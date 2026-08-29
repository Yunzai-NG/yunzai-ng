/**
 * 模块职责：统一 HTTP 客户端（undici）—— 超时、重试、代理、限长、流式下载
 * 依赖方向：依赖 undici、util/{defer,duration,fs,text}、类型包；不依赖任何插件
 * 生命周期：应用级单例（`createHttpClient` 创建一份，`close()` 时释放连接池）
 * 注意事项：此处是全框架**唯一**发起 HTTP 请求的位置，插件经 `ctx.http` 取得它 —— 各处混用不同
 *          客户端时，代理要各配一遍、超时各实现一套，国内网络下「某个插件没反应」得查三份实现。
 *
 *          **连接池必须复用。** `ProxyAgent` / `Agent` 按代理地址缓存，绝不每次请求新建 ——
 *          那会丢掉全部 socket 与 TLS 会话，高频接口退化成每次重新握手。
 *
 *          **响应体必须被消费。** undici 的 body 没读完时连接不归还连接池，故丢弃响应
 *          （`responseType: "none"`、重试前、报错时）一律显式 `dump()`。
 *
 *          **缓冲读取必须有上限。** `maxBodySize` 缺省 64 MiB —— 对端返回一个无限流即可让机器人
 *          OOM，而图床故障时返回 HTML 死循环并不罕见。
 *
 *          **报错信息不得泄露凭据。** URL 里的 authkey / token 一律打码后才写日志，否则使用者
 *          贴日志求助时会连带泄露。
 */
import { createWriteStream } from "node:fs"
import { rename, unlink } from "node:fs/promises"
import { dirname } from "node:path"
import { pipeline as pipelineTo, type Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib"
import { Agent, ProxyAgent, interceptors, request as undiciRequest, type Dispatcher } from "undici"
import type {
  HttpClient,
  HttpDefaults,
  HttpRequestOptions,
  HttpResponse,
  HttpResponseType,
  HttpRetryOptions,
  Logger
} from "@yunzai-ng/types"
import { AbortError, backoffDelay, sleep } from "../util/defer.js"
import { parseDuration } from "../util/duration.js"
import { ensureDir } from "../util/fs.js"
import { maskSecret } from "../util/text.js"

/** 默认超时（毫秒） */
const DEFAULT_TIMEOUT = 10_000

/** 默认缓冲上限：64 MiB */
const DEFAULT_MAX_BODY = 64 * 1024 * 1024

/** 默认跟随重定向的次数 */
const MAX_REDIRECTIONS = 5

/** 默认会重试的状态码 */
const RETRY_STATUSES: readonly number[] = [408, 429, 500, 502, 503, 504]

/** 重试等待的上限（毫秒）：`Retry-After` 说等一小时也不真等 */
const MAX_RETRY_DELAY = 30_000

/**
 * `close()` 等待在途请求的宽限（毫秒）
 *
 * 取一个小值：够正在收尾的响应写完，又不至于让使用者在停机时干等。
 */
const CLOSE_GRACE_MS = 500

/** 查询串里需要打码的键（小写比对） */
const SECRET_QUERY_KEYS: readonly string[] = [
  "authkey",
  "token",
  "access_token",
  "refresh_token",
  "cookie",
  "sign",
  "secret",
  "key",
  "password",
  "stoken",
  "ltoken"
]

/** 请求头里需要打码的键（小写比对） */
const SECRET_HEADER_KEYS: readonly string[] = ["cookie", "authorization", "x-rpc-device_fp", "ds"]

/** 从环境变量里读代理的顺序 */
const PROXY_ENV_KEYS: readonly string[] = ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY", "ALL_PROXY"]

/** HTTP 请求失败 */
export class HttpError extends Error {
  /** 错误名 */
  override readonly name = "HttpError"
  /** 状态码；网络层失败时为 0 */
  readonly status: number
  /** 请求方法 */
  readonly method: string
  /** 已打码的请求 URL */
  readonly url: string
  /** 响应体片段（截断后），便于看清对方到底回了什么 */
  readonly body?: string

  /**
   * @param message 错误信息
   * @param info 附加信息
   * @param info.status 状态码
   * @param info.method 请求方法
   * @param info.url 已打码 URL
   * @param info.body 响应体片段
   * @param info.cause 底层错误
   */
  constructor(
    message: string,
    info: {
      /** 状态码 */
      status: number
      /** 请求方法 */
      method: string
      /** 已打码 URL */
      url: string
      /** 响应体片段 */
      body?: string
      /** 底层错误 */
      cause?: unknown
    }
  ) {
    super(message, info.cause === undefined ? undefined : { cause: info.cause })
    this.status = info.status
    this.method = info.method
    this.url = info.url
    if (info.body !== undefined) this.body = info.body
  }
}

/** 创建客户端的参数 */
export interface HttpClientOptions extends HttpDefaults {
  /** 日志器（记重试与代理选择） */
  logger?: Logger
  /** 默认 User-Agent */
  userAgent?: string
  /** 缓冲读取上限字节数，缺省 64 MiB */
  maxBodySize?: number
  /** 每个源的最大连接数，缺省 32 */
  connections?: number
  /** 是否读取 `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`，缺省 true */
  useEnvProxy?: boolean
}

/** 带生命周期管理的 HTTP 客户端 */
export interface ManagedHttpClient extends HttpClient {
  /**
   * 关掉全部连接池
   *
   * 不调用它，进程可能因为 keep-alive 的空闲 socket 迟迟不退出。
   * 这是**终态**：关掉后再发请求会直接抛错，而不是悄悄重建一个池子。
   * @returns 全部关闭后兑现
   */
  close(): Promise<void>
}

/** 一次请求最终生效的参数 */
interface ResolvedRequest {
  /** 请求方法（大写） */
  method: string
  /** 完整 URL */
  url: string
  /** 请求头（键已小写） */
  headers: Record<string, string>
  /** 请求体 */
  body: string | Uint8Array | undefined
  /** 超时毫秒 */
  timeout: number
  /** 重试策略 */
  retry: HttpRetryOptions
  /** 响应解析方式 */
  responseType: HttpResponseType
  /** 代理地址；false 表示直连 */
  proxy: string | false
  /** 跟随重定向次数 */
  redirections: number
  /** 非 2xx 是否抛错 */
  throwOnError: boolean
  /** 外部中止信号 */
  signal: AbortSignal | undefined
}

/**
 * 把 URL 里的敏感查询值打码
 *
 * 抽卡链接的 `authkey` 有一千多字符且等于账号凭据，直接进日志等于泄号。
 * @param raw 原始 URL
 * @returns 可安全记录的 URL
 */
export function sanitizeUrl(raw: string): string {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    // 拼错的 URL 也可能带密钥，整体截断了事
    return raw.length > 120 ? `${raw.slice(0, 120)}…` : raw
  }

  for (const key of [...parsed.searchParams.keys()]) {
    if (!SECRET_QUERY_KEYS.includes(key.toLowerCase())) continue
    const value = parsed.searchParams.get(key) ?? ""
    parsed.searchParams.set(key, maskSecret(value))
  }
  return parsed.toString()
}

/**
 * 把请求头里的敏感值打码
 * @param headers 请求头
 * @returns 可安全记录的副本
 */
export function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    safe[key] = SECRET_HEADER_KEYS.includes(key.toLowerCase()) ? maskSecret(value) : value
  }
  return safe
}

/**
 * 合并两个中止信号
 *
 * 用于把「客户端默认信号」（如插件的卸载信号）与「单次请求的信号」并成一个：
 * 任一触发即中止。两者都缺省时返回 undefined，此时不给 undici 传 signal。
 * @param a 一个信号
 * @param b 另一个信号
 * @returns 合并后的信号；都没有时 undefined
 */
function mergeSignals(a: AbortSignal | undefined, b: AbortSignal | undefined): AbortSignal | undefined {
  const list = [a, b].filter((s): s is AbortSignal => s !== undefined)
  if (list.length === 0) return undefined
  if (list.length === 1) return list[0]
  return AbortSignal.any(list)
}

/**
 * 归一化重试选项
 * @param input 数字（次数）或完整选项
 * @returns 完整选项
 */
function normalizeRetry(input: number | HttpRetryOptions | undefined): HttpRetryOptions {
  if (input === undefined) return { times: 0 }
  if (typeof input === "number") return { times: Math.max(0, Math.trunc(input)) }
  return input
}

/**
 * 拼出完整 URL
 * @param url 绝对 URL 或相对路径
 * @param baseUrl 基址
 * @param query 查询参数
 * @returns 完整 URL
 * @throws 相对路径但没配 baseUrl 时抛错
 */
function buildUrl(url: string, baseUrl: string | undefined, query: HttpRequestOptions["query"]): string {
  let full: URL
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    full = new URL(url)
  } else if (baseUrl) {
    // 用 URL 的相对解析：baseUrl 带不带尾斜杠都能接上
    full = new URL(url.replace(/^\/+/, ""), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`)
  } else {
    throw new TypeError(`HTTP 请求的地址不是绝对 URL，且客户端没配 baseUrl：${url}`)
  }

  for (const [key, value] of Object.entries(query ?? {})) {
    // undefined/null 直接丢掉：让调用方能写 `{ uid, region: maybeUndefined }`
    // 而不必先过滤一遍
    if (value === undefined || value === null) continue
    full.searchParams.set(key, String(value))
  }
  return full.toString()
}

/**
 * 把响应头折叠成小写键的字符串表
 * @param raw undici 的响应头
 * @returns 小写键表
 */
function flattenHeaders(raw: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value
  }
  return out
}

/**
 * 读取响应体，超过上限就中断
 *
 * 不设上限的话，对方返回一个不结束的流就能把进程吃干 —— 图床故障时
 * 返回无限重定向页面是真实发生过的。
 * @param body 响应流
 * @param max 上限字节数
 * @param onOverflow 超限时用于构造错误
 * @returns 字节内容
 * @throws 超过上限时抛 HttpError
 */
async function readBounded(body: Readable, max: number, onOverflow: (read: number) => HttpError): Promise<Uint8Array> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of body) {
    const buf = chunk as Buffer
    total += buf.length
    if (total > max) {
      body.destroy()
      throw onOverflow(total)
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks, total)
}

/**
 * 丢弃响应体
 *
 * undici 的连接要等 body 读完才还回池子；重试前、报错后如果不消费，
 * 池子会被慢慢占满，症状是"跑一段时间后所有请求都卡住"。
 * @param body 响应流
 */
function discard(body: Readable): void {
  // dump() 会把剩余数据读掉并释放连接；它自己可能因连接已断而拒绝，忽略即可
  const dumpable = body as Readable & {
    /**
     * undici 提供的丢弃方法
     * @returns 丢弃完成
     */
    dump?: () => Promise<void>
  }
  if (typeof dumpable.dump === "function") void dumpable.dump().catch(() => undefined)
  else body.resume()
}

/**
 * 按 `Content-Encoding` 套一层解压
 *
 * 刻意不使用 undici 的 `interceptors.decompress()`：它在 v7 中仍标注 experimental，
 * 加载即向 stderr 输出 `ExperimentalWarning`。机器人启动时出现这样一行，
 * 使用者的第一反应是"是否出现故障"，而此处所需仅为三行 zlib。
 *
 * 使用回调版 `pipeline` 而非手工 `pipe`：它保证任一端出错或提前关闭时
 * 两端均被销毁 —— 否则解压流被调用方 destroy 后，undici 一侧的 socket 即被泄漏。
 * @param body 原始响应流
 * @param encoding `Content-Encoding` 头值
 * @returns 解压后的流；无需解压时原样返回
 */
function decodeStream(body: Readable, encoding: string | undefined): Readable {
  const codec = (encoding ?? "").trim().toLowerCase()
  const decoder =
    codec === "gzip" || codec === "x-gzip"
      ? createGunzip()
      : codec === "deflate"
        ? createInflate()
        : codec === "br"
          ? createBrotliDecompress()
          : undefined
  if (!decoder) return body
  return pipelineTo(body, decoder, () => undefined)
}

/**
 * 解析 `Retry-After` 头
 * @param value 头值
 * @returns 毫秒；无法解析时 undefined
 */
function parseRetryAfter(value: string | undefined): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(value)
  if (Number.isNaN(date)) return undefined
  return Math.max(0, date - Date.now())
}

/**
 * 判断一个网络层错误是否值得重试
 *
 * 仅重试再次尝试即可能成功者：连接被拒、超时、连接被对端重置。
 * 4xx 语义错误与证书错误重试一百次结果相同，只会刷满日志。
 * @param err 错误
 * @returns 是否重试
 */
function isRetryableNetworkError(err: unknown): boolean {
  if (err instanceof AbortError) return false
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code !== "string") return false
  return [
    "ECONNRESET",
    "ECONNREFUSED",
    "ENOTFOUND",
    "EAI_AGAIN",
    "EPIPE",
    "ETIMEDOUT",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_SOCKET"
  ].includes(code)
}

/**
 * 从环境变量里挑一个代理
 * @returns 代理地址；没配时 undefined
 */
function proxyFromEnv(): string | undefined {
  for (const key of PROXY_ENV_KEYS) {
    const value = process.env[key]
    if (value && value.trim()) return value.trim()
  }
  return undefined
}

/**
 * 校验请求头是否可用于发送
 *
 * HTTP 头仅允许 latin1 范围内的字节，中文一律非法。插件作者遇到该问题的概率较高
 *（例如将群名置入自定义头），而 undici 仅返回 `invalid x-foo header`，
 * 既不说明原因亦不给出处置方式。此处提前拦截并明确给出处置方式。
 * @param headers 请求头
 * @throws 含非法字符时抛 TypeError
 */
function assertHeaders(headers: Record<string, string>): void {
  for (const [key, value] of Object.entries(headers)) {
    if (!/^[\w!#$%&'*+.^`|~-]+$/.test(key)) {
      throw new TypeError(`请求头名 ${JSON.stringify(key)} 含非法字符（只允许 ASCII 记号字符）`)
    }
    for (const ch of value) {
      const code = ch.codePointAt(0) ?? 0
      // 放行水平制表符与 latin1 可见字符；控制字符（含 CRLF —— 可被用于注入请求头）
      // 与 U+00FF 以上的字符均不允许
      if (code === 0x09 || (code >= 0x20 && code !== 0x7f && code <= 0xff)) continue
      throw new TypeError(
        `请求头 ${key} 的值含非法字符（HTTP 头仅允许 latin1，中文与换行均不允许）。` +
          `需要传递中文请先 encodeURIComponent 或改用 Base64`
      )
    }
  }
}

/**
 * 创建 HTTP 客户端
 *
 * 返回的客户端是全框架共享的那一份；插件不要自己建，用 `ctx.http`。
 * @param opts 客户端参数
 * @returns 带 `close()` 的客户端
 */
export function createHttpClient(opts: HttpClientOptions = {}): ManagedHttpClient {
  const logger = opts.logger?.child({ scope: "http" })
  const maxBodySize = opts.maxBodySize ?? DEFAULT_MAX_BODY
  const connections = opts.connections ?? 32

  /**
   * 是否已 `close()`
   *
   * 关掉之后如果还允许发请求，连接池会被静默重建，于是 `close()` 等于没调 ——
   * 进程照旧被 keep-alive 的空闲 socket 吊着不退出，且没有任何报错可查。
   * 所以 `close()` 是终态，之后的请求一律拒绝。
   */
  let closed = false

  /** 基础连接池：按代理地址缓存，`""` 是直连 */
  const agents = new Map<string, Agent | ProxyAgent>()
  /** 组合后的派发器：键为 `代理|重定向次数` */
  const dispatchers = new Map<string, Dispatcher>()

  const envProxy = (opts.useEnvProxy ?? true) ? proxyFromEnv() : undefined
  if (envProxy && opts.proxy === undefined) {
    logger?.info(`已从环境变量读到代理：${sanitizeUrl(envProxy)}`)
  }

  /**
   * 取（或建）一个基础连接池
   * @param proxy 代理地址；空串表示直连
   * @returns 连接池
   */
  function baseAgent(proxy: string): Agent | ProxyAgent {
    let agent = agents.get(proxy)
    if (agent) return agent
    agent = proxy
      ? new ProxyAgent({ uri: proxy, connections, keepAliveTimeout: 10_000, keepAliveMaxTimeout: 60_000 })
      : new Agent({ connections, keepAliveTimeout: 10_000, keepAliveMaxTimeout: 60_000 })
    agents.set(proxy, agent)
    return agent
  }

  /**
   * 取（或建）一个带拦截器的派发器
   *
   * 拦截器只有"重定向次数"这一个变量，所以每个代理最多缓存两份
   * （跟随 / 不跟随），不会随请求数增长。
   * @param proxy 代理地址；空串表示直连
   * @param redirections 跟随重定向次数
   * @returns 派发器
   */
  function dispatcherFor(proxy: string, redirections: number): Dispatcher {
    const key = `${proxy}|${redirections}`
    let dispatcher = dispatchers.get(key)
    if (dispatcher) return dispatcher
    // 只装重定向拦截器。解压刻意不走 interceptors.decompress()，改在 once() 里
    // 手工套 zlib —— 理由见 decodeStream 的注释
    dispatcher = baseAgent(proxy).compose(interceptors.redirect({ maxRedirections: redirections }))
    dispatchers.set(key, dispatcher)
    return dispatcher
  }

  /**
   * 按默认值造一个客户端
   * @param defaults 该客户端的默认值
   * @returns 客户端
   */
  function build(defaults: HttpDefaults): ManagedHttpClient {
    /**
     * 把调用方选项与默认值合成最终参数
     * @param url 地址
     * @param options 调用方选项
     * @returns 最终参数
     */
    function resolve(url: string, options: HttpRequestOptions = {}): ResolvedRequest {
      const headers: Record<string, string> = {
        "accept-encoding": "gzip, deflate",
        "user-agent": opts.userAgent ?? "yunzai-ng"
      }
      for (const [key, value] of Object.entries(defaults.headers ?? {})) headers[key.toLowerCase()] = value
      for (const [key, value] of Object.entries(options.headers ?? {})) headers[key.toLowerCase()] = value

      let body = options.body
      if (options.json !== undefined) {
        body = JSON.stringify(options.json)
        headers["content-type"] ??= "application/json"
      } else if (options.form !== undefined) {
        const form = new URLSearchParams()
        for (const [key, value] of Object.entries(options.form)) form.set(key, String(value))
        body = form.toString()
        headers["content-type"] ??= "application/x-www-form-urlencoded"
      }

      const method = (options.method ?? (body === undefined ? "GET" : "POST")).toUpperCase()
      const proxyChoice = options.proxy ?? defaults.proxy ?? envProxy ?? false
      const follow = options.followRedirect ?? true

      // 提前校验：非法头字符交给 undici 只会换来一句 `invalid x-foo header`
      assertHeaders(headers)

      return {
        method,
        url: buildUrl(url, defaults.baseUrl, options.query),
        headers,
        body,
        timeout: parseDuration(options.timeout ?? defaults.timeout, DEFAULT_TIMEOUT),
        retry: normalizeRetry(options.retry ?? defaults.retry),
        responseType: options.responseType ?? "json",
        proxy: proxyChoice,
        redirections: follow ? MAX_REDIRECTIONS : 0,
        throwOnError: options.throwOnError ?? true,
        signal: mergeSignals(defaults.signal, options.signal)
      }
    }

    /**
     * 发一次请求（不含重试）
     * @param req 最终参数
     * @returns 完整响应
     */
    async function once<T>(req: ResolvedRequest): Promise<HttpResponse<T>> {
      const startedAt = Date.now()
      const safeUrl = sanitizeUrl(req.url)

      // 每次尝试一个独立的超时信号；与调用方信号合并，谁先触发都能中断底层连接。
      // 注意不能用 withTimeout 包一层了事 —— 那样只是调用方不等了，
      // socket 还在那儿挂着，重试几轮就把连接池占满
      const timer = req.timeout > 0 ? AbortSignal.timeout(req.timeout) : undefined
      const signals = [timer, req.signal].filter((s): s is AbortSignal => s !== undefined)
      const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0]

      let res: Dispatcher.ResponseData
      try {
        res = await undiciRequest(req.url, {
          dispatcher: dispatcherFor(req.proxy === false ? "" : req.proxy, req.redirections),
          method: req.method as Dispatcher.HttpMethod,
          headers: req.headers,
          ...(req.body === undefined ? {} : { body: req.body }),
          ...(signal ? { signal } : {})
        })
      } catch (err) {
        // 调用方主动取消：原样抛出 AbortError，别包成 HttpError 让人误判成服务端问题
        if (req.signal?.aborted) throw new AbortError(`请求已被取消：${req.method} ${safeUrl}`)
        if (timer?.aborted) {
          throw new HttpError(`请求超时（${req.timeout}ms）：${req.method} ${safeUrl}`, {
            status: 0,
            method: req.method,
            url: safeUrl,
            cause: err
          })
        }
        throw new HttpError(`请求失败：${req.method} ${safeUrl} —— ${(err as Error).message}`, {
          status: 0,
          method: req.method,
          url: safeUrl,
          cause: err
        })
      }

      const status = res.statusCode
      const headers = flattenHeaders(res.headers)
      const ok = status >= 200 && status < 300

      /**
       * 组装响应对象
       * @param data 解析后的数据
       * @returns 响应
       */
      const wrap = (data: unknown): HttpResponse<T> => ({
        status,
        statusText: headers["x-status-text"] ?? "",
        headers,
        data: data as T,
        ok,
        url: safeUrl,
        cost: Date.now() - startedAt
      })

      if (req.responseType === "none") {
        // 用原始 res.body：dump() 是 undici 挂在它身上的方法，
        // 套一层解压流就没有了，连接也就还不回池子
        discard(res.body)
        return wrap(undefined)
      }

      // 往下的分支都要真读内容，先按 Content-Encoding 套上解压
      const body = decodeStream(res.body, headers["content-encoding"])

      if (req.responseType === "stream") {
        // 流式：body 交给调用方，读完/销毁的责任也一并交出去
        return wrap(body)
      }

      /**
       * 超限时的错误
       * @param read 已读字节数
       * @returns 错误
       */
      const overflow = (read: number): HttpError =>
        new HttpError(
          `响应体超过上限 ${maxBodySize} 字节（已读 ${read}）：${req.method} ${safeUrl}。` +
            `大文件请用 download() 直接落盘，不要读进内存`,
          { status, method: req.method, url: safeUrl }
        )

      const bytes = await readBounded(body, maxBodySize, overflow)

      if (req.responseType === "buffer") return wrap(bytes)

      const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8")
      if (req.responseType === "text") return wrap(text)

      // json：空体按 undefined 处理；解析失败时把片段带上，
      // 否则只看到 "Unexpected token <" 完全不知道对方回了什么
      if (text.length === 0) return wrap(undefined)
      try {
        return wrap(JSON.parse(text))
      } catch (err) {
        // 非 2xx 就退回文本，不在这里抛：网关返回 503 + 一张 HTML 错误页是常态，
        // 在这儿抛掉的话 request() 里"按状态码重试"的判断永远轮不到执行 ——
        // 症状是"明明配了 retry，日志里一次重试都没有"。
        // 这种响应里状态码才是主要信息，正文只当片段用
        if (!ok) return wrap(text)
        throw new HttpError(
          `响应不是合法 JSON：${req.method} ${safeUrl}（状态 ${status}）。片段：${text.slice(0, 200)}`,
          { status, method: req.method, url: safeUrl, body: text.slice(0, 2000), cause: err }
        )
      }
    }

    /**
     * 带重试地发请求
     * @param url 地址
     * @param options 选项
     * @returns 完整响应
     * @throws HttpError / AbortError
     */
    async function request<T>(url: string, options?: HttpRequestOptions): Promise<HttpResponse<T>> {
      if (closed) {
        throw new Error(
          "HTTP 客户端已关闭，不能再发请求。注意 extend() 派生出的客户端与根客户端共享连接池，关一个等于全关"
        )
      }
      const req = resolve(url, options)
      const times = Math.max(0, req.retry.times)
      const statuses = req.retry.statuses ?? RETRY_STATUSES
      const baseDelay = req.retry.delay === undefined ? 500 : parseDuration(req.retry.delay, 500)

      for (let attempt = 0; ; attempt++) {
        /** 本轮是否还能再试 */
        const canRetry = attempt < times

        /**
         * 等待下一轮
         * @param wait 等待毫秒
         * @param why 记录用的原因
         */
        const waitThen = async (wait: number, why: string): Promise<void> => {
          logger?.debug(`${req.method} ${sanitizeUrl(req.url)} ${why}，${wait}ms 后重试（第 ${attempt + 1} 次）`)
          await sleep(Math.min(wait, MAX_RETRY_DELAY), req.signal)
        }

        let res: HttpResponse<T>
        try {
          res = await once<T>(req)
        } catch (err) {
          const custom = req.retry.when?.(err)
          const retryable = custom ?? isRetryableNetworkError((err as { cause?: unknown }).cause ?? err)
          if (!canRetry || !retryable) throw err
          await waitThen(backoffDelay(attempt + 1, { baseDelay }), "网络出错")
          continue
        }

        const byStatus = statuses.includes(res.status)
        const custom = req.retry.when?.(undefined, res)
        if ((custom ?? byStatus) && canRetry) {
          // 重试前必须把 body 处理掉，否则连接不还池
          if (req.responseType === "stream") discard(res.data as unknown as Readable)
          const hinted = parseRetryAfter(res.headers["retry-after"])
          await waitThen(hinted ?? backoffDelay(attempt + 1, { baseDelay }), `返回 ${res.status}`)
          continue
        }

        if (!res.ok && req.throwOnError) {
          const snippet = typeof res.data === "string" ? res.data.slice(0, 200) : ""
          throw new HttpError(`${req.method} ${res.url} 返回 ${res.status}${snippet ? `：${snippet}` : ""}`, {
            status: res.status,
            method: req.method,
            url: res.url,
            ...(snippet ? { body: snippet } : {})
          })
        }
        return res
      }
    }

    const client: ManagedHttpClient = {
      request,

      get: async <T>(url: string, options?: Omit<HttpRequestOptions, "method">): Promise<T> =>
        (await request<T>(url, { ...options, method: "GET" })).data,

      post: async <T>(
        url: string,
        json?: unknown,
        options?: Omit<HttpRequestOptions, "method" | "json">
      ): Promise<T> => {
        const merged: HttpRequestOptions = { ...options, method: "POST" }
        if (json !== undefined) merged.json = json
        return (await request<T>(url, merged)).data
      },

      // 实际返回 Node 的 Buffer（本身就是 Uint8Array 的子类）。契约上写 Uint8Array
      // 是为了不把类型包绑到 Node，但这里刻意不降级成裸 Uint8Array ——
      // 适配器发图片要 toString("base64")，那是 Buffer 才有的
      buffer: async (url: string, options?: HttpRequestOptions): Promise<Uint8Array> =>
        (await request<Uint8Array>(url, { ...options, responseType: "buffer" })).data,

      download: async (url: string, dest: string, options?: HttpRequestOptions): Promise<string> => {
        await ensureDir(dirname(dest))
        // 先写 .part 再改名：残缺文件若留在目标路径上，下次会被当作有效缓存，
        // 症状是某张图片始终损坏
        const temp = `${dest}.part`
        const res = await request<Readable>(url, { ...options, responseType: "stream" })
        try {
          await pipeline(res.data, createWriteStream(temp))
          await rename(temp, dest)
          return dest
        } catch (err) {
          await unlink(temp).catch(() => undefined)
          throw err
        }
      },

      extend: (override: HttpDefaults): HttpClient => build({ ...defaults, ...override }),

      close: async (): Promise<void> => {
        closed = true
        dispatchers.clear()
        const pool = [...agents.values()]
        agents.clear()

        // 先给一小段宽限让正在收尾的请求写完，到点未完的一律掐断。
        // undici 的 close() 是优雅关闭 —— 它会一直等在途请求跑完，于是一个 15 秒超时的
        // 请求能把停机拖满 15 秒。停机走到这一步时插件已卸载、服务器已关闭，还在途的
        // 必然是没人接收结果的孤儿请求，等它们没有意义。
        const graceful = Promise.all(pool.map(agent => agent.close().catch(() => undefined)))
        const timer = new Promise<"timeout">(res => {
          const t = setTimeout(() => res("timeout"), CLOSE_GRACE_MS)
          // unref：这个定时器自己不该成为进程退不出的原因
          t.unref()
        })
        if ((await Promise.race([graceful.then(() => "done" as const), timer])) === "timeout") {
          logger?.debug(`连接池未在 ${CLOSE_GRACE_MS}ms 内关闭，中止在途请求`)
          await Promise.all(pool.map(agent => agent.destroy().catch(() => undefined)))
        }
      }
    }
    return client
  }

  const rootDefaults: HttpDefaults = {}
  if (opts.baseUrl !== undefined) rootDefaults.baseUrl = opts.baseUrl
  if (opts.headers !== undefined) rootDefaults.headers = opts.headers
  if (opts.timeout !== undefined) rootDefaults.timeout = opts.timeout
  if (opts.retry !== undefined) rootDefaults.retry = opts.retry
  if (opts.proxy !== undefined) rootDefaults.proxy = opts.proxy

  return build(rootDefaults)
}

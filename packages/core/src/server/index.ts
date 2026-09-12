/**
 * 模块职责：共享 HTTP / WebSocket 服务器 —— 面板、插件路由、适配器 webhook 共用一个端口
 * 依赖方向：依赖 fastify 与本目录的 auth/files/table；不认识任何插件，也不认识面板前端
 * 生命周期：`createManagedServer()` 建好但不监听；`listen()` 由 `App.start()` 在插件
 *          全部装完之后调用；`close()` 幂等，由 `App.own()` 登记
 * 注意事项：四个不显而易见的决定 ——
 *
 *          **Fastify 上只注册 4 条 catch-all 路由**（`/` 与 `/*` 各两条），真正的分发走 table.ts 的
 *          `PathTable` —— find-my-way 没有删除单条路由的 API，而「插件能装能卸能热重载」是核心不变量。
 *
 *          **鉴权放在 `onRequest` 钩子里**，不放在处理函数里。fastify 在 `handle-request` 开头就判
 *          `reply.sent`，故在 `onRequest` 里回了响应，body 解析与路由处理都不会发生 —— 未鉴权的请求
 *          不该有机会往本进程内存写 64MB。
 *
 *          **WebSocket 的拒绝也必须在 `onRequest` 里做。** `@fastify/websocket` 的 `onUpgrade` 会先建
 *          响应对象再调 `fastify.routing()`，此时回响应得到的是一个真正的 401/404，对方看得到原因；
 *          等进了 `wsHandler` 再关连接，对方只看到一次没有理由的断线。
 *
 *          **静态资源刻意不鉴权。** 浏览器请求文档时设不了请求头，要鉴权就只剩 Cookie 一条路，
 *          那会把 auth.ts 刻意避开的 CSRF 面重新引进来。HTML/JS 本身不是机密，要保护的是 API。
 */
import { isAbsolute } from "node:path"
import type { IncomingMessage } from "node:http"
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify"
import fastifyStatic from "@fastify/static"
import fastifyWebsocket from "@fastify/websocket"
import type {
  Awaitable,
  Disposer,
  HttpMethod,
  Logger,
  RouteHandler,
  RouteOptions,
  RouteRequest,
  RouteResponse,
  ServerInfo,
  WebSocketConnection,
  WebSocketHandler,
  WebSocketOptions
} from "@yunzai-ng/types"
import type { CoreConfigHandle } from "../config/core-config.js"
import type { ServerSink } from "../plugin/hooks.js"
import { createSeqFactory } from "../util/id.js"
import { formatBytes } from "../util/duration.js"
import { WS_PROTOCOL, checkAuth, checkForgeableBody, generateToken, type AuthRequest } from "./auth.js"
import { resolveStaticFile, type StaticMount } from "./files.js"
import { HTTP_METHODS, PathTable, isHttpMethod, joinPattern, splitSegments, type PathHit } from "./table.js"

/** 单条路由未声明 `bodyLimit` 时的请求体上限 */
const DEFAULT_BODY_LIMIT = 1024 * 1024

/**
 * 任何路由都不得超过的请求体上限
 *
 * 同时作为 Fastify 实例级的 `bodyLimit`：实际的限流在本模块自有的解析器中按路由施加，
 * 此处仅为最后一道兜底，防止某个路由将 `bodyLimit` 设为 `Infinity`。
 */
const MAX_BODY_LIMIT = 64 * 1024 * 1024

/** 静态挂载的通配参数名，`/webui/*rest` 里的 `rest` */
const STATIC_REST = "rest"

/** `ws` 的 `readyState` 里代表"已连通"的值 */
const WS_OPEN = 1

/** `RouteResponse` 允许出现的键；出现其他键即表明该对象实为业务数据 */
const RESPONSE_KEYS = new Set(["status", "headers", "body"])

/** 一条 HTTP 路由的注册信息 */
interface RouteEntry {
  /** 注册方的 URL 前缀，通常带插件名；面板据此显示归属 */
  readonly scope: string
  /** 处理函数 */
  readonly handler: RouteHandler
  /** 是否需要鉴权 */
  readonly auth: boolean
  /** 请求体上限（字节） */
  readonly limit: number
  /** 是否把原始字节一并交给处理函数 */
  readonly rawBody: boolean
}

/** 一个 WebSocket 端点的注册信息 */
interface WsEntry {
  /** 注册方的 URL 前缀 */
  readonly scope: string
  /** 处理函数 */
  readonly handler: WebSocketHandler
  /** 自定义校验；`undefined` 表示沿用面板令牌校验 */
  readonly verify: ((req: RouteRequest) => Awaitable<boolean>) | undefined
}

/**
 * 一次请求的查表结果
 *
 * 之所以要缓存：鉴权（`onRequest`）、请求体限流（内容解析器）、真正分发（路由处理
 * 函数）是三个不同阶段，它们必须看到**同一次**查表结果。否则一次插件热重载正好卡在
 * 中间，就会出现"按 A 路由鉴权、按 B 路由分发"这种既难复现又致命的错位。
 */
interface RequestContext {
  /** 归一化后的请求方法 */
  readonly method: HttpMethod
  /** 去掉查询串的路径 */
  readonly path: string
  /** 已解码的路径段 */
  readonly parts: readonly string[]
  /** 命中的 HTTP 路由 */
  readonly route: PathHit<RouteEntry> | undefined
  /** 命中的静态挂载 */
  readonly mount: PathHit<StaticMount> | undefined
  /** 命中的 WebSocket 端点 */
  readonly ws: PathHit<WsEntry> | undefined
  /** 本次请求适用的请求体上限 */
  readonly limit: number
  /** 本次请求是否要保留原始字节 */
  readonly rawBody: boolean
}

/** 带状态码的错误，`setErrorHandler` 靠它决定回什么码 */
interface HttpError extends Error {
  /** 建议的 HTTP 状态码 */
  statusCode: number
}

/** Fastify 内置 JSON 解析器的回调式签名 */
type JsonParser = (
  request: FastifyRequest,
  body: string,
  done: (err: Error | null, body?: unknown) => void
) => void

/**
 * `ws` 原生连接里本文件真正用到的部分
 *
 * 为什么自己声明而不是 `import type { WebSocket } from "ws"`：`ws` 不自带类型声明，
 * 仓库里也没装 `@types/ws`。`@fastify/websocket` 内部 `import * as WebSocket from "ws"`，
 * 在 `skipLibCheck` 下退化成 `any`，因此这个最小接口可以直接赋给它的 `wsHandler` ——
 * 既不用装一个只为编译服务的类型包，也不用在代码里写 `any`。
 */
interface RawSocket {
  /** 连接状态，`1` 为已连通 */
  readonly readyState: number

  /**
   * 发一帧
   * @param data 文本或二进制数据
   */
  send(data: string | Uint8Array): void

  /**
   * 正常关闭
   * @param code 关闭码
   * @param reason 关闭原因
   */
  close(code?: number, reason?: string): void

  /** 直接掐断，不走关闭握手 */
  terminate(): void

  /**
   * 监听收到的帧
   * @param event 固定为 `"message"`
   * @param cb 回调，第二个参数标明是否为二进制帧
   */
  on(event: "message", cb: (data: unknown, isBinary: boolean) => void): void

  /**
   * 监听关闭
   * @param event 固定为 `"close"`
   * @param cb 回调
   */
  on(event: "close", cb: (code: number, reason: unknown) => void): void

  /**
   * 监听错误
   * @param event 固定为 `"error"`
   * @param cb 回调
   */
  on(event: "error", cb: (err: unknown) => void): void
}

/** 面板"路由一览"里的一条 HTTP 路由 */
export interface RouteSummary {
  /** 请求方法 */
  readonly method: HttpMethod
  /** URL 模式 */
  readonly pattern: string
  /** 注册方前缀 */
  readonly scope: string
  /** 是否需要鉴权 */
  readonly auth: boolean
}

/** 面板"路由一览"里的一个 WebSocket 端点 */
export interface WebSocketSummary {
  /** URL 模式 */
  readonly pattern: string
  /** 注册方前缀 */
  readonly scope: string
}

/** 面板"路由一览"里的一个静态挂载 */
export interface StaticSummary {
  /** URL 模式 */
  readonly pattern: string
  /** 本地目录 */
  readonly dir: string
  /** 是否单页回退 */
  readonly spa: boolean
}

/** 创建共享服务器的参数 */
export interface ManagedServerOptions {
  /** 内核配置句柄，监听地址、端口与访问令牌都从这里读 */
  readonly config: CoreConfigHandle
  /** 日志器 */
  readonly logger: Logger
}

/**
 * 取错误的可读文本
 *
 * 内核没有统一的错误文案工具（pipeline/router.ts 也是就地内联的），这里同样自备一个，
 * 免得为一行三元表达式在 util 里加一个模块。
 * @param err 任意抛出物
 * @returns 可读文本
 */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 去掉查询串与锚点，只留路径
 * @param url `request.url`，形如 `/api/config?x=1`
 * @returns 路径部分
 */
function pathOf(url: string): string {
  const cut = url.search(/[?#]/)
  return cut < 0 ? url : url.slice(0, cut)
}

/**
 * 取 TCP 对端地址
 *
 * 刻意使用 `request.socket.remoteAddress` 而非 `request.ip`：后者在 `trustProxy` 开启
 * 时会变为 `X-Forwarded-For` 的值。鉴权的"是否本机"判断绝不能被一个请求头左右，
 * 因此此处绕开 Fastify 的加工，直接向内核获取对端地址。
 *
 * 使用 `?.` 是必要的：WebSocket 升级经由 `fastify.routing()` 而非正常的请求流程，
 * 注入式测试（`injectWS`）伪造的 raw request 上并不存在 `socket`。无法取得时返回空串，
 * 于是 `isLoopbackAddress("")` 为 false —— 无法确定时按"非本机"处理，是安全的一侧。
 * @param request Fastify 请求
 * @returns 对端地址；取不到时空串
 */
function ipOf(request: FastifyRequest): string {
  return request.socket?.remoteAddress ?? ""
}

/**
 * 取请求头的第一个值
 * @param value 头值
 * @returns 首个值；不存在时 undefined
 */
function firstHeader(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined
  return Array.isArray(value) ? value[0] : value
}

/**
 * 从 `Content-Type` 里取出媒体类型本身
 * @param header 头值
 * @returns 已小写化的媒体类型；没有时空串
 */
function mediaTypeOf(header: string | undefined): string {
  return (header ?? "").split(";")[0]?.trim().toLowerCase() ?? ""
}

/**
 * 判断是否是一个 WebSocket 升级请求
 *
 * 不能只看 `request.ws`：`fastify.addHook()` 立即生效，而 `fastify.register()` 要等到
 * `ready()` 才启动插件，因此本服务器的 `onRequest` 钩子**排在 `@fastify/websocket`
 * 自己那个钩子之前**，那时 `request.ws` 还没被赋值。所以以请求头为准，
 * `request.ws` 只当快捷路径。
 * @param request Fastify 请求
 * @returns 是否为升级请求
 */
function isUpgradeRequest(request: FastifyRequest): boolean {
  if (request.ws === true) return true
  const upgrade = firstHeader(request.headers.upgrade)
  if (upgrade === undefined || upgrade.toLowerCase() !== "websocket") return false
  return (firstHeader(request.headers.connection) ?? "").toLowerCase().includes("upgrade")
}

/**
 * 把监听地址转成"能点开"的形式
 *
 * `0.0.0.0` 与 `::` 是通配监听地址，不是可访问地址。日志里印一条
 * `http://0.0.0.0:2536` 等于给用户一个点不开的链接。
 * @param host 配置里的监听地址
 * @returns 可放进 URL 的主机名
 */
function displayHost(host: string): string {
  if (host === "" || host === "0.0.0.0") return "127.0.0.1"
  if (host === "::" || host === "::0") return "[::1]"
  return host.includes(":") ? `[${host}]` : host
}

/**
 * 造一个带状态码的错误
 * @param status HTTP 状态码
 * @param message 错误文案，会直接回给对方
 * @returns 错误对象
 */
function httpError(status: number, message: string): HttpError {
  const err = new Error(message) as HttpError
  err.statusCode = status
  return err
}

/**
 * 从错误里取状态码
 *
 * 只认 400–599：插件把 `statusCode` 写成 `0` 或 `200` 时，回一个"成功"的错误响应
 * 远比回 500 更难排查。
 * @param err 任意抛出物
 * @returns 状态码；不合法时 500
 */
function statusOf(err: unknown): number {
  if (typeof err !== "object" || err === null) return 500
  const code = (err as { statusCode?: unknown }).statusCode
  if (typeof code !== "number" || !Number.isInteger(code)) return 500
  return code >= 400 && code < 600 ? code : 500
}

/**
 * 判断处理函数的返回值是否为一个 `RouteResponse` 信封
 *
 * `RouteHandler` 允许直接以 `return { ok: true }` 作为响应体，亦允许
 * `return { status: 201, body: x }` 指定状态码，二者必须可以区分。判据是**键集合完全
 * 落在 `status`/`headers`/`body` 之内**：业务对象只要多出一个字段便不会被误判。
 * 确需返回一个恰好只含这三个键的业务对象时，外层包裹一层 `{ body: 该对象 }` 即可。
 * @param value 处理函数的返回值
 * @returns 是否为信封
 */
function isRouteResponse(value: unknown): value is RouteResponse<unknown> {
  if (typeof value !== "object" || value === null) return false
  if (Array.isArray(value) || value instanceof Uint8Array) return false
  const keys = Object.keys(value)
  if (keys.length === 0) return false
  if (!keys.every(key => RESPONSE_KEYS.has(key))) return false
  const rec = value as Record<string, unknown>
  if (rec.status !== undefined && typeof rec.status !== "number") return false
  if (rec.headers !== undefined && (typeof rec.headers !== "object" || rec.headers === null)) return false
  return true
}

/**
 * 把响应体转成 Fastify 认得的形态
 *
 * Fastify 只对 `Buffer.isBuffer()` 为真的值走二进制直发。一个普通 `Uint8Array`
 * 会被当成对象 JSON 序列化成 `{"0":137,"1":80,…}`，而且状态码还是 200 ——
 * 这种故障从现象追回类型问题极其费时，所以在这里就地转掉。
 * @param body 处理函数给的响应体
 * @returns 可交给 `reply.send()` 的值
 */
function toPayload(body: unknown): unknown {
  if (body instanceof Uint8Array && !Buffer.isBuffer(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  }
  return body
}

/**
 * 按处理函数的返回值回响应
 * @param reply Fastify 响应
 * @param result 处理函数的返回值
 * @returns 同一个 `reply`，供处理函数 `return`
 */
function sendResult(reply: FastifyReply, result: unknown): FastifyReply {
  if (result === undefined) return reply.code(204).send()
  if (isRouteResponse(result)) {
    const { status, headers, body } = result
    reply.code(status ?? (body === undefined ? 204 : 200))
    if (headers !== undefined) reply.headers(headers)
    return body === undefined ? reply.send() : reply.send(toPayload(body))
  }
  return reply.send(toPayload(result))
}

/**
 * 解析表单编码的请求体
 *
 * 用 `Object.create(null)` 而不是 `{}`：对字面量对象写 `out["__proto__"] = x` 会真的
 * 改掉它的原型，一个表单字段就能污染下游所有属性查找。
 * @param text 表单文本
 * @returns 无原型的键值对
 */
function formToObject(text: string): Record<string, string> {
  const out = Object.create(null) as Record<string, string>
  for (const [key, value] of new URLSearchParams(text)) out[key] = value
  return out
}

/**
 * 把 `ws` 给的各种数据形态统一成 Buffer
 * @param data `ws` 的 message 回调第一个参数
 * @returns 字节
 */
function toBytes(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data.filter((part): part is Buffer => Buffer.isBuffer(part)))
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  return Buffer.from(String(data), "utf8")
}

/**
 * 把关闭原因统一成字符串
 * @param reason `ws` 的 close 回调第二个参数
 * @returns 原因文本；没有时空串
 */
function reasonOf(reason: unknown): string {
  if (typeof reason === "string") return reason
  if (Buffer.isBuffer(reason)) return reason.toString("utf8")
  return ""
}

/**
 * 将一条 `ws` 原生连接封装为 `WebSocketConnection`
 * @param socket `ws` 原生连接
 * @param id 连接编号
 * @param ip 对端地址
 * @param headers 握手请求头
 * @param log 日志器
 * @returns 交给插件的连接对象
 */
function wrapConnection(
  socket: RawSocket,
  id: string,
  ip: string,
  headers: Readonly<Record<string, string | string[] | undefined>>,
  log: Logger
): WebSocketConnection {
  /** 是否仍认为连接可用 */
  let open = true
  const messageCbs = new Set<(data: string | Uint8Array, isBinary: boolean) => void>()
  const closeCbs = new Set<(code: number, reason: string) => void>()
  const errorCbs = new Set<(err: Error) => void>()

  /*
   * 回调收进 Set 由单一监听分发，而不是每个插件各注册一次
   *
   * 于是 `onMessage()` 的 Disposer 只是从 Set 里删一项 —— 不需要 `off`（`RawSocket` 因而
   * 不必声明它），也不会因一条连接上注册了十几个插件而触发 Node 的 MaxListeners 警告。
   */

  /**
   * 把一个事件分发给一组回调
   * @param set 回调集合
   * @param args 回调实参
   */
  const fire = <A extends unknown[]>(set: ReadonlySet<(...args: A) => void>, ...args: A): void => {
    // 遍历副本：在回调里调用自身的 Disposer 是常见写法，直接遍历原 Set 会让迭代器行为取决于
    // 删除时机。抛错只记日志不外传 —— 单个插件的缺陷不该中断连接，更不该沿 ws 的事件循环
    // 变成 uncaught exception
    for (const cb of [...set]) {
      try {
        cb(...args)
      } catch (err) {
        log.error(`WebSocket ${id} 的回调抛错：${messageOf(err)}`)
      }
    }
  }

  socket.on("message", (data: unknown, isBinary: boolean) => {
    const bytes = toBytes(data)
    fire(messageCbs, isBinary ? bytes : bytes.toString("utf8"), isBinary)
  })

  socket.on("close", (code: number, reason: unknown) => {
    open = false
    fire(closeCbs, typeof code === "number" ? code : 1006, reasonOf(reason))
    // 连接已经结束，留着回调只会把插件闭包连带的对象一直吊在内存里
    messageCbs.clear()
    closeCbs.clear()
    errorCbs.clear()
  })

  socket.on("error", (err: unknown) => {
    const error = err instanceof Error ? err : new Error(String(err))
    // 没人关心时也要留一条痕迹：服务器是 `logger: false` 建的，fastify 自己不会记
    if (errorCbs.size === 0) log.debug(`WebSocket ${id} 出错：${error.message}`)
    fire(errorCbs, error)
  })

  return {
    id,
    ip,
    headers,

    get open(): boolean {
      return open && socket.readyState === WS_OPEN
    },

    send(data: string | Uint8Array): void {
      if (!open || socket.readyState !== WS_OPEN) {
        // 静默丢弃会让"消息发不出去"变成一个查不到的现象，至少留条 debug
        log.debug(`WebSocket ${id} 已不可用，丢弃一条待发消息`)
        return
      }
      socket.send(data)
    },

    close(code?: number, reason?: string): void {
      open = false
      socket.close(code, reason)
    },

    onMessage(cb: (data: string | Uint8Array, isBinary: boolean) => void): Disposer {
      messageCbs.add(cb)
      return () => {
        messageCbs.delete(cb)
      }
    },

    onClose(cb: (code: number, reason: string) => void): Disposer {
      closeCbs.add(cb)
      return () => {
        closeCbs.delete(cb)
      }
    },

    onError(cb: (err: Error) => void): Disposer {
      errorCbs.add(cb)
      return () => {
        errorCbs.delete(cb)
      }
    }
  }
}

/**
 * 共享 HTTP / WebSocket 服务器
 *
 * 实现 `ServerSink`，因此 `ctx.route()` / `ctx.websocket()` / `ctx.static()` 最终都落到
 * 这里。面板自己的 API 也只是"一个 scope 为 `/api` 的普通注册方"，没有任何特权 ——
 * 这是"一切皆可为插件"在服务器层的体现。
 */
export class ManagedServer implements ServerSink {
  /** Fastify 实例 */
  readonly #fastify: FastifyInstance
  /** 内核配置句柄 */
  readonly #config: CoreConfigHandle
  /** 日志器 */
  readonly #logger: Logger
  /** 方法 → 该方法下的路径表 */
  readonly #routes = new Map<HttpMethod, PathTable<RouteEntry>>()
  /** WebSocket 端点表 */
  readonly #ws = new PathTable<WsEntry>()
  /** 静态挂载表 */
  readonly #static = new PathTable<StaticMount>()
  /** 请求 → 查表结果；使用 WeakMap 以免请求对象被本表长期持有 */
  readonly #contexts = new WeakMap<FastifyRequest, RequestContext>()
  /** 请求 → 原始请求体，只在路由声明了 `rawBody` 时写入 */
  readonly #rawBodies = new WeakMap<FastifyRequest, Buffer>()
  /** 当前保持的连接，面板需展示数量，`close()` 需清空 */
  readonly #connections = new Set<WebSocketConnection>()
  /** 连接编号发号器 */
  readonly #nextConnId = createSeqFactory("ws-")
  /** Fastify 内置的 JSON 解析器，带原型污染防护 */
  readonly #jsonParser: JsonParser
  /** 是否已在监听 */
  #listening = false
  /** 是否已关闭 */
  #closed = false
  /** 实际监听到的端口，`listen()` 之后才有值 */
  #port = 0

  /**
   * 建好实例但不监听
   *
   * **不要直接 `new`**，用 `createManagedServer()`：路由必须等到两个 Fastify 插件启动
   * 完成之后才能注册（原因见 `#boot()`），而那是一个异步过程，构造函数里做不到。
   * @param opts 构造参数
   */
  constructor(opts: ManagedServerOptions) {
    this.#config = opts.config
    this.#logger = opts.logger
    this.#fastify = Fastify({
      // 日志走内核自己的 logger；开着 Fastify 的会出现两套格式两份文件
      logger: false,
      // 必须为 false：auth.ts 第 4 条的"是否本机"判断依赖真实 TCP 对端地址
      trustProxy: false,
      // 本服务器已显式注册 HEAD，若再由 Fastify 自动生成一条将冲突为 duplicate route
      exposeHeadRoutes: false,
      bodyLimit: MAX_BODY_LIMIT
    })
    this.#jsonParser = this.#fastify.getDefaultJsonParser("remove", "remove") as JsonParser
    this.#registerPlugins()
  }

  /**
   * 建一个已就绪的服务器
   * @param opts 构造参数
   * @returns 已 `ready()` 的服务器
   */
  static async create(opts: ManagedServerOptions): Promise<ManagedServer> {
    const server = new ManagedServer(opts)
    await server.#boot()
    return server
  }

  /**
   * 启动两个 Fastify 插件，然后装上钩子与那 4 条 catch-all 路由
   *
   * **`await fastify.after()` 这一步不能省。** `fastify.route()` 会**同步**触发
   * `onRoute` 钩子（见 fastify 的 `lib/route.js` 里 `addNewRoute` 直接
   * `for (const hook of this[kHooks].onRoute)`），而 `@fastify/websocket` 的 `onRoute`
   * 钩子是在其自身启动时方才装上的。若先注册路由，该钩子将完全观察不到本服务器的路由，
   * 于是路由的 handler 不会被包上"升级分支" —— 表现为所有 WebSocket 握手均得到一个
   * 普通 HTTP 响应，且完全不报错。
   * @returns 完成时 resolve
   */
  async #boot(): Promise<void> {
    await this.#fastify.after()
    this.#installRoutes()
    await this.#fastify.ready()
  }

  /**
   * 注册 `@fastify/static` 与 `@fastify/websocket`
   *
   * 两个 `register()` 都是延迟的，真正启动要等 `after()` / `ready()`。
   */
  #registerPlugins(): void {
    const fastify = this.#fastify

    // `serve: false` 让它一条路由都不注册，只装饰出 `reply.sendFile()`。
    // 它默认会占用 `/*`，而 `/*` 正是本服务器自己的总入口，见 files.ts 文件头
    fastify.register(fastifyStatic, { serve: false, decorateReply: true })

    fastify.register(fastifyWebsocket, {
      options: {
        // 浏览器将令牌置于子协议中（见 auth.ts 第 2 条）。返回 `WS_PROTOCOL` 即向
        // 浏览器表明"该子协议被接受"，否则 `new WebSocket(url, [...])` 会立即失败
        handleProtocols: (protocols: Set<string>): string | false =>
          protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false
      },
      // 服务器以 `logger: false` 创建，插件内部的 `fastify.log.error` 会被丢弃，
      // 此处将其接回内核日志
      errorHandler: (error: Error, socket: RawSocket): void => {
        this.#logger.error(`WebSocket 连接出错：${error.message}`)
        socket.terminate()
      }
    })
  }

  /**
   * 装上请求体解析器、钩子、错误处理与那 4 条 catch-all 路由
   *
   * 必须在两个插件启动之后调用，见 `#boot()`。
   */
  #installRoutes(): void {
    const fastify = this.#fastify

    fastify.removeAllContentTypeParsers()
    fastify.addContentTypeParser(
      "*",
      (request: FastifyRequest, payload: IncomingMessage, done: (err: Error | null, body?: unknown) => void): void => {
        this.#parseBody(request, payload, done)
      }
    )

    fastify.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) =>
      this.#onRequest(request, reply)
    )

    // `reply.sendFile()` 遇到 ENOENT 会走 `callNotFound()`，加上这个处理器是为了让
    // 404 也是 `{ error: string }` —— 面板前端只需要认一种错误形状
    fastify.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) =>
      this.#reject(reply, 404, `路由 ${pathOf(request.url)} 不存在`)
    )

    fastify.setErrorHandler((err: unknown, request: FastifyRequest, reply: FastifyReply) => {
      const status = statusOf(err)
      // 4xx 源于请求方，记录日志只会被扫描器填满；5xx 源于本服务器，必须记录
      if (status >= 500) {
        this.#logger.error(`处理 ${request.method} ${pathOf(request.url)} 出错：${messageOf(err)}`)
      }
      return this.#reject(reply, status, messageOf(err))
    })

    const handler = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> =>
      this.#dispatch(request, reply)
    const wsHandler = (socket: RawSocket, request: FastifyRequest): void => {
      this.#openConnection(socket, request)
    }
    // GET 之外的方法不能带 wsHandler：`@fastify/websocket` 的 onRoute 钩子会抛
    // `websocket handler can only be declared in GET method`
    const others: HttpMethod[] = ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]

    for (const url of ["/", "/*"]) {
      fastify.route({ method: "GET", url, handler, wsHandler })
      fastify.route({ method: others, url, handler })
    }
  }

  /**
   * 当前服务器状态
   *
   * 刻意做成 getter 而不是构造时算好的常量：`port: 0` 时内核会拿到一个随机端口，
   * 只有 `listen()` 之后才知道是多少，而测试与面板都要显示真实端口。
   * @returns 服务器信息
   */
  get info(): ServerInfo {
    const cfg = this.#config.get().server
    const port = this.#port === 0 ? cfg.port : this.#port
    return {
      enabled: this.#listening,
      host: cfg.host,
      port,
      publicUrl: cfg.publicUrl ?? `http://${displayHost(cfg.host)}:${port}`
    }
  }

  /** 当前保持连接的 WebSocket 数量 */
  get connections(): number {
    return this.#connections.size
  }

  /**
   * 原生 Fastify 实例
   *
   * 保留给两种场合：测试中的 `inject()` / `injectWS()`，以及插件确实需要 Fastify 原生
   * 能力（multipart、SSE、自定义序列化）之时。**直接在其上注册的路由无法摘除**，
   * 插件热重载后会残留为失效路由，因此除已确认可接受该后果外，应使用 `route()`。
   * @returns Fastify 实例
   */
  get raw(): FastifyInstance {
    return this.#fastify
  }

  /**
   * 确保有访问令牌，没有就生成一个并落盘
   *
   * **不再区分是否只监听本机。** 早先只在监听地址对外时生成，理由是「单机用户不该为了
   * 打开面板先去抄一串随机字符」。但那让本机部署处在一种没有门的状态：`checkAuth` 在
   * 无令牌时放行一切回环请求，而「本机」并不等于「可信」—— 使用者浏览器里的任何一个
   * 页面都能向 `127.0.0.1:2536` 发请求，那正是面板的全部写权限。
   *
   * 代价是首次启动多一步：从日志里把令牌抄进面板。故令牌取 16 位字母数字而非 32 位
   * base64url（见 `generateToken`），且面板的令牌页留了一枚「发送到日志」以便重看。
   * @returns 完成时 resolve
   */
  async ensureToken(): Promise<void> {
    const cfg = this.#config.get().server
    if (cfg.token !== undefined && cfg.token !== "") return

    const token = generateToken()
    await this.#config.patch({ server: { token } }, "api")
    // 明文输出一次是必要的：使用者此时即需以其登录面板，且它本已写入配置文件
    this.#logger.warn(`已自动生成面板访问令牌：${token}`)
    this.#logger.warn("首次打开面板须填入它。该令牌已写入配置项 server.token，可随时自行修改")
  }

  /**
   * 开始监听
   *
   * 由 `App.start()` 在插件全部装完之后调用：那时路由才齐，也不会出现"面板半截可用"
   * 的窗口期。
   * @returns 完成时 resolve
   * @throws 服务器已关闭、或端口被占用时
   */
  async listen(): Promise<void> {
    if (this.#closed) throw new Error("服务器已关闭，不能再监听")
    if (this.#listening) return

    const cfg = this.#config.get().server
    await this.#fastify.listen({ host: cfg.host, port: cfg.port })
    const addr = this.#fastify.server.address()
    this.#port = typeof addr === "object" && addr !== null ? addr.port : cfg.port
    this.#listening = true
    this.#logger.info(`面板与插件路由已就绪：${this.info.publicUrl}`)
  }

  /**
   * 关闭服务器
   *
   * 幂等。清表置于 `finally` 中：`fastify.close()` 抛错（例如某个 `preClose` 钩子出现问题）
   * 亦不应残留大量指向已卸载插件闭包的注册项。
   * @returns 完成时 resolve
   */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    try {
      await this.#fastify.close()
    } finally {
      for (const table of this.#routes.values()) table.clear()
      this.#ws.clear()
      this.#static.clear()
      this.#connections.clear()
      this.#listening = false
    }
  }

  /**
   * 注册一条 HTTP 路由
   * @param scope URL 前缀，通常是 `/plugin/<插件名>`
   * @param method 请求方法，大小写不敏感
   * @param path 相对 scope 的路径，可含 `:id` 与末尾的 `*rest`
   * @param handler 处理函数
   * @param opts 路由选项；`auth` 缺省为 true
   * @returns 注销句柄；幂等
   * @throws 服务器已关闭、方法不受支持、或同一模式重复注册时
   */
  route(
    scope: string,
    method: HttpMethod,
    path: string,
    handler: RouteHandler,
    opts: RouteOptions = {}
  ): Disposer {
    this.#assertOpen()
    const key = method.toUpperCase()
    if (!isHttpMethod(key)) throw new Error(`不支持的请求方法 ${method}`)

    const entry: RouteEntry = {
      scope,
      handler,
      // 默认要鉴权：插件作者忘了写选项时，安全的那一侧才该是默认值
      auth: opts.auth !== false,
      limit: this.#clampLimit(opts.bodyLimit),
      rawBody: opts.rawBody === true
    }
    return this.#tableOf(key).add(joinPattern(scope, path), entry)
  }

  /**
   * 注册一个 WebSocket 端点
   *
   * 不给 `verify` 时沿用面板令牌校验（与 `route()` 的 `auth` 默认为 true 对齐）。
   * 适配器的反向连接端点要让平台连进来，就自己给一个 `verify` 做签名校验 ——
   * 给了就完全接管，不再叠加令牌校验。
   * @param scope URL 前缀
   * @param path 相对 scope 的路径
   * @param handler 连接建立后的处理函数
   * @param opts 端点选项
   * @returns 注销句柄；幂等
   * @throws 服务器已关闭、或同一模式重复注册时
   */
  websocket(scope: string, path: string, handler: WebSocketHandler, opts: WebSocketOptions = {}): Disposer {
    this.#assertOpen()
    return this.#ws.add(joinPattern(scope, path), { scope, handler, verify: opts.verify })
  }

  /**
   * 挂一个静态目录
   * @param scope URL 前缀
   * @param urlPath 相对 scope 的 URL 路径，`""` 或 `"/"` 表示挂在 scope 根上
   * @param dir 本地目录绝对路径
   * @returns 注销句柄；幂等
   * @throws 服务器已关闭、`dir` 不是绝对路径、或同一模式重复注册时
   */
  static(scope: string, urlPath: string, dir: string): Disposer {
    return this.#mount(scope, urlPath, dir, false)
  }

  /**
   * 挂载面板：把一个单页应用目录挂到站点根路径
   *
   * 内置面板与接管它的插件都走这里，因此"谁在提供面板"只有一个判定依据
   * （`claimant("/")`）。第二个调用方会在路径表里撞上重复模式而抛错，
   * 这正是期望行为：静默覆盖会让面板显示的内容无法判定。
   * @param owner 归属标识，如 `core` 或 `plugin:webui-next`
   * @param dir 单页应用产物目录（绝对路径）
   * @returns 注销句柄；幂等
   * @throws 服务器已关闭、`dir` 不是绝对路径、或根路径已被占用时
   */
  panel(owner: string, dir: string): Disposer {
    return this.#mount("/", "", dir, true, owner)
  }

  /**
   * 导出全部 HTTP 路由，面板"路由一览"用
   * @returns 路由摘要数组
   */
  listRoutes(): RouteSummary[] {
    const out: RouteSummary[] = []
    for (const [method, table] of this.#routes) {
      for (const item of table.entries()) {
        out.push({ method, pattern: item.pattern, scope: item.value.scope, auth: item.value.auth })
      }
    }
    return out
  }

  /**
   * 导出全部 WebSocket 端点
   * @returns 端点摘要数组
   */
  listWebsockets(): WebSocketSummary[] {
    return this.#ws.entries().map(item => ({ pattern: item.pattern, scope: item.value.scope }))
  }

  /**
   * 导出全部静态挂载
   * @returns 挂载摘要数组
   */
  listStatic(): StaticSummary[] {
    return this.#static.entries().map(item => ({
      pattern: item.pattern,
      dir: item.value.dir,
      spa: item.value.spa
    }))
  }

  /**
   * 查询某路径当前由谁提供
   *
   * 先查静态挂载再查 GET 路由：内核用它判断根路径是否已被插件接管，而接管
   * 面板既可以挂一个单页目录，也可以注册一条返回 HTML 的路由，两种都要认。
   * @param path URL 路径
   * @returns 提供方的注册前缀；无人提供时 undefined
   */
  claimant(path: string): string | undefined {
    const parts = splitSegments(path)
    const mount = this.#static.find(parts)
    if (mount !== undefined) return mount.value.scope
    return this.#routes.get("GET")?.find(parts)?.value.scope
  }

  /**
   * 静态挂载的公共实现
   *
   * 模式写成 `<urlPath>/*rest`：通配段"连什么都不剩也匹配"（见 table.ts 的
   * `matchSegments`），所以 `/webui/*rest` 同时命中 `/webui` 与 `/webui/a/b.js`，
   * 不必再额外注册一条裸路径。
   * @param scope URL 前缀
   * @param urlPath 相对 scope 的 URL 路径
   * @param dir 本地目录绝对路径
   * @param spa 是否单页回退
   * @param owner 归属标识，缺省与 scope 相同；仅面板挂载需要与 scope 不同的值
   * @returns 注销句柄
   * @throws 服务器已关闭或 `dir` 不是绝对路径时
   */
  #mount(scope: string, urlPath: string, dir: string, spa: boolean, owner = scope): Disposer {
    this.#assertOpen()
    if (!isAbsolute(dir)) {
      // 相对路径会随进程工作目录变化，而工作目录取决于用户是怎么启动的
      throw new Error(`静态目录必须是绝对路径，收到 ${dir}`)
    }
    return this.#static.add(joinPattern(scope, `${urlPath}/*${STATIC_REST}`), { dir, spa, scope: owner })
  }

  /**
   * 取某方法的路径表，没有就建
   * @param method 请求方法
   * @returns 路径表
   */
  #tableOf(method: HttpMethod): PathTable<RouteEntry> {
    let table = this.#routes.get(method)
    if (table === undefined) {
      table = new PathTable<RouteEntry>()
      this.#routes.set(method, table)
    }
    return table
  }

  /**
   * 把路由声明的请求体上限收进合法范围
   * @param limit 路由声明的上限
   * @returns 实际生效的上限
   */
  #clampLimit(limit: number | undefined): number {
    if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return DEFAULT_BODY_LIMIT
    if (limit > MAX_BODY_LIMIT) {
      this.#logger.warn(
        `路由声明的 bodyLimit ${formatBytes(limit)} 超过服务器上限，按 ${formatBytes(MAX_BODY_LIMIT)} 处理`
      )
      return MAX_BODY_LIMIT
    }
    return limit
  }

  /**
   * 拒绝在已关闭的服务器上注册
   * @throws 已关闭时
   */
  #assertOpen(): void {
    if (this.#closed) throw new Error("服务器已关闭，不能再注册路由")
  }

  /**
   * 取当前配置里的访问令牌
   * @returns 令牌；未设置时 undefined
   */
  #token(): string | undefined {
    const token = this.#config.get().server.token
    return token === "" ? undefined : token
  }

  /**
   * 回一个统一形状的错误响应
   * @param reply Fastify 响应
   * @param status 状态码
   * @param message 错误文案
   * @param extra 额外响应头
   * @returns 同一个 `reply`
   */
  #reject(reply: FastifyReply, status: number, message: string, extra?: Record<string, string>): FastifyReply {
    if (extra !== undefined) reply.headers(extra)
    return reply.code(status).send({ error: message })
  }

  /**
   * 拒绝一次升级请求
   *
   * 额外附带 `Connection: close`：升级被拒之后该条 TCP 连接已无其他用途，而
   * `@fastify/websocket` 的 `onResponse` 钩子仅在 `request.ws` 为真时才去 destroy
   * socket —— 本服务器的钩子执行于其之前，该标记此时尚未被设置。
   * @param reply Fastify 响应
   * @param status 状态码
   * @param message 错误文案
   * @returns 同一个 `reply`
   */
  #rejectUpgrade(reply: FastifyReply, status: number, message: string): FastifyReply {
    return this.#reject(reply, status, message, { connection: "close" })
  }

  /**
   * 唯一的请求入口钩子：查表 → 鉴权 → 缓存上下文
   *
   * 返回 `undefined` 表示放行，返回 `reply` 表示"已经回过响应了，别再往下走"。后者
   * 之所以真的能拦住后续阶段，是因为 fastify 的 `lib/handle-request.js` 第一行就是
   * `if (reply.sent === true) return`，body 解析与路由处理都在它之后。
   * @param request Fastify 请求
   * @param reply Fastify 响应
   * @returns 已回响应时是 `reply`，放行时是 `undefined`
   */
  async #onRequest(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
    const raw = request.method.toUpperCase()
    const path = pathOf(request.url)
    const parts = splitSegments(path)

    if (isUpgradeRequest(request)) return this.#handleUpgrade(request, reply, path, parts)
    if (!isHttpMethod(raw)) return this.#reject(reply, 405, `不支持的请求方法 ${raw}`)
    const method: HttpMethod = raw

    // HEAD 未单独注册时回落到 GET：Node 的 ServerResponse 对 HEAD 会自动丢弃响应体，
    // 因此直接执行 GET 的处理函数是安全的，同时免去每个插件重复注册两次
    const route =
      method === "HEAD"
        ? (this.#routes.get("HEAD")?.find(parts) ?? this.#routes.get("GET")?.find(parts))
        : this.#routes.get(method)?.find(parts)

    if (route !== undefined) {
      const entry = route.value
      if (entry.auth) {
        const authReq: AuthRequest = { ip: ipOf(request), method, headers: request.headers }
        const failure = checkAuth(this.#token(), authReq) ?? checkForgeableBody(authReq)
        if (failure !== undefined) return this.#reject(reply, failure.status, failure.message)
      }

      // 声明了长度就先按声明拒掉，别等把 64MB 收完再说 413
      const declared = Number(firstHeader(request.headers["content-length"]) ?? "0")
      if (Number.isFinite(declared) && declared > entry.limit) {
        return this.#reject(
          reply,
          413,
          `请求体 ${formatBytes(declared)} 超过该路由的上限 ${formatBytes(entry.limit)}`
        )
      }

      this.#contexts.set(request, {
        method,
        path,
        parts,
        route,
        mount: undefined,
        ws: undefined,
        limit: entry.limit,
        rawBody: entry.rawBody
      })
      return undefined
    }

    if (method === "GET" || method === "HEAD") {
      const mount = this.#static.find(parts)
      if (mount !== undefined) {
        // 静态资源刻意不鉴权，理由见文件头第 4 条
        this.#contexts.set(request, {
          method,
          path,
          parts,
          route: undefined,
          mount,
          ws: undefined,
          limit: DEFAULT_BODY_LIMIT,
          rawBody: false
        })
        return undefined
      }
    }

    const allow = this.#allowFor(parts)
    // 不存在任何方法 → 该路径本身不存在，应为 404 而非 405
    if (allow.length === 0) return this.#reject(reply, 404, `路由 ${path} 不存在`)
    const header = allow.join(", ")
    if (method === "OPTIONS") {
      reply.header("allow", header)
      return reply.code(204).send()
    }
    return this.#reject(reply, 405, `${path} 不支持 ${method}`, { allow: header })
  }

  /**
   * 算出某路径支持哪些方法，用于 `Allow` 响应头
   * @param parts 已解码的路径段
   * @returns 方法数组；路径不存在时为空数组
   */
  #allowFor(parts: readonly string[]): HttpMethod[] {
    const out: HttpMethod[] = []
    for (const method of HTTP_METHODS) {
      if (this.#routes.get(method)?.find(parts) !== undefined) out.push(method)
    }
    // 这两条是服务器代劳的，注册表里查不到但确实支持
    if (out.includes("GET") && !out.includes("HEAD")) out.push("HEAD")
    if (out.length > 0 && !out.includes("OPTIONS")) out.push("OPTIONS")
    return out
  }

  /**
   * 处理一次 WebSocket 升级请求
   *
   * 全部拒绝都在这里做完，理由见文件头第 3 条：此刻回的是真正的 HTTP 响应，对方能
   * 从状态码和响应体里看到原因；进了 `wsHandler` 之后就只剩"关连接"这一种表达方式。
   * @param request Fastify 请求
   * @param reply Fastify 响应
   * @param path 请求路径
   * @param parts 已解码的路径段
   * @returns 已拒绝时是 `reply`，放行时是 `undefined`
   */
  async #handleUpgrade(
    request: FastifyRequest,
    reply: FastifyReply,
    path: string,
    parts: readonly string[]
  ): Promise<FastifyReply | undefined> {
    const hit = this.#ws.find(parts)
    if (hit === undefined) return this.#rejectUpgrade(reply, 404, `WebSocket 端点 ${path} 不存在`)

    const ctx: RequestContext = {
      method: "GET",
      path,
      parts,
      route: undefined,
      mount: undefined,
      ws: hit,
      limit: 0,
      rawBody: false
    }

    const verify = hit.value.verify
    if (verify === undefined) {
      const failure = checkAuth(this.#token(), { ip: ipOf(request), method: "GET", headers: request.headers })
      if (failure !== undefined) return this.#rejectUpgrade(reply, failure.status, failure.message)
    } else {
      let ok = false
      try {
        ok = await verify(this.#toRequest(request, ctx, hit.params))
      } catch (err) {
        // verify 抛出异常等同于校验未通过，但须记录日志：否则 verify 中的一处拼写错误将
        // 表现为"对端无法连接，而服务端未给出任何信息"
        this.#logger.error(`WebSocket ${hit.pattern} 的 verify 抛错：${messageOf(err)}`)
      }
      if (!ok) return this.#rejectUpgrade(reply, 401, `WebSocket ${path} 校验未通过`)
    }

    this.#contexts.set(request, ctx)
    return undefined
  }

  /**
   * 把 Fastify 请求转成插件看到的 `RouteRequest`
   *
   * 插件拿到的是一个平的、只读的普通对象，不是 Fastify 请求：一方面插件不该依赖
   * Fastify 的 API（将来换 HTTP 实现时才不必改插件），另一方面这样也堵住了插件从
   * `request` 上摸到 `raw.socket` 去做越权操作的路。
   * @param request Fastify 请求
   * @param ctx 本次请求的查表结果
   * @param params 路径参数
   * @returns 只读请求对象
   */
  #toRequest(
    request: FastifyRequest,
    ctx: RequestContext,
    params: Readonly<Record<string, string>>
  ): RouteRequest {
    return {
      method: ctx.method,
      path: ctx.path,
      params,
      query: request.query as Readonly<Record<string, string | string[] | undefined>>,
      headers: request.headers,
      body: request.body,
      rawBody: this.#rawBodies.get(request),
      ip: ipOf(request)
    }
  }

  /**
   * 唯一的请求体解析器
   *
   * 只注册一个 `"*"` catch-all 而不是按类型注册若干个，原因和路由一样：限流上限是
   * **按路由**来的，只有拿到本次请求的上下文才知道该按多少截断，而 Fastify 的按类型
   * 解析器拿不到"这条请求命中了哪个路由"。
   * @param request Fastify 请求
   * @param payload 原始请求流
   * @param done 解析完成回调
   */
  #parseBody(
    request: FastifyRequest,
    payload: IncomingMessage,
    done: (err: Error | null, body?: unknown) => void
  ): void {
    const ctx = this.#contexts.get(request)
    const limit = ctx?.limit ?? DEFAULT_BODY_LIMIT
    const chunks: Buffer[] = []
    let size = 0
    let settled = false

    /**
     * 只允许回调一次
     * @param err 错误
     * @param body 解析结果
     */
    const finish = (err: Error | null, body?: unknown): void => {
      if (settled) return
      settled = true
      done(err, body)
    }

    payload.on("data", (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        finish(httpError(413, `请求体超过该路由的上限 ${formatBytes(limit)}`))
        // 若不 resume，该连接会持续等待本端读取，直至对端超时
        payload.resume()
        return
      }
      chunks.push(chunk)
    })

    payload.on("aborted", () => {
      finish(httpError(400, "请求体尚未传完连接就断了"))
    })

    payload.on("error", (err: Error) => {
      finish(err)
    })

    payload.on("end", () => {
      if (settled) return
      const raw = Buffer.concat(chunks)
      // 仅声明了 rawBody 的路由才保留原始字节：缺省保留会使每个请求额外驻留一份副本
      if (ctx?.rawBody === true) this.#rawBodies.set(request, raw)
      if (raw.length === 0) {
        finish(null, undefined)
        return
      }

      const type = mediaTypeOf(firstHeader(request.headers["content-type"]))
      if (type === "application/json" || type.endsWith("+json")) {
        this.#jsonParser(request, raw.toString("utf8"), finish)
        return
      }
      if (type === "") {
        // 部分设备端 SDK 完全不发送 content-type。先按 JSON 尝试解析，失败则将原始字节
        // 交由路由自行处理 —— 若仅返回一个不含说明的 400，对端无从判断问题所在
        this.#jsonParser(request, raw.toString("utf8"), (err, body) => {
          finish(null, err === null ? body : raw)
        })
        return
      }
      if (type === "application/x-www-form-urlencoded") {
        finish(null, formToObject(raw.toString("utf8")))
        return
      }
      if (type.startsWith("text/") || type === "application/xml" || type.endsWith("+xml")) {
        finish(null, raw.toString("utf8"))
        return
      }
      // 其余（含 multipart）原样给出去，需要的插件自己解
      finish(null, raw)
    })
  }

  /**
   * 真正分发一次请求
   *
   * 走到这里说明 `onRequest` 已经放行，所以上下文一定在；查不到只可能是有人绕开了钩子
   * （比如直接往 `raw` 上加了路由），那是 500 而不是 404。
   * @param request Fastify 请求
   * @param reply Fastify 响应
   * @returns 同一个 `reply`
   */
  async #dispatch(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const ctx = this.#contexts.get(request)
    if (ctx === undefined) return this.#reject(reply, 500, "请求上下文丢失：这条路由不是通过 route() 注册的")

    if (ctx.route !== undefined) {
      const result = await ctx.route.value.handler(this.#toRequest(request, ctx, ctx.route.params))
      return sendResult(reply, result)
    }

    if (ctx.mount !== undefined) {
      const rest = ctx.mount.params[STATIC_REST] ?? ""
      const rel = await resolveStaticFile(ctx.mount.value, rest)
      if (rel === undefined) {
        reply.callNotFound()
        return reply
      }
      // 此处给出的是**未编码**的相对路径：`@fastify/static` 内部会自行 `encodeURI()`
      // 再交给 `@fastify/send`，若在此提前编码将造成双重编码
      return reply.sendFile(rel, ctx.mount.value.dir)
    }

    // 携带升级头进入但最终未被 `@fastify/websocket` 接管 —— 最常见的原因是对端实际
    // 发送的是一个普通 GET 请求，因此明确说明该端点仅接受 WebSocket，避免对端只见 404 而无从判断
    if (ctx.ws !== undefined) {
      return this.#reject(reply, 400, `${ctx.path} 是一个 WebSocket 端点，请使用 WebSocket 连接`)
    }
    return this.#reject(reply, 404, `路由 ${ctx.path} 不存在`)
  }

  /**
   * 一条 WebSocket 握手成功后接管连接
   * @param socket `ws` 原生连接
   * @param request 握手时的 Fastify 请求
   */
  #openConnection(socket: RawSocket, request: FastifyRequest): void {
    const ctx = this.#contexts.get(request)
    const hit = ctx?.ws
    if (ctx === undefined || hit === undefined) {
      socket.close(1011, "服务器内部状态丢失")
      return
    }

    const conn = wrapConnection(socket, this.#nextConnId(), ipOf(request), request.headers, this.#logger)
    this.#connections.add(conn)
    conn.onClose(() => {
      this.#connections.delete(conn)
    })

    try {
      hit.value.handler(conn, this.#toRequest(request, ctx, hit.params))
    } catch (err) {
      // 处理函数是同步抛的，此时插件很可能还没挂上任何回调，直接关掉比留个哑连接好
      this.#logger.error(`WebSocket ${hit.pattern} 的处理函数抛错：${messageOf(err)}`)
      conn.close(1011, "处理函数抛错")
    }
  }

}

/**
 * 创建一个共享服务器，但**不**开始监听
 *
 * `await ready()` 在此处即完成，而非留至 `listen()`：`ready()` 之后 Fastify 不再
 * 接受新路由，而本服务器共计只有那 4 条 catch-all，插件后续注册的路由均进入 `PathTable`，
 * 不经由 Fastify —— 因此提前 ready 是安全的，同时可使 `raw.inject()` / `raw.injectWS()`
 * 在不占用端口的前提下直接用于测试。
 * @param opts 构造参数
 * @returns 已就绪的服务器
 */
export async function createManagedServer(opts: ManagedServerOptions): Promise<ManagedServer> {
  return ManagedServer.create(opts)
}


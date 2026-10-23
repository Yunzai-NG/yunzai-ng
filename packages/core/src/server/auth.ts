/**
 * 模块职责：面板与插件路由的访问控制 —— 令牌生成、校验、跨站伪造防线
 * 依赖方向：只依赖 node:crypto 与类型包
 * 生命周期：纯函数，无状态；令牌本身存在配置里
 * 注意事项：四条安全约定 ——
 *          1) 令牌只从请求头读，绝不从查询串或 Cookie 读：前者会进 access log 与 Referer，后者会被
 *             浏览器自动附带（CSRF 的成因）。故本服务器免疫 CSRF、不需要 CSRF token；代价是
 *             `EventSource` 用不了（它设不了请求头），日志实时推送因此走 WebSocket
 *          2) 浏览器 WebSocket 同样设不了请求头，故允许把令牌放进 `Sec-WebSocket-Protocol`
 *          3) 比较走 SHA-256 摘要 + `timingSafeEqual`：直接对原文用后者会在长度不等时抛错，
 *             等于把「长度对不对」变成旁路信号
 *          4) 没设令牌时只放行本机，判据是 TCP 对端地址，且服务器强制 `trustProxy: false` ——
 *             否则一个 `X-Forwarded-For: 127.0.0.1` 就能把自己伪装成本机
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

/**
 * 自动生成令牌的字符数
 *
 * 取 16 位而非更长：这串东西使用者要从日志里抄进浏览器（面板首次打开即要求它），
 * 而 16 位已远超爆破所需 —— 字符集 62 个，16 位约 95 bit 熵。
 */
const TOKEN_CHARS = 16

/**
 * 令牌的字符集
 *
 * 刻意不用 base64url：`-` 与 `_` 在「从日志里抄一串字符」这件事上是纯粹的负担，
 * 而人工转录正是这串东西的主要用法。也不剔除 `0O1lI` 一类形近字符 —— 剔除会削减
 * 每位的熵，而使用者多半是复制粘贴，真手抄时字体等宽（日志与输入框都是）。
 */
const TOKEN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

/** 令牌请求头（`Authorization: Bearer` 之外的简易写法） */
const TOKEN_HEADER = "x-yunzai-token"

/** WebSocket 子协议里约定的第一个标识，第二个才是令牌 */
export const WS_PROTOCOL = "yunzai"

/**
 * 会被跨站表单 / 简单请求造出来的请求体类型
 *
 * 这三种 `Content-Type` 不触发预检，因此一个恶意页面可以在用户不知情的情况下
 * 向 `127.0.0.1` 发出携带它们的 POST。面板的写接口一律只收 JSON，于是把这三种
 * 直接挡在门外 —— 挡的不是"错误的格式"，是"唯一一条能绕开同源策略的路"。
 */
const FORGEABLE_TYPES = ["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"]

/** 会改变状态、因此需要防伪造的方法 */
const UNSAFE_METHODS = ["POST", "PUT", "PATCH", "DELETE"]

/**
 * 生成一个新的访问令牌
 *
 * 用 `randomBytes` 而**不是** `util/id.ts` 的 `randomId()`：后者对随机字节取模
 * 引入了可忽略但真实存在的分布偏差，其文档里也写明"不用于密码学场景"。
 * 令牌正是密码学场景。
 *
 * **取字符时同样不能取模**（`byte % 62`）—— 那正是 `randomId()` 被弃用的那个偏差：
 * 256 不是 62 的整数倍，`0..255` 取模后前 8 个字符各命中 5 个字节、其余各 4 个，
 * 即前 8 个字符的概率高出 25%。故用拒绝采样：落在 `62 * 4 = 248` 之外的字节
 * 直接丢弃重取，代价是平均多取 3% 的字节。
 * @returns 16 字符的令牌，字符集为大小写字母与数字
 */
export function generateToken(): string {
  const limit = Math.floor(256 / TOKEN_ALPHABET.length) * TOKEN_ALPHABET.length
  let out = ""
  while (out.length < TOKEN_CHARS) {
    // 一次多取一些，省去逐字节调用系统随机源的开销；不够时循环会再取一批
    for (const byte of randomBytes(TOKEN_CHARS)) {
      if (byte >= limit) continue
      out += TOKEN_ALPHABET[byte % TOKEN_ALPHABET.length]
      if (out.length === TOKEN_CHARS) break
    }
  }
  return out
}

/**
 * 定时安全地比较两个令牌
 * @param expected 配置里的令牌
 * @param given 请求带来的令牌
 * @returns 是否一致
 */
export function tokenEquals(expected: string, given: string): boolean {
  const a = createHash("sha256").update(expected, "utf8").digest()
  const b = createHash("sha256").update(given, "utf8").digest()
  return timingSafeEqual(a, b)
}

/**
 * 判断一个对端地址是否是本机
 *
 * IPv4 的整个 `127.0.0.0/8` 都是回环，不只是 `127.0.0.1`；Node 在双栈监听下
 * 会把 IPv4 对端写成 `::ffff:127.0.0.1` 这种映射形式。两者都要认。
 * @param address 对端地址；unix socket 等场景可能是空串
 * @returns 是否本机
 */
export function isLoopbackAddress(address: string): boolean {
  if (address === "") return false
  const ip = address.startsWith("::ffff:") ? address.slice(7) : address
  if (ip === "::1" || ip === "localhost") return true
  if (!ip.includes(".")) return false
  return ip.startsWith("127.")
}

/**
 * 判断配置中填写的监听地址是否仅对本机可见
 *
 * **内核自身已不再据此放宽任何东西。** 早先 `ensureToken()` 用它决定「只监听本机就不生成
 * 令牌」，那条已去掉（理由见那个方法）—— 令牌恒生成，与监听地址无关。
 *
 * 保留本函数是因为它已随 `export *` 成为对外 API，且「这个地址是否只对本机可见」本身
 * 是插件会问的问题（如决定要不要在日志里提醒使用者暴露风险）。
 * @param host 监听地址
 * @returns 是否只对本机可见
 */
export function isLocalHost(host: string): boolean {
  return host === "localhost" || isLoopbackAddress(host)
}

/**
 * 从请求头里取出令牌
 *
 * 三个来源按优先级：`Authorization: Bearer x` → `x-yunzai-token: x` →
 * `Sec-WebSocket-Protocol: yunzai, x`。刻意**不看**查询串与 Cookie，见文件头第 1 条。
 * @param headers 已小写化键名的请求头
 * @returns 令牌；没带时 undefined
 */
export function readToken(headers: Readonly<Record<string, string | string[] | undefined>>): string | undefined {
  const auth = firstValue(headers.authorization)
  if (auth !== undefined) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim())
    if (match?.[1] !== undefined) return match[1].trim()
  }

  const plain = firstValue(headers[TOKEN_HEADER])
  if (plain !== undefined && plain !== "") return plain.trim()

  const protocols = firstValue(headers["sec-websocket-protocol"])
  if (protocols !== undefined) {
    const parts = protocols.split(",").map(part => part.trim())
    if (parts[0] === WS_PROTOCOL && parts[1] !== undefined && parts[1] !== "") return parts[1]
  }

  return undefined
}

/**
 * 取请求头的第一个值
 *
 * Node 对重复出现的请求头会给出数组。取第一个而非拼接：令牌被写入两次时，
 * 拼接得到的字符串必定校验失败，而报错信息会指向"令牌错误"而非"令牌重复出现"。
 * @param value 头值
 * @returns 首个值；不存在时 undefined
 */
function firstValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined
  return Array.isArray(value) ? value[0] : value
}

/** 一个对端的失败记录 */
interface FailureRecord {
  /** 窗口内的失败次数 */
  count: number
  /** 窗口起点 */
  since: number
  /** 封禁到何时；未封禁时 0 */
  blockedUntil: number
}

/**
 * 按对端地址数鉴权失败次数，失败太多就暂时拒绝该地址
 *
 * 自动生成的令牌有 95 bit，爆破无从谈起；但 `server.token` 可以手填，填成 `123456` 再把端口
 * 开到公网，没有这一层就是一台可以无限次猜的机器。阈值放得宽：一个开着旧令牌的标签页在
 * 断线重连，十分钟里也凑不满 30 次。
 *
 * **本机不计。** 经反向代理进来的请求对端都是本机 —— 那时这一层无从区分来人，限流该交给代理做；
 * 本机的使用者也不该被自己一个写错令牌的脚本锁在门外。
 */
export class AuthLimiter {
  /** 窗口长度 */
  static readonly WINDOW_MS = 10 * 60_000
  /** 窗口内允许的失败次数 */
  static readonly MAX_FAILURES = 30
  /** 封禁时长 */
  static readonly BLOCK_MS = 15 * 60_000
  /** 最多记多少个地址；超出时先丢最早的，免得被换着地址打爆内存 */
  static readonly MAX_ENTRIES = 4096

  readonly #records = new Map<string, FailureRecord>()
  readonly #now: () => number

  /**
   * @param now 取当前时刻，测试里换成假时钟
   */
  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  /**
   * 该地址此刻是否被封
   * @param ip 对端地址
   * @returns 封禁剩余秒数；未封禁时 0
   */
  blockedFor(ip: string): number {
    if (isLoopbackAddress(ip)) return 0
    const rec = this.#records.get(ip)
    if (rec === undefined) return 0
    const left = rec.blockedUntil - this.#now()
    return left > 0 ? Math.ceil(left / 1000) : 0
  }

  /**
   * 记一次失败
   * @param ip 对端地址
   * @returns 这一次是否刚好触发了封禁（调用方据此只记一条日志）
   */
  fail(ip: string): boolean {
    if (isLoopbackAddress(ip)) return false
    const now = this.#now()
    let rec = this.#records.get(ip)
    if (rec === undefined || now - rec.since > AuthLimiter.WINDOW_MS) {
      rec = { count: 0, since: now, blockedUntil: 0 }
      this.#records.delete(ip)
      this.#records.set(ip, rec)
      this.#prune()
    }
    rec.count++
    if (rec.count >= AuthLimiter.MAX_FAILURES && rec.blockedUntil <= now) {
      rec.blockedUntil = now + AuthLimiter.BLOCK_MS
      return true
    }
    return false
  }

  /**
   * 该地址带对了令牌：清掉它的记录
   * @param ip 对端地址
   */
  succeed(ip: string): void {
    this.#records.delete(ip)
  }

  /** 超出上限时丢掉最早插入的那些（Map 按插入序迭代） */
  #prune(): void {
    for (const key of this.#records.keys()) {
      if (this.#records.size <= AuthLimiter.MAX_ENTRIES) return
      this.#records.delete(key)
    }
  }
}

/** 鉴权失败的描述 */
export interface AuthFailure {
  /** 建议的 HTTP 状态码 */
  readonly status: number
  /** 给人看的原因，会直接写进响应体 */
  readonly message: string
  /** 额外的响应头，如封禁时的 `retry-after` */
  readonly headers?: Readonly<Record<string, string>>
}

/** 一次鉴权要用到的请求信息 */
export interface AuthRequest {
  /** 对端地址（必须是 TCP 对端，不能是 `X-Forwarded-For`） */
  readonly ip: string
  /** 请求方法 */
  readonly method: string
  /** 已小写化键名的请求头 */
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
}

/**
 * 校验一次访问
 *
 * 规则：
 * - 已配置令牌 → 一律要求携带正确令牌，**本机亦不例外**。本机进程与使用者浏览器中
 *   的任意页面均可访问 `127.0.0.1`，"本机"并不等同于"可信"。
 * - 未配置令牌 → 仅放行本机对端；外部访问直接拒绝，并说明需要配置的内容。
 * @param token 配置中的令牌；未设置时 undefined
 * @param req 请求信息
 * @returns 校验失败时的描述；通过时 undefined
 */
export function checkAuth(token: string | undefined, req: AuthRequest): AuthFailure | undefined {
  if (token === undefined || token === "") {
    if (isLoopbackAddress(req.ip)) return undefined
    return {
      status: 401,
      message: "本服务器尚未设置访问令牌，因此只接受本机访问。请在 config/yunzai.yaml 的 server.token 里设置令牌后重启"
    }
  }

  const given = readToken(req.headers)
  if (given === undefined) {
    return {
      status: 401,
      message: "缺少访问令牌。请在请求头带上 Authorization: Bearer <令牌>，或 x-yunzai-token: <令牌>"
    }
  }
  if (!tokenEquals(token, given)) return { status: 403, message: "访问令牌不正确" }
  return undefined
}

/**
 * 校验请求体类型，挡掉可跨站伪造的写请求
 *
 * 只对需要鉴权的路由生效：适配器 webhook 常用表单编码，它们走 `auth: false`
 * 并自行验签，不该被这条规则牵连。
 * @param req 请求信息
 * @returns 校验失败时的描述；通过时 undefined
 */
export function checkForgeableBody(req: AuthRequest): AuthFailure | undefined {
  if (!UNSAFE_METHODS.includes(req.method)) return undefined
  const type = (firstValue(req.headers["content-type"]) ?? "").split(";")[0]?.trim().toLowerCase() ?? ""
  if (type === "" || !FORGEABLE_TYPES.includes(type)) return undefined
  return {
    status: 415,
    message: `${type} 不被接受：需要鉴权的写接口只收 application/json（这条限制是为了挡住跨站伪造请求）`
  }
}

/**
 * 模块职责：面板与插件路由的访问控制 —— 令牌生成、校验、跨站伪造防线
 * 依赖方向：只依赖 node:crypto 与类型包
 * 生命周期：纯函数，无状态；令牌本身存在配置里
 * 注意事项：四条安全约定 ——
 *
 *          **令牌只从请求头读，绝不从查询串或 Cookie 读。** 查询串会进 access log、浏览器历史与
 *          Referer；Cookie 会被浏览器自动附带，那正是 CSRF 的成因。头部令牌没有「自动附带」这回事，
 *          故本服务器天然免疫 CSRF，也因此不需要 CSRF token。代价是 `EventSource` 用不了（它设不了
 *          请求头），故日志实时推送走 WebSocket。
 *
 *          **浏览器 WebSocket 同样设不了请求头**，故允许把令牌放进 `Sec-WebSocket-Protocol`。
 *          它是请求头的一部分，同样不会被自动附带。
 *
 *          **比较走 SHA-256 摘要 + `timingSafeEqual`。** 直接对原文用后者会在长度不等时抛错，
 *          等于把「长度对不对」变成一个旁路信号；先摘要则两边恒为 32 字节。
 *
 *          **没设令牌时只放行本机**，判据是 TCP 对端地址，且服务器强制 `trustProxy: false` ——
 *          否则任何人都能靠一个 `X-Forwarded-For: 127.0.0.1` 把自己伪装成本机。
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

/** 自动生成令牌的字节数：24 字节 → base64url 32 字符，既可抵御爆破又便于人工转录 */
const TOKEN_BYTES = 24

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
 * @returns base64url 编码的 32 字符令牌
 */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url")
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
 * `ensureToken()` 据此决定是否强制生成令牌：仅监听本机时不生成，
 * 以免单机部署的使用者被一串随机字符阻挡在面板之外。
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

/** 鉴权失败的描述 */
export interface AuthFailure {
  /** 建议的 HTTP 状态码 */
  readonly status: number
  /** 给人看的原因，会直接写进响应体 */
  readonly message: string
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

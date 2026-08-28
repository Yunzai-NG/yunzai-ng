/**
 * 模块职责：HTTP / WebSocket 路由契约
 * 依赖方向：依赖 common.ts
 * 生命周期：纯类型
 * 注意事项：全进程只有一个 HTTP 服务器，面板、插件路由与适配器的反向连接共用它 ——
 *          故端口与鉴权只有一处。
 */
import type { Awaitable, Disposer } from "./common.js"

/** HTTP 方法 */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"

/** 路由请求 */
export interface RouteRequest<B = unknown> {
  /** 请求方法 */
  readonly method: HttpMethod
  /** 完整路径 */
  readonly path: string
  /** 路径参数（`/x/:id` 的 id） */
  readonly params: Readonly<Record<string, string>>
  /** 查询串参数 */
  readonly query: Readonly<Record<string, string | string[] | undefined>>
  /** 请求头（键已小写化） */
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  /** 已解析的请求体（JSON / 表单），无体时 undefined */
  readonly body: B
  /** 原始请求体字节，签名校验时用 */
  readonly rawBody?: Uint8Array
  /** 客户端 IP */
  readonly ip: string
}

/** 路由响应 */
export interface RouteResponse<T = unknown> {
  /** HTTP 状态码，缺省 200 */
  status?: number
  /** 附加响应头 */
  headers?: Record<string, string>
  /** 响应体：对象自动 JSON 序列化，字符串/字节原样输出 */
  body?: T
}

/**
 * 路由处理函数
 *
 * 直接返回非 RouteResponse 的值时，等价于 `{ status: 200, body: 该值 }`。
 */
export type RouteHandler<B = unknown, T = unknown> = (req: RouteRequest<B>) => Awaitable<RouteResponse<T> | T>

/** 路由注册选项 */
export interface RouteOptions {
  /**
   * 是否要求 WebUI 口令
   *
   * 缺省 true。适配器的 webhook 端点通常自带签名校验，可设 false 并自行验签。
   */
  auth?: boolean
  /** 请求体大小上限（字节），缺省 1MB */
  bodyLimit?: number
  /** 是否保留原始请求体（验签需要），缺省 false */
  rawBody?: boolean
}

/** 一条 WebSocket 连接 */
export interface WebSocketConnection {
  /** 连接 id */
  readonly id: string
  /** 客户端 IP */
  readonly ip: string
  /** 握手请求头 */
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  /** 连接是否仍然打开 */
  readonly open: boolean

  /**
   * 发送数据
   * @param data 文本或字节
   */
  send(data: string | Uint8Array): void

  /**
   * 关闭连接
   * @param code 关闭码
   * @param reason 原因
   */
  close(code?: number, reason?: string): void

  /**
   * 监听收到消息
   * @param cb 回调
   * @returns 取消监听的句柄
   */
  onMessage(cb: (data: string | Uint8Array, isBinary: boolean) => void): Disposer

  /**
   * 监听关闭
   * @param cb 回调
   * @returns 取消监听的句柄
   */
  onClose(cb: (code: number, reason: string) => void): Disposer

  /**
   * 监听错误
   * @param cb 回调
   * @returns 取消监听的句柄
   */
  onError(cb: (err: Error) => void): Disposer
}

/**
 * WebSocket 处理函数
 *
 * NapCat 的"反向 WS"（NapCat 主动连过来）就用这个：适配器注册一个路径，
 * NapCat 连上来后每个连接调一次。
 */
export type WebSocketHandler = (conn: WebSocketConnection, req: RouteRequest) => void

/** WebSocket 路由选项 */
export interface WebSocketOptions {
  /**
   * 握手校验
   *
   * 返回 false 或抛错则拒绝升级。用于校验 `Authorization: Bearer <token>`。
   * @param req 握手请求
   * @returns 是否允许连接
   */
  verify?: (req: RouteRequest) => Awaitable<boolean>
}

/** 服务器对外信息，供适配器拼回调地址 */
export interface ServerInfo {
  /**
   * 服务器是否已启用
   *
   * 使用者可关闭内置服务器（`server.enable: false`）。需被动接入的适配器
   * （反向 WS、HTTP 回调）必须先检查该标志，于**创建账号时**即告知使用者
   * "该模式需先开启内置服务器"，而非等待对端连接失败后再行推断。
   */
  readonly enabled: boolean
  /** 监听地址 */
  readonly host: string
  /** 监听端口 */
  readonly port: number
  /** 配置里填的对外可访问基址（反代场景），未配置时由 host:port 推导 */
  readonly publicUrl: string
}

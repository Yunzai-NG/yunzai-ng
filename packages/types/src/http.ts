/**
 * 模块职责：HTTP 客户端契约
 * 依赖方向：依赖 common.ts
 * 生命周期：纯类型
 * 注意事项：插件一律用 `ctx.http` 而不自己 `import fetch`：超时、重试与代理只在一处配置，
 *          排障时也只有一处要看。
 */
import type { DurationLike } from "./common.js"

/** 期望的响应解析方式 */
export type HttpResponseType = "json" | "text" | "buffer" | "stream" | "none"

/** 重试策略 */
export interface HttpRetryOptions {
  /** 最多重试几次（不含首次），缺省 0 */
  times: number
  /** 首次重试的等待时长，之后指数退避 */
  delay?: DurationLike
  /** 哪些状态码需要重试，缺省 `[408, 429, 500, 502, 503, 504]` */
  statuses?: number[]
  /** 自定义判定；返回 true 表示重试 */
  when?: (err: unknown, res?: HttpResponse<unknown>) => boolean
}

/** 请求选项 */
export interface HttpRequestOptions {
  /** HTTP 方法，缺省 GET（有 body 时缺省 POST） */
  method?: string
  /** 请求头 */
  headers?: Record<string, string>
  /** 查询串参数，值为 undefined 的键会被丢弃 */
  query?: Record<string, string | number | boolean | undefined | null>
  /** 原始请求体 */
  body?: string | Uint8Array
  /** JSON 请求体，自动序列化并设置 Content-Type */
  json?: unknown
  /** 表单请求体，自动 urlencode */
  form?: Record<string, string | number | boolean>
  /** 超时，缺省 10s */
  timeout?: DurationLike
  /** 重试策略 */
  retry?: number | HttpRetryOptions
  /** 代理地址，缺省用全局配置 */
  proxy?: string | false
  /** 响应解析方式，缺省 json */
  responseType?: HttpResponseType
  /** 外部中止信号 */
  signal?: AbortSignal
  /** 是否跟随重定向，缺省 true */
  followRedirect?: boolean
  /** 非 2xx 是否抛错，缺省 true */
  throwOnError?: boolean
}

/** 响应 */
export interface HttpResponse<T = unknown> {
  /** 状态码 */
  status: number
  /** 状态文本 */
  statusText: string
  /** 响应头（键已小写化） */
  headers: Record<string, string>
  /** 解析后的数据 */
  data: T
  /** 是否 2xx */
  ok: boolean
  /** 最终 URL（跟随重定向后） */
  url: string
  /** 耗时毫秒 */
  cost: number
}

/** 客户端默认值 */
export interface HttpDefaults {
  /** 基址，相对 URL 会拼在它后面 */
  baseUrl?: string
  /** 默认请求头 */
  headers?: Record<string, string>
  /** 默认超时 */
  timeout?: DurationLike
  /** 默认重试 */
  retry?: number | HttpRetryOptions
  /** 默认代理 */
  proxy?: string | false
  /**
   * 默认中止信号
   *
   * 由此派生出的客户端所发的每个请求都跟随它 —— 插件的 `ctx.http` 即绑在插件的
   * 卸载信号上，插件卸载时其在途请求随之中止，不必由插件逐个请求传 `signal`。
   * 单次请求另传 `signal` 时两者取并集：任一触发即中止。
   */
  signal?: AbortSignal
}

/** HTTP 客户端 */
export interface HttpClient {
  /**
   * 发起请求，取得完整响应
   * @param url 绝对 URL 或相对 baseUrl 的路径
   * @param opts 请求选项
   * @returns 完整响应
   * @throws 网络错误，或非 2xx 且 `throwOnError` 未关闭
   */
  request<T = unknown>(url: string, opts?: HttpRequestOptions): Promise<HttpResponse<T>>

  /**
   * GET 并直接返回解析后的数据
   * @param url 地址
   * @param opts 请求选项
   * @returns 响应数据
   */
  get<T = unknown>(url: string, opts?: Omit<HttpRequestOptions, "method">): Promise<T>

  /**
   * POST 并直接返回解析后的数据
   * @param url 地址
   * @param json JSON 请求体
   * @param opts 请求选项
   * @returns 响应数据
   */
  post<T = unknown>(url: string, json?: unknown, opts?: Omit<HttpRequestOptions, "method" | "json">): Promise<T>

  /**
   * 下载为字节
   * @param url 地址
   * @param opts 请求选项
   * @returns 字节内容
   */
  buffer(url: string, opts?: HttpRequestOptions): Promise<Uint8Array>

  /**
   * 下载到本地文件（流式，不占内存）
   * @param url 地址
   * @param dest 目标绝对路径
   * @param opts 请求选项
   * @returns 实际写入的路径
   */
  download(url: string, dest: string, opts?: HttpRequestOptions): Promise<string>

  /**
   * 派生带新默认值的客户端
   * @param defaults 要覆盖的默认值
   * @returns 新客户端，不影响原客户端
   */
  extend(defaults: HttpDefaults): HttpClient
}

/**
 * 模块职责：适配器契约（"账号登录也是插件"的落地点）
 * 依赖方向：依赖 bot / event / logger / store / schema / server / media / common
 * 生命周期：纯类型
 * 注意事项：账号被拆成 `AccountRecord`（数据）与 `AdapterProvider`（插件）两半，
 *          两者在运行时撮合。内核不知道 QQ 是什么，只知道「某个插件声称能把一份账号
 *          配置变成一个能收发消息的 `BotDriver`」。
 */
import type { BotApi } from "./bot.js"
import type { Awaitable, Disposer, DurationLike } from "./common.js"
import type { IncomingEvent } from "./event.js"
import type { Logger } from "./logger.js"
import type { MediaRef } from "./media.js"
import type { SchemaDescriptor, SchemaEnumItem } from "./schema.js"
import type { RouteHandler, RouteOptions, ServerInfo, WebSocketHandler, WebSocketOptions } from "./server.js"
import type { KvNamespace } from "./store.js"

/* ────────────────────────────── 账号 ────────────────────────────── */

/** 持久化的账号记录 */
export interface AccountRecord {
  /**
   * 记录 id（内核生成的 uuid）
   *
   * 与平台 id 分开，因为同一个 QQ 号可能有两份不同配置（正向 WS 和 HTTP 各一份）。
   */
  id: string
  /** 提供该账号的适配器 id */
  adapterId: string
  /** 用户自定义备注 */
  label?: string
  /** 是否启用（禁用的账号不会尝试连接） */
  enabled: boolean
  /** 适配器自定义的账号配置，结构由 `AdapterProvider.accountSchema` 描述 */
  config: Record<string, unknown>
  /**
   * 这个账号自己的重连策略；缺省沿用全局配置 `adapter.*`
   *
   * **与 `config` 分开，因为拥有者不同。** `config` 里的字段由适配器的 `accountSchema`
   * 声明（「这个号的 WS 地址与 token 是什么」），内核不认识其中任何一个；重连是内核**替
   * 所有适配器统一做的事**（见 `AccountManager.#scheduleReconnect`），适配器根本不参与。
   * 塞进 `config` 就得要求每个适配器作者各自声明一遍这些字段，于是同一件事有 N 份声明、
   * N 套校验，且哪个适配器忘了写，它的账号就没有这个能力。
   *
   * 逐字段可缺，缺的那一项各自回落到全局值 —— 不是「填了就整套接管」：多数人只想给某个
   * 号单独设个上限，不该因此被迫把退避的三个数也抄一遍。
   */
  retry?: AccountRetryOverride
  /** 已知的平台账号 id，首次连接成功后回填 */
  selfId?: string
  /** 创建时间（毫秒） */
  createdAt: number
  /** 最后修改时间（毫秒） */
  updatedAt: number
}

/**
 * 单个账号对重连策略的覆盖
 *
 * 四项逐个可缺，缺的回落到全局配置 `adapter.*` 的同名项。**取「逐字段回落」而非「整套
 * 二选一」**：真实诉求多半是「这一个号连不上就别再试了」，而那不该迫使人把退避的三个数
 * 一并抄进来 —— 抄进来的那份此后不会跟着全局改动走，而没人记得自己抄过。
 *
 * 单位与全局配置一致：`interval` / `maxInterval` 收毫秒数或 `"2s"` 这类时长表达式。
 */
export interface AccountRetryOverride {
  /** 连续失败多少次后放弃；`0` 为一直重连 */
  limit?: number
  /** 首次重试前等多久 */
  interval?: DurationLike
  /** 退避的等待上限 */
  maxInterval?: DurationLike
  /** 退避倍率：每失败一次把等待乘上这个数，直到 `maxInterval` */
  factor?: number
}

/** 账号运行状态 */
export type AccountStatus = "disabled" | "offline" | "connecting" | "online" | "error"

/** 账号运行状态快照（WebUI 展示用） */
export interface AccountState {
  /** 账号记录 */
  record: AccountRecord
  /** 当前状态 */
  status: AccountStatus
  /** 最近一次错误信息 */
  error?: string
  /** 进入当前状态的时间（毫秒） */
  since: number
  /** 在线时取到的昵称 */
  nickname?: string
  /** 已重连次数 */
  retries: number
}

/* ────────────────────────────── 交互式登录 ────────────────────────────── */

/** 登录方式描述 */
export interface LoginModeDescriptor {
  /** 方式 id，传给 `login()` */
  id: string
  /** 展示名，如"扫码登录" */
  name: string
  /** 说明 */
  description?: string
}

/** 需要展示给用户的一步 */
export type LoginStep =
  | {
      /** 纯文字提示 */
      type: "info"
      /** 提示内容 */
      text: string
    }
  | {
      /** 二维码 */
      type: "qrcode"
      /** 二维码图片 */
      image: MediaRef
      /** 附加说明 */
      text?: string
    }
  | {
      /** 需要用户在浏览器打开的链接 */
      type: "url"
      /** 目标地址 */
      url: string
      /** 附加说明 */
      text?: string
    }
  | {
      /** 进度 */
      type: "progress"
      /** 0-100 */
      percent: number
      /** 当前阶段说明 */
      text?: string
    }

/** 需要用户输入的一项 */
export interface LoginPrompt {
  /** 输入类型 */
  type: "text" | "password" | "code" | "confirm" | "select"
  /** 标签 */
  label: string
  /** 说明 */
  description?: string
  /** type=select 时的候选项 */
  options?: SchemaEnumItem[]
  /** 等待超时，缺省 3 分钟 */
  timeout?: DurationLike
}

/**
 * 交互式登录会话
 *
 * 适配器只管"推一步、等一次输入"，WebUI 负责把它渲染成页面。
 * 扫码登录、短信验证码、填 token 三种流程用同一套原语表达，
 * 所以新增一个平台的登录方式不需要改前端。
 */
export interface LoginSession {
  /** 会话 id */
  readonly id: string
  /** 会话专用日志器 */
  readonly logger: Logger
  /** 用户取消或超时时触发 */
  readonly signal: AbortSignal

  /**
   * 向用户展示一步
   * @param step 步骤内容
   */
  push(step: LoginStep): void

  /**
   * 等待用户输入
   * @param prompt 输入项描述
   * @returns 用户输入的值（confirm 返回布尔，其余返回字符串）
   * @throws 超时或用户取消时抛出
   */
  ask<T = string>(prompt: LoginPrompt): Promise<T>
}

/* ────────────────────────────── 适配器 ────────────────────────────── */

/** 带并发去重的联系人缓存 */
export interface ContactCache<V> {
  /** 当前条目数 */
  readonly size: number

  /**
   * 取缓存
   * @param key 键
   * @returns 值，未命中或已过期时 undefined
   */
  get(key: string): V | undefined

  /**
   * 写缓存
   * @param key 键
   * @param value 值
   */
  set(key: string, value: V): void

  /**
   * 删除
   * @param key 键
   */
  delete(key: string): void

  /**
   * 取缓存，未命中时用 loader 拉取
   *
   * 同一个 key 的并发请求只会触发一次 loader（single-flight），
   * 避免一条群消息里多处判权限导致重复请求平台。
   * @param key 键
   * @param loader 拉取函数
   * @returns 值
   */
  fetch(key: string, loader: (key: string) => Promise<V | undefined>): Promise<V | undefined>

  /** 清空 */
  clear(): void
}

/** 联系人缓存参数 */
export interface ContactCacheOptions {
  /** 最多缓存多少条，超出按 LRU 淘汰 */
  max: number
  /**
   * 条目存活时长
   *
   * 省略或为 0 表示不过期，仅受 `max` 约束 —— 用于缓存自身不会失效的数据
   * （如预编译 SQL 语句）。联系人这类会变的数据必须给 ttl。
   */
  ttl?: DurationLike
}

/** 内核策略的只读视图 */
export interface PolicyView {
  /** 主人账号列表 */
  readonly masters: readonly string[]

  /**
   * 判断是否主人
   * @param uid 用户 id
   * @returns 是否主人
   */
  isMaster(uid: string): boolean
}

/**
 * 内核给适配器的宿主能力
 *
 * 适配器**只能**通过它接触外界：日志、存储、投递事件、挂路由。
 * 没有全局变量可用，所以卸载插件时内核能确定地把这些全部回收。
 */
export interface AdapterHost {
  /** 该账号专属日志器（已带 adapter/account 字段） */
  readonly logger: Logger
  /** 该账号专属 KV 命名空间 */
  readonly kv: KvNamespace
  /** 账号记录 */
  readonly account: AccountRecord
  /** 内核策略 */
  readonly policy: PolicyView
  /** 公共 HTTP 服务器信息，用于拼反向连接/webhook 地址 */
  readonly server: ServerInfo
  /** 账号被停用/插件被卸载时 abort */
  readonly signal: AbortSignal

  /**
   * 把平台事件投递进内核管线
   *
   * 同步返回，内核内部异步处理；适配器不必等待处理结果。
   * @param event 已翻译成通用模型的事件
   */
  submit(event: IncomingEvent): void

  /**
   * 注册 HTTP 路由（正向 HTTP 模式的回调端点）
   * @param method HTTP 方法
   * @param path 路径，会被挂到 `/adapter/<adapterId>` 之下
   * @param handler 处理函数
   * @param opts 选项
   * @returns 注销句柄
   */
  route(method: "GET" | "POST", path: string, handler: RouteHandler, opts?: RouteOptions): Disposer

  /**
   * 注册 WebSocket 路径（反向 WS 模式，等对端连过来）
   * @param path 路径，会被挂到 `/adapter/<adapterId>` 之下
   * @param handler 每个连接调用一次
   * @param opts 选项
   * @returns 注销句柄
   */
  websocket(path: string, handler: WebSocketHandler, opts?: WebSocketOptions): Disposer

  /**
   * 创建 LRU + TTL 联系人缓存
   *
   * 内核统一提供，适配器不要自己用裸 Map：常驻不淘汰的成员表在千人群上就是数百 MB。
   * @param opts 缓存参数
   * @returns 缓存实例，随账号一起被回收
   */
  createCache<V>(opts: ContactCacheOptions): ContactCache<V>

  /**
   * 注册清理回调，账号断开时按注册逆序执行
   * @param fn 清理函数
   */
  onDispose(fn: Disposer): void

  /**
   * 上报状态变化（连接中 / 在线 / 出错），WebUI 会实时反映
   * @param status 新状态
   * @param detail 附加信息（错误消息、昵称等）
   */
  setStatus(status: AccountStatus, detail?: { error?: string; nickname?: string }): void
}

/**
 * 账号驱动
 *
 * 一个账号一个实例。除 BotApi 的能力外，还要能连、能断，且断开后必须
 * 释放全部资源（socket、定时器、缓存）——内核会在卸载时调用 `disconnect()`
 * 并断言之后不再有事件投递进来。
 */
export interface BotDriver extends BotApi {
  /**
   * 建立连接
   * @throws 连接失败时抛出，内核据此进入退避重连
   */
  connect(): Promise<void>

  /** 断开并释放所有资源 */
  disconnect(): Promise<void>
}

/**
 * 适配器提供方
 *
 * 由插件通过 `ctx.registerAdapter()` 注册。这就是"账号登录也是插件"的接口：
 * 内核对 QQ 协议零认知，只负责存账号、按需创建驱动、把事件送进管线。
 */
export interface AdapterProvider<TAccount extends object = Record<string, unknown>> {
  /** 适配器 id，账号记录里引用它 */
  readonly id: string
  /** 展示名，如"NapCat (OneBot v11)" */
  readonly name: string
  /** 说明 */
  readonly description?: string
  /** 平台标识，会写进事件的 `platform` 字段 */
  readonly platform: string
  /** 账号配置表单描述，WebUI 据此渲染"添加账号"页面 */
  readonly accountSchema: SchemaDescriptor
  /** 支持的交互式登录方式；不支持交互式登录时留空 */
  readonly loginModes?: readonly LoginModeDescriptor[]

  /**
   * 校验并规范化账号配置
   * @param input WebUI 提交的原始对象
   * @returns 规范化后的配置
   * @throws 校验不通过时抛出，错误信息会展示给用户
   */
  validateAccount(input: unknown): TAccount

  /**
   * 为一个账号创建驱动
   * @param account 已校验的账号配置
   * @param host 内核提供的宿主能力
   * @returns 账号驱动（尚未连接）
   */
  createBot(account: TAccount, host: AdapterHost): Awaitable<BotDriver>

  /**
   * 交互式登录，产出可持久化的账号配置
   * @param session 登录会话
   * @param mode 用户选择的登录方式 id
   * @returns 可直接存进 `AccountRecord.config` 的配置
   */
  login?(session: LoginSession, mode: string): Promise<TAccount>
}

/** 适配器注册表的只读视图（WebUI / 诊断用） */
export interface AdapterRegistryView {
  /**
   * 列出已注册的适配器
   * @returns 适配器描述数组
   */
  list(): Array<Pick<AdapterProvider, "id" | "name" | "description" | "platform" | "accountSchema" | "loginModes">>

  /**
   * 按 id 取适配器
   * @param id 适配器 id
   * @returns 适配器，未注册时 undefined
   */
  get(id: string): AdapterProvider | undefined
}

/** Bot 注册表的只读视图 */
export interface BotRegistryView {
  /**
   * 按账号记录 id 取 Bot
   * @param accountId 账号记录 id
   * @returns Bot，未连接时 undefined
   */
  get(accountId: string): BotApi | undefined

  /**
   * 按平台 selfId 取 Bot
   * @param selfId 平台账号 id
   * @returns Bot，未连接时 undefined
   */
  bySelfId(selfId: string): BotApi | undefined

  /**
   * 列出所有在线 Bot
   * @returns Bot 数组
   */
  online(): BotApi[]

  /** 在线 Bot 数量 */
  readonly size: number
}

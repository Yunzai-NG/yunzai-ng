/**
 * 模块职责：统一事件模型（适配器产出的原始形态 + 内核补全后的运行时形态）
 * 依赖方向：依赖 bot / contact / segment / renderer / common
 * 生命周期：纯类型
 * 注意事项：刻意分成两种形态：`Incoming*` 只需适配器填平台真实有的字段，运行时形态
 *          由内核补齐（id / time / platform / bot / reply / render / isMaster…）。
 *          故写一个新适配器要做的只有「把平台报文翻译成 `IncomingEvent`」。
 *
 *          插件往事件上加字段走 `EventExtensions`（声明在本包入口，用法见那里）。
 */
import type { BotApi, SendOptions, SendResult } from "./bot.js"
import type { DurationLike } from "./common.js"
import type { ChannelInfo, GroupInfo, GroupRole, MemberInfo, QuoteInfo, SendTarget, UserInfo } from "./contact.js"
import type { EventExtensions } from "./index.js"
import type { RenderOptions, RenderablePage, RenderedImage } from "./renderer.js"
import type { ImageSegment, MessageContent, Segment } from "./segment.js"

/** 事件大类 */
export type EventKind = "message" | "notice" | "request" | "meta"

/** 消息场景 */
export type MessageScene = "private" | "group" | "guild"

/* ────────────────────────────── 适配器产出形态 ────────────────────────────── */

/** 适配器构造任何事件时都可以填的公共字段 */
interface IncomingBase {
  /** 事件 id；缺省由内核生成 */
  id?: string
  /** 发生时间（毫秒时间戳）；缺省取当前时间 */
  time?: number
  /** 平台原始报文，务必带上——排障几乎全靠它 */
  raw?: unknown
}

/** 适配器产出的消息事件 */
export interface IncomingMessageEvent extends IncomingBase {
  /** 事件大类 */
  kind: "message"
  /** 场景 */
  scene: MessageScene
  /** 平台细分类型，如 `"friend"` / `"normal"` / `"temp"` */
  subType?: string
  /** 平台消息 id */
  messageId: string
  /** 会话内序号，用于排序/去重 */
  seq?: number
  /** 消息段 */
  message: Segment[]
  /** 发送者；群消息应给 MemberInfo 以便判权限 */
  sender: UserInfo | MemberInfo
  /** 所在群 */
  group?: GroupInfo
  /** 所在子频道 */
  channel?: ChannelInfo
  /** 引用的消息 */
  quote?: QuoteInfo
}

/** 群成员增加 */
export interface GroupIncreaseNotice extends IncomingBase {
  /** 事件大类 */
  kind: "notice"
  /** 通知类型 */
  noticeType: "group.increase"
  /** 群 id */
  gid: string
  /** 新成员 id */
  uid: string
  /** 操作者（邀请人/审批人） */
  operatorId?: string
  /** 加入方式 */
  way?: "approve" | "invite" | "other"
}

/** 群成员减少 */
export interface GroupDecreaseNotice extends IncomingBase {
  /** 事件大类 */
  kind: "notice"
  /** 通知类型 */
  noticeType: "group.decrease"
  /** 群 id */
  gid: string
  /** 离开的成员 id */
  uid: string
  /** 操作者 */
  operatorId?: string
  /** 离开方式 */
  way?: "leave" | "kick" | "kickMe" | "other"
}

/** 群管理员变动 */
export interface GroupAdminNotice extends IncomingBase {
  /** 事件大类 */
  kind: "notice"
  /** 通知类型 */
  noticeType: "group.admin"
  /** 群 id */
  gid: string
  /** 目标成员 */
  uid: string
  /** 变动后的角色 */
  role: GroupRole
}

/** 群禁言 */
export interface GroupMuteNotice extends IncomingBase {
  /** 事件大类 */
  kind: "notice"
  /** 通知类型 */
  noticeType: "group.mute"
  /** 群 id */
  gid: string
  /** 被禁言成员；全体禁言时缺省 */
  uid?: string
  /** 操作者 */
  operatorId?: string
  /** 禁言时长（秒），0 表示解除 */
  duration: number
  /** 是否全体禁言 */
  whole?: boolean
}

/** 消息撤回 */
export interface RecallNotice extends IncomingBase {
  /** 事件大类 */
  kind: "notice"
  /** 通知类型 */
  noticeType: "message.recall"
  /** 群 id，私聊撤回时缺省 */
  gid?: string
  /** 消息发送者 */
  uid: string
  /** 操作者 */
  operatorId?: string
  /** 被撤回的消息 id */
  messageId: string
}

/** 戳一戳 */
export interface PokeNotice extends IncomingBase {
  /** 事件大类 */
  kind: "notice"
  /** 通知类型 */
  noticeType: "poke"
  /** 群 id，私聊戳时缺省 */
  gid?: string
  /** 发起者 */
  uid: string
  /** 被戳者 */
  targetId: string
}

/** 通用通知：通用模型没覆盖到的类型走这里，避免为每个平台特性改内核 */
export interface GenericNotice extends IncomingBase {
  /** 事件大类 */
  kind: "notice"
  /** 通知类型，形如 `"group.essence"` / `"friend.add"` */
  noticeType: string
  /** 群 id */
  gid?: string
  /** 相关用户 */
  uid?: string
  /** 结构化明细 */
  data?: Record<string, unknown>
}

/** 适配器产出的通知事件 */
export type IncomingNoticeEvent =
  | GroupIncreaseNotice
  | GroupDecreaseNotice
  | GroupAdminNotice
  | GroupMuteNotice
  | RecallNotice
  | PokeNotice
  | GenericNotice

/** 适配器产出的请求事件 */
export interface IncomingRequestEvent extends IncomingBase {
  /** 事件大类 */
  kind: "request"
  /** 请求类型 */
  requestType: "friend" | "group.add" | "group.invite"
  /** 申请人 */
  uid: string
  /** 目标群 */
  gid?: string
  /** 验证信息/邀请语 */
  comment?: string
  /** 平台用于同意/拒绝的标识 */
  flag: string
}

/** 适配器产出的元事件（连接生命周期、心跳） */
export interface IncomingMetaEvent extends IncomingBase {
  /** 事件大类 */
  kind: "meta"
  /** 元事件类型 */
  metaType: "connect" | "enable" | "disable" | "heartbeat" | "other"
  /** 附加数据，如心跳里的 status */
  data?: Record<string, unknown>
}

/** 适配器需要投递给内核的事件联合 */
export type IncomingEvent = IncomingMessageEvent | IncomingNoticeEvent | IncomingRequestEvent | IncomingMetaEvent

/* ────────────────────────────── 运行时形态 ────────────────────────────── */

/** 命令匹配结果 */
export interface CommandMatch {
  /** 命令声明时的名字 */
  name: string
  /** 实际命中的模式（字符串前缀本身，或正则的 source） */
  pattern: string
  /** 命中的触发词 */
  trigger: string
  /** 触发词之后剩余的文本，已 trim */
  rest: string
  /** 正则命名捕获组 */
  groups: Readonly<Record<string, string>>
  /** 正则数字捕获（下标 0 为整体匹配） */
  captures: readonly string[]
  /** 注册该命令的插件名 */
  plugin: string
}

/** 所有运行时事件共有的部分 */
export interface EventRuntimeBase {
  /** 事件唯一 id，贯穿日志便于串联一次处理的全过程 */
  readonly id: string
  /** 发生时间（毫秒时间戳） */
  readonly time: number
  /** 平台标识 */
  readonly platform: string
  /** 接收该事件的账号 id */
  readonly selfId: string
  /** 接收该事件的 Bot */
  readonly bot: BotApi
  /** 平台原始报文 */
  readonly raw: unknown

  /**
   * 本次事件的临时状态袋
   *
   * 供中间件向下游传值。键请带插件前缀（如 `"mhy:uid"`），避免撞名。
   * 事件处理结束即随事件一起被回收，不会泄漏。
   */
  readonly state: Record<string, unknown>

  /** 阻断后续中间件与命令匹配 */
  stop(): void
  /** 是否已被阻断 */
  readonly stopped: boolean
}

/** `e.reply` 的选项 */
export interface ReplyOptions extends Omit<SendOptions, "quote"> {
  /** 是否自动 @ 发送者（仅群聊生效） */
  at?: boolean
  /** 引用回复：`true` 引用当前消息，字符串则引用指定消息 id */
  quote?: boolean | string
}

/** `e.prompt` 的选项 */
export interface PromptOptions {
  /** 等待超时，缺省 60s */
  timeout?: DurationLike
  /** 是否只接受同一用户的消息，缺省 true */
  sameUser?: boolean
  /** 等待前发送的提示语 */
  tip?: MessageContent
  /** 额外过滤：返回 false 表示这条不算，继续等 */
  filter?: (e: MessageEvent) => boolean
}

/**
 * 运行时消息事件
 *
 * 插件的 `action(e)` 所接收的即为该类型。
 */
export interface MessageEvent extends EventRuntimeBase, EventExtensions {
  /** 事件大类 */
  readonly kind: "message"
  /** 场景 */
  readonly scene: MessageScene
  /** 平台细分类型 */
  readonly subType: string
  /** 平台消息 id */
  readonly messageId: string
  /** 会话内序号 */
  readonly seq?: number

  /** 消息段，中间件可改写；改写后需调用 `refresh()` 同步派生字段 */
  message: Segment[]
  /** 纯文本视图：拼接所有文本段并 trim，不含 at/图片 */
  text: string

  /** 发送者 */
  readonly sender: UserInfo | MemberInfo
  /** 所在群 */
  readonly group?: GroupInfo
  /** 所在子频道 */
  readonly channel?: ChannelInfo
  /** 引用的消息 */
  readonly quote?: QuoteInfo

  /** 是否 @ 了自己（含 @全体） */
  readonly atMe: boolean
  /** 被 @ 的用户 id 列表 */
  readonly atUsers: readonly string[]
  /** 消息中的图片段（含引用消息里的图，便于"识图"类指令） */
  readonly images: readonly ImageSegment[]

  /** 发送者是否主人 */
  readonly isMaster: boolean
  /** 发送者是否群管理（群主也算） */
  readonly isGroupAdmin: boolean
  /** 发送者是否群主 */
  readonly isGroupOwner: boolean
  /** 是否私聊 */
  readonly isPrivate: boolean
  /** 是否群聊 */
  readonly isGroup: boolean

  /** 回复该消息时应发往的目标 */
  readonly target: SendTarget

  /** 命令匹配结果；在 `command().action()` 内一定有值 */
  command?: CommandMatch

  /**
   * 回复
   * @param content 消息内容
   * @param opts 回复选项
   * @returns 发送结果
   */
  reply(content: MessageContent, opts?: ReplyOptions): Promise<SendResult>

  /**
   * 渲染 TSX 页面为图片段（不发送）
   *
   * 页面由 `@yunzai-ng/jsx` 的 `defineTemplate()` 产出，数据已在组件调用处完成类型检查。
   * @param page 已渲染好的页面
   * @param opts 渲染选项
   * @returns 图片段（分页时为数组）
   */
  render(page: RenderablePage, opts?: RenderOptions): Promise<RenderedImage>

  /**
   * 渲染字符串模板为图片段（不发送）
   * @param template 模板路径，相对本插件模板根
   * @param data 模板数据
   * @param opts 渲染选项
   * @returns 图片段（分页时为数组）
   */
  render(template: string, data?: Record<string, unknown>, opts?: RenderOptions): Promise<RenderedImage>

  /**
   * 渲染 TSX 页面并直接回复
   * @param page 已渲染好的页面
   * @param opts 渲染与回复选项
   * @returns 发送结果
   */
  renderReply(page: RenderablePage, opts?: RenderOptions & ReplyOptions): Promise<SendResult>

  /**
   * 渲染字符串模板并直接回复
   * @param template 模板路径
   * @param data 模板数据
   * @param opts 渲染与回复选项
   * @returns 发送结果
   */
  renderReply(
    template: string,
    data?: Record<string, unknown>,
    opts?: RenderOptions & ReplyOptions
  ): Promise<SendResult>

  /**
   * 撤回本条消息
   * @returns 是否成功
   */
  recall(): Promise<boolean>

  /**
   * 等待同一会话的下一条消息
   *
   * 等待句柄挂在插件的 disposer 上，卸载时以 `undefined` 结束（与超时同一条路径），
   * 故不会泄漏，插件也不必为此多写一个 catch。
   * @param opts 等待选项
   * @returns 下一条消息事件；超时或插件卸载时 undefined
   */
  prompt(opts?: PromptOptions): Promise<MessageEvent | undefined>

  /** 改写 `message` 后重算 `text`/`atMe`/`atUsers`/`images` */
  refresh(): void
}

/** 运行时通知事件 */
export type NoticeEvent = EventRuntimeBase &
  IncomingNoticeEvent & {
    /** 事件大类 */
    readonly kind: "notice"
    /**
     * 就地回复（群通知回群，私聊通知回私聊）
     * @param content 消息内容
     * @returns 发送结果
     */
    reply(content: MessageContent): Promise<SendResult>
  }

/** 运行时请求事件 */
export type RequestEvent = EventRuntimeBase &
  IncomingRequestEvent & {
    /** 事件大类 */
    readonly kind: "request"
    /**
     * 同意
     * @param extra 好友请求的备注 / 群请求忽略
     */
    approve(extra?: string): Promise<void>
    /**
     * 拒绝
     * @param reason 拒绝理由
     */
    reject(reason?: string): Promise<void>
  }

/** 运行时元事件 */
export type MetaEvent = EventRuntimeBase &
  IncomingMetaEvent & {
    /** 事件大类 */
    readonly kind: "meta"
  }

/** 任意运行时事件 */
export type AnyEvent = MessageEvent | NoticeEvent | RequestEvent | MetaEvent

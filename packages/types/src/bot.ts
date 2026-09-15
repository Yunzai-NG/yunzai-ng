/**
 * 模块职责：Bot 能力面（适配器实现，插件调用）
 * 依赖方向：依赖 contact / segment / media
 * 生命周期：纯类型
 * 注意事项：刻意区分「必须实现」与「可选实现」，可选能力由 `caps` 声明 —— 插件问一句
 *          「这个平台支持撤回吗」，而不是靠方法是否存在去试探。
 */
import type { GroupInfo, MemberInfo, QuoteInfo, SendTarget, UserInfo } from "./contact.js"
import type { ForwardNode, MessageContent, Segment } from "./segment.js"

/** 可选能力标记 */
export type BotCapability =
  | "recall"
  | "forward"
  | "poke"
  | "groupFile"
  | "groupCard"
  | "groupMute"
  | "groupKick"
  | "groupWholeMute"
  | "groupAdmin"
  | "groupName"
  | "groupSign"
  | "essence"
  | "reaction"
  | "friendRequest"
  | "groupRequest"
  | "markdown"
  | "keyboard"
  | "guild"
  | "fetchHistory"
  | "getFileUrl"

/** 发送结果 */
export interface SendResult {
  /** 是否成功送达平台 */
  ok: boolean
  /** 平台返回的消息 id；平台不返回时为空串 */
  messageId: string
  /** 发送时间（毫秒时间戳） */
  time: number
  /** 平台原始返回，排障用 */
  raw?: unknown
}

/** 一条历史消息 */
export interface MessageRecord {
  /** 消息 id */
  messageId: string
  /** 时间（毫秒） */
  time: number
  /** 发送者 */
  sender: UserInfo | MemberInfo
  /** 内容 */
  message: Segment[]
  /** 所在群，私聊时缺省 */
  group?: GroupInfo
}

/** 发送选项 */
export interface SendOptions {
  /** 引用回复的目标消息 id */
  quote?: string
  /** 若目标平台支持，多少毫秒后自动撤回 */
  recallAfter?: number
  /** 内容过长时是否自动转为合并转发 */
  autoForward?: boolean
  /** 覆盖默认的分片长度 */
  splitLength?: number
}

/** 拉取群成员列表的选项 */
export interface MemberListOptions {
  /** 是否绕过缓存强制拉取 */
  refresh?: boolean
  /** 最多返回多少条，缺省不限；用于避免千人群把内存打满 */
  limit?: number
}

/**
 * Bot 能力面
 *
 * 一个"账号"对应一个 BotApi 实例。所有方法都可能因网络原因 reject，
 * 调用方要么 catch 要么让它冒泡到管线的统一错误处理。
 */
export interface BotApi {
  /** 账号在平台上的 id */
  readonly selfId: string
  /** 平台标识，如 `"onebot11"` */
  readonly platform: string
  /** 提供该账号的适配器 id，如 `"napcat"` */
  readonly adapterId: string
  /** 账号昵称，未知时为空串 */
  readonly nickname: string
  /** 当前是否在线 */
  readonly online: boolean
  /** 本账号支持的可选能力 */
  readonly caps: ReadonlySet<BotCapability>

  /**
   * 发送消息
   * @param target 发送目标
   * @param content 消息内容，支持嵌套数组与裸字符串
   * @param opts 发送选项
   * @returns 发送结果
   */
  sendMessage(target: SendTarget, content: MessageContent, opts?: SendOptions): Promise<SendResult>

  /**
   * 撤回消息（需 `caps` 含 `recall`）
   * @param messageId 消息 id
   * @returns 是否撤回成功
   */
  recallMessage(messageId: string): Promise<boolean>

  /**
   * 取自身信息
   * @returns 当前账号信息
   */
  getSelfInfo(): Promise<UserInfo>

  /**
   * 取好友信息
   * @param uid 用户 id
   * @returns 好友信息，非好友时 undefined
   */
  getFriend(uid: string): Promise<UserInfo | undefined>

  /**
   * 取好友列表
   * @returns 好友数组
   */
  getFriendList(): Promise<UserInfo[]>

  /**
   * 取群信息
   * @param gid 群 id
   * @returns 群信息，未加入时 undefined
   */
  getGroup(gid: string): Promise<GroupInfo | undefined>

  /**
   * 取群列表
   * @returns 群数组
   */
  getGroupList(): Promise<GroupInfo[]>

  /**
   * 取单个群成员；实现应带缓存，这是最高频的查询（每条群消息都要判权限）
   * @param gid 群 id
   * @param uid 用户 id
   * @returns 成员信息，不在群内时 undefined
   */
  getGroupMember(gid: string, uid: string): Promise<MemberInfo | undefined>

  /**
   * 取群成员列表
   *
   * **昂贵操作**。千人群一次调用可能产生数 MB 的对象，内核绝不会在启动时调用它，
   * 插件也应当只在用户显式请求（如"群签到排行"）时才用。
   * @param gid 群 id
   * @param opts 拉取选项
   * @returns 成员数组
   */
  getGroupMemberList(gid: string, opts?: MemberListOptions): Promise<MemberInfo[]>

  /**
   * 发送合并转发（需 `caps` 含 `forward`）
   * @param target 发送目标
   * @param nodes 转发节点
   * @returns 发送结果
   */
  sendForward?(target: SendTarget, nodes: ForwardNode[]): Promise<SendResult>

  /**
   * 修改群名片（需 `caps` 含 `groupCard`）
   * @param gid 群 id
   * @param uid 用户 id
   * @param card 新名片，空串表示清除
   */
  setGroupCard?(gid: string, uid: string, card: string): Promise<void>

  /**
   * 禁言群成员（需 `caps` 含 `groupMute`）
   * @param gid 群 id
   * @param uid 用户 id
   * @param seconds 禁言秒数，0 表示解除
   */
  muteGroupMember?(gid: string, uid: string, seconds: number): Promise<void>

  /**
   * 全体禁言（需 `caps` 含 `groupWholeMute`）
   * @param gid 群 id
   * @param enable 是否开启
   */
  muteGroupAll?(gid: string, enable: boolean): Promise<void>

  /**
   * 踢出群成员（需 `caps` 含 `groupKick`）
   * @param gid 群 id
   * @param uid 用户 id
   * @param rejectAddAgain 是否拒绝再次加群
   */
  kickGroupMember?(gid: string, uid: string, rejectAddAgain?: boolean): Promise<void>

  /**
   * 退群
   * @param gid 群 id
   */
  quitGroup?(gid: string): Promise<void>

  /**
   * 处理加好友请求（需 `caps` 含 `friendRequest`）
   * @param flag 请求标识
   * @param approve 是否同意
   * @param remark 同意时设置的备注
   */
  handleFriendRequest?(flag: string, approve: boolean, remark?: string): Promise<void>

  /**
   * 处理加群请求（需 `caps` 含 `groupRequest`）
   * @param flag 请求标识
   * @param approve 是否同意
   * @param reason 拒绝理由
   */
  handleGroupRequest?(flag: string, approve: boolean, reason?: string): Promise<void>

  /**
   * 拉取历史消息（需 `caps` 含 `fetchHistory`）
   * @param target 会话目标
   * @param count 条数
   * @param before 从该消息 id 之前开始
   * @returns 历史消息，按时间升序
   */
  fetchHistory?(target: SendTarget, count: number, before?: string): Promise<MessageRecord[]>

  /**
   * 取单条消息（用于补全引用内容）
   * @param messageId 消息 id
   * @returns 消息记录，取不到时 undefined
   */
  getMessage?(messageId: string): Promise<MessageRecord | undefined>

  /**
   * 上传群文件（需 `caps` 含 `groupFile`）
   * @param gid 群 id
   * @param file 本地文件绝对路径
   * @param name 展示文件名
   * @param folder 目标文件夹 id
   */
  uploadGroupFile?(gid: string, file: string, name: string, folder?: string): Promise<void>

  /**
   * 贴表情回应（需 `caps` 含 `reaction`）
   * @param messageId 消息 id
   * @param emojiId 表情 id
   * @param add true 为添加，false 为取消
   */
  setReaction?(messageId: string, emojiId: string, add?: boolean): Promise<void>

  /**
   * 直接调用平台原生 API
   *
   * 兼容出口：通用能力面未覆盖的平台特有能力经由本入口调用。
   * 用它意味着代码绑定了具体平台，插件应先判断 `platform`。
   * @param action 平台 API 名，如 OneBot 的 `set_group_sign`
   * @param params 参数对象
   * @returns 平台返回的数据
   */
  callApi<T = unknown>(action: string, params?: Record<string, unknown>): Promise<T>
}

/** 引用信息补全器：内核在需要时用它把 quote 的正文填上 */
export type QuoteResolver = (bot: BotApi, quote: QuoteInfo) => Promise<QuoteInfo>

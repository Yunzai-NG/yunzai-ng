/**
 * 模块职责：用户 / 群 / 成员等联系人信息
 * 依赖方向：仅依赖 segment.ts（`QuoteInfo.message` 需要）
 * 生命周期：纯类型
 * 注意事项：除 id 外一律可选 —— 适配器只填手头已有的，缺的字段由使用方按需再查。
 *          全量预拉一遍成员表在千人群上是数百 MB 的常驻内存。
 */
import type { Segment } from "./segment.js"

/** 用户基础信息 */
export interface UserInfo {
  /** 平台内唯一用户 id（QQ 号 / openid） */
  uid: string
  /** 昵称 */
  name?: string
  /** 头像地址 */
  avatar?: string
  /** 好友备注 */
  remark?: string
}

/** 群成员角色 */
export type GroupRole = "owner" | "admin" | "member"

/** 群成员信息 */
export interface MemberInfo extends UserInfo {
  /** 所属群 id */
  gid: string
  /** 群名片 */
  card?: string
  /** 权限角色 */
  role: GroupRole
  /** 专属头衔 */
  title?: string
  /** 入群时间（秒级） */
  joinTime?: number
  /** 最后发言时间（秒级） */
  lastSentTime?: number
  /** 禁言到期时间（秒级），0 或缺省表示未禁言 */
  shutUpTime?: number
}

/** 群信息 */
export interface GroupInfo {
  /** 群 id */
  gid: string
  /** 群名 */
  name?: string
  /** 群头像 */
  avatar?: string
  /** 当前人数 */
  memberCount?: number
  /** 人数上限 */
  maxMemberCount?: number
  /** 群主 id */
  owner?: string
  /** 机器人在本群的角色 */
  selfRole?: GroupRole
}

/** 频道（Guild）信息，为将来接入 QQ 频道 / Discord 预留 */
export interface ChannelInfo {
  /** 频道 id */
  channelId: string
  /** 所属 guild id */
  guildId: string
  /** 频道名 */
  name?: string
  /** 频道类型 */
  kind?: "text" | "voice" | "category" | "other"
}

/** 被引用消息的摘要 */
export interface QuoteInfo {
  /** 被引用消息 id */
  messageId: string
  /** 原发送者 */
  sender?: UserInfo
  /** 原消息内容摘要（部分平台不返回） */
  text?: string
  /**
   * 原消息的消息段（部分平台不返回）
   *
   * 具备该字段，`e.images` 才能将"被引用的图片"计入 —— 这是"识图"类指令的
   * 唯一数据来源。平台若需额外一次请求方可取得（OneBot 的 `get_msg`），
   * 适配器应当留空，由内核在插件确实需要时经 `QuoteResolver` 补全，
   * 而非为每条带引用的消息额外调用一次 API。
   */
  message?: Segment[]
  /** 原发送时间（毫秒） */
  time?: number
}

/** 发送目标 */
export type SendTarget =
  | {
      /** 私聊 */
      scene: "private"
      /** 对方用户 id */
      uid: string
      /** 群临时会话时的来源群 id */
      gid?: string
    }
  | {
      /** 群聊 */
      scene: "group"
      /** 群 id */
      gid: string
    }
  | {
      /** 频道 */
      scene: "guild"
      /** guild id */
      guildId: string
      /** 子频道 id */
      channelId: string
    }

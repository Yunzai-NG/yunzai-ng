/**
 * 模块职责：与平台无关的消息段模型
 * 依赖方向：仅依赖 media.ts
 * 生命周期：纯类型
 * 注意事项：`RawSegment` 是有意保留的兼容出口 —— 宁可由适配器传一个 raw 段，也不为某个
 *          平台的私有消息类型往本联合类型里加通用字段，那是平台细节渗入内核的入口。
 */
import type { MediaRef } from "./media.js"

/** 纯文本 */
export interface TextSegment {
  /** 段类型 */
  type: "text"
  /** 文本内容 */
  text: string
}

/** 图片 */
export interface ImageSegment {
  /** 段类型 */
  type: "image"
  /** 图片来源 */
  file: MediaRef
  /** 无障碍摘要/外显文本 */
  summary?: string
  /** 平台子类型（QQ：0 普通图、1 表情图等） */
  subType?: number
  /** 已知宽度，便于下游排版 */
  width?: number
  /** 已知高度 */
  height?: number
}

/** @ 某人 */
export interface AtSegment {
  /** 段类型 */
  type: "at"
  /** 被 @ 的用户 id */
  uid: string
  /** 展示名，仅用于回显，匹配时不要依赖 */
  name?: string
}

/** @ 全体成员 */
export interface AtAllSegment {
  /** 段类型 */
  type: "atAll"
}

/** QQ 原生表情 */
export interface FaceSegment {
  /** 段类型 */
  type: "face"
  /** 表情 id */
  id: number
  /** 是否超级表情 */
  big?: boolean
}

/** 回复引用 */
export interface ReplySegment {
  /** 段类型 */
  type: "reply"
  /** 被引用的消息 id */
  messageId: string
}

/** 语音 */
export interface RecordSegment {
  /** 段类型 */
  type: "record"
  /** 音频来源 */
  file: MediaRef
  /** 时长（秒） */
  duration?: number
  /** 是否变声 */
  magic?: boolean
}

/** 短视频 */
export interface VideoSegment {
  /** 段类型 */
  type: "video"
  /** 视频来源 */
  file: MediaRef
  /** 封面 */
  thumb?: MediaRef
}

/** 文件 */
export interface FileSegment {
  /** 段类型 */
  type: "file"
  /** 文件来源 */
  file: MediaRef
  /** 文件名 */
  name?: string
  /** 字节数 */
  size?: number
}

/** 位置 */
export interface LocationSegment {
  /** 段类型 */
  type: "location"
  /** 纬度 */
  lat: number
  /** 经度 */
  lon: number
  /** 标题 */
  title?: string
  /** 描述 */
  content?: string
}

/** 链接分享 */
export interface ShareSegment {
  /** 段类型 */
  type: "share"
  /** 目标地址 */
  url: string
  /** 标题 */
  title: string
  /** 摘要 */
  content?: string
  /** 缩略图地址 */
  image?: string
}

/** 推荐好友/群 */
export interface ContactSegment {
  /** 段类型 */
  type: "contact"
  /** 推荐对象类别 */
  scene: "user" | "group"
  /** 对象 id */
  id: string
}

/** JSON 卡片 */
export interface JsonSegment {
  /** 段类型 */
  type: "json"
  /** 序列化后的卡片数据 */
  data: string
}

/** XML 卡片 */
export interface XmlSegment {
  /** 段类型 */
  type: "xml"
  /** 卡片 XML */
  data: string
}

/** 戳一戳 */
export interface PokeSegment {
  /** 段类型 */
  type: "poke"
  /** 目标用户，群聊内必填 */
  uid?: string
  /** 戳的类型 */
  pokeType?: number
}

/** 骰子 */
export interface DiceSegment {
  /** 段类型 */
  type: "dice"
  /** 点数，发送时留空由平台随机 */
  result?: number
}

/** 猜拳 */
export interface RpsSegment {
  /** 段类型 */
  type: "rps"
  /** 结果，发送时留空由平台随机 */
  result?: number
}

/** 音乐分享 */
export interface MusicSegment {
  /** 段类型 */
  type: "music"
  /** 音乐平台；custom 表示自定义卡片 */
  platform: "qq" | "163" | "kugou" | "kuwo" | "migu" | "custom"
  /** 平台歌曲 id（非 custom 时必填） */
  id?: string
  /** custom：跳转地址 */
  url?: string
  /** custom：音频直链 */
  audio?: string
  /** custom：标题 */
  title?: string
  /** custom：作者 */
  singer?: string
  /** custom：封面 */
  image?: string
}

/** 合并转发中的一条 */
export interface ForwardNode {
  /** 显示的发送者 id */
  uid?: string
  /** 显示的发送者昵称 */
  name?: string
  /** 显示时间（秒级时间戳） */
  time?: number
  /** 该条的内容；与 messageId 二选一 */
  message?: Segment[]
  /** 直接引用一条已存在的消息 */
  messageId?: string
}

/** 合并转发 */
export interface ForwardSegment {
  /** 段类型 */
  type: "forward"
  /** 已存在的转发资源 id（接收时常见） */
  id?: string
  /** 待发送的节点列表 */
  nodes?: ForwardNode[]
  /** 外显：来源标题 */
  source?: string
  /** 外显：摘要行 */
  summary?: string
  /** 外显：预览行 */
  prompt?: string
}

/** Markdown（QQ 官方 Bot / 部分平台支持） */
export interface MarkdownSegment {
  /** 段类型 */
  type: "markdown"
  /** Markdown 正文 */
  content: string
}

/** 按钮 */
export interface KeyboardButton {
  /** 按钮 id */
  id?: string
  /** 按钮文本 */
  label: string
  /** 点击后展示的文本 */
  visitedLabel?: string
  /** 按钮行为：回填指令 / 跳链接 / 回调 */
  action: "input" | "link" | "callback"
  /** input 时回填的指令、link 时的地址、callback 时的数据 */
  data?: string
  /** 是否直接发送回填的指令 */
  enter?: boolean
}

/** 按钮键盘 */
export interface KeyboardSegment {
  /** 段类型 */
  type: "keyboard"
  /** 按行组织的按钮 */
  rows: KeyboardButton[][]
}

/** 平台私有段的兼容出口：内核只保证原样透传回同一平台，插件按 `platform` + `platformType` 自行处理 */
export interface RawSegment {
  /** 段类型 */
  type: "raw"
  /** 来源平台 */
  platform: string
  /** 平台侧的原始段类型名 */
  platformType: string
  /** 原始数据 */
  data: unknown
}

/** 全部消息段的联合类型 */
export type Segment =
  | TextSegment
  | ImageSegment
  | AtSegment
  | AtAllSegment
  | FaceSegment
  | ReplySegment
  | RecordSegment
  | VideoSegment
  | FileSegment
  | LocationSegment
  | ShareSegment
  | ContactSegment
  | JsonSegment
  | XmlSegment
  | PokeSegment
  | DiceSegment
  | RpsSegment
  | MusicSegment
  | ForwardSegment
  | MarkdownSegment
  | KeyboardSegment
  | RawSegment

/** 消息段类型名 */
export type SegmentType = Segment["type"]

/**
 * 按类型取出对应的段接口
 *
 * 判别条件必须写作 `Record<"type", T>` 而非 `{ type: T }`：后者是内联属性签名，
 * 会被 `jsdoc/require-jsdoc` 要求补注释，`--fix` 之后这一行会被拆成四行。两者对
 * `Extract` 等价，不要"简化"回去。
 */
export type SegmentOf<T extends SegmentType> = Extract<Segment, Record<"type", T>>

/** 可作为消息内容的单项；`null`/`undefined`/`false` 会被内核过滤，便于条件拼装 */
export type MessageContentItem = string | number | Segment | null | undefined | false

/**
 * 消息内容的宽松输入：任意层嵌套数组，`toSegments()` 展平并把裸字符串/数字转成文本段
 */
export type MessageContent = MessageContentItem | readonly MessageContent[]

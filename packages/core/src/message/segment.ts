/**
 * 模块职责：消息段构造器（`seg.*`）、消息内容归一化、媒体引用归一化
 * 依赖方向：仅依赖类型包与 util/text；不依赖任何子系统
 * 生命周期：纯函数，无状态
 * 注意事项：三条约定 ——
 *          1) 媒体不默认转 base64：`toMediaRef` 保留来源种类，由适配器按
 *             `id > url > path > buffer > base64` 选开销最低的通道
 *          2) 相邻文本段合并：原样产出多段会被平台视为多条内容拼接，部分平台还按段计费
 *          3) `null` / `undefined` / `false` 丢弃，故可写 `[e.isGroup && seg.at(uid), "x"]`；
 *             `0` 是有意义的文本，只有空串才丢
 */
import { fileURLToPath } from "node:url"
import { isAbsolute } from "node:path"
import type {
  AtAllSegment,
  AtSegment,
  ContactSegment,
  DiceSegment,
  FaceSegment,
  FileSegment,
  ForwardNode,
  ForwardSegment,
  ImageSegment,
  JsonSegment,
  KeyboardButton,
  KeyboardSegment,
  LocationSegment,
  MarkdownSegment,
  MediaInput,
  MediaRef,
  MessageContent,
  MusicSegment,
  PokeSegment,
  RawSegment,
  RecordSegment,
  ReplySegment,
  RpsSegment,
  Segment,
  SegmentType,
  ShareSegment,
  TextSegment,
  VideoSegment,
  XmlSegment
} from "@yunzai-ng/types"
import { truncate } from "../util/text.js"

/** `data:` URI 的头部形式 */
const DATA_URI_RE = /^data:([^;,]*)(;charset=[^;,]*)?;base64,(.*)$/s

/** 日志里描述消息时，文本段最多展示多少字 */
const DESCRIBE_TEXT_MAX = 40

/**
 * 判断是否已经是归一化后的媒体引用
 * @param value 任意值
 * @returns 是否为 MediaRef
 */
function isMediaRef(value: unknown): value is MediaRef {
  if (typeof value !== "object" || value === null) return false
  const kind = (value as { kind?: unknown }).kind
  return kind === "url" || kind === "path" || kind === "buffer" || kind === "base64" || kind === "id"
}

/**
 * 把宽松的媒体输入归一化成 `MediaRef`
 *
 * 识别顺序：已归一化对象 → 字节 → URL 对象 → 字符串前缀。字符串规则：
 * - `http://` / `https://` → `url`
 * - `file://` → `path`（经 `fileURLToPath`，正确处理 Windows 盘符与转义）
 * - `base64://` / `data:*;base64,` → `base64`
 * - 绝对路径 → `path`
 *
 * 相对路径**不予接受**：内核无法确定其解析基准（插件根目录、工作目录，或渲染产物目录），
 * 判定错误的表现为"图片无法发出但未产生报错"。插件应使用 `ctx.resource()` 拼接绝对路径。
 * @param input 媒体输入
 * @returns 归一化后的媒体引用
 * @throws 传入相对路径或空串时
 */
export function toMediaRef(input: MediaInput): MediaRef {
  if (isMediaRef(input)) return input

  if (input instanceof Uint8Array) return { kind: "buffer", data: input }
  if (input instanceof ArrayBuffer) return { kind: "buffer", data: new Uint8Array(input) }

  if (input instanceof URL) {
    if (input.protocol === "file:") return { kind: "path", path: fileURLToPath(input) }
    return { kind: "url", url: input.href }
  }

  const text: string = input
  if (text === "") throw new Error("媒体引用不能为空串")

  if (text.startsWith("http://") || text.startsWith("https://")) return { kind: "url", url: text }
  if (text.startsWith("file://")) return { kind: "path", path: fileURLToPath(text) }
  if (text.startsWith("base64://")) return { kind: "base64", base64: text.slice("base64://".length) }

  const dataUri = DATA_URI_RE.exec(text)
  if (dataUri) {
    const mime = dataUri[1]
    return mime ? { kind: "base64", base64: dataUri[3] ?? "", mime } : { kind: "base64", base64: dataUri[3] ?? "" }
  }

  if (isAbsolute(text)) return { kind: "path", path: text }

  throw new Error(
    `无法识别的媒体引用 ${truncate(text, 60)}：请传入 http(s) 链接、绝对路径、Buffer 或 base64:// 开头的字符串。` +
      `若是插件内的文件，请用 ctx.resource("...") 取绝对路径`
  )
}

/**
 * 给媒体引用生成一句简短描述（日志用，绝不打印正文）
 *
 * base64 与 buffer 只打长度：把 2MB 的 base64 写进日志文件既没用又会把
 * 日志轮转打满，而 CK/token 若混在其中还会泄露。
 * @param ref 媒体引用
 * @returns 描述文本
 */
export function describeMedia(ref: MediaRef): string {
  switch (ref.kind) {
    case "url":
      return truncate(ref.url, 60)
    case "path":
      return ref.path
    case "buffer":
      return `${ref.data.byteLength} 字节`
    case "base64":
      return `base64 ${ref.base64.length} 字符`
    case "id":
      return `id:${ref.id}`
  }
}

/**
 * 消息段构造器
 *
 * 挂在导出对象上而非做成全局：全局构造器会让每个文件都成为潜在的消息构造点，
 * 热重载时无从判断谁还在引用。
 */
export const seg = {
  /**
   * 纯文本
   * @param text 文本内容（数字会被转成字符串）
   * @returns 文本段
   */
  text(text: string | number): TextSegment {
    return { type: "text", text: String(text) }
  },

  /**
   * 图片
   * @param file 图片来源（链接 / 绝对路径 / Buffer / base64）
   * @param opts 附加信息
   * @returns 图片段
   */
  image(file: MediaInput, opts: Omit<ImageSegment, "type" | "file"> = {}): ImageSegment {
    return { type: "image", file: toMediaRef(file), ...opts }
  },

  /**
   * @ 某人
   * @param uid 用户 id
   * @param name 展示名（仅回显用）
   * @returns at 段
   */
  at(uid: string, name?: string): AtSegment {
    return name === undefined ? { type: "at", uid } : { type: "at", uid, name }
  },

  /**
   * @ 全体成员
   * @returns atAll 段
   */
  atAll(): AtAllSegment {
    return { type: "atAll" }
  },

  /**
   * QQ 原生表情
   * @param id 表情 id
   * @param big 是否超级表情
   * @returns 表情段
   */
  face(id: number, big?: boolean): FaceSegment {
    return big === undefined ? { type: "face", id } : { type: "face", id, big }
  },

  /**
   * 引用回复
   * @param messageId 被引用的消息 id
   * @returns 回复段
   */
  reply(messageId: string): ReplySegment {
    return { type: "reply", messageId }
  },

  /**
   * 语音
   * @param file 音频来源
   * @param opts 附加信息
   * @returns 语音段
   */
  record(file: MediaInput, opts: Omit<RecordSegment, "type" | "file"> = {}): RecordSegment {
    return { type: "record", file: toMediaRef(file), ...opts }
  },

  /**
   * 短视频
   * @param file 视频来源
   * @param thumb 封面
   * @returns 视频段
   */
  video(file: MediaInput, thumb?: MediaInput): VideoSegment {
    return thumb === undefined
      ? { type: "video", file: toMediaRef(file) }
      : { type: "video", file: toMediaRef(file), thumb: toMediaRef(thumb) }
  },

  /**
   * 文件
   * @param file 文件来源
   * @param opts 附加信息
   * @returns 文件段
   */
  file(file: MediaInput, opts: Omit<FileSegment, "type" | "file"> = {}): FileSegment {
    return { type: "file", file: toMediaRef(file), ...opts }
  },

  /**
   * 位置
   * @param lat 纬度
   * @param lon 经度
   * @param opts 标题与描述
   * @returns 位置段
   */
  location(lat: number, lon: number, opts: Omit<LocationSegment, "type" | "lat" | "lon"> = {}): LocationSegment {
    return { type: "location", lat, lon, ...opts }
  },

  /**
   * 链接分享
   * @param url 目标地址
   * @param title 标题
   * @param opts 摘要与缩略图
   * @returns 分享段
   */
  share(url: string, title: string, opts: Omit<ShareSegment, "type" | "url" | "title"> = {}): ShareSegment {
    return { type: "share", url, title, ...opts }
  },

  /**
   * 推荐好友/群
   * @param scene 对象类别
   * @param id 对象 id
   * @returns 推荐段
   */
  contact(scene: "user" | "group", id: string): ContactSegment {
    return { type: "contact", scene, id }
  },

  /**
   * JSON 卡片
   * @param data 卡片数据；传对象时自动序列化
   * @returns JSON 段
   */
  json(data: string | object): JsonSegment {
    return { type: "json", data: typeof data === "string" ? data : JSON.stringify(data) }
  },

  /**
   * XML 卡片
   * @param data 卡片 XML
   * @returns XML 段
   */
  xml(data: string): XmlSegment {
    return { type: "xml", data }
  },

  /**
   * 戳一戳
   * @param uid 目标用户（群聊内必填）
   * @param pokeType 戳的类型
   * @returns 戳一戳段
   */
  poke(uid?: string, pokeType?: number): PokeSegment {
    const out: PokeSegment = { type: "poke" }
    if (uid !== undefined) out.uid = uid
    if (pokeType !== undefined) out.pokeType = pokeType
    return out
  },

  /**
   * 骰子
   * @param result 点数，留空由平台随机
   * @returns 骰子段
   */
  dice(result?: number): DiceSegment {
    return result === undefined ? { type: "dice" } : { type: "dice", result }
  },

  /**
   * 猜拳
   * @param result 结果，留空由平台随机
   * @returns 猜拳段
   */
  rps(result?: number): RpsSegment {
    return result === undefined ? { type: "rps" } : { type: "rps", result }
  },

  /**
   * 平台歌曲分享
   * @param platform 音乐平台
   * @param id 平台歌曲 id
   * @returns 音乐段
   */
  music(platform: Exclude<MusicSegment["platform"], "custom">, id: string): MusicSegment {
    return { type: "music", platform, id }
  },

  /**
   * 自定义音乐卡片
   * @param opts 卡片字段
   * @returns 音乐段
   */
  musicCustom(opts: Omit<MusicSegment, "type" | "platform" | "id">): MusicSegment {
    return { type: "music", platform: "custom", ...opts }
  },

  /**
   * 合并转发
   * @param nodes 转发节点
   * @param opts 外显字段
   * @returns 合并转发段
   */
  forward(nodes: ForwardNode[], opts: Omit<ForwardSegment, "type" | "nodes" | "id"> = {}): ForwardSegment {
    return { type: "forward", nodes, ...opts }
  },

  /**
   * 合并转发中的一条
   * @param message 该条内容（支持宽松形式）
   * @param opts 显示用的发送者信息
   * @returns 转发节点
   */
  node(message: MessageContent, opts: Omit<ForwardNode, "message" | "messageId"> = {}): ForwardNode {
    return { message: toSegments(message), ...opts }
  },

  /**
   * Markdown
   * @param content 正文
   * @returns Markdown 段
   */
  markdown(content: string): MarkdownSegment {
    return { type: "markdown", content }
  },

  /**
   * 按钮键盘
   * @param rows 按行组织的按钮
   * @returns 键盘段
   */
  keyboard(rows: KeyboardButton[][]): KeyboardSegment {
    return { type: "keyboard", rows }
  },

  /**
   * 平台私有段（兼容出口）
   * @param platform 来源平台
   * @param platformType 平台侧段类型名
   * @param data 原始数据
   * @returns raw 段
   */
  raw(platform: string, platformType: string, data: unknown): RawSegment {
    return { type: "raw", platform, platformType, data }
  }
}

/**
 * 判断一个值是否为消息段
 * @param value 任意值
 * @returns 是否为 Segment
 */
export function isSegment(value: unknown): value is Segment {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string"
}

/**
 * 把宽松的消息内容归一化成消息段数组
 *
 * 展平任意层嵌套数组、把裸字符串/数字转成文本段、丢掉 `null`/`undefined`/`false`
 * 与空文本，并合并相邻文本段（见文件头第 2、3 条）。
 * @param content 消息内容
 * @returns 消息段数组；内容为空时返回空数组
 */
export function toSegments(content: MessageContent): Segment[] {
  const out: Segment[] = []
  collect(content, out)
  return out
}

/**
 * 递归展平并写入结果数组
 * @param content 消息内容
 * @param out 结果数组（就地追加）
 */
function collect(content: MessageContent, out: Segment[]): void {
  if (content === null || content === undefined || content === false) return

  if (Array.isArray(content)) {
    for (const item of content) collect(item, out)
    return
  }

  if (typeof content === "string" || typeof content === "number") {
    pushText(out, String(content))
    return
  }

  if (isSegment(content)) {
    if (content.type === "text") pushText(out, content.text)
    else out.push(content)
    return
  }
}

/**
 * 追加文本，与前一个文本段合并
 * @param out 结果数组
 * @param text 文本
 */
function pushText(out: Segment[], text: string): void {
  if (text === "") return
  const last = out[out.length - 1]
  if (last && last.type === "text") last.text += text
  else out.push({ type: "text", text })
}

/**
 * 取消息的纯文本视图
 * @param segments 消息段
 * @returns 拼接后 trim 的文本；无文本段时为空串
 */
export function textOf(segments: readonly Segment[]): string {
  let out = ""
  for (const s of segments) {
    if (s.type === "text") out += s.text
  }
  return out.trim()
}

/**
 * 取消息里的全部图片段
 * @param segments 消息段
 * @returns 图片段数组
 */
export function imagesOf(segments: readonly Segment[]): ImageSegment[] {
  return segments.filter((s): s is ImageSegment => s.type === "image")
}

/**
 * 取消息里被 @ 的用户 id
 * @param segments 消息段
 * @returns 用户 id 数组，已去重且保持出现顺序
 */
export function atUsersOf(segments: readonly Segment[]): string[] {
  const seen = new Set<string>()
  for (const s of segments) {
    if (s.type === "at" && s.uid !== "") seen.add(s.uid)
  }
  return [...seen]
}

/**
 * 判断消息里是否有 @全体成员
 * @param segments 消息段
 * @returns 是否含 atAll
 */
export function hasAtAll(segments: readonly Segment[]): boolean {
  return segments.some(s => s.type === "atAll")
}

/**
 * 取消息里第一个 reply 段指向的消息 id
 * @param segments 消息段
 * @returns 消息 id；没有 reply 段时 undefined
 */
export function quotedIdOf(segments: readonly Segment[]): string | undefined {
  for (const s of segments) {
    if (s.type === "reply") return s.messageId
  }
  return undefined
}

/**
 * 统计各类型段的数量
 * @param segments 消息段
 * @returns 类型到数量的映射
 */
export function countByType(segments: readonly Segment[]): Partial<Record<SegmentType, number>> {
  const out: Partial<Record<SegmentType, number>> = {}
  for (const s of segments) out[s.type] = (out[s.type] ?? 0) + 1
  return out
}

/**
 * 将消息渲染成一行日志文本
 *
 * 媒体只出摘要不出正文，见 `describeMedia`。
 * @param segments 消息段
 * @returns 单行描述
 */
export function describeMessage(segments: readonly Segment[]): string {
  const parts: string[] = []
  for (const s of segments) {
    switch (s.type) {
      case "text":
        parts.push(truncate(s.text.replace(/\s+/g, " "), DESCRIBE_TEXT_MAX))
        break
      case "image":
        parts.push(`[图片 ${describeMedia(s.file)}]`)
        break
      case "at":
        parts.push(`[@${s.name ?? s.uid}]`)
        break
      case "atAll":
        parts.push("[@全体]")
        break
      case "face":
        parts.push(`[表情${s.id}]`)
        break
      case "reply":
        parts.push(`[回复${s.messageId}]`)
        break
      case "record":
        parts.push("[语音]")
        break
      case "video":
        parts.push("[视频]")
        break
      case "file":
        parts.push(`[文件 ${s.name ?? ""}]`)
        break
      case "forward":
        parts.push(`[合并转发 ${s.nodes?.length ?? s.id ?? ""}]`)
        break
      case "json":
      case "xml":
        parts.push("[卡片]")
        break
      case "markdown":
        parts.push("[Markdown]")
        break
      case "keyboard":
        parts.push("[按钮]")
        break
      case "raw":
        parts.push(`[${s.platform}:${s.platformType}]`)
        break
      default:
        parts.push(`[${s.type}]`)
    }
  }
  return parts.join("")
}

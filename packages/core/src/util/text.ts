/**
 * 模块职责：文本处理（正则转义、宽度对齐、截断、脱敏、长文本切分）
 * 依赖方向：无
 * 生命周期：纯函数
 * 注意事项：`visualWidth` 按东亚全角字符计 2 列宽 —— 日志表格中混排中英文时，
 *          以 `String.length` 对齐将出现偏移。
 *
 *          `maskSecret` 并非装饰：CK、token、Cookie 一旦写入日志文件，使用者发送
 *          日志求助即等同于公开账号凭据。配置项标注 `secret` 者必须经由它处理。
 */

/**
 * ANSI 转义序列（用于清理日志文本）
 *
 * `no-control-regex` 是为"误将控制字符写入正则"而设，而此处需要匹配的目标本身
 * 即为控制字符 —— 以 ESC(0x1b) 开头的 CSI 序列，不写入它则无法剥离颜色码。
 */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g

/** 需要在正则里转义的字符 */
const REGEX_SPECIAL_RE = /[.*+?^${}()|[\]\\]/g

/**
 * 转义字符串使其可安全嵌入正则
 *
 * 命令前缀可能含 `#`、`*`、`(` 等字符，直接拼进正则会改变语义甚至抛错。
 * @param input 原始字符串
 * @returns 转义后的字符串
 */
export function escapeRegExp(input: string): string {
  return input.replace(REGEX_SPECIAL_RE, "\\$&")
}

/**
 * 去掉 ANSI 颜色码
 * @param input 原始字符串
 * @returns 纯文本
 */
export function stripAnsi(input: string): string {
  return input.replace(ANSI_RE, "")
}

/**
 * 判断码点是否占两列宽（东亚全角、表意文字、部分符号）
 * @param code 码点
 * @returns 是否全角
 */
function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) || // 谚文字母
    (code >= 0x2e80 && code <= 0x303e) || // CJK 部首、标点
    (code >= 0x3041 && code <= 0x33ff) || // 假名、CJK 兼容
    (code >= 0x3400 && code <= 0x4dbf) || // CJK 扩展 A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK 基本区
    (code >= 0xa000 && code <= 0xa4cf) || // 彝文
    (code >= 0xac00 && code <= 0xd7a3) || // 谚文音节
    (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容表意
    (code >= 0xfe30 && code <= 0xfe6f) || // CJK 兼容形式
    (code >= 0xff00 && code <= 0xff60) || // 全角 ASCII
    (code >= 0xffe0 && code <= 0xffe6) || // 全角符号
    (code >= 0x1f300 && code <= 0x1f64f) || // 绘文字
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd) // CJK 扩展 B+
  )
}

/**
 * 计算字符串的终端显示列宽
 * @param input 字符串
 * @returns 列宽（全角字符计 2）
 */
export function visualWidth(input: string): number {
  let width = 0
  for (const ch of stripAnsi(input)) {
    const code = ch.codePointAt(0)
    if (code === undefined) continue
    if (code < 0x20 || (code >= 0x7f && code < 0xa0)) continue // 控制字符不占宽
    width += isWide(code) ? 2 : 1
  }
  return width
}

/**
 * 按显示宽度右侧补空格
 * @param input 字符串
 * @param width 目标列宽
 * @returns 补齐后的字符串；已超宽时原样返回
 */
export function padVisualEnd(input: string, width: number): string {
  const pad = width - visualWidth(input)
  return pad > 0 ? input + " ".repeat(pad) : input
}

/**
 * 按显示宽度左侧补空格
 * @param input 字符串
 * @param width 目标列宽
 * @returns 补齐后的字符串
 */
export function padVisualStart(input: string, width: number): string {
  const pad = width - visualWidth(input)
  return pad > 0 ? " ".repeat(pad) + input : input
}

/**
 * 截断字符串
 *
 * 按码点而非 UTF-16 单元切分，不会把 emoji 劈成两半（`slice` 会）。
 * @param input 字符串
 * @param max 最大字符数
 * @param suffix 超长时的省略号，缺省 `"…"`
 * @returns 截断后的字符串
 */
export function truncate(input: string, max: number, suffix = "…"): string {
  const chars = [...input]
  if (chars.length <= max) return input
  return chars.slice(0, Math.max(0, max)).join("") + suffix
}

/**
 * 把连续空白折叠成单个空格并去首尾空白
 * @param input 字符串
 * @returns 规整后的字符串
 */
export function normalizeSpace(input: string): string {
  return input.replace(/\s+/g, " ").trim()
}

/**
 * 敏感信息脱敏
 *
 * 保留首尾各若干字符，中间部分打码；长度不足时整体打码，以避免脱敏后仍可推断原值。
 * @param input 原始值
 * @param keep 头尾各保留的字符数，缺省 4
 * @returns 脱敏后的字符串
 */
export function maskSecret(input: string, keep = 4): string {
  if (input === "") return ""
  const chars = [...input]
  if (chars.length <= keep * 2) return "*".repeat(chars.length)
  const head = chars.slice(0, keep).join("")
  const tail = chars.slice(-keep).join("")
  return `${head}${"*".repeat(Math.min(8, chars.length - keep * 2))}${tail}`
}

/**
 * 将长文本按最大长度切分为多段
 *
 * 优先在换行处切分，其次在空白处切分，两者均不可行时才强制切分 —— 直接强制切分会使
 * 长文本回复难以阅读。
 * @param input 文本
 * @param max 单段最大字符数
 * @returns 分段数组；输入为空时返回空数组
 */
export function splitText(input: string, max: number): string[] {
  if (max <= 0) return [input]
  const chars = [...input]
  if (chars.length === 0) return []
  if (chars.length <= max) return [input]

  const out: string[] = []
  let rest = input

  while ([...rest].length > max) {
    const window = [...rest].slice(0, max).join("")
    let cut = window.lastIndexOf("\n")
    if (cut < max * 0.5) {
      const space = window.search(/\s+\S*$/)
      cut = space > max * 0.5 ? space : -1
    }
    if (cut <= 0) cut = window.length

    out.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).replace(/^\s+/, "")
  }

  if (rest !== "") out.push(rest)
  return out
}

/**
 * 判断字符串是否可能是纯数字 id（QQ 号、群号）
 * @param input 字符串
 * @returns 是否为 1~20 位纯数字
 */
export function isNumericId(input: string): boolean {
  return /^\d{1,20}$/.test(input)
}

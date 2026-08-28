/**
 * 模块职责：终端输出 —— 换行、缩进、颜色与表格对齐
 * 依赖方向：仅依赖 node:process，不涉及内核
 * 生命周期：无状态，颜色开关于模块加载时确定一次
 * 注意事项：**刻意不使用 `console`，而是直接写入 `process.stdout`。** 理由有二：
 *          1) CLI 的输出是**程序结果**，而非日志。日志具有级别与 scope 并需落盘，
 *             应经由 `loggerHub`；而 `yzng doctor` 输出的表格不应被写入 yunzai.log，
 *             亦不应因日志级别被调整为 warn 而消失。
 *          2) 仓库的 eslint 规则禁用了 `console`（仅保留 `console.error`），其目的在于
 *             使插件必须经由 `ctx.logger` 输出。CLI 自身不应为此开设例外 —— 直接写入
 *             stdout 既满足该规则，亦更准确地表达了"此为命令的输出流"。
 */
import process from "node:process"

/** ANSI 转义引导符。写作转义序列而非字面控制字符：后者会被部分编辑器与补丁工具丢弃 */
const ESC = "\u001b"

/** 是否启用 ANSI 颜色：非 TTY（输出被管道接收）或已设置 NO_COLOR 时一律关闭 */
const COLOR = process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined

/**
 * 为文本附加 ANSI 颜色
 * @param code SGR 参数
 * @param text 文本
 * @returns 着色后的文本；未启用颜色时原样返回
 */
function paint(code: string, text: string): string {
  return COLOR ? `${ESC}[${code}m${text}${ESC}[0m` : text
}

/** 加粗 */
export const bold = (text: string): string => paint("1", text)
/** 变暗，用于次要信息 */
export const dim = (text: string): string => paint("2", text)
/** 红色，用于错误 */
export const red = (text: string): string => paint("31", text)
/** 绿色，用于成功 */
export const green = (text: string): string => paint("32", text)
/** 黄色，用于警告 */
export const yellow = (text: string): string => paint("33", text)
/** 青色，用于路径与命令 */
export const cyan = (text: string): string => paint("36", text)

/**
 * 向标准输出写入一行
 * @param text 文本，缺省为空行
 */
export function print(text = ""): void {
  process.stdout.write(`${text}\n`)
}

/**
 * 向标准错误写入一行
 *
 * 分流的目的在于使 `yzng doctor > report.txt` 之类的重定向仍能在终端观察到错误信息。
 * @param text 文本
 */
export function printErr(text: string): void {
  process.stderr.write(`${text}\n`)
}

/**
 * 估算字符串在等宽终端中占用的列数
 *
 * 仅区分"宽字符"与"窄字符"两档，不处理组合字符与 emoji 变体选择符 ——
 * CLI 中出现的仅为中文标签与 ASCII 取值，更高的精度并无收益。
 * @param text 文本
 * @returns 列数
 */
export function displayWidth(text: string): number {
  let width = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x3fffd)
    width += wide ? 2 : 1
  }
  return width
}

/**
 * 输出一组"标签 值"，标签按显示宽度在右侧补齐
 *
 * 使用 `displayWidth` 而非 `str.length` 度量宽度：标签为中文，中文在等宽字体中
 * 占两列 —— 按 UTF-16 码元数补空格会使整张表格错位。
 * @param rows 标签与值
 * @param indent 每行前缀空格数
 */
export function printRows(rows: readonly (readonly [string, string])[], indent = 2): void {
  const width = Math.max(0, ...rows.map(([label]) => displayWidth(label)))
  const pad = " ".repeat(indent)
  for (const [label, value] of rows) {
    print(`${pad}${dim(label)}${" ".repeat(width - displayWidth(label) + 1)}${value}`)
  }
}

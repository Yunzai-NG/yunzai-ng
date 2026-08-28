/**
 * 模块职责：日志行的解析与彩色格式化
 * 依赖方向：依赖 util/text
 * 生命周期：纯函数
 * 注意事项：自行实现而不使用 `pino-pretty`，理由与 rotate.ts 相同：pino-pretty 作为
 *          transport 运行于 worker 线程，单文件打包后无法定位入口；作为同步
 *          prettifier 又会引入一系列依赖。此处以 150 行完成，且可按需对齐中日韩
 *          全角字符（`visualWidth`）。
 *
 *          颜色遵循约定：`NO_COLOR` 有值即禁用，`FORCE_COLOR` 有值即启用，
 *          否则依据 stdout 是否为 TTY 判定。
 */
import { inspect } from "node:util"
import type { LogLevel } from "@yunzai-ng/types"
import { padVisualEnd, visualWidth } from "../util/text.js"

/** pino 的数字级别 → 级别名 */
const LEVEL_NAMES: Record<number, LogLevel> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal"
}

/** 级别名 → pino 数字级别 */
export const LEVEL_VALUES: Record<Exclude<LogLevel, "silent">, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60
}

/** 控制台里显示的级别标签（定宽 5 列，便于竖向对齐） */
const LEVEL_LABELS: Record<LogLevel, string> = {
  trace: "TRACE",
  debug: "DEBUG",
  info: "INFO ",
  warn: "WARN ",
  error: "ERROR",
  fatal: "FATAL",
  silent: "     "
}

/** ANSI 前景色码 */
const LEVEL_COLORS: Record<LogLevel, string> = {
  trace: "90", // 亮黑（灰）
  debug: "36", // 青
  info: "32", // 绿
  warn: "33", // 黄
  error: "31", // 红
  fatal: "35", // 洋红
  silent: "0"
}

/** pino 注入的、不该当作业务字段打印出来的键 */
const RESERVED_KEYS = new Set(["level", "time", "msg", "pid", "hostname", "v", "err", "scope"])

/**
 * 判断当前是否应输出颜色
 * @returns 是否启用颜色
 */
export function supportsColor(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== "") return true
  return process.stdout.isTTY === true
}

/**
 * 给文本加 ANSI 颜色
 * @param code 颜色码，如 `"32"`
 * @param text 文本
 * @param enabled 是否启用；false 时原样返回
 * @returns 带颜色的文本
 */
export function paint(code: string, text: string, enabled: boolean): string {
  return enabled ? `\u001b[${code}m${text}\u001b[0m` : text
}

/** 解析后的日志记录 */
export interface LogRecord {
  /** 级别名 */
  level: LogLevel
  /** 毫秒时间戳 */
  time: number
  /** 主消息 */
  msg: string
  /** 作用域（插件名 / 适配器名 / 账号 id） */
  scope?: string
  /** 错误堆栈 */
  stack?: string
  /** 其余业务字段 */
  fields?: Record<string, unknown>
}

/**
 * 解析 pino 输出的一行 JSON
 * @param line 日志行（含尾部换行）
 * @returns 解析结果；不是合法 JSON 时 undefined
 */
export function parseRecord(line: string): LogRecord | undefined {
  const text = line.trim()
  if (text === "" || text[0] !== "{") return undefined

  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text) as Record<string, unknown>
  } catch {
    return undefined
  }

  const levelNum = typeof raw.level === "number" ? raw.level : 30
  const err = raw.err as { stack?: unknown; message?: unknown } | undefined

  const fields: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!RESERVED_KEYS.has(key)) fields[key] = value
  }

  return {
    level: LEVEL_NAMES[levelNum] ?? "info",
    time: typeof raw.time === "number" ? raw.time : Date.now(),
    msg: typeof raw.msg === "string" ? raw.msg : typeof err?.message === "string" ? err.message : "",
    scope: typeof raw.scope === "string" ? raw.scope : undefined,
    stack: typeof err?.stack === "string" ? err.stack : undefined,
    fields: Object.keys(fields).length > 0 ? fields : undefined
  }
}

/**
 * 格式化时间为 `HH:mm:ss.SSS`
 * @param time 毫秒时间戳
 * @returns 时间字符串
 */
function formatTime(time: number): string {
  const d = new Date(time)
  const hh = String(d.getHours()).padStart(2, "0")
  const mm = String(d.getMinutes()).padStart(2, "0")
  const ss = String(d.getSeconds()).padStart(2, "0")
  const ms = String(d.getMilliseconds()).padStart(3, "0")
  return `${hh}:${mm}:${ss}.${ms}`
}

/** 控制台格式化选项 */
export interface FormatOptions {
  /** 是否着色 */
  color: boolean
  /** 作用域列的对齐宽度，缺省 14；设 0 不对齐 */
  scopeWidth?: number
  /** 是否打印错误堆栈，缺省 true */
  stack?: boolean
}

/**
 * 把日志记录格式化为一行（或多行，含堆栈）控制台文本
 * @param rec 日志记录
 * @param opts 格式化选项
 * @returns 带尾部换行的文本
 */
export function formatRecord(rec: LogRecord, opts: FormatOptions): string {
  const { color } = opts
  const levelColor = LEVEL_COLORS[rec.level]

  const time = paint("90", formatTime(rec.time), color)
  const level = paint(levelColor, LEVEL_LABELS[rec.level], color)

  let scope = ""
  if (rec.scope) {
    const width = opts.scopeWidth ?? 14
    // 作用域超宽时不截断（宁可错行也不让用户看不出是哪个插件），
    // 只在未超宽时补齐
    const label = width > 0 && visualWidth(rec.scope) < width ? padVisualEnd(rec.scope, width) : rec.scope
    scope = ` ${paint("36", label, color)}`
  }

  let extra = ""
  if (rec.fields) {
    const parts: string[] = []
    for (const [key, value] of Object.entries(rec.fields)) {
      parts.push(`${paint("90", `${key}=`, color)}${stringifyField(value)}`)
    }
    if (parts.length > 0) extra = ` ${parts.join(" ")}`
  }

  let out = `${time} ${level}${scope} ${rec.msg}${extra}\n`

  if (rec.stack && opts.stack !== false) {
    out += `${paint("90", indent(rec.stack), color)}\n`
  }
  return out
}

/**
 * 缩进多行文本
 * @param text 文本
 * @returns 每行前加四空格
 */
function indent(text: string): string {
  return text
    .split("\n")
    .map(line => `    ${line}`)
    .join("\n")
}

/**
 * 将字段值转换为紧凑的单行文本
 * @param value 字段值
 * @returns 单行字符串
 */
function stringifyField(value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value)
  return inspect(value, { depth: 2, breakLength: Number.POSITIVE_INFINITY, compact: true, colors: false })
}

/**
 * 将任意日志参数拼接为消息文本
 *
 * 不直接交由 pino 处理：pino 仅将第一个参数视为消息，其余参数仅在第一个参数含
 * `%s`/`%d` 占位符时才被消费，否则**静默丢弃**。而 `logger.info("查询", uid, data)`
 * 这类 console.log 写法很常见，故此处统一按 console.log 语义拼接。
 * @param args 日志参数
 * @returns 拼接后的消息与提取出的错误
 */
export function joinArgs(args: readonly unknown[]): { msg: string; err?: Error } {
  const parts: string[] = []
  let err: Error | undefined

  for (const arg of args) {
    if (arg instanceof Error) {
      // 第一个 Error 单独提出来，让 pino 的 err 序列化器保留堆栈
      if (!err) err = arg
      parts.push(arg.message)
      continue
    }
    if (typeof arg === "string") {
      parts.push(arg)
      continue
    }
    if (arg === undefined) {
      parts.push("undefined")
      continue
    }
    if (arg === null) {
      parts.push("null")
      continue
    }
    if (typeof arg === "object") {
      parts.push(inspect(arg, { depth: 3, breakLength: 120, compact: 3, colors: false }))
      continue
    }
    parts.push(String(arg))
  }

  return { msg: parts.join(" "), err }
}

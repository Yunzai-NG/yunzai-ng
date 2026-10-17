/**
 * 模块职责：日志枢纽（控制台/文件双路输出、运行时改级别、尾部缓冲）
 * 依赖方向：依赖 logger/format、logger/rotate、util
 * 生命周期：应用级单例，`close()` 时刷盘
 * 注意事项：三个不显然的决定 ——
 *          1) 级别过滤只在枢纽一处：面板上改级别必须立刻对所有已派生的子日志器生效
 *          2) 参数按 console.log 语义拼接（见 format.ts 的 `joinArgs`），`logger.info("查询", uid)` 不丢 uid
 *          3) 直接构造记录、按需拼文件行，不经「序列化成 JSON 再解析回来」那一圈；文件行与 pino
 *             的格式一致（`{"level":30,"time":…,…,"msg":…}`），旧日志与 `parseRecord` 照样通用
 */
import type { Disposer, LogBindings, Logger, LogLevel } from "@yunzai-ng/types"
import {
  LEVEL_VALUES,
  RESERVED_KEYS,
  type LogRecord,
  formatRecord,
  joinArgs,
  safeStringify,
  serializeError,
  supportsColor
} from "./format.js"
import { RotatingFileWriter } from "./rotate.js"

/** 一个日志器的固定字段，派生时算好，每条日志只拼接不重算 */
interface Bound {
  /** 作用域 */
  scope?: string
  /** 业务字段（不含保留键），给控制台与查看器 */
  fields?: Record<string, unknown>
  /** 文件行里 `"time":…` 之后、`"msg"` 之前那一段，形如 `,"scope":"x","n":5`；没有字段时空串 */
  chunk: string
}

/** 根日志器的固定字段 */
const ROOT_BOUND: Bound = { chunk: "" }

/**
 * 在已有固定字段上叠加一层
 *
 * 同名字段后者覆盖前者。值先过一遍 JSON 再取回：查看器与文件看到的是同一份东西，
 * 也免得插件之后改了传进来的对象、日志跟着变。
 * @param parent 上一层
 * @param bindings 新增字段
 * @returns 叠加后的固定字段
 */
function bind(parent: Bound, bindings: LogBindings): Bound {
  const merged: Record<string, unknown> = { ...parent.fields }
  if (parent.scope !== undefined) merged["scope"] = parent.scope
  Object.assign(merged, bindings)
  const plain = JSON.parse(safeStringify(merged)) as Record<string, unknown>
  const fields: Record<string, unknown> = {}
  let chunk = ""
  for (const [key, value] of Object.entries(plain)) {
    if (key === "level" || key === "time" || key === "msg") continue
    chunk += `,${JSON.stringify(key)}:${JSON.stringify(value)}`
    if (!RESERVED_KEYS.has(key)) fields[key] = value
  }
  const out: Bound = { chunk }
  if (typeof plain["scope"] === "string") out.scope = plain["scope"]
  if (Object.keys(fields).length > 0) out.fields = fields
  return out
}

/** 日志配置 */
export interface LoggerConfig {
  /** 全局级别，缺省 `"info"` */
  level?: LogLevel
  /** 文件输出级别，缺省与 `level` 相同 */
  fileLevel?: LogLevel
  /** 控制台输出级别，缺省与 `level` 相同 */
  consoleLevel?: LogLevel
  /** 日志目录；不给则只输出到控制台 */
  dir?: string
  /** 日志文件名前缀，缺省 `"app"` */
  basename?: string
  /** 是否输出到控制台，缺省 true */
  console?: boolean
  /** 是否着色，缺省自动探测 */
  color?: boolean
  /** 单文件字节上限 */
  maxSize?: number
  /** 日志保留天数 */
  keepDays?: number
  /** 日志文件数上限 */
  maxFiles?: number
  /** 尾部缓冲条数（供 WebUI 回看），缺省 500 */
  tailSize?: number
  /** 控制台作用域列宽，缺省 14 */
  scopeWidth?: number
}

/** 尾部日志查询条件 */
export interface TailQuery {
  /** 最多返回条数 */
  limit?: number
  /** 最低级别 */
  level?: LogLevel
  /** 作用域精确匹配 */
  scope?: string
  /** 消息子串匹配（不区分大小写） */
  keyword?: string
}

/** 默认尾部缓冲条数 */
const DEFAULT_TAIL = 500

/**
 * 级别名转数字，`silent` 视为最高
 * @param level 级别名
 * @returns 数字级别
 */
function levelValue(level: LogLevel): number {
  return level === "silent" ? Number.POSITIVE_INFINITY : LEVEL_VALUES[level]
}

/**
 * 日志枢纽
 *
 * 内核只创建一个；插件通过 `ctx.logger`（即 `hub.root.child({ scope })`）取用。
 */
export class LoggerHub {
  /** 文件写入器 */
  readonly #writer: RotatingFileWriter | undefined
  /** 环形缓冲 */
  readonly #ring: (LogRecord | undefined)[]
  /** 环形缓冲写指针 */
  #ringPos = 0
  /** 环形缓冲是否已绕回（用于判断有效长度） */
  #ringFull = false
  /** 实时订阅者 */
  readonly #subscribers = new Set<(rec: LogRecord) => void>()
  /** 防止订阅者内部再打日志导致无限递归 */
  #notifying = false

  /** 全局级别：控制台的缺省级别，也是查看器不指定级别时的缺省过滤 */
  #level: LogLevel
  /** 控制台级别数字 */
  #consoleValue: number
  /**
   * 文件级别数字
   *
   * 缺省是 trace（记全部），不跟随 `level`：改级别是为了改「看什么」，
   * 而历史日志一旦没落盘就再也补不回来 —— 复现不了的缺陷正是靠它翻回去查。
   */
  #fileValue: number
  /**
   * 生效阈值：两路里更低的那个，低于它的日志直接不生成
   *
   * 有文件输出时它恒为文件那一档（缺省 trace），故控制台调高级别不会让
   * 文件与查看器跟着丢数据。
   */
  #threshold: number

  /** 是否输出控制台 */
  readonly #console: boolean
  /** 是否着色 */
  readonly #color: boolean
  /** 作用域列宽 */
  readonly #scopeWidth: number

  /** 根日志器 */
  readonly root: Logger

  /**
   * @param config 日志配置
   */
  constructor(config: LoggerConfig = {}) {
    this.#level = config.level ?? "info"
    this.#console = config.console !== false
    this.#color = config.color ?? supportsColor()
    this.#scopeWidth = config.scopeWidth ?? 14
    this.#ring = new Array<LogRecord | undefined>(Math.max(50, config.tailSize ?? DEFAULT_TAIL))

    this.#consoleValue = this.#console ? levelValue(config.consoleLevel ?? this.#level) : Number.POSITIVE_INFINITY
    // 文件缺省 trace 而非跟随 level：见 #fileValue
    this.#fileValue = config.dir ? levelValue(config.fileLevel ?? "trace") : Number.POSITIVE_INFINITY
    this.#threshold = Math.min(this.#consoleValue, this.#fileValue)

    this.#writer = config.dir
      ? new RotatingFileWriter({
          dir: config.dir,
          basename: config.basename,
          maxSize: config.maxSize,
          keepDays: config.keepDays,
          maxFiles: config.maxFiles
        })
      : undefined

    this.root = new HubLogger(this, ROOT_BOUND)
  }

  /** 当前全局级别 */
  get level(): LogLevel {
    return this.#level
  }

  /** 当前日志文件路径；未启用文件输出时 undefined */
  get file(): string | undefined {
    return this.#writer?.file
  }

  /**
   * 判断某级别当前是否会被输出；由 `HubLogger` 在每次打日志前调用，命中 false 时连消息都不拼
   * @param level 目标级别
   * @returns 是否启用
   */
  enabled(level: LogLevel): boolean {
    return levelValue(level) >= this.#threshold
  }

  /**
   * 运行时修改级别；立刻对所有已创建的子日志器生效，这正是把过滤放在包装层的原因
   *
   * 缺省只改控制台，**不动文件那一路**：文件要留全量，否则调低级别的那段时间就成了
   * 历史里的空白，而那正是最需要翻回去看的一段。要改文件得显式传 `"file"`。
   * @param level 新级别
   * @param target 只改某一路：`"console"` / `"file"`；缺省改控制台与查看器缺省
   */
  setLevel(level: LogLevel, target?: "console" | "file"): void {
    const value = levelValue(level)
    if (target === "file") {
      if (this.#writer) this.#fileValue = value
    } else {
      if (target !== "console") this.#level = level
      if (this.#console) this.#consoleValue = value
    }
    this.#threshold = Math.min(this.#consoleValue, this.#fileValue)
  }

  /**
   * 取尾部日志
   *
   * 缓冲里存的是全量，级别只在读取时过滤：缺省按当前 `level`，查看器可传更低的级别
   * 翻出**已经过去**的 debug —— 那正是「复现不了、只能回头查」的那类缺陷要的东西。
   * @param query 查询条件；`level` 缺省取当前全局级别
   * @returns 按时间正序的日志记录
   */
  tail(query: TailQuery = {}): LogRecord[] {
    const size = this.#ring.length
    const count = this.#ringFull ? size : this.#ringPos
    const minLevel = levelValue(query.level ?? this.#level)
    const keyword = query.keyword?.toLowerCase()

    const out: LogRecord[] = []
    for (let i = 0; i < count; i++) {
      // 从最旧的一条开始按环形顺序读
      const index = this.#ringFull ? (this.#ringPos + i) % size : i
      const rec = this.#ring[index]
      if (!rec) continue
      if (levelValue(rec.level) < minLevel) continue
      if (query.scope && rec.scope !== query.scope) continue
      if (keyword && !rec.msg.toLowerCase().includes(keyword)) continue
      out.push(rec)
    }

    const limit = query.limit ?? out.length
    return limit >= out.length ? out : out.slice(out.length - limit)
  }

  /**
   * 订阅实时日志（WebUI 的 SSE / WebSocket 推送用）
   * @param fn 回调；**不要在里面打日志**，会被静默丢弃以防递归
   * @returns 取消订阅
   */
  subscribe(fn: (rec: LogRecord) => void): Disposer {
    this.#subscribers.add(fn)
    return () => void this.#subscribers.delete(fn)
  }

  /** 同步刷盘 */
  flush(): void {
    this.#writer?.flushSync()
  }

  /** 刷盘并关闭文件 */
  close(): void {
    this.#subscribers.clear()
    this.#writer?.close()
  }

  /**
   * 写一条日志：控制台、文件、环形缓冲/订阅者三处共用同一份记录
   *
   * 由 `HubLogger` 在过了级别判定之后调用。
   * @param level 级别
   * @param bound 日志器的固定字段
   * @param msg 拼好的消息
   * @param err 随附的错误
   */
  write(level: Exclude<LogLevel, "silent">, bound: Bound, msg: string, err: Error | undefined): void {
    const value = LEVEL_VALUES[level]
    const time = Date.now()
    const serialized = err === undefined ? undefined : serializeError(err)

    const rec: LogRecord = { level, time, msg: msg === "" && serialized ? serialized.message : msg }
    if (bound.scope !== undefined) rec.scope = bound.scope
    if (serialized) rec.stack = serialized.stack
    if (bound.fields) rec.fields = bound.fields

    if (value >= this.#consoleValue) {
      const text = formatRecord(rec, { color: this.#color, scopeWidth: this.#scopeWidth })
      // warn 及以上走 stderr，便于 `yzng start 2> error.log` 单独收集
      if (value >= LEVEL_VALUES.warn) process.stderr.write(text)
      else process.stdout.write(text)
    }

    if (this.#writer && value >= this.#fileValue) {
      const errPart = serialized ? `,"err":${safeStringify(serialized)}` : ""
      this.#writer.write(`{"level":${value},"time":${time}${bound.chunk}${errPart},"msg":${JSON.stringify(msg)}}\n`)
      // fatal 立即落盘：这行之后进程很可能就没了
      if (value >= LEVEL_VALUES.fatal) this.#writer.flushSync()
    }

    this.#ring[this.#ringPos] = rec
    this.#ringPos = (this.#ringPos + 1) % this.#ring.length
    if (this.#ringPos === 0) this.#ringFull = true

    this.#notify(rec)
  }

  /**
   * 通知订阅者
   * @param rec 日志记录
   */
  #notify(rec: LogRecord): void {
    if (this.#subscribers.size === 0 || this.#notifying) return
    this.#notifying = true
    try {
      for (const fn of this.#subscribers) {
        try {
          fn(rec)
        } catch {
          // 订阅者出错不能影响日志本身
        }
      }
    } finally {
      this.#notifying = false
    }
  }
}

/**
 * 面向插件的日志器实现
 *
 * 只带一份固定字段：级别过滤与输出都在枢纽里。
 */
class HubLogger implements Logger {
  /** 所属枢纽 */
  readonly #hub: LoggerHub
  /** 固定字段（scope 等） */
  readonly #bound: Bound

  /**
   * @param hub 日志枢纽
   * @param bound 固定字段
   */
  constructor(hub: LoggerHub, bound: Bound) {
    this.#hub = hub
    this.#bound = bound
  }

  /** 当前生效级别 */
  get level(): LogLevel {
    return this.#hub.level
  }

  /**
   * 最细粒度的追踪日志
   * @param msg 消息
   * @param args 附加参数
   */
  trace(msg: unknown, ...args: unknown[]): void {
    this.#emit("trace", msg, args)
  }

  /**
   * 调试信息
   * @param msg 消息
   * @param args 附加参数
   */
  debug(msg: unknown, ...args: unknown[]): void {
    this.#emit("debug", msg, args)
  }

  /**
   * 常规信息
   * @param msg 消息
   * @param args 附加参数
   */
  info(msg: unknown, ...args: unknown[]): void {
    this.#emit("info", msg, args)
  }

  /**
   * 需要留意但不影响运行
   * @param msg 消息
   * @param args 附加参数
   */
  warn(msg: unknown, ...args: unknown[]): void {
    this.#emit("warn", msg, args)
  }

  /**
   * 出错但可继续
   * @param msg 消息
   * @param args 附加参数
   */
  error(msg: unknown, ...args: unknown[]): void {
    this.#emit("error", msg, args)
  }

  /**
   * 致命错误
   * @param msg 消息
   * @param args 附加参数
   */
  fatal(msg: unknown, ...args: unknown[]): void {
    this.#emit("fatal", msg, args)
  }

  /**
   * 重要信息，等价于 `info`
   * @param msg 消息
   * @param args 附加参数
   */
  mark(msg: unknown, ...args: unknown[]): void {
    this.#emit("info", msg, args)
  }

  /**
   * 派生子日志器
   * @param bindings 固定字段
   * @returns 新日志器
   */
  child(bindings: LogBindings): Logger {
    return new HubLogger(this.#hub, bind(this.#bound, bindings))
  }

  /**
   * 判断级别是否启用
   * @param level 目标级别
   * @returns 是否启用
   */
  isLevelEnabled(level: LogLevel): boolean {
    return this.#hub.enabled(level)
  }

  /**
   * 实际写日志
   * @param level 级别
   * @param msg 首个参数
   * @param args 其余参数
   */
  #emit(level: Exclude<LogLevel, "silent">, msg: unknown, args: readonly unknown[]): void {
    if (!this.#hub.enabled(level)) return
    const joined = joinArgs(args.length === 0 ? [msg] : [msg, ...args])
    this.#hub.write(level, this.#bound, joined.msg, joined.err)
  }
}

/**
 * 创建日志枢纽
 * @param config 日志配置
 * @returns 日志枢纽
 */
export function createLoggerHub(config: LoggerConfig = {}): LoggerHub {
  return new LoggerHub(config)
}

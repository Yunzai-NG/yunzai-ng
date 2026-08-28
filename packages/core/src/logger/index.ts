/**
 * 模块职责：日志枢纽（pino 实例、控制台/文件双路输出、运行时改级别、尾部缓冲）
 * 依赖方向：依赖 logger/format、logger/rotate、util
 * 生命周期：应用级单例，`close()` 时刷盘
 * 注意事项：三个不显然的设计决定 ——
 *
 *          1) **pino 实例常驻 trace，级别过滤放在包装层做**。pino 的 child
 *             logger 在创建时固化 level，改父级不会传播给已有子级；而 WebUI
 *             上"把日志级别调成 debug"必须立刻对所有插件生效。所以过滤前移到
 *             `#emit`，顺带连 `joinArgs` 的字符串拼接都省掉了，比 pino 自带
 *             的级别检查更省。
 *
 *          2) **参数按 console.log 语义拼接**（见 format.ts 的 `joinArgs`）。
 *             pino 原生仅识别第一个参数，`logger.info("查询", uid)` 将丢弃 uid。
 *
 *          3) **不采用 pino.multistream**。控制台与文件的级别过滤在自有的
 *             dispatcher 中完成，同时将日志写入 WebUI 的环形缓冲，一次解析三处使用。
 */
import pino from "pino"
import type { Disposer, LogBindings, Logger, LogLevel } from "@yunzai-ng/types"
import { LEVEL_VALUES, type LogRecord, formatRecord, joinArgs, parseRecord, supportsColor } from "./format.js"
import { RotatingFileWriter } from "./rotate.js"

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
  /** pino 实例（级别恒为 trace，过滤在包装层做） */
  readonly #pino: pino.Logger
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

  /** 全局级别 */
  #level: LogLevel
  /** 控制台级别数字 */
  #consoleValue: number
  /** 文件级别数字 */
  #fileValue: number
  /** 生效阈值：两路里更低的那个，低于它的日志直接不生成 */
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
    this.#fileValue = config.dir ? levelValue(config.fileLevel ?? this.#level) : Number.POSITIVE_INFINITY
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

    this.#pino = pino(
      {
        level: "trace",
        // 去掉 pid/hostname：单机机器人用不上，白占日志体积
        base: undefined,
        serializers: { err: pino.stdSerializers.err }
      },
      { write: (line: string) => this.#dispatch(line) }
    )

    this.root = new HubLogger(this, this.#pino)
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
   * 判断某级别当前是否会被输出
   *
   * 由 `HubLogger` 在每次打日志前调用；命中 false 时连消息都不拼。
   * @param level 目标级别
   * @returns 是否启用
   */
  enabled(level: LogLevel): boolean {
    return levelValue(level) >= this.#threshold
  }

  /**
   * 运行时修改级别
   *
   * 立刻对所有已创建的子日志器生效 —— 这正是把过滤放在包装层的原因。
   * @param level 新级别
   * @param target 只改某一路：`"console"` / `"file"`；缺省两路都改
   */
  setLevel(level: LogLevel, target?: "console" | "file"): void {
    const value = levelValue(level)
    if (target === "console") {
      if (this.#console) this.#consoleValue = value
    } else if (target === "file") {
      if (this.#writer) this.#fileValue = value
    } else {
      this.#level = level
      if (this.#console) this.#consoleValue = value
      if (this.#writer) this.#fileValue = value
    }
    this.#threshold = Math.min(this.#consoleValue, this.#fileValue)
  }

  /**
   * 取尾部日志
   * @param query 查询条件
   * @returns 按时间正序的日志记录
   */
  tail(query: TailQuery = {}): LogRecord[] {
    const size = this.#ring.length
    const count = this.#ringFull ? size : this.#ringPos
    const minLevel = query.level ? levelValue(query.level) : 0
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
   * 分发一行 pino 输出
   *
   * 一次解析，三处使用：控制台、文件、环形缓冲/订阅者。
   * @param line pino 生成的 JSON 行
   */
  #dispatch(line: string): void {
    const rec = parseRecord(line)
    if (!rec) {
      // 无法解析时原样输出至控制台，优于直接丢弃
      if (this.#console) process.stdout.write(line)
      return
    }

    const value = levelValue(rec.level)

    if (value >= this.#consoleValue) {
      const text = formatRecord(rec, { color: this.#color, scopeWidth: this.#scopeWidth })
      // warn 及以上走 stderr，便于 `yzng start 2> error.log` 单独收集
      if (value >= LEVEL_VALUES.warn) process.stderr.write(text)
      else process.stdout.write(text)
    }

    if (this.#writer && value >= this.#fileValue) {
      this.#writer.write(line)
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
 * 只是 pino 的薄包装：加上级别前置过滤、console.log 风格参数拼接、`mark`。
 */
class HubLogger implements Logger {
  /** 所属枢纽 */
  readonly #hub: LoggerHub
  /** 底层 pino 实例（已绑定 scope 等字段） */
  readonly #pino: pino.Logger

  /**
   * @param hub 日志枢纽
   * @param instance pino 实例
   */
  constructor(hub: LoggerHub, instance: pino.Logger) {
    this.#hub = hub
    this.#pino = instance
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
    return new HubLogger(this.#hub, this.#pino.child(bindings))
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
    if (joined.err) this.#pino[level]({ err: joined.err }, joined.msg)
    else this.#pino[level](joined.msg)
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

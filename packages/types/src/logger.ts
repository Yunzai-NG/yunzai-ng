/**
 * 模块职责：日志接口
 * 依赖方向：叶子模块
 * 生命周期：纯类型
 * 注意事项：内核实现用 pino，而插件只看到这个接口 —— 换实现不影响插件。
 */

/** 日志级别，由低到高 */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "silent"

/** 一条日志的附加字段 */
export type LogBindings = Record<string, unknown>

/** 日志器 */
export interface Logger {
  /** 当前生效级别 */
  readonly level: LogLevel

  /** 最细粒度的追踪日志 */
  trace(msg: unknown, ...args: unknown[]): void
  /** 调试信息 */
  debug(msg: unknown, ...args: unknown[]): void
  /** 常规信息 */
  info(msg: unknown, ...args: unknown[]): void
  /** 需要留意但不影响运行 */
  warn(msg: unknown, ...args: unknown[]): void
  /** 出错但可继续 */
  error(msg: unknown, ...args: unknown[]): void
  /** 致命错误 */
  fatal(msg: unknown, ...args: unknown[]): void

  /**
   * 重要信息
   *
   * 等价于 `info`，仅为兼容 Miao-Yunzai 的 `logger.mark` 习惯而保留。
   */
  mark(msg: unknown, ...args: unknown[]): void

  /**
   * 派生带固定字段的子日志器
   * @param bindings 附加到每条日志上的字段，如 `{ plugin: "mhy-game" }`
   * @returns 新的日志器，不影响父级
   */
  child(bindings: LogBindings): Logger

  /**
   * 判断某级别是否会被输出，用于跳过昂贵的日志参数构造
   * @param level 目标级别
   * @returns 该级别当前是否启用
   */
  isLevelEnabled(level: LogLevel): boolean
}

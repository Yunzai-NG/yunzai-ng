/**
 * 模块职责：跨模块复用的基础类型别名
 * 依赖方向：叶子模块，不依赖本包内任何其他文件
 * 注意事项：只放「任何层都可能用到」的类型，带业务语义的进对应领域文件
 */

/** 可能同步也可能异步的返回值 */
export type Awaitable<T> = T | Promise<T>

/**
 * 回收句柄
 *
 * 内核全部「注册」类 API（命令、中间件、定时任务、路由、服务）都返回它，
 * 插件卸载时由内核逐个调用。
 */
export type Disposer = () => void

/** 字符串键值字典 */
export type Dict<V = unknown> = Record<string, V>

/** 递归可选，用于配置补丁 */
export type DeepPartial<T> = T extends (infer U)[]
  ? DeepPartial<U>[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T

/** 递归只读，用于对外暴露配置快照 */
export type DeepReadonly<T> = T extends (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T

/** 至少包含一个键的对象 */
export type AtLeastOne<T, K extends keyof T = keyof T> = Partial<T> & { [P in K]-?: Required<Pick<T, P>> }[K]

/**
 * 时长表达式：毫秒数，或 `"5s"` / `"3m"` / `"2h"` / `"1d"` 这类可读串
 *
 * 由内核的 `parseDuration` 统一解析。
 */
export type DurationLike = number | `${number}${"ms" | "s" | "m" | "h" | "d"}`

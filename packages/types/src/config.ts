/**
 * 模块职责：配置读写句柄
 * 依赖方向：依赖 common.ts / schema.ts
 * 生命周期：纯类型
 * 注意事项：`onChange` 带上变更路径，故实现方可以只失效受影响的那一小块，
 *          而不必在任何一处改动后清空整份缓存。
 */
import type { DeepPartial, DeepReadonly, Disposer } from "./common.js"
import type { SchemaDescriptor } from "./schema.js"

/** 配置变更事件 */
export interface ConfigChange<T> {
  /** 变更后的完整配置 */
  next: DeepReadonly<T>
  /** 变更前的完整配置 */
  prev: DeepReadonly<T>
  /**
   * 发生变更的字段路径（点号分隔，如 `"napcat.accounts.0.token"`）
   *
   * 实现方尽力给出；无法精确判断时给出最近的公共父路径。
   */
  paths: string[]
  /** 变更来源 */
  source: "webui" | "file" | "api" | "default"
}

/**
 * 类型安全的配置句柄
 *
 * 通过 `definePlugin({ configSchema })` 声明后由内核注入到 `ctx.config`。
 */
export interface ConfigHandle<T> {
  /** 配置文件绝对路径 */
  readonly file: string
  /** 供 WebUI 渲染表单的描述 */
  readonly schema: SchemaDescriptor

  /**
   * 取当前配置快照
   * @returns 只读快照；每次调用返回同一对象，变更后才换新对象
   */
  get(): DeepReadonly<T>

  /**
   * 局部更新并落盘
   * @param patch 要合并的补丁，深合并
   * @returns 更新后的快照
   * @throws 校验失败时抛出，原配置保持不变
   */
  patch(patch: DeepPartial<T>): Promise<DeepReadonly<T>>

  /**
   * 整体替换并落盘
   * @param value 完整配置
   * @returns 更新后的快照
   * @throws 校验失败时抛出，原配置保持不变
   */
  replace(value: T): Promise<DeepReadonly<T>>

  /**
   * 恢复默认值并落盘
   * @returns 更新后的快照
   */
  reset(): Promise<DeepReadonly<T>>

  /**
   * 订阅变更
   * @param cb 变更回调，抛错只记日志不冒泡
   * @returns 取消订阅的句柄
   */
  onChange(cb: (change: ConfigChange<T>) => void): Disposer
}

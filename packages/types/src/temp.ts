/**
 * 模块职责：定义插件临时文件与磁盘缓存的公共契约。
 * 依赖方向：仅引用公共时长类型，不依赖内核实现。
 * 生命周期：纯类型，无运行时状态。
 * 注意事项：file 返回独占文件，cached 返回共享路径，调用方不能删除共享文件。
 */
import type { DurationLike } from "./common.js"

/** 文件内容；字符串按 UTF-8 写入，远程文件须显式传 URL 对象。 */
export type TempSource = string | Uint8Array | {
  /** HTTP(S) 下载地址 */
  url: string
}

/** 调用者独占的临时文件。 */
export interface TempFile {
  /** 本地绝对路径 */
  readonly path: string
  /** 提前删除；可重复调用 */
  remove(): Promise<void>
}

/** 插件实例的磁盘临时文件，不是持久化存储。 */
export interface PluginTemp {
  /** 创建独占文件，ext 示例：`.png`。 */
  file(source: TempSource, ext?: string): Promise<TempFile>
  /** 同键共享只读路径；首次成功写入决定该次内容及有效期，命中不续期。 */
  cached(key: string, source: TempSource, options: TempCacheOptions): Promise<string>
}

/** 可复用临时文件的选项。 */
export interface TempCacheOptions {
  /** 正的存活时长 */
  ttl: DurationLike
  /** 文件扩展名，默认无 */
  ext?: string
}

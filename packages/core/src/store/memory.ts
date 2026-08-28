/**
 * 模块职责：内存 KV 驱动（测试与"仅内存"模式）
 * 依赖方向：依赖类型包与 util/deep
 * 生命周期：`close()` 后可再 `open()`
 * 注意事项：**存取都做深拷贝**。若直接存引用，调用方在 set 之后修改对象会连带改掉
 *          "已落盘"的值；这样内存驱动下能跑通的代码换到 level/json 驱动就会出错，
 *          属于最难查的一类问题。宁可多一次拷贝，也要让三种驱动语义完全一致。
 */
import type { KvBatchOp, KvDriver, StoredEnvelope } from "@yunzai-ng/types"
import { deepClone } from "../util/deep.js"
import { isExpired } from "./kv.js"

/** 内存 KV 驱动 */
export class MemoryKvDriver implements KvDriver {
  /** 驱动 id */
  readonly id = "memory"

  /** 数据表 */
  readonly #map = new Map<string, StoredEnvelope>()

  /** 键数量（含未清理的过期键），仅用于调试与面板展示 */
  get size(): number {
    return this.#map.size
  }

  /** 打开（内存驱动无需准备） */
  async open(): Promise<void> {
    // 无操作
  }

  /** 关闭并清空 */
  async close(): Promise<void> {
    this.#map.clear()
  }

  /**
   * 读取
   * @param key 完整键
   * @returns 值信封的副本
   */
  async get(key: string): Promise<StoredEnvelope | undefined> {
    const env = this.#map.get(key)
    return env === undefined ? undefined : deepClone(env)
  }

  /**
   * 写入
   * @param key 完整键
   * @param value 值信封
   */
  async set(key: string, value: StoredEnvelope): Promise<void> {
    this.#map.set(key, deepClone(value))
  }

  /**
   * 删除
   * @param key 完整键
   */
  async del(key: string): Promise<void> {
    this.#map.delete(key)
  }

  /**
   * 批量操作
   * @param ops 操作列表
   */
  async batch(ops: KvBatchOp[]): Promise<void> {
    for (const op of ops) {
      if (op.op === "set") this.#map.set(op.key, deepClone(op.value))
      else this.#map.delete(op.key)
    }
  }

  /**
   * 按前缀扫描
   * @param prefix 键前缀
   * @returns 键值对迭代器
   */
  async *scan(prefix: string): AsyncIterableIterator<readonly [string, StoredEnvelope]> {
    // 先快照键集合：调用方在遍历中删除过期键是正常用法，
    // 直接迭代 Map 会撞上"遍历中修改"的未定义顺序
    for (const key of [...this.#map.keys()]) {
      if (!key.startsWith(prefix)) continue
      const env = this.#map.get(key)
      if (env === undefined) continue
      yield [key, deepClone(env)]
    }
  }

  /**
   * 原生原子自增
   *
   * 单线程 JS 里同步的读改写天然原子，故内存驱动可以直接提供，
   * 免掉上层的串行队列开销。
   * @param key 完整键
   * @param by 增量
   * @param expireAt 首次创建时的过期时间点
   * @returns 自增后的值
   */
  async incr(key: string, by: number, expireAt?: number): Promise<number> {
    const env = this.#map.get(key)
    const alive = env !== undefined && !isExpired(env)
    const current = alive && typeof env.v === "number" ? env.v : 0
    const next = current + by
    const keep = alive ? env.e : expireAt
    this.#map.set(key, keep === undefined ? { v: next } : { v: next, e: keep })
    return next
  }
}

/**
 * 模块职责：LRU + TTL 缓存，带并发去重
 * 依赖方向：仅依赖类型包
 * 生命周期：随创建者（插件 / 账号）一起被回收
 * 注意事项：三项机制合起来使缓存的内存占用具备上界 —— 裸 Map 存群成员表且从不淘汰时，
 *          数十个千人群即是数百 MB 常驻：
 *          1) 硬性上限 + LRU 淘汰；
 *          2) TTL 惰性过期；
 *          3) single-flight 合并同 key 的并发请求，避免一条群消息中多处判定权限时
 *             各发一次平台请求。
 *
 *          **不采用定时器扫描**：定时器或造成泄漏，或需额外的生命周期管理。改为每次写入时
 *          清理队首若干过期项，摊还成本 O(1)。
 */
import type { ContactCache, ContactCacheOptions } from "@yunzai-ng/types"
import { parseDuration } from "./duration.js"

/** 缓存条目 */
interface Entry<V> {
  /** 缓存的值 */
  value: V
  /** 过期时间点（毫秒），Infinity 表示不过期 */
  expireAt: number
}

/** 每次写入时顺带检查的队首条目数 */
const SWEEP_PER_WRITE = 4

/**
 * LRU + TTL 缓存
 *
 * 利用 `Map` 的插入顺序实现 LRU：读命中时把条目挪到队尾，
 * 于是队首恒为最久未使用者，淘汰只需 `keys().next()`。
 */
export class LruCache<V> implements ContactCache<V> {
  /** 主存储，键序即 LRU 序（队首最久未用） */
  readonly #map = new Map<string, Entry<V>>()
  /** 进行中的 loader，用于并发去重 */
  readonly #pending = new Map<string, Promise<V | undefined>>()
  /** 条目上限 */
  readonly #max: number
  /** 默认存活毫秒 */
  readonly #ttl: number

  /** 命中次数（诊断用） */
  #hits = 0
  /** 未命中次数（诊断用） */
  #misses = 0

  /**
   * @param opts 缓存参数；`max` 至少为 1，`ttl` 为 0 表示不过期
   */
  constructor(opts: ContactCacheOptions) {
    this.#max = Math.max(1, Math.floor(opts.max))
    const ttl = parseDuration(opts.ttl, 0)
    this.#ttl = ttl > 0 ? ttl : Number.POSITIVE_INFINITY
  }

  /** 当前条目数（含尚未被清理的过期项） */
  get size(): number {
    return this.#map.size
  }

  /** 命中率统计，供 `/api/diagnostics` 展示缓存是否配得合理 */
  get stats(): { hits: number; misses: number; size: number; max: number } {
    return { hits: this.#hits, misses: this.#misses, size: this.#map.size, max: this.#max }
  }

  /**
   * 取缓存
   * @param key 键
   * @returns 值；未命中或已过期时 undefined
   */
  get(key: string): V | undefined {
    const entry = this.#map.get(key)
    if (!entry) {
      this.#misses++
      return undefined
    }
    if (entry.expireAt <= Date.now()) {
      this.#map.delete(key)
      this.#misses++
      return undefined
    }
    // 命中即挪到队尾：delete + set 是 Map 上唯一能改插入序的手段
    this.#map.delete(key)
    this.#map.set(key, entry)
    this.#hits++
    return entry.value
  }

  /**
   * 写缓存
   * @param key 键
   * @param value 值
   * @param ttl 覆盖默认存活时长（毫秒）
   */
  set(key: string, value: V, ttl?: number): void {
    this.#sweep()
    const expireAt = ttl === undefined ? this.#ttl : ttl
    this.#map.delete(key)
    this.#map.set(key, {
      value,
      expireAt: Number.isFinite(expireAt) ? Date.now() + expireAt : Number.POSITIVE_INFINITY
    })
    // 超限时从队首淘汰，直到回到上限内
    while (this.#map.size > this.#max) {
      const oldest = this.#map.keys().next()
      if (oldest.done) break
      this.#map.delete(oldest.value)
    }
  }

  /**
   * 删除
   * @param key 键
   */
  delete(key: string): void {
    this.#map.delete(key)
  }

  /**
   * 取缓存，未命中时用 loader 拉取并回填
   *
   * 同一 key 的并发调用共享同一个 loader promise。loader 抛错时不缓存，
   * 但会把错误传播给所有等待者——避免"一次网络抖动被缓存成永久失败"。
   * @param key 键
   * @param loader 拉取函数
   * @returns 值；loader 返回 undefined 时不缓存
   */
  async fetch(key: string, loader: (key: string) => Promise<V | undefined>): Promise<V | undefined> {
    const cached = this.get(key)
    if (cached !== undefined) return cached

    const inflight = this.#pending.get(key)
    if (inflight) return inflight

    const task = (async () => {
      try {
        const value = await loader(key)
        if (value !== undefined) this.set(key, value)
        return value
      } finally {
        this.#pending.delete(key)
      }
    })()

    this.#pending.set(key, task)
    return task
  }

  /** 清空全部条目与进行中的 loader 记录 */
  clear(): void {
    this.#map.clear()
    this.#pending.clear()
    this.#hits = 0
    this.#misses = 0
  }

  /**
   * 清理队首若干个过期条目
   *
   * 只看队首是因为 LRU 序下队首最可能已经过期；全量扫描在千级条目上
   * 会让每次写入都变成 O(n)。
   */
  #sweep(): void {
    if (this.#ttl === Number.POSITIVE_INFINITY) return
    const now = Date.now()
    let checked = 0
    for (const [key, entry] of this.#map) {
      if (checked++ >= SWEEP_PER_WRITE) break
      if (entry.expireAt <= now) this.#map.delete(key)
      else break // 队首未过期时后续项更不可能过期（近似成立，满足本场景需要）
    }
  }
}

/**
 * 创建 LRU + TTL 缓存
 * @param opts 缓存参数
 * @returns 缓存实例
 */
export function createCache<V>(opts: ContactCacheOptions): LruCache<V> {
  return new LruCache<V>(opts)
}

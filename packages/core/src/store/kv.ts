/**
 * 模块职责：驱动之上的命名空间化 KV 视图（前缀隔离、TTL、原子自增、前缀遍历）
 * 依赖方向：依赖 util/{duration,queue}、类型包；不认识任何具体驱动
 * 生命周期：与驱动同寿；`Kv` 自身无需回收
 * 注意事项：三条规则 ——
 *
 *          1) **过期为读时判定**，不用定时器扫描 —— 那会在低内存设备上白耗 CPU。读到过期键
 *             即视为不存在并一并删除，遍历时同样机会式清理。
 *          2) **`incr` 在驱动没有原生原子操作时退化为"按键串行的读改写"。** LevelDB 没有 INCR，
 *             直接 `get` + `set` 会让同一秒内的并发消息相互覆盖、计数偏小。`KeyedQueue` 把同一个键
 *             的操作排队，进程内语义正确；跨进程原子性不予承诺（单进程架构无此需要）。
 *          3) **每个插件的键自带 `plugin:<name>:` 前缀**，插件之间不可能访问到对方的键 ——
 *             隔离由前缀保证，不靠命名约定。
 */
import type { DurationLike, KvDriver, KvNamespace, KvSetOptions, StoredEnvelope } from "@yunzai-ng/types"
import { parseDuration } from "../util/duration.js"
import { KeyedQueue } from "../util/queue.js"

/** 命名空间分隔符 */
const SEP = ":"

/** 单次遍历中最多清理多少个过期键（有界，避免遍历大库时删除列表耗尽内存） */
const SWEEP_LIMIT = 256

/**
 * 命名空间化的 KV 视图
 *
 * 由 `openKv()` 创建根视图，插件通过 `ctx.kv` 拿到 `plugin:<name>:` 子视图。
 */
export class Kv implements KvNamespace {
  /** 本命名空间的键前缀 */
  readonly prefix: string

  /** 底层驱动 */
  readonly #driver: KvDriver
  /** 自增串行队列，与同一驱动的所有视图共享 */
  readonly #queue: KeyedQueue

  /**
   * @param driver 底层驱动
   * @param prefix 键前缀（含结尾分隔符，根视图为空串）
   * @param queue 自增串行队列；派生子视图时必须沿用父级的队列，
   *              否则同一个键在父子视图里会落到两条队列上，串行保证失效
   */
  constructor(driver: KvDriver, prefix = "", queue = new KeyedQueue()) {
    this.#driver = driver
    this.prefix = prefix
    this.#queue = queue
  }

  /**
   * 读取
   * @param key 命名空间内的键
   * @returns 值；不存在或已过期时 undefined
   */
  async get<T = unknown>(key: string): Promise<T | undefined> {
    const full = this.#full(key)
    const env = await this.#driver.get(full)
    if (env === undefined) return undefined
    if (isExpired(env)) {
      // 读到过期键即予删除：不删除则遍历与容量统计均会被无效数据污染
      await this.#driver.del(full).catch(() => undefined)
      return undefined
    }
    return env.v as T
  }

  /**
   * 读取，不存在时返回默认值
   * @param key 命名空间内的键
   * @param fallback 默认值
   * @returns 值或默认值
   */
  async getOr<T>(key: string, fallback: T): Promise<T> {
    const value = await this.get<T>(key)
    return value === undefined ? fallback : value
  }

  /**
   * 写入
   * @param key 命名空间内的键
   * @param value 值，必须可 JSON 序列化
   * @param opts 写入选项
   */
  async set<T = unknown>(key: string, value: T, opts?: KvSetOptions): Promise<void> {
    await this.#driver.set(this.#full(key), envelope(value, opts?.ttl))
  }

  /**
   * 删除
   * @param key 命名空间内的键
   */
  async del(key: string): Promise<void> {
    await this.#driver.del(this.#full(key))
  }

  /**
   * 判断是否存在且未过期
   * @param key 命名空间内的键
   * @returns 是否存在
   */
  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== undefined
  }

  /**
   * 原子自增
   *
   * 驱动提供原生 `incr` 就直接用；否则按键串行地读改写。
   * @param key 命名空间内的键
   * @param by 增量，默认 1
   * @param opts 写入选项；`ttl` 只在键首次创建时生效（与 Redis 的 INCR 语义一致：
   *             自增不会刷新过期时间，否则热点计数器永不过期）
   * @returns 自增后的值
   */
  async incr(key: string, by = 1, opts?: KvSetOptions): Promise<number> {
    const full = this.#full(key)
    const expireAt = expiryOf(opts?.ttl)

    if (this.#driver.incr) return this.#driver.incr(full, by, expireAt)

    return this.#queue.run(full, async () => {
      const env = await this.#driver.get(full)
      const alive = env !== undefined && !isExpired(env)
      const current = alive && typeof env.v === "number" ? env.v : 0
      const next = current + by

      // 已存在的键保留原过期时间点，新建的键才套用传入的 ttl
      const keep = alive ? env.e : expireAt
      await this.#driver.set(full, keep === undefined ? { v: next } : { v: next, e: keep })
      return next
    })
  }

  /**
   * 读取剩余存活毫秒数
   * @param key 命名空间内的键
   * @returns 剩余毫秒；永不过期返回 Infinity；不存在或已过期返回 -1
   */
  async ttl(key: string): Promise<number> {
    const env = await this.#driver.get(this.#full(key))
    if (env === undefined || isExpired(env)) return -1
    if (env.e === undefined) return Number.POSITIVE_INFINITY
    return env.e - Date.now()
  }

  /**
   * 遍历键（不含命名空间前缀）
   * @param prefix 命名空间内的额外前缀
   * @returns 键的异步迭代器
   */
  async *keys(prefix = ""): AsyncIterableIterator<string> {
    for await (const [key] of this.entries(prefix)) yield key
  }

  /**
   * 遍历键值
   * @param prefix 命名空间内的额外前缀
   * @returns 键值对的异步迭代器
   */
  async *entries<T = unknown>(prefix = ""): AsyncIterableIterator<readonly [string, T]> {
    const base = this.#full(prefix)
    const expired: string[] = []
    try {
      for await (const [full, env] of this.#driver.scan(base)) {
        if (isExpired(env)) {
          if (expired.length < SWEEP_LIMIT) expired.push(full)
          continue
        }
        yield [full.slice(this.prefix.length), env.v as T]
      }
    } finally {
      // 在迭代结束后再删：遍历过程中改动底层游标在部分驱动上是未定义行为。
      // 提前 break 也会走到这里，已收集的过期键同样被清理。
      if (expired.length > 0) await this.#delMany(expired)
    }
  }

  /**
   * 清空（可按前缀）
   * @param prefix 命名空间内的额外前缀，省略则清空整个命名空间
   * @returns 删除的键数量
   */
  async clear(prefix = ""): Promise<number> {
    const base = this.#full(prefix)
    const keys: string[] = []
    for await (const [full] of this.#driver.scan(base)) keys.push(full)
    await this.#delMany(keys)
    return keys.length
  }

  /**
   * 派生子命名空间
   * @param name 子命名空间名
   * @returns 新的 KV 视图，与父级共享驱动与自增队列
   * @throws 当名字为空或含分隔符时（否则两个不同的子空间可能拼出同一个前缀）
   */
  sub(name: string): KvNamespace {
    if (name === "") throw new Error("子命名空间名不能为空")
    if (name.includes(SEP)) throw new Error(`子命名空间名不能含 "${SEP}"：${name}`)
    return new Kv(this.#driver, `${this.prefix}${name}${SEP}`, this.#queue)
  }

  /**
   * 拼出完整键
   * @param key 命名空间内的键
   * @returns 完整键
   */
  #full(key: string): string {
    return `${this.prefix}${key}`
  }

  /**
   * 批量删除，能用 batch 就用 batch
   * @param keys 完整键列表
   */
  async #delMany(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return
    if (this.#driver.batch) {
      await this.#driver.batch(keys.map(key => ({ op: "del" as const, key })))
      return
    }
    for (const key of keys) await this.#driver.del(key)
  }
}

/**
 * 判断信封是否已过期
 * @param env 值信封
 * @returns 是否过期
 */
export function isExpired(env: StoredEnvelope): boolean {
  return env.e !== undefined && env.e <= Date.now()
}

/**
 * 计算过期时间点
 * @param ttl 存活时长
 * @returns 毫秒时间戳；不过期时 undefined
 */
export function expiryOf(ttl: DurationLike | undefined): number | undefined {
  if (ttl === undefined) return undefined
  const ms = parseDuration(ttl, 0)
  return ms > 0 ? Date.now() + ms : undefined
}

/**
 * 组装值信封
 * @param value 值
 * @param ttl 存活时长
 * @returns 值信封
 */
export function envelope(value: unknown, ttl?: DurationLike): StoredEnvelope {
  const e = expiryOf(ttl)
  return e === undefined ? { v: value } : { v: value, e }
}

/**
 * 模块职责：JSON 文件 KV 驱动（纯 JS 兜底，Termux/无编译环境用）
 * 依赖方向：依赖 util/{fs,deep}、类型包
 * 生命周期：`open()` 载入全量数据，`close()` 落盘；进程存续期间数据常驻内存
 * 注意事项：**这是兜底方案，不是主力**。全量数据常驻内存 + 每次写盘重写整个文件，
 *          数据量大了必然吃内存与 IO；只在原生模块装不上（Android/Termux 常见）
 *          时启用，`level` 驱动才是默认。
 *
 *          写盘做了两件事防丢数据：一是合并窗口内的多次写只落一次盘，
 *          二是走 `atomicWrite`（同目录临时文件 + rename），断电不会留下半个文件。
 *          进程退出前必须 `close()`，否则最后一个窗口内的写入会丢。
 */
import type { KvBatchOp, KvDriver, StoredEnvelope } from "@yunzai-ng/types"
import { atomicWrite, ensureDir, readText } from "../util/fs.js"
import { deepClone } from "../util/deep.js"
import { dirname } from "node:path"
import { isExpired } from "./kv.js"

/** 落盘合并窗口（毫秒） */
const FLUSH_DELAY = 300

/** 文件格式版本，将来变更结构时用于迁移判断 */
const FORMAT = 1

/** 落盘结构 */
interface JsonFileShape {
  /** 格式版本 */
  format: number
  /** 数据表 */
  data: Record<string, StoredEnvelope>
}

/** JSON 文件 KV 驱动 */
export class JsonKvDriver implements KvDriver {
  /** 驱动 id */
  readonly id = "json"

  /** 文件绝对路径 */
  readonly #file: string
  /** 数据表 */
  #map = new Map<string, StoredEnvelope>()
  /** 落盘定时器 */
  #timer: NodeJS.Timeout | undefined
  /** 是否有未落盘的改动 */
  #dirty = false
  /** 正在进行的落盘，用于串行化避免两次写互相覆盖 */
  #writing: Promise<void> = Promise.resolve()
  /** 是否已关闭 */
  #closed = false

  /**
   * @param file 数据文件绝对路径
   */
  constructor(file: string) {
    this.#file = file
  }

  /** 键数量 */
  get size(): number {
    return this.#map.size
  }

  /**
   * 载入数据
   *
   * 文件损坏时不抛错也不删除：改名为 `.corrupt-<时间戳>` 留证，然后从空库启动。
   * 存储坏了让机器人起不来，比丢一点缓存严重得多。
   */
  async open(): Promise<void> {
    this.#closed = false
    await ensureDir(dirname(this.#file))
    const text = await readText(this.#file)
    if (text === undefined || text.trim() === "") return

    try {
      const parsed = JSON.parse(text) as JsonFileShape
      const data = parsed.format === FORMAT ? parsed.data : undefined
      if (!data || typeof data !== "object") throw new Error("结构不符")
      this.#map = new Map(Object.entries(data))
      // 载入时清掉过期键，避免它们一直占内存直到被访问
      for (const [key, env] of [...this.#map]) if (isExpired(env)) this.#map.delete(key)
    } catch (err) {
      const backup = `${this.#file}.corrupt-${Date.now()}`
      await atomicWrite(backup, text).catch(() => undefined)
      throw new Error(`KV 数据文件解析失败，已备份到 ${backup}：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** 落盘并停止后续写入 */
  async close(): Promise<void> {
    this.#closed = true
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
    await this.flush()
  }

  /**
   * 读取
   * @param key 完整键
   * @returns 值信封副本
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
    this.#schedule()
  }

  /**
   * 删除
   * @param key 完整键
   */
  async del(key: string): Promise<void> {
    if (this.#map.delete(key)) this.#schedule()
  }

  /**
   * 批量操作（只触发一次落盘）
   * @param ops 操作列表
   */
  async batch(ops: KvBatchOp[]): Promise<void> {
    let changed = false
    for (const op of ops) {
      if (op.op === "set") {
        this.#map.set(op.key, deepClone(op.value))
        changed = true
      } else if (this.#map.delete(op.key)) changed = true
    }
    if (changed) this.#schedule()
  }

  /**
   * 按前缀扫描
   * @param prefix 键前缀
   * @returns 键值对迭代器
   */
  async *scan(prefix: string): AsyncIterableIterator<readonly [string, StoredEnvelope]> {
    for (const key of [...this.#map.keys()]) {
      if (!key.startsWith(prefix)) continue
      const env = this.#map.get(key)
      if (env === undefined) continue
      yield [key, deepClone(env)]
    }
  }

  /**
   * 原生原子自增（同步读改写，单线程下天然原子）
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
    this.#schedule()
    return next
  }

  /** 立即落盘（`close()` 与测试用） */
  async flush(): Promise<void> {
    if (!this.#dirty) return await this.#writing
    this.#dirty = false

    const snapshot: JsonFileShape = { format: FORMAT, data: Object.fromEntries(this.#map) }
    // 串在上一次写之后：两次并发的 atomicWrite 会竞争同一个目标文件
    this.#writing = this.#writing.then(async () => {
      await atomicWrite(this.#file, JSON.stringify(snapshot))
    })
    await this.#writing
  }

  /** 安排一次延迟落盘 */
  #schedule(): void {
    this.#dirty = true
    if (this.#closed || this.#timer) return
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      void this.flush().catch(() => undefined)
    }, FLUSH_DELAY)
    // unref：等待落盘不该拖住进程退出，退出路径上有 close() 兜底
    if (typeof this.#timer.unref === "function") this.#timer.unref()
  }
}

/**
 * 模块职责：内嵌 LevelDB KV 驱动（默认驱动）
 * 依赖方向：动态依赖可选原生模块 classic-level；依赖类型包
 * 生命周期：`open()` 打开数据库目录，`close()` 关闭并 flush
 * 注意事项：classic-level 是 **optionalDependency**（原生模块，Termux 上可能编不出来），
 *          所以这里用动态 `import()` 且**不引用它的类型** —— 只声明自己真正用到的
 *          那几个方法。这样在没装成功的机器上，整个内核依然能编译、能跑，
 *          由 `openKv()` 自动降级到 json 驱动。
 *
 *          刻意不实现 `incr`：LevelDB 没有原子自增原语，硬写成 get+put 会在并发下
 *          丢计数。留空让上层的按键串行队列接管，语义才是对的。
 */
import type { KvBatchOp, KvDriver, StoredEnvelope } from "@yunzai-ng/types"
import { ensureDir } from "../util/fs.js"

/** classic-level 中本驱动实际用到的最小面 */
interface LevelDb {
  /** 打开数据库 */
  open(): Promise<void>
  /** 关闭数据库 */
  close(): Promise<void>
  /** 读取，缺失返回 undefined（abstract-level 2.x 语义） */
  get(key: string): Promise<StoredEnvelope | undefined>
  /** 写入 */
  put(key: string, value: StoredEnvelope): Promise<void>
  /** 删除 */
  del(key: string): Promise<void>
  /** 批量写入/删除 */
  batch(ops: { type: "put" | "del"; key: string; value?: StoredEnvelope }[]): Promise<void>
  /** 范围迭代器 */
  iterator(opts: { gte?: string }): LevelIterator
}

/** classic-level 的迭代器最小面 */
interface LevelIterator extends AsyncIterable<[string, StoredEnvelope]> {
  /** 关闭迭代器，释放底层快照 */
  close(): Promise<void>
}

/** classic-level 的构造签名 */
type LevelCtor = new (location: string, opts: { valueEncoding: "json" }) => LevelDb

/**
 * 尝试加载 classic-level
 * @returns 构造函数；模块不可用时 undefined
 */
export async function loadLevel(): Promise<LevelCtor | undefined> {
  try {
    const mod = (await import("classic-level")) as unknown as { ClassicLevel?: LevelCtor }
    return mod.ClassicLevel
  } catch {
    return undefined
  }
}

/** 内嵌 LevelDB KV 驱动 */
export class LevelKvDriver implements KvDriver {
  /** 驱动 id */
  readonly id = "level"

  /** 数据库目录 */
  readonly #dir: string
  /** 构造函数 */
  readonly #ctor: LevelCtor
  /** 数据库实例 */
  #db: LevelDb | undefined

  /**
   * @param dir 数据库目录
   * @param ctor classic-level 构造函数，由 `loadLevel()` 提供
   */
  constructor(dir: string, ctor: LevelCtor) {
    this.#dir = dir
    this.#ctor = ctor
  }

  /** 数据库目录 */
  get dir(): string {
    return this.#dir
  }

  /**
   * 打开数据库
   * @throws 目录被另一个进程锁住时（LevelDB 是单进程独占）
   */
  async open(): Promise<void> {
    await ensureDir(this.#dir)
    const db = new this.#ctor(this.#dir, { valueEncoding: "json" })
    await db.open()
    this.#db = db
  }

  /** 关闭数据库 */
  async close(): Promise<void> {
    const db = this.#db
    this.#db = undefined
    if (db) await db.close()
  }

  /**
   * 读取
   * @param key 完整键
   * @returns 值信封；不存在时 undefined
   */
  async get(key: string): Promise<StoredEnvelope | undefined> {
    return this.#require().get(key)
  }

  /**
   * 写入
   * @param key 完整键
   * @param value 值信封
   */
  async set(key: string, value: StoredEnvelope): Promise<void> {
    await this.#require().put(key, value)
  }

  /**
   * 删除
   * @param key 完整键
   */
  async del(key: string): Promise<void> {
    await this.#require().del(key)
  }

  /**
   * 批量操作（LevelDB 的原子批写）
   * @param ops 操作列表
   */
  async batch(ops: KvBatchOp[]): Promise<void> {
    if (ops.length === 0) return
    await this.#require().batch(
      ops.map(op => (op.op === "set" ? { type: "put" as const, key: op.key, value: op.value } : { type: "del" as const, key: op.key }))
    )
  }

  /**
   * 按前缀扫描
   *
   * 只给出 `gte` 而不给上界，依靠"键按字节序排列 ⇒ 同前缀的键连续"提前结束。
   * 较自行计算 `lt` 上界更可靠：手工计算上界一旦遇到 emoji 一类四字节字符即会漏键。
   * @param prefix 键前缀
   * @returns 键值对迭代器
   */
  async *scan(prefix: string): AsyncIterableIterator<readonly [string, StoredEnvelope]> {
    const it = this.#require().iterator({ gte: prefix })
    try {
      for await (const [key, value] of it) {
        if (!key.startsWith(prefix)) break
        yield [key, value]
      }
    } finally {
      // 迭代器持有底层快照，不关会一直占着 sst 文件不让压缩
      await it.close().catch(() => undefined)
    }
  }

  /**
   * 取已打开的数据库
   * @returns 数据库实例
   * @throws 未 open 时
   */
  #require(): LevelDb {
    if (!this.#db) throw new Error("LevelDB 尚未打开，请先调用 open()")
    return this.#db
  }
}

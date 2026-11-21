/**
 * 模块职责：SQLite KV 驱动 —— 生产环境唯一的落盘格式，`<store>/kv.db` 一个文件
 * 依赖方向：依赖 store/sqlite-binding、util/fs、类型包
 * 生命周期：`open()` 打开并独占文件，`close()` 释放；关闭时 WAL 合回主文件
 * 注意事项：三条约定 ——
 *          1) **独占打开**（locking_mode=EXCLUSIVE）：两个实例指向同一主目录时第二个直接报占用，
 *             不会两边各写一半。导出命令也靠它判断实例是否还在跑。
 *          2) **遍历按页取、页间不持有游标**：调用方在遍历中途 await 别的读写是正常用法，
 *             better-sqlite3 在迭代器打开时不许同一连接执行其他语句。
 *          3) 值存 JSON 文本，`undefined` 存 NULL；过期时间单列，读时由上层判定。
 */
import type { KvBatchOp, KvDriver, StoredEnvelope } from "@yunzai-ng/types"
import { dirname } from "node:path"
import { ensureDir } from "../util/fs.js"
import type { SqliteBinding, SqliteConnection, SqliteStatementLike, SqliteValue } from "./sqlite-binding.js"

/** 存储目录下的库文件名 */
export const KV_DB_FILE = "kv.db"

/** 库内格式版本，将来改表结构时据此迁移 */
export const KV_DB_FORMAT = 1

/** 遍历每页取多少行 */
const SCAN_PAGE = 256

/** 一行 */
interface KvRow {
  /** 完整键 */
  k: string
  /** JSON 文本；值为 undefined 时 NULL */
  v: string | null
  /** 过期时间点 */
  e: number | bigint | null
}

/** 用到的预编译语句 */
interface Statements {
  get: SqliteStatementLike
  set: SqliteStatementLike
  del: SqliteStatementLike
  scanFirst: SqliteStatementLike
  scanNext: SqliteStatementLike
  count: SqliteStatementLike
}

/** SQLite KV 驱动 */
export class SqliteKvDriver implements KvDriver {
  /** 驱动 id */
  readonly id = "sqlite"

  /** 数据库文件 */
  readonly file: string
  /** 绑定 */
  readonly #binding: SqliteBinding
  /** 连接 */
  #db: SqliteConnection | undefined
  /** 语句 */
  #stmt: Statements | undefined

  /**
   * @param file 数据库文件绝对路径
   * @param binding 由 `loadSqliteBinding()` 取得
   */
  constructor(file: string, binding: SqliteBinding) {
    this.file = file
    this.#binding = binding
  }

  /** 实际使用的绑定 */
  get engine(): SqliteBinding["engine"] {
    return this.#binding.engine
  }

  /**
   * 打开并独占
   * @throws 文件被另一个连接占着时（错误可用 `isSqliteBusy` 识别）；库格式比本版本新时
   */
  async open(): Promise<void> {
    await ensureDir(dirname(this.file))
    const db = this.#binding.open(this.file)
    try {
      // busy_timeout 0：等不等由 openKv 的退避重试决定，这里一碰到锁就报
      db.exec("PRAGMA busy_timeout = 0")
      db.exec("PRAGMA locking_mode = EXCLUSIVE")
      db.exec("PRAGMA journal_mode = WAL")
      db.exec("PRAGMA synchronous = NORMAL")
      db.exec(
        "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;" +
          "CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT, e INTEGER) WITHOUT ROWID;"
      )
      const format = db.prepare("SELECT value FROM meta WHERE key = 'format'").get() as { value: string } | undefined
      if (format === undefined) {
        db.prepare("INSERT INTO meta (key, value) VALUES ('format', ?)").run(String(KV_DB_FORMAT))
      } else if (Number(format.value) > KV_DB_FORMAT) {
        throw new Error(`${this.file} 由更新版本的 Yunzai NG 写入（格式 ${format.value}），请先升级内核`)
      }
      this.#stmt = {
        get: db.prepare("SELECT v, e FROM kv WHERE k = ?"),
        set: db.prepare("INSERT OR REPLACE INTO kv (k, v, e) VALUES (?, ?, ?)"),
        del: db.prepare("DELETE FROM kv WHERE k = ?"),
        scanFirst: db.prepare("SELECT k, v, e FROM kv WHERE k >= ? ORDER BY k LIMIT ?"),
        scanNext: db.prepare("SELECT k, v, e FROM kv WHERE k > ? ORDER BY k LIMIT ?"),
        count: db.prepare("SELECT count(*) AS n FROM kv")
      }
      this.#db = db
    } catch (err) {
      db.close()
      throw err
    }
  }

  /** 关闭 */
  async close(): Promise<void> {
    const db = this.#db
    this.#db = undefined
    this.#stmt = undefined
    db?.close()
  }

  /**
   * 读取
   * @param key 完整键
   * @returns 值信封；不存在时 undefined
   */
  async get(key: string): Promise<StoredEnvelope | undefined> {
    const row = this.#require().get.get(key) as Omit<KvRow, "k"> | undefined
    return row === undefined ? undefined : decode(row)
  }

  /**
   * 写入
   * @param key 完整键
   * @param value 值信封
   */
  async set(key: string, value: StoredEnvelope): Promise<void> {
    this.#write(key, value)
  }

  /**
   * 删除
   * @param key 完整键
   */
  async del(key: string): Promise<void> {
    this.#require().del.run(key)
  }

  /**
   * 批量操作，一个事务
   * @param ops 操作列表
   */
  async batch(ops: KvBatchOp[]): Promise<void> {
    if (ops.length === 0) return
    const db = this.#conn()
    db.exec("BEGIN")
    try {
      for (const op of ops) {
        if (op.op === "set") this.#write(op.key, op.value)
        else this.#require().del.run(op.key)
      }
      db.exec("COMMIT")
    } catch (err) {
      db.exec("ROLLBACK")
      throw err
    }
  }

  /**
   * 原生自增：同步读改写，单连接单线程下天然原子
   * @param key 完整键
   * @param by 增量
   * @param expireAt 首次创建时的过期时间点
   * @returns 自增后的值
   */
  async incr(key: string, by: number, expireAt?: number): Promise<number> {
    const row = this.#require().get.get(key) as Omit<KvRow, "k"> | undefined
    const env = row === undefined ? undefined : decode(row)
    const alive = env !== undefined && (env.e === undefined || env.e > Date.now())
    const current = alive && typeof env.v === "number" ? env.v : 0
    const next = current + by
    const keep = alive ? env.e : expireAt
    this.#write(key, keep === undefined ? { v: next } : { v: next, e: keep })
    return next
  }

  /**
   * 按前缀顺序扫描
   *
   * 只给下界、遇到第一个不带前缀的键即停：键按字节序连续，手算上界在四字节字符上容易漏键。
   * @param prefix 键前缀
   * @returns 键值对迭代器
   */
  async *scan(prefix: string): AsyncIterableIterator<readonly [string, StoredEnvelope]> {
    let rows = this.#require().scanFirst.all(prefix, SCAN_PAGE) as KvRow[]
    while (rows.length > 0) {
      for (const row of rows) {
        if (!row.k.startsWith(prefix)) return
        yield [row.k, decode(row)]
      }
      if (rows.length < SCAN_PAGE) return
      const last = rows[rows.length - 1]?.k ?? ""
      rows = this.#require().scanNext.all(last, SCAN_PAGE) as KvRow[]
    }
  }

  /**
   * 行数（含未清理的过期键），迁移核对用
   * @returns 行数
   */
  count(): number {
    const row = this.#require().count.get() as { n: number | bigint }
    return Number(row.n)
  }

  /**
   * 把整库拷成一个干净的独立文件（不带 WAL）
   * @param target 目标路径，必须不存在
   */
  vacuumInto(target: string): void {
    this.#conn().prepare("VACUUM INTO ?").run(target)
  }

  /**
   * 写一行
   * @param key 完整键
   * @param value 值信封
   */
  #write(key: string, value: StoredEnvelope): void {
    const v: SqliteValue = value.v === undefined ? null : JSON.stringify(value.v)
    this.#require().set.run(key, v, value.e ?? null)
  }

  /**
   * 取语句
   * @returns 语句表
   * @throws 未 open 时
   */
  #require(): Statements {
    if (this.#stmt === undefined) throw new Error("KV 库尚未打开，请先调用 open()")
    return this.#stmt
  }

  /**
   * 取连接
   * @returns 连接
   * @throws 未 open 时
   */
  #conn(): SqliteConnection {
    if (this.#db === undefined) throw new Error("KV 库尚未打开，请先调用 open()")
    return this.#db
  }
}

/**
 * 行转信封
 * @param row 行
 * @returns 信封
 */
function decode(row: Omit<KvRow, "k">): StoredEnvelope {
  const v: unknown = row.v === null ? undefined : JSON.parse(row.v)
  return row.e === null ? { v } : { v, e: Number(row.e) }
}

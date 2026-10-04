/**
 * 模块职责：SQLite 关系存储（语句缓存、异步事务、迁移）
 * 依赖方向：动态依赖可选原生模块 better-sqlite3；依赖 util/{lru,queue}、类型包
 * 生命周期：`openSql()` 打开，`close()` 关闭
 * 注意事项：**不引 ORM**，只暴露 run/all/get/transaction/migrate。
 *
 *          **事务手写 BEGIN/COMMIT 并用互斥锁串行化**：better-sqlite3 的 `db.transaction()`
 *          只收同步函数，而本框架的接口是异步的（要容得下别的驱动）。一条连接上开不了两个
 *          事务，故事务之间必须排队；嵌套事务改用 SAVEPOINT，不重复抢锁。
 *
 *          **语句缓存有界。** `prepare()` 有真实开销，但无上限的缓存在动态拼 SQL 的插件手里
 *          就是内存泄漏。
 */
import type { SqlHandle, SqlMigration, SqlParam } from "@yunzai-ng/types"
import { dirname } from "node:path"
import { performance } from "node:perf_hooks"
import { LruCache } from "../util/lru.js"
import { Semaphore } from "../util/queue.js"
import { ensureDir } from "../util/fs.js"
import {
  StorageError,
  guardStatement,
  sqlCellOf,
  type SqlExecOptions,
  type SqlExecResult,
  type SqlInspectStore,
  type SqlPanelParam
} from "./inspect.js"

/** 语句缓存条目上限 */
const STMT_CACHE_MAX = 200

/** 迁移记录表名 */
const MIGRATION_TABLE = "_yzng_migrations"

/** better-sqlite3 的语句最小面 */
interface SqliteStatement {
  /** 是否返回行 */
  readonly reader: boolean
  /** 是否为只读语句 */
  readonly readonly: boolean
  /** 执行不取行 */
  run(...params: SqlParam[]): { changes: number; lastInsertRowid: number | bigint }
  /** 取全部行 */
  all(...params: SqlParam[]): unknown[]
  /** 取首行 */
  get(...params: SqlParam[]): unknown
  /** 逐行迭代 */
  iterate(...params: SqlParam[]): IterableIterator<unknown>
  /** 结果列 */
  columns(): { name: string }[]
  /** 切换为按数组返回行 */
  raw(toggle?: boolean): SqliteStatement
}

/** better-sqlite3 的连接最小面 */
interface SqliteDb {
  /** 预编译语句 */
  prepare(sql: string): SqliteStatement
  /** 直接执行脚本（可含多条语句，不支持绑定参数） */
  exec(sql: string): void
  /** 读写 pragma */
  pragma(source: string): unknown
  /** 关闭连接 */
  close(): void
}

/** better-sqlite3 的构造签名 */
type SqliteCtor = new (file: string, opts?: { readonly?: boolean }) => SqliteDb

/** 一条连接上的共享状态 */
interface SqlState {
  /** 连接 */
  db: SqliteDb
  /** 语句缓存 */
  stmts: LruCache<SqliteStatement>
  /** 事务互斥锁 */
  mutex: Semaphore
  /** SAVEPOINT 命名计数器 */
  savepoint: number
}

/**
 * 尝试加载 better-sqlite3
 * @returns 构造函数；模块不可用时 undefined
 */
export async function loadSqlite(): Promise<SqliteCtor | undefined> {
  try {
    const mod = (await import("better-sqlite3")) as unknown as { default?: SqliteCtor }
    return mod.default
  } catch {
    return undefined
  }
}

/**
 * SQLite 句柄
 *
 * 根句柄由 `openSql()` 创建；事务内传给回调的是 `depth > 0` 的子句柄，
 * 它们共享同一条连接，因此**不能**在事务回调里持有子句柄留到事务外使用。
 */
export class SqliteHandle implements SqlHandle {
  /** 共享状态 */
  readonly #state: SqlState
  /** 事务嵌套深度，0 表示不在事务中 */
  readonly #depth: number

  /**
   * @param state 共享状态
   * @param depth 事务嵌套深度
   */
  constructor(state: SqlState, depth = 0) {
    this.#state = state
    this.#depth = depth
  }

  /**
   * 执行不返回行的语句
   *
   * 不带参数且含多条语句时走 `exec()`，方便迁移里一次建表 + 建索引；
   * 这种情况下无法报告受影响行数，返回 0。
   * @param sql SQL 文本
   * @param params 绑定参数
   * @returns 受影响行数与最后插入 id
   */
  async run(sql: string, params: SqlParam[] = []): Promise<{ changes: number; lastInsertRowid: number | bigint }> {
    if (params.length === 0 && isMultiStatement(sql)) {
      this.#state.db.exec(sql)
      return { changes: 0, lastInsertRowid: 0 }
    }
    return this.#prepare(sql).run(...params)
  }

  /**
   * 查询多行
   * @param sql SQL 文本
   * @param params 绑定参数
   * @returns 结果行数组
   */
  async all<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<T[]> {
    return this.#prepare(sql).all(...params) as T[]
  }

  /**
   * 查询首行
   * @param sql SQL 文本
   * @param params 绑定参数
   * @returns 首行；无结果时 undefined
   */
  async get<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<T | undefined> {
    return (this.#prepare(sql).get(...params) as T | undefined) ?? undefined
  }

  /**
   * 在事务中执行
   *
   * 最外层用 `BEGIN IMMEDIATE`（立刻拿写锁，避免升级锁时才发现冲突而整段重来）；
   * 嵌套层用 SAVEPOINT，实现"内层回滚不牵连外层"。
   * @param fn 事务体，抛错即回滚
   * @returns 事务体的返回值
   */
  async transaction<T>(fn: (tx: SqlHandle) => Promise<T>): Promise<T> {
    if (this.#depth > 0) return this.#savepoint(fn)
    // 同一条连接上不能并发开事务，排队等前一个事务结束
    return this.#state.mutex.use(async () => {
      const tx = new SqliteHandle(this.#state, 1)
      this.#state.db.exec("BEGIN IMMEDIATE")
      try {
        const result = await fn(tx)
        this.#state.db.exec("COMMIT")
        return result
      } catch (err) {
        // 回滚本身也可能失败（连接已断），此时保留原始错误更有诊断价值
        try {
          this.#state.db.exec("ROLLBACK")
        } catch {
          /* 忽略 */
        }
        throw err
      }
    })
  }

  /**
   * 应用迁移
   *
   * 每条迁移单独一个事务：失败只回滚这一条，已成功的保持生效，修好后重跑从断点继续。
   * 版本号落在迁移表里，故"这个库到哪一版了"有确定答案，不必靠"存在则忽略"的 try/catch。
   * @param migrations 迁移列表
   * @throws 版本号未严格递增，或某条迁移执行失败
   */
  async migrate(migrations: SqlMigration[]): Promise<void> {
    await this.run(
      `CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
         version INTEGER PRIMARY KEY,
         name TEXT NOT NULL,
         applied_at INTEGER NOT NULL
       )`
    )

    const sorted = [...migrations].sort((a, b) => a.version - b.version)
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i]!.version === sorted[i - 1]!.version) {
        throw new Error(`迁移版本号重复：${sorted[i]!.version}`)
      }
    }

    const rows = await this.all<{ version: number }>(`SELECT version FROM ${MIGRATION_TABLE}`)
    const applied = new Set(rows.map(r => r.version))

    for (const migration of sorted) {
      if (applied.has(migration.version)) continue
      await this.transaction(async tx => {
        await migration.up(tx)
        await tx.run(`INSERT INTO ${MIGRATION_TABLE} (version, name, applied_at) VALUES (?, ?, ?)`, [
          migration.version,
          migration.name,
          Date.now()
        ])
      })
    }
  }

  /**
   * 嵌套事务：SAVEPOINT
   * @param fn 事务体
   * @returns 事务体的返回值
   */
  async #savepoint<T>(fn: (tx: SqlHandle) => Promise<T>): Promise<T> {
    const name = `yzng_sp_${++this.#state.savepoint}`
    const tx = new SqliteHandle(this.#state, this.#depth + 1)
    this.#state.db.exec(`SAVEPOINT ${name}`)
    try {
      const result = await fn(tx)
      this.#state.db.exec(`RELEASE ${name}`)
      return result
    } catch (err) {
      try {
        this.#state.db.exec(`ROLLBACK TO ${name}`)
        this.#state.db.exec(`RELEASE ${name}`)
      } catch {
        /* 忽略 */
      }
      throw err
    }
  }

  /**
   * 取（并缓存）预编译语句
   * @param sql SQL 文本
   * @returns 预编译语句
   */
  #prepare(sql: string): SqliteStatement {
    const cached = this.#state.stmts.get(sql)
    if (cached) return cached
    const stmt = this.#state.db.prepare(sql)
    this.#state.stmts.set(sql, stmt)
    return stmt
  }
}

/** 打开 SQL 存储的参数 */
export interface OpenSqlOptions {
  /** 数据库文件绝对路径 */
  file: string
  /** 构造函数，缺省自动加载 */
  ctor?: SqliteCtor
}

/** 已打开的 SQL 存储 */
export interface SqlStore extends SqlInspectStore {
  /** 句柄 */
  readonly handle: SqlHandle
  /** 数据库文件路径 */
  readonly file: string
  /** 关闭连接 */
  close(): void
}

/**
 * 打开 SQLite 数据库
 * @param opts 参数
 * @returns 已打开的 SQL 存储；原生模块不可用时 undefined（调用方应降级为纯 KV）
 */
export async function openSql(opts: OpenSqlOptions): Promise<SqlStore | undefined> {
  const ctor = opts.ctor ?? (await loadSqlite())
  if (!ctor) return undefined

  await ensureDir(dirname(opts.file))
  const db = new ctor(opts.file)

  // WAL：读不阻塞写，且断电时不会像 rollback journal 那样留下半个事务
  db.pragma("journal_mode = WAL")
  // NORMAL 在 WAL 下依然崩溃安全（只可能丢最后一个未 checkpoint 的事务），
  // 却比 FULL 快一个数量级；机器人数据不是账本，这个取舍是合适的
  db.pragma("synchronous = NORMAL")
  db.pragma("foreign_keys = ON")
  // 被别的连接短暂锁住时等一会儿再报错，而不是立刻抛 SQLITE_BUSY
  db.pragma("busy_timeout = 5000")

  const state: SqlState = {
    db,
    stmts: new LruCache<SqliteStatement>({ max: STMT_CACHE_MAX }),
    mutex: new Semaphore(1),
    savepoint: 0
  }

  return {
    handle: new SqliteHandle(state),
    file: opts.file,
    // 与插件事务共用互斥锁，避免面板语句落入插件未结束的事务
    exec: (sql, params, execOpts) => state.mutex.use(async () => execPanel(db, sql, params, execOpts)),
    close: () => {
      // 缓存里的语句必须先丢掉：连接关了之后再用它们会直接崩进程
      state.stmts.clear()
      db.close()
    }
  }
}

/**
 * 执行一条面板语句
 *
 * 不使用语句缓存：`raw()` 会修改语句对象，而缓存中的语句由插件复用。
 * @param db 连接
 * @param sql 单条 SQL
 * @param params 绑定参数
 * @param opts 选项
 * @returns 执行结果
 * @throws StorageError 语句被拦下、只读模式下写库，或 SQLite 报错时
 */
function execPanel(db: SqliteDb, sql: string, params: readonly SqlPanelParam[], opts: SqlExecOptions): SqlExecResult {
  const text = guardStatement(sql)
  if (isMultiStatement(text)) throw new StorageError(400, "一次只执行一条语句")

  const started = performance.now()
  const cost = (): number => Math.round((performance.now() - started) * 100) / 100
  const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err))

  let stmt: SqliteStatement
  try {
    stmt = db.prepare(text)
  } catch (err) {
    throw new StorageError(400, reason(err))
  }
  if (!stmt.readonly && !opts.allowWrite) {
    throw new StorageError(403, "面板处于只读模式（配置项 server.readonly 为 true），只能执行只读语句")
  }

  try {
    if (stmt.reader) {
      const columns = stmt.columns().map(c => c.name)
      const rows: unknown[][] = []
      let truncated = false
      for (const row of stmt.raw(true).iterate(...params)) {
        if (rows.length >= opts.limit) {
          truncated = true
          break
        }
        rows.push((row as unknown[]).map(sqlCellOf))
      }
      return { readonly: stmt.readonly, columns, rows, truncated, cost: cost() }
    }
    const result = stmt.run(...params)
    const rowid = sqlCellOf(result.lastInsertRowid) as number | string
    return { readonly: stmt.readonly, changes: result.changes, lastInsertRowid: rowid, cost: cost() }
  } catch (err) {
    throw new StorageError(400, reason(err))
  }
}

/**
 * 判断 SQL 是否包含多条语句
 *
 * 只做粗判：跳过字符串字面量后看是否还有 `;` 跟着非空白内容。
 * 粗判失败的后果仅仅是走 `prepare()` 然后由 SQLite 自己报错，可接受。
 * @param sql SQL 文本
 * @returns 是否多语句
 */
function isMultiStatement(sql: string): boolean {
  let inString = false
  let quote = ""
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!
    if (inString) {
      if (ch === quote) inString = false
      continue
    }
    if (ch === "'" || ch === '"') {
      inString = true
      quote = ch
      continue
    }
    if (ch === ";" && sql.slice(i + 1).trim() !== "") return true
  }
  return false
}

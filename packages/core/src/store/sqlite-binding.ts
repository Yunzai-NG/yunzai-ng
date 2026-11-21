/**
 * 模块职责：SQLite 绑定的选择 —— better-sqlite3 与 Node 自带的 node:sqlite 二选一，对上给出同一个最小面
 * 依赖方向：动态依赖可选原生模块 better-sqlite3 与内置模块 node:sqlite；不依赖本目录其他文件
 * 生命周期：加载结果按进程缓存
 * 注意事项：两者读写的是同一种文件格式，换绑定不换数据。better-sqlite3 优先（更成熟）；
 *          装不上（Termux、安卓、没有预编译包）时退到 node:sqlite（Node 22.13 起免旗标）。
 *
 *          加载时真开一次内存库：better-sqlite3 的 `.node` 到构造时才 require，
 *          ABI 不匹配只在那一刻报出来，只 import 成功不算可用。
 */
import { createRequire } from "node:module"

/** 绑定参数 */
export type SqliteValue = string | number | bigint | null | Uint8Array

/** 预编译语句的最小面 */
export interface SqliteStatementLike {
  /** 执行不取行 */
  run(...params: SqliteValue[]): unknown
  /** 取首行 */
  get(...params: SqliteValue[]): unknown
  /** 取全部行 */
  all(...params: SqliteValue[]): unknown[]
}

/** 连接的最小面 */
export interface SqliteConnection {
  /** 执行脚本（可含多条语句，不带参数） */
  exec(sql: string): void
  /** 预编译 */
  prepare(sql: string): SqliteStatementLike
  /** 关闭 */
  close(): void
}

/** 一种可用的绑定 */
export interface SqliteBinding {
  /** 绑定名，面板与日志里显示 */
  readonly engine: "better-sqlite3" | "node:sqlite"
  /**
   * 打开一个数据库文件；只读模式不创建文件
   * @param file 绝对路径
   * @param readOnly 只读打开现有文件
   * @returns 连接
   */
  open(file: string, readOnly?: boolean): SqliteConnection
}

/** 加载结果：成功给绑定，失败给原因 */
export interface SqliteBindingResult {
  /** 绑定 */
  readonly binding?: SqliteBinding
  /** 不可用的原因，按尝试顺序拼接 */
  readonly reason?: string
}

/** better-sqlite3 的构造签名 */
type BetterCtor = new (file: string, opts?: { readonly: boolean }) => SqliteConnection

/** node:sqlite 的构造签名 */
type NodeCtor = new (file: string, opts?: { readOnly: boolean }) => SqliteConnection

/**
 * 试加载 better-sqlite3
 * @returns 绑定；不可用时附原因
 */
export async function loadBetterSqlite(): Promise<SqliteBindingResult> {
  try {
    const mod = (await import("better-sqlite3")) as unknown as { default?: BetterCtor }
    const Ctor = mod.default
    if (Ctor === undefined) return { reason: "better-sqlite3 没有默认导出" }
    new Ctor(":memory:").close()
    return { binding: { engine: "better-sqlite3", open: (file, readOnly = false) => new Ctor(file, { readonly: readOnly }) } }
  } catch (err) {
    return { reason: `better-sqlite3：${firstLine(err)}` }
  }
}

/**
 * 试加载 node:sqlite
 * @returns 绑定；不可用时附原因
 */
export async function loadNodeSqlite(): Promise<SqliteBindingResult> {
  try {
    // 不写 `import("node:sqlite")`：它只有带前缀的写法，vite 一类工具会剥掉前缀去找一个叫 sqlite 的包
    const getBuiltin = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule
    const mod = (getBuiltin?.("node:sqlite") ?? createRequire(import.meta.url)("node:sqlite")) as { DatabaseSync?: NodeCtor }
    const Ctor = mod.DatabaseSync
    if (Ctor === undefined) return { reason: "node:sqlite 没有 DatabaseSync" }
    new Ctor(":memory:").close()
    return { binding: { engine: "node:sqlite", open: (file, readOnly = false) => new Ctor(file, { readOnly }) } }
  } catch (err) {
    return { reason: `node:sqlite（Node ${process.versions.node}）：${firstLine(err)}` }
  }
}

/** 进程内只探一次 */
let cached: Promise<SqliteBindingResult> | undefined

/**
 * 取一个可用的绑定：better-sqlite3 优先，其次 node:sqlite
 * @returns 绑定；都不可用时附两边的原因
 */
export function loadSqliteBinding(): Promise<SqliteBindingResult> {
  cached ??= (async () => {
    const better = await loadBetterSqlite()
    if (better.binding !== undefined) return better
    const builtin = await loadNodeSqlite()
    if (builtin.binding !== undefined) return builtin
    return { reason: `${better.reason ?? ""}；${builtin.reason ?? ""}` }
  })()
  return cached
}

/**
 * 是不是「库被别的连接锁着」
 *
 * better-sqlite3 报 `code: "SQLITE_BUSY"`，node:sqlite 报 `errcode: 5` 与 "database is locked"。
 * @param err 错误
 * @returns 是否锁冲突
 */
export function isSqliteBusy(err: unknown): boolean {
  const e = err as { code?: unknown; errcode?: unknown; message?: unknown } | null
  if (e === null || typeof e !== "object") return false
  if (e.code === "SQLITE_BUSY" || e.code === "SQLITE_LOCKED" || e.errcode === 5 || e.errcode === 6) return true
  return typeof e.message === "string" && /database is locked|database is busy/i.test(e.message)
}

/**
 * 取错误的第一行
 * @param err 错误
 * @returns 文本
 */
function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? ""
}

/**
 * 模块职责：存储检视层，供面板浏览与编辑 KV 及 SQLite
 * 依赖方向：依赖 store/kv（过期判定）、类型包；不依赖 HTTP
 * 生命周期：KV 检视器由 `openKv()` 创建，与驱动同寿；其余为纯函数
 * 注意事项：检视器不经命名空间直接读写驱动，仅供面板 API 使用，不进入 `AppView`，以免破坏插件间的前缀隔离。
 *
 *          memory / json 驱动按插入序扫描，故先收集全部键再排序分页；收集数量设上限，超出时标记截断。
 */
import type { KvDriver, SqlHandle, SqlParam, StoredEnvelope } from "@yunzai-ng/types"
import { isExpired } from "./kv.js"

/** 命名空间分隔符，与 `Kv` 一致 */
const SEP = ":"

/** 单次浏览最多扫多少个键 */
export const KV_SCAN_MAX = 50_000

/** 单页键数的缺省值与上限 */
const PAGE_DEFAULT = 100
const PAGE_MAX = 500

/** 预览文本的最大长度 */
const PREVIEW_MAX = 160

/** 携带 HTTP 状态码的存储错误，服务器按 `statusCode` 响应 */
export class StorageError extends Error {
  /** 错误名 */
  override readonly name = "StorageError"

  /**
   * @param statusCode 建议的 HTTP 状态码
   * @param message 面向使用者的说明
   */
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message)
  }
}

/* ────────────────────────────── KV ────────────────────────────── */

/** 值的大类 */
export type KvValueType = "string" | "number" | "boolean" | "null" | "array" | "object"

/** 浏览参数 */
export interface KvBrowseOptions {
  /** 只看这个前缀之下 */
  readonly prefix?: string
  /** 分页游标：上一页最后一个键 */
  readonly after?: string
  /** 每页键数 */
  readonly limit?: number
}

/** 前缀之下的一个子命名空间 */
export interface KvGroup {
  /** 名字，含结尾分隔符，如 `plugin:` */
  readonly name: string
  /** 其下未过期的键数 */
  readonly count: number
}

/** 列表里的一个键 */
export interface KvItem {
  /** 完整键 */
  readonly key: string
  /** 值的大类 */
  readonly type: KvValueType
  /** JSON 序列化后的字节数 */
  readonly size: number
  /** 截断的预览 */
  readonly preview: string
  /** 过期时间点；永不过期时不出现 */
  readonly expireAt?: number
}

/** 一页浏览结果 */
export interface KvPage {
  /** 本次的前缀 */
  readonly prefix: string
  /** 子命名空间，按名字排序 */
  readonly groups: readonly KvGroup[]
  /** 本页的键 */
  readonly items: readonly KvItem[]
  /** 直属于该前缀的键总数 */
  readonly total: number
  /** 下一页的游标；没有下一页时不出现 */
  readonly next?: string
  /** 是否因扫描上限而截断 */
  readonly truncated: boolean
}

/** 一个键的完整值 */
export interface KvEntryView {
  /** 完整键 */
  readonly key: string
  /** 值 */
  readonly value: unknown
  /** 过期时间点；永不过期时不出现 */
  readonly expireAt?: number
}

/** KV 检视器 */
export interface KvInspector {
  /** 实际生效的驱动 id */
  readonly driver: string

  /**
   * 浏览一个前缀
   * @param opts 参数
   * @returns 一页结果
   */
  browse(opts?: KvBrowseOptions): Promise<KvPage>

  /**
   * 读一个键
   * @param key 完整键
   * @returns 值；不存在或已过期时 undefined
   */
  read(key: string): Promise<KvEntryView | undefined>

  /**
   * 写一个键
   * @param key 完整键
   * @param value 值，须可 JSON 序列化
   * @param expireAt 过期时间点；省略即永不过期
   */
  write(key: string, value: unknown, expireAt?: number): Promise<void>

  /**
   * 删一个键
   * @param key 完整键
   * @returns 删除前是否存在
   */
  remove(key: string): Promise<boolean>

  /**
   * 删一个前缀之下的全部键
   * @param prefix 前缀，不可为空
   * @returns 删除的键数
   */
  removePrefix(prefix: string): Promise<number>
}

/**
 * 判断值的大类
 * @param value 值
 * @returns 大类
 */
function typeOf(value: unknown): KvValueType {
  if (value === null || value === undefined) return "null"
  if (Array.isArray(value)) return "array"
  const t = typeof value
  return t === "string" || t === "number" || t === "boolean" ? t : "object"
}

/**
 * 把一个信封摘成列表项
 * @param key 完整键
 * @param env 信封
 * @returns 列表项
 */
function itemOf(key: string, env: StoredEnvelope): KvItem {
  const json = JSON.stringify(env.v) ?? "null"
  const text = typeof env.v === "string" ? env.v : json
  return {
    key,
    type: typeOf(env.v),
    size: Buffer.byteLength(json),
    preview: text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX)}…` : text,
    ...(env.e === undefined ? {} : { expireAt: env.e })
  }
}

/**
 * 创建 KV 检视器
 * @param driver 已打开的驱动
 * @returns 检视器
 */
export function createKvInspector(driver: KvDriver): KvInspector {
  const alive = async (key: string): Promise<StoredEnvelope | undefined> => {
    const env = await driver.get(key)
    return env === undefined || isExpired(env) ? undefined : env
  }

  return {
    driver: driver.id,

    async browse(opts = {}): Promise<KvPage> {
      const prefix = opts.prefix ?? ""
      const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? PAGE_DEFAULT)), PAGE_MAX)
      const groups = new Map<string, number>()
      const leaves: string[] = []
      let scanned = 0
      let truncated = false

      for await (const [full, env] of driver.scan(prefix)) {
        if (isExpired(env)) continue
        if (scanned >= KV_SCAN_MAX) {
          truncated = true
          break
        }
        scanned++
        const rest = full.slice(prefix.length)
        const cut = rest.indexOf(SEP)
        if (cut < 0) leaves.push(full)
        else {
          const name = rest.slice(0, cut + 1)
          groups.set(name, (groups.get(name) ?? 0) + 1)
        }
      }

      leaves.sort()
      const after = opts.after
      const start = after === undefined ? 0 : leaves.findIndex(key => key > after)
      const page = start < 0 ? [] : leaves.slice(start, start + limit)

      const items: KvItem[] = []
      for (const key of page) {
        const env = await alive(key)
        if (env !== undefined) items.push(itemOf(key, env))
      }

      const more = start >= 0 && start + limit < leaves.length
      return {
        prefix,
        groups: [...groups.keys()].sort().map(name => ({ name, count: groups.get(name) ?? 0 })),
        items,
        total: leaves.length,
        ...(more && page.length > 0 ? { next: page[page.length - 1] } : {}),
        truncated
      }
    },

    async read(key: string): Promise<KvEntryView | undefined> {
      const env = await alive(key)
      if (env === undefined) return undefined
      return { key, value: env.v, ...(env.e === undefined ? {} : { expireAt: env.e }) }
    },

    async write(key: string, value: unknown, expireAt?: number): Promise<void> {
      if (key === "") throw new StorageError(400, "键不能为空")
      if (value === undefined) throw new StorageError(400, "值不能为空")
      await driver.set(key, expireAt === undefined ? { v: value } : { v: value, e: expireAt })
    },

    async remove(key: string): Promise<boolean> {
      if ((await alive(key)) === undefined) return false
      await driver.del(key)
      return true
    },

    async removePrefix(prefix: string): Promise<number> {
      // 空前缀即清空整库，不予支持
      if (prefix === "") throw new StorageError(400, "前缀不能为空")
      const keys: string[] = []
      for await (const [full] of driver.scan(prefix)) keys.push(full)
      if (keys.length === 0) return 0
      if (driver.batch) await driver.batch(keys.map(key => ({ op: "del" as const, key })))
      else for (const key of keys) await driver.del(key)
      return keys.length
    }
  }
}

/* ────────────────────────────── SQLite ────────────────────────────── */

/** 数据目录里的一个库 */
export interface SqlDatabaseInfo {
  /** 归属插件 */
  readonly plugin: string
  /** 库名 */
  readonly name: string
  /** 文件字节数（不含 WAL） */
  readonly size: number
  /** 当前是否已有连接 */
  readonly open: boolean
}

/** 表的一列 */
export interface SqlColumnInfo {
  /** 列名 */
  readonly name: string
  /** 声明类型 */
  readonly type: string
  /** 主键序号，非主键为 0 */
  readonly pk: number
  /** 是否 NOT NULL */
  readonly notnull: boolean
}

/** 库里的一张表或视图 */
export interface SqlTableInfo {
  /** 名字 */
  readonly name: string
  /** 表还是视图 */
  readonly type: "table" | "view"
  /** 是否带 rowid；面板按 rowid 改删行 */
  readonly rowid: boolean
  /** 列 */
  readonly columns: readonly SqlColumnInfo[]
}

/** 执行一条语句的选项 */
export interface SqlExecOptions {
  /** 最多返回多少行 */
  readonly limit: number
  /** 是否允许写；为假时写语句以 403 拒绝 */
  readonly allowWrite: boolean
}

/** 一条语句的执行结果 */
export interface SqlExecResult {
  /** 是否为只读语句 */
  readonly readonly: boolean
  /** 结果列；不返回行的语句不出现 */
  readonly columns?: readonly string[]
  /** 结果行；单元格见 `sqlCellOf` */
  readonly rows?: readonly (readonly unknown[])[]
  /** 是否因行数上限而截断 */
  readonly truncated?: boolean
  /** 受影响行数；返回行的语句不出现 */
  readonly changes?: number
  /** 最后插入的 rowid；超出安全整数时为字符串 */
  readonly lastInsertRowid?: number | string
  /** 耗时毫秒 */
  readonly cost: number
}

/** 二进制单元格的 JSON 形态 */
export interface SqlBlobCell {
  /** 字节数 */
  readonly $blob: number
  /** 前 32 字节的十六进制 */
  readonly head: string
}

/**
 * 面板拒绝执行的语句
 *
 * ATTACH 与 VACUUM INTO 可读写数据目录之外的文件；事务控制语句会使与插件共用的连接停留在未结束的事务中。
 */
const FORBIDDEN = /^(attach|detach|vacuum|begin|commit|end|rollback|savepoint|release)\b/i

/**
 * 去掉语句开头的空白与注释
 * @param sql SQL 文本
 * @returns 剩余文本
 */
function stripLeading(sql: string): string {
  let rest = sql
  for (;;) {
    rest = rest.trimStart()
    if (rest.startsWith("--")) {
      const end = rest.indexOf("\n")
      rest = end < 0 ? "" : rest.slice(end + 1)
    } else if (rest.startsWith("/*")) {
      const end = rest.indexOf("*/")
      rest = end < 0 ? "" : rest.slice(end + 2)
    } else return rest
  }
}

/**
 * 拦下面板不该执行的语句
 * @param sql SQL 文本
 * @returns 去掉开头注释后的语句
 * @throws StorageError 语句为空，或属于 ATTACH / DETACH / VACUUM / 事务控制
 */
export function guardStatement(sql: string): string {
  const head = stripLeading(sql)
  if (head === "") throw new StorageError(400, "SQL 为空")
  if (FORBIDDEN.test(head)) {
    throw new StorageError(400, "不支持 ATTACH、DETACH、VACUUM 及事务控制语句")
  }
  return head
}

/**
 * 把一个单元格转成可 JSON 序列化的形态
 * @param value 单元格
 * @returns 原值；二进制转为 `SqlBlobCell`，bigint 在安全整数范围内转为数字，否则转为字符串
 */
export function sqlCellOf(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { $blob: value.byteLength, head: Buffer.from(value.subarray(0, 32)).toString("hex") } satisfies SqlBlobCell
  }
  if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString()
  return value
}

/**
 * 列出库里的表与视图
 * @param handle 句柄
 * @returns 表清单，按名字排序
 */
export async function listSqlTables(handle: SqlHandle): Promise<SqlTableInfo[]> {
  const objects = await handle.all<{ name: string; type: "table" | "view"; sql: string | null }>(
    "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name"
  )
  const out: SqlTableInfo[] = []
  for (const obj of objects) {
    const columns = await handle.all<{ name: string; type: string; pk: number; notnull: number }>(
      'SELECT name, type, pk, "notnull" AS "notnull" FROM pragma_table_info(?)',
      [obj.name]
    )
    out.push({
      name: obj.name,
      type: obj.type,
      rowid: obj.type === "table" && !/without\s+rowid/i.test(obj.sql ?? ""),
      columns: columns.map(c => ({ name: c.name, type: c.type, pk: c.pk, notnull: c.notnull === 1 }))
    })
  }
  return out
}

/** 面板能绑定的参数：JSON 表达得出的那几种 */
export type SqlPanelParam = Extract<SqlParam, string | number | null>

/** 面板打开的一个库 */
export interface SqlInspectStore {
  /** 句柄，与插件共用同一连接 */
  readonly handle: SqlHandle

  /**
   * 执行一条面板语句
   * @param sql 单条 SQL
   * @param params 绑定参数
   * @param opts 选项
   * @returns 执行结果
   * @throws StorageError 语句被拦下、只读模式下写库，或 SQLite 报错时
   */
  exec(sql: string, params: readonly SqlPanelParam[], opts: SqlExecOptions): Promise<SqlExecResult>
}

/** 面板取 SQLite 库的来源 */
export interface SqlInspectSource {
  /** 配置是否启用 SQLite */
  readonly enabled: boolean

  /**
   * 列出数据目录里的库文件
   * @returns 库清单，按 `插件/库名` 排序
   */
  databases(): Promise<SqlDatabaseInfo[]>

  /**
   * 取一个已存在的库；与插件共用连接
   * @param plugin 归属插件
   * @param name 库名
   * @returns 库
   * @throws StorageError 名字不合法（400）或库文件不存在（404）时
   * @throws SubsystemUnavailableError SQLite 未启用或原生模块缺失时
   */
  store(plugin: string, name: string): Promise<SqlInspectStore>
}

/**
 * 模块职责：把 `store/sql.ts` 的 SQLite 能力接到插件上下文的 `SqlSink` 接缝上
 * 依赖方向：依赖 store/sql、plugin/hooks、类型包；不依赖任何插件
 * 生命周期：应用级单例，`closeAll()` 时关闭全部连接
 * 注意事项：连接的**归属**在这里确定 —— 每个插件的库落在 `<data>/sql/<插件名>/<库名>.db`，
 *          插件卸载时由上下文调用 `close(插件名)` 一次性关掉它开过的所有库。
 *          `SqlHandle` 上刻意没有 `close()`：句柄会被插件在模块间传递，
 *          谁都能关就意味着谁都可能在别人还在用时关掉。
 *
 *          `open()` 缓存的是**Promise 而不是结果**。两个模块在同一 tick 里
 *          `await ctx.sql("gacha")` 是常见写法，缓存结果的话两次都会 miss，
 *          于是同一个文件被打开两次 —— SQLite 允许，但两个连接各有一套
 *          语句缓存和 WAL 视图，写入会互相 SQLITE_BUSY。
 */
import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import type { Logger, SqlHandle } from "@yunzai-ng/types"
import { SubsystemUnavailableError, type SqlSink } from "../plugin/hooks.js"
import { StorageError, type SqlDatabaseInfo, type SqlInspectSource, type SqlInspectStore } from "../store/inspect.js"
import { openSql, type SqlStore } from "../store/sql.js"
import { errorCode } from "../util/fs.js"

/** 库名与插件名的合法形式：不含路径分隔符，避免写到目录外面去 */
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]*$/i

/** 创建 SQL 接缝的参数 */
export interface SqlSinkOptions {
  /** 存放 `.db` 文件的根目录（绝对路径） */
  dir: string
  /** 日志器 */
  logger: Logger
  /** 是否启用（对应配置 `store.sqlite`） */
  enabled: boolean
}

/**
 * 带生命周期管理的 SQL 接缝
 *
 * 同时实现面板的 `SqlInspectSource`：面板与插件共用同一连接表，避免同一文件上的两条连接相互 SQLITE_BUSY。
 */
export interface ManagedSqlSink extends SqlSink, SqlInspectSource {
  /** 当前打开的库数量 */
  readonly size: number

  /**
   * 列出已打开的库
   * @returns 形如 `["mhy-game/gacha"]` 的键数组，按字典序
   */
  list(): string[]

  /**
   * 关闭全部库
   * @returns 全部关闭后兑现
   */
  closeAll(): Promise<void>
}

/**
 * 校验一段名字能不能安全地当目录/文件名用
 * @param kind 名字用途，用于报错
 * @param value 待校验的名字
 * @throws 名字非法时
 */
function assertSafe(kind: string, value: string): void {
  if (!SAFE_NAME.test(value)) {
    throw new Error(`${kind} ${JSON.stringify(value)} 不合法：需以字母或数字开头，只含字母数字与 . - _`)
  }
}

/**
 * 创建 SQL 接缝
 *
 * 未启用或原生模块缺失时并不在此处报错，而是等到插件确实调用 `open()`：
 * 多数插件完全不使用 SQL，为其在启动期抛错等于将"可选依赖"变为必选。
 * @param opts 参数
 * @returns SQL 接缝
 */
export function createSqlSink(opts: SqlSinkOptions): ManagedSqlSink {
  const logger = opts.logger.child({ scope: "sql" })
  /** `插件名/库名` → 打开中或已打开的库 */
  const opened = new Map<string, Promise<SqlStore>>()

  /**
   * 关闭一个库并从表中摘除
   * @param key 缓存键
   * @param pending 打开中或已打开的库
   */
  const shut = async (key: string, pending: Promise<SqlStore>): Promise<void> => {
    opened.delete(key)
    try {
      // 必须 await：若对正在打开的库直接丢弃引用，连接会在无人持有的情况下
      // 泄漏于事件循环中，导致进程无法退出
      const store = await pending
      store.close()
    } catch (err) {
      // 对打开阶段即已失败的库，此处再次抛出并无意义
      logger.debug(`关闭 ${key} 时出错（打开阶段可能就已失败）`, err)
    }
  }

  /**
   * 取得一个库：已打开则复用，否则打开并登记
   * @param plugin 插件名（已校验）
   * @param name 库名（已校验）
   * @returns 已打开的库
   */
  const acquire = async (plugin: string, name: string): Promise<SqlStore> => {
    if (!opts.enabled) {
      throw new SubsystemUnavailableError("SQL", "配置项 store.sqlite 为 false，在 WebUI 里开启后重启即可")
    }

    const key = `${plugin}/${name}`
    const cached = opened.get(key)
    if (cached) return cached

    const pending = (async (): Promise<SqlStore> => {
      const file = join(opts.dir, plugin, `${name}.db`)
      const store = await openSql({ file })
      if (!store) {
        throw new SubsystemUnavailableError(
          "SQL",
          "可选依赖 better-sqlite3 不可用（Termux 等环境常编译失败）。" +
            "执行 pnpm rebuild better-sqlite3 重装，或让插件降级用 ctx.kv"
        )
      }
      logger.debug(`已打开 ${key} → ${store.file}`)
      return store
    })()

    opened.set(key, pending)
    try {
      return await pending
    } catch (err) {
      // 失败的 Promise 不留在表里：磁盘满、权限不对这类问题修好之后
      // 插件重载应该能重新打开，而不是一直拿到同一个陈旧的 rejection
      opened.delete(key)
      throw err
    }
  }

  return {
    get size(): number {
      return opened.size
    },

    get enabled(): boolean {
      return opts.enabled
    },

    list(): string[] {
      return [...opened.keys()].sort()
    },

    async open(plugin: string, name: string): Promise<SqlHandle> {
      assertSafe("插件名", plugin)
      assertSafe("库名", name)
      return (await acquire(plugin, name)).handle
    },

    async databases(): Promise<SqlDatabaseInfo[]> {
      const out: SqlDatabaseInfo[] = []
      let plugins: string[]
      try {
        plugins = (await readdir(opts.dir, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name)
      } catch (err) {
        if (errorCode(err) === "ENOENT") return []
        throw err
      }
      for (const plugin of plugins) {
        if (!SAFE_NAME.test(plugin)) continue
        const files = await readdir(join(opts.dir, plugin)).catch(() => [] as string[])
        for (const file of files) {
          if (!file.endsWith(".db")) continue
          const name = file.slice(0, -".db".length)
          if (!SAFE_NAME.test(name)) continue
          const size = await stat(join(opts.dir, plugin, file)).then(
            s => s.size,
            () => 0
          )
          out.push({ plugin, name, size, open: opened.has(`${plugin}/${name}`) })
        }
      }
      return out.sort((a, b) => {
        const ka = `${a.plugin}/${a.name}`
        const kb = `${b.plugin}/${b.name}`
        return ka < kb ? -1 : ka > kb ? 1 : 0
      })
    },

    async store(plugin: string, name: string): Promise<SqlInspectStore> {
      try {
        assertSafe("插件名", plugin)
        assertSafe("库名", name)
      } catch (err) {
        throw new StorageError(400, err instanceof Error ? err.message : String(err))
      }
      // 仅打开已存在的库：openSql 会为不存在的文件新建库
      if (!opened.has(`${plugin}/${name}`)) {
        const exists = await stat(join(opts.dir, plugin, `${name}.db`)).then(
          s => s.isFile(),
          () => false
        )
        if (!exists) throw new StorageError(404, `库 ${plugin}/${name} 不存在`)
      }
      return acquire(plugin, name)
    },

    async close(plugin: string): Promise<void> {
      const prefix = `${plugin}/`
      const jobs: Promise<void>[] = []
      for (const [key, pending] of opened) {
        if (key.startsWith(prefix)) jobs.push(shut(key, pending))
      }
      await Promise.all(jobs)
    },

    async closeAll(): Promise<void> {
      const jobs = [...opened].map(([key, pending]) => shut(key, pending))
      await Promise.all(jobs)
    }
  }
}

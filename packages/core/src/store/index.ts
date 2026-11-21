/**
 * 模块职责：KV 存储的装配（选绑定、迁移旧数据、根命名空间）
 * 依赖方向：依赖 store/{kv,memory,sqlite-kv,sqlite-binding,migrate,legacy,inspect}、类型包
 * 生命周期：应用级单例，`close()` 时落盘
 * 注意事项：**存储只归内核，插件不能注册或替换驱动。** 账号凭据与各插件的数据同在一个库里，
 *          交给插件提供的驱动就等于把全部数据交给那个插件。
 *
 *          **落盘格式只有一种：`<store>/kv.db`（SQLite）。** 文件跨平台通用，换机器、换系统直接拷；
 *          读写它的绑定可以不同（better-sqlite3 或 node:sqlite），格式不变。旧版的 LevelDB 与 JSON
 *          只读，首次启动时迁进 kv.db，原件改名保留。
 *
 *          **没有可用绑定时直接报错，不退到内存。** 退到内存意味着每次重启账号与插件数据全丢，
 *          而且没人会立刻发现。`memory` 只在配置里显式指定时用（测试、评测脚本）。
 */
import { join } from "node:path"
import type { KvDriver, KvNamespace, Logger } from "@yunzai-ng/types"
import { Kv } from "./kv.js"
import { MemoryKvDriver } from "./memory.js"
import { KV_DB_FILE, SqliteKvDriver } from "./sqlite-kv.js"
import { isSqliteBusy, loadSqliteBinding } from "./sqlite-binding.js"
import { migrateLegacy } from "./migrate.js"
import { findLegacy } from "./legacy.js"
import { createKvInspector, type KvInspector } from "./inspect.js"
import { isFile } from "../util/fs.js"

/** 驱动 id */
export type BuiltinDriverId = "sqlite" | "memory"

/** 旧配置里还会出现的驱动名，一律当 sqlite */
const LEGACY_DRIVER_IDS: ReadonlySet<string> = new Set(["auto", "level", "json"])

/** 打开 KV 存储的参数 */
export interface OpenKvOptions {
  /** 存储目录 */
  dir: string
  /** 驱动 id，缺省 `sqlite` */
  driver?: string
  /** 日志器 */
  logger: Logger
}

/** 已打开的 KV 存储 */
export interface KvStore {
  /** 实际生效的驱动 id */
  readonly driver: BuiltinDriverId
  /** SQLite 绑定名；memory 时 undefined */
  readonly engine: string | undefined
  /** 库文件；memory 时 undefined */
  readonly file: string | undefined
  /** 根命名空间 */
  readonly root: KvNamespace
  /**
   * 取一个子命名空间
   * @param name 命名空间名
   * @returns KV 视图
   */
  namespace(name: string): KvNamespace
  /** 不经命名空间的检视器，仅供面板 API 使用 */
  readonly inspector: KvInspector
  /** 关闭并落盘 */
  close(): Promise<void>
}

/**
 * 打开 KV 存储
 * @param opts 参数
 * @returns 已打开的 KV 存储
 * @throws 没有可用的 SQLite 绑定、旧数据迁移不了、库被别的进程占用，或驱动 id 不认识时
 */
export async function openKv(opts: OpenKvOptions): Promise<KvStore> {
  const logger = opts.logger.child({ scope: "store" })
  const id = normalizeDriver(opts.driver)

  if (id === "memory") {
    logger.warn("KV 存储使用内存驱动：重启即丢，只应出现在测试里")
    return assemble(new MemoryKvDriver(), id, undefined, undefined, logger)
  }

  const loaded = await loadSqliteBinding()
  const binding = loaded.binding
  if (binding === undefined) {
    throw new Error(
      `KV 存储需要 SQLite，而 better-sqlite3 与 node:sqlite 都不可用（${loaded.reason ?? "未知原因"}）。` +
        `在实例目录重新安装依赖让 better-sqlite3 装上，或换用 Node 22.13 及以上（自带 node:sqlite）`
    )
  }

  const file = join(opts.dir, KV_DB_FILE)
  if (!(await isFile(file))) {
    const report = await withLockRetry(() => migrateLegacy(opts.dir, binding, logger), opts.dir)
    if (report !== undefined) {
      logger.info(
        `已把旧版 KV（${report.from.kind}）的 ${report.entries} 条数据迁入 ${file}` +
          (report.archived === undefined ? "" : `，原数据改名保留为 ${report.archived}`)
      )
    }
  } else {
    for (const left of await findLegacy(opts.dir)) {
      logger.warn(`${left.path} 是旧版 KV 数据，而 ${KV_DB_FILE} 已在使用，它不会被读取。确认无用后可自行移走`)
    }
  }

  const driver = new SqliteKvDriver(file, binding)
  await withLockRetry(() => driver.open(), opts.dir)
  return assemble(driver, id, binding.engine, file, logger)
}

/**
 * 规整驱动 id
 * @param raw 配置里的值
 * @returns 驱动 id
 * @throws 不认识时
 */
function normalizeDriver(raw: string | undefined): BuiltinDriverId {
  if (raw === undefined || raw === "sqlite" || LEGACY_DRIVER_IDS.has(raw)) return "sqlite"
  if (raw === "memory") return "memory"
  throw new Error(`不认识的 KV 驱动 ${raw}：只有 sqlite / memory`)
}

/**
 * 包成对外的 KvStore
 * @param driver 已打开的驱动
 * @param id 驱动 id
 * @param engine 绑定名
 * @param file 库文件
 * @param logger 日志器
 * @returns KV 存储
 */
function assemble(driver: KvDriver, id: BuiltinDriverId, engine: string | undefined, file: string | undefined, logger: Logger): KvStore {
  logger.info(`KV 存储就绪：${engine === undefined ? id : `${file ?? ""}（${engine}）`}`)
  const root = new Kv(driver)
  return {
    driver: id,
    engine,
    file,
    root,
    namespace: (name: string) => root.sub(name),
    inspector: createKvInspector(driver, engine),
    close: () => driver.close()
  }
}

/** 库被锁时重试几次：守护拉起新进程时，旧进程可能还在退出途中 */
const LOCK_RETRIES = 5

/**
 * 是不是「库被另一个进程锁着」
 * @param err 错误
 * @returns 是否锁冲突
 */
function isLocked(err: unknown): boolean {
  const chain = [err, (err as { cause?: unknown } | null)?.cause]
  return chain.some(e => (e as { code?: unknown } | null)?.code === "LEVEL_LOCKED" || isSqliteBusy(e))
}

/**
 * 执行一个要独占存储的步骤，锁冲突时退避重试
 * @param task 步骤
 * @param dir 存储目录，用于报错
 * @returns 步骤的结果
 * @throws 重试用尽仍被占用时
 */
async function withLockRetry<T>(task: () => Promise<T>, dir: string): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await task()
    } catch (err) {
      if (!isLocked(err)) throw err
      if (attempt >= LOCK_RETRIES) {
        throw new Error(
          `KV 数据目录 ${dir} 被另一个进程占用（多半是上一个实例还没退干净，或两个实例指向同一主目录）。结束那个进程后再启动`,
          { cause: err }
        )
      }
      await new Promise(resolve => setTimeout(resolve, 300 * attempt))
    }
  }
}

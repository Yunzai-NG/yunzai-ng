/**
 * 模块职责：旧版 KV（LevelDB / JSON）→ kv.db 的一次性迁移，以及导出用的 kv.db 快照
 * 依赖方向：依赖 store/{legacy,sqlite-kv,sqlite-binding}、util/fs、类型包
 * 生命周期：启动时由 `openKv()` 调一次；导出时由 CLI 调一次
 * 注意事项：**先写临时文件、核对条数、再改名成 kv.db。** 迁移途中断电或被杀，留下的只是
 *          `kv.db.migrating`，下次启动删掉重来；不会出现一份半截的 kv.db 被当成迁移完成。
 *
 *          旧数据迁移后改名为 `kv.migrated-<时间>` / `kv.json.migrated-<时间>` 保留，不删。
 *
 *          导出快照**不改动源目录**：源是 kv.db 就 VACUUM INTO，源是旧格式就读出来写一份新的，
 *          旧数据原地不动 —— 导出是在别人机器上执行的只读操作。
 */
import { rename } from "node:fs/promises"
import { join } from "node:path"
import type { Logger, StoredEnvelope } from "@yunzai-ng/types"
import { isFile, remove } from "../util/fs.js"
import {
  LegacyCorruptError,
  archiveLegacy,
  findLegacy,
  withLegacySource,
  setAsideCorrupt,
  stampOf,
  type LegacyEntries,
  type LegacySource
} from "./legacy.js"
import { KV_DB_FILE, SqliteKvDriver } from "./sqlite-kv.js"
import type { SqliteBinding } from "./sqlite-binding.js"

/** 迁移途中的临时文件后缀 */
const MIGRATING_SUFFIX = ".migrating"

/** 迁移时每个事务写多少条 */
const BATCH = 500

/** 一次迁移的结果 */
export interface MigrationReport {
  /** 迁移的来源 */
  readonly from: LegacySource
  /** 写入的条数（不含已过期的） */
  readonly entries: number
  /** 旧数据封存到的路径；改名失败时 undefined */
  readonly archived: string | undefined
}

/**
 * 有旧数据而还没有 kv.db 时，把旧数据迁进 kv.db
 *
 * 两种旧数据并存时拒绝猜测来源。
 * @param dir 存储目录
 * @param binding SQLite 绑定
 * @param logger 日志器
 * @returns 迁移结果；没有旧数据时 undefined
 * @throws 旧数据读不出来（classic-level 不可用、库被占用）时，此时 kv.db 不会被创建
 */
export async function migrateLegacy(dir: string, binding: SqliteBinding, logger: Logger): Promise<MigrationReport | undefined> {
  const final = join(dir, KV_DB_FILE)
  const from = singleSource(await findLegacy(dir))
  if (from === undefined || await isFile(final)) return undefined
  const migrate = () => withLegacySource(from, async read => {
    if (await isFile(final)) return undefined
    const current = singleSource(await findLegacy(dir))
    if (current?.path !== from.path) throw new Error(`已选的旧版 KV 来源 ${from.path} 已变更，停止迁移`)
    const temp = `${final}${MIGRATING_SUFFIX}`
    await removeDb(temp)

    const target = new SqliteKvDriver(temp, binding)
    await target.open()
    let entries: number
    let corrupt = false
    try {
      try {
        entries = await copyInto(target, await read())
      } catch (err) {
        if (!(err instanceof LegacyCorruptError)) throw err
        // 与旧 JSON 驱动一致：坏文件挪开留证、从空库起步，存储坏了不该让机器人起不来
        corrupt = true
        entries = 0
      }
      const counted = target.count()
      if (counted !== entries) throw new Error(`迁移核对失败：写入 ${entries} 条，库里只有 ${counted} 条`)
    } catch (err) {
      await target.close()
      await removeDb(temp)
      throw err
    }
    await target.close()
    await rename(temp, final)

    let archived: string | undefined
    // 坏文件已被挪开时就没有可封存的了
    if ((await findLegacy(dir)).some(s => s.path === from.path)) {
      try {
        archived = corrupt ? await setAsideCorrupt(from.path) : await archiveLegacy(from, stampOf())
        if (corrupt) logger.warn(`旧版 KV 文件已损坏，挪到 ${archived}，从空库启动`)
      } catch (err) {
        logger.warn(`旧版 KV 数据已迁入 ${final}，但改名封存 ${from.path} 失败：${err instanceof Error ? err.message : String(err)}。可手动改名或移走`)
      }
    }
    return { from, entries, archived }
  })
  if (from.kind === "level") return migrate() // withLegacySource 已持有旧库的进程锁
  // 保留同一锁文件；删除后等待者可能锁住旧 inode。进程退出由 SQLite 自动解锁。
  const guard = binding.open(join(dir, ".kv-json-migration.lock"))
  try {
    guard.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE")
    return await migrate()
  } finally {
    guard.close()
  }
}

function singleSource(sources: readonly LegacySource[]): LegacySource | undefined {
  if (sources.length > 1) {
    throw new Error(`同时发现旧版 KV 来源 ${sources.map(s => s.path).join(" 和 ")}。请先停机并备份两份数据，确认要使用哪份，将另一份移出存储目录后重试`)
  }
  return sources[0]
}

/** 导出快照的结果 */
export interface SnapshotReport {
  /** 写入的条数 */
  readonly entries: number
  /** 快照来自哪里 */
  readonly source: "kv.db" | "level" | "json" | "empty"
}

/**
 * 把一个存储目录里的 KV 拷成一份独立的 kv.db
 * @param dir 源存储目录
 * @param out 目标文件，必须不存在
 * @param binding SQLite 绑定
 * @returns 结果
 * @throws 源被占用（实例还在跑）、旧数据读不出来或损坏时
 */
export async function snapshotKv(dir: string, out: string, binding: SqliteBinding): Promise<SnapshotReport> {
  const db = join(dir, KV_DB_FILE)
  const sources = await findLegacy(dir)
  if (await isFile(db)) {
    const source = new SqliteKvDriver(db, binding)
    await source.open()
    try {
      const entries = source.count()
      source.vacuumInto(out)
      return { entries, source: "kv.db" }
    } finally {
      await source.close()
    }
  }

  const from = singleSource(sources)
  const write = async (rows: LegacyEntries): Promise<SnapshotReport> => {
    const target = new SqliteKvDriver(out, binding)
    await target.open()
    try {
      return { entries: await copyInto(target, rows), source: from?.kind ?? "empty" }
    } finally {
      await target.close()
    }
  }
  return from === undefined ? write([]) : withLegacySource(from, async read => write(await read()))
}

/**
 * 逐批写入，跳过已过期的
 * @param target 已打开的目标库
 * @param entries 来源
 * @returns 写入条数
 */
async function copyInto(target: SqliteKvDriver, entries: LegacyEntries): Promise<number> {
  const now = Date.now()
  let pending: { op: "set"; key: string; value: StoredEnvelope }[] = []
  let written = 0
  for await (const [key, value] of entries) {
    if (value.e !== undefined && value.e <= now) continue
    pending.push({ op: "set", key, value })
    if (pending.length >= BATCH) {
      await target.batch(pending)
      written += pending.length
      pending = []
    }
  }
  if (pending.length > 0) {
    await target.batch(pending)
    written += pending.length
  }
  return written
}

/**
 * 删一个库文件及其 WAL 伴生文件
 * @param file 库文件
 */
async function removeDb(file: string): Promise<void> {
  await Promise.all(["", "-wal", "-shm", "-journal"].map(suffix => remove(`${file}${suffix}`)))
}

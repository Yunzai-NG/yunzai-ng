/**
 * 模块职责：旧版 KV 格式（LevelDB 目录 `kv/`、JSON 文件 `kv.json`）的识别、只读遍历与改名封存
 * 依赖方向：动态依赖可选原生模块 classic-level；依赖 util/fs、类型包
 * 生命周期：迁移与导出时用一次，用完即关
 * 注意事项：**只读不写**。这两种格式已不再作为存储使用，只在迁移进 kv.db 时打开一次。
 *
 *          认 LevelDB 看 `kv/CURRENT` 而不是目录存在：level 打开失败时会留下一个空的 `kv/`，
 *          按目录判断会把它当成「有数据」。
 *
 *          LevelDB 只有原生模块读得了：classic-level 装不上的机器（安卓多半如此）没法迁移，
 *          报错时指明「回原机器迁移或导出」。
 */
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, readFile, rename, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import type { StoredEnvelope } from "@yunzai-ng/types"
import { isFile, mtimeOf } from "../util/fs.js"

/** LevelDB 数据所在的子目录 */
export const LEGACY_LEVEL_DIR = "kv"

/** JSON 数据文件 */
export const LEGACY_JSON_FILE = "kv.json"

/** 旧 JSON 文件的格式版本 */
const JSON_FORMAT = 1

/** 旧格式 */
export type LegacyKind = "level" | "json"

/** 盘上的一份旧数据 */
export interface LegacySource {
  /** 格式 */
  readonly kind: LegacyKind
  /** 目录或文件的绝对路径 */
  readonly path: string
  /** 修改时间，仅供诊断，不用于选择迁移来源 */
  readonly mtime: number
}

/** classic-level 用到的最小面 */
interface LevelDb {
  open(): Promise<void>
  close(): Promise<void>
  iterator(): AsyncIterable<[string, StoredEnvelope]> & { close(): Promise<void> }
}

/** classic-level 的构造签名 */
type LevelCtor = new (location: string, opts: { valueEncoding: "json"; createIfMissing: false }) => LevelDb

/** 加载 classic-level 的方式；测试替换它来模拟「装不上」 */
export const legacyLoader = {
  /**
   * @returns 构造函数；不可用时附原因
   */
  async level(): Promise<{ ctor?: LevelCtor; reason?: string }> {
    try {
      const mod = (await import("classic-level")) as unknown as { ClassicLevel?: LevelCtor }
      return mod.ClassicLevel ? { ctor: mod.ClassicLevel } : { reason: "classic-level 没有导出 ClassicLevel" }
    } catch (err) {
      return { reason: err instanceof Error ? err.message.split("\n")[0] : String(err) }
    }
  }
}

/** 旧 JSON 文件坏了 */
export class LegacyCorruptError extends Error {
  /**
   * @param file 文件
   * @param cause 解析错误
   */
  constructor(
    readonly file: string,
    cause: unknown
  ) {
    super(`${file} 无法解析：${cause instanceof Error ? cause.message : String(cause)}`, { cause })
  }
}

/**
 * 列出目录里的旧数据，新的在前
 * @param dir 存储目录
 * @returns 旧数据；没有时空数组
 */
export async function findLegacy(dir: string): Promise<LegacySource[]> {
  const found: LegacySource[] = []
  const level = join(dir, LEGACY_LEVEL_DIR)
  if (await isFile(join(level, "CURRENT"))) found.push({ kind: "level", path: level, mtime: (await mtimeOf(level)) ?? 0 })
  const json = join(dir, LEGACY_JSON_FILE)
  if (await isFile(json)) found.push({ kind: "json", path: json, mtime: (await mtimeOf(json)) ?? 0 })
  return found.sort((a, b) => b.mtime - a.mtime)
}

type LegacyEntry = readonly [string, StoredEnvelope]
/** JSON 一次读入，LevelDB 逐条读取 */
export type LegacyEntries = Iterable<LegacyEntry> | AsyncIterable<LegacyEntry>

/** 在持锁的停机副本上执行操作；迁移发布与封存也在锁内完成。 */
export async function withLegacySource<T>(source: LegacySource, run: (read: () => Promise<LegacyEntries>) => Promise<T>): Promise<T> {
  if (source.kind === "json") return run(() => readJson(source.path))
  const loaded = await legacyLoader.level()
  if (loaded.ctor === undefined) {
    throw new Error(
      `${source.path} 是旧版 LevelDB 数据，读它需要原生模块 classic-level，而本机加载失败（${loaded.reason ?? "未知原因"}）。` +
        `回到原来那台机器上升级内核并启动一次（会自动迁移成 kv.db），或在那里执行 yzng data export，再把结果拿过来`
    )
  }
  const ctor = loaded.ctor
  return withLevelWorker(source.path, dirname(source.path), "copy", async work => {
    const copy = join(work, "copy")
    if (!/^MANIFEST-[0-9]+\n$/.test(await readFile(join(copy, "CURRENT"), "utf8"))) throw new Error(`${source.path}/CURRENT 无效`)
    return await run(() => Promise.resolve(readLevelCopy(copy, ctor)))
  })
}

/** 持有旧 LevelDB 的原生锁直到操作及其回滚结束；workParent 须同卷且不在待改名目录内。 */
export function withLegacyLevelLock<T>(path: string, workParent: string, run: () => Promise<T>): Promise<T> {
  return withLevelWorker(path, workParent, "lock", run)
}

async function withLevelWorker<T>(path: string, workParent: string, mode: "copy" | "lock", run: (work: string) => Promise<T>): Promise<T> {
  const worker = join(dirname(createRequire(import.meta.url).resolve("@yunzai-ng/core/package.json")), "src/store/legacy-copy.mjs")
  const work = await mkdtemp(join(workParent, ".kv-offline-"))
  try {
    const child = spawn(process.execPath, [worker, resolve(path), resolve(work), mode], { stdio: "pipe", windowsHide: true })
    const closed = once(child, "close")
    let reason = ""
    child.stderr.setEncoding("utf8").on("data", chunk => { reason += chunk })
    try {
      const ready = once(child.stdout, "data").then(([chunk]) => String(chunk) === "1")
      if (!(await Promise.race([ready, closed.then(() => false)]))) {
        const [code] = await closed
        if (code === 2) throw Object.assign(new Error(`${path} 被占用，请先停掉旧实例`), { code: "LEVEL_LOCKED" })
        throw new Error(`无法取得 ${path} 的停机锁：${reason.trim() || "锁进程异常退出"}`)
      }
      return await run(work)
    } finally {
      child.stdin.end()
      await closed
    }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

async function* readLevelCopy(path: string, ctor: LevelCtor): AsyncGenerator<LegacyEntry> {
  const db = new ctor(path, { valueEncoding: "json", createIfMissing: false })
  await db.open()
  try {
    for await (const entry of db.iterator()) yield entry
  } finally {
    await db.close()
  }
}

/**
 * 把一份旧数据改名封存，不删
 * @param source 旧数据
 * @param stamp 时间戳文本
 * @returns 新路径
 */
export async function archiveLegacy(source: LegacySource, stamp: string): Promise<string> {
  const target = `${source.path}.migrated-${stamp}`
  await rename(source.path, target)
  return target
}

/**
 * 把坏掉的旧 JSON 文件挪开留证
 * @param file 文件
 * @returns 新路径
 */
export async function setAsideCorrupt(file: string): Promise<string> {
  const target = `${file}.corrupt-${Date.now()}`
  await rename(file, target)
  return target
}

/**
 * 当前时间的文件名友好形式
 * @param now 时间
 * @returns 形如 20261025-142233
 */
export function stampOf(now = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0")
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
}

/**
 * 读旧 JSON 文件
 * @param file 文件
 * @returns 键值对迭代器
 * @throws 文件损坏或格式版本不符时
 */
async function readJson(file: string): Promise<LegacyEntry[]> {
  const text = await readFile(file, "utf8")
  if (text.trim() === "") return []
  let parsed: { format?: unknown; data?: unknown } | null
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new LegacyCorruptError(file, err)
  }
  if (typeof parsed?.format !== "number") throw new LegacyCorruptError(file, "结构不符")
  if (parsed.format !== JSON_FORMAT) {
    throw new Error(`${file} 的格式版本 ${parsed.format} 不受支持（当前仅支持 ${JSON_FORMAT}），请使用支持该版本的内核`)
  }
  if (parsed.data === null || typeof parsed.data !== "object") throw new LegacyCorruptError(file, "结构不符")
  return Object.entries(parsed.data as Record<string, StoredEnvelope>)
}

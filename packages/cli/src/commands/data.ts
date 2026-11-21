/**
 * 模块职责：`yzng data export / import` —— 把一个实例的配置与数据打包成可搬走的目录，或从那样的目录恢复
 * 依赖方向：依赖 @yunzai-ng/core 的路径、配置与存储公开入口
 * 生命周期：一次性
 * 注意事项：**导出是只读操作。** KV 不论原来是 kv.db 还是旧版 LevelDB / JSON，导出里都是一份新写的
 *          kv.db，源目录一个字节不动；插件的 SQL 库用 VACUUM INTO 拷成不带 WAL 的独立文件。
 *          实例还在跑时 kv.db 被独占，导出直接报错，不会拷出一份写到一半的数据。
 *
 *          导出成目录而不是压缩包：插件数据动辄几百 MB，打包要整份读进内存。要压缩就自己压。
 *
 *          **导入不覆盖。** 目标的 config/ 与 data/ 若已存在，先改名为 `*.before-import-<时间>` 保留；
 *          目标已经有 KV 数据时要加 `--force` 才继续。
 */
import { existsSync } from "node:fs"
import { copyFile, cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep, toNamespacedPath, win32 } from "node:path"
import process from "node:process"
import {
  CORE_CONFIG_NAME,
  KV_DB_FILE,
  KV_DB_FORMAT,
  SqliteKvDriver,
  coreConfigSchema,
  findLegacy,
  isSqliteBusy,
  loadSqliteBinding,
  parseYaml,
  resolvePaths,
  snapshotKv,
  stampOf,
  withLegacyLevelLock,
  type SqliteBinding,
  type SnapshotReport
} from "@yunzai-ng/core"
import { cyan, dim, print, printErr, red, yellow } from "../terminal.js"

/** 导出目录里的清单文件 */
export const MANIFEST_FILE = "yzng-export.json"

/** 清单格式版本 */
const MANIFEST_FORMAT = 1

/** 导出目录里的 KV 快照位置 */
const KV_IN_EXPORT = join("store", KV_DB_FILE)

/** 导出清单 */
export interface ExportManifest {
  /** 固定为 yzng-export，用来认出这是导出目录 */
  readonly kind: "yzng-export"
  /** 清单格式版本 */
  readonly format: number
  /** 导出时的 CLI 版本 */
  readonly version: string
  /** 导出时间（ISO） */
  readonly exportedAt: string
  /** 源机器的系统 */
  readonly platform: string
  /** 源实例的主目录，仅供参考 */
  readonly home: string
  /** KV 条数 */
  readonly kv: number
  /** KV 快照的来源 */
  readonly kvSource: SnapshotReport["source"]
  /** 插件 SQL 库个数 */
  readonly sql: number
}

/** 使用者可处置的失败：只打印文案，不打印栈 */
export class DataCommandError extends Error {}

/**
 * 读一份内核配置里的 store.dir
 *
 * 配置写错时直接报错而不是沿用缺省：缺省的存储目录可能根本不是使用者的那份数据。
 * @param configDir 配置目录
 * @returns 原值；未填时 undefined
 * @throws 配置语法或校验有误时
 */
async function storeDirSetting(configDir: string): Promise<string | undefined> {
  const file = join(configDir, `${CORE_CONFIG_NAME}.yaml`)
  const text = await readFile(file, "utf8").catch(() => undefined)
  if (text === undefined) return undefined
  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch (err) {
    throw new DataCommandError(`${file} 语法有误：${err instanceof Error ? err.message.split("\n")[0] : String(err)}。先跑 yzng doctor 修好它`)
  }
  const result = coreConfigSchema.safeParse(raw)
  if (!result.ok) throw new DataCommandError(`${file} 校验失败，先跑 yzng doctor 修好它`)
  const dir = result.value.store.dir
  return dir === undefined || dir === "" ? undefined : dir
}

/**
 * 按内核同样的规则求存储目录
 * @param home 主目录
 * @param data 数据目录
 * @param setting store.dir 的原值
 * @returns 绝对路径
 */
function storeDirOf(home: string, data: string, setting: string | undefined): string {
  if (setting === undefined) return join(data, "store")
  if ((process.platform !== "win32" && win32.isAbsolute(setting) && !isAbsolute(setting)) ||
      (process.platform === "win32" && /^\/(?!\/)/.test(setting))) {
    throw new DataCommandError(`store.dir 使用另一平台的绝对路径：${setting}。改为本机路径或清空后再试`)
  }
  return isAbsolute(setting) ? setting : resolve(home, setting)
}

/** Windows 的 fs.cp 过滤回调可能传长路径形式；两端同形再比较，涵盖盘符与 UNC。 */
function relativePath(from: string, to: string): string {
  return relative(toNamespacedPath(from), toNamespacedPath(to))
}

/**
 * inner 是否就是 outer 或在它里面
 * @param outer 外层目录
 * @param inner 待判断的路径
 * @returns 是否在内
 */
function within(outer: string, inner: string): boolean {
  const rel = relativePath(outer, inner)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * 取 SQLite 绑定
 * @returns 绑定
 * @throws 不可用时
 */
async function requireBinding(): Promise<SqliteBinding> {
  const loaded = await loadSqliteBinding()
  if (loaded.binding === undefined) {
    throw new DataCommandError(`没有可用的 SQLite（${loaded.reason ?? "未知原因"}）：装上 better-sqlite3，或换用 Node 22.13 及以上`)
  }
  return loaded.binding
}

/**
 * 是不是库被占着（实例还在跑）
 * @param err 错误
 * @returns 是否
 */
function isLocked(err: unknown): boolean {
  const chain = [err, (err as { cause?: unknown } | null)?.cause]
  return chain.some(e => isSqliteBusy(e) || (e as { code?: unknown } | null)?.code === "LEVEL_LOCKED")
}

/** 导出参数 */
export interface ExportOptions {
  /** 源实例主目录；缺省按 CLI 的规则探测 */
  readonly home?: string | undefined
  /** 输出目录，必须不存在或为空 */
  readonly out: string
  /** CLI 版本，写进清单 */
  readonly version: string
}

/**
 * 导出一个实例
 * @param opts 参数
 * @returns 清单
 * @throws 输出目录不可用、实例还在跑、数据读不出来时
 */
export async function exportInstance(opts: ExportOptions): Promise<ExportManifest> {
  const paths = resolvePaths({ home: opts.home })
  const out = resolve(opts.out)
  const existed = existsSync(out)
  if (existed && (await readdir(out)).length > 0) throw new DataCommandError(`${out} 已存在且不为空，换一个目录`)
  if (within(paths.data, out) || within(paths.config, out)) throw new DataCommandError(`${out} 在实例的 data/ 或 config/ 里，换一个目录`)

  const binding = await requireBinding()
  const storeDir = storeDirOf(paths.home, paths.data, await storeDirSetting(paths.config))
  const sqlDir = join(paths.data, "sql")

  await mkdir(join(out, "store"), { recursive: true })
  try {
    let kv: SnapshotReport
    try {
      kv = await snapshotKv(storeDir, join(out, KV_IN_EXPORT), binding)
    } catch (err) {
      if (isLocked(err)) throw new DataCommandError(`${storeDir} 正被使用：实例还在跑，先停掉它再导出`)
      throw err
    }

    if (existsSync(paths.config)) await cp(paths.config, join(out, "config"), { recursive: true })
    if (existsSync(paths.data)) {
      await cp(paths.data, join(out, "data"), {
        recursive: true,
        dereference: true,
        filter: src => {
          if (within(sqlDir, src)) return false
          if (relativePath(paths.data, storeDir) !== "") return !within(storeDir, src)
          const first = relativePath(storeDir, src).split(sep)[0] ?? ""
          return !/^(?:kv(?:\.json)?(?:$|\.migrated-|\.corrupt-)|kv\.db(?:$|[-.]))/.test(first)
        }
      })
    }
    const sql = await exportSql(sqlDir, join(out, "data", "sql"), binding)

    const manifest: ExportManifest = {
      kind: "yzng-export",
      format: MANIFEST_FORMAT,
      version: opts.version,
      exportedAt: new Date().toISOString(),
      platform: `${process.platform}/${process.arch}`,
      home: paths.home,
      kv: kv.entries,
      kvSource: kv.source,
      sql
    }
    await writeFile(join(out, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
    return manifest
  } catch (err) {
    // 只清理自己建的：输出目录原本存在（空目录）时只清空其内容
    if (existed) for (const name of await readdir(out)) await rm(join(out, name), { recursive: true, force: true })
    else await rm(out, { recursive: true, force: true })
    throw err
  }
}

/**
 * 把插件的 SQL 库逐个拷成独立文件
 * @param src `data/sql`
 * @param dest 导出里的 `data/sql`
 * @param binding SQLite 绑定
 * @returns 库个数
 */
async function exportSql(src: string, dest: string, binding: SqliteBinding): Promise<number> {
  if (!existsSync(src)) return 0
  let count = 0
  for (const plugin of await readdir(src, { withFileTypes: true })) {
    if (!plugin.isDirectory()) continue
    for (const file of await readdir(join(src, plugin.name))) {
      if (!file.endsWith(".db")) continue
      await mkdir(join(dest, plugin.name), { recursive: true })
      const db = binding.open(join(src, plugin.name, file))
      try {
        db.prepare("VACUUM INTO ?").run(join(dest, plugin.name, file))
      } catch (err) {
        if (isLocked(err)) throw new DataCommandError(`${join(src, plugin.name, file)} 正被使用：实例还在跑，先停掉它再导出`)
        throw err
      } finally {
        db.close()
      }
      count++
    }
  }
  return count
}

/** 导入参数 */
export interface ImportOptions {
  /** 导出目录 */
  readonly from: string
  /** 目标实例主目录；缺省按 CLI 的规则探测 */
  readonly home?: string | undefined
  /** 目标已有 KV 数据时仍继续 */
  readonly force: boolean
}

/** 导入结果 */
export interface ImportReport {
  /** 导出清单 */
  readonly manifest: ExportManifest
  /** 目标主目录 */
  readonly home: string
  /** 原有内容改名保留到了哪里 */
  readonly backups: readonly string[]
  /** 配置里像本机路径、而本机不存在的值 */
  readonly foreignPaths: readonly { file: string; line: number; value: string }[]
}

/**
 * 从导出目录恢复一个实例
 * @param opts 参数
 * @returns 结果
 * @throws 导出目录不对、目标实例还在跑、目标已有数据而未加 --force 时
 */
export async function importInstance(opts: ImportOptions): Promise<ImportReport> {
  const from = resolve(opts.from)
  const manifest = await readManifest(from)
  const scratch = await mkdtemp(join(tmpdir(), "yzng-import-"))
  try {
    const snapshot = join(scratch, KV_DB_FILE)
    await copyFile(join(from, KV_IN_EXPORT), snapshot)
    validateKvSnapshot(await requireBinding(), snapshot, manifest.kv)
    return await restoreInstance(opts, from, manifest, snapshot)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/** 只安装已经校验的同一份快照。 */
async function restoreInstance(opts: ImportOptions, from: string, manifest: ExportManifest, snapshot: string): Promise<ImportReport> {
  const paths = resolvePaths({ home: opts.home })

  const setting = await storeDirSetting(join(from, "config"))
  if (setting !== undefined && isAbsolute(setting) && !existsSync(setting)) {
    throw new DataCommandError(
      `导出的配置里 store.dir 是 ${setting}，本机没有这个目录。改掉 ${join(from, "config", `${CORE_CONFIG_NAME}.yaml`)} 里的这一项（留空即用 data/store）后再导入`
    )
  }
  const storeDir = storeDirOf(paths.home, paths.data, setting)

  const separate = !within(paths.data, storeDir)
  if (within(storeDir, paths.home) || within(storeDir, paths.config) || within(paths.config, storeDir)) {
    throw new DataCommandError("store.dir 不能与主目录或配置目录重叠")
  }
  const targets = [paths.config, paths.data, ...(separate ? [storeDir] : [])]
  if (targets.some(dir => within(from, dir) || within(dir, from))) {
    throw new DataCommandError("导出目录不能与待替换的目录重叠")
  }
  if (separate && existsSync(storeDir)) {
    const files = await readdir(storeDir)
    if (files.some(name => ![KV_DB_FILE, "kv", "kv.json", ...["-wal", "-shm", "-journal"].map(s => KV_DB_FILE + s)].includes(name))) {
      throw new DataCommandError(`外置存储目录含其他文件，拒绝整目录替换：${storeDir}。请先指定单独的存储目录`)
    }
  }
  const currentStore = storeDirOf(paths.home, paths.data, await storeDirSetting(paths.config))
  const dirs = [...new Set([currentStore, storeDir])]
  return withImportLocks(dirs, targets, async () => {
    for (const dir of dirs) {
      if ((await hasKvData(dir)) && !opts.force) {
        throw new DataCommandError(`${dir} 里已经有 KV 数据。确认要换成导出的那份就加 --force（原数据改名保留，不删）`)
      }
    }
    return installSnapshot(from, manifest, snapshot, paths, storeDir, targets, separate)
  })
}

/** 同时保护原配置与新配置指向的旧库，备份改名或回滚时锁随原文件保持有效。 */
async function withImportLocks<T>(dirs: string[], targets: string[], run: () => Promise<T>): Promise<T> {
  const locks = new Map<string, string>()
  for (const dir of dirs) {
    const source = (await findLegacy(dir)).find(s => s.kind === "level")
    if (!source) continue
    const path = await realpath(source.path)
    const outer = targets.find(target => within(target, dir))
    locks.set(path, dirname(outer ?? dir))
  }
  let next = run
  for (const [path, parent] of locks) {
    const inner = next
    next = () => withLegacyLevelLock(path, parent, inner).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException | null)?.code === "LEVEL_LOCKED") {
        throw new DataCommandError(`${path} 正被使用：目标实例还在跑，先停掉它再导入`)
      }
      throw err
    })
  }
  return next()
}

async function installSnapshot(from: string, manifest: ExportManifest, snapshot: string, paths: ReturnType<typeof resolvePaths>, storeDir: string, targets: string[], separate: boolean): Promise<ImportReport> {
  const stamp = stampOf()
  const parts: { dest: string; stage: string; backup?: string; installed: boolean }[] = []
  try {
    for (const dest of targets) {
      await mkdir(dirname(dest), { recursive: true })
      const stage = await mkdtemp(join(dirname(dest), `.${basename(dest)}.import-`))
      parts.push({ dest, stage, installed: false })
    }
    const config = parts[0]!.stage
    const data = parts[1]!.stage
    for (const [name, stage] of [["config", config], ["data", data]] as const) {
      const src = join(from, name)
      if (existsSync(src)) await cp(src, stage, { recursive: true, filter: async file => {
        if ((await lstat(file)).isSymbolicLink()) throw new DataCommandError(`导出目录中含符号链接，请先核实并替换为普通文件：${file}`)
        return true
      } })
    }
    const stagedStore = separate ? parts[2]!.stage : join(data, relativePath(paths.data, storeDir))
    await mkdir(stagedStore, { recursive: true })
    const leftovers = await readdir(stagedStore)
    if (leftovers.some(name => [KV_DB_FILE, `${KV_DB_FILE}-wal`, `${KV_DB_FILE}-shm`, `${KV_DB_FILE}-journal`].includes(name))) {
      throw new DataCommandError("插件数据中含重复的 KV 快照或日志，拒绝导入")
    }
    await copyFile(snapshot, join(stagedStore, KV_DB_FILE))
    await validateSqlCopies(join(data, "sql"), manifest.sql, await requireBinding())
    const foreignPaths = await scanForeignPaths(config)

    for (const part of parts) {
      const backup = `${part.dest}.before-import-${stamp}`
      if (existsSync(backup)) throw new DataCommandError(`备份路径已存在，不覆盖：${backup}`)
      if (existsSync(part.dest)) {
        const st = await lstat(part.dest)
        if (!st.isDirectory() || st.isSymbolicLink()) throw new DataCommandError(`目标不是普通目录：${part.dest}`)
        await rename(part.dest, backup)
        part.backup = backup
      }
      await rename(part.stage, part.dest)
      part.installed = true
    }
    return { manifest, home: paths.home, backups: parts.flatMap(part => part.backup ? [part.backup] : []), foreignPaths }
  } catch (err) {
    const failures: string[] = []
    for (const part of [...parts].reverse()) {
      try {
        if (part.installed) await rename(part.dest, part.stage)
        if (part.backup) await rename(part.backup, part.dest)
      } catch (rollbackError) {
        failures.push(`${part.dest}（原备份：${part.backup ?? "无"}）：${String(rollbackError)}`)
      }
    }
    const reason = err instanceof Error ? err.message : String(err)
    throw new DataCommandError(`导入失败：${reason}。${failures.length ? `请手动恢复：${failures.join("；")}` : "原目录未变或已还原"}`)
  } finally {
    for (const part of parts) await rm(part.stage, { recursive: true, force: true })
  }
}

/**
 * 读并核对导出清单
 * @param from 导出目录
 * @returns 清单
 * @throws 不是导出目录或版本不认识时
 */
async function readManifest(from: string): Promise<ExportManifest> {
  const file = join(from, MANIFEST_FILE)
  let manifest: ExportManifest
  try {
    manifest = JSON.parse(await readFile(file, "utf8")) as ExportManifest
  } catch {
    throw new DataCommandError(`${from} 不是 yzng data export 导出的目录（缺少 ${MANIFEST_FILE}）`)
  }
  if (!manifest || manifest.kind !== "yzng-export") throw new DataCommandError(`${file} 不是导出清单`)
  if (manifest.format > MANIFEST_FORMAT) throw new DataCommandError(`${from} 由更新版本的 CLI 导出（格式 ${manifest.format}），先升级 CLI`)
  if (manifest.format !== MANIFEST_FORMAT || !Number.isSafeInteger(manifest.kv) || manifest.kv < 0 || !Number.isSafeInteger(manifest.sql) || manifest.sql < 0) {
    throw new DataCommandError(`${file} 的清单格式或 KV 条数无效`)
  }
  if (!existsSync(join(from, KV_IN_EXPORT))) throw new DataCommandError(`${from} 里缺少 ${KV_IN_EXPORT}，导出不完整`)
  return manifest
}

/** 对即将换入的插件 SQL 副本逐库校验，再与清单数量对账。 */
async function validateSqlCopies(root: string, expected: number, binding: SqliteBinding): Promise<void> {
  let count = 0
  for (const dir of existsSync(root) ? await readdir(root, { withFileTypes: true }) : []) {
    if (!dir.isDirectory()) continue
    for (const file of await readdir(join(root, dir.name))) {
      if (!file.endsWith(".db")) continue
      const db = binding.open(join(root, dir.name, file), true)
      try {
        db.exec("PRAGMA trusted_schema = OFF")
        const row = db.prepare("PRAGMA integrity_check(1)").get() as { integrity_check?: string } | undefined
        if (row?.integrity_check !== "ok") throw new DataCommandError(`插件 SQL 库损坏：${dir.name}/${file}`)
      } finally { db.close() }
      count++
    }
  }
  if (count !== expected) throw new DataCommandError(`插件 SQL 库数量与清单不符：需要 ${expected} 个，读到 ${count} 个`)
}

/** 只读校验，不调用会为不完整的库建表的驱动 open()。 */
function validateKvSnapshot(binding: SqliteBinding, file: string, expected: number): void {
  try {
    const db = binding.open(file, true)
    try {
      db.exec("PRAGMA trusted_schema = OFF")
      const checked = db.prepare("PRAGMA integrity_check(1)").get() as { integrity_check: string } | undefined
      if (checked?.integrity_check !== "ok") throw new Error("SQLite 完整性检查失败")
      const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('meta', 'kv')").all()
      if (tables.length !== 2) throw new Error("缺少 KV 数据表或元信息表")
      const meta = db.prepare("SELECT value FROM meta WHERE key = 'format'").get() as { value: string } | undefined
      if (meta?.value !== String(KV_DB_FORMAT)) throw new Error("无法识别 KV 格式版本")
      db.prepare("SELECT k, v, e FROM kv LIMIT 0").get()
      const count = db.prepare("SELECT COUNT(*) AS n FROM kv").get() as { n: number | bigint }
      if (Number(count.n) !== expected) throw new Error("KV 条数与导出清单不符")
    } finally {
      db.close()
    }
  } catch (err) {
    throw new DataCommandError(`KV 快照校验失败，目标实例未改动：${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * 存储目录里是否已有 KV 数据
 * @param dir 存储目录
 * @returns 是否有
 * @throws 库被占用（目标实例在跑）时
 */
async function hasKvData(dir: string): Promise<boolean> {
  const file = join(dir, KV_DB_FILE)
  if (existsSync(file)) {
    const driver = new SqliteKvDriver(file, await requireBinding())
    try {
      await driver.open()
    } catch (err) {
      if (isLocked(err)) throw new DataCommandError(`${file} 正被使用：目标实例还在跑，先停掉它再导入`)
      throw err
    }
    try {
      if (driver.count() > 0) return true
    } finally {
      await driver.close()
    }
  }
  return (await findLegacy(dir)).length > 0
}

/** 配置行里像本机绝对路径的值：盘符路径，或至少两段的 POSIX 路径 */
const PATH_VALUE = /^\s*(?:-\s+|[\w.-]+:\s+)["']?((?:[A-Za-z]:[\\/]|\/[^/\s"']+\/)[^"'#]*?)["']?\s*(?:#.*)?$/

/**
 * 找出配置里指向本机不存在路径的值
 *
 * 只按文本扫：换了系统后最常见的就是 `D:\...` 一类的绝对路径，提示出来让使用者自己改。
 * @param configDir 配置目录
 * @returns 可疑的值
 */
async function scanForeignPaths(configDir: string): Promise<{ file: string; line: number; value: string }[]> {
  const found: { file: string; line: number; value: string }[] = []
  if (!existsSync(configDir)) return found
  for (const name of await readdir(configDir)) {
    if (!/\.ya?ml$/.test(name)) continue
    const lines = (await readFile(join(configDir, name), "utf8")).split(/\r?\n/)
    lines.forEach((text, i) => {
      const value = PATH_VALUE.exec(text)?.[1]?.trim()
      if (value !== undefined && value !== "" && !existsSync(value)) found.push({ file: name, line: i + 1, value })
    })
  }
  return found
}

/** `yzng data` 的参数 */
export interface DataCommandOptions {
  /** export / import */
  readonly sub: "export" | "import"
  /** 导出时为输出目录，导入时为导出目录 */
  readonly target: string
  /** 主目录 */
  readonly home?: string | undefined
  /** 仅 import */
  readonly force: boolean
  /** CLI 版本 */
  readonly version: string
}

/**
 * 执行 `yzng data`
 * @param opts 参数
 * @returns 退出码
 */
export async function runData(opts: DataCommandOptions): Promise<number> {
  try {
    if (opts.sub === "export") {
      const m = await exportInstance({ home: opts.home, out: opts.target, version: opts.version })
      const source = m.kvSource === "kv.db" ? "" : m.kvSource === "empty" ? "（没有 KV 数据）" : `（由旧版 ${m.kvSource} 转换）`
      print()
      print(`  已导出到 ${cyan(resolve(opts.target))}`)
      print(`  ${dim(`KV ${m.kv} 条${source}，插件 SQL 库 ${m.sql} 个`)}`)
      print(`  ${dim("到新机器上执行")} ${cyan(`yzng data import <这个目录>`)}`)
      print()
      return 0
    }

    const r = await importInstance({ from: opts.target, home: opts.home, force: opts.force })
    print()
    print(`  已导入到 ${cyan(r.home)}  ${dim(`导出于 ${r.manifest.exportedAt}，来自 ${r.manifest.platform}`)}`)
    for (const b of r.backups) print(`  ${dim(`原有内容改名保留为 ${b}`)}`)
    if (r.foreignPaths.length > 0) {
      print()
      print(`  ${yellow("这些配置像是原机器上的路径，本机不存在，请逐个改掉：")}`)
      for (const f of r.foreignPaths) print(`    ${cyan(`config/${f.file}:${f.line}`)}  ${f.value}`)
    }
    print()
    print(`  ${dim("下一步：")}${cyan("yzng start")}`)
    print()
    return 0
  } catch (err) {
    if (err instanceof DataCommandError) {
      printErr(red(err.message))
      return 1
    }
    throw err
  }
}

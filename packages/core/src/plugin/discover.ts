/**
 * 模块职责：发现磁盘上的插件、解析入口、规划加载顺序
 * 依赖方向：依赖 util/fs、类型包；不 import 任何插件
 * 生命周期：每次全量加载/热重载时调用
 * 注意事项：**顺序规划与文件发现分离**是这里的关键：先把候选文件找出来 → 全部 import
 *          拿到声明式元信息 → 用依赖图算出确定顺序 → 再按序 setup。加载顺序由声明的
 *          依赖决定，而非文件名字典序。
 *
 *          依赖缺失**不连坐内核**：只把依赖它的插件标记为跳过，其余照常工作。
 */
import { basename, isAbsolute, join, resolve } from "node:path"
import type { Logger } from "@yunzai-ng/types"
import { isDirectory, isFile, listDirs, listFiles, readJson } from "../util/fs.js"

/**
 * 本进程是否运行在 TypeScript 源码模式
 *
 * 通过"本模块自身是否 .ts"判断：vitest / tsx 下为真，编译产物下为假。
 * 为真时才把 `src/index.ts` 当作合法入口，否则一个没编译的插件会以
 * "Unknown file extension .ts" 这种毫无指向性的错误失败。
 */
const TS_RUNTIME = import.meta.url.endsWith(".ts")

/** 依次尝试的入口文件（相对插件目录） */
const ENTRY_CANDIDATES = ["dist/index.js", "index.js", "index.mjs", "lib/index.js"]

/** 单文件插件允许的扩展名 */
const SINGLE_FILE_EXT = [".js", ".mjs"]

/** package.json 里与本框架相关的字段 */
interface PackageManifest {
  /** npm 包名 */
  name?: string
  /** 版本 */
  version?: string
  /** 说明 */
  description?: string
  /** 作者，可能是字符串或对象 */
  author?: string | { name?: string }
  /** 主页 */
  homepage?: string
  /** 入口 */
  main?: string
  /** 模块入口 */
  module?: string
  /** exports 映射（只认 `"."`） */
  exports?: unknown
  /** 框架专属字段，用于不执行代码就能读到的信息 */
  yunzai?: {
    /** 覆盖插件名 */
    name?: string
    /** 是否禁用 */
    disabled?: boolean
    /** 入口文件 */
    entry?: string
  }
}

/** 一个待加载的插件候选 */
export interface PluginCandidate {
  /**
   * 名字线索（目录名或包名）
   *
   * 真正的插件名以 `definePlugin({ name })` 为准；这个只用于导入失败时的日志，
   * 因为那时候还读不到定义。
   */
  id: string
  /** 插件根目录绝对路径 */
  dir: string
  /** 入口文件绝对路径 */
  entry: string
  /** 是否为随发行版预置的插件 */
  builtin: boolean
  /** package.json 内容（若有） */
  manifest?: PackageManifest
}

/** 被跳过的插件及原因 */
export interface SkippedPlugin {
  /** 插件名 */
  name: string
  /** 跳过原因（直接展示给用户，必须能照着解决） */
  reason: string
}

/** 发现插件的参数 */
export interface DiscoverOptions {
  /** 要扫描的目录（绝对路径），按顺序扫描，先出现者优先 */
  dirs: string[]
  /** 其中属于"内置"的目录，用于给候选打 builtin 标记 */
  builtinDirs?: string[]
  /** 用户在配置里禁用的插件名 */
  disabled?: readonly string[]
  /** 日志器 */
  logger: Logger
}

/**
 * 解析 package.json 的入口字段
 *
 * 只认 `exports["."]` 的字符串形式与 `import`/`default` 条件；再复杂的条件导出
 * 交给 Node 自己解析（此时返回 undefined，由调用方回落到目录导入）。
 * @param manifest package.json 内容
 * @returns 相对路径；无法确定时 undefined
 */
function entryFromManifest(manifest: PackageManifest): string | undefined {
  if (manifest.yunzai?.entry) return manifest.yunzai.entry

  const exp = manifest.exports
  if (typeof exp === "string") return exp
  if (exp && typeof exp === "object") {
    const dot = (exp as Record<string, unknown>)["."]
    if (typeof dot === "string") return dot
    if (dot && typeof dot === "object") {
      const cond = dot as Record<string, unknown>
      for (const key of ["import", "module", "default"]) {
        const value = cond[key]
        if (typeof value === "string") return value
      }
    }
  }

  return manifest.module ?? manifest.main
}

/**
 * 在插件目录里找入口文件
 * @param dir 插件目录
 * @param manifest package.json 内容
 * @returns 入口绝对路径；找不到时 undefined
 */
async function resolveEntry(dir: string, manifest?: PackageManifest): Promise<string | undefined> {
  const declared = manifest ? entryFromManifest(manifest) : undefined
  if (declared) {
    const full = resolve(dir, declared)
    if (await isFile(full)) return full
  }

  const candidates = TS_RUNTIME ? [...ENTRY_CANDIDATES, "src/index.ts", "index.ts"] : ENTRY_CANDIDATES
  for (const rel of candidates) {
    const full = join(dir, rel)
    if (await isFile(full)) return full
  }
  return undefined
}

/**
 * 取插件名线索
 *
 * 优先 `yunzai.name`，其次去掉 scope 的包名，最后目录名。
 * @param dir 插件目录
 * @param manifest package.json 内容
 * @returns 名字线索
 */
function idOf(dir: string, manifest?: PackageManifest): string {
  const explicit = manifest?.yunzai?.name
  if (explicit) return explicit
  const pkg = manifest?.name
  if (pkg) return pkg.startsWith("@") ? (pkg.split("/")[1] ?? pkg) : pkg
  return basename(dir)
}

/**
 * 扫描一个目录下的全部插件
 * @param root 要扫描的目录
 * @param builtin 是否标记为内置
 * @param logger 日志器
 * @returns 候选数组
 */
async function scanDir(root: string, builtin: boolean, logger: Logger): Promise<PluginCandidate[]> {
  if (!(await isDirectory(root))) return []
  const out: PluginCandidate[] = []

  for (const name of await listDirs(root)) {
    // `.` 开头是隐藏目录，`_` 开头约定为"作者临时禁用"，node_modules 不用说
    if (name.startsWith(".") || name.startsWith("_") || name === "node_modules") continue

    const dir = join(root, name)
    const manifest = await readJson<PackageManifest>(join(dir, "package.json"))
    if (manifest?.yunzai?.disabled) {
      logger.debug(`插件目录 ${name} 在 package.json 里自我标记为 disabled，跳过`)
      continue
    }

    const entry = await resolveEntry(dir, manifest)
    if (!entry) {
      logger.warn(
        `插件目录 ${name} 里找不到入口文件：请提供 ${ENTRY_CANDIDATES.join(" / ")} 之一，` +
          `或在 package.json 的 main / yunzai.entry 里指明。若是 TypeScript 插件，请先编译`
      )
      continue
    }

    out.push({ id: idOf(dir, manifest), dir, entry, builtin, manifest })
  }

  // 顶层单文件插件：plugins/我的小功能.js。给"就想加个几十行小功能"的用户留的口子，
  // 不必为此建目录和 package.json
  for (const ext of SINGLE_FILE_EXT) {
    for (const file of await listFiles(root, ext)) {
      const name = basename(file, ext)
      if (name.startsWith(".") || name.startsWith("_")) continue
      out.push({ id: name, dir: root, entry: join(root, file), builtin })
    }
  }

  return out
}

/**
 * 发现全部插件
 *
 * 同名插件只保留先扫到的那份（目录顺序即优先级），并记一条警告 ——
 * 用户插件目录排在预置目录之前，因此复制一份预置插件加以修改即可覆盖原插件。
 * @param opts 参数
 * @returns 候选数组
 */
export async function discoverPlugins(opts: DiscoverOptions): Promise<PluginCandidate[]> {
  const builtin = new Set((opts.builtinDirs ?? []).map(dir => resolve(dir)))
  const disabled = new Set(opts.disabled ?? [])
  const seen = new Map<string, PluginCandidate>()

  for (const raw of opts.dirs) {
    if (!isAbsolute(raw)) {
      opts.logger.warn(`插件目录 ${raw} 不是绝对路径，已忽略（相对路径会随启动方式变化）`)
      continue
    }
    const dir = resolve(raw)
    for (const candidate of await scanDir(dir, builtin.has(dir), opts.logger)) {
      if (disabled.has(candidate.id)) {
        opts.logger.info(`插件 ${candidate.id} 已被用户禁用，跳过`)
        continue
      }
      const exists = seen.get(candidate.id)
      if (exists) {
        opts.logger.warn(`发现同名插件 ${candidate.id}：使用 ${exists.dir}，忽略 ${candidate.dir}`)
        continue
      }
      seen.set(candidate.id, candidate)
    }
  }

  return [...seen.values()]
}

/** 参与排序所需的最小信息 */
export interface OrderableUnit {
  /** 插件名 */
  name: string
  /** 依赖的插件名 */
  dependencies?: string[]
  /** 优先级，小者先加载 */
  priority?: number
}

/** 排序结果 */
export interface LoadOrder<T extends OrderableUnit> {
  /** 可加载的插件，已按依赖与优先级排好 */
  order: T[]
  /** 被跳过的插件 */
  skipped: SkippedPlugin[]
}

/** 默认加载优先级 */
const DEFAULT_PRIORITY = 100

/**
 * 规划加载顺序
 *
 * 三步：去重 → 剔除依赖不可满足者（级联）→ 拓扑排序。
 *
 * 排序在同层节点之间以 `(priority, name)` 作**确定性**排序：
 * 同一份插件集合在任何机器上都得到相同顺序，否则"甲机器正常、乙机器异常"
 * 这类问题会耗费大量排障时间。
 * @param units 待排序的插件定义
 * @returns 顺序与跳过列表
 */
export function resolveLoadOrder<T extends OrderableUnit>(units: readonly T[]): LoadOrder<T> {
  const skipped: SkippedPlugin[] = []
  const byName = new Map<string, T>()

  for (const unit of units) {
    if (byName.has(unit.name)) {
      skipped.push({ name: unit.name, reason: `插件名 ${unit.name} 重复，只加载第一个` })
      continue
    }
    byName.set(unit.name, unit)
  }

  // 级联剔除：A 依赖 B，B 因缺依赖被剔除，A 也留不住
  let changed = true
  while (changed) {
    changed = false
    for (const [name, unit] of byName) {
      const missing = (unit.dependencies ?? []).filter(dep => !byName.has(dep))
      if (missing.length === 0) continue
      byName.delete(name)
      skipped.push({
        name,
        reason: `依赖的插件未安装或已被跳过：${missing.join("、")}。装上它们或删掉本插件的依赖声明`
      })
      changed = true
    }
  }

  /** 同层排序：优先级小者先，其次名字字典序 */
  const compare = (a: T, b: T): number => {
    const pa = a.priority ?? DEFAULT_PRIORITY
    const pb = b.priority ?? DEFAULT_PRIORITY
    return pa !== pb ? pa - pb : a.name.localeCompare(b.name)
  }

  // Kahn：indegree 为"还有几个依赖没就绪"
  const indegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const [name, unit] of byName) {
    const deps = (unit.dependencies ?? []).filter(dep => byName.has(dep))
    indegree.set(name, deps.length)
    for (const dep of deps) {
      const list = dependents.get(dep)
      if (list) list.push(name)
      else dependents.set(dep, [name])
    }
  }

  const ready = [...byName.values()].filter(unit => indegree.get(unit.name) === 0).sort(compare)
  const order: T[] = []

  while (ready.length > 0) {
    const unit = ready.shift()!
    order.push(unit)
    for (const name of dependents.get(unit.name) ?? []) {
      const left = (indegree.get(name) ?? 0) - 1
      indegree.set(name, left)
      if (left !== 0) continue
      const next = byName.get(name)
      if (!next) continue
      // 插进有序位置，保持"每次取出的都是当前可加载里最该先加载的那个"
      const at = ready.findIndex(item => compare(item, next) > 0)
      if (at < 0) ready.push(next)
      else ready.splice(at, 0, next)
    }
  }

  if (order.length !== byName.size) {
    const loop = [...byName.keys()].filter(name => (indegree.get(name) ?? 0) > 0).sort()
    for (const name of loop) {
      skipped.push({ name, reason: `插件依赖成环，无法确定加载顺序：${loop.join(" → ")}` })
    }
  }

  return { order, skipped }
}

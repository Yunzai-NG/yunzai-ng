/**
 * 模块职责：插件市场 —— 索引获取与缓存、插件安装、卸载与更新
 * 依赖方向：依赖 http 客户端契约、logger 契约、`plugin/tar.ts` 与 `util/fs`；
 *          不认识插件宿主，也不认识面板 —— 安装完成后由调用方决定何时加载
 * 生命周期：随应用装配创建一次，索引缓存驻留内存并落盘一份，随应用停机一同丢弃
 * 注意事项：改本文件前须保住四条与安全相关的约定：
 *          1) 写入范围限定在插件目录之内 —— 插件名先过白名单校验，再经 `joinWithin` 求值
 *          2) 先下载到临时目录，校验通过后才移入插件目录，故中途失败不会留下半个插件
 *          3) 跑包管理器要由调用方逐次明说（`opts.dependencies`），本模块不擅自决定
 *          4) 索引为不可信输入，逐字段校验类型，缺字段的条目整条丢弃而非补默认值；
 *             `setup.scripts` 里的名字要拼进命令行，另有一道白名单，见 `pm.ts`
 */
import { execFile } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { HttpClient, Logger } from "@yunzai-ng/types"
import { isDirectory, isFile } from "../util/fs.js"
import { INSTALL_TIMEOUT_MS, SCRIPT_TIMEOUT_MS, isScriptName, runPm, type PmRunner } from "./pm.js"
import { extractTarGz, joinWithin, singleRoot } from "./tar.js"

/** 合法插件名：字母或数字开头，其余可含字母、数字、点、下划线与连字符 */
const NAME_RE = /^[a-z\d][a-z\d._-]*$/i

/** 安装归档的体积上限 */
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024

/**
 * 克隆与下载的超时毫秒
 *
 * 与索引请求分开取值：索引是一份几十 KB 的 JSON，超时设短便于尽快切换到下一个源；
 * 而一次插件传输可达数十 MB，在窄带链路上按索引超时衡量会把正常的下载判为失败。
 */
const TRANSFER_TIMEOUT_MS = 5 * 60 * 1000

/** 只读本地仓库的 git 命令超时毫秒；不含网络往返，故与传输超时分开取值 */
const GIT_LOCAL_TIMEOUT_MS = 10_000


/** 判定"看起来是一个插件"时接受的入口文件 */
const ENTRY_FILES: readonly string[] = ["index.js", "index.mjs", "index.cjs", "dist/index.js", "dist/index.mjs"]

/** 应用镜像前缀的主机白名单 */
const MIRRORED_HOSTS: readonly string[] = ["github.com", "raw.githubusercontent.com", "codeload.github.com"]

/** 安装来源 */
export interface MarketInstallSpec {
  /** 取源方式 */
  readonly type: "git" | "tarball"
  /** 仓库地址或归档地址 */
  readonly url: string
  /** git 分支，缺省由远端决定 */
  readonly branch?: string
}

/**
 * 装后步骤：装完依赖之后还要跑哪些 npm script
 *
 * 由索引声明而非读插件的 package.json —— 索引是经审核的那一份事实。名字要拼进命令行，
 * 逐个过 `pm.ts` 的白名单；不合法的整条 `setup` 丢弃，不做过滤后继续。
 */
export interface MarketSetupSpec {
  /** 依次要跑的 script 名；顺序即依赖关系，按序执行、一个失败即停 */
  readonly scripts: readonly string[]
  /**
   * 装依赖时是否连 devDependencies 一起装，缺省为真
   *
   * 要靠 `build` 出产物的插件必须为真：编译器在 devDependencies 里。
   */
  readonly dev: boolean
}

/** 索引中的一个插件条目 */
export interface MarketEntry {
  /** 插件名，同时是安装目录名与配置文件名 */
  readonly name: string
  /** 展示标题 */
  readonly title: string
  /** 一句话说明 */
  readonly description: string
  /** 作者 */
  readonly author?: string
  /** 索引声明的版本 */
  readonly version?: string
  /** 项目主页 */
  readonly homepage?: string
  /** 分类标签 */
  readonly tags: readonly string[]
  /** 是否为官方维护 */
  readonly official: boolean
  /** 要求的最低内核版本 */
  readonly minCore?: string
  /** 安装来源 */
  readonly install: MarketInstallSpec
  /**
   * 装后步骤，缺省即「装完依赖就算完」
   *
   * 声明在索引里而非插件的 package.json 里：面板要在取到内容之前就说清这次会跑什么。
   */
  readonly setup?: MarketSetupSpec
  /** 该条目来自哪个索引地址 */
  readonly source: string
}

/** 附带本地安装状态的条目 */
export interface MarketListing extends MarketEntry {
  /** 插件目录下是否已存在同名目录 */
  readonly installed: boolean
  /** 已装那份的版本，取自安装目录的 `package.json`；读不到时本字段不出现，不补 `0.0.0` */
  readonly installedVersion?: string
  /** 索引声明的版本是否高于已装那份；两侧任一读不到版本时恒为假 */
  readonly updatable: boolean
}

/** 一次索引获取的结果 */
export interface MarketSourceResult {
  /** 索引地址 */
  readonly url: string
  /** 是否取到并解析成功 */
  readonly ok: boolean
  /** 失败原因 */
  readonly error?: string
  /** 该索引贡献的条目数 */
  readonly count: number
}

/** 索引快照 */
export interface MarketSnapshot {
  /** 获取时间戳 */
  readonly fetchedAt: number
  /** 是否来自缓存而非本次网络请求 */
  readonly cached: boolean
  /** 逐个索引的获取结果 */
  readonly sources: readonly MarketSourceResult[]
  /** 合并去重后的条目，按名称排序 */
  readonly plugins: readonly MarketListing[]
}

/**
 * 一次安装的取源方式
 *
 * `pull` 是更新独有的一种：目录已是 git 仓库，就地拉取而非重新下载，故保住了
 * `node_modules` 与目录内的其他文件。
 */
export type InstallVia = MarketInstallSpec["type"] | "pull"

/**
 * 一次「装依赖 + 跑装后步骤」的结果
 *
 * 与安装结果分开成型，因为这一步可以单独发起（面板的「装依赖并编译」）。
 */
export interface SetupOutcome {
  /** 是否声明了运行时依赖且尚未安装 */
  readonly needsDependencies: boolean
  /** 本次是否确实跑了包管理器装依赖；与 `needsDependencies` 分别表示「刚才做了什么」与「还缺不缺」 */
  readonly installedDeps?: boolean
  /** 用的是哪个包管理器，仅在确实装过或跑过 script 时存在 */
  readonly packageManager?: string
  /** 装依赖失败的原因。装依赖失败不让整次安装失败，故记在这里由面板说明 */
  readonly dependencyError?: string
  /** 实际跑完的装后 script，按执行顺序 */
  readonly ranScripts?: readonly string[]
  /** 装后步骤失败的原因，附带失败在哪个 script 上。与 `dependencyError` 分开：两者的后手不同 */
  readonly setupError?: string
}

/** 单独发起一次装依赖与装后步骤的结果 */
export interface PluginSetupResult extends SetupOutcome {
  /** 插件名 */
  readonly name: string
  /** 插件目录 */
  readonly dir: string
  /** package.json 里声明的版本，读不到时 `0.0.0` */
  readonly version: string
}

/** 一次安装的结果 */
export interface InstallResult extends SetupOutcome {
  /** 插件名 */
  readonly name: string
  /** 安装目录 */
  readonly dir: string
  /** 取源方式 */
  readonly via: InstallVia
  /** package.json 中声明的版本；无 package.json 时为索引声明的版本 */
  readonly version: string
  /** 就地拉取时的旧版本号，仅 `via` 为 `pull` 时存在，供面板显示「1.0.0 → 1.1.0」 */
  readonly fromVersion?: string
  /** 就地拉取时是否确实有新提交，`false` 表示已是最新 */
  readonly changed?: boolean
  /**
   * 此后的更新会走哪条路
   *
   * 由 `via` 纯推导：留下 `.git` 的可 `fetch` + `reset`，保住包目录里的 `node_modules`；
   * 归档装出来的没有 `.git`，每次更新都是整目录重下重装。
   */
  readonly updatable: "pull" | "reinstall"
  /** 本次是否暂存过本地改动，仅暂存了才出现；面板据此提示可 `git stash pop` 取回 */
  readonly stashed?: boolean
  /**
   * 本次是否按调用方的选择丢弃了本地改动，仅丢弃了才出现
   *
   * 与 {@link stashed} 互斥，且必须分开报：这一路没有任何可取回的东西。
   */
  readonly discarded?: boolean
}

/**
 * 一次更新前的探测结果
 *
 * 供面板在动手之前问清「要不要暂存」，否则它只能先发一次注定失败的更新再靠错误文本反推。
 */
export interface UpdateProbe {
  /** 这次更新会不会走就地拉取。为假即整目录重装那条路，那条路不碰 git */
  readonly willPull: boolean
  /** 目录里有没有未提交的改动（含未跟踪文件）。`willPull` 为假时恒为假 */
  readonly dirty: boolean
}

/**
 * 撞上本地改动时怎么办
 *
 * - `abort`：原地中止，目录停在原样（缺省，也是唯一不动磁盘的一个）
 * - `stash`：`stash push --include-untracked` 之后再更新，可 `git stash pop` 取回
 * - `discard`：丢掉改动直接更新，不可撤销
 *
 * 缺省取 `abort` 而非 `stash`：本项由面板的一次提问填，提问没答之前不该有任何磁盘动作。
 */
export type DirtyAction = "abort" | "stash" | "discard"

/** 市场行为的可配置项，由内核配置提供 */
export interface MarketSettings {
  /** 索引地址列表，靠前者优先 */
  readonly sources: readonly string[]
  /** 镜像前缀，为空表示直连 */
  readonly mirror: string
  /** 索引缓存生存期毫秒 */
  readonly cacheTtl: number
  /** 单次网络请求超时毫秒 */
  readonly timeout: number
}

/**
 * 执行一次 git 命令的函数形态
 *
 * 抽成类型是为了让测试替换它，逐条钉住实际下发的命令序列 —— `stash` 必须先于
 * `reset --hard`，次序反了就是数据丢失，而真网络测不出这一点。
 * @param args 命令参数
 * @param cwd 工作目录
 * @param timeout 超时毫秒
 * @returns 标准输出
 */
export type GitRunner = (args: readonly string[], cwd: string, timeout: number) => Promise<string>

/** 构造插件市场所需的依赖 */
export interface MarketDeps {
  /** HTTP 客户端 */
  readonly http: HttpClient
  /** 日志器 */
  readonly logger: Logger
  /** 插件安装目录 */
  readonly pluginsDir: string
  /** 临时目录，下载与解包在此完成 */
  readonly tempDir: string
  /** 索引缓存文件路径 */
  readonly cacheFile: string
  /** 读取当前配置 */
  readonly settings: () => MarketSettings
  /** 当前内核版本，用于 `minCore` 判定 */
  readonly coreVersion: string
  /** 执行 git 命令，缺省调用本机的 git */
  readonly git?: GitRunner
  /** 执行包管理器，缺省调用本机的 pnpm / npm，见 `pm.ts` */
  readonly pm?: PmRunner
}

/**
 * 校验插件名
 *
 * 白名单而非黑名单：路径越界校验能挡住 `../`，但挡不住 `.git`、`node_modules`
 * 这类落在目录之内却会破坏运行环境的名称。
 * @param name 待校验的名称
 * @returns 名称本身
 * @throws 名称为空、含非法字符或为保留名时
 */
export function assertPluginName(name: string): string {
  if (!NAME_RE.test(name)) throw new Error(`插件名不合法：${name}`)
  if (name === "node_modules" || name.startsWith(".")) throw new Error(`插件名为保留名：${name}`)
  return name
}

/**
 * 比较两个版本号
 *
 * 仅比较点分数值段，忽略预发布标识。内核版本与 `minCore` 都由本项目自己产出，
 * 不需要完整的 semver 语义，引入依赖的收益低于其体积。
 * @param a 左操作数
 * @param b 右操作数
 * @returns a 大于 b 时为正，小于时为负，相等时为零
 */
export function compareVersion(a: string, b: string): number {
  const left = a.split("-")[0]?.split(".") ?? []
  const right = b.split("-")[0]?.split(".") ?? []
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = Number.parseInt(left[i] ?? "0", 10) || 0
    const y = Number.parseInt(right[i] ?? "0", 10) || 0
    if (x !== y) return x - y
  }
  return 0
}

/**
 * 对白名单主机的地址应用镜像前缀
 *
 * 只处理白名单内的主机：镜像站点通常只代理 GitHub，把任意地址都套上前缀会让
 * 自建源无法访问，且更难排查 —— 用户看到的会是镜像站的 404 而不是自己的地址写错。
 * @param url 原始地址
 * @param mirror 镜像前缀，空串表示直连
 * @returns 应用镜像后的地址
 */
export function applyMirror(url: string, mirror: string): string {
  const prefix = mirror.trim().replace(/\/+$/, "")
  if (prefix === "") return url
  let host: string
  try {
    host = new URL(url).host
  } catch {
    return url
  }
  if (!MIRRORED_HOSTS.includes(host)) return url
  return `${prefix}/${url}`
}

/**
 * 把 git 仓库地址换算为 codeload 归档地址
 *
 * git 不可用时的退路。仅识别 GitHub：其归档地址可由仓库地址推导，而通用的
 * git 服务端不存在统一的归档端点，推断得出的地址仅会导致一次无谓的失败请求。
 * @param url 仓库地址
 * @param branch 分支名，缺省取 HEAD
 * @returns 归档地址；无法推导时 undefined
 */
export function tarballFromGit(url: string, branch = "HEAD"): string | undefined {
  const match = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url)
  if (!match) return undefined
  return `https://codeload.github.com/${match[1]}/${match[2]}/tar.gz/${branch}`
}

/**
 * 取一个字符串字段
 * @param raw 记录
 * @param key 字段名
 * @returns 去除首尾空白后的值；类型不符或为空时 undefined
 */
function text(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key]
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

/**
 * 解析安装来源
 * @param raw 条目中的 `install` 字段
 * @returns 安装来源；字段缺失或类型不符时 undefined
 */
function parseInstall(raw: unknown): MarketInstallSpec | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const type = text(record, "type")
  const url = text(record, "url")
  if (url === undefined) return undefined
  if (!/^https?:\/\//.test(url)) return undefined
  if (type !== "git" && type !== "tarball") return undefined
  const branch = text(record, "branch")
  return { type, url, ...(branch === undefined ? {} : { branch }) }
}

/**
 * 解析装后步骤
 *
 * 一个 script 名不合法即整条丢弃，不做过滤后继续 —— 过滤会得到一份跑了一半的装后步骤。
 * `scripts` 为空数组同样返回 undefined。
 * @param raw 条目中的 `setup` 字段
 * @param name 插件名，仅用于告警
 * @param logger 日志器，用于说明为何丢弃
 * @returns 装后步骤；字段缺失或不合法时 undefined
 */
function parseSetup(raw: unknown, name: string, logger?: Logger): MarketSetupSpec | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const record = raw as Record<string, unknown>
  if (!Array.isArray(record.scripts)) return undefined
  const scripts: string[] = []
  for (const item of record.scripts) {
    if (typeof item !== "string" || !isScriptName(item)) {
      logger?.warn(`插件 ${name} 的索引里 setup.scripts 含不合法的 script 名，已忽略整个装后步骤`)
      return undefined
    }
    scripts.push(item)
  }
  if (scripts.length === 0) return undefined
  // 缺省连 devDependencies 一起装：声明了装后步骤就意味着有东西要跑，而那多半要编译器
  return { scripts, dev: record.dev !== false }
}

/**
 * 把一条索引记录解析为条目
 *
 * 任一必填字段不合法即返回 undefined，由调用方整条丢弃。
 * @param raw 索引记录
 * @param source 该记录所属的索引地址
 * @param logger 日志器，供 `setup` 不合法时说明
 * @returns 条目；记录不合法时 undefined
 */
function parseEntry(raw: unknown, source: string, logger?: Logger): MarketEntry | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const name = text(record, "name")
  if (name === undefined || !NAME_RE.test(name) || name.startsWith(".")) return undefined
  const install = parseInstall(record.install)
  if (install === undefined) return undefined
  const tags = Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === "string") : []
  const author = text(record, "author")
  const version = text(record, "version")
  const homepage = text(record, "homepage")
  const minCore = text(record, "minCore")
  const setup = parseSetup(record.setup, name, logger)
  return {
    name,
    title: text(record, "title") ?? name,
    description: text(record, "description") ?? "",
    tags,
    official: record.official === true,
    install,
    source,
    ...(setup === undefined ? {} : { setup }),
    ...(author === undefined ? {} : { author }),
    ...(version === undefined ? {} : { version }),
    ...(homepage === undefined ? {} : { homepage }),
    ...(minCore === undefined ? {} : { minCore })
  }
}

/**
 * 解析一份索引文档
 *
 * 接受两种形状：`{ plugins: [...] }` 与顶层直接是数组。后者便于用户把一个手写的
 * 数组挂到静态文件服务上作为私有源。
 * @param raw 已解析的 JSON
 * @param source 索引地址
 * @param logger 日志器，供条目里的 `setup` 不合法时说明；不给则静默丢弃
 * @returns 合法条目列表
 * @throws 文档既不是数组也不含 `plugins` 数组时
 */
export function parseIndex(raw: unknown, source: string, logger?: Logger): MarketEntry[] {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "object" && raw !== null && Array.isArray((raw as { plugins?: unknown }).plugins)
      ? (raw as { plugins: unknown[] }).plugins
      : undefined
  if (list === undefined) throw new Error("索引格式不符：期望数组或含 plugins 数组的对象")
  const entries: MarketEntry[] = []
  for (const item of list) {
    const entry = parseEntry(item, source, logger)
    if (entry !== undefined) entries.push(entry)
  }
  return entries
}

/**
 * 调用本机 git 执行一次命令，`MarketDeps.git` 的缺省实现
 *
 * 参数以数组传递，不经 shell，因此索引里的地址不会被当作命令解释。
 * `GIT_TERMINAL_PROMPT=0` 与 `GIT_ASKPASS` 一并关闭凭据提示：市场安装发生在
 * 无人值守的请求处理过程中，弹出的提示无人应答，只会让请求挂到超时。
 * @param args 命令参数
 * @param cwd 工作目录
 * @param timeout 超时毫秒
 * @returns 标准输出
 * @throws 命令不存在、超时或退出码非零时
 */
const runGit: GitRunner = (args, cwd, timeout) => {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      { cwd, timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" }, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`git ${args[0]} 失败：${stderr.trim() || err.message}`))
        else resolve(stdout)
      }
    )
  })
}

/** 磁盘缓存的文档结构 */
interface CacheFile {
  /** 获取时间戳 */
  fetchedAt: number
  /** 条目列表 */
  entries: MarketEntry[]
}

/**
 * 插件市场
 *
 * 索引缓存同时驻留内存与磁盘：磁盘那份让重启后无网络时仍能列出上次看到的插件。
 */
export class PluginMarket {
  /** 依赖 */
  readonly #deps: MarketDeps

  /** 内存中的索引条目 */
  #entries: MarketEntry[] = []

  /** 内存索引的获取时间，0 表示尚未取到 */
  #fetchedAt = 0

  /** 逐源结果，随索引一同更新 */
  #sources: MarketSourceResult[] = []

  /** 正在进行的索引获取，用于合并并发请求 */
  #inflight: Promise<void> | undefined

  /** git 可用性探测结果 */
  #gitAvailable: boolean | undefined

  /** 执行 git 命令，未注入时调用本机 git */
  readonly #git: GitRunner

  /** 执行包管理器，未注入时调用本机的 pnpm / npm */
  readonly #pm: PmRunner

  /**
   * @param deps 依赖
   */
  constructor(deps: MarketDeps) {
    this.#deps = deps
    this.#git = deps.git ?? runGit
    this.#pm = deps.pm ?? runPm
  }

  /**
   * 列出市场中的插件
   *
   * 缓存未过期时不发起网络请求。安装状态每次都重新读取文件系统：用户可能在面板
   * 之外手动删掉了插件目录，沿用缓存里的状态会让"卸载"按钮对着一个不存在的目录。
   * @param force 忽略缓存，强制重新获取
   * @returns 索引快照
   */
  async list(force = false): Promise<MarketSnapshot> {
    const settings = this.#deps.settings()
    const fresh = this.#fetchedAt > 0 && Date.now() - this.#fetchedAt < settings.cacheTtl
    const cached = !force && fresh
    if (force || !fresh) await this.#refresh(force)
    const plugins: MarketListing[] = []
    for (const entry of this.#entries) {
      const installed = await this.#isInstalled(entry.name)
      // 已装那份的版本从磁盘读，不能沿用索引里那个：索引说的是「现在最新是多少」
      const dir = installed ? joinWithin(this.#deps.pluginsDir, entry.name) : undefined
      const version = dir === undefined ? undefined : (await this.#manifest(dir))?.version
      plugins.push({
        ...entry,
        installed,
        ...(version === undefined ? {} : { installedVersion: version }),
        updatable:
          installed && version !== undefined && entry.version !== undefined
            ? compareVersion(entry.version, version) > 0
            : false
      })
    }
    plugins.sort((a, b) => a.name.localeCompare(b.name))
    return { fetchedAt: this.#fetchedAt, cached, sources: [...this.#sources], plugins }
  }

  /**
   * 按名称取一个条目
   * @param name 插件名
   * @returns 条目；索引中没有时 undefined
   */
  async entry(name: string): Promise<MarketEntry | undefined> {
    await this.list()
    return this.#entries.find(item => item.name === name)
  }

  /**
   * 合并并发的索引获取
   *
   * 面板打开时会同时请求概览与插件列表，两者都会触发获取。此处让后到者复用
   * 同一次网络请求，而不是各发一遍。
   * @param force 忽略磁盘缓存
   * @returns 获取完成
   */
  async #refresh(force: boolean): Promise<void> {
    if (this.#inflight !== undefined) return this.#inflight
    const task = this.#fetchAll(force).finally(() => {
      this.#inflight = undefined
    })
    this.#inflight = task
    return task
  }

  /**
   * 逐个索引获取并合并条目
   *
   * 同名插件以靠前的索引为准，因此用户可以把私有源放在官方源之前来覆盖某个条目。
   * 全部索引都失败且没有缓存可用时，条目置空但仍记录获取时间：面板据 `sources`
   * 展示失败原因，重试由用户显式触发，避免每次刷新页面都重复请求已知不可达的地址。
   * @param force 忽略磁盘缓存
   */
  async #fetchAll(force: boolean): Promise<void> {
    const { sources, mirror, timeout, cacheTtl } = this.#deps.settings()
    if (!force && this.#fetchedAt === 0) {
      const cache = await this.#loadCache()
      if (cache !== undefined && Date.now() - cache.fetchedAt < cacheTtl) {
        this.#entries = cache.entries
        this.#fetchedAt = cache.fetchedAt
        this.#sources = [{ url: this.#deps.cacheFile, ok: true, count: cache.entries.length }]
        return
      }
    }
    const results: MarketSourceResult[] = []
    const merged = new Map<string, MarketEntry>()
    for (const url of sources) {
      try {
        const raw = await this.#deps.http.get<unknown>(applyMirror(url, mirror), {
          responseType: "json",
          timeout,
          retry: 1
        })
        const entries = parseIndex(raw, url, this.#deps.logger)
        for (const item of entries) if (!merged.has(item.name)) merged.set(item.name, item)
        results.push({ url, ok: true, count: entries.length })
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        results.push({ url, ok: false, error, count: 0 })
        this.#deps.logger.warn(`插件市场索引获取失败 ${url}：${error}`)
      }
    }
    this.#sources = results
    if (merged.size === 0 && results.every(item => !item.ok)) {
      const cache = await this.#loadCache()
      if (cache !== undefined) {
        this.#entries = cache.entries
        this.#fetchedAt = cache.fetchedAt
        this.#deps.logger.warn("插件市场全部索引不可达，沿用上次缓存")
        return
      }
    }
    this.#entries = [...merged.values()]
    this.#fetchedAt = Date.now()
    await this.#saveCache()
  }

  /**
   * 读取磁盘缓存
   *
   * 缓存文件按不可信输入对待并重新经 `parseIndex` 校验：文件可能被用户手工改动，
   * 也可能是旧版本写下的、字段形状已经不同的内容。
   * @returns 缓存内容；文件不存在或不可解析时 undefined
   */
  async #loadCache(): Promise<CacheFile | undefined> {
    try {
      const raw = JSON.parse(await readFile(this.#deps.cacheFile, "utf8")) as unknown
      if (typeof raw !== "object" || raw === null) return undefined
      const record = raw as { fetchedAt?: unknown; entries?: unknown }
      if (typeof record.fetchedAt !== "number") return undefined
      const entries = parseIndex(record.entries ?? [], this.#deps.cacheFile)
      return { fetchedAt: record.fetchedAt, entries }
    } catch {
      return undefined
    }
  }

  /**
   * 写入磁盘缓存
   *
   * 写入失败只记日志：缓存是加速手段，写不进去不应当让一次成功的索引获取失败。
   */
  async #saveCache(): Promise<void> {
    const doc: CacheFile = { fetchedAt: this.#fetchedAt, entries: this.#entries }
    try {
      await mkdir(dirname(this.#deps.cacheFile), { recursive: true })
      await writeFile(this.#deps.cacheFile, JSON.stringify(doc, undefined, 2), "utf8")
    } catch (err) {
      this.#deps.logger.debug(`插件市场缓存写入失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * 判断插件目录下是否已存在同名目录
   * @param name 插件名
   * @returns 是否已安装
   */
  async #isInstalled(name: string): Promise<boolean> {
    try {
      return await isDirectory(joinWithin(this.#deps.pluginsDir, name))
    } catch {
      return false
    }
  }

  /**
   * 安装一个插件
   *
   * 取源与校验在临时目录内完成，校验通过后才移入插件目录，故取源失败时插件目录保持原状。
   * 装依赖与装后步骤在移入之后、于插件目录内进行：pnpm 的 `node_modules` 里全是指向
   * store 的符号链接，换个路径就断。
   *
   * 安装完成后不加载插件：加载时机由调用方决定。
   * @param name 插件名
   * @param opts 可选参数
   * @param opts.replace 目标已存在时先删除再安装
   * @param opts.dependencies 装完之后跑包管理器装依赖，并按索引声明跑装后步骤
   * @returns 安装结果
   * @throws 名称不合法、索引中无此插件、内核版本不满足、目标已存在或取源失败时
   */
  async install(name: string, opts: { replace?: boolean; dependencies?: boolean } = {}): Promise<InstallResult> {
    assertPluginName(name)
    const entry = await this.entry(name)
    if (entry === undefined) throw new Error(`插件市场中没有名为 ${name} 的插件`)
    const target = joinWithin(this.#deps.pluginsDir, name)
    const exists = await isDirectory(target)
    if (exists && opts.replace !== true) throw new Error(`插件 ${name} 已安装，如需覆盖请先卸载`)
    if (entry.minCore !== undefined && compareVersion(this.#deps.coreVersion, entry.minCore) < 0) {
      throw new Error(`插件 ${name} 要求内核版本不低于 ${entry.minCore}，当前为 ${this.#deps.coreVersion}`)
    }

    await mkdir(this.#deps.tempDir, { recursive: true })
    const staging = await mkdtemp(join(this.#deps.tempDir, `market-${name}-`))
    try {
      const { via, root } = await this.#fetch(entry, staging)
      await this.#assertLooksLikePlugin(root, name)
      const manifest = await this.#manifest(root)
      const version = manifest?.version ?? entry.version ?? "0.0.0"
      if (exists) await rm(target, { recursive: true, force: true })
      await mkdir(this.#deps.pluginsDir, { recursive: true })
      await this.#move(root, target)
      this.#deps.logger.info(`插件 ${name}@${version} 已安装至 ${target}`)
      // 带 `.git` 的目录此后可就地拉取；归档装出来的每次更新都要整目录重下
      const updatable = via === "git" ? "pull" : "reinstall"
      const done = await this.#finish(name, target, manifest, entry.setup, opts.dependencies === true)
      return { name, dir: target, via, version, updatable, ...done }
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }

  /**
   * 收尾：按需装依赖、跑装后步骤
   *
   * 失败不向上抛，原因记进返回值：插件目录已经就位，缺的只是依赖或产物。
   * 先装依赖再跑脚本，装依赖失败就不跑脚本 —— 脚本多半建立在依赖之上。
   * @param name 插件名
   * @param dir 插件目录
   * @param manifest package.json 里的相关字段
   * @param setup 索引声明的装后步骤
   * @param wanted 调用方是否要求跑包管理器
   * @param always 依赖不缺、也没有装后步骤时是否仍跑一遍装依赖
   * @returns 结果中与依赖、装后步骤相关的那几项
   */
  async #finish(
    name: string,
    dir: string,
    manifest: { dependencies?: Record<string, string> } | undefined,
    setup: MarketSetupSpec | undefined,
    wanted: boolean,
    always = false
  ): Promise<SetupOutcome> {
    const declared = Object.keys(manifest?.dependencies ?? {}).length > 0
    // 「声明了依赖」不等于「还缺依赖」：就地拉取那条路上目录里往往已有 `node_modules`
    const missing = declared && !(await isDirectory(join(dir, "node_modules")))

    // 声明了装后步骤就得跑，哪怕依赖不缺：拉来新提交后 `node_modules` 还在而 `dist/` 已旧
    const wants = wanted && (missing || setup !== undefined || always)
    if (!wants) {
      if (missing) this.#deps.logger.warn(`插件 ${name} 声明了运行时依赖，需在其目录内自行执行包管理器安装`)
      return { needsDependencies: missing }
    }

    // 零依赖、无装后步骤的插件不跑包管理器：对没有 package.json 的目录跑只会报无关的错
    if (!declared && setup === undefined) return { needsDependencies: false }

    let pm: string
    try {
      // 有装后步骤时连 devDependencies 一起装：`build` 要的编译器在那里，见 pm.ts 文件头
      pm = await this.#pm({ kind: "install", dev: setup?.dev === true }, dir, INSTALL_TIMEOUT_MS)
      this.#deps.logger.info(`插件 ${name} 的依赖已由 ${pm} 装好`)
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      this.#deps.logger.error(`插件 ${name} 的依赖安装失败：${error}。请在 ${dir} 目录内自行执行包管理器`)
      // 记 `dependencyError` 而非 `setupError`：两者的后手不同，见 SetupOutcome 的注释
      return { needsDependencies: true, installedDeps: false, dependencyError: error }
    }

    const ranScripts: string[] = []
    for (const script of setup?.scripts ?? []) {
      try {
        await this.#pm({ kind: "run", script }, dir, SCRIPT_TIMEOUT_MS)
        ranScripts.push(script)
        this.#deps.logger.info(`插件 ${name} 的装后步骤 ${script} 已执行`)
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        this.#deps.logger.error(`插件 ${name} 的装后步骤 ${script} 失败：${error}。请在 ${dir} 目录内自行执行 ${pm} run ${script}`)
        return { needsDependencies: false, installedDeps: true, packageManager: pm, ranScripts, setupError: `${script}：${error}` }
      }
    }
    return { needsDependencies: false, installedDeps: true, packageManager: pm, ranScripts }
  }

  /**
   * 对一个已装好的插件重跑装依赖与装后步骤，不重新取源
   *
   * 索引里没有这个插件也照做，此时只装依赖、不跑装后步骤 —— 手工放进插件目录的插件
   * 多半不在任何索引里。即便依赖不缺也跑一遍：包管理器自己比对 lock 文件，本就幂等。
   * @param name 插件名
   * @returns 本次的结果
   * @throws 名称不合法或插件目录不存在时
   */
  async setup(name: string): Promise<PluginSetupResult> {
    assertPluginName(name)
    const dir = joinWithin(this.#deps.pluginsDir, name)
    if (!(await isDirectory(dir))) throw new Error(`插件目录 ${name} 不存在`)
    const manifest = await this.#manifest(dir)
    // 索引取不到不算失败，见方法头
    const entry = await this.entry(name).catch(() => undefined)
    const done = await this.#finish(name, dir, manifest, entry?.setup, true, true)
    return { name, dir, version: manifest?.version ?? "0.0.0", ...done }
  }

  /**
   * 卸载一个插件
   *
   * 只删除插件目录。配置文件与数据库另行存放，保留它们使得重新安装后原有配置仍然有效。
   * @param name 插件名
   * @returns 是否确实删除了目录
   * @throws 名称不合法时
   */
  async remove(name: string): Promise<boolean> {
    assertPluginName(name)
    const target = joinWithin(this.#deps.pluginsDir, name)
    if (!(await isDirectory(target))) return false
    await rm(target, { recursive: true, force: true })
    this.#deps.logger.info(`插件 ${name} 目录已删除：${target}`)
    return true
  }

  /**
   * 探一下就地拉取会不会撞上本地改动
   *
   * 只读：除 `status` 之外一个命令都不发，故可在面板的确认框之前调用。
   * 判据与 `#tryPull` 里那一条必须一致，分两处写迟早分叉。
   * @param name 插件名
   * @returns 就地拉取会不会走成、以及目录里有没有未提交的改动
   * @throws 名称不合法时
   */
  async inspectUpdate(name: string): Promise<UpdateProbe> {
    assertPluginName(name)
    const dir = joinWithin(this.#deps.pluginsDir, name)
    // 前置条件与 `#tryPull` 同一串；任一条不满足即整目录重装那条路，那条路不碰 git，故 dirty 恒为假
    if (!(await isDirectory(join(dir, ".git")))) return { willPull: false, dirty: false }
    const entry = await this.entry(name)
    if (entry === undefined || entry.install.type !== "git") return { willPull: false, dirty: false }
    if (!(await this.#hasGit())) return { willPull: false, dirty: false }
    const dirty = await this.#isDirty(dir)
    return { willPull: true, dirty }
  }

  /**
   * 目录里有没有未提交的改动
   *
   * 探测与执行共用这一处判据，别在调用方另写一份。
   * @param dir 插件目录
   * @returns 是否有改动（含未跟踪文件）
   */
  async #isDirty(dir: string): Promise<boolean> {
    return (await this.#git(["status", "--porcelain"], dir, GIT_LOCAL_TIMEOUT_MS)).trim() !== ""
  }

  /**
   * 更新一个插件：目录已是 git 仓库时就地拉取，否则退回重新安装
   * @param name 插件名
   * @param opts 可选参数
   * @param opts.dependencies 更新完之后跑包管理器装依赖，并按索引声明跑装后步骤
   * @param opts.stash 撞上本地改动时是否暂存。`onDirty` 已给出时本项忽略，留着是为了不破坏既有调用方
   * @param opts.onDirty 撞上本地改动时怎么办：`abort` 中止（缺省）、`stash` 暂存、`discard` 丢弃
   * @returns 安装结果
   * @throws 与 `install` 相同；就地拉取失败时抛出 git 的错误；有改动而未给出处置方式时
   */
  async update(
    name: string,
    opts: { dependencies?: boolean; stash?: boolean; onDirty?: DirtyAction } = {}
  ): Promise<InstallResult> {
    // 优先就地拉取：重新安装会删掉目录里那份 node_modules 与其他不属于仓库的文件
    assertPluginName(name)
    const target = joinWithin(this.#deps.pluginsDir, name)
    // 老调用方只给 `stash`，新调用方给 `onDirty`；两者都没给即中止，与从前一致
    const onDirty: DirtyAction = opts.onDirty ?? (opts.stash === true ? "stash" : "abort")
    const pulled = await this.#tryPull(name, target, opts.dependencies === true, onDirty)
    return pulled ?? this.install(name, { replace: true, ...opts })
  }

  /**
   * 试着就地拉取一个插件
   * @param name 插件名
   * @param dir 插件安装目录
   * @param dependencies 拉完之后按需装依赖、跑装后步骤
   * @param onDirty 撞上本地改动时怎么办：暂存、丢弃，还是中止整次更新
   * @returns 拉取结果；不具备就地拉取条件（无 git、目录不是仓库、来源不是 git）时 undefined
   * @throws 拉取过程本身失败时 —— 那意味着网络或仓库状态有问题，此时退回重新安装会把一次
   *         可修复的失败变成一次目录删除；有改动而 `onDirty` 为 `abort` 时同样抛出，见下
   */
  async #tryPull(
    name: string,
    dir: string,
    dependencies: boolean,
    onDirty: DirtyAction
  ): Promise<InstallResult | undefined> {
    /*
     * 两条不能改的次序：用 `fetch` + `reset --hard` 而非 `pull`（后者会试图合并，
     * 冲突时目录停在半新半旧）；stash 必须先于 reset，反过来即数据丢失。
     */
    if (!(await isDirectory(join(dir, ".git")))) return undefined
    const entry = await this.entry(name)
    if (entry === undefined) throw new Error(`插件市场中没有名为 ${name} 的插件`)
    if (entry.install.type !== "git") return undefined
    if (!(await this.#hasGit())) return undefined
    if (entry.minCore !== undefined && compareVersion(this.#deps.coreVersion, entry.minCore) < 0) {
      throw new Error(`插件 ${name} 要求内核版本不低于 ${entry.minCore}，当前为 ${this.#deps.coreVersion}`)
    }

    const before = (await this.#manifest(dir))?.version
    const head = async (): Promise<string> => (await this.#git(["rev-parse", "HEAD"], dir, GIT_LOCAL_TIMEOUT_MS)).trim()
    const wasAt = await head()

    // 中止发生在 reset 之前，故目录停在原样
    const dirty = await this.#isDirty(dir)
    if (dirty && onDirty === "abort") {
      throw new Error(
        `插件 ${name} 的目录内有未提交的改动。更新会把目录重置到远端最新提交，` +
          `那些改动须先暂存或丢弃（面板会问你一次），或自行处理：在该目录执行 git stash push 或 git checkout .`
      )
    }
    const stashed = dirty && onDirty === "stash"
    if (stashed) {
      await this.#git(
        ["stash", "push", "--include-untracked", "-m", `yunzai-ng 更新前暂存 ${new Date().toISOString()}`],
        dir,
        GIT_LOCAL_TIMEOUT_MS
      )
      this.#deps.logger.warn(`插件 ${name} 目录内有未提交的改动，已按你的选择暂存。如需取回：在该目录执行 git stash pop`)
    }
    if (dirty && onDirty === "discard") {
      // `clean -fd` 不能省：`reset --hard` 不动未跟踪的文件，而那正是这一项要清掉的东西
      await this.#git(["reset", "--hard", "HEAD"], dir, GIT_LOCAL_TIMEOUT_MS)
      await this.#git(["clean", "-fd"], dir, GIT_LOCAL_TIMEOUT_MS)
      this.#deps.logger.warn(`插件 ${name} 目录内有未提交的改动，已按你的选择丢弃 —— 这些改动无法取回`)
    }

    const { mirror } = this.#deps.settings()
    const branch = entry.install.branch
    // 地址每次现算，不沿用目录里记着的 origin：镜像是可改的配置项，旧镜像可能已关站
    const url = applyMirror(entry.install.url, mirror)
    const ref = branch ?? "HEAD"
    await this.#git(["fetch", "--depth", "1", url, ref], dir, TRANSFER_TIMEOUT_MS)
    await this.#git(["reset", "--hard", "FETCH_HEAD"], dir, GIT_LOCAL_TIMEOUT_MS)

    const nowAt = await head()
    const changed = nowAt !== wasAt
    const manifest = await this.#manifest(dir)
    const version = manifest?.version ?? entry.version ?? "0.0.0"

    if (changed) this.#deps.logger.info(`插件 ${name} 已就地更新至 ${version}（${wasAt.slice(0, 7)} → ${nowAt.slice(0, 7)}）`)
    else this.#deps.logger.info(`插件 ${name} 已是最新版本 ${version}`)

    // 没有新提交时跳过收尾，重跑 `build` 只是白等；缺依赖是例外，与有没有新提交无关
    const missing =
      Object.keys(manifest?.dependencies ?? {}).length > 0 && !(await isDirectory(join(dir, "node_modules")))
    const done = await this.#finish(name, dir, manifest, entry.setup, dependencies && (changed || missing))

    return {
      name,
      dir,
      via: "pull",
      version,
      changed,
      // 就地拉取过一次，说明目录确实是 git 仓库，此后照旧走这条路
      updatable: "pull",
      // 判据取 onDirty 而非 dirty：discard 那一路同样 dirty，却没有 stash 可 pop
      ...(dirty && onDirty === "stash" ? { stashed: true } : {}),
      ...(dirty && onDirty === "discard" ? { discarded: true } : {}),
      ...(before === undefined ? {} : { fromVersion: before }),
      ...done
    }
  }

  /**
   * 把插件内容取到临时目录
   *
   * git 优先：克隆得到的目录带 `.git`，此后可就地拉取。git 不可用时退回归档下载，
   * 仅 GitHub 地址可换算出 codeload 归档地址，其余来源只提供 git 时明确报错。
   * @param entry 索引条目
   * @param staging 临时目录
   * @returns 取源方式与插件内容的根目录
   * @throws git 与归档两条路都不可用，或归档为空时
   */
  async #fetch(entry: MarketEntry, staging: string): Promise<{ via: MarketInstallSpec["type"]; root: string }> {
    const { mirror } = this.#deps.settings()
    if (entry.install.type === "git" && (await this.#hasGit())) {
      const dest = join(staging, "repo")
      const args = ["clone", "--depth", "1", "--single-branch"]
      if (entry.install.branch !== undefined) args.push("--branch", entry.install.branch)
      args.push(applyMirror(entry.install.url, mirror), dest)
      await this.#git(args, staging, TRANSFER_TIMEOUT_MS)
      return { via: "git", root: dest }
    }
    const url =
      entry.install.type === "tarball"
        ? entry.install.url
        : tarballFromGit(entry.install.url, entry.install.branch)
    if (url === undefined) throw new Error(`插件 ${entry.name} 仅提供 git 来源，而本机未安装 git`)
    const bytes = await this.#deps.http.buffer(applyMirror(url, mirror), {
      timeout: TRANSFER_TIMEOUT_MS,
      retry: 1
    })
    if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
      throw new Error(`归档体积 ${bytes.byteLength} 字节超过上限 ${MAX_ARCHIVE_BYTES} 字节`)
    }
    const raw = join(staging, "raw")
    const written = await extractTarGz(bytes, raw)
    if (written.length === 0) throw new Error(`归档 ${url} 中没有可写入的文件`)
    const top = singleRoot(written)
    return { via: "tarball", root: top === undefined ? raw : join(raw, top) }
  }

  /**
   * 探测本机 git 可用性
   *
   * 结果缓存到进程结束。探测前先建出临时目录：它是这条命令的 cwd，不存在时 execFile
   * 报 ENOENT，会被下面的 catch 记成「本机没有 git」并缓存到进程结束。
   * @returns git 是否可用
   */
  async #hasGit(): Promise<boolean> {
    if (this.#gitAvailable !== undefined) return this.#gitAvailable
    try {
      await mkdir(this.#deps.tempDir, { recursive: true })
      await this.#git(["--version"], this.#deps.tempDir, GIT_LOCAL_TIMEOUT_MS)
      this.#gitAvailable = true
    } catch {
      this.#gitAvailable = false
      this.#deps.logger.debug("本机未检测到 git，插件安装改用归档下载")
    }
    return this.#gitAvailable
  }

  /**
   * 校验取到的内容是否具备插件形态
   *
   * 先于移入插件目录执行，把「地址写错」变成此刻一条可读的错误，而非下次启动时的加载失败。
   * @param root 内容根目录
   * @param name 插件名
   * @throws 既无 package.json 也无入口文件时
   */
  async #assertLooksLikePlugin(root: string, name: string): Promise<void> {
    if (await isFile(join(root, "package.json"))) return
    for (const entry of ENTRY_FILES) if (await isFile(join(root, entry))) return
    throw new Error(`取到的内容不像插件：${name} 目录内既无 package.json 也无入口文件`)
  }

  /**
   * 读取 package.json 中与安装相关的字段
   * @param root 内容根目录
   * @returns 版本与依赖声明；无 package.json 或不可解析时 undefined
   */
  async #manifest(root: string): Promise<{ version?: string; dependencies?: Record<string, string> } | undefined> {
    try {
      const raw = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as unknown
      if (typeof raw !== "object" || raw === null) return undefined
      const record = raw as { version?: unknown; dependencies?: unknown }
      const version = typeof record.version === "string" ? record.version : undefined
      const dependencies =
        typeof record.dependencies === "object" && record.dependencies !== null
          ? (record.dependencies as Record<string, string>)
          : undefined
      return { ...(version === undefined ? {} : { version }), ...(dependencies === undefined ? {} : { dependencies }) }
    } catch {
      return undefined
    }
  }

  /**
   * 把临时目录中的内容移到插件目录
   *
   * 临时目录被配到另一个分区时 `rename` 报 EXDEV，此时退回递归复制。
   * @param from 源目录
   * @param to 目标目录
   */
  async #move(from: string, to: string): Promise<void> {
    try {
      await rename(from, to)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err
      await cp(from, to, { recursive: true })
    }
  }
}

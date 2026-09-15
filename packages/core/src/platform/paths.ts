/**
 * 模块职责：确定并创建运行时目录布局
 * 依赖方向：依赖 util/fs、platform/detect
 * 生命周期：启动时解析一次，之后只读
 * 注意事项：优先级为显式参数 > `YZNG_HOME` > 便携模式标记 > 当前目录，启动时一次性定死成绝对路径，
 *          其余模块只准通过 `app.paths` 取。
 *
 *          默认落在当前目录，故本模块要读 `process.cwd()`；以 Windows 服务、开机自启或 pm2 启动时
 *          工作目录并非项目目录，那些场景必须显式给出 `YZNG_HOME`。旧版（0.1.1 及更早）的系统目录
 *          位置不做静默回落，改由 {@link legacyInstance} 报给 CLI 提示 —— 换目录该是使用者看得见的
 *          一步。
 *
 *          「当前目录」先向上认已有实例，见 {@link findInstanceRoot}：直接取 `process.cwd()` 会在
 *          实例的子目录里现建第二个实例，空配置、无账号、面板端口与上层相撞。主判据是
 *          `package.json` 声明了 `@yunzai-ng/cli` 而非「有没有 `config/`」，故全新安装尚未 init 时
 *          也成立。
 */
import { homedir } from "node:os"
import { dirname, isAbsolute, join, parse as parsePath, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { existsSync, readFileSync } from "node:fs"
import type { RuntimePaths } from "@yunzai-ng/types"
import { ensureDir } from "../util/fs.js"
import { detectPlatform } from "./detect.js"

/** 便携模式标记文件名 */
const PORTABLE_MARKER = ".portable"

/**
 * CLI 的包名 —— 向上找实例根的主判据
 *
 * 写成字面量而非 import：core 不依赖 cli（那会成环，且分层门禁会拦）。
 */
const CLI_PACKAGE = "@yunzai-ng/cli"

/**
 * 内核配置的文件名 —— 向上找实例根的次判据
 *
 * 与 `CORE_CONFIG_NAME` 对应，同样刻意不 import config 层：platform 是更底的一层。
 */
const CORE_CONFIG_FILE = "yunzai.yaml"

/** 应用目录名（系统默认位置下使用） */
const APP_DIR_NAME = "YunzaiNG"

/** 类 Unix 系统下的隐藏目录名 */
const APP_DIR_NAME_UNIX = ".yunzai-ng"

/** 解析目录布局的参数 */
export interface ResolvePathsOptions {
  /** 显式指定数据根目录；相对路径按 `process.cwd()` 解析 */
  home?: string
  /** 内核包所在目录；缺省由 `import.meta.url` 推导 */
  runtime?: string
}

/**
 * 推导内核自身所在目录
 *
 * 编译后本文件位于 `<pkg>/dist/platform/paths.js`，上溯两级即包根。
 * @returns 内核包根目录的绝对路径
 */
function detectRuntimeDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, "..", "..")
}

/**
 * 寻找便携模式标记
 *
 * 依次检查工作目录、内核包上两级（`node_modules/@yunzai-ng/core` → 安装根）。
 * @param runtimeDir 内核包目录
 * @returns 命中的便携根目录；未命中时 undefined
 */
function findPortableRoot(runtimeDir: string): string | undefined {
  const candidates = [process.cwd(), resolve(runtimeDir, "..", "..", ".."), resolve(runtimeDir, "..", "..")]
  for (const dir of candidates) {
    if (existsSync(join(dir, PORTABLE_MARKER))) return dir
  }
  return undefined
}

/**
 * 系统默认的数据根目录
 *
 * 已不再是缺省取值，仅由 {@link legacyInstance} 用于查找旧实例，见文件头第 3 条。
 * @returns 绝对路径
 */
function defaultHome(): string {
  const info = detectPlatform()
  const home = homedir()

  if (info.os === "windows") {
    const base = process.env.LOCALAPPDATA ?? process.env.APPDATA ?? join(home, "AppData", "Local")
    return join(base, APP_DIR_NAME)
  }
  if (info.os === "macos") {
    return join(home, "Library", "Application Support", APP_DIR_NAME)
  }
  if (info.os === "android") {
    // Termux 的 $HOME 已经在应用私有目录里，再套 XDG 只会加深路径
    return join(home, APP_DIR_NAME_UNIX)
  }
  const xdg = process.env.XDG_DATA_HOME
  if (xdg && isAbsolute(xdg)) return join(xdg, "yunzai-ng")
  return join(home, APP_DIR_NAME_UNIX)
}

/**
 * 判断一个目录里是否已有实例
 *
 * 以 `config/` 是否存在为准：`ensurePaths` 建的七个目录里只有它必定装着文件，而空的 `data/`、
 * `logs/` 无从区分「一个实例」与「随手建的空目录」。
 * @param dir 待判断的目录
 * @returns 是否已有实例
 */
function hasInstance(dir: string): boolean {
  return existsSync(join(dir, "config"))
}

/**
 * 一个目录的 `package.json` 是否声明了 CLI
 *
 * 装 CLI 的唯一理由就是要在这个目录里跑实例，而插件只依赖 `core` 与 `types`，故插件目录不会被
 * 误认。三段依赖表都看：源码开发时它可能在 `devDependencies` 里。判据刻意不是「存在
 * `node_modules/@yunzai-ng/cli`」—— 那样一个自行 `pnpm add @yunzai-ng/core` 的插件目录会被认成
 * 实例根。
 * @param dir 待判断的目录
 * @returns 是否声明了 CLI
 */
function declaresCli(dir: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
    if (typeof parsed !== "object" || parsed === null) return false
    const pkg = parsed as Record<string, unknown>
    return ["dependencies", "devDependencies", "optionalDependencies"].some(field => {
      const deps = pkg[field]
      return typeof deps === "object" && deps !== null && CLI_PACKAGE in (deps as Record<string, unknown>)
    })
  } catch {
    // 读不到、或不是合法 JSON —— 两种情形都只说明「这一级不是实例根」，继续向上
    return false
  }
}

/**
 * 向上找实例时的次判据：`config/yunzai.yaml`
 *
 * 覆盖 CLI 判据照不到的两种布局：全局安装（实例目录里没有 `package.json`）与源码构建。
 *
 * 比 {@link hasInstance} 的「有 `config/` 目录」严格：这一条决定数据往哪写，认宽了会把无关项目的
 * `config/` 当成 Yunzai 实例。`config/yunzai.yaml` 由 `ConfigStore` 初始化时必定落盘。
 * @param dir 待判断的目录
 * @returns 是否装着一份内核配置
 */
function hasCoreConfig(dir: string): boolean {
  return existsSync(join(dir, "config", CORE_CONFIG_FILE))
}

/**
 * 自 `from` 逐级向上找一个目录
 * @param from 起点目录
 * @param match 判据
 * @returns 命中的目录；一路到盘根都没有时 undefined
 */
function walkUp(from: string, match: (dir: string) => boolean): string | undefined {
  const start = resolve(from)
  const root = parsePath(start).root
  let dir = start
  for (;;) {
    if (match(dir)) return dir
    if (dir === root) return undefined
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * 自 `from` 向上找装着 CLI 的那个目录
 *
 * 供 `yzng update` 定位「在哪跑包管理器」。与 {@link findInstanceRoot} 分开：升级必须落在一个有
 * `package.json` 的目录上，而后者还认只有配置文件的实例 —— 在那种目录里跑 `pnpm add` 会凭空造出
 * 一份 `package.json`。
 * @param from 起点目录
 * @returns 安装目录；找不到时 undefined
 */
export function findInstallRoot(from: string): string | undefined {
  return walkUp(from, declaresCli)
}

/**
 * 自 `from` 向上找已有实例的根
 *
 * 逐级向上而非只看当前目录：在实例的子目录里执行 `yzng start` 是极自然的动作，而只看当前目录会在
 * 那里现建第二个实例。两条判据取就近命中者，不分主次 —— 嵌套时最近的那个才是使用者所指的。
 * @param from 起点目录
 * @returns 实例根目录；一路到盘根都没有时 undefined
 */
export function findInstanceRoot(from: string): string | undefined {
  return walkUp(from, dir => declaresCli(dir) || hasCoreConfig(dir))
}

/**
 * 未显式指定、也无便携标记时的主目录
 *
 * 先向上找已有实例，找不到才用当前目录：后者是「新装」，前者是「已经装过了，只是此刻站在它的某个
 * 子目录里」。
 * @returns 绝对路径
 */
function autoHome(): string {
  return findInstanceRoot(process.cwd()) ?? process.cwd()
}

/**
 * 0.1.1 及更早的默认位置上是否还留着一个实例
 *
 * 供 CLI 提示使用：默认位置自 0.2.0 起改为当前目录，装过旧版的机器上那个实例仍在原处。内核只报出
 * 位置，是否搬家由使用者决定 —— 自动迁移在两个目录都有内容时无从判断以谁为准。
 * @param home 本次实际使用的主目录
 * @returns 旧实例所在目录；不存在、或恰好就是本次所用的目录时 undefined
 */
export function legacyInstance(home: string): string | undefined {
  const legacy = defaultHome()
  if (resolve(legacy) === resolve(home)) return undefined
  return hasInstance(legacy) ? legacy : undefined
}

/**
 * 解析目录布局
 *
 * 只做路径计算，不创建目录，便于测试与 `yzng doctor` 这类只想看路径的场景。创建请调用 `ensurePaths`。
 * @param opts 解析参数
 * @returns 目录布局（全为绝对路径）
 */
export function resolvePaths(opts: ResolvePathsOptions = {}): RuntimePaths {
  const runtime = opts.runtime ? resolve(opts.runtime) : detectRuntimeDir()

  const explicit = opts.home ?? process.env.YZNG_HOME
  const home = explicit ? resolve(process.cwd(), explicit) : (findPortableRoot(runtime) ?? autoHome())

  return Object.freeze({
    home,
    config: join(home, "config"),
    data: join(home, "data"),
    logs: join(home, "logs"),
    temp: join(home, "temp"),
    plugins: join(home, "plugins"),
    cache: join(home, "cache"),
    runtime
  })
}

/**
 * 创建目录布局里的所有目录
 *
 * `runtime` 不创建（它是安装目录，理应已存在且可能只读）。
 * @param paths 目录布局
 * @returns 传入的布局本身，便于链式使用
 * @throws 目录无法创建时抛出（磁盘只读、权限不足），此时应终止启动
 */
export async function ensurePaths(paths: RuntimePaths): Promise<RuntimePaths> {
  await Promise.all([
    ensureDir(paths.home),
    ensureDir(paths.config),
    ensureDir(paths.data),
    ensureDir(paths.logs),
    ensureDir(paths.temp),
    ensureDir(paths.plugins),
    ensureDir(paths.cache)
  ])
  return paths
}

/**
 * 在临时目录下生成一个带前缀的路径
 *
 * 用完请自行删除；`temp` 目录也会在启动时按保留期清理。
 * @param paths 目录布局
 * @param prefix 文件名前缀
 * @param ext 扩展名（含点），如 `".png"`
 * @param unique 唯一后缀，通常传 `randomId()`
 * @returns 临时文件绝对路径
 */
export function tempFile(paths: RuntimePaths, prefix: string, ext: string, unique: string): string {
  return join(paths.temp, `${prefix}-${unique}${ext}`)
}

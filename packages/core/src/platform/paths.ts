/**
 * 模块职责：确定并创建运行时目录布局
 * 依赖方向：依赖 util/fs、platform/detect
 * 生命周期：启动时解析一次，之后只读
 * 注意事项：全程不使用 `process.cwd()` —— 以 Windows 服务、开机自启或 pm2 启动时
 *          工作目录并非项目目录。启动时把八个目录一次性定死成绝对路径，
 *          其余模块只准通过 `app.paths` 取。
 *
 *          优先级：显式参数 > `YZNG_HOME` 环境变量 > 便携模式标记 > 系统默认位置。
 *          便携模式（安装目录下有 `.portable` 文件）让 ZIP 解压即用、
 *          换机拷走整个文件夹就能迁移 —— Windows 用户最常见的诉求。
 */
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { existsSync } from "node:fs"
import type { RuntimePaths } from "@yunzai-ng/types"
import { ensureDir } from "../util/fs.js"
import { detectPlatform } from "./detect.js"

/** 便携模式标记文件名 */
const PORTABLE_MARKER = ".portable"

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
 * 解析目录布局
 *
 * 只做路径计算，不创建目录 —— 便于测试与 `yzng doctor` 之类"只想看看
 * 路径解析成什么"的场景。创建请调用 `ensurePaths`。
 * @param opts 解析参数
 * @returns 目录布局（全为绝对路径）
 */
export function resolvePaths(opts: ResolvePathsOptions = {}): RuntimePaths {
  const runtime = opts.runtime ? resolve(opts.runtime) : detectRuntimeDir()

  const explicit = opts.home ?? process.env.YZNG_HOME
  const home = explicit ? resolve(process.cwd(), explicit) : (findPortableRoot(runtime) ?? defaultHome())

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

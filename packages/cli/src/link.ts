/**
 * 模块职责：将框架包链接至主目录，使 `<home>/plugins` 下的第三方插件可以 import 内核
 * 依赖方向：仅使用 node:fs / node:path / node:module
 * 生命周期：`init` 与 `start` 各调用一次，幂等
 * 注意事项：**此项并非可选的便利功能，而是插件能否加载的前提。** 插件位于使用者的主目录
 *          （例如 `%LOCALAPPDATA%\yunzai-ng\plugins\我的插件\`），而框架安装于其他位置；
 *          Node 解析 `import "@yunzai-ng/core"` 时仅会自插件目录逐级向上查找
 *          `node_modules`，始终无法到达框架所在目录 —— 其结果是每个插件均以
 *          `ERR_MODULE_NOT_FOUND` 失败，而报错信息完全不指示应对方式。
 *          在 `<home>/node_modules/@yunzai-ng/` 下建立两个链接即可解决，pnpm 自身
 *          亦采用同一做法。
 *
 *          Windows 上使用 junction 而非 symlink：目录 symlink 需要开发者模式或
 *          管理员权限，junction 无此要求，而对 Node 的解析行为两者等价。
 *
 *          已存在的链接一律不作改动，仅替换**指向已消失目标**的那一类（框架被移动或
 *          重装后会出现该情形）。绝不覆盖真实目录：开发时主目录可能即为仓库本身，
 *          其中的 `node_modules/@yunzai-ng` 由 pnpm 建立，改动它将破坏开发环境。
 */
import { lstat, mkdir, readlink, rm, symlink } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { createRequire } from "node:module"
import { existsSync } from "node:fs"

/**
 * 需要暴露给插件的框架包
 *
 * 三者与分层门禁中插件可依赖的包集合（scripts/check-layering.mjs 的 plugins 规则，
 * 现已移交各插件仓库的 eslint）保持一致：**门禁允许 import 的包，此处必须链接**，
 * 否则插件在开发时类型检查通过，装到使用者主目录后却以 ERR_MODULE_NOT_FOUND 失败。
 * `jsx` 曾因不在此列而具备该缺陷。
 */
const FRAMEWORK_PACKAGES = ["@yunzai-ng/core", "@yunzai-ng/types", "@yunzai-ng/jsx"] as const

/** 链接结果 */
export interface LinkReport {
  /** 本次新建或修复的包名 */
  readonly linked: readonly string[]
  /** 已存在、无需处理的包名 */
  readonly kept: readonly string[]
  /** 失败的包名与原因 */
  readonly failed: readonly (readonly [string, string])[]
}

/**
 * 定位一个已安装包的目录
 *
 * 解析 `package.json` 而非包主入口：`exports` 字段可将主入口指向 `dist/` 内的深层路径，
 * 对其取 dirname 会得到 `dist` 而非包根。所有框架包均显式导出了
 * `"./package.json"`，正是为使此类工具能够查询其包根位置。
 * @param name 包名
 * @returns 包根目录；解析不到时 undefined
 */
function packageDir(name: string): string | undefined {
  try {
    return dirname(createRequire(import.meta.url).resolve(`${name}/package.json`))
  } catch {
    return undefined
  }
}

/**
 * 判断一个已存在的路径是否需要重建
 * @param path 链接路径
 * @returns 需要重建时 true
 */
async function isBrokenLink(path: string): Promise<boolean> {
  const stat = await lstat(path)
  if (!stat.isSymbolicLink()) return false
  try {
    const target = await readlink(path)
    return !existsSync(resolve(dirname(path), target))
  } catch {
    return true
  }
}

/**
 * 在主目录中建立框架包链接
 * @param home 主目录
 * @returns 链接结果
 */
export async function linkFramework(home: string): Promise<LinkReport> {
  const scopeDir = join(home, "node_modules", "@yunzai-ng")
  const linked: string[] = []
  const kept: string[] = []
  const failed: [string, string][] = []

  await mkdir(scopeDir, { recursive: true })

  for (const name of FRAMEWORK_PACKAGES) {
    const short = name.slice("@yunzai-ng/".length)
    const link = join(scopeDir, short)
    const target = packageDir(name)

    if (target === undefined) {
      failed.push([name, "CLI 的模块图中不存在该包，框架安装可能不完整"])
      continue
    }

    try {
      if (existsSync(link)) {
        if (!(await isBrokenLink(link))) {
          kept.push(name)
          continue
        }
        await rm(link, { recursive: true, force: true })
      }
      await symlink(target, link, "junction")
      linked.push(name)
    } catch (err) {
      failed.push([name, err instanceof Error ? err.message : String(err)])
    }
  }

  return { linked, kept, failed }
}

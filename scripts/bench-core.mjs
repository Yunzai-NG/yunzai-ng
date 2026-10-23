/**
 * 模块职责：压测脚本共用的两件事 —— 选哪一份内核、把官方插件链进临时主目录
 * 依赖方向：只依赖 node 内置模块
 * 生命周期：被 bench-memory.mjs 与 bench-startup.mjs 在子进程里引入
 * 注意事项：**插件与压测脚本必须拿到同一份内核。** 插件 `import "@yunzai-ng/core"` 按自己的 node_modules
 *          解析，指向本仓库的构建产物；压测别的版本时不拦下来，进程里就有两份内核，量出来的是两份之和。
 *          故在子进程里注册一个解析钩子，把 `@yunzai-ng/core`（含 `/testing`）一律指到选定的那份。
 */
import { existsSync, readFileSync } from "node:fs"
import { copyFile, mkdir, readdir, rm, symlink, unlink } from "node:fs/promises"
import { register } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

/** 本仓库根目录 */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/**
 * 官方插件：链接名 → 与本仓库并列的 `repos/` 下的候选目录（须已构建）
 *
 * 链接名取插件名：OneBot 适配器的本地目录可能还叫旧名。
 */
export const OFFICIAL = {
  webui: ["webui-plugin"],
  "adapter-onebot": ["adapter-onebot", "adapter-napcat"],
  "renderer-puppeteer": ["renderer-puppeteer"],
  steward: ["steward-plugin"]
}

/**
 * 选定内核的两个入口
 * @param dir 内核包目录，或装着它的目录（其下有 `node_modules/@yunzai-ng/core`）；省略即本仓库的构建产物
 * @returns 主入口与 `/testing` 入口的 file URL，以及版本号
 */
export function coreTargets(dir) {
  let pkg = dir === undefined ? join(ROOT, "packages", "core") : resolve(dir)
  if (!existsSync(join(pkg, "package.json")) || existsSync(join(pkg, "node_modules", "@yunzai-ng", "core"))) {
    pkg = join(pkg, "node_modules", "@yunzai-ng", "core")
  }
  const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"))
  const entry = sub => {
    const target = manifest.exports?.[sub]
    const file = typeof target === "string" ? target : (target?.import ?? target?.default)
    if (typeof file !== "string") throw new Error(`${pkg} 的 exports 里没有 ${sub}`)
    return pathToFileURL(join(pkg, file)).href
  }
  return { version: manifest.version, core: entry("."), testing: entry("./testing") }
}

/** 解析钩子：在加载器线程里跑，故写成自包含的模块源码 */
const HOOK = `
let map = {}
export async function initialize(data) { map = data }
export async function resolve(specifier, context, next) {
  const hit = map[specifier]
  return hit === undefined ? next(specifier, context) : { url: hit, shortCircuit: true }
}
`

/**
 * 让这个进程里的 `@yunzai-ng/core` 都解析到选定的那份
 * @param targets `coreTargets()` 的结果
 */
export function pinCore(targets) {
  register(`data:text/javascript,${encodeURIComponent(HOOK)}`, {
    data: { "@yunzai-ng/core": targets.core, "@yunzai-ng/core/testing": targets.testing }
  })
}

/**
 * 把官方插件放进一个目录
 *
 * **插件目录本身是真目录，里面的子目录才是链接、文件是复制。** 0.7.0 之前的内核扫插件时不认链接目录，
 * 整个插件链过去就一个都扫不到，与新版对比的就成了「纯内核」。
 * @param dir 目标目录（会被创建）
 * @param only 只放这几个；省略即全部
 * @returns 建下的链接路径，拆时用
 */
export async function linkOfficial(dir, only) {
  const links = []
  for (const [name, candidates] of Object.entries(OFFICIAL)) {
    if (only !== undefined && !only.includes(name)) continue
    const src = candidates.map(c => join(ROOT, "..", "repos", c)).find(p => existsSync(join(p, "dist", "index.js")))
    if (src === undefined) throw new Error(`官方插件 ${name} 没找到已构建的仓库（找过 repos/${candidates.join("、repos/")}）`)
    const target = join(dir, name)
    await mkdir(target, { recursive: true })
    for (const entry of await readdir(src, { withFileTypes: true })) {
      if (entry.name === ".git") continue
      const from = join(src, entry.name)
      if (entry.isFile()) await copyFile(from, join(target, entry.name))
      else {
        await symlink(from, join(target, entry.name), "junction")
        links.push(join(target, entry.name))
      }
    }
  }
  return links
}

/**
 * 先拆掉 `linkOfficial` 建的链接，再删目录：递归删除万一顺着链接走，删掉的就是插件仓库本身
 * @param dir 目录
 * @param links 链接路径
 */
export async function unlinkOfficial(dir, links) {
  for (const link of links) await unlink(link)
  await rm(dir, { recursive: true, force: true })
}

/**
 * 模块职责：把内核打成少数几个 ESM 文件，连同启动必经的纯 JS 依赖
 * 依赖方向：esbuild；读 packages/core/src，写 packages/core/dist
 * 生命周期：`pnpm run build` 在 tsc 之后调一次；`--watch` 时常驻
 * 注意事项：tsc 只出 .d.ts（core 的 tsconfig 设了 emitDeclarationOnly），.js 全由这里出。
 *
 *          打包的理由是**文件数**：内核 69 个模块加 yaml、fastify、ws 的几百个文件逐个解析、打开、编译，
 *          Windows 上还要过一遍杀毒扫描，合起来占带面板启动的大半。合成几个文件后同样的代码只读几次盘。
 *
 *          不打包的：原生模块（better-sqlite3、classic-level）、ws 的可选原生加速、启动后才预载的 undici、
 *          croner，以及工作区里的类型包。它们照旧从 node_modules 加载。
 *
 *          代价：打进来的依赖随内核发版才更新，使用者 `npm update` 改不动它们。
 *          打进来的包的许可证汇总在 dist/THIRD-PARTY-LICENSES.txt。
 *
 * 用法：node scripts/bundle.mjs [--watch]
 */
import { spawn } from "node:child_process"
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import * as esbuild from "esbuild"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const CORE = join(ROOT, "packages", "core")
const DIST = join(CORE, "dist")
const WATCH = process.argv.includes("--watch")

/** 内核源码里直接 import、要打进来的依赖；它们自己的依赖一并打进来 */
const BUNDLED = new Set(["yaml", "fastify", "@fastify/websocket", "@fastify/send"])

/** 依赖内部也不打包的：可选原生加速，装没装都得能跑 */
const NEVER = new Set(["bufferutil", "utf-8-validate"])

/**
 * 取裸模块名的包名部分
 * @param spec import 说明符
 * @returns 包名
 */
function packageName(spec) {
  const parts = spec.split("/")
  return spec.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]
}

/** 决定哪些裸模块留在外面 */
const externals = {
  name: "core-externals",
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, args => {
      if (args.path.startsWith("node:")) return { external: true }
      const name = packageName(args.path)
      if (NEVER.has(name)) return { external: true }
      const fromCore = !args.importer.includes(`${sep}node_modules${sep}`)
      if (fromCore && !BUNDLED.has(name)) return { external: true }
      return undefined
    })
  }
}

/** 删掉 dist 里上一轮留下的 .js / .js.map（.d.ts 归 tsc 管） */
function cleanJs(dir) {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) cleanJs(path)
    else if (/\.js(\.map)?$/.test(entry.name)) rmSync(path)
  }
}

/**
 * 把打进来的每个包的许可证汇总成一个文件
 * @param metafile esbuild 的 metafile
 */
function writeLicenses(metafile) {
  const roots = new Map()
  for (const input of Object.keys(metafile.inputs)) {
    const m = /^(.*node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/.exec(input.replaceAll("/", sep))
    if (m) roots.set(resolve(CORE, m[1]), true)
  }
  const blocks = []
  for (const dir of [...roots.keys()].sort()) {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
    const file = readdirSync(dir).find(f => /^licen[cs]e/i.test(f))
    const text = file ? readFileSync(join(dir, file), "utf8").trim() : `License: ${pkg.license ?? "未声明"}`
    blocks.push(`${pkg.name}@${pkg.version}\n${"-".repeat(60)}\n${text}\n`)
  }
  writeFileSync(join(DIST, "THIRD-PARTY-LICENSES.txt"), blocks.join("\n"), "utf8")
}

/** @type {import("esbuild").BuildOptions} */
const options = {
  absWorkingDir: CORE,
  entryPoints: { index: "src/index.ts", "testing/index": "src/testing/index.ts" },
  outdir: "dist",
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node20",
  sourcemap: "linked",
  sourcesContent: false,
  keepNames: true,
  metafile: true,
  chunkNames: "chunks/[name]-[hash]",
  logLevel: "warning",
  // 打进来的 CommonJS 依赖会调 require（内置模块、可选依赖），ESM 里要自己备一个
  banner: { js: 'import { createRequire as __yzngRequire } from "node:module"; const require = __yzngRequire(import.meta.url);' },
  plugins: [
    externals,
    {
      name: "after",
      setup(build) {
        build.onStart(() => cleanJs(DIST))
        build.onEnd(result => {
          if (result.errors.length === 0 && result.metafile) writeLicenses(result.metafile)
        })
      }
    }
  ]
}

if (WATCH) {
  const ctx = await esbuild.context(options)
  await ctx.watch()
  console.error(`[bundle] 监听 ${relative(ROOT, CORE)}/src 中`)
  // .d.ts 与其他包的产物仍归 tsc；两边写的文件互不相交
  const tsc = spawn(process.execPath, [join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-b", "tsconfig.build.json", "--watch", "--preserveWatchOutput"], {
    cwd: ROOT,
    stdio: "inherit"
  })
  tsc.on("exit", code => process.exit(code ?? 0))
} else {
  await esbuild.build(options)
}

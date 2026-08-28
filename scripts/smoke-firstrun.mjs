#!/usr/bin/env node
/**
 * 模块职责：首次启动门禁 —— 断言内核在一个空主目录上零插件启动并正常停机
 * 依赖方向：只依赖 `packages/core` 的构建产物，不导入任何插件
 * 生命周期：一次性脚本，由 `pnpm run verify` 调用；起停一次后删除临时主目录
 * 注意事项：单元测试各自替换配置与环境，而"全新解压、配置目录为空"这条路径只有真起一次
 *          内核才会经过，插件曾在该路径上加载失败而单元测试全部通过。
 *
 *          此处不断言官方插件可加载：插件各自成库，其可加载性由插件仓库自己的 CI 负责
 *          （那里会 checkout 本仓库作为框架）。反过来在本仓库断言，需要一个指向仓库外的
 *          路径，只在作者本机成立。
 *
 * 用法：node scripts/smoke-firstrun.mjs
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"

/** 仅关闭服务，其余项使用缺省值 */
const CONFIG_YAML = "server:\n  enable: false\n"

/**
 * 在一个全新主目录上起停一次
 * @returns 插件状态列表与加载失败明细
 */
async function boot() {
  const { createApp } = await import("../packages/core/dist/index.js")
  const home = await mkdtemp(join(tmpdir(), "yzng-firstrun-"))
  await mkdir(join(home, "config"), { recursive: true })
  await writeFile(join(home, "config", "yunzai.yaml"), CONFIG_YAML, "utf8")

  const app = await createApp({ home, console: false, watchConfig: false })
  try {
    const report = await app.start()
    return {
      plugins: app.plugins.list().map(p => ({ name: p.name, status: p.status, error: p.error })),
      failed: report.failed
    }
  } finally {
    await app.stop()
    await rm(home, { recursive: true, force: true })
  }
}

/** 入口 */
async function main() {
  const { plugins, failed } = await boot()
  const problems = []
  if (plugins.length > 0) {
    problems.push(`未预置插件目录却加载到 ${plugins.length} 个插件：${plugins.map(p => p.name).join("、")}`)
  }
  // `failed` 的项是 `SkippedPlugin`（字段为 `reason`），与 `plugins.list()` 的 `PluginState`
  // （字段为 `error`）形状不同 —— 取错字段会把原因印成 undefined
  for (const f of failed) problems.push(`零插件启动出现失败项：${f.name} —— ${f.reason}`)

  if (problems.length > 0) {
    console.error("✗ 零插件启动")
    for (const p of problems) console.error(`  · ${p}`)
    process.exitCode = 1
    return
  }
  console.log("✓ 零插件启动")
}

await main()

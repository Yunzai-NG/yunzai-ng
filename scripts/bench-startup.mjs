/**
 * 模块职责：启动耗时基线 —— 从进程启动到 `app.start()` 返回花了多少 CPU 时间，以及启动后的 heap
 * 依赖方向：依赖 bench-core.mjs；内核取本仓库的构建产物，或 `--core` 给的那份
 * 生命周期：一次性脚本。每一次测量都 fork 一个干净的子进程
 * 注意事项：**取 CPU 时间而非墙钟。** 本机常有别的进程把 CPU 打满，墙钟时间随之忽长忽短；`process.cpuUsage()`
 *          只算本进程，含 Node 自身启动。给了多份内核时**交替**跑，每份取中位数，免得机器忙闲的时段
 *          恰好落在某一份上。
 *
 * 用法：node scripts/bench-startup.mjs [--core <目录>]... [--rounds 7]
 */
import { spawn } from "node:child_process"
import { createServer } from "node:net"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import v8 from "node:v8"
import vm from "node:vm"
import { ROOT, coreTargets, linkOfficial, pinCore, unlinkOfficial } from "./bench-core.mjs"

const SELF = fileURLToPath(import.meta.url)
const RESULT_TAG = "#STARTUP-RESULT#"

/** 场景：服务器开不开、带不带官方插件 */
const SCENARIOS = {
  bare: { title: "纯内核，不开服务器", server: false, official: false },
  server: { title: "纯内核，开服务器", server: true, official: false },
  panel: { title: "内核 + 面板（webui）", server: true, official: ["webui"] },
  official: { title: "内核 + 四个官方插件", server: true, official: true }
}

/**
 * 取一个本机空闲端口
 * @returns 端口号
 */
function freePort() {
  return new Promise((done, fail) => {
    const probe = createServer()
    probe.on("error", fail)
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address()
      probe.close(() => done(port))
    })
  })
}

/**
 * 子进程：起一次应用并量
 * @param name 场景名
 * @param coreDir 内核目录
 */
async function measure(name, coreDir) {
  const scenario = SCENARIOS[name]
  const targets = coreTargets(coreDir)
  pinCore(targets)
  const home = await mkdtemp(join(tmpdir(), "yzng-startup-"))
  await mkdir(join(home, "config"), { recursive: true })
  const server = scenario.server
    ? ["  enable: true", "  host: 127.0.0.1", `  port: ${await freePort()}`, "  token: bench-token-0123456789"]
    : ["  enable: false"]
  await writeFile(join(home, "config", "yunzai.yaml"), ["store:", "  driver: memory", "  sqlite: false", "server:", ...server, ""].join("\n"), "utf8")
  const only = Array.isArray(scenario.official) ? scenario.official : undefined
  const linked = scenario.official ? await linkOfficial(join(home, "bundled"), only) : []

  // 以上是压测自己的准备，不算进启动：从这里起才是使用者那边会发生的事
  const before = process.cpuUsage()
  const { createApp } = await import(targets.core)
  const app = await createApp({ home, console: false, watchConfig: false, builtinDirs: scenario.official ? [join(home, "bundled")] : [] })
  await app.start()
  const cpu = process.cpuUsage(before)
  const sinceBoot = process.cpuUsage()

  v8.setFlagsFromString("--expose-gc")
  const gc = vm.runInNewContext("gc")
  for (let i = 0; i < 3; i++) {
    gc()
    await new Promise(r => setTimeout(r, 100))
  }
  const heap = Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 10) / 10
  const plugins = app.plugins.list().map(p => `${p.name}:${p.status}`)

  await app.stop()
  if (linked.length > 0) await unlinkOfficial(join(home, "bundled"), linked)
  await rm(home, { recursive: true, force: true })
  const ms = usage => Math.round((usage.user + usage.system) / 1000)
  console.log(RESULT_TAG + JSON.stringify({ name, core: targets.version, start: ms(cpu), total: ms(sinceBoot), heap, plugins }))
}

/**
 * fork 一次测量
 * @param name 场景名
 * @param coreDir 内核目录
 * @returns 结果
 */
function fork(name, coreDir) {
  return new Promise((done, fail) => {
    const args = [SELF, "--measure", name, ...(coreDir === undefined ? [] : ["--core", coreDir])]
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "inherit"] })
    let out = ""
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", chunk => (out += chunk))
    child.on("error", fail)
    child.on("close", code => {
      const line = out.split(/\r?\n/).find(l => l.startsWith(RESULT_TAG))
      if (line === undefined) fail(new Error(`${name} 没报回结果（退出码 ${code}）：\n${out.trim() || "（空）"}`))
      else done(JSON.parse(line.slice(RESULT_TAG.length)))
    })
  })
}

/** @param list 数 @returns 中位数 */
const median = list => {
  const sorted = [...list].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

async function main() {
  const argv = process.argv
  if (argv.includes("--measure")) {
    const at = argv.indexOf("--core")
    await measure(argv[argv.indexOf("--measure") + 1], at === -1 ? undefined : argv[at + 1])
    return
  }

  const cores = argv.flatMap((arg, i) => (arg === "--core" ? [argv[i + 1]] : []))
  if (cores.length === 0) cores.push(undefined)
  const rounds = Number(argv[argv.indexOf("--rounds") + 1]) || 7
  const labels = cores.map(dir => coreTargets(dir).version)
  console.log(`Node ${process.version} / ${process.platform}-${process.arch}，内核 ${labels.join(" / ")}，每格 ${rounds} 次取中位数`)

  const results = {}
  for (const name of Object.keys(SCENARIOS)) {
    for (let r = 0; r < rounds; r++) {
      for (let c = 0; c < cores.length; c++) {
        const one = await fork(name, cores[c])
        ;((results[name] ??= {})[labels[c]] ??= []).push(one)
      }
    }
    for (const label of labels) {
      const runs = results[name][label]
      const notLoaded = runs[0].plugins.filter(p => !p.endsWith(":loaded"))
      console.log(
        `${SCENARIOS[name].title}  内核 ${label}：start ${median(runs.map(x => x.start))} ms，进程合计 ${median(runs.map(x => x.total))} ms，` +
          `heap ${median(runs.map(x => x.heap))} MB${notLoaded.length > 0 ? `  未加载：${notLoaded.join("、")}` : ""}`
      )
    }
  }

  const out = join(ROOT, "..", "temp", "bench-startup.json")
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, JSON.stringify({ node: process.version, at: new Date().toISOString(), rounds, results }, undefined, 2), "utf8")
  console.log(`明细已写入 ${out}`)
}

await main()

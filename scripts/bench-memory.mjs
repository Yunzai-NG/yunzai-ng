/**
 * 模块职责：内存基线压测 —— 空载 RSS、1 万条消息后的 RSS、GC 后的回落值
 * 依赖方向：只依赖 `packages/core` 的构建产物（`dist/`），不碰任何插件源码
 * 生命周期：一次性脚本。每个场景都 fork 一个干净的子进程跑，跑完删掉临时主目录
 * 注意事项：三条量法上的取舍，改数字之前先读：
 *
 *          1) **场景之间必须换进程**。同一进程里跑完场景一再跑场景二，V8 的堆
 *             已经长起来了（RSS 只涨不跌），场景二的"空载"会白白继承上一轮的水位。
 *             所以父进程只负责调度与汇总，真正的测量都在子进程里。
 *
 *          2) **投递要限流**。`host.submit()` 是同步返回、内核异步处理的，
 *             一个 for 循环灌 1 万条会同时存在 1 万个事件对象 —— 那测的是
 *             "瞬时积压的峰值"，不是稳态占用。这里按 50 条一批、等上一批处理完
 *             再投下一批，对应真实聊天里消息陆续到达的形态。
 *
 *          3) **Mock 的发送记录要定期清**。`createMockAdapter()` 会把每一条发出去的
 *             消息留在数组里，那是测试替身的账，不该记到内核头上。
 *
 * 用法：node scripts/bench-memory.mjs        （跑全部场景并打印汇总）
 *      node scripts/bench-memory.mjs --scenario minimal   （子进程模式，只跑一个）
 */
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import v8 from "node:v8"
import vm from "node:vm"

/** 本脚本绝对路径 */
const SELF = fileURLToPath(import.meta.url)

/** 本仓库根目录 */
const ROOT = resolve(dirname(SELF), "..")

/** 压测消息条数，来自计划里的"1 万条消息压测" */
const TOTAL = 10_000

/** 每批投递条数，见文件头第 2 条 */
const BATCH = 50

/** 每处理多少条清一次 Mock 的发送记录，见文件头第 3 条 */
const RESET_EVERY = 1000

/** 子进程把结果写在这一行前缀之后，父进程据此提取（其余 stdout 原样透传） */
const RESULT_TAG = "#BENCH-RESULT#"

/** 一批消息等待处理完的上限毫秒 */
const BATCH_TIMEOUT = 120_000

/**
 * 拿到一个可调用的 gc
 *
 * 刻意不要求外部附加 `--expose-gc`：本脚本将以 CI 与人工复现两种方式运行，
 * 少一个必须记住的命令行参数就少一次"忘了加参数于是 GC 那一列是空的"。
 */
v8.setFlagsFromString("--expose-gc")

/** 触发一次完整 GC */
const gc = vm.runInNewContext("gc")

/** 全部场景 */
const SCENARIOS = {
  minimal: {
    title: "纯内核（不加载任何插件）",
    builtin: false
  },
  bundled: {
    title: "内核 + 三个官方插件",
    builtin: true
  }
}

/** 压测用的内核配置：内存 KV + 关掉面板，把被测面收窄到消息管线本身 */
const CONFIG_YAML = [
  "store:",
  "  driver: memory",
  "  sqlite: false",
  "server:",
  "  enable: false",
  ""
].join("\n")

/**
 * 睡一小会儿
 * @param ms 毫秒
 * @returns 到点兑现
 */
function sleep(ms) {
  return new Promise(done => setTimeout(done, ms))
}

/**
 * 取一份内存快照（单位 MB，保留一位小数）
 * @returns rss / heapUsed / external
 */
function sample() {
  const m = process.memoryUsage()
  const mb = bytes => Math.round((bytes / 1024 / 1024) * 10) / 10
  return { rss: mb(m.rss), heapUsed: mb(m.heapUsed), external: mb(m.external + m.arrayBuffers) }
}

/**
 * 反复 GC 直到读数稳定，再取快照
 *
 * 单次 gc() 之后马上读 RSS 常常还在半路上（弱引用回调、外部内存的归还都要一跳），
 * 于是同一份代码两次跑能差出十几 MB。这里连做三轮并留出让出时间。
 * @returns 稳定后的内存快照
 */
async function settled() {
  for (let i = 0; i < 3; i++) {
    gc()
    await sleep(120)
  }
  return sample()
}

/**
 * 等到条件成立
 * @param ok 判定函数
 * @param label 超时消息里的场景描述
 * @returns 成立时兑现
 */
async function waitUntil(ok, label) {
  const deadline = Date.now() + BATCH_TIMEOUT
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`等待超时（${label}）：管线在 ${BATCH_TIMEOUT}ms 内没把这一批处理完`)
    await sleep(0)
  }
}

/**
 * 跑一个场景，返回测量结果
 * @param name 场景名
 * @returns 测量结果对象
 */
async function runScenario(name) {
  const scenario = SCENARIOS[name]
  if (!scenario) throw new Error(`未知场景 ${name}，可选：${Object.keys(SCENARIOS).join(" / ")}`)

  const { createApp } = await import("../packages/core/dist/index.js")
  const { createMockAdapter } = await import("../packages/core/dist/testing/index.js")

  const home = await mkdtemp(join(tmpdir(), "yzng-bench-"))
  await mkdir(join(home, "config"), { recursive: true })
  await writeFile(join(home, "config", "yunzai.yaml"), CONFIG_YAML, "utf8")

  const app = await createApp({
    home,
    console: false,
    watchConfig: false,
    builtinDirs: scenario.builtin ? [join(ROOT, "plugins")] : []
  })

  const mock = createMockAdapter()
  app.runtime.adapters.register(mock.provider, "bench")

  // 直接往路由与管线里登记，不为压测造一个插件目录：
  // 被测对象是"消息进 → 命令命中 → 回复出去"这条链路，插件加载是另一件事
  // （场景二已经在测它了）。`plugin: "bench"` 没有对应的已加载插件，
  // 分发器那边 `e.bind(undefined)` 是允许的 —— 只是这条命令用不了 e.render/e.prompt。
  app.runtime.router.register({
    plugin: "bench",
    patterns: ["#ping"],
    options: {},
    handler: async e => {
      await e.reply("pong")
    }
  })

  /** 已经走完整条管线的消息数（含未命中命令的） */
  let done = 0
  app.runtime.middlewares.register({
    plugin: "bench",
    // 计数放在 next() 之后：这样它数的是"处理完"而不是"收到"，
    // 否则限流会变成空转，测出来的是投递速度而不是处理速度
    fn: async (e, next) => {
      await next()
      done++
    },
    options: {}
  })

  await app.start()
  await app.runtime.accounts.create("mock", { selfId: "10000" })
  const plugins = app.plugins.list().map(p => `${p.name}:${p.status}${p.error === undefined ? "" : `（${p.error}）`}`)

  const idle = await settled()

  const started = Date.now()
  for (let i = 0; i < TOTAL; i += BATCH) {
    const n = Math.min(BATCH, TOTAL - i)
    for (let j = 0; j < n; j++) {
      const idx = i + j
      const uid = String(20_000 + (idx % 50))
      // 每 5 条里 1 条是命令：真实群聊里绝大多数消息是不命中任何命令的闲聊，
      // 但"命中并回复"那条路才是最贵的，两者都要走到
      if (idx % 5 === 0) mock.driver.receivePrivate("#ping", { uid })
      else mock.driver.receiveGroup(`闲聊消息 ${idx}`, { gid: String(700_000 + (idx % 20)), uid })
    }
    await waitUntil(() => done >= i + n, `${name} 第 ${i + n} 条`)
    if ((i + n) % RESET_EVERY === 0) mock.reset()
  }
  const cost = Date.now() - started

  const loadedPeak = sample()
  const after = await settled()

  const handled = app.runtime.dispatcher.handled
  await app.stop()
  await rm(home, { recursive: true, force: true })
  const stopped = await settled()

  return {
    scenario: name,
    title: scenario.title,
    plugins,
    total: TOTAL,
    handled,
    replies: Math.floor(TOTAL / 5),
    cost,
    perSecond: Math.round((TOTAL / cost) * 1000),
    idle,
    peak: loadedPeak,
    after,
    stopped
  }
}

/**
 * 在干净的子进程里跑一个场景
 * @param name 场景名
 * @returns 子进程报回来的结果
 */
function forkScenario(name) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [SELF, "--scenario", name], { stdio: ["ignore", "pipe", "inherit"] })
    let out = ""
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", chunk => {
      out += chunk
    })
    child.on("error", fail)
    child.on("close", code => {
      const line = out.split(/\r?\n/).find(l => l.startsWith(RESULT_TAG))
      if (line === undefined) {
        fail(new Error(`场景 ${name} 没报回结果（退出码 ${code}）。子进程输出：\n${out.trim() || "（空）"}`))
        return
      }
      done(JSON.parse(line.slice(RESULT_TAG.length)))
    })
  })
}

/**
 * 打印一行汇总
 * @param r 场景结果
 */
function printResult(r) {
  console.log(`\n${r.title}（插件 ${r.plugins.length === 0 ? "无" : r.plugins.join("、")}）`)
  console.log(`  空载        RSS ${r.idle.rss} MB   heap ${r.idle.heapUsed} MB`)
  console.log(`  ${r.total} 条后  RSS ${r.peak.rss} MB   heap ${r.peak.heapUsed} MB`)
  console.log(`  GC 后       RSS ${r.after.rss} MB   heap ${r.after.heapUsed} MB`)
  console.log(`  停机后      RSS ${r.stopped.rss} MB   heap ${r.stopped.heapUsed} MB`)
  console.log(`  耗时 ${r.cost}ms（${r.perSecond} 条/秒），分发器计数 ${r.handled}，回复 ${r.replies} 条`)
}

/** 入口 */
async function main() {
  const at = process.argv.indexOf("--scenario")
  if (at !== -1) {
    const name = process.argv[at + 1]
    const result = await runScenario(name)
    console.log(RESULT_TAG + JSON.stringify(result))
    return
  }

  console.log(`Node ${process.version} / ${process.platform}-${process.arch}，每场景 ${TOTAL} 条消息`)
  const results = []
  for (const name of Object.keys(SCENARIOS)) {
    console.log(`\n▶ 场景 ${name}…`)
    const result = await forkScenario(name)
    results.push(result)
    printResult(result)
  }

  const out = join(ROOT, "..", "temp", "bench-memory.json")
  await mkdir(dirname(out), { recursive: true })
  await writeFile(
    out,
    JSON.stringify({ node: process.version, platform: `${process.platform}-${process.arch}`, at: new Date().toISOString(), results }, undefined, 2),
    "utf8"
  )
  console.log(`\n明细已写入 ${out}`)
}

await main()


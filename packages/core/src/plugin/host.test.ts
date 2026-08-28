/**
 * 模块职责：插件宿主的加载 / 失败隔离 / 卸载 / 热重载测试
 * 依赖方向：测试文件，依赖 plugin/host、config/store、store、testing/fake
 * 生命周期：每个用例一套临时目录 + 一个宿主，afterEach 全部关闭
 * 注意事项：夹具插件是**确实写入磁盘后再 import 进来**的，而非在内存中构造对象。
 *          该链路（发现 → 导入 → 装配上下文 → setup → 回收）出现过的问题几乎均位于
 *          真实 import 的那一段：默认导出书写错误、语法错误、setup 无响应、
 *          卸载后模块缓存仍存在。构造替身对象无法覆盖这些情形。
 *
 *          临时目录中不存在 node_modules，夹具无法 `import "@yunzai-ng/core"`。
 *          因此夹具采用两条注入通道：
 *          1) 品牌标记使用 `Symbol.for("yunzai-ng.plugin")` —— 注册表符号，全进程共享；
 *          2) 需要 `s`（配置 schema）时从 `globalThis` 取测试注入的那一份 ——
 *             `instanceof Schema` 要求同一个类实例，只能以此方式传递。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { RuntimePaths } from "@yunzai-ng/types"
import { createConfigStore, type ConfigStore } from "../config/store.js"
import { s } from "../config/schema.js"
import { openKv, type KvStore } from "../store/index.js"
import { createEventBus, type CoreEventBus } from "./events.js"
import { createServiceRegistry, type ServiceRegistry } from "./services.js"
import { PluginHost, createPluginsView } from "./host.js"
import { fakeAppView, fakeHttp, fakeLogger, recordingHooks, type FakeLogger, type Recorded } from "../testing/fake.js"

/** 夹具与测试之间的共享通道 */
interface TestGlobals {
  /** 夹具插件写下的执行痕迹（顺序敏感的断言靠它） */
  __yzngMarks?: string[]
  /** 注入给夹具的 schema 构造器 */
  __yzngS?: typeof s
  /** 夹具回填的配置快照 */
  __yzngConfig?: unknown
}

/** 取共享全局 */
const shared = (): TestGlobals => globalThis as unknown as TestGlobals

/** 取执行痕迹数组 */
function marks(): string[] {
  const g = shared()
  g.__yzngMarks ??= []
  return g.__yzngMarks
}

/** 夹具里给对象打品牌的前缀代码 */
const BRAND = 'const brand = Symbol.for("yunzai-ng.plugin")\n'

/** 一个宿主及其周边 */
interface Harness {
  /** 宿主 */
  host: PluginHost
  /** 插件目录 */
  pluginsDir: string
  /** 配置目录 */
  configDir: string
  /** 日志 */
  logger: FakeLogger
  /** 子系统录制结果 */
  recorded: Recorded
  /** 服务注册表 */
  services: ServiceRegistry
  /** 事件总线 */
  events: CoreEventBus
  /** 配置仓库 */
  config: ConfigStore
  /** KV */
  kv: KvStore
  /** 根临时目录 */
  root: string
}

let harness: Harness | undefined

/**
 * 起一套宿主
 * @param opts 可选参数
 * @param opts.setupTimeout setup 超时毫秒
 * @param opts.disabled 禁用的插件名
 * @returns 宿主与周边
 */
async function makeHarness(opts: { setupTimeout?: number; disabled?: string[] } = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "yzng-host-"))
  const paths: RuntimePaths = {
    home: root,
    config: join(root, "config"),
    data: join(root, "data"),
    logs: join(root, "logs"),
    temp: join(root, "temp"),
    plugins: join(root, "plugins"),
    runtime: root,
    cache: join(root, "cache")
  }
  for (const dir of Object.values(paths)) await mkdir(dir, { recursive: true })

  const logger = fakeLogger()
  const { hooks, recorded } = recordingHooks()
  const config = createConfigStore({ dir: paths.config, logger, watch: false })
  // memory 驱动：用例只关心"命名空间给对了没"，不需要真的落盘
  const kv = await openKv({ dir: join(root, "kv"), driver: "memory", logger })
  const services = createServiceRegistry()
  const events = createEventBus({ logger })

  const host = new PluginHost({
    paths,
    logger,
    config,
    kv,
    http: fakeHttp(),
    services,
    events,
    hooks,
    app: () => fakeAppView(),
    setupTimeout: opts.setupTimeout ?? 2000,
    ...(opts.disabled ? { disabled: opts.disabled } : {})
  })

  harness = { host, pluginsDir: paths.plugins, configDir: paths.config, logger, recorded, services, events, config, kv, root }
  return harness
}

/**
 * 往插件目录里写一个插件
 * @param h 宿主套件
 * @param name 目录名
 * @param body 模块源码
 * @param manifest package.json 内容；省略则该目录不含 package.json
 */
async function writePlugin(
  h: Harness,
  name: string,
  body: string,
  manifest?: Record<string, unknown>
): Promise<void> {
  const dir = join(h.pluginsDir, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "index.js"), body, "utf8")
  if (manifest !== undefined) await writeFile(join(dir, "package.json"), JSON.stringify(manifest), "utf8")
}

beforeEach(() => {
  shared().__yzngMarks = []
  shared().__yzngS = s
  delete shared().__yzngConfig
})

afterEach(async () => {
  if (!harness) return
  const h = harness
  harness = undefined
  await h.host.dispose()
  h.config.dispose()
  h.events.close()
  await h.kv.close()
  await rm(h.root, { recursive: true, force: true })
})

describe("PluginHost 加载", () => {
  it("加载一个正常插件，状态与计数都对得上", async () => {
    const h = await makeHarness()
    await writePlugin(
      h,
      "ok",
      `${BRAND}export default {
        name: "ok",
        version: "1.2.3",
        description: "正常插件",
        setup(ctx) {
          ctx.command("#ping").action(() => undefined)
          globalThis.__yzngMarks.push("ok:setup")
        },
        [brand]: true
      }`
    )

    const report = await h.host.loadAll()

    expect(report.loaded).toEqual(["ok"])
    expect(report.failed).toEqual([])
    expect(h.host.size).toBe(1)
    expect(marks()).toEqual(["ok:setup"])

    const state = h.host.get("ok")
    expect(state).toMatchObject({
      name: "ok",
      version: "1.2.3",
      description: "正常插件",
      status: "loaded",
      commands: 1,
      builtin: false
    })
    expect(h.recorded.commands).toHaveLength(1)
  })

  it("`homepage` 从 package.json 带出，供面板画「访问仓库」", async () => {
    const h = await makeHarness()
    await writePlugin(h, "withhome", `export default { name: "withhome", setup() {} }`, {
      name: "withhome",
      version: "1.0.0",
      homepage: "https://example.com/repo"
    })

    await h.host.loadAll()

    expect(h.host.get("withhome")?.homepage).toBe("https://example.com/repo")
  })

  it("`definePlugin` 里写的 homepage 优先于 package.json", async () => {
    const h = await makeHarness()
    await writePlugin(
      h,
      "bothhome",
      `export default { name: "bothhome", homepage: "https://from-define", setup() {} }`,
      { name: "bothhome", homepage: "https://from-manifest" }
    )

    await h.host.loadAll()

    expect(h.host.get("bothhome")?.homepage).toBe("https://from-define")
  })

  it("**取不到主页时该字段不出现** —— 按钮在而点了没反应，比按钮不在更糟", async () => {
    const h = await makeHarness()
    await writePlugin(h, "nohome", `export default { name: "nohome", setup() {} }`, { name: "nohome" })

    await h.host.loadAll()

    const state = h.host.get("nohome")
    expect(state).not.toHaveProperty("homepage")
  })

  it("没走 definePlugin 的手写定义也接受，但留一条 debug 提示", async () => {
    const h = await makeHarness()
    await writePlugin(h, "loose", `export default { name: "loose", setup() {} }`)

    const report = await h.host.loadAll()

    expect(report.loaded).toEqual(["loose"])
    expect(h.logger.lines.some(l => l.includes("definePlugin"))).toBe(true)
  })

  it("未在 definePlugin 中声明版本时，日志、状态与 ctx 三处一致地取 package.json 的版本", async () => {
    const h = await makeHarness()
    await writePlugin(
      h,
      "panel",
      `${BRAND}export default {
        name: "panel",
        setup(ctx) { globalThis.__yzngMarks.push("ctx:" + ctx.version) },
        [brand]: true
      }`,
      { name: "@scope/panel-plugin", version: "2.3.4", main: "index.js" }
    )

    await h.host.loadAll()

    // 三处必须给出同一个版本号。曾经日志只看 definition.version 而另两处回落到
    // package.json：未重复声明版本的插件在日志里是 0.0.0、在面板里是 2.3.4
    expect(h.host.get("panel")?.version).toBe("2.3.4")
    expect(marks()).toEqual(["ctx:2.3.4"])
    expect(h.logger.lines.some(l => l.includes("插件 panel@2.3.4 已加载"))).toBe(true)
  })
  it("插件名以定义里的 name 为准，与目录名无关", async () => {
    const h = await makeHarness()
    // 目录名故意与插件名不同：用户 clone 出来的目录名很随意（带 -main 后缀是常态）
    //
    // 注：这里不用中文目录名 —— vitest 的模块运行器不会对 file:// URL 做百分号解码，
    // 非 ASCII 目录在测试环境里必然 "Does the file exist?"。纯 Node 下无此问题，
    // 别为这个去改 host.ts。
    await writePlugin(h, "some-plugin-main", `export default { name: "real-name", setup() {} }`)

    const report = await h.host.loadAll()
    expect(report.loaded).toEqual(["real-name"])
    expect(h.host.get("real-name")).toBeDefined()
  })

  it("被禁用的插件不加载", async () => {
    const h = await makeHarness({ disabled: ["nope"] })
    await writePlugin(h, "nope", `export default { name: "nope", setup() {} }`)

    const report = await h.host.loadAll()
    expect(report.loaded).toEqual([])
    expect(h.host.size).toBe(0)
  })

  it("重复 loadAll 不会把同一个插件装两遍", async () => {
    const h = await makeHarness()
    await writePlugin(
      h,
      "ok",
      `export default { name: "ok", setup(ctx) { ctx.command("#a") } }`
    )

    await h.host.loadAll()
    await h.host.loadAll()

    expect(h.host.size).toBe(1)
    expect(h.recorded.commands).toHaveLength(1)
    expect(h.logger.lines.some(l => l.includes("忽略重复加载"))).toBe(true)
  })
})

describe("PluginHost 失败隔离", () => {
  it("一个插件 setup 抛错，其余插件照常加载", async () => {
    const h = await makeHarness()
    await writePlugin(
      h,
      "boom",
      `export default {
        name: "boom",
        setup(ctx) {
          ctx.command("#boom")
          throw new Error("插件自身执行失败")
        }
      }`
    )
    await writePlugin(h, "ok", `export default { name: "ok", setup(ctx) { ctx.command("#ok") } }`)

    const report = await h.host.loadAll()

    expect(report.loaded).toEqual(["ok"])
    expect(report.failed.map(f => f.name)).toEqual(["boom"])
    expect(report.failed[0]?.reason).toContain("插件自身执行失败")
    expect(h.host.get("boom")).toMatchObject({ status: "error" })

    // 关键：失败的插件在 setup 中已完成的命令注册必须被回收，
    // 否则路由里留着一条"点了没反应"的命令
    expect(h.recorded.commands.map(c => c.patterns[0])).toEqual(["#ok"])
  })

  it("setup 超时会被判失败，且已完成的注册一并回收", async () => {
    const h = await makeHarness({ setupTimeout: 120 })
    await writePlugin(
      h,
      "slow",
      `export default {
        name: "slow",
        setup(ctx) {
          ctx.command("#slow")
          return new Promise(() => {})
        }
      }`
    )

    const report = await h.host.loadAll()

    expect(report.loaded).toEqual([])
    expect(report.failed[0]?.name).toBe("slow")
    expect(report.failed[0]?.reason).toContain("超时")
    expect(h.recorded.commands).toEqual([])
    expect(h.logger.lines.some(l => l.includes("app/ready"))).toBe(true)
  })

  it("语法写错的插件只记错误，不影响启动", async () => {
    const h = await makeHarness()
    await writePlugin(h, "broken", `export default { name: "broken", setup() { <<< } }`)
    await writePlugin(h, "ok", `export default { name: "ok", setup() {} }`)

    const report = await h.host.loadAll()

    expect(report.loaded).toEqual(["ok"])
    expect(report.failed.map(f => f.name)).toEqual(["broken"])
    expect(h.logger.lines.some(l => l.includes("broken") && l.includes("导入出错"))).toBe(true)
  })

  it("没有默认导出时，提示怎么写才对", async () => {
    const h = await makeHarness()
    await writePlugin(h, "nodefault", `export const something = 1`)

    const report = await h.host.loadAll()
    expect(report.failed[0]?.reason).toContain("export default definePlugin")
  })

  it("默认导出不像插件时也给出可照做的提示", async () => {
    const h = await makeHarness()
    await writePlugin(h, "weird", `export default 42`)

    const report = await h.host.loadAll()
    expect(report.failed[0]?.reason).toContain("definePlugin({ name, setup })")
  })

  it("依赖没安装的插件被跳过，原因说清怎么办", async () => {
    const h = await makeHarness()
    await writePlugin(
      h,
      "needs",
      `export default { name: "needs", dependencies: ["not-installed"], setup() {} }`
    )

    const report = await h.host.loadAll()

    expect(report.loaded).toEqual([])
    expect(report.failed[0]?.reason).toContain("not-installed")
    expect(h.host.get("needs")).toMatchObject({ status: "error" })
  })

  it("依赖装了但加载失败时，依赖方一并跳过（不留半残状态）", async () => {
    const h = await makeHarness()
    await writePlugin(h, "base", `export default { name: "base", setup() { throw new Error("底座执行失败") } }`)
    await writePlugin(
      h,
      "child",
      `export default { name: "child", dependencies: ["base"], setup(ctx) { ctx.command("#child") } }`
    )

    const report = await h.host.loadAll()

    expect(report.loaded).toEqual([])
    expect(h.host.get("child")?.error).toContain("依赖的插件未成功加载")
    expect(h.host.get("child")?.error).toContain("base")
    expect(h.recorded.commands).toEqual([])
  })
})

describe("PluginHost 加载顺序", () => {
  it("依赖先于依赖方 setup，即使依赖方优先级更高", async () => {
    const h = await makeHarness()
    // user 的 priority 更小（更想早加载），但它依赖 base —— 依赖必须赢
    await writePlugin(
      h,
      "base",
      `export default { name: "base", priority: 200, setup() { globalThis.__yzngMarks.push("base") } }`
    )
    await writePlugin(
      h,
      "user",
      `export default { name: "user", priority: 1, dependencies: ["base"], setup() { globalThis.__yzngMarks.push("user") } }`
    )

    await h.host.loadAll()
    expect(marks()).toEqual(["base", "user"])
  })

  it("无依赖时按 priority 排，与文件名字典序无关", async () => {
    const h = await makeHarness()
    await writePlugin(
      h,
      "a-late",
      `export default { name: "a-late", priority: 200, setup() { globalThis.__yzngMarks.push("a-late") } }`
    )
    await writePlugin(
      h,
      "z-early",
      `export default { name: "z-early", priority: 1, setup() { globalThis.__yzngMarks.push("z-early") } }`
    )

    await h.host.loadAll()
    // 按 priority 排而非文件名，否则会是 ["a-late", "z-early"]
    expect(marks()).toEqual(["z-early", "a-late"])
  })
})

describe("PluginHost 配置", () => {
  it("声明 configSchema 的插件拿到真配置文件与默认值", async () => {
    const h = await makeHarness()
    await writePlugin(
      h,
      "cfg",
      `${BRAND}const s = globalThis.__yzngS
      export default {
        name: "cfg",
        configSchema: s.object({ cookie: s.string().default("空"), retry: s.number().default(3) }),
        setup(ctx) { globalThis.__yzngConfig = ctx.config.get() },
        [brand]: true
      }`
    )

    await h.host.loadAll()

    expect(shared().__yzngConfig).toEqual({ cookie: "空", retry: 3 })
    expect(h.config.get("cfg")).toBeDefined()
    // 面板据此决定是否给这个插件展示配置入口
    expect(h.host.get("cfg")?.configured).toBe(true)
  })

  it("没声明 configSchema 时 get() 给空对象，写操作报错并说明办法", async () => {
    const h = await makeHarness()
    await writePlugin(
      h,
      "nocfg",
      `export default {
        name: "nocfg",
        setup(ctx) {
          globalThis.__yzngConfig = ctx.config.get()
          globalThis.__yzngMarks.push("get-ok")
          ctx.config.patch({ a: 1 }).catch(err => globalThis.__yzngMarks.push(err.message))
        }
      }`
    )

    await h.host.loadAll()
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(shared().__yzngConfig).toEqual({})
    expect(marks()[0]).toBe("get-ok")
    expect(marks()[1]).toContain("configSchema")
    expect(h.host.get("nocfg")?.configured).toBe(false)
  })

  it("configSchema 不是 s.object(...) 的产物时忽略并告警", async () => {
    const h = await makeHarness()
    await writePlugin(
      h,
      "badcfg",
      `export default { name: "badcfg", configSchema: { type: "object" }, setup() {} }`
    )

    const report = await h.host.loadAll()
    expect(report.loaded).toEqual(["badcfg"])
    expect(h.logger.lines.some(l => l.includes("badcfg") && l.includes("s.object"))).toBe(true)
  })
})

describe("PluginHost 卸载", () => {
  /** 一个把各种能力都用上的插件 */
  const FULL = `export default {
    name: "full",
    setup(ctx) {
      ctx.command("#a")
      ctx.middleware(async (e, next) => next())
      ctx.cron("0 0 8 * * *", () => {})
      ctx.on("app/ready", () => {})
      ctx.provide("full.api", { x: 1 })
      return () => globalThis.__yzngMarks.push("cleanup")
    }
  }`

  it("卸载后各子系统里一条不剩，setup 返回的清理函数也被调用", async () => {
    const h = await makeHarness()
    await writePlugin(h, "full", FULL)
    await h.host.loadAll()

    expect(await h.host.unload("full")).toBe(true)

    expect(h.host.size).toBe(0)
    expect(h.host.get("full")).toBeUndefined()
    expect(h.recorded.commands).toEqual([])
    expect(h.recorded.middlewares).toEqual([])
    expect(h.recorded.tasks).toEqual([])
    expect(h.services.size).toBe(0)
    expect(h.events.count("app/ready")).toBe(0)
    expect(marks()).toContain("cleanup")
  })

  it("卸载未加载的插件返回 false", async () => {
    const h = await makeHarness()
    expect(await h.host.unload("ghost")).toBe(false)
  })

  it("绕过 ctx 直接注册的服务在卸载时被兜底清扫并告警", async () => {
    const h = await makeHarness()
    await writePlugin(h, "ok", `export default { name: "ok", setup() {} }`)
    await h.host.loadAll()

    // 模拟越界写法：插件不知从哪拿到注册表，绕过 ctx 自己注册
    h.services.provide("sneaky", 1, "ok")
    await h.host.unload("ok")

    expect(h.services.has("sneaky")).toBe(false)
    expect(h.logger.lines.some(l => l.includes("未经 ctx 注册"))).toBe(true)
  })

  it("dispose 按逆加载顺序卸载，依赖方先走", async () => {
    const h = await makeHarness()
    await writePlugin(
      h,
      "base",
      `export default { name: "base", setup() { return () => globalThis.__yzngMarks.push("base-off") } }`
    )
    await writePlugin(
      h,
      "user",
      `export default { name: "user", dependencies: ["base"], setup() { return () => globalThis.__yzngMarks.push("user-off") } }`
    )
    await h.host.loadAll()

    expect(await h.host.dispose()).toBe(2)
    expect(marks()).toEqual(["user-off", "base-off"])
    expect(h.host.list()).toEqual([])
  })

  it("卸载会广播 plugin/unloaded", async () => {
    const h = await makeHarness()
    await writePlugin(h, "ok", `export default { name: "ok", setup() {} }`)
    await h.host.loadAll()

    h.events.on("plugin/unloaded", name => void marks().push(`event:${name}`), "test")
    await h.host.unload("ok")
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(marks()).toContain("event:ok")
  })
})

describe("PluginHost 热重载", () => {
  it("重载会重新读磁盘上的代码", async () => {
    const h = await makeHarness()
    await writePlugin(h, "hot", `export default { name: "hot", setup(ctx) { ctx.command("#v1") } }`)
    await h.host.loadAll()
    expect(h.recorded.commands.map(c => c.patterns[0])).toEqual(["#v1"])

    await writePlugin(h, "hot", `export default { name: "hot", setup(ctx) { ctx.command("#v2") } }`)
    expect(await h.host.reload("hot")).toBe(true)

    expect(h.recorded.commands.map(c => c.patterns[0])).toEqual(["#v2"])
    // 旧模块留在 Node 的 ESM 缓存里出不来，这条提示必须给
    expect(h.logger.lines.some(l => l.includes("累积内存"))).toBe(true)
  })

  it("声明了配置的插件可以反复重载（配置声明要跟着解除）", async () => {
    const h = await makeHarness()
    await writePlugin(
      h,
      "cfg",
      `${BRAND}const s = globalThis.__yzngS
      export default {
        name: "cfg",
        configSchema: s.object({ a: s.number().default(1) }),
        setup() {},
        [brand]: true
      }`
    )
    await h.host.loadAll()

    // 不解除声明的话，这里会以"配置 cfg 已被声明"失败
    expect(await h.host.reload("cfg")).toBe(true)
    expect(await h.host.reload("cfg")).toBe(true)
    expect(h.host.get("cfg")).toMatchObject({ status: "loaded" })
  })

  it("重载未知插件返回 false 并告警", async () => {
    const h = await makeHarness()
    expect(await h.host.reload("ghost")).toBe(false)
    expect(h.logger.lines.some(l => l.includes("没有名为 ghost"))).toBe(true)
  })

  it("重载后新代码坏掉时，插件停在 error 状态而不是半残", async () => {
    const h = await makeHarness()
    await writePlugin(h, "hot", `export default { name: "hot", setup(ctx) { ctx.command("#v1") } }`)
    await h.host.loadAll()

    await writePlugin(h, "hot", `export default { name: "hot", setup() { throw new Error("改坏了") } }`)
    expect(await h.host.reload("hot")).toBe(false)

    expect(h.host.size).toBe(0)
    expect(h.host.get("hot")).toMatchObject({ status: "error" })
    expect(h.recorded.commands).toEqual([])
  })
})

describe("PluginHost 并发与视图", () => {
  it("并发的加载与卸载被串行化，不会互相打断", async () => {
    const h = await makeHarness()
    await writePlugin(h, "ok", `export default { name: "ok", setup(ctx) { ctx.command("#a") } }`)

    // 不 await 第一个就发第二个：串行链保证 unload 排在 loadAll 之后
    const loading = h.host.loadAll()
    const unloading = h.host.unload("ok")
    const [report, removed] = await Promise.all([loading, unloading])

    expect(report.loaded).toEqual(["ok"])
    expect(removed).toBe(true)
    expect(h.host.size).toBe(0)
    expect(h.recorded.commands).toEqual([])
  })

  it("list 按名字排序，失败的插件也在列表里", async () => {
    const h = await makeHarness()
    await writePlugin(h, "zoo", `export default { name: "zoo", setup() {} }`)
    await writePlugin(h, "bad", `export default { name: "bad", setup() { throw new Error("x") } }`)
    await h.host.loadAll()

    expect(h.host.list().map(p => `${p.name}:${p.status}`)).toEqual(["bad:error", "zoo:loaded"])
  })

  it("createPluginsView 把插件状态与命令/任务清单拼在一起", async () => {
    const h = await makeHarness()
    await writePlugin(h, "ok", `export default { name: "ok", setup() {} }`)
    await h.host.loadAll()

    const view = createPluginsView(h.host, {
      commands: () => [{ plugin: "ok", pattern: "#a" }] as never,
      tasks: () => [],
      middlewares: () => []
    })

    expect(view.list()).toHaveLength(1)
    expect(view.get("ok")).toMatchObject({ name: "ok" })
    expect(view.get("ghost")).toBeUndefined()
    expect(view.commands()).toHaveLength(1)
    expect(view.tasks()).toEqual([])
  })
})

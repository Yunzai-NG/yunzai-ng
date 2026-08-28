/**
 * 模块职责：插件上下文（`ctx`）行为测试
 * 依赖方向：测试文件，依赖 plugin/{context,events,services}、testing/fake
 * 生命周期：每个用例一份上下文 + 一份回收簿
 * 注意事项：本文件最重要的一组断言是**"回收簿一经 dispose，各子系统中即一条不剩"**——
 *          "一切皆可为插件"的前提是插件能被彻底移除。
 */
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it, vi } from "vitest"
import type {
  AdapterProvider,
  ConfigHandle,
  ImageSegment,
  KvDriver,
  KvNamespace,
  RenderResult,
  RendererProvider
} from "@yunzai-ng/types"
import { createEventBus } from "./events.js"
import { createServiceRegistry } from "./services.js"
import { createPluginContext } from "./context.js"
import { DisposalRegistry } from "../util/dispose.js"
import { fakeAppView, fakeHttp, fakeLogger, recordingHooks } from "../testing/fake.js"

/** 假插件根目录（多数用例只做路径计算，不必真的存在） */
const ROOT = join(tmpdir(), "yzng-ctx-plugin")

/** 假数据目录 */
const DATA = join(tmpdir(), "yzng-ctx-data")

/**
 * 装配一份上下文及其周边
 * @returns 上下文与可断言的周边对象
 */
function setup() {
  const logger = fakeLogger()
  const { hooks, recorded } = recordingHooks()
  const services = createServiceRegistry()
  const events = createEventBus({ logger })
  const registry = new DisposalRegistry("demo")
  const abort = new AbortController()

  const { ctx, counters } = createPluginContext({
    name: "demo",
    version: "1.2.3",
    root: ROOT,
    dataDir: DATA,
    logger,
    // 上下文只是把它们原样挂上，用例里不会调用其方法
    kv: {} as unknown as KvNamespace,
    config: {} as unknown as ConfigHandle<unknown>,
    app: fakeAppView(),
    http: fakeHttp(),
    services,
    events,
    hooks,
    registry,
    signal: abort.signal
  })

  return { ctx, counters, hooks, recorded, services, events, registry, abort, logger }
}

describe("PluginContext 基础", () => {
  it("原样透传插件身份与目录", () => {
    const { ctx, abort } = setup()
    expect(ctx.name).toBe("demo")
    expect(ctx.version).toBe("1.2.3")
    expect(ctx.root).toBe(ROOT)
    expect(ctx.dataDir).toBe(DATA)
    expect(ctx.signal).toBe(abort.signal)
  })
})

describe("ctx.command", () => {
  it("登记进命令路由并计数", () => {
    const { ctx, counters, recorded } = setup()
    ctx.command("#ping").action(() => undefined)

    expect(recorded.commands).toHaveLength(1)
    expect(recorded.commands[0]?.plugin).toBe("demo")
    expect(recorded.commands[0]?.patterns).toEqual(["#ping"])
    expect(recorded.commands[0]?.handler).toBeTypeOf("function")
    expect(counters.commands).toBe(1)
  })

  it("alias 选项与 alias() 都进 patterns", () => {
    const { ctx, recorded } = setup()
    ctx.command("#体力", { alias: ["#树脂"] }).alias("#tili")

    expect(recorded.commands[0]?.patterns).toEqual(["#体力", "#树脂", "#tili"])
  })

  it("只有改了索引键才通知路由重新索引", () => {
    const { ctx, recorded } = setup()
    const cmd = ctx.command("#a")

    cmd.desc("说明").master().cooldown("5s").priority(3)
    expect(recorded.reindexed).toHaveLength(0)

    cmd.alias("#b")
    expect(recorded.reindexed).toHaveLength(1)
  })

  it("alias() 传空不产生多余的重新索引", () => {
    const { ctx, recorded } = setup()
    ctx.command("#a").alias()
    expect(recorded.reindexed).toHaveLength(0)
  })

  it("链式改动落在 options 上", () => {
    const { ctx, recorded } = setup()
    ctx.command("#a").desc("说明").master().admin().scene("group").cooldown("5s", "user").priority(3)

    expect(recorded.commands[0]?.options).toMatchObject({
      desc: "说明",
      master: true,
      admin: true,
      scene: ["group"],
      cooldown: "5s",
      cooldownScope: "user",
      priority: 3
    })
  })

  it("复用同一份 options 声明多条命令时互不串台", () => {
    const { ctx, recorded } = setup()
    // 插件作者常这么写：const opts = { desc: "..." }，然后声明一串命令
    const shared = { desc: "共享说明" }
    ctx.command("#a", shared).desc("只改我")
    ctx.command("#b", shared)

    expect(recorded.commands[0]?.options.desc).toBe("只改我")
    expect(recorded.commands[1]?.options.desc).toBe("共享说明")
    // 更不该改到调用方手里的那个字面量
    expect(shared.desc).toBe("共享说明")
  })

  it("重复设置 action 会告警（通常源于复制粘贴后未修改）", () => {
    const { ctx, logger } = setup()
    ctx
      .command("#a")
      .action(() => undefined)
      .action(() => undefined)

    expect(logger.lines.some(l => l.includes("#a") && l.includes("重复设置"))).toBe(true)
  })

  it("builder.dispose() 摘除命令并回退计数", () => {
    const { ctx, counters, recorded } = setup()
    const cmd = ctx.command("#a")
    cmd.dispose()

    expect(recorded.commands).toHaveLength(0)
    expect(counters.commands).toBe(0)
  })
})

describe("ctx.middleware / cron / every", () => {
  it("中间件登记与注销", () => {
    const { ctx, counters, recorded } = setup()
    const undo = ctx.middleware(async (_e, next) => next(), { priority: 5 })

    expect(recorded.middlewares).toHaveLength(1)
    expect(recorded.middlewares[0]?.options).toEqual({ priority: 5 })
    expect(counters.middlewares).toBe(1)

    undo()
    expect(recorded.middlewares).toHaveLength(0)
    expect(counters.middlewares).toBe(0)
  })

  it("cron 原样传表达式", () => {
    const { ctx, recorded } = setup()
    ctx.cron("0 0 8 * * *", () => undefined, { name: "早报" })

    expect(recorded.tasks[0]).toMatchObject({ plugin: "demo", kind: "cron", schedule: "0 0 8 * * *" })
  })

  it("every 把时长解析成毫秒", () => {
    const { ctx, recorded } = setup()
    ctx.every("30s", () => undefined)

    expect(recorded.tasks[0]).toMatchObject({ kind: "interval", schedule: 30_000 })
  })

  it("every 周期小于 1 秒直接抛错，且不留下半个登记", () => {
    const { ctx, counters, recorded } = setup()
    expect(() => ctx.every("500ms", () => undefined)).toThrow(/最小 1s/)
    expect(recorded.tasks).toHaveLength(0)
    expect(counters.tasks).toBe(0)
  })
})

describe("ctx 服务互操作", () => {
  it("provide / inject / require 走服务注册表", () => {
    const { ctx, counters, services } = setup()
    const api = { ping: () => "pong" }
    ctx.provide("demo.api", api)

    expect(services.get("demo.api")).toBe(api)
    expect(ctx.inject<typeof api>("demo.api")).toBe(api)
    expect(ctx.require<typeof api>("demo.api")).toBe(api)
    expect(counters.services).toBe(1)
  })

  it("inject 缺失返回 undefined，require 缺失抛错并点名本插件", () => {
    const { ctx } = setup()
    expect(ctx.inject("nope")).toBeUndefined()
    expect(() => ctx.require("nope")).toThrow(/demo/)
  })

  it("waitFor 已就绪时立即拿到", async () => {
    const { ctx } = setup()
    ctx.provide("k", 42)
    await expect(ctx.waitFor<number>("k")).resolves.toBe(42)
  })

  it("插件被卸载时 waitFor 立即以 undefined 结束（否则闭包被长期持有）", async () => {
    const { ctx, abort } = setup()
    // 缺省超时 30s：若不监听 abort，该 promise 会将已卸载插件的闭包持有 30 秒
    const pending = ctx.waitFor("never.coming")
    abort.abort()
    await expect(pending).resolves.toBeUndefined()
  })

  it("已卸载的插件再调 waitFor 直接返回 undefined", async () => {
    const { ctx, abort } = setup()
    abort.abort()
    await expect(ctx.waitFor("anything")).resolves.toBeUndefined()
  })
})

describe("ctx 服务器相关", () => {
  it("路由、WebSocket、静态目录都挂在 /plugin/<插件名> 作用域下", () => {
    const { ctx, counters, recorded } = setup()
    ctx.route("GET", "/status", async () => undefined)
    ctx.websocket("/live", () => undefined)
    ctx.static("/assets", join(ROOT, "resources"))

    expect(recorded.routes).toEqual([
      { scope: "/plugin/demo", method: "GET", path: "/status" },
      { scope: "/plugin/demo", method: "WS", path: "/live" }
    ])
    expect(recorded.statics).toEqual([
      { scope: "/plugin/demo", urlPath: "/assets", dir: join(ROOT, "resources"), spa: false }
    ])
    expect(counters.routes).toBe(2)
  })

  it("ctx.panel 挂在站点根路径，归属标识带插件名", () => {
    const { ctx, recorded } = setup()
    ctx.panel(join(ROOT, "panel-dist"))

    // 归属不是 /plugin/demo：接管面板的意义在于占据 `/`，
    // 而作用域之下的页面无法成为默认入口
    expect(recorded.statics).toEqual([
      { scope: "plugin:demo", urlPath: "/", dir: join(ROOT, "panel-dist"), spa: true }
    ])
  })

  it("ctx.panel 的挂载随插件卸载一起回收", () => {
    const { ctx, recorded, registry } = setup()
    ctx.panel(join(ROOT, "panel-dist"))
    expect(registry.dispose()).toEqual([])
    expect(recorded.statics).toEqual([])
  })
})

describe("ctx.render", () => {
  it("模板根与资源根由内核按插件目录算好（插件只写相对名）", async () => {
    const { ctx, recorded } = setup()
    await ctx.render("player/daily-note", { uid: 1 })

    expect(recorded.renders[0]).toMatchObject({
      template: "player/daily-note",
      data: { uid: 1 },
      templateRoot: join(ROOT, "templates"),
      resourceRoot: join(ROOT, "resources"),
      origin: "demo"
    })
  })

  it("单图返回一个图片段，且是 buffer 直传而非 base64", async () => {
    const { ctx } = setup()
    const seg = (await ctx.render("t")) as ImageSegment

    expect(Array.isArray(seg)).toBe(false)
    expect(seg.type).toBe("image")
    expect(seg.file).toMatchObject({ kind: "buffer", mime: "image/jpeg" })
  })

  it("按 opts.type 给出对应 MIME", async () => {
    const { ctx } = setup()
    const seg = (await ctx.render("t", {}, { type: "png" })) as ImageSegment
    expect(seg.file).toMatchObject({ mime: "image/png" })
  })

  it("多图返回数组（分页长图）", async () => {
    const { ctx, hooks } = setup()
    hooks.render = {
      ...hooks.render,
      render: async () => ({ images: [new Uint8Array([1]), new Uint8Array([2])], cost: 1, renderer: "fake" })
    }

    const seg = await ctx.render("t")
    expect(Array.isArray(seg)).toBe(true)
    expect(seg).toHaveLength(2)
  })

  it("渲染器返回空结果时抛错，而不是发一条空消息出去", async () => {
    const { ctx, hooks } = setup()
    hooks.render = {
      ...hooks.render,
      render: async (): Promise<RenderResult> => ({ images: [], cost: 0, renderer: "空渲染器" })
    }

    await expect(ctx.render("t")).rejects.toThrow(/没有产出图片/)
  })
})

describe("ctx.sql", () => {
  it("同名库只打开一次（多连接会在 WAL 下互相等锁）", async () => {
    const { ctx, recorded } = setup()
    const [a, b] = await Promise.all([ctx.sql(), ctx.sql()])

    expect(a).toBe(b)
    expect(recorded.sqlOpened).toEqual(["demo/main"])
  })

  it("不同库名各打开一次", async () => {
    const { ctx, recorded } = setup()
    await ctx.sql()
    await ctx.sql("gacha")
    expect(recorded.sqlOpened).toEqual(["demo/main", "demo/gacha"])
  })

  it("打开失败不留坏缓存，重试仍有机会成功", async () => {
    const { ctx, hooks, recorded } = setup()
    const real = hooks.sql.open
    let attempt = 0
    hooks.sql = {
      ...hooks.sql,
      open: async (plugin, name) => {
        attempt++
        if (attempt === 1) throw new Error("磁盘忙")
        return real(plugin, name)
      }
    }

    await expect(ctx.sql()).rejects.toThrow(/磁盘忙/)
    await expect(ctx.sql()).resolves.toBeDefined()
    expect(recorded.sqlOpened).toEqual(["demo/main"])
  })
})

describe("ctx.resource", () => {
  it("拼出插件内的绝对路径", () => {
    const { ctx } = setup()
    expect(ctx.resource("resources", "img", "bg.png")).toBe(join(ROOT, "resources", "img", "bg.png"))
  })

  it("挡住越出插件根的路径（参数可能来自用户消息）", () => {
    const { ctx } = setup()
    expect(() => ctx.resource("..", "..", "etc", "passwd")).toThrow()
    expect(() => ctx.resource(resolve("/etc/passwd"))).toThrow()
  })
})

describe("回收：卸载必须完整归还全部资源", () => {
  it("registry.dispose() 之后各子系统中不残留任何条目", async () => {
    const { ctx, counters, recorded, services, events, registry } = setup()

    ctx.command("#a").action(() => undefined)
    ctx.command("#b")
    ctx.middleware(async (_e, next) => next())
    ctx.cron("0 0 8 * * *", () => undefined)
    ctx.every("10s", () => undefined)
    ctx.on("app/ready", () => undefined)
    ctx.provide("demo.api", { x: 1 })
    ctx.route("GET", "/s", async () => undefined)
    ctx.websocket("/w", () => undefined)
    ctx.static("/a", ROOT)
    ctx.panel(join(ROOT, "panel-dist"))
    ctx.registerAdapter({ id: "fake-adapter" } as unknown as AdapterProvider)
    ctx.registerRenderer({ id: "fake-renderer" } as unknown as RendererProvider)
    ctx.registerKvDriver({ id: "fake-kv" } as unknown as KvDriver)
    await ctx.sql()

    const failures = registry.dispose()
    expect(failures).toEqual([])

    expect(recorded.commands).toEqual([])
    expect(recorded.middlewares).toEqual([])
    expect(recorded.tasks).toEqual([])
    expect(recorded.routes).toEqual([])
    expect(recorded.statics).toEqual([])
    expect(recorded.adapters).toEqual([])
    expect(recorded.renderers).toEqual([])
    expect(recorded.kvDrivers).toEqual([])
    // SQL 连接的生死由存储层按插件统一管理，卸载时要求它关掉本插件的全部库
    expect(recorded.sqlClosed).toEqual(["demo"])

    expect(services.size).toBe(0)
    expect(events.count("app/ready")).toBe(0)
    expect(counters).toEqual({ commands: 0, middlewares: 0, tasks: 0, routes: 0, services: 0 })
  })

  it("onDispose 注册的清理函数会被调用", () => {
    const { ctx, registry } = setup()
    const clean = vi.fn()
    ctx.onDispose(clean)

    registry.dispose()
    expect(clean).toHaveBeenCalledTimes(1)
  })

  it("卸载后迟到的注册被立即回收（异步 setup 慢一步的情形）", () => {
    const { ctx, counters, recorded, registry } = setup()
    registry.dispose()

    // 插件的 setup 里 `void (async () => { ...await...; ctx.command(...) })()`
    // 这种写法很常见，卸载后它可能才跑到注册那一行
    ctx.command("#late")
    ctx.middleware(async (_e, next) => next())

    expect(recorded.commands).toEqual([])
    expect(recorded.middlewares).toEqual([])
    expect(counters.commands).toBe(0)
    expect(counters.middlewares).toBe(0)
  })

  it("cache() 随卸载清空", () => {
    const { ctx, registry } = setup()
    const cache = ctx.cache<number>({ max: 10 })
    cache.set("k", 1)
    expect(cache.get("k")).toBe(1)

    registry.dispose()
    expect(cache.get("k")).toBeUndefined()
    expect(cache.size).toBe(0)
  })

  it("单个 disposer 幂等，不会把计数扣成负数", () => {
    const { ctx, counters } = setup()
    const undo = ctx.middleware(async (_e, next) => next())
    undo()
    undo()
    expect(counters.middlewares).toBe(0)
  })
})

describe("ctx.pickBot", () => {
  it("走账号管理器；无账号时给 undefined 而不是抛错", () => {
    const { ctx } = setup()
    expect(ctx.pickBot()).toBeUndefined()
  })
})

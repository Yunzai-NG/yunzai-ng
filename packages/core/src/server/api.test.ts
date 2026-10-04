/**
 * 模块职责：面板 API 端点的行为测试
 * 依赖方向：测试文件，依赖 server/*、config/*
 * 生命周期：每个用例一个临时配置目录、一个未监听的服务器、一组替身子系统
 * 注意事项：`ApiDeps` 中有六个字段的类型是**带私有字段的类**（AccountManager、
 *          LoginManager、RenderRegistry、EventDispatcher、PluginHost、LoggerHub），
 *          结构化替身无法直接赋值，只能 `as unknown as`。此项取舍并非规避实现成本：这些类各自
 *          需要一整套内核依赖方可构造，为验证一个"只读模式返回 403"而将它们全部构造出来，
 *          等同于把 api.ts 的测试变为 kernel/app.ts 的集成测试，一处失败即导致全体失败。
 *
 *          服务器为真实实现（经完整钩子链），配置亦为真实实现（需验证 SchemaError → 400）。
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"
import type { Socket } from "node:net"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
  AccountRecord,
  AccountState,
  AdapterRegistryView,
  BotRegistryView,
  LogLevel,
  Logger,
  ResourceUsage,
  RuntimePaths
} from "@yunzai-ng/types"
import { detectPlatform } from "../platform/detect.js"
import type { AccountManager } from "../adapter/accounts.js"
import type { LoginManager, LoginSnapshot } from "../adapter/login.js"
import type { EventDispatcher } from "../pipeline/dispatch.js"
import type { PluginHost } from "../plugin/host.js"
import type { PluginMarket } from "../plugin/market.js"
import type { RenderRegistry } from "../render/registry.js"
import type { LoggerHub } from "../logger/index.js"
import type { LogRecord } from "../logger/format.js"
import { ConfigStore } from "../config/store.js"
import { defineCoreConfig, type CoreConfigHandle } from "../config/core-config.js"
import { createManagedServer, type ManagedServer } from "./index.js"
import { API_SCOPE, registerApi, type ApiDeps } from "./api.js"
import { MemoryKvDriver } from "../store/memory.js"
import { StorageError, createKvInspector, type SqlInspectSource } from "../store/inspect.js"
import { SubsystemUnavailableError } from "../plugin/hooks.js"

/** 本机对端，light-my-request 默认也是这个 */
const LOCAL_IP = "127.0.0.1"

/**
 * 拼一个 `injectWS` 的 upgradeContext
 *
 * 伪造的 raw request 上没有 `socket`，而鉴权要看 TCP 对端地址，所以得自己补一个。
 * @param headers 额外的握手请求头
 * @returns upgradeContext
 */
function upgradeCtx(headers: Record<string, string> = {}): { socket: Socket; headers: Record<string, string> } {
  return { socket: { remoteAddress: LOCAL_IP } as unknown as Socket, headers }
}

/**
 * 静音日志器
 * @returns 只收集行的日志器
 */
function quietLogger(): Logger {
  const push = (): void => undefined
  const logger: Logger = {
    level: "silent" as LogLevel,
    trace: push,
    debug: push,
    info: push,
    warn: push,
    error: push,
    fatal: push,
    mark: push,
    child: () => logger,
    isLevelEnabled: () => false
  }
  return logger
}

/**
 * 会留痕的日志器
 *
 * 与 `quietLogger` 分开而不是给后者加个数组：那一个被服务器与配置仓库共用，它们在每个用例里
 * 都会写好几行，混进来之后「日志里有没有那一行」这类断言得先在一堆无关的行里筛。
 * @param lines 收集到的行，形如 `warn:内容`
 * @returns 日志器
 */
function recordingLogger(lines: string[]): Logger {
  const at =
    (level: string) =>
    (...args: unknown[]): void => {
      lines.push(`${level}:${args.map(a => String(a)).join(" ")}`)
    }
  const logger: Logger = {
    level: "trace" as LogLevel,
    trace: at("trace"),
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    fatal: at("fatal"),
    mark: at("mark"),
    child: () => logger,
    isLevelEnabled: () => true
  }
  return logger
}

/**
 * 造一条账号记录
 * @param id 记录 id
 * @returns 记录
 */
function accountRecord(id: string): AccountRecord {
  return {
    id,
    adapterId: "napcat",
    enabled: true,
    config: { mode: "ws", url: "ws://127.0.0.1:3001", token: "机密" },
    createdAt: 1,
    updatedAt: 1
  }
}

/**
 * 造一条账号状态
 * @param id 记录 id
 * @param status 状态
 * @returns 状态
 */
function accountState(id: string, status: AccountState["status"] = "online"): AccountState {
  return { record: accountRecord(id), status, since: 1, retries: 0 }
}

/** 替身子系统的可观测部分，用例据此断言"到底调没调" */
interface Spies {
  /** 插件宿主 */
  plugins: {
    /** 列表 */
    list: ReturnType<typeof vi.fn>
    /** 单个 */
    get: ReturnType<typeof vi.fn>
    /** 重载 */
    reload: ReturnType<typeof vi.fn>
    /** 卸载 */
    unload: ReturnType<typeof vi.fn>
    /** 全量加载 */
    loadAll: ReturnType<typeof vi.fn>
  }
  /** 插件市场 */
  market: {
    /** 索引快照 */
    list: ReturnType<typeof vi.fn>
    /** 安装 */
    install: ReturnType<typeof vi.fn>
    /** 更新 */
    update: ReturnType<typeof vi.fn>
    /** 更新前的探测：会不会就地拉取、目录里有没有改动 */
    inspectUpdate: ReturnType<typeof vi.fn>
    /** 单独重跑装依赖与装后步骤 */
    setup: ReturnType<typeof vi.fn>
    /** 卸载 */
    remove: ReturnType<typeof vi.fn>
  }
  /** 账号管理器 */
  accounts: {
    /** 列表 */
    list: ReturnType<typeof vi.fn>
    /** 单个 */
    get: ReturnType<typeof vi.fn>
    /** 新建 */
    create: ReturnType<typeof vi.fn>
    /** 修改 */
    update: ReturnType<typeof vi.fn>
    /** 删除 */
    remove: ReturnType<typeof vi.fn>
    /** 连接 */
    connect: ReturnType<typeof vi.fn>
    /** 断开 */
    disconnect: ReturnType<typeof vi.fn>
    /** 重连 */
    reconnect: ReturnType<typeof vi.fn>
  }
  /** 登录会话管理器 */
  logins: {
    /** 列表 */
    list: ReturnType<typeof vi.fn>
    /** 快照 */
    snapshot: ReturnType<typeof vi.fn>
    /** 开始 */
    start: ReturnType<typeof vi.fn>
    /** 答复 */
    answer: ReturnType<typeof vi.fn>
    /** 取消 */
    cancel: ReturnType<typeof vi.fn>
    /** 进行中数量 */
    running: number
  }
  /** 日志枢纽 */
  loggerHub: {
    /** 回看 */
    tail: ReturnType<typeof vi.fn>
    /** 订阅者集合 */
    listeners: Set<(rec: LogRecord) => void>
    /** 文件路径 */
    file: string
    /** 级别 */
    level: LogLevel
  }
}

/**
 * 造一条登录会话快照
 * @param id 会话 id
 * @returns 快照
 */
function loginSnapshot(id: string): LoginSnapshot {
  return {
    id,
    adapterId: "napcat",
    mode: "qrcode",
    status: "running",
    steps: [{ type: "info", text: "请扫码" }],
    pending: undefined,
    error: undefined,
    accountId: undefined,
    startedAt: 1,
    updatedAt: 1
  }
}

describe("面板 API", () => {
  let dir: string
  let config: CoreConfigHandle
  let store: ConfigStore
  let server: ManagedServer
  let spies: Spies
  let deps: ApiDeps
  let off: () => void
  /** API 自己打出的日志行，供「令牌写进日志」一类断言查看 */
  let logLines: string[]

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "yzng-api-"))
    logLines = []
    const logger = quietLogger()
    store = new ConfigStore({ dir, logger, watch: false })
    config = await defineCoreConfig(store)
    server = await createManagedServer({ config, logger })

    spies = {
      plugins: {
        list: vi.fn(() => [
          {
            name: "demo",
            version: "1.0.0",
            // 必须真落在 paths.plugins 底下：市场那几条路由按**目录**认插件（见 api.ts 的
            // pluginInDir），root 随手写成 /p/demo 的替身会让「该不该卸载」一律判成否
            root: join(dir, "demo"),
            status: "loaded",
            loadCost: 12,
            commands: 3,
            tasks: 1,
            middlewares: 0,
            builtin: false,
            configured: false
          }
        ]),
        get: vi.fn((name: string) => (name === "demo" ? { name: "demo", status: "loaded" } : undefined)),
        reload: vi.fn(async (name: string) => name === "demo"),
        unload: vi.fn(async (name: string) => name === "demo"),
        loadAll: vi.fn(async () => ({ loaded: ["fresh"], failed: [], skipped: [], cost: 1 }))
      },
      market: {
        list: vi.fn(async () => ({
          fetchedAt: 1,
          cached: false,
          sources: [{ url: "https://example.com/i.json", ok: true, count: 1 }],
          plugins: [
            {
              name: "fresh",
              title: "示例插件",
              description: "用于测试",
              tags: [],
              official: true,
              install: { type: "tarball", url: "https://example.com/f.tar.gz" },
              source: "https://example.com/i.json",
              installed: false
            }
          ]
        })),
        install: vi.fn(async (name: string) => ({
          name,
          dir: join(dir, "plugins", name),
          via: "tarball",
          version: "1.0.0",
          needsDependencies: false
        })),
        update: vi.fn(async (name: string) => ({
          name,
          dir: join(dir, "plugins", name),
          via: "tarball",
          version: "2.0.0",
          needsDependencies: false
        })),
        setup: vi.fn(async (name: string) => ({
          name,
          dir: join(dir, "plugins", name),
          version: "1.0.0",
          needsDependencies: false,
          installedDeps: true,
          packageManager: "pnpm",
          ranScripts: ["build"]
        })),
        // 缺省是「会就地拉取、目录干净」：那是绝大多数插件的常态，
        // 要验有改动那一路的用例自行 mockResolvedValueOnce 覆盖
        inspectUpdate: vi.fn(async () => ({ willPull: true, dirty: false })),
        remove: vi.fn(async (name: string) => name === "demo")
      },
      accounts: {
        list: vi.fn(() => [accountState("a1")]),
        get: vi.fn((id: string) => (id === "a1" ? accountState("a1") : undefined)),
        create: vi.fn(async () => accountRecord("a2")),
        update: vi.fn(async () => accountRecord("a1")),
        remove: vi.fn(async () => true),
        connect: vi.fn(async () => undefined),
        disconnect: vi.fn(async () => undefined),
        reconnect: vi.fn(async () => undefined)
      },
      logins: {
        list: vi.fn(() => [loginSnapshot("l1")]),
        snapshot: vi.fn((id: string) => (id === "l1" ? loginSnapshot("l1") : undefined)),
        start: vi.fn(() => loginSnapshot("l1")),
        answer: vi.fn(() => true),
        cancel: vi.fn(() => true),
        running: 1
      },
      loggerHub: {
        tail: vi.fn(() => [{ level: "info" as LogLevel, time: 1, msg: "第一行" }]),
        listeners: new Set<(rec: LogRecord) => void>(),
        file: join(dir, "yunzai.log"),
        level: "info" as LogLevel
      }
    }

    const adapters: AdapterRegistryView = {
      list: () => [
        { id: "napcat", name: "NapCat (OneBot v11)", platform: "qq", accountSchema: { type: "object" }, loginModes: [] }
      ],
      get: () => undefined
    }
    const bots: BotRegistryView = { get: () => undefined, bySelfId: () => undefined, online: () => [], size: 1 }

    deps = {
      version: "9.9.9",
      paths: { home: dir, config: dir, data: dir, logs: dir, temp: dir, plugins: dir } as unknown as RuntimePaths,
      platform: detectPlatform(),
      logger: recordingLogger(logLines),
      config,
      configStore: store,
      loggerHub: {
        ...spies.loggerHub,
        subscribe: (fn: (rec: LogRecord) => void) => {
          spies.loggerHub.listeners.add(fn)
          return () => void spies.loggerHub.listeners.delete(fn)
        }
      } as unknown as LoggerHub,
      plugins: spies.plugins as unknown as PluginHost,
      market: spies.market as unknown as PluginMarket,
      registries: {
        commands: () => [{ name: "#帮助", patterns: ["#帮助"], plugin: "demo", master: false, admin: false, hidden: false, disabled: false }],
        tasks: () => [{ name: "推送", schedule: "0 0 8 * * *", plugin: "demo", running: false, skipped: 0 }],
        middlewares: () => [{ plugin: "demo", priority: 50, kinds: ["message"] as const }] as never
      },
      adapters,
      accounts: spies.accounts as unknown as AccountManager,
      logins: spies.logins as unknown as LoginManager,
      bots,
      renderers: { size: 1, list: () => [{ id: "puppeteer", name: "Puppeteer", owner: "renderer-puppeteer", preferred: true, available: true, lastError: undefined, succeeded: 4, failed: 0 }] } as unknown as RenderRegistry,
      dispatcher: { handled: 42, queued: 0 } as unknown as EventDispatcher,
      server,
      status: () => "running",
      startedAt: () => Date.now() - 1000,
      usage: () => ({ rss: 1, heapUsed: 1, heapTotal: 1, external: 1, cpu: 0 }) as ResourceUsage,
      system: async () => ({
        disks: [{ mount: "C:\\", total: 1000, free: 400, used: 600 }],
        gpus: [{ name: "GeForce RTX 4090", load: 0.31, memoryUsed: 2048, memoryTotal: 24576 }]
      })
    }

    off = registerApi(server, deps)
  })

  afterEach(async () => {
    off()
    await server.close()
    await rm(dir, { recursive: true, force: true })
  })

  /**
   * 发一个面板 API 请求
   * @param method HTTP 方法
   * @param path 相对 `API_SCOPE` 的路径
   * @param payload 请求体
   * @returns 注入响应
   */
  const call = async (
    method: string,
    path: string,
    payload?: unknown
  ): Promise<{ statusCode: number; json: () => Record<string, unknown>; body: string }> => {
    const res = await server.raw.inject({
      method: method as "GET",
      url: `${API_SCOPE}/${path}`,
      ...(payload === undefined ? {} : { payload: payload as object, headers: { "content-type": "application/json" } })
    })
    return { statusCode: res.statusCode, json: () => res.json() as Record<string, unknown>, body: res.body }
  }

  describe("概览", () => {
    it("汇总版本、状态与各子系统计数", async () => {
      const res = await call("GET", "overview")
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.version).toBe("9.9.9")
      expect(body.status).toBe("running")
      expect(body.counts).toEqual({
        plugins: 1,
        pluginsFailed: 0,
        commands: 1,
        tasks: 1,
        adapters: 1,
        accounts: 1,
        online: 1,
        renderers: 1,
        logins: 1
      })
      expect(body.pipeline).toEqual({ handled: 42, queued: 0 })
    })
  })

  describe("系统信息", () => {
    it("回出磁盘与显卡", async () => {
      const res = await call("GET", "system")
      expect(res.statusCode).toBe(200)
      const body = res.json() as unknown as {
        disks: Array<{ mount: string; total: number }>
        gpus?: Array<{ name: string }>
      }
      expect(body.disks[0]?.mount).toBe("C:\\")
      expect(body.gpus?.[0]?.name).toBe("GeForce RTX 4090")
    })

    /*
     * CPU 与内存不进这个端点：它们已在 `GET overview` 里。同一事实供两份，
     * 两处的采样时刻还不一样，面板上就会出现「CPU 卡片与 CPU 环不是一个数」。
     * 这一条断言的是「日后有人往这里加 cpu 字段会红」。
     */
    it("不含 CPU 与内存 —— 那两项的唯一来源是概览", async () => {
      const body = (await call("GET", "system")).json()
      expect(body.cpu).toBeUndefined()
      expect(body.usage).toBeUndefined()
      expect(body.memory).toBeUndefined()
    })

    it("只读模式下照常可用 —— 它报容量与型号，不含任何路径", async () => {
      await config.patch({ server: { readonly: true } }, "api")
      expect((await call("GET", "system")).statusCode).toBe(200)
    })
  })

  describe("中间件清单", () => {
    it("回出所属插件、优先级与适用大类", async () => {
      const res = await call("GET", "middlewares")
      expect(res.statusCode).toBe(200)
      const body = res.json() as unknown as Array<{ plugin: string; priority: number; kinds: string[] }>
      expect(body[0]).toEqual({ plugin: "demo", priority: 50, kinds: ["message"] })
    })

    /*
     * 插件卡片一直显示着中间件的**条数**，却看不到是哪几条 —— 排查「消息被谁拦下了」
     * 时条数没有用。这一条断言的是「清单与计数出自同一处」。
     */
    it("与概览里的计数同源 —— 两处不该各数一遍", async () => {
      const list = (await call("GET", "middlewares")).json() as unknown as unknown[]
      expect(list).toHaveLength(1)
    })
  })

  describe("配置", () => {
    it("列出已声明的配置，并给出表单描述", async () => {
      const list = (await call("GET", "config")).json() as unknown as Array<{ name: string; schema: unknown }>
      expect(list.some(c => c.name === "yunzai")).toBe(true)

      const one = await call("GET", "config/yunzai")
      expect(one.statusCode).toBe(200)
      expect(one.json().name).toBe("yunzai")
      expect(one.json().schema).toBeDefined()
      expect((one.json().value as { server: { port: number } }).server.port).toBe(2536)
    })

    it("未声明的配置回 404", async () => {
      const res = await call("GET", "config/不存在")
      expect(res.statusCode).toBe(404)
    })

    it("PATCH 深合并，只改传进来的字段", async () => {
      const res = await call("PATCH", "config/yunzai", { server: { port: 3999 } })
      expect(res.statusCode).toBe(200)
      expect(config.get().server.port).toBe(3999)
      // 同层的其他字段不该被抹掉
      expect(config.get().server.host).toBe("127.0.0.1")
    })

    it("校验失败回 400，并带上逐字段的 issues", async () => {
      const res = await call("PATCH", "config/yunzai", { server: { port: 999999 } })
      expect(res.statusCode).toBe(400)
      const issues = res.json().issues as Array<{ path: string }>
      expect(issues.some(i => i.path === "server.port")).toBe(true)
      // 配置必须原样不动
      expect(config.get().server.port).toBe(2536)
    })

    it("reset 恢复默认值", async () => {
      await call("PATCH", "config/yunzai", { server: { port: 3999 } })
      const res = await call("POST", "config/yunzai/reset")
      expect(res.statusCode).toBe(200)
      expect(config.get().server.port).toBe(2536)
    })

    it("请求体不是对象时回 400", async () => {
      const res = await call("PATCH", "config/yunzai", [1, 2, 3])
      expect(res.statusCode).toBe(400)
      expect(String(res.json().error)).toContain("JSON 对象")
    })
  })

  describe("只读模式", () => {
    beforeEach(async () => {
      await config.patch({ server: { readonly: true } }, "api")
    })

    it("读接口照常，写接口一律 403", async () => {
      expect((await call("GET", "config/yunzai")).statusCode).toBe(200)
      expect((await call("GET", "accounts")).statusCode).toBe(200)

      for (const [method, path] of [
        ["PATCH", "config/yunzai"],
        ["POST", "config/yunzai/reset"],
        ["POST", "plugins/demo/reload"],
        ["POST", "accounts"],
        ["DELETE", "accounts/a1"],
        ["POST", "logins"],
        ["POST", "market/install"],
        ["POST", "market/demo/update"],
        ["DELETE", "market/demo"]
      ] as const) {
        const res = await call(method, path, {})
        expect(res.statusCode, `${method} ${path}`).toBe(403)
      }
    })

    it("只读模式不影响插件自己注册的路由", async () => {
      // 适配器的 webhook 不该因为"面板设成只读"而收不到消息，见 api.ts 第 2 条
      server.route("/plugin/napcat", "POST", "hook", () => ({ ok: true }), { auth: false })
      const res = await server.raw.inject({ method: "POST", url: "/plugin/napcat/hook", payload: { a: 1 } })
      expect(res.statusCode).toBe(200)
    })

    it("**目录浏览在只读模式下停用** —— 它只为改配置服务，此时只剩扩权", async () => {
      const res = await call("GET", "fs")
      expect(res.statusCode).toBe(403)
      expect(String(res.json().error)).toContain("目录浏览已停用")
    })
  })

  describe("目录浏览", () => {
    it("列出指定目录，只回名字与是否目录", async () => {
      const res = await call("GET", `fs?path=${encodeURIComponent(dir)}`)
      expect(res.statusCode).toBe(200)
      const body = res.json() as unknown as {
        path: string
        entries: Array<Record<string, unknown>>
        truncated: boolean
        sep: string
      }
      expect(body.path).toBe(dir)
      expect(body.truncated).toBe(false)
      expect(body.sep).toBe(sep)
      // 临时目录里此刻有 defineCoreConfig 写出的 yunzai.yaml
      const names = body.entries.map(e => e.name)
      expect(names).toContain("yunzai.yaml")
      for (const entry of body.entries) expect(Object.keys(entry).sort()).toEqual(["dir", "name"])
    })

    it("不存在的目录回 404，相对路径回 400", async () => {
      expect((await call("GET", `fs?path=${encodeURIComponent(join(dir, "无此目录"))}`)).statusCode).toBe(404)
      expect((await call("GET", "fs?path=plugins")).statusCode).toBe(400)
    })

    it("不带 path 时给出最外层，不报错", async () => {
      const res = await call("GET", "fs")
      expect(res.statusCode).toBe(200)
    })

    it("与其余 /api/* 一样要令牌", async () => {
      await config.patch({ server: { token: "秘密令牌" } }, "api")
      const bare = await server.raw.inject({ method: "GET", url: `${API_SCOPE}/fs` })
      expect(bare.statusCode).toBe(401)
      const withToken = await server.raw.inject({
        method: "GET",
        url: `${API_SCOPE}/fs`,
        headers: { "x-yunzai-token": "秘密令牌" }
      })
      expect(withToken.statusCode).toBe(200)
    })
  })

  describe("插件", () => {
    it("列出插件、取单个、未知插件 404", async () => {
      const list = (await call("GET", "plugins")).json() as unknown as Array<{ name: string }>
      expect(list[0]?.name).toBe("demo")
      expect((await call("GET", "plugins/demo")).statusCode).toBe(200)
      expect((await call("GET", "plugins/无名")).statusCode).toBe(404)
    })

    it("reload 与 unload 转发到宿主，失败时不返回 200", async () => {
      expect((await call("POST", "plugins/demo/reload")).statusCode).toBe(200)
      expect(spies.plugins.reload).toHaveBeenCalledWith("demo")

      expect((await call("POST", "plugins/无名/reload")).statusCode).toBe(400)
      expect((await call("POST", "plugins/无名/unload")).statusCode).toBe(404)
    })

    it("命令、任务、渲染器清单都能读", async () => {
      expect(((await call("GET", "commands")).json() as unknown as unknown[]).length).toBe(1)
      expect(((await call("GET", "tasks")).json() as unknown as unknown[]).length).toBe(1)
      expect(((await call("GET", "renderers")).json() as unknown as unknown[]).length).toBe(1)
    })
  })

  describe("账号", () => {
    it("新建成功回 201，并把校验后的记录带回来", async () => {
      const res = await call("POST", "accounts", { adapterId: "napcat", config: { mode: "ws" }, label: "主号" })
      expect(res.statusCode).toBe(201)
      expect(res.json().id).toBe("a2")
      // 第五个参数是每账号的重连覆盖：没填就是 undefined，即四项全跟随全局配置
      expect(spies.accounts.create).toHaveBeenCalledWith("napcat", { mode: "ws" }, "主号", true, undefined)
    })

    /*
     * 重连覆盖那一组的用例，钉住三件事：逐字段可缺、边界校验、以及 null 表示清空
     *
     * 「逐字段可缺」是这块唯一容易写错的语义 —— 补齐缺省值会把「跟随全局」偷换成
     * 「此刻的全局值」，而后者此后不跟着全局改动走，症状是「我改了全局间隔，这个号却不听」。
     */
    it("建号时可只给重连覆盖里的一项，其余留空跟随全局", async () => {
      const res = await call("POST", "accounts", {
        adapterId: "napcat",
        config: { mode: "ws" },
        retry: { limit: 5 }
      })
      expect(res.statusCode).toBe(201)
      expect(spies.accounts.create).toHaveBeenCalledWith("napcat", { mode: "ws" }, undefined, true, { limit: 5 })
    })

    it("重连覆盖收时长字符串与毫秒数字两种写法", async () => {
      await call("PATCH", "accounts/a1", { retry: { interval: "5s", maxInterval: 120_000, factor: 1.5 } })
      expect(spies.accounts.update).toHaveBeenLastCalledWith("a1", {
        retry: { interval: "5s", maxInterval: 120_000, factor: 1.5 }
      })
    })

    it("重连覆盖越界、单位写错、负数一律 400", async () => {
      // 上限与全局 schema 同区间：-1 会让「0 为不限」这个判据静默失效
      expect((await call("PATCH", "accounts/a1", { retry: { limit: -1 } })).statusCode).toBe(400)
      expect((await call("PATCH", "accounts/a1", { retry: { factor: 0.5 } })).statusCode).toBe(400)
      // "5秒" 解析不出来，收下它等于悄悄按兜底值跑
      const res = await call("PATCH", "accounts/a1", { retry: { interval: "5秒" } })
      expect(res.statusCode).toBe(400)
      expect(String(res.json().error)).toContain("retry.interval")
      expect((await call("PATCH", "accounts/a1", { retry: { interval: "-2s" } })).statusCode).toBe(400)
      expect(spies.accounts.update).not.toHaveBeenCalled()
    })

    it("retry 为 null 表示清掉覆盖、回去跟随全局", async () => {
      await call("PATCH", "accounts/a1", { retry: null })
      expect(spies.accounts.update).toHaveBeenLastCalledWith("a1", { retry: null })
    })

    it("缺 adapterId 回 400，配置校验失败也回 400", async () => {
      expect((await call("POST", "accounts", { config: {} })).statusCode).toBe(400)

      spies.accounts.create.mockRejectedValueOnce(new Error("字段 url 必填"))
      const res = await call("POST", "accounts", { adapterId: "napcat", config: {} })
      expect(res.statusCode).toBe(400)
      expect(String(res.json().error)).toContain("字段 url 必填")
    })

    it("未知账号一律 404，且不会误调管理器", async () => {
      expect((await call("PATCH", "accounts/nope", {})).statusCode).toBe(404)
      expect((await call("POST", "accounts/nope/connect")).statusCode).toBe(404)
      expect(spies.accounts.update).not.toHaveBeenCalled()
      expect(spies.accounts.connect).not.toHaveBeenCalled()
    })

    it("连接类动作回动作之后的状态，删除回 204", async () => {
      const connected = await call("POST", "accounts/a1/connect")
      expect(connected.statusCode).toBe(200)
      expect((connected.json().record as { id: string }).id).toBe("a1")
      expect(spies.accounts.connect).toHaveBeenCalledWith("a1")

      await call("POST", "accounts/a1/disconnect")
      expect(spies.accounts.disconnect).toHaveBeenCalledWith("a1", "面板手动断开")

      const removed = await call("DELETE", "accounts/a1")
      expect(removed.statusCode).toBe(204)
      expect(spies.accounts.remove).toHaveBeenCalledWith("a1")
    })
  })

  describe("交互式登录", () => {
    it("开始登录立刻回初始快照，不等流程结束", async () => {
      const res = await call("POST", "logins", { adapterId: "napcat", mode: "qrcode" })
      expect(res.statusCode).toBe(201)
      expect(res.json().status).toBe("running")
      expect(spies.logins.start).toHaveBeenCalledWith("napcat", "qrcode", undefined)
    })

    it("适配器不支持登录时回 400", async () => {
      spies.logins.start.mockImplementationOnce(() => {
        throw new Error("适配器 napcat 不支持交互式登录")
      })
      const res = await call("POST", "logins", { adapterId: "napcat", mode: "qrcode" })
      expect(res.statusCode).toBe(400)
      expect(String(res.json().error)).toContain("不支持交互式登录")
    })

    it("答复要带整数 seq，答复结果与最新快照一起回", async () => {
      expect((await call("POST", "logins/l1/answer", { value: "1234" })).statusCode).toBe(400)

      const res = await call("POST", "logins/l1/answer", { seq: 2, value: "1234" })
      expect(res.statusCode).toBe(200)
      expect(res.json().accepted).toBe(true)
      expect((res.json().session as { id: string }).id).toBe("l1")
      expect(spies.logins.answer).toHaveBeenCalledWith("l1", 2, "1234")
    })

    it("取消会话，未知会话读快照回 404", async () => {
      expect((await call("DELETE", "logins/l1")).json().cancelled).toBe(true)
      expect((await call("GET", "logins/无名")).statusCode).toBe(404)
    })
  })

  describe("日志", () => {
    it("回看时把 limit / level / scope / keyword 传给日志枢纽", async () => {
      const res = await call("GET", "logs?limit=5&level=warn&scope=kernel&keyword=失败")
      expect(res.statusCode).toBe(200)
      expect(spies.loggerHub.tail).toHaveBeenCalledWith({
        limit: 5,
        level: "warn",
        scope: "kernel",
        keyword: "失败"
      })
    })

    it("非法 limit 与非法 level 都退回缺省，而不是报错", async () => {
      await call("GET", "logs?limit=abc&level=喧闹")
      expect(spies.loggerHub.tail).toHaveBeenCalledWith({ limit: 200 })
    })

    it("limit 有上限，防止一次把整个环形缓冲搬进内存", async () => {
      await call("GET", "logs?limit=999999")
      expect(spies.loggerHub.tail).toHaveBeenCalledWith({ limit: 2000 })
    })

    it("WebSocket 推送实时日志，按握手时的条件过滤，断开后摘除订阅", async () => {
      const ws = await server.raw.injectWS(`${API_SCOPE}/logs?level=warn`, upgradeCtx())
      expect(spies.loggerHub.listeners.size).toBe(1)

      const got = await new Promise<string>(resolve => {
        ws.on("message", (raw: unknown) => {
          resolve(String(raw))
        })
        for (const fn of spies.loggerHub.listeners) {
          // 级别低于 warn 的这条必须被过滤掉，否则下面的断言会读到它
          fn({ level: "debug", time: 1, msg: "不该出现" })
          fn({ level: "error", time: 2, msg: "出事了" })
        }
      })
      expect(JSON.parse(got)).toEqual({ level: "error", time: 2, msg: "出事了" })

      ws.terminate()
      // 订阅者表是进程级的，连接断开后必须完整摘除，见 api.ts 中的相关注释
      await vi.waitFor(() => {
        expect(spies.loggerHub.listeners.size).toBe(0)
      })
    })
  })

  /*
   * 这一组钉的是「发送到日志」那枚钮背后的端点，三条约定逐条钉住
   *
   * 它是全站唯一一个 `auth: false` 又碰得到令牌的地方，故每一条都得有用例看着：
   * 少了「响应不带令牌」那条，日后有人为了「让界面显示出来」把它加进响应体，
   * 而那等于把面板的全部写权限交给使用者浏览器里的任何一个页面。
   */
  describe("把令牌打进日志", () => {
    it("写进日志，但响应体一个字节都不带令牌", async () => {
      await config.patch({ server: { token: "SecretTokenAbc123" } }, "api")

      const res = await call("POST", "token/reveal")
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ ok: true, hasToken: true })
      // 整个响应体里都不该出现令牌，连 header 之外的任何字段都不行
      expect(res.body).not.toContain("SecretTokenAbc123")
      expect(logLines.some(line => line.startsWith("warn") && line.includes("SecretTokenAbc123"))).toBe(true)
    })

    it("不带令牌也能调 —— 需要它的人恰恰是没有令牌的那个", async () => {
      await config.patch({ server: { token: "SecretTokenAbc123" } }, "api")
      // call() 不带任何鉴权头；若这个端点要求令牌，它就对被挡在门外的人毫无用处
      expect((await call("POST", "token/reveal")).statusCode).toBe(200)
    })

    it("非本机对端一律 403", async () => {
      const res = await server.raw.inject({
        method: "POST",
        url: `${API_SCOPE}/token/reveal`,
        remoteAddress: "10.0.0.9"
      })
      expect(res.statusCode).toBe(403)
      expect(logLines.some(line => line.includes("SecretTokenAbc123"))).toBe(false)
    })

    it("节流：连着两次的第二次给 429，日志里只多一行", async () => {
      await config.patch({ server: { token: "SecretTokenAbc123" } }, "api")

      expect((await call("POST", "token/reveal")).statusCode).toBe(200)
      const again = await call("POST", "token/reveal")
      expect(again.statusCode).toBe(429)
      expect(logLines.filter(line => line.includes("SecretTokenAbc123")).length).toBe(1)
    })

    it("未设令牌时说明「留空即可进入」，而不是假装打了一行", async () => {
      const res = await call("POST", "token/reveal")
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ ok: true, hasToken: false })
    })
  })

  describe("插件市场", () => {
    it("列出索引，refresh=1 时强制刷新", async () => {
      const res = await call("GET", "market")
      expect(res.statusCode).toBe(200)
      expect((res.json().plugins as Array<{ name: string }>)[0]?.name).toBe("fresh")
      expect(spies.market.list).toHaveBeenCalledWith(false)

      await call("GET", "market?refresh=1")
      expect(spies.market.list).toHaveBeenCalledWith(true)

      await call("POST", "market/refresh")
      expect(spies.market.list).toHaveBeenLastCalledWith(true)
    })

    it("安装后默认立即加载，并把本次加载的插件名带回来", async () => {
      const res = await call("POST", "market/install", { name: "fresh" })
      expect(res.statusCode).toBe(200)
      expect(spies.market.install).toHaveBeenCalledWith("fresh", { dependencies: true })
      expect(spies.plugins.loadAll).toHaveBeenCalled()
      expect(res.json().loaded).toEqual(["fresh"])
      expect(res.json().version).toBe("1.0.0")
    })

    /*
     * 缺省装依赖，这一条只能由用例固定
     *
     * 缺省若翻回 false，表现是「装完却跑不起来」重新成为常态，而那条「请自行执行
     * pnpm install」的提示对着的是一个多数人不会去开的终端 —— 从接口的返回值上
     * 看不出缺省变过，故此处钉住。
     */
    it("装依赖缺省为真，显式传 false 才不装", async () => {
      await call("POST", "market/install", { name: "fresh", dependencies: false })
      expect(spies.market.install).toHaveBeenLastCalledWith("fresh", { dependencies: false })

      await call("POST", "market/demo/update", { dependencies: false })
      expect(spies.market.update).toHaveBeenLastCalledWith("demo", { dependencies: false, onDirty: "abort" })
    })

    /*
     * 装后步骤失败时不许加载
     *
     * `build` 挂了就没有 `dist/`，此时加载只会再报一条「找不到模块」—— 两条错误里
     * 后一条更显眼而更没用，使用者会去查模块解析，而真正的原因在上一条里。
     */
    it("装后步骤失败时不加载，原因原样带回", async () => {
      spies.market.install.mockResolvedValueOnce({
        name: "fresh",
        dir: join(dir, "plugins", "fresh"),
        via: "git",
        version: "1.0.0",
        needsDependencies: false,
        installedDeps: true,
        packageManager: "pnpm",
        ranScripts: [],
        setupError: "build：tsc 退出码 2"
      })
      const res = await call("POST", "market/install", { name: "fresh" })
      expect(res.statusCode).toBe(200)
      expect(spies.plugins.loadAll).not.toHaveBeenCalled()
      expect(res.json().loaded).toEqual([])
      expect(String(res.json().setupError)).toContain("tsc 退出码 2")
    })

    it("单独重跑装依赖与编译：先卸载再跑，跑完才加载", async () => {
      const res = await call("POST", "market/demo/setup", {})
      expect(res.statusCode).toBe(200)
      expect(spies.market.setup).toHaveBeenCalledWith("demo")
      // 顺序即正确性：build 会覆盖 dist，旧模块还在内存里就会响应刚被覆盖掉的代码
      expect(spies.plugins.unload.mock.invocationCallOrder[0]).toBeLessThan(
        spies.market.setup.mock.invocationCallOrder[0] ?? 0
      )
      expect(res.json().ranScripts).toEqual(["build"])
      expect(res.json().loaded).toEqual(["fresh"])
    })

    it("重跑装依赖失败时回 400", async () => {
      spies.market.setup.mockRejectedValueOnce(new Error("插件目录 无名 不存在"))
      const res = await call("POST", "market/无名/setup", {})
      expect(res.statusCode).toBe(400)
      expect(String(res.json().error)).toContain("不存在")
    })

    it("load 为 false 时只落盘不加载", async () => {
      const res = await call("POST", "market/install", { name: "fresh", load: false })
      expect(res.statusCode).toBe(200)
      expect(spies.plugins.loadAll).not.toHaveBeenCalled()
      expect(res.json().loaded).toEqual([])
    })

    it("缺少 name 回 400，安装失败也回 400", async () => {
      expect((await call("POST", "market/install", {})).statusCode).toBe(400)

      spies.market.install.mockRejectedValueOnce(new Error("插件 x 已安装，如需覆盖请先卸载"))
      const res = await call("POST", "market/install", { name: "x" })
      expect(res.statusCode).toBe(400)
      expect(String(res.json().error)).toContain("已安装")
    })

    it("更新已加载的插件时先卸载再覆盖安装", async () => {
      const res = await call("POST", "market/demo/update", {})
      expect(res.statusCode).toBe(200)
      expect(spies.plugins.unload).toHaveBeenCalledWith("demo")
      // onDirty 缺省为 abort：撞上本地改动时内核中止并交回决定权，面板据此弹一个必须回答的问句
      expect(spies.market.update).toHaveBeenCalledWith("demo", { dependencies: true, onDirty: "abort" })
      expect(res.json().unloaded).toBe(true)
      expect(res.json().version).toBe("2.0.0")
    })

    /*
     * `fresh` 走 install(replace) 而非 update()
     *
     * 这一条只能由用例钉住：两条路的返回值形状相同，从接口回值上看不出走了哪条。
     * 而差别是决定性的 —— `update()` 先试就地拉取，那条路成功时一个字节都不会重下，
     * 于是「重装」在目录被改花、产物与源码对不上时什么都修不了。
     */
    it("重装（fresh）跳过就地拉取，直接整目录重下", async () => {
      const res = await call("POST", "market/demo/update", { fresh: true })
      expect(res.statusCode).toBe(200)
      expect(spies.plugins.unload).toHaveBeenCalledWith("demo")
      expect(spies.market.update).not.toHaveBeenCalled()
      expect(spies.market.install).toHaveBeenCalledWith("demo", { replace: true, dependencies: true })
    })

    /*
     * 三个取值各自原样传下去
     *
     * 与上面那条缺省 `abort` 的用例是一组：合起来钉住「问过才动磁盘」。少了它们，一次
     * 「缺省翻成 stash」的改动不会让用例变红，而症状是使用者的改动在他没答应的情况下
     * 进了 stash。`discard` 那一路更要钉 —— 它不可撤销。
     */
    it("onDirty 的三个取值原样传给内核", async () => {
      await call("POST", "market/demo/update", { onDirty: "stash" })
      expect(spies.market.update).toHaveBeenLastCalledWith("demo", { dependencies: true, onDirty: "stash" })

      await call("POST", "market/demo/update", { onDirty: "discard" })
      expect(spies.market.update).toHaveBeenLastCalledWith("demo", { dependencies: true, onDirty: "discard" })

      const res = await call("POST", "market/demo/update", { onDirty: "abort" })
      expect(res.statusCode).toBe(200)
      expect(spies.market.update).toHaveBeenLastCalledWith("demo", { dependencies: true, onDirty: "abort" })
    })

    /*
     * 读不懂的 `onDirty` 退回 `abort`，而不是当作某个动作
     *
     * 面板与内核各自发布，一个新面板可能送来这里还不认识的取值。此时唯一安全的落点是
     * 「什么都不做」—— 猜成 stash 或 discard 都在替使用者动他的文件。
     */
    it("onDirty 取值不认识时退回 abort", async () => {
      await call("POST", "market/demo/update", { onDirty: "wipe" })
      expect(spies.market.update).toHaveBeenLastCalledWith("demo", { dependencies: true, onDirty: "abort" })
    })

    /*
     * 旧面板的 `stash: true` 继续收
     *
     * 面板与内核各自发布，版本不必齐步。旧面板只会送 `stash`，而它发出的那次更新不该
     * 因为内核换了参数名就以一条 400 收场。`onDirty` 同时在场时以它为准。
     */
    it("旧请求体的 stash: true 等价于 onDirty: stash", async () => {
      await call("POST", "market/demo/update", { stash: true })
      expect(spies.market.update).toHaveBeenLastCalledWith("demo", { dependencies: true, onDirty: "stash" })

      await call("POST", "market/demo/update", { stash: true, onDirty: "abort" })
      expect(spies.market.update).toHaveBeenLastCalledWith("demo", { dependencies: true, onDirty: "abort" })
    })

    /*
     * 探测端点：先问「会不会撞上改动」，再决定要不要弹那个问句
     *
     * 没有它的话，面板只能无条件先弹一次询问 —— 而绝大多数更新的目录是干净的，
     * 那一问纯属白问；或者先发一次注定失败的更新，靠错误文本反推，那是把可预料的
     * 分支做成了异常流程。
     */
    it("探测更新前的状况：回「会不会就地拉取」与「有没有改动」", async () => {
      // 覆盖替身的缺省（干净目录）：这一条要验的正是「有改动」那一项也原样带回
      spies.market.inspectUpdate.mockResolvedValueOnce({ willPull: true, dirty: true })
      const res = await call("GET", "market/demo/update-probe")
      expect(res.statusCode).toBe(200)
      expect(spies.market.inspectUpdate).toHaveBeenCalledWith("demo")
      expect(res.json()).toMatchObject({ willPull: true, dirty: true })
    })

    it("探测不需要写权限 —— 它一个字节都不改", async () => {
      const res = await call("GET", "market/demo/update-probe")
      expect(res.statusCode).toBe(200)
    })

    it("探测失败回 400，原因原样带回", async () => {
      spies.market.inspectUpdate.mockRejectedValueOnce(new Error("插件名不合法：../x"))
      const res = await call("GET", "market/..x/update-probe")
      expect(res.statusCode).toBe(400)
      expect(String(res.json().error)).toContain("不合法")
    })

    it("卸载先摘内存再删目录，目录不存在回 404", async () => {
      const res = await call("DELETE", "market/demo")
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ name: "demo", unloaded: true, removed: true })

      // 未加载的插件不该触发 unload，删不到目录时回 404
      spies.plugins.unload.mockClear()
      const missing = await call("DELETE", "market/无名")
      expect(missing.statusCode).toBe(404)
      expect(spies.plugins.unload).not.toHaveBeenCalled()
    })

    /*
     * 目录名与声明名不同名时，卸载按**目录**认插件
     *
     * 真实例子：中转站签到插件的目录（也是索引条目名）叫 `relay-checkin-plugin`，而它自己
     * `definePlugin({ name: "relay-checkin" })`。按名字卸载会错向两个相反的方向，且都不报错 ——
     * 这一条钉住「该卸的卸了」，下一条钉住「不该卸的没卸」。
     */
    it("更新时按目录认插件，卸的是目录里那个而非同名那个", async () => {
      spies.plugins.list.mockReturnValue([
        { name: "relay-checkin", version: "1.1.0", root: join(dir, "relay-checkin-plugin"), status: "loaded" }
      ])
      spies.plugins.get.mockImplementation((name: string) =>
        name === "relay-checkin" ? { name, status: "loaded" } : undefined
      )

      const res = await call("POST", "market/relay-checkin-plugin/update", {})
      expect(res.statusCode).toBe(200)
      expect(spies.plugins.unload).toHaveBeenCalledWith("relay-checkin")
      expect(spies.market.update).toHaveBeenCalledWith("relay-checkin-plugin", { dependencies: true, onDirty: "abort" })
    })

    /*
     * 拿声明名请求时早早挡下，且**一个插件都不卸**
     *
     * 这是一条真实发生过的缺陷：面板列表显示声明名、管理动作也拿它去请求，于是内核先把
     * `relay-checkin` 卸掉（那个名字在宿主里恰好存在），再去索引里找 `relay-checkin` 找不到
     * 而抛错 —— 插件从列表里凭空消失，目录却一个字节都没动，而错误文本说的是「市场里没有
     * 这个插件」，把人引向「市场是不是坏了」。
     */
    it("拿声明名当目录名请求更新：回 400 说该用哪个名字，且不卸载", async () => {
      spies.plugins.list.mockReturnValue([
        { name: "relay-checkin", version: "1.1.0", root: join(dir, "relay-checkin-plugin"), status: "loaded" }
      ])

      const res = await call("POST", "market/relay-checkin/update", {})
      expect(res.statusCode).toBe(400)
      expect(String(res.json().error)).toContain("relay-checkin-plugin")
      expect(spies.plugins.unload).not.toHaveBeenCalled()
      expect(spies.market.update).not.toHaveBeenCalled()
    })

    /*
     * 失败之后把插件装回来
     *
     * 卸载发生在动手**之前**，而「有本地改动且未同意暂存」是内核刻意的中止路径 ——
     * 对使用者的承诺是「目录停在原样」。少了这一手，那句承诺只对了一半：目录确实没动，
     * 插件却停了，而界面上只有一句关于改动的错误，看不出插件已经不在。
     */
    it("更新失败时把先前卸掉的插件装回来", async () => {
      spies.market.update.mockRejectedValueOnce(new Error("插件 demo 的目录内有未提交的改动"))
      const res = await call("POST", "market/demo/update", {})
      expect(res.statusCode).toBe(400)
      expect(String(res.json().error)).toContain("未提交的改动")
      expect(spies.plugins.unload).toHaveBeenCalledWith("demo")
      expect(spies.plugins.reload).toHaveBeenCalledWith("demo")
    })

    // 安装（replace 为假）压根不卸载，失败时自然也没什么可装回来的
    it("没卸载过就不必装回来", async () => {
      spies.market.install.mockRejectedValueOnce(new Error("取源失败"))
      const res = await call("POST", "market/install", { name: "fresh" })
      expect(res.statusCode).toBe(400)
      expect(spies.plugins.reload).not.toHaveBeenCalled()
    })

    // 另外两条也走同一个目录判据：少改一处的表现是「产物换了而旧模块还在响应命令」
    it("装依赖并编译、删除目录同样按目录认插件", async () => {
      spies.plugins.list.mockReturnValue([
        { name: "relay-checkin", version: "1.1.0", root: join(dir, "relay-checkin-plugin"), status: "loaded" }
      ])
      spies.plugins.get.mockImplementation((name: string) =>
        name === "relay-checkin" ? { name, status: "loaded" } : undefined
      )

      expect((await call("POST", "market/relay-checkin-plugin/setup", {})).statusCode).toBe(200)
      expect(spies.plugins.unload).toHaveBeenCalledWith("relay-checkin")

      spies.plugins.unload.mockClear()
      spies.market.remove.mockResolvedValueOnce(true)
      expect((await call("DELETE", "market/relay-checkin-plugin")).statusCode).toBe(200)
      expect(spies.plugins.unload).toHaveBeenCalledWith("relay-checkin")
    })

    it("未启用市场的部署一律回 501", async () => {
      off()
      const without: ApiDeps = { ...deps }
      delete (without as { market?: unknown }).market
      off = registerApi(server, without)

      expect((await call("GET", "market")).statusCode).toBe(501)
      expect((await call("POST", "market/install", { name: "fresh" })).statusCode).toBe(501)
    })
  })

  describe("服务器自省", () => {
    it("列出监听信息、连接数与三张路由表", async () => {
      server.route("/plugin/demo", "GET", "ping", () => "pong")
      const body = (await call("GET", "server")).json()
      expect(body.port).toBe(2536)
      expect(body.readonly).toBe(false)
      expect(body.connections).toBe(0)
      const routes = body.routes as Array<{ pattern: string; scope: string }>
      expect(routes.some(r => r.pattern === "/plugin/demo/ping")).toBe(true)
      expect(routes.some(r => r.scope === API_SCOPE)).toBe(true)
      expect((body.websockets as Array<{ pattern: string }>).some(w => w.pattern === `${API_SCOPE}/logs`)).toBe(true)
    })
  })

  describe("存储检视", () => {
    let driver: MemoryKvDriver
    let sqlExec: ReturnType<typeof vi.fn>

    beforeEach(async () => {
      driver = new MemoryKvDriver()
      await driver.open()
      await driver.set("plugin:demo:a", { v: { n: 1 } })
      await driver.set("plugin:demo:b", { v: "文本" })
      await driver.set("accounts:x", { v: 1 })

      sqlExec = vi.fn(async (_sql: string, _params: unknown[], opts: { allowWrite: boolean }) => ({
        readonly: true,
        columns: ["n"],
        rows: [[1]],
        truncated: false,
        cost: 0,
        allowWrite: opts.allowWrite
      }))
      const sql: SqlInspectSource = {
        enabled: true,
        databases: async () => [{ plugin: "demo", name: "gacha", size: 4096, open: false }],
        store: async (plugin, name) => {
          if (plugin === "bad!") throw new StorageError(400, "插件名不合法")
          if (name === "none") throw new StorageError(404, `没有库 ${plugin}/${name}`)
          if (name === "nomod") throw new SubsystemUnavailableError("SQL", "缺原生模块")
          return { handle: { all: async () => [] } as never, exec: sqlExec as never }
        }
      }

      off()
      off = registerApi(server, { ...deps, storage: { kv: createKvInspector(driver), sql } })
    })

    it("浏览根前缀时按子命名空间归并", async () => {
      const res = await call("GET", "storage/kv")
      expect(res.statusCode).toBe(200)
      const body = res.json() as { driver: string; groups: Array<{ name: string; count: number }> }
      expect(body.driver).toBe("memory")
      expect(body.groups).toEqual([
        { name: "accounts:", count: 1 },
        { name: "plugin:", count: 2 }
      ])
    })

    it("键走查询串，读写删往返一致", async () => {
      const key = encodeURIComponent("plugin:demo:a")
      expect((await call("GET", `storage/kv/entry?key=${key}`)).json().value).toEqual({ n: 1 })

      const put = await call("PUT", "storage/kv/entry", { key: "plugin:demo:c", value: [1, 2] })
      expect(put.statusCode).toBe(200)
      expect((await driver.get("plugin:demo:c"))?.v).toEqual([1, 2])

      expect((await call("DELETE", `storage/kv/entry?key=${key}`)).statusCode).toBe(200)
      expect((await call("GET", `storage/kv/entry?key=${key}`)).statusCode).toBe(404)
    })

    it("清空前缀不收空串", async () => {
      expect((await call("POST", "storage/kv/clear", { prefix: "" })).statusCode).toBe(400)
      const res = await call("POST", "storage/kv/clear", { prefix: "plugin:demo:" })
      expect(res.json().removed).toBe(2)
    })

    it("过去的过期时间点以 400 拒绝", async () => {
      const res = await call("PUT", "storage/kv/entry", { key: "k", value: 1, expireAt: 1 })
      expect(res.statusCode).toBe(400)
    })

    it("存储层错误映射为对应状态码", async () => {
      expect((await call("GET", "storage/sql/bad!/x/tables")).statusCode).toBe(400)
      expect((await call("GET", "storage/sql/demo/none/tables")).statusCode).toBe(404)
      expect((await call("GET", "storage/sql/demo/nomod/tables")).statusCode).toBe(503)
    })

    it("SQL 参数只收 JSON 能表达的标量", async () => {
      const bad = await call("POST", "storage/sql/demo/gacha/query", { sql: "SELECT ?", params: [{ a: 1 }] })
      expect(bad.statusCode).toBe(400)
      expect(sqlExec).not.toHaveBeenCalled()
    })

    it("只读模式下 KV 写一律 403，读与 SQL 查询照常（写语句由 exec 拦）", async () => {
      await config.patch({ server: { readonly: true } }, "api")

      expect((await call("GET", "storage/kv")).statusCode).toBe(200)
      expect((await call("PUT", "storage/kv/entry", { key: "k", value: 1 })).statusCode).toBe(403)
      expect((await call("DELETE", "storage/kv/entry?key=plugin%3Ademo%3Aa")).statusCode).toBe(403)
      expect((await call("POST", "storage/kv/clear", { prefix: "plugin:" })).statusCode).toBe(403)
      expect((await driver.get("plugin:demo:a"))?.v).toEqual({ n: 1 })

      const query = await call("POST", "storage/sql/demo/gacha/query", { sql: "SELECT 1" })
      expect(query.statusCode).toBe(200)
      expect(sqlExec.mock.calls[0]?.[2]).toMatchObject({ allowWrite: false })
    })

    it("未接入存储检视的部署一律 501", async () => {
      off()
      off = registerApi(server, deps)
      expect((await call("GET", "storage/kv")).statusCode).toBe(501)
      expect((await call("GET", "storage/sql")).statusCode).toBe(501)
    })
  })

  describe("生命周期", () => {
    it("registerApi 的 Disposer 会完整摘除全部端点", async () => {
      expect((await call("GET", "overview")).statusCode).toBe(200)
      off()
      expect((await call("GET", "overview")).statusCode).toBe(404)
      // afterEach 会再调一次，必须幂等
    })
  })

})


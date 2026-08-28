/**
 * 模块职责：测试替身（假日志器、录制型子系统接缝、最小应用视图）
 * 依赖方向：依赖 plugin/hooks、类型包；只被 `*.test.ts` 使用
 * 生命周期：每个用例新建一套
 * 注意事项：这些替身**刻意采用真实实现而非 mock 框架的自动桩** —— 注册后必须可查得到、
 *          注销后必须可查得已不存在，否则"卸载是否确实归还了资源"这类断言无从落地。
 *
 *          目前仅用于内核自身的测试。将来若需使插件作者亦可借其编写单元测试，
 *          须同时放开分层门禁中 `@yunzai-ng/core/*` 的深引限制 ——
 *          那是一次独立的、需要写入文档的决定，不在此处附带开放。
 */
import type {
  AdapterProvider,
  AppView,
  HttpClient,
  KvDriver,
  LogLevel,
  Logger,
  RenderRequest,
  RendererProvider,
  SqlHandle
} from "@yunzai-ng/types"
import type {
  CommandRegistration,
  KernelHooks,
  MiddlewareRegistration,
  TaskRegistration
} from "../plugin/hooks.js"

/** 带行记录的假日志器 */
export interface FakeLogger extends Logger {
  /** 已记录的日志行，形如 `"warn 消息 附加参数"` */
  readonly lines: string[]
}

/**
 * 创建假日志器
 *
 * 断言"出错时给了提示"而不是"抛异常中断"时用它 —— 框架里大量路径的正确行为
 * 就是"记一条能照着解决的 warn 然后继续跑"，没有日志断言就测不到。
 * @returns 假日志器
 */
export function fakeLogger(): FakeLogger {
  const lines: string[] = []
  /** 生成某个级别的记录函数 */
  const push =
    (level: string) =>
    (msg: unknown, ...args: unknown[]): void => {
      const extra = args.map(a => (a instanceof Error ? a.message : String(a))).join(" ")
      lines.push(`${level} ${String(msg)} ${extra}`.trim())
    }

  const logger: FakeLogger = {
    lines,
    level: "trace" as LogLevel,
    trace: push("trace"),
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    fatal: push("fatal"),
    mark: push("info"),
    child: () => logger,
    isLevelEnabled: () => true
  }
  return logger
}

/** 一条静态目录挂载记录 */
export interface StaticMount {
  /** URL 作用域；面板挂载记为归属标识（如 `plugin:webui-next`） */
  scope: string
  /** URL 前缀；面板挂载记为 `"/"` */
  urlPath: string
  /** 本地目录 */
  dir: string
  /** 是否为单页应用挂载（`ctx.panel()` 记为真） */
  spa: boolean
}

/** 一条路由记录 */
export interface RouteMount {
  /** URL 作用域 */
  scope: string
  /** 方法，WebSocket 记为 `"WS"` */
  method: string
  /** 路径 */
  path: string
}

/** 录制到的全部注册 */
export interface Recorded {
  /** 命令 */
  commands: CommandRegistration[]
  /** 重新索引的次数（按命令去重前的调用计数） */
  reindexed: CommandRegistration[]
  /** 中间件 */
  middlewares: MiddlewareRegistration[]
  /** 定时任务 */
  tasks: TaskRegistration[]
  /** 路由与 WebSocket */
  routes: RouteMount[]
  /** 静态目录 */
  statics: StaticMount[]
  /** 适配器 */
  adapters: AdapterProvider[]
  /** 渲染器 */
  renderers: RendererProvider[]
  /** 收到的渲染请求（断言 templateRoot/resourceRoot 是否算对） */
  renders: RenderRequest[]
  /** KV 驱动 */
  kvDrivers: KvDriver[]
  /** 已打开的 SQL 库，形如 `"插件名/库名"` */
  sqlOpened: string[]
  /** 被要求关闭全部库的插件名 */
  sqlClosed: string[]
}

/** 录制型接缝与其录制结果 */
export interface RecordingHooks {
  /** 交给上下文的接缝 */
  hooks: KernelHooks
  /** 录制结果 */
  recorded: Recorded
}

/**
 * 从数组里移除某项的 disposer
 * @param list 数组
 * @param item 待移除项
 * @returns 注销函数
 */
function remover<T>(list: T[], item: T): () => void {
  return () => {
    const index = list.indexOf(item)
    if (index >= 0) list.splice(index, 1)
  }
}

/**
 * 创建录制型子系统接缝
 *
 * 每个 `register` 均确实将登记写入数组，返回的 disposer 亦确实将其摘除。
 * 因此"插件卸载后残留多少条命令"可直接断言 `recorded.commands.length === 0`。
 * @returns 接缝与录制结果
 */
export function recordingHooks(): RecordingHooks {
  const recorded: Recorded = {
    commands: [],
    reindexed: [],
    middlewares: [],
    tasks: [],
    routes: [],
    statics: [],
    adapters: [],
    renderers: [],
    renders: [],
    kvDrivers: [],
    sqlOpened: [],
    sqlClosed: []
  }

  /** 假 SQL 句柄：只记录被调用过，不真的建库 */
  const sqlHandle = {
    file: ":fake:",
    exec: () => undefined,
    run: () => ({ changes: 0, lastInsertRowid: 0 }),
    get: () => undefined,
    all: () => [],
    transaction: <T>(fn: () => T) => fn(),
    pragma: () => undefined
  } as unknown as SqlHandle

  const hooks: KernelHooks = {
    commands: {
      register: reg => {
        recorded.commands.push(reg)
        return remover(recorded.commands, reg)
      },
      reindex: reg => void recorded.reindexed.push(reg)
    },
    middlewares: {
      register: reg => {
        recorded.middlewares.push(reg)
        return remover(recorded.middlewares, reg)
      }
    },
    tasks: {
      register: reg => {
        recorded.tasks.push(reg)
        return remover(recorded.tasks, reg)
      }
    },
    server: {
      info: { enabled: true, host: "127.0.0.1", port: 2536, publicUrl: "http://127.0.0.1:2536" },
      route: (scope, method, path) => {
        const mount: RouteMount = { scope, method, path }
        recorded.routes.push(mount)
        return remover(recorded.routes, mount)
      },
      websocket: (scope, path) => {
        const mount: RouteMount = { scope, method: "WS", path }
        recorded.routes.push(mount)
        return remover(recorded.routes, mount)
      },
      static: (scope, urlPath, dir) => {
        const mount: StaticMount = { scope, urlPath, dir, spa: false }
        recorded.statics.push(mount)
        return remover(recorded.statics, mount)
      },
      panel: (owner, dir) => {
        const mount: StaticMount = { scope: owner, urlPath: "/", dir, spa: true }
        recorded.statics.push(mount)
        return remover(recorded.statics, mount)
      },
      // 只按 urlPath 相等判断：录制型接缝不实现路径表，而调用方（内核挂载内置面板）
      // 问的只是"根路径有没有人接管"这一种情况
      claimant: path => recorded.statics.find(m => m.urlPath === path)?.scope
    },
    render: {
      register: provider => {
        recorded.renderers.push(provider)
        return remover(recorded.renderers, provider)
      },
      // 一张 3 字节的假图：断言"渲染结果被包成 ImageSegment"用得到，
      // 不需要真的产生 PNG
      render: async req => {
        recorded.renders.push(req)
        return { images: [new Uint8Array([1, 2, 3])], cost: 1, renderer: "fake" }
      }
    },
    adapters: {
      register: provider => {
        recorded.adapters.push(provider)
        return remover(recorded.adapters, provider)
      }
    },
    kvDrivers: {
      register: driver => {
        recorded.kvDrivers.push(driver)
        return remover(recorded.kvDrivers, driver)
      }
    },
    sql: {
      open: async (plugin, name) => {
        recorded.sqlOpened.push(`${plugin}/${name}`)
        return sqlHandle
      },
      close: async plugin => void recorded.sqlClosed.push(plugin)
    },
    bots: { pick: () => undefined }
  }

  return { hooks, recorded }
}

/**
 * 创建最小应用视图
 *
 * 只填测试真正会读的字段，其余用类型断言留空 —— `AppView` 聚合了适配器、
 * 账号、策略等一大票子系统视图，为一个上下文测试把它们全造出来毫无收益。
 * 一旦某个用例真的要读某字段，就在这里补上真的实现。
 * @returns 应用视图
 */
export function fakeAppView(): AppView {
  return {
    version: "0.0.0-test",
    startedAt: 0,
    usage: () => ({ rss: 0, heapUsed: 0, heapTotal: 0, external: 0, uptime: 0, cpu: 0 })
  } as unknown as AppView
}

/**
 * 创建假 HTTP 客户端
 *
 * 任何调用均抛错：网络请求出现在单元测试中几乎总属设计问题，应使其显式失败。
 *
 * 方法列表与 `HttpClient` 逐一对齐，且**不使用 as unknown as 断言** ——
 * 经断言的替身对象会掩盖"契约已变更"一事：真实客户端新增一个方法后，
 * 只有被测代码调用它时才在运行时抛错，而编译期不会报告任何问题。
 * @returns HTTP 客户端
 */
export function fakeHttp(): HttpClient {
  /** 统一拒绝 */
  const fail = (): never => {
    throw new Error("测试中不应发起真实 HTTP 请求")
  }
  const client: HttpClient = {
    request: fail,
    get: fail,
    post: fail,
    buffer: fail,
    download: fail,
    extend: () => client
  }
  return client
}

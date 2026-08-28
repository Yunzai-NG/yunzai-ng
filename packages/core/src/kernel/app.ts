/**
 * 模块职责：应用生命周期 `create → start → stop`，装配全部内核子系统
 * 依赖方向：依赖内核各模块（config / logger / store / http / plugin / platform）；
 *          **不依赖任何插件**，这是本次重写的核心不变量，由 scripts/check-layering.mjs 守着
 * 生命周期：一个进程一个实例；`stop()` 是终态，重启请新建实例
 * 注意事项：装配顺序不是任意排列，以下七项是强制约束 ——
 *
 *          **日志最先就绪，早于配置。** 否则「读配置时出错」无处记录，使用者只看到一个没有任何
 *          输出的进程。代价是轮转参数只能取 schema 默认值，配置里的改动次轮启动才生效（会记日志）。
 *
 *          **存储早于插件。** 插件加载失败要写状态、要记日志，两者都以 KV 为前提；反过来插件注册的
 *          KV 驱动本轮接管不了存储，见 kernel/kv-sink.ts。
 *
 *          **子系统接缝可后填。** `hooks` 与 `subsystems` 是可变对象，装配完直接替换字段即可，
 *          已加载的插件立即取得新实现（上下文是即时读取）。`server.enable` 为 false 时刻意不建实例，
 *          让 `hooks.server` 保持 `unavailableServer()` —— 插件调 `ctx.route()` 会得到一条说明原因的
 *          错误，而不是一次静默不生效的注册。
 *
 *          **`listen()` 排在插件加载之后、`app/ready` 之前。** 前者保证路由已齐、没有「面板部分可用」
 *          的窗口；后者是因为账号在 `app/ready` 里开始连接，反向 WebSocket 的适配器要求端点已可接入。
 *
 *          **AppView 全部用 getter。** 它被插件长期持有；若是值快照，替换 bots 注册表后插件手里
 *          那一份永远是空的。
 *
 *          **面板 API 在 `new App(...)` 之后挂载。** 它要读 `app.status` 与 `app.startedAt`。方向仍
 *          单向：`server/api.ts` 不认识 `App`，它收的是一组窄依赖加两个取值函数。
 *
 *          **内核不提供面板前端，只检测有没有插件提供。** 内核侧不留兜底实现 —— 兜底会使「替换面板」
 *          退化成必须改内核。
 */
import { createRequire } from "node:module"
import { isAbsolute, join, resolve } from "node:path"
import type {
  AccountsView,
  AdapterRegistryView,
  AppView,
  BotApi,
  BotRegistryView,
  Disposer,
  LogLevel,
  Logger,
  PlatformInfo,
  PluginsView,
  ResourceUsage,
  RuntimePaths,
  ServerInfo
} from "@yunzai-ng/types"
import {
  CORE_CONFIG_NAME,
  applyLogLevel,
  coreConfigSchema,
  defineCoreConfig,
  loggerSettingsOf,
  serverSecurityWarning,
  type CoreConfigHandle,
  type CoreConfigSnapshot
} from "../config/core-config.js"
import { createConfigStore, type ConfigStore } from "../config/store.js"
import { createManagedServer, type ManagedServer } from "../server/index.js"
import { registerApi, API_SCOPE } from "../server/api.js"
import { createHttpClient, type ManagedHttpClient } from "../http/client.js"
import { createLoggerHub, type LoggerHub } from "../logger/index.js"
import { detectPlatform, sampleUsage } from "../platform/detect.js"
import { sampleSystem } from "../platform/system.js"
import { ensurePaths, resolvePaths } from "../platform/paths.js"
import { createEventBus, type CoreEventBus } from "../plugin/events.js"
import { unavailableHooks, type KernelHooks } from "../plugin/hooks.js"
import { PluginHost, createPluginsView, type LoadReport, type RegistryInspectors } from "../plugin/host.js"
import { PluginMarket } from "../plugin/market.js"
import { createServiceRegistry, type ServiceRegistry } from "../plugin/services.js"
import { openKv, type KvStore } from "../store/index.js"
import { withTimeout } from "../util/defer.js"
import { parseDuration } from "../util/duration.js"
import { createKvDriverSink } from "./kv-sink.js"
import { createPolicy, type KernelPolicy } from "./policy.js"
import { installRuntime, type RuntimeParts } from "./runtime.js"
import { createSqlSink, type ManagedSqlSink } from "./sql-sink.js"

/** 读不到 package.json 时用的版本号 */
const FALLBACK_VERSION = "0.0.0-unknown"

/** 日志文件名前缀 */
const LOG_BASENAME = "yunzai"

/** `app/stopping` 的默认等待上限毫秒 */
const DEFAULT_STOP_TIMEOUT = 5000

/** 用于读自身 package.json（ESM 里没有 __dirname，也不能 import 到 rootDir 之外） */
const requireFromHere = createRequire(import.meta.url)

/**
 * 读内核版本
 *
 * `src/kernel/app.ts` 与 `dist/kernel/app.js` 到 package.json 都是两级，
 * 所以同一个相对路径在源码运行（vitest / tsx）与编译产物下都成立。
 * @returns 版本号；读不到时返回占位值而不是抛错 —— 版本号读不到不该让机器人起不来
 */
function readVersion(): string {
  try {
    const pkg = requireFromHere("../../package.json") as { version?: unknown }
    return typeof pkg.version === "string" ? pkg.version : FALLBACK_VERSION
  } catch {
    return FALLBACK_VERSION
  }
}

/**
 * 把配置里可能是相对路径的目录解析成绝对路径
 * @param home 应用主目录
 * @param value 配置值
 * @returns 绝对路径；配置为空时 undefined
 */
function resolveUnder(home: string, value: string | undefined): string | undefined {
  if (!value) return undefined
  return isAbsolute(value) ? value : resolve(home, value)
}

/** 应用状态 */
export type AppStatus = "created" | "starting" | "running" | "stopping" | "stopped"

/** 创建应用的参数 */
export interface CreateAppOptions {
  /** 应用主目录；缺省按 `resolvePaths` 的优先级探测 */
  home?: string
  /** 可执行文件所在目录，用于探测便携模式标记文件 */
  runtime?: string
  /** 内核版本，缺省从 `@yunzai-ng/core` 的 package.json 读 */
  version?: string
  /**
   * 启动期日志级别
   *
   * 早于配置生效，供 CLI 的 `--debug` 使用 —— 排查"配置本身有问题"时，
   * 待配置加载完成后再设置级别已然过晚。
   */
  logLevel?: LogLevel
  /** 是否输出到控制台，缺省 true；跑在服务里可关掉只留文件 */
  console?: boolean
  /** 随发行版预置的插件目录（绝对路径） */
  builtinDirs?: string[]
  /** 额外插件目录，叠加在配置项 `plugins.dirs` 之上 */
  extraDirs?: string[]
  /** 是否监听配置文件的外部改动，缺省 true */
  watchConfig?: boolean
  /** `app/stopping` 的等待上限毫秒，缺省 5000 */
  stopTimeout?: number
}

/**
 * 可后填的子系统视图
 *
 * 这些注册表由阶段三（适配器 / 账号管理）提供。内核先置入空实现，使 `AppView`
 * 类型完整、WebUI 可正常渲染空列表，装配完成后直接替换字段。
 *
 * 未采用"未装配即抛错"的原因：`AppView` 属插件的高频读取对象
 *（例如启动横幅打印在线账号数），为一个尚未到达的阶段令插件失败并不适当。
 */
export interface KernelSubsystems {
  /** 适配器注册表 */
  adapters: AdapterRegistryView
  /** 在线 Bot 注册表 */
  bots: BotRegistryView
  /** 账号视图 */
  accounts: AccountsView
  /** 命令与定时任务清单（供 `AppView.plugins` 与 WebUI） */
  registries: RegistryInspectors
}

/**
 * 构造一组空的子系统视图
 * @returns 子系统视图
 */
function emptySubsystems(): KernelSubsystems {
  return {
    adapters: { list: () => [], get: () => undefined },
    bots: { get: () => undefined, bySelfId: () => undefined, online: () => [], size: 0 },
    accounts: { list: () => [], get: () => undefined },
    registries: { commands: () => [], tasks: () => [], middlewares: () => [] }
  }
}

/**
 * 从 Bot 注册表里挑一个账号
 *
 * `hooks.bots.pick` 的实现放在内核而不是账号管理器里，是为了让阶段三只需要
 * 提供 `BotRegistryView`（一个纯查询接口），不必再实现一遍"省略 id 时取第一个"
 * 这种约定。
 * @param bots Bot 注册表
 * @param id 账号记录 id 或平台 selfId；省略时取第一个在线账号
 * @returns Bot；无可用账号时 undefined
 */
function pickBot(bots: BotRegistryView, id?: string): BotApi | undefined {
  if (id === undefined || id === "") return bots.online()[0]
  return bots.get(id) ?? bots.bySelfId(id)
}

/** 装配好的内核部件（`createApp` 内部用） */
interface AppParts {
  /** 版本号 */
  version: string
  /** 目录布局 */
  paths: RuntimePaths
  /** 环境信息 */
  platform: PlatformInfo
  /** 日志枢纽 */
  loggerHub: LoggerHub
  /** 配置仓库 */
  configStore: ConfigStore
  /** 内核配置句柄 */
  config: CoreConfigHandle
  /** KV 存储 */
  kv: KvStore
  /** SQL 接缝 */
  sql: ManagedSqlSink
  /** HTTP 客户端 */
  http: ManagedHttpClient
  /** 服务注册表 */
  services: ServiceRegistry
  /** 事件总线 */
  events: CoreEventBus
  /** 策略 */
  policy: KernelPolicy
  /** 子系统接缝 */
  hooks: KernelHooks
  /** 插件宿主 */
  host: PluginHost
  /** 插件视图 */
  pluginsView: PluginsView
  /** 可后填的子系统视图 */
  subsystems: KernelSubsystems
  /** 运行期子系统 */
  runtime: RuntimeParts
  /**
   * 装配期已登记的回收动作
   *
   * `installRuntime` 发生在 `new App(...)` 之前，其时尚无 `own()` 可供调用，
   * 因此它将回收动作累积于一个数组中，由此处接手。`stop()` 因而对"从未 start()"
   * 的实例亦能完整回收 —— 装配失败后调用 `stop()` 是最自然的补救动作。
   */
  disposers: Disposer[]
  /** 停机等待上限 */
  stopTimeout: number
  /**
   * 共享服务器
   *
   * `server.enable` 为 false 时是 `undefined`，此时 `hooks.server` 仍是
   * `unavailableServer()` 占位 —— 插件调 `ctx.route()` 会拿到一条说明原因的错误，
   * 而不是一个静默不生效的注册。
   */
  server: ManagedServer | undefined
}

/**
 * 应用实例
 *
 * 由 `createApp()` 创建。持有全部内核子系统，并负责按正确顺序把它们关掉 —— 没有这一层，
 * `Ctrl+C` 之后存储连接、浏览器进程与文件监听会各自漂着，要手动 kill。
 */
export class App {
  /** 内核版本 */
  readonly version: string
  /** 目录布局 */
  readonly paths: RuntimePaths
  /** 运行环境信息 */
  readonly platform: PlatformInfo
  /** 日志枢纽（WebUI 的日志回看与实时推送用它） */
  readonly loggerHub: LoggerHub
  /** 内核自己的日志器 */
  readonly logger: Logger
  /** 配置仓库（全部配置文件的登记处） */
  readonly configStore: ConfigStore
  /** 内核配置句柄 */
  readonly config: CoreConfigHandle
  /** KV 存储 */
  readonly kv: KvStore
  /** SQL 接缝 */
  readonly sql: ManagedSqlSink
  /** HTTP 客户端 */
  readonly http: ManagedHttpClient
  /** 服务注册表（`ctx.provide` / `ctx.inject`） */
  readonly services: ServiceRegistry
  /** 内核事件总线 */
  readonly events: CoreEventBus
  /** 策略（主人、前缀、维护模式） */
  readonly policy: KernelPolicy
  /**
   * 子系统接缝
   *
   * **可变**：管线层、调度器、服务器、渲染器装好后替换对应字段即可，
   * 已加载的插件立刻生效。见文件头第 3 条。
   */
  readonly hooks: KernelHooks
  /** 插件宿主 */
  readonly plugins: PluginHost
  /**
   * 可后填的子系统视图
   *
   * **可变**，同 `hooks`。阶段三装好适配器与账号管理后替换这里的字段。
   */
  readonly subsystems: KernelSubsystems
  /**
   * 运行期子系统的具体实现
   *
   * 与 `subsystems` 的区别：那边是交给插件的**只读窄视图**（列表、查询），
   * 这边是完整实现。WebUI 要做的事（增删账号、驱动登录会话、看渲染器状态、
   * 读分发器积压）都在窄视图之外，所以内核自己留一份引用。
   *
   * 插件拿不到它 —— `PluginContext` 只暴露 `ctx.app`（即 `view`）。
   */
  readonly runtime: RuntimeParts
  /** 只读应用视图（交给插件的那一份） */
  readonly view: AppView

  /** 插件视图 */
  readonly #pluginsView: PluginsView
  /** 共享服务器；`server.enable` 为 false 时没有 */
  readonly #server: ManagedServer | undefined
  /** 停机上限毫秒 */
  readonly #stopTimeout: number
  /** 需在 `stop()` 中回收的句柄；装配期与 `start()` 期登记的均在其中 */
  readonly #disposers: Disposer[]
  /** 当前状态 */
  #status: AppStatus = "created"
  /** 启动时间戳；未启动时为创建时间 */
  #startedAt = Date.now()

  /**
   * 内部构造函数，请用 `createApp()`
   *
   * 没有标 `private`：那样 `createApp()` 这个模块级函数自己也调不了。
   * 封装靠 `AppParts` **不导出** —— 包外拿不到那些内部类型，也就拼不出参数。
   * @param parts 已装配好的部件
   */
  constructor(parts: AppParts) {
    this.version = parts.version
    this.paths = parts.paths
    this.platform = parts.platform
    this.loggerHub = parts.loggerHub
    this.logger = parts.loggerHub.root.child({ scope: "kernel" })
    this.configStore = parts.configStore
    this.config = parts.config
    this.kv = parts.kv
    this.sql = parts.sql
    this.http = parts.http
    this.services = parts.services
    this.events = parts.events
    this.policy = parts.policy
    this.hooks = parts.hooks
    this.plugins = parts.host
    this.subsystems = parts.subsystems
    this.runtime = parts.runtime
    this.#pluginsView = parts.pluginsView
    this.#server = parts.server
    this.#stopTimeout = parts.stopTimeout
    // 复制而不是持有同一个数组：装配期那份数组不该在 App 建好之后还能被外部追加
    this.#disposers = [...parts.disposers]

    // 全部字段都是 getter：见文件头第 4 条
    const self = this
    this.view = {
      version: parts.version,
      paths: parts.paths,
      platform: parts.platform,
      policy: parts.policy,
      get startedAt(): number {
        return self.#startedAt
      },
      get adapters(): AdapterRegistryView {
        return self.subsystems.adapters
      },
      get bots(): BotRegistryView {
        return self.subsystems.bots
      },
      get accounts(): AccountsView {
        return self.subsystems.accounts
      },
      get plugins(): PluginsView {
        return self.#pluginsView
      },
      get server(): ServerInfo {
        // 单一来源：服务器信息只存在于接缝里，避免"改了监听端口但视图还是旧的"
        return self.hooks.server.info
      },
      usage: (): ResourceUsage => sampleUsage()
    }
  }

  /** 当前状态 */
  get status(): AppStatus {
    return this.#status
  }

  /** 启动时间戳（毫秒） */
  get startedAt(): number {
    return this.#startedAt
  }

  /** 当前配置快照 */
  get settings(): CoreConfigSnapshot {
    return this.config.get()
  }

  /**
   * 启动：加载插件、开启配置热加载、广播 `app/ready`
   *
   * 插件加载失败不会导致启动失败：单个插件写错一个正则，不该让整个实例起不来。
   * 失败清单在返回值里，同时记一条 warn。
   * @returns 插件加载汇总
   * @throws 已经启动过或已停机时；此时应新建实例而不是重启
   */
  async start(): Promise<LoadReport> {
    if (this.#status !== "created") {
      throw new Error(
        `应用当前状态为 ${this.#status}，不能再次 start()。stop() 是终态（连接池与日志文件都已关闭），重启请新建实例`
      )
    }
    this.#status = "starting"
    this.#startedAt = Date.now()

    // 配置热加载：目录监听 + 变更回调。两者均登记进 #disposers，
    // 否则 stop() 之后 watcher 仍在运行，进程无法退出
    this.own(this.configStore.startWatching())
    this.own(
      this.config.onChange(change => {
        applyLogLevel(this.loggerHub, change.next)
        // emitDetached：配置回调可能来自 fs 事件，没人在等它的返回值；
        // 用 emit 会把插件监听器的耗时算进文件监听的回调里
        this.events.emitDetached("config/changed", CORE_CONFIG_NAME, change.paths)
      })
    )

    // 令牌要在安全警告之前落定：否则"未设置访问令牌"的警告会和紧随其后的
    // "已自动生成令牌"自相矛盾，用户不知道该信哪句
    if (this.#server) await this.#server.ensureToken()

    const warning = serverSecurityWarning(this.settings)
    if (warning) this.logger.warn(warning)

    const report = await this.plugins.loadAll()
    if (report.failed.length > 0) {
      this.logger.warn(
        `${report.failed.length} 个插件未加载：${report.failed.map(f => f.name).join("、")}（详情见上文，或在面板的插件页查看）`
      )
    }
    this.logger.info(`插件就绪：成功 ${report.loaded.length} 个，失败 ${report.failed.length} 个，耗时 ${report.cost}ms`)

    // 监听要卡在这两步中间：
    // - 在 loadAll() 之后，插件的路由才齐，不会出现"面板半截可用"的窗口期；
    // - 在 app/ready 之前，因为账号是在那个事件里开始连接的（见 kernel/runtime.ts），
    //   而反向 WebSocket 的适配器需要端点已经能接入
    if (this.#server) {
      this.#reportPanel(this.#server)
      try {
        await this.#server.listen()
      } catch (err) {
        // 端口被占用不该让机器人整台起不来：消息收发和面板是两件独立的事
        this.logger.error(`共享服务器监听失败，面板与插件路由不可用：${err instanceof Error ? err.message : String(err)}`)
      }
    }

    await this.events.emit("app/ready")
    this.#status = "running"
    this.logger.mark(`Yunzai NG ${this.version} 已启动`)
    return report
  }

  /**
   * 检测面板由谁提供，并在无人提供时给出可照做的一条指令
   *
   * **内核不提供面板前端，此处只做检测。** 面板由插件调用 `ctx.panel()` 接管根路径，
   * 因此检测必须排在 `plugins.loadAll()` 之后。内核侧不设兜底实现：兜底实现要求
   * 内核知晓前端产物的目录约定，而那正是"替换面板必须改内核"的由来。
   *
   * 无人提供不是错误，只记一条 info：机器人收发消息与面板是两件独立的事，
   * 精简部署（不装面板插件）是受支持的形态。
   * @param server 共享服务器
   */
  #reportPanel(server: ManagedServer): void {
    const claimant = server.claimant("/")
    if (claimant !== undefined) {
      this.logger.debug(`站点根路径由 ${claimant} 提供`)
      return
    }
    this.logger.info(
      `未检测到提供面板的插件，当前仅 ${API_SCOPE} 可用。可在插件市场安装 webui，或将其置入 ${this.paths.plugins}`
    )
  }

  /**
   * 停机：广播 `app/stopping`、卸载插件、按依赖倒序关闭内核资源
   *
   * 幂等，可重复调用。任何一步出错均只记日志并继续执行下一步 ——
   * 停机路径上"某个资源无法关闭"绝不能连带导致其后的资源全部泄漏。
   * @returns 全部关闭后兑现
   */
  async stop(): Promise<void> {
    if (this.#status === "stopping" || this.#status === "stopped") return
    this.#status = "stopping"
    this.logger.info("正在停机…")

    // 1) 先让插件保存状态。超时就不等了：一个插件卡在这里不能让整个进程停不下来
    try {
      await withTimeout(
        this.events.emit("app/stopping"),
        this.#stopTimeout,
        `插件处理 app/stopping 超过 ${this.#stopTimeout}ms，不再等待（可能有插件在停机回调里发网络请求）`
      )
    } catch (err) {
      this.logger.warn(err instanceof Error ? err.message : String(err))
    }

    // 2) 卸载插件：宿主会按逆加载顺序回收每个插件登记的资源
    await this.#safely("插件", async () => {
      const count = await this.plugins.dispose()
      this.logger.debug(`已卸载 ${count} 个插件`)
    })

    // 3) 关闭服务器。必须在插件卸载之后：插件的 Disposer 需摘除自身注册的路由，
    //    若先关闭服务器，那些 Disposer 面对的是一张已清空的表（幂等，但为无效执行），
    //    且停机过程中面板应当能响应至最后一刻
    if (this.#server) await this.#safely("共享服务器", () => this.#server?.close() ?? Promise.resolve())

    // 4) 装配期与 start() 期登记的回收动作，后进先出
    for (const dispose of this.#disposers.reverse()) {
      await this.#safely("运行期资源", dispose)
    }
    this.#disposers.length = 0

    // 5) 内核资源。顺序 = 依赖倒序：先断掉还会产生事件的，再关存储，最后关日志
    await this.#safely("事件总线", () => this.events.close())
    await this.#safely("SQL 连接", () => this.sql.closeAll())
    await this.#safely("KV 存储", () => this.kv.close())
    await this.#safely("HTTP 连接池", () => this.http.close())
    await this.#safely("配置监听", () => this.configStore.dispose())

    this.#status = "stopped"
    this.logger.info("已停机")
    // 日志放在最后：上面每一步都还要往里写
    this.loggerHub.flush()
    this.loggerHub.close()
  }

  /**
   * 接管 `SIGINT` / `SIGTERM`，收到信号时优雅停机后退出进程
   *
   * 刻意做成**显式调用**而不是 `createApp()` 里自动装上：往 `process` 上挂
   * 全局监听器是有副作用的，嵌进别人程序里的内核不该私自决定进程什么时候退出。
   * CLI 的 `yzng start` 调它，单元测试不调。
   * @returns 取消接管
   */
  handleSignals(): Disposer {
    /** 是否已经在停机 */
    let leaving = false

    /**
     * 信号处理
     * @param signal 信号名
     */
    const onSignal = (signal: NodeJS.Signals): void => {
      if (leaving) {
        // 用户连按两次 Ctrl+C 的意思很明确：别等了。这时强退比"优雅"重要
        this.logger.warn(`再次收到 ${signal}，放弃优雅停机直接退出`)
        this.loggerHub.flush()
        process.exit(1)
      }
      leaving = true
      this.logger.info(`收到 ${signal}，开始停机（再按一次可强制退出）`)
      void this.stop().then(
        () => process.exit(0),
        () => process.exit(1)
      )
    }

    process.on("SIGINT", onSignal)
    process.on("SIGTERM", onSignal)
    return () => {
      process.off("SIGINT", onSignal)
      process.off("SIGTERM", onSignal)
    }
  }

  /**
   * 登记一个需在 `stop()` 中回收的句柄
   *
   * 回收按登记的**逆序**执行，位置是 `stop()` 的第 3 步 —— 插件已卸载完毕
   *（不再有向子系统注册的行为），而存储、事件总线、日志仍处于开启状态（尚可写出
   * 最后一次账号状态、尚可记录最后一行日志）。
   *
   * 公开而非私有：`start()` 用它登记配置监听，阶段四的服务器会用它登记
   * 关闭监听端口。装配期（`new App` 之前）的回收动作走
   * `AppParts.disposers`，因为那时还没有实例可调。
   * @param dispose 回收函数
   */
  own(dispose: Disposer): void {
    this.#disposers.push(dispose)
  }

  /**
   * 执行一步关闭动作，失败只记日志
   * @param what 关闭对象的名字，用于日志
   * @param fn 关闭动作
   */
  async #safely(what: string, fn: () => unknown): Promise<void> {
    try {
      await fn()
    } catch (err) {
      this.logger.warn(`关闭${what}时出错，继续停机`, err)
    }
  }
}

/**
 * 创建应用
 *
 * 只装配，不启动：返回时全部子系统已就绪但没有任何账号在连、没有任何插件被
 * 加载。调用方可以在此期间往 `hooks` / `subsystems` 里塞测试替身，再调
 * `start()`。CLI 与测试都走这条路。
 * @param opts 参数
 * @returns 应用实例
 * @throws 目录创建失败、或全部 KV 驱动都打不开时
 */
export async function createApp(opts: CreateAppOptions = {}): Promise<App> {
  const version = opts.version ?? readVersion()
  const platform = detectPlatform()
  const paths = await ensurePaths(resolvePaths({ home: opts.home, runtime: opts.runtime }))

  // ── 1. 日志 ───────────────────────────────────────────────────────────
  // 轮转参数取 schema 默认值而不是另写一套魔数：默认值只有一个来源
  const logDefaults = coreConfigSchema.defaults().log
  const loggerHub = createLoggerHub({
    level: opts.logLevel ?? logDefaults.level,
    dir: paths.logs,
    basename: LOG_BASENAME,
    console: opts.console !== false,
    color: logDefaults.color,
    maxSize: logDefaults.maxSize * 1024 * 1024,
    keepDays: logDefaults.keepDays,
    maxFiles: logDefaults.maxFiles
  })
  const root = loggerHub.root
  const logger = root.child({ scope: "kernel" })
  logger.info(`Yunzai NG ${version} 装配中：${platform.os}/${platform.arch}，Node ${platform.nodeVersion}`)
  logger.debug(`主目录 ${paths.home}${platform.isTermux ? "（Termux）" : ""}${platform.lowMemory ? "，低内存模式" : ""}`)

  // ── 2. 配置 ───────────────────────────────────────────────────────────
  const configStore = createConfigStore({ dir: paths.config, logger: root, watch: opts.watchConfig !== false })
  const config = await defineCoreConfig(configStore)
  const settings = config.get()
  applyLogLevel(loggerHub, settings)

  // 日志写入器已按默认值建立，轮转参数无法再变更；此处明确说明而非静默忽略
  const wanted = loggerSettingsOf(settings)
  if (
    wanted.maxSize !== logDefaults.maxSize * 1024 * 1024 ||
    wanted.keepDays !== logDefaults.keepDays ||
    wanted.maxFiles !== logDefaults.maxFiles
  ) {
    logger.info("日志的单文件上限 / 保留天数 / 文件数上限将在下次启动生效：日志必须早于配置就绪，见 kernel/app.ts 文件头")
  }

  // ── 3. 存储 ───────────────────────────────────────────────────────────
  const kv = await openKv({
    dir: resolveUnder(paths.home, settings.store.dir) ?? join(paths.data, "store"),
    driver: settings.store.driver,
    logger: root
  })
  const sql = createSqlSink({ dir: join(paths.data, "sql"), logger: root, enabled: settings.store.sqlite })

  // ── 4. 网络 ───────────────────────────────────────────────────────────
  // 超时在这里就折算成毫秒：配置里是 "20s" 这类人写的形式，
  // 往下传字符串的话每一层都得再解析一次，也各有一次解析失败的机会
  const http = createHttpClient({
    logger: root,
    timeout: parseDuration(settings.net.timeout, 20_000),
    retry: settings.net.retry,
    proxy: settings.net.proxy,
    userAgent: settings.net.userAgent ?? `Yunzai-NG/${version}`
  })

  // ── 5. 注册表与事件 ───────────────────────────────────────────────────
  const services = createServiceRegistry()
  const events = createEventBus({ logger: root })
  const policy = createPolicy(config)

  // ── 6. 子系统接缝：能填的填真的，填不了的留 unavailable ────────────────
  const subsystems = emptySubsystems()
  const hooks = unavailableHooks()
  hooks.sql = sql
  hooks.kvDrivers = createKvDriverSink({
    logger: root,
    requested: () => config.get().store.driver,
    active: kv.driver
  })
  hooks.bots = { pick: (id?: string) => pickBot(subsystems.bots, id) }

  // 共享服务器：关掉时刻意**不建实例**，`hooks.server` 保持 unavailable 占位。
  // 建一个"不监听的服务器"会让插件的 `ctx.route()` 注册成功却永远收不到请求，
  // 那比当场报错难查得多
  const server = settings.server.enable
    ? await createManagedServer({ config, logger: root.child({ scope: "server" }) })
    : undefined
  if (server) hooks.server = server

  // ── 7. 插件宿主 ───────────────────────────────────────────────────────
  // 插件目录：配置里的相对路径按主目录解析，命令行传的追加在后面
  const extraDirs = [
    ...settings.plugins.dirs.map(dir => resolveUnder(paths.home, dir)).filter((dir): dir is string => dir !== undefined),
    ...(opts.extraDirs ?? [])
  ]

  /**
   * 装配期的自引用槽
   *
   * 宿主要 `AppView`，而 `AppView.plugins` 正是宿主提供的 —— 死结只能靠
   * "先建宿主、事后回填"解开。用对象槽而不是 `let`，是为了让"这里有意存在
   * 一个装配期的空窗"这件事在类型上就写明白（`app?: App`）。
   */
  const selfRef: { app?: App } = {}

  const host = new PluginHost({
    paths,
    logger: root,
    config: configStore,
    kv,
    http,
    services,
    events,
    hooks,
    app: () => {
      if (!selfRef.app) throw new Error("内部错误：应用尚未装配完成就有人取用 AppView")
      return selfRef.app.view
    },
    extraDirs,
    builtinDirs: opts.builtinDirs,
    // 注意：禁用清单在这里固定下来。面板上"禁用某插件"应当同时 patch 配置
    // 并调用 host.unload()，这样无需重启也能立刻生效
    disabled: settings.plugins.disabled,
    setupTimeout: parseDuration(settings.plugins.loadTimeout, 30_000)
  })

  const pluginsView = createPluginsView(host, {
    commands: () => subsystems.registries.commands(),
    tasks: () => subsystems.registries.tasks(),
    middlewares: () => subsystems.registries.middlewares()
  })

  // 插件市场：只负责取索引与读写插件目录，不参与加载。安装完成后由面板决定
  // 何时调用 host.loadAll()，因此它与宿主之间没有直接依赖
  const market = new PluginMarket({
    http,
    logger: root.child({ scope: "market" }),
    pluginsDir: paths.plugins,
    tempDir: join(paths.temp, "market"),
    cacheFile: join(paths.cache, "market-index.json"),
    coreVersion: version,
    settings: () => {
      const current = config.get().market
      return {
        sources: current.sources,
        mirror: current.mirror,
        cacheTtl: parseDuration(current.cacheTtl, 3_600_000),
        timeout: parseDuration(current.timeout, 15_000)
      }
    }
  })

  // ── 8. 运行期子系统 ───────────────────────────────────────────────────
  // 必须在 new App 之前：否则 AppView 会存在一段"子系统仍为空占位"的窗口期，
  // 见 kernel/runtime.ts 文件头第 2 条。回收动作先行累积，交由 App 接手
  const disposers: Disposer[] = []
  const runtime = installRuntime({
    logger: root,
    config,
    kv,
    events,
    policy,
    hooks,
    subsystems,
    plugins: name => host.runtime(name),
    own: dispose => void disposers.push(dispose)
  })

  const app = new App({
    version,
    paths,
    platform,
    loggerHub,
    configStore,
    config,
    kv,
    sql,
    http,
    services,
    events,
    policy,
    hooks,
    host,
    pluginsView,
    subsystems,
    runtime,
    disposers,
    server,
    stopTimeout: opts.stopTimeout ?? DEFAULT_STOP_TIMEOUT
  })
  selfRef.app = app

  // ── 9. 面板 ───────────────────────────────────────────────────────────
  // 必须在 new App 之后：API 要读 `app.status` 与 `app.startedAt`，而这两个只有
  // 实例才有。反过来 api.ts 不认识 App —— 它收的是一组窄依赖与两个取值函数，
  // 于是 app → api 是单向的（见 server/api.ts 文件头第 1 条）
  if (server) {
    app.own(
      registerApi(server, {
        version,
        paths,
        platform,
        logger: root.child({ scope: "api" }),
        config,
        configStore,
        loggerHub,
        plugins: host,
        market,
        registries: {
          commands: () => subsystems.registries.commands(),
          tasks: () => subsystems.registries.tasks(),
          middlewares: () => subsystems.registries.middlewares()
        },
        adapters: runtime.adapters,
        accounts: runtime.accounts,
        logins: runtime.logins,
        bots: runtime.bots,
        renderers: runtime.renderers,
        dispatcher: runtime.dispatcher,
        server,
        status: () => app.status,
        startedAt: () => app.startedAt,
        usage: () => sampleUsage(),
        system: () => sampleSystem()
      })
    )
  }

  return app
}

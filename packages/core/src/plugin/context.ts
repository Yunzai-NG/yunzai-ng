/**
 * 模块职责：构造插件上下文（`ctx`）——"一切皆可为插件"的落地实现
 * 依赖方向：依赖 plugin/{hooks,events,services}、util/*、类型包；**不依赖任何子系统实现**
 * 生命周期：每个插件实例一个 ctx，随插件卸载整体失效
 * 注意事项：三条硬规则 ——
 *
 *          **零全局变量。** 全部能力须经 ctx 上的具名方法获取，故「某插件用了哪些能力」
 *          可枚举，卸载时可确定性回收。
 *
 *          **每个注册型方法都把 disposer 登记进 DisposalRegistry。** 插件作者无从遗漏清理 ——
 *          否则改十次代码就有十份定时器同时在跑。
 *
 *          **路径不做算术。** `ctx.resource()` 与模板根由内核依据插件根计算，`safeJoin` 拦
 *          `../` 越界；手工拼相对路径会在目录层级一变时给出空白页面。
 */
import { join } from "node:path"
import type {
  AdapterProvider,
  AppView,
  Awaitable,
  CommandBuilder,
  CommandHandler,
  CommandOptions,
  CommandPattern,
  ConfigHandle,
  ContactCache,
  ContactCacheOptions,
  CoreEventMap,
  Disposer,
  DurationLike,
  HttpClient,
  HttpMethod,
  KvDriver,
  KvNamespace,
  Logger,
  MessageScene,
  Middleware,
  MiddlewareOptions,
  PluginContext,
  RenderOptions,
  RenderablePage,
  RenderedImage,
  RendererProvider,
  RouteHandler,
  RouteOptions,
  SqlHandle,
  TaskFn,
  TaskOptions,
  WebSocketHandler,
  WebSocketOptions,
  BotApi,
  CooldownScope,
  ImageSegment
} from "@yunzai-ng/types"
import { DisposalRegistry } from "../util/dispose.js"
import { parseDuration } from "../util/duration.js"
import { safeJoin } from "../util/fs.js"
import { LruCache } from "../util/lru.js"
import type { CoreEventBus } from "./events.js"
import type { CommandRegistration, KernelHooks } from "./hooks.js"
import type { ServiceRegistry } from "./services.js"

/** 插件内的模板目录名 */
const TEMPLATE_DIR = "templates"

/** 插件内的静态资源目录名 */
const RESOURCE_DIR = "resources"

/** 渲染输出格式对应的 MIME */
const IMAGE_MIME: Record<string, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp"
}

/** 插件注册计数（供 WebUI 的插件列表展示） */
export interface PluginCounters {
  /** 已注册命令数 */
  commands: number
  /** 已注册中间件数 */
  middlewares: number
  /** 已注册定时任务数 */
  tasks: number
  /** 已注册路由数 */
  routes: number
  /** 已提供服务数 */
  services: number
}

/** 构造上下文所需的依赖 */
export interface PluginContextDeps {
  /** 插件名 */
  name: string
  /** 插件版本 */
  version: string
  /** 插件安装目录（绝对路径） */
  root: string
  /** 插件专属数据目录（绝对路径，调用方已确保存在） */
  dataDir: string
  /** 插件专属日志器 */
  logger: Logger
  /** 插件专属 KV 命名空间 */
  kv: KvNamespace
  /** 插件配置句柄 */
  config: ConfigHandle<unknown>
  /** 应用只读视图 */
  app: AppView
  /** HTTP 客户端 */
  http: HttpClient
  /** 服务注册表 */
  services: ServiceRegistry
  /** 内核事件总线 */
  events: CoreEventBus
  /** 子系统接缝 */
  hooks: KernelHooks
  /** 本插件的回收登记簿 */
  registry: DisposalRegistry
  /** 卸载信号 */
  signal: AbortSignal
}

/** 构造结果 */
export interface PluginContextHandle {
  /** 交给插件的上下文 */
  ctx: PluginContext<unknown>
  /** 实时计数，宿主用它填 `PluginState` */
  counters: PluginCounters
}

/**
 * 链式命令构造器
 *
 * 每一环都在改同一份 `CommandRegistration`，路由器持有该对象引用，
 * 因此 `.desc()` / `.master()` 这类不影响索引键的改动无需通知路由器；
 * 只有 `.alias()` 改了索引键才调 `reindex`。
 */
class ChainedCommand implements CommandBuilder {
  /** 登记内容 */
  readonly #reg: CommandRegistration
  /** 命令路由 */
  readonly #sink: KernelHooks["commands"]
  /** 注销句柄（已登记进 registry） */
  readonly #undo: Disposer
  /** 日志器，用于提示可疑用法 */
  readonly #logger: Logger

  /**
   * @param reg 登记内容
   * @param sink 命令路由
   * @param undo 注销句柄
   * @param logger 日志器
   */
  constructor(reg: CommandRegistration, sink: KernelHooks["commands"], undo: Disposer, logger: Logger) {
    this.#reg = reg
    this.#sink = sink
    this.#undo = undo
    this.#logger = logger
  }

  /**
   * 绑定处理函数
   * @param fn 处理函数
   * @returns 自身
   */
  action(fn: CommandHandler): CommandBuilder {
    if (this.#reg.handler) {
      // 覆盖 action 几乎总是复制粘贴的产物：静默覆盖会让人以为前一个还在生效
      this.#logger.warn(`命令 ${describePatterns(this.#reg.patterns)} 的 action 被重复设置，后者生效`)
    }
    this.#reg.handler = fn
    return this
  }

  /**
   * 追加别名
   * @param patterns 别名模式
   * @returns 自身
   */
  alias(...patterns: CommandPattern[]): CommandBuilder {
    if (patterns.length === 0) return this
    this.#reg.patterns.push(...patterns)
    this.#sink.reindex(this.#reg)
    return this
  }

  /**
   * 设置说明
   * @param text 说明文案
   * @returns 自身
   */
  desc(text: string): CommandBuilder {
    this.#reg.options.desc = text
    return this
  }

  /**
   * 限定场景
   * @param scenes 允许的场景
   * @returns 自身
   */
  scene(...scenes: MessageScene[]): CommandBuilder {
    this.#reg.options.scene = scenes
    return this
  }

  /**
   * 限定仅主人可用
   * @returns 自身
   */
  master(): CommandBuilder {
    this.#reg.options.master = true
    return this
  }

  /**
   * 限定仅群管可用
   * @returns 自身
   */
  admin(): CommandBuilder {
    this.#reg.options.admin = true
    return this
  }

  /**
   * 设置冷却
   * @param spec 冷却时长
   * @param scope 作用域
   * @returns 自身
   */
  cooldown(spec: DurationLike, scope?: CooldownScope): CommandBuilder {
    this.#reg.options.cooldown = spec
    if (scope) this.#reg.options.cooldownScope = scope
    return this
  }

  /**
   * 设置优先级
   * @param value 数值，小者优先
   * @returns 自身
   */
  priority(value: number): CommandBuilder {
    this.#reg.options.priority = value
    return this
  }

  /** 注销该命令 */
  dispose(): void {
    this.#undo()
  }
}

/**
 * 把模式数组渲染成可读文本
 * @param patterns 模式数组
 * @returns 可读字符串
 */
export function describePatterns(patterns: readonly CommandPattern[]): string {
  return patterns.map(p => (typeof p === "string" ? p : p.source)).join(" | ")
}

/** 归一化后的一次渲染调用 */
export interface RenderCall {
  /** 模板名：字符串通路为相对路径，TSX 通路为页面名（仅用于日志与临时文件名） */
  template: string
  /** 模板数据；TSX 通路为空对象 —— 数据已在组件求值时消化完毕 */
  data: Record<string, unknown>
  /** 已渲染好的 HTML；仅 TSX 通路有值 */
  html?: string
  /** 渲染选项 */
  opts: RenderOptions
}

/**
 * 把两条渲染通路的实参归一为一次调用描述
 *
 * `render()` 有两种形态：`render(page, opts)` 与 `render(template, data, opts)`。
 * 以第一参是否为字符串判别 —— `RenderablePage` 是对象，二者不可能混淆。
 * 判别只做这一处，两个调用点（`ctx.render` 与 `e.render`）共用同一份语义。
 * @param first 页面或模板相对路径
 * @param second 模板数据（字符串通路）或渲染选项（TSX 通路）
 * @param third 渲染选项（字符串通路）
 * @returns 归一化后的调用描述
 */
export function splitRenderArgs(
  first: RenderablePage | string,
  second?: Record<string, unknown> | RenderOptions,
  third?: RenderOptions
): RenderCall {
  if (typeof first === "string") {
    return { template: first, data: (second as Record<string, unknown> | undefined) ?? {}, opts: third ?? {} }
  }
  return { template: first.name, data: {}, html: first.html, opts: (second as RenderOptions | undefined) ?? {} }
}

/**
 * 插件上下文实现
 *
 * 每个成员都对应 `PluginContext` 的一项能力；除 `resource()` 这类纯计算外，
 * 所有注册都经过 `#own()` 登记回收。
 */
class Context implements PluginContext<unknown> {
  /** 依赖 */
  readonly #deps: PluginContextDeps
  /** 计数 */
  readonly #counters: PluginCounters
  /** 已打开的 SQL 库，按库名缓存（含进行中的打开操作） */
  readonly #sqlCache = new Map<string, Promise<SqlHandle>>()
  /** URL 作用域，如 `/plugin/mhy-game` */
  readonly #scope: string

  /** 插件名 */
  readonly name: string
  /** 插件版本 */
  readonly version: string
  /** 插件安装目录 */
  readonly root: string
  /** 插件数据目录 */
  readonly dataDir: string
  /** 插件日志器 */
  readonly logger: Logger
  /** 插件 KV 命名空间 */
  readonly kv: KvNamespace
  /** 插件配置句柄 */
  readonly config: ConfigHandle<unknown>
  /** 应用只读视图 */
  readonly app: AppView
  /** HTTP 客户端 */
  readonly http: HttpClient
  /** 卸载信号 */
  readonly signal: AbortSignal

  /**
   * @param deps 依赖
   * @param counters 计数对象（与宿主共享同一引用）
   */
  constructor(deps: PluginContextDeps, counters: PluginCounters) {
    this.#deps = deps
    this.#counters = counters
    this.#scope = `/plugin/${deps.name}`

    this.name = deps.name
    this.version = deps.version
    this.root = deps.root
    this.dataDir = deps.dataDir
    this.logger = deps.logger
    this.kv = deps.kv
    this.config = deps.config
    this.app = deps.app
    this.http = deps.http
    this.signal = deps.signal
  }

  /**
   * 声明一条命令
   * @param pattern 触发模式
   * @param opts 命令选项
   * @returns 链式构造器
   */
  command(pattern: CommandPattern, opts: CommandOptions = {}): CommandBuilder {
    const patterns: CommandPattern[] = [pattern]
    if (opts.alias) patterns.push(...(Array.isArray(opts.alias) ? opts.alias : [opts.alias]))

    // options 拷一份：插件可能复用同一个 options 字面量声明多条命令，
    // 而链式方法会就地改它
    const reg: CommandRegistration = {
      plugin: this.name,
      patterns,
      options: { ...opts },
      handler: undefined
    }

    const undo = this.#deps.hooks.commands.register(reg)
    this.#counters.commands++
    const disposer = this.#own(() => {
      this.#counters.commands--
      undo()
    }, `command:${describePatterns(patterns)}`)

    return new ChainedCommand(reg, this.#deps.hooks.commands, disposer, this.logger)
  }

  /**
   * 注册中间件
   * @param fn 中间件函数
   * @param opts 注册选项
   * @returns 注销句柄
   */
  middleware(fn: Middleware, opts: MiddlewareOptions = {}): Disposer {
    const undo = this.#deps.hooks.middlewares.register({ plugin: this.name, fn, options: opts })
    this.#counters.middlewares++
    return this.#own(() => {
      this.#counters.middlewares--
      undo()
    }, "middleware")
  }

  /**
   * 监听内核事件
   * @param event 事件名
   * @param handler 处理函数
   * @returns 注销句柄
   */
  on<K extends keyof CoreEventMap>(event: K, handler: (...args: CoreEventMap[K]) => Awaitable<void>): Disposer {
    return this.#own(this.#deps.events.on(event, handler, this.name), `on:${String(event)}`)
  }

  /**
   * 注册 cron 定时任务
   * @param expression cron 表达式
   * @param fn 任务体
   * @param opts 任务选项
   * @returns 注销句柄
   */
  cron(expression: string, fn: TaskFn, opts: TaskOptions = {}): Disposer {
    return this.#task("cron", expression, fn, opts)
  }

  /**
   * 注册固定间隔任务
   * @param interval 间隔
   * @param fn 任务体
   * @param opts 任务选项
   * @returns 注销句柄
   * @throws 间隔小于 1 秒时（几乎总是写错了单位）
   */
  every(interval: DurationLike, fn: TaskFn, opts: TaskOptions = {}): Disposer {
    const ms = parseDuration(interval, 0)
    if (ms < 1000) {
      throw new Error(`插件 ${this.name} 的间隔任务周期 ${ms}ms 过短：最小 1s，请确认单位是否写错`)
    }
    return this.#task("interval", ms, fn, opts)
  }

  /**
   * 对外提供服务
   * @param key 服务键
   * @param value 服务实例
   * @returns 注销句柄
   * @throws 键名非法或已被占用时
   */
  provide<T>(key: string, value: T): Disposer {
    const undo = this.#deps.services.provide(key, value, this.name)
    this.#counters.services++
    return this.#own(() => {
      this.#counters.services--
      undo()
    }, `provide:${key}`)
  }

  /**
   * 取用其他插件提供的服务
   * @param key 服务键
   * @returns 服务实例；未提供时 undefined
   */
  inject<T>(key: string): T | undefined {
    return this.#deps.services.get<T>(key)
  }

  /**
   * 取用服务，缺失即抛错
   * @param key 服务键
   * @returns 服务实例
   * @throws 服务未注册时
   */
  require<T>(key: string): T {
    return this.#deps.services.require<T>(key, this.name)
  }

  /**
   * 等待某服务就绪
   *
   * 插件被卸载时立刻以 undefined 结束等待：否则一个等不到的服务会把
   * 已卸载插件的闭包一直挂在内存里。
   * @param key 服务键
   * @param timeout 等待超时，缺省 30s
   * @returns 服务实例；超时或插件已卸载时 undefined
   */
  async waitFor<T>(key: string, timeout?: DurationLike): Promise<T | undefined> {
    if (this.signal.aborted) return undefined
    const ready = this.#deps.services.get<T>(key)
    if (ready !== undefined) return ready

    return new Promise<T | undefined>(resolve => {
      let settled = false
      /** 只兑现一次 */
      const finish = (value: T | undefined): void => {
        if (settled) return
        settled = true
        this.signal.removeEventListener("abort", onAbort)
        resolve(value)
      }
      /** 卸载时放弃等待 */
      function onAbort(): void {
        finish(undefined)
      }
      this.signal.addEventListener("abort", onAbort, { once: true })
      void this.#deps.services.waitFor<T>(key, timeout).then(finish, () => finish(undefined))
    })
  }

  /**
   * 注册 HTTP 路由
   * @param method HTTP 方法
   * @param path 路径
   * @param handler 处理函数
   * @param opts 选项
   * @returns 注销句柄
   * @throws 服务器未启用时
   */
  route(method: HttpMethod, path: string, handler: RouteHandler, opts?: RouteOptions): Disposer {
    const undo = this.#deps.hooks.server.route(this.#scope, method, path, handler, opts)
    this.#counters.routes++
    return this.#own(() => {
      this.#counters.routes--
      undo()
    }, `route:${method} ${path}`)
  }

  /**
   * 注册 WebSocket 路径
   * @param path 路径
   * @param handler 连接处理函数
   * @param opts 选项
   * @returns 注销句柄
   * @throws 服务器未启用时
   */
  websocket(path: string, handler: WebSocketHandler, opts?: WebSocketOptions): Disposer {
    const undo = this.#deps.hooks.server.websocket(this.#scope, path, handler, opts)
    this.#counters.routes++
    return this.#own(() => {
      this.#counters.routes--
      undo()
    }, `ws:${path}`)
  }

  /**
   * 挂载静态目录
   * @param urlPath URL 前缀
   * @param dir 本地目录绝对路径
   * @returns 注销句柄
   * @throws 服务器未启用时
   */
  static(urlPath: string, dir: string): Disposer {
    return this.#own(this.#deps.hooks.server.static(this.#scope, urlPath, dir), `static:${urlPath}`)
  }

  /**
   * 接管站点根路径，替换内置面板
   *
   * 不经过 `this.#scope`：接管面板的意义就在于占据 `/`，挂在
   * `/plugin/<插件名>` 之下的页面无法成为默认入口。归属标识写成
   * `plugin:<插件名>`，`claimant("/")` 因此能回答"面板由谁提供"。
   * 根路径已被占用时抛错，不静默覆盖 —— 见 types 里的说明。
   * @param dir 单页应用产物目录（绝对路径）
   * @returns 注销句柄
   * @throws 服务器未启用、或根路径已被占用时
   */
  panel(dir: string): Disposer {
    const undo = this.#deps.hooks.server.panel(`plugin:${this.name}`, dir)
    this.#deps.logger.info(`已接管面板根路径：${dir}`)
    return this.#own(undo, "panel:/")
  }

  /**
   * 注册适配器
   * @param provider 适配器实现
   * @returns 注销句柄
   */
  registerAdapter(provider: AdapterProvider): Disposer {
    return this.#own(this.#deps.hooks.adapters.register(provider, this.name), `adapter:${provider.id}`)
  }

  /**
   * 注册渲染器
   * @param provider 渲染器实现
   * @returns 注销句柄
   */
  registerRenderer(provider: RendererProvider): Disposer {
    return this.#own(this.#deps.hooks.render.register(provider, this.name), `renderer:${provider.id}`)
  }

  /**
   * 注册 KV 驱动
   * @param driver 驱动实现
   * @returns 注销句柄
   */
  registerKvDriver(driver: KvDriver): Disposer {
    return this.#own(this.#deps.hooks.kvDrivers.register(driver, this.name), `kv-driver:${driver.id}`)
  }

  /**
   * 渲染 TSX 页面为图片段
   * @param page 由 `defineTemplate()` 产出的页面
   * @param opts 渲染选项
   * @returns 图片段；分页时为数组
   * @throws 无可用渲染器、渲染失败或渲染器返回空结果时
   */
  async render(page: RenderablePage, opts?: RenderOptions): Promise<RenderedImage>

  /**
   * 渲染字符串模板为图片段
   *
   * 模板根与资源根由内核按插件目录算好（`<root>/templates`、`<root>/resources`），
   * 插件只写 `"player/daily-note"` 这样的相对名。
   * @param template 模板相对路径
   * @param data 模板数据
   * @param opts 渲染选项
   * @returns 图片段；分页时为数组
   * @throws 无可用渲染器、渲染失败或渲染器返回空结果时
   */
  async render(template: string, data?: Record<string, unknown>, opts?: RenderOptions): Promise<RenderedImage>

  /**
   * 渲染实现
   * @param first 页面或模板相对路径
   * @param second 模板数据（字符串通路）或渲染选项（TSX 通路）
   * @param third 渲染选项（字符串通路）
   * @returns 图片段；分页时为数组
   * @throws 无可用渲染器、渲染失败或渲染器返回空结果时
   */
  async render(
    first: RenderablePage | string,
    second?: Record<string, unknown> | RenderOptions,
    third?: RenderOptions
  ): Promise<RenderedImage> {
    const call = splitRenderArgs(first, second, third)

    const result = await this.#deps.hooks.render.render({
      ...call.opts,
      ...(call.html !== undefined ? { html: call.html } : {}),
      template: call.template,
      data: call.data,
      templateRoot: join(this.root, TEMPLATE_DIR),
      resourceRoot: join(this.root, RESOURCE_DIR),
      origin: this.name
    })

    if (result.images.length === 0) {
      throw new Error(`渲染器 ${result.renderer} 处理模板 ${call.template} 后没有产出图片`)
    }

    const type = call.opts.type ?? "jpeg"
    const mime = IMAGE_MIME[type] ?? "image/jpeg"
    const segments: ImageSegment[] = result.images.map((bytes, index) => ({
      type: "image",
      // buffer 直传：渲染器刚出的图就在内存里，转 base64 只是白占一倍内存
      file: { kind: "buffer", data: bytes, name: `${this.name}-${index}.${type}`, mime }
    }))

    return segments.length === 1 ? segments[0]! : segments
  }

  /**
   * 打开本插件专属的 SQLite 库
   *
   * 同名库只打开一次：插件在多处 `await ctx.sql()` 拿到的是同一个连接，
   * 否则 WAL 下多连接互相等锁，症状是"偶发变慢"，极难定位。
   * @param name 库名，缺省 `"main"`
   * @returns SQL 句柄
   * @throws better-sqlite3 不可用时
   */
  async sql(name = "main"): Promise<SqlHandle> {
    const cached = this.#sqlCache.get(name)
    if (cached) return cached

    const opening = this.#deps.hooks.sql.open(this.name, name)
    this.#sqlCache.set(name, opening)
    // 打开失败不留下坏缓存，否则重试永远拿到同一个已拒绝的 promise
    opening.catch(() => this.#sqlCache.delete(name))

    if (this.#sqlCache.size === 1) {
      this.#own(() => void this.#deps.hooks.sql.close(this.name), "sql:close")
    }
    return opening
  }

  /**
   * 创建 LRU + TTL 缓存
   * @param opts 缓存参数
   * @returns 缓存实例，随插件卸载自动清空
   */
  cache<V>(opts: ContactCacheOptions): ContactCache<V> {
    const cache = new LruCache<V>(opts)
    this.#own(() => cache.clear(), "cache")
    return cache
  }

  /**
   * 拼出插件内资源的绝对路径
   *
   * 走 `safeJoin`：插件传入 `"../../../etc/passwd"` 会被拒绝。参数很可能来自
   * 用户消息（如"看某个模板"），不挡住就是任意文件读。
   * @param parts 相对插件根的路径片段
   * @returns 绝对路径
   * @throws 结果越出插件根目录时
   */
  resource(...parts: string[]): string {
    return safeJoin(this.root, join(...parts))
  }

  /**
   * 注册清理回调
   * @param fn 清理函数
   */
  onDispose(fn: Disposer): void {
    this.#deps.registry.add(fn, "onDispose")
  }

  /**
   * 选一个可用账号
   * @param bot 账号记录 id 或平台 selfId
   * @returns Bot；无可用账号时 undefined
   */
  pickBot(bot?: string): BotApi | undefined {
    return this.#deps.hooks.bots.pick(bot)
  }

  /**
   * 登记定时任务
   * @param kind 任务类型
   * @param schedule cron 表达式或间隔毫秒
   * @param fn 任务体
   * @param opts 任务选项
   * @returns 注销句柄
   */
  #task(kind: "cron" | "interval", schedule: string | number, fn: TaskFn, opts: TaskOptions): Disposer {
    const undo = this.#deps.hooks.tasks.register({ plugin: this.name, kind, schedule, fn, options: opts })
    this.#counters.tasks++
    return this.#own(() => {
      this.#counters.tasks--
      undo()
    }, `task:${opts.name ?? schedule}`)
  }

  /**
   * 把一个 disposer 登记进本插件的回收簿
   *
   * 插件卸载后仍然发生的注册（异步 setup 慢一步）会被立即回收 ——
   * 这是 `DisposalRegistry.add` 的既有行为，此处依赖它。
   * @param fn 回收函数
   * @param label 标签
   * @returns 提前回收的句柄
   */
  #own(fn: Disposer, label: string): Disposer {
    return this.#deps.registry.add(fn, label)
  }
}

/**
 * 构造插件上下文
 * @param deps 依赖
 * @returns 上下文与计数对象
 */
export function createPluginContext(deps: PluginContextDeps): PluginContextHandle {
  const counters: PluginCounters = { commands: 0, middlewares: 0, tasks: 0, routes: 0, services: 0 }
  return { ctx: new Context(deps, counters), counters }
}

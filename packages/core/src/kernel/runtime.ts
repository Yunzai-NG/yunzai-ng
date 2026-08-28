/**
 * 模块职责：装配运行期子系统 —— 消息管线、调度器、渲染注册表、适配器与账号
 * 依赖方向：依赖 pipeline / scheduler / render / adapter 各层与内核基础设施；
 *          **不依赖任何插件**，亦不被上述任何一层反向 import（由 scripts/check-layering.mjs 守卫）
 * 生命周期：`createApp()` 中调用一次，且在 `new App(...)` **之前**；回收动作经 `own()` 移交 `App.stop()`
 * 注意事项：从 `kernel/app.ts` 拆出来是为了让那边只描述生命周期 —— 子系统之间的装配有十余条，
 *          混在 `createApp` 里会把「启动顺序」这条主线盖掉。附带收益是可单独测试：`RuntimeDeps`
 *          是一组窄依赖，不必先造一个真的 `App`。四条不可改的约定：
 *
 *          **必须早于 `new App(...)`。** 顺序反了，从 App 构造完到子系统装配完之间有一段空窗，
 *          `AppView.bots` 在那期间给出的是空占位注册表 —— 视图虽是 getter，窗口期内每次读取
 *          都是错的。
 *
 *          **接缝字段是「替换」而非「注入」。** `hooks` 与 `subsystems` 是可变对象，插件上下文每次
 *          使用时实时读取，故此处直接改写字段即可，不必通知任何一方。
 *
 *          **配置一律取 getter 或取值函数，不缓存快照。** 面板改了 `message.splitLength` 应当自下
 *          一条消息即生效。唯一的例外是 `message.concurrency` —— 信号量容量在创建时固定，这一点
 *          已写进它的配置说明。
 */
import type { Disposer, Logger } from "@yunzai-ng/types"
import { AccountManager } from "../adapter/accounts.js"
import { BotRegistry, type SendPolicyView } from "../adapter/bots.js"
import { createAdapterHostFactory } from "../adapter/host.js"
import { LoginManager } from "../adapter/login.js"
import { AdapterRegistry } from "../adapter/registry.js"
import type { CoreConfigHandle } from "../config/core-config.js"
import { CooldownStore } from "../pipeline/cooldown.js"
import { EventDispatcher } from "../pipeline/dispatch.js"
import { EventFactory, type PluginRuntimeView } from "../pipeline/event.js"
import { MiddlewarePipeline } from "../pipeline/middleware.js"
import { PromptRegistry } from "../pipeline/prompt.js"
import { CommandRouter } from "../pipeline/router.js"
import type { CoreEventBus } from "../plugin/events.js"
import type { KernelHooks } from "../plugin/hooks.js"
import { RenderRegistry, type RenderPolicy } from "../render/registry.js"
import { Scheduler } from "../scheduler/index.js"
import type { KvStore } from "../store/index.js"
import { parseDuration } from "../util/duration.js"
import type { KernelSubsystems } from "./app.js"
import type { KernelPolicy } from "./policy.js"

/** 适配器数据的 KV 命名空间名 */
const KV_ADAPTER = "adapter"

/** 账号记录的 KV 命名空间名 */
const KV_ACCOUNTS = "accounts"

/**
 * 发送超时读不出来时的兜底毫秒
 *
 * 与 `message.sendTimeout` 的 schema 默认值 `"30s"` 对应。schema 会在加载时
 * 校验时长格式，所以这个兜底实际上走不到；留着是因为"发送永不超时"的后果比
 * 一个偏差几秒的超时严重得多 —— 在 `sequential` 模式下，一次永不结束的发送
 * 会把那个会话的队列永久堵死。
 */
const FALLBACK_SEND_TIMEOUT = 30_000

/** 装配运行期子系统所需的依赖 */
export interface RuntimeDeps {
  /** 根日志器；各子系统自行派生 child */
  readonly logger: Logger
  /** 内核配置句柄 */
  readonly config: CoreConfigHandle
  /** KV 存储 */
  readonly kv: KvStore
  /** 内核事件总线 */
  readonly events: CoreEventBus
  /** 内核策略（同时充当三层的策略视图，见 `installRuntime` 的注释） */
  readonly policy: KernelPolicy
  /** 子系统接缝；本函数会替换其中五个字段 */
  readonly hooks: KernelHooks
  /** 可后填的子系统视图；本函数会替换全部四个字段 */
  readonly subsystems: KernelSubsystems
  /**
   * 按插件名取运行时上下文
   *
   * 由插件宿主提供（`PluginHost.runtime`）。分发器靠它把 `e.render()` 的模板根、
   * `e.prompt()` 的卸载信号绑到发起命令的那个插件上。
   * @param name 插件名
   * @returns 插件运行时视图；未加载或已卸载时 undefined
   */
  readonly plugins: (name: string) => PluginRuntimeView | undefined
  /**
   * 登记一个需要在停机时回收的动作
   *
   * 回收按登记的**逆序**执行，见 `kernel/app.ts` 的 `own()`。
   * @param dispose 回收函数
   */
  readonly own: (dispose: Disposer) => void
}

/**
 * 装配好的运行期子系统
 *
 * 暴露的是**具体实现**而不是窄视图：WebUI（阶段四）要做账号增删改查、要看
 * 登录会话快照、要列渲染器、要读分发器的积压计数，这些都在 `AppView` 的
 * 只读视图之外。`App` 持有这一份，WebUI 从 `App` 拿。
 */
export interface RuntimeParts {
  /** `prompt` 等待者登记表 */
  readonly prompts: PromptRegistry
  /** 事件工厂 */
  readonly factory: EventFactory
  /** 中间件管线 */
  readonly middlewares: MiddlewarePipeline
  /** 命令路由 */
  readonly router: CommandRouter
  /** 冷却存储 */
  readonly cooldown: CooldownStore
  /** 事件分发器（适配器唯一的入口） */
  readonly dispatcher: EventDispatcher
  /** 定时任务调度器 */
  readonly scheduler: Scheduler
  /** 渲染注册表 */
  readonly renderers: RenderRegistry
  /** 适配器注册表 */
  readonly adapters: AdapterRegistry
  /** 在线 Bot 注册表 */
  readonly bots: BotRegistry
  /** 账号管理器 */
  readonly accounts: AccountManager
  /** 登录会话管理器 */
  readonly logins: LoginManager
}

/**
 * 取当前渲染策略
 *
 * 超时解析不出来时给 0：`RenderRegistry.render()` 对非正值有自己的兜底
 * （60 秒），把那个数字再抄一遍只会多一处需要同步维护的地方。
 * @param config 内核配置句柄
 * @returns 渲染策略
 */
function renderPolicyOf(config: CoreConfigHandle): RenderPolicy {
  const r = config.get().render
  return {
    default: r.default,
    timeout: parseDuration(r.timeout, 0),
    retry: r.retry,
    quality: r.quality,
    scale: r.scale
  }
}

/**
 * 造一份"活的"发送策略视图
 *
 * 三个字段都是 getter：`BotFacade` 在**每次发送时**读它们（见 adapter/bots.ts），
 * 所以在面板上把切分长度从 3000 改成 1000，下一条消息就按 1000 切，
 * 不需要重连账号。缓存成快照的话就得重连才生效。
 * @param config 内核配置句柄
 * @returns 发送策略视图
 */
function sendPolicyOf(config: CoreConfigHandle): SendPolicyView {
  return {
    get splitLength(): number {
      return config.get().message.splitLength
    },
    get sendTimeout(): number {
      return parseDuration(config.get().message.sendTimeout, FALLBACK_SEND_TIMEOUT)
    },
    get sequential(): boolean {
      return config.get().message.sequential
    }
  }
}

/**
 * 装配全部运行期子系统，并把它们填进内核接缝
 *
 * 构造顺序按依赖来：管线（内层）→ 调度器与渲染（旁挂）→ 适配器与账号（外层，
 * 事件从这里进来）。`KernelPolicy` 会被同时当成 `DispatchPolicyView`、
 * `EventPolicyView`、`PolicyView` 传下去 —— 它结构上满足三者，多写三个适配器
 * 对象只会让"这几个视图必须对得上"这件事变得不明显。
 * @param deps 依赖
 * @returns 装配好的子系统
 */
export function installRuntime(deps: RuntimeDeps): RuntimeParts {
  const { logger, config, kv, events, policy, hooks, subsystems } = deps
  const log = logger.child({ scope: "runtime" })

  // ── 1. 消息管线 ───────────────────────────────────────────────────────
  const prompts = new PromptRegistry()
  const factory = new EventFactory({ logger, policy, prompts })
  const middlewares = new MiddlewarePipeline(logger)
  const router = new CommandRouter({ logger })
  const cooldown = new CooldownStore()
  const dispatcher = new EventDispatcher({
    logger,
    policy,
    events,
    factory,
    middlewares,
    router,
    cooldown,
    prompts,
    plugins: deps.plugins,
    // 只读一次：信号量的容量在构造时定下，见文件头第 4 条
    concurrency: config.get().message.concurrency
  })

  // ── 2. 调度器与渲染 ───────────────────────────────────────────────────
  const scheduler = new Scheduler({ logger })
  // onDone 在此处接线而非由注册表自己认识总线：注册表对渲染实现零认知，
  // 认识事件总线就等于认识插件系统（见 render/registry.ts 的构造参数注释）
  const renderers = new RenderRegistry({
    logger,
    policy: () => renderPolicyOf(config),
    onDone: info => events.emitDetached("render/done", info)
  })

  // ── 3. 适配器与账号 ───────────────────────────────────────────────────
  const adapters = new AdapterRegistry({ logger })
  const bots = new BotRegistry({ logger })
  const createHost = createAdapterHostFactory({
    logger,
    kv: kv.namespace(KV_ADAPTER),
    policy,
    server: () => hooks.server,
    // 不 await：适配器是在 socket 回调里调 dispatch 的，一条消息处理多久
    // 都不该把下一条报文的读取堵住。`submit()` 契约上永不抛出，所以也不需要
    // 在这里 catch —— 真出错了它自己会落日志并发 pipeline/error。
    dispatch: (event, bot) => void dispatcher.submit(event, bot)
  })
  const accounts = new AccountManager({
    logger,
    kv: kv.namespace(KV_ACCOUNTS),
    adapters,
    bots,
    createHost,
    events,
    sendPolicy: sendPolicyOf(config)
  })
  const logins = new LoginManager({
    logger,
    adapters,
    createAccount: (adapterId, cfg, label) => accounts.create(adapterId, cfg, label)
  })

  // ── 4. 填进接缝 ───────────────────────────────────────────────────────
  // 这五个在 app.ts 里原本是 unavailable*() 占位，插件调用它们会拿到一条
  // "该子系统尚未装配"的错误；替换之后已加载的插件立刻看到真实现
  hooks.commands = router
  hooks.middlewares = middlewares
  hooks.tasks = scheduler
  hooks.render = renderers
  hooks.adapters = adapters

  // hooks.bots.pick 不用动：app.ts 里那个闭包读的是 subsystems.bots，现取现用
  subsystems.adapters = adapters
  subsystems.bots = bots
  subsystems.accounts = accounts
  subsystems.registries = {
    commands: () => router.list(),
    tasks: () => scheduler.list(),
    middlewares: () => middlewares.list()
  }

  // ── 5. 账号上线时机 ───────────────────────────────────────────────────
  // 挂在 app/ready 而不是就地连接：适配器由插件注册，插件全部加载完之前连接
  // 必然因"适配器未注册"白失败一次（见 adapter/accounts.ts 的 load 注释）。
  deps.own(
    events.on("app/ready", async () => {
      // 只 await load()：账号列表要在 start() 返回前就位（WebUI 与插件的
      // app/ready 都可能立刻去读它）。而"连上"取决于对端 —— NapCat 没启动时
      // 一次 TCP 连接可能耗时数十秒，使 start() 阻塞于此只会令使用者误判框架已无响应。
      // 连接失败有退避重连兜着，插件想知道上线时机请听 bot/online。
      await accounts.load()
      void accounts.startAll().catch((err: unknown) => {
        log.error("启动账号时出现未预期的错误", err)
      })
    })
  )

  // ── 6. 停机回收 ───────────────────────────────────────────────────────
  // 登记顺序 = 从内到外，`App.stop()` 逆序执行（见 kernel/app.ts 第 3 步），
  // 于是实际关闭顺序是：账号 → 登录会话 → 管线残留 → 调度器 → 渲染器。
  // 先断账号，此后不再有新事件进管线；渲染器最后关，因为在它之前的每一步
  // 都还可能要出一张图（比如插件在 app/stopping 里发一条告别消息）。
  deps.own(() => renderers.stop())
  deps.own(() => scheduler.stop())
  deps.own(() => {
    // 兜底清扫：正常路径下插件卸载已逐条完整摘除，此处防的是越界注册
    middlewares.clear()
    router.clear()
    prompts.clear()
    cooldown.clear()
  })
  deps.own(() => logins.stop())
  deps.own(() => accounts.stop())

  return {
    prompts,
    factory,
    middlewares,
    router,
    cooldown,
    dispatcher,
    scheduler,
    renderers,
    adapters,
    bots,
    accounts,
    logins
  }
}

/**
 * 模块职责：插件契约与注入式上下文（框架最重要的对外接口）
 * 依赖方向：依赖本包内几乎所有其他模块
 * 生命周期：纯类型
 * 注意事项：插件想做的每件事都是 `ctx` 上的一个方法，且每个注册都返回 `Disposer`，
 *          故内核在卸载时能确定性地回收一切
 */
import type {
  AccountState,
  AdapterProvider,
  AdapterRegistryView,
  BotRegistryView,
  ContactCache,
  ContactCacheOptions,
  PolicyView
} from "./adapter.js"
import type { BotApi } from "./bot.js"
import type { Awaitable, Disposer, DurationLike } from "./common.js"
import type { ConfigHandle } from "./config.js"
import type { SendTarget } from "./contact.js"
import type { AnyEvent, MessageEvent, MessageScene, MetaEvent, NoticeEvent, RequestEvent } from "./event.js"
import type { HttpClient } from "./http.js"
import type { Logger } from "./logger.js"
import type { PlatformInfo, ResourceUsage, RuntimePaths } from "./platform.js"
import type { RenderOptions, RenderablePage, RenderedImage, RendererProvider } from "./renderer.js"
import type { KvDriver, KvNamespace, SqlHandle } from "./store.js"
import type {
  HttpMethod,
  RouteHandler,
  RouteOptions,
  ServerInfo,
  WebSocketHandler,
  WebSocketOptions
} from "./server.js"

/* ────────────────────────────── 命令 ────────────────────────────── */

/**
 * 命令模式
 *
 * - 字符串：前缀匹配，内核按首字符分桶索引，一条消息只试同桶的候选
 * - 正则：完整匹配 `e.text`，捕获组填进 `e.command.groups` / `captures`
 */
export type CommandPattern = string | RegExp

/** 冷却作用域 */
export type CooldownScope = "user" | "group" | "groupUser" | "global"

/** 命令声明选项 */
export interface CommandOptions {
  /** 别名，与主模式等价 */
  alias?: CommandPattern | CommandPattern[]
  /** 一句话说明，用于帮助与 WebUI */
  desc?: string
  /** 用法示例 */
  usage?: string
  /** 帮助里的分组名 */
  group?: string
  /** 限定生效场景，缺省全部 */
  scene?: MessageScene | MessageScene[]
  /** 仅主人可用 */
  master?: boolean
  /** 仅群管/群主可用 */
  admin?: boolean
  /** 冷却时长 */
  cooldown?: DurationLike
  /** 冷却作用域，缺省 `"user"` */
  cooldownScope?: CooldownScope
  /** 触发冷却时的提示语；缺省静默 */
  cooldownTip?: string
  /** 优先级，数值小者先匹配，缺省 100 */
  priority?: number
  /** 群聊中是否必须 @ 机器人才触发 */
  atMe?: boolean
  /** 是否允许触发词不在开头（默认必须以触发词开头） */
  anywhere?: boolean
  /** 命中后是否阻断后续命令，缺省 true */
  block?: boolean
  /** 是否在帮助中隐藏 */
  hidden?: boolean
}

/**
 * 命令处理函数
 *
 * 返回 `false` 表示"我不处理这条"，内核继续尝试后续命令。
 */
export type CommandHandler = (e: MessageEvent) => Awaitable<void | boolean>

/** 链式命令构造器 */
export interface CommandBuilder {
  /**
   * 绑定处理函数
   * @param fn 处理函数
   * @returns 自身，便于链式调用
   */
  action(fn: CommandHandler): CommandBuilder

  /**
   * 追加别名
   * @param patterns 别名模式
   * @returns 自身
   */
  alias(...patterns: CommandPattern[]): CommandBuilder

  /**
   * 设置说明
   * @param text 说明文案
   * @returns 自身
   */
  desc(text: string): CommandBuilder

  /**
   * 限定场景
   * @param scenes 允许的场景
   * @returns 自身
   */
  scene(...scenes: MessageScene[]): CommandBuilder

  /**
   * 限定仅主人可用
   * @returns 自身
   */
  master(): CommandBuilder

  /**
   * 限定仅群管可用
   * @returns 自身
   */
  admin(): CommandBuilder

  /**
   * 设置冷却
   * @param spec 冷却时长
   * @param scope 作用域
   * @returns 自身
   */
  cooldown(spec: DurationLike, scope?: CooldownScope): CommandBuilder

  /**
   * 设置优先级
   * @param value 数值，小者优先
   * @returns 自身
   */
  priority(value: number): CommandBuilder

  /** 注销该命令 */
  dispose(): void
}

/** 命令的对外描述（帮助、WebUI 用） */
export interface CommandInfo {
  /** 命令名 */
  name: string
  /** 全部触发模式的可读形式 */
  patterns: string[]
  /** 说明 */
  desc?: string
  /** 用法 */
  usage?: string
  /** 分组 */
  group?: string
  /** 所属插件 */
  plugin: string
  /** 是否仅主人 */
  master: boolean
  /** 是否仅群管 */
  admin: boolean
  /** 是否隐藏 */
  hidden: boolean
  /** 是否被用户禁用 */
  disabled: boolean
}

/* ────────────────────────────── 中间件 ────────────────────────────── */

/**
 * 中间件
 *
 * Koa 语义：接收事件与 `next`，可在 next 前后执行动作，不调用 next 即阻断。
 */
export type Middleware<E extends AnyEvent = AnyEvent> = (e: E, next: () => Promise<void>) => Awaitable<void>

/** 中间件注册选项 */
export interface MiddlewareOptions {
  /** 优先级，小者靠外层，缺省 100 */
  priority?: number
  /** 只对某类事件生效，缺省全部 */
  kind?: AnyEvent["kind"] | Array<AnyEvent["kind"]>
}

/** 中间件的对外描述，供 WebUI 展示；不含中间件函数本身（闭包序列化不出去） */
export interface MiddlewareInfo {
  /** 所属插件名 */
  plugin: string
  /** 实际生效的优先级（未声明时即缺省值） */
  priority: number
  /** 适用的事件大类；未声明 `kind` 的中间件在此列出全部大类，而非留空 */
  kinds: Array<AnyEvent["kind"]>
}

/* ────────────────────────────── 定时任务 ────────────────────────────── */

/** 定时任务体 */
export type TaskFn = (signal: AbortSignal) => Awaitable<void>

/** 定时任务选项 */
export interface TaskOptions {
  /** 任务名，用于日志与 WebUI；缺省用 cron 表达式 */
  name?: string
  /**
   * 上一轮还没跑完时的策略
   *
   * - `"skip"`（缺省）：跳过本轮，避免任务堆积
   * - `"queue"`：排队等上一轮结束
   */
  overlap?: "skip" | "queue"
  /** 单次执行超时；超时会 abort 传入的 signal */
  timeout?: DurationLike
  /** 是否在注册后立即执行一次 */
  immediate?: boolean
  /** 时区，缺省系统时区 */
  timezone?: string
}

/** 定时任务的对外描述 */
export interface TaskInfo {
  /** 任务名 */
  name: string
  /** cron 表达式或间隔说明 */
  schedule: string
  /** 所属插件 */
  plugin: string
  /** 下次执行时间（毫秒），无后续执行时 undefined */
  nextRun?: number
  /** 上次执行时间（毫秒） */
  lastRun?: number
  /** 上次耗时毫秒 */
  lastCost?: number
  /** 是否正在执行 */
  running: boolean
  /** 累计跳过次数（overlap=skip 生效的次数） */
  skipped: number
}

/* ────────────────────────────── 内核事件 ────────────────────────────── */

/** 一次命令处理的结果；三个「已完成」事件都带 `cost` 与 `ok`，供统计插件直接取用 */
export interface CommandDoneInfo {
  /** 命令所属插件 */
  plugin: string
  /** 命令名 */
  command: string
  /** 处理耗时毫秒 */
  cost: number
  /** 是否正常结束（抛错为假） */
  ok: boolean
  /** 出错时的可读信息 */
  error?: string
}

/** 一次消息发送的结果 */
export interface MessageSentInfo {
  /** 发出该消息的账号记录 id */
  accountId: string
  /** 适配器 id */
  adapterId: string
  /** 平台标识 */
  platform: string
  /** 发送目标 */
  target: SendTarget
  /** 消息段数 */
  segments: number
  /** 各类型段的计数，如 `{ text: 1, image: 2 }` */
  kinds: Record<string, number>
  /** 发送耗时毫秒 */
  cost: number
  /** 平台是否接收 */
  ok: boolean
}

/** 一次渲染的结果 */
export interface RenderDoneInfo {
  /** 实际出图的渲染器 id */
  renderer: string
  /** 模板标识 */
  template: string
  /** 出图张数 */
  images: number
  /** 产物总字节数 */
  bytes: number
  /** 渲染耗时毫秒 */
  cost: number
  /** 是否成功 */
  ok: boolean
  /** 失败原因 */
  error?: string
}

/** `ctx.on` 可监听的内核事件与其参数 */
export interface CoreEventMap {
  /** 全部插件加载完成、服务已就绪 */
  "app/ready": []
  /** 开始停机，插件应在此保存状态 */
  "app/stopping": []
  /** 某账号上线 */
  "bot/online": [bot: BotApi]
  /** 某账号下线 */
  "bot/offline": [bot: BotApi, reason: string | undefined]
  /** 收到消息（在命令路由之后触发，便于做统计） */
  message: [e: MessageEvent]
  /** 收到通知 */
  notice: [e: NoticeEvent]
  /** 收到请求 */
  request: [e: RequestEvent]
  /** 收到元事件 */
  meta: [e: MetaEvent]
  /** 某插件加载完成 */
  "plugin/loaded": [name: string]
  /** 某插件已卸载 */
  "plugin/unloaded": [name: string]
  /** 某插件加载失败 */
  "plugin/error": [name: string, err: unknown]
  /** 某配置发生变更 */
  "config/changed": [owner: string, paths: string[]]
  /** 事件处理中抛出未捕获错误 */
  "pipeline/error": [e: AnyEvent, err: unknown]
  /** 一条命令处理完毕（成功或抛错都会触发）；一条消息可能命中零条或多条命令 */
  "command/done": [e: MessageEvent, info: CommandDoneInfo]
  /** 一条消息已发出；埋在 `BotApi.sendMessage` 的出口，故主动推送也在其中 */
  "message/sent": [info: MessageSentInfo]
  /** 一次渲染结束（成功或全部渲染器失败） */
  "render/done": [info: RenderDoneInfo]
}

/* ────────────────────────────── 应用视图 ────────────────────────────── */

/** 账号管理视图 */
export interface AccountsView {
  /**
   * 列出全部账号及其状态
   * @returns 状态快照数组
   */
  list(): AccountState[]

  /**
   * 按记录 id 取账号状态
   * @param id 账号记录 id
   * @returns 状态快照，不存在时 undefined
   */
  get(id: string): AccountState | undefined
}

/** 插件运行状态 */
export type PluginStatus = "loaded" | "disabled" | "error"

/** 插件状态快照 */
export interface PluginState {
  /** 插件名 */
  name: string
  /** 版本 */
  version: string
  /** 说明 */
  description?: string
  /** 作者 */
  author?: string
  /** 仓库或主页地址，取自 `package.json` 的 `homepage` 或 `definePlugin` 同名字段；取不到时不出现 */
  homepage?: string
  /** 安装目录 */
  root: string
  /** 当前状态 */
  status: PluginStatus
  /** 出错时的信息 */
  error?: string
  /** 加载耗时毫秒 */
  loadCost: number
  /** 注册的命令数 */
  commands: number
  /** 注册的定时任务数 */
  tasks: number
  /** 注册的中间件数 */
  middlewares: number
  /** 是否位于随发行版预置的插件目录，仅宿主显式传入 `builtinDirs` 时为真 */
  builtin: boolean
  /** 是否声明了配置 schema；加载失败的插件恒为假，其 `setup` 未执行 */
  configured: boolean
}

/** 插件管理视图 */
export interface PluginsView {
  /**
   * 列出全部插件
   * @returns 状态快照数组
   */
  list(): PluginState[]

  /**
   * 按名取插件
   * @param name 插件名
   * @returns 状态快照，未安装时 undefined
   */
  get(name: string): PluginState | undefined

  /**
   * 列出全部命令
   * @returns 命令描述数组
   */
  commands(): CommandInfo[]

  /**
   * 列出全部定时任务
   * @returns 任务描述数组
   */
  tasks(): TaskInfo[]

  /**
   * 列出全部中间件，顺序即实际的执行顺序
   * @returns 中间件描述数组
   */
  middlewares(): MiddlewareInfo[]
}

/**
 * 撞上本地改动时怎么办
 *
 * 与内核市场的同名取值一一对应。缺省 `abort`：不给出处置方式时不该有任何磁盘动作。
 */
export type PluginDirtyAction = "abort" | "stash" | "discard"

/** 一次更新探测的结果 */
export interface PluginUpdateProbe {
  /** 这次更新会不会走就地拉取；为假即整目录重装那条路 */
  readonly willPull: boolean
  /** 目录里有没有未提交的改动（含未跟踪文件）。`willPull` 为假时恒为假 */
  readonly dirty: boolean
}

/** 一次更新带来的一条提交 */
export interface PluginCommit {
  /** 短提交号 */
  readonly hash: string
  /** 提交时间（毫秒时间戳） */
  readonly time: number
  /** 提交说明的首行 */
  readonly subject: string
}

/**
 * 一次插件更新的结果
 *
 * 刻意比内核市场的 `InstallResult` 窄：那里还带着安装目录、取源方式一类只有面板用得上的
 * 字段，而维护面要的是「更新到了哪一版、有没有真的变、本地改动去哪了」。
 */
export interface PluginUpdateOutcome {
  /** 插件名（安装目录名） */
  readonly name: string
  /** 更新后的版本 */
  readonly version: string
  /** 更新前的版本，仅就地拉取时存在 */
  readonly fromVersion?: string
  /** 是否确实有新提交；`false` 表示已是最新 */
  readonly changed?: boolean
  /** 这次拉来的新提交，新的在前；仅就地拉取且取得到历史时存在 */
  readonly commits?: readonly PluginCommit[]
  /** 装依赖失败的原因；此时新代码多半跑不起来，不该重载 */
  readonly dependencyError?: string
  /** 装后步骤（如 build）失败的原因，带上失败的 script；此时产物仍是旧的，不该重载 */
  readonly setupError?: string
  /** 本次是否暂存过本地改动；可 `git stash pop` 取回 */
  readonly stashed?: boolean
  /**
   * 本次是否按调用方的选择丢弃了本地改动
   *
   * 与 {@link stashed} 互斥，且必须分开报：这一路没有任何可取回的东西，
   * 而对一个刚把改动丢掉的人说「可以 stash pop 取回」会让他以为改动还在。
   */
  readonly discarded?: boolean
}

/** 更新一个插件的选项 */
export interface PluginUpdateOptions {
  /** 是否装依赖，缺省装 */
  readonly dependencies?: boolean
  /** 撞上本地改动时怎么办，缺省 `abort` */
  readonly onDirty?: PluginDirtyAction
}

/** 请求重启时的说明 */
export interface RestartRequest {
  /** 为什么要重启，会写进停机日志 —— 事后翻日志时「谁让它重启的」是第一个问题 */
  readonly reason?: string
}

/** 请求关机时的说明 */
export interface ShutdownRequest {
  /** 为什么要关机，会写进停机日志 */
  readonly reason?: string
}

/**
 * 进程守护
 *
 * - `pm2` / `systemd`：外部守护，按启动器注入的环境变量探测。
 * - `yzng`：CLI 自带的守护 —— `yzng start` 缺省会 fork 一个子进程跑内核，父进程按子进程
 *   的退出码决定重启还是收工。它对插件而言与外部守护无异（重启拉得起、关机拉不起）。
 *
 * `undefined` **不证明没有守护**：Windows 服务（nssm）一类不留可识别的环境痕迹，且
 * 使用者可能以 `--no-supervise` 关掉自带守护而另接一层探测不到的守护。故它只用于
 * 「能确认有守护时给使用者一句准话」，不可用于拒绝重启 —— 那会让那批人用不了这个功能。
 */
export type SupervisorKind = "pm2" | "systemd" | "yzng"

/**
 * 维护面：更新插件与请求重启
 *
 * 与 `AppView` 其余部分的只读性质不同，**这里是能改变实例状态的具名 API**，
 * 独立成面正是为了让「插件动了什么」在类型上一眼看得出（见 `AppView` 的说明）。
 *
 * **刻意不开放安装与删除。** 市场能装任意 git 仓库，等于在这台机器上执行任意代码；
 * 而「更新已装插件」是就地 `fetch` + `reset`，目标仓库早被使用者信任过一次。
 * 两者的信任边界不同，故只开后者。
 */
export interface MaintenanceView {
  /**
   * 探测到的外部进程守护；探测不到时 undefined（见 {@link SupervisorKind}）
   */
  readonly supervisor: SupervisorKind | undefined

  /**
   * 请求重启是否真能生效，即「宿主有没有注册过重启处理器」
   *
   * **它不说明有没有外部守护。** `yzng start` 一律注册处理器，故它起的实例上恒为真，
   * 裸启动也一样 —— 那种实例停机后没人拉起。为假只出现在内核被嵌进别的程序、或单元
   * 测试里，此时 {@link requestRestart} 只记一条日志而不停机。
   *
   * 判断「停机后会不会被拉起来」只能参考 {@link supervisor}，而它探测不到亦不等于没有
   * 守护（Windows 服务不留痕迹），故适合用来问一句，不适合用来拦。
   */
  readonly canRestart: boolean

  /**
   * 探测一次插件更新
   * @param name 插件名（安装目录名）
   * @returns 会不会走就地拉取、目录里有没有改动
   * @throws 名称不合法时
   */
  inspectUpdate(name: string): Promise<PluginUpdateProbe>

  /**
   * 更新一个已装插件（含装依赖与装后步骤）
   * @param name 插件名（安装目录名）
   * @param opts 选项
   * @returns 更新结果
   * @throws 名称不合法、目录不存在、有改动而未给出处置方式，或取源失败时
   */
  updatePlugin(name: string, opts?: PluginUpdateOptions): Promise<PluginUpdateOutcome>

  /**
   * 重载一个插件，使更新后的代码立即生效
   *
   * 多数插件更新后无须重启整个进程，重载即可。内核自身的更新不在此列。
   * @param name 插件名
   * @returns 是否重载成功
   */
  reloadPlugin(name: string): Promise<boolean>

  /**
   * 请求重启整个进程
   *
   * 内核**没有**自我重启的能力（`stop()` 是终态），本方法做的是「优雅停机后以一个
   * 约定的退出码退出」，再由外部守护（pm2 / systemd / Windows 服务）把它拉起来。
   * 因此 {@link canRestart} 为假时它只记一条日志、什么都不做。
   *
   * 调用后当前进程即进入停机流程，故**要先把话说完**：命令处理函数里应先
   * `await e.reply(...)` 再调它，否则那句「正在重启」还在发送队列里就被停机带走了。
   * @param req 说明
   * @returns 已开始停机时兑现；无人接管时立即兑现
   */
  requestRestart(req?: RestartRequest): Promise<void>

  /**
   * 请求关机是否真能生效，即「宿主有没有注册过关机处理器」
   *
   * 与 {@link canRestart} 同理，它也不说明有没有外部守护 —— 关机之后不被拉起来，
   * 靠的是宿主用一个守护认得的退出码退出（`yzng start` 用 0），而非靠没有守护。
   */
  readonly canShutdown: boolean

  /**
   * 请求关掉整个进程，且**不期望被拉起来**
   *
   * 与 {@link requestRestart} 走同一条路（优雅停机 + 交给宿主退出），区别只在退出码：
   * 宿主该用一个守护认作「别重启」的码（`yzng start` 用 0，配合 pm2 的
   * `stop_exit_codes: [0]` 或 systemd 的 `Restart=on-failure`）。
   *
   * **关掉之后没有任何聊天指令能把它启动回来**，故调用方应先向使用者确认。
   * 同样要先把话说完，见 {@link requestRestart}。
   * @param req 说明
   * @returns 已开始停机时兑现；无人接管时立即兑现
   */
  requestShutdown(req?: ShutdownRequest): Promise<void>
}

/**
 * 应用视图
 *
 * 插件通过 `ctx.app` 观察全局。除 {@link MaintenanceView} 之外一律只读 ——
 * 想改就得走具名 API（`ctx.config.patch`、`app.maintenance.*` 等），便于审计。
 */
export interface AppView {
  /** 内核版本 */
  readonly version: string
  /** 启动时间（毫秒时间戳） */
  readonly startedAt: number
  /** 目录布局 */
  readonly paths: RuntimePaths
  /** 环境信息 */
  readonly platform: PlatformInfo
  /** 适配器注册表 */
  readonly adapters: AdapterRegistryView
  /** 在线 Bot 注册表 */
  readonly bots: BotRegistryView
  /** 账号 */
  readonly accounts: AccountsView
  /** 插件 */
  readonly plugins: PluginsView
  /** 主人等策略 */
  readonly policy: PolicyView
  /** HTTP 服务器信息 */
  readonly server: ServerInfo
  /**
   * 维护面：更新插件与请求重启
   *
   * `AppView` 其余部分一律只读，这一面是唯一能改变实例状态的 —— 独立成面即为此。
   */
  readonly maintenance: MaintenanceView

  /**
   * 采样当前资源占用
   * @returns 资源占用快照
   */
  usage(): ResourceUsage
}

/* ────────────────────────────── 插件上下文 ────────────────────────────── */

/**
 * 插件上下文
 *
 * 插件能做的一切都在这里。没有全局变量、没有 `require("../../lib/...")`，
 * 因此内核可以精确知道每个插件占用了哪些资源，卸载时全部归还。
 */
export interface PluginContext<C = unknown> {
  /** 插件名 */
  readonly name: string
  /** 插件版本 */
  readonly version: string
  /** 插件安装目录（绝对路径） */
  readonly root: string
  /** 本插件专属的数据目录（绝对路径，已创建） */
  readonly dataDir: string
  /** 本插件专属日志器 */
  readonly logger: Logger
  /** 本插件专属 KV 命名空间 */
  readonly kv: KvNamespace
  /** 本插件的配置句柄；未声明 `configSchema` 时 `get()` 返回空对象 */
  readonly config: ConfigHandle<C>
  /** 应用只读视图 */
  readonly app: AppView
  /** HTTP 客户端（已带全局代理与超时默认值） */
  readonly http: HttpClient
  /** 插件卸载时 abort，可直接传给 fetch / 循环判断 */
  readonly signal: AbortSignal

  /**
   * 声明一条命令
   * @param pattern 触发模式
   * @param opts 命令选项
   * @returns 链式构造器
   */
  command(pattern: CommandPattern, opts?: CommandOptions): CommandBuilder

  /**
   * 注册中间件
   * @param fn 中间件函数
   * @param opts 注册选项
   * @returns 注销句柄
   */
  middleware(fn: Middleware, opts?: MiddlewareOptions): Disposer

  /**
   * 监听内核事件
   * @param event 事件名
   * @param handler 处理函数
   * @returns 注销句柄
   */
  on<K extends keyof CoreEventMap>(
    event: K,
    handler: (...args: CoreEventMap[K]) => Awaitable<void>
  ): Disposer

  /**
   * 注册 cron 定时任务
   * @param expression 5 或 6 段 cron 表达式（支持秒）
   * @param fn 任务体
   * @param opts 任务选项
   * @returns 注销句柄
   */
  cron(expression: string, fn: TaskFn, opts?: TaskOptions): Disposer

  /**
   * 注册固定间隔任务
   * @param interval 间隔
   * @param fn 任务体
   * @param opts 任务选项
   * @returns 注销句柄
   */
  every(interval: DurationLike, fn: TaskFn, opts?: TaskOptions): Disposer

  /**
   * 对外提供服务，供其他插件 `inject` 取用
   *
   * 插件间协作的唯一入口；内核只维护一张键到值的表，不认识表里装的是什么。
   * @param key 服务键，建议 `"<插件域>.<能力>"`
   * @param value 服务实例
   * @returns 注销句柄
   */
  provide<T>(key: string, value: T): Disposer

  /**
   * 取用其他插件提供的服务
   * @param key 服务键
   * @returns 服务实例，未提供时 undefined
   */
  inject<T>(key: string): T | undefined

  /**
   * 取用服务，缺失即抛错
   * @param key 服务键
   * @returns 服务实例
   * @throws 服务未注册时抛出
   */
  require<T>(key: string): T

  /**
   * 等待某服务就绪
   *
   * 用于弱依赖：插件 A 想用插件 B 的能力，但不想因为 B 没装就整体失败。
   * @param key 服务键
   * @param timeout 等待超时，缺省 30s
   * @returns 服务实例；超时返回 undefined
   */
  waitFor<T>(key: string, timeout?: DurationLike): Promise<T | undefined>

  /**
   * 注册 HTTP 路由
   * @param method HTTP 方法
   * @param path 路径，会被挂到 `/plugin/<插件名>` 之下
   * @param handler 处理函数
   * @param opts 选项
   * @returns 注销句柄
   */
  route(method: HttpMethod, path: string, handler: RouteHandler, opts?: RouteOptions): Disposer

  /**
   * 注册 WebSocket 路径
   * @param path 路径，会被挂到 `/plugin/<插件名>` 之下
   * @param handler 每个连接调用一次
   * @param opts 选项
   * @returns 注销句柄
   */
  websocket(path: string, handler: WebSocketHandler, opts?: WebSocketOptions): Disposer

  /**
   * 挂载静态目录（WebUI 扩展页面用）
   * @param urlPath URL 前缀
   * @param dir 本地目录绝对路径
   * @returns 注销句柄
   */
  static(urlPath: string, dir: string): Disposer

  /**
   * 接管站点根路径，以本插件提供的单页应用替换内置面板
   *
   * 挂在 `/` 而非 `static()` 的 `/plugin/<插件名>` 之下。内核自带的面板只在根路径
   * 无人接管时才挂载。同一时刻只允许一个插件接管，已被占用时抛错而非静默覆盖。
   * @param dir 单页应用产物目录（绝对路径，需含 index.html）
   * @returns 注销句柄；注销后内置面板不会自动补挂，需重启进程
   */
  panel(dir: string): Disposer

  /**
   * 注册适配器
   * @param provider 适配器实现
   * @returns 注销句柄；注销时内核会先断开该适配器的全部账号
   */
  registerAdapter(provider: AdapterProvider): Disposer

  /**
   * 注册渲染器
   * @param provider 渲染器实现
   * @returns 注销句柄
   */
  registerRenderer(provider: RendererProvider): Disposer

  /**
   * 注册 KV 驱动（如 Redis）
   * @param driver 驱动实现
   * @returns 注销句柄
   */
  registerKvDriver(driver: KvDriver): Disposer

  /**
   * 渲染 TSX 页面为图片段
   *
   * 页面由 `@yunzai-ng/jsx` 的 `defineTemplate()` 产出。
   * @param page 已渲染好的页面
   * @param opts 渲染选项
   * @returns 图片段（分页时为数组）
   * @throws 无可用渲染器或渲染失败时抛出
   */
  render(page: RenderablePage, opts?: RenderOptions): Promise<RenderedImage>

  /**
   * 渲染字符串模板为图片段
   * @param template 模板路径，相对本插件的 `templates` 目录
   * @param data 模板数据
   * @param opts 渲染选项
   * @returns 图片段（分页时为数组）
   * @throws 无可用渲染器或渲染失败时抛出
   */
  render(template: string, data?: Record<string, unknown>, opts?: RenderOptions): Promise<RenderedImage>

  /**
   * 打开本插件专属的 SQLite 库
   * @param name 库名，缺省 `"main"`
   * @returns SQL 句柄，随插件卸载自动关闭
   */
  sql(name?: string): Promise<SqlHandle>

  /**
   * 创建 LRU + TTL 缓存
   * @param opts 缓存参数
   * @returns 缓存实例，随插件卸载自动清空
   */
  cache<V>(opts: ContactCacheOptions): ContactCache<V>

  /**
   * 拼出插件内资源的绝对路径
   * @param parts 相对插件根的路径片段
   * @returns 绝对路径
   */
  resource(...parts: string[]): string

  /**
   * 注册清理回调
   *
   * 卸载时按注册的逆序执行。ctx 之外自己开的资源（socket、子进程、第三方库的
   * watcher）都必须在这里登记，否则卸载后仍在跑。
   * @param fn 清理函数
   */
  onDispose(fn: Disposer): void

  /**
   * 主动向某个会话发消息（推送任务用）
   * @param bot 目标账号；传 undefined 时用第一个在线账号
   * @returns 该账号的 Bot；无可用账号时 undefined
   */
  pickBot(bot?: string): BotApi | undefined
}

/* ────────────────────────────── 插件定义 ────────────────────────────── */

/** 插件元信息 */
export interface PluginMeta {
  /** 插件名，必须全局唯一；同时作为 KV 命名空间与配置文件名 */
  name: string
  /** 版本号 */
  version?: string
  /** 一句话说明 */
  description?: string
  /** 作者 */
  author?: string
  /** 主页 */
  homepage?: string
  /**
   * 依赖的其他插件名
   *
   * 内核据此排序加载。缺失依赖时本插件跳过加载并记警告，**不影响内核启动**。
   */
  dependencies?: string[]
  /** 声明本插件会 `provide` 的服务键，供依赖检查与文档生成 */
  provides?: string[]
  /** 加载优先级，小者先加载，缺省 100 */
  priority?: number
}

/**
 * 插件定义
 *
 * `setup` 可返回一个 Disposer 作为清理函数（等价于在里面调 `ctx.onDispose`）。
 */
export interface PluginDefinition<C = unknown> extends PluginMeta {
  /**
   * 配置 schema
   *
   * 实际类型是 core 的 `Schema`（由 `s.object({...})` 构造），此处只能写 `unknown`
   * 因为类型包不依赖工作区包。类型推导由 core 的 `definePlugin` 完成，故插件必须用
   * 它而不是手写对象字面量。
   */
  configSchema?: unknown

  /**
   * 插件入口
   * @param ctx 注入的上下文
   * @returns 可选的清理函数
   */
  setup(ctx: PluginContext<C>): Awaitable<void | Disposer>
}

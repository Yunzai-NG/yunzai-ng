/**
 * 模块职责：账号生命周期管理（持久化、连接、重连、状态）+ 实现 `AccountsView`
 * 依赖方向：依赖类型包、KV、适配器注册表、Bot 注册表、宿主工厂；**不认识任何具体协议**
 * 生命周期：随内核创建；每个账号一份 `AccountRuntime`，随账号删除或内核停止回收
 * 注意事项：账号是数据（KV 里的 `AccountRecord`），协议是插件（`AdapterProvider`），两者在运行时
 *          撮合，故增删账号不必重启进程。四个必须做对的点：
 *          1) 重连要有退避、要能被取消 —— 账号一被禁用或删除，pending 的定时器立刻清掉
 *          2) `connect()` 用 `#connecting` 单飞防重入，否则两个 driver 连同一个账号，消息收两遍
 *          3) 断开的顺序是先 abort、再回收登记、最后 await driver 的 `disconnect()`；反了会出现
 *             「已断开的账号还在往管线里灌事件」。`disconnect()` 同样先 abort 再 await 正在进行的
 *             `connect()` —— 被动接入的适配器要等对端连入才返回，不先 abort 会卡住停机
 *          4) 适配器卸载时账号要同步下线：`onUnregister` 是同步回调（见 registry.ts），故同步改
 *             状态并 abort，异步的 socket 关闭交给 `#closing` 由 `stop()` 兜底 await
 */
import type {
  AccountRecord,
  AccountRetryOverride,
  AccountState,
  AccountStatus,
  AccountsView,
  AdapterProvider,
  BotDriver,
  Disposer,
  KvNamespace,
  Logger
} from "@yunzai-ng/types"
import type { CoreEventBus } from "../plugin/events.js"
import { backoffDelay } from "../util/defer.js"
import { DisposalRegistry } from "../util/dispose.js"
import { parseDuration } from "../util/duration.js"
import { uuid } from "../util/id.js"
import type { AdapterEntry, AdapterRegistry } from "./registry.js"
import type { BotFacade, BotRegistry, SendPolicyView } from "./bots.js"
import { createBotFacade } from "./bots.js"
import type { AdapterHostFactory, AdapterHostHandle } from "./host.js"

/** KV 里存账号记录的键前缀 */
const RECORD_PREFIX = "account:"

/** 退避的抖动比例，让同一时刻掉线的几个号不挤在同一秒重连 */
const RECONNECT_JITTER = 0.25

/**
 * 重连策略的兜底值，仅在调用方不给 `retryPolicy` 时生效
 *
 * 刻意与配置 schema 里 `adapter.*` 的默认值不同：这里答的是「没人给策略时用什么」，
 * schema 那边答的是「使用者没改过配置时是什么」。内核装配时总会把配置里的策略传进来
 * （见 runtime.ts 的 `retryPolicyOf`），故这份兜底只在测试与嵌入式用法里走到。
 */
const RETRY_FALLBACK: RetryPolicyView = { maxRetries: 0, interval: 2_000, maxInterval: 60_000, factor: 2 }

/** 每多少次失败落一条 warn（其余落 debug），避免日志刷屏 */
const WARN_EVERY = 10

/**
 * 重连策略的只读视图
 *
 * 与 `SendPolicyView` 同一形制，取 getter 而非快照值：缓存下来的话，把上限从 0
 * 调成 5 得重启才算数。这四项是全局缺省，单个账号可在 `AccountRecord.retry` 里
 * 逐项覆盖，见 `#policyOf`。
 */
export interface RetryPolicyView {
  /** 连续失败多少次后放弃；`0` 表示一直重连 */
  readonly maxRetries: number
  /** 首次重试前等待的毫秒 */
  readonly interval: number
  /** 退避的等待上限毫秒 */
  readonly maxInterval: number
  /** 退避倍率 */
  readonly factor: number
}

/**
 * 一个账号此刻实际生效的重连策略
 *
 * 与 `RetryPolicyView` 分开：那个是全局缺省的活视图（getter，配置改了就变），
 * 这个是某账号某一刻算出来的四个数。
 */
interface EffectiveRetry {
  /** 连续失败多少次后放弃；`0` 为一直重连 */
  readonly limit: number
  /** 首次重试前等待的毫秒 */
  readonly interval: number
  /** 退避的等待上限毫秒 */
  readonly maxInterval: number
  /** 退避倍率 */
  readonly factor: number
}

/** 单个账号的运行时状态 */
interface AccountRuntime {
  /** 持久化记录 */
  record: AccountRecord
  /** 当前状态 */
  status: AccountStatus
  /** 最近错误 */
  error: string | undefined
  /** 进入当前状态的时刻 */
  since: number
  /** 已重连次数 */
  retries: number
  /** 本次连接的取消信号源；未连接时 undefined */
  controller: AbortController | undefined
  /** 本次连接期间的回收簿；未连接时 undefined */
  registry: DisposalRegistry | undefined
  /** 驱动实例 */
  driver: BotDriver | undefined
  /** 对外门面 */
  facade: BotFacade | undefined
  /** 重连定时器 */
  timer: NodeJS.Timeout | undefined
  /** 正在进行的连接（单飞用） */
  connecting: Promise<void> | undefined
  /** 正在进行的断开（停机时 await 它） */
  closing: Promise<void> | undefined
  /** 是否已被删除 */
  removed: boolean
}

/** 账号管理器构造参数 */
export interface AccountManagerOptions {
  /** 日志器 */
  readonly logger: Logger
  /** 存账号记录的 KV 命名空间 */
  readonly kv: KvNamespace
  /** 适配器注册表 */
  readonly adapters: AdapterRegistry
  /** Bot 注册表 */
  readonly bots: BotRegistry
  /** 宿主工厂 */
  readonly createHost: AdapterHostFactory
  /** 内核事件总线 */
  readonly events: CoreEventBus
  /** 发送策略视图，透传给每个 Bot 门面 */
  readonly sendPolicy: SendPolicyView
  /**
   * 重连策略的全局缺省；不给则一直重连、按 2s → 60s 退避
   *
   * 单个账号可在 `AccountRecord.retry` 里逐项覆盖这四项，见 `#policyOf`。
   */
  readonly retryPolicy?: RetryPolicyView
}

/**
 * 取错误的可读描述
 * @param err 任意抛出物
 * @returns 描述文本
 */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 账号管理器
 *
 * 既是 WebUI 的增删改查入口，也是 `AccountsView` 的实现（插件通过
 * `ctx.app.accounts` 只读观察）。
 */
export class AccountManager implements AccountsView {
  /** 日志器 */
  readonly #logger: Logger
  /** KV 命名空间 */
  readonly #kv: KvNamespace
  /** 适配器注册表 */
  readonly #adapters: AdapterRegistry
  /** Bot 注册表 */
  readonly #bots: BotRegistry
  /** 宿主工厂 */
  readonly #createHost: AdapterHostFactory
  /** 事件总线 */
  readonly #events: CoreEventBus
  /** 发送策略视图 */
  readonly #sendPolicy: SendPolicyView
  /** 重连策略视图 */
  readonly #retryPolicy: RetryPolicyView
  /** 账号 id → 运行时 */
  readonly #runtimes = new Map<string, AccountRuntime>()
  /** 适配器注册表的监听句柄，停机时摘除 */
  readonly #unhook: Disposer[]
  /** 是否已停机 */
  #stopped = false

  /**
   * @param opts 构造参数
   */
  constructor(opts: AccountManagerOptions) {
    this.#logger = opts.logger.child({ scope: "account" })
    this.#kv = opts.kv
    this.#adapters = opts.adapters
    this.#bots = opts.bots
    this.#createHost = opts.createHost
    this.#events = opts.events
    this.#sendPolicy = opts.sendPolicy
    this.#retryPolicy = opts.retryPolicy ?? RETRY_FALLBACK

    // 适配器热插拔（文件头第 4 点）：卸载即下线，重新注册即连回来。
    // 在构造函数里自行装配而不交给 kernel/runtime.ts：漏装不报错也不留痕，
    // 只表现为「适配器插件更新之后账号不再自动恢复」
    this.#unhook = [
      opts.adapters.onUnregister((id, entry) => this.detachAdapter(id, entry)),
      opts.adapters.onRegister(id => this.onAdapterRegistered(id))
    ]
  }

  /** 账号总数 */
  get size(): number {
    return this.#runtimes.size
  }

  /**
   * 从 KV 载入全部账号记录（不连接）
   *
   * 与 `startAll()` 分开：连接要等适配器插件全部注册完，否则先加载的账号会因
   * 「适配器未注册」白失败一次。
   * @returns 载入的账号数
   */
  async load(): Promise<number> {
    for await (const [key, value] of this.#kv.entries<AccountRecord>(RECORD_PREFIX)) {
      const record = value as AccountRecord | undefined
      // 手工编辑过 KV、或旧版本残留的坏记录：跳过而不是让整个内核起不来
      if (record === undefined || typeof record.id !== "string" || typeof record.adapterId !== "string") {
        this.#logger.warn(`跳过无法解析的账号记录 ${key}`)
        continue
      }
      this.#runtimes.set(record.id, {
        record,
        status: record.enabled ? "offline" : "disabled",
        error: undefined,
        since: Date.now(),
        retries: 0,
        controller: undefined,
        registry: undefined,
        driver: undefined,
        facade: undefined,
        timer: undefined,
        connecting: undefined,
        closing: undefined,
        removed: false
      })
    }
    this.#logger.info(`载入 ${this.#runtimes.size} 个账号`)
    return this.#runtimes.size
  }

  /**
   * 连接全部已启用的账号
   *
   * 并发连接：一个账号的对端没起来不该让后面的账号排队等它退避完。单个账号失败
   * 由 `connect` 内部转成 error 状态并排重连，故这里不检查 `allSettled` 的结果。
   */
  async startAll(): Promise<void> {
    const targets = [...this.#runtimes.values()].filter(rt => rt.record.enabled)
    if (targets.length === 0) {
      this.#logger.info("没有已启用的账号，等待在 WebUI 中添加")
      return
    }
    await Promise.allSettled(targets.map(rt => this.connect(rt.record.id)))
  }

  /* ─────────────────────────── AccountsView ─────────────────────────── */

  /**
   * 列出全部账号及其状态
   * @returns 状态快照数组
   */
  list(): AccountState[] {
    return [...this.#runtimes.values()].map(rt => this.#snapshot(rt))
  }

  /**
   * 按记录 id 取账号状态
   * @param id 账号记录 id
   * @returns 状态快照；不存在时 undefined
   */
  get(id: string): AccountState | undefined {
    const rt = this.#runtimes.get(id)
    return rt === undefined ? undefined : this.#snapshot(rt)
  }

  /* ─────────────────────────── 增删改 ─────────────────────────── */

  /**
   * 新建账号
   *
   * 配置先过 `validateAccount()` 再落盘：非法配置存进去之后，只会在下次启动时
   * 表现为一条看不出原因的连接失败。
   * @param adapterId 适配器 id
   * @param config 账号配置（WebUI 提交的原始对象）
   * @param label 备注名
   * @param enabled 是否立即启用并连接，缺省 true
   * @param retry 这个号自己的重连覆盖；不给则整套跟随全局配置
   * @returns 新建的记录
   * @throws 适配器未注册或配置校验失败时
   */
  async create(
    adapterId: string,
    config: unknown,
    label?: string,
    enabled = true,
    retry?: AccountRetryOverride
  ): Promise<AccountRecord> {
    const provider = this.#requireAdapter(adapterId)
    const normalized = this.#validate(provider, config)

    const now = Date.now()
    const record: AccountRecord = {
      id: uuid(),
      adapterId,
      enabled,
      config: normalized,
      createdAt: now,
      updatedAt: now
    }
    if (label !== undefined && label !== "") record.label = label
    // 空对象不落盘：它与「没填」行为相同，但会让 `record.retry !== undefined` 成真，
    // 而放弃重连那条日志据此判断该提示改全局配置还是改这个号
    if (retry !== undefined && Object.keys(retry).length > 0) record.retry = retry

    await this.#persist(record)
    this.#runtimes.set(record.id, {
      record,
      status: enabled ? "offline" : "disabled",
      error: undefined,
      since: now,
      retries: 0,
      controller: undefined,
      registry: undefined,
      driver: undefined,
      facade: undefined,
      timer: undefined,
      connecting: undefined,
      closing: undefined,
      removed: false
    })
    this.#logger.info(`新增账号 ${this.#describe(record)}`)
    if (enabled) await this.connect(record.id)
    return record
  }

  /**
   * 修改账号配置
   *
   * 改了 `config` 必须重连，否则连接参数变了而 socket 还是旧的。只改 `label` 或
   * `retry` 时不重连：两者都不参与建连（`retry` 由 `#policyOf` 每次现算），
   * 为它们把在线的号踢下线会丢掉那期间的消息。
   * @param id 账号记录 id
   * @param patch 要改的字段；`retry` 传 `null` 表示清掉覆盖、回到跟随全局
   * @returns 更新后的记录
   * @throws 账号不存在时；给了 `config` 而适配器未注册或该份配置校验不过时
   */
  async update(
    id: string,
    patch: { config?: unknown; label?: string; enabled?: boolean; retry?: AccountRetryOverride | null }
  ): Promise<AccountRecord> {
    const rt = this.#require(id)

    const next: AccountRecord = { ...rt.record, updatedAt: Date.now() }
    // 适配器只在要校验 `config` 时才取：另外三项归内核自己所有，
    // 在开头无条件取会让适配器卸载后连备注都改不动
    if (patch.config !== undefined) {
      next.config = this.#validate(this.#requireAdapter(rt.record.adapterId), patch.config)
    }
    if (patch.label !== undefined) next.label = patch.label
    if (patch.enabled !== undefined) next.enabled = patch.enabled
    // `undefined` 是「这次没提这一项」，`null` 是「清掉覆盖、回到跟随全局」，不能合并判断
    if (patch.retry === null) delete next.retry
    else if (patch.retry !== undefined) next.retry = patch.retry

    await this.#persist(next)
    rt.record = next

    // 判据取「有没有提 config 或 enabled」而非比对新旧值：深比对算错的后果是
    // 「改了地址却没重连」，宁可在提交了同样 config 时多重连一次
    const touchesConnection = patch.config !== undefined || patch.enabled !== undefined
    if (!touchesConnection) return next

    // 与 `reconnect()` 同一个道理：改地址、改 token 正是为了让它连上，
    // 不该被上一套配置攒下的失败次数挡在门外（见 `reconnect` 的注释）
    rt.retries = 0
    await this.disconnect(id, "配置已修改")
    if (next.enabled) await this.connect(id)
    else this.#setStatus(rt, "disabled", undefined)
    return next
  }

  /**
   * 启用 / 禁用账号
   * @param id 账号记录 id
   * @param enabled 是否启用
   * @returns 更新后的记录
   * @throws 账号不存在时
   */
  async setEnabled(id: string, enabled: boolean): Promise<AccountRecord> {
    return this.update(id, { enabled })
  }

  /**
   * 删除账号
   * @param id 账号记录 id
   * @returns 是否删掉了（不存在时 false）
   */
  async remove(id: string): Promise<boolean> {
    const rt = this.#runtimes.get(id)
    if (rt === undefined) return false
    // 先标记再断开：断开过程里到达的重连调度要能看到"这个账号已经没了"
    rt.removed = true
    await this.disconnect(id, "账号已删除")
    this.#runtimes.delete(id)
    await this.#kv.del(`${RECORD_PREFIX}${id}`)
    this.#logger.info(`删除账号 ${this.#describe(rt.record)}`)
    return true
  }

  /* ─────────────────────────── 连接 / 断开 ─────────────────────────── */

  /**
   * 连接一个账号
   *
   * 幂等且防重入：已在线直接返回，正在连接则复用同一个 promise（文件头第 2 点）。
   * 失败不抛异常，转 `error` 状态并安排重连 —— 抛出会让面板的批量操作停在第一个账号上。
   * @param id 账号记录 id
   * @throws 账号不存在时
   */
  async connect(id: string): Promise<void> {
    const rt = this.#require(id)
    if (this.#stopped) return
    if (rt.status === "online" && rt.driver !== undefined) return
    if (rt.connecting !== undefined) return rt.connecting

    this.#clearTimer(rt)
    const task = this.#doConnect(rt).finally(() => {
      rt.connecting = undefined
    })
    rt.connecting = task
    return task
  }

  /**
   * 断开一个账号
   * @param id 账号记录 id
   * @param reason 断开原因（落日志与 `bot/offline`）
   */
  async disconnect(id: string, reason = "手动断开"): Promise<void> {
    const rt = this.#runtimes.get(id)
    if (rt === undefined) return
    this.#clearTimer(rt)
    // 先 abort 再等待：被动接入的适配器要等对端连入才从 connect() 返回，
    // 顺序反了会让 stop() 一直阻塞到那次等待超时
    rt.controller?.abort()
    if (rt.connecting !== undefined) await rt.connecting.catch(() => undefined)
    await this.#teardown(rt, reason)
    if (!rt.removed) this.#setStatus(rt, rt.record.enabled ? "offline" : "disabled", undefined)
  }

  /**
   * 重连一个账号
   * @param id 账号记录 id
   */
  async reconnect(id: string): Promise<void> {
    const rt = this.#runtimes.get(id)
    /*
     * 手动重连把失败计数归零，否则达到上限之后这个按钮点了没反应：`retries` 只在连接
     * 成功那一刻才归零，放弃重连后它停在上限值上。
     *
     * 只在手动入口归零，不在 `connect()` 里 —— 后者也被重连定时器调用，在那里归零
     * 等于把上限抹掉。
     */
    if (rt !== undefined) rt.retries = 0
    await this.disconnect(id, "手动重连")
    await this.connect(id)
  }

  /**
   * 适配器插件被卸载：同步让它名下的账号下线
   *
   * 改状态、abort、从 Bot 注册表摘除三件事必须在返回前做完（调用方是同步的
   * `Disposer`）；异步的 socket 关闭挂在 `rt.closing` 上由 `stop()` 兜底 await。
   * @param adapterId 适配器 id
   * @param entry 摘除的注册条目（仅用于日志）
   */
  detachAdapter(adapterId: string, entry?: AdapterEntry): void {
    const owner = entry?.owner
    const reason = owner === undefined ? `适配器 ${adapterId} 已卸载` : `适配器插件 ${owner} 已卸载`
    for (const rt of this.#runtimes.values()) {
      if (rt.record.adapterId !== adapterId) continue
      this.#clearTimer(rt)
      // 同步切断事件投递：宿主的 signal 一 abort，submit() 立刻开始丢事件
      rt.controller?.abort()
      const facade = rt.facade
      if (facade !== undefined) {
        // 同步让门面失效并摘出注册表：插件的 pickBot() 立刻拿不到它，
        // 已经拿在手上的那个也会在下一次调用时明确报错
        facade.close()
        this.#bots.remove(rt.record.id)
        if (rt.status === "online") this.#events.emitDetached("bot/offline", facade, reason)
      }
      this.#setStatus(rt, rt.record.enabled ? "offline" : "disabled", reason)
      // 异步收尾（关 socket、回收登记）：不能 await，但要让 stop() 有机会等到
      rt.closing = this.#teardown(rt, reason)
      void rt.closing.catch(() => undefined)
    }
  }

  /**
   * 适配器插件重新注册：把它名下已启用的账号连回来
   *
   * 热重载的另一半。不 await：注册通知也发生在同步路径上。
   * @param adapterId 适配器 id
   */
  onAdapterRegistered(adapterId: string): void {
    if (this.#stopped) return
    for (const rt of this.#runtimes.values()) {
      if (rt.record.adapterId !== adapterId) continue
      if (!rt.record.enabled || rt.status === "online" || rt.status === "connecting") continue
      this.#logger.info(`适配器 ${adapterId} 已重新注册，正在重连账号 ${this.#describe(rt.record)}`)
      void this.connect(rt.record.id).catch(() => undefined)
    }
  }

  /**
   * 停机：断开全部账号
   *
   * 并发断开并等到全部收尾，含 `detachAdapter` 留下的异步尾巴 —— 漏等会留下没关的
   * socket，对端要等 TCP 超时才发现。
   */
  async stop(): Promise<void> {
    this.#stopped = true
    // 先摘监听：停机过程中若有插件正好在卸载，detachAdapter 再来一遍
    // 只会和下面的 disconnect 抢同一个运行时
    for (const off of this.#unhook) off()
    this.#unhook.length = 0

    const tasks: Promise<unknown>[] = []
    for (const rt of this.#runtimes.values()) {
      this.#clearTimer(rt)
      if (rt.closing !== undefined) tasks.push(rt.closing.catch(() => undefined))
      tasks.push(this.disconnect(rt.record.id, "内核正在停止").catch(() => undefined))
    }
    await Promise.allSettled(tasks)
  }

  /* ─────────────────────────── 内部 ─────────────────────────── */

  /**
   * 真正的连接过程
   * @param rt 账号运行时
   */
  async #doConnect(rt: AccountRuntime): Promise<void> {
    const record = rt.record
    const provider = this.#adapters.get(record.adapterId)
    if (provider === undefined) {
      // 不算失败到要重连：适配器插件没装，重试一万次也是一样的结果。
      // 等 onAdapterRegistered 把它叫回来。
      this.#setStatus(rt, "error", `适配器 ${record.adapterId} 未注册`)
      this.#logger.warn(`账号 ${this.#describe(record)} 无法连接：适配器 ${record.adapterId} 未注册`)
      return
    }

    this.#setStatus(rt, "connecting", undefined)
    const controller = new AbortController()
    const registry = new DisposalRegistry(`account:${record.id}`)
    rt.controller = controller
    rt.registry = registry

    let handle: AdapterHostHandle | undefined
    // 提到 try 外面：`rt.driver` 要等连上之后才赋值，而 `connect()` 抛错恰恰是
    // 最常见的失败路径，那时只有这个引用能把半成品驱动交给 #teardown 关掉
    let driver: BotDriver | undefined
    try {
      handle = this.#createHost({
        record,
        controller,
        registry,
        setStatus: (status, detail) => {
          // 适配器自报状态（如"正在扫码"）。它报 offline 时走完整的下线流程
          // 而不是仅修改一个字段：socket 已不存在，Bot 注册表中的对应条目也必须摘除。
          if (status === "offline" && rt.status === "online") {
            void this.#onDriverOffline(rt, detail?.error ?? "适配器报告已下线")
            return
          }
          this.#setStatus(rt, status, detail?.error)
        }
      })

      driver = await provider.createBot(provider.validateAccount(record.config), handle.host)
      if (controller.signal.aborted) {
        // 连接期间账号被禁用/删除了：把刚建好的 driver 立刻收掉，
        // 否则它会成为一个没人引用、还在收消息的幽灵
        await driver.disconnect().catch(() => undefined)
        return
      }

      await driver.connect()
      if (controller.signal.aborted) {
        await driver.disconnect().catch(() => undefined)
        return
      }

      const facade = createBotFacade({
        driver,
        accountId: record.id,
        logger: this.#logger.child({ account: record.id }),
        policy: this.#sendPolicy,
        // 门面自己不认识总线（见 adapter/bots.ts 文件头），由此处代为转发。
        // emitDetached：统计插件绝不该拖慢发送主链路
        onSent: info => this.#events.emitDetached("message/sent", info)
      })
      rt.driver = driver
      rt.facade = facade
      this.#bots.add(facade)
      // 绑在最后一步：宿主此前收到的事件一律丢弃（宿主文件头闸门二），
      // 因为在门面就绪之前 e.reply() 无处可发
      handle.attach(facade)

      // 回填 selfId：WebUI 要显示"这个账号是哪个 QQ"，而它只有连上才知道
      if (driver.selfId !== "" && record.selfId !== driver.selfId) {
        record.selfId = driver.selfId
        record.updatedAt = Date.now()
        await this.#persist(record).catch((err: unknown) => {
          this.#logger.warn(`回填账号 ${record.id} 的 selfId 失败：${errText(err)}`)
        })
      }

      rt.retries = 0
      this.#setStatus(rt, "online", undefined)
      this.#logger.info(`账号上线：${this.#describe(record)}（${driver.nickname || driver.selfId}）`)
      this.#events.emitDetached("bot/online", facade)
    } catch (err) {
      handle?.detach()
      // 补登记再收拾：失败点在 `rt.driver = driver` 之前时（`connect()` 抛错就是），
      // #teardown 看不到这个驱动，它带着的 socket 与定时器就没人关了 —— 而
      // #scheduleReconnect 每次重试都新建一个驱动，漏一个就是永久漏一个
      rt.driver ??= driver
      // **必须在 #teardown 之前读**：它自己会 abort 这个 controller，读晚了
      // 就永远是 true，于是真正的连接失败也不再上报 error、也不再重连
      const deliberate = controller.signal.aborted
      await this.#teardown(rt, "连接失败")
      // 被 abort 打断的不算"连接失败"，那是 disconnect/stop 主动要求停下来。
      // 照常报 error 并排重连的话，`disconnect()` 里的 #clearTimer 早已跑过，
      // 这个新排的定时器没人清，几秒后会把一个刚被停掉的账号重新连起来
      if (deliberate) return
      this.#setStatus(rt, "error", errText(err))
      this.#scheduleReconnect(rt, err)
    }
  }

  /**
   * 驱动侧断线：清理并安排重连
   * @param rt 账号运行时
   * @param reason 原因
   */
  async #onDriverOffline(rt: AccountRuntime, reason: string): Promise<void> {
    if (rt.status !== "online" && rt.status !== "connecting") return
    await this.#teardown(rt, reason)
    if (rt.removed || this.#stopped) return
    this.#setStatus(rt, rt.record.enabled ? "offline" : "disabled", reason)
    if (rt.record.enabled) this.#scheduleReconnect(rt, new Error(reason))
  }

  /**
   * 收拾一次连接留下的一切
   *
   * 顺序不能改：abort（停止投递）→ 摘 Bot 注册表 → 回收登记 → 关 socket。
   * 反过来会有「已断开却还在处理事件」的窗口。
   * @param rt 账号运行时
   * @param reason 原因
   */
  async #teardown(rt: AccountRuntime, reason: string): Promise<void> {
    const driver = rt.driver
    const facade = rt.facade
    const wasOnline = rt.status === "online"

    rt.controller?.abort()
    rt.controller = undefined
    rt.driver = undefined
    rt.facade = undefined

    if (facade !== undefined) {
      // 幂等：detachAdapter 可能已经 close 过了
      facade.close()
      this.#bots.remove(rt.record.id)
    }

    const registry = rt.registry
    rt.registry = undefined
    if (registry !== undefined) {
      const failures = registry.dispose()
      for (const f of failures) {
        this.#logger.warn(`回收账号 ${rt.record.id} 的 ${f.label} 时出错：${errText(f.error)}`)
      }
    }

    if (driver !== undefined) {
      try {
        await driver.disconnect()
      } catch (err) {
        // 断开失败没有补救手段，落日志即可 —— 进程退出时 socket 总会关掉
        this.#logger.warn(`断开账号 ${rt.record.id} 时出错：${errText(err)}`)
      }
    }

    if (wasOnline) {
      this.#logger.info(`账号下线：${this.#describe(rt.record)}（${reason}）`)
      if (facade !== undefined) this.#events.emitDetached("bot/offline", facade, reason)
    }
  }

  /**
   * 算出一个账号此刻实际生效的重连策略
   *
   * 逐字段回落，不是「填了就整套接管」：整套接管会让抄进记录的那几个数此后不跟全局改动走。
   * 每次现算不缓存 —— 全局那侧是活视图（getter），缓存会让「改配置立刻生效」失效。
   * @param record 账号记录
   * @returns 四项都已定值的策略
   */
  #policyOf(record: AccountRecord): EffectiveRetry {
    const own: AccountRetryOverride = record.retry ?? {}
    const global = this.#retryPolicy
    // 两项时长解析不出来时回落到全局值而非 0：0 是「不等待、立刻重试」的死循环
    return {
      limit: own.limit ?? global.maxRetries,
      interval: own.interval === undefined ? global.interval : parseDuration(own.interval, global.interval),
      maxInterval:
        own.maxInterval === undefined ? global.maxInterval : parseDuration(own.maxInterval, global.maxInterval),
      factor: own.factor ?? global.factor
    }
  }

  /**
   * 安排一次重连
   *
   * 达到上限即停手，状态留在 error 上。上限 0 为一直重连。四个数一律取自 `#policyOf`，
   * 不在这里读全局值 —— 两处判断迟早分叉。
   * @param rt 账号运行时
   * @param err 触发重连的错误
   */
  #scheduleReconnect(rt: AccountRuntime, err: unknown): void {
    if (this.#stopped || rt.removed || !rt.record.enabled) return
    this.#clearTimer(rt)

    rt.retries++

    const policy = this.#policyOf(rt.record)
    const limit = policy.limit
    if (limit > 0 && rt.retries > limit) {
      // 恒为 warn，不跟随 WARN_EVERY 降级：这是「此后不再自动重试」的唯一告知。
      // 提示按上限来源分开写，否则让填过账号级上限的人去改全局配置只会白改一次
      const where =
        rt.record.retry?.limit === undefined
          ? "把配置项 adapter.reconnectLimit 调大（0 为一直重连）"
          : "把这个账号的「重连次数上限」调大（0 为一直重连）"
      this.#logger.warn(
        `账号 ${this.#describe(rt.record)} 连接失败已达 ${limit} 次，停止自动重连：${errText(err)}。` +
          `如需继续重试请在面板点「重连」，或${where}`
      )
      return
    }

    const delay = backoffDelay(rt.retries, {
      baseDelay: policy.interval,
      maxDelay: policy.maxInterval,
      factor: policy.factor,
      jitter: RECONNECT_JITTER
    })
    const suffix = limit > 0 ? `（第 ${rt.retries}/${limit} 次）` : `（第 ${rt.retries} 次）`
    const text = `账号 ${this.#describe(rt.record)} 连接失败${suffix}：${errText(err)}；${Math.round(delay / 1000)} 秒后重试`
    // 对端长期不在线时不刷屏：首次与每 10 次一条 warn，其余降级到 debug
    if (rt.retries === 1 || rt.retries % WARN_EVERY === 0) this.#logger.warn(text)
    else this.#logger.debug(text)

    rt.timer = setTimeout(() => {
      rt.timer = undefined
      void this.connect(rt.record.id).catch(() => undefined)
    }, delay)
    rt.timer.unref?.()
  }

  /**
   * 清掉待触发的重连
   * @param rt 账号运行时
   */
  #clearTimer(rt: AccountRuntime): void {
    if (rt.timer === undefined) return
    clearTimeout(rt.timer)
    rt.timer = undefined
  }

  /**
   * 落一次状态变化
   * @param rt 账号运行时
   * @param status 新状态
   * @param error 错误信息
   */
  #setStatus(rt: AccountRuntime, status: AccountStatus, error: string | undefined): void {
    if (rt.status === status && rt.error === error) return
    rt.status = status
    rt.error = error
    rt.since = Date.now()
  }

  /**
   * 生成状态快照
   * @param rt 账号运行时
   * @returns 快照
   */
  #snapshot(rt: AccountRuntime): AccountState {
    // 复制记录：WebUI 拿到的对象不该是内部状态的别名，改一下就悄悄改了内核
    const state: AccountState = {
      record: { ...rt.record, config: { ...rt.record.config } },
      status: rt.status,
      since: rt.since,
      retries: rt.retries
    }
    if (rt.error !== undefined) state.error = rt.error
    const nickname = rt.facade?.nickname
    if (nickname !== undefined && nickname !== "") state.nickname = nickname
    return state
  }

  /**
   * 写一条记录进 KV
   * @param record 账号记录
   */
  async #persist(record: AccountRecord): Promise<void> {
    await this.#kv.set(`${RECORD_PREFIX}${record.id}`, record)
  }

  /**
   * 取运行时，不存在即抛
   * @param id 账号记录 id
   * @returns 运行时
   * @throws 账号不存在时
   */
  #require(id: string): AccountRuntime {
    const rt = this.#runtimes.get(id)
    if (rt === undefined) throw new Error(`账号 ${id} 不存在`)
    return rt
  }

  /**
   * 取适配器，未注册即抛
   * @param adapterId 适配器 id
   * @returns 适配器
   * @throws 未注册时
   */
  #requireAdapter(adapterId: string): AdapterProvider {
    const provider = this.#adapters.get(adapterId)
    if (provider === undefined) {
      const available = this.#adapters
        .list()
        .map(a => a.id)
        .join("、")
      throw new Error(`适配器 ${adapterId} 未注册${available === "" ? "" : `，可用：${available}`}`)
    }
    return provider
  }

  /**
   * 走一遍适配器的配置校验
   * @param provider 适配器
   * @param config 原始配置
   * @returns 规范化后的配置
   * @throws 校验不通过时（错误信息会展示给用户）
   */
  #validate(provider: AdapterProvider, config: unknown): Record<string, unknown> {
    try {
      return provider.validateAccount(config) as Record<string, unknown>
    } catch (err) {
      throw new Error(`账号配置不符合适配器 ${provider.name} 的要求：${errText(err)}`)
    }
  }

  /**
   * 账号的可读描述
   * @param record 账号记录
   * @returns 描述文本
   */
  #describe(record: AccountRecord): string {
    const who = record.label ?? record.selfId ?? record.id.slice(0, 8)
    return `${who}@${record.adapterId}`
  }
}

/**
 * 模块职责：账号生命周期管理（持久化、连接、重连、状态）+ 实现 `AccountsView`
 * 依赖方向：依赖类型包、KV、适配器注册表、Bot 注册表、宿主工厂；**不认识任何具体协议**
 * 生命周期：随内核创建；每个账号一份 `AccountRuntime`，随账号删除或内核停止回收
 * 注意事项：账号是**数据**（KV 里的 `AccountRecord`），协议是**插件**（`AdapterProvider`），
 *          两者在运行时撮合 —— 故增删账号不必重启进程。四个必须做对的点：
 *
 *          **重连要有退避、要能被取消。** 用 `backoffDelay`，日志按次数递减（首次 warn、
 *          之后每 10 次一条）；账号一被禁用或删除，pending 的重连定时器立刻清掉。
 *
 *          **`connect()` 必须防重入。** 双击「连接」、重连定时器与手动连接撞在一起，都会让两个
 *          driver 连同一个账号 —— 表现为消息收两遍、回两遍。用 `#connecting` 做单飞。
 *
 *          **每个账号一份 `DisposalRegistry` + 一个 `AbortController`，且顺序要对。** 断开时先
 *          abort（让宿主立刻开始丢事件），再回收登记，最后才 await driver 的 `disconnect()`；
 *          反了就会出现「已断开的账号还在往管线里灌事件」。`disconnect()` 同样先 abort 再 await
 *          正在进行的 `connect()` —— 被动接入的适配器要等对端连入才返回，不先 abort 会卡住停机。
 *
 *          **适配器插件卸载时账号要同步下线。** `onUnregister` 是同步回调（见 registry.ts），
 *          故此处同步改状态并 abort，异步的 socket 关闭交给 `#closing` 由 `stop()` 兜底 await。
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

/**
 * 退避的抖动比例
 *
 * 不做成配置项：它存在的理由是**多个账号别同时敲对端的门**（同一时刻掉线的几个号若步调
 * 一致，重连会挤在同一秒），那是一条内部实现约定，调它没有可说清的收益。其余三个数
 * （起始、上限、倍率）才是使用者真正会想改的。
 */
const RECONNECT_JITTER = 0.25

/**
 * 重连策略的兜底值，仅在调用方不给 `retryPolicy` 时生效
 *
 * 与配置 schema 里 `adapter.*` 的四个默认值刻意一致，但**不是**同一处定义 —— 这里是
 * 「没人给策略时用什么」，那里是「使用者没改过配置时是什么」。两者数值相同只是因为
 * 都该等于旧行为（无限重连、2 秒起、60 秒顶、2 倍）。
 *
 * 取「一直重连」而非某个具体次数：改默认行为得是使用者自己在配置里选的，
 * 不该由一个可选参数悄悄决定。
 */
const RETRY_FALLBACK: RetryPolicyView = { maxRetries: 0, interval: 2_000, maxInterval: 60_000, factor: 2 }

/** 每多少次失败落一条 warn（其余落 debug），避免日志刷屏 */
const WARN_EVERY = 10

/**
 * 重连策略的只读视图
 *
 * 与 `SendPolicyView` 同一形制：取 getter 而非快照值，故配置改了立刻生效，
 * 不必重连账号。缓存下来的话，把上限从 0 调成 5 得重启才算数。
 *
 * 这四项是**全局缺省**；单个账号可在 `AccountRecord.retry` 里逐项覆盖，见 `#policyOf`。
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
 * 与 `RetryPolicyView` 分开一个类型：那个是**全局缺省的活视图**（getter，配置改了就变），
 * 这个是**某账号某一刻算出来的四个数**。混用一个类型会让「这是全局的还是这个号的」在
 * 调用点上看不出来，而那正是这块代码唯一容易搞错的地方。
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
   * 重连策略的全局缺省；不给则一直重连、按 2s → 60s 退避（旧行为）
   *
   * 可选是为了不打断既有调用方（测试里大多不关心重连）。上限缺省取「一直重连」而非某个
   * 具体次数：改默认行为得是使用者自己在配置里选的，不该由一个可选参数悄悄决定。
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
    /*
     * 重连策略可选而非必填
     *
     * 内嵌用法与既有测试都不给这一项，而它缺席时的正确行为恰是旧行为（无限重连、
     * 2 秒起、60 秒顶、2 倍）—— 要求必填只会让每个调用点抄一遍同样的四个数。
     */
    this.#retryPolicy = opts.retryPolicy ?? RETRY_FALLBACK

    // 适配器热插拔（文件头第 4 点）：卸载即下线，重新注册即连回来。
    // 在构造函数中自行装配，而不交由 kernel/runtime.ts 装配：遗漏的后果是
    // "适配器插件更新之后账号不再自动恢复"，这种缺失不报错、不留痕，
    // 只会使人认为热重载不可用 —— 可以消除的装配步骤不应留给调用方。
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
   * 与 `startAll()` 分开：内核 `load` 阶段就该知道有哪些账号（WebUI 要能显示
   * 列表），但连接要等适配器插件全部注册完 —— 否则先加载的账号会因为
   * "适配器未注册"白失败一次。
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
   * 并发连接：一个账号的对端没起来不该让后面的账号排队等它退避完。
   * 单个账号失败只落日志（`connect` 内部已转成 error 状态 + 重连），
   * 所以这里 `allSettled` 之后不需要检查结果。
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
   * 配置先过 `validateAccount()` 再落盘：非法配置一旦存入，只会在下次启动时
   * 表现为一条无从判断原因的连接失败。
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
    /*
     * 空对象不落盘
     *
     * `{}` 与「没填」在行为上完全一样（四项都回落全局），但落进 KV 之后它会让
     * `record.retry !== undefined` 成真 —— 而放弃重连那条日志正是据此判断该提示
     * 「改全局配置」还是「改这个号的设置」，于是提示会指错地方。
     */
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
   * 改完必须重连：连接参数（地址、token）变了而 socket 还是旧的，
   * 用户会以为"改了没生效"。
   *
   * **只改备注或重连策略时不重连。** 那两项都不参与建连：`label` 纯展示，`retry` 只在下一次
   * 失败之后才被读到（`#policyOf` 每次现算）。为它们把一个正在线的号踢下线，代价是那期间的
   * 消息全丢 —— 而使用者做的只是把上限从 5 改成 10。
   * @param id 账号记录 id
   * @param patch 要改的字段；`retry` 传 `null` 表示清掉覆盖、回到跟随全局
   * @returns 更新后的记录
   * @throws 账号不存在或配置校验失败时
   */
  async update(
    id: string,
    patch: { config?: unknown; label?: string; enabled?: boolean; retry?: AccountRetryOverride | null }
  ): Promise<AccountRecord> {
    const rt = this.#require(id)
    const provider = this.#requireAdapter(rt.record.adapterId)

    const next: AccountRecord = { ...rt.record, updatedAt: Date.now() }
    if (patch.config !== undefined) next.config = this.#validate(provider, patch.config)
    if (patch.label !== undefined) next.label = patch.label
    if (patch.enabled !== undefined) next.enabled = patch.enabled
    /*
     * `null` 与 `undefined` 在这里意思不同，故不能合并判断
     *
     * `undefined` 是「这次没提这一项」（保持原样），`null` 是「明确要清掉」。少了 `null`
     * 这条路，一个填过覆盖的账号就没法回到「跟随全局」—— 只能删号重建。
     */
    if (patch.retry === null) delete next.retry
    else if (patch.retry !== undefined) next.retry = patch.retry

    await this.#persist(next)
    rt.record = next

    /*
     * 判「这次改动要不要重连」：只动了 label / retry 就不动连接
     *
     * 判据取「有没有提 config 或 enabled」而非比对新旧值：`config` 是任意结构的对象，
     * 深比对既要处理嵌套又要处理键序，而算错的后果是「改了地址却没重连」—— 那正是这个
     * 方法开头那句注释要防的事。宁可在「提交了同样的 config」这种情形下多重连一次。
     */
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
   * 失败**不抛出异常** —— 账号无法连接属于常态（对端未启动），转为 `error` 状态并
   * 安排重连即可；抛出异常只会使 WebUI 的批量操作在第一个账号处中断。
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
    // **先 abort 再等待**。被动接入的适配器（反向 WS、HTTP 上报）的 `connect()`
    // 需一直等到对端连入才返回，可能长达十余秒。先 await 即等于令停机被一个
    // "尚未发生的连接"阻塞；abort 之后驱动会立即从等待中退出，该 await
    // 仅用于收尾。顺序颠倒会使 `stop()` 阻塞至该等待超时为止。
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
     * 手动重连把失败计数归零
     *
     * **少了这一句，「重连」在达到上限之后就是个点了没反应的按钮。** `retries` 只在连接
     * 成功那一刻才归零（见 `#doConnect`），故放弃重连后它停在上限值上：不归零的话这次
     * 手动连接一旦仍失败，`#scheduleReconnect` 立刻又判超限、又放弃，而使用者刚刚才
     * 明确要求「再试一次」—— 那句「点重连即可恢复」也就成了空话。
     *
     * 只在手动入口归零，不在 `connect()` 里：后者也被重连定时器调用，在那里归零等于
     * 把上限抹掉（每次重试都从 0 开始数，永远到不了上限）。
     */
    if (rt !== undefined) rt.retries = 0
    await this.disconnect(id, "手动重连")
    await this.connect(id)
  }

  /**
   * 适配器插件被卸载：同步让它名下的账号下线
   *
   * **同步部分**必须在本函数返回前完成（改状态 + abort + 从 Bot 注册表摘除），
   * 因为调用方是同步的 `Disposer`。异步的 socket 关闭挂在 `rt.closing` 上，
   * 由 `stop()` 兜底 await。见文件头第 4 点。
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
   * 并发断开并等到全部收尾，包括 `detachAdapter` 留下的异步尾巴 ——
   * 否则进程退出时会留下没关的 socket，NapCat 侧要等到 TCP 超时才发现。
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
   * 顺序是刻意的：abort（停止投递）→ 摘 Bot 注册表（`pickBot` 拿不到它）→
   * 回收登记（路由、缓存、定时器）→ 关 socket。反过来会有"已断开却还在
   * 处理事件"的窗口。
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
   * **逐字段回落，不是「填了就整套接管」。** 真实诉求多半是「这一个号连不上就别再试了」，
   * 若因此迫使人把退避那三个数一并抄进记录里，抄来的那份此后不会跟着全局改动走 ——
   * 而没人记得自己抄过，症状是「我改了全局间隔，这个号却不听」。
   *
   * 每次调用现算而不缓存：全局那侧是活视图（getter），缓存下来会让「改配置立刻生效」失效。
   * 这个方法只在一次连接失败之后跑，算四个数的代价可以忽略。
   * @param record 账号记录
   * @returns 四项都已定值的策略
   */
  #policyOf(record: AccountRecord): EffectiveRetry {
    const own: AccountRetryOverride = record.retry ?? {}
    const global = this.#retryPolicy
    /*
     * `interval` / `maxInterval` 收的是 `DurationLike`（`"5s"` 或毫秒数），故过一遍
     * `parseDuration`；解析不出来时回落到全局值而不是 0 —— 0 会变成「不等待、立刻重试」，
     * 那是一个把日志刷满、且对端还没缓过来的死循环，而它的起因只是配置里写错了一个单位。
     */
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
   * 达到上限即停手，**并把状态留在 error 上**（不改成别的状态）：使用者在面板上看到的仍是
   * 「这个账号连不上，最后一次的错误是什么」，只是不再自动重试。上限为 0 表示一直重连 ——
   * 那是此前唯一的行为，故取 0 为「不限」而非「不重连」。
   *
   * 四个数取自 `#policyOf`：账号自己填了的用它的，没填的用全局配置。**不在这里读全局值**，
   * 否则「某个号单独设上限」这件事就得在两处判断，而两处迟早分叉。
   *
   * 手动「重连」按钮走 `reconnect()`，那里**显式**把 `retries` 归零（`connect()` 自己不归零，
   * 它同时被重连定时器调用，在那里归零等于把上限抹掉），故放弃之后仍能一键从头再来 ——
   * 少了那条出路，上限一到就只能重启进程。
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
      /*
       * 这一条恒为 warn 而不跟随 WARN_EVERY 降级：它是「此后再也不会自动重试了」的唯一告知，
       * 落进 debug 就等于没说 —— 而使用者看到的现象会是「账号一直离线、日志里也没动静」。
       *
       * 提示按上限的来源分开写：这个号自己填了上限时，让他去改全局配置只会白改一次。
       */
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

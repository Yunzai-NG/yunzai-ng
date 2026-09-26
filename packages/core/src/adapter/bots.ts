/**
 * 模块职责：Bot 门面（`BotFacade`）与 Bot 注册表（实现 `BotRegistryView`）
 * 依赖方向：依赖类型包、message/*、util/*；**不认识适配器实现，也不认识账号管理器**
 * 生命周期：门面随账号连接建立、随断开销毁；注册表随内核创建
 * 注意事项：门面把发送语义收进内核，故适配器只需实现「把这一段消息段发出去」。四件事由门面负责：
 *          `splitLength` 超长切分、`sequential` 同会话串行（`KeyedQueue`，键与 `e.prompt()` 共用
 *          `targetKey`）、`sendTimeout` 发送超时、`recallAfter` / `autoForward`。故 `SendOptions`
 *          四个字段里只有 `quote` 会传到驱动。
 *
 *          超时只是「不再等」，取消不了已发出的请求，故超时后绝不自动重试 —— 否则用户收到两条回复。
 *          只有发送类调用套 `sendTimeout`：`getGroupMemberList` 在千人群上本就要十几秒。
 */
import type {
  BotApi,
  BotCapability,
  BotDriver,
  BotRegistryView,
  ForwardNode,
  GroupInfo,
  Logger,
  MemberInfo,
  MemberListOptions,
  MessageContent,
  MessageSentInfo,
  Segment,
  SendOptions,
  SendResult,
  SendTarget,
  UserInfo
} from "@yunzai-ng/types"
import { toSegments } from "../message/segment.js"
import { splitMessage } from "../message/split.js"
import { describeTarget, targetKey } from "../message/target.js"
import { withTimeout } from "../util/defer.js"
import { KeyedQueue } from "../util/queue.js"

/**
 * `BotApi` 上的可选方法名
 *
 * 门面必须**存在性对齐**驱动：`pipeline/event.ts` 的 `createRequest` 靠
 * `bot.handleGroupRequest === undefined` 判断该平台支不支持同意加群。无条件补齐这些方法
 * 会让那处判断永远为真。
 */
const OPTIONAL_METHODS = [
  "sendForward",
  "setGroupCard",
  "muteGroupMember",
  "muteGroupAll",
  "kickGroupMember",
  "quitGroup",
  "handleFriendRequest",
  "handleGroupRequest",
  "fetchHistory",
  "getMessage",
  "uploadGroupFile",
  "setReaction",
  "getFileUrl"
] as const satisfies readonly (keyof BotApi)[]

/** 需要套用 `sendTimeout` 的可选方法 */
const TIMED_METHODS: ReadonlySet<string> = new Set(["sendForward"])

/**
 * 门面需要的发送策略视图
 *
 * 三个字段都在每次发送时读取，故实现方可用 getter 直连当前配置快照：改了配置下一条消息就生效，
 * 不必重连账号。
 */
export interface SendPolicyView {
  /** 单条消息最大文本长度；`<= 0` 表示不切分 */
  readonly splitLength: number
  /** 单条消息的发送超时（毫秒） */
  readonly sendTimeout: number
  /** 同一会话内是否串行发送 */
  readonly sequential: boolean
}

/** Bot 门面构造参数 */
export interface BotFacadeOptions {
  /** 适配器创建的驱动 */
  readonly driver: BotDriver
  /** 账号记录 id */
  readonly accountId: string
  /** 日志器 */
  readonly logger: Logger
  /** 发送策略视图 */
  readonly policy: SendPolicyView
  /**
   * 一条消息发出后的回调，用于触发 `message/sent` 总线事件
   *
   * 取回调而非直接传 `CoreEventBus`：认识总线就等于认识插件系统，而门面连账号管理器都不认识。
   * 省略即不通知。
   */
  readonly onSent?: (info: MessageSentInfo) => void
}

/** Bot 门面：插件拿到的 `BotApi` 实体 */
export interface BotFacade extends BotApi {
  /** 账号记录 id（`BotApi` 里没有，注册表与 WebUI 用它定位） */
  readonly accountId: string
  /**
   * 关闭门面
   *
   * 此后所有调用立刻 reject，待撤回的定时器一并取消。**不会**调 `driver.disconnect()`：
   * 驱动的生死由账号管理器负责。
   */
  close(): void
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
 * 创建一个 Bot 门面
 *
 * 刻意返回**对象字面量**而不是 class 实例：可选方法必须按驱动的实际实现
 * 逐个决定"装不装"，见 `OPTIONAL_METHODS` 的说明。class 做不到这件事 ——
 * 原型上的方法总是存在。
 * @param opts 构造参数
 * @returns Bot 门面
 */
export function createBotFacade(opts: BotFacadeOptions): BotFacade {
  const { driver, accountId, logger, policy, onSent } = opts
  /** 同会话串行发送队列 */
  const queue = new KeyedQueue()
  /** 待触发的自动撤回定时器 */
  const timers = new Set<NodeJS.Timeout>()
  /** 是否已关闭 */
  let closed = false
  /** 是否已就"平台不支持撤回"提醒过一次 */
  let warnedRecall = false

  /**
   * 确认门面仍然可用
   * @throws 门面已关闭时
   */
  const ensureAlive = (): void => {
    if (closed) {
      throw new Error(
        `账号 ${accountId} 已断开，这个 Bot 句柄失效了：请在用到时重新 ctx.pickBot()，不要把 Bot 存进模块变量`
      )
    }
  }

  /**
   * 安排自动撤回
   * @param messageId 消息 id
   * @param ms 延时毫秒
   */
  const scheduleRecall = (messageId: string, ms: number): void => {
    if (!driver.caps.has("recall")) {
      // 只提醒一次：这是插件作者的能力误判，每条消息都刷一行没有新信息
      if (!warnedRecall) {
        warnedRecall = true
        logger.warn(`适配器 ${driver.adapterId} 不支持撤回，recallAfter 将被忽略`)
      }
      return
    }
    // 平台没返回消息 id 就无从撤回，静默跳过（不是错误，有平台确实不返回）
    if (messageId === "") return

    const timer = setTimeout(() => {
      timers.delete(timer)
      if (closed) return
      void driver.recallMessage(messageId).catch((err: unknown) => {
        // 撤回失败很常见（消息已过撤回时限、被管理员先撤了），不值得报错
        logger.debug(`自动撤回消息 ${messageId} 失败：${errText(err)}`)
      })
    }, ms)
    // 不使"等待撤回"阻止进程退出：停机时该消息留存于群内并无影响
    timer.unref?.()
    timers.add(timer)
  }

  /**
   * 发出一条（已切分好的）消息
   * @param target 发送目标
   * @param chunk 消息段
   * @param quote 引用的消息 id
   * @returns 发送结果
   */
  const sendChunk = async (target: SendTarget, chunk: Segment[], quote: string | undefined): Promise<SendResult> => {
    const pending = quote === undefined ? driver.sendMessage(target, chunk) : driver.sendMessage(target, chunk, { quote })
    return await withTimeout(pending, policy.sendTimeout, `向${describeTarget(target)}发送消息超时`)
  }

  /**
   * 把切分结果包成合并转发节点
   * @param chunks 切分结果
   * @returns 转发节点数组
   */
  const forwardNodes = (chunks: Segment[][]): ForwardNode[] =>
    chunks.map(message => ({ uid: driver.selfId, name: driver.nickname, message }))

  /**
   * 完成一次发送（切分、转发、撤回都在这里）
   * @param target 发送目标
   * @param segments 已展平的消息段
   * @param opts 发送选项
   * @returns 发送结果
   */
  const deliver = async (
    target: SendTarget,
    segments: Segment[],
    opts: SendOptions | undefined
  ): Promise<SendResult> => {
    // 再确认一次：串行队列里排在后面的任务可能等到了断开之后才轮到
    ensureAlive()

    const chunks = splitMessage(segments, opts?.splitLength ?? policy.splitLength)
    const recallAfter = opts?.recallAfter ?? 0
    const results: SendResult[] = []

    // 合并转发：连发五条长文本会把屏幕刷满，折成一个卡片友好得多
    const forward = driver.sendForward
    if (chunks.length > 1 && opts?.autoForward === true) {
      if (forward !== undefined && driver.caps.has("forward")) {
        const result = await withTimeout(
          forward.call(driver, target, forwardNodes(chunks)),
          policy.sendTimeout,
          `向${describeTarget(target)}发送合并转发超时`
        )
        if (recallAfter > 0) scheduleRecall(result.messageId, recallAfter)
        return result
      }
      logger.debug(`适配器 ${driver.adapterId} 不支持合并转发，autoForward 退回逐条发送`)
    }

    for (const [i, chunk] of chunks.entries()) {
      // 只有第一条带引用：每条都引用会让整屏都是回复箭头，
      // 而用户想看到的是"这一串是对那条消息的回答"
      results.push(await sendChunk(target, chunk, i === 0 ? opts?.quote : undefined))
    }
    if (recallAfter > 0) for (const r of results) scheduleRecall(r.messageId, recallAfter)

    const first = results[0]
    // splitMessage 保证至少一条，这里只是让类型收窄；真到了这一步说明切分坏了
    if (first === undefined) return { ok: false, messageId: "", time: Date.now() }
    if (results.length === 1) return first
    // 多条时返回**第一条**的 id：插件拿它去撤回或引用，用户看到的也是从第一条开始
    return {
      ok: results.every(r => r.ok),
      messageId: first.messageId,
      time: first.time,
      raw: results.map(r => r.raw)
    }
  }

  /**
   * 记一行「已发出」并通知总线
   *
   * 日志取 info 级：与「收到消息」成对。只记进来不记出去，则一次问答在日志里
   * 只剩上半句 —— 排障时无从判断是命令没跑，还是跑完了但平台没收。
   *
   * 图文构成逐类计数而非只记总段数：「发了 3 段」看不出是三行字还是两张图，
   * 而「图片发不出去」与「文字发不出去」是两类完全不同的故障。
   * @param target 发送目标
   * @param segments 已展平的消息段
   * @param cost 耗时毫秒
   * @param ok 平台是否接收
   */
  const report = (target: SendTarget, segments: Segment[], cost: number, ok: boolean): void => {
    /** 各类型段的计数 */
    const kinds: Record<string, number> = {}
    for (const s of segments) kinds[s.type] = (kinds[s.type] ?? 0) + 1
    const shape = Object.entries(kinds)
      .map(([type, n]) => `${type}×${n}`)
      .join(" ")
    const verb = ok ? "已发出" : "发送失败"
    logger.info(`[${driver.platform}:${driver.selfId}] ${verb} → ${describeTarget(target)}：${shape}，耗时 ${cost}ms`)
    // 回调自身抛错不该让「消息已发出」变成「发送失败」：统计插件的问题不是发送的问题
    try {
      onSent?.({
        accountId,
        adapterId: driver.adapterId,
        platform: driver.platform,
        target,
        segments: segments.length,
        kinds,
        cost,
        ok
      })
    } catch (err) {
      logger.debug(`message/sent 通知回调抛错：${errText(err)}`)
    }
  }

  /**
   * 发送消息
   * @param target 发送目标
   * @param content 消息内容
   * @param opts 发送选项
   * @returns 发送结果
   */
  const sendMessage = async (
    target: SendTarget,
    content: MessageContent,
    opts?: SendOptions
  ): Promise<SendResult> => {
    ensureAlive()
    const segments = toSegments(content)
    if (segments.length === 0) {
      // 与 `e.reply()` 一致：空内容几乎总是拼装时全部为 undefined 的逻辑缺陷。
      // 告警而非抛错 —— 因一句未能拼装出的提示语而使整个插件失败并不适当。
      logger.warn(`试图向${describeTarget(target)}发送空消息，已忽略`)
      return { ok: false, messageId: "", time: Date.now() }
    }

    /**
     * 实际发送
     *
     * 计时起点在**队列之内**：`sequential` 为真时，一条消息可能先在队列里等上
     * 数秒才轮到自己发。把等待算进「发送耗时」会使统计出的耗时随并发量起伏，
     * 而那反映的是排队深度、不是平台的响应快慢。
     */
    const task = async (): Promise<SendResult> => {
      const started = Date.now()
      try {
        const result = await deliver(target, segments, opts)
        report(target, segments, Date.now() - started, result.ok)
        return result
      } catch (err) {
        // 抛错也报一次：统计要算成功率，只在成功时报则分母恒等于分子。
        // 报完照旧抛出 —— 调用方的错误处理不受影响
        report(target, segments, Date.now() - started, false)
        throw err
      }
    }
    // 同会话串行：并发发送时平台不保证到达顺序，用户会看到图片跑到说明文字前面
    return policy.sequential ? await queue.run(targetKey(target), task) : await task()
  }

  const facade: BotFacade = {
    accountId,
    // 一律用 getter 转发：`selfId` 在握手完成后才知道、`nickname` 会被用户改、
    // `online` 会在重连中反复变化。快照下来就全是过期数据。
    get selfId(): string {
      return driver.selfId
    },
    get platform(): string {
      return driver.platform
    },
    get adapterId(): string {
      return driver.adapterId
    },
    get nickname(): string {
      return driver.nickname
    },
    get online(): boolean {
      return !closed && driver.online
    },
    get caps(): ReadonlySet<BotCapability> {
      return driver.caps
    },
    sendMessage,
    // 以下透传方法全部写成 async：`ensureAlive()` 若同步抛出，
    // 调用方的 `.catch()` 接不住，会变成一个 unhandled 异常
    recallMessage: async (messageId: string): Promise<boolean> => {
      ensureAlive()
      return await driver.recallMessage(messageId)
    },
    getSelfInfo: async (): Promise<UserInfo> => {
      ensureAlive()
      return await driver.getSelfInfo()
    },
    getFriend: async (uid: string): Promise<UserInfo | undefined> => {
      ensureAlive()
      return await driver.getFriend(uid)
    },
    getFriendList: async (): Promise<UserInfo[]> => {
      ensureAlive()
      return await driver.getFriendList()
    },
    getGroup: async (gid: string): Promise<GroupInfo | undefined> => {
      ensureAlive()
      return await driver.getGroup(gid)
    },
    getGroupList: async (): Promise<GroupInfo[]> => {
      ensureAlive()
      return await driver.getGroupList()
    },
    getGroupMember: async (gid: string, uid: string): Promise<MemberInfo | undefined> => {
      ensureAlive()
      return await driver.getGroupMember(gid, uid)
    },
    getGroupMemberList: async (gid: string, listOpts?: MemberListOptions): Promise<MemberInfo[]> => {
      ensureAlive()
      return await driver.getGroupMemberList(gid, listOpts)
    },
    callApi: async <T = unknown>(action: string, params?: Record<string, unknown>): Promise<T> => {
      ensureAlive()
      return await driver.callApi<T>(action, params)
    },
    close: (): void => {
      if (closed) return
      closed = true
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
    }
  }

  for (const name of OPTIONAL_METHODS) {
    const fn = driver[name]
    // 驱动没实现就不装 —— 这正是本函数不写成 class 的原因
    if (typeof fn !== "function") continue
    const timed = TIMED_METHODS.has(name)
    Reflect.set(facade, name, async (...args: unknown[]): Promise<unknown> => {
      ensureAlive()
      const pending = Reflect.apply(fn, driver, args) as Promise<unknown>
      return await (timed ? withTimeout(pending, policy.sendTimeout, `调用 ${name} 超时`) : pending)
    })
  }

  return facade
}

/** 注册表内部条目 */
interface BotEntry {
  /** 门面 */
  readonly facade: BotFacade
  /**
   * 建索引时的 selfId 快照
   *
   * 用它而不是 `facade.selfId` 摘索引：驱动重连后 selfId 理论上可变，
   * 若按当前值去删，旧索引就会永久残留。
   */
  readonly selfId: string
}

/** Bot 注册表构造参数 */
export interface BotRegistryOptions {
  /** 日志器 */
  readonly logger: Logger
}

/**
 * Bot 注册表
 *
 * 只登记**已连接**的账号：`BotRegistryView.get()` 的契约是"未连接时 undefined"，
 * 因此账号管理器在 `connect()` 成功后才 `add`，断开时立刻 `remove`。
 * 让离线账号留在表里会让插件的 `pickBot()` 拿到一个永远发不出消息的壳子。
 */
export class BotRegistry implements BotRegistryView {
  /** 日志器 */
  readonly #logger: Logger
  /** 账号记录 id → 条目 */
  readonly #byAccount = new Map<string, BotEntry>()
  /** 平台 selfId → 条目（同一个 QQ 可能有两条账号记录，例如正向 WS 与 HTTP 各一条） */
  readonly #bySelfId = new Map<string, BotEntry[]>()

  /**
   * @param opts 构造参数
   */
  constructor(opts: BotRegistryOptions) {
    this.#logger = opts.logger.child({ scope: "bot" })
  }

  /** 在线 Bot 数量 */
  get size(): number {
    let n = 0
    // 不走 online() —— 那会为了数个数分配一个数组
    for (const entry of this.#byAccount.values()) if (entry.facade.online) n++
    return n
  }

  /** 已登记的账号数（含短暂离线的） */
  get total(): number {
    return this.#byAccount.size
  }

  /**
   * 登记一个已连接的账号
   *
   * 必须在驱动知道自己的 selfId **之后**调用（即 `connect()` 解析之后），
   * 否则 selfId 索引会建在空串上。重连走"remove → add"，索引因此自愈。
   * @param facade Bot 门面
   * @returns 被顶掉的旧门面（同一账号重复登记时），没有则 undefined
   */
  add(facade: BotFacade): BotFacade | undefined {
    const previous = this.remove(facade.accountId)
    const entry: BotEntry = { facade, selfId: facade.selfId }
    this.#byAccount.set(facade.accountId, entry)

    let list = this.#bySelfId.get(entry.selfId)
    if (list === undefined) {
      list = []
      this.#bySelfId.set(entry.selfId, list)
    }
    list.push(entry)

    if (list.length > 1) {
      // 不是错误：一个 QQ 挂两条链路（正向 WS + HTTP 回调）是合法用法。
      // 但这意味着 bySelfId 存在歧义，此处提示一句，以免排障时误判至他处
      this.#logger.info(`账号 ${facade.selfId} 有 ${list.length} 条链路在线，bySelfId 只会返回其中一条`)
    }
    return previous
  }

  /**
   * 摘除一个账号
   * @param accountId 账号记录 id
   * @returns 被摘除的门面；未登记时 undefined
   */
  remove(accountId: string): BotFacade | undefined {
    const entry = this.#byAccount.get(accountId)
    if (entry === undefined) return undefined
    this.#byAccount.delete(accountId)

    const list = this.#bySelfId.get(entry.selfId)
    if (list !== undefined) {
      const at = list.indexOf(entry)
      if (at >= 0) list.splice(at, 1)
      if (list.length === 0) this.#bySelfId.delete(entry.selfId)
    }
    return entry.facade
  }

  /**
   * 按账号记录 id 取 Bot
   * @param accountId 账号记录 id
   * @returns Bot，未连接时 undefined
   */
  get(accountId: string): BotApi | undefined {
    return this.#byAccount.get(accountId)?.facade
  }

  /**
   * 按平台 selfId 取 Bot
   *
   * 同一个 QQ 有多条链路时优先返回在线的那条；全都不在线则返回第一条 ——
   * 而不是 undefined。重连的瞬间返回"找不到这个账号"会让插件走进
   * "配置错了吗"的排查方向，让驱动报一个真实的网络错误更有指向性。
   * @param selfId 平台账号 id
   * @returns Bot，未连接时 undefined
   */
  bySelfId(selfId: string): BotApi | undefined {
    const list = this.#bySelfId.get(selfId)
    if (list === undefined) return undefined
    for (const entry of list) if (entry.facade.online) return entry.facade
    return list[0]?.facade
  }

  /**
   * 列出所有在线 Bot
   * @returns Bot 数组
   */
  online(): BotApi[] {
    const out: BotApi[] = []
    for (const entry of this.#byAccount.values()) if (entry.facade.online) out.push(entry.facade)
    return out
  }

  /**
   * 列出全部门面（含离线），停机时逐个关闭用
   * @returns 门面数组
   */
  all(): BotFacade[] {
    const out: BotFacade[] = []
    for (const entry of this.#byAccount.values()) out.push(entry.facade)
    return out
  }

  /** 清空登记（不关闭门面，由账号管理器负责） */
  clear(): void {
    this.#byAccount.clear()
    this.#bySelfId.clear()
  }
}

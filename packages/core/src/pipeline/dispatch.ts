/**
 * 模块职责：事件分发编排 —— 把一条 `IncomingEvent` 走完"策略 → 中间件 → 等待 → 路由 → 冷却 → 处理"
 * 依赖方向：依赖管线内各子模块与事件总线；不依赖适配器实现，也不被适配器 import
 * 生命周期：随内核创建；无跨事件状态（冷却与等待都在各自的模块里）
 * 注意事项：这是**唯一**决定"一条消息会发生什么"的地方，顺序即语义：
 *
 *          1. 维护模式 / 忽略自身 —— 在构造事件对象**之前**判掉，省掉全部派生计算
 *          2. 中间件 —— 可改写 `message`、可注入字段、可 `stop()`
 *          3. `e.prompt()` 等待者 —— 放在中间件之后（让改写生效）、路由之前
 *             （用户正在回答问题时不该同时触发命令，否则会收到两条回复）
 *          4. 命令路由 —— 只做纯查询与零成本静态过滤
 *          5. 冷却 —— 命中之后才计费，且主人豁免
 *          6. 处理函数 —— 返回 `false` 继续找下一条，`block !== false` 则命中即止
 *
 *          `submit()` **永不抛出**。适配器在 socket 回调里调它，一个未捕获的
 *          rejection 会变成 `unhandledRejection` 进而带崩整个进程。
 */
import type {
  AnyEvent,
  BotApi,
  CommandMatch,
  IncomingEvent,
  IncomingMessageEvent,
  IncomingRequestEvent,
  Logger,
  MetaEvent,
  NoticeEvent,
  RequestEvent
} from "@yunzai-ng/types"
import type { CommandRegistration } from "../plugin/hooks.js"
import type { CoreEventBus } from "../plugin/events.js"
import { describeMessage } from "../message/segment.js"
import { parseDuration } from "../util/duration.js"
import { Semaphore } from "../util/queue.js"
import { cooldownKey, renderCooldownTip } from "./cooldown.js"
import type { CooldownStore } from "./cooldown.js"
import type { EventFactory, PluginRuntimeView, RuntimeMessageEvent } from "./event.js"
import type { MiddlewarePipeline } from "./middleware.js"
import type { PromptRegistry } from "./prompt.js"
import type { CommandRouter, RouterCandidate } from "./router.js"

/**
 * 分发器需要的策略视图
 *
 * 仅取两项：**维护模式的判定仅在此一处**，管线下游不再重复判定，
 * 否则"消息在哪一层被丢弃"将成为无法回答的问题。
 */
export interface DispatchPolicyView {
  /** 是否忽略机器人自己发出的消息 */
  readonly ignoreSelf: boolean
  /**
   * 该用户当前是否应被响应
   * @param uid 用户 id
   * @returns 是否响应
   */
  canRespond(uid: string): boolean
}

/** 分发器构造参数 */
export interface EventDispatcherOptions {
  /** 日志器 */
  readonly logger: Logger
  /** 策略视图 */
  readonly policy: DispatchPolicyView
  /** 内核事件总线 */
  readonly events: CoreEventBus
  /** 事件工厂 */
  readonly factory: EventFactory
  /** 中间件管线 */
  readonly middlewares: MiddlewarePipeline
  /** 命令路由 */
  readonly router: CommandRouter
  /** 冷却存储 */
  readonly cooldown: CooldownStore
  /** `prompt` 等待者登记表 */
  readonly prompts: PromptRegistry
  /**
   * 按插件名取运行时视图
   *
   * 由插件宿主注入。`e.render()` 要靠它定位"当前插件"的模板根，
   * `e.prompt()` 要靠它拿卸载信号。分发器自己不认识 PluginHost，
   * 否则 host → context → hooks → dispatch → host 就绕成环了。
   * @param name 插件名
   * @returns 插件运行时视图；插件已卸载时 undefined
   */
  readonly plugins: (name: string) => PluginRuntimeView | undefined
  /**
   * 命令处理的并发上限，对应配置项 `message.concurrency`
   *
   * 省略或 `<= 0` 表示不限制，此时连信号量都不创建（零开销）。
   * 闸门的位置有讲究，见 `#route` 的注释。
   */
  readonly concurrency?: number
}

/**
 * 取错误的可读描述
 * @param err 任意抛出物
 * @returns 描述文本
 */
function errText(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err)
}

/** 事件分发器 */
export class EventDispatcher {
  /** 日志器 */
  readonly #logger: Logger
  /** 策略视图 */
  readonly #policy: DispatchPolicyView
  /** 事件总线 */
  readonly #events: CoreEventBus
  /** 事件工厂 */
  readonly #factory: EventFactory
  /** 中间件管线 */
  readonly #middlewares: MiddlewarePipeline
  /** 命令路由 */
  readonly #router: CommandRouter
  /** 冷却存储 */
  readonly #cooldown: CooldownStore
  /** 等待者登记表 */
  readonly #prompts: PromptRegistry
  /** 插件运行时视图查询 */
  readonly #plugins: (name: string) => PluginRuntimeView | undefined
  /** 命令执行闸门；未配置并发上限时 undefined */
  readonly #gate: Semaphore | undefined
  /** 闸门积压到多少条开始告警 */
  readonly #backlogWarnAt: number

  /** 累计处理的事件数，用于 WebUI 的运行状态 */
  #handled = 0
  /** 已就积压告警过的次数，用于降频 */
  #backlogWarns = 0

  /**
   * @param opts 构造参数
   */
  constructor(opts: EventDispatcherOptions) {
    this.#logger = opts.logger
    this.#policy = opts.policy
    this.#events = opts.events
    this.#factory = opts.factory
    this.#middlewares = opts.middlewares
    this.#router = opts.router
    this.#cooldown = opts.cooldown
    this.#prompts = opts.prompts
    this.#plugins = opts.plugins

    const limit = opts.concurrency ?? 0
    this.#gate = limit > 0 ? new Semaphore(limit) : undefined
    // 阈值取"上限的十倍"：并发 1 的时候 10 条积压就值得说一句，
    // 并发 16 的时候 10 条只是正常波峰。下限 50 免得小上限下刷屏
    this.#backlogWarnAt = Math.max(limit * 10, 50)
  }

  /** 累计处理的事件数 */
  get handled(): number {
    return this.#handled
  }

  /** 当前因并发上限而排队等待的命令数；未配置上限时恒为 0 */
  get queued(): number {
    return this.#gate?.pending ?? 0
  }

  /**
   * 投递一条事件并处理完毕
   *
   * 适配器唯一的入口。**永不抛出**：任何错误都在这里落日志并转成
   * `pipeline/error` 事件，适配器不需要 try/catch。
   * @param incoming 适配器产出的事件
   * @param bot 接收该事件的 Bot
   */
  async submit(incoming: IncomingEvent, bot: BotApi): Promise<void> {
    let event: AnyEvent | undefined
    try {
      if (incoming.kind === "message") {
        if (!this.#acceptMessage(incoming, bot)) return
        const e = this.#factory.createMessage(incoming, bot)
        event = e
        this.#handled++
        await this.#processMessage(e)
        return
      }
      // 请求事件同样受维护模式约束：同意加群也是一种"对普通用户的响应"。
      // 通知与元事件不受约束 —— "有人退群就清理他的数据"这类插件在维护模式下
      // 也必须继续工作，否则维护结束后数据就对不上了。
      if (incoming.kind === "request" && !this.#acceptRequest(incoming)) return

      const other = this.#factory.create(incoming, bot) as NoticeEvent | RequestEvent | MetaEvent
      event = other
      this.#handled++
      await this.#processOther(other)
    } catch (err) {
      if (event === undefined) {
        // 连事件对象都没构造出来，说明适配器交上来的报文不合规
        this.#logger.error(`构造事件失败（适配器 ${bot.adapterId}）：${errText(err)}`)
        return
      }
      this.#logger.error(`处理事件 ${event.id} 时抛出未捕获错误：${errText(err)}`)
      // 用 detached：错误处理插件自己再抛错也不该影响这条调用链
      this.#events.emitDetached("pipeline/error", event, err)
    }
  }

  /**
   * 消息事件的准入判定
   * @param incoming 适配器产出的消息事件
   * @param bot 接收该事件的 Bot
   * @returns 是否继续处理
   */
  #acceptMessage(incoming: IncomingMessageEvent, bot: BotApi): boolean {
    if (this.#policy.ignoreSelf && incoming.sender.uid === bot.selfId) return false
    if (!this.#policy.canRespond(incoming.sender.uid)) {
      if (this.#logger.isLevelEnabled("trace")) {
        this.#logger.trace(`维护模式：忽略 ${incoming.sender.uid} 的消息`)
      }
      return false
    }
    return true
  }

  /**
   * 请求事件的准入判定
   * @param incoming 适配器产出的请求事件
   * @returns 是否继续处理
   */
  #acceptRequest(incoming: IncomingRequestEvent): boolean {
    return this.#policy.canRespond(incoming.uid)
  }

  /**
   * 处理消息事件
   * @param e 运行时消息事件
   */
  async #processMessage(e: RuntimeMessageEvent): Promise<void> {
    this.#logIncoming(e)
    // core 里先路由再广播：`message` 总线事件的契约是"命令路由之后触发"，
    // 统计类插件因此能看到 e.command 是否有值
    await this.#middlewares.run(e, async () => {
      await this.#route(e)
      await this.#events.emit("message", e)
    })
  }

  /**
   * 处理通知 / 请求 / 元事件
   *
   * 这三类不存在"核心处理"—— 内核不代替插件决定是否同意入群请求。广播本身即为核心，
   * 因此置于 `run` 的 core 位置：中间件调用 `stop()` 后自然不会广播，
   * 无须在外层再判定一次 `stopped`。
   * @param event 运行时事件
   */
  async #processOther(event: NoticeEvent | RequestEvent | MetaEvent): Promise<void> {
    await this.#middlewares.run(event, async () => {
      switch (event.kind) {
        case "notice":
          await this.#events.emit("notice", event)
          return
        case "request":
          await this.#events.emit("request", event)
          return
        case "meta":
          await this.#events.emit("meta", event)
          return
      }
    })
  }

  /**
   * 等待者投递 + 命令路由
   *
   * 并发闸门刻意开在**这里**而不是 `submit()` 入口，原因是 `e.prompt()`：
   * 一个正在等用户回话的命令会一直占着许可，而"能结束这次等待"的下一条消息
   * 必须先取得许可方能被处理 —— 闸门置于入口即构成死锁。等待者投递不需要
   * 许可（它仅是唤醒一个已在执行中的处理函数），因此在 `offer()` 之后再取许可
   * 既拦住了昂贵的命令处理，又不会将交互式流程锁死。
   *
   * 代价是中间件与 `message` 总线事件不受限制。它们本应是轻量的，
   * 真正可能同时开启大量浏览器页面的是命令处理函数。
   * @param e 运行时消息事件
   */
  async #route(e: RuntimeMessageEvent): Promise<void> {
    // 命中等待者即消费掉这条消息，不再进路由
    if (this.#prompts.offer(e)) return

    const candidates = this.#router.match(e)
    if (candidates.length === 0) return

    const gate = this.#gate
    if (gate === undefined) return this.#invokeAll(e, candidates)

    // 不丢弃积压，只告警：事件对象在这一步之前就已经构造出来了，
    // 丢掉它省不下多少内存，却会让用户的命令无声消失
    if (gate.pending >= this.#backlogWarnAt) {
      this.#backlogWarns++
      if (this.#backlogWarns === 1 || this.#backlogWarns % 100 === 0) {
        this.#logger.warn(
          `命令处理积压 ${gate.pending} 条（并发上限 ${gate.active} 已满）。` +
            `若非突发流量，请调大配置项 message.concurrency 或排查耗时过长的命令`
        )
      }
    }
    return gate.use(() => this.#invokeAll(e, candidates))
  }

  /**
   * 依次尝试候选命令，直到有一条命中并阻断
   * @param e 运行时消息事件
   * @param candidates 候选命令
   */
  async #invokeAll(e: RuntimeMessageEvent, candidates: readonly RouterCandidate[]): Promise<void> {
    for (const candidate of candidates) {
      if (e.stopped) break
      const handled = await this.#invoke(e, candidate.reg, candidate.match)
      if (!handled) continue
      // 缺省阻断：一条消息通常只该有一个功能响应。声明 block: false 的
      // 命令（如日志、统计类）才会让后面的命令继续匹配。
      if (candidate.reg.options.block !== false) break
    }
  }

  /**
   * 执行一条命令（含冷却计费）
   * @param e 运行时消息事件
   * @param reg 命令登记
   * @param match 匹配结果
   * @returns 是否算作"已处理"
   */
  async #invoke(e: RuntimeMessageEvent, reg: CommandRegistration, match: CommandMatch): Promise<boolean> {
    const handler = reg.handler
    if (handler === undefined) return false

    // 冷却判定放在这里而不是路由里：路由是纯查询，WebUI 要能反复调用它做预览，
    // 而 hit() 会真的占用配额。只有确定要执行才计费。
    const ms = parseDuration(reg.options.cooldown, 0)
    let cdKey: string | undefined
    if (ms > 0 && !e.isMaster) {
      cdKey = cooldownKey(reg.plugin, match.name, reg.options.cooldownScope ?? "user", e)
      const decision = this.#cooldown.hit(cdKey, ms)
      if (!decision.ok) {
        const tip = reg.options.cooldownTip
        if (tip !== undefined && tip !== "") await e.reply(renderCooldownTip(tip, decision.remaining))
        // 冷却中也算"已处理"：继续往下匹配的话，用户会看到"刷太快反而
        // 触发了另一个功能"，比什么都不回更费解
        return true
      }
    }

    e.command = match
    e.bind(this.#plugins(reg.plugin))
    const started = Date.now()
    // 命中即记：这行与「处理完毕」成对出现，缺了它则一条命令耗时很长时，
    // 使用者只看到消息进来了而不知道正在跑哪个命令
    this.#logger.info(`命令命中 ${reg.plugin}:${match.name}`)
    try {
      const result = await handler(e)
      if (result === false) {
        // 插件显式表示"我不处理这条"，把刚占用的 CD 退回去。
        // 不发 command/done：这条命令并未处理该消息，计入调用统计会虚高
        if (cdKey !== undefined) this.#cooldown.reset(cdKey)
        return false
      }
      const cost = Date.now() - started
      // 级别由 debug 提到 info：默认级别是 info，包在 debug 里等于这行永不出现，
      // 使用者看到的是「消息进来了，然后没有下文」
      this.#logger.info(`命令 ${reg.plugin}:${match.name} 处理完毕，耗时 ${cost}ms`)
      this.#events.emitDetached("command/done", e, { plugin: reg.plugin, command: match.name, cost, ok: true })
      return true
    } catch (err) {
      // 执行失败不该让用户为此等一个完整的 CD
      if (cdKey !== undefined) this.#cooldown.reset(cdKey)
      const cost = Date.now() - started
      this.#logger.error(`插件 ${reg.plugin} 的命令 ${match.name} 执行出错（耗时 ${cost}ms）：${errText(err)}`)
      this.#events.emitDetached("pipeline/error", e, err)
      // 失败同样发 command/done：统计要算成功率，只在成功时发则分母永远等于分子
      this.#events.emitDetached("command/done", e, {
        plugin: reg.plugin,
        command: match.name,
        cost,
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      })
      // 出错也算已处理：继续匹配只会让用户收到一条不相关的回复
      return true
    } finally {
      // 解绑：脱离处理函数后 e.render() 应当明确报错而不是渲染到上一个插件的
      // 模板目录里去。异步回调里要渲染请用 ctx.render()。
      e.bind(undefined)
    }
  }

  /**
   * 记录收到的消息
   *
   * **必带协议与账号。** 同一进程可同时挂多个平台的多个账号，只记
   * 「[群 X] 某人: 内容」在排障时答不出「这条是哪个号收到的」——
   * 而 `bot` 对象本就在手边。格式取 `platform:selfId`：平台名说明是哪个协议，
   * selfId 说明是哪个号，二者都取自 `e.bot` 的 getter，不缓存。
   * @param e 运行时消息事件
   */
  #logIncoming(e: RuntimeMessageEvent): void {
    if (!this.#logger.isLevelEnabled("info")) return
    const who = `${e.sender.name ?? ""}(${e.sender.uid})`
    const body = describeMessage(e.message)
    const via = `${e.bot.platform}:${e.bot.selfId}`
    switch (e.scene) {
      case "group":
        this.#logger.info(`[${via}][群 ${e.group?.name ?? e.group?.gid ?? "?"}] ${who}: ${body}`)
        return
      case "guild":
        this.#logger.info(`[${via}][频道 ${e.channel?.name ?? e.channel?.channelId ?? "?"}] ${who}: ${body}`)
        return
      case "private":
        this.#logger.info(`[${via}][私聊] ${who}: ${body}`)
        return
    }
  }
}

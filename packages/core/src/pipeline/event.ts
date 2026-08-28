/**
 * 模块职责：把适配器产出的 `Incoming*Event` 补全成插件可用的运行时事件
 * 依赖方向：依赖类型包、message/segment、pipeline/prompt、util/id、util/duration；不依赖适配器实现
 * 生命周期：每条事件一个实例，处理完即被 GC；不持有跨事件状态
 * 注意事项：**适配器只负责翻译报文，派生字段全部由这里算** —— 摊到各适配器里会让 `e.atBot` 在
 *          不同协议下语义不一致，插件只能两边都试。
 *
 *          派生字段（`atMe` / `atUsers` / `images` / `text`）用 getter + 私有缓存：中间件改写
 *          `message` 后调一次 `refresh()` 重算，而不是每次读取都重新遍历 —— 路由匹配阶段 `e.text`
 *          会被读几十次。
 *
 *          实例**刻意不 freeze、不 seal**：`EventExtensions` 的正规用法就是插件在事件上挂自有字段。
 *
 *          `e.render()` 依赖「当前执行的是哪个插件」（模板根随插件而定），故该绑定由 dispatch 在调
 *          每个 handler 之前经 `bind()` 替换，而不写进事件的构造参数 —— 一条消息会依次流经多个插件。
 */
import type {
  BotApi,
  ChannelInfo,
  CommandMatch,
  GroupInfo,
  GroupRole,
  ImageSegment,
  IncomingEvent,
  IncomingMessageEvent,
  IncomingNoticeEvent,
  IncomingMetaEvent,
  IncomingRequestEvent,
  Logger,
  MemberInfo,
  MessageContent,
  MessageEvent,
  MessageScene,
  MetaEvent,
  NoticeEvent,
  PromptOptions,
  QuoteInfo,
  RenderablePage,
  RenderOptions,
  RenderedImage,
  ReplyOptions,
  RequestEvent,
  Segment,
  SendOptions,
  SendResult,
  SendTarget,
  UserInfo
} from "@yunzai-ng/types"
import { atUsersOf, hasAtAll, imagesOf, seg, textOf, toSegments } from "../message/segment.js"
import { createEventId } from "../util/id.js"
import { parseDuration } from "../util/duration.js"
import { DEFAULT_PROMPT_TIMEOUT, PromptRegistry, sessionKeyOf } from "./prompt.js"

/**
 * 昵称后面允许被一并剥掉的呼唤语气字符
 *
 * 刻意**不含** `.` `!` `~` `/` `#` —— 这些在各家插件里都是真实的命令前缀，
 * 剥掉会把 `云崽 .help` 变成 `help` 从而匹配不上。这里只剥"叫人"用的标点。
 */
const NICKNAME_TAIL_RE = /^[\s,，、:：]+/

/**
 * 事件工厂需要的策略视图
 *
 * 只取用得到的两项而不是直接依赖 `KernelPolicy`：事件构造与"主人是谁"之间
 * 只有这么一点耦合，写成最小接口后单测里给个字面量就能跑。
 */
export interface EventPolicyView {
  /** 机器人昵称列表，用于把"云崽 #体力"识别为对我说话 */
  readonly nicknames: readonly string[]
  /**
   * 判断是否主人
   * @param uid 用户 id
   * @returns 是否主人
   */
  isMaster(uid: string): boolean
}

/**
 * 当前正在执行的插件在事件上的投影
 *
 * `PluginContext` 结构上天然满足它，因此 dispatch 直接把上下文传进来即可，
 * 不需要额外包一层。
 */
export interface PluginRuntimeView {
  /** 插件名 */
  readonly name: string
  /** 插件卸载信号 */
  readonly signal: AbortSignal
  /**
   * 渲染 TSX 页面（模板根已绑定到该插件）
   * @param page 已渲染好的页面
   * @param opts 渲染选项
   * @returns 图片段
   */
  render(page: RenderablePage, opts?: RenderOptions): Promise<RenderedImage>

  /**
   * 渲染字符串模板（模板根已绑定到该插件）
   * @param template 模板路径
   * @param data 模板数据
   * @param opts 渲染选项
   * @returns 图片段
   */
  render(template: string, data?: Record<string, unknown>, opts?: RenderOptions): Promise<RenderedImage>
}

/** 内核内部持有的消息事件：比插件看到的多一个绑定入口 */
export interface RuntimeMessageEvent extends MessageEvent {
  /**
   * 绑定当前正在执行的插件
   *
   * 只影响 `render()`/`renderReply()`/`prompt()` 的归属。dispatch 在每个
   * handler 前后成对调用；传 `undefined` 表示"当前不在任何插件里"。
   * @param view 插件运行时视图
   */
  bind(view: PluginRuntimeView | undefined): void
}

/** 事件工厂构造参数 */
export interface EventFactoryOptions {
  /** 日志器 */
  readonly logger: Logger
  /** 策略视图 */
  readonly policy: EventPolicyView
  /** `prompt` 等待者登记表 */
  readonly prompts: PromptRegistry
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
 * 推断通知事件应该回到哪里
 *
 * 有群号回群、否则回给相关用户。两者都没有（如纯连接类通知）返回 undefined，
 * 由 `reply()` 抛错 —— 静默丢弃会让插件作者以为消息发出去了。
 * @param n 通知事件
 * @returns 发送目标；无法推断时 undefined
 */
function noticeTargetOf(n: IncomingNoticeEvent): SendTarget | undefined {
  if (n.gid !== undefined) return { scene: "group", gid: n.gid }
  if (n.uid !== undefined) return { scene: "private", uid: n.uid }
  return undefined
}

/** 运行时消息事件实现 */
class MessageEventImpl implements RuntimeMessageEvent {
  /** 事件大类 */
  readonly kind = "message" as const

  /** 事件唯一 id */
  readonly id: string
  /** 发生时间（毫秒） */
  readonly time: number
  /** 平台标识 */
  readonly platform: string
  /** 接收该事件的账号 id */
  readonly selfId: string
  /** 接收该事件的 Bot */
  readonly bot: BotApi
  /** 平台原始报文 */
  readonly raw: unknown
  /** 本次事件的临时状态袋 */
  readonly state: Record<string, unknown> = {}

  /** 场景 */
  readonly scene: MessageScene
  /** 平台细分类型 */
  readonly subType: string
  /** 平台消息 id */
  readonly messageId: string
  /** 会话内序号 */
  readonly seq?: number

  /** 消息段（可改写，改后需 `refresh()`） */
  message: Segment[]
  /** 纯文本视图 */
  text = ""

  /** 发送者 */
  readonly sender: UserInfo | MemberInfo
  /** 所在群 */
  readonly group?: GroupInfo
  /** 所在子频道 */
  readonly channel?: ChannelInfo
  /** 引用的消息 */
  readonly quote?: QuoteInfo

  /** 命令匹配结果 */
  command?: CommandMatch

  /** 日志器 */
  readonly #logger: Logger
  /** 策略视图 */
  readonly #policy: EventPolicyView
  /** 等待者登记表 */
  readonly #prompts: PromptRegistry

  /** 回复目标（构造时算一次，场景与群号都是只读的） */
  readonly #target: SendTarget
  /** 发送者在群里的角色 */
  readonly #role: GroupRole | undefined
  /** 是否主人 */
  readonly #isMaster: boolean

  /** 是否 @ 了自己 */
  #atMe = false
  /** 被 @ 的用户 */
  #atUsers: readonly string[] = []
  /** 图片段（含引用消息里的） */
  #images: readonly ImageSegment[] = []
  /** 是否已被阻断 */
  #stopped = false
  /** 当前执行中的插件 */
  #binding: PluginRuntimeView | undefined

  /**
   * @param incoming 适配器产出的消息事件
   * @param bot 接收该事件的 Bot
   * @param opts 工厂依赖
   */
  constructor(incoming: IncomingMessageEvent, bot: BotApi, opts: EventFactoryOptions) {
    this.#logger = opts.logger
    this.#policy = opts.policy
    this.#prompts = opts.prompts

    this.id = incoming.id ?? createEventId()
    this.time = incoming.time ?? Date.now()
    this.platform = bot.platform
    this.selfId = bot.selfId
    this.bot = bot
    this.raw = incoming.raw

    this.scene = incoming.scene
    this.subType = incoming.subType ?? incoming.scene
    this.messageId = incoming.messageId
    this.seq = incoming.seq
    // 不复制数组：适配器交出来就不该再持有它，复制只是白白多一次分配。
    // 中间件改写 message 是被允许的，改的就是这一份。
    this.message = incoming.message
    this.sender = incoming.sender
    this.group = incoming.group
    this.channel = incoming.channel
    this.quote = incoming.quote

    this.#role = "role" in incoming.sender ? incoming.sender.role : undefined
    this.#isMaster = opts.policy.isMaster(incoming.sender.uid)
    this.#target = this.#computeTarget()
    this.refresh()
  }

  /** 是否 @ 了自己（含 @全体、含昵称呼唤） */
  get atMe(): boolean {
    return this.#atMe
  }

  /** 被 @ 的用户 id 列表 */
  get atUsers(): readonly string[] {
    return this.#atUsers
  }

  /** 消息中的图片段（含引用消息里的图） */
  get images(): readonly ImageSegment[] {
    return this.#images
  }

  /** 发送者是否主人 */
  get isMaster(): boolean {
    return this.#isMaster
  }

  /** 发送者是否群管理（群主也算） */
  get isGroupAdmin(): boolean {
    return this.#role === "owner" || this.#role === "admin"
  }

  /** 发送者是否群主 */
  get isGroupOwner(): boolean {
    return this.#role === "owner"
  }

  /** 是否私聊 */
  get isPrivate(): boolean {
    return this.scene === "private"
  }

  /** 是否群聊（频道不算，频道判断用 `scene === "guild"`） */
  get isGroup(): boolean {
    return this.scene === "group"
  }

  /** 回复该消息时应发往的目标 */
  get target(): SendTarget {
    return this.#target
  }

  /** 是否已被阻断 */
  get stopped(): boolean {
    return this.#stopped
  }

  /** 阻断后续中间件与命令匹配 */
  stop(): void {
    this.#stopped = true
  }

  /**
   * 绑定当前正在执行的插件
   * @param view 插件运行时视图
   */
  bind(view: PluginRuntimeView | undefined): void {
    this.#binding = view
  }

  /** 改写 `message` 后重算派生字段 */
  refresh(): void {
    const message = this.message
    const atUsers = atUsersOf(message)
    const images = imagesOf(message)

    // 引用消息里的图也算进来：这是"识图"类指令唯一的数据来源。
    // 放在自身图片之后 —— 用户自己发的图优先级更高。
    const quoted = this.quote?.message
    if (quoted !== undefined && quoted.length > 0) images.push(...imagesOf(quoted))

    let atMe = hasAtAll(message)
    if (!atMe) {
      for (const uid of atUsers) {
        if (uid === this.selfId) {
          atMe = true
          break
        }
      }
    }

    let text = textOf(message)
    const stripped = this.#stripNickname(text)
    if (stripped !== undefined) {
      // 昵称已经从 text 里剥掉：这样 `云崽 #体力` 与 `#体力` 走同一条路由，
      // 插件不必自己处理昵称前缀
      text = stripped
      atMe = true
    }

    this.text = text
    this.#atUsers = atUsers
    this.#images = images
    this.#atMe = atMe
  }

  /**
   * 回复
   * @param content 消息内容
   * @param opts 回复选项
   * @returns 发送结果
   */
  async reply(content: MessageContent, opts: ReplyOptions = {}): Promise<SendResult> {
    const segments = toSegments(content)
    if (segments.length === 0) {
      // 空内容送到平台上通常是一个含义不明的 API 报错。这里拦下并指名道姓，
      // 因为源头几乎总是插件里某个分支忘了赋值。
      this.#logger.warn(`插件 ${this.#binding?.name ?? "未知"} 回复了空内容，已忽略（事件 ${this.id}）`)
      return { ok: false, messageId: "", time: Date.now() }
    }

    const payload: Segment[] =
      opts.at === true && this.isGroup ? [seg.at(this.sender.uid, this.sender.name), ...segments] : segments

    const send: SendOptions = {}
    if (opts.quote === true) send.quote = this.messageId
    else if (typeof opts.quote === "string") send.quote = opts.quote
    if (opts.recallAfter !== undefined) send.recallAfter = opts.recallAfter
    if (opts.autoForward !== undefined) send.autoForward = opts.autoForward
    if (opts.splitLength !== undefined) send.splitLength = opts.splitLength

    return this.bot.sendMessage(this.#target, payload, send)
  }

  /**
   * 渲染 TSX 页面为图片段（不发送）
   * @param page 已渲染好的页面
   * @param opts 渲染选项
   * @returns 图片段
   */
  async render(page: RenderablePage, opts?: RenderOptions): Promise<RenderedImage>
  /**
   * 渲染字符串模板为图片段（不发送）
   * @param template 模板路径，相对本插件模板根
   * @param data 模板数据
   * @param opts 渲染选项
   * @returns 图片段
   */
  async render(template: string, data?: Record<string, unknown>, opts?: RenderOptions): Promise<RenderedImage>
  /**
   * 渲染实现
   * @param first 页面或模板路径
   * @param second TSX 通路为渲染选项，字符串通路为模板数据
   * @param third 字符串通路的渲染选项
   * @returns 图片段
   * @throws 不在插件执行上下文里调用时
   */
  async render(
    first: RenderablePage | string,
    second?: Record<string, unknown> | RenderOptions,
    third?: RenderOptions
  ): Promise<RenderedImage> {
    const binding = this.#binding
    if (binding === undefined) {
      throw new Error(
        "e.render() 只能在插件的命令处理函数或中间件里调用：内核要靠「当前插件」定位模板根目录。" +
          "若要在 setTimeout 等脱离上下文的回调里渲染，请改用 ctx.render()"
      )
    }
    // 两条通路在此汇合后原样转交给上下文，由其统一判别形态 —— 此处再判一次
    // 只会让"形态如何判定"散落在两个文件里
    if (typeof first === "string") return binding.render(first, second as Record<string, unknown> | undefined, third)
    return binding.render(first, second as RenderOptions | undefined)
  }

  /**
   * 渲染 TSX 页面并直接回复
   * @param page 已渲染好的页面
   * @param opts 渲染与回复选项
   * @returns 发送结果
   */
  async renderReply(page: RenderablePage, opts?: RenderOptions & ReplyOptions): Promise<SendResult>
  /**
   * 渲染字符串模板并直接回复
   * @param template 模板路径
   * @param data 模板数据
   * @param opts 渲染与回复选项
   * @returns 发送结果
   */
  async renderReply(
    template: string,
    data?: Record<string, unknown>,
    opts?: RenderOptions & ReplyOptions
  ): Promise<SendResult>
  /**
   * 渲染并回复的实现
   * @param first 页面或模板路径
   * @param second TSX 通路为选项，字符串通路为模板数据
   * @param third 字符串通路的选项
   * @returns 发送结果
   */
  async renderReply(
    first: RenderablePage | string,
    second?: Record<string, unknown> | (RenderOptions & ReplyOptions),
    third?: RenderOptions & ReplyOptions
  ): Promise<SendResult> {
    // 选项在两条通路里位置不同：TSX 通路是第二参，字符串通路是第三参。
    // reply 也要用到同一份选项（quote / recallAfter 等），故先归一
    const opts = typeof first === "string" ? third : (second as (RenderOptions & ReplyOptions) | undefined)
    const image =
      typeof first === "string"
        ? await this.render(first, second as Record<string, unknown> | undefined, third)
        : await this.render(first, second as (RenderOptions & ReplyOptions) | undefined)
    return this.reply(image, opts)
  }

  /**
   * 撤回本条消息
   * @returns 是否成功
   */
  async recall(): Promise<boolean> {
    if (!this.bot.caps.has("recall")) return false
    try {
      return await this.bot.recallMessage(this.messageId)
    } catch (err) {
      // 撤回失败是家常便饭（超过 2 分钟、没有管理权限），不值得往上抛
      this.#logger.debug(`撤回消息 ${this.messageId} 失败：${errText(err)}`)
      return false
    }
  }

  /**
   * 等待同一会话的下一条消息
   * @param opts 等待选项
   * @returns 下一条消息事件；超时或插件卸载时 undefined
   */
  async prompt(opts: PromptOptions = {}): Promise<MessageEvent | undefined> {
    if (opts.tip !== undefined) await this.reply(opts.tip)
    const binding = this.#binding
    return this.#prompts.wait({
      key: sessionKeyOf(this),
      uid: this.sender.uid,
      sameUser: opts.sameUser !== false,
      timeout: parseDuration(opts.timeout, DEFAULT_PROMPT_TIMEOUT),
      filter: opts.filter,
      plugin: binding?.name ?? "未知",
      signal: binding?.signal
    })
  }

  /**
   * 剥除开头的机器人昵称
   *
   * 取**最长**匹配而非遍历顺序上的第一个：昵称配置为 `["云", "云崽"]` 时，
   * 先命中 `云` 会将 `云崽帮我看看` 剥为 `崽帮我看看`。一次遍历即可求得最长者，
   * 不必为此排序（昵称列表可能在 WebUI 中随时修改，排序结果无法长期缓存）。
   * @param text 当前纯文本
   * @returns 剥除昵称后的文本；未命中昵称时 undefined
   */
  #stripNickname(text: string): string | undefined {
    if (text === "") return undefined
    let best = ""
    for (const nick of this.#policy.nicknames) {
      if (nick === "" || nick.length <= best.length) continue
      if (text.startsWith(nick)) best = nick
    }
    if (best === "") return undefined
    return text.slice(best.length).replace(NICKNAME_TAIL_RE, "")
  }

  /**
   * 算出回复目标
   * @returns 发送目标
   */
  #computeTarget(): SendTarget {
    switch (this.scene) {
      case "group": {
        const gid = this.group?.gid
        if (gid !== undefined) return { scene: "group", gid }
        break
      }
      case "guild": {
        const ch = this.channel
        if (ch !== undefined) return { scene: "guild", guildId: ch.guildId, channelId: ch.channelId }
        break
      }
      case "private": {
        const gid = this.group?.gid
        // 群临时会话带上来源群号：部分平台（OneBot 的 temp 会话）非它不可发
        return gid === undefined
          ? { scene: "private", uid: this.sender.uid }
          : { scene: "private", uid: this.sender.uid, gid }
      }
    }
    // 适配器声明了场景却没给对应的会话标识，属于适配器 bug。
    // 退化成私聊回给发送者：至少用户能看到回复，而不是静默失败。
    this.#logger.error(
      `事件 ${this.id} 的场景为 ${this.scene} 但缺少${this.scene === "group" ? "群号" : "频道信息"}，` +
        `已退化为私聊回复；请检查适配器 ${this.bot.adapterId}`
    )
    return { scene: "private", uid: this.sender.uid }
  }
}

/**
 * 运行时事件工厂
 *
 * 内核里唯一构造事件的地方。适配器把 `IncomingEvent` 交给 `host.submit()`，
 * 由 dispatch 调这里补全成运行时形态。
 */
export class EventFactory {
  /** 工厂依赖 */
  readonly #opts: EventFactoryOptions

  /**
   * @param opts 构造参数
   */
  constructor(opts: EventFactoryOptions) {
    this.#opts = opts
  }

  /**
   * 按事件大类分派构造
   * @param incoming 适配器产出的事件
   * @param bot 接收该事件的 Bot
   * @returns 运行时事件
   */
  create(incoming: IncomingEvent, bot: BotApi): MessageEvent | NoticeEvent | RequestEvent | MetaEvent {
    switch (incoming.kind) {
      case "message":
        return this.createMessage(incoming, bot)
      case "notice":
        return this.createNotice(incoming, bot)
      case "request":
        return this.createRequest(incoming, bot)
      case "meta":
        return this.createMeta(incoming, bot)
    }
  }

  /**
   * 构造运行时消息事件
   * @param incoming 适配器产出的消息事件
   * @param bot 接收该事件的 Bot
   * @returns 运行时消息事件
   */
  createMessage(incoming: IncomingMessageEvent, bot: BotApi): RuntimeMessageEvent {
    return new MessageEventImpl(incoming, bot, this.#opts)
  }

  /**
   * 构造运行时通知事件
   * @param incoming 适配器产出的通知事件
   * @param bot 接收该事件的 Bot
   * @returns 运行时通知事件
   */
  createNotice(incoming: IncomingNoticeEvent, bot: BotApi): NoticeEvent {
    const target = noticeTargetOf(incoming)
    let stopped = false
    const event = {
      ...incoming,
      id: incoming.id ?? createEventId(),
      time: incoming.time ?? Date.now(),
      platform: bot.platform,
      selfId: bot.selfId,
      bot,
      raw: incoming.raw,
      state: {} as Record<string, unknown>,
      stop(): void {
        stopped = true
      },
      // 写成 getter 而不是普通字段：`stop()` 必须能被下游立刻看见
      get stopped(): boolean {
        return stopped
      },
      /**
       * 就地回复
       * @param content 消息内容
       * @returns 发送结果
       * @throws 该通知没有可回复的会话时
       */
      async reply(content: MessageContent): Promise<SendResult> {
        if (target === undefined) {
          throw new Error(`通知事件 ${incoming.noticeType} 没有可回复的会话（既无群号也无用户 id）`)
        }
        return bot.sendMessage(target, content)
      }
    }
    return event as NoticeEvent
  }

  /**
   * 构造运行时请求事件
   * @param incoming 适配器产出的请求事件
   * @param bot 接收该事件的 Bot
   * @returns 运行时请求事件
   */
  createRequest(incoming: IncomingRequestEvent, bot: BotApi): RequestEvent {
    let stopped = false

    /**
     * 落到平台的同意/拒绝
     *
     * 好友与加群的第三个参数含义不同：好友是"同意后设置的备注"，
     * 加群是"拒绝的理由"。该不对称源自 OneBot，在此处封装以免插件误用。
     * @param approve 是否同意
     * @param extra 备注或理由
     */
    const handle = async (approve: boolean, extra?: string): Promise<void> => {
      if (incoming.requestType === "friend") {
        if (bot.handleFriendRequest === undefined) {
          throw new Error(`账号 ${bot.selfId} 的适配器未实现处理好友请求`)
        }
        await bot.handleFriendRequest(incoming.flag, approve, approve ? extra : undefined)
        return
      }
      if (bot.handleGroupRequest === undefined) {
        throw new Error(`账号 ${bot.selfId} 的适配器未实现处理加群请求`)
      }
      await bot.handleGroupRequest(incoming.flag, approve, approve ? undefined : extra)
    }

    const event = {
      ...incoming,
      id: incoming.id ?? createEventId(),
      time: incoming.time ?? Date.now(),
      platform: bot.platform,
      selfId: bot.selfId,
      bot,
      raw: incoming.raw,
      state: {} as Record<string, unknown>,
      stop(): void {
        stopped = true
      },
      /** 是否已被阻断 */
      get stopped(): boolean {
        return stopped
      },
      /**
       * 同意
       * @param extra 好友请求的备注
       */
      async approve(extra?: string): Promise<void> {
        await handle(true, extra)
      },
      /**
       * 拒绝
       * @param reason 拒绝理由
       */
      async reject(reason?: string): Promise<void> {
        await handle(false, reason)
      }
    }
    return event as RequestEvent
  }

  /**
   * 构造运行时元事件
   * @param incoming 适配器产出的元事件
   * @param bot 接收该事件的 Bot
   * @returns 运行时元事件
   */
  createMeta(incoming: IncomingMetaEvent, bot: BotApi): MetaEvent {
    let stopped = false
    const event = {
      ...incoming,
      id: incoming.id ?? createEventId(),
      time: incoming.time ?? Date.now(),
      platform: bot.platform,
      selfId: bot.selfId,
      bot,
      raw: incoming.raw,
      state: {} as Record<string, unknown>,
      stop(): void {
        stopped = true
      },
      /** 是否已被阻断 */
      get stopped(): boolean {
        return stopped
      }
    }
    return event as MetaEvent
  }
}

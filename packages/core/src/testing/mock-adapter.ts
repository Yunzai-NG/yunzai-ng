/**
 * 模块职责：内存 Mock 适配器 —— 不连接任何平台，在进程内直接收发消息
 * 依赖方向：只依赖 `@yunzai-ng/types` 与 message/segment；不依赖内核其余任何模块，
 *          因此任何一层的测试均可引用它，不会反向将被测模块引入
 * 生命周期：一次 `createMockAdapter()` 对应一个测试用例；驱动实例由内核在连接账号时创建
 * 注意事项：三项设计取舍，使用前应先阅读：
 *
 *          1) **这是真实实现，而非 `vi.fn()` 拼装出的替身对象**。它在编译期即必须满足
 *             `AdapterProvider` / `BotDriver`，因而同时是测试替身与"编写一个新适配器
 *             至少需实现哪些方法"的可执行文档 —— 编写 adapter-napcat 时可直接参照。
 *             以 `as unknown as BotDriver` 强制转换得到的替身对象无法做到这一点：接口新增成员后，
 *             测试仍能编译通过，直至真实适配器上线方发现存在未实现的方法。
 *
 *          2) **投递是单向的，断言必须等待回调**。`host.submit()` 同步返回，内核内部
 *             异步处理（见 kernel/runtime.ts 第 3 步的 `dispatch` 未 await），因此
 *             `await receiveGroup(...)` 无法等到回复，需等待时应使用 `waitForSend()`。
 *
 *          3) **`waitForSend()` 超时会将已发出的内容写入错误信息**。否则 vitest
 *             仅报告一句 "test timed out"，无从区分是命令未匹配、插件抛出错误、
 *             还是回复内容不符 —— 这三种情形的排查方向完全不同。
 */
import type {
  AdapterHost,
  AdapterProvider,
  BotCapability,
  BotDriver,
  ForwardNode,
  GroupInfo,
  GroupRole,
  IncomingEvent,
  IncomingMessageEvent,
  MemberInfo,
  MessageContent,
  SchemaDescriptor,
  Segment,
  SendOptions,
  SendResult,
  SendTarget,
  UserInfo
} from "@yunzai-ng/types"
import { seg, textOf, toSegments } from "../message/segment.js"

/** 缺省适配器 id */
const DEFAULT_ID = "mock"

/** 缺省账号昵称 */
const DEFAULT_NICKNAME = "Mock Bot"

/** 缺省的消息发送者 id */
const DEFAULT_UID = "20000"

/** 缺省群 id */
const DEFAULT_GID = "700000"

/** `waitForSend()` 的缺省等待上限毫秒 */
const DEFAULT_WAIT = 2000

/** 缺省声明的可选能力：撤回与合并转发，正好对应下面真的实现了的两个可选方法 */
const DEFAULT_CAPS: readonly BotCapability[] = ["recall", "forward"]

/**
 * Mock 账号配置
 *
 * 写成 `type` 而不是 `interface` 是必要的：`AdapterProvider<T>` 的默认实参是
 * `Record<string, unknown>`，而 TS 只给**类型别名**隐式索引签名，interface 没有 ——
 * 用 interface 的话 `AdapterProvider<MockAccountConfig>` 赋给 `AdapterProvider`
 * （`ctx.registerAdapter` 的形参类型）会编译不过。
 */
export type MockAccountConfig = {
  /** 账号在"平台"上的 id，会成为 `bot.selfId` */
  selfId: string
  /** 账号昵称 */
  nickname?: string
}

/** 一条被 Mock 记下来的发送 */
export interface SentMessage {
  /** 发出这条消息的账号 selfId */
  selfId: string
  /** 发送目标 */
  target: SendTarget
  /** 已展平的消息段 */
  message: Segment[]
  /** 纯文本视图，断言基本都用它 */
  text: string
  /** 发送选项（内核填的分片/引用信息也在里面） */
  opts: SendOptions | undefined
  /** Mock 生成的消息 id */
  messageId: string
  /** 合并转发的节点；普通消息为 undefined */
  nodes: readonly ForwardNode[] | undefined
}

/** 一次被记下来的原生 API 调用 */
export interface RecordedCall {
  /** API 名 */
  action: string
  /** 参数 */
  params: Record<string, unknown> | undefined
}

/** 构造一条私聊消息的选项 */
export interface MockPrivateOptions {
  /** 发送者 id，缺省 `"20000"` */
  uid?: string
  /** 发送者昵称 */
  name?: string
  /** 直接指定消息段；给了就忽略 `text` 参数 */
  message?: Segment[]
  /** 引用的消息 id */
  quote?: string
  /** 平台细分类型，如 `"friend"` / `"temp"` */
  subType?: string
}

/** 构造一条群消息的选项 */
export interface MockGroupOptions extends MockPrivateOptions {
  /** 群 id，缺省 `"700000"` */
  gid?: string
  /** 发送者在群里的角色，缺省 `"member"`；测 `e.isGroupAdmin` 时改这里 */
  role?: GroupRole
  /** 是否 @ 了机器人：true 时在消息最前面插一个 at 段 */
  atMe?: boolean
}

/**
 * Mock 驱动
 *
 * 除 `BotDriver` 的能力外，多出一组"从平台方向往内核里灌事件"的方法 ——
 * 真适配器里这件事由 socket 回调触发，测试里由这些方法代劳。
 */
export interface MockDriver extends BotDriver {
  /** 内核给这个账号的宿主对象（`kv` / `signal` / `route` 都在上面） */
  readonly host: AdapterHost
  /** 校验后的账号配置 */
  readonly config: MockAccountConfig
  /** `connect()` 被调用过几次，测退避重连用 */
  readonly connects: number
  /** `disconnect()` 被调用过几次 */
  readonly disconnects: number

  /**
   * 投递一个任意事件
   * @param event 已经是通用模型的事件
   */
  receive(event: IncomingEvent): void

  /**
   * 投递一条私聊消息
   * @param text 消息内容，支持裸字符串与嵌套数组
   * @param opts 构造选项
   * @returns 投递出去的那个事件，便于断言 `messageId`
   */
  receivePrivate(text: MessageContent, opts?: MockPrivateOptions): IncomingMessageEvent

  /**
   * 投递一条群消息
   * @param text 消息内容
   * @param opts 构造选项
   * @returns 投递出去的那个事件
   */
  receiveGroup(text: MessageContent, opts?: MockGroupOptions): IncomingMessageEvent

  /**
   * 模拟"连接被对端关闭"
   *
   * 经由 `host.setStatus("offline")`，因此内核会执行完整的下线流程
   * （摘除 Bot 注册表条目、派发 `bot/offline`、安排退避重连），而不仅是修改一个状态字段。
   * @param reason 下线原因，会出现在账号状态里
   */
  goOffline(reason?: string): void
}

/** 创建 Mock 适配器的选项 */
export interface MockAdapterOptions {
  /** 适配器 id，缺省 `"mock"` */
  id?: string
  /** 平台标识，缺省与 id 相同 */
  platform?: string
  /** 本账号声明的可选能力，缺省撤回 + 合并转发 */
  caps?: readonly BotCapability[]
  /**
   * 让 `connect()` 固定失败
   *
   * 给了字符串就以它为错误消息抛出，用来测"连接失败不进 Bot 注册表、
   * 账号状态变 error、排了退避重连"这条路径。
   */
  failConnect?: string
  /**
   * `callApi` 的实现
   *
   * 缺省抛错 —— 内存 Mock 没有"平台原生 API"这回事，静默返回 undefined
   * 只会让依赖它的测试以一个更难懂的形式失败。
   * @param action API 名
   * @param params 参数
   * @returns 平台返回值
   */
  callApi?: (action: string, params?: Record<string, unknown>) => unknown
}

/** Mock 适配器句柄 */
export interface MockAdapter {
  /** 交给 `ctx.registerAdapter()` 的提供方 */
  readonly provider: AdapterProvider<MockAccountConfig>
  /** 已创建的全部驱动，按创建顺序 */
  readonly drivers: readonly MockDriver[]
  /** 全部发送记录（多账号共用一份，按 `selfId` 区分） */
  readonly sent: readonly SentMessage[]
  /** 全部发送记录的纯文本视图 */
  readonly texts: readonly string[]
  /** 被撤回过的消息 id */
  readonly recalled: readonly string[]
  /** 被调用过的原生 API */
  readonly calls: readonly RecordedCall[]

  /**
   * 唯一那个驱动
   *
   * 单账号测试里省一次 `drivers[0]!`。
   * @throws 还没有账号连上来时；错误信息里写了该先调什么
   */
  readonly driver: MockDriver

  /**
   * 等到累计发出了 `count` 条消息
   *
   * @param count 期望的累计条数，缺省 1
   * @param timeoutMs 等待上限，缺省 2000
   * @returns 前 `count` 条发送记录
   * @throws 超时；错误信息里带上实际已发出的内容
   */
  waitForSend(count?: number, timeoutMs?: number): Promise<readonly SentMessage[]>

  /**
   * 最后一条发送记录
   * @returns 发送记录；一条都没发过时 undefined
   */
  last(): SentMessage | undefined

  /** 清空发送/撤回/调用记录（驱动本身保留） */
  reset(): void
}

/** 账号配置的表单描述，WebUI 的"添加账号"表单由它生成 */
const ACCOUNT_SCHEMA: SchemaDescriptor = {
  type: "object",
  title: "内存 Mock 账号",
  properties: {
    selfId: {
      type: "string",
      title: "账号 id",
      description: "该字段取值任意，Mock 适配器不执行实际登录",
      default: "10000",
      required: true,
      placeholder: "10000"
    },
    nickname: {
      type: "string",
      title: "昵称",
      default: DEFAULT_NICKNAME
    }
  }
}

/**
 * 一个等待发送的挂起请求
 *
 * 拆成具名结构而不是直接存 resolve 函数，是因为 `notify()` 要能读到它等的条数。
 */
interface Waiter {
  /** 期望的累计发送条数 */
  count: number
  /** 条件满足时调用 */
  wake: () => void
}

/**
 * 创建一个内存 Mock 适配器
 *
 * 典型用法（完整例子见 kernel/runtime.test.ts）：
 * ```ts
 * const mock = createMockAdapter()
 * app.runtime.adapters.register(mock.provider, "test-plugin")
 * await app.runtime.accounts.create("mock", { selfId: "10000" })
 * mock.driver.receivePrivate("#ping")
 * const [reply] = await mock.waitForSend()
 * ```
 * @param opts 选项
 * @returns Mock 适配器句柄
 */
export function createMockAdapter(opts: MockAdapterOptions = {}): MockAdapter {
  const id = opts.id ?? DEFAULT_ID
  const platform = opts.platform ?? id
  const caps: ReadonlySet<BotCapability> = new Set(opts.caps ?? DEFAULT_CAPS)

  /** 发送记录 */
  const sent: SentMessage[] = []
  /** 撤回记录 */
  const recalled: string[] = []
  /** 原生 API 调用记录 */
  const calls: RecordedCall[] = []
  /** 已创建的驱动 */
  const drivers: MockDriver[] = []
  /** 挂起的 `waitForSend()` */
  const waiters = new Set<Waiter>()
  /** 自增序号，用来生成消息 id；不用时间戳是为了让断言可预期 */
  let counter = 0

  /**
   * 取下一个消息 id
   * @returns 形如 `mock-msg-1` 的 id
   */
  const nextId = (): string => {
    counter += 1
    return `${id}-msg-${counter}`
  }

  /** 唤醒条件已满足的等待者 */
  const notify = (): void => {
    for (const waiter of [...waiters]) {
      if (sent.length >= waiter.count) {
        waiters.delete(waiter)
        waiter.wake()
      }
    }
  }

  /**
   * 记一条发送
   * @param selfId 发出者
   * @param target 目标
   * @param message 消息段
   * @param sendOpts 发送选项
   * @param nodes 合并转发节点
   * @returns 发送结果
   */
  const record = (
    selfId: string,
    target: SendTarget,
    message: Segment[],
    sendOpts: SendOptions | undefined,
    nodes?: readonly ForwardNode[]
  ): SendResult => {
    const messageId = nextId()
    sent.push({ selfId, target, message, text: textOf(message), opts: sendOpts, messageId, nodes })
    notify()
    return { ok: true, messageId, time: Date.now() }
  }

  /**
   * 造一个 Mock 驱动
   * @param config 账号配置
   * @param host 内核给的宿主
   * @returns 驱动
   */
  const createDriver = (config: MockAccountConfig, host: AdapterHost): MockDriver => {
    const selfId = config.selfId
    const nickname = config.nickname ?? DEFAULT_NICKNAME
    /** 是否在线 */
    let online = false
    /** connect 次数 */
    let connects = 0
    /** disconnect 次数 */
    let disconnects = 0

    /**
     * 造一个群成员
     * @param gid 群 id
     * @param uid 用户 id
     * @param role 角色
     * @returns 成员信息
     */
    const member = (gid: string, uid: string, role: GroupRole = "member"): MemberInfo => ({
      uid,
      gid,
      role,
      name: uid === selfId ? nickname : `用户${uid}`
    })

    const driver: MockDriver = {
      host,
      config,
      selfId,
      platform,
      adapterId: id,
      nickname,
      caps,

      get online(): boolean {
        return online
      },
      get connects(): number {
        return connects
      },
      get disconnects(): number {
        return disconnects
      },

      async connect(): Promise<void> {
        connects += 1
        if (opts.failConnect !== undefined) throw new Error(opts.failConnect)
        online = true
        return Promise.resolve()
      },

      async disconnect(): Promise<void> {
        disconnects += 1
        online = false
        return Promise.resolve()
      },

      async sendMessage(target: SendTarget, content: MessageContent, sendOpts?: SendOptions): Promise<SendResult> {
        return Promise.resolve(record(selfId, target, toSegments(content), sendOpts))
      },

      async sendForward(target: SendTarget, nodes: ForwardNode[]): Promise<SendResult> {
        // 转发的文本视图取各节点正文拼接，以使 `texts` 断言对转发同样有效
        const flat = nodes.flatMap(node => node.message ?? [])
        return Promise.resolve(record(selfId, target, flat, undefined, nodes))
      },

      async recallMessage(messageId: string): Promise<boolean> {
        recalled.push(messageId)
        return Promise.resolve(true)
      },

      async getSelfInfo(): Promise<UserInfo> {
        return Promise.resolve({ uid: selfId, name: nickname })
      },

      async getFriend(uid: string): Promise<UserInfo | undefined> {
        return Promise.resolve({ uid, name: `用户${uid}` })
      },

      async getFriendList(): Promise<UserInfo[]> {
        return Promise.resolve([{ uid: DEFAULT_UID, name: `用户${DEFAULT_UID}` }])
      },

      async getGroup(gid: string): Promise<GroupInfo | undefined> {
        return Promise.resolve({ gid, name: `Mock 群 ${gid}`, memberCount: 2 })
      },

      async getGroupList(): Promise<GroupInfo[]> {
        return Promise.resolve([{ gid: DEFAULT_GID, name: `Mock 群 ${DEFAULT_GID}`, memberCount: 2 }])
      },

      async getGroupMember(gid: string, uid: string): Promise<MemberInfo | undefined> {
        return Promise.resolve(member(gid, uid))
      },

      async getGroupMemberList(gid: string): Promise<MemberInfo[]> {
        return Promise.resolve([member(gid, selfId), member(gid, DEFAULT_UID)])
      },

      async callApi<T>(action: string, params?: Record<string, unknown>): Promise<T> {
        calls.push({ action, params })
        if (!opts.callApi) {
          throw new Error(
            `内存 Mock 适配器没有平台原生 API（收到调用 ${action}）；需要的话给 createMockAdapter 传 callApi`
          )
        }
        return (await opts.callApi(action, params)) as T
      },

      receive(event: IncomingEvent): void {
        host.submit(event)
      },

      receivePrivate(text: MessageContent, o: MockPrivateOptions = {}): IncomingMessageEvent {
        const uid = o.uid ?? DEFAULT_UID
        const event: IncomingMessageEvent = {
          kind: "message",
          scene: "private",
          subType: o.subType ?? "friend",
          messageId: nextId(),
          message: o.message ?? toSegments(text),
          sender: { uid, name: o.name ?? `用户${uid}` }
        }
        if (o.quote !== undefined) event.quote = { messageId: o.quote }
        host.submit(event)
        return event
      },

      receiveGroup(text: MessageContent, o: MockGroupOptions = {}): IncomingMessageEvent {
        const gid = o.gid ?? DEFAULT_GID
        const uid = o.uid ?? DEFAULT_UID
        const body = o.message ?? toSegments(text)
        const event: IncomingMessageEvent = {
          kind: "message",
          scene: "group",
          subType: o.subType ?? "normal",
          messageId: nextId(),
          message: o.atMe === true ? [seg.at(selfId), ...body] : body,
          sender: { uid, gid, role: o.role ?? "member", name: o.name ?? `用户${uid}` },
          group: { gid, name: `Mock 群 ${gid}` }
        }
        if (o.quote !== undefined) event.quote = { messageId: o.quote }
        host.submit(event)
        return event
      },

      goOffline(reason?: string): void {
        online = false
        host.setStatus("offline", { error: reason ?? "Mock 主动下线" })
      }
    }

    return driver
  }

  const provider: AdapterProvider<MockAccountConfig> = {
    id,
    name: "内存 Mock 适配器",
    description: "不连任何平台，事件由测试代码直接灌进来",
    platform,
    accountSchema: ACCOUNT_SCHEMA,

    validateAccount(input: unknown): MockAccountConfig {
      if (typeof input !== "object" || input === null) throw new Error("Mock 账号配置必须是一个对象")
      const raw = input as Record<string, unknown>
      const selfId = raw.selfId
      if (typeof selfId !== "string" || selfId === "") throw new Error("Mock 账号配置缺少 selfId")
      const nickname = raw.nickname
      return { selfId, nickname: typeof nickname === "string" ? nickname : DEFAULT_NICKNAME }
    },

    createBot(account: MockAccountConfig, host: AdapterHost): BotDriver {
      const driver = createDriver(account, host)
      drivers.push(driver)
      return driver
    }
  }

  return {
    provider,
    drivers,
    sent,
    recalled,
    calls,

    get texts(): readonly string[] {
      return sent.map(item => item.text)
    },

    get driver(): MockDriver {
      const first = drivers[0]
      if (!first) throw new Error("还没有 Mock 驱动：先注册 provider 再 accounts.create()，且要等 create() 返回")
      return first
    },

    async waitForSend(count = 1, timeoutMs = DEFAULT_WAIT): Promise<readonly SentMessage[]> {
      if (sent.length < count) {
        await new Promise<void>((resolve, reject) => {
          // wake 要清定时器、定时器要摘等待者，两边互相引用；用一个小盒子打断这个循环
          const box: { timer?: ReturnType<typeof setTimeout> } = {}
          const waiter: Waiter = {
            count,
            wake: () => {
              clearTimeout(box.timer)
              resolve()
            }
          }
          box.timer = setTimeout(() => {
            waiters.delete(waiter)
            // 附带已发出的内容：见文件头第 3 条
            const got = sent.length === 0 ? "（尚无任何发送）" : sent.map(item => JSON.stringify(item.text)).join("、")
            reject(new Error(`等待第 ${count} 条发送超过 ${timeoutMs}ms 仍未到达，目前已发出 ${sent.length} 条：${got}`))
          }, timeoutMs)
          // 用例断言完毕后，该定时器不应继续阻塞 vitest 的收尾流程
          box.timer.unref?.()
          waiters.add(waiter)
        })
      }
      return sent.slice(0, count)
    },

    last(): SentMessage | undefined {
      return sent[sent.length - 1]
    },

    reset(): void {
      sent.length = 0
      recalled.length = 0
      calls.length = 0
      counter = 0
    }
  }
}

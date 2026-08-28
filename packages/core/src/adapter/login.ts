/**
 * 模块职责：交互式登录会话（实现 `LoginSession`）与登录会话管理器
 * 依赖方向：依赖类型包与 util/*；通过注入的回调创建账号，**不认识账号管理器**
 * 生命周期：一次登录一个会话；成功/失败/取消后短暂留存供 WebUI 展示结果，然后自毁
 * 注意事项：内核不知道扫码、短信验证码、填 token 有什么区别，只提供两个原语：**推一步给用户看**
 *          （`push`）与**等用户答一次**（`ask`）。扫码是 push(qrcode) + push(progress)，短信是
 *          ask(手机号) + ask(验证码) —— 故前端不必为每个新平台改一行代码。三处必须做对：
 *
 *          **`start()` 同步返回。** 登录要等用户操作、动辄几十秒，HTTP 请求不能挂在那儿，故
 *          `login()` 在后台跑，前端拿会话 id 去轮询或订阅。
 *
 *          **`ask` 带序号。** 用户连点两次提交或网络重发时，迟到的那次答复不能拿去满足**下一个**
 *          问题（把手机号填进验证码框），故 `answer()` 必须带 `seq`，对不上就拒绝。
 *
 *          **一切都有上限**：步骤数、每次提问的超时、整个会话的 TTL，结束即自毁 —— 一个人点开
 *          登录页就走开，不该留下一个永远挂着的 promise 和一张常驻内存的二维码。
 */
import type {
  AccountRecord,
  AdapterRegistryView,
  LoginPrompt,
  LoginSession,
  LoginStep,
  Logger
} from "@yunzai-ng/types"
import { parseDuration } from "../util/duration.js"
import { createEventId } from "../util/id.js"

/** 单次提问的缺省超时（毫秒），与 `LoginPrompt.timeout` 文档一致 */
export const DEFAULT_LOGIN_PROMPT_TIMEOUT = 180_000

/** 整个登录会话的硬上限（毫秒）：扫码最多两三分钟，十分钟足够宽裕 */
export const DEFAULT_LOGIN_TTL = 600_000

/** 已结束的会话保留多久供前端读取结果（毫秒） */
const RESULT_TTL = 120_000

/** 步骤数组上限：`progress` 刷屏或反复刷新二维码时不能无限增长 */
const MAX_STEPS = 40

/** 登录会话状态 */
export type LoginStatus = "running" | "done" | "failed" | "cancelled"

/** 正在等待用户回答的提问 */
export interface PendingPrompt {
  /** 提问序号，回答时必须带回 */
  readonly seq: number
  /** 提问内容 */
  readonly prompt: LoginPrompt
  /** 超时时刻（毫秒时间戳），前端据此显示倒计时 */
  readonly deadline: number
}

/** 登录会话快照，WebUI 的唯一数据来源 */
export interface LoginSnapshot {
  /** 会话 id */
  readonly id: string
  /** 适配器 id */
  readonly adapterId: string
  /** 登录方式 id */
  readonly mode: string
  /** 当前状态 */
  readonly status: LoginStatus
  /** 已推送的步骤，按时间顺序 */
  readonly steps: readonly LoginStep[]
  /** 正在等待的提问；没有则 undefined */
  readonly pending: PendingPrompt | undefined
  /** 失败原因 */
  readonly error: string | undefined
  /** 成功时创建出的账号记录 id */
  readonly accountId: string | undefined
  /** 开始时刻（毫秒时间戳） */
  readonly startedAt: number
  /** 最后变化时刻（毫秒时间戳），前端据此判断是否需要重绘 */
  readonly updatedAt: number
}

/** 登录管理器构造参数 */
export interface LoginManagerOptions {
  /** 日志器 */
  readonly logger: Logger
  /** 适配器注册表视图 */
  readonly adapters: AdapterRegistryView
  /**
   * 登录成功后落账号
   *
   * 注入而非直接依赖账号管理器：否则 login → accounts → login 就绕成环了。
   * @param adapterId 适配器 id
   * @param config 登录产出的账号配置
   * @param label 账号备注名
   * @returns 新建的账号记录
   */
  readonly createAccount: (adapterId: string, config: Record<string, unknown>, label?: string) => Promise<AccountRecord>
  /** 会话硬上限，缺省 `DEFAULT_LOGIN_TTL` */
  readonly ttl?: number
}

/** 会话内部状态 */
interface SessionState {
  /** 会话 id */
  readonly id: string
  /** 适配器 id */
  readonly adapterId: string
  /** 登录方式 */
  readonly mode: string
  /** 账号备注名 */
  readonly label: string | undefined
  /** 取消信号源 */
  readonly controller: AbortController
  /** 已推送步骤 */
  readonly steps: LoginStep[]
  /** 当前状态 */
  status: LoginStatus
  /** 正在等待的提问 */
  pending: PendingPrompt | undefined
  /** 交付答复 */
  resolveAsk: ((value: unknown) => void) | undefined
  /** 终止等待 */
  rejectAsk: ((err: Error) => void) | undefined
  /** 会话 TTL 定时器 */
  ttlTimer: NodeJS.Timeout | undefined
  /** 结束后自毁定时器 */
  reapTimer: NodeJS.Timeout | undefined
  /** 提问序号发号器 */
  seq: number
  /** 失败原因 */
  error: string | undefined
  /** 成功创建的账号 id */
  accountId: string | undefined
  /** 开始时刻 */
  readonly startedAt: number
  /** 最后变化时刻 */
  updatedAt: number
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
 * 交互式登录会话管理器
 *
 * WebUI 侧的用法：`start()` 拿到 id → 轮询/订阅 `snapshot(id)` → 遇到
 * `pending` 就渲染输入框，用户提交后 `answer(id, seq, value)` → 直到
 * `status` 不再是 `running`。
 */
export class LoginManager {
  /** 日志器 */
  readonly #logger: Logger
  /** 适配器注册表 */
  readonly #adapters: AdapterRegistryView
  /** 账号创建回调 */
  readonly #createAccount: LoginManagerOptions["createAccount"]
  /** 会话硬上限 */
  readonly #ttl: number
  /** 会话 id → 状态 */
  readonly #sessions = new Map<string, SessionState>()

  /**
   * @param opts 构造参数
   */
  constructor(opts: LoginManagerOptions) {
    this.#logger = opts.logger.child({ scope: "login" })
    this.#adapters = opts.adapters
    this.#createAccount = opts.createAccount
    this.#ttl = opts.ttl ?? DEFAULT_LOGIN_TTL
  }

  /** 进行中的会话数 */
  get running(): number {
    let n = 0
    for (const s of this.#sessions.values()) if (s.status === "running") n++
    return n
  }

  /**
   * 开始一次交互式登录
   *
   * **同步返回**，登录流程在后台跑，见文件头第 1 点。
   * @param adapterId 适配器 id
   * @param mode 登录方式 id
   * @param label 账号备注名
   * @returns 初始快照
   * @throws 适配器不存在、不支持交互式登录、或方式 id 无效时
   */
  start(adapterId: string, mode: string, label?: string): LoginSnapshot {
    const provider = this.#adapters.get(adapterId)
    if (provider === undefined) throw new Error(`适配器 ${adapterId} 未注册：请先安装并启用对应的适配器插件`)

    const login = provider.login
    if (login === undefined) {
      throw new Error(`适配器 ${provider.name} 不支持交互式登录，请在"添加账号"里直接填写配置`)
    }

    const modes = provider.loginModes ?? []
    if (modes.length > 0 && !modes.some(m => m.id === mode)) {
      const names = modes.map(m => `${m.id}(${m.name})`).join("、")
      throw new Error(`适配器 ${provider.name} 没有名为 ${mode} 的登录方式，可用：${names}`)
    }

    const id = createEventId("login")
    const now = Date.now()
    const state: SessionState = {
      id,
      adapterId,
      mode,
      label,
      controller: new AbortController(),
      steps: [],
      status: "running",
      pending: undefined,
      resolveAsk: undefined,
      rejectAsk: undefined,
      ttlTimer: undefined,
      reapTimer: undefined,
      seq: 0,
      error: undefined,
      accountId: undefined,
      startedAt: now,
      updatedAt: now
    }
    this.#sessions.set(id, state)

    state.ttlTimer = setTimeout(() => {
      this.#abort(state, `登录超时（超过 ${Math.round(this.#ttl / 1000)} 秒未完成）`, "failed")
    }, this.#ttl)
    state.ttlTimer.unref?.()

    const session = this.#createSession(state)
    this.#logger.info(`开始登录：适配器 ${adapterId}，方式 ${mode}，会话 ${id}`)

    // 后台跑：不 await，也不让它的 rejection 冒成 unhandledRejection
    void login(session, mode).then(
      config => void this.#succeed(state, config),
      (err: unknown) => this.#fail(state, err)
    )

    return this.snapshotOf(state)
  }

  /**
   * 读一个会话的快照
   * @param id 会话 id
   * @returns 快照；会话不存在（或已自毁）时 undefined
   */
  snapshot(id: string): LoginSnapshot | undefined {
    const state = this.#sessions.get(id)
    return state === undefined ? undefined : this.snapshotOf(state)
  }

  /**
   * 列出全部会话
   * @returns 快照数组，按开始时间
   */
  list(): LoginSnapshot[] {
    return [...this.#sessions.values()].map(s => this.snapshotOf(s))
  }

  /**
   * 提交用户的答复
   * @param id 会话 id
   * @param seq 提问序号，必须与 `pending.seq` 一致
   * @param value 用户输入
   * @returns 是否被接受
   */
  answer(id: string, seq: number, value: unknown): boolean {
    const state = this.#sessions.get(id)
    if (state === undefined || state.status !== "running") return false
    const pending = state.pending
    if (pending === undefined) return false
    // 序号不符即丢弃：见文件头第 2 点
    if (pending.seq !== seq) {
      this.#logger.debug(`会话 ${id} 收到过期答复（seq ${seq}，当前 ${pending.seq}），已忽略`)
      return false
    }
    state.resolveAsk?.(value)
    return true
  }

  /**
   * 取消一个会话
   * @param id 会话 id
   * @returns 是否取消成功（会话不存在或已结束时 false）
   */
  cancel(id: string): boolean {
    const state = this.#sessions.get(id)
    if (state === undefined || state.status !== "running") return false
    this.#abort(state, "用户取消了登录", "cancelled")
    return true
  }

  /** 取消全部会话并清理（停机时调用） */
  stop(): void {
    for (const state of [...this.#sessions.values()]) {
      if (state.status === "running") this.#abort(state, "内核正在停止", "cancelled")
      if (state.ttlTimer !== undefined) clearTimeout(state.ttlTimer)
      if (state.reapTimer !== undefined) clearTimeout(state.reapTimer)
    }
    this.#sessions.clear()
  }

  /**
   * 生成快照
   * @param state 会话状态
   * @returns 快照
   */
  snapshotOf(state: SessionState): LoginSnapshot {
    return {
      id: state.id,
      adapterId: state.adapterId,
      mode: state.mode,
      status: state.status,
      // 复制数组：前端持有的快照不该跟着后续 push 变化，否则"这一帧看到了什么"
      // 就说不清了。步骤有上限，复制成本可控。
      steps: [...state.steps],
      pending: state.pending,
      error: state.error,
      accountId: state.accountId,
      startedAt: state.startedAt,
      updatedAt: state.updatedAt
    }
  }

  /**
   * 造出交给适配器的 `LoginSession`
   * @param state 会话状态
   * @returns 登录会话
   */
  #createSession(state: SessionState): LoginSession {
    const logger = this.#logger.child({ session: state.id })
    return {
      id: state.id,
      logger,
      signal: state.controller.signal,

      push: (step: LoginStep): void => {
        if (state.status !== "running") return
        const steps = state.steps
        const last = steps[steps.length - 1]
        // 进度覆盖上一条进度：否则一个每秒 push 一次的适配器将累积出数百条
        // 只有最后一条有意义的记录
        if (step.type === "progress" && last?.type === "progress") steps[steps.length - 1] = step
        else steps.push(step)
        // 超出上限丢最旧的：二维码可能是几十 KB 的 base64，不能无限累积
        while (steps.length > MAX_STEPS) steps.shift()
        state.updatedAt = Date.now()
      },

      ask: <T = string>(prompt: LoginPrompt): Promise<T> => this.#ask<T>(state, prompt)
    }
  }

  /**
   * 等待一次用户输入
   *
   * 与 `pipeline/prompt.ts` 同构：超时、会话取消、用户答复三个终止条件
   * 都汇到一个只许生效一次的 `settle` 上。
   * @param state 会话状态
   * @param prompt 提问内容
   * @returns 用户输入
   * @throws 超时、被取消、或适配器并发提问时
   */
  #ask<T>(state: SessionState, prompt: LoginPrompt): Promise<T> {
    if (state.status !== "running") return Promise.reject(new Error("登录会话已结束，不能再提问"))
    if (state.pending !== undefined) {
      // 前端一次只渲染一个输入框，同时问两个问题必然有一个永远收不到答复
      return Promise.reject(new Error("上一次提问还没得到答复：登录流程必须串行提问"))
    }

    const ms = parseDuration(prompt.timeout, DEFAULT_LOGIN_PROMPT_TIMEOUT)
    const seq = ++state.seq

    return new Promise<T>((resolve, reject) => {
      let done = false
      let timer: NodeJS.Timeout | undefined

      /** 统一收尾 */
      const settle = (fn: () => void): void => {
        if (done) return
        done = true
        if (timer !== undefined) clearTimeout(timer)
        state.pending = undefined
        state.resolveAsk = undefined
        state.rejectAsk = undefined
        state.updatedAt = Date.now()
        fn()
      }

      state.pending = { seq, prompt, deadline: Date.now() + ms }
      state.resolveAsk = (value: unknown): void => settle(() => resolve(value as T))
      state.rejectAsk = (err: Error): void => settle(() => reject(err))
      state.updatedAt = Date.now()

      if (ms > 0) {
        timer = setTimeout(() => {
          settle(() => reject(new Error(`等待"${prompt.label}"超时`)))
        }, ms)
        timer.unref?.()
      }
    })
  }

  /**
   * 中止一个会话
   * @param state 会话状态
   * @param reason 原因
   * @param status 终态
   */
  #abort(state: SessionState, reason: string, status: LoginStatus): void {
    if (state.status !== "running") return
    // 先落终态再 abort：适配器的 catch 里可能回读 snapshot，看到的应该是终态
    state.status = status
    state.error = reason
    state.updatedAt = Date.now()
    state.rejectAsk?.(new Error(reason))
    state.controller.abort()
    this.#finish(state)
    this.#logger.info(`登录会话 ${state.id} 结束：${reason}`)
  }

  /**
   * 登录成功：落账号
   * @param state 会话状态
   * @param config 登录产出的账号配置
   */
  async #succeed(state: SessionState, config: Record<string, unknown>): Promise<void> {
    if (state.status !== "running") return
    try {
      const record = await this.#createAccount(state.adapterId, config, state.label)
      state.accountId = record.id
      state.status = "done"
      state.updatedAt = Date.now()
      this.#finish(state)
      this.#logger.info(`登录成功：会话 ${state.id} → 账号 ${record.id}`)
    } catch (err) {
      // 登录本身成功了但存不下来（磁盘满、配置校验不过），这仍然是失败：
      // 让用户看到原因，而不是一个"成功了但列表里没有"的账号
      this.#fail(state, err)
    }
  }

  /**
   * 登录失败
   * @param state 会话状态
   * @param err 错误
   */
  #fail(state: SessionState, err: unknown): void {
    // 已被取消/超时的会话不要把状态改成 failed —— 用户点了取消，
    // 适配器随后抛出的 AbortError 只是取消的回声
    if (state.status !== "running") return
    state.status = "failed"
    state.error = errText(err)
    state.updatedAt = Date.now()
    state.controller.abort()
    this.#finish(state)
    this.#logger.warn(`登录失败：会话 ${state.id}：${state.error}`)
  }

  /**
   * 结束善后：停 TTL、安排自毁
   * @param state 会话状态
   */
  #finish(state: SessionState): void {
    if (state.ttlTimer !== undefined) {
      clearTimeout(state.ttlTimer)
      state.ttlTimer = undefined
    }
    if (state.reapTimer !== undefined) return
    // 保留一段时间供前端读取结果，之后自毁 —— 否则一个长期运行的实例将累积
    // 无数条历史登录记录（每条都可能挂着一张二维码）
    state.reapTimer = setTimeout(() => {
      this.#sessions.delete(state.id)
    }, RESULT_TTL)
    state.reapTimer.unref?.()
  }
}

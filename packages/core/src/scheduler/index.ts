/**
 * 模块职责：定时任务调度器 —— 实现 `TaskSink`，兼作 WebUI 的任务查询表
 * 依赖方向：依赖类型包、plugin/hooks 的接缝定义、util/*、croner；**不认识任何插件实现**
 * 生命周期：随内核创建；每个任务随注册插件卸载而注销；`stop()` 停机时清空
 * 注意事项：每个任务都是注册表里的一行：`list()` 可查、Disposer 可注销、`stop()` 一次清空 ——
 *          插件各自 `setInterval` 的话，热重载后会残留无人回收的定时器。四项刻意的选择：
 *
 *          **重叠策略自己实现，不用 croner 的 `protect`。** 那个只对 cron 生效，而 `interval`
 *          走 `setInterval`；两条路各用一套判定会让 `overlap` 的语义随 `kind` 漂移。
 *
 *          **`queue` 策略有积压上限。** 一个每分钟触发、每次跑十分钟的任务会排出无限长的队列，
 *          超过 `MAX_QUEUE` 者丢弃并计入 `skipped`。
 *
 *          **超时后不再无限等待。** 先 abort 让守约定的任务自行收尾，但任务可能不响应 signal
 *          （同步死循环、不收 signal 的第三方调用）。只 abort 而不停止等待会让 `running` 永久为
 *          true，此后每轮都被跳过 —— 看着还在跑，实则再也不会触发。故宽限 `ABORT_GRACE` 后
 *          停止等待，并记 error。
 *
 *          **执行出错同样计为已执行。** `lastRun` 在开始时就写，不等成功 —— 隐去失败的那次会让
 *          人误认为调度器没工作。
 */
import type { Disposer, Logger, TaskFn, TaskInfo, TaskOptions } from "@yunzai-ng/types"
import { Cron } from "croner"
import type { TaskRegistration, TaskSink } from "../plugin/hooks.js"
import { TimeoutError, withTimeout } from "../util/defer.js"
import { formatDuration, parseDuration } from "../util/duration.js"

/** `queue` 策略下的积压上限，见文件头第 2 点 */
const MAX_QUEUE = 3

/** 超时 abort 之后再宽限多久才放弃等待（毫秒），见文件头第 3 点 */
const ABORT_GRACE = 5_000

/** 触发器：cron 与 interval 两种实现的共同外壳 */
interface Job {
  /**
   * 下次触发时刻
   * @returns 毫秒时间戳；不会再触发时 undefined
   */
  nextRun(): number | undefined
  /** 停止触发 */
  stop(): void
}

/** 单个任务的运行时状态（`TaskInfo` 的数据来源） */
interface TaskState {
  /** 上次开跑时刻（毫秒时间戳） */
  lastRun: number | undefined
  /** 上次耗时（毫秒） */
  lastCost: number | undefined
  /** 是否正在执行 */
  running: boolean
  /** 累计跳过次数 */
  skipped: number
  /** 当前积压的待执行轮数（仅 `queue` 策略会大于 0） */
  queued: number
}

/** 注册表内部条目 */
interface TaskEntry {
  /** 所属插件名 */
  readonly plugin: string
  /** 任务名 */
  readonly name: string
  /** 人类可读的调度说明 */
  readonly schedule: string
  /** 运行时状态 */
  readonly state: TaskState
  /** 触发器 */
  readonly job: Job
}

/** 调度器构造参数 */
export interface SchedulerOptions {
  /** 基础日志器 */
  readonly logger: Logger
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
 * 定时任务调度器
 *
 * 既是 `ctx.cron()` / `ctx.interval()` 的落点（`TaskSink`），也是 WebUI
 * "定时任务"页面的数据来源（`list()`）。
 */
export class Scheduler implements TaskSink {
  /** 日志器 */
  readonly #logger: Logger
  /** 全部任务，按登记顺序 */
  readonly #entries: TaskEntry[] = []
  /** 是否已停机：停机后不再接受新任务 */
  #stopped = false

  /**
   * @param opts 构造参数
   */
  constructor(opts: SchedulerOptions) {
    this.#logger = opts.logger.child({ scope: "scheduler" })
  }

  /** 当前登记的任务数 */
  get size(): number {
    return this.#entries.length
  }

  /**
   * 登记一个任务
   * @param reg 登记内容
   * @returns 注销句柄
   * @throws cron 表达式非法、或 interval 间隔非法时
   */
  register(reg: TaskRegistration): Disposer {
    const options = reg.options
    const state: TaskState = { lastRun: undefined, lastCost: undefined, running: false, skipped: 0, queued: 0 }

    // 间隔任务允许写 "5m" 这类字符串：插件作者不该为了 ctx.interval 去手算毫秒
    const intervalMs = reg.kind === "interval" ? parseDuration(reg.schedule, 0) : 0
    const schedule = reg.kind === "interval" ? `每 ${formatDuration(intervalMs)}` : String(reg.schedule)
    const name = options.name ?? schedule
    const logger = this.#logger.child({ task: name, plugin: reg.plugin })

    const runner = this.#createRunner(name, reg.fn, options, state, logger)

    let job: Job
    if (reg.kind === "interval") {
      // 上界是 setInterval 的 32 位溢出点：超过它 Node 会立刻、反复触发，
      // 与"每 25 天跑一次"的意图正好相反
      if (!Number.isFinite(intervalMs) || intervalMs <= 0 || intervalMs > 2_147_483_647) {
        throw new Error(`任务 ${name} 的间隔非法（${String(reg.schedule)}）：必须是 1 毫秒到 24.8 天之间的时长`)
      }
      if (intervalMs < 1_000) logger.warn(`任务 ${name} 的间隔只有 ${intervalMs}ms，请确认这是有意的`)
      job = createIntervalJob(intervalMs, runner)
    } else {
      job = createCronJob(String(reg.schedule), options.timezone, runner, name)
    }

    const entry: TaskEntry = { plugin: reg.plugin, name, schedule, state, job }

    // 停机之后仍有插件在登记任务：不能默默持有一个永不回收的定时器，
    // 直接停掉并返回空 Disposer，与 DisposalRegistry 的同类处理保持一致
    if (this.#stopped) {
      job.stop()
      logger.debug(`调度器已停止，任务 ${name} 不再启动`)
      return () => {}
    }

    this.#entries.push(entry)
    this.#logger.info(`任务已登记：${name}（${schedule}，来自插件 ${reg.plugin}）`)

    // 立即执行一次也走 runner：它内部不 await，所以不会拖慢插件 setup
    if (options.immediate === true) runner()

    return () => {
      const at = this.#entries.indexOf(entry)
      if (at < 0) return
      this.#entries.splice(at, 1)
      job.stop()
      // 已在跑的那一轮不会被打断（没有安全的中断手段），但积压一律作废：
      // 插件都卸载了，再补跑几轮只会去操作已经回收掉的资源
      state.queued = 0
      logger.debug(`任务已注销：${name}`)
    }
  }

  /**
   * 列出全部任务
   * @returns 任务信息数组，按登记顺序
   */
  list(): TaskInfo[] {
    return this.#entries.map(entry => ({
      name: entry.name,
      schedule: entry.schedule,
      plugin: entry.plugin,
      nextRun: entry.job.nextRun(),
      lastRun: entry.state.lastRun,
      lastCost: entry.state.lastCost,
      running: entry.state.running,
      skipped: entry.state.skipped
    }))
  }

  /**
   * 注销某插件的全部任务
   *
   * 兜底路径：插件上下文正常会逐条调 Disposer，但插件 setup 抛在半路时
   * 可能有登记没走 ctx。
   * @param plugin 插件名
   * @returns 注销的任务数
   */
  removePlugin(plugin: string): number {
    let n = 0
    // 自后向前删除：正序遍历会因 splice 改变下标而遗漏相邻的同名任务
    for (let i = this.#entries.length - 1; i >= 0; i--) {
      const entry = this.#entries[i]
      if (entry === undefined || entry.plugin !== plugin) continue
      this.#entries.splice(i, 1)
      entry.job.stop()
      entry.state.queued = 0
      n++
    }
    if (n > 0) this.#logger.debug(`已注销插件 ${plugin} 的 ${n} 个任务`)
    return n
  }

  /** 停止全部任务（停机时调用） */
  stop(): void {
    this.#stopped = true
    for (const entry of this.#entries) {
      entry.job.stop()
      entry.state.queued = 0
    }
    this.#entries.length = 0
  }

  /**
   * 造出任务的触发回调
   *
   * 重叠策略、超时、错误处理全在这里，因此 cron 与 interval 两种触发器
   * 的行为完全一致，见文件头第 1 点。
   * @param name 任务名
   * @param fn 任务体
   * @param options 任务选项
   * @param state 运行时状态
   * @param logger 任务日志器
   * @returns 触发回调（同步返回，不会向触发器抛错）
   */
  #createRunner(name: string, fn: TaskFn, options: TaskOptions, state: TaskState, logger: Logger): () => void {
    const timeoutMs = parseDuration(options.timeout, 0)
    const queueing = options.overlap === "queue"

    /** 跑一轮，永不 reject */
    const once = async (): Promise<void> => {
      const controller = new AbortController()
      const started = Date.now()
      state.lastRun = started

      let timer: NodeJS.Timeout | undefined
      if (timeoutMs > 0) {
        // unref：任务卡住不该让进程无法退出
        timer = setTimeout(() => controller.abort(), timeoutMs)
        timer.unref?.()
      }

      try {
        const task = Promise.resolve(fn(controller.signal))
        if (timeoutMs > 0) {
          // 此处已接住 task 的 rejection：宽限期过后调度器不再等待它，
          // 但其延迟到达的失败不得转为 unhandledRejection 而终止进程
          task.catch(() => {})
          await withTimeout(task, timeoutMs + ABORT_GRACE, `任务 ${name} 超时 ${timeoutMs}ms 后仍未结束`)
        } else {
          await task
        }
      } catch (err) {
        if (err instanceof TimeoutError) {
          // 见文件头第 3 点：任务无视了 abort 信号，只能放弃等待
          logger.error(`任务 ${name} 超时后未响应中止信号，已放弃等待（任务可能仍在后台运行）：${errText(err)}`)
        } else if (controller.signal.aborted) {
          logger.warn(`任务 ${name} 因超时被中止（${timeoutMs}ms）`)
        } else {
          logger.error(`任务 ${name} 执行失败：${errText(err)}`, err)
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        state.lastCost = Date.now() - started
      }
    }

    /** 连跑：先跑一轮，再把积压清空 */
    const drain = async (): Promise<void> => {
      state.running = true
      try {
        await once()
        while (state.queued > 0) {
          state.queued--
          await once()
        }
      } finally {
        state.running = false
      }
    }

    return () => {
      if (!state.running) {
        void drain()
        return
      }
      if (queueing && state.queued < MAX_QUEUE) {
        state.queued++
        logger.debug(`任务 ${name} 上一轮未结束，本轮排队（积压 ${state.queued}）`)
        return
      }
      state.skipped++
      const why = queueing ? `积压已达上限 ${MAX_QUEUE}` : "上一轮未结束"
      // 第一次与每 10 次一报：一个长期重叠的任务不该把日志刷满，
      // 但也不能一声不响 —— skipped 会一直涨，WebUI 上看得见
      if (state.skipped === 1 || state.skipped % 10 === 0) {
        logger.warn(`任务 ${name} ${why}，跳过本轮（累计跳过 ${state.skipped} 次）`)
      } else {
        logger.debug(`任务 ${name} ${why}，跳过本轮`)
      }
    }
  }
}

/**
 * 造一个 cron 触发器
 * @param pattern cron 表达式
 * @param timezone 时区，缺省系统时区
 * @param tick 触发回调
 * @param name 任务名，仅用于报错
 * @returns 触发器
 * @throws 表达式非法时
 */
function createCronJob(pattern: string, timezone: string | undefined, tick: () => void, name: string): Job {
  let cron: Cron
  try {
    // 三个参数写全：croner 的签名是 (pattern, fnOrOptions1, fnOrOptions2)，
    // 只传两个时选项会被当成回调
    cron = new Cron(pattern, tick, { timezone, unref: true })
  } catch (err) {
    // croner 的原始报错只说"哪个字段不认识"，补上任务名与表达式才够排查
    throw new Error(`任务 ${name} 的 cron 表达式非法（${pattern}）：${errText(err)}`)
  }
  return {
    nextRun: () => cron.nextRun()?.getTime(),
    stop: () => void cron.stop()
  }
}

/**
 * 造一个固定间隔触发器
 * @param ms 间隔毫秒
 * @param tick 触发回调
 * @returns 触发器
 */
function createIntervalJob(ms: number, tick: () => void): Job {
  let nextAt = Date.now() + ms
  const timer = setInterval(() => {
    nextAt = Date.now() + ms
    tick()
  }, ms)
  // unref：只有定时任务在等的时候，进程应该可以正常退出
  timer.unref?.()
  return {
    nextRun: () => nextAt,
    stop: () => clearInterval(timer)
  }
}

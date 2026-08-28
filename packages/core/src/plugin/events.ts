/**
 * 模块职责：内核事件总线（`ctx.on` 的实现）
 * 依赖方向：依赖 util/defer、类型包
 * 生命周期：应用级单例
 * 注意事项：刻意不使用 Node 的 EventEmitter，原因有三 ——
 *
 *          1) **错误隔离**。EventEmitter 中一个监听器抛错即中断整条 emit 链，
 *             其后的监听器收不到事件；异步监听器抛错更会转为
 *             unhandledRejection 直接终止进程 —— 一个插件的缺陷便影响全部插件。
 *          2) **可等待异步监听器**。`app/stopping` 必须等待插件保存完状态方可继续
 *             停机，而 EventEmitter 不 await 返回的 Promise。
 *          3) **可按插件归属批量摘除**，且每次订阅均返回 Disposer，
 *             热重载不残留悬空监听器。
 *
 *          单个监听器超时（缺省 10s）会被**放弃等待**并记录警告：无法真正终止它，
 *          但绝不使一个阻塞的插件永久阻止停机流程完成。
 */
import type { Awaitable, Disposer, Logger } from "@yunzai-ng/types"
import type { CoreEventMap } from "@yunzai-ng/types"
import { TimeoutError, withTimeout } from "../util/defer.js"

/** 单个监听器的默认等待上限 */
const DEFAULT_HANDLER_TIMEOUT = 10_000

/** 监听器记录 */
interface Listener {
  /** 处理函数 */
  fn: (...args: never[]) => Awaitable<void>
  /** 归属插件名，用于日志与批量摘除 */
  owner: string
  /** 是否只触发一次 */
  once: boolean
  /** 已触发次数（诊断用） */
  calls: number
}

/** 事件总线参数 */
export interface EventBusOptions {
  /** 日志器 */
  logger: Logger
  /** 单个监听器等待上限毫秒，缺省 10000；<=0 表示不限时 */
  handlerTimeout?: number
}

/** 监听器的对外描述 */
export interface ListenerInfo {
  /** 事件名 */
  event: string
  /** 归属插件 */
  owner: string
  /** 触发次数 */
  calls: number
}

/**
 * 内核事件总线
 *
 * 键类型来自 `CoreEventMap`，因此 `ctx.on("bot/online", bot => ...)` 里
 * `bot` 的类型是自动推出来的，写错事件名编译期就报错。
 */
export class CoreEventBus {
  /** 事件名 → 监听器列表（保持注册顺序） */
  readonly #listeners = new Map<string, Listener[]>()
  /** 日志器 */
  readonly #logger: Logger
  /** 单监听器超时毫秒 */
  readonly #timeout: number
  /** 是否已停用（停机后仍到达的事件直接丢弃） */
  #closed = false

  /**
   * @param opts 参数
   */
  constructor(opts: EventBusOptions) {
    this.#logger = opts.logger.child({ scope: "event" })
    this.#timeout = opts.handlerTimeout ?? DEFAULT_HANDLER_TIMEOUT
  }

  /**
   * 订阅事件
   * @param event 事件名
   * @param fn 处理函数
   * @param owner 归属插件名
   * @returns 取消订阅句柄；重复调用无副作用
   */
  on<K extends keyof CoreEventMap>(
    event: K,
    fn: (...args: CoreEventMap[K]) => Awaitable<void>,
    owner = "core"
  ): Disposer {
    return this.#add(event as string, fn as Listener["fn"], owner, false)
  }

  /**
   * 订阅一次
   * @param event 事件名
   * @param fn 处理函数
   * @param owner 归属插件名
   * @returns 取消订阅句柄
   */
  once<K extends keyof CoreEventMap>(
    event: K,
    fn: (...args: CoreEventMap[K]) => Awaitable<void>,
    owner = "core"
  ): Disposer {
    return this.#add(event as string, fn as Listener["fn"], owner, true)
  }

  /**
   * 触发事件并等待全部监听器结束
   *
   * 监听器按注册顺序**同时启动**（而非串行），因为它们之间不应有依赖关系；
   * 谁想要顺序保证就该用服务依赖或中间件优先级表达，而不是偷偷依赖注册顺序。
   * @param event 事件名
   * @param args 事件参数
   * @returns 全部监听器结束（或超时被放弃）后兑现；本身永不拒绝
   */
  async emit<K extends keyof CoreEventMap>(event: K, ...args: CoreEventMap[K]): Promise<void> {
    const listeners = this.#take(event as string)
    if (listeners.length === 0) return

    await Promise.all(listeners.map(listener => this.#invoke(event as string, listener, args)))
  }

  /**
   * 触发事件但不等待
   *
   * 用于消息统计一类"通知即可"的场景：绝不能让某个插件的统计逻辑拖慢
   * 消息处理主链路。错误照样被记录。
   * @param event 事件名
   * @param args 事件参数
   */
  emitDetached<K extends keyof CoreEventMap>(event: K, ...args: CoreEventMap[K]): void {
    const listeners = this.#take(event as string)
    if (listeners.length === 0) return
    for (const listener of listeners) {
      // void 显式表明"刻意不等待"，同时 #invoke 内部已捕获全部错误，
      // 不会产生 unhandledRejection
      void this.#invoke(event as string, listener, args)
    }
  }

  /**
   * 某事件当前的监听器数量
   * @param event 事件名
   * @returns 数量
   */
  count<K extends keyof CoreEventMap>(event: K): number {
    return this.#listeners.get(event as string)?.length ?? 0
  }

  /**
   * 摘除某插件的全部监听器
   * @param owner 插件名
   * @returns 摘除的数量
   */
  removeByOwner(owner: string): number {
    let removed = 0
    for (const [event, list] of this.#listeners) {
      const kept = list.filter(listener => listener.owner !== owner)
      removed += list.length - kept.length
      if (kept.length === 0) this.#listeners.delete(event)
      else this.#listeners.set(event, kept)
    }
    return removed
  }

  /**
   * 列出全部监听器
   * @returns 描述数组
   */
  list(): ListenerInfo[] {
    const out: ListenerInfo[] = []
    for (const [event, list] of this.#listeners) {
      for (const listener of list) out.push({ event, owner: listener.owner, calls: listener.calls })
    }
    return out
  }

  /** 清空全部监听器并停止接受事件 */
  close(): void {
    this.#closed = true
    this.#listeners.clear()
  }

  /**
   * 登记监听器
   * @param event 事件名
   * @param fn 处理函数
   * @param owner 归属插件
   * @param once 是否只触发一次
   * @returns 取消订阅句柄
   */
  #add(event: string, fn: Listener["fn"], owner: string, once: boolean): Disposer {
    const listener: Listener = { fn, owner, once, calls: 0 }
    const list = this.#listeners.get(event)
    if (list) list.push(listener)
    else this.#listeners.set(event, [listener])

    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      const current = this.#listeners.get(event)
      if (!current) return
      const index = current.indexOf(listener)
      if (index >= 0) current.splice(index, 1)
      if (current.length === 0) this.#listeners.delete(event)
    }
  }

  /**
   * 取出本次要触发的监听器快照
   *
   * 必须是快照：监听器在处理过程中订阅/退订是完全合法的（`once` 自己就会退订），
   * 直接遍历原数组会漏触发或重复触发。
   * @param event 事件名
   * @returns 监听器数组；已关闭或无监听器时为空数组
   */
  #take(event: string): Listener[] {
    if (this.#closed) return []
    const list = this.#listeners.get(event)
    if (!list || list.length === 0) return []

    const snapshot = [...list]
    // once 监听器在派发前即摘除，避免其自身抛错导致永久无法摘除
    if (snapshot.some(listener => listener.once)) {
      const kept = list.filter(listener => !listener.once)
      if (kept.length === 0) this.#listeners.delete(event)
      else this.#listeners.set(event, kept)
    }
    return snapshot
  }

  /**
   * 调用单个监听器，捕获错误并仅记日志
   * @param event 事件名
   * @param listener 监听器
   * @param args 事件参数
   * @returns 结束后兑现；永不拒绝
   */
  async #invoke(event: string, listener: Listener, args: readonly unknown[]): Promise<void> {
    listener.calls++
    try {
      const result = listener.fn(...(args as never[]))
      if (result instanceof Promise) {
        await withTimeout(result, this.#timeout, `事件 ${event} 的监听器超过 ${this.#timeout}ms 未结束`)
      }
    } catch (err) {
      if (err instanceof TimeoutError) {
        this.#logger.warn(`插件 ${listener.owner} 处理事件 ${event} 超时，已放弃等待`, err.message)
      } else {
        this.#logger.error(`插件 ${listener.owner} 处理事件 ${event} 出错`, err)
      }
    }
  }
}

/**
 * 创建事件总线
 * @param opts 参数
 * @returns 总线实例
 */
export function createEventBus(opts: EventBusOptions): CoreEventBus {
  return new CoreEventBus(opts)
}

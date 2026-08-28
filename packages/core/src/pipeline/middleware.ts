/**
 * 模块职责：Koa 式中间件管线（实现 `MiddlewareSink`）
 * 依赖方向：依赖类型包与 plugin/hooks 的登记结构
 * 生命周期：随内核创建；每条注册返回 Disposer，插件卸载即摘除
 * 注意事项：中间件是"把业务逻辑挡在内核之外"的关键机制。诸如 `*` → 星铁、
 *          `%` → 绝区零这类前缀识别，都是插件里的一个中间件，内核对"游戏"
 *          一词毫不知情 —— 写进内核就再也洗不掉。
 *
 *          按事件大类预分桶（`#byKind`）而不是每条消息 filter 一遍：
 *          注册是低频的，消息是高频的。
 *
 *          `next()` 只能调一次。重复调用在 Koa 里也是硬错误 —— 它意味着
 *          下游会被跑两遍，而"回复发了两条"这种症状极难追回到源头。
 */
import type { AnyEvent, Disposer, EventKind, Logger, MiddlewareInfo } from "@yunzai-ng/types"
import type { MiddlewareRegistration, MiddlewareSink } from "../plugin/hooks.js"

/** 缺省优先级 */
const DEFAULT_PRIORITY = 100

/** 全部事件大类 */
const ALL_KINDS: readonly EventKind[] = ["message", "notice", "request", "meta"]

/**
 * 比较两条中间件的执行顺序
 * @param a 登记 a
 * @param b 登记 b
 * @returns 排序结果
 */
function byPriority(a: MiddlewareRegistration, b: MiddlewareRegistration): number {
  return (a.options.priority ?? DEFAULT_PRIORITY) - (b.options.priority ?? DEFAULT_PRIORITY)
}

/** 中间件管线 */
export class MiddlewarePipeline implements MiddlewareSink {
  /** 日志器 */
  readonly #logger: Logger
  /** 全部登记，用于 `size` 与按插件摘除 */
  readonly #all = new Set<MiddlewareRegistration>()
  /** 按事件大类预分桶的有序执行链 */
  readonly #byKind = new Map<EventKind, MiddlewareRegistration[]>()

  /**
   * @param logger 日志器
   */
  constructor(logger: Logger) {
    this.#logger = logger
    for (const kind of ALL_KINDS) this.#byKind.set(kind, [])
  }

  /** 已注册的中间件条数 */
  get size(): number {
    return this.#all.size
  }

  /**
   * 列出全部中间件，顺序即实际的执行顺序
   *
   * **按 `message` 桶的顺序输出，不按注册顺序。** 面板上这张表要回答的是
   * 「一条消息先过谁」，而注册顺序与执行顺序并不一致 —— `register()` 是插入排序，
   * 后注册的高优先级中间件会排到前面去。
   *
   * 只对某几类**非** message 事件生效的中间件不在 message 桶里，故补在末尾：
   * 少列一条比顺序不完美糟得多，那会让人以为某个插件没注册上。
   * @returns 中间件描述数组
   */
  list(): MiddlewareInfo[] {
    const ordered = [...(this.#byKind.get("message") ?? [])]
    for (const reg of this.#all) {
      if (!ordered.includes(reg)) ordered.push(reg)
    }
    return ordered.map(reg => ({
      plugin: reg.plugin,
      priority: reg.options.priority ?? DEFAULT_PRIORITY,
      kinds: [...this.#kindsOf(reg)]
    }))
  }

  /**
   * 登记中间件
   * @param reg 登记内容
   * @returns 注销句柄
   */
  register(reg: MiddlewareRegistration): Disposer {
    if (this.#all.has(reg)) return () => this.#remove(reg)
    this.#all.add(reg)

    for (const kind of this.#kindsOf(reg)) {
      const list = this.#byKind.get(kind)
      if (list === undefined) continue
      // 插入排序：同优先级时后注册的排在后面，符合"先装的插件先跑"的直觉
      let at = list.length
      while (at > 0 && byPriority(list[at - 1]!, reg) > 0) at--
      list.splice(at, 0, reg)
    }

    return () => this.#remove(reg)
  }

  /**
   * 执行整条管线
   *
   * `core` 是管线最内层 —— 对消息事件而言即命令路由。中间件未调用 `next()`
   * 或调用了 `e.stop()` 均将导致 `core` 不执行，这正是"拦截消息"的实现方式。
   * @param e 事件
   * @param core 最内层处理
   * @throws 任一中间件或 core 抛错时原样冒泡（由 dispatch 统一处理）
   */
  async run(e: AnyEvent, core: () => Promise<void>): Promise<void> {
    const chain = this.#byKind.get(e.kind)
    // 没有中间件时直接执行核心逻辑，一个闭包都不分配
    if (chain === undefined || chain.length === 0) {
      if (!e.stopped) await core()
      return
    }

    // 取快照：中间件里调 ctx.middleware() 注册新中间件不该影响本次执行，
    // 否则同一条消息的处理链会在跑的过程中变长，行为不可复现
    const list = chain.slice()

    /**
     * 递归执行第 i 层
     * @param i 层号
     */
    const dispatch = async (i: number): Promise<void> => {
      if (e.stopped) return
      if (i === list.length) {
        await core()
        return
      }

      const reg = list[i]!
      let called = false
      /** 传给中间件的 next */
      const next = async (): Promise<void> => {
        if (called) {
          throw new Error(`插件 ${reg.plugin} 的中间件重复调用了 next()：下游会被执行多次`)
        }
        called = true
        await dispatch(i + 1)
      }

      await reg.fn(e, next)

      // 中间件既没调 next 也没显式 stop：这是合法的"拦截"，但很容易是忘了写。
      // 只在 trace 级别提示，避免正常拦截也刷日志。
      if (!called && !e.stopped && this.#logger.isLevelEnabled("trace")) {
        this.#logger.trace(`插件 ${reg.plugin} 的中间件未调用 next()，事件 ${e.id} 到此中断`)
      }
    }

    await dispatch(0)
  }

  /**
   * 摘除某插件的全部中间件
   * @param plugin 插件名
   * @returns 摘除的条数
   */
  removePlugin(plugin: string): number {
    let n = 0
    for (const reg of [...this.#all]) {
      if (reg.plugin === plugin) {
        this.#remove(reg)
        n++
      }
    }
    return n
  }

  /** 清空全部登记 */
  clear(): void {
    this.#all.clear()
    for (const list of this.#byKind.values()) list.length = 0
  }

  /**
   * 取某条登记适用的事件大类
   * @param reg 登记内容
   * @returns 事件大类数组
   */
  #kindsOf(reg: MiddlewareRegistration): readonly EventKind[] {
    const want = reg.options.kind
    if (want === undefined) return ALL_KINDS
    return Array.isArray(want) ? want : [want]
  }

  /**
   * 注销一条登记
   * @param reg 登记内容
   */
  #remove(reg: MiddlewareRegistration): void {
    if (!this.#all.delete(reg)) return
    for (const list of this.#byKind.values()) {
      const at = list.indexOf(reg)
      if (at >= 0) list.splice(at, 1)
    }
  }
}

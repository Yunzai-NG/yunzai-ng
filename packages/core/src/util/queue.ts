/**
 * 模块职责：串行队列与并发闸门
 * 依赖方向：仅依赖 util/defer
 * 生命周期：随持有者回收；`clear()` 会拒绝所有排队任务
 * 注意事项：两个必须串行的场景：
 *          1) **KV 自增**。内嵌 KV 没有原子 INCR，"读-改-写"必须按 key 串行，否则统计会掉数。
 *          2) **同群发消息**。并发发送会乱序，且更容易触发平台风控。
 *
 *          `Semaphore` 用于限制渲染、HTTP 拉取等昂贵操作的并发数 ——
 *          在 1G 内存的安卓机上，同时开 8 个 puppeteer 页面就是 OOM。
 */
import { defer, type Deferred } from "./defer.js"

/**
 * 按 key 串行的任务队列
 *
 * 同一 key 的任务严格按提交顺序逐个执行；不同 key 之间并行。
 * key 上没有任务时会自动清理链表头，不会随 key 数量无限增长。
 */
export class KeyedQueue {
  /** key → 该 key 上最后一个任务的完成信号 */
  readonly #tails = new Map<string, Promise<unknown>>()

  /** 当前有排队任务的 key 数量 */
  get size(): number {
    return this.#tails.size
  }

  /**
   * 排队执行
   * @param key 串行域；同 key 串行，异 key 并行
   * @param task 任务
   * @returns 任务结果
   */
  run<T>(key: string, task: () => Promise<T> | T): Promise<T> {
    const prev = this.#tails.get(key) ?? Promise.resolve()

    // 以 catch 捕获前一个任务的错误：前者失败不应阻断其后排队的任务，
    // 但错误本身仍会经由各自的返回 Promise 抛给对应调用方。
    const next = prev.then(
      () => task(),
      () => task()
    )

    this.#tails.set(key, next)

    // 队尾未发生变化说明自身即最后一个 → 可摘除该 key
    void next
      .catch(() => undefined)
      .finally(() => {
        if (this.#tails.get(key) === next) this.#tails.delete(key)
      })

    return next
  }

  /**
   * 等待某个 key 上的所有任务结束
   * @param key 串行域
   * @returns 全部结束后兑现
   */
  async drain(key: string): Promise<void> {
    const tail = this.#tails.get(key)
    if (tail) await tail.catch(() => undefined)
  }

  /**
   * 等待全部 key 的任务结束
   * @returns 全部结束后兑现
   */
  async drainAll(): Promise<void> {
    while (this.#tails.size > 0) {
      const tails = [...this.#tails.values()]
      await Promise.allSettled(tails)
    }
  }
}

/**
 * 计数信号量
 *
 * 用于限制昂贵操作的并发上限。务必用 `use()` 而不是手工 acquire/release ——
 * 手工写法一旦任务抛错忘了 release，闸门就永久关闭。
 */
export class Semaphore {
  /** 并发上限 */
  readonly #limit: number
  /** 当前占用数 */
  #active = 0
  /** 等待队列 */
  readonly #waiting: Deferred<void>[] = []

  /**
   * @param limit 并发上限，至少 1
   */
  constructor(limit: number) {
    this.#limit = Math.max(1, Math.floor(limit))
  }

  /** 当前正在执行的任务数 */
  get active(): number {
    return this.#active
  }

  /** 当前排队等待的任务数 */
  get pending(): number {
    return this.#waiting.length
  }

  /**
   * 在信号量保护下执行任务
   * @param task 任务
   * @returns 任务结果
   */
  async use<T>(task: () => Promise<T> | T): Promise<T> {
    await this.#acquire()
    try {
      return await task()
    } finally {
      this.#release()
    }
  }

  /**
   * 获取一个许可
   * @returns 拿到许可后兑现
   */
  async #acquire(): Promise<void> {
    if (this.#active < this.#limit) {
      this.#active++
      return
    }
    const waiter = defer<void>()
    this.#waiting.push(waiter)
    await waiter.promise
  }

  /** 释放许可并唤醒下一个等待者 */
  #release(): void {
    const next = this.#waiting.shift()
    if (next) {
      // 许可直接移交，不经过 active-- 再 ++，避免中间态被别人插队
      next.resolve()
      return
    }
    this.#active--
  }
}

/**
 * 并发受限地映射一组任务
 *
 * 与 `Promise.all` 的区别是**同时在跑的任务数有上限**；
 * 结果顺序与输入一致。任一任务抛错则整体拒绝。
 * @param items 输入项
 * @param limit 并发上限
 * @param mapper 映射函数
 * @returns 结果数组，顺序与输入一致
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const sem = new Semaphore(limit)
  return Promise.all(items.map((item, index) => sem.use(() => mapper(item, index))))
}

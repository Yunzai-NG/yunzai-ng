/**
 * 模块职责：插件间服务注册表（provide / inject / require / waitFor）
 * 依赖方向：依赖 util/defer、util/duration、类型包
 * 生命周期：应用级单例；每个插件卸载时其提供的服务被自动摘除
 * 注意事项：这是本框架对「插件间协作」的唯一答案。提供方 `ctx.provide("mihoyo.api", impl)`，
 *          使用方 `ctx.inject("mihoyo.api")`；内核只维护一张 `key → 值` 的表，对表里装的是什么
 *          毫无认知，故内核到任何插件都是零依赖。
 *
 *          它取代两种坏做法：把业务对象硬写成内核的 getter（那会让内核反向依赖插件，删掉一个插件
 *          内核就起不来），以及插件之间靠 `global.xxx` 或跨插件相对路径互相摸（路径一改全体崩，
 *          且无从知道谁在用谁）。
 *
 *          键的所有者被记录下来，插件卸载时它提供的服务一起消失 —— 使用方拿到的是 undefined，
 *          而不是一个指向已卸载模块的失效引用。
 */
import type { Disposer, DurationLike } from "@yunzai-ng/types"
import { defer, type Deferred } from "../util/defer.js"
import { parseDuration } from "../util/duration.js"

/** `waitFor` 的默认等待上限 */
const DEFAULT_WAIT = 30_000

/** 服务键的合法形式：字母开头，允许点号分域 */
const KEY_RE = /^[a-z][a-z0-9]*(?:[.:-][a-z0-9]+)*$/i

/** 一条服务记录 */
interface ServiceEntry {
  /** 服务实例 */
  value: unknown
  /** 提供方插件名 */
  owner: string
  /** 注册时间（毫秒） */
  since: number
}

/** 服务的对外描述（WebUI / `yzng doctor` 用） */
export interface ServiceInfo {
  /** 服务键 */
  key: string
  /** 提供方插件名 */
  owner: string
  /** 注册时间（毫秒） */
  since: number
  /** 当前有多少个等待者（诊断"谁在等一个没人提供的服务"） */
  waiting: number
}

/**
 * 服务注册表
 *
 * 线程模型：同进程单线程，无锁。
 */
export class ServiceRegistry {
  /** 已注册的服务 */
  readonly #entries = new Map<string, ServiceEntry>()
  /** 等待中的 `waitFor` 调用，按键分组 */
  readonly #waiters = new Map<string, Set<Deferred<unknown>>>()

  /** 已注册的服务数 */
  get size(): number {
    return this.#entries.size
  }

  /**
   * 注册服务
   *
   * 同一键被两个插件同时提供时**抛出异常**，而非由后者覆盖前者：此类冲突
   * 多数源于插件作者复制代码后未修改键名，静默覆盖只会使排障难以进行。
   * @param key 服务键，建议 `"<插件域>.<能力>"`
   * @param value 服务实例
   * @param owner 提供方插件名
   * @returns 注销句柄；注销后等待者重新回到"等待"状态
   * @throws 键名非法或已被他人占用时
   */
  provide<T>(key: string, value: T, owner: string): Disposer {
    if (!KEY_RE.test(key)) {
      throw new Error(`服务键 ${key} 不合法：需以字母开头，只含字母数字与 . : -`)
    }
    const exists = this.#entries.get(key)
    if (exists) {
      throw new Error(`服务 ${key} 已由插件 ${exists.owner} 提供，${owner} 不能重复注册`)
    }

    const entry: ServiceEntry = { value, owner, since: Date.now() }
    this.#entries.set(key, entry)
    this.#flushWaiters(key, value)

    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      // 仅当仍为自身那份记录时才删除：避免延迟到达的卸载摘除他方刚注册的服务
      if (this.#entries.get(key) === entry) this.#entries.delete(key)
    }
  }

  /**
   * 取服务
   * @param key 服务键
   * @returns 服务实例；未注册时 undefined
   */
  get<T>(key: string): T | undefined {
    return this.#entries.get(key)?.value as T | undefined
  }

  /**
   * 是否已注册
   * @param key 服务键
   * @returns 是否存在
   */
  has(key: string): boolean {
    return this.#entries.has(key)
  }

  /**
   * 取服务，缺失即抛错
   *
   * 错误信息中必须同时出现"由谁使用"与"需要什么"，否则使用者仅看到
   * "服务不存在"，无从判断应当安装哪一个插件。
   * @param key 服务键
   * @param requester 使用方插件名，用于错误信息
   * @returns 服务实例
   * @throws 服务未注册时
   */
  require<T>(key: string, requester = "未知插件"): T {
    const entry = this.#entries.get(key)
    if (!entry) {
      const available = [...this.#entries.keys()].sort()
      const hint = available.length > 0 ? `当前可用：${available.join("、")}` : "当前没有任何插件提供服务"
      throw new Error(`插件 ${requester} 需要服务 ${key}，但没有插件提供它。${hint}`)
    }
    return entry.value as T
  }

  /**
   * 等待服务就绪
   *
   * 用于弱依赖：A 需要使用 B 的能力，但 B 可能晚于 A 加载，亦可能并未安装。
   * 超时返回 undefined 而非抛错 —— 弱依赖的语义即"不存在时亦可继续运行"。
   * @param key 服务键
   * @param timeout 等待上限，缺省 30s；传 0 表示不限时
   * @returns 服务实例；超时返回 undefined
   */
  async waitFor<T>(key: string, timeout?: DurationLike): Promise<T | undefined> {
    const ready = this.#entries.get(key)
    if (ready) return ready.value as T

    const ms = parseDuration(timeout, DEFAULT_WAIT)
    const waiter = defer<unknown>()
    let bucket = this.#waiters.get(key)
    if (!bucket) {
      bucket = new Set()
      this.#waiters.set(key, bucket)
    }
    bucket.add(waiter)

    /** 从等待队列中摘除自身，并一并清除空桶 */
    const cleanup = (): void => {
      bucket!.delete(waiter)
      if (bucket!.size === 0) this.#waiters.delete(key)
    }

    if (ms <= 0) {
      try {
        return (await waiter.promise) as T
      } finally {
        cleanup()
      }
    }

    // 超时按"没等到"处理：resolve(undefined) 而非 reject，
    // 调用方就不必为一个正常结局写 try/catch
    const timer = setTimeout(() => waiter.resolve(undefined), ms)
    // unref：只剩这个等待时进程仍应能退出，否则插件写错一个 key 就永远关不掉
    if (typeof timer.unref === "function") timer.unref()

    try {
      return (await waiter.promise) as T | undefined
    } finally {
      clearTimeout(timer)
      cleanup()
    }
  }

  /**
   * 摘除某插件提供的全部服务
   *
   * 插件卸载时由宿主调用。尽管每个 `provide` 均返回 disposer 且已登记进
   * DisposalRegistry，此处仍作为兜底：插件若在 setup 之外的异步回调中 provide，
   * 有可能绕过登记。
   * @param owner 插件名
   * @returns 被摘除的服务键
   */
  removeByOwner(owner: string): string[] {
    const removed: string[] = []
    for (const [key, entry] of this.#entries) {
      if (entry.owner !== owner) continue
      this.#entries.delete(key)
      removed.push(key)
    }
    return removed
  }

  /**
   * 列出全部服务
   * @returns 服务描述，按键名排序
   */
  list(): ServiceInfo[] {
    return [...this.#entries.entries()]
      .map(([key, entry]) => ({
        key,
        owner: entry.owner,
        since: entry.since,
        waiting: this.#waiters.get(key)?.size ?? 0
      }))
      .sort((a, b) => a.key.localeCompare(b.key))
  }

  /**
   * 列出"存在等待者但无提供方"的服务键
   *
   * `yzng doctor` 以其给出"可能缺少某个插件"的提示。
   * @returns 键名数组
   */
  pending(): string[] {
    return [...this.#waiters.keys()].filter(key => !this.#entries.has(key)).sort()
  }

  /**
   * 清空注册表并唤醒所有等待者
   *
   * 停机时调用，避免等待者阻止进程退出。
   */
  clear(): void {
    this.#entries.clear()
    for (const bucket of this.#waiters.values()) {
      for (const waiter of bucket) waiter.resolve(undefined)
    }
    this.#waiters.clear()
  }

  /**
   * 唤醒某个键上的全部等待者
   * @param key 服务键
   * @param value 服务实例
   */
  #flushWaiters(key: string, value: unknown): void {
    const bucket = this.#waiters.get(key)
    if (!bucket) return
    // 先取快照再唤醒：resolve 的 finally 会改动这个 Set
    for (const waiter of [...bucket]) waiter.resolve(value)
  }
}

/**
 * 创建服务注册表
 * @returns 注册表实例
 */
export function createServiceRegistry(): ServiceRegistry {
  return new ServiceRegistry()
}

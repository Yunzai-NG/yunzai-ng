/**
 * 模块职责：资源回收登记簿
 * 依赖方向：依赖类型包的 Disposer
 * 生命周期：与其宿主（插件实例 / 账号连接 / 应用）同寿
 * 注意事项：**内核提供给插件的每一个注册型 API 都返回 Disposer**，并自动登记到该插件的
 *          registry。插件卸载时逆序全量回收，故插件作者不需要（也无从忘记）手工清理 ——
 *          否则改十次代码就有十份定时器在跑同一件事。
 *
 *          逆序回收是有意的：后注册的往往依赖先注册的（如先 provide 服务再
 *          注册用到它的命令），倒着拆才不会拆到一半引用空对象。
 */
import type { Disposer } from "@yunzai-ng/types"

/** 回收过程中收集到的错误 */
export interface DisposeFailure {
  /** 登记时的标签 */
  label: string
  /** 抛出的错误 */
  error: unknown
}

/**
 * 资源回收登记簿
 *
 * 线程模型：同进程单线程，无需加锁；但 `dispose()` 可能重入
 * （插件在 disposer 里又触发卸载），故有 `#disposed` 幂等保护。
 */
export class DisposalRegistry {
  /** 登记的回收器，按登记顺序存放 */
  readonly #entries: { label: string; dispose: Disposer }[] = []
  /** 是否已回收 */
  #disposed = false
  /** 归属标识，仅用于日志 */
  readonly #owner: string

  /**
   * @param owner 归属标识（插件名等），出错时用于定位
   */
  constructor(owner: string) {
    this.#owner = owner
  }

  /** 是否已回收 */
  get disposed(): boolean {
    return this.#disposed
  }

  /** 尚未回收的登记项数量 */
  get size(): number {
    return this.#entries.length
  }

  /**
   * 登记一个回收器
   *
   * 若 registry 已回收，传入的 disposer 会**立即执行** —— 这防止"卸载竞态"：
   * 异步初始化的插件在卸载后才完成注册，资源没人回收。
   * @param dispose 回收函数
   * @param label 标签，用于报错定位
   * @returns 取消登记并执行回收的函数；重复调用无副作用
   */
  add(dispose: Disposer, label = "anonymous"): Disposer {
    if (this.#disposed) {
      this.#runOne({ label, dispose })
      return () => undefined
    }

    const entry = { label, dispose }
    this.#entries.push(entry)

    let done = false
    return () => {
      if (done) return
      done = true
      const index = this.#entries.indexOf(entry)
      if (index >= 0) this.#entries.splice(index, 1)
      this.#runOne(entry)
    }
  }

  /**
   * 登记一个 `Map`/`Set` 条目的清理
   * @param collection 容器
   * @param key 键
   * @param label 标签
   * @returns 回收函数
   */
  addEntry<K>(collection: { delete(key: K): unknown }, key: K, label = "entry"): Disposer {
    return this.add(() => void collection.delete(key), label)
  }

  /**
   * 登记一个定时器
   *
   * 顺带 `unref`，让"只剩定时器"时进程能正常退出。
   * @param timer 定时器句柄
   * @param label 标签
   * @returns 回收函数
   */
  addTimer(timer: NodeJS.Timeout, label = "timer"): Disposer {
    if (typeof timer.unref === "function") timer.unref()
    return this.add(() => clearTimeout(timer), label)
  }

  /**
   * 创建从属子登记簿
   *
   * 父簿回收时自动带走子簿。用于"插件里的账号连接"这类嵌套生命周期。
   * @param owner 子簿归属标识
   * @returns 子登记簿
   */
  child(owner: string): DisposalRegistry {
    const sub = new DisposalRegistry(`${this.#owner}/${owner}`)
    this.add(() => void sub.dispose(), `child:${owner}`)
    return sub
  }

  /**
   * 逆序回收全部登记项
   *
   * 单个 disposer 抛错**不会**中断后续回收 —— 一个插件写错清理逻辑不应该
   * 导致其余资源全部泄漏。所有错误汇总返回，由调用方（插件宿主）记日志。
   * @returns 回收过程中发生的错误列表；无错时为空数组
   */
  dispose(): DisposeFailure[] {
    if (this.#disposed) return []
    this.#disposed = true

    const failures: DisposeFailure[] = []
    // 逆序：后注册的可能依赖先注册的
    for (let i = this.#entries.length - 1; i >= 0; i--) {
      const failure = this.#runOne(this.#entries[i]!)
      if (failure) failures.push(failure)
    }
    this.#entries.length = 0
    return failures
  }

  /**
   * 执行单个回收器并捕获错误
   * @param entry 登记项
   * @returns 出错时返回错误信息，否则 undefined
   */
  #runOne(entry: { label: string; dispose: Disposer }): DisposeFailure | undefined {
    try {
      entry.dispose()
      return undefined
    } catch (error) {
      return { label: `${this.#owner}:${entry.label}`, error }
    }
  }
}

/**
 * 把多个 Disposer 合成一个
 * @param disposers 回收函数列表（可含 undefined，便于条件注册）
 * @returns 合成后的回收函数；逆序执行，单个抛错不影响其余
 */
export function combineDisposers(...disposers: (Disposer | undefined)[]): Disposer {
  return () => {
    for (let i = disposers.length - 1; i >= 0; i--) {
      try {
        disposers[i]?.()
      } catch {
        // 合成 disposer 拿不到 logger，只能忽略；需要记录的场景请用 DisposalRegistry
      }
    }
  }
}

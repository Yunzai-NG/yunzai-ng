/**
 * 模块职责：`e.prompt()` 的等待者登记表（会话内"等下一条消息"）
 * 依赖方向：仅依赖类型包
 * 生命周期：随内核创建；每个等待者自带超时与插件卸载信号，不会长期驻留
 * 注意事项：**等待者集中登记，不挂在插件实例上。** 挂在实例上的上下文会随热重载
 *          一并悬空：使用者仍在等输入，而插件已被替换，此后他回复的消息永远得不到
 *          响应，那个闭包也永远不被释放。
 *
 *          集中登记后**同时**绑定三个终止条件：
 *          超时、插件卸载信号、被消息满足。任一条件触发均会摘除登记，
 *          因此不存在永久驻留的等待者。
 *
 *          同一会话可存在多个等待者，按 FIFO 交付：先登记者先取得。
 *          随机交付或全部唤醒均将使"两个插件同时向使用者提问"的行为不可预测。
 */
import type { Disposer, MessageEvent } from "@yunzai-ng/types"
import { targetKey } from "../message/target.js"

/** 缺省等待超时（毫秒） */
export const DEFAULT_PROMPT_TIMEOUT = 60_000

/** 一个等待者 */
interface Waiter {
  /** 会话键 */
  readonly key: string
  /** 发起等待的用户 */
  readonly uid: string
  /** 是否只接受同一用户 */
  readonly sameUser: boolean
  /** 额外过滤 */
  readonly filter: ((e: MessageEvent) => boolean) | undefined
  /** 发起等待的插件名（日志与按插件取消用） */
  readonly plugin: string
  /** 结束等待 */
  resolve(e: MessageEvent | undefined): void
  /** 摘除全部终止条件 */
  cleanup(): void
}

/** 登记一个等待者所需的参数 */
export interface PromptWaitParams {
  /** 会话键，用 `sessionKeyOf()` 计算 */
  readonly key: string
  /** 发起等待的用户 id */
  readonly uid: string
  /** 是否只接受同一用户的消息 */
  readonly sameUser: boolean
  /** 超时毫秒 */
  readonly timeout: number
  /** 额外过滤；返回 false 表示这条不算，继续等 */
  readonly filter?: ((e: MessageEvent) => boolean) | undefined
  /** 发起等待的插件名 */
  readonly plugin: string
  /** 插件卸载信号；abort 时等待以 undefined 结束 */
  readonly signal?: AbortSignal | undefined
}

/**
 * 计算会话键
 *
 * `selfId` 参与计算：同一个群中接入两个账号时，各自的等待互不干扰。
 * 缺少它，A 号提出的问题会被回复给 B 号的等待者。
 *
 * 会话部分复用 `targetKey()`：发送队列用的是同一个函数，两处对"哪个算同一个
 * 会话"的理解因此不可能走样。
 * @param e 消息事件
 * @returns 会话键
 */
export function sessionKeyOf(e: MessageEvent): string {
  return `${e.platform}:${e.selfId}:${targetKey(e.target)}`
}

/** `e.prompt()` 的等待者登记表 */
export class PromptRegistry {
  /** 会话键 → 该会话上的等待者队列（FIFO） */
  readonly #waiters = new Map<string, Waiter[]>()

  /** 当前等待中的数量 */
  get pending(): number {
    let n = 0
    for (const list of this.#waiters.values()) n += list.length
    return n
  }

  /**
   * 登记一个等待者
   * @param params 等待参数
   * @returns 下一条满足条件的消息；超时或插件卸载时 undefined
   */
  wait(params: PromptWaitParams): Promise<MessageEvent | undefined> {
    return new Promise<MessageEvent | undefined>(resolve => {
      let done = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let offSignal: Disposer | undefined

      /** 统一收尾：摘登记、清定时器、解绑信号 */
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer)
        offSignal?.()
        this.#detach(params.key, waiter)
      }

      /** 只允许结束一次 */
      const finish = (e: MessageEvent | undefined): void => {
        if (done) return
        done = true
        cleanup()
        resolve(e)
      }

      const waiter: Waiter = {
        key: params.key,
        uid: params.uid,
        sameUser: params.sameUser,
        filter: params.filter,
        plugin: params.plugin,
        resolve: finish,
        cleanup
      }

      if (params.timeout > 0) {
        timer = setTimeout(() => finish(undefined), params.timeout)
        // 不使一个等待中的 prompt 阻止进程退出：使用者可能始终不再回复，
        // 而停机不应为此额外等待 60 秒
        timer.unref?.()
      }

      const signal = params.signal
      if (signal !== undefined) {
        if (signal.aborted) {
          finish(undefined)
          return
        }
        /** 插件卸载即结束等待 */
        const onAbort = (): void => finish(undefined)
        signal.addEventListener("abort", onAbort, { once: true })
        offSignal = () => signal.removeEventListener("abort", onAbort)
      }

      let list = this.#waiters.get(params.key)
      if (list === undefined) {
        list = []
        this.#waiters.set(params.key, list)
      }
      list.push(waiter)
    })
  }

  /**
   * 把消息投给该会话上的等待者
   *
   * 命中即消费：这条消息不再进入命令路由。否则"用户回答的内容恰好是个命令"
   * 就会既满足等待又触发命令，两条回复一起发出来。
   * @param e 消息事件
   * @returns 是否被某个等待者消费
   */
  offer(e: MessageEvent): boolean {
    const key = sessionKeyOf(e)
    const list = this.#waiters.get(key)
    if (list === undefined || list.length === 0) return false

    for (const waiter of [...list]) {
      if (waiter.sameUser && waiter.uid !== e.sender.uid) continue
      if (waiter.filter !== undefined && !waiter.filter(e)) continue
      waiter.resolve(e)
      return true
    }
    return false
  }

  /**
   * 取消某插件的全部等待
   *
   * 插件的 `ctx.signal` 已经能覆盖正常卸载路径，这里是兜底：`prompt` 若被
   * 转手到别的插件（服务注入场景）调用，signal 可能对不上。
   * @param plugin 插件名
   * @returns 取消的数量
   */
  cancelPlugin(plugin: string): number {
    let n = 0
    for (const list of [...this.#waiters.values()]) {
      for (const waiter of [...list]) {
        if (waiter.plugin === plugin) {
          waiter.resolve(undefined)
          n++
        }
      }
    }
    return n
  }

  /** 结束全部等待（停机时调用） */
  clear(): void {
    for (const list of [...this.#waiters.values()]) {
      for (const waiter of [...list]) waiter.resolve(undefined)
    }
    this.#waiters.clear()
  }

  /**
   * 将等待者从队列中摘除
   * @param key 会话键
   * @param waiter 等待者
   */
  #detach(key: string, waiter: Waiter): void {
    const list = this.#waiters.get(key)
    if (list === undefined) return
    const at = list.indexOf(waiter)
    if (at >= 0) list.splice(at, 1)
    if (list.length === 0) this.#waiters.delete(key)
  }
}

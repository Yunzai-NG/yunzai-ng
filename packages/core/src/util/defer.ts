/**
 * 模块职责：Promise 原语（外部可控 Promise、超时、休眠、重试）
 * 依赖方向：仅依赖类型包
 * 生命周期：纯函数 / 短生命周期对象
 * 注意事项：所有会挂起的等待均必须可被取消，否则热重载时插件已卸载、
 *          而 Promise 仍持有定时器，即构成内存泄漏。因此 `Deferred` 暴露
 *          `reject`，`withTimeout` 必定清除 timer，`sleep` 支持 signal。
 */

/** 超时错误：与普通业务错误相区分，便于上层决定"重试"或"放弃" */
export class TimeoutError extends Error {
  /** 错误名，便于 `err.name === "TimeoutError"` 判定 */
  override readonly name = "TimeoutError"

  /**
   * @param message 错误信息
   */
  constructor(message = "操作超时") {
    super(message)
  }
}

/** 中止错误：signal 触发时抛出 */
export class AbortError extends Error {
  /** 错误名 */
  override readonly name = "AbortError"

  /**
   * @param message 错误信息
   */
  constructor(message = "操作已被取消") {
    super(message)
  }
}

/** 外部可控的 Promise */
export interface Deferred<T> {
  /** Promise 本体 */
  readonly promise: Promise<T>
  /**
   * 兑现
   * @param value 结果值
   */
  resolve(value: T | PromiseLike<T>): void
  /**
   * 拒绝
   * @param reason 原因
   */
  reject(reason?: unknown): void
  /** 是否已结束（兑现或拒绝） */
  readonly settled: boolean
}

/**
 * 创建外部可控的 Promise
 *
 * 用于把"回调/事件"风格的等待（如适配器 echo 应答、`e.prompt`）转成 await。
 * 重复调用 resolve/reject 会被忽略，不会抛错。
 * @returns Deferred 句柄
 */
export function defer<T>(): Deferred<T> {
  let resolveFn!: (value: T | PromiseLike<T>) => void
  let rejectFn!: (reason?: unknown) => void
  let settled = false

  const promise = new Promise<T>((res, rej) => {
    resolveFn = res
    rejectFn = rej
  })

  return {
    promise,
    resolve(value) {
      if (settled) return
      settled = true
      resolveFn(value)
    },
    reject(reason) {
      if (settled) return
      settled = true
      rejectFn(reason)
    },
    get settled() {
      return settled
    }
  }
}

/**
 * 休眠
 * @param ms 毫秒
 * @param signal 可选中止信号；触发时以 AbortError 拒绝
 * @returns 到期后兑现
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortError())
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    // Node 下 unref 让"只剩一个 sleep"时进程仍能退出
    if (typeof timer.unref === "function") timer.unref()

    /** 中止回调 */
    function onAbort(): void {
      clearTimeout(timer)
      reject(new AbortError())
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/**
 * 给 Promise 套超时
 *
 * 注意：超时只是让调用方不再等待，**并不能真正取消**底层操作。需要真取消
 * 的场景（HTTP 请求）请把 signal 传给底层。
 * @param promise 被包装的 Promise
 * @param ms 超时毫秒；<=0 表示不限时
 * @param message 超时错误信息
 * @returns 原结果，或以 TimeoutError 拒绝
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message?: string): Promise<T> {
  if (ms <= 0) return promise
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(message)), ms)
    if (typeof timer.unref === "function") timer.unref()
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      reason => {
        clearTimeout(timer)
        reject(reason)
      }
    )
  })
}

/** 重试选项 */
export interface RetryOptions {
  /** 最大尝试次数（含首次），缺省 3 */
  attempts?: number
  /** 首次退避毫秒，缺省 500 */
  baseDelay?: number
  /** 退避上限毫秒，缺省 30000 */
  maxDelay?: number
  /** 退避倍率，缺省 2 */
  factor?: number
  /** 抖动比例 0~1，缺省 0.2；用于避免多账号重连时步调一致而对服务端造成过载 */
  jitter?: number
  /** 中止信号 */
  signal?: AbortSignal
  /**
   * 每次失败后的回调
   * @param err 本次错误
   * @param attempt 已尝试次数（从 1 开始）
   * @param delay 即将等待的毫秒
   */
  onRetry?: (err: unknown, attempt: number, delay: number) => void
}

/**
 * 计算指数退避（带抖动）的等待时长
 * @param attempt 已尝试次数（从 1 开始）
 * @param opts 退避参数
 * @returns 毫秒
 */
export function backoffDelay(attempt: number, opts: RetryOptions = {}): number {
  const base = opts.baseDelay ?? 500
  const factor = opts.factor ?? 2
  const max = opts.maxDelay ?? 30_000
  const jitter = opts.jitter ?? 0.2

  const raw = Math.min(max, base * factor ** Math.max(0, attempt - 1))
  // 抖动只往下浮动，保证不会超过 maxDelay
  const delta = raw * jitter * Math.random()
  return Math.round(raw - delta)
}

/**
 * 带指数退避的重试
 * @param task 任务；参数为已尝试次数（从 1 开始）
 * @param opts 重试选项
 * @returns 任务结果
 * @throws 最后一次的错误
 */
export async function retry<T>(task: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3)
  let lastError: unknown

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (opts.signal?.aborted) throw new AbortError()
    try {
      return await task(attempt)
    } catch (err) {
      lastError = err
      if (attempt >= attempts) break
      const delay = backoffDelay(attempt, opts)
      opts.onRetry?.(err, attempt, delay)
      await sleep(delay, opts.signal)
    }
  }
  throw lastError
}

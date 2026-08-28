/**
 * 模块职责：渲染注册表 —— 实现 `RenderSink`，管理渲染器插件并择一执行渲染
 * 依赖方向：依赖类型包、plugin/hooks 的接缝定义、util/*；**不认识 puppeteer**
 * 生命周期：随内核创建；每个渲染器随提供方插件卸载而摘除；`stop()` 关闭全部渲染器
 * 注意事项：内核对「怎么把 HTML 变成图片」零认知，只做三件事：择一可用者、补齐全局默认值、
 *          失败时指明失败方。四项刻意的选择：
 *
 *          **`available()` 的结果要缓存。** 它的实现可能是探测 Chromium 是否存在这类几十毫秒的
 *          磁盘操作，每渲染一张图探一次会计进每条消息的响应时间。故按 TTL 缓存，且**探测本身
 *          单例化** —— 十条消息同时请求渲染不该产生十次并发探测。
 *
 *          **失败后立即让可用性缓存作废。** 浏览器崩溃这件事必须在下一次渲染时被发现。不可用
 *          状态的 TTL 更短：使用者刚装好 Chromium，不该再等一分钟。
 *
 *          **只在「该渲染器整体不可用」时切换**，此前先重试同一个。`render.retry` 的语义是本次
 *          渲染重试几次（浏览器繁忙、页面偶发超时）。全部失败时把每个渲染器的原因**逐条**汇总
 *          抛出 —— 只报最后一个的话，真实原因常在第一个里。
 *
 *          **此处不限并发。** 同时渲染多张图会不会耗尽内存，取决于渲染器自己页面池的大小，
 *          只有渲染器插件知道那个数。内核再加一层信号量只会与插件内部的池互相干扰。
 */
import type {
  Disposer,
  Logger,
  RenderDoneInfo,
  RenderRequest,
  RenderResult,
  RendererProvider
} from "@yunzai-ng/types"
import type { RenderSink } from "../plugin/hooks.js"
import { SubsystemUnavailableError } from "../plugin/hooks.js"
import { TimeoutError, withTimeout } from "../util/defer.js"
import { formatBytes } from "../util/duration.js"

/** 可用状态的缓存时长（毫秒） */
const AVAILABLE_TTL_OK = 60_000

/** 不可用状态的缓存时长（毫秒）：比可用短，见文件头第 2 点 */
const AVAILABLE_TTL_FAIL = 10_000

/** 渲染的兜底超时（毫秒），仅当配置读不到时使用 */
const FALLBACK_TIMEOUT = 60_000

/** 渲染相关的配置视图（对应配置项 `render.*`） */
export interface RenderPolicy {
  /** 首选渲染器 id，对应 `render.default` */
  readonly default: string
  /** 单次渲染超时（毫秒） */
  readonly timeout: number
  /** 渲染失败重试次数 */
  readonly retry: number
  /** 图片质量 0-100 */
  readonly quality: number
  /** 缩放倍率 */
  readonly scale: number
}

/** 注册表内部条目 */
interface RendererEntry {
  /** 渲染器实现 */
  readonly provider: RendererProvider
  /** 提供方插件名 */
  readonly owner: string
  /** 可用性缓存：结果 */
  ok: boolean | undefined
  /** 可用性缓存：判定时刻 */
  checkedAt: number
  /** 可用性缓存：正在进行的探测（单例化，见文件头第 1 点） */
  probing: Promise<boolean> | undefined
  /** 最近一次失败原因，供 WebUI 展示 */
  lastError: string | undefined
  /** 累计成功次数 */
  succeeded: number
  /** 累计失败次数 */
  failed: number
}

/** 渲染器的对外描述（WebUI "渲染" 页面的数据来源） */
export interface RendererInfo {
  /** 渲染器 id */
  readonly id: string
  /** 展示名 */
  readonly name: string
  /** 提供方插件名 */
  readonly owner: string
  /** 是否为当前首选 */
  readonly preferred: boolean
  /** 最近判定的可用性；从未判定过时 undefined */
  readonly available: boolean | undefined
  /** 最近失败原因 */
  readonly lastError: string | undefined
  /** 累计成功次数 */
  readonly succeeded: number
  /** 累计失败次数 */
  readonly failed: number
}

/** 渲染注册表构造参数 */
export interface RenderRegistryOptions {
  /** 基础日志器 */
  readonly logger: Logger
  /**
   * 取当前渲染配置
   *
   * 取函数而非直接传值：`render.*` 在 WebUI 里随时可改，配置存储会就地更新，
   * 缓存一份快照就意味着"改了配置要重启才生效"。
   */
  readonly policy: () => RenderPolicy
  /**
   * 一次渲染结束后的通知（成功或全部渲染器失败）
   *
   * 取回调而非直接传 `CoreEventBus`：本文件对渲染实现零认知，认识事件总线
   * 就等于认识插件系统。回调由 `installRuntime` 传入 —— 它本来就持有总线。
   *
   * 省略即不通知，现有调用方（含测试）因此无须改动。
   */
  readonly onDone?: (info: RenderDoneInfo) => void
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
 * 渲染注册表
 *
 * 既是 `ctx.registerRenderer()` 的落点，也是 `ctx.render()` / `e.render()` 的执行处。
 */
export class RenderRegistry implements RenderSink {
  /** 日志器 */
  readonly #logger: Logger
  /** 取配置 */
  readonly #policy: () => RenderPolicy
  /** 渲染器 id → 条目，按注册顺序 */
  readonly #entries = new Map<string, RendererEntry>()
  /** 正在进行的渲染器关闭操作，`stop()` 要等它们结束 */
  readonly #closing = new Set<Promise<void>>()
  /** 渲染结束通知，见构造参数的说明 */
  readonly #onDone: ((info: RenderDoneInfo) => void) | undefined

  /**
   * @param opts 构造参数
   */
  constructor(opts: RenderRegistryOptions) {
    this.#logger = opts.logger.child({ scope: "render" })
    this.#policy = opts.policy
    this.#onDone = opts.onDone
  }

  /** 已注册的渲染器数量 */
  get size(): number {
    return this.#entries.size
  }

  /**
   * 注册一个渲染器
   * @param provider 渲染器实现
   * @param owner 提供方插件名
   * @returns 注销句柄
   * @throws 该 id 已被别的插件占用时
   */
  register(provider: RendererProvider, owner: string): Disposer {
    const existing = this.#entries.get(provider.id)
    if (existing !== undefined) {
      // 与适配器注册表同样的理由：id 是配置项 render.default 引用实现的凭据，
      // 悄悄覆盖会让用户以为自己用的是另一个渲染器
      throw new Error(
        `渲染器 id ${provider.id} 已被插件 ${existing.owner} 注册，插件 ${owner} 不能重复注册；请改用不同的 id`
      )
    }

    const entry: RendererEntry = {
      provider,
      owner,
      ok: undefined,
      checkedAt: 0,
      probing: undefined,
      lastError: undefined,
      succeeded: 0,
      failed: 0
    }
    this.#entries.set(provider.id, entry)
    this.#logger.info(`渲染器就绪：${provider.name ?? provider.id}（${provider.id}，来自插件 ${owner}）`)

    return () => this.#remove(provider.id, entry)
  }

  /**
   * 执行一次渲染
   * @param req 渲染请求（模板根等已由插件上下文补全）
   * @returns 渲染结果
   * @throws 没有任何渲染器、没有可用渲染器、或全部渲染器都失败时
   */
  async render(req: RenderRequest): Promise<RenderResult> {
    if (this.#entries.size === 0) {
      throw new SubsystemUnavailableError("渲染", "没有安装任何渲染器插件，建议安装 renderer-puppeteer")
    }

    const policy = this.#policy()
    const full = this.#applyDefaults(req, policy)
    const timeout = policy.timeout > 0 ? policy.timeout : FALLBACK_TIMEOUT
    const attempts = Math.max(0, policy.retry) + 1

    /**
     * 整个 `render()` 的起点
     *
     * 全灭时上报的耗时取这一档，而非最后一次尝试的耗时：使用者等的是「这次渲染
     * 花了多久才失败」，那包含全部渲染器的全部重试。成功路径不用它 ——
     * 那里取渲染器自报的 `result.cost`，与「出图快慢」对得上。
     */
    const startedAll = Date.now()

    /** 每个渲染器的失败原因，全灭时一起抛出 */
    const reasons: string[] = []

    for (const entry of this.#candidates(policy.default)) {
      const id = entry.provider.id
      if (!(await this.#available(entry))) {
        reasons.push(`${id}：不可用（${entry.lastError ?? "available() 返回 false"}）`)
        continue
      }

      for (let attempt = 1; attempt <= attempts; attempt++) {
        const started = Date.now()
        try {
          const result = await withTimeout(entry.provider.render(full), timeout, `渲染器 ${id} 超时（${timeout}ms）`)
          entry.succeeded++
          entry.lastError = undefined
          const bytes = result.images.reduce((sum, img) => sum + img.byteLength, 0)
          // 级别由 debug 提到 info：渲染是最耗时的一环（数百毫秒到数秒），
          // 「消息进来了、图还没出」这段空白期正需要这行来说明进展。
          // 附上字节数 —— 出图异常大往往是模板里漏了尺寸约束，只看张数看不出来
          this.#logger.info(
            `渲染完成：${req.template} 由 ${id} 出图 ${result.images.length} 张（${formatBytes(bytes)}），耗时 ${result.cost}ms`
          )
          this.#onDone?.({
            renderer: id,
            template: req.template,
            images: result.images.length,
            bytes,
            cost: result.cost,
            ok: true
          })
          return result
        } catch (err) {
          entry.failed++
          entry.lastError = errText(err)
          // 令可用性缓存作废：浏览器崩溃须能在下一次渲染时被发现，见文件头第 2 点
          this.#invalidate(entry)

          const cost = Date.now() - started
          const kind = err instanceof TimeoutError ? "超时" : "失败"
          if (attempt < attempts) {
            this.#logger.warn(`渲染${kind}（${id}，${req.template}，${cost}ms），第 ${attempt}/${attempts} 次重试`)
            continue
          }
          reasons.push(`${id}：${entry.lastError}`)
          this.#logger.warn(`渲染器 ${id} 已重试 ${attempts} 次仍${kind}（${req.template}）`)
        }
      }
    }

    // 逐条汇总而不是只报最后一个：见文件头第 3 点
    const summary = `模板 ${req.template} 渲染失败，已尝试 ${this.#entries.size} 个渲染器：\n  ${reasons.join("\n  ")}`
    // 全灭也报一次：统计要算成功率，只在成功时报则分母恒等于分子。
    // `renderer` 取空串 —— 这一次没有任何渲染器出图，填谁都是错的
    this.#onDone?.({
      renderer: "",
      template: req.template,
      images: 0,
      bytes: 0,
      cost: Date.now() - startedAll,
      ok: false,
      error: summary
    })
    throw new Error(summary)
  }

  /**
   * 列出已注册的渲染器
   * @returns 渲染器描述数组，首选排在最前
   */
  list(): RendererInfo[] {
    const preferred = this.#policy().default
    return [...this.#candidates(preferred)].map(entry => ({
      id: entry.provider.id,
      name: entry.provider.name ?? entry.provider.id,
      owner: entry.owner,
      preferred: entry.provider.id === preferred,
      available: entry.ok,
      lastError: entry.lastError,
      succeeded: entry.succeeded,
      failed: entry.failed
    }))
  }

  /**
   * 摘除某插件注册的全部渲染器
   *
   * 兜底路径：插件上下文正常会逐条调用 Disposer，但插件 setup 中途抛错时
   * 可能存在未经 ctx 的登记。
   * @param owner 插件名
   * @returns 摘除的条数
   */
  removePlugin(owner: string): number {
    let n = 0
    for (const [id, entry] of [...this.#entries]) {
      if (entry.owner === owner) {
        this.#remove(id, entry)
        n++
      }
    }
    return n
  }

  /**
   * 关闭全部渲染器（停机时调用）
   *
   * 会等待插件卸载时那些"发出去就不管"的 `dispose()` 收尾 —— 否则进程退出时
   * 可能留下没杀掉的 Chromium 子进程。
   */
  async stop(): Promise<void> {
    for (const [id, entry] of [...this.#entries]) this.#remove(id, entry)
    if (this.#closing.size > 0) await Promise.allSettled([...this.#closing])
    this.#closing.clear()
  }

  /**
   * 按优先级排出候选渲染器
   *
   * 首选（`render.default`）排在第一位，其余按注册顺序。首选未注册时不报错 ——
   * 使用者可能仅是尚未安装该插件，"能够产出图片"比"由指定渲染器产出图片"更为重要，
   * 但选中其他渲染器时会留下一条日志。
   * @param preferred 首选渲染器 id
   * @returns 候选条目，按尝试顺序
   */
  *#candidates(preferred: string): Generator<RendererEntry> {
    const first = this.#entries.get(preferred)
    if (first !== undefined) yield first
    for (const entry of this.#entries.values()) {
      if (entry !== first) yield entry
    }
  }

  /**
   * 判断渲染器当前可用
   *
   * 带 TTL 缓存 + 单例探测，见文件头第 1 点。
   * @param entry 条目
   * @returns 是否可用
   */
  async #available(entry: RendererEntry): Promise<boolean> {
    const now = Date.now()
    if (entry.ok !== undefined) {
      const ttl = entry.ok ? AVAILABLE_TTL_OK : AVAILABLE_TTL_FAIL
      if (now - entry.checkedAt < ttl) return entry.ok
    }
    // 已有探测在跑就搭它的车：十条消息同时出图不该触发十次 Chromium 探测
    if (entry.probing !== undefined) return entry.probing

    const probing = (async (): Promise<boolean> => {
      try {
        return await entry.provider.available()
      } catch (err) {
        // available() 自己抛错等同于不可用：一个探测都做不成的渲染器不能拿来出图
        entry.lastError = `available() 抛出异常：${errText(err)}`
        return false
      }
    })().then(ok => {
      entry.ok = ok
      entry.checkedAt = Date.now()
      entry.probing = undefined
      return ok
    })

    entry.probing = probing
    return probing
  }

  /**
   * 让可用性缓存作废
   * @param entry 条目
   */
  #invalidate(entry: RendererEntry): void {
    entry.ok = undefined
    entry.checkedAt = 0
  }

  /**
   * 补齐全局缺省值
   *
   * 仅填充插件未指定的项：插件中硬编码的 `quality: 100` 表明其有相应理由，
   * 全局配置不应覆盖它。
   * @param req 原始请求
   * @param policy 当前配置
   * @returns 补全后的请求
   */
  #applyDefaults(req: RenderRequest, policy: RenderPolicy): RenderRequest {
    return {
      ...req,
      quality: req.quality ?? policy.quality,
      timeout: req.timeout ?? policy.timeout,
      viewport: { ...req.viewport, scale: req.viewport?.scale ?? policy.scale }
    }
  }

  /**
   * 摘除一条注册并关闭渲染器
   *
   * 比对 entry 而不是只看 id：插件 A 卸载得晚、插件 B 已经用同一个 id 注册了
   * 新实现时，A 的 Disposer 不应将 B 的实现摘除。
   * @param id 渲染器 id
   * @param entry 注册时的条目
   */
  #remove(id: string, entry: RendererEntry): void {
    if (this.#entries.get(id) !== entry) return
    this.#entries.delete(id)

    const dispose = entry.provider.dispose
    if (dispose === undefined) {
      this.#logger.info(`渲染器 ${id} 已摘除（插件 ${entry.owner}）`)
      return
    }

    // Disposer 是同步的，而关浏览器是异步的：把 promise 记下来交给 stop() 等，
    // 不能就这么丢掉 —— 丢掉的后果是一个残留的 Chromium 进程
    const closing = Promise.resolve(dispose.call(entry.provider)).then(
      () => void this.#logger.info(`渲染器 ${id} 已摘除并关闭（插件 ${entry.owner}）`),
      (err: unknown) => void this.#logger.error(`关闭渲染器 ${id} 时出错：${errText(err)}`, err)
    )
    this.#closing.add(closing)
    void closing.finally(() => void this.#closing.delete(closing))
  }
}

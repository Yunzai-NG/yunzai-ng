/**
 * 模块职责：适配器注册表（实现 `AdapterSink` 与 `AdapterRegistryView`）
 * 依赖方向：仅依赖类型包与 plugin/hooks 的接缝定义；**不认识账号管理器**
 * 生命周期：随内核创建；每条注册随提供方插件卸载而摘除
 * 注意事项：这是"账号登录也是插件"的登记处 —— 内核对 QQ 协议零认知，只知道
 *          "某个插件声称能把一份账号配置变成一个能收发消息的 BotDriver"。
 *
 *          摘除一条适配器时必须先断开它名下的全部账号，但 `Disposer` 是**同步**的
 *          （见 util/dispose.ts：插件卸载走 `DisposalRegistry.dispose()`，不 await）。
 *          于是这里只做同步通知：`onUnregister` 的监听者（账号管理器）必须在回调里
 *          **同步**把账号标成下线、让 `AdapterHost.submit()` 立刻开始丢弃事件，
 *          真正的 socket 关闭再异步收尾。否则会出现"插件已卸载但事件还在往管线里灌"，
 *          症状是热重载后收到重复回复。
 */
import type { AdapterProvider, AdapterRegistryView, Disposer, Logger } from "@yunzai-ng/types"
import type { AdapterSink } from "../plugin/hooks.js"

/** 适配器描述（`list()` 的元素类型，WebUI 的"添加账号"页面据此渲染） */
export type AdapterSummary = Pick<
  AdapterProvider,
  "id" | "name" | "description" | "platform" | "accountSchema" | "loginModes"
>

/** 注册表内部条目 */
export interface AdapterEntry {
  /** 适配器实现 */
  readonly provider: AdapterProvider
  /** 提供方插件名 */
  readonly owner: string
}

/** 摘除通知监听器 */
export type AdapterUnregisterListener = (id: string, entry: AdapterEntry) => void

/** 注册通知监听器 */
export type AdapterRegisterListener = (id: string, entry: AdapterEntry) => void

/** 适配器注册表构造参数 */
export interface AdapterRegistryOptions {
  /** 日志器 */
  readonly logger: Logger
}

/**
 * 适配器注册表
 *
 * 既是 `ctx.registerAdapter()` 的落点（`AdapterSink`），也是 WebUI 与账号管理器
 * 的查询入口（`AdapterRegistryView`）。
 */
export class AdapterRegistry implements AdapterSink, AdapterRegistryView {
  /** 日志器 */
  readonly #logger: Logger
  /** 适配器 id → 条目 */
  readonly #entries = new Map<string, AdapterEntry>()
  /** 摘除通知监听器 */
  readonly #listeners = new Set<AdapterUnregisterListener>()
  /** 注册通知监听器 */
  readonly #onRegister = new Set<AdapterRegisterListener>()

  /**
   * @param opts 构造参数
   */
  constructor(opts: AdapterRegistryOptions) {
    this.#logger = opts.logger.child({ scope: "adapter" })
  }

  /** 已注册的适配器数量 */
  get size(): number {
    return this.#entries.size
  }

  /**
   * 注册一个适配器
   * @param provider 适配器实现
   * @param owner 提供方插件名
   * @returns 注销句柄
   * @throws 该 id 已被别的插件占用时
   */
  register(provider: AdapterProvider, owner: string): Disposer {
    const existing = this.#entries.get(provider.id)
    if (existing !== undefined) {
      // 不做"后来者覆盖"：id 是账号记录里引用适配器的唯一凭据，
      // 悄悄换掉实现会让已存的账号连到另一套协议上去
      throw new Error(
        `适配器 id ${provider.id} 已被插件 ${existing.owner} 注册，插件 ${owner} 不能重复注册；` +
          `请改用不同的 id（账号记录靠它定位适配器实现）`
      )
    }

    const entry: AdapterEntry = { provider, owner }
    this.#entries.set(provider.id, entry)
    this.#logger.info(`适配器就绪：${provider.name}（${provider.id}，平台 ${provider.platform}，来自插件 ${owner}）`)
    for (const listener of [...this.#onRegister]) {
      try {
        listener(provider.id, entry)
      } catch (err) {
        this.#logger.error(`处理适配器 ${provider.id} 的注册通知时出错`, err)
      }
    }
    return () => this.#remove(provider.id, entry)
  }

  /**
   * 按 id 取适配器
   * @param id 适配器 id
   * @returns 适配器实现；未注册时 undefined
   */
  get(id: string): AdapterProvider | undefined {
    return this.#entries.get(id)?.provider
  }

  /**
   * 按 id 取条目（含提供方插件名）
   * @param id 适配器 id
   * @returns 条目；未注册时 undefined
   */
  entry(id: string): AdapterEntry | undefined {
    return this.#entries.get(id)
  }

  /**
   * 列出已注册的适配器
   * @returns 适配器描述数组，按注册顺序
   */
  list(): AdapterSummary[] {
    return [...this.#entries.values()].map(({ provider }) => ({
      id: provider.id,
      name: provider.name,
      description: provider.description,
      platform: provider.platform,
      accountSchema: provider.accountSchema,
      loginModes: provider.loginModes
    }))
  }

  /**
   * 登记注册通知
   *
   * 为热重载而存在：适配器插件重新加载后，其名下账号须自行重连，
   * 否则用户须在面板中逐个点击连接。
   * @param listener 监听器
   * @returns 取消登记
   */
  onRegister(listener: AdapterRegisterListener): Disposer {
    this.#onRegister.add(listener)
    return () => void this.#onRegister.delete(listener)
  }

  /**
   * 登记摘除通知
   *
   * 回调在 `Disposer` 里**同步**执行，因此实现方不能在里面 await 网络操作，
   * 只能做"立刻停止投递事件"这类同步动作，见文件头。
   * @param listener 监听器
   * @returns 取消登记
   */
  onUnregister(listener: AdapterUnregisterListener): Disposer {
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
  }

  /**
   * 摘除某插件注册的全部适配器
   *
   * 兜底路径：插件上下文正常会逐条调 Disposer，但插件 setup 抛在半路时
   * 可能有登记没走 ctx。
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
   * 摘除一条注册
   *
   * 比对 entry 而不是只看 id：插件 A 卸载得晚、插件 B 已经用同一个 id 注册了
   * 新实现时，A 的 Disposer 不应将 B 的实现摘除。
   * @param id 适配器 id
   * @param entry 注册时的条目
   */
  #remove(id: string, entry: AdapterEntry): void {
    if (this.#entries.get(id) !== entry) return
    // 先通知再删：监听者要能通过 entry 拿到 provider 做收尾
    for (const listener of [...this.#listeners]) {
      try {
        listener(id, entry)
      } catch (err) {
        this.#logger.error(`处理适配器 ${id} 的摘除通知时出错`, err)
      }
    }
    this.#entries.delete(id)
    this.#logger.info(`适配器 ${id} 已摘除（插件 ${entry.owner}）`)
  }
}

/**
 * 模块职责：`AdapterHost` 实现 —— 内核给每个账号的宿主能力面
 * 依赖方向：依赖类型包、plugin/hooks 的 `ServerSink`、util/*；**不认识任何适配器实现**
 * 生命周期：一个账号一个实例；随账号断开而回收（`DisposalRegistry` 逆序）
 * 注意事项：适配器插件只拿到这个对象，拿不到内核内部。它解决三件事：
 *
 *          **事件投递的闸门。** `BotDriver` 的契约写明「内核会在卸载时调 `disconnect()`，并断言
 *          其后不再有事件投递进来」。这条断言由此处兑现：`signal` 一经 abort，`submit()` 立即开始
 *          丢弃并计数 —— 不能指望适配器一定彻底停掉自己的 socket 回调，否则热重载后会收到重复回复。
 *
 *          **服务器晚绑定。** HTTP 服务器装配得比适配器插件晚，故 `server` 是 getter、`ServerSink`
 *          是取值函数：适配器在 `createBot()` 里存下 host，真要挂 webhook 时读到的是当时的实际状态。
 *          服务器没开时 `info.enabled` 为 false，适配器据此告知使用者「该模式需要内置服务器」。
 *
 *          **资源回收。** `route` / `websocket` / `createCache` / `onDispose` 全部登记进账号自己的
 *          `DisposalRegistry`，账号一断开即全部回收，适配器不必自行记录。
 *
 *          工厂分两层是刻意的：内核装配时绑定一次全局依赖，账号管理器每次连接只补「该账号」专属
 *          的几项 —— 于是账号管理器不必认识分发器与服务器，`adapter` 层也不会反向依赖 `pipeline`。
 */
import type {
  AccountRecord,
  AccountStatus,
  AdapterHost,
  BotApi,
  ContactCache,
  ContactCacheOptions,
  Disposer,
  IncomingEvent,
  KvNamespace,
  Logger,
  PolicyView,
  RouteHandler,
  RouteOptions,
  ServerInfo,
  WebSocketHandler,
  WebSocketOptions
} from "@yunzai-ng/types"
import type { ServerSink } from "../plugin/hooks.js"
import type { DisposalRegistry } from "../util/dispose.js"
import { createCache } from "../util/lru.js"

/** 状态上报的附加信息 */
export interface StatusDetail {
  /** 错误消息 */
  error?: string
  /** 账号昵称 */
  nickname?: string
}

/** 宿主工厂的全局依赖（内核装配时绑定一次） */
export interface AdapterHostDeps {
  /**
   * 基础日志器
   *
   * 工厂会自己派生带 `adapter`/`account` 字段的 child —— `AdapterHost.logger`
   * 的契约是"已带这两个字段"，由这里兑现而不是靠调用方记得。
   */
  readonly logger: Logger
  /**
   * 适配器数据的 KV 根命名空间
   *
   * 每个账号取得的是 `<root>/<adapterId>/<accountId>`：两个账号即使运行同一个
   * 适配器亦不会相互覆写键，而同一账号重连后仍可读回其此前写入的数据
   *（NapCat 的 `echo` 序号与登录态缓存均依赖该机制）。
   */
  readonly kv: KvNamespace
  /** 内核策略视图 */
  readonly policy: PolicyView
  /**
   * 取当前的服务器登记面
   *
   * 取函数而非直接传值：服务器子系统装好之前 `hooks.server` 是"不可用"占位，
   * 之后会被整体替换掉。见文件头第 2 点。
   */
  readonly server: () => ServerSink
  /**
   * 把事件送进管线
   *
   * 由内核注入（最终指向 `EventDispatcher.submit`）。宿主不认识分发器，
   * 否则 adapter 层就反过来依赖 pipeline 层了。
   * @param event 通用事件
   * @param bot 收到该事件的 Bot
   */
  readonly dispatch: (event: IncomingEvent, bot: BotApi) => void
}

/** 单次连接的账号侧参数 */
export interface AdapterHostParams {
  /** 账号记录 */
  readonly record: AccountRecord
  /** 本次连接的取消信号源 */
  readonly controller: AbortController
  /** 本次连接的回收登记簿 */
  readonly registry: DisposalRegistry
  /**
   * 上报账号状态
   * @param status 新状态
   * @param detail 附加信息
   */
  readonly setStatus: (status: AccountStatus, detail?: StatusDetail) => void
}

/** 宿主句柄：`host` 交给适配器，其余留给账号管理器 */
export interface AdapterHostHandle {
  /** 交给 `createBot()` 的宿主对象 */
  readonly host: AdapterHost
  /**
   * 绑定事件归属的 Bot
   *
   * 必须在 `createBot()` 返回、门面建好之后调用。宿主先于驱动存在
   * （驱动是靠宿主创建出来的），所以这个槽位只能后填。
   * @param bot Bot 门面
   */
  attach(bot: BotApi): void
  /** 解绑：此后事件一律丢弃 */
  detach(): void
  /** 被丢弃的事件数（诊断用：非 0 说明适配器停止不彻底） */
  readonly dropped: number
}

/** 宿主工厂 */
export type AdapterHostFactory = (params: AdapterHostParams) => AdapterHostHandle

/**
 * 绑定全局依赖，得到宿主工厂
 * @param deps 全局依赖
 * @returns 宿主工厂
 */
export function createAdapterHostFactory(deps: AdapterHostDeps): AdapterHostFactory {
  return params => createAdapterHost(deps, params)
}

/**
 * 创建一个账号宿主
 * @param deps 全局依赖
 * @param params 账号侧参数
 * @returns 宿主句柄
 */
export function createAdapterHost(deps: AdapterHostDeps, params: AdapterHostParams): AdapterHostHandle {
  const { record, registry, setStatus } = params
  const adapterId = record.adapterId
  const accountId = record.id
  const signal = params.controller.signal
  const logger = deps.logger.child({ adapter: adapterId, account: accountId })
  /** 路由挂载前缀 */
  const scope = `/adapter/${adapterId}`

  /** 事件归属的 Bot；`createBot()` 之后才有 */
  let bot: BotApi | undefined
  /** 丢弃的事件数 */
  let dropped = 0
  /** 是否已就"投递到无主宿主"提醒过 */
  let warnedNoBot = false

  const host: AdapterHost = {
    logger,
    signal,
    policy: deps.policy,
    kv: deps.kv.sub(adapterId).sub(accountId),
    // 快照 + 复制 config：适配器往 config 上随手写字段是常事，
    // 若给的是原对象，那些临时字段会被账号管理器一并持久化下去，
    // 下次启动时又被当成用户配置读回来
    account: { ...record, config: { ...record.config } },

    // getter：服务器可能在适配器加载之后才启动，见文件头第 2 点
    get server(): ServerInfo {
      return deps.server().info
    },

    submit: (event: IncomingEvent): void => {
      // 闸门一：账号已停用 / 插件已卸载。这是 BotDriver 契约里
      // "断开后不再有事件投递进来"的兑现处
      if (signal.aborted) {
        dropped++
        return
      }
      // 闸门二：尚未绑定 Bot。适配器在 connect() 完成前即收到事件，
      // 此时不存在可用于回复的对象，继续处理只会在管线中抛错
      if (bot === undefined) {
        dropped++
        if (!warnedNoBot) {
          warnedNoBot = true
          logger.warn("在 Bot 就绪前收到事件，已丢弃：请在 connect() 解析之后再开始投递事件")
        }
        return
      }
      deps.dispatch(event, bot)
    },

    route: (method: "GET" | "POST", path: string, handler: RouteHandler, routeOpts?: RouteOptions): Disposer =>
      // 登记进账号的回收簿：账号一断开，webhook 端点必须跟着消失，
      // 否则平台还在往一个没人接的地址推事件
      registry.add(deps.server().route(scope, method, path, handler, routeOpts), `route:${method} ${scope}${path}`),

    websocket: (path: string, handler: WebSocketHandler, wsOpts?: WebSocketOptions): Disposer =>
      registry.add(deps.server().websocket(scope, path, handler, wsOpts), `ws:${scope}${path}`),

    createCache: <V>(cacheOpts: ContactCacheOptions): ContactCache<V> => {
      const cache = createCache<V>(cacheOpts)
      // clear 而不是置 undefined：适配器可能还握着这个缓存对象的引用，
      // 清空能立刻把内存还回去，之后即使被误用也只是全部 miss
      registry.add(() => cache.clear(), "cache")
      return cache
    },

    onDispose: (fn: Disposer): void => void registry.add(fn, "adapter:onDispose"),

    setStatus: (status: AccountStatus, detail?: StatusDetail): void => setStatus(status, detail)
  }

  return {
    host,
    attach: (next: BotApi): void => {
      bot = next
    },
    detach: (): void => {
      bot = undefined
    },
    get dropped(): number {
      return dropped
    }
  }
}

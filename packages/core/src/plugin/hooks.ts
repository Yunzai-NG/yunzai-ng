/**
 * 模块职责：插件上下文与各子系统之间的接缝（sink 接口）
 * 依赖方向：只依赖类型包
 * 生命周期：纯接口 + 一组"子系统不可用"的占位实现
 * 注意事项：`ctx.command` / `ctx.cron` / `ctx.route` / `ctx.render` 的**语义**属于插件上下文，
 *          **实现**属于各子系统。让 context.ts 直接 import 那些子系统会绕成
 *          context → router → context 的环，且没有服务器时上下文就编译不过。
 *
 *          故此处定义一组窄接口，内核启动时把真实子系统插进来。这有当下的现实需求：
 *          服务器可被用户关掉（`server.enable: false`），渲染器可能没装任何插件 ——
 *          那时 `ctx.route` / `ctx.render` 须给出一句人能看懂的话，而不是
 *          `undefined is not a function`。`unavailable*()` 是这条路径的正式实现，不是临时桩。
 */
import type {
  AdapterProvider,
  BotApi,
  CommandHandler,
  CommandOptions,
  CommandPattern,
  Disposer,
  HttpMethod,
  KvDriver,
  Middleware,
  MiddlewareOptions,
  RenderRequest,
  RenderResult,
  RendererProvider,
  RouteHandler,
  RouteOptions,
  ServerInfo,
  SqlHandle,
  TaskFn,
  TaskOptions,
  WebSocketHandler,
  WebSocketOptions
} from "@yunzai-ng/types"

/* ────────────────────────────── 命令 ────────────────────────────── */

/**
 * 一条命令的登记内容
 *
 * 刻意设计成**可变对象**：`ctx.command(p).desc(x).master().action(fn)` 是链式的，
 * 每一环都在修改这份登记。路由器持有同一个对象引用，因此无须采用"先累积完毕再注册"
 * 这类依赖微任务时序的做法；变更索引键（模式）时链式构造器会调用 `reindex`。
 */
export interface CommandRegistration {
  /** 所属插件名 */
  readonly plugin: string
  /** 全部触发模式（主模式 + 别名），至少一个 */
  patterns: CommandPattern[]
  /** 命令选项 */
  options: CommandOptions
  /** 处理函数；`action()` 之前为 undefined，路由器应跳过并告警 */
  handler: CommandHandler | undefined
}

/** 命令注册目标（由命令路由器实现） */
export interface CommandSink {
  /**
   * 登记一条命令
   * @param reg 登记内容
   * @returns 注销句柄
   */
  register(reg: CommandRegistration): Disposer

  /**
   * 通知索引键已变化（追加了别名等）
   * @param reg 登记内容
   */
  reindex(reg: CommandRegistration): void
}

/* ────────────────────────────── 中间件 ────────────────────────────── */

/** 一个中间件的登记内容 */
export interface MiddlewareRegistration {
  /** 所属插件名 */
  readonly plugin: string
  /** 中间件函数 */
  readonly fn: Middleware
  /** 注册选项 */
  readonly options: MiddlewareOptions
}

/** 中间件注册目标（由管线实现） */
export interface MiddlewareSink {
  /**
   * 登记中间件
   * @param reg 登记内容
   * @returns 注销句柄
   */
  register(reg: MiddlewareRegistration): Disposer
}

/* ────────────────────────────── 定时任务 ────────────────────────────── */

/** 一个定时任务的登记内容 */
export interface TaskRegistration {
  /** 所属插件名 */
  readonly plugin: string
  /** `"cron"` 为表达式，`"interval"` 为固定间隔毫秒 */
  readonly kind: "cron" | "interval"
  /** cron 表达式或间隔毫秒 */
  readonly schedule: string | number
  /** 任务体 */
  readonly fn: TaskFn
  /** 任务选项 */
  readonly options: TaskOptions
}

/** 定时任务注册目标（由调度器实现） */
export interface TaskSink {
  /**
   * 登记任务
   * @param reg 登记内容
   * @returns 注销句柄
   * @throws cron 表达式非法时
   */
  register(reg: TaskRegistration): Disposer
}

/* ────────────────────────────── HTTP 服务器 ────────────────────────────── */

/** HTTP 注册目标（由共享服务器实现） */
export interface ServerSink {
  /** 服务器信息，用于插件拼回调地址 */
  readonly info: ServerInfo

  /**
   * 注册路由
   * @param scope URL 前缀（如 `/plugin/mhy-game`）
   * @param method HTTP 方法
   * @param path 相对 scope 的路径
   * @param handler 处理函数
   * @param opts 选项
   * @returns 注销句柄
   */
  route(scope: string, method: HttpMethod, path: string, handler: RouteHandler, opts?: RouteOptions): Disposer

  /**
   * 注册 WebSocket 路径
   * @param scope URL 前缀
   * @param path 相对 scope 的路径
   * @param handler 连接处理函数
   * @param opts 选项
   * @returns 注销句柄
   */
  websocket(scope: string, path: string, handler: WebSocketHandler, opts?: WebSocketOptions): Disposer

  /**
   * 挂载静态目录
   * @param scope URL 前缀
   * @param urlPath 相对 scope 的路径
   * @param dir 本地目录绝对路径
   * @returns 注销句柄
   */
  static(scope: string, urlPath: string, dir: string): Disposer

  /**
   * 挂载单页应用目录并接管站点根路径
   *
   * 内置面板与替换它的插件走同一个入口，因此"谁在提供面板"只有一个判定依据。
   * 根路径已被占用时抛错，不静默覆盖。
   * @param owner 归属标识，仅用于归属查询与日志，如 `core` 或 `plugin:webui-next`
   * @param dir 单页应用产物目录（绝对路径）
   * @returns 注销句柄
   */
  panel(owner: string, dir: string): Disposer

  /**
   * 查询某路径当前由谁提供
   *
   * 内置面板据此判断根路径是否已被插件接管：内核自带面板是兜底实现，
   * 已有提供方时不再挂载，避免重复注册直接抛错。
   * @param path URL 路径，如 `/`
   * @returns 提供方标识；无人提供时 undefined
   */
  claimant(path: string): string | undefined
}

/* ────────────────────────────── 渲染 ────────────────────────────── */

/** 渲染目标（由渲染注册表实现） */
export interface RenderSink {
  /**
   * 注册渲染器
   * @param provider 渲染器实现
   * @param owner 提供方插件名
   * @returns 注销句柄
   */
  register(provider: RendererProvider, owner: string): Disposer

  /**
   * 执行渲染
   * @param req 渲染请求（路径已由上下文补全为绝对路径）
   * @returns 渲染结果
   * @throws 无可用渲染器或渲染失败时
   */
  render(req: RenderRequest): Promise<RenderResult>
}

/* ────────────────────────────── 适配器与存储 ────────────────────────────── */

/** 适配器注册目标（由适配器注册表实现） */
export interface AdapterSink {
  /**
   * 注册适配器
   * @param provider 适配器实现
   * @param owner 提供方插件名
   * @returns 注销句柄；注销时应先断开该适配器的全部账号
   */
  register(provider: AdapterProvider, owner: string): Disposer
}

/** KV 驱动注册目标（由存储层实现） */
export interface KvDriverSink {
  /**
   * 注册 KV 驱动
   * @param driver 驱动实现
   * @param owner 提供方插件名
   * @returns 注销句柄
   */
  register(driver: KvDriver, owner: string): Disposer
}

/** SQL 打开目标（由存储层实现） */
export interface SqlSink {
  /**
   * 打开某插件专属的库
   * @param plugin 插件名（决定文件落在哪个子目录）
   * @param name 库名
   * @returns SQL 句柄
   * @throws better-sqlite3 不可用时
   */
  open(plugin: string, name: string): Promise<SqlHandle>

  /**
   * 关闭某插件打开的全部库
   *
   * `SqlHandle` 上刻意没有 `close()`：句柄会被插件到处传递，谁都能关就意味着
   * 谁都可能在别人还在用时关掉。连接的生死由存储层按插件归属统一管理，
   * 插件卸载时由上下文调用这里。
   * @param plugin 插件名
   */
  close(plugin: string): Promise<void>
}

/** Bot 选取目标（由账号管理器实现） */
export interface BotSink {
  /**
   * 选一个可用账号
   * @param id 账号记录 id 或平台 selfId；省略时取第一个在线账号
   * @returns Bot；无可用账号时 undefined
   */
  pick(id?: string): BotApi | undefined
}

/* ────────────────────────────── 汇总 ────────────────────────────── */

/**
 * 插件上下文依赖的全部子系统
 *
 * 内核在 `create()` 阶段逐个填好；未启用的子系统填 `unavailable*()`。
 */
export interface KernelHooks {
  /** 命令路由 */
  commands: CommandSink
  /** 中间件管线 */
  middlewares: MiddlewareSink
  /** 调度器 */
  tasks: TaskSink
  /** HTTP 服务器；关闭时为不可用实现 */
  server: ServerSink
  /** 渲染 */
  render: RenderSink
  /** 适配器注册表 */
  adapters: AdapterSink
  /** KV 驱动注册表 */
  kvDrivers: KvDriverSink
  /** SQL */
  sql: SqlSink
  /** Bot 选取 */
  bots: BotSink
}

/**
 * 子系统不可用的统一错误
 *
 * 信息中必须写明"为何不可用"与"如何使其可用"，因为看到该错误的通常是插件使用者
 * 而非插件作者。
 */
export class SubsystemUnavailableError extends Error {
  /** 错误名 */
  override readonly name = "SubsystemUnavailableError"

  /**
   * @param subsystem 子系统名
   * @param hint 启用办法
   */
  constructor(subsystem: string, hint: string) {
    super(`${subsystem}当前不可用：${hint}`)
  }
}

/**
 * 构造"服务器未启用"的实现
 * @param reason 不可用原因
 * @returns ServerSink
 */
export function unavailableServer(reason = "配置项 server.enable 为 false"): ServerSink {
  /** 统一抛错 */
  const fail = (): never => {
    throw new SubsystemUnavailableError("HTTP 服务器", `${reason}。在 WebUI 或 config/yunzai.yaml 中开启后重启即可`)
  }
  return {
    info: { enabled: false, host: "", port: 0, publicUrl: "" },
    route: fail,
    websocket: fail,
    static: fail,
    panel: fail,
    // 查询不抛错：调用方问的是"有没有人提供该路径"，服务器整体不可用时
    // 答案就是"没有"。为一次查询抛错会迫使每个调用点包一层 try
    claimant: () => undefined
  }
}

/**
 * 构造"没有渲染器"的实现
 *
 * 注意 `register` 是可用的：渲染器插件正是通过它把自己装进来的，
 * 只有 `render` 在没有任何渲染器时才失败。真实实现由 render 子系统提供，
 * 这里只服务于"渲染子系统整体未初始化"的极早期阶段。
 * @returns RenderSink
 */
export function unavailableRender(): RenderSink {
  return {
    register: () => () => undefined,
    render: () => {
      throw new SubsystemUnavailableError("渲染", "没有安装任何渲染器插件，建议安装 renderer-puppeteer")
    }
  }
}

/**
 * 构造一组全部不可用的子系统
 *
 * 供单元测试与"内核只想加载插件、不跑消息"的诊断模式使用。
 * @returns KernelHooks
 */
export function unavailableHooks(): KernelHooks {
  /** 生成一个抛错的注册函数 */
  const failing = (subsystem: string, hint: string) => () => {
    throw new SubsystemUnavailableError(subsystem, hint)
  }
  return {
    commands: {
      register: failing("命令路由", "消息管线未初始化"),
      reindex: () => undefined
    },
    middlewares: { register: failing("中间件管线", "消息管线未初始化") },
    tasks: { register: failing("调度器", "调度子系统未初始化") },
    server: unavailableServer("服务器子系统未初始化"),
    render: unavailableRender(),
    adapters: { register: failing("适配器注册表", "适配器子系统未初始化") },
    kvDrivers: { register: failing("KV 驱动注册表", "存储子系统未初始化") },
    sql: {
      open: () => Promise.reject(new SubsystemUnavailableError("SQL", "better-sqlite3 未安装或存储子系统未初始化")),
      close: () => Promise.resolve()
    },
    bots: { pick: () => undefined }
  }
}

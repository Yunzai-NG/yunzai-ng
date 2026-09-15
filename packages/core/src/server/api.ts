/**
 * 模块职责：面板 API —— 把内核各子系统的能力翻译成一组 HTTP / WebSocket 端点
 * 依赖方向：依赖 config / logger / plugin / adapter / render / pipeline 的**具体实现**，
 *          以及本目录的 ManagedServer 类型；不认识前端，也不被任何子系统反向依赖
 * 生命周期：`registerApi()` 由 `App.start()` 之前的装配步骤调用一次，返回的 Disposer
 *          交给 `App.own()`；端点本身随服务器一起活到停机
 * 注意事项：本模块只产出描述，注册由调用方做 —— 直接 import `kernel/app.ts` 会形成
 *          app → api → app 的环。
 *
 *          只读模式（`server.readonly`）是面板策略而非服务器策略，故判断在 `requireWritable()`：
 *          插件路由与适配器 webhook 一律照常放行。
 *
 *          日志走 WebSocket 而非 SSE：令牌只走请求头，而 `EventSource` 设不了请求头。
 *          历史日志与实时日志分两条路，合成一条会丢掉握手瞬间同步发出的那一帧。
 */
import { basename, dirname, resolve } from "node:path"
import type {
  AccountRetryOverride,
  AccountState,
  AdapterRegistryView,
  BotRegistryView,
  CommandInfo,
  Disposer,
  HttpMethod,
  LogLevel,
  Logger,
  MiddlewareInfo,
  PlatformInfo,
  ResourceUsage,
  RouteHandler,
  RouteOptions,
  RouteRequest,
  RuntimePaths,
  SchemaDescriptor,
  TaskInfo,
  WebSocketHandler
} from "@yunzai-ng/types"
import type { CoreConfigHandle } from "../config/core-config.js"
import { SchemaError } from "../config/schema.js"
import type { ConfigStore } from "../config/store.js"
import type { LoggerHub } from "../logger/index.js"
import type { LogRecord } from "../logger/format.js"
import type { AccountManager } from "../adapter/accounts.js"
import type { LoginManager } from "../adapter/login.js"
import type { RenderRegistry } from "../render/registry.js"
import type { EventDispatcher } from "../pipeline/dispatch.js"
import type { PluginHost } from "../plugin/host.js"
import type { DirtyAction, PluginMarket } from "../plugin/market.js"
import type { SystemInfo } from "../platform/system.js"
import type { ServerSink } from "../plugin/hooks.js"
import { isDurationLike, parseDuration } from "../util/duration.js"
import { isLoopbackAddress } from "./auth.js"
import { browseDirectory } from "./browse.js"
import type { ManagedServer } from "./index.js"

/** 面板 API 的挂载前缀 */
export const API_SCOPE = "/api"

/** `GET logs` 默认返回的条数 */
const LOG_TAIL_DEFAULT = 200

/** `GET logs` 单次最多返回的条数 */
const LOG_TAIL_MAX = 2000

/** 配置写入的来源标记，日志里据此区分"面板改的"与"用户手改文件" */
const WRITE_SOURCE = "webui"

/** 合法的日志级别，用于校验查询参数 */
const LOG_LEVELS: readonly string[] = ["trace", "debug", "info", "warn", "error", "fatal", "silent"]

/**
 * 两次「把令牌打进日志」之间的最小间隔
 *
 * 该端点 `auth: false`，故跨站页面可向它发表单类 POST。响应体不带令牌，但不加节流
 * 就能靠反复请求把有用的日志顶出滚动窗口。
 */
const REVEAL_COOLDOWN_MS = 10_000

/** 一条面板 HTTP 端点的描述 */
export interface ApiRoute {
  /** HTTP 方法 */
  readonly method: HttpMethod
  /** 相对 `API_SCOPE` 的路径，如 `config/:name` */
  readonly path: string
  /** 处理函数 */
  readonly handler: RouteHandler
  /** 注册选项；缺省即"要令牌、1MB 体上限" */
  readonly options?: RouteOptions
}

/** 一条面板 WebSocket 端点的描述 */
export interface ApiWebSocket {
  /** 相对 `API_SCOPE` 的路径 */
  readonly path: string
  /** 每个连接调用一次 */
  readonly handler: WebSocketHandler
}

/** 面板 API 的完整端点清单 */
export interface ApiSurface {
  /** HTTP 端点 */
  readonly routes: readonly ApiRoute[]
  /** WebSocket 端点 */
  readonly websockets: readonly ApiWebSocket[]
}

/**
 * 命令、定时任务与中间件清单
 *
 * 与 `kernel/app.ts` 的 `KernelSubsystems.registries` 同形，重新声明一份而非 import，
 * 以免 api 反向依赖 kernel。
 */
export interface ApiRegistries {
  /**
   * 列出全部命令
   * @returns 命令描述数组
   */
  commands(): CommandInfo[]

  /**
   * 列出全部定时任务
   * @returns 任务描述数组
   */
  tasks(): TaskInfo[]

  /**
   * 列出全部中间件，顺序即实际的执行顺序
   * @returns 中间件描述数组
   */
  middlewares(): MiddlewareInfo[]
}

/** 面板 API 需要的全部依赖 */
export interface ApiDeps {
  /** 内核版本 */
  readonly version: string
  /** 目录布局 */
  readonly paths: RuntimePaths
  /** 运行环境 */
  readonly platform: PlatformInfo
  /** 面板自己的日志器 */
  readonly logger: Logger
  /** 内核配置句柄（读 `server.readonly` 与各项设置） */
  readonly config: CoreConfigHandle
  /** 配置仓库（面板要能改任意插件的配置） */
  readonly configStore: ConfigStore
  /** 日志枢纽 */
  readonly loggerHub: LoggerHub
  /** 插件宿主 */
  readonly plugins: PluginHost
  /**
   * 插件市场
   *
   * 可选：不提供时相关端点一律返回 501，而非让面板拿到空列表误以为市场是空的。
   */
  readonly market?: PluginMarket
  /** 命令与任务清单 */
  readonly registries: ApiRegistries
  /** 适配器注册表（此处只读视图即可满足需要：注册由插件负责） */
  readonly adapters: AdapterRegistryView
  /** 账号管理器 */
  readonly accounts: AccountManager
  /** 登录会话管理器 */
  readonly logins: LoginManager
  /** 在线 Bot 注册表 */
  readonly bots: BotRegistryView
  /** 渲染器注册表 */
  readonly renderers: RenderRegistry
  /** 事件分发器（读积压计数） */
  readonly dispatcher: EventDispatcher
  /** 共享服务器（读监听信息与路由表） */
  readonly server: ManagedServer

  /**
   * 取应用状态
   *
   * 是取值函数而不是字段：状态会变，而端点清单只建一次。
   * @returns `created` / `starting` / `running` / `stopping` / `stopped`
   */
  status(): string

  /**
   * 取启动时间戳（毫秒）
   * @returns 时间戳
   */
  startedAt(): number

  /**
   * 采样资源占用
   * @returns 内存与 CPU 快照
   */
  usage(): ResourceUsage

  /**
   * 采样磁盘与显卡
   *
   * 与 `usage()` 分开的理由是**耗时不同量级**：`usage()` 只读进程自己的计数器，
   * 同步且微秒级；本项要量文件系统、还可能 spawn 一个 nvidia-smi，故是异步的。
   * 合成一个的话，`GET /api/overview` 就得跟着变成「等磁盘」的端点 ——
   * 而它是面板每 5 秒必拉的那一个。
   * @returns 磁盘与显卡快照
   */
  system(): Promise<SystemInfo>
}

/**
 * 面板能改的配置句柄
 *
 * `ConfigStore.get()` 返回的是 `ConfigFile<any>`（仓库里存着各插件各自的类型，
 * 取出来时已经无从得知）。这里声明一个只含面板真正会用到的成员的窄接口，
 * 好处是本文件内部再也不出现 `any`：类型检查在这道边界上收敛一次，
 * 后面所有调用点都是有类型的。
 */
interface WritableConfig {
  /** 配置名 */
  readonly name: string
  /** 展示标题 */
  readonly title: string
  /** 文件绝对路径 */
  readonly file: string
  /** 表单描述 */
  readonly schema: SchemaDescriptor

  /**
   * 读当前值
   * @returns 只读快照
   */
  get(): unknown

  /**
   * 局部合并写入
   * @param patch 要改的字段
   * @param source 变更来源
   * @returns 写入后的快照
   */
  patch(patch: Record<string, unknown>, source: typeof WRITE_SOURCE): Promise<unknown>

  /**
   * 整体替换
   * @param value 新值
   * @param source 变更来源
   * @returns 写入后的快照
   */
  replace(value: unknown, source: typeof WRITE_SOURCE): Promise<unknown>

  /**
   * 恢复默认值
   * @param source 变更来源
   * @returns 写入后的快照
   */
  reset(source: typeof WRITE_SOURCE): Promise<unknown>
}

/** 带状态码的错误，`ManagedServer` 的错误处理器按 `statusCode` 回状态 */
interface ApiError extends Error {
  /** HTTP 状态码 */
  statusCode: number
}

/**
 * 造一个带状态码的错误
 * @param status HTTP 状态码
 * @param message 中文说明，会原样回给面板
 * @returns 错误对象
 */
function fail(status: number, message: string): ApiError {
  const err = new Error(message) as ApiError
  err.statusCode = status
  return err
}

/**
 * 取错误的可读信息
 * @param err 任意抛出物
 * @returns 文本
 */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 把请求体当作对象取出
 * @param body 已解析的请求体
 * @returns 键值对
 * @throws 请求体不是 JSON 对象时抛 400
 */
function objectOf(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw fail(400, "请求体必须是一个 JSON 对象")
  }
  return body as Record<string, unknown>
}

/**
 * 从对象里取必填字符串
 * @param obj 请求体
 * @param key 字段名
 * @returns 非空字符串
 * @throws 缺失或类型不对时抛 400
 */
function requireString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key]
  if (typeof value !== "string" || value === "") throw fail(400, `字段 ${key} 必填，且必须是非空字符串`)
  return value
}

/**
 * 从对象里取可选字符串
 * @param obj 请求体
 * @param key 字段名
 * @returns 字符串；缺失时 undefined
 * @throws 存在但类型不对时抛 400
 */
function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") throw fail(400, `字段 ${key} 必须是字符串`)
  return value
}

/**
 * 从对象里取可选布尔
 * @param obj 请求体
 * @param key 字段名
 * @returns 布尔；缺失时 undefined
 * @throws 存在但类型不对时抛 400
 */
function optionalBoolean(obj: Record<string, unknown>, key: string): boolean | undefined {
  const value = obj[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "boolean") throw fail(400, `字段 ${key} 必须是布尔值`)
  return value
}

/**
 * 从对象里取可选数字
 * @param obj 请求体
 * @param key 字段名
 * @param range 允许区间（含两端）
 * @returns 数字；缺失时 undefined
 * @throws 存在但不是有限数字、或越界时抛 400
 */
function optionalNumber(
  obj: Record<string, unknown>,
  key: string,
  range: { min: number; max: number }
): number | undefined {
  const value = obj[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "number" || !Number.isFinite(value)) throw fail(400, `字段 ${key} 必须是数字`)
  if (value < range.min || value > range.max) {
    throw fail(400, `字段 ${key} 必须在 ${range.min} 到 ${range.max} 之间，收到 ${value}`)
  }
  return value
}

/**
 * 解析请求体里的每账号重连覆盖
 *
 * 四项逐个可缺，缺的那项由内核回落到全局配置（见 `AccountManager.#policyOf`），故此处
 * 不填默认值 —— 填了就把「跟随全局」变成「此刻的全局值」。时长字符串的格式不在这里校验，
 * 由 `parseDuration` 解析、解析不出来时回落到全局值。
 * @param body 请求体
 * @returns 覆盖对象；`retry` 缺席时 undefined，`retry: null` 时 null（表示清空）
 * @throws 类型不对或越界时抛 400
 */
function retryOverrideOf(body: Record<string, unknown>): AccountRetryOverride | null | undefined {
  const raw = body.retry
  if (raw === undefined) return undefined
  if (raw === null) return null
  const obj = objectOf(raw)
  const override: AccountRetryOverride = {}
  // 上限与全局 schema 同区间：越界在这里挡住，否则一个 -1 会让「0 为不限」的判据静默失效
  const limit = optionalNumber(obj, "limit", { min: 0, max: 1000 })
  if (limit !== undefined) override.limit = Math.trunc(limit)
  const factor = optionalNumber(obj, "factor", { min: 1, max: 10 })
  if (factor !== undefined) override.factor = factor
  // 判据必须与 `parseDuration` 同一条，否则会收下一个它解析不了的值而静默回落到全局。
  // 负数单独挡掉：`"-2s"` 合乎格式却会让 `setTimeout` 立刻触发，退避形同不存在
  for (const key of ["interval", "maxInterval"] as const) {
    const value = obj[key]
    if (value === undefined || value === null) continue
    if (!isDurationLike(value)) {
      throw fail(400, `字段 retry.${key} 必须是毫秒数字或形如 "2s" 的时长字符串`)
    }
    if (parseDuration(value, -1) < 0) throw fail(400, `字段 retry.${key} 不能是负数`)
    override[key] = value
  }
  return override
}

/**
 * 取查询串里的单个值
 *
 * 同名重复（`?scope=a&scope=b`）时 Fastify 给出数组，取第一个。
 * @param query 查询串对象
 * @param key 参数名
 * @returns 字符串；缺失时 undefined
 */
function queryOf(query: RouteRequest["query"], key: string): string | undefined {
  const value = query[key]
  if (Array.isArray(value)) return value[0]
  return value
}

/**
 * 解析查询串里的正整数
 * @param query 查询串对象
 * @param key 参数名
 * @param fallback 缺省值
 * @param max 上限
 * @returns 落在 `[1, max]` 内的整数
 */
function countOf(query: RouteRequest["query"], key: string, fallback: number, max: number): number {
  const raw = queryOf(query, key)
  if (raw === undefined || raw === "") return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 1) return fallback
  return Math.min(n, max)
}

/**
 * 解析查询串里的日志级别
 * @param query 查询串对象
 * @returns 级别；未指定或非法时 undefined
 */
function levelOf(query: RouteRequest["query"]): LogLevel | undefined {
  const raw = queryOf(query, "level")
  if (raw === undefined || !LOG_LEVELS.includes(raw)) return undefined
  return raw as LogLevel
}

/**
 * 造出面板 API 的全部端点描述
 *
 * 只造描述，不注册（理由见文件头），故单测某个端点时可直接调它的 `handler`。
 * @param deps 依赖
 * @returns 端点清单
 */
export function createApiRoutes(deps: ApiDeps): ApiSurface {
  const routes: ApiRoute[] = []
  const websockets: ApiWebSocket[] = []

  // 上一次把令牌打进日志的时刻，用于节流（见 `POST token/reveal`）。
  // 不放模块级：同进程内起两台服务器时会相互串扰，测试里正是这种用法
  let lastReveal = 0

  /** 只读模式下拦住写操作，见文件头第 2 条 */
  const requireWritable = (): void => {
    if (deps.config.get().server.readonly) {
      throw fail(403, "面板处于只读模式（配置项 server.readonly 为 true），不能执行写操作")
    }
  }

  /**
   * 登记一条端点，并统一将 SchemaError 转换为 400
   *
   * 直接抛出只会保留一条拼接后的消息，前端无从把错误标到对应表单项，故返回带
   * `issues` 的 400 信封。
   */
  const add = (method: HttpMethod, path: string, handler: RouteHandler, options?: RouteOptions): void => {
    routes.push({
      method,
      path,
      options,
      handler: async req => {
        try {
          return await handler(req)
        } catch (err) {
          if (err instanceof SchemaError) {
            return { status: 400, body: { error: err.message, issues: err.issues } }
          }
          throw err
        }
      }
    })
  }

  /** 按名取配置句柄，取不到就是 404 */
  const configOf = (name: string | undefined): WritableConfig => {
    if (name === undefined || name === "") throw fail(400, "缺少配置名")
    const file: WritableConfig | undefined = deps.configStore.get(name)
    if (file === undefined) throw fail(404, `没有名为 ${name} 的配置。已声明的配置见 GET ${API_SCOPE}/config`)
    return file
  }

  /** 按 id 取账号，取不到就是 404 */
  const accountOf = (id: string | undefined): AccountState => {
    if (id === undefined || id === "") throw fail(400, "缺少账号 id")
    const state = deps.accounts.get(id)
    if (state === undefined) throw fail(404, `没有 id 为 ${id} 的账号`)
    return state
  }

  /* ────────────────────────────── 概览 ────────────────────────────── */

  add("GET", "overview", () => {
    const plugins = deps.plugins.list()
    const accounts = deps.accounts.list()
    return {
      version: deps.version,
      status: deps.status(),
      startedAt: deps.startedAt(),
      uptime: Date.now() - deps.startedAt(),
      platform: deps.platform,
      paths: deps.paths,
      usage: deps.usage(),
      server: {
        ...deps.server.info,
        readonly: deps.config.get().server.readonly,
        connections: deps.server.connections
      },
      counts: {
        plugins: plugins.length,
        pluginsFailed: plugins.filter(p => p.status === "error").length,
        commands: deps.registries.commands().length,
        tasks: deps.registries.tasks().length,
        adapters: deps.adapters.list().length,
        accounts: accounts.length,
        online: accounts.filter(a => a.status === "online").length,
        renderers: deps.renderers.size,
        logins: deps.logins.running
      },
      pipeline: { handled: deps.dispatcher.handled, queued: deps.dispatcher.queued }
    }
  })

  // 单独一个端点，不并入概览：概览每 5 秒必拉，而本项要量文件系统、还可能 spawn nvidia-smi。
  // CPU 与内存刻意不在这里 —— 已在概览里，同一事实供两份会让两处的数对不上
  add("GET", "system", () => deps.system())

  /* ────────────────────────────── 配置 ────────────────────────────── */

  add("GET", "config", () => deps.configStore.list())

  // 刻意**不脱敏**：读这个端点本身就需要令牌，而面板必须能显示与轮换令牌、
  // 显示适配器的连接密钥。返回掩码会让"改一个字段就得重填全部密码"成为常态，
  // 那才是真正会逼用户把密钥写到别处的设计
  add("GET", "config/:name", req => {
    const file = configOf(req.params.name)
    return { name: file.name, title: file.title, file: file.file, schema: file.schema, value: file.get() }
  })

  add("PATCH", "config/:name", async req => {
    requireWritable()
    const file = configOf(req.params.name)
    return { value: await file.patch(objectOf(req.body), WRITE_SOURCE) }
  })

  add("PUT", "config/:name", async req => {
    requireWritable()
    const file = configOf(req.params.name)
    return { value: await file.replace(objectOf(req.body), WRITE_SOURCE) }
  })

  add("POST", "config/:name/reset", async req => {
    requireWritable()
    const file = configOf(req.params.name)
    deps.logger.warn(`面板重置了配置 ${file.name}`)
    return { value: await file.reset(WRITE_SOURCE) }
  })

  /* ────────────────────────────── 插件 ────────────────────────────── */

  add("GET", "plugins", () => deps.plugins.list())

  add("GET", "plugins/:name", req => {
    const name = req.params.name ?? ""
    const state = deps.plugins.get(name)
    if (state === undefined) throw fail(404, `没有名为 ${name} 的插件`)
    return state
  })

  add("POST", "plugins/:name/reload", async req => {
    requireWritable()
    const name = req.params.name ?? ""
    const ok = await deps.plugins.reload(name)
    if (!ok) throw fail(400, `重载 ${name} 失败，详情见日志`)
    return { name, reloaded: true }
  })

  add("POST", "plugins/:name/unload", async req => {
    requireWritable()
    const name = req.params.name ?? ""
    const ok = await deps.plugins.unload(name)
    if (!ok) throw fail(404, `插件 ${name} 当前并未加载`)
    return { name, unloaded: true }
  })

  /* ────────────────────────── 插件市场 ────────────────────────── */

  /**
   * 取市场实例
   * @returns 市场实例
   * @throws 当前部署未提供市场时以 501 结束请求
   */
  const market = (): PluginMarket => {
    if (deps.market === undefined) throw fail(501, "当前部署未启用插件市场")
    return deps.market
  }

  /**
   * 找出装在 `plugins/<dir>` 里的那个插件的声明名
   *
   * 市场按安装目录寻址，插件宿主按 `definePlugin({ name })` 的声明名寻址，两者常常不同。
   * 把目录名直接交给 `plugins.unload()` 会静默卸错对象或该卸的没卸，故按目录比对而非按名字。
   * @param dir 安装目录名
   * @returns 声明名；该目录下没有已知插件时 undefined
   */
  const pluginInDir = (dir: string): string | undefined => {
    const root = resolve(deps.paths.plugins)
    const target = resolve(root, dir)
    // 只认 plugins 的直接子目录：空串、`..` 之类都在此挡下
    if (dirname(target) !== root) return undefined
    return deps.plugins.list().find(state => state.root !== "" && resolve(state.root) === target)?.name
  }

  /**
   * 失败之后把先前卸掉的那个插件装回来
   *
   * 卸载发生在动手之前，而多数失败（索引里没有、`minCore` 不满足、有改动而未同意暂存）
   * 根本没碰目录。装不回来只记日志、不改写错误 —— 要报给使用者的是原本那个失败。
   * @param name 先前卸掉的插件声明名
   * @param unloaded 当时是否确实卸掉了
   */
  const restore = async (name: string | undefined, unloaded: boolean): Promise<void> => {
    if (!unloaded || name === undefined) return
    const back = await deps.plugins.reload(name).catch(() => false)
    if (!back) deps.logger.warn(`插件 ${name} 在一次失败的市场操作后没能装回来，可在插件页手动重载`)
  }

  /**
   * 安装或更新一个市场插件，并按需加载
   *
   * 更新前先卸载：旧模块留在内存里时其命令仍会响应，而磁盘上已是新代码。
   * 失败一律折成 400 —— 都是请求方的输入或环境决定的，不是服务端故障。
   * @param name 插件目录名（与索引条目同名）
   * @param load 安装后是否立即加载
   * @param replace 目标已存在时是否覆盖
   * @param dependencies 是否顺带装依赖并跑索引声明的装后步骤
   * @param fresh 覆盖时跳过就地拉取，直接整目录重下
   * @param onDirty 就地拉取撞上本地改动时怎么办：暂存 / 丢弃 / 中止，缺省中止
   * @returns 安装结果，附本次加载成功的插件名
   * @throws 安装失败时以 400 结束请求
   */
  const installFromMarket = async (
    name: string,
    load: boolean,
    replace: boolean,
    dependencies: boolean,
    fresh = false,
    onDirty: DirtyAction = "abort"
  ): Promise<Record<string, unknown>> => {
    const instance = market()
    const occupant = replace ? pluginInDir(name) : undefined
    // 市场按目录寻址，而插件列表显示的是声明名；两者不同名时改说该用哪个名字
    const mistaken = replace && occupant === undefined ? deps.plugins.list().find(s => s.name === name) : undefined
    if (mistaken !== undefined && mistaken.root !== "") {
      const dir = basename(mistaken.root)
      throw fail(400, `插件 ${name} 装在目录 ${dir} 里。市场按安装目录寻址，请改用 ${dir}`)
    }
    let unloaded = false
    try {
      if (occupant !== undefined && deps.plugins.get(occupant) !== undefined) {
        unloaded = await deps.plugins.unload(occupant)
      }
      // `fresh` 绕开就地拉取直接重下：`update()` 拉取成功时什么都不会重下
      let result
      if (!replace) result = await instance.install(name, { dependencies })
      else if (fresh) result = await instance.install(name, { replace: true, dependencies })
      else result = await instance.update(name, { dependencies, onDirty })
      // 缺依赖或装后步骤失败时不加载：加载注定失败，且报出的错离原因很远
      const skip = result.setupError !== undefined || result.dependencyError !== undefined || result.needsDependencies
      const loaded = load && !skip ? [...(await deps.plugins.loadAll()).loaded] : []
      return { ...result, unloaded, loaded }
    } catch (err) {
      await restore(occupant, unloaded)
      throw fail(400, err instanceof Error ? err.message : String(err))
    }
  }

  // 刷新索引不需要写权限：该动作只更新索引缓存，不改动配置、账号与已装插件。
  // 只读模式的用途是防止误操作改动部署状态，浏览可安装的插件不属于此列
  add("GET", "market", req => market().list(queryOf(req.query, "refresh") === "1"))

  add("POST", "market/refresh", () => market().list(true))

  // 装依赖缺省为真，与面板商店那侧一致；离线部署可显式传 false
  add("POST", "market/install", async req => {
    requireWritable()
    const body = objectOf(req.body)
    const name = requireString(body, "name")
    return installFromMarket(
      name,
      optionalBoolean(body, "load") ?? true,
      false,
      optionalBoolean(body, "dependencies") ?? true
    )
  })

  /*
   * 自己填一个 git 地址装插件 —— 索引之外的那条路
   *
   * **登记与安装是两步，中间夹着这一层自己的事**（卸掉占目录的插件、装完 loadAll、失败时装回去），
   * 故这里调 `registerCustom` 而非让市场一口气装完：那一套若在市场里重写一遍，两条安装路径迟早
   * 在「装失败之后插件还在不在」这种事上分叉。
   *
   * **登记成功而安装失败时不撤登记。** 那时目录多半已经在了（失败在编译或装依赖上），使用者
   * 下一步是修一修再点重试，而撤掉登记等于让他重填一遍表单。要清掉就用 DELETE 那条。
   *
   * 路由段数与 `market/:name` 那几条都不同，故不会互相吃掉。
   */
  add("POST", "market/custom", async req => {
    requireWritable()
    const body = objectOf(req.body)
    const scripts = Array.isArray(body.scripts)
      ? body.scripts.filter((one): one is string => typeof one === "string")
      : []
    let entry
    try {
      entry = await market().registerCustom({
        url: requireString(body, "url"),
        ...(optionalString(body, "name") === undefined ? {} : { name: optionalString(body, "name") }),
        ...(optionalString(body, "branch") === undefined ? {} : { branch: optionalString(body, "branch") }),
        ...(optionalString(body, "title") === undefined ? {} : { title: optionalString(body, "title") }),
        ...(optionalString(body, "description") === undefined
          ? {}
          : { description: optionalString(body, "description") }),
        build: optionalBoolean(body, "build") ?? false,
        scripts
      })
    } catch (err) {
      // 登记这一步的失败一概是表单问题（地址不合法、目录名推不出、script 名不合法、已有同名索引条目）
      throw fail(400, err instanceof Error ? err.message : String(err))
    }
    const result = await installFromMarket(
      entry.name,
      optionalBoolean(body, "load") ?? true,
      optionalBoolean(body, "replace") ?? false,
      optionalBoolean(body, "dependencies") ?? true
    )
    return { ...result, custom: true }
  })

  // 列出自己登记过的那几条。只读动作，故不要求写权限
  add("GET", "market/customs", () => market().customs())

  /*
   * 撤掉一条登记 —— **不删插件目录**
   *
   * 删目录是 `DELETE market/:name` 的事。两件事分开，才使得「我想改一下这条的地址」不必先
   * 卸载插件：撤掉旧登记、填一条新的即可。反过来，插件目录删掉之后这条登记还在，那时它在
   * 市场页上显示为「未安装」，点一下即按原地址重装 —— 那是有用的。
   */
  add("DELETE", "market/custom/:name", async req => {
    requireWritable()
    const name = req.params.name ?? ""
    let removed: boolean
    try {
      removed = await market().removeCustom(name)
    } catch (err) {
      throw fail(400, err instanceof Error ? err.message : String(err))
    }
    if (!removed) throw fail(404, `没有名为 ${name} 的自定义登记`)
    return { name, removed }
  })

  // 只读动作，故不要求写权限：只读模式下更新会被挡下，但「目录改过没有」仍该答得出
  add("GET", "market/:name/update-probe", async req => {
    const name = req.params.name ?? ""
    try {
      return await market().inspectUpdate(name)
    } catch (err) {
      throw fail(400, err instanceof Error ? err.message : String(err))
    }
  })

  /*
   * 更新，或整份重装（`fresh` 为真时跳过就地拉取）
   *
   * `onDirty` 三取值：`abort`（缺省，原地中止）、`stash`（暂存后更新，可 pop 取回）、
   * `discard`（丢弃后更新，取不回）。旧请求体的 `stash: true` 继续收，等价于 `"stash"`
   * —— 面板与内核各自发版，旧面板发来的更新请求不该因此失败。
   */
  add("POST", "market/:name/update", async req => {
    requireWritable()
    const name = req.params.name ?? ""
    const body = req.body === undefined ? {} : objectOf(req.body)
    const raw = optionalString(body, "onDirty")
    const onDirty: DirtyAction =
      raw === "stash" || raw === "discard" || raw === "abort"
        ? raw
        : optionalBoolean(body, "stash") === true
          ? "stash"
          : "abort"
    return installFromMarket(
      name,
      optionalBoolean(body, "load") ?? true,
      true,
      optionalBoolean(body, "dependencies") ?? true,
      optionalBoolean(body, "fresh") ?? false,
      onDirty
    )
  })

  // 单独重跑装依赖与装后步骤，不重新取源；与安装那条路共用 `PluginMarket.setup()`
  add("POST", "market/:name/setup", async req => {
    requireWritable()
    const name = req.params.name ?? ""
    const body = req.body === undefined ? {} : objectOf(req.body)
    const load = optionalBoolean(body, "load") ?? true
    // 先卸载再跑：`build` 会覆盖 `dist/`，而旧模块还在内存里响应命令。
    // 卸的是这个目录里装着的那个插件，不是与目录同名的那个，见 `pluginInDir`
    const occupant = pluginInDir(name)
    const unloaded =
      occupant !== undefined && deps.plugins.get(occupant) !== undefined ? await deps.plugins.unload(occupant) : false
    try {
      const result = await market().setup(name)
      // 判据与 installFromMarket 一致：缺依赖或缺产物时加载注定失败，见那里的注释
      const skip = result.setupError !== undefined || result.needsDependencies
      const loaded = load && !skip ? [...(await deps.plugins.loadAll()).loaded] : []
      return { ...result, unloaded, loaded }
    } catch (err) {
      await restore(occupant, unloaded)
      throw fail(400, err instanceof Error ? err.message : String(err))
    }
  })

  add("DELETE", "market/:name", async req => {
    requireWritable()
    const name = req.params.name ?? ""
    // 先卸载再删除目录：若目录已删除而插件仍在内存中运行，其命令仍会响应，
    // 而重启后则不再存在 —— 此类不一致比一次失败的卸载更难排查。
    // 同样按目录定位那个插件，见 `pluginInDir`
    const occupant = pluginInDir(name)
    const unloaded =
      occupant !== undefined && deps.plugins.get(occupant) !== undefined ? await deps.plugins.unload(occupant) : false
    let removed: boolean
    try {
      removed = await market().remove(name)
    } catch (err) {
      await restore(occupant, unloaded)
      throw fail(400, err instanceof Error ? err.message : String(err))
    }
    // 目录都没删掉就别让插件白白停掉：这一支的典型成因是目录名写错，与插件本身无关
    if (!removed) {
      await restore(occupant, unloaded)
      throw fail(404, `插件目录 ${name} 不存在`)
    }
    return { name, unloaded, removed }
  })

  add("GET", "commands", () => deps.registries.commands())
  add("GET", "tasks", () => deps.registries.tasks())

  // 顺序即实际的执行顺序，不是注册顺序，见 MiddlewarePipeline.list()
  add("GET", "middlewares", () => deps.registries.middlewares())

  add("GET", "renderers", () => deps.renderers.list())

  /* ────────────────────── 适配器与账号 ────────────────────── */

  add("GET", "adapters", () => deps.adapters.list())

  // 账号配置里含连接密钥，同 GET config/:name 一样刻意不脱敏
  add("GET", "accounts", () => deps.accounts.list())

  add("GET", "accounts/:id", req => accountOf(req.params.id))

  add("POST", "accounts", async req => {
    requireWritable()
    const body = objectOf(req.body)
    const adapterId = requireString(body, "adapterId")
    const config = body.config === undefined ? {} : objectOf(body.config)
    const label = optionalString(body, "label")
    const enabled = optionalBoolean(body, "enabled") ?? true
    // 一次 create() 带上 retry，不走「先建号再 PATCH」：update() 会断开重连，
    // 那样建一个号会让它当场闪一下离线。建号时 null 无意义，按 undefined 处理
    const retry = retryOverrideOf(body) ?? undefined
    // create() 的失败几乎都是用户输入问题（适配器没装、配置字段填错），
    // 而 validateAccount 的错误信息按契约就是给用户看的 —— 一律 400
    try {
      return { status: 201, body: await deps.accounts.create(adapterId, config, label, enabled, retry) }
    } catch (err) {
      if (err instanceof SchemaError) throw err
      throw fail(400, messageOf(err))
    }
  })

  add("PATCH", "accounts/:id", async req => {
    requireWritable()
    const state = accountOf(req.params.id)
    const body = objectOf(req.body)
    const patch: { config?: unknown; label?: string; enabled?: boolean; retry?: AccountRetryOverride | null } = {}
    if (body.config !== undefined) patch.config = objectOf(body.config)
    const label = optionalString(body, "label")
    if (label !== undefined) patch.label = label
    const enabled = optionalBoolean(body, "enabled")
    if (enabled !== undefined) patch.enabled = enabled
    // 三态：不传即「这次不动它」，null 即「清掉覆盖、改回跟随全局」
    const retry = retryOverrideOf(body)
    if (retry !== undefined) patch.retry = retry
    try {
      return await deps.accounts.update(state.record.id, patch)
    } catch (err) {
      if (err instanceof SchemaError) throw err
      throw fail(400, messageOf(err))
    }
  })

  add("DELETE", "accounts/:id", async req => {
    requireWritable()
    const state = accountOf(req.params.id)
    await deps.accounts.remove(state.record.id)
    return undefined
  })

  // 连接类动作全部返回**动作之后的状态**而不是空体：面板据此立刻刷新那一行，
  // 少一次往返，也不会出现"点了连接但列表还显示离线"的错觉
  add("POST", "accounts/:id/connect", async req => {
    requireWritable()
    const state = accountOf(req.params.id)
    await deps.accounts.connect(state.record.id)
    return deps.accounts.get(state.record.id)
  })

  add("POST", "accounts/:id/disconnect", async req => {
    requireWritable()
    const state = accountOf(req.params.id)
    await deps.accounts.disconnect(state.record.id, "面板手动断开")
    return deps.accounts.get(state.record.id)
  })

  add("POST", "accounts/:id/reconnect", async req => {
    requireWritable()
    const state = accountOf(req.params.id)
    await deps.accounts.reconnect(state.record.id)
    return deps.accounts.get(state.record.id)
  })

  /* ────────────────────────── 交互式登录 ────────────────────────── */

  add("GET", "logins", () => deps.logins.list())

  add("GET", "logins/:id", req => {
    const id = req.params.id ?? ""
    const snapshot = deps.logins.snapshot(id)
    if (snapshot === undefined) throw fail(404, `登录会话 ${id} 不存在或已结束并清理`)
    return snapshot
  })

  // start() 是同步返回的：登录流程在后台跑，面板拿到初始快照后轮询或等 WS 推送。
  // 这里刻意不做成"等到登录完成才回响应" —— 扫码登录能耗上几分钟，
  // 任何一层反向代理都会先把这条请求掐断
  add("POST", "logins", req => {
    requireWritable()
    const body = objectOf(req.body)
    const adapterId = requireString(body, "adapterId")
    const mode = requireString(body, "mode")
    const label = optionalString(body, "label")
    try {
      return { status: 201, body: deps.logins.start(adapterId, mode, label) }
    } catch (err) {
      throw fail(400, messageOf(err))
    }
  })

  add("POST", "logins/:id/answer", req => {
    requireWritable()
    const id = req.params.id ?? ""
    const body = objectOf(req.body)
    const seq = body.seq
    if (typeof seq !== "number" || !Number.isInteger(seq)) throw fail(400, "字段 seq 必填，且必须是整数")
    // 答复被拒有三种原因（会话没了、当前没在提问、序号过期），共同的正确反应
    // 都是"重新读一次快照"，所以不区分状态码，只把当前快照一并回去
    const accepted = deps.logins.answer(id, seq, body.value)
    return { accepted, session: deps.logins.snapshot(id) }
  })

  add("DELETE", "logins/:id", req => {
    requireWritable()
    const id = req.params.id ?? ""
    return { cancelled: deps.logins.cancel(id), session: deps.logins.snapshot(id) }
  })

  /* ────────────────────────────── 日志 ────────────────────────────── */

  add("GET", "logs", req => {
    const level = levelOf(req.query)
    const scope = queryOf(req.query, "scope")
    const keyword = queryOf(req.query, "keyword")
    const query: { limit: number; level?: LogLevel; scope?: string; keyword?: string } = {
      limit: countOf(req.query, "limit", LOG_TAIL_DEFAULT, LOG_TAIL_MAX)
    }
    if (level !== undefined) query.level = level
    if (scope !== undefined && scope !== "") query.scope = scope
    if (keyword !== undefined && keyword !== "") query.keyword = keyword
    return { file: deps.loggerHub.file, level: deps.loggerHub.level, records: deps.loggerHub.tail(query) }
  })

  /*
   * 把当前令牌打进日志，供「令牌抄丢了、正被令牌页挡在外面」时取回
   *
   * 四条缺一不可的约定：`auth: false`（需要它的人恰恰没有令牌）、只放行回环对端
   * （同 `checkAuth` 的 `isLoopbackAddress`，且服务器强制 `trustProxy: false`）、
   * 响应体一个字节都不带令牌（`auth: false` 下任何跨站页面都能发这个请求）、
   * 以及节流（`auth: false` 同时跳过 `checkForgeableBody`，否则跨站表单 POST 能刷满日志）。
   */
  add(
    "POST",
    "token/reveal",
    req => {
      if (!isLoopbackAddress(req.ip)) {
        return { status: 403, body: { error: "只有本机可以请求把令牌打进日志" } }
      }
      const now = Date.now()
      if (now - lastReveal < REVEAL_COOLDOWN_MS) {
        return { status: 429, body: { error: "刚刚已经打过一次，请查看日志；稍后可再试" } }
      }
      lastReveal = now
      const token = deps.config.get().server.token
      if (token === undefined || token === "") {
        deps.logger.warn("面板请求显示访问令牌，但当前未设置令牌 —— 此时无需令牌即可进入")
        return { ok: true, hasToken: false }
      }
      deps.logger.warn(`面板访问令牌：${token}`)
      deps.logger.warn("这一行由「发送到日志」按钮打出。令牌亦存于配置项 server.token")
      return { ok: true, hasToken: true }
    },
    { auth: false }
  )

  // 实时日志：只推此后新产生的记录，历史请走 GET logs（见文件头第 4 条）。
  // 过滤条件放在握手的查询串里而不是靠客户端发一帧配置过来 —— 后者存在
  // "配置帧到达之前已经推了一批不该推的记录"的窗口期
  websockets.push({
    path: "logs",
    handler: (conn, req) => {
      const level = levelOf(req.query)
      const scope = queryOf(req.query, "scope")
      const keyword = queryOf(req.query, "keyword")
      const threshold = level === undefined ? undefined : LOG_LEVELS.indexOf(level)

      /** 判断一条记录是否要推给这个连接 */
      const matches = (rec: LogRecord): boolean => {
        if (threshold !== undefined && LOG_LEVELS.indexOf(rec.level) < threshold) return false
        if (scope !== undefined && scope !== "" && rec.scope !== scope) return false
        if (keyword !== undefined && keyword !== "" && !rec.msg.includes(keyword)) return false
        return true
      }

      const off = deps.loggerHub.subscribe(rec => {
        if (!conn.open) return
        if (!matches(rec)) return
        conn.send(JSON.stringify(rec))
      })
      // 必须摘：LoggerHub 的订阅者表是进程级的，连接断了还留着的话，
      // 面板每刷新一次就永久多一个订阅者，且每条日志都会往一个死 socket 上写
      conn.onClose(() => off())
    }
  })

  /* ───────────────────────── 服务器自身 ───────────────────────── */

  // 路由表是排障用的：插件说"我注册了 /plugin/foo/bar 但访问 404"时，
  // 第一件要确认的事就是它到底有没有出现在这张表里
  add("GET", "server", () => ({
    ...deps.server.info,
    readonly: deps.config.get().server.readonly,
    connections: deps.server.connections,
    routes: deps.server.listRoutes(),
    websockets: deps.server.listWebsockets(),
    static: deps.server.listStatic()
  }))

  /* ────────────────────────── 目录浏览 ────────────────────────── */

  /*
   * 只读列目录：`file` / `dir` 配置项的候选来源
   *
   * 三条面板侧边界（文件系统那侧的限制见 browse.ts 文件头）：要令牌；只读模式下禁用
   * （那时配置改不了，它只剩「让访问者看见目录树」这一个作用）；起点由前端给，
   * 不带 `path` 时 Windows 列盘符、其余系统列 `/`。
   */
  add("GET", "fs", async req => {
    if (deps.config.get().server.readonly) {
      throw fail(403, "面板处于只读模式（配置项 server.readonly 为 true），目录浏览已停用")
    }
    const result = await browseDirectory(queryOf(req.query, "path"))
    if (!result.ok) throw fail(result.status, result.message)
    return result.listing
  })

  return { routes, websockets }
}

/**
 * 将面板 API 挂载至服务器
 *
 * 接收 `ServerSink` 而非 `ManagedServer`：注册仅使用接缝中的三个方法，
 * 收窄接口使该函数可在测试中对接一个测试替身服务器。
 * @param server 服务器接缝
 * @param surface 端点清单
 * @returns 摘除全部端点的句柄；由 `App.stop()` 调用
 */
export function installApiRoutes(server: ServerSink, surface: ApiSurface): Disposer {
  const offs: Disposer[] = []
  for (const route of surface.routes) {
    offs.push(server.route(API_SCOPE, route.method, route.path, route.handler, route.options))
  }
  for (const ws of surface.websockets) {
    offs.push(server.websocket(API_SCOPE, ws.path, ws.handler))
  }
  return () => {
    // 逆序摘，且摘完清空：Disposer 本身是幂等的，但重复调用会白跑一遍查表
    for (const off of offs.reverse()) off()
    offs.length = 0
  }
}

/**
 * 构造并挂载面板 API
 *
 * `createApiRoutes` 与 `installApiRoutes` 的便捷组合，由 `kernel/app.ts` 使用。
 * @param server 服务器接缝
 * @param deps 依赖
 * @returns 摘除全部端点的句柄
 */
export function registerApi(server: ServerSink, deps: ApiDeps): Disposer {
  return installApiRoutes(server, createApiRoutes(deps))
}


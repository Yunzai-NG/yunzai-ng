/**
 * 模块职责：插件宿主 —— 导入、装配上下文、setup、卸载与热重载
 * 依赖方向：依赖 plugin/{discover,define,context,events,services,hooks}、config、store、util
 * 生命周期：应用级单例；`dispose()` 卸载全部插件
 * 注意事项：这里是「内核不依赖插件」的执行现场，四条规则 ——
 *
 *          **一个插件出问题，其余插件与内核照常工作。** 导入失败、setup 抛错、setup 超时、
 *          依赖缺失，一律降级为一条 `status = "error"` 记录，内核继续启动。
 *
 *          **卸载必须完整归还资源。** 每个插件一份 `DisposalRegistry` 与一个 `AbortController`：
 *          先 abort（停掉插件内的 fetch 与循环），再逆序回收注册，最后按 owner 兜底清扫 ——
 *          兜底是为了应对「绕过 ctx 直接调注册表」这类越界写法。
 *
 *          **依赖失败要连带处理。** `resolveLoadOrder` 只能剔除未安装的依赖；一个插件 setup
 *          失败而依赖它的照常加载，会得到更难排查的半可用状态，故 setup 前再查一次实际状态。
 *
 *          **热重载只是开发期功能。** Node 的 ESM 缓存清不掉，每次重载都会永久留下一份旧模块
 *          连同其闭包，故 `reload()` 会在日志里说明这一点。
 */
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type {
  AppView,
  CommandInfo,
  ConfigHandle,
  HttpClient,
  KvNamespace,
  Logger,
  MiddlewareInfo,
  PluginDefinition,
  PluginState,
  PluginsView,
  RuntimePaths,
  TaskInfo
} from "@yunzai-ng/types"
import { Schema } from "../config/schema.js"
import type { ConfigStore } from "../config/store.js"
import { DisposalRegistry } from "../util/dispose.js"
import { TimeoutError, withTimeout } from "../util/defer.js"
import { ensureDir } from "../util/fs.js"
import { createPluginContext, type PluginContextHandle, type PluginCounters } from "./context.js"
import { isPluginDefinition, looksLikePlugin } from "./define.js"
import { discoverPlugins, resolveLoadOrder, type PluginCandidate, type SkippedPlugin } from "./discover.js"
import type { CoreEventBus } from "./events.js"
import type { KernelHooks } from "./hooks.js"
import type { ServiceRegistry } from "./services.js"

/** setup 的默认超时（毫秒） */
const DEFAULT_SETUP_TIMEOUT = 30_000

/** 插件数据/配置的命名空间前缀 */
const KV_PREFIX = "plugin"

/**
 * 热重载击穿模块缓存用的 query 名
 *
 * 刻意不用 `v` 或 `t`：它们是 Vite/vitest 的保留 query（依赖版本号与 HMR 时间戳），
 * 会在解析时被剥掉，于是 `?v=1` 拿回来的还是缓存里那份旧模块 —— 重载看着成功，
 * 实际什么都没变。用一个带前缀的私有名字，谁都不会去动它。
 */
const RELOAD_QUERY = "yzngReload"

/**
 * 取插件版本
 *
 * `definePlugin` 中的声明优先，其次 package.json 的 `version`，两处皆无则 `0.0.0`。
 *
 * **取版本必须经此函数。** 曾出现日志只看 `definition.version`、而面板状态另有一条
 * 回落至 package.json 的取值：未在 `definePlugin` 中重复声明版本的插件（官方面板插件
 * 即是）在日志里显示为 `0.0.0`、在面板里显示为 `0.1.0`，同一进程内自相矛盾。版本号
 * 的单一事实来源应是 package.json，插件不应被要求在两处各写一遍。
 * @param definition 插件定义；无定义时（导入失败）传 undefined
 * @param candidate 候选，含 package.json
 * @returns 版本号
 */
function versionOf(definition: PluginDefinition | undefined, candidate: PluginCandidate | undefined): string {
  return definition?.version ?? candidate?.manifest?.version ?? "0.0.0"
}

/** KV 命名空间的最小契约（只用到取子空间） */
export interface KvNamespaceSource {
  /**
   * 取一个子命名空间
   * @param name 命名空间名
   * @returns KV 视图
   */
  namespace(name: string): KvNamespace
}

/** 构造插件宿主所需的依赖 */
export interface PluginHostDeps {
  /** 目录布局 */
  paths: RuntimePaths
  /** 根日志器（每个插件会派生 child） */
  logger: Logger
  /** 配置仓库 */
  config: ConfigStore
  /** KV 存储 */
  kv: KvNamespaceSource
  /** HTTP 客户端 */
  http: HttpClient
  /** 服务注册表 */
  services: ServiceRegistry
  /** 内核事件总线 */
  events: CoreEventBus
  /**
   * 子系统接缝
   *
   * 内核可以**在插件加载之后**继续往这个对象里填真实实现（服务器通常最后才起），
   * 上下文每次调用都是现取现用，所以替换会立即对已加载的插件生效。
   */
  hooks: KernelHooks
  /**
   * 取应用视图
   *
   * 刻意是函数而不是值：`AppView.plugins` 正是本宿主提供的，宿主必须先存在。
   * 加载插件时才调用，那时视图已装配完毕。
   */
  app: () => AppView
  /** 额外扫描的插件目录（绝对路径），排在默认目录之前 */
  extraDirs?: string[]
  /** 随发行版预置的插件目录（绝对路径） */
  builtinDirs?: string[]
  /** 用户禁用的插件名 */
  disabled?: readonly string[]
  /** setup 超时毫秒，缺省 30s */
  setupTimeout?: number
}

/** 一个已加载插件的内部记录 */
interface PluginRecord {
  /** 插件定义 */
  definition: PluginDefinition
  /** 来源候选 */
  candidate: PluginCandidate
  /**
   * 交给插件的上下文
   *
   * 留一份引用是为了 `runtime()`：分发器执行某条命令时要把 `e.render()`
   * 的模板根、`e.prompt()` 的卸载信号绑到**发起该命令的插件**上。
   */
  ctx: PluginContextHandle["ctx"]
  /** 回收登记簿 */
  registry: DisposalRegistry
  /** 卸载信号源 */
  abort: AbortController
  /** 注册计数（与上下文共享同一引用） */
  counters: PluginCounters
  /** 是否声明了配置（卸载时据此决定是否调用 `config.remove`） */
  hasConfig: boolean
  /** 加载耗时毫秒 */
  loadCost: number
}

/** 加载一批插件后的汇总 */
export interface LoadReport {
  /** 成功加载的插件名 */
  loaded: string[]
  /** 失败或被跳过的插件 */
  failed: SkippedPlugin[]
  /** 总耗时毫秒 */
  cost: number
}

/**
 * 将未知错误转换为一段可读描述
 * @param err 错误
 * @returns 错误描述
 */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * 插件宿主
 *
 * 线程模型：单线程；`loadAll` / `reload` / `unload` 之间用一条串行链互斥，
 * 避免"WebUI 点重载"与"文件监听触发重载"同时进来把状态搅乱。
 */
export class PluginHost {
  /** 依赖 */
  readonly #deps: PluginHostDeps
  /** 日志器 */
  readonly #logger: Logger
  /** 插件名 → 记录 */
  readonly #records = new Map<string, PluginRecord>()
  /** 插件名 → 对外状态（含失败项，故独立于 #records） */
  readonly #states = new Map<string, PluginState>()
  /** 名字 → 已知候选（供按名重载） */
  readonly #candidates = new Map<string, PluginCandidate>()
  /** 串行锁 */
  #chain: Promise<unknown> = Promise.resolve()
  /** 模块缓存击穿计数（热重载用） */
  #reloadEpoch = 0

  /**
   * @param deps 依赖
   */
  constructor(deps: PluginHostDeps) {
    this.#deps = deps
    this.#logger = deps.logger.child({ scope: "plugin" })
  }

  /** 已加载插件数 */
  get size(): number {
    return this.#records.size
  }

  /**
   * 扫描并加载全部插件
   * @returns 加载汇总
   */
  async loadAll(): Promise<LoadReport> {
    return this.#serial(() => this.#loadAll())
  }

  /**
   * 卸载一个插件
   * @param name 插件名
   * @returns 是否确实卸载了（未加载时 false）
   */
  async unload(name: string): Promise<boolean> {
    return this.#serial(() => this.#unload(name))
  }

  /**
   * 重载一个插件
   *
   * 会重新读磁盘上的代码。见文件头第 4 条：这在 Node 里必然泄漏一份旧模块，
   * 仅供开发期使用。
   * @param name 插件名
   * @returns 是否成功
   */
  async reload(name: string): Promise<boolean> {
    return this.#serial(async () => {
      const candidate = this.#candidates.get(name)
      if (!candidate) {
        this.#logger.warn(`重载失败：没有名为 ${name} 的插件`)
        return false
      }
      await this.#unload(name)
      this.#reloadEpoch++
      const definition = await this.#import(candidate)
      if (!definition) return false
      this.#logger.info(
        `插件 ${name} 已重载。提示：Node 无法卸载旧模块，反复重载会累积内存，` +
          `生产环境请重启进程`
      )
      return await this.#setup(candidate, definition)
    })
  }

  /**
   * 卸载全部插件
   *
   * 逆加载顺序卸载：先卸载依赖别人的，再卸载被依赖的。
   * @returns 卸载的插件数
   */
  async dispose(): Promise<number> {
    return this.#serial(async () => {
      const names = [...this.#records.keys()].reverse()
      for (const name of names) await this.#unload(name)
      this.#states.clear()
      this.#candidates.clear()
      return names.length
    })
  }

  /**
   * 列出全部插件状态
   * @returns 状态数组，按名字排序
   */
  list(): PluginState[] {
    return [...this.#states.values()]
      .map(state => this.#refresh(state))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * 按名取插件状态
   * @param name 插件名
   * @returns 状态；未知插件时 undefined
   */
  get(name: string): PluginState | undefined {
    const state = this.#states.get(name)
    return state ? this.#refresh(state) : undefined
  }

  /**
   * 按名取插件的运行时上下文
   *
   * 供事件分发器使用：执行某个插件的命令处理函数时，`e.render()` 要用该插件的
   * 模板根、`e.prompt()` 要用该插件的卸载信号。返回值刻意是完整的上下文而不是
   * 另包一层窄接口 —— 分发器那边的参数类型（`PluginRuntimeView`）只取三个成员，
   * 结构上天然满足，多定义一层适配器反而让"这两者必须对得上"变得不明显。
   *
   * 插件已卸载时返回 undefined：分发器据此把那条命令当作已失效跳过，
   * 而不是拿着一个 signal 已 abort 的上下文继续跑。
   * @param name 插件名
   * @returns 上下文；未加载或已卸载时 undefined
   */
  runtime(name: string): PluginContextHandle["ctx"] | undefined {
    return this.#records.get(name)?.ctx
  }

  /**
   * 将实时计数同步至状态快照
   *
   * 计数存放于 `PluginCounters` 中由上下文实时增减，状态对象仅在被查询时同步 ——
   * 以免每注册一条命令即更新一次快照。
   * @param state 状态对象
   * @returns 同一个对象（已更新）
   */
  #refresh(state: PluginState): PluginState {
    const record = this.#records.get(state.name)
    if (record) {
      state.commands = record.counters.commands
      state.middlewares = record.counters.middlewares
      state.tasks = record.counters.tasks
    }
    return state
  }

  /**
   * 串行执行，避免并发加载/卸载互相打断
   * @param fn 要执行的操作
   * @returns 操作结果
   */
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(fn, fn)
    // 挂一个空 catch 以保持链条状态正常：错误由调用方从返回的 promise 中获取
    this.#chain = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  /**
   * 扫描 → 导入 → 排序 → 依次 setup
   * @returns 加载汇总
   */
  async #loadAll(): Promise<LoadReport> {
    const startedAt = Date.now()
    const dirs = [...(this.#deps.extraDirs ?? []), this.#deps.paths.plugins, ...(this.#deps.builtinDirs ?? [])]
    const candidates = await discoverPlugins({
      dirs,
      builtinDirs: this.#deps.builtinDirs,
      disabled: this.#deps.disabled,
      logger: this.#logger
    })

    this.#logger.info(`发现 ${candidates.length} 个插件，开始导入`)

    // 导入阶段可以并发：definePlugin 是纯函数，模块顶层不该有副作用
    // （有副作用的插件本来就是 bug，且并发与否都会发生）
    const pairs = await Promise.all(
      candidates.map(async candidate => ({ candidate, definition: await this.#import(candidate) }))
    )

    const units: { name: string; dependencies?: string[]; priority?: number; pair: (typeof pairs)[number] }[] = []
    const failed: SkippedPlugin[] = []

    for (const pair of pairs) {
      if (!pair.definition) {
        failed.push({ name: pair.candidate.id, reason: this.#states.get(pair.candidate.id)?.error ?? "导入失败" })
        continue
      }
      this.#candidates.set(pair.definition.name, pair.candidate)
      const unit: { name: string; dependencies?: string[]; priority?: number; pair: (typeof pairs)[number] } = {
        name: pair.definition.name,
        pair
      }
      if (pair.definition.dependencies) unit.dependencies = pair.definition.dependencies
      if (pair.definition.priority !== undefined) unit.priority = pair.definition.priority
      units.push(unit)
    }

    const { order, skipped } = resolveLoadOrder(units)
    for (const item of skipped) {
      this.#logger.warn(`跳过插件 ${item.name}：${item.reason}`)
      this.#markFailed(item.name, item.reason, this.#candidates.get(item.name))
      failed.push(item)
    }

    const loaded: string[] = []
    for (const unit of order) {
      const definition = unit.pair.definition
      if (!definition) continue
      const ok = await this.#setup(unit.pair.candidate, definition)
      if (ok) loaded.push(definition.name)
      else failed.push({ name: definition.name, reason: this.#states.get(definition.name)?.error ?? "加载失败" })
    }

    const cost = Date.now() - startedAt
    this.#logger.info(`插件加载完成：成功 ${loaded.length} 个，失败/跳过 ${failed.length} 个，耗时 ${cost}ms`)
    return { loaded, failed, cost }
  }

  /**
   * 导入插件模块并取出定义
   *
   * 失败只记状态不抛错 —— 一个插件语法写错不该让内核起不来。
   * @param candidate 候选
   * @returns 插件定义；失败时 undefined
   */
  async #import(candidate: PluginCandidate): Promise<PluginDefinition | undefined> {
    const url = pathToFileURL(candidate.entry).href
    // 首次加载不附带 query，以保持堆栈中的路径简洁易辨识
    const spec = this.#reloadEpoch === 0 ? url : `${url}?${RELOAD_QUERY}=${this.#reloadEpoch}`

    try {
      const mod = (await import(spec)) as Record<string, unknown>
      const exported = mod["default"] ?? mod["plugin"]

      if (isPluginDefinition(exported)) return exported
      if (looksLikePlugin(exported)) {
        this.#logger.debug(`插件 ${candidate.id} 的定义没走 definePlugin，已按宽松规则接受（建议改用 definePlugin 以获得类型推导与校验）`)
        return exported
      }

      const hint =
        exported === undefined
          ? "没有默认导出。请 `export default definePlugin({ ... })`"
          : "默认导出不是插件定义。请确认用了 `definePlugin({ name, setup })`"
      this.#markFailed(candidate.id, hint, candidate)
      this.#logger.error(`插件 ${candidate.id} 导入失败：${hint}（${candidate.entry}）`)
      return undefined
    } catch (err) {
      const reason = describeError(err)
      this.#markFailed(candidate.id, reason, candidate)
      this.#logger.error(`插件 ${candidate.id} 导入出错：${reason}`, err)
      return undefined
    }
  }

  /**
   * 装配上下文并执行 setup
   * @param candidate 候选
   * @param definition 插件定义
   * @returns 是否成功
   */
  async #setup(candidate: PluginCandidate, definition: PluginDefinition): Promise<boolean> {
    const name = definition.name

    if (this.#records.has(name)) {
      this.#logger.warn(`插件 ${name} 已加载，忽略重复加载`)
      return true
    }

    // 依赖必须确实处于已加载状态：resolveLoadOrder 只保证顺序与"是否已安装"，
    // 已安装但 setup 失败的情形只能在此处拦截
    const broken = (definition.dependencies ?? []).filter(dep => this.#states.get(dep)?.status !== "loaded")
    if (broken.length > 0) {
      const reason = `依赖的插件未成功加载：${broken.join("、")}`
      this.#logger.warn(`跳过插件 ${name}：${reason}`)
      this.#markFailed(name, reason, candidate)
      return false
    }

    const startedAt = Date.now()
    const registry = new DisposalRegistry(name)
    const abort = new AbortController()

    try {
      const dataDir = await ensureDir(join(this.#deps.paths.data, KV_PREFIX, name))
      const config = await this.#defineConfig(definition)
      const { ctx, counters } = createPluginContext({
        name,
        version: versionOf(definition, candidate),
        root: candidate.dir,
        dataDir,
        logger: this.#deps.logger.child({ scope: name }),
        kv: this.#deps.kv.namespace(KV_PREFIX).sub(name),
        config: config.handle,
        app: this.#deps.app(),
        http: this.#deps.http,
        services: this.#deps.services,
        events: this.#deps.events,
        hooks: this.#deps.hooks,
        registry,
        signal: abort.signal
      })

      const timeout = this.#deps.setupTimeout ?? DEFAULT_SETUP_TIMEOUT
      const cleanup = await withTimeout(
        Promise.resolve(definition.setup(ctx)),
        timeout,
        `插件 ${name} 的 setup 超过 ${timeout}ms 未完成。setup 里不要做耗时网络请求，改用 ctx.on("app/ready")`
      )
      if (typeof cleanup === "function") registry.add(cleanup, "setup:return")

      const loadCost = Date.now() - startedAt
      this.#records.set(name, {
        definition,
        candidate,
        ctx,
        registry,
        abort,
        counters,
        hasConfig: config.declared,
        loadCost
      })
      this.#candidates.set(name, candidate)
      this.#states.set(name, this.#stateOf(definition, candidate, counters, loadCost, config.declared))

      this.#logger.info(
        `插件 ${name}@${versionOf(definition, candidate)} 已加载（${counters.commands} 条命令、` +
          `${counters.tasks} 个任务，${loadCost}ms）`
      )
      this.#deps.events.emitDetached("plugin/loaded", name)
      return true
    } catch (err) {
      const reason =
        err instanceof TimeoutError
          ? `setup 超时（${this.#deps.setupTimeout ?? DEFAULT_SETUP_TIMEOUT}ms）`
          : describeError(err)

      // 关键：setup 抛错或超时后，其已完成的注册必须回收。
      // abort 在前，使超时后仍在执行的 setup 尽快停止；registry 已回收，
      // 此后迟到的注册将被 DisposalRegistry.add 立即回收
      abort.abort()
      const failures = registry.dispose()
      for (const failure of failures) {
        this.#logger.warn(`回收插件 ${name} 的 ${failure.label} 时出错`, failure.error)
      }
      this.#deps.services.removeByOwner(name)
      this.#deps.events.removeByOwner(name)

      this.#markFailed(name, reason, candidate)
      this.#logger.error(`插件 ${name} 加载失败：${reason}`, err)
      this.#deps.events.emitDetached("plugin/error", name, err)
      return false
    }
  }

  /**
   * 卸载单个插件（不加锁，供内部调用）
   * @param name 插件名
   * @returns 是否确实卸载了
   */
  async #unload(name: string): Promise<boolean> {
    const record = this.#records.get(name)
    if (!record) return false

    this.#records.delete(name)

    // 先 abort：插件里 `while (!ctx.signal.aborted)` 的循环、传了 signal 的 fetch
    // 会立刻停下，避免它们在回收过程中还在往已拆掉的注册表里写
    record.abort.abort()

    const failures = record.registry.dispose()
    for (const failure of failures) {
      this.#logger.warn(`回收插件 ${name} 的 ${failure.label} 时出错`, failure.error)
    }

    // 兜底清扫：正常路径下二者均已由 registry 完整回收，
    // 此处防的是"插件绕过 ctx 直接取注册表注册"的越界写法
    const leakedServices = this.#deps.services.removeByOwner(name)
    if (leakedServices.length > 0) {
      this.#logger.warn(`插件 ${name} 有 ${leakedServices.length} 个服务未经 ctx 注册：${leakedServices.join("、")}`)
    }
    const leakedListeners = this.#deps.events.removeByOwner(name)
    if (leakedListeners > 0) {
      this.#logger.warn(`插件 ${name} 有 ${leakedListeners} 个事件监听未经 ctx 注册`)
    }

    // 配置声明必须解除，否则重载时 `define` 会以"已被声明"抛错
    if (record.hasConfig) this.#deps.config.remove(name)

    this.#states.delete(name)
    this.#logger.info(`插件 ${name} 已卸载`)
    this.#deps.events.emitDetached("plugin/unloaded", name)
    return true
  }

  /**
   * 声明插件配置
   *
   * 没声明 `configSchema` 的插件也要有一个可用的 `ctx.config`：
   * 让它 `get()` 返回空对象，比让插件作者判空好 —— 配置是不是空取决于用户，
   * 插件代码不该为此分叉。
   * @param definition 插件定义
   * @returns 配置句柄与"是否真的声明了"
   */
  async #defineConfig(definition: PluginDefinition): Promise<{
    /** 配置句柄 */
    handle: ConfigHandle<unknown>
    /** 是否真的声明了配置 */
    declared: boolean
  }> {
    const schema = definition.configSchema
    if (!(schema instanceof Schema)) {
      if (schema !== undefined) {
        this.#logger.warn(
          `插件 ${definition.name} 的 configSchema 不是 s.object(...) 的产物，已忽略。` +
            `请从 @yunzai-ng/core 导入 s 来构造`
        )
      }
      return { handle: emptyConfigHandle(), declared: false }
    }

    const handle = await this.#deps.config.define(definition.name, schema as Schema<unknown>, {
      title: definition.description ?? definition.name,
      notes: [`插件 ${definition.name}${definition.version ? `@${definition.version}` : ""} 的配置`]
    })
    return { handle, declared: true }
  }

  /**
   * 记录一个加载失败的插件
   * @param name 插件名
   * @param reason 失败原因
   * @param candidate 候选（有则能填出目录与内置标记）
   */
  #markFailed(name: string, reason: string, candidate?: PluginCandidate): void {
    this.#states.set(name, {
      name,
      version: versionOf(undefined, candidate),
      root: candidate?.dir ?? "",
      status: "error",
      error: reason,
      loadCost: 0,
      commands: 0,
      tasks: 0,
      middlewares: 0,
      builtin: candidate?.builtin ?? false,
      configured: false
    })
  }

  /**
   * 组装成功加载后的状态快照
   * @param definition 插件定义
   * @param candidate 候选
   * @param counters 计数
   * @param loadCost 加载耗时
   * @param configured 是否声明了配置 schema
   * @returns 状态快照
   */
  #stateOf(
    definition: PluginDefinition,
    candidate: PluginCandidate,
    counters: PluginCounters,
    loadCost: number,
    configured: boolean
  ): PluginState {
    const manifest = candidate.manifest
    const author =
      definition.author ?? (typeof manifest?.author === "string" ? manifest.author : manifest?.author?.name)

    const state: PluginState = {
      name: definition.name,
      version: versionOf(definition, candidate),
      root: candidate.dir,
      status: "loaded",
      loadCost,
      commands: counters.commands,
      tasks: counters.tasks,
      middlewares: counters.middlewares,
      builtin: candidate.builtin,
      configured
    }
    const description = definition.description ?? manifest?.description
    if (description !== undefined) state.description = description
    if (author !== undefined) state.author = author
    // 取不到主页时**不写这个字段**：面板据其有无决定要不要画「访问仓库」，
    // 写一个空串会让按钮出现而点了没反应
    const homepage = definition.homepage ?? (typeof manifest?.homepage === "string" ? manifest.homepage : undefined)
    if (homepage !== undefined && homepage !== "") state.homepage = homepage
    return state
  }
}

/**
 * 构造一个"没有配置"的配置句柄
 *
 * 所有写操作都抛错并指明办法：静默成功会让插件作者以为配置存进去了。
 * @returns 空配置句柄
 */
function emptyConfigHandle(): ConfigHandle<unknown> {
  /** 统一拒绝写操作 */
  const reject = (): Promise<never> =>
    Promise.reject(
      new Error("本插件没有声明 configSchema，无法写配置。请在 definePlugin 里加上 configSchema: s.object({...})")
    )

  return {
    file: "",
    schema: { type: "object", properties: {} },
    get: () => ({}),
    patch: reject,
    replace: reject,
    reset: reject,
    onChange: () => () => undefined
  }
}

/** 命令与任务的查询入口（由路由器与调度器提供） */
export interface RegistryInspectors {
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

/**
 * 组装 `AppView.plugins`
 *
 * 插件状态在宿主这里，命令与任务清单在路由器/调度器那里；视图把两边拼起来，
 * 免得内核里到处传三个对象。
 * @param host 插件宿主
 * @param inspectors 命令与任务查询入口
 * @returns 插件视图
 */
export function createPluginsView(host: PluginHost, inspectors: RegistryInspectors): PluginsView {
  return {
    list: () => host.list(),
    get: (name: string) => host.get(name),
    commands: () => inspectors.commands(),
    tasks: () => inspectors.tasks(),
    middlewares: () => inspectors.middlewares()
  }
}

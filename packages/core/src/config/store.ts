/**
 * 模块职责：配置仓库（YAML 落盘、schema 校验、细粒度变更通知、外部改动热加载）
 * 依赖方向：依赖 config/schema、config/yaml、util/{fs,deep}、类型包
 * 生命周期：应用级单例；`dispose()` 关闭文件监听
 * 注意事项：四条行为约定 ——
 *          1) 变更通知按叶子路径：`diffPaths` 算出实际变化的路径，只通知关注它的订阅者
 *          2) 写入走 `atomicWrite`（临时文件 + rename），否则断电或强杀会留下截断的 YAML
 *          3) 配置写坏了不崩：记录错误、退回上一份可用配置（首次加载则用缺省值），且绝不
 *             覆盖使用者那份坏文件
 *          4) 新增配置项会补进既有文件：校验通过后按当前 schema 重写，新选项连同中文注释
 *             一并补入，幂等 —— 否则升级之后新选项在使用者的配置里根本看不见
 */
import { watch, type FSWatcher } from "node:fs"
import { basename, join } from "node:path"
import type { ConfigChange, ConfigHandle, DeepPartial, DeepReadonly, Disposer, Logger, SchemaDescriptor } from "@yunzai-ng/types"
import { atomicWrite, ensureDir, readText } from "../util/fs.js"
import { deepClone, deepMerge, diffPaths, pathAffects, type PlainObject } from "../util/deep.js"
import { SchemaError, type Schema, type SchemaIssue } from "./schema.js"
import { parseYaml, serializeYaml } from "./yaml.js"

/** 配置名的合法形式：小写字母开头，可含数字、点、横线、下划线 */
const NAME_RE = /^[a-z][a-z0-9._-]*$/i

/** 外部改动的合并窗口（毫秒）：编辑器保存常触发多次 fs 事件 */
const RELOAD_DEBOUNCE = 200

/** 配置仓库参数 */
export interface ConfigStoreOptions {
  /** 配置目录（绝对路径） */
  dir: string
  /** 日志器 */
  logger: Logger
  /** 是否监听文件外部改动，缺省 true */
  watch?: boolean
}

/** 声明配置时的附加信息 */
export interface DefineConfigOptions {
  /** 文件头注释里显示的名字，缺省用配置名 */
  title?: string
  /** 额外的文件头说明行 */
  notes?: string[]
}

/** 配置文件的对外快照信息（WebUI 列表用） */
export interface ConfigSummary {
  /** 配置名 */
  name: string
  /** 文件绝对路径 */
  file: string
  /** 显示标题 */
  title: string
  /** 表单描述 */
  schema: SchemaDescriptor
}

/**
 * 单个配置文件的句柄
 *
 * 由 `ConfigStore.define()` 创建，插件通过 `ctx.config` 拿到它。
 */
export class ConfigFile<T> implements ConfigHandle<T> {
  /** 配置名 */
  readonly name: string
  /** 文件绝对路径 */
  readonly file: string
  /** 表单描述 */
  readonly schema: SchemaDescriptor
  /** 显示标题 */
  readonly title: string

  /** 校验用的 schema */
  readonly #validator: Schema<T>
  /** 日志器 */
  readonly #logger: Logger
  /** 文件头注释 */
  readonly #header: string[]
  /** 当前值 */
  #value: T
  /** 变更订阅者 */
  readonly #subscribers = new Set<(change: ConfigChange<T>) => void>()
  /** 按路径订阅者 */
  readonly #watchers = new Set<{ path: string; cb: (change: ConfigChange<T>) => void }>()
  /** 最近一次由自己写出的文本，用于识别"这次改动是我自己造成的" */
  #lastWritten: string | undefined

  /**
   * @param params 构造参数
   */
  constructor(params: {
    /** 配置名 */
    name: string
    /** 文件路径 */
    file: string
    /** 校验 schema */
    validator: Schema<T>
    /** 初始值 */
    value: T
    /** 日志器 */
    logger: Logger
    /** 显示标题 */
    title: string
    /** 文件头注释 */
    header: string[]
  }) {
    this.name = params.name
    this.file = params.file
    this.title = params.title
    this.#validator = params.validator
    this.schema = params.validator.describe()
    this.#value = params.value
    this.#logger = params.logger
    this.#header = params.header
  }

  /**
   * 取当前配置快照
   * @returns 只读快照；未发生变更时多次调用返回同一对象
   */
  get(): DeepReadonly<T> {
    return this.#value as unknown as DeepReadonly<T>
  }

  /**
   * 局部更新并落盘
   * @param patch 深合并的补丁
   * @param source 变更来源，WebUI 保存时传 `"webui"`，缺省 `"api"`
   * @returns 更新后的快照
   * @throws SchemaError 校验失败，此时原配置不变、文件不变
   */
  async patch(patch: DeepPartial<T>, source: ConfigChange<T>["source"] = "api"): Promise<DeepReadonly<T>> {
    const merged = deepMerge(this.#value as unknown as PlainObject, patch as unknown as PlainObject)
    return this.#commit(merged, source)
  }

  /**
   * 整体替换并落盘
   * @param value 完整配置
   * @param source 变更来源，缺省 `"api"`
   * @returns 更新后的快照
   * @throws SchemaError 校验失败
   */
  async replace(value: T, source: ConfigChange<T>["source"] = "api"): Promise<DeepReadonly<T>> {
    return this.#commit(value, source)
  }

  /**
   * 恢复默认值并落盘
   * @param source 变更来源，缺省 `"api"`
   * @returns 更新后的快照
   */
  async reset(source: ConfigChange<T>["source"] = "api"): Promise<DeepReadonly<T>> {
    return this.#commit(this.#validator.defaults(), source)
  }

  /**
   * 订阅变更
   * @param cb 回调；抛错只记日志，不影响其他订阅者
   * @returns 取消订阅
   */
  onChange(cb: (change: ConfigChange<T>) => void): Disposer {
    this.#subscribers.add(cb)
    return () => void this.#subscribers.delete(cb)
  }

  /**
   * 只订阅某个路径（及其子路径）的变更
   *
   * 父子路径双向匹配：改 `bot` 会通知订阅 `bot.masterQQ` 的一方，反之亦然。
   * @param path 点分路径，空串等价于 `onChange`
   * @param cb 回调
   * @returns 取消订阅
   */
  watch(path: string, cb: (change: ConfigChange<T>) => void): Disposer {
    const entry = { path, cb }
    this.#watchers.add(entry)
    return () => void this.#watchers.delete(entry)
  }

  /**
   * 从磁盘加载
   *
   * 出错时保留当前值并返回问题列表，**不会**抛错也**不会**覆盖磁盘文件。
   * @param source 变更来源，用于变更事件
   * @param createIfMissing 文件不存在时是否写出默认配置
   * @returns 校验问题列表（可能只含 warn）
   */
  async load(source: ConfigChange<T>["source"], createIfMissing: boolean): Promise<SchemaIssue[]> {
    const text = await readText(this.file)

    if (text === undefined) {
      const value = this.#validator.defaults()
      this.#value = value
      if (createIfMissing) await this.#write(value)
      return []
    }

    // 自己刚写出去的内容，跳过重复解析
    if (text === this.#lastWritten) return []

    let raw: unknown
    try {
      raw = parseYaml(text)
    } catch (err) {
      this.#logger.error(`配置 ${this.name} 的 YAML 语法有误，已沿用上一份可用配置`, err)
      return [{ path: "", message: err instanceof Error ? err.message : String(err), severity: "error" }]
    }

    const result = this.#validator.safeParse(raw)
    if (!result.ok) {
      this.#logger.error(`配置 ${this.name} 校验失败，已沿用上一份可用配置：\n${formatIssues(result.issues)}`)
      return result.issues
    }

    for (const issue of result.issues) {
      this.#logger.warn(`配置 ${this.name} 的 ${issue.path}：${issue.message}`)
    }

    const prev = this.#value
    this.#value = result.value

    // 按当前 schema 回写：补上新增选项与注释。序列化是确定性的，故此操作幂等。
    const canonical = this.#render(result.value)
    if (canonical !== text) await this.#write(result.value)

    const paths = diffPaths(prev, result.value)
    if (paths.length > 0) this.#emit(prev, result.value, paths, source)

    return result.issues
  }

  /**
   * 校验、落盘、通知
   * @param candidate 候选值
   * @param source 变更来源
   * @returns 新快照
   * @throws SchemaError 校验失败
   */
  async #commit(candidate: unknown, source: ConfigChange<T>["source"]): Promise<DeepReadonly<T>> {
    const result = this.#validator.safeParse(candidate)
    if (!result.ok) throw new SchemaError(result.issues)

    const prev = this.#value
    const next = result.value
    const paths = diffPaths(prev, next)

    // 无实质变化就不写盘，避免 WebUI 里点一下保存就产生一次磁盘写入与一轮通知
    if (paths.length === 0) return this.get()

    this.#value = next
    await this.#write(next)
    this.#emit(prev, next, paths, source)
    return this.get()
  }

  /**
   * 序列化为 YAML 文本
   * @param value 配置值
   * @returns YAML 文本
   */
  #render(value: T): string {
    return serializeYaml(value, { header: this.#header, descriptor: this.schema })
  }

  /**
   * 原子写盘
   * @param value 配置值
   */
  async #write(value: T): Promise<void> {
    const text = this.#render(value)
    this.#lastWritten = text
    await atomicWrite(this.file, text)
  }

  /**
   * 派发变更事件
   * @param prev 旧值
   * @param next 新值
   * @param paths 变化路径
   * @param source 变更来源
   */
  #emit(prev: T, next: T, paths: string[], source: ConfigChange<T>["source"]): void {
    const change: ConfigChange<T> = {
      prev: prev as unknown as DeepReadonly<T>,
      next: next as unknown as DeepReadonly<T>,
      paths,
      source
    }

    for (const cb of this.#subscribers) this.#invoke(cb, change)
    for (const entry of this.#watchers) {
      if (paths.some(p => pathAffects(p, entry.path))) this.#invoke(entry.cb, change)
    }
  }

  /**
   * 调用订阅回调并隔离错误
   * @param cb 回调
   * @param change 变更事件
   */
  #invoke(cb: (change: ConfigChange<T>) => void, change: ConfigChange<T>): void {
    try {
      cb(change)
    } catch (err) {
      this.#logger.error(`配置 ${this.name} 的变更回调抛错`, err)
    }
  }
}

/**
 * 把校验问题列成多行文本
 * @param issues 问题列表
 * @returns 多行文本
 */
function formatIssues(issues: readonly SchemaIssue[]): string {
  return issues.map(i => `  · ${i.path === "" ? "(根)" : i.path}：${i.message}`).join("\n")
}

/**
 * 配置仓库
 *
 * 一个进程一个实例，管住 `config/` 目录下所有 YAML 与唯一一个目录监听器。
 */
export class ConfigStore {
  /** 配置目录 */
  readonly #dir: string
  /** 日志器 */
  readonly #logger: Logger
  /** 是否监听外部改动 */
  readonly #watchEnabled: boolean
  /** 名字 → 配置文件 */
   
  readonly #files = new Map<string, ConfigFile<any>>()
  /** 目录监听器 */
  #watcher: FSWatcher | undefined
  /** 重载去抖定时器 */
  readonly #timers = new Map<string, NodeJS.Timeout>()

  /**
   * @param opts 仓库参数
   */
  constructor(opts: ConfigStoreOptions) {
    this.#dir = opts.dir
    this.#logger = opts.logger.child({ scope: "config" })
    this.#watchEnabled = opts.watch !== false
  }

  /** 配置目录 */
  get dir(): string {
    return this.#dir
  }

  /**
   * 声明一份配置
   *
   * 同名重复声明抛错，不让后者悄悄覆盖前者。
   * @param name 配置名，同时是文件名（`<name>.yaml`）
   * @param validator schema
   * @param opts 附加信息
   * @returns 配置句柄
   * @throws 名字非法或重复声明时
   */
  async define<T>(name: string, validator: Schema<T>, opts: DefineConfigOptions = {}): Promise<ConfigFile<T>> {
    if (!NAME_RE.test(name)) throw new Error(`配置名 ${name} 不合法：需以字母开头，只含字母数字与 . - _`)
    if (this.#files.has(name)) throw new Error(`配置 ${name} 已被声明，请换个名字`)

    await ensureDir(this.#dir)

    const title = opts.title ?? name
    const header = [
      `Yunzai NG 配置：${title}`,
      "本文件由 schema 自动生成：保存时会重建注释，但不会丢弃任何配置值。",
      "可以直接手改，保存后框架会自动重新加载；改错了会在日志里指出具体字段。",
      ...(opts.notes ?? [])
    ]

    const file = new ConfigFile<T>({
      name,
      file: join(this.#dir, `${name}.yaml`),
      validator,
      value: validator.defaults(),
      logger: this.#logger,
      title,
      header
    })

    this.#files.set(name, file)
    await file.load("default", true)
    return file
  }

  /**
   * 取已声明的配置
   * @param name 配置名
   * @returns 配置句柄；未声明时 undefined
   */
  get(name: string): ConfigFile<any> | undefined {
    return this.#files.get(name)
  }

  /**
   * 移除一份配置声明（插件卸载时调用）
   *
   * 只解除内存中的登记，不删磁盘文件 —— 插件重装后配置还在。
   * @param name 配置名
   */
  remove(name: string): void {
    this.#files.delete(name)
  }

  /**
   * 列出全部配置
   * @returns 配置摘要数组，按名字排序
   */
  list(): ConfigSummary[] {
    return [...this.#files.values()]
      .map(file => ({ name: file.name, file: file.file, title: file.title, schema: file.schema }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * 开始监听配置目录
   *
   * 监听**目录**而不是每个文件：原子写用的是 rename，被替换的文件 inode 会变，
   * 盯着文件的 watcher 在 Windows 上会失效。顺带只需一个监听器。
   * @returns 取消监听
   */
  startWatching(): Disposer {
    if (!this.#watchEnabled || this.#watcher) return () => undefined

    try {
      // persistent: false —— 配置监听不应该拖着进程不让退出
      this.#watcher = watch(this.#dir, { persistent: false }, (_event, filename) => {
        if (!filename) return
        const base = basename(String(filename))
        const match = /^(.+)\.ya?ml$/i.exec(base)
        if (!match) return // 原子写留下的 .tmp-xxxx 之类，忽略
        this.#scheduleReload(match[1]!)
      })
      this.#watcher.on("error", err => this.#logger.warn("配置目录监听出错，热加载已停止", err))
    } catch (err) {
      this.#logger.warn("无法监听配置目录，配置将只在启动时加载", err)
    }

    return () => this.dispose()
  }

  /** 停止监听并清理定时器 */
  dispose(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer)
    this.#timers.clear()
    this.#watcher?.close()
    this.#watcher = undefined
  }

  /**
   * 去抖后重载某个配置
   * @param name 配置名
   */
  #scheduleReload(name: string): void {
    const file = this.#files.get(name)
    if (!file) return

    const existing = this.#timers.get(name)
    if (existing) clearTimeout(existing)

    const timer = setTimeout(() => {
      this.#timers.delete(name)
      void file
        .load("file", false)
        .then(issues => {
          if (issues.some(i => i.severity === "error")) return
          this.#logger.info(`配置 ${name} 已重新加载`)
        })
        .catch((err: unknown) => this.#logger.error(`重新加载配置 ${name} 失败`, err))
    }, RELOAD_DEBOUNCE)

    if (typeof timer.unref === "function") timer.unref()
    this.#timers.set(name, timer)
  }
}

/**
 * 创建配置仓库
 * @param opts 仓库参数
 * @returns 配置仓库
 */
export function createConfigStore(opts: ConfigStoreOptions): ConfigStore {
  return new ConfigStore(opts)
}

/** 深拷贝一份配置快照，供需要可变副本的场景使用 */
export const cloneConfig = deepClone

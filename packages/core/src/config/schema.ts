/**
 * 模块职责：配置 schema 构造器（校验 + WebUI 表单描述，一份声明两处产出）
 * 依赖方向：依赖类型包与 util/deep、util/duration
 * 生命周期：schema 对象不可变，可自由复用与共享
 * 注意事项：**为什么自己写而不用 zod**：面板要把 schema 降级成表单描述，而 zod 只能读 `_def`
 *          反推、版本一升就碎；内核要跑在 Termux 上，少一个运行时依赖就少一次装包失败；
 *          配置是人手写的 YAML，需要「字符串 '8080' 当端口」这类宽容转换，而 zod 的 coerce
 *          是全局开关、粒度不够。
 *
 *          三条刻意的语义：**数组整体替换**不逐元素合并（见 util/deep）；**缺失的对象节点按
 *          子字段默认值物化**，故用户只写关心的几个键即可；**未识别的键保留但报 warn**，
 *          不静默丢弃 —— 静默丢弃会让拼错的配置项改半天没反应。
 */
import type { IssueSeverity, SchemaDescriptor, SchemaEnumItem, SchemaIssue, SchemaWidget } from "@yunzai-ng/types"
import { deepClone, isPlainObject } from "../util/deep.js"
import { parseDuration } from "../util/duration.js"

// `SchemaIssue` 定义在类型包：面板前端也要消费它（400 响应体里的 issues 数组），
// 而前端不许依赖内核。这里转发出去，使用者仍可从 @yunzai-ng/core 拿到
export type { IssueSeverity, SchemaIssue } from "@yunzai-ng/types"

/** 校验结果 */
export type ParseResult<T> =
  | {
      /** 校验通过 */
      ok: true
      /** 已填充默认值、已强制转换的结果 */
      value: T
      /** 非致命问题（如未识别的键） */
      issues: SchemaIssue[]
    }
  | {
      /** 校验失败 */
      ok: false
      /** 全部问题 */
      issues: SchemaIssue[]
    }

/** 校验失败抛出的错误 */
export class SchemaError extends Error {
  /** 错误名 */
  override readonly name = "SchemaError"
  /** 全部问题 */
  readonly issues: readonly SchemaIssue[]

  /**
   * @param issues 校验问题列表
   */
  constructor(issues: readonly SchemaIssue[]) {
    const lines = issues
      .filter(i => i.severity === "error")
      .map(i => `  · ${i.path === "" ? "(根)" : i.path}：${i.message}`)
    super(`配置校验失败：\n${lines.join("\n")}`)
    this.issues = issues
  }
}

/** 校验失败的哨兵值 */
const INVALID = Symbol("invalid")

/** 表单元信息 */
interface SchemaMeta {
  /** 表单标签 */
  title?: string
  /** 说明文案 */
  description?: string
  /** 是否敏感 */
  secret?: boolean
  /** 是否只读 */
  readonly?: boolean
  /** 控件类型 */
  widget?: SchemaWidget
  /** 分组 */
  group?: string
  /** 排序权重 */
  order?: number
  /** 占位符 */
  placeholder?: string
  /** 条件显隐 */
  showWhen?: Record<string, unknown>
}

/** 内部定义结构 */
interface SchemaDef {
  /** 节点类型 */
  kind: "string" | "number" | "boolean" | "enum" | "literal" | "array" | "object" | "record" | "unknown"
  /** 表单元信息 */
  meta: SchemaMeta
  /** 是否可缺省 */
  optional?: boolean
  /** 是否有默认值 */
  hasDefault?: boolean
  /** 默认值 */
  defaultValue?: unknown
  /** 下界（数值大小 / 字符串长度 / 数组长度） */
  min?: number
  /** 上界 */
  max?: number
  /** 字符串正则 */
  pattern?: RegExp
  /** 字符串是否自动去首尾空白，缺省 true */
  trim?: boolean
  /**
   * 字符串节点是否允许保留数值形态
   *
   * 仅 `duration()` 使用：时长既可写 `"30s"` 也可写 `30000`，两种写法都要
   * 原样保留 —— 若统一转成字符串，配置文件里的 `cooldown: 0` 会被改写成
   * `cooldown: '0'`，用户会以为框架在乱改自己的文件。
   */
  allowNumber?: boolean
  /** 数值是否必须为整数 */
  int?: boolean
  /** 数值步长（仅表单提示） */
  step?: number
  /** 枚举候选 */
  enumItems?: SchemaEnumItem[]
  /** 字面量值 */
  literalValue?: unknown
  /** 数组元素 schema */
   
  element?: Schema<any>
  /** 单值是否自动包成数组 */
  wrapSingle?: boolean
  /** 对象字段表 */
   
  shape?: Record<string, Schema<any>>
  /** 是否拒绝未识别的键 */
  strict?: boolean
  /** record 的值 schema */
   
  valueSchema?: Schema<any>
  /** 自定义校验 */
  checks?: { message: string; test: (value: never) => boolean }[]
}

/**
 * 配置 schema 节点
 *
 * 不可变：全部 fluent 方法均返回新实例，因此可安全地抽取公共片段以供复用。
 */
export class Schema<T> {
  /** 内部定义 */
  readonly #def: SchemaDef

  /**
   * @param def 内部定义；请通过 `s.*` 工厂函数创建，不要直接 new
   */
  constructor(def: SchemaDef) {
    this.#def = def
  }

  /* ───────────────────────────── 元信息 ───────────────────────────── */

  /**
   * 设置表单标签
   * @param text 标签文案
   * @returns 新 schema
   */
  title(text: string): Schema<T> {
    return this.#patch({ meta: { title: text } })
  }

  /**
   * 设置说明文案
   * @param text 说明
   * @returns 新 schema
   */
  desc(text: string): Schema<T> {
    return this.#patch({ meta: { description: text } })
  }

  /**
   * 设置分组（WebUI 折叠区块）
   * @param name 分组名
   * @returns 新 schema
   */
  group(name: string): Schema<T> {
    return this.#patch({ meta: { group: name } })
  }

  /**
   * 设置排序权重，小的在前
   * @param weight 权重
   * @returns 新 schema
   */
  order(weight: number): Schema<T> {
    return this.#patch({ meta: { order: weight } })
  }

  /**
   * 指定控件类型
   * @param widget 控件
   * @returns 新 schema
   */
  widget(widget: SchemaWidget): Schema<T> {
    return this.#patch({ meta: { widget } })
  }

  /**
   * 标记为敏感字段
   *
   * WebUI 读取时脱敏、日志中不打印。CK、token、密码必须标。
   * @returns 新 schema
   */
  secret(): Schema<T> {
    return this.#patch({ meta: { secret: true, widget: this.#def.meta.widget ?? "password" } })
  }

  /**
   * 标记为只读
   * @returns 新 schema
   */
  readonly(): Schema<T> {
    return this.#patch({ meta: { readonly: true } })
  }

  /**
   * 设置输入框占位符
   * @param text 占位文案
   * @returns 新 schema
   */
  placeholder(text: string): Schema<T> {
    return this.#patch({ meta: { placeholder: text } })
  }

  /**
   * 设置条件显隐
   * @param cond 同级字段取值条件，如 `{ mode: "ws-reverse" }`；值写成数组表示"取其中之一"
   * @returns 新 schema
   */
  showWhen(cond: Record<string, unknown>): Schema<T> {
    return this.#patch({ meta: { showWhen: cond } })
  }

  /* ───────────────────────────── 可选与默认 ───────────────────────────── */

  /**
   * 标记为可缺省
   * @returns 新 schema，输出类型带上 undefined
   */
  optional(): Schema<T | undefined> {
    return this.#patch<T | undefined>({ optional: true })
  }

  /**
   * 设置默认值
   *
   * 有默认值的字段在输出类型里仍是必填 —— 因为解析后一定有值。
   * @param value 默认值
   * @returns 新 schema
   */
  default(value: T): Schema<T> {
    return this.#patch({ hasDefault: true, defaultValue: value })
  }

  /**
   * 追加自定义校验
   * @param message 不通过时的中文提示
   * @param test 返回 true 表示通过
   * @returns 新 schema
   */
  check(message: string, test: (value: T) => boolean): Schema<T> {
    const checks = [...(this.#def.checks ?? []), { message, test: test as (value: never) => boolean }]
    return this.#patch({ checks })
  }

  /* ───────────────────────────── 约束 ───────────────────────────── */

  /**
   * 下界：数值最小值 / 字符串最短长度 / 数组最少元素
   * @param value 下界
   * @returns 新 schema
   */
  min(value: number): Schema<T> {
    return this.#patch({ min: value })
  }

  /**
   * 上界：数值最大值 / 字符串最长长度 / 数组最多元素
   * @param value 上界
   * @returns 新 schema
   */
  max(value: number): Schema<T> {
    return this.#patch({ max: value })
  }

  /**
   * 字符串正则约束
   * @param regex 正则
   * @param message 自定义提示
   * @returns 新 schema
   */
  pattern(regex: RegExp, message?: string): Schema<T> {
    const next = this.#patch<T>({ pattern: regex })
    return message ? next.check(message, v => typeof v !== "string" || regex.test(v)) : next
  }

  /**
   * 要求整数
   * @returns 新 schema
   */
  int(): Schema<T> {
    return this.#patch({ int: true, step: this.#def.step ?? 1 })
  }

  /**
   * 数值步长（表单提示用）
   * @param value 步长
   * @returns 新 schema
   */
  step(value: number): Schema<T> {
    return this.#patch({ step: value })
  }

  /**
   * 对象：拒绝未识别的键
   *
   * 缺省行为是"保留并 warn"，适配器这类结构明确的配置可以开严格模式。
   * @returns 新 schema
   */
  strict(): Schema<T> {
    return this.#patch({ strict: true })
  }

  /**
   * 数组：允许单值自动包成数组
   *
   * 让 `masterQQ: 123` 与 `masterQQ: [123]` 都能用 —— 旧配置最常见的困惑点。
   * @returns 新 schema
   */
  single(): Schema<T> {
    return this.#patch({ wrapSingle: true })
  }

  /* ───────────────────────────── 解析 ───────────────────────────── */

  /**
   * 解析并校验
   * @param input 待校验值
   * @returns 结果对象；失败时带全部问题，不抛错
   */
  safeParse(input: unknown): ParseResult<T> {
    const issues: SchemaIssue[] = []
    const value = this.#validate(input, "", issues)
    const failed = value === INVALID || issues.some(i => i.severity === "error")
    return failed ? { ok: false, issues } : { ok: true, value: value as T, issues }
  }

  /**
   * 解析并校验，失败抛错
   * @param input 待校验值
   * @returns 校验后的值（已填默认、已强制转换）
   * @throws SchemaError 校验失败
   */
  parse(input: unknown): T {
    const result = this.safeParse(input)
    if (!result.ok) throw new SchemaError(result.issues)
    return result.value
  }

  /**
   * 只取默认值，不需要输入
   *
   * 用于生成初始配置文件。
   * @returns 全部默认值构成的对象
   * @throws SchemaError 当 schema 里有无默认值的必填项
   */
  defaults(): T {
    return this.parse(undefined)
  }

  /**
   * 降级为 WebUI 表单描述
   * @returns 表单描述结构体
   */
  describe(): SchemaDescriptor {
    const def = this.#def
    const out: SchemaDescriptor = { type: this.#descriptorType() }

    if (def.meta.title !== undefined) out.title = def.meta.title
    if (def.meta.description !== undefined) out.description = def.meta.description
    if (def.hasDefault) out.default = deepClone(def.defaultValue)
    if (!def.optional && !def.hasDefault) out.required = true
    if (def.meta.secret) out.secret = true
    if (def.meta.readonly) out.readonly = true
    if (def.meta.widget !== undefined) out.widget = def.meta.widget
    if (def.meta.group !== undefined) out.group = def.meta.group
    if (def.meta.order !== undefined) out.order = def.meta.order
    if (def.meta.placeholder !== undefined) out.placeholder = def.meta.placeholder
    if (def.meta.showWhen !== undefined) out.showWhen = def.meta.showWhen
    if (def.min !== undefined) out.min = def.min
    if (def.max !== undefined) out.max = def.max
    if (def.step !== undefined) out.step = def.step
    if (def.pattern !== undefined) out.pattern = def.pattern.source

    if (def.kind === "object" && def.shape) {
      const properties: Record<string, SchemaDescriptor> = {}
      for (const [key, child] of Object.entries(def.shape)) properties[key] = child.describe()
      out.properties = properties
    }
    if (def.kind === "array" && def.element) out.items = def.element.describe()
    if (def.kind === "record" && def.valueSchema) out.values = def.valueSchema.describe()
    if (def.kind === "enum" && def.enumItems) out.enum = def.enumItems.map(item => ({ ...item }))
    if (def.kind === "literal") out.enum = [{ value: def.literalValue as string }]

    return out
  }

  /**
   * 对象 schema：取子字段 schema
   * @param key 字段名
   * @returns 子 schema；不是对象或字段不存在时 undefined
   */
   
  /**
   *
   */
  field(key: string): Schema<any> | undefined {
    return this.#def.shape?.[key]
  }

  /**
   * 收集全部标了 `secret()` 的字段路径
   *
   * 日志脱敏与 WebUI 读取脱敏都用它，保证"标一次、处处生效"。
   * @returns 点分路径列表
   */
  secretPaths(): string[] {
    const out: string[] = []
    this.#collectSecrets("", out)
    return out
  }

  /* ───────────────────────────── 内部 ───────────────────────────── */

  /**
   * 克隆并打补丁
   * @param patch 要覆盖的定义片段
   * @returns 新 schema
   */
  #patch<U = T>(patch: Partial<SchemaDef> & { meta?: SchemaMeta }): Schema<U> {
    return new Schema<U>({
      ...this.#def,
      ...patch,
      meta: { ...this.#def.meta, ...(patch.meta ?? {}) }
    })
  }

  /**
   * 映射到表单描述的类型名
   * @returns 描述类型
   */
  #descriptorType(): SchemaDescriptor["type"] {
    switch (this.#def.kind) {
      case "literal":
        return "enum"
      case "string":
      case "number":
      case "boolean":
      case "enum":
      case "array":
      case "object":
      case "record":
        return this.#def.kind
      default:
        return "unknown"
    }
  }

  /**
   * 递归收集敏感字段路径
   * @param prefix 当前路径前缀
   * @param out 收集容器
   */
  #collectSecrets(prefix: string, out: string[]): void {
    if (this.#def.meta.secret) out.push(prefix)
    if (this.#def.shape) {
      for (const [key, child] of Object.entries(this.#def.shape)) {
        child.#collectSecrets(prefix === "" ? key : `${prefix}.${key}`, out)
      }
    }
    if (this.#def.element) this.#def.element.#collectSecrets(prefix === "" ? "*" : `${prefix}.*`, out)
    if (this.#def.valueSchema) this.#def.valueSchema.#collectSecrets(prefix === "" ? "*" : `${prefix}.*`, out)
  }

  /**
   * 记录一条问题
   * @param issues 收集容器
   * @param path 路径
   * @param message 说明
   * @param severity 严重程度
   */
  #fail(issues: SchemaIssue[], path: string, message: string, severity: IssueSeverity = "error"): void {
    issues.push({ path, message, severity })
  }

  /**
   * 核心校验
   * @param input 输入值
   * @param path 当前路径
   * @param issues 问题收集容器
   * @returns 校验后的值，或 INVALID
   */
  #validate(input: unknown, path: string, issues: SchemaIssue[]): unknown {
    const def = this.#def

    // 缺失值处理：默认值 → 可选 → 对象自动物化 → 报缺失
    if (input === undefined || input === null) {
      if (def.hasDefault) return this.#materializeDefault(path, issues)
      if (def.optional) return undefined
      if (def.kind === "object") return this.#validateObject({}, path, issues)
      if (def.kind === "unknown") return undefined
      this.#fail(issues, path, "缺少必填项")
      return INVALID
    }

    let value: unknown
    switch (def.kind) {
      case "string":
        value = this.#validateString(input, path, issues)
        break
      case "number":
        value = this.#validateNumber(input, path, issues)
        break
      case "boolean":
        value = this.#validateBoolean(input, path, issues)
        break
      case "enum":
        value = this.#validateEnum(input, path, issues)
        break
      case "literal":
        value = input === def.literalValue ? input : this.#reject(issues, path, `必须为 ${String(def.literalValue)}`)
        break
      case "array":
        value = this.#validateArray(input, path, issues)
        break
      case "object":
        value = this.#validateObject(input, path, issues)
        break
      case "record":
        value = this.#validateRecord(input, path, issues)
        break
      default:
        value = input
    }

    if (value === INVALID) return INVALID

    for (const rule of def.checks ?? []) {
      if (!rule.test(value as never)) {
        this.#fail(issues, path, rule.message)
        return INVALID
      }
    }
    return value
  }

  /**
   * 记录错误并返回 INVALID
   * @param issues 问题收集容器
   * @param path 路径
   * @param message 说明
   * @returns INVALID
   */
  #reject(issues: SchemaIssue[], path: string, message: string): typeof INVALID {
    this.#fail(issues, path, message)
    return INVALID
  }

  /**
   * 把声明的默认值也过一遍校验
   *
   * 默认值必须走同一条校验/转换链，否则 `defaults()` 与 `parse(用户文件)`
   * 会给出**形态不同的同一份配置**（例如 duration 的默认 `0` 与文件里读回的
   * `"0"`），下游按路径比对时就会在每次启动时误报"配置变了"。
   *
   * 默认值不合法属于插件作者的 bug，不是用户的错：这里只记 warn 并退回原始
   * 默认值，让机器人照常启动，而不是让用户面对一个自己无法修复的启动失败。
   * @param path 当前路径
   * @param issues 问题收集容器
   * @returns 规范化后的默认值
   */
  #materializeDefault(path: string, issues: SchemaIssue[]): unknown {
    const raw = deepClone(this.#def.defaultValue)
    if (raw === undefined || raw === null) return raw

    const probe: SchemaIssue[] = []
    const value = this.#validate(raw, path, probe)
    if (value === INVALID || probe.some(i => i.severity === "error")) {
      const detail = probe.map(i => i.message).join("；")
      issues.push({
        path,
        message: `schema 声明的默认值不符合自身规则（${detail}），请联系插件作者`,
        severity: "warn"
      })
      return raw
    }
    issues.push(...probe)
    return value
  }

  /**
   * 校验字符串
   * @param input 输入
   * @param path 路径
   * @param issues 问题容器
   * @returns 字符串或 INVALID
   */
  #validateString(input: unknown, path: string, issues: SchemaIssue[]): unknown {
    const def = this.#def
    // 数字/布尔宽容转字符串：YAML 里 `token: 12345` 会被解析成数字
    let text: string
    if (typeof input === "string") text = input
    else if (typeof input === "number" && def.allowNumber) return input
    else if (typeof input === "number" || typeof input === "boolean") text = String(input)
    else return this.#reject(issues, path, "应为字符串")

    if (def.trim !== false) text = text.trim()
    if (def.min !== undefined && [...text].length < def.min) {
      return this.#reject(issues, path, `长度不能少于 ${def.min}`)
    }
    if (def.max !== undefined && [...text].length > def.max) {
      return this.#reject(issues, path, `长度不能超过 ${def.max}`)
    }
    if (def.pattern && !def.pattern.test(text)) {
      return this.#reject(issues, path, `格式不正确（需匹配 ${def.pattern.source}）`)
    }
    return text
  }

  /**
   * 校验数值
   * @param input 输入
   * @param path 路径
   * @param issues 问题容器
   * @returns 数值或 INVALID
   */
  #validateNumber(input: unknown, path: string, issues: SchemaIssue[]): unknown {
    const def = this.#def
    let num: number
    if (typeof input === "number") num = input
    else if (typeof input === "string" && input.trim() !== "" && Number.isFinite(Number(input))) {
      num = Number(input)
    } else return this.#reject(issues, path, "应为数字")

    if (!Number.isFinite(num)) return this.#reject(issues, path, "应为有限数字")
    if (def.int && !Number.isInteger(num)) return this.#reject(issues, path, "应为整数")
    if (def.min !== undefined && num < def.min) return this.#reject(issues, path, `不能小于 ${def.min}`)
    if (def.max !== undefined && num > def.max) return this.#reject(issues, path, `不能大于 ${def.max}`)
    return num
  }

  /**
   * 校验布尔
   * @param input 输入
   * @param path 路径
   * @param issues 问题容器
   * @returns 布尔或 INVALID
   */
  #validateBoolean(input: unknown, path: string, issues: SchemaIssue[]): unknown {
    if (typeof input === "boolean") return input
    if (typeof input === "string") {
      const text = input.trim().toLowerCase()
      if (["true", "1", "yes", "on", "是"].includes(text)) return true
      if (["false", "0", "no", "off", "否"].includes(text)) return false
    }
    if (input === 1) return true
    if (input === 0) return false
    return this.#reject(issues, path, "应为布尔值")
  }

  /**
   * 校验枚举
   * @param input 输入
   * @param path 路径
   * @param issues 问题容器
   * @returns 枚举值或 INVALID
   */
  #validateEnum(input: unknown, path: string, issues: SchemaIssue[]): unknown {
    const items = this.#def.enumItems ?? []
    for (const item of items) {
      if (item.value === input) return input
      // WebUI 的 select 只会回传字符串，数字枚举需要按文本比一次
      if (String(item.value) === String(input)) return item.value
    }
    const allowed = items.map(i => String(i.value)).join(" / ")
    return this.#reject(issues, path, `只能是 ${allowed}`)
  }

  /**
   * 校验数组
   * @param input 输入
   * @param path 路径
   * @param issues 问题容器
   * @returns 数组或 INVALID
   */
  #validateArray(input: unknown, path: string, issues: SchemaIssue[]): unknown {
    const def = this.#def
    let list: unknown[]
    if (Array.isArray(input)) list = input
    else if (def.wrapSingle) list = [input]
    else return this.#reject(issues, path, "应为数组")

    if (def.min !== undefined && list.length < def.min) {
      return this.#reject(issues, path, `至少需要 ${def.min} 项`)
    }
    if (def.max !== undefined && list.length > def.max) {
      return this.#reject(issues, path, `最多 ${def.max} 项`)
    }

    const element = def.element
    if (!element) return deepClone(list)

    const out: unknown[] = []
    let bad = false
    for (let i = 0; i < list.length; i++) {
      const item = element.#validate(list[i], `${path}[${i}]`, issues)
      if (item === INVALID) bad = true
      else out.push(item)
    }
    return bad ? INVALID : out
  }

  /**
   * 校验对象
   * @param input 输入
   * @param path 路径
   * @param issues 问题容器
   * @returns 对象或 INVALID
   */
  #validateObject(input: unknown, path: string, issues: SchemaIssue[]): unknown {
    const def = this.#def
    if (!isPlainObject(input)) return this.#reject(issues, path, "应为对象")

    const shape = def.shape ?? {}
    const out: Record<string, unknown> = {}
    let bad = false

    for (const [key, child] of Object.entries(shape)) {
      const childPath = path === "" ? key : `${path}.${key}`
      const value = child.#validate(input[key], childPath, issues)
      if (value === INVALID) bad = true
      else if (value !== undefined) out[key] = value
    }

    for (const key of Object.keys(input)) {
      if (Object.prototype.hasOwnProperty.call(shape, key)) continue
      const childPath = path === "" ? key : `${path}.${key}`
      if (def.strict) {
        this.#fail(issues, childPath, "无法识别的配置项")
        bad = true
      } else {
        // 保留但提示：可能是拼写错误，也可能来自暂时卸载的插件
        this.#fail(issues, childPath, "无法识别的配置项，已原样保留", "warn")
        out[key] = deepClone(input[key])
      }
    }

    return bad ? INVALID : out
  }

  /**
   * 校验字典
   * @param input 输入
   * @param path 路径
   * @param issues 问题容器
   * @returns 字典或 INVALID
   */
  #validateRecord(input: unknown, path: string, issues: SchemaIssue[]): unknown {
    if (!isPlainObject(input)) return this.#reject(issues, path, "应为键值对象")
    const valueSchema = this.#def.valueSchema
    if (!valueSchema) return deepClone(input)

    const out: Record<string, unknown> = {}
    let bad = false
    for (const [key, raw] of Object.entries(input)) {
      const childPath = path === "" ? key : `${path}.${key}`
      const value = valueSchema.#validate(raw, childPath, issues)
      if (value === INVALID) bad = true
      else out[key] = value
    }
    return bad ? INVALID : out
  }
}

/** 从 schema 反推 TS 类型 */
 
/**
 *
 */
export type Infer<S> = S extends Schema<infer T> ? T : never

/** 让交叉类型在编辑器提示里展开成扁平对象 */
type Simplify<T> = { [K in keyof T]: T[K] } & {}

/** 对象 schema 的字段表 */
 
/**
 *
 */
export type Shape = Record<string, Schema<any>>

/** 可缺省的键（输出类型含 undefined 的那些） */
type OptionalKeys<S extends Shape> = {
  [K in keyof S]: undefined extends Infer<S[K]> ? K : never
}[keyof S]

/** 对象 schema 的输出类型 */
export type ObjectOutput<S extends Shape> = Simplify<
  { [K in Exclude<keyof S, OptionalKeys<S>>]: Infer<S[K]> } & { [K in OptionalKeys<S>]?: Infer<S[K]> }
>

/**
 * 创建基础节点
 * @param def 定义片段
 * @returns schema
 */
function make<T>(def: Omit<SchemaDef, "meta"> & { meta?: SchemaMeta }): Schema<T> {
  return new Schema<T>({ ...def, meta: def.meta ?? {} })
}

/**
 * 字符串
 * @returns 字符串 schema
 */
function string(): Schema<string> {
  return make<string>({ kind: "string" })
}

/**
 * 数字
 * @returns 数字 schema
 */
function number(): Schema<number> {
  return make<number>({ kind: "number" })
}

/**
 * 布尔
 * @returns 布尔 schema
 */
function boolean(): Schema<boolean> {
  return make<boolean>({ kind: "boolean" })
}

/**
 * 字面量
 * @param value 唯一允许的值
 * @returns 字面量 schema
 */
function literal<const V extends string | number | boolean>(value: V): Schema<V> {
  return make<V>({ kind: "literal", literalValue: value })
}

/**
 * 枚举
 * @param values 候选值
 * @param labels 值到展示文案的映射
 * @returns 枚举 schema
 */
function enumOf<const V extends readonly (string | number | boolean)[]>(
  values: V,
  labels?: Partial<Record<string, string>>
): Schema<V[number]> {
  const items: SchemaEnumItem[] = values.map(value => {
    const label = labels?.[String(value)]
    return label === undefined ? { value } : { value, label }
  })
  return make<V[number]>({ kind: "enum", enumItems: items, meta: { widget: "select" } })
}

/**
 * 带说明的枚举（WebUI 下拉框里显示 label 与 description）
 * @param items 候选项
 * @returns 枚举 schema
 */
function select<const V extends readonly SchemaEnumItem[]>(items: V): Schema<V[number]["value"]> {
  return make<V[number]["value"]>({
    kind: "enum",
    enumItems: items.map(item => ({ ...item })),
    meta: { widget: "select" }
  })
}

/**
 * 数组
 * @param element 元素 schema
 * @returns 数组 schema
 */
function array<S extends Schema<unknown>>(element: S): Schema<Infer<S>[]> {
  return make<Infer<S>[]>({ kind: "array", element })
}

/**
 * 对象
 * @param shape 字段表
 * @returns 对象 schema
 */
function object<S extends Shape>(shape: S): Schema<ObjectOutput<S>> {
  return make<ObjectOutput<S>>({ kind: "object", shape })
}

/**
 * 字典（键任意、值同构）
 * @param valueSchema 值 schema
 * @returns 字典 schema
 */
function record<S extends Schema<unknown>>(valueSchema: S): Schema<Record<string, Infer<S>>> {
  return make<Record<string, Infer<S>>>({ kind: "record", valueSchema, meta: { widget: "keyValue" } })
}

/**
 * 任意值（不校验）
 *
 * 兼容出口：插件存在确实无法描述的结构时使用，但 WebUI 仅能提供 JSON 编辑框。
 * @returns 任意值 schema
 */
function unknownValue(): Schema<unknown> {
  return make<unknown>({ kind: "unknown", meta: { widget: "code" } })
}

/**
 * 时长（`"30s"` / `"7d"` / 毫秒数）
 *
 * 数值写法与字符串写法都原样保留，不互相转换 —— 见 `SchemaDef.allowNumber`。
 * @returns 时长 schema
 */
function duration(): Schema<string | number> {
  return make<string | number>({ kind: "string", meta: { widget: "duration" }, allowNumber: true }).check(
    "时长格式应为毫秒数或形如 30s / 5m / 1h / 7d",
    value => typeof value === "number" || parseDuration(value, Number.NaN) === parseDuration(value, 0)
  )
}

/**
 * cron 表达式
 * @returns cron schema
 */
function cron(): Schema<string> {
  return make<string>({ kind: "string", meta: { widget: "cron" } }).check("cron 表达式应为 5 或 6 段", value => {
    const parts = value.trim().split(/\s+/)
    return parts.length === 5 || parts.length === 6
  })
}

/**
 * 端口号
 * @returns 端口 schema
 */
function port(): Schema<number> {
  return make<number>({ kind: "number", meta: { widget: "number" }, int: true, min: 1, max: 65535 })
}

/**
 * 密码 / 令牌（自动脱敏）
 * @returns 敏感字符串 schema
 */
function password(): Schema<string> {
  return string().secret()
}

/**
 * 多行文本
 * @returns 文本域 schema
 */
function text(): Schema<string> {
  return string().widget("textarea")
}

/**
 * 字符串标签数组（WebUI 用 tag 输入框）
 * @returns 标签数组 schema
 */
function tags(): Schema<string[]> {
  return array(string()).widget("tags").single()
}

/**
 * id 列表（QQ 号 / 群号，允许写单个值）
 * @returns id 数组 schema
 */
function ids(): Schema<string[]> {
  return array(string().pattern(/^\d{1,20}$/, "应为纯数字 id"))
    .widget("tags")
    .single()
}

/**
 * 目录路径
 * @returns 目录 schema
 */
function dir(): Schema<string> {
  return string().widget("dir")
}

/**
 * 文件路径
 * @returns 文件 schema
 */
function file(): Schema<string> {
  return string().widget("file")
}

/**
 * schema 构造器集合
 *
 * 用法：
 * ```ts
 * const conf = s.object({
 *   port: s.port().default(3000).title("监听端口"),
 *   mode: s.enum(["ws", "ws-reverse"]).default("ws-reverse").title("连接方式")
 * })
 * type Conf = Infer<typeof conf>
 * ```
 */
export const s = {
  string,
  number,
  boolean,
  literal,
  enum: enumOf,
  select,
  array,
  object,
  record,
  unknown: unknownValue,
  duration,
  cron,
  port,
  password,
  text,
  tags,
  ids,
  dir,
  file
} as const

/**
 * 模块职责：`definePlugin()` —— 插件的声明入口与配置类型推导
 * 依赖方向：依赖 config/schema、类型包
 * 生命周期：模块加载期执行一次（纯校验，无副作用）
 * 注意事项：两个设计要点 ——
 *
 *          1) **配置类型自动推导**。`configSchema: s.object({ cookie: s.string() })`
 *             之后，`ctx.config.get().cookie` 就是 `string`，写错字段名编译期报错。
 *             类型包为保持叶子（不许依赖任何工作区包）故把 `configSchema` 声明为
 *             `unknown`，推导只能在这里做 —— 这也是插件必须从 `@yunzai-ng/core`
 *             导入 `definePlugin` 而不是自己拼对象的原因。
 *
 *          2) **在声明期就校验元信息**。插件名会被当作配置文件名、KV 命名空间、
 *             URL 前缀和日志 scope 使用，非法名字必须在 `import` 的那一刻就报错，
 *             而不是等到写文件时抛一个看不出所以然的 ENOENT。
 */
import type { Awaitable, Disposer, PluginContext, PluginDefinition, PluginMeta } from "@yunzai-ng/types"
import type { Schema } from "../config/schema.js"

/**
 * 插件名合法形式
 *
 * 与配置名规则保持一致（见 config/store.ts）：插件名直接就是
 * `config/<name>.yaml` 的文件名。额外排除了 `:`（KV 命名空间分隔符）
 * 与路径分隔符，否则一个插件能读写别人的命名空间。
 */
const NAME_RE = /^[a-z][a-z0-9._-]*$/i

/** 标记"这是 definePlugin 的产物"，用于加载时校验默认导出 */
const BRAND = Symbol.for("yunzai-ng.plugin")

/**
 * 从 schema 推出配置类型
 *
 * 未声明 schema 时给出 `Record<string, never>`：`ctx.config.get()` 仍可调用，
 * 但读取任何字段均会在编译期报错，以提示作者"尚未声明配置"。
 */
export type ConfigOf<S> = S extends Schema<infer T> ? T : Record<string, never>

/** `definePlugin` 的入参 */
export interface DefinePluginInput<S extends Schema<unknown> | undefined = undefined> extends PluginMeta {
  /**
   * 配置 schema
   *
   * 用 `s.object({...})` 构造。内核据此生成带中文注释的 YAML、
   * 渲染 WebUI 表单、校验用户输入 —— 三处共用一份声明，永不脱节。
   */
  configSchema?: S

  /**
   * 插件入口
   *
   * 在这里注册命令、中间件、定时任务等。**不要**在这里做耗时的网络请求：
   * 内核对 setup 有超时（默认 30s），超时会把插件标记为加载失败。
   * 需要预热的资源请注册 `ctx.on("app/ready", ...)` 或用 `ctx.cron`。
   * @param ctx 注入的上下文
   * @returns 可选的清理函数，等价于在里面调 `ctx.onDispose`
   */
  setup(ctx: PluginContext<ConfigOf<S>>): Awaitable<void | Disposer>
}

/** 带品牌标记的插件定义（内核内部使用） */
export interface BrandedPluginDefinition<C = unknown> extends PluginDefinition<C> {
  /** 品牌标记 */
  readonly [BRAND]: true
}

/**
 * 声明一个插件
 *
 * @param input 插件定义
 * @returns 供内核加载的插件定义（已冻结）
 * @throws 插件名缺失/非法、`setup` 不是函数、依赖项写法错误时
 * @example
 * ```ts
 * export default definePlugin({
 *   name: "mhy-game",
 *   configSchema: s.object({ cookie: s.string().default("") }),
 *   setup(ctx) {
 *     ctx.command("#体力").desc("查询实时便笺").action(async e => {
 *       await e.reply(ctx.config.get().cookie ? "查询中" : "请先配置 cookie")
 *     })
 *   }
 * })
 * ```
 */
export function definePlugin<S extends Schema<unknown> | undefined = undefined>(
  input: DefinePluginInput<S>
): PluginDefinition<ConfigOf<S>> {
  if (typeof input?.name !== "string" || input.name.length === 0) {
    throw new Error("definePlugin：缺少 name，插件必须有名字")
  }
  if (!NAME_RE.test(input.name)) {
    throw new Error(`definePlugin：插件名 ${input.name} 不合法。需以字母开头，只含字母、数字与 . - _（它同时是配置文件名与存储命名空间）`)
  }
  if (typeof input.setup !== "function") {
    throw new Error(`definePlugin：插件 ${input.name} 缺少 setup 函数`)
  }
  if (input.dependencies && !Array.isArray(input.dependencies)) {
    throw new Error(`definePlugin：插件 ${input.name} 的 dependencies 必须是字符串数组`)
  }
  for (const dep of input.dependencies ?? []) {
    if (typeof dep !== "string" || dep.length === 0) {
      throw new Error(`definePlugin：插件 ${input.name} 的 dependencies 含空项`)
    }
    if (dep === input.name) {
      throw new Error(`definePlugin：插件 ${input.name} 依赖了自己`)
    }
  }
  if (input.priority !== undefined && !Number.isFinite(input.priority)) {
    throw new Error(`definePlugin：插件 ${input.name} 的 priority 必须是数字`)
  }

  // 浅冻结：防止插件在运行期改自己的元信息（改了内核也不会重新读，只会造成困惑）
  return Object.freeze({ ...input, [BRAND]: true }) as unknown as PluginDefinition<ConfigOf<S>>
}

/**
 * 判断一个值是否 `definePlugin` 的产物
 *
 * 加载器用它区分"插件写错了默认导出"和"插件确实是插件"，
 * 从而给出"请用 definePlugin 包一层"这种能直接照做的提示。
 * @param value 待判定值
 * @returns 是否为插件定义
 */
export function isPluginDefinition(value: unknown): value is BrandedPluginDefinition {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[BRAND] === true
}

/**
 * 宽松判定：像插件定义但可能没走 `definePlugin`
 *
 * 允许手写对象（如测试里的假插件、compat 插件动态生成的定义），
 * 只要有 name 与 setup 就接受，但加载器会记一条 debug 提示。
 * @param value 待判定值
 * @returns 是否可当作插件定义使用
 */
export function looksLikePlugin(value: unknown): value is PluginDefinition {
  if (typeof value !== "object" || value === null) return false
  const obj = value as Partial<PluginDefinition>
  return typeof obj.name === "string" && typeof obj.setup === "function"
}

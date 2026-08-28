/**
 * 模块职责：HTML 文本的载体、转义，以及 `class` / `style` / 子节点的求值
 * 依赖方向：叶子模块，仅取同包的类型
 * 生命周期：无状态，全部为纯函数
 * 注意事项：默认行为是**转义**，`raw()` 是唯一的逃生口。反过来（默认原样输出、需要时
 *          显式转义）在实践中必然遗漏 —— 米游社返回的昵称含一个尖括号即可破坏整张图的
 *          结构，而这种数据只在真机上才会出现，单测覆盖不到。
 */
import type { Child, ClassValue, StyleDict } from "./types.js"

/** 需要转义的五个字符 */
const ENTITIES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
}

/** 转义匹配式；单引号一并处理，使属性值以单引号包裹时同样安全 */
const NEED_ESCAPE = /[&<>"']/g

/**
 * 已完成转义、可直接写入文档的 HTML 文本
 *
 * 仅是一个带类型标记的字符串包装：模板的产物是一次性的文本，虚拟 DOM 的 diff 能力在此
 * 毫无用处，而 react / preact 会为此引入数十个传递依赖。Termux 上包体越小越好，
 * 这笔交换不成立。
 */
export class Html {
  /** HTML 文本 */
  readonly value: string

  /**
   * @param value 已转义的 HTML 文本
   */
  constructor(value: string) {
    this.value = value
  }

  /**
   * 判定任意值是否为 Html
   * @param input 待判定的值
   * @returns 是 Html 则为真
   */
  static is(input: unknown): input is Html {
    return input instanceof Html
  }

  /**
   * 取 HTML 文本
   * @returns HTML 文本
   */
  toString(): string {
    return this.value
  }

  /**
   * 参与 `JSON.stringify` 时退化为文本，使快照测试可直接序列化
   * @returns HTML 文本
   */
  toJSON(): string {
    return this.value
  }
}

/**
 * 转义为 HTML 文本
 *
 * `null` 与 `undefined` 转为空串而非字面量 "null" —— 模板里 `{user.nick}` 取到空值时
 * 应当什么都不显示，打印出 "undefined" 只会出现在成品图上。
 * @param input 任意值
 * @returns 转义后的文本
 */
export function escape(input: unknown): string {
  if (input === null || input === undefined) return ""
  return String(input).replace(NEED_ESCAPE, ch => ENTITIES[ch] ?? ch)
}

/**
 * 声明一段文本已经是安全的 HTML，跳过转义
 *
 * 唯一的逃生口，仅用于本模块自己生成的标签、`<!DOCTYPE html>`，以及编译产物这类
 * 确定安全的内容。**不要**用它包裹任何来自接口的数据。
 * @param value HTML 文本
 * @returns 载体
 */
export function raw(value: string): Html {
  return new Html(value)
}

/**
 * 求值类名
 *
 * 接纳字符串、条件字典与任意嵌套数组三种形态，使 `class={["cont", full && "full"]}`
 * 与 `class={{ up: delta > 0 }}` 都可直接书写，无需在模板里拼字符串。
 * @param inputs 任意个类名输入
 * @returns 以空格分隔、已去重的类名串
 */
export function cx(...inputs: ClassValue[]): string {
  const out: string[] = []
  push(inputs, out)
  return [...new Set(out)].join(" ")
}

/**
 * `cx` 的递归收集部分
 * @param input 类名输入
 * @param out 收集容器
 */
function push(input: ClassValue, out: string[]): void {
  if (input === null || input === undefined || input === false || input === "") return
  if (typeof input === "string") {
    for (const part of input.split(/\s+/)) if (part) out.push(part)
    return
  }
  if (typeof input === "number") {
    out.push(String(input))
    return
  }
  if (Array.isArray(input)) {
    for (const item of input) push(item, out)
    return
  }
  for (const [name, on] of Object.entries(input)) if (on) push(name, out)
}

/**
 * 求值内联样式
 *
 * 数值不会被自动补上 `px`：React 的这套隐式补单位规则需要一张"哪些属性是长度"的名单，
 * 名单不全时表现为样式静默失效。此处要求显式书写单位，宽度写成百分号模板串一目了然。
 * 以 `--` 开头的自定义属性保留原始大小写 —— 它们区分大小写，转换会改变含义。
 * @param input 样式字符串或字典
 * @returns CSS 声明串
 */
export function style(input: string | StyleDict): string {
  if (typeof input === "string") return input
  const out: string[] = []
  for (const [property, value] of Object.entries(input)) {
    if (value === null || value === undefined || value === false || value === "") continue
    const name = property.startsWith("--") ? property : property.replace(/[A-Z]/g, ch => `-${ch.toLowerCase()}`)
    out.push(`${name}: ${String(value)}`)
  }
  return out.join("; ")
}

/**
 * 求值子节点
 * @param child 子节点
 * @returns 拼接好的 HTML 文本
 */
export function children(child: Child): string {
  if (child === null || child === undefined || typeof child === "boolean") return ""
  if (child instanceof Html) return child.value
  if (Array.isArray(child)) {
    let out = ""
    for (const item of child) out += children(item)
    return out
  }
  return escape(child)
}

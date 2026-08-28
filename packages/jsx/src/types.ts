/**
 * 模块职责：JSX 层的公共类型契约
 * 依赖方向：仅依赖同包的 `html.ts`（取 `Html` 作为节点类型），不引任何工作区包
 * 生命周期：纯类型，编译后不留痕迹
 * 注意事项：属性名**不作 camelCase 转换**，一律按真实 HTML 书写（`stroke-width`、
 *          `tabindex`、`data-x`）。TSX 语法本身允许带连字符的属性名，无需转换即可书写；
 *          而一旦引入转换，`viewBox` 这类 SVG 属性与 `data-camelCase` 就会出现两套
 *          互相冲突的规则。唯二的例外是 `className` 与 `htmlFor` —— 它们是 React 为
 *          规避 JS 保留字留下的历史包袱，作为别名接纳以降低迁移成本。
 */
import type { Html } from "./html.js"

/** 以键为类名、值为是否启用的字典 */
export interface ClassDict {
  /** 类名 → 是否启用 */
  [name: string]: boolean | null | undefined
}

/** `class` 属性可接受的形态：字符串、条件字典、以及两者的任意嵌套数组 */
export type ClassValue = string | number | false | null | undefined | ClassDict | ClassValue[]

/** 内联样式字典；键为 CSS 属性名或 `--` 自定义属性 */
export interface StyleDict {
  /** CSS 属性名 → 取值；数值不会被自动补单位，需要单位时自行拼接 */
  [property: string]: string | number | null | undefined | false
}

/**
 * 子节点
 *
 * `null` / `undefined` / 布尔值渲染为空串，使 `{cond && <div/>}` 与 `{value ?? null}`
 * 这两种最常用的条件写法无需额外处理。
 */
export type Child = Html | string | number | bigint | boolean | null | undefined | Child[]

/** 元素属性 */
export interface HtmlAttributes {
  /** 类名 */
  class?: ClassValue
  /** 类名，`class` 的别名 */
  className?: ClassValue
  /** 内联样式 */
  style?: string | StyleDict
  /** 子节点 */
  children?: Child
  /** 兼容 React 写法而接纳，渲染时丢弃 —— 此处没有需要复用节点的协调过程 */
  key?: string | number
  /** 其余属性原样输出；值为 `true` 输出裸属性名，为 `false`/`null`/`undefined` 则整项省略 */
  [attr: string]: unknown
}

/** 函数组件：接收属性、返回一段 HTML */
export type Component<P = Record<string, never>> = (props: P) => Html

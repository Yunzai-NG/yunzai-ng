/**
 * 模块职责：`@yunzai-ng/jsx` 的公开入口
 * 依赖方向：仅依赖 `@yunzai-ng/types`（取 `RenderablePage` 的形状）
 * 生命周期：无状态
 * 注意事项：本包独立于 `@yunzai-ng/core` 而非作为它的一个子路径导出。分层门禁把
 *          `@yunzai-ng/core/*` 的任意子路径判为"深引内核内部实现"，为一个 JSX 运行时
 *          给门禁开洞并不划算；独立成包后第三方插件也可单独依赖它而不必牵入整个内核。
 */
import type { RenderablePage } from "@yunzai-ng/types"
import { children } from "./html.js"
import type { Child } from "./types.js"

export { Html, escape, raw, cx, style, children } from "./html.js"
export { attributes, element } from "./element.js"
export { Fragment, jsx, jsxs, jsxDEV } from "./jsx-runtime.js"
export type { ElementType } from "./jsx-runtime.js"
export type { Child, ClassDict, ClassValue, Component, HtmlAttributes, StyleDict } from "./types.js"

/** HTML5 文档类型声明；缺了它浏览器进入怪异模式，盒模型与行高全部改变 */
const DOCTYPE = "<!DOCTYPE html>"

/**
 * 把一个组件封装成模板
 *
 * 产物可直接交给 `ctx.render()` / `e.renderReply()`：
 *
 * ```tsx
 * export const Abyss = defineTemplate("abyss", (view: AbyssView) => <Page>…</Page>)
 * await e.renderReply(Abyss(view))
 * ```
 *
 * 由此模板数据的类型在调用处即被检查 —— 视图层改了字段名，编译当场失败，而不是等到
 * 真机出图时得到一张空白图。模板同时退化成纯函数，可直接快照测试，不需要浏览器。
 * @param name 页面名，用于日志、临时文件名与统计
 * @param component 组件；返回整份文档（不含 doctype，由本函数补上）
 * @returns 接受同样属性、返回可渲染页面的函数
 */
export function defineTemplate<P>(name: string, component: (props: P) => Child): (props: P) => RenderablePage {
  return (props: P): RenderablePage => ({ name, html: DOCTYPE + children(component(props)) })
}

/**
 * 模块职责：TypeScript 自动 JSX 转换所要求的运行时入口（`jsx` / `jsxs` / `Fragment`）
 * 依赖方向：仅依赖同包的 `html.ts` 与 `element.ts`
 * 生命周期：无状态，纯函数
 * 注意事项：`jsx` 与 `jsxs` 为同一实现。二者的区别在于 `jsxs` 保证 `children` 已是数组
 *          且不会被改写，React 借此跳过 key 校验；此处不存在协调过程，无从利用该保证。
 *
 *          `jsx-dev-runtime` 亦指向本文件：开发版签名多出 `isStaticChildren` / `source`
 *          / `self` 三个参数，全部用于 React 的错误提示，与产出的 HTML 无关。
 */
import { children, Html, raw } from "./html.js"
import { element } from "./element.js"
import type { Child, HtmlAttributes } from "./types.js"

/**
 * JSX 标签位置可出现的类型
 *
 * 函数组件的属性类型声明为 `never`：函数类型的参数按逆变判定，`never` 可被任意参数类型
 * 接受，因此这是"任意一元函数"的写法。真正的属性类型检查由 TSX 在标签处完成，
 * 与此签名无关。
 */
export type ElementType = string | ((props: never) => Child)

/**
 * 片段：把多个同级节点合成一个返回值
 *
 * 它就是一个普通函数组件，`<>…</>` 编译成 `jsx(Fragment, { children })` 后自然生效，
 * 无需在 `jsx()` 里为它开特例。
 * @param props 仅取 `children`
 * @returns 拼接好的子节点
 */
export function Fragment(props: { children?: Child }): Html {
  return raw(children(props.children))
}

/**
 * 创建一个节点
 * @param type 标签名或函数组件
 * @param props 属性；`children` 亦在其中
 * @returns 渲染好的 HTML
 * @throws 标签名或属性名不合法时抛出 TypeError
 */
export function jsx(type: ElementType, props: Readonly<Record<string, unknown>> = {}): Html {
  if (typeof type === "function") {
    return raw(children((type as (props: Readonly<Record<string, unknown>>) => Child)(props)))
  }
  return raw(element(type, props))
}

export { jsx as jsxs, jsx as jsxDEV }

/**
 * TSX 类型契约
 *
 * TypeScript 在 `jsxImportSource` 指向的模块上查找这个命名空间，用它判定标签合法性、
 * 子节点属性名与元素类型。
 */
export namespace JSX {
  /** 一次渲染的产物 */
  export interface Element extends Html {}

  /** 告知 TypeScript 以 `children` 属性接收子节点 */
  export interface ElementChildrenAttribute {
    /** 属性名本身才是这里唯一有意义的信息，类型不参与判定 */
    children: object
  }

  /**
   * 内建标签
   *
   * 以索引签名放开全部标签：逐一枚举 HTML 元素及其专属属性需要数千行声明，而模板作者
   * 真正需要的约束是 `class` / `style` / `children` 的形态，这三项已在 `HtmlAttributes`
   * 中给出。拼错标签名的代价是浏览器把它当作未知内联元素，肉眼可见，不必由类型系统兜住。
   */
  export interface IntrinsicElements {
    /** 任意标签 */
    [tag: string]: HtmlAttributes
  }

  /** 所有元素隐含允许的属性 */
  export interface IntrinsicAttributes {
    /** 兼容 React 写法而接纳，渲染时丢弃 */
    key?: string | number
  }
}

/**
 * 模块职责：把标签名与属性对象序列化成 HTML 文本
 * 依赖方向：仅依赖同包的 `html.ts`
 * 生命周期：无状态，纯函数
 * 注意事项：标签名与属性名均须通过白名单校验。属性名并非全部来自源码字面量 ——
 *          `{...props}` 展开可以把任意键带进来，其中若含空格或引号，即可在生成的标签里
 *          插入一个新属性。此处直接抛错而非静默丢弃：这类问题在模板作者一侧一次性可修，
 *          悄悄少输出一个属性反而要到成品图上才被发现。
 */
import { children, cx, escape, style } from "./html.js"
import type { Child, ClassValue, StyleDict } from "./types.js"

/**
 * 空元素（HTML 规范中不允许有内容、也不写闭合标签的那些）
 *
 * 为它们补一个 `</img>` 会被解析器当作多余的结束标签忽略，看似无害；但 `<br></br>`
 * 在部分场景下会被解析成两个换行。按规范只输出开始标签。
 */
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr"
])

/** React 为规避 JS 保留字而改名的两个属性，作为别名接纳 */
const ALIASES: Readonly<Record<string, string>> = { className: "class", htmlFor: "for" }

/** 不参与属性输出的键 */
const DROPPED = new Set(["children", "key", "class", "className"])

/** 合法标签名 */
const VALID_TAG = /^[A-Za-z][\w.:-]*$/

/** 合法属性名；与 HTML 规范一致地允许连字符、点与冒号 */
const VALID_ATTR = /^[A-Za-z_:][\w.:-]*$/

/**
 * 序列化属性
 * @param props 属性对象
 * @returns 以空格开头的属性串；无属性时为空串
 * @throws 属性名不合法时抛出 TypeError
 */
export function attributes(props: Readonly<Record<string, unknown>>): string {
  let out = ""

  // class 与 className 合并后一次输出：两者都写时分别输出会得到两个 class 属性，
  // 浏览器只认第一个，后一个静默丢失
  const classes = cx(props["class"] as ClassValue, props["className"] as ClassValue)
  if (classes) out += ` class="${escape(classes)}"`

  for (const [key, value] of Object.entries(props)) {
    if (DROPPED.has(key)) continue
    if (value === null || value === undefined || value === false) continue

    const name = ALIASES[key] ?? key
    if (!VALID_ATTR.test(name)) throw new TypeError(`非法的属性名：${JSON.stringify(key)}`)

    // 布尔属性（hidden、disabled 之类）输出裸属性名。写成 `hidden="false"` 反而是生效的，
    // 因为 HTML 只看属性是否存在
    if (value === true) {
      out += ` ${name}`
      continue
    }

    if (name === "style") {
      const css = style(value as string | StyleDict)
      if (css) out += ` style="${escape(css)}"`
      continue
    }

    out += ` ${name}="${escape(value)}"`
  }

  return out
}

/**
 * 序列化一个元素
 * @param tag 标签名
 * @param props 属性对象（含 `children`）
 * @returns HTML 文本
 * @throws 标签名不合法时抛出 TypeError
 */
export function element(tag: string, props: Readonly<Record<string, unknown>>): string {
  if (!VALID_TAG.test(tag)) throw new TypeError(`非法的标签名：${JSON.stringify(tag)}`)
  const head = `<${tag}${attributes(props)}>`
  if (VOID_TAGS.has(tag.toLowerCase())) return head
  return `${head}${children(props["children"] as Child)}</${tag}>`
}

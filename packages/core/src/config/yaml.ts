/**
 * 模块职责：把配置对象序列化成**带中文注释**的 YAML，以及从 YAML 反序列化
 * 依赖方向：依赖 yaml 包与类型包
 * 生命周期：纯函数
 * 注意事项：注释由 schema 的 `title`/`description`/枚举候选自动生成，不另维护一份
 *          YAML 模板 —— 两份东西的默认值会各自漂移，而使用者拿到的注释会常年过期。
 *
 *          代价是**保存时会重写整个文件，用户手写的注释不被保留**。这是有意的
 *          取舍：配置的主编辑面是 WebUI，文件是产物；换来的是注释永远与当前版本
 *          一致。文件里的**值**当然完整保留。
 */
import { Document, isMap, isSeq, parse, type Node } from "yaml"
import type { SchemaDescriptor } from "@yunzai-ng/types"

/** 序列化选项 */
export interface SerializeOptions {
  /** 文件头注释（每行前会自动加 `# `） */
  header?: string[]
  /** 表单描述，用于生成字段注释 */
  descriptor?: SchemaDescriptor
}

/**
 * 解析 YAML 文本
 * @param text YAML 文本
 * @returns 解析结果；空文本返回 undefined
 * @throws 语法错误时抛出，错误信息里带行号
 */
export function parseYaml(text: string): unknown {
  if (text.trim() === "") return undefined
  return parse(text, { merge: true })
}

/**
 * 把配置对象序列化成带注释的 YAML
 * @param value 配置值
 * @param opts 序列化选项
 * @returns YAML 文本（以换行结尾）
 */
export function serializeYaml(value: unknown, opts: SerializeOptions = {}): string {
  const doc = new Document(value)

  if (opts.header && opts.header.length > 0) {
    doc.commentBefore = opts.header.map(line => ` ${line}`).join("\n")
  }
  if (opts.descriptor && doc.contents) {
    annotate(doc.contents, opts.descriptor)
  }

  // lineWidth: 0 关闭自动折行 —— 折行后的长 URL、cookie 在文本编辑器里很难改
  return doc.toString({ lineWidth: 0, indent: 2, nullStr: "~" })
}

/**
 * 给 YAML 节点递归挂注释
 * @param node YAML 节点
 * @param descriptor 对应的表单描述
 */
function annotate(node: Node, descriptor: SchemaDescriptor): void {
  if (isMap(node) && descriptor.properties) {
    for (const item of node.items) {
      const key = item.key
      if (typeof key !== "object" || key === null || !("value" in key)) continue
      const name = String((key as { value: unknown }).value)
      const child = descriptor.properties[name]
      if (!child) continue

      const comment = buildComment(child)
      if (comment) (key as { commentBefore?: string }).commentBefore = comment

      const valueNode = item.value
      if (valueNode && typeof valueNode === "object") annotate(valueNode as Node, child)
    }
    return
  }

  if (isSeq(node) && descriptor.items) {
    // 只给第一个元素挂注释：每一项都重复一遍会把列表淹没
    const first = node.items[0]
    if (first && typeof first === "object") annotate(first as Node, descriptor.items)
  }
}

/**
 * 由字段描述生成注释文本
 * @param descriptor 字段描述
 * @returns 注释文本；无可写内容时返回 undefined
 */
function buildComment(descriptor: SchemaDescriptor): string | undefined {
  const lines: string[] = []

  if (descriptor.title) lines.push(descriptor.title)
  if (descriptor.description) lines.push(...descriptor.description.split("\n"))

  if (descriptor.enum && descriptor.enum.length > 0) {
    const items = descriptor.enum.map(item => {
      const label = item.label ?? item.description
      return label ? `${String(item.value)}（${label}）` : String(item.value)
    })
    lines.push(`可选值：${items.join(" / ")}`)
  }

  if (descriptor.widget === "duration") lines.push("格式：毫秒数，或 30s / 5m / 2h / 7d")
  if (descriptor.widget === "cron") lines.push("格式：cron 表达式，如 0 0 8 * * *")
  if (descriptor.secret) lines.push("敏感信息，请勿分享本文件")

  if (descriptor.min !== undefined || descriptor.max !== undefined) {
    const range =
      descriptor.min !== undefined && descriptor.max !== undefined
        ? `${descriptor.min} ~ ${descriptor.max}`
        : descriptor.min !== undefined
          ? `≥ ${descriptor.min}`
          : `≤ ${descriptor.max}`
    lines.push(`取值范围：${range}`)
  }

  if (lines.length === 0) return undefined
  return lines.map(line => ` ${line}`).join("\n")
}

/**
 * 模块职责：超长消息切分
 * 依赖方向：依赖类型包与 util/text
 * 生命周期：纯函数
 * 注意事项：平台对单条消息长度设有硬性限制（QQ 约 4500 字，超出后整条无法发出，
 *          而非被截断），故切分由内核统一承担，不交由插件各自实现。
 *
 *          本模块仅按**文本长度**切分。图片、语音、卡片一律原样传递，因
 *          "单条消息最多包含几张图"属平台差异，应由适配器判定，内核不作推断。
 *
 *          切分点优先选取换行，其次空白，最后为强制切分（`splitText` 的策略）——
 *          在句中强制切分会使长文本回复的可读性显著下降。
 */
import type { Segment } from "@yunzai-ng/types"
import { splitStep } from "../util/text.js"

/**
 * 码点数
 * @param text 文本
 * @returns 码点数
 */
function codePoints(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0xd800 || code > 0xdbff) n++
  }
  return n
}

/**
 * 统计消息里的文本总长度（按码点）
 *
 * 只算文本段：`[图片]` 这类占位在不同平台上的实际开销天差地别，
 * 用一个假定的权重去估反而会在某个平台上恰好算错。
 * @param segments 消息段
 * @returns 文本总长度
 */
export function textLength(segments: readonly Segment[]): number {
  let n = 0
  for (const s of segments) {
    if (s.type === "text") n += codePoints(s.text)
  }
  return n
}

/**
 * 把一条消息按文本长度切成多条
 *
 * 不需要切时**原样返回同一个数组**（不复制）：这是绝大多数消息走的路径，
 * 一次多余的数组分配乘以每条回复也是可观的。
 * @param segments 消息段
 * @param maxLength 单条最大文本长度；`<= 0` 表示不切
 * @returns 切分后的消息数组，至少一项
 */
export function splitMessage(segments: Segment[], maxLength: number): Segment[][] {
  if (maxLength <= 0 || textLength(segments) <= maxLength) return [segments]

  const out: Segment[][] = []
  let current: Segment[] = []
  let used = 0

  /** 收束当前一条，开始下一条 */
  const flush = (): void => {
    if (current.length > 0) out.push(current)
    current = []
    used = 0
  }

  for (const s of segments) {
    if (s.type !== "text") {
      // 非文本段不计长度，但要跟在它前面的文本同一条里 —— 图文顺序不能乱
      current.push(s)
      continue
    }

    const text = s.text
    let at = 0
    while (at < text.length) {
      const room = maxLength - used
      if (room <= 0) {
        flush()
        continue
      }

      // 每次只看 room 个码点的窗口：对剩余全文反复调 splitText 是平方级的
      const step = splitStep(text, at, room)
      if (step === undefined) {
        const tail = text.slice(at)
        current.push({ type: "text", text: tail })
        used += codePoints(tail)
        break
      }
      if (step.head === "") {
        // 窗口里全是空白：逐字往前挪，免得死循环
        at += 1
        continue
      }

      current.push({ type: "text", text: step.head })
      used += codePoints(step.head)
      // 断点之后只剩空白：这一段到此为止，后面的图片等仍跟在这一条里
      if (step.next >= text.length) break
      // 断点处的空白已跳过，下一条不会以空格或换行开头
      at = step.next
      flush()
    }
  }

  flush()
  // 全是空白文本的极端输入会把所有内容都丢掉，此时退回原样：
  // 宁可让平台报一次长度错，也不要静默发出一条空消息
  return out.length > 0 ? out : [segments]
}

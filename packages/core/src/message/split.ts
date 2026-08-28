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
import { splitText } from "../util/text.js"

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
    if (s.type === "text") n += [...s.text].length
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

    let rest = s.text
    while (rest !== "") {
      const room = maxLength - used
      if (room <= 0) {
        flush()
        continue
      }

      const pieces = splitText(rest, room)
      const head = pieces[0]
      // rest 只剩空白时 splitText 返回空数组；这段没有信息量，丢掉
      if (head === undefined) break
      if (head === "") {
        // 理论上不会发生（splitText 的硬切兜底保证非空）。留这一手是因为
        // 一旦发生就是死循环，而死循环比多发一条消息严重得多。
        rest = rest.slice(1)
        continue
      }

      current.push({ type: "text", text: head })
      used += [...head].length
      if (pieces.length === 1) break

      // head 可能被 trimEnd 过，因此按长度回切后再抹掉断点处的空白，
      // 否则下一条会以空格或换行开头
      rest = rest.slice(head.length).replace(/^\s+/, "")
      flush()
    }
  }

  flush()
  // 全是空白文本的极端输入会把所有内容都丢掉，此时退回原样：
  // 宁可让平台报一次长度错，也不要静默发出一条空消息
  return out.length > 0 ? out : [segments]
}

import { describe, expect, it } from "vitest"
import type { Segment } from "@yunzai-ng/types"
import { splitMessage, textLength } from "./split.js"
import { splitText } from "../util/text.js"

const text = (t: string): Segment => ({ type: "text", text: t })
const image: Segment = { type: "image", file: { kind: "url", url: "https://x/a.png" } }

describe("splitText", () => {
  it("优先在换行处切，断点处的空白不带进下一段", () => {
    expect(splitText("一二三四五\n六七八九十", 7)).toEqual(["一二三四五", "六七八九十"])
  })

  it("没有合适断点时硬切，emoji 按一个字算", () => {
    expect(splitText("😀😀😀😀😀", 2)).toEqual(["😀😀", "😀😀", "😀"])
  })

  it("空串给空数组，不超长原样返回", () => {
    expect(splitText("", 5)).toEqual([])
    expect(splitText("短", 5)).toEqual(["短"])
  })
})

describe("splitMessage", () => {
  it("不超长时原样返回同一个数组", () => {
    const segs = [text("你好")]
    expect(splitMessage(segs, 10)[0]).toBe(segs)
  })

  it("图片跟在它前面那段文本所在的那一条里", () => {
    const out = splitMessage([text("一二三四五六"), image, text("七")], 4)
    expect(out).toEqual([[text("一二三四")], [text("五六"), image, text("七")]])
  })

  it("切完每条的文本都不超过上限", () => {
    const out = splitMessage([text("字 ".repeat(500))], 37)
    for (const msg of out) expect(textLength(msg)).toBeLessThanOrEqual(37)
  })

  it("30 万字无空白长文本线性切完（旧实现是平方级，要十几秒）", () => {
    const started = performance.now()
    const out = splitMessage([text("字".repeat(300_000))], 3000)
    expect(out).toHaveLength(100)
    expect(performance.now() - started).toBeLessThan(1000)
  })
})

/**
 * 模块职责：消息段编解码的单元测试 —— 归一化、媒体引用、纯文本视图、日志摘要
 * 依赖方向：测试文件，只依赖 message/segment
 * 生命周期：纯函数，无夹具
 * 注意事项：这里盯的是文件头那三条取舍能不能一直守住：
 *          媒体**不**擅自转 base64、相邻文本段合并、假值被丢弃。
 *          三条都是"写错了也能跑"的那种缺陷 —— 图片照样发得出去，只是多占几倍
 *          内存；回复照样收得到，只是被平台当成三条内容计费。
 *
 *          路径断言一律以 `resolve()` + `pathToFileURL()` 实时计算，不硬编码
 *          `C:\` 或 `/tmp`：这套代码 Windows 与 Termux 双端都要跑，
 *          把盘符写进测试等于把测试绑死在一个平台上。
 */
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import type { MediaRef, MessageContent, Segment } from "@yunzai-ng/types"
import {
  atUsersOf,
  countByType,
  describeMedia,
  describeMessage,
  hasAtAll,
  imagesOf,
  isSegment,
  quotedIdOf,
  seg,
  textOf,
  toMediaRef,
  toSegments
} from "./segment.js"

/** 本机上一个真实存在写法的绝对路径 */
const ABS = resolve("temp", "示例 图.png")

describe("toSegments 归一化", () => {
  it("裸字符串与数字都变成文本段", () => {
    expect(toSegments("你好")).toEqual([{ type: "text", text: "你好" }])
    expect(toSegments(160)).toEqual([{ type: "text", text: "160" }])
  })

  it("相邻文本段合并成一段", () => {
    // 原样产出三段的话，部分平台会当成三条内容拼接甚至分别计费
    expect(toSegments(["你的体力：", 160, "/160"])).toEqual([{ type: "text", text: "你的体力：160/160" }])
  })

  it("非相邻的文本段各自保留", () => {
    expect(toSegments(["前", seg.at("20000"), "后"])).toEqual([
      { type: "text", text: "前" },
      { type: "at", uid: "20000" },
      { type: "text", text: "后" }
    ])
  })

  it("任意层嵌套数组都被展平", () => {
    expect(toSegments(["a", ["b", ["c", [["d"]]]]])).toEqual([{ type: "text", text: "abcd" }])
  })

  it("null / undefined / false / 空串被丢弃", () => {
    // 于是条件拼装可以直接写 `[e.isGroup && seg.at(uid), "内容"]`
    expect(toSegments([null, undefined, false, "", "正文"])).toEqual([{ type: "text", text: "正文" }])
    expect(toSegments(null)).toEqual([])
    expect(toSegments([])).toEqual([])
  })

  it("数字 0 是有意义的文本，不能跟着假值一起丢", () => {
    expect(toSegments(["剩余 ", 0, " 次"])).toEqual([{ type: "text", text: "剩余 0 次" }])
  })

  it("已经是段的对象原样透传", () => {
    const image = seg.image("https://example.com/a.png")
    const out = toSegments(["看图", image])
    expect(out[1]).toBe(image)
  })

  it("文本段对象也参与合并", () => {
    expect(toSegments([seg.text("甲"), { type: "text", text: "乙" }])).toEqual([{ type: "text", text: "甲乙" }])
  })

  it("空文本段不会额外产生一个段", () => {
    expect(toSegments([seg.text(""), seg.at("1")])).toEqual([{ type: "at", uid: "1" }])
  })

  it("认不出来的对象被丢掉而不是抛错", () => {
    // 平台或插件传入非法数据时，宁可少一个段，亦不应使整条回复无法发出
    expect(toSegments([{ foo: 1 }, "正文"] as unknown as MessageContent)).toEqual([{ type: "text", text: "正文" }])
  })
})

describe("toMediaRef 媒体归一化", () => {
  it("http(s) 链接归到 url", () => {
    expect(toMediaRef("https://example.com/a.png")).toEqual({ kind: "url", url: "https://example.com/a.png" })
    expect(toMediaRef("http://example.com/a.png")).toEqual({ kind: "url", url: "http://example.com/a.png" })
  })

  it("file:// 与绝对路径都归到 path", () => {
    // 经 fileURLToPath 而不是字符串切片：Windows 盘符与 %20 转义都要正确还原
    expect(toMediaRef(pathToFileURL(ABS).href)).toEqual({ kind: "path", path: ABS })
    expect(toMediaRef(pathToFileURL(ABS))).toEqual({ kind: "path", path: ABS })
    expect(toMediaRef(ABS)).toEqual({ kind: "path", path: ABS })
  })

  it("URL 对象按协议分流", () => {
    expect(toMediaRef(new URL("https://example.com/a.png"))).toEqual({
      kind: "url",
      url: "https://example.com/a.png"
    })
  })

  it("base64:// 前缀归到 base64", () => {
    expect(toMediaRef("base64://QUJD")).toEqual({ kind: "base64", base64: "QUJD" })
  })

  it("data URI 归到 base64 并带上 mime", () => {
    expect(toMediaRef("data:image/png;base64,QUJD")).toEqual({ kind: "base64", base64: "QUJD", mime: "image/png" })
    expect(toMediaRef("data:text/plain;charset=utf-8;base64,QUJD")).toEqual({
      kind: "base64",
      base64: "QUJD",
      mime: "text/plain"
    })
    // 未标注 mime 的 data URI 不应写入一个空串 mime
    expect(toMediaRef("data:;base64,QUJD")).toEqual({ kind: "base64", base64: "QUJD" })
  })

  it("字节直接归到 buffer，不做 base64 编码", () => {
    const bytes = new Uint8Array([1, 2, 3])
    const ref = toMediaRef(bytes)
    expect(ref).toEqual({ kind: "buffer", data: bytes })
    // 同一块内存，不做拷贝：base64 会让 2MB 的图多占 2.7MB
    if (ref.kind === "buffer") expect(ref.data).toBe(bytes)
  })

  it("ArrayBuffer 包成 Uint8Array 视图", () => {
    const buf = new ArrayBuffer(2)
    new Uint8Array(buf).set([7, 8])
    expect(toMediaRef(buf)).toEqual({ kind: "buffer", data: new Uint8Array([7, 8]) })
  })

  it("已归一化的引用原样返回，不重复包装", () => {
    const ref: MediaRef = { kind: "id", id: "file-123" }
    expect(toMediaRef(ref)).toBe(ref)
  })

  it("相对路径被拒绝，并指出该用 ctx.resource", () => {
    // 内核无从判定其解析基准，判定错误的表现为"图片无法发出但未产生报错"
    expect(() => toMediaRef("./resources/a.png")).toThrow(/ctx\.resource/)
    expect(() => toMediaRef("a.png")).toThrow(/无法识别的媒体引用/)
  })

  it("空串被拒绝", () => {
    expect(() => toMediaRef("")).toThrow("媒体引用不能为空串")
  })
})

describe("seg 构造器", () => {
  it("可选参数没传时不留 undefined 键", () => {
    // 留着的话适配器 `if ("name" in s)` 之类的判断会误判，序列化出去也多一个 null
    expect(seg.at("20000")).toEqual({ type: "at", uid: "20000" })
    expect(Object.keys(seg.at("20000"))).toEqual(["type", "uid"])
    expect(Object.keys(seg.face(1))).toEqual(["type", "id"])
    expect(Object.keys(seg.poke())).toEqual(["type"])
    expect(Object.keys(seg.dice())).toEqual(["type"])
    expect(Object.keys(seg.video("https://e.com/v.mp4"))).toEqual(["type", "file"])
  })

  it("可选参数传了就带上", () => {
    expect(seg.at("20000", "阿测")).toEqual({ type: "at", uid: "20000", name: "阿测" })
    expect(seg.face(4, true)).toEqual({ type: "face", id: 4, big: true })
    expect(seg.poke("20000", 2)).toEqual({ type: "poke", uid: "20000", pokeType: 2 })
    expect(seg.dice(6)).toEqual({ type: "dice", result: 6 })
  })

  it("媒体类构造器把来源归一化，附加字段照原样带上", () => {
    expect(seg.image(ABS, { summary: "面板图", width: 800 })).toEqual({
      type: "image",
      file: { kind: "path", path: ABS },
      summary: "面板图",
      width: 800
    })
    expect(seg.file("base64://QUJD", { name: "a.txt" })).toEqual({
      type: "file",
      file: { kind: "base64", base64: "QUJD" },
      name: "a.txt"
    })
    expect(seg.video("https://e.com/v.mp4", ABS)).toEqual({
      type: "video",
      file: { kind: "url", url: "https://e.com/v.mp4" },
      thumb: { kind: "path", path: ABS }
    })
  })

  it("json 接对象时自动序列化", () => {
    expect(seg.json({ app: "com.tencent.miniapp" })).toEqual({
      type: "json",
      data: '{"app":"com.tencent.miniapp"}'
    })
    expect(seg.json('{"raw":1}')).toEqual({ type: "json", data: '{"raw":1}' })
  })

  it("转发节点的内容也走归一化", () => {
    const node = seg.node(["第", 1, "条"], { name: "阿测", uid: "20000" })
    expect(node).toEqual({ message: [{ type: "text", text: "第1条" }], name: "阿测", uid: "20000" })

    expect(seg.forward([node], { summary: "查看 1 条转发" })).toEqual({
      type: "forward",
      nodes: [node],
      summary: "查看 1 条转发"
    })
  })

  it("音乐分两种：平台歌曲与自定义卡片", () => {
    expect(seg.music("163", "123")).toEqual({ type: "music", platform: "163", id: "123" })
    expect(seg.musicCustom({ title: "曲名", url: "https://e.com/s", audio: "https://e.com/a.mp3" })).toEqual({
      type: "music",
      platform: "custom",
      title: "曲名",
      url: "https://e.com/s",
      audio: "https://e.com/a.mp3"
    })
  })

  it("raw 段为平台私有内容的兼容出口", () => {
    expect(seg.raw("napcat", "mface", { emoji_id: "x" })).toEqual({
      type: "raw",
      platform: "napcat",
      platformType: "mface",
      data: { emoji_id: "x" }
    })
  })
})

describe("派生视图", () => {
  /** 一条什么都有的消息 */
  const rich: Segment[] = [
    seg.reply("m-1"),
    seg.at("10000", "机器人"),
    seg.at("20000"),
    seg.at("20000"),
    seg.at(""),
    seg.text("  查一下 "),
    seg.atAll(),
    seg.image("https://e.com/1.png"),
    seg.image(ABS),
    seg.text("角色  ")
  ]

  it("textOf 只拼文本段并 trim", () => {
    expect(textOf(rich)).toBe("查一下 角色")
    expect(textOf([])).toBe("")
    expect(textOf([seg.image(ABS)])).toBe("")
  })

  it("imagesOf 按出现顺序取全部图片", () => {
    expect(imagesOf(rich).map(i => i.file.kind)).toEqual(["url", "path"])
  })

  it("atUsersOf 去重保序并忽略空 uid", () => {
    expect(atUsersOf(rich)).toEqual(["10000", "20000"])
  })

  it("hasAtAll 认 atAll 段", () => {
    expect(hasAtAll(rich)).toBe(true)
    expect(hasAtAll([seg.at("20000")])).toBe(false)
  })

  it("quotedIdOf 取第一个 reply 段", () => {
    expect(quotedIdOf(rich)).toBe("m-1")
    expect(quotedIdOf([seg.reply("a"), seg.reply("b")])).toBe("a")
    expect(quotedIdOf([seg.text("无引用")])).toBeUndefined()
  })

  it("countByType 统计各类型条数", () => {
    expect(countByType(rich)).toEqual({ reply: 1, at: 4, text: 2, atAll: 1, image: 2 })
    expect(countByType([])).toEqual({})
  })

  it("isSegment 只认有 type 字符串的对象", () => {
    expect(isSegment(seg.text("x"))).toBe(true)
    expect(isSegment({ type: "谁知道是什么" })).toBe(true)
    expect(isSegment({ type: 1 })).toBe(false)
    expect(isSegment(null)).toBe(false)
    expect(isSegment("text")).toBe(false)
  })
})

describe("日志摘要", () => {
  it("describeMedia 对 base64 与字节只报长度", () => {
    // 把 2MB 的 base64 写进日志既没用又会把轮转打满，混在里面的 CK 还会泄露
    expect(describeMedia({ kind: "base64", base64: "QUJD" })).toBe("base64 4 字符")
    expect(describeMedia({ kind: "buffer", data: new Uint8Array(2048) })).toBe("2048 字节")
    expect(describeMedia({ kind: "id", id: "f-1" })).toBe("id:f-1")
    expect(describeMedia({ kind: "path", path: ABS })).toBe(ABS)
  })

  it("describeMedia 把超长 url 截断", () => {
    const long = `https://example.com/${"a".repeat(80)}.png`
    const out = describeMedia({ kind: "url", url: long })
    expect([...out]).toHaveLength(61)
    expect(out.endsWith("…")).toBe(true)
  })

  it("describeMessage 贴着聊天窗口的样子拼一行", () => {
    expect(
      describeMessage([
        seg.reply("m-1"),
        seg.at("20000", "阿测"),
        seg.at("30000"),
        seg.atAll(),
        seg.text("查\n角色"),
        seg.face(4),
        seg.image("https://e.com/1.png"),
        seg.record(ABS),
        seg.video(ABS),
        seg.file(ABS, { name: "a.txt" }),
        seg.forward([seg.node("一条")]),
        seg.json("{}"),
        seg.markdown("# 标题"),
        seg.keyboard([[{ label: "按我", action: "input", data: "#帮助" }]]),
        seg.raw("napcat", "mface", {})
      ])
    ).toBe("[回复m-1][@阿测][@30000][@全体]查 角色[表情4][图片 https://e.com/1.png][语音][视频][文件 a.txt][合并转发 1][卡片][Markdown][按钮][napcat:mface]")
  })

  it("describeMessage 里的媒体只出摘要，不出正文", () => {
    const out = describeMessage([seg.image(`base64://${"Q".repeat(200)}`)])
    expect(out).toBe("[图片 base64 200 字符]")
    expect(out).not.toContain("QQQ")
  })

  it("describeMessage 把超长文本截断", () => {
    const out = describeMessage([seg.text("字".repeat(50))])
    expect([...out]).toHaveLength(41)
    expect(out.endsWith("…")).toBe(true)
  })
})

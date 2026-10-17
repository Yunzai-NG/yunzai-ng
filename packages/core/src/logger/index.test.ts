import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { parseRecord } from "./format.js"
import { createLoggerHub, type LoggerHub } from "./index.js"

/** 每个用例各自的日志目录，收尾一并删掉 */
const dirs: string[] = []

/** 用完要关的枢纽，否则文件句柄留到进程结束 */
const hubs: LoggerHub[] = []

/**
 * 建一个写真实文件、不打控制台的枢纽
 * @param level 全局级别
 * @returns 枢纽与它的日志目录
 */
async function make(level: "trace" | "debug" | "info" | "warn" = "info"): Promise<{ hub: LoggerHub; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "yzng-log-"))
  dirs.push(dir)
  const hub = createLoggerHub({ level, dir, basename: "test", console: false, color: false })
  hubs.push(hub)
  return { hub, dir }
}

/**
 * 读出已落盘的那份日志文本
 * @param hub 枢纽
 * @returns 文件内容
 */
async function fileText(hub: LoggerHub): Promise<string> {
  hub.flush()
  const file = hub.file
  expect(file).toBeDefined()
  return readFile(file as string, "utf8")
}

afterEach(async () => {
  for (const hub of hubs.splice(0)) hub.close()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe("LoggerHub 的级别语义", () => {
  it("级别设为 info 时，debug 仍然落盘 —— 历史日志留全量", async () => {
    const { hub } = await make("info")
    hub.root.debug("一条调试")
    hub.root.info("一条常规")

    const text = await fileText(hub)
    expect(text).toContain("一条调试")
    expect(text).toContain("一条常规")
  })

  it("查看器缺省按当前级别过滤，显式给 level 能翻出更低的那些", async () => {
    const { hub } = await make("info")
    hub.root.debug("一条调试")
    hub.root.info("一条常规")

    // 缺省：只给 info 及以上，与控制台看到的一致
    expect(hub.tail().map(rec => rec.msg)).toEqual(["一条常规"])
    // 显式放宽：缓冲里本来就存着，故翻得回去
    expect(hub.tail({ level: "debug" }).map(rec => rec.msg)).toEqual(["一条调试", "一条常规"])
  })

  it("调低级别之后，之前那段 debug 仍在缓冲里 —— 不留空白", async () => {
    const { hub } = await make("info")
    hub.root.debug("调级别之前")
    hub.setLevel("debug")
    hub.root.debug("调级别之后")

    expect(hub.tail().map(rec => rec.msg)).toEqual(["调级别之前", "调级别之后"])
  })

  it("setLevel 缺省不动文件那一路", async () => {
    const { hub } = await make("info")
    hub.setLevel("warn")
    hub.root.debug("压到 warn 之后的调试")

    expect(await fileText(hub)).toContain("压到 warn 之后的调试")
  })

  it("显式给 file 才改文件级别，低于它的不再落盘", async () => {
    const { hub } = await make("info")
    hub.setLevel("warn", "file")
    hub.root.debug("这条不该落盘")
    hub.root.warn("这条该落盘")

    const text = await fileText(hub)
    expect(text).not.toContain("这条不该落盘")
    expect(text).toContain("这条该落盘")
  })

  it("silent 只闭掉控制台，文件照旧收全量", async () => {
    const { hub } = await make("info")
    hub.setLevel("silent", "console")
    hub.root.info("控制台看不到但要留下")

    expect(await fileText(hub)).toContain("控制台看不到但要留下")
  })
})

describe("LoggerHub 的记录格式", () => {
  it("文件行是一行一个 JSON，字段顺序与旧格式一致，子日志器的字段逐层叠加", async () => {
    const { hub } = await make("info")
    hub.root.child({ scope: "plug" }).child({ account: "123", n: 5 }).warn("子日志器", "带参数", 42)

    const [line] = (await fileText(hub)).trim().split("\n")
    expect(line).toMatch(/^\{"level":40,"time":\d+,"scope":"plug","account":"123","n":5,"msg":"子日志器 带参数 42"\}$/)
    expect(parseRecord(line ?? "")).toMatchObject({ level: "warn", scope: "plug", fields: { account: "123", n: 5 } })
  })

  it("错误带上类型、cause 链与自有字段，查看器里拿得到堆栈", async () => {
    const { hub } = await make("info")
    const err = Object.assign(new Error("外层", { cause: new TypeError("根因") }), { code: "E_X" })
    hub.root.error("出错了", err)

    const rec = JSON.parse((await fileText(hub)).trim()) as { err: Record<string, unknown>; msg: string }
    expect(rec.msg).toBe("出错了 外层")
    expect(rec.err).toMatchObject({ type: "Error", message: "外层: 根因", code: "E_X" })
    expect(String(rec.err["stack"])).toMatch(/Error: 外层[\s\S]*caused by: TypeError: 根因/)
    expect(hub.tail()[0]?.stack).toMatch(/caused by: TypeError: 根因/)
  })

  it("**环形对象当字段不抛错**：一个插件塞错东西不能把调用方炸掉", async () => {
    const { hub } = await make("info")
    const circ: Record<string, unknown> = { a: 1 }
    circ["self"] = circ

    expect(() => hub.root.child({ circ }).info("环")).not.toThrow()
    expect(await fileText(hub)).toContain('"self":"[Circular]"')
  })

  it("消息里的引号与换行照样是合法 JSON", async () => {
    const { hub } = await make("info")
    hub.root.info('引号 " 与\n换行')

    expect((JSON.parse((await fileText(hub)).trim()) as { msg: string }).msg).toBe('引号 " 与\n换行')
  })

  it("订阅者收到的记录与缓冲里的是同一份", async () => {
    const { hub } = await make("info")
    const got: string[] = []
    hub.subscribe(rec => got.push(`${rec.scope ?? ""}:${rec.msg}`))
    hub.root.child({ scope: "s" }).info("推送")

    expect(got).toEqual(["s:推送"])
    expect(hub.tail().map(rec => rec.msg)).toEqual(["推送"])
  })
})

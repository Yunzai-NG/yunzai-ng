import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
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

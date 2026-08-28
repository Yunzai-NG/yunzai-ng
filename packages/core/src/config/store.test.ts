/**
 * 模块职责：`ConfigStore` / `ConfigFile` 的行为测试
 * 依赖方向：测试文件，依赖 config/*、util/fs
 * 生命周期：每个用例一个临时目录
 * 注意事项：重点覆盖四项 —— 损坏文件不导致崩溃、新增选项自动补齐、
 *          细粒度失效、外部改动热加载。文件内容断言只针对"关键片段"，
 *          不锁定整段 YAML 排版，以免排版微调即导致测试失败。
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { LogLevel, Logger } from "@yunzai-ng/types"
import { ConfigStore } from "./store.js"
import { s } from "./schema.js"

/** 收集日志的假日志器，用于断言"出错时有提示而不是抛异常" */
function fakeLogger(): Logger & { lines: string[] } {
  const lines: string[] = []
  const push =
    (level: string) =>
    (msg: unknown, ...args: unknown[]) => {
      lines.push(`${level} ${String(msg)} ${args.map(a => (a instanceof Error ? a.message : String(a))).join(" ")}`.trim())
    }
  const logger: Logger & { lines: string[] } = {
    lines,
    level: "trace" as LogLevel,
    trace: push("trace"),
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    fatal: push("fatal"),
    mark: push("info"),
    child: () => logger,
    isLevelEnabled: () => true
  }
  return logger
}

/** 测试用配置：一个典型的"内核 + 账号数组"形状 */
const demoSchema = s.object({
  bot: s.object({
    masterQQ: s.ids().default([]).title("主人 QQ"),
    prefix: s.string().default("#").title("命令前缀")
  }),
  render: s.object({
    quality: s.number().min(50).max(100).default(90).title("图片质量")
  })
})

describe("ConfigStore", () => {
  let dir: string
  let logger: ReturnType<typeof fakeLogger>
  let store: ConfigStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "yzng-conf-"))
    logger = fakeLogger()
    store = new ConfigStore({ dir, logger, watch: false })
  })

  afterEach(async () => {
    store.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  it("首次声明就写出带中文注释的默认配置文件", async () => {
    const conf = await store.define("demo", demoSchema, { title: "示例配置" })

    expect(conf.get()).toEqual({ bot: { masterQQ: [], prefix: "#" }, render: { quality: 90 } })

    const text = await readFile(conf.file, "utf8")
    expect(text).toContain("Yunzai NG 配置：示例配置")
    expect(text).toContain("# 主人 QQ")
    expect(text).toContain("# 命令前缀")
    // 注释里带上取值范围，用户不用翻文档
    expect(text).toContain("取值范围：50 ~ 100")
    expect(text).toContain("quality: 90")
  })

  it("读回自己写出的文件后值不变（序列化/解析闭环）", async () => {
    const first = await store.define("demo", demoSchema)
    await first.patch({ bot: { masterQQ: ["10086"] } })
    const written = await readFile(first.file, "utf8")

    // 换一个 store 模拟重启
    const store2 = new ConfigStore({ dir, logger, watch: false })
    const second = await store2.define("demo", demoSchema)
    expect(second.get()).toEqual({ bot: { masterQQ: ["10086"], prefix: "#" }, render: { quality: 90 } })
    // 重启不该无谓地改写文件
    expect(await readFile(second.file, "utf8")).toBe(written)
    store2.dispose()
  })

  it("升级后新增的配置项会自动补进既有文件", async () => {
    // 模拟老版本留下的配置：只有 bot 段，且缺 prefix
    await writeFile(join(dir, "demo.yaml"), "bot:\n  masterQQ:\n    - '10086'\n", "utf8")

    const conf = await store.define("demo", demoSchema)
    expect(conf.get()).toEqual({ bot: { masterQQ: ["10086"], prefix: "#" }, render: { quality: 90 } })

    const text = await readFile(conf.file, "utf8")
    expect(text).toContain("prefix:")
    expect(text).toContain("quality: 90")
    expect(text).toContain("# 图片质量")
    // 用户原有的值一个都不能丢
    expect(text).toContain("10086")
  })

  it("YAML 语法写坏时退回默认值、记错误、且绝不覆盖用户文件", async () => {
    const broken = "bot:\n  masterQQ: [1, 2\n" // 括号没闭合
    const file = join(dir, "demo.yaml")
    await writeFile(file, broken, "utf8")

    const conf = await store.define("demo", demoSchema)

    expect(conf.get()).toEqual({ bot: { masterQQ: [], prefix: "#" }, render: { quality: 90 } })
    expect(logger.lines.some(l => l.startsWith("error") && l.includes("YAML 语法有误"))).toBe(true)
    // 关键：坏文件原样留着，用户能照报错去修
    expect(await readFile(file, "utf8")).toBe(broken)
  })

  it("校验不通过时沿用上一份可用配置，不覆盖用户文件", async () => {
    const conf = await store.define("demo", demoSchema)
    await conf.patch({ render: { quality: 70 } })

    const bad = "render:\n  quality: 999\n"
    await writeFile(conf.file, bad, "utf8")
    const issues = await conf.load("file", false)

    expect(issues.some(i => i.severity === "error" && i.path === "render.quality")).toBe(true)
    expect(conf.get().render.quality).toBe(70)
    expect(await readFile(conf.file, "utf8")).toBe(bad)
  })

  it("patch 校验失败时抛错且配置与文件都不变", async () => {
    const conf = await store.define("demo", demoSchema)
    const before = await readFile(conf.file, "utf8")

    await expect(conf.patch({ render: { quality: 5 } })).rejects.toThrow(/quality/)
    expect(conf.get().render.quality).toBe(90)
    expect(await readFile(conf.file, "utf8")).toBe(before)
  })

  it("变更事件带上精确的变更路径", async () => {
    const conf = await store.define("demo", demoSchema)
    const seen: string[][] = []
    conf.onChange(change => seen.push(change.paths))

    await conf.patch({ bot: { prefix: "/" } })
    expect(seen).toEqual([["bot.prefix"]])
  })

  it("watch(path) 仅通知关注该路径的订阅者", async () => {
    const conf = await store.define("demo", demoSchema)
    const renderCb = vi.fn()
    const botCb = vi.fn()
    conf.watch("render", renderCb)
    conf.watch("bot.masterQQ", botCb)

    await conf.patch({ render: { quality: 80 } })
    expect(renderCb).toHaveBeenCalledTimes(1)
    expect(botCb).not.toHaveBeenCalled()

    // 改父路径要通知订阅子路径的人
    await conf.replace({ bot: { masterQQ: ["1"], prefix: "#" }, render: { quality: 80 } })
    expect(botCb).toHaveBeenCalledTimes(1)
    expect(renderCb).toHaveBeenCalledTimes(1)
  })

  it("值没有实质变化时不触发通知也不写盘", async () => {
    const conf = await store.define("demo", demoSchema)
    const cb = vi.fn()
    conf.onChange(cb)

    await conf.patch({ render: { quality: 90 } })
    expect(cb).not.toHaveBeenCalled()
  })

  it("订阅回调抛错不影响其他订阅者", async () => {
    const conf = await store.define("demo", demoSchema)
    const good = vi.fn()
    conf.onChange(() => {
      throw new Error("坏回调")
    })
    conf.onChange(good)

    await conf.patch({ bot: { prefix: "!" } })
    expect(good).toHaveBeenCalledTimes(1)
    expect(logger.lines.some(l => l.includes("变更回调抛错"))).toBe(true)
  })

  it("取消订阅后不再收到通知", async () => {
    const conf = await store.define("demo", demoSchema)
    const cb = vi.fn()
    const off = conf.onChange(cb)
    off()

    await conf.patch({ bot: { prefix: "!" } })
    expect(cb).not.toHaveBeenCalled()
  })

  it("reset 恢复默认值", async () => {
    const conf = await store.define("demo", demoSchema)
    await conf.patch({ bot: { prefix: "!", masterQQ: ["10086"] } })
    await conf.reset()
    expect(conf.get()).toEqual({ bot: { masterQQ: [], prefix: "#" }, render: { quality: 90 } })
  })

  it("重复声明同名配置直接抛错，而不是让后者悄悄顶掉前者", async () => {
    await store.define("demo", demoSchema)
    await expect(store.define("demo", demoSchema)).rejects.toThrow(/已被声明/)
  })

  it("拒绝非法配置名（防止越出配置目录）", async () => {
    await expect(store.define("../evil", demoSchema)).rejects.toThrow(/不合法/)
    await expect(store.define("a/b", demoSchema)).rejects.toThrow(/不合法/)
  })

  it("list() 给 WebUI 提供表单描述", async () => {
    await store.define("zeta", demoSchema, { title: "Z" })
    await store.define("alpha", demoSchema, { title: "A" })

    const list = store.list()
    expect(list.map(i => i.name)).toEqual(["alpha", "zeta"])
    expect(list[0]?.schema.properties?.bot?.properties?.prefix?.title).toBe("命令前缀")
  })

  it("外部手改文件后自动热加载（走真实 fs.watch）", async () => {
    const watched = new ConfigStore({ dir, logger, watch: true })
    try {
      const conf = await watched.define("demo", demoSchema)
      watched.startWatching()

      const changed = new Promise<string[]>(resolve => conf.onChange(c => resolve(c.paths)))
      await writeFile(conf.file, "bot:\n  prefix: '/'\n", "utf8")

      await expect(changed).resolves.toEqual(["bot.prefix"])
      expect(conf.get().bot.prefix).toBe("/")
    } finally {
      watched.dispose()
    }
  }, 10_000)
})

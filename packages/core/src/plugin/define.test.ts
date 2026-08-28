/**
 * 模块职责：`definePlugin()` 与两个判定函数的测试
 * 依赖方向：测试文件
 * 生命周期：纯函数，无需清理
 * 注意事项：插件名会被同时用作**配置文件名、KV 命名空间、URL 前缀、日志 scope**，
 *          因此"非法名称必须在 import 的那一刻即抛错"是此处的核心断言 ——
 *          若予放行，症状将表现为写入配置时一个无从解释的 ENOENT，或更为严重的情形：
 *          一个插件读写到了其他插件的 KV 命名空间。
 */
import { describe, expect, it } from "vitest"
import { definePlugin, isPluginDefinition, looksLikePlugin } from "./define.js"
import { s } from "../config/schema.js"

/** 品牌标记用的注册表符号（插件与内核可能来自不同模块实例，故用 Symbol.for） */
const BRAND = Symbol.for("yunzai-ng.plugin")

describe("definePlugin", () => {
  it("返回带品牌标记的定义", () => {
    const def = definePlugin({ name: "demo", setup: () => undefined })

    expect(def.name).toBe("demo")
    expect(isPluginDefinition(def)).toBe(true)
  })

  it("原样保留元信息与 schema", () => {
    const schema = s.object({ cookie: s.string().default("") })
    const def = definePlugin({
      name: "mhy-game",
      version: "1.0.0",
      description: "米哈游游戏插件",
      author: "someone",
      dependencies: ["renderer-puppeteer"],
      priority: 50,
      configSchema: schema,
      setup: () => undefined
    })

    expect(def).toMatchObject({
      name: "mhy-game",
      version: "1.0.0",
      description: "米哈游游戏插件",
      dependencies: ["renderer-puppeteer"],
      priority: 50
    })
    expect(def.configSchema).toBe(schema)
  })

  it("冻结定义，插件改不动自己的元信息", () => {
    const def = definePlugin({ name: "demo", setup: () => undefined })
    // 改了内核也不会重新读，只会让人以为改生效了
    expect(() => {
      ;(def as { name: string }).name = "别的名字"
    }).toThrow()
  })

  it("缺 name 就抛错", () => {
    expect(() => definePlugin({ setup: () => undefined } as never)).toThrow(/缺少 name/)
    expect(() => definePlugin({ name: "", setup: () => undefined })).toThrow(/缺少 name/)
  })

  it("非法插件名抛错并说明规则", () => {
    for (const name of ["1abc", "有中文", "with space", "a:b", "a/b", "-lead", "_lead"]) {
      expect(() => definePlugin({ name, setup: () => undefined }), name).toThrow(/不合法/)
    }
  })

  it("合法插件名放行", () => {
    for (const name of ["demo", "mhy-game-plugin", "adapter.napcat", "A_b-1", "x"]) {
      expect(() => definePlugin({ name, setup: () => undefined }), name).not.toThrow()
    }
  })

  it("缺 setup 抛错", () => {
    expect(() => definePlugin({ name: "demo" } as never)).toThrow(/缺少 setup/)
  })

  it("dependencies 写法错误抛错", () => {
    expect(() => definePlugin({ name: "demo", dependencies: "other" as never, setup: () => undefined })).toThrow(
      /必须是字符串数组/
    )
    expect(() => definePlugin({ name: "demo", dependencies: [""], setup: () => undefined })).toThrow(/含空项/)
    expect(() => definePlugin({ name: "demo", dependencies: ["demo"], setup: () => undefined })).toThrow(/依赖了自己/)
  })

  it("priority 必须是数字", () => {
    expect(() => definePlugin({ name: "demo", priority: Number.NaN, setup: () => undefined })).toThrow(
      /priority 必须是数字/
    )
  })
})

describe("isPluginDefinition", () => {
  it("只认 definePlugin 的产物", () => {
    expect(isPluginDefinition({ name: "demo", setup: () => undefined })).toBe(false)
    expect(isPluginDefinition(undefined)).toBe(false)
    expect(isPluginDefinition(null)).toBe(false)
    expect(isPluginDefinition("demo")).toBe(false)
    expect(isPluginDefinition(() => undefined)).toBe(false)
  })

  it("品牌用注册表符号，跨模块实例也认得", () => {
    // 插件可能链接了另一份 @yunzai-ng/core（版本不同的两个 node_modules 副本）。
    // Symbol.for 是全进程共享的，所以这种情况下判定仍然成立 ——
    // 换成模块内的 Symbol() 就会退化成"看起来像插件"的宽松路径。
    expect(isPluginDefinition({ name: "demo", setup: () => undefined, [BRAND]: true })).toBe(true)
  })
})

describe("looksLikePlugin", () => {
  it("有 name 与 setup 即可（手写定义、compat 插件动态生成的定义）", () => {
    expect(looksLikePlugin({ name: "demo", setup: () => undefined })).toBe(true)
  })

  it("缺一个就不算", () => {
    expect(looksLikePlugin({ name: "demo" })).toBe(false)
    expect(looksLikePlugin({ setup: () => undefined })).toBe(false)
    expect(looksLikePlugin({ name: 1, setup: () => undefined })).toBe(false)
    expect(looksLikePlugin(null)).toBe(false)
  })
})

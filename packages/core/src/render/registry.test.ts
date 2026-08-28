/**
 * 模块职责：渲染注册表的埋点用例 —— `render/done` 与「渲染完成」日志行
 * 依赖方向：测试文件，依赖 render/registry 与 testing/fake
 * 生命周期：每个用例新建一个注册表
 * 注意事项：只测**埋点那一部分**（日志级别、字节数、成败两路都发事件），
 *          注册表原有的择一、重试、可用性缓存等行为不在此处重复覆盖。
 *
 *          用真实的 `RenderRegistry` 配一个假渲染器，而不是 mock 注册表本身：
 *          「全部渲染器失败时也要发一次事件」这条只在真实的重试与切换流程走完
 *          之后才成立，替身对象测不到。
 */
import { describe, expect, it } from "vitest"
import type { RenderDoneInfo, RenderRequest, RenderResult, RendererProvider } from "@yunzai-ng/types"
import { fakeLogger, type FakeLogger } from "../testing/fake.js"
import { RenderRegistry, type RenderPolicy } from "./registry.js"

/** 不重试、不超时的策略，使用例只观察埋点 */
const POLICY: RenderPolicy = { default: "fake", timeout: 5000, retry: 0, quality: 90, scale: 1 }

/**
 * 造一个最小渲染请求
 * @param template 模板标识
 * @returns 渲染请求
 */
function request(template = "demo/card"): RenderRequest {
  return { template, data: {}, templateRoot: "/tpl", resourceRoot: "/res", origin: "demo-plugin" }
}

/**
 * 造一个假渲染器
 * @param impl 出图实现；抛错即视作渲染失败
 * @returns 渲染器实现
 */
function fakeRenderer(impl: () => Promise<RenderResult>): RendererProvider {
  return {
    id: "fake",
    name: "假渲染器",
    available: () => Promise.resolve(true),
    render: () => impl()
  }
}

/** 一套注册表与它收到的埋点 */
interface Fixture {
  /** 注册表 */
  registry: RenderRegistry
  /** 假日志器，断言日志行用 */
  logger: FakeLogger
  /** 收到的 `render/done` 载荷，按顺序 */
  done: RenderDoneInfo[]
}

/**
 * 建一套夹具
 * @param impl 假渲染器的出图实现
 * @returns 夹具
 */
function setup(impl: () => Promise<RenderResult>): Fixture {
  const logger = fakeLogger()
  const done: RenderDoneInfo[] = []
  const registry = new RenderRegistry({ logger, policy: () => POLICY, onDone: info => done.push(info) })
  registry.register(fakeRenderer(impl), "fake-plugin")
  return { registry, logger, done }
}

describe("渲染埋点", () => {
  it("出图成功：发一次 render/done，带张数、字节数与耗时", async () => {
    const { registry, done } = setup(() =>
      Promise.resolve({ images: [new Uint8Array(1024), new Uint8Array(2048)], cost: 123, renderer: "fake" })
    )

    await registry.render(request())

    expect(done).toHaveLength(1)
    expect(done[0]).toMatchObject({
      renderer: "fake",
      template: "demo/card",
      images: 2,
      bytes: 3072,
      cost: 123,
      ok: true
    })
    expect(done[0]?.error).toBeUndefined()
  })

  it("「渲染完成」记在 info 而非 debug —— 默认级别下要看得见", async () => {
    const { registry, logger } = setup(() =>
      Promise.resolve({ images: [new Uint8Array(2048)], cost: 88, renderer: "fake" })
    )

    await registry.render(request())

    const line = logger.lines.find(l => l.includes("渲染完成"))
    expect(line).toBeDefined()
    expect(line?.startsWith("info ")).toBe(true)
    // 字节数以可读形式附在行内：出图异常大往往是模板漏了尺寸约束，只看张数看不出来
    expect(line).toContain("2.00KB")
    expect(line).toContain("88ms")
  })

  it("全部渲染器失败：照旧抛出，但也发一次 ok=false 的 render/done", async () => {
    const { registry, done } = setup(() => Promise.reject(new Error("Chromium 没装")))

    await expect(registry.render(request("demo/fail"))).rejects.toThrow("渲染失败")

    // 只在成功时发事件的话，统计出的成功率恒为 100%
    expect(done).toHaveLength(1)
    expect(done[0]?.ok).toBe(false)
    expect(done[0]?.template).toBe("demo/fail")
    expect(done[0]?.images).toBe(0)
    expect(done[0]?.error).toContain("Chromium 没装")
    // 这一次没有任何渲染器出图，renderer 填谁都是错的
    expect(done[0]?.renderer).toBe("")
  })

  it("不传 onDone 也能正常渲染（现有调用方无须改动）", async () => {
    const logger = fakeLogger()
    const registry = new RenderRegistry({ logger, policy: () => POLICY })
    registry.register(
      fakeRenderer(() => Promise.resolve({ images: [new Uint8Array(16)], cost: 5, renderer: "fake" })),
      "fake-plugin"
    )

    const result = await registry.render(request())
    expect(result.images).toHaveLength(1)
  })
})

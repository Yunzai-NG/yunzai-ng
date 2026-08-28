/**
 * 模块职责：`ServiceRegistry` 行为测试
 * 依赖方向：测试文件
 * 生命周期：每个用例一个注册表
 * 注意事项：重点覆盖"取代 runtime.js 硬编码 getter"这项设计的边界：重复注册须抛错、
 *          缺失须给出可操作的错误、卸载后不得残留失效引用、等待者不得阻止进程退出。
 */
import { describe, expect, it } from "vitest"
import { createServiceRegistry } from "./services.js"

describe("ServiceRegistry", () => {
  it("provide 后可被 get / has / require 取到", () => {
    const reg = createServiceRegistry()
    const api = { hello: () => "hi" }
    reg.provide("mihoyo.api", api, "mhy-game")

    expect(reg.has("mihoyo.api")).toBe(true)
    expect(reg.get<typeof api>("mihoyo.api")).toBe(api)
    expect(reg.require<typeof api>("mihoyo.api", "other")).toBe(api)
    expect(reg.size).toBe(1)
  })

  it("键名非法时立即抛错", () => {
    const reg = createServiceRegistry()
    expect(() => reg.provide("2bad", 1, "p")).toThrow(/不合法/)
    expect(() => reg.provide("has space", 1, "p")).toThrow(/不合法/)
    expect(() => reg.provide("ok.key-1:sub", 1, "p")).not.toThrow()
  })

  it("同键重复注册抛错，且错误里点明是谁先占的", () => {
    const reg = createServiceRegistry()
    reg.provide("x.y", 1, "first")
    expect(() => reg.provide("x.y", 2, "second")).toThrow(/first/)
    // 冲突不该破坏已有记录
    expect(reg.get("x.y")).toBe(1)
  })

  it("require 缺失时的错误同时说明谁要用、要什么、现在有什么", () => {
    const reg = createServiceRegistry()
    reg.provide("a.b", 1, "p1")
    try {
      reg.require("missing.key", "mhy-game")
      expect.unreachable("require 应当抛错")
    } catch (err) {
      const msg = (err as Error).message
      expect(msg).toContain("mhy-game")
      expect(msg).toContain("missing.key")
      expect(msg).toContain("a.b")
    }
  })

  it("没有任何服务时 require 的错误也说得清楚", () => {
    const reg = createServiceRegistry()
    expect(() => reg.require("k", "p")).toThrow(/没有任何插件提供服务/)
  })

  it("disposer 摘除服务；重复调用无副作用", () => {
    const reg = createServiceRegistry()
    const undo = reg.provide("k", 1, "p")
    undo()
    undo()
    expect(reg.has("k")).toBe(false)
    expect(reg.size).toBe(0)
  })

  it("延迟到达的卸载 disposer 不会摘除后注册者的同名服务", () => {
    const reg = createServiceRegistry()
    const stale = reg.provide("k", "old", "old-plugin")
    // 模拟：旧插件的服务先由 removeByOwner 摘除，新插件随后注册，旧 disposer 最后到达
    reg.removeByOwner("old-plugin")
    reg.provide("k", "new", "new-plugin")
    stale()
    expect(reg.get("k")).toBe("new")
  })

  it("waitFor 在服务已就绪时立即返回", async () => {
    const reg = createServiceRegistry()
    reg.provide("k", 42, "p")
    await expect(reg.waitFor<number>("k")).resolves.toBe(42)
  })

  it("waitFor 等到后来的 provide", async () => {
    const reg = createServiceRegistry()
    const pending = reg.waitFor<string>("late.key")
    expect(reg.pending()).toEqual(["late.key"])
    reg.provide("late.key", "arrived", "p")
    await expect(pending).resolves.toBe("arrived")
    // 兑现后等待队列要清空，否则 list() 里的 waiting 永远挂着
    expect(reg.pending()).toEqual([])
  })

  it("waitFor 超时返回 undefined 而不是抛错", async () => {
    const reg = createServiceRegistry()
    await expect(reg.waitFor("never", 10)).resolves.toBeUndefined()
  })

  it("多个等待者会被同一次 provide 一起唤醒", async () => {
    const reg = createServiceRegistry()
    const all = Promise.all([reg.waitFor<number>("k"), reg.waitFor<number>("k"), reg.waitFor<number>("k")])
    reg.provide("k", 7, "p")
    await expect(all).resolves.toEqual([7, 7, 7])
  })

  it("removeByOwner 摘除该插件的全部服务并返回键名", () => {
    const reg = createServiceRegistry()
    reg.provide("a", 1, "p1")
    reg.provide("b", 2, "p1")
    reg.provide("c", 3, "p2")

    expect(reg.removeByOwner("p1").sort()).toEqual(["a", "b"])
    expect(reg.size).toBe(1)
    expect(reg.get("c")).toBe(3)
  })

  it("list 按键排序并带上等待者数量", async () => {
    const reg = createServiceRegistry()
    reg.provide("z.svc", 1, "p2")
    reg.provide("a.svc", 2, "p1")
    void reg.waitFor("a.svc")

    const list = reg.list()
    expect(list.map(i => i.key)).toEqual(["a.svc", "z.svc"])
    expect(list[0]?.owner).toBe("p1")
    // a.svc 已就绪，waitFor 会立即返回、不进等待队列
    expect(list[0]?.waiting).toBe(0)
  })

  it("clear 唤醒全部等待者，避免停机时被阻塞", async () => {
    const reg = createServiceRegistry()
    const waiting = reg.waitFor("never.coming", 0)
    reg.clear()
    await expect(waiting).resolves.toBeUndefined()
    expect(reg.size).toBe(0)
  })
})

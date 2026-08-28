/**
 * 模块职责：`CoreEventBus` 行为测试
 * 依赖方向：测试文件，依赖 testing/fake
 * 生命周期：每个用例一条总线
 * 注意事项：这里断言的是"不用 EventEmitter"换来的三件事 —— 错误隔离、能等异步、
 *          能按插件批量摘除。其中**一个监听器抛错不能影响其他监听器**为重点。
 */
import { describe, expect, it, vi } from "vitest"
import { createEventBus } from "./events.js"
import { fakeLogger } from "../testing/fake.js"

describe("CoreEventBus", () => {
  it("按注册顺序通知全部监听器", async () => {
    const bus = createEventBus({ logger: fakeLogger() })
    const seen: string[] = []
    bus.on("app/ready", () => void seen.push("a"), "p1")
    bus.on("app/ready", () => void seen.push("b"), "p2")

    await bus.emit("app/ready")
    expect(seen).toEqual(["a", "b"])
  })

  it("一个监听器抛错不影响其余监听器，且 emit 自身不拒绝", async () => {
    const logger = fakeLogger()
    const bus = createEventBus({ logger })
    const seen: string[] = []

    bus.on("app/ready", () => {
      throw new Error("插件写错了")
    }, "bad-plugin")
    bus.on("app/ready", () => void seen.push("still-ran"), "good-plugin")

    await expect(bus.emit("app/ready")).resolves.toBeUndefined()
    expect(seen).toEqual(["still-ran"])
    expect(logger.lines.some(l => l.includes("bad-plugin") && l.includes("出错"))).toBe(true)
  })

  it("异步监听器抛错同样被隔离", async () => {
    const logger = fakeLogger()
    const bus = createEventBus({ logger })
    bus.on("app/stopping", async () => {
      await Promise.resolve()
      throw new Error("保存失败")
    }, "p")

    await expect(bus.emit("app/stopping")).resolves.toBeUndefined()
    expect(logger.lines.some(l => l.includes("保存失败"))).toBe(true)
  })

  it("emit 会等待异步监听器完成（停机时要靠这个）", async () => {
    const bus = createEventBus({ logger: fakeLogger() })
    let saved = false
    bus.on("app/stopping", async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
      saved = true
    }, "p")

    await bus.emit("app/stopping")
    expect(saved).toBe(true)
  })

  it("卡住的监听器会被放弃等待并记警告，而不是吊死停机流程", async () => {
    const logger = fakeLogger()
    const bus = createEventBus({ logger, handlerTimeout: 20 })
    bus.on("app/stopping", () => new Promise<void>(() => undefined), "stuck-plugin")

    await bus.emit("app/stopping")
    expect(logger.lines.some(l => l.includes("stuck-plugin") && l.includes("放弃等待"))).toBe(true)
  })

  it("once 只触发一次，且抛错时同样被摘除", async () => {
    const logger = fakeLogger()
    const bus = createEventBus({ logger })
    const fn = vi.fn(() => {
      throw new Error("boom")
    })
    bus.once("app/ready", fn, "p")

    await bus.emit("app/ready")
    await bus.emit("app/ready")
    expect(fn).toHaveBeenCalledTimes(1)
    expect(bus.count("app/ready")).toBe(0)
  })

  it("监听器在处理中订阅新监听器不会被本次 emit 触发", async () => {
    const bus = createEventBus({ logger: fakeLogger() })
    const seen: string[] = []
    let added = false
    bus.on("app/ready", () => {
      seen.push("first")
      if (added) return
      added = true
      bus.on("app/ready", () => void seen.push("added-during-emit"), "p")
    }, "p")

    // 本次 emit 用的是快照，新加的监听器要等下一次
    await bus.emit("app/ready")
    expect(seen).toEqual(["first"])

    await bus.emit("app/ready")
    expect(seen).toEqual(["first", "first", "added-during-emit"])
  })

  it("disposer 摘除监听器；重复调用无副作用", async () => {
    const bus = createEventBus({ logger: fakeLogger() })
    const fn = vi.fn()
    const undo = bus.on("message", fn, "p")
    undo()
    undo()

    expect(bus.count("message")).toBe(0)
  })

  it("removeByOwner 摘除某插件的全部监听（热重载兜底）", async () => {
    const bus = createEventBus({ logger: fakeLogger() })
    bus.on("app/ready", () => undefined, "p1")
    bus.on("app/stopping", () => undefined, "p1")
    bus.on("app/ready", () => undefined, "p2")

    expect(bus.removeByOwner("p1")).toBe(2)
    expect(bus.count("app/ready")).toBe(1)
    expect(bus.count("app/stopping")).toBe(0)
  })

  it("emitDetached 不等待监听器，但错误照样记录", async () => {
    const logger = fakeLogger()
    const bus = createEventBus({ logger })
    let finished = false
    bus.on("app/ready", async () => {
      await new Promise(resolve => setTimeout(resolve, 10))
      finished = true
      throw new Error("迟到的错误")
    }, "p")

    bus.emitDetached("app/ready")
    expect(finished).toBe(false)

    await new Promise(resolve => setTimeout(resolve, 30))
    expect(finished).toBe(true)
    expect(logger.lines.some(l => l.includes("迟到的错误"))).toBe(true)
  })

  it("list 汇总监听器与触发次数", async () => {
    const bus = createEventBus({ logger: fakeLogger() })
    bus.on("app/ready", () => undefined, "p1")
    await bus.emit("app/ready")

    const list = bus.list()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ event: "app/ready", owner: "p1", calls: 1 })
  })

  it("close 之后不再派发事件", async () => {
    const bus = createEventBus({ logger: fakeLogger() })
    const fn = vi.fn()
    bus.on("app/ready", fn, "p")
    bus.close()

    await bus.emit("app/ready")
    expect(fn).not.toHaveBeenCalled()
  })
})

/**
 * 模块职责：中间件管线的单元测试 —— 洋葱顺序、优先级、事件大类分桶、拦截语义
 * 依赖方向：测试文件，依赖 pipeline/middleware 与 testing/fake
 * 生命周期：每个用例新建一条管线
 * 注意事项：这里也不建真事件 —— 管线只读 `kind`/`stopped`/`id` 三个字段。
 *          真事件那一侧（中间件改写 message 后路由按改写结果匹配）由
 *          kernel/runtime.test.ts 覆盖。
 *
 *          顺序断言一律用一个 `trace: string[]`，进出各记一笔（`a>` / `a<`）。
 *          仅断言"哪些中间件被执行"并不充分：中间件最易出错之处为 `next()` 之后的收尾代码
 *          跑在了内层之前，而那只有进出成对记录才看得出来。
 */
import { describe, expect, it } from "vitest"
import type { AnyEvent, EventKind, Middleware, MiddlewareOptions } from "@yunzai-ng/types"
import type { MiddlewareRegistration } from "../plugin/hooks.js"
import { fakeLogger, type FakeLogger } from "../testing/fake.js"
import { MiddlewarePipeline } from "./middleware.js"

/** 够管线用的假事件 */
interface FakeEvent {
  /** 事件大类 */
  kind: EventKind
  /** 事件 id */
  id: string
  /** 是否已被阻断 */
  stopped: boolean
  /** 阻断 */
  stop: () => void
}

/**
 * 造一个假事件
 * @param kind 事件大类，缺省消息
 * @returns 假事件
 */
function ev(kind: EventKind = "message"): FakeEvent {
  const e: FakeEvent = {
    kind,
    id: `e-${kind}`,
    stopped: false,
    stop: () => {
      e.stopped = true
    }
  }
  return e
}

/**
 * 造一条中间件登记
 * @param plugin 插件名
 * @param fn 中间件函数
 * @param options 注册选项
 * @returns 登记内容
 */
function reg(plugin: string, fn: Middleware, options: MiddlewareOptions = {}): MiddlewareRegistration {
  return { plugin, fn, options }
}

/**
 * 造一条只在 trace 里留下进出记录的中间件
 * @param tag 标记
 * @param trace 记录数组
 * @returns 中间件登记用的函数
 */
function tracer(tag: string, trace: string[]): Middleware {
  return async (_e, next) => {
    trace.push(`${tag}>`)
    await next()
    trace.push(`${tag}<`)
  }
}

/** 建一条管线与它的日志器 */
function make(): { pipe: MiddlewarePipeline; logger: FakeLogger } {
  const logger = fakeLogger()
  return { pipe: new MiddlewarePipeline(logger), logger }
}

/**
 * 执行一遍管线
 *
 * 将 `as unknown as AnyEvent` 收束于此一处，以使用例中的 `e` 保持 FakeEvent 类型、
 * 可直接断言 `e.stopped`。
 * @param pipe 管线
 * @param e 假事件
 * @param core 最内层
 */
async function run(pipe: MiddlewarePipeline, e: FakeEvent, core: () => Promise<void>): Promise<void> {
  await pipe.run(e as unknown as AnyEvent, core)
}

/**
 * 造一个往 trace 里记一笔的最内层
 * @param trace 记录数组
 * @returns 最内层函数
 */
function core(trace: string[]): () => Promise<void> {
  return async () => {
    trace.push("core")
    return Promise.resolve()
  }
}

describe("执行顺序", () => {
  it("洋葱模型：next() 之后的收尾在内层执行完毕之后执行", async () => {
    const { pipe } = make()
    const trace: string[] = []
    pipe.register(reg("甲", tracer("甲", trace)))
    pipe.register(reg("乙", tracer("乙", trace)))

    await run(pipe, ev(), core(trace))

    expect(trace).toEqual(["甲>", "乙>", "core", "乙<", "甲<"])
  })

  it("priority 小者在外层，同优先级按注册先后", async () => {
    const { pipe } = make()
    const trace: string[] = []
    pipe.register(reg("先注册", tracer("先注册", trace)))
    pipe.register(reg("最外层", tracer("最外层", trace), { priority: 10 }))
    pipe.register(reg("后注册", tracer("后注册", trace)))
    pipe.register(reg("最内层", tracer("最内层", trace), { priority: 900 }))

    await run(pipe, ev(), core(trace))

    expect(trace).toEqual([
      "最外层>",
      "先注册>",
      "后注册>",
      "最内层>",
      "core",
      "最内层<",
      "后注册<",
      "先注册<",
      "最外层<"
    ])
  })

  it("一条中间件都没有时也会执行最内层", async () => {
    const { pipe } = make()
    const trace: string[] = []

    await run(pipe, ev(), core(trace))

    expect(trace).toEqual(["core"])
  })
})

describe("事件大类分桶", () => {
  it("kind 限定生效，单值与数组两种写法都算", async () => {
    const { pipe } = make()
    const trace: string[] = []
    pipe.register(reg("只管消息", tracer("只管消息", trace), { kind: "message" }))
    pipe.register(reg("管通知与请求", tracer("管通知与请求", trace), { kind: ["notice", "request"] }))
    pipe.register(reg("全都管", tracer("全都管", trace)))

    await run(pipe, ev("message"), core(trace))
    expect(trace).toEqual(["只管消息>", "全都管>", "core", "全都管<", "只管消息<"])

    trace.length = 0
    await run(pipe, ev("notice"), core(trace))
    expect(trace).toEqual(["管通知与请求>", "全都管>", "core", "全都管<", "管通知与请求<"])

    trace.length = 0
    await run(pipe, ev("meta"), core(trace))
    expect(trace).toEqual(["全都管>", "core", "全都管<"])
  })

  it("不认识的 kind 不会让最内层被跳过", async () => {
    const { pipe } = make()
    const trace: string[] = []
    pipe.register(reg("全都管", tracer("全都管", trace)))
    const weird = ev()
    weird.kind = "unknown" as EventKind

    await run(pipe, weird, core(trace))

    // 桶中不存在该大类：管线应当直接执行核心逻辑，而非丢弃该事件
    expect(trace).toEqual(["core"])
  })
})

describe("拦截语义", () => {
  it("不调 next() 就拦住了后续与最内层", async () => {
    const { pipe } = make()
    const trace: string[] = []
    pipe.register(reg("拦路", async () => void trace.push("拦路")))
    pipe.register(reg("后面的", tracer("后面的", trace)))

    await run(pipe, ev(), core(trace))

    expect(trace).toEqual(["拦路"])
  })

  it("不调 next() 也没 stop() 时留一条 trace 级提示", async () => {
    const { pipe, logger } = make()
    pipe.register(reg("忘了写 next 的插件", async () => Promise.resolve()))

    await run(pipe, ev(), async () => Promise.resolve())

    expect(logger.lines.some(l => l.includes("未调用 next()") && l.includes("忘了写 next 的插件"))).toBe(true)
  })

  it("显式 stop() 后不再提示未调用 next()", async () => {
    const { pipe, logger } = make()
    const e = ev()
    pipe.register(reg("正当拦截", async ev0 => void ev0.stop()))

    await run(pipe, e, async () => Promise.resolve())

    expect(e.stopped).toBe(true)
    expect(logger.lines.some(l => l.includes("未调用 next()"))).toBe(false)
  })

  it("stop() 之后即使调了 next()，下游与最内层也不执行", async () => {
    const { pipe } = make()
    const trace: string[] = []
    pipe.register(
      reg("先停再放行", async (e, next) => {
        trace.push("先停再放行>")
        e.stop()
        await next()
        trace.push("先停再放行<")
      })
    )
    pipe.register(reg("下游", tracer("下游", trace)))

    await run(pipe, ev(), core(trace))

    // next() 本身不抛错，只是什么都不做：拦截路径不该逼插件多写一个 try
    expect(trace).toEqual(["先停再放行>", "先停再放行<"])
  })

  it("事件进来时就已 stopped 的话一条中间件都不跑", async () => {
    const { pipe } = make()
    const trace: string[] = []
    pipe.register(reg("甲", tracer("甲", trace)))
    const e = ev()
    e.stopped = true

    await run(pipe, e, core(trace))

    expect(trace).toEqual([])
  })

  it("空管线遇到已 stopped 的事件也不执行最内层", async () => {
    const { pipe } = make()
    const trace: string[] = []
    const e = ev()
    e.stopped = true

    await run(pipe, e, core(trace))

    expect(trace).toEqual([])
  })
})

describe("错误处理", () => {
  it("重复调用 next() 直接抛错，错误信息里点名插件", async () => {
    const { pipe } = make()
    pipe.register(
      reg("话多的插件", async (_e, next) => {
        await next()
        await next()
      })
    )

    await expect(run(pipe, ev(), async () => Promise.resolve())).rejects.toThrow(
      /话多的插件.*重复调用了 next\(\)/
    )
  })

  it("中间件抛的错原样冒泡，交给 dispatch 统一处理", async () => {
    const { pipe } = make()
    pipe.register(reg("执行失败的插件", async () => Promise.reject(new Error("插件内部执行失败"))))

    await expect(run(pipe, ev(), async () => Promise.resolve())).rejects.toThrow("插件内部执行失败")
  })

  it("最内层抛的错也原样冒泡，且外层的收尾不会被跑", async () => {
    const { pipe } = make()
    const trace: string[] = []
    pipe.register(reg("甲", tracer("甲", trace)))

    await expect(
      run(pipe, ev(), async () => {
        throw new Error("命令处理执行失败")
      })
    ).rejects.toThrow("命令处理执行失败")
    expect(trace).toEqual(["甲>"])
  })
})

describe("注册表维护", () => {
  it("执行期间新注册的中间件不影响本次执行，下一次才生效", async () => {
    const { pipe } = make()
    const trace: string[] = []
    pipe.register(
      reg("装了个新的", async (_e, next) => {
        pipe.register(reg("半路加入", tracer("半路加入", trace)))
        await next()
      })
    )

    await run(pipe, ev(), core(trace))
    expect(trace).toEqual(["core"])

    trace.length = 0
    await run(pipe, ev(), core(trace))
    expect(trace).toEqual(["半路加入>", "core", "半路加入<"])
  })

  it("注销后不再执行，size 也跟着减", async () => {
    const { pipe } = make()
    const trace: string[] = []
    const off = pipe.register(reg("甲", tracer("甲", trace)))
    expect(pipe.size).toBe(1)

    off()
    // 幂等：插件卸载时上下文与兜底清理可能都调一次
    off()

    expect(pipe.size).toBe(0)
    await run(pipe, ev(), core(trace))
    expect(trace).toEqual(["core"])
  })

  it("重复注册同一条登记是幂等的", async () => {
    const { pipe } = make()
    const trace: string[] = []
    const r = reg("甲", tracer("甲", trace))
    pipe.register(r)
    pipe.register(r)

    expect(pipe.size).toBe(1)
    await run(pipe, ev(), core(trace))
    expect(trace).toEqual(["甲>", "core", "甲<"])
  })

  it("removePlugin 只摘该插件的中间件，含多大类登记", async () => {
    const { pipe } = make()
    const trace: string[] = []
    pipe.register(reg("甲", tracer("甲消息", trace), { kind: "message" }))
    pipe.register(reg("甲", tracer("甲全部", trace)))
    pipe.register(reg("乙", tracer("乙", trace)))

    expect(pipe.removePlugin("甲")).toBe(2)
    expect(pipe.size).toBe(1)

    await run(pipe, ev(), core(trace))
    expect(trace).toEqual(["乙>", "core", "乙<"])
    // 通知桶里也不该有残留
    trace.length = 0
    await run(pipe, ev("notice"), core(trace))
    expect(trace).toEqual(["乙>", "core", "乙<"])
  })

  it("clear 清空全部大类的桶", async () => {
    const { pipe } = make()
    const trace: string[] = []
    pipe.register(reg("甲", tracer("甲", trace), { kind: ["message", "notice"] }))

    pipe.clear()

    expect(pipe.size).toBe(0)
    await run(pipe, ev(), core(trace))
    await run(pipe, ev("notice"), core(trace))
    expect(trace).toEqual(["core", "core"])
  })
})

describe("对外清单", () => {
  it("**顺序是执行顺序，不是注册顺序** —— 面板上这张表要回答「一条消息先过谁」", () => {
    const { pipe } = make()
    const trace: string[] = []
    pipe.register(reg("后注册的", tracer("后", trace), { priority: 10 }))
    pipe.register(reg("先注册的", tracer("先", trace), { priority: 200 }))

    expect(pipe.list().map(item => item.plugin)).toEqual(["后注册的", "先注册的"])
  })

  it("未声明优先级时报出缺省值，而不是留空", () => {
    const { pipe } = make()
    pipe.register(reg("甲", tracer("甲", [])))
    expect(pipe.list()[0]?.priority).toBe(100)
  })

  it("**未限定 kind 时列出全部大类** —— 「适用于全部」与「一类都不适用」必须分得开", () => {
    const { pipe } = make()
    pipe.register(reg("甲", tracer("甲", [])))
    expect(pipe.list()[0]?.kinds).toEqual(["message", "notice", "request", "meta"])
  })

  it("限定了 kind 就只列那几类，单值写法也算", () => {
    const { pipe } = make()
    pipe.register(reg("甲", tracer("甲", []), { kind: "notice" }))
    pipe.register(reg("乙", tracer("乙", []), { kind: ["request", "meta"] }))
    const byPlugin = new Map(pipe.list().map(item => [item.plugin, item.kinds]))
    expect(byPlugin.get("甲")).toEqual(["notice"])
    expect(byPlugin.get("乙")).toEqual(["request", "meta"])
  })

  it("**不管消息的中间件也要列出来** —— 少列一条会让人以为插件没注册上", () => {
    const { pipe } = make()
    pipe.register(reg("只管通知的", tracer("甲", []), { kind: "notice" }))
    expect(pipe.list().map(item => item.plugin)).toEqual(["只管通知的"])
    expect(pipe.list()).toHaveLength(pipe.size)
  })

  it("条数与 size 始终一致，注销之后也是", () => {
    const { pipe } = make()
    const off = pipe.register(reg("甲", tracer("甲", [])))
    pipe.register(reg("乙", tracer("乙", []), { kind: "meta" }))
    expect(pipe.list()).toHaveLength(2)
    off()
    expect(pipe.list()).toHaveLength(1)
    expect(pipe.list()[0]?.plugin).toBe("乙")
  })

  it("不含中间件函数本身 —— 那是个闭包，序列化不出去", () => {
    const { pipe } = make()
    pipe.register(reg("甲", tracer("甲", [])))
    expect(pipe.list()[0]).not.toHaveProperty("fn")
    expect(() => JSON.stringify(pipe.list())).not.toThrow()
  })
})

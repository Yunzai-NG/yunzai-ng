/**
 * 模块职责：命令冷却的判定、退回与过期清理
 * 依赖方向：测试文件
 * 生命周期：每个用例一个存储，用假时钟推进
 * 注意事项：过期清理那条守的是内存：冷却记录各带各的时长，缺省不过期的 LRU 若不扫，
 *          过期记录要一直占到挤满上限
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CooldownStore, renderCooldownTip } from "./cooldown.js"

describe("CooldownStore", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("冷却期内拒绝并给出剩余时间，到期后放行", () => {
    const store = new CooldownStore()
    expect(store.hit("p/cmd|u:1", 5000).ok).toBe(true)
    vi.advanceTimersByTime(2000)
    expect(store.hit("p/cmd|u:1", 5000)).toEqual({ ok: false, remaining: 3000 })
    vi.advanceTimersByTime(3000)
    expect(store.hit("p/cmd|u:1", 5000).ok).toBe(true)
  })

  it("reset 退回冷却", () => {
    const store = new CooldownStore()
    store.hit("k", 5000)
    store.reset("k")
    expect(store.hit("k", 5000).ok).toBe(true)
  })

  it("过期的记录在后续写入时被清掉，不必等挤满上限", () => {
    const store = new CooldownStore()
    for (let i = 0; i < 100; i++) store.hit(`p/cmd|u:${i}`, 1000)
    expect(store.size).toBe(100)
    vi.advanceTimersByTime(1500)
    // 每次写入清队首几条；写够次数后旧记录应当全部清走
    for (let i = 0; i < 40; i++) store.hit(`p/other|u:${i}`, 60_000)
    expect(store.size).toBe(40)
  })
})

describe("renderCooldownTip", () => {
  it("替换 {time} 占位符", () => {
    expect(renderCooldownTip("还有 {time}", 65_000)).toBe("还有 1分5秒")
    expect(renderCooldownTip("别刷了", 1000)).toBe("别刷了")
  })
})

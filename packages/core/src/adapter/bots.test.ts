/**
 * 模块职责：Bot 注册表「换新失效门面」的测试
 * 依赖方向：测试文件，依赖 adapter/bots、testing/fake
 * 生命周期：每个用例一张新注册表
 * 注意事项：门面用最小的假驱动造，只验换新与等待，不经账号管理器
 */
import { describe, expect, it } from "vitest"
import type { BotDriver } from "@yunzai-ng/types"
import { BotRegistry, createBotFacade, type BotFacade } from "./bots.js"
import { fakeLogger } from "../testing/fake.js"

/**
 * 造一个门面
 * @param accountId 账号记录 id
 * @returns 门面
 */
function facadeOf(accountId: string): BotFacade {
  const driver = {
    adapterId: "fake",
    platform: "fake",
    selfId: "10000",
    nickname: "假号",
    online: true,
    caps: new Set(),
    sendMessage: async () => ({ ok: true, messageId: "1", time: Date.now() })
  } as unknown as BotDriver
  return createBotFacade({
    driver,
    accountId,
    logger: fakeLogger(),
    policy: { splitLength: 0, sendTimeout: 1000, sequential: false }
  })
}

describe("BotRegistry.live", () => {
  it("没关闭的门面原样返回", async () => {
    const registry = new BotRegistry({ logger: fakeLogger() })
    const bot = facadeOf("a")
    registry.add(bot)
    expect(await registry.live(bot)).toBe(bot)
    expect(registry.current(bot)).toBe(bot)
  })

  it("关闭了且同一账号已重连：换成新门面", async () => {
    const registry = new BotRegistry({ logger: fakeLogger() })
    const old = facadeOf("a")
    registry.add(old)
    old.close()
    registry.remove("a")
    const fresh = facadeOf("a")
    registry.add(fresh)

    expect(await registry.live(old)).toBe(fresh)
    expect(registry.current(old)).toBe(fresh)
  })

  it("关闭了、账号还在重连：等它连回来", async () => {
    const registry = new BotRegistry({ logger: fakeLogger() })
    const old = facadeOf("a")
    registry.add(old)
    old.close()
    registry.remove("a")

    const waiting = registry.live(old, 5000)
    // 同步那一版不等：还没连回来就给原门面
    expect(registry.current(old)).toBe(old)
    const fresh = facadeOf("a")
    registry.add(fresh)
    expect(await waiting).toBe(fresh)
  })

  it("**等不到就交回原门面**，由它报「已断开」那句明确的错", async () => {
    const registry = new BotRegistry({ logger: fakeLogger() })
    const old = facadeOf("a")
    registry.add(old)
    old.close()
    registry.remove("a")

    const got = await registry.live(old, 20)
    expect(got).toBe(old)
    await expect(got.sendMessage({ scene: "private", uid: "1" }, "x")).rejects.toThrow(/已断开/)
  })

  it("别的账号上线不唤醒这个等待", async () => {
    const registry = new BotRegistry({ logger: fakeLogger() })
    const old = facadeOf("a")
    registry.add(old)
    old.close()
    registry.remove("a")

    const waiting = registry.live(old, 50)
    registry.add(facadeOf("b"))
    expect(await waiting).toBe(old)
  })
})

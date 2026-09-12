/**
 * 模块职责：运行期子系统装配的端到端测试 —— 阶段三的验收用例
 * 依赖方向：测试文件，依赖 kernel/app、kernel/runtime、testing/mock-adapter
 * 生命周期：每个用例一套临时主目录 + 一个应用实例，afterEach 停机并删目录
 * 注意事项：这组用例走的是**完整真实链路**：真实的 `createApp()`、真实地从磁盘 import
 *          一个插件、真实地经 `ctx.registerAdapter()` 注册适配器、真实地建立账号连接、
 *          事件真实地自 `host.submit()` 进入管线。其间任何一处装配错误
 *          （前缀策略未注入路由、prompts 只提供给工厂而未提供给分发器、账号上线时机
 *          挂错事件）都会在此处显现 —— 这正是 kernel/runtime.ts 存在的理由，
 *          其十余条装配若以单测逐个 mock，反而测不出"装配至错误的对象"。
 *
 *          夹具插件从 `globalThis` 取 Mock 适配器：临时目录中没有 node_modules，
 *          其无法 import 到 `@yunzai-ng/core`。与 plugin/host.test.ts 的做法一致。
 *
 *          断言一律等待 `mock.waitForSend()`，不应写 `await mock.driver.receive*()` ——
 *          投递是单向的，见 testing/mock-adapter.ts 文件头第 2 条。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AdapterProvider, CommandDoneInfo, MessageSentInfo } from "@yunzai-ng/types"
import { createMockAdapter, type MockAdapter, type MockAdapterOptions } from "../testing/mock-adapter.js"
import { createApp, type App } from "./app.js"

/** 夹具插件名，也是它的目录名 */
const PLUGIN = "mock-adapter"

/** 夹具与测试之间的共享通道 */
interface TestGlobals {
  /** 注入给夹具的 Mock 适配器提供方 */
  __yzngMock?: AdapterProvider
}

/** 取共享全局 */
const shared = (): TestGlobals => globalThis as unknown as TestGlobals

/**
 * 夹具插件源码
 *
 * 注册适配器 + 五条命令 + 一个改写型中间件，覆盖 `installRuntime` 里几乎每根线。
 * 用字符串拼接而不是模板字符串：这段本身就活在模板字符串里，再嵌一层 `${}`
 * 只会让人分不清哪个 `$` 是给谁的。
 */
const PLUGIN_SOURCE = `const brand = Symbol.for("yunzai-ng.plugin")
export default {
  name: "${PLUGIN}",
  version: "0.0.1",
  description: "测试用：注册内存 Mock 适配器并挂几条命令",
  setup(ctx) {
    ctx.registerAdapter(globalThis.__yzngMock)

    ctx.command("#ping").action(e => e.reply("pong"))
    ctx.command("#谁", { desc: "回显发送者" }).action(e => e.reply("你是 " + e.sender.uid))
    ctx.command("#重启", { master: true }).action(e => e.reply("好的主人"))
    // 故意抛错：验证 command/done 在失败路径同样触发（统计要算成功率）
    ctx.command("#炸").action(() => { throw new Error("故意炸的") })
    ctx.command("#改名").action(async e => {
      const next = await e.prompt({ tip: "要改成什么？" })
      await e.reply(next ? "已改为 " + next.text : "没等到")
    })

    // 改写型中间件：验证改写 message 后 refresh() 的结果确实被命令路由看见
    ctx.middleware(async (e, next) => {
      if (e.kind === "message" && e.text === "喵ping") {
        e.message = [{ type: "text", text: "#ping" }]
        e.refresh()
      }
      await next()
    })
  },
  [brand]: true
}
`

/** 当前用例的应用实例 */
let current: App | undefined
/** 当前用例的临时主目录 */
let root: string | undefined

/** 一套跑起来的应用与它的 Mock 适配器 */
interface Fixture {
  /** 应用实例，已 `start()` */
  app: App
  /** Mock 适配器 */
  mock: MockAdapter
}

/**
 * 建主目录、写夹具插件、起应用
 * @param extra 追加到 `config/yunzai.yaml` 的 YAML 片段
 * @param mockOpts Mock 适配器选项
 * @returns 应用与 Mock 适配器（应用已启动，但还没有账号）
 */
async function boot(extra = "", mockOpts: MockAdapterOptions = {}): Promise<Fixture> {
  const home = await mkdtemp(join(tmpdir(), "yzng-runtime-"))
  root = home
  await mkdir(join(home, "config"), { recursive: true })
  await writeFile(join(home, "config", "yunzai.yaml"), `store:\n  driver: memory\n  sqlite: false\n${extra}`, "utf8")
  await mkdir(join(home, "plugins", PLUGIN), { recursive: true })
  await writeFile(join(home, "plugins", PLUGIN, "index.js"), PLUGIN_SOURCE, "utf8")

  const mock = createMockAdapter(mockOpts)
  shared().__yzngMock = mock.provider

  const app = await createApp({
    home,
    version: "9.9.9-test",
    console: false,
    watchConfig: false,
    stopTimeout: 300
  })
  current = app

  const report = await app.start()
  expect(report.failed).toEqual([])
  expect(report.loaded).toEqual([PLUGIN])
  return { app, mock }
}

/**
 * 给应用加一个 Mock 账号并等它上线
 * @param app 应用
 * @param selfId 账号 id
 * @returns 账号记录 id
 */
async function login(app: App, selfId = "10000"): Promise<string> {
  const record = await app.runtime.accounts.create("mock", { selfId })
  expect(app.runtime.accounts.get(record.id)?.status).toBe("online")
  return record.id
}

afterEach(async () => {
  await current?.stop()
  current = undefined
  delete shared().__yzngMock
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe("installRuntime 装配", () => {
  it("把五个接缝和四个视图都换成真实现", async () => {
    const { app } = await boot()

    // 接缝：换的是同一个对象而不是又包一层，插件拿到的就是这几个注册表本身
    expect(app.hooks.commands).toBe(app.runtime.router)
    expect(app.hooks.middlewares).toBe(app.runtime.middlewares)
    expect(app.hooks.tasks).toBe(app.runtime.scheduler)
    expect(app.hooks.render).toBe(app.runtime.renderers)
    expect(app.hooks.adapters).toBe(app.runtime.adapters)

    expect(app.subsystems.adapters).toBe(app.runtime.adapters)
    expect(app.subsystems.bots).toBe(app.runtime.bots)
    expect(app.subsystems.accounts).toBe(app.runtime.accounts)
    // registries 是新造的闭包，只能验行为：夹具插件注册了 5 条命令
    expect(app.subsystems.registries.commands()).toHaveLength(5)

    // AppView 是活的：装配期填的子系统立刻能从插件那一侧看到
    expect(app.view.adapters.list().map(a => a.id)).toEqual(["mock"])
  })

  it("账号上线后 pickBot 能拿到它，下线后拿不到", async () => {
    const { app } = await boot()
    expect(app.hooks.bots.pick()).toBeUndefined()

    const id = await login(app)

    const bot = app.hooks.bots.pick()
    expect(bot?.selfId).toBe("10000")
    // 记录 id 与平台 selfId 两种写法都要能查到
    expect(app.hooks.bots.pick(id)?.selfId).toBe("10000")
    expect(app.hooks.bots.pick("10000")).toBe(bot)
    expect(app.view.bots.size).toBe(1)

    await app.runtime.accounts.disconnect(id, "用例主动断开")
    expect(app.view.bots.size).toBe(0)
    expect(app.hooks.bots.pick()).toBeUndefined()
  })
})

describe("消息链路", () => {
  it("私聊收到 #ping 回 pong", async () => {
    const { app, mock } = await boot()
    await login(app)

    mock.driver.receivePrivate("#ping")

    const [reply] = await mock.waitForSend()
    expect(reply?.text).toBe("pong")
    expect(reply?.target).toEqual({ scene: "private", uid: "20000" })
  })

  it("群里收到 #ping 回到群里", async () => {
    const { app, mock } = await boot()
    await login(app)

    mock.driver.receiveGroup("#ping", { gid: "800001", uid: "20001" })

    const [reply] = await mock.waitForSend()
    expect(reply?.text).toBe("pong")
    expect(reply?.target).toEqual({ scene: "group", gid: "800001" })
  })

  it("事件字段被内核补全：发送者、selfId 都对得上", async () => {
    const { app, mock } = await boot()
    await login(app, "10086")

    mock.driver.receivePrivate("#谁", { uid: "20002" })

    const [reply] = await mock.waitForSend()
    expect(reply?.text).toBe("你是 20002")
    expect(reply?.selfId).toBe("10086")
  })

  it("没有前缀的消息不进命令路由", async () => {
    const { app, mock } = await boot()
    await login(app)

    // 先发一条不带前缀的，再发一条带前缀的；等到后者的回复时前者早已走完
    mock.driver.receivePrivate("ping")
    mock.driver.receivePrivate("#ping")

    await mock.waitForSend()
    expect(mock.texts).toEqual(["pong"])
  })

  it("中间件改写消息后，路由按改写后的内容匹配", async () => {
    const { app, mock } = await boot()
    await login(app)

    mock.driver.receivePrivate("喵ping")

    const [reply] = await mock.waitForSend()
    expect(reply?.text).toBe("pong")
  })

  it("仅主人命令对非主人静默，对主人生效", async () => {
    const { app, mock } = await boot("bot:\n  masterQQ:\n    - '30000'\n")
    await login(app)
    expect(app.policy.isMaster("30000")).toBe(true)

    mock.driver.receivePrivate("#重启", { uid: "20000" })
    mock.driver.receivePrivate("#重启", { uid: "30000" })

    await mock.waitForSend()
    // 非主人那条既不回复也不报错 —— 有权限提示的话这里会是两条
    expect(mock.texts).toEqual(["好的主人"])
  })

  it("e.prompt() 能等到同会话的下一条消息", async () => {
    const { app, mock } = await boot()
    await login(app)

    mock.driver.receivePrivate("#改名")
    const [tip] = await mock.waitForSend()
    expect(tip?.text).toBe("要改成什么？")

    // 必须等待至等待者确实登记完成：waitForSend 在 driver.sendMessage 中即 resolve，
    // 此时插件尚未从 `await e.reply(tip)` 返回，更未进入 prompts.wait()。
    // 若在此时投入答案，prompts.offer() 找不到等待者，该消息将进入命令路由并被丢弃。
    await vi.waitFor(() => expect(app.runtime.prompts.pending).toBe(1))

    // 这条会被 prompt 截住，不进命令路由（否则会当成未知命令丢掉）
    mock.driver.receivePrivate("小明")
    const sends = await mock.waitForSend(2)
    expect(sends[1]?.text).toBe("已改为 小明")
    expect(app.runtime.prompts.pending).toBe(0)
  })

  it("机器人自己发的消息被忽略", async () => {
    const { app, mock } = await boot()
    await login(app)

    mock.driver.receivePrivate("#ping", { uid: "10000" })
    mock.driver.receivePrivate("#ping", { uid: "20000" })

    await mock.waitForSend()
    expect(mock.texts).toEqual(["pong"])
  })
})

describe("适配器生命周期", () => {
  it("适配器插件卸载后账号自动下线", async () => {
    const { app, mock } = await boot()
    const id = await login(app)
    expect(app.view.bots.size).toBe(1)

    await app.plugins.unload(PLUGIN)

    // 应当同步完整摘除：插件卸载后 pickBot 立即不能再给出该账号
    expect(app.view.bots.size).toBe(0)
    expect(app.hooks.bots.pick()).toBeUndefined()
    expect(app.view.adapters.list()).toEqual([])

    const state = app.runtime.accounts.get(id)
    expect(state?.status).toBe("offline")
    expect(state?.error).toContain("已卸载")
    await vi.waitFor(() => expect(mock.driver.disconnects).toBe(1))

    // 账号记录本身还在：适配器插件装回来就该自动连上，不该要求用户重新加账号
    expect(app.runtime.accounts.list()).toHaveLength(1)
  })

  it("适配器报告下线时走完整下线流程", async () => {
    const { app, mock } = await boot()
    const id = await login(app)

    mock.driver.goOffline("对端关闭了连接")

    // 等待状态而不是等待 `bots.size`：size 仅统计在线门面，而 goOffline() 已同步将
    // driver.online 置为 false，首次轮询即成立 —— 其时异步的下线流程尚未执行。
    await vi.waitFor(() => expect(app.runtime.accounts.get(id)?.status).toBe("offline"))
    // total 统计的是注册表中真实存在的条目，方可验证门面确实已被摘除
    expect(app.runtime.bots.total).toBe(0)
    expect(app.hooks.bots.pick()).toBeUndefined()
    expect(app.runtime.accounts.get(id)?.error).toBe("对端关闭了连接")
    expect(mock.driver.disconnects).toBe(1)
  })

  it("连接失败的账号不进 Bot 注册表，状态是 error", async () => {
    const { app, mock } = await boot("", { failConnect: "Mock 就是不让连" })

    const record = await app.runtime.accounts.create("mock", { selfId: "10000" })

    const state = app.runtime.accounts.get(record.id)
    expect(state?.status).toBe("error")
    expect(state?.error).toContain("Mock 就是不让连")
    expect(app.view.bots.size).toBe(0)
    // 驱动建出来了、连过一次、也被收拾掉了 —— 不能留一个没人引用还在收消息的幽灵
    expect(mock.driver.connects).toBe(1)
    expect(mock.driver.disconnects).toBe(1)
  })

  it("重连次数达到上限后停止自动重连，并把原因说清", async () => {
    // 上限取 1：第一次失败排一次重试（退避基数 2 秒），那一次再失败即超限
    const { app } = await boot("adapter:\n  reconnectLimit: 1\n", { failConnect: "Mock 就是不让连" })
    const record = await app.runtime.accounts.create("mock", { selfId: "10000" })

    const gaveUp = async (): Promise<string | undefined> =>
      app.loggerHub.tail({ level: "warn" }).find(r => r.msg.includes("停止自动重连"))?.msg

    // 退避是 2 秒起步带抖动，故给足余量；这里等的是「放弃」那一条日志
    await vi.waitFor(async () => expect(await gaveUp()).toBeDefined(), { timeout: 10_000, interval: 100 })

    const line = (await gaveUp()) ?? ""
    // 三样都要有：上限值、最后一次的错误、以及怎么恢复 —— 少了最后一样，
    // 使用者看到的就是「账号一直离线且日志再无动静」
    expect(line).toContain("已达 1 次")
    expect(line).toContain("Mock 就是不让连")
    expect(line).toContain("adapter.reconnectLimit")

    // 状态留在 error 上，不改成别的：面板上仍要显示「连不上，最后的错误是什么」
    expect(app.runtime.accounts.get(record.id)?.status).toBe("error")
    expect(app.runtime.accounts.get(record.id)?.retries).toBeGreaterThan(1)
  }, 15_000)

  it("手动重连把失败计数归零 —— 否则达到上限后那个按钮点了没反应", async () => {
    const { app } = await boot("adapter:\n  reconnectLimit: 1\n", { failConnect: "Mock 就是不让连" })
    const record = await app.runtime.accounts.create("mock", { selfId: "10000" })

    await vi.waitFor(
      () => expect(app.runtime.accounts.get(record.id)?.retries ?? 0).toBeGreaterThan(1),
      { timeout: 10_000, interval: 100 }
    )

    // `retries` 只在连接成功那一刻归零（见 accounts.ts 的 #doConnect），故手动入口必须自己清 ——
    // 不清的话这次手动连接一失败就又判超限，而使用者刚刚才明确要求「再试一次」
    await app.runtime.accounts.reconnect(record.id).catch(() => undefined)
    expect(app.runtime.accounts.get(record.id)?.retries).toBe(1)
  }, 15_000)

  it("上限缺省为 0，即一直重连（此前唯一的行为）", async () => {
    const { app } = await boot()
    expect(app.config.get().adapter.reconnectLimit).toBe(0)
  })

  it("退避三项也有缺省值，且与 accounts.ts 的兜底一致", async () => {
    const { app } = await boot()
    const { adapter } = app.config.get()
    expect(adapter.reconnectInterval).toBe("2s")
    expect(adapter.reconnectMaxInterval).toBe("1m")
    expect(adapter.reconnectFactor).toBe(2)
  })

  /*
   * 逐账号覆盖的三条用例
   *
   * 全局设 0（一直重连），只有这个账号自己填了上限 —— 于是「放弃」那条日志只可能来自
   * 账号那一层。反过来写（全局设上限、账号设 0）测不出优先级：日志里同样只有一条，
   * 而它究竟来自哪一层看不出来。
   */
  it("账号自己填的上限优先于全局配置", async () => {
    const { app } = await boot("adapter:\n  reconnectLimit: 0\n  reconnectInterval: 60ms\n", {
      failConnect: "Mock 就是不让连"
    })
    await app.runtime.accounts.create("mock", { selfId: "10000" }, undefined, true, { limit: 1 })

    const gaveUp = (): string | undefined =>
      app.loggerHub.tail({ level: "warn" }).find(r => r.msg.includes("停止自动重连"))?.msg

    await vi.waitFor(() => expect(gaveUp()).toBeDefined(), { timeout: 10_000, interval: 50 })
    expect(gaveUp() ?? "").toContain("已达 1 次")
    // 提示要指向账号那一项，而不是让人去改一个改了也没用的全局配置
    expect(gaveUp() ?? "").toContain("这个账号")
    expect(gaveUp() ?? "").not.toContain("adapter.reconnectLimit")
  }, 15_000)

  it("账号只填上限时，退避三项仍跟随全局 —— 逐字段回落而非整套接管", async () => {
    /*
     * 全局把首次间隔设成 60ms，账号只填 limit。若回落是「整套二选一」，这个账号会用回
     * 内置的 2 秒起步，于是三次失败要等 6 秒以上，这条用例会超时 —— 那正是判据。
     */
    const { app } = await boot("adapter:\n  reconnectInterval: 60ms\n  reconnectFactor: 1\n", {
      failConnect: "Mock 就是不让连"
    })
    const record = await app.runtime.accounts.create("mock", { selfId: "10000" }, undefined, true, { limit: 3 })

    await vi.waitFor(() => expect(app.runtime.accounts.get(record.id)?.retries ?? 0).toBeGreaterThan(3), {
      timeout: 3_000,
      interval: 20
    })
  }, 10_000)

  it("清掉账号的覆盖（retry: null）之后回到跟随全局", async () => {
    const { app } = await boot("adapter:\n  reconnectInterval: 60ms\n", { failConnect: "Mock 就是不让连" })
    const record = await app.runtime.accounts.create("mock", { selfId: "10000" }, undefined, false, { limit: 1 })
    expect(record.retry).toEqual({ limit: 1 })

    const cleared = await app.runtime.accounts.update(record.id, { retry: null })
    // 字段整个消失而非留一个空对象：留着的话「有没有覆盖」得靠看里面有几个键来判断
    expect(cleared.retry).toBeUndefined()
  })

  it("账号被 disable 后事件不再进管线", async () => {
    const { app, mock } = await boot()
    const id = await login(app)

    await app.runtime.accounts.setEnabled(id, false)
    expect(app.view.bots.size).toBe(0)

    // 宿主的 signal 已经 abort，submit() 会直接丢掉
    mock.driver.receivePrivate("#ping")
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(mock.sent).toEqual([])
  })

  it("断开一个仍处于 connect() 等待中的账号：先 abort 再等待，不会被阻塞", async () => {
    const { app } = await boot()

    // 被动接入的适配器（反向 WS、HTTP 上报）的 connect() 即为此形态：持续等待
    // 对端连入。disconnect() 若先 await 该 promise 再 abort，便会一直等到
    // 该等待自身超时为止 —— 表现为 Ctrl-C 之后进程半分钟无法退出
    const mock = createMockAdapter({ id: "blocking" })
    const provider = {
      ...mock.provider,
      id: "blocking",
      async createBot(account: unknown, host: Parameters<AdapterProvider["createBot"]>[1]) {
        const base = await mock.provider.createBot(account as never, host)
        // 用原型委托而不是展开：`online` 是 getter，展开会把它压成一个定值
        return Object.create(base, {
          connect: {
            value: () =>
              new Promise<void>((_resolve, reject) => {
                host.signal.addEventListener("abort", () => reject(new Error("账号已停用")), { once: true })
              })
          }
        }) as Awaited<ReturnType<AdapterProvider["createBot"]>>
      }
    } as unknown as AdapterProvider

    app.runtime.adapters.register(provider, PLUGIN)
    // 建为禁用态，否则 create() 自身即会阻塞于 connect() 上
    const record = await app.runtime.accounts.create("blocking", { selfId: "10000" }, undefined, false)

    void app.runtime.accounts.connect(record.id)
    await vi.waitFor(() => expect(app.runtime.accounts.get(record.id)?.status).toBe("connecting"))

    const started = Date.now()
    await app.runtime.accounts.disconnect(record.id, "用例主动断开")
    expect(Date.now() - started).toBeLessThan(1000)
    expect(app.runtime.accounts.get(record.id)?.status).toBe("disabled")
  })

  it("被 abort 打断的连接不算失败，不会排一个没人清的重连", async () => {
    const { app } = await boot()

    const mock = createMockAdapter({ id: "blocking2" })
    const provider = {
      ...mock.provider,
      id: "blocking2",
      async createBot(account: unknown, host: Parameters<AdapterProvider["createBot"]>[1]) {
        const base = await mock.provider.createBot(account as never, host)
        return Object.create(base, {
          connect: {
            value: () =>
              new Promise<void>((_resolve, reject) => {
                host.signal.addEventListener("abort", () => reject(new Error("账号已停用")), { once: true })
              })
          }
        }) as Awaited<ReturnType<AdapterProvider["createBot"]>>
      }
    } as unknown as AdapterProvider

    app.runtime.adapters.register(provider, PLUGIN)
    const record = await app.runtime.accounts.create("blocking2", { selfId: "10001" }, undefined, false)

    void app.runtime.accounts.connect(record.id)
    await vi.waitFor(() => expect(app.runtime.accounts.get(record.id)?.status).toBe("connecting"))
    await app.runtime.accounts.disconnect(record.id, "用例主动断开")

    // 状态是"已禁用"而不是"error"：主动断开不是连接失败。若这里变成 error，
    // 说明重连也被排上了 —— 而 disconnect 的清定时器早就跑过，那个定时器没人清
    const state = app.runtime.accounts.get(record.id)
    expect(state?.status).toBe("disabled")
    expect(state?.error).toBeUndefined()

    // 再等一会儿，确认没有定时器把它重新连起来
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(app.runtime.accounts.get(record.id)?.status).toBe("disabled")
  })

  it("停机时断开全部账号", async () => {
    const { app, mock } = await boot()
    await login(app)

    await app.stop()

    expect(app.view.bots.size).toBe(0)
    expect(mock.driver.disconnects).toBe(1)
    expect(mock.driver.online).toBe(false)
  })
})

/*
 * 埋点与统计事件
 *
 * 走完整真实链路而非单测分发器：这几条断言的价值全在「默认配置下、真实日志级别下
 * 看得见」——而那恰恰是被 `isLevelEnabled("debug")` 包住时测不出来的那一类缺陷。
 * 只 mock 一个 logger 去断言「调用过 info」并不能说明默认级别下它会被记下。
 */
describe("埋点与统计事件", () => {
  it("收到的消息记明协议与账号，而非只记场景与发送者", async () => {
    const { app, mock } = await boot()
    await login(app, "10086")

    mock.driver.receivePrivate("#ping", { uid: "20007" })
    await mock.waitForSend()

    const line = app.loggerHub.tail().find(r => r.msg.includes("20007"))
    expect(line).toBeDefined()
    // 同一进程可同时挂多个平台的多个号，缺了这一段就答不出「这条是哪个号收到的」
    expect(line?.msg).toContain("[mock:10086]")
    expect(line?.msg).toContain("[私聊]")
    expect(line?.level).toBe("info")
  })

  it("命令命中与处理完毕都记在 info 级 —— 默认级别下看得见", async () => {
    const { app, mock } = await boot()
    await login(app)

    mock.driver.receivePrivate("#ping")
    await mock.waitForSend()

    // 取 info 及以上，模拟默认配置下使用者实际看到的内容
    await vi.waitFor(() => {
      const msgs = app.loggerHub.tail({ level: "info" }).map(r => r.msg)
      expect(msgs.some(m => m.includes("命令命中 mock-adapter:#ping"))).toBe(true)
      expect(msgs.some(m => /命令 mock-adapter:#ping 处理完毕，耗时 \d+ms/.test(m))).toBe(true)
    })
  })

  it("命令跑完发 command/done，带插件、命令、耗时与成功标记", async () => {
    const { app, mock } = await boot()
    await login(app)

    const seen: CommandDoneInfo[] = []
    app.events.on("command/done", (_e, info) => void seen.push(info))

    mock.driver.receivePrivate("#ping")
    await mock.waitForSend()

    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toMatchObject({ plugin: PLUGIN, command: "#ping", ok: true })
    expect(seen[0]?.cost).toBeGreaterThanOrEqual(0)
    expect(seen[0]?.error).toBeUndefined()
  })

  it("命令抛错同样发 command/done，且 ok 为假 —— 否则统计出的成功率恒为 100%", async () => {
    const { app, mock } = await boot()
    await login(app)

    const seen: CommandDoneInfo[] = []
    app.events.on("command/done", (_e, info) => void seen.push(info))

    mock.driver.receivePrivate("#炸")

    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toMatchObject({ plugin: PLUGIN, command: "#炸", ok: false })
    expect(seen[0]?.error).toContain("故意炸的")
    // 失败也要有耗时：统计「平均耗时」时若失败那次缺项，均值会偏向成功的快路径
    expect(seen[0]?.cost).toBeGreaterThanOrEqual(0)
  })

  it("消息发出后发 message/sent，带目标、段数与图文构成", async () => {
    const { app, mock } = await boot()
    const accountId = await login(app, "10010")

    const seen: MessageSentInfo[] = []
    app.events.on("message/sent", info => void seen.push(info))

    mock.driver.receiveGroup("#ping", { gid: "800900", uid: "20008" })
    await mock.waitForSend()

    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toMatchObject({
      accountId,
      adapterId: "mock",
      platform: "mock",
      target: { scene: "group", gid: "800900" },
      segments: 1,
      ok: true
    })
    // 逐类计数而非只记总段数：「图片发不出去」与「文字发不出去」是两类故障
    expect(seen[0]?.kinds).toEqual({ text: 1 })
    expect(seen[0]?.cost).toBeGreaterThanOrEqual(0)
  })

  it("发出的消息也记一行 info —— 只记进来不记出去，一次问答在日志里只剩上半句", async () => {
    const { app, mock } = await boot()
    await login(app, "10011")

    mock.driver.receiveGroup("#ping", { gid: "800901" })
    await mock.waitForSend()

    await vi.waitFor(() => {
      const line = app.loggerHub.tail({ level: "info" }).find(r => r.msg.includes("已发出"))
      expect(line).toBeDefined()
      expect(line?.msg).toContain("[mock:10011]")
      expect(line?.msg).toContain("text×1")
    })
  })
})

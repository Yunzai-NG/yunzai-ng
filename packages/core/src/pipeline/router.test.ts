/**
 * 模块职责：命令路由器的单元测试 —— 分桶索引、优先级、权限静态门、正则处理
 * 依赖方向：测试文件，依赖 pipeline/router 与 testing/fake
 * 生命周期：每个用例新建一个路由器，无共享状态
 * 注意事项：这里**故意不建真事件**。`match()` 只读 8 个字段
 *          （text / scene / sender.uid / selfId / isGroup / atMe / isMaster /
 *          isGroupAdmin），为此启动一整套 EventFactory + BotApi 只会把
 *          "路由到底按什么匹配"埋进无关噪音里 —— 端到端那一层由
 *          kernel/runtime.test.ts 覆盖，这里专测索引与门禁本身。
 *
 *          分桶是这个文件最容易悄悄失效的优化：写错了功能照样正确，只是退化成
 *          全表扫描。所以有几处断言直接盯着"另一个桶里的正则一次都没被 exec"，
 *          而不只是断言"没匹配上"。
 */
import { describe, expect, it, vi } from "vitest"
import type { CommandOptions, CommandPattern, MessageEvent, MessageScene } from "@yunzai-ng/types"
import type { CommandRegistration } from "../plugin/hooks.js"
import { fakeLogger, type FakeLogger } from "../testing/fake.js"
import { CommandRouter } from "./router.js"

/** 构造假消息事件的入参 */
interface MsgSpec {
  /** 纯文本 */
  text: string
  /** 场景，缺省私聊 */
  scene?: MessageScene
  /** 发送者，缺省 20000 */
  uid?: string
  /** 接收账号，缺省 10000 */
  selfId?: string
  /** 是否 @ 了机器人 */
  atMe?: boolean
  /** 是否主人 */
  isMaster?: boolean
  /** 是否群管 */
  isGroupAdmin?: boolean
}

/**
 * 造一个够路由用的假消息事件
 * @param spec 文本或完整描述
 * @returns 消息事件
 */
function msg(spec: MsgSpec | string): MessageEvent {
  const s: MsgSpec = typeof spec === "string" ? { text: spec } : spec
  const scene = s.scene ?? "private"
  return {
    kind: "message",
    scene,
    text: s.text,
    selfId: s.selfId ?? "10000",
    sender: { uid: s.uid ?? "20000", name: "阿测" },
    isPrivate: scene === "private",
    isGroup: scene === "group",
    atMe: s.atMe ?? false,
    isMaster: s.isMaster ?? false,
    isGroupAdmin: s.isGroupAdmin ?? false,
    isGroupOwner: false
  } as unknown as MessageEvent
}

/**
 * 造一条命令登记
 * @param patterns 模式或模式数组
 * @param options 命令选项
 * @param plugin 插件名，断言顺序时用它当标记
 * @returns 登记内容
 */
function reg(
  patterns: CommandPattern | CommandPattern[],
  options: CommandOptions = {},
  plugin = "p"
): CommandRegistration {
  return {
    plugin,
    patterns: Array.isArray(patterns) ? patterns : [patterns],
    options,
    handler: () => undefined
  }
}

/** 建一个路由器与它的日志器 */
function make(isDisabled?: (r: CommandRegistration) => boolean): { router: CommandRouter; logger: FakeLogger } {
  const logger = fakeLogger()
  const router = new CommandRouter(isDisabled === undefined ? { logger } : { logger, isDisabled })
  return { router, logger }
}

/**
 * 取命中的插件名序列，断言顺序时比逐个挖字段清楚
 * @param router 路由器
 * @param spec 消息
 * @returns 插件名数组
 */
function hits(router: CommandRouter, spec: MsgSpec | string): string[] {
  return router.match(msg(spec)).map(c => c.reg.plugin)
}

describe("字符串模式", () => {
  it("按前缀命中，填好 trigger/rest/captures", () => {
    const { router } = make()
    router.register(reg("#查角色"))

    const [hit] = router.match(msg("#查角色  刻晴 命座"))
    expect(hit?.match.name).toBe("#查角色")
    expect(hit?.match.pattern).toBe("#查角色")
    expect(hit?.match.trigger).toBe("#查角色")
    // rest 已 trim：插件里最常见的一行就是 `const name = e.command.rest`
    expect(hit?.match.rest).toBe("刻晴 命座")
    expect(hit?.match.groups).toEqual({})
    expect(hit?.match.captures).toEqual(["#查角色"])
    expect(hit?.match.plugin).toBe("p")
  })

  it("前缀不在开头时不命中", () => {
    const { router } = make()
    router.register(reg("#ping"))

    expect(router.match(msg("你好 #ping"))).toEqual([])
    expect(router.match(msg("ping"))).toEqual([])
  })

  it("anywhere 允许触发词出现在任意位置", () => {
    const { router } = make()
    router.register(reg("体力", { anywhere: true }))

    const [hit] = router.match(msg("帮我看看体力还剩多少"))
    expect(hit?.match.trigger).toBe("体力")
    expect(hit?.match.rest).toBe("还剩多少")
  })

  it("空串模式被拒绝，同一条命令的其余别名照旧可用", () => {
    const { router, logger } = make()
    router.register(reg(["", "#ok"]))

    expect(hits(router, "#ok")).toEqual(["p"])
    expect(logger.lines.some(l => l.includes("无效"))).toBe(true)
  })

  it("一条命令的模式全都无效时不会被触发，但会留下告警", () => {
    const { router, logger } = make()
    router.register(reg(""))

    expect(router.match(msg("随便说点什么"))).toEqual([])
    expect(logger.lines.some(l => l.includes("没有任何有效模式"))).toBe(true)
    // 条目本身还在注册表里：WebUI 得能显示"这条命令坏了"
    expect(router.size).toBe(1)
  })
})

describe("正则模式", () => {
  it("命名捕获与数字捕获都填进 match，未参与的组归一成空串", () => {
    const { router } = make()
    router.register(reg(/^#查(?<name>\S+?)(\d+)?命座/))

    const [hit] = router.match(msg("#查刻晴命座 顺便看天赋"))
    expect(hit?.match.groups).toEqual({ name: "刻晴" })
    expect(hit?.match.captures).toEqual(["#查刻晴命座", "刻晴", ""])
    expect(hit?.match.rest).toBe("顺便看天赋")
  })

  it("g/y 标志被去掉：同一条命令连发两次都要命中", () => {
    const { router, logger } = make()
    router.register(reg(/^#dup/g))

    // 不去标志的话第二次 exec 会从上次的 lastIndex 继续找，表现为"命令只灵一次"
    expect(router.match(msg("#dup"))).toHaveLength(1)
    expect(router.match(msg("#dup"))).toHaveLength(1)
    expect(logger.lines.some(l => l.includes("g/y"))).toBe(true)
  })

  it("正则的 name 取 source，不含斜杠与标志", () => {
    const { router } = make()
    router.register(reg(/^#状态$/i))

    expect(router.list()[0]?.name).toBe("^#状态$")
    expect(router.list()[0]?.patterns).toEqual(["^#状态$"])
  })
})

describe("首字符分桶", () => {
  it("首字符不同的命令连 exec 都不会被调到", () => {
    const { router } = make()
    const re = /^#ping/
    const spy = vi.spyOn(re, "exec")
    router.register(reg(re))

    expect(router.match(msg("!别的命令"))).toEqual([])
    // 这一条是分桶优化本身的断言：功能正确但退化成全表扫描时它会红
    expect(spy).not.toHaveBeenCalled()

    expect(router.match(msg("#ping"))).toHaveLength(1)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it("提不出字面前缀的正则每条消息都要试", () => {
    const { router } = make()
    router.register(reg(/^\d+/))

    const [hit] = router.match(msg("42 天后"))
    expect(hit?.match.trigger).toBe("42")
    expect(hit?.match.rest).toBe("天后")
  })

  it("带 m 标志的正则不分桶：第二行开头也算命中", () => {
    const { router } = make()
    router.register(reg(/^#x/m))

    // 首字符是"啊"，按 `#` 桶找不到；正因为 m 标志落进了每条都试的那份名单才命中
    expect(hits(router, "啊\n#x")).toEqual(["p"])
  })

  it("带 i 标志且字母开头的正则不分桶：大小写都能命中", () => {
    const { router } = make()
    router.register(reg(/^abc/i))

    expect(hits(router, "ABC 大写")).toEqual(["p"])
    expect(hits(router, "abc 小写")).toEqual(["p"])
  })

  it("同一条命令的多个别名落在同一个桶里也只命中一次", () => {
    const { router } = make()
    router.register(reg(["#a", "#ab"]))

    const found = router.match(msg("#ab"))
    expect(found).toHaveLength(1)
    // 按声明顺序取第一个能匹配上的模式
    expect(found[0]?.match.pattern).toBe("#a")
  })

  it("一条命令同时有可分桶与不可分桶的模式时也只命中一次", () => {
    const { router } = make()
    router.register(reg(["#x", /#x/]))

    expect(router.match(msg("#x"))).toHaveLength(1)
  })
})

describe("优先级与顺序", () => {
  it("priority 小者在前，同优先级按注册先后", () => {
    const { router } = make()
    router.register(reg("#a", {}, "先注册"))
    router.register(reg("#a", { priority: 50 }, "更优先"))
    router.register(reg("#a", {}, "后注册"))

    expect(hits(router, "#a")).toEqual(["更优先", "先注册", "后注册"])
  })

  it("桶内与不分桶的候选按同一套优先级归并", () => {
    const a = make()
    a.router.register(reg("#x", {}, "桶内"))
    a.router.register(reg(/#x/, { priority: 50 }, "不分桶"))
    expect(hits(a.router, "#x")).toEqual(["不分桶", "桶内"])

    const b = make()
    b.router.register(reg("#x", {}, "桶内"))
    b.router.register(reg(/#x/, { priority: 150 }, "不分桶"))
    expect(hits(b.router, "#x")).toEqual(["桶内", "不分桶"])
  })
})

describe("静态门禁", () => {
  it("还没 action() 的命令被跳过", () => {
    const { router } = make()
    const r = reg("#半成品")
    r.handler = undefined
    router.register(r)

    expect(router.match(msg("#半成品"))).toEqual([])
  })

  it("被禁用的命令被跳过，但仍出现在 list() 里且标了 disabled", () => {
    const { router } = make(r => r.options.group === "关掉的")
    router.register(reg("#关", { group: "关掉的" }))
    router.register(reg("#开"))

    expect(router.match(msg("#关"))).toEqual([])
    expect(hits(router, "#开")).toEqual(["p"])
    expect(router.list().map(i => i.disabled)).toEqual([true, false])
  })

  it("scene 限定生效，单值与数组两种写法都算", () => {
    const { router } = make()
    router.register(reg("#群限", { scene: "group" }, "仅群"))
    router.register(reg("#多限", { scene: ["private", "guild"] }, "私聊与频道"))

    expect(hits(router, "#群限")).toEqual([])
    expect(hits(router, { text: "#群限", scene: "group" })).toEqual(["仅群"])
    expect(hits(router, "#多限")).toEqual(["私聊与频道"])
    expect(hits(router, { text: "#多限", scene: "group" })).toEqual([])
  })

  it("默认不响应机器人自己发的消息，ignoreSelf:false 才放行", () => {
    const { router } = make()
    router.register(reg("#复读", {}, "默认"))
    router.register(reg("#复读", { ignoreSelf: false }, "放行"))

    // 自己发的：只有显式声明放行的那条能命中，否则复读类命令会自我触发成死循环
    expect(hits(router, { text: "#复读", uid: "10000", selfId: "10000" })).toEqual(["放行"])
    expect(hits(router, { text: "#复读", uid: "20000" })).toEqual(["默认", "放行"])
  })

  it("atMe 只约束群聊，私聊天然算对我说话", () => {
    const { router } = make()
    router.register(reg("#要艾特", { atMe: true }))

    expect(hits(router, { text: "#要艾特", scene: "group" })).toEqual([])
    expect(hits(router, { text: "#要艾特", scene: "group", atMe: true })).toEqual(["p"])
    expect(hits(router, "#要艾特")).toEqual(["p"])
  })

  it("master 门只对主人开", () => {
    const { router } = make()
    router.register(reg("#重启", { master: true }))

    expect(hits(router, "#重启")).toEqual([])
    expect(hits(router, { text: "#重启", isMaster: true })).toEqual(["p"])
  })

  it("admin 门对群管开，主人不受群管限制", () => {
    const { router } = make()
    router.register(reg("#踢人", { admin: true }))

    expect(hits(router, { text: "#踢人", scene: "group" })).toEqual([])
    expect(hits(router, { text: "#踢人", scene: "group", isGroupAdmin: true })).toEqual(["p"])
    // 主人在自己不是管理员的群里也该能用管理命令
    expect(hits(router, { text: "#踢人", scene: "group", isMaster: true })).toEqual(["p"])
  })
})

describe("注册表维护", () => {
  it("注销后自所有桶中完整摘除", () => {
    const { router } = make()
    const off = router.register(reg(["#a", "!b"]))
    expect(hits(router, "#a")).toEqual(["p"])
    expect(hits(router, "!b")).toEqual(["p"])

    off()

    expect(router.match(msg("#a"))).toEqual([])
    expect(router.match(msg("!b"))).toEqual([])
    expect(router.size).toBe(0)
  })

  it("重复注册同一条登记是幂等的", () => {
    const { router } = make()
    const r = reg("#once")
    router.register(r)
    router.register(r)

    expect(router.size).toBe(1)
    expect(router.match(msg("#once"))).toHaveLength(1)
  })

  it("reindex 让后加的别名生效，展示名仍是主模式", () => {
    const { router } = make()
    const r = reg("#体力")
    router.register(r)
    expect(router.match(msg("#树脂"))).toEqual([])

    r.patterns.push("#树脂")
    router.reindex(r)

    expect(hits(router, "#树脂")).toEqual(["p"])
    expect(hits(router, "#体力")).toEqual(["p"])
    expect(router.list()[0]?.name).toBe("#体力")
    // 重建而不是追加：别名不该在桶里留下重复条目
    expect(router.match(msg("#体力"))).toHaveLength(1)
  })

  it("reindex 未注册过的登记是空操作", () => {
    const { router } = make()
    router.reindex(reg("#没注册过"))
    expect(router.size).toBe(0)
  })

  it("removePlugin 只摘该插件的命令", () => {
    const { router } = make()
    router.register(reg("#a", {}, "甲"))
    router.register(reg("#b", {}, "甲"))
    router.register(reg("#c", {}, "乙"))

    expect(router.removePlugin("甲")).toBe(2)
    expect(router.size).toBe(1)
    expect(hits(router, "#c")).toEqual(["乙"])
  })

  it("clear 清空一切", () => {
    const { router } = make()
    router.register(reg("#a"))
    router.register(reg(/^\d+/))

    router.clear()

    expect(router.size).toBe(0)
    expect(router.list()).toEqual([])
    expect(router.match(msg("#a"))).toEqual([])
    expect(router.match(msg("42"))).toEqual([])
  })

  it("list() 导出 WebUI 需要的全部字段，按匹配顺序", () => {
    const { router } = make()
    router.register(reg("#后但更优先", { priority: 10 }, "乙"))
    router.register(
      reg("#帮助", { desc: "看帮助", usage: "#帮助 [页码]", group: "系统", hidden: true, master: true }, "甲")
    )

    expect(router.list()).toEqual([
      {
        name: "#后但更优先",
        patterns: ["#后但更优先"],
        plugin: "乙",
        master: false,
        admin: false,
        hidden: false,
        disabled: false
      },
      {
        name: "#帮助",
        patterns: ["#帮助"],
        plugin: "甲",
        master: true,
        admin: false,
        hidden: true,
        disabled: false,
        desc: "看帮助",
        usage: "#帮助 [页码]",
        group: "系统"
      }
    ])
  })
})

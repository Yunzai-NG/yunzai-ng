/**
 * 模块职责：内核配置 schema 的回归测试
 * 依赖方向：测试文件
 * 生命周期：纯内存
 * 注意事项：这里锁住的是**不变量**（默认值自洽、YAML 可回环、敏感字段被标记、
 *          对外监听必须有令牌），而不是逐条字段的取值 —— 后者会随产品调整而变。
 */
import { describe, expect, it } from "vitest"
import { CORE_SECRET_PATHS, coreConfigSchema, loggerSettingsOf, serverSecurityWarning } from "./core-config.js"
import { parseYaml, serializeYaml } from "./yaml.js"

describe("内核配置", () => {
  const defaults = coreConfigSchema.defaults()

  it("默认值自洽：不给任何输入也能得到一份合法配置", () => {
    expect(coreConfigSchema.safeParse(undefined).ok).toBe(true)
    expect(coreConfigSchema.safeParse(defaults).ok).toBe(true)
    expect(defaults.server.port).toBe(2536)
    expect(defaults.bot.prefix).toEqual(["#", "*", "%"])
    expect(defaults.store.driver).toBe("sqlite")
    expect(defaults.log.level).toBe("mark")
    expect(coreConfigSchema.parse({ log: { messageContent: false } }).log.messageContent).toBe(false)
    expect(defaults.log.messageContent).toBe(true)
    expect(coreConfigSchema.safeParse({ log: { level: "info", messageContent: false } }).ok).toBe(true)
  })

  it("发送与重连时长不能让定时器立即触发，冷却仍允许关闭", () => {
    for (const value of [0, "0s", -1, "30d"]) {
      expect(coreConfigSchema.safeParse({ message: { sendTimeout: value } }).ok).toBe(false)
      expect(coreConfigSchema.safeParse({ adapter: { reconnectInterval: value } }).ok).toBe(false)
      expect(coreConfigSchema.safeParse({ adapter: { reconnectMaxInterval: value } }).ok).toBe(false)
    }
    expect(coreConfigSchema.safeParse({ message: { cooldown: 0, sendTimeout: "1s" } }).ok).toBe(true)
  })

  // 旧配置里写着 auto / level / json：拒收会让整份配置失效、沿用缺省值
  it("旧的 KV 驱动名照收，换成 sqlite", () => {
    for (const old of ["auto", "level", "json"]) {
      const result = coreConfigSchema.safeParse({ store: { driver: old } })
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.store.driver).toBe("sqlite")
    }
    expect(coreConfigSchema.safeParse({ store: { driver: "redis" } }).ok).toBe(false)
    expect(coreConfigSchema.safeParse({ store: { driver: "toString" } }).ok).toBe(false)
  })

  it("序列化成带注释的 YAML 后能原样解析回来", () => {
    const text = serializeYaml(defaults, { descriptor: coreConfigSchema.describe() })
    const back = coreConfigSchema.parse(parseYaml(text))
    expect(back).toEqual(defaults)
    // 注释确实生成了，用户打开文件不是一片裸键值
    expect(text).toContain("# 主人账号")
    expect(text).toContain("可选值：")
  })

  it("令牌被标记为敏感字段，导出与日志需脱敏", () => {
    expect(CORE_SECRET_PATHS).toContain("server.token")
  })

  it("对外监听但没设令牌时给出警告", () => {
    expect(serverSecurityWarning(defaults)).toBeUndefined()

    const exposed = coreConfigSchema.parse({ server: { host: "0.0.0.0" } })
    expect(serverSecurityWarning(exposed)).toMatch(/未设置访问令牌/)

    const weak = coreConfigSchema.parse({ server: { host: "0.0.0.0", token: "short" } })
    expect(serverSecurityWarning(weak)).toMatch(/太短/)

    const ok = coreConfigSchema.parse({ server: { host: "0.0.0.0", token: "0123456789abcdef01" } })
    expect(serverSecurityWarning(ok)).toBeUndefined()
  })

  it("日志设置把 MB 换算成字节", () => {
    const settings = loggerSettingsOf(defaults)
    expect(settings.maxSize).toBe(8 * 1024 * 1024)
    expect(settings.consoleLevel).toBeUndefined()
  })

  it("非法端口与越界质量被拦下并报出路径", () => {
    const bad = coreConfigSchema.safeParse({ server: { port: 99999 }, render: { quality: 10 } })
    expect(bad.ok).toBe(false)
    expect(bad.issues.map(i => i.path)).toEqual(expect.arrayContaining(["server.port", "render.quality"]))
  })
})

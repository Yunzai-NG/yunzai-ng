import { describe, expect, it } from "vitest"
import { Schema, s, type Infer } from "./schema.js"

describe("schema 构造器", () => {
  it("填充嵌套默认值，用户只写关心的键", () => {
    const conf = s.object({
      server: s.object({
        host: s.string().default("127.0.0.1"),
        port: s.port().default(3000)
      }),
      log: s.object({
        level: s.enum(["info", "debug"]).default("info")
      })
    })

    const result = conf.parse({ server: { port: 8080 } })
    expect(result).toEqual({
      server: { host: "127.0.0.1", port: 8080 },
      log: { level: "info" }
    })
  })

  it("defaults() 不需要输入就能产出完整配置", () => {
    const conf = s.object({
      enable: s.boolean().default(true),
      masters: s.ids().default([])
    })
    expect(conf.defaults()).toEqual({ enable: true, masters: [] })
  })

  it("对人手写的 YAML 做宽容转换", () => {
    const conf = s.object({
      port: s.port(),
      enable: s.boolean(),
      token: s.string()
    })
    // YAML 里端口写成字符串、开关写成 on、token 写成纯数字都常见
    expect(conf.parse({ port: "8080", enable: "on", token: 12345 })).toEqual({
      port: 8080,
      enable: true,
      token: "12345"
    })
  })

  it("单值自动包成数组", () => {
    const conf = s.object({ masterQQ: s.ids().default([]) })
    expect(conf.parse({ masterQQ: "10086" })).toEqual({ masterQQ: ["10086"] })
    expect(conf.parse({ masterQQ: ["10086", "10010"] })).toEqual({ masterQQ: ["10086", "10010"] })
  })

  it("未识别的键保留并给出 warn，而不是静默丢弃", () => {
    const conf = s.object({ port: s.port().default(3000) })
    const result = conf.safeParse({ port: 3000, prot: 3001 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({ port: 3000, prot: 3001 })
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]).toMatchObject({ path: "prot", severity: "warn" })
  })

  it("strict() 下未识别的键直接报错", () => {
    const conf = s.object({ port: s.port().default(3000) }).strict()
    const result = conf.safeParse({ prot: 3001 })
    expect(result.ok).toBe(false)
    expect(result.issues[0]).toMatchObject({ path: "prot", severity: "error" })
  })

  it("错误信息带完整路径，包括数组下标", () => {
    const conf = s.object({
      accounts: s.array(s.object({ selfId: s.string(), port: s.port() }))
    })
    const result = conf.safeParse({ accounts: [{ selfId: "1", port: 80 }, { selfId: "2", port: 99999 }] })
    expect(result.ok).toBe(false)
    expect(result.issues.map(i => i.path)).toContain("accounts[1].port")
  })

  it("缺少必填项时报出路径", () => {
    const conf = s.object({ nested: s.object({ token: s.string() }) })
    const result = conf.safeParse({})
    expect(result.ok).toBe(false)
    expect(result.issues[0]).toMatchObject({ path: "nested.token", message: "缺少必填项" })
  })

  it("describe() 产出的表单描述与校验规则同源", () => {
    const conf = s.object({
      mode: s
        .enum(["ws", "ws-reverse"], { ws: "正向 WS" })
        .default("ws-reverse")
        .title("连接方式"),
      token: s.password().optional().desc("NapCat 的鉴权令牌"),
      port: s.port().default(3001).showWhen({ mode: "ws" })
    })

    const d = conf.describe()
    expect(d.type).toBe("object")
    expect(d.properties?.mode).toMatchObject({
      type: "enum",
      title: "连接方式",
      default: "ws-reverse",
      widget: "select"
    })
    expect(d.properties?.mode?.enum).toEqual([{ value: "ws", label: "正向 WS" }, { value: "ws-reverse" }])
    expect(d.properties?.token).toMatchObject({ secret: true, widget: "password" })
    expect(d.properties?.port).toMatchObject({ min: 1, max: 65535, showWhen: { mode: "ws" } })
    // 有默认值 → 表单不标必填；无默认且非 optional → 必填
    expect(d.properties?.port?.required).toBeUndefined()
  })

  it("secretPaths() 汇总全部敏感字段", () => {
    const conf = s.object({
      bot: s.object({ token: s.password().optional() }),
      accounts: s.array(s.object({ ck: s.password().optional() }))
    })
    expect(conf.secretPaths()).toEqual(["bot.token", "accounts.*.ck"])
  })

  it("schema 不可变：fluent 方法返回新实例", () => {
    const base = s.string()
    const titled = base.title("甲")
    expect(titled).not.toBe(base)
    expect(base.describe().title).toBeUndefined()
    expect(titled.describe().title).toBe("甲")
  })

  it("check() 自定义校验生效", () => {
    const conf = s.string().check("必须以 # 开头", v => v.startsWith("#"))
    expect(conf.parse("#体力")).toBe("#体力")
    expect(conf.safeParse("体力").ok).toBe(false)
  })

  it("时长与 cron 的格式校验", () => {
    expect(s.duration().parse("30s")).toBe("30s")
    expect(s.duration().safeParse("30x").ok).toBe(false)
    expect(s.cron().parse("0 0 8 * * *")).toBe("0 0 8 * * *")
    expect(s.cron().safeParse("0 8").ok).toBe(false)
  })

  it("record 的值逐个校验", () => {
    const conf = s.record(s.number())
    expect(conf.parse({ a: "1", b: 2 })).toEqual({ a: 1, b: 2 })
    expect(conf.safeParse({ a: "x" }).ok).toBe(false)
  })

  it("默认值也走校验链：defaults() 与 parse(文件) 的形态必须一致", () => {
    // duration 允许数字与字符串两种写法，两者都要原样保留，
    // 否则首次启动写出 0、重启读回 "0"，下游会误以为配置变了
    const conf = s.object({ cooldown: s.duration().default(0), timeout: s.duration().default("30s") })
    const first = conf.defaults()
    expect(first).toEqual({ cooldown: 0, timeout: "30s" })
    expect(conf.parse(first)).toEqual(first)

    // 数值型默认值经过校验后仍是数值，不会被字符串化
    const coerced = s.object({ port: s.port().default(3000) }).defaults()
    expect(coerced.port).toBe(3000)
  })

  it("schema 自身默认值不合法时给 warn 而不是让用户的机器人起不来", () => {
    const conf = s.object({ quality: s.number().min(50).max(100).default(10) })
    const result = conf.safeParse({})
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // 退回原始默认值，机器人照常启动
    expect(result.value.quality).toBe(10)
    expect(result.issues[0]).toMatchObject({ path: "quality", severity: "warn" })
    expect(result.issues[0]?.message).toContain("插件作者")
  })

  it("类型推导：optional 变可选键，default 保持必填", () => {
    const conf = s.object({
      required: s.string(),
      withDefault: s.number().default(1),
      maybe: s.string().optional()
    })
    type Conf = Infer<typeof conf>
    const value: Conf = { required: "a", withDefault: 2 }
    expect(value.maybe).toBeUndefined()
    expect(conf).toBeInstanceOf(Schema)
  })
})

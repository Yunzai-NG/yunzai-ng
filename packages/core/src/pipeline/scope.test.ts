/**
 * 模块职责：群规则的取值与合并
 * 依赖方向：测试文件，只依赖 scope.ts
 * 生命周期：纯函数，无夹具
 * 注意事项：端到端的那几条（真的不回、真的回）在 kernel/runtime.test.ts 的「群规则」里
 */
import { describe, expect, it } from "vitest"
import { isScopeDisabled, isScopeEmpty, resolveScope, stripScopePrefix, type ScopeRule, type ScopeRules } from "./scope.js"

/**
 * 造一条群规则，没写的项取表单缺省值
 * @param patch 要改的项
 * @returns 群规则
 */
const rule = (patch: Partial<ScopeRule>): ScopeRule => ({
  account: "*",
  groups: [],
  preset: "",
  prefixMode: "inherit",
  prefix: [],
  ownDisabled: false,
  disabled: [],
  ...patch
})

describe("resolveScope", () => {
  const rules: ScopeRules = {
    prefix: ["小云"],
    disabled: ["抽卡"],
    presets: [{ name: "安静", prefixMode: "none", prefix: [], ownDisabled: true, disabled: ["复读"] }],
    rules: [
      rule({ groups: ["1"], prefixMode: "custom", prefix: ["  阿云 ", "云"] }),
      rule({ groups: ["2", "3"], preset: "安静" }),
      rule({ account: "10000", groups: ["3"], ownDisabled: true }),
      rule({ account: "20000", prefixMode: "none" }),
      rule({ groups: ["4"], preset: "删掉了", prefixMode: "custom", prefix: ["备用"] })
    ]
  }

  it("没有规则的群沿用全局", () => {
    const scope = resolveScope(rules, "10000", "9")
    expect(scope.prefix).toEqual(["小云"])
    expect([...scope.disabled]).toEqual(["抽卡"])
  })

  it("规则写了的项整项覆盖全局，没写的沿用；几个前缀长的在前", () => {
    const one = resolveScope(rules, "10000", "1")
    expect(one.prefix).toEqual(["阿云", "云"])
    expect([...one.disabled]).toEqual(["抽卡"])
  })

  it("套用套餐：一条规则管几个群，整套取套餐的", () => {
    for (const gid of ["2", "3"]) {
      const scope = resolveScope(rules, "30000", gid)
      expect(scope.prefix).toEqual([])
      expect([...scope.disabled]).toEqual(["复读"])
    }
  })

  it("指名账号优先于 *；写了群号的优先于全部群", () => {
    const own = resolveScope(rules, "10000", "3")
    expect(own.prefix).toEqual(["小云"])
    expect(own.disabled.size).toBe(0)
    // 20000 的「全部群」规则管不到写了群号的 1 号群
    expect(resolveScope(rules, "20000", "1").prefix).toEqual(["阿云", "云"])
    expect(resolveScope(rules, "20000", "9").prefix).toEqual([])
  })

  it("套餐找不到时退回规则自己那几项", () => {
    expect(resolveScope(rules, "10000", "4").prefix).toEqual(["备用"])
  })

  it("同一档里靠后的优先", () => {
    const later: ScopeRules = { ...rules, rules: [rule({ groups: ["5"], prefixMode: "none" }), rule({ groups: ["5"], prefixMode: "custom", prefix: ["后"] })] }
    expect(resolveScope(later, "1", "5").prefix).toEqual(["后"])
  })
})

describe("isScopeDisabled", () => {
  const scope = { prefix: [], disabled: new Set(["抽卡", "米游社:#签到"]) }
  it("插件名禁整个插件，插件名:命令名只禁那一条", () => {
    expect(isScopeDisabled(scope, "抽卡", "#十连")).toBe(true)
    expect(isScopeDisabled(scope, "米游社", "#签到")).toBe(true)
    expect(isScopeDisabled(scope, "米游社", "#体力")).toBe(false)
  })
})

describe("stripScopePrefix", () => {
  it("剥掉前缀与其后的空白；没带前缀时 undefined；不要前缀时原样；几个前缀带上哪个都算", () => {
    expect(stripScopePrefix("小云 #帮助", ["小云"])).toBe("#帮助")
    expect(stripScopePrefix("小云#帮助", ["小云"])).toBe("#帮助")
    expect(stripScopePrefix("#帮助", ["小云"])).toBeUndefined()
    expect(stripScopePrefix("#帮助", [])).toBe("#帮助")
    expect(stripScopePrefix("阿云#帮助", ["小云", "阿云"])).toBe("#帮助")
  })
})

describe("isScopeEmpty", () => {
  it("缺省配置下为真，任一项设了即为假", () => {
    expect(isScopeEmpty({ prefix: [" ", ""], disabled: [], presets: [], rules: [] })).toBe(true)
    expect(isScopeEmpty({ prefix: [], disabled: ["x"], presets: [], rules: [] })).toBe(false)
  })
})

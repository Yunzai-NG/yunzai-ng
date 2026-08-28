/**
 * 模块职责：参数解析的行为测试
 * 依赖方向：测试文件
 * 生命周期：纯函数，无需夹具
 * 注意事项：重点覆盖两处易于出错的边界 —— "选项值与后续子命令"之间的歧义，
 *          以及 `--no-x` 的取反。二者出错的表现均为"命令看似执行成功但行为不符"，
 *          其排查难度远高于直接报错。
 */
import { describe, expect, it } from "vitest"
import { flagBoolean, flagString, parseArgs } from "./args.js"

describe("参数解析", () => {
  it("第一个非选项 token 为子命令，其余计入位置参数", () => {
    const args = parseArgs(["plugin", "new", "我的插件"])
    expect(args.command).toBe("plugin")
    expect(args.positional).toEqual(["new", "我的插件"])
  })

  it("--key=value 与 --key value 等价", () => {
    expect(flagString(parseArgs(["start", "--home=D:/yz"]), "home")).toBe("D:/yz")
    expect(flagString(parseArgs(["start", "--home", "D:/yz"]), "home")).toBe("D:/yz")
  })

  it("下一个 token 形似选项时不将其作为值，而按布尔开关处理", () => {
    const args = parseArgs(["--debug", "start"])
    // start 必须保留给子命令，不可被 --debug 并入
    expect(args.command).toBe("start")
    expect(flagBoolean(args, "debug")).toBe(true)
  })

  it("--no-x 取反，且优先级高于 fallback", () => {
    expect(flagBoolean(parseArgs(["start", "--no-console"]), "console", true)).toBe(false)
    expect(flagBoolean(parseArgs(["start"]), "console", true)).toBe(true)
  })

  it("短选项可合并书写，-c 后可接值", () => {
    const args = parseArgs(["-dv"])
    expect(flagBoolean(args, "debug")).toBe(true)
    expect(flagBoolean(args, "version")).toBe(true)
    expect(flagString(parseArgs(["start", "-c", "D:/yz"]), "home")).toBe("D:/yz")
  })

  it("-- 之后原样保留，不作解析", () => {
    const args = parseArgs(["start", "--", "--debug", "任意"])
    expect(args.rest).toEqual(["--debug", "任意"])
    expect(flagBoolean(args, "debug")).toBe(false)
  })

  it("空串选项值视为未提供，以免 --home= 被解析为空的主目录", () => {
    expect(flagString(parseArgs(["start", "--home="]), "home")).toBeUndefined()
  })
})

/**
 * 模块职责：自带守护里可脱离子进程判定的部分：该不该担任守护、子进程的 Node 启动参数
 * 依赖方向：测试文件
 * 生命周期：纯函数
 * 注意事项：fork 与退出码处置要真起子进程，不在此测
 */
import { describe, expect, it } from "vitest"
import { childExecArgv, shouldSupervise } from "./supervise.js"

describe("childExecArgv", () => {
  it("继承父进程参数并补上新生代上限", () => {
    expect(childExecArgv(["--enable-source-maps"], {})).toEqual(["--enable-source-maps", "--max-semi-space-size=4"])
  })

  it("使用者在命令行或 NODE_OPTIONS 里给过就以他的为准", () => {
    expect(childExecArgv(["--max-semi-space-size=16"], {})).toEqual(["--max-semi-space-size=16"])
    expect(childExecArgv([], { NODE_OPTIONS: "--max_semi_space_size=8" })).toEqual([])
  })
})

describe("shouldSupervise", () => {
  it("外部已有 pm2 / systemd 或显式关掉时不担任", () => {
    expect(shouldSupervise({}, {})).toBe(true)
    expect(shouldSupervise({ supervise: false }, {})).toBe(false)
    expect(shouldSupervise({}, { pm_id: "0" })).toBe(false)
    expect(shouldSupervise({}, { INVOCATION_ID: "abc" })).toBe(false)
    expect(shouldSupervise({}, { YZNG_SUPERVISOR: "123" })).toBe(false)
  })
})

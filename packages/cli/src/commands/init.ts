/**
 * 模块职责：`yzng init` —— 在主目录中建立目录布局与缺省配置文件
 * 依赖方向：依赖 @yunzai-ng/core 的公开入口
 * 生命周期：一次性，执行完毕即退出
 * 注意事项：**刻意不经由 `createApp()`。** `createApp` 会一并打开 KV 数据库、
 *          建立 HTTP 客户端连接池、装配插件宿主 —— 在"仅需查看配置文件结构"
 *          的场景中，上述工作均属额外开销，且 KV 无法打开时会直接抛出异常，
 *          使一次本应成功的初始化转为失败。此处仅执行两项必要工作：建立目录、
 *          声明配置（从而将缺省值落盘）。
 *
 *          幂等：已存在的目录与配置文件均不会被覆盖（`ConfigStore` 仅在文件
 *          缺失时写入缺省值），因此对一个已长期运行的实例再次执行 init 是安全的。
 */
import {
  ConfigStore,
  PluginMarket,
  createHttpClient,
  createLoggerHub,
  defineCoreConfig,
  ensurePaths,
  parseDuration,
  resolvePaths
} from "@yunzai-ng/core"
import type { RuntimePaths } from "@yunzai-ng/types"
import { createRequire } from "node:module"
import { createInterface } from "node:readline/promises"
import { join } from "node:path"
import process from "node:process"
import { linkFramework } from "../link.js"
import { noteLegacyInstance } from "../legacy.js"
import { bold, cyan, dim, green, print, printErr, printRows, red, yellow } from "../terminal.js"

/** 读自身可解析到的 `@yunzai-ng/core` 版本，用于市场的 `minCore` 判定 */
const requireHere = createRequire(import.meta.url)

/**
 * 读内核版本
 *
 * 从 CLI 侧按模块解析取 `@yunzai-ng/core` 的 package.json —— 与内核自读同一个文件，
 * 故装 webui 时的 `minCore` 判定用的就是这台实例真正在跑的内核版本。
 * @returns 版本号；读不到时 `0.0.0`（让 `minCore` 判定从宽而非误拒）
 */
function coreVersion(): string {
  try {
    const pkg = requireHere("@yunzai-ng/core/package.json") as { version?: unknown }
    return typeof pkg.version === "string" ? pkg.version : "0.0.0"
  } catch {
    return "0.0.0"
  }
}

/** 初始化参数 */
export interface InitOptions {
  /** 应用主目录；缺省时按内核的探测顺序确定 */
  readonly home?: string | undefined
  /**
   * 是否安装官方面板 webui
   *
   * 三态：`true` / `false` 由 `--webui` / `--no-webui` 显式给出；`undefined` 表示未指定，
   * 此时交互式终端会询问（缺省装），非交互式则跳过。
   */
  readonly webui?: boolean | undefined
}

/**
 * 建立主目录与缺省配置
 * @param opts 参数
 * @returns 进程退出码
 */
export async function runInit(opts: InitOptions = {}): Promise<number> {
  // 仅输出至控制台、级别限制为 warn：ConfigStore 自身会输出"已写出缺省配置"一类的
  // info，而本命令需要给出的是一份经过整理的清单，两者叠加将降低可读性
  const hub = createLoggerHub({ level: "warn", console: true })
  try {
    const paths = await ensurePaths(resolvePaths({ home: opts.home }))
    const store = new ConfigStore({ dir: paths.config, logger: hub.root, watch: false })
    const config = await defineCoreConfig(store)
    const link = await linkFramework(paths.home)

    print()
    print(`  ${bold(green("已就绪"))} ${dim("目录与缺省配置均已建立")}`)
    print()
    printRows([
      ["主目录", cyan(paths.home)],
      ["配置", cyan(paths.config)],
      ["数据", cyan(paths.data)],
      ["日志", cyan(paths.logs)],
      ["插件", cyan(paths.plugins)],
      ["临时", cyan(paths.temp)]
    ])
    print()
    if (noteLegacyInstance(paths.home)) print()
    if (link.failed.length > 0) {
      print(`  ${yellow("!")} 框架包未能链接至主目录，插件将无法 import @yunzai-ng/core`)
      for (const [name, reason] of link.failed) print(`      ${dim(`${name}：${reason}`)}`)
      print()
    }

    // 面板（webui）是插件而非内核内置，不装则 start 后打开只有 /api、没有页面。故在此询问一次。
    // 目录与配置在此之前已建好，装 webui 失败不影响 init 的主职责，只记警告并给补救指引。
    await maybeInstallWebui(opts.webui, paths, config, hub)

    print(`  ${dim("下一步")} ${cyan("yzng start")} ${dim(`随后访问 http://${config.get().server.host}:${config.get().server.port}/`)}`)
    print()
    return 0
  } catch (err) {
    printErr(red(`初始化失败：${err instanceof Error ? err.message : String(err)}`))
    return 1
  } finally {
    hub.close()
  }
}

/** 内核配置句柄类型（`defineCoreConfig` 的返回） */
type CoreConfig = Awaited<ReturnType<typeof defineCoreConfig>>
/** 日志中枢类型 */
type Hub = ReturnType<typeof createLoggerHub>

/**
 * 决定并执行 webui 安装：显式旗标优先，否则交互式询问、非交互式跳过
 * @param choice `--webui` / `--no-webui` 的三态取值
 * @param paths 目录布局
 * @param config 内核配置句柄
 * @param hub 日志中枢
 */
async function maybeInstallWebui(
  choice: boolean | undefined,
  paths: RuntimePaths,
  config: CoreConfig,
  hub: Hub
): Promise<void> {
  let install: boolean
  if (choice !== undefined) {
    install = choice
  } else if (process.stdin.isTTY === true) {
    install = await askInstallWebui()
  } else {
    // 非交互式（管道 / CI）不自作主张做联网 clone+build：init 历来是离线、幂等、秒级的操作
    print(`  ${dim("未安装面板（非交互式）。需要时加 --webui，或经面板市场 / 手动安装 webui")}`)
    print()
    return
  }

  if (!install) {
    print(`  ${dim("跳过面板安装。需要时经面板市场安装 webui，或换装第三方面板")}`)
    print()
    return
  }

  await installWebui(paths, config, hub)
}

/**
 * 交互式询问是否安装 webui，缺省装
 * @returns 是否安装
 */
async function askInstallWebui(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await rl.question(`  ${bold("是否安装官方面板 webui？")}${dim(" 推荐，直接回车即安装 [Y/n] ")}`))
      .trim()
      .toLowerCase()
    return answer === "" || answer === "y" || answer === "yes" || answer === "是"
  } finally {
    rl.close()
  }
}

/**
 * 借内核市场安装 webui：git 拉取 + 装依赖 + 跑 build
 *
 * 复用 `PluginMarket`（与面板里点「安装」同一条路），失败不抛：目录与配置已建好，
 * 缺的只是面板这一个插件，记警告并给补救指引即可。
 * @param paths 目录布局
 * @param config 内核配置句柄
 * @param hub 日志中枢
 */
async function installWebui(paths: RuntimePaths, config: CoreConfig, hub: Hub): Promise<void> {
  print(`  ${dim("正在安装官方面板 webui（git 拉取 + 编译，国内网络下可能要几分钟）…")}`)
  const http = createHttpClient({})
  const market = new PluginMarket({
    http,
    logger: hub.root.child({ scope: "market" }),
    pluginsDir: paths.plugins,
    tempDir: join(paths.temp, "market"),
    cacheFile: join(paths.cache, "market-index.json"),
    coreVersion: coreVersion(),
    settings: () => {
      const m = config.get().market
      return {
        sources: m.sources,
        mirror: m.mirror,
        cacheTtl: parseDuration(m.cacheTtl, 3_600_000),
        timeout: parseDuration(m.timeout, 15_000)
      }
    }
  })
  try {
    const res = await market.install("webui", { dependencies: true })
    if (res.setupError !== undefined) {
      print(`  ${yellow("!")} webui 已拉取（${res.version}），但编译未完成：${res.setupError}`)
      print(`      ${dim(`到 ${join(paths.plugins, "webui")} 手动执行包管理器 install 与 build，或在面板插件页重装`)}`)
    } else {
      print(`  ${green("✓")} 官方面板 webui@${res.version} 已安装`)
    }
    print()
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    // 已安装是幂等场景，不当失败报
    if (reason.includes("已安装")) {
      print(`  ${dim("官方面板 webui 已安装，跳过")}`)
    } else {
      print(`  ${yellow("!")} 官方面板 webui 未能安装：${reason}`)
      print(`      ${dim("init 的目录与配置已建好，不受影响。稍后可经面板市场安装，或手动：")}`)
      print(`      ${dim(`git clone https://github.com/Yunzai-NG/webui-plugin ${join(paths.plugins, "webui")}`)}`)
    }
    print()
  } finally {
    await http.close()
  }
}

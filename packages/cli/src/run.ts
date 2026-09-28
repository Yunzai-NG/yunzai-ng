/**
 * 模块职责：命令分发 —— 将解析后的参数转为一次命令执行，返回退出码
 * 依赖方向：依赖 args / help / commands/*；不涉及 process.exit（该职责属于 bin.ts）
 * 生命周期：一次调用
 * 注意事项：**返回退出码而非自行退出。** 由此 `run()` 可被测试直接调用并断言
 *          返回值；将 `process.exit` 置于函数深处的程序无法编写测试 —— 一经调用
 *          即会终止测试进程自身。
 *
 *          未知命令返回 1 并输出帮助，而非静默无响应：命令名拼写错误是最常见的
 *          使用者错误，此时"无任何反馈"是最差的处理方式。
 *
 *          **命令实现一律动态 import。** 守护父进程只会命中 start 分支且走 supervise.js
 *          （不认识 core），若在顶部静态 import 任何一个 import 了 core 的命令，父进程就会
 *          连带把整个内核加载进来 —— 那正是自带守护要省掉的一份常驻内存。
 */
import { createRequire } from "node:module"
import type { LogLevel } from "@yunzai-ng/types"
import { flagBoolean, flagString, parseArgs, type ParsedArgs } from "./args.js"
import { printHelp } from "./help.js"
import { cyan, dim, print, printErr, red } from "./terminal.js"
import type { StartOptions } from "./commands/start.js"

/**
 * 读取自身版本号
 *
 * 自 package.json 读取而非硬编码常量：硬编码的版本号必然与发布时的实际版本脱节，
 * 而版本号有误会使使用者提交的 issue 全部指向错误的代码。
 * @returns 版本号
 */
function readVersion(): string {
  try {
    const require = createRequire(import.meta.url)
    const pkg = require("../package.json") as { version?: string }
    return pkg.version ?? "0.0.0"
  } catch {
    return "0.0.0"
  }
}

/**
 * 将 `--plugins a,b` 拆分为目录数组
 * @param args 解析结果
 * @returns 目录数组；未提供时 undefined
 */
function pluginDirs(args: ParsedArgs): string[] | undefined {
  const raw = flagString(args, "plugins")
  if (raw === undefined) return undefined
  const dirs = raw
    .split(",")
    .map(s => s.trim())
    .filter(s => s !== "")
  return dirs.length > 0 ? dirs : undefined
}

/**
 * 派发 `start` / `dev`：该由本进程担任守护还是直接跑内核
 *
 * 两条路都**动态 import**：担任守护时只加载 supervise.js（它不认识 core），父进程因此不会
 * 背上一份内核；反过来单进程或子进程才加载 start.js 把 core 拉进来。故这里不能在文件顶部
 * 静态 import 二者中的任何一个。
 * @param opts 启动参数
 * @returns 退出码
 */
async function dispatchStart(opts: StartOptions): Promise<number> {
  const { shouldSupervise, runSupervisor } = await import("./commands/supervise.js")
  if (shouldSupervise(opts)) return runSupervisor()
  const { runStart } = await import("./commands/start.js")
  return runStart(opts)
}

/**
 * 执行一次命令
 * @param argv `process.argv.slice(2)`
 * @returns 退出码
 */
export async function run(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv)
  const version = readVersion()

  if (flagBoolean(args, "version")) {
    print(version)
    return 0
  }
  if (args.command === "" || args.command === "help" || flagBoolean(args, "help")) {
    printHelp(version)
    // 显式请求帮助属于成功；未提供任何参数亦视为成功 —— 仅输入命令名以查看用法是正常行为
    return 0
  }

  const home = flagString(args, "home")
  const debug = flagBoolean(args, "debug")

  switch (args.command) {
    case "init": {
      const { runInit } = await import("./commands/init.js")
      // 三态：--webui / --no-webui 显式给出，未给时传 undefined 交由 init 决定（询问或跳过）
      const webui = args.flags["webui"] === undefined ? undefined : flagBoolean(args, "webui")
      return runInit({ home, webui })
    }

    case "start":
      return dispatchStart({
        home,
        extraDirs: pluginDirs(args),
        logLevel: debug ? ("debug" as LogLevel) : undefined,
        console: flagBoolean(args, "console", true),
        supervise: flagBoolean(args, "supervise", true)
      })

    case "dev":
      // dev 与 start 的唯一区别在于缺省日志级别。刻意不提供文件监听自动重载：
      // Node 的 ESM 模块缓存无法真正清除（见 plugin/host.ts 第 4 条注意事项），
      // 提供名义上的热重载会使"修改未生效"成为常态性困惑
      return dispatchStart({
        home,
        extraDirs: pluginDirs(args),
        logLevel: "debug" as LogLevel,
        console: flagBoolean(args, "console", true),
        supervise: flagBoolean(args, "supervise", true)
      })

    case "doctor": {
      const port = flagString(args, "port")
      const parsed = port === undefined ? undefined : Number.parseInt(port, 10)
      const { runDoctor } = await import("./commands/doctor.js")
      return runDoctor({
        home,
        host: flagString(args, "host"),
        port: parsed !== undefined && Number.isInteger(parsed) ? parsed : undefined
      })
    }

    case "update": {
      const { runUpdateCommand } = await import("./commands/update.js")
      return runUpdateCommand({
        to: flagString(args, "to"),
        prune: flagBoolean(args, "prune", true)
      })
    }

    case "plugin": {
      const sub = args.positional[0] ?? ""
      const name = args.positional[1] ?? ""
      if (sub !== "new" || name === "") {
        printErr(red("用法：yzng plugin new <名称>"))
        return 1
      }
      const { runPluginNew } = await import("./commands/plugin.js")
      return runPluginNew({ name, home })
    }

    default:
      printErr(red(`未知命令：${args.command}`))
      printErr(dim(`可用命令见 ${cyan("yzng --help")}`))
      return 1
  }
}

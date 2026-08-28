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
 */
import { createRequire } from "node:module"
import type { LogLevel } from "@yunzai-ng/types"
import { flagBoolean, flagString, parseArgs, type ParsedArgs } from "./args.js"
import { printHelp } from "./help.js"
import { cyan, dim, print, printErr, red } from "./terminal.js"
import { runStart } from "./commands/start.js"
import { runInit } from "./commands/init.js"
import { runDoctor } from "./commands/doctor.js"
import { runPluginNew } from "./commands/plugin.js"

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
    case "init":
      return runInit({ home })

    case "start":
      return runStart({
        home,
        extraDirs: pluginDirs(args),
        logLevel: debug ? ("debug" as LogLevel) : undefined,
        console: flagBoolean(args, "console", true)
      })

    case "dev":
      // dev 与 start 的唯一区别在于缺省日志级别。刻意不提供文件监听自动重载：
      // Node 的 ESM 模块缓存无法真正清除（见 plugin/host.ts 第 4 条注意事项），
      // 提供名义上的热重载会使"修改未生效"成为常态性困惑
      return runStart({
        home,
        extraDirs: pluginDirs(args),
        logLevel: "debug" as LogLevel,
        console: flagBoolean(args, "console", true)
      })

    case "doctor": {
      const port = flagString(args, "port")
      const parsed = port === undefined ? undefined : Number.parseInt(port, 10)
      return runDoctor({
        home,
        host: flagString(args, "host"),
        port: parsed !== undefined && Number.isInteger(parsed) ? parsed : undefined
      })
    }

    case "plugin": {
      const sub = args.positional[0] ?? ""
      const name = args.positional[1] ?? ""
      if (sub !== "new" || name === "") {
        printErr(red("用法：yzng plugin new <名称>"))
        return 1
      }
      return runPluginNew({ name, home })
    }

    default:
      printErr(red(`未知命令：${args.command}`))
      printErr(dim(`可用命令见 ${cyan("yzng --help")}`))
      return 1
  }
}

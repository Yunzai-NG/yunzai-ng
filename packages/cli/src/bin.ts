#!/usr/bin/env node
/**
 * 模块职责：`yzng` 可执行入口 —— 唯一允许调用 `process.exit` 的位置
 * 依赖方向：仅调用 run()
 * 生命周期：进程入口
 * 注意事项：**未捕获异常在此处理，而非交由 Node 缺省处理。** Node 缺省会输出
 *          完整调用栈，其中绝大部分为内核与 fastify 的栈帧；对使用者不具信息量，
 *          反而将真正有用的第一行挤出屏幕。此处仅输出消息，调用栈保留给 `--debug`。
 *
 *          `unhandledRejection` 必须显式接管：自 Node 20 起其缺省行为是终止进程，
 *          而"某个插件的 promise 未附加 catch"不应导致整个机器人下线。
 */
import process from "node:process"
import { run } from "./run.js"

/**
 * 输出一条致命错误
 * @param label 场景
 * @param err 错误
 */
function fatal(label: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(`\n${label}：${message}\n`)
  if (err instanceof Error && err.stack !== undefined && process.argv.includes("--debug")) {
    process.stderr.write(`${err.stack}\n`)
  } else {
    process.stderr.write("附加 --debug 可查看完整调用栈\n")
  }
}

process.on("unhandledRejection", reason => {
  fatal("未处理的 promise 拒绝", reason)
})

try {
  process.exitCode = await run(process.argv.slice(2))
} catch (err) {
  fatal("命令执行失败", err)
  process.exitCode = 1
}

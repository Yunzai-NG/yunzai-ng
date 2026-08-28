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
import { ConfigStore, createLoggerHub, defineCoreConfig, ensurePaths, resolvePaths } from "@yunzai-ng/core"
import { linkFramework } from "../link.js"
import { bold, cyan, dim, green, print, printErr, printRows, red, yellow } from "../terminal.js"

/** 初始化参数 */
export interface InitOptions {
  /** 应用主目录；缺省时按内核的探测顺序确定 */
  readonly home?: string | undefined
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
    if (link.failed.length > 0) {
      print(`  ${yellow("!")} 框架包未能链接至主目录，插件将无法 import @yunzai-ng/core`)
      for (const [name, reason] of link.failed) print(`      ${dim(`${name}：${reason}`)}`)
      print()
    }
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

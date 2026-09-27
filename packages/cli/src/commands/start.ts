/**
 * 模块职责：`yzng start` / `yzng dev` —— 装配内核、启动、接管信号、输出入口信息
 * 依赖方向：依赖 @yunzai-ng/core 的公开入口；不涉及其他命令
 * 生命周期：进程的整个生命周期。返回时进程即将退出
 * 注意事项：**必须自行持有事件循环。** `app.start()` 之后，进程能否继续存活取决于
 *          是否存在活跃 handle：面板启用时存在监听 socket，账号连接时存在 TCP 连接。
 *          但"面板关闭且未配置任何账号"正是全新安装后的缺省状态，此时 Node 会判定
 *          无待处理工作而直接退出 —— 使用者所见的现象是 `yzng start` 输出横幅后即
 *          返回终端提示符，且退出码为 0，无法据此判断属于异常终止还是既定行为。
 *          因此此处以一个长周期定时器兜底，并交由 `app.own()` 在停机时清除。
 */
import { createApp, resolvePaths, type App } from "@yunzai-ng/core"
import type { LogLevel } from "@yunzai-ng/types"
import { linkFramework } from "../link.js"
import { noteLegacyInstance } from "../legacy.js"
import { bold, cyan, dim, green, print, printErr, printRows, red, yellow } from "../terminal.js"

/** 兜底定时器的间隔：取值足够大以避免产生可测量的开销，同时不超出 32 位范围 */
const KEEPALIVE_MS = 0x7fffffff

/**
 * 因重启请求而退出时的退出码
 *
 * **刻意非零。** pm2 与 `Restart=always` 的 systemd 单元对任何退出码都会拉起，但
 * `Restart=on-failure`（systemd 单元里很常见的一种写法）只在非零时拉起 —— 用 0 退出
 * 会让那批实例「关掉之后再也不起来」，而那正是本功能最不该有的失败方式。
 *
 * 取 75：sysexits.h 里的 `EX_TEMPFAIL`（暂时性失败，可重试），语义最接近「我这就下去，
 * 请把我拉起来」。它与 Node 自身的退出码不冲突（Node 用 1~12 与 128+n）。
 */
const RESTART_EXIT_CODE = 75

/** 启动参数 */
export interface StartOptions {
  /** 应用主目录 */
  readonly home?: string | undefined
  /** 额外插件目录 */
  readonly extraDirs?: readonly string[] | undefined
  /** 启动期日志级别 */
  readonly logLevel?: LogLevel | undefined
  /** 是否输出至控制台 */
  readonly console?: boolean | undefined
}

/**
 * 输出启动横幅
 *
 * 刻意经由 stdout 而非 logger：这几行给出的是面板访问位置，使用者在配置出错、
 * 日志级别被调整为 warn 时最需要看到，而那恰是 logger 不再输出的情形。
 * @param app 已启动的应用
 */
function printBanner(app: App): void {
  const settings = app.settings
  const rows: [string, string][] = [
    ["版本", app.version],
    ["主目录", cyan(app.paths.home)],
    ["环境", `${app.platform.os}/${app.platform.arch}${app.platform.isTermux ? " · Termux" : ""} · Node ${app.platform.nodeVersion}`]
  ]

  if (settings.server.enable) {
    const host = settings.server.host === "0.0.0.0" ? "127.0.0.1" : settings.server.host
    rows.push(["面板", cyan(`http://${host}:${settings.server.port}/`)])
    // 令牌完整输出而非掩码：此处为本机终端，使用者此刻正需将其复制至浏览器。
    // 掩码只会迫使其转往 config/yunzai.yaml 查阅，安全性并无变化，却增加一道步骤
    if (settings.server.token) rows.push(["令牌", settings.server.token])
  } else {
    rows.push(["面板", dim("已在配置中关闭（server.enable）")])
  }

  const online = app.subsystems.bots.online().length
  const accounts = app.subsystems.accounts.list().length
  rows.push(["账号", accounts === 0 ? yellow("尚未配置，请在面板中添加") : `${online}/${accounts} 在线`])

  print()
  print(`  ${bold(green("Yunzai NG"))} ${dim("已启动")}`)
  print()
  printRows(rows)
  print()
  print(dim("  Ctrl+C 停机（再次按下则强制退出）"))
  print()
}

/**
 * 启动机器人
 * @param opts 启动参数
 * @returns 进程退出码
 */
export async function runStart(opts: StartOptions = {}): Promise<number> {
  // 建立链接须早于 createApp：插件在 app.start() 中被 import，此时 Node 的解析
  // 已经开始，届时再补建链接已无效果
  const home = resolvePaths({ home: opts.home }).home
  // 在 createApp 之前提示：插件加载可能耗时数秒，而「我的数据呢」这个疑问越早解答越好
  if (noteLegacyInstance(home)) print()
  const link = await linkFramework(home)

  let app: App
  try {
    app = await createApp({
      home,
      logLevel: opts.logLevel,
      console: opts.console,
      extraDirs: opts.extraDirs === undefined ? undefined : [...opts.extraDirs]
    })
  } catch (err) {
    // 装配失败（目录无法建立、KV 驱动全部无法打开）时尚无可用的 logger，只能直接写入终端
    printErr(red(`启动失败：${err instanceof Error ? err.message : String(err)}`))
    printErr(dim("常见原因：主目录无写入权限、磁盘空间不足，或上一实例仍占用数据目录"))
    return 1
  }

  // 信号接管须在 start() 之前装配：插件加载可能耗时数秒，其间按下 Ctrl+C
  // 亦应能够优雅停机，而不是残留一个半初始化状态的数据目录
  app.handleSignals()

  /*
   * 接管重启请求：停机之后退出，由外部守护拉起
   *
   * 内核只做到「优雅停机」为止（`stop()` 是终态），**退出这一步归宿主** —— 与
   * `handleSignals()` 同一条判断：嵌进别人程序里的内核不该私自决定进程什么时候退出。
   * 注册在这里，于是 `yzng start` 起的实例上 `canRestart` 为真，而单元测试与嵌入
   * 场景不注册、插件据此得知「这台实例重启不了」。
   *
   * 日志先落盘再退出：那句「正在重启」是事后排查「谁让它重启的」的唯一线索，而
   * `process.exit` 不等待挂起的写入。
   */
  app.onRestartRequest(() => {
    app.loggerHub.flush()
    process.exit(RESTART_EXIT_CODE)
  })

  // 链接结果延至此处报告：createApp 之前尚无 logger，而该事项的重要程度不足以直接写入终端
  if (link.linked.length > 0) app.logger.debug(`已将框架包链接至主目录：${link.linked.join("、")}`)
  for (const [name, reason] of link.failed) {
    app.logger.warn(`${name} 未能链接至主目录，${home} 下的第三方插件将无法 import 该包：${reason}`)
  }

  const keepalive = setInterval(() => undefined, KEEPALIVE_MS)
  app.own(() => clearInterval(keepalive))

  try {
    await app.start()
  } catch (err) {
    app.logger.fatal(`启动失败：${err instanceof Error ? err.message : String(err)}`)
    await app.stop()
    return 1
  }

  printBanner(app)
  // 不返回：进程由 handleSignals() 中的 process.exit 结束。
  // 该 promise 永不兑现是刻意的 —— 参见文件头
  return new Promise<number>(() => undefined)
}

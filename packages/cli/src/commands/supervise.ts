/**
 * 模块职责：`yzng start` 自带的进程守护 —— 父进程 fork 一个子进程跑内核，按子进程的
 *          退出码决定重启、收工还是放弃
 * 依赖方向：仅 node 内建 + terminal.js（**刻意不 import core**）。父进程要尽量轻，多背
 *          一份内核就白费了这一层；子进程才加载 core，见 run.ts 的动态 import
 * 生命周期：父进程的整个生命周期。子进程由 start.ts 的 runKernel 承担
 * 注意事项：父子之间唯一的约定是**退出码**（见 exit-codes.ts）与一条 `ready` 的 IPC 消息，
 *          父进程不读子进程的任何内部状态。行为按 Windows 实测定：
 *          1) Ctrl+C 时父子同处一个控制台组、**都会收到 SIGINT**，子进程自己优雅停机退 0，
 *             父进程只需别再拉起、等它停完 —— 在 Windows 上 `child.kill` 是硬杀，转发反而坏事，
 *             故仅在非 Windows 上转发信号。
 *          2) 父进程被单独强杀（任务管理器）时子进程不会自动消失，靠 IPC 断开时子进程那侧的
 *             `disconnect` 自行优雅停机兜底，见 start.ts。
 */
import { fork, type ChildProcess } from "node:child_process"
import process from "node:process"
import { dim, print, printErr, yellow } from "../terminal.js"
import { RESTART_EXIT_CODE, SHUTDOWN_EXIT_CODE } from "./exit-codes.js"
import type { StartOptions } from "./start.js"

/** 崩溃计数的时间窗：只在这段时间内累计，之外的既往崩溃不算数 */
const CRASH_WINDOW_MS = 60_000

/** 时间窗内崩溃到这个次数就放弃 —— 反复起不来多半是配置或环境问题，无限重试只会刷屏 */
const CRASH_LIMIT = 5

/** 崩溃重启的退避上限 */
const BACKOFF_CAP_MS = 30_000

/**
 * 该不该由本进程担任守护
 *
 * 四种情形不担任，直接单进程跑内核：已是被守护的子进程、使用者以 `--no-supervise` 关掉、
 * 外部已有 pm2 / systemd（不在别人的守护里再套一层，那会让 `max_memory_restart` 只量到
 * 空壳父进程、停机信号也多转一手）。
 *
 * 探测外部守护这里**另抄一份**而不 import core 的 `detectSupervisor`：那会把整个内核拉进
 * 父进程，正是本模块要避免的。两处读的是同一批环境变量，改一处要想到另一处。
 * @param opts 启动参数
 * @param env 环境变量
 * @returns 是否担任守护
 */
export function shouldSupervise(opts: StartOptions, env: NodeJS.ProcessEnv = process.env): boolean {
  if (typeof env["YZNG_SUPERVISOR"] === "string" && env["YZNG_SUPERVISOR"] !== "") return false
  if (opts.supervise === false) return false
  if (typeof env["pm_id"] === "string" && env["pm_id"] !== "") return false
  if (typeof env["INVOCATION_ID"] === "string" && env["INVOCATION_ID"] !== "") return false
  return true
}

/**
 * 担任守护：fork 子进程跑内核，按其退出码决定下一步
 *
 * 不收参数：子进程用**同一份 argv** 重新起（原样透传 home / plugins / console 等旗标），
 * 故这里只需 `process.argv`，无须把 run.ts 解析出的 opts 再带一遍。
 *
 * 退出码的含义两头共用一处（exit-codes.ts）：
 * - {@link SHUTDOWN_EXIT_CODE}（0）：关机，父进程随之收工
 * - {@link RESTART_EXIT_CODE}（75）：重启，立即拉起并清零崩溃计数（这是主动重启，不算崩溃）
 * - 其余非零：崩溃。**没报过 `ready` 就退出**当作启动失败，不重试（配置错、端口被占，重试也不会好）；
 *   报过 `ready` 再崩的按退避重启，短时间内连崩到上限即放弃
 * @returns 进程退出码（该 promise 通常不兑现，进程由内部 `process.exit` 结束）
 */
export function runSupervisor(): Promise<number> {
  const binPath = process.argv[1]
  if (binPath === undefined) {
    printErr("无法定位 yzng 入口，守护无法启动")
    return Promise.resolve(1)
  }
  const childArgv = process.argv.slice(2)

  /** 是否正在收工（收到过 Ctrl+C / SIGTERM）：置位后子进程退出即不再拉起 */
  let leaving = false
  /** 当前子进程 */
  let child: ChildProcess | undefined
  /** 当前这个子进程是否报过 `ready` */
  let childReady = false
  /** 时间窗内的崩溃时刻 */
  const crashes: number[] = []

  /** fork 一个子进程跑内核 */
  const spawn = (): void => {
    childReady = false
    child = fork(binPath, childArgv, {
      // 注入 pid 供内核的 detectSupervisor 认出「有自带守护」，也作为子进程「我是被守护的」的标记
      env: { ...process.env, YZNG_SUPERVISOR: String(process.pid) },
      // stdio 继承终端：标准输入适配器要 TTY，这也是自带守护相对 pm2 的好处
      stdio: ["inherit", "inherit", "inherit", "ipc"]
    })
    child.on("message", (msg: unknown) => {
      if (typeof msg === "object" && msg !== null && (msg as { type?: unknown }).type === "ready") {
        childReady = true
      }
    })
    child.on("error", err => {
      printErr(`子进程启动失败：${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    })
    child.on("exit", onExit)
  }

  /**
   * 子进程退出后的处置
   * @param code 退出码
   * @param signal 终止信号（被信号杀死时）
   */
  const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (leaving) {
      // 收工途中子进程停完了：父进程随之退出，沿用子进程的退出码
      process.exit(code ?? 0)
    }

    if (code === SHUTDOWN_EXIT_CODE) {
      print(dim("  实例已关机，守护退出"))
      process.exit(0)
    }

    if (code === RESTART_EXIT_CODE) {
      print(dim("  实例请求重启，正在拉起…"))
      crashes.length = 0
      spawn()
      return
    }

    // 走到这里都是意外退出（崩溃、被信号杀死、启动失败）
    const how = signal === null ? `退出码 ${code}` : `信号 ${signal}`
    if (!childReady) {
      // 没报过 ready 就退出：多半是启动阶段就失败，重试不会好，原样把码抛出去
      printErr(yellow(`  实例未及启动就退出（${how}），不重试 —— 多为配置或环境问题，请查看上方日志`))
      process.exit(code ?? 1)
    }

    const now = Date.now()
    crashes.push(now)
    while (crashes.length > 0 && now - (crashes[0] as number) > CRASH_WINDOW_MS) crashes.shift()
    if (crashes.length >= CRASH_LIMIT) {
      printErr(yellow(`  实例在 ${Math.round(CRASH_WINDOW_MS / 1000)} 秒内崩溃 ${crashes.length} 次（${how}），放弃拉起`))
      process.exit(code ?? 1)
    }

    const backoff = Math.min(1000 * 2 ** (crashes.length - 1), BACKOFF_CAP_MS)
    printErr(yellow(`  实例意外退出（${how}），${Math.round(backoff / 1000)} 秒后拉起（第 ${crashes.length} 次）`))
    setTimeout(spawn, backoff).unref?.()
  }

  /**
   * 收到停机信号
   *
   * Ctrl+C 时父子同处一个控制台组、子进程也收到了 SIGINT 并自行优雅停机，父进程只需置位
   * 收工、等它停完；在 Windows 上转发（`child.kill`）反而是硬杀。非 Windows 上信号可能只发给
   * 父进程（`kill <父pid>`），故转发一手，那里的转发对子进程是优雅的。
   * @param signal 信号名
   */
  const onSignal = (signal: NodeJS.Signals): void => {
    if (leaving) {
      // 再来一次：别等了，硬杀子进程后强退
      child?.kill("SIGKILL")
      process.exit(1)
    }
    leaving = true
    if (child !== undefined && process.platform !== "win32") {
      try {
        child.kill(signal)
      } catch {
        // 子进程可能已在退出途中，杀不动就算了
      }
    }
  }

  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)

  print(dim(`  守护已就绪（pid ${process.pid}），启动实例…`))
  spawn()

  // 不兑现：父进程由上面的 process.exit 结束，与 runKernel 的收尾同理
  return new Promise<number>(() => undefined)
}

/**
 * 模块职责：维护面 —— 把「更新已装插件」与「请求重启」以受控形式交给插件
 * 依赖方向：依赖 plugin/market 与 plugin/host 的窄接口；不认识 App（重启由注入的处理器完成）
 * 生命周期：随 App
 * 注意事项：**这是 `AppView` 上唯一能改变实例状态的一面。** 其余部分一律只读，故独立成面
 *          正是为了让「插件动了什么」在类型上看得出来 —— 见 `types` 里 `AppView` 的说明。
 *
 *          **刻意不开放安装与删除。** 市场能装任意 git 仓库，等于在这台机器上执行任意代码；
 *          而「更新已装插件」是就地 `fetch` + `reset`，那个仓库早被使用者信任过一次。两者
 *          信任边界不同，故只开后者。删除同理：一条命令把插件目录删掉，没有任何回头路。
 *
 *          **内核没有自我重启的能力**（`App.stop()` 是终态，连接池与日志文件都已关闭），
 *          故 `requestRestart` 做的是「优雅停机 + 交给宿主退出」，再由外部守护拉起来。
 *          处理器由宿主注册（`yzng start` 注册，单元测试与嵌入场景不注册）—— 内核不该
 *          私自决定进程什么时候退出，与 `handleSignals()` 是同一条判断。
 *
 *          `requestShutdown` 与之同路，**区别只在宿主给的退出码**：重启用一个守护会拉起
 *          的码，关机用一个守护认作「别重启」的码。内核这一侧两者完全对称。
 *
 *          **`supervisor` 探测不到不等于没有守护。** Windows 服务（nssm）一类不留可识别的
 *          环境痕迹，故它只用于「能确认时给使用者一句准话」，绝不可用来拒绝重启 ——
 *          那会让一批装了守护的人用不了这个功能。能不能重启看的是 `canRestart`
 *          （有没有人注册过处理器），那才是确定的事实。
 */
import type {
  Logger,
  MaintenanceView,
  PluginUpdateOptions,
  PluginUpdateOutcome,
  PluginUpdateProbe,
  RestartRequest,
  ShutdownRequest,
  SupervisorKind
} from "@yunzai-ng/types"
import type { PluginMarket } from "../plugin/market.js"

/**
 * 探测外部进程守护
 *
 * 都按**启动器注入的环境变量**判定，而不是去翻进程表：翻进程表要 spawn 一个命令，
 * 而这个取值会被每条 `#更新` 命令读到。
 *
 * - `yzng start` 自带的守护给子进程注入 `YZNG_SUPERVISOR`（存父进程 pid）。它最贴身，
 *   故先探测；而自带守护只在探测不到外部守护时才启动，故它与 pm2 / systemd 不会同时出现。
 * - pm2 给每个受管进程注入 `pm_id`（`PM2_HOME` 在未受管的 shell 里也可能存在，故不取它）。
 * - systemd 从 v232 起注入 `INVOCATION_ID`，且仅对它自己启动的单元注入。
 *
 * 判不出时返回 undefined —— 这**不是**「没有守护」的证明，见文件头第 4 条。
 * @param env 环境变量
 * @returns 守护类型；判不出时 undefined
 */
export function detectSupervisor(env: NodeJS.ProcessEnv): SupervisorKind | undefined {
  if (typeof env["YZNG_SUPERVISOR"] === "string" && env["YZNG_SUPERVISOR"] !== "") return "yzng"
  if (typeof env["pm_id"] === "string" && env["pm_id"] !== "") return "pm2"
  if (typeof env["INVOCATION_ID"] === "string" && env["INVOCATION_ID"] !== "") return "systemd"
  return undefined
}

/**
 * 停机前留给「把话说完」的时间
 *
 * 插件应当先 `await e.reply(...)` 再请求重启，但那个 await 只保证消息交到了平台，
 * 适配器侧可能还在排队。给一小段时间比让使用者收不到那句「正在重启」要好，而它只在
 * 真要重启时付出一次。
 */
const FAREWELL_MS = 300

/** 维护面所需的依赖 */
export interface MaintenanceDeps {
  /** 插件市场 */
  readonly market: PluginMarket
  /** 重载一个插件 */
  readonly reload: (name: string) => Promise<boolean>
  /** 日志器 */
  readonly logger: Logger
  /** 优雅停机；由 App 提供 */
  readonly stop: () => Promise<void>
  /** 取当前的重启处理器；没有人接管时 undefined */
  readonly restartHandler: () => (() => void | Promise<void>) | undefined
  /** 取当前的关机处理器；没有人接管时 undefined */
  readonly shutdownHandler: () => (() => void | Promise<void>) | undefined
  /** 环境变量，供守护探测（可注入以便测试） */
  readonly env?: NodeJS.ProcessEnv
}

/**
 * 一种「离开」：重启与关机在内核这一侧只差处理器与措辞
 *
 * 抽出来是因为停机那段流程（排到下一拍、停机出错仍继续退出、无人接管时只出声）
 * 两者必须一模一样 —— 抄一遍迟早只改一边。
 */
interface Departure {
  /** 日志里怎么称呼这件事 */
  readonly what: string
  /** 停机之后会发生什么，缀在「开始停机」后面 */
  readonly after: string
  /** 宿主该调哪个方法接管 */
  readonly hook: string
  /** 无人接管时建议使用者自己做的动作 */
  readonly byHand: string
  /** 取处理器 */
  readonly handler: (deps: MaintenanceDeps) => (() => void | Promise<void>) | undefined
}

/** 重启 */
const RESTART: Departure = {
  what: "重启",
  after: "，之后由外部守护拉起",
  hook: "app.onRestartRequest()",
  byHand: "重启",
  handler: deps => deps.restartHandler()
}

/** 关机：退出码归宿主，故这里不承诺「不会被拉起」 */
const SHUTDOWN: Departure = {
  what: "关机",
  after: "，之后退出",
  hook: "app.onShutdownRequest()",
  byHand: "停机",
  handler: deps => deps.shutdownHandler()
}

/**
 * 优雅停机后交给宿主退出
 * @param deps 依赖
 * @param how 重启还是关机
 * @param reason 原因，写进日志
 * @returns 已开始停机时兑现；无人接管时立即兑现
 */
async function leave(deps: MaintenanceDeps, how: Departure, reason: string | undefined): Promise<void> {
  const because = reason === undefined || reason === "" ? "" : `：${reason}`
  const handler = how.handler(deps)

  if (handler === undefined) {
    /*
     * 无人接管时**什么都不做**，只出声
     *
     * 这一支只在宿主没注册处理器时走到（内核被嵌进别的程序、单元测试），`yzng start`
     * 起的实例一律注册过。不抛错是因为抛错会让插件把一句技术错误抄给使用者。
     */
    deps.logger.warn(
      `收到${how.what}请求${because}，但本进程的宿主没有接管${how.what}（内核嵌在别的程序里时即如此），` +
        `已忽略。请由宿主调用 ${how.hook} 接管，或按自身部署方式${how.byHand}`
    )
    return
  }

  deps.logger.info(`收到${how.what}请求${because}，开始停机${how.after}`)

  /*
   * 不在此处 await 停机
   *
   * 调用方几乎总是一个命令处理函数，而停机会卸载它所属的插件 —— 在自己的调用栈里
   * 等自己被卸载完，是一个没有必要的结。故排到下一拍执行，本方法在「已开始停机」
   * 处即兑现（与 TSDoc 一致）。延时同时给那句告别留出发出去的时间。
   */
  setTimeout(() => {
    void (async (): Promise<void> => {
      try {
        await deps.stop()
      } catch (err) {
        // 停机路径上的失败不该挡住退出：一个没关干净的旧连接会随进程一起消失
        deps.logger.warn(`${how.what}前的停机过程出错，仍继续退出`, err)
      }
      await handler()
    })()
  }, FAREWELL_MS).unref?.()
}

/**
 * 组装维护面
 * @param deps 依赖
 * @returns 交给插件的那一份维护面
 */
export function createMaintenanceView(deps: MaintenanceDeps): MaintenanceView {
  const supervisor = detectSupervisor(deps.env ?? process.env)

  return {
    supervisor,

    get canRestart(): boolean {
      // 现读而非快照：宿主注册处理器的时机（`yzng start`）晚于 App 构造，
      // 存成快照会让插件永远看到 false
      return deps.restartHandler() !== undefined
    },

    async inspectUpdate(name: string): Promise<PluginUpdateProbe> {
      const probe = await deps.market.inspectUpdate(name)
      // 显式映射而不是原样回传：市场那份结果日后加字段时，不该自动流进插件看得见的契约
      return { willPull: probe.willPull, dirty: probe.dirty }
    },

    async updatePlugin(name: string, opts: PluginUpdateOptions = {}): Promise<PluginUpdateOutcome> {
      const result = await deps.market.update(name, {
        ...(opts.dependencies === undefined ? {} : { dependencies: opts.dependencies }),
        ...(opts.onDirty === undefined ? {} : { onDirty: opts.onDirty })
      })
      // 只取维护面用得上的几项：安装目录、取源方式一类是面板的事
      return {
        name: result.name,
        version: result.version,
        ...(result.fromVersion === undefined ? {} : { fromVersion: result.fromVersion }),
        ...(result.changed === undefined ? {} : { changed: result.changed }),
        ...(result.commits === undefined ? {} : { commits: result.commits }),
        ...(result.dependencyError === undefined ? {} : { dependencyError: result.dependencyError }),
        ...(result.setupError === undefined ? {} : { setupError: result.setupError }),
        ...(result.stashed === undefined ? {} : { stashed: result.stashed }),
        ...(result.discarded === undefined ? {} : { discarded: result.discarded })
      }
    },

    reloadPlugin(name: string): Promise<boolean> {
      return deps.reload(name)
    },

    get canShutdown(): boolean {
      return deps.shutdownHandler() !== undefined
    },

    requestRestart(req: RestartRequest = {}): Promise<void> {
      return leave(deps, RESTART, req.reason)
    },

    requestShutdown(req: ShutdownRequest = {}): Promise<void> {
      return leave(deps, SHUTDOWN, req.reason)
    }
  }
}

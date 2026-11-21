/**
 * 模块职责：在一个插件目录里执行包管理器 —— 装依赖与跑 npm script
 * 依赖方向：只依赖 node 内置模块；不认识市场、不认识插件宿主
 * 生命周期：无状态
 * 注意事项：**脚本名是要拼进命令行的，故必须先过白名单。** Windows 上 node 拒绝不经 shell
 *          执行 `.cmd`（CVE-2024-27980 之后的行为），而 `pnpm` / `npm` 在 Windows 上正是
 *          `.cmd`，因此这里只能带 `shell` 执行；一旦带了 shell，参数就是被解释的字符串，
 *          索引里一个 `build && curl …` 就是任意命令执行。目录路径不进命令行（走 `cwd`），
 *          于是唯一的可变部分就是脚本名 —— 它由 {@link assertScriptName} 挡住。
 *
 *          **装依赖要不要带 devDependencies 由调用方决定，本模块不猜。** 从源码装的插件
 *          要跑 `build`，而编译器（typescript）在 devDependencies 里 —— 那时 `--prod`
 *          装出来的目录跑 `build` 必然失败，报的还是「找不到 tsc」这种离原因很远的错。
 */
import { execFile } from "node:child_process"

/**
 * 包管理器候选，按优先级
 *
 * pnpm 在前：本项目各插件的 lock 文件都是 pnpm 的，装出来的布局与插件作者测过的一致。
 * npm 兜底，随 node 一起装。不认 yarn —— berry 缺省不建 `node_modules`（PnP 模式），
 * 那时 `import()` 插件入口会失败，而失败原因与包管理器的关系很难看出来。
 */
export const PACKAGE_MANAGERS: readonly string[] = ["pnpm", "npm"]

/**
 * 装依赖的超时毫秒
 *
 * 比任何网络请求都长：国内网络下一次冷装依赖十分钟并不罕见，而超时的后果是留下一个
 * 装了一半的 `node_modules` —— 那比等下去更难收拾。
 */
export const INSTALL_TIMEOUT_MS = 15 * 60 * 1000

/**
 * 跑一个 script 的超时毫秒
 *
 * 与装依赖同一量级，且理由相同：`build` 只要几秒，但装后脚本可能在下载一个
 * 上百兆的运行时（renderer-puppeteer 的 `install:browser` 拉的是 Chromium）。
 */
export const SCRIPT_TIMEOUT_MS = 15 * 60 * 1000

/**
 * 合法的 npm script 名
 *
 * 字母或数字开头，其余可含字母、数字、冒号、点、下划线与连字符 —— 冒号是为了
 * `install:browser` 这类分段名。**刻意不含空格、引号与任何 shell 元字符**：
 * 理由见文件头，这一条正则是那道边界本身。
 */
const SCRIPT_NAME_RE = /^[a-z\d][a-z\d:._-]*$/i

/**
 * 一个 script 名是否合法
 *
 * 与 {@link assertScriptName} 同一判据，两种形态：解析索引时要的是「不合法就丢弃这一条」，
 * 而真要执行前要的是「不合法就抛」。共用一条正则，免得日后只改一处。
 * @param name 待判定的名称
 * @returns 是否合法
 */
export function isScriptName(name: string): boolean {
  return SCRIPT_NAME_RE.test(name)
}

/**
 * 校验一个 script 名
 *
 * 执行前的最后一道闸：即便索引解析时已筛过，`runPm` 也可能被别处直接调用。
 * @param name 待校验的名称
 * @returns 名称本身
 * @throws 名称为空或含白名单之外的字符时
 */
export function assertScriptName(name: string): string {
  if (!isScriptName(name)) throw new Error(`script 名不合法：${name}`)
  return name
}

/** 一次包管理器动作 */
export type PmTask =
  | {
      /** 装依赖 */
      readonly kind: "install"
      /** 是否连 devDependencies 一起装 */
      readonly dev: boolean
    }
  | {
      /** 跑一个 script */
      readonly kind: "run"
      /** script 名，须已过 {@link assertScriptName} */
      readonly script: string
    }

/**
 * 执行一次包管理器动作的函数形态
 *
 * 抽成类型是为了让测试替换它。这条路的正确性几乎全在**下发了什么** —— 要不要带
 * devDependencies、跑的是哪个 script、失败之后还继不继续 —— 而真实的包管理器
 * 只能告诉你「最后目录里有 node_modules」，上述任一条错掉同样可能得到一个看着
 * 对的目录，直到某个插件在加载时报出一条与原因无关的错。故留这道缝。
 * @param task 动作
 * @param cwd 插件目录
 * @param timeout 超时毫秒
 * @returns 实际用的是哪个包管理器
 */
export type PmRunner = (task: PmTask, cwd: string, timeout: number) => Promise<string>

/**
 * 把一次动作译成某个包管理器的实参
 *
 * `--prod` / `--omit=dev` 两家的写法不同，故按包管理器分别给。
 * @param pm 包管理器
 * @param task 动作
 * @returns 实参
 */
function argsOf(pm: string, task: PmTask): string[] {
  if (task.kind === "run") return ["run", task.script]
  if (task.dev) return ["install"]
  return pm === "pnpm" ? ["install", "--prod"] : ["install", "--omit=dev"]
}

/**
 * 依次尝试各包管理器，`MarketDeps.pm` 的缺省实现
 *
 * 不加 `--ignore-scripts`：插件可能依赖原生模块（sqlite、sharp），install 脚本正是它们
 * 编译或下载预编译产物的地方，禁掉会装出一份 `import` 即报错的 `node_modules`，而报错
 * 指向缺少 `.node` 文件，离「我禁了脚本」很远。既然已明说要装，就该装成能用的。
 *
 * 只有「没装这个包管理器」才换下一个：pnpm 已经跑起来又失败时再让 npm 在同一目录重来，
 * 耗时翻倍不说，还会在 pnpm 的符号链接布局上叠一份 npm 的扁平布局。Windows 上经 shell
 * 执行时「命令不存在」与「执行失败」退出码都是 1，故先用 `--version` 探一次。
 * @param task 动作
 * @param cwd 插件目录
 * @param timeout 超时毫秒
 * @returns 实际用的是哪个包管理器
 * @throws 没有可用的包管理器，或选中的那个执行失败时
 */
export const runPm: PmRunner = (task, cwd, timeout) => createPmRunner(exec)(task, cwd, timeout)

/**
 * 以给定的命令执行器组装 {@link PmRunner}
 * @param execute 执行一条命令，失败时抛
 * @returns 依次探测并执行的 runner
 */
export function createPmRunner(
  execute: (cmd: string, args: string[], cwd: string, timeout: number) => Promise<void>
): PmRunner {
  return async (task, cwd, timeout) => {
    if (task.kind === "run") assertScriptName(task.script)
    for (const pm of PACKAGE_MANAGERS) {
      if (!(await execute(pm, ["--version"], cwd, PROBE_TIMEOUT_MS).then(() => true, () => false))) continue
      try {
        await execute(pm, argsOf(pm, task), cwd, timeout)
      } catch (err) {
        throw new Error(`${pm} 执行失败：${err instanceof Error ? err.message : String(err)}`)
      }
      return pm
    }
    throw new Error(`没有可用的包管理器（试过 ${PACKAGE_MANAGERS.join("、")}）`)
  }
}

/** 探测包管理器是否可用的超时毫秒 */
const PROBE_TIMEOUT_MS = 30_000

/**
 * 执行一次命令
 * @param cmd 命令
 * @param args 实参
 * @param cwd 工作目录
 * @param timeout 超时毫秒
 * @throws 退出码非 0 或超时，消息取 stderr
 */
function exec(cmd: string, args: string[], cwd: string, timeout: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        cwd,
        timeout,
        env: { ...process.env },
        windowsHide: true,
        // 理由见文件头：Windows 上 pnpm/npm 是 .cmd，不经 shell 起不来
        shell: process.platform === "win32"
      },
      (err, _stdout, stderr) => {
        if (err) reject(new Error(stderr.trim() || err.message))
        else resolve()
      }
    )
  })
}

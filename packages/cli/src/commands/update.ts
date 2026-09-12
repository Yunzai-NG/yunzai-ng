/**
 * 模块职责：`yzng update` —— 把安装目录里的框架包整套升到同一版本
 * 依赖方向：依赖内核的 `findInstallRoot` 与本包的终端输出
 * 生命周期：一次性，执行完毕即退出
 * 注意事项：**只升 `@yunzai-ng/cli` 一个包，core / jsx / types 由它带上来。** CLI 的
 *          `dependencies` 里列着这三个，且发布时 `workspace:*` 被改写为**精确版本**，
 *          于是「装哪个 cli」唯一确定了另外三个的版本。逐个升反而会装出四个版本互不
 *          匹配的组合 —— 那时报错落在插件里（接口凭空缺字段），与「我升级过」相距很远。
 *
 *          **根 `package.json` 里单列 core / jsx / types 是有害的，故缺省剪掉。**
 *          单列且被精确锁住时，cli 升到新版本后它对 core 的精确依赖与根上那条冲突，
 *          包管理器只能装两份：`node_modules/@yunzai-ng/core` 是旧的，cli 实际用的是新的。
 *          插件经主目录的链接拿到新的，而编辑器与 `tsc` 自根目录解析到旧的 ——
 *          代码里报错、运行时正常，这一幕极难归因。仅剪 `dependencies`；
 *          `devDependencies` 里的一律保留，那是本地写 TS 插件时给编译器用的。
 *
 *          **升级后不在本进程内重建主目录的框架链接。** 包管理器跑完之后，当前进程
 *          解析到的仍是旧版本的目录（pnpm 甚至可能已把它从 `.pnpm/` 里剪掉），
 *          此时调用 `linkFramework` 会把链接指向旧版本，比不建更糟。下次
 *          `yzng start` 会重建 —— 它按链接的**指向**判断去留，正为此而写。
 */
import { execFile } from "node:child_process"
import { readFile, realpath, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import process from "node:process"
import { findInstallRoot } from "@yunzai-ng/core"
import { bold, cyan, dim, green, print, printErr, printRows, red, yellow } from "../terminal.js"

/** 要升的那个包 —— 另外三个由它的 dependencies 带上来 */
const CLI_PACKAGE = "@yunzai-ng/cli"

/**
 * 由 CLI 带上来的框架包
 *
 * 与 {@link import("../link.js").linkFramework} 链接的集合一致：那里链接什么，这里就该报告什么，
 * 否则「升上去了」与「插件能 import 到的是哪一版」会是两件对不上的事。
 */
const FRAMEWORK_PACKAGES = ["@yunzai-ng/core", "@yunzai-ng/types", "@yunzai-ng/jsx"] as const

/** 报告里出现的全部包，cli 在前 */
const REPORTED = [CLI_PACKAGE, ...FRAMEWORK_PACKAGES] as const

/**
 * 装依赖的超时毫秒
 *
 * 与内核代跑包管理器时同一量级（`plugin/pm.ts`）：国内网络下一次冷装十分钟并不罕见，
 * 而超时的后果是留下一个装了一半的 `node_modules`，比等下去更难收拾。
 */
const UPDATE_TIMEOUT_MS = 15 * 60 * 1000

/**
 * 合法的版本说明符
 *
 * 只放行 dist-tag（`latest`）与具体版本（`0.4.0`、`0.5.0-rc.1`），**刻意不放行范围**：
 * `^` 在 Windows 的 cmd 里是转义字符，`>` 是重定向 —— 而下面执行包管理器时不得不带
 * `shell`（Windows 上 `pnpm` / `npm` 是 `.cmd`，node 在 CVE-2024-27980 之后拒绝不经
 * shell 执行它们）。带了 shell，参数就是被解释的字符串，这条正则即是那道边界。
 */
const SPEC_RE = /^[a-z\d][\w.-]*$/i

/** 一个包升级前后的版本 */
export interface VersionChange {
  /** 包名 */
  readonly name: string
  /** 升级前；未装时 undefined */
  readonly before: string | undefined
  /** 升级后；未装时 undefined */
  readonly after: string | undefined
}

/**
 * 执行一次包管理器的函数形态
 *
 * 抽成类型是为了让测试替换它。这条路的正确性几乎全在**下发了什么** —— 选了哪个包管理器、
 * 升的是哪一个包、在哪个目录跑 —— 而真实的包管理器只能告诉你「最后目录里有 node_modules」。
 * @param pm 包管理器可执行名
 * @param args 实参
 * @param cwd 安装目录
 */
export type UpdateRunner = (pm: string, args: readonly string[], cwd: string) => Promise<void>

/** 更新参数 */
export interface UpdateOptions {
  /** 自哪个目录起向上寻找安装目录；缺省为当前工作目录 */
  readonly from?: string | undefined
  /** 目标版本或 dist-tag；缺省 `latest` */
  readonly to?: string | undefined
  /** 是否剪掉根 `package.json` 中多余的框架依赖；缺省 true */
  readonly prune?: boolean | undefined
  /** 执行包管理器的实现；缺省为真实执行，测试时替换 */
  readonly run?: UpdateRunner | undefined
}

/**
 * 读一个 JSON 文件
 * @param file 路径
 * @returns 解析结果；读不到或不是合法 JSON 时 undefined
 */
async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"))
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/**
 * 取 `package.json` 里某一段依赖表
 * @param pkg 已解析的 package.json
 * @param field 字段名
 * @returns 依赖表；不存在时 undefined
 */
function depsOf(pkg: Record<string, unknown>, field: string): Record<string, unknown> | undefined {
  const value = pkg[field]
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
}

/**
 * 列出该到哪些 `node_modules` 里找传递依赖
 *
 * 自 CLI 的**真实路径**逐级向上，直至安装目录，再补上安装目录自身的 `node_modules` ——
 * 这样两种布局都覆盖到：pnpm 把 CLI 链到 `.pnpm/@yunzai-ng+cli@x/node_modules/@yunzai-ng/cli`
 * 并把它的依赖放在同一层，npm 则一律提到安装目录的 `node_modules/`。
 *
 * 先取 realpath 是必要的一步：pnpm 布局下 `<root>/node_modules/@yunzai-ng/cli` 是一条链接，
 * 按字面路径向上找永远进不到 `.pnpm/` 里，于是三个包全被报成「未装」。
 * @param root 安装目录
 * @param cliDir CLI 所在目录
 * @returns 候选目录，按查找顺序
 */
async function searchDirs(root: string, cliDir: string): Promise<readonly string[]> {
  const dirs: string[] = []
  let dir = await realpath(cliDir).catch(() => cliDir)
  for (;;) {
    dirs.push(join(dir, "node_modules"))
    if (dir === root) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const own = join(root, "node_modules")
  if (!dirs.includes(own)) dirs.push(own)
  return dirs
}

/**
 * 读出安装目录里四个包各自的版本
 *
 * **在磁盘上按 node 的算法自己找，不用 `createRequire`。** 后者的结果取决于**当前进程的
 * 模块图**：在框架仓库自身里跑（或在 vitest 之类会改写解析的宿主里跑）时，它会漏到
 * workspace 里的那几个源码包上，于是报出的版本与安装目录里实际装的那份无关。
 *
 * 基准也刻意不取 `import.meta.url`：本进程跑的是**旧版**的 CLI，自它出发解析必然仍得到
 * 旧的三个包，于是「升级后」一栏会与「升级前」一模一样。
 * @param root 安装目录
 * @returns 包名到版本的映射；未装到的包不出现
 */
export async function readInstalled(root: string): Promise<ReadonlyMap<string, string>> {
  const found = new Map<string, string>()
  const cliDir = join(root, "node_modules", CLI_PACKAGE)
  const cli = await readJson(join(cliDir, "package.json"))
  if (cli === undefined) return found
  if (typeof cli["version"] === "string") found.set(CLI_PACKAGE, cli["version"])

  const dirs = await searchDirs(root, cliDir)
  for (const name of FRAMEWORK_PACKAGES) {
    for (const dir of dirs) {
      const pkg = await readJson(join(dir, name, "package.json"))
      if (pkg !== undefined && typeof pkg["version"] === "string") {
        // 就近者胜，与 node 的解析顺序一致
        found.set(name, pkg["version"])
        break
      }
    }
    // 一个都没找到即视为未装；缺哪一个由报告如实呈现，不在此处编造版本号
  }
  return found
}

/**
 * 猜出这个目录该用哪个包管理器
 *
 * 按 lock 文件判断而非固定顺序：在一个 pnpm 项目里跑 `npm install` 会另建一份
 * `package-lock.json` 与一套扁平 `node_modules`，此后两个包管理器各自维护一半依赖 ——
 * 而这种状态的表现是随机的模块解析失败，与「我升级过框架」看不出关系。
 * 都没有 lock 文件时按 pnpm、npm 依次尝试，与内核代跑包管理器的顺序一致。
 * @param root 安装目录
 * @returns 候选包管理器，按优先级
 */
export async function detectPackageManagers(root: string): Promise<readonly string[]> {
  if ((await readJson(join(root, "package.json"))) === undefined) return ["pnpm", "npm"]
  const hasPnpmLock = await readFile(join(root, "pnpm-lock.yaml"), "utf8").then(
    () => true,
    () => false
  )
  if (hasPnpmLock) return ["pnpm"]
  const hasNpmLock = await readFile(join(root, "package-lock.json"), "utf8").then(
    () => true,
    () => false
  )
  if (hasNpmLock) return ["npm"]
  return ["pnpm", "npm"]
}

/**
 * 把一次升级译成某个包管理器的实参
 * @param pm 包管理器
 * @param spec `名称@版本`
 * @returns 实参
 */
function argsOf(pm: string, spec: string): string[] {
  // pnpm 的 install 不接受包名，改依赖版本要用 add；npm 的 install 两用
  return pm === "pnpm" ? ["add", spec] : ["install", spec]
}

/**
 * 真实执行包管理器，{@link UpdateOptions.run} 的缺省实现
 * @param pm 包管理器
 * @param args 实参
 * @param cwd 安装目录
 */
const execPm: UpdateRunner = (pm, args, cwd) =>
  new Promise<void>((resolve, reject) => {
    execFile(
      pm,
      args,
      {
        cwd,
        timeout: UPDATE_TIMEOUT_MS,
        env: { ...process.env },
        windowsHide: true,
        // 理由见 SPEC_RE：Windows 上 pnpm/npm 是 .cmd，不经 shell 起不来
        shell: process.platform === "win32"
      },
      (err, _stdout, stderr) => {
        if (err) reject(new Error(stderr.trim() || err.message))
        else resolve()
      }
    )
  })

/**
 * 依次尝试各候选包管理器
 *
 * 全都失败时把各自的原因都带上：只报最后一个会使「机器上压根没装 pnpm」与
 * 「pnpm 装到一半失败」看起来一样。
 * @param candidates 候选
 * @param spec `名称@版本`
 * @param cwd 安装目录
 * @param run 执行实现
 * @returns 实际用的包管理器
 * @throws 全部候选都不可用或都失败时
 */
async function runUpdate(
  candidates: readonly string[],
  spec: string,
  cwd: string,
  run: UpdateRunner
): Promise<string> {
  const errors: string[] = []
  for (const pm of candidates) {
    try {
      await run(pm, argsOf(pm, spec), cwd)
      return pm
    } catch (err) {
      errors.push(`${pm}：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  throw new Error(`包管理器均不可用或执行失败 —— ${errors.join("；")}`)
}

/**
 * 探出一份 JSON 文本用的缩进
 *
 * 原样写回使用者的缩进风格：把一份四空格的 `package.json` 重写成两空格，会在
 * 版本管理里留下一整个文件的改动，真正那两行反而看不见了。
 * @param text 原文
 * @returns 缩进字符串
 */
function indentOf(text: string): string {
  const match = /\n([ \t]+)"/.exec(text)
  return match?.[1] ?? "  "
}

/**
 * 剪掉根 `package.json` 中多余的框架依赖
 *
 * 仅动 `dependencies`。理由见文件头。
 * @param root 安装目录
 * @returns 被剪掉的包名
 */
export async function pruneFrameworkDeps(root: string): Promise<readonly string[]> {
  const file = join(root, "package.json")
  let text: string
  try {
    text = await readFile(file, "utf8")
  } catch {
    return []
  }
  let pkg: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== "object" || parsed === null) return []
    pkg = parsed as Record<string, unknown>
  } catch {
    return []
  }

  const deps = depsOf(pkg, "dependencies")
  if (deps === undefined) return []
  const removed = FRAMEWORK_PACKAGES.filter(name => deps[name] !== undefined)
  if (removed.length === 0) return []
  for (const name of removed) delete deps[name]

  const trailing = text.endsWith("\n") ? "\n" : ""
  await writeFile(file, `${JSON.stringify(pkg, null, indentOf(text))}${trailing}`, "utf8")
  return removed
}

/**
 * 汇总升级前后的版本
 * @param before 升级前
 * @param after 升级后
 * @returns 四个包各自的变化
 */
export function diffVersions(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>
): readonly VersionChange[] {
  return REPORTED.map(name => ({ name, before: before.get(name), after: after.get(name) }))
}

/**
 * 输出一张升级前后对照表
 * @param changes 变化
 */
function printChanges(changes: readonly VersionChange[]): void {
  printRows(
    changes.map(change => {
      const before = change.before ?? dim("未装")
      if (change.after === undefined) return [change.name, `${before} ${dim("→")} ${yellow("未装")}`] as const
      if (change.before === change.after) return [change.name, `${change.after} ${dim("未变")}`] as const
      return [change.name, `${dim(before)} ${dim("→")} ${green(change.after)}`] as const
    })
  )
}

/**
 * 升级已装的框架包
 * @param opts 参数
 * @returns 进程退出码
 */
export async function runUpdateCommand(opts: UpdateOptions = {}): Promise<number> {
  const spec = opts.to ?? "latest"
  if (!SPEC_RE.test(spec)) {
    printErr(red(`版本 ${spec} 不合法：只接受 dist-tag（如 latest）或具体版本（如 0.4.0）`))
    printErr(dim("刻意不接受 ^ ~ > 一类范围 —— 它们在 Windows 的命令行里是转义与重定向字符"))
    return 1
  }

  const from = opts.from ?? process.cwd()
  const root = findInstallRoot(from)
  if (root === undefined) {
    printErr(red("未找到装有 Yunzai NG 的目录"))
    printErr(dim(`自 ${from} 逐级向上都没有一份 package.json 声明了 ${CLI_PACKAGE}`))
    printErr(dim(`若是全局安装，请直接执行：pnpm add -g ${CLI_PACKAGE}@${spec}`))
    printErr(dim("若是从源码构建的仓库，请用 git 拉取后重新 pnpm install && pnpm run build"))
    return 1
  }

  const before = await readInstalled(root)
  print()
  print(`  ${bold("安装目录")} ${cyan(root)}`)
  print()

  const pruned = opts.prune === false ? [] : await pruneFrameworkDeps(root)
  if (pruned.length > 0) {
    print(`  ${yellow("!")} 已从 package.json 的 dependencies 中移除 ${pruned.join("、")}`)
    print(`      ${dim("这三个包由 CLI 按精确版本带上来，单列会锁住旧版本，使升级只动 cli 一个")}`)
    print(`      ${dim("本地写 TS 插件需要类型时，把它们放进 devDependencies —— 那一段不会被移除")}`)
    print(`      ${dim("要保留原样：yzng update --no-prune")}`)
    print()
  }

  const candidates = await detectPackageManagers(root)
  print(`  ${dim("正在执行")} ${cyan(`${candidates[0]} ${argsOf(candidates[0] ?? "pnpm", `${CLI_PACKAGE}@${spec}`).join(" ")}`)}`)
  print(`  ${dim("冷装依赖可能需要数分钟，请勿中断")}`)

  let used: string
  try {
    used = await runUpdate(candidates, `${CLI_PACKAGE}@${spec}`, root, opts.run ?? execPm)
  } catch (err) {
    print()
    printErr(red(`升级失败：${err instanceof Error ? err.message : String(err)}`))
    if (pruned.length > 0) printErr(dim("package.json 已被改动，重试前无须还原 —— 移除那几条本身是正确的"))
    return 1
  }

  const after = await readInstalled(root)
  const changes = diffVersions(before, after)
  const moved = changes.filter(change => change.before !== change.after)

  print()
  print(`  ${bold(moved.length > 0 ? green("已升级") : "无变化")} ${dim(`由 ${used} 执行`)}`)
  print()
  printChanges(changes)
  print()

  if (moved.length === 0) {
    print(`  ${dim("已是")} ${cyan(spec)} ${dim("对应的版本")}`)
    print()
    return 0
  }

  print(`  ${dim("下一步")} ${cyan("yzng start")}`)
  print(`      ${dim("主目录里指向框架的链接会在启动时按新版本重建，本命令刻意不代做 —— 见模块说明")}`)
  print(`      ${dim("用 TypeScript 写的插件需各自重新编译，否则仍是编译于旧类型、运行于新内核")}`)
  print()
  return 0
}

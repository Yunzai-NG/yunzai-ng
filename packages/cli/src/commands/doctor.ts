/**
 * 模块职责：`yzng doctor` —— 环境自检：运行环境、目录、内核配置、可选原生依赖、端口占用
 * 依赖方向：依赖 @yunzai-ng/core 的公开入口与 node:net
 * 生命周期：一次性，执行完毕即退出
 * 注意事项：**每一项均须给出后续处置方式，否则本命令不具备存在价值。**
 *          一句"Redis 连接失败"不指明该改哪里，等于把排障推回给使用者；故每条不合格项
 *          都附一条可执行的下一步。
 *
 *          退出码：存在 `error` 级问题时为 1，仅有 `warn` 时仍为 0 ——
 *          `yzng doctor && yzng start` 是自然的用法，不应被"尚未配置账号"一类提示阻断。
 */
import net from "node:net"
import process from "node:process"
import { createRequire } from "node:module"
import { constants } from "node:fs"
import { access, readFile } from "node:fs/promises"
import { join } from "node:path"
import { CORE_CONFIG_NAME, coreConfigSchema, detectPlatform, legacyInstance, parseYaml, resolvePaths } from "@yunzai-ng/core"
import { bold, cyan, dim, green, print, printRows, red, yellow } from "../terminal.js"

/** Node 最低版本，与根 package.json 的 engines（>=20.11.0）保持一致 */
const MIN_NODE: readonly [number, number] = [20, 11]

/** 校验失败时最多列几条问题 */
const MAX_ISSUES = 5

/** 一条自检结论 */
export interface Finding {
  /** 严重程度 */
  readonly level: "ok" | "warn" | "error"
  /** 检查项名称 */
  readonly title: string
  /** 结论 */
  readonly detail: string
  /** 不合格时的下一步；合格时省略 */
  readonly next?: string
}

/**
 * 检查 Node 版本
 * @param version 版本号（不带 `v`），缺省为当前进程的
 * @returns 结论
 */
export function checkNode(version: string = process.versions.node): Finding {
  const [major = 0, minor = 0] = version.split(".").map(part => Number.parseInt(part, 10))
  const [needMajor, needMinor] = MIN_NODE
  if (major > needMajor || (major === needMajor && minor >= needMinor)) {
    return { level: "ok", title: "Node 版本", detail: `v${version}` }
  }
  return {
    level: "error",
    title: "Node 版本",
    detail: `v${version}，低于要求的 ${needMajor}.${needMinor}`,
    next: `将 Node 升级至 ${needMajor}.${needMinor} 或更高版本：内核使用了 import.meta.dirname 与原生 ESM 解析`
  }
}

/** 自检要用到的那几项内核配置 */
export interface ServerProbe {
  /** 面板是否启用；关着时不探端口 */
  readonly enable: boolean
  /** 监听地址 */
  readonly host: string
  /** 端口 */
  readonly port: number
}

/**
 * 读内核配置并校验，取出要探测的监听地址
 *
 * 启动时配置写错只记一条 error 并沿用缺省值，使用者多半只看到「面板端口不对」；自检要把原因直接报出来。
 * @param configDir 配置目录
 * @returns 结论（文件不存在时为 undefined：首次启动会按缺省值生成）与监听参数
 */
export async function checkConfig(configDir: string): Promise<{ finding?: Finding; server: ServerProbe }> {
  const file = join(configDir, `${CORE_CONFIG_NAME}.yaml`)
  const defaults = coreConfigSchema.defaults().server
  const fallback = { enable: defaults.enable, host: defaults.host, port: defaults.port }
  const text = await readFile(file, "utf8").catch(() => undefined)
  if (text === undefined) return { server: fallback }

  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch (err) {
    return {
      finding: {
        level: "error",
        title: "内核配置",
        detail: `${cyan(file)} 语法有误：${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
        next: "启动时会整份沿用缺省值，改动全不生效。按提示的行号修正后再启动"
      },
      server: fallback
    }
  }

  const result = coreConfigSchema.safeParse(raw)
  if (!result.ok) {
    const issues = result.issues.filter(issue => issue.severity === "error")
    const shown = issues.slice(0, MAX_ISSUES).map(issue => `${issue.path || "(根)"}：${issue.message}`)
    if (issues.length > MAX_ISSUES) shown.push(`…另有 ${issues.length - MAX_ISSUES} 项`)
    return {
      finding: {
        level: "error",
        title: "内核配置",
        detail: `${cyan(file)} 校验失败：${shown.join("；")}`,
        next: "启动时会整份沿用缺省值，改动全不生效。改正这几项，或在面板的设置页里改"
      },
      server: fallback
    }
  }
  const { enable, host, port } = result.value.server
  return { finding: { level: "ok", title: "内核配置", detail: cyan(file) }, server: { enable, host, port } }
}

/**
 * 检查一个可选原生依赖能否加载
 *
 * **解析基准必须是内核而非 CLI 自身。** pnpm 的隔离式 node_modules 将
 * `classic-level` 安装于 `packages/core/node_modules` 之下，CLI 的模块图中并不含有
 * 该包 —— 自 CLI 自身解析将一律得到"未安装"，而该结论会将使用者引向
 * 一个并不存在的问题（去安装一个实际已安装完毕的包）。
 *
 * 使用 `createRequire` 而非 `await import()`：这两个包均为 CommonJS 原生扩展，
 * 而此处需要区分的是"未安装"与"已安装但 ABI 不匹配"—— 仅 `require` 的报错信息中
 * 携带 `NODE_MODULE_VERSION` 一段，动态 import 会将其重新包装并丢失该细节。
 * @param name 包名
 * @param purpose 该包的用途
 * @param fallback 缺失时的降级说明
 * @returns 结论
 */
function checkNative(name: string, purpose: string, fallback: string): Finding {
  const self = createRequire(import.meta.url)
  let require = self
  try {
    require = createRequire(self.resolve("@yunzai-ng/core/package.json"))
  } catch {
    // 未找到内核时退回自身解析：此情形下 CLI 属于单独安装，
    // 报告"未安装"至少不构成误导，而真正的问题（内核缺失）由其他检查项覆盖
  }
  try {
    require.resolve(name)
  } catch {
    // 它是内核的可选依赖，缺了多半是安装时编译失败（没有预编译包、缺编译工具），不是漏装
    return {
      level: "warn",
      title: name,
      detail: `未安装（${purpose}）`,
      next: `${fallback}。需要时在实例目录重新安装依赖（pnpm install 或 npm install），留意其中 ${name} 的编译报错`
    }
  }
  try {
    require(name)
    return { level: "ok", title: name, detail: `可用（${purpose}）` }
  } catch (err) {
    return {
      level: "warn",
      title: name,
      detail: `已安装但加载失败：${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
      next: `原生模块与当前 Node ABI 不匹配，重建即可解决：pnpm rebuild ${name}。${fallback}`
    }
  }
}

/**
 * 检查目录存在且可写
 * @param label 检查项名称
 * @param dir 路径
 * @returns 结论
 */
async function checkDir(label: string, dir: string): Promise<Finding> {
  try {
    await access(dir)
  } catch {
    return {
      level: "warn",
      title: label,
      detail: `${cyan(dir)} ${dim("尚不存在")}`,
      next: "首次启动时将自动创建；亦可先执行 yzng init"
    }
  }
  try {
    await access(dir, constants.W_OK)
    return { level: "ok", title: label, detail: cyan(dir) }
  } catch {
    return {
      level: "error",
      title: label,
      detail: `${cyan(dir)} 不可写`,
      next: "内核要在这里写配置、数据与日志。换一个当前用户有写权限的目录（--home / YZNG_HOME），或改这个目录的权限"
    }
  }
}

/**
 * 检查端口是否可监听
 *
 * 实际执行一次 bind 而非查询进程列表：其行为跨平台一致，且"能否监听"本身即为
 * 内核关注的问题 —— 端口被同一用户的另一实例占用，与被防火墙策略拦截，
 * 对启动而言结果相同。
 * @param host 监听地址
 * @param port 端口
 * @returns 结论
 */
function checkPort(host: string, port: number): Promise<Finding> {
  return new Promise<Finding>(resolve => {
    const probe = net.createServer()
    probe.once("error", (err: NodeJS.ErrnoException) => {
      resolve({
        level: "error",
        title: "面板端口",
        detail: `${host}:${port} 不可用（${err.code ?? err.message}）`,
        next:
          err.code === "EADDRINUSE"
            ? "该端口已被其他程序占用（通常为另一个 Yunzai 实例）。请修改 config/yunzai.yaml 中的 server.port，或先停止该程序"
            : "请检查监听地址是否属于本机网卡"
      })
    })
    probe.once("listening", () => {
      probe.close(() => resolve({ level: "ok", title: "面板端口", detail: `${host}:${port} 可用` }))
    })
    probe.listen(port, host)
  })
}

/**
 * 输出一条结论
 * @param finding 结论
 */
function printFinding(finding: Finding): void {
  const mark = finding.level === "ok" ? green("✓") : finding.level === "warn" ? yellow("!") : red("✗")
  print(`  ${mark} ${finding.title}  ${finding.detail}`)
  if (finding.next !== undefined) print(`      ${dim(`→ ${finding.next}`)}`)
}

/** 自检参数 */
export interface DoctorOptions {
  /** 应用主目录 */
  readonly home?: string | undefined
  /** 待探测的面板端口；缺省取配置的 `server.port` */
  readonly port?: number | undefined
  /** 待探测的监听地址；缺省取配置的 `server.host` */
  readonly host?: string | undefined
}

/**
 * 检查旧默认位置上是否还留着一个实例
 *
 * 无遗留时**不产出结论**而非产出一条 ok：0.2.0 之后新装的机器永远不会命中这一条，
 * 为它常驻一行「无旧实例」只是噪声。
 *
 * 命中时定为 warn：它不阻碍启动，但「升级之后配置全没了」是这次默认值变更最可能
 * 被当成故障的一幕，自检必须替使用者把它答出来。
 * @param home 本次解析出的主目录
 * @returns 结论；无遗留时 undefined
 */
function checkLegacy(home: string): Finding | undefined {
  const legacy = legacyInstance(home)
  if (legacy === undefined) return undefined
  return {
    level: "warn",
    title: "旧实例",
    detail: `${legacy} 里还留着一个实例`,
    next: "0.2.0 起主目录默认为当前目录。要继续用旧的，设 YZNG_HOME 指向它；要搬过来，把其中内容拷到本次的主目录"
  }
}

/**
 * 执行一次环境自检
 * @param opts 参数
 * @returns 进程退出码；存在 error 级问题时为 1
 */
export async function runDoctor(opts: DoctorOptions = {}): Promise<number> {
  const platform = detectPlatform()
  const paths = resolvePaths({ home: opts.home })

  print()
  print(`  ${bold("环境")}`)
  printRows([
    ["系统", `${platform.os}/${platform.arch}${platform.isTermux ? " · Termux" : ""}${platform.isContainer ? " · 容器" : ""}`],
    ["CPU", `${platform.cpus} 核`]
  ])

  const legacy = checkLegacy(paths.home)
  const config = await checkConfig(paths.config)
  const server = config.server
  // 命令行给了就探命令行的；面板关着且没人指定时不探
  const probePort = opts.port !== undefined || opts.host !== undefined || server.enable
  const findings: Finding[] = [
    checkNode(),
    await checkDir("主目录", paths.home),
    ...(legacy === undefined ? [] : [legacy]),
    await checkDir("配置目录", paths.config),
    await checkDir("数据目录", paths.data),
    ...(config.finding === undefined ? [] : [config.finding]),
    checkNative("classic-level", "内嵌 KV，用于计数与冷却", "缺失时内核降级为 JSON 文件存储，功能不受影响但写入速度较低"),
    checkNative("better-sqlite3", "关系数据，用于插件建表", "缺失时依赖 SQL 的插件将取得一条错误说明，而非静默失效"),
    probePort
      ? await checkPort(opts.host ?? server.host, opts.port ?? server.port)
      : { level: "ok", title: "面板端口", detail: dim("面板已关闭（server.enable: false），不探测") }
  ]

  print()
  print(`  ${bold("检查")}`)
  for (const finding of findings) printFinding(finding)

  const errors = findings.filter(f => f.level === "error").length
  const warns = findings.filter(f => f.level === "warn").length
  print()
  if (errors > 0) print(`  ${red(`${errors} 项需要处理`)}${warns > 0 ? dim(`，${warns} 项提示`) : ""}`)
  else if (warns > 0) print(`  ${yellow(`${warns} 项提示`)}${dim("，不影响启动")}`)
  else print(`  ${green("全部检查项正常")}`)
  print()

  return errors > 0 ? 1 : 0
}

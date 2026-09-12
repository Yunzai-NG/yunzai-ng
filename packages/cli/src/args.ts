/**
 * 模块职责：命令行参数解析
 * 依赖方向：无依赖
 * 生命周期：纯函数
 * 注意事项：手写实现而非引入 commander / yargs。CLI 的参数总计不足十个，
 *          而这两个库各自会引入 10~30 个传递依赖 —— 对一个需在 Termux 上
 *          执行 `pnpm install` 的框架而言，装机体积与安装时长是真实成本。
 *
 *          `--` 之后的内容原样收入 `rest`，不作解析：`yzng plugin new x -- --raw`
 *          这类"将其余参数转交给下游"的场景需要该行为。
 */

/** 解析结果 */
export interface ParsedArgs {
  /** 子命令，未提供时为空串 */
  readonly command: string
  /** 子命令之后的位置参数 */
  readonly positional: readonly string[]
  /** 长短选项；出现但未带值的记为 `true` */
  readonly flags: Readonly<Record<string, string | boolean>>
  /** `--` 之后的原样内容 */
  readonly rest: readonly string[]
}

/** 单字母短选项到长名的映射 */
const SHORT: Readonly<Record<string, string>> = {
  h: "help",
  v: "version",
  d: "debug",
  c: "home"
}

/**
 * 会带值的选项
 *
 * 必须显式列出，不可依据"下一个 token 不似选项即视为其值"推断 —— 该规则会使
 * `yzng --debug start` 中的 `start` 被 `--debug` 并入，子命令因此为空，
 * CLI 转而输出帮助，而使用者无从察觉问题所在。清单之外的选项一律为布尔开关；
 * 确需为其传值时应写 `--新选项=值`，等号形式的优先级恒高于本清单。
 */
const VALUE_FLAGS: ReadonlySet<string> = new Set(["home", "plugins", "port", "host", "to"])

/**
 * 解析 `process.argv.slice(2)`
 * @param argv 参数数组
 * @returns 解析结果
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}
  const rest: string[] = []
  let command = ""

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? ""

    if (token === "--") {
      rest.push(...argv.slice(i + 1))
      break
    }

    if (token.startsWith("--")) {
      const body = token.slice(2)
      const eq = body.indexOf("=")
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1)
        continue
      }
      if (body.startsWith("no-")) {
        flags[body.slice(3)] = false
        continue
      }
      // 仅清单内的选项会消耗下一个 token 作为其值。代价是以横杠开头的值
      // （`--home -x`）须写作 `--home=-x`；该代价换取的是子命令绝不会被误并入
      const next = argv[i + 1]
      if (VALUE_FLAGS.has(body) && next !== undefined && !next.startsWith("-")) {
        flags[body] = next
        i++
      } else {
        flags[body] = true
      }
      continue
    }

    if (token.startsWith("-") && token.length > 1) {
      // 允许 `-dv` 形式的合并写法；合并时仅最后一个字母可能带值
      const letters = [...token.slice(1)]
      for (let k = 0; k < letters.length; k++) {
        const name = SHORT[letters[k] ?? ""] ?? letters[k] ?? ""
        const last = k === letters.length - 1
        const next = argv[i + 1]
        if (last && VALUE_FLAGS.has(name) && next !== undefined && !next.startsWith("-")) {
          flags[name] = next
          i++
        } else {
          flags[name] = true
        }
      }
      continue
    }

    if (command === "") command = token
    else positional.push(token)
  }

  return { command, positional, flags, rest }
}

/**
 * 取字符串选项
 * @param args 解析结果
 * @param name 选项名
 * @returns 值；未提供或仅为布尔开关时 undefined
 */
export function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name]
  return typeof value === "string" && value !== "" ? value : undefined
}

/**
 * 取布尔选项
 * @param args 解析结果
 * @param name 选项名
 * @param fallback 未提供时的取值
 * @returns 布尔值
 */
export function flagBoolean(args: ParsedArgs, name: string, fallback = false): boolean {
  const value = args.flags[name]
  if (value === undefined) return fallback
  if (typeof value === "boolean") return value
  return value !== "false" && value !== "0"
}

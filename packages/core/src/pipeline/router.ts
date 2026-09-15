/**
 * 模块职责：命令注册表与匹配（实现 `CommandSink`）
 * 依赖方向：依赖类型包、plugin/hooks 的登记结构、util/text；不依赖事件实现与适配器
 * 生命周期：随内核创建，随内核销毁；每条注册返回 Disposer，插件卸载即摘除
 * 注意事项：按触发词首字符分桶，一条消息只试同桶的候选，而不是线性匹配全部正则。
 *          桶内按 `priority` 在注册时排好序，故匹配路径上没有 sort 也没有正则编译。
 *          正则模式尽力提取字面前缀（`/^#体力$/` → `#`）也进桶；提取不出的
 *          （`/^\d+/`、带 `m` 或 `i` 标志的字母开头）落入 `#unbucketed`，每条消息都要试。
 */
import type {
  CommandInfo,
  CommandMatch,
  CommandOptions,
  CommandPattern,
  Disposer,
  Logger,
  MessageEvent,
  MessageScene
} from "@yunzai-ng/types"
import type { CommandRegistration, CommandSink } from "../plugin/hooks.js"

/** 缺省优先级 */
const DEFAULT_PRIORITY = 100

/** 正则里不能当字面前缀的字符 */
const REGEX_META = new Set([".", "*", "+", "?", "(", ")", "[", "]", "{", "}", "|", "$", "^"])

/** 会让前一个字符变成"可选"的量词，出现即无法据此分桶 */
const OPTIONAL_QUANTIFIER = new Set(["?", "*"])

/**
 * 一次模式命中的原始结果
 *
 * 与 `CommandMatch` 的区别是不含 `name`/`plugin` —— 那两个来自登记而非模式。
 */
interface PatternHit {
  /** 命中的模式可读形式 */
  pattern: string
  /** 命中的触发词 */
  trigger: string
  /** 触发词之后剩余的文本，已 trim */
  rest: string
  /** 命名捕获组 */
  groups: Readonly<Record<string, string>>
  /** 数字捕获，下标 0 为整体匹配 */
  captures: readonly string[]
}

/** 编译后的单个模式 */
interface CompiledPattern {
  /** 可读形式；字符串模式即其本身，正则取 `source` */
  readonly label: string
  /** 分桶键（触发词首字符）；`undefined` 表示无法分桶 */
  readonly key: string | undefined
  /**
   * 尝试匹配
   * @param text 消息纯文本
   * @returns 命中结果；未命中返回 undefined
   */
  match(text: string): PatternHit | undefined
}

/** 注册表内部条目 */
interface Entry {
  /** 原始登记（可变，插件可能随后追加别名） */
  readonly reg: CommandRegistration
  /** 注册序号，用于同优先级时的稳定排序 */
  readonly seq: number
  /** 编译后的模式 */
  compiled: CompiledPattern[]
}

/** 一条命中的候选 */
export interface RouterCandidate {
  /** 命中的登记 */
  readonly reg: CommandRegistration
  /** 填给 `e.command` 的匹配结果 */
  readonly match: CommandMatch
}

/** 命令路由器构造参数 */
export interface CommandRouterOptions {
  /** 日志器 */
  readonly logger: Logger
  /**
   * 判断某命令是否被用户禁用
   *
   * 由配置层注入而非由路由器自行读取配置：路由器不应知晓配置文件的结构，
   * 而 WebUI 的"停用某命令"开关（阶段四）只需替换该函数即可接入。
   * @param reg 登记内容
   * @returns 是否禁用
   */
  readonly isDisabled?: (reg: CommandRegistration) => boolean
}

/**
 * 取字符串模式的分桶键
 * @param pattern 字符串模式
 * @returns 首字符
 */
function keyOfString(pattern: string): string {
  return [...pattern][0] ?? ""
}

/**
 * 尝试从正则里提取可分桶的字面首字符
 *
 * 只在能证明「命中必然以该字符开头」时才返回，宁可放弃优化也不能漏匹配。放弃的情形：
 * 没有 `^` 锚定、带 `m` 标志（`^` 也匹配行首）、带 `i` 标志且首字符是 ASCII 字母、
 * 首字符是元字符或字符类、首字符后跟可选量词。
 * @param re 正则
 * @returns 分桶键；无法提取时 undefined
 */
function keyOfRegExp(re: RegExp): string | undefined {
  if (re.flags.includes("m")) return undefined

  const src = re.source
  if (!src.startsWith("^")) return undefined

  let literal: string
  let after: number

  const first = src[1]
  if (first === undefined) return undefined

  if (first === "\\") {
    const escaped = src[2]
    if (escaped === undefined) return undefined
    // `\d` / `\w` / `\s` / `\b` 这类是字符类或断言，不是字面量
    if (/[a-zA-Z0-9]/.test(escaped)) return undefined
    literal = escaped
    after = 3
  } else if (REGEX_META.has(first)) {
    return undefined
  } else {
    literal = first
    after = 2
  }

  const next = src[after]
  if (next !== undefined && OPTIONAL_QUANTIFIER.has(next)) return undefined
  // `{0,3}` 也让首字符可选；`{2}` 不会，但区分成本高于收益，一律放弃
  if (next === "{") return undefined

  if (re.flags.includes("i") && /[a-zA-Z]/.test(literal)) return undefined

  return literal
}

/**
 * 去掉正则的有状态标志
 *
 * `g` 与 `y` 会让 `exec` 推进 `lastIndex`，同一个正则对象在第二条消息上从上次结束的
 * 位置开始找，表现为「命令只灵一次」。注册时就消灭掉，并告知插件作者。
 * @param re 原始正则
 * @param label 日志用的命令标识
 * @param logger 日志器
 * @returns 无状态标志的正则
 */
function stripStatefulFlags(re: RegExp, label: string, logger: Logger): RegExp {
  if (!re.flags.includes("g") && !re.flags.includes("y")) return re
  const flags = re.flags.replace(/[gy]/g, "")
  logger.warn(`命令 ${label} 的正则带 g/y 标志，已自动去除：这两个标志会让匹配位置在消息之间残留`)
  return new RegExp(re.source, flags)
}

/**
 * 编译一个模式
 * @param pattern 原始模式
 * @param opts 命令选项（`anywhere` 影响字符串匹配方式）
 * @param label 日志用的命令标识
 * @param logger 日志器
 * @returns 编译结果
 * @throws 字符串模式为空时
 */
function compile(pattern: CommandPattern, opts: CommandOptions, label: string, logger: Logger): CompiledPattern {
  if (typeof pattern === "string") {
    if (pattern === "") throw new Error(`命令 ${label} 的字符串模式不能为空：空串会匹配所有消息`)

    if (opts.anywhere === true) {
      return {
        label: pattern,
        // anywhere 的触发词可以出现在任何位置，首字符判断不成立
        key: undefined,
        match: text => {
          const at = text.indexOf(pattern)
          if (at < 0) return undefined
          return {
            pattern,
            trigger: pattern,
            rest: text.slice(at + pattern.length).trim(),
            groups: {},
            captures: [pattern]
          }
        }
      }
    }

    return {
      label: pattern,
      key: keyOfString(pattern),
      match: text => {
        if (!text.startsWith(pattern)) return undefined
        return {
          pattern,
          trigger: pattern,
          rest: text.slice(pattern.length).trim(),
          groups: {},
          captures: [pattern]
        }
      }
    }
  }

  const re = stripStatefulFlags(pattern, label, logger)
  return {
    label: re.source,
    key: keyOfRegExp(re),
    match: text => {
      const m = re.exec(text)
      if (m === null) return undefined
      const whole = m[0]
      return {
        pattern: re.source,
        trigger: whole,
        rest: text.slice(m.index + whole.length).trim(),
        groups: m.groups ?? {},
        // 捕获组可能不参与匹配（`(a)|(b)`），undefined 统一成空串，
        // 免得插件里到处写 `captures[1] ?? ""`
        captures: Array.from(m, v => v ?? "")
      }
    }
  }
}

/**
 * 比较两个条目的匹配顺序
 * @param a 条目 a
 * @param b 条目 b
 * @returns 排序结果
 */
function byPriority(a: Entry, b: Entry): number {
  const pa = a.reg.options.priority ?? DEFAULT_PRIORITY
  const pb = b.reg.options.priority ?? DEFAULT_PRIORITY
  return pa !== pb ? pa - pb : a.seq - b.seq
}

/**
 * 把一项按序插入已排序数组
 *
 * 排序成本挪到注册时，故匹配路径上一次 sort 都不做。
 * @param list 已排序数组（就地修改）
 * @param entry 待插入条目
 */
function insertSorted(list: Entry[], entry: Entry): void {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    // 断言安全：mid < hi <= length
    if (byPriority(list[mid]!, entry) <= 0) lo = mid + 1
    else hi = mid
  }
  list.splice(lo, 0, entry)
}

/**
 * 判断事件场景是否落在命令声明的范围内
 * @param opts 命令选项
 * @param scene 事件场景
 * @returns 是否允许
 */
function sceneAllowed(opts: CommandOptions, scene: MessageScene): boolean {
  const want = opts.scene
  if (want === undefined) return true
  return Array.isArray(want) ? want.includes(scene) : want === scene
}

/**
 * 命令路由器
 *
 * 既是 `ctx.command()` 的落点（`CommandSink`），也是消息管线的查询入口（`match()`），
 * 还是 WebUI 的数据来源（`list()`）。
 */
export class CommandRouter implements CommandSink {
  /** 日志器 */
  readonly #logger: Logger
  /** 命令禁用判定 */
  readonly #isDisabled: (reg: CommandRegistration) => boolean
  /** 登记 → 条目 */
  readonly #entries = new Map<CommandRegistration, Entry>()
  /** 首字符 → 已排序的条目数组 */
  readonly #buckets = new Map<string, Entry[]>()
  /** 无法分桶、每条消息都要试的条目（已排序） */
  #unbucketed: Entry[] = []
  /** 注册序号发号器 */
  #seq = 0

  /**
   * @param opts 构造参数
   */
  constructor(opts: CommandRouterOptions) {
    this.#logger = opts.logger
    this.#isDisabled = opts.isDisabled ?? (() => false)
  }

  /** 已注册的命令条数 */
  get size(): number {
    return this.#entries.size
  }

  /**
   * 登记一条命令
   *
   * 不抛错：单个模式编译失败只落一条 error 并跳过该模式，其余别名照旧可用。
   * @param reg 登记内容
   * @returns 注销句柄
   */
  register(reg: CommandRegistration): Disposer {
    if (this.#entries.has(reg)) return () => this.#remove(reg)

    const entry: Entry = { reg, seq: this.#seq++, compiled: [] }
    entry.compiled = this.#compileAll(reg)
    this.#entries.set(reg, entry)
    this.#index(entry)

    return () => this.#remove(reg)
  }

  /**
   * 模式变化后重建索引
   *
   * 整条重建而非增量追加：增量要处理「旧键还在不在别的模式里用」的引用计数。
   * @param reg 登记内容
   */
  reindex(reg: CommandRegistration): void {
    const entry = this.#entries.get(reg)
    if (entry === undefined) return
    this.#unindex(entry)
    entry.compiled = this.#compileAll(reg)
    this.#index(entry)
  }

  /**
   * 找出该消息命中的全部命令，按匹配顺序排列
   *
   * 只做模式匹配与零成本的静态过滤（禁用、场景、@我、权限）。冷却是异步的、要写 KV，
   * 且命中后才该计费，故留给 dispatch。
   * @param e 消息事件
   * @returns 候选数组；无命中时为空数组
   */
  match(e: MessageEvent): RouterCandidate[] {
    const candidates = this.#candidates(e.text)
    if (candidates.length === 0) return []

    const out: RouterCandidate[] = []
    for (const entry of candidates) {
      const { reg } = entry
      if (reg.handler === undefined) continue
      if (this.#isDisabled(reg)) continue
      if (!sceneAllowed(reg.options, e.scene)) continue
      // 群聊要求 @ 机器人；私聊天然算"对我说话"
      if (reg.options.atMe === true && e.isGroup && !e.atMe) continue
      if (reg.options.master === true && !e.isMaster) continue
      // 主人不受群管限制：否则主人在自己不是管理员的群里连管理命令都用不了
      if (reg.options.admin === true && !e.isGroupAdmin && !e.isMaster) continue

      for (const pattern of entry.compiled) {
        const hit = pattern.match(e.text)
        if (hit === undefined) continue
        out.push({
          reg,
          match: {
            name: this.#nameOf(entry),
            pattern: hit.pattern,
            trigger: hit.trigger,
            rest: hit.rest,
            groups: hit.groups,
            captures: hit.captures,
            plugin: reg.plugin
          }
        })
        // 同一条命令的多个别名只算一次命中
        break
      }
    }
    return out
  }

  /**
   * 导出全部命令描述
   * @returns 命令描述数组，按匹配顺序
   */
  list(): CommandInfo[] {
    const all = [...this.#entries.values()].sort(byPriority)
    return all.map(entry => {
      const { options: o, plugin } = entry.reg
      const info: CommandInfo = {
        name: this.#nameOf(entry),
        patterns: entry.compiled.map(p => p.label),
        plugin,
        master: o.master === true,
        admin: o.admin === true,
        hidden: o.hidden === true,
        disabled: this.#isDisabled(entry.reg)
      }
      if (o.desc !== undefined) info.desc = o.desc
      if (o.usage !== undefined) info.usage = o.usage
      if (o.group !== undefined) info.group = o.group
      return info
    })
  }

  /**
   * 摘除某插件的全部命令
   *
   * 插件卸载时上下文会逐条调用 Disposer，此处为兜底：若存在未经 ctx 的登记
   *（例如插件 setup 中途抛错），亦不会留下悬空命令。
   * @param plugin 插件名
   * @returns 摘除的条数
   */
  removePlugin(plugin: string): number {
    let n = 0
    for (const reg of [...this.#entries.keys()]) {
      if (reg.plugin === plugin) {
        this.#remove(reg)
        n++
      }
    }
    return n
  }

  /** 清空全部登记 */
  clear(): void {
    this.#entries.clear()
    this.#buckets.clear()
    this.#unbucketed = []
  }

  /**
   * 编译一条登记的全部模式
   * @param reg 登记内容
   * @returns 编译结果数组
   */
  #compileAll(reg: CommandRegistration): CompiledPattern[] {
    const label = `${reg.plugin}:${String(reg.patterns[0] ?? "?")}`
    const out: CompiledPattern[] = []
    for (const p of reg.patterns) {
      try {
        out.push(compile(p, reg.options, label, this.#logger))
      } catch (err) {
        // 一个别名编译失败不该让整条命令消失，其余模式仍然可用
        this.#logger.error(`命令 ${label} 的模式 ${String(p)} 无效：${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (out.length === 0) this.#logger.error(`命令 ${label} 没有任何有效模式，将不会被触发`)
    return out
  }

  /**
   * 取命令展示名
   * @param entry 条目 t
   * @returns 首个模式的可读形式
   */
  #nameOf(entry: Entry): string {
    return entry.compiled[0]?.label ?? String(entry.reg.patterns[0] ?? "?")
  }

  /**
   * 把条目挂进索引
   * @param entry 条目
   */
  #index(entry: Entry): void {
    // 同一条命令的多个模式可能落在同一个桶（`#体力`/`#树脂` 都在 `#`），
    // 用 Set 去重，避免一条命令在桶里出现两次导致重复命中
    const keys = new Set<string>()
    let needsUnbucketed = false
    for (const p of entry.compiled) {
      if (p.key === undefined || p.key === "") needsUnbucketed = true
      else keys.add(p.key)
    }

    for (const key of keys) {
      let bucket = this.#buckets.get(key)
      if (bucket === undefined) {
        bucket = []
        this.#buckets.set(key, bucket)
      }
      insertSorted(bucket, entry)
    }
    if (needsUnbucketed) insertSorted(this.#unbucketed, entry)
  }

  /**
   * 将条目从索引中摘除
   * @param entry 条目
   */
  #unindex(entry: Entry): void {
    for (const [key, bucket] of this.#buckets) {
      const at = bucket.indexOf(entry)
      if (at >= 0) bucket.splice(at, 1)
      if (bucket.length === 0) this.#buckets.delete(key)
    }
    const at = this.#unbucketed.indexOf(entry)
    if (at >= 0) this.#unbucketed.splice(at, 1)
  }

  /**
   * 注销一条登记
   * @param reg 登记内容
   */
  #remove(reg: CommandRegistration): void {
    const entry = this.#entries.get(reg)
    if (entry === undefined) return
    this.#unindex(entry)
    this.#entries.delete(reg)
  }

  /**
   * 取该文本需要试的候选条目（已按匹配顺序排好）
   * @param text 消息纯文本
   * @returns 候选条目数组
   */
  #candidates(text: string): readonly Entry[] {
    const first = [...text][0]
    const bucket = first === undefined ? undefined : this.#buckets.get(first)
    const loose = this.#unbucketed

    // 绝大多数消息走这两条零分配的捷径
    if (bucket === undefined) return loose
    if (loose.length === 0) return bucket

    // 两边都已排序，线性归并即可，不必 concat + sort
    const out: Entry[] = []
    let i = 0
    let j = 0
    while (i < bucket.length && j < loose.length) {
      const a = bucket[i]!
      const b = loose[j]!
      if (a === b) {
        // 一条命令可能同时有可分桶与不可分桶的模式，只保留一次
        out.push(a)
        i++
        j++
      } else if (byPriority(a, b) <= 0) {
        out.push(a)
        i++
      } else {
        out.push(b)
        j++
      }
    }
    while (i < bucket.length) out.push(bucket[i++]!)
    while (j < loose.length) out.push(loose[j++]!)
    return out
  }
}

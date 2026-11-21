/**
 * 模块职责：群范围的命令规则 —— 某个群要不要前缀、哪些插件或命令在那里不响应
 * 依赖方向：只依赖类型包；规则由调用方给，本模块不读配置
 * 生命周期：纯函数与一份按规则对象缓存的索引，随规则对象回收
 * 注意事项：**只管群聊。** 私聊不受前缀与禁用约束：私聊里只有机器人一个对象，没有「误触」可防。
 *          只管提供方插件声明了 `groupRules` 的适配器名下的机器人（分发器那边判），别的机器人在群里照常。
 *
 *          两层规则，群配置优先：规则里**写了的项**整项覆盖全局（前缀选「不要」即本群不要前缀，
 *          单独设禁用而清单留空即本群一个不禁），没写的项沿用全局。合并两份禁用清单看似更贴心，
 *          却让「全局禁了、只在这个群放开」无从表达。
 *
 *          一个群落进几条规则时按四档取：账号与群都对上 → `*` 与群 → 账号与全部群 → `*` 与全部群；
 *          同一档里靠后的优先，面板上「后加的盖住先加的」与之一致。
 *
 *          主人不豁免：在某个群禁了一个插件，主人在那里同样叫不动它 —— 豁免了的话，主人自己
 *          试一下发现「还能用」，会以为禁用没生效。
 */

/** 一套前缀与禁用，规则与规则套餐同形 */
export interface ScopeBody {
  /** 前缀取哪一份：`inherit` 沿用全局 / `custom` 用 `prefix` / `none` 不要前缀 */
  readonly prefixMode: string
  /** `custom` 时的前缀，带上其中任意一个即可 */
  readonly prefix: readonly string[]
  /** 是否单独设禁用；为假时沿用全局 */
  readonly ownDisabled: boolean
  /** `ownDisabled` 为真时的禁用项 */
  readonly disabled: readonly string[]
}

/** 一套起了名字的规则 */
export interface ScopePreset extends ScopeBody {
  /** 名字，规则据此引用 */
  readonly name: string
}

/** 一条群规则，与内核配置 `scope.rules[]` 同形 */
export interface ScopeRule extends ScopeBody {
  /** 机器人账号（平台 id，如 QQ 号）；`*` 表示任意账号 */
  readonly account: string
  /** 群号；空数组表示这个账号的全部群 */
  readonly groups: readonly string[]
  /** 套用的规则套餐名；空串用本条自己的那几项 */
  readonly preset: string
}

/** 全部规则 */
export interface ScopeRules {
  /** 全局前缀，带上其中任意一个即可；空数组即不要前缀 */
  readonly prefix: readonly string[]
  /** 全局禁用的插件或命令，项为 `插件名` 或 `插件名:命令名` */
  readonly disabled: readonly string[]
  /** 规则套餐 */
  readonly presets: readonly ScopePreset[]
  /** 群规则 */
  readonly rules: readonly ScopeRule[]
}

/** 某个群生效的规则 */
export interface ResolvedScope {
  /** 可用的前缀，长的在前；空数组即不要 */
  readonly prefix: readonly string[]
  /** 禁用项 */
  readonly disabled: ReadonlySet<string>
}

/** 「全部群」在索引里的键 */
const ALL = "*"

/** 规则对象 → 索引；配置不变时 `get()` 返回同一个对象，故只建一次 */
const INDEX = new WeakMap<ScopeRules, { rules: Map<string, ScopeRule>; presets: Map<string, ScopePreset> }>()

/**
 * 取规则索引
 * @param rules 全部规则
 * @returns `账号/群` → 规则（同键以后写的为准），与名字 → 套餐
 */
function indexOf(rules: ScopeRules): { rules: Map<string, ScopeRule>; presets: Map<string, ScopePreset> } {
  let index = INDEX.get(rules)
  if (index === undefined) {
    const byKey = new Map<string, ScopeRule>()
    for (const rule of rules.rules) {
      const account = rule.account.trim() || ALL
      const groups = rule.groups.map(g => g.trim()).filter(g => g !== "")
      for (const group of groups.length === 0 ? [ALL] : groups) byKey.set(`${account}/${group}`, rule)
    }
    const presets = new Map<string, ScopePreset>()
    for (const preset of rules.presets) if (preset.name.trim() !== "") presets.set(preset.name.trim(), preset)
    index = { rules: byKey, presets }
    INDEX.set(rules, index)
  }
  return index
}

/**
 * 求某个群生效的规则
 * @param rules 全部规则
 * @param account 收到消息的机器人账号
 * @param group 群号
 * @returns 生效的规则
 */
export function resolveScope(rules: ScopeRules, account: string, group: string): ResolvedScope {
  const index = indexOf(rules)
  const rule =
    index.rules.get(`${account}/${group}`) ??
    index.rules.get(`${ALL}/${group}`) ??
    index.rules.get(`${account}/${ALL}`) ??
    index.rules.get(`${ALL}/${ALL}`)
  // 套餐找不到（删了、改名了）时退回规则自己那几项，不当作「没有规则」
  const body: ScopeBody | undefined = rule === undefined ? undefined : (index.presets.get(rule.preset.trim()) ?? rule)
  let prefix = rules.prefix
  if (body?.prefixMode === "custom") prefix = body.prefix
  else if (body?.prefixMode === "none") prefix = []
  return { prefix: cleanPrefixes(prefix), disabled: new Set(body?.ownDisabled === true ? body.disabled : rules.disabled) }
}

/**
 * 规则是否一条都没设
 *
 * 分发器据此整段跳过：绝大多数部署不用这一项，那时每条消息不该为它多建一个 Set。
 * @param rules 全部规则
 * @returns 是否全空
 */
export function isScopeEmpty(rules: ScopeRules): boolean {
  return cleanPrefixes(rules.prefix).length === 0 && rules.disabled.length === 0 && rules.rules.length === 0
}

/**
 * 一条命令在这个群里是否被禁用
 * @param scope 生效的规则
 * @param plugin 插件名
 * @param command 命令名
 * @returns 是否禁用
 */
export function isScopeDisabled(scope: ResolvedScope, plugin: string, command: string): boolean {
  return scope.disabled.has(plugin) || scope.disabled.has(`${plugin}:${command}`)
}

/**
 * 去掉群前缀
 *
 * 前缀后面的空白一并去掉：`小云 #帮助` 与 `小云#帮助` 都该当作 `#帮助`。几个前缀里取最长的那个对上的，
 * 免得 `云` 与 `小云` 同在时把 `小云#帮助` 剥成 `#帮助` 之外的样子。
 * @param text 消息纯文本
 * @param prefixes 可用的前缀，已按长度降序；空数组即不要
 * @returns 去掉前缀后的文本；要前缀而没带时 undefined
 */
export function stripScopePrefix(text: string, prefixes: readonly string[]): string | undefined {
  if (prefixes.length === 0) return text
  const hit = prefixes.find(p => text.startsWith(p))
  return hit === undefined ? undefined : text.slice(hit.length).trimStart()
}

/**
 * 去空白、去空项、去重，长的在前
 * @param list 前缀
 * @returns 规整后的前缀
 */
function cleanPrefixes(list: readonly string[]): string[] {
  return [...new Set(list.map(p => p.trim()).filter(p => p !== ""))].sort((a, b) => b.length - a.length)
}

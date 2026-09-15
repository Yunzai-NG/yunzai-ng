/**
 * 模块职责：路径表 —— 注册 / 注销 / 按请求路径查找，含参数与通配段
 * 依赖方向：只依赖 `@yunzai-ng/types`；不认识 Fastify，也不认识业务
 * 生命周期：随共享服务器创建；插件卸载时按 Disposer 逐条摘除
 * 注意事项：自己维护一张表而非直接用 Fastify 的路由树，因为 find-my-way 没有删除单条路由的
 *          API，而「插件能装能卸能热重载」是核心不变量 —— 留下一条死路由，第二次注册同一路径
 *          就会 duplicate route 抛错。故服务器只在 Fastify 上注册 catch-all，分发走这张表。
 *          排序在注册时一次算好（`#dynamic` 始终有序），查找路径上没有 sort 与正则编译。
 */
import type { Disposer, HttpMethod } from "@yunzai-ng/types"

/** 全部支持的 HTTP 方法，顺序即 `Allow` 响应头里的顺序 */
export const HTTP_METHODS: readonly HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]

/** 静态段的具体度权重 */
const RANK_STATIC = 3

/** 参数段（`:id`）的具体度权重 */
const RANK_PARAM = 2

/** 通配段（`*rest`）的具体度权重 */
const RANK_WILDCARD = 1

/** 通配段没写名字时的缺省参数名 */
const DEFAULT_WILDCARD_NAME = "*"

/**
 * 判断一个字符串是否是受支持的 HTTP 方法
 * @param value 待判断的值（通常来自 `request.method`）
 * @returns 是否受支持
 */
export function isHttpMethod(value: string): value is HttpMethod {
  return (HTTP_METHODS as readonly string[]).includes(value)
}

/**
 * 解码一个路径段
 *
 * 失败时原样返回而不抛错：畸形的 `%` 转义应当表现为"路由不存在"（404），
 * 而非 500 —— 后者会将每个扫描器的探测请求都记为一条 error 日志。
 * @param raw 原始段
 * @returns 解码后的段
 */
function decodeSegment(raw: string): string {
  if (!raw.includes("%")) return raw
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/**
 * 把路径切成已解码的段数组
 *
 * 先切后解码，顺序不能反：`%2F` 是段内的字面斜杠，先解码会让它变成分隔符，
 * 那就等于把 `..%2F..%2Fetc` 这类穿越尝试翻译成了真正的路径分隔。
 * @param path 路径（可含查询串之前的部分）
 * @returns 已解码的非空段数组
 */
export function splitSegments(path: string): string[] {
  const out: string[] = []
  for (const raw of path.split("/")) {
    if (raw === "" || raw === ".") continue
    out.push(decodeSegment(raw))
  }
  return out
}

/**
 * 归一化一个 URL 模式
 *
 * `scope` 与 `path` 各自可能带或不带首尾斜杠，插件作者两种写法都会用。
 * @param scope URL 前缀，如 `/plugin/mhy-game`
 * @param path 相对 scope 的路径，如 `webhook/:id`
 * @returns 形如 `/plugin/mhy-game/webhook/:id` 的模式；根路径为 `/`
 */
export function joinPattern(scope: string, path: string): string {
  const segs = [...splitRaw(scope), ...splitRaw(path)]
  return segs.length === 0 ? "/" : `/${segs.join("/")}`
}

/**
 * 切分但**不**解码
 *
 * 模式是插件作者手写的，本来就是解码后的形态；对它做 `decodeURIComponent`
 * 会把 `%` 当转义处理，反而改坏了模式。
 * @param path 路径
 * @returns 非空段数组
 */
function splitRaw(path: string): string[] {
  return path.split("/").filter(seg => seg !== "" && seg !== ".")
}

/** 一个已编译的路径段 */
interface PathSegment {
  /** 段类型 */
  readonly kind: "static" | "param" | "wildcard"
  /** 静态段为字面值；参数段与通配段为参数名 */
  readonly value: string
}

/** 表内一项 */
interface Bound<T> {
  /** 归一化后的完整模式 */
  readonly pattern: string
  /** 承载的值（路由处理函数、WebSocket 处理函数、静态目录……） */
  readonly value: T
  /** 编译后的段 */
  readonly segments: readonly PathSegment[]
  /** 各段的具体度权重，用于排序 */
  readonly ranks: readonly number[]
  /** 注册序号，同具体度时保证先注册者优先且顺序稳定 */
  readonly seq: number
}

/** 一次查找命中 */
export interface PathHit<T> {
  /** 命中的模式 */
  readonly pattern: string
  /** 承载的值 */
  readonly value: T
  /** 路径参数；无参数时是同一个空对象 */
  readonly params: Readonly<Record<string, string>>
}

/** 没有参数时共用的空对象，省掉每次请求一次分配 */
const NO_PARAMS: Readonly<Record<string, string>> = Object.freeze({})

/**
 * 编译一个模式
 * @param pattern 已归一化的模式
 * @returns 段数组
 * @throws 参数名为空、或通配段不在末尾时
 */
function compileSegments(pattern: string): PathSegment[] {
  const raw = splitRaw(pattern)
  const out: PathSegment[] = []
  for (let i = 0; i < raw.length; i++) {
    const seg = raw[i]!
    if (seg.startsWith(":")) {
      const name = seg.slice(1)
      if (name === "") throw new Error(`路由模式 ${pattern} 里有一个没写名字的参数段（应形如 /x/:id）`)
      out.push({ kind: "param", value: name })
      continue
    }
    if (seg.startsWith("*")) {
      if (i !== raw.length - 1) {
        throw new Error(`路由模式 ${pattern} 的通配段只能置于末尾：其将匹配后续的全部路径`)
      }
      out.push({ kind: "wildcard", value: seg.slice(1) === "" ? DEFAULT_WILDCARD_NAME : seg.slice(1) })
      continue
    }
    out.push({ kind: "static", value: seg })
  }
  return out
}

/**
 * 取段的具体度权重
 * @param segment 段
 * @returns 权重
 */
function rankOf(segment: PathSegment): number {
  if (segment.kind === "static") return RANK_STATIC
  return segment.kind === "param" ? RANK_PARAM : RANK_WILDCARD
}

/**
 * 比较两项的匹配优先级
 *
 * 逐段比权重：`/api/config` 必须比 `/api/:name` 先试，`/api/:name` 又必须比
 * `/api/*` 先试。前缀相同时段数多者更具体（`/a/b/*` 比 `/a/*` 更具体）。
 * 完全同级时按注册顺序，保证行为可预期。
 * @param a 项 a
 * @param b 项 b
 * @returns 排序结果，负数表示 a 先试
 */
function bySpecificity<T>(a: Bound<T>, b: Bound<T>): number {
  const n = Math.min(a.ranks.length, b.ranks.length)
  for (let i = 0; i < n; i++) {
    const diff = b.ranks[i]! - a.ranks[i]!
    if (diff !== 0) return diff
  }
  if (a.ranks.length !== b.ranks.length) return b.ranks.length - a.ranks.length
  return a.seq - b.seq
}

/**
 * 按已排好的顺序插入
 * @param list 已排序数组（就地修改）
 * @param item 待插入项
 */
function insertSorted<T>(list: Bound<T>[], item: Bound<T>): void {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (bySpecificity(list[mid]!, item) <= 0) lo = mid + 1
    else hi = mid
  }
  list.splice(lo, 0, item)
}

/**
 * 一张路径表
 *
 * 静态模式走 Map 精确命中，其余按具体度顺序线性试。HTTP 路由、WebSocket 路径与
 * 静态挂载三者的查找规则相同，故共用这一个实现，只是承载的 `T` 不同。
 */
export class PathTable<T> {
  /** 无参数模式：路径 → 项 */
  readonly #exact = new Map<string, Bound<T>>()
  /** 含参数或通配的模式，按具体度预排序 */
  #dynamic: Bound<T>[] = []
  /** 注册序号发号器 */
  #seq = 0

  /** 已注册的条数 */
  get size(): number {
    return this.#exact.size + this.#dynamic.length
  }

  /**
   * 注册一条
   * @param pattern 已归一化的模式
   * @param value 承载的值
   * @returns 注销句柄；幂等
   * @throws 模式非法、或同一模式重复注册时
   */
  add(pattern: string, value: T): Disposer {
    if (this.has(pattern)) {
      // 不静默覆盖：两个插件争用同一个路径时，"后者生效"将表现为前者无故失效。
      // 插件的 scope 天然带有插件名，可能冲突的只有同一插件内部的重复注册
      throw new Error(`路径 ${pattern} 已经注册过了。热重载请先执行上一次注册返回的 Disposer`)
    }

    const segments = compileSegments(pattern)
    const item: Bound<T> = {
      pattern,
      value,
      segments,
      ranks: segments.map(rankOf),
      seq: this.#seq++
    }

    if (segments.every(seg => seg.kind === "static")) this.#exact.set(pattern, item)
    else insertSorted(this.#dynamic, item)

    let removed = false
    return () => {
      if (removed) return
      removed = true
      if (this.#exact.get(pattern) === item) this.#exact.delete(pattern)
      const at = this.#dynamic.indexOf(item)
      if (at >= 0) this.#dynamic.splice(at, 1)
    }
  }

  /**
   * 某个模式是否已注册
   * @param pattern 已归一化的模式
   * @returns 是否已注册
   */
  has(pattern: string): boolean {
    return this.#exact.has(pattern) || this.#dynamic.some(item => item.pattern === pattern)
  }

  /**
   * 按已解码的路径段查找
   * @param parts 已解码的路径段（`splitSegments()` 的产物）
   * @returns 命中项；未命中时 undefined
   */
  find(parts: readonly string[]): PathHit<T> | undefined {
    const exact = this.#exact.get(parts.length === 0 ? "/" : `/${parts.join("/")}`)
    if (exact !== undefined) return { pattern: exact.pattern, value: exact.value, params: NO_PARAMS }

    for (const item of this.#dynamic) {
      const params = matchSegments(item.segments, parts)
      if (params !== undefined) return { pattern: item.pattern, value: item.value, params }
    }
    return undefined
  }

  /**
   * 导出全部模式，按匹配顺序
   * @returns 模式数组
   */
  list(): string[] {
    return this.entries().map(item => item.pattern)
  }

  /**
   * 导出全部注册项，按匹配顺序
   *
   * 面板需要展示的是"哪条路由属于哪个插件、是否需要鉴权"，仅有模式字符串不足，
   * 因此连同 `value` 一并给出。
   * @returns 模式与承载值的数组
   */
  entries(): { pattern: string; value: T }[] {
    return [...this.#exact.values(), ...this.#dynamic]
      .sort(bySpecificity)
      .map(item => ({ pattern: item.pattern, value: item.value }))
  }

  /** 清空 */
  clear(): void {
    this.#exact.clear()
    this.#dynamic = []
  }
}

/**
 * 拿一组段去匹配请求路径
 * @param segments 编译后的模式段
 * @param parts 请求路径的段
 * @returns 路径参数；不匹配时 undefined
 */
function matchSegments(
  segments: readonly PathSegment[],
  parts: readonly string[]
): Readonly<Record<string, string>> | undefined {
  const params: Record<string, string> = {}
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!
    if (seg.kind === "wildcard") {
      // 通配段匹配剩余的全部路径，包括"无剩余内容"的情形（`/files/*` 亦匹配 `/files`）
      params[seg.value] = parts.slice(i).join("/")
      return params
    }
    const part = parts[i]
    if (part === undefined) return undefined
    if (seg.kind === "static") {
      if (part !== seg.value) return undefined
      continue
    }
    if (part === "") return undefined
    params[seg.value] = part
  }
  return parts.length === segments.length ? params : undefined
}

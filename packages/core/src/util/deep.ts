/**
 * 模块职责：对象深操作（合并、克隆、按路径读写、差异路径计算）
 * 依赖方向：无
 * 生命周期：纯函数
 * 注意事项：配置系统的地基。`diffPaths` 算出实际变化的叶子路径，故配置变更只通知
 *          关心那些路径的订阅者，而不是让每个读配置的地方全量重算。
 *
 *          **数组是整体替换，不逐元素合并。** 配置里的数组（主人列表、黑名单）语义上是
 *          "一个值"，逐元素合并会让使用者无法删除默认项。
 */

/** 可作为配置节点的普通对象 */
export type PlainObject = Record<string, unknown>

/**
 * 判断是否为普通对象（排除数组、null、Date、Buffer、类实例等）
 * @param value 待判定值
 * @returns 是否为普通对象
 */
export function isPlainObject(value: unknown): value is PlainObject {
  if (value === null || typeof value !== "object") return false
  if (Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value) as object | null
  return proto === Object.prototype || proto === null
}

/**
 * 深克隆
 *
 * 优先用 `structuredClone`（Node 17+ 内置，能处理 Map/Set/Date/循环引用），
 * 遇到函数等不可克隆值时退回浅拷贝语义。
 * @param value 源值
 * @returns 克隆结果
 */
export function deepClone<T>(value: T): T {
  try {
    return structuredClone(value)
  } catch {
    return cloneFallback(value)
  }
}

/**
 * structuredClone 失败时的回退克隆（跳过不可克隆值）
 * @param value 源值
 * @returns 克隆结果
 */
function cloneFallback<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => cloneFallback(item)) as unknown as T
  if (isPlainObject(value)) {
    const out: PlainObject = {}
    for (const [k, v] of Object.entries(value)) out[k] = cloneFallback(v)
    return out as T
  }
  return value
}

/**
 * 深合并：把 `source` 覆盖到 `target` 的副本上
 *
 * - 普通对象递归合并
 * - 数组、`Date` 等整体替换
 * - `source` 中值为 `undefined` 的键被忽略（不会把 target 的值抹成 undefined）
 * @param target 基准值（不被修改）
 * @param source 覆盖值
 * @returns 合并后的新对象
 */
export function deepMerge<T extends PlainObject>(target: T, source: PlainObject | undefined): T {
  if (!source) return deepClone(target)
  const out: PlainObject = deepClone(target) as PlainObject

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    // 拒绝原型链污染：合并的数据可能来自 WebUI 提交的 JSON
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue

    const existing = out[key]
    if (isPlainObject(value) && isPlainObject(existing)) {
      out[key] = deepMerge(existing, value)
    } else {
      out[key] = deepClone(value)
    }
  }
  return out as T
}

/**
 * 深比较
 * @param a 左值
 * @param b 右值
 * @returns 是否深度相等
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, i) => deepEqual(item, b[i]))
  }

  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
  }

  if (typeof a === "object" && typeof b === "object") {
    const ao = a as PlainObject
    const bo = b as PlainObject
    const aKeys = Object.keys(ao)
    const bKeys = Object.keys(bo)
    if (aKeys.length !== bKeys.length) return false
    return aKeys.every(k => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]))
  }

  return false
}

/**
 * 把点分路径切成键数组
 *
 * 支持 `a.b[0].c` 与 `a.b.0.c` 两种写法。
 * @param path 路径字符串
 * @returns 键数组
 */
export function splitPath(path: string): string[] {
  if (path === "") return []
  return path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(seg => seg !== "")
}

/**
 * 按路径取值
 * @param obj 源对象
 * @param path 点分路径；空串返回 obj 本身
 * @returns 值；路径不存在时 undefined
 */
export function getPath(obj: unknown, path: string): unknown {
  const keys = splitPath(path)
  let cur: unknown = obj
  for (const key of keys) {
    if (cur === null || cur === undefined) return undefined
    if (typeof cur !== "object") return undefined
    cur = (cur as PlainObject)[key]
  }
  return cur
}

/**
 * 按路径写值（原地修改）
 *
 * 中间层不存在时自动创建：下一级键是纯数字则建数组，否则建对象。
 * @param obj 目标对象
 * @param path 点分路径
 * @param value 值
 * @throws 当路径为空或中间层是不可写入的标量时
 */
export function setPath(obj: PlainObject, path: string, value: unknown): void {
  const keys = splitPath(path)
  if (keys.length === 0) throw new Error("setPath: 路径不能为空")

  let cur: PlainObject | unknown[] = obj
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new Error(`setPath: 非法路径片段 ${key}`)
    }
    const next = (cur as PlainObject)[key]
    if (isPlainObject(next) || Array.isArray(next)) {
      cur = next as PlainObject | unknown[]
    } else if (next === undefined || next === null) {
      const created: PlainObject | unknown[] = /^\d+$/.test(keys[i + 1]!) ? [] : {}
      ;(cur as PlainObject)[key] = created
      cur = created
    } else {
      throw new Error(`setPath: ${keys.slice(0, i + 1).join(".")} 已是标量，无法继续写入`)
    }
  }

  const last = keys[keys.length - 1]!
  if (last === "__proto__" || last === "constructor" || last === "prototype") {
    throw new Error(`setPath: 非法路径片段 ${last}`)
  }
  ;(cur as PlainObject)[last] = value
}

/**
 * 按路径删除（原地修改）
 * @param obj 目标对象
 * @param path 点分路径
 * @returns 是否确实删掉了什么
 */
export function deletePath(obj: PlainObject, path: string): boolean {
  const keys = splitPath(path)
  if (keys.length === 0) return false

  const parentPath = keys.slice(0, -1).join(".")
  const parent = parentPath === "" ? obj : getPath(obj, parentPath)
  if (parent === null || typeof parent !== "object") return false

  const last = keys[keys.length - 1]!
  if (Array.isArray(parent)) {
    const index = Number(last)
    if (!Number.isInteger(index) || index < 0 || index >= parent.length) return false
    parent.splice(index, 1)
    return true
  }
  if (!Object.prototype.hasOwnProperty.call(parent, last)) return false
  delete (parent as PlainObject)[last]
  return true
}

/**
 * 计算两个对象间发生变化的**叶子路径**
 *
 * 这是细粒度配置失效的核心：改了 `bot.masterQQ` 就只通知订阅
 * `bot.masterQQ`（或其祖先 `bot`）的人，不打扰订阅 `render.*` 的人。
 *
 * 数组视为叶子（整体变化），不下钻元素。
 * @param before 旧值
 * @param after 新值
 * @param prefix 内部递归用的路径前缀
 * @returns 变化路径列表，已去重
 */
export function diffPaths(before: unknown, after: unknown, prefix = ""): string[] {
  if (deepEqual(before, after)) return []

  // 任一侧不是普通对象 → 当前节点整体变化
  if (!isPlainObject(before) || !isPlainObject(after)) {
    return prefix === "" ? [""] : [prefix]
  }

  const out: string[] = []
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const key of keys) {
    const path = prefix === "" ? key : `${prefix}.${key}`
    out.push(...diffPaths(before[key], after[key], path))
  }
  return out
}

/**
 * 判断某条变化路径是否影响到订阅路径
 *
 * 双向前缀匹配：改 `bot` 影响订阅 `bot.masterQQ` 的人（父变子受影响），
 * 改 `bot.masterQQ` 也影响订阅 `bot` 的人（子变父受影响）。
 * @param changed 发生变化的路径
 * @param watched 订阅的路径；空串表示订阅全部
 * @returns 是否受影响
 */
export function pathAffects(changed: string, watched: string): boolean {
  if (watched === "" || changed === "") return true
  if (changed === watched) return true
  return changed.startsWith(`${watched}.`) || watched.startsWith(`${changed}.`)
}

/**
 * 摘出对象里的指定路径，组成新对象
 * @param obj 源对象
 * @param paths 路径列表
 * @returns 只含这些路径的新对象
 */
export function pickPaths(obj: PlainObject, paths: readonly string[]): PlainObject {
  const out: PlainObject = {}
  for (const path of paths) {
    const value = getPath(obj, path)
    if (value !== undefined) setPath(out, path, deepClone(value))
  }
  return out
}

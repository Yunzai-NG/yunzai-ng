/**
 * 模块职责：时长表达式解析
 * 依赖方向：仅依赖类型包
 * 生命周期：纯函数
 * 注意事项：一律写 `"30d"` 而不是 `60 * 60 * 24 * 30`：手工算出来的秒数改一处要通查全部
 *          调用点，而配置文件里也读不出那串数字是多久。
 */
import type { DurationLike } from "@yunzai-ng/types"

/** 各单位对应的毫秒数 */
const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000
}

const DURATION_RE = /^(-?\d+(?:\.\d+)?)(ms|s|m|h|d)$/

/**
 * 判断一个值是否为合法的时长表达式
 *
 * 存在的理由是**边界上要收窄类型**：`DurationLike` 是模板字面量类型（`` `${number}s` `` 一类），
 * 而 HTTP 请求体里来的是任意 `string`，直接赋值编译不过。写在这里而不是各调用点自备一条
 * 正则：判据与 `parseDuration` 必须同一条 —— 分开写的症状是「这个值收下了却解析成兜底值」。
 *
 * 纯数字串（`"5000"`）算合法：`parseDuration` 按毫秒收它，YAML 里读出来的正是这种。
 * @param value 待判断的值
 * @returns 是否可作 `DurationLike` 使用
 */
export function isDurationLike(value: unknown): value is DurationLike {
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value !== "string") return false
  const trimmed = value.trim()
  return /^-?\d+$/.test(trimmed) || DURATION_RE.test(trimmed)
}

/**
 * 把时长表达式解析为毫秒
 * @param value 毫秒数字，或形如 `"5s"` / `"30d"` 的字符串
 * @param fallback 无法解析时返回的默认值，缺省 0
 * @returns 毫秒数
 */
export function parseDuration(value: DurationLike | string | undefined | null, fallback = 0): number {
  if (value === undefined || value === null) return fallback
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback

  const trimmed = value.trim()
  if (trimmed === "") return fallback

  // 纯数字串按毫秒处理，兼容从 YAML 里读到的 "5000"
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed)

  const m = DURATION_RE.exec(trimmed)
  if (!m) return fallback
  const [, num, unit] = m
  return Number(num) * (UNIT_MS[unit as string] ?? 1)
}

/**
 * 把毫秒格式化为人类可读的中文时长
 * @param ms 毫秒数
 * @returns 形如 `"1天2小时3分"` 的字符串；小于 1 秒时返回 `"<1秒"`
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-"
  if (ms < 1000) return "<1秒"

  const d = Math.floor(ms / UNIT_MS.d!)
  const h = Math.floor((ms % UNIT_MS.d!) / UNIT_MS.h!)
  const m = Math.floor((ms % UNIT_MS.h!) / UNIT_MS.m!)
  const s = Math.floor((ms % UNIT_MS.m!) / 1000)

  const parts: string[] = []
  if (d) parts.push(`${d}天`)
  if (h) parts.push(`${h}小时`)
  if (m) parts.push(`${m}分`)
  // 只有在没有更大单位时才显示秒，避免 "1天0小时0分3秒" 这种噪音
  if (s && !d && !h) parts.push(`${s}秒`)
  return parts.join("") || "<1秒"
}

/**
 * 把字节数格式化为可读大小
 * @param bytes 字节数
 * @returns 形如 `"12.34MB"` 的字符串
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "-"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let value = Math.abs(bytes)
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  const sign = bytes < 0 ? "-" : ""
  return `${sign}${i === 0 ? value : value.toFixed(2)}${units[i]}`
}

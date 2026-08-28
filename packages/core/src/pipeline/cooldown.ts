/**
 * 模块职责：命令冷却（CD）的判定与计费
 * 依赖方向：依赖类型包与 util/lru、util/duration
 * 生命周期：随内核创建；纯内存，不落盘
 * 注意事项：**刻意不落盘、不进 Redis**。把 CD 写成 Redis key 会带来两个问题：
 *          没装 Redis 就起不来，且每条命令都要一次网络往返。
 *
 *          CD 的本质是"几秒到几分钟内别重复触发"，重启后清零完全无害
 *          （甚至是用户期望的）。因此用有界的 LRU + TTL 存在内存里：
 *          热路径上零 I/O，且条目数有硬上限，不会像裸 Map 那样无限增长。
 *
 *          主人不受 CD 限制：调试时被自己设的 5 分钟 CD 锁在门外是最没必要的
 *          挫败感。这条是内核的既定行为，不是插件可配项。
 */
import type { CooldownScope, MessageEvent } from "@yunzai-ng/types"
import { LruCache } from "../util/lru.js"
import { formatDuration } from "../util/duration.js"

/** 默认最多同时跟踪多少条冷却记录 */
const DEFAULT_MAX = 20_000

/** 冷却判定结果 */
export type CooldownDecision =
  | {
      /** 可以执行 */
      readonly ok: true
    }
  | {
      /** 处于冷却中 */
      readonly ok: false
      /** 剩余毫秒 */
      readonly remaining: number
    }

/** 冷却存储构造参数 */
export interface CooldownStoreOptions {
  /** 条目上限，缺省 20000 */
  readonly max?: number
}

/**
 * 按作用域构造冷却键
 *
 * `group` 作用域在私聊中退化为 `user`：否则私聊消息不具备 gid，全部私聊用户
 * 将共享同一把锁，成为事实上的全局冷却 —— 该缺陷静默存在，且仅在生产环境暴露。
 * @param plugin 插件名
 * @param command 命令名
 * @param scope 作用域
 * @param e 消息事件
 * @returns 冷却键
 */
export function cooldownKey(plugin: string, command: string, scope: CooldownScope, e: MessageEvent): string {
  const head = `${plugin}/${command}`
  const gid = e.group?.gid
  switch (scope) {
    case "global":
      return `${head}|*`
    case "group":
      return gid === undefined ? `${head}|u:${e.sender.uid}` : `${head}|g:${gid}`
    case "groupUser":
      return gid === undefined ? `${head}|u:${e.sender.uid}` : `${head}|g:${gid}:u:${e.sender.uid}`
    case "user":
      return `${head}|u:${e.sender.uid}`
  }
}

/**
 * 命令冷却存储
 *
 * 判定与计费是**同一个动作**（`hit`）：分成 `check` + `mark` 两步的话，
 * 两次调用之间同一用户的第二条消息就能挤进来，CD 形同虚设。
 */
export class CooldownStore {
  /** 键 → 冷却结束时间点（毫秒） */
  readonly #cache: LruCache<number>

  /**
   * @param opts 构造参数
   */
  constructor(opts: CooldownStoreOptions = {}) {
    // ttl 设 0（不过期）：每个条目在写入时带上自己的 ms，
    // 各命令的 CD 长度不同，用统一 TTL 会算错剩余时间
    this.#cache = new LruCache<number>({ max: opts.max ?? DEFAULT_MAX, ttl: 0 })
  }

  /** 当前跟踪的冷却条目数 */
  get size(): number {
    return this.#cache.size
  }

  /**
   * 判定冷却，未冷却则立即占用
   * @param key 冷却键
   * @param ms 冷却毫秒；`<= 0` 视为不设冷却
   * @returns 判定结果
   */
  hit(key: string, ms: number): CooldownDecision {
    if (ms <= 0) return { ok: true }

    const now = Date.now()
    const until = this.#cache.get(key)
    if (until !== undefined && until > now) return { ok: false, remaining: until - now }

    this.#cache.set(key, now + ms, ms)
    return { ok: true }
  }

  /**
   * 提前解除某条冷却
   *
   * 给"命令执行失败了，不该占用用户的 CD"这种场景用 —— 让用户为一次
   * 接口超时等 5 分钟是不合理的。
   * @param key 冷却键
   */
  reset(key: string): void {
    this.#cache.delete(key)
  }

  /** 清空全部冷却 */
  clear(): void {
    this.#cache.clear()
  }
}

/**
 * 生成冷却提示语
 *
 * 支持 `{time}` 占位符，插件写 `cooldownTip: "冷静一下，还有 {time}"` 即可。
 * @param template 插件配置的提示语模板
 * @param remaining 剩余毫秒
 * @returns 提示文本
 */
export function renderCooldownTip(template: string, remaining: number): string {
  const time = formatDuration(remaining)
  return template.includes("{time}") ? template.replaceAll("{time}", time) : template
}

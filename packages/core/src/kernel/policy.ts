/**
 * 模块职责：内核策略 —— 主人、命令前缀、昵称、维护模式
 * 依赖方向：依赖 config/core-config 与类型包；不依赖任何子系统
 * 生命周期：与应用同寿，无需回收
 * 注意事项：所有取值均**即时读取配置**而不缓存，故改完主人号对下一条消息即生效，不必重启。
 *          `ConfigFile.get()` 在配置未变更时返回同一个对象，故"即时读取"只是一次属性访问。
 *
 *          此处刻意**不做鉴权**：`addMaster` 对任何调用方均开放。凭据校验是入口的职责
 *          （WebUI 经由令牌，命令经由 `isMaster`），策略层仅负责"名单的内容"。
 *          两者混于一层将导致"经由修改配置绕过鉴权"这类漏洞。
 */
import type { PolicyView } from "@yunzai-ng/types"
import type { CoreConfigHandle } from "../config/core-config.js"

/**
 * 内核策略
 *
 * 实现类型包里的 `PolicyView`（适配器与插件只看得到那个只读接口），
 * 另外多给内核自己用的几项：前缀、昵称、维护模式。
 */
export class KernelPolicy implements PolicyView {
  /** 内核配置句柄 */
  readonly #config: CoreConfigHandle

  /**
   * @param config 内核配置句柄
   */
  constructor(config: CoreConfigHandle) {
    this.#config = config
  }

  /** 主人账号列表 */
  get masters(): readonly string[] {
    return this.#config.get().bot.masterQQ
  }

  /**
   * 命令前缀
   *
   * 空数组表示不限制前缀。命令路由据此分桶，见 pipeline 层。
   */
  get prefixes(): readonly string[] {
    return this.#config.get().bot.prefix
  }

  /** 机器人昵称（群里以昵称开头等同于 @ 机器人） */
  get nicknames(): readonly string[] {
    return this.#config.get().bot.nickname
  }

  /** 是否处于维护模式（只响应主人） */
  get maintenance(): boolean {
    return this.#config.get().bot.onlyMaster
  }

  /**
   * 判断是否主人
   *
   * 主人名单为空时一律返回 false —— 不存在"没配主人就人人是主人"的默认，
   * 那会让首次启动的机器人对全世界开放管理命令。
   * @param uid 用户 id
   * @returns 是否主人
   */
  isMaster(uid: string): boolean {
    if (uid === "") return false
    return this.masters.includes(uid)
  }

  /**
   * 判断该用户当前是否应被响应
   *
   * 维护模式下只放行主人。这是**唯一**的全局开关判定点，管线里不要再各自判一次。
   * @param uid 用户 id
   * @returns 是否响应
   */
  canRespond(uid: string): boolean {
    return !this.maintenance || this.isMaster(uid)
  }

  /**
   * 添加主人并落盘
   * @param uid 用户 id（纯数字）
   * @returns 是否真的添加了（已在名单里时 false）
   * @throws SchemaError uid 不是合法 id 时；此时配置与文件都不变
   */
  async addMaster(uid: string): Promise<boolean> {
    const current = this.masters
    if (current.includes(uid)) return false
    // 整个数组一起写：deepMerge 对数组是整体替换而非追加，
    // 只传新增项会把原有主人全冲掉
    await this.#config.patch({ bot: { masterQQ: [...current, uid] } })
    return true
  }

  /**
   * 移除主人并落盘
   * @param uid 用户 id
   * @returns 是否真的移除了
   */
  async removeMaster(uid: string): Promise<boolean> {
    const current = this.masters
    if (!current.includes(uid)) return false
    await this.#config.patch({ bot: { masterQQ: current.filter(id => id !== uid) } })
    return true
  }
}

/**
 * 创建内核策略
 * @param config 内核配置句柄
 * @returns 内核策略
 */
export function createPolicy(config: CoreConfigHandle): KernelPolicy {
  return new KernelPolicy(config)
}

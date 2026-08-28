/**
 * 模块职责：将插件注册的 KV 驱动接入 `KvDriverSink` 接缝
 * 依赖方向：依赖 store/index、plugin/hooks、类型包
 * 生命周期：应用级单例；注销由插件卸载时触发
 * 注意事项：**插件注册的驱动不会立即接管存储**。KV 必须在 `create()` 阶段即开启
 *          （配置、账号、插件状态均需使用它），而插件在其之后方才加载，
 *          因此 `store-redis` 一类插件注册的驱动最早也需下一次启动方能生效。
 *
 *          此项取舍并非规避实现成本：先加载插件再开启存储将导致"插件加载失败时连日志都无处写入"
 *          的循环依赖问题。取舍是明确的 —— 更换驱动需重启一次，
 *          而更换驱动本身即属极低频操作。
 *
 *          因此此处在注册时会**主动比对当前配置**：使用者配置了 `store.driver: redis`
 *          而实际仍运行于 level 之上时，日志中必须出现一句"重启后生效"，
 *          而不应使使用者误认为数据已写入 Redis。
 */
import type { KvDriver, Logger } from "@yunzai-ng/types"
import type { KvDriverSink } from "../plugin/hooks.js"
import { registerKvDriver } from "../store/index.js"

/** 创建 KV 驱动接缝的参数 */
export interface KvDriverSinkOptions {
  /** 日志器 */
  logger: Logger
  /** 取配置里请求的驱动 id（现读，配置可能已被改过） */
  requested: () => string
  /** 当前实际生效的驱动 id */
  active: string
}

/**
 * 创建 KV 驱动接缝
 * @param opts 参数
 * @returns KV 驱动接缝
 */
export function createKvDriverSink(opts: KvDriverSinkOptions): KvDriverSink {
  const logger = opts.logger.child({ scope: "store" })

  return {
    register(driver: KvDriver, owner: string) {
      // 驱动实例转成工厂：openKv 需要的是"给我目录、我造一个"，
      // 而插件手里已经有实例了。忽略 dir 参数是刻意的 ——
      // 目录信息在插件自己构造实例时就已经拿到（ctx.dataDir）
      const undo = registerKvDriver(driver.id, () => driver)
      logger.info(`插件 ${owner} 注册了 KV 驱动 ${driver.id}`)

      const requested = opts.requested()
      if (requested === driver.id && opts.active !== driver.id) {
        logger.warn(
          `配置里的 store.driver 是 ${driver.id}，但本次启动实际使用的是 ${opts.active} ——` +
            `插件注册的驱动要下次启动才能接管存储，现在重启一次即可生效`
        )
      }

      return undo
    }
  }
}

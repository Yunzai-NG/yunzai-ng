/**
 * 模块职责：KV 存储的装配（驱动选择、自动降级、根命名空间）
 * 依赖方向：依赖 store/{kv,memory,json,level}、util/fs、类型包
 * 生命周期：应用级单例，`close()` 时落盘
 * 注意事项：**存储不可用不等于机器人不可用。** `auto` 模式按 level → json → memory 逐级降级，
 *          每次降级记一条 warn 说明原因；最坏退到纯内存（重启丢缓存），但机器人始终能收发消息。
 *
 *          外部注册的驱动（如 store-redis 插件）通过 `registerKvDriver()` 挂进来，
 *          与内置驱动一视同仁 —— 这正是"一切皆可为插件"在存储层的落点。
 */
import { join } from "node:path"
import type { KvDriver, KvNamespace, Logger } from "@yunzai-ng/types"
import { Kv } from "./kv.js"
import { MemoryKvDriver } from "./memory.js"
import { JsonKvDriver } from "./json.js"
import { LevelKvDriver, loadLevel } from "./level.js"

/** 内置驱动 id */
export type BuiltinDriverId = "auto" | "level" | "json" | "memory"

/** 驱动工厂：拿到数据目录，产出一个尚未 open 的驱动 */
export type KvDriverFactory = (dir: string) => Promise<KvDriver> | KvDriver

/** 外部注册的驱动表（插件注册的驱动进这里） */
const externalDrivers = new Map<string, KvDriverFactory>()

/**
 * 注册一个 KV 驱动
 *
 * 供 `store-redis` 这类插件调用；配置里把 `store.driver` 写成同一个 id 即可启用。
 * @param id 驱动 id
 * @param factory 驱动工厂
 * @returns 取消注册
 * @throws id 与内置驱动冲突时
 */
export function registerKvDriver(id: string, factory: KvDriverFactory): () => void {
  if (id === "auto" || id === "level" || id === "json" || id === "memory") {
    throw new Error(`驱动 id ${id} 与内置驱动冲突`)
  }
  externalDrivers.set(id, factory)
  return () => void externalDrivers.delete(id)
}

/** 打开 KV 存储的参数 */
export interface OpenKvOptions {
  /** 数据目录（KV 数据会放在其子目录里） */
  dir: string
  /** 驱动 id，缺省 `auto` */
  driver?: string
  /** 日志器 */
  logger: Logger
}

/** 已打开的 KV 存储 */
export interface KvStore {
  /** 实际生效的驱动 id（`auto` 会被解析为具体驱动） */
  readonly driver: string
  /** 根命名空间 */
  readonly root: KvNamespace
  /**
   * 取一个子命名空间
   * @param name 命名空间名
   * @returns KV 视图
   */
  namespace(name: string): KvNamespace
  /** 关闭并落盘 */
  close(): Promise<void>
}

/**
 * 打开 KV 存储
 *
 * `auto` 的降级顺序：level（性能最优）→ json（纯 JS，Termux 兜底）→ memory。
 * 显式指定驱动时同样会降级，但会将"所指定的驱动为何不可用"记为 warn，
 * 而非静默替换 —— 使用者配置了 redis 却运行于内存驱动之上而不知情是最糟的情形。
 * @param opts 参数
 * @returns 已打开的 KV 存储
 */
export async function openKv(opts: OpenKvOptions): Promise<KvStore> {
  const logger = opts.logger.child({ scope: "store" })
  const requested = opts.driver ?? "auto"
  const chain = resolveChain(requested)

  let driver: KvDriver | undefined
  for (const id of chain) {
    try {
      const candidate = await createDriver(id, opts.dir)
      if (!candidate) {
        logger.warn(`KV 驱动 ${id} 不可用（未安装或未注册），尝试下一个`)
        continue
      }
      await candidate.open()
      driver = candidate
      if (id !== requested && requested !== "auto") {
        logger.warn(`配置指定的 KV 驱动 ${requested} 不可用，已降级为 ${id}`)
      }
      break
    } catch (err) {
      logger.warn(`KV 驱动 ${id} 打开失败，尝试下一个`, err)
    }
  }

  if (!driver) {
    // chain 末尾恒为 memory，理论上到不了这里；留着是为了让失败可诊断而不是空指针
    throw new Error("所有 KV 驱动均不可用")
  }

  logger.info(`KV 存储就绪：驱动 ${driver.id}`)
  const root = new Kv(driver)

  return {
    driver: driver.id,
    root,
    namespace: (name: string) => root.sub(name),
    close: async () => {
      await driver.close()
    }
  }
}

/**
 * 把请求的驱动 id 展开成降级链
 * @param requested 请求的驱动 id
 * @returns 依次尝试的驱动 id 列表，末尾恒为 memory
 */
function resolveChain(requested: string): string[] {
  if (requested === "auto") return ["level", "json", "memory"]
  if (requested === "memory") return ["memory"]
  if (requested === "json") return ["json", "memory"]
  if (requested === "level") return ["level", "json", "memory"]
  // 外部驱动（redis 等）失败后退回内置默认链
  return [requested, "level", "json", "memory"]
}

/**
 * 按 id 造驱动
 * @param id 驱动 id
 * @param dir 数据目录
 * @returns 驱动实例；不可用时 undefined
 */
async function createDriver(id: string, dir: string): Promise<KvDriver | undefined> {
  switch (id) {
    case "memory":
      return new MemoryKvDriver()
    case "json":
      return new JsonKvDriver(join(dir, "kv.json"))
    case "level": {
      const ctor = await loadLevel()
      return ctor ? new LevelKvDriver(join(dir, "kv"), ctor) : undefined
    }
    default: {
      const factory = externalDrivers.get(id)
      return factory ? await factory(dir) : undefined
    }
  }
}

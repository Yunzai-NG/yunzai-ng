/**
 * 模块职责：存储抽象（KV + 关系型）
 * 依赖方向：仅依赖 common.ts
 * 生命周期：纯类型
 * 注意事项：「用什么存」与「存什么」彻底分开：内核默认内嵌 LevelDB，不要求外部 Redis；
 *          存储插件实现同一套 `KvDriver` 即可替换。
 */
import type { DurationLike } from "./common.js"

/** 驱动层落盘的值信封 */
export interface StoredEnvelope {
  /** 实际值（会被 JSON 序列化） */
  v: unknown
  /** 过期时间点（毫秒时间戳），缺省表示永不过期 */
  e?: number
}

/**
 * KV 驱动
 *
 * 一个存储插件只需要实现这几个方法。`incr` 可选：驱动没有原生原子自增时，
 * 内核会退化为"命名空间内串行队列 + 读改写"，语义仍然正确。
 */
export interface KvDriver {
  /** 驱动 id，用于配置里指定 */
  readonly id: string

  /** 打开连接/文件句柄 */
  open(): Promise<void>
  /** 关闭并 flush */
  close(): Promise<void>

  /**
   * 读取
   * @param key 完整键（已含命名空间前缀）
   * @returns 值信封，不存在时为 undefined
   */
  get(key: string): Promise<StoredEnvelope | undefined>

  /**
   * 写入
   * @param key 完整键
   * @param value 值信封
   */
  set(key: string, value: StoredEnvelope): Promise<void>

  /**
   * 删除
   * @param key 完整键
   */
  del(key: string): Promise<void>

  /**
   * 批量写入/删除，用于减少事务开销
   * @param ops 操作列表
   */
  batch?(ops: KvBatchOp[]): Promise<void>

  /**
   * 按前缀顺序扫描
   * @param prefix 键前缀
   * @returns 键值对的异步迭代器
   */
  scan(prefix: string): AsyncIterableIterator<readonly [string, StoredEnvelope]>

  /**
   * 原生原子自增（可选）
   * @param key 完整键
   * @param by 增量
   * @param expireAt 过期时间点（毫秒时间戳）
   * @returns 自增后的值
   */
  incr?(key: string, by: number, expireAt?: number): Promise<number>
}

/** 批量操作项 */
export type KvBatchOp =
  | {
      /** 写入 */
      op: "set"
      /** 完整键 */
      key: string
      /** 值信封 */
      value: StoredEnvelope
    }
  | {
      /** 删除 */
      op: "del"
      /** 完整键 */
      key: string
    }

/** 写入选项 */
export interface KvSetOptions {
  /** 存活时长，到期自动视为不存在 */
  ttl?: DurationLike
}

/**
 * 命名空间化的 KV 视图
 *
 * 每个插件取得的 `ctx.kv` 已绑定 `plugin:<name>:` 前缀，插件之间不会相互覆写键。
 */
export interface KvNamespace {
  /** 本命名空间的键前缀（只读，便于调试） */
  readonly prefix: string

  /**
   * 读取
   * @param key 命名空间内的键
   * @returns 值，不存在或已过期时为 undefined
   */
  get<T = unknown>(key: string): Promise<T | undefined>

  /**
   * 读取，不存在时返回默认值
   * @param key 命名空间内的键
   * @param fallback 默认值
   * @returns 值或默认值
   */
  getOr<T>(key: string, fallback: T): Promise<T>

  /**
   * 写入
   * @param key 命名空间内的键
   * @param value 值，必须可 JSON 序列化
   * @param opts 写入选项
   */
  set<T = unknown>(key: string, value: T, opts?: KvSetOptions): Promise<void>

  /**
   * 删除
   * @param key 命名空间内的键
   */
  del(key: string): Promise<void>

  /**
   * 判断是否存在
   * @param key 命名空间内的键
   * @returns 是否存在且未过期
   */
  has(key: string): Promise<boolean>

  /**
   * 原子自增，用于消息计数、CD 等
   * @param key 命名空间内的键
   * @param by 增量，默认 1
   * @param opts 写入选项（首次创建时生效的 ttl）
   * @returns 自增后的值
   */
  incr(key: string, by?: number, opts?: KvSetOptions): Promise<number>

  /**
   * 读取剩余存活毫秒数
   * @param key 命名空间内的键
   * @returns 剩余毫秒；永不过期返回 Infinity；不存在返回 -1
   */
  ttl(key: string): Promise<number>

  /**
   * 遍历键
   * @param prefix 命名空间内的额外前缀
   * @returns 键的异步迭代器（不含命名空间前缀）
   */
  keys(prefix?: string): AsyncIterableIterator<string>

  /**
   * 遍历键值
   * @param prefix 命名空间内的额外前缀
   * @returns 键值对的异步迭代器
   */
  entries<T = unknown>(prefix?: string): AsyncIterableIterator<readonly [string, T]>

  /**
   * 清空（可按前缀）
   * @param prefix 命名空间内的额外前缀，省略则清空整个命名空间
   * @returns 删除的键数量
   */
  clear(prefix?: string): Promise<number>

  /**
   * 派生子命名空间
   * @param name 子命名空间名
   * @returns 新的 KV 视图
   */
  sub(name: string): KvNamespace
}

/** SQL 查询的参数 */
export type SqlParam = string | number | bigint | boolean | null | Uint8Array

/**
 * 关系型存储句柄
 *
 * 只暴露最小面：抽卡记录、角色面板这类「多行 + 需要索引」的数据用它，其余一律用 KV。
 * **不引 ORM** —— 用得到的能力不足其 5%，而代价是一大坨依赖与启动开销。
 */
export interface SqlHandle {
  /**
   * 执行不返回行的语句
   * @param sql SQL 文本
   * @param params 绑定参数
   * @returns 受影响行数与最后插入 id
   */
  run(sql: string, params?: SqlParam[]): Promise<{ changes: number; lastInsertRowid: number | bigint }>

  /**
   * 查询多行
   * @param sql SQL 文本
   * @param params 绑定参数
   * @returns 结果行数组
   */
  all<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T[]>

  /**
   * 查询首行
   * @param sql SQL 文本
   * @param params 绑定参数
   * @returns 首行，无结果时 undefined
   */
  get<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T | undefined>

  /**
   * 在事务中执行
   * @param fn 事务体，抛错即回滚
   * @returns 事务体的返回值
   */
  transaction<T>(fn: (tx: SqlHandle) => Promise<T>): Promise<T>

  /**
   * 应用迁移脚本
   *
   * 内核按 `version` 记录已执行到哪一步，重复调用幂等。
   * @param migrations 迁移列表，按 version 升序
   */
  migrate(migrations: SqlMigration[]): Promise<void>
}

/** 一条迁移 */
export interface SqlMigration {
  /** 版本号，同一 SqlHandle 内必须严格递增 */
  version: number
  /** 说明 */
  name: string
  /** 迁移体 */
  up(tx: SqlHandle): Promise<void>
}

/**
 * 模块职责：id 生成与哈希
 * 依赖方向：仅依赖 node:crypto
 * 生命周期：纯函数
 * 注意事项：事件 id 采用"时间前缀 + 随机后缀"而非纯 uuid —— 排障时可直接
 *          按时间排序，且在日志中可直接辨识所属批次。
 *          刻意不引入 nanoid：一个 60 行的功能不值得增加一个依赖，在
 *          Termux 上安装依赖时尤为如此。
 */
import { createHash, randomBytes, randomUUID } from "node:crypto"

/** id 字符表：去掉了易混淆的 0/O/1/l/I */
const ALPHABET = "23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ"

/**
 * 生成随机字符串
 * @param size 长度，缺省 12
 * @returns 随机 id
 */
export function randomId(size = 12): string {
  const bytes = randomBytes(size)
  let out = ""
  for (let i = 0; i < size; i++) {
    // 取模引入的偏差在 56/256 上可忽略；这里不用于密码学场景
    out += ALPHABET[bytes[i]! % ALPHABET.length]
  }
  return out
}

/**
 * 生成事件 id
 *
 * 形如 `"m9x2k1qa-7Kd3"`：前段是 36 进制毫秒时间戳，后段随机。
 * @param prefix 可选前缀，如 `"evt"`
 * @returns 事件 id
 */
export function createEventId(prefix?: string): string {
  const stamp = Date.now().toString(36)
  const tail = randomId(4)
  return prefix ? `${prefix}-${stamp}-${tail}` : `${stamp}-${tail}`
}

/**
 * 生成 UUID v4
 * @returns 标准 uuid 字符串
 */
export function uuid(): string {
  return randomUUID()
}

/**
 * 单调递增的自增 id 工厂
 *
 * 用于适配器的 `echo` 序号等只需进程内唯一的场景，比随机串更省。
 * @param prefix 前缀
 * @returns 每次调用返回下一个 id
 */
export function createSeqFactory(prefix = ""): () => string {
  let seq = 0
  // 加一个进程内随机段，避免重启后与对端残留的旧 echo 撞号
  const salt = randomId(4)
  return () => `${prefix}${salt}${(++seq).toString(36)}`
}

/**
 * 计算字符串的 sha256 十六进制摘要
 * @param input 输入
 * @param length 截断长度，缺省完整 64 位
 * @returns 十六进制摘要
 */
export function sha256(input: string, length?: number): string {
  const hex = createHash("sha256").update(input, "utf8").digest("hex")
  return length ? hex.slice(0, length) : hex
}

/**
 * 计算字符串的 md5 十六进制摘要
 *
 * 仅用于兼容米游社等平台的签名算法，**不要用于任何安全用途**。
 * @param input 输入
 * @returns 十六进制摘要
 */
export function md5(input: string): string {
  return createHash("md5").update(input, "utf8").digest("hex")
}

/**
 * 稳定的短哈希，用于给任意字符串生成缓存键
 * @param input 输入
 * @returns 12 位十六进制
 */
export function shortHash(input: string): string {
  return sha256(input, 12)
}

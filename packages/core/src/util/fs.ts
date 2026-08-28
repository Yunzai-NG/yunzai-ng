/**
 * 模块职责：文件系统助手（原子写、目录保证、路径越界防护）
 * 依赖方向：仅依赖 node:fs / node:path 与 util/defer
 * 生命周期：纯函数
 * 注意事项：**原子写是必需品**，一律走"写临时文件 → rename"。直接 `writeFileSync` 时，
 *          进程恰在此刻被杀（Windows 关窗口、安卓被系统回收）会留下一个截断的配置文件，
 *          下次启动即崩。
 *
 *          Windows 上 rename 会因杀软/资源管理器短暂占用而抛 EPERM
 *          （本项目 pnpm install 就撞过一次），所以带退避重试。
 */
import { constants as fsConstants } from "node:fs"
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile
} from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { randomId } from "./id.js"
import { sleep } from "./defer.js"

/** rename 遇到占用类错误时的重试次数 */
const RENAME_RETRIES = 5

/** 判定为"临时占用、可重试"的错误码 */
const TRANSIENT_CODES = new Set(["EPERM", "EACCES", "EBUSY"])

/**
 * 从未知错误里取出 errno code
 * @param err 错误
 * @returns 错误码，取不到时 undefined
 */
export function errorCode(err: unknown): string | undefined {
  if (err !== null && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code
    if (typeof code === "string") return code
  }
  return undefined
}

/**
 * 路径是否存在
 * @param path 路径
 * @returns 是否存在
 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 是否是目录
 * @param path 路径
 * @returns 是目录则 true；不存在或不是目录则 false
 */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * 是否是文件
 * @param path 路径
 * @returns 是文件则 true
 */
export async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * 确保目录存在
 * @param path 目录路径
 * @returns 目录路径本身，便于链式使用
 */
export async function ensureDir(path: string): Promise<string> {
  await mkdir(path, { recursive: true })
  return path
}

/**
 * 带重试的 rename
 *
 * Windows 下杀软扫描、编辑器索引会短暂锁住新建文件，导致 rename 抛 EPERM。
 * 这类错误重试即可，不该让一次配置保存失败。
 * @param from 源路径
 * @param to 目标路径
 * @throws 重试用尽后抛出最后一次错误
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (err) {
      const code = errorCode(err)
      if (attempt >= RENAME_RETRIES || !code || !TRANSIENT_CODES.has(code)) throw err
      await sleep(20 * attempt)
    }
  }
}

/**
 * 原子写文件
 *
 * 先写同目录下的 `.tmp-*` 文件再 rename 覆盖 —— 同目录是关键，
 * 跨分区 rename 不是原子操作。
 * @param path 目标文件路径
 * @param data 内容
 * @throws 写入或替换失败时抛出；此时原文件保持不变
 */
export async function atomicWrite(path: string, data: string | Uint8Array): Promise<void> {
  const dir = dirname(path)
  await ensureDir(dir)
  const tmp = join(dir, `.tmp-${randomId(8)}`)
  try {
    await writeFile(tmp, data)
    await renameWithRetry(tmp, path)
  } catch (err) {
    // 清理临时文件，失败也不掩盖原始错误
    await unlink(tmp).catch(() => undefined)
    throw err
  }
}

/**
 * 读文本文件
 * @param path 路径
 * @returns 文件内容；不存在时 undefined
 * @throws 除"不存在"以外的读取错误
 */
export async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8")
  } catch (err) {
    if (errorCode(err) === "ENOENT") return undefined
    throw err
  }
}

/**
 * 读 JSON 文件
 * @param path 路径
 * @returns 解析结果；文件不存在时 undefined
 * @throws JSON 解析失败时抛出，错误信息带上文件路径
 */
export async function readJson<T = unknown>(path: string): Promise<T | undefined> {
  const text = await readText(path)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text) as T
  } catch (err) {
    throw new Error(`解析 JSON 失败：${path} —— ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * 原子写 JSON 文件
 * @param path 路径
 * @param value 数据
 * @param pretty 是否缩进，缺省 true（配置类文件要能手改）
 */
export async function writeJson(path: string, value: unknown, pretty = true): Promise<void> {
  await atomicWrite(path, JSON.stringify(value, null, pretty ? 2 : undefined))
}

/**
 * 列出目录下的子目录名
 * @param path 目录路径
 * @returns 子目录名数组；目录不存在时空数组
 */
export async function listDirs(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries.filter(e => e.isDirectory()).map(e => e.name)
  } catch (err) {
    if (errorCode(err) === "ENOENT") return []
    throw err
  }
}

/**
 * 列出目录下的文件名
 * @param path 目录路径
 * @param ext 可选扩展名过滤，如 `".yaml"`
 * @returns 文件名数组；目录不存在时空数组
 */
export async function listFiles(path: string, ext?: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    const files = entries.filter(e => e.isFile()).map(e => e.name)
    return ext ? files.filter(name => name.endsWith(ext)) : files
  } catch (err) {
    if (errorCode(err) === "ENOENT") return []
    throw err
  }
}

/**
 * 删除文件或目录（不存在时静默）
 * @param path 路径
 */
export async function remove(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

/**
 * 取文件修改时间
 * @param path 路径
 * @returns 毫秒时间戳；文件不存在时 undefined
 */
export async function mtimeOf(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return undefined
  }
}

/**
 * 取文件大小
 * @param path 路径
 * @returns 字节数；文件不存在时 undefined
 */
export async function sizeOf(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size
  } catch {
    return undefined
  }
}

/**
 * 在根目录内安全拼接路径，阻止 `../` 越界
 *
 * WebUI 的静态资源、插件模板资源都要按外部传入的相对路径取文件，
 * 不做这层校验就是任意文件读取漏洞。
 * @param root 允许访问的根目录
 * @param requested 外部传入的相对路径
 * @returns 解析后的绝对路径
 * @throws 当结果落在 root 之外，或传入了绝对路径时
 */
export function safeJoin(root: string, requested: string): string {
  if (isAbsolute(requested)) throw new Error(`路径越界：不接受绝对路径 ${requested}`)
  const rootAbs = resolve(root)
  const target = resolve(rootAbs, requested)
  const rel = relative(rootAbs, target)
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`路径越界：${requested}`)
  }
  return target
}

/**
 * 判断路径是否在某目录内
 * @param root 根目录
 * @param target 待判定路径
 * @returns 是否在根目录内（含自身）
 */
export function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
}

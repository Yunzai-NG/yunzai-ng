/**
 * 模块职责：tar.gz 解包 —— 把内存中的归档解到目标目录，并在解包阶段执行路径与体积校验
 * 依赖方向：仅依赖 node 标准库与 `util/fs` 的越界校验；不认识插件市场，也不发起网络请求
 * 生命周期：纯函数，无状态
 * 注意事项：该实现不引入第三方解包库。插件市场需要在 Windows 与 Termux 上以相同方式
 *          解包 GitHub 归档，而现有的 tar 实现均带原生模块或较大的依赖树；
 *          归档格式本身只有 512 字节定长头部一种结构，自行解析的成本低于引入依赖。
 *
 *          解包被视为处理不可信输入。三项校验在写盘之前完成：
 *          1) 每个条目的目标路径经 `safeJoin` 求值，越出目标目录即丢弃该条目；
 *          2) 符号链接与硬链接条目一律丢弃 —— 归档可借链接把后续写入导向目录之外，
 *             而插件分发不需要链接；
 *          3) 解包后总字节数与条目数均设上限，避免高压缩比归档耗尽磁盘。
 */
import { gunzipSync, gzipSync } from "node:zlib"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { safeJoin } from "../util/fs.js"

/** tar 块大小 */
const BLOCK = 512

/** 头部各字段的偏移与长度 */
const FIELD = {
  name: [0, 100],
  size: [124, 12],
  typeflag: [156, 1],
  prefix: [345, 155]
} as const

/** 解包后总字节数的缺省上限 */
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024

/** 条目数的缺省上限 */
const DEFAULT_MAX_ENTRIES = 20_000

/** 解包选项 */
export interface ExtractOptions {
  /** 剥离前若干层路径，GitHub 归档带一层仓库名目录，取 1 */
  readonly strip?: number
  /** 解包后总字节上限，超出即抛错 */
  readonly maxBytes?: number
  /** 条目数上限，超出即抛错 */
  readonly maxEntries?: number
}

/** 一个已解析的条目头部 */
interface TarHeader {
  /** 归档内路径 */
  readonly path: string
  /** 内容字节数 */
  readonly size: number
  /** 类型标记 */
  readonly type: string
}

/**
 * 按 NUL 截断并去除首尾空白
 * @param buf 归档缓冲
 * @param offset 起始偏移
 * @param length 字段长度
 * @returns 字段文本
 */
function textAt(buf: Uint8Array, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length)
  const end = slice.indexOf(0)
  return Buffer.from(end === -1 ? slice : slice.subarray(0, end))
    .toString("utf8")
    .trim()
}

/**
 * 读取一个八进制数值字段
 *
 * 体积字段在超过 8GiB 时会改用 base-256 编码（首字节最高位置 1）。插件归档不会
 * 触及该量级，因此这里遇到 base-256 直接判为非法，而不是实现一段无从验证的分支。
 * @param buf 归档缓冲
 * @param offset 起始偏移
 * @param length 字段长度
 * @returns 数值
 * @throws 字段为 base-256 编码或不是合法八进制时
 */
function octalAt(buf: Uint8Array, offset: number, length: number): number {
  const first = buf[offset] ?? 0
  if ((first & 0x80) !== 0) throw new Error("归档使用了 base-256 数值字段，超出支持范围")
  const text = textAt(buf, offset, length)
  if (text === "") return 0
  const value = Number.parseInt(text, 8)
  if (!Number.isFinite(value) || value < 0) throw new Error(`归档头部的数值字段非法：${text}`)
  return value
}

/**
 * 判断一个块是否全为零字节
 * @param buf 归档缓冲
 * @param offset 块起始偏移
 * @returns 是否为结束块
 */
function isZeroBlock(buf: Uint8Array, offset: number): boolean {
  for (let i = offset; i < offset + BLOCK; i++) if (buf[i] !== 0) return false
  return true
}

/**
 * 解析一个头部块
 * @param buf 归档缓冲
 * @param offset 块起始偏移
 * @returns 头部信息
 */
function readHeader(buf: Uint8Array, offset: number): TarHeader {
  const name = textAt(buf, offset + FIELD.name[0], FIELD.name[1])
  const prefix = textAt(buf, offset + FIELD.prefix[0], FIELD.prefix[1])
  return {
    path: prefix === "" ? name : `${prefix}/${name}`,
    size: octalAt(buf, offset + FIELD.size[0], FIELD.size[1]),
    type: textAt(buf, offset + FIELD.typeflag[0], FIELD.typeflag[1]) || "0"
  }
}

/**
 * 从 pax 扩展头部中取出 `path` 记录
 *
 * 记录格式为 `长度 键=值\n`，长度含自身。仅取 `path`，其余记录（权限、时间）
 * 与插件分发无关。
 * @param block 扩展头部的内容
 * @returns 路径；未声明时 undefined
 */
function paxPath(block: Uint8Array): string | undefined {
  const text = Buffer.from(block).toString("utf8")
  const match = /\d+ path=([^\n]*)\n/.exec(text)
  return match?.[1]
}

/**
 * 剥离路径的前若干层
 * @param path 归档内路径
 * @param strip 剥离层数
 * @returns 剥离后的相对路径；剥空时为空串
 */
function stripPath(path: string, strip: number): string {
  if (strip <= 0) return path
  const parts = path.split("/").filter(part => part !== "")
  return parts.slice(strip).join("/")
}

/**
 * 把归档条目写入目标目录
 *
 * 目标目录会被按需创建。返回值为实际写入的相对路径列表，供调用方在日志中说明
 * 安装内容，也便于单元测试断言。
 * @param archive gzip 压缩后的 tar 归档
 * @param dest 目标目录绝对路径
 * @param opts 解包选项
 * @returns 实际写入的相对路径列表
 * @throws 归档结构非法、超出体积或条目上限时
 */
export async function extractTarGz(archive: Uint8Array, dest: string, opts: ExtractOptions = {}): Promise<string[]> {
  const buf = gunzipSync(archive)
  const strip = opts.strip ?? 0
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES

  const written: string[] = []
  let total = 0
  let entries = 0
  /** 由 pax 或 GNU 长名头部预告的下一条目路径 */
  let pendingPath: string | undefined
  let offset = 0

  while (offset + BLOCK <= buf.length) {
    if (isZeroBlock(buf, offset)) break

    const header = readHeader(buf, offset)
    offset += BLOCK
    const contentBlocks = Math.ceil(header.size / BLOCK)
    const content = buf.subarray(offset, offset + header.size)
    offset += contentBlocks * BLOCK

    // 扩展头部本身不落盘，只影响下一个条目的路径
    if (header.type === "x" || header.type === "X") {
      pendingPath = paxPath(content)
      continue
    }
    if (header.type === "L") {
      pendingPath = Buffer.from(content).toString("utf8").replace(/\0+$/, "")
      continue
    }
    // 全局头部与链接条目一律丢弃，理由见文件头
    if (header.type === "g" || header.type === "1" || header.type === "2") {
      pendingPath = undefined
      continue
    }

    const rawPath = pendingPath ?? header.path
    pendingPath = undefined
    const rel = stripPath(rawPath, strip)
    if (rel === "") continue

    if (++entries > maxEntries) throw new Error(`归档条目数超过上限 ${maxEntries}`)
    total += header.size
    if (total > maxBytes) throw new Error(`归档解包后体积超过上限 ${maxBytes} 字节`)

    let target: string
    try {
      target = safeJoin(dest, rel)
    } catch {
      // 越界条目直接跳过：归档由第三方提供，不应因其内容异常而中断整次安装，
      // 但也绝不能按其要求写到目标目录之外
      continue
    }

    if (header.type === "5") {
      await mkdir(target, { recursive: true })
      continue
    }
    if (header.type !== "0") continue

    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
    written.push(rel)
  }

  return written
}

/**
 * 判断目录内是否只有一个顶层目录
 *
 * GitHub 的归档统一带一层 `仓库名-提交号/` 包装，而用户自建的归档可能没有。
 * 调用方据此决定 `strip` 取 0 还是 1。
 * @param paths 归档内的相对路径列表
 * @returns 唯一的顶层目录名；不唯一或存在顶层文件时 undefined
 */
export function singleRoot(paths: readonly string[]): string | undefined {
  const roots = new Set<string>()
  for (const path of paths) {
    const first = path.split("/")[0] ?? ""
    if (first === path) return undefined
    roots.add(first)
  }
  return roots.size === 1 ? [...roots][0] : undefined
}

/**
 * 拼一个位于目标目录内的路径，越界时抛错
 *
 * 供插件市场在删除前复核目标路径，语义与解包阶段一致。
 * @param base 基准目录
 * @param name 名称
 * @returns 绝对路径
 * @throws 越界时
 */
export function joinWithin(base: string, name: string): string {
  return safeJoin(base, name)
}

/** 供测试与调用方复用的块大小 */
export const TAR_BLOCK_SIZE = BLOCK

/**
 * 构造一个 tar 头部块
 *
 * 该函数只在测试与自建归档时使用；生产路径只解包不打包。之所以放在本文件而不是
 * 测试文件里，是为了让头部字段的偏移只有一份定义 —— 打包与解包共用 `FIELD`，
 * 偏移写错时两侧同时失败，不会出现"测试自己造的归档能解、真实归档不能解"。
 * @param path 条目路径
 * @param size 内容字节数
 * @param type 类型标记
 * @returns 512 字节头部
 */
export function buildTarHeader(path: string, size: number, type: string): Buffer {
  const block = Buffer.alloc(BLOCK)
  block.write(path.slice(0, FIELD.name[1]), FIELD.name[0], "utf8")
  block.write(`${size.toString(8).padStart(11, "0")}\0`, FIELD.size[0], "ascii")
  block.write("0000644\0", 100, "ascii")
  block.write("0000000\0", 108, "ascii")
  block.write("0000000\0", 116, "ascii")
  block.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, "0")}\0`, 136, "ascii")
  block.write(type, FIELD.typeflag[0], "ascii")
  block.write("ustar\0" + "00", 257, "ascii")
  // 校验和字段先填空格再求和，这是格式规定的计算方式
  block.write("        ", 148, "ascii")
  let sum = 0
  for (const byte of block) sum += byte
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii")
  return block
}

/**
 * 把若干文件打成 gzip 压缩的 tar 归档
 * @param files 条目列表，路径使用正斜杠
 * @returns 压缩后的归档
 */
export function buildTarGz(files: readonly { path: string; content: string | Uint8Array; type?: string }[]): Buffer {
  const parts: Buffer[] = []
  for (const file of files) {
    const content = typeof file.content === "string" ? Buffer.from(file.content, "utf8") : Buffer.from(file.content)
    const type = file.type ?? "0"
    parts.push(buildTarHeader(file.path, type === "5" ? 0 : content.length, type))
    if (type !== "5" && content.length > 0) {
      const padded = Buffer.alloc(Math.ceil(content.length / BLOCK) * BLOCK)
      content.copy(padded)
      parts.push(padded)
    }
  }
  parts.push(Buffer.alloc(BLOCK * 2))
  return gzipSync(Buffer.concat(parts))
}


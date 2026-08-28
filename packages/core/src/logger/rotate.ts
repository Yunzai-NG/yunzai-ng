/**
 * 模块职责：日志文件的滚动写入与保留策略
 * 依赖方向：仅依赖 node:fs / node:path
 * 生命周期：由 LoggerHub 创建与关闭；`close()` 前必须 `flushSync()`
 * 注意事项：刻意**不用** `pino-roll` / `pino/file` 这类 worker 线程 transport。
 *          worker transport 在两个场景下存在缺陷：
 *          1) 单文件打包（Windows 安装包）里 worker 入口路径解析不到；
 *          2) 进程被强杀时 worker 尚未落盘的日志直接丢失 —— 而崩溃前最后
 *             几行日志恰恰是排障最需要的。
 *
 *          因此此处自行维护一个 fd 与内存缓冲：常态下批量异步刷盘，退出与致命
 *          错误时 `flushSync()` 同步落盘。写入用 `writeSync` 循环，处理
 *          部分写入（管道/网络盘上会发生）。
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync, writeSync } from "node:fs"
import { join } from "node:path"

/** 滚动写入参数 */
export interface RotateOptions {
  /** 日志目录 */
  dir: string
  /** 文件名前缀，缺省 `"app"` */
  basename?: string
  /** 单文件字节上限，缺省 8MB */
  maxSize?: number
  /** 保留天数，缺省 14 */
  keepDays?: number
  /** 文件数上限，缺省 100（防止同一天大量写入日志将磁盘写满） */
  maxFiles?: number
  /** 批量刷盘间隔毫秒，缺省 200 */
  flushInterval?: number
  /** 缓冲字节数上限，超过立即刷盘，缺省 32KB */
  bufferLimit?: number
}

/** 默认单文件上限：8MB */
const DEFAULT_MAX_SIZE = 8 * 1024 * 1024

/**
 * 取本地日期字符串
 * @param date 时间
 * @returns 形如 `"2026-08-21"`
 */
function localDay(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

/**
 * 滚动日志写入器
 *
 * 触发滚动的两个条件：跨自然日、当前文件超过 `maxSize`。
 * 同一天内超限则追加序号：`app-2026-08-21.1.log`。
 */
export class RotatingFileWriter {
  /** 日志目录 */
  readonly #dir: string
  /** 文件名前缀 */
  readonly #basename: string
  /** 单文件上限 */
  readonly #maxSize: number
  /** 保留天数 */
  readonly #keepDays: number
  /** 文件数上限 */
  readonly #maxFiles: number
  /** 刷盘间隔 */
  readonly #flushInterval: number
  /** 缓冲上限 */
  readonly #bufferLimit: number

  /** 当前文件描述符 */
  #fd = -1
  /** 当前文件路径 */
  #file = ""
  /** 当前文件已写字节数 */
  #size = 0
  /** 当前文件对应的日期 */
  #day = ""
  /** 待刷盘缓冲 */
  #buffer: string[] = []
  /** 缓冲字节数（按 UTF-8 估算） */
  #bufferBytes = 0
  /** 刷盘定时器 */
  #timer: NodeJS.Timeout | undefined
  /** 是否已关闭 */
  #closed = false

  /**
   * @param opts 滚动参数
   */
  constructor(opts: RotateOptions) {
    this.#dir = opts.dir
    this.#basename = opts.basename ?? "app"
    this.#maxSize = Math.max(64 * 1024, opts.maxSize ?? DEFAULT_MAX_SIZE)
    this.#keepDays = Math.max(1, opts.keepDays ?? 14)
    this.#maxFiles = Math.max(2, opts.maxFiles ?? 100)
    this.#flushInterval = Math.max(50, opts.flushInterval ?? 200)
    this.#bufferLimit = Math.max(4096, opts.bufferLimit ?? 32 * 1024)
  }

  /** 当前正在写入的文件路径 */
  get file(): string {
    return this.#file
  }

  /**
   * 写入一行（调用方需自带换行符，pino 已带）
   * @param line 日志行
   */
  write(line: string): void {
    if (this.#closed) return
    this.#buffer.push(line)
    this.#bufferBytes += Buffer.byteLength(line)

    if (this.#bufferBytes >= this.#bufferLimit) {
      this.flushSync()
      return
    }
    if (!this.#timer) {
      this.#timer = setTimeout(() => {
        this.#timer = undefined
        this.flushSync()
      }, this.#flushInterval)
      // unref：日志缓冲不该拖着进程不让退出
      if (typeof this.#timer.unref === "function") this.#timer.unref()
    }
  }

  /**
   * 同步刷盘
   *
   * 进程退出、`uncaughtException`、`fatal` 级日志之后都应调用，
   * 否则最关键的几行日志会随进程一起消失。
   */
  flushSync(): void {
    if (this.#buffer.length === 0) return
    const payload = this.#buffer.join("")
    this.#buffer = []
    this.#bufferBytes = 0

    try {
      this.#ensureTarget(Buffer.byteLength(payload))
      if (this.#fd < 0) return
      const data = Buffer.from(payload, "utf8")
      let offset = 0
      // writeSync 可能只写了一部分，必须循环
      while (offset < data.length) {
        offset += writeSync(this.#fd, data, offset, data.length - offset)
      }
      this.#size += data.length
    } catch {
      // 日志系统本身不能抛错，否则会把"记录错误"变成"制造错误"。
      // 磁盘满或权限问题只能静默丢弃，控制台流仍然可用。
    }
  }

  /** 刷盘并关闭文件 */
  close(): void {
    if (this.#closed) return
    this.flushSync()
    this.#closed = true
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
    if (this.#fd >= 0) {
      try {
        closeSync(this.#fd)
      } catch {
        // 关闭失败无从处理
      }
      this.#fd = -1
    }
  }

  /**
   * 确保当前文件可写且容量足够
   * @param incoming 即将写入的字节数
   */
  #ensureTarget(incoming: number): void {
    const day = localDay(new Date())
    const needRotate = this.#fd < 0 || day !== this.#day || this.#size + incoming > this.#maxSize
    if (!needRotate) return

    if (this.#fd >= 0) {
      try {
        closeSync(this.#fd)
      } catch {
        // 忽略
      }
      this.#fd = -1
    }

    mkdirSync(this.#dir, { recursive: true })
    this.#day = day

    // 找当天第一个未超限的序号
    let index = 0
    let file = join(this.#dir, `${this.#basename}-${day}.log`)
    let size = this.#sizeOf(file)
    while (size + incoming > this.#maxSize && index < 1000) {
      index++
      file = join(this.#dir, `${this.#basename}-${day}.${index}.log`)
      size = this.#sizeOf(file)
    }

    this.#file = file
    this.#size = size
    this.#fd = openSync(file, "a")
    this.#cleanup()
  }

  /**
   * 取文件大小
   * @param file 文件路径
   * @returns 字节数；不存在时 0
   */
  #sizeOf(file: string): number {
    try {
      return existsSync(file) ? statSync(file).size : 0
    } catch {
      return 0
    }
  }

  /**
   * 按保留策略删除旧日志
   *
   * 只在滚动时调用（低频），因此用同步 API 无妨。
   */
  #cleanup(): void {
    try {
      const pattern = new RegExp(`^${this.#basename}-(\\d{4}-\\d{2}-\\d{2})(?:\\.(\\d+))?\\.log$`)
      const files: { name: string; day: string; index: number }[] = []
      for (const name of readdirSync(this.#dir)) {
        const m = pattern.exec(name)
        if (m) files.push({ name, day: m[1]!, index: Number(m[2] ?? 0) })
      }

      // 按日期倒序、同日按序号倒序 → 数组头部是最新的
      files.sort((a, b) => (a.day === b.day ? b.index - a.index : a.day < b.day ? 1 : -1))

      const cutoff = new Date()
      cutoff.setDate(cutoff.getDate() - this.#keepDays)
      const cutoffDay = localDay(cutoff)

      for (let i = 0; i < files.length; i++) {
        const entry = files[i]!
        const tooOld = entry.day < cutoffDay
        const tooMany = i >= this.#maxFiles
        if (!tooOld && !tooMany) continue
        if (join(this.#dir, entry.name) === this.#file) continue
        try {
          unlinkSync(join(this.#dir, entry.name))
        } catch {
          // 文件被占用（Windows 常见）时留到下次滚动再试
        }
      }
    } catch {
      // 清理失败不影响写入
    }
  }
}

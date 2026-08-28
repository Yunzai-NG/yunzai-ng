/**
 * 模块职责：探测运行环境（操作系统族、Termux、容器、内存档位、资源占用）
 * 依赖方向：仅依赖 node 内置模块与类型包
 * 生命周期：`detectPlatform()` 结果在进程内不变，缓存一份
 * 注意事项：Termux 上的 Node 通常把 `process.platform` 报成 `"linux"`，
 *          单看它会把安卓当普通 Linux，进而按桌面策略去找 Chromium、
 *          按大内存开并发 —— 这是安卓端最常见的 OOM 原因。
 *          所以这里做多重取证：环境变量 PREFIX / TERMUX_VERSION、
 *          `/data/data/com.termux` 目录、`/system/build.prop`。
 */
import { existsSync, readFileSync } from "node:fs"
import { arch, cpus, platform, totalmem } from "node:os"
import type { PlatformInfo, OsFamily, ResourceUsage } from "@yunzai-ng/types"

/** 低内存判定阈值：2GB */
const LOW_MEMORY_BYTES = 2 * 1024 * 1024 * 1024

/** 探测结果缓存 */
let cached: PlatformInfo | undefined

/**
 * 是否运行在 Termux（安卓）里
 * @returns 是否为 Termux 环境
 */
function detectTermux(): boolean {
  if (process.env.TERMUX_VERSION) return true
  const prefix = process.env.PREFIX ?? ""
  if (prefix.includes("com.termux")) return true
  if (existsSync("/data/data/com.termux/files/usr")) return true
  return false
}

/**
 * 是否运行在安卓上（含非 Termux 的其他安卓运行环境）
 * @returns 是否为安卓
 */
function detectAndroid(): boolean {
  if (platform() === "android") return true
  if (detectTermux()) return true
  // 非 Termux 的安卓容器：靠系统属性文件判断
  return existsSync("/system/build.prop") && existsSync("/system/bin/app_process")
}

/**
 * 是否运行在容器里
 *
 * 容器内可用内存往往远小于 `os.totalmem()` 报告的宿主机内存，
 * 日志和并发策略需要知道这件事。
 * @returns 是否为容器环境
 */
function detectContainer(): boolean {
  if (existsSync("/.dockerenv")) return true
  if (process.env.KUBERNETES_SERVICE_HOST) return true
  try {
    const cgroup = readFileSync("/proc/1/cgroup", "utf8")
    return /docker|kubepods|containerd|lxc/.test(cgroup)
  } catch {
    return false
  }
}

/**
 * 判定操作系统族
 * @returns 操作系统族
 */
function detectOs(): OsFamily {
  if (detectAndroid()) return "android"
  switch (platform()) {
    case "win32":
      return "windows"
    case "darwin":
      return "macos"
    case "linux":
      return "linux"
    default:
      return "unknown"
  }
}

/**
 * 读取 cgroup v2/v1 的内存上限
 *
 * 容器里 `os.totalmem()` 给的是宿主机内存，会让"低内存档位"判断失效。
 * @returns 字节数；读不到时 undefined
 */
function readCgroupMemoryLimit(): number | undefined {
  const candidates = ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]
  for (const file of candidates) {
    try {
      const text = readFileSync(file, "utf8").trim()
      if (text === "max") continue
      const value = Number(text)
      // cgroup v1 未设限时是一个接近 2^63 的巨大数，直接忽略
      if (Number.isFinite(value) && value > 0 && value < Number.MAX_SAFE_INTEGER) return value
    } catch {
      continue
    }
  }
  return undefined
}

/**
 * 探测运行环境
 * @returns 环境信息（进程内缓存，多次调用返回同一对象）
 */
export function detectPlatform(): PlatformInfo {
  if (cached) return cached

  const isContainer = detectContainer()
  const hostMemory = totalmem()
  const limited = readCgroupMemoryLimit()
  const totalMemory = limited !== undefined ? Math.min(hostMemory, limited) : hostMemory

  cached = Object.freeze({
    os: detectOs(),
    arch: arch(),
    isTermux: detectTermux(),
    isContainer,
    nodeVersion: process.versions.node,
    cpus: Math.max(1, cpus().length),
    totalMemory,
    lowMemory: totalMemory > 0 && totalMemory < LOW_MEMORY_BYTES
  })
  return cached
}

/** 上一次 CPU 采样点 */
let lastCpuSample: { time: bigint; usage: NodeJS.CpuUsage } | undefined

/**
 * 采样进程资源占用
 *
 * `cpu` 是**两次调用之间**的平均占用率，因此第一次调用必然返回 0。
 * WebUI 的资源曲线按固定间隔轮询即可。
 * @returns 资源占用快照
 */
export function sampleUsage(): ResourceUsage {
  const mem = process.memoryUsage()
  const now = process.hrtime.bigint()
  const usage = process.cpuUsage()

  let cpu = 0
  if (lastCpuSample) {
    const elapsedUs = Number(now - lastCpuSample.time) / 1000
    if (elapsedUs > 0) {
      const usedUs = usage.user - lastCpuSample.usage.user + (usage.system - lastCpuSample.usage.system)
      // 除以核心数，让多核机器上的数值仍落在 0~1
      cpu = Math.min(1, Math.max(0, usedUs / elapsedUs / detectPlatform().cpus))
    }
  }
  lastCpuSample = { time: now, usage }

  return {
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    external: mem.external + (mem.arrayBuffers ?? 0),
    uptime: Math.round(process.uptime()),
    cpu: Number(cpu.toFixed(4))
  }
}

/**
 * 按内存档位给出建议的并发上限
 *
 * 渲染器、图片下载这类"每个任务几十 MB"的操作用它定并发，
 * 而不是各自拍一个魔数。
 * @param kind 任务类型：`render` 每任务约 80MB，`io` 约 2MB
 * @returns 建议并发数，至少 1
 */
export function suggestConcurrency(kind: "render" | "io"): number {
  const info = detectPlatform()
  if (kind === "io") return info.lowMemory ? 4 : Math.min(16, info.cpus * 2)
  // 渲染：低内存设备强制串行，避免 Chromium 多标签把内存打满
  if (info.lowMemory) return 1
  const byMemory = Math.floor(info.totalMemory / (1024 * 1024 * 1024))
  return Math.max(1, Math.min(4, Math.min(byMemory - 1, info.cpus)))
}

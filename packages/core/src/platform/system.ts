/**
 * 模块职责：探测本机的磁盘与 GPU —— 概览页两个进度组件的数据来源
 * 依赖方向：仅依赖 node 内置模块与本目录的 detect；不认识 HTTP，也不认识面板
 * 生命周期：无状态函数 + 一份短命缓存；缓存生存期见 `CACHE_MS`
 * 注意事项：**CPU 与内存不在本模块。** 那两项已在 `sampleUsage()` 里并随 `GET /api/overview`
 *          发给面板；此处再供一份就是同一事实的第二个来源，采样时刻还不同 —— 面板上会出现
 *          「CPU 卡片和 CPU 环不是一个数」。四个不显而易见的决定：
 *
 *          **磁盘走 `fs.statfs`，不调外部命令。** Windows 上 `Get-CimInstance` 实测约 813ms，
 *          而 `statfs` 逐盘合计 3ms、字节数一致 —— 差两个数量级是因为起一个 PowerShell 进程就要
 *          半秒，而这个端点被 5 秒一次地轮询。
 *
 *          **「有几个分区」按平台分别回答。** Windows 探盘符；Linux 与安卓读 `/proc/mounts` 只留
 *          真实块设备；macOS 与未知系统只报 `/` —— 为一个进度条搬 `getmntinfo` 不值得。
 *
 *          **GPU 只认 nvidia-smi，取不到就当没有这件事。** 测不到时**不返回 `gpus` 字段**而非
 *          返回空数组：空数组会被前端读成「确实有 0 块显卡」，而 0% 会被读成「GPU 空闲」。
 *
 *          **`nvidia-smi` 不存在这件事只查一次。** 没有 N 卡的机器上每 5 秒 spawn 一个必然
 *          ENOENT 的进程，一天是一万七千次。
 */
import { constants as fsConstants } from "node:fs"
import { access, readFile, statfs } from "node:fs/promises"
import { execFile } from "node:child_process"
import { detectPlatform } from "./detect.js"

/**
 * 快照缓存生存期
 *
 * 取 4 秒而非 5 秒：面板按 5 秒轮询，缓存若与轮询同为 5 秒，两个周期的相位差会让
 * 每隔几次出现一次「这次读的是上一次的数」。比轮询间隔短一点，则每次轮询必然重新采。
 */
const CACHE_MS = 4000

/** 探测盘符的范围，理由同 server/browse.ts：A、B 是软驱字母 */
const DRIVE_LETTERS = "CDEFGHIJKLMNOPQRSTUVWXYZ"

/** 最多报告几个分区 */
const MAX_DISKS = 12

/** nvidia-smi 的超时毫秒 */
const GPU_TIMEOUT_MS = 3000

/**
 * `/proc/mounts` 里不当作「分区」的文件系统类型
 *
 * squashfs 是 snap 包的只读镜像，一台装了十几个 snap 的 Ubuntu 上会有十几条，
 * 且每条都「100% 已用」—— 那是只读镜像的常态，不是磁盘快满了。
 */
const PSEUDO_FS = new Set(["squashfs", "iso9660", "ramfs", "tmpfs", "devtmpfs", "overlay", "aufs"])

/** 一个分区的占用 */
export interface DiskInfo {
  /** 挂载点；Windows 上形如 `C:\` */
  readonly mount: string
  /** 总容量（字节） */
  readonly total: number
  /** 可用容量（字节），取非特权用户可用的那个数 */
  readonly free: number
  /** 已用容量（字节），即 `total - free` */
  readonly used: number
}

/** 一块显卡 */
export interface GpuInfo {
  /** 型号名 */
  readonly name: string
  /** 占用率（0-1）；nvidia-smi 未给出时不出现 */
  readonly load?: number
  /** 显存已用（字节） */
  readonly memoryUsed?: number
  /** 显存总量（字节） */
  readonly memoryTotal?: number
}

/** `GET /api/system` 的响应 */
export interface SystemInfo {
  /** 各分区占用；一个都探不到时为空数组 */
  readonly disks: readonly DiskInfo[]
  /**
   * 各显卡
   *
   * **测不到时本字段不出现**，与「有 0 块显卡」相区分，见文件头第 3 条。
   */
  readonly gpus?: readonly GpuInfo[]
}

/** 上一次快照与其采样时刻 */
let cache: { at: number; value: SystemInfo } | undefined

/** 是否已确认本机没有 nvidia-smi，见文件头第 4 条 */
let noNvidiaSmi = false

/**
 * 列举现有的盘符
 *
 * Node 没有列举盘符的 API，只能逐个字母试。`access` 而非 `statfs`：后者在未插盘的
 * 读卡器上会等到超时，前者只问「能不能访问」。
 * @returns 形如 `C:\` 的盘根数组，按字母升序
 */
export async function listDriveRoots(): Promise<string[]> {
  const probes = [...DRIVE_LETTERS].map(async letter => {
    const root = `${letter}:\\`
    try {
      await access(root, fsConstants.R_OK)
      return root
    } catch {
      return undefined
    }
  })
  const found = await Promise.all(probes)
  return found.filter((root): root is string => root !== undefined)
}

/**
 * 从 `/proc/mounts` 里挑出真实分区的挂载点
 *
 * 只留设备名以 `/` 开头的行：那是真实块设备，从而一举排除 proc、sysfs、cgroup、
 * devpts 等一切伪文件系统 —— 逐个列举它们的名字迟早会漏。再按类型排掉只读镜像
 * （见 `PSEUDO_FS`），并按挂载点去重（bind mount 会让同一处出现两次）。
 * @returns 挂载点数组；读不到该文件时为空
 */
async function readMountPoints(): Promise<string[]> {
  let text: string
  try {
    text = await readFile("/proc/mounts", "utf8")
  } catch {
    return []
  }

  const seen = new Set<string>()
  for (const line of text.split("\n")) {
    const [device, rawMount, fstype] = line.split(/\s+/)
    if (device === undefined || rawMount === undefined || fstype === undefined) continue
    if (!device.startsWith("/")) continue
    if (PSEUDO_FS.has(fstype)) continue
    // /proc/mounts 用八进制转义空格与制表符，还原后才是真实路径
    const mount = rawMount.replace(/\\040/g, " ").replace(/\\011/g, "\t")
    seen.add(mount)
  }
  return [...seen].sort((a, b) => a.localeCompare(b))
}

/**
 * 本机上要报告哪些挂载点
 * @returns 挂载点数组
 */
async function mountsToProbe(): Promise<string[]> {
  const os = detectPlatform().os
  if (os === "windows") return listDriveRoots()
  if (os === "linux" || os === "android") {
    const mounts = await readMountPoints()
    // 读不到 /proc/mounts（权限受限的容器）时至少报根分区，而不是什么都不报
    return mounts.length > 0 ? mounts : ["/"]
  }
  return ["/"]
}

/**
 * 量一个挂载点
 *
 * 取 `bavail` 而不是 `bfree`：后者含为 root 预留的那一部分（ext4 默认 5%），
 * 而面板上的「可用」要回答的是「我还能写进去多少」。
 * @param mount 挂载点
 * @returns 占用；量不到时 undefined
 */
async function measure(mount: string): Promise<DiskInfo | undefined> {
  try {
    const st = await statfs(mount)
    const total = Number(st.blocks) * Number(st.bsize)
    const free = Number(st.bavail) * Number(st.bsize)
    // 容量为 0 的挂载点无从画进度条：空的光驱、已卸载的容器层都会这样
    if (!Number.isFinite(total) || total <= 0) return undefined
    const capped = Math.min(Math.max(free, 0), total)
    return { mount, total, free: capped, used: total - capped }
  } catch {
    // 权限不足、设备已拔出、网络盘掉线：跳过这一个，不影响其余
    return undefined
  }
}

/**
 * 探测各分区占用
 * @returns 各分区；一个都探不到时为空数组
 */
export async function probeDisks(): Promise<DiskInfo[]> {
  const mounts = await mountsToProbe()
  const measured = await Promise.all(mounts.map(measure))
  return measured.filter((item): item is DiskInfo => item !== undefined).slice(0, MAX_DISKS)
}

/**
 * 跑一次 nvidia-smi
 *
 * 参数以数组传递、不经 shell。`windowsHide` 免得每 5 秒在 Windows 上闪一个黑框。
 * @returns 标准输出；命令不存在或失败时 undefined
 */
function runNvidiaSmi(): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=name,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"],
      { timeout: GPU_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => {
        if (err) {
          // ENOENT 意为本机没装驱动工具，此后不必再试；超时或其他错误则留待下次
          if ((err as NodeJS.ErrnoException).code === "ENOENT") noNvidiaSmi = true
          resolve(undefined)
          return
        }
        resolve(stdout)
      }
    )
  })
}

/**
 * 解析 nvidia-smi 的 CSV 输出
 *
 * 取不到的字段 nvidia-smi 会写 `[N/A]`（如虚拟化环境下的占用率），此时该字段
 * **不出现**而不是记 0 —— 理由同文件头第 3 条。
 * @param raw 标准输出
 * @returns 各显卡；一行都解不出时为空数组
 */
export function parseNvidiaSmi(raw: string): GpuInfo[] {
  const gpus: GpuInfo[] = []
  for (const line of raw.split("\n")) {
    const cols = line.split(",").map(part => part.trim())
    const [name, load, used, total] = cols
    if (name === undefined || name === "") continue

    /**
     * 一列数字，`[N/A]` 与非数字一律作「没有这个数」
     * @param text 该列原文
     * @returns 数值；取不到时 undefined
     */
    const num = (text: string | undefined): number | undefined => {
      if (text === undefined) return undefined
      const value = Number(text)
      return Number.isFinite(value) ? value : undefined
    }

    const pct = num(load)
    const usedMb = num(used)
    const totalMb = num(total)
    gpus.push({
      name,
      ...(pct === undefined ? {} : { load: Math.min(1, Math.max(0, pct / 100)) }),
      ...(usedMb === undefined ? {} : { memoryUsed: usedMb * 1024 * 1024 }),
      ...(totalMb === undefined ? {} : { memoryTotal: totalMb * 1024 * 1024 })
    })
  }
  return gpus
}

/**
 * 探测显卡
 * @returns 各显卡；测不到时 undefined（与「有 0 块」相区分）
 */
export async function probeGpus(): Promise<GpuInfo[] | undefined> {
  if (noNvidiaSmi) return undefined
  const raw = await runNvidiaSmi()
  if (raw === undefined) return undefined
  const gpus = parseNvidiaSmi(raw)
  return gpus.length > 0 ? gpus : undefined
}

/**
 * 采一份系统快照
 *
 * 磁盘与显卡并发探测：两者互不相关，串行只是把 nvidia-smi 的耗时加到磁盘上。
 * @param force 是否绕过缓存，仅测试用
 * @returns 系统快照
 */
export async function sampleSystem(force = false): Promise<SystemInfo> {
  const now = Date.now()
  if (!force && cache !== undefined && now - cache.at < CACHE_MS) return cache.value

  const [disks, gpus] = await Promise.all([probeDisks(), probeGpus()])
  const value: SystemInfo = { disks, ...(gpus === undefined ? {} : { gpus }) }
  cache = { at: now, value }
  return value
}

/** 清掉缓存与「没有 nvidia-smi」的记忆，仅测试用 */
export function resetSystemCache(): void {
  cache = undefined
  noNvidiaSmi = false
}

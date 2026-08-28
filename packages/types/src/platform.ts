/**
 * 模块职责：运行环境与目录布局
 * 依赖方向：叶子模块
 * 生命周期：纯类型
 * 注意事项：Windows 与 Android（Termux）的差异全部收敛到这里。取路径一律经
 *          `ctx.app.paths` / `ctx.app.platform`，**不要拼 `process.cwd()`** ——
 *          装成服务或以 pm2 启动时工作目录并非安装目录。
 */

/** 运行的操作系统族 */
export type OsFamily = "windows" | "linux" | "android" | "macos" | "unknown"

/** 环境信息 */
export interface PlatformInfo {
  /** 操作系统族 */
  readonly os: OsFamily
  /** CPU 架构，如 `"x64"` / `"arm64"` / `"ia32"` */
  readonly arch: string
  /** 是否运行在 Termux 里 */
  readonly isTermux: boolean
  /** 是否运行在容器里 */
  readonly isContainer: boolean
  /** Node 版本 */
  readonly nodeVersion: string
  /** 逻辑 CPU 数 */
  readonly cpus: number
  /** 物理内存总量（字节） */
  readonly totalMemory: number
  /** 是否为低内存设备（<2GB，Android 常见）；渲染器等会据此收紧并发 */
  readonly lowMemory: boolean
}

/**
 * 目录布局
 *
 * 全部为绝对路径，由内核在启动时一次性确定并保证存在。
 */
export interface RuntimePaths {
  /** 数据根目录（可通过 `YZNG_HOME` 覆盖） */
  readonly home: string
  /** 配置文件目录 */
  readonly config: string
  /** 持久数据目录（KV / SQLite 落盘处） */
  readonly data: string
  /** 日志目录 */
  readonly logs: string
  /** 临时目录，重启可清 */
  readonly temp: string
  /** 插件安装目录 */
  readonly plugins: string
  /** 内核自身所在目录（只读） */
  readonly runtime: string
  /** 缓存目录（Chromium、下载的资源等） */
  readonly cache: string
}

/** 进程资源占用采样 */
export interface ResourceUsage {
  /** 常驻内存（字节） */
  rss: number
  /** V8 堆已用（字节） */
  heapUsed: number
  /** V8 堆总量（字节） */
  heapTotal: number
  /** 堆外内存（字节），Buffer 大量堆积时看这里 */
  external: number
  /** 进程已运行秒数 */
  uptime: number
  /** 最近一个采样窗口内的 CPU 占用率（0-1） */
  cpu: number
}

/**
 * 模块职责：盯住插件目录里的单文件插件，有增删改时通知宿主同步
 * 依赖方向：只依赖 node 内置模块与 util/fs
 * 生命周期：`start()` 之后由内核持有，返回的 Disposer 关掉全部监听
 * 注意事项：**不递归监听。** 目录插件里有 node_modules，递归监听在 Linux 上要为其中每个目录各占
 *          一个 inotify 句柄，几万个文件就能把上限吃光。故只盯插件根目录与其下的单文件合集目录
 *          （没有 package.json 的那种，如 `plugins/example/`），合集目录增删时随根目录事件重建。
 *
 *          事件合并成一次同步：编辑器保存一个文件常连发三四个事件（写临时文件、改名、改属性），
 *          逐个同步会把同一个插件重载好几遍。
 */
import { watch, type FSWatcher } from "node:fs"
import { join } from "node:path"
import type { Disposer, Logger } from "@yunzai-ng/types"
import { isFile, listDirs } from "../util/fs.js"

/** 事件合并窗口毫秒 */
const SETTLE_MS = 300

/** 单文件插件的扩展名 */
const SCRIPT_RE = /\.m?js$/i

/** 监听参数 */
export interface ScriptWatchOptions {
  /** 插件根目录 */
  readonly root: string
  /** 日志器 */
  readonly logger: Logger
  /** 有变化时调用；同一时刻只会有一次在跑 */
  readonly onChange: () => Promise<unknown>
}

/**
 * 开始监听
 * @param opts 参数
 * @returns 停止监听
 */
export function watchScripts(opts: ScriptWatchOptions): Disposer {
  const subs = new Map<string, FSWatcher>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let running: Promise<unknown> | undefined
  let again = false
  let closed = false

  /** 合并窗口到点后同步一次；同步途中又有事件就在它结束后再来一次 */
  const fire = (): void => {
    timer = undefined
    if (running !== undefined) {
      again = true
      return
    }
    running = opts
      .onChange()
      .catch((err: unknown) => opts.logger.warn("单文件插件同步失败", err))
      .finally(() => {
        running = undefined
        if (again && !closed) {
          again = false
          fire()
        }
      })
  }

  const schedule = (): void => {
    if (closed) return
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(fire, SETTLE_MS)
  }

  /**
   * 盯一个目录
   * @param dir 目录
   * @param onName 收到事件时调用，参数为变动的文件名（平台给不出时为空串）
   * @returns 监听句柄；目录打不开时 undefined
   */
  const open = (dir: string, onName: (name: string) => void): FSWatcher | undefined => {
    try {
      const watcher = watch(dir, { persistent: false }, (_event, name) => onName(name === null ? "" : String(name)))
      // 目录被删时 Windows 上会报 EPERM：不处理就是一个未捕获的 error 事件
      watcher.on("error", () => {
        watcher.close()
        for (const [key, value] of subs) if (value === watcher) subs.delete(key)
      })
      return watcher
    } catch {
      return undefined
    }
  }

  /** 合集目录里的事件只认脚本文件：插件写进去的数据文件不该引来一次同步 */
  const onScript = (name: string): void => {
    if (name === "" || SCRIPT_RE.test(name)) schedule()
  }

  /**
   * 按根目录现状重建合集目录的监听
   * @returns 合集目录有没有增减
   */
  const refresh = async (): Promise<boolean> => {
    const want = new Set<string>()
    for (const name of await listDirs(opts.root).catch(() => [])) {
      if (name.startsWith(".") || name.startsWith("_") || name === "node_modules") continue
      const dir = join(opts.root, name)
      if (!(await isFile(join(dir, "package.json")))) want.add(dir)
    }
    if (closed) return false
    let changed = false
    for (const [dir, watcher] of subs) {
      if (want.has(dir)) continue
      watcher.close()
      subs.delete(dir)
      changed = true
    }
    for (const dir of want) {
      if (subs.has(dir)) continue
      const watcher = open(dir, onScript)
      if (watcher !== undefined) subs.set(dir, watcher)
      changed = true
    }
    return changed
  }

  /*
   * 根目录：顶层脚本直接同步；别的名字只在合集目录有增减时同步
   *
   * Windows 上子目录里随便改一个文件，根目录也会报一次那个子目录名 —— 目录插件编译、写日志都会
   * 走到这里，照单同步就是满屏无用功。
   */
  const top = open(opts.root, name => {
    // 平台给不出文件名时无从判断，宁可多同步一次
    if (name === "" || SCRIPT_RE.test(name)) return schedule()
    void refresh().then(changed => {
      if (changed) schedule()
    })
  })
  if (top === undefined) {
    opts.logger.warn(`无法监听插件目录 ${opts.root}，单文件插件的增删改需在插件页手动重载`)
    return () => undefined
  }
  void refresh()

  return () => {
    closed = true
    if (timer !== undefined) clearTimeout(timer)
    top.close()
    for (const watcher of subs.values()) watcher.close()
    subs.clear()
  }
}

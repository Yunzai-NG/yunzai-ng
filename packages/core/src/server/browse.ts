/**
 * 模块职责：只读的目录浏览 —— 面板填写「服务器上的路径」时的候选来源
 * 依赖方向：依赖 node:fs / node:path 与 util/fs；不认识 HTTP，也不认识面板
 * 生命周期：纯函数，无状态
 * 注意事项：**这是内核唯一一处允许外部枚举本机文件系统的地方，故边界写在这里而非调用处。**
 *          它的存在理由只有一个：配置里的 `file` / `dir` 字段要的是服务器上的路径，而浏览器的
 *          `<input type="file">` 给不到路径。没有它，那两种 widget 只能让人手敲绝对路径。
 *
 *          四条刻意的限制，都是为了让扩权尽量小：**只回名字与「是不是目录」**，不回大小、时间、
 *          权限、内容（附带好处是不必逐项 `stat`，万条文件的目录会因此慢上百倍）；**条目数设上限**
 *          并如实标明截断；**符号链接只跟一层**，且跟不到就当普通文件（`withFileTypes` 是 lstat
 *          语义，指向目录的链接会被判成不是目录、于是点不进去）；**不做写操作，也不收相对路径**
 *          —— 相对路径的基准是内核的工作目录，而那不是面板看得见的东西。
 *
 *          「只读模式下要禁用这个只读接口」那条在 api.ts —— 那是面板策略，不是文件系统的性质。
 */
import { constants as fsConstants, type Dirent } from "node:fs"
import { access, readdir, stat } from "node:fs/promises"
import { posix, win32 } from "node:path"
import { errorCode } from "../util/fs.js"

/** 单次最多返回的条目数，见文件头第 2 条 */
const MAX_ENTRIES = 1000

/**
 * 探测盘符的范围
 *
 * 自 C 起而不自 A 起：A、B 是软驱字母，在部分机器上探测它们会让驱动器空转数秒，
 * 而这两个字母上今日不会有内核要访问的目录。
 */
const DRIVE_LETTERS = "CDEFGHIJKLMNOPQRSTUVWXYZ"

/**
 * 取对应平台的路径实现
 *
 * 本模块的每个导出都带 `windows` 参数，于是路径计算也必须跟着这个参数走，不能用
 * `node:path` 的平台默认导出：那些导出绑的是**当前进程**的平台，于是
 * `dirname("C:\\Users\\x")` 在 Linux 上是 `"."`，参数就成了摆设 —— 用例在 Windows 上
 * 全绿、在 Linux 的 CI 上挂。
 * @param windows 是否按 Windows 处理
 * @returns `node:path` 的 win32 或 posix 实现
 */
function pathOf(windows: boolean): typeof win32 | typeof posix {
  return windows ? win32 : posix
}

/** 目录里的一项 */
export interface BrowseEntry {
  /** 名字，不含所在目录 */
  readonly name: string
  /** 是不是目录（符号链接按其指向判定） */
  readonly dir: boolean
  /** 是不是符号链接；不是则不出现 */
  readonly link?: boolean
}

/** 一次目录列举的结果 */
export interface BrowseListing {
  /** 规范化后的绝对路径；Windows 上列举盘符时为空串 */
  readonly path: string
  /** 上一级路径；已在最外层时不出现 */
  readonly parent?: string
  /** 条目，目录在前、各按名称排序 */
  readonly entries: readonly BrowseEntry[]
  /** 条目是否因超过上限而被截断 */
  readonly truncated: boolean
  /**
   * 本机的路径分隔符
   *
   * 一并回给面板，免得前端靠 `navigator.platform` 猜 —— 浏览器所在的机器与内核
   * 所在的机器完全可以是两台，用浏览器的分隔符去拼服务器的路径必然出错。
   */
  readonly sep: string
}

/** 列举结果：成功或一条可直接回给面板的失败说明 */
export type BrowseResult =
  | {
      /** 成功 */
      readonly ok: true
      /** 列举内容 */
      readonly listing: BrowseListing
    }
  | {
      /** 失败 */
      readonly ok: false
      /** 建议的 HTTP 状态码 */
      readonly status: number
      /** 中文说明，可原样回给面板 */
      readonly message: string
    }

/** 错误码 → 状态码与说明 */
const CODE_TABLE: Record<string, { status: number; text: string }> = {
  ENOENT: { status: 404, text: "不存在" },
  ENOTDIR: { status: 400, text: "不是一个目录" },
  EACCES: { status: 403, text: "没有读取权限" },
  EPERM: { status: 403, text: "没有读取权限" },
  ELOOP: { status: 400, text: "符号链接成环" },
  ENAMETOOLONG: { status: 400, text: "路径过长" }
}

/**
 * 上一级路径
 *
 * Windows 上盘根（`C:\`）的上一级是**盘符列表**（以空串表示），而不是它自己 ——
 * 否则面板上的「上一级」在盘根处点不动，也就无从切换到另一个盘。
 * @param target 绝对路径
 * @param windows 是否 Windows
 * @returns 上一级；已在最外层时 undefined
 */
export function parentOf(target: string, windows: boolean): string | undefined {
  const up = pathOf(windows).dirname(target)
  if (up !== target) return up
  return windows ? "" : undefined
}

/**
 * 列举现有的盘符
 *
 * Node 没有列举盘符的 API，只能逐个字母试。`access` 而非 `stat`：后者在未插盘的
 * 读卡器上会等到超时，前者只问「能不能访问」。
 * @returns 形如 `C:\` 的盘根数组
 */
async function listDrives(): Promise<BrowseEntry[]> {
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
  return found.filter((root): root is string => root !== undefined).map(name => ({ name, dir: true }))
}

/**
 * 判定一个条目是不是目录
 *
 * 只对符号链接补 `stat`，见文件头第 3 条。
 * @param dir 所在目录
 * @param entry readdir 给出的条目
 * @param windows 是否按 Windows 处理
 * @returns 是否为目录
 */
async function isDirEntry(dir: string, entry: Dirent, windows: boolean): Promise<boolean> {
  if (!entry.isSymbolicLink()) return entry.isDirectory()
  try {
    return (await stat(pathOf(windows).join(dir, entry.name))).isDirectory()
  } catch {
    // 悬空链接：当作普通条目，不报错也不当目录 —— 点不进去是对的
    return false
  }
}

/**
 * 排序：目录在前，同类按名称（`localeCompare` + `numeric`，故 `f2` 在 `f10` 之前）
 *
 * **中文名排在英文名之前不是缺陷** —— CLDR 的中文规则把汉字整块提到拉丁字母之前。
 * 要改成「英文在前」得在此处显式加一层「是否以 ASCII 起头」的比较键，而不是换 locale。
 * @param a 左项
 * @param b 右项
 * @returns 比较结果
 */
function compareEntries(a: BrowseEntry, b: BrowseEntry): number {
  if (a.dir !== b.dir) return a.dir ? -1 : 1
  return a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true })
}

/**
 * 列举一个目录
 *
 * @param input 要列举的绝对路径；空或缺省时，Windows 上列举盘符、其余系统列举根目录
 * @param windows 是否按 Windows 处理，缺省取当前平台。仅为让用例能同时覆盖两种行为
 * @returns 列举结果
 */
export async function browseDirectory(input: string | undefined, windows = process.platform === "win32"): Promise<BrowseResult> {
  const path = pathOf(windows)
  const raw = (input ?? "").trim()

  if (raw === "") {
    if (windows) {
      return { ok: true, listing: { path: "", entries: await listDrives(), truncated: false, sep: path.sep } }
    }
    return read("/", windows)
  }

  if (!path.isAbsolute(raw)) {
    return {
      ok: false,
      status: 400,
      message: `只接受绝对路径：${raw} 是相对路径，而它的基准（内核进程的工作目录）在面板上看不到`
    }
  }

  return read(path.resolve(raw), windows)
}

/**
 * 真正读一次目录
 * @param target 已规范化的绝对路径
 * @param windows 是否按 Windows 处理
 * @returns 列举结果
 */
async function read(target: string, windows: boolean): Promise<BrowseResult> {
  let raw: Dirent[]
  try {
    raw = await readdir(target, { withFileTypes: true })
  } catch (err) {
    const code = errorCode(err) ?? ""
    const known = CODE_TABLE[code]
    if (known !== undefined) return { ok: false, status: known.status, message: `${target} ${known.text}` }
    return { ok: false, status: 500, message: `读取 ${target} 失败：${err instanceof Error ? err.message : String(err)}` }
  }

  const entries: BrowseEntry[] = []
  for (const item of raw) {
    const link = item.isSymbolicLink()
    const dir = await isDirEntry(target, item, windows)
    entries.push(link ? { name: item.name, dir, link: true } : { name: item.name, dir })
  }
  entries.sort(compareEntries)

  // 先排序再截断：反过来的话「截掉的是哪些」取决于文件系统给出的顺序，
  // 同一个目录两次请求可能截到不同的一批
  const truncated = entries.length > MAX_ENTRIES
  const parent = parentOf(target, windows)
  return {
    ok: true,
    listing: {
      path: target,
      ...(parent === undefined ? {} : { parent }),
      entries: truncated ? entries.slice(0, MAX_ENTRIES) : entries,
      truncated,
      sep: pathOf(windows).sep
    }
  }
}

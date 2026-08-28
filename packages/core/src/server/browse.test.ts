/**
 * 模块职责：`browse.ts` 的用例 —— 目录列举、上一级、错误映射与截断
 * 依赖方向：测试文件，依赖被测模块与 node:fs
 * 生命周期：每个用例一个临时目录
 * 注意事项：**用例跑在真实文件系统上，不打桩。** 要验的恰是「Node 的 readdir 在这台
 *          机器上给出什么」——把 fs 打成桩就只是在验证桩自己，而符号链接、悬空链接、
 *          权限错误这几处的行为差异全在真实文件系统一侧。
 *
 *          符号链接一节在 Windows 上需要管理员权限或开发者模式，因此建链接失败时
 *          跳过该用例而不是让它红 —— 那种失败与被测代码无关。
 */
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { browseDirectory, parentOf } from "./browse.js"

describe("目录浏览", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "yzng-browse-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  /**
   * 取成功结果的列举内容
   * @param path 要列举的路径
   * @returns 列举内容
   */
  async function listing(path: string | undefined): Promise<{
    /** 路径 */
    path: string
    /** 上一级 */
    parent?: string
    /** 条目 */
    entries: readonly { name: string; dir: boolean; link?: boolean }[]
    /** 是否截断 */
    truncated: boolean
    /** 分隔符 */
    sep: string
  }> {
    const result = await browseDirectory(path)
    if (!result.ok) throw new Error(`预期成功，实得 ${result.status}：${result.message}`)
    return result.listing
  }

  it("目录在前、文件在后，各按名称排序", async () => {
    await mkdir(join(dir, "z-dir"))
    await mkdir(join(dir, "a-dir"))
    await writeFile(join(dir, "z.txt"), "1")
    await writeFile(join(dir, "a.txt"), "1")

    const out = await listing(dir)
    expect(out.entries.map(e => e.name)).toEqual(["a-dir", "z-dir", "a.txt", "z.txt"])
    expect(out.entries.map(e => e.dir)).toEqual([true, true, false, false])
  })

  it("数字按数值大小排，f2 在 f10 之前", async () => {
    for (const name of ["f10.txt", "f2.txt", "f1.txt"]) await writeFile(join(dir, name), "1")
    const out = await listing(dir)
    expect(out.entries.map(e => e.name)).toEqual(["f1.txt", "f2.txt", "f10.txt"])
  })

  it("**中文名整块排在英文名之前** —— CLDR 中文排序把汉字提到拉丁字母之前，非缺陷", async () => {
    for (const name of ["伽马", "阿尔法", "alpha"]) await mkdir(join(dir, name))
    const out = await listing(dir)
    // 汉字之间按拼音：阿尔法（a）在伽马（g）之前
    expect(out.entries.map(e => e.name)).toEqual(["阿尔法", "伽马", "alpha"])
  })

  it("回的是名字与是否目录，**不含大小、时间与内容**", async () => {
    await writeFile(join(dir, "secret.txt"), "不该出现在响应里")
    const out = await listing(dir)
    const entry = out.entries[0]
    expect(entry).toEqual({ name: "secret.txt", dir: false })
    expect(JSON.stringify(out)).not.toContain("不该出现")
  })

  it("给出上一级与本机分隔符", async () => {
    const child = join(dir, "sub")
    await mkdir(child)
    const out = await listing(child)
    expect(out.path).toBe(child)
    expect(out.parent).toBe(dir)
    expect(out.sep).toBe(sep)
  })

  it("隐藏项照常列出 —— Linux 上 .config 一类目录正是要找的", async () => {
    await mkdir(join(dir, ".config"))
    const out = await listing(dir)
    expect(out.entries.map(e => e.name)).toContain(".config")
  })

  it("路径被规范化，末尾多余的分隔符与 `.` 不影响结果", async () => {
    const out = await listing(`${dir}${sep}.${sep}`)
    expect(out.path).toBe(dir)
  })

  it("**相对路径一律拒绝**，并说明基准不可见", async () => {
    const result = await browseDirectory("plugins")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(400)
    expect(result.message).toContain("绝对路径")
  })

  it("不存在回 404、指向文件回 400", async () => {
    const missing = await browseDirectory(join(dir, "无此目录"))
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.status).toBe(404)

    const file = join(dir, "f.txt")
    await writeFile(file, "1")
    const notDir = await browseDirectory(file)
    expect(notDir.ok).toBe(false)
    if (!notDir.ok) {
      expect(notDir.status).toBe(400)
      expect(notDir.message).toContain("不是一个目录")
    }
  })

  it("超过 1000 项时截断并标明", async () => {
    await Promise.all(
      Array.from({ length: 1005 }, (_, i) => writeFile(join(dir, `f${String(i).padStart(4, "0")}.txt`), "1"))
    )
    const out = await listing(dir)
    expect(out.entries.length).toBe(1000)
    expect(out.truncated).toBe(true)
    // 先排序再截断，故截到的必是排序后的前 1000 项
    expect(out.entries[0]?.name).toBe("f0000.txt")
  })

  it("未超上限时 truncated 为假", async () => {
    await writeFile(join(dir, "one.txt"), "1")
    expect((await listing(dir)).truncated).toBe(false)
  })

  it("指向目录的符号链接算目录，悬空链接不算且不报错", async () => {
    const target = join(dir, "real")
    await mkdir(target)
    try {
      await symlink(target, join(dir, "link-dir"), "dir")
      await symlink(join(dir, "无此物"), join(dir, "link-broken"), "dir")
    } catch {
      // Windows 上建符号链接需要额外权限，与被测代码无关
      return
    }
    const out = await listing(dir)
    const byName = new Map(out.entries.map(e => [e.name, e]))
    expect(byName.get("link-dir")).toEqual({ name: "link-dir", dir: true, link: true })
    expect(byName.get("link-broken")).toEqual({ name: "link-broken", dir: false, link: true })
  })
})

describe("上一级", () => {
  it("Windows 上盘根的上一级是盘符列表（空串），而不是它自己", () => {
    expect(parentOf("C:\\Users\\x", true)).toBe("C:\\Users")
    expect(parentOf("C:\\", true)).toBe("")
  })

  it("类 Unix 上根目录没有上一级", () => {
    // 在 Windows 上 dirname("/") 同样是 "/"，故用 windows=false 走另一条分支
    expect(parentOf("/", false)).toBeUndefined()
  })
})

describe("缺省起点", () => {
  it("不带路径时按平台给出最外层：Windows 列盘符、其余列根目录", async () => {
    const result = await browseDirectory(undefined)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    if (process.platform === "win32") {
      expect(result.listing.path).toBe("")
      expect(result.listing.parent).toBeUndefined()
      // 至少有一个盘，且每个都形如 X:\
      expect(result.listing.entries.length).toBeGreaterThan(0)
      expect(result.listing.entries.every(e => /^[C-Z]:\\$/.test(e.name) && e.dir)).toBe(true)
    } else {
      expect(result.listing.path).toBe("/")
    }
  })

  it("空串与只有空白的路径等同于缺省", async () => {
    const blank = await browseDirectory("   ")
    const none = await browseDirectory(undefined)
    expect(blank.ok).toBe(true)
    if (blank.ok && none.ok) expect(blank.listing.path).toBe(none.listing.path)
  })
})

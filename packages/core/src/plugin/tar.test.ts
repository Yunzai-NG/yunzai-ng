/**
 * 模块职责：tar.gz 解包器的行为测试
 * 依赖方向：测试文件，依赖 plugin/tar
 * 生命周期：每个用例一套临时目录，afterEach 全部删除
 * 注意事项：归档由 `buildTarGz` 现场构造，不使用预置的二进制夹具。解包器的校验对象是
 *          归档头部的字节内容，而预置夹具无法表达"路径写成 `../`"这类恶意结构 ——
 *          需要断言的正是这些结构被拒绝。
 */
import { readFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { isFile } from "../util/fs.js"
import { buildTarGz, extractTarGz, joinWithin, singleRoot } from "./tar.js"

let root: string | undefined

/**
 * 建一个临时目录，并返回其中的解包目标目录
 *
 * 目标目录嵌在临时根目录之内，因此"越界写入"若真的发生，落点也在本用例的清理范围内，
 * 不会残留到系统临时目录并影响后续用例。
 * @returns 解包目标目录绝对路径
 */
async function temp(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), "yzng-tar-"))
  return join(root, "dest")
}

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe("extractTarGz", () => {
  it("解出文件与目录，返回写入的相对路径", async () => {
    const dir = await temp()
    const archive = buildTarGz([
      { path: "pkg/", content: "", type: "5" },
      { path: "pkg/index.js", content: "export default 1\n" },
      { path: "pkg/lib/util.js", content: "export const a = 1\n" }
    ])

    const written = await extractTarGz(archive, dir)

    expect(written).toEqual(["pkg/index.js", "pkg/lib/util.js"])
    expect(await readFile(join(dir, "pkg", "index.js"), "utf8")).toBe("export default 1\n")
    expect(await readFile(join(dir, "pkg", "lib", "util.js"), "utf8")).toBe("export const a = 1\n")
  })

  it("strip 剥掉 GitHub 归档外层的仓库名目录", async () => {
    const dir = await temp()
    const archive = buildTarGz([{ path: "repo-abc123/index.js", content: "1" }])

    const written = await extractTarGz(archive, dir, { strip: 1 })

    expect(written).toEqual(["index.js"])
    expect(await isFile(join(dir, "index.js"))).toBe(true)
  })

  it("剥空的条目被跳过，而不是写到目标目录本身", async () => {
    const dir = await temp()
    const archive = buildTarGz([{ path: "repo/", content: "", type: "5" }, { path: "repo/a.js", content: "1" }])

    const written = await extractTarGz(archive, dir, { strip: 1 })
    expect(written).toEqual(["a.js"])
  })

  it("越出目标目录的条目被丢弃，其余条目照常解出", async () => {
    const dir = await temp()
    const archive = buildTarGz([
      { path: "../escaped.js", content: "恶意内容" },
      { path: "a/../../escaped2.js", content: "恶意内容" },
      { path: "ok.js", content: "正常内容" }
    ])

    const written = await extractTarGz(archive, dir)

    expect(written).toEqual(["ok.js"])
    expect(await isFile(join(dir, "..", "escaped.js"))).toBe(false)
    expect(await isFile(join(dir, "..", "escaped2.js"))).toBe(false)
  })

  it("绝对路径条目被丢弃", async () => {
    const dir = await temp()
    const archive = buildTarGz([{ path: "/tmp/yzng-absolute.js", content: "恶意内容" }, { path: "ok.js", content: "1" }])

    const written = await extractTarGz(archive, dir)
    expect(written).toEqual(["ok.js"])
  })

  it("软链接与硬链接条目被丢弃", async () => {
    const dir = await temp()
    const archive = buildTarGz([
      { path: "link.js", content: "", type: "2" },
      { path: "hard.js", content: "", type: "1" },
      { path: "real.js", content: "1" }
    ])

    const written = await extractTarGz(archive, dir)

    expect(written).toEqual(["real.js"])
    expect(await isFile(join(dir, "link.js"))).toBe(false)
  })

  it("pax 扩展头部声明的长路径生效", async () => {
    const dir = await temp()
    const long = `deep/${"seg/".repeat(30)}index.js`
    const record = `path=${long}\n`
    const archive = buildTarGz([
      { path: "PaxHeader", content: `${record.length + 4} ${record}`, type: "x" },
      { path: "short.js", content: "1" }
    ])

    const written = await extractTarGz(archive, dir)
    expect(written).toEqual([long])
  })

  it("条目数超过上限时抛错", async () => {
    const dir = await temp()
    const archive = buildTarGz([
      { path: "a.js", content: "1" },
      { path: "b.js", content: "1" },
      { path: "c.js", content: "1" }
    ])

    await expect(extractTarGz(archive, dir, { maxEntries: 2 })).rejects.toThrow("条目数超过上限")
  })

  it("解包后体积超过上限时抛错", async () => {
    const dir = await temp()
    const archive = buildTarGz([{ path: "big.js", content: "x".repeat(4096) }])

    await expect(extractTarGz(archive, dir, { maxBytes: 1024 })).rejects.toThrow("体积超过上限")
  })
})

describe("singleRoot", () => {
  it("唯一顶层目录时返回该目录名", () => {
    expect(singleRoot(["repo-1/index.js", "repo-1/lib/a.js"])).toBe("repo-1")
  })

  it("存在顶层文件或多个顶层目录时返回 undefined", () => {
    expect(singleRoot(["index.js", "lib/a.js"])).toBeUndefined()
    expect(singleRoot(["a/x.js", "b/y.js"])).toBeUndefined()
  })
})

describe("joinWithin", () => {
  it("越界名称一律抛错", () => {
    expect(() => joinWithin("/plugins", "../etc/passwd")).toThrow("路径越界")
    expect(() => joinWithin("/plugins", "/etc/passwd")).toThrow("路径越界")
  })

  it("正常名称拼出目标路径", () => {
    expect(joinWithin("/plugins", "demo")).toContain("demo")
  })
})

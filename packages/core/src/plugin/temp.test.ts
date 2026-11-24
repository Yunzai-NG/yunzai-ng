/**
 * 模块职责：验证临时文件的写入、复用、过期与卸载清理。
 * 依赖方向：通过 TempFiles 读写真实临时目录，用测试替身代替网络下载。
 * 生命周期：每个用例独占目录和实例，结束后回收。
 * 注意事项：TTL 边界使用可控时钟，避免断言依赖磁盘速度。
 */
import { existsSync } from "node:fs"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { TempFiles } from "./temp.js"

let root: string
let files: TempFiles
const download = vi.fn(async (url: string, path: string) => {
  await writeFile(path, url)
  return path
})
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "yzng-temp-"))
  files = new TempFiles(root, { download }, err => { throw err })
  download.mockClear()
})
afterEach(async () => {
  vi.useRealTimers()
  await files.close()
  await rm(root, { recursive: true, force: true })
})

it("独占文件支持文本和字节，提前删除幂等，关闭时回收其余文件", async () => {
  const a = await files.file("中文", ".txt")
  const b = await files.file(Uint8Array.of(0, 255))
  expect(dirname(a.path)).toBe(root)
  expect(a.path.endsWith(".txt")).toBe(true)
  expect(a.path).not.toBe(b.path)
  expect(await readFile(a.path, "utf8")).toBe("中文")
  expect([...await readFile(b.path)]).toEqual([0, 255])
  await a.remove()
  await a.remove()
  expect(existsSync(a.path)).toBe(false)
  await files.close()
  expect(existsSync(b.path)).toBe(false)
  await expect(files.file("x")).rejects.toThrow("已关闭")
})

it("同键共享下载，不把键当路径；命中不续期", async () => {
  vi.useFakeTimers()
  const source = { url: "https://example.org/a" }
  const load = () => files.cached("../a", source, { ttl: "1s" })
  const [a, b] = await Promise.all([load(), load()])
  expect(a).toBe(b)
  expect(dirname(a)).toBe(root)
  expect(download).toHaveBeenCalledTimes(1)
  vi.advanceTimersByTime(900)
  expect(await load()).toBe(a)
  vi.advanceTimersByTime(100)
  const next = await load()
  expect(next).not.toBe(a)
  vi.advanceTimersByTime(60_000)
  vi.useRealTimers()
  await vi.waitFor(() => {
    expect(existsSync(a)).toBe(false)
    expect(existsSync(next)).toBe(false)
  })
})

it("拒绝无效后缀、协议及 TTL，下载失败允许同键重试", async () => {
  await expect(files.file("x", "/../x")).rejects.toThrow("扩展名")
  await expect(files.file({ url: "file:///x" })).rejects.toThrow("HTTP")
  await expect(files.cached("a", "x", { ttl: 0 })).rejects.toThrow("TTL")
  download.mockRejectedValueOnce(new Error("断流"))
  const load = () => files.cached("a", { url: "https://example.org/a" }, { ttl: "1m" })
  await expect(load()).rejects.toThrow("断流")
  expect(await readFile(await load(), "utf8")).toBe("https://example.org/a")
})

it("关闭与写入交错，不留下文件或复活缓存", async () => {
  const task = files.cached("late", "x", { ttl: "1m" })
  await files.close()
  await expect(task).rejects.toThrow("已关闭")
  expect(await readdir(root)).toEqual([])
})

/**
 * 模块职责：`yzng data export / import` 的往返、拒绝条件与路径提示
 * 依赖方向：测试文件，依赖 commands/data 与内核的存储入口
 * 生命周期：每个用例一组临时主目录
 * 注意事项：要一个可用的 SQLite 绑定，本机没有时整组跳过
 */
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Logger } from "@yunzai-ng/types"
import { KV_DB_FILE, loadSqliteBinding, openKv, stampOf } from "@yunzai-ng/core"
import { DataCommandError, MANIFEST_FILE, exportInstance, importInstance } from "./data.js"

const binding = (await loadSqliteBinding()).binding

const coreRequire = createRequire(createRequire(import.meta.url).resolve("@yunzai-ng/core/package.json"))
interface OldLevel {
  open(): Promise<void>
  close(): Promise<void>
  put(key: string, value: string): Promise<void>
  get(key: string): Promise<string>
}
let OldDb: (new (path: string) => OldLevel) | undefined
try { OldDb = coreRequire("classic-level").ClassicLevel } catch { /* 可选原生绑定 */ }

const silent = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return silent
  },
  isLevelEnabled: () => false
} as unknown as Logger

describe.skipIf(binding === undefined)("yzng data", () => {
  let root: string
  let src: string
  let dst: string
  let out: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "yzng-data-"))
    src = join(root, "src")
    dst = join(root, "dst")
    out = join(root, "export")
    await mkdir(join(src, "config"), { recursive: true })
    await mkdir(join(src, "data", "store"), { recursive: true })
    await writeFile(join(src, "config", "yunzai.yaml"), "bot:\n  masterQQ:\n    - \"10001\"\n", "utf8")
    await writeFile(join(src, "config", "demo.yaml"), "cache: D:\\nowhere\\at\\all\n", "utf8")
    await mkdir(join(src, "data", "plugin", "demo"), { recursive: true })
    await writeFile(join(src, "data", "plugin", "demo", "state.json"), "{\"n\":1}", "utf8")
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("旧版 JSON 数据导出成 kv.db，导入后新实例读得到，源目录原样不动", async () => {
    await writeFile(join(src, "data", "store", "kv.json"), JSON.stringify({ format: 1, data: { "plugin:demo:k": { v: "旧值" } } }), "utf8")

    const manifest = await exportInstance({ home: src, out, version: "test" })
    expect(manifest).toMatchObject({ kind: "yzng-export", kv: 1, kvSource: "json" })
    expect(existsSync(join(out, MANIFEST_FILE))).toBe(true)
    expect(existsSync(join(out, "store", KV_DB_FILE))).toBe(true)
    expect(await readdir(join(src, "data", "store"))).toEqual(["kv.json"])

    const report = await importInstance({ from: out, home: dst, force: false })
    expect(report.backups).toEqual([])
    expect(await readFile(join(dst, "data", "plugin", "demo", "state.json"), "utf8")).toBe("{\"n\":1}")
    expect(await readFile(join(dst, "config", "yunzai.yaml"), "utf8")).toContain("10001")

    const store = await openKv({ dir: join(dst, "data", "store"), logger: silent })
    try {
      expect(await store.root.get("plugin:demo:k")).toBe("旧值")
    } finally {
      await store.close()
    }
  })

  it("导出不把存储目录本身原样拷进 data/", async () => {
    const store = await openKv({ dir: join(src, "data", "store"), logger: silent })
    await store.root.set("k", 1)
    await store.close()
    await exportInstance({ home: src, out, version: "test" })
    expect(existsSync(join(out, "data", "store"))).toBe(false)
    expect(existsSync(join(out, "store", KV_DB_FILE))).toBe(true)
  })

  it("实例还在跑（kv.db 被占着）时拒绝导出，不留半截目录", async () => {
    const store = await openKv({ dir: join(src, "data", "store"), logger: silent })
    try {
      await expect(exportInstance({ home: src, out, version: "test" })).rejects.toThrow(/实例还在跑/)
    } finally {
      await store.close()
    }
    expect(existsSync(out)).toBe(false)
  })

  it("输出目录已有东西时拒绝", async () => {
    await mkdir(out)
    await writeFile(join(out, "x"), "", "utf8")
    await expect(exportInstance({ home: src, out, version: "test" })).rejects.toBeInstanceOf(DataCommandError)
  })

  it("目标已有 KV 数据：不加 --force 拒绝；加了则原内容改名保留", async () => {
    await exportInstance({ home: src, out, version: "test" })
    const existing = await openKv({ dir: join(dst, "data", "store"), logger: silent })
    await existing.root.set("mine", true)
    await existing.close()

    await expect(importInstance({ from: out, home: dst, force: false })).rejects.toThrow(/--force/)
    const report = await importInstance({ from: out, home: dst, force: true })
    expect(report.backups.length).toBeGreaterThan(0)
    expect(report.backups.every(b => /\.before-import-\d{8}-\d{6}$/.test(b))).toBe(true)
    expect(existsSync(join(report.backups.find(b => b.includes("data")) ?? "", "store", KV_DB_FILE))).toBe(true)
  })

  it.skipIf(!OldDb).each(["当前", "换入"])("%s配置指向占用的旧 LevelDB：force 也拒绝，停机后可换入", async which => {
    await exportInstance({ home: src, out, version: "test" })
    await mkdir(join(dst, "config"), { recursive: true })
    const external = join(root, "legacy-store")
    await mkdir(external)
    const yaml = `store: {dir: ${JSON.stringify(external)}}`
    await writeFile(join(dst, "config", "yunzai.yaml"), which === "当前" ? yaml : "{}")
    if (which === "换入") await writeFile(join(out, "config", "yunzai.yaml"), yaml)
    const db = new OldDb!(join(external, "kv"))
    await db.open()
    try {
      await db.put("old", "before")
      await expect(importInstance({ home: dst, from: out, force: true })).rejects.toThrow(/正被使用/)
      expect(await readdir(dst)).toEqual(["config"])
      expect(await db.get("old")).toBe("before")
      await db.put("old", "after")
    } finally { await db.close() }
    const result = await importInstance({ home: dst, from: out, force: true })
    const preserved = which === "当前" ? external : result.backups.find(path => path.startsWith(external + ".before-import-"))!
    const old = new OldDb!(join(preserved, "kv"))
    await old.open()
    try { expect(await old.get("old")).toBe("after") } finally { await old.close() }
    expect((await readdir(root)).some(n => n.startsWith(".kv-offline-"))).toBe(false)
  })

  it.skipIf(!OldDb)("已换走旧库后遇到外置目标冲突：回滚还原原库并释放锁", async () => {
    await exportInstance({ home: src, out, version: "test" })
    const dir = join(dst, "data", "store")
    await mkdir(dir, { recursive: true })
    const db = new OldDb!(join(dir, "kv"))
    await db.open()
    try { await db.put("original", "yes") } finally { await db.close() }
    const external = join(root, "external")
    await mkdir(external)
    await writeFile(join(out, "config", "yunzai.yaml"), `store: {dir: ${JSON.stringify(external)}}`)
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      await mkdir(external + ".before-import-" + stampOf())
      await expect(importInstance({ home: dst, from: out, force: true })).rejects.toThrow(/备份路径已存在/)
    } finally { vi.useRealTimers() }
    expect(await readdir(dst)).toEqual(["data"])
    const restored = new OldDb!(join(dir, "kv"))
    await restored.open()
    try { expect(await restored.get("original")).toBe("yes") } finally { await restored.close() }
  })

  it.each(["损坏字节", "缺少数据表", "未知数据库格式", "条数不符", "清单缺少条数"])("%s：即使 --force 也不改目标或源快照", async fault => {
    await exportInstance({ home: src, out, version: "test" })
    const file = join(out, "store", KV_DB_FILE)
    if (fault === "损坏字节") await writeFile(file, "not a database")
    else if (fault === "条数不符" || fault === "清单缺少条数") {
      const file = join(out, MANIFEST_FILE)
      const manifest = JSON.parse(await readFile(file, "utf8")) as { kv?: number }
      if (fault === "条数不符") manifest.kv = 1
      else delete manifest.kv
      await writeFile(file, JSON.stringify(manifest))
    } else {
      const db = binding!.open(file)
      try {
        db.exec(fault === "缺少数据表" ? "DROP TABLE kv" : "UPDATE meta SET value = '2' WHERE key = 'format'")
      } finally {
        db.close()
      }
    }
    const before = await readFile(file)
    await mkdir(join(dst, "config"), { recursive: true })
    await mkdir(join(dst, "data"))
    await writeFile(join(dst, "config", "keep"), "原配置")
    await writeFile(join(dst, "data", "keep"), "原数据")
    await expect(importInstance({ from: out, home: dst, force: true })).rejects.toThrow(/快照校验失败|清单格式/)
    expect((await readdir(dst)).sort()).toEqual(["config", "data"])
    expect(await readFile(join(dst, "config", "keep"), "utf8")).toBe("原配置")
    expect(await readFile(join(dst, "data", "keep"), "utf8")).toBe("原数据")
    expect(await readFile(file)).toEqual(before)
  })

  it("导出包的数据目录夹带 WAL 时拒绝，不污染已校验的快照", async () => {
    await exportInstance({ home: src, out, version: "test" })
    await mkdir(join(out, "data", "store"), { recursive: true })
    await writeFile(join(out, "data", "store", `${KV_DB_FILE}-wal`), "stale")
    await expect(importInstance({ from: out, home: dst, force: true })).rejects.toThrow(/重复的 KV 快照或日志/)
    expect(await readdir(dst)).toEqual([])
  })

  it("换入第二个目录失败时还原第一个，不移动或删除冲突项", async () => {
    await exportInstance({ home: src, out, version: "test" })
    await mkdir(join(dst, "config"), { recursive: true })
    await writeFile(join(dst, "config", "keep"), "原配置")
    await writeFile(join(dst, "data"), "占用该位置的文件")
    await expect(importInstance({ from: out, home: dst, force: true })).rejects.toThrow(/目标不是普通目录/)
    expect(await readFile(join(dst, "config", "keep"), "utf8")).toBe("原配置")
    expect(await readFile(join(dst, "data"), "utf8")).toBe("占用该位置的文件")
    expect((await readdir(dst)).sort()).toEqual(["config", "data"])
  })

  it("store.dir 指向 data 根目录时普通插件状态仍可往返", async () => {
    await writeFile(join(src, "config", "yunzai.yaml"), "store: {dir: data}")
    await exportInstance({ home: src, out, version: "test" })
    await importInstance({ from: out, home: dst, force: false })
    expect(await readFile(join(dst, "data", "plugin", "demo", "state.json"), "utf8")).toBe('{"n":1}')
  })

  it("清单声明的插件 SQL 缺失时在切换目标前失败", async () => {
    const manifest = await exportInstance({ home: src, out, version: "test" })
    await writeFile(join(out, MANIFEST_FILE), JSON.stringify({ ...manifest, sql: 1 }))
    await expect(importInstance({ home: dst, from: out, force: true })).rejects.toThrow(/SQL 库数量/)
    expect(existsSync(join(dst, "config"))).toBe(false)
  })

  it("外置存储目录有无关文件时即使 force 也不移动", async () => {
    await exportInstance({ home: src, out, version: "test" })
    const shared = join(root, "shared")
    await mkdir(shared)
    await writeFile(join(shared, "keep"), "keep")
    await writeFile(join(out, "config", "yunzai.yaml"), `store: {dir: ${JSON.stringify(shared)}}`)
    await expect(importInstance({ home: dst, from: out, force: true })).rejects.toThrow(/含其他文件/)
    expect(await readFile(join(shared, "keep"), "utf8")).toBe("keep")
  })

  it("配置里原机器的绝对路径会被指出来", async () => {
    await exportInstance({ home: src, out, version: "test" })
    const report = await importInstance({ from: out, home: dst, force: false })
    expect(report.foreignPaths).toEqual([{ file: "demo.yaml", line: 1, value: "D:\\nowhere\\at\\all" }])
  })

  it("store.dir 是本机不存在的绝对路径时拒绝导入", async () => {
    await exportInstance({ home: src, out, version: "test" })
    await writeFile(join(out, "config", "yunzai.yaml"), "store:\n  dir: Z:\\gone\\store\n", "utf8")
    await expect(importInstance({ from: out, home: dst, force: false })).rejects.toThrow(/store\.dir/)
    expect(existsSync(join(dst, "config"))).toBe(false)
  })

  it("异平台绝对路径不能被当成目标主目录下的相对路径", async () => {
    await exportInstance({ home: src, out, version: "test" })
    const path = process.platform === "win32" ? "/mnt/foreign/store" : "Z:/foreign/store"
    await writeFile(join(out, "config", "yunzai.yaml"), `store: {dir: ${JSON.stringify(path)}}`)
    await expect(importInstance({ home: dst, from: out, force: true })).rejects.toThrow(/store\.dir/)
    expect(existsSync(join(dst, "config"))).toBe(false)
  })

  it("不是导出目录时拒绝", async () => {
    await mkdir(out)
    await expect(importInstance({ from: out, home: dst, force: false })).rejects.toThrow(MANIFEST_FILE)
  })
})

/**
 * 模块职责：旧版 KV → kv.db 的迁移、导出快照与 openKv 的装配规则
 * 依赖方向：测试文件
 * 生命周期：每个用例一个临时存储目录
 * 注意事项：LevelDB 的用例要真的 classic-level，本机装不上时跳过；「装不上」本身通过替换 legacyLoader 模拟。
 */
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Logger, StoredEnvelope } from "@yunzai-ng/types"
import { openKv } from "./index.js"
import { legacyLoader } from "./legacy.js"
import { migrateLegacy, snapshotKv } from "./migrate.js"
import { SqliteKvDriver } from "./sqlite-kv.js"
import { loadSqliteBinding, type SqliteBinding } from "./sqlite-binding.js"
import { Kv } from "./kv.js"

const binding = (await loadSqliteBinding()).binding
const levelCtor = (await legacyLoader.level()).ctor

/**
 * 收集日志的日志器
 * @returns 日志器与收集到的行
 */
function capture(): Logger & { lines: string[] } {
  const lines: string[] = []
  const push = (level: string) => (msg: unknown) => void lines.push(`${level} ${String(msg)}`)
  const logger = {
    lines,
    trace: push("trace"),
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    fatal: push("fatal"),
    child: () => logger,
    isLevelEnabled: () => false
  }
  return logger as unknown as Logger & { lines: string[] }
}

/**
 * 写一份旧版 JSON 数据
 * @param dir 存储目录
 * @param data 数据
 */
async function writeLegacyJson(dir: string, data: Record<string, StoredEnvelope>): Promise<void> {
  await writeFile(join(dir, "kv.json"), JSON.stringify({ format: 1, data }), "utf8")
}

/**
 * 写一份旧版 LevelDB 数据
 * @param dir 存储目录
 * @param data 数据
 */
async function writeLegacyLevel(dir: string, data: Record<string, StoredEnvelope>): Promise<void> {
  const db = await openLegacyLevel(dir)
  try {
    for (const [k, v] of Object.entries(data)) await db.put(k, v)
  } finally {
    await db.close()
  }
}

async function openLegacyLevel(dir: string) {
  const { ClassicLevel } = await import("classic-level")
  const db = new ClassicLevel<string, StoredEnvelope>(join(dir, "kv"), { valueEncoding: "json" })
  await db.open()
  return db
}

async function hashes(dir: string, locked = false) {
  const files = (await readdir(dir)).sort()
  return Promise.all(files.map(async file => [file, locked && file === "LOCK" ? null :
    createHash("sha256").update(await readFile(join(dir, file))).digest("hex")]))
}

describe.skipIf(binding === undefined)("旧版 KV 迁移", () => {
  let dir: string
  let logger: ReturnType<typeof capture>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "yzng-migrate-"))
    logger = capture()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
  })

  it("JSON → kv.db：数据都在，过期的不带，原文件改名保留", async () => {
    await writeLegacyJson(dir, {
      "plugin:a:x": { v: { n: 1 } },
      "plugin:a:y": { v: "保留", e: Date.now() + 3_600_000 },
      "plugin:a:gone": { v: 1, e: Date.now() - 1000 }
    })
    const store = await openKv({ dir, logger })
    try {
      expect(store.driver).toBe("sqlite")
      expect(await store.root.get("plugin:a:x")).toEqual({ n: 1 })
      expect(await store.root.get("plugin:a:y")).toBe("保留")
      expect(await store.root.ttl("plugin:a:y")).toBeGreaterThan(0)
      expect(await store.root.get("plugin:a:gone")).toBeUndefined()
    } finally {
      await store.close()
    }
    const files = await readdir(dir)
    expect(files).toContain("kv.db")
    expect(files).not.toContain("kv.json")
    expect(files.some(f => /^kv\.json\.migrated-\d{8}-\d{6}$/.test(f))).toBe(true)
    expect(logger.lines.some(l => l.includes("迁入") && l.includes("2 条"))).toBe(true)
  })

  it("迁移只做一次：第二次启动直接用 kv.db", async () => {
    await writeLegacyJson(dir, { k: { v: 1 } })
    await (await openKv({ dir, logger })).close()
    const again = await openKv({ dir, logger: capture() })
    try {
      expect(await again.root.get("k")).toBe(1)
    } finally {
      await again.close()
    }
  })

  it.skipIf(levelCtor === undefined)("LevelDB → kv.db，原目录改名保留", async () => {
    await writeLegacyLevel(dir, { "plugin:b:1": { v: [1, 2] }, "plugin:b:2": { v: true } })
    const before = await hashes(join(dir, "kv"))
    const store = await openKv({ dir, driver: "level", logger })
    try {
      expect(await store.root.get("plugin:b:1")).toEqual([1, 2])
      expect(await store.root.get("plugin:b:2")).toBe(true)
    } finally {
      await store.close()
    }
    const files = await readdir(dir)
    expect(files).not.toContain("kv")
    const archived = files.find(f => /^kv\.migrated-\d{8}-\d{6}$/.test(f))
    expect(files.sort()).toEqual(["kv.db", archived])
    expect(await hashes(join(dir, archived!))).toEqual(before)
  }, 15_000)

  it("classic-level 装不上时报错并指路，什么都不动", async () => {
    // 造一个看着像 LevelDB 的目录即可：加载就失败了，不会真去读
    await mkdir(join(dir, "kv"))
    await writeFile(join(dir, "kv", "CURRENT"), "MANIFEST-000001\n", "utf8")
    vi.spyOn(legacyLoader, "level").mockResolvedValue({ reason: "Cannot find module 'classic-level'" })

    await expect(openKv({ dir, logger })).rejects.toThrow(/classic-level.*yzng data export/s)
    const files = await readdir(dir)
    expect(files).toEqual(["kv"])
  })

  it("空的 kv/ 目录（level 打开失败留下的）不算旧数据", async () => {
    await mkdir(join(dir, "kv"))
    const store = await openKv({ dir, logger })
    await store.close()
    const files = await readdir(dir)
    expect(files).toContain("kv")
    expect(files).toContain("kv.db")
  })

  it("上次迁移中途被杀留下的临时文件，下次删掉重来", async () => {
    await writeLegacyJson(dir, { k: { v: "真" } })
    await writeFile(join(dir, "kv.db.migrating"), "半截", "utf8")
    const store = await openKv({ dir, logger })
    try {
      expect(await store.root.get("k")).toBe("真")
    } finally {
      await store.close()
    }
    expect(await readdir(dir)).not.toContain("kv.db.migrating")
  })

  it("未知 JSON 格式版本：拒绝迁移，保留原文件且不留下数据库", async () => {
    const file = join(dir, "kv.json")
    const text = JSON.stringify({ format: 2, records: ["新结构"] })
    await writeFile(file, text)
    await expect(openKv({ dir, logger }).then(store => store.close())).rejects.toThrow(/kv\.json.*格式版本 2/)
    expect((await readdir(dir)).sort()).toEqual([".kv-json-migration.lock", "kv.json"])
    expect(await readFile(file, "utf8")).toBe(text)
  })

  it.each(["{ 这不是 json", "null", '{"data":{}}', '{"format":1,"data":null}'])("旧 JSON 损坏（%s）：挪开留证，从空库启动", async text => {
    await writeFile(join(dir, "kv.json"), text, "utf8")
    const store = await openKv({ dir, logger })
    await store.close()
    const files = await readdir(dir)
    expect(files).toContain("kv.db")
    expect(files.some(f => f.startsWith("kv.json.corrupt-"))).toBe(true)
    expect(logger.lines.some(l => l.startsWith("warn") && l.includes("已损坏"))).toBe(true)
  })

  it("kv.db 已在用时，旁边的旧数据不读、不动，只告警", async () => {
    await (await openKv({ dir, logger })).close()
    await writeLegacyJson(dir, { k: { v: 1 } })
    const fresh = capture()
    const store = await openKv({ dir, logger: fresh })
    try {
      expect(await store.root.get("k")).toBeUndefined()
    } finally {
      await store.close()
    }
    expect(await readdir(dir)).toContain("kv.json")
    expect(fresh.lines.some(l => l.startsWith("warn") && l.includes("不会被读取"))).toBe(true)
  })

  it("两种旧来源并存：启动与导出均拒绝，不改动原件", async () => {
    await mkdir(join(dir, "kv"))
    await writeFile(join(dir, "kv", "CURRENT"), "MANIFEST-000001\n")
    await writeLegacyJson(dir, { k: { v: "保留" } })
    const level = await hashes(join(dir, "kv"))
    const json = await readFile(join(dir, "kv.json"))
    await expect(openKv({ dir, logger })).rejects.toThrow(/同时发现.*移出存储目录/)
    await expect(snapshotKv(dir, join(dir, "export.db"), binding!)).rejects.toThrow(/同时发现/)
    expect((await readdir(dir)).sort()).toEqual(["kv", "kv.json"])
    expect(await hashes(join(dir, "kv"))).toEqual(level)
    expect(await readFile(join(dir, "kv.json"))).toEqual(json)
  })

  it("选定的 JSON 在读前消失：报错且不发布空库", async () => {
    await writeLegacyJson(dir, { k: { v: 1 } })
    const open = SqliteKvDriver.prototype.open
    vi.spyOn(SqliteKvDriver.prototype, "open").mockImplementationOnce(async function (this: SqliteKvDriver) {
      await open.call(this)
      await rm(join(dir, "kv.json"))
    })
    await expect(migrateLegacy(dir, binding!, logger)).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readdir(dir)).toEqual([".kv-json-migration.lock"])
  })

  it("并发迁移者不能清理持锁者的半成品，完成后只打开已发布的库", async () => {
    await writeLegacyJson(dir, { k: { v: "保留" } })
    let signalReady!: () => void, resume!: () => void
    const ready = new Promise<void>(resolve => { signalReady = resolve })
    const gate = new Promise<void>(resolve => { resume = resolve })
    const open = SqliteKvDriver.prototype.open
    vi.spyOn(SqliteKvDriver.prototype, "open").mockImplementationOnce(async function (this: SqliteKvDriver) {
      await open.call(this)
      signalReady()
      await gate
    })
    const first = migrateLegacy(dir, binding!, logger)
    try {
      await Promise.race([ready, first.then(() => { throw new Error("未到达迁移屏障") })])
      await expect(migrateLegacy(dir, binding!, logger)).rejects.toThrow(/locked|busy/i)
      expect(await stat(join(dir, "kv.db.migrating"))).toBeDefined()
    } finally {
      resume()
      expect((await first)?.entries).toBe(1)
    }
    expect(await migrateLegacy(dir, binding!, logger)).toBeUndefined()
    const store = await openKv({ dir, logger })
    try { expect(await store.root.get("k")).toBe("保留") } finally { await store.close() }
  })

  it("驱动 id 只认 sqlite / memory，旧名照收", async () => {
    await expect(openKv({ dir, driver: "redis", logger })).rejects.toThrow("不认识的 KV 驱动 redis")
    for (const old of ["auto", "level", "json"]) {
      const store = await openKv({ dir, driver: old, logger })
      expect(store.driver).toBe("sqlite")
      await store.close()
    }
  })

  it("两个实例指向同一目录：第二个报占用，不悄悄开一份空库", async () => {
    const first = await openKv({ dir, logger })
    try {
      await expect(openKv({ dir, logger })).rejects.toThrow(/被另一个进程占用/)
    } finally {
      await first.close()
    }
  }, 15_000)
})

describe.skipIf(binding === undefined)("导出快照", () => {
  let dir: string
  let out: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "yzng-snap-src-"))
    out = join(await mkdtemp(join(tmpdir(), "yzng-snap-out-")), "kv.db")
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
    await rm(dirname(out), { recursive: true, force: true })
  })

  /**
   * 读快照里的一个键
   * @param key 键
   * @returns 值
   */
  async function readOut(key: string): Promise<unknown> {
    const driver = new SqliteKvDriver(out, binding as SqliteBinding)
    await driver.open()
    try {
      return await new Kv(driver).get(key)
    } finally {
      await driver.close()
    }
  }

  it("源是 kv.db：拷出一份独立文件", async () => {
    const store = await openKv({ dir, logger: capture() })
    await store.root.set("k", "值")
    await store.close()
    expect(await snapshotKv(dir, out, binding as SqliteBinding)).toEqual({ entries: 1, source: "kv.db" })
    expect(await readOut("k")).toBe("值")
  })

  it.skipIf(levelCtor === undefined)("停机 LevelDB 导出：保留源文件集与逐文件 SHA-256", async () => {
    await writeLegacyLevel(dir, { k: { v: "旧" }, expired: { v: false, e: 1 } })
    const level = join(dir, "kv")
    const before = await hashes(level)
    expect(await snapshotKv(dir, out, binding!)).toEqual({ entries: 1, source: "level" })
    expect(await readOut("k")).toBe("旧")
    expect(await hashes(level)).toEqual(before)
    expect(await readdir(dir)).toEqual(["kv"])
  })

  it.skipIf(levelCtor === undefined)("旧库占用：启动与导出均拒绝，不轮换源日志、不留输出", async () => {
    const db = await openLegacyLevel(dir)
    try {
      await db.put("k", { v: 1 })
      const before = await hashes(join(dir, "kv"), true)
      await expect(openKv({ dir, logger: capture() })).rejects.toThrow(/占用/)
      await expect(snapshotKv(dir, out, binding!)).rejects.toMatchObject({ code: "LEVEL_LOCKED" })
      expect(await hashes(join(dir, "kv"), true)).toEqual(before)
      expect(await readdir(dir)).toEqual(["kv"])
      expect(await readdir(dirname(out))).toEqual([])
      await db.put("k", { v: 2 })
    } finally {
      await db.close()
    }
  }, 20_000)

  it.skipIf(levelCtor === undefined)("旧库缺少 LOCK：不补造锁、不尝试裸拷", async () => {
    await writeLegacyLevel(dir, { k: { v: 1 } })
    const level = join(dir, "kv")
    await rm(join(level, "LOCK"))
    const before = await hashes(level)
    await expect(snapshotKv(dir, out, binding!)).rejects.toThrow(/LOCK/)
    expect(await hashes(level)).toEqual(before)
    expect(await readdir(dirname(out))).toEqual([])
  })

  it("源是旧 JSON：转成 kv.db，源目录原样不动", async () => {
    await writeLegacyJson(dir, { k: { v: "旧" } })
    const before = (await stat(join(dir, "kv.json"))).mtimeMs
    expect(await snapshotKv(dir, out, binding as SqliteBinding)).toEqual({ entries: 1, source: "json" })
    expect(await readOut("k")).toBe("旧")
    expect(await readdir(dir)).toEqual(["kv.json"])
    expect((await stat(join(dir, "kv.json"))).mtimeMs).toBe(before)
  })

  it("未知 JSON 格式版本：拒绝导出，不改源文件也不生成快照", async () => {
    const file = join(dir, "kv.json")
    const text = JSON.stringify({ format: 2, data: { k: { v: 1 } } })
    await writeFile(file, text)
    await expect(snapshotKv(dir, out, binding as SqliteBinding)).rejects.toThrow(/kv\.json.*格式版本 2/)
    expect(await readdir(dir)).toEqual(["kv.json"])
    expect(await readFile(file, "utf8")).toBe(text)
    await expect(stat(out)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("实例还在跑（kv.db 被占着）时报错", async () => {
    const store = await openKv({ dir, logger: capture() })
    try {
      await expect(snapshotKv(dir, out, binding as SqliteBinding)).rejects.toThrow(/locked|busy/i)
    } finally {
      await store.close()
    }
  })

  it("没有任何数据：给一份空库", async () => {
    expect(await snapshotKv(dir, out, binding as SqliteBinding)).toEqual({ entries: 0, source: "empty" })
  })
})

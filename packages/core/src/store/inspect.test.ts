/**
 * 模块职责：存储检视面的行为测试
 * 依赖方向：测试文件，依赖 store/{inspect,memory,sql}
 * 生命周期：KV 每个用例一个内存驱动；SQL 每个用例一个临时库
 * 注意事项：better-sqlite3 装不上时 SQL 那组整体跳过，同 sql.test.ts。
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { MemoryKvDriver } from "./memory.js"
import { StorageError, createKvInspector, guardStatement, listSqlTables, sqlCellOf, type KvInspector } from "./inspect.js"
import { loadSqlite, openSql, type SqlStore } from "./sql.js"

describe("KV 检视器", () => {
  let driver: MemoryKvDriver
  let inspector: KvInspector

  beforeEach(async () => {
    driver = new MemoryKvDriver()
    await driver.open()
    inspector = createKvInspector(driver)
    // 故意乱序写入：内存驱动的 scan 是插入序，浏览结果必须按字典序
    await driver.set("plugin:b:x", { v: 1 })
    await driver.set("plugin:a:y", { v: "文本" })
    await driver.set("plugin:a:z", { v: { deep: [1, 2] } })
    await driver.set("accounts:r1", { v: { id: "r1" } })
    await driver.set("top2", { v: true })
    await driver.set("top1", { v: null })
    await driver.set("gone", { v: 1, e: Date.now() - 1 })
  })

  it("根前缀下分出子命名空间与直属键，过期键不计", async () => {
    const page = await inspector.browse()
    expect(page.groups).toEqual([
      { name: "accounts:", count: 1 },
      { name: "plugin:", count: 3 }
    ])
    expect(page.items.map(i => i.key)).toEqual(["top1", "top2"])
    expect(page.total).toBe(2)
    expect(page.truncated).toBe(false)
    expect(page.next).toBeUndefined()
  })

  it("逐层下钻，列表项带类型、体积与预览", async () => {
    const plugin = await inspector.browse({ prefix: "plugin:" })
    expect(plugin.groups.map(g => g.name)).toEqual(["a:", "b:"])

    const a = await inspector.browse({ prefix: "plugin:a:" })
    expect(a.items.map(i => [i.key, i.type])).toEqual([
      ["plugin:a:y", "string"],
      ["plugin:a:z", "object"]
    ])
    expect(a.items[0]!.preview).toBe("文本")
    expect(a.items[1]!.size).toBe(Buffer.byteLength(JSON.stringify({ deep: [1, 2] })))
  })

  it("按游标分页，最后一页不给 next", async () => {
    for (let i = 0; i < 5; i++) await driver.set(`p:k${i}`, { v: i })
    const first = await inspector.browse({ prefix: "p:", limit: 2 })
    expect(first.items.map(i => i.key)).toEqual(["p:k0", "p:k1"])
    expect(first.next).toBe("p:k1")

    const third = await inspector.browse({ prefix: "p:", limit: 2, after: "p:k3" })
    expect(third.items.map(i => i.key)).toEqual(["p:k4"])
    expect(third.next).toBeUndefined()
  })

  it("读写删，过期键读作不存在", async () => {
    expect(await inspector.read("gone")).toBeUndefined()
    expect(await inspector.remove("gone")).toBe(false)

    const at = Date.now() + 60_000
    await inspector.write("new:key", { a: 1 }, at)
    expect(await inspector.read("new:key")).toEqual({ key: "new:key", value: { a: 1 }, expireAt: at })

    expect(await inspector.remove("new:key")).toBe(true)
    expect(await inspector.read("new:key")).toBeUndefined()
  })

  it("按前缀清空，空前缀拒绝", async () => {
    expect(await inspector.removePrefix("plugin:a:")).toBe(2)
    expect((await inspector.browse({ prefix: "plugin:" })).groups).toEqual([{ name: "b:", count: 1 }])
    await expect(inspector.removePrefix("")).rejects.toBeInstanceOf(StorageError)
  })

  it("空键与 undefined 值拒绝写入", async () => {
    await expect(inspector.write("", 1)).rejects.toMatchObject({ statusCode: 400 })
    await expect(inspector.write("k", undefined)).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe("面板语句守卫", () => {
  it("放行普通语句，返回去掉开头注释后的文本", () => {
    expect(guardStatement("  -- 注释\n/* 块 */ SELECT 1")).toBe("SELECT 1")
  })

  it.each(["", "  -- 只有注释", "ATTACH 'x.db' AS x", "vacuum into 'x.db'", "BEGIN", "/* c */ commit", "SAVEPOINT s"])(
    "拦下 %j",
    sql => {
      expect(() => guardStatement(sql)).toThrow(StorageError)
    }
  )

  it("单元格：二进制摘成长度加开头，bigint 按安全整数取舍", () => {
    expect(sqlCellOf(new Uint8Array([0xab, 0xcd]))).toEqual({ $blob: 2, head: "abcd" })
    expect(sqlCellOf(42n)).toBe(42)
    expect(sqlCellOf(2n ** 60n)).toBe((2n ** 60n).toString())
  })
})

const ctor = await loadSqlite()

describe.skipIf(!ctor)("SQLite 面板语句", () => {
  let dir: string
  let store: SqlStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "yzng-inspect-"))
    store = (await openSql({ file: join(dir, "data.db"), ctor }))!
    await store.handle.run("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL, b BLOB)")
    await store.handle.run("CREATE TABLE w (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID")
    await store.handle.run("CREATE VIEW vt AS SELECT name FROM t")
    for (let i = 1; i <= 3; i++) await store.handle.run("INSERT INTO t (name) VALUES (?)", [`n${i}`])
  })

  afterEach(async () => {
    store.close()
    await rm(dir, { recursive: true, force: true })
  })

  it("列出表与视图，标出有无 rowid", async () => {
    const tables = await listSqlTables(store.handle)
    expect(tables.map(t => [t.name, t.type, t.rowid])).toEqual([
      ["t", "table", true],
      ["vt", "view", false],
      ["w", "table", false]
    ])
    expect(tables[0]!.columns.find(c => c.name === "name")).toMatchObject({ type: "TEXT", notnull: true, pk: 0 })
  })

  it("查询按数组返回行，超出上限标明截断", async () => {
    const res = await store.exec("SELECT id, name FROM t ORDER BY id", [], { limit: 2, allowWrite: false })
    expect(res.readonly).toBe(true)
    expect(res.columns).toEqual(["id", "name"])
    expect(res.rows).toEqual([
      [1, "n1"],
      [2, "n2"]
    ])
    expect(res.truncated).toBe(true)
  })

  it("写语句报受影响行数；只读时 403 且库不变", async () => {
    const done = await store.exec("UPDATE t SET name = ? WHERE id = ?", ["改", 1], { limit: 10, allowWrite: true })
    expect(done).toMatchObject({ readonly: false, changes: 1 })

    await expect(
      store.exec("DELETE FROM t", [], { limit: 10, allowWrite: false })
    ).rejects.toMatchObject({ statusCode: 403 })
    expect(await store.handle.get<{ n: number }>("SELECT count(*) AS n FROM t")).toEqual({ n: 3 })
  })

  it("多语句与语法错误一律 400", async () => {
    await expect(store.exec("SELECT 1; SELECT 2", [], { limit: 10, allowWrite: true })).rejects.toMatchObject({
      statusCode: 400
    })
    await expect(store.exec("SELEC 1", [], { limit: 10, allowWrite: true })).rejects.toMatchObject({ statusCode: 400 })
  })

  it("面板语句不污染插件的语句缓存", async () => {
    // raw() 改的是语句对象本身；若共用缓存，插件随后的 all() 会拿到数组而非对象
    await store.exec("SELECT name FROM t WHERE id = 1", [], { limit: 10, allowWrite: false })
    expect(await store.handle.all("SELECT name FROM t WHERE id = 1")).toEqual([{ name: "n1" }])
  })
})

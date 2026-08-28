/**
 * 模块职责：SQLite 存储的行为测试
 * 依赖方向：测试文件
 * 生命周期：每个用例一个临时数据库文件
 * 注意事项：better-sqlite3 是可选原生模块，装不上时整组跳过而不是报红。
 *          重点覆盖异步事务的正确性 —— 这是本模块唯一有真实并发风险的地方。
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { SqlHandle, SqlMigration } from "@yunzai-ng/types"
import { loadSqlite, openSql, type SqlStore } from "./sql.js"

const ctor = await loadSqlite()

describe.skipIf(!ctor)("SQLite 存储", () => {
  let dir: string
  let store: SqlStore
  let db: SqlHandle

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "yzng-sql-"))
    const opened = await openSql({ file: join(dir, "data.db"), ctor })
    store = opened!
    db = store.handle
    await db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, n INTEGER DEFAULT 0)")
  })

  afterEach(async () => {
    store.close()
    await rm(dir, { recursive: true, force: true })
  })

  it("run / all / get 的基本语义", async () => {
    const inserted = await db.run("INSERT INTO t (name, n) VALUES (?, ?)", ["甲", 1])
    expect(inserted.changes).toBe(1)
    expect(Number(inserted.lastInsertRowid)).toBe(1)

    await db.run("INSERT INTO t (name, n) VALUES (?, ?)", ["乙", 2])
    expect(await db.all("SELECT name FROM t ORDER BY id")).toEqual([{ name: "甲" }, { name: "乙" }])
    expect(await db.get("SELECT n FROM t WHERE name = ?", ["乙"])).toEqual({ n: 2 })
    // 无结果统一返回 undefined，而不是 null
    expect(await db.get("SELECT n FROM t WHERE name = ?", ["丙"])).toBeUndefined()
  })

  it("不带参数的多语句脚本可以一次执行（迁移常用）", async () => {
    await db.run(`
      CREATE TABLE a (id INTEGER PRIMARY KEY);
      CREATE INDEX idx_a ON a (id);
    `)
    const tables = await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
    expect(tables.map(r => r.name)).toContain("a")
  })

  it("语句里的分号字面量不会被误判成多语句", async () => {
    await db.run("INSERT INTO t (name) VALUES (?)", ["带;分号"])
    expect(await db.get("SELECT name FROM t WHERE name = ?", ["带;分号"])).toEqual({ name: "带;分号" })
  })

  it("事务提交后数据可见", async () => {
    await db.transaction(async tx => {
      await tx.run("INSERT INTO t (name) VALUES (?)", ["甲"])
      await tx.run("INSERT INTO t (name) VALUES (?)", ["乙"])
    })
    expect(await db.get("SELECT COUNT(*) AS c FROM t")).toEqual({ c: 2 })
  })

  it("事务体抛错时整体回滚，错误照原样冒出", async () => {
    await expect(
      db.transaction(async tx => {
        await tx.run("INSERT INTO t (name) VALUES (?)", ["甲"])
        throw new Error("业务失败")
      })
    ).rejects.toThrow("业务失败")

    expect(await db.get("SELECT COUNT(*) AS c FROM t")).toEqual({ c: 0 })
  })

  it("事务里 await 别的异步操作也不会串台（互斥锁生效）", async () => {
    // 两个事务同时开：若没有互斥锁，第二个 BEGIN 会撞上
    // "cannot start a transaction within a transaction"
    const one = db.transaction(async tx => {
      await tx.run("INSERT INTO t (name) VALUES (?)", ["甲"])
      await new Promise(r => setTimeout(r, 30))
      await tx.run("INSERT INTO t (name) VALUES (?)", ["乙"])
    })
    const two = db.transaction(async tx => {
      await tx.run("INSERT INTO t (name) VALUES (?)", ["丙"])
    })

    await Promise.all([one, two])
    expect(await db.get("SELECT COUNT(*) AS c FROM t")).toEqual({ c: 3 })
  })

  it("并发事务不会互相回滚对方的写入", async () => {
    await db.run("INSERT INTO t (id, name, n) VALUES (1, '计数', 0)")

    const bump = () =>
      db.transaction(async tx => {
        const row = await tx.get<{ n: number }>("SELECT n FROM t WHERE id = 1")
        await tx.run("UPDATE t SET n = ? WHERE id = 1", [(row?.n ?? 0) + 1])
      })

    await Promise.all(Array.from({ length: 20 }, bump))
    expect(await db.get("SELECT n FROM t WHERE id = 1")).toEqual({ n: 20 })
  })

  it("嵌套事务用 SAVEPOINT：内层回滚不牵连外层", async () => {
    await db.transaction(async tx => {
      await tx.run("INSERT INTO t (name) VALUES (?)", ["外层"])
      await expect(
        tx.transaction(async inner => {
          await inner.run("INSERT INTO t (name) VALUES (?)", ["内层"])
          throw new Error("内层失败")
        })
      ).rejects.toThrow("内层失败")
    })

    const names = await db.all<{ name: string }>("SELECT name FROM t")
    expect(names.map(r => r.name)).toEqual(["外层"])
  })

  it("迁移按版本号依次执行且幂等", async () => {
    const log: string[] = []
    const migrations: SqlMigration[] = [
      {
        version: 2,
        name: "加索引",
        up: async tx => {
          log.push("v2")
          await tx.run("CREATE INDEX idx_name ON t (name)")
        }
      },
      {
        version: 1,
        name: "建表",
        up: async tx => {
          log.push("v1")
          await tx.run("CREATE TABLE m (id INTEGER PRIMARY KEY)")
        }
      }
    ]

    await db.migrate(migrations)
    expect(log).toEqual(["v1", "v2"])

    // 再跑一次什么都不该发生
    await db.migrate(migrations)
    expect(log).toEqual(["v1", "v2"])

    // 新增一条只跑新的
    migrations.push({
      version: 3,
      name: "再加一张表",
      up: async tx => {
        log.push("v3")
        await tx.run("CREATE TABLE m2 (id INTEGER PRIMARY KEY)")
      }
    })
    await db.migrate(migrations)
    expect(log).toEqual(["v1", "v2", "v3"])
  })

  it("迁移失败时该条回滚，且不会被记为已应用", async () => {
    const migrations: SqlMigration[] = [
      {
        version: 1,
        name: "会失败的迁移",
        up: async tx => {
          await tx.run("CREATE TABLE ok (id INTEGER PRIMARY KEY)")
          await tx.run("这不是 SQL")
        }
      }
    ]

    await expect(db.migrate(migrations)).rejects.toThrow()

    const tables = await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
    expect(tables.map(r => r.name)).not.toContain("ok")
    expect(await db.get("SELECT COUNT(*) AS c FROM _yzng_migrations")).toEqual({ c: 0 })
  })

  it("版本号重复直接报错，而不是随机执行一条", async () => {
    await expect(
      db.migrate([
        { version: 1, name: "甲", up: async () => undefined },
        { version: 1, name: "乙", up: async () => undefined }
      ])
    ).rejects.toThrow(/重复/)
  })

  it("重开文件后数据仍在", async () => {
    await db.run("INSERT INTO t (name) VALUES (?)", ["持久"])
    const file = store.file
    store.close()

    const reopened = (await openSql({ file, ctor }))!
    expect(await reopened.handle.get("SELECT name FROM t")).toEqual({ name: "持久" })
    reopened.close()
    // afterEach 会再 close 一次，close 必须可重复调用
    store = reopened
  })
})

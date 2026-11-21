/**
 * 模块职责：KV 层的契约测试（同一套用例覆盖 memory 与 SQLite 的两种绑定）
 * 依赖方向：测试文件
 * 生命周期：每个驱动一个临时目录
 * 注意事项：**同一套用例覆盖全部驱动**：两种驱动语义必须一致，内存驱动下能跑通的代码换到 SQLite 照样跑通。
 *          SQLite 的两种绑定读写同一种文件，各跑一遍；某个绑定在本机不可用时该组用 skipIf 跳过，
 *          报告里显示为「跳过」而不是「通过」。
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { KvDriver, KvNamespace } from "@yunzai-ng/types"
import { Kv } from "./kv.js"
import { MemoryKvDriver } from "./memory.js"
import { SqliteKvDriver } from "./sqlite-kv.js"
import { loadBetterSqlite, loadNodeSqlite, type SqliteBinding } from "./sqlite-binding.js"

const better = (await loadBetterSqlite()).binding
const builtin = (await loadNodeSqlite()).binding

/** 待测驱动的构造方式 */
interface DriverCase {
  /** 名称 */
  name: string
  /** 本机是否可用 */
  available: boolean
  /** 造一个未 open 的驱动 */
  make(dir: string): KvDriver
}

/**
 * SQLite 驱动的用例
 * @param binding 绑定
 * @param name 名称
 * @returns 用例
 */
function sqliteCase(binding: SqliteBinding | undefined, name: string): DriverCase {
  return {
    name,
    available: binding !== undefined,
    make: dir => new SqliteKvDriver(join(dir, "kv.db"), binding as SqliteBinding)
  }
}

const cases: DriverCase[] = [
  { name: "memory", available: true, make: () => new MemoryKvDriver() },
  sqliteCase(better, "sqlite · better-sqlite3"),
  sqliteCase(builtin, "sqlite · node:sqlite")
]

for (const driverCase of cases) {
  describe.skipIf(!driverCase.available)(`KV 契约 · ${driverCase.name}`, () => {
    let dir: string
    let driver: KvDriver
    let kv: KvNamespace

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "yzng-kv-"))
      driver = driverCase.make(dir)
      await driver.open()
      kv = new Kv(driver)
    })

    afterEach(async () => {
      await driver.close()
      await rm(dir, { recursive: true, force: true })
    })

    it("读写删的基本语义", async () => {
      expect(await kv.get("a")).toBeUndefined()
      await kv.set("a", { n: 1, list: ["x"] })
      expect(await kv.get("a")).toEqual({ n: 1, list: ["x"] })
      expect(await kv.has("a")).toBe(true)

      await kv.del("a")
      expect(await kv.has("a")).toBe(false)
      // 删不存在的键不应抛错
      await kv.del("a")
    })

    it("getOr 只在缺失时给默认值，false / 0 / null 都要原样返回", async () => {
      expect(await kv.getOr("missing", "兜底")).toBe("兜底")
      await kv.set("flag", false)
      await kv.set("zero", 0)
      await kv.set("nil", null)
      expect(await kv.getOr("flag", true)).toBe(false)
      expect(await kv.getOr("zero", 99)).toBe(0)
      expect(await kv.getOr("nil", "兜底")).toBeNull()
    })

    it("存进去的对象与外部引用解耦（改外部变量不影响已存的值）", async () => {
      const obj = { list: [1, 2] }
      await kv.set("k", obj)
      obj.list.push(3)
      expect(await kv.get("k")).toEqual({ list: [1, 2] })

      // 读出来的对象也不能是内部引用
      const read = (await kv.get<{ list: number[] }>("k"))!
      read.list.push(99)
      expect(await kv.get("k")).toEqual({ list: [1, 2] })
    })

    it("TTL 到期后视为不存在，并且不再出现在遍历里", async () => {
      // TTL 取 150ms：太短会与一次写读往返赛跑，`set` 之后紧接的 `get` 合法地读到已过期
      await kv.set("short", 1, { ttl: 150 })
      await kv.set("long", 2, { ttl: "1h" })
      expect(await kv.get("short")).toBe(1)

      await new Promise(r => setTimeout(r, 300))
      expect(await kv.get("short")).toBeUndefined()
      expect(await kv.has("short")).toBe(false)

      const keys: string[] = []
      for await (const key of kv.keys()) keys.push(key)
      expect(keys).toEqual(["long"])
    })

    it("ttl() 报告剩余时间：永久为 Infinity，缺失为 -1", async () => {
      await kv.set("forever", 1)
      await kv.set("temp", 1, { ttl: "10s" })
      expect(await kv.ttl("forever")).toBe(Number.POSITIVE_INFINITY)
      expect(await kv.ttl("nope")).toBe(-1)

      const left = await kv.ttl("temp")
      expect(left).toBeGreaterThan(8000)
      expect(left).toBeLessThanOrEqual(10_000)
    })

    it("incr 在并发下不丢计数", async () => {
      const results = await Promise.all(Array.from({ length: 50 }, () => kv.incr("count")))
      expect(await kv.get("count")).toBe(50)
      // 每次调用都应拿到唯一的序号，说明确实串行
      expect(new Set(results).size).toBe(50)
    })

    it("incr 的 ttl 只在首次创建时生效，自增不会续命", async () => {
      await kv.incr("c", 1, { ttl: "10s" })
      const first = await kv.ttl("c")
      await new Promise(r => setTimeout(r, 30))
      await kv.incr("c", 1)
      const second = await kv.ttl("c")
      expect(await kv.get("c")).toBe(2)
      expect(second).toBeLessThan(first)
    })

    it("incr 遇到过期键从 0 重新开始", async () => {
      await kv.incr("c", 5, { ttl: 150 })
      await new Promise(r => setTimeout(r, 300))
      expect(await kv.incr("c")).toBe(1)
    })

    it("遍历只看得到本命名空间的键，且键名已剥掉前缀", async () => {
      const a = kv.sub("plugin-a")
      const b = kv.sub("plugin-b")
      await a.set("k1", 1)
      await a.set("k2", 2)
      await b.set("k1", 3)

      const entries: [string, unknown][] = []
      for await (const entry of a.entries()) entries.push([entry[0], entry[1]])
      expect(entries.sort()).toEqual([
        ["k1", 1],
        ["k2", 2]
      ])
      expect(await b.get("k1")).toBe(3)
    })

    it("同名子命名空间不会相互覆盖键", async () => {
      const a = kv.sub("x").sub("y")
      const b = kv.sub("xy")
      await a.set("k", "深层")
      await b.set("k", "同名")
      expect(await a.get("k")).toBe("深层")
      expect(await b.get("k")).toBe("同名")
    })

    it("按前缀遍历与按前缀清空", async () => {
      await kv.set("user:1", "a")
      await kv.set("user:2", "b")
      await kv.set("group:1", "c")

      const userKeys: string[] = []
      for await (const key of kv.keys("user:")) userKeys.push(key)
      expect(userKeys.sort()).toEqual(["user:1", "user:2"])

      expect(await kv.clear("user:")).toBe(2)
      expect(await kv.get("user:1")).toBeUndefined()
      expect(await kv.get("group:1")).toBe("c")

      expect(await kv.clear()).toBe(1)
    })

    it("清空子命名空间不影响父命名空间的其他键", async () => {
      await kv.set("root-key", 1)
      const sub = kv.sub("child")
      await sub.set("k", 2)

      expect(await sub.clear()).toBe(1)
      expect(await kv.get("root-key")).toBe(1)
    })

    it("拒绝含分隔符的子命名空间名（否则两个不同子空间会拼出同一前缀）", () => {
      expect(() => kv.sub("a:b")).toThrow(/不能含/)
      expect(() => kv.sub("")).toThrow(/不能为空/)
    })

    it("键里含中文与 emoji 也能正确前缀扫描", async () => {
      // 按字节序排列时，四字节字符是"自行计算上界"写法的典型漏键场景
      await kv.set("用户:甲", 1)
      await kv.set("用户:🙂", 2)
      await kv.set("别的:乙", 3)

      const keys: string[] = []
      for await (const key of kv.keys("用户:")) keys.push(key)
      expect(keys.sort()).toEqual(["用户:甲", "用户:🙂"].sort())
    })

    it("遍历跨页且中途读写不出错", async () => {
      // 超过一页（256），并在遍历途中写入：驱动不能在页与页之间持有游标
      for (let i = 0; i < 600; i++) await kv.set(`p:${String(i).padStart(4, "0")}`, i)
      let seen = 0
      for await (const [key, value] of kv.entries<number>("p:")) {
        expect(key).toBe(`p:${String(value).padStart(4, "0")}`)
        if (seen === 300) await kv.set("other", true)
        seen++
      }
      expect(seen).toBe(600)
      expect(await kv.get("other")).toBe(true)
    })

    it("存 undefined 与存 null 分得开", async () => {
      await kv.set("u", undefined)
      await kv.set("n", null)
      expect(await kv.get("u")).toBeUndefined()
      expect(await kv.get("n")).toBeNull()
    })
  })
}

describe.skipIf(better === undefined && builtin === undefined)("SQLite 驱动的落盘与独占", () => {
  const binding = (better ?? builtin) as SqliteBinding
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "yzng-kv-sqlite-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("close() 后重新打开，数据仍在", async () => {
    const file = join(dir, "kv.db")
    const first = new SqliteKvDriver(file, binding)
    await first.open()
    await new Kv(first).set("a", { hello: "世界" })
    await first.close()

    const second = new SqliteKvDriver(file, binding)
    await second.open()
    expect(await new Kv(second).get("a")).toEqual({ hello: "世界" })
    await second.close()
  })

  it("同一个文件只能被一个连接打开", async () => {
    const file = join(dir, "kv.db")
    const first = new SqliteKvDriver(file, binding)
    await first.open()
    try {
      await expect(new SqliteKvDriver(file, binding).open()).rejects.toThrow(/locked|busy/i)
    } finally {
      await first.close()
    }
    // 第一个关掉之后就能打开
    const again = new SqliteKvDriver(file, binding)
    await again.open()
    await again.close()
  })

  it.skipIf(better === undefined || builtin === undefined)("两种绑定读写的是同一种文件", async () => {
    const file = join(dir, "kv.db")
    const writer = new SqliteKvDriver(file, better as SqliteBinding)
    await writer.open()
    await new Kv(writer).set("k", { from: "better-sqlite3" }, { ttl: "1h" })
    await writer.close()

    const reader = new SqliteKvDriver(file, builtin as SqliteBinding)
    await reader.open()
    const kv = new Kv(reader)
    expect(await kv.get("k")).toEqual({ from: "better-sqlite3" })
    expect(await kv.ttl("k")).toBeGreaterThan(0)
    await reader.close()
  })
})

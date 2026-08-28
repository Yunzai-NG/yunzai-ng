/**
 * 模块职责：KV 层的契约测试（同一套用例覆盖 memory / json / level 三种驱动）
 * 依赖方向：测试文件
 * 生命周期：每个驱动一个临时目录
 * 注意事项：**同一套用例覆盖全部驱动**是此处的关键设计 —— 任何驱动只要通过这份契约
 *          即可互换，第三方存储插件将来同样沿用这份用例。
 *          level 驱动依赖可选原生模块，无法安装时该组用例整体跳过而非报告失败。
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { KvDriver, KvNamespace } from "@yunzai-ng/types"
import { Kv } from "./kv.js"
import { MemoryKvDriver } from "./memory.js"
import { JsonKvDriver } from "./json.js"
import { LevelKvDriver, loadLevel } from "./level.js"

/** 待测驱动的构造方式 */
interface DriverCase {
  /** 名称 */
  name: string
  /** 造一个未 open 的驱动；返回 undefined 表示该驱动不可用 */
  make(dir: string): Promise<KvDriver | undefined>
}

const levelCtor = await loadLevel()

const cases: DriverCase[] = [
  { name: "memory", make: async () => new MemoryKvDriver() },
  { name: "json", make: async dir => new JsonKvDriver(join(dir, "kv.json")) },
  {
    name: "level",
    make: async dir => (levelCtor ? new LevelKvDriver(join(dir, "kv"), levelCtor) : undefined)
  }
]

for (const driverCase of cases) {
  describe(`KV 契约 · ${driverCase.name}`, () => {
    let dir: string
    let driver: KvDriver
    let kv: KvNamespace
    let available = true

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), `yzng-kv-${driverCase.name}-`))
      const made = await driverCase.make(dir)
      if (!made) {
        available = false
        return
      }
      driver = made
      await driver.open()
      kv = new Kv(driver)
    })

    afterEach(async () => {
      if (available) await driver.close()
      await rm(dir, { recursive: true, force: true })
    })

    /** 该驱动不可用时跳过单个用例 */
    const runIf = (fn: () => Promise<void>) => async () => {
      if (!available) return
      await fn()
    }

    it(
      "读写删的基本语义",
      runIf(async () => {
        expect(await kv.get("a")).toBeUndefined()
        await kv.set("a", { n: 1, list: ["x"] })
        expect(await kv.get("a")).toEqual({ n: 1, list: ["x"] })
        expect(await kv.has("a")).toBe(true)

        await kv.del("a")
        expect(await kv.has("a")).toBe(false)
        // 删不存在的键不应抛错
        await kv.del("a")
      })
    )

    it(
      "getOr 只在缺失时给默认值，false / 0 / null 都要原样返回",
      runIf(async () => {
        expect(await kv.getOr("missing", "兜底")).toBe("兜底")
        await kv.set("flag", false)
        await kv.set("zero", 0)
        await kv.set("nil", null)
        expect(await kv.getOr("flag", true)).toBe(false)
        expect(await kv.getOr("zero", 99)).toBe(0)
        expect(await kv.getOr("nil", "兜底")).toBeNull()
      })
    )

    it(
      "存进去的对象与外部引用解耦（改外部变量不影响已存的值）",
      runIf(async () => {
        const obj = { list: [1, 2] }
        await kv.set("k", obj)
        obj.list.push(3)
        expect(await kv.get("k")).toEqual({ list: [1, 2] })

        // 读出来的对象也不能是内部引用
        const read = (await kv.get<{ list: number[] }>("k"))!
        read.list.push(99)
        expect(await kv.get("k")).toEqual({ list: [1, 2] })
      })
    )

    it(
      "TTL 到期后视为不存在，并且不再出现在遍历里",
      runIf(async () => {
        // TTL 取 150ms 而非 20ms：20ms 短于 LevelDB 在负载中的一次写读往返，
        // 于是 `set` 之后紧接的 `get` 会**合法地**读到已过期 —— 断言因此偶发失败，
        // 而失败信息（expected undefined to be 1）看起来像 TTL 实现坏了
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
    )

    it(
      "ttl() 报告剩余时间：永久为 Infinity，缺失为 -1",
      runIf(async () => {
        await kv.set("forever", 1)
        await kv.set("temp", 1, { ttl: "10s" })
        expect(await kv.ttl("forever")).toBe(Number.POSITIVE_INFINITY)
        expect(await kv.ttl("nope")).toBe(-1)

        const left = await kv.ttl("temp")
        expect(left).toBeGreaterThan(8000)
        expect(left).toBeLessThanOrEqual(10_000)
      })
    )

    it(
      "incr 在并发下不丢计数（内嵌驱动无 Redis INCR 可依赖，须自行保证）",
      runIf(async () => {
        const results = await Promise.all(Array.from({ length: 50 }, () => kv.incr("count")))
        expect(await kv.get("count")).toBe(50)
        // 每次调用都应拿到唯一的序号，说明确实串行
        expect(new Set(results).size).toBe(50)
      })
    )

    it(
      "incr 的 ttl 只在首次创建时生效，自增不会续命",
      runIf(async () => {
        await kv.incr("c", 1, { ttl: "10s" })
        const first = await kv.ttl("c")
        await new Promise(r => setTimeout(r, 30))
        await kv.incr("c", 1)
        const second = await kv.ttl("c")
        expect(await kv.get("c")).toBe(2)
        expect(second).toBeLessThan(first)
      })
    )

    it(
      "incr 遇到过期键从 0 重新开始",
      runIf(async () => {
        // 同上：20ms 会与驱动的写读往返赛跑
        await kv.incr("c", 5, { ttl: 150 })
        await new Promise(r => setTimeout(r, 300))
        expect(await kv.incr("c")).toBe(1)
      })
    )

    it(
      "遍历只看得到本命名空间的键，且键名已剥掉前缀",
      runIf(async () => {
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
    )

    it(
      "同名子命名空间不会相互覆盖键",
      runIf(async () => {
        const a = kv.sub("x").sub("y")
        const b = kv.sub("xy")
        await a.set("k", "深层")
        await b.set("k", "同名")
        expect(await a.get("k")).toBe("深层")
        expect(await b.get("k")).toBe("同名")
      })
    )

    it(
      "按前缀遍历与按前缀清空",
      runIf(async () => {
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
    )

    it(
      "清空子命名空间不影响父命名空间的其他键",
      runIf(async () => {
        await kv.set("root-key", 1)
        const sub = kv.sub("child")
        await sub.set("k", 2)

        expect(await sub.clear()).toBe(1)
        expect(await kv.get("root-key")).toBe(1)
      })
    )

    it(
      "拒绝含分隔符的子命名空间名（否则两个不同子空间会拼出同一前缀）",
      runIf(async () => {
        expect(() => kv.sub("a:b")).toThrow(/不能含/)
        expect(() => kv.sub("")).toThrow(/不能为空/)
      })
    )

    it(
      "键里含中文与 emoji 也能正确前缀扫描",
      runIf(async () => {
        // level 按字节序排列，四字节字符曾是"自行计算上界"写法的典型漏键场景
        await kv.set("用户:甲", 1)
        await kv.set("用户:🙂", 2)
        await kv.set("别的:乙", 3)

        const keys: string[] = []
        for await (const key of kv.keys("用户:")) keys.push(key)
        expect(keys.sort()).toEqual(["用户:甲", "用户:🙂"].sort())
      })
    )
  })
}

describe("JSON 驱动的落盘", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "yzng-kv-json-persist-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("close() 后重新打开，数据仍在", async () => {
    const file = join(dir, "kv.json")
    const first = new JsonKvDriver(file)
    await first.open()
    const kv1 = new Kv(first)
    await kv1.set("a", { hello: "世界" })
    await kv1.set("gone", 1, { ttl: 10 })
    await first.close()

    await new Promise(r => setTimeout(r, 30))

    const second = new JsonKvDriver(file)
    await second.open()
    const kv2 = new Kv(second)
    expect(await kv2.get("a")).toEqual({ hello: "世界" })
    // 载入时就清掉过期键，不等到被访问
    expect(await kv2.get("gone")).toBeUndefined()
    expect(second.size).toBe(1)
    await second.close()
  })

  it("文件损坏时抛出可诊断的错误并留下备份", async () => {
    const file = join(dir, "kv.json")
    const { writeFile, readdir } = await import("node:fs/promises")
    await writeFile(file, "{ 这不是 json", "utf8")

    const driver = new JsonKvDriver(file)
    await expect(driver.open()).rejects.toThrow(/解析失败/)

    const files = await readdir(dir)
    expect(files.some(f => f.includes(".corrupt-"))).toBe(true)
  })
})

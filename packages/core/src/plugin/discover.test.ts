/**
 * 模块职责：插件发现与加载顺序规划的测试
 * 依赖方向：测试文件，依赖 plugin/discover、testing/fake
 * 生命周期：每个用例一个临时插件目录
 * 注意事项：`resolveLoadOrder` 的**确定性**是重点断言对象 —— 同一份插件集合在任何机器上
 *          都须得到相同顺序，否则"甲机器正常、乙机器异常"会耗费大量排障时间。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { discoverPlugins, resolveLoadOrder } from "./discover.js"
import { fakeLogger } from "../testing/fake.js"

/** 造一个插件目录 */
async function makePlugin(
  root: string,
  name: string,
  opts: { pkg?: Record<string, unknown>; entry?: string; content?: string } = {}
): Promise<string> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  if (opts.pkg) await writeFile(join(dir, "package.json"), JSON.stringify(opts.pkg))
  const entry = opts.entry ?? "index.js"
  if (entry) {
    await mkdir(join(dir, entry.includes("/") ? entry.split("/").slice(0, -1).join("/") : "."), { recursive: true })
    await writeFile(join(dir, entry), opts.content ?? "export default {}\n")
  }
  return dir
}

describe("discoverPlugins", () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "yzng-discover-"))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("找到带 index.js 的插件目录", async () => {
    await makePlugin(root, "demo")
    const found = await discoverPlugins({ dirs: [root], logger: fakeLogger() })

    expect(found).toHaveLength(1)
    expect(found[0]?.id).toBe("demo")
    expect(found[0]?.entry).toBe(join(root, "demo", "index.js"))
    expect(found[0]?.builtin).toBe(false)
  })

  it("优先用 package.json 声明的入口", async () => {
    await makePlugin(root, "custom", { pkg: { name: "custom", main: "lib/boot.js" }, entry: "lib/boot.js" })
    const found = await discoverPlugins({ dirs: [root], logger: fakeLogger() })
    expect(found[0]?.entry).toBe(join(root, "custom", "lib", "boot.js"))
  })

  it("认 exports 的条件导出", async () => {
    await makePlugin(root, "exp", {
      pkg: { name: "exp", exports: { ".": { import: "./dist/mod.js" } } },
      entry: "dist/mod.js"
    })
    const found = await discoverPlugins({ dirs: [root], logger: fakeLogger() })
    expect(found[0]?.entry).toBe(join(root, "exp", "dist", "mod.js"))
  })

  it("scope 包名去掉 scope 作为名字线索", async () => {
    await makePlugin(root, "scoped", { pkg: { name: "@acme/cool-plugin" } })
    const found = await discoverPlugins({ dirs: [root], logger: fakeLogger() })
    expect(found[0]?.id).toBe("cool-plugin")
  })

  it("yunzai.name 优先于包名与目录名", async () => {
    await makePlugin(root, "dirname", { pkg: { name: "pkgname", yunzai: { name: "declared" } } })
    const found = await discoverPlugins({ dirs: [root], logger: fakeLogger() })
    expect(found[0]?.id).toBe("declared")
  })

  it("跳过隐藏目录、下划线开头目录与 node_modules", async () => {
    await makePlugin(root, ".hidden")
    await makePlugin(root, "_disabled")
    await makePlugin(root, "node_modules")
    await makePlugin(root, "real")

    const found = await discoverPlugins({ dirs: [root], logger: fakeLogger() })
    expect(found.map(f => f.id)).toEqual(["real"])
  })

  it("package.json 自标记 disabled 的插件不加载", async () => {
    await makePlugin(root, "off", { pkg: { name: "off", yunzai: { disabled: true } } })
    const found = await discoverPlugins({ dirs: [root], logger: fakeLogger() })
    expect(found).toHaveLength(0)
  })

  it("找不到入口时给出照着能解决的警告，而不是静默跳过", async () => {
    const dir = join(root, "broken")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "readme.md"), "# 忘了写 index.js")

    const logger = fakeLogger()
    const found = await discoverPlugins({ dirs: [root], logger })

    expect(found).toHaveLength(0)
    const line = logger.lines.find(l => l.includes("broken"))
    expect(line).toBeDefined()
    expect(line).toContain("index.js")
  })

  it("支持顶层单文件插件", async () => {
    await writeFile(join(root, "小功能.js"), "export default {}\n")
    await writeFile(join(root, "_草稿.js"), "export default {}\n")

    const found = await discoverPlugins({ dirs: [root], logger: fakeLogger() })
    expect(found.map(f => f.id)).toEqual(["小功能"])
    expect(found[0]?.dir).toBe(root)
  })

  it("同名插件先扫到的胜出，并给出警告", async () => {
    const userDir = await mkdtemp(join(tmpdir(), "yzng-user-"))
    try {
      await makePlugin(userDir, "dup")
      await makePlugin(root, "dup")

      const logger = fakeLogger()
      // 用户目录排在前面 —— 复制一份预置插件加以修改即应覆盖原插件
      const found = await discoverPlugins({ dirs: [userDir, root], builtinDirs: [root], logger })

      expect(found).toHaveLength(1)
      expect(found[0]?.dir).toBe(join(userDir, "dup"))
      expect(logger.lines.some(l => l.includes("同名插件"))).toBe(true)
    } finally {
      await rm(userDir, { recursive: true, force: true })
    }
  })

  it("给预置目录里的插件打 builtin 标记", async () => {
    await makePlugin(root, "builtin-one")
    const found = await discoverPlugins({ dirs: [root], builtinDirs: [root], logger: fakeLogger() })
    expect(found[0]?.builtin).toBe(true)
  })

  it("被用户禁用的插件不出现在结果里", async () => {
    await makePlugin(root, "nope")
    const found = await discoverPlugins({ dirs: [root], disabled: ["nope"], logger: fakeLogger() })
    expect(found).toHaveLength(0)
  })

  it("相对路径目录被拒绝并警告（相对路径会随启动方式漂移）", async () => {
    const logger = fakeLogger()
    const found = await discoverPlugins({ dirs: ["./plugins"], logger })
    expect(found).toHaveLength(0)
    expect(logger.lines.some(l => l.includes("绝对路径"))).toBe(true)
  })

  it("目录不存在时安静返回空数组", async () => {
    const found = await discoverPlugins({ dirs: [join(root, "not-there")], logger: fakeLogger() })
    expect(found).toEqual([])
  })
})

describe("resolveLoadOrder", () => {
  it("依赖先于依赖方加载", () => {
    const { order, skipped } = resolveLoadOrder([
      { name: "game", dependencies: ["renderer"] },
      { name: "renderer" }
    ])

    expect(order.map(u => u.name)).toEqual(["renderer", "game"])
    expect(skipped).toEqual([])
  })

  it("多层依赖链按拓扑顺序展开", () => {
    const { order } = resolveLoadOrder([
      { name: "c", dependencies: ["b"] },
      { name: "a" },
      { name: "b", dependencies: ["a"] }
    ])
    expect(order.map(u => u.name)).toEqual(["a", "b", "c"])
  })

  it("同层内按 priority 再按名字排序（确定性）", () => {
    const { order } = resolveLoadOrder([
      { name: "zebra", priority: 10 },
      { name: "alpha", priority: 50 },
      { name: "beta", priority: 50 },
      { name: "omega" }
    ])
    expect(order.map(u => u.name)).toEqual(["zebra", "alpha", "beta", "omega"])
  })

  it("同一集合的不同输入顺序得到同一结果", () => {
    const units = [
      { name: "b", dependencies: ["a"] },
      { name: "a" },
      { name: "d", dependencies: ["a"] },
      { name: "c", dependencies: ["a"] }
    ]
    const first = resolveLoadOrder(units).order.map(u => u.name)
    const second = resolveLoadOrder([...units].reverse()).order.map(u => u.name)
    expect(second).toEqual(first)
    expect(first).toEqual(["a", "b", "c", "d"])
  })

  it("缺依赖的插件被跳过，其余照常加载", () => {
    const { order, skipped } = resolveLoadOrder([{ name: "needs-genshin", dependencies: ["genshin"] }, { name: "solo" }])

    expect(order.map(u => u.name)).toEqual(["solo"])
    expect(skipped).toHaveLength(1)
    expect(skipped[0]?.name).toBe("needs-genshin")
    expect(skipped[0]?.reason).toContain("genshin")
  })

  it("依赖缺失会级联剔除依赖它的插件", () => {
    const { order, skipped } = resolveLoadOrder([
      { name: "a", dependencies: ["missing"] },
      { name: "b", dependencies: ["a"] },
      { name: "c", dependencies: ["b"] },
      { name: "healthy" }
    ])

    expect(order.map(u => u.name)).toEqual(["healthy"])
    expect(skipped.map(s => s.name).sort()).toEqual(["a", "b", "c"])
  })

  it("依赖成环时整环跳过，并在原因里列出环成员", () => {
    const { order, skipped } = resolveLoadOrder([
      { name: "x", dependencies: ["y"] },
      { name: "y", dependencies: ["x"] },
      { name: "fine" }
    ])

    expect(order.map(u => u.name)).toEqual(["fine"])
    expect(skipped.map(s => s.name)).toEqual(["x", "y"])
    expect(skipped[0]?.reason).toContain("成环")
    expect(skipped[0]?.reason).toContain("y")
  })

  it("重名只留第一个", () => {
    const { order, skipped } = resolveLoadOrder([
      { name: "dup", priority: 1 },
      { name: "dup", priority: 2 }
    ])

    expect(order).toHaveLength(1)
    expect(order[0]?.priority).toBe(1)
    expect(skipped[0]?.reason).toContain("重复")
  })

  it("空输入不报错", () => {
    expect(resolveLoadOrder([])).toEqual({ order: [], skipped: [] })
  })
})

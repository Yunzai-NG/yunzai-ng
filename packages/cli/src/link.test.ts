/**
 * 模块职责：框架包链接的行为测试
 * 依赖方向：测试文件
 * 生命周期：每个用例使用一个临时主目录
 * 注意事项：断言对象为**幂等性与不破坏已有目录**两条，因为二者的失效方式最为隐蔽：
 *          幂等性失效须执行第二次才会暴露；误删已有目录在开发机上将直接破坏
 *          仓库自身的 node_modules，而此时的错误信息仅提示"找不到模块"。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { linkFramework } from "./link.js"

describe("框架包链接", () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "yzng-link-"))
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  it("首次链接三个框架包，插件可自主目录解析至该三者", async () => {
    const report = await linkFramework(home)
    expect(report.failed).toEqual([])
    expect([...report.linked].sort()).toEqual(["@yunzai-ng/core", "@yunzai-ng/jsx", "@yunzai-ng/types"])

    // 须能经由该链接读取到内核的 package.json，方可认定链接生效
    const raw = await readFile(join(home, "node_modules", "@yunzai-ng", "core", "package.json"), "utf8")
    expect((JSON.parse(raw) as { name: string }).name).toBe("@yunzai-ng/core")
  })

  it("重复调用不重建链接，且不报错", async () => {
    await linkFramework(home)
    const again = await linkFramework(home)
    expect(again.linked).toEqual([])
    expect([...again.kept].sort()).toEqual(["@yunzai-ng/core", "@yunzai-ng/jsx", "@yunzai-ng/types"])
    expect(again.failed).toEqual([])
  })

  it("已存在的真实目录一律不作改动 —— 主目录可能即为仓库本身", async () => {
    const real = join(home, "node_modules", "@yunzai-ng", "core")
    await mkdir(real, { recursive: true })
    await writeFile(join(real, "标记.txt"), "别删我", "utf8")

    const report = await linkFramework(home)
    expect(report.kept).toContain("@yunzai-ng/core")
    await expect(readFile(join(real, "标记.txt"), "utf8")).resolves.toBe("别删我")
  })
})

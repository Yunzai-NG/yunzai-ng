/**
 * 模块职责：单文件插件监听的真实文件系统用例
 * 依赖方向：测试文件，依赖 watch.ts 与 testing/fake
 * 生命周期：每个用例一个临时目录，afterEach 停监听并删目录
 * 注意事项：走真的 fs.watch，故断言一律「等到被调用」，不断言调用次数的精确值以外的时序
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Disposer } from "@yunzai-ng/types"
import { fakeLogger } from "../testing/fake.js"
import { watchScripts } from "./watch.js"

let stop: Disposer | undefined
let root: string | undefined

afterEach(async () => {
  stop?.()
  stop = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * 等到计数达标
 * @param read 取当前计数
 * @param want 目标
 */
async function until(read: () => number, want: number): Promise<void> {
  for (let i = 0; i < 100 && read() < want; i++) await new Promise(resolve => setTimeout(resolve, 30))
}

describe("watchScripts", () => {
  it("合集目录里放进一个 js 时通知一次，连发的事件合并", async () => {
    root = await mkdtemp(join(tmpdir(), "yzng-watch-"))
    const example = join(root, "example")
    await mkdir(example)
    let calls = 0
    stop = watchScripts({ root, logger: fakeLogger(), onChange: () => Promise.resolve(++calls) })
    // 等合集目录的监听建好
    await new Promise(resolve => setTimeout(resolve, 150))

    await writeFile(join(example, "dice.js"), "export default {}", "utf8")
    await writeFile(join(example, "dice.js"), "export default { }", "utf8")
    await until(() => calls, 1)
    expect(calls).toBe(1)
  })

  it("目录插件里的文件变动不通知", async () => {
    root = await mkdtemp(join(tmpdir(), "yzng-watch-"))
    const pkg = join(root, "pkg")
    await mkdir(pkg)
    await writeFile(join(pkg, "package.json"), "{}", "utf8")
    let calls = 0
    stop = watchScripts({ root, logger: fakeLogger(), onChange: () => Promise.resolve(++calls) })
    await new Promise(resolve => setTimeout(resolve, 150))

    await writeFile(join(pkg, "index.js"), "export default {}", "utf8")
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(calls).toBe(0)
  })
})

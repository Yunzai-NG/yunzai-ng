/**
 * 模块职责：`yzng doctor` 里可脱离真机判定的几项：Node 版本线、内核配置的读取与校验
 * 依赖方向：测试文件
 * 生命周期：每个用例一个临时配置目录
 * 注意事项：端口与原生模块要真机，不在此测
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { checkConfig, checkNode } from "./doctor.js"

describe("checkNode", () => {
  it("版本线是 20.11，不只看主版本", () => {
    expect(checkNode("20.10.0").level).toBe("error")
    expect(checkNode("20.11.0").level).toBe("ok")
    expect(checkNode("22.1.0").level).toBe("ok")
    expect(checkNode("18.20.4").level).toBe("error")
  })
})

describe("checkConfig", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "yzng-doctor-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("没有配置文件时不出结论，按缺省值探测", async () => {
    const { finding, server } = await checkConfig(dir)
    expect(finding).toBeUndefined()
    expect(server).toEqual({ enable: true, host: "127.0.0.1", port: 2536 })
  })

  it("探测配置里的端口，而不是缺省的 2536", async () => {
    await writeFile(join(dir, "yunzai.yaml"), "server:\n  host: 0.0.0.0\n  port: 3100\n", "utf8")
    const { finding, server } = await checkConfig(dir)
    expect(finding?.level).toBe("ok")
    expect(server).toEqual({ enable: true, host: "0.0.0.0", port: 3100 })
  })

  it("面板关着时如实带出 enable: false", async () => {
    await writeFile(join(dir, "yunzai.yaml"), "server:\n  enable: false\n", "utf8")
    expect((await checkConfig(dir)).server.enable).toBe(false)
  })

  it("YAML 语法错报 error，监听参数退回缺省值", async () => {
    await writeFile(join(dir, "yunzai.yaml"), "server:\n  port: [3100\n", "utf8")
    const { finding, server } = await checkConfig(dir)
    expect(finding?.level).toBe("error")
    expect(finding?.detail).toContain("语法有误")
    expect(server.port).toBe(2536)
  })

  it("校验失败报 error 并指出字段", async () => {
    await writeFile(join(dir, "yunzai.yaml"), "server:\n  port: 99999\n", "utf8")
    const { finding } = await checkConfig(dir)
    expect(finding?.level).toBe("error")
    expect(finding?.detail).toContain("server.port")
  })
})

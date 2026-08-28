/**
 * 模块职责：`platform/system.ts` 的用例 —— 磁盘量测、nvidia-smi 解析与缓存
 * 依赖方向：测试文件，依赖被测模块
 * 生命周期：每个用例前清一次缓存
 * 注意事项：**磁盘一节跑在真实文件系统上，不打桩。** 要验的恰是「`fs.statfs` 在这台
 *          机器上给出什么」—— 把它打成桩就只是在验证桩自己，而 Windows 盘根与
 *          Linux 挂载点的行为差异全在真实文件系统一侧。因此断言只挑**与平台无关的
 *          性质**（总量为正、可用不超过总量、已用与可用相加等于总量），不断言具体数值。
 *
 *          GPU 一节反过来全部是纯函数解析：`nvidia-smi` 在 CI 与多数开发机上不存在，
 *          用例若依赖它的存在就会在没有 N 卡的机器上红。故把「跑命令」与「解析输出」
 *          分成两个函数，用例只验后者。
 */
import { beforeEach, describe, expect, it } from "vitest"
import { parseNvidiaSmi, probeDisks, resetSystemCache, sampleSystem } from "./system.js"

describe("系统探测", () => {
  beforeEach(() => {
    resetSystemCache()
  })

  describe("磁盘", () => {
    it("至少探到一个分区，且每一项的数字自洽", async () => {
      const disks = await probeDisks()
      expect(disks.length).toBeGreaterThan(0)
      for (const disk of disks) {
        expect(disk.mount).not.toBe("")
        expect(disk.total).toBeGreaterThan(0)
        expect(disk.free).toBeGreaterThanOrEqual(0)
        expect(disk.free).toBeLessThanOrEqual(disk.total)
        // used 由 total - free 算出，故这条等式必然成立；验它是为了防止日后有人
        // 改成各自独立采样 —— 那时两个数就会来自不同时刻，相加不再等于总量
        expect(disk.used + disk.free).toBe(disk.total)
      }
    })

    it("挂载点不重复 —— bind mount 与同一盘的多次探测都不该各记一条", async () => {
      const disks = await probeDisks()
      expect(new Set(disks.map(d => d.mount)).size).toBe(disks.length)
    })
  })

  describe("nvidia-smi 输出解析", () => {
    it("解析常规的一行", () => {
      const gpus = parseNvidiaSmi("NVIDIA GeForce RTX 4090, 37, 2048, 24564\n")
      expect(gpus).toEqual([
        { name: "NVIDIA GeForce RTX 4090", load: 0.37, memoryUsed: 2048 * 1024 * 1024, memoryTotal: 24564 * 1024 * 1024 }
      ])
    })

    it("解析多块显卡", () => {
      const gpus = parseNvidiaSmi("Tesla T4, 0, 12, 15360\nTesla T4, 99, 15000, 15360\n")
      expect(gpus).toHaveLength(2)
      expect(gpus[0]?.load).toBe(0)
      expect(gpus[1]?.load).toBe(0.99)
    })

    it("**`[N/A]` 的字段不出现，而不是记 0** —— 0% 会被读成「空闲」，而真相是「测不到」", () => {
      const gpus = parseNvidiaSmi("NVIDIA A100, [N/A], 512, 40960\n")
      expect(gpus[0]?.name).toBe("NVIDIA A100")
      expect(gpus[0]).not.toHaveProperty("load")
      expect(gpus[0]?.memoryUsed).toBe(512 * 1024 * 1024)
    })

    it("占用率钳在 0~1 内 —— 驱动偶有报出 101 的记录", () => {
      expect(parseNvidiaSmi("X, 101, 1, 2")[0]?.load).toBe(1)
      expect(parseNvidiaSmi("X, -5, 1, 2")[0]?.load).toBe(0)
    })

    it("空输出与空行给出空数组，不抛错", () => {
      expect(parseNvidiaSmi("")).toEqual([])
      expect(parseNvidiaSmi("\n\n")).toEqual([])
    })

    it("缺列的行只丢掉缺的那几项，型号仍在", () => {
      const gpus = parseNvidiaSmi("NVIDIA T1000\n")
      expect(gpus).toEqual([{ name: "NVIDIA T1000" }])
    })
  })

  describe("快照", () => {
    it("**测不到显卡时不出现 `gpus` 字段** —— 空数组会被读成「确实有 0 块」", async () => {
      const snapshot = await sampleSystem(true)
      // 本机有无 N 卡未知，故两种情形都接受，但「有这个字段且为空数组」不接受
      if ("gpus" in snapshot) expect(snapshot.gpus?.length).toBeGreaterThan(0)
      else expect(snapshot.gpus).toBeUndefined()
    })

    it("缓存生效：连续两次取到同一个对象", async () => {
      const first = await sampleSystem()
      const second = await sampleSystem()
      expect(second).toBe(first)
    })

    it("force 绕过缓存，取到的是另一次采样", async () => {
      const first = await sampleSystem()
      const forced = await sampleSystem(true)
      expect(forced).not.toBe(first)
      expect(forced.disks.length).toBe(first.disks.length)
    })
  })
})

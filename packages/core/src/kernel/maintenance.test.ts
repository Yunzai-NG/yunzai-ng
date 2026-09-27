/**
 * 模块职责：维护面的用例 —— 守护探测、受控映射、以及「无人接管时不停机」
 * 依赖方向：测试文件，依赖 maintenance.ts 与类型
 * 生命周期：重启那几条用假定时器推进（`requestRestart` 刻意把停机排到下一拍）
 * 注意事项：**最要紧的一条是「没有守护时绝不停机」。** 那条判断错了不会报错，只会在真实例上
 *          表现成「下了 #重启，机器人关掉再也没起来」—— 而那时使用者手上没有任何线索。
 *
 *          映射那几条钉的是**窄契约**：市场的结果日后加字段，不该自动流进插件看得见的那一份。
 *          故断言用 `toEqual` 而非 `toMatchObject` —— 后者对「多给了字段」视而不见，
 *          而多给正是这里要防的。
 */
import { describe, expect, it, vi } from "vitest"
import type { Logger } from "@yunzai-ng/types"
import { createMaintenanceView, detectSupervisor, type MaintenanceDeps } from "./maintenance.js"
import type { PluginMarket } from "../plugin/market.js"

/** 收集日志的假日志器 */
function collectingLogger(): { readonly warns: string[]; readonly infos: string[]; readonly logger: Logger } {
  const warns: string[] = []
  const infos: string[] = []
  const logger = {
    trace: () => undefined,
    debug: () => undefined,
    info: (msg: unknown) => void infos.push(String(msg)),
    warn: (msg: unknown) => void warns.push(String(msg)),
    error: () => undefined,
    fatal: () => undefined,
    mark: () => undefined,
    child: () => logger,
    isLevelEnabled: () => true,
    level: "info"
  } as unknown as Logger
  return { warns, infos, logger }
}

/**
 * 造一份维护面及其周边
 * @param over 要盖掉的依赖
 * @returns 维护面与观察点
 */
function make(over: Partial<MaintenanceDeps> = {}) {
  const { warns, infos, logger } = collectingLogger()
  const stopped: number[] = []
  const handled: number[] = []
  /** 当前的重启处理器，可在用例中途换掉以验证「现读」 */
  let handler: (() => void | Promise<void>) | undefined = () => void handled.push(Date.now())

  const deps: MaintenanceDeps = {
    market: {} as unknown as PluginMarket,
    reload: () => Promise.resolve(true),
    logger,
    stop: () => {
      stopped.push(Date.now())
      return Promise.resolve()
    },
    restartHandler: () => handler,
    env: {},
    ...over
  }

  return {
    view: createMaintenanceView(deps),
    warns,
    infos,
    stopped,
    handled,
    /**
     * 换掉重启处理器
     * @param next 新的处理器
     */
    setHandler: (next: (() => void | Promise<void>) | undefined): void => {
      handler = next
    }
  }
}

describe("detectSupervisor", () => {
  it("pm2 注入 pm_id", () => {
    expect(detectSupervisor({ pm_id: "0" })).toBe("pm2")
  })

  it("systemd 注入 INVOCATION_ID", () => {
    expect(detectSupervisor({ INVOCATION_ID: "abc123" })).toBe("systemd")
  })

  it("什么都没有时 undefined —— 这不是「没有守护」的证明", () => {
    // Windows 服务（nssm）不留可识别的环境痕迹，故判不出时只能沉默
    expect(detectSupervisor({})).toBeUndefined()
  })

  it("空串按没有算", () => {
    // 环境变量被显式设成空串是常见的清除写法，取它会误报一个不存在的守护
    expect(detectSupervisor({ pm_id: "", INVOCATION_ID: "" })).toBeUndefined()
  })

  it("**不取 PM2_HOME** —— 它在未受管的 shell 里也存在", () => {
    expect(detectSupervisor({ PM2_HOME: "/root/.pm2" })).toBeUndefined()
  })

  it("两者都在时以 pm2 为准", () => {
    expect(detectSupervisor({ pm_id: "3", INVOCATION_ID: "x" })).toBe("pm2")
  })
})

describe("canRestart", () => {
  it("有人接管时为真", () => {
    expect(make().view.canRestart).toBe(true)
  })

  it("无人接管时为假", () => {
    expect(make({ restartHandler: () => undefined }).view.canRestart).toBe(false)
  })

  it("**现读而非快照** —— 宿主注册处理器晚于 App 构造", () => {
    // 存成快照的话，插件永远看到 false：`yzng start` 注册那一刻早已过去
    const { view, setHandler } = make()
    setHandler(undefined)
    expect(view.canRestart).toBe(false)
    setHandler(() => undefined)
    expect(view.canRestart).toBe(true)
  })
})

describe("supervisor", () => {
  it("由注入的环境变量算出，不去翻进程表", () => {
    expect(make({ env: { pm_id: "1" } }).view.supervisor).toBe("pm2")
  })
})

describe("inspectUpdate", () => {
  it("只回传两项，市场那份结果的其余字段不外流", async () => {
    const market = {
      inspectUpdate: () => Promise.resolve({ willPull: true, dirty: false, 将来新增的字段: "x" })
    } as unknown as PluginMarket
    const { view } = make({ market })
    // toEqual 而非 toMatchObject：要防的正是「多给了字段」
    expect(await view.inspectUpdate("webui")).toEqual({ willPull: true, dirty: false })
  })

  it("名字原样交给市场（校验归市场，不在此处抄一遍）", async () => {
    const seen: string[] = []
    const market = {
      inspectUpdate: (name: string) => {
        seen.push(name)
        return Promise.resolve({ willPull: false, dirty: false })
      }
    } as unknown as PluginMarket
    await make({ market }).view.inspectUpdate("yenai-state")
    expect(seen).toEqual(["yenai-state"])
  })
})

describe("updatePlugin", () => {
  /**
   * 造一个只记参数的假市场
   * @param result update 要回的结果
   * @returns 市场与它收到的参数
   */
  const fakeMarket = (
    result: Record<string, unknown>
  ): { readonly calls: { name: string; opts: unknown }[]; readonly market: PluginMarket } => {
    const calls: { name: string; opts: unknown }[] = []
    const market = {
      update: (name: string, opts: unknown) => {
        calls.push({ name, opts })
        return Promise.resolve(result)
      }
    } as unknown as PluginMarket
    return { calls, market }
  }

  it("只取维护面用得上的几项，安装目录与取源方式不外流", async () => {
    const { market } = fakeMarket({
      name: "webui",
      version: "0.4.0",
      dir: "/plugins/webui",
      via: "pull",
      updatable: "pull",
      fromVersion: "0.3.2",
      changed: true
    })
    expect(await make({ market }).view.updatePlugin("webui")).toEqual({
      name: "webui",
      version: "0.4.0",
      fromVersion: "0.3.2",
      changed: true
    })
  })

  it("没发生的事不出现在结果里，而不是给一个 undefined 字段", async () => {
    const { market } = fakeMarket({ name: "a", version: "1.0.0", dir: "/p/a", via: "archive", updatable: "reinstall" })
    const out = await make({ market }).view.updatePlugin("a")
    expect(out).toEqual({ name: "a", version: "1.0.0" })
    expect("stashed" in out).toBe(false)
  })

  it("**暂存与丢弃分开报** —— 对一个刚把改动丢掉的人说「可以 stash pop 取回」是误导", async () => {
    const { market } = fakeMarket({
      name: "a",
      version: "1.0.0",
      dir: "/p/a",
      via: "pull",
      updatable: "pull",
      discarded: true
    })
    const out = await make({ market }).view.updatePlugin("a", { onDirty: "discard" })
    expect(out).toEqual({ name: "a", version: "1.0.0", discarded: true })
    expect("stashed" in out).toBe(false)
  })

  it("选项透传给市场；一项都没给时不硬塞缺省值", async () => {
    const { calls, market } = fakeMarket({ name: "a", version: "1", dir: "/p/a", via: "pull", updatable: "pull" })
    const { view } = make({ market })

    await view.updatePlugin("a", { onDirty: "stash", dependencies: false })
    expect(calls[0]?.opts).toEqual({ onDirty: "stash", dependencies: false })

    // 不给选项时交一个空对象：塞进 `onDirty: undefined` 会盖掉市场自己的缺省
    await view.updatePlugin("a")
    expect(calls[1]?.opts).toEqual({})
  })
})

describe("reloadPlugin", () => {
  it("原样委派给宿主的重载", async () => {
    const seen: string[] = []
    const { view } = make({
      reload: (name: string) => {
        seen.push(name)
        return Promise.resolve(true)
      }
    })
    expect(await view.reloadPlugin("mhy-game")).toBe(true)
    expect(seen).toEqual(["mhy-game"])
  })

  it("重载失败原样回传 false，不翻译成异常", async () => {
    expect(await make({ reload: () => Promise.resolve(false) }).view.reloadPlugin("x")).toBe(false)
  })
})

describe("requestRestart", () => {
  it("**宿主没接管时不停机**，只留一条日志", async () => {
    vi.useFakeTimers()
    try {
      const { view, stopped, warns } = make({ restartHandler: () => undefined })
      await view.requestRestart({ reason: "更新了内核" })
      // 即便把时间推到底也不该有停机：停机之后没人负责退出与拉起，进程会卡在已停机状态
      await vi.advanceTimersByTimeAsync(10_000)
      expect(stopped).toEqual([])
      expect(warns.some(m => m.includes("宿主没有接管重启"))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("宿主没接管时也**不抛错** —— 插件不该把一句技术错误抄给使用者", async () => {
    const { view } = make({ restartHandler: () => undefined })
    await expect(view.requestRestart()).resolves.toBeUndefined()
  })

  it("有守护时先停机再交给宿主退出", async () => {
    vi.useFakeTimers()
    try {
      const { view, stopped, handled, infos } = make()
      await view.requestRestart({ reason: "装了新插件" })
      // 停机排在下一拍：调用方是命令处理函数，在自己的栈里等自己被卸载完是个没必要的结
      expect(stopped).toEqual([])
      await vi.advanceTimersByTimeAsync(1_000)
      expect(stopped).toHaveLength(1)
      expect(handled).toHaveLength(1)
      // 原因要写进日志：事后翻日志时「谁让它重启的」是第一个问题
      expect(infos.some(m => m.includes("装了新插件"))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("停机出错仍继续退出 —— 没关干净的连接会随进程一起消失", async () => {
    vi.useFakeTimers()
    try {
      const { view, handled, warns } = make({ stop: () => Promise.reject(new Error("KV 关不掉")) })
      await view.requestRestart()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(handled).toHaveLength(1)
      expect(warns.some(m => m.includes("仍继续退出"))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("不给原因也能调，日志里不留一个空的冒号", async () => {
    vi.useFakeTimers()
    try {
      const { view, infos } = make()
      await view.requestRestart()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(infos.some(m => m.includes("：") && m.includes("重启请求"))).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

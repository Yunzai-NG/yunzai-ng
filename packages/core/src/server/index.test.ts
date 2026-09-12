/**
 * 模块职责：`ManagedServer` 的行为测试
 * 依赖方向：测试文件，依赖 server/*、config/*
 * 生命周期：每个用例一个临时配置目录与一个未监听的服务器
 * 注意事项：全程用 `server.raw.inject()` / `raw.injectWS()`，**不真的监听端口** ——
 *          CI 上抢端口是最常见的偶发失败源，而这两个注入接口走的是完整的钩子链，
 *          鉴权、请求体解析、路由分发一个都不会被跳过。
 *
 *          `injectWS` 伪造的 raw request 上没有 `socket`，所以要在 upgradeContext 里
 *          自己补一个 `remoteAddress`，否则"是否本机"判断永远为假。
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Socket } from "node:net"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { LogLevel, Logger } from "@yunzai-ng/types"
import { ConfigStore } from "../config/store.js"
import { defineCoreConfig, type CoreConfigHandle } from "../config/core-config.js"
import { ManagedServer, createManagedServer } from "./index.js"

/** 本机对端，light-my-request 默认也是这个 */
const LOCAL_IP = "127.0.0.1"

/**
 * 拼一个 `injectWS` 的 upgradeContext
 *
 * `injectWS` 伪造的 raw request 上没有 `socket`，而鉴权要看 TCP 对端地址，所以得自己
 * 补一个。类型上只能断言：`net.Socket` 有近百个成员，这里真正需要的只有
 * `remoteAddress` 一个字段。
 * @param headers 额外的握手请求头
 * @returns upgradeContext
 */
function upgradeCtx(headers: Record<string, string> = {}): { socket: Socket; headers: Record<string, string> } {
  return { socket: { remoteAddress: LOCAL_IP } as unknown as Socket, headers }
}

/**
 * 静音日志器
 * @returns 只收集行的日志器
 */
function quietLogger(): Logger & { lines: string[] } {
  const lines: string[] = []
  const push =
    (level: string) =>
    (msg: unknown): void => {
      lines.push(`${level} ${String(msg)}`)
    }
  const logger: Logger & { lines: string[] } = {
    lines,
    level: "silent" as LogLevel,
    trace: push("trace"),
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    fatal: push("fatal"),
    mark: push("info"),
    child: () => logger,
    isLevelEnabled: () => false
  }
  return logger
}

describe("ManagedServer", () => {
  let dir: string
  let logger: ReturnType<typeof quietLogger>
  let config: CoreConfigHandle
  let server: ManagedServer

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "yzng-server-"))
    logger = quietLogger()
    const store = new ConfigStore({ dir, logger, watch: false })
    config = await defineCoreConfig(store)
    server = await createManagedServer({ config, logger })
  })

  afterEach(async () => {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  })

  describe("路由分发", () => {
    it("裸返回值当响应体，状态码 200", async () => {
      server.route("/plugin/demo", "GET", "ping", () => ({ ok: true }))
      const res = await server.raw.inject({ method: "GET", url: "/plugin/demo/ping" })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ ok: true })
    })

    it("信封形式可以指定状态码与响应头", async () => {
      server.route("/plugin/demo", "POST", "create", () => ({
        status: 201,
        headers: { "x-made-by": "demo" },
        body: { id: 7 }
      }))
      const res = await server.raw.inject({
        method: "POST",
        url: "/plugin/demo/create",
        payload: { name: "x" }
      })
      expect(res.statusCode).toBe(201)
      expect(res.headers["x-made-by"]).toBe("demo")
      expect(res.json()).toEqual({ id: 7 })
    })

    it("返回 undefined 是 204", async () => {
      server.route("/plugin/demo", "DELETE", "thing", () => undefined)
      const res = await server.raw.inject({ method: "DELETE", url: "/plugin/demo/thing" })
      expect(res.statusCode).toBe(204)
    })

    it("路径参数与通配段都能拿到", async () => {
      server.route("/plugin/demo", "GET", "file/:name/*rest", req => req.params)
      const res = await server.raw.inject({ method: "GET", url: "/plugin/demo/file/a/b/c" })
      expect(res.json()).toEqual({ name: "a", rest: "b/c" })
    })

    it("Uint8Array 走二进制直发而不是被 JSON 序列化", async () => {
      server.route("/plugin/demo", "GET", "bin", () => new Uint8Array([1, 2, 3]))
      const res = await server.raw.inject({ method: "GET", url: "/plugin/demo/bin" })
      expect(res.statusCode).toBe(200)
      expect([...res.rawPayload]).toEqual([1, 2, 3])
    })

    it("处理函数抛错回 500，抛 statusCode 时按它回", async () => {
      server.route("/plugin/demo", "GET", "boom", () => {
        throw new Error("处理失败")
      })
      server.route("/plugin/demo", "GET", "teapot", () => {
        const err = new Error("我是茶壶") as Error & { statusCode: number }
        err.statusCode = 418
        throw err
      })
      const boom = await server.raw.inject({ method: "GET", url: "/plugin/demo/boom" })
      expect(boom.statusCode).toBe(500)
      expect(boom.json()).toEqual({ error: "处理失败" })
      const teapot = await server.raw.inject({ method: "GET", url: "/plugin/demo/teapot" })
      expect(teapot.statusCode).toBe(418)
    })

    it("Disposer 摘除路由后返回 404", async () => {
      const off = server.route("/plugin/demo", "GET", "gone", () => "hi")
      expect((await server.raw.inject({ method: "GET", url: "/plugin/demo/gone" })).statusCode).toBe(200)
      off()
      expect((await server.raw.inject({ method: "GET", url: "/plugin/demo/gone" })).statusCode).toBe(404)
    })

    it("同一模式重复注册会抛错，摘除后可再次注册", () => {
      const off = server.route("/plugin/demo", "GET", "dup", () => 1)
      expect(() => server.route("/plugin/demo", "GET", "dup", () => 2)).toThrow(/已经注册过了/)
      off()
      expect(() => server.route("/plugin/demo", "GET", "dup", () => 2)).not.toThrow()
    })

    it("HEAD 没单独注册时回落到 GET", async () => {
      server.route("/plugin/demo", "GET", "page", () => ({ ok: true }))
      const res = await server.raw.inject({ method: "HEAD", url: "/plugin/demo/page" })
      expect(res.statusCode).toBe(200)
      // 仅断言响应头：真实网络下 Node 的 ServerResponse 会自动丢弃 HEAD 的响应体，
      // 但注入接口不经由真实 socket，body 仍然留存于缓冲中
      expect(res.headers["content-type"]).toMatch(/application\/json/)
    })
  })

  describe("方法协商", () => {
    it("路径不存在是 404，方法不对是 405 并带 Allow", async () => {
      server.route("/plugin/demo", "GET", "thing", () => "ok")
      const missing = await server.raw.inject({ method: "GET", url: "/nope" })
      expect(missing.statusCode).toBe(404)
      const wrong = await server.raw.inject({ method: "PUT", url: "/plugin/demo/thing" })
      expect(wrong.statusCode).toBe(405)
      expect(wrong.headers.allow).toBe("GET, HEAD, OPTIONS")
    })

    it("OPTIONS 由服务器代劳，回 204 + Allow", async () => {
      server.route("/plugin/demo", "GET", "thing", () => "ok")
      server.route("/plugin/demo", "POST", "thing", () => "ok")
      const res = await server.raw.inject({ method: "OPTIONS", url: "/plugin/demo/thing" })
      expect(res.statusCode).toBe(204)
      expect(res.headers.allow).toBe("GET, POST, HEAD, OPTIONS")
    })
  })

  describe("鉴权", () => {
    it("没配令牌时放行本机", async () => {
      server.route("/api", "GET", "state", () => ({ ok: true }))
      const res = await server.raw.inject({ method: "GET", url: "/api/state", remoteAddress: "127.0.0.1" })
      expect(res.statusCode).toBe(200)
    })

    it("没配令牌时拒绝外部，并说明该去配什么", async () => {
      server.route("/api", "GET", "state", () => ({ ok: true }))
      const res = await server.raw.inject({ method: "GET", url: "/api/state", remoteAddress: "10.0.0.9" })
      expect(res.statusCode).toBe(401)
      expect(String(res.json().error)).toContain("server.token")
    })

    it("配了令牌后本机也要带令牌", async () => {
      await config.patch({ server: { token: "0123456789abcdef" } }, "api")
      server.route("/api", "GET", "state", () => ({ ok: true }))

      const bare = await server.raw.inject({ method: "GET", url: "/api/state" })
      expect(bare.statusCode).toBe(401)

      const wrong = await server.raw.inject({
        method: "GET",
        url: "/api/state",
        headers: { authorization: "Bearer nope" }
      })
      expect(wrong.statusCode).toBe(403)

      const right = await server.raw.inject({
        method: "GET",
        url: "/api/state",
        headers: { authorization: "Bearer 0123456789abcdef" }
      })
      expect(right.statusCode).toBe(200)

      const alt = await server.raw.inject({
        method: "GET",
        url: "/api/state",
        headers: { "x-yunzai-token": "0123456789abcdef" }
      })
      expect(alt.statusCode).toBe(200)
    })

    it("auth: false 的路由不受令牌影响，适配器 webhook 靠这个", async () => {
      await config.patch({ server: { token: "0123456789abcdef" } }, "api")
      server.route("/plugin/napcat", "POST", "hook", () => ({ ok: true }), { auth: false })
      const res = await server.raw.inject({
        method: "POST",
        url: "/plugin/napcat/hook",
        payload: { post_type: "message" },
        remoteAddress: "10.0.0.9"
      })
      expect(res.statusCode).toBe(200)
    })

    it("需要鉴权的写接口挡掉可跨站伪造的 Content-Type", async () => {
      server.route("/api", "POST", "config", () => ({ ok: true }))
      const res = await server.raw.inject({
        method: "POST",
        url: "/api/config",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: "a=1"
      })
      expect(res.statusCode).toBe(415)
    })

    it("查询串里的令牌不算数：那正是 auth.ts 第 1 条刻意排除的来源", async () => {
      await config.patch({ server: { token: "0123456789abcdef" } }, "api")
      server.route("/api", "GET", "state", () => ({ ok: true }))
      const res = await server.raw.inject({ method: "GET", url: "/api/state?token=0123456789abcdef" })
      expect(res.statusCode).toBe(401)
    })
  })

  describe("请求体", () => {
    it("JSON 正常解析，且原型污染被中和", async () => {
      let seen: unknown
      server.route("/plugin/demo", "POST", "echo", req => {
        seen = req.body
        return { ok: true }
      })
      const res = await server.raw.inject({
        method: "POST",
        url: "/plugin/demo/echo",
        payload: '{"a":1,"__proto__":{"polluted":true}}',
        headers: { "content-type": "application/json" }
      })
      expect(res.statusCode).toBe(200)
      expect(seen).toEqual({ a: 1 })
      expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    })

    it("空请求体是 undefined 而不是解析失败", async () => {
      let seen: unknown = "未赋值"
      server.route("/plugin/demo", "POST", "empty", req => {
        seen = req.body
        return { ok: true }
      })
      const res = await server.raw.inject({ method: "POST", url: "/plugin/demo/empty" })
      expect(res.statusCode).toBe(200)
      expect(seen).toBeUndefined()
    })

    it("没有 Content-Type 时也按 JSON 试一次", async () => {
      let seen: unknown
      server.route("/plugin/demo", "POST", "guess", req => {
        seen = req.body
        return { ok: true }
      })
      const res = await server.raw.inject({
        method: "POST",
        url: "/plugin/demo/guess",
        payload: '{"a":1}'
      })
      expect(res.statusCode).toBe(200)
      expect(seen).toEqual({ a: 1 })
    })

    it("超过 bodyLimit 回 413", async () => {
      server.route("/plugin/demo", "POST", "small", () => ({ ok: true }), { bodyLimit: 16 })
      const res = await server.raw.inject({
        method: "POST",
        url: "/plugin/demo/small",
        payload: { pad: "x".repeat(200) },
        headers: { "content-type": "application/json" }
      })
      expect(res.statusCode).toBe(413)
    })

    it("rawBody 为真时能拿到原始字节，为假时拿不到", async () => {
      let withRaw: Uint8Array | undefined
      let withoutRaw: Uint8Array | undefined
      server.route(
        "/plugin/demo",
        "POST",
        "raw",
        req => {
          withRaw = req.rawBody
          return { ok: true }
        },
        { rawBody: true }
      )
      server.route("/plugin/demo", "POST", "norm", req => {
        withoutRaw = req.rawBody
        return { ok: true }
      })

      await server.raw.inject({
        method: "POST",
        url: "/plugin/demo/raw",
        payload: '{"a":1}',
        headers: { "content-type": "application/json" }
      })
      await server.raw.inject({
        method: "POST",
        url: "/plugin/demo/norm",
        payload: '{"a":1}',
        headers: { "content-type": "application/json" }
      })

      expect(withRaw).toBeInstanceOf(Uint8Array)
      expect(Buffer.from(withRaw ?? new Uint8Array()).toString("utf8")).toBe('{"a":1}')
      expect(withoutRaw).toBeUndefined()
    })

    it("表单请求体在 auth: false 的路由上解析成无原型对象", async () => {
      let seen: unknown
      server.route(
        "/plugin/napcat",
        "POST",
        "form",
        req => {
          seen = req.body
          return { ok: true }
        },
        { auth: false }
      )
      await server.raw.inject({
        method: "POST",
        url: "/plugin/napcat/form",
        payload: "a=1&b=2",
        headers: { "content-type": "application/x-www-form-urlencoded" }
      })
      expect(seen).toEqual({ a: "1", b: "2" })
      expect(Object.getPrototypeOf(seen)).toBeNull()
    })
  })

  describe("静态资源", () => {
    let web: string

    beforeEach(async () => {
      web = join(dir, "web")
      await mkdir(join(web, "assets"), { recursive: true })
      await writeFile(join(web, "index.html"), "<html>面板</html>", "utf8")
      await writeFile(join(web, "assets", "app.js"), "console.error(1)", "utf8")
    })

    it("挂载根路径时同时命中 `/` 与子路径", async () => {
      server.panel("plugin:webui", web)
      const root = await server.raw.inject({ method: "GET", url: "/" })
      expect(root.statusCode).toBe(200)
      expect(root.body).toContain("面板")

      const asset = await server.raw.inject({ method: "GET", url: "/assets/app.js" })
      expect(asset.statusCode).toBe(200)
      expect(asset.headers["content-type"]).toMatch(/javascript/)
    })

    it("单页回退只对看起来像页面的路径生效", async () => {
      server.panel("plugin:webui", web)
      const page = await server.raw.inject({ method: "GET", url: "/plugins/list" })
      expect(page.statusCode).toBe(200)
      expect(page.body).toContain("面板")

      // 带扩展名的缺失资源必须是 404，否则浏览器拿到 HTML 会报一个方向完全跑偏的错
      const missing = await server.raw.inject({ method: "GET", url: "/assets/missing.js" })
      expect(missing.statusCode).toBe(404)
    })

    it("静态资源不需要令牌，但同前缀的 API 需要", async () => {
      await config.patch({ server: { token: "0123456789abcdef" } }, "api")
      server.panel("plugin:webui", web)
      server.route("/api", "GET", "state", () => ({ ok: true }))

      expect((await server.raw.inject({ method: "GET", url: "/" })).statusCode).toBe(200)
      expect((await server.raw.inject({ method: "GET", url: "/api/state" })).statusCode).toBe(401)
    })

    it("路径穿越拿不到挂载目录之外的文件", async () => {
      await writeFile(join(dir, "secret.txt"), "令牌在这里", "utf8")
      server.static("/", "", web)
      for (const url of ["/../secret.txt", "/..%2Fsecret.txt", "/%2e%2e/secret.txt"]) {
        const res = await server.raw.inject({ method: "GET", url })
        expect(res.statusCode).not.toBe(200)
      }
    })

    it("相对目录直接拒掉", () => {
      expect(() => server.static("/", "", "web")).toThrow(/绝对路径/)
    })

    it("更具体的挂载优先于根挂载", async () => {
      const docs = join(dir, "docs")
      await mkdir(docs, { recursive: true })
      await writeFile(join(docs, "index.html"), "<html>文档</html>", "utf8")
      server.panel("plugin:webui", web)
      server.static("/docs", "", docs)
      const res = await server.raw.inject({ method: "GET", url: "/docs" })
      expect(res.body).toContain("文档")
    })

    it("面板归属可查，重复接管抛错", async () => {
      expect(server.claimant("/")).toBeUndefined()
      server.panel("plugin:webui", web)
      expect(server.claimant("/")).toBe("plugin:webui")
      // 第二个调用方撞在同一个路径模式上：静默覆盖会让"面板显示的是谁的页面"无法判定。
      // 归属一律形如 `plugin:<名>` —— 内核自身从不挂面板
      expect(() => server.panel("plugin:webui-alt", web)).toThrow()
    })

    it("插件接管后归属指向该插件", () => {
      server.panel("plugin:webui-next", web)
      expect(server.claimant("/")).toBe("plugin:webui-next")
    })
  })

  describe("WebSocket", () => {
    it("收发一条消息，并计入连接数", async () => {
      server.websocket("/plugin/demo", "echo", conn => {
        conn.onMessage(data => {
          conn.send(`收到 ${String(data)}`)
        })
      })

      const ws = await server.raw.injectWS("/plugin/demo/echo", upgradeCtx())
      expect(server.connections).toBe(1)
      const got = await new Promise<string>(resolve => {
        ws.on("message", (raw: unknown) => {
          resolve(String(raw))
        })
        ws.send("你好")
      })
      expect(got).toBe("收到 你好")
      ws.terminate()
    })

    it("未注册的路径回真正的 HTTP 404，而不是一次没理由的断线", async () => {
      await expect(server.raw.injectWS("/plugin/demo/nope", upgradeCtx())).rejects.toThrow(
        /Unexpected server response: 404/
      )
    })

    it("配了令牌后缺令牌回 401，子协议里带上就通", async () => {
      await config.patch({ server: { token: "0123456789abcdef" } }, "api")
      server.websocket("/plugin/demo", "logs", () => undefined)

      await expect(server.raw.injectWS("/plugin/demo/logs", upgradeCtx())).rejects.toThrow(
        /Unexpected server response: 401/
      )

      // 前端只能以此方式携带令牌：浏览器的 WebSocket 构造函数无法设置请求头（见 auth.ts 第 2 条）
      const ws = await server.raw.injectWS("/plugin/demo/logs", upgradeCtx({ "sec-websocket-protocol": "yunzai, 0123456789abcdef" }))
      expect(server.connections).toBe(1)
      ws.terminate()
    })

    it("自定义 verify 完全接管校验，返回 false 时回 401", async () => {
      server.websocket(
        "/plugin/napcat",
        "reverse",
        () => undefined,
        { verify: req => req.headers["x-self-id"] === "10000" }
      )

      await expect(server.raw.injectWS("/plugin/napcat/reverse", upgradeCtx())).rejects.toThrow(
        /Unexpected server response: 401/
      )

      const ws = await server.raw.injectWS("/plugin/napcat/reverse", upgradeCtx({ "x-self-id": "10000" }))
      expect(server.connections).toBe(1)
      ws.terminate()
    })
  })

  describe("面板内省", () => {
    it("列出路由、端点与静态挂载", () => {
      server.route("/api", "GET", "state", () => 1)
      server.route("/plugin/napcat", "POST", "hook", () => 1, { auth: false })
      server.websocket("/api", "logs", () => undefined)
      server.static("/docs", "", join(dir, "docs"))

      expect(server.listRoutes()).toEqual(
        expect.arrayContaining([
          { method: "GET", pattern: "/api/state", scope: "/api", auth: true },
          { method: "POST", pattern: "/plugin/napcat/hook", scope: "/plugin/napcat", auth: false }
        ])
      )
      expect(server.listWebsockets()).toEqual([{ pattern: "/api/logs", scope: "/api" }])
      expect(server.listStatic()).toEqual([{ pattern: "/docs/*rest", dir: join(dir, "docs"), spa: false }])
    })

    it("info 反映配置，publicUrl 把通配地址换成能点开的形式", async () => {
      expect(server.info.enabled).toBe(false)
      expect(server.info.publicUrl).toBe("http://127.0.0.1:2536")
      await config.patch({ server: { host: "0.0.0.0", port: 3000 } }, "api")
      expect(server.info.publicUrl).toBe("http://127.0.0.1:3000")
    })
  })

  describe("生命周期", () => {
    // 本机也生成：早先只在监听地址对外时生成，那让本机部署处在没有门的状态 ——
    // 使用者浏览器里的任何页面都能向 127.0.0.1 发请求，而那是面板的全部写权限
    it("自动生成并落盘令牌，只监听本机时亦然", async () => {
      expect(config.get().server.host).toBe("127.0.0.1")
      await server.ensureToken()

      const token = config.get().server.token
      expect(typeof token).toBe("string")
      // 恰好 16 位字母数字：这串东西要从日志里抄进浏览器，见 generateToken
      expect(token).toMatch(/^[A-Za-z0-9]{16}$/)
      expect(logger.lines.some(line => line.startsWith("warn") && line.includes(token ?? "!"))).toBe(true)
    })

    it("已有令牌时不覆盖 —— 使用者自己设的那一个说了算", async () => {
      await config.patch({ server: { token: "kept-by-the-user" } }, "api")
      await server.ensureToken()
      expect(config.get().server.token).toBe("kept-by-the-user")
    })

    it("close 幂等，且关闭后不能再注册", async () => {
      server.route("/api", "GET", "state", () => 1)
      await server.close()
      await server.close()
      expect(server.listRoutes()).toEqual([])
      expect(() => server.route("/api", "GET", "other", () => 1)).toThrow(/已关闭/)
    })

    it("真的监听时 info 给出实际端口", async () => {
      // 配置 schema 不接受 port 0，所以自己挑一个高位端口而不是让内核分配
      const port = 40000 + Math.floor(Math.random() * 20000)
      await config.patch({ server: { port } }, "api")
      await server.listen()
      expect(server.info.enabled).toBe(true)
      expect(server.info.port).toBe(port)
    })
  })
})

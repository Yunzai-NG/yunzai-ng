/**
 * 模块职责：HTTP 客户端测试
 * 依赖方向：测试文件，依赖 http/client + node:http
 * 生命周期：整个文件共用一个本地 HTTP 服务器，由 `afterAll` 关闭
 * 注意事项：此处**不对 fetch 打桩**，而是实际启动一个 `node:http` 服务器。
 *          超时、重试、`Retry-After`、gzip 解压、重定向、连接池归还
 *          等行为均位于 undici 与内核的接缝处，打桩将使待测行为不再被覆盖。
 *
 *          `/slow`、`/flaky` 一类路由带有状态，用例之间以不同的 key 相互隔离，
 *          不得在两个用例中共用同一个 key。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { gzipSync } from "node:zlib"
import { readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { AbortError, sleep } from "../util/defer.js"
import { HttpError, createHttpClient, sanitizeHeaders, sanitizeUrl, type ManagedHttpClient } from "./client.js"

/** 服务器实例 */
let server: Server

/** 服务器根地址 */
let base: string

/** 每个 key 已被请求过几次（测重试） */
const hits = new Map<string, number>()

/** 收到的请求头（按路径记最后一次） */
const seenHeaders = new Map<string, IncomingMessage["headers"]>()

/** 收到的请求体（按路径记最后一次） */
const seenBodies = new Map<string, string>()

/** 本轮用例创建的客户端，afterEach 统一关掉 */
const clients: ManagedHttpClient[] = []

/**
 * 建一个客户端并登记待关闭
 * @param opts 客户端参数
 * @returns 客户端
 */
function makeClient(opts: Parameters<typeof createHttpClient>[0] = {}): ManagedHttpClient {
  // useEnvProxy: false —— 开发机上通常设置了 HTTPS_PROXY，经代理连接 127.0.0.1 必然失败，
  // 该失败与被测逻辑无关，只会导致用例无故报错
  const client = createHttpClient({ useEnvProxy: false, ...opts })
  clients.push(client)
  return client
}

/**
 * 读完请求体
 * @param req 请求
 * @returns 请求体文本
 */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf8")
}

/**
 * 取得一次调用抛出的错误
 *
 * 相较 `.catch(e => e)` 的优势在于其同时断言该次调用确实抛出了错误 —— 使用 catch 时，
 * 若被测代码意外成功，后续断言将以成功值进行比对，报错信息不具备提示性。
 * @param promise 待观察的调用
 * @returns 抛出的错误
 * @throws 调用成功时抛错
 */
async function caught(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise
  } catch (err) {
    return err as HttpError
  }
  throw new Error("期望这次调用抛错，但它成功了")
}

/**
 * 路由分发
 * @param req 请求
 * @param res 响应
 */
async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", base)
  const path = url.pathname
  seenHeaders.set(path, req.headers)
  seenBodies.set(path, await readBody(req))

  /** 计数并返回当前次数 */
  const bump = (key: string): number => {
    const next = (hits.get(key) ?? 0) + 1
    hits.set(key, next)
    return next
  }

  switch (path) {
    case "/json":
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true, query: Object.fromEntries(url.searchParams) }))
      return

    case "/text":
      res.writeHead(200, { "content-type": "text/plain" })
      res.end("纯文本")
      return

    case "/bytes":
      res.writeHead(200, { "content-type": "application/octet-stream" })
      res.end(Buffer.from([1, 2, 3, 4]))
      return

    case "/empty":
      res.writeHead(204)
      res.end()
      return

    case "/gzip": {
      const packed = gzipSync(Buffer.from(JSON.stringify({ zipped: true }), "utf8"))
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" })
      res.end(packed)
      return
    }

    case "/echo":
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ method: req.method, body: seenBodies.get(path), type: req.headers["content-type"] }))
      return

    case "/not-json":
      res.writeHead(200, { "content-type": "application/json" })
      res.end("<html>网关错误页</html>")
      return

    case "/404":
      res.writeHead(404, { "content-type": "text/plain" })
      res.end("资源不存在")
      return

    case "/flaky": {
      // 前两次 503，第三次成功
      const key = `flaky:${url.searchParams.get("k") ?? ""}`
      const n = bump(key)
      if (n <= 2) {
        res.writeHead(503, { "content-type": "text/plain" })
        res.end("暂时不可用")
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ attempts: n }))
      return
    }

    case "/rate-limited": {
      const key = `rate:${url.searchParams.get("k") ?? ""}`
      const n = bump(key)
      if (n === 1) {
        res.writeHead(429, { "content-type": "text/plain", "retry-after": "0" })
        res.end("慢点")
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ attempts: n }))
      return
    }

    case "/count": {
      const n = bump(`count:${url.searchParams.get("k") ?? ""}`)
      res.writeHead(500, { "content-type": "text/plain" })
      res.end(String(n))
      return
    }

    case "/slow":
      // 永不响应：交给客户端超时
      return

    case "/redirect":
      res.writeHead(302, { location: "/json" })
      res.end()
      return

    case "/huge": {
      res.writeHead(200, { "content-type": "application/octet-stream" })
      // 分块写 4 MiB，用来撞 maxBodySize
      for (let i = 0; i < 64; i++) res.write(Buffer.alloc(64 * 1024, 7))
      res.end()
      return
    }

    case "/file":
      res.writeHead(200, { "content-type": "application/octet-stream" })
      res.end(Buffer.from("下载内容", "utf8"))
      return

    case "/broken-stream":
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": "1024" })
      res.write(Buffer.alloc(16, 1))
      // 中途掐断：download() 应该把 .part 清掉
      req.socket.destroy()
      return

    default:
      res.writeHead(404)
      res.end()
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const addr = server.address()
  if (addr === null || typeof addr === "string") throw new Error("测试服务器没拿到端口")
  base = `http://127.0.0.1:${addr.port}`
})

afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()))
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
})

describe("请求与响应解析", () => {
  it("默认按 JSON 解析", async () => {
    const http = makeClient()
    await expect(http.get(`${base}/json`)).resolves.toMatchObject({ ok: true })
  })

  it("request 给出完整响应元信息", async () => {
    const http = makeClient()
    const res = await http.request(`${base}/json`)

    expect(res.status).toBe(200)
    expect(res.ok).toBe(true)
    expect(res.headers["content-type"]).toContain("application/json")
    expect(res.cost).toBeGreaterThanOrEqual(0)
  })

  it("按 responseType 给文本 / 字节 / 不读", async () => {
    const http = makeClient()

    await expect(http.request<string>(`${base}/text`, { responseType: "text" })).resolves.toMatchObject({
      data: "纯文本"
    })

    // 刻意断言是 Buffer 而不是裸 Uint8Array：适配器发图片时要 toString("base64")
    const bytes = await http.buffer(`${base}/bytes`)
    expect(Buffer.isBuffer(bytes)).toBe(true)
    expect([...bytes]).toEqual([1, 2, 3, 4])

    await expect(http.request(`${base}/json`, { responseType: "none" })).resolves.toMatchObject({ data: undefined })
  })

  it("空响应体不会导致 JSON 解析失败", async () => {
    const http = makeClient()
    const res = await http.request(`${base}/empty`)
    expect(res.status).toBe(204)
    expect(res.data).toBeUndefined()
  })

  it("自动解压 gzip（undici 的 request 不像 fetch 那样自带）", async () => {
    const http = makeClient()
    await expect(http.get(`${base}/gzip`)).resolves.toEqual({ zipped: true })
  })

  it("响应不是 JSON 时报错带上片段", async () => {
    const http = makeClient()
    await expect(http.get(`${base}/not-json`)).rejects.toThrow(/不是合法 JSON.*网关错误页/s)
  })

  it("stream 模式把流交给调用方", async () => {
    const http = makeClient()
    const res = await http.request<import("node:stream").Readable>(`${base}/text`, { responseType: "stream" })

    const chunks: Buffer[] = []
    for await (const chunk of res.data) chunks.push(chunk as Buffer)
    expect(Buffer.concat(chunks).toString("utf8")).toBe("纯文本")
  })
})

describe("URL 与请求头", () => {
  it("query 里的 undefined / null 被丢掉", async () => {
    const http = makeClient()
    const res = await http.get<{
      /** 服务端回显的查询串 */
      query: Record<string, string>
    }>(`${base}/json`, { query: { uid: 114, keep: "yes", drop: undefined, alsoDrop: null } })

    expect(res.query).toEqual({ uid: "114", keep: "yes" })
  })

  it("baseUrl 与相对路径拼接（两边有没有斜杠都行）", async () => {
    const a = makeClient({ baseUrl: base })
    const b = makeClient({ baseUrl: `${base}/` })

    await expect(a.get("json")).resolves.toMatchObject({ ok: true })
    await expect(b.get("/json")).resolves.toMatchObject({ ok: true })
  })

  it("未配置 baseUrl 时相对路径直接报错，不作推断", async () => {
    const http = makeClient()
    await expect(http.get("/json")).rejects.toThrow(/不是绝对 URL/)
  })

  it("请求头三层合并：内置 < 客户端默认 < 单次调用", async () => {
    // 头值一律使用 ASCII —— HTTP 头仅允许 latin1，写入中文会被 assertHeaders 拦截
    const http = makeClient({ headers: { "x-from": "default", "x-keep": "kept" }, userAgent: "yzng-test" })
    await http.get(`${base}/json`, { headers: { "X-From": "once" } })

    const headers = seenHeaders.get("/json")
    expect(headers?.["x-from"]).toBe("once")
    expect(headers?.["x-keep"]).toBe("kept")
    expect(headers?.["user-agent"]).toBe("yzng-test")
  })

  it("头值写入中文时立即报错，并说明正确的传递方式", async () => {
    // undici 仅返回一句 `invalid x-foo header`，插件作者（例如将群名写入请求头）
    // 无从判断问题所在
    const http = makeClient()
    await expect(http.get(`${base}/json`, { headers: { "x-name": "群名" } })).rejects.toThrow(
      /latin1.*encodeURIComponent/s
    )
  })

  it("json 与 form 自动设 content-type", async () => {
    const http = makeClient()

    await expect(http.post(`${base}/echo`, { a: 1 })).resolves.toMatchObject({
      method: "POST",
      body: '{"a":1}',
      type: "application/json"
    })
    await expect(
      http.request(`${base}/echo`, { form: { uid: 114, name: "甲" } })
    ).resolves.toMatchObject({
      data: { method: "POST", body: "uid=114&name=%E7%94%B2", type: "application/x-www-form-urlencoded" }
    })
  })

  it("有 body 时方法默认 POST，无 body 默认 GET", async () => {
    const http = makeClient()
    await expect(http.request(`${base}/echo`, { body: "裸体" })).resolves.toMatchObject({
      data: { method: "POST" }
    })
    await expect(http.request(`${base}/echo`)).resolves.toMatchObject({ data: { method: "GET" } })
  })

  it("默认跟随重定向，关掉后拿到 302", async () => {
    const http = makeClient()

    await expect(http.get(`${base}/redirect`)).resolves.toMatchObject({ ok: true })
    const res = await http.request(`${base}/redirect`, { followRedirect: false, throwOnError: false })
    expect(res.status).toBe(302)
  })
})

describe("错误处理", () => {
  it("非 2xx 抛 HttpError，带状态码与片段", async () => {
    const http = makeClient()
    await expect(http.get(`${base}/404`)).rejects.toThrow(HttpError)

    const err = await caught(http.get(`${base}/404`))
    expect(err.status).toBe(404)
    expect(err.message).toContain("资源不存在")
  })

  it("throwOnError 关掉后由调用方自己判断", async () => {
    const http = makeClient()
    const res = await http.request(`${base}/404`, { responseType: "text", throwOnError: false })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(404)
  })

  it("连不上时给 status 0 的 HttpError（而不是裸的 ECONNREFUSED）", async () => {
    const http = makeClient()
    // 1 端口上没人监听
    const err = await caught(http.get("http://127.0.0.1:1/nope"))
    expect(err).toBeInstanceOf(HttpError)
    expect(err.status).toBe(0)
    expect(err.message).toContain("请求失败")
  })

  it("超时报错说清超了多久", async () => {
    const http = makeClient()
    const err = await caught(http.get(`${base}/slow`, { timeout: 150 }))
    expect(err).toBeInstanceOf(HttpError)
    expect(err.message).toMatch(/请求超时（150ms）/)
  })

  it("调用方取消时抛 AbortError，不伪装成服务端故障", async () => {
    const http = makeClient()
    const abort = new AbortController()
    const pending = http.get(`${base}/slow`, { signal: abort.signal, timeout: 5000 })
    setTimeout(() => abort.abort(), 30)

    await expect(pending).rejects.toBeInstanceOf(AbortError)
  })

  it("响应体超过上限时中断并指路 download()", async () => {
    const http = makeClient({ maxBodySize: 128 * 1024 })
    await expect(http.buffer(`${base}/huge`)).rejects.toThrow(/超过上限.*download\(\)/s)
  })
})

describe("重试", () => {
  it("503 重试到成功", async () => {
    const http = makeClient()
    const res = await http.get<{
      /** 服务端记录的尝试次数 */
      attempts: number
    }>(`${base}/flaky`, { query: { k: "basic" }, retry: 3 })

    expect(res.attempts).toBe(3)
  })

  it("默认不重试（次数为 0）", async () => {
    const http = makeClient()
    await expect(http.get(`${base}/flaky`, { query: { k: "none" } })).rejects.toThrow(/503/)
    expect(hits.get("flaky:none")).toBe(1)
  })

  it("重试次数用尽后抛最后一次的错误", async () => {
    const http = makeClient()
    await expect(
      http.get(`${base}/count`, { query: { k: "exhaust" }, retry: { times: 2, delay: "1ms" } })
    ).rejects.toThrow(/500/)
    // 首次 + 2 次重试
    expect(hits.get("count:exhaust")).toBe(3)
  })

  it("429 时听 Retry-After", async () => {
    const http = makeClient()
    await expect(
      http.get(`${base}/rate-limited`, { query: { k: "ra" }, retry: 1 })
    ).resolves.toMatchObject({ attempts: 2 })
  })

  it("404 这种语义错误不重试（重试一百次也是同样结果）", async () => {
    const http = makeClient()
    hits.delete("count:na")
    await expect(http.get(`${base}/404`, { retry: 3 })).rejects.toThrow(/404/)
  })

  it("retry.when 可以自定义判定", async () => {
    const http = makeClient()
    const res = await http.request(`${base}/count`, {
      query: { k: "custom" },
      responseType: "text",
      throwOnError: false,
      retry: {
        times: 2,
        delay: "1ms",
        // 只在第一次的响应体是 "1" 时重试，第二次就收手
        when: (_err, response) => response?.data === "1"
      }
    })

    expect(res.data).toBe("2")
    expect(hits.get("count:custom")).toBe(2)
  })

  it("取消信号能打断重试之间的等待", async () => {
    const http = makeClient()
    const abort = new AbortController()
    const pending = http.get(`${base}/count`, {
      query: { k: "abortwait" },
      retry: { times: 5, delay: "5s" },
      signal: abort.signal
    })
    setTimeout(() => abort.abort(), 50)

    await expect(pending).rejects.toBeInstanceOf(AbortError)
  })
})

describe("download", () => {
  /** 落盘目录 */
  const dir = join(tmpdir(), "yzng-http-download")

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("流式落盘，父目录自动创建", async () => {
    const http = makeClient()
    const dest = join(dir, "深", "一层", "a.bin")

    await expect(http.download(`${base}/file`, dest)).resolves.toBe(dest)
    await expect(readFile(dest, "utf8")).resolves.toBe("下载内容")
  })

  it("中途断流时不留下半个文件（否则会被当成有效缓存）", async () => {
    const http = makeClient()
    const dest = join(dir, "broken.bin")

    await expect(http.download(`${base}/broken-stream`, dest)).rejects.toThrow()
    await expect(readFile(dest)).rejects.toThrow(/ENOENT/)
    await expect(readFile(`${dest}.part`)).rejects.toThrow(/ENOENT/)
  })
})

describe("extend", () => {
  it("派生客户端继承并覆盖默认值，且不影响原客户端", async () => {
    const root = makeClient({ baseUrl: base, headers: { "x-tag": "root" } })
    const child = root.extend({ headers: { "x-tag": "child" } })

    await child.get("json")
    expect(seenHeaders.get("/json")?.["x-tag"]).toBe("child")

    await root.get("json")
    expect(seenHeaders.get("/json")?.["x-tag"]).toBe("root")
  })

  it("派生客户端共享连接池，关根即可", async () => {
    const root = makeClient({ baseUrl: base })
    const child = root.extend({ timeout: "5s" })

    await expect(child.get("json")).resolves.toMatchObject({ ok: true })
    await root.close()
    // 关掉后必须明确拒绝：悄悄重建一个池子就等于 close() 白调，
    // 进程还会被 keep-alive 的空闲 socket 吊着不退出
    await expect(child.get("json")).rejects.toThrow(/已关闭/)
  })
})

describe("脱敏", () => {
  it("URL 里的 authkey 等密钥被打码", () => {
    const masked = sanitizeUrl("https://hk4e-api.mihoyo.com/gacha?authkey=ABCDEFGHIJKLMNOP&size=20&uid=114")

    expect(masked).not.toContain("ABCDEFGHIJKLMNOP")
    expect(masked).toContain("uid=114")
    expect(masked).toContain("size=20")
  })

  it("格式错误的 URL 亦不会原样输出", () => {
    const masked = sanitizeUrl(`不是url但很长${"x".repeat(300)}`)
    expect(masked.length).toBeLessThan(140)
  })

  it("请求头里的 cookie / authorization 被打码", () => {
    const masked = sanitizeHeaders({
      cookie: "ltuid=123456789; ltoken=SECRETVALUE12345",
      authorization: "Bearer SECRETTOKENVALUE",
      "x-normal": "看得见"
    })

    expect(masked["cookie"]).not.toContain("SECRETVALUE12345")
    expect(masked["authorization"]).not.toContain("SECRETTOKENVALUE")
    expect(masked["x-normal"]).toBe("看得见")
  })

  it("报错信息里的 URL 已经打过码", async () => {
    const http = makeClient()
    const err = await caught(http.get(`${base}/404`, { query: { authkey: "ABCDEFGHIJKLMNOP" } }))

    expect(err.message).not.toContain("ABCDEFGHIJKLMNOP")
    expect(err.url).not.toContain("ABCDEFGHIJKLMNOP")
  })
})

describe("close 不被在途请求拖住", () => {
  // 用 3 秒而非线上那个 15 秒：被测的是「close 不等在途请求」，请求超时具体多长与此无关，
  // 而用例本身要等它最终落地（见下），15 秒会让这一个用例占满 CI 的耐心
  it(
    "在途请求远未超时，close 仍在宽限内返回",
    async () => {
      const http = makeClient()
      // 服务端永不响应。undici 的 close() 是优雅关闭，会一直等在途请求跑完 —— 若不掐断，
      // 停机就要陪着这个请求等满它的超时（国内网络下拉 GitHub 索引正是此情形）
      const pending = http.get(`${base}/slow`, { timeout: 3000 })
      // 等 socket 真的建立起来，否则关的是一个还没有在途请求的空池子，用例就测不到东西
      await sleep(80)

      const started = Date.now()
      await http.close()
      const spent = Date.now() - started

      // 宽限 500ms，留足余量判定；关键是它远小于那个 3 秒
      expect(spent).toBeLessThan(1500)

      // destroy() 释放的是连接池，它并不代拒那个已经发出的 Promise —— 后者仍按自己的超时落地。
      // 此处等它结束只为不把一个悬空的 Promise 留给下一个用例，不是在断言时序
      await expect(pending).rejects.toThrow()
    },
    15_000
  )
})

describe("默认信号", () => {
  it("extend 带的信号一触发，经它发出的请求随之中止", async () => {
    const http = makeClient()
    const abort = new AbortController()
    // 插件上下文正是这样拿到自己的 http：extend({ signal: 卸载信号 })
    const scoped = http.extend({ signal: abort.signal })
    const pending = scoped.get(`${base}/slow`, { timeout: 5000 })
    setTimeout(() => abort.abort(), 30)

    await expect(pending).rejects.toBeInstanceOf(AbortError)
  })

  it("默认信号与单次请求的信号是并集，任一触发即中止", async () => {
    const http = makeClient()
    const outer = new AbortController()
    const scoped = http.extend({ signal: outer.signal })
    const inner = new AbortController()
    // 只触发单次请求那一个：合并不能把调用方自己的信号吃掉
    const pending = scoped.get(`${base}/slow`, { signal: inner.signal, timeout: 5000 })
    setTimeout(() => inner.abort(), 30)

    await expect(pending).rejects.toBeInstanceOf(AbortError)
  })

  it("默认信号已经中止时，请求不再发出", async () => {
    const http = makeClient()
    const abort = new AbortController()
    abort.abort()
    const scoped = http.extend({ signal: abort.signal })

    // 插件已卸载之后才被调用的代码路径：不该再打出一个注定没人接收的请求
    await expect(scoped.get(`${base}/json`)).rejects.toBeInstanceOf(AbortError)
  })

  it("根客户端不受派生客户端的信号影响", async () => {
    const http = makeClient()
    const abort = new AbortController()
    const scoped = http.extend({ signal: abort.signal })
    abort.abort()

    // 一个插件被卸载不能让内核自己的请求跟着废掉 —— 两者共享连接池，但信号必须各自独立
    await expect(scoped.get(`${base}/json`)).rejects.toBeInstanceOf(AbortError)
    await expect(http.get(`${base}/json`)).resolves.toMatchObject({ ok: true })
  })
})

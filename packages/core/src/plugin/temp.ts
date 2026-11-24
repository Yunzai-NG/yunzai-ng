/**
 * 模块职责：创建插件临时文件，合并同键写入并回收过期缓存。
 * 依赖方向：依赖 Node 文件系统、内核文件工具与插件的 HTTP 客户端。
 * 生命周期：每个使用临时文件的插件实例一份，卸载时关闭。
 * 注意事项：缓存键不参与路径拼接；关闭后才完成的写入也要删除。
 */
import { randomUUID } from "node:crypto"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import type { HttpClient, PluginTemp, TempCacheOptions, TempFile, TempSource } from "@yunzai-ng/types"
import { parseDuration } from "../util/duration.js"
import { atomicWrite } from "../util/fs.js"

/** 文件由创建它的实例回收；重载间不共享引用。 */
export class TempFiles implements PluginTemp {
  readonly #owned = new Set<string>()
  readonly #cache = new Map<string, { path: string; until: number }>()
  readonly #pending = new Map<string, Promise<string>>()
  #timer?: NodeJS.Timeout
  #closed = false

  /** 只使用插件自己的下载客户端与目录。 */
  constructor(
    private readonly dir: string,
    private readonly http: Pick<HttpClient, "download">,
    private readonly onError: (err: unknown) => void
  ) {}

  /** 生成独立文件。 */
  async file(source: TempSource, ext = ""): Promise<TempFile> {
    if (this.#closed) throw new Error("插件临时文件接口已关闭")
    if (ext !== "" && !/^\.[a-z0-9]{1,16}$/i.test(ext)) throw new Error("临时文件扩展名无效")
    const path = join(this.dir, randomUUID() + ext)
    if (typeof source === "object" && "url" in source) {
      if (!["http:", "https:"].includes(new URL(source.url).protocol)) throw new Error("仅支持 HTTP(S) 下载")
      await this.http.download(source.url, path)
    } else {
      await atomicWrite(path, source)
    }
    if (this.#closed) {
      await rm(path, { force: true })
      throw new Error("插件临时文件接口已关闭")
    }
    this.#owned.add(path)
    return { path, remove: () => this.#remove(path) }
  }

  /** 同键并发只生成一次，失败不缓存。 */
  async cached(key: string, source: TempSource, options: TempCacheOptions): Promise<string> {
    if (this.#closed) throw new Error("插件临时文件接口已关闭")
    const ttl = parseDuration(options.ttl)
    if (!key || !Number.isFinite(ttl) || ttl <= 0) throw new Error("缓存需要非空键和正的 TTL")
    const hit = this.#cache.get(key)
    if (hit && hit.until > Date.now()) return hit.path
    if (hit) this.#expire(key, hit.path)
    const pending = this.#pending.get(key)
    if (pending) return pending
    const task = this.file(source, options.ext).then(async file => {
      if (this.#closed) {
        await file.remove()
        throw new Error("插件临时文件接口已关闭")
      }
      this.#cache.set(key, { path: file.path, until: Date.now() + ttl })
      this.#timer ??= setInterval(() => this.#sweep(), 60_000).unref()
      return file.path
    }).finally(() => this.#pending.delete(key))
    this.#pending.set(key, task)
    return task
  }

  async #remove(path: string): Promise<void> {
    if (!this.#owned.has(path)) return
    await rm(path, { force: true })
    this.#owned.delete(path)
  }

  #expire(key: string, path: string): void {
    this.#cache.delete(key)
    void this.#remove(path).catch(this.onError)
  }

  #sweep(): void {
    for (const [key, entry] of this.#cache) {
      if (entry.until <= Date.now()) this.#expire(key, entry.path)
    }
    if (!this.#cache.size) {
      clearInterval(this.#timer)
      this.#timer = undefined
    }
  }

  /** 停止接受新文件，并清理本实例尚未释放的文件。 */
  async close(): Promise<void> {
    this.#closed = true
    clearInterval(this.#timer)
    this.#cache.clear()
    for (const path of this.#owned) await this.#remove(path).catch(this.onError)
  }
}

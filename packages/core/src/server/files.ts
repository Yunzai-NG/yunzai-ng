/**
 * 模块职责：静态文件定位 —— 把 URL 剩余段解析成目录内的一个真实文件
 * 依赖方向：依赖 util/fs 的越界校验；不认识 Fastify
 * 生命周期：纯函数
 * 注意事项：**真正读文件与设响应头的活交给 `@fastify/static`**（mime、ETag、304、Range、HEAD 都由
 *          它背后的 `@fastify/send` 实现），本文件只回答「该给哪个文件」。
 *
 *          它以 `{ serve: false }` 注册，那样它一条路由都不注册、只装饰出 `reply.sendFile()`。
 *          必须如此 —— 它默认会占用 `/*`，而那正是本服务器自己的总入口，冲突会让 Fastify 直接抛
 *          duplicate route。
 *
 *          路径越界仍先由 `safeJoin()` 挡一道，不依赖 `@fastify/send` 的内部检查：任意文件读取是
 *          这类服务器最致命的漏洞，值得两道锁。
 *
 *          **本文件不定位面板前端产物。** 面板是插件，产物目录由它自己解析并经 `ctx.panel()` 传入
 *          —— 内核一旦掌握前端的目录约定，「替换面板」就退化成必须改内核。
 */
import { isDirectory, isFile, safeJoin } from "../util/fs.js"

/** 目录请求与单页回退都指向这个文件 */
const INDEX_FILE = "index.html"

/** 一个静态目录挂载 */
export interface StaticMount {
  /** 本地目录绝对路径 */
  readonly dir: string
  /**
   * 找不到文件时是否回退到 `index.html`
   *
   * 单页应用需要：`/plugins` 这类前端路由在磁盘上并不存在，
   * 必须由 `index.html` 接管再由前端路由器解析。
   */
  readonly spa: boolean
  /**
   * 注册方前缀
   *
   * 仅用于归属查询与面板展示，不参与文件定位。内核据此判断根路径是否已被
   * 插件接管，从而决定是否提示使用者安装面板插件。
   */
  readonly scope: string
}

/**
 * 判断最后一段是否带扩展名
 *
 * 单页回退**仅对"形似页面"的请求生效**。否则 `/assets/missing-abc.js`
 * 将取得一份 HTML，浏览器报告的是"MIME 类型不匹配"或语法错误，
 * 排查方向完全偏离 —— 该情形应当如实返回 404。
 * @param rest 相对挂载点的路径
 * @returns 是否带扩展名
 */
function looksLikeFile(rest: string): boolean {
  const last = rest.slice(rest.lastIndexOf("/") + 1)
  return last.includes(".")
}

/**
 * 在挂载目录内安全解析出一个候选绝对路径
 * @param dir 挂载目录
 * @param rel 相对路径
 * @returns 绝对路径；越界时 undefined
 */
function within(dir: string, rel: string): string | undefined {
  try {
    return safeJoin(dir, rel)
  } catch {
    // 越界一律按"文件不存在"处理：告知对方"已越界"等同于确认了目录布局
    return undefined
  }
}

/**
 * 把 URL 剩余段解析成挂载目录内的一个真实文件
 * @param mount 挂载信息
 * @param rest 相对挂载点的剩余路径（已解码，不以 `/` 开头，可为空串）
 * @returns 可直接交给 `reply.sendFile()` 的相对路径；找不到时 undefined
 */
export async function resolveStaticFile(mount: StaticMount, rest: string): Promise<string | undefined> {
  const wanted = rest === "" ? INDEX_FILE : rest

  const direct = within(mount.dir, wanted)
  if (direct !== undefined) {
    if (await isFile(direct)) return wanted
    // 目录请求（`/docs` 或 `/docs/`）取其中的 index.html
    if (await isDirectory(direct)) {
      const indexRel = `${wanted}/${INDEX_FILE}`
      const index = within(mount.dir, indexRel)
      if (index !== undefined && (await isFile(index))) return indexRel
    }
  }

  if (mount.spa && !looksLikeFile(wanted)) {
    const fallback = within(mount.dir, INDEX_FILE)
    if (fallback !== undefined && (await isFile(fallback))) return INDEX_FILE
  }
  return undefined
}

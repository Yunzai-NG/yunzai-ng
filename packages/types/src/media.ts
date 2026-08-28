/**
 * 模块职责：媒体资源引用的统一表示
 * 依赖方向：叶子模块
 * 生命周期：纯类型
 * 注意事项：**刻意区分来源，不统一转 base64。** base64 会让单张图多占两份内存、
 *          多一次 CPU 编码，而同机部署时本可直接读盘。区分之后适配器可选最省的通道。
 */

/**
 * 归一化后的媒体引用
 *
 * 适配器发送时的优先级建议：`id` > `url` > `path` > `buffer` > `base64`。
 * 只有目标平台确实不支持前面几种时才回落到 base64。
 */
export type MediaRef =
  | {
      /** 远端地址，平台侧自行下载，最省本机内存 */
      kind: "url"
      /** 完整 URL */
      url: string
      /** 下载所需的额外请求头（如米游社图床防盗链） */
      headers?: Record<string, string>
    }
  | {
      /** 本地文件绝对路径；同机部署的 NapCat 可直接读盘 */
      kind: "path"
      /** 绝对路径 */
      path: string
    }
  | {
      /** 内存字节，适合渲染器刚出图的场景 */
      kind: "buffer"
      /** 字节内容 */
      data: Uint8Array
      /** 建议文件名 */
      name?: string
      /** MIME 类型 */
      mime?: string
    }
  | {
      /** 已编码的 base64（不含 `data:` 前缀），最后的兜底 */
      kind: "base64"
      /** base64 正文 */
      base64: string
      /** MIME 类型 */
      mime?: string
    }
  | {
      /** 平台侧的资源 id（如已上传过的 file_id），零传输 */
      kind: "id"
      /** 平台资源标识 */
      id: string
    }

/**
 * 媒体输入的宽松形式
 *
 * 插件作者可以随手传字符串或 Buffer，内核的 `toMediaRef()` 负责归一化：
 * - `http(s)://…` → url
 * - `file://…`、绝对路径 → path
 * - `base64://…`、`data:…;base64,…` → base64
 * - `Uint8Array` / `ArrayBuffer` → buffer
 */
export type MediaInput = string | URL | Uint8Array | ArrayBuffer | MediaRef

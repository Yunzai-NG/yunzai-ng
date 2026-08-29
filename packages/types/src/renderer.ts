/**
 * 模块职责：渲染器抽象（出图）
 * 依赖方向：依赖 segment.ts
 * 生命周期：纯类型
 * 注意事项：插件在注册时声明资源根，模板里以 `{{ res }}` 取用 —— 模板中不做任何路径算术，
 *          故移动模板目录不会导致空白页面。
 */
import type { ImageSegment } from "./segment.js"

/** 输出图片格式 */
export type RenderImageType = "jpeg" | "png" | "webp"

/** 视口设置 */
export interface RenderViewport {
  /**
   * 宽度（CSS 像素）
   *
   * 缺省由渲染器决定。截图对象是 `selector` 指定的元素，元素自身的宽度通常
   * 已由模板 CSS 定死，所以视口宽度多数情况下只影响媒体查询。
   */
  width?: number
  /** 高度；缺省则按内容自适应 */
  height?: number
  /** 缩放倍率，等价于 devicePixelRatio；缺省取配置项 `render.scale` */
  scale?: number
}

/** 一次渲染请求 */
export interface RenderRequest {
  /**
   * 模板标识
   *
   * 由内核解析为绝对路径：相对路径按发起插件的模板根解析。
   * `html` 已给出时不再解析文件，此字段退化为日志与临时文件名所用的标签。
   */
  template: string
  /** 模板数据 */
  data: Record<string, unknown>
  /** 模板根目录绝对路径，由内核根据发起插件填入 */
  templateRoot: string
  /** 静态资源根目录绝对路径，模板中以 `res` 变量取用 */
  resourceRoot: string
  /** 发起插件名，用于日志与临时文件分目录 */
  origin: string

  /**
   * 已渲染好的完整 HTML
   *
   * 给出时渲染器跳过字符串模板引擎，直接使用这段文本 —— TSX 模板走的就是这条通路：
   * 组件在插件进程内求值完毕，渲染器只负责注入 `<base>`、编译 Tailwind 与截图。
   * 由此模板数据在编译期即可获得类型检查，而字符串模板层永远做不到这一点。
   */
  html?: string

  /**
   * 本次渲染是否需要编译 Tailwind 工具类
   *
   * **由发起方声明，而非由渲染器揣度。** 渲染器无从判断一段 HTML 里的 `class` 是工具类
   * 还是模板自定义的类名：`flex` 既可能出自 Tailwind，也可能是模板自己写的一条 CSS 规则。
   * 猜错的代价是不对称的 —— 该编译而未编译只是少了样式，不该编译而编译了则会引入
   * preflight，把现存模板的边距与字号一并重置。
   *
   * 缺省（undefined）时由渲染器自身的配置决定，而那一项缺省关闭 —— **不声明即不编译**。
   * 于是不用工具类的插件不必装 `tailwindcss`，也不会收到与它无关的编译告警。
   * 声明 `false` 与不声明的效果相同，只是把「不用工具类」写成了明文。
   * 仅在 `html` 通路生效：字符串模板一律不编译工具类。
   */
  tailwind?: boolean

  /** 截图元素选择器，缺省 `#container` 回落 `body` */
  selector?: string
  /** 输出格式，缺省 jpeg */
  type?: RenderImageType
  /** jpeg/webp 质量 0-100，缺省 90 */
  quality?: number
  /** 背景透明（仅 png/webp 有效） */
  omitBackground?: boolean
  /** 视口 */
  viewport?: RenderViewport
  /** 单次渲染超时毫秒 */
  timeout?: number
  /**
   * 长图分页
   *
   * `true` 用默认页高，数字表示页高像素。分页时输出格式强制 jpeg。
   */
  multiPage?: boolean | number
}

/** 渲染结果 */
export interface RenderResult {
  /** 图片字节，分页时按顺序多张 */
  images: Uint8Array[]
  /** 渲染耗时毫秒 */
  cost: number
  /** 实际使用的渲染器 id */
  renderer: string
}

/**
 * 渲染器提供方
 *
 * 由插件注册（`ctx.registerRenderer`）。内核仅认识该接口，
 * 因此 puppeteer 可被替换为任意实现而插件代码无须改动。
 */
export interface RendererProvider {
  /** 渲染器 id，配置中以其指定优先使用哪一个 */
  readonly id: string
  /** 展示名 */
  readonly name?: string

  /**
   * 是否可用
   *
   * 内核在选择渲染器时调用：例如 puppeteer 探测不到 Chromium 就返回 false，
   * 内核便回落到下一个渲染器而不是直接报错。
   * @returns 当前是否可用
   */
  available(): Promise<boolean>

  /**
   * 执行渲染
   * @param req 渲染请求
   * @returns 渲染结果
   * @throws 渲染失败时抛出
   */
  render(req: RenderRequest): Promise<RenderResult>

  /** 释放资源（关闭浏览器等） */
  dispose?(): Promise<void>
}

/** 插件调用 `ctx.render` 时可传的选项（模板根等由内核补齐） */
export type RenderOptions = Omit<
  RenderRequest,
  "template" | "data" | "templateRoot" | "resourceRoot" | "origin" | "html"
>

/**
 * 一张已渲染好、可直接交给渲染器的页面
 *
 * TSX 模板的产物形态。`name` 仅用于日志、临时文件名与统计，不参与路径解析 ——
 * 内容已在 `html` 里，渲染器无须再去磁盘找任何模板文件。
 *
 * 由 `@yunzai-ng/jsx` 的 `defineTemplate()` 构造；类型定义放在此处而非 jsx 包，
 * 是为使内核与渲染器都能识别这一形态而无须依赖 jsx 包。
 */
export interface RenderablePage {
  /** 页面名，等价于字符串模板通路里的模板名 */
  readonly name: string
  /** 完整 HTML 文本 */
  readonly html: string
  /**
   * 该页面是否使用 Tailwind 工具类
   *
   * 由 `defineTemplate()` 的第三参声明，直通 {@link RenderRequest.tailwind}。
   * 写在页面上而非每个调用点上：用不用工具类是模板自身的属性，
   * 让每处 `render()` 各自重复一遍，迟早会有一处与模板不符。
   */
  readonly tailwind?: boolean
}

/**
 * `ctx.render` 的返回值
 *
 * 直接就是可发送的图片段，故 `await e.reply(await ctx.render(...))` 成立，无须再包一层。
 */
export type RenderedImage = ImageSegment | ImageSegment[]

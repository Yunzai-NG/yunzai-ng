/**
 * 模块职责：`@yunzai-ng/types` 的唯一入口
 * 依赖方向：汇总本包全部子模块
 * 生命周期：编译后仅剩类型声明，无运行时代码
 * 注意事项：`EventExtensions` 必须声明在**入口模块**里，
 *          否则插件的 `declare module "@yunzai-ng/types"` 增补不到
 *          （TypeScript 的接口合并只认声明所在的模块，认不了 re-export）。
 */

/**
 * 事件字段扩展点
 *
 * 插件用模块增补往消息事件上加字段，既有类型又不污染内核：
 *
 * ```ts
 * declare module "@yunzai-ng/types" {
 *   interface EventExtensions {
 *     /** 当前指令针对的游戏 *\/
 *     game?: "gs" | "sr" | "zzz"
 *   }
 * }
 * ```
 *
 * 内核因此不必知道任何具体业务字段的存在。
 */
export interface EventExtensions {}

export type * from "./adapter.js"
export type * from "./bot.js"
export type * from "./common.js"
export type * from "./config.js"
export type * from "./contact.js"
export type * from "./event.js"
export type * from "./http.js"
export type * from "./logger.js"
export type * from "./media.js"
export type * from "./platform.js"
export type * from "./plugin.js"
export type * from "./renderer.js"
export type * from "./schema.js"
export type * from "./segment.js"
export type * from "./server.js"
export type * from "./store.js"

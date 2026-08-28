/**
 * 模块职责：发送目标的键与可读描述
 * 依赖方向：仅依赖类型包
 * 生命周期：纯函数
 * 注意事项：`targetKey` 有两个消费者 —— 同会话串行发送的队列键（adapter/bots）与
 *          `e.prompt()` 的会话键（pipeline/prompt）。两者对"什么算同一个会话"
 *          必须有完全一致的理解，否则会出现"用户在 A 会话回答、B 会话的等待者被唤醒"
 *          这类只在多账号 + 频道场景下才复现的问题。放在一处就没有走样的机会。
 *
 *          键里**不含**平台与 selfId：那是调用方的作用域问题（Bot 的发送队列天然
 *          按账号隔离，而 prompt 需要自己加前缀）。这里只回答"哪个会话"。
 */
import type { SendTarget } from "@yunzai-ng/types"

/**
 * 算出发送目标的会话键
 *
 * 私聊**刻意忽略** `gid`：群临时会话与直接私聊是同一个人的同一个聊天窗口，
 * 分成两个键会让"从群里发起的对话"与"私聊里的对话"各排一条队。
 * @param target 发送目标
 * @returns 会话键
 */
export function targetKey(target: SendTarget): string {
  switch (target.scene) {
    case "group":
      return `g:${target.gid}`
    case "guild":
      return `c:${target.guildId}/${target.channelId}`
    case "private":
      return `p:${target.uid}`
  }
}

/**
 * 将发送目标渲染为一段可读描述
 * @param target 发送目标
 * @returns 描述文本，如 `群 123456`
 */
export function describeTarget(target: SendTarget): string {
  switch (target.scene) {
    case "group":
      return `群 ${target.gid}`
    case "guild":
      return `频道 ${target.guildId}/${target.channelId}`
    case "private":
      return target.gid === undefined ? `私聊 ${target.uid}` : `临时会话 ${target.uid}（来自群 ${target.gid}）`
  }
}

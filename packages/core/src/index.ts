/**
 * 模块职责：`@yunzai-ng/core` 的唯一入口，汇总导出内核各模块的公开符号
 * 依赖方向：只做转发，本身不含逻辑
 * 生命周期：无
 * 注意事项：刻意使用 `export *` 而非逐个列举 —— 手写清单必然与实现脱节，遗漏一个类型
 *          就迫使使用者去 import 内核内部路径。代价是各模块须自我克制：仅 `export`
 *          确实供外部使用的符号。
 *
 *          测试替身（`testing/fake.ts`）**不在此处**，经 `@yunzai-ng/core/testing` 子路径
 *          导出，否则替身实现会进入生产依赖图。
 *
 *          类型定义在 `@yunzai-ng/types`，本包不转发：类型包零运行时依赖，插件的 `.d.ts`
 *          可只引用它而不引入整个内核。
 */

/* ────────────────────────────── 内核 ────────────────────────────── */
export * from "./kernel/app.js"
export * from "./kernel/runtime.js"
export * from "./kernel/policy.js"
export * from "./kernel/sql-sink.js"
export * from "./kernel/kv-sink.js"

/* ────────────────────────────── 插件体系 ────────────────────────────── */
export * from "./plugin/define.js"
export * from "./plugin/context.js"
export * from "./plugin/host.js"
export * from "./plugin/hooks.js"
export * from "./plugin/events.js"
export * from "./plugin/services.js"
export * from "./plugin/discover.js"
export * from "./plugin/market.js"
export * from "./plugin/pm.js"
export * from "./plugin/tar.js"

/* ────────────────────────────── 消息 ────────────────────────────── */
export * from "./message/segment.js"
export * from "./message/split.js"
export * from "./message/target.js"

/* ────────────────────────────── 管线 ────────────────────────────── */
export * from "./pipeline/event.js"
export * from "./pipeline/middleware.js"
export * from "./pipeline/router.js"
export * from "./pipeline/cooldown.js"
export * from "./pipeline/prompt.js"
export * from "./pipeline/dispatch.js"

/* ────────────────────────────── 适配器与账号 ────────────────────────────── */
// 适配器插件要的是 @yunzai-ng/types 里的 `AdapterProvider` / `BotDriver` 接口，
// 这里导出的是内核侧的注册表与管理器 —— 给 WebUI 与测试用，插件通常不碰
export * from "./adapter/registry.js"
export * from "./adapter/bots.js"
export * from "./adapter/host.js"
export * from "./adapter/accounts.js"
export * from "./adapter/login.js"

/* ────────────────────────────── 调度与渲染 ────────────────────────────── */
export * from "./scheduler/index.js"
export * from "./render/registry.js"

/* ────────────────────────────── 配置 ────────────────────────────── */
export * from "./config/schema.js"
export * from "./config/store.js"
export * from "./config/core-config.js"
export * from "./config/yaml.js"

/* ────────────────────────────── 日志 ────────────────────────────── */
export * from "./logger/index.js"
export * from "./logger/format.js"
export * from "./logger/rotate.js"

/* ────────────────────────────── 存储 ────────────────────────────── */
export * from "./store/index.js"
export * from "./store/kv.js"
export * from "./store/sql.js"
export * from "./store/memory.js"
export * from "./store/json.js"
export * from "./store/level.js"

/* ────────────────────────────── 网络 ────────────────────────────── */
export * from "./http/client.js"

/* ────────────────────────────── 服务器 ────────────────────────────── */
export * from "./server/index.js"
export * from "./server/api.js"
export * from "./server/auth.js"
export * from "./server/browse.js"
export * from "./server/files.js"
export * from "./server/table.js"

/* ────────────────────────────── 平台 ────────────────────────────── */
export * from "./platform/paths.js"
export * from "./platform/detect.js"
export * from "./platform/system.js"

/* ────────────────────────────── 工具 ────────────────────────────── */
// 以下为插件作者最常自行重复实现的工具（切分长文本、LRU、退避重试、脱敏），
// 一并导出，以免各插件各自实现一份并各自带有缺陷
export * from "./util/deep.js"
export * from "./util/defer.js"
export * from "./util/dispose.js"
export * from "./util/duration.js"
export * from "./util/fs.js"
export * from "./util/id.js"
export * from "./util/lru.js"
export * from "./util/queue.js"
export * from "./util/text.js"

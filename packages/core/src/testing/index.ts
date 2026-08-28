/**
 * 模块职责：`@yunzai-ng/core/testing` 的入口，汇总内核提供的测试替身
 * 依赖方向：只做转发
 * 生命周期：无
 * 注意事项：这些替身刻意**不**从主入口 `@yunzai-ng/core` 导出 —— 一并导出会使测试替身
 *          进入生产依赖图（见 src/index.ts 的说明）。适配器与插件作者编写测试时：
 *          ```ts
 *          import { createMockAdapter, fakeLogger } from "@yunzai-ng/core/testing"
 *          ```
 *
 *          与内核自身那些 `*.test.ts` 的分工：后者是内部单元测试，直接以相对路径 import
 *          内部模块；此处是**对外公开**的替身，因此每次改动均应视为 API 变更。
 */
export * from "./fake.js"
export * from "./mock-adapter.js"

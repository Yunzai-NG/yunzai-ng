import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

/**
 * 把仓库内的相对路径转成绝对路径
 *
 * vitest 的 alias 必须给绝对路径，相对路径会相对被解析的文件而不是配置文件。
 * @param rel 相对本文件的路径
 * @returns 绝对路径
 */
const at = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      // 工作区包一律指向**源码**而不是 dist。插件的测试会 `import "@yunzai-ng/core"`，
      // 若走 dist 就有两个问题：一是必须先 build 才能跑测试，忘了就测的是上一版；
      // 二是 dist 里的相对导入带 `.js` 后缀，会被下面那条规则改写成 `.ts` 而找不到文件。
      // 具体子路径要排在裸包名之前，否则 `@yunzai-ng/core` 会先把它匹配掉。
      { find: /^@yunzai-ng\/core\/testing$/, replacement: at("./packages/core/src/testing/index.ts") },
      { find: /^@yunzai-ng\/core$/, replacement: at("./packages/core/src/index.ts") },
      { find: /^@yunzai-ng\/jsx\/jsx-runtime$/, replacement: at("./packages/jsx/src/jsx-runtime.ts") },
      { find: /^@yunzai-ng\/jsx$/, replacement: at("./packages/jsx/src/index.ts") },
      { find: /^@yunzai-ng\/types$/, replacement: at("./packages/types/src/index.ts") },
      // 源码里 import 统一带 `.js` 后缀（NodeNext ESM 的硬要求），
      // 但测试时实际文件是 `.ts`，需要把相对导入的后缀改回来。
      { find: /^(\.{1,2}\/.*)\.js$/, replacement: "$1.ts" }
    ]
  },
  // TSX 模板由 esbuild 走自动转换，运行时指向本仓库的 jsx 包 ——
  // 上面的 alias 会把它再解析到源码，因此测试不需要先 build
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "@yunzai-ng/jsx"
  },
  test: {
    include: ["packages/*/src/**/*.test.{ts,tsx}"],
    environment: "node",
    // 内核用到 level/sqlite 等原生模块，串行更稳
    pool: "forks",
    coverage: {
      provider: "v8",
      include: ["packages/core/src/**", "packages/jsx/src/**"],
      reporter: ["text", "html"]
    }
  }
})

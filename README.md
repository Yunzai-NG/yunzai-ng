# Yunzai NG

[![CI](https://github.com/Yunzai-NG/yunzai-ng/actions/workflows/ci.yml/badge.svg)](https://github.com/Yunzai-NG/yunzai-ng/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@yunzai-ng/core?logo=npm&label=core)](https://www.npmjs.com/package/@yunzai-ng/core)
[![npm](https://img.shields.io/npm/v/@yunzai-ng/cli?logo=npm&label=cli)](https://www.npmjs.com/package/@yunzai-ng/cli)
[![npm](https://img.shields.io/npm/v/@yunzai-ng/types?logo=npm&label=types)](https://www.npmjs.com/package/@yunzai-ng/types)
[![npm](https://img.shields.io/npm/v/@yunzai-ng/jsx?logo=npm&label=jsx)](https://www.npmjs.com/package/@yunzai-ng/jsx)
[![下载量](https://img.shields.io/npm/dm/@yunzai-ng/core?label=%E4%B8%8B%E8%BD%BD%2F%E6%9C%88)](https://www.npmjs.com/package/@yunzai-ng/core)
[![Node](https://img.shields.io/node/v/@yunzai-ng/core?logo=node.js)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](tsconfig.base.json)
[![许可](https://img.shields.io/npm/l/@yunzai-ng/core)](LICENSE)

面向 QQ 机器人的可插拔运行时内核。TypeScript,零全局变量,插件可装可卸可热重载。

> 本仓库只有**内核**。适配器、渲染器、面板、业务功能全部是插件,各自成库 ——
> 见[官方插件](#官方插件)。

## 它与旧 Yunzai 的区别

一句话:**内核不认识任何插件**。这不是口号,由 `scripts/check-layering.mjs` 在 CI 里守着 ——
内核里出现一处指向插件的 import 就构建失败。

由此带来三件旧框架做不到的事:

- **一个插件出问题,其余插件与机器人照常工作。** 导入失败、setup 抛错、setup 超时、依赖缺失,
  一律降级为一条 `status = "error"` 记录,内核继续启动。
- **卸载真的归还资源。** 每个插件一份 `DisposalRegistry` 与一个 `AbortController`,卸载时先 abort
  再逆序回收 —— 定时器、路由、监听器、缓存一个不留。
- **换掉任何一层不必改内核。** 连面板都是插件:内核只检测站点根路径有没有被接管,不自带兜底前端。

## 装与起

需要 Node ≥ 20.11 与 pnpm。

```bash
pnpm install
pnpm run build
pnpm start
```

首次启动会在**主目录**下生成配置与数据,并打印它的位置。主目录默认按平台取(Windows 是
`%LOCALAPPDATA%\YunzaiNG`),可用环境变量 `YZNG_HOME` 指定:

```bash
# Windows PowerShell
$env:YZNG_HOME = "D:\yunzai"; pnpm start
```

起来之后打开它打印的面板地址。**收发消息还需要装一个适配器**,面板的插件市场里装。

## 包

| 包 | 作用 | 谁依赖它 |
|---|---|---|
| `@yunzai-ng/types` | 全部公开类型,**零运行时依赖** | 插件与内核都依赖它 |
| `@yunzai-ng/core` | 内核实现:插件宿主、管线、配置、存储、服务器、调度 | 插件依赖它取 `definePlugin` 等 |
| `@yunzai-ng/cli` | 命令行:`start` / `dev` / `doctor` / `plugin new` | — |
| `@yunzai-ng/jsx` | 可选的 JSX 运行时,给写模板的人 | 渲染器插件 |

`types` 与 `core` 分开是刻意的:类型包零运行时依赖,故插件的 `.d.ts` 只引用它而不必引入整个内核。

## 写一个插件

```bash
pnpm exec yzng plugin new my-plugin
```

或者手写 —— 一个插件就是一个默认导出:

```ts
import { definePlugin, s } from "@yunzai-ng/core"

export default definePlugin({
  name: "hello",
  configSchema: s.object({ greeting: s.string().default("你好") }),
  setup(ctx) {
    ctx.command("#打招呼").desc("回一句话").action(async e => {
      await e.reply(ctx.config.get().greeting)
    })
  }
})
```

`configSchema` 一写,面板上就有了表单 —— 一份声明同时用于校验、生成带注释的 YAML、渲染表单。

完整的写法见[文档站](https://github.com/Yunzai-NG/docs)的「插件开发」。

## 官方插件

| 插件 | 作用 |
|---|---|
| [webui-plugin](https://github.com/Yunzai-NG/webui-plugin) | 面板:七个页面、配置表单、面板插件宿主与商店 |
| [adapter-napcat](https://github.com/Yunzai-NG/adapter-napcat) | 以 OneBot v11 接入 NapCat,提供 QQ 收发 |
| [renderer-puppeteer](https://github.com/Yunzai-NG/renderer-puppeteer) | 把模板渲染成图片 |
| [hardware-plugin](https://github.com/Yunzai-NG/hardware-plugin) | 整机硬件监控,九枚面板组件 |
| [webui-example](https://github.com/Yunzai-NG/webui-example) | 面板插件的示例包,用于照抄 |
| [mhy-game-plugin](https://github.com/Yunzai-NG/mhy-game-plugin) | 原神 / 星穹铁道 / 绝区零 查询 |

## 开发

```bash
pnpm run verify   # 构建 + 分层门禁 + 首启动冒烟 + 类型检查 + lint + 用例
```

`verify` 里有两道门是这个项目特有的:

- **`check:layering`** —— 扫描内核源码,内核里出现指向插件的 import 就失败。
- **`check:firstrun`** —— 在一个临时主目录里真起一次,确认首次启动能生成配置并正常停机。

用例放在 `packages/*/src/` 之下(与被测代码同目录)。`vitest.config.ts` 的 `include` 只覆盖那里,
**放在别处不会报错,只会静默不执行**。

## 许可

AGPL-3.0-or-later。见 [LICENSE](LICENSE)。

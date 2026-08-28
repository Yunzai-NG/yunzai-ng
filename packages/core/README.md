# @yunzai-ng/core

内核实现。插件从这里取 `definePlugin`、`s`(配置 schema)与若干工具。

## 唯一入口

```ts
import { definePlugin, s } from "@yunzai-ng/core"
```

`src/index.ts` 刻意用 `export *` 而非逐个列举 —— 逐个列举的清单必然与实现脱节,而漏掉一个类型
就要使用者改内核。作为交换,各模块自己须克制:**只 `export` 确实供外部使用的符号**。

测试替身在 `@yunzai-ng/core/testing` 子路径,**不在主入口** —— 并进去会让替身实现进入生产依赖图。

## 目录

| 目录 | 职责 |
|---|---|
| `kernel/` | 应用生命周期 `create → start → stop`,以及运行期子系统的装配 |
| `plugin/` | 插件宿主:发现、导入、上下文、卸载、热重载、市场 |
| `pipeline/` | 消息管线:事件、中间件、路由、冷却、上下文问答、分发 |
| `config/` | 配置 schema 构造器与 YAML 存取 |
| `store/` | KV / SQL / JSON / 内存四种存储 |
| `server/` | 共享 HTTP + WebSocket 服务器、面板 API、鉴权 |
| `adapter/` | 适配器注册表、账号生命周期、Bot 门面 |
| `render/` | 渲染注册表(内核不认识 puppeteer) |
| `scheduler/` | 定时任务 |
| `logger/` | 日志与轮转 |
| `http/` | 全框架唯一的 HTTP 客户端 |
| `platform/` | 目录布局、平台探测、磁盘与 GPU |
| `util/` | 插件作者最常自己重复实现的那些(切分、LRU、退避重试、脱敏) |
| `testing/` | 测试替身,经子路径导出 |

## 三条不可动的约束

**内核不依赖任何插件。** 由 `scripts/check-layering.mjs` 在 CI 里守着。

**装配顺序不是任意排列。** 日志早于配置(否则「读配置时出错」无处记录)、存储早于插件(插件
加载失败要写状态)、`listen()` 晚于插件加载(否则有「面板部分可用」的窗口)。逐条写在
`kernel/app.ts` 的文件头。

**卸载必须完整归还资源。** 每个注册型方法都把 disposer 登记进 `DisposalRegistry`,插件作者
无从遗漏 —— 否则改十次代码就有十份定时器同时在跑。

## 读源码的入口

想看「一个插件是怎么跑起来的」:`plugin/host.ts` → `plugin/context.ts` → `plugin/hooks.ts`。
最后那个是理解全局的关键 —— 它解释了为什么上下文不直接 import 各子系统。

想看「一条消息是怎么走的」:`pipeline/dispatch.ts` → `pipeline/router.ts` → `adapter/bots.ts`。

# @yunzai-ng/types

Yunzai NG 的全部公开类型。**零运行时依赖,也零工作区依赖。**

## 为什么单独一个包

插件的 `.d.ts` 需要引用这些类型,而它不该因此引入整个内核。把类型抽出来之后,一个只写类型
声明的包(例如适配器的类型补充)可以只依赖这一个包。

「零依赖」是硬约束,不是现状描述:本包**不许 import 任何工作区内的包**。一旦它引了 `core`,
上面那件事就不成立了。

## 里面有什么

| 文件 | 内容 |
|---|---|
| `plugin.ts` | `PluginContext`、`AppView`、各类注册选项 —— 插件能看到的一切 |
| `event.ts` | 事件模型:消息、通知、请求、元事件 |
| `contact.ts` | 联系人、群、成员、引用 |
| `adapter.ts` | `AdapterProvider` 与 `BotDriver` —— 写适配器实现这两个 |
| `renderer.ts` | 渲染器接口 |
| `schema.ts` | `SchemaDescriptor` —— 配置声明降级成的表单描述 |
| `store.ts` | KV 与 SQL 句柄 |
| `http.ts` | HTTP 客户端 |
| `platform.ts` | 目录布局、平台信息、资源占用 |
| `config.ts` | 配置句柄 |
| `logger.ts` | 日志器 |

## 一处容易误解的地方

`PluginDefinition.configSchema` 在这里声明为 `unknown`。**这是为了守住零依赖**:类型推导需要
`core` 里的 `Schema<T>`,而引入它就打破了约束。故推导在 `definePlugin()` 里做 —— 这也是插件
必须从 `@yunzai-ng/core` 导入它而不能自己拼一个对象的原因。

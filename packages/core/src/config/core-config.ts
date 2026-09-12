/**
 * 模块职责：内核自身的配置 schema（`config/yunzai.yaml`）
 * 依赖方向：依赖 config/schema、config/store
 * 生命周期：应用启动时声明一次
 * 注意事项：这里只放**内核真正会读**的配置项。规矩是「谁消费、谁声明」—— 插件的配置
 *          由插件自己 `ctx.config` 声明、各自成文件，不往内核配置里塞业务开关。
 *
 *          每一项都写了 `title`/`desc`/`group`，WebUI 的表单和 YAML 注释都由此生成，
 *          不存在"改了校验忘了改表单"的可能。
 */
import type { DeepReadonly } from "@yunzai-ng/types"
import { s, type Infer } from "./schema.js"
import type { ConfigFile, ConfigStore } from "./store.js"

/** 内核配置名（对应 `config/yunzai.yaml`） */
export const CORE_CONFIG_NAME = "yunzai"

/**
 * 内核配置 schema
 *
 * 分组约定：`基础` / `日志` / `存储` / `面板` / `插件` / `消息` / `渲染` / `网络`，
 * WebUI 按此分栏。
 */
export const coreConfigSchema = s.object({
  bot: s
    .object({
      masterQQ: s
        .ids()
        .default([])
        .title("主人账号")
        .desc(
          "拥有全部权限的用户 id。留空则首次通过 WebUI 绑定。" +
            "填适配器给出的原始 id：QQ 号为纯数字，QQ 官方机器人为 32 位 openid，频道用户带 qg_ 前缀。"
        ),
      prefix: s
        .tags()
        .default(["#", "*", "%"])
        .title("命令前缀")
        .desc("只有以这些字符开头的消息才会进入命令路由。留空表示不限制前缀（不建议，会显著增加匹配开销）。"),
      nickname: s
        .tags()
        .default([])
        .title("机器人昵称")
        .desc("群里以昵称开头的消息等同于 @机器人。"),
      ignoreSelf: s
        .boolean()
        .default(true)
        .title("忽略自身消息")
        .desc("关闭后机器人会处理自己发出的消息，容易形成死循环，仅调试时开启。"),
      onlyMaster: s
        .boolean()
        .default(false)
        .title("维护模式")
        .desc("开启后只响应主人，用于线上排障时把其他人挡在外面。")
    })
    .title("基础")
    .group("基础")
    .order(10),

  log: s
    .object({
      level: s
        .enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"], {
          trace: "全部",
          debug: "调试",
          info: "常规",
          warn: "警告",
          error: "错误",
          fatal: "致命",
          silent: "关闭"
        })
        .default("info")
        .title("日志级别"),
      consoleLevel: s
        .enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"])
        .optional()
        .title("控制台级别")
        .desc("留空则跟随日志级别。常见用法：文件记 debug、控制台只看 info。"),
      fileLevel: s
        .enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"])
        .optional()
        .title("文件级别")
        .desc("留空则跟随日志级别。"),
      color: s.boolean().default(true).title("彩色输出").desc("重定向到文件或在不支持 ANSI 的终端里会自动关闭。"),
      keepDays: s.number().int().min(1).max(365).default(14).title("日志保留天数"),
      maxSize: s
        .number()
        .int()
        .min(1)
        .default(8)
        .title("单文件上限")
        .desc("单位 MB，超过后切分为 .1 / .2 …"),
      maxFiles: s.number().int().min(1).default(100).title("日志文件数上限")
    })
    .title("日志")
    .group("日志")
    .order(20),

  store: s
    .object({
      driver: s
        .select([
          { value: "auto", label: "自动", description: "优先内嵌 level，装不上时退回 JSON 文件" },
          { value: "level", label: "内嵌 LevelDB", description: "默认；性能好，需原生模块" },
          { value: "json", label: "JSON 文件", description: "纯 JS，Termux 上最稳" },
          { value: "memory", label: "仅内存", description: "重启即丢，仅测试用" }
        ])
        .default("auto")
        .title("键值存储驱动")
        .desc("缺省自带内嵌存储，无须另装任何服务；Redis 由 store-redis 插件提供，属可选。"),
      dir: s
        .dir()
        .optional()
        .title("数据目录")
        .desc("留空则使用应用数据目录下的 store/。"),
      sqlite: s
        .boolean()
        .default(true)
        .title("启用 SQLite")
        .desc("关系型数据（抽卡记录、面板缓存）用 better-sqlite3；原生模块不可用时自动降级为纯 KV。")
    })
    .title("存储")
    .group("存储")
    .order(30),

  server: s
    .object({
      enable: s.boolean().default(true).title("启用面板与 HTTP 服务"),
      host: s
        .string()
        .default("127.0.0.1")
        .title("监听地址")
        .desc("默认只监听本机。改为 0.0.0.0 对外暴露时必须设置访问令牌。"),
      port: s.port().default(2536).title("监听端口"),
      token: s
        .password()
        .optional()
        .title("访问令牌")
        .desc("非本机访问时必填。令牌走请求头而非 Cookie，天然免疫 CSRF。留空时首次启动会自动生成并打印在日志里。"),
      readonly: s
        .boolean()
        .default(false)
        .title("只读模式")
        .desc("开启后面板只能查看，不能改配置、不能重启插件。"),
      publicUrl: s
        .string()
        .optional()
        .title("外部访问地址")
        .desc("反向代理场景下用于拼接回调 URL，如 https://bot.example.com。")
    })
    .title("面板")
    .group("面板")
    .order(40),

  plugins: s
    .object({
      dirs: s
        .array(s.dir())
        .default([])
        .title("额外插件目录")
        .desc("除内置 plugins/ 之外要扫描的目录，支持相对应用根目录的路径。"),
      disabled: s
        .tags()
        .default([])
        .title("禁用的插件")
        .desc("按插件名精确匹配。禁用后完全不加载，不占内存。"),
      hotReload: s
        .boolean()
        .default(false)
        .title("热重载")
        .desc("开发用。改动插件文件后自动卸载重载；卸载会回收该插件登记的全部资源（定时任务、监听器、路由）。"),
      loadTimeout: s
        .duration()
        .default("30s")
        .title("单插件加载超时")
        .desc("超时的插件被跳过并记错误，不拖垮启动流程。")
    })
    .title("插件")
    .group("插件")
    .order(50),

  market: s
    .object({
      sources: s
        .array(s.string())
        .default(["https://raw.githubusercontent.com/yunzai-ng/plugin-index/main/index.json"])
        .title("索引地址")
        .desc(
          "插件市场的索引文件地址，可填多个。靠前的地址优先，同名插件以先出现者为准，" +
            "因此私有索引应置于官方索引之前。索引文件为 JSON，形如 { plugins: [...] }。"
        ),
      mirror: s
        .string()
        .default("")
        .title("镜像前缀")
        .desc(
          "仅对 github.com、raw.githubusercontent.com、codeload.github.com 三个主机生效，" +
            "拼接方式为 前缀 + 原始地址，例如 https://gh-proxy.org/。留空表示直接连接。"
        ),
      cacheTtl: s
        .duration()
        .default("1h")
        .title("索引缓存有效期")
        .desc("有效期内不再请求索引。缓存同时保存在磁盘，因此在无网络时仍可展示上次获取到的列表。"),
      timeout: s.duration().default("15s").title("索引请求超时").desc("单个索引地址的请求超时。插件下载与克隆另有更长的超时。")
    })
    .title("插件市场")
    .group("插件")
    .order(55),

  message: s
    .object({
      cooldown: s
        .duration()
        .default(0)
        .title("全局冷却")
        .desc("同一用户两条命令之间的最小间隔。0 表示不限制；命令自身声明的冷却优先。"),
      splitLength: s
        .number()
        .int()
        .min(100)
        .max(20000)
        .default(3000)
        .title("长文本切分长度")
        .desc("超长文本按此长度切分发送，切分点优先取换行与空白处。"),
      sendTimeout: s.duration().default("30s").title("发送超时"),
      sequential: s
        .boolean()
        .default(true)
        .title("同会话串行发送")
        .desc("保证同一群/私聊内消息按调用顺序到达。关闭可提高吞吐，但多条消息可能乱序。"),
      concurrency: s
        .number()
        .int()
        .min(1)
        .max(256)
        .optional()
        .title("命令处理并发上限")
        .desc(
          "同时执行的命令处理函数数量上限。留空表示不限制。" +
            "低内存设备（Termux）设成 2~4 可避免多张图同时渲染把内存吃满；" +
            "设得过小会让交互式命令（等用户回话的那类）互相排队。" +
            "本项改后需重启生效 —— 其余消息与渲染选项都是即时生效的。"
        )
    })
    .title("消息")
    .group("消息")
    .order(60),

  render: s
    .object({
      default: s
        .string()
        .default("puppeteer")
        .title("默认渲染器")
        .desc("渲染器由插件注册，这里填其注册名。"),
      timeout: s.duration().default("60s").title("单次渲染超时"),
      retry: s.number().int().min(0).max(5).default(1).title("渲染失败重试次数"),
      quality: s
        .number()
        .int()
        .min(50)
        .max(100)
        .default(90)
        .title("图片质量")
        .desc("对 jpeg/webp 生效。降低可显著减小图片体积。"),
      scale: s
        .number()
        .min(0.5)
        .max(3)
        .default(1)
        .title("缩放倍率")
        .desc("出图的像素密度：2 表示两倍图，更清晰但更占内存与耗时。低内存设备建议 1。")
    })
    .title("渲染")
    .group("渲染")
    .order(70),

  adapter: s
    .object({
      reconnectLimit: s
        .number()
        .int()
        .min(0)
        .max(1000)
        .default(0)
        .title("重连次数上限")
        .desc(
          "账号断线后最多连续重试多少次，超过即停在离线状态，等人工点「重连」。" +
            "0 为一直重试（此前的行为）。" +
            "连上一次就归零，故这个数说的是「连续失败多少次」而不是「一生总共重试多少次」。" +
            "设一个上限的意义在于：号被封、配置填错这类失败重试一万次也是同样的结果，" +
            "而无休止的重试会让日志里真正要看的东西被刷走。" +
            "这四项都可以在账号上单独覆盖，账号没填的项才用这里的值。"
        ),
      reconnectInterval: s
        .duration()
        .default("2s")
        .title("首次重连间隔")
        .desc("第一次失败之后等多久再试。此后每失败一次乘上「退避倍率」，直到「重连间隔上限」。"),
      reconnectMaxInterval: s
        .duration()
        .default("1m")
        .title("重连间隔上限")
        .desc(
          "退避增长到此为止，不再继续变长。设得太大会让一个短暂掉线的号迟迟不回来，" +
            "太小则对端长期不在线时反复敲门 —— 一分钟是两者之间的折中。"
        ),
      reconnectFactor: s
        .number()
        .min(1)
        .max(10)
        .default(2)
        .title("重连退避倍率")
        .desc(
          "每失败一次把等待时长乘上这个数。取 1 表示不退避、始终按「首次重连间隔」重试 —— " +
            "对端就在本机（NapCat 之类）时用得上，那种失败通常几秒内就恢复。"
        )
    })
    .title("适配器")
    .group("适配器")
    .order(75),

  net: s
    .object({
      proxy: s
        .string()
        .optional()
        .title("HTTP 代理")
        .desc("形如 http://127.0.0.1:7890。留空则读取环境变量 HTTPS_PROXY / HTTP_PROXY。"),
      timeout: s.duration().default("20s").title("请求超时"),
      retry: s.number().int().min(0).max(5).default(2).title("请求重试次数").desc("仅对幂等请求与网络层错误重试。"),
      userAgent: s
        .string()
        .optional()
        .title("User-Agent")
        .desc("留空使用框架默认 UA。米游社相关请求由插件自行覆盖，不受此项影响。")
    })
    .title("网络")
    .group("网络")
    .order(80)
})

/** 内核配置类型 */
export type CoreConfig = Infer<typeof coreConfigSchema>

/**
 * 内核配置的只读快照类型
 *
 * 即 `ConfigFile.get()` 的返回类型。下面几个读配置的辅助函数都收这个而不是
 * `CoreConfig`：`DeepReadonly` 会把 `string[]` 变成 `readonly string[]`，
 * 后者赋给前者是类型错误，于是"拿 get() 的结果直接调用"会编译不过 ——
 * 那是最自然的调用方式，不该被迫在调用点写断言。
 * 反过来，可变的 `CoreConfig` 传进来仍然合法。
 */
export type CoreConfigSnapshot = DeepReadonly<CoreConfig>

/** 内核配置句柄 */
export type CoreConfigHandle = ConfigFile<CoreConfig>

/**
 * 在配置仓库里声明内核配置
 * @param store 配置仓库
 * @returns 内核配置句柄
 */
export async function defineCoreConfig(store: ConfigStore): Promise<CoreConfigHandle> {
  return store.define(CORE_CONFIG_NAME, coreConfigSchema, {
    title: "内核",
    notes: [
      "插件的配置各自成文件，不要往这里加 —— 谁消费、谁声明。",
      "面板地址默认 http://127.0.0.1:2536"
    ]
  })
}

/**
 * 从内核配置中取出日志器所需的部分
 *
 * 日志器必须在配置加载**之前**先行就绪（否则加载配置时发生的错误无处记录），
 * 因此此处提供一个"配置就绪后再调整级别"的映射函数。
 * @param config 内核配置
 * @returns 日志相关设置
 */
export function loggerSettingsOf(config: CoreConfigSnapshot): {
  /** 总级别 */
  level: CoreConfig["log"]["level"]
  /** 控制台级别 */
  consoleLevel: CoreConfig["log"]["level"] | undefined
  /** 文件级别 */
  fileLevel: CoreConfig["log"]["level"] | undefined
  /** 单文件字节上限 */
  maxSize: number
  /** 保留天数 */
  keepDays: number
  /** 文件数上限 */
  maxFiles: number
  /** 是否彩色 */
  color: boolean
} {
  return {
    level: config.log.level,
    consoleLevel: config.log.consoleLevel,
    fileLevel: config.log.fileLevel,
    maxSize: config.log.maxSize * 1024 * 1024,
    keepDays: config.log.keepDays,
    maxFiles: config.log.maxFiles,
    color: config.log.color
  }
}

/**
 * 判断当前监听配置是否对外暴露却没有设令牌
 *
 * 安全底线：非本机监听必须设令牌。
 * @param config 内核配置
 * @returns 不安全时返回原因，安全时返回 undefined
 */
export function serverSecurityWarning(config: CoreConfigSnapshot): string | undefined {
  const host = config.server.host
  const isLocal = host === "127.0.0.1" || host === "localhost" || host === "::1"
  if (isLocal) return undefined
  if (!config.server.token) return `面板监听于 ${host} 但未设置访问令牌，任意来源均可修改本实例配置`
  if (config.server.token.length < 16) return "面板访问令牌太短，建议至少 16 位"
  return undefined
}

/**
 * 用配置里的日志器设置更新运行中的日志器
 *
 * 抽成函数是为了让 `kernel/app.ts` 与配置的 `onChange` 复用同一段逻辑。
 * @param logger 日志器（需支持 setLevel 的具体实现）
 * @param config 内核配置
 */
export function applyLogLevel(
  logger: { setLevel(level: CoreConfig["log"]["level"], target?: "console" | "file"): void },
  config: CoreConfigSnapshot
): void {
  logger.setLevel(config.log.level)
  if (config.log.consoleLevel) logger.setLevel(config.log.consoleLevel, "console")
  if (config.log.fileLevel) logger.setLevel(config.log.fileLevel, "file")
}

/** 供 CLI `yzng doctor` 使用的字段说明表（避免文档与实现脱节） */
export function describeCoreConfig(): ReturnType<typeof coreConfigSchema.describe> {
  return coreConfigSchema.describe()
}

/** 内核配置里所有敏感字段的路径，日志与面板导出时需脱敏 */
export const CORE_SECRET_PATHS: readonly string[] = coreConfigSchema.secretPaths()

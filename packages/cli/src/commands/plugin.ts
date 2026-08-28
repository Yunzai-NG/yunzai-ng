/**
 * 模块职责：`yzng plugin new <名称>` —— 生成可立即运行的插件骨架
 * 依赖方向：仅使用 node:fs / node:path 与内核的 `resolvePaths`
 * 生命周期：一次性，执行完毕即退出
 * 注意事项：**生成的是 JavaScript，而非 TypeScript。** 骨架的目的在于使开发者在极短时间内
 *          观察到 `#ping` 得到回复；TS 插件额外需要一份 tsconfig、一次编译，以及
 *          "修改源码后未生效"一类的排查，而这些均发生于其确认框架可用之前。
 *          文件末尾以注释给出了改用 TS 的方式（编译至 dist/index.js）。
 *
 *          绝不覆盖已存在的目录 —— 误操作重复执行 `plugin new` 不应清除已编写的代码。
 */
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { resolvePaths } from "@yunzai-ng/core"
import { bold, cyan, dim, green, print, printErr, red } from "../terminal.js"

/** 插件名合法字符，与内核 `definePlugin` 的校验保持一致 */
const NAME_RE = /^[a-zA-Z][\w.-]*$/

/** 脚手架参数 */
export interface PluginNewOptions {
  /** 插件名 */
  readonly name: string
  /** 应用主目录 */
  readonly home?: string | undefined
}

/**
 * 生成骨架源码
 * @param name 插件名
 * @returns index.js 内容
 */
function scaffold(name: string): string {
  return `import { definePlugin, s } from "@yunzai-ng/core"

/**
 * ${name}
 *
 * 本文件为 \`yzng plugin new\` 生成的骨架。整个插件即一个 setup 函数：
 * 内核将各项能力经由 ctx 注入，插件无需（亦无法取得）任何全局变量。
 */
export default definePlugin({
  name: "${name}",
  version: "0.1.0",
  description: "Yunzai NG 插件骨架",

  // 声明配置 schema 即自动获得 config/${name}.yaml 以及面板中的一张表单，
  // 无需自行编写文件读写代码，亦无需为面板编写任何前端代码
  configSchema: s.object({
    greeting: s.string().default("pong").title("回复内容")
  }),

  setup(ctx) {
    ctx
      .command("#ping")
      .desc("检测插件是否正常运行")
      .action(async e => {
        await e.reply(ctx.config.get().greeting)
      })

    // 定时任务：注册即受内核托管，插件卸载时内核自动停止它
    // ctx.cron("0 0 8 * * *", () => ctx.logger.info("每日任务已执行"))

    // 需要保存状态时使用 ctx.kv，其已绑定以插件名隔离的命名空间
    // await ctx.kv.set("上次运行时间", Date.now())
  }
})

// 改用 TypeScript：将源码置于 src/，编译至 dist/index.js，
// 并在 package.json 中声明 "main": "dist/index.js" —— 内核优先采用该入口
`
}

/**
 * 生成 package.json
 * @param name 插件名
 * @returns 文件内容
 */
function manifest(name: string): string {
  return `${JSON.stringify(
    {
      name,
      version: "0.1.0",
      description: `Yunzai NG 插件：${name}`,
      type: "module",
      main: "index.js"
    },
    null,
    2
  )}\n`
}

/**
 * 生成插件骨架
 * @param opts 参数
 * @returns 进程退出码
 */
export async function runPluginNew(opts: PluginNewOptions): Promise<number> {
  if (!NAME_RE.test(opts.name)) {
    printErr(red(`插件名 ${opts.name} 不合法：需以字母开头，仅含字母、数字与 . - _`))
    printErr(dim("该名称同时作为配置文件名与存储命名空间，因此约束严于目录名"))
    return 1
  }

  const paths = resolvePaths({ home: opts.home })
  const dir = join(paths.plugins, opts.name)

  try {
    // recursive: false —— 目录已存在时抛出 EEXIST，此即所需的保护行为
    await mkdir(paths.plugins, { recursive: true })
    await mkdir(dir)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "EEXIST") {
      printErr(red(`${dir} 已存在`))
      printErr(dim("请改用其他名称，或先移走原有目录 —— 本命令不覆盖任何已有文件"))
      return 1
    }
    printErr(red(`创建目录失败：${err instanceof Error ? err.message : String(err)}`))
    return 1
  }

  await writeFile(join(dir, "index.js"), scaffold(opts.name), "utf8")
  await writeFile(join(dir, "package.json"), manifest(opts.name), "utf8")

  print()
  print(`  ${bold(green("已生成"))} ${cyan(dir)}`)
  print()
  print(`  ${dim("下一步")} ${cyan("yzng dev")} ${dim("随后向机器人发送")} ${cyan("#ping")}`)
  print(`  ${dim("修改代码后在面板的插件页执行重载，无需重启整个进程")}`)
  print()
  return 0
}

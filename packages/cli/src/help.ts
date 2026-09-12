/**
 * 模块职责：`yzng --help` 的文案
 * 依赖方向：仅依赖终端输出
 * 生命周期：纯函数
 * 注意事项：帮助文案手写而非由命令表自动生成。自动生成的帮助仅能罗列选项，
 *          而初次使用者真正需要的是"当前应执行哪一条命令"—— 那属于顺序信息，
 *          选项表格无法表达。
 */
import { bold, cyan, dim, print } from "./terminal.js"

/**
 * 输出帮助文本
 * @param version CLI 版本
 */
export function printHelp(version: string): void {
  print()
  print(`  ${bold("Yunzai NG")} ${dim(version)}  ${dim("面向 QQ 机器人的可插拔运行时")}`)
  print()
  print(`  ${bold("用法")}  ${cyan("yzng")} <命令> [选项]`)
  print()
  print(`  ${bold("命令")}`)
  print(`    ${cyan("init")}              生成主目录与缺省配置，不启动运行时`)
  print(`    ${cyan("start")}             启动机器人与面板服务`)
  print(`    ${cyan("dev")}               同 start，但日志级别为 debug`)
  print(`    ${cyan("doctor")}            环境自检：运行环境、目录、原生依赖、端口占用`)
  print(`    ${cyan("update")}            把内核、CLI、JSX 与类型包整套升到同一版本`)
  print(`    ${cyan("plugin new <名称>")}  在插件目录中生成可直接运行的插件骨架`)
  print()
  print(`  ${bold("选项")}`)
  print(`    ${cyan("-c, --home <目录>")}  指定主目录（亦可通过环境变量 YZNG_HOME 指定）`)
  print(`    ${cyan("-d, --debug")}       将启动期日志级别设为 debug`)
  print(`    ${cyan("    --no-console")}  仅写入日志文件，不输出至终端（以服务方式运行时使用）`)
  print(`    ${cyan("    --plugins <目录>")} 追加一个插件目录，多个目录以逗号分隔`)
  print(`    ${cyan("    --port <端口>")}  仅 doctor：指定探测的端口`)
  print(`    ${cyan("    --to <版本>")}   仅 update：目标版本或 dist-tag，缺省 latest`)
  print(`    ${cyan("    --no-prune")}   仅 update：保留 package.json 中单列的框架依赖`)
  print(`    ${cyan("-v, --version")}     输出版本号`)
  print(`    ${cyan("-h, --help")}        输出本帮助`)
  print()
  print(`  ${bold("首次使用")}`)
  print(`    ${dim("1.")} ${cyan("yzng init")}    ${dim("确认各类文件的存放位置")}`)
  print(`    ${dim("2.")} ${cyan("yzng start")}   ${dim("终端将输出面板地址与访问令牌")}`)
  print(`    ${dim("3.")} ${dim("在面板中安装适配器插件并添加账号 —— 账号登录同为插件，不在内核之内")}`)
  print()
}

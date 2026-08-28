/**
 * 模块职责：提示「旧默认位置上还留着一个实例」
 * 依赖方向：依赖内核的 `legacyInstance` 与本包的终端输出
 * 生命周期：每条命令执行时调用一次
 * 注意事项：0.2.0 起主目录默认为当前目录，此前是系统目录（Windows 的
 *          `%LOCALAPPDATA%\YunzaiNG` 等）。升级后使用者在新位置看到的是一个空实例，
 *          而配置、账号、历史记录仍在旧处 —— 若不提示，这一幕与「数据被清空」
 *          无从分辨，而后者是会让人立刻停用一个框架的体验。
 *
 *          **只提示，不自动迁移。** 两个目录都有内容时无从判断该以谁为准，
 *          猜错的代价是覆盖掉正在用的那份。搬家是使用者看得见的一步。
 */
import { legacyInstance } from "@yunzai-ng/core"
import { cyan, dim, print, yellow } from "./terminal.js"

/**
 * 若旧默认位置上还有实例，打印一段提示
 * @param home 本次实际使用的主目录
 * @returns 是否打印了提示
 */
export function noteLegacyInstance(home: string): boolean {
  const legacy = legacyInstance(home)
  if (legacy === undefined) return false

  print()
  print(`  ${yellow("!")} 旧版本的主目录里还有一个实例 ${cyan(legacy)}`)
  print(`      ${dim("本次用的是")} ${cyan(home)}`)
  print(`      ${dim(`要继续用旧的，设 YZNG_HOME 指向它；要搬过来，把其中内容拷到上面这个目录`)}`)
  return true
}

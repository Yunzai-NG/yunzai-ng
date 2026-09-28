/**
 * 模块职责：停机退出码的单一来源 —— 守护（父进程）与内核宿主（子进程）两头都认同一套
 * 依赖方向：无依赖
 * 生命周期：常量
 * 注意事项：这两个码是父子进程之间唯一的约定。父进程只按退出码决定「拉起还是收工」，
 *          不读子进程的任何内部状态，故它们必须两头共用一处，抄一遍迟早只改一边。
 */

/**
 * 因重启请求而退出时的退出码
 *
 * **刻意非零。** 自带守护、pm2、`Restart=always` 的 systemd 都会拉起，但
 * `Restart=on-failure`（systemd 单元里常见的写法）只在非零时拉起 —— 用 0 退出会让那批
 * 实例「重启即变关机」。取 75：sysexits.h 的 `EX_TEMPFAIL`（暂时性失败，可重试），语义
 * 最接近「我这就下去，请把我拉起来」，且与 Node 自身的退出码不冲突（Node 用 1~12 与 128+n）。
 */
export const RESTART_EXIT_CODE = 75

/**
 * 因关机请求而退出时的退出码
 *
 * **刻意取 0。** 关机的意思是「别再拉起来」，守护判断这件事只看退出码：自带守护认得 0；
 * pm2 需在配置里写 `stop_exit_codes: [0]`；`Restart=on-failure` 的 systemd 天然不拉零退出，
 * `Restart=always` 要另写 `RestartPreventExitStatus=0`。
 */
export const SHUTDOWN_EXIT_CODE = 0

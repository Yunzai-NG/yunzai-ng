// POSIX 记录锁按进程持有：即使旧库就在调用进程里，也必须由独立进程取锁。
import { copyFile, link, lstat, mkdir, readdir } from "node:fs/promises"
import { join } from "node:path"
import { ClassicLevel } from "classic-level"

const [source, work, mode = "copy"] = process.argv.slice(2)
const guard = join(work, "guard")
const copy = join(work, "copy")
const released = new Promise(resolve => process.stdin.resume().once("end", resolve))
try {
  await mkdir(guard)
  const lock = join(source, "LOCK")
  if (!(await lstat(lock)).isFile()) throw new Error("LOCK 不是普通文件")
  // 只共享锁文件；LevelDB 的日志轮换和恢复均发生在临时目录。
  await link(lock, join(guard, "LOCK"))
  const db = new ClassicLevel(guard)
  await db.open()
  try {
    if (mode === "copy") {
      await mkdir(copy)
      for (const entry of await readdir(source, { withFileTypes: true })) {
        if (!/^(?:CURRENT|MANIFEST-\d+|\d+\.(?:log|sst|ldb))$/.test(entry.name)) continue
        if (!entry.isFile()) throw new Error(`${entry.name} 不是普通文件`)
        await copyFile(join(source, entry.name), join(copy, entry.name))
      }
    }
    process.stdout.write("1")
    await released
  } finally {
    await db.close()
  }
} catch (err) {
  process.stderr.write(String(err.message))
  process.exitCode = [err.code, err.cause?.code].includes("LEVEL_LOCKED") || err.code === "EBUSY" ? 2 : 1
  process.stdin.destroy()
}

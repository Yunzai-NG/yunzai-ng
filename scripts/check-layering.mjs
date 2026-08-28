#!/usr/bin/env node
/**
 * 分层门禁 —— 本次重写的核心不变量检查
 *
 * Miao-Yunzai 的"底层"之所以不是底层，是因为 lib/plugins/runtime.js 直接
 * `import ../../plugins/genshin/model/...`，lib/plugins/plugin.js 与
 * lib/renderer/loader.js 又 `import "#miao"`：缺插件内核起不来。
 *
 * 这个脚本把"内核不依赖插件"从口头约定变成 CI 会红的断言。
 * 零依赖，node scripts/check-layering.mjs 直接跑。
 */
import fs from "node:fs"
import path from "node:path"
import process from "node:process"

const ROOT = path.resolve(import.meta.dirname, "..")

/** 从源码里抠出所有模块说明符（import / export from / 动态 import / require） */
const SPECIFIER_RE =
  /(?:^|[\s;])(?:import|export)\s+(?:[\s\S]*?\sfrom\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g

/**
 * 分层规则表
 *
 * scope: 相对仓库根的目录
 * allowPackages: 允许出现的 @yunzai-ng/* 包（其余一律拒绝）
 * denyPathPatterns: 解析后的相对路径若命中则拒绝
 */
const RULES = [
  {
    scope: "packages/types",
    desc: "类型包必须是叶子：不许依赖任何工作区包",
    allowPackages: [],
    denyPathPatterns: [/^packages\/(?!types\/)/, /^plugins\//, /^apps\//]
  },
  {
    scope: "packages/jsx",
    desc: "JSX 运行时只许依赖类型包：模板层不该能碰到内核",
    allowPackages: ["@yunzai-ng/types", "@yunzai-ng/jsx"],
    denyPathPatterns: [/^packages\/(?!jsx\/|types\/)/, /^plugins\//, /^apps\//]
  },
  {
    scope: "packages/core",
    desc: "内核只许依赖 @yunzai-ng/types，绝不许碰任何插件",
    allowPackages: ["@yunzai-ng/types"],
    denyPathPatterns: [/^plugins\//, /^apps\//, /^packages\/(?!core\/|types\/)/]
  },
  {
    scope: "packages/cli",
    desc: "CLI 只许依赖内核与类型包",
    allowPackages: ["@yunzai-ng/types", "@yunzai-ng/core"],
    denyPathPatterns: [/^plugins\//, /^packages\/(?!cli\/|core\/|types\/)/]
  },
  {
    scope: "apps",
    desc: "apps（安装器、站点等）只许依赖内核与类型包，且不得反向被内核依赖",
    allowPackages: ["@yunzai-ng/types", "@yunzai-ng/core", "@yunzai-ng/cli"],
    denyPathPatterns: [/^packages\//]
  }
]

/*
 * 关于 `plugins` scope 的去向
 *
 * 三个官方插件已拆为独立仓库（Yunzai-NG/adapter-napcat 等），本仓库内不再有
 * plugins/ 目录，故此处不再有对应规则。「插件只许走公开入口、不许深引 core 内部
 * 实现」这条约束移交各插件仓库的 eslint no-restricted-imports 等价实现。
 *
 * 但上方各 scope 的 denyPathPatterns 仍保留 `/^plugins\//`：那拦的是**内核反向
 * 引用插件**（`import "../../plugins/genshin/..."`），即本次重写要消灭的方向。
 * 该目录如今不存在，写出这样一条 import 只会得到"模块找不到"，但门禁应当在
 * 有人重新创建该目录的第一时间就报错，而不是等到运行时。
 */

/** 递归收集 .ts / .mts / .js（跳过 dist 与 node_modules） */
function collect(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "resources") {
        continue
      }
      collect(full, out)
    } else if (/\.(m?ts|m?js|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(full)
    }
  }
  return out
}

/**
 * 从 `start` 处读一个字符串字面量，返回闭合引号之后的下标
 *
 * 单/双引号字面量不允许跨行：读到换行还没闭合，说明这个引号根本不是字符串开头
 * （最常见的来源是正则里的撇号，如 `/don't/`），返回 -1 让调用方按普通字符处理。
 */
function readString(src, start, quote) {
  for (let i = start + 1; i < src.length; i++) {
    const ch = src[i]
    if (ch === "\\") {
      i++
      continue
    }
    if (ch === quote) return i + 1
    if (ch === "\n" && quote !== "`") return -1
  }
  return -1
}

/**
 * 去掉注释，保留字符串字面量
 *
 * 必须先去注释再找 import：本仓库的中文注释里会出现
 * `require("../../lib/...")` 这类**被批判的旧写法示例**，直接正则扫全文会把
 * 注释里的反面教材当成真实依赖报出来 —— 门禁误报一次，下次就没人信它了。
 */
function stripComments(src) {
  let out = ""
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    const next = src[i + 1]

    if (ch === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++
      continue
    }
    if (ch === "/" && next === "*") {
      i += 2
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++
      i += 2
      continue
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const end = readString(src, i, ch)
      if (end > 0) {
        out += src.slice(i, end)
        i = end
        continue
      }
    }
    out += ch
    i++
  }
  return out
}

/** 逐个说明符判定，返回违规描述数组 */
function inspect(file, rule) {
  const src = stripComments(fs.readFileSync(file, "utf8"))
  const violations = []
  SPECIFIER_RE.lastIndex = 0
  let m
  while ((m = SPECIFIER_RE.exec(src)) !== null) {
    const spec = m[1] ?? m[2] ?? m[3]
    if (!spec) continue

    if (spec.startsWith(".")) {
      // 相对路径：解析后看是否越出本层
      const resolved = path
        .relative(ROOT, path.resolve(path.dirname(file), spec))
        .split(path.sep)
        .join("/")
      for (const deny of rule.denyPathPatterns ?? []) {
        if (deny.test(resolved)) {
          violations.push({ file, spec, reason: `相对引用越层 → ${resolved}` })
          break
        }
      }
      continue
    }

    if (spec.startsWith("@yunzai-ng/")) {
      const base = spec.split("/").slice(0, 2).join("/")
      for (const deny of rule.denyPackagePatterns ?? []) {
        if (deny.test(spec)) {
          violations.push({ file, spec, reason: "深引内核内部实现，请只用公开入口" })
        }
      }
      if (!(rule.allowPackages ?? []).includes(base)) {
        violations.push({ file, spec, reason: `不在允许清单 [${(rule.allowPackages ?? []).join(", ") || "空"}] 内` })
      }
      continue
    }

    // 旧框架的路径别名，绝不该出现在新代码里
    if (spec === "#miao" || spec === "#miao.models" || spec === "#yunzai") {
      violations.push({ file, spec, reason: "旧框架别名，禁止出现" })
    }
  }
  return violations
}

let total = 0
let failed = 0
const report = []

for (const rule of RULES) {
  const scopeDir = path.join(ROOT, rule.scope)
  const files = collect(scopeDir)
  total += files.length
  for (const file of files) {
    const v = inspect(file, rule)
    if (v.length) {
      failed += v.length
      report.push({ rule, violations: v })
    }
  }
}

if (report.length === 0) {
  console.error(`[分层门禁] 通过：扫描 ${total} 个文件，无越层依赖`)
  process.exit(0)
}

console.error(`[分层门禁] 失败：${failed} 处越层依赖\n`)
for (const { rule, violations } of report) {
  console.error(`  ✗ ${rule.scope} —— ${rule.desc}`)
  for (const v of violations) {
    const rel = path.relative(ROOT, v.file).split(path.sep).join("/")
    console.error(`      ${rel}\n        "${v.spec}"  ${v.reason}`)
  }
  console.error("")
}
process.exit(1)

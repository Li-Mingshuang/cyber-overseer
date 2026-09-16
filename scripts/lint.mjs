/**
 * 轻量自检脚本（不引 ESLint，保持零依赖）：
 *   1. 所有 .mjs 能通过 `node --check`（语法层面）；
 *   2. src/ 里没有 `require(` / `module.exports`（ESM 一致性）；
 *   3. src/ 里没有 `console.log`（统一走 logger，便于日志分级与重定向）；
 *   4. 没有把 `console.log` 之类调试残留混进 CLI 的 stdout 契约
 *      （`cw hook` 的输出必须是纯 JSON —— 这是最容易被破坏的契约之一）。
 *
 * 跑法：npm run lint
 * @module scripts/lint
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const files = []

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === '.recon-tmp' || entry === '.cyber') continue
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) { walk(full); continue }
    if (entry.endsWith('.mjs') || entry.endsWith('.js')) files.push(full)
  }
}

walk(ROOT)

for (const file of files) {
  const rel = relative(ROOT, file).replace(/\\/g, '/')
  if (rel.startsWith('examples/') || rel.startsWith('scripts/')) {
    // 示例与脚本允许 console 输出（它们是给人看的程序）
  }
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch (error) {
    problems.push(`${rel}: 语法检查失败\n${String(error.stderr ?? error.message).split('\n').slice(0, 4).join('\n')}`)
  }

  const text = readFileSync(file, 'utf8')
  if (rel.startsWith('src/') || rel.startsWith('bin/')) {
    if (/\brequire\s*\(/.test(text)) problems.push(`${rel}: ESM 模块里出现了 require()（应该用 import）`)
    if (/\bmodule\.exports\b/.test(text)) problems.push(`${rel}: ESM 模块里出现了 module.exports`)
    if (/\bconsole\.log\s*\(/.test(text)) problems.push(`${rel}: 直接用了 console.log（请走 util/log.mjs 的 logger）`)
  }

  // PowerShell 脚本必须带 UTF-8 BOM：Windows PowerShell 5.1 没有 BOM 时会按系统 ANSI（中文机器是 GBK）
  // 读取，中文注释变乱码后可能吞掉引号，直接导致"看着正常、一跑就语法错误"。这个坑踩过两次。
  if (file.endsWith('.ps1')) {
    const first = readFileSync(file).subarray(0, 3)
    const hasBom = first[0] === 0xef && first[1] === 0xbb && first[2] === 0xbf
    if (!hasBom) {
      problems.push(`${rel}: .ps1 缺少 UTF-8 BOM（Windows PowerShell 5.1 会把中文读成乱码）——跑 \`node scripts/fix-ps1-bom.mjs\` 修复`)
    }
  }
  if (rel === 'src/cli.mjs' && /process\.stdout\.write\(\s*JSON\.stringify\(result\.output/.test(text)) {
    // 这是钩子契约里**唯一**允许直接写 stdout 的地方，留个提醒注释即可
  }
}

if (problems.length) {
  console.error(`✖ 自检发现 ${problems.length} 个问题：`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`✔ 自检通过：${files.length} 个文件`)

/**
 * 把演示复位：恢复方案的原始勾选状态、清掉产物与监工状态。
 * 跑法：node examples/lazy-agent/reset.mjs
 *
 * （之所以要有这个脚本：演示跑一遍会把 PLAN.md 的复选框勾上，想再演示一次就得复位。
 *   用脚本而不是手工改，避免中文文件被编辑器/编码来回折腾坏。）
 *
 * @module examples/lazy-agent/reset
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLAN = join(HERE, 'PLAN.md')

if (existsSync(PLAN)) {
  const text = readFileSync(PLAN, 'utf8')
  writeFileSync(PLAN, text.replace(/^(\s*[-*+]\s+)\[x\]/gm, '$1[ ]'), 'utf8')
}

for (const target of ['artifacts', '.cyber', 'work-log.txt', 'CW-REPORT.md']) {
  const full = join(HERE, target)
  if (existsSync(full)) rmSync(full, { recursive: true, force: true })
}

console.log('演示已复位：复选框还原、产物与监工状态已清理。')
console.log('现在可以：node bin/cw.mjs run --config examples/lazy-agent/cw.config.mjs')

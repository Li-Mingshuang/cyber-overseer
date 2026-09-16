/**
 * 演示用的验收命令：四个产物文件都必须存在且内容合规，退出码 0 才算"目标达成"。
 * 这是监工判定"该不该收工"的**硬证据**——它不关心劳工怎么自述。
 * @module examples/lazy-agent/verify
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const problems = []

for (let step = 1; step <= 4; step++) {
  const file = join(HERE, 'artifacts', `step${step}.txt`)
  if (!existsSync(file)) { problems.push(`缺少产物：artifacts/step${step}.txt`); continue }
  const text = readFileSync(file, 'utf8')
  if (!text.includes(`第 ${step} 份产物`)) problems.push(`产物内容不对：artifacts/step${step}.txt`)
}

const plan = readFileSync(join(HERE, 'PLAN.md'), 'utf8')
const unchecked = (plan.match(/^\s*[-*+]\s+\[ \]/gm) ?? []).length
if (unchecked > 0) problems.push(`方案里还有 ${unchecked} 项未勾选`)

if (problems.length) {
  console.error('验收不通过：')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log('验收通过：4 份产物齐备，方案复选框全部勾选。')

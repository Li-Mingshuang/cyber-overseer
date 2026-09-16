/**
 * 演示用的"懒惰劳工"。
 *
 * 每次被调用只做一件事：勾掉方案文档里的**一个**复选框，并写出对应的产物文件。
 * 它不会自己检查验收命令，也不会自己继续——所以如果没有监工抽鞭，它永远停在第一步。
 *
 * 用法：node agent.mjs "<监工抽过来的鞭子>"
 * @module examples/lazy-agent/agent
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLAN = join(HERE, 'PLAN.md')
const ARTIFACTS = join(HERE, 'artifacts')
const LOG = join(HERE, 'work-log.txt')

const whip = process.argv.slice(2).join(' ').trim()

/** 读方案，找出第一个未勾选项。 */
function firstOpenItem() {
  const text = readFileSync(PLAN, 'utf8')
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*[-*+]\s+\[)( |x|X)(\]\s+)(.*)$/.exec(lines[i])
    if (m && m[2] === ' ') return { index: i, match: m, lines, text }
  }
  return null
}

function main() {
  if (whip.includes('CW-RECEIPT') || whip.length === 0) {
    // 收到的确实是监工的鞭子（回执要求写在鞭子末尾）
  }
  const open = firstOpenItem()
  if (!open) {
    console.log([
      '方案里的复选框已经全部勾完了。',
      'CW-RECEIPT: 本轮无新增改动 | 下一步 等待验收 | 阻塞 无',
    ].join('\n'))
    return
  }

  const itemText = open.match[4]
  const step = String(open.match[4].match(/step(\d)/)?.[1] ?? '1')
  if (!existsSync(ARTIFACTS)) mkdirSync(ARTIFACTS, { recursive: true })
  const file = join(ARTIFACTS, `step${step}.txt`)
  writeFileSync(file, [
    `这是第 ${step} 份产物。`,
    `由"懒惰劳工"在被抽鞭后写下：${new Date().toISOString()}`,
    `监工的要求（节选）：${whip.split('\n').filter(Boolean).slice(0, 2).join(' / ').slice(0, 200)}`,
    '',
  ].join('\n'), 'utf8')

  // 勾掉这一个复选框，只勾一个
  open.lines[open.index] = open.lines[open.index].replace('[ ]', '[x]')
  writeFileSync(PLAN, open.lines.join('\n'), 'utf8')

  writeFileSync(LOG, `${new Date().toISOString()} 完成：${itemText}\n`, { flag: 'a' })

  const remaining = (readFileSync(PLAN, 'utf8').match(/^\s*[-*+]\s+\[ \]/gm) ?? []).length
  console.log([
    `我做了「${itemText}」，产物写在 artifacts/step${step}.txt。`,
    remaining ? `方案里还剩 ${remaining} 项没做，我这就停下来了（等下一次指令）。` : '方案里的复选框已经全部勾完了。',
    '',
    `CW-RECEIPT: 本轮勾选了 1 项（${itemText}） | 下一步 ${remaining ? '继续做剩余项' : '跑验收命令'} | 阻塞 无`,
  ].join('\n'))
}

main()

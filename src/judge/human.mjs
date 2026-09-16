/**
 * 人工判定器：把"收不收工"这个决定交还给人。
 *
 * 两种模式：
 *  - `interactive`：终端问答（人就在旁边时用；也有超时兜底，避免挂死）；
 *  - `file`：在 `.cyber/HUMAN-DECISION.md` 写出待决策的问题，轮询等待主人回来填写。
 *    这是"主人睡醒后一句话收工"的形态——非常适合长时间无人值守后补决策。
 *
 * 注入 `ask`/`now` 依赖是为了可测试（测试里不需要真的有人在敲键盘）。
 *
 * @module cyber-overseer/judge/human
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { clip, oneLine } from '../util/text.mjs'
import { isoLocal, sleep } from '../util/time.mjs'
import { normalizeVerdict } from './types.mjs'

export const id = 'human'

const DECISION_RE = /^\s*(?:decision|决定|判定)\s*[:：]\s*(done|continue|blocked|needs-human|收工|继续|受阻)\s*$/im
const PROMPT_RE = /^\s*(?:prompt|指令|鞭子)\s*[:：]\s*([\s\S]*?)(?:\n\s*\n|$)/im

const STATUS_MAP = { 收工: 'done', 继续: 'continue', 受阻: 'blocked' }

/**
 * @param {import('../config.mjs').defaultConfig} config
 * @param {{ask?:Function, log?:any, now?:()=>number, sleepFn?:typeof sleep}} [deps]
 * @returns {import('./types.mjs').Judge}
 */
export function createHumanJudge(config, deps = {}) {
  const opts = config.judge?.human ?? {}
  return {
    id,
    available: true,
    async judge(input) {
      return opts.mode === 'file'
        ? judgeByFile(input, opts, deps, config)
        : judgeInteractive(input, opts, deps)
    },
  }
}

/** 终端问答。超时（默认 5 分钟）则返回 needs-human，绝不替主人做决定。 */
async function judgeInteractive(input, opts, deps) {
  const ask = deps.ask ?? defaultAsk
  const timeoutMs = opts.askTimeoutMs ?? 300000
  const question = [
    '',
    '──────────────── 赛博监工：需要主人裁决 ────────────────',
    `方案进度：${input.progress?.done ?? 0}/${input.progress?.total ?? 0} 已勾选`,
    `规则判定：${oneLine(input.ruleReason ?? input.reason ?? '无法判定', 200)}`,
    '',
    '劳工最后一次回答（尾部）：',
    clip(input.answer ?? '', 1200),
    '',
    '请输入决定：done=收工 / continue=继续抽鞭 / blocked=卡住了 / 直接输入要抽的鞭子内容',
    '─────────────────────────────────────────────',
  ].join('\n')

  const answer = await withTimeout(ask(question), timeoutMs).catch(error => ({ error }))
  if (!answer || answer.error || answer.value === undefined) {
    return normalizeVerdict({
      status: 'needs-human',
      reason: `等待人工裁决超时或失败（${answer?.error?.message ?? '无输入'}）`,
      confidence: 0.5,
      judge: id,
    }, { judge: id })
  }
  return parseHumanAnswer(String(answer.value))
}

/** 文件裁决：写问题文件，轮询等待填写。 */
async function judgeByFile(input, opts, deps, config) {
  const dir = resolve(config.__cwd ?? process.cwd(), config.journal?.dir ?? '.cyber')
  const file = resolve(dir, 'HUMAN-DECISION.md')
  const sleepFn = deps.sleepFn ?? sleep
  const pollMs = opts.pollMs ?? 15000
  const timeoutMs = opts.timeoutMs ?? 24 * 60 * 60 * 1000
  const started = (deps.now ?? Date.now)()

  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  if (!existsSync(file)) {
    writeFileSync(file, renderDecisionFile(input), 'utf8')
    deps.log?.step?.(`已写出待裁决文件：${file}（填写 decision: 后监工会继续）`)
  }

  for (;;) {
    if (existsSync(file)) {
      const text = readFileSync(file, 'utf8')
      const decision = DECISION_RE.exec(text)
      if (decision && !/^\s*(?:decision|决定|判定)\s*[:：]\s*(?:待填|TODO|\?+)/im.test(text)) {
        const verdict = parseHumanAnswer(decision[1] + (PROMPT_RE.test(text) ? `\n${text}` : ''))
        deps.log?.ok?.(`读到人工裁决：${verdict.status}`)
        return verdict
      }
    }
    if ((deps.now ?? Date.now)() - started > timeoutMs) {
      return normalizeVerdict({
        status: 'needs-human',
        reason: `等待主人填写 ${file} 超时`,
        confidence: 0.5,
        judge: id,
      }, { judge: id })
    }
    await sleepFn(pollMs).catch(() => {})
  }
}

/** 把人的一句话解析成判决。 */
export function parseHumanAnswer(text) {
  const raw = String(text ?? '').trim()
  const lower = raw.toLowerCase()
  const explicit = DECISION_RE.exec(raw)?.[1]
  const normalized = explicit && STATUS_MAP[explicit] ? STATUS_MAP[explicit] : explicit?.toLowerCase()
  const promptMatch = PROMPT_RE.exec(raw)?.[1]?.trim() ?? null

  if (normalized === 'done' || lower === 'done' || lower === '收工' || lower === 'y') {
    return normalizeVerdict({ status: 'done', reason: '主人裁定：可以收工', confidence: 1, judge: id }, { judge: id })
  }
  if (normalized === 'blocked' || lower === 'blocked' || lower === '卡住') {
    return normalizeVerdict({ status: 'blocked', reason: `主人裁定：卡住了${promptMatch ? `（${oneLine(promptMatch, 120)}）` : ''}`, confidence: 1, judge: id }, { judge: id })
  }
  if (normalized === 'needs-human') {
    return normalizeVerdict({ status: 'needs-human', reason: '主人要求人工介入', confidence: 1, judge: id }, { judge: id })
  }
  // 既不是关键词也不是空：把原话当成要抽的鞭子
  const asPrompt = promptMatch ?? raw
  if (asPrompt) {
    return normalizeVerdict({
      status: 'continue',
      reason: '主人给了具体的下一条指令',
      nextPrompt: asPrompt,
      confidence: 1,
      judge: id,
    }, { judge: id })
  }
  return normalizeVerdict({ status: 'continue', reason: '主人裁定：继续', confidence: 1, judge: id }, { judge: id })
}

function renderDecisionFile(input) {
  return `# 赛博监工：待主人裁决

> 生成时间：${isoLocal()}
> 监工已经跑完自己的判断手段，需要你一句话决定下一步。
> **填写下面 \`decision:\` 那一行后保存即可**，监工会在轮询中读到（默认每 15 秒看一次）。
> 可选值：\`done\`（收工）、\`continue\`（继续抽鞭）、\`blocked\`（卡住了，停止）

## 机器统计
- 方案进度：${input.progress?.done ?? 0}/${input.progress?.total ?? 0} 已勾选
- 第 ${input.round ?? '?'} 轮
- 规则判定：${oneLine(input.ruleReason ?? '（无）', 300)}

## 未完成项
${input.progress?.remaining?.length ? input.progress.remaining.map(r => `- ${r}`).join('\n') : '- （无）'}

## 劳工最后一次回答（尾部 1500 字）
\`\`\`text
${clip(input.answer ?? '', 1500)}
\`\`\`

---

decision: 待填

# 如果选择 continue，可以顺手写下要抽的鞭子（可选；留空则用监工自动生成的那条）
prompt:
`;
}

async function defaultAsk(question) {
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(`${question}\n> `)
    return { value: answer }
  } finally {
    rl.close()
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise.then(value => ({ value })),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`等待 ${Math.round(ms / 1000)}s 无响应`)), ms)),
  ])
}

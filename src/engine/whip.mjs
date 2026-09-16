/**
 * 鞭子（whip）：把"下一步该干什么"组装成一段注入给 agent 的话。
 *
 * 这是监工唯一真正"作用于世界"的东西，所以设计上很克制：
 *  - 短：拟人通道要靠剪贴板粘贴再回车，太长容易被输入框截断；默认 <=1800 字符；
 *  - 具体：一次只推进一步，指明文件/命令/要交的证据，不复述整篇方案；
 *  - 有回执：要求 agent 在回答末尾留一行 `CW-RECEIPT:`，下一轮判定就有结构化线索；
 *  - 有护栏：禁止危险动作的句子固化在模板里，不靠模型自觉。
 *
 * @module cyber-overseer/engine/whip
 */

import { clip, oneLine } from '../util/text.mjs'

/** 三种语气。默认 strict——毕竟项目叫赛博监工。 */
export const STYLES = {
  strict: {
    head: '还没到收工的时候。',
    tail: '不要解释你在做什么，直接做。做完再说话。',
  },
  neutral: {
    head: '继续推进这个任务。',
    tail: '完成后简要说明你做了什么、以及如何验证。',
  },
  gentle: {
    head: '方便的话继续推进一下这个任务～',
    tail: '做完告诉我就好。',
  },
}

/** 固化在每一条鞭子里的安全约束。 */
const SAFETY = '不要执行破坏性操作（删库、强推、绕过审批、把密钥写进代码）；如果必须人类决策，明确说出来。'

/** 回执要求：让下一轮判定更容易。 */
const RECEIPT = '回答最后一行请给出回执：`CW-RECEIPT: 本轮做了什么 | 下一步 | 阻塞(无则写无)`'

/**
 * 组装鞭子文本。
 * @param {{
 *   verdict:import('../judge/types.mjs').Verdict, plan:any, progress:any, round:number,
 *   config:any, verify?:any[], git?:any
 * }} args
 * @returns {string}
 */
export function composeWhip(args) {
  const { verdict, plan, progress, round, config, verify = [], git } = args
  const whip = config.whip ?? {}
  const style = STYLES[whip.style] ?? STYLES.strict

  if (whip.template) {
    return enforceLimit(renderTemplate(whip.template, {
      plan: plan?.title ?? '',
      remaining: (plan?.remaining ?? []).slice(0, 6).map(r => `- ${oneLine(r, 120)}`).join('\n'),
      reason: verdict?.reason ?? '',
      round: String(round ?? ''),
      evidence: renderEvidence({ verify, git, progress }),
      next: verdict?.nextPrompt ?? '',
      style: whip.style ?? 'strict',
    }), whip)
  }

  const parts = []
  const prefix = whip.prefix ? `${whip.prefix} ` : ''
  parts.push(`${prefix}${style.head}`)
  parts.push('')
  parts.push(verdict?.nextPrompt ? verdict.nextPrompt.trim() : '继续完成方案里剩下的部分。')

  if (whip.includeContext !== false) {
    const context = renderEvidence({ verify, git, progress })
    if (context) parts.push('', context)
    if (verdict?.reason) parts.push(`（监工判定依据：${oneLine(verdict.reason, 200)}）`)
    if (round) parts.push(`（第 ${round} 轮）`)
  }

  parts.push('')
  parts.push(style.tail)
  parts.push(SAFETY)
  if (whip.requireReceipt !== false) parts.push(RECEIPT)

  return enforceLimit(parts.join('\n').replace(/\n{3,}/g, '\n\n').trim(), whip)
}

function renderEvidence({ verify = [], git, progress }) {
  const lines = []
  if (progress?.total) {
    lines.push(`方案进度：${progress.done}/${progress.total}${progress.remaining?.length ? `，还剩 ${progress.remaining.length} 项` : ''}`)
  }
  const failed = (verify ?? []).filter(v => !v.ok)
  if (failed.length) {
    lines.push(`验收命令未通过：${failed.map(v => `${v.command}(码 ${v.code})`).join('、')}`)
  } else if (verify?.length) {
    lines.push(`验收命令：${verify.length} 条全部通过`)
  }
  if (git?.available && git.diffStat) {
    const changed = git.diffStat.split('\n').filter(Boolean).length
    if (changed) lines.push(`工作区有改动（${changed} 个文件）`)
  }
  return lines.join('\n')
}

function renderTemplate(template, vars) {
  return String(template).replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key) => String(vars[key] ?? ''))
}

/**
 * 长度控制：优先保留"指令"和"安全/回执"，砍掉中间的证据清单。
 * @param {string} text
 * @param {{maxChars?:number}} whip
 */
function enforceLimit(text, whip = {}) {
  const max = whip.maxChars ?? 1800
  if (text.length <= max) return text
  const cut = clip(text, max, { headRatio: 0.85 })
  return `${cut}\n（内容过长已截断——监工）`
}

/**
 * 收工/卡住时给主人的一句话（终端 + webhook 共用）。
 * @param {import('../judge/types.mjs').Verdict} verdict
 * @param {any} plan
 * @param {string} stopReason
 */
export function composeNotification({ verdict, plan, stopReason, rounds, costUsd }) {
  const icon = { done: '✅', blocked: '🛑', 'needs-human': '🙋', stalled: '😵', error: '💥' }[verdict?.status ?? stopReason] ?? 'ℹ️'
  const lines = [
    `${icon} 赛博监工：${stopReason}`,
    `方案：${plan?.title ?? plan?.path ?? '?'}（勾选 ${plan?.doneCount ?? 0}/${plan?.totalCount ?? 0}）`,
    `轮次：${rounds ?? 0}　花费：$${(costUsd ?? 0).toFixed(4)}`,
  ]
  if (verdict?.reason) lines.push(`判定：${oneLine(verdict.reason, 300)}`)
  if (plan?.remaining?.length) {
    lines.push(`剩余 ${plan.remaining.length} 项，例如：`)
    for (const item of plan.remaining.slice(0, 3)) lines.push(`  - ${oneLine(item, 100)}`)
  }
  return lines.join('\n')
}

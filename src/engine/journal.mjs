/**
 * 日志与报告。
 *
 * 两种输出：
 *  - `.cyber/journal.jsonl`：append-only 事件流，机器可读，用于事后复盘/统计；
 *  - `CW-REPORT.md`：给主人早上醒来看的一份人话报告（做了什么、为什么停、欠什么）。
 *
 * 报告的存在意义：无人值守工具最怕"我睡了 8 小时，它到底干了啥？"——所以收工/异常
 * 停止时一定要留下一份能 30 秒读完的交代。
 *
 * @module cyber-overseer/engine/journal
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { clip, indent, oneLine } from '../util/text.mjs'
import { humanDuration, isoLocal } from '../util/time.mjs'

export const EVENT_KINDS = [
  'start', 'probe', 'session', 'wait', 'round', 'evidence', 'verdict', 'whip', 'inject',
  'guard', 'pause', 'stop', 'done', 'blocked', 'needs-human', 'error', 'notify', 'report',
]

/**
 * 事件日志 + 报告生成器。
 */
export class Journal {
  /**
   * @param {{dir:string, reportFile:string, maxEvents?:number, storeAnswers?:boolean, cwd:string}} opts
   */
  constructor(opts) {
    this.dir = opts.dir
    this.cwd = opts.cwd
    this.storeAnswers = Boolean(opts.storeAnswers)
    this.maxEvents = opts.maxEvents ?? 5000
    this.events = []
    this.jsonlPath = resolve(opts.dir, 'journal.jsonl')
    this.reportPath = resolve(opts.cwd, opts.reportFile)
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
    this.session = { startedAt: Date.now() }
  }

  /**
   * 追加事件。
   * @param {string} kind
   * @param {Record<string, any>} [data]
   */
  event(kind, data = {}) {
    const record = { at: Date.now(), iso: isoLocal(), kind, ...data }
    if (!this.storeAnswers && typeof record.answer === 'string') {
      record.answerTail = clip(record.answer, 800)
      delete record.answer
    }
    this.events.push(record)
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents)
    try {
      appendFileSync(this.jsonlPath, JSON.stringify(record) + '\n', 'utf8')
    } catch { /* 日志写不进去不能影响主流程 */ }
    return record
  }

  /** 读回历史事件（断点续跑时用来恢复上下文）。 */
  readHistory(limit = 500) {
    if (!existsSync(this.jsonlPath)) return []
    try {
      const lines = readFileSync(this.jsonlPath, 'utf8').split('\n').filter(Boolean)
      return lines.slice(-limit).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    } catch {
      return []
    }
  }

  /**
   * 写 Markdown 报告。
   * @param {{
   *   state:import('./state.mjs').OverseerState, config:any, plan:any, adapterLabel:string,
   *   sessionId:string|null, stopReason:string, verdict:import('../judge/types.mjs').Verdict|null,
   *   extra?:string
   * }} args
   */
  writeReport(args) {
    const { state, plan, adapterLabel, sessionId, stopReason, verdict } = args
    const started = state.startedAt ?? this.session.startedAt
    const rounds = state.rounds ?? []
    const lines = []
    lines.push(`# 赛博监工报告`)
    lines.push('')
    lines.push(`- 生成时间：${isoLocal()}`)
    lines.push(`- 监工时长：${humanDuration(Date.now() - started)}（自 ${isoLocal(started)}）`)
    lines.push(`- 监工对象：${adapterLabel}${sessionId ? `，会话 \`${sessionId}\`` : ''}`)
    lines.push(`- 方案文档：\`${plan?.path ?? '?'}\`（勾选 ${plan?.doneCount ?? 0}/${plan?.totalCount ?? 0}）`)
    lines.push(`- 抽鞭次数：${rounds.length}，判定花费：$${(state.costUsd ?? 0).toFixed(4)}`)
    lines.push(`- 结束原因：**${stopReasonLabel(stopReason)}**`)
    if (verdict) {
      lines.push(`- 最终判定：\`${verdict.status}\`（置信度 ${verdict.confidence?.toFixed?.(2) ?? '?'}）— ${oneLine(verdict.reason, 400)}`)
    }
    lines.push('')

    const open = plan?.remaining ?? []
    if (open.length) {
      lines.push(`## 还没做完的事（${open.length} 项）`)
      for (const item of open.slice(0, 30)) lines.push(`- [ ] ${item}`)
      lines.push('')
    } else if (plan?.totalCount) {
      lines.push('## 方案清单')
      lines.push('全部复选框已勾选。')
      lines.push('')
    }

    lines.push('## 每一轮都发生了什么')
    lines.push('')
    lines.push('| 轮次 | 判定 | 置信度 | 耗时 | 为什么 | 抽出去的鞭子 |')
    lines.push('| --- | --- | --- | --- | --- | --- |')
    for (const round of rounds) {
      const v = round.verdict ?? {}
      lines.push(`| ${round.round} | ${v.status ?? '?'} | ${v.confidence?.toFixed?.(2) ?? '?'} | ${humanDuration((round.endedAt ?? round.startedAt) - round.startedAt)} | ${escapeCell(oneLine(v.reason ?? '', 220))} | ${escapeCell(oneLine(round.injected ?? '', 160)) || '—'} |`)
    }
    lines.push('')

    const last = rounds.at(-1)
    if (last?.answerText || last?.answerTail) {
      lines.push('## 最后一次回答（尾部）')
      lines.push('')
      lines.push('```text')
      lines.push(clip(last.answerText ?? last.answerTail ?? '', 2000))
      lines.push('```')
      lines.push('')
    }

    if (args.extra) {
      lines.push('## 备注')
      lines.push('')
      lines.push(args.extra)
      lines.push('')
    }

    lines.push('## 我该怎么接着干')
    lines.push('')
    lines.push(...nextSteps(stopReason, plan, verdict).map(s => `- ${s}`))
    lines.push('')
    lines.push('---')
    lines.push('')
    lines.push('*本报告由赛博监工自动生成：`cw report` 可重新打印，`cw run` 可继续监工。*')

    const text = lines.join('\n')
    try {
      writeFileSync(this.reportPath, text, 'utf8')
      this.event('report', { path: this.reportPath, bytes: text.length })
    } catch { /* 报告写不进去也不能崩 */ }
    return { path: this.reportPath, text }
  }

  /** 控制台摘要。 */
  printSummary(logger, state) {
    const rounds = state.rounds ?? []
    logger.raw('')
    logger.banner('赛博监工小结')
    logger.raw(`  轮次 ${rounds.length}  花费 $${(state.costUsd ?? 0).toFixed(4)}  状态 ${state.status}`)
    for (const round of rounds.slice(-5)) {
      logger.raw(`  #${round.round} ${round.verdict?.status ?? '?'} — ${oneLine(round.verdict?.reason ?? '', 100)}`)
    }
    logger.raw(`  报告：${this.reportPath}`)
    logger.raw('')
  }
}

function escapeCell(text) {
  return String(text ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

function stopReasonLabel(reason) {
  const map = {
    done: '目标已完成，收工',
    'max-rounds': '达到轮次上限',
    'max-wall-clock': '达到时长上限',
    'max-cost': '达到花费上限',
    stalled: '连续多轮无进展（疑似卡死）',
    blocked: '判定为受阻',
    'needs-human': '需要主人介入',
    paused: '主人喊停（PAUSE 文件）',
    'dry-run-complete': '演练模式完成',
    aborted: '被中断（Ctrl+C / 信号）',
    error: '出错停止',
    'agent-gone': '找不到被监工的会话/agent',
  }
  return map[reason] ?? reason
}

function nextSteps(reason, plan, verdict) {
  const steps = []
  if (reason === 'done') {
    steps.push('核对 `git diff` 与验收命令输出，确认结果符合预期后再合并。')
    steps.push('如果这不是你想要的"完成"，把方案文档写得更具体（尤其是验收标准），再来一轮。')
  } else if (reason === 'needs-human') {
    steps.push(`回答监工的问题：${oneLine(verdict?.reason ?? '', 200)}`)
    steps.push('在方案文档里补齐「验收标准」，监工下次就能自己判断了。')
  } else if (reason === 'stalled' || reason === 'blocked') {
    steps.push('看上面表格里"抽出去的鞭子"与 agent 的回答，判断它到底卡在哪。')
    steps.push('把卡点写成方案文档里的一个更小、更明确的任务，再跑 `cw run`。')
  } else if (reason === 'max-rounds' || reason === 'max-wall-clock' || reason === 'max-cost') {
    steps.push('预算用完了但任务没完：调大 `guard.maxRounds` / `guard.maxWallClockMs` 后继续 `cw run`。')
    steps.push('或者缩小方案范围：把大目标拆成几个能被单轮完成的小目标。')
  } else if (reason === 'aborted') {
    steps.push('直接 `cw run` 可以接着上一轮继续（状态已落盘）。')
  } else if (reason === 'error') {
    steps.push('看 `.cyber/journal.jsonl` 最后几条事件定位错误。')
  }
  if (plan?.remaining?.length) steps.push(`方案里还有 ${plan.remaining.length} 项没勾选。`)
  return steps.length ? steps : ['没有额外建议。']
}

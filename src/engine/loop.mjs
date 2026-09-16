/**
 * 监工主循环。
 *
 * 一个回合（round）的完整生命周期：
 *
 *   ┌─ 护栏检查（暂停哨兵 / 轮次 / 时长 / 花费 / 静默期 / 工作时段）
 *   │
 *   ├─ 等 agent 空闲       ← 绝不在它正在说话的时候插嘴
 *   ├─ 读最后一次回答      ← 适配器：读磁盘会话 / UI 对话框
 *   ├─ 采证据              ← 验收命令 + git 改动 + 方案勾选
 *   ├─ 判定                ← rule / llm / human，输出 done|continue|blocked|needs-human
 *   ├─ 判定为 done → 写报告、通知、退出（唯一的"好"结局）
 *   ├─ 判定为 continue → 组鞭子 → 注入（抽）→ 等它这一回合结束
 *   └─ 回到开头
 *
 * 与 agent 的"谁等谁"是本模块最微妙的地方：适配器分两种模式——
 *  - `foreground`：鞭子本身就是"把 agent 跑完一轮"（codex exec resume / dsh headless / 通用 CLI），
 *    注入返回时回合已经结束；
 *  - `inject`：鞭子只是"往活着的会话里塞一句话"（GUI 拟人 / Cursor hook / DSH 在线会话），
 *    注入后还必须等它开工、再等它收工。
 * 引擎对这两种模式分别处理，见 `waitForTurnEnd`。
 *
 * @module cyber-overseer/engine/loop
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { planProgress, planSummary, loadPlan } from '../plan.mjs'
import { createJudge } from '../judge/index.mjs'
import { normalizeVerdict } from '../judge/types.mjs'
import { createLogger } from '../util/log.mjs'
import { hash, oneLine, clip } from '../util/text.mjs'
import { humanDuration, inWindow, msUntilWindow, sleep } from '../util/time.mjs'
import { collectEvidence, normalizeAnswer } from './evidence.mjs'
import { Journal } from './journal.mjs'
import { composeNotification, composeWhip } from './whip.mjs'
import { StateStore, statePath } from './state.mjs'
import { createAdapter, loadAdapters } from '../adapters/index.mjs'

/** 停止原因 → 退出码。0=目标完成；其余非零便于 CI/脚本判断。 */
export const EXIT_CODES = {
  done: 0,
  'max-rounds': 10,
  'max-wall-clock': 11,
  'max-cost': 12,
  stalled: 13,
  blocked: 14,
  'needs-human': 15,
  paused: 16,
  'dry-run-complete': 0,
  aborted: 130,
  error: 1,
  'agent-gone': 17,
}

/**
 * 跑监工。
 * @param {{
 *   config:any, cwd:string, planPath:string, agentCwd:string, log?:any, signal?:AbortSignal,
 *   resume?:boolean, deps?:Record<string,any>, once?:boolean
 * }} opts
 */
export async function runOverseer(opts) {
  const { config, cwd, planPath, agentCwd } = opts
  const log = opts.log ?? createLogger({ level: config.runtime?.logLevel ?? 'info' })
  const deps = opts.deps ?? {}
  const signal = opts.signal
  const now = deps.now ?? (() => Date.now())

  // ---------- 方案文档 ----------
  // 注意：方案文档是"合同"，agent 会在工作过程中勾选/修改它，所以**每轮都要重读**，
  // 不能只在启动时读一次（否则监工永远看不到进展——这是踩过的坑）。
  let plan = loadPlan(planPath, { fs: deps.readFileSync })
  let progress = planProgress(plan)
  log.step(`方案文档：${planPath}`)
  log.raw(indentBlock(planSummary(plan, 1200)))

  // ---------- 适配器 ----------
  await loadAdapters()
  const adapter = createAdapter(config.agent?.adapter ?? 'dsh', { config, cwd: agentCwd, log, deps, signal })
  const probe = await adapter.probe()
  if (!probe.ok) {
    log.error(`适配器 ${adapter.id} 不可用：${probe.reason ?? '未知原因'}`)
    if (probe.hints?.length) for (const hint of probe.hints) log.warn(`  · ${hint}`)
    return finish({
      stopReason: 'error', verdict: null, plan, store: null, journal: null, adapter, session: null,
      log, config, exitCode: EXIT_CODES.error, error: probe.reason,
    })
  }
  log.ok(`适配器就绪：${adapter.label}${probe.detail ? ` — ${probe.detail}` : ''}`)

  const session = await adapter.resolveSession(config.agent?.session ?? 'latest', { plan })
  if (!session) {
    log.error('找不到要监工的会话。用 `cw sessions` 看看有哪些。')
    return finish({
      stopReason: 'agent-gone', verdict: null, plan, store: null, journal: null, adapter, session: null,
      log, config, exitCode: EXIT_CODES['agent-gone'],
    })
  }
  log.ok(`监工目标：${adapter.label} 会话 ${session.id ?? '(默认)'}${session.title ? ` — ${oneLine(session.title, 60)}` : ''}`)

  // ---------- 状态与日志 ----------
  const store = StateStore.open(statePath(config, cwd), {
    adapter: adapter.id,
    sessionId: session.id ?? null,
    cwd: agentCwd,
    planSha: plan.sha256,
    status: 'running',
  })
  if (!opts.resume && store.state.rounds?.length && store.state.status === 'running') {
    log.warn(`检测到未结束的上一次监工（第 ${store.state.roundsStarted} 轮），加 --fresh 可重来`)
  }
  store.patch({ adapter: adapter.id, sessionId: session.id ?? null, cwd: agentCwd, planSha: plan.sha256, status: 'running', stopReason: null })

  const journal = new Journal({
    dir: opts.journalDir ?? resolve(cwd, config.journal?.dir ?? '.cyber'),
    cwd,
    reportFile: config.journal?.reportFile ?? 'CW-REPORT.md',
    maxEvents: config.journal?.maxEvents,
    storeAnswers: config.journal?.storeAnswers,
  })
  journal.event('start', {
    adapter: adapter.id, sessionId: session.id ?? null, plan: planPath, planSha: plan.sha256,
    progress: { done: progress.done, total: progress.total },
    judge: config.judge?.kind, dryRun: Boolean(config.runtime?.dryRun),
  })

  const judge = createJudge(config, { log, deps: deps.judge })
  log.step(judge.describe?.() ?? `判定器：${judge.id}`)

  const pauseFile = resolve(cwd, config.guard?.pauseFile ?? '.cyber/PAUSE')
  const ctx = {
    config, cwd, planPath, agentCwd, plan, progress, adapter, session, store, journal, judge,
    log, signal, deps, now, pauseFile, previous: null,
  }

  // ---------- 主循环 ----------
  let round = store.state.roundsStarted ?? 0
  let lastEvidence = null
  let blockedCount = 0
  let lastVerdict = null
  let blankReads = 0

  for (;;) {
    // (1) 护栏
    const guard = checkGuards({ ...ctx, stopReason: null })
    if (guard.stop) {
      journal.event('guard', { stop: true, reason: guard.reason })
      log.warn(`护栏触发：${guard.reason}`)
      return finish({ ...ctx, stopReason: guard.reason, verdict: lastVerdict, exitCode: EXIT_CODES[guard.reason] ?? 1 })
    }
    if (guard.waitMs) {
      log.step(`等待时段：${guard.reason}（${humanDuration(guard.waitMs)}）`)
      journal.event('wait', { reason: guard.reason, waitMs: guard.waitMs })
      await sleep(guard.waitMs, signal).catch(() => {})
      continue
    }

    round++

    // (1.5) 重读方案文档：它的勾选状态就是"进展"的权威来源
    const freshPlan = loadPlan(planPath, { fs: deps.readFileSync })
    if (freshPlan.sha256 !== plan.sha256) {
      log.step(`方案文档有更新：勾选 ${freshPlan.doneCount}/${freshPlan.totalCount}`)
      journal.event('plan-reload', { sha256: freshPlan.sha256, done: freshPlan.doneCount, total: freshPlan.totalCount })
    }
    plan = freshPlan
    progress = planProgress(plan)
    ctx.plan = plan
    ctx.progress = progress

    // (2) 等 agent 空闲
    const idle = await waitForTurnEnd({ ...ctx, phase: 'before-judge', timeoutMs: config.guard?.waitForAgentIdleMs })
    if (idle.timedOut) {
      log.warn(`等 agent 收工超时（${humanDuration(config.guard?.waitForAgentIdleMs)}），仍按当前状态判定`)
      journal.event('wait', { phase: 'before-judge', timedOut: true })
    }

    // (3) 读状态
    const snapshot = await adapter.readState(session)
    if (snapshot.error) {
      log.error(`读会话失败：${snapshot.error}`)
      journal.event('error', { where: 'readState', message: snapshot.error })
    }
    // "读不到东西"本身不算 agent 消失（第一轮本来就没有历史回答）；连续读不到才判定失联。
    if (!snapshot.lastAnswer && !snapshot.turn && snapshot.status === 'unknown') {
      blankReads++
      if (blankReads >= 3) {
        journal.event('stop', { reason: 'agent-gone', blankReads })
        return finish({ ...ctx, stopReason: 'agent-gone', verdict: lastVerdict, exitCode: EXIT_CODES['agent-gone'] })
      }
      log.warn(`连续第 ${blankReads} 次读不到任何状态（会话可能不存在或还没开始）`)
    } else {
      blankReads = 0
    }

    if (snapshot.status === 'awaiting-approval') {
      const handled = await handleApproval({ ...ctx, snapshot })
      if (handled.stop) return finish({ ...ctx, stopReason: handled.reason, verdict: lastVerdict, exitCode: EXIT_CODES[handled.reason] ?? 1 })
    }

    // (4) 采证据
    const evidence = await collectEvidence({
      config, cwd: agentCwd, plan, answer: snapshot.lastAnswer ?? '',
      previous: lastEvidence ? { evidence: lastEvidence, answerHash: lastEvidence.answerHash } : null,
      history: store.rounds, runFn: deps.run, log, signal,
    })
    lastEvidence = evidence
    journal.event('evidence', {
      gate: evidence.answerHash,
      fingerprint: evidence.fingerprint,
      verify: evidence.verify.map(v => ({ command: v.command, ok: v.ok, code: v.code, cached: v.cached })),
      sameAsPreviousAnswer: evidence.sameAsPreviousAnswer,
      stallRounds: evidence.stallRounds,
      gitChanged: evidence.git?.changedSinceLastRound ?? null,
    })

    // (5) 判定
    const judgeInput = {
      plan, progress, answer: snapshot.lastAnswer ?? '', lastUserMessage: snapshot.lastUserMessage ?? null,
      evidence, history: store.rounds, config, round, log,
      agentAwaitingInput: Boolean(snapshot.awaitingInput),
      agentAwaitingApproval: snapshot.status === 'awaiting-approval',
    }
    const verdict = normalizeVerdict(await judge.judge(judgeInput), { judge: judge.id })
    lastVerdict = verdict
    log.step(`第 ${round} 轮判定：${verdict.status}（${verdict.confidence.toFixed(2)}）— ${oneLine(verdict.reason, 140)}`)
    journal.event('verdict', {
      round, status: verdict.status, reason: verdict.reason, confidence: verdict.confidence,
      judge: verdict.judge, costUsd: verdict.costUsd, nextPrompt: verdict.nextPrompt,
    })

    // (6) 结束类判定
    if (verdict.status === 'done') {
      store.recordRound(makeRound({ round, verdict, evidence, injected: null, snapshot, store }))
      store.patch({ status: 'done', stopReason: 'done' })
      return finish({ ...ctx, stopReason: 'done', verdict, exitCode: EXIT_CODES.done })
    }
    if (verdict.status === 'needs-human') {
      store.recordRound(makeRound({ round, verdict, evidence, injected: null, snapshot, store }))
      store.patch({ status: 'needs-human', stopReason: 'needs-human' })
      return finish({ ...ctx, stopReason: 'needs-human', verdict, exitCode: EXIT_CODES['needs-human'] })
    }
    if (verdict.status === 'blocked') {
      blockedCount++
      const limit = config.guard?.maxBlockedRounds ?? 2
      store.recordRound(makeRound({ round, verdict, evidence, injected: null, snapshot, store }))
      if (blockedCount >= limit) {
        store.patch({ status: 'blocked', stopReason: 'blocked' })
        return finish({ ...ctx, stopReason: 'blocked', verdict, exitCode: EXIT_CODES.blocked })
      }
      log.warn(`判定受阻（第 ${blockedCount}/${limit} 次）：${oneLine(verdict.reason, 120)}，再抽最后几鞭试试`)
    }

    // (7) 无进展熔断（规则判定之外的兜底：agent 一直回一样的话）
    const stallLimit = config.guard?.maxStallRounds ?? 3
    if (evidence.stallRounds >= stallLimit) {
      store.recordRound(makeRound({ round, verdict, evidence, injected: null, snapshot, store }))
      store.patch({ status: 'stalled', stopReason: 'stalled' })
      log.warn(`连续 ${evidence.stallRounds} 轮无任何进展，停止监工`)
      return finish({ ...ctx, stopReason: 'stalled', verdict, exitCode: EXIT_CODES.stalled })
    }

    // (8) 抽鞭
    const whipText = composeWhip({ verdict, plan, progress, round, config, verify: evidence.verify, git: evidence.git })
    if (config.runtime?.dryRun) {
      log.banner('（演练模式）本来要抽的鞭子：')
      log.raw(indentBlock(clip(whipText, 2000)))
      store.recordRound(makeRound({ round, verdict, evidence, injected: whipText, snapshot, store }))
      store.patch({ status: 'dry-run', stopReason: 'dry-run-complete' })
      return finish({ ...ctx, stopReason: 'dry-run-complete', verdict, exitCode: EXIT_CODES['dry-run-complete'] })
    }

    const beforeHash = evidence.answerHash
    const injected = await adapter.whip(whipText, session, ctx)
    journal.event('inject', {
      round, mode: injected?.mode ?? 'unknown', ok: injected?.ok !== false,
      detail: injected?.detail ?? null, chars: whipText.length, whip: whipText,
    })
    if (injected?.ok === false) {
      // 失败要分类：通道没配置好 ≠ 出错。前者应该停下喊人（并给出怎么配），后者才是 error。
      const kind = injected?.kind ?? 'fatal'
      if (kind === 'transient') {
        log.warn(`抽鞭暂时失败（${injected.detail ?? '未说明'}），下一轮再试`)
        journal.event('error', { where: 'whip', transient: true, message: injected.detail ?? null })
        store.recordRound(makeRound({ round, verdict, evidence, injected: whipText, snapshot, store }))
        store.patch({ status: 'running' })
        await sleep(Math.max(1000, config.guard?.cooldownMs ?? 0), signal).catch(() => {})
        continue
      }
      log.error(`抽鞭失败：${injected.detail ?? '适配器未说明原因'}`)
      journal.event('error', { where: 'whip', kind, message: injected.detail ?? null })
      store.recordRound(makeRound({ round, verdict, evidence, injected: whipText, snapshot, store }))
      const setupProblem = kind === 'setup'
      store.patch({ status: setupProblem ? 'needs-human' : 'error', stopReason: setupProblem ? 'needs-human' : 'error' })
      return finish({
        ...ctx,
        stopReason: setupProblem ? 'needs-human' : 'error',
        verdict,
        exitCode: EXIT_CODES[setupProblem ? 'needs-human' : 'error'],
        error: setupProblem ? `抽鞭通道还没配置好：${injected.detail ?? ''}` : undefined,
      })
    }
    log.ok(`已抽鞭（第 ${round} 轮，${injected?.mode === 'foreground' ? '前台跑完' : '注入待跑'}，${whipText.length} 字）`)
    // 让 agent 的订阅者（GUI/终端）有时间把新消息显示出来，避免抢焦点时打字打到旧输入框
    await sleep(Math.max(0, config.guard?.cooldownMs ?? 0), signal).catch(() => {})

    if (injected?.mode !== 'foreground') {
      const waited = await waitForNewAnswer({ ...ctx, beforeHash, timeoutMs: config.guard?.waitForAgentIdleMs })
      if (waited.changed) {
        log.ok(`agent 已给出新一轮回答（等待 ${humanDuration(waited.elapsedMs)}）`)
      } else {
        log.warn(`等待 agent 新回答超时（${humanDuration(waited.elapsedMs)}）`)
        journal.event('wait', { phase: 'after-whip', timedOut: true, elapsedMs: waited.elapsedMs })
      }
    }

    store.recordRound(makeRound({ round, verdict, evidence, injected: whipText, snapshot, store }))
    store.patch({ status: 'running' })
  }
}

/** 组装一轮记录。 */
function makeRound({ round, verdict, evidence, injected, snapshot, store }) {
  const started = store.rounds.at(-1)?.endedAt ?? store.state.startedAt
  return {
    round,
    startedAt: started,
    endedAt: Date.now(),
    verdict,
    injected,
    answerHash: evidence?.answerHash ?? hash(snapshot?.lastAnswer ?? ''),
    answerText: snapshot?.lastAnswer ?? undefined,
    fingerprint: evidence?.fingerprint ?? '',
    costUsd: verdict?.costUsd ?? 0,
    waitMs: 0,
  }
}

/**
 * 护栏检查：返回 {stop,reason} 或 {waitMs,reason} 或 {}。
 * 单独导出，便于单测——这是"无人值守不出事"的关键。
 */
export function checkGuards(ctx) {
  const { config, store, plan, progress, now = () => Date.now() } = ctx
  const guard = config.guard ?? {}
  const state = store?.state

  if (ctx.pauseFile && existsSync(ctx.pauseFile)) {
    return { stop: true, reason: 'paused' }
  }
  if (state) {
    const started = state.startedAt ?? now()
    if (guard.maxWallClockMs > 0 && now() - started >= guard.maxWallClockMs) {
      return { stop: true, reason: 'max-wall-clock' }
    }
    if (guard.maxRounds > 0 && (state.roundsStarted ?? 0) >= guard.maxRounds) {
      return { stop: true, reason: 'max-rounds' }
    }
    if (guard.maxCostUsd != null && (state.costUsd ?? 0) >= guard.maxCostUsd) {
      return { stop: true, reason: 'max-cost' }
    }
  }
  if (!plan) return {}
  if (guard.quietHours && !inWindow(guard.quietHours)) {
    const waitMs = Math.min(msUntilWindow(guard.quietHours), 30 * 60 * 1000)
    return { waitMs: Math.max(waitMs, 60 * 1000), reason: `不在静默期（${guard.quietHours.from}–${guard.quietHours.to}）内` }
  }
  if (guard.workWindow && !inWindow(guard.workWindow)) {
    const waitMs = Math.min(msUntilWindow(guard.workWindow), 30 * 60 * 1000)
    return { waitMs: Math.max(waitMs, 60 * 1000), reason: `不在工作时段（${guard.workWindow.from}–${guard.workWindow.to}）内` }
  }
  return {}
}

/**
 * 等到 agent 本回合结束（或超时）。
 * @param {any} ctx
 * @returns {Promise<{timedOut:boolean, snapshot:any, elapsedMs:number}>}
 */
async function waitForTurnEnd(ctx) {
  const { adapter, session, log, signal, deps } = ctx
  const timeoutMs = ctx.timeoutMs ?? 1800000
  const pollMs = ctx.config.guard?.pollIntervalMs ?? (deps.pollIntervalMs ?? 5000)
  const started = Date.now()
  const sleepFn = deps.sleep ?? sleep
  for (;;) {
    const snapshot = await adapter.readState(session)
    const busy = snapshot.status === 'working'
    if (!busy) return { timedOut: false, snapshot, elapsedMs: Date.now() - started }
    if (Date.now() - started >= timeoutMs) return { timedOut: true, snapshot, elapsedMs: Date.now() - started }
    if (ctx.phase === 'before-judge') {
      log.debug?.(`agent 正在工作（回合 ${snapshot.turn ?? '?'}），等它说完再判定…`)
    }
    await sleepFn(pollMs, signal).catch(() => {})
  }
}

/**
 * 抽完鞭后等"新回答出现且回合结束"。
 * @param {any} ctx
 */
async function waitForNewAnswer(ctx) {
  const { adapter, session, beforeHash, signal, deps } = ctx
  const timeoutMs = ctx.timeoutMs ?? 3600000
  const pollMs = ctx.config.guard?.pollIntervalMs ?? (deps.pollIntervalMs ?? 5000)
  const started = Date.now()
  const sleepFn = deps.sleep ?? sleep
  let sawWorking = false
  for (;;) {
    const snapshot = await adapter.readState(session)
    if (snapshot.status === 'working') sawWorking = true
    const newHash = hash(normalizeAnswer(snapshot.lastAnswer ?? ''))
    if (!snapshot.status || snapshot.status === 'idle' || snapshot.status === 'error') {
      if (newHash && newHash !== beforeHash) return { changed: true, snapshot, elapsedMs: Date.now() - started, sawWorking }
      // 有些 agent 会在被注入后立刻返回（例如 hook 模式下），只要 answer 变了就算数；
      // 若一直没变且已经过了它"开工"的窗口，就返回超时。
    }
    if (Date.now() - started >= timeoutMs) return { changed: false, snapshot, elapsedMs: Date.now() - started, sawWorking }
    await sleepFn(pollMs, signal).catch(() => {})
  }
}

/** 处理"agent 在等审批"。 */
async function handleApproval(ctx) {
  const { adapter, config, log, journal, snapshot, session } = ctx
  if (config.guard?.autoApprove && typeof adapter.approve === 'function') {
    const result = await adapter.approve(snapshot.approval, session)
    journal?.event('approval', { auto: true, ok: result?.ok !== false, detail: result?.detail ?? null })
    if (result?.ok !== false) {
      log.warn('已按 guard.autoApprove 自动放行 agent 的审批请求（风险自负）')
      return { stop: false }
    }
    log.error(`自动放行失败：${result?.detail ?? '适配器未说明'}`)
    return { stop: true, reason: 'needs-human' }
  }
  log.warn('agent 正在等待审批，监工不替主人点"同意"——交还给人。')
  journal?.event('approval', { auto: false, pending: snapshot.approval ?? null })
  return { stop: true, reason: 'needs-human' }
}

/** 收尾：写报告 + 通知 + 返回结果。 */
async function finish(ctx) {
  const { stopReason, verdict, plan, store, journal, adapter, session, log, config } = ctx
  const state = store?.state ?? { rounds: [], costUsd: 0 }
  let reportPath = null
  if (journal && plan) {
    reportPath = journal.writeReport({
      state,
      config,
      plan,
      adapterLabel: adapter?.label ?? adapter?.id ?? 'unknown',
      sessionId: session?.id ?? null,
      stopReason,
      verdict,
      extra: ctx.error ? `错误：${ctx.error}` : undefined,
    })?.path
  }
  if (journal) journal.event('stop', { reason: stopReason, verdict: verdict?.status ?? null, reportPath })
  const notifyText = composeNotification({
    verdict, plan, stopReason,
    rounds: state.rounds?.length ?? 0,
    costUsd: state.costUsd ?? 0,
  })
  await notify({ config, text: notifyText, log })
  if (log) {
    log.raw('')
    log.banner(stopLabel(stopReason))
    log.raw(indentBlock(notifyText))
    journal?.printSummary?.(log, state)
  }
  return {
    stopReason,
    verdict,
    reportPath,
    rounds: state.rounds?.length ?? 0,
    costUsd: state.costUsd ?? 0,
    exitCode: ctx.exitCode ?? 0,
    error: ctx.error ?? null,
  }
}

/** 通知：终端响铃 + webhook。 */
async function notify({ config, text, log }) {
  const notifyCfg = config.notify ?? {}
  if (notifyCfg.beep) {
    try { process.stdout.write('\u0007') } catch { /* 忽略 */ }
  }
  if (!notifyCfg.webhook) return
  const { jsonRequest } = await import('../util/http.mjs')
  try {
    await jsonRequest(notifyCfg.webhook, {
      method: 'POST',
      body: { text, content: text, msgtype: 'text', message: text },
      timeoutMs: 15000,
    })
    log?.debug?.('webhook 通知已发送')
  } catch (error) {
    log?.warn?.(`webhook 通知失败：${error?.message ?? error}`)
  }
}

function stopLabel(reason) {
  const map = {
    done: '✅ 收工：目标已完成',
    blocked: '🛑 停止：判定为受阻',
    'needs-human': '🙋 停止：需要主人决策',
    stalled: '😵 停止：连续无进展',
    'max-rounds': '⏳ 停止：达到轮次上限',
    'max-wall-clock': '⏳ 停止：达到时长上限',
    'max-cost': '💸 停止：达到花费上限',
    paused: '⏸ 停止：主人喊停',
    'dry-run-complete': '🧪 演练完成（未真的抽鞭）',
    aborted: '⛔ 已中断',
    error: '💥 出错停止',
    'agent-gone': '🔍 找不到被监工的会话',
  }
  return map[reason] ?? `停止：${reason}`
}

function indentBlock(text) {
  return String(text ?? '').split('\n').map(l => (l ? `  ${l}` : l)).join('\n')
}

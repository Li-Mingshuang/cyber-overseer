/**
 * 催工模式（`cw poke`）—— 这个项目**最小**的形态。
 *
 * 用户的原话：*"我的期望就是 agent 回复完最后一条消息后，或者需要人机交互的情况，
 * 让监工去督促他继续工作"*。所以这里只有三件事：
 *
 *   1. **盯着它**：轮询 agent 会话状态（读磁盘会话，不动 agent）；
 *   2. **它一停就催**：
 *      · 空闲（回复完了、在等人）→ 催一句「继续，别等我」；
 *      · 在等你回话 / 等审批（需要人机交互）→ 催它「自己选最合理的做法继续，只有真定不了的才留给我」；
 *      · 正在跑 → 什么都不做，等它。
 *   3. **停下来的时候有理由**：它说完成了（CW:DONE）、连续两轮回答完全没变（卡住了）、
 *      到达催工次数上限、你按了 Ctrl+C 或建了 PAUSE 文件。
 *
 * 没有方案文档、没有验收命令、没有 LLM 判定、没有配置——因为"催一下让它继续"这件事不需要它们。
 *（想要"验收证据 + 判定完成"那套严谨流程时，再用 `cw run` / `cw "<一句话>"`。）
 *
 * @module cyber-overseer/poke
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaultConfig, mergeConfig } from './config.mjs'
import { loadAdapters, createAdapter } from './adapters/index.mjs'
import { detectAgent } from './quick.mjs'
import { createLogger } from './util/log.mjs'
import { hash, oneLine, normalize } from './util/text.mjs'
import { humanDuration, sleep } from './util/time.mjs'
import { Journal } from './engine/journal.mjs'

/** 默认催促语：短、像人说话、并且明确处理"它在等我"这种情况。 */
export const DEFAULT_NUDGE = [
  '继续，不要停下来等我。',
  '如果你正在等我回答或等我批准：请自己选最合理、最可回退的做法继续做下去，并在回答里说明你的选择；',
  '只有真正无法自行决定的事（需要我提供凭据、需要产品决策、涉及不可逆风险）才列出来等我回来。',
  '全部做完后，在回答里写上 CW:DONE。',
].join('')

/** 需要人机交互时用的催促语（更强调"自己决定"）。 */
export const WAITING_NUDGE = [
  '我在忙，现在回答不了你。',
  '请你基于现有信息自己做出最合理的判断继续推进；能回退的选择就直接选，把风险和选择写进回答里。',
  '只有涉及不可逆操作或必须由我提供的凭据时，才停下来等我。做完写 CW:DONE。',
].join('')

/**
 * 判断回答里是不是**真的宣告完成**了。
 *
 * 只"提到"CW:DONE 不算——实测踩到过：回答里写"方案里说要做完写 CW:DONE 标记"，
 * 宽松匹配就会把这种"引用说明"当成完成宣告，导致监工提前收工。
 * 所以只认三种真宣告形式：
 *   1. HTML 注释形式：`<!-- CW:DONE -->`
 *   2. 独占一行以 CW:DONE 开头
 *   3. 出现在回答**结尾**（最后 80 字内）
 * @param {string} answer
 */
export function looksDone(answer) {
  const text = String(answer ?? '')
  if (!text.trim()) return false
  if (/<!--\s*CW:DONE\s*-->/i.test(text)) return true
  if (/^\s*CW:?\s*DONE\b/im.test(text)) return true
  return /CW:?\s*DONE\s*[。.!！]?\s*$/i.test(text.slice(-80).trim())
}

/**
 * 决策：给定一次快照与历史，下一步该干嘛。**纯函数**，便于测试。
 *
 * @param {{
 *   snapshot:{status:string, lastAnswer?:string, turn?:number},
 *   lastNudgedHash?:string|null,
 *   stallCount?:number,
 *   nudgesSent:number, maxNudges:number,
 *   nudgeText:string, waitingNudgeText:string, completionMarker?:RegExp
 * }} input
 * @returns {{action:'wait'|'nudge'|'stop', reason:string, text?:string}}
 */
export function decidePoke(input) {
  const {
    snapshot, nudgesSent, maxNudges,
    nudgeText = DEFAULT_NUDGE, waitingNudgeText = WAITING_NUDGE,
    completionMarker = null, stallCount = 0,
  } = input
  const status = snapshot?.status ?? 'unknown'
  const answer = String(snapshot?.lastAnswer ?? '')

  // 0) 已经完成：它自己宣告了（只认回答里的真宣告形式，提到不算）
  const done = completionMarker ? completionMarker.test(answer) : looksDone(answer)
  if (done) {
    return { action: 'stop', reason: 'agent 宣告完成（CW:DONE）' }
  }
  // 1) 还在跑 → 等
  if (status === 'working') return { action: 'wait', reason: 'agent 正在工作' }
  // 2) 卡住（连续两轮回答一字不变，且我们已经催过）→ 停
  if (nudgesSent > 0 && stallCount >= 2) {
    return { action: 'stop', reason: `连续 ${stallCount} 轮催促后回答与动作都没变化，像是真的卡住了` }
  }
  // 3) 次数用完 → 停
  if (nudgesSent >= maxNudges) return { action: 'stop', reason: `已催 ${nudgesSent} 次（上限 ${maxNudges}）` }
  // 4) 需要人机交互（等你回答 / 等审批）→ 催它自己决定
  if (status === 'awaiting-input' || status === 'awaiting-approval') {
    return { action: 'nudge', text: waitingNudgeText, reason: `agent 在等人类（${status}）→ 催它自己往下走` }
  }
  // 5) 空闲（回复完了在等人）→ 催继续
  if (status === 'idle') return { action: 'nudge', text: nudgeText, reason: 'agent 已停下（空闲）→ 催它继续' }
  // 6) 读不到状态 → 等（可能是刚启动/会话写盘中）
  if (status === 'error') return { action: 'stop', reason: 'agent 停在错误上（需要人看一眼）' }
  return { action: 'wait', reason: `状态未知（${status}），先等一会儿` }
}

/**
 * 跑催工循环（阻塞直到停止条件成立）。
 * @param {{
 *   cwd:string, log?:any, agentId?:string, session?:string, maxNudges?:number,
 *   everyMs?:number, nudge?:string, onEvent?:(e:any)=>void, signal?:AbortSignal
 * }} opts
 */
export async function runPoke(opts) {
  const log = opts.log ?? createLogger({ level: 'info' })
  const cwd = opts.cwd
  const maxNudges = Number(opts.maxNudges ?? 30)
  const everyMs = Number(opts.everyMs ?? 5000)
  const peerPollMs = Number(opts.peerPollMs ?? 4000)

  await loadAdapters()
  // 选 agent：沿用"一句话起步"的判断（优先 DSH，并只认工作目录完全一致的会话）
  const agent = await detectAgent({ cwd, log, prefer: opts.agentId })
  const adapter = createAdapter(agent.adapter, { config: defaultConfig(), cwd, log })
  const probe = await adapter.probe()
  if (!probe.ok) throw new Error(`${agent.adapter} 不可用：${probe.reason}`)

  let session = agent.session
  if (opts.session) session = { ...(session ?? {}), id: opts.session }
  if (!session) session = await adapter.resolveSession('latest')
  if (!session) throw new Error('找不到要盯的 agent 会话')

  const journal = new Journal({ dir: join(cwd, '.cyber'), cwd, reportFile: 'CW-REPORT.md' })
  const pauseFile = join(cwd, '.cyber', 'PAUSE')
  journal.event('start', { mode: 'poke', adapter: agent.adapter, sessionId: session.id ?? null, maxNudges })
  try { mkdirSync(join(cwd, '.cyber'), { recursive: true }) } catch { /* 忽略 */ }

  log.banner('催工模式')
  log.raw(`  盯谁：${agent.adapter}${session.id ? `（会话 ${String(session.id).slice(0, 24)}）` : ''}`)
  log.raw(`  怎么催：它一停下（或在等你）就发一句"继续"；最多催 ${maxNudges} 次`)
  log.raw(`  停止：它写 CW:DONE ／ 连着两轮没变化 ／ 催够次数 ／ 你 Ctrl+C 或建立 .cyber/PAUSE`)
  log.raw('')

  const startedAt = Date.now()
  let nudges = 0
  let stallCount = 0
  let lastAnswerHash = ''
  let lastFingerprint = ''
  let stopReason = 'interrupted'

  for (;;) {
    if (opts.signal?.aborted) { stopReason = 'interrupted'; break }
    if (existsSync(pauseFile)) { stopReason = 'paused'; log.warn('看到 .cyber/PAUSE，停止催工'); break }

    const snapshot = await adapter.readState(session)
    if (snapshot.session?.id && snapshot.session.id !== session.id) session = { ...session, id: snapshot.session.id }

    const answerHash = hash(normalize(snapshot.lastAnswer ?? ''))
    const fingerprint = `${answerHash}:${snapshot.turn ?? ''}:${snapshot.status}`
    if (nudges > 0 && answerHash === lastAnswerHash) stallCount++
    else stallCount = 0
    lastAnswerHash = answerHash
    lastFingerprint = fingerprint

    const decision = decidePoke({
      snapshot,
      nudgesSent: nudges,
      maxNudges,
      stallCount,
      nudgeText: opts.nudge,
      waitingNudgeText: opts.waitingNudge,
    })
    opts.onEvent?.({ type: 'decision', decision, snapshot: { status: snapshot.status, turn: snapshot.turn } })

    if (decision.action === 'stop') { stopReason = decision.reason; break }
    if (decision.action === 'wait') {
      log.debug?.(`${decision.reason}（等 ${peerPollMs}ms）`)
      await sleep(peerPollMs, opts.signal).catch(() => {})
      continue
    }

    // 催它
    nudges++
    const text = decision.text ?? DEFAULT_NUDGE
    log.step(`第 ${nudges} 次催促：${decision.reason}`)
    // "它在等人类"时用 steer（插进当前回合，等价于回答它的问题）；空闲时用 queue（排新回合）
    const isWaiting = snapshot.status === 'awaiting-input' || snapshot.status === 'awaiting-approval'
    if (isWaiting && adapter.id === 'dsh' && (agent.options?.whip === 'http')) {
      adapter.options = { ...(agent.options ?? {}), httpMode: 'steer' }
    }
    const result = await adapter.whip(text, session, { config: { guard: {} }, signal: opts.signal })
    journal.event(result.ok !== false ? 'whip' : 'error', {
      round: nudges, chars: text.length, whip: text,
      detail: result.detail ?? null, mode: result.mode ?? null,
    })
    opts.onEvent?.({ type: 'nudge', n: nudges, text, result })
    if (result.ok === false && result.kind === 'setup') {
      log.error(`催促通道没配好：${result.detail}`)
      stopReason = `setup: ${result.detail}`
      break
    }
    if (result.ok === false) log.warn(`催促可能没送达：${result.detail ?? ''}`)

    // 等下一条回答出现（前台型适配器返回时已经有了）
    if (result.mode !== 'foreground') {
      const before = answerHash
      const waitUntil = Date.now() + Number(opts.waitForReplyMs ?? 10 * 60 * 1000)
      for (;;) {
        await sleep(everyMs, opts.signal).catch(() => {})
        const nextState = await adapter.readState(session)
        const nextHash = hash(normalize(nextState.lastAnswer ?? ''))
        if (nextHash && nextHash !== before) {
          log.ok(`agent 继续干活了：${oneLine(String(nextState.lastAnswer ?? '').slice(-200), 120)}`)
          break
        }
        if (Date.now() > waitUntil) { log.warn('等不到新回答，先继续循环'); break }
        if (opts.signal?.aborted) break
      }
    } else if (result.answer) {
      log.ok(`agent 回复：${oneLine(result.answer.slice(-200), 120)}`)
    }
    lastAnswerHash = hash(normalize(result.answer ?? (await adapter.readState(session)).lastAnswer ?? ''))
  }

  // 收尾小结
  const state = { rounds: [], costUsd: 0, startedAt }
  log.raw('')
  log.banner(stopReason === 'interrupted' ? '停止：你按了 Ctrl+C' : `停止：${stopReason}`)
  log.raw(`  催了 ${nudges} 次，共 ${humanDuration(Date.now() - startedAt)}`)
  journal.event('stop', { reason: stopReason, nudges })
  return { nudges, stopReason, durationMs: Date.now() - startedAt, sessionId: session.id ?? null, state }
}

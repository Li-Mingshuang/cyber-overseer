/**
 * Agent 钩子集成。
 *
 * 目前实现了 **Cursor Hooks**（官方机制）：Cursor 在每个回合结束时（`stop` 事件）会用自己的
 * 进程调用我们配置的命令，并把事件 JSON 从 stdin 递进来；我们把 `{"followup_message": "..."}`
 * 写到 stdout，Cursor 就会**把这段文字当成新的用户消息提交给同一个会话**——于是"抽鞭"这件事
 * 完全发生在 Cursor 自己的事件循环里：不用轮询、不用抢焦点、不用常驻进程，还自带 `loop_limit` 防死循环。
 *
 * 这让 Cursor 成为所有适配器里**最干净**的一条闭环，代价是必须在项目里放一个 `.cursor/hooks.json`。
 *
 * 事件输出字段（官方 cheat sheet，已核对）：
 *   - `stop` / `subagentStop` → `followup_message`
 *   - `afterAgentResponse`    → 无输出字段，但事件里直接带最后一条回答的 `text`（用来喂我们的读取通道）
 *   - `beforeSubmitPrompt`    → `continue` / `user_message`
 *
 * @module cyber-overseer/hooks
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createLogger } from './util/log.mjs'
import { clip, oneLine } from './util/text.mjs'
import { inWindow, isoLocal } from './util/time.mjs'
import { loadPlan, planProgress, planSummary } from './plan.mjs'
import { createJudge } from './judge/index.mjs'
import { collectEvidence } from './engine/evidence.mjs'
import { composeWhip } from './engine/whip.mjs'
import { Journal } from './engine/journal.mjs'
import { loadAdapters, createAdapter } from './adapters/index.mjs'

export const HOOK_EVENTS = {
  cursor: ['stop', 'subagentStop', 'afterAgentResponse', 'beforeSubmitPrompt', 'postToolUse', 'preToolUse'],
}

/**
 * 生成 `.cursor/hooks.json` 的内容。
 * @param {{cwd:string, cliPath:string, nodePath:string, loopLimit?:number, timeout?:number, events?:string[]}} opts
 */
export function cursorHooksConfig(opts) {
  const cli = opts.cliPath
  const node = opts.nodePath ?? process.execPath
  const cwd = opts.cwd
  const entry = (event) => ({
    command: `"${node}" "${cli}" hook cursor-${event === 'afterAgentResponse' ? 'response' : 'stop'} --cwd "${cwd}"`,
    timeout: opts.timeout ?? 60,
    failClosed: false,
    ...(event === 'stop' || event === 'subagentStop' ? { loop_limit: opts.loopLimit ?? 25 } : {}),
  })
  const events = opts.events ?? ['stop', 'afterAgentResponse']
  return {
    version: 1,
    hooks: Object.fromEntries(events.map(event => [event, [entry(event)]])),
  }
}

/**
 * 安装 Cursor 钩子（幂等：已存在就打印差异，`force` 才覆盖）。
 * @param {{cwd:string, cliPath:string, nodePath?:string, force?:boolean, loopLimit?:number, log?:any}} opts
 * @returns {{ok:boolean, path:string, created:boolean, message:string}}
 */
export function installCursorHooks(opts) {
  const log = opts.log ?? createLogger({ level: 'info' })
  const dir = resolve(opts.cwd, '.cursor')
  const file = join(dir, 'hooks.json')
  const config = cursorHooksConfig({ ...opts, cwd: opts.cwd })
  if (existsSync(file) && !opts.force) {
    let existing = null
    try { existing = JSON.parse(readFileSync(file, 'utf8')) } catch { existing = null }
    const same = existing && JSON.stringify(existing) === JSON.stringify(config)
    return {
      ok: false,
      path: file,
      created: false,
      message: same ? '钩子已是最新，无需改动' : `${file} 已存在且内容不同：请人工合并，或用 --force 覆盖`,
    }
  }
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n', 'utf8')
  log.ok?.(`已写入 ${file}`)
  return { ok: true, path: file, created: true, message: `已安装 Cursor 钩子：${file}` }
}

/**
 * 处理一个 agent 钩子事件。
 *
 * 这是"监工大脑"在**别人进程里**运行的形态：Cursor 调我们，我们返回"下一句该说什么"。
 *
 * @param {{agent:'cursor', event:'stop'|'response', payload:any, cwd:string, configPath?:string, log?:any, deps?:any}} opts
 * @returns {Promise<{output:Record<string,any>, verdict?:any, reason:string}>}
 */
export async function handleHook(opts) {
  const log = opts.log ?? createLogger({ level: 'info' })
  const { loadConfig } = await import('./config.mjs')
  const { config, planPath, agentCwd } = await loadConfig({ configPath: opts.configPath ?? null, cwd: opts.cwd, log })
  await loadAdapters()

  const event = opts.event
  const payload = opts.payload ?? {}

  // ---- afterAgentResponse：只是把回答落盘，供 `cw run` / `cw status` 读取 ----
  if (event === 'response') {
    const dir = resolve(opts.cwd, config.journal?.dir ?? '.cyber')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const file = join(dir, 'cursor-events.jsonl')
    writeFileSync(file, `${JSON.stringify({
      at: Date.now(), iso: isoLocal(), conversationId: payload.conversation_id ?? null,
      generationId: payload.generation_id ?? null, model: payload.model ?? null,
      text: payload.text ?? null,
    })}\n`, { flag: 'a' })
    return { output: {}, reason: '已记录 afterAgentResponse' }
  }

  // ---- stop：判定 + 回一句 followup_message（= 抽鞭）----
  if (event !== 'stop') return { output: {}, reason: `未处理的事件：${event}` }

  const plan = loadPlan(planPath)
  const progress = planProgress(plan)
  // 钩子由谁触发不影响"用哪个适配器读会话"：尊重配置里的 adapter（Cursor 场景通常就是 cursor）
  const adapterId = config.agent?.adapter ?? 'cursor'
  const adapter = createAdapter(adapterId, { config, cwd: agentCwd, log })
  const probe = await adapter.probe()
  if (!probe.ok) return { output: {}, reason: `适配器不可用：${probe.reason}` }
  const session = await adapter.resolveSession(
    payload.conversation_id ? { id: payload.conversation_id } : (config.agent?.session ?? 'latest'),
  )
  const snapshot = session ? await adapter.readState(session) : { status: 'unknown', lastAnswer: '' }
  const journal = new Journal({
    dir: resolve(opts.cwd, config.journal?.dir ?? '.cyber'),
    cwd: opts.cwd,
    reportFile: config.journal?.reportFile ?? 'CW-REPORT.md',
  })

  // 护栏：静默期 / 轮次（用 Cursor 给的 loop_count）
  const loopCount = Number(payload.loop_count ?? 0)
  const guard = config.guard ?? {}
  if (guard.quietHours && !inWindow(guard.quietHours)) {
    journal.event('guard', { source: 'cursor-hook', reason: 'outside-quiet-hours' })
    return { output: {}, reason: `不在静默期（${guard.quietHours.from}–${guard.quietHours.to}）内，停止续跑` }
  }
  if (guard.maxRounds > 0 && loopCount >= guard.maxRounds) {
    journal.event('guard', { source: 'cursor-hook', reason: 'max-rounds', loopCount })
    return { output: {}, reason: `已达轮次上限 ${guard.maxRounds}（loop_count=${loopCount}），停止续跑` }
  }

  const evidence = await collectEvidence({
    config: { ...config, evidence: { ...config.evidence, verify: config.evidence?.verify ?? [] } },
    cwd: agentCwd, plan, answer: snapshot.lastAnswer ?? '', log,
  })
  const judge = createJudge(config, { log, deps: opts.deps?.judge })
  const verdict = await judge.judge({
    plan, progress, answer: snapshot.lastAnswer ?? '', lastUserMessage: snapshot.lastUserMessage ?? null,
    evidence, history: [], config, round: loopCount + 1, log,
  })
  journal.event('verdict', { source: 'cursor-hook', round: loopCount + 1, status: verdict.status, reason: verdict.reason, confidence: verdict.confidence })

  if (verdict.status === 'done') {
    journal.writeReport({
      state: { rounds: [], costUsd: verdict.costUsd ?? 0, startedAt: Date.now() },
      config, plan, adapterLabel: 'Cursor (hook)', sessionId: session?.id ?? null,
      stopReason: 'done', verdict,
    })
    return { output: {}, verdict, reason: `判定完成：${oneLine(verdict.reason, 160)}（不再返回 followup_message，循环结束）` }
  }
  if (verdict.status === 'blocked' || verdict.status === 'needs-human') {
    journal.writeReport({
      state: { rounds: [], costUsd: verdict.costUsd ?? 0, startedAt: Date.now() },
      config, plan, adapterLabel: 'Cursor (hook)', sessionId: session?.id ?? null,
      stopReason: verdict.status, verdict,
    })
    return { output: {}, verdict, reason: `判定为 ${verdict.status}：停止续跑并写报告（${oneLine(verdict.reason, 120)}）` }
  }

  const whip = composeWhip({
    verdict, plan, progress, round: loopCount + 1, config,
    verify: evidence.verify, git: evidence.git,
  })
  if (config.runtime?.dryRun) {
    return { output: {}, verdict, reason: `演练模式：本来要回 followup_message（${whip.length} 字）` }
  }
  journal.event('whip', { source: 'cursor-hook', round: loopCount + 1, chars: whip.length, whip })
  return {
    output: { followup_message: whip },
    verdict,
    reason: `已回 followup_message（${whip.length} 字）：${oneLine(verdict.reason, 120)}`,
  }
}

/** 打印钩子事件（调试用：`cw hook cursor-stop --dry-stdin`）。 */
export function describeHookPayload(payload) {
  const keys = Object.keys(payload ?? {})
  return `事件字段：${keys.join(', ')}\n` + clip(JSON.stringify(payload, null, 2), 2000)
}

export { planSummary }

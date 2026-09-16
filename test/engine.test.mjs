/**
 * 引擎与适配器测试：
 *  - 主循环用 fake 适配器跑完整闭环（含"方案文档每轮重读"这个关键行为）
 *  - 护栏（暂停/轮次/静默期）
 *  - DSH 会话折叠、codex/opencode 输出解析、拟人通道的纯函数
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig, mergeConfig } from '../src/config.mjs'
import { runOverseer, checkGuards, EXIT_CODES } from '../src/engine/loop.mjs'
import { summarizeSession } from '../src/adapters/dsh-session.mjs'
import { extractAnswer, resolveComposerPoint, sameMessage } from '../src/adapters/human-sim.mjs'
import { extractFromJsonStream } from '../src/adapters/codex.mjs'
import { extractOpencodeAnswer } from '../src/adapters/opencode.mjs'
import { composeWhip } from '../src/engine/whip.mjs'
import { parsePlan, planProgress } from '../src/plan.mjs'
import { createLogger } from '../src/util/log.mjs'

const quiet = createLogger({ level: 'error', stream: { write() {} }, errStream: { write() {} } })

/** 造一个临时工作区：方案文档 + 配置。 */
function scaffold({ todos = 3, acceptance = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cw-test-'))
  const planFile = join(dir, 'PLAN.md')
  const lines = ['# 测试任务', '', '## 目标', '把测试任务做完。', '']
  if (acceptance) lines.push('## 验收标准', '- 所有产物文件都存在', '')
  lines.push('## 任务清单')
  for (let i = 1; i <= todos; i++) lines.push(`- [ ] 第 ${i} 项`)
  writeFileSync(planFile, lines.join('\n'), 'utf8')
  const config = mergeConfig(defaultConfig(), {
    plan: planFile,
    agent: { adapter: 'fake', cwd: dir, session: 'latest', options: { stateFile: join(dir, '.cyber', 'fake.json') } },
    judge: { kind: 'rule' },
    evidence: { git: false, verify: [] },
    guard: { maxRounds: 20, maxWallClockMs: 60000, maxStallRounds: 5, quietHours: null, cooldownMs: 0 },
    journal: { dir: join(dir, '.cyber'), reportFile: 'CW-REPORT.md', storeAnswers: true },
    notify: { beep: false },
    runtime: { logLevel: 'error', stateFile: join(dir, '.cyber', 'state.json') },
  })
  config.__cwd = dir
  return { dir, planFile, config }
}

/** 假 agent 的一步：勾掉一个复选框（模拟真实 agent 的产出）。 */
function tickCheckbox(planFile) {
  const text = readFileSync(planFile, 'utf8')
  const next = text.replace(/^(\s*[-*+]\s+)\[ \](\s+第 (\d) 项)/m, '$1[x]$2')
  writeFileSync(planFile, next, 'utf8')
  return next !== text
}

test('主循环：fake agent 被一轮轮抽到"全部勾选"→ needs-human（因为没配验收命令）', async () => {
  const { dir, planFile, config } = scaffold({ todos: 2, acceptance: false })
  let step = 0
  config.agent.options.reply = () => {
    step++
    tickCheckbox(planFile)
    return `第 ${step} 步做完了。`
  }
  const result = await runOverseer({
    config, cwd: dir, planPath: planFile, agentCwd: dir, log: quiet,
    deps: { pollIntervalMs: 1, sleep: async () => {} },
  })
  assert.equal(result.stopReason, 'needs-human')
  assert.equal(result.rounds, 3) // 2 轮抽鞭 + 第 3 轮判定发现全勾完但无验收命令
  assert.ok(existsSync(join(dir, 'CW-REPORT.md')), '应写出报告')
  assert.ok(existsSync(join(dir, '.cyber', 'journal.jsonl')), '应写出事件日志')
  rmSync(dir, { recursive: true, force: true })
})

test('主循环：方案文档每轮重读（agent 勾选立刻可见）', async () => {
  const { dir, planFile, config } = scaffold({ todos: 3, acceptance: false })
  const seen = []
  config.agent.options.reply = (step) => {
    tickCheckbox(planFile)
    seen.push(step)
    return `完成第 ${step} 项`
  }
  const result = await runOverseer({
    config, cwd: dir, planPath: planFile, agentCwd: dir, log: quiet,
    deps: { pollIntervalMs: 1, sleep: async () => {} },
  })
  // 3 项 → 3 次抽鞭；如果方案不重读，会一直以为 0/3 而抽满 20 轮
  assert.equal(result.rounds, 4, `轮次应为 4，实际 ${result.rounds}`)
  assert.deepEqual(seen, [1, 2, 3])
  rmSync(dir, { recursive: true, force: true })
})

test('主循环：护栏——轮次上限', async () => {
  const { dir, planFile, config } = scaffold({ todos: 99 })
  config.guard.maxRounds = 2
  config.agent.options.reply = () => '我什么都没干。'
  const result = await runOverseer({
    config, cwd: dir, planPath: planFile, agentCwd: dir, log: quiet,
    deps: { pollIntervalMs: 1, sleep: async () => {} },
  })
  assert.equal(result.stopReason, 'max-rounds')
  assert.equal(result.exitCode, EXIT_CODES['max-rounds'])
  rmSync(dir, { recursive: true, force: true })
})

test('主循环：护栏——暂停哨兵文件', async () => {
  const { dir, planFile, config } = scaffold()
  mkdirSync(join(dir, '.cyber'), { recursive: true })
  writeFileSync(join(dir, '.cyber', 'PAUSE'), 'paused\n', 'utf8')
  const result = await runOverseer({
    config, cwd: dir, planPath: planFile, agentCwd: dir, log: quiet,
    deps: { pollIntervalMs: 1, sleep: async () => {} },
  })
  assert.equal(result.stopReason, 'paused')
  rmSync(dir, { recursive: true, force: true })
})

test('主循环：连续无进展 → stalled', async () => {
  const { dir, planFile, config } = scaffold({ todos: 5 })
  config.guard.maxStallRounds = 2
  config.agent.options.reply = () => '一样的回答。'
  const result = await runOverseer({
    config, cwd: dir, planPath: planFile, agentCwd: dir, log: quiet,
    deps: { pollIntervalMs: 1, sleep: async () => {} },
  })
  assert.equal(result.stopReason, 'stalled')
  rmSync(dir, { recursive: true, force: true })
})

test('主循环：演练模式（dryRun）只打印不注入', async () => {
  const { dir, planFile, config } = scaffold({ todos: 2 })
  config.runtime.dryRun = true
  let whips = 0
  config.agent.options.reply = () => { whips++; return '假装干了' }
  const result = await runOverseer({
    config, cwd: dir, planPath: planFile, agentCwd: dir, log: quiet,
    deps: { pollIntervalMs: 1, sleep: async () => {} },
  })
  assert.equal(result.stopReason, 'dry-run-complete')
  assert.equal(whips, 0)
  rmSync(dir, { recursive: true, force: true })
})

test('护栏函数：静默期返回等待而不是停止', () => {
  const { dir, planFile, config } = scaffold()
  config.guard.quietHours = { from: '00:00', to: '23:59' }
  const now = new Date()
  // 让"当前时间"落在窗口外：窗口是从现在往后 1 分钟
  const from = new Date(now.getTime() + 60000)
  config.guard.quietHours = {
    from: `${String(from.getHours()).padStart(2, '0')}:${String(from.getMinutes()).padStart(2, '0')}`,
    to: `${String((from.getHours() + 1) % 24).padStart(2, '0')}:00`,
  }
  const guard = checkGuards({
    config, plan: parsePlan(readFileSync(planFile, 'utf8')), progress: planProgress(parsePlan(readFileSync(planFile, 'utf8'))),
    store: { state: { startedAt: Date.now(), roundsStarted: 0, costUsd: 0 } },
    pauseFile: join(dir, '.cyber', 'PAUSE'),
  })
  if (!guard.stop) assert.ok(guard.waitMs > 0 || guard.reason)
  rmSync(dir, { recursive: true, force: true })
})

test('DSH 会话折叠：忙/闲、最后一次回答要跳过只有 tool-call 的消息', () => {
  const records = [
    // 头行的字段是**顶层**的（真实 DSH 文件如此：{"type":"session","id":…,"cwd":…}），不在 data 里
    { type: 'session', seq: 0, time: 1, id: 'session-x', cwd: 'C:\\w', createdAt: 1 },
    { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: 3, data: { content: [{ type: 'text', text: '干活' }], id: 'u1' } },
    { type: 'assistant/message', seq: 3, time: 4, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '我先看看' }] } } },
    // 关键陷阱：最后一条 assistant/message 可能只有 tool-call，没有文本
    { type: 'assistant/message', seq: 4, time: 5, data: { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'tool-call', name: 'pwsh', id: 'c1' }] } } },
  ]
  const busy = summarizeSession(records)
  assert.equal(busy.status, 'working', '最后一个边界是 turn/start → 还在跑')
  assert.equal(busy.lastAnswer, '我先看看', '要回退找到真正有文本的那条')
  assert.equal(busy.sessionId, 'session-x')
  assert.equal(busy.cwd, 'C:\\w')

  const finished = summarizeSession([...records, { type: 'turn/end', seq: 5, time: 6, data: { turn: 1, reason: { kind: 'completed' } } }])
  assert.equal(finished.status, 'idle')
  assert.equal(finished.turn.open, false)

  const errored = summarizeSession([...records, { type: 'turn/end', seq: 5, time: 6, data: { turn: 1, reason: { kind: 'error', error: { code: 'x', message: 'boom' } } } }])
  assert.equal(errored.status, 'error')
})

test('DSH 会话折叠：审批中与等人类回答', () => {
  const base = [
    { type: 'session', seq: 0, time: 1, data: { id: 's', cwd: 'C:\\w' } },
    { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } },
  ]
  const approving = summarizeSession([...base, { type: 'approval/asked', seq: 2, time: 3, data: { id: 'a1', tool: 'pwsh' } }])
  assert.equal(approving.status, 'awaiting-approval')
  assert.equal(approving.pendingApprovals.length, 1)

  const decided = summarizeSession([
    ...base,
    { type: 'approval/asked', seq: 2, time: 3, data: { id: 'a1' } },
    { type: 'approval/decided', seq: 3, time: 4, data: { id: 'a1' } },
  ])
  assert.equal(decided.pendingApprovals.length, 0)
  assert.equal(decided.status, 'working')

  const asking = summarizeSession([...base, { type: 'tool/call', seq: 2, time: 3, data: { callId: 'c9', name: 'ask_user_question', arguments: '{}' } }])
  assert.equal(asking.status, 'awaiting-input')
})

test('拟人通道纯函数：用"我们刚打进去的鞭子"切出回答', () => {
  const whip = '[赛博监工] 还没到收工的时候。把第 2 项做完。CW-RECEIPT: ...'
  const dialog = [
    '你', '把第 1 项做完', 'AI', '第 1 项做完了。',
    '你', whip, 'AI', '好的，第 2 项也做完了，产物在 artifacts/step2.txt。',
  ].join('\n')
  const answer = extractAnswer(dialog, whip, {})
  assert.match(answer, /第 2 项也做完了/)
  assert.doesNotMatch(answer, /第 1 项做完了/)

  // 没有鞭子记录时退化为尾巴
  const tailAnswer = extractAnswer(dialog, '', { answerTailChars: 20 })
  assert.ok(tailAnswer.length <= 20)

  assert.equal(sameMessage('a  b\nc', 'a b c'), true)
  assert.equal(sameMessage('完全不同的内容啊', '另一个内容'), false)

  const point = resolveComposerPoint({ rect: [100, 50], width: 1000, height: 500 }, {})
  assert.deepEqual(point, { x: 600, y: 520 })
  const absolute = resolveComposerPoint({ rect: [0, 0], width: 10, height: 10 }, { x: 7, y: 9 })
  assert.deepEqual(absolute, { x: 7, y: 9 })
})

test('codex / opencode 输出解析', () => {
  const codexOut = [
    '{"type":"event_msg","payload":{"type":"task_started"}}',
    '{"type":"event_msg","payload":{"type":"agent_message","message":"先跑测试"}}',
    '{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"全部通过"}}',
  ].join('\n')
  assert.equal(extractFromJsonStream(codexOut), '全部通过')

  const opencodeOut = [
    '{"type":"message","role":"assistant","parts":[{"type":"text","text":"第一版"}]}',
    '{"type":"message","role":"assistant","parts":[{"type":"text","text":"第二版"}]}',
  ].join('\n')
  assert.equal(extractOpencodeAnswer(opencodeOut), '第二版')
})

test('鞭子组装：包含剩余项、安全约束与回执要求，且受长度限制', () => {
  const plan = parsePlan('# T\n- [ ] 甲\n- [ ] 乙\n- [ ] 丙\n')
  const text = composeWhip({
    verdict: { status: 'continue', reason: '还有 3 项', nextPrompt: '先把甲做完，跑通 npm test。' },
    plan, progress: planProgress(plan), round: 2,
    config: { whip: { style: 'strict', maxChars: 1800, requireReceipt: true, prefix: '[赛博监工]' } },
    verify: [{ command: 'npm test', ok: false, code: 1 }],
    git: { available: true, diffStat: 'a.js | 2 +-' },
  })
  assert.match(text, /\[赛博监工\]/)
  assert.match(text, /先把甲做完/)
  assert.match(text, /npm test\(码 1\)/)
  assert.match(text, /CW-RECEIPT/)
  assert.match(text, /破坏性操作/)
  assert.ok(text.length <= 1800)
})

test('退出码表覆盖所有停止原因', () => {
  for (const reason of ['done', 'max-rounds', 'max-wall-clock', 'max-cost', 'stalled', 'blocked', 'needs-human', 'paused', 'error', 'aborted', 'agent-gone']) {
    assert.equal(typeof EXIT_CODES[reason], 'number', `${reason} 缺少退出码`)
  }
})

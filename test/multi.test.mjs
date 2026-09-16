/**
 * 多 agent 并行监工测试。
 *
 * 全部离线：用 fake 适配器 + 注入的假 run（验收命令不真的执行），
 * 所以既不需要 agent 也不需要网络。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig, mergeConfig, validateAgents } from '../src/config.mjs'
import { SharedBudget, createBudget } from '../src/engine/budget.mjs'
import { aggregateExitCode, prepareAgentEntries, runMultiAgent } from '../src/engine/multi.mjs'
import { EXIT_CODES } from '../src/engine/loop.mjs'
import { createLogger } from '../src/util/log.mjs'

const quiet = createLogger({ level: 'error', stream: { write() {} }, errStream: { write() {} } })

/** 验收命令不真的跑：git 命令报"不是仓库"，其它命令一律成功。 */
const fakeRun = async (command) => (command === 'git'
  ? { code: 1, stdout: '', stderr: '', timedOut: false, durationMs: 0, aborted: false }
  : { code: 0, stdout: 'ok', stderr: '', timedOut: false, durationMs: 0, aborted: false })

function writePlan(file, todos) {
  const lines = ['# 测试任务', '', '## 目标', '把测试任务做完。', '', '## 验收标准', '`echo ok` 返回 0', '', '## 任务清单']
  for (let i = 1; i <= todos; i++) lines.push(`- [ ] 第 ${i} 项`)
  writeFileSync(file, lines.join('\n'), 'utf8')
}

/** 每勾一项就真的改方案文档（模拟真实 agent 的产出）。 */
function ticker(planFile) {
  return (step) => {
    const text = readFileSync(planFile, 'utf8')
    const next = text.replace(/^(\s*[-*+]\s+)\[ \](\s+第 (\d+) 项)/m, '$1[x]$2')
    writeFileSync(planFile, next, 'utf8')
    return `第 ${step} 步完成（plan 已更新：${next !== text}）`
  }
}

function workspace({ todosA = 2, todosB = 1, planB = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cw-multi-'))
  const dirA = join(root, 'a')
  const dirB = join(root, 'b')
  mkdirSync(dirA, { recursive: true })
  mkdirSync(dirB, { recursive: true })
  const planA = join(dirA, 'PLAN.md')
  writePlan(planA, todosA)
  const planBPath = join(dirB, planB ? 'PLAN.md' : 'MISSING.md')
  if (planB) writePlan(planBPath, todosB)
  return { root, dirA, dirB, planA, planB: planBPath }
}

function multiConfig({ root, dirA, dirB, planB, todosA = 2, guards = {}, agentB = {} }) {
  const config = mergeConfig(defaultConfig(), {
    plan: join(dirA, 'PLAN.md'),
    agents: [
      {
        name: 'front', adapter: 'fake', cwd: dirA, plan: 'PLAN.md',
        options: { stateFile: join(root, '.cyber', 'fake-front.json'), reply: ticker(join(dirA, 'PLAN.md')) },
      },
      {
        name: 'back', adapter: 'fake', cwd: dirB, plan: 'PLAN.md',
        options: { stateFile: join(root, '.cyber', 'fake-back.json'), reply: ticker(planB) },
        ...agentB,
      },
    ],
    judge: { kind: 'rule' },
    evidence: { git: false, verify: ['echo ok'] },
    guard: { maxRounds: 10, maxWallClockMs: 60000, maxStallRounds: 20, maxBlockedRounds: 20, quietHours: null, cooldownMs: 0, ...guards },
    journal: { dir: join(root, '.cyber'), reportFile: 'CW-REPORT.md', storeAnswers: true },
    notify: { beep: false, toast: false },
    runtime: { logLevel: 'error', exitOnDone: true },
  })
  config.__cwd = root
  return config
}

test('共享预算：纯逻辑（轮次/花费/上限顺序）', () => {
  const budget = createBudget({ maxRounds: 2, maxWallClockMs: 1000, maxCostUsd: 0.5 }, { startedAt: 0 })
  assert.equal(budget.check(0), null)
  budget.noteRound('a')
  budget.noteRound('b')
  budget.noteRound('b')
  assert.equal(budget.check(0).reason, 'max-rounds', '轮次上限优先于花费')

  const fresh = createBudget({ maxRounds: 10, maxWallClockMs: 1000, maxCostUsd: 0.5 }, { startedAt: 0 })
  assert.equal(fresh.check(1000).reason, 'max-wall-clock', '时长上限最先判')
  fresh.addCost(0.25, 'a')
  fresh.addCost(0.25, 'b')
  assert.equal(fresh.costUsd, 0.5)
  assert.equal(fresh.check(0).reason, 'max-cost')
  assert.equal(fresh.rounds, 0)
  assert.deepEqual(fresh.costByAgent, { a: 0.25, b: 0.25 })

  // 不设上限 = 永不拦
  const unlimited = new SharedBudget({})
  assert.equal(unlimited.check(Date.now() + 10 ** 9), null)
})

test('agents 配置校验：重名/未知适配器/非数组都给警告', () => {
  const warnings = validateAgents({ agents: [{ name: 'x', adapter: 'nope' }, { name: 'x' }], agent: { adapter: 'fake' }, judge: { kind: 'rule' }, guard: {} })
  assert.ok(warnings.some(w => w.includes('重名')), warnings.join('\n'))
  assert.ok(warnings.some(w => w.includes('未知')), warnings.join('\n'))
  assert.ok(warnings.some(w => w.includes('共享同一套护栏预算')), warnings.join('\n'))

  const broken = { agents: 'not-an-array' }
  const w2 = validateAgents(broken)
  assert.deepEqual(broken.agents, [])
  assert.ok(w2.some(w => w.includes('必须是数组')))
})

test('prepareAgentEntries：简写折叠、名字去重、目录/报告/状态各自独立', () => {
  const root = mkdtempSync(join(tmpdir(), 'cw-multi-prep-'))
  mkdirSync(join(root, 'sub'), { recursive: true })
  const config = mergeConfig(defaultConfig(), {
    agents: [
      { name: 'dup', adapter: 'fake', cwd: 'sub', plan: 'P1.md', options: { a: 1 } },
      { name: 'dup', adapter: 'fake' },
      { agent: { adapter: 'fake', options: { b: 2 } } },
    ],
    journal: { dir: '.cyber', reportFile: 'CW-REPORT.md' },
    agent: { adapter: 'dsh' },
  })
  const entries = prepareAgentEntries(config, root)
  assert.equal(entries.length, 3)
  assert.deepEqual(entries.map(e => e.name), ['dup', 'dup-2', 'agent-3'])
  assert.equal(entries[0].agentCwd, join(root, 'sub'), 'cwd 相对主目录解析')
  assert.equal(entries[1].agentCwd, root)
  assert.equal(entries[0].planPath, join(root, 'sub', 'P1.md'))
  assert.equal(entries[0].config.agent.adapter, 'fake')
  assert.deepEqual(entries[0].config.agent.options, { a: 1 })
  assert.equal(entries[2].config.agent.adapter, 'fake', '完整 agent 写法生效')
  assert.equal(entries[2].config.agent.options.b, 2)

  const dirs = new Set(entries.map(e => e.config.journal.dir))
  assert.equal(dirs.size, 3, '每个 agent 有自己的日志目录')
  const reports = new Set(entries.map(e => e.config.journal.reportFile))
  assert.equal(reports.size, 3, '每个 agent 有自己的分项报告')
  assert.ok(!reports.has(join(root, 'CW-REPORT.md')), '分项报告不能覆盖合并报告')
  assert.equal(entries[0].config.agents.length, 0, '子配置里不能带 agents（否则会递归）')
  rmSync(root, { recursive: true, force: true })
})

test('并行监工：两个 agent 都干完 → 退出码 0 + 合并报告 + 分项报告', async () => {
  const ws = workspace({ todosA: 2, todosB: 1 })
  const config = multiConfig({ root: ws.root, dirA: ws.dirA, dirB: ws.dirB, planB: ws.planB })
  const result = await runMultiAgent({
    config, cwd: ws.root, log: quiet,
    deps: { pollIntervalMs: 1, sleep: async () => {}, run: fakeRun },
  })

  assert.equal(result.exitCode, 0, JSON.stringify(result.results.map(r => [r.agentName, r.stopReason, r.error])))
  assert.equal(result.stopReason, 'done')
  assert.deepEqual(result.results.map(r => r.agentName).sort(), ['back', 'front'])
  assert.ok(result.results.every(r => r.stopReason === 'done'))
  assert.equal(result.rounds, 5, 'front 2 项（2 抽 + 1 收工判定）+ back 1 项（1 抽 + 1 收工判定）')

  assert.ok(existsSync(result.mergedReportPath), '应有合并报告')
  const merged = readFileSync(result.mergedReportPath, 'utf8')
  assert.match(merged, /多 agent 并行/)
  assert.match(merged, /front/)
  assert.match(merged, /back/)
  assert.match(merged, /预算用在哪/)

  for (const r of result.results) {
    assert.ok(existsSync(r.reportPath), `${r.agentName} 应有分项报告`)
    assert.ok(existsSync(join(ws.root, '.cyber', 'agents', r.agentName, 'state.json')), `${r.agentName} 应有独立状态文件`)
    assert.ok(existsSync(join(ws.root, '.cyber', 'agents', r.agentName, 'journal.jsonl')), `${r.agentName} 应有独立事件日志`)
  }
  const frontReport = readFileSync(result.results.find(r => r.agentName === 'front').reportPath, 'utf8')
  assert.match(frontReport, /赛博监工报告/)
  rmSync(ws.root, { recursive: true, force: true })
})

test('并行监工：轮次上限是共享的（总轮次不会超支到 N 倍）', async () => {
  const ws = workspace({ todosA: 99, todosB: 99 })
  const config = multiConfig({
    root: ws.root, dirA: ws.dirA, dirB: ws.dirB, planB: ws.planB,
    guards: { maxRounds: 3, maxStallRounds: 99, maxBlockedRounds: 99 },
  })
  // 每轮回答都不同（避免触发"无进展"熔断），但方案一直不勾选
  for (const entry of config.agents) {
    let n = 0
    entry.options.reply = () => { n++; return `第 ${n} 次：我什么也没干。` }
  }
  const result = await runMultiAgent({
    config, cwd: ws.root, log: quiet,
    deps: { pollIntervalMs: 1, sleep: async () => {}, run: fakeRun },
  })
  assert.ok(result.results.every(r => r.stopReason === 'max-rounds'), JSON.stringify(result.results.map(r => r.stopReason)))
  assert.ok(result.rounds <= 4, `共享预算下总轮次应 <= 4（3 + 并发各多算 1），实际 ${result.rounds}`)
  assert.equal(result.exitCode, EXIT_CODES['max-rounds'])
  assert.equal(result.budget.rounds, result.rounds)
  assert.ok(Object.keys(result.budget.roundsByAgent).length >= 1)
  rmSync(ws.root, { recursive: true, force: true })
})

test('并行监工：一个 agent 挂了不影响另一个（错误被隔离并写进报告）', async () => {
  const ws = workspace({ todosA: 1, planB: false })
  const config = multiConfig({ root: ws.root, dirA: ws.dirA, dirB: ws.dirB, planB: ws.planB })
  const result = await runMultiAgent({
    config, cwd: ws.root, log: quiet,
    deps: { pollIntervalMs: 1, sleep: async () => {}, run: fakeRun },
  })
  const front = result.results.find(r => r.agentName === 'front')
  const back = result.results.find(r => r.agentName === 'back')
  assert.equal(front.stopReason, 'done', 'front 应该正常干完')
  assert.equal(back.ok, false, 'back 的方案文档不存在 → 记成错误')
  assert.equal(back.stopReason, 'error')
  assert.match(String(back.error), /读不到方案文档/)

  const merged = readFileSync(result.mergedReportPath, 'utf8')
  assert.match(merged, /## 出错的 agent/)
  assert.match(merged, /back/)
  assert.equal(result.exitCode, 1)
  assert.equal(result.stopReason, 'multi-incomplete')
  rmSync(ws.root, { recursive: true, force: true })
})

test('aggregateExitCode：全完成才是 0；否则取最严重的', () => {
  assert.equal(aggregateExitCode([]), 1)
  assert.equal(aggregateExitCode([{ stopReason: 'done', exitCode: 0 }, { stopReason: 'dry-run-complete', exitCode: 0 }]), 0)
  assert.equal(aggregateExitCode([
    { stopReason: 'done', exitCode: 0 },
    { stopReason: 'needs-human', exitCode: 15 },
    { stopReason: 'max-rounds', exitCode: 10 },
  ]), 15)
})

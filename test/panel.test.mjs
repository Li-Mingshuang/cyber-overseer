/**
 * `cw status --watch` 的实时面板测试。
 *
 * 面板的核心是纯函数（`renderPanel`），所以可以在没有 TTY、没有 agent 的情况下钉死；
 * 另外用 fake 适配器真跑一次闭环，验证"从状态文件/事件日志里能把关键信息捞出来"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig, mergeConfig } from '../src/config.mjs'
import { runOverseer } from '../src/engine/loop.mjs'
import {
  discoverAgentStates, formatAge, panelSources, renderPanel, watchStatus, windowStatus,
} from '../src/engine/panel.mjs'
import { createLogger } from '../src/util/log.mjs'

const quiet = createLogger({ level: 'error', stream: { write() {} }, errStream: { write() {} } })
const fakeRun = async (command) => (command === 'git'
  ? { code: 1, stdout: '', stderr: '', timedOut: false, durationMs: 0, aborted: false }
  : { code: 0, stdout: 'ok', stderr: '', timedOut: false, durationMs: 0, aborted: false })

test('windowStatus：不限 / 进行中 / 还有多久', () => {
  assert.match(windowStatus({}).label, /不限/)

  const inQuiet = windowStatus({ quietHours: { from: '00:00', to: '23:59' } }, new Date('2026-01-01T12:00:00'))
  assert.equal(inQuiet.kind, 'quiet')
  assert.equal(inQuiet.inside, true)
  assert.match(inQuiet.label, /进行中/)

  const beforeWindow = windowStatus({ quietHours: { from: '23:00', to: '08:00' } }, new Date('2026-01-01T22:00:00'))
  assert.equal(beforeWindow.inside, false)
  assert.equal(beforeWindow.waitMs, 60 * 60 * 1000)
  assert.match(beforeWindow.label, /1小时/)
})

test('formatAge：秒/分/小时/天', () => {
  assert.equal(formatAge(1000), '刚刚')
  assert.equal(formatAge(30_000), '30 秒前')
  assert.equal(formatAge(5 * 60_000), '5 分钟前')
  assert.equal(formatAge(3 * 3600_000), '3 小时前')
  assert.equal(formatAge(50 * 3600_000), '2 天前')
  assert.equal(formatAge(Number.NaN), '?')
})

test('renderPanel：纯渲染（含状态/方案/验收/鞭子），color=false 时无 ANSI', () => {
  const sources = [{
    name: 'front', file: 'x', journalFile: 'y', planPath: 'p', exists: true,
    status: 'running', stopReason: null, adapter: 'cursor', sessionId: 'sess-1',
    rounds: 7, costUsd: 0.1234, startedAt: Date.now() - 600000, updatedAt: Date.now() - 3000,
    lastVerdict: { status: 'continue', reason: '方案还剩 2 项未完成' },
    lastWhip: { text: '[赛博监工] 还没到收工的时候。', at: Date.now(), ok: true },
    verify: [{ command: 'npm test', ok: false, code: 1 }, { command: 'lint', ok: true, cached: true }],
    plan: { path: 'p', done: 3, total: 5, remaining: 2, error: null },
  }]
  const text = renderPanel(sources, { now: Date.now(), color: false, cwd: 'C:\\proj', guard: {}, paused: false })
  assert.match(text, /实时面板/)
  assert.match(text, /front/)
  assert.match(text, /正在跑（第 7 轮）/)
  assert.match(text, /\$0\.1234/)
  assert.match(text, /方案 3\/5 已勾选，剩 2 项/)
  assert.match(text, /最近判定：continue — 方案还剩 2 项未完成/)
  assert.match(text, /最近鞭子：\[赛博监工\]/)
  assert.match(text, /✖ npm test（码 1）/)
  assert.match(text, /✔ lint（复用）/)
  assert.match(text, /最近|刚刚/)
  assert.ok(!/\u001B\[/.test(text), 'color=false 不应有 ANSI 转义')

  const colored = renderPanel(sources, { now: Date.now(), color: true, guard: {}, paused: true })
  assert.ok(/\u001B\[/.test(colored), 'color=true 应有 ANSI 转义')
  assert.match(colored, /已暂停/)
})

test('renderPanel：没有状态文件时给出"先跑一次"的提示；读不到方案会明说', () => {
  const empty = renderPanel([{ name: 'main', exists: false, status: 'idle', rounds: 0, costUsd: 0, adapter: 'dsh', verify: [], plan: { done: 0, total: 0, remaining: 0 } }], { color: false })
  assert.match(empty, /还没有跑过监工/)

  const brokenPlan = renderPanel([{
    name: 'main', exists: true, status: 'error', adapter: 'fake', rounds: 1, costUsd: 0,
    verify: [], plan: { error: '读不到方案文档 PLAN.md' }, lastVerdict: null, lastWhip: null,
  }], { color: false, guard: {} })
  assert.match(brokenPlan, /方案读不到/)
})

test('panelSources + renderPanel：从真实跑完的状态文件/事件日志里捞信息', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-panel-'))
  const planFile = join(dir, 'PLAN.md')
  writeFileSync(planFile, ['# T', '', '## 目标', '做完。', '', '## 验收标准', '`echo ok` 通过', '', '## 任务清单', '- [ ] 甲'].join('\n'), 'utf8')
  const config = mergeConfig(defaultConfig(), {
    plan: planFile,
    agent: { adapter: 'fake', cwd: dir, session: 'latest', options: { stateFile: join(dir, '.cyber', 'fake.json') } },
    judge: { kind: 'rule' },
    evidence: { git: false, verify: ['echo ok'] },
    guard: { maxRounds: 6, maxWallClockMs: 60000, maxStallRounds: 10, quietHours: null, cooldownMs: 0 },
    journal: { dir: join(dir, '.cyber'), reportFile: 'CW-REPORT.md', storeAnswers: false },
    notify: { beep: false, toast: false },
    runtime: { logLevel: 'error', stateFile: join(dir, '.cyber', 'state.json') },
  })
  config.__cwd = dir
  config.agent.options.reply = () => {
    writeFileSync(planFile, readFileSync(planFile, 'utf8').replace('- [ ] 甲', '- [x] 甲'), 'utf8')
    return '甲做完了。'
  }
  const run = await runOverseer({
    config, cwd: dir, planPath: planFile, agentCwd: dir, log: quiet,
    deps: { pollIntervalMs: 1, sleep: async () => {}, run: fakeRun },
  })
  assert.equal(run.stopReason, 'done')

  const sources = panelSources({ cwd: dir, config })
  assert.equal(sources.length, 1)
  assert.equal(sources[0].name, 'main')
  assert.equal(sources[0].exists, true)
  assert.equal(sources[0].status, 'done')
  assert.equal(sources[0].rounds, 2)
  assert.equal(sources[0].plan.done, 1)
  assert.equal(sources[0].verify.length, 1)
  assert.equal(sources[0].verify[0].ok, true)

  const text = renderPanel(sources, { now: Date.now(), color: false, cwd: dir, guard: config.guard })
  assert.match(text, /✔ 已完成（第 2 轮）/)
  assert.match(text, /方案 1\/1 已勾选/)
  assert.match(text, /✔ echo ok/)
  assert.equal(discoverAgentStates(join(dir, '.cyber', 'agents')).length, 0)
  rmSync(dir, { recursive: true, force: true })
})

test('panelSources：多 agent 时每个条目一行', () => {
  const root = mkdtempSync(join(tmpdir(), 'cw-panel-multi-'))
  mkdirSync(join(root, 'a'), { recursive: true })
  mkdirSync(join(root, 'b'), { recursive: true })
  const config = mergeConfig(defaultConfig(), {
    agents: [
      { name: 'front', adapter: 'fake', cwd: 'a' },
      { name: 'back', adapter: 'fake', cwd: 'b' },
    ],
    journal: { dir: '.cyber' },
  })
  const sources = panelSources({ cwd: root, config })
  assert.equal(sources.length, 3, '顶层 + 两个 agent')
  assert.deepEqual(sources.map(s => s.name), ['(顶层)', 'front', 'back'])
  assert.equal(sources[1].planPath, join(root, 'a', 'PLAN.md'))
  assert.equal(sources[2].planPath, join(root, 'b', 'PLAN.md'))
  const text = renderPanel(sources.filter(s => s.exists || s.name !== '(顶层)'), { color: false, guard: {} })
  assert.match(text, /front/)
  assert.match(text, /back/)
  rmSync(root, { recursive: true, force: true })
})

test('watchStatus：按 maxTicks 刷新（注入 sleep，不真的等）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-panel-watch-'))
  const config = mergeConfig(defaultConfig(), {
    plan: join(dir, 'PLAN.md'),
    journal: { dir: join(dir, '.cyber') },
    runtime: { stateFile: join(dir, '.cyber', 'state.json') },
  })
  writeFileSync(join(dir, 'PLAN.md'), '# T\n\n## 任务清单\n- [ ] 甲\n', 'utf8')
  const chunks = []
  const out = { isTTY: false, write: (s) => chunks.push(s) }
  let sleeps = 0
  const result = await watchStatus({
    cwd: dir, config, out, intervalMs: 1, maxTicks: 3,
    sleepFn: async () => { sleeps++ },
  })
  assert.deepEqual(result, { ticks: 3, interrupted: false })
  assert.equal(sleeps, 2, '最后一轮之后不再 sleep')
  assert.equal(chunks.filter(c => c.includes('实时面板')).length, 3)

  // 已中断的信号 → 刷一次就退出
  const controller = new AbortController()
  controller.abort()
  const aborted = await watchStatus({ cwd: dir, config, out, intervalMs: 1, signal: controller.signal })
  assert.equal(aborted.interrupted, true)
  assert.equal(aborted.ticks, 1)
  rmSync(dir, { recursive: true, force: true })
})

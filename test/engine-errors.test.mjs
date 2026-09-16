/**
 * 失败分类与熔断测试。
 *
 * 这几条是"无人值守会不会误报"的关键：通道没配置好（例如 Cursor 还没装钩子、
 * DSH web 没在跑）应该**停下喊人**并说明怎么配，而不是让主人早上看到一条 "error"；
 * 临时故障则应该再试，而不是立刻放弃整晚的监工。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig, mergeConfig } from '../src/config.mjs'
import { runOverseer } from '../src/engine/loop.mjs'
import { createLogger } from '../src/util/log.mjs'

const quiet = createLogger({ level: 'error', stream: { write() {} }, errStream: { write() {} } })

function scaffold(options = {}, guard = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cw-fail-'))
  const planFile = join(dir, 'PLAN.md')
  writeFileSync(planFile, '# 测试\n## 目标\n做完它。\n## 任务清单\n- [ ] 第一项\n- [ ] 第二项\n', 'utf8')
  const config = mergeConfig(defaultConfig(), {
    plan: planFile,
    agent: { adapter: 'fake', cwd: dir, options: { stateFile: join(dir, '.cyber', 'fake.json'), ...options } },
    judge: { kind: 'rule' },
    evidence: { git: false, verify: [] },
    guard: { maxRounds: 8, maxWallClockMs: 30000, maxStallRounds: 9, quietHours: null, cooldownMs: 0, ...guard },
    journal: { dir: join(dir, '.cyber'), reportFile: 'CW-REPORT.md' },
    notify: { beep: false, toast: false },
    runtime: { logLevel: 'error', stateFile: join(dir, '.cyber', 'state.json') },
  })
  config.__cwd = dir
  return { dir, planFile, config }
}

test('抽鞭失败 kind=setup → 停下喊人（needs-human），而不是报 error', async () => {
  const { dir, planFile, config } = scaffold({ failWith: { kind: 'setup', detail: '请先安装钩子' } })
  const result = await runOverseer({
    config, cwd: dir, planPath: planFile, agentCwd: dir, log: quiet,
    deps: { pollIntervalMs: 1, sleep: async () => {} },
  })
  assert.equal(result.stopReason, 'needs-human')
  assert.equal(result.exitCode, 15)
  assert.match(String(result.error ?? ''), /请先安装钩子/)
  rmSync(dir, { recursive: true, force: true })
})

test('抽鞭失败 kind=fatal → 报 error（真正的错误）', async () => {
  const { dir, planFile, config } = scaffold({ failWith: { kind: 'fatal', detail: '进程崩了' } })
  const result = await runOverseer({
    config, cwd: dir, planPath: planFile, agentCwd: dir, log: quiet,
    deps: { pollIntervalMs: 1, sleep: async () => {} },
  })
  assert.equal(result.stopReason, 'error')
  assert.equal(result.exitCode, 1)
  rmSync(dir, { recursive: true, force: true })
})

test('抽鞭失败 kind=transient → 再试，成功后照常推进', async () => {
  const { dir, planFile, config } = scaffold({
    failWith: { kind: 'transient', detail: '窗口暂时不在', times: 2 },
    reply: (step) => `第 ${step} 步完成`,
  })
  const result = await runOverseer({
    config, cwd: dir, planPath: planFile, agentCwd: dir, log: quiet,
    deps: { pollIntervalMs: 1, sleep: async () => {} },
  })
  // 两次临时失败之后成功抽鞭，所以最终不是因为失败而停：要么推进到上限，要么到无进展
  assert.notEqual(result.stopReason, 'error')
  assert.ok(result.rounds >= 2, `应记录多轮，实际 ${result.rounds}`)
  rmSync(dir, { recursive: true, force: true })
})

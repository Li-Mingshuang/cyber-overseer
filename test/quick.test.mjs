/**
 * 「一句话起步」的测试：验收命令嗅探、方案生成、以及"方案里的标记说明不算宣告"这条安全约束。
 *
 * 这些函数是零配置体验的地基：猜错了验收命令 → 判定就没有硬证据；生成的方案里出现字面标记 →
 * 监工可能凭空判定"已完成/受阻"（真实踩到过的 bug，这里钉死）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildQuickPlan, detectVerifyCommands, prepareQuickRun } from '../src/quick.mjs'
import { parsePlan } from '../src/plan.mjs'
import { createLogger } from '../src/util/log.mjs'

const quiet = createLogger({ level: 'error', stream: { write() {} }, errStream: { write() {} } })

function project(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cw-quick-'))
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }
  return dir
}

test('验收命令嗅探：package.json（测试优先，跳过占位脚本）', (t) => {
  const dir = project({
    'package.json': JSON.stringify({ scripts: { test: 'node --test', lint: 'eslint .', build: 'tsc' } }),
  })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const found = detectVerifyCommands(dir)
  assert.deepEqual(found.commands, ['npm run test', 'npm run lint'])
  assert.ok(found.evidence.includes('package.json'))
})

test('验收命令嗅探：占位脚本不算（no test specified）', (t) => {
  const dir = project({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.deepEqual(detectVerifyCommands(dir).commands, [])
})

test('验收命令嗅探：其他技术栈', (t) => {
  const py = project({ 'pyproject.toml': '[project]\nname="x"\n' })
  const rs = project({ 'Cargo.toml': '[package]\nname="x"\n' })
  const go = project({ 'go.mod': 'module x\n' })
  const make = project({ 'Makefile': 'test:\n\techo ok\n' })
  const verify = project({ 'verify.mjs': 'process.exit(0)\n' })
  const empty = project({})
  t.after(() => {
    for (const dir of [py, rs, go, make, verify, empty]) rmSync(dir, { recursive: true, force: true })
  })
  assert.deepEqual(detectVerifyCommands(py).commands, ['python -m pytest -q'])
  assert.deepEqual(detectVerifyCommands(rs).commands, ['cargo test'])
  assert.deepEqual(detectVerifyCommands(go).commands, ['go test ./...'])
  assert.deepEqual(detectVerifyCommands(make).commands, ['make test'])
  assert.deepEqual(detectVerifyCommands(verify).commands, ['node verify.mjs'])
  assert.deepEqual(detectVerifyCommands(empty).commands, [])
})

test('生成的方案：目标是那句话、验收标准是命令、且**不含标记字面形式**', () => {
  const text = buildQuickPlan({
    sentence: '把 artifacts 下那四份产物做完',
    verify: ['node verify.mjs', 'npm run lint'],
    agentLabel: 'dsh',
  })
  const plan = parsePlan(text)
  assert.match(plan.objective, /四份产物/)
  assert.equal(plan.acceptance.length, 3)   // 两条命令 + 一条"由 xx 完成"
  // 关键安全约束：方案里不能出现 `<!-- CW:… -->` 这种字面标记，
  // 否则监工读方案就会把它当成 agent 的宣告（历史 bug）
  assert.doesNotMatch(text, /<!--\s*CW:/i)
  assert.equal(plan.explicit.done, false)
  assert.equal(plan.explicit.blocked, false)
  assert.equal(plan.totalCount, 0)
})

test('prepareQuickRun：写出方案与配置，且判定策略是零配置模式', async (t) => {
  const dir = project({ 'package.json': JSON.stringify({ scripts: { test: 'node -e "0"' } }) })
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const prepared = await prepareQuickRun({
    sentence: '把首页样式改成深色',
    cwd: dir,
    log: quiet,
    preferAgent: 'fake',
    maxRounds: 5,
  })

  assert.ok(existsSync(prepared.planPath), '方案应写到 .cyber/PLAN.md')
  assert.match(prepared.planPath, /\.cyber[\\/]PLAN\.md$/)
  assert.ok(existsSync(prepared.configFile), '应落一份可复现的配置')
  const onDisk = JSON.parse(readFileSync(prepared.configFile, 'utf8'))
  assert.equal(onDisk.agent.adapter, 'fake')
  assert.deepEqual(onDisk.evidence.verify, ['npm run test'])
  assert.equal(onDisk.guard.maxRounds, 5)
  assert.equal(onDisk.judge.rule.acceptDoneMarker, true)
  assert.equal(onDisk.judge.rule.requireTodosChecked, false)
  assert.equal(prepared.config.__cwd, dir)
  // 报告要落在项目根，日志/状态在 .cyber
  assert.match(String(onDisk.journal.reportFile), /CW-REPORT\.md$/)
  assert.doesNotMatch(readFileSync(prepared.planPath, 'utf8'), /<!--\s*CW:/i)
})

test('prepareQuickRun：拒绝空目标', async () => {
  await assert.rejects(() => prepareQuickRun({ sentence: '   ', cwd: process.cwd(), log: quiet }), /一句话目标/)
})

test('选会话时只认工作目录完全一致的（绝不接管别的项目）', async (t) => {
  const dir = project({ 'package.json': JSON.stringify({ scripts: { test: 'node -e "0"' } }) })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { detectAgent } = await import('../src/quick.mjs')
  const picked = await detectAgent({ cwd: dir, log: quiet, prefer: 'fake' })
  // fake 适配器没有 cwd 概念，这里只断言"不会崩"，真正的同目录匹配逻辑由 dsh 适配器覆盖
  assert.ok(picked.adapter)
  assert.ok(picked.why)
})

/**
 * 证据强化测试：方案文档"合同"防篡改 + 验收命令的历史趋势。
 *
 * 这两条针对的是同一类问题：**"完成"这件事必须由事实支撑，而不是由 agent 的自述支撑**。
 *  - 合同防篡改：agent 可以改方案文档（勾选进度就在里面），但"把验收标准改简单、
 *    把不想做的任务删掉"必须被抓住，并且默认拒绝收工；
 *  - 验收历史：只看最后一次结果是会被骗的（最后一次可能碰巧没跑到），要能看出"从红到绿"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig, mergeConfig } from '../src/config.mjs'
import { planContract, contractHash, diffContracts, describeContractChange, parsePlan, planProgress } from '../src/plan.mjs'
import { ruleJudge } from '../src/judge/rule.mjs'
import { runOverseer } from '../src/engine/loop.mjs'
import { renderVerifyHistory, verifyHistory } from '../src/engine/journal.mjs'
import { createLogger } from '../src/util/log.mjs'

const quiet = createLogger({ level: 'error', stream: { write() {} }, errStream: { write() {} } })
const okRun = async (command) => (command === 'git'
  ? { code: 1, stdout: '', stderr: '', timedOut: false, durationMs: 0, aborted: false }
  : { code: 0, stdout: 'ok', stderr: '', timedOut: false, durationMs: 0, aborted: false })

// ---------------------------------------------------------------------------
// 合同：解析、指纹、差异
// ---------------------------------------------------------------------------

test('planContract / contractHash：只取"合同"三件套，空白与勾选状态不进指纹', () => {
  const plan = parsePlan([
    '# T', '', '## 验收标准', '- `npm test` 全绿', '- 产物在 artifacts/ 下', '',
    '## 禁止 / 范围外', '- 不要改 CI', '', '## 任务清单', '- [ ] 甲', '- [x] 乙', '',
  ].join('\n'))
  const contract = planContract(plan)
  assert.deepEqual(contract.acceptance, ['`npm test` 全绿', '产物在 artifacts/ 下'])
  assert.deepEqual(contract.forbidden, ['不要改 CI'])
  assert.deepEqual(contract.todos, ['甲', '乙'], '勾选状态不进合同（否则勾一项就算"改合同"）')

  const sameButMessy = planContract(parsePlan([
    '# T', '', '## 验收标准', '- `npm test`   全绿', '- 产物在  artifacts/ 下', '',
    '## 禁止 / 范围外', '- 不要改 CI', '', '## 任务清单', '- [x] 甲', '- [ ] 乙', '',
  ].join('\n')))
  assert.equal(contractHash(sameButMessy), contractHash(contract), '空白差异/勾选状态不应改变合同指纹')
})

test('diffContracts：移除=改弱，新增不算改弱，改写按"改弱"处理（保守）', () => {
  const baseline = { acceptance: ['A', 'B'], forbidden: ['不要改 CI'], todos: ['甲', '乙'] }

  const removedAcceptance = diffContracts(baseline, { acceptance: ['A'], forbidden: ['不要改 CI'], todos: ['甲', '乙'] })
  assert.equal(removedAcceptance.weakened, true)
  assert.deepEqual(removedAcceptance.removedAcceptance, ['B'])
  assert.match(describeContractChange(removedAcceptance), /移除验收标准 1 条/)

  const removedTodo = diffContracts(baseline, { acceptance: ['A', 'B'], forbidden: ['不要改 CI'], todos: ['甲'] })
  assert.equal(removedTodo.weakened, true)
  assert.match(describeContractChange(removedTodo), /移除任务 1 项/)

  const removedForbidden = diffContracts(baseline, { acceptance: ['A', 'B'], forbidden: [], todos: ['甲', '乙'] })
  assert.equal(removedForbidden.weakened, true)
  assert.match(describeContractChange(removedForbidden), /移除禁止事项 1 条/)

  const added = diffContracts(baseline, { acceptance: ['A', 'B', 'C'], forbidden: ['不要改 CI'], todos: ['甲', '乙', '丙'] })
  assert.equal(added.changed, true)
  assert.equal(added.weakened, false, '新增要求是好事，不该拦')
  assert.match(describeContractChange(added), /新增验收标准 1 条/)

  const reordered = diffContracts(baseline, { acceptance: ['B', 'A'], forbidden: ['不要改 CI'], todos: ['乙', '甲'] })
  assert.equal(reordered.changed, false, '换个顺序不算改合同')

  const reworded = diffContracts(baseline, { acceptance: ['A 大概能跑就行'], forbidden: ['不要改 CI'], todos: ['甲', '乙'] })
  assert.equal(reworded.weakened, true, '改写监工分不清是不是偷懒，按改弱处理并喊人')

  assert.equal(diffContracts(null, baseline).changed, false, '没有基线时不报变化')
  assert.equal(describeContractChange({ changed: false }), '')
})

// ---------------------------------------------------------------------------
// 规则判定：合同被改弱 → 拒绝收工
// ---------------------------------------------------------------------------

test('规则判定：合同被改弱时拒绝判 done，除非显式允许', () => {
  const plan = parsePlan('# T\n\n## 验收标准\n- A\n- B\n\n## 任务清单\n- [x] 甲\n')
  const evidence = {
    verify: [{ command: 'echo ok', ok: true, code: 0 }],
    answerHash: 'h', fingerprint: 'f',
    planChange: {
      changed: true, weakened: true, removedAcceptance: ['B'], addedAcceptance: [],
      removedTodos: [], addedTodos: [], removedForbidden: [], addedForbidden: [],
      description: '移除验收标准 1 条',
    },
  }
  const input = {
    plan, progress: planProgress(plan), answer: '全做完了', evidence, history: [],
    config: { judge: { rule: {} }, evidence: {} },
  }

  const blocked = ruleJudge(input, {})
  assert.equal(blocked.status, 'needs-human')
  assert.equal(blocked.details.planWeakened, true)
  assert.match(blocked.reason, /被改弱/)

  const allowedByOpts = ruleJudge(input, { allowPlanWeakening: true })
  assert.equal(allowedByOpts.status, 'done', '显式允许后，清单全勾 + 验收通过就可以收工')

  const allowedByConfig = ruleJudge({ ...input, config: { judge: { rule: {} }, evidence: { allowPlanWeakening: true } } }, {})
  assert.equal(allowedByConfig.status, 'done')

  // 没有 planChange（例如 planGuard 关掉）时一切照旧
  const noGuard = ruleJudge({ ...input, evidence: { verify: [{ command: 'x', ok: true, code: 0 }], answerHash: 'h', fingerprint: 'f' } }, {})
  assert.equal(noGuard.status, 'done')
})

// ---------------------------------------------------------------------------
// 验收历史：从红到绿
// ---------------------------------------------------------------------------

test('verifyHistory / renderVerifyHistory：红→绿的过程要能看出来', () => {
  const rounds = [
    { round: 1, verify: [{ command: 'npm test', ok: false, code: 1 }, { command: 'lint', ok: true, code: 0 }] },
    { round: 2, verify: [{ command: 'npm test', ok: true, code: 0, cached: true }, { command: 'lint', ok: true, code: 0 }] },
    { round: 3, verify: [{ command: 'npm test', ok: true, code: 0 }, { command: 'lint', ok: true, code: 0 }] },
  ]
  const history = verifyHistory(rounds)
  assert.equal(history.length, 2)
  const testRow = history.find(h => h.command === 'npm test')
  assert.equal(testRow.everFailed, true)
  assert.equal(testRow.finallyOk, true)

  const table = renderVerifyHistory(rounds).join('\n')
  assert.match(table, /第 1 轮/)
  assert.match(table, /第 3 轮/)
  assert.match(table, /✖\(1\)/)
  assert.match(table, /✔\(复用\)/)
  assert.match(table, /从红到绿/)
  assert.match(table, /一直通过/)

  assert.deepEqual(renderVerifyHistory([]), [])
  const stillRed = renderVerifyHistory([{ round: 1, verify: [{ command: 'npm test', ok: false, code: 1 }] }]).join('\n')
  assert.match(stillRed, /仍未通过/)
})

// ---------------------------------------------------------------------------
// 端到端：合同被改弱 / 验收从红到绿
// ---------------------------------------------------------------------------

function scaffold({ acceptance = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cw-evidence-'))
  const planFile = join(dir, 'PLAN.md')
  const lines = ['# 测试任务', '', '## 目标', '做完它。', '']
  if (acceptance) lines.push('## 验收标准', '- `echo ok` 返回 0', '')
  lines.push('## 任务清单', '- [ ] 第一项', '- [ ] 第二项', '')
  writeFileSync(planFile, lines.join('\n'), 'utf8')
  const config = mergeConfig(defaultConfig(), {
    plan: planFile,
    agent: { adapter: 'fake', cwd: dir, session: 'latest', options: { stateFile: join(dir, '.cyber', 'fake.json') } },
    judge: { kind: 'rule', rule: { allowPlanWeakening: false } },
    evidence: { git: false, verify: ['echo ok'], verifyEveryRound: true, planGuard: true, allowPlanWeakening: false },
    guard: { maxRounds: 10, maxWallClockMs: 60000, maxStallRounds: 9, quietHours: null, cooldownMs: 0 },
    journal: { dir: join(dir, '.cyber'), reportFile: 'CW-REPORT.md', storeAnswers: true },
    notify: { beep: false, toast: false },
    runtime: { logLevel: 'error', stateFile: join(dir, '.cyber', 'state.json') },
  })
  config.__cwd = dir
  return { dir, planFile, config }
}

test('端到端：agent 边干活边把验收标准删掉 → 停成 needs-human 并写进报告', async () => {
  const { dir, planFile, config } = scaffold()
  config.agent.options.reply = (step) => {
    let text = readFileSync(planFile, 'utf8')
    if (step === 1) {
      // 作弊路径：勾掉一项的同时，把验收标准那一行删掉
      text = text.replace('- [ ] 第一项', '- [x] 第一项').replace('- `echo ok` 返回 0\n', '')
    } else {
      text = text.replace('- [ ] 第二项', '- [x] 第二项')
    }
    writeFileSync(planFile, text, 'utf8')
    return `第 ${step} 步做完了。`
  }

  const result = await runOverseer({
    config, cwd: dir, planPath: planFile, agentCwd: dir, log: quiet,
    deps: { pollIntervalMs: 1, sleep: async () => {}, run: okRun },
  })

  assert.equal(result.stopReason, 'needs-human', JSON.stringify(result.verdict))
  assert.equal(result.verdict.details.planWeakened, true)
  assert.match(result.verdict.reason, /被改弱/)

  // 基线要落盘（断点续跑后仍然知道原来的合同长什么样）
  const state = JSON.parse(readFileSync(join(dir, '.cyber', 'state.json'), 'utf8'))
  assert.equal(state.planContract.acceptance.length, 1, '基线里的验收标准应被保存')

  const report = readFileSync(join(dir, 'CW-REPORT.md'), 'utf8')
  assert.match(report, /合同.*被改弱过/)
  assert.match(report, /移除验收标准 1 条/)
  assert.match(report, /验收命令的历史/)

  rmSync(dir, { recursive: true, force: true })
})

test('端到端：验收命令从红到绿 → 报告里能看出这个趋势', async () => {
  const { dir, planFile, config } = scaffold({ acceptance: true })
  let verifyCalls = 0
  const runFn = async (command, args) => {
    if (command === 'git') return { code: 1, stdout: '', stderr: '', timedOut: false, durationMs: 0, aborted: false }
    verifyCalls++
    // 第一次红、之后绿（模拟"先修好再跑通"）
    return verifyCalls === 1
      ? { code: 1, stdout: 'boom', stderr: '', timedOut: false, durationMs: 0, aborted: false }
      : { code: 0, stdout: 'ok', stderr: '', timedOut: false, durationMs: 0, aborted: false }
  }
  config.agent.options.reply = (step) => {
    const text = readFileSync(planFile, 'utf8').replace(`- [ ] 第${step === 1 ? '一' : '二'}项`, `- [x] 第${step === 1 ? '一' : '二'}项`)
    writeFileSync(planFile, text, 'utf8')
    return `第 ${step} 步做完了。`
  }

  const result = await runOverseer({
    config, cwd: dir, planPath: planFile, agentCwd: dir, log: quiet,
    deps: { pollIntervalMs: 1, sleep: async () => {}, run: runFn },
  })
  assert.equal(result.stopReason, 'done', JSON.stringify(result.verdict))

  const report = readFileSync(join(dir, 'CW-REPORT.md'), 'utf8')
  const history = report.split('## 验收命令的历史')[1] ?? ''
  assert.match(history, /`echo ok`/)
  assert.match(history, /✖\(1\)/, '第一轮的红要留痕')
  assert.match(history, /从红到绿/)

  rmSync(dir, { recursive: true, force: true })
})

test('planGuard=false 时不做合同对比（给"方案文档本来就要大改"的项目留出口）', async () => {
  const { dir, planFile, config } = scaffold()
  config.evidence.planGuard = false
  config.agent.options.reply = (step) => {
    const text = readFileSync(planFile, 'utf8')
      .replace(`- [ ] 第${step === 1 ? '一' : '二'}项`, `- [x] 第${step === 1 ? '一' : '二'}项`)
      .replace('- `echo ok` 返回 0\n', '')
    writeFileSync(planFile, text, 'utf8')
    return `第 ${step} 步做完了。`
  }
  const result = await runOverseer({
    config, cwd: dir, planPath: planFile, agentCwd: dir, log: quiet,
    deps: { pollIntervalMs: 1, sleep: async () => {}, run: okRun },
  })
  // planGuard 关掉后：删掉验收标准不再拦收工——清单全勾 + 验收命令通过就是 done
  // （这是主人显式的选择：这个项目的方案文档本来就会频繁大改）
  assert.equal(result.stopReason, 'done', JSON.stringify(result.verdict))
  assert.notEqual(result.verdict.details?.planWeakened, true)
  rmSync(dir, { recursive: true, force: true })
})

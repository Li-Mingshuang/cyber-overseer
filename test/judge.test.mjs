/**
 * 判定器测试：规则判定、LLM 判定（注入假 fetch）、人工判定解析、链式升级。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectStall, ruleJudge } from '../src/judge/rule.mjs'
import { judgeWithLlm, estimateCost } from '../src/judge/llm.mjs'
import { parseHumanAnswer } from '../src/judge/human.mjs'
import { chainJudge, normalizeVerdict } from '../src/judge/index.mjs'
import { parsePlan, planProgress } from '../src/plan.mjs'

const plan = parsePlan(`# 任务
## 验收标准
- npm test 通过
## 任务清单
- [x] 第一步
- [ ] 第二步
- [ ] 第三步
`)
const progress = planProgress(plan)

const baseInput = (overrides = {}) => ({
  plan, progress, answer: '我做了第一步。',
  evidence: { verify: [], git: { available: true }, answerHash: 'h1', fingerprint: 'f1', stallRounds: 0 },
  history: [], config: { judge: { rule: {} } }, round: 1,
  ...overrides,
})

test('规则判定：验收命令失败优先于一切（哪怕 agent 说完成了）', () => {
  const verdict = ruleJudge(baseInput({
    answer: '已经全部完成啦！',
    evidence: {
      verify: [{ command: 'npm test', ok: false, code: 1, outputTail: 'FAIL src/a.test.js' }],
      answerHash: 'h', fingerprint: 'f',
    },
  }), {})
  assert.equal(verdict.status, 'continue')
  assert.match(verdict.reason, /验收命令失败/)
  assert.match(verdict.nextPrompt, /FAIL src\/a\.test\.js/)
})

test('规则判定：还有未勾选项 → continue，并指向具体条目', () => {
  const verdict = ruleJudge(baseInput(), {})
  assert.equal(verdict.status, 'continue')
  assert.match(verdict.nextPrompt, /第二步/)
  assert.equal(verdict.confidence >= 0.8, true)
})

test('规则判定：全部勾选 + 验收通过 → done', () => {
  const allDone = parsePlan('# T\n- [x] a\n- [x] b\n')
  const verdict = ruleJudge({
    ...baseInput(),
    plan: allDone,
    progress: planProgress(allDone),
    evidence: { verify: [{ command: 'npm test', ok: true, code: 0 }], answerHash: 'h', fingerprint: 'f' },
  }, {})
  assert.equal(verdict.status, 'done')
  assert.match(verdict.reason, /验收命令全部通过/)
})

test('规则判定：全部勾选但没有验收命令 → needs-human（宁可不猜）', () => {
  const allDone = parsePlan('# T\n- [x] a\n')
  const verdict = ruleJudge({
    ...baseInput(),
    plan: allDone,
    progress: planProgress(allDone),
    evidence: { verify: [], answerHash: 'h', fingerprint: 'f' },
  }, {})
  assert.equal(verdict.status, 'needs-human')
  assert.match(verdict.reason, /没有可执行的验收命令/)
})

test('规则判定：显式 CW:BLOCKED → blocked', () => {
  const blocked = parsePlan('# T\n<!-- CW:BLOCKED 缺少 API key -->')
  const verdict = ruleJudge({ ...baseInput(), plan: blocked, progress: planProgress(blocked) }, {})
  assert.equal(verdict.status, 'blocked')
  assert.match(verdict.reason, /缺少 API key/)
})

test('规则判定：方案没有任何结构 → needs-human 并给出建议', () => {
  const vague = parsePlan('随便写点什么。')
  const verdict = ruleJudge({ ...baseInput(), plan: vague, progress: planProgress(vague) }, {})
  assert.equal(verdict.status, 'needs-human')
  assert.ok(verdict.details.hint)
})

test('卡死检测：回答与证据都不变才算无进展', () => {
  const history = [
    { answerHash: 'same', fingerprint: 'fp' },
    { answerHash: 'same', fingerprint: 'fp' },
  ]
  assert.equal(detectStall('x', { answerHash: 'same', fingerprint: 'fp' }, history), 3)
  assert.equal(detectStall('x', { answerHash: 'new', fingerprint: 'fp' }, history), 1)
  assert.equal(detectStall('x', { answerHash: 'same', fingerprint: 'changed' }, history), 1)
})

test('连续无进展到达阈值 → blocked', () => {
  const history = Array.from({ length: 3 }, () => ({ answerHash: 'same', fingerprint: 'fp' }))
  const verdict = ruleJudge(baseInput({
    history,
    evidence: { verify: [], answerHash: 'same', fingerprint: 'fp', stallRounds: 4 },
  }), { stallRounds: 3 })
  assert.equal(verdict.status, 'blocked')
  assert.match(verdict.nextPrompt, /CW:BLOCKED/)
})

test('LLM 判定：正常 JSON 解析 + 追问指令保留', async () => {
  const fakeFetch = async () => ({
    ok: true, status: 200,
    data: {
      choices: [{ message: { content: JSON.stringify({ status: 'continue', reason: '还有 2 项没做', next_prompt: '先把第三步做完', confidence: 0.8 }) } }],
      usage: { prompt_tokens: 1000, completion_tokens: 100 },
    },
  })
  const verdict = await judgeWithLlm(baseInput(), { baseUrl: 'http://localhost:1/v1', model: 'deepseek-chat', apiKeyEnv: 'X' }, { fetchImpl: fakeFetch })
  assert.equal(verdict.status, 'continue')
  assert.equal(verdict.nextPrompt, '先把第三步做完')
  assert.equal(verdict.judge, 'llm')
  assert.ok(verdict.costUsd >= 0)
})

test('LLM 判定：说 continue 却不给指令 → 退回 needs-human（不让引擎自己编）', async () => {
  const fakeFetch = async () => ({
    ok: true, status: 200,
    data: { choices: [{ message: { content: '{"status":"continue","reason":"继续努力","confidence":0.9}' } }] },
  })
  const verdict = await judgeWithLlm(baseInput(), { baseUrl: 'http://localhost:1/v1', model: 'm', apiKeyEnv: 'X' }, { fetchImpl: fakeFetch })
  assert.equal(verdict.status, 'needs-human')
  assert.match(verdict.reason, /没给出可执行指令/)
})

test('LLM 判定：输出无法解析 → needs-human，绝不猜 done', async () => {
  const fakeFetch = async () => ({ ok: true, status: 200, data: { choices: [{ message: { content: '我觉得差不多了' } }] } })
  const verdict = await judgeWithLlm(baseInput(), { baseUrl: 'http://localhost:1/v1', model: 'm', apiKeyEnv: 'X' }, { fetchImpl: fakeFetch })
  assert.equal(verdict.status, 'needs-human')
  assert.equal(verdict.confidence <= 0.3, true)
})

test('成本估算', () => {
  assert.ok(estimateCost('deepseek-chat', { prompt_tokens: 1e6, completion_tokens: 1e6 }) > 0)
  assert.equal(estimateCost('unknown-model', { prompt_tokens: 1e6 }), 0)
})

test('人工判定解析：关键词与自由文本', () => {
  assert.equal(parseHumanAnswer('done').status, 'done')
  assert.equal(parseHumanAnswer('decision: 收工').status, 'done')
  assert.equal(parseHumanAnswer('blocked').status, 'blocked')
  const custom = parseHumanAnswer('decision: continue\nprompt: 先把测试跑绿')
  assert.equal(custom.status, 'continue')
  assert.match(custom.nextPrompt, /先把测试跑绿/)
  // 既不是关键词也不是空：当成要抽的鞭子
  const raw = parseHumanAnswer('把首页的样式调成深色')
  assert.equal(raw.status, 'continue')
  assert.match(raw.nextPrompt, /深色/)
})

test('链式判定：规则判得了就不叫模型；判不了才升级', async () => {
  let llmCalls = 0
  const llmStub = { id: 'llm', available: true, judge: async () => { llmCalls++; return { status: 'done', reason: '模型认为完成了', confidence: 0.9, judge: 'llm' } } }
  const ruleStub = { id: 'rule', available: true, judge: async () => ({ status: 'continue', reason: '还有活没干', confidence: 0.9, judge: 'rule' }) }
  const chain = chainJudge({ rule: ruleStub, llm: llmStub, human: { id: 'human', available: true, judge: async () => ({ status: 'continue' }) }, log: null })
  const first = await chain.judge(baseInput())
  assert.equal(first.status, 'continue')
  assert.equal(llmCalls, 0)

  const undecided = { id: 'rule', available: true, judge: async () => ({ status: 'needs-human', reason: '判不了', confidence: 0.2, judge: 'rule' }) }
  const chain2 = chainJudge({ rule: undecided, llm: llmStub, human: { id: 'human', available: true, judge: async () => ({ status: 'continue' }) }, log: null })
  const second = await chain2.judge(baseInput())
  assert.equal(second.status, 'done')
  assert.equal(llmCalls, 1)
  assert.ok(second.details.ruleVerdict)
})

test('判定器崩溃不会拖垮引擎（normalizeVerdict 兜底）', () => {
  const verdict = normalizeVerdict(undefined, { judge: 'x' })
  assert.equal(verdict.status, 'needs-human')
  assert.equal(verdict.judge, 'x')
  const weird = normalizeVerdict({ status: '乱写', confidence: 99, reason: null })
  assert.equal(weird.status, 'needs-human')
  assert.equal(weird.confidence, 1)
})

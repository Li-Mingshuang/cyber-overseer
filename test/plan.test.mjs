/**
 * 方案文档解析测试：中英双语章节、勾选统计、显式协议标记、JSON 覆盖块。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePlan, planProgress, planSummary } from '../src/plan.mjs'

const SAMPLE = `# 做一个天气插件

## 目标
给 DSH 写一个天气插件，支持查询与语音播报。

## 验收标准
- \`npm test\` 全绿
- \`node verify.mjs\` 退出码 0
- 文档里有截图

## 任务清单
- [x] 脚手架
- [ ] 数据源接入
- [ ] 语音播报
- [ ] 写文档

## 禁止 / 范围外
- 不要动 CI 配置
- 不要引入新的 npm 依赖

<!-- CW:NOTE 记得跑 lint -->
`

test('解析中文方案：目标、验收、勾选、禁止项', () => {
  const plan = parsePlan(SAMPLE)
  assert.equal(plan.title, '做一个天气插件')
  assert.match(plan.objective, /天气插件/)
  assert.equal(plan.acceptance.length, 3)
  assert.equal(plan.forbidden.length, 2)
  assert.equal(plan.totalCount, 4)
  assert.equal(plan.doneCount, 1)
  assert.deepEqual(plan.remaining, ['数据源接入', '语音播报', '写文档'])
  assert.equal(plan.todos[0].done, true)
  assert.equal(plan.todos[0].line, 12)
  assert.equal(plan.explicit.done, false)
  assert.deepEqual(plan.explicit.notes, ['记得跑 lint'])
})

test('英文标题别名同样识别', () => {
  const plan = parsePlan(`# Weather plugin

## Goal
Ship a weather plugin.

## Acceptance criteria
- tests pass
- docs written

## Tasks
- [ ] wire data source
- [ ] ship
`)
  assert.match(plan.objective, /Ship a weather plugin/)
  assert.equal(plan.acceptance.length, 2)
  assert.equal(plan.totalCount, 2)
})

test('进度计算与"能否判定"', () => {
  const plan = parsePlan(SAMPLE)
  const progress = planProgress(plan)
  assert.equal(progress.total, 4)
  assert.equal(progress.done, 1)
  assert.equal(progress.ratio, 0.25)
  assert.equal(progress.allChecked, false)
  assert.equal(progress.acceptanceKnown, true)

  const empty = planProgress(parsePlan('只有一句话，没有任何结构。'))
  assert.equal(empty.undecidable, true)
})

test('全勾选后 allChecked 为真，显式标记被识别', () => {
  const plan = parsePlan(`# T
- [x] a
- [x] b
<!-- CW:DONE -->
`)
  const progress = planProgress(plan)
  assert.equal(progress.allChecked, true)
  assert.equal(plan.explicit.done, true)
})

test('受阻标记带上原因', () => {
  const plan = parsePlan('# T\n<!-- CW:BLOCKED 需要数据库密码 -->')
  assert.equal(plan.explicit.blocked, true)
  assert.equal(plan.explicit.blockedReason, '需要数据库密码')
})

test('cw:plan JSON 覆盖块', () => {
  const plan = parsePlan(`# T

\`\`\`cw:plan
{ "objective": "机器写的目标", "acceptance": ["a1"], "maxRounds": 5 }
\`\`\`
`)
  assert.equal(plan.overrides.objective, '机器写的目标')
  assert.equal(plan.overrides.maxRounds, 5)
})

test('摘要渲染包含关键信息且受长度限制', () => {
  const plan = parsePlan(SAMPLE)
  const summary = planSummary(plan, 2000)
  assert.match(summary, /## 目标/)
  assert.match(summary, /## 验收标准/)
  assert.match(summary, /勾选 1\/4/)
  const short = planSummary(plan, 80)
  assert.ok(short.length <= 100)
})

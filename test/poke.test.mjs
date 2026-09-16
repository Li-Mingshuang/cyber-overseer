/**
 * 催工模式（`cw poke`）的决策测试。
 *
 * 这个模式是整个项目"最小"的形态：不读方案、不看验收、不叫模型，
 * 只回答一个问题——**现在该催它、等它，还是收工？** 所以这段判定必须钉死。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_NUDGE, WAITING_NUDGE, decidePoke, looksDone } from '../src/poke.mjs'

const base = { nudgesSent: 0, maxNudges: 30, stallCount: 0 }
const withStatus = (status, extra = {}) => ({ ...base, snapshot: { status, lastAnswer: '', ...extra } })

test('正在跑 → 什么都不做（绝不插嘴）', () => {
  const d = decidePoke(withStatus('working'))
  assert.equal(d.action, 'wait')
  assert.match(d.reason, /正在工作/)
})

test('空闲（回复完了在等人）→ 催它继续', () => {
  const d = decidePoke(withStatus('idle', { lastAnswer: '我完成了第一步。' }))
  assert.equal(d.action, 'nudge')
  assert.equal(d.text, DEFAULT_NUDGE)
  assert.match(d.reason, /已停下/)
})

test('需要人机交互（等你回话 / 等审批）→ 催它自己决定往下走', () => {
  for (const status of ['awaiting-input', 'awaiting-approval']) {
    const d = decidePoke(withStatus(status))
    assert.equal(d.action, 'nudge', `${status} 应该催它自己决定`)
    assert.equal(d.text, WAITING_NUDGE)
    assert.match(d.text, /自己做出最合理的判断/)
  }
})

test('它自己写了 CW:DONE → 收工；只是"提到"标记不算完成', () => {
  assert.equal(decidePoke(withStatus('idle', { lastAnswer: '都做完了。CW:DONE' })).action, 'stop')
  assert.equal(decidePoke(withStatus('idle', { lastAnswer: '收尾完成 <!-- CW:DONE -->' })).action, 'stop')
  assert.equal(decidePoke(withStatus('idle', { lastAnswer: 'CW:DONE\n以上。' })).action, 'stop')

  // 引用/说明形式不算 —— 实测踩到过：宽松匹配会把这种当成完成宣告提前收工
  assert.equal(looksDone('方案里说要做完写 CW:DONE 标记。'), false)
  assert.equal(looksDone('下一步我会写上 CW:DONE 然后继续别的活。'), false)
  assert.equal(decidePoke(withStatus('idle', { lastAnswer: '方案里说要做完写 CW:DONE 标记。' })).action, 'nudge')
})

test('连续两轮催了没变化 → 判定卡住并停止', () => {
  const d = decidePoke({ ...withStatus('idle'), nudgesSent: 3, stallCount: 2 })
  assert.equal(d.action, 'stop')
  assert.match(d.reason, /卡住/)
})

test('催够次数 → 停止（防跑飞）', () => {
  const d = decidePoke({ ...withStatus('idle'), nudgesSent: 5, maxNudges: 5 })
  assert.equal(d.action, 'stop')
  assert.match(d.reason, /上限/)
})

test('出错停下 → 交给人类（不要瞎催）', () => {
  const d = decidePoke(withStatus('error'))
  assert.equal(d.action, 'stop')
  assert.match(d.reason, /错误/)
})

test('状态未知 → 先等，不急着催', () => {
  assert.equal(decidePoke(withStatus('unknown')).action, 'wait')
})

test('催促语要短、像人说话，并明确处理"它在等我"这种情况', () => {
  assert.ok(DEFAULT_NUDGE.length < 220, '催促语别太长')
  assert.match(DEFAULT_NUDGE, /继续/)
  assert.match(DEFAULT_NUDGE, /等我/)
  assert.match(WAITING_NUDGE, /不可逆/)
})

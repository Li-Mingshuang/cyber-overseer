/**
 * 规则判定器：零成本、确定性、不需要 API Key。
 *
 * 它的定位不是"取代 LLM"，而是**兜底与刹车**：
 *  - 离网/没有 Key 也能跑通闭环（示例与测试都靠它）；
 *  - 勾选清单 + 验收命令是硬事实，规则判定在这上面比模型更可靠；
 *  - 判不了就老实说 needs-human（让 chain 升级到 LLM 或喊人），绝不瞎猜"完成"。
 *
 * 判定顺序（先硬后软）：
 *  1. agent 显式宣告受阻 → blocked
 *  2. 验收命令失败 → continue（把失败摘要变成鞭子）
 *  3. 有待办未勾选 → continue（把第一项未完成变成鞭子）
 *  4. 待办全勾 + 验收全绿 → done
 *  5. 同一回答连续 N 轮无变化 → blocked（卡死）
 *  6. 缺验收标准/无法判定 → needs-human
 *
 * @module cyber-overseer/judge/rule
 */

import { oneLine } from '../util/text.mjs'
import { normalizeVerdict } from './types.mjs'

export const id = 'rule'

/**
 * @param {import('../config.mjs').defaultConfig} config
 * @returns {import('./types.mjs').Judge}
 */
export function createRuleJudge(config) {
  const opts = config.judge?.rule ?? {}
  return {
    id,
    available: true,
    async judge(input) {
      return normalizeVerdict(ruleJudge(input, opts), { judge: id })
    },
  }
}

/**
 * 纯函数版本，便于单测。
 * @param {import('./types.mjs').JudgeInput} input
 * @param {NonNullable<ReturnType<import('../config.mjs').defaultConfig>['judge']['rule']>} opts
 * @returns {import('./types.mjs').Verdict}
 */
export function ruleJudge(input, opts = {}) {
  const requireTodosChecked = opts.requireTodosChecked ?? true
  const requireVerifyPass = opts.requireVerifyPass ?? true
  const trustAgentDone = opts.trustAgentDone ?? false
  const stallRounds = opts.stallRounds ?? 3

  const { plan, progress, answer, evidence, history = [] } = input
  const verifyFailed = evidence?.verify?.filter(v => !v.ok) ?? []
  const verifyRan = (evidence?.verify?.length ?? 0) > 0
  const verifyAllPass = verifyRan && verifyFailed.length === 0

  // 1) agent 明确宣告受阻
  if (plan?.explicit?.blocked) {
    return verdict('blocked', `agent 显式宣告受阻：${oneLine(plan.explicit.blockedReason ?? '未说明')}`, null, 0.85)
  }

  // 2) 卡死检测（放在"还有待办"之前）：连续几轮回答与证据都没变，
  //    说明再抽同样一句话也没用——应该换成"换条路"的鞭子，而不是复述待办清单。
  const stall = detectStall(answer, evidence, history)
  if (stall >= stallRounds) {
    return verdict('blocked', `连续 ${stall} 轮回答与证据完全一致：agent 在原地打转`, buildStallWhip(plan, stall), 0.8, { stallRounds: stall })
  }

  // 3) 验收命令失败 —— 硬证据，优先于一切"我觉得我完成了"
  if (requireVerifyPass && verifyFailed.length > 0) {
    const first = verifyFailed[0]
    return verdict('continue', `验收命令失败：${first.command}（退出码 ${first.code}）`, buildVerifyWhip(first, plan, progress), 0.95, {
      failedCommands: verifyFailed.map(v => v.command),
    })
  }

  // 4) 待办未勾完
  if (plan?.totalCount > 0 && plan.remaining.length > 0) {
    const next = plan.remaining.slice(0, 3)
    return verdict(
      'continue',
      `方案还剩 ${plan.remaining.length} 项未完成，例如：${oneLine(next[0], 80)}`,
      buildTodoWhip(next, plan, progress),
      0.9,
    )
  }

  // 5) 全部勾选 + 验收证据齐备 → 收工
  if (plan?.totalCount > 0 && plan.remaining.length === 0) {
    if (verifyRan && verifyAllPass) {
      return verdict('done', `方案 ${plan.doneCount}/${plan.totalCount} 项全部完成，且 ${evidence.verify.length} 条验收命令全部通过`, null, 0.97)
    }
    if (!verifyRan) {
      if (trustAgentDone && plan.explicit?.done) {
        return verdict('done', 'agent 显式宣告完成（配置允许信任自述），清单已全部勾选', null, 0.6)
      }
      return verdict(
        'needs-human',
        '方案待办已全部勾选，但没有可执行的验收命令来证明结果；规则判定无法确认',
        null,
        0.45,
        { hint: '建议在 config.evidence.verify 里配置 `npm test` 之类的验收命令' },
      )
    }
  }

  // 6) 无法判定
  if (progress?.undecidable || (plan?.totalCount === 0 && plan?.acceptance?.length === 0)) {
    return verdict('needs-human', '方案文档里既没有可勾选的待办清单，也没有验收标准，规则判定无从下手', null, 0.3, {
      hint: '在方案文档里加一段 `## 验收标准` 的列表，或加上 `- [ ] 任务` 复选框',
    })
  }

  // 7) 有验收标准但无清单：只能依赖模型或人
  return verdict('needs-human', `有 ${plan?.acceptance?.length ?? 0} 条验收标准但没有待办清单，规则判定无法逐项核对`, null, 0.35)
}

/**
 * 统计"连续多少轮无进展"：回答哈希相同 + 文件指纹相同。
 * @param {string} answer
 * @param {import('../engine/evidence.mjs').Evidence|undefined} evidence
 * @param {import('../engine/state.mjs').RoundRecord[]} history
 */
export function detectStall(answer, evidence, history) {
  const currentAnswer = evidence?.answerHash ?? null
  const currentFingerprint = evidence?.fingerprint ?? null
  let stall = 1
  for (let i = history.length - 1; i >= 0; i--) {
    const rec = history[i]
    const sameAnswer = currentAnswer ? rec.answerHash === currentAnswer : rec.answerText === answer
    const sameFingerprint = currentFingerprint ? rec.fingerprint === currentFingerprint : true
    if (sameAnswer && sameFingerprint) stall++
    else break
  }
  return stall
}

function verdict(status, reason, nextPrompt, confidence, details = {}) {
  return { status, reason, nextPrompt, confidence, judge: id, details, costUsd: 0 }
}

function buildVerifyWhip(failed, plan, progress) {
  const lines = [
    `${failed.command} 失败了（退出码 ${failed.code}）。在你把这条命令跑绿之前，任务不算完成。`,
    '',
  ]
  if (failed.outputTail) {
    lines.push('最近的输出：', '```', failed.outputTail.slice(-1200), '```', '')
  }
  if (plan?.remaining?.length) {
    lines.push(`方案里还剩 ${plan.remaining.length} 项：`)
    for (const item of plan.remaining.slice(0, 5)) lines.push(`- ${oneLine(item, 120)}`)
  }
  lines.push('请先修复失败原因，然后再继续推进方案里的剩余项。')
  return lines.join('\n')
}

function buildTodoWhip(remaining, plan, progress) {
  const lines = [
    `当前只完成了 ${progress?.done ?? '?'}/${progress?.total ?? '?'} 项，还没到收工的时候。下一次回答请集中处理：`,
    '',
  ]
  for (const item of remaining.slice(0, 3)) lines.push(`- ${oneLine(item, 160)}`)
  lines.push('', '做完之后请勾选方案文档里对应的复选框（把 `- [ ]` 改成 `- [x]`），并给出可验证的结果。')
  return lines.join('\n')
}

function buildStallWhip(plan, stall) {
  return [
    `你已经连续 ${stall} 轮给出几乎相同的回答，没有任何新的改动或证据。这就是卡住了。`,
    '',
    '换一条路：',
    '1. 先用一条命令把当前真实状态查清楚（测试输出、git status、文件内容），把结果原样贴出来；',
    '2. 明确写下"我卡在哪一步、需要什么"（缺信息、缺权限、方案自相矛盾）；',
    '3. 如果确实无法继续，就明确说 `CW:BLOCKED <原因>`，不要假装在推进。',
    plan?.remaining?.length ? `\n方案里仍未完成的：\n${plan.remaining.slice(0, 3).map(r => `- ${oneLine(r, 120)}`).join('\n')}` : '',
  ].filter(Boolean).join('\n')
}

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
import { parseMarkers } from '../plan.mjs'
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
  // 显式标记只认 **agent 的回答**里的：方案文档里会有"教 agent 怎么写标记"的说明文字，
  // 拿方案去匹配会把说明当成真标记（真实踩到过）。
  const markers = parseMarkers(String(answer ?? ''))
  const planClaimedDone = plan?.explicit?.done === true && input.config?.judge?.rule?.trustPlanMarker === true

  // 1) agent 明确宣告受阻（来自回答）
  if (markers.blocked) {
    return verdict('blocked', `agent 显式宣告受阻：${oneLine(markers.blockedReason ?? '未说明')}`, null, 0.85)
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
      if (trustAgentDone && (markers.done || planClaimedDone)) {
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

  // 6) 无法判定（没有任何结构）
  if (progress?.undecidable || (plan?.totalCount === 0 && plan?.acceptance?.length === 0)) {
    return verdict('needs-human', '方案文档里既没有可勾选的待办清单，也没有验收标准，规则判定无从下手', null, 0.3, {
      hint: '在方案文档里加一段 `## 验收标准` 的列表，或加上 `- [ ] 任务` 复选框',
    })
  }

  // 7) 零配置模式：有验收标准但没有任务清单（`cw "一句话"` 自动生成的方案就是这样）
  //
  //    用户不想为了"让监工盯一下"去手写复选框，所以这里改用三样东西判定：
  //      ① 验收命令全绿（硬证据）  ② agent 的显式宣告 `<!-- CW:DONE -->`  ③ 卡死检测（上面已处理）
  //    仍然不轻信自述：没有全绿的验收命令就绝不判 done；全绿了但 agent 没宣告，会先问一次，
  //    问过之后仍全绿才收工（避免把"跑完测试但其实还有活"的情况误判，也避免永远卡在等人宣告）。
  if (plan?.acceptance?.length) {
    if (verifyRan && verifyAllPass) {
      if (markers.done || planClaimedDone) {
        return verdict('done', `验收命令全部通过，且 agent 显式宣告完成（共 ${plan.acceptance.length} 条验收标准）`, null, 0.92)
      }
      const askedBefore = (history ?? []).filter(h => h.verdict?.details?.awaitingDoneMarker).length
      const acceptAfterAsks = opts.acceptVerifyGreenAfterAsks ?? 1
      if (askedBefore >= acceptAfterAsks) {
        return verdict(
          'done',
          `验收命令全部通过，且已要求 agent 确认过一次没有额外未完成项 → 收工（如果不对，请在方案里补上任务清单）`,
          null, 0.7, { verifyGreenWithoutMarker: true },
        )
      }
      return verdict(
        'continue',
        `验收命令全部通过；请 agent 自查是否还有未完成项并明确宣告`,
        '验收命令都过了，很好。请再自己检查一遍是否有遗漏（边界情况、报错分支、文档/示例），'
        + '若确实都做完了，请在回答里写上 `<!-- CW:DONE -->`；若还有没做的，直接继续做完。',
        0.75, { awaitingDoneMarker: true },
      )
    }
    if (!verifyRan) {
      if (trustAgentDone && (markers.done || planClaimedDone)) {
        return verdict('done', 'agent 显式宣告完成（配置允许信任自述），但没有验收命令可核对', null, 0.55)
      }
      return verdict('needs-human', `方案有 ${plan.acceptance.length} 条验收标准，但没有可执行的验收命令来证明结果`, null, 0.45, {
        hint: '在 cw.config.mjs 的 evidence.verify 里加一条能跑的命令（例如 npm test）',
      })
    }
  }

  return verdict('needs-human', '规则判定无法决定（既没有清单也没有可核对的验收命令）', null, 0.35)
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

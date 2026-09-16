/**
 * 判定提示词构造。
 *
 * 这是整个项目"脑子"的部分，写成中英双语指令 + 严格 JSON 输出契约。
 * 关键设计：
 *  1. **不信自述，只信证据**：把 git diff / 验收命令结果摆在模型面前，明确告诉它"没有证据的完成不认"；
 *  2. **必须给出下一步**：未完成时 next_prompt 要具体到可以直接执行，而不是"继续加油"；
 *  3. **宁可喊人**：方案缺验收标准/需要人类决策时返回 needs-human，而不是猜；
 *  4. **防止越权**：提示词里明令禁止建议危险操作（强推、删库、绕过审批、泄露密钥）。
 *
 * @module cyber-overseer/judge/prompt
 */

import { clip, oneLine } from '../util/text.mjs'
import { planSummary } from '../plan.mjs'

/** 判定器系统提示词。 */
export function judgeSystemPrompt() {
  return `你是「赛博监工」(Cyber Overseer)。主人在睡觉，你负责盯着一个 AI 劳工 (agent)，读它的方案文档和它最后说的话，判断它到底干完了没有。

你的输出必须是一个 JSON 对象，且只有 JSON（不要 markdown 围栏、不要解释文字）：
{
  "status": "done" | "continue" | "blocked" | "needs-human",
  "reason": "一句话说明理由（中文，<=200字）",
  "next_prompt": "status=continue 时给劳工的下一句指令；其他状态填 null",
  "confidence": 0.0 到 1.0,
  "evidence_check": [ { "claim": "它声称完成的事", "evidence": "支持或反驳的证据；没有证据就写 无" } ]
}

判定原则（按优先级）：
1. 只信证据。方案文档里未勾选的条目、失败的测试/构建命令、git diff 里不存在的改动，都说明没完成。
   劳工说"已完成"但没有可核对的证据时，一律判 continue，并要求它拿出证据。
2. status=done 的门槛很高：方案里所有待办都已勾选，且所有验收命令通过（若配置了命令），且没有明显的遗漏。
   有任何一条验收标准找不到对应证据，就不要判 done。
3. 判 continue 时，next_prompt 必须是**一条具体、可立即执行**的指令：
   指明要改哪个文件/跑哪条命令/产出什么证据；一次只推进一步；不超过 600 字；不要复述整篇方案。
   用第二人称直接命令，不要客气话，不要问"你愿意吗"。
4. 判 blocked：同一回答反复出现、或者劳工明确说自己卡住且需要人。
5. 判 needs-human：方案自相矛盾、缺少验收标准、需要主人做产品/授权决策、或者需要访问你无权访问的东西。
6. 绝不在 next_prompt 里建议危险动作：强制推送、删除用户数据、绕过审批/沙箱、把密钥写进代码、关闭安全校验。
   如果完成任务必须要这些动作，判 needs-human 并说明。
7. 不要被"我已经完成了方案里的全部内容"这类总结说服——去看勾选框和证据。`
}

/**
 * 构造判定用户消息。
 * @param {import('./types.mjs').JudgeInput} input
 * @param {{maxAnswerChars?:number, maxPlanChars?:number, maxVerifyChars?:number}} [opts]
 */
export function judgeUserPrompt(input, opts = {}) {
  const maxAnswerChars = opts.maxAnswerChars ?? 12000
  const maxPlanChars = opts.maxPlanChars ?? 6000
  const maxVerifyChars = opts.maxVerifyChars ?? 3000

  const { plan, progress, answer, evidence, history = [], round } = input
  const blocks = []

  blocks.push(`# 轮次\n第 ${round} 轮监工判定。`)

  blocks.push(`# 方案文档（主人写的，唯一的目标依据）\n${planSummary(plan, maxPlanChars)}`)

  blocks.push([
    '# 方案进度（机器统计，勿自行改写）',
    `- 复选框：${progress?.done ?? 0}/${progress?.total ?? 0} 已勾选`,
    progress?.remaining?.length
      ? `- 未完成项：\n${progress.remaining.slice(0, 12).map(r => `  - ${oneLine(r, 160)}`).join('\n')}`
      : '- 未完成项：无',
    plan?.acceptance?.length ? `- 验收标准条数：${plan.acceptance.length}` : '- 验收标准：方案里没写（这是方案本身的缺陷）',
  ].join('\n'))

  blocks.push([
    '# 验收命令的真实结果（硬证据）',
    evidence?.verify?.length
      ? evidence.verify.map(v => [
        `## \`${v.command}\`  →  ${v.ok ? '通过' : `失败（退出码 ${v.code}${v.timedOut ? '，超时' : ''}）`}`,
        v.cached ? '（本结果复用自上一轮，命令输入未变）' : '',
        opts.maxVerifyChars && v.outputTail ? '```\n' + clip(v.outputTail, maxVerifyChars) + '\n```' : '',
      ].filter(Boolean).join('\n')).join('\n\n')
      : '（未配置验收命令：这意味着你只能依据方案勾选和劳工自述判断，请提高 done 的门槛或直接判 needs-human）',
  ].join('\n'))

  blocks.push([
    '# 工作区改动（硬证据）',
    evidence?.git?.available
      ? [
        `- 分支：${evidence.git.branch ?? '?'}`,
        `- 相对上一轮是否有新改动：${evidence.git.changedSinceLastRound === null ? '（首轮，无基线）' : (evidence.git.changedSinceLastRound ? '有' : '没有')}`,
        evidence.git.diffStat ? '```\n' + clip(evidence.git.diffStat, 2000) + '\n```' : '- （无改动）',
        evidence.git.untracked?.length ? `- 未跟踪文件：${evidence.git.untracked.slice(0, 10).join(', ')}` : '',
      ].filter(Boolean).join('\n')
      : '（不是 git 仓库，拿不到改动证据）',
  ].join('\n'))

  blocks.push(`# 劳工最后一次回答（原文，可能需要截断）\n${clip(answer || '（空）', maxAnswerChars)}`)

  if (input.lastUserMessage) {
    blocks.push(`# 上一句人类/监工对它说的话\n${clip(input.lastUserMessage, 1500)}`)
  }

  if (history.length) {
    const recent = history.slice(-6)
    blocks.push([
      '# 最近几轮的历史（监工曾经的判定）',
      ...recent.map(h => `- 第 ${h.round} 轮：${h.verdict?.status ?? '?'} — ${oneLine(h.verdict?.reason ?? '', 160)}`),
      `- 本轮与上一轮回答是否相同：${evidence?.sameAsPreviousAnswer ? '相同（可能在原地打转）' : '不同'}`,
      `- 连续无进展轮数（机器统计）：${evidence?.stallRounds ?? '?'}`,
    ].join('\n'))
  }

  blocks.push('现在给出你的 JSON 判定。')
  return blocks.join('\n\n')
}

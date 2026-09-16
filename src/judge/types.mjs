/**
 * 判定契约。所有判定器（规则/LLM/人工）都必须返回这个形状，引擎只认它。
 * @module cyber-overseer/judge/types
 */

/**
 * @typedef {'done'|'continue'|'blocked'|'needs-human'} VerdictStatus
 *
 * - `done`       目标已完成，监工收工（这是唯一会让循环停下来的"好"结局）
 * - `continue`   agent 还没干完，把 `nextPrompt` 抽到它脸上继续干
 * - `blocked`    agent 卡住了（同一回答反复出现、明确宣告受阻），监工应停下喊人
 * - `needs-human` 监工无法判断（方案缺验收标准、需要人类决策、需要授权），交还给主人
 */

/**
 * @typedef {Object} Verdict
 * @property {VerdictStatus} status
 * @property {string} reason 判定理由（进日志、报告，也会拼进下一鞭）
 * @property {string|null} nextPrompt status=continue 时的下一条指令
 * @property {number} confidence 0..1，低置信度会让 chain 判定器升级到 LLM
 * @property {string} judge 判定器 id（rule/llm/human/chain）
 * @property {Record<string, any>} [details] 证据、模型原始输出等
 * @property {number} [costUsd] 本次判定成本估算
 */

/**
 * @typedef {Object} JudgeInput
 * @property {import('../plan.mjs').parsePlan} plan 解析后的方案文档（含 progress 计算前的原始结构）
 * @property {ReturnType<import('../plan.mjs').planProgress>} progress
 * @property {string} answer 被监工 agent 的最后一次回答
 * @property {string|null} lastUserMessage 最后一条用户消息（判断"agent 是不是在等人"）
 * @property {import('../engine/evidence.mjs').Evidence} evidence 证据（git/验收命令/文件变化）
 * @property {import('../engine/state.mjs').RoundRecord[]} history 历史轮次
 * @property {import('../config.mjs').defaultConfig extends () => infer T ? T : never} config
 * @property {number} round 当前轮次（从 1 开始）
 * @property {import('../util/log.mjs').createLogger extends never ? any : any} log
 */

/**
 * 判定器接口。
 * @typedef {Object} Judge
 * @property {string} id
 * @property {boolean} available
 * @property {string} [unavailableReason]
 * @property {(input: JudgeInput) => Promise<Verdict>} judge
 */

export const VERDICT_STATUSES = ['done', 'continue', 'blocked', 'needs-human']

/** 把任意输入整形成合法 Verdict（判定器出错时不至于让引擎崩掉）。 */
export function normalizeVerdict(raw, fallback = {}) {
  const status = VERDICT_STATUSES.includes(raw?.status) ? raw.status : (fallback.status ?? 'needs-human')
  const reason = String(raw?.reason ?? fallback.reason ?? '判定器未给出理由')
  const nextPrompt = raw?.nextPrompt ?? raw?.next_prompt ?? raw?.nextPromptText ?? null
  return {
    status,
    reason,
    nextPrompt: status === 'continue' ? (nextPrompt ? String(nextPrompt) : null) : (nextPrompt ? String(nextPrompt) : null),
    confidence: clamp01(typeof raw?.confidence === 'number' ? raw.confidence : (fallback.confidence ?? 0.5)),
    judge: String(raw?.judge ?? fallback.judge ?? 'unknown'),
    details: raw?.details ?? fallback.details ?? {},
    costUsd: typeof raw?.costUsd === 'number' ? raw.costUsd : (fallback.costUsd ?? 0),
  }
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0.5
  return Math.min(1, Math.max(0, n))
}

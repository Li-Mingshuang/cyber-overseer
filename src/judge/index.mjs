/**
 * 判定器工厂 + chain（链式）判定器。
 *
 * chain 的策略：**规则优先，规则判不了才花钱**。
 *   rule → (needs-human 或低置信度) → llm → (不可用/也不确定) → human → needs-human
 * 这样绝大多数轮次（"待办还没勾完"→继续）都是零成本的，只有真正到了"该不该收工"的
 * 关键节点才会调模型——既省钱又比"每轮都问模型"更稳定。
 *
 * @module cyber-overseer/judge/index
 */

import { createLogger } from '../util/log.mjs'
import { createHumanJudge } from './human.mjs'
import { createLlmJudge } from './llm.mjs'
import { createRuleJudge } from './rule.mjs'
import { normalizeVerdict } from './types.mjs'

export { createRuleJudge, ruleJudge, detectStall } from './rule.mjs'
export { createLlmJudge, judgeWithLlm, estimateCost } from './llm.mjs'
export { createHumanJudge, parseHumanAnswer } from './human.mjs'
export { judgeSystemPrompt, judgeUserPrompt } from './prompt.mjs'
export { normalizeVerdict, VERDICT_STATUSES } from './types.mjs'

/** chain 升级到 LLM 的置信度门槛。 */
export const CHAIN_ESCALATE_BELOW = 0.55

/**
 * 按配置装配判定器。
 * @param {import('../config.mjs').defaultConfig} config
 * @param {{log?:any, deps?:Record<string,any>}} [opts]
 * @returns {import('./types.mjs').Judge & {describe:()=>string, judges?:import('./types.mjs').Judge[]}}
 */
export function createJudge(config, opts = {}) {
  const log = opts.log ?? config.__log ?? createLogger({ level: 'warn' })
  const rule = createRuleJudge(config)
  const llm = createLlmJudge(config, { log })
  const human = createHumanJudge(config, { ...(opts.deps ?? {}), log })

  const judge = (() => {
    switch (config.judge?.kind) {
      case 'rule': return rule
      case 'llm': return llm.available ? llm : rule
      case 'human': return human
      case 'chain':
      default: return chainJudge({ rule, llm, human, log })
    }
  })()

  return Object.assign(judge, {
    describe: () => {
      const parts = [`判定器=${config.judge?.kind}`]
      if (config.judge?.kind === 'chain') {
        parts.push(`rule → ${llm.available ? `llm(${config.judge?.llm?.model})` : 'llm(不可用)'} → human`)
      }
      if (config.judge?.kind === 'llm' && !llm.available) parts.push(`llm 不可用（${llm.unavailableReason}）已退回 rule`)
      return parts.join('  ')
    },
    judges: [rule, llm, human],
  })
}

/**
 * 链式判定：规则 → LLM → 人工。
 * @param {{rule:import('./types.mjs').Judge, llm:import('./types.mjs').Judge, human:import('./types.mjs').Judge, log:any}} deps
 * @returns {import('./types.mjs').Judge}
 */
export function chainJudge({ rule, llm, human, log }) {
  return {
    id: 'chain',
    available: true,
    async judge(input) {
      const first = await safeJudge(rule, input, log)
      const escalate = first.status === 'needs-human' || first.confidence < CHAIN_ESCALATE_BELOW
      if (!escalate) return first
      log?.debug?.(`rule 判定为「${first.status}」（置信度 ${first.confidence.toFixed(2)}），升级到 LLM 判定`)

      if (llm.available) {
        const second = await safeJudge(llm, input, log, { ruleReason: first.reason })
        if (second.status !== 'needs-human' || second.confidence >= first.confidence) {
          return { ...second, details: { ...second.details, ruleVerdict: { status: first.status, reason: first.reason } } }
        }
        return first
      }

      // 没有 LLM：把规则判定器的 needs-human 交给人工（如果它们不是同一个东西）
      if (human.available && input.config?.judge?.kind === 'chain') {
        const third = await safeJudge(human, { ...input, ruleReason: first.reason }, log)
        // 人工超时/无输入时保留规则结论，避免把 needs-human 变成 continue
        return third.status === 'needs-human' && third.details?.unavailable ? first : third
      }
      return { ...first, details: { ...first.details, llmUnavailable: llm.unavailableReason ?? null } }
    },
  }
}

async function safeJudge(judge, input, log, extra = {}) {
  try {
    const verdict = await judge.judge({ ...input, ...extra })
    return normalizeVerdict({ ...verdict, judge: judge.id }, { judge: judge.id })
  } catch (error) {
    log?.warn?.(`判定器 ${judge.id} 出错：${error?.message ?? error}`)
    return normalizeVerdict({
      status: 'needs-human',
      reason: `判定器 ${judge.id} 出错：${error?.message ?? error}`,
      confidence: 0,
      judge: judge.id,
      details: { error: String(error?.stack ?? error) },
    }, { judge: judge.id })
  }
}

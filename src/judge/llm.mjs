/**
 * LLM 判定器：调用任意 OpenAI 兼容的 /chat/completions 接口。
 *
 * 兼容性：DeepSeek 官方、OpenAI、OpenRouter、Ollama、vLLM、LM Studio、任何网关
 * 只要遵循 `POST {baseUrl}/chat/completions` 都能用。零依赖（用全局 fetch）。
 *
 * 健壮性设计：
 *  - 输出解析失败时**不猜**：降级为 needs-human 并保留原始文本，绝不误判 done；
 *  - 二次尝试：解析失败会把温度降到 0 并用一句"只输出 JSON"重问一次；
 *  - 成本记账：返回 usage 时折算上成本（可选），供预算熔断使用。
 *
 * @module cyber-overseer/judge/llm
 */

import { jsonRequest } from '../util/http.mjs'
import { extractJson, oneLine, safeJson, clip } from '../util/text.mjs'
import { judgeSystemPrompt, judgeUserPrompt } from './prompt.mjs'
import { normalizeVerdict, VERDICT_STATUSES } from './types.mjs'

export const id = 'llm'

/** 各家的粗略价格（美元 / 1M tokens），仅用于预算熔断，不影响判定。 */
const PRICES = {
  'deepseek-chat': { in: 0.27, out: 1.1 },
  'deepseek-reasoner': { in: 0.55, out: 2.19 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4o': { in: 2.5, out: 10 },
}

/**
 * @param {import('../config.mjs').defaultConfig} config
 * @param {{log?:any}} [deps]
 * @returns {import('./types.mjs').Judge}
 */
export function createLlmJudge(config, deps = {}) {
  const llm = config.judge?.llm ?? {}
  const apiKey = process.env[llm.apiKeyEnv ?? 'DEEPSEEK_API_KEY'] ?? ''
  const isLocal = /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(llm.baseUrl ?? '')
  const available = Boolean(llm.baseUrl) && (Boolean(apiKey) || isLocal)
  return {
    id,
    available,
    unavailableReason: available
      ? undefined
      : `缺少 API Key（环境变量 ${llm.apiKeyEnv ?? 'DEEPSEEK_API_KEY'}）且 baseUrl 不是本地地址`,
    async judge(input) {
      if (!available) throw new Error(this.unavailableReason)
      return judgeWithLlm(input, llm, { log: deps.log, apiKey })
    },
  }
}

/**
 * 单次 LLM 判定（也导出给测试用，可注入 fetchImpl）。
 * @param {import('./types.mjs').JudgeInput} input
 * @param {NonNullable<ReturnType<import('../config.mjs').defaultConfig>['judge']['llm']>} llm
 * @param {{log?:any, apiKey?:string, fetchImpl?:typeof jsonRequest}} [deps]
 * @returns {Promise<import('./types.mjs').Verdict>}
 */
export async function judgeWithLlm(input, llm, deps = {}) {
  const request = deps.fetchImpl ?? jsonRequest
  const apiKey = deps.apiKey ?? process.env[llm.apiKeyEnv ?? 'DEEPSEEK_API_KEY'] ?? ''
  const system = judgeSystemPrompt()
  const user = judgeUserPrompt(input, {})
  const url = `${String(llm.baseUrl).replace(/\/+$/, '')}/chat/completions`

  const call = async (temperature, extraSystem) => request(url, {
    method: 'POST',
    headers: {
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      ...(llm.headers ?? {}),
    },
    body: {
      model: llm.model,
      temperature,
      max_tokens: llm.maxTokens ?? 2000,
      messages: [
        { role: 'system', content: extraSystem ? `${system}\n\n${extraSystem}` : system },
        { role: 'user', content: user },
      ],
    },
    timeoutMs: llm.timeoutMs ?? 180000,
  })

  let response = await call(llm.temperature ?? 0, null)
  let content = response?.data?.choices?.[0]?.message?.content ?? ''
  let parsed = extractJson(content)

  if (!parsed || !VERDICT_STATUSES.includes(parsed.status)) {
    deps.log?.warn?.(`LLM 判定输出无法解析，重试一次（原文：${oneLine(content, 160)}）`)
    const retryModel = llm.fallbackModel ?? llm.model
    response = await call(0, '重要：只输出一个 JSON 对象，不要任何其他字符。')
    content = response?.data?.choices?.[0]?.message?.content ?? ''
    parsed = extractJson(content)
    if (!parsed || !VERDICT_STATUSES.includes(parsed.status)) {
      return normalizeVerdict({
        status: 'needs-human',
        reason: 'LLM 判定器返回了无法解析的内容，宁可交给主人也不猜',
        confidence: 0.2,
        judge: id,
        details: { raw: clip(content, 2000), model: retryModel },
        costUsd: estimateCost(llm.model, response?.data?.usage),
      }, { judge: id })
    }
  }

  const usage = response?.data?.usage
  const costUsd = estimateCost(llm.model, usage)
  const verdict = normalizeVerdict({
    status: parsed.status,
    reason: parsed.reason ?? '(模型未给理由)',
    nextPrompt: parsed.next_prompt ?? parsed.nextPrompt ?? null,
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.6,
    judge: id,
    details: {
      model: llm.model,
      usage,
      evidenceCheck: parsed.evidence_check ?? null,
      raw: safeJson(parsed, 3000),
    },
    costUsd,
  }, { judge: id })

  if (verdict.status === 'continue' && !verdict.nextPrompt) {
    // 模型说继续但没给指令：这是不可接受的输出，退回 needs-human 而不是让引擎自己编一条
    return {
      ...verdict,
      status: 'needs-human',
      reason: `模型判定要继续但没给出可执行指令（理由：${oneLine(verdict.reason, 120)}）`,
      confidence: 0.3,
    }
  }
  return verdict
}

/** 粗略成本估算。 */
export function estimateCost(model, usage) {
  const price = PRICES[model]
  if (!price || !usage) return 0
  const inTokens = usage.prompt_tokens ?? 0
  const outTokens = usage.completion_tokens ?? 0
  return Number((((inTokens / 1e6) * price.in) + ((outTokens / 1e6) * price.out)).toFixed(6))
}

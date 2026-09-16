/**
 * 假适配器（fake）：给测试与离线演示用。
 *
 * 它扮演一个"听话但懒惰"的 agent：每被抽一鞭就往前走一步，按脚本吐出一段回答。
 * 有了它，整个监工闭环可以在**没有任何 agent、没有网络、没有 API Key** 的环境里被完整验证——
 * `npm test` 与 `examples/lazy-agent` 都靠它。
 *
 * 配置：
 * ```js
 * agent: { adapter: 'fake', options: {
 *   reply: (step, text) => string,   // 自定义每一步的回答
 * }} 
 * ```
 *
 * @module cyber-overseer/adapters/fake
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { probeOk } from './base.mjs'

export const id = 'fake'
export const label = '假 agent（测试/演示）'
export const docs = '按脚本吐回答，用于离线验证整条监工闭环'

/**
 * @param {{config:any, cwd:string, log?:any}} ctx
 * @returns {import('./base.mjs').Adapter}
 */
export function createFakeAdapter(ctx) {
  const { config, cwd, log } = ctx
  const options = config.agent?.options ?? {}
  const stateFile = resolve(cwd, options.stateFile ?? '.cyber/fake-agent.json')

  const read = () => {
    try { return JSON.parse(readFileSync(stateFile, 'utf8')) } catch { return { step: 0, answers: [], idle: true } }
  }
  const write = (state) => {
    if (!existsSync(dirname(stateFile))) mkdirSync(dirname(stateFile), { recursive: true })
    writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8')
  }

  const defaultReply = (step) => (step === 0
    ? '我已经看了一遍任务，准备开始了。'
    : `第 ${step} 步做完了，但我还没把方案里的复选框都勾上。`)

  return {
    id,
    label,
    docs,

    async probe() {
      return probeOk(`状态文件：${stateFile}（当前第 ${read().step} 步）`, [])
    },

    async listSessions() {
      return [{ id: 'fake-session', title: options.title ?? '假 agent 会话', cwd, updatedAt: Date.now() }]
    },

    async resolveSession() {
      return { id: 'fake-session', title: options.title ?? null, cwd, updatedAt: Date.now() }
    },

    async readState(session) {
      const state = read()
      const lastAnswer = state.answers.at(-1) ?? ''
      return {
        status: state.idle === false ? 'working' : 'idle',
        turn: state.step,
        lastAnswer,
        lastUserMessage: state.lastWhip ?? null,
        session,
        extra: { step: state.step },
      }
    },

    async whip(text, session) {
      const state = read()
      state.step = (state.step ?? 0) + 1
      state.lastWhip = text
      // 测试用：模拟"通道没配好/临时故障"，用来验证引擎的失败分类与熔断
      const fail = options.failWith
      if (fail && (!fail.times || (state.failures ?? 0) < fail.times)) {
        state.failures = (state.failures ?? 0) + 1
        write(state)
        return {
          ok: false, mode: 'inject', kind: fail.kind ?? 'fatal',
          detail: fail.detail ?? '（假适配器模拟的抽鞭失败）',
        }
      }
      const reply = typeof options.reply === 'function' ? options.reply(state.step, text, state) : defaultReply(state.step)
      state.answers = [...(state.answers ?? []), reply].slice(-50)
      state.idle = true
      write(state)
      log?.debug?.(`假 agent 走到第 ${state.step} 步`)
      return { ok: true, mode: 'foreground', detail: `假 agent 第 ${state.step} 步完成`, answer: reply, exitCode: 0 }
    },

    async capabilities() {
      return `状态文件：${stateFile}\n步骤：${read().step}`
    },
  }
}

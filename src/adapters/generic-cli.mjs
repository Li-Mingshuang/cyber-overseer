/**
 * 通用 CLI 适配器：把**任意**命令行 agent 纳入监工。
 *
 * 适用形态：任何"给它一段提示词、它干活、它退出"的程序（自研脚本、aider、gemini-cli、
 * 甚至 `bash -c`）。这是最不挑食、最稳的一条通道，也是无人值守场景的首选：
 * 每一鞭起一个干净进程，记忆全在工作区（PLAN.md + 代码 + git）。
 *
 * 配置：
 * ```js
 * agent: {
 *   adapter: 'generic-cli',
 *   options: {
 *     // 抽鞭命令模板；{text} 会被替换成鞭子内容（超长时自动改走 stdin）
 *     command: ['my-agent', '--resume', '{session}', '{text}'],
 *     session: 'demo',              // 固定会话名（可选）
 *     useStdin: false,              // true 时把鞭子写进 stdin，命令模板里不要放 {text}
 *     // 只在"你没法从命令 stdout 拿到回答"时才需要：一条打印回答的命令
 *     readCommand: ['tail', '-n', '200', 'agent.log'],
 *   },
 * }
 * ```
 *
 * @module cyber-overseer/adapters/generic-cli
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { run } from '../util/proc.mjs'
import { clip, oneLine, stripAnsi } from '../util/text.mjs'
import { createCache, probeFail, probeOk } from './base.mjs'

export const id = 'generic-cli'
export const label = '通用 CLI 循环'
export const docs = '按模板起进程抽鞭，stdout 即回答；对任何 CLI agent 成立'

/**
 * @param {{config:any, cwd:string, log?:any}} ctx
 * @returns {import('./base.mjs').Adapter}
 */
export function createGenericCliAdapter(ctx) {
  const { config, cwd, log } = ctx
  const options = config.agent?.options ?? {}
  const cache = createCache(500)
  const answerFile = resolve(cwd, options.answerFile ?? '.cyber/agent-last-answer.txt')
  const sessionFile = resolve(cwd, options.sessionFile ?? '.cyber/agent-session.txt')

  const readAnswer = () => {
    try { return readFileSync(answerFile, 'utf8') } catch { return '' }
  }
  const writeAnswer = (text) => {
    mkdirSync(dirname(answerFile), { recursive: true })
    writeFileSync(answerFile, String(text ?? ''), 'utf8')
  }
  const readSessionId = () => {
    if (options.session) return String(options.session)
    try { return readFileSync(sessionFile, 'utf8').trim() } catch { return '' }
  }

  return {
    id,
    label,
    docs,

    async probe() {
      const command = options.command
      if (!Array.isArray(command) || command.length === 0) {
        return probeFail('agent.options.command 未配置（需要非空数组，例如 ["my-agent","{text}"]）', [
          '示例：agent: { adapter: "generic-cli", options: { command: ["node", "scripts/agent.mjs", "{text}"] } }',
        ])
      }
      return probeOk(`命令模板：${command.join(' ')}${options.useStdin ? '（鞭子走 stdin）' : ''}`, options.readCommand ? [] : [
        '未配置 readCommand：监工只能读到该命令的 stdout 作为"最后一次回答"',
      ])
    },

    async listSessions() {
      return [{ id: readSessionId() || '(默认)', title: options.title ?? '通用 CLI 会话', cwd, updatedAt: Date.now() }]
    },

    async resolveSession() {
      return { id: readSessionId() || '(默认)', title: options.title ?? null, cwd, updatedAt: Date.now() }
    },

    async readState(session) {
      // 优先用 readCommand（适合 agent 自己写日志、stdout 不吐回答的情况）
      if (options.readCommand?.length) {
        const result = await run(options.readCommand[0], options.readCommand.slice(1).map(a => fill(a, '', session)), {
          cwd, timeoutMs: options.readTimeoutMs ?? 60000,
        })
        const text = stripAnsi(result.stdout).trim()
        return { status: 'idle', turn: null, lastAnswer: text, lastUserMessage: null, session, extra: { readVia: 'readCommand' } }
      }
      const answer = readAnswer()
      return {
        // 前台型适配器：两次抽鞭之间没有"正在运行的 agent"，空闲是常态而不是异常
        status: 'idle',
        turn: null,
        lastAnswer: answer,
        lastUserMessage: null,
        session,
        extra: { readVia: 'answerFile', chars: answer.length },
      }
    },

    async whip(text, session, engineCtx) {
      const template = options.command
      const useStdin = options.useStdin === true
      const args = template.map(part => fill(String(part), useStdin ? '' : text, session)).filter(a => a !== '')
      const [command, ...rest] = args
      log?.step?.(`通用 CLI 抽鞭：${oneLine(args.join(' '), 160)}`)

      const result = await run(command, rest, {
        cwd,
        timeoutMs: options.timeoutMs ?? (engineCtx?.config?.guard?.waitForAgentIdleMs ?? 3 * 60 * 60 * 1000),
        signal: engineCtx?.signal,
        input: useStdin ? text : undefined,
        env: { ...process.env, ...(options.env ?? {}) },
        maxOutput: 4 * 1024 * 1024,
        onStdout: options.echo ? (chunk) => log?.debug?.(chunk.trimEnd()) : undefined,
      })

      const answer = stripAnsi(result.stdout).trim()
      if (answer) writeAnswer(answer)
      cache.invalidate()
      return {
        ok: result.code === 0 || answer.length > 0,
        mode: 'foreground',
        detail: `命令退出码 ${result.code}${result.timedOut ? '（超时被杀）' : ''}${result.stderr ? `；stderr: ${oneLine(result.stderr, 160)}` : ''}`,
        answer: clip(answer, 20000),
        exitCode: result.code,
      }
    },

    async capabilities() {
      return [
        `抽鞭命令：${(options.command ?? []).join(' ')}`,
        options.readCommand ? `读回答命令：${options.readCommand.join(' ')}` : `读回答：${answerFile}`,
        '模式：前台（每次抽鞭跑完一整轮）',
      ].join('\n')
    },
  }
}

function fill(part, text, session) {
  return part
    .replace(/\{text\}/g, text)
    .replace(/\{session\}/g, session?.id ?? '')
    .replace(/\{cwd\}/g, session?.cwd ?? process.cwd())
}

/** 记录/读取"外部 agent 自己的会话 id"（有些 agent 会把自己的 resume id 写进文件）。 */
export function rememberSession(cwd, sessionId, file = '.cyber/agent-session.txt') {
  const target = resolve(cwd, file)
  if (!existsSync(dirname(target))) mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, String(sessionId), 'utf8')
}

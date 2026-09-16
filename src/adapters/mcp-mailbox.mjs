/**
 * MCP 信箱适配器 + 内置 MCP 服务端。
 *
 * 思路：凡是支持 MCP 的 agent（Cursor / codex / opencode / Claude 系），都可以给它挂一个
 * **本地的 MCP 服务**，这个服务只做两件事：
 *
 *   - `overseer_check`：agent 在结束回合前调用 → 返回"监工的最新指令"（就是鞭子）。
 *     如果监工说"收工了"，返回 `done: true`，agent 就可以安心停下。
 *   - `overseer_report`：agent 汇报本轮做了什么（一句话 + 证据 + 是否受阻），
 *     监工据此判定，而不是去猜它的自由文本。
 *
 * 这样"抽鞭"退化成"写一个文件"，"读回答"退化成"读一行 JSONL"——
 * 跨 agent 通用、零副作用、不用抢焦点、不用解析各家私有格式。代价是需要 agent 配合
 * （在规则文件里要求它每回合调用 `overseer_check`，见 `templates/`）。
 *
 * @module cyber-overseer/adapters/mcp-mailbox
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { probeOk } from './base.mjs'
import { isoLocal } from '../util/time.mjs'

export const id = 'mcp-mailbox'
export const label = 'MCP 信箱'
export const docs = '给 agent 挂 MCP 服务：它每回合来取指令、汇报进度；监工只读写文件'

const PROTOCOL_VERSION = '2024-11-05'

/**
 * @param {{config:any, cwd:string, log?:any}} ctx
 * @returns {import('./base.mjs').Adapter}
 */
export function createMcpMailboxAdapter(ctx) {
  const { config, cwd, log } = ctx
  const options = config.agent?.options ?? {}
  const dir = resolve(cwd, config.journal?.dir ?? '.cyber')
  const instructionFile = join(dir, 'inbox-instruction.md')
  const reportFile = join(dir, 'agent-reports.jsonl')
  const state = options.stateFile ? resolve(cwd, options.stateFile) : join(dir, 'inbox-state.json')

  const readState = () => {
    try { return JSON.parse(readFileSync(state, 'utf8')) } catch { return { round: 0, lastWhipAt: 0, done: false } }
  }
  const writeState = (next) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(state, JSON.stringify(next, null, 2), 'utf8')
  }
  const readReports = () => {
    try {
      return readFileSync(reportFile, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    } catch { return [] }
  }

  return {
    id,
    label,
    docs,

    async probe() {
      return probeOk(`信箱目录：${dir}（指令 ${instructionFile}，汇报 ${reportFile}）`, [
        '需要在 agent 侧挂上 MCP 服务：`cw mcp --serve`；并在规则文件里要求它每回合调用 overseer_check',
        '参考 templates/cursor-rule-overseer.mdc 与 templates/AGENTS-snippet.md',
      ])
    },

    async listSessions() {
      return [{ id: 'mcp-mailbox', title: 'MCP 信箱（agent 主动来取指令）', cwd, updatedAt: Date.now() }]
    },

    async resolveSession() {
      return { id: 'mcp-mailbox', title: null, cwd, updatedAt: Date.now() }
    },

    async readState(session) {
      const st = readState()
      const reports = readReports()
      const lastReport = reports.at(-1) ?? null
      const pending = existsSync(instructionFile) && (st.lastWhipAt ?? 0) > (lastReport?.at ?? 0)
      return {
        status: pending ? 'working' : 'idle',
        turn: st.round ?? reports.length,
        lastAnswer: lastReport ? renderReport(lastReport) : '',
        lastUserMessage: st.lastWhipText ?? null,
        session,
        extra: {
          pendingInstruction: pending,
          reports: reports.length,
          lastReportAt: lastReport?.at ?? null,
          instructionFile,
          reportFile,
        },
      }
    },

    async whip(text, session) {
      mkdirSync(dir, { recursive: true })
      const st = readState()
      const round = (st.round ?? 0) + 1
      writeFileSync(instructionFile, [
        `# 赛博监工指令（第 ${round} 轮）`,
        '',
        `生成时间：${isoLocal()}`,
        '',
        text,
        '',
        '---',
        '',
        '做完之后请调用 MCP 工具 `overseer_report` 汇报本轮结果（一句话 + 证据 + 是否受阻）。',
      ].join('\n'), 'utf8')
      writeState({ ...st, round, lastWhipAt: Date.now(), lastWhipText: text, done: false })
      log?.ok?.(`已写入信箱指令：${instructionFile}（第 ${round} 轮）`)
      return { ok: true, mode: 'inject', detail: `指令已写入 ${instructionFile}，等 agent 调用 overseer_check 取走` }
    },

    async capabilities() {
      return [
        `指令文件：${instructionFile}`,
        `汇报文件：${reportFile}`,
        'MCP 服务：`cw mcp --serve`（stdio）',
        `已收到汇报：${readReports().length} 条`,
      ].join('\n')
    },
  }
}

/** 把一条汇报渲染成判定器能读的文本。 */
export function renderReport(report) {
  const lines = []
  if (report.summary) lines.push(String(report.summary))
  if (report.done) lines.push('（agent 声明：已完成）')
  if (report.blocked) lines.push(`（agent 声明：受阻 — ${report.blockedReason ?? '未说明'}）`)
  if (report.evidence) lines.push(`证据：${typeof report.evidence === 'string' ? report.evidence : JSON.stringify(report.evidence)}`)
  if (report.files?.length) lines.push(`改动文件：${report.files.join(', ')}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// MCP 服务端（stdio，newline-delimited JSON-RPC）

/**
 * 启动 MCP 服务端（阻塞读 stdin 直到 EOF）。
 * @param {{cwd:string, log?:any, done?:boolean}} opts
 */
export async function serveMcpMailbox(opts) {
  const { cwd } = opts
  const log = opts.log
  const dir = resolve(cwd, '.cyber')
  const instructionFile = join(dir, 'inbox-instruction.md')
  const reportFile = join(dir, 'agent-reports.jsonl')

  const tools = [
    {
      name: 'overseer_check',
      description: '向赛博监工索取"下一条该做什么"。在结束你的回合之前调用它；若返回 done=true，说明任务已完成，可以停下。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'overseer_report',
      description: '向赛博监工汇报本轮结果（一句话总结 + 证据 + 是否受阻）。每次实质性工作结束后调用。',
      inputSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '本轮做了什么（一句话）' },
          evidence: { type: 'string', description: '证据：命令输出、测试结果、文件路径等' },
          done: { type: 'boolean', description: '你是否认为方案已全部完成' },
          blocked: { type: 'boolean', description: '是否被卡住需要人类介入' },
          blockedReason: { type: 'string', description: '受阻原因' },
          files: { type: 'array', items: { type: 'string' }, description: '本轮改动的文件' },
        },
        required: ['summary'],
        additionalProperties: false,
      },
    },
  ]

  const send = (message) => {
    process.stdout.write(JSON.stringify(message) + '\n')
  }
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
  const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })

  const handle = (message) => {
    const { id, method, params } = message
    switch (method) {
      case 'initialize':
        reply(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'cyber-overseer', version: '0.1.0' },
        })
        return
      case 'notifications/initialized':
        return
      case 'ping':
        reply(id, {})
        return
      case 'tools/list':
        reply(id, { tools })
        return
      case 'tools/call': {
        const name = params?.name
        const args = params?.arguments ?? {}
        if (name === 'overseer_check') {
          let instruction = ''
          try { instruction = readFileSync(instructionFile, 'utf8') } catch { instruction = '' }
          const text = instruction.trim()
            ? instruction
            : '监工暂时没有新指令。如果方案文档（PLAN.md）里还有未勾选的条目，就继续做下一项；全部完成就停下。'
          reply(id, { content: [{ type: 'text', text }] })
          return
        }
        if (name === 'overseer_report') {
          mkdirSync(dir, { recursive: true })
          const record = { at: Date.now(), iso: isoLocal(), ...args }
          writeFileSync(reportFile, JSON.stringify(record) + '\n', { flag: 'a' })
          reply(id, { content: [{ type: 'text', text: '已记录。' }] })
          return
        }
        fail(id, -32601, `未知工具：${name}`)
        return
      }
      default:
        if (id !== undefined) fail(id, -32601, `未知方法：${method}`)
    }
  }

  let buffer = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      try { handle(JSON.parse(line)) } catch (error) { log?.warn?.(`MCP 消息解析失败：${error?.message ?? error}`) }
    }
  }
  log?.info?.('MCP 信箱服务端退出（stdin 关闭）')
}

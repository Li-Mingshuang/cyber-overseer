/**
 * 测试夹具：最小的 DSH SDK JSON-RPC 服务端（stdio + newline-delimited JSON-RPC 2.0）。
 *
 * ⚠️ 与 `fake-acp-agent.mjs` 一样，**故意放在 fixtures/**：它是常驻 stdio 服务端，
 * 放进 test/ 会让测试 runner 永远等下去。
 *
 * 它忠实复刻 DSH 的两个关键行为，用来把协议契约钉死：
 *  1. **并发处理帧**（对每行 `void handle(line)` 不 await）——所以客户端必须先等
 *     `initialize` 响应再发 `session/prompt`，否则会先收到 prompt（本夹具会让 initialize
 *     的响应延迟 60ms，把这个竞态放大到可观测）；
 *  2. prompt 会先推一串 `session.event` / `session.status`（注入回显 + turn 边界 + 回答），
 *     最后才回 JSON-RPC 响应——和真实输出一致。
 *
 * 行为开关（按 prompt 文本）：
 *   - 含 SILENT      → 只回响应，不推任何事件（用来测"注入成功但 agent 没动"）
 *   - 含 ERROR       → 回一条 JSON-RPC 错误（-32603）
 *   - 含 FAIL_TURN   → 事件以 turn/end reason=error 结束（用来测"判定为出错"）
 *
 * 环境变量：
 *   FAKE_DSH_LOG=<file>  把收到的每一帧追加进去（供测试断言顺序）
 *
 * @module fixtures/fake-dsh-jsonrpc
 */

import { appendFileSync } from 'node:fs'

const logFile = process.env.FAKE_DSH_LOG
const log = (entry) => {
  if (!logFile) return
  try { appendFileSync(logFile, JSON.stringify({ at: Date.now(), ...entry }) + '\n', 'utf8') } catch { /* 忽略 */ }
}

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')
const sessions = new Set()
let seq = 0
const nextSeq = () => seq++

function emit(sessionId, type, data) {
  send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type, seq: nextSeq(), time: Date.now(), data } } })
}

function setStatus(sessionId, status) {
  send({ jsonrpc: '2.0', method: 'session.status', params: { sessionId, status } })
}

async function handlePrompt(id, params) {
  const text = (params?.contentBlocks ?? []).map(b => b?.text ?? '').join('')
  const sessionId = params?.sessionId
  sessions.add(sessionId)
  log({ dir: 'in', method: 'session/prompt', id, sessionId, text })

  if (text.includes('SILENT')) {
    send({ jsonrpc: '2.0', id, result: { messageId: `msg-${nextSeq()}` } })
    return
  }
  if (text.includes('ERROR')) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: 'fixture: turn failed' } })
    return
  }

  // 真实顺序：注入回显 → 状态 running → turn/start → assistant/message → status idle → turn/end
  emit(sessionId, 'agent/inbox/spliced', {
    target: 'next-turn', start: 0,
    inserted: [{ content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user', id: `u-${nextSeq()}` }],
  })
  setStatus(sessionId, 'running')
  emit(sessionId, 'turn/start', { turn: 1 })
  await new Promise(r => setTimeout(r, 10))
  const answer = `假 DSH JSON-RPC 收到：${text.slice(0, 40)}。这一步做完了。`
  emit(sessionId, 'assistant/message', {
    turn: 1, step: 1,
    message: { role: 'assistant', content: [{ type: 'text', text: answer }] },
  })
  await new Promise(r => setTimeout(r, 10))
  emit(sessionId, 'turn/end', {
    turn: 1,
    reason: text.includes('FAIL_TURN')
      ? { kind: 'error', error: { code: 'FIXTURE', message: 'fixture turn failed' } }
      : { kind: 'completed' },
  })
  setStatus(sessionId, 'idle')
  send({ jsonrpc: '2.0', id, result: { messageId: `msg-${nextSeq()}` } })
}

async function handle(message) {
  const { id, method, params, result, error } = message
  log({ dir: 'in', method: method ?? (result !== undefined ? '(response)' : '(other)'), id })

  switch (method) {
    case 'initialize':
      // 故意延迟：放大"先发 prompt 再等 initialize"的竞态（真实 DSH 也是并发处理的）
      await new Promise(r => setTimeout(r, 60))
      send({
        jsonrpc: '2.0',
        id,
        result: { serverInfo: { name: 'fake-dsh-jsonrpc-server', version: '0.0.1' }, cwd: params?.cwd ?? null },
      })
      return
    case 'session/prompt':
      await handlePrompt(id, params)
      return
    case 'shutdown':
      send({ jsonrpc: '2.0', id, result: {} })
      return
    default:
      if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    // 忠实复刻 DSH：不 await，帧之间并发处理（这正是客户端必须串行的原因）
    try { void handle(JSON.parse(line)) } catch { /* 忽略坏帧 */ }
  }
})
process.stdin.on('end', () => process.exit(0))

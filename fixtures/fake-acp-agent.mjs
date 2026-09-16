/**
 * 测试夹具：一个最小的 ACP 服务端（stdio + newline-delimited JSON-RPC）。
 *
 * ⚠️ 它**故意放在 fixtures/** 而不是 test/ 目录下：Node 的测试发现规则会把 test/ 目录里的
 * 所有 .mjs 文件都当成测试执行，而本文件是**常驻的 stdio 服务端**、会一直读 stdin 不退出——
 * 被当成测试跑会让整个 runner 永远等下去。
 * （这个坑真实踩过，症状是：每个测试文件单跑都过，一次跑全部却挂死。别把它移回 test/。）
 *
 * 它不调用任何模型，只按 prompt 文本决定行为，用来把"监工 ↔ ACP agent"的协议契约钉死：
 *   - 普通文本      → 分几块发 session/update 的 agent_message_chunk，最后回 stopReason=end_turn
 *   - 含 PERMISSION → 先反向发 session/request_permission，按客户端选择继续
 *   - 含 ERROR      → 回一条 JSON-RPC 错误（模拟 "turn failed"）
 *   - 含 SILENT     → 不回（用来测超时）
 *   - session/cancel 通知 → 记一笔
 *
 * 环境变量：
 *   FAKE_ACP_LOG=<file>   把收到的每一帧（方向 + 方法）追加到该文件，供测试断言
 *
 * @module fixtures/fake-acp-agent
 */

import { appendFileSync } from 'node:fs'

const logFile = process.env.FAKE_ACP_LOG
const log = (entry) => {
  if (!logFile) return
  try { appendFileSync(logFile, JSON.stringify({ at: Date.now(), ...entry }) + '\n', 'utf8') } catch { /* 忽略 */ }
}

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')
const sessions = new Set()
let nextServerRequestId = 1000

/** 拆成小块，模拟流式输出。 */
function chunk(text, size = 8) {
  const parts = []
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size))
  return parts.length ? parts : ['']
}

async function handlePrompt(id, params) {
  const text = (params?.prompt ?? []).map(p => p.text ?? '').join('')
  const sessionId = params?.sessionId
  log({ dir: 'in', method: 'session/prompt', sessionId, text })

  if (text.includes('SILENT')) return // 故意不回：测试超时

  if (text.includes('PERMISSION')) {
    const requestId = nextServerRequestId++
    send({
      jsonrpc: '2.0',
      id: requestId,
      method: 'session/request_permission',
      params: {
        sessionId,
        toolCall: { toolCallId: 'call_fixture_1' },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      },
    })
    // 服务端等客户端的响应：这里把"客户端怎么答的"记进日志，供测试断言
    await new Promise((resolveWait) => {
      pendingPermission = { id: requestId, resolve: resolveWait }
      setTimeout(resolveWait, 5000)
    })
    if (!text.includes('继续')) return
  }

  if (text.includes('ERROR')) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error: turn failed: fixture error' } })
    return
  }

  const answer = `假 ACP 收到：${text.slice(0, 40)}。我做完了这一步。`
  for (const part of chunk(answer)) {
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: part } } },
    })
    await new Promise(r => setTimeout(r, 5))
  }
  send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
}

let pendingPermission = null

async function handle(message) {
  const { id, method, params, result, error } = message
  log({ dir: 'in', method: method ?? (result !== undefined ? '(response)' : '(other)'), id })
  switch (method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: 'fake-acp-agent', version: '0.0.1' },
          agentCapabilities: { promptCapabilities: { image: false, audio: false, embeddedContext: false } },
          authMethods: [],
        },
      })
      return
    case 'authenticate':
      send({ jsonrpc: '2.0', id, result: {} })
      return
    case 'session/new': {
      const sessionId = `sess-fake-${sessions.size + 1}`
      sessions.add(sessionId)
      log({ dir: 'out', method: 'session/new', sessionId, cwd: params?.cwd })
      send({ jsonrpc: '2.0', id, result: { sessionId } })
      return
    }
    case 'session/prompt':
      void handlePrompt(id, params)
      return
    case 'session/cancel':
      log({ dir: 'in', method: 'session/cancel', sessionId: params?.sessionId })
      return
    default:
      if (result !== undefined && pendingPermission && id === pendingPermission.id) {
        log({ dir: 'in', method: 'permission-response', id, result })
        pendingPermission.resolve()
        pendingPermission = null
        return
      }
      if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunkText) => {
  buffer += chunkText
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    try { void handle(JSON.parse(line)) } catch { /* 忽略坏帧 */ }
  }
})
process.stdin.on('end', () => process.exit(0))

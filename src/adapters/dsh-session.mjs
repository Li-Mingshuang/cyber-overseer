/**
 * DSH 会话文件解析（`$DSH_HOME/sessions/<slug>/<session-id>/session.jsonl.zstd`）。
 *
 * 事实依据（来自 `docs/recon/dsh-session-storage.md` 的实测结论）：
 *  - 文件是**拼接的多帧 zstd**，必须逐帧解码（Node 自带解码器只吃第一帧）；
 *  - 每行是一条事件 `{type, seq, time, data}`，seq 从 0 连续递增；
 *  - "最后一次回答"= **反向**找第一条含 `type:'text'` 块的 `assistant/message`
 *    （最后一条 assistant/message 可能只含 tool-call，没有文本）；
 *  - 忙/闲 = 折叠 `turn/start` / `turn/end`，**最后一个胜出**；
 *  - 审批中 = 有 `approval/asked` 的 id 没有对应 `approval/decided`；
 *  - 等人类回答 = 有未配对的 `ask_user_question` / `exit_plan_mode` 工具调用。
 *
 * 本模块是纯函数（输入文本/字节，输出结构），便于单测与复用。
 *
 * @module cyber-overseer/adapters/dsh-session
 */

import { decompressFrames } from '../util/zstd-frames.mjs'

/** 会"等人类回话"的工具名。 */
const HUMAN_INPUT_TOOLS = new Set(['ask_user_question', 'exit_plan_mode'])

/**
 * 把多帧 zstd 字节解码成事件数组。
 * @param {Buffer} buf
 * @returns {{records:any[], info:ReturnType<typeof decompressFrames>}}
 */
export function decodeSessionBytes(buf) {
  const info = decompressFrames(buf)
  return { records: parseJsonl(info.text), info }
}

/**
 * 宽容地按行解析 JSONL（半截行直接丢）。
 * @param {string} text
 * @returns {any[]}
 */
export function parseJsonl(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try { out.push(JSON.parse(trimmed)) } catch { /* 半截行/坏行 */ }
  }
  return out
}

/**
 * 把事件流折叠成"监工需要的状态"。
 * @param {any[]} records
 * @param {{wantFullTranscript?:boolean}} [opts]
 */
export function summarizeSession(records, opts = {}) {
  const header = records.find(r => r?.type === 'session') ?? null
  const userMessages = []
  const assistantMessages = []
  const todos = []
  const goals = []
  const approvalsAsked = new Map()
  const approvalsDecided = new Set()
  const humanInputCalls = new Map()
  const humanInputResolved = new Set()
  let turnStarted = null
  let turnEnded = null
  let lastTitle = null
  let lastTurnEndReason = null
  let lastSlot = null
  let segment = null
  let knownSlotCount = 0

  for (const record of records) {
    const type = record?.type
    const data = record?.data ?? {}
    switch (type) {
      case 'user/message': {
        const text = textOfBlocks(data.content)
        userMessages.push({ text, at: record.time ?? null, id: data.id ?? null, source: data.source?.kind ?? null })
        lastSlot = 'user'
        break
      }
      case 'assistant/message': {
        const blocks = Array.isArray(data.message?.content) ? data.message.content : []
        const text = textOfBlocks(blocks)
        const toolCalls = blocks.filter(b => b?.type === 'tool-call').map(b => ({ name: b.name, id: b.id, arguments: b.arguments }))
        assistantMessages.push({
          text,
          turn: data.turn ?? null,
          step: data.step ?? null,
          at: record.time ?? null,
          toolCalls,
          usage: data.usage ?? null,
        })
        lastSlot = 'assistant'
        break
      }
      case 'tool/call': {
        const name = data.name ?? data.toolName ?? null
        if (name && HUMAN_INPUT_TOOLS.has(name)) humanInputCalls.set(data.callId ?? data.id ?? String(record.seq), { name, at: record.time })
        lastSlot = 'tool'
        break
      }
      case 'tool/result': {
        const id = data.callId ?? data.id ?? null
        if (id) humanInputResolved.add(id)
        lastSlot = 'tool'
        break
      }
      case 'turn/start':
        turnStarted = { turn: data.turn ?? null, at: record.time ?? null, seq: record.seq }
        break
      case 'turn/end':
        turnEnded = { turn: data.turn ?? null, at: record.time ?? null, seq: record.seq, reason: data.reason ?? null }
        lastTurnEndReason = data.reason ?? null
        break
      case 'session/title':
        if (data.title) lastTitle = data.title
        break
      case 'todo/write':
        todos.length = 0
        if (Array.isArray(data.todos)) for (const todo of data.todos) todos.push({ content: todo.content, status: todo.status })
        break
      case 'goal/change':
        goals.push({ operation: data.operation, goal: data.goal ?? null, roundsStarted: data.roundsStarted ?? null, at: record.time ?? null })
        break
      case 'approval/asked': {
        const id = data.id ?? data.requestId ?? data.approvalId ?? String(record.seq)
        approvalsAsked.set(id, { id, tool: data.tool ?? data.toolName ?? null, at: record.time ?? null, detail: data })
        break
      }
      case 'approval/decided': {
        const id = data.id ?? data.requestId ?? data.approvalId ?? null
        if (id) approvalsDecided.add(id)
        break
      }
      case 'step/start':
      case 'step/end':
        knownSlotCount++
        break
      default:
        break
    }
  }

  const openTurn = !turnEnded || (turnStarted && turnEnded && (turnStarted.seq ?? 0) > (turnEnded.seq ?? 0))
  const pendingApprovals = [...approvalsAsked.values()].filter(a => !approvalsDecided.has(a.id))
  const pendingHumanInput = [...humanInputCalls.entries()].filter(([id]) => !humanInputResolved.has(id))
  const lastAssistantText = [...assistantMessages].reverse().find(m => m.text && m.text.trim().length > 0) ?? null
  const lastAssistantAny = assistantMessages.at(-1) ?? null
  const lastUser = userMessages.at(-1) ?? null

  let status = 'unknown'
  if (openTurn) {
    if (pendingApprovals.length) status = 'awaiting-approval'
    else if (pendingHumanInput.length) status = 'awaiting-input'
    else status = 'working'
  } else {
    // 只有真正的 error 才算错；aborted/user（主人自己按了停止）与 max-tokens 都只是"停下来了"
    const kind = lastTurnEndReason?.kind
    status = kind === 'error' || kind === 'blocked' ? 'error' : 'idle'
  }

  const transcript = opts.wantFullTranscript
    ? records
      .filter(r => r.type === 'user/message' || r.type === 'assistant/message' || r.type === 'turn/end' || r.type === 'turn/start')
      .map(r => ({
        role: r.type === 'user/message' ? 'user' : r.type === 'assistant/message' ? 'assistant' : 'system',
        type: r.type,
        at: r.time ?? null,
        text: r.type === 'assistant/message' ? textOfBlocks(r.data?.message?.content) : textOfBlocks(r.data?.content),
        reason: r.data?.reason ?? undefined,
      }))
    : null

  return {
    header,
    sessionId: header?.id ?? null,
    cwd: header?.cwd ?? null,
    createdAt: header?.createdAt ?? null,
    agentPreset: header?.agentPreset ?? null,
    title: lastTitle,
    userMessages,
    assistantMessages,
    lastAnswer: lastAssistantText?.text ?? '',
    lastAnswerTurn: lastAssistantText?.turn ?? null,
    lastAnswerAt: lastAssistantText?.at ?? null,
    lastAssistantAny,
    lastUserMessage: lastUser?.text ?? null,
    turn: {
      open: openTurn,
      started: turnStarted,
      ended: turnEnded,
      endReason: lastTurnEndReason,
      current: openTurn ? (turnStarted?.turn ?? null) : (turnEnded?.turn ?? null),
      count: Math.max(turnStarted?.turn ?? 0, turnEnded?.turn ?? 0),
    },
    todos,
    goal: goals.at(-1)?.goal ?? null,
    goalHistory: goals,
    pendingApprovals,
    pendingHumanInput: pendingHumanInput.map(([id, info]) => ({ id, ...info })),
    status,
    lastSlot,
    eventCount: records.length,
    transcript,
  }
}

/** 把消息块数组里的 text 块拼起来。 */
export function textOfBlocks(blocks) {
  if (typeof blocks === 'string') return blocks
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter(b => b && (b.type === 'text' || b.type === 'input_text' || b.type === 'output_text'))
    .map(b => b.text ?? '')
    .join('')
}

/**
 * 从方案文档里取"给 DSH 会话"的标题（DSH 会把第一条用户消息当标题）。
 * @param {any} plan
 * @param {number} [max]
 */
export function titleFromPlan(plan, max = 60) {
  const base = plan?.title ?? plan?.objective ?? '未命名任务'
  return String(base).split('\n')[0].slice(0, max)
}

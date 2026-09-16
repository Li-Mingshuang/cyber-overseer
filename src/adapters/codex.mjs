/**
 * OpenAI Codex 适配器。
 *
 * 读：`$CODEX_HOME/state_5.sqlite` 的 `threads` 表是**权威索引**（cwd → rollout_path），
 *     正文在 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`（每行一条事件）。
 *     注意三个坑（都来自实测）：
 *       · `threads.cwd` 带 Windows `\\?\` 前缀，比较前必须剥掉；
 *       · rollout 的 **mtime 停在创建时刻**，只有 ctime 随追加走 → 用 mtime 判活会永远误判成死；
 *       · `user_message` 事件**没有 turn_id**，要归给前一个 `task_started`。
 *
 * 写：`codex exec resume <session-id> -C <workspace> ... "<prompt>"`（前台跑完一轮）。
 *
 * @module cyber-overseer/adapters/codex
 */

import { existsSync, readdirSync, readFileSync as nodeReadFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { run, which } from '../util/proc.mjs'
import { clip, oneLine, stripAnsi } from '../util/text.mjs'
import { openReadOnly, loadSqlite } from '../util/sqlite.mjs'
import { createCache, probeFail, probeOk, selectSession } from './base.mjs'

export const id = 'codex'
export const label = 'OpenAI Codex CLI'
export const docs = '读 state_5.sqlite + rollout jsonl；鞭子走 `codex exec resume`'

/** 巨型行（21MB 的 custom_tool_call_output）不解析，直接跳过，避免卡死/吃内存。 */
const MAX_LINE_BYTES = 1 << 20

/**
 * @param {{config:any, cwd:string, log?:any}} ctx
 * @returns {import('./base.mjs').Adapter}
 */
export function createCodexAdapter(ctx) {
  const { config, cwd, log } = ctx
  const options = config.agent?.options ?? {}
  const home = resolve(process.env.CODEX_HOME ?? join(homedir(), '.codex'))
  const cache = createCache(1500)
  let sqliteMod = null

  const sessionsRoot = () => join(home, 'sessions')
  const stateDb = () => join(home, 'state_5.sqlite')
  const bin = () => options.codexBin ?? process.env.CW_CODEX_BIN ?? which('codex')

  /** 从文件名解析会话 id 与本地时间戳。 */
  function scanRollouts() {
    const root = sessionsRoot()
    if (!existsSync(root)) return []
    const out = []
    const walk = (dir, depth) => {
      if (depth > 3) return
      for (const entry of safeReaddir(dir)) {
        const full = join(dir, entry)
        let stat
        try { stat = statSync(full) } catch { continue }
        if (stat.isDirectory()) { walk(full, depth + 1); continue }
        if (!entry.startsWith('rollout-') || !entry.endsWith('.jsonl')) continue
        const m = /^rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(.+)\.jsonl$/.exec(entry)
        out.push({
          path: full,
          size: stat.size,
          // 实测：rollout 的 mtime 不随追加更新，ctime 才更新
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs,
          updatedAt: Math.max(stat.mtimeMs, stat.ctimeMs),
          sessionId: m?.[5] ?? entry,
          createdAt: m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}`) : stat.birthtimeMs,
        })
      }
    }
    walk(root, 0)
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** 索引表查询（不可用时返回 null，由调用方回退到目录扫描）。 */
  function queryIndex() {
    const file = stateDb()
    if (!existsSync(file) || !sqliteMod) return null
    try {
      const handle = openReadOnly(file, sqliteMod)
      try {
        return handle.db.prepare(
          `select id, rollout_path, cwd, title, created_at_ms, updated_at_ms, source, model, archived
           from threads order by updated_at_ms desc limit 200`,
        ).all()
      } finally {
        handle.close()
        if (handle.scratch) { /* openReadOnly 已清理句柄，临时目录交给 GC 不阻塞主流程 */ }
      }
    } catch (error) {
      log?.debug?.(`codex 索引读取失败（回退目录扫描）：${error?.message ?? error}`)
      return null
    }
  }

  function listSessionsSync() {
    const rollouts = scanRollouts()
    const index = queryIndex()
    const byId = new Map(rollouts.map(r => [r.sessionId, r]))
    const out = []
    if (index?.length) {
      for (const row of index) {
        if (row.archived) continue
        const hit = byId.get(row.id)
        out.push({
          id: row.id,
          title: row.title ?? null,
          cwd: String(row.cwd ?? '').replace(/^\\\\\?\\/, ''),
          updatedAt: row.updated_at_ms ?? hit?.updatedAt ?? 0,
          path: row.rollout_path ?? hit?.path ?? null,
          size: hit?.size ?? 0,
          raw: { source: row.source, model: row.model, indexed: true },
        })
      }
    }
    for (const r of rollouts) {
      if (out.some(s => s.id === r.sessionId)) continue
      out.push({ id: r.sessionId, title: null, cwd: null, updatedAt: r.updatedAt, path: r.path, size: r.size, raw: { indexed: false } })
    }
    return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  }

    function readRollout(file) {
    const key = `${file}:${safeSize(file)}:${Math.max(safeStat(file)?.mtimeMs ?? 0, safeStat(file)?.ctimeMs ?? 0)}`
    return cache.get(key, () => parseRolloutSync(file))
  }

  /** 同步版本（引擎的 readState 是 async，但内部用同步读更简单且文件不大）。 */
  function parseRolloutSync(file) {
    const result = { sessionId: null, sessionCwd: null, turns: [], lastTs: null, bigLines: 0, badLines: 0 }
    // 用 node:fs 同步读（readline 的异步流在缓存回调里不方便），大文件时按行切分
    const text = readText(file)
    const turns = new Map()
    const order = []
    let lastStarted = null
    const ensureTurn = (turnId) => {
      if (!turns.has(turnId)) {
        turns.set(turnId, { turnId, started: null, ended: null, end: null, user: null, final: null, reasoning: [], tools: [] })
        order.push(turnId)
      }
      return turns.get(turnId)
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      if (line.length > MAX_LINE_BYTES) { result.bigLines++; continue }
      let record
      try { record = JSON.parse(line) } catch { result.badLines++; continue }
      if (record.timestamp) result.lastTs = record.timestamp
      const payload = record.payload ?? {}
      if (record.type === 'session_meta') {
        result.sessionId = payload.session_id ?? payload.id ?? result.sessionId
        result.sessionCwd = payload.cwd ?? result.sessionCwd
        continue
      }
      if (record.type === 'event_msg' && payload.type === 'task_started') {
        lastStarted = payload.turn_id
        const turn = ensureTurn(payload.turn_id)
        turn.started = record.timestamp ?? null
        continue
      }
      if (record.type === 'event_msg' && payload.type === 'user_message') {
        const turn = lastStarted ? turns.get(lastStarted) : null
        if (turn && !turn.user) turn.user = payload.message ?? null
        continue
      }
      const turnId = payload.turn_id ?? payload.internal_chat_message_metadata_passthrough?.turn_id ?? null
      if (!turnId) continue
      const turn = ensureTurn(turnId)
      if (record.type === 'event_msg') {
        if (payload.type === 'task_complete') {
          turn.ended = record.timestamp ?? null
          turn.end = 'task_complete'
          turn.final = payload.last_agent_message ?? turn.final
          turn.durationMs = payload.duration_ms ?? null
        } else if (payload.type === 'turn_aborted') {
          turn.ended = record.timestamp ?? null
          turn.end = 'turn_aborted'
          turn.abortReason = payload.reason ?? null
        } else if (payload.type === 'agent_message' && payload.phase === 'final_answer') {
          turn.final = payload.message ?? turn.final
        } else if (payload.type === 'agent_reasoning') {
          turn.reasoning.push(payload.text ?? '')
        }
      } else if (record.type === 'response_item') {
        if (payload.type === 'function_call') turn.tools.push({ name: payload.name, args: clip(payload.arguments ?? '', 300) })
        else if (payload.type === 'custom_tool_call') turn.tools.push({ name: payload.name, args: clip(payload.input ?? '', 300) })
        else if (payload.type === 'message' && payload.role === 'assistant') {
          const text2 = (payload.content ?? []).filter(c => c.type === 'output_text').map(c => c.text).join('\n')
          if (text2) turn.final = text2
        }
      }
    }
    result.turns = order.map(t => turns.get(t))
    return result
  }

  return {
    id,
    label,
    docs,

    async probe() {
      const hints = []
      sqliteMod = await loadSqlite()
      if (!sqliteMod) hints.push('当前 Node 没有 node:sqlite：无法读 codex 的会话索引（会退化为目录扫描）')
      if (!existsSync(home)) return probeFail(`找不到 CODEX_HOME：${home}`, ['设置 CODEX_HOME 或先跑一次 codex'])
      if (!existsSync(sessionsRoot())) hints.push(`没有 sessions 目录（${sessionsRoot()}）：codex 还没跑过？`)
      if (!bin()) hints.push('PATH 里找不到 codex：抽鞭需要它（可用 agent.options.codexBin 指定）')
      const rollouts = scanRollouts()
      if (!rollouts.length) hints.push('没发现任何 rollout 文件')
      const approval = options.approvalPolicy ?? (config.guard?.autoApprove ? 'never' : 'never')
      if (approval === 'never') {
        hints.push('注意：无人值守需要 codex 不弹审批，默认用 `-c approval_policy=never`（等价于全自动放行，风险自负）')
      }
      return probeOk(`CODEX_HOME=${home}，${rollouts.length} 个 rollout，CLI=${bin() ? '已找到' : '缺失'}`, hints)
    },

    async listSessions() {
      return listSessionsSync()
    },

    async resolveSession(wanted) {
      const sessions = listSessionsSync()
      const picked = selectSession(sessions, wanted, { cwd })
      if (picked) {
        // 索引里没带 cwd 的，从 rollout 头行补上
        if (!picked.cwd && picked.path) {
          try {
            const parsed = readRollout(picked.path)
            picked.cwd = parsed.sessionCwd ?? null
            picked.title = picked.title ?? null
          } catch { /* 读不到就算了 */ }
        }
        return picked
      }
      // 索引/目录里都没有：扫一遍头行找 cwd 匹配
      for (const s of sessions) {
        if (!s.path) continue
        try {
          const parsed = readRollout(s.path)
          if (parsed.sessionCwd && resolve(parsed.sessionCwd).toLowerCase() === resolve(cwd).toLowerCase()) return { ...s, cwd: parsed.sessionCwd }
        } catch { /* 继续 */ }
      }
      return null
    },

    async readState(session) {
      if (!session?.path || !existsSync(session.path)) {
        return { status: 'unknown', turn: null, lastAnswer: '', lastUserMessage: null, error: `rollout 不存在：${session?.path ?? '(空)'}` }
      }
      try {
        const parsed = readRollout(session.path)
        const turns = parsed.turns ?? []
        const last = turns.at(-1) ?? null
        const openTurn = turns.filter(t => !t.end).at(-1) ?? null
        const stat = safeStat(session.path)
        const lastAppendMs = Math.max(stat?.ctimeMs ?? 0, Date.parse(parsed.lastTs ?? '') || 0)
        const appendAgeMs = Date.now() - lastAppendMs
        let status = 'idle'
        if (openTurn && appendAgeMs < (options.workingWindowMs ?? 120000)) status = 'working'
        else if (openTurn) status = 'awaiting-input'
        else if (last?.end === 'task_complete') status = 'idle'
        else if (last?.end === 'turn_aborted') status = 'idle'
        else if (!turns.length) status = 'unknown'
        return {
          status,
          turn: turns.length,
          lastAnswer: last?.final ?? '',
          lastUserMessage: last?.user ?? null,
          awaitingInput: status === 'awaiting-input',
          session,
          extra: { appendAgeMs, bigLines: parsed.bigLines, badLines: parsed.badLines, lastEnd: last?.end ?? null },
        }
      } catch (error) {
        return { status: 'unknown', turn: null, lastAnswer: '', lastUserMessage: null, error: `读 rollout 失败：${error?.message ?? error}` }
      }
    },

    async whip(text, session, engineCtx) {
      const codex = bin()
      if (!codex) return { ok: false, mode: 'inject', detail: 'PATH 里找不到 codex（可用 agent.options.codexBin 指定）' }
      const approval = options.approvalPolicy ?? 'never'
      const sandbox = options.sandbox ?? 'workspace-write'
      const outFile = join(session?.cwd ?? cwd, '.cyber', 'codex-last-message.txt')
      const base = options.newSession
        ? ['exec', '-C', session?.cwd ?? cwd, '-s', sandbox, '-c', `approval_policy=${approval}`, '--json']
        : ['exec', 'resume', session?.id ?? '--last', '-C', session?.cwd ?? cwd, '-s', sandbox, '-c', `approval_policy=${approval}`, '--json']
      const args = [...base, '--output-last-message', outFile, text]

      log?.step?.(`codex 抽鞭：exec ${options.newSession ? '(新会话)' : `resume ${session?.id}`}（${text.length} 字）`)
      const result = await run(codex, args, {
        cwd: session?.cwd ?? cwd,
        timeoutMs: engineCtx?.config?.guard?.waitForAgentIdleMs ?? 3 * 60 * 60 * 1000,
        signal: engineCtx?.signal,
        env: { ...process.env, ...(options.env ?? {}) },
        maxOutput: 4 * 1024 * 1024,
      })
      let answer = ''
      try { answer = readText(outFile) } catch { /* 文件可能没生成 */ }
      if (!answer) {
        // --json 流里兜底抽最后一条 agent_message / output_text
        answer = extractFromJsonStream(result.stdout)
      }
      const detail = `codex 退出码 ${result.code}${result.timedOut ? '（超时被杀）' : ''}`
      log?.[result.code === 0 ? 'ok' : 'warn']?.(detail)
      return {
        ok: result.code === 0 || answer.length > 0,
        mode: 'foreground',
        detail,
        answer: clip(stripAnsi(answer), 20000),
        exitCode: result.code,
      }
    },

    async capabilities() {
      return [
        `CODEX_HOME：${home}`,
        `索引：${sqliteMod ? 'state_5.sqlite/threads 可用' : '不可用（目录扫描）'}`,
        `CLI：${bin() ?? '未找到'}`,
        `抽鞭：codex exec resume <id> -C <cwd> -s ${options.sandbox ?? 'workspace-write'} -c approval_policy=${options.approvalPolicy ?? 'never'} --json -o <file> "<鞭子>"`,
      ].join('\n')
    },
  }
}

/** 从 `--json` 事件流里抽最后一条助手文本（兜底）。 */
export function extractFromJsonStream(stdout) {
  let last = ''
  for (const line of String(stdout ?? '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let record
    try { record = JSON.parse(trimmed) } catch { continue }
    const payload = record.payload ?? record
    if (payload?.type === 'agent_message' && typeof payload.message === 'string') last = payload.message
    if (payload?.type === 'message' && payload.role === 'assistant') {
      const text = (payload.content ?? []).filter(c => c.type === 'output_text').map(c => c.text).join('\n')
      if (text) last = text
    }
    if (typeof payload?.last_agent_message === 'string' && payload.last_agent_message) last = payload.last_agent_message
  }
  return last
}

function safeReaddir(dir) {
  try { return readdirSync(dir) } catch { return [] }
}

function safeStat(file) {
  try { return statSync(file) } catch { return null }
}

function safeSize(file) {
  return safeStat(file)?.size ?? -1
}

function readText(file) { return nodeReadFileSync(file, 'utf8') }

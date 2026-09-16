/**
 * opencode 适配器。
 *
 * 读：`$OPENCODE_DATA/opencode.db`（sqlite）。opencode 是**事件溯源 + 投影**：
 *     真源在 `event` 表，但读对话要读投影表 `message` + `part`（两表的 `data` 列都是 JSON 字符串）。
 *     完成判定有权威依据：最后一条 assistant 消息的 `time.completed` 为 null ⇒ 还在跑；
 *     最后一个 `part/step-finish` 的 `reason === 'stop'` ⇒ 整轮结束、在等人。
 *
 * 写：`opencode run -s <sessionID> --dir <cwd> --format json "<prompt>"`。
 *     注意 `-c/--continue` **不按 cwd 过滤**（它取全局最近更新的顶层会话），所以永远显式 `-s`。
 *     另外 `opencode run` 默认会**自动拒绝**权限请求（question/plan_enter/plan_exit 被 deny，
 *     收到 permission.asked 直接 reject），要放行需 `--auto`。
 *
 * @module cyber-overseer/adapters/opencode
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { run, which } from '../util/proc.mjs'
import { clip, oneLine, stripAnsi } from '../util/text.mjs'
import { loadSqlite, openReadOnly, parseMaybeJson } from '../util/sqlite.mjs'
import { createCache, probeFail, probeOk, selectSession } from './base.mjs'

export const id = 'opencode'
export const label = 'opencode'
export const docs = '读 opencode.db（message/part 投影）；鞭子走 `opencode run -s <id>`'

/**
 * @param {{config:any, cwd:string, log?:any}} ctx
 * @returns {import('./base.mjs').Adapter}
 */
export function createOpencodeAdapter(ctx) {
  const { config, cwd, log } = ctx
  const options = config.agent?.options ?? {}
  const dataDir = join(process.env.USERPROFILE ?? process.env.HOME ?? homedir(), '.local', 'share', 'opencode')
  const dbFile = options.dbPath ?? process.env.OPENCODE_DB ?? join(dataDir, 'opencode.db')
  const cache = createCache(1500)
  let sqliteMod = null

  const bin = () => options.opencodeBin ?? process.env.CW_OPENCODE_BIN ?? which('opencode')
  const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

  /** 一次性查询（带缓存 + 只读打开回退）。 */
  function query(fn, key) {
    return cache.get(key, () => {
      const handle = openReadOnly(dbFile, sqliteMod)
      try {
        return fn(handle.db)
      } finally {
        handle.close()
      }
    })
  }

  function listSessionsSync() {
    return query((db) => {
      const rows = db.prepare(
        `select id, project_id, parent_id, directory, title, agent, model, cost,
                tokens_input, tokens_output, time_created, time_updated
         from session where time_archived is null order by time_updated desc limit 200`,
      ).all()
      return rows.map(row => ({
        id: row.id,
        title: row.title ?? null,
        cwd: row.directory ?? null,
        updatedAt: row.time_updated ?? 0,
        parentId: row.parent_id ?? null,
        raw: { project: row.project_id, agent: row.agent, model: parseMaybeJson(row.model, row.model), cost: row.cost },
      }))
    }, `sessions:${dbFile}`)
  }

  /** 读一个会话的消息与 part。 */
  function readTranscript(sessionId) {
    return query((db) => {
      const messages = db.prepare(
        'select id, time_created, data from message where session_id = ? order by time_created, id',
      ).all(sessionId)
      const partsStmt = db.prepare(
        'select id, time_created, data from part where message_id = ? order by time_created, id',
      )
      return messages.map(m => ({
        id: m.id,
        at: m.time_created,
        info: parseMaybeJson(m.data, {}),
        parts: partsStmt.all(m.id).map(p => ({ id: p.id, at: p.time_created, ...parseMaybeJson(p.data, {}) })),
      }))
    }, `transcript:${sessionId}`)
  }

  return {
    id,
    label,
    docs,

    async probe() {
      const hints = []
      sqliteMod = await loadSqlite()
      if (!sqliteMod) {
        return probeFail('当前 Node 没有 node:sqlite（需要 Node >= 22.5，推荐 24）：读不了 opencode.db', [
          '升级 Node，或改用 agent.adapter=human-sim 从界面读',
        ])
      }
      if (!existsSync(dbFile)) return probeFail(`找不到 opencode 数据库：${dbFile}`, ['先跑一次 opencode，或用 agent.options.dbPath 指定'])
      if (!bin()) hints.push('PATH 里找不到 opencode：抽鞭需要它（可用 agent.options.opencodeBin 指定）')
      let count = 0
      try { count = listSessionsSync().length } catch (error) { return probeFail(`读数据库失败：${error?.message ?? error}`) }
      if (options.auto !== true) hints.push('opencode run 默认会自动拒绝权限请求；要放行需 agent.options.auto=true（风险自负）')
      return probeOk(`数据库=${dbFile}，${count} 个会话，CLI=${bin() ? '已找到' : '缺失'}`, hints)
    },

    async listSessions() {
      return listSessionsSync()
    },

    async resolveSession(wanted) {
      const sessions = listSessionsSync().filter(s => !s.parentId)
      const scoped = sessions.filter(s => norm(s.cwd) === norm(cwd))
      const pool = scoped.length ? scoped : sessions
      const picked = selectSession(pool, wanted, { cwd })
      if (picked) return picked
      // 兜底：目录是前缀关系的（子目录里跑的 opencode）
      return sessions.find(s => norm(cwd).startsWith(norm(s.cwd)) && norm(s.cwd).length > 3) ?? null
    },

    async readState(session) {
      if (!session?.id) return { status: 'unknown', turn: null, lastAnswer: '', lastUserMessage: null, error: '没有会话 id' }
      try {
        const transcript = readTranscript(session.id)
        if (!transcript.length) {
          return { status: 'idle', turn: 0, lastAnswer: '', lastUserMessage: null, session }
        }
        const last = transcript.at(-1)
        const openAssistant = transcript.filter(m => m.info?.role === 'assistant' && m.info?.time?.completed == null).at(-1)
        const allParts = transcript.flatMap(m => m.parts)
        const lastStepFinish = allParts.filter(p => p.type === 'step-finish').at(-1)
        const pendingTool = allParts.filter(p => p.type === 'tool' && !['completed', 'error'].includes(p.state?.status)).at(-1)
        const ageMs = Date.now() - (session.updatedAt ?? 0)

        let status = 'idle'
        if (!lastStepFinish) status = 'unknown'
        else if (pendingTool) status = ageMs < (options.workingWindowMs ?? 180000) ? 'working' : 'awaiting-input'
        else if (last.info?.role === 'user' || openAssistant) status = ageMs < (options.workingWindowMs ?? 180000) ? 'working' : 'awaiting-input'
        else if (lastStepFinish.reason === 'stop') status = 'idle'
        else status = 'idle'

        // "最后一次回答" = 最后一个已被 step-finish 收尾的 assistant 消息的 text parts
        const answerMessage = [...transcript].reverse().find(m => m.info?.role === 'assistant' && m.parts.some(p => p.type === 'text'))
        const answer = answerMessage ? answerMessage.parts.filter(p => p.type === 'text').map(p => p.text).join('\n') : ''
        const lastUser = [...transcript].reverse().find(m => m.info?.role === 'user')
        const lastUserText = lastUser ? lastUser.parts.filter(p => p.type === 'text').map(p => p.text).join('\n') : null

        return {
          status,
          turn: transcript.filter(m => m.info?.role === 'user').length,
          lastAnswer: answer,
          lastUserMessage: lastUserText,
          awaitingInput: status === 'awaiting-input',
          session,
          extra: {
            lastStepFinish: lastStepFinish?.reason ?? null,
            pendingTool: pendingTool ? { tool: pendingTool.tool, status: pendingTool.state?.status } : null,
            messages: transcript.length,
            parts: allParts.length,
          },
        }
      } catch (error) {
        return { status: 'unknown', turn: null, lastAnswer: '', lastUserMessage: null, error: `读 opencode 会话失败：${error?.message ?? error}` }
      }
    },

    async whip(text, session, engineCtx) {
      const opencode = bin()
      if (!opencode) return { ok: false, mode: 'inject', detail: 'PATH 里找不到 opencode' }
      const args = ['run', '-s', session?.id ?? '', '--dir', session?.cwd ?? cwd, '--format', 'json']
      if (options.auto === true) args.push('--auto')
      if (options.agent) args.push('--agent', String(options.agent))
      if (options.model) args.push('-m', String(options.model))
      args.push(text)

      log?.step?.(`opencode 抽鞭：run -s ${session?.id}（${text.length} 字）`)
      const result = await run(opencode, args, {
        cwd: session?.cwd ?? cwd,
        timeoutMs: engineCtx?.config?.guard?.waitForAgentIdleMs ?? 3 * 60 * 60 * 1000,
        signal: engineCtx?.signal,
        env: { ...process.env, ...(options.env ?? {}) },
        maxOutput: 4 * 1024 * 1024,
      })
      const answer = extractOpencodeAnswer(result.stdout)
      const detail = `opencode 退出码 ${result.code}${result.timedOut ? '（超时被杀）' : ''}`
      log?.[result.code === 0 ? 'ok' : 'warn']?.(detail)
      if (result.code !== 0 && result.stderr) log?.debug?.(oneLine(stripAnsi(result.stderr), 300))
      cache.invalidate(`transcript:${session?.id}`)
      return {
        ok: result.code === 0 || answer.length > 0,
        mode: 'foreground',
        detail,
        answer: clip(answer, 20000),
        exitCode: result.code,
      }
    },

    async capabilities() {
      return [
        `数据库：${dbFile}`,
        `CLI：${bin() ?? '未找到'}`,
        `抽鞭：opencode run -s <session> --dir <cwd> --format json${options.auto ? ' --auto' : ''} "<鞭子>"`,
        options.auto ? '⚠️ auto=true：opencode 会自动放行权限请求' : '权限请求会被 opencode 自动拒绝（默认安全）',
      ].join('\n')
    },
  }
}

/**
 * 从 `--format json` 的输出里抽取最后一条助手文本。
 * 输出可能是 JSON 行、也可能是 JSON 数组，两种都容忍。
 */
export function extractOpencodeAnswer(stdout) {
  const text = stripAnsi(String(stdout ?? ''))
  const candidates = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) continue
    try { candidates.push(JSON.parse(trimmed)) } catch { /* 忽略 */ }
  }
  let last = ''
  const visit = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const item of node) visit(item); return }
    const role = node.role ?? node.info?.role
    const parts = node.parts ?? node.message?.parts
    if (role === 'assistant' && Array.isArray(parts)) {
      const joined = parts.filter(p => p?.type === 'text').map(p => p.text).join('\n')
      if (joined) last = joined
    }
    if (typeof node.text === 'string' && (node.type === 'text' || node.part?.type === 'text')) last = node.text
    for (const value of Object.values(node)) if (value && typeof value === 'object') visit(value)
  }
  for (const candidate of candidates) visit(candidate)
  return last || text.trim()
}

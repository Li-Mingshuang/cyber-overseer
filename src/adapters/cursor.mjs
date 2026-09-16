/**
 * Cursor 适配器。
 *
 * 读：`%APPDATA%/Cursor/User/globalStorage/state.vscdb`（sqlite）
 *   · 会话列表：表 `composerHeaders`（或 `ItemTable['cursor.composerHeaders']`）
 *   · 每会话元数据：`cursorDiskKV['composerData:<composerId>']`（含 `fullConversationHeadersOnly` 顺序表）
 *   · 每条消息正文：`cursorDiskKV['bubbleId:<composerId>:<bubbleId>']` 的 `.text`（type 1=用户 2=助手）
 *   · 忙闲：`composerData.status`（none/completed=闲，generating=忙）+ `generatingBubbleIds` 非空
 *   实测结论：`conversation-search.db` 与正文**滞后 ≥1 轮**，不能用来读"最新回答"，只能做全文检索。
 *
 * 写（抽鞭）三条路，按推荐顺序：
 *   1. **`hooks`（首推，官方机制、无门控、不用抢焦点）**：在项目里安装 `.cursor/hooks.json`，
 *      让 Cursor 自己的 `stop` 钩子回调 `cw hook cursor-stop`；那个命令读会话 + 判定 + 返回
 *      `{"followup_message": "..."}`，Cursor 就会自动把这条当新用户消息提交。
 *      → 用 `cw hooks install cursor` 一键装好，之后完全由 Cursor 驱动，本进程都不用常驻。
 *   2. **`desktop-bridge`**：`cursor desktop send <threadId> <text> --json`（需在
 *      Settings → Beta 打开 "Allow CLI to access desktop agents" 并重启 Cursor）。
 *   3. **`human-sim`**：直接往 Cursor 窗口里打字回车（复用拟人通道，最脏但永远能用）。
 *
 * @module cyber-overseer/adapters/cursor
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { run, which } from '../util/proc.mjs'
import { clip, oneLine } from '../util/text.mjs'
import { loadSqlite, openReadOnly, parseMaybeJson } from '../util/sqlite.mjs'
import { createCache, probeFail, probeOk, selectSession } from './base.mjs'

export const id = 'cursor'
export const label = 'Cursor IDE'
export const docs = '读 state.vscdb（cursorDiskKV）；鞭子走 hooks / desktop-bridge / 拟人'

/**
 * @param {{config:any, cwd:string, log?:any, deps?:any}} ctx
 * @returns {import('./base.mjs').Adapter}
 */
export function createCursorAdapter(ctx) {
  const { config, cwd, log } = ctx
  const options = config.agent?.options ?? {}
  const appData = process.env.APPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming')
  const stateDb = options.stateDb ?? join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb')
  const cache = createCache(1500)
  let sqliteMod = null

  const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

  function withDb(fn, key) {
    return cache.get(key, () => {
      const handle = openReadOnly(stateDb, sqliteMod)
      try {
        return fn(handle.db)
      } finally {
        handle.close()
      }
    })
  }

  /** 会话列表（标题 + 项目路径）。 */
  function listSessionsSync() {
    return withDb((db) => {
      let rows = []
      try {
        rows = db.prepare('select composerId, name, subtitle, createdAt, lastUpdatedAt, unifiedMode, workspaceIdentifier from composerHeaders order by lastUpdatedAt desc limit 200').all()
      } catch { rows = [] }
      if (!rows.length) {
        // 老版本/无该表时退回 ItemTable
        try {
          const item = db.prepare("select value from ItemTable where key = 'composer.composerHeaders'").get()
          const parsed = parseMaybeJson(item?.value, null)
          const all = parsed?.allComposers ?? []
          rows = all.map(c => ({
            composerId: c.composerId,
            name: c.name,
            subtitle: c.subtitle,
            lastUpdatedAt: c.lastUpdatedAt,
            workspaceIdentifier: c.workspaceIdentifier ?? c.workspaceId,
          }))
        } catch { rows = [] }
      }
      return rows.filter(r => r.composerId).map(row => {
        const meta = readComposerMetaFrom(db, row.composerId)
        return {
          id: row.composerId,
          title: row.name ?? meta?.name ?? null,
          cwd: extractWorkspacePath(row.workspaceIdentifier ?? meta?.workspaceIdentifier, db),
          updatedAt: row.lastUpdatedAt ?? meta?.lastUpdatedAt ?? 0,
          raw: { status: meta?.status ?? 'unknown', subtitle: row.subtitle ?? null },
        }
      })
    }, `cursor:sessions:${stateDb}`)
  }

  function readComposerMetaFrom(db, composerId) {
    try {
      const row = db.prepare('select value from cursorDiskKV where key = ?').get(`composerData:${composerId}`)
      return parseMaybeJson(row?.value, null)
    } catch { return null }
  }

  /** workspaceIdentifier 里通常是 workspace 路径。 */
  function extractWorkspacePath(identifier, db) {
    if (!identifier) return null
    if (typeof identifier === 'object') {
      return identifier.uri?.path ?? identifier.folder ?? identifier.path ?? null
    }
    const text = String(identifier)
    if (text.startsWith('file://')) {
      try { return decodeURIComponent(text.replace(/^file:\/\//, '').replace(/^\//, '').replace(/\//g, '\\')) } catch { return text }
    }
    if (/^[a-zA-Z]:[\\/]/.test(text)) return text
    // 形如 "file:///c%3A/Users/..." 或 workspaceStorage id
    try {
      const row = db.prepare('select value from ItemTable where key = ?').get(`workspaceStorage.${text}`)
      const parsed = parseMaybeJson(row?.value, null)
      if (parsed?.folder) return parsed.folder
    } catch { /* 忽略 */ }
    return text
  }

  /** 读一条会话的完整消息（按 fullConversationHeadersOnly 的顺序）。 */
  function readConversation(composerId) {
    return withDb((db) => {
      const meta = readComposerMetaFrom(db, composerId) ?? {}
      const headers = Array.isArray(meta.fullConversationHeadersOnly) ? meta.fullConversationHeadersOnly : []
      const bubbles = []
      const stmt = db.prepare('select value from cursorDiskKV where key = ?')
      const ids = headers.length ? headers.map(h => h.bubbleId ?? h.id).filter(Boolean) : null
      if (ids) {
        for (const bubbleId of ids) {
          const row = stmt.get(`bubbleId:${composerId}:${bubbleId}`)
          const parsed = parseMaybeJson(row?.value, null)
          if (parsed) bubbles.push({ bubbleId, ...parsed })
        }
      } else {
        // 没有顺序表：退化为按 key 前缀扫（顺序不可靠，但好过没有）
        try {
          const rows = db.prepare('select key, value from cursorDiskKV where key like ?').all(`bubbleId:${composerId}:%`)
          for (const row of rows) {
            const parsed = parseMaybeJson(row.value, null)
            if (parsed) bubbles.push({ bubbleId: row.key.split(':').pop(), ...parsed })
          }
        } catch { /* 忽略 */ }
      }
      return { meta, bubbles }
    }, `cursor:conv:${composerId}`)
  }

  return {
    id,
    label,
    docs,

    async probe() {
      const hints = []
      sqliteMod = await loadSqlite()
      if (!sqliteMod) return probeFail('当前 Node 没有 node:sqlite：读不了 Cursor 的 state.vscdb', ['升级到 Node >= 22.5（推荐 24）'])
      if (!existsSync(stateDb)) return probeFail(`找不到 Cursor 数据库：${stateDb}`, ['确认 Cursor 装在默认位置，或用 agent.options.stateDb 指定'])
      let sessions = []
      try { sessions = listSessionsSync() } catch (error) { return probeFail(`读 state.vscdb 失败：${error?.message ?? error}`) }
      const mode = options.whip ?? 'hooks'
      if (mode === 'hooks') hints.push('推荐用 `cw hooks install cursor` 安装官方 stop 钩子：无需抢焦点、无需常驻进程')
      if (mode === 'desktop-bridge' && !isDesktopBridgeEnabled()) {
        hints.push('desktop bridge 当前关闭：需要在 Cursor 的 Settings → Beta 打开 "Allow CLI to access desktop agents" 并重启')
      }
      return probeOk(`数据库=${stateDb}，${sessions.length} 个 composer 会话，抽鞭模式=${mode}`, hints)
    },

    async listSessions() {
      return listSessionsSync()
    },

    async resolveSession(wanted) {
      const sessions = listSessionsSync()
      const scoped = sessions.filter(s => s.cwd && norm(s.cwd) === norm(cwd))
      const pool = scoped.length ? scoped : sessions
      return selectSession(pool, wanted, { cwd })
    },

    async readState(session) {
      if (!session?.id) return { status: 'unknown', turn: null, lastAnswer: '', lastUserMessage: null, error: '没有 composerId' }
      try {
        const { meta, bubbles } = readConversation(session.id)
        const assistantBubbles = bubbles.filter(b => Number(b.type) === 2 && typeof b.text === 'string' && b.text.trim())
        const userBubbles = bubbles.filter(b => Number(b.type) === 1 && typeof b.text === 'string')
        const lastAssistant = assistantBubbles.at(-1) ?? null
        const lastUser = userBubbles.at(-1) ?? null
        const generating = Array.isArray(meta.generatingBubbleIds) && meta.generatingBubbleIds.length > 0
        const status = generating || meta.status === 'generating'
          ? 'working'
          : meta.status === 'aborted'
            ? 'error'
            : meta.status === 'none' || meta.status === 'completed' || meta.status === undefined
              ? 'idle'
              : 'idle'
        return {
          status,
          turn: userBubbles.length,
          lastAnswer: lastAssistant?.text ?? '',
          lastUserMessage: lastUser?.text ?? null,
          session: { ...session, title: session.title ?? meta.name ?? null },
          extra: {
            cursorStatus: meta.status ?? null,
            generatingBubbleIds: meta.generatingBubbleIds?.length ?? 0,
            bubbles: bubbles.length,
            assistantBubbles: assistantBubbles.length,
          },
        }
      } catch (error) {
        return { status: 'unknown', turn: null, lastAnswer: '', lastUserMessage: null, error: `读 Cursor 会话失败：${error?.message ?? error}` }
      }
    },

    async whip(text, session, engineCtx) {
      const mode = options.whip ?? 'hooks'
      if (mode === 'hooks') {
        return {
          ok: false, mode: 'inject',
          detail: 'Cursor 走 hooks 模式时不需要（也不能）由监工主动注入：请先 `cw hooks install cursor`，'
            + '之后由 Cursor 自己的 stop 钩子回调 `cw hook cursor-stop` 来驱动——那样连监工进程都不必常驻。',
        }
      }
      if (mode === 'desktop-bridge') return whipViaDesktopBridge(text, session, engineCtx)
      if (mode === 'human-sim') return whipViaHumanSim(text, session, engineCtx)
      return { ok: false, mode: 'inject', detail: `未知的 Cursor 抽鞭模式：${mode}（可选 hooks / desktop-bridge / human-sim）` }
    },

    async capabilities() {
      return [
        `数据库：${stateDb}`,
        `读取：cursorDiskKV（composerData / bubbleId）`,
        `抽鞭模式：${options.whip ?? 'hooks'}`,
        (options.whip ?? 'hooks') === 'hooks' ? '提示：`cw hooks install cursor` 装官方钩子（推荐）' : '',
      ].filter(Boolean).join('\n')
    },
  }

  // -------------------------------------------------------------------------

  function isDesktopBridgeEnabled() {
    try {
      return withDb((db) => {
        const row = db.prepare("select value from ItemTable where key = 'cursor.desktopBridge.enabled'").get()
        return String(row?.value).includes('true')
      }, `cursor:bridge:${stateDb}`)
    } catch { return false }
  }

  async function whipViaDesktopBridge(text, session, engineCtx) {
    const cursor = which('cursor')
    if (!cursor) return { ok: false, mode: 'inject', detail: 'PATH 里找不到 cursor CLI' }
    const result = await run(cursor, ['desktop', 'send', session?.id ?? '', text, '--json'], {
      cwd, timeoutMs: 60000, signal: engineCtx?.signal,
    })
    let status = null
    try { status = JSON.parse(result.stdout.trim().split('\n').at(-1))?.status ?? null } catch { /* 忽略 */ }
    const ok = result.code === 0 && ['submitted', 'queued'].includes(status)
    return {
      ok, mode: 'inject',
      detail: ok
        ? `cursor desktop send 返回 ${status}`
        : `cursor desktop send 失败（退出码 ${result.code}, status=${status ?? '?'}）：${oneLine(result.stderr || result.stdout, 200)}`
        + '（若提示 not-sendable/unknown-thread，检查 Settings → Beta 的 Desktop Bridge 开关）',
    }
  }

  async function whipViaHumanSim(text, session, engineCtx) {
    const { createHumanSimAdapter } = await import('./human-sim.mjs')
    const sim = createHumanSimAdapter({
      ...ctx,
      config: {
        ...config,
        agent: {
          ...config.agent,
          adapter: 'human-sim',
          options: { windowMatch: options.windowMatch ?? { process: 'Cursor' }, ...(options.humanSim ?? {}) },
        },
      },
    })
    return sim.whip(text, session, engineCtx)
  }
}

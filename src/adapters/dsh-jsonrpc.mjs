/**
 * DSH 的 SDK stdio JSON-RPC 适配器（`dsh --profile jrpc`）。
 *
 * 为什么值得单独做一个通道（详见 `docs/recon/dsh-control-surfaces.md` §4.6、§5⑤）：
 *  - **注入**：`session/prompt` 就是信箱（服务端内部 `agent.followup`），一个常驻进程可以反复注入；
 *  - **观测**：`session.event` 把会话事件**逐条**推给客户端，能还原出忙/闲与最后一次回答；
 *  - **零侵入**：独立进程、全新会话，完全不碰人类正在用的会话。
 *
 * 三个必须记住的协议事实（都是实测踩出来的）：
 *  1. **先等 `initialize` 的响应再发 `session/prompt`**——服务端对同一批到达的帧
 *     用 `void handleLine()` 并发处理，抢跑会撞上"用了默认模型"的 400（本适配器天然串行）；
 *  2. `sessionId` 是**新建**而不是恢复历史：协议没有 resume/load，也没有 cancel/close，
 *     放弃只能杀进程（由 `dispose()` 负责）；
 *  3. stdout 被协议独占，所以 profile 组合里不能有 stdout logger。
 *
 * profile 怎么来：`cw dsh-profile --install`（模板见 `src/dsh-profile.mjs`）。
 *
 * @module cyber-overseer/adapters/dsh-jsonrpc
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { JsonRpcStdioClient } from '../util/jsonrpc-stdio.mjs'
import { which } from '../util/proc.mjs'
import { createLogger } from '../util/log.mjs'
import { oneLine } from '../util/text.mjs'
import { DEFAULT_PROFILE, inspectProfile, resolveDshHome, SDK_PACKAGE } from '../dsh-profile.mjs'
import { summarizeSession } from './dsh-session.mjs'
import { probeFail, probeOk } from './base.mjs'

export const id = 'dsh-jsonrpc'
export const label = 'DeepSeek Harness（SDK stdio JSON-RPC）'
export const docs = '常驻 `--profile jrpc` 进程；initialize → session/prompt 注入，session.event 流观测'

/**
 * 失败分类：通道没配好（profile 缺东西、方法不存在）→ setup；超时/进程没了 → transient。
 * @param {any} error
 */
export function classifyRpcError(error) {
  const message = String(error?.message ?? error)
  const code = error?.code
  if (code === -32601 || code === -32602) return 'setup'
  if (/超时|timeout/i.test(message)) return 'transient'
  if (/ENOENT|not found|Cannot find|无法解析|invalid profile|profile/i.test(message)) return 'setup'
  return 'fatal'
}

/**
 * @param {{config:any, cwd:string, log?:any, deps?:any, signal?:AbortSignal}} ctx
 * @returns {import('./base.mjs').Adapter}
 */
export function createDshJsonRpcAdapter(ctx) {
  const { config, cwd } = ctx
  const log = ctx.log ?? createLogger({ level: 'warn' })
  const options = config.agent?.options ?? {}
  const dshHome = resolveDshHome(options.dshHome)
  const profile = options.profile ?? DEFAULT_PROFILE
  const workspace = resolve(options.workspace ?? options.cwd ?? cwd)
  const sessionId = String(options.sessionId ?? 'cw-jsonrpc')
  const maxEvents = options.maxEvents ?? 4000

  /** 收集到的 `session.event`（形状与 session.jsonl 里的记录一致，直接复用 DSH 的折叠逻辑）。 */
  const events = []
  let serverStatus = null
  let client = null
  let connecting = null
  let initializeResult = null
  let stderrTail = ''

  /** DSH 入口：显式命令 → dshEntry → CW_DSH_BIN → PATH → 常见 checkout 位置。 */
  function resolveEntry() {
    if (Array.isArray(options.command) && options.command.length) {
      return { kind: 'argv', command: options.command[0], args: options.command.slice(1), label: options.command.join(' ') }
    }
    const entry = options.dshEntry ?? process.env.CW_DSH_BIN
    if (entry) {
      return /\.(mjs|cjs|js)$/.test(entry)
        ? { kind: 'node', command: process.execPath, args: [entry, '--profile', profile], label: `node ${entry}` }
        : { kind: 'bin', command: entry, args: ['--profile', profile], label: entry }
    }
    const onPath = which('dsh')
    if (onPath) return { kind: 'bin', command: onPath, args: ['--profile', profile], label: onPath }
    const guesses = [
      process.env.DSH_CHECKOUT ? join(process.env.DSH_CHECKOUT, 'apps', 'cli', 'lib', 'bin.js') : null,
      join(cwd, '..', 'deepseek-harness', 'apps', 'cli', 'lib', 'bin.js'),
      'C:\\myFiles\\codes\\github\\deepseek-harness\\apps\\cli\\lib\\bin.js',
      join(homedir(), 'deepseek-harness', 'apps', 'cli', 'lib', 'bin.js'),
    ].filter(Boolean)
    for (const guess of guesses) {
      if (existsSync(guess)) return { kind: 'node', command: process.execPath, args: [guess, '--profile', profile], label: `node ${guess}` }
    }
    return null
  }

  function pushEvent(params) {
    const event = params?.event
    if (!event) return
    if (params?.sessionId && String(params.sessionId) !== sessionId) return
    events.push(event)
    if (events.length > maxEvents) events.splice(0, events.length - maxEvents)
  }

  /** 连上（只连一次）；**串行**等 `initialize` 的响应，避免 DSH 的并发分帧竞态。 */
  function ensureConnected(engineCtx) {
    if (client?.alive) return Promise.resolve(client)
    if (connecting) return connecting
    const entry = resolveEntry()
    if (!entry && !ctx.deps?.makeTransport) {
      return Promise.reject(new Error('找不到 DSH 入口：设置 agent.options.dshEntry / CW_DSH_BIN / DSH_CHECKOUT，或把 dsh 放进 PATH'))
    }
    connecting = (async () => {
      // 测试可以注入一条"假的 JSON-RPC 连接"（deps.makeTransport），
      // 这样适配器逻辑（串行 initialize、事件折叠、失败分类）能在没有子进程的环境里被钉死。
      const factory = ctx.deps?.makeTransport
      const next = factory
        ? factory({ label: entry?.label ?? '(注入的传输层)', dshHome, profile, workspace })
        : new JsonRpcStdioClient({
            command: entry.command,
            args: entry.args,
            cwd: workspace,
            env: { ...process.env, DSH_HOME: dshHome, ...(options.env ?? {}) },
            log,
            name: 'dsh-jsonrpc',
            requestTimeoutMs: options.requestTimeoutMs ?? 10 * 60 * 1000,
          })
      next.onNotification((method, params) => {
        if (method === 'session.event') pushEvent(params)
        else if (method === 'session.status') serverStatus = params?.status ?? serverStatus
      })
      next.onExit(({ code, stderr } = {}) => {
        if (stderr) stderrTail = String(stderr)
        log.debug?.(`dsh-jsonrpc 子进程退出 code=${code}`)
      })
      next.start()
      initializeResult = await next.request('initialize', {
        cwd: workspace,
        ...(options.model ? { model: options.model } : {}),
        ...(options.provider ? { provider: options.provider } : {}),
        ...(options.initialize ?? {}),
      }, { timeoutMs: options.initializeTimeoutMs ?? 180000, signal: engineCtx?.signal })
      log.debug?.(`dsh-jsonrpc initialize 完成：${oneLine(JSON.stringify(initializeResult ?? {}), 200)}`)
      client = next
      return client
    })().catch((error) => {
      connecting = null
      throw error
    })
    return connecting
  }

  return {
    id,
    label,
    docs,

    async probe() {
      const entry = resolveEntry()
      if (!entry && !ctx.deps?.makeTransport) {
        return probeFail('找不到 DSH 入口', [
          '设置 agent.options.dshEntry（例如 "C:\\\\path\\\\deepseek-harness\\\\apps\\\\cli\\\\lib\\\\bin.js"）',
          '或设置环境变量 CW_DSH_BIN / DSH_CHECKOUT',
        ])
      }
      const status = inspectProfile({ home: dshHome, profile })
      if (!status.ok) {
        return probeFail(`profile「${profile}」还没准备好（${status.dir}）`, status.hints)
      }
      return probeOk(`DSH ${entry ? entry.label : '(注入的传输层)'} + profile「${profile}」（DSH_HOME=${dshHome}）`, [
        '注意：SDK JSON-RPC 的 session 是**新建**的，协议没有 resume（记忆靠工作区与提示词）',
        'stdout 被协议独占：profile 组合里不要挂 stdout logger',
      ])
    },

    async listSessions() {
      // 协议里**没有**列表方法：只能如实说明"这个通道只认配置里的那个会话"
      return [{
        id: sessionId,
        title: options.title ?? `${label}（协议无列表方法，这里只有配置的会话）`,
        cwd: workspace,
        updatedAt: Date.now(),
        raw: { events: events.length, connected: client?.alive ?? false },
      }]
    },

    async resolveSession(wanted) {
      const wantedId = typeof wanted === 'object' && wanted?.id ? String(wanted.id) : null
      const resolved = wantedId
        ?? (typeof wanted === 'string' && wanted !== 'latest' && wanted !== 'new' ? wanted : sessionId)
      return { id: resolved, title: options.title ?? null, cwd: workspace, updatedAt: Date.now() }
    },

    async readState(session) {
      // 事件形状与 session.jsonl 一致：直接复用 DSH 的折叠逻辑（同样的"最后一个边界胜出"语义）
      const records = [{ type: 'session', seq: 0, id: session?.id ?? sessionId, cwd: workspace }, ...events]
      const summary = summarizeSession(records, { wantFullTranscript: Boolean(options.wantFullTranscript) })
      // 还没开始过任何回合的会话要算 **idle**：否则引擎会以为它在干活而一直等（新会话最常见）
      const sawTurnStart = events.some(event => event?.type === 'turn/start')
      let status = sawTurnStart ? summary.status : 'idle'
      if (serverStatus === 'running' && status !== 'awaiting-approval' && status !== 'awaiting-input') status = 'working'
      return {
        status,
        turn: summary.turn?.current ?? null,
        lastAnswer: summary.lastAnswer ?? '',
        lastUserMessage: summary.lastUserMessage ?? null,
        awaitingInput: status === 'awaiting-input',
        session,
        extra: {
          source: 'dsh-jsonrpc',
          events: events.length,
          serverStatus,
          connected: client?.alive ?? false,
          serverInfo: initializeResult?.serverInfo ?? null,
        },
      }
    },

    async whip(text, session, engineCtx) {
      const resolvedSessionId = String(session?.id ?? sessionId)
      try {
        const rpc = await ensureConnected(engineCtx)
        const result = await rpc.request('session/prompt', {
          sessionId: resolvedSessionId,
          contentBlocks: [{ type: 'text', text: String(text) }],
        }, { timeoutMs: options.promptTimeoutMs ?? 300000, signal: engineCtx?.signal })
        log.debug?.(`dsh-jsonrpc 注入成功 messageId=${result?.messageId ?? '?'}`)
        return {
          ok: true,
          mode: 'inject',
          detail: `已通过 SDK JSON-RPC 注入（session ${resolvedSessionId}，${String(text).length} 字，messageId=${result?.messageId ?? '?'}）`,
        }
      } catch (error) {
        const kind = classifyRpcError(error)
        const detail = String(error?.message ?? error)
        if (stderrTail) log.debug?.(`dsh-jsonrpc stderr：${oneLine(stderrTail, 200)}`)
        return { ok: false, mode: 'inject', kind, detail }
      }
    },

    async capabilities() {
      const entry = resolveEntry()
      const status = inspectProfile({ home: dshHome, profile })
      return [
        `DSH 入口：${entry ? entry.label : '（未找到）'}`,
        `DSH_HOME：${dshHome}｜profile：${profile}（${status.ok ? '就绪' : '未就绪'}）`,
        `插件包：${SDK_PACKAGE}`,
        `工作目录：${workspace}｜会话 id：${sessionId}`,
        `已收到事件：${events.length}${serverStatus ? `｜服务端状态：${serverStatus}` : ''}`,
      ].join('\n')
    },

    async dispose() {
      const current = client
      client = null
      connecting = null
      initializeResult = null
      if (current) {
        try { await current.stop({ graceMs: options.shutdownGraceMs ?? 800 }) } catch (error) {
          log.debug?.(`dsh-jsonrpc 收尾出错：${error?.message ?? error}`)
        }
      }
    },
  }
}

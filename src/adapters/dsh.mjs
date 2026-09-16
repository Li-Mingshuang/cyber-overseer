/**
 * DSH 适配器（DeepSeek Harness）——本项目的一等公民。
 *
 * 读：直接解析 `$DSH_HOME/sessions/<slug>/<session-id>/session.jsonl.zstd`
 *     （多帧 zstd，见 `dsh-session.mjs`）。不依赖 DSH 正在运行，也不碰它的状态。
 *
 * 写（抽鞭）有四种模式，用 `agent.options.whip` 选：
 *   - `'headless'`（默认，开箱可用）：`dsh --profile headless "<鞭子>"`。
 *     注意 DSH 的 headless 是**一次性全新会话**（不续接旧会话），所以"记忆"靠的是
 *     工作区本身（PLAN.md + 代码 + git）——这也正是本项目推荐的无人值守形态：
 *     每一鞭派一个干净的劳工，接着干方案里剩下的活。
 *   - `'http'`：往**正在运行**的 DSH Web/服务端会话里插一条用户消息（需要 DSH 的
 *     HTTP API；见 docs/recon/dsh-control-surfaces.md，配置 options.httpEndpoint）。
 *   - `'human-sim'`：复用拟人通道，直接在 DSH 的 GUI 窗口里打字回车（最通用，代价是要抢焦点）。
 *   - `'custom'`：完全自定义命令模板，支持 `{text}` / `{session}` / `{cwd}` 占位符。
 *     例：`['tmux','send-keys','-t','dsh','{text}','Enter']`。
 *
 * @module cyber-overseer/adapters/dsh
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { run, which, spawnDetached } from '../util/proc.mjs'
import { clip, oneLine, stripAnsi, tail } from '../util/text.mjs'
import { jsonRequest } from '../util/http.mjs'
import { hasZstd, scanFrames } from '../util/zstd-frames.mjs'
import { createCache, probeFail, probeOk, samePath, selectSession } from './base.mjs'
import { decodeSessionBytes, summarizeSession, titleFromPlan } from './dsh-session.mjs'

export const id = 'dsh'
export const label = 'DeepSeek Harness (dsh)'
export const docs = '读 session.jsonl.zstd；鞭子走 headless / HTTP / 拟人 / 自定义命令'

/**
 * @param {{config:any, cwd:string, log?:any, deps?:any}} ctx
 * @returns {import('./base.mjs').Adapter}
 */
export function createDshAdapter(ctx) {
  const { config, cwd, log } = ctx
  const options = config.agent?.options ?? {}
  const cache = createCache(1200)
  let resolvedDshHome = null

  /** DSH 家目录：环境变量优先，其次 ~/.dsh。 */
  const dshHome = () => {
    if (resolvedDshHome) return resolvedDshHome
    resolvedDshHome = resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'))
    return resolvedDshHome
  }

  const sessionsRoot = () => join(dshHome(), 'sessions')

  /** 找 dsh 可执行入口：环境变量 → PATH → 常见 checkout 位置。 */
  const dshEntry = () => {
    if (options.dshEntry) return { kind: 'node', file: options.dshEntry, label: options.dshEntry }
    const envBin = process.env.CW_DSH_BIN
    if (envBin) {
      return envBin.endsWith('.js') || envBin.endsWith('.mjs')
        ? { kind: 'node', file: envBin, label: `node ${envBin}` }
        : { kind: 'bin', file: envBin, label: envBin }
    }
    const onPath = which('dsh')
    if (onPath) return { kind: 'bin', file: onPath, label: onPath }
    const guesses = [
      process.env.DSH_CHECKOUT ? join(process.env.DSH_CHECKOUT, 'apps', 'cli', 'lib', 'bin.js') : null,
      join(cwd, '..', 'deepseek-harness', 'apps', 'cli', 'lib', 'bin.js'),
      'C:\\myFiles\\codes\\github\\deepseek-harness\\apps\\cli\\lib\\bin.js',
      join(homedir(), 'deepseek-harness', 'apps', 'cli', 'lib', 'bin.js'),
    ].filter(Boolean)
    for (const guess of guesses) {
      if (existsSync(guess)) return { kind: 'node', file: guess, label: `node ${guess}` }
    }
    return null
  }

  /**
   * 列出所有会话：扫 `<sessionsRoot>/<slug>/<session-id>/session.jsonl.zstd`。
   * 只读每个文件的"尾部帧"来取状态与最新回答，避免为了列个表解码 100MB。
   */
  function listSessionsSync() {
    const root = sessionsRoot()
    if (!existsSync(root)) return []
    const out = []
    for (const slug of safeReaddir(root)) {
      const slugDir = join(root, slug)
      if (!isDir(slugDir)) continue
      for (const sessionDirName of safeReaddir(slugDir)) {
        const dir = join(slugDir, sessionDirName)
        if (!isDir(dir)) continue
        const file = pickSessionFile(dir)
        if (!file) continue
        let stat
        try { stat = statSync(file) } catch { continue }
        let summary = null
        try {
          // 列会话用轻量读（只解头帧 + 尾帧）；整解留给 readState
          summary = readSummaryLite(file)
        } catch (error) {
          log?.debug?.(`跳过读不动的会话 ${file}：${error?.message ?? error}`)
        }
        out.push({
          id: summary?.sessionId ?? sessionDirName,
          title: summary?.title ?? null,
          cwd: summary?.cwd ?? null,
          updatedAt: stat.mtimeMs,
          size: stat.size,
          path: file,
          status: summary?.status ?? 'unknown',
          turnCount: summary?.turn?.current ?? summary?.turn?.count ?? null,
          raw: summary,
        })
      }
    }
    return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  }

  /**
   * 轻量读一个会话：**只解头帧 + 末尾几帧**，不解压整个文件。
   *
   * 为什么必须这样：会话文件是几百 KB、上千个 zstd 帧，"列个表"如果把每个文件都整解一遍，
   * 65 个会话要十几秒（实测），把交互式命令全拖死。列会话只需要：会话 id/cwd（头帧）、
   * 标题与回合状态（尾帧）、更新时间（文件 mtime）。
   * 需要"最后一次回答"时，才用 readSummary 整解（只对选中的那一个会话做）。
   */
  function readSummaryLite(file) {
    const key = `lite:${file}:${statSync(file).size}:${statSync(file).mtimeMs}`
    return cache.get(key, () => {
      const buf = readFileSync(file)
      const frames = scanFrames(buf)
      const decode = (index) => {
        const frame = frames[index]
        if (!frame || frame.kind !== 'frame' || !frame.complete) return null
        try { return zstdDecompressSync(buf.subarray(frame.start, frame.end)).toString('utf8') } catch { return null }
      }
      const parse = (text) => {
        const out = []
        if (!text) return out
        for (const line of text.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try { out.push(JSON.parse(trimmed)) } catch { /* 半截行 */ }
        }
        return out
      }
      // 头帧：会话元信息；接着再读开头几帧（标题、开头几个回合边界都在文件前部）
      const head = parse(decode(0))
      const header = head.find(r => r?.type === 'session') ?? head[0] ?? null
      const headRecords = [...head]
      for (let i = 1; i < Math.min(8, frames.length); i++) headRecords.push(...parse(decode(i)))
      // 尾帧（最近几帧）：最新标题与当前回合状态
      const tailRecords = []
      for (let i = Math.max(0, frames.length - 6); i < frames.length; i++) tailRecords.push(...parse(decode(i)))

      const all = [...headRecords, ...tailRecords]
      const lastTitle = [...all].reverse().find(r => r?.type === 'session/title' && r.data?.title)?.data?.title ?? null
      let openTurn = false
      let turnCount = 0
      for (const record of all) {
        if (record?.type === 'turn/start') { openTurn = true; turnCount = Math.max(turnCount, record.data?.turn ?? 0) }
        else if (record?.type === 'turn/end') { openTurn = false; turnCount = Math.max(turnCount, record.data?.turn ?? 0) }
      }
      return {
        sessionId: header?.id ?? null,
        cwd: header?.cwd ?? null,
        createdAt: header?.createdAt ?? null,
        title: lastTitle,
        status: openTurn ? 'working' : 'idle',
        turn: { current: turnCount || null, open: openTurn },
        frames: frames.length,
        lite: true,
      }
    })
  }

  /** 读一个会话文件并折叠状态（带短 TTL 缓存 + 大小/mtime 变更检测）。 */
  function readSummary(file) {
    const key = `${file}:${statSync(file).size}:${statSync(file).mtimeMs}`
    return cache.get(key, () => {
      const buf = readFileSync(file)
      const { records, info } = decodeSessionBytes(buf)
      const summary = summarizeSession(records)
      return { ...summary, decode: { frames: info.frames, decoded: info.decoded, failures: info.failures } }
    })
  }

  return {
    id,
    label,
    docs,

    async probe() {
      const home = dshHome()
      const root = sessionsRoot()
      const hints = []
      if (!existsSync(home)) return probeFail(`找不到 DSH 家目录：${home}`, ['设置环境变量 DSH_HOME 指向你的 .dsh 目录'])
      if (!existsSync(root)) hints.push(`会话目录还不存在（${root}）：DSH 还没跑过任何会话？`)
      if (!hasZstd()) return probeFail('当前 Node 缺少 zstd 支持，读不了 DSH 的 session.jsonl.zstd', ['升级到 Node >= 22.15（推荐 24）'])
      const entry = dshEntry()
      if (!entry) hints.push('没找到 dsh 可执行入口：抽鞭需要它（可设 CW_DSH_BIN 或 agent.options.dshEntry）')
      const sessions = listSessionsSync()
      if (!sessions.length) hints.push('还没发现任何会话；先让 DSH 跑一次任务，或把 agent.cwd 指到已有会话的目录')
      return probeOk(
        `DSH_HOME=${home}，发现 ${sessions.length} 个会话，鞭子模式=${options.whip ?? 'headless'}${entry ? '' : '（无 CLI）'}`,
        hints,
      )
    },

    async listSessions() {
      return listSessionsSync()
    },

    async resolveSession(wanted) {
      const sessions = listSessionsSync()
      const picked = selectSession(sessions, wanted, { cwd })
      if (picked) cache.get(`picked:${picked.path}`, () => picked.raw)
      return picked
    },

    async readState(session) {
      if (!session?.path) return { status: 'unknown', turn: null, lastAnswer: '', lastUserMessage: null, error: '没有会话文件' }
      // 'latest' 模式下，headless 每轮都会新建会话：这里始终跟着最新的走
      let target = session
      if (config.agent?.session === 'latest' || config.agent?.session === undefined) {
        const newest = listSessionsSync()[0]
        if (newest && (newest.updatedAt ?? 0) > (session.updatedAt ?? 0)) target = newest
      }
      try {
        const summary = readSummary(target.path)
        return {
          status: summary.status,
          turn: summary.turn?.current ?? null,
          lastAnswer: summary.lastAnswer ?? '',
          lastUserMessage: summary.lastUserMessage ?? null,
          awaitingInput: summary.status === 'awaiting-input',
          approval: summary.pendingApprovals?.[0] ?? null,
          session: { ...target, id: summary.sessionId ?? target.id, title: summary.title ?? target.title, cwd: summary.cwd ?? target.cwd },
          extra: {
            decode: summary.decode,
            turn: summary.turn,
            todos: summary.todos,
            goal: summary.goal,
            eventCount: summary.eventCount,
            pendingHumanInput: summary.pendingHumanInput,
          },
        }
      } catch (error) {
        return {
          status: 'unknown', turn: null, lastAnswer: '', lastUserMessage: null,
          error: `读会话失败：${error?.message ?? error}`,
        }
      }
    },

    /**
     * 抽鞭。
     * @param {string} text
     * @param {any} session
     * @param {any} engineCtx
     * @returns {Promise<import('./base.mjs').WhipResult>}
     */
    async whip(text, session, engineCtx) {
      const mode = options.whip ?? 'headless'
      switch (mode) {
        case 'headless': return whipHeadless(text, session, engineCtx)
        case 'http': return whipHttp(text, session, engineCtx)
        case 'human-sim': return whipHumanSim(text, session, engineCtx)
        case 'custom': return whipCustom(text, session, engineCtx)
        default:
          return { ok: false, mode: 'inject', detail: `未知的 DSH 抽鞭模式：${mode}（可选 headless/http/human-sim/custom）` }
      }
    },

    async capabilities() {
      const entry = dshEntry()
      const mode = options.whip ?? 'headless'
      return [
        `读会话：session.jsonl.zstd（${hasZstd() ? 'zstd 可用' : 'zstd 不可用！'}）`,
        `抽鞭模式：${mode}`,
        mode === 'headless' ? `命令：${entry ? `${entry.label} --profile headless "<鞭子>"` : '（未找到 dsh 入口）'}` : '',
        mode === 'http' ? `接口：${options.httpEndpoint ?? '未配置 options.httpEndpoint'}` : '',
        mode === 'human-sim' ? `目标窗口：${options.windowMatch ?? '未配置 options.windowMatch'}` : '',
      ].filter(Boolean).join('\n')
    },
  }

  // ---------------------------------------------------------------------------

  /** headless：一次性全新会话，跑完把最后一条回答打到 stdout。 */
  async function whipHeadless(text, session, engineCtx) {
    const entry = dshEntry()
    if (!entry) {
      return { ok: false, mode: 'inject', detail: '找不到 dsh 可执行入口：设 CW_DSH_BIN 或 agent.options.dshEntry' }
    }
    const args = entry.kind === 'node'
      ? [entry.file, '--profile', options.profile ?? 'headless', text]
      : ['--profile', options.profile ?? 'headless', text]
    const started = Date.now()
    log?.step?.(`headless 抽鞭：${entry.label} --profile ${options.profile ?? 'headless'} "<${text.length} 字>"`)
    const result = await run(entry.kind === 'node' ? process.execPath : entry.file, args, {
      cwd: cwd,
      timeoutMs: engineCtx?.config?.guard?.waitForAgentIdleMs ?? 3 * 60 * 60 * 1000,
      signal: engineCtx?.signal,
      env: {
        ...process.env,
        // 无人值守时 DSH 需要一个不会挂起等审批的权限模式（实测：danger-full-access → approval policy=never）
        ...(options.permissionMode ? { DSH_PERMISSION_MODE: options.permissionMode } : {}),
        ...(options.env ?? {}),
      },
      onStderr: (chunk) => log?.debug?.(oneLine(stripAnsi(chunk), 200)),
    })
    const answer = stripAnsi(result.stdout).trim()
    const detail = `headless 退出码 ${result.code}，耗时 ${Math.round((Date.now() - started) / 1000)}s${result.timedOut ? '（超时被杀）' : ''}`
    if (result.code !== 0) {
      log?.warn?.(`${detail}；stderr: ${oneLine(result.stderr, 200)}`)
    } else {
      log?.ok?.(detail)
    }
    return {
      ok: result.code === 0 || answer.length > 0,
      mode: 'foreground',
      detail,
      answer: clip(answer, 20000),
      exitCode: result.code,
    }
  }

  /**
   * HTTP：把消息插进正在运行的会话。
   *
   * 端点与信封来自实测（docs/recon/dsh-control-surfaces.md）：
   *   POST /api/session.prompt
   *   { "type":"client-request", "rpcId":"...", "method":"session.prompt",
   *     "payload": { "sessionId":"session-…", "mode":"queue"|"steer",
   *                  "content":[{"type":"text","text":"…"}] } }
   * `mode:'queue'` = 排成新回合（不打断当前工作，默认）；`'steer'` = 插进当前回合。
   * 冷会话会被隐式 resume（服务端行为）。
   * 注意：DSH 的 /api 没有认证层，所以这个端点只能对 127.0.0.1 使用。
   */
  async function whipHttp(text, session, engineCtx) {
    const endpoint = options.httpEndpoint ?? process.env.CW_DSH_ENDPOINT ?? 'http://127.0.0.1:3080'
    if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(String(endpoint))) {
      return {
        ok: false, mode: 'inject',
        detail: `拒绝向非本机地址注入（${endpoint}）：DSH 的 /api 没有认证层，对外暴露等于把控制权交出去`,
      }
    }
    const path = options.httpPath ?? '/api/session.prompt'
    const url = `${String(endpoint).replace(/\/+$/, '')}${path}`
    const sessionId = session?.id ?? options.sessionId
    if (!sessionId) return { ok: false, mode: 'inject', detail: 'http 模式需要会话 id（session.id）' }
    const body = {
      type: 'client-request',
      rpcId: `cw-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
      method: 'session.prompt',
      payload: {
        sessionId,
        mode: options.httpMode ?? 'queue',
        content: [{ type: 'text', text }],
      },
    }
    try {
      const res = await jsonRequest(url, {
        method: 'POST',
        body,
        headers: options.httpHeaders ?? {},
        timeoutMs: 60000,
      })
      // 服务端用 { ok:false, error:'session-not-found' } 这类 fail-closed 语义
      const payload = res.data?.payload ?? res.data
      if (!res.ok || payload?.ok === false || payload?.error) {
        return {
          ok: false, mode: 'inject',
          detail: `DSH HTTP 注入未成功：HTTP ${res.status}${payload?.error ? ` — ${payload.error}` : ''}`,
        }
      }
      return { ok: true, mode: 'inject', detail: `已通过 ${url} 注入（mode=${body.payload.mode}，rpcId=${body.rpcId}）` }
    } catch (error) {
      // 连不上通常意味着"DSH 的 web 服务没在跑"，属于配置/环境问题而不是监工出错
      return {
        ok: false, mode: 'inject', kind: 'setup',
        detail: `连不上 DSH 的 HTTP 接口 ${url}：${error?.message ?? error}`
          + '（http 模式需要 DSH web 正在运行；或者改用 options.whip="headless"）',
      }
    }
  }

  /** 拟人：在 DSH 的 GUI 窗口里打字。 */
  async function whipHumanSim(text, session, engineCtx) {
    const { createHumanSimAdapter } = await import('./human-sim.mjs')
    const sim = createHumanSimAdapter({
      ...ctx,
      config: {
        ...ctx.config,
        agent: {
          ...ctx.config.agent,
          adapter: 'human-sim',
          options: { ...(options.humanSim ?? {}), ...(options.windowMatch ? { windowMatch: options.windowMatch } : {}) },
        },
      },
    })
    return sim.whip(text, session, engineCtx)
  }

  /** 自定义命令模板。 */
  async function whipCustom(text, session, engineCtx) {
    const template = options.command
    if (!Array.isArray(template) || template.length === 0) {
      return { ok: false, mode: 'inject', detail: 'agent.options.command 需要是非空数组，例如 ["tmux","send-keys","-t","dsh","{text}","Enter"]' }
    }
    const args = template.map(part => String(part)
      .replace(/\{text\}/g, text)
      .replace(/\{session\}/g, session?.id ?? '')
      .replace(/\{cwd\}/g, session?.cwd ?? cwd))
    const [command, ...rest] = args
    const result = await run(command, rest, {
      cwd,
      timeoutMs: options.commandTimeoutMs ?? 60000,
      signal: engineCtx?.signal,
      env: { ...process.env, ...(options.env ?? {}) },
    })
    return {
      ok: result.code === 0,
      mode: options.commandMode === 'foreground' ? 'foreground' : 'inject',
      detail: `自定义命令退出码 ${result.code}${result.stderr ? `：${oneLine(result.stderr, 160)}` : ''}`,
      answer: stripAnsi(result.stdout),
      exitCode: result.code,
    }
  }
}

// ---------------------------------------------------------------------------
// 工具

function safeReaddir(dir) {
  try { return readdirSync(dir) } catch { return [] }
}

function isDir(p) {
  try { return statSync(p).isDirectory() } catch { return false }
}

/** 会话目录里挑出会话文件（可能是 .jsonl.zstd 或未压缩 .jsonl）。 */
function pickSessionFile(dir) {
  const names = safeReaddir(dir)
  const zstd = names.find(n => n === 'session.jsonl.zstd' || n.endsWith('.jsonl.zstd'))
  if (zstd) return join(dir, zstd)
  const plain = names.find(n => n === 'session.jsonl' || n.endsWith('.jsonl'))
  return plain ? join(dir, plain) : null
}

/** 顺带导出：给 `cw sessions` 用的"人类可读摘要"。 */
export function describeSessions(sessions) {
  return sessions.map(s => {
    const when = s.updatedAt ? new Date(s.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '?'
    return `${(s.id ?? '?').padEnd(40)} ${String(s.status ?? '?').padEnd(18)} ${when}  ${oneLine(s.title ?? s.cwd ?? '', 60)}`
  })
}

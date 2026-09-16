/**
 * 赛博监工 · 本地 Web 界面服务端（零依赖）。
 *
 * 设计取舍：
 *  - **只监听 127.0.0.1**，并且校验 Host 头（防止 DNS rebinding 让外部页面打到本机）；
 *  - 用 Node 内置 `node:http`，不引任何前端框架、不需要构建步骤——与本项目"零运行时依赖"一致；
 *  - 界面是单文件 HTML（`src/web/index.html`），内联 CSS/JS，改完刷新即可；
 *  - 监工进程由本服务**作为子进程启动**（`cw run --cwd <项目>`），日志与事件通过 HTTP 轮询拉取，
 *    这样刷新页面/关掉页面都不会影响正在跑的监工。
 *
 * 它**不**做的事（重要的安全边界）：不暴露到局域网、不做远程控制、不替主人点"同意"。
 *
 * @module cyber-overseer/web/server
 */

import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { loadConfig } from '../config.mjs'
import { loadPlan, parsePlan, planProgress, planSummary } from '../plan.mjs'
import { StateStore, statePath } from '../engine/state.mjs'
import { loadAdapters, createAdapter, ADAPTER_CATALOG } from '../adapters/index.mjs'
import { createLogger } from '../util/log.mjs'
import { oneLine } from '../util/text.mjs'
import { isoLocal } from '../util/time.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const INDEX_HTML = join(HERE, 'index.html')
const CLI = join(HERE, '..', '..', 'bin', 'cw.mjs')

/** 默认端口：挑一个不容易冲突的。 */
export const DEFAULT_PORT = 7717

/**
 * 启动界面服务。
 * @param {{cwd?:string, port?:number, host?:string, log?:any, open?:boolean, token?:string}} [opts]
 * @returns {Promise<{url:string, port:number, close:()=>Promise<void>, supervisor:any}>}
 */
export async function startWebUi(opts = {}) {
  const log = opts.log ?? createLogger({ level: 'info' })
  const host = opts.host ?? '127.0.0.1'
  const port = Number(opts.port ?? DEFAULT_PORT)
  const token = opts.token ?? null
  const supervisor = createSupervisor({ log })
  const recents = createRecentsStore()

  const server = createServer(async (req, res) => {
    try {
      if (!hostAllowed(req, host, port)) return sendJson(res, 403, { ok: false, error: 'Host 校验失败（只允许本机访问）' })
      const url = new URL(req.url ?? '/', `http://${host}:${port}`)

      // 静态页面
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return sendHtml(res, readFileSync(INDEX_HTML, 'utf8'))
      }
      if (req.method === 'GET' && url.pathname === '/favicon.ico') {
        res.writeHead(204).end()
        return
      }
      if (!url.pathname.startsWith('/api/')) return sendJson(res, 404, { ok: false, error: 'not found' })
      if (token && url.searchParams.get('token') !== token) return sendJson(res, 401, { ok: false, error: 'token 不匹配' })

      const body = req.method === 'POST' ? await readJsonBody(req) : {}
      const cwd = resolveProject(body.cwd ?? url.searchParams.get('cwd') ?? process.cwd())

      switch (url.pathname) {
        case '/api/ping':
          return sendJson(res, 200, { ok: true, version: '0.1.0', at: isoLocal() })
        case '/api/projects':
          return sendJson(res, 200, { ok: true, ...recents.list(), suggested: suggestProjects() })
        case '/api/state':
          return sendJson(res, 200, { ok: true, ...(await readProjectState(cwd, log, supervisor, Number(url.searchParams.get('since') ?? 0))) })
        case '/api/init':
          return sendJson(res, 200, { ok: true, ...scaffoldProject(cwd) })
        case '/api/plan':
          return sendJson(res, 200, body.text === undefined
            ? { ok: true, ...readPlanInfo(cwd) }
            : writePlan(cwd, String(body.text)))
        case '/api/config':
          return sendJson(res, 200, body.config === undefined
            ? { ok: true, ...readConfigInfo(cwd, log) }
            : writeConfig(cwd, body.config, log))
        case '/api/adapters':
          return sendJson(res, 200, { ok: true, ...(await probeAdapters(cwd, log)) })
        case '/api/sessions':
          return sendJson(res, 200, { ok: true, ...(await listSessions(cwd, body.adapter ?? url.searchParams.get('adapter'), log)) })
        case '/api/start':
          recents.remember(cwd)
          return sendJson(res, 200, supervisor.start({
            cwd,
            log,
            dryRun: Boolean(body.dryRun),
            planFile: readPlanInfo(cwd).planFile,
          }))
        case '/api/stop':
          return sendJson(res, 200, await supervisor.stop())
        case '/api/pause':
          return sendJson(res, 200, togglePause(cwd, true))
        case '/api/resume':
          return sendJson(res, 200, togglePause(cwd, false))
        case '/api/report':
          return sendJson(res, 200, readReport(cwd))
        case '/api/judge':
          return sendJson(res, 200, await runJudgeOnce(cwd, log))
        default:
          return sendJson(res, 404, { ok: false, error: `未知接口：${url.pathname}` })
      }
    } catch (error) {
      log.warn?.(`界面请求出错：${error?.message ?? error}`)
      return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  })

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(port, host, () => resolveListen())
  })
  const actualPort = server.address().port
  const url = `http://${host}:${actualPort}/`
  log.ok(`赛博监工界面已启动：${url}`)
  if (opts.open !== false) openBrowser(url, log)

  return {
    url,
    port: actualPort,
    supervisor,
    close: async () => {
      await supervisor.stop().catch(() => {})
      await new Promise(done => server.close(done))
    },
  }
}

// ---------------------------------------------------------------------------
// 子进程：监工

function createSupervisor({ log }) {
  let child = null
  let meta = { running: false, pid: null, cwd: null, startedAt: null, exitCode: null, dryRun: false }
  const lines = []          // 子进程输出（环形）
  const MAX_LINES = 800

  const push = (stream, text) => {
    for (const raw of String(text).split('\n')) {
      const line = raw.replace(/\u001B\[[0-9;]*m/g, '').trimEnd()
      if (!line.trim()) continue
      lines.push({ at: Date.now(), stream, text: line })
    }
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES)
  }

  return {
    get meta() { return meta },
    get lines() { return lines },
    start({ cwd, log: logger, dryRun = false, planFile = null }) {
      if (child && meta.running) return { ok: false, error: '已经在跑了（先停止）', ...meta }
      const args = [CLI, dryRun ? 'watch' : 'run', '--cwd', cwd]
      // 显式钉住这几个路径到项目目录：项目配置里的 plan/report/journal 常常是"相对仓库根"写的，
      // 而这里的工作目录是项目目录，不显式指定就会被拼重（真实踩到过两次）。
      args.push('--journal-dir', join(cwd, '.cyber'))
      args.push('--state-file', join(cwd, '.cyber', 'state.json'))
      args.push('--report', join(cwd, 'CW-REPORT.md'))
      if (planFile) args.push('--plan', resolve(cwd, planFile))
      const configFile = join(cwd, '.cyber', 'ui.config.json')
      if (existsSync(configFile)) args.push('--config', configFile)
      child = spawn(process.execPath, args, { cwd, env: process.env, windowsHide: true })
      meta = { running: true, pid: child.pid, cwd, startedAt: Date.now(), exitCode: null, dryRun }
      lines.length = 0
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', chunk => push('out', chunk))
      child.stderr.on('data', chunk => push('err', chunk))
      child.on('exit', (code, signal) => {
        meta = { ...meta, running: false, exitCode: code, signal, endedAt: Date.now() }
        push('sys', `[监工进程结束] 退出码 ${code}${signal ? ` 信号 ${signal}` : ''}`)
        logger?.info?.(`监工进程结束：退出码 ${code}`)
      })
      logger?.ok?.(`已启动监工（pid=${child.pid}，${dryRun ? '演练模式' : '真抽'}）`)
      return { ok: true, ...meta }
    },
    async stop() {
      if (!child || !meta.running) return { ok: true, message: '没有在跑' }
      push('sys', '[已请求停止]')
      const pid = child.pid
      if (process.platform === 'win32') {
        await new Promise(done => {
          const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true })
          killer.on('exit', done)
          killer.on('error', done)
        })
      } else {
        try { child.kill('SIGTERM') } catch { /* 已退出 */ }
      }
      meta = { ...meta, running: false, exitCode: meta.exitCode ?? -1 }
      child = null
      return { ok: true, message: `已停止 pid=${pid}` }
    },
    /** 供 /api/state 使用：最近的输出与运行状态。 */
    tail(sinceAt = 0) {
      return { ...meta, lines: lines.filter(line => line.at > sinceAt) }
    },
  }
}

// ---------------------------------------------------------------------------
// 项目状态

async function readProjectState(cwd, log, supervisor, since = 0) {
  const state = { cwd, exists: existsSync(cwd) }
  if (!state.exists) return { ...state, error: '目录不存在' }

  // 方案文档（项目内 PLAN.md）
  Object.assign(state, readPlanInfo(cwd))
  // 配置（只展示，不覆盖手写的 .mjs）
  Object.assign(state, readConfigInfo(cwd, log))

  // 状态 / 日志 / 报告：**一律用项目本地路径**。
  // 因为启动子进程时我们显式钉住了这些路径（见 supervisor.start），读的时候必须用同一套，
  // 否则会出现"子进程写的是项目内、界面读的是配置里的路径"这种两边不一致（真实踩到过）。
  const cyberDir = join(cwd, '.cyber')
  try {
    const store = StateStore.open(join(cyberDir, 'state.json'))
    state.run = store.summary()
  } catch (error) {
    state.runError = String(error?.message ?? error)
  }
  state.journal = readJournalFile(join(cyberDir, 'journal.jsonl'), 200)
  state.paused = existsSync(join(cyberDir, 'PAUSE'))
  state.supervisor = supervisor.tail(since)
  state.report = existsSync(join(cwd, 'CW-REPORT.md'))
  return state
}

/** 读方案文档并解析进度。 */
export function readPlanInfo(cwd) {
  const candidates = ['PLAN.md', 'plan.md', 'PLAN.MD', 'docs/PLAN.md']
  for (const name of candidates) {
    const file = resolve(cwd, name)
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8')
    const plan = parsePlanSafe(text)
    return {
      planFile: name,
      planText: text,
      plan: {
        title: plan.title,
        objective: plan.objective,
        acceptance: plan.acceptance,
        emptyTodos: plan.remaining,
        doneCount: plan.doneCount,
        totalCount: plan.totalCount,
        progress: planProgress(plan),
        summary: planSummary(plan, 1500),
      },
    }
  }
  return { planFile: null, planText: '', plan: null }
}

function parsePlanSafe(text) {
  try { return parsePlan(text) } catch { return null }
}

function writePlan(cwd, text) {
  const info = readPlanInfo(cwd)
  const target = resolve(cwd, info.planFile ?? 'PLAN.md')
  writeFileSync(target, text, 'utf8')
  return { ok: true, saved: target, ...readPlanInfo(cwd) }
}

/** 读配置（并说明它来自哪里）。 */
export function readConfigInfo(cwd, log) {
  const handWritten = ['cw.config.mjs', 'cw.config.js'].map(f => resolve(cwd, f)).find(existsSync) ?? null
  const uiConfig = resolve(cwd, '.cyber', 'ui.config.json')
  const effectiveSource = handWritten
    ? { kind: 'handwritten', file: handWritten }
    : (existsSync(uiConfig) ? { kind: 'ui', file: uiConfig } : { kind: 'default', file: null })
  let config = null
  if (effectiveSource.kind === 'ui') {
    try { config = JSON.parse(readFileSync(uiConfig, 'utf8')) } catch { config = null }
  }
  return {
    configSource: effectiveSource,
    editable: effectiveSource.kind !== 'handwritten',
    config,
    note: effectiveSource.kind === 'handwritten'
      ? '这个项目用的是手写的 cw.config.mjs：界面只展示、不覆盖它（要改请直接编辑文件）'
      : '界面把配置存在 .cyber/ui.config.json，启动监工时通过 --config 传给它',
  }
}

/** 写 UI 配置（不碰手写的 .mjs）。 */
function writeConfig(cwd, config, log) {
  const info = readConfigInfo(cwd, log)
  if (!info.editable) return { ok: false, error: info.note }
  const file = resolve(cwd, '.cyber', 'ui.config.json')
  mkdirSync(dirname(file), { recursive: true })
  const merged = { ...(info.config ?? {}), ...config }
  writeFileSync(file, JSON.stringify(merged, null, 2), 'utf8')
  log?.info?.('已保存界面配置')
  return { ok: true, saved: file, ...readConfigInfo(cwd, log) }
}

/** 探针：各适配器在这台机器上能不能用。 */
async function probeAdapters(cwd, log) {
  await loadAdapters()
  const { config } = await loadConfig({ cwd, log })
  const out = []
  for (const entry of ADAPTER_CATALOG) {
    try {
      const adapter = createAdapter(entry.id, { config, cwd, log })
      const probe = await adapter.probe()
      out.push({ id: entry.id, label: entry.label, channel: entry.channel, note: entry.note, ok: probe.ok, detail: probe.detail ?? probe.reason ?? '', hints: probe.hints ?? [] })
    } catch (error) {
      out.push({ id: entry.id, label: entry.label, channel: entry.channel, ok: false, detail: String(error?.message ?? error), hints: [] })
    }
  }
  return { adapters: out }
}

/** 列出某个适配器能监工的会话。 */
async function listSessions(cwd, adapterId, log) {
  await loadAdapters()
  const id = adapterId || 'dsh'
  const { config } = await loadConfig({ cwd, log })
  const adapter = createAdapter(id, { config, cwd, log })
  const probe = await adapter.probe()
  if (!probe.ok) return { sessions: [], error: probe.reason }
  const sessions = await adapter.listSessions()
  return {
    sessions: sessions.slice(0, 60).map(s => ({ id: s.id, title: s.title, cwd: s.cwd, updatedAt: s.updatedAt, status: s.raw?.status ?? null })),
  }
}

/** 读 journal 的尾部事件（界面时间线用）。 */
function readJournalFile(file, limit) {
  if (!existsSync(file)) return []
  try {
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-limit)
    return lines.map(line => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}

function readReport(cwd) {
  const file = resolve(cwd, 'CW-REPORT.md')
  if (!existsSync(file)) return { exists: false, text: '' }
  try { return { exists: true, text: readFileSync(file, 'utf8') } } catch { return { exists: false, text: '' } }
}

function togglePause(cwd, pause) {
  const file = resolve(cwd, '.cyber', 'PAUSE')
  if (pause) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `paused at ${isoLocal()}（由界面发起）\n`, 'utf8')
    return { ok: true, paused: true }
  }
  if (existsSync(file)) {
    try { unlinkSync(file) } catch { /* 忽略 */ }
  }
  return { ok: true, paused: false }
}

/** 只判定一次（界面上的"预览判定"）。 */
async function runJudgeOnce(cwd, log) {
  const { config, planPath, agentCwd } = await loadConfig({ cwd, log })
  await loadAdapters()
  const plan = loadPlan(planPath)
  const adapter = createAdapter(config.agent?.adapter ?? 'dsh', { config, cwd: agentCwd, log })
  const probe = await adapter.probe()
  if (!probe.ok) return { ok: false, error: `适配器不可用：${probe.reason}` }
  const session = await adapter.resolveSession(config.agent?.session ?? 'latest')
  const snapshot = session ? await adapter.readState(session) : { status: 'unknown', lastAnswer: '' }
  const { collectEvidence } = await import('../engine/evidence.mjs')
  const { createJudge } = await import('../judge/index.mjs')
  const evidence = await collectEvidence({ config, cwd: agentCwd, plan, answer: snapshot.lastAnswer ?? '', log })
  const judge = createJudge(config, { log })
  const verdict = await judge.judge({
    plan, progress: planProgress(plan), answer: snapshot.lastAnswer ?? '', lastUserMessage: snapshot.lastUserMessage ?? null,
    evidence, history: [], config, round: 1, log,
  })
  return {
    ok: true,
    verdict,
    snapshot: { status: snapshot.status, answerChars: (snapshot.lastAnswer ?? '').length, answerTail: oneLine(String(snapshot.lastAnswer ?? '').slice(-600), 600) },
    evidence: evidence.verify.map(v => ({ command: v.command, ok: v.ok, code: v.code })),
  }
}

// ---------------------------------------------------------------------------
// 项目脚手架与"最近使用"

function scaffoldProject(cwd) {
  if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true })
  const planFile = resolve(cwd, 'PLAN.md')
  let createdPlan = false
  if (!existsSync(planFile)) {
    writeFileSync(planFile, `# 在这里写一句目标

## 目标
用一两段话说清楚"做完是什么样"。监工只认这份文档。

## 验收标准
- 写下**可以被命令验证**的标准，例如：npm test 全绿、curl localhost:3000/health 返回 200

## 任务清单
- [ ] 第一件事（小到能在一轮内做完）
- [ ] 第二件事

## 禁止 / 范围外
- 不要动 CI 配置
`, 'utf8')
    createdPlan = true
  }
  const cyberDir = resolve(cwd, '.cyber')
  if (!existsSync(cyberDir)) mkdirSync(cyberDir, { recursive: true })
  return { createdPlan, planFile: createdPlan ? 'PLAN.md' : readPlanInfo(cwd).planFile }
}

function createRecentsStore() {
  const file = resolve(process.env.CW_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.cyber-overseer'), 'recent-projects.json')
  const read = () => {
    try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return { projects: [] } }
  }
  return {
    list() { return read() },
    remember(cwd) {
      const data = read()
      const projects = [cwd, ...(data.projects ?? []).filter(p => p !== cwd)].slice(0, 12)
      try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify({ projects }, null, 2), 'utf8') } catch { /* 忽略 */ }
      return { projects }
    },
  }
}

/** 猜几个"很可能想监工"的项目目录（你工作区里带 PLAN.md 或 .git 的）。 */
function suggestProjects(limit = 12) {
  const roots = [process.env.CW_PROJECTS_ROOT, process.cwd(), resolve(process.cwd(), '..')].filter(Boolean)
  const seen = new Set()
  const out = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const entry of safeReaddir(root).slice(0, 300)) {
      if (entry.startsWith('.')) continue
      const full = join(root, entry)
      try {
        if (!statSync(full).isDirectory()) continue
      } catch { continue }
      const hasPlan = existsSync(join(full, 'PLAN.md'))
      const hasGit = existsSync(join(full, '.git'))
      if (!hasPlan && !hasGit) continue
      if (seen.has(full)) continue
      seen.add(full)
      out.push({ cwd: full, name: entry, hasPlan })
    }
  }
  return out.slice(0, limit)
}

// ---------------------------------------------------------------------------
// HTTP 小工具

function hostAllowed(req, host, port) {
  const header = String(req.headers.host ?? '')
  const name = header.split(':')[0].toLowerCase()
  return ['127.0.0.1', 'localhost', '[::1]', host.toLowerCase()].includes(name)
}

/** 把请求里的项目目录解析成绝对路径（空则回退到服务启动目录）。 */
function resolveProject(input) {
  const value = String(input ?? '').trim()
  if (!value) return process.cwd()
  return resolve(value)
}

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload, (_k, v) => (typeof v === 'bigint' ? String(v) : v))
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

function sendHtml(res, html) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(html)
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 2 * 1024 * 1024) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  try { return JSON.parse(text) } catch { return {} }
}

function safeReaddir(dir) {
  try { return readdirSync(dir) } catch { return [] }
}

/** 打开浏览器（尽力而为，失败不影响服务）。 */
function openBrowser(url, log) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { windowsHide: true, detached: true, stdio: 'ignore' }).unref()
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
    }
  } catch (error) {
    log?.debug?.(`打开浏览器失败（不影响使用）：${error?.message ?? error}`)
  }
}

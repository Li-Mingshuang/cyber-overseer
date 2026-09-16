/**
 * `cw status --watch` 的实时面板。
 *
 * 无人值守时主人最想知道的是"现在到哪一步了"——不用去翻 journal.jsonl。所以这里把
 * 状态文件（`.cyber/state.json`、`.cyber/agents/<name>/state.json`）与各自事件日志的尾部
 * 聚合成一屏 ANSI 面板：当前轮次、最近判定、最近一条鞭子、验收命令状态、花费、
 * 距下次静默期还有多久。
 *
 * 设计约束：
 *  - **纯渲染**：`renderPanel()` 只吃数据、吐字符串，因此可以被单测钉死（不依赖 TTY）；
 *  - **只读**：面板绝不写任何状态，只是读磁盘；
 *  - 多 agent 与单 agent 用同一套渲染，主人不用学两种界面。
 *
 * @module cyber-overseer/engine/panel
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { loadPlan } from '../plan.mjs'
import { statePath } from './state.mjs'
import { prepareAgentEntries } from './multi.mjs'
import { humanDuration, inWindow, isoLocal, msUntilWindow } from '../util/time.mjs'
import { oneLine } from '../util/text.mjs'

/** ANSI 色码（color=false 时全部忽略）。 */
const C = {
  reset: '\u001B[0m', bold: '\u001B[1m', dim: '\u001B[2m',
  red: '\u001B[31m', green: '\u001B[32m', yellow: '\u001B[33m',
  cyan: '\u001B[36m', gray: '\u001B[90m',
}

/**
 * 聚合面板要显示的数据源。
 * @param {{cwd:string, config:any, now?:number}} args
 * @returns {any[]}
 */
export function panelSources({ cwd, config }) {
  const baseDir = isAbsolute(config.journal?.dir ?? '.cyber')
    ? config.journal.dir
    : resolve(cwd, config.journal?.dir ?? '.cyber')
  const sources = []
  const entries = prepareAgentEntries(config, cwd)

  // 单 agent 时叫 main；多 agent 时顶层那份配置基本没用上，只是留个位置
  sources.push(buildSource({
    name: entries.length ? '(顶层)' : 'main',
    file: statePath(config, cwd),
    planPath: isAbsolute(config.plan) ? config.plan : resolve(cwd, config.plan),
    journalFile: join(baseDir, 'journal.jsonl'),
    adapterHint: config.agent?.adapter ?? null,
  }))

  for (const entry of entries) {
    sources.push(buildSource({
      name: entry.name,
      file: entry.config.runtime?.stateFile ?? join(baseDir, 'agents', entry.name, 'state.json'),
      planPath: entry.planPath,
      journalFile: join(entry.config.journal?.dir ?? join(baseDir, 'agents', entry.name), 'journal.jsonl'),
      adapterHint: entry.config.agent?.adapter ?? null,
    }))
  }
  return sources
}

function buildSource({ name, file, planPath, journalFile, adapterHint }) {
  const state = readJson(file)
  const events = readJournalTail(journalFile, 300)
  const evidence = lastOf(events, 'evidence')
  const verdict = lastOf(events, 'verdict')
  const inject = lastOf(events, 'inject')
  const guard = lastOf(events, 'guard')
  const start = events.find(e => e.kind === 'start' || e.kind === 'multi-start') ?? null
  const plan = readPlan(planPath)
  const rounds = state?.rounds ?? []
  const lastRound = rounds.at(-1) ?? null
  return {
    name,
    file,
    journalFile,
    planPath,
    exists: Boolean(state),
    status: state?.status ?? 'idle',
    stopReason: state?.stopReason ?? null,
    adapter: state?.adapter ?? adapterHint ?? '?',
    sessionId: state?.sessionId ?? null,
    rounds: state?.roundsStarted ?? rounds.length,
    costUsd: state?.costUsd ?? 0,
    startedAt: state?.startedAt ?? null,
    updatedAt: state?.updatedAt ?? null,
    lastVerdict: verdict ? { status: verdict.status, reason: verdict.reason, confidence: verdict.confidence } : (lastRound?.verdict ?? null),
    lastWhip: inject?.whip ? { text: inject.whip, at: inject.at, ok: inject.ok !== false } : (lastRound?.injected ? { text: lastRound.injected, at: lastRound.endedAt, ok: true } : null),
    verify: Array.isArray(evidence?.verify) ? evidence.verify : [],
    lastGuard: guard ? { reason: guard.reason, at: guard.at, shared: Boolean(guard.shared) } : null,
    startedPlan: start?.progress ?? null,
    plan,
  }
}

function lastOf(events, kind) {
  for (let i = events.length - 1; i >= 0; i--) if (events[i]?.kind === kind) return events[i]
  return null
}

/** 读事件日志尾部（读不到就返回空数组，面板不能因为日志缺失而崩）。 */
export function readJournalTail(file, limit = 300) {
  try {
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    return lines.slice(-limit).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch {
    return []
  }
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

function readPlan(file) {
  try {
    const plan = loadPlan(file)
    return { path: file, done: plan.doneCount, total: plan.totalCount, remaining: plan.remaining.length, error: null }
  } catch (error) {
    return { path: file, done: 0, total: 0, remaining: 0, error: String(error?.message ?? error) }
  }
}

/**
 * 静默期/工作时段状态（面板顶部那一行）。
 * @param {any} guard
 * @param {Date} [date]
 */
export function windowStatus(guard = {}, date = new Date()) {
  const win = guard.quietHours ?? guard.workWindow ?? null
  if (!win) return { kind: null, label: '时段：不限（随时可能动手）' }
  const kind = guard.quietHours ? 'quiet' : 'work'
  const inside = inWindow(win, date)
  const name = kind === 'quiet' ? '静默期' : '工作时段'
  const range = `${win.from}–${win.to}`
  if (inside) return { kind, inside: true, label: `${name} ${range}：进行中` }
  const waitMs = msUntilWindow(win, date)
  return { kind, inside: false, waitMs, label: `${name} ${range}：还有 ${humanDuration(waitMs)} 开始` }
}

const STATUS_STYLE = {
  running: { text: '● 正在跑', color: 'cyan' },
  working: { text: '● 正在跑', color: 'cyan' },
  idle: { text: '○ 空闲', color: 'gray' },
  done: { text: '✔ 已完成', color: 'green' },
  'dry-run': { text: '🧪 演练完成', color: 'yellow' },
  blocked: { text: '🛑 受阻', color: 'red' },
  'needs-human': { text: '🙋 需要主人', color: 'yellow' },
  stalled: { text: '😵 卡死', color: 'red' },
  error: { text: '💥 出错', color: 'red' },
  paused: { text: '⏸ 已暂停', color: 'yellow' },
}

/** 人类可读的"多久之前"。 */
export function formatAge(ms) {
  if (!Number.isFinite(ms)) return '?'
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 5) return '刚刚'
  if (s < 60) return `${s} 秒前`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} 分钟前`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.round(h / 24)} 天前`
}

/**
 * 把聚合数据渲染成一屏文本。
 * @param {any[]} sources
 * @param {{now?:number, color?:boolean, paused?:boolean, cwd?:string, guard?:any, date?:Date}} [opts]
 * @returns {string}
 */
export function renderPanel(sources, opts = {}) {
  const now = opts.now ?? Date.now()
  const color = opts.color === true
  const paint = (text, code) => (color ? `${C[code] ?? ''}${text}${C.reset}` : text)
  const lines = []

  const title = `赛博监工 · 实时面板`
  lines.push(paint(`${title}   ${isoLocal(now)}`, 'bold'))
  if (opts.cwd) lines.push(paint(`  ${opts.cwd}`, 'gray'))
  const win = windowStatus(opts.guard ?? {}, opts.date ?? new Date(now))
  const paused = opts.paused ? paint('⏸ 已暂停（存在 PAUSE 哨兵）', 'yellow') : '▶ 运行中'
  lines.push(`  ${paused}   ${win.label}`)
  lines.push('')

  // 只显示"真的跑过"的对象；一个都没有时给出最直接的下一步，并列出配置里等着被监工的 agent。
  const shown = sources.filter(s => s.exists)
  if (!shown.length) {
    lines.push(paint('  还没有跑过监工（找不到状态文件）。先来一次：cw run', 'gray'))
    const configured = sources.filter(s => s.name !== '(顶层)').map(s => s.name)
    if (configured.length) lines.push(paint(`  配置里的 agent：${configured.join('、')}（都还没开始）`, 'gray'))
    return lines.join('\n')
  }
  const notStarted = sources.filter(s => !s.exists && s.name !== '(顶层)').map(s => s.name)

  for (const source of shown) {
    const style = STATUS_STYLE[source.status] ?? { text: `· ${source.status}`, color: 'gray' }
    const roundText = source.rounds ? `第 ${source.rounds} 轮` : '尚未开始'
    const head = `${source.name}  ${style.text}（${roundText}）`
    // 状态写着"正在跑"但很久没落盘 = 进程大概已经没了（面板只读磁盘，只能这样提示）
    const stale = source.status === 'running' && source.updatedAt && (now - source.updatedAt) > (opts.staleMs ?? 10 * 60 * 1000)
    lines.push(
      paint(`▌${head}`, style.color === 'gray' ? 'bold' : style.color)
      + paint(`   $${Number(source.costUsd ?? 0).toFixed(4)}`, 'gray')
      + (stale ? paint('   可能已停（状态很久没更新）', 'yellow') : ''),
    )
    lines.push(`   适配器 ${source.adapter}${source.sessionId ? `  会话 ${String(source.sessionId).slice(0, 32)}` : ''}${source.stopReason ? `  结束原因 ${source.stopReason}` : ''}`)
    if (!source.exists) {
      lines.push(paint('   （这个 agent 还没开始跑）', 'gray'))
      lines.push('')
      continue
    }

    const planText = source.plan?.error
      ? paint(`方案读不到：${oneLine(source.plan.error, 60)}`, 'red')
      : `方案 ${source.plan.done}/${source.plan.total} 已勾选${source.plan.remaining ? `，剩 ${source.plan.remaining} 项` : ''}`
    lines.push(`   ${planText}`)

    if (source.lastVerdict) {
      lines.push(`   最近判定：${source.lastVerdict.status} — ${oneLine(source.lastVerdict.reason ?? '', 70)}`)
    }
    if (source.lastWhip?.text) {
      lines.push(`   最近鞭子：${oneLine(source.lastWhip.text, 70)}`)
    }
    if (source.verify?.length) {
      const cells = source.verify.map(v => {
        const mark = v.ok ? paint('✔', 'green') : paint('✖', 'red')
        const cached = v.cached ? '（复用）' : ''
        return `${mark} ${v.command}${v.code != null && !v.ok ? `（码 ${v.code}）` : ''}${cached}`
      })
      lines.push(`   验收命令：${cells.join('   ')}`)
    } else {
      lines.push(paint('   验收命令：未配置（判定会变弱，建议在 evidence.verify 里加一条）', 'gray'))
    }
    const updated = source.updatedAt ? formatAge(now - source.updatedAt) : '?'
    const started = source.startedAt ? `已跑 ${humanDuration(now - source.startedAt)}` : ''
    lines.push(paint(`   更新：${updated}${started ? `   ${started}` : ''}`, 'gray'))
    lines.push('')
  }
  if (notStarted.length) lines.push(paint(`  还没开始的 agent：${notStarted.join('、')}`, 'gray'))
  lines.push(paint('  Ctrl+C 退出面板；cw pause / cw resume 可以喊停与继续。', 'gray'))
  return lines.join('\n')
}

/**
 * 循环刷新面板（`cw status --watch`）。
 *
 * `maxTicks` 与注入的 sleep 让这个循环可被单测（不需要真的等 2 秒，也不需要 TTY）。
 * @param {{
 *   cwd:string, config:any, out?:any, log?:any, intervalMs?:number, maxTicks?:number,
 *   signal?:AbortSignal, sleepFn?:(ms:number, signal?:AbortSignal)=>Promise<void>, now?:()=>number,
 *   color?:boolean, clear?:boolean
 * }} opts
 * @returns {Promise<{ticks:number, interrupted:boolean}>}
 */
export async function watchStatus(opts) {
  const {
    cwd, config, log,
    intervalMs = 2000, maxTicks = 0,
    signal, now = () => Date.now(),
  } = opts
  const out = opts.out ?? process.stdout
  const sleepFn = opts.sleepFn ?? ((ms, sig) => new Promise((resolveSleep, reject) => {
    if (sig?.aborted) return reject(new Error('aborted'))
    const timer = setTimeout(resolveSleep, ms)
    sig?.addEventListener?.('abort', () => { clearTimeout(timer); reject(new Error('aborted')) }, { once: true })
  }))
  const clear = opts.clear ?? Boolean(out.isTTY)
  const color = opts.color ?? Boolean(out.isTTY)
  const pauseFile = isAbsolute(config.guard?.pauseFile ?? '.cyber/PAUSE')
    ? config.guard.pauseFile
    : resolve(cwd, config.guard?.pauseFile ?? '.cyber/PAUSE')

  let ticks = 0
  for (;;) {
    const sources = panelSources({ cwd, config, now })
    const text = renderPanel(sources, { now: now(), color, cwd, guard: config.guard, paused: existsSync(pauseFile) })
    if (clear) out.write('\u001B[2J\u001B[3J\u001B[H')
    out.write(text + '\n')
    ticks++
    if (maxTicks > 0 && ticks >= maxTicks) return { ticks, interrupted: false }
    try {
      await sleepFn(intervalMs, signal)
    } catch {
      return { ticks, interrupted: true }
    }
    if (signal?.aborted) return { ticks, interrupted: true }
  }
}

/** 列出 `.cyber/agents/<name>/state.json`（给面板/status 用；不依赖 multi 的展开逻辑）。 */
export function discoverAgentStates(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => join(dir, entry.name, 'state.json'))
      .filter(file => existsSync(file))
  } catch {
    return []
  }
}

/**
 * 多 agent 并行监工。
 *
 * 单 agent 的循环在 `loop.mjs`；这里只做"编排"：
 *
 *   1. 把 `config.agents[]` 的每个条目展开成一份**独立的** agent 配置
 *      （自己的 adapter / cwd / 方案文档 / 判定器），互不干扰；
 *   2. 每个条目一个 `runOverseer`，用 `Promise.all` 并行跑；
 *   3. 所有条目**共享一套预算**（轮次/时长/花费，见 budget.mjs）——主人睡一觉起来
 *      不会因为"3 个 agent × 各自 24 轮"而拿到天价账单；
 *   4. 每个 agent 有分项报告（`CW-REPORT-<name>.md`）与独立日志目录
 *      （`.cyber/agents/<name>/`），最后再合并出一份总的 `CW-REPORT.md`。
 *
 * 失败语义：任何一个 agent 挂掉都不会拖垮其它 agent（用 try/catch 兜住，记成一条 error 结果）；
 * 退出码取"最严重"的那个，全部完成才是 0。
 *
 * @module cyber-overseer/engine/multi
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { mergeConfig } from '../config.mjs'
import { loadPlan } from '../plan.mjs'
import { Journal } from './journal.mjs'
import { EXIT_CODES, runOverseer } from './loop.mjs'
import { createBudget } from './budget.mjs'
import { humanDuration, isoLocal } from '../util/time.mjs'
import { oneLine } from '../util/text.mjs'

/** 配置里写了并行 agent 吗？ */
export function isMultiAgent(config) {
  return Array.isArray(config?.agents) && config.agents.length > 0
}

/**
 * 把 `config.agents[]` 展开成可运行的条目。
 *
 * 支持两种写法（可以混用）：
 * ```js
 * { name:'web', adapter:'cursor', cwd:'apps/web', options:{ windowMatch:{...} } }   // 简写
 * { name:'api', agent:{ adapter:'codex', session:'latest' }, plan:'PLAN-api.md' }   // 完整
 * ```
 * @param {any} config
 * @param {string} baseCwd
 * @returns {{name:string, agentCwd:string, planPath:string, config:any}[]}
 */
export function prepareAgentEntries(config, baseCwd) {
  const raw = Array.isArray(config?.agents) ? config.agents : []
  const used = new Set()
  const mergedReportFile = resolve(baseCwd, config?.journal?.reportFile ?? 'CW-REPORT.md')
  return raw.map((entry, index) => {
    const base = entry && typeof entry === 'object' ? entry : {}
    let name = String(base.name ?? base.id ?? `agent-${index + 1}`).trim() || `agent-${index + 1}`
    if (used.has(name)) {
      let suffix = 2
      while (used.has(`${name}-${suffix}`)) suffix++
      name = `${name}-${suffix}`
    }
    used.add(name)

    const agentCwd = base.cwd
      ? (isAbsolute(base.cwd) ? base.cwd : resolve(baseCwd, base.cwd))
      : baseCwd

    const merged = mergeConfig(config, buildOverride(base))
    merged.agents = [] // 防止递归展开
    merged.__cwd = agentCwd
    merged.agent = { ...(merged.agent ?? {}), cwd: agentCwd }
    merged.plan = isAbsolute(merged.plan) ? merged.plan : resolve(agentCwd, merged.plan)

    // 监工自己的东西（日志/状态/分项报告）统一放在主项目的 .cyber/agents/<name>/，
    // 不管被监工的 agent 在哪个子目录——主人只需要看一个地方。
    const baseJournalDir = isAbsolute(config?.journal?.dir ?? '.cyber')
      ? config.journal.dir
      : resolve(baseCwd, config?.journal?.dir ?? '.cyber')
    const agentDir = resolve(baseJournalDir, 'agents', name)
    const wantedReport = base.journal?.reportFile ? resolve(baseCwd, base.journal.reportFile) : null
    const reportFile = (wantedReport && wantedReport !== mergedReportFile)
      ? wantedReport
      : resolve(baseCwd, `CW-REPORT-${name}.md`)
    merged.journal = { ...(merged.journal ?? {}), dir: agentDir, reportFile }
    merged.runtime = {
      ...(merged.runtime ?? {}),
      stateFile: resolve(agentDir, 'state.json'),
    }

    return { name, agentCwd, planPath: merged.plan, config: merged }
  })
}

/** 把条目里的简写折叠成标准配置覆盖（不污染顶层字段）。 */
function buildOverride(entry) {
  const override = { ...entry }
  delete override.name
  delete override.id
  delete override.cwd
  delete override.agents
  const agentExtra = { ...(entry.agent ?? {}) }
  if (entry.adapter !== undefined) agentExtra.adapter = entry.adapter
  if (entry.session !== undefined) agentExtra.session = entry.session
  if (entry.options !== undefined) agentExtra.options = { ...(entry.agent?.options ?? {}), ...entry.options }
  delete override.agent
  if (Object.keys(agentExtra).length) override.agent = agentExtra
  return override
}

/** 给日志加 agent 名前缀，好让并行时交错的控制台输出能分清是谁。 */
export function createAgentLogger(base, name) {
  if (!base) return base
  const tag = `[${name}]`
  const wrap = (fn) => (typeof fn === 'function' ? (...args) => fn(tag, ...args) : undefined)
  return {
    level: base.level,
    enabled: base.enabled,
    error: wrap(base.error),
    warn: wrap(base.warn),
    info: wrap(base.info),
    ok: wrap(base.ok),
    step: wrap(base.step),
    debug: wrap(base.debug),
    trace: wrap(base.trace),
    raw: (text) => base.raw(text),
    banner: (text) => base.banner(`${tag} ${text}`),
  }
}

/**
 * 并行监工的全部 agent。
 * @param {{
 *   config:any, cwd:string, log?:any, signal?:AbortSignal, deps?:Record<string,any>, resume?:boolean
 * }} opts
 * @returns {Promise<{
 *   multi:true, results:any[], mergedReportPath:string|null, stopReason:string,
 *   exitCode:number, rounds:number, costUsd:number, budget:any, elapsedMs:number
 * }>}
 */
export async function runMultiAgent(opts) {
  const { config, log } = opts
  const baseCwd = opts.cwd ?? config?.__cwd ?? process.cwd()
  const deps = opts.deps ?? {}
  const resume = opts.resume !== false
  const startedAt = Date.now()
  const entries = prepareAgentEntries(config, baseCwd)

  const budget = deps.budget ?? createBudget(config.guard ?? {}, { startedAt })
  const journal = new Journal({
    dir: isAbsolute(config.journal?.dir ?? '.cyber') ? config.journal.dir : resolve(baseCwd, config.journal?.dir ?? '.cyber'),
    cwd: baseCwd,
    reportFile: config.journal?.reportFile ?? 'CW-REPORT.md',
    maxEvents: config.journal?.maxEvents,
  })
  journal.event('multi-start', {
    agents: entries.map(e => ({ name: e.name, adapter: e.config.agent?.adapter ?? null, cwd: e.agentCwd, plan: e.planPath })),
    budget: budget.snapshot(),
    dryRun: Boolean(config.runtime?.dryRun),
  })

  log?.banner(`多 agent 并行监工：${entries.length} 个对象共享一套预算`)
  for (const entry of entries) {
    log?.raw(`  · ${entry.name.padEnd(12)} ${String(entry.config.agent?.adapter ?? '?').padEnd(12)} ${entry.agentCwd}`)
    log?.raw(`      ${oneLine(entry.planPath, 100)}`)
  }
  log?.raw(`  总预算：${config.guard?.maxRounds ?? '?'} 轮 / ${humanDuration(config.guard?.maxWallClockMs ?? 0)} / 花费上限 ${config.guard?.maxCostUsd ?? '未设置'}`)

  const results = await Promise.all(entries.map(async (entry) => {
    const agentLog = createAgentLogger(log, entry.name)
    try {
      const result = await runOverseer({
        config: entry.config,
        cwd: entry.agentCwd,
        planPath: entry.planPath,
        agentCwd: entry.agentCwd,
        log: agentLog,
        resume,
        deps: { ...deps, budget, agentName: entry.name },
      })
      return {
        ...result, agentName: entry.name, adapter: entry.config.agent?.adapter ?? null,
        cwd: entry.agentCwd, planPath: entry.planPath, ok: true, plan: safePlan(entry.planPath),
      }
    } catch (error) {
      const message = String(error?.message ?? error)
      agentLog?.error(`监工失败：${message}`)
      return {
        agentName: entry.name, adapter: entry.config.agent?.adapter ?? null,
        cwd: entry.agentCwd, planPath: entry.planPath, ok: false,
        stopReason: 'error', exitCode: EXIT_CODES.error, error: message, rounds: 0, costUsd: 0,
        reportPath: null, verdict: null, plan: safePlan(entry.planPath),
      }
    }
  }))

  const allDone = results.every(r => r.stopReason === 'done' || r.stopReason === 'dry-run-complete')
  const exitCode = aggregateExitCode(results)
  const mergedReportPath = writeMergedReport({
    cwd: baseCwd, config, entries, results, budget, startedAt, allDone,
  })
  journal.event('multi-stop', { stopReason: allDone ? 'done' : 'multi-incomplete', exitCode, mergedReportPath, budget: budget.snapshot() })

  const summary = {
    multi: true,
    results,
    mergedReportPath,
    stopReason: allDone ? 'done' : 'multi-incomplete',
    exitCode,
    rounds: budget.rounds,
    costUsd: budget.costUsd,
    budget: budget.snapshot(),
    elapsedMs: Date.now() - startedAt,
  }
  log?.banner('并行监工小结')
  for (const r of results) {
    log?.raw(`  ${r.ok ? '·' : '✖'} ${String(r.agentName).padEnd(12)} ${String(r.stopReason).padEnd(16)} ${String(r.rounds).padStart(3)} 轮  $${Number(r.costUsd ?? 0).toFixed(4)}  ${oneLine(r.verdict?.reason ?? r.error ?? '', 80)}`)
  }
  log?.raw(`  共享预算用掉：${budget.rounds} 轮 / $${budget.costUsd.toFixed(4)}`)
  log?.raw(`  合并报告：${mergedReportPath}`)
  log?.raw('')
  return summary
}

/** 退出码：全部完成才是 0；否则取最严重的那个（便于 CI/脚本判断）。 */
export function aggregateExitCode(results = []) {
  if (!results.length) return 1
  const unfinished = results.filter(r => r.stopReason !== 'done' && r.stopReason !== 'dry-run-complete')
  if (!unfinished.length) return 0
  return Math.max(...unfinished.map(r => r.exitCode ?? EXIT_CODES[r.stopReason] ?? 1))
}

function safePlan(planPath) {
  try {
    const plan = loadPlan(planPath)
    return { path: plan.path, done: plan.doneCount, total: plan.totalCount, remaining: plan.remaining, error: null }
  } catch (error) {
    return { path: planPath, done: 0, total: 0, remaining: [], error: String(error?.message ?? error) }
  }
}

/**
 * 写合并报告（`CW-REPORT.md`）——主人早上第一眼看的就是这份。
 * @param {{cwd:string, config:any, entries:any[], results:any[], budget:any, startedAt:number, allDone:boolean}} args
 * @returns {string} 报告路径
 */
export function writeMergedReport(args) {
  const { cwd, config, results, budget, startedAt, allDone } = args
  const file = isAbsolute(config.journal?.reportFile ?? 'CW-REPORT.md')
    ? config.journal.reportFile
    : resolve(cwd, config.journal?.reportFile ?? 'CW-REPORT.md')
  const lines = []
  lines.push('# 赛博监工报告（多 agent 并行）')
  lines.push('')
  lines.push(`- 生成时间：${isoLocal()}`)
  lines.push(`- 监工时长：${humanDuration(Date.now() - startedAt)}（自 ${isoLocal(startedAt)}）`)
  lines.push(`- 并行对象：${results.length} 个`)
  lines.push(`- 共享预算：已用 ${budget.rounds} 轮 / ${budget.maxRounds || '不限'}，花费 $${budget.costUsd.toFixed(4)} / ${budget.maxCostUsd == null ? '不限' : `$${budget.maxCostUsd}`}`)
  lines.push(`- 结束原因：**${allDone ? '全部完成，收工' : '部分 agent 未完成（见下表）'}**`)
  lines.push('')
  lines.push('## 每个 agent 的结果')
  lines.push('')
  lines.push('| agent | 适配器 | 工作目录 | 方案勾选 | 轮次 | 判定 | 结束原因 | 分项报告 |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const r of results) {
    const planCell = r.plan?.total ? `${r.plan.done}/${r.plan.total}` : '—'
    const report = r.reportPath ? `\`${relativeish(cwd, r.reportPath)}\`` : '—'
    lines.push(`| ${escapeCell(r.agentName)} | ${escapeCell(r.adapter ?? adapterOf(config, r.agentName))} | ${escapeCell(relativeish(cwd, r.cwd))} | ${planCell} | ${r.rounds ?? 0} | ${r.verdict?.status ?? (r.ok ? '?' : 'error')} | ${escapeCell(r.stopReason ?? '?')} | ${report} |`)
  }
  lines.push('')

  const withError = results.filter(r => !r.ok || r.error)
  if (withError.length) {
    lines.push('## 出错的 agent')
    lines.push('')
    for (const r of withError) lines.push(`- **${r.agentName}**：${oneLine(r.error ?? r.stopReason, 300)}`)
    lines.push('')
  }

  lines.push('## 预算用在哪')
  lines.push('')
  for (const [name, rounds] of Object.entries(budget.roundsByAgent ?? {})) {
    const cost = budget.costByAgent?.[name] ?? 0
    lines.push(`- ${name}：${rounds} 轮，$${Number(cost).toFixed(4)}`)
  }
  lines.push('')

  const open = results.filter(r => r.plan?.remaining?.length)
  if (open.length) {
    lines.push('## 还没做完的事')
    lines.push('')
    for (const r of open) {
      lines.push(`### ${r.agentName}（${r.plan.remaining.length} 项）`)
      for (const item of r.plan.remaining.slice(0, 15)) lines.push(`- [ ] ${item}`)
      lines.push('')
    }
  }

  lines.push('## 我该怎么接着干')
  lines.push('')
  if (allDone) {
    lines.push('- 逐个 `git diff` 核对各子项目的改动，确认结果符合预期后再合并。')
    lines.push('- 想再盯一轮：`cw run`（会并行接着跑）。')
  } else {
    lines.push('- 看上面的分项报告，先处理"未完成/出错"的那个 agent。')
    lines.push('- 预算不够就调大 `guard.maxRounds` / `guard.maxCostUsd`（这是**所有 agent 共享**的总额度）。')
    lines.push('- 只想盯其中一个：把它单独写进 `agents` 数组里跑，或 `cw run --cwd <那个目录>`。')
  }
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('*本报告由赛博监工自动生成（多 agent 并行模式）。各 agent 的完整事件流在 `.cyber/agents/<name>/journal.jsonl`。*')

  const text = lines.join('\n')
  try {
    if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true })
    writeFileSync(file, text, 'utf8')
    return file
  } catch {
    return null
  }
}

function adapterOf(config, name) {
  const entry = (config.agents ?? []).find(a => (a?.name ?? a?.id) === name)
  return String(entry?.adapter ?? entry?.agent?.adapter ?? config.agent?.adapter ?? '?')
}

function relativeish(from, to) {
  if (!to) return '—'
  const normalizedFrom = String(from).replace(/[\\/]+$/, '')
  const normalizedTo = String(to)
  return normalizedTo.toLowerCase().startsWith(normalizedFrom.toLowerCase())
    ? normalizedTo.slice(normalizedFrom.length).replace(/^[\\/]/, '')
    : normalizedTo
}

function escapeCell(text) {
  return String(text ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

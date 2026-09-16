/**
 * 命令行入口：`cw`。
 *
 * 命令一览（`cw help`）：
 *   init      生成配置骨架、方案文档模板与 .cyber 目录
 *   doctor    环境自检：Node 能力、各 agent 是否可用、UI 通道、判定器、验收命令
 *   adapters  列出适配器与它们在这台机器上的能力
 *   sessions  列出可监工的会话
 *   windows   列出当前窗口（拟人通道选目标用）
 *   run       开始监工（默认命令）
 *   watch     演练：只判定不抽鞭
 *   judge     只判定一次，打印结论
 *   whip      手动抽一鞭
 *   status    查看监工状态
 *   report    打印/导出报告
 *   pause / resume   喊停 / 继续
 *   hooks     安装 agent 钩子（Cursor）
 *   hook      钩子回调入口（由 agent 调用，读 stdin JSON）
 *   mcp       启动 MCP 信箱服务端
 *
 * @module cyber-overseer/cli
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defaultConfig, loadConfig } from './config.mjs'
import { loadPlan, planProgress, planSummary } from './plan.mjs'
import { createJudge } from './judge/index.mjs'
import { collectEvidence } from './engine/evidence.mjs'
import { runOverseer, checkGuards, EXIT_CODES } from './engine/loop.mjs'
import { StateStore, statePath } from './engine/state.mjs'
import { composeWhip } from './engine/whip.mjs'
import { createLogger } from './util/log.mjs'
import { humanDuration, isoLocal } from './util/time.mjs'
import { clip, oneLine } from './util/text.mjs'
import { ADAPTER_CATALOG, createAdapter, loadAdapters } from './adapters/index.mjs'
import { hasZstd } from './util/zstd-frames.mjs'
import { loadSqlite } from './util/sqlite.mjs'
import { uiSupportLabel } from './util/platform.mjs'

/** 解析 argv（零依赖，够用就好）。 */
export function parseArgv(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--') { positional.push(...argv.slice(i + 1)); break }
    if (token.startsWith('--')) {
      const [key, inline] = token.slice(2).split('=')
      if (inline !== undefined) { flags[key] = inline; continue }
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('-')) { flags[key] = next; i++ } else { flags[key] = true }
      continue
    }
    if (token.startsWith('-') && token.length > 1) {
      const short = token.slice(1)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('-')) { flags[short] = next; i++ } else { flags[short] = true }
      continue
    }
    positional.push(token)
  }
  return { flags, positional }
}

/**
 * 主入口。
 * @param {string[]} argv 不含 node 与脚本名
 * @returns {Promise<number>} 退出码
 */
export async function main(argv = process.argv.slice(2)) {
  const { flags, positional } = parseArgv(argv)
  const command = positional[0] ?? (flags.help || flags.h ? 'help' : 'run')
  const log = createLogger({
    level: flags.quiet ? 'error' : (flags.verbose ? 'debug' : (flags['log-level'] ?? 'info')),
  })

  if (flags.version || flags.V) { log.raw(await version()); return 0 }

  const cwd = resolve(String(flags.cwd ?? process.cwd()))
  const overrides = buildOverrides(flags)
  const { config, planPath, agentCwd, warnings, path: configPath } = await loadConfig({
    configPath: typeof flags.config === 'string' ? flags.config : null,
    cwd,
    log,
    overrides,
  })
  for (const warning of warnings) log.warn(warning)

  if (overrides.runtime?.dryRun) log.warn('演练模式：只判定不抽鞭')

  // 「一句话起步」：第一个词不是命令时，把整句当作目标 —— `cw "把登录页改成深色主题并跑通测试"`
  const COMMANDS = new Set([
    'help', 'version', 'init', 'doctor', 'adapters', 'sessions', 'windows', 'judge', 'whip',
    'status', 'report', 'pause', 'resume', 'hooks', 'hook', 'mcp', 'ui', 'web', 'run', 'watch', 'do', 'poke', 'toast',
    'dsh-profile',
  ])
  if (!COMMANDS.has(command)) {
    return cmdQuick({ log, cwd, sentence: positional.join(' '), flags })
  }

  switch (command) {
    case 'help': printHelp(log); return 0
    case 'version': log.raw(await version()); return 0
    case 'init': return cmdInit({ log, cwd, configPath })
    case 'doctor': return cmdDoctor({ log, config, cwd, planPath, agentCwd })
    case 'adapters': return cmdAdapters({ log, config, cwd, agentCwd })
    case 'sessions': return cmdSessions({ log, config, cwd, agentCwd, flags })
    case 'windows': return cmdWindows({ log, config, agentCwd })
    case 'judge': return cmdJudge({ log, config, cwd, planPath, agentCwd, flags })
    case 'poke': return cmdPoke({ log, cwd, flags })
    case 'do': return cmdQuick({ log, cwd, sentence: positional.slice(1).join(' '), flags })
    case 'whip': return cmdWhip({ log, config, cwd, planPath, agentCwd, positional, flags })
    case 'status': return cmdStatus({ log, config, cwd, flags })
    case 'report': return cmdReport({ log, config, cwd })
    case 'pause': return cmdPause({ log, config, cwd, resume: false })
    case 'resume': return cmdPause({ log, config, cwd, resume: true })
    case 'hooks': return cmdHooks({ log, cwd, flags, positional })
    case 'hook': return cmdHook({ log, cwd, flags, positional })
    case 'mcp': return cmdMcp({ log, config, cwd, flags })
    case 'toast': return cmdToast({ log, flags })
    case 'dsh-profile': return cmdDshProfile({ log, flags })
    case 'ui':
    case 'web': return cmdUi({ log, cwd, flags })
    case 'run':
    case 'watch': {
      if (command === 'watch') config.runtime.dryRun = true
      // 配了 agents[] 就并行盯多个（共享一套预算、报告合并）
      const { isMultiAgent, runMultiAgent } = await import('./engine/multi.mjs')
      if (isMultiAgent(config)) {
        const result = await runMultiAgent({
          config, cwd, log,
          resume: flags.fresh !== true,
          deps: {},
        })
        return result.exitCode ?? 0
      }
      const result = await runOverseer({
        config,
        cwd,
        planPath,
        agentCwd,
        log,
        resume: flags.fresh !== true,
        once: false,
        deps: {},
      })
      return result.exitCode ?? EXIT_CODES[result.stopReason] ?? 0
    }
    default:
      log.error(`未知命令：${command}`)
      printHelp(log)
      return 2
  }
}

function buildOverrides(flags) {
  const overrides = {}
  if (flags.adapter) overrides.agent = { ...(overrides.agent ?? {}), adapter: String(flags.adapter) }
  if (flags.agent) overrides.agent = { ...(overrides.agent ?? {}), adapter: String(flags.agent) }
  if (flags.session) overrides.agent = { ...(overrides.agent ?? {}), session: String(flags.session) }
  if (flags.plan) overrides.plan = String(flags.plan)
  // 下面几个是给"界面/脚本以项目目录为工作目录启动监工"用的：显式钉住路径，
  // 免得项目配置里写的相对路径（往往是相对仓库根）被拼重。
  if (flags.report) overrides.journal = { ...(overrides.journal ?? {}), reportFile: String(flags.report) }
  if (flags['journal-dir']) overrides.journal = { ...(overrides.journal ?? {}), dir: String(flags['journal-dir']) }
  if (flags['state-file']) overrides.runtime = { ...(overrides.runtime ?? {}), stateFile: String(flags['state-file']) }
  if (flags.judge) overrides.judge = { ...(overrides.judge ?? {}), kind: String(flags.judge) }
  if (flags.model) overrides.judge = { ...(overrides.judge ?? {}), llm: { ...(overrides.judge?.llm ?? {}), model: String(flags.model) } }
  if (flags['max-rounds']) overrides.guard = { ...(overrides.guard ?? {}), maxRounds: Number(flags['max-rounds']) }
  if (flags['dry-run'] || flags.watch) overrides.runtime = { ...(overrides.runtime ?? {}), dryRun: true }
  if (flags['auto-approve']) overrides.guard = { ...(overrides.guard ?? {}), autoApprove: true }
  if (flags['no-quiet-hours']) overrides.guard = { ...(overrides.guard ?? {}), quietHours: null, workWindow: null }
  if (flags['log-level']) overrides.runtime = { ...(overrides.runtime ?? {}), logLevel: String(flags['log-level']) }
  return overrides
}

async function version() {
  const { readFileSync: read } = await import('node:fs')
  const { dirname, join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  try {
    const pkg = JSON.parse(read(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'))
    return `cyber-overseer ${pkg.version}`
  } catch { return 'cyber-overseer 0.1.0' }
}

function printHelp(log) {
  log.raw(`
赛博监工 (cyber-overseer) — 在主人休息时，用赛博鞭子抽打赛博劳工

用法：cw <命令> [选项]

  cw poke             催工：agent 一停下（或在等你回话）就催它继续 —— 最小用法，不需要方案与配置
  cw "<一句话目标>"     一句话起步：自动选 agent / 猜验收命令 / 生成方案 / 直接开跑
  cw ui               打开本地图形界面（只监听 127.0.0.1）
  cw run              开始监工（判定→抽鞭→再判定，直到方案完成或触发护栏）
  cw watch            演练模式：只判定、只打印要抽的鞭子，不真的注入
  cw judge            只判定一次并打印结论
  cw whip "<文本>"    手动抽一鞭（调试注入通道）
  cw status           当前状态摘要（--watch 实时面板）
  cw report           打印最近一次报告（--save 重新生成）
  cw pause / resume   喊停 / 继续（写 .cyber/PAUSE 哨兵文件）
  cw sessions         列出可监工的会话
  cw adapters         适配器能力矩阵
  cw windows          列出当前窗口（拟人通道选目标窗口用）
  cw doctor           环境自检
  cw init             生成 cw.config.mjs + PLAN.md + .cyber/
  cw hooks install cursor    给 Cursor 装官方 stop 钩子（最干净的闭环）
  cw hook cursor-stop        钩子回调入口（由 Cursor 调用，读 stdin）
  cw mcp --serve            启动 MCP 信箱服务端（给支持 MCP 的 agent 用）
  cw toast                 自检 Windows 原生通知（收工提醒；--script 只看脚本）
  cw dsh-profile           查看/安装 DSH 的 SDK JSON-RPC profile（--install，零 token）

常用选项：
  --adapter <id>      指定适配器：dsh|dsh-jsonrpc|codex|opencode|cursor|acp|human-sim|generic-cli|mcp-mailbox|fake
  --session <id>      指定会话（默认 latest）
  --plan <file>       指定方案文档（默认 PLAN.md）
  --judge <kind>      判定器：chain|rule|llm|human
  --max-rounds <n>    轮次上限
  --dry-run           演练模式
  --cwd <dir>         工作目录
  --config <file>     指定配置文件
  --watch             用于 status：开实时面板（Ctrl+C 退出）
  --interval <秒>     用于 status --watch：刷新间隔，默认 2
  --verbose           详细日志

多 agent 并行监工：在 cw.config.mjs 里写 agents: [...]（每个条目可有自己的
adapter / cwd / plan / session），判定与抽鞭各自独立，报告合并、预算共享。

退出码：0=完成  10=轮次上限  11=时长上限  12=花费上限  13=无进展  14=受阻
        15=需要人类  16=被喊停  17=找不到会话  1=出错
`)
}

/** cw init */
function cmdInit({ log, cwd, configPath }) {
  const configFile = configPath ?? resolve(cwd, 'cw.config.mjs')
  let created = []
  if (!existsSync(configFile)) {
    writeFileSync(configFile, `/**
 * 赛博监工配置。所有项都可省略——省略即用默认值（默认偏保守）。
 * 完整字段见：node_modules/cyber-overseer/src/config.mjs 的 defaultConfig()
 */
export default {
  // 方案文档：监工判定"完成了没有"的唯一依据
  plan: 'PLAN.md',

  // 被监工的 agent
  agent: {
    adapter: 'dsh',          // dsh | dsh-jsonrpc | codex | opencode | cursor | human-sim | generic-cli | mcp-mailbox
    // dsh-jsonrpc：常驻 DSH 的 jrpc profile 进程（注入 + 事件流观测）；先跑 cw dsh-profile --install
    session: 'latest',
    options: {
      // ---- DSH ----
      // whip: 'headless',     // headless（一次性新会话，推荐）| http | human-sim | custom
      // ---- 拟人通道（任何 GUI：Windows / macOS / Linux 都有驱动）----
      // windowMatch: { process: 'Cursor' },
      // composer: { relX: 0.5, relY: 0.94 },
      // readerClickPoints: [{ relX: 0.5, relY: 0.35 }],   // 焦点在输入框里时挨个点这些位置再读
      // 先跑 cw doctor / cw windows 看本平台结论（mac 要辅助功能权限，linux 要 xdotool）
      // ---- 通用 CLI ----
      // command: ['my-agent', '--resume', '{session}', '{text}'],
    },
  },

  // 多 agent 并行监工（可选）：每个条目独立判定/抽鞭，报告合并，预算共享。
  // agents: [
  //   { name: 'front', adapter: 'cursor', cwd: 'apps/web', plan: 'PLAN-web.md' },
  //   { name: 'back',  adapter: 'codex',  cwd: 'apps/api', plan: 'PLAN-api.md' },
  // ],

  // 判定器：chain = 规则优先，判不了才花钱问模型
  judge: {
    kind: 'chain',
    llm: {
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
    },
  },

  // 证据：没有证据的"我完成了"一律不认
  evidence: {
    git: true,
    verify: [],              // 例：['npm test', 'npm run build']
  },

  // 护栏：无人值守的底线
  guard: {
    maxRounds: 24,
    maxWallClockMs: 10 * 60 * 60 * 1000,
    maxStallRounds: 3,
    quietHours: { from: '23:00', to: '08:00' },  // 主人的休息时间；null = 不限
    requireHumanIdleMs: 120000,                  // 拟人通道：键鼠空闲 2 分钟才动手
  },

  whip: {
    style: 'strict',         // strict | neutral | gentle
    requireReceipt: true,    // 要求 agent 在回答末尾留 CW-RECEIPT
  },
}
`, 'utf8')
    created.push(configFile)
  } else {
    log.info(`配置已存在，跳过：${configFile}`)
  }

  const planFile = resolve(cwd, 'PLAN.md')
  if (!existsSync(planFile)) {
    writeFileSync(planFile, `# 在这里写一句目标

## 目标
用一两段话说清楚"做完是什么样"。监工只认这份文档。

## 验收标准
- 写下**可以被命令验证**的标准，例如：\`npm test\` 全绿、\`curl localhost:3000/health\` 返回 200
- 写不出可验证的标准时，监工会在关键节点喊人（这是设计，不是缺陷）

## 任务清单
- [ ] 第一件事（小到能在一轮内做完）
- [ ] 第二件事
- [ ] 第三件事

## 禁止 / 范围外
- 不要改数据库 schema
- 不要动 CI 配置
`, 'utf8')
    created.push(planFile)
  }

  const dir = resolve(cwd, '.cyber')
  if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }); created.push(dir) }

  log.ok(`初始化完成，新建 ${created.length} 项：`)
  for (const item of created) log.raw(`  ${item}`)
  log.raw('\n下一步：')
  log.raw('  1. 编辑 PLAN.md，把目标、验收标准、任务清单写清楚')
  log.raw('  2. cw doctor          # 看看这台机器能怎么监工')
  log.raw('  3. cw watch           # 演练一次（不真的抽鞭）')
  log.raw('  4. cw run             # 真抽')
  return 0
}

/** cw doctor */
async function cmdDoctor({ log, config, cwd, planPath, agentCwd }) {
  await loadAdapters()
  const sqlite = await loadSqlite()
  log.banner('环境自检')
  const rows = [
    ['Node', process.version, true],
    ['平台', `${process.platform} ${process.arch}`, true],
    ['zstd（读 DSH 会话必需）', hasZstd() ? '可用' : '不可用 → 升级 Node >= 22.15', hasZstd()],
    ['node:sqlite（读 codex/opencode/cursor 必需）', sqlite ? '可用' : '不可用 → 升级 Node >= 22.5', Boolean(sqlite)],
    ['UI 自动化（拟人通道）', uiSupportLabel(), uiSupportLabel().startsWith('可用')],
    ['方案文档', existsSync(planPath) ? planPath : `缺失：${planPath}`, existsSync(planPath)],
    ['配置文件', config.__configPath ?? '（用默认配置）', true],
  ]
  for (const [name, value, ok] of rows) {
    log.raw(`  ${ok ? '✔' : '✖'} ${name.padEnd(40, ' ')} ${value}`)
  }

  log.raw('')
  log.banner('适配器可用性')
  for (const entry of ADAPTER_CATALOG) {
    let probe
    try {
      const adapter = createAdapter(entry.id, { config, cwd: agentCwd, log })
      probe = await adapter.probe()
    } catch (error) {
      probe = { ok: false, reason: String(error?.message ?? error), hints: [] }
    }
    log.raw(`  ${probe.ok ? '✔' : '·'} ${entry.id.padEnd(12)} ${probe.ok ? (probe.detail ?? '可用') : (probe.reason ?? '不可用')}`)
    for (const hint of probe.hints ?? []) log.raw(`      ↳ ${hint}`)
  }

  if (existsSync(planPath)) {
    const plan = loadPlan(planPath)
    const progress = planProgress(plan)
    log.raw('')
    log.banner('方案文档解析结果')
    log.raw(`  目标：${oneLine(plan.objective ?? '(没写)', 100)}`)
    log.raw(`  验收标准：${plan.acceptance.length} 条｜任务清单：${progress.done}/${progress.total} 已勾选`)
    if (!plan.acceptance.length) log.warn('  方案里没有「验收标准」：判定器只能靠勾选框，容易误判，建议补上')
    if (!progress.total) log.warn('  方案里没有 `- [ ]` 任务清单：规则判定无法逐项核对')
  }

  log.raw('')
  log.banner('OCR 引擎（拟人通道的辅助读取）')
  try {
    const { listOcrProviders } = await import('./ocr/index.mjs')
    for (const provider of await listOcrProviders({ cwd, config, log })) {
      log.raw(`  ${provider.available ? '✔' : '·'} ${provider.id.padEnd(9)} ${provider.label}`)
      log.raw(`      ${provider.detail}｜${provider.cost}`)
    }
    log.raw('  提示：`npm run ocr:install` 一键装 RapidOCR（中文准得多），`npm run bench:ocr` 量准确率')
  } catch (error) {
    log.raw(`  · OCR 探测失败：${error?.message ?? error}`)
  }

  log.raw('')
  const key = process.env[config.judge?.llm?.apiKeyEnv ?? 'DEEPSEEK_API_KEY']
  log.raw(`  ${key ? '✔' : '·'} 判定器：${config.judge?.kind}${config.judge?.kind !== 'rule' ? `（${config.judge?.llm?.apiKeyEnv}=${key ? '已设置' : '未设置，将退化为 rule'}）` : ''}`)
  log.raw(`  ${config.evidence?.verify?.length ? '✔' : '·'} 验收命令：${config.evidence?.verify?.length ? config.evidence.verify.join(' | ') : '未配置（建议加，判定会准很多）'}`)
  return 0
}

/** cw adapters */
async function cmdAdapters({ log, config, cwd, agentCwd }) {
  await loadAdapters()
  log.banner('适配器')
  for (const entry of ADAPTER_CATALOG) {
    log.raw(`\n▌${entry.id} — ${entry.label}`)
    log.raw(`   通道：${entry.channel}`)
    if (entry.note) log.raw(`   备注：${entry.note}`)
    try {
      const adapter = createAdapter(entry.id, { config, cwd: agentCwd, log })
      const probe = await adapter.probe()
      log.raw(`   状态：${probe.ok ? `可用 — ${probe.detail ?? ''}` : `不可用 — ${probe.reason ?? ''}`}`)
      if (probe.ok && typeof adapter.capabilities === 'function') {
        const caps = await adapter.capabilities()
        for (const line of String(caps).split('\n')) log.raw(`     ${line}`)
      }
      for (const hint of probe.hints ?? []) log.raw(`     ↳ ${hint}`)
    } catch (error) {
      log.raw(`   状态：不可用 — ${error?.message ?? error}`)
    }
  }
  return 0
}

/** cw sessions */
async function cmdSessions({ log, config, cwd, agentCwd, flags }) {
  await loadAdapters()
  const adapterId = String(flags.adapter ?? config.agent?.adapter ?? 'dsh')
  const adapter = createAdapter(adapterId, { config, cwd: agentCwd, log })
  const probe = await adapter.probe()
  if (!probe.ok) { log.error(`${adapterId} 不可用：${probe.reason}`); return 1 }
  const sessions = await adapter.listSessions()
  // 默认**全部**列出：以前默认只列 25 个，用户会以为"有些会话看不到"（实测踩到）
  const limit = Number(flags.limit ?? 0)
  const liveOnly = flags.live === true

  // "还活着"的判据：最近 30 分钟内有更新，或者状态本身就是"在跑/等人"
  const now = Date.now()
  const ACTIVE = new Set(['working', 'awaiting-approval', 'awaiting-input'])
  const isLive = (s) => ACTIVE.has(s.status) || (s.updatedAt && now - s.updatedAt < 30 * 60 * 1000)
  const rows = (liveOnly ? sessions.filter(isLive) : sessions).slice(0, limit > 0 ? limit : undefined)
  if (!rows.length) { log.warn(`没有${liveOnly ? '活跃的' : ''}会话`); return 0 }

  const STATUS_LABEL = {
    working: '● 正在跑',
    idle: '○ 空闲（在等人）',
    'awaiting-approval': '▲ 等审批',
    'awaiting-input': '▲ 等你回话',
    error: '✖ 出错停止',
    unknown: '· 未知',
  }
  log.banner(`${adapterId} 的会话（${rows.length}/${sessions.length}${liveOnly ? '，只看活跃' : ''}）`)
  for (const s of rows) {
    const when = s.updatedAt ? relativeTime(now - s.updatedAt) : '?'
    const status = STATUS_LABEL[s.status] ?? `· ${s.status ?? '?'}`
    const live = isLive(s) ? '' : '  （久未活动）'
    log.raw(`  ${status.padEnd(14)} ${when.padStart(8)}  ${String(s.id).slice(0, 40)}`)
    const title = oneLine(s.title ?? '(无标题)', 52)
    log.raw(`      ${title}`)
    if (s.cwd) log.raw(`      ${oneLine(s.cwd, 90)}`)
    const extra = []
    if (typeof s.turnCount === 'number') extra.push(`${s.turnCount} 回合`)
    if (s.raw?.eventCount) extra.push(`${s.raw.eventCount} 事件`)
    if (typeof s.size === 'number' && s.size > 0) extra.push(`${Math.round(s.size / 1024)}KB`)
    if (extra.length) log.raw(`      ${extra.join('｜')}${live ? '' : live}`)
  }
  log.raw('')
  log.raw('想监工其中某个：cw run --session <会话id>；只看活跃的：cw sessions --live')
  return 0
}

/** 人类可读的相对时间。 */
function relativeTime(ms) {
  const minutes = Math.round(ms / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

/** cw windows */
async function cmdWindows({ log, config, agentCwd }) {
  const { createUiDriver, describeWindows } = await import('./ui/index.mjs')
  const driver = createUiDriver({ log })
  if (driver.supported === false) {
    log.error(driver.reason ?? `拟人通道在 ${driver.platform ?? process.platform} 上不可用`)
    return 1
  }
  log.banner(`平台：${driver.platform}｜当前空闲：${Math.round((await driver.idle()) / 1000)}s`)
  for (const line of await describeWindows(driver, 40)) log.raw(`  ${line}`)
  log.raw('\n挑一个填进 agent.options.windowMatch，例如：{ process: "Cursor" } 或 { title: "Codex" }')
  return 0
}

/** cw judge（判定一次） */
async function cmdJudge({ log, config, cwd, planPath, agentCwd, flags }) {
  await loadAdapters()
  const plan = loadPlan(planPath)
  const progress = planProgress(plan)
  const adapter = createAdapter(config.agent?.adapter ?? 'dsh', { config, cwd: agentCwd, log })
  const probe = await adapter.probe()
  if (!probe.ok) { log.error(`适配器不可用：${probe.reason}`); return 1 }
  const session = await adapter.resolveSession(config.agent?.session ?? 'latest')
  if (!session) { log.error('找不到会话'); return 1 }
  const snapshot = await adapter.readState(session)
  const store = StateStore.open(statePath(config, cwd), { adapter: adapter.id, sessionId: session.id })
  const evidence = await collectEvidence({
    config, cwd: agentCwd, plan, answer: snapshot.lastAnswer ?? '',
    previous: store.rounds.length ? { evidence: null, answerHash: store.state.lastAnswerHash } : null,
    history: store.rounds, log,
  })
  const judge = createJudge(config, { log })
  const verdict = await judge.judge({
    plan, progress, answer: snapshot.lastAnswer ?? '', lastUserMessage: snapshot.lastUserMessage ?? null,
    evidence, history: store.rounds, config, round: store.rounds.length + 1, log,
  })
  log.banner('判定结果')
  log.raw(`  状态：${verdict.status}（置信度 ${verdict.confidence.toFixed(2)}，判定器 ${verdict.judge}）`)
  log.raw(`  理由：${verdict.reason}`)
  log.raw(`  会话状态：${snapshot.status}｜最后一次回答 ${snapshot.lastAnswer.length} 字`)
  log.raw(`  验收命令：${evidence.verify.length ? evidence.verify.map(v => `${v.command}=${v.ok ? '通过' : '失败'}`).join('  ') : '（未配置）'}`)
  if (verdict.nextPrompt) {
    log.raw('\n  将要抽的鞭子：')
    log.raw(clip(verdict.nextPrompt, 1200).split('\n').map(l => `    ${l}`).join('\n'))
  }
  if (flags.json) log.raw(JSON.stringify(verdict, null, 2))
  return verdict.status === 'done' ? 0 : verdict.status === 'continue' ? 3 : 4
}

/** cw whip（手动抽一鞭） */
async function cmdWhip({ log, config, cwd, planPath, agentCwd, positional, flags }) {
  await loadAdapters()
  const plan = loadPlan(planPath)
  const adapter = createAdapter(config.agent?.adapter ?? 'dsh', { config, cwd: agentCwd, log })
  const probe = await adapter.probe()
  if (!probe.ok) { log.error(`适配器不可用：${probe.reason}`); return 1 }
  const session = await adapter.resolveSession(config.agent?.session ?? 'latest')
  if (!session) { log.error('找不到会话'); return 1 }
  const text = positional.slice(1).join(' ') || (flags.text ? String(flags.text) : '') || (flags.default
    ? composeWhip({
        verdict: { status: 'continue', reason: '手动抽鞭（未给文本，使用默认鞭子）', nextPrompt: null },
        plan, progress: planProgress(plan), round: 1, config,
      })
    : '')
  if (!text) {
    log.error('没给鞭子内容。用法：cw whip "把 PLAN.md 里的第 2 项做完"')
    return 2
  }
  log.step(`向 ${adapter.label} / ${session.id} 抽鞭（${text.length} 字）…`)
  const result = await adapter.whip(text, session, { config, signal: undefined })
  log.raw(`  模式：${result.mode}｜结果：${result.ok ? '成功' : '失败'}`)
  if (result.detail) log.raw(`  说明：${result.detail}`)
  if (result.answer) log.raw(`  回答（尾部）：\n${clip(result.answer, 800).split('\n').map(l => `    ${l}`).join('\n')}`)
  return result.ok ? 0 : 1
}

/** cw status（--watch 时是实时面板） */
async function cmdStatus({ log, config, cwd, flags = {} }) {
  if (flags.watch === true) {
    const { watchStatus } = await import('./engine/panel.mjs')
    const intervalSec = flags.interval !== undefined ? Math.max(0.25, Number(flags.interval)) : 2
    const controller = new AbortController()
    const onSignal = () => controller.abort()
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
    try {
      log.info(`实时面板：每 ${intervalSec}s 刷新（Ctrl+C 退出）`)
      const result = await watchStatus({
        cwd, config, out: process.stdout, log, intervalMs: intervalSec * 1000, signal: controller.signal,
      })
      if (result.interrupted) log.info('面板已退出（状态没有变，监工该跑还在跑）')
      return 0
    } finally {
      process.removeListener('SIGINT', onSignal)
      process.removeListener('SIGTERM', onSignal)
    }
  }

  const file = statePath(config, cwd)
  const store = StateStore.open(file)
  const summary = store.summary()
  log.banner('监工状态')
  log.raw(`  状态：${summary.status}${summary.stopReason ? `（${summary.stopReason}）` : ''}`)
  log.raw(`  适配器：${summary.adapter}｜会话：${summary.sessionId ?? '?'}`)
  log.raw(`  轮次：${summary.rounds}｜花费：$${summary.costUsd.toFixed(4)}`)
  log.raw(`  开始：${summary.startedAt}｜更新：${summary.updatedAt}`)
  log.raw(`  状态文件：${file}`)
  if (summary.lastVerdict) log.raw(`  最近判定：${summary.lastVerdict.status} — ${oneLine(summary.lastVerdict.reason ?? '', 140)}`)
  const pause = resolve(cwd, config.guard?.pauseFile ?? '.cyber/PAUSE')
  log.raw(`  暂停哨兵：${existsSync(pause) ? '存在（已暂停）' : '不存在'}`)

  // 配了 agents[] 的话，顺手把每个 agent 的状态也列出来（免得多 agent 时看不到全貌）
  const { isMultiAgent } = await import('./engine/multi.mjs')
  if (isMultiAgent(config)) {
    const { panelSources, renderPanel } = await import('./engine/panel.mjs')
    const sources = panelSources({ cwd, config }).filter(s => s.exists)
    if (sources.length) {
      log.raw('')
      log.raw(renderPanel(sources, { color: false, cwd, guard: config.guard, paused: existsSync(pause) }))
    }
  }
  log.raw('\n想看实时刷新：cw status --watch（--interval 1 秒级刷新）')
  return 0
}

/** cw report */
function cmdReport({ log, config, cwd }) {
  const file = resolve(cwd, config.journal?.reportFile ?? 'CW-REPORT.md')
  if (!existsSync(file)) { log.warn(`还没有报告：${file}（跑一次 cw run 就会生成）`); return 1 }
  log.raw(readFileSync(file, 'utf8'))
  return 0
}

/** cw pause / resume */
function cmdPause({ log, config, cwd, resume }) {
  const file = resolve(cwd, config.guard?.pauseFile ?? '.cyber/PAUSE')
  if (resume) {
    if (existsSync(file)) {
      unlinkSync(file)
      log.ok(`已恢复：删除 ${file}`)
    } else log.info('本来就没暂停')
    return 0
  }
  mkdirSync(resolve(file, '..'), { recursive: true })
  writeFileSync(file, `paused at ${isoLocal()}\n`, 'utf8')
  log.ok(`已暂停：写入 ${file}（监工在下一轮护栏检查时会停下）`)
  return 0
}

/** cw hooks install cursor */
async function cmdHooks({ log, cwd, flags, positional }) {
  const target = positional[1] ?? 'cursor'
  const { installCursorHooks } = await import('./hooks.mjs')
  if (target !== 'cursor') { log.error(`暂不支持的钩子目标：${target}（目前支持 cursor）`); return 2 }
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const cliPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cw.mjs')
  const result = installCursorHooks({
    cwd,
    cliPath,
    nodePath: process.execPath,
    force: Boolean(flags.force),
    loopLimit: flags['loop-limit'] ? Number(flags['loop-limit']) : undefined,
    log,
  })
  log.raw(result.message)
  if (result.created) {
    log.raw('\n之后 Cursor 每个回合结束都会回调本监工：读方案 + 读最后一次回答 → 判定 →')
    log.raw('要么返回 followup_message 继续抽，要么什么都不返回让循环停下。')
    log.raw('提醒：Cursor 会热重载 hooks.json，但若没生效请重启 Cursor。')
  }
  return result.ok || result.message.includes('最新') ? 0 : 1
}

/** cw hook <agent>-<event>（钩子回调入口） */
async function cmdHook({ log, cwd, flags, positional }) {
  const name = positional[1] ?? ''
  const match = /^([a-z]+)-(stop|response)$/.exec(name)
  if (!match) { log.error('用法：cw hook cursor-stop（或 cursor-response）'); return 2 }
  const [, agent, event] = match
  const input = await readStdin()
  let payload = {}
  try { payload = input.trim() ? JSON.parse(input) : {} } catch { log.warn('stdin 不是合法 JSON，按空事件处理') }
  if (flags['print-payload']) { log.raw(JSON.stringify(payload, null, 2)); return 0 }

  const { handleHook } = await import('./hooks.mjs')
  try {
    const result = await handleHook({
      agent,
      event,
      payload,
      cwd: resolve(String(flags.cwd ?? payload.cwd ?? cwd)),
      configPath: typeof flags.config === 'string' ? flags.config : null,
      log,
    })
    // 钩子的输出必须是**纯 JSON 到 stdout**，所以日志走 stderr
    process.stdout.write(JSON.stringify(result.output ?? {}) + '\n')
    log.debug?.(result.reason)
    return 0
  } catch (error) {
    log.error(`钩子处理失败：${error?.message ?? error}`)
    // 按 Cursor 的约定：非 0/2 的退出码默认 fail open，不阻塞用户
    process.stdout.write('{}\n')
    return 1
  }
}

/** cw mcp --serve */
async function cmdMcp({ log, config, cwd, flags }) {
  if (!flags.serve) { log.error('用法：cw mcp --serve（stdio 服务端）'); return 2 }
  const { serveMcpMailbox } = await import('./adapters/mcp-mailbox.mjs')
  await serveMcpMailbox({ cwd, log })
  return 0
}

/**
 * cw toast —— 自检 Windows 原生通知通道。
 *
 * 收工/卡住时监工会自己发一条 toast（`notify.toast`，默认 auto = Windows 上开）。
 * 这个命令用来当场验证"这台机器能不能弹出来"，而不是等到早上才发现没收到通知。
 */
async function cmdToast({ log, flags }) {
  const { buildToastScript, sendToast, toastAvailable, DEFAULT_APP_ID } = await import('./util/toast.mjs')
  const title = typeof flags.title === 'string' ? flags.title : '赛博监工 · 通知自检'
  const text = typeof flags.text === 'string'
    ? String(flags.text)
    : '如果你看到这条通知，说明监工的收工提醒是通的。'
  const appId = typeof flags.appid === 'string' ? String(flags.appid) : undefined

  if (flags.script === true) {
    log.raw(buildToastScript({ title, text, appId }))
    return 0
  }
  if (!toastAvailable()) {
    log.error('这台机器没有可用的 toast 通道（需要 Windows + Windows PowerShell 5.1）')
    log.raw(`  平台：${process.platform}｜默认 AppID：${DEFAULT_APP_ID}`)
    return 1
  }
  const result = await sendToast({ title, text, appId, log })
  if (result.ok) {
    log.ok(`已弹出一条 toast：${title}`)
    log.raw('  如果没看到，请检查「设置 → 系统 → 通知」里 PowerShell 的通知是否被关掉/勿扰模式是否开着。')
    return 0
  }
  log.error(`toast 发送失败：${result.detail}`)
  log.raw('  排查：cw toast --script  可以打印将要执行的 PowerShell 脚本（内容用 base64 传递，不会被注入）。')
  return 1
}

/**
 * cw dsh-profile —— 建/查 DSH 的 SDK JSON-RPC profile（`dsh --profile jrpc`）。
 *
 * 这条通道能同时"注入 + 观测"，且完全不碰人类会话；但产品 CLI 的 web/headless profile
 * 都没挂那个插件包，所以要自建一个 profile。本命令只做三件事：写模板文件、建插件软链、
 * 把"还差什么"说清楚——**已经存在的文件一律不覆盖**（除非显式 --force）。
 */
async function cmdDshProfile({ log, flags }) {
  const {
    DEFAULT_PROFILE, SDK_PACKAGE, inspectProfile, installProfile, profileTemplateFiles,
  } = await import('./dsh-profile.mjs')
  const profile = typeof flags.profile === 'string' ? String(flags.profile) : DEFAULT_PROFILE
  const home = typeof flags['dsh-home'] === 'string' ? String(flags['dsh-home']) : undefined

  if (flags.help === true || flags.h === true) {
    log.raw(`
cw dsh-profile —— DSH 的 SDK stdio JSON-RPC profile（注入 + 事件流观测，零侵入）

  cw dsh-profile                     查看当前 profile 是否就绪
  cw dsh-profile --install           写 profile 模板（package.json + cordis.patch.yml + pnpm-workspace.yaml）
  cw dsh-profile --install --sdk-path <deepseek-harness>/packages/sdk/server
                                     顺便把插件包软链到 profiles/node_modules（Windows 用 junction，免管理员）
  cw dsh-profile --print             打印将要写入的内容（不改任何文件）
  cw dsh-profile --force             覆盖已存在的模板文件（默认绝不覆盖）

选项：--profile <name>（默认 jrpc）  --dsh-home <dir>（默认 $DSH_HOME 或 ~/.dsh）
之后：cw run --adapter dsh-jsonrpc   （需要 DEEPSEEK_API_KEY；协议无 resume，session 是新建的）
`)
    return 0
  }

  if (flags.print === true) {
    log.banner(`SDK JSON-RPC profile 模板（${profile}）`)
    for (const entry of profileTemplateFiles(profile)) {
      log.raw(`\n--- ${entry.file} ---`)
      log.raw(entry.content.replace(/\n$/, ''))
    }
    return 0
  }

  if (flags.install === true || flags.force === true) {
    const result = installProfile({
      home,
      profile,
      force: flags.force === true,
      sdkPath: typeof flags['sdk-path'] === 'string' ? String(flags['sdk-path']) : undefined,
      cwd: resolve(String(flags.cwd ?? process.cwd())),
    })
    log.banner(`安装 SDK JSON-RPC profile「${profile}」`)
    log.raw(`  目录：${result.dir}`)
    log.raw(`  新建：${result.created.length ? result.created.join('、') : '（无）'}`)
    if (result.skipped.length) log.raw(`  已存在（未覆盖）：${result.skipped.join('、')}`)
    log.raw(`  插件软链：${result.linked ?? '（未创建）'}`)
    for (const warning of result.warnings) log.warn(warning)
    for (const hint of result.hints) log.raw(`  · ${hint}`)
    if (result.ok) {
      log.ok('profile 就绪')
      log.raw('')
      log.raw('下一步：')
      log.raw(`  1. 在 cw.config.mjs 里：agent: { adapter: 'dsh-jsonrpc', options: { profile: '${profile}', workspace: '<被监工的项目>' } }`)
      log.raw(`  2. 设好 DSH_HOME=${result.home} 与 DEEPSEEK_API_KEY（真实额度由你决定）`)
      log.raw('  3. cw watch   # 演练（只判定、只打印鞭子），确认无误再 cw run')
      log.raw(`  插件包：${SDK_PACKAGE}（stdout 被协议独占：profile 里不要挂 stdout logger）`)
      return 0
    }
    log.warn('还没完全就绪：按上面的 · 提示补齐后再跑一次 cw dsh-profile')
    return 1
  }

  const status = inspectProfile({ home, profile })
  log.banner(`DSH SDK JSON-RPC profile「${profile}」`)
  log.raw(`  DSH_HOME：${status.home}`)
  log.raw(`  目录：${status.dir}`)
  log.raw(`  ${status.files.manifest ? '✔' : '✖'} package.json（bundles 清单）`)
  log.raw(`  ${status.files.patch ? '✔' : '✖'} cordis.patch.yml（用户补丁层）`)
  log.raw(`  ${status.patchMentionsServer ? '✔' : '✖'} patch 里挂了 ${SDK_PACKAGE}`)
  log.raw(`  ${status.resolvable ? '✔' : '✖'} 插件包可解析${status.linkTarget ? `（软链 → ${status.linkTarget}）` : ''}`)
  log.raw(`  软链位置：${status.link}`)
  for (const hint of status.hints) log.raw(`  · ${hint}`)
  if (status.ok) {
    log.ok('profile 就绪：cw run --adapter dsh-jsonrpc')
    return 0
  }
  log.warn(`尚未就绪：cw dsh-profile --install --profile ${profile}`)
  return 1
}

/**
 * cw poke —— 催工模式（本项目最小的形态）。
 *
 * 不读方案文档、不看验收命令、不叫模型：**agent 一停下来（或在等你回话）就催它继续**。
 * 这是"让 agent 持续工作"这件事最直接的实现。
 */
async function cmdPoke({ log, cwd, flags }) {
  const { runPoke, DEFAULT_NUDGE } = await import('./poke.mjs')
  if (flags.help === true || flags.h === true) {
    log.raw(`
cw poke —— 催工：agent 一停下就催它继续（不需要方案文档、不需要配置）

  cw poke                     盯当前目录的 agent 会话，停下就催（最多 30 次）
  cw poke --times 10          最多催 10 次
  cw poke --agent codex       换 agent（默认优先 DSH）
  cw poke --session <id>      盯指定会话
  cw poke --text "继续做完"    自定义催促语
  cw poke --dry-run           只观察与判定，不真的发
  cw poke --every 10          催促后等待新回答的轮询间隔（秒）

停止条件：它自己写 CW:DONE ／ 连着两轮回答没变化 ／ 催够次数 ／ Ctrl+C ／ .cyber/PAUSE
`)
    return 0
  }
  const controller = new AbortController()
  const onSignal = () => controller.abort()
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    const result = await runPoke({
      cwd,
      log,
      agentId: typeof flags.agent === 'string' ? flags.agent : (typeof flags.adapter === 'string' ? flags.adapter : undefined),
      session: typeof flags.session === 'string' ? flags.session : undefined,
      maxNudges: flags.times !== undefined ? Number(flags.times) : undefined,
      everyMs: flags.every !== undefined ? Number(flags.every) * 1000 : undefined,
      nudge: typeof flags.text === 'string' ? flags.text : DEFAULT_NUDGE,
      signal: controller.signal,
    })
    return result.stopReason === 'interrupted' ? 130 : 0
  } finally {
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
  }
}

/**
 * 一句话起步：`cw "把登录页改成深色主题并跑通测试"`。
 *
 * 不要求用户写配置、写方案、配验收命令——这些都自动决定并**打印出来**，
 * 不满意可以用 `--plan-only` 只生成不跑，或者直接去改 `.cyber/PLAN.md`（监工每轮重读）。
 */
async function cmdQuick({ log, cwd, sentence, flags }) {
  const { prepareQuickRun, describeQuickRun } = await import('./quick.mjs')
  if (!sentence || !sentence.trim()) {
    log.error('用法：cw "<一句话目标>"   例如：cw "把登录页改成深色主题并跑通测试"')
    log.raw('可选：--agent dsh|codex|opencode|cursor  --session <id>  --max-rounds 8  --no-join  --plan-only')
    return 2
  }

  const prepared = await prepareQuickRun({
    sentence,
    cwd,
    log,
    preferAgent: typeof flags.agent === 'string' ? flags.agent : (typeof flags.adapter === 'string' ? flags.adapter : undefined),
    session: typeof flags.session === 'string' ? flags.session : undefined,
    maxRounds: flags['max-rounds'],
    joinWeb: flags['no-join'] !== true,
    verify: typeof flags.verify === 'string' ? String(flags.verify).split(';').map(s => s.trim()).filter(Boolean) : undefined,
    quietHours: flags['quiet-hours'] === false ? null : undefined,
    command: typeof flags.cmd === 'string' ? String(flags.cmd).split(' ').filter(Boolean) : undefined,
  })

  log.banner('一句话起步 · 我决定这么干')
  for (const line of describeQuickRun(prepared)) log.raw(`  ${line}`)
  log.raw(`  护栏：最多抽 ${prepared.config.guard.maxRounds} 鞭，连续 ${prepared.config.guard.maxStallRounds} 轮无进展就停`)
  log.raw(`  想改配置：${prepared.configFile}`)

  if (flags['plan-only'] === true || flags['dry-run'] === true) {
    log.raw('')
    log.ok(`只生成不运行（--plan-only）。方案已写好：${prepared.planPath}`)
    log.raw(`下一步：cw run --config "${prepared.configFile}"`)
    return 0
  }

  const result = await runOverseer({
    config: prepared.config,
    cwd,
    planPath: prepared.planPath,
    agentCwd: cwd,
    log,
    resume: flags.fresh !== true,
  })
  return result.exitCode ?? EXIT_CODES[result.stopReason] ?? 0
}
/**
 * cw ui —— 本地 Web 界面（零依赖，只监听 127.0.0.1）。
 *
 * 界面做的事：选项目 → 写方案 → 选 agent 与验收命令 → 点开始 → 看实时判定/鞭子/报告。
 * 监工进程由界面服务作为子进程启动，所以刷新或关掉页面都不影响正在跑的监工。
 */
async function cmdUi({ log, cwd, flags }) {
  const { startWebUi, DEFAULT_PORT } = await import('./web/server.mjs')
  const port = Number(flags.port ?? DEFAULT_PORT)
  const host = String(flags.host ?? '127.0.0.1')
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    log.warn(`界面只能监听本机地址（请求的是 ${host}）。这是刻意的安全边界：界面能启动监工、改写方案文档。`)
    return 2
  }
  const ui = await startWebUi({
    cwd,
    port,
    host,
    log,
    open: flags['no-open'] !== true,
    token: typeof flags.token === 'string' ? flags.token : null,
  })
  log.raw('')
  log.raw(`  界面地址：${ui.url}`)
  log.raw(`  项目目录：${cwd}（也可以在页面里换）`)
  log.raw('  按 Ctrl+C 退出界面（正在跑的监工不会被杀，可在页面上点「停止」）')
  log.raw('')
  // 保持进程存活直到中断
  await new Promise((resolveHold) => {
    const stop = () => { ui.close().then(resolveHold).catch(resolveHold) }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
  return 0
}

async function readStdin() {
  if (process.stdin.isTTY) return ''
  let data = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) data += chunk
  return data
}

export { checkGuards, humanDuration, defaultConfig }

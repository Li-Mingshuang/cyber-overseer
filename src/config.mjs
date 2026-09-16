/**
 * 配置：默认值、加载、校验、归一化。
 *
 * 监工是"无人值守"的工具，所以配置的第一原则是**默认安全**：
 * 默认只在一个回合结束后才动手、默认有轮次上限、默认有静默期、默认不自动批准危险操作。
 * 想要更激进的行为必须显式写出来。
 *
 * @module cyber-overseer/config
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { isAbsolute, resolve } from 'node:path'
import { createLogger } from './util/log.mjs'
import { ADAPTER_IDS } from './adapters/index.mjs'

/** 用户配置的默认值。任何一项都可以在 cw.config.mjs 里覆盖。 */
export function defaultConfig() {
  return {
    /** 方案文档：监工判断"目标完成了没有"的唯一依据。 */
    plan: 'PLAN.md',

    /** 被监工的 agent。 */
    agent: {
      /** 适配器 id：dsh | codex | opencode | cursor | acp | human-sim | generic-cli | mcp-mailbox | fake */
      adapter: 'dsh',
      /** agent 的工作目录（默认=监工自己所在目录）。 */
      cwd: null,
      /** 会话选择：'latest'（默认）| 'new' | 具体 session id | {match:{cwd,title}}。 */
      session: 'latest',
      /** 交给适配器的额外参数（每种适配器自定义）。 */
      options: {},
    },

    /**
     * 多 agent 并行监工（可选）。
     *
     * 真实项目里常常同时开着 Cursor 写前端、codex 改后端。把每个要盯的对象写成一个条目，
     * 监工就并行地盯着它们：判定/抽鞭各自独立，报告合并成一份，轮次/时长/花费**共享**一套预算。
     *
     * 条目形如：
     * ```js
     * agents: [
     *   { name: 'frontend', adapter: 'cursor', cwd: 'apps/web', plan: 'PLAN-web.md' },
     *   { name: 'backend',  adapter: 'codex',  cwd: 'apps/api', plan: 'PLAN-api.md', session: 'latest' },
     * ]
     * ```
     * 条目可覆盖上面 agent 之外的任何配置（judge / evidence / whip / guard …）；
     * 为空的条目 = 直接用顶层配置。判重名会自动加后缀。
     */
    agents: [],

    /** 判定器：读方案文档 + 最后一次回答 → 收工 / 继续 / 卡住。 */
    judge: {
      /** rule（零成本确定性）| llm（模型判定）| human（人工确认）| chain（规则优先，无法判定时升级到 LLM）。 */
      kind: 'chain',
      /** rule 判定的策略细节。 */
      rule: {
        /** 方案文档剩下未勾选项时是否允许判定完成。 */
        requireTodosChecked: true,
        /** 有验收命令时，命令必须全绿才允许收工。 */
        requireVerifyPass: true,
        /** 允许 agent 用 <!-- CW:DONE --> 显式宣告完成（默认：必须有证据才认，见 trustAgentDone）。 */
        trustAgentDone: false,
        /** 连续多少轮回答完全一致且无新证据 → 判定为卡住。 */
        stallRounds: 3,
      },
      /** LLM 判定器（OpenAI 兼容）。 */
      llm: {
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        /** 判定用温度：越低越稳定。 */
        temperature: 0,
        maxTokens: 2000,
        timeoutMs: 180000,
        /** 额外请求头。 */
        headers: {},
        /** 便宜的降级模型（第一次解析失败时重试用）。 */
        fallbackModel: null,
      },
      /** 人工判定：把结论交给人（通过终端提问或生成待办文件）。 */
      human: {
        /** interactive（终端问答）| file（写 .cyber/HUMAN-DECISION.md 后等待文件被填） */
        mode: 'interactive',
        pollMs: 15000,
      },
    },

    /** 证据采集：让判定基于事实而不是 agent 的自述。 */
    evidence: {
      /** 收集 git diff --stat（有 git 仓库时）。 */
      git: true,
      /** 验收命令；全部通过才算"证据充分"。 */
      verify: [],
      /** 单条验收命令超时。 */
      verifyTimeoutMs: 900000,
      /** 是否把验收命令的输出给判定器。 */
      includeVerifyOutput: true,
      /** 每轮都重跑验收命令（false=只在方案勾选有变化时跑，省时间）。 */
      verifyEveryRound: false,
      /**
       * 方案文档防篡改：把**第一轮**看到的"合同"（验收标准 + 禁止事项 + 任务清单文本）当基线，
       * 之后任何**移除**（含改写）都会被判定为"改弱了"→ 规则判定拒绝收工并喊人。
       *
       * 为什么默认开：方案文档是 agent 自己也能改的文件，而"把验收标准改简单"是它做得到的作弊。
       */
      planGuard: true,
      /** 明确接受"agent 可以改弱合同"（危险；默认 false）。 */
      allowPlanWeakening: false,
    },

    /** 安全护栏。默认偏保守——监工是拿来睡觉时用的，出错的代价由主人承担。 */
    guard: {
      /** 最多抽多少鞭（含第一轮判定之后的每次注入）。 */
      maxRounds: 24,
      /** 总时长上限（毫秒），到点收工并写报告。 */
      maxWallClockMs: 10 * 60 * 60 * 1000,
      /** 连续 N 轮没有任何进展（回答+文件都无变化）就停下喊人。 */
      maxStallRounds: 3,
      /** 承认失败/卡住的判定出现 N 次就停下。 */
      maxBlockedRounds: 2,
      /** 每次抽鞭后等待 agent 开始工作的最长时长。 */
      waitForAgentStartMs: 10 * 60 * 1000,
      /** 每次抽鞭后等待 agent 结束本回合的最长时长。 */
      waitForAgentIdleMs: 3 * 60 * 60 * 1000,
      /** 两次抽鞭之间的最小间隔（防止把 agent 打爆/烧钱）。 */
      cooldownMs: 5000,
      /** 只在这个时段内动手（"主人休息时"）。null=不限。跨零点写法：{from:'23:00',to:'08:00'}。 */
      quietHours: null,
      /** 只在这个时段内动手（与 quietHours 互斥，用于"只在工作时间）"。 */
      workWindow: null,
      /** 拟人通道专用：系统键鼠空闲达到该毫秒数才允许抢焦点打字。0=不检查（危险）。 */
      requireHumanIdleMs: 120000,
      /** 拟人通道专用：打字前把当前前台窗口记下来，打完还回去。 */
      restoreFocus: true,
      /** 出现"需要人类批准"时是否自动放行（默认否；交给 agent 自己的审批策略）。 */
      autoApprove: false,
      /** 预算：判定器累计花费上限（美元，按适配器给出的估算，未知则不判）。 */
      maxCostUsd: null,
      /** 暂停哨兵文件（存在即暂停）。 */
      pauseFile: '.cyber/PAUSE',
    },

    /** 鞭子的内容。 */
    whip: {
      /** 风格：strict（严厉督工）| neutral（客观派活）| gentle（温和提醒）。 */
      style: 'strict',
      /** 注入文本最大长度（拟人通道会因过长而失败，需截断）。 */
      maxChars: 1800,
      /** 是否把方案剩余项、验收状态、上一轮判定理由拼进鞭子。 */
      includeContext: true,
      /** 完全自定义模板（覆盖 style）。可用变量：{{plan}} {{remaining}} {{reason}} {{round}} {{evidence}} {{next}} */
      template: null,
      /** 每次注入前的固定前缀（用于让 agent 知道这不是人类在说话）。 */
      prefix: '[赛博监工]',
      /** 是否要求 agent 在回答末尾回执（便于判定器判断"这轮做了什么"）。 */
      requireReceipt: true,
    },

    /** 日志/状态目录。 */
    journal: {
      dir: '.cyber',
      /** 同时把人类可读报告写到项目根。 */
      reportFile: 'CW-REPORT.md',
      /** 保留的历史事件条数上限（防止日志无限膨胀）。 */
      maxEvents: 5000,
      /** 是否把完整回答也存进日志（默认只存摘要+哈希）。 */
      storeAnswers: false,
    },

    /** 通知（可选）。 */
    notify: {
      /** POST JSON 到该地址（Server 酱/飞书/钉钉/Slack webhook 都能接）。 */
      webhook: null,
      /** 终端响铃。 */
      beep: true,
      /**
       * Windows 原生 toast：true | false | 'auto'（默认，Windows 上开、其它平台关）| { title, appId, duration }。
       * 只在收工/出错时弹一次（与 onlyOnEnd 无关，因为通知本身只在收尾时发）。
       */
      toast: 'auto',
      /** toast 的 AppUserModelID；企业环境里可能需要换成自己注册的 AUMID。 */
      toastAppId: null,
      /** 只在收工/出错时通知。 */
      onlyOnEnd: true,
    },

    /** 杂项。 */
    runtime: {
      logLevel: 'info',
      /** 不真的抽鞭，只打印将要注入的内容（演练模式）。 */
      dryRun: false,
      /** 一旦判定完成是否自动退出（false=留在原地等下一次监工）。 */
      exitOnDone: true,
      /** 状态文件（断点续跑）。 */
      stateFile: '.cyber/state.json',
    },
  }
}

/** 深合并（数组整体替换，不合并）。 */
export function mergeConfig(base, override) {
  if (override === undefined || override === null) return base
  if (Array.isArray(override)) return override
  if (typeof override !== 'object') return override
  const out = Array.isArray(base) ? [...base] : { ...base }
  for (const [key, value] of Object.entries(override)) {
    out[key] = key in out ? mergeConfig(out[key], value) : value
  }
  return out
}

/** 便捷写法：拿到类型提示的同时保持零依赖。 */
export function defineConfig(config) {
  return config
}

/**
 * 载入 `.env` 文件里的密钥（让"配 API"变成"在界面或文件里填一次"）。
 *
 * 查找顺序（都**不覆盖**已存在的环境变量，与 dotenv 行为一致；先找到的优先）：
 *   1. `<项目>/.cyber/.env`（界面里填的密钥存这里；`.cyber/` 默认 gitignore）
 *   2. `<项目>/.env`
 *   3. `~/.cyber-overseer/.env`（用户级：放一次，所有项目都能用）
 *
 * @param {string} cwd
 * @returns {{loaded:string[], files:string[]}}
 */
export function loadEnvFiles(cwd) {
  const files = [
    resolve(cwd, '.cyber', '.env'),
    resolve(cwd, '.env'),
    resolve(homedir(), '.cyber-overseer', '.env'),
  ]
  const loaded = []
  const used = []
  for (const file of files) {
    if (!existsSync(file)) continue
    let text = ''
    try { text = readFileSync(file, 'utf8') } catch { continue }
    used.push(file)
    for (const line of text.split('\n')) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
      if (!match) continue
      const key = match[1]
      let value = match[2]
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      if (process.env[key] === undefined) { process.env[key] = value; loaded.push(key) }
    }
  }
  return { loaded, files: used }
}

/**
 * 加载配置。
 * @param {{configPath?:string|null, cwd?:string, overrides?:Record<string,any>, log?:any}} [opts]
 * @returns {Promise<{config:ReturnType<typeof defaultConfig>, path:string|null, dir:string, warnings:string[]}>}
 */
export async function loadConfig(opts = {}) {
  const cwd = opts.cwd ?? process.cwd()
  const log = opts.log ?? createLogger({ level: 'warn' })
  const warnings = []
  let userConfig = {}
  let configPath = null

  const candidates = opts.configPath
    ? [opts.configPath]
    : ['cw.config.mjs', 'cw.config.js', 'cw.config.json', '.cyber/config.mjs']

  for (const candidate of candidates) {
    const full = isAbsolute(candidate) ? candidate : resolve(cwd, candidate)
    if (!existsSync(full)) continue
    configPath = full
    if (full.endsWith('.json')) {
      const { readFileSync } = await import('node:fs')
      userConfig = JSON.parse(readFileSync(full, 'utf8'))
    } else {
      const mod = await import(pathToFileURL(full).href + `?t=${Date.now()}`)
      userConfig = mod.default ?? mod.config ?? {}
    }
    break
  }
  if (opts.configPath && !configPath) warnings.push(`指定的配置文件不存在：${opts.configPath}`)

  let config = mergeConfig(defaultConfig(), userConfig)
  if (opts.overrides) config = mergeConfig(config, opts.overrides)

  // 先载入 .env，再校验（校验需要看得到 API Key）
  const env = loadEnvFiles(cwd)
  if (env.loaded.length) log.debug?.(`已从 ${env.files.join('、')} 载入：${env.loaded.join(', ')}`)

  // 归一化与校验
  const problems = validateConfig(config, { cwd })
  warnings.push(...problems)

  config.__cwd = cwd
  config.__configPath = configPath
  config.__log = log
  config.__env = env
  const dir = isAbsolute(config.journal.dir) ? config.journal.dir : resolve(cwd, config.journal.dir)
  const planPath = isAbsolute(config.plan) ? config.plan : resolve(cwd, config.plan)
  const agentCwd = config.agent.cwd
    ? (isAbsolute(config.agent.cwd) ? config.agent.cwd : resolve(cwd, config.agent.cwd))
    : cwd
  return {
    config,
    path: configPath,
    dir,
    planPath,
    agentCwd,
    warnings,
  }
}

/**
 * 校验并就地修正明显危险的配置。
 * @param {ReturnType<typeof defaultConfig>} config
 * @param {{cwd:string}} ctx
 * @returns {string[]} 警告列表
 */
export function validateConfig(config, ctx = { cwd: process.cwd() }) {
  const warnings = []
  const guard = config.guard ?? {}

  if (!Number.isFinite(guard.maxRounds) || guard.maxRounds <= 0) {
    warnings.push('guard.maxRounds 非法，已回退为 24')
    guard.maxRounds = 24
  } else if (guard.maxRounds > 500) {
    warnings.push(`guard.maxRounds=${guard.maxRounds} 偏大，请确认你清楚代价`)
  }

  if (guard.requireHumanIdleMs === 0 && config.agent?.adapter === 'human-sim') {
    warnings.push('human-sim 适配器把 requireHumanIdleMs 设为 0：监工会在主人正在用电脑时抢焦点打字，极易误输入')
  }
  if (guard.autoApprove) {
    warnings.push('guard.autoApprove=true：agent 的审批请求会被自动放行，风险自负')
  }
  if (config.runtime?.dryRun) warnings.push('runtime.dryRun=true：只演练不注入')

  const validWindow = (w, name) => {
    if (!w) return
    if (!/^\d{1,2}:\d{2}$/.test(String(w.from ?? '')) || !/^\d{1,2}:\d{2}$/.test(String(w.to ?? ''))) {
      warnings.push(`${name} 格式应为 {from:'23:00',to:'08:00'}，当前值被忽略`)
      return false
    }
    return true
  }
  if (validWindow(guard.quietHours, 'guard.quietHours') === false) guard.quietHours = null
  if (validWindow(guard.workWindow, 'guard.workWindow') === false) guard.workWindow = null
  if (guard.quietHours && guard.workWindow) {
    warnings.push('guard.quietHours 与 guard.workWindow 同时配置，quietHours 生效')
    guard.workWindow = null
  }

  if (!['rule', 'llm', 'human', 'chain'].includes(config.judge?.kind)) {
    warnings.push(`judge.kind=${config.judge?.kind} 未知，回退为 chain`)
    config.judge.kind = 'chain'
  }

  const llm = config.judge?.llm ?? {}
  if (config.judge?.kind !== 'rule') {
    const key = process.env[llm.apiKeyEnv ?? 'DEEPSEEK_API_KEY']
    if (!key && (config.judge?.kind === 'llm' || config.judge?.kind === 'chain')) {
      warnings.push(
        `环境变量 ${llm.apiKeyEnv} 未设置：LLM 判定不可用，chain 会自动退化为 rule`
        + `（配置方法：在项目里建 .env 写一行 ${llm.apiKeyEnv}=你的key，或设系统环境变量；`
        + '不需要 API 的纯规则判定可设 judge.kind="rule"）',
      )
    }
  }
  if (!config.evidence?.verify?.length) {
    warnings.push('evidence.verify 为空：判定器拿不到"测试是否通过"这类硬证据，收工判断会变弱')
  }
  validateAgents(config, warnings)
  return warnings
}

/**
 * 校验多 agent 并行监工的条目（就地修正明显写错的地方）。
 *
 * 并行监工比单 agent 更容易"静默出错"（盯错目录、盯错会话），所以这里对
 * 名字缺失/重名、adapter 未知都给出明确警告，而不是让它在运行时神秘失败。
 *
 * @param {any} config
 * @param {string[]} warnings
 */
export function validateAgents(config, warnings = []) {
  const entries = config.agents
  if (entries === undefined || entries === null) { config.agents = []; return warnings }
  if (!Array.isArray(entries)) {
    warnings.push('agents 必须是数组，已忽略')
    config.agents = []
    return warnings
  }
  if (!entries.length) return warnings

  const seen = new Set()
  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      warnings.push(`agents[${index}] 不是对象，已忽略`)
      return
    }
    const name = String(entry.name ?? entry.id ?? `agent-${index + 1}`).trim() || `agent-${index + 1}`
    if (seen.has(name)) warnings.push(`agents 里有重名「${name}」：运行时会自动加后缀区分，建议改成不同的名字`)
    seen.add(name)

    const adapter = entry.adapter ?? entry.agent?.adapter ?? config.agent?.adapter
    if (!ADAPTER_IDS.includes(adapter)) {
      warnings.push(`agents[${index}].adapter=${adapter} 未知（可用：${ADAPTER_IDS.join(', ')}）`)
    }
    if (entry.cwd !== undefined && typeof entry.cwd !== 'string') {
      warnings.push(`agents[${index}].cwd 必须是字符串`)
    }
    if (entry.plan !== undefined && typeof entry.plan !== 'string') {
      warnings.push(`agents[${index}].plan 必须是字符串`)
    }
  })

  if (config.judge?.kind !== 'rule' && !process.env[config.judge?.llm?.apiKeyEnv ?? 'DEEPSEEK_API_KEY']) {
    warnings.push(`${entries.length} 个 agent 并行时每轮都可能调用 LLM 判定，但 ${config.judge?.llm?.apiKeyEnv ?? 'DEEPSEEK_API_KEY'} 未设置：会退化为 rule`)
  }
  warnings.push(`多 agent 并行：${entries.length} 个条目共享同一套护栏预算（maxRounds=${config.guard?.maxRounds}，总花费上限 ${config.guard?.maxCostUsd ?? '未设置'}）`)
  return warnings
}

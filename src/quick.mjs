/**
 * 「一句话起步」——把配置这件事从用户手里拿走。
 *
 * 用户的原话是：*"我叫 agent 干活都是说一句话，搞个监工代替我劳动还要配这配那"*。
 * 所以这个模块负责把一句话变成一次可运行的监工：
 *
 *   1. **选 agent**：优先 DSH；如果这个项目里已经有一个 DSH 会话（不管是正在跑还是在等人），
 *      就接着那个会话用 HTTP 注入——**像人一样接着刚才那段对话继续盯**；否则用 headless 起新会话；
 *   2. **猜验收命令**：看 package.json / pytest / cargo / go / Makefile / verify.mjs …
 *      这是"判定准不准"的关键，能猜就不让用户手写；
 *   3. **自动写方案文档**：一句话当目标，验收命令当验收标准；不覆盖用户已有的 PLAN.md；
 *   4. **直接开跑**：打印三行"我决定这么干"，然后进入监工循环。
 *
 * 判定策略也随之为"零配置"服务：没有任务清单时，靠 **验收命令 + agent 的显式宣告（CW:DONE）
 * + 卡死检测** 判定，而不是逼用户去写复选框（见 judge/rule.mjs 的 zero-config 分支）。
 *
 * @module cyber-overseer/quick
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { defaultConfig, mergeConfig } from './config.mjs'
import { loadAdapters, createAdapter } from './adapters/index.mjs'
import { oneLine } from './util/text.mjs'
import { which } from './util/proc.mjs'
import { jsonRequest } from './util/http.mjs'

/** 认得出这些"验收命令"的证据文件（顺序即优先级）。 */
const VERIFY_SNIFFERS = [
  { file: 'package.json', detect: detectFromPackageJson },
  { file: 'pnpm-lock.yaml', detect: () => ['pnpm test'] },
  { file: 'yarn.lock', detect: () => ['yarn test'] },
  { file: 'pyproject.toml', detect: () => ['python -m pytest -q'] },
  { file: 'pytest.ini', detect: () => ['python -m pytest -q'] },
  { file: 'Cargo.toml', detect: () => ['cargo test'] },
  { file: 'go.mod', detect: () => ['go test ./...'] },
  { file: 'Makefile', detect: () => ['make test'] },
  { file: 'verify.mjs', detect: () => ['node verify.mjs'] },
  { file: 'verify.js', detect: () => ['node verify.js'] },
]

/** package.json 里挑测试/检查脚本。 */
function detectFromPackageJson(cwd) {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))
    const scripts = pkg.scripts ?? {}
    const out = []
    for (const name of ['test', 'test:unit', 'lint', 'typecheck', 'build']) {
      if (typeof scripts[name] === 'string') out.push(`npm run ${name === 'test' ? 'test' : name}`)
      if (out.length >= 2) break
    }
    // 有 test 脚本但内容只是占位（"no test specified"）时不算
    return out.filter(cmd => !/no test specified/i.test(scripts[cmd.replace('npm run ', '')] ?? ''))
  } catch {
    return []
  }
}

/**
 * 猜这个项目该怎么验收（最多两条：先测试，再检查/构建）。
 * @param {string} cwd
 * @returns {{commands:string[], evidence:string[]}}
 */
export function detectVerifyCommands(cwd) {
  const commands = []
  const evidence = []
  for (const sniffer of VERIFY_SNIFFERS) {
    if (!existsSync(join(cwd, sniffer.file))) continue
    const found = sniffer.detect(cwd) ?? []
    if (!found.length) continue
    evidence.push(sniffer.file)
    for (const command of found) if (!commands.includes(command)) commands.push(command)
    if (commands.length >= 2) break
  }
  return { commands: commands.slice(0, 2), evidence }
}

/**
 * 猜该监工谁：优先 DSH，并尽量接着"这个项目里已有的那个会话"。
 * @param {{cwd:string, log?:any, prefer?:string}} opts
 */
export async function detectAgent(opts) {
  const { cwd, log, prefer } = opts
  await loadAdapters()

  const candidates = prefer ? [prefer] : ['dsh', 'codex', 'opencode', 'cursor', 'acp', 'human-sim', 'generic-cli']
  for (const id of candidates) {
    let adapter
    try {
      adapter = createAdapter(id, { config: defaultConfig(), cwd, log })
      const probe = await adapter.probe()
      if (!probe.ok) { log?.debug?.(`${id} 不可用：${probe.reason}`); continue }
    } catch (error) {
      log?.debug?.(`${id} 探测失败：${error?.message ?? error}`)
      continue
    }

    // 找这个项目里的会话（"接着刚才那段对话继续盯"）
    // ⚠️ 只认**工作目录完全一致**的会话：DSH 的会话常常把 cwd 记成父目录，
    //    若用"包含关系"匹配，就会把兄弟项目的会话当成自己的——实测踩到过：
    //    在 cyber-overseer 里说一句话，它却要接着「俯视角僵尸射击游戏开发」那个会话。
    //    宁可不接、起新会话，也不能把监工开到别人的项目上去。
    let session = null
    let nearby = []
    let sessionFromParent = false
    try {
      const all = await adapter.listSessions()
      const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
      const mine = all.filter(s => norm(s.cwd) === norm(cwd))
      nearby = all.filter(s => {
        const other = norm(s.cwd)
        const target = norm(cwd)
        return other && other !== target && (target.startsWith(other + '/') || other.startsWith(target + '/'))
      })
      // 本项目自己有会话就用它；否则退一步用"上层目录里最新的那个"（很可能就是你刚才在用的），
      // 但要**说明白**用的是哪一个，别让用户以为监工盯的是本项目。
      session = mine[0] ?? nearby[0] ?? null
      if (!mine.length && session) sessionFromParent = true
    } catch { /* 忽略 */ }

    if (id === 'dsh') {
      const hasWeb = await dshWebAlive()
      const joinable = session && ['idle', 'awaiting-input', 'working'].includes(session.raw?.status ?? session.status ?? '')
      if (joinable && hasWeb) {
        return {
          adapter: id,
          options: { whip: 'http', httpEndpoint: 'http://127.0.0.1:3080' },
          session,
          why: `接着本项目已有的 DSH 会话（${oneLine(session.title ?? session.id, 30)}，${session.status ?? ''}），用 HTTP 注入到同一段对话`,
        }
      }
      const nearbyHint = sessionFromParent
        ? `（本项目没有自己的会话，接着的是上层目录里最新的那个：${oneLine(session.title ?? session.id, 30)}；要指定请用 --session <id>）`
        : (nearby.length ? `（另有 ${nearby.length} 个上层目录的会话，想接着某个请用 --session <id>）` : '')
      return {
        adapter: id,
        options: { whip: 'headless', permissionMode: 'workspace-write' },
        session,
        why: `用 DSH headless：每鞭起一个干净劳工，记忆靠工作区（PLAN.md + 代码 + git）${nearbyHint}`,
      }
    }

    const options = id === 'codex' ? { approvalPolicy: 'never', sandbox: 'workspace-write' } : {}
    return { adapter: id, options, session, why: `用 ${id}（本机可用）` }
  }
  return { adapter: 'generic-cli', options: {}, session: null, why: '没找到可用的 agent 适配器（可用 agent.options.command 指定任意命令行 agent）' }
}

/** DSH 的界面服务在不在跑（决定能不能"插进活会话"）。 */
async function dshWebAlive() {
  try {
    const res = await jsonRequest('http://127.0.0.1:3080/api/session.list', { method: 'POST', body: {}, timeoutMs: 2500 })
    return res.ok
  } catch {
    return false
  }
}

/**
 * 由一句话生成方案文档（不覆盖已有的 PLAN.md）。
 * @param {{sentence:string, verify:string[], cwd:string, agentLabel:string}} opts
 */
export function buildQuickPlan(opts) {
  const { sentence, verify, agentLabel } = opts
  const lines = [
    `# ${oneLine(sentence, 60)}`,
    '',
    '> 这份方案由「一句话起步」自动生成（`cw "<一句话>"`）。',
    '> 你可以随时编辑它——监工每轮都会重读，把 `- [ ]` 改成 `- [x]` 就是进度信号。',
    '',
    '## 目标',
    sentence,
    '',
    '## 验收标准',
  ]
  if (verify.length) for (const command of verify) lines.push(`- \`${command}\` 通过（退出码 0）`)
  else lines.push('- ⚠ 没猜到这个项目的验收命令：监工只能靠 agent 的完成宣告，建议补一条能跑的命令')
  lines.push('', `- 由 ${agentLabel} 完成上述目标，且不破坏现有功能`)
  lines.push(
    '',
    '## 任务清单',
    '（留空：本方案不靠复选框判进度）',
    '',
    '## 约定',
    '- 全部做完时，在回答里写上完成标记 `CW:DONE`（放在 HTML 注释里，监工能识别）',
    '- 卡住需要人类时写上受阻标记 `CW:BLOCKED` 并跟一句原因，监工会停下并写报告',
    '- 不要为了让验收命令通过而修改测试/CI 本身',
    '',
  )
  // 注意：这里**故意不写出标记的字面形式**（`<!-- CW:… -->`）。
  // 方案文档里出现字面标记会被解析器当成"真的宣告"（真实踩到过：监工一看方案就判定 agent 受阻/完成）。
  return lines.join('\n')
}

/**
 * 一句话起步：决定 → 生成方案与配置 → 返回可直接传给 runOverseer 的东西。
 * @param {{sentence:string, cwd:string, log?:any, preferAgent?:string, maxRounds?:number, quietHours?:object|null, verify?:string[], session?:string, joinWeb?:boolean}} opts
 */
export async function prepareQuickRun(opts) {
  const { sentence, cwd, log } = opts
  if (!sentence || !sentence.trim()) throw new Error('需要一句话目标，例如：cw "把登录页改成深色主题并跑通测试"')
  if (!existsSync(cwd)) throw new Error(`目录不存在：${cwd}`)

  const verifyInfo = opts.verify?.length ? { commands: opts.verify, evidence: ['（你指定的）'] } : detectVerifyCommands(cwd)
  const agent = await detectAgent({ cwd, log, prefer: opts.preferAgent })
  if (opts.joinWeb === false && agent.options.whip === 'http') {
    agent.options = { whip: 'headless', permissionMode: 'workspace-write' }
    agent.why = '你要求不插进活会话 → 用 headless 起新会话'
  }
  if (opts.session) agent.session = { ...(agent.session ?? {}), id: opts.session }
  // 逃生口：任意命令行 agent（`cw "..." --agent generic-cli --cmd "node agent.mjs {text}"`）
  if (opts.command?.length) {
    agent.options = { ...agent.options, command: opts.command }
    agent.why = `用自定义命令：${opts.command.join(' ')}`
  }

  // 方案文档：写进 .cyber/（不碰项目根的 PLAN.md，除非它不存在）
  const cyberDir = join(cwd, '.cyber')
  mkdirSync(cyberDir, { recursive: true })
  const planPath = join(cyberDir, 'PLAN.md')
  const planText = buildQuickPlan({ sentence, verify: verifyInfo.commands, cwd, agentLabel: agent.adapter })
  writeFileSync(planPath, planText, 'utf8')

  const config = mergeConfig(defaultConfig(), {
    plan: planPath,
    agent: {
      adapter: agent.adapter,
      cwd,
      session: agent.session?.id ? { id: agent.session.id } : 'latest',
      options: agent.options,
    },
    // 零配置模式的判定：验收命令 + 显式宣告 + 卡死检测（不需要用户写复选框）
    judge: { kind: 'chain', rule: { requireTodosChecked: false, requireVerifyPass: true, acceptDoneMarker: true, acceptVerifyGreenAfterAsks: 1, stallRounds: 3 } },
    evidence: { git: true, verify: verifyInfo.commands },
    guard: {
      maxRounds: Number(opts.maxRounds ?? 10),
      maxStallRounds: 3,
      maxBlockedRounds: 2,
      quietHours: opts.quietHours ?? null,
      cooldownMs: 5000,
    },
    journal: { dir: cyberDir, reportFile: join(cwd, 'CW-REPORT.md'), storeAnswers: false },
    runtime: { stateFile: join(cyberDir, 'state.json') },
    whip: { style: 'strict', requireReceipt: true },
  })
  config.__cwd = cwd
  // 落一份配置，方便之后用 `cw run --config .cyber/auto.config.json` 复现
  const configFile = join(cyberDir, 'auto.config.json')
  writeFileSync(configFile, JSON.stringify({
    plan: planPath,
    agent: config.agent,
    judge: config.judge,
    evidence: config.evidence,
    guard: config.guard,
    journal: config.journal,
    runtime: config.runtime,
  }, null, 2), 'utf8')

  return { sentence, cwd, planPath, planText, configFile, config, agent, verify: verifyInfo }
}

/** 给用户看的三行"我决定这么干"。 */
export function describeQuickRun(prepared) {
  const { agent, verify, planPath } = prepared
  const verifyText = verify.commands.length
    ? verify.commands.join(' + ') + (verify.evidence.length ? `（从 ${verify.evidence.join('/')} 猜的）` : '')
    : '（没猜到，建议手动加一条）'
  return [
    `监工谁：${agent.adapter}${agent.session?.id ? `（会话 ${String(agent.session.id).slice(0, 24)}）` : ''} — ${agent.why}`,
    `验收：${verifyText}`,
    `方案：${planPath}（想改随时改，监工每轮重读）`,
  ]
}

export { which, dirname }

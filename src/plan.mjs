/**
 * 方案文档（PLAN）解析。
 *
 * 监工的全部判断都建立在"目标是什么"之上，而目标写在人写的方案文档里。
 * 这里把 Markdown 方案文档解析成结构化对象：目标、验收标准、待办勾选、禁止事项、
 * 以及 agent 与监工之间的**显式协议标记**。
 *
 * 支持的文档形状（全部可选，有多少用多少）：
 *
 * ```markdown
 * # 项目名
 * ## 目标 / Goal          → objective
 * ## 验收标准 / Acceptance → acceptance[]（列表项）
 * ## 禁止 / Out of scope   → forbidden[]
 * - [ ] 待办             → todos[]（勾选状态决定进度）
 * <!-- CW:DONE -->        → agent 显式宣告完成
 * <!-- CW:BLOCKED 原因 --> → agent 显式宣告卡住
 * ```
 *
 * 另外支持 `cw:plan` 代码块里的 JSON 覆盖（给机器写的方案）：
 *
 * ```cw:plan
 * { "objective": "...", "acceptance": ["..."], "maxRounds": 20 }
 * ```
 *
 * @module cyber-overseer/plan
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { normalize } from './util/text.mjs'

/** 章节标题的别名表（中英都要认，用户的文档语言不可控）。 */
const SECTION_ALIASES = {
  objective: ['目标', '目的', '任务', 'objective', 'goal', 'mission', 'aim'],
  acceptance: ['验收', '验收标准', '完成标准', '完成定义', 'definition of done', 'acceptance', 'acceptance criteria', 'dod', 'done when'],
  forbidden: ['禁止', '不要做', '范围外', '不做什么', 'out of scope', 'forbidden', 'non-goals', 'non goals', 'constraints', '约束'],
  context: ['背景', '上下文', '说明', 'context', 'background', 'notes'],
  plan: ['计划', '步骤', '实施', 'plan', 'steps', 'tasks', 'todo', '待办'],
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*$/
const CHECKBOX_RE = /^\s*[-*+]\s+\[( |x|X)\]\s+(.*)$/
const BULLET_RE = /^\s*[-*+]\s+(?!\[[ xX]\])(.*)$/
const NUMBERED_RE = /^\s*\d+[.)]\s+(.*)$/
const MARKER_RE = /<!--\s*CW:([A-Z_-]+)(?:\s+([\s\S]*?))?-->/gi

/**
 * 读取并解析方案文档。
 * @param {string} file 绝对或相对路径
 * @param {{fs?:any, fallbackText?:string}} [opts]
 * @returns {ReturnType<typeof parsePlan> & {path:string, sha256:string}}
 */
export function loadPlan(file, opts = {}) {
  const fs = opts.fs ?? readFileSync
  let text
  try {
    text = String(fs(file, 'utf8'))
  } catch (error) {
    if (opts.fallbackText !== undefined) text = opts.fallbackText
    else throw new Error(`读不到方案文档 ${file}：${error?.message ?? error}`)
  }
  const parsed = parsePlan(text)
  return {
    ...parsed,
    path: file,
    sha256: createHash('sha256').update(text).digest('hex').slice(0, 16),
  }
}

/**
 * 解析方案文档文本。
 * @param {string} raw
 * @returns {{
 *   raw:string, title:string|null, objective:string|null, acceptance:string[],
 *   forbidden:string[], context:string|null, sectionNames:string[],
 *   todos:{text:string,done:boolean,line:number}[], doneCount:number, totalCount:number,
 *   remaining:string[], explicit:{done:boolean,blocked:boolean,blockedReason:string|null,notes:string[]},
 *   overrides:Record<string,any>|null, urls:string[]
 * }}
 */
export function parsePlan(raw) {
  const text = normalize(raw)
  const lines = text.split('\n')
  const sections = collectSections(lines)

  const title = firstTitle(lines)
  const objective = pickSection(sections, 'objective') ?? deriveObjective(text)
  const acceptance = toItems(pickSection(sections, 'acceptance'))
  const forbidden = toItems(pickSection(sections, 'forbidden'))
  const context = pickSection(sections, 'context')

  const todos = []
  lines.forEach((line, index) => {
    const m = CHECKBOX_RE.exec(line)
    if (m) todos.push({ text: m[2].trim(), done: m[1].toLowerCase() === 'x', line: index + 1 })
  })

  const explicit = parseMarkers(text)
  const overrides = parsePlanBlock(text)
  const urls = [...new Set((text.match(/https?:\/\/[^\s)"'<>]+/g) ?? []))].slice(0, 20)

  const doneCount = todos.filter(t => t.done).length
  return {
    raw: text,
    title,
    objective,
    acceptance,
    forbidden,
    context,
    sectionNames: sections.map(s => s.name),
    todos,
    doneCount,
    totalCount: todos.length,
    remaining: todos.filter(t => !t.done).map(t => t.text),
    explicit,
    overrides,
    urls,
  }
}

function firstTitle(lines) {
  for (const line of lines) {
    const m = HEADING_RE.exec(line)
    if (m && m[1].length === 1) return m[2].trim()
  }
  return null
}

function collectSections(lines) {
  const sections = []
  let current = null
  for (const line of lines) {
    const m = HEADING_RE.exec(line)
    if (m) {
      current = { name: m[2].trim(), level: m[1].length, body: [] }
      sections.push(current)
      continue
    }
    current?.body.push(line)
  }
  return sections.map(s => ({ ...s, text: s.body.join('\n').trim() }))
}

function pickSection(sections, key) {
  const aliases = SECTION_ALIASES[key] ?? []
  const hit = sections.find(s => {
    const name = s.name.toLowerCase().replace(/[:：]\s*$/, '').trim()
    return aliases.some(a => name === a || name.startsWith(a + ' ') || name.includes(a))
  })
  return hit?.text ?? null
}

/** 没有"目标"章节时，退化为"标题 + 第一段正文"。 */
function deriveObjective(text) {
  const paragraphs = text
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(p => p && !HEADING_RE.test(p) && !p.startsWith('|') && !p.startsWith('>'))
  return paragraphs.slice(0, 2).join('\n\n') || null
}

function toItems(sectionText) {
  if (!sectionText) return []
  const items = []
  for (const line of sectionText.split('\n')) {
    const cb = CHECKBOX_RE.exec(line)
    if (cb) { items.push(cb[2].trim()); continue }
    const bullet = BULLET_RE.exec(line)
    if (bullet) { items.push(bullet[1].trim()); continue }
    const numbered = NUMBERED_RE.exec(line)
    if (numbered) { items.push(numbered[1].trim()); continue }
  }
  // 没有列表项的章节：把非空行当成条目（有些方案文档直接写段落）
  if (items.length === 0) {
    return sectionText.split('\n').map(l => l.trim()).filter(Boolean)
  }
  return items
}

function parseMarkers(text) {
  const result = { done: false, blocked: false, blockedReason: null, notes: [] }
  for (const m of text.matchAll(MARKER_RE)) {
    const key = m[1].toUpperCase()
    const value = (m[2] ?? '').trim()
    if (key === 'DONE' || key === 'COMPLETE' || key === 'FINISHED') result.done = true
    else if (key === 'BLOCKED') { result.blocked = true; result.blockedReason = value || '未说明原因' }
    else if (key === 'NOTE') result.notes.push(value)
  }
  return result
}

function parsePlanBlock(text) {
  const m = /```cw:plan\s*([\s\S]*?)```/i.exec(text)
  if (!m) return null
  try { return JSON.parse(m[1]) } catch { return null }
}

/**
 * 计算"方案进度"：勾选比例 + 剩余清单。
 * 监工的规则判定器用它做第一层判断（全勾完 = 可以收工，前提是验收命令也过）。
 * @param {ReturnType<typeof parsePlan>} plan
 * @param {{requireAcceptance?:boolean}} [opts]
 */
export function planProgress(plan, opts = {}) {
  const total = plan.totalCount
  const ratio = total === 0 ? null : plan.doneCount / total
  const finished = total > 0 ? plan.remaining.length === 0 : null
  const acceptanceKnown = plan.acceptance.length > 0
  return {
    total,
    done: plan.doneCount,
    ratio,
    finishedByTodos: finished,
    allChecked: total > 0 && plan.remaining.length === 0,
    acceptanceKnown,
    // "规则判定无从下手"的判据：既没有可勾选的清单，也没有可核对的验收标准。
    // 注意 objective 写得再漂亮也没用——规则判定需要对得上的证据。
    undecidable: total === 0 && !acceptanceKnown,
    unsupportedByChecklist: total === 0 && acceptanceKnown,
  }
}

/**
 * 生成给判定器/agent 看的"方案摘要"（控制长度，避免把整篇文档灌进提示词）。
 * @param {ReturnType<typeof parsePlan>} plan
 * @param {number} [maxChars]
 */
export function planSummary(plan, maxChars = 6000) {
  const parts = []
  if (plan.title) parts.push(`# ${plan.title}`)
  if (plan.objective) parts.push(`## 目标\n${plan.objective}`)
  if (plan.acceptance.length) parts.push(`## 验收标准\n${plan.acceptance.map(a => `- ${a}`).join('\n')}`)
  if (plan.forbidden.length) parts.push(`## 禁止/范围外\n${plan.forbidden.map(a => `- ${a}`).join('\n')}`)
  if (plan.totalCount) {
    parts.push(`## 进度（勾选 ${plan.doneCount}/${plan.totalCount}）\n${plan.todos.map(t => `- [${t.done ? 'x' : ' '}] ${t.text}`).join('\n')}`)
  }
  const text = parts.join('\n\n')
  return text.length <= maxChars ? text : text.slice(0, maxChars) + '\n…（方案文档已截断）'
}

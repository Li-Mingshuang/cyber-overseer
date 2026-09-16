/**
 * 证据采集：让判定建立在事实上，而不是 agent 的自述上。
 *
 * 三类证据：
 *  1. **验收命令**：`npm test`、`cargo build`、`pytest`…… 通过与否是硬事实；
 *  2. **工作区改动**：git diff --stat / 未跟踪文件 / 文件指纹，用来判断"它到底动没动手"；
 *  3. **方案勾选**：方案文档本身的 sha + 勾选进度（人写的合同）。
 *
 * 缓存策略：验收命令很慢，默认只在"输入变了"的时候重跑——输入指纹 = git HEAD +
 * 工作区状态哈希 + 方案文档 sha。这样既保证证据新鲜，又不至于每轮重跑 10 分钟测试。
 *
 * @module cyber-overseer/engine/evidence
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { clip, hash, tail } from '../util/text.mjs'
import { run } from '../util/proc.mjs'

/**
 * @typedef {Object} VerifyResult
 * @property {string} command
 * @property {number|null} code
 * @property {boolean} ok
 * @property {boolean} timedOut
 * @property {number} durationMs
 * @property {string} outputTail
 * @property {boolean} [cached]
 * @property {string} at
 *
 * @typedef {Object} Evidence
 * @property {VerifyResult[]} verify
 * @property {{available:boolean, branch?:string, head?:string, diffStat?:string, untracked?:string[], changedSinceLastRound?:boolean|null, error?:string}} git
 * @property {string} answerHash
 * @property {string} fingerprint
 * @property {boolean} sameAsPreviousAnswer
 * @property {number} stallRounds
 * @property {string} inputFingerprint
 * @property {number} collectedAt
 */

/**
 * 采集证据。
 * @param {{
 *   config:any, cwd:string, plan:{sha256:string, doneCount:number, totalCount:number},
 *   answer:string, previous?:{evidence?:Evidence|null, answerHash?:string}, history?:any[],
 *   runFn?:typeof run, log?:any, signal?:AbortSignal
 * }} args
 * @returns {Promise<Evidence>}
 */
export async function collectEvidence(args) {
  const { config, cwd, plan, answer, previous, history = [], runFn = run, log, signal } = args
  const git = await collectGit(config, cwd, runFn, signal)
  const inputFingerprint = computeInputFingerprint({ git, plan })
  const verify = await collectVerify({ config, cwd, runFn, log, signal, inputFingerprint, previous })
  const answerHash = hash(normalizeAnswer(answer))
  const previousAnswerHash = previous?.answerHash ?? history.at(-1)?.answerHash ?? ''
  const fingerprint = computeFingerprint({ plan, git, verify })
  const previousFingerprint = previous?.evidence?.fingerprint ?? history.at(-1)?.fingerprint ?? ''
  const sameAsPreviousAnswer = Boolean(previousAnswerHash) && previousAnswerHash === answerHash
  const sameFingerprint = Boolean(previousFingerprint) && previousFingerprint === fingerprint

  return {
    verify,
    git,
    answerHash,
    fingerprint,
    inputFingerprint,
    sameAsPreviousAnswer,
    stallRounds: sameAsPreviousAnswer && sameFingerprint ? computeStall(history, answerHash, fingerprint) : 0,
    collectedAt: Date.now(),
  }
}

/**
 * 归一化回答再算哈希：去掉空白差异、去掉时间戳噪声，避免"只改了一个空格"被当成新进展。
 * @param {string} answer
 */
export function normalizeAnswer(answer) {
  return String(answer ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function collectGit(config, cwd, runFn, signal) {
  if (!config.evidence?.git) return { available: false }
  try {
    if (!existsSync(`${cwd}/.git`) && !existsSync(`${cwd}\\.git`)) {
      // 可能在工作区子目录里；用 rev-parse 判定更可靠
      const probe = await runFn('git', ['rev-parse', '--is-inside-work-tree'], { cwd, timeoutMs: 15000, signal })
      if (probe.code !== 0) return { available: false, error: '不是 git 仓库' }
    }
    const [branch, head, diffStat, porcelain] = await Promise.all([
      runFn('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: 15000, signal }),
      runFn('git', ['rev-parse', '--short', 'HEAD'], { cwd, timeoutMs: 15000, signal }),
      runFn('git', ['diff', '--stat', 'HEAD'], { cwd, timeoutMs: 30000, signal }),
      runFn('git', ['status', '--porcelain'], { cwd, timeoutMs: 30000, signal }),
    ])
    const untracked = porcelain.stdout
      .split('\n')
      .filter(l => l.startsWith('??'))
      .map(l => l.slice(3).trim())
      .slice(0, 50)
    return {
      available: true,
      branch: branch.stdout.trim() || undefined,
      head: head.stdout.trim() || undefined,
      diffStat: clip(diffStat.stdout.trim(), 4000, { headRatio: 0.8 }),
      untracked,
      statusHash: hash(porcelain.stdout),
    }
  } catch (error) {
    return { available: false, error: String(error?.message ?? error) }
  }
}

async function collectVerify({ config, cwd, runFn, log, signal, inputFingerprint, previous }) {
  const commands = config.evidence?.verify ?? []
  if (!commands.length) return []
  const everyRound = config.evidence?.verifyEveryRound === true
  const cache = new Map((previous?.evidence?.verify ?? []).map(v => [v.command, v]))
  const results = []
  for (const command of commands) {
    const cached = cache.get(command)
    if (!everyRound && cached && previous?.evidence?.inputFingerprint === inputFingerprint && cached.ok) {
      results.push({ ...cached, cached: true })
      continue
    }
    log?.step?.(`跑验收命令：${command}`)
    const started = Date.now()
    const result = await shellRun(command, cwd, config.evidence?.verifyTimeoutMs ?? 900000, runFn, signal)
    const verifyResult = {
      command,
      code: result.code,
      ok: result.code === 0 && !result.timedOut,
      timedOut: result.timedOut,
      durationMs: Date.now() - started,
      outputTail: tail(`${result.stdout}\n${result.stderr}`.trim(), 4000),
      at: new Date().toISOString(),
    }
    log?.[verifyResult.ok ? 'ok' : 'warn']?.(`${command} → ${verifyResult.ok ? '通过' : `失败(码 ${result.code})`}`)
    results.push(verifyResult)
  }
  return results
}

/** 验收命令可能是 `npm test`（含参数），所以走 shell。 */
function shellRun(command, cwd, timeoutMs, runFn, signal) {
  const shell = process.platform === 'win32' ? (process.env.COMSPEC ?? 'cmd.exe') : '/bin/sh'
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command]
  return runFn(shell, args, { cwd, timeoutMs, signal, maxOutput: 512 * 1024 })
}

function computeInputFingerprint({ git, plan }) {
  return hash(JSON.stringify({
    head: git?.head ?? null,
    statusHash: git?.statusHash ?? null,
    planSha: plan?.sha256 ?? null,
  }))
}

function computeFingerprint({ plan, git, verify }) {
  return hash(JSON.stringify({
    planSha: plan?.sha256 ?? null,
    planDone: plan?.doneCount ?? null,
    head: git?.head ?? null,
    statusHash: git?.statusHash ?? null,
    diff: git?.diffStat ?? null,
    verify: (verify ?? []).map(v => ({ c: v.command, ok: v.ok, code: v.code, out: hash(v.outputTail ?? '') })),
  }))
}

function computeStall(history, answerHash, fingerprint) {
  let stall = 1
  for (let i = history.length - 1; i >= 0; i--) {
    const rec = history[i]
    if (rec.answerHash === answerHash && rec.fingerprint === fingerprint) stall++
    else break
  }
  return stall
}

/** 读文件指纹（用于适配器判断"会话文件有没有变"）。 */
export function fileFingerprint(file) {
  try {
    const stat = statSync(file)
    return `${stat.size}:${stat.mtimeMs}`
  } catch {
    return ''
  }
}

/** 目录内文件内容的合并哈希（给非 git 项目做"有没有动静"的判断）。 */
export function dirFingerprint(dir, files) {
  let acc = ''
  for (const file of files) {
    try {
      const buf = readFileSync(file.startsWith(dir) ? file : `${dir}/${file}`)
      acc += createHash('sha1').update(buf).digest('hex')
    } catch { /* 跳过读不到的文件 */ }
  }
  return hash(acc)
}

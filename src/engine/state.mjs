/**
 * 断点续跑状态。
 *
 * 监工常常要跑一整夜，中途可能被 Ctrl+C、断电、重启打断。所有状态都落在一个
 * JSON 文件里，重启后能接着上一轮继续（`cw run --resume` 默认开启）。
 *
 * @module cyber-overseer/engine/state
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { isoLocal } from '../util/time.mjs'

/** 状态文件版本：结构变更时递增，读到旧版本直接丢弃（宁可重来也不要错乱）。 */
export const STATE_VERSION = 1

/**
 * @typedef {Object} RoundRecord
 * @property {number} round
 * @property {number} startedAt
 * @property {number} endedAt
 * @property {import('../judge/types.mjs').Verdict} verdict
 * @property {string|null} injected 抽出去的那一鞭（原文）
 * @property {string} answerHash
 * @property {string} [answerText] 回答原文（仅在 journal.storeAnswers 打开时保存）
 * @property {string} fingerprint 证据指纹（用于判"有没有进展"）
 * @property {number} costUsd
 * @property {number} waitMs 等待 agent 干完这一轮花了多久
 */

/**
 * @typedef {Object} OverseerState
 * @property {number} version
 * @property {string} adapter
 * @property {string|null} sessionId
 * @property {string} cwd
 * @property {string} planSha
 * @property {number} startedAt
 * @property {number} updatedAt
 * @property {number} roundsStarted
 * @property {number} costUsd
 * @property {string} status
 * @property {string|null} stopReason
 * @property {string} lastAnswerHash
 * @property {string} lastFingerprint
 * @property {RoundRecord[]} rounds
 */

/** 空状态。 */
export function emptyState(partial = {}) {
  return {
    version: STATE_VERSION,
    adapter: 'unknown',
    sessionId: null,
    cwd: process.cwd(),
    planSha: '',
    startedAt: Date.now(),
    updatedAt: Date.now(),
    roundsStarted: 0,
    costUsd: 0,
    status: 'idle',
    stopReason: null,
    lastAnswerHash: '',
    lastFingerprint: '',
    rounds: [],
    ...partial,
  }
}

/** 把状态文件路径归一化。 */
export function statePath(config, cwd = config.__cwd ?? process.cwd()) {
  const file = config.runtime?.stateFile ?? '.cyber/state.json'
  return isAbsolute(file) ? file : resolve(cwd, file)
}

/**
 * 读状态。
 * @param {string} file
 * @returns {OverseerState|null}
 */
export function loadState(file) {
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed?.version !== STATE_VERSION) return null
    return parsed
  } catch {
    return null
  }
}

/** 原子写状态（先写临时文件再 rename，避免掉电写坏）。 */
export function saveState(file, state) {
  const dir = dirname(file)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  state.updatedAt = Date.now()
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
  renameSync(tmp, file)
  return state
}

/**
 * 状态仓库：把"读改写"封装起来，顺便维护轮次记录与累计成本。
 */
export class StateStore {
  /**
   * @param {string} file
   * @param {OverseerState} [initial]
   */
  constructor(file, initial) {
    this.file = file
    this.state = initial ?? emptyState({ cwd: process.cwd() })
  }

  /** 从磁盘加载（不存在则新建）。 */
  static open(file, seed = {}) {
    const existing = loadState(file)
    return new StateStore(file, existing ?? emptyState(seed))
  }

  get rounds() { return this.state.rounds }

  /** 记录一轮。 */
  recordRound(record) {
    this.state.rounds.push(record)
    this.state.roundsStarted = Math.max(this.state.roundsStarted, record.round)
    this.state.lastAnswerHash = record.answerHash || this.state.lastAnswerHash
    this.state.lastFingerprint = record.fingerprint || this.state.lastFingerprint
    this.state.costUsd = Number((this.state.costUsd + (record.costUsd ?? 0)).toFixed(6))
    this.save()
    return record
  }

  /** 更新若干字段。 */
  patch(partial) {
    Object.assign(this.state, partial)
    this.save()
    return this.state
  }

  /** 落盘。 */
  save() {
    saveState(this.file, this.state)
    return this.state
  }

  /** 人类可读摘要（cw status 用）。 */
  summary() {
    const s = this.state
    const last = s.rounds.at(-1)
    return {
      status: s.status,
      adapter: s.adapter,
      sessionId: s.sessionId,
      rounds: s.roundsStarted,
      costUsd: s.costUsd,
      startedAt: isoLocal(s.startedAt),
      updatedAt: isoLocal(s.updatedAt),
      lastVerdict: last ? { status: last.verdict?.status, reason: last.verdict?.reason } : null,
      stopReason: s.stopReason,
    }
  }
}

/**
 * 暂停哨兵：文件存在即暂停。用文件而不是信号量，是因为主人可能从任何地方（手机 SSH、
 * 另一个终端、文件管理器）来"喊停"。
 * @param {string} pauseFile
 */
export function pauseControl(pauseFile) {
  return {
    file: pauseFile,
    isPaused: () => existsSync(pauseFile),
    pause: (note = '') => {
      mkdirSync(dirname(pauseFile), { recursive: true })
      writeFileSync(pauseFile, `paused at ${isoLocal()}\n${note}\n`, 'utf8')
    },
    resume: () => {
      if (existsSync(pauseFile)) unlinkSync(pauseFile)
    },
  }
}

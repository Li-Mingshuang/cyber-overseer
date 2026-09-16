/**
 * 共享预算：多个 agent 并行监工时的"总闸"。
 *
 * 单 agent 时，轮次/时长/花费记在各自的 `.cyber/state.json` 里就够了。但真实项目里
 * 常常同时开着 Cursor 写前端、codex 改后端——如果每个 agent 都各自允许 24 轮，
 * 总花费会变成 24×N，主人睡一觉起来可能被账单吓到。
 *
 * 所以并行监工共用**一套**预算：总轮次、总时长、总花费。任何一个 agent 想干下一轮，
 * 都要先问过这个总闸；额度用完，所有 agent 一起收工，报告里写清楚"额度被谁用掉的"。
 *
 * 这里是纯逻辑（不碰文件、不发通知），所以可以被单测直接钉死。
 *
 * @module cyber-overseer/engine/budget
 */

/**
 * @typedef {Object} BudgetHit
 * @property {boolean} stop
 * @property {'max-wall-clock'|'max-rounds'|'max-cost'} reason
 * @property {string} [detail]
 */

export class SharedBudget {
  /**
   * @param {{maxRounds?:number, maxWallClockMs?:number, maxCostUsd?:number|null, startedAt?:number}} [opts]
   */
  constructor(opts = {}) {
    /** 总轮次上限（0/-1 = 不限）。 */
    this.maxRounds = Number.isFinite(opts.maxRounds) ? opts.maxRounds : 0
    /** 总时长上限（0 = 不限）。 */
    this.maxWallClockMs = Number.isFinite(opts.maxWallClockMs) ? opts.maxWallClockMs : 0
    /** 总花费上限（null = 不限）。 */
    this.maxCostUsd = opts.maxCostUsd ?? null
    this.startedAt = opts.startedAt ?? Date.now()
    /** 已开出的轮次（所有 agent 之和）。 */
    this.rounds = 0
    /** 已累计的判定花费（所有 agent 之和）。 */
    this.costUsd = 0
    /** 明细：谁用掉了多少（写合并报告用）。 */
    this.roundsByAgent = {}
    this.costByAgent = {}
  }

  /**
   * 记一轮。**必须在真正开始这一轮之前调用**，否则并发下会超支。
   * @param {string} [agent]
   * @returns {number} 记完之后的累计轮次
   */
  noteRound(agent = '(未命名)') {
    this.rounds++
    this.roundsByAgent[agent] = (this.roundsByAgent[agent] ?? 0) + 1
    return this.rounds
  }

  /**
   * 记一笔花费。
   * @param {number} usd
   * @param {string} [agent]
   * @returns {number} 累计花费
   */
  addCost(usd, agent = '(未命名)') {
    const value = Number(usd)
    if (!Number.isFinite(value) || value === 0) return this.costUsd
    this.costUsd = Number((this.costUsd + value).toFixed(6))
    this.costByAgent[agent] = Number(((this.costByAgent[agent] ?? 0) + value).toFixed(6))
    return this.costUsd
  }

  /**
   * 还能不能继续干？返回 null = 可以。
   *
   * 判定顺序固定为时长 → 轮次 → 花费，保证"为什么停"在所有 agent 上一致（主人复盘时不会困惑）。
   * @param {number} [now]
   * @returns {BudgetHit|null}
   */
  check(now = Date.now()) {
    if (this.maxWallClockMs > 0 && now - this.startedAt >= this.maxWallClockMs) {
      return { stop: true, reason: 'max-wall-clock', detail: `已跑 ${Math.round((now - this.startedAt) / 1000)}s / 上限 ${Math.round(this.maxWallClockMs / 1000)}s` }
    }
    if (this.maxRounds > 0 && this.rounds >= this.maxRounds) {
      return { stop: true, reason: 'max-rounds', detail: `已用 ${this.rounds} / 上限 ${this.maxRounds} 轮` }
    }
    if (this.maxCostUsd != null && this.maxCostUsd >= 0 && this.costUsd >= this.maxCostUsd) {
      return { stop: true, reason: 'max-cost', detail: `已花 $${this.costUsd.toFixed(4)} / 上限 $${this.maxCostUsd}` }
    }
    return null
  }

  /** 快照（进报告/返回值）。 */
  snapshot() {
    return {
      maxRounds: this.maxRounds,
      maxWallClockMs: this.maxWallClockMs,
      maxCostUsd: this.maxCostUsd,
      startedAt: this.startedAt,
      elapsedMs: Date.now() - this.startedAt,
      rounds: this.rounds,
      costUsd: this.costUsd,
      roundsByAgent: { ...this.roundsByAgent },
      costByAgent: { ...this.costByAgent },
    }
  }
}

/**
 * 从 `config.guard` 造一个共享预算。
 * @param {any} guard
 * @param {{startedAt?:number}} [opts]
 * @returns {SharedBudget}
 */
export function createBudget(guard = {}, opts = {}) {
  return new SharedBudget({
    maxRounds: guard?.maxRounds,
    maxWallClockMs: guard?.maxWallClockMs,
    maxCostUsd: guard?.maxCostUsd ?? null,
    startedAt: opts.startedAt,
  })
}

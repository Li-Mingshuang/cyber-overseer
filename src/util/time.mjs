/**
 * 时间与静默期工具。
 *
 * 这个项目的一切都围绕"人类主人什么时候在休息"：
 *  - `requireHumanIdleMs`：系统级空闲（键鼠无输入）达到阈值才允许抽鞭；
 *  - `quietHours`：只在夜间/指定时段行动（默认正是"主人睡觉时"）；
 *  - `workWindow`：反向约束，只在白天工作时段行动（给"我要它别在我上班时抢焦点"的用户）。
 *
 * @module cyber-overseer/util/time
 */

/** 当前毫秒时间戳。 */
export const nowMs = () => Date.now()

/** 毫秒转人类可读的时长。 */
export function humanDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const parts = []
  if (d) parts.push(`${d}天`)
  if (h) parts.push(`${h}小时`)
  if (m) parts.push(`${m}分`)
  if (!d && !h) parts.push(`${sec}秒`)
  return parts.join('')
}

/** `"23:00"` → 分钟数；非法输入返回 null。 */
export function parseHhMm(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/** 本地时间转"当天分钟数"。 */
export function minutesOfDay(date = new Date()) {
  return date.getHours() * 60 + date.getMinutes()
}

/**
 * 判断某个"时段"是否包含当前时刻。支持跨零点（如 23:00→08:00）。
 * @param {{from:string,to:string}|null|undefined} window
 * @param {Date} [date]
 * @returns {boolean} 未配置时段时恒为 true
 */
export function inWindow(window, date = new Date()) {
  if (!window) return true
  const from = parseHhMm(window.from)
  const to = parseHhMm(window.to)
  if (from === null || to === null) return true
  const cur = minutesOfDay(date)
  if (from === to) return true
  return from < to ? (cur >= from && cur < to) : (cur >= from || cur < to)
}

/**
 * 计算距离下一次进入时段还有多久（毫秒）。
 * @param {{from:string,to:string}} window
 * @param {Date} [date]
 * @returns {number}
 */
export function msUntilWindow(window, date = new Date()) {
  const from = parseHhMm(window?.from)
  if (from === null) return 0
  const cur = minutesOfDay(date)
  const diff = (from - cur + 1440) % 1440
  const secondsIntoMinute = date.getSeconds()
  return (diff * 60 - secondsIntoMinute) * 1000
}

/** ISO 时间戳（本地时区，便于人读）。 */
export function isoLocal(ms = Date.now()) {
  const d = new Date(ms)
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const oh = pad(Math.floor(Math.abs(off) / 60))
  const om = pad(Math.abs(off) % 60)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${sign}${oh}:${om}`
}

/** 简易 sleep（可被 AbortSignal 打断）。 */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'))
    const timer = setTimeout(() => { cleanup(); resolve() }, ms)
    const onAbort = () => { cleanup(); reject(new Error('aborted')) }
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort) }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

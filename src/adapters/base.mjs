/**
 * 适配器契约与共享工具。
 *
 * 一个适配器要回答四个问题：
 *   1. `probe()`          —— 这台机器上能用吗？缺什么？
 *   2. `listSessions()`   —— 有哪些会话可以监工？
 *   3. `readState(s)`     —— 它现在在干什么？最后说了什么？说完没有？
 *   4. `whip(text, s)`    —— 怎么把下一句话塞给它？
 *
 * 关于 `whip()` 的返回值，有一个非常重要的区分（引擎据此决定要不要等）：
 *   - `mode:'foreground'`：这次调用**自己把 agent 跑完了一整轮**（CLI 类适配器），
 *     返回时新回答已经在会话里了；
 *   - `mode:'inject'`：只是往活着的会话里**塞了一句话**（GUI 拟人 / hook / HTTP），
 *     引擎还要等它开工、等它收工。
 *
 * 另外所有适配器都要遵守两条铁律：
 *   - **只读别人家的数据**：读 agent 的会话存储时永远只读，绝不改（要写就写自己的 .cyber/）；
 *   - **不猜测**：读不到就说读不到（返回 error/unknown），不要让引擎在假数据上做判决。
 *
 * @module cyber-overseer/adapters/base
 */

import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { oneLine } from '../util/text.mjs'

/**
 * @typedef {'working'|'idle'|'awaiting-approval'|'awaiting-input'|'error'|'unknown'} AgentStatus
 *
 * @typedef {Object} SessionRef
 * @property {string} id
 * @property {string} [title]
 * @property {string} [cwd]
 * @property {number} [updatedAt]
 * @property {string} [path] 会话在磁盘上的位置（有的适配器没有）
 * @property {any} [raw]
 *
 * @typedef {Object} AgentSnapshot
 * @property {AgentStatus} status
 * @property {number|null} turn
 * @property {string} lastAnswer 最后一次"真正说出口"的回答文本
 * @property {string|null} lastUserMessage
 * @property {boolean} [awaitingInput] agent 正在等人回答问题
 * @property {any} [approval] 待审批的内容
 * @property {string} [error]
 * @property {SessionRef} [session]
 * @property {Record<string, any>} [extra]
 *
 * @typedef {Object} WhipResult
 * @property {boolean} ok
 * @property {'foreground'|'inject'} mode
 * @property {string} [detail]
 * @property {string} [answer] mode=foreground 时可直接拿到的新回答
 * @property {number} [exitCode]
 * @property {'setup'|'transient'|'fatal'} [kind] 失败分类：
 *   `setup`     = 通道没配置好/没启动（例如 Cursor 还没装钩子、DSH web 没在跑）→ 停下喊人，而不是报错
 *   `transient` = 临时故障（网络抖动、目标窗口暂时不在）→ 引擎下轮可以再试
 *   `fatal`     = 默认，真正的错误
 *
 * @typedef {Object} Adapter
 * @property {string} id
 * @property {string} label
 * @property {string} docs 一句话说明这个适配器靠什么通道工作
 * @property {() => Promise<{ok:boolean, detail?:string, reason?:string, hints?:string[]}>} probe
 * @property {() => Promise<SessionRef[]>} listSessions
 * @property {(wanted:any, ctx:any) => Promise<SessionRef|null>} resolveSession
 * @property {(session:SessionRef) => Promise<AgentSnapshot>} readState
 * @property {(text:string, session:SessionRef, ctx:any) => Promise<WhipResult>} whip
 * @property {((approval:any, session:SessionRef) => Promise<{ok:boolean, detail?:string}>) } [approve]
 * @property {() => Promise<string>} [capabilities]
 */

/** 探针结果糖。 */
export const probeOk = (detail, hints) => ({ ok: true, detail, hints })
export const probeFail = (reason, hints = []) => ({ ok: false, reason, hints })

/** 通用 home 目录解析（`~` 展开）。 */
export function expandHome(p) {
  if (!p) return p
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return resolve(homedir(), p.slice(2))
  return isAbsolute(p) ? p : resolve(process.cwd(), p)
}

/** 路径存在且是文件/目录。 */
export function exists(p) {
  try { return existsSync(p) } catch { return false }
}

/** 安全的 mtime（读不到返回 0）。 */
export function mtimeOf(p) {
  try { return statSync(p).mtimeMs } catch { return 0 }
}

/** 安全的 size（读不到返回 -1）。 */
export function sizeOf(p) {
  try { return statSync(p).size } catch { return -1 }
}

/**
 * 会话匹配：把配置里的 `session` 值（'latest' | id | {id} | {match:{...}}）解析到具体会话。
 * @param {SessionRef[]} sessions 已按"最新优先"排序
 * @param {any} wanted
 * @param {{cwd?:string, log?:any}} [opts]
 * @returns {SessionRef|null}
 */
export function selectSession(sessions, wanted, opts = {}) {
  if (!sessions.length) return null
  if (!wanted || wanted === 'latest' || wanted === 'new') {
    const cwdScoped = opts.cwd ? sessions.filter(s => samePath(s.cwd, opts.cwd)) : []
    return (cwdScoped.length ? cwdScoped : sessions)[0] ?? null
  }
  if (typeof wanted === 'string') {
    return sessions.find(s => s.id === wanted || s.id.startsWith(wanted) || s.path === wanted) ?? null
  }
  if (typeof wanted === 'object') {
    if (wanted.id) return selectSession(sessions, wanted.id, opts)
    const match = wanted.match ?? wanted
    return sessions.find(s => {
      if (match.cwd && !samePath(s.cwd, match.cwd)) return false
      if (match.title && !String(s.title ?? '').toLowerCase().includes(String(match.title).toLowerCase())) return false
      if (match.path && s.path !== match.path) return false
      if (match.newerThan && (s.updatedAt ?? 0) < match.newerThan) return false
      return true
    }) ?? null
  }
  return null
}

/** 路径比较（Windows 大小写不敏感）。 */
export function samePath(a, b) {
  if (!a || !b) return false
  const norm = (p) => resolve(p).replace(/[\\/]+$/, '').toLowerCase()
  try { return norm(a) === norm(b) } catch { return false }
}

/** 简单 TTL 缓存（读会话文件很频繁，子代理写盘也很频繁）。 */
export function createCache(ttlMs = 1500) {
  const map = new Map()
  return {
    /**
     * @param {string} key
     * @param {() => any} produce
     */
    get(key, produce) {
      const hit = map.get(key)
      const now = Date.now()
      if (hit && now - hit.at < ttlMs) return hit.value
      const value = produce()
      map.set(key, { at: now, value })
      return value
    },
    invalidate(key) { if (key === undefined) map.clear(); else map.delete(key) },
  }
}

/**
 * 拼一个"给人看的"适配器能力描述（cw adapters 用）。
 * @param {Adapter} adapter
 */
export function describeAdapter(adapter) {
  return `${adapter.id.padEnd(12)} ${adapter.label}${adapter.docs ? ` — ${oneLine(adapter.docs, 80)}` : ''}`
}

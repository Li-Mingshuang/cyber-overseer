/**
 * sqlite 读取封装（node:sqlite，零依赖）。
 *
 * 这里的两次踩坑值得写下来，因为它们是**静默失败**型的：
 *  1. `new DatabaseSync(path, {readOnly:true})` 是**惰性打开**的——构造不抛错，
 *     直到第一条语句才抛。所以只判断构造成功会误以为能读。
 *  2. WAL 模式下如果只读打开（或所在目录不可写），sqlite 无法创建/读取 `-wal`，
 *     会读到**旧快照**或直接失败。可靠做法是把 `db + -wal + -shm` 一起拷到可写临时目录再读。
 *     （不建议用 `immutable=1`：它会直接忽略 WAL，等于读了个过期的库。）
 *
 * @module cyber-overseer/util/sqlite
 */

import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 运行时是否可用 node:sqlite。 */
export async function loadSqlite() {
  try {
    const mod = await import('node:sqlite')
    return mod.DatabaseSync ?? null
  } catch {
    return null
  }
}

/**
 * 只读打开一个 sqlite 库（带 WAL 拷贝回退）。
 * @param {string} file
 * @param {{DatabaseSync:any}|any} deps `node:sqlite` 模块本身，或它的 DatabaseSync 类
 * @returns {{db:any, close:()=>void, scratch:string|null, mode:'direct'|'copy'}}
 */
export function openReadOnly(file, deps) {
  // 容忍两种传法：`{ DatabaseSync }` 或直接传类（调用方很容易只把 loadSqlite() 的返回值丢进来）
  const DatabaseSync = deps?.DatabaseSync ?? deps
  if (typeof DatabaseSync !== 'function') {
    throw new Error('openReadOnly 需要一个 DatabaseSync 类（node:sqlite 在 Node >= 22.5 才有）')
  }
  const probe = (candidate) => {
    const db = new DatabaseSync(candidate, { readOnly: true })
    db.prepare('pragma schema_version').get() // 惰性打开：必须真跑一条语句
    return db
  }
  try {
    return { db: probe(file), close: () => {}, scratch: null, mode: 'direct' }
  } catch {
    const scratch = mkdtempSync(join(tmpdir(), 'cw-sqlite-'))
    const copy = join(scratch, 'db.sqlite')
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(file + suffix)) copyFileSync(file + suffix, copy + suffix)
    }
    try {
      const db = probe(copy)
      return { db, close: () => { try { db.close() } catch { /* 已关闭 */ } }, scratch, mode: 'copy' }
    } catch (error) {
      rmSync(scratch, { recursive: true, force: true })
      throw error
    }
  }
}

/** 用完即清（含临时目录）。 */
export function withReadOnly(file, deps, fn) {
  const handle = openReadOnly(file, deps)
  try {
    return fn(handle.db)
  } finally {
    handle.close()
    if (handle.scratch) rmSync(handle.scratch, { recursive: true, force: true })
  }
}

/** 安全 JSON 解析（sqlite 里很多列存的是 JSON 字符串）。 */
export function parseMaybeJson(value, fallback = null) {
  if (value === null || value === undefined) return fallback
  if (typeof value === 'object') return value
  try { return JSON.parse(String(value)) } catch { return fallback }
}

/** 把 loadSqlite() 的返回值整形成 openReadOnly 能用的形状。 */
export function sqliteDeps(DatabaseSync) {
  return { DatabaseSync }
}

/**
 * 子进程封装：所有"抽鞭"最终都落到这个模块（起 CLI、跑验收命令、调 PowerShell UI 驱动）。
 *
 * 设计要点：
 *  - **永不 shell 注入**：默认 `shell:false`，参数以数组传入（Windows 上对 .cmd/.ps1 自动走
 *    cmd.exe / powershell.exe 包装，见 `resolveSpawnTarget`）；
 *  - **可超时、可中断**：长跑的 `codex exec resume` 必须能被 Ctrl+C 和预算熔断打断；
 *  - **输出有界**：把 stdout/stderr 缓存在环形缓冲里，避免 21MB 的 rollout 把内存吃光。
 *
 * @module cyber-overseer/util/proc
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, extname, join } from 'node:path'

/** 单次调用的默认上限。 */
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_MAX_OUTPUT = 2 * 1024 * 1024

/**
 * 在 PATH 里找一个可执行文件。
 * Windows 上 npm 全局装的 CLI 是 `.cmd`/`.ps1` 垫片，必须按 PATHEXT 顺序找。
 * @param {string} name
 * @param {{env?:NodeJS.ProcessEnv, cwd?:string}} [opts]
 * @returns {string|null}
 */
export function which(name, opts = {}) {
  const env = opts.env ?? process.env
  const pathValue = env.PATH ?? env.Path ?? ''
  const dirs = pathValue.split(delimiter).filter(Boolean)
  const exts = process.platform === 'win32'
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD;.PS1').split(';').map(e => e.toLowerCase())
    : ['']
  const hasExt = extname(name) !== ''
  for (const dir of dirs) {
    if (hasExt) {
      const full = join(dir, name)
      if (existsSync(full)) return full
      continue
    }
    for (const ext of exts) {
      const full = join(dir, name + ext)
      if (existsSync(full)) return full
    }
  }
  return null
}

/**
 * 把命令名解析成 spawn 能直接跑的目标。
 * Windows 的 `.cmd`/`.bat` 只能由 cmd.exe 执行，`.ps1` 只能由 powershell 执行——
 * 这是 Node 在 Windows 上最容易踩的执行坑，所以集中在这里处理。
 * @param {string} command
 * @param {string[]} args
 * @returns {{file:string,args:string[]}}
 */
export function resolveSpawnTarget(command, args) {
  if (process.platform !== 'win32') return { file: command, args }
  const ext = extname(command).toLowerCase()
  if (ext === '.cmd' || ext === '.bat') {
    return { file: process.env.COMSPEC ?? 'cmd.exe', args: ['/d', '/s', '/c', command, ...args] }
  }
  if (ext === '.ps1') {
    const ps = which('pwsh') ?? which('powershell') ?? 'powershell.exe'
    return { file: ps, args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', command, ...args] }
  }
  return { file: command, args }
}

/**
 * 运行一个子进程并收集输出。
 * @param {string} command
 * @param {string[]} [args]
 * @param {{
 *   cwd?:string, env?:NodeJS.ProcessEnv, timeoutMs?:number, input?:string,
 *   maxOutput?:number, signal?:AbortSignal, onStdout?:(chunk:string)=>void,
 *   onStderr?:(chunk:string)=>void, log?:import('./log.mjs').createLogger extends never ? any : any,
 * }} [opts]
 * @returns {Promise<{code:number|null, signal:string|null, stdout:string, stderr:string, timedOut:boolean, durationMs:number, aborted:boolean}>}
 */
export function run(command, args = [], opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxOutput = opts.maxOutput ?? DEFAULT_MAX_OUTPUT
  const started = Date.now()
  const target = resolveSpawnTarget(command, args)

  return new Promise((resolve) => {
    let child
    try {
      child = spawn(target.file, target.args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        shell: false,
        windowsHide: true,
        stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({
        code: null, signal: null, stdout: '', stderr: String(error?.message ?? error),
        timedOut: false, durationMs: Date.now() - started, aborted: false,
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false

    const append = (current, chunk) => {
      const next = current + chunk
      return next.length > maxOutput ? next.slice(next.length - maxOutput) : next
    }

    child.stdout?.on('data', (buf) => {
      const text = buf.toString('utf8')
      stdout = append(stdout, text)
      opts.onStdout?.(text)
    })
    child.stderr?.on('data', (buf) => {
      const text = buf.toString('utf8')
      stderr = append(stderr, text)
      opts.onStderr?.(text)
    })
    if (opts.input !== undefined && child.stdin) {
      child.stdin.end(opts.input)
    }

    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true
      killTree(child)
    }, timeoutMs) : null

    const onAbort = () => { aborted = true; killTree(child) }
    opts.signal?.addEventListener?.('abort', onAbort, { once: true })

    child.on('error', (error) => {
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener?.('abort', onAbort)
      resolve({
        code: null, signal: null, stdout, stderr: `${stderr}\n${error.message}`.trim(),
        timedOut, durationMs: Date.now() - started, aborted,
      })
    })

    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener?.('abort', onAbort)
      resolve({ code, signal, stdout, stderr, timedOut, durationMs: Date.now() - started, aborted })
    })
  })
}

/** 杀掉整棵进程树（CLI agent 常会 fork 出子代理，只杀父进程会留下孤儿）。 */
export function killTree(child) {
  if (!child || child.killed) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
    } else {
      child.kill('SIGTERM')
      setTimeout(() => { try { child.kill('SIGKILL') } catch { /* 已退出 */ } }, 3000)
    }
  } catch { /* 尽力而为 */ }
}

/**
 * 分离启动一个长期进程（不等待、不收集输出）。
 * 用于"启动 ChatGPT/Cursor 这类 GUI"或后台任务。
 * @param {string} command
 * @param {string[]} [args]
 * @param {{cwd?:string, env?:NodeJS.ProcessEnv, stdio?:any}} [opts]
 * @returns {{pid:number|undefined, child:import('node:child_process').ChildProcess}}
 */
export function spawnDetached(command, args = [], opts = {}) {
  const target = resolveSpawnTarget(command, args)
  const child = spawn(target.file, target.args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    detached: true,
    windowsHide: true,
    stdio: opts.stdio ?? 'ignore',
  })
  child.unref()
  return { pid: child.pid, child }
}

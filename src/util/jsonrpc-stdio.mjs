/**
 * 通用 JSON-RPC 2.0 over stdio 客户端（newline-delimited JSON）。
 *
 * 为什么要单独写一个：ACP（Agent Client Protocol）和 DSH 的 SDK JSON-RPC 服务端都长这个样子，
 * 而它们都是"能把下一句话塞给 agent"的**标准通道**——比各家私有 CLI 参数更通用。
 * 写一次，两个适配器都能用。
 *
 * 里面有一个必须踩过的坑（DSH 实测）：服务端可能**不串行化**收到的帧
 * （DSH 的 `JsonRpcLineTransport` 对每行做 `void this.handleLine(line)` 并不 await），
 * 所以客户端**必须等 `initialize` 的响应回来再发下一条**，否则会撞上"用了默认模型"之类的竞态。
 * 本实现天然满足：所有请求都带 id 且有响应等待。
 *
 * @module cyber-overseer/util/jsonrpc-stdio
 */

import { spawn } from 'node:child_process'
import { resolveSpawnTarget } from './proc.mjs'
import { oneLine } from './text.mjs'

/** JSON-RPC 错误码。 */
export const RPC_ERRORS = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
}

export class JsonRpcError extends Error {
  constructor(message, code, data) {
    super(message)
    this.name = 'JsonRpcError'
    this.code = code
    this.data = data
  }
}

/**
 * 一条 stdio JSON-RPC 连接。
 */
export class JsonRpcStdioClient {
  /**
   * @param {{
   *   command:string, args?:string[], cwd?:string, env?:NodeJS.ProcessEnv, log?:any,
   *   name?:string, maxStderr?:number, requestTimeoutMs?:number
   * }} opts
   */
  constructor(opts) {
    this.opts = opts
    this.name = opts.name ?? opts.command
    this.log = opts.log
    this.child = null
    this.buffer = ''
    this.stderrTail = ''
    this.nextId = 1
    this.pending = new Map()
    this.notificationHandlers = new Set()
    this.requestHandlers = new Set()
    this.exitHandlers = new Set()
    this.stopped = false
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 10 * 60 * 1000
    this.maxStderr = opts.maxStderr ?? 32 * 1024
  }

  /** 启动子进程并开始读帧。 */
  start() {
    if (this.child) return this
    const target = resolveSpawnTarget(this.opts.command, this.opts.args ?? [])
    this.child = spawn(target.file, target.args, {
      cwd: this.opts.cwd,
      env: this.opts.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk) => this.#consume(chunk))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-this.maxStderr)
      this.log?.debug?.(`[${this.name}] ${oneLine(chunk, 200)}`)
    })
    this.child.on('error', (error) => this.#failAll(new Error(`子进程错误：${error.message}`)))
    this.child.on('exit', (code, signal) => {
      const reason = new Error(`[${this.name}] 子进程退出（code=${code} signal=${signal}）${this.stderrTail ? `：${oneLine(this.stderrTail, 200)}` : ''}`)
      this.#failAll(reason)
      for (const handler of this.exitHandlers) handler({ code, signal, stderr: this.stderrTail })
    })
    // 兜底：监工进程自己被杀（Ctrl+C / 崩溃）时，绝不能把 ACP 子进程留成孤儿
    this.#armExitGuard()
    this.log?.debug?.(`[${this.name}] 已启动 pid=${this.child.pid}`)
    return this
  }

  /** 进程退出时尽力杀掉子进程（同步、best-effort，不阻塞退出）。 */
  #armExitGuard() {
    if (this.exitGuardArmed) return
    this.exitGuardArmed = true
    const cleanup = () => {
      try {
        if (this.child && this.child.exitCode === null) this.child.kill()
      } catch { /* 尽力而为 */ }
    }
    process.once('exit', cleanup)
    // 故意**不**注册 SIGINT/SIGTERM：那会抢在引擎的优雅收尾（写报告、落状态）之前退出。
    // 引擎收到中断会走 dispose() 主动收尾；这里只兜"进程以任何方式退出"的最后一道。
  }

  /** 发一个请求并等响应。 */
  request(method, params, opts = {}) {
    this.start()
    const id = this.nextId++
    const timeoutMs = opts.timeoutMs ?? this.requestTimeoutMs
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`[${this.name}] ${method} 超时（${Math.round(timeoutMs / 1000)}s）`))
      }, timeoutMs) : null
      const onAbort = () => {
        this.pending.delete(id)
        if (timer) clearTimeout(timer)
        reject(new Error(`[${this.name}] ${method} 被中断`))
      }
      opts.signal?.addEventListener?.('abort', onAbort, { once: true })
      this.pending.set(id, {
        method,
        resolve: (value) => { if (timer) clearTimeout(timer); opts.signal?.removeEventListener?.('abort', onAbort); resolve(value) },
        reject: (error) => { if (timer) clearTimeout(timer); opts.signal?.removeEventListener?.('abort', onAbort); reject(error) },
      })
      this.#write({ jsonrpc: '2.0', id, method, params })
    })
  }

  /** 发一个通知（不等响应）。 */
  notify(method, params) {
    this.start()
    this.#write({ jsonrpc: '2.0', method, params })
  }

  /** 注册通知处理器。 */
  onNotification(handler) { this.notificationHandlers.add(handler); return () => this.notificationHandlers.delete(handler) }

  /** 注册"服务端反向请求"处理器：返回值会作为 result 回给服务端。 */
  onRequest(handler) { this.requestHandlers.add(handler); return () => this.requestHandlers.delete(handler) }

  /** 注册进程退出回调。 */
  onExit(handler) { this.exitHandlers.add(handler); return () => this.exitHandlers.delete(handler) }

  /** 是否还活着。 */
  get alive() {
    return Boolean(this.child) && this.child.exitCode === null && !this.stopped
  }

  /** 关闭（先温柔关 stdin，再杀）。 */
  async stop({ graceMs = 500 } = {}) {
    if (!this.child || this.stopped) return
    this.stopped = true
    try { this.child.stdin.end() } catch { /* 已关闭 */ }
    await new Promise((resolveDone) => {
      const timer = setTimeout(() => {
        try { this.child?.kill() } catch { /* 已退出 */ }
        resolveDone()
      }, graceMs)
      this.child?.once('exit', () => { clearTimeout(timer); resolveDone() })
    })
  }

  // -------------------------------------------------------------------------

  #write(message) {
    if (!this.child?.stdin?.writable) {
      throw new Error(`[${this.name}] stdin 不可写（子进程已退出？）${this.stderrTail ? `：${oneLine(this.stderrTail, 200)}` : ''}`)
    }
    this.child.stdin.write(JSON.stringify(message) + '\n')
    this.log?.trace?.(`[${this.name}] → ${oneLine(JSON.stringify(message), 200)}`)
  }

  #consume(chunk) {
    this.buffer += chunk
    let index
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        this.log?.debug?.(`[${this.name}] 收到非 JSON 行：${oneLine(line, 160)}`)
        continue
      }
      this.log?.trace?.(`[${this.name}] ← ${oneLine(line, 200)}`)
      void this.#dispatch(message)
    }
  }

  async #dispatch(message) {
    const { id, method, params, result, error } = message ?? {}
    // 1) 响应
    if ((result !== undefined || error !== undefined) && id !== undefined && !method) {
      const entry = this.pending.get(id)
      if (!entry) return
      this.pending.delete(id)
      if (error) entry.reject(new JsonRpcError(error.message ?? '未知错误', error.code, error.data))
      else entry.resolve(result)
      return
    }
    // 2) 服务端 → 客户端的请求（需要回一个 result）
    if (method && id !== undefined) {
      for (const handler of this.requestHandlers) {
        try {
          const value = await handler(method, params)
          if (value !== undefined) { this.#write({ jsonrpc: '2.0', id, result: value }); return }
        } catch (handlerError) {
          this.#write({ jsonrpc: '2.0', id, error: { code: RPC_ERRORS.INTERNAL, message: String(handlerError?.message ?? handlerError) } })
          return
        }
      }
      // 没人处理：按协议返回"方法不存在"，避免服务端一直等
      this.#write({ jsonrpc: '2.0', id, error: { code: RPC_ERRORS.METHOD_NOT_FOUND, message: `客户端未实现 ${method}` } })
      return
    }
    // 3) 通知
    if (method) {
      for (const handler of this.notificationHandlers) {
        try { handler(method, params) } catch (handlerError) { this.log?.debug?.(`通知处理器出错：${handlerError?.message ?? handlerError}`) }
      }
    }
  }

  #failAll(error) {
    for (const [, entry] of this.pending) entry.reject(error)
    this.pending.clear()
  }
}

/**
 * 便捷构造：起一个 ACP/JSON-RPC 端并等 `initialize` 完成（避免竞态）。
 * @param {ConstructorParameters<typeof JsonRpcStdioClient>[0]} opts
 * @param {{method?:string, params?:any, timeoutMs?:number}} [init]
 */
export async function connectJsonRpc(opts, init = {}) {
  const client = new JsonRpcStdioClient(opts).start()
  const method = init.method ?? 'initialize'
  const result = await client.request(method, init.params ?? {}, { timeoutMs: init.timeoutMs ?? 60000 })
  return { client, result }
}

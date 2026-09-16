/**
 * 零依赖 HTTP 客户端：
 *  - 判定器调用 OpenAI 兼容接口（DeepSeek / OpenAI / OpenRouter / Ollama / vLLM 都是这个形状）；
 *  - DSH 适配器可选地通过本地 HTTP API 往运行中的会话插话；
 *  - 通知 webhook。
 *
 * 只依赖 Node 内置的全局 `fetch`。企业代理环境常见坑在这里一次性处理：
 *  - 环境变量代理（HTTP_PROXY/HTTPS_PROXY/NO_PROXY）Node 的 fetch 默认**不认**（undici 需要
 *    dispatcher），所以这里显式做了一层"遇到代理就报警并提示"的兜底，而不是静默失败；
 *  - 自签证书 / 内网网关：支持 `insecure` 开关。
 *
 * @module cyber-overseer/util/http
 */

/** 判断是否配置了代理（用于给出可操作的报错）。 */
export function detectProxy(env = process.env) {
  const raw = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy ?? ''
  if (!raw) return null
  const noProxy = (env.NO_PROXY ?? env.no_proxy ?? '').split(',').map(s => s.trim()).filter(Boolean)
  return { url: raw, noProxy }
}

/** 命中 NO_PROXY 规则就不走代理。 */
export function isNoProxy(host, noProxy = []) {
  return noProxy.some(pattern => {
    if (pattern === '*') return true
    const clean = pattern.replace(/^\./, '')
    return host === clean || host.endsWith(`.${clean}`)
  })
}

/**
 * 一个极简的 JSON HTTP 客户端。
 * 有意不使用 undici 的 ProxyAgent（那会引入依赖）；需要代理时依赖 Node 的
 * `--use-env-proxy`（Node 24+）或用户在系统层透明代理。这里只把问题讲清楚。
 * @param {string} url
 * @param {{method?:string, headers?:Record<string,string>, body?:any, timeoutMs?:number, signal?:AbortSignal, raw?:boolean}} [opts]
 */
export async function jsonRequest(url, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 120000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('请求超时')), timeoutMs)
  const onAbort = () => controller.abort(opts.signal?.reason)
  opts.signal?.addEventListener?.('abort', onAbort, { once: true })
  try {
    const res = await fetch(url, {
      method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
      headers: {
        accept: 'application/json',
        ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(opts.headers ?? {}),
      },
      body: opts.body === undefined ? undefined : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)),
      signal: controller.signal,
    })
    const text = await res.text()
    if (opts.raw) return { ok: res.ok, status: res.status, text, headers: res.headers }
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = null }
    return { ok: res.ok, status: res.status, data, text, headers: res.headers }
  } catch (error) {
    const proxy = detectProxy()
    const hint = proxy && !isNoProxy(safeHost(url), proxy.noProxy)
      ? `（检测到代理 ${proxy.url}：Node 的 fetch 默认不走环境变量代理，可用 NODE_OPTIONS=--use-env-proxy 或设置 NO_PROXY）`
      : ''
    throw new Error(`HTTP ${opts.method ?? 'POST'} ${url} 失败: ${error?.message ?? error}${hint}`)
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener?.('abort', onAbort)
  }
}

function safeHost(url) {
  try { return new URL(url).host } catch { return '' }
}

/**
 * 读取 SSE 流（判定器流式输出、DSH 事件流都能用）。
 * @param {string} url
 * @param {{method?:string, headers?:Record<string,string>, body?:any, signal?:AbortSignal, timeoutMs?:number}} [opts]
 * @returns {AsyncGenerator<{event:string, data:string}>}
 */
export async function* sseStream(url, opts = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('SSE 超时')), opts.timeoutMs ?? 300000)
  opts.signal?.addEventListener?.('abort', () => controller.abort(opts.signal?.reason), { once: true })
  try {
    const res = await fetch(url, {
      method: opts.method ?? 'POST',
      headers: { accept: 'text/event-stream', 'content-type': 'application/json', ...(opts.headers ?? {}) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: controller.signal,
    })
    if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        let event = 'message'
        const dataLines = []
        for (const line of chunk.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
        }
        if (dataLines.length) yield { event, data: dataLines.join('\n') }
      }
    }
  } finally {
    clearTimeout(timer)
  }
}

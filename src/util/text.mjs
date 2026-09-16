/**
 * 文本工具：判定器与适配器都要用到的轻量文本处理。
 * 刻意不引第三方库——这个项目要在离网机器上零依赖跑起来。
 * @module cyber-overseer/util/text
 */

/** 去掉 ANSI 颜色/光标控制序列（终端类 agent 的输出里全是这些）。 */
export function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s ?? '').replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\u001B\][^\u0007]*\u0007/g, '')
}

/** 归一化换行 + 去尾空白。 */
export function normalize(s) {
  return String(s ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim()
}

/** 截断，保留头尾（长输出的判定器输入需要"头尾都在"）。 */
export function clip(s, max = 4000, opts = {}) {
  const text = String(s ?? '')
  if (text.length <= max) return text
  const head = Math.floor(max * (opts.headRatio ?? 0.6))
  const tail = max - head
  return `${text.slice(0, head)}\n…[省略 ${text.length - max} 字符]…\n${text.slice(-tail)}`
}

/** 取文本尾部若干字符（判定器只需要"最后一次回答"）。 */
export function tail(s, max) {
  const text = String(s ?? '')
  return text.length <= max ? text : text.slice(-max)
}

/** 稳定哈希（判断"这一轮回答是否与上一轮相同"用，避免重复判定/重复抽鞭）。 */
export function hash(s) {
  const text = String(s ?? '')
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = (h1 ^ c) * 16777619 >>> 0
    h2 = (h2 + c * (i + 1)) >>> 0
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0'))
}

/** 从可能带 ``` 围栏的 LLM 输出里抠出第一个 JSON 对象。 */
export function extractJson(text) {
  const raw = stripAnsi(String(text ?? '')).trim()
  const fenced = raw.match(/```(?:json|JSON)?\s*([\s\S]*?)```/)
  const candidates = [fenced?.[1], raw].filter(Boolean)
  for (const candidate of candidates) {
    const trimmed = candidate.trim()
    try { return JSON.parse(trimmed) } catch { /* 继续 */ }
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try { return JSON.parse(trimmed.slice(start, end + 1)) } catch { /* 继续 */ }
    }
  }
  return null
}

/** 段首缩进渲染，用于报告。 */
export function indent(s, prefix = '  ') {
  return String(s ?? '').split('\n').map(l => (l.length ? prefix + l : l)).join('\n')
}

/** 单行摘要。 */
export function oneLine(s, max = 160) {
  const text = String(s ?? '').replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : text.slice(0, max - 1) + '…'
}

/** 把任意值安全转成 JSON 文本（循环引用/大对象保护）。 */
export function safeJson(value, max = 4000) {
  try {
    return clip(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? String(v) : v), 2), max)
  } catch {
    return String(value)
  }
}

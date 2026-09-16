/**
 * 可插拔的 OCR 引擎层。
 *
 * 为什么做成"可插拔"而不是挑一个写死：OCR 质量**强依赖场景与机器**——
 *  - Windows 自带 OCR：零依赖、能识别"截图上哪里是文字"（位置），但中文保真度差；
 *  - **RapidOCR（PaddleOCR 模型 + ONNX）**：中文准得多，代价是多一个 Python 依赖；
 *  - 自定义命令：你机器上已经装了什么都行（Umi-OCR / tesseract / 自研脚本）；
 *  - 视觉模型 API：对界面截图的理解能力最强，代价是联网 + 额度。
 *
 * 所以这里给出统一的 `{text, lines, engine, ms}` 契约，让上层（human-sim 读取阶梯、
 * `cw doctor`、基准脚本）不必关心背后是谁。挑选依据请用实测：`npm run bench:ocr`。
 *
 * @module cyber-overseer/ocr
 */

import { existsSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run, which } from '../util/proc.mjs'
import { clip, oneLine } from '../util/text.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/** RapidOCR 桥脚本（随包分发）。 */
export const RAPIDOCR_CLI = join(HERE, 'rapidocr_cli.py')

/**
 * 找一个可用的 Python：优先仓库内的隔离 venv（`.tools/ocr-venv`），其次 PATH。
 * 隔离 venv 是为了"不污染用户已有的 conda/系统 Python"。
 * @param {string} [cwd]
 */
export function findPython(cwd = process.cwd()) {
  if (process.env.CW_OCR_PYTHON) return process.env.CW_OCR_PYTHON
  const candidates = [
    join(cwd, '.tools', 'ocr-venv', 'Scripts', 'python.exe'),
    join(cwd, '.tools', 'ocr-venv', 'bin', 'python'),
  ]
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return which('python') ?? which('python3') ?? null
}

/**
 * @typedef {Object} OcrLine
 * @property {string} text
 * @property {number} x
 * @property {number} y
 * @property {number} [w]
 * @property {number} [h]
 * @property {number} [score]
 *
 * @typedef {Object} OcrResult
 * @property {boolean} ok
 * @property {string} provider
 * @property {string} [engine]
 * @property {number} [ms]
 * @property {string} text
 * @property {OcrLine[]} lines
 * @property {string} [error]
 */

/**
 * 列出所有 OCR 提供者及其可用性（`cw doctor` 用）。
 * @param {{cwd?:string, config?:any, log?:any}} [opts]
 * @returns {Promise<{id:string,label:string,available:boolean,detail:string,cost:string}[]>}
 */
export async function listOcrProviders(opts = {}) {
  const cwd = opts.cwd ?? process.cwd()
  const out = []

  // 1) Windows 自带
  if (process.platform === 'win32') {
    let detail = 'Windows.Media.Ocr（系统自带）'
    let available = false
    try {
      const { createWindowsDriver } = await import('../ui/windows.mjs')
      const driver = createWindowsDriver({ log: opts.log })
      const info = await driver.ocrLanguages()
      available = Boolean(info.ok)
      detail = `${detail}：语言 ${(info.languages ?? []).join('/')}，中文引擎${info.chineseOk ? '可用' : '不可用'}`
    } catch (error) {
      detail = `${detail}：不可用（${oneLine(String(error?.message ?? error), 80)}）`
    }
    out.push({ id: 'windows', label: 'Windows 自带 OCR', available, detail, cost: '零依赖 · 中文保真度差' })
  }

  // 2) RapidOCR（推荐的中文方案）
  const python = findPython(cwd)
  {
    let available = false
    let detail = '需要 Python 与 `pip install rapidocr-onnxruntime`'
    if (python && existsSync(RAPIDOCR_CLI)) {
      const check = await run(python, ['-c', 'import rapidocr_onnxruntime'], { cwd, timeoutMs: 30000 })
      available = check.code === 0
      detail = available
        ? `Python=${python}，rapidocr-onnxruntime 已安装`
        : `Python=${python}，但未安装 rapidocr-onnxruntime`
    } else if (!python) {
      detail = '找不到 Python'
    }
    out.push({ id: 'rapidocr', label: 'RapidOCR（PaddleOCR PP-OCR + ONNX）', available, detail, cost: '需 Python 包 · 中文准' })
  }

  // 3) 自定义命令
  const command = opts.config?.ocr?.command
  out.push({
    id: 'command',
    label: '自定义 OCR 命令',
    available: Array.isArray(command) && command.length > 0,
    detail: Array.isArray(command) ? command.join(' ') : '未配置（`ocr.command`，例如 ["Umi-OCR.exe","--path","{file}"]）',
    cost: '取决于你装了什么',
  })

  // 4) 视觉模型
  const vlm = opts.config?.ocr?.vlm
  const key = vlm?.apiKeyEnv ? process.env[vlm.apiKeyEnv] : null
  out.push({
    id: 'vlm',
    label: '视觉模型 API（OpenAI 兼容）',
    available: Boolean(vlm?.baseUrl && vlm?.model && (key || /localhost|127\.0\.0\.1/.test(vlm.baseUrl))),
    detail: vlm?.model ? `模型 ${vlm.model}（${vlm.apiKeyEnv ?? '需 API Key'}${key ? '：已设置' : '：未设置'}）` : '未配置（`ocr.vlm`）',
    cost: '联网 + 额度 · 对界面理解最强',
  })

  return out
}

/**
 * 按配置挑一个 OCR 提供者并识别一张图。
 * @param {string} imageFile 绝对路径（WinRT/Python 都要求绝对路径）
 * @param {{cwd?:string, config?:any, driver?:any, provider?:string, log?:any, signal?:AbortSignal}} opts
 * @returns {Promise<OcrResult>}
 */
export async function ocrImage(imageFile, opts = {}) {
  const cwd = opts.cwd ?? process.cwd()
  const config = opts.config ?? {}
  const wanted = opts.provider ?? config.ocr?.provider ?? 'auto'
  const file = resolve(imageFile)

  const providers = wanted === 'auto' ? ['rapidocr', 'windows', 'command', 'vlm'] : [wanted]
  const errors = []
  for (const provider of providers) {
    try {
      const result = await runProvider(provider, file, { ...opts, cwd, config })
      if (result?.ok) return result
      if (result?.error) errors.push(`${provider}: ${result.error}`)
    } catch (error) {
      errors.push(`${provider}: ${error?.message ?? error}`)
    }
  }
  return {
    ok: false, provider: wanted, text: '', lines: [],
    error: `所有 OCR 提供者都失败：${errors.join('；') || '没有可用的提供者'}`,
  }
}

async function runProvider(provider, file, opts) {
  switch (provider) {
    case 'windows': return ocrViaWindows(file, opts)
    case 'rapidocr': return ocrViaRapidOcr(file, opts)
    case 'command': return ocrViaCommand(file, opts)
    case 'vlm': return ocrViaVisionModel(file, opts)
    default: return { ok: false, provider, text: '', lines: [], error: `未知 OCR 提供者：${provider}` }
  }
}

/** Windows 自带 OCR（经 PowerShell 驱动；能顺便截图）。 */
async function ocrViaWindows(file, opts) {
  const { createWindowsDriver } = await import('../ui/windows.mjs')
  const driver = opts.driver ?? createWindowsDriver({ log: opts.log })
  const result = await driver.ocr({ file, lang: opts.config?.ocr?.windowsLang })
  if (!result.ok) return { ok: false, provider: 'windows', text: '', lines: [], error: result.error }
  return {
    ok: true,
    provider: 'windows',
    engine: result.engine,
    ms: result.ms,
    text: result.text ?? '',
    lines: (result.lines ?? []).map(line => ({ text: line.text, x: line.x, y: line.y, w: line.w, h: line.h })),
  }
}

/** RapidOCR：把图片交给 Python 桥脚本，解析它输出的单行 JSON。 */
async function ocrViaRapidOcr(file, opts) {
  const python = opts.config?.ocr?.python ?? findPython(opts.cwd)
  if (!python) return { ok: false, provider: 'rapidocr', text: '', lines: [], error: '找不到 Python（可用 CW_OCR_PYTHON 指定）' }
  if (!existsSync(RAPIDOCR_CLI)) return { ok: false, provider: 'rapidocr', text: '', lines: [], error: `缺少桥脚本：${RAPIDOCR_CLI}` }
  const started = Date.now()
  const result = await run(python, [RAPIDOCR_CLI, file], {
    cwd: opts.cwd,
    timeoutMs: opts.config?.ocr?.timeoutMs ?? 120000,
    signal: opts.signal,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  })
  const lastLine = result.stdout.trim().split('\n').filter(Boolean).at(-1) ?? ''
  let parsed = null
  try { parsed = JSON.parse(lastLine) } catch { /* 下面统一报错 */ }
  if (!parsed) {
    return {
      ok: false, provider: 'rapidocr', text: '', lines: [],
      error: `桥脚本输出无法解析（退出码 ${result.code}）：${oneLine(result.stderr || lastLine, 200)}`,
    }
  }
  if (!parsed.ok) return { ok: false, provider: 'rapidocr', text: '', lines: [], error: parsed.error ?? '未知错误' }
  return {
    ok: true,
    provider: 'rapidocr',
    engine: parsed.engine ?? 'rapidocr',
    ms: parsed.ms ?? (Date.now() - started),
    text: parsed.text ?? (parsed.lines ?? []).map(l => l.text).join('\n'),
    lines: (parsed.lines ?? []).map(line => ({ text: line.text, x: line.x, y: line.y, w: line.w, h: line.h, score: line.score })),
  }
}

/**
 * 自定义命令：把 `{file}` 换成图片路径执行，stdout 按 `parse` 解析。
 * `ocr.command = ['Umi-OCR.exe', '--path', '{file}']` 或 tesseract：
 * `['tesseract', '{file}', 'stdout', '-l', 'chi_sim+eng']`（此时 parse: 'text'）。
 */
async function ocrViaCommand(file, opts) {
  const template = opts.config?.ocr?.command
  if (!Array.isArray(template) || template.length === 0) {
    return { ok: false, provider: 'command', text: '', lines: [], error: '未配置 ocr.command' }
  }
  const args = template.map(part => String(part).replace(/\{file\}/g, file))
  const [command, ...rest] = args
  const result = await run(command, rest, { timeoutMs: opts.config?.ocr?.timeoutMs ?? 120000, signal: opts.signal })
  if (result.code !== 0) {
    return { ok: false, provider: 'command', text: '', lines: [], error: `命令退出码 ${result.code}：${oneLine(result.stderr, 160)}` }
  }
  const stdout = result.stdout.trim()
  const parse = opts.config?.ocr?.parse ?? 'text'
  if (parse === 'jsonl' || parse === 'json') {
    const lines = []
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('{')) continue
      try {
        const item = JSON.parse(trimmed)
        lines.push({ text: item.text ?? '', x: item.x ?? 0, y: item.y ?? 0, w: item.w, h: item.h })
      } catch { /* 跳过坏行 */ }
    }
    return { ok: true, provider: 'command', engine: command, text: lines.map(l => l.text).join('\n'), lines }
  }
  return { ok: true, provider: 'command', engine: command, text: stdout, lines: [] }
}

/** 视觉模型（OpenAI 兼容的 chat/completions + base64 图片）。 */
async function ocrViaVisionModel(file, opts) {
  const vlm = opts.config?.ocr?.vlm
  if (!vlm?.baseUrl || !vlm?.model) return { ok: false, provider: 'vlm', text: '', lines: [], error: '未配置 ocr.vlm' }
  const apiKey = vlm.apiKeyEnv ? process.env[vlm.apiKeyEnv] : null
  const base64 = readFileSync(file).toString('base64')
  const { jsonRequest } = await import('../util/http.mjs')
  const started = Date.now()
  const response = await jsonRequest(`${String(vlm.baseUrl).replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    body: {
      model: vlm.model,
      temperature: 0,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: vlm.prompt ?? '把这张界面截图里的所有文字**原样**转写成纯文本，保留换行与顺序，不要总结、不要解释、不要遗漏。' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
        ],
      }],
    },
    timeoutMs: vlm.timeoutMs ?? 120000,
    signal: opts.signal,
  })
  const text = response?.data?.choices?.[0]?.message?.content ?? ''
  if (!response.ok || !text) {
    return { ok: false, provider: 'vlm', text: '', lines: [], error: `视觉模型返回异常：HTTP ${response.status} ${oneLine(JSON.stringify(response.data ?? ''), 160)}` }
  }
  return {
    ok: true,
    provider: 'vlm',
    engine: vlm.model,
    ms: Date.now() - started,
    text,
    lines: String(text).split('\n').filter(Boolean).map((line, index) => ({ text: line, x: 0, y: index * 20, w: 0, h: 0 })),
  }
}

/** 供 `cw doctor` / 报告使用的摘要文本。 */
export function describeOcrResult(result) {
  if (!result.ok) return `OCR 失败（${result.provider}）：${result.error}`
  return `OCR(${result.provider}/${result.engine ?? '?'}) 读到 ${result.lines.length} 行 / ${result.text.length} 字，用时 ${result.ms ?? '?'}ms\n${clip(result.text, 400)}`
}

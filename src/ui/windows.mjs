/**
 * Windows 拟人驱动的 Node 封装。
 *
 * 为什么用 PowerShell 而不是原生插件：Windows 上 UIAutomationClient / WinForms 剪贴板 /
 * STA 线程这些能力，只有 .NET 侧才有；`powershell.exe` 是每台 Windows 都自带的东西，
 * 于是"零 npm 依赖 + 完整 GUI 自动化能力"同时成立。每次调用是一次独立进程（约 200~600ms），
 * 对"每隔几十秒抽一鞭"的场景完全够用。
 *
 * @module cyber-overseer/ui/windows
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run, which } from '../util/proc.mjs'
import { sleep } from '../util/time.mjs'
import { createLogger } from '../util/log.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 驱动脚本路径（随包分发）。 */
export const DRIVER_SCRIPT = join(HERE, 'win', 'ui-driver.ps1')

/** 选一个能跑 UIAutomationClient 的 PowerShell：5.1 桌面版自带，pwsh 7 没有。 */
export function findPowerShell() {
  if (process.env.CW_POWERSHELL) return process.env.CW_POWERSHELL
  const ps51 = which('powershell')
  if (ps51) return ps51
  const fallback = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (existsSync(fallback)) return fallback
  return which('pwsh') ?? 'powershell.exe'
}

/**
 * 创建驱动。
 * @param {{log?:any, scriptPath?:string, powershell?:string, timeoutMs?:number}} [opts]
 */
export function createWindowsDriver(opts = {}) {
  const log = opts.log ?? createLogger({ level: 'warn' })
  const scriptPath = opts.scriptPath ?? DRIVER_SCRIPT
  const powershell = opts.powershell ?? findPowerShell()
  const defaultTimeout = opts.timeoutMs ?? 30000

  /**
   * 调一次驱动。
   * @param {string} command
   * @param {Record<string, any>} [payload]
   * @param {{timeoutMs?:number, signal?:AbortSignal}} [callOpts]
   */
  async function call(command, payload = {}, callOpts = {}) {
    const args = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      '-Command', command,
      '-Json', JSON.stringify(payload ?? {}),
    ]
    const result = await run(powershell, args, {
      timeoutMs: callOpts.timeoutMs ?? defaultTimeout,
      signal: callOpts.signal,
      env: { ...process.env, CW_DRIVER: '1' },
    })
    if (result.timedOut) throw new Error(`UI 驱动 ${command} 超时（${callOpts.timeoutMs ?? defaultTimeout}ms）`)
    const stdout = result.stdout.trim()
    if (!stdout) {
      throw new Error(`UI 驱动 ${command} 无输出（退出码 ${result.code}）：${result.stderr.trim().slice(0, 400)}`)
    }
    const lastLine = stdout.split('\n').filter(Boolean).at(-1)
    let parsed
    try {
      parsed = JSON.parse(lastLine)
    } catch {
      throw new Error(`UI 驱动 ${command} 输出无法解析：${lastLine.slice(0, 300)}`)
    }
    if (parsed?.ok === false && parsed.error) log.debug?.(`UI 驱动 ${command} 失败：${parsed.error}`)
    return parsed
  }

  return {
    powershell,
    scriptPath,
    call,
    /** 系统键鼠空闲毫秒数 —— "主人是否在休息"的判据。 */
    idle: async (o) => (await call('idle', {}, o)).idleMs,
    listWindows: async (o = {}) => (await call('list-windows', { visibleOnly: o.visibleOnly !== false }, o)).windows ?? [],
    window: async (hwnd, o) => (await call('window', { hwnd }, o)).window,
    foreground: async (o) => (await call('foreground', {}, o)).window,
    focus: async (hwnd, o) => {
      const res = await call('focus', { hwnd }, o)
      return { ok: Boolean(res.focused), foreground: res.foreground, target: res.target, raw: res }
    },
    click: (x, y, o = {}) => call('click', { x, y, double: o.double }, o),
    type: (text, o) => call('type', { text }, o),
    key: (vk, mods = {}, o) => call('key', { vk, ...mods }, o),
    readClipboard: async (o) => (await call('read-clipboard', {}, o)).text ?? '',
    writeClipboard: async (text, o) => (await call('write-clipboard', { text }, o)).ok !== false,
    paste: (text, o = {}) => call('paste', { text, restore: o.restore, restoreText: o.restoreText }, o),
    uiaElements: async (hwnd, o = {}) => (await call('uia-elements', { hwnd, ...o }, o)).elements ?? [],
    uiaFocus: (hwnd, o = {}) => call('uia-focus-element', { hwnd, ...o }, o),
    whoamiWindow: (o) => call('whoami-window', {}, o),

    // ---- 截图与 OCR（Windows 自带 Windows.Media.Ocr，零依赖）----
    // 定位：**辅助**通道。截图的"位置信息"有用（哪里是输入框/按钮），
    // 但 OCR 的**文本保真度**在真实中文界面上很差（实测见 docs/OCR.md），
    // 所以读对话内容仍然优先用磁盘会话与剪贴板。
    /** 截取窗口（不抢焦点）。Chromium/Electron 必须用 flag=2，驱动会自动处理并检测黑屏。 */
    capture: (hwnd, o = {}) => call('capture', { hwnd, dir: o.dir, ...o }, { timeoutMs: o.timeoutMs ?? 30000, signal: o.signal }),
    /** 对图片做 OCR（给 file）或"截图并识别"（给 hwnd）。返回每行文本 + 每个词的精确矩形。 */
    ocr: (o = {}) => call('ocr', { file: o.file, hwnd: o.hwnd, dir: o.dir, lang: o.lang }, { timeoutMs: o.timeoutMs ?? 60000, signal: o.signal }),
    /** 这台机器可用的 OCR 语言，以及默认/中文引擎能否建立。 */
    ocrLanguages: (o) => call('ocr-languages', {}, o),
    sleep,
  }
}

/**
 * 按 `windowMatch` 找目标窗口。
 * @param {ReturnType<typeof createWindowsDriver>} driver
 * @param {{process?:string, title?:string, hwnd?:number, class?:string, matchAll?:boolean}} match
 * @returns {Promise<any|null>}
 */
export async function findWindow(driver, match = {}, callOpts = {}) {
  if (!match || Object.keys(match).length === 0) return null
  if (match.hwnd) {
    const win = await driver.window(match.hwnd, callOpts)
    return win ?? null
  }
  const windows = await driver.listWindows({}, callOpts)
  const tests = []
  if (match.process) tests.push(w => regex(match.process).test(w.process ?? ''))
  if (match.title) tests.push(w => regex(match.title).test(w.title ?? ''))
  if (match.class) tests.push(w => regex(match.class).test(w.class ?? ''))
  if (!tests.length) return null
  const predicate = match.matchAll === false
    ? (w) => tests.some(t => t(w))
    : (w) => tests.every(t => t(w))
  return windows.find(predicate) ?? null
}

function regex(value) {
  if (value instanceof RegExp) return value
  return new RegExp(String(value), 'i')
}

/** 描述当前桌面上的窗口（cw doctor / 报错提示用）。 */
export async function describeWindows(driver, limit = 25) {
  const windows = await driver.listWindows()
  return windows
    .filter(w => (w.title ?? '').trim().length > 0)
    .slice(0, limit)
    .map(w => `0x${Number(w.hwnd).toString(16)} ${String(w.process).padEnd(18)} ${String(w.title).slice(0, 60)}`)
}

/**
 * macOS 拟人驱动（`osascript` / System Events）。
 *
 * 和 Windows 版一样，"驱动"是一组一次性子进程调用：每次按键盘、点一下鼠标、读一次剪贴板
 * 都是起一个 `osascript`。对"每隔几十秒抽一鞭"的场景完全够用，而且零依赖。
 *
 * 两个 macOS 特有的现实：
 *  - **必须给终端/Node 开"辅助功能"权限**（系统设置 → 隐私与安全性 → 辅助功能），
 *    否则 System Events 会抛 `not allowed assistive access`；
 *  - **窗口句柄用进程 id（pid）**：System Events 层面按应用抢焦点最稳，同一应用多窗口时
 *    取第一个（`options.windowMatch.title` 可以进一步筛）。
 *
 * 打中文默认也走**剪贴板粘贴**（`keystroke` 对非 ASCII 支持差），与 Windows 行为一致。
 *
 * @module cyber-overseer/ui/darwin
 */

import { readFileSync } from 'node:fs'
import { createLogger } from '../util/log.mjs'
import { run, which } from '../util/proc.mjs'
import { osaKeyScript, osaKeystrokeScript, osaEscape } from './driver.mjs'

/** 一次拿全所有可见窗口（pid / 应用名 / 窗口名 / 位置 / 尺寸）。 */
const LIST_WINDOWS_SCRIPT = [
  'set out to ""',
  'tell application "System Events"',
  '  repeat with p in (every process whose background only is false)',
  '    try',
  '      set pid to unix id of p',
  '      set appName to name of p',
  '      repeat with w in (every window of p)',
  '        set wp to position of w',
  '        set ws to size of w',
  '        set out to out & pid & tab & appName & tab & (name of w) & tab & (item 1 of wp) & "," & (item 2 of wp) & tab & (item 1 of ws) & "," & (item 2 of ws) & linefeed',
  '      end repeat',
  '    end try',
  '  end repeat',
  'end tell',
  'return out',
].join('\n')

/** `ioreg` 里的 HIDIdleTime 是**纳秒**。 */
export function parseHidIdleMs(stdout) {
  const text = String(stdout ?? '')
  const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(text) ?? /HIDIdleTime\s*=\s*(\d+)/.exec(text)
  if (!match) return -1
  return Math.round(Number(match[1]) / 1e6)
}

/** `{10, 20}` 或 `10,20` → `[10, 20]`。 */
export function parseApplePair(value) {
  const match = /(-?\d+)\s*,\s*(-?\d+)/.exec(String(value ?? ''))
  if (!match) return null
  return [Number(match[1]), Number(match[2])]
}

/**
 * 解析窗口列表（制表符分隔的一行一个窗口）。
 * 字段：pid、应用名、窗口标题、位置、尺寸。
 */
export function parseDarwinWindowLines(stdout, limit = 60) {
  const windows = []
  for (const line of String(stdout ?? '').split('\n')) {
    if (!line.trim()) continue
    const [pidRaw, appName, title, position, size] = line.split('\t')
    const pid = Number(pidRaw)
    if (!Number.isFinite(pid)) continue
    const pos = parseApplePair(position) ?? [0, 0]
    const dim = parseApplePair(size) ?? [0, 0]
    const [left, top] = pos
    const [width, height] = dim
    windows.push({
      hwnd: pid,
      pid,
      process: (appName ?? '').trim(),
      title: (title ?? '').trim(),
      class: null,
      x: left,
      y: top,
      width,
      height,
      rect: [left, top, left + width, top + height],
    })
    if (windows.length >= limit) break
  }
  return windows
}

/** 解析 `get {unix id, name} of first process whose frontmost is true` 的输出（`123, Safari`）。 */
export function parseDarwinForeground(stdout) {
  const match = /(\d+)\s*,\s*(.*)/.exec(String(stdout ?? '').trim())
  if (!match) return null
  return { hwnd: Number(match[1]), pid: Number(match[1]), process: match[2].trim(), title: null }
}

/** 辅助功能权限的错误文案（用于 probe 给出可操作的提示）。 */
export function isAccessibilityError(text) {
  return /assistive access|not allowed|1002|-25211/i.test(String(text ?? ''))
}

/** macOS 上"全选/复制/粘贴"是 Command 而不是 Ctrl；拟人通道内部统一按 Ctrl 发，这里做翻译。 */
const MAC_CTRL_TO_CMD = new Set([0x41, 0x43, 0x56, 0x58, 0x5A, 0x46, 0x54]) // A C V X Z F T
export function effectiveMods(vk, mods = {}) {
  if (mods.ctrl && !mods.meta && MAC_CTRL_TO_CMD.has(Number(vk))) {
    return { ...mods, ctrl: false, meta: true }
  }
  return mods
}

/**
 * 创建 macOS 驱动。
 * @param {{log?:any, runFn?:typeof run, osascript?:string, timeoutMs?:number, maxWindows?:number}} [opts]
 */
export function createDarwinDriver(opts = {}) {
  const log = opts.log ?? createLogger({ level: 'warn' })
  const runFn = opts.runFn ?? run
  const osascript = opts.osascript ?? which('osascript') ?? 'osascript'
  const defaultTimeout = opts.timeoutMs ?? 20000
  const maxWindows = opts.maxWindows ?? 60

  async function osa(script, callOpts = {}) {
    return runFn(osascript, ['-e', script], {
      timeoutMs: callOpts.timeoutMs ?? defaultTimeout,
      signal: callOpts.signal,
    })
  }

  async function listWindows(callOpts = {}) {
    const result = await osa(LIST_WINDOWS_SCRIPT, callOpts)
    if (result.code !== 0) {
      if (isAccessibilityError(`${result.stdout}\n${result.stderr}`)) {
        throw new Error('macOS 拒绝了辅助功能访问：请到「系统设置 → 隐私与安全性 → 辅助功能」里勾选你的终端/Node')
      }
      throw new Error(`列窗口失败：${String(result.stderr || result.stdout).trim().slice(0, 300)}`)
    }
    return parseDarwinWindowLines(result.stdout, maxWindows)
  }

  async function windowOf(hwnd, callOpts = {}) {
    const windows = await listWindows(callOpts)
    return windows.find(w => String(w.hwnd) === String(hwnd)) ?? null
  }

  async function foreground(callOpts = {}) {
    const result = await osa('tell application "System Events" to get {unix id, name} of first process whose frontmost is true', callOpts)
    if (result.code !== 0) return null
    return parseDarwinForeground(result.stdout)
  }

  return {
    platform: 'darwin',
    supported: true,
    osascript,
    call: osa,

    async idle(callOpts = {}) {
      const result = await runFn('ioreg', ['-c', 'IOHIDSystem', '-d', '4'], {
        timeoutMs: callOpts.timeoutMs ?? 8000,
        signal: callOpts.signal,
      })
      return parseHidIdleMs(result.stdout)
    },

    listWindows,
    window: windowOf,
    foreground,

    async focus(hwnd, callOpts = {}) {
      const target = await windowOf(hwnd, callOpts)
      const result = await osa(`tell application "System Events" to set frontmost of (first process whose unix id is ${Number(hwnd)}) to true`, callOpts)
      if (result.code !== 0) {
        return { ok: false, foreground: await foreground(callOpts), target, raw: result }
      }
      const front = await foreground(callOpts)
      return { ok: String(front?.hwnd ?? '') === String(hwnd), foreground: front, target, raw: result }
    },

    async click(x, y, callOpts = {}) {
      const result = await osa(`tell application "System Events" to click at {${Math.round(x)}, ${Math.round(y)}}`, callOpts)
      return { ok: result.code === 0, detail: result.stderr?.trim() || undefined }
    },

    async type(text, callOpts = {}) {
      const result = await osa(osaKeystrokeScript(text), callOpts)
      return { ok: result.code === 0, detail: result.stderr?.trim() || undefined }
    },

    async key(vk, mods = {}, callOpts = {}) {
      const script = osaKeyScript(vk, effectiveMods(vk, mods))
      if (!script) return { ok: false, detail: `没有为虚拟键码 ${vk} 准备 macOS key code` }
      const result = await osa(script, callOpts)
      return { ok: result.code === 0, detail: result.stderr?.trim() || undefined }
    },

    async readClipboard(callOpts = {}) {
      const result = await runFn('pbpaste', [], { timeoutMs: callOpts.timeoutMs ?? 8000, signal: callOpts.signal })
      return result.code === 0 ? result.stdout : ''
    },

    async writeClipboard(text, callOpts = {}) {
      const result = await runFn('pbcopy', [], {
        timeoutMs: callOpts.timeoutMs ?? 8000,
        signal: callOpts.signal,
        input: String(text ?? ''),
      })
      return result.code === 0
    },

    // —— 未实现的（拟人通道靠坐标点击兜底；OCR 相关能力仅 Windows 提供）——
    async uiaElements() { return [] },
    async uiaFocus() { return { ok: false, error: 'macOS 驱动没有实现 UI 元素树，请用 agent.options.composer 指定输入框坐标' } },
    async ocrLanguages() { return [] },
    async capture() { return { ok: false, error: '截图/OCR 目前仅 Windows 驱动实现' } },
    async ocr() { return { ok: false, lines: [], error: '截图/OCR 目前仅 Windows 驱动实现' } },

    /** probe 用：检查 osascript 与辅助功能权限。 */
    async check() {
      const result = await osa('tell application "System Events" to get name of first process whose frontmost is true')
      if (result.code === 0) return { ok: true, detail: `osascript 可用（前台应用：${result.stdout.trim()}）` }
      const text = `${result.stdout}\n${result.stderr}`
      if (isAccessibilityError(text)) {
        return { ok: false, reason: '缺少辅助功能权限', hints: ['系统设置 → 隐私与安全性 → 辅助功能 → 勾选终端/Node'] }
      }
      return { ok: false, reason: text.trim().slice(0, 200) || 'osascript 调用失败' }
    },
  }
}

/** 读一个 pid 的进程名（Linux/macOS 通用，mac 上主要用于补充信息）。 */
export function processNameOf(pid) {
  try { return readFileSync(`/proc/${pid}/comm`, 'utf8').trim() } catch { return null }
}

/** 把 AppleScript 里的文本转义暴露出去，便于外部（脚本/测试）复用。 */
export { osaEscape }

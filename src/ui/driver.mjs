/**
 * 拟人通道的"跨平台驱动"共享层。
 *
 * 三个平台（Windows / macOS / Linux）各自用系统自带的东西实现同一套接口：
 *
 *   | 能力      | Windows            | macOS                    | Linux                |
 *   | --------- | ------------------ | ------------------------ | -------------------- |
 *   | 列窗口    | UIAutomation       | System Events            | xdotool              |
 *   | 抢焦点    | SetForegroundWindow| set frontmost            | windowactivate       |
 *   | 打字      | 剪贴板 + Ctrl+V    | keystroke / 剪贴板       | 剪贴板 + Ctrl+V      |
 *   | 剪贴板    | WinForms           | pbcopy / pbpaste         | xclip / xsel / wl-*  |
 *   | 键鼠空闲  | GetLastInputInfo   | ioreg HIDIdleTime        | xprintidle           |
 *   | UI 元素树 | UIAutomation       | 未实现（用坐标兜底）      | 未实现（用坐标兜底）  |
 *
 * 这里只放**与平台无关**的部分：窗口匹配、描述、以及键码映射。
 * 各平台的实现见 `windows.mjs` / `darwin.mjs` / `linux.mjs`，统一从 `index.mjs` 取。
 *
 * @module cyber-overseer/ui/driver
 */

/** 统一的窗口描述：`hwnd` 是平台内的窗口句柄（Windows/X11 是窗口 id，macOS 是进程 id）。 */

/** 把配置里的 `windowMatch` 编译成判定函数。 */
export function windowPredicate(match = {}) {
  const tests = []
  if (match.process) tests.push(w => regex(match.process).test(String(w.process ?? '')))
  if (match.title) tests.push(w => regex(match.title).test(String(w.title ?? '')))
  if (match.class) tests.push(w => regex(match.class).test(String(w.class ?? '')))
  if (!tests.length) return null
  return match.matchAll === false ? (w) => tests.some(t => t(w)) : (w) => tests.every(t => t(w))
}

/**
 * 按 `windowMatch` 找目标窗口。
 * @param {any} driver
 * @param {{process?:string, title?:string, hwnd?:number|string, class?:string, matchAll?:boolean}} match
 * @returns {Promise<any|null>}
 */
export async function findWindow(driver, match = {}, callOpts = {}) {
  if (!match || Object.keys(match).length === 0) return null
  if (match.hwnd) {
    const win = await driver.window(match.hwnd, callOpts)
    return win ?? null
  }
  const predicate = windowPredicate(match)
  if (!predicate) return null
  const windows = await driver.listWindows({}, callOpts)
  return windows.find(predicate) ?? null
}

/** 描述当前桌面上的窗口（`cw windows` / 报错提示用）。 */
export async function describeWindows(driver, limit = 25) {
  const windows = await driver.listWindows()
  return windows
    .filter(w => String(w.title ?? '').trim().length > 0)
    .slice(0, limit)
    .map(w => `${String(w.hwnd).padEnd(10)} ${String(w.process ?? '?').padEnd(20)} ${String(w.title).slice(0, 60)}`)
}

function regex(value) {
  if (value instanceof RegExp) return value
  return new RegExp(String(value), 'i')
}

/** Windows 虚拟键码 → Linux keysym 名字（拟人通道只用得上这几个）。 */
export const LINUX_KEY_NAMES = {
  0x08: 'BackSpace',
  0x09: 'Tab',
  0x0D: 'Return',
  0x1B: 'Escape',
  0x2E: 'Delete',
  0x41: 'a', 0x43: 'c', 0x56: 'v', 0x58: 'x',
  0x25: 'Left', 0x26: 'Up', 0x27: 'Right', 0x28: 'Down',
}

/** 把虚拟键码翻成 xdotool 的按键名（未知则按"字母/数字"猜测，再不行返回 null）。 */
export function vkToLinuxKey(vk) {
  const code = Number(vk)
  if (LINUX_KEY_NAMES[code]) return LINUX_KEY_NAMES[code]
  if (code >= 0x30 && code <= 0x39) return String.fromCharCode(code)      // 0-9
  if (code >= 0x60 && code <= 0x7A) return String.fromCharCode(code)      // 小键盘字母（含 a-z 区段）
  if (code >= 0x41 && code <= 0x5A) return String.fromCharCode(code + 32) // A-Z → a-z
  return null
}

/** 修饰键 → xdotool 前缀。 */
export function linuxKeyChord(vk, mods = {}) {
  const key = vkToLinuxKey(vk)
  if (!key) return null
  const parts = []
  if (mods.ctrl) parts.push('ctrl')
  if (mods.shift) parts.push('shift')
  if (mods.alt) parts.push('alt')
  if (mods.meta) parts.push('super')
  return [...parts, key].join('+')
}

/** macOS 的 key code（虚拟键码 → Carbon key code）。 */
export const MAC_KEY_CODES = {
  0x08: 51, // Delete（Backspace）
  0x09: 48, // Tab
  0x0D: 36, // Return
  0x1B: 53, // Escape
  0x2E: 117, // Forward Delete
  0x41: 0, 0x43: 8, 0x56: 9, 0x58: 7,
  0x25: 123, 0x26: 126, 0x27: 124, 0x28: 125,
}

/** 修饰键 → AppleScript 的 `using {…}` 列表。 */
export function macModifierList(mods = {}) {
  const parts = []
  if (mods.ctrl) parts.push('control down')
  if (mods.shift) parts.push('shift down')
  if (mods.alt) parts.push('option down')
  if (mods.meta) parts.push('command down')
  return parts
}

/** AppleScript 字符串字面量转义（`"` 和 `\` 两个字符就够，AppleScript 没有更多转义）。 */
export function osaEscape(text) {
  return String(text ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * 生成"把按键送到前台应用"的 AppleScript。
 * @param {number} vk 虚拟键码
 * @param {{ctrl?:boolean, shift?:boolean, alt?:boolean, meta?:boolean}} mods
 * @returns {string|null}
 */
export function osaKeyScript(vk, mods = {}) {
  const code = MAC_KEY_CODES[Number(vk)]
  if (code === undefined) return null
  const using = macModifierList(mods)
  return `tell application "System Events" to key code ${code}${using.length ? ` using {${using.join(', ')}}` : ''}`
}

/**
 * 生成"逐字敲入文本"的 AppleScript（keystroke 对中文/emoji 支持不好，
 * 所以拟人通道默认走剪贴板粘贴，这里只是 `inputMode:'type'` 的兜底）。
 */
export function osaKeystrokeScript(text) {
  return `tell application "System Events" to keystroke "${osaEscape(text)}"`
}

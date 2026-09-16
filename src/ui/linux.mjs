/**
 * Linux 拟人驱动（`xdotool` + 剪贴板工具）。
 *
 * X11 下 `xdotool` 是事实标准：列窗口、抢焦点、发按键、点鼠标都能做，且几乎所有发行版
 * 仓库里都有（`apt install xdotool`）。剪贴板按可用性挑一个：`xclip` / `xsel`，或者
 * Wayland 的 `wl-copy` / `wl-paste`。
 *
 * **诚实说明**：
 *  - **Wayland 下 xdotool 基本不可用**（它看不到别的应用窗口）。要么在 XWayland 里跑 agent，
 *    要么换 `ydotool`（需要 root 起 daemon）。probe 会直接告诉你当前是不是这种情况；
 *  - **键鼠空闲时间**依赖 `xprintidle`；没有它就返回 -1（= 未知），此时 `requireHumanIdleMs > 0`
 *    会让拟人通道**一直等到超时也不动手**（宁可不动，也不在主人用电脑时抢焦点）；
 *  - 没有跨应用 UI 元素树（AX），所以读对话框靠剪贴板、输入框靠坐标，和 Windows 的兜底路径一致。
 *
 * @module cyber-overseer/ui/linux
 */

import { readFileSync } from 'node:fs'
import { createLogger } from '../util/log.mjs'
import { run, which } from '../util/proc.mjs'
import { linuxKeyChord } from './driver.mjs'

/** `xdotool search` 的输出：一行一个窗口 id。 */
export function parseIdList(stdout) {
  return String(stdout ?? '')
    .split('\n')
    .map(line => Number(line.trim()))
    .filter(n => Number.isFinite(n) && n > 0)
}

/** `xdotool getwindowgeometry --shell` 的 KEY=VALUE 输出。 */
export function parseGeometry(stdout) {
  const out = {}
  for (const line of String(stdout ?? '').split('\n')) {
    const match = /^([A-Z]+)=(-?\d+)$/.exec(line.trim())
    if (match) out[match[1]] = Number(match[2])
  }
  if (!Number.isFinite(out.WIDTH) || !Number.isFinite(out.HEIGHT)) return null
  return {
    x: out.X ?? 0,
    y: out.Y ?? 0,
    width: out.WIDTH,
    height: out.HEIGHT,
    rect: [out.X ?? 0, out.Y ?? 0, (out.X ?? 0) + out.WIDTH, (out.Y ?? 0) + out.HEIGHT],
  }
}

/** `xdotool getactivewindow` / `getwindowpid` 的输出（单个数字）。 */
export function parseSingleId(stdout) {
  const value = Number(String(stdout ?? '').trim().split('\n')[0])
  return Number.isFinite(value) && value > 0 ? value : null
}

/** `xdotool mousemove --sync x y click 1`（双击时 repeat 2）。 */
export function buildClickArgs(x, y, opts = {}) {
  const args = ['mousemove', '--sync', String(Math.round(x)), String(Math.round(y))]
  if (opts.double) args.push('click', '--repeat', '2', '--delay', '120', '1')
  else args.push('click', '1')
  return args
}

/**
 * 剪贴板工具选择（xclip → xsel → Wayland 的 wl-*）。
 * @param {(name:string)=>string|null} lookup 一般是 `which`
 * @returns {{read:{file:string,args:string[]}, write:{file:string,args:string[]}, name:string}|null}
 */
export function pickClipboardTool(lookup = which) {
  if (lookup('xclip')) {
    return {
      name: 'xclip',
      read: { file: 'xclip', args: ['-selection', 'clipboard', '-o'] },
      write: { file: 'xclip', args: ['-selection', 'clipboard', '-i'] },
    }
  }
  if (lookup('xsel')) {
    return {
      name: 'xsel',
      read: { file: 'xsel', args: ['-b'] },
      write: { file: 'xsel', args: ['-b', '-i'] },
    }
  }
  if (lookup('wl-paste') && lookup('wl-copy')) {
    return {
      name: 'wl-clipboard',
      read: { file: 'wl-paste', args: ['--no-newline'] },
      write: { file: 'wl-copy', args: [] },
    }
  }
  return null
}

/** 是不是 Wayland 会话（xdotool 基本不可用）。 */
export function isWayland(env = process.env) {
  return String(env.XDG_SESSION_TYPE ?? '').toLowerCase() === 'wayland' || Boolean(env.WAYLAND_DISPLAY)
}

/**
 * 创建 Linux 驱动。
 * @param {{log?:any, runFn?:typeof run, xdotool?:string, lookup?:typeof which, timeoutMs?:number,
 *   maxWindows?:number, env?:Record<string,string|undefined>}} [opts]
 */
export function createLinuxDriver(opts = {}) {
  const log = opts.log ?? createLogger({ level: 'warn' })
  const runFn = opts.runFn ?? run
  const lookup = opts.lookup ?? which
  const env = opts.env ?? process.env
  const xdotool = opts.xdotool ?? lookup('xdotool')
  const clipboard = opts.clipboard ?? pickClipboardTool(lookup)
  const defaultTimeout = opts.timeoutMs ?? 20000
  const maxWindows = opts.maxWindows ?? 40
  const supported = Boolean(xdotool) && !isWayland(env)

  async function xdo(args, callOpts = {}, extra = {}) {
    return runFn(xdotool ?? 'xdotool', args, {
      timeoutMs: callOpts.timeoutMs ?? defaultTimeout,
      signal: callOpts.signal,
      ...extra,
    })
  }

  async function windowOf(hwnd, callOpts = {}) {
    const id = String(hwnd)
    const [name, geomOut, pidOut] = await Promise.all([
      xdo(['getwindowname', id], callOpts),
      xdo(['getwindowgeometry', '--shell', id], callOpts),
      xdo(['getwindowpid', id], callOpts),
    ])
    const geometry = parseGeometry(geomOut.stdout)
    const pid = parseSingleId(pidOut.stdout)
    if (!geometry) return null
    return {
      hwnd: Number(id),
      pid,
      process: pid ? processNameOf(pid) : null,
      title: name.code === 0 ? name.stdout.trim() : '',
      class: null,
      x: geometry.x,
      y: geometry.y,
      width: geometry.width,
      height: geometry.height,
      rect: geometry.rect,
    }
  }

  async function listWindows(callOpts = {}) {
    // `--onlyvisible` 优先；某些 WM 下拿不到就退回全部，再靠标题筛
    let ids = parseIdList((await xdo(['search', '--onlyvisible', '--name', '.*'], callOpts)).stdout)
    if (!ids.length) ids = parseIdList((await xdo(['search', '--name', '.*'], callOpts)).stdout)
    const windows = await Promise.all(ids.slice(0, maxWindows).map(id => windowOf(id, callOpts)))
    return windows.filter(Boolean)
  }

  async function foreground(callOpts = {}) {
    const active = parseSingleId((await xdo(['getactivewindow'], callOpts)).stdout)
    if (!active) return null
    return windowOf(active, callOpts)
  }

  async function readClipboard(callOpts = {}) {
    if (!clipboard) return ''
    const result = await runFn(clipboard.read.file, clipboard.read.args, {
      timeoutMs: callOpts.timeoutMs ?? 8000,
      signal: callOpts.signal,
    })
    return result.code === 0 ? result.stdout : ''
  }

  return {
    platform: 'linux',
    supported,
    xdotool,
    clipboardTool: clipboard?.name ?? null,

    async idle(callOpts = {}) {
      if (!lookup('xprintidle')) return -1 // 未知：拟人通道会因此拒绝动手（安全默认）
      const result = await runFn('xprintidle', [], { timeoutMs: callOpts.timeoutMs ?? 8000, signal: callOpts.signal })
      const value = Number(String(result.stdout).trim())
      return Number.isFinite(value) ? value : -1
    },

    listWindows,
    window: windowOf,
    foreground,

    async focus(hwnd, callOpts = {}) {
      const target = await windowOf(hwnd, callOpts)
      const result = await xdo(['windowactivate', '--sync', String(hwnd)], callOpts)
      if (result.code !== 0) return { ok: false, foreground: await foreground(callOpts), target, raw: result }
      const front = await foreground(callOpts)
      return { ok: Number(front?.hwnd) === Number(hwnd), foreground: front, target, raw: result }
    },

    click: async (x, y, callOpts = {}) => {
      const result = await xdo(buildClickArgs(x, y, callOpts), callOpts)
      return { ok: result.code === 0, detail: result.stderr?.trim() || undefined }
    },

    async type(text, callOpts = {}) {
      // `--` 结束选项解析：鞭子文本以 `-` 开头也不会被当成参数
      const result = await xdo(['type', '--clearmodifiers', '--delay', '12', '--', String(text ?? '')], callOpts)
      return { ok: result.code === 0, detail: result.stderr?.trim() || undefined }
    },

    async key(vk, mods = {}, callOpts = {}) {
      const chord = linuxKeyChord(vk, mods)
      if (!chord) return { ok: false, detail: `没有为虚拟键码 ${vk} 准备 Linux keysym` }
      const result = await xdo(['key', '--clearmodifiers', chord], callOpts)
      return { ok: result.code === 0, detail: result.stderr?.trim() || undefined }
    },

    readClipboard,

    async writeClipboard(text, callOpts = {}) {
      if (!clipboard) return false
      const result = await runFn(clipboard.write.file, clipboard.write.args, {
        timeoutMs: callOpts.timeoutMs ?? 8000,
        signal: callOpts.signal,
        input: String(text ?? ''),
      })
      return result.code === 0
    },

    async uiaElements() { return [] },
    async uiaFocus() { return { ok: false, error: 'Linux 驱动没有实现 UI 元素树，请用 agent.options.composer 指定输入框坐标' } },
    async ocrLanguages() { return [] },
    async capture() { return { ok: false, error: '截图/OCR 目前仅 Windows 驱动实现' } },
    async ocr() { return { ok: false, lines: [], error: '截图/OCR 目前仅 Windows 驱动实现' } },

    /** probe 用：xdotool / DISPLAY / 剪贴板工具是否齐。 */
    async check() {
      if (isWayland(env)) {
        return {
          ok: false,
          reason: '当前是 Wayland 会话，xdotool 看不到其它应用的窗口',
          hints: ['在 XWayland 下跑 agent（设置 XDG_SESSION_TYPE=x11 或登录 X11 会话）', '或改装 ydotool（需要 daemon 权限）'],
        }
      }
      if (!xdotool) {
        return { ok: false, reason: '找不到 xdotool', hints: ['apt install xdotool（或 dnf/pacman 对应包）'] }
      }
      if (!clipboard) {
        return { ok: false, reason: '找不到剪贴板工具（xclip / xsel / wl-clipboard）', hints: ['apt install xclip'] }
      }
      const idle = lookup('xprintidle')
      return {
        ok: true,
        detail: `xdotool + ${clipboard.name}${idle ? ' + xprintidle' : ''}`,
        hints: idle ? [] : ['没有 xprintidle：读不到键鼠空闲时间，requireHumanIdleMs > 0 时不会动手（安全但保守）'],
      }
    },
  }
}

/** 读 `/proc/<pid>/comm`（Linux 下拿进程名）。 */
export function processNameOf(pid) {
  try { return readFileSync(`/proc/${pid}/comm`, 'utf8').trim() } catch { return null }
}

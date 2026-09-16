/**
 * 拟人通道的驱动入口：按平台挑一个实现。
 *
 * 三个驱动（windows / darwin / linux）实现同一套接口（见 `driver.mjs` 的说明），
 * 所以 `human-sim` 适配器只跟这里打交道，不关心脚下是什么系统。
 *
 * @module cyber-overseer/ui/index
 */

import { existsSync } from 'node:fs'
import { which } from '../util/proc.mjs'
import { isWindows } from '../util/platform.mjs'
import { findWindow, describeWindows } from './driver.mjs'
import { createWindowsDriver } from './windows.mjs'
import { createDarwinDriver } from './darwin.mjs'
import { createLinuxDriver } from './linux.mjs'

export { findWindow, describeWindows }

/** 一个"什么都不能做"的驱动，保证接口存在（probe 会据此给出提示）。 */
export function createNullDriver(platform, reason) {
  const fail = async () => ({ ok: false, detail: reason })
  return {
    platform,
    supported: false,
    reason,
    idle: async () => -1,
    listWindows: async () => [],
    window: async () => null,
    foreground: async () => null,
    focus: fail,
    click: fail,
    type: fail,
    key: fail,
    readClipboard: async () => '',
    writeClipboard: async () => false,
    uiaElements: async () => [],
    uiaFocus: fail,
    ocrLanguages: async () => [],
    capture: fail,
    ocr: async () => ({ ok: false, lines: [] }),
    check: async () => ({ ok: false, reason }),
  }
}

/**
 * 按平台创建驱动。
 * @param {{platform?:string, log?:any, [key:string]:any}} [opts]
 */
export function createUiDriver(opts = {}) {
  const platform = opts.platform ?? process.platform
  if (platform === 'win32') return createWindowsDriver(opts)
  if (platform === 'darwin') return createDarwinDriver(opts)
  if (platform === 'linux') return createLinuxDriver(opts)
  return createNullDriver(platform, `拟人通道没有为 ${platform} 实现（目前有 Windows / macOS / Linux）`)
}

/**
 * "这台机器上拟人通道能不能用"的一句话结论（`cw doctor` / probe 用）。
 * @param {{platform?:string}} [opts]
 */
export async function uiPlatformInfo(opts = {}) {
  const platform = opts.platform ?? process.platform
  if (platform === 'win32') {
    const ok = isWindows() && existsSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    return { ok, label: 'Windows：UIAutomation + SendInput（含截图/OCR）', hints: ok ? [] : ['找不到 Windows PowerShell 5.1'] }
  }
  if (platform === 'darwin') {
    const ok = Boolean(which('osascript'))
    return {
      ok,
      label: 'macOS：osascript + System Events',
      hints: ok
        ? ['第一次使用需要在「系统设置 → 隐私与安全性 → 辅助功能」里给终端/Node 授权', '打中文默认走剪贴板粘贴']
        : ['找不到 osascript（正常情况下 macOS 自带）'],
    }
  }
  if (platform === 'linux') {
    const driver = createLinuxDriver({ ...opts, platform })
    const check = await driver.check()
    return { ok: check.ok, label: `Linux：xdotool${driver.clipboardTool ? ` + ${driver.clipboardTool}` : ''}`, hints: check.hints ?? [], reason: check.reason, detail: check.detail }
  }
  return { ok: false, label: `${platform}：拟人通道未实现`, hints: [] }
}

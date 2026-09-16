/**
 * 平台能力探测。
 *
 * 这个项目跨平台的程度不均匀，而且**必须诚实**：读会话文件的部分全平台通用，
 * 但"拟人通道"（抢焦点打字）依赖各平台自己的自动化设施：
 *
 *   | 平台    | 依赖                                  |
 *   | ------- | ------------------------------------- |
 *   | Windows | Windows PowerShell 5.1（UIA + SendInput） |
 *   | macOS   | osascript（System Events）             |
 *   | Linux   | xdotool（+ xclip/xsel 剪贴板）         |
 *
 * 与其在运行时神秘失败，不如在 `cw doctor` 里直说。
 *
 * @module cyber-overseer/util/platform
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { which } from './proc.mjs'

/** 是否 Windows。 */
export const isWindows = () => process.platform === 'win32'

/** 是否 macOS。 */
export const isMac = () => process.platform === 'darwin'

/** 是否 Linux。 */
export const isLinux = () => process.platform === 'linux'

/**
 * 拟人通道可用性（按平台）。
 * Windows 上必须是 **Windows PowerShell 5.1**（pwsh 7 没有完整的 UIA/WinForms 投影）。
 */
export function hasUiSupport() {
  if (isWindows()) {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
    return existsSync(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  }
  if (isMac()) return Boolean(which('osascript'))
  if (isLinux()) return Boolean(which('xdotool'))
  return false
}

/** 历史名字（doctor/CLI 早先叫它"触摸支持"）：等价于 hasUiSupport()。 */
export const hasTouchSupport = hasUiSupport

/** 拟人通道在本平台的实现名（给人看的）。 */
export function uiSupportLabel() {
  if (isWindows()) return hasUiSupport() ? '可用（Windows：UIA + SendInput）' : '不可用（缺少 Windows PowerShell 5.1）'
  if (isMac()) return hasUiSupport() ? '可用（macOS：osascript + System Events）' : '不可用（找不到 osascript）'
  if (isLinux()) return hasUiSupport() ? '可用（Linux：xdotool）' : '不可用（缺少 xdotool；Wayland 下还需要 XWayland）'
  return `不可用（${process.platform} 未实现）`
}

/** Node 版本是否满足核心能力（zstd / sqlite）。 */
export function nodeVersion() {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
  return { major, minor, ok: major > 22 || (major === 22 && minor >= 15) }
}

/** 一台机器上能做到什么，一句话总结（doctor 用）。 */
export function describeCapability() {
  const v = nodeVersion()
  const parts = [`Node ${process.versions.node}${v.ok ? '' : '（太旧，zstd/sqlite 可能缺失）'}`]
  parts.push(isWindows() ? 'Windows' : process.platform)
  parts.push(hasUiSupport() ? '拟人通道可用' : '拟人通道不可用')
  return parts.join('｜')
}

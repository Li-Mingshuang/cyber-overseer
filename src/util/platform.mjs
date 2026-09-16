/**
 * 平台能力探测。
 *
 * 这个项目跨平台的程度不均匀，而且**必须诚实**：读会话文件的部分全平台通用，
 * 但"拟人通道"（抢焦点打字）目前只有 Windows 实现（UIA + SendInput）。
 * 与其在运行时神秘失败，不如在 `cw doctor` 里直说。
 *
 * @module cyber-overseer/util/platform
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 是否 Windows。 */
export const isWindows = () => process.platform === 'win32'

/** 拟人通道可用性（Windows + 能找到 Windows PowerShell 5.1）。 */
export function hasTouchSupport() {
  if (!isWindows()) return false
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  return existsSync(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
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
  parts.push(hasTouchSupport() ? '拟人通道可用' : '拟人通道不可用')
  return parts.join('｜')
}

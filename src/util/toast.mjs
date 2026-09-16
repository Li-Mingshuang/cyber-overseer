/**
 * Windows 原生 toast 通知。
 *
 * 目前监工收工/卡住时只有"响铃 + webhook"——响铃在白天没人听得见，webhook 要配。
 * Windows 10/11 自带的 toast 才是主人早上醒来第一眼能看到的东西，而且**零依赖**：
 * 走 PowerShell 里的 WinRT（`Windows.UI.Notifications`），Windows PowerShell 5.1 就有。
 *
 * 两个刻意的设计：
 *  - **不拼字符串**：toast 的 XML 用 base64 传给 PowerShell，再由 `-EncodedCommand`
 *    （UTF-16LE + base64）传整段脚本。鞭子/报告里的引号、`$`、换行都不会变成命令注入；
 *  - **构造与执行分离**：`buildToastScript()` 是纯函数，单测可以直接解码校验；
 *    `sendToast()` 才真的起进程（非 Windows 或没有 PowerShell 时安静地跳过）。
 *
 * @module cyber-overseer/util/toast
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { run, which } from './proc.mjs'
import { isWindows } from './platform.mjs'

/** 默认 AUMID：Windows PowerShell 自己的 AppUserModelID（无需注册即可弹 toast）。 */
export const DEFAULT_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'

/** XML 文本转义（toast 内容是 XML，必须转义，否则 `&`/`<` 会让整条 toast 静默失败）。 */
export function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * 拼 toast 的 XML。
 * @param {{title?:string, text?:string, duration?:'short'|'long', silent?:boolean}} opts
 */
export function buildToastXml(opts = {}) {
  const title = xmlEscape(opts.title ?? '赛博监工')
  const body = xmlEscape(opts.text ?? '')
  const duration = opts.duration === 'long' ? ' duration="long"' : ''
  const audio = opts.silent ? '<audio silent="true"/>' : ''
  // 两行文本：标题加粗（第一行），正文折行
  return `<toast${duration}><visual><binding template="ToastGeneric">`
    + `<text>${title}</text><text>${body}</text>`
    + `</binding></visual>${audio}</toast>`
}

/**
 * 生成 PowerShell 脚本（纯函数）。
 *
 * 内容全部走 base64，脚本本身只含 ASCII —— 中文/引号/换行都不需要转义，
 * 也不可能因为通知文本而"变成"别的命令。
 * @param {{title?:string, text?:string, appId?:string, duration?:'short'|'long', silent?:boolean}} opts
 * @returns {string}
 */
export function buildToastScript(opts = {}) {
  const xml = buildToastXml(opts)
  const xmlB64 = Buffer.from(xml, 'utf8').toString('base64')
  const appId = String(opts.appId ?? DEFAULT_APP_ID)
  return [
    '$ErrorActionPreference = "Stop"',
    `$xmlText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${xmlB64}"))`,
    `$appId = "${appId.replace(/"/g, '')}"`,
    'try {',
    '  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    '  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument',
    '  $doc.LoadXml($xmlText)',
    '  $toast = New-Object Windows.UI.Notifications.ToastNotification $doc',
    '  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)',
    '  Write-Output "CW_TOAST_OK"',
    '} catch {',
    '  Write-Output ("CW_TOAST_FAIL " + $_.Exception.Message)',
    '  exit 1',
    '}',
  ].join('\n')
}

/** PowerShell 的 `-EncodedCommand` 需要 UTF-16LE 的 base64。 */
export function encodePowerShellCommand(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64')
}

/** 这台机器能不能弹 toast。 */
export function toastAvailable() {
  if (!isWindows()) return false
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  return Boolean(
    which('powershell')
    ?? (existsSync(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
      ? join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : null),
  )
}

/**
 * 通知配置里要不要发 toast。
 *
 * `'auto'`（默认）= Windows 上发、其它平台不发。
 * @param {any} notifyCfg
 * @param {{platform?:string, available?:boolean}} [ctx]
 */
export function toastEnabled(notifyCfg = {}, ctx = {}) {
  const platform = ctx.platform ?? process.platform
  const value = notifyCfg.toast ?? 'auto'
  if (value === false || value === null) return false
  if (value === true || (value && typeof value === 'object')) {
    const available = ctx.available ?? (platform === 'win32' ? toastAvailable() : false)
    return platform === 'win32' && available
  }
  if (value === 'auto') {
    const available = ctx.available ?? (platform === 'win32' ? toastAvailable() : false)
    return platform === 'win32' && available
  }
  return false
}

/**
 * 发一条 toast。
 * @param {{title?:string, text?:string, appId?:string, duration?:'short'|'long', silent?:boolean,
 *   log?:any, timeoutMs?:number, runFn?:typeof run}} opts
 * @returns {Promise<{ok:boolean, skipped?:boolean, detail?:string}>}
 */
export async function sendToast(opts = {}) {
  const runFn = opts.runFn ?? run
  const available = opts.available ?? toastAvailable()
  if (!available) return { ok: false, skipped: true, detail: '当前平台没有可用的 PowerShell toast 通道（仅 Windows）' }
  const script = buildToastScript(opts)
  const encoded = encodePowerShellCommand(script)
  const powershell = opts.powershell ?? which('powershell') ?? 'powershell.exe'
  const result = await runFn(powershell, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded,
  ], { timeoutMs: opts.timeoutMs ?? 20000 })
  const stdout = String(result.stdout ?? '')
  if (stdout.includes('CW_TOAST_OK')) return { ok: true, detail: 'toast 已发送' }
  const detail = stdout.trim() || String(result.stderr ?? '').trim() || `退出码 ${result.code}`
  opts.log?.debug?.(`toast 发送失败：${detail}`)
  return { ok: false, detail }
}

/**
 * 从通知文本里切出"标题 + 正文"：第一行当标题（已含 ✅/🛑 图标与停止原因），其余当正文。
 * @param {string} text
 * @param {{maxBody?:number}} [opts]
 */
export function splitNotification(text, opts = {}) {
  const lines = String(text ?? '').split('\n').map(l => l.trim()).filter(Boolean)
  const title = lines[0] ?? '赛博监工'
  const body = lines.slice(1).join(' / ').slice(0, opts.maxBody ?? 320)
  return { title: title.slice(0, 120), body }
}

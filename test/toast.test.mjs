/**
 * Windows 原生 toast 的纯函数与执行封装测试。
 *
 * 关键点：**测试绝不能在主人的桌面上弹通知**，所以真正的执行路径用注入的 runFn 覆盖，
 * 只验证"脚本构造正确、内容原样传过去、失败能说清原因"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_APP_ID, buildToastScript, buildToastXml, encodePowerShellCommand,
  sendToast, splitNotification, toastAvailable, toastEnabled, xmlEscape,
} from '../src/util/toast.mjs'

/** 从 PowerShell 脚本里把 base64 的 XML 解出来（模拟 PowerShell 侧的行为）。 */
function extractXmlFromScript(script) {
  const m = /FromBase64String\("([^"]+)"\)/.exec(script)
  assert.ok(m, '脚本里应该有 base64 的 XML')
  return Buffer.from(m[1], 'base64').toString('utf8')
}

test('xmlEscape：XML 元字符全部转义', () => {
  assert.equal(xmlEscape('a & b < c > d " e \' f'), 'a &amp; b &lt; c &gt; d &quot; e &apos; f')
  assert.equal(xmlEscape(null), '')
})

test('buildToastXml：两行文本 + duration/静音开关', () => {
  const xml = buildToastXml({ title: '收工了', text: '全部勾选 & 测试通过' })
  assert.match(xml, /^<toast>/)
  assert.match(xml, /<binding template="ToastGeneric">/)
  assert.match(xml, /<text>收工了<\/text>/)
  assert.match(xml, /<text>全部勾选 &amp; 测试通过<\/text>/)
  assert.match(xml, /<\/toast>$/)
  assert.ok(!xml.includes('duration='))

  const long = buildToastXml({ title: 't', text: 'b', duration: 'long', silent: true })
  assert.match(long, /^<toast duration="long">/)
  assert.match(long, /<audio silent="true"\/>/)
})

test('buildToastScript：用户文本不进脚本正文（防注入），但内容能被还原', () => {
  const nastyTitle = `'; Remove-Item -Recurse C:\\ ; '`
  const nastyText = 'body with "quotes" and $env:PATH and \n newline'
  const script = buildToastScript({ title: nastyTitle, text: nastyText })

  assert.ok(!script.includes('Remove-Item'), '通知文本不能出现在脚本正文里')
  assert.ok(!script.includes('$env:PATH'), '通知文本不能出现在脚本正文里')
  assert.match(script, /FromBase64String/)
  assert.match(script, /CreateToastNotifier/)
  assert.match(script, /CW_TOAST_OK/)
  assert.ok(/^[\x00-\x7F]*$/.test(script), '脚本正文应为纯 ASCII（内容都在 base64 里）')

  const xml = extractXmlFromScript(script)
  assert.ok(xml.includes('&apos;; Remove-Item -Recurse C:\\ ; &apos;'), '标题应被 XML 转义后原样保留')
  assert.ok(xml.includes('&quot;quotes&quot;'), '正文里的引号应被转义')
  assert.ok(script.includes(`$appId = "${DEFAULT_APP_ID}"`))
})

test('buildToastScript：appId 里的引号被去掉（不能逃逸出字符串）', () => {
  const script = buildToastScript({ title: 't', text: 'b', appId: 'My"App"' })
  assert.match(script, /^\$appId = "MyApp"$/m)
})

test('encodePowerShellCommand：UTF-16LE base64 往返', () => {
  const script = 'Write-Output "中文 ok"'
  const encoded = encodePowerShellCommand(script)
  assert.ok(/^[A-Za-z0-9+/=]+$/.test(encoded))
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), script)
})

test('toastEnabled：auto / true / false / 对象 / 非 Windows', () => {
  assert.equal(toastEnabled({}, { platform: 'win32', available: true }), true, 'auto 在 Windows 上开')
  assert.equal(toastEnabled({}, { platform: 'win32', available: false }), false)
  assert.equal(toastEnabled({}, { platform: 'linux', available: true }), false)
  assert.equal(toastEnabled({ toast: true }, { platform: 'win32', available: true }), true)
  assert.equal(toastEnabled({ toast: false }, { platform: 'win32', available: true }), false)
  assert.equal(toastEnabled({ toast: 'auto' }, { platform: 'darwin', available: true }), false)
  assert.equal(toastEnabled({ toast: { title: '自定义' } }, { platform: 'win32', available: true }), true)
  assert.equal(typeof toastAvailable(), 'boolean')
})

test('splitNotification：首行当标题，其余拼成正文（有长度上限）', () => {
  const text = '✅ 赛博监工：done\n方案：甲（勾选 3/3）\n轮次：4　花费：$0.0000'
  const { title, body } = splitNotification(text)
  assert.equal(title, '✅ 赛博监工：done')
  assert.match(body, /方案：甲/)
  assert.match(body, /轮次：4/)
  assert.ok(!body.includes('\n'))

  const long = splitNotification(`t\n${'x'.repeat(1000)}`, { maxBody: 20 })
  assert.equal(long.body.length, 20)
  assert.equal(splitNotification('').title, '赛博监工')
})

test('sendToast：成功 / 失败 / 跳过，三条路径都说清原因', async () => {
  let captured = null
  const okRun = async (file, args) => {
    captured = { file, args }
    return { code: 0, stdout: 'CW_TOAST_OK\n', stderr: '', timedOut: false, durationMs: 1, aborted: false }
  }
  const result = await sendToast({
    title: '收工了', text: '全部通过', available: true, powershell: 'pwsh', runFn: okRun,
  })
  assert.equal(result.ok, true)
  assert.equal(captured.file, 'pwsh')
  assert.ok(captured.args.includes('-EncodedCommand'))
  const encoded = captured.args[captured.args.indexOf('-EncodedCommand') + 1]
  const script = Buffer.from(encoded, 'base64').toString('utf16le')
  assert.ok(script.includes('CreateToastNotifier'), '传给 PowerShell 的是构造好的脚本')
  assert.ok(extractXmlFromScript(script).includes('收工了'), '标题应完整传到脚本里')

  const fail = await sendToast({
    title: 'x', text: 'y', available: true, powershell: 'pwsh',
    runFn: async () => ({ code: 1, stdout: 'CW_TOAST_FAIL 通知被系统关掉了', stderr: '', timedOut: false, durationMs: 1, aborted: false }),
  })
  assert.equal(fail.ok, false)
  assert.match(fail.detail, /通知被系统关掉了/)

  const emptyErr = await sendToast({
    title: 'x', text: 'y', available: true, powershell: 'pwsh',
    runFn: async () => ({ code: null, stdout: '', stderr: 'spawn EPERM', timedOut: false, durationMs: 1, aborted: false }),
  })
  assert.equal(emptyErr.ok, false)
  assert.match(emptyErr.detail, /spawn EPERM/)

  const skipped = await sendToast({ title: 'x', text: 'y', available: false })
  assert.equal(skipped.skipped, true)
  assert.equal(skipped.ok, false)
})

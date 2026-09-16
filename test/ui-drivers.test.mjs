/**
 * 拟人通道的跨平台驱动测试。
 *
 * 这台机器上只有 Windows，所以 macOS / Linux 的实现用**注入的假 runFn** 验证：
 * 命令怎么拼、输出怎么解析、接口是否齐全。这样即使手上没有 mac/Linux，
 * 代码路径也不是"看起来对"而已。
 *
 * 另外用假 UI 驱动离线跑一遍 human-sim 的读回与注入流程，
 * 专门钉死两件事：① 焦点被输入框抢走时能靠候选点读回对话；② **绝不破坏主人的草稿**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig, mergeConfig } from '../src/config.mjs'
import { createHumanSimAdapter, resolveReaderClickCandidates } from '../src/adapters/human-sim.mjs'
import {
  describeWindows, findWindow, linuxKeyChord, osaKeyScript, osaKeystrokeScript, vkToLinuxKey, windowPredicate,
} from '../src/ui/driver.mjs'
import {
  effectiveMods, isAccessibilityError, parseApplePair, parseDarwinForeground, parseDarwinWindowLines, parseHidIdleMs,
} from '../src/ui/darwin.mjs'
import {
  buildClickArgs, isWayland, parseGeometry, parseIdList, parseSingleId, pickClipboardTool,
} from '../src/ui/linux.mjs'
import { createUiDriver, uiPlatformInfo } from '../src/ui/index.mjs'
import { createLogger } from '../src/util/log.mjs'

const quiet = createLogger({ level: 'error', stream: { write() {} }, errStream: { write() {} } })
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '', timedOut: false, durationMs: 0, aborted: false })
const bad = (stderr = '') => ({ code: 1, stdout: '', stderr, timedOut: false, durationMs: 0, aborted: false })
const basename = (file) => String(file).replace(/^.*[\\/]/, '')

// ---------------------------------------------------------------------------
// 平台无关的窗口匹配
// ---------------------------------------------------------------------------

test('窗口匹配：process/title/class 与 matchAll 语义', async () => {
  const windows = [
    { hwnd: 1, process: 'Cursor', title: 'PLAN.md — Cursor', class: 'Chrome_WidgetWin_1' },
    { hwnd: 2, process: 'Codex', title: 'Codex' },
  ]
  const driver = { listWindows: async () => windows, window: async (id) => windows.find(w => w.hwnd === Number(id)) ?? null }

  assert.equal((await findWindow(driver, { process: 'cursor' }))?.hwnd, 1, 'process 匹配大小写不敏感')
  assert.equal((await findWindow(driver, { title: 'PLAN' }))?.hwnd, 1)
  assert.equal((await findWindow(driver, { process: 'nope' })), null)
  assert.equal(await findWindow(driver, {}), null, '没配 windowMatch 时不应该乱选窗口')
  assert.equal((await findWindow(driver, { process: 'Cursor', title: 'Codex' })), null, '默认要求全部条件成立')
  assert.equal((await findWindow(driver, { process: 'Cursor', title: 'Codex', matchAll: false }))?.hwnd, 1, 'matchAll:false = 任一成立')
  assert.equal((await findWindow(driver, { hwnd: 2 }))?.process, 'Codex', '直接给 hwnd 时不再按名字筛')
  assert.equal(windowPredicate({}), null)

  const described = await describeWindows(driver, 10)
  assert.equal(described.length, 2)
  assert.match(described[0], /Cursor/)
})

// ---------------------------------------------------------------------------
// macOS：纯解析与脚本构造
// ---------------------------------------------------------------------------

test('macOS 纯函数：idle 纳秒换算 / 坐标解析 / 窗口行解析 / 前台进程', () => {
  assert.equal(parseHidIdleMs('    "HIDIdleTime" = 5000000000\n'), 5000)
  assert.equal(parseHidIdleMs('nothing here'), -1)
  assert.deepEqual(parseApplePair('{10, 20}'), [10, 20])
  assert.deepEqual(parseApplePair('-5,-6'), [-5, -6])
  assert.equal(parseApplePair('abc'), null)

  const windows = parseDarwinWindowLines('123\tCursor\tPLAN.md — Cursor\t100,200\t800,600\n456\tSafari\tGitHub\t0,0\t1440,900\n')
  assert.equal(windows.length, 2)
  assert.deepEqual(windows[0], {
    hwnd: 123, pid: 123, process: 'Cursor', title: 'PLAN.md — Cursor', class: null,
    x: 100, y: 200, width: 800, height: 600, rect: [100, 200, 900, 800],
  })
  assert.equal(parseDarwinWindowLines('garbage line\n').length, 0)

  assert.deepEqual(parseDarwinForeground('123, Cursor\n'), { hwnd: 123, pid: 123, process: 'Cursor', title: null })
  assert.equal(parseDarwinForeground(''), null)
  assert.equal(isAccessibilityError('execution error: System Events got an error: osascript is not allowed assistive access. (-25211)'), true)
  assert.equal(isAccessibilityError('all good'), false)
})

test('macOS 按键：虚拟键码 → key code，Ctrl 组合自动翻成 Command', () => {
  assert.equal(osaKeyScript(0x0D), 'tell application "System Events" to key code 36')
  assert.match(osaKeyScript(0x41, { ctrl: true }), /key code 0 using \{control down\}/)
  assert.deepEqual(effectiveMods(0x41, { ctrl: true }), { ctrl: false, meta: true }, '全选必须是 Command+A')
  assert.deepEqual(effectiveMods(0x43, { ctrl: true }), { ctrl: false, meta: true }, '复制必须是 Command+C')
  assert.deepEqual(effectiveMods(0x56, { ctrl: true }), { ctrl: false, meta: true }, '粘贴必须是 Command+V')
  assert.deepEqual(effectiveMods(0x2E, {}), {}, 'Delete 不该被改写')
  assert.deepEqual(effectiveMods(0x0D, { shift: true }), { shift: true })
  assert.match(osaKeyScript(0x41, effectiveMods(0x41, { ctrl: true })), /command down/)
  assert.equal(osaKeyScript(0x99), null, '没准备的键码要明确返回 null')

  assert.equal(osaKeystrokeScript('say "hi"\\there'), 'tell application "System Events" to keystroke "say \\"hi\\"\\\\there"')
})

// ---------------------------------------------------------------------------
// Linux：纯解析与命令构造
// ---------------------------------------------------------------------------

test('Linux 纯函数：id 列表 / 几何 / 按键名 / 剪贴板工具选择', () => {
  assert.deepEqual(parseIdList('100\n200\n\nbogus\n'), [100, 200])
  assert.equal(parseSingleId('4242\n'), 4242)
  assert.equal(parseSingleId('nope'), null)

  const geometry = parseGeometry('WINDOW=100\nX=10\nY=20\nWIDTH=800\nHEIGHT=600\nSCREEN=0\n')
  assert.deepEqual(geometry, { x: 10, y: 20, width: 800, height: 600, rect: [10, 20, 810, 620] })
  assert.equal(parseGeometry('WINDOW=100\n'), null)

  assert.deepEqual(buildClickArgs(5, 6), ['mousemove', '--sync', '5', '6', 'click', '1'])
  assert.deepEqual(buildClickArgs(5.4, 6.6, { double: true }), ['mousemove', '--sync', '5', '7', 'click', '--repeat', '2', '--delay', '120', '1'])

  assert.equal(vkToLinuxKey(0x0D), 'Return')
  assert.equal(vkToLinuxKey(0x41), 'a')
  assert.equal(vkToLinuxKey(0x2E), 'Delete')
  assert.equal(vkToLinuxKey(0x99), null)
  assert.equal(linuxKeyChord(0x41, { ctrl: true }), 'ctrl+a')
  assert.equal(linuxKeyChord(0x56, { ctrl: true, shift: true }), 'ctrl+shift+v')
  assert.equal(linuxKeyChord(0x99, { ctrl: true }), null)

  const lookupOnly = (available) => (name) => (available.includes(name) ? `/usr/bin/${name}` : null)
  assert.equal(pickClipboardTool(lookupOnly(['xclip']))?.name, 'xclip')
  assert.equal(pickClipboardTool(lookupOnly(['xsel']))?.name, 'xsel')
  assert.equal(pickClipboardTool(lookupOnly(['wl-paste', 'wl-copy']))?.name, 'wl-clipboard')
  assert.equal(pickClipboardTool(lookupOnly([])), null)
  assert.deepEqual(pickClipboardTool(lookupOnly(['xclip'])).write.args, ['-selection', 'clipboard', '-i'])

  assert.equal(isWayland({ XDG_SESSION_TYPE: 'wayland' }), true)
  assert.equal(isWayland({ WAYLAND_DISPLAY: 'wayland-0' }), true)
  assert.equal(isWayland({ XDG_SESSION_TYPE: 'x11' }), false)
})

// ---------------------------------------------------------------------------
// 驱动：macOS / Linux（注入假 runFn）
// ---------------------------------------------------------------------------

test('macOS 驱动：列窗口 / 抢焦点 / 按键 / 剪贴板 / 空闲（走假 osascript）', async () => {
  const calls = []
  const runFn = async (file, args, opts = {}) => {
    calls.push({ file, args, input: opts.input })
    const tool = basename(file)
    if (tool === 'ioreg') return ok('    "HIDIdleTime" = 5000000000\n')
    if (tool === 'pbpaste') return ok('剪贴板内容')
    if (tool === 'pbcopy') return ok('')
    if (tool === 'osascript') {
      const script = String(args?.[1] ?? '')
      if (script.includes('every process whose background only is false')) return ok('123\tCursor\tPLAN.md — Cursor\t100,200\t800,600\n')
      if (script.includes('set frontmost')) return ok('')
      if (script.includes('frontmost is true')) return ok('123, Cursor\n')
      return ok('')
    }
    return bad('unexpected command')
  }
  const driver = createUiDriver({ platform: 'darwin', log: quiet, runFn, osascript: 'osascript' })

  assert.equal(await driver.idle(), 5000)
  const windows = await driver.listWindows()
  assert.equal(windows.length, 1)
  assert.equal(windows[0].process, 'Cursor')
  assert.equal((await driver.window(123))?.title, 'PLAN.md — Cursor')

  const focus = await driver.focus(123)
  assert.equal(focus.ok, true, '前台 pid 一致 → ok')

  await driver.key(0x41, { ctrl: true })
  assert.match(calls.filter(c => basename(c.file) === 'osascript').at(-1).args[1], /key code 0 using \{command down\}/)

  await driver.key(0x0D)
  assert.match(calls.filter(c => basename(c.file) === 'osascript').at(-1).args[1], /key code 36/)

  await driver.click(10, 20)
  assert.match(calls.filter(c => basename(c.file) === 'osascript').at(-1).args[1], /click at \{10, 20\}/)

  assert.equal(await driver.readClipboard(), '剪贴板内容')
  assert.equal(await driver.writeClipboard('新内容'), true)
  assert.equal(calls.filter(c => basename(c.file) === 'pbcopy').at(-1).input, '新内容')

  const check = await driver.check()
  assert.equal(check.ok, true)
  // UI 元素树没有实现：必须诚实返回"不支持"，而不是假装拿到东西
  assert.deepEqual(await driver.uiaElements(), [])
  assert.equal((await driver.uiaFocus()).ok, false)
})

test('Linux 驱动：列窗口 / 按键 / 剪贴板 / Wayland 与缺依赖的诚实降级', async () => {
  const calls = []
  const runFn = async (file, args, opts = {}) => {
    calls.push({ file, args, input: opts.input })
    const tool = basename(file)
    if (tool === 'xprintidle') return ok('1234\n')
    if (tool === 'xclip') return opts.input !== undefined ? ok('') : ok('剪贴板内容')
    if (tool === 'xdotool') {
      const [cmd] = args
      if (cmd === 'search') return ok('100\n')
      if (cmd === 'getwindowname') return ok('PLAN.md — Cursor\n')
      if (cmd === 'getwindowgeometry') return ok('WINDOW=100\nX=10\nY=20\nWIDTH=800\nHEIGHT=600\nSCREEN=0\n')
      if (cmd === 'getwindowpid') return ok('4242\n')
      if (cmd === 'getactivewindow') return ok('100\n')
      return ok('')
    }
    return bad('unexpected command')
  }
  const lookup = (name) => (['xdotool', 'xclip', 'xprintidle'].includes(name) ? `/usr/bin/${name}` : null)
  const driver = createUiDriver({ platform: 'linux', log: quiet, runFn, lookup, env: { XDG_SESSION_TYPE: 'x11' } })

  assert.equal(driver.supported, true)
  assert.equal(driver.clipboardTool, 'xclip')
  assert.equal(await driver.idle(), 1234)

  const windows = await driver.listWindows()
  assert.equal(windows.length, 1)
  assert.equal(windows[0].title, 'PLAN.md — Cursor')
  assert.deepEqual(windows[0].rect, [10, 20, 810, 620])

  assert.equal((await driver.focus(100)).ok, true)
  await driver.key(0x41, { ctrl: true })
  assert.deepEqual(calls.filter(c => basename(c.file) === 'xdotool').at(-1).args, ['key', '--clearmodifiers', 'ctrl+a'])
  await driver.type('-中文开头')
  assert.deepEqual(calls.filter(c => basename(c.file) === 'xdotool').at(-1).args, ['type', '--clearmodifiers', '--delay', '12', '--', '-中文开头'])
  await driver.click(5, 6)
  assert.deepEqual(calls.filter(c => basename(c.file) === 'xdotool').at(-1).args, ['mousemove', '--sync', '5', '6', 'click', '1'])

  assert.equal(await driver.readClipboard(), '剪贴板内容')
  assert.equal(await driver.writeClipboard('新内容'), true)
  assert.equal(calls.filter(c => basename(c.file) === 'xclip' && c.input !== undefined).at(-1).input, '新内容')

  const check = await driver.check()
  assert.equal(check.ok, true)
  assert.match(check.detail, /xdotool \+ xclip/)

  // Wayland：xdotool 看不到别的窗口 → 必须明确不可用，并给出可操作提示
  const wayland = createUiDriver({ platform: 'linux', log: quiet, runFn, lookup, env: { XDG_SESSION_TYPE: 'wayland' } })
  assert.equal(wayland.supported, false)
  const waylandCheck = await wayland.check()
  assert.equal(waylandCheck.ok, false)
  assert.ok(waylandCheck.hints.join(' ').includes('XWayland'))

  // 没有 xdotool / 没有剪贴板工具
  const bare = createUiDriver({ platform: 'linux', log: quiet, runFn, lookup: () => null, env: {} })
  assert.equal(bare.supported, false)
  assert.match((await bare.check()).reason, /xdotool/)
})

test('驱动分发：平台不认识时明确不可用；uiPlatformInfo 不抛异常', async () => {
  const other = createUiDriver({ platform: 'plan9', log: quiet })
  assert.equal(other.supported, false)
  assert.match(other.reason, /plan9/)
  assert.equal(await other.idle(), -1)
  assert.deepEqual(await other.listWindows(), [])

  for (const platform of ['win32', 'darwin', 'linux', 'plan9']) {
    const info = await uiPlatformInfo({ platform })
    assert.equal(typeof info.ok, 'boolean', `${platform} 应该有 ok`)
    assert.equal(typeof info.label, 'string')
  }
  assert.match((await uiPlatformInfo({ platform: 'plan9' })).label, /未实现/)
})

// ---------------------------------------------------------------------------
// human-sim：读回强化 + 草稿保护（假 UI 驱动，离线）
// ---------------------------------------------------------------------------

/** 造一个"有输入框 / 有对话记录"的假 UI 驱动，忠实模拟复制/粘贴/撤销语义。 */
function makeFakeUiDriver({ transcript = '', composer = '', clickToTranscriptAt = [] } = {}) {
  const win = { hwnd: 1, process: 'Cursor', title: 'Cursor', width: 1000, height: 800, rect: [0, 0, 1000, 800] }
  const state = { composer, focus: 'composer', clipboard: '', selected: null, undo: [], sent: [] }
  const calls = []
  return {
    platform: 'win32',
    supported: true,
    calls,
    state,
    async idle() { return 10 ** 6 },
    async listWindows() { return [win] },
    async window() { return win },
    async foreground() { return { hwnd: 1, process: 'Cursor', title: 'Cursor' } },
    async focus() { calls.push(['focus']); return { ok: true, foreground: { hwnd: 1 }, target: win } },
    async click(x, y) {
      calls.push(['click', x, y])
      if (clickToTranscriptAt.some(p => p.x === x && p.y === y)) state.focus = 'transcript'
      return { ok: true }
    },
    async key(vk, mods = {}) {
      calls.push(['key', vk, mods])
      const ctrl = Boolean(mods.ctrl)
      if (ctrl && vk === 0x41) state.selected = state.focus === 'composer' ? state.composer : transcript
      else if (ctrl && vk === 0x43) { if (state.selected !== null) state.clipboard = state.selected; state.selected = null }
      else if (ctrl && vk === 0x56) { if (state.focus === 'composer') { state.undo.push(state.composer); state.composer += state.clipboard } }
      else if (ctrl && vk === 0x5A) { if (state.undo.length) state.composer = state.undo.pop() }
      else if (vk === 0x2E && state.selected !== null) { state.composer = ''; state.selected = null }
      else if (vk === 0x0D) { if (state.focus === 'composer') { state.sent.push(state.composer); state.composer = '' } }
      return { ok: true }
    },
    async type(text) { calls.push(['type', text]); if (state.focus === 'composer') state.composer += text; return { ok: true } },
    async readClipboard() { return state.clipboard },
    async writeClipboard(text) { state.clipboard = String(text); return true },
    async uiaElements() { return [] },
    async uiaFocus() { return { ok: false } },
    async ocrLanguages() { return [] },
    async capture() { return { ok: false } },
    async ocr() { return { ok: false, lines: [] } },
  }
}

function humanConfig(dir, options = {}, guard = {}) {
  const config = mergeConfig(defaultConfig(), {
    plan: join(dir, 'PLAN.md'),
    agent: {
      adapter: 'human-sim', cwd: dir, session: 'latest',
      options: { windowMatch: { process: 'Cursor' }, humanIdleMs: 0, ...options },
    },
    judge: { kind: 'rule' },
    evidence: { git: false, verify: [] },
    guard: { requireHumanIdleMs: 0, restoreFocus: false, cooldownMs: 0, ...guard },
    journal: { dir: join(dir, '.cyber') },
    notify: { beep: false, toast: false },
    runtime: { logLevel: 'error' },
  })
  config.__cwd = dir
  return config
}

test('human-sim 读回：焦点被输入框抢走时，靠对话区候选点把对话读回来', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-ui-read-'))
  const transcript = '你\n把第 1 项做完\nAI\n第 1 项做完了，产物在 artifacts/a.txt。\nRECV#1'
  // 候选点第一个默认是 (relX .5, relY .35) → 窗口 1000×800 → (500, 280)
  const driver = makeFakeUiDriver({ transcript, composer: '', clickToTranscriptAt: [{ x: 500, y: 280 }] })
  const adapter = createHumanSimAdapter({
    config: humanConfig(dir, { stableMs: 0 }), cwd: dir, log: quiet, deps: { driver },
  })
  const session = await adapter.resolveSession()
  const snapshot = await adapter.readState(session)

  assert.match(String(snapshot.lastAnswer), /第 1 项做完了/)
  assert.match(String(snapshot.extra.readVia), /clipboard\+click\(500,280\)/)
  assert.equal(snapshot.status, 'idle')
  assert.ok(driver.calls.some(c => c[0] === 'click' && c[1] === 500 && c[2] === 280), '应该点了对话区')
  rmSync(dir, { recursive: true, force: true })
})

test('human-sim 读回：候选点可配置（绝对坐标只试那一个）', () => {
  const win = { rect: [0, 0], width: 1000, height: 800 }
  const defaults = resolveReaderClickCandidates(win, {})
  assert.equal(defaults.length, 4, '默认最多试 4 个点')
  assert.deepEqual(defaults[0], { x: 500, y: 280 })
  assert.equal(resolveReaderClickCandidates(win, { maxReaderAttempts: 2 }).length, 2)
  assert.deepEqual(resolveReaderClickCandidates(win, { readerClick: { x: 7, y: 9 } }), [{ x: 7, y: 9 }])
  const custom = resolveReaderClickCandidates(win, { readerClickPoints: [{ relX: 0.2, relY: 0.5 }] })
  assert.deepEqual(custom[0], { x: 200, y: 400 })
})

test('human-sim 注入：输入框里有主人的草稿 → 一个字符都不动，直接放弃这一鞭', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-ui-draft-'))
  const driver = makeFakeUiDriver({ transcript: 'AI\n之前的回答', composer: '主人的草稿' })
  const adapter = createHumanSimAdapter({ config: humanConfig(dir), cwd: dir, log: quiet, deps: { driver } })
  const session = await adapter.resolveSession()
  const result = await adapter.whip('[赛博监工] 继续干活', session)

  assert.equal(result.ok, false)
  assert.equal(result.kind, 'setup', '草稿属于"通道没配好"，应该停下喊人而不是报错')
  assert.match(result.detail, /草稿/)

  assert.equal(driver.state.composer, '主人的草稿', '草稿必须原封不动')
  assert.deepEqual(driver.state.sent, [], '绝不能把消息发出去')
  assert.ok(!driver.calls.some(c => c[0] === 'key' && c[1] === 0x2E), '绝不能用 Delete 清探针（那会删掉草稿）')
  assert.ok(driver.calls.some(c => c[0] === 'key' && c[1] === 0x5A && c[2]?.ctrl), '应该用 Ctrl+Z 撤销探针')
  rmSync(dir, { recursive: true, force: true })
})

test('human-sim 注入：clearComposer=true 时清掉草稿并把鞭子发出去（回车前已校验）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-ui-clear-'))
  const driver = makeFakeUiDriver({ transcript: 'AI\n之前的回答', composer: '主人的草稿' })
  const adapter = createHumanSimAdapter({
    config: humanConfig(dir, { clearComposer: true }), cwd: dir, log: quiet, deps: { driver },
  })
  const session = await adapter.resolveSession()
  const whip = '[赛博监工] 还没到收工的时候。把第 2 项做完。'
  const result = await adapter.whip(whip, session)

  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(driver.state.sent.length, 1, '应该刚好发出一条消息')
  assert.equal(driver.state.sent[0], whip, '发出去的内容必须与鞭子完全一致')
  assert.match(result.detail, /回车前已校验/)
  assert.equal(driver.state.composer, '', '发完之后输入框应该是空的')
  rmSync(dir, { recursive: true, force: true })
})

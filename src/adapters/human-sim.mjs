/**
 * 拟人适配器（human-sim）：像人一样读对话框、像人一样打字。
 *
 * 这是覆盖面最广的通道——对任何 GUI agent（Cursor / Codex 桌面版 / opencode TUI /
 * 网页版助手 / 甚至聊天窗口里的另一个 AI）都成立，代价是它必须**抢焦点**，
 * 所以它被三道保险焊死：
 *
 *   1. **空闲保险丝**：只有系统键鼠空闲达到 `guard.requireHumanIdleMs` 才动手。"主人在休息时才抽鞭"
 *      不是比喻，是硬条件；主人在用电脑就等，等到超时就放弃这一鞭。
 *   2. **焦点确认**：抢焦点后**回读**当前前台窗口，没抢到就绝不打字（不会把鞭子打进别的窗口）。
 *   3. **回车前校验**：粘贴完先 `Ctrl+A`/`Ctrl+C` 把输入框内容读回来跟原文比对，
 *      一致才按回车；不一致就直接放弃（宁可这一轮不抽，也不能发错消息）。
 *
 * 读的策略同样分三层：优先让别的适配器**读磁盘**（最准），否则用剪贴板把对话框文字
 * 捞出来（Ctrl+A/Ctrl+C），再不行才用 UIA。判"它说完没有"用"文本多久没变"作为代理信号。
 *
 * @module cyber-overseer/adapters/human-sim
 */

import { createLogger } from '../util/log.mjs'
import { hash, normalize } from '../util/text.mjs'
import { sleep } from '../util/time.mjs'
import { findWindow, describeWindows, createWindowsDriver } from '../ui/windows.mjs'
import { probeFail, probeOk } from './base.mjs'

export const id = 'human-sim'
export const label = '拟人通道（模拟人类操作界面）'
export const docs = 'UIA/剪贴板读对话框 + 抢焦点打字回车注入；带空闲保险丝'

/** 输入框位置的默认猜测：窗口底部居中（绝大多数聊天式 agent 的输入框都在那）。 */
const DEFAULT_COMPOSER = { relX: 0.5, relY: 0.94 }

/**
 * @param {{config:any, cwd:string, log?:any, deps?:any}} ctx
 * @returns {import('./base.mjs').Adapter}
 */
export function createHumanSimAdapter(ctx) {
  const { config } = ctx
  const log = ctx.log ?? createLogger({ level: 'warn' })
  const options = ctx.config.agent?.options ?? {}
  const guard = config.guard ?? {}
  const driver = ctx.deps?.driver ?? createWindowsDriver({ log, scriptPath: options.driverScript })
  const state = {
    lastText: '',
    lastChangeAt: 0,
    lastInjected: options.lastInjected ?? '',
    lastWindow: null,
  }
  const stableMs = options.stableMs ?? 20000
  const humanIdleMs = options.humanIdleMs ?? guard.requireHumanIdleMs ?? 120000
  const waitForHumanIdleMs = options.waitForHumanIdleMs ?? 10 * 60 * 1000

  return {
    id,
    label,
    docs,

    async probe() {
      if (process.platform !== 'win32') {
        return probeFail('拟人通道目前只实现了 Windows（UIA + SendInput）', [
          'macOS 可用 AppleScript/`osascript` 走同一套接口实现（欢迎 PR）',
          'Linux 可用 xdotool/ydotool',
        ])
      }
      if (!options.windowMatch || Object.keys(options.windowMatch).length === 0) {
        return probeFail('拟人通道必须配置目标窗口：agent.options.windowMatch = { title: "Cursor" }', [
          '用 `cw windows` 列出当前所有窗口，挑出你要监工的那个',
        ])
      }
      let idleMs = -1
      try { idleMs = await driver.idle() } catch (error) {
        return probeFail(`UI 驱动不可用：${error?.message ?? error}`, ['确认能运行 powershell.exe（Windows PowerShell 5.1）'])
      }
      const win = await findWindow(driver, options.windowMatch)
      if (!win) {
        const list = await describeWindows(driver).catch(() => [])
        return probeFail(`找不到匹配窗口：${JSON.stringify(options.windowMatch)}`, ['当前可见窗口：', ...list])
      }
      state.lastWindow = win
      const hints = []
      if (humanIdleMs === 0) hints.push('⚠️ humanIdleMs=0：主人在用电脑时也会抢焦点打字，极易误输入')
      if (options.verifyComposer === false) hints.push('⚠️ 已关闭回车前校验：万一焦点不对，鞭子可能发错地方')
      return probeOk(`目标窗口：${win.process} — ${win.title}（${win.width}×${win.height}）；当前空闲 ${Math.round(idleMs / 1000)}s`, hints)
    },

    async listSessions() {
      const windows = await driver.listWindows()
      return windows
        .filter(w => (w.title ?? '').trim())
        .map(w => ({
          id: `hwnd:${w.hwnd}`,
          title: w.title,
          cwd: null,
          updatedAt: Date.now(),
          raw: w,
        }))
    },

    async resolveSession() {
      const win = await findWindow(driver, options.windowMatch)
      if (!win) return null
      return { id: `hwnd:${win.hwnd}`, title: win.title, cwd: options.cwd ?? null, updatedAt: Date.now(), raw: win }
    },

    async readState(session) {
      if (process.platform !== 'win32') return unknownState('拟人通道仅支持 Windows')
      let win = session?.raw?.hwnd ? session.raw : null
      if (!win) win = await findWindow(driver, options.windowMatch)
      if (!win) return unknownState(`找不到目标窗口：${JSON.stringify(options.windowMatch)}`)

      // 1) 首选：让别的适配器读磁盘（最精确，不抢焦点）
      if (options.readerAdapter) {
        try {
          const { createAdapter } = await import('./index.mjs')
          const inner = createAdapter(options.readerAdapter, { ...ctx, log })
          const innerProbe = await inner.probe()
          if (innerProbe.ok) {
            const innerSession = await inner.resolveSession(options.readerSession ?? 'latest')
            if (innerSession) {
              const snapshot = await inner.readState(innerSession)
              return {
                ...snapshot,
                extra: { ...(snapshot.extra ?? {}), readVia: options.readerAdapter, window: win.title },
              }
            }
          }
        } catch (error) {
          log.debug?.(`拟人通道的磁盘读取器（${options.readerAdapter}）不可用：${error?.message ?? error}`)
        }
      }

      // 2) 其次：剪贴板捞文本（Ctrl+A / Ctrl+C）
      let text = ''
      let readVia = 'none'
      try {
        text = await readTranscriptViaClipboard(driver, win)
        readVia = 'clipboard'
      } catch (error) {
        log.debug?.(`剪贴板读取失败：${error?.message ?? error}`)
      }
      // 3) 兜底：UIA
      if (!text.trim()) {
        try {
          text = await readTranscriptViaUia(driver, win)
          readVia = 'uia'
        } catch (error) {
          log.debug?.(`UIA 读取失败：${error?.message ?? error}`)
        }
      }
      if (!text.trim()) {
        return unknownState('读不到对话框内容（剪贴板与 UIA 都失败）', { readVia, window: win.title })
      }

      const answer = extractAnswer(text, state.lastInjected, options)
      const textHash = hash(normalize(text))
      if (textHash !== hash(normalize(state.lastText))) {
        state.lastText = text
        state.lastChangeAt = Date.now()
      }
      const quietMs = state.lastChangeAt ? Date.now() - state.lastChangeAt : Infinity
      const status = quietMs >= stableMs ? 'idle' : 'working'
      return {
        status,
        turn: null,
        lastAnswer: answer,
        lastUserMessage: state.lastInjected || null,
        session,
        extra: {
          readVia,
          window: win.title,
          quietMs,
          stableMs,
          transcriptChars: text.length,
          // 拟人通道没有权威的回合边界：用"文本安静了多久"当代理信号
          statusBasis: `文本已安静 ${Math.round(quietMs / 1000)}s（阈值 ${Math.round(stableMs / 1000)}s）`,
        },
      }
    },

    async whip(text, session, engineCtx) {
      if (process.platform !== 'win32') {
        return { ok: false, mode: 'inject', detail: '拟人通道仅支持 Windows' }
      }
      const win = session?.raw?.hwnd ? session.raw : await findWindow(driver, options.windowMatch)
      if (!win) return { ok: false, mode: 'inject', detail: `找不到目标窗口：${JSON.stringify(options.windowMatch)}` }

      // ---- 保险丝 1：主人在休息吗 ----
      const waited = await waitForHumanRest(driver, humanIdleMs, waitForHumanIdleMs, engineCtx?.signal)
      if (!waited.ok) {
        return { ok: false, mode: 'inject', detail: `主人还在用电脑（空闲 ${Math.round(waited.idleMs / 1000)}s < ${Math.round(humanIdleMs / 1000)}s），本次不抽鞭` }
      }

      const prevClipboard = await driver.readClipboard().catch(() => '')
      const prevForeground = (await driver.foreground().catch(() => null))?.hwnd

      // ---- 保险丝 2：抢焦点并回读确认 ----
      const focusResult = await driver.focus(win.hwnd)
      if (!focusResult.ok) {
        return { ok: false, mode: 'inject', detail: `抢焦点失败（前台仍是 ${focusResult.foreground?.process ?? '?'}），放弃注入` }
      }
      await sleep(options.afterFocusMs ?? 250, engineCtx?.signal).catch(() => {})

      // ---- 点进输入框 ----
      const point = resolveComposerPoint(win, options.composer)
      let clicked = false
      if (options.uiaFocusFirst !== false) {
        try {
          const found = await driver.uiaFocus(win.hwnd, { nameMatch: options.composerNameMatch })
          if (found.ok && found.rect) {
            await driver.click(Math.round(found.rect[0] + found.rect[2] / 2), Math.round(found.rect[1] + found.rect[3] / 2))
            clicked = true
            log.debug?.('已用 UIA 定位并点击输入框')
          }
        } catch { /* 回退到坐标 */ }
      }
      if (!clicked) await driver.click(point.x, point.y)
      await sleep(options.afterClickMs ?? 200, engineCtx?.signal).catch(() => {})

      // ---- 输入框里已经有东西？默认不动它（可能是主人的草稿） ----
      if (options.clearComposer !== true) {
        const existing = await readComposer(driver).catch(() => null)
        if (existing && existing.trim().length > 0 && !looksLikeOurs(existing, text)) {
          await restoreFocus(driver, prevForeground, options, engineCtx)
          return {
            ok: false, mode: 'inject',
            detail: `输入框里已有内容（${existing.trim().length} 字），为不破坏主人的草稿，本次不注入`,
          }
        }
      } else {
        await driver.key(0x41, { ctrl: true }) // Ctrl+A
        await driver.key(0x2E) // Delete
        await sleep(120, engineCtx?.signal).catch(() => {})
      }

      // ---- 写入：默认走剪贴板粘贴（长文本/中文最稳） ----
      const inputMode = options.inputMode ?? 'paste'
      if (inputMode === 'type') {
        const typed = await driver.type(text)
        if (typed.ok === false) log.warn?.(`逐字输入可能不完整：${JSON.stringify(typed)}`)
      } else {
        await driver.writeClipboard(text)
        await sleep(options.afterClipboardMs ?? 150, engineCtx?.signal).catch(() => {})
        await driver.key(0x56, { ctrl: true }) // Ctrl+V
      }
      await sleep(options.afterInputMs ?? 300, engineCtx?.signal).catch(() => {})

      // ---- 保险丝 3：回车前校验输入框内容 ----
      if (options.verifyComposer !== false) {
        const actual = await readComposer(driver).catch(() => null)
        if (actual === null) {
          await restore(driver, prevClipboard, prevForeground, options, engineCtx)
          return { ok: false, mode: 'inject', detail: '无法回读输入框内容以确认注入正确，按安全策略放弃按回车' }
        }
        if (!sameMessage(actual, text)) {
          await restore(driver, prevClipboard, prevForeground, options, engineCtx)
          return {
            ok: false, mode: 'inject',
            detail: `输入框内容与鞭子不一致（读到 ${actual.trim().length} 字 / 期望 ${text.trim().length} 字），已放弃按回车；内容仍留在输入框里，请人工确认`,
          }
        }
      }

      // ---- 回车 ----
      await driver.key(0x0D)
      await sleep(options.afterEnterMs ?? 400, engineCtx?.signal).catch(() => {})
      state.lastInjected = text
      await restore(driver, prevClipboard, prevForeground, options, engineCtx)

      return {
        ok: true,
        mode: 'inject',
        detail: `已在「${win.title}」输入并回车（${inputMode}，${text.length} 字，回车前已校验）`,
      }
    },

    async capabilities() {
      const win = await findWindow(driver, options.windowMatch).catch(() => null)
      return [
        `平台：${process.platform}`,
        `目标窗口：${win ? `${win.process} — ${win.title}` : `未找到（${JSON.stringify(options.windowMatch)}）`}`,
        `输入方式：${options.inputMode ?? 'paste'}（剪贴板粘贴 + 回车）`,
        `读取方式：${options.readerAdapter ? `磁盘（${options.readerAdapter}）` : '剪贴板 / UIA'}`,
        `空闲保险丝：${Math.round(humanIdleMs / 1000)}s`,
        `回车前校验：${options.verifyComposer === false ? '关闭' : '开启'}`,
      ].join('\n')
    },
  }

  // -------------------------------------------------------------------------

  /** 等到"主人离开电脑"。 */
  async function waitForHumanRest(drv, thresholdMs, timeoutMs, signal) {
    const started = Date.now()
    for (;;) {
      const idleMs = await drv.idle().catch(() => -1)
      if (idleMs >= thresholdMs) return { ok: true, idleMs }
      if (Date.now() - started >= timeoutMs) return { ok: false, idleMs }
      log.debug?.(`主人还在用电脑（空闲 ${Math.round(idleMs / 1000)}s），等待中…`)
      await sleep(5000, signal).catch(() => {})
    }
  }

  /** 用 Ctrl+A / Ctrl+C 把界面上的文字捞进剪贴板（读完还原剪贴板）。 */
  async function readTranscriptViaClipboard(drv, win) {
    const prev = await drv.readClipboard().catch(() => '')
    const fg = (await drv.foreground().catch(() => null))?.hwnd
    const focusResult = await drv.focus(win.hwnd)
    if (!focusResult.ok) throw new Error('抢焦点失败，无法读取对话框')
    await sleep(200)
    if (options.readerClick) await drv.click(options.readerClick.x, options.readerClick.y)
    await sleep(120)
    await drv.writeClipboard('')
    await drv.key(0x41, { ctrl: true }) // Ctrl+A
    await sleep(150)
    await drv.key(0x43, { ctrl: true }) // Ctrl+C
    await sleep(350)
    const text = await drv.readClipboard().catch(() => '')
    await restoreFocus(drv, fg, options, null)
    if (options.restoreClipboard !== false) await drv.writeClipboard(prev).catch(() => {})
    return text
  }

  /** UIA 兜底读取：把所有可编辑/文档元素的文本拼起来。 */
  async function readTranscriptViaUia(drv, win) {
    const elements = await drv.uiaElements(win.hwnd, { kinds: ['Document', 'Edit', 'Text'], max: 400 })
    const pieces = elements
      .map(el => (typeof el.value === 'string' && el.value.trim()) ? el.value : (typeof el.name === 'string' ? el.name : ''))
      .filter(Boolean)
    return pieces.join('\n')
  }

  /** 读输入框内容（Ctrl+A / Ctrl+C），失败返回 null。 */
  async function readComposer(drv) {
    const prev = await drv.readClipboard().catch(() => '')
    await drv.writeClipboard('')
    await drv.key(0x41, { ctrl: true })
    await sleep(120)
    await drv.key(0x43, { ctrl: true })
    await sleep(250)
    const text = await drv.readClipboard().catch(() => null)
    if (options.restoreClipboard !== false) await drv.writeClipboard(prev).catch(() => {})
    return text
  }

  async function restore(drv, clipboard, foregroundHwnd, opts, engineCtx) {
    if (opts.restoreClipboard !== false && clipboard !== undefined) {
      await drv.writeClipboard(clipboard).catch(() => {})
    }
    await restoreFocus(drv, foregroundHwnd, opts, engineCtx)
  }

  async function restoreFocus(drv, foregroundHwnd, opts, engineCtx) {
    if (opts.restoreFocus === false || guard.restoreFocus === false) return
    if (!foregroundHwnd) return
    try { await drv.focus(foregroundHwnd) } catch { /* 原窗口可能已关闭 */ }
  }
}

/** 输入框坐标：支持绝对坐标或相对窗口的比例。 */
export function resolveComposerPoint(win, composer) {
  const c = { ...DEFAULT_COMPOSER, ...(composer ?? {}) }
  if (typeof c.x === 'number' && typeof c.y === 'number') return { x: Math.round(c.x), y: Math.round(c.y) }
  const relX = typeof c.relX === 'number' ? c.relX : DEFAULT_COMPOSER.relX
  const relY = typeof c.relY === 'number' ? c.relY : DEFAULT_COMPOSER.relY
  const [left, top] = win.rect ?? [0, 0]
  return {
    x: Math.round(left + (win.width ?? 800) * relX),
    y: Math.round(top + (win.height ?? 600) * relY),
  }
}

/**
 * 从整段对话框文本里抽"最后一次回答"。
 *
 * 核心技巧：**我们自己知道刚才往输入框里打了什么**（lastInjected），
 * 所以按它最后一次出现的位置切开，后面那段就是 agent 的回答。
 * 这比任何"按发言人分行"的启发式都可靠。
 */
export function extractAnswer(text, lastInjected, options = {}) {
  const full = String(text ?? '')
  const marker = String(lastInjected ?? '').trim()
  if (marker && marker.length > 8) {
    const needle = marker.slice(0, Math.min(120, marker.length))
    const index = full.lastIndexOf(needle)
    if (index >= 0) {
      return full.slice(index + needle.length).trim()
    }
  }
  if (options.answerRegex) {
    try {
      const re = new RegExp(options.answerRegex, 'g')
      let match
      let last = null
      while ((match = re.exec(full)) !== null) last = match
      if (last) return (last[1] ?? last[0]).trim()
    } catch { /* 正则写错了就当没配 */ }
  }
  const tailChars = options.answerTailChars ?? 4000
  return full.slice(-tailChars).trim()
}

function unknownState(error, extra = {}) {
  return { status: 'unknown', turn: null, lastAnswer: '', lastUserMessage: null, error, extra }
}

/** 宽松比较：忽略空白差异，也容忍末尾被界面吞掉少量字符。 */
export function sameMessage(a, b) {
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
  const left = norm(a)
  const right = norm(b)
  if (left === right) return true
  const min = Math.min(left.length, right.length)
  if (min < 20) return false
  return left.slice(0, min) === right.slice(0, min) && Math.abs(left.length - right.length) <= Math.max(8, right.length * 0.05)
}

function looksLikeOurs(existing, text) {
  return sameMessage(existing, text)
}

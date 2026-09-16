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
      //
      // 这里有个真实世界的坑：**agent 刚回复完时，焦点往往还在输入框里**
      // （Cursor/Codex 这类聊天式界面会把光标放回输入框）。此时 Ctrl+A 选中的是**空的输入框**，
      // 复制出来是空的，看起来就像"读不到对话框"。
      // 所以策略是一串：
      //   a. 直接复制（焦点若在对话区就成）
      //   b. 先点一下"对话区域"（options.readerClick，默认窗口上方 1/3）再复制
      //   c. UIA（对 Electron/Chromium 通常没用，但对 Win32 应用有用）
      // 每一步都用 `plausibleTranscript` 检查"捞到的像不像对话记录"，避免把空字符串当答案。
      let text = ''
      let readVia = 'none'
      try {
        text = await readTranscriptViaClipboard(driver, win)
        readVia = 'clipboard'
      } catch (error) {
        log.debug?.(`剪贴板读取失败：${error?.message ?? error}`)
      }
      if (!plausibleTranscript(text, state.lastInjected, options)) {
        try {
          const point = resolveReaderClickPoint(win, options)
          const second = await readTranscriptViaClipboard(driver, win, point)
          if (plausibleTranscript(second, state.lastInjected, options) || second.length > text.length) {
            text = second
            readVia = `clipboard+click(${point.x},${point.y})`
          }
        } catch (error) {
          log.debug?.(`点击对话区后再读失败：${error?.message ?? error}`)
        }
      }
      if (!plausibleTranscript(text, state.lastInjected, options)) {
        try {
          const viaUia = await readTranscriptViaUia(driver, win)
          // UIA 在浏览器里常常只能拿到地址栏之类的零碎文本，所以只在它"更像对话"时才采用
          if (plausibleTranscript(viaUia, state.lastInjected, options) || viaUia.length > text.length) {
            text = viaUia
            readVia = 'uia'
          }
        } catch (error) {
          log.debug?.(`UIA 读取失败：${error?.message ?? error}`)
        }
      }
      if (!plausibleTranscript(text, state.lastInjected, options)) {
        return unknownState(
          `读不到对话框内容（试过直接复制 / 点击对话区后复制 / UIA，拿到 ${text.length} 字）`
          + '——如果焦点始终在输入框里，请配置 agent.options.readerClick 指向对话区域',
          { readVia, window: win.title, chars: text.length },
        )
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

      // ---- 点进输入框：按候选点依次尝试，每次都用"探针字符"确认焦点真的进去了 ----
      // `clickComposer: false` 用于"输入框本来就有焦点"的应用（很多聊天式 GUI 切到窗口就会聚焦输入框）：
      // 这时乱点反而可能把焦点打到工具栏上，所以直接跳过点击，只做探针确认。
      const candidates = options.clickComposer === false ? [] : resolveComposerCandidates(win, options)
      if (!candidates.length) candidates.push(null)
      let focused = false
      let existing = ''
      const attempts = []
      for (const point of candidates) {
        if (point) {
          if (options.uiaFocusFirst !== false) {
            try {
              const found = await driver.uiaFocus(win.hwnd, { nameMatch: options.composerNameMatch })
              if (found.ok && found.rect) {
                await driver.click(Math.round(found.rect[0] + found.rect[2] / 2), Math.round(found.rect[1] + found.rect[3] / 2))
                attempts.push(`uia(${found.rect.join(',')})`)
              } else {
                await driver.click(point.x, point.y)
                attempts.push(`${point.x},${point.y}`)
              }
            } catch {
              await driver.click(point.x, point.y)
              attempts.push(`${point.x},${point.y}`)
            }
          } else {
            await driver.click(point.x, point.y)
            attempts.push(`${point.x},${point.y}`)
          }
          await sleep(options.afterClickMs ?? 200, engineCtx?.signal).catch(() => {})
        } else {
          attempts.push('不点击(clickComposer:false)')
        }

        const probe = await probeComposerFocus(driver, `${options.focusProbeToken ?? 'cwprobe'}`)
        attempts[attempts.length - 1] += probe.focused ? '(命中)' : `(未命中:${probe.readLength})`
        if (probe.focused) { focused = true; break }
        log.debug?.(`${attempts.at(-1)}：没把焦点送进输入框（探针读回 ${probe.readLength} 字），换下一个候选点`)
      }

      if (!focused) {
        await restore(driver, prevClipboard, prevForeground, options, engineCtx)
        return {
          ok: false, mode: 'inject', kind: 'setup',
          detail: `没能把焦点送进输入框：试了 ${attempts.length} 个位置（${attempts.join(' / ')}）。`
            + '请用 `cw windows` 确认窗口，并在 agent.options.composer 里给出输入框的准确位置'
            + '（支持 { relX, relY } 相对比例或 { x, y } 绝对坐标；注意浏览器/应用自己的工具栏高度）。'
            + '已放弃本次注入，未发送任何内容。',
        }
      }

      // ---- 输入框里已经有东西？默认不动它（可能是主人的草稿） ----
      existing = (await readComposer(driver)) ?? ''
      if (existing.trim().length > 0 && !looksLikeOurs(existing, text)) {
        if (options.clearComposer === true) {
          await driver.key(0x41, { ctrl: true }) // Ctrl+A
          await driver.key(0x2E) // Delete
          await sleep(120, engineCtx?.signal).catch(() => {})
        } else {
          await restore(driver, prevClipboard, prevForeground, options, engineCtx)
          return {
            ok: false, mode: 'inject', kind: 'setup',
            detail: `输入框里已有内容（${existing.trim().length} 字），为不破坏主人的草稿，本次不注入。`
              + '（如果那是上次失败的残留，清空它或把 agent.options.clearComposer 设为 true）',
          }
        }
      }

      // ---- 写入：默认走剪贴板粘贴（长文本/中文最稳） ----
      const inputMode = options.inputMode ?? 'paste'
      if (inputMode === 'type') {
        const typed = await driver.type(text)
        if (typed.ok === false) log.warn?.(`逐字输入可能不完整：${JSON.stringify(typed)}`)
      } else {
        if (!(await writeClipboardVerified(driver, text))) {
          await restore(driver, prevClipboard, prevForeground, options, engineCtx)
          return {
            ok: false, mode: 'inject', kind: 'transient',
            detail: '剪贴板写不进去（可能被别的进程占用）：本次不按回车，避免把主人剪贴板里的旧内容粘进去',
          }
        }
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

  /** 用 Ctrl+A / Ctrl+C 把界面上的文字捞进剪贴板（读完还原剪贴板；用哨兵确认"复制真的发生了"）。 */
  async function readTranscriptViaClipboard(drv, win, clickPoint = options.readerClick) {
    const prev = await drv.readClipboard().catch(() => '')
    const fg = (await drv.foreground().catch(() => null))?.hwnd
    const focusResult = await drv.focus(win.hwnd)
    if (!focusResult.ok) throw new Error('抢焦点失败，无法读取对话框')
    await sleep(200)
    if (clickPoint) {
      await drv.click(clickPoint.x, clickPoint.y)
      await sleep(220)
    }
    let result
    try {
      // 关键：把 hwnd 传进去，让 copyFocusedText 在按 Ctrl+A/Ctrl+C 之前复查前台窗口。
      // 不传的话，主人中途切回自己的窗口，我们就会**复制到他窗口里的内容**并当成 agent 的回答（踩过）。
      result = await copyFocusedText(drv, win.hwnd)
    } finally {
      await restoreFocus(drv, fg, options, null)
      if (options.restoreClipboard !== false) await drv.writeClipboard(prev).catch(() => {})
    }
    if (!result.copied) {
      log.debug?.('复制没有发生（焦点大概还在输入框里）——这次读取按失败处理，而不是拿旧剪贴板内容凑数')
      return ''
    }
    return result.text
  }

  /** UIA 兜底读取：把所有可编辑/文档元素的文本拼起来。 */
  async function readTranscriptViaUia(drv, win) {
    const elements = await drv.uiaElements(win.hwnd, { kinds: ['Document', 'Edit', 'Text'], max: 400 })
    const pieces = elements
      .map(el => (typeof el.value === 'string' && el.value.trim()) ? el.value : (typeof el.name === 'string' ? el.name : ''))
      .filter(Boolean)
    return pieces.join('\n')
  }

  /**
   * 目标窗口现在还是前台吗？
   *
   * 这是"焦点漂移"的防线：注入过程由多次独立进程调用组成（每步几百毫秒），
   * 主人完全可能在这中间点回自己的窗口。若不复查，后面的 Ctrl+A/Ctrl+V/回车就会
   * **打到别人的窗口里**——实测就这么读到过主人正在看的网页，甚至可能把鞭子发错地方。
   * 所以每一批按键之前都要复查一次；一旦漂移就立刻放弃（宁可这一轮不抽）。
   */
  async function targetIsForeground(drv, hwnd) {
    const foreground = await drv.foreground().catch(() => null)
    if (!foreground) return false
    return Number(foreground.hwnd) === Number(hwnd)
  }

  /**
   * 写剪贴板并**回读校验**：写不进去就重试，重试不过就返回 false。
   *
   * 为什么必须校验：Windows 剪贴板会被别的进程短暂占用，`SetText` 可能静默失败。
   * 一旦写失败而我们不知道，后面的 Ctrl+V 会粘贴**主人剪贴板里的旧内容**，
   * 而"读回"步骤读到的也是旧内容——于是监工会把别人的文本当成 agent 的回答（真实踩到过）。
   */
  async function writeClipboardVerified(drv, text, attempts = 3) {
    for (let i = 0; i < attempts; i++) {
      try { await drv.writeClipboard(text) } catch { /* 下面回读会判定 */ }
      await sleep(90)
      const back = await drv.readClipboard().catch(() => null)
      if (back === text) return true
    }
    return false
  }

  /**
   * 读当前焦点处的内容：写入唯一哨兵 → Ctrl+A → Ctrl+C → 读回。
   *
   * 哨兵是**关键**：如果复制根本没发生（焦点不在可编辑区/没有选中内容），剪贴板会原封不动地
   * 保留我们写进去的哨兵——于是我们能确定地判定"这次读取失败"。
   * 没有哨兵的话，读回来的会是**主人剪贴板里的旧内容**（实测读到过 B 站评论！），
   * 那会被当成 agent 的回答，让判定彻底跑偏。
   *
   * @param {any} drv
   * @returns {Promise<{copied:boolean, text:string, sentinel:string, reason?:string}>}
   */
  async function copyFocusedText(drv, hwnd) {
    const sentinel = `__cw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}__`
    if (hwnd !== undefined && !(await targetIsForeground(drv, hwnd))) {
      return { copied: false, text: '', sentinel, reason: '目标窗口已不是前台（焦点漂移）' }
    }
    if (!(await writeClipboardVerified(drv, sentinel))) {
      return { copied: false, text: '', sentinel, reason: '剪贴板写不进去（可能被别的进程占用）' }
    }
    await drv.key(0x41, { ctrl: true }) // Ctrl+A
    await sleep(140)
    await drv.key(0x43, { ctrl: true }) // Ctrl+C
    await sleep(320)
    const read = (await drv.readClipboard().catch(() => '')) ?? ''
    // 还是哨兵 = 复制没发生；空 = 什么都没复制到。两种都按"读取失败"处理，绝不用旧剪贴板内容凑数。
    if (read === sentinel || read.trim() === '') return { copied: false, text: '', sentinel, reason: '复制没有产生内容' }
    return { copied: true, text: read.split(sentinel).join(''), sentinel }
  }

  /**
   * 读输入框内容。
   *
   * 语义细节（很重要）：返回 `''` 表示"复制没发生"或"就是空的"——两者在**空输入框**上是同一件事：
   * Ctrl+A 选不到东西，自然不会覆盖剪贴板。焦点是否真的在输入框里，已经由
   * {@link probeComposerFocus}（粘贴探针 + 读回）单独确认过了，所以这里不需要再区分。
   *
   * 返回 `null` 只用于**真正读不出来**的情况（驱动报错），调用方据此走保守分支。
   */
  async function readComposer(drv, hwnd) {
    const prev = await drv.readClipboard().catch(() => '')
    try {
      const result = await copyFocusedText(drv, hwnd)
      return result.copied ? result.text : ''
    } catch (error) {
      log.debug?.(`读输入框失败：${error?.message ?? error}`)
      return null
    } finally {
      if (options.restoreClipboard !== false) await drv.writeClipboard(prev).catch(() => {})
    }
  }

  /**
   * 焦点探测：往当前焦点粘贴一个短"探针令牌"，再用 Ctrl+A/Ctrl+C 读回来。
   *
   * 为什么需要它：`Ctrl+A` 在**没进输入框**时会选中整页文字（实测 2754 字），
   * 而某些情况下复制又什么都没拿到（读回空字符串）——"空"既可能是"输入框是空的"，
   * 也可能是"焦点压根不在任何可编辑区域"。粘贴探针能把这个歧义消掉：
   * 读回 == 探针 → 焦点确实在输入框里；读回是整页文字或空 → 没进去。
   *
   * 探针本身很脏吗？不：它是一小段临时文本，确认/放弃后都会立刻清空（Ctrl+A + Delete）。
   * 这比"直接粘贴真正的鞭子然后发现发错地方"安全得多。
   *
   * @param {any} drv
   * @param {string} token
   * @returns {Promise<{focused:boolean, readLength:number, read:string}>}
   */
  async function probeComposerFocus(drv, token) {
    const prev = await drv.readClipboard().catch(() => '')
    try {
      if (!(await writeClipboardVerified(drv, token))) {
        return { focused: false, readLength: -1, read: '', reason: '剪贴板写入失败' }
      }
      await drv.key(0x56, { ctrl: true })     // Ctrl+V
      await sleep(140)
      await drv.key(0x41, { ctrl: true })     // Ctrl+A（选中刚才粘贴的内容）
      await sleep(100)
      await drv.key(0x43, { ctrl: true })     // Ctrl+C
      await sleep(220)
      const read = (await drv.readClipboard().catch(() => '')) ?? ''
      const focused = sameMessage(read, token)
      // 无论成没成，都把探针清掉（如果它落在错误的地方，也顺手帮主人清掉这点垃圾）
      await drv.key(0x41, { ctrl: true })
      await sleep(80)
      await drv.key(0x2E)                     // Delete
      await sleep(100)
      return { focused, readLength: read.length, read }
    } finally {
      if (options.restoreClipboard !== false) await drv.writeClipboard(prev).catch(() => {})
    }
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
 * 候点击点：真实 UI 里"输入框在哪"经常猜不准（顶部标题栏、工具条、多行布局都会影响），
 * 所以给一串候选点按顺序试，每个点都由 {@link looksLikeComposer} 做安全检查——
 * 不合格就换下一个，而不是把内容盲发出去。
 * @param {any} win
 * @param {any} options
 */
export function resolveComposerCandidates(win, options = {}) {
  const configured = options.composer ?? {}
  const points = [resolveComposerPoint(win, configured)]
  if (typeof configured.x === 'number' && typeof configured.y === 'number') return points // 绝对坐标：用户很确定，别自作聪明
  const [, top] = win.rect ?? [0, 0]
  const height = win.height ?? 600
  const width = win.width ?? 800
  const [left] = win.rect ?? [0, 0]
  const relX = typeof configured.relX === 'number' ? configured.relX : DEFAULT_COMPOSER.relX
  const relY = typeof configured.relY === 'number' ? configured.relY : DEFAULT_COMPOSER.relY
  const seen = new Set(points.map(p => `${p.x},${p.y}`))
  const push = (rx, ry) => {
    const point = { x: Math.round(left + width * rx), y: Math.round(top + height * ry) }
    const key = `${point.x},${point.y}`
    if (!seen.has(key)) { seen.add(key); points.push(point) }
  }
  // 优先在配置位置附近上下试探（±6% / ±12%），再退到常见的"底部输入框"位置
  push(relX, relY - 0.06)
  push(relX, relY + 0.06)
  push(relX, relY - 0.12)
  push(relX, relY + 0.12)
  push(0.5, 0.94)
  push(0.5, 0.88)
  return points.slice(0, Math.max(1, options.maxComposerAttempts ?? 6))
}

/**
 * 读回来的内容"像不像输入框里的东西"？
 *
 * 判据很关键：焦点没进输入框时，`Ctrl+A`/`Ctrl+C` 会把**整页文字**拷回来（实测 2754 字），
 * 而输入框要么是空的、要么只会包含我们刚打进去的内容。明显的长度失衡就说明点错了。
 * @param {string|null} existing
 * @param {string} intended 我们准备打进去的内容
 */
export function looksLikeComposer(existing, intended) {
  if (existing === null || existing === undefined) return false
  const text = String(existing)
  if (text.trim().length === 0) return true // 空的输入框：正常
  const budget = Math.max(400, String(intended ?? '').length * 2 + 200)
  return text.length <= budget
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

/** "对话区域"的默认点击位置：窗口上方 1/3（聊天式界面的对话记录通常在那儿）。 */
export function resolveReaderClickPoint(win, options = {}) {
  const configured = options.readerClick
  if (configured && typeof configured.x === 'number' && typeof configured.y === 'number') return configured
  const relX = configured?.relX ?? 0.5
  const relY = configured?.relY ?? 0.35
  const [left, top] = win.rect ?? [0, 0]
  return {
    x: Math.round(left + (win.width ?? 800) * relX),
    y: Math.round(top + (win.height ?? 600) * relY),
  }
}

/**
 * 捞到的文本"像不像对话记录"？
 *
 * 判据：够长，而且（含我们刚注入的那句话 / 有多行 / 长到不可能是输入框残留）三者之一。
 * 这是为了防止把"空输入框"或"地址栏 URL"当成 agent 的回答——那会让判定完全跑偏。
 * @param {string} text
 * @param {string} lastInjected 我们上一次注入的鞭子原文（知道它，就能确认"读到了包含它的对话"）
 * @param {any} options
 */
export function plausibleTranscript(text, lastInjected, options = {}) {
  const value = String(text ?? '')
  const minChars = options.minTranscriptChars ?? 40
  if (value.trim().length < minChars) return false
  if (value.includes('RECV#')) return true // 夹具页面专用：出现即说明读到了对话记录
  const marker = String(lastInjected ?? '').trim()
  if (marker.length > 8 && value.includes(marker.slice(0, Math.min(60, marker.length)))) return true
  const newlines = (value.match(/\n/g) ?? []).length
  if (newlines >= 2) return true
  return value.trim().length >= (options.minTranscriptCharsStrong ?? 200) && !/^[a-z]+:\/\//i.test(value.trim())
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

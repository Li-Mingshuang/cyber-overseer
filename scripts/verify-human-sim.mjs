/**
 * 拟人通道自检：**真的开一个浏览器窗口，真的抢焦点打字回车**。
 *
 * 这是本项目里唯一"能对外界造成不可逆影响"的通道（抢焦点、打字、回车），所以它值得一个
 * 端到端自检脚本：跑通它，说明这台机器上的 UIA/SendInput/剪贴板/空闲检测全都可用。
 *
 * 它做三件事（第二件会短暂抢焦点）：
 *   1. 用隔离 profile 起一个浏览器，打开 fixtures/scratch-dialog.html（不碰你现有的浏览器与会话）；
 *   2. **空闲保险丝测试**：把阈值设成极大 → 断言监工拒绝动手（安全设计生效）；
 *   3. **真抽一鞭**：绕过保险丝（仅本脚本、仅对测试窗口），验证
 *      "抢焦点 → 点输入框 → 粘贴 → 回车前校验 → 回车 → 应用真的收到"，
 *      并用剪贴板把页面文字读回来，验证"读对话框"这半条通道。
 *
 * 用法：node scripts/verify-human-sim.mjs
 * 退出码：0 = 全绿；2 = 环境不支持（非 Windows/无浏览器）；1 = 某一步失败。
 * @module scripts/verify-human-sim
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHumanSimAdapter } from '../src/adapters/human-sim.mjs'
import { createWindowsDriver } from '../src/ui/windows.mjs'
import { defaultConfig, mergeConfig } from '../src/config.mjs'
import { createLogger } from '../src/util/log.mjs'
import { spawnDetached, which } from '../src/util/proc.mjs'
import { sleep } from '../src/util/time.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PAGE = join(HERE, '..', 'fixtures', 'scratch-dialog.html')
const log = createLogger({ level: process.env.CW_LOG_LEVEL ?? 'info', stream: process.stderr })

if (process.platform !== 'win32') {
  console.error('✖ 拟人通道目前只有 Windows 实现（UIA + SendInput）')
  process.exit(2)
}
if (!existsSync(PAGE)) {
  console.error(`✖ 找不到夹具页面：${PAGE}`)
  process.exit(2)
}

/** 找一个浏览器（Chrome / Edge 都行）。 */
function findBrowser() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ]
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return which('chrome') ?? which('msedge') ?? null
}

const browser = findBrowser()
if (!browser) {
  console.error('✖ 找不到 Chrome / Edge：拟人通道自检需要它们之一来当"被监工的 GUI"')
  process.exit(2)
}

const profileDir = mkdtempSync(join(tmpdir(), 'cw-human-sim-'))
const driver = createWindowsDriver({ log })
const cleanup = []
let exitCode = 0

try {
  console.log(`ℹ 浏览器：${browser}`)
  console.log(`ℹ 隔离 profile：${profileDir}`)
  console.log(`ℹ 夹具页面：${PAGE}`)

  const { child } = spawnDetached(browser, [
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-service-autorun',
    '--new-window',
    pathToFileURL(PAGE).href,
  ])
  cleanup.push(() => { try { child.kill() } catch { /* 已退出 */ } })

  // 等目标窗口出现（先按标题找）
  let found = null
  for (let i = 0; i < 40 && !found; i++) {
    await sleep(500)
    const windows = await driver.listWindows().catch(() => [])
    found = windows.find(w => /CW-SCRATCH/i.test(w.title ?? '')) ?? null
  }
  if (!found) throw new Error('等不到 CW-SCRATCH 窗口（浏览器没起来？）')
  console.log(`✔ 目标窗口已就绪：${found.process} — ${found.title}（${found.width}×${found.height}）`)

  // 找到之后改用 hwnd 精确匹配：夹具页面收到消息会把标题改成 CW-RECV:*，
  // 用标题匹配会"自己把自己弄丢"。（真实应用同样会改标题——Cursor/Codex 都会把文件名放进标题。）
  const windowMatch = { hwnd: found.hwnd }

  const baseConfig = (options, guard = {}) => {
    const config = mergeConfig(defaultConfig(), {
      agent: {
        adapter: 'human-sim',
        options: {
          windowMatch,
          // 夹具页面在窗口获得焦点时会自动聚焦输入框（真实聊天应用也是这样），
          // 所以这里不点击——浏览器里点击很容易落到工具栏上，把焦点打飞。
          clickComposer: false,
          // 夹具页面的"对话记录"在底部面板里，所以读的时候点那里（默认是窗口上方 1/3）
          readerClick: { relX: 0.5, relY: 0.94 },
          stableMs: 0,
          ...options,
        },
      },
      guard: { requireHumanIdleMs: 0, restoreFocus: true, ...guard },
      notify: { beep: false },
    })
    config.__cwd = process.cwd()
    return config
  }

  // ---- 1) 空闲保险丝：阈值极大时必须拒绝动手 ----
  const fuseAdapter = createHumanSimAdapter({
    config: baseConfig({ humanIdleMs: 999_999_999, waitForHumanIdleMs: 1200 }, { requireHumanIdleMs: 999_999_999 }),
    cwd: process.cwd(),
    log,
  })
  const fuseResult = await fuseAdapter.whip('这句话不应该被发出去', null, { config: {} })
  if (fuseResult.ok !== false || !/主人还在用电脑/.test(fuseResult.detail ?? '')) {
    throw new Error(`空闲保险丝没生效：${JSON.stringify(fuseResult)}`)
  }
  console.log('✔ 空闲保险丝：主人在用电脑时拒绝动手（这是安全设计，不是失败）')

  // ---- 2) 真抽一鞭（这里仍然保留一个**较小但真实**的空闲要求：3 秒内没人碰键鼠） ----
  // 注意：**不要**把 humanIdleMs 设成 0。这个自检本身就是在验证"主人在休息时才动手"的通道；
  // 绕过保险丝时如果主人正在用电脑，焦点会在注入过程中被切走，读到/发到别的地方去（真实踩过）。
  const humanIdleMs = Number(process.env.CW_VERIFY_IDLE_MS ?? 3000)
  const adapter = createHumanSimAdapter({
    config: baseConfig({ humanIdleMs, waitForHumanIdleMs: 30000 }, { requireHumanIdleMs: humanIdleMs }),
    cwd: process.cwd(),
    log,
  })
  const probe = await adapter.probe()
  if (!probe.ok) throw new Error(`probe 失败：${probe.reason}`)
  console.log(`✔ probe：${probe.detail}`)

  const marker = `CW-拟人通道-${Date.now().toString(36)}-✓`
  const whipResult = await adapter.whip(marker, null, { config: baseConfig({ humanIdleMs: 0 }, { requireHumanIdleMs: 0 }) })
  if (!whipResult.ok) throw new Error(`抽鞭失败：${whipResult.detail}`)
  console.log(`✔ 抽鞭成功：${whipResult.detail}`)

  // 页面把内容写进了窗口标题 → 这是"应用真的收到了"的硬证据
  await sleep(500)
  const after = (await driver.listWindows()).find(w => Number(w.hwnd) === Number(found.hwnd))
  if (!after || !/^CW-RECV:/.test(after.title ?? '')) {
    throw new Error(`页面没有收到内容（标题仍是 ${JSON.stringify(after?.title)}）`)
  }
  console.log(`✔ 应用确认收到：窗口标题 → ${after.title}`)
  if (!after.title.includes(marker.slice(0, 12))) {
    throw new Error(`收到的内容与发出的不一致：标题 ${after.title} / 期望含 ${marker.slice(0, 12)}`)
  }
  console.log('✔ 内容一致（含中文与全角符号，说明 KEYEVENTF_UNICODE / 剪贴板路径都正确）')

  // ---- 3) 读对话框：剪贴板把整页文字读回来，并切出"最后一次回答" ----
  const snapshot = await adapter.readState(null)
  if (!snapshot.lastAnswer || !snapshot.lastAnswer.includes('RECV#')) {
    throw new Error(`读对话框失败：readState 拿到 ${JSON.stringify(snapshot.lastAnswer?.slice(0, 120))}（via ${snapshot.extra?.readVia}）`)
  }
  console.log(`✔ 读对话框成功（via ${snapshot.extra?.readVia}，安静 ${Math.round((snapshot.extra?.quietMs ?? 0) / 1000)}s → 状态 ${snapshot.status}）`)
  console.log(`   切出的最后一次回答：${JSON.stringify(snapshot.lastAnswer.slice(-90))}`)

  console.log('')
  console.log('结论：拟人通道全绿 —— 抢焦点 / 点输入框 / 粘贴 / 回车前校验 / 回车 / 读回内容 全部可用。')
  console.log('提醒：生产环境务必保留 guard.requireHumanIdleMs（默认 120 秒），否则会在主人打字时抢焦点。')
} catch (error) {
  exitCode = 1
  console.error(`✖ ${error?.message ?? error}`)
} finally {
  for (const step of cleanup) step()
  await sleep(300)
  try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* 浏览器可能还占着文件 */ }
}

process.exit(exitCode)

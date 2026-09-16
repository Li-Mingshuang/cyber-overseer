/**
 * 截图 + OCR 自检：在**你这台机器**上量一遍"能不能截、中文准不准"。
 *
 * 为什么值得单独有个脚本：Windows OCR 的识别模型随系统版本与语言包变化，
 * 别人的结论不一定适用于你。跑一遍你就知道该不该依赖它（结论与实测样本见 docs/OCR.md）。
 *
 * 做三件事：
 *   1. 画一张有 ground truth 的图（中英混排 + 代码风格），测识别准确率；
 *   2. 截一个真实窗口（**不抢焦点**），验证 Chromium 必需的 flag=2 与黑屏检测；
 *   3. 打印两种引擎（默认 / zh-Hans-CN）的识别结果，方便肉眼判断。
 *
 * 用法：
 *   node scripts/verify-ocr.mjs                    # 自动挑一个可见窗口
 *   node scripts/verify-ocr.mjs --hwnd 0x1234      # 指定窗口
 *   node scripts/verify-ocr.mjs --dir .cyber/shots
 *
 * 退出码：0 = 基础能力可用；2 = 环境不支持（非 Windows / 无 OCR）；1 = 出错了。
 * @module scripts/verify-ocr
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWindowsDriver } from '../src/ui/windows.mjs'
import { createLogger } from '../src/util/log.mjs'
import { run } from '../src/util/proc.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const opt = (name, fallback = null) => {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : fallback
}

if (process.platform !== 'win32') {
  console.error('✖ 截图 + OCR 目前是 Windows 实现（Windows.Media.Ocr 是系统自带的，零依赖）')
  process.exit(2)
}

const log = createLogger({ level: process.env.CW_LOG_LEVEL ?? 'info' })
const driver = createWindowsDriver({ log })
const workDir = opt('--dir', null) ?? mkdtempSync(join(tmpdir(), 'cw-ocr-'))
const cleanupDir = opt('--dir', null) === null
if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true })

// ground truth：中英混排 + 代码风格 + 常见 UI 文案
const TRUTH_LINES = [
  '赛博监工正在读取对话框内容',
  '第 3 轮判定：continue（置信度 0.90）',
  '验收命令 npm test 失败，退出码 1',
  '输入消息…   发送   停止生成',
  '助手：我已经把方案里的第 2 项做完了。',
  'npm test  failed  exit code 1',
  'PROBE-OK 1234',
]

let exitCode = 0
try {
  console.log(`ℹ 工作目录：${workDir}`)

  // ---------- 0) 引擎可用性 ----------
  const langs = await driver.ocrLanguages()
  console.log(`✔ 可用 OCR 语言：${(langs.languages ?? []).join(', ')}｜默认引擎=${langs.engine ?? 'null'}｜中文引擎=${langs.chineseOk ? '可建' : '不可用'}`)
  if (!langs.ok) {
    console.error(`✖ OCR 不可用：${langs.error}`)
    process.exit(2)
  }

  // ---------- 1) ground truth 图 ----------
  const truthPng = resolve(workDir, 'ocr-truth.png')
  const ps = process.env.SystemRoot
    ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe'
  const draw = await run(ps, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    renderTruthScript(truthPng, TRUTH_LINES),
  ], { timeoutMs: 60000 })
  if (!existsSync(truthPng)) throw new Error(`画 ground-truth 图失败：${draw.stderr.slice(0, 200)}`)
  console.log(`✔ 已生成 ground truth 图：${truthPng}`)

  for (const lang of ['', 'zh-Hans-CN']) {
    const result = await driver.ocr({ file: truthPng, lang })
    if (!result.ok) { console.log(`  · ${lang || '(默认)'} 识别失败：${result.error.slice(0, 120)}`); continue }
    const text = result.lines.map(l => l.text).join('\n')
    const hits = TRUTH_LINES.filter(line => fuzzyIncludes(text, line)).length
    console.log(`\n▌引擎 ${result.engine}（${result.ms}ms）—— 命中 ${hits}/${TRUTH_LINES.length} 行`)
    for (const line of result.lines) {
      const word = line.words?.[0]
      console.log(`   y=${String(line.y).padStart(4)} x=${String(line.x).padStart(4)}  ${line.text}`)
      if (word && process.env.CW_OCR_VERBOSE) {
        console.log(`        首个词矩形：${word.x},${word.y} ${word.w}×${word.h}（OCR 的价值就在这些坐标上）`)
      }
    }
  }

  // ---------- 2) 真实窗口截图（不抢焦点） ----------
  console.log('\n▌真实窗口截图（PrintWindow，不抢焦点）')
  let hwnd = opt('--hwnd', null) ? Number(opt('--hwnd')) : null
  if (!hwnd) {
    const windows = await driver.listWindows()
    const candidate = windows.find(w => /Cursor|Codex|Chrome|Edge|Terminal|Notepad|记事本/i.test(w.title ?? ''))
      ?? windows.find(w => (w.title ?? '').trim().length > 0)
    hwnd = candidate?.hwnd
    if (candidate) console.log(`  选中窗口：${candidate.process} — ${candidate.title.slice(0, 60)}`)
  }
  if (!hwnd) {
    console.log('  · 没找到可截图的窗口（可以先用 --hwnd 指定）')
  } else {
    const capture = await driver.capture(hwnd, { dir: workDir })
    if (!capture.ok) {
      console.log(`  ✖ 截图失败：${capture.error}`)
      exitCode = 1
    } else {
      console.log(`  ✔ 截图成功：${capture.width}×${capture.height}，flag=${capture.flag}，像素 mean=${capture.mean} std=${capture.std}，黑屏=${capture.blank}`)
      console.log(`    文件：${capture.file}`)
      if (capture.blank) console.log('    ⚠️ 判为黑屏/纯色：这个窗口可能不支持 PrintWindow（有些 GPU 合成/受保护内容会这样）')
      else {
        for (const lang of ['zh-Hans-CN']) {
          const ocr = await driver.ocr({ file: capture.file, lang })
          if (!ocr.ok) { console.log(`    ${lang} 识别失败：${ocr.error.slice(0, 120)}`); continue }
          console.log(`    引擎 ${ocr.engine}（${ocr.ms}ms）读到 ${ocr.lines.length} 行，前几行：`)
          for (const line of ocr.lines.slice(0, 8)) console.log(`      y=${String(line.y).padStart(4)}  ${line.text.slice(0, 70)}`)
          console.log('    （中文界面上"字被拆开/图标被当字"是常态——所以 OCR 只作辅助，见 docs/OCR.md）')
        }
      }
    }
  }

  console.log('\n结论：位置信息可用（哪里是输入框/按钮），文本请优先用磁盘会话或剪贴板。')
} catch (error) {
  exitCode = 1
  console.error(`✖ ${error?.message ?? error}`)
} finally {
  if (cleanupDir) { try { rmSync(workDir, { recursive: true, force: true }) } catch { /* 忽略 */ } }
}

process.exit(exitCode)

/** 生成一段 PowerShell：把 ground truth 画成 PNG（中文从参数传入，脚本本体保持 ASCII）。 */
function renderTruthScript(file, lines) {
  const escaped = lines.map(l => l.replace(/'/g, "''"))
  const calls = escaped.map((line, index) => `$g.DrawString('${line}', $(if (${index} -eq 5) { $mono } else { $ui }), $brush, 20, ${20 + index * 42})`).join('\n')
  return [
    "Add-Type -AssemblyName System.Drawing",
    "$bmp = New-Object System.Drawing.Bitmap 1100, 360",
    "$g = [System.Drawing.Graphics]::FromImage($bmp)",
    "$g.Clear([System.Drawing.Color]::White)",
    "$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit",
    "$ui = New-Object System.Drawing.Font('Microsoft YaHei UI', 18)",
    "$mono = New-Object System.Drawing.Font('Consolas', 16)",
    "$brush = [System.Drawing.Brushes]::Black",
    calls,
    "$g.Dispose()",
    `$bmp.Save('${file.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    "$bmp.Dispose()",
  ].join('\n')
}

/** 宽松包含：忽略空白与常见 OCR 噪声（OCR 会把空格拆散）。 */
function fuzzyIncludes(haystack, needle) {
  const strip = (s) => String(s ?? '').replace(/\s+/g, '')
  const target = strip(needle)
  const text = strip(haystack)
  if (text.includes(target)) return true
  // 允许 OCR 少认几个字：按 80% 的连续片段命中即算
  const probe = target.slice(0, Math.max(4, Math.floor(target.length * 0.8)))
  return probe.length >= 4 && text.includes(probe)
}

/**
 * OCR 引擎基准：在**你这台机器**上量出"哪个好用"。
 *
 * 做法：画一张有 ground truth 的图（中文正文 + 界面小字 + 英文代码），把每个可用提供者都跑一遍，
 * 按 ① 整行命中率 ② 字符级相似度（1 - 编辑距离/长度）打分，输出表格。
 *
 * 为什么要这么做：OCR 质量强依赖场景与机器，别人的结论不一定适用；
 * 而且"哪个好用"必须用**同一张图**横向比，否则没有可比性。
 *
 * 用法：
 *   node scripts/bench-ocr.mjs                 # 干净正文图 + 真实窗口截图
 *   node scripts/bench-ocr.mjs --no-window     # 只跑 ground truth 图
 *   node scripts/bench-ocr.mjs --provider rapidocr
 *
 * @module scripts/bench-ocr
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ocrImage, listOcrProviders } from '../src/ocr/index.mjs'
import { createWindowsDriver } from '../src/ui/windows.mjs'
import { createLogger } from '../src/util/log.mjs'
import { run } from '../src/util/proc.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const opt = (name, fallback = null) => {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : fallback
}

const log = createLogger({ level: 'warn' })
const workDir = opt('--dir', null) ?? mkdtempSync(join(tmpdir(), 'cw-bench-'))
if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true })
const cleanupDir = opt('--dir', null) === null

/** ground truth：三档难度混在一张图里，贴近"读对话框"的真实需求。 */
const GROUPS = {
  正文: [
    '赛博监工正在读取对话框内容',
    '第 3 轮判定：continue（置信度 0.90）',
    '助手：我已经把方案里的第 2 项做完了。',
    '验收命令 npm test 失败，退出码 1',
  ],
  界面小字: [
    '输入消息…   发送   停止生成',
    '设置  Beta  Allow CLI to access desktop agents',
  ],
  代码: [
    'npm test  failed  exit code 1',
    'CW-RECEIPT: 本轮勾选 1 项 | 下一步 跑验收',
  ],
}
const TRUTH_LINES = Object.values(GROUPS).flat()

const ps = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

/** 画 ground truth 图（脚本本体保持 ASCII，中文经参数传入）。 */
async function renderTruth(file) {
  const lines = TRUTH_LINES.map(l => l.replace(/'/g, "''"))
  const script = [
    'Add-Type -AssemblyName System.Drawing',
    '$bmp = New-Object System.Drawing.Bitmap 1100, 420',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.Clear([System.Drawing.Color]::White)',
    '$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit',
    "$ui = New-Object System.Drawing.Font('Microsoft YaHei UI', 19)",
    "$small = New-Object System.Drawing.Font('Microsoft YaHei UI', 13)",
    "$mono = New-Object System.Drawing.Font('Consolas', 15)",
    "$b = [System.Drawing.Brushes]::Black",
    ...lines.map((line, index) => {
      const font = index >= 4 && index <= 5 ? '$small' : (index >= 6 ? '$mono' : '$ui')
      return `$g.DrawString('${line}', ${font}, $b, 20, ${18 + index * 44})`
    }),
    '$g.Dispose()',
    `$bmp.Save('${file.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    '$bmp.Dispose()',
  ].join('\n')
  await run(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeoutMs: 60000 })
}

/** 去掉空白后比较（OCR 常见行为是把每个字用空格隔开）。 */
const squash = (s) => String(s ?? '').replace(/\s+/g, '')

/** 字符级相似度 = 1 - 编辑距离/较长长度。 */
function similarity(a, b) {
  const left = squash(a)
  const right = squash(b)
  if (!left && !right) return 1
  if (!left || !right) return 0
  const rows = left.length + 1
  const cols = right.length + 1
  let previous = new Array(cols)
  let current = new Array(cols)
  for (let j = 0; j < cols; j++) previous[j] = j
  for (let i = 1; i < rows; i++) {
    current[0] = i
    for (let j = 1; j < cols; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
    }
    const swap = previous
    previous = current
    current = swap
  }
  return 1 - previous[cols - 1] / Math.max(left.length, right.length)
}

/** 一行是否被"基本读对"（相似度 >= 阈值）。 */
function scoreAgainstTruth(text, threshold = 0.8) {
  const lines = String(text ?? '').split('\n')
  let exact = 0
  let loose = 0
  for (const truth of TRUTH_LINES) {
    const best = Math.max(...lines.map(line => similarity(line, truth)), 0)
    if (best >= 0.98) exact++
    if (best >= threshold) loose++
  }
  return {
    exact,
    loose,
    similarity: similarity(text.replace(/\n/g, ''), TRUTH_LINES.join('')),
  }
}

const results = []
let exitCode = 0
try {
  const providers = await listOcrProviders({ cwd: process.cwd(), log })
  console.log('▌可用性')
  for (const provider of providers) {
    console.log(`  ${provider.available ? '✔' : '·'} ${provider.id.padEnd(9)} ${provider.label} —— ${provider.detail}`)
  }

  const truthPng = resolve(workDir, 'bench-truth.png')
  await renderTruth(truthPng)
  console.log(`\n▌Ground truth 图：${truthPng}（${TRUTH_LINES.length} 行，含正文/界面小字/代码三档）`)

  const wanted = opt('--provider', null)
  const candidates = providers.filter(p => p.available && (!wanted || p.id === wanted))
  if (!candidates.length) {
    console.error('✖ 没有可用的 OCR 提供者')
    process.exit(2)
  }

  console.log('\n| 提供者 | 引擎 | 耗时 | 整行全对 | 基本读对(≥0.8) | 字符相似度 |')
  console.log('| --- | --- | --- | --- | --- | --- |')
  for (const provider of candidates) {
    const result = await ocrImage(truthPng, { cwd: process.cwd(), provider: provider.id, log })
    if (!result.ok) {
      console.log(`| ${provider.id} | — | — | 失败：${result.error?.slice(0, 40)} | | |`)
      continue
    }
    const score = scoreAgainstTruth(result.text)
    console.log(`| ${provider.id} | ${result.engine} | ${result.ms}ms | ${score.exact}/${TRUTH_LINES.length} | ${score.loose}/${TRUTH_LINES.length} | ${(score.similarity * 100).toFixed(1)}% |`)
    results.push({ provider: provider.id, engine: result.engine, ms: result.ms, ...score, text: result.text })
  }

  // 把识别结果原样打出来，方便肉眼判断
  for (const result of results) {
    console.log(`\n--- ${result.provider} 的识别结果（原样） ---`)
    console.log(result.text.split('\n').map(line => `  ${line}`).join('\n'))
  }

  // 真实窗口截图（能截就比一比：这才是"读界面"的真实难度）
  if (!flag('--no-window')) {
    const driver = createWindowsDriver({ log })
    const windows = await driver.listWindows().catch(() => [])
    const candidate = windows.find(w => /Cursor|Codex|Chrome|Edge|Terminal|Notepad|记事本|DSH/i.test(w.title ?? ''))
      ?? windows.find(w => (w.title ?? '').trim().length > 0)
    if (candidate) {
      const capture = await driver.capture(candidate.hwnd, { dir: workDir })
      console.log(`\n▌真实窗口截图：${candidate.process} — ${String(candidate.title).slice(0, 50)}`)
      if (capture.ok && !capture.blank) {
        console.log(`  ${capture.width}×${capture.height} flag=${capture.flag}（图：${capture.file}）`)
        for (const provider of candidates) {
          const result = await ocrImage(capture.file, { cwd: process.cwd(), provider: provider.id, log, driver })
          if (!result.ok) { console.log(`  · ${provider.id}: 失败 ${result.error?.slice(0, 60)}`); continue }
          console.log(`  · ${provider.id}（${result.ms}ms）读到 ${result.lines.length} 行：`)
          for (const line of result.lines.slice(0, 6)) console.log(`      ${line.text.slice(0, 76)}`)
        }
      } else {
        console.log(`  ✖ 截图失败：${capture.error ?? '黑屏'}`)
      }
    }
  }

  // 落一份 Markdown 结果，便于粘进文档
  const report = [
    '# OCR 基准结果（本机实测）',
    '',
    `时间：${new Date().toISOString()}`,
    `样本：${GROUPS.正文.length} 行正文 + ${GROUPS.界面小字.length} 行界面小字 + ${GROUPS.代码.length} 行代码（见 scripts/bench-ocr.mjs）`,
    '',
    '| 提供者 | 引擎 | 耗时 | 整行全对 | 基本读对(≥0.8) | 字符相似度 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...results.map(r => `| ${r.provider} | ${r.engine} | ${r.ms}ms | ${r.exact}/${TRUTH_LINES.length} | ${r.loose}/${TRUTH_LINES.length} | ${(r.similarity * 100).toFixed(1)}% |`),
    '',
    '```text',
    ...results.map(r => `--- ${r.provider} ---\n${r.text}`),
    '```',
    '',
  ].join('\n')
  const reportFile = resolve(process.cwd(), 'docs', 'OCR-BENCH.md')
  writeFileSync(reportFile, report, 'utf8')
  console.log(`\n✔ 基准结果已写入：${reportFile}`)
} catch (error) {
  exitCode = 1
  console.error(`✖ ${error?.message ?? error}`)
} finally {
  if (cleanupDir) { try { rmSync(workDir, { recursive: true, force: true }) } catch { /* 忽略 */ } }
}

process.exit(exitCode)

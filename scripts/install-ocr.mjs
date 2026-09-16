/**
 * 一键安装"好用的 OCR"（RapidOCR）。
 *
 * 为什么默认选它：本仓库用同一张图做过横向基准（`npm run bench:ocr`，结果见 docs/OCR-BENCH.md）——
 * 中文正文的字符相似度 **96.4%** vs Windows 自带 OCR 的 **53.7%**，整行可读率 7/8 vs 2/8。
 * 代价是多一个 Python 依赖与约 10 倍耗时（CPU 上每张图 3~4 秒），对"每几分钟看一眼"的监工完全够用。
 *
 * 它做的三件事：
 *   1. 在**仓库内**建一个隔离 venv（`.tools/ocr-venv`）——不污染你的 conda/系统 Python；
 *   2. `pip install rapidocr-onnxruntime`（模型随包自带，装完可离线用）；
 *   3. 自检一次：印一张中英混排图并识别，把结果打出来给你看。
 *
 * 用法：
 *   node scripts/install-ocr.mjs                     # 默认装到 .tools/ocr-venv
 *   node scripts/install-ocr.mjs --proxy http://127.0.0.1:7890
 *   node scripts/install-ocr.mjs --mirror https://pypi.tuna.tsinghua.edu.cn/simple
 *
 * @module scripts/install-ocr
 */

import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { run, which } from '../src/util/proc.mjs'
import { ocrImage } from '../src/ocr/index.mjs'
import { createLogger } from '../src/util/log.mjs'

const argv = process.argv.slice(2)
const opt = (name, fallback = null) => {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : fallback
}

const log = createLogger({ level: 'info' })
const cwd = process.cwd()
const venvDir = resolve(opt('--venv', join(cwd, '.tools', 'ocr-venv')))
const proxy = opt('--proxy', process.env.HTTPS_PROXY ?? process.env.https_proxy ?? null)
const mirror = opt('--mirror', process.env.CW_PIP_INDEX ?? null)

/** 系统代理（Windows 注册表）——用户往往只配了系统代理，pip 默认不认。 */
async function detectSystemProxy() {
  if (process.platform !== 'win32') return null
  const result = await run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyServer'], { timeoutMs: 15000 })
  const match = /ProxyServer\s+REG_SZ\s+(\S+)/.exec(result.stdout)
  return match ? `http://${match[1]}` : null
}

const basePython = which('python') ?? which('python3')
if (!basePython) {
  console.error('✖ 找不到 Python。装一个（python.org 或 conda）后重跑本脚本。')
  process.exit(2)
}

const venvPython = process.platform === 'win32'
  ? join(venvDir, 'Scripts', 'python.exe')
  : join(venvDir, 'bin', 'python')

let effectiveProxy = proxy
if (!effectiveProxy) {
  effectiveProxy = await detectSystemProxy()
  if (effectiveProxy) log.info(`检测到系统代理：${effectiveProxy}（pip 默认不使用它，这里显式传 --proxy）`)
}

try {
  if (!existsSync(venvPython)) {
    log.step(`创建隔离 venv：${venvDir}`)
    if (!existsSync(venvDir)) mkdirSync(venvDir, { recursive: true })
    const created = await run(basePython, ['-m', 'venv', venvDir], { timeoutMs: 300000 })
    if (!existsSync(venvPython)) throw new Error(`venv 创建失败：${created.stderr.slice(0, 300)}`)
  } else {
    log.info(`复用已有 venv：${venvDir}`)
  }
  log.ok(`Python：${venvPython}`)

  const pipArgs = ['-m', 'pip', 'install', '--upgrade', 'rapidocr-onnxruntime']
  if (mirror) pipArgs.push('-i', mirror)
  if (effectiveProxy) pipArgs.push('--proxy', effectiveProxy)

  const check = await run(venvPython, ['-c', 'import rapidocr_onnxruntime'], { timeoutMs: 60000 })
  if (check.code === 0) {
    log.ok('rapidocr-onnxruntime 已安装，跳过下载')
  } else {
    log.step(`安装 rapidocr-onnxruntime（含 PP-OCR 模型，约 60MB）…`)
    const installed = await run(venvPython, pipArgs, {
      timeoutMs: 1800000,
      onStdout: chunk => { const line = chunk.trim(); if (line && !line.startsWith('  ')) log.raw(`  ${line.slice(0, 120)}`) },
    })
    if (installed.code !== 0) {
      throw new Error(`pip 安装失败（退出码 ${installed.code}）：${installed.stderr.slice(-500)}`
        + '\n提示：国内网络可加 --mirror https://pypi.tuna.tsinghua.edu.cn/simple，或 --proxy http://127.0.0.1:7890')
    }
  }

  // 自检：画一张中英混排图 → 识别 → 打印
  const ps = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const sampleDir = join(cwd, '.tools')
  const sample = join(sampleDir, 'ocr-selftest.png')
  await run(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', [
    'Add-Type -AssemblyName System.Drawing',
    '$b = New-Object System.Drawing.Bitmap 900, 160',
    '$g = [System.Drawing.Graphics]::FromImage($b)',
    '$g.Clear([System.Drawing.Color]::White)',
    "$f = New-Object System.Drawing.Font('Microsoft YaHei UI', 20)",
    "$g.DrawString('赛博监工：RapidOCR 安装成功', $f, [System.Drawing.Brushes]::Black, 20, 20)",
    "$g.DrawString('npm test  failed  exit code 1', $f, [System.Drawing.Brushes]::Black, 20, 80)",
    '$g.Dispose()',
    `$b.Save('${sample.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    '$b.Dispose()',
  ].join('\n')], { timeoutMs: 60000 })

  log.step('自检识别…')
  const result = await ocrImage(sample, { cwd, provider: 'rapidocr' })
  if (!result.ok) throw new Error(`自检失败：${result.error}`)
  log.ok(`识别成功（${result.engine}，${result.ms}ms）：`)
  for (const line of result.lines) log.raw(`  ${line.text}`)

  console.log('')
  console.log('完成。监工现在默认优先使用 RapidOCR；要改回系统自带 OCR，在配置里写：')
  console.log("  export default { ocr: { provider: 'windows' } }")
  console.log('想对比不同引擎的准确率：npm run bench:ocr')
} catch (error) {
  console.error(`\n✖ ${error?.message ?? error}`)
  process.exit(1)
}

/**
 * 给所有 .ps1 补 UTF-8 BOM。
 *
 * 为什么需要它：Windows PowerShell 5.1（每台 Windows 都自带、也是拟人驱动的运行时）**没有 BOM 时
 * 会按系统 ANSI 代码页（中文机器上是 GBK）读取脚本**。脚本里的中文注释会被读成乱码，
 * 乱码里出现的引号/大括号会直接破坏解析——症状是"代码看着完全正常，一执行就报语法错误"，
 * 而且报错信息本身也是乱码，极难定位。（这个坑在本项目里真实踩过两次。）
 *
 * 所以：`src/ui/win/*.ps1` 一律带 BOM；`scripts/lint.mjs` 会强制检查，
 * 编辑这些文件之后如果 BOM 掉了，跑一下本脚本即可：
 *
 *   node scripts/fix-ps1-bom.mjs
 *
 * @module scripts/fix-ps1-bom
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BOM = Buffer.from([0xef, 0xbb, 0xbf])
const targets = []

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', '.git', '.recon-tmp', '.cyber', 'artifacts'].includes(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) { walk(full); continue }
    if (entry.endsWith('.ps1')) targets.push(full)
  }
}

walk(ROOT)

let fixed = 0
for (const file of targets) {
  const buf = readFileSync(file)
  if (buf.subarray(0, 3).equals(BOM)) continue
  writeFileSync(file, Buffer.concat([BOM, buf]))
  console.log(`✔ 已补 BOM：${relative(ROOT, file)}`)
  fixed++
}

console.log(fixed ? `共修复 ${fixed} 个文件。` : `全部 ${targets.length} 个 .ps1 都已带 BOM。`)

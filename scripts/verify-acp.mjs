/**
 * ACP 通道自检：**不花一分钱**地验证"监工能不能跟这个 agent 的 ACP 端说上话"。
 *
 * 它只做握手（`initialize` → `session/new` → `session/cancel`），**绝不发送 prompt**，
 * 所以不会调用任何模型、不消耗额度。跑通它，就说明抽鞭之前的全部前置条件都成立了。
 *
 * 用法：
 *   node scripts/verify-acp.mjs                       # 自动找 DSH（DSH_CHECKOUT 或常见路径）
 *   node scripts/verify-acp.mjs --preset opencode
 *   node scripts/verify-acp.mjs --command "node <path>/bin.js --config examples/acp-agent/cordis.yml"
 *   node scripts/verify-acp.mjs --cwd <harness目录> --workspace <被监工的项目目录>
 *
 * 退出码：0 = 握手成功；2 = 找不到入口/参数不对；1 = 协议或进程出错。
 * @module scripts/verify-acp
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { JsonRpcStdioClient } from '../src/util/jsonrpc-stdio.mjs'
import { createLogger } from '../src/util/log.mjs'
import { which } from '../src/util/proc.mjs'

const argv = process.argv.slice(2)
const opt = (name, fallback = null) => {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : fallback
}
const flag = (name) => argv.includes(name)

const workspace = resolve(opt('--workspace', process.cwd()))
const preset = opt('--preset', null)
const explicitCommand = opt('--command', null)
const log = createLogger({ level: flag('--verbose') ? 'debug' : 'info' })

/** 推测 DSH 的 ACP 入口（不猜就直说找不到）。 */
function guessDsh() {
  const candidates = [
    process.env.DSH_CHECKOUT,
    process.env.DSH_ACP_CHECKOUT,
    'C:\\myFiles\\codes\\github\\deepseek-harness',
    join(homedir(), 'deepseek-harness'),
    join(process.cwd(), '..', 'deepseek-harness'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    const checkout = resolve(candidate)
    const bin = join(checkout, 'packages', 'examples', 'acp-demo', 'lib', 'bin.js')
    if (existsSync(bin)) return { checkout, bin }
  }
  return null
}

let command
let args
let launchCwd = opt('--cwd', null)

if (explicitCommand) {
  const parts = explicitCommand.split(' ').map(s => s.trim()).filter(Boolean)
  command = parts[0]
  args = parts.slice(1)
  launchCwd = launchCwd ?? workspace
} else if (preset === 'opencode') {
  command = which('opencode') ?? 'opencode'
  args = ['acp']
  launchCwd = launchCwd ?? workspace
} else {
  const dsh = guessDsh()
  if (!dsh) {
    console.error('✖ 找不到 DSH 的 ACP 入口。请用 --command 或 --preset 指定，例如：')
    console.error('  node scripts/verify-acp.mjs --preset opencode')
    console.error('  node scripts/verify-acp.mjs --command "node <harness>/packages/examples/acp-demo/lib/bin.js --config examples/acp-agent/cordis.yml" --cwd <harness>')
    process.exit(2)
  }
  command = process.execPath
  args = [dsh.bin, '--config', 'examples/acp-agent/cordis.yml']
  // 关键：DSH 的 --config 是相对路径 → 进程必须从 harness 仓库根启动
  launchCwd = launchCwd ?? dsh.checkout
  console.log(`ℹ 使用 DSH ACP 入口：${dsh.bin}`)
}

console.log(`ℹ 启动命令：${command} ${args.join(' ')}`)
console.log(`ℹ 启动目录：${launchCwd}`)
console.log(`ℹ 工作区（session/new 的 cwd）：${workspace}`)
if (launchCwd && !isAbsolute(launchCwd)) process.exit(2)

const client = new JsonRpcStdioClient({
  command,
  args,
  cwd: launchCwd ?? workspace,
  name: 'verify-acp',
  log,
  requestTimeoutMs: 90000,
})

let failed = false
try {
  const init = await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
  console.log(`✔ initialize：${JSON.stringify(init)}`)
  const session = await client.request('session/new', { cwd: workspace, mcpServers: [] })
  if (!session?.sessionId) throw new Error(`session/new 没有返回 sessionId：${JSON.stringify(session)}`)
  console.log(`✔ session/new：sessionId=${session.sessionId}`)
  client.notify('session/cancel', { sessionId: session.sessionId })
  console.log('✔ 已发送 session/cancel')
  console.log('')
  console.log('结论：ACP 通道可用（本次握手未发送任何 prompt，零 token 消耗）。')
  console.log('要让它真正开始干活，把 cw.config.mjs 的 agent.adapter 设为 "acp" 并配好 preset/command 即可。')
} catch (error) {
  failed = true
  console.error(`✖ ACP 握手失败：${error?.message ?? error}`)
  if (client.stderrTail) console.error(`子进程 stderr（尾部）：\n${client.stderrTail.slice(-800)}`)
  console.error('常见原因：① 入口路径不对 ② 启动目录不对（DSH 的 --config 是相对路径）③ 缺 DEEPSEEK_API_KEY')
} finally {
  await client.stop().catch(() => {})
}

process.exit(failed ? 1 : 0)

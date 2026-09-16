/**
 * MCP 信箱服务端 + Cursor 钩子的协议级测试。
 *
 * 这两条通道的"契约"很脆弱（一个是 JSON-RPC over stdio，一个是钩子的 stdout 必须只有 JSON），
 * 所以用真实输入输出把它们钉住——回归时最先坏的就是这类地方。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cursorHooksConfig, installCursorHooks, handleHook } from '../src/hooks.mjs'
import { createLogger } from '../src/util/log.mjs'
import { defaultConfig, mergeConfig } from '../src/config.mjs'
import { parsePlan } from '../src/plan.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const quiet = createLogger({ level: 'error', stream: { write() {} }, errStream: { write() {} } })

/** 用 stdio 起一个 MCP 服务端，发一批 JSON-RPC，收回应。 */
function mcpSession(cwd, requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, 'bin', 'cw.mjs'), 'mcp', '--serve', '--cwd', cwd], {
      cwd, stdio: ['pipe', 'pipe', 'pipe'],
    })
    const responses = []
    let buffer = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (!line) continue
        try { responses.push(JSON.parse(line)) } catch { /* 忽略非 JSON 行 */ }
      }
    })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.on('error', reject)
    child.on('close', () => resolve({ responses, stderr }))
    for (const request of requests) child.stdin.write(JSON.stringify(request) + '\n')
    child.stdin.end()
    setTimeout(() => { try { child.kill() } catch { /* 已退出 */ } }, 8000)
  })
}

test('MCP：initialize / tools/list / overseer_check / overseer_report 全链路', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-mcp-'))
  const result = await mcpSession(dir, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'overseer_check', arguments: {} } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'overseer_report', arguments: { summary: '做完了第一项', files: ['a.ts'] } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: '不存在的工具', arguments: {} } },
  ])

  const byId = new Map(result.responses.map(r => [r.id, r]))
  assert.ok(byId.get(1)?.result?.serverInfo?.name === 'cyber-overseer', 'initialize 应返回服务信息')
  assert.equal(byId.get(1).result.capabilities.tools !== undefined, true)

  const toolNames = byId.get(2).result.tools.map(t => t.name)
  assert.deepEqual(toolNames, ['overseer_check', 'overseer_report'])

  assert.match(byId.get(3).result.content[0].text, /监工暂时没有新指令|PLAN\.md/)
  assert.equal(byId.get(4).result.content[0].text, '已记录。')

  const reportFile = join(dir, '.cyber', 'agent-reports.jsonl')
  assert.ok(existsSync(reportFile), '汇报应落盘')
  const report = JSON.parse(readFileSync(reportFile, 'utf8').trim())
  assert.equal(report.summary, '做完了第一项')
  assert.deepEqual(report.files, ['a.ts'])

  assert.ok(byId.get(5).error, '未知工具应返回 JSON-RPC 错误')
  rmSync(dir, { recursive: true, force: true })
})

test('MCP：写好的信箱指令会被 overseer_check 取出', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-mcp2-'))
  mkdirSync(join(dir, '.cyber'), { recursive: true })
  writeFileSync(join(dir, '.cyber', 'inbox-instruction.md'), '# 赛博监工指令（第 2 轮）\n\n把第 2 项做完。\n', 'utf8')
  const result = await mcpSession(dir, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'overseer_check', arguments: {} } },
  ])
  const check = result.responses.find(r => r.id === 2)
  assert.match(check.result.content[0].text, /把第 2 项做完/)
  rmSync(dir, { recursive: true, force: true })
})

test('Cursor 钩子配置：schema 与官方一致（version/hooks/stop/loop_limit）', () => {
  const config = cursorHooksConfig({
    cwd: 'C:/proj', cliPath: 'C:/cw/bin/cw.mjs', nodePath: 'C:/node/node.exe', loopLimit: 10,
  })
  assert.equal(config.version, 1)
  assert.ok(Array.isArray(config.hooks.stop))
  const stop = config.hooks.stop[0]
  assert.match(stop.command, /hook cursor-stop/)
  assert.equal(stop.loop_limit, 10)
  assert.equal(stop.failClosed, false)
  assert.ok(config.hooks.afterAgentResponse, '默认同时装 afterAgentResponse 以便读取回答')
})

test('Cursor 钩子安装：幂等，已存在时不覆盖', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-hooks-'))
  const first = installCursorHooks({ cwd: dir, cliPath: join(ROOT, 'bin', 'cw.mjs'), log: quiet })
  assert.equal(first.created, true)
  const second = installCursorHooks({ cwd: dir, cliPath: join(ROOT, 'bin', 'cw.mjs'), log: quiet })
  assert.equal(second.ok, false)
  assert.match(second.message, /最新|已存在/)
  rmSync(dir, { recursive: true, force: true })
})

test('钩子回调：stop 事件在"还没干完"时返回 followup_message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-hook-'))
  writeFileSync(join(dir, 'PLAN.md'), '# 测试\n## 目标\n把测试做完。\n## 验收标准\n- 产物存在\n## 任务清单\n- [ ] 第一项\n- [ ] 第二项\n', 'utf8')
  writeFileSync(join(dir, 'cw.config.mjs'), `export default {
  plan: 'PLAN.md',
  agent: { adapter: 'fake', cwd: ${JSON.stringify(dir)}, options: { stateFile: ${JSON.stringify(join(dir, '.cyber', 'fake.json'))} } },
  judge: { kind: 'rule' },
  evidence: { git: false, verify: [] },
  guard: { quietHours: null, maxRounds: 5 },
  journal: { dir: ${JSON.stringify(join(dir, '.cyber'))}, reportFile: 'CW-REPORT.md' },
}
`, 'utf8')

  const result = await handleHook({
    agent: 'cursor', event: 'stop',
    payload: { conversation_id: 'conv-1', loop_count: 0, status: 'completed' },
    cwd: dir, log: quiet,
  })
  assert.ok(result.output.followup_message, '未完成时应回话继续抽')
  assert.match(result.output.followup_message, /CW-RECEIPT|第一项|还没到收工/)
  assert.equal(result.verdict.status, 'continue')

  // 达到轮次上限后不再回话（让 Cursor 的循环停下）
  const capped = await handleHook({
    agent: 'cursor', event: 'stop',
    payload: { conversation_id: 'conv-1', loop_count: 5, status: 'completed' },
    cwd: dir, log: quiet,
  })
  assert.deepEqual(capped.output, {})
  assert.match(capped.reason, /轮次上限/)
  rmSync(dir, { recursive: true, force: true })
})

test('钩子回调：afterAgentResponse 把回答落盘（供 cw run 读取）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-hook2-'))
  const result = await handleHook({
    agent: 'cursor', event: 'response',
    payload: { conversation_id: 'c1', generation_id: 'g1', text: '我完成了第二步。' },
    cwd: dir, log: quiet,
  })
  assert.deepEqual(result.output, {})
  const file = join(dir, '.cyber', 'cursor-events.jsonl')
  assert.ok(existsSync(file))
  const record = JSON.parse(readFileSync(file, 'utf8').trim())
  assert.equal(record.text, '我完成了第二步。')
  rmSync(dir, { recursive: true, force: true })
})

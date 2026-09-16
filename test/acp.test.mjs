/**
 * ACP 适配器协议测试（对着 test/fixtures/fake-acp-agent.mjs 跑真进程）。
 *
 * 钉住这几件事：
 *   - initialize → session/new → session/prompt 的**顺序**（DSH 实测：服务端不串行化帧，
 *     客户端必须先等 initialize 响应，否则会踩竞态）；
 *   - 同一连接的**多轮**复用（监工连抽多鞭时不该每轮新建会话）；
 *   - `agent_message_chunk` 通知的拼接（ACP 只给成文文本）；
 *   - `session/request_permission` 反向请求的 fail-closed（默认拒绝）与 autoApprove 放行；
 *   - 错误帧映射成 ok:false；dispose 之后进程真的退出（不留孤儿）。
 *
 * 注意每个用例都用 t.after 保证 dispose：ACP 适配器持有子进程，一旦泄漏，
 * 事件循环不会退出、测试会整个挂住（这不是假设，是本文件第一版就踩到的坑）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAcpAdapter } from '../src/adapters/acp.mjs'
import { defaultConfig, mergeConfig } from '../src/config.mjs'
import { createLogger } from '../src/util/log.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
// 夹具在仓库根的 fixtures/，**不能**放进 test/：Node 会把 test/ 下所有 .mjs 当测试文件跑，
// 而这个夹具是常驻 stdio 服务端（不退出），会让 runner 挂死。
const FIXTURE = join(HERE, '..', 'fixtures', 'fake-acp-agent.mjs')
const quiet = createLogger({ level: 'error', stream: { write() {} }, errStream: { write() {} } })

function setup(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cw-acp-'))
  const logFile = join(dir, 'acp-frames.jsonl')
  const config = mergeConfig(defaultConfig(), {
    agent: {
      adapter: 'acp',
      options: {
        command: [process.execPath, FIXTURE],
        env: { FAKE_ACP_LOG: logFile },
        startTimeoutMs: 20000,
      },
    },
    guard: { maxRounds: 5, autoApprove: false, ...(overrides.guard ?? {}) },
  })
  config.__cwd = dir
  if (overrides.options) Object.assign(config.agent.options, overrides.options)
  const adapter = createAcpAdapter({ config, cwd: dir, log: quiet })
  const frames = () => (existsSync(logFile)
    ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    : [])
  // 无论断言是否失败都收尾：否则子进程会吊住整个测试进程
  t.after(async () => {
    await adapter.dispose().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, config, adapter, frames }
}

test('ACP：probe 能识别可用的 ACP 端与未替换的占位符', async (t) => {
  const good = setup(t)
  const probe = await good.adapter.probe()
  assert.equal(probe.ok, true)
  assert.match(probe.detail, /ACP 端/)

  const bad = setup(t, { options: { command: ['node', '<deepseek-harness>/x.js'], dshCheckout: undefined } })
  const badProbe = await bad.adapter.probe()
  assert.equal(badProbe.ok, false)
  assert.match(badProbe.reason, /占位符/)
})

test('ACP：未连接时 readState 是空闲的（不报错）', async (t) => {
  const { adapter } = setup(t)
  const snapshot = await adapter.readState(await adapter.resolveSession())
  assert.equal(snapshot.status, 'idle')
  assert.equal(snapshot.lastAnswer, '')
  assert.ok(snapshot.extra.acp)
})

test('ACP：一鞭 = 一次 session/prompt（前台跑完），回答由 chunk 拼成', async (t) => {
  const { adapter, frames } = setup(t)
  const session = await adapter.resolveSession()
  const result = await adapter.whip('把第一步做完。', session, { config: { guard: {} } })

  assert.equal(result.ok, true)
  assert.equal(result.mode, 'foreground', 'ACP 的 prompt 会一直等到回合结束，所以是前台模式')
  assert.match(result.answer, /假 ACP 收到：把第一步做完/)
  assert.match(result.answer, /我做完了这一步/)

  // 协议顺序：initialize 必须在 session/prompt 之前（服务端不串行化帧，抢跑会踩竞态）
  const methods = frames().filter(f => f.dir === 'in' && f.method).map(f => f.method)
  assert.equal(methods[0], 'initialize')
  assert.equal(methods[1], 'session/new')
  assert.equal(methods[2], 'session/prompt')

  // 回答落进状态，下一轮判定用得到
  const snapshot = await adapter.readState(session)
  assert.equal(snapshot.status, 'idle')
  assert.equal(snapshot.lastAnswer, result.answer)
  assert.equal(snapshot.extra.lastStopReason, 'end_turn')
})

test('ACP：同一连接复用会话（连抽多鞭不重建），且能读到每次的新回答', async (t) => {
  const { adapter, frames } = setup(t)
  const session = await adapter.resolveSession()
  const first = await adapter.whip('做第一项', session, { config: { guard: {} } })
  const second = await adapter.whip('做第二项', session, { config: { guard: {} } })

  assert.match(first.answer, /做第一项/)
  assert.match(second.answer, /做第二项/)

  // 只数"客户端 → 服务端"方向的帧（夹具自己的出站帧、以及它给 prompt 记的详细条目都会写进同一个日志）
  const inbound = (method) => frames().filter(f => f.dir === 'in' && f.method === method).length
  assert.equal(inbound('initialize'), 1, 'initialize 只应发生一次')
  assert.equal(inbound('session/new'), 1, 'session/new 只应发生一次（同一会话连抽两鞭）')
  assert.equal(frames().filter(f => f.dir === 'in' && f.method === 'session/prompt' && typeof f.text === 'string').length, 2)

  const snapshot = await adapter.readState(session)
  assert.equal(snapshot.turn, 2)
  assert.match(snapshot.lastAnswer, /做第二项/)
})

test('ACP：权限请求默认被拒绝（fail-closed），guard.autoApprove=true 才放行', async (t) => {
  const rejectCase = setup(t)
  await rejectCase.adapter.whip('PERMISSION 然后继续', await rejectCase.adapter.resolveSession(), { config: { guard: {} } })
  const rejected = rejectCase.frames().find(f => f.method === 'permission-response')
  assert.ok(rejected, '应当看到客户端对权限请求的响应')
  assert.equal(rejected.result.outcome.optionId, 'reject-once')
  const rejectSnapshot = await rejectCase.adapter.readState(null)
  assert.equal(rejectSnapshot.extra.rejections, 1)
  assert.equal(rejectSnapshot.extra.approvals, 0)

  const allowCase = setup(t, { guard: { autoApprove: true } })
  await allowCase.adapter.whip('PERMISSION 然后继续', await allowCase.adapter.resolveSession(), { config: { guard: { autoApprove: true } } })
  const allowed = allowCase.frames().find(f => f.method === 'permission-response')
  assert.equal(allowed.result.outcome.optionId, 'allow-once')
  const allowSnapshot = await allowCase.adapter.readState(null)
  assert.equal(allowSnapshot.extra.approvals, 1)
})

test('ACP：错误帧 → ok:false（不让引擎以为成功）', async (t) => {
  const { adapter } = setup(t)
  const result = await adapter.whip('这一步会 ERROR', await adapter.resolveSession(), { config: { guard: {} } })
  assert.equal(result.ok, false)
  assert.match(result.detail, /turn failed/)
  const snapshot = await adapter.readState(null)
  assert.match(snapshot.extra.lastError ?? '', /turn failed/)
})

test('ACP：dispose 会取消会话并结束子进程（不留孤儿）', async (t) => {
  const { adapter, frames } = setup(t)
  await adapter.whip('做点事', await adapter.resolveSession(), { config: { guard: {} } })
  await adapter.dispose()
  await new Promise(r => setTimeout(r, 200))
  assert.equal(frames().some(f => f.method === 'session/cancel'), true, 'dispose 应当发出 session/cancel')
  const snapshot = await adapter.readState(null)
  assert.equal(snapshot.status, 'idle')
})

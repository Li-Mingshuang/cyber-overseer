/**
 * DSH SDK JSON-RPC 通道测试。
 *
 * 分两层：
 *  1. **适配器逻辑**（进程内）：注入一条假的 JSON-RPC 连接，钉死"必须先等 initialize 再发 prompt"、
 *     事件折叠成忙/闲与最后一次回答、失败分类——这些不需要任何子进程；
 *  2. **协议级端到端**：起 `fixtures/fake-dsh-jsonrpc.mjs`（它忠实复刻 DSH 的并发分帧），
 *     验证真实 stdio 往返与帧顺序。若运行环境禁止子进程管道（某些沙箱），这一层会显式 skip
 *     而不是伪装通过。
 *
 * 另外覆盖 profile 模板的生成/安装/幂等/不覆盖既有文件。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { defaultConfig, mergeConfig } from '../src/config.mjs'
import {
  DEFAULT_PROFILE, SDK_PACKAGE, findSdkPackage, inspectProfile, installProfile,
  profileManifest, profilePatchYaml, profileTemplateFiles, profileWorkspaceYaml,
} from '../src/dsh-profile.mjs'
import { classifyRpcError, createDshJsonRpcAdapter } from '../src/adapters/dsh-jsonrpc.mjs'
import { loadAdapters, createAdapter } from '../src/adapters/index.mjs'
import { createLogger } from '../src/util/log.mjs'

const quiet = createLogger({ level: 'error', stream: { write() {} }, errStream: { write() {} } })
const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, '..', 'fixtures', 'fake-dsh-jsonrpc.mjs')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** 这台机器允许"子进程 + 管道"吗？（沙箱里会 EPERM，此时显式 skip 而不是假绿） */
function spawnDenied() {
  try {
    const probe = spawnSync(process.execPath, ['-e', 'process.stdout.write("ok")'], { stdio: 'pipe', encoding: 'utf8', timeout: 20000 })
    if (probe.error?.code === 'EPERM' || probe.status !== 0) return `子进程管道不可用（${probe.error?.code ?? `exit ${probe.status}`}）`
  } catch (error) {
    return `子进程管道不可用（${error?.code ?? error?.message}）`
  }
  return false
}
const SPAWN_DENIED = spawnDenied()

// ---------------------------------------------------------------------------
// profile 模板
// ---------------------------------------------------------------------------

test('profile 模板：清单形状与 DSH 的 initProfile 一致，patch 挂了 JSON-RPC 服务端', () => {
  const manifest = profileManifest(DEFAULT_PROFILE)
  assert.equal(manifest.name, 'dsh-profile-jrpc')
  assert.equal(manifest.private, true)
  assert.deepEqual(manifest.dsh, { profile: { bundles: ['@deepseek-ai/dsh-base'] } })

  const patch = profilePatchYaml()
  assert.match(patch, /^- insert:/m)
  assert.match(patch, /id: sdk-jsonrpc-server/)
  assert.match(patch, /name: '@deepseek-ai\/dsh-sdk-jsonrpc-server'/)

  const workspace = profileWorkspaceYaml()
  assert.match(workspace, /nodeLinker: hoisted/)
  assert.match(workspace, /autoInstallPeers: false/)
})

test('profile 模板：仓库里 shipped 的文件与生成器**逐字节一致**（防止文档漂移）', () => {
  for (const entry of profileTemplateFiles(DEFAULT_PROFILE)) {
    const shipped = join(HERE, '..', 'templates', 'dsh-profile-jrpc', entry.file)
    assert.ok(existsSync(shipped), `模板文件缺失：${entry.file}`)
    assert.equal(readFileSync(shipped, 'utf8'), entry.content, `${entry.file} 与生成器不一致（跑 node .recon-tmp/gen-dsh-profile.mjs 或手工同步）`)
  }
})

test('installProfile：写模板 + 建插件软链；重复安装是幂等的', () => {
  const home = mkdtempSync(join(tmpdir(), 'cw-dsh-home-'))
  const sdkPath = mkdtempSync(join(tmpdir(), 'cw-dsh-sdk-'))
  writeFileSync(join(sdkPath, 'package.json'), JSON.stringify({ name: SDK_PACKAGE }), 'utf8')

  const before = inspectProfile({ home, profile: DEFAULT_PROFILE })
  assert.equal(before.ok, false)
  assert.ok(before.hints.join(' ').includes('--install'))

  const first = installProfile({ home, profile: DEFAULT_PROFILE, sdkPath })
  assert.deepEqual(first.created.sort(), ['cordis.patch.yml', 'package.json', 'pnpm-workspace.yaml'])
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.ok(first.linked, '应该建好插件软链')

  const after = inspectProfile({ home, profile: DEFAULT_PROFILE })
  assert.equal(after.ok, true)
  assert.equal(after.resolvable, true)
  const link = join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-sdk-jsonrpc-server')
  assert.ok(lstatSync(link).isSymbolicLink())
  assert.equal(readlinkSync(link), sdkPath)

  const second = installProfile({ home, profile: DEFAULT_PROFILE, sdkPath })
  assert.deepEqual(second.created, [], '第二次不应再写任何文件')
  assert.deepEqual(second.skipped.sort(), ['cordis.patch.yml', 'package.json', 'pnpm-workspace.yaml'])
  assert.equal(second.ok, true)

  rmSync(home, { recursive: true, force: true })
  rmSync(sdkPath, { recursive: true, force: true })
})

test('installProfile：不覆盖已存在的文件（除非 force）；不删别人的目录', () => {
  const home = mkdtempSync(join(tmpdir(), 'cw-dsh-home2-'))
  const profile = DEFAULT_PROFILE
  const dir = join(home, 'profiles', profile)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{ "mine": true }\n', 'utf8')

  const result = installProfile({ home, profile, sdkPath: null })
  assert.ok(result.skipped.includes('package.json'))
  assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), '{ "mine": true }\n', '绝不能覆盖主人自己的清单')
  assert.ok(result.warnings.some(w => w.includes('packages/sdk/server')), '没给 sdkPath 时要说明缺什么')

  const forced = installProfile({ home, profile, sdkPath: null, force: true })
  assert.ok(forced.created.includes('package.json'))
  assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name, 'dsh-profile-jrpc')

  // 软链位置被一个真实目录占着：只警告，绝不递归删除
  const blocker = join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-sdk-jsonrpc-server')
  mkdirSync(blocker, { recursive: true })
  const sdkPath = mkdtempSync(join(tmpdir(), 'cw-dsh-sdk2-'))
  const blocked = installProfile({ home, profile, sdkPath })
  assert.ok(blocked.warnings.some(w => w.includes('不是软链')), JSON.stringify(blocked.warnings))
  assert.ok(existsSync(blocker), '别人的目录必须还在')

  rmSync(home, { recursive: true, force: true })
  rmSync(sdkPath, { recursive: true, force: true })
})

test('findSdkPackage：环境变量优先', () => {
  const fake = mkdtempSync(join(tmpdir(), 'cw-dsh-sdk3-'))
  assert.equal(findSdkPackage({ env: { CW_DSH_SDK_PATH: fake } }), fake)
  rmSync(fake, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 适配器逻辑（注入假传输层，不需要子进程）
// ---------------------------------------------------------------------------

/** 一条进程内的假 JSON-RPC 连接：行为对齐 fixtures/fake-dsh-jsonrpc.mjs。 */
function makeFakeTransport(log) {
  const handlers = { notification: [], exit: [] }
  let alive = false
  const emit = (method, params) => { for (const handler of handlers.notification) handler(method, params) }
  let seq = 0
  return {
    get alive() { return alive },
    start() { alive = true; return this },
    onNotification(handler) { handlers.notification.push(handler); return () => {} },
    onExit(handler) { handlers.exit.push(handler); return () => {} },
    async request(method, params) {
      log.push({ method, params })
      if (method === 'initialize') {
        await sleep(5) // 放大"抢跑"窗口：适配器必须等这个响应
        return { serverInfo: { name: 'fake-inproc', version: '0.0.1' } }
      }
      if (method === 'session/prompt') {
        const text = String(params?.contentBlocks?.[0]?.text ?? '')
        if (text.includes('ERROR')) {
          const error = new Error('fixture: turn failed')
          error.code = -32603
          throw error
        }
        if (text.includes('BAD_METHOD')) {
          const error = new Error('Method not found: session/prompt')
          error.code = -32601
          throw error
        }
        if (text.includes('TIMEOUT')) throw new Error('[dsh-jsonrpc] session/prompt 超时（300s）')
        if (!text.includes('SILENT')) {
          emit('session.event', { sessionId: params.sessionId, event: { type: 'agent/inbox/spliced', seq: seq++, data: { inserted: [{ content: [{ type: 'text', text }] }] } } })
          emit('session.status', { sessionId: params.sessionId, status: 'running' })
          emit('session.event', { sessionId: params.sessionId, event: { type: 'turn/start', seq: seq++, data: { turn: 1 } } })
          emit('session.event', {
            sessionId: params.sessionId,
            event: {
              type: 'assistant/message', seq: seq++, data: {
                turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: `假 inproc 收到：${text.slice(0, 30)}` }] },
              },
            },
          })
          emit('session.event', {
            sessionId: params.sessionId,
            event: {
              type: 'turn/end', seq: seq++, data: {
                turn: 1,
                reason: text.includes('FAIL_TURN') ? { kind: 'error', error: { message: 'boom' } } : { kind: 'completed' },
              },
            },
          })
          emit('session.status', { sessionId: params.sessionId, status: 'idle' })
        }
        return { messageId: `msg-${seq}` }
      }
      return {}
    },
    async stop() { alive = false },
  }
}

function adapterConfig(dir, options = {}) {
  const config = mergeConfig(defaultConfig(), {
    agent: { adapter: 'dsh-jsonrpc', cwd: dir, session: 'latest', options: { profile: DEFAULT_PROFILE, workspace: dir, ...options } },
    judge: { kind: 'rule' },
    evidence: { git: false, verify: [] },
    guard: { quietHours: null, cooldownMs: 0 },
    notify: { beep: false, toast: false },
    runtime: { logLevel: 'error' },
  })
  config.__cwd = dir
  return config
}

async function readyAdapter(dir, options = {}) {
  const home = mkdtempSync(join(tmpdir(), 'cw-dsh-home-'))
  const sdkPath = mkdtempSync(join(tmpdir(), 'cw-dsh-sdk-'))
  installProfile({ home, profile: DEFAULT_PROFILE, sdkPath })
  const calls = []
  const adapter = createDshJsonRpcAdapter({
    config: adapterConfig(dir, { dshHome: home, ...options }),
    cwd: dir,
    log: quiet,
    deps: { makeTransport: () => makeFakeTransport(calls) },
  })
  return { adapter, calls, home, sdkPath }
}

test('适配器：probe / resolveSession / listSessions 的行为契约', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-dsh-ws-'))
  const { adapter, home, sdkPath } = await readyAdapter(dir)

  const probe = await adapter.probe()
  assert.equal(probe.ok, true, JSON.stringify(probe))
  assert.match(probe.detail, /jrpc/)

  const session = await adapter.resolveSession('latest')
  assert.equal(session.id, 'cw-jsonrpc')
  assert.equal(session.cwd, dir)
  assert.equal((await adapter.resolveSession('my-own-id')).id, 'my-own-id', '显式 id 要照用（协议就是按 id 新建）')

  const sessions = await adapter.listSessions()
  assert.equal(sessions.length, 1)
  assert.match(String(sessions[0].title), /没有|无列表方法|JSON-RPC/)

  // 未连接时也要能报状态（初始 idle，不是 unknown，免得引擎以为失联）
  const snapshot = await adapter.readState(session)
  assert.equal(snapshot.status, 'idle')
  assert.equal(snapshot.lastAnswer, '')

  await adapter.dispose()
  rmSync(dir, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
  rmSync(sdkPath, { recursive: true, force: true })
})

test('适配器：注入必须串行（先 initialize 后 session/prompt），事件流折叠出忙/闲与回答', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-dsh-ws2-'))
  const { adapter, calls, home, sdkPath } = await readyAdapter(dir)
  const session = await adapter.resolveSession()

  const whipped = await adapter.whip('[赛博监工] 把第 1 项做完', session, {})
  assert.equal(whipped.ok, true, JSON.stringify(whipped))
  assert.equal(whipped.mode, 'inject', '常驻进程 = 注入，引擎之后要等新回答')
  assert.match(whipped.detail, /messageId=/)

  // 帧顺序：initialize 必须排在 session/prompt 之前（DSH 并发处理帧，抢跑会 400）
  assert.deepEqual(calls.map(c => c.method), ['initialize', 'session/prompt'], JSON.stringify(calls.map(c => c.method)))

  const snapshot = await adapter.readState(session)
  assert.match(snapshot.lastAnswer, /假 inproc 收到/)
  assert.equal(snapshot.status, 'idle')
  assert.equal(snapshot.turn, 1)
  assert.equal(snapshot.extra.source, 'dsh-jsonrpc')
  assert.ok(snapshot.extra.events >= 4)

  // 第二次注入不会重新 initialize（常驻连接复用）
  await adapter.whip('再来一鞭', session, {})
  assert.equal(calls.filter(c => c.method === 'initialize').length, 1)
  assert.equal(calls.filter(c => c.method === 'session/prompt').length, 2)

  await adapter.dispose()
  rmSync(dir, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
  rmSync(sdkPath, { recursive: true, force: true })
})

test('适配器：注入失败分类（setup / transient / fatal）与 SILENT / FAIL_TURN', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-dsh-ws3-'))
  const { adapter, home, sdkPath } = await readyAdapter(dir)
  const session = await adapter.resolveSession()

  const fatal = await adapter.whip('ERROR', session, {})
  assert.equal(fatal.ok, false)
  assert.equal(fatal.kind, 'fatal')
  assert.match(fatal.detail, /turn failed/)

  const setup = await adapter.whip('BAD_METHOD', session, {})
  assert.equal(setup.kind, 'setup', '方法不存在 = 通道没配好，应该停下喊人')

  const transient = await adapter.whip('TIMEOUT', session, {})
  assert.equal(transient.kind, 'transient', '超时 = 下轮再试')

  assert.equal(classifyRpcError({ code: -32601, message: 'x' }), 'setup')
  assert.equal(classifyRpcError(new Error('spawn ENOENT')), 'setup')
  assert.equal(classifyRpcError(new Error('随便什么错')), 'fatal')

  // SILENT：注入成功但 agent 没动 → 状态不应被"编造"成 working
  const silent = await adapter.whip('SILENT', session, {})
  assert.equal(silent.ok, true)
  assert.equal((await adapter.readState(session)).status, 'idle')

  // FAIL_TURN：事件以 turn/end reason=error 结束 → 状态是 error
  await adapter.whip('FAIL_TURN', session, {})
  assert.equal((await adapter.readState(session)).status, 'error')

  await adapter.dispose()
  rmSync(dir, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
  rmSync(sdkPath, { recursive: true, force: true })
})

test('适配器已注册到适配器表（cw adapters / --adapter dsh-jsonrpc 能拿到）', async () => {
  await loadAdapters()
  const config = adapterConfig(process.cwd())
  const adapter = createAdapter('dsh-jsonrpc', { config, cwd: process.cwd(), log: quiet })
  assert.equal(adapter.id, 'dsh-jsonrpc')
  for (const method of ['probe', 'listSessions', 'resolveSession', 'readState', 'whip', 'dispose']) {
    assert.equal(typeof adapter[method], 'function', `缺少 ${method}()`)
  }
})

// ---------------------------------------------------------------------------
// 协议级端到端（真子进程；沙箱禁止管道时显式 skip）
// ---------------------------------------------------------------------------

test('端到端：真实 stdio 往返（fake-dsh-jsonrpc 复刻 DSH 的并发分帧）', {
  skip: SPAWN_DENIED || false,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-dsh-e2e-'))
  const home = mkdtempSync(join(tmpdir(), 'cw-dsh-home-e2e-'))
  const sdkPath = mkdtempSync(join(tmpdir(), 'cw-dsh-sdk-e2e-'))
  installProfile({ home, profile: DEFAULT_PROFILE, sdkPath })
  const logFile = join(dir, 'frames.jsonl')

  const adapter = createDshJsonRpcAdapter({
    config: adapterConfig(dir, {
      dshHome: home,
      command: [process.execPath, FIXTURE],
      env: { FAKE_DSH_LOG: logFile },
      initializeTimeoutMs: 30000,
      promptTimeoutMs: 30000,
    }),
    cwd: dir,
    log: quiet,
  })

  try {
    assert.equal((await adapter.probe()).ok, true)
    const session = await adapter.resolveSession()
    const whipped = await adapter.whip('[赛博监工] 真实 stdio 一鞭', session, {})
    assert.equal(whipped.ok, true, JSON.stringify(whipped))

    // 等事件流把回答推回来
    let snapshot = null
    for (let i = 0; i < 100; i++) {
      snapshot = await adapter.readState(session)
      if (/假 DSH JSON-RPC 收到/.test(snapshot.lastAnswer)) break
      await sleep(30)
    }
    assert.match(String(snapshot?.lastAnswer), /假 DSH JSON-RPC 收到/)
    assert.equal(snapshot.status, 'idle')

    const frames = readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    const methods = frames.filter(f => f.dir === 'in').map(f => f.method)
    assert.equal(methods[0], 'initialize', `第一帧必须是 initialize，实际：${methods.join(',')}`)
    assert.equal(methods.filter(m => m === 'initialize').length, 1)
    assert.ok(methods.indexOf('session/prompt') > methods.indexOf('initialize'), 'prompt 必须在 initialize 响应之后')
  } finally {
    await adapter.dispose()
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
    rmSync(sdkPath, { recursive: true, force: true })
  }
})

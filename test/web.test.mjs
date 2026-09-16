/**
 * Web 界面（`cw ui`）的接口测试。
 *
 * 覆盖：探活 / 项目状态 / 方案文档读写与解析 / 初始化 / 配置读写（含"手写配置不覆盖"这条安全行为）/
 * 暂停继续 / 报告 / **Host 头校验**（只允许本机）。
 *
 * 注意：这些用例**不启动真实监工**（那会花时间也花额度）；启动链路由 scripts/verify-*.mjs 与
 * 离线演示覆盖，这里只钉住 HTTP 契约。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startWebUi } from '../src/web/server.mjs'
import { createLogger } from '../src/util/log.mjs'

const quiet = createLogger({ level: 'error', stream: { write() {} }, errStream: { write() {} } })

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'cw-web-'))
  writeFileSync(join(dir, 'PLAN.md'), [
    '# 界面测试任务',
    '',
    '## 目标',
    '把界面跑通。',
    '',
    '## 验收标准',
    '- node verify.mjs 退出码 0',
    '',
    '## 任务清单',
    '- [ ] 第一项',
    '- [x] 第二项',
    '',
  ].join('\n'), 'utf8')
  return dir
}

/** 起一个界面实例（随机端口），返回调用助手。 */
async function withUi(t, project) {
  const ui = await startWebUi({ cwd: project, port: 0, open: false, log: quiet })
  t.after(async () => { await ui.close() })
  const base = ui.url.replace(/\/$/, '')
  const call = async (path, body) => {
    const res = await fetch(base + path, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    const text = await res.text()
    let data = null
    try { data = JSON.parse(text) } catch { data = null }
    return { status: res.status, data, text }
  }
  return { ui, base, call }
}

test('界面：探活 + 主页可访问', async (t) => {
  const project = makeProject()
  t.after(() => rmSync(project, { recursive: true, force: true }))
  const { call, base } = await withUi(t, project)

  const page = await fetch(base + '/')
  assert.equal(page.status, 200)
  assert.match(await page.text(), /赛博监工/)

  const ping = await call('/api/ping')
  assert.equal(ping.status, 200)
  assert.equal(ping.data.ok, true)
})

test('界面：Host 头校验（只允许本机访问）', async (t) => {
  const project = makeProject()
  t.after(() => rmSync(project, { recursive: true, force: true }))
  const { ui } = await withUi(t, project)

  const status = await new Promise((resolveDone, rejectDone) => {
    const req = request({ host: '127.0.0.1', port: ui.port, path: '/api/ping', headers: { host: 'evil.example.com' } }, (res) => {
      res.resume()
      resolveDone(res.statusCode)
    })
    req.on('error', rejectDone)
    req.end()
  })
  assert.equal(status, 403, '伪造 Host 必须被拒绝（防止外部页面打到本机服务）')
})

test('界面：读项目状态（方案解析 + 进度）', async (t) => {
  const project = makeProject()
  t.after(() => rmSync(project, { recursive: true, force: true }))
  const { call } = await withUi(t, project)

  const state = await call(`/api/state?cwd=${encodeURIComponent(project)}`)
  assert.equal(state.data.ok, true)
  assert.equal(state.data.planFile, 'PLAN.md')
  assert.equal(state.data.plan.totalCount, 2)
  assert.equal(state.data.plan.doneCount, 1)
  assert.equal(state.data.plan.acceptance.length, 1)
  assert.deepEqual(state.data.plan.emptyTodos, ['第一项'])
  assert.equal(state.data.run.status, 'idle')
  assert.equal(state.data.paused, false)
})

test('界面：写方案文档并立即看到新进度', async (t) => {
  const project = makeProject()
  t.after(() => rmSync(project, { recursive: true, force: true }))
  const { call } = await withUi(t, project)

  const saved = await call('/api/plan', {
    cwd: project,
    text: '# 新任务\n\n## 任务清单\n- [x] 甲\n- [x] 乙\n- [ ] 丙\n',
  })
  assert.equal(saved.data.ok, true)
  assert.equal(saved.data.plan.doneCount, 2)
  assert.equal(saved.data.plan.totalCount, 3)
  assert.match(readFileSync(join(project, 'PLAN.md'), 'utf8'), /- \[ \] 丙/)
})

test('界面：初始化 + 配置可写（没有手写配置时）', async (t) => {
  const project = mkdtempSync(join(tmpdir(), 'cw-web-new-'))
  t.after(() => rmSync(project, { recursive: true, force: true }))
  const { call } = await withUi(t, project)

  const init = await call('/api/init', { cwd: project })
  assert.equal(init.data.ok, true)
  assert.equal(init.data.createdPlan, true)
  assert.ok(existsSync(join(project, 'PLAN.md')))
  assert.ok(existsSync(join(project, '.cyber')))

  const written = await call('/api/config', {
    cwd: project,
    config: { agent: { adapter: 'fake' }, evidence: { verify: ['node -e "0"'] }, guard: { maxRounds: 3 } },
  })
  assert.equal(written.data.ok, true, written.data.error ?? '')
  assert.equal(written.data.editable, true)
  const onDisk = JSON.parse(readFileSync(join(project, '.cyber', 'ui.config.json'), 'utf8'))
  assert.equal(onDisk.agent.adapter, 'fake')
  assert.equal(onDisk.guard.maxRounds, 3)
  // 再读一次应能读回同一份配置
  const again = await call(`/api/config?cwd=${encodeURIComponent(project)}`)
  assert.equal(again.data.configSource.kind, 'ui')
  assert.equal(again.data.config.guard.maxRounds, 3)
})

test('界面：有手写 cw.config.mjs 时拒绝覆盖（安全行为）', async (t) => {
  const project = makeProject()
  t.after(() => rmSync(project, { recursive: true, force: true }))
  writeFileSync(join(project, 'cw.config.mjs'), 'export default { plan: "PLAN.md" }\n', 'utf8')
  const { call } = await withUi(t, project)

  const info = await call(`/api/config?cwd=${encodeURIComponent(project)}`)
  assert.equal(info.data.editable, false)
  assert.equal(info.data.configSource.kind, 'handwritten')
  assert.match(info.data.note, /手写/)

  const attempt = await call('/api/config', { cwd: project, config: { guard: { maxRounds: 99 } } })
  assert.equal(attempt.data.ok, false)
  assert.equal(existsSync(join(project, '.cyber', 'ui.config.json')), false, '不该给手写配置的项目写 ui.config.json')
})

test('界面：暂停与继续（PAUSE 哨兵）', async (t) => {
  const project = makeProject()
  t.after(() => rmSync(project, { recursive: true, force: true }))
  const { call } = await withUi(t, project)

  const paused = await call('/api/pause', { cwd: project })
  assert.equal(paused.data.paused, true)
  assert.ok(existsSync(join(project, '.cyber', 'PAUSE')))
  assert.equal((await call(`/api/state?cwd=${encodeURIComponent(project)}`)).data.paused, true)

  const resumed = await call('/api/resume', { cwd: project })
  assert.equal(resumed.data.paused, false)
  assert.equal(existsSync(join(project, '.cyber', 'PAUSE')), false)
})

test('界面：报告与停止接口在"没跑过"时也能安全响应', async (t) => {
  const project = makeProject()
  t.after(() => rmSync(project, { recursive: true, force: true }))
  const { call } = await withUi(t, project)

  const report = await call(`/api/report?cwd=${encodeURIComponent(project)}`)
  assert.equal(report.data.exists, false)

  const stopped = await call('/api/stop', {})
  assert.equal(stopped.data.ok, true)

  const unknown = await call('/api/does-not-exist')
  assert.equal(unknown.status, 404)
})

test('界面：最近项目/建议列表可返回（不报错）', async (t) => {
  const project = makeProject()
  t.after(() => rmSync(project, { recursive: true, force: true }))
  const { call } = await withUi(t, project)

  const data = await call('/api/projects')
  assert.equal(data.data.ok, true)
  assert.ok(Array.isArray(data.data.projects))
  assert.ok(Array.isArray(data.data.suggested))
})

test('界面：一句话起步（只生成方案，安全且不启动监工）', async (t) => {
  const project = makeProject()
  t.after(() => rmSync(project, { recursive: true, force: true }))
  const { call } = await withUi(t, project)

  const quick = await call('/api/quick', { cwd: project, sentence: '把首页做成深色主题', planOnly: true })
  assert.equal(quick.data.ok, true, quick.data.error ?? '')
  assert.equal(quick.data.planOnly, true)
  assert.ok(quick.data.decided.length >= 3, '应打印"监工谁/验收/方案"三行决定')
  assert.match(quick.data.planPath, /\.cyber[\\/]PLAN\.md$/)

  // 生成的方案不含标记字面形式（否则会被误读成 agent 宣告）
  assert.doesNotMatch(quick.data.planText, /<!--\s*CW:/i)

  // 方案与配置落盘
  assert.ok(existsSync(join(project, '.cyber', 'PLAN.md')))
  assert.ok(existsSync(join(project, '.cyber', 'auto.config.json')))

  // 状态接口应能读到刚生成的方案
  const state = await call(`/api/state?cwd=${encodeURIComponent(project)}`)
  assert.equal(state.data.planFile, 'PLAN.md')
})

test('界面：一句话为空时报错而不是乱跑', async (t) => {
  const project = makeProject()
  t.after(() => rmSync(project, { recursive: true, force: true }))
  const { call } = await withUi(t, project)

  const quick = await call('/api/quick', { cwd: project, sentence: '   ' })
  assert.equal(quick.data.ok, false)
  assert.match(quick.data.error, /一句话/)
})

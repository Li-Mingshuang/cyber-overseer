/**
 * ACP 适配器（Agent Client Protocol）—— 跨 agent 的标准通道。
 *
 * ACP 是"编辑器/客户端 ↔ agent"的开放协议（Zed 生态、DSH、opencode 都实现了它）。
 * 对监工来说它有一个很舒服的性质：**一个连接的会话可以反复投喂 prompt**，
 * 所以监工可以像人一样一直跟同一个 agent 对话——比"每次起一个全新会话"更接近真人监工。
 *
 * 协议形状（实测自 DSH 的真实快照帧，见 docs/recon/dsh-control-surfaces.md §3）：
 *
 *   客户端 → agent：
 *     { "jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}} }
 *     { "jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"…","mcpServers":[]} }   → {sessionId}
 *     { "jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"…","prompt":[{"type":"text","text":"…"}]} }
 *         → 结束时返回 { "stopReason":"end_turn" }
 *     { "jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"…"} }        （通知）
 *
 *   agent → 客户端：
 *     { "jsonrpc":"2.0","method":"session/update","params":{"sessionId":"…",
 *         "update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"…"}}}}   （通知，流式）
 *     { "jsonrpc":"2.0","id":1,"method":"session/request_permission","params":{…,"options":[…]}}    （反向请求）
 *
 * 已知限制（务必知道，否则会误判 agent 没干活）：
 *   - 只能看到**成文的助手文本**（`agent_message_chunk`），拿不到工具调用、reasoning、usage；
 *   - 没有 `session/load`/`resume`：**跨连接无法恢复**（同一连接内可以连续多轮）；
 *   - 一个会话同时只允许一个 in-flight prompt（第二个会报错）→ 本适配器据此返回 transient 失败让引擎重试。
 *
 * 审批：`session/request_permission` 是 agent 反向问"能执行吗"。默认**拒绝**（fail-closed），
 * 只有 `guard.autoApprove` 明确打开才放行——监工不替主人点"同意"。
 *
 * @module cyber-overseer/adapters/acp
 */

import { existsSync } from 'node:fs'
import { which } from '../util/proc.mjs'
import { clip, oneLine } from '../util/text.mjs'
import { JsonRpcError, JsonRpcStdioClient } from '../util/jsonrpc-stdio.mjs'
import { probeFail, probeOk } from './base.mjs'

export const id = 'acp'
export const label = 'ACP（Agent Client Protocol）'
export const docs = '标准协议通道：同连接多轮喂 prompt；只可见成文文本，跨连接不能恢复'

/** 常见 ACP agent 的启动方式。 */
export const ACP_PRESETS = {
  opencode: { command: 'opencode', args: ['acp'], note: 'opencode 自带 ACP 服务端' },
  dsh: {
    command: 'node',
    args: ['<deepseek-harness>/packages/examples/acp-demo/lib/bin.js', '--config', 'examples/acp-agent/cordis.yml'],
    note: 'DSH 的 ACP 服务端在 packages/examples/acp-demo；需要 DEEPSEEK_API_KEY，且进程必须在 deepseek-harness 仓库根启动（--config 是相对路径）',
    // 关键：--config 是相对路径，所以启动目录必须是 harness 仓库根，而不是被监工的项目目录
    launchCwdFromCheckout: true,
  },
  gemini: { command: 'gemini', args: ['--experimental-acp'], note: 'Gemini CLI 的实验性 ACP 入口（按你安装的版本为准）' },
}

/**
 * @param {{config:any, cwd:string, log?:any, deps?:any}} ctx
 * @returns {import('./base.mjs').Adapter & {dispose:()=>Promise<void>}}
 */
export function createAcpAdapter(ctx) {
  const { config, cwd, log } = ctx
  const options = config.agent?.options ?? {}
  const presetName = options.preset ?? options.agentPreset ?? null
  const preset = presetName ? ACP_PRESETS[presetName] : null
  const command = options.command?.[0] ?? preset?.command ?? null
  const args = options.command ? options.command.slice(1) : (preset?.args ?? [])
  const checkout = options.dshCheckout ?? process.env.DSH_CHECKOUT ?? null
  /**
   * 两个 cwd 必须分开：
   *   - `launchCwd`：**ACP 服务端进程**的启动目录（DSH 的 --config 是相对路径，必须在 harness 仓库根）；
   *   - `acpCwd`：传给 `session/new` 的**工作区目录**（agent 真正干活的地方）。
   * 早期版本把两者混为一谈，结果 DSH 的 preset 一启动就找不到配置文件。
   */
  const launchCwd = options.launchCwd
    ?? (preset?.launchCwdFromCheckout && checkout ? checkout : null)
    ?? options.acpCwd
    ?? cwd
  const workspaceCwd = options.acpCwd ?? cwd

  /** @type {JsonRpcStdioClient|null} */
  let client = null
  let sessionId = null
  let initializing = null
  let promptInFlight = false
  const state = {
    chunks: [],
    lastAnswer: '',
    turn: 0,
    rejections: 0,
    approvals: 0,
    pendingPermission: null,
    lastStopReason: null,
    lastError: null,
    stderr: '',
    startedAt: null,
  }

  const resolveArgs = () => args.map(a => String(a)
    .replace('<deepseek-harness>', checkout ?? cwd))

  async function ensureSession() {
    if (sessionId && client?.alive) return sessionId
    if (initializing) return initializing
    initializing = (async () => {
      const resolvedArgs = resolveArgs()
      const conn = new JsonRpcStdioClient({
        command, args: resolvedArgs, cwd: launchCwd,
        env: {
          ...process.env,
          ...(options.permissionMode ? { DSH_PERMISSION_MODE: options.permissionMode } : {}),
          ...(options.env ?? {}),
        },
        log, name: `acp:${presetName ?? command}`,
      })
      client = conn
      conn.onNotification((method, params) => {
        if (method === 'session/update') {
          const update = params?.update
          if (update?.sessionUpdate === 'agent_message_chunk') {
            const text = update.content?.type === 'text' ? update.content.text : ''
            if (text) state.chunks.push(text)
          } else if (update?.sessionUpdate) {
            log?.trace?.(`ACP 未处理的 update：${update.sessionUpdate}`)
          }
          return
        }
        log?.trace?.(`ACP 通知：${method}`)
      })
      conn.onRequest(async (method, params) => {
        if (method === 'session/request_permission') return handlePermission(params)
        return undefined
      })
      conn.onExit(({ code, stderr }) => {
        state.stderr = stderr ?? ''
        sessionId = null
        client = null
        initializing = null
        if (code !== 0) log?.warn?.(`ACP 进程退出（code=${code}）：${oneLine(stderr ?? '', 200)}`)
      })

      await conn.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: options.clientCapabilities ?? {},
      }, { timeoutMs: options.startTimeoutMs ?? 60000 })
      const created = await conn.request('session/new', {
        cwd: workspaceCwd,
        mcpServers: options.mcpServers ?? [],
      }, { timeoutMs: options.startTimeoutMs ?? 60000 })
      sessionId = created?.sessionId ?? created?.session?.id ?? null
      state.startedAt = Date.now()
      if (!sessionId) throw new Error(`session/new 没有返回 sessionId：${JSON.stringify(created)}`)
      log?.ok?.(`ACP 会话已建立：${sessionId}`)
      return sessionId
    })()
    try {
      return await initializing
    } finally {
      initializing = null
    }
  }

  /** agent 反向问"能不能执行"：默认拒绝（fail-closed）。 */
  function handlePermission(params) {
    state.pendingPermission = { at: Date.now(), toolCallId: params?.toolCall?.toolCallId ?? null }
    const allowOption = (params?.options ?? []).find(o => o.kind === 'allow_once' || o.kind === 'allow_always' || o.optionId === 'allow-once')
    const rejectOption = (params?.options ?? []).find(o => o.kind === 'reject_once' || o.kind === 'reject_always' || o.optionId === 'reject-once')
    if (config.guard?.autoApprove && allowOption) {
      state.approvals++
      state.pendingPermission = null
      log?.warn?.(`按 guard.autoApprove 放行 ACP 权限请求（${allowOption.optionId}）——风险自负`)
      return { outcome: { outcome: 'selected', optionId: allowOption.optionId } }
    }
    state.rejections++
    state.pendingPermission = null
    log?.warn?.('ACP 权限请求已拒绝（监工不替主人点同意；如需放行请开 guard.autoApprove）')
    return { outcome: { outcome: 'selected', optionId: rejectOption?.optionId ?? 'reject-once' } }
  }

  return {
    id,
    label,
    docs,

    async probe() {
      const hints = []
      if (!command) {
        return probeFail('没有配置 ACP 端命令：请在 agent.options 里给 { preset: "opencode" } 或 { command: ["...","acp"] }', [
          `内置预设：${Object.entries(ACP_PRESETS).map(([k, v]) => `${k} → ${v.command} ${v.args.join(' ')}`).join('；')}`,
        ])
      }
      const resolved = which(command)
      const isNode = command === process.execPath || command === 'node' || /node(\.exe)?$/i.test(command)
      const badArg = args.find(a => a.startsWith('<') && !options.dshCheckout && !process.env.DSH_CHECKOUT)
      if (badArg) return probeFail(`命令里有未替换的占位符：${badArg}`, ['设 agent.options.dshCheckout 指向 deepseek-harness 仓库，或改用 preset'])
      const firstFile = args.find(a => a.endsWith('.js') || a.endsWith('.mjs'))
      if (firstFile && !existsSync(firstFile) && !firstFile.startsWith('-')) {
        return probeFail(`入口文件不存在：${firstFile}`, ['确认 ACP 端的路径（dsh 的 ACP 端在 packages/examples/acp-demo/lib/bin.js）'])
      }
      if (!resolved && !isNode) return probeFail(`找不到可执行文件：${command}`, [`PATH 里没有 ${command}`])
      if (preset?.launchCwdFromCheckout && !checkout) {
        return probeFail('该预设需要 harness 仓库路径（--config 是相对路径）', [
          '设 agent.options.dshCheckout 或环境变量 DSH_CHECKOUT 指向 deepseek-harness 仓库',
        ])
      }
      if (options.acpCwd && !existsSync(options.acpCwd)) {
        return probeFail(`acpCwd 不存在：${options.acpCwd}`, ['session/new 的 cwd 必须是一个真实目录'])
      }
      if (preset?.note) hints.push(preset.note)
      hints.push(`启动目录 ${launchCwd}｜工作区 ${workspaceCwd}`)
      hints.push('ACP 只能看到成文文本（没有工具调用/reasoning）；跨连接不能恢复会话，所以一次 cw run 用一个连接')
      if (config.guard?.autoApprove !== true) hints.push('agent 的权限请求会被自动拒绝（默认安全）；需要放行请开 guard.autoApprove')
      return probeOk(`ACP 端：${command} ${resolveArgs().join(' ')}（启动时才会建立会话）`, hints)
    },

    async listSessions() {
      // ACP 没有 session/list：一条连接就是一次监工过程
      return [{ id: sessionId ?? '(未建立)', title: `ACP：${presetName ?? command}`, cwd: options.acpCwd ?? cwd, updatedAt: Date.now() }]
    },

    async resolveSession() {
      return { id: sessionId ?? '(按需建立)', title: `ACP：${presetName ?? command}`, cwd: options.acpCwd ?? cwd, updatedAt: Date.now() }
    },

    async readState(session) {
      if (!client?.alive) {
        // 还没连过：空闲，但没有回答
        if (!sessionId) {
          return {
            status: 'idle', turn: state.turn, lastAnswer: state.lastAnswer, lastUserMessage: null,
            session, extra: { acp: '尚未建立连接', preset: presetName },
          }
        }
        // 连过但进程没了：需要重连
        return {
          status: 'unknown', turn: state.turn, lastAnswer: state.lastAnswer, lastUserMessage: null,
          session, error: `ACP 进程已退出${state.stderr ? `：${oneLine(state.stderr, 160)}` : ''}`,
          extra: { acp: '进程已退出', preset: presetName },
        }
      }
      return {
        status: promptInFlight ? 'working' : 'idle',
        turn: state.turn,
        lastAnswer: state.lastAnswer,
        lastUserMessage: null,
        session: { ...session, id: sessionId ?? session?.id },
        extra: {
          acp: 'ok', preset: presetName, sessionId,
          rejections: state.rejections, approvals: state.approvals,
          lastStopReason: state.lastStopReason, lastError: state.lastError ? oneLine(state.lastError, 160) : null,
          // 说明：ACP 只暴露成文文本，判定依据主要来自验收命令与方案勾选
          observable: '仅成文助手文本',
        },
      }
    },

    async whip(text, session, engineCtx) {
      try {
        await ensureSession()
      } catch (error) {
        return {
          ok: false, mode: 'inject', kind: 'setup',
          detail: `建立 ACP 会话失败：${error?.message ?? error}`,
        }
      }
      if (promptInFlight) {
        return { ok: false, mode: 'inject', kind: 'transient', detail: '上一个 prompt 还没结束（ACP 每会话只允许一个 in-flight prompt）' }
      }

      state.chunks = []
      state.lastError = null
      promptInFlight = true
      state.turn++
      log?.step?.(`ACP 抽鞭：session/prompt（${text.length} 字）`)
      try {
        const result = await client.request('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text }],
        }, {
          timeoutMs: engineCtx?.config?.guard?.waitForAgentIdleMs ?? 3 * 60 * 60 * 1000,
          signal: engineCtx?.signal,
        })
        const answer = state.chunks.join('')
        state.lastAnswer = answer
        state.lastStopReason = result?.stopReason ?? null
        const detail = `ACP 回合结束（stopReason=${result?.stopReason ?? '?'}，${answer.length} 字）`
        log?.ok?.(detail)
        return {
          ok: true,
          mode: 'foreground',
          detail,
          answer: clip(answer, 20000),
          exitCode: 0,
        }
      } catch (error) {
        const message = error instanceof JsonRpcError ? `${error.message}（code ${error.code}）` : String(error?.message ?? error)
        state.lastError = message
        promptInFlight = false
        // 会话还在的话，这类错误多半是对方 agent 侧的问题；让引擎按 fatal 处理并写报告
        const kind = /already in flight|busy/i.test(message) ? 'transient' : 'fatal'
        return { ok: false, mode: 'inject', kind, detail: `ACP session/prompt 失败：${message}` }
      } finally {
        promptInFlight = false
      }
    },

    async capabilities() {
      return [
        `ACP 端：${command ?? '(未配置)'} ${resolveArgs().join(' ')}`,
        `预设：${presetName ?? '(自定义)'}`,
        `会话：${sessionId ?? '(尚未建立；一次监工过程内复用同一个会话，可连续多轮)'}`,
        `审批：${config.guard?.autoApprove ? '自动放行（⚠️ 已拒绝 ' + state.rejections + ' 次 / 放行 ' + state.approvals + ' 次）' : '自动拒绝（fail-closed）'}`,
        '限制：只看得到成文助手文本；跨连接无法恢复会话',
      ].join('\n')
    },

    /** 收尾：礼貌地取消并关掉 ACP 进程（引擎在 finish 时调用）。 */
    async dispose() {
      if (!client) return
      try {
        if (sessionId && client.alive) client.notify('session/cancel', { sessionId })
      } catch { /* 忽略 */ }
      await client.stop().catch(() => {})
      client = null
      sessionId = null
    },
  }
}

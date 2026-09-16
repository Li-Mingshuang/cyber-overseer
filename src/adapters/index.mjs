/**
 * 适配器注册表。
 *
 * 每个适配器负责一种"读会话 + 抽鞭"的方式；引擎只跟这个接口打交道。
 * 懒加载：没用到 codex 就不去 import 它的解析器（也避免 Node 版本不满足时直接崩）。
 *
 * @module cyber-overseer/adapters/index
 */

export const ADAPTER_IDS = ['dsh', 'dsh-jsonrpc', 'codex', 'opencode', 'cursor', 'acp', 'human-sim', 'generic-cli', 'mcp-mailbox', 'fake']

/** 适配器清单（给 `cw adapters` 用）。 */
export const ADAPTER_CATALOG = [
  { id: 'dsh', label: 'DeepSeek Harness (dsh)', channel: '读 session.jsonl.zstd；headless / HTTP / 拟人 / 自定义命令', note: '本项目一等公民' },
  { id: 'dsh-jsonrpc', label: 'DeepSeek Harness（SDK stdio JSON-RPC）', channel: '常驻 `--profile jrpc` 进程：session/prompt 注入 + session.event 事件流观测', note: '需先 `cw dsh-profile --install`' },
  { id: 'codex', label: 'OpenAI Codex CLI', channel: '读 state_5.sqlite + rollout.jsonl；`codex exec resume`', note: '' },
  { id: 'opencode', label: 'opencode', channel: '读 opencode.db（message/part）；`opencode run -s`', note: '' },
  { id: 'cursor', label: 'Cursor IDE', channel: '读 state.vscdb；官方 stop 钩子 / desktop bridge / 拟人', note: '推荐 hooks 模式' },
  { id: 'acp', label: 'ACP（Agent Client Protocol）', channel: '标准协议：同连接多轮 session/prompt，兼容 DSH/opencode/Zed 生态', note: '跨 agent 通用，但只可见成文文本' },
  { id: 'human-sim', label: '拟人通道（任意 GUI）', channel: 'UIA/剪贴板读；抢焦点打字 + 回车', note: 'Windows 实现，万能兜底' },
  { id: 'generic-cli', label: '通用 CLI 循环', channel: '模板命令抽鞭，stdout 即回答', note: '任何 CLI agent' },
  { id: 'mcp-mailbox', label: 'MCP 信箱', channel: '给 agent 挂一个 MCP 服务，让它每回合来取指令', note: '需要 agent 支持 MCP' },
  { id: 'fake', label: '假 agent', channel: '按脚本吐回答', note: '测试与离线演示用' },
]

/**
 * 创建适配器实例。
 * @param {string} adapterId
 * @param {{config:any, cwd:string, log?:any, deps?:any, signal?:AbortSignal}} ctx
 * @returns {import('./base.mjs').Adapter}
 */
export function createAdapter(adapterId, ctx) {
  switch (adapterId) {
    case 'dsh':
      return requireFactory(ctx, './dsh.mjs', 'createDshAdapter')
    case 'dsh-jsonrpc':
      return requireFactory(ctx, './dsh-jsonrpc.mjs', 'createDshJsonRpcAdapter')
    case 'codex':
      return requireFactory(ctx, './codex.mjs', 'createCodexAdapter')
    case 'opencode':
      return requireFactory(ctx, './opencode.mjs', 'createOpencodeAdapter')
    case 'cursor':
      return requireFactory(ctx, './cursor.mjs', 'createCursorAdapter')
    case 'acp':
      return requireFactory(ctx, './acp.mjs', 'createAcpAdapter')
    case 'human-sim':
      return requireFactory(ctx, './human-sim.mjs', 'createHumanSimAdapter')
    case 'generic-cli':
      return requireFactory(ctx, './generic-cli.mjs', 'createGenericCliAdapter')
    case 'mcp-mailbox':
      return requireFactory(ctx, './mcp-mailbox.mjs', 'createMcpMailboxAdapter')
    case 'fake':
      return requireFactory(ctx, './fake.mjs', 'createFakeAdapter')
    default:
      throw new Error(`未知适配器：${adapterId}（可用：${ADAPTER_IDS.join(', ')}）`)
  }
}

/**
 * 同步创建（适配器模块都是同步的 ESM，这里用 require-like 的惰性写法保持零依赖）。
 * 注意：Node 的 ESM 不能同步 import，所以适配器工厂统一通过 `registerAdapter` 预先注册；
 * 未注册时退化为"报错并提示先 await loadAdapter()"。
 */
const registry = new Map()

/** 注册工厂（在 bin/cli 启动时把全部适配器注册进来）。 */
export function registerAdapter(id, factory) {
  registry.set(id, factory)
}

function requireFactory(ctx, modulePath, exportName) {
  const factory = registry.get(modulePath)
  if (!factory) {
    throw new Error(
      `适配器模块 ${modulePath} 尚未加载。请先 \`await loadAdapters()\`（bin/cw.mjs 已自动完成），`
      + `或在自定义脚本里 import { loadAdapters } from '${'cyber-overseer/src/adapters/index.mjs'}'; await loadAdapters()`,
    )
  }
  return factory(ctx)
}

/**
 * 预加载所有适配器工厂（启动时调一次）。
 * @returns {Promise<void>}
 */
export async function loadAdapters() {
  const mods = [
    ['./dsh.mjs', 'createDshAdapter'],
    ['./dsh-jsonrpc.mjs', 'createDshJsonRpcAdapter'],
    ['./codex.mjs', 'createCodexAdapter'],
    ['./opencode.mjs', 'createOpencodeAdapter'],
    ['./cursor.mjs', 'createCursorAdapter'],
    ['./acp.mjs', 'createAcpAdapter'],
    ['./human-sim.mjs', 'createHumanSimAdapter'],
    ['./generic-cli.mjs', 'createGenericCliAdapter'],
    ['./mcp-mailbox.mjs', 'createMcpMailboxAdapter'],
    ['./fake.mjs', 'createFakeAdapter'],
  ]
  for (const [path, name] of mods) {
    try {
      const mod = await import(path)
      registerAdapter(path, mod[name])
    } catch (error) {
      // 某个适配器加载失败（例如依赖的平台能力缺失）不应该拖垮其它适配器
      registerAdapter(path, () => { throw error })
    }
  }
}

export { selectSession, probeOk, probeFail, samePath, describeAdapter } from './base.mjs'

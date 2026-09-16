/**
 * 本仓库自己的监工配置（dogfooding）。
 *
 * 用法：
 *   node bin/cw.mjs watch            # 演练：只判定、只打印要抽的鞭子
 *   node bin/cw.mjs run              # 真抽（默认 adapter=dsh，走 headless 接力）
 *   node bin/cw.mjs doctor           # 看看这台机器能怎么监工
 *
 * 注意 `evidence.verify` 里那条测试命令：它既是给主人的保证，也是监工判定"能不能收工"的硬证据。
 */
export default {
  plan: 'PLAN.md',

  agent: {
    adapter: 'dsh',
    cwd: '.',
    session: 'latest',
    options: {
      // headless（默认，每次全新会话、记忆靠工作区）| http（插进正在跑的会话）| human-sim | custom
      whip: 'headless',
      permissionMode: 'workspace-write',
    },
  },

  judge: {
    // 规则优先：勾选 + 验收命令 + 卡死检测；判不了才升级到 LLM（省钱也更稳）
    kind: 'chain',
    rule: {
      requireTodosChecked: true,
      requireVerifyPass: true,
      trustAgentDone: false,
      stallRounds: 3,
    },
    llm: {
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
    },
  },

  evidence: {
    git: true,
    verify: ['node --test "test/*.test.mjs"', 'node scripts/lint.mjs'],
    verifyEveryRound: false,   // 输入没变就复用上一轮的通过结果，省时间
  },

  guard: {
    maxRounds: 16,
    maxWallClockMs: 6 * 60 * 60 * 1000,
    maxStallRounds: 3,
    maxBlockedRounds: 2,
    quietHours: { from: '23:00', to: '08:00' },   // 主人休息时才动手
    requireHumanIdleMs: 120000,
    autoApprove: false,
  },

  whip: {
    style: 'strict',
    maxChars: 1800,
    includeContext: true,
    requireReceipt: true,
  },

  journal: {
    dir: '.cyber',
    reportFile: 'CW-REPORT.md',
    storeAnswers: false,       // 不把整段回答写进日志（可能含敏感片段）
  },

  notify: { beep: false, webhook: null },
}

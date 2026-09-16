/**
 * 离线演示的监工配置：把"懒惰劳工"抽到验收通过为止。
 *
 * 跑法（在仓库根目录）：
 *   node bin/cw.mjs run --config examples/lazy-agent/cw.config.mjs
 * 想看它准备抽什么但不真抽：
 *   node bin/cw.mjs watch --config examples/lazy-agent/cw.config.mjs
 */
export default {
  plan: 'examples/lazy-agent/PLAN.md',

  agent: {
    adapter: 'generic-cli',
    cwd: 'examples/lazy-agent',
    options: {
      // 每抽一鞭 = 起一个劳工进程，鞭子作为参数递进去
      command: ['node', 'agent.mjs', '{text}'],
      title: '懒惰劳工（离线演示）',
    },
  },

  judge: {
    // 纯规则判定：零成本、确定性——演示不需要 API Key
    kind: 'rule',
    rule: {
      requireTodosChecked: true,
      requireVerifyPass: true,
      trustAgentDone: false,
      stallRounds: 3,
    },
  },

  evidence: {
    git: false,
    verify: ['node verify.mjs'],
    verifyEveryRound: true,
  },

  guard: {
    maxRounds: 12,
    maxWallClockMs: 5 * 60 * 1000,
    maxStallRounds: 3,
    quietHours: null,        // 演示不受静默期限制
    workWindow: null,
    cooldownMs: 0,
  },

  whip: {
    style: 'strict',
    requireReceipt: true,
  },

  journal: {
    dir: 'examples/lazy-agent/.cyber',
    reportFile: 'examples/lazy-agent/CW-REPORT.md',
    storeAnswers: true,
  },

  notify: { beep: false, toast: false, webhook: null },

  runtime: {
    logLevel: 'info',
    stateFile: 'examples/lazy-agent/.cyber/state.json',
  },
}

/**
 * 配置示例（复制成你项目根的 cw.config.mjs 后按需修改）。
 *
 * 三个最常改的地方：
 *   1. agent.adapter / agent.options —— 你到底在监工谁；
 *   2. evidence.verify —— 验收命令（决定判定准不准，强烈建议配）；
 *   3. guard.* —— 无人值守的护栏（轮次、时长、静默期）。
 */
export default {
  plan: 'PLAN.md',

  agent: {
    adapter: 'dsh',                 // dsh | codex | opencode | cursor | human-sim | generic-cli | mcp-mailbox
    session: 'latest',              // 'latest' | 具体会话 id | { match: { title: '...' } }
    options: {
      // —— DSH ——
      // whip: 'headless',            // headless（一次性新会话接力）| http（插入活会话）| human-sim | custom
      // permissionMode: 'workspace-write',
      // —— Cursor ——
      // whip: 'hooks',               // 用 `cw hooks install cursor` 装官方钩子（推荐）
      // —— 拟人通道（任何 GUI）——
      // windowMatch: { process: 'Cursor' },
      // composer: { relX: 0.5, relY: 0.94 },
      // readerAdapter: 'cursor',     // 能读磁盘就读磁盘，最准
      // —— 通用 CLI ——
      // command: ['my-agent', '--resume', '{session}', '{text}'],
    },
  },

  judge: {
    kind: 'chain',                  // chain（规则优先，判不了才问模型）| rule | llm | human
    llm: {
      baseUrl: 'https://api.deepseek.com/v1',   // 任何 OpenAI 兼容端点都行
      model: 'deepseek-chat',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
    },
  },

  evidence: {
    git: true,
    verify: ['npm test'],           // ← 建议加：这是最硬的证据
    verifyEveryRound: false,        // true = 每轮都跑（慢但证据最新）
  },

  guard: {
    maxRounds: 24,
    maxWallClockMs: 10 * 60 * 60 * 1000,
    maxStallRounds: 3,
    quietHours: { from: '23:00', to: '08:00' },   // 主人休息时才动手；null = 不限
    requireHumanIdleMs: 120000,                   // 拟人通道：键鼠空闲 2 分钟才抢焦点
    autoApprove: false,                           // 绝不替主人点"同意"
  },

  whip: {
    style: 'strict',                // strict | neutral | gentle
    maxChars: 1800,
    requireReceipt: true,
  },

  notify: {
    webhook: null,                  // POST JSON 到该地址（飞书/钉钉/Slack/Server 酱）
    beep: true,
  },
}

# 赛博监工（本仓库自己的方案文档）

> 这份文件是**给监工读的**：本仓库 dogfooding —— 用赛博监工来开发赛博监工自己。
> 跑法：`cw watch`（演练）或 `cw run`（真抽），配置见 `cw.config.mjs`。

## 目标
让「赛博监工」成为一个**真的能在无人值守下替人盯 agent 的工具**：
判定有证据、抽鞭有闭环、出事有护栏、收工有交代。
功能范围以 [`ROADMAP.md`](ROADMAP.md) 的清单为准；每一轮只推进一项。

## 验收标准
- `node --test "test/*.test.mjs"` 全绿（当前 55 个用例）
- `node scripts/lint.mjs` 通过（语法 + ESM 一致性 + 不污染 stdout 契约）
- `node bin/cw.mjs run --config examples/lazy-agent/cw.config.mjs` 能跑完离线演示并以退出码 0 收工
- 新增的适配器/通道都有**协议级测试**（不许只写"看起来对"的代码）

## 任务清单
- [x] 方案文档解析（中英双语章节、勾选、显式标记）
- [x] 判定器：rule / llm / human / chain
- [x] 主循环：等空闲 → 读回答 → 采证据 → 判定 → 抽鞭 → 循环
- [x] 证据采集：验收命令 + git 改动 + 指纹缓存
- [x] 护栏：轮次 / 时长 / 花费 / 卡死 / 静默期 / 暂停哨兵 / 断点续跑
- [x] 适配器：dsh（多帧 zstd 会话读取 + headless/http/拟人/自定义）
- [x] 适配器：codex（state_5.sqlite + rollout + `exec resume`）
- [x] 适配器：opencode（opencode.db 投影表 + `run -s`）
- [x] 适配器：cursor（state.vscdb + 官方 stop 钩子）
- [x] 适配器：human-sim（Windows UIA + SendInput，三重保险）
- [x] 适配器：generic-cli / mcp-mailbox
- [x] 适配器：acp（标准协议通道，同连接多轮）
- [x] 报告与通知：CW-REPORT.md + journal.jsonl + webhook/响铃
- [x] 测试 55 个 + 离线端到端演示
- [x] 双语文档 + 各家逆向报告
- [x] dsh 的 ACP 通道：真实握手实测通过（`node scripts/verify-acp.mjs`，零 token）
- [ ] dsh 的 ACP prompt 通路实测（需要花真实额度，留给主人决定）
- [ ] dsh 的 SDK JSON-RPC 通道（协议已摸清，见 docs/recon/dsh-control-surfaces.md §4.6）
- [ ] human-sim：macOS（osascript）与 Linux（xdotool）驱动
- [ ] 多 agent 并行监工（一个监工进程管多个会话）
- [ ] `cw status --watch`：终端里的实时面板
- [ ] Windows 原生 toast 通知（目前只有响铃 + webhook）

## 禁止 / 范围外
- 不许替主人批准 agent 的危险操作（`guard.autoApprove` 默认必须为 false）
- 不许修改任何 agent 的会话数据（一律只读打开）
- 不许在测试里调用真实模型/真实额度（协议测试用 fixtures/ 下的假服务端）
- 不许为了过测试而放宽断言（尤其是判定器："判不了"必须返回 needs-human，不许猜 done）

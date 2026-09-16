# 路线图

> 这份清单和 [`PLAN.md`](PLAN.md) 的复选框保持一致——监工只认 `PLAN.md`，
> 这里写的是"为什么排这个顺序"。

## 已完成（v0.1）

- **判定引擎**：rule（零成本、离线可用）/ llm（OpenAI 兼容，严格 JSON，解析失败不猜）/ human / chain
- **主循环**：等空闲 → 读回答 → 采证据 → 判定 → 抽鞭 → 再判定；每轮重读方案文档
- **七条抽鞭通道**：dsh、codex、opencode、cursor（官方钩子）、acp、human-sim、generic-cli、mcp-mailbox
- **护栏**：轮次 / 时长 / 花费 / 卡死 / 受阻 / 静默期 / 工作时段 / 暂停哨兵 / 审批不放行 / 断点续跑
- **交代**：CW-REPORT.md（人话）+ journal.jsonl（完整事件流，含每条鞭子原文）
- **测试**：55 个用例，含离线端到端闭环、护栏、失败分类、MCP 与 ACP 协议级测试、Cursor 钩子契约
- **逆向报告**：DSH 会话格式与控制面、codex、opencode、cursor（逐条标注实测/源码/推断）

## 下一步（按价值排序）

1. **DSH 的 ACP 与 SDK JSON-RPC 通道实测接入**
   协议已经摸清（`docs/recon/dsh-control-surfaces.md`），ACP 适配器也已就绪；
   差的是用真实的 DSH ACP 端跑一次端到端（需要一个可写的 `DSH_HOME` 与 API key），
   以及把 `dsh-sdk-jsonrpc-server` 做成一个 profile 模板。价值：零侵入 + 事件流完整。
2. **多 agent 并行监工**
   现在一个监工进程管一个会话。真实项目里往往同时开着 Cursor 写前端、codex 改后端。
   做法：`cw.config.mjs` 支持 `agents: [...]` 数组，每个条目的判定/抽鞭互相独立，
   报告合并；共享一套护栏预算（避免总花费失控）。
3. **`cw status --watch` 终端面板**
   无人值守时主人最想要的是"现在到哪一步了"。用 ANSI 直接在终端画：
   当前轮次、判定、最近一条鞭子、验收命令状态、花费、距下次静默期还有多久。
4. **macOS / Linux 的拟人通道**
   `src/ui/windows.mjs` 里的命令集（idle/list-windows/focus/click/type/key/剪贴板/UIA）
   已经与平台无关；macOS 用 `osascript` + `System Events`、Linux 用 `xdotool`/`ydotool`
   各写一个驱动即可。价值：让"万能兜底通道"真正万能。
5. **Windows 原生 toast 通知**
   目前只有响铃 + webhook。用 PowerShell 的 `Windows.UI.Notifications` 发 toast，
   主人早上醒来第一眼就能看到"它收工了/它卡住了"。
6. **证据强化**
   - 把"方案文档被改动"也纳入证据（防止 agent 偷偷把验收标准改简单）；
   - 验收命令的**历史趋势**（从红到绿的过程）进报告，而不是只看最后一次；
   - 可选的"独立复核"：判定为 done 时，另起一个干净会话问它"这份 diff 真的满足验收标准吗"。

## 刻意不做

- **不替主人批准危险操作**：`guard.autoApprove` 默认 false，且打开时会告警。
- **不自动提交/合并代码**：监工的职责是"让活干完"，不是"替你决策入库"。
- **不修改 agent 的会话数据**：只读打开，绝不写。
- **不做"无限续跑"**：所有循环都必须有轮次/时长/进展三重熔断——没人看着的进程必须会自己停。

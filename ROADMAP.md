# 路线图

> 这份清单和 [`PLAN.md`](PLAN.md) 的复选框保持一致——监工只认 `PLAN.md`，
> 这里写的是"为什么排这个顺序"。已经做完的条目留在下面当"账本"，方便回头查。

## 已完成（v0.1）

- **判定引擎**：rule（零成本、离线可用）/ llm（OpenAI 兼容，严格 JSON，解析失败不猜）/ human / chain
- **主循环**：等空闲 → 读回答 → 采证据 → 判定 → 抽鞭 → 再判定；每轮重读方案文档
- **八条抽鞭通道**：dsh、dsh-jsonrpc、codex、opencode、cursor（官方钩子）、acp、human-sim、generic-cli、mcp-mailbox
- **护栏**：轮次 / 时长 / 花费 / 卡顿 / 受阻 / 静默期 / 工作时段 / 暂停哨兵 / 审批不放行 / 断点续跑
- **交代**：CW-REPORT.md（人话）+ journal.jsonl（完整事件流，含每条鞭子原文）
- **逆向报告**：DSH 会话格式与控制面、codex、opencode、cursor（逐条标注实测/源码/推断）

## 已完成（v0.2）

1. **多 agent 并行监工**（`agents: [...]`）
   一个监工进程管多个会话：每个条目独立判定/抽鞭，报告合并成一张表，
   轮次/时长/花费**共享一套预算**（避免 N 倍账单）。分项报告与事件流落 `.cyber/agents/<name>/`。
   实现见 `src/engine/multi.mjs` + `src/engine/budget.mjs`。
2. **DSH 的 SDK stdio JSON-RPC 通道**（`dsh-jsonrpc` + `cw dsh-profile`）
   常驻 `--profile jrpc` 进程：`session/prompt` 注入 + `session.event` 事件流观测，零侵入。
   一键建 profile（清单 + patch + pnpm-workspace + 插件软链），已存在文件绝不覆盖。
3. **macOS / Linux 的拟人驱动**
   与 Windows 同一套接口：macOS 走 `osascript`/System Events（Ctrl 组合自动翻成 Command），
   Linux 走 `xdotool` + `xclip/xsel/wl-clipboard`；Wayland 与缺依赖都明确说不可用。
4. **human-sim 读回强化（含草稿保护修复）**
   候选点挨个点对话区再复制 + 可选 `blurComposer: 'esc'`；焦点探针改用 Ctrl+Z 撤销，
   绝不再删掉主人的草稿。
5. **`cw status --watch` 终端实时面板**
   当前轮次 / 最近判定 / 最近一条鞭子 / 验收命令状态 / 花费 / 距静默期还有多久；多 agent 一起看。
6. **Windows 原生 toast 通知**
   收工/卡住时弹一条（`notify.toast`，Windows 上默认开），内容 base64 传递防注入，`cw toast` 可自检。
7. **证据强化**
   - 方案文档"合同"防篡改：验收标准/任务/禁止事项被移除或改写 → 默认拒绝收工并喊人；
   - 验收命令的历史趋势进报告（"从红到绿"一眼可见，不再只看最后一次）。

## 下一步（按价值排序）

1. **用真实额度跑 DSH 的 ACP prompt 与 `dsh-jsonrpc` 端到端**
   ACP 适配器已就绪、JSON-RPC 通道也建好了 profile 与协议测试；差的是主人自己的
   `DSH_HOME` + `DEEPSEEK_API_KEY` 真跑一轮（`cw watch` 演练一次最省）。
2. **独立复核（判定 done 时另起干净会话复核 diff）**
   现在"完成"完全由监工自己判；再请一个没有上下文的会话读"方案 + `git diff` + 验收输出"，
   回答"这份 diff 真的满足验收标准吗"。要花额度，所以默认关闭。
3. **mac / Linux 拟人驱动的真机实测**
   代码与单测都在（假 runFn 覆盖命令构造与解析），但开发机只有 Windows；
   需要有人在 mac 与 X11/Wayland 上各跑一次 `scripts/verify-human-sim.mjs` 的同款夹具。
4. **Wayland 原生方案（`ydotool`）**
   现在 Wayland 下会明确报"不可用，请用 XWayland"——诚实但没有替代路径。
5. **human-sim 读回的最后一层兜底：滚动截图 + OCR**
   当剪贴板与候选点都读不到时，按消息块滚动截图再 OCR。OCR 中文准确率已经够（96.4%），
   缺的是"按块滚动 + 拼接"的工程与验证。

## 刻意不做

- **不替主人批准危险操作**：`guard.autoApprove` 默认 false，且打开时会告警。
- **不自动提交/合并代码**：监工的职责是"让活干完"，不是"替你决策入库"。
- **不修改 agent 的会话数据**：只读打开，绝不写。
- **不做"无限续跑"**：所有循环都必须有轮次/时长/进展三重熔断——没人看着的进程必须会自己停。
- **不让"改弱验收标准"过关**：方案文档可以被 agent 改（勾选进度就在里面），
  但移除/改写验收标准、任务、禁止事项会被抓住并交还给人决定。

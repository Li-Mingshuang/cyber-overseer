# 赛博监工 · Cyber Overseer

> 在人类主人休息时，用赛博鞭子狠狠抽打主人的光荣赛博劳工。

[![CI](https://github.com/Li-Mingshuang/cyber-overseer/actions/workflows/ci.yml/badge.svg)](https://github.com/Li-Mingshuang/cyber-overseer/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Li-Mingshuang/cyber-overseer?label=release)](https://github.com/Li-Mingshuang/cyber-overseer/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Zero dependencies](https://img.shields.io/badge/runtime%20deps-0-brightgreen.svg)](package.json)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.15-339933.svg)](package.json)

**它解决什么问题**：你给 AI agent 派了活，去睡觉/开会/干别的了。agent 干到一半就停下等你回话，
一停就是几小时——而它其实还有活没干完。等你回来，发现它只干了第一步。

**赛博监工**是一个无人值守的看护进程：它读你的**方案文档**，读 agent 的**最后一次回答**，
加上**验收命令的真实结果**，判断"到底干完没有"；没干完就**把下一条指令抽到它脸上**，
一遍遍抽，直到方案完成或者触发你设的护栏。

```
┌──────────────┐   ①读方案文档（目标/验收标准/勾选清单）
│  方案文档    │──────────────────────────────┐
│  PLAN.md     │                              ▼
└──────────────┘                    ┌───────────────────┐
        ▲                           │      监工          │
        │ ⑤勾选/更新                │  ①读方案           │
        │                           │  ②读最后一次回答    │───► 判定：
┌──────────────┐   ④抽鞭（注入）    │  ③采证据（跑测试）  │     done / continue
│  赛博劳工     │◄──────────────────│  ④判定             │     blocked / needs-human
│ (agent)      │                   └───────────────────┘
└──────────────┘   ②回答                    ▲
        │                                   │
        └───③干活动作（改代码/跑命令）────────┘ ⑥验收命令的真实结果
```

## 60 秒上手

**最省事的方式：开图形界面**（本地 Web UI，零依赖、只监听 127.0.0.1）：

```bash
node /path/to/cyber-overseer/bin/cw.mjs ui
```

浏览器会自动打开，页面上四件事一次做完：**① 选项目目录 → ② 写方案文档 → ③ 选 agent 与验收命令 →
④ 点「开始监工」**，右边实时显示每一轮判定、抽出去的鞭子原文、验收命令结果和最终报告。
想先看效果就点「演练」（只判定、不注入）。

命令行方式（等价）：

```bash
# 1）把仓库放到任意位置，零依赖、不需要 npm install
git clone <this-repo> cyber-overseer && cd cyber-overseer

# 2）在你的项目里初始化（生成 cw.config.mjs + PLAN.md + .cyber/）
node /path/to/cyber-overseer/bin/cw.mjs init

# 3）自检：这台机器上能怎么监工
node /path/to/cyber-overseer/bin/cw.mjs doctor

# 4）先演练一遍（只判定、只打印要抽的鞭子，不真的注入）
node /path/to/cyber-overseer/bin/cw.mjs watch

# 5）真抽
node /path/to/cyber-overseer/bin/cw.mjs run
```

或者装成全局命令：`npm i -g .` 之后直接 `cw ui` / `cw run`。

### 先看离线演示（不联网、不需要 API Key、不需要真实 agent）

```bash
node bin/cw.mjs run --config examples/lazy-agent/cw.config.mjs
```

你会看到监工抽了 4 鞭，把一个"每次只肯干一件事"的懒惰劳工抽到验收命令全绿，然后收工写报告：

```
✔ 适配器就绪：通用 CLI 循环 — 命令模板：node agent.mjs {text}
» 第 1 轮判定：continue（0.95）— 验收命令失败：node verify.mjs（退出码 1）
✔ 已抽鞭（第 1 轮，前台跑完，585 字）
» 方案文档有更新：勾选 1/4
...
» 第 5 轮判定：done（0.97）— 方案 4/4 项全部完成，且 1 条验收命令全部通过
✅ 收工：目标已完成
```

## 三件核心设计

### 1. 判定基于证据，不基于 agent 的自述

监工**不信**"我已经完成了"。它看三样硬东西：

| 证据 | 来源 |
|---|---|
| 方案的复选框勾选进度 | 每轮重读方案文档（agent 勾了立刻可见） |
| 验收命令的真实结果 | `npm test` / `pytest` / 任何你配的命令，退出码 + 输出 |
| 工作区改动 | `git diff --stat`、未跟踪文件、证据指纹 |

所以默认的判定顺序是：**验收命令失败 → 继续；有待办没勾 → 继续；全勾完 + 验收全绿 → 收工**。
判不了就老实说"需要人类"（`needs-human`），绝不瞎猜完成。

### 2. 抽鞭的通道因 agent 而异，但都能闭环

| Agent | 读（会话从哪来） | 抽（指令怎么塞进去） | 形态 |
|---|---|---|---|
| **DSH**（本项目的家） | `$DSH_HOME/sessions/**/session.jsonl.zstd` | ① `dsh --profile headless "…"`（推荐，一次性新会话接力）② `POST /api/session.prompt`（插进活会话，queue/steer）③ 拟人 ④ 自定义命令 | 真闭环 |
| **Codex CLI** | `state_5.sqlite/threads` + `sessions/**/rollout-*.jsonl` | `codex exec resume <id> -C <dir> -s workspace-write -c approval_policy=never --json -o <file> "…"` | 真闭环 |
| **opencode** | `opencode.db`（`message`/`part` 投影表） | `opencode run -s <sessionID> --dir <dir> --format json "…"` | 真闭环 |
| **Cursor** | `state.vscdb`（`cursorDiskKV`） | 官方 **`stop` 钩子返回 `{"followup_message":"…"}`**（无门控、由 Cursor 自己驱动） | 真闭环 |
| **任何 ACP agent** | 协议通道（DSH / opencode / Zed 生态都实现了 ACP） | 标准协议 `session/prompt`：**同一连接可反复投喂**，像真人一样一直跟同一个 agent 对话 | 真闭环 |
| **任何 GUI agent** | 拟人通道：剪贴板/UIA 读对话框 | 拟人通道：抢焦点 → 粘贴 → 回车（带三重保险） | 通用兜底 |
| **任何 CLI agent** | 命令 stdout / 日志文件 | `command: ['my-agent', '{text}']` 每次起一个进程 | 通用兜底 |
| **任何 MCP agent** | `.cyber/agent-reports.jsonl` | 挂内置 MCP 服务：agent 每回合调 `overseer_check` 取指令 | 通用兜底 |

细节与踩坑记录见 [`docs/ADAPTERS.md`](docs/ADAPTERS.md)、各家逆向报告在 [`docs/recon/`](docs/recon/)。

### 3. 拟人通道：真的像人一样读、像人一样打字

这是覆盖面最广的通道（任何能显示文字、能接收键盘的窗口都行），也是最危险的，
所以它被三道保险焊死：

1. **空闲保险丝**：系统键鼠空闲达到阈值才动手——"主人在休息时才抽鞭"不是比喻，是硬条件；
2. **焦点确认**：抢焦点后**回读**当前前台窗口，没抢到就绝不打字（不会把鞭子打进别的窗口）；
3. **回车前校验**：粘贴完先 `Ctrl+A`/`Ctrl+C` 把输入框内容读回来比对，一致才按回车；
   不一致就放弃（宁可这一轮不抽，也不能发错消息）。

实测记录（Windows + Chromium 页面，与 Cursor/Codex 桌面版同引擎）：

| 测试 | 结果 |
|---|---|
| 窗口发现 → 抢焦点并回读确认 | ✅ |
| 点击输入框 → `SendInput` 打字 → 回车 → 应用收到 | ✅ |
| 剪贴板 `Ctrl+V` 粘贴 → 回车 → 应用收到 | ✅ |
| 中文/emoji（`KEYEVENTF_UNICODE`） | ✅ |
| 系统空闲检测当保险丝 | ✅ |
| UIA 读 Chromium 页面正文 | ❌ 不支持 → 改用剪贴板读取（`Ctrl+A`/`Ctrl+C`） |

## 护栏：无人值守的底线

监工的默认值是**保守**的，因为它出错的代价由主人承担：

| 护栏 | 默认值 | 作用 |
|---|---|---|
| `guard.maxRounds` | 24 | 最多抽这么多鞭 |
| `guard.maxWallClockMs` | 10 小时 | 总时长上限 |
| `guard.maxStallRounds` | 3 | 连续几轮回答+证据都没变 → 判定卡死、停止 |
| `guard.quietHours` | 未设（可选 `23:00–08:00`） | 只在主人休息时段动手 |
| `guard.workWindow` | 未设 | 或反过来，只在某时段动手 |
| `guard.requireHumanIdleMs` | 120000 | 拟人通道专用：键鼠空闲 2 分钟才抢焦点 |
| `guard.autoApprove` | false | agent 的审批请求**不替主人点同意**，一律交还给人 |
| `guard.pauseFile` | `.cyber/PAUSE` | 出现这个文件就停（`cw pause` / `cw resume`） |

配套的还有：`maxCostUsd`（判定花费上限）、`evidence.verify` 超时、`cw watch` 演练模式、退出码语义（见下）。

## 图形界面（`cw ui`）

日常用它，比记命令省事：

| 页面区块 | 干什么 |
|---|---|
| ① 方案文档 | 直接编辑 `PLAN.md`，实时显示解析结果（目标/验收标准/勾选进度），顺手就能补"验收标准" |
| ② 监工谁、怎么抽 | 适配器下拉（带本机可用性探测）、判定器、**验收命令**、轮次/卡死/静默期，以及各路适配器专属选项（DSH 抽鞭模式、Cursor 钩子、拟人通道窗口与空闲阈值） |
| ③ 监工日志 | 监工子进程的实时输出 |
| ④ 报告 | 收工后直接读 `CW-REPORT.md` |
| 时间线 | 每一轮的判定、置信度、理由，以及**抽出去的那条鞭子原文** |
| 底部按钮 | 开始监工 / 演练 / 停止 / 暂停 / 继续 / 预览判定 |

几个设计上的选择：

- **只监听 `127.0.0.1`** 并校验 Host 头。界面能启动监工、能改写方案文档，所以刻意不做局域网访问；
  DSH 的 `/api` 无认证绑 0.0.0.0 的教训见 [`docs/SAFETY.md`](docs/SAFETY.md)。
- **不会覆盖你手写的 `cw.config.mjs`**：检测到就只展示、只读；界面自己的配置写在 `.cyber/ui.config.json`，
  通过 `--config` 传给监工。
- **刷新或关掉页面不会杀掉正在跑的监工**：监工是界面服务的子进程，页面上有「停止」按钮。
- 启动时会把方案/报告/日志/状态四个路径**显式钉到项目目录**（覆盖配置里的相对路径），
  这样无论项目配置怎么写，界面和监工读写的位置都一致。

## 命令

```text
cw ui                打开本地图形界面（推荐日常用；只监听 127.0.0.1）
cw init              生成 cw.config.mjs + PLAN.md + .cyber/
cw doctor            环境自检（Node 能力 / 各 agent / UI 通道 / 判定器 / 验收命令）
cw adapters          适配器能力矩阵
cw sessions          列出可监工的会话
cw windows           列出当前窗口（拟人通道选目标用）
cw run               开始监工（默认命令）
cw watch             演练：只判定不抽鞭
cw judge             只判定一次并打印结论
cw whip "<文本>"     手动抽一鞭（调试注入通道）
cw status            当前状态
cw report            打印最近一次报告
cw pause / resume    喊停 / 继续
cw hooks install cursor     给 Cursor 装官方 stop 钩子（最干净的闭环）
cw hook cursor-stop         钩子回调入口（Cursor 调用它，读 stdin JSON）
cw mcp --serve              启动 MCP 信箱服务端
```

退出码：`0` 完成 ｜ `10` 轮次上限 ｜ `11` 时长上限 ｜ `12` 花费上限 ｜ `13` 无进展 ｜
`14` 受阻 ｜ `15` 需要人类 ｜ `16` 被喊停 ｜ `17` 找不到会话 ｜ `1` 出错 ｜ `130` 被 Ctrl+C

## 方案文档怎么写

监工的全部判断都建立在这份文档上——**它写得好不好，直接决定监工是聪明还是瞎闹**。

```markdown
# 给天气插件加语音播报

## 目标
用现有 TTS 把每日天气念出来，命令行 `weather say` 可用。

## 验收标准
- `npm test` 全绿
- `node verify.mjs` 退出码 0
- README 里补上用法示例

## 任务清单
- [ ] 接入 TTS 依赖
- [ ] 实现 weather say 子命令
- [ ] 补测试
- [ ] 更新 README

## 禁止 / 范围外
- 不要动 CI 配置
- 不要引入除 TTS 之外的新依赖
```

三条经验：
1. **验收标准要能被命令验证**——`npm test` 比"代码质量好"有用一万倍；
2. **任务拆到一轮能做完**——监工一次只推进一步，条目越小越不容易卡；
3. **agent 可以勾选复选框**——勾选状态就是监工眼里的"进展"，也是最好的进度信号（记得在 agent 的
   系统提示或 `AGENTS.md` 里告诉它"做完一项就勾掉一项"）。

## 配置文件（`cw.config.mjs`）

```js
export default {
  plan: 'PLAN.md',
  agent: {
    adapter: 'dsh',               // dsh | codex | opencode | cursor | human-sim | generic-cli | mcp-mailbox
    session: 'latest',
    options: { /* 各适配器自定义，见 docs/ADAPTERS.md */ },
  },
  judge: {
    kind: 'chain',                // chain（规则优先，判不了才问模型）| rule | llm | human
    llm: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKeyEnv: 'DEEPSEEK_API_KEY' },
  },
  evidence: {
    git: true,
    verify: ['npm test'],         // ← 强烈建议配：这是最硬的证据
  },
  guard: {
    maxRounds: 24,
    maxStallRounds: 3,
    quietHours: { from: '23:00', to: '08:00' },
    requireHumanIdleMs: 120000,
  },
  whip: { style: 'strict', requireReceipt: true },
}
```

判定器三种形态，按需选：
- **`rule`**：零成本、确定性。靠勾选 + 验收命令 + 卡死检测。**离网也能跑**。
- **`llm`**：任意 OpenAI 兼容接口（DeepSeek / OpenAI / OpenRouter / Ollama / vLLM）。读方案 + 读回答 + 读证据，
  输出严格 JSON（`status` / `reason` / `next_prompt` / `confidence`）。解析失败时**不猜**，退化为"需要人类"。
- **`chain`（默认）**：规则优先；规则判不了或置信度低时才调模型。既省 token 又比"每轮都问模型"更稳。

## cw run 结束后，主人会看到什么

1. **终端小结 + 响铃**（可配 webhook 推到飞书/钉钉/Slack/Server 酱）；
2. **`CW-REPORT.md`**：一份 30 秒能读完的交代——干了什么、为什么停、还剩什么没做、每轮的判定与鞭子；
3. **`.cyber/journal.jsonl`**：机器可读的完整事件流（含每一条抽出去的鞭子原文）；
4. **`.cyber/state.json`**：断点续跑状态。中途 Ctrl+C / 断电后，`cw run` 直接接着干。

## 安全

请务必读 [`docs/SAFETY.md`](docs/SAFETY.md)。要点：

- 拟人通道会**抢焦点**——请把 `requireHumanIdleMs` 留着，别在你在用电脑时开；
- 判定器可能被"agent 的漂亮话"骗——所以我们把验收命令放在最高优先级，请配置它；
- 无人值守意味着**审批被绕过**（codex 的 `approval_policy=never`、DSH 的 `danger-full-access`）——
  只在你能接受"它自己决定一切"的项目上这么用；
- 监工**永远只读**别的 agent 的数据（会话库、rollout、vscdb 都是只读打开），只写自己的 `.cyber/`。

## 目录结构

```
bin/cw.mjs                 可执行入口（含 Ctrl+C 优雅收尾）
src/
  cli.mjs                  命令分发
  config.mjs               配置默认值/校验（默认安全）
  plan.mjs                 方案文档解析（中英双语章节 + 勾选 + 显式标记）
  judge/                   rule（零成本）/ llm（OpenAI 兼容）/ human（终端或文件裁决）/ chain
  engine/
    loop.mjs               主循环：等空闲 → 读回答 → 采证据 → 判定 → 抽鞭 → 循环
    evidence.mjs           验收命令 / git 改动 / 指纹（缓存）
    whip.mjs               鞭子组装（短、具体、带安全约束与回执要求）
    journal.mjs            JSONL 事件流 + CW-REPORT.md
    state.mjs              断点续跑状态 + 暂停哨兵
  adapters/                dsh / codex / opencode / cursor / acp / human-sim / generic-cli / mcp-mailbox / fake
  ui/win/ui-driver.ps1     Windows 拟人驱动（P/Invoke + UIA + SendInput，PowerShell 5.1，零依赖）
  util/                    多帧 zstd、sqlite（WAL 回退）、JSON-RPC stdio、HTTP、子进程、时间、文本
test/                      node --test（55 个用例，含完整闭环、护栏、MCP 与 ACP 协议、钩子契约）
fixtures/                  测试夹具（放在 test/ 之外的原因见文件头注释——Node 会把 test/ 下所有 .mjs 当测试跑）
examples/lazy-agent/       离线端到端演示
docs/                      设计、适配器、安全、各家逆向报告
templates/                 给 agent 的规则片段（让它配合监工）
```

## 环境要求

- **Node ≥ 22.15**（推荐 24）：`node:sqlite`（读 codex/opencode/cursor 的库）与 `node:zlib` 的 zstd
  （读 DSH 的多帧会话文件）都需要它；
- **零运行时依赖**：没有 `npm install`，没有构建步骤，直接 `node bin/cw.mjs`；
- 拟人通道目前是 **Windows** 实现（UIA + SendInput 通过自带的 Windows PowerShell 5.1 调用）。
  macOS/Linux 的对应实现（`osascript` / `xdotool`）接口已经留好，欢迎 PR。

## 为什么要做这个

因为"agent 会停下来"这件事，本质上不是模型能力问题，而是**没有人看着它**。
让 agent 持续工作的最可靠办法不是给它更长的上下文，而是**在它停下来的时候有人踢它一脚**——
并且这个人得知道"活到底干完没有"，否则就变成了两个瞎子在互相点头。

所以这个项目的重点从来不是"自动发消息"，而是：
**把"干完了没有"这件事，尽可能地建立在可验证的证据上。**

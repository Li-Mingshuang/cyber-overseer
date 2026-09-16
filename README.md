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

**最简用法（就一个命令，什么都不用配）**：

```bash
cd <你的项目>
node /path/to/cyber-overseer/bin/cw.mjs poke
```

它只做一件事：**agent 一停下来就催它继续**。

| 它看到的状态 | 它做什么 |
|---|---|
| 正在跑 | 什么都不做（绝不插嘴） |
| 空闲了（回复完在等你） | 发一句「继续，不要停下来等我」 |
| 在等你回话 / 等审批（需要人机交互） | 发一句「我自己选最合理的做法继续；只有不可逆或需要你给凭据才等你」 |
| 它写了 `CW:DONE` | 收工 |
| 连着两轮回答没变化 | 判定卡住，停下并报告 |
| 催够次数（默认 30）/ 你 Ctrl+C / 建 `.cyber/PAUSE` | 停 |

不需要方案文档、不需要验收命令、不需要判定器、不需要配置文件——因为"催一下让它继续"这件事不需要它们。
想要"验收证据 + 判定是否真的完成"那套严谨流程时，再用下面的 `cw "<一句话>"`。

**进阶：一句话起步（自动定验收标准、自动判定完成）**：

```bash
cd <你的项目>
node /path/to/cyber-overseer/bin/cw.mjs "把登录页改成深色主题并跑通测试"
```

它自己决定这些事，并打印给你看：

```
一句话起步 · 我决定这么干
  监工谁：dsh（会话 session-89016627…） — 接着这个项目里已有的 DSH 会话，用 HTTP 注入到同一段对话
  验收：npm test（从 package.json 猜的）
  方案：<项目>/.cyber/PLAN.md（想改随时改，监工每轮重读）
  护栏：最多抽 10 鞭，连续 3 轮无进展就停
```

然后它就开始盯：判定 → 抽鞭 → 再判定，直到验收全绿并收工，或者卡死/需要人时停下写报告。
想只生成不跑：加 `--plan-only`；想换 agent：`--agent codex`；想接着某个会话：`--session <id>`。

**看有哪些 agent 会话还活着**：

```bash
node /path/to/cyber-overseer/bin/cw.mjs sessions --live
```

```
dsh 的会话（14/65，只看活跃）
  ● 正在跑          刚刚   session-d855a1fb…  虚拟3D世界Agent桌面工具      1 回合｜1501 事件
  ▲ 等你回话        刚刚   session-2ae6a4f1…  Windows端查看iPhone实况照片…  38 回合｜20343 事件
  ○ 空闲（在等人）   3 分钟前 session-d51beb5f…  本地图片转简笔画工具推荐     1 回合
```

**图形界面**（想看得清楚时用）：`cw ui`，见下文「图形界面」一节。

## 一句话起步（零配置）

用户的原话是：*"我叫 agent 干活都是说一句话，搞个监工代替我劳动还要配这配那"*。所以：

```bash
cw "把 artifacts 下那四份产物做完"          # 等价于 cw do "…"
```

它自动做四件事：

| 自动决策 | 依据 |
|---|---|
| **监工谁** | 优先 DSH；若这个项目里已有 DSH 会话且界面服务在跑 → 用 `POST /api/session.prompt` **接着那段对话**（像真人接着聊），否则 `headless` 起干净劳工；没 DSH 就按 codex → opencode → cursor → … 挑本机可用的 |
| **验收命令** | 嗅探 `package.json`（test/lint/typecheck/build）、`pnpm/yarn.lock`、`pyproject.toml`、`pytest.ini`、`Cargo.toml`、`go.mod`、`Makefile`、`verify.mjs` |
| **方案文档** | 一句话当目标 + 验收命令当验收标准，写进 `<项目>/.cyber/PLAN.md`（**不碰**你项目根的 PLAN.md）；想改随时改，监工每轮重读 |
| **判定策略** | 零配置模式：**验收命令全绿** + agent 的完成宣告（`CW:DONE`）+ 卡死检测。没有全绿就绝不判完成；全绿但没宣告会先要求它自查一次，问过之后仍全绿才收工 |

常用开关：`--plan-only`（只生成方案不跑）· `--agent codex` · `--session <id>` · `--cmd "node agent.mjs {text}"`
（任意命令行 agent）· `--verify "npm test;npm run lint"` · `--max-rounds 8` · `--no-join`（不插进活会话）。

复现同一次监工：它会写一份 `<项目>/.cyber/auto.config.json`，`cw run --config .cyber/auto.config.json` 即可。

## 命令行完整流程

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
| 方案文档的"合同"有没有被改弱 | 第一轮取基线（验收标准/任务/禁止事项文本），之后任何**移除或改写**都拒绝收工 |

所以默认的判定顺序是：**验收命令失败 → 继续；有待办没勾 → 继续；全勾完 + 验收全绿 → 收工**。
判不了就老实说"需要人类"（`needs-human`），绝不瞎猜完成。

两条针对"证据会不会被骗"的加固：

- **验收命令的历史趋势**：报告里按命令画出"第 N 轮 ✔/✖"，结论直接写"从红到绿 / 一直通过 / 仍未通过"
  ——只看最后一次是会被骗的；
- **方案文档防篡改**：agent 能改方案文档（勾选进度就在里面），所以"把验收标准改简单、把不想做的任务删掉"
  会被抓住（`evidence.planGuard`，默认开）→ 规则判定**拒绝收工**并喊人。明确接受这种改法的项目
  可以关掉，或用 `allowPlanWeakening: true` 显式放行。

### 2. 抽鞭的通道因 agent 而异，但都能闭环

| Agent | 读（会话从哪来） | 抽（指令怎么塞进去） | 形态 |
|---|---|---|---|
| **DSH**（本项目的家） | `$DSH_HOME/sessions/**/session.jsonl.zstd` | ① `dsh --profile headless "…"`（推荐，一次性新会话接力）② `POST /api/session.prompt`（插进活会话，queue/steer）③ **SDK stdio JSON-RPC**（常驻进程：`session/prompt` 注入 + `session.event` 事件流观测，一次建 profile 后长期可用）④ 拟人 ⑤ 自定义命令 | 真闭环 |
| **Codex CLI** | `state_5.sqlite/threads` + `sessions/**/rollout-*.jsonl` | `codex exec resume <id> -C <dir> -s workspace-write -c approval_policy=never --json -o <file> "…"` | 真闭环 |
| **opencode** | `opencode.db`（`message`/`part` 投影表） | `opencode run -s <sessionID> --dir <dir> --format json "…"` | 真闭环 |
| **Cursor** | `state.vscdb`（`cursorDiskKV`） | 官方 **`stop` 钩子返回 `{"followup_message":"…"}`**（无门控、由 Cursor 自己驱动） | 真闭环 |
| **任何 ACP agent** | 协议通道（DSH / opencode / Zed 生态都实现了 ACP） | 标准协议 `session/prompt`：**同一连接可反复投喂**，像真人一样一直跟同一个 agent 对话 | 真闭环 |
| **任何 GUI agent** | 拟人通道：剪贴板/UIA 读对话框 | 拟人通道：抢焦点 → 粘贴 → 回车（带三重保险；Windows / macOS / Linux 都有驱动） | 通用兜底 |
| **任何 CLI agent** | 命令 stdout / 日志文件 | `command: ['my-agent', '{text}']` 每次起一个进程 | 通用兜底 |
| **任何 MCP agent** | `.cyber/agent-reports.jsonl` | 挂内置 MCP 服务：agent 每回合调 `overseer_check` 取指令 | 通用兜底 |

细节与踩坑记录见 [`docs/ADAPTERS.md`](docs/ADAPTERS.md)、各家逆向报告在 [`docs/recon/`](docs/recon/)。

### 2.1 多 agent 并行监工

真实项目里常同时开着 Cursor 写前端、codex 改后端。配一个 `agents[]` 数组就并行盯：

```js
export default {
  agents: [
    { name: 'front', adapter: 'cursor', cwd: 'apps/web', plan: 'PLAN-web.md' },
    { name: 'back',  adapter: 'codex',  cwd: 'apps/api', plan: 'PLAN-api.md' },
  ],
  evidence: { verify: ['npm test'] },   // 每个条目都可以覆盖任意配置
}
```

- 每个条目**独立**判定/抽鞭（自己的 adapter / 目录 / 方案 / 判定器）；
- 轮次 / 时长 / 花费是**共享一套预算**（不会变成 N 倍账单），账目进合并报告；
- 分项报告 `CW-REPORT-<name>.md`、独立事件流 `.cyber/agents/<name>/`，总报告把结果与预算去向合并成一张表；
- 任何一个 agent 挂掉都不影响其它（错误隔离，退出码取最严重的）；
- 实时看：`cw status --watch`。

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

**三个平台都有驱动**（同一套接口，`src/ui/`）：

| 平台 | 依赖 | 备注 |
|---|---|---|
| Windows | 自带的 Windows PowerShell 5.1（UIA + SendInput） | 含截图/OCR |
| macOS | `osascript`（System Events） | 第一次要在「系统设置 → 隐私与安全性 → 辅助功能」里给终端/Node 授权；Ctrl 组合自动翻成 Command |
| Linux | `xdotool` + `xclip`/`xsel`/`wl-clipboard` | Wayland 需 XWayland；没有 `xprintidle` 时读不到空闲时间，`requireHumanIdleMs > 0` 会一直等（宁可不动） |

`cw doctor` / `cw windows` 会直接告诉你本平台能不能用、还差什么。

**读回与草稿保护**（这条通道最脆弱的地方）：

- 焦点被输入框抢走时（`Ctrl+A` 只选到空输入框），按一串候选点挨个"点对话区 → 再复制"，
  捞到像对话记录的就停；可以用 `readerClickPoints` 自己指定候选点；
- 可选 `blurComposer: 'esc'` 在读之前按一次 Esc 把焦点赶出输入框（默认关：有些 agent 的 Esc 是"停止生成"）；
- **绝不破坏你的草稿**：确认焦点用的探针从"粘贴 + Ctrl+A + Delete"改成"只读预检 + **Ctrl+Z 撤销**"，
  读回"草稿 + 探针"时直接放弃这一鞭（除非你显式 `clearComposer: true`）。

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
cw "<一句话目标>"     一句话起步：自动选 agent / 猜验收命令 / 生成方案 / 直接开跑
cw sessions --live   看有哪些 agent 会话还活着（正在跑 / 等回话 / 空闲）
cw ui                打开本地图形界面（想看得清楚时用；只监听 127.0.0.1）
cw init              生成 cw.config.mjs + PLAN.md + .cyber/（要精细控制时才需要）
cw doctor            环境自检（Node 能力 / 各 agent / UI 通道 / OCR 引擎 / 判定器 / 验收命令）
cw adapters          适配器能力矩阵
cw sessions          列出可监工的会话（--adapter codex / --live）
cw windows           列出当前窗口（拟人通道选目标用）
cw run               开始监工（默认命令）
cw watch             演练：只判定不抽鞭
cw judge             只判定一次并打印结论
cw whip "<文本>"     手动抽一鞭（调试注入通道）
cw status            当前状态（`cw status --watch` 是终端实时面板，多 agent 一起看）
cw report            打印最近一次报告
cw pause / resume    喊停 / 继续
cw toast             自检 Windows 原生通知（收工提醒）
cw dsh-profile       查看/安装 DSH 的 SDK JSON-RPC profile（`--install`，零 token）
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
    adapter: 'dsh',               // dsh | dsh-jsonrpc | codex | opencode | cursor | acp | human-sim | generic-cli | mcp-mailbox
    session: 'latest',
    options: { /* 各适配器自定义，见 docs/ADAPTERS.md */ },
  },
  // 多 agent 并行（可选）：每个条目独立判定/抽鞭，预算共享、报告合并
  // agents: [{ name: 'front', adapter: 'cursor', cwd: 'apps/web', plan: 'PLAN-web.md' }],
  judge: {
    kind: 'chain',                // chain（规则优先，判不了才问模型）| rule | llm | human
    llm: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKeyEnv: 'DEEPSEEK_API_KEY' },
  },
  evidence: {
    git: true,
    verify: ['npm test'],         // ← 强烈建议配：这是最硬的证据
    planGuard: true,              // 方案文档"合同"防篡改（验收标准/任务被移除或改写 → 拒绝收工）
  },
  guard: {
    maxRounds: 24,
    maxStallRounds: 3,
    quietHours: { from: '23:00', to: '08:00' },
    requireHumanIdleMs: 120000,
  },
  whip: { style: 'strict', requireReceipt: true },
  notify: { beep: true, toast: 'auto' },   // toast：Windows 上默认开（收工时弹一条）
}
```

判定器三种形态，按需选：
- **`rule`**：零成本、确定性。靠勾选 + 验收命令 + 卡死检测。**离网也能跑**。
- **`llm`**：任意 OpenAI 兼容接口（DeepSeek / OpenAI / OpenRouter / Ollama / vLLM）。读方案 + 读回答 + 读证据，
  输出严格 JSON（`status` / `reason` / `next_prompt` / `confidence`）。解析失败时**不猜**，退化为"需要人类"。
- **`chain`（默认）**：规则优先；规则判不了或置信度低时才调模型。既省 token 又比"每轮都问模型"更稳。

## cw run 结束后，主人会看到什么

1. **终端小结 + 响铃 + Windows 原生 toast**（`notify.toast`，默认 Windows 上开；还能配 webhook 推到飞书/钉钉/Slack/Server 酱）；
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
  plan.mjs                 方案文档解析（中英双语章节 + 勾选 + 显式标记 + 合同指纹）
  dsh-profile.mjs          DSH 的 SDK JSON-RPC profile 模板与安装（cw dsh-profile）
  judge/                   rule（零成本）/ llm（OpenAI 兼容）/ human（终端或文件裁决）/ chain
  engine/
    loop.mjs               主循环：等空闲 → 读回答 → 采证据 → 判定 → 抽鞭 → 循环
    multi.mjs              多 agent 并行：展开 agents[]、共享预算、合并报告
    budget.mjs             共享预算（总轮次/总时长/总花费，谁用掉了多少）
    panel.mjs              cw status --watch 的实时面板（纯渲染，可单测）
    evidence.mjs           验收命令 / git 改动 / 指纹（缓存）/ 方案合同防篡改
    whip.mjs               鞭子组装（短、具体、带安全约束与回执要求）
    journal.mjs            JSONL 事件流 + CW-REPORT.md（含验收命令历史趋势）
    state.mjs              断点续跑状态 + 暂停哨兵 + 合同基线
  adapters/                dsh / dsh-jsonrpc / codex / opencode / cursor / acp / human-sim / generic-cli / mcp-mailbox / fake
  ui/
    index.mjs              按平台挑驱动（win32 / darwin / linux）
    windows.mjs + win/ui-driver.ps1   Windows（P/Invoke + UIA + SendInput，PowerShell 5.1，零依赖）
    darwin.mjs             macOS（osascript + System Events）
    linux.mjs              Linux（xdotool + xclip/xsel/wl-clipboard）
  util/                    多帧 zstd、sqlite（WAL 回退）、JSON-RPC stdio、HTTP、子进程、toast、时间、文本
test/                      node --test（134 个用例，含完整闭环、护栏、多 agent、并行预算、协议与钩子契约）
fixtures/                  测试夹具（放在 test/ 之外的原因见文件头注释——Node 会把 test/ 下所有 .mjs 当测试跑）
examples/lazy-agent/       离线端到端演示
docs/                      设计、适配器、安全、各家逆向报告
templates/                 给 agent 的规则片段 + DSH 的 jrpc profile 模板
```

## 环境要求

- **Node ≥ 22.15**（推荐 24）：`node:sqlite`（读 codex/opencode/cursor 的库）与 `node:zlib` 的 zstd
  （读 DSH 的多帧会话文件）都需要它；
- **零运行时依赖**：没有 `npm install`，没有构建步骤，直接 `node bin/cw.mjs`；
- 拟人通道三个平台都有驱动：Windows（系统自带 Windows PowerShell 5.1 + UIA + SendInput）、
  macOS（`osascript`，需辅助功能权限）、Linux（`xdotool` + 剪贴板工具，Wayland 需 XWayland）。
  `cw doctor` 会告诉你本平台还差什么；mac/Linux 的驱动有单测但**尚未在真机上实测**（开发机只有 Windows）。

## 为什么要做这个

因为"agent 会停下来"这件事，本质上不是模型能力问题，而是**没有人看着它**。
让 agent 持续工作的最可靠办法不是给它更长的上下文，而是**在它停下来的时候有人踢它一脚**——
并且这个人得知道"活到底干完没有"，否则就变成了两个瞎子在互相点头。

所以这个项目的重点从来不是"自动发消息"，而是：
**把"干完了没有"这件事，尽可能地建立在可验证的证据上。**

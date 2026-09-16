# 适配器接入指南

每个适配器回答四个问题：**能不能用**（probe）、**有哪些会话**（listSessions）、
**它现在在干什么**（readState）、**怎么把下句话塞进去**（whip）。

`whip()` 的返回值里 `mode` 决定引擎要不要等：`foreground` = 这次调用已经跑完一整轮；
`inject` = 只是塞了句话进去，还要等它开工收工。见 [`DESIGN.md`](DESIGN.md#3-时间与状态谁等谁)。

先用 `cw adapter`/`cw adapters` 看这台机器上的实际情况，再挑一条：

```bash
cw adapters          # 每个适配器的可用性与能力
cw sessions          # 列出可监工的会话
cw doctor            # 环境自检
```

---

## DSH（DeepSeek Harness）—— 本项目的一等公民

```js
agent: {
  adapter: 'dsh',
  cwd: '/path/to/project',
  session: 'latest',            // 或具体 session id；'latest' 会在 headless 模式下跟着最新会话走
  options: {
    whip: 'headless',           // headless（默认）| http | human-sim | custom
    dshEntry: 'C:/path/to/deepseek-harness/apps/cli/lib/bin.js',  // 找不到 dsh 时显式指定
    permissionMode: 'workspace-write',  // 无人值守可改 danger-full-access（=审批 never，风险自负）
  },
}
```

**读**：`$DSH_HOME/sessions/<slug>/<session-id>/session.jsonl.zstd`。这是**拼接的多帧 zstd**，
Node 自带的解码器只吃第一帧（实测 774KB 的文件只解出 191 字节），必须逐帧解 —— 已实现于
`src/util/zstd-frames.mjs`。要点：

- 最后一次回答 = **反向**找第一条含 `type:'text'` 的 `assistant/message`
  （最后一条可能只有 `tool-call`，没有文本）；
- 忙/闲 = 折叠 `turn/start` / `turn/end`，**最后一个胜出**；
- 审批中 = 有 `approval/asked` 没有对应 `approval/decided`；
- 等人类回答 = 有未配对的 `ask_user_question` / `exit_plan_mode` 工具调用；
- 并发读安全：每次 append 都是完整帧 + 完整行，丢掉半截尾帧不会产生半行。

**四种抽鞭方式**：

| 模式 | 命令/接口 | 形态 | 适用 |
|---|---|---|---|
| `headless`（默认） | `dsh --profile headless "<鞭子>"` | foreground | 无人值守首选。**注意：每次都是全新会话**（headless 没有 `--resume`），"记忆"靠工作区（PLAN.md + 代码 + git）。stdout = 最后一条回答，exit 0 仅当 `turn/end` 的 reason 是 `completed` |
| `http` | `POST /api/session.prompt` | inject | 插进**正在运行**的会话（"同一个人接着干"）。信封见下 |
| `human-sim` | 在 DSH 的 GUI 窗口里打字 | inject | Web GUI 场景；复用拟人通道的三道保险 |
| `custom` | 自定义命令模板（`{text}`/`{session}`/`{cwd}`） | inject 或 foreground | 例如 tmux：`['tmux','send-keys','-t','dsh','{text}','Enter']` |

HTTP 注入的信封（实测自 DSH 源码）：

```json
POST /api/session.prompt
{ "type": "client-request", "rpcId": "…", "method": "session.prompt",
  "payload": { "sessionId": "session-…", "mode": "queue",
               "content": [{ "type": "text", "text": "…" }] } }
```

`mode:'queue'` = 排成新回合（不打断当前工作）；`'steer'` = 插进当前回合。
冷会话会被服务端隐式 resume。**安全提示**：DSH 的 `/api` 没有认证层，所以本适配器**拒绝**
向非 `127.0.0.1`/`localhost` 的地址注入（见 `docs/SAFETY.md`）。

**前置条件**：`$DSH_HOME/profiles/<profile>/` 需要可写（DSH 每次 boot 会重写 `cordis.yml`）；
读会话需要 Node 带 zstd（≥22.15）。

---

## Codex CLI

```js
agent: {
  adapter: 'codex',
  cwd: '/path/to/project',
  options: {
    approvalPolicy: 'never',   // 无人值守需要它不弹审批；改成 'on-request' 会挂起等人类
    sandbox: 'workspace-write',
    newSession: false,         // true = 每鞭起新会话（codex exec）而不是 resume
  },
}
```

**读**：索引在 `$CODEX_HOME/state_5.sqlite` 的 `threads` 表（`cwd` 带 Windows `\\?\` 前缀，需剥掉），
正文在 `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`。三个坑：

1. **rollout 的 mtime 停在创建时刻**，只有 ctime 随追加走——用 mtime 判"是否在跑"会永远误判成死；
2. `user_message` 事件**没有 turn_id**，要归给前一个 `task_started`；
3. 单行可能极大（实测有一条 21MB 的 `custom_tool_call_output`），必须按行大小跳过再解析。

**抽**：`codex exec resume <session-id> -C <cwd> -s workspace-write -c approval_policy=never --json -o <file> "<鞭子>"`
（`--json` 事件流走 stdout，最终回答同时写进 `-o` 指定的文件；两者都读，哪个有用用哪个）。

---

## opencode

```js
agent: {
  adapter: 'opencode',
  cwd: '/path/to/project',
  options: { auto: false, agent: null, model: null },   // auto=true 会放行权限请求
}
```

**读**：`~/.local/share/opencode/opencode.db`。它是**事件溯源 + 投影**：真源在 `event` 表，
但读对话要读投影表 `message` + `part`（两表的 `data` 列都是 JSON 字符串）。
权威的"收工了没有"判据：最后一个 `part/step-finish` 的 `reason === 'stop'`。

**抽**：`opencode run -s <sessionID> --dir <cwd> --format json "<鞭子>"`。

两个坑：

1. **`-c/--continue` 不按 cwd 过滤**（它取全局最近更新的顶层会话）→ 永远显式 `-s`；
2. `opencode run` 默认会**自动拒绝**权限请求（收到 `permission.asked` 直接 reject，不挂起），
   要放行必须 `--auto`（本适配器映射到 `options.auto`）。

---

## Cursor —— 最干净的闭环（官方钩子）

```js
agent: { adapter: 'cursor', cwd: '/path/to/project', options: { whip: 'hooks' } }
```

```bash
cw hooks install cursor     # 写 .cursor/hooks.json
```

生成的配置（Cursor 热重载）：

```json
{ "version": 1,
  "hooks": {
    "stop": [ { "command": "\"<node>\" \"<…>/bin/cw.mjs\" hook cursor-stop --cwd \"<项目>\"",
                "timeout": 60, "failClosed": false, "loop_limit": 25 } ],
    "afterAgentResponse": [ { "command": "… hook cursor-response …" } ] } }
```

之后 Cursor **每个回合结束都会回调监工**：读方案 + 读最后一次回答 → 判定 →
返回 `{"followup_message": "…"}` 就继续抽，返回 `{}` 就停下（完成/受阻/需要人类）。
好处：不轮询、不抢焦点、不用常驻进程，还自带 `loop_limit` 防死循环。

**读**（`state.vscdb`，只读）：`cursorDiskKV['composerData:<composerId>']` 给出消息顺序
（`fullConversationHeadersOnly`），每条正文在 `cursorDiskKV['bubbleId:<composerId>:<bubbleId>']`
的 `.text`（`type` 1=用户 2=助手）；忙闲看 `composerData.status`（`generating` = 忙）。
**`conversation-search.db` 滞后 ≥1 轮，不能用来读"最新回答"**（只能做全文检索）。

**备选抽鞭**：`cursor desktop send <threadId> <text> --json`（需要 Cursor 里打开
Settings → Beta → "Allow CLI to access desktop agents" 并重启），以及拟人通道兜底。

---

## ACP（Agent Client Protocol）—— 跨 agent 的标准通道

```js
agent: {
  adapter: 'acp',
  options: {
    preset: 'opencode',        // opencode | dsh | gemini，或自己给 command
    // command: ['node', '<deepseek-harness>/packages/examples/acp-demo/lib/bin.js', '--config', 'examples/acp-agent/cordis.yml'],
    dshCheckout: 'C:/path/to/deepseek-harness',     // 替换命令里的 <deepseek-harness>；dsh 预设必填
    launchCwd: 'C:/path/to/deepseek-harness',       // ACP 服务端进程的启动目录（dsh 预设会自动用它）
    acpCwd: '/path/to/project',                     // session/new 的 cwd（agent 在这里干活）
    permissionMode: 'workspace-write',              // 传给 dsh 的 DSH_PERMISSION_MODE
  },
}
```

> ⚠️ **两个 cwd 必须分开**，这是踩出来的：`launchCwd` 是 *ACP 服务端进程* 的启动目录，
> `acpCwd` 是传给 `session/new` 的 *工作区*。DSH 的 `--config examples/acp-agent/cordis.yml`
> 是**相对路径**，所以进程必须在 deepseek-harness 仓库根启动，否则一启动就找不到配置。
> （`preset: 'dsh'` 会自动把 `launchCwd` 设成 `dshCheckout`。）

### 零成本自检（不发 prompt、不花额度）

```bash
node scripts/verify-acp.mjs                          # 自动找 DSH
node scripts/verify-acp.mjs --preset opencode
node scripts/verify-acp.mjs --command "node <harness>/packages/examples/acp-demo/lib/bin.js --config examples/acp-agent/cordis.yml" --cwd <harness>
```

它只做 `initialize` → `session/new` → `session/cancel` 三步握手，**绝不发送 prompt**，
所以零 token 消耗。跑通它就说明抽鞭之前的全部前置条件成立（入口、协议、工作区都对）。

实测输出（真实 DSH ACP 服务端）：

```
✔ initialize：{"protocolVersion":1,"agentInfo":{"name":"deepseek-harness-acp","version":"0.0.1"},…}
✔ session/new：sessionId=438d5356-db94-483e-ab01-547b45d04cb8
✔ 已发送 session/cancel
结论：ACP 通道可用（本次握手未发送任何 prompt，零 token 消耗）。
```

ACP 是"客户端 ↔ agent"的开放协议（DSH、opencode、Zed 生态都实现了）。对监工来说它有一个很舒服的
性质：**同一个连接里的会话可以反复投喂 prompt**，所以监工能像真人一样一直跟同一个 agent 对话——
比"每鞭起一个全新会话"更接近真人监工（对话上下文不丢）。

协议帧（实测自 DSH 的真实快照，见 [`recon/dsh-control-surfaces.md`](recon/dsh-control-surfaces.md) §3）：

```jsonc
// 客户端 → agent
{ "jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}} }
{ "jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"…","mcpServers":[]} }        // → {sessionId}
{ "jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"…","prompt":[{"type":"text","text":"…"}]} }
{ "jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"…"} }

// agent → 客户端
{ "jsonrpc":"2.0","method":"session/update","params":{"sessionId":"…",
    "update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"…"}}} }
{ "jsonrpc":"2.0","id":1,"method":"session/request_permission","params":{"toolCall":{…},"options":[…]} }
```

**必须知道的限制**（否则会误判 agent 在偷懒）：

- 只看得见**成文助手文本**（`agent_message_chunk`）：拿不到工具调用、reasoning、usage →
  判定必须依赖方案勾选与验收命令，别指望从协议里看出"它干了多少活"；
- **跨连接不能恢复**（没有 `session/load`/`resume`）：一次 `cw run` 一个连接，重启就是新会话；
- 一个会话同时只允许一个 in-flight prompt（第二个会报错）→ 适配器会返回 `kind:'transient'`，
  引擎下一轮再试，不会误判成出错。

**审批**：`session/request_permission` 是 agent 反向问"能不能执行"。默认**拒绝**（fail-closed），
只有 `guard.autoApprove` 明确打开才放行——监工不替主人点"同意"。
（协议用的是客户端反向请求，`JsonRpcStdioClient` 已经处理好了"服务端 → 客户端请求"这一侧。）

**一个实现细节值得记一笔**：DSH 的 JSON-RPC 传输层对每行 `void handleLine(line)` **不 await**，
所以同一批到达的帧会并发处理 → 客户端**必须先等到 `initialize` 的响应再发 `session/prompt`**，
否则会撞上"用了默认模型"之类的竞态（我们的客户端所有请求都带 id 且等待响应，天然满足）。

---

## DSH 的 SDK JSON-RPC 通道（`dsh-jsonrpc`）

DSH 自带一个 **stdio JSON-RPC 2.0** 服务端（插件包 `@deepseek-ai/dsh-sdk-jsonrpc-server`），
它同时提供**注入**（`session/prompt`，服务端内部就是 `agent.followup`）与**观测**
（`session.event` / `session.status` 逐条推事件）——是"可控自律进程"里最干净的一条通道
（协议实测见 `docs/recon/dsh-control-surfaces.md` §4.6）。

但它**不在产品 CLI 的 web/headless profile 里**，所以要自建一个 profile：

```bash
cw dsh-profile            # 体检：还差什么会说清楚
cw dsh-profile --install --sdk-path <deepseek-harness>/packages/sdk/server
```

`--install` 只做三件事，且**已存在的文件一律不覆盖**（`--force` 才覆盖）：

| 文件（`<DSH_HOME>/profiles/jrpc/`） | 内容 |
|---|---|
| `package.json` | `{ private:true, dependencies:{}, dsh:{ profile:{ bundles:['@deepseek-ai/dsh-base'] } } }`（与 DSH 的 `initProfile` 同形状） |
| `cordis.patch.yml` | `- insert: [{ id: sdk-jsonrpc-server, name: '@deepseek-ai/dsh-sdk-jsonrpc-server' }]` |
| `pnpm-workspace.yaml` | `nodeLinker: hoisted` / `autoInstallPeers: false` |

并把插件包软链到 `<DSH_HOME>/profiles/node_modules/@deepseek-ai/dsh-sdk-jsonrpc-server`
（Windows 用 junction，不需要管理员）。DSH 只会把"安装包依赖闭包"里的包软链过去，
而这个包不在其中，这一步不能省。模板文件在 `templates/dsh-profile-jrpc/`。

```js
agent: {
  adapter: 'dsh-jsonrpc',
  options: {
    profile: 'jrpc',
    workspace: 'C:/path/to/被监工的项目',   // DSH 的工作目录
    // dshHome / dshEntry / model / provider / initialize（透传给 initialize）
  },
}
```

**三个必须知道的协议事实**（都是实测踩出来的，适配器里已处理）：

1. **必须等 `initialize` 的响应再发 `session/prompt`**：DSH 对同一批到达的帧是
   `void handleLine()` **并发**处理；抢跑会撞上"用了默认模型"的 400。
   本适配器的所有请求都带 id 且等响应，天然串行（`test/dsh-jsonrpc.test.mjs` 用假传输层
   与真子进程夹具各钉了一遍帧顺序）。
2. **没有 resume**：给一个不存在的 `sessionId` 是**新建**会话，不载入历史 → 记忆靠工作区与提示词。
3. **没有 cancel/close**：放弃只能杀进程；stdout 被协议独占，profile 组合里不能有 stdout logger。

失败分类：`-32601/-32602`（方法不存在/参数错）与解析不到包 → `setup`（停下喊人）；
超时 → `transient`（下轮再试）；其余 → `fatal`。

---

## 拟人通道（任何 GUI agent）

```js
agent: {
  adapter: 'human-sim',
  options: {
    windowMatch: { process: 'Cursor' },        // 或 { title: 'Codex' }，用 cw windows 挑
    composer: { relX: 0.5, relY: 0.94 },       // 输入框位置（默认底部居中）；也可给绝对 {x,y}
    inputMode: 'paste',                        // paste（剪贴板+Ctrl+V，默认）| type（逐字）
    readerAdapter: 'cursor',                   // 能读磁盘就读磁盘（最准）
    stableMs: 20000,                           // 文本安静这么久 = 它说完了（代理信号）
    humanIdleMs: 120000,                       // 键鼠空闲这么久才动手
    verifyComposer: true,                      // 回车前校验输入框内容
    clearComposer: false,                      // 绝不主动清空主人的草稿
  },
}
```

**三道保险**（见 `SAFETY.md`）：空闲保险丝 → 焦点回读确认 → 回车前内容校验。
读取优先 `readerAdapter`（磁盘），否则剪贴板整段捞（`Ctrl+A`/`Ctrl+C`），再不行 UIA。
"最后一次回答"的切法很关键：**我们知道刚打进去的鞭子原文**，按它最后一次出现的位置切开，
后面那段就是回答——比任何"按发言人分行"的启发式都可靠。

### 实测状态与已知限制（重要）

用 `npm run verify:human-sim` 可以对着一份夹具页面跑真实闭环，当前实测：

| 环节 | 状态 |
|---|---|
| 空闲保险丝（主人在用电脑时拒绝动手） | ✅ 通过 |
| 抢焦点 + 回读确认 | ✅ 通过 |
| 焦点探针（粘贴探针字符再读回，确认焦点真在输入框） | ✅ 通过 |
| 粘贴 + 回车前校验 + 回车 | ✅ 通过（中文与 `✓` 都正确送达） |
| 应用确认收到（窗口标题变化） | ✅ 通过 |
| **读回对话记录** | ⚠️ **有限制，见下** |

**读回的限制**：读取依赖 `Ctrl+A`/`Ctrl+C` 选中"对话记录"。但聊天式界面（Cursor / Codex / 本仓库夹具）
在 agent 回复完会把光标放回**输入框**——此时 `Ctrl+A` 选中的是空的输入框，复制不到东西。
适配器做了五层处理：

1. **哨兵校验**：复制前后写入唯一哨兵，若复制没发生就判定"读取失败"，
   而不是把**主人剪贴板里的旧内容**当成 agent 的回答（这是真实踩到的严重误判路径）；
2. **对话区候选点**：失败时按候选点（`options.readerClick` → 默认 4 个位置，见
   `resolveReaderClickCandidates`）依次"点一下 → 再复制"，捞到像对话记录的就停；
   想更稳可以用 `options.readerClickPoints` 明确给出几个点；
3. **可选 Esc 模糊**：`options.blurComposer: 'esc'` 会在读之前按一次 Esc 把焦点赶出输入框——
   默认**关闭**，因为有些 agent 的 Esc 是"停止生成"，我们不能在它干活时把它按停；
4. **前台复查**：按 Ctrl+A/Ctrl+C 之前复查目标窗口仍是前台，防止主人中途切窗导致复制到别处；
5. **优先 `readerAdapter`**：能读磁盘（`cursor`/`dsh`）就不要用这套启发式。

**要让它稳定工作，请显式配置 `readerClick` 指向对话记录区域**（例如窗口中部偏上），
或者更推荐：配 `readerAdapter`（如 `cursor`/`dsh`）**直接读磁盘会话**——那是最准的，
UI 只用来写入。纯 GUI 场景（没有任何可读的会话存储）下，读回仍是本通道最脆弱的一环。

**草稿保护（v0.2 修复）**：焦点探针以前用"粘贴探针 → Ctrl+A → Delete"清理，
这会把输入框里已有的草稿**一起删掉**（而调用方是在之后才检查"有没有草稿"的，来不及）。
现在改为：先只读地看一眼焦点处的内容（读回来是整段对话就说明焦点不在输入框），
粘贴探针后用 **Ctrl+Z 撤销**；如果读回的是"草稿 + 探针"，会明确报 `draft`，
调用方**一个字符都不动**，直接放弃这一鞭（除非显式配置 `clearComposer: true`）。

平台：Windows / macOS / Linux 三个驱动实现同一套接口（`src/ui/`）：

| 平台 | 驱动实现 | 依赖 | 未实现的部分 |
|---|---|---|---|
| Windows | `src/ui/windows.mjs` + `win/ui-driver.ps1` | Windows PowerShell 5.1（UIA + SendInput） | — |
| macOS | `src/ui/darwin.mjs` | `osascript`（System Events） | UI 元素树、截图/OCR |
| Linux | `src/ui/linux.mjs` | `xdotool` + `xclip`/`xsel`/`wl-clipboard` | UI 元素树、截图/OCR；Wayland 需 XWayland |

macOS 第一次用需要给终端/Node 开「辅助功能」权限；Linux 的键鼠空闲时间依赖 `xprintidle`，
没有它时 `requireHumanIdleMs > 0` 会让通道**一直等**（宁可不动，也不在主人用电脑时抢焦点）。
用 `cw doctor` / `cw windows` 可以直接看到本平台的结论与可操作提示。

---

## 通用 CLI 循环（任何命令行 agent）

```js
agent: {
  adapter: 'generic-cli',
  options: {
    command: ['my-agent', '--resume', '{session}', '{text}'],
    useStdin: false,                 // true 时把鞭子写进 stdin，模板里不要放 {text}
    readCommand: ['tail', '-n', '200', 'agent.log'],   // 可选：回答不在 stdout 时用它读
    timeoutMs: 1800000,
  },
}
```

每次抽鞭起一个干净进程，`stdout` 就是"最后一次回答"（也会落一份到 `.cyber/agent-last-answer.txt`）。
这是最不挑食、最稳的形态：记忆全在工作区，任何"给提示词→干活→退出"的程序都能被监工。

---

## MCP 信箱（任何支持 MCP 的 agent）

```bash
cw mcp --serve     # stdio MCP 服务端
```

给 agent 挂上它，并在规则文件里要求它**每回合结束前调用 `overseer_check`**、**做完事调用 `overseer_report`**：

- `overseer_check` → 返回监工写好的最新指令（鞭子）；
- `overseer_report` → agent 汇报本轮总结/证据/是否受阻（`.cyber/agent-reports.jsonl`），监工据此判定。

"抽鞭"退化成写一个文件，"读回答"退化成读一行 JSONL：跨 agent 通用、零副作用、
不用抢焦点、不用解析私有格式。代价是需要 agent 配合（模板见 `templates/`）。
各家的 MCP 配置入口：Cursor `.cursor/mcp.json`、codex `config.toml` 的 `[mcp_servers.x]`、
opencode 的 `mcp` 键。

---

## 写一个新适配器

```js
export function createMyAdapter(ctx) {
  return {
    id: 'my-agent',
    label: '我的 agent',
    docs: '一句话说明靠什么通道工作',

    async probe() { return { ok: true, detail: '…', hints: [] } },
    async listSessions() { return [{ id, title, cwd, updatedAt }] },
    async resolveSession(wanted) { /* selectSession(sessions, wanted, { cwd }) */ },
    async readState(session) {
      return { status: 'idle', turn: 1, lastAnswer: '…', lastUserMessage: '…' }
    },
    async whip(text, session, engineCtx) {
      return { ok: true, mode: 'inject', detail: '…' }   // 或 mode: 'foreground'
    },
  }
}
```

然后在 `src/adapters/index.mjs` 的 `ADAPTER_IDS` / `ADAPTER_CATALOG` / `createAdapter` /
`loadAdapters` 里各加一行。测试参考 `test/engine.test.mjs` 里的 `fake` 适配器用法——
它演示了"如何在没有真实 agent 的情况下验证整条闭环"。

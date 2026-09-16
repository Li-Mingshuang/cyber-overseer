# DSH（DeepSeek Harness）外部控制面逆向报告

> 目标：判定**外部 supervisor 进程**如何 (a) 观察一个正在运行的 DSH session，以及 (b) 向它注入新的 user message（"whip"），使 agent 在没有人类输入的情况下继续工作。
>
> 侦察对象：`C:\myFiles\codes\github\deepseek-harness`（只读）＋ 运行中的 Web GUI `http://127.0.0.1:3080`（只读探测）＋ 一份**独立的一次性 `$DSH_HOME`**（写在 `cyber-overseer\.recon-tmp\`，用于跑真实 CLI，避免碰用户的 DSH 状态）。

---

## 0. 证据分级与本次工作的边界

| 标记 | 含义 |
|---|---|
| `[已实测]` | 我真的执行了该命令 / HTTP 请求 / 进程，并**原样粘贴真实输出**。部分条目由我委派的侦察子进程执行（已注明），它们同样是真实执行而非推测。 |
| `[源码确认]` | 我读了源码并给出 `path:line`，但未运行该路径。 |
| `[推断]` | 由源码语义推导，未端到端验证。 |

**方法学上的关键发现（先说，因为它影响所有"跑 CLI"的结论）**：

我（作为一个 DSH agent session，file policy = `workspace-write`）**无法**直接运行 `dsh`：

```text
$ node C:\myFiles\codes\github\deepseek-harness\apps\cli\lib\bin.js --profile headless --help
Error: EPERM: operation not permitted, mkdir 'C:\Users\lms\.dsh\profiles\headless'
    at initProfile (file:///C:/myFiles/codes/github/deepseek-harness/packages/boot/app-boot/lib/index.js:354:2)
```
```text
$ node ...\apps\cli\lib\bin.js --profile web --help
Error: EPERM: operation not permitted, open 'C:\Users\lms\.dsh\profiles\web\cordis.yml'
    at prepareProfile (file:///C:/myFiles/codes/github/deepseek-harness/apps/cli/lib/profile-boot-DG5t9aN.js:143:2)
```
`[已实测]`

根因（`[源码确认]`）：**每次启动 profile 都会重写 profile 根配置**
`apps/cli/src/profile-boot.ts:98-103`：
```ts
export function prepareProfile(name: string, userLayer = true): Profile {
  healProfilesModuleFallback(INSTALL_ANCHOR)
  const profile = loadProfile(NAME, name, INSTALL_ANCHOR, undefined, { userLayer })
  writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG)   // ← 每次都写
  return profile
}
```
并且首次使用某个 profile 时会在 `$DSH_HOME/profiles/<name>` 建目录、写 `package.json` / `cordis.patch.yml` / `pnpm-workspace.yaml`
（`packages/boot/app-boot/lib/index.js:353-369`，模板表 `:323-332`），还会在 `$DSH_HOME/profiles/node_modules` 维护整份符号链接回退目录（`:409-438`）。

**这意味着两件事：**
1. 对本报告：我把 `DSH_HOME` 改到工作区内的临时家目录，从而**完整跑通了 CLI**（下面所有 `[已实测]` 的 CLI 输出都出自这种方式），全程没有写用户 `C:\Users\lms\.dsh` 的任何文件。
2. 对 supervisor：**外部 supervisor 必须对 `$DSH_HOME/profiles/<profile>/` 有写权限**，否则 boot 在 mount 任何插件之前就 EPERM 退出。一个运行在 DSH file sandbox（`read-only` / 受限 `workspace-write`）**内部**的 supervisor 会踩到这个坑；一个普通的宿主进程（人类 shell、Windows 服务、计划任务）不会。

复现方式（我用的，可复制）：
```powershell
$T='C:\myFiles\codes\deepseek\cyber-overseer\.recon-tmp'
$env:DSH_HOME="$T\dsh-home"
New-Item -ItemType Directory -Force -Path "$env:DSH_HOME" | Out-Null
node C:\myFiles\codes\github\deepseek-harness\apps\cli\lib\bin.js --profile headless --help
```
补充：真实凭证不在环境变量里；`$DSH_HOME/.credentials.yaml` 的 `refs.DEEPSEEK_API_KEY` 是唯一凭证来源
（`packages/bundle/base/cordis.patch.yml:85-86` 挂载 `dsh-credentials-local`）。

---

## 1. HEADLESS 通道

### 1.1 完整 flag 列表

**`dsh --help`（launcher 自己的 flag）** `[已实测]`
```text
Usage: dsh [options] [command] [args...]

Arguments:
  args                        arguments for the booted profile's app (see: dsh --profile <name> --help)

Options:
  -V, --version               output the version number
  --profile <name>            the profile under $DSH_HOME/profiles to boot
  --patch <path>              extra patch-list overlay applied after the profile layer (repeatable)
  --dump-config               print the composed profile tree and exit
  --dump-default-config       print the profile tree without its user layer or --patch overlays and exit

Commands:
  web [options] [args...]     boot the web profile (alias of --profile web); the web app's own flags follow
  plugin [options] [args...]  manage a profile's plugins by forwarding the remaining arguments to pnpm in the profile directory
```
`dsh` 只解析自己的 flag；**第一个无法识别的 token 之后的所有参数原样交给被启动的应用**（`apps/cli/src/args.ts:123-134`、`127-130`：`allowUnknownOption() + passThroughOptions()`），所以 `-h` 也归应用。

**`dsh --profile headless --help`** `[已实测]`
```text
Usage: dsh --profile headless [options] [task...]

Answer one task, print the final assistant message, and exit.

Arguments:
  task        the task text; multiple words are joined by spaces

Options:
  -h, --help  show this help

Examples:
  dsh --profile headless "run the tests"     answer one task and exit
```
**这就是 headless 的全部 flag。** 源码与之完全一致：`packages/bundle/headless/src/startup.ts:31-41` 只声明 `helpOption` + `task...` 位置参数；整个仓库只有**两个** `parseCmdline` 调用点（`packages/bundle/headless/src/startup.ts:56`、`packages/bundle/web-app/src/startup.ts:87`），`headless-startup` 是 headless 组合里唯一的 flag provider（`packages/bundle/headless/cordis.patch.yml:27-35`）。`[源码确认]`

**`dsh --profile web --help`** `[已实测]`
```text
Usage: dsh --profile web [options]

Options:
  --host <host>                  bind host
  --no-open                      do not open the Web UI in the default browser
  --port <port>                  listen port; pass 0 to let the OS pick a free one
  --trusted-host <authority...>  extra authority the /api browser-trust fence accepts (host or host:port; repeatable)
  -h, --help                     show this help
```
`--host 0.0.0.0` 被**主动拒绝**（`packages/bundle/web-app/src/startup.ts:74-79`，理由写着"会把 RCE 暴露到网络"）——注意这只拦 CLI 参数，**直接写 profile patch 可以绕过**（见 §5 安全提示）。

### 1.2 一次性（one-shot）非交互任务的精确跑法

```powershell
# 关键：cwd 就是 agent 的工作目录（headless runner 用 process.cwd() 作为 session 的 cwd）
cd <target-workspace>
$env:DSH_HOME='C:\Users\lms\.dsh'          # 可写！见 §0
$env:DSH_PERMISSION_MODE='workspace-write' # 见 §1.6：同时决定 sandbox 与 approval
node C:\myFiles\codes\github\deepseek-harness\apps\cli\lib\bin.js --profile headless "<task 文本>"
```

**真实端到端结果** `[已实测]`（我在 `DSH_HOME=$T\dsh-home` 下跑，凭证为该临时 home 内的副本，跑完即删）：
```powershell
$env:DSH_HOME=$tmp
$out = node ...\apps\cli\lib\bin.js --profile headless "Reply with exactly: WHIP-OK" 2>&1
```
```text
--- stdout+stderr ---
WHIP-OK
--- exit code: 0 ; elapsed ms: 13431 ---
```
即：**13.4 秒完成一次真实 LLM 回合，stdout 只有最终答复本身。**

### 1.3 最终答复如何输出 / 有哪些格式 flag

* **没有**任何 `--json` / `--format` / `--output` 类 flag（§1.1 的 flag 列表就是全集）。
* 输出契约（`[源码确认]`，`packages/bundle/headless/src/index.ts:60-134`）：
  * `summarize()`（`:61-82`）从本次 run 的 session events 中取**最后一个** `assistant/message` 的所有 `text` block 拼接（丢弃 image/reasoning block），**不是流式**；
  * `io.stdout.write(outcome.text + '\n')`（`:129`）——**stdout 只有这一行最终文本**；
  * 若 `turn/end` 的 reason 是 `error`，额外写 stderr：`dsh: <error.code>: <error.message>`（`:130-132`）；
  * `io.exit(outcome.reason?.kind === 'completed' ? 0 : 1)`（`:133`）。
* 内部过程事件**不**输出到 stdout；它是持久化的 session log（`$DSH_HOME/sessions/<cwd-slug>/<sessionId>/session.jsonl.zstd`，`packages/bundle/base/cordis.patch.yml:98-101` 配置 `root: !!js dshHomePath('sessions')`；`[已实测]` 我的一次性 run 生成了 `session-3cec2831-.../session.jsonl.zstd`，13312 字节）。

### 1.4 退出码语义 `[源码确认]` + 部分 `[已实测]`

| 退出码 | 含义 | 证据 |
|---|---|---|
| `0` | 该回合 `turn/end` 的 reason 为 `completed`；或 launcher 收到 SIGTERM（`profile-boot.ts:221`） | `packages/bundle/headless/src/index.ts:133` |
| `1` | 回合以任意非 `completed` reason 结束（`error` / `max-tokens` / `aborted` / `blocked` …）；或 direct-driver 抛错（`:85-88`）；或**任何启动失败**（插件树加载失败、EPERM、缺凭证） | 同上 + `[已实测]`：无 task 时输出 `error: a task is required, for example: dsh --profile headless "run the tests"`，退出码 **1** |
| `130` | SIGINT（`profile-boot.ts:222`，`shutdown.interrupt(130)`） | `profile-boot.ts:212-222` |

### 1.5 **前一个 session 能否被 headless 恢复？——不能，没有这个 flag**

* 全仓 `grep --resume|--continue|--session` 在 `packages/**/*.ts` 只有 **3 处**，且全部是文档/测试里的字符串样例：`packages/boot/cmdline/src/index.ts:24-25`（"`dsh --profile tui --resume abc` yields `['--resume','abc']`"）、`packages/boot/cmdline/tests/cmdline.spec.ts:184-187`。`[源码确认]`
* `apps/cli/README.md:24` 明确写：`dsh --profile tui --resume <id>     # example, assuming the tui profile is installed; --resume belongs to the terminal app`。**本机 `$DSH_HOME/profiles/` 只有 `web`**（`[已实测]`：`Get-ChildItem C:\Users\lms\.dsh\profiles` → `node_modules`, `web`），没有 tui 应用，因此 `--resume` 在**本机不存在任何实现**。
* headless runner **硬编码新建 session**：`packages/bundle/headless/src/index.ts:111-119`
  ```ts
  const { agent } = await agents.create({
    sessionId: SessionId(`session-${randomUUID()}`),      // ← 永远是新 id
    meta: { cwd: process.cwd() },
    agentOptions: { provider: selection.provider, model: selection.model },
  ```
  **不读任何 sessionId、不 resume、不注入历史。**

**存在但不可直接用的三条"按 id 续接"路径（供参考）**：

| 路径 | 语义 | 能否做 headless 续接 |
|---|---|---|
| `agent-loop` 行配置 `agents[].resumeSessionId`（`packages/core/agent-loop/src/index.ts:262-271`, `:355-381`） | boot 时按 id **恢复**持久化 session（`resumeWith` → `agents.resume({resumeSessionId})`） | `[源码确认]` 能恢复历史，**但没有任何插件会在 boot 后自动投递第一条 prompt**；headless runner 又只会操作它自己创建的 agent → 单独用它不会产生任何回合。可用 `--patch` 注入该配置（把 `agent-loop` 行写上 `agents: [{id: main, resumeSessionId: session-xxxx, provider: ..., model: ...}]`） | 
| HTTP API（§2） | 真·按 id resume 并注入（`implicit cold resume`） | `[源码确认]` 是唯一"按 id 复活 + 投喂"的完整路径，但只在 **web profile** 里有 HTTP 服务器 |
| SDK JSON-RPC `session/prompt`（§4.6） | 未知 id → `agents.create({sessionId})`：**新建**同名 session，不载入历史 | `[源码确认]` `packages/sdk/server/src/server.ts:218-235` |

**结论**：headless 模式**没有 session 续接能力**。跨 whip 的连续性必须由 supervisor 自己携带（把上一轮摘要/工作区状态写进 prompt 文本，或让 agent 读工作区产物）。这是 headless 通道最大的功能性缺口。

### 1.6 sandbox / approval / 非交互 / model / workspace 的控制方式

headless **没有任何 CLI flag** 控制这些，全部靠**环境变量 + 组合配置**：

| 需求 | 手段 | 证据 |
|---|---|---|
| **自动批准 / 无人值守** | `DSH_PERMISSION_MODE=danger-full-access` → `permission` preset 把 `sandbox: danger-full-access, approval: never`；`approval` 行的 policy 直接由该变量决定 | `packages/bundle/base/cordis.patch.yml:175`（`sandbox-policy.mode`）、`:191`（`approval.policy: (env ?? 'workspace-write') === 'danger-full-access' ? 'never' : 'ask'`）、`:193-205`（preset 表） `[源码确认]` |
| **默认（非交互）安全档** | 什么都不设 → `workspace-write` + `approval: ask`。headless 组合**没有** approval UI 插件，"ask" 在无人应答时会悬停/失败 | 同上 |
| **sandbox 工作区根** | `sandbox-policy.workspaceRoot: !!js process.cwd()`；session 的 cwd 也是 `process.cwd()` | `packages/bundle/base/cordis.patch.yml:176`；`packages/bundle/headless/src/index.ts:113` |
| **model / provider** | 无 flag。来自 `agent-default-model` 行（`provider: deepseek-official`, `model: deepseek-v4-flash`）或 `$DSH_HOME/settings.yaml` 的 `llm-deepseek:` / `llm-pi-ai:` 段（热重载） | `packages/bundle/base/cordis.patch.yml:63-67`, `:75-96` |
| **凭证** | 环境变量优先，其次 `$DSH_HOME/.credentials.yaml`，再退到 project/user `.env` | `packages/bundle/base/cordis.patch.yml:81-86` |
| **quiet / 事件流** | 无。想要事件流只能读 session log 或换通道（§2/§4.6） | — |
| **extra overlay** | `--patch <file.yml>`（launcher flag，可重复）——这是**在不改 profile 的情况下调整 headless 组合的唯一手段** | `apps/cli/src/args.ts:132` |

### 1.7 `$DSH_HOME/profiles/headless` 里有什么？（题目要求读它）

**本机该目录原本不存在**（`[已实测]`：`C:\Users\lms\.dsh\profiles` 下只有 `node_modules` 与 `web`）。它在首次 `--profile headless` 时按 shipped 模板自动生成：
`packages/boot/app-boot/lib/index.js:323-332`
```js
const PROFILE_TEMPLATES = {
  web:      ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],
  headless: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"],
};
```
生成物（我在临时 home 里实测到的）：`package.json`（`dsh.profile.bundles`）、`cordis.patch.yml`（空数组模板）、`pnpm-workspace.yaml`、以及每次 boot 被重写的 `cordis.yml`（空 entry list）。`[已实测]`

**真正 boot 的插件**由 bundle patch 层组合决定。我在临时 home 里 dump 了完整组合：`node bin.js --profile headless --dump-config`（退出码 0，21798 字节）→ **81 行** `[已实测]`：

```text
timer, hmr, llm, session, typert, typert-loader, typert-gateway, session-title, session-title-llm,
user-questions, agent, agent-default-model, jobs, llm-retry, settings, credentials, llm-pi-ai,
session-persistence-jsonl, attachment-local, session-query-sqlite, session-projection, session-telemetry-otel,
subprocess, sandbox, sandbox-policy, bash-sandbox, pwsh-sandbox, approval, permission, shell-env,
tool-bash, tool-pwsh, tool-jobs, fs-observation-policy, tool-fs, tool-fs-search, agent-instructions,
skill, skill-filesystem, skill-badge, tool-skill, commands, command-feedback,
goal, goal-round-driver, command-goal, plan-mode, token-meter, compaction-basic, command-compact,
subagent, subagent-spawn-in-process, subagent-fork-in-process, tool-subagent-control,
tool-subagent-list-agents, tool-subagent, tool-subagent-fork, tool-subagent-report,
workflow-worker-thread, tool-workflow, timeout-policy, spill-local, spill-policy,
session-checkpoint-policy, tool-result-pruner, tool-todo, tool-goal, tool-ralph, tool-str-replace-editor,
repeat-tool-reminder, web, web-search-deepseek, tool-web, tools, system-prompt, agent-loop, fs-sandbox,
llm-deepseek, code-runtime, headless-startup, headless-runner
```
注意两点：**（a）组合里没有 HTTP server / webserver / client-connection / MCP client / hooks / schedule**（那些在 web bundle 或 examples 里）；**（b）`goal`、`goal-round-driver`、`command-goal`、`tool-goal` 都在**——headless 组合自带 goal 自动续跑引擎（见 §4.5），只是 runner 在第一回合结束后就退出（`packages/bundle/headless/src/index.ts:126-133`），所以默认用不上。`[源码确认]`

---

## 2. WEB / HTTP API（运行中的 127.0.0.1:3080）

> 本节由我委派的 HTTP 侦察子进程执行只读探测（**没有**发过 `session.prompt` / `cancel` / `create`），我与它各自独立地用真实请求复核了关键点（§2.6 是我自己发的）。

### 2.1 启动与 bootstrap

* Web profile 的 HTTP server：`@deepseek-ai/dsh-host-webserver`，`node:http` `createServer`（`packages/host/webserver/src/index.ts:185-195`）+ `upgrade` 分发（`:196-229`）+ `listen`（`:231-239`）。
* 默认 `127.0.0.1:3080`：`packages/bundle/web-app/cordis.patch.yml:121-126`（`host: ctx.webStartup.host ?? '127.0.0.1'`, `port: ctx.webStartup.port ?? 3080`）。
* **`/api` 没有认证层。** `isTrustedApiRequest`（`packages/client/connection/src/api-request-trust.ts:96-123`）只是 DNS-rebinding / 跨站栅栏：`Host` 必须是 loopback 或命中 `trustedHosts`；`Origin` 必须与 `Host` 同 authority；`Sec-Fetch-Site: cross-site` 拒绝。源码自称 "this fence is not an auth layer"（`packages/client/connection/src/api-request-trust.ts:12-13`）。`[源码确认]` + `[已实测]`（见 §2.6）。
* 另有 13 个 **privileged method 额外钉死 loopback**（`packages/client/connection/src/index.ts:89-119`）：`settings.*`、`credentials.*`、`host.pickDirectory`、`host.openPath`、`agentPreset.*`、`llm.discoverModels`。**`session.*` / `subagent.*` / `goal.*` 不在其中。**
* `window.__DSH_BOOT__` 由 `@deepseek-ai/dsh-client-modules` 构造：`packages/client/modules/src/index.ts:241-273`（`:271` 那一行产出 `{kind:'global', name:'__DSH_BOOT__', value: graph}`），经 `WebServer.renderIndex` 注入（`packages/host/webserver/src/index.ts:286-300`）。`[源码确认]`
  真实抓到的形状 `[已实测]`（子进程探测）：
  ```js
  globalThis["__DSH_BOOT__"] = {"rev":"08cf8032c9ae","entries":[
    {"id":"@deepseek-ai/dsh-typert-registry","url":"/plugins/@deepseek-ai/dsh-typert-registry/client.js?rev=f41d56e0b747","rev":"f41d56e0b747","inject":[],"immediately":true},
    {"id":"@deepseek-ai/dsh-api-gateway","url":"/plugins/@deepseek-ai/dsh-api-gateway/client.js?rev=965b70361a00","rev":"965b70361a00","inject":["@deepseek-ai/dsh-typert-registry","@deepseek-ai/dsh-client-connection"],"immediately":true},
    ...]}
  ```

### 2.2 传输契约（所有端点共用）

**不是 REST。** 一律 `POST` + JSON envelope（`packages/host/apiproxy/src/api/rpc.ts:145-180`）：

```jsonc
// 请求
{ "type": "client-request", "rpcId": "<任意字符串>", "method": "<endpoint 名>", "payload": { ... } }
// 响应
{ "type": "server-response", "rpcId": "...", "result": { "ok": true, "value": ... } }
{ "type": "server-response", "rpcId": "...", "result": { "ok": false, "error": { "code": "...", "message": "...", "details": ... } } }
```
**HTTP status 只表达载体层**：业务错误也是 `200` + `ok:false`（`packages/host/apiproxy/src/fetch/handler.ts:5-7`）。`404` = 未知路径，`415` = 非 `application/json`，`400` = body 非 JSON。错误码封闭联合见 `packages/host/apiproxy/src/api/rpc.ts:32-99`（`session-not-found`、`agent-busy`、`command-error`、`model-unavailable`、`GOAL_STALE_REVISION` …）。

两条路由分流（`packages/client/connection/src/rpc-host.ts:71-88`）：
* **1 段** endpoint（`session.prompt`）→ apiproxy unary 表（`packages/host/apiproxy/src/fetch/handler.ts:90-143`）；
* **2 段** endpoint（`goals/create`）→ Typert remote gateway（`packages/api/gateway/src/index.ts:104-120`，payload 必须是 `{args:{...}}`）。

### 2.3 观测端点（对运行中的 session 零副作用）

| Method | Path | Request payload | Response | 源码 |
|---|---|---|---|---|
| POST | `/api/session.list` | `{}` | `{items: SessionSummary[]}`（含 `sessionId, running, blank, cwd, agentPreset, parentSessionId, origin, updatedAt, projections.values{}`） | `fetch/handler.ts:91`；`api/sessions.schema.ts:65-72` |
| POST | `/api/session.history` | `{sessionId, beforeSeq?, maxMessages?}` | `{events: [...], hasMore, projections}` | `fetch/handler.ts:94`；实现 `api-proxy.ts:2154-2182` |
| POST | `/api/session.search` | `{query}` | `{items:[{sessionId,snippet}],hasMore}` | `fetch/handler.ts:92` |
| GET/HEAD | `/api/session.export?sessionId=<id>&includeDescendants=<bool>` | — | ZIP 流 | `fetch/handler.ts:260-271` |
| WS | `/api/events.mux` | — | 全会话 live agent 事件 | `packages/client/connection/src/index.ts:181-194` |
| WS | `/api/events.host` | — | host 级事件（session 增删、running 状态、workspace 变化） | 同上 |

**`session.history` 是唯一"零副作用"的转录读取路径**：它走 `historySourceFor`（`packages/host/apiproxy/src/api-proxy.ts:1474-1479`，只查 attached 或 detached inspect），**从不调用 `agentFor`**，因此不会 resume、不会 attach、不产生 turn。对比 `session.models` / `session.selectModel` / `session.prompt` 都走 `agentFor`（`api-proxy.ts:2186, 2196, 2373`）。`[源码确认]`

真实观测输出 `[已实测]`（子进程对活服务器）：
```text
POST /api/session.list      → 200, 55 个 session, 其中 running=true 9 个
POST /api/session.history {"sessionId":"session-89016627-...","maxMessages":1}
   → 200, result.ok=true, events=139, hasMore=true, projections.asOfSeq=70183
     projection keys = sessionStats, title, goal, tokenUsage, contextPressure, contextBreakdown,
                       subagentTiming, subagent, permissions, sessionListMetadata, imageLimits, todos, plan
```
WebSocket 真实帧 `[已实测]`（子进程，`ws://127.0.0.1:3080/api/events.mux`，客户端发 **0** 帧，收到 6 帧）：
```json
{"type":"server-request","rpcId":"5fdfbd92-...","method":"session/subscribed",
 "payload":{"type":"session/subscribed","sessionId":"session-d3d27aea-...","lastSeq":172078}}
```
信封规则：`method === payload.type`，`rpcId` 每次新 mint（`packages/client/connection/src/websocket-downlink.ts:14-29`）。
**WS 是纯下行**：客户端发任何帧都会 `close(1008, 'downlink only')`（`websocket-downlink.ts:109-111`）——所以**不能**用 WS 注入。
HTTP `GET /api/events.mux` 返回 **426 upgrade required**（`packages/client/connection/src/index.ts:150-155`），`[已实测]`：`GET /api/events.mux → 426 upgrade required`、`GET /api/session.list → 404 not found`（证实"列会话必须 POST"）。

`MuxFrame` 变体（`packages/host/apiproxy/src/api/events.ts:69-108`）：`session/event`（真正的 agent 事件，带完整 `SessionEvent`）、`session/subscribed`、`approval/requested` / `approval/resolved`、`question/requested` / `question/resolved`、`session/queue`、`session/jobs`、`session/projection`、`stream/error`。

### 2.4 注入端点（把 user message 送进已有 session）——**真实存在**

```http
POST http://127.0.0.1:3080/api/session.prompt
Content-Type: application/json

{
  "type": "client-request",
  "rpcId": "whip-1",
  "method": "session.prompt",
  "payload": {
    "sessionId": "<目标 session id>",
    "mode": "queue",
    "content": [ { "type": "text", "text": "<whip 文本>" } ]
  }
}
```
* schema：`packages/host/apiproxy/src/api/sessions.schema.ts:283-294`（`mode: 'queue' | 'steer'`；content 只接受 `text` 与 `image`）。
* 实现：`packages/host/apiproxy/src/api-proxy.ts:2361-2417`，核心两行（`:2396-2399`）：
  ```ts
  const message: UserMessage = createUserMessage({ content: durable, source: { kind: 'user' } })
  if (mode === 'steer') agent.steer(message)
  else agent.followup(message)
  ```
  `[源码确认]`
* 语义（`packages/core/agent-loop/src/agent.ts:113-128`）：
  * `mode: 'queue'` → `followup` → inbox `next-turn` → **不打断**当前回合，排成一个独立的新回合（`packages/core/agent/src/runtime-types.ts:119-124`）；
  * `mode: 'steer'` → `steer` → inbox `next-step` → **进入正在运行的回合**，在最近 step 边界被消费（`runtime-types.ts:126-133`）——这是"改变当前行为"的操作，风险高。
* **不要求 session 空闲**：冷 session（未 attach 但持久化存在）会被 `agentFor` **隐式 resume**（`packages/api/remotes/src/agent-lookup.ts:136-197`，注释写 "implicit cold resume"；`[源码确认]`）。
* 拒绝条件：目标是 subagent session → `agent-busy`（`agent-lookup.ts:62-85`、`api-proxy.ts:2410-2412`）；route 未服务 → `model-unavailable`（`api-proxy.ts:1798-1806`）。
* 陷阱：content 若是**单个以 `/` 开头的 text block**，会被当作 slash command 执行而**不发给模型**（`packages/host/apiproxy/src/api/sessions.ts:319-326`）。

**我实测了什么（并明确没有做什么）**：
* `[已实测]` 我**只**发了**不存在的 sessionId** 的负向探针：
  ```text
  POST /api/session.prompt {"sessionId":"recon-nonexistent-0000","mode":"queue","content":[{"type":"text","text":"probe"}]}
  STATUS: 200
  {"type":"server-response","rpcId":"recon-prompt-probe-1","result":{"ok":false,"error":
    {"code":"session-not-found","message":"session \"recon-nonexistent-0000\" not found",
     "details":{"sessionId":"recon-nonexistent-0000"}}}}
  ```
  → 证明 **路由已注册、可从非浏览器进程穿过 fence 调用、且未知 id 会 fail-closed 不会偷偷建 session**。
* `[未测]` 我**没有**对活的 session 发过 `session.prompt` / `session.cancel` / `session.create` / `goal.*`。原因：`session.list` 显示 **9 个 session `running=true`**（其中包含人类正在使用的会话），`queue` 会真的插入新回合、`steer` 会真的改变进行中的回合。因此 §2.4 的"注入语义"是 `[源码确认]`，不是 `[已实测]`。
* `[已实测]` 子进程的其它只读证据：`POST /api/session.bogus → 404`；`POST /api/session.list`（body 里 method 写错）→ `200 + bad-request`；`Content-Type: text/plain → 415`；`POST /api/session.cancel {"sessionId":"nonexistent-recon-0000"} → 200 + session-not-found`；三道信任栅栏（伪造 `Host`、跨站 `Origin`、`Sec-Fetch-Site: cross-site`）全部 `403 forbidden`。

### 2.5 其它相关端点

| Path | 用途 | 源码 |
|---|---|---|
| `POST /api/session.cancel` | 中断当前回合（`agent.cancel({kind:'user'}, {keepInbox:true})`，**保留**排队消息） | `api-proxy.ts:2518-2533` |
| `POST /api/session.create` | 新建 session（`{workspaceId?, cwd?, sessionId?, agentPreset?}`） | `fetch/handler.ts:93` |
| `POST /api/session.updateQueue` | 对排队项 edit/remove/steer | `api-proxy.ts:2468-2516` |
| `POST /api/subagent.prompt` | 向 **continuable 子 agent** 的 FIFO inbox 投消息（可冷 resume） | `packages/host/apiproxy/src/api/subagents.ts:92-106` |
| `POST /api/subagent.interrupt` | 中断子 agent 当前回合（保留 inbox） | `api/subagents.ts:108-119` |
| `POST /api/goal.create` / `goal.edit` / `goal.pause` / `goal.resume` / `goal.complete` / `goal.clear` | goal 生命周期（会隐式冷 resume）；Typert 形态为 `POST /api/goals/{create,resume,...}` + `{args:{...}}` | `api/rpc-map.ts:60-65`；`api-proxy.ts:2914-2945`；`goal/goal/src/index.ts:276-388` |
| `POST /api/commands/execute`（Typert: `POST /api/commands/execute`） | **执行 slash 命令**（如 `/goal resume`），第二条注入型通道 | `packages/interaction/commands/src/index.ts:328-334`；子进程实测 endpoint CLAIMED |
| `POST /api/respond` | 回答悬停中的 `approval/requested` / `question/requested`（**解封卡住的回合**） | `api-proxy.ts:3594-3637` |

子进程实测 endpoint 认领（`POST` 一个 method 名故意不匹配的 envelope，只触发路由判定，不执行业务逻辑）`[已实测]`：
```text
CLAIMED  /api/goals/{create,edit,pause,resume,complete,clear}
CLAIMED  /api/commands/{list,execute}
CLAIMED  /api/dynamicCordisRunner/{invoke,inventory}
CLAIMED  /api/messageFeedback/list
CLAIMED  /api/pluginInventory/list
404      /api/jobs/list
404      /api/schedule/create
```

### 2.6 结论

* **"向运行中的 session 注入 user message" 是真的**：`POST /api/session.prompt` 路由存在、可从任意本机进程调用、`mode:'queue'` 不打断当前回合、冷 session 自动 resume。**我未在活会话上端到端触发**（因为会打扰人类正在用的会话），触发部分的证据是"路由已实测可打 + 代码路径 `agent.followup` 已实测（同一函数在 SDK 通道上被我跑通，见 §4.6）"。
* **注入 live session 是"低打扰"还是"高打扰"取决于 `mode`**：`queue` 低（新回合），`steer`/`cancel` 高（改/停当前回合）。
* **观测通道是安全的**：`session.list` + `session.history` + WS `mux` 组合零副作用。

---

## 3. ACP（Agent Client Protocol）

> 本节由我委派的 ACP 侦察子进程完成（只读源码 + 仓库内快照帧），结论与源码指针引自其报告。

### 3.1 DSH 同时是 ACP server 和 ACP client（不同包、互不相干）

* **ACP server**：`@deepseek-ai/dsh-acp`（`packages/acp/acp`）。`packages/acp/acp/src/index.ts:2` 自述 "Automation-only Agent Client Protocol **server** over JSON-RPC stdio"；`:443-448` 用 `ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))` + `AgentSideConnection`。`[源码确认]`
* **ACP client**：`@deepseek-ai/dsh-subagent-acp`（`packages/subagent/subagent-acp`）把**外部 ACP agent 子进程**当作 out-of-process subagent 驱动（`src/run.ts:266-272`，`initialize` → `session/new` → `session/prompt`，`stdio: {stdin:'pipe', stdout:'pipe', stderr:'inherit'}`）。`[源码确认]`
* **产品 CLI 默认组合两者都不挂**：`packages/bundle/base/cordis.patch.yml:292-333` 只有 `subagent-spawn-in-process` / `subagent-fork-in-process`；base/web-app/headless 三个 bundle 里没有任何 `acp` 字样。`[源码确认]`

### 3.2 启动入口（没有 `dsh` 子命令、没有 profile）

`apps/cli/src/args.ts` 只有 default / `web` / `plugin`，全文件无 `acp`。真入口是示例 app 的 bin：

```bash
# 源码树（tsx）
pnpm run demo:acp
# 等价于
node --import tsx packages/examples/acp-demo/src/bin.ts --config examples/acp-agent/cordis.yml

# 构建产物（本 checkout 里 lib/ 已存在）
node C:\myFiles\codes\github\deepseek-harness\packages\examples\acp-demo\lib\bin.js --config examples\acp-agent\cordis.yml
```
bin 名 `dsh-acp-demo`（`packages/examples/acp-demo/package.json:16-18`），只解析 `--config/-c`（默认 `./cordis.yml`）。传输 = **stdio + newline-delimited JSON-RPC**。需要 `DEEPSEEK_API_KEY`；`DSH_PERMISSION_MODE` 控制审批档位。`[源码确认]`

### 3.3 实现的方法集合（很小）

| 方向 | 方法 | 类型 | 源码 |
|---|---|---|---|
| client→DSH | `initialize` | request | `packages/acp/acp/src/index.ts:290-302` |
| client→DSH | `authenticate` | request（no-op，`authMethods: []`） | `:304-306` |
| client→DSH | `session/new` | request | `:308-333` |
| client→DSH | `session/prompt` | request | `:335-423` |
| client→DSH | `session/cancel` | **notification** | `:425-439` |
| DSH→client | `session/update` | notification（**只发 `agent_message_chunk`**） | `:233-236` |
| DSH→client | `session/request_permission` | request | `:274-281` |

**未实现**：`session/load`、`session/list`、`session/resume`、`session/delete`、`session/fork`、`fs/read_text_file`、`fs/write_text_file`、`terminal/*`、`elicitation/*` → 全部 `-32601`（SDK 对缺失 handler 抛 `RequestError.methodNotFound`）。`[源码确认]`
权限选项固定两项：`allow-once` / `reject-once`；未知 optionId → `rejected`（fail-closed）。`[源码确认]`

### 3.4 真实协议帧（来自仓库快照，非构造）

`examples/acp-agent/tests/snapshots/*/stdout.expected.jsonl` `[已实测]`（子进程读取并粘贴）：
```json
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentInfo":{"name":"deepseek-harness-acp","version":"0.0.1"},"agentCapabilities":{"promptCapabilities":{"image":false,"audio":false,"embeddedContext":false}},"authMethods":[]}}
{"jsonrpc":"2.0","id":2,"result":{"sessionId":"{{sessionId}}"}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"{{sessionId}}","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"PONG"}}}}
{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}
{"jsonrpc":"2.0","id":1,"method":"session/request_permission","params":{"sessionId":"{{sessionId}}","toolCall":{"toolCallId":"call_00_d0sAHpJ9mYOJi0z7KNy30441"},"options":[{"optionId":"allow-once","name":"Allow once","kind":"allow_once"},{"optionId":"reject-once","name":"Reject","kind":"reject_once"}]}}
{"jsonrpc":"2.0","id":3,"error":{"code":-32603,"message":"Internal error: turn failed: simulated provider error (HTTP 401)"}}
```
客户端方向（`[推断]` 构造，字段来源逐条标注在子进程报告里）：
```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}
{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"C:\\work\\proj","mcpServers":[]}}
{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"<sid>","prompt":[{"type":"text","text":"reply with PONG"}]}}
{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"<sid>"}}
```

### 3.5 外部 supervisor 能否纯走 ACP 驱动？

* **能**驱动**同一连接内**的会话：`session/new` 拿到服务端生成的 id 后，只要没有 in-flight prompt（每 session 同时只允许 1 个，第二个报 `invalid params: a prompt is already in flight`），就可以对**同一个 sessionId** 反复 `session/prompt` 注入新 user prompt（测试证据 `packages/acp/acp/tests/turns.spec.ts:447-470`）。`[源码确认]`
* **不能**跨连接按 id 恢复：没有 `session/load`/`resume`，未知 id → `unknown session: <id>`。README 自述 "Fresh sessions only"。`[源码确认]`
* **可观测性弱**：只有 committed assistant 文本/图片（`agent_message_chunk`），拿不到 token delta、reasoning、tool 调用、plan、usage；进度只能靠帧顺序与外部副作用。`[源码确认]`

---

## 4. 自动化友好面（MCP / schedule / hooks / jobs / goal）

> 本节主要由自动化面侦察子进程完成，§4.6 是我自己额外发现并**端到端跑通**的一条通道。

### 4.1 MCP —— 是"邮局"不是"鞭子"

* DSH **只是 MCP client**（`packages/mcp/mcp-client`）。产品代码里没有任何 MCP server 实现；`McpServer|StdioServerTransport|...` 只命中测试 fixture（`packages/mcp/mcp-client/tests/fixture-server.ts`）。`[源码确认]`
* 接入方式 = Cordis 插件行（不是 settings 键）。exact schema：`packages/mcp/mcp-client/src/index.ts:107-128`（`transport: 'stdio' | 'streamable-http'`；stdio 需 `command/args/env/cwd`；http 需 `url/headers`；公共 `serverName`（`/^[A-Za-z0-9_-]{1,32}$/`）、`toolCallTimeoutMs`（默认 60000）、`failOnStartupError`（默认 false）、`reconnect`）。**没有 SSE transport**（`src/transport.ts:31-49` 只有两个分支）。`[源码确认]`
* 落地写法（真实可运行样例）：`examples/mcp-memory/memorix.cordis.yml:3-11`
  ```yaml
  - insert:
      - id: memory-memorix
        name: '@deepseek-ai/dsh-mcp-client'
        config:
          serverName: memorix
          transport: stdio
          command: memorix
          args: [serve]
          cwd: !!js process.cwd()
  ```
  写进 `$DSH_HOME/profiles/web/cordis.patch.yml` 即可（该文件被 chokidar 热重载，见 §4.7）。
* 工具名 `mcp__<serverName>__<toolName>`（`src/tools.ts:112`）。**没有任何"收到 server 通知就唤醒 agent"的路径**——唯一监听的 notification 是 `tools/list_changed`（只做工具重同步）。因此 MCP 只能当**拉取式信箱**：必须有人在提示词层面要求模型"每回合先调 `mcp__x__check_mail`"，而且**还需要另一条通道把 agent 推起来**。`[源码确认]`
* 现状：**shipped bundles 都没挂 mcp-client**（全仓 `*.yml` 只有 `examples/mcp-memory/*`），当前 GUI 里没有 MCP 面。`[源码确认]`
* 可靠性：初始连接失败默认**不阻塞**激活；断线指数退避（500ms 起，上限 30s，最多 10 次后永久放弃）；工具调用默认 60s 超时；stdio 子进程 env 会被 `scrubbedParentEnv()` 洗掉凭证。`[源码确认]`

### 4.2 schedule —— 只有模型能建，外部无法入队

* 三个 session 作用域工具 `schedule_create` / `schedule_list` / `schedule_delete`（`packages/schedule/schedule/src/tools.ts:318,399`）。选择器必须是 `after_seconds` | `at` | `every_seconds`（**最小 5 分钟**），**不是 cron**。`[源码确认]`
* 唯一持久权威 = session event log 的 `schedule/change` 事件（`src/tools.ts:382-386`），落盘在 `$DSH_HOME/sessions/.../session.jsonl.zstd`。`[源码确认]`
* 投递机制与 goal 同源：`agent.followup(message)`，**不打断**（`src/runtime.ts:256,275`）；但**只在原 session 活着时准时**，冷 session 只在 resume 后处理 overdue。`[源码确认]`
* **外部无法入队**：子进程实测 `POST /api/schedule/create → 404`；没有 `@Remote` 暴露 schedule。`[已实测]`（endpoint 探针）
* 未挂载（只在 `examples/web-schedule/cordis.yml`）。`[源码确认]`

### 4.3 hooks —— 唯一"回合末自我再注入"机制，但配置只读一次、且未挂载

* 事件集（闭合）：Claude Code 方言 7 个（`SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SubagentStart, SubagentStop`，`packages/hooks/hooks-claude-code/src/config.ts:11-19`）、Codex 方言 5 个（`packages/hooks/hooks-codex/src/config.ts:11`）。
* **`Stop` hook 阻塞（exit 2）会在回合关闭边界强制再来一步**：`packages/hooks/hooks-claude-code/src/index.ts:267-277` 在 `agent/turn-stopping` 上 `agent.steer(createUserMessage({...}))`；扩展点的位置在 `packages/core/agent-loop/src/agent.ts:295-299`（turn 关闭前，若 `inbox.nextStep` 非空则不 break）。**这是一个"永动鞭子"原语**：一个每次 exit 2 的 `Stop` hook 就能让 agent 不断继续。`[源码确认]`
* 但硬限制：配置**只在插件 load 时读一次**（`hooks-claude-code/src/index.ts:104`，无 fs.watch、README 自述 "live reload are not implemented"）；hook 只能是 **shell command**（不支持 HTTP 类型）；`stop_hook_active` 被硬编码 `false`（**没有 loop guard**）。`[源码确认]`
* 外部触发：`grep 'watch|chokidar|WebSocket|createServer|listen\(|net\.|http\.' packages/hooks/**/*.ts` → **0 命中**。`[源码确认]`
* 未挂载（只有 `examples/acp-agent/cordis.yml:184-195`）。`[源码确认]`
* fail-open：配置坏 / 超时 / 非 2 退出码 / 被信号杀 → 都不阻塞回合（默认 timeout 600000 ms）。`[源码确认]`

### 4.4 jobs / subagent

* `packages/jobs`（`dsh-jobs-local`）：**进程内**，README 明说 "Jobs are process-local — records die with the harness process"（`packages/jobs/jobs-local/README.md:33`）；`job.list` 在 apiproxy 里是**保留位**（`packages/host/apiproxy/README.md:80`）。子进程实测 `POST /api/jobs/list → 404`。**外部无法 enqueue**。`[已实测]` + `[源码确认]`
* `packages/subagent`：**这个有真实的外部驱动路径**。`POST /api/subagent.prompt`（`packages/host/apiproxy/src/api/subagents.ts:92-106`，payload `{parentSessionId, childSessionId, mode:'continuable', content, clientTimeZone?}`）可直接把消息投进一个 **continuable 子 agent** 的 FIFO inbox，必要时冷 resume；它**先于父 agent**、不需要父 agent 参与（授权校验要求精确的 live direct parent）。`[源码确认]` 子进程实测活环境里确有 continuable 子 agent（`projections.values.subagent = {"mode":"continuable", ...}`）。注意：`session.prompt` **不能**用于子 agent（返回 `agent-busy`）。`[源码确认]`

### 4.5 goal + goal-round-driver —— **这就是"继续干活"的现成引擎，外部可触发**

实现：`packages/goal/goal-round-driver/src/index.ts`（`inject = ['agents','goals','sessions']`）。判定链（全部 `[源码确认]`）：

| 环节 | 判定 | 位置 |
|---|---|---|
| 触发 | `agent/status → idle` | `:259-277` |
| 触发 | `goal/changed` → `needsCheckpoint` + `requestDrive` | `:278-282` |
| 可驱动 | fiber ACTIVE && 未 stopping && agent 仍是 registry 里精确实例 && `status==='idle'` && `!competingQueued` | `:103-109` |
| 持久化检查点 | `await ctx.sessions.flush(agent.session)`，失败 → `disarm` | `:142-154` |
| 上膛判定 | `goal.phase === 'active' && goal.activation === 'armed'` | `:165` |
| **轮次上限** | `roundsStarted >= maxGoalRounds` → `ctx.goals.block(..., {code:'round-limit'})` | `:166-172` |
| 投递 | `renderGoalRoundPrompt(goal, round)` → `createUserMessage({source:{kind:'goal',...}})` → **`agent.followup(message)`** | `:175-192` |
| 计数 | 只有被 admitted 的 goal-source user message 才 `roundsStarted++` | `:307-316` |

* **disarm（停）条件**：`agent/error`、竞争者入 inbox（人优先）、`turn/end` reason `max-tokens`/`aborted`、以及 **`agent/session-start`（resume/fork）一律 disarmed**（activation 不持久化，`packages/goal/goal/src/index.ts:198-200`）。
* **上膛（外部可用的动词）**：`create` / `resume` → `armed`；`pause` / `complete` / `block` / `clear` → `disarmed`（`goal/src/index.ts:251-388`）。默认 `maxGoalRounds = 256`。
* **外部触发路径（三条）** `[源码确认]` + `[已实测]`（endpoint 探针）：
  1. Typert：`POST /api/goals/create`、`/api/goals/resume`（payload `{args:{...}}`）——实测 6 个 endpoint 全部 CLAIMED；
  2. apiproxy unary：`POST /api/goal.create` / `goal.resume`（`api/rpc-map.ts:60-65`；实现 `api-proxy.ts:2914-2945`，**隐式冷 resume**）；
  3. `POST /api/commands/execute` with `/goal resume`。
* **CAS**：`resume`/`pause` 需要当前 `{id, revision}`；revision 过旧 → `GOAL_STALE_REVISION`。可以从 `session.history` 的 `projections.values.goal` 读当前值。`[源码确认]`
* 可靠性缺口：**没有独立 evaluator**（完成/受阻由模型自己 `update_goal` 判定）；`maxGoalRounds` 只是轮数预算，不是 token/钱/时间预算；无隐式重试（provider 瞬时失败需要外部再 `resume`）。`[源码确认]`
* headless 组合里 **goal / goal-round-driver / command-goal / tool-goal 全部在**（§1.7 的 81 行 dump），但 runner 在第一回合后退出，除非用 `--patch` 关掉 `headless-runner` 并另配驱动者，否则用不上。`[推断]`

### 4.6 附加通道：SDK stdio JSON-RPC（`dsh-sdk-jsonrpc-server`）—— **我端到端跑通了**

这是 shipped 的、有文档的外部控制面：`packages/sdk/server`（插件名 `jsonrpc` / `sdk-jsonrpc-server`）通过 **stdio 上换行分帧的 JSON-RPC 2.0** 对外服务。

* 协议（`packages/sdk/protocol/src/types.ts:100-105`）：请求 `initialize` / `session/prompt` / `shutdown`；通知 `session.event` / `session.status` / `subagent.started` / `subagent.finished`。
* `session/prompt` **就是信箱**：`packages/sdk/server/src/server.ts:132-143`
  ```ts
  const rec = await this.getOrCreateSession(params.sessionId)
  const message = createUserMessage({ content: params.contentBlocks, source: { kind: 'user' } })
  rec.handle.agent.followup(message)
  return { messageId: message.id }
  ```
* `initialize` 是就绪边界：`packages/sdk/server/src/index.ts:82`（`await ctx.get('loader')?.await()`）。
* **没有 per-session close / prompt-cancel，没有 per-prompt result**（README "Known Limitations"）。

**我怎么把它跑起来的（可复制）** —— 产品 CLI 没有 profile 挂它，`examples/jsonrpc-agent/cordis.yml` 的 bin 在本 checkout 里又因为 `packages/examples/jsonrpc-demo/node_modules` 只有 3 个包而无法解析裸插件名（`ERR_MODULE_NOT_FOUND: @deepseek-ai/dsh-sdk-jsonrpc-server`，`[已实测]`）。可行做法是**自建一个 profile**（全部写在我自己的临时 home，未碰用户状态）：

```powershell
# 1) profile 清单 + patch
$T='C:\myFiles\codes\deepseek\cyber-overseer\.recon-tmp'
#    $T\dsh-home\profiles\jrpc\package.json      → bundles: ["@deepseek-ai/dsh-base"]
#    $T\dsh-home\profiles\jrpc\cordis.patch.yml  → - insert: [{id: sdk-jsonrpc-server,
#                                                     name: '@deepseek-ai/dsh-sdk-jsonrpc-server'}]
# 2) 让该包可从 profile 解析（一次性 junction，模拟安装）
New-Item -ItemType Junction -Path "$T\dsh-home\profiles\node_modules\@deepseek-ai\dsh-sdk-jsonrpc-server" `
         -Target 'C:\myFiles\codes\github\deepseek-harness\packages\sdk\server'
# 3) 启动（stdio 即协议通道）
$env:DSH_HOME="$T\dsh-home"; $env:DSH_PERMISSION_MODE='danger-full-access'; $env:DEEPSEEK_API_KEY='<credential>'
cmd /c "node ...\apps\cli\lib\bin.js --profile jrpc < in.jsonl > out.jsonl 2> err.txt"
```

**真实输出** `[已实测]`（stdin 两帧：`initialize` + `session/prompt{sessionId:'jrpc-recon-1'}`）：
```jsonl
{"jsonrpc":"2.0","method":"session.event","params":{"sessionId":"jrpc-recon-1","event":{"type":"permission/preset","seq":0,"data":{"preset":"danger-full-access"}}}}
{"jsonrpc":"2.0","method":"session.event","params":{"sessionId":"jrpc-recon-1","event":{"type":"sandbox/mode","seq":1,"data":{"mode":"danger-full-access"}}}}
{"jsonrpc":"2.0","method":"session.event","params":{"sessionId":"jrpc-recon-1","event":{"type":"approval/policy","seq":2,"data":{"policy":"never"}}}}
{"jsonrpc":"2.0","method":"session.event","params":{"sessionId":"jrpc-recon-1","event":{"type":"agent/inbox/spliced","seq":3,"data":{"target":"next-turn","start":0,"inserted":[{"content":[{"type":"text","text":"Reply with exactly: WHIP-VIA-JSONRPC"}],"source":{"kind":"user"},"role":"user","id":"8876a312-..."}]}}}}
{"jsonrpc":"2.0","method":"session.status","params":{"sessionId":"jrpc-recon-1","status":"running"}}
{"jsonrpc":"2.0","method":"session.event","params":{"sessionId":"jrpc-recon-1","event":{"type":"turn/start","seq":4,"data":{"turn":1}}}}
{"jsonrpc":"2.0","id":2,"result":{"messageId":"8876a312-f184-47dd-952f-e56452fa50f9"}}
{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"deepseek-harness-sdk-runtime","version":"0.0.1"}}}
{"jsonrpc":"2.0","method":"session.event","params":{"sessionId":"jrpc-recon-1","event":{"type":"turn/end","seq":15,"data":{"turn":1,"reason":{"kind":"error","error":{"message":"The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed deepseek-official.","code":"INVALID_REQUEST","status":400}}}}}}
```
这一条同时证明了：**（a）注入真实生效**（`agent/inbox/spliced`、`target: next-turn`、`source.kind: 'user'`）；**（b）观测真实可用**（逐条 `session.event` + `session.status` 流）；**（c）`DSH_PERMISSION_MODE=danger-full-access` 真的把 approval policy 变成 `never`**（事件里可见）。

**一个必须知道的使用陷阱（我亲自踩到）** `[已实测]`：`JsonRpcLineTransport.drainLines()` 对每行做 `void this.handleLine(line)`（`packages/sdk/protocol/src/transport.ts:180-189`），**不 await**——所以同一批到达的帧是**并发处理**的。我用文件重定向一次性灌入两帧，`session/prompt` 抢在 `initialize` 完成前执行，于是用了服务端默认 model `deepseek-official`，直接 400。**客户端必须串行：收到 `initialize` 响应后再发 `session/prompt`**（真实客户端用 `request()` 天然是这个语义）。上面的输出里 `id:2` 的响应排在 `id:1` 之前，就是这次竞态的直接证据。

### 4.7 其它"能力注入"面（给运行中的 agent 装东西）

* **`$DSH_HOME/profiles/web/cordis.patch.yml` 热重载**：被 chokidar 监视，改动会事务性重组整棵插件树（`apps/cli/src/profile-boot.ts:285-294` + `packages/boot/app-boot/src/index.ts:232-265`；web bundle 关了共享 `hmr` 行，launcher 仍会挂一个 watch-only 实例，`profile-boot.ts:279-284`）。坏 patch → 保留上一棵好树（fail-safe）。**这是唯一不需要重启就能给运行中 agent 装 MCP mailbox / schedule / hooks 的通道**，前提是有 `$DSH_HOME` 写权限。`[源码确认]`
* `$DSH_HOME/settings.yaml`（热重载，改 model/provider 路由）、`.credentials.yaml`（热重载）、skill roots（热重载，改模型可见 skill 目录）。`[源码确认]`
* **明确不存在**：unix socket / named pipe / UDP / cluster IPC / webhook / `daemon|attach` 子命令 / MCP server 入口 / 跨进程 attach。信号只有 SIGTERM(→0) / SIGINT(→130) 的终止语义。`[源码确认]`

---

## 5. 推荐：外部 supervisor 的 whip 通道排名

排序 = 可靠性 × 低侵入 × 低工作量。**"插进人类正在用的 session" 一律标为高侵入**。

### ① HTTP `POST /api/session.prompt`（mode: `queue`）—— 最佳"信箱"
```http
POST http://127.0.0.1:3080/api/session.prompt
Content-Type: application/json

{"type":"client-request","rpcId":"whip-1","method":"session.prompt",
 "payload":{"sessionId":"<id>","mode":"queue","content":[{"type":"text","text":"继续：<whip 文本>"}]}}
```
* 可靠性：**高**。路由实测可打（§2.4 负向探针 200 + `session-not-found`）；语义 `agent.followup`（同一函数已在 §4.6 被端到端证明能产生 `agent/inbox/spliced`）；不要求 idle（冷 session 自动 resume）。
* 侵入性：对**人类会话**高（会真的插入回合）→ **`queue` 不打断当前回合，是唯二安全的选择**。对 supervisor 自己创建的 session 无侵入。
* 工作量：**极低**（一个 HTTP 请求，零安装、零配置）。
* 失败模式：目标不存在 → `session-not-found`（fail-closed，不会偷偷建 session）；目标是 subagent → `agent-busy`（改用 `POST /api/subagent.prompt`）；provider 无 adapter → `model-unavailable`；`Content-Type` 不是 `application/json` → 415；content 以 `/` 开头会被当 slash command 执行；**`mode:'steer'` 会插进当前回合，别对活人会话用**。

### ② HTTP goal + `goal-round-driver`（让它自己持续干）—— 最佳"自动续跑"
```http
POST /api/goals/create   {"type":"client-request","rpcId":"g1","method":"goals/create",
                          "payload":{"args":{"sessionId":"<id>","objective":"<目标>","maxGoalRounds":40}}}
POST /api/goals/resume   {"type":"client-request","rpcId":"g2","method":"goals/resume",
                          "payload":{"args":{"sessionId":"<id>","ref":{"id":"<goalId>","revision":<n>}}}}
```
* 可靠性：**高**（进程内 driver 在每次 `agent/status → idle` 自动投递 `<goal_round>` 用户消息；不要自己写轮询-投递循环）。上限由 `maxGoalRounds` 控制；`resume` 需要 CAS `{id, revision}`（从 `session.history` 的 `projections.values.goal` 读）。
* 侵入性：中（它会让 agent 自主连续推进；对人类会话来说这是"接管"）。
* 工作量：低（2 个请求）。
* 失败模式：`resume` 时 revision 过期 → `GOAL_STALE_REVISION`；**session resume/fork 会 disarm**；`agent/error`、竞争输入（人插话优先）、`max-tokens`/`aborted` 都会 disarm → supervisor 必须自己重新 `resume`；`round-limit` block；没有独立 evaluator（模型自评完成）。

### ③ 自建 SDK JSON-RPC profile（`--profile jrpc`，stdio）—— 最佳"可控自律进程"
```powershell
$env:DSH_HOME='C:\Users\lms\.dsh'   # 需可写；profile 目录配置见 §4.6
node C:\myFiles\codes\github\deepseek-harness\apps\cli\lib\bin.js --profile jrpc
# 然后按行写 JSON-RPC：
#   {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"cwd":"<ws>","provider":"deepseek-official","model":"deepseek-flash"}}
#   {"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{"sessionId":"<任意 id>","contentBlocks":[{"type":"text","text":"<whip>"}]}}
```
* 可靠性：**高**（我端到端跑通：注入 + 事件流双通道；一个常驻进程可反复 `session/prompt`，天然是"永不退出的 supervisor 靶子"）。
* 侵入性：**零**（全新独立进程/会话，完全不碰人类会话）。
* 工作量：**中**（需要一次性建 profile 并让包可解析；我已给出 junction 方案）。
* 失败模式：**必须等 `initialize` 响应再发 prompt**（并发分帧竞态，实测踩坑）；`sessionId` 是**新建**而非恢复历史（无 resume）；无 cancel/close 方法（放弃只能杀进程）；stdout 被协议独占，组合里不能有 stdout logger；stdin EOF 不会被 `dsh` launcher 处理（进程会一直活着，靠 kill 收尾）。

### ④ headless 一次性（`--profile headless "<task>"`）—— 最简单、但**无 session 续接**
```powershell
cd <target-workspace>
$env:DSH_HOME='C:\Users\lms\.dsh'
$env:DSH_PERMISSION_MODE='workspace-write'   # 无人值守改 'danger-full-access'（approval=never）
node C:\myFiles\codes\github\deepseek-harness\apps\cli\lib\bin.js --profile headless "<whip 文本>"
```
* 可靠性：**高**（实测 13.4s、stdout 一行答复、exit 0）。契约极简单：stdout = 最终答复 + `\n`，stderr = `dsh: CODE: message`（仅错误时），exit 0 = `completed`，非 0 = 其它一切。
* 侵入性：**最低**（新 session，零打扰）。
* 工作量：**最低**（一条命令）。
* 失败模式：**没有 `--resume`/`--continue`/`--session`**，每次都是全新 session（`session-<uuid>`）→ 上下文不连续，必须把历史摘要塞进 prompt；**必须对 `$DSH_HOME/profiles/headless/` 有写权限**（每次 boot 重写 `cordis.yml`），否则 EPERM（我在 sandbox 内实测）；cwd = `process.cwd()`，supervisor 必须自己 `cd`；无人值守必须显式设 `DSH_PERMISSION_MODE=danger-full-access`，否则 approval 是 `ask` 而 headless 组合**没有审批 UI**；模型/工具集不可用 flag 控制（只能 `--patch` 或 `settings.yaml`）。

### ⑤ ACP（`dsh-acp-demo --config <cordis.yml>`）
* 可靠性：中。协议干净，但**表达能力最小**（只有 `agent_message_chunk` 可见，无 tool/reasoning/usage）。
* 侵入性：零（独立进程、全新 session）。
* 工作量：中（要装/构建 `dsh-acp-demo`；产品 CLI 无入口）。
* 失败模式：**不能 resume/load 任何已有 session**（无 `session/load` → `-32601`）；每 session 只允许 1 个 in-flight prompt；权限请求必须应答，否则工具 fail-closed；无 per-session close。**不适合"鞭打一个已存在的会话"**，只适合"起一个受控 worker"。

### ⑥ MCP mailbox
* 只能**拉取**：agent 必须被别的东西推着走才会去调 `mcp__x__check_mail`；DSH 不会因为 MCP server 有新数据而唤醒 agent。
* 需要改 profile（写 `cordis.patch.yml`，热重载生效）才能装载；当前 GUI 根本没挂 MCP。
* 定位：**作为 ①②③ 的补充工具面**（让 agent 能"取信箱"），**不要**当鞭子本体。

### ⑦ schedule / hooks `Stop` / jobs / agent-team mailbox
* 都**不是**外部可触发的鞭子：schedule 只有模型能建（外部 404）、hooks 配置进程启动时读一次且未挂载、jobs 是进程内、agent-team mailbox 是进程内且未挂载。
* 唯一有价值的原语是 **`Stop` hook exit 2 → `agent.steer(...)`**（回合末再注入一步），但它需要"改 profile + 重载"，且**没有 loop guard**（`stop_hook_active` 硬编码 false）——容易变成失控的无限循环。推荐只在明确需要"回合级反复自检"时，通过 `cordis.patch.yml` 热重载装入，并配合外部计数。

### 安全提示（与 whip 能力直接相关）
`[已实测]` 用户当前的 live profile 明确把 webserver 绑到全网卡：
`C:\Users\lms\.dsh\profiles\web\cordis.patch.yml:10-13`
```yaml
- id: webserver
  config:
    host: '0.0.0.0'
    port: !!js ctx.webStartup.port ?? 3080
```
而 `/api` **没有认证层**（只是 DNS-rebinding/跨站栅栏）。因此**同 LAN 上任何能连到 3080 的机器都可以无凭证调用 `session.prompt` / `goal.resume` / `commands/execute`**，驱动一个拥有 workspace 写权限与命令执行能力的 agent。CLI 的 `--host 0.0.0.0` 守卫被"直接写 patch 文件"绕过。若不需要 LAN 访问，把该 `host` 改回 `'127.0.0.1'`。

---

## 6. 最终答复（给委派方）

* **报告路径**：`C:\myFiles\codes\deepseek\cyber-overseer\docs\recon\dsh-control-surfaces.md`
* **推荐的 headless whip 命令（逐字）**：
  ```powershell
  cd <target-workspace>; $env:DSH_HOME='C:\Users\lms\.dsh'; $env:DSH_PERMISSION_MODE='workspace-write'; node C:\myFiles\codes\github\deepseek-harness\apps\cli\lib\bin.js --profile headless "<whip 文本>"
  ```
  （stdout 即最终答复，exit 0 = 回合完成；**无 `--resume`，每次全新 session**；`$DSH_HOME/profiles/headless/` 必须可写，否则 EPERM）
* **live-session HTTP 注入是真的**：`POST /api/session.prompt`（envelope `{"type":"client-request","rpcId":...,"method":"session.prompt","payload":{"sessionId","mode":"queue"|"steer","content":[{"type":"text","text"}]}}`）→ `agent.followup`（queue，不打断）／`agent.steer`（steer，插进当前回合）；冷 session 自动 resume。我实测打通过该路由（用不存在的 id 得到 `200 + session-not-found`），但因活环境有 9 个 `running=true` 的会话（含人类正在使用的），**没有对活会话真正注入**。
* **Blocker**：在我的 DSH file sandbox（`workspace-write`）内无法运行 `dsh`——`prepareProfile` 每次 boot 都重写 `$DSH_HOME/profiles/<name>/cordis.yml`，对 `C:\Users\lms\.dsh` 写入被拒绝（EPERM）。我改用工作区内的临时 `DSH_HOME` 完成全部真实执行；普通外部进程不受此限，但**必须对 `$DSH_HOME/profiles/<profile>/` 有写权限**。

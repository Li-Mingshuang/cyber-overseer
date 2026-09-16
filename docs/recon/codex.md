# Codex CLI 会话格式与非交互控制面 recon

对象: `codex-cli 0.146.0`(二进制版本串 `0.146.0-alpha.9.2`),CLI 入口 `C:\Users\lms\AppData\Roaming\npm\codex.ps1` → `node_modules/@openai/codex/bin/codex.js`。
CODEX_HOME = `C:\Users\lms\.codex`。本文所有结论标注 **VERIFIED**(实测/实读)或 **INFERRED**(由结构、help 文本或二进制字符串推断,未实测)。

> 环境限制说明:本次 recon 运行在只读沙箱内。因此所有 `codex exec` **没有真正执行**过(不消耗额度、不新增会话),`--json` 输出格式、退出码、新 rollout 落盘行为均标注 INFERRED;而 rollout 解析、sqlite schema、CLI/help 文本、config.toml、MCP 配置均为实测 **VERIFIED**。

---

## A. 会话记录读取

### A.1 磁盘布局 **VERIFIED**

| 路径 | 作用 | 实测大小 |
|---|---|---|
| `C:\Users\lms\.codex\sessions\<yyyy>\<MM>\<dd>\rollout-<ts>-<uuid>.jsonl` | 会话 transcript,每会话一个文件,只追加 | 1 个文件 21,827,454 B / 227 行 |
| `C:\Users\lms\.codex\state_5.sqlite` | **会话索引(最可靠的 cwd→会话 映射)** | 180,224 B |
| `C:\Users\lms\.codex\goals_1.sqlite` | 长期 goal(`thread_goals`) | 32,768 B,0 行 |
| `C:\Users\lms\.codex\memories_1.sqlite` | 记忆抽取(`stage1_outputs`/`jobs`) | 40,960 B,0 行 |
| `C:\Users\lms\.codex\logs_2.sqlite` | 结构化日志(WAL,~30 MB) | 30,244,864 B |
| `C:\Users\lms\.codex\session_index.jsonl` | 极简索引:`{"id","thread_name","updated_at"}` | 1 行 |
| `C:\Users\lms\.codex\sqlite\codex-dev.db` | Desktop/`local_thread_catalog` 目录同步,本机几乎为空 | 98,304 B |
| `C:\Users\lms\.codex\config.toml` | 用户配置(含 `mcp_servers`) | 3,004 B |

`session_index.jsonl` 实测内容(**VERIFIED**):

```json
{"id":"019fbe92-f8fb-7503-98a8-fbe3958791e3","thread_name":"你好","updated_at":"2026-08-01T18:26:02.2517903Z"}
```

**命名规则**:**VERIFIED**。`rollout-2026-08-02T02-25-30-019fbe92-f8fb-7503-98a8-fbe3958791e3.jsonl`
= `rollout-<本地日期>T<本地时:分:秒>-<session uuid>.jsonl`。该文件内 `session_meta.timestamp = 2026-08-01T18:25:30.880Z`,而 Asia/Shanghai 为 UTC+8 → `18:25:30Z = 次日 02:25:30`,说明文件名时间戳是**本地时间**,而 JSON 内部 `timestamp` 是 **UTC ISO-8601**。目录层级 `<yyyy>\<MM>\<dd>` 同样按本地日期。

### A.2 如何按 cwd 找最新会话 **VERIFIED(推荐路径)**

`state_5.sqlite` 的 `threads` 表是权威索引(有 `idx_threads_archived_cwd_recency_at_ms` 等索引):

```
threads(id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
        sandbox_policy, approval_mode, tokens_used, has_user_event, archived, archived_at,
        git_sha, git_branch, git_origin_url, cli_version, first_user_message, agent_nickname,
        agent_role, memory_mode, model, reasoning_effort, agent_path, created_at_ms, updated_at_ms,
        thread_source, preview, recency_at, recency_at_ms, history_mode, name, is_pinned)
```

实测唯一一行的关键字段(**VERIFIED**):

```
id            = 019fbe92-f8fb-7503-98a8-fbe3958791e3
rollout_path  = C:\Users\lms\.codex\sessions\2026\08\02\rollout-2026-08-02T02-25-30-019fbe92-f8fb-7503-98a8-fbe3958791e3.jsonl
cwd           = \\?\C:\Users\lms\Documents\Codex\2026-08-02\ni-h      <-- 带 Windows 扩展前缀 \\?\
source        = vscode      model = gpt-5.6-terra   reasoning_effort = medium
title         = 你好        preview = 你好            first_user_message = 你好
created_at_ms = 1785608730880   updated_at_ms = 1785682026076   tokens_used = 1068995
archived = 0    cli_version = 0.146.0-alpha.9.2
```

**关键坑**:`threads.cwd` 存的是 `\\?\C:\...`。查询必须归一化:
`select ... from threads where replace(cwd,'\\?\','') = ? order by updated_at_ms desc`(**VERIFIED**,已实测取到该行)。

### A.3 运行中 / 已结束 的判定 **VERIFIED**

* 该 rollout 只追加(`custom_tool_call_output` 单行可达 21 MB,line 162),**`mtime` 停留在“创建时刻”不再更新**(实测 `mtime = 2026-08-01T18:25:32.307Z`,而 `ctime = 2026-08-02T14:47:06.076Z` 即最后一次追加)。**所以判断“是否还在写”要用 `ctimeMs` 或最后一条记录的 `timestamp`,绝不能用 `mtime`。**
* 一次 task(turn)边界规则(**VERIFIED**,8 个 turn 全部符合):

```
event_msg/task_started   -> 开一个新 turn_id
... (optional user_message / reasoning / custom_tool_call / function_call ...)
event_msg/task_complete  -> 正常结束,payload.last_agent_message 就是最终答复
event_msg/turn_aborted   -> 异常结束,payload.reason(本机 3 次均为 "interrupted")
```
  每个 turn 恰好以 `task_started` 开始、以 `task_complete` **或** `turn_aborted` **或** 无结尾(仍开着)结束。实测 8 个 turn = 5 `task_complete` + 3 `turn_aborted`,最后一个 turn(line 227)`task_complete`,故当前**空闲、等待人类**。

判定表:

| 条件 | 结论 |
|---|---|
| 最后一个 `task_started` 之后没有任何 `task_complete`/`turn_aborted`,且 `ctimeMs` 在 120 s 内 | RUNNING |
| 同上但 `ctimeMs` 已超过 120 s | STALE-OPEN:进程被杀 / 崩溃 / 卡在批准 | 
| 最后一个 turn 以 `task_complete` 结束 | IDLE,等待人类 |
| 最后一个 turn 以 `turn_aborted` 结束 | IDLE(被中断) |

**INFERRED**:rollout 中**没有**任何 approval/permission 请求事件(本机 approval 走 Desktop/VS Code UI 而非 transcript),因此“等待权限批准”**无法只从 rollout 判定**;这种状态表现为“turn 开着且长时间不写盘”。`turn_context.payload.approval_policy` 实测为
`{"granular":{"sandbox_approval":false,"rules":false,"skill_approval":false,"request_permissions":true,"mcp_elicitations":true}}`(**VERIFIED**),即确实存在 `request_permissions` / `mcp_elicitations` 两处会等待人工的通道。

### A.4 完整事件 schema(实测枚举,来自 21 MB rollout 全量流式解析)**VERIFIED**

227 行 = 1 `session_meta` + 1 `world_state` + 8 `turn_context` + 217 条 `event_msg`/`response_item`。逐类型计数:

```
 38 event_msg/token_count            33 response_item/reasoning
 30 response_item/message            24 response_item/custom_tool_call
 24 response_item/custom_tool_call_output
 16 event_msg/agent_message           8 event_msg/task_started
  8 turn_context                      7 event_msg/user_message
  7 event_msg/thread_settings_applied 7 event_msg/agent_reasoning
  7 response_item/function_call       7 response_item/function_call_output
  5 event_msg/task_complete           3 event_msg/turn_aborted
  1 session_meta                      1 world_state
  1 event_msg/web_search_end
```

所有 19 种记录的**顶层**键固定为 `timestamp, type, payload`(**VERIFIED**,无一例外)。

#### 时间戳与 turn id 承载情况 **VERIFIED**

| 记录 | 有 `timestamp` | 有 `turn_id` |
|---|---|---|
| `session_meta` | ✅(UTC ISO) | ❌(有 `session_id`/`id`) |
| `world_state` | ✅ | ❌ |
| `turn_context` | ✅ | ✅ `payload.turn_id` |
| `event_msg/task_started` | ✅ | ✅ `payload.turn_id` |
| `event_msg/task_complete` | ✅ | ✅ `payload.turn_id` |
| `event_msg/turn_aborted` | ✅ | ✅ `payload.turn_id` |
| `event_msg/agent_message` | ✅ | ❌ |
| `event_msg/agent_reasoning` | ✅ | ❌ |
| `event_msg/user_message` | ✅ | ❌(**必须归给前一个 `task_started`**) |
| `event_msg/token_count` | ✅ | ❌ |
| `event_msg/thread_settings_applied` | ✅ | ❌ |
| `event_msg/web_search_end` | ✅ | ❌ |
| `response_item/*` | ✅ | ✅ 在 `payload.internal_chat_message_metadata_passthrough.turn_id` |

`payload.turn_id` 之外还有 epoch 秒:`task_started.started_at`、`task_complete.completed_at`、`turn_aborted.completed_at`(**VERIFIED**:如 `started_at:1785608732` ↔ `2026-08-01T18:25:32Z`)。

#### 每个 subtype 的真实样本(截断 200 字符)**VERIFIED**

```
event_msg/user_message
{"timestamp":"2026-08-01T18:25:47.309Z","type":"event_msg","payload":{"type":"user_message","client_id":"f51bb8f4-70bc-427d-9570-51da651433dc","message":"你好\n","images":[],"local_images":[],"audio":[],"local_audio":[],"text_elements":[]}}

event_msg/agent_message
{"timestamp":"2026-08-01T18:27:26.556Z","type":"event_msg","payload":{"type":"agent_message","message":"你好！有什么想一起处理的吗？","phase":"final_answer","memory_citation":null}}

event_msg/agent_reasoning
{"timestamp":"2026-08-02T14:20:52.664Z","type":"event_msg","payload":{"type":"agent_reasoning","text":"**Identifying exact four diploma PDFs**"}}

event_msg/task_started
{"timestamp":"2026-08-01T18:25:32.315Z","type":"event_msg","payload":{"type":"task_started","turn_id":"019fbe92-fcf6-75f0-9a8d-42ee3cfa43b3","started_at":1785608732,"model_context_window":258400,"collaboration_mode_kind":"default"}}

event_msg/task_complete
{"timestamp":"2026-08-01T18:27:26.779Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"019fbe92-fcf6-75f0-9a8d-42ee3cfa43b3","last_agent_message":"你好！有什么想一起处理的吗？","started_at":1785608732,"completed_at":1785608846,"duration_ms":114551,"time_to_first_token_ms":114141}}

event_msg/turn_aborted
{"timestamp":"2026-08-02T14:19:09.994Z","type":"event_msg","payload":{"type":"turn_aborted","turn_id":"019fbe99-ae5e-77e2-81e3-7c5dc446f669","reason":"interrupted","started_at":1785609170,"completed_at":1785680349,"duration_ms":71183040}}

event_msg/token_count
{"timestamp":"2026-08-01T18:27:26.713Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":16626,"cached_input_tokens":11008,"cache_write_input_tokens":0,"output_tokens":...}},"rate_limits":{...}}}

event_msg/thread_settings_applied
{"timestamp":"2026-08-01T18:32:50.738Z","type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{"model":"gpt-5.6-terra","model_provider_id":"openai","service_tier":"default",...}}}

event_msg/web_search_end
{"timestamp":"2026-08-02T14:43:55.451Z","type":"event_msg","payload":{"type":"web_search_end","call_id":"exec-3f8562af-e674-4c85-9dd4-3118083e3193","query":"LocalSend official troubleshooting cannot r...","action":{"type":"search","queries":[...]},"results":[{"type":...,"title":...,"url":...,"snippet":...}]}}

response_item/message
{"timestamp":"2026-08-01T18:25:47.213Z","type":"response_item","payload":{"type":"message","id":"msg_019fbe93-38ca-7513-9739-612c3db6d057","role":"developer","content":[{"type":"input_text","text":"<a..."}]}}

response_item/reasoning
{"timestamp":"2026-08-01T18:32:53.511Z","type":"response_item","payload":{"type":"reasoning","id":"rs_08f6a29c7fb09c9d016a6e3bd4ad688191bdc0bace83fd8347","summary":[],"encrypted_content":"gAAAAABqbjvV..."}}

response_item/custom_tool_call
{"timestamp":"2026-08-01T18:32:56.742Z","type":"response_item","payload":{"type":"custom_tool_call","id":"ctc_08f6a29c7fb09c9d016a6e3bd6658081918b2f4d51ece60a33","status":"completed","call_id":"call_LdUxNkQYdJAMSydyk6LW4nzz","name":"exec","input":"const r = await tools.shell_command({...});\ntext(r);",...}}

response_item/function_call
{"timestamp":"2026-08-02T14:21:29.539Z","type":"response_item","payload":{"type":"function_call","id":"fc_08f6a29c7fb09c9d016a6f526982b08191937fa3b3473d7ef5","name":"wait","arguments":"{\"cell_id\":\"14\",\"yield_time_ms\":10000,\"max_tokens\":2000}","call_id":"call_UK2D6ipZC5CKDoE90gtUEqh5",...}}
```

样本中截断的完整结构(**VERIFIED**,字段路径已逐条 dump):

* `response_item/custom_tool_call` → `payload.name`(实为 `exec`)、`payload.input`(**原始文本**的 JS 片段,内含 `tools.shell_command({...})` / `tools.web__run({...})`)、`payload.status`、`payload.call_id`、`payload.id`。
* `response_item/custom_tool_call_output` → `payload.call_id`、`payload.output[] = [{type:"input_text"|..., text:"..."}]`;**21,454,652 B 的那一行就是它**(line 162,一次 `exec` 返回的巨大输出)。**解析器必须能跳过/截断超长行。**
* `response_item/function_call` → `payload.name`(如 `wait`)、`payload.arguments`(**JSON 字符串**,需二次 `JSON.parse`)、`payload.call_id`。
* `response_item/function_call_output` → `payload.call_id`、`payload.output[]`。
* `response_item/message` → `payload.role`(`developer`/`user`/`assistant`)、`payload.content[] = [{type:"input_text"|"output_text", text}]`、`payload.phase`(见下)。
* `response_item/reasoning` → `payload.summary[]`(**通常是空数组**)+ `payload.encrypted_content`(加密 blob)。**结论:assistant 的思考文本不在这里**,必须读 `event_msg/agent_reasoning.text`。
* `session_meta` → `session_id`、`id`、`timestamp`、`cwd`、`originator`(`Codex Desktop`)、`cli_version`、`source`(`vscode`)、`thread_source`、`model_provider`、`base_instructions.text`(17,730 字符系统提示)、`dynamic_tools`(26,716 字符工具表)、`history_mode`(`legacy`)、`context_window.window_id`。
* `world_state`(8,697 B,仅 1 条,line 7)→ `payload.full:true` + `payload.state.{agents_md, apps_instructions, collaboration_mode, environments{local.cwd, local.shell:"powershell", current_date, timezone:"Asia/Shanghai", filesystem}, git_attribution, host_skills, multi_agent_mode, permissions, skills}`。适合一次拿到 cwd/时区/skills。
* `turn_context`(每个 turn 一条,6–7 KB)→ 见 A.5。

### A.5 精确字段路径(**VERIFIED**)

| 想要的东西 | 精确路径 |
|---|---|
| 用户消息 | `event_msg` → `payload.type=="user_message"` → `payload.message`(无 `turn_id`,归前一个 `task_started`) |
| assistant 每步自然语言 | `event_msg` → `payload.type=="agent_message"` → `payload.message`,配 `payload.phase`(`final_answer` 为最终答复) |
| **某 turn 的最终答复** | 首选 `event_msg/task_complete` → `payload.last_agent_message`;等价于该 turn 内最后一条 `payload.phase=="final_answer"` 的 `agent_message.message`;或该 turn 最后一条 `response_item/message`(`role=="assistant"`)的 `payload.content[].text` |
| 思考/推理文本 | `event_msg` → `payload.type=="agent_reasoning"` → `payload.text`(注意:`response_item/reasoning.text` 不存在,只有 `summary[]` 与 `encrypted_content`) |
| 工具调用 + 参数 | `response_item` → `payload.type=="custom_tool_call"` → `payload.name` / `payload.input`(文本);`payload.type=="function_call"` → `payload.name` / `payload.arguments`(JSON 字符串) |
| 工具结果 | `response_item` → `custom_tool_call_output` / `function_call_output` → `payload.output[].text`,用 `payload.call_id` 回连调用 |
| **turn 完成标记** | `event_msg` → `payload.type=="task_complete"`(**正常**)/ `"turn_aborted"`(**异常**,`payload.reason`) |
| turn 标识 | `payload.turn_id`(`task_started`/`task_complete`/`turn_aborted`/`turn_context`)或 `payload.internal_chat_message_metadata_passthrough.turn_id`(`response_item/*`) |
| 会话 id / cwd | `session_meta.payload.session_id` / `.cwd`;或 `state_5.sqlite.threads` |
| 沙箱与批准策略 | `turn_context.payload.{approval_policy, sandbox_policy, file_system_sandbox_policy, permission_profile}`;**实测值**:`sandbox_policy={"type":"workspace-write","writable_roots":[...],"network_access":false}`、`permission_profile={"type":"managed","file_system":{"type":"restricted",...}}` |
| 模型/推理强度/时区 | `turn_context.payload.{model, effort, summary, timezone, current_date, workspace_roots, collaboration_mode.mode}`(**实测**:`gpt-5.6-terra` / `medium` / `Asia/Shanghai`) |
| token 用量 | `event_msg/token_count.payload.info.{last_token_usage,total_token_usage,model_context_window}` |

### A.6 边写边读是否安全 / tail 策略 **VERIFIED**

* **安全**。rollout 是普通 JSONL 文件(codex 用的是 `O_APPEND` 式行追加,本机最后 1 字节 = `0x0a`)。没有跨进程锁。
* `fs.createReadStream` + `readline` 边写边读:唯一风险是**最后一行可能是半行**。处理方式:JSON.parse 失败的行直接跳过(计为 `partial`),下次轮询再读。不要因为解析失败就报错退出。
* 优化要点(**实测有效**):`Buffer.byteLength(line) > 1MB` 的行先按子串判断类型再决定是否 `JSON.parse`。21 MB 的单行会让朴素解析器吃满内存(实测 21 MB 文件里那一行占 98.3% 字节,却对“读对话”毫无价值)。
* tail 策略:**不要给 `createReadStream` 传 `start` 重读整个文件**。用 `prevOffset` 记住已消费字节数,每次只读新增部分:

```js
async function tailNew(file, prevOffset, onLine) {   // VERIFIED pattern
  const size = fs.statSync(file).size;
  if (size <= prevOffset) return prevOffset;                       // 未增长
  const rs = fs.createReadStream(file, { encoding: 'utf8', start: prevOffset });
  let buf = '';                                                    // 半行缓冲,跨轮保留
  for await (const chunk of rs) { buf += chunk; }
  const nl = buf.lastIndexOf('\n');
  if (nl < 0) return prevOffset;                                   // 整块都是半行:一个字节都不消费
  for (const line of buf.slice(0, nl).split('\n')) if (line.trim()) onLine(line);
  return prevOffset + Buffer.byteLength(buf.slice(0, nl + 1), 'utf8');   // 只推进到最后一个换行
}
```

* 主动发现新会话:轮询 `C:\Users\lms\.codex\sessions\<yyyy>\<MM>\<dd>\` 目录(或 `state_5.sqlite.threads` 的 `updated_at_ms`)。

### A.7 可直接复制的零依赖 Node 配方(**VERIFIED,147 行,已在本机跑通**)

保存为 `codex-recipes.mjs`,命令行:

```powershell
node codex-recipes.mjs --cwd "C:\Users\lms\Documents\Codex\2026-08-02\ni-h" --tail 2
node codex-recipes.mjs --id 019fbe92 --tail 1
node codex-recipes.mjs --all
```

实测输出(节选):

```
session   : 019fbe92-f8fb-7503-98a8-fbe3958791e3
cwd       : C:\Users\lms\Documents\Codex\2026-08-02\ni-h
rollout   : C:\Users\lms\.codex\sessions\2026\08\02\rollout-2026-08-02T02-25-30-019fbe92-f8fb-7503-98a8-fbe3958791e3.jsonl
size      : 21827454 bytes   lastAppendAge: 3888741757ms
verdict   : IDLE (last turn completed; waiting for human)
turns     : 8  lastTurn: 019fc2f0-75ca-7190-90ac-3359dde08e62 task_complete
skipped   : 1 giant lines, 0 unparseable lines (partial tail)

--- TURN 019fc2f0-75ca-7190-90ac-3359dde08e62 task_complete 2026-08-02T14:46:06.684Z → 2026-08-02T14:47:06.075Z
  user  : 电脑能发现手机，但是手机无法发现电脑
  tools : 2 exec(const r = await tools.shell_command({"command":"$interfaces = Get-CimInstance Wi…) ...
  final : 定位到了：电脑的局域网地址是 `192.168.0.102`。这是典型的“电脑能收到手机广播，但手机收不到电脑广播”的网络发现问题。...
```

完整源码见 `../cyber-overseer/.recon-tmp/codex-recipes.mjs`(147 行)。核心片段:

```js
/// 1) 打开只读 sqlite:DatabaseSync 是惰性的,必须用 pragma 逼出失败再回退到“拷贝副本”
function openReadOnly(dbPath) {
  try { const db = new DatabaseSync(dbPath, { readOnly: true }); db.prepare('pragma schema_version').get(); return { db }; }
  catch {                                   // WAL 库在只读目录下无法就地打开(需要写 -shm)
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-read-'));
    const copy = path.join(scratch, 'state.sqlite');
    for (const suf of ['', '-wal', '-shm']) if (fs.existsSync(dbPath + suf)) fs.copyFileSync(dbPath + suf, copy + suf);
    const db = new DatabaseSync(copy, { readOnly: true }); db.prepare('pragma schema_version').get();
    return { db, scratch };
  }
}
// 2) 按 cwd 取最新会话(cwd 带 \\?\ 前缀,必须 replace)
const rows = db.prepare(`select id, rollout_path, cwd, title, updated_at_ms, model, tokens_used, archived
                         from threads where replace(cwd,'\\\\?\\','') = ? order by updated_at_ms desc`).all(cwd);
// 3) 增量 tail(见 A.6 的 tailNew)+ 4) turn 状态机(见 A.5 字段路径)
```

**实测踩过的两个坑(已在配方里修好)**:

1. `new DatabaseSync(path, {readOnly:true})` **不会在构造函数抛错**,错误在第一条语句才出现 → 必须用 `db.prepare('pragma schema_version').get()` 探测。
2. `state_5.sqlite` 处于 WAL 模式,而 `C:\Users\lms\.codex\` 在只读沙箱下不可写 → 就地 `readOnly` 打开报 `SQLITE_CANTOPEN (unable to open database file)`。解决:**复制 `state_5.sqlite` + `-wal` + `-shm` 到可写临时目录再以 readOnly 打开副本**(WAL 内容会被正常回放,不丢已提交数据)。若用 `?immutable=1` URI 也能打开,但会**跳过 WAL**,可能读到旧快照,不推荐。

---

## B. 打鞭子:非交互注入下一条指令

### B.1 续会话 + 发一条 prompt **VERIFIED(来自 `--help` 原文)**

```powershell
# 按 session id 续,并注入一条 prompt(会话内追加,不新建 session)
codex exec resume 019fbe92-f8fb-7503-98a8-fbe3958791e3 "继续:把刚才的结论写成 docs/report.md"

# 续“最近一个”会话
codex exec resume --last "继续上一步"

# 从 stdin 读 prompt(参数位写 '-' 即从 stdin 读;若同时给了 prompt 且 stdin 是管道,stdin 会作为 <stdin> 块追加)
"继续,只输出结论" | codex exec resume 019fbe92-f8fb-7503-98a8-fbe3958791e3 -

# 开一个全新会话(不 resume)
codex exec -C "C:\path\to\ws" "开始做 X"
```

`codex exec resume` 的位置参数 help 原文:**VERIFIED**

```
Usage: codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]
  [SESSION_ID]  Conversation/session id (UUID) or thread name.
                UUIDs take precedence if it parses.
                If omitted, use --last to pick the most recent recorded session
  [PROMPT]      Prompt to send after resuming the session. If `-` is used, read from stdin
  --last        Resume the most recent recorded session (newest) without specifying an id
  --all         Show all sessions (disables cwd filtering)
```

**注意**:**`SESSION_ID` 也接受 “thread name”**(即 `session_index.jsonl` 的 `thread_name` / `threads.title`),但 UUID 优先解析(**VERIFIED**)。`--last` 在没有 id 时按最近会话选,而 `resume` 默认**有 cwd 过滤**(`--all` 关掉它)—— 所以 `--last` 的语义受当前工作目录影响,**建议 supervisor 显式传 UUID**。

### B.2 无人值守时的沙箱/批准开关 **VERIFIED(help 原文)**

* `-s, --sandbox <SANDBOX_MODE>`,可能值:`read-only` | `workspace-write` | `danger-full-access`。
* `--dangerously-bypass-approvals-and-sandbox`:跳过全部确认且完全无沙箱(EXTREMELY DANGEROUS)。
* `--dangerously-bypass-hook-trust`:不要求持久化 hook 信任。
* `--skip-git-repo-check`:允许在非 Git 仓库里跑。
* `-C, --cd <DIR>` / `--add-dir <DIR>`:工作根与额外可写目录。
* `--ephemeral`:**不把会话写到磁盘**(supervisor 若靠 rollout 判完成则**不能用**它)。
* `--ignore-user-config` / `--ignore-rules` / `--strict-config` / `--enable <FEATURE>` / `--disable <FEATURE>` / `-p, --profile <NAME>` / `-m, --model` / `-o, --output-last-message <FILE>` / `--output-schema <FILE>`。
* `-c, --config <key=value>`:点号路径覆盖 `config.toml`,值按 TOML 解析,失败则当字面字符串。help 官方示例:`-c model="o3"`、`-c 'sandbox_permissions=["disk-full-read-access"]'`、`-c shell_environment_policy.inherit=all`。

**推荐的无人值守组合(INFERRED,选项本身 VERIFIED)**:

```powershell
codex exec resume --last `
  -C "C:\path\to\ws" `
  -s workspace-write `
  -c approval_policy=never `
  -c sandbox_workspace_write.network_access=false `
  -c 'sandbox_workspace_write.writable_roots=["C:\path\to\ws"]' `
  -c shell_environment_policy.inherit=core `
  -c features.js_repl=false `
  "下一条指令"
```

* `approval_policy` 的取值在 rollout 里表现为 `turn_context.payload.approval_policy`(granular 结构);`never` 是 Rust 端的常见枚举值 —— **INFERRED**,未在本机 CLI 上实测接受。
* `-s read-only` 适合“只让它分析、不许改文件”的催办轮。**若你要用 rollout 判完成,必须保证 `-s` 允许写入 `~/.codex/sessions`** —— 但该目录是 codex 自己写的,与 `-s`(只约束模型生成的 shell 命令)无关,**INFERRED**。

### B.3 输出格式 **VERIFIED(help 原文)+ 部分 INFERRED**

`codex exec --help` 里**只有一个**流式格式开关:

```
      --json     Print events to stdout as JSONL
  -o, --output-last-message <FILE>   Specifies file where the last message from the agent should be written
      --output-schema <FILE>         Path to a JSON Schema file describing the model's final response shape
      --color <COLOR>                [default: auto] [possible values: always, never, auto]
```

* **存在 `--json`**(JSONL 事件流);**没有** `--experimental-json`(help 中不存在,`resume --help` 亦同)。
* **`--json` 的确切事件 schema 未实测** —— 但极可能就与 rollout 的 `{timestamp,type,payload}` 事件同族(rollout 本身就是事件日志),**INFERRED,需一次实跑确认**。
* **不加 `--json` 时 stdout 上是给人看的渲染文本**(进度 + 最终答复);要**机器可读的最终答复**,用 `-o <FILE>` 写最后一条消息,这是最稳的做法(**VERIFIED** 该 flag 存在;**INFERRED** 其内容格式为纯文本)。
* **退出码**:未实测。**INFERRED**:0 = 成功;非 0 = 失败/参数错误(TUI 类 CLI 常见 1/2)。**建议 supervisor 不要只依赖退出码,一律以 rollout 的 `task_complete` 作为“本轮完成”的权威信号。**
* 另有 `--output-schema <FILE>`:给最终答复套 JSON Schema,让模型按 schema 回答 —— 对 supervisor 解析结构化“下一步指令”很有用(**VERIFIED** flag 存在)。

### B.4 新会话如何落盘(供 supervisor 找新 rollout)

* **INFERRED(结构强证据)**:**每次 `codex exec`(不带 resume)新建一个 rollout 文件**,命名 `rollout-<本地时间戳>-<新 session uuid>.jsonl`,路径 `sessions\<yyyy>\<MM>\<dd>\`;`state_5.sqlite.threads` 插入一行,`rollout_path` 列存绝对路径(**VERIFIED** 该列存在且实测指向正确文件)。
* **`codex exec resume <id>` 是往**同一个** rollout 文件尾部追加**(证据:`threads.rollout_path` 每个 thread 只有一条、rollout 是纯追加日志、`ctime` 在会话期间持续被更新而 `mtime` 停在创建时刻 —— **VERIFIED**)。
* **supervisor 查找新 rollout 的稳妥顺序**:**① `select rollout_path from threads order by created_at_ms desc limit 1`** → ② 目录扫描兜底 → ③ 读文件首行 `session_meta.cwd` 校验目录。本仓库配方已实现全部三级(**VERIFIED** 跑通)。

---

## C. MCP

### C.1 Codex 支持用户配置 MCP **VERIFIED**

配置文件:`C:\Users\lms\.codex\config.toml`,顶层表 `[mcp_servers.<name>]`。**本机这个文件里已经有一个真实配置**(实测原文,节选):

```toml
[mcp_servers.node_repl]
args = []
command = 'C:\Users\lms\AppData\Local\OpenAI\Codex\runtimes\cua_node\fb8898c05a62885e\bin\node_repl.exe'
startup_timeout_sec = 120

[mcp_servers.node_repl.env]
NODE_REPL_NODE_PATH = '...\bin\node.exe'
CODEX_HOME = 'C:\Users\lms\.codex'
```

`codex mcp list` 实测(**VERIFIED**):

```
Name       Command                                                       Args  Env(…)  Cwd  Status   Auth
node_repl  ...\bin\node_repl.exe                                      -     ...     -    enabled  Unsupported
```

`codex mcp` 子命令(**VERIFIED**):`list` / `get` / `add` / `remove` / `login` / `logout`。
`codex mcp add --help`(**VERIFIED**):

```
Usage: codex mcp add [OPTIONS] <NAME> (--url <URL> | -- <COMMAND>...)
  --env <KEY=VALUE>                  Environment variables (stdio servers only)
  --url <URL>                        URL for a streamable HTTP MCP server
  --bearer-token-env-var <ENV_VAR>   Bearer token env var (HTTP servers only)
  --oauth-client-id / --oauth-resource
```

即:**stdio 与 streamable HTTP 两种 MCP server 都支持**,带 bearer token 与 OAuth。

### C.2 是否能让 MCP tool call 成为“下一条指令”的通道 **VERIFIED(能力存在)**

* **`codex mcp-server`** —— “Start Codex as an MCP server (stdio)”(**VERIFIED**)。也就是**别人**可以通过 MCP 驱动 codex。
* **`codex exec-server` [EXPERIMENTAL]** —— “Run the standalone exec-server service”,`--listen <URL>` 支持 **`ws://IP:PORT`(默认)、`stdio`、`stdio://`**,还有 `--remote <URL>` / `--environment-id` / `--name`(**VERIFIED**)。这是把 codex 变成**可远程驱动的执行环境**的正式入口。
* **结论**:是的。supervisor 可以既是 MCP client 又驱动 codex:由 MCP server 暴露一个 `next_instruction` 之类工具,codex 侧真正调用它时,该调用会**同时**出现在 rollout 的 `response_item/custom_tool_call`(`payload.name` + `payload.input`)里 —— 于是**“下一条指令”既经 MCP 送达,又在 transcript 里留下可观测的凭据**(**INFERRED**:MCP 工具调用必然在 rollout 中留下 `custom_tool_call`,因为本机所有工具调用都是这个形状,含 `exec`/`web__run`)。

---

## 单一最佳“打鞭子”命令(codex)

```powershell
codex exec resume <SESSION_UUID> -C "<workspace>" -s workspace-write -c approval_policy=never --json -o "<workspace>\.supervisor\last-msg.txt" "继续:<下一条指令>;完成后用一句话总结你做了什么"
```

理由:显式 UUID 避免 `--last` 的 cwd 过滤歧义;`-s workspace-write` + `-c approval_policy=never` 让它不卡在批准上;`--json` 给 supervisor 一条事件流(与 rollout 同族结构);`-o` 把最终答复落成文件(不依赖 stdout 渲染);完成后 rollout 必出现 `task_complete`,即为权威完成信号。

**与本仓库 `src/engine/whip.mjs` 的接法**:`composeWhip(...)` 产出的那段文本就是上一条命令里的 `"继续:<下一条指令>;…"` 位置参数(用 stdin `-` 也可以,避免命令行长度/引号转义问题):

```powershell
'继续:<whip 文本>' | codex exec resume <SESSION_UUID> -C "<workspace>" -s workspace-write -c approval_policy=never --json
```

`composeWhip` 的 `whip.maxChars` 默认 1800 字符(为“剪贴板粘贴”通道设计的)—— 走 `codex exec` 命令行时该上限并非硬限制,可以放宽;但注意 Windows 命令行长度与 `"` 转义,文本较长时用 stdin。

---

## D. Supervisor 完成检测与幂等(两个 agent 通用)

1. **完成检测**:轮询 rollout 尾部新增行,出现 `event_msg/task_complete`(或 `turn_aborted`)即“本轮结束”。记录 `payload.turn_id` 与 `payload.last_agent_message`。**VERIFIED**:每个 turn 恰好一条 `task_complete` 或 `turn_aborted`,数量 = turn 数。
2. **幂等/防重复注入**:注入前记下 `state.lastTurnId`(上次见到的 `task_complete.turn_id`);注入后**不要**立刻再注入,必须等到出现一个**新的** `task_started.turn_id` **且**该 turn 以 `task_complete`/`turn_aborted` 结束,才允许下一次注入。这样即使 supervisor 重启,也不会对同一 turn 注入两次。
3. **额外保险**:用 `-o <FILE>` 的 mtime/内容作为“答复已出”的旁证;用 `<workspace>\.supervisor\state.json` 持久化 `lastTurnId` + `lastInjectedAt`。
4. **不要**用文件 `mtime` 判活跃(mtime 停在创建时刻);用 `ctimeMs` 或最后一条记录 `timestamp`。
5. **不要**用 `--ephemeral`,否则没有 rollout 可供判完成。

## E. 未验证 / 阻塞项

* `codex exec` / `codex exec resume` **未真实执行**(只读沙箱 + 避免消耗真实额度与污染用户 CODEX_HOME)。因此 `--json` 确切事件 schema、stdout 渲染文本、退出码、`resume` 的确切落盘行为均为 INFERRED。
* 若要落实 B.3 / B.4,一条最小验证命令(在 `--ephemeral --ignore-user-config` 下成本极低):

```powershell
cd C:\myFiles\codes\deepseek\cyber-overseer\.recon-tmp\scratch
codex exec --ephemeral --ignore-user-config -s read-only --json "reply with the single word OK"
```

* rollout 内**不存在** approval/permission 事件流,因此“等待权限批准”只能靠“turn 开着且长时间不写盘”间接推断。

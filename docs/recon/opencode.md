# opencode 会话格式与非交互控制面 recon

对象:`opencode 1.18.11`,CLI 入口 `C:\Users\lms\AppData\Roaming\npm\opencode.ps1` → `node_modules/opencode-ai/bin/opencode.exe`(单文件 Bun 打包,174,182,280 B)。
数据目录 `C:\Users\lms\.local\share\opencode`(**VERIFIED**,经 `opencode debug paths`)。标注 **VERIFIED** = 实测/实读;**INFERRED** = 由二进制内嵌代码或 schema 推断,未实跑。

> **重要环境阻塞**:本机只读沙箱禁止写 `C:\Users\lms\.local\share\opencode\log\opencode.log`。opencode 的**每一个**需要启动 runtime 的命令都会尝试打开该日志文件,因此在本次 recon 中**失败并 exit 1**:
> ```
> Unknown: FileSystem.open (C:\Users\lms\.local\share\opencode\log\opencode.log)
> ```
> 实测受影响的命令:`opencode serve`、`opencode db`、`opencode db path`、以及(同类)`opencode run`。
> 不受影响、实测成功的:`opencode --help`、`opencode <cmd> --help`、`opencode debug paths`、`opencode mcp list` 等纯 help/只读子命令。
> 因此 **`opencode run` 与 `opencode serve` 均未真实执行**;其行为结论来自 **二进制内嵌 SDK/OpenAPI/schema 与真实 sqlite 数据**,已逐条标注。

---

## A. 会话记录读取

### A.1 磁盘布局 **VERIFIED**

| 路径 | 作用 | 实测 |
|---|---|---|
| `C:\Users\lms\.local\share\opencode\opencode.db` | **主库(sqlite,WAL)**,会话/消息/部件/事件全在这 | 138,174,464 B;`-wal` 4,161,232 B;`-shm` 32,768 B |
| `…\storage\session_diff\ses_*.json` | 每个会话一个 diff JSON | 14 个,最大 12,016 B |
| `…\storage\migration` | 迁移标记 | 1 B |
| `…\log\opencode.log` + `log\<ISO>.log` | 运行日志 | 3,083,489 B + 新旧 8 个 |
| `…\snapshot\` / `tool-output\` / `repos\` / `bin\` | 快照 / 工具输出 / 仓库缓存 / 自带二进制 | — |
| `…\auth.json` | provider 凭据(明文 API key) | 91 B |
| `C:\Users\lms\.config\opencode\opencode.jsonc` | 用户配置(当前仅 `$schema`) | 50 B |
| `C:\Users\lms\.local\state\opencode` | state 目录(`debug paths` 报) | — |

> 安全提示:实测 `…\share\opencode\auth.json` 里以**明文**保存 `deepseek` 的 `api` key;`control_account`/`credential` 表也存在(本机 0 行)。报告不复制该 key,但请按密钥对待。

### A.2 sqlite schema **VERIFIED**(`sqlite_master` 全量 dump,只读打开副本)

```
session(id TEXT PK, project_id, workspace_id, parent_id, slug, directory, path, title, version,
        share_url, summary_additions, summary_deletions, summary_files, summary_diffs,
        metadata, cost REAL, tokens_input, tokens_output, tokens_reasoning,
        tokens_cache_read, tokens_cache_write, revert, permission, agent, model,
        time_created INT, time_updated INT, time_compacting INT, time_archived INT)
message(id TEXT PK, session_id, time_created INT, time_updated INT, data TEXT)     -- data = JSON
part   (id TEXT PK, message_id, session_id, time_created INT, time_updated INT, data TEXT) -- data = JSON
event  (id TEXT PK, aggregate_id, seq INT, type TEXT, data TEXT)
event_sequence(aggregate_id TEXT PK, seq INT, owner_id TEXT)
project(id, worktree, vcs, name, icon_*, time_created, time_updated, time_initialized, sandboxes, commands)
project_directory(project_id, directory, type, strategy, time_created)
todo(session_id, content, status, priority, position, ...)
permission(project_id, action, resource, ...)      -- 本机 0 行
session_message(...)                               -- 存在但 0 行(已被 event 流取代)
session_input(...)                                 -- 存在但 0 行
workspace / account / account_state / credential / control_account / session_share / migration / data_migration
```

行数(**VERIFIED**):`session` 22、`project` 9、`project_directory` 8、`message` 2,340、`part` 8,594、`event` **32,927**、`event_sequence` 22、`todo` 41、`permission` 0。
`journal_mode = wal`(**VERIFIED**)。`opencode.db` 是 WAL 且最近仍在写(实测 `-wal` mtime 2026-08-18 00:43)。

**关键结构结论**:**VERIFIED** —— 这是**事件溯源 + 投影**架构。真实来源是 `event`(每会话一个 `aggregate_id = sessionID`,`seq` 单调递增,`event_sequence` 存每会话最大 seq);`message` 与 `part` 是**为读取优化的投影**(`message.data` = `message.updated` 里的 `info` 对象,`part.data` = `message.part.updated` 里的 `part` 对象)。**读 transcript 请直接读 `message` + `part`,不要解析 `event`。**

`event` 的类型分布(**VERIFIED**):

```
21365  message.part.updated.1
 8827  message.updated.1
 2677  session.updated.1
   36  message.removed.1
   22  session.created.1
```

### A.3 按 cwd 找最新会话 / 命名 / 时间戳 / 运行中判定

* **命名**:`session.id` = `ses_<20位十六进制/自定义64进制>`(如 `ses_01a09204effeT71oU1XNKFbv19`);`message.id` = `msg_…`;`part.id` = `prt_…`。`slug` 是 `kind-cactus` 这类人类名。**没有**按目录分文件的机制 —— 全部会话在同一张表里,靠 `session.directory` 过滤。**VERIFIED**
* **时间戳**:一律为 **epoch 毫秒整数**。`1786895891519` ↔ `2026-08-16T15:58:11.519Z`(**VERIFIED**)。
* **cwd 归一化(必须做)**:`session.directory` 用**正斜杠**存(`C:/myFiles/Notes/obsidian_lms`),而 `message.data.path.cwd` 用**反斜杠**;而且 partition 会话的 `project_id = 'global'` 且 `directory` 可能与会话实际工作目录不同(实测 `ses_ff4cdad07ffe6AuHm2Hcpvq1kl`:`project_id=global`、`directory=C:/myFiles/codes/github/social`)。比较前统一 `replace(/\\/g,'/').toLowerCase()` 并去掉尾斜杠。**VERIFIED**
* **`opencode run -c/--continue` 到底选哪个会话**:**VERIFIED(二进制内嵌 CLI 源码)**:
  ```js
  let Q = j.continue ? (await G.session.list()).data?.find($ => !$.parentID) : void 0;
  ```
  即 **`session.list()` 返回列表里第一个 `parentID` 为空者**。而 `session.list` 的服务端描述是 “Get a list of all OpenCode sessions, **sorted by most recently updated**”(**VERIFIED**,内嵌 OpenAPI 注释)。→ **延续的是“全局最近更新的顶级会话”,不按 cwd 过滤。**
* **运行中判定(权威逻辑,直接取自 opencode TUI 内嵌代码)**:**VERIFIED**
  ```js
  status(sessionID) {
    const s = session;            if (!s) return "idle";
    if (s.time.compacting) return "compacting";
    const last = (messages[sessionID] ?? []).at(-1);
    if (!last) return "idle";
    if (last.role === "user") return "working";
    return last.time.completed ? "idle" : "working";   // assistant 未填 completed → 还在跑
  }
  ```
  纯 sqlite 等价实现:
  `select json_extract(data,'$.role') role, json_extract(data,'$.time.completed') from message where session_id=? order by time_created desc limit 1`
  → 最后一条是 `user` 或 `assistant` 且 `time.completed is null` ⇒ **working**。

### A.4 记录形状(真实样本,截断 ~200~300 字符)**VERIFIED**

`session` 一行(实测最新一条):

```
id=ses_01a09204effeT71oU1XNKFbv19  project_id=bea52d6deb15d0b21f5f40dac553df30de3c5739
directory=C:/myFiles/Notes/obsidian_lms  title=下载论文到paper文件夹  version=local
agent=build  model={"id":"deepseek-v4-flash","providerID":"deepseek","variant":"default"}
cost=0.0027233303999999996  tokens_input=10619  tokens_output=1865  tokens_reasoning=1360
time_created=1786269589425  time_updated=1786895891519  time_archived=null
```

`message.data`(投影,`role=user`,注意**没有** `time.completed`):

```json
{"parentID":"msg_00b4b1c36001mtluvTQ3KnHy6k","role":"assistant","mode":"build","agent":"build",
 "path":{"cwd":"C:\\myFiles\\Notes\\obsidian_lms","root":"C:\\myFiles\\Notes\\obsidian_lms"},
 "cost":0.00007784,
 "tokens":{"total":12996,"input":92,"output":104,"reasoning":0,"cache":{"write":0,"read":12800}},
 "modelID":"deepseek-v4-flash","providerID":"deepseek",
 "time":{"created":1786895888326,"completed":1786895891512},"finish":"stop"}
```

实测统计(**VERIFIED**,全库 2,340 条 message):
`assistant + finish="tool-calls"` 1800、`assistant + finish="stop"` 229、`assistant + finish=null` 26、`assistant + "unknown"` 8、`assistant + "length"` 1、`user + finish=null` 276。
`assistant` 中只有 **1 条** `time.completed` 为空(user 全部为空,正常)。

`part.data` 逐类型真实样本(**VERIFIED**,截断):

```
part/text        {"type":"text","text":"原因找到了：Obsidian 用的是按机器分的 `appearance-DESKTOP-56E7VNN.json`，它只启用了 `checkbox`，没启用 `line-spacing`。…","time":{"start":1786895889642,"end":1786895890412}}
part/reasoning   {"type":"reasoning","text":"The desktop-specific appearance file uses \"Blue Topaz\" theme and has different snippets enabled (only \"checkbox\"). …","time":{"start":1786895885549,"end":1786895886204}}
part/tool        {"type":"tool","tool":"edit","callID":"call_00_QNqK22veNA5wKuBnKCqs9280","state":{"status":"completed","input":{"filePath":"C:\\myFiles\\Notes\\obsidian_lms\\.obsidian\\appearance-DESKTOP-56E7VNN.json","oldString":"…","newString":"…"},"output":"Edit applied successfully.","metadata":{"diagnostics":{},"diff":"Index: …"}}}
part/step-start  {"snapshot":"899916c7b097fcea09cc1fc4e36f1e6ac3ee45e9","type":"step-start"}
part/step-finish {"reason":"stop","snapshot":"899916c7b097fcea09cc1fc4e36f1e6ac3ee45e9","type":"step-finish","tokens":{"total":12996,"input":92,"output":104,"reasoning":0,"cache":{"write":0,"read":12800}},"cost":0.00007784}
part/patch       {"type":"patch","hash":"e4e480fde9113d5dc7a75a7139072c6a4dbb4af1","files":["C:/myFiles/Notes/obsidian_lms/.obsidian/appearance-DESKTOP-56E7VNN.json"]}
part/compaction  {"type":"compaction","auto":true,"overflow":false,"tail_start_id":"msg_fe596c0ca001L6CDHiiByOLx3i"}
part/file        {"type":"file","mime":"text/plain","filename":"技术方案.md","url":"file:///C:/myFiles/codes/github/aiinfo/技术方案.md","source":{"text":{"value":"@技术方案.md","start":0,"end":8},"type":"file","path":"C:\\myFiles\\codes\\github\\aiinfo/技术方案.md"}}
```

part 类型分布(**VERIFIED**,8,594 条):`step-start` 2055、`step-finish` 2038、`tool` 1908、`text` 1643、`reasoning` 787、`patch` 156、`compaction` 5、`file` 2。
`tool.state.status` 分布:`completed` 1827、`error` 81(**没有** `running`/`pending` 落库 —— 中间态只走事件流)。工具名 top:`bash` 923、`edit` 418、`read` 237、`write` 174、`websearch` 38、`grep` 31、`todowrite` 30、`webfetch` 26、`question` 26、`task` 1。

### A.5 消息顺序 / 角色 / parts 如何组成一次 assistant 答复 **VERIFIED**

* **排序**:`order by time_created, id`(毫秒可能撞车,必须用 `id` 做 tie-break;`part.id` 前缀单调)。**VERIFIED**(实测 transcript 顺序自洽)。
* **角色**:`message.data.role` ∈ `user` / `assistant`(实测全库只有这两种;`message.data.mode="build"` 是模式而非角色)。
* **一次“用户utterance”的构成**:1 条 `role=user` 的 message,parts 只有 `text`(以及可选 `file`)。`user` 的 `time.completed` **永远为空**。
* **一次“轮次”的构成**:`role=user` 的 message 开轮 → 若干条 `role=assistant` message,**它们全部共享同一个 `parentID`,等于那条 user message 的 id**(实测:`msg_00b4b1c36001mtluvTQ3KnHy6k` 下有 6 条 assistant message)。**VERIFIED**
* **单条 assistant message 的内部结构**(一次 LLM step):`step-start` →(`reasoning`? )→(`text`? )→(`tool`+`patch`? )→ `step-finish`,以 `step-finish.reason` 收尾。`finish="tool-calls"` 表示还要继续下一步;`finish="stop"` 表示该 message 是这一步的收尾且**整轮结束**。**VERIFIED**
* **整轮结束标记**:最后一个 assistant message 的 `data.finish === "stop"`,其紧邻的 `part/step-finish.reason === "stop"`。实测 `step-finish.reason` 分布与 `message.finish` **完全一致**:`tool-calls` 1800、`stop` 229、`unknown` 8、`length` 1。**VERIFIED**
* **另有两个更强信号(HTTP/事件流)**:
  * SSE `session.status`,其 `properties.status.type === "idle"` 时 `opencode run` 就 `break` 结束(**VERIFIED**,内嵌 CLI 源码:`if (Y.type==="session.status" && Y.properties.sessionID===W && Y.properties.status.type==="idle") break;`)。
  * `session.idle` 事件类型存在(**VERIFIED**,二进制字符串)。
* **`opencode export <sessionID>`** 给出人类可读 JSON:**VERIFIED(help)**;本 recon **未执行**(受 A.0 的日志阻塞),故未附真实 export 样本;A.4 的样本全部取自数据库本体,语义等价。

### A.6 边写边读是否安全 / tail 策略 **VERIFIED(实测成功)+ 说明**

* **安全但要小心 WAL**。实测:直接以 `readOnly` 打开**运行中**的 `opencode.db` 在只读沙箱下**失败**,因为 SQLite 打开 WAL 库需要写 `-shm`。**解决:把 `opencode.db` + `-wal` + `-shm` 三个文件一起拷到可写临时目录,再以 `readOnly` 打开副本** —— WAL 内容会被正常回放,已提交数据不丢(**VERIFIED**,配方即如此,读到了全部 22 个会话)。
  * 备选:`file:///…/opencode.db?immutable=1` 能在原地打开,但**跳过 WAL**,可能读到旧快照 —— 不推荐。
  * 只读连接不会被写者阻塞(WAL 模式允许并发读),反之亦然;不要开 `PRAGMA journal_mode` 之类会写库的语句。
* **没有“半行”问题**(不是文本日志),但**投影表可能有中间态**:`part` 行是 insert-or-update 的,正在跑的 `text` part 其 `time.end` 可能还没写。**判据**:只把 `time.end` 已存在的 `text`/`reasoning` part 当作最终文本(这正是 `opencode run` 自己的规则:**VERIFIED**,源码 `if (J.type==="text" && J.time?.end)`)。同理,`tool` part 只有 `state.status` ∈ `completed|error` 才算终态。
* **最稳的 tail 策略**:
  1. 记住上次的 `(session_id, 最大 time_created, 最大 message/part id)`;
  2. 每轮 `select ... where session_id=? and (time_created > ? or (time_created = ? and id > ?)) order by time_created, id`;
  3. 或直接盯 `event` 表:`select seq, type, data from event where aggregate_id=? and seq > ? order by seq` —— `seq` 单调,**天然就是一个游标**,比时间戳可靠。**VERIFIED**(`event_aggregate_seq_idx (aggregate_id, seq)` 唯一索引)。
* 实时(非轮询)推荐用 HTTP:`GET /event`(SSE,见 B.3)。

### A.7 可直接复制的零依赖 Node 配方(**VERIFIED,99 行,已在本机跑通**)

保存为 `opencode-recipes.mjs`,命令行:

```powershell
node opencode-recipes.mjs --list
node opencode-recipes.mjs --id ses_01a09204effeT71oU1XNKFbv19 --tail 2
node opencode-recipes.mjs --cwd "C:\myFiles\Notes\obsidian_lms" --tail 1
node opencode-recipes.mjs --last --tail 1          # 复刻 `opencode run -c` 的选会话逻辑
```

实测输出(节选,**VERIFIED**):

```
session   : ses_01a09204effeT71oU1XNKFbv19   agent=build   model={"id":"deepseek-v4-flash","providerID":"deepseek",...}
directory : C:/myFiles/Notes/obsidian_lms   project=bea52d6deb15d0b21f5f40dac553df30de3c5739
title     : 下载论文到paper文件夹
updated   : 2026-08-16T15:58:11.519Z (2674525s ago)
cost/tok  : 0.0027233303999999996 10619/1865/1360
messages  : 17   parts: 56
verdict   : IDLE (turn finished; waiting for human)  lastStepFinish=stop

--- TURN opened by msg_00b4b1c36001mtluvTQ3KnHy6k 2026-08-16T15:57:46.987Z → assistants: tool-calls,tool-calls,tool-calls,tool-calls,tool-calls,stop
  user  : 没变化
  think : The user says there's no change. Let me think about why. In Obsidian, the editor line spacing CSS might need different selectors. …
  tools : 5 bash:completed({"command":"Get-ChildItem -LiteralPath \".obsidian\" -Filter \"*.json\"…}) ; read:completed(...) ; write:completed(...)
  final :  snippet 已启用，是选择器不够覆盖新版 Obsidian 的编辑器。改进一下：…
```

完整源码见 `.recon-tmp\opencode-recipes.mjs`(99 行)。核心片段:

```js
// 1) 只读 + WAL 安全打开(DatabaseSync 惰性,必须 pragma 逼出失败)
function openDb(file) {
  try { const db = new DatabaseSync(file, { readOnly: true }); db.prepare('pragma schema_version').get(); return { db }; }
  catch {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-read-'));
    const copy = path.join(scratch, 'opencode.db');
    for (const suf of ['', '-wal', '-shm']) if (fs.existsSync(file + suf)) fs.copyFileSync(file + suf, copy + suf);
    const db = new DatabaseSync(copy, { readOnly: true }); db.prepare('pragma schema_version').get();
    return { db, scratch };
  }
}
// 2) 找会话:session.directory 是正斜杠,必须归一化
const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const sessions = q(`select id, project_id, parent_id, directory, title, agent, model, cost,
                           tokens_input, tokens_output, tokens_reasoning, time_created, time_updated, time_archived
                    from session where time_archived is null order by time_updated desc`);
// 3) 读 transcript:message.data / part.data 都是 JSON 字符串
const msgs  = q(`select id, time_created, data from message where session_id=? order by time_created, id`, sid);
const parts = q(`select id, data from part where message_id=? order by time_created, id`, mid);
// 4) 完成判定:assistant 的 part/step-finish.reason === 'stop'
```

判 idle/busy 的等价 SQL(**VERIFIED** 逻辑,直接可用):

```sql
-- 该会话是否还在工作(取最后一条 message 的角色与 completed)
select json_extract(data,'$.role') as role,
       json_extract(data,'$.time.completed') as completed,
       json_extract(data,'$.finish') as finish
from message where session_id = 'ses_XXXX' order by time_created desc, id desc limit 1;
-- role='user' 或 (role='assistant' and completed is null)  =>  WORKING
-- role='assistant' and completed is not null               =>  IDLE

-- 最近的 step-finish 原因
select json_extract(data,'$.reason') from part
where message_id in (select id from message where session_id='ses_XXXX')
  and json_extract(data,'$.type')='step-finish'
order by time_created desc, id desc limit 1;     -- 'stop' = 整轮结束
```

---

## B. 打鞭子:非交互注入下一条指令

### B.1 精确调用方式 **VERIFIED(help 原文)**

```powershell
# 续“最近会话”(= session.list 里第一条 parentID 为空的)
opencode run -c "下一条指令"

# 续指定会话
opencode run -s ses_01a09204effeT71oU1XNKFbv19 "下一条指令"

# 边续边 fork(不污染原会话)
opencode run -s ses_01a09204effeT71oU1XNKFbv19 --fork "下一条指令"

# 指定目录 / agent / 模型 / 权限
opencode run --dir "C:\path\to\ws" --agent build -m deepseek/deepseek-v4-flash "下一条指令"

# 只读本轮(不允许任何未被显式允许的写)
opencode run -s ses_XXX "只分析不改文件：..."     # 默认就会自动拒绝权限请求,见下
```

`opencode run --help` 原文要点(**VERIFIED**):

```
Usage: opencode run [message..]
  -c, --continue     continue the last session
  -s, --session      session id to continue
      --fork         fork the session before continuing (requires --continue or --session)
  -m, --model        model to use in the format of provider/model
      --agent        agent to use
      --format       format: default (formatted) or json (raw JSON events)  [choices: default, json]
  -f, --file         file(s) to attach to message
      --title        title for the session
      --attach       attach to a running opencode server (e.g., http://localhost:4096)
  -p, --password     basic auth password (defaults to OPENCODE_SERVER_PASSWORD)
  -u, --username     basic auth username (defaults to OPENCODE_SERVER_USERNAME or 'opencode')
      --dir          directory to run in, path on remote server if attaching
      --port         port for the local server (defaults to random port if no value provided)
      --variant      model variant (provider-specific reasoning effort)
      --thinking     show thinking blocks
  -i, --interactive  run in direct interactive split-footer mode
      --auto         auto-approve permissions that are not explicitly denied (dangerous!)
```

**stdin 支持**:**VERIFIED(源码)** —— `let u = process.stdin.isTTY ? undefined : await Bun.stdin.text();` 非 TTY 时自动读 stdin 并拼进 prompt;若既没 message 也没 stdin 则报 `You must provide a message or a command` 退出。

**关键安全行为(默认就很安全)**:**VERIFIED(源码)** —— run 模式默认注入三条 deny 规则,并在收到 `permission.asked` 时**自动 reject**:

```js
let o = q ? [] : [
  { permission: "question",  action: "deny", pattern: "*" },
  { permission: "plan_enter", action: "deny", pattern: "*" },
  { permission: "plan_exit",  action: "deny", pattern: "*" } ];
// 事件循环里:
if (Y.type === "permission.asked") {
  if (Yj /* = --auto | --yolo | --dangerously-skip-permissions */) await N.permission.reply({ requestID: J.id, reply: "once" });
  else { z.println("! permission requested: " + J.permission + " (…); auto-rejecting");
         await N.permission.reply({ requestID: J.id, reply: "reject" }); } }
```

→ **不加 `--auto` 时,任何需要授权的动作都会被自动拒绝**(不会挂起等人类),非常适合无人值守;`question` / `plan_enter` / `plan_exit` 三条被强制 deny。

**`--auto` 的风险**:**VERIFIED** —— `--auto` 等价于对所有“未被显式拒绝”的权限一律 `reply:"once"` 自动批准。help 里就写着 `(dangerous!)`。还有两个 **hidden** 别名:`--yolo` 与 `--dangerously-skip-permissions`,与 `--auto` **完全同一开关**(源码 `Yj = j.auto || j.yolo || j["dangerously-skip-permissions"]`)。这意味着:**`--auto` 下模型可以任意写文件、跑命令;唯一拦得住它的是 agent 配置里显式 `deny` 的权限。** 另外 `--auto` 只影响 harness 自己的权限闸门,**不是沙箱**。

### B.2 `--format json` 究竟输出什么 **VERIFIED(源码级)**

`opencode run --format json` 把事件按 **JSONL 逐行写到 stdout**。源码:

```js
function Z(N, _) { if (j.format === "json") return process.stdout.write(JSON.stringify({ type: N, timestamp: Date.now(), sessionID: W, ..._ }) + "\n"), true; return false; }
```

发出的行(**VERIFIED**,类型与字段名均来自该函数被调用的位置):

| `type` | 载荷 |
|---|---|
| `tool_use` | `{part}` —— `part.type==="tool"` 且 `state.status` 为 `completed` \| `error` |
| `step_start` | `{part}` —— `part.type==="step-start"` |
| `step_finish` | `{part}` —— `part.type==="step-finish"`(含 `reason`,`cost`,`tokens`) |
| `text` | `{part}` —— `part.type==="text"` **且 `part.time.end` 已存在** |
| `reasoning` | `{part}` —— 仅当 `--thinking` 为真且 `part.time.end` 存在 |
| `error` | `{error}` —— 来自 `session.error` 事件的 `properties.error` |

每行统一带 `type` / `timestamp`(**本地 `Date.now()` 毫秒**,不是会话时间)/ `sessionID`。
**注意**:**没有**一个“最终答复”行;要拿最终答复,取最后一条 `type:"text"` 行的 `part.text`(或累加所有 `text` part)。**INFERRED**(由上面 table 直接推得)。
**未实测**(A.0 阻塞),故未附真实 `--format json` 输出样本。不加大模型调用成本的取法就是直接读 A.7 的 DB 查询。

`--format json` 与 `--mini` 互斥(**VERIFIED**:`if (q && j.format==="json") T("--mini cannot be used with --format json")`)。

### B.3 Headless HTTP 控制面 **VERIFIED(schema 级;未实跑)**

* 启动:`opencode serve [--port <n>] [--hostname 127.0.0.1] [--cors <domain...>] [--mdns] [--pure] [--print-logs] [--log-level DEBUG|INFO|WARN|ERROR]`(**VERIFIED** help 原文;`--port` 默认 `0` = 随机端口)。
* `--attach` 的示例 URL 是 `http://localhost:4096`(**VERIFIED**,`opencode run --attach` 与 `opencode attach <url>` 的 help),所以**默认约定端口是 4096**;`serve` 自己不默认 4096,要显式 `--port 4096`。
* **认证**:HTTP Basic。`opencode run --attach` / `opencode attach` 接受 `-p/--password`(默认取 `OPENCODE_SERVER_PASSWORD`)与 `-u/--username`(默认 `OPENCODE_SERVER_USERNAME` 或 `opencode`)(**VERIFIED**)。服务器端若无密码变量则**不鉴权**(**INFERRED**)。
* **OpenAPI 文档路由:`GET /doc`**(**VERIFIED**,二进制内嵌路由字符串 + 内嵌 OpenAPI 生成器代码)。**这是拿到权威接口清单的最快方式**(需先能起 server)。
* 事件流:`GET /event` → `text/event-stream`(**VERIFIED**,OpenAPI `identifier:"event.subscribe"`,description “Subscribe to events”);另有 `GET /global/event`(SSE,`GlobalEvent`)(**VERIFIED**);实验性 `GET /api/event`(`V2Event`,含 `server.connected`)(**VERIFIED**)。
* **完整 REST 路由表(151 条,从二进制内嵌 SDK 逐条抽取)** —— 摘录与打鞭子相关的全部条目(**VERIFIED**):

```
GET    /session                                   [directory workspace scope path roots start search limit]
GET    /session/status                            [directory workspace]      <- active/idle/completed
GET    /session/{sessionID}                       [directory workspace]
GET    /session/{sessionID}/message               [directory workspace limit before]
GET    /session/{sessionID}/message/{messageID}
GET    /session/{sessionID}/todo | /children | /diff
POST   /session                                   [directory workspace; body: parentID title agent model metadata permission workspaceID]
POST   /session/{sessionID}/message               [body: messageID model agent noReply tools format system variant parts]
POST   /session/{sessionID}/prompt_async          [同上 body]              <- 异步注入,不阻塞
POST   /session/{sessionID}/command               [body: messageID agent model arguments command variant parts]
POST   /session/{sessionID}/shell                 [body: messageID agent model command]
POST   /session/{sessionID}/abort
POST   /session/{sessionID}/fork                  [body: messageID]
POST   /session/{sessionID}/summarize             [body: providerID modelID auto]
POST   /session/{sessionID}/revert | /unrevert | /share | /init
PATCH  /session/{sessionID}                       [body: title metadata permission time]
DELETE /session/{sessionID}
GET    /permission                                [directory workspace]      <- 待批权限
POST   /permission/{requestID}/reply              [body: reply message]
POST   /session/{sessionID}/permissions/{permissionID}  [body: response]
GET    /mcp  |  POST /mcp [body: name config]  |  POST /mcp/{name}/connect | /disconnect
GET    /config | GET /config/providers | PATCH /config
GET    /global/health | GET /global/config | PATCH /global/config | POST /global/dispose | POST /global/upgrade
GET    /event | GET /global/event
GET    /agent | /command | /skill | /lsp | /formatter | /provider | /path | /project | /vcs
GET/POST /pty  ...  (完整 PTY API: create/get/update/remove/connect/connect-token/shells)
POST   /tui/{append-prompt,submit-prompt,clear-prompt,execute-command,publish,show-toast,select-session,...}
GET    /file | /file/content | /file/status | /find | /find/file | /find/symbol
GET/POST /experimental/{capabilities,console,session,workspace,worktree,tool,resource}
GET    /doc          <-- OpenAPI 规范
```

* **推荐的 supervisor HTTP 注入(等价于 `opencode run -s <id> "..."`)**:**INFERRED**(由 schema/内嵌客户端推得,未实跑):

```powershell
# 0) 起服务(注意:本机只读沙箱会让它失败,见 A.0)
opencode serve --port 4096 --hostname 127.0.0.1

# 1) 查哪些会话在忙
curl.exe -s "http://127.0.0.1:4096/session/status"

# 2) 注入一条指令(阻塞直到该轮结束)
curl.exe -s -X POST "http://127.0.0.1:4096/session/ses_XXXX/message" ^
  -H "Content-Type: application/json" ^
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"继续：把结论写进 docs/report.md\"}]}"

# 3) 或者异步注入(立即返回,自己再靠 /event 或 /session/status 判完成)
curl.exe -s -X POST "http://127.0.0.1:4096/session/ses_XXXX/prompt_async" ^
  -H "Content-Type: application/json" -d "{\"parts\":[{\"type\":\"text\",\"text\":\"继续\"}]}"

# 4) 需要时批准/拒绝一个权限请求
curl.exe -s -X POST "http://127.0.0.1:4096/permission/<requestID>/reply" ^
  -H "Content-Type: application/json" -d "{\"reply\":\"once\"}"     # reply: once | always | reject
```

* `opencode attach <url>` 是**TUI**附着(交互界面),不是给脚本用的注入通道 —— 脚本请用上面的 REST 或 `opencode run --attach`。
* `opencode acp` = **ACP(Agent Client Protocol)服务器**,`--port`(默认 0)/`--hostname`/`--cwd`(**VERIFIED** help)。这是第三种机器可驱动通道(编辑器类客户端协议)。
* `opencode db`:**VERIFIED(源码)** —— `opencode db "<SQL>"` 直接跑 SQL:`instance:!1`(不需要 runtime?实际上本机仍因日志失败),`--format json|tsv` 默认 `tsv`;**无 SQL 参数时 `spawn("sqlite3", [dbPath], {stdio:"inherit"})` 打开交互 shell**(因此需要 PATH 里有 `sqlite3`)。`opencode db path` 打印库路径。
* `opencode debug` 子命令(**VERIFIED**):`config`(打印解析后的完整配置,**排查 MCP/权限最有用**)、`paths`、`agent <name>`、`skill`、`scrap`(列出所有已知项目)、`startup`、`info`、`lsp`、`rg`、`file`、`snapshot`、`v2`、`wait`。
* 其它:`opencode models [provider] [--verbose] [--refresh]`、`opencode stats [--days N] [--tools N] [--models] [--project]`、`opencode session list [--max-count N] [--format table|json]`、`opencode session delete <id>`、`opencode export [sessionID] [--sanitize]`、`opencode import <file|url>`、`opencode agent list|create`、`opencode mcp list|add|auth|logout|debug`(**全部 VERIFIED** help)。

### B.4 新会话如何落盘

`opencode run` 新建会话时:`POST /session`(body `title agent model permission`),服务端插一行 `session`(新 `ses_*` id、`project_id` 由 cwd 决定、`slug` 随机人类名)并写一条 `event/session.created.1`。**VERIFIED**(实测 `session.created` 事件 22 条 = 22 个会话,且 `event_sequence.seq` 从 0 开始)。**同一会话被 continue 时,消息/parts 追加到同一 session 下,不新建 session。**

---

## C. MCP

### C.1 opencode 支持用户配置 MCP **VERIFIED(schema 级)**

配置文件:`C:\Users\lms\.config\opencode\opencode.jsonc`(**VERIFIED**,当前内容仅 `{"$schema":"https://opencode.ai/config.json"}`,**尚未配置任何 MCP**)。顶层键 **`mcp`**,两种 server(**VERIFIED**,二进制内嵌 `Config.MCP` schema):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "my-local":  { "type": "local",  "command": ["node", "server.js"],
                   "cwd": ".", "environment": { "KEY": "VALUE" },
                   "enabled": true, "disabled": false,
                   "timeout": { "startup": 5000, "request": 5000 } },
    "my-remote": { "type": "remote", "url": "https://example.com/mcp",
                   "headers": { "Authorization": "Bearer ..." },
                   "oauth": { "client_id": "...", "scope": "...", "callback_port": 19876 } }
  }
}
```

* `local`:`command` 是**字符串数组**(可执行文件 + 参数),`cwd`、`environment`、`enabled`/`disabled`、`timeout.{startup,request}`(毫秒)。
* `remote`:`url`、`headers`、`oauth`(或 `oauth:false` 关闭 OAuth 自动发现),`disabled`、`timeout`。
* 命令行等价物:**VERIFIED** `opencode mcp add [name]`(交互式写配置)、`list|ls`、`auth [name]`(OAuth 登录;help 里直接给出 remote JSON 片段)、`logout`、`debug <name>`。
* 运行时查看:`opencode mcp list`(**VERIFIED** 存在)、`opencode debug config`、HTTP `GET /mcp` / `POST /mcp/{name}/connect|disconnect`(**VERIFIED**)。

### C.2 能否让 MCP tool call 成为“下一条指令”的通道

* **可以,两条路**:
  1. **给 opencode 注册一个 MCP server(supervisor)**,由它暴露 `next_instruction` 之类的工具。opencode 调用该工具时,调用会作为 `part.type==="tool"`,`part.tool` = `"<server>_<tool>"`(MCP 工具命名约定),`state.input` / `state.output` 完整落库 —— 于是“指令下发”与“transcript 留痕”合二为一。**VERIFIED**:工具调用确实以 `part/tool` + `state.{status,input,output,metadata}` 完整落库(实测 1,908 条)。
  2. **把 opencode 当 MCP client 用**:`opencode mcp add/local/remote`,让它去连外部 server。
* **反向(以 opencode 为被驱动方)**:`opencode acp`(ACP server)与 `opencode serve`(HTTP/SSE)才是设计给程序驱动的入口;`opencode run` 是给 shell 脚本的单次注入。
* 本机**尚未配置任何 MCP server**(**VERIFIED**),所以没有真实 MCP 调用样本可引;上面第 1 条的具体工具命名与 `input` 形状为 **INFERRED**。

---

## 单一最佳“打鞭子”命令(opencode)

```powershell
opencode run -s <ses_SESSION_ID> --dir "<workspace>" --format json "继续:<下一条指令>;完成后用一句话总结你做了什么"
```

理由:`-s` 显式指定会话,避开 `-c` 的“全局最近会话、不按 cwd 过滤”歧义;`--dir` 固定工作目录;**不加 `--auto`** 时所有非显式允许的权限会被自动 reject(不会挂起等人类),这是最安全的无人值守默认;`--format json` 给 supervisor 逐行 JSONL(`step_start`/`text`/`tool_use`/`step_finish`/`error`),其中 `step_finish.part.reason==="stop"` 即整轮结束。

**与本仓库 `src/engine/whip.mjs` 的接法**:`composeWhip(...)` 的输出去掉模板首行 `还没到收工的时候。` 之类寒暄也可(headless 无需拟人),直接把整段当作 `message` 参数:

```powershell
opencode run -s <ses_SESSION_ID> --dir "<workspace>" --format json "<composeWhip 文本>"
```

`opencode run` 非 TTY 时会自动读 stdin(`Bun.stdin.text()`)并把内容拼进 prompt,所以 stdin 亦可:

```powershell
'<composeWhip 文本>' | opencode run -s <ses_SESSION_ID> --dir "<workspace>" --format json
```

> 备选(更适合长连接 supervisor):`opencode serve --port 4096` + `POST /session/{id}/message` 注入 + `GET /event` 判完成。

---

## D. Supervisor 完成检测与幂等

1. **完成检测(离线,推荐)**:
   * `part/step-finish.reason === "stop"`(**VERIFIED** 与 `message.finish==="stop"` 一一对应)出现在**该会话最后一条 message** 上 ⇒ 整轮结束;`tool-calls` ⇒ 还在跑。
   * 或 `message.data.time.completed is not null` 且 `finish="stop"`。
   * 或(等价于 TUI 逻辑)最后一条 message 是 `assistant` 且 `time.completed` 非空 ⇒ idle。
   * 判“卡住”:`time_updated` 超过 N 分钟未变 **且** 最后一条 message 未完成 ⇒ STALE。
2. **完成检测(在线)**:SSE `session.status` 的 `status.type==="idle"`,或 `session.idle` 事件(**VERIFIED** 这两者都是 `opencode run` 自己用的判据)。
3. **幂等/防重复注入**:
   * 注入前记下 `(session_id, 最后一条 user message 的 id)` 或 `(session_id, event_sequence.seq)` 游标。
   * 只有当**出现了一个新的、已完成的 assistant 轮**(`finish="stop"`,且其 `parentID` 是那次注入的 user message id)**才允许下一次注入**。
   * 持久化到 `<workspace>\.supervisor\state.json`:`{ sessionId, lastInjectedUserMessageId, lastSeenSeq }`。`event.seq` 单调 ⇒ 用它做游标天然幂等(**VERIFIED**:`event_aggregate_seq_idx` 唯一)。
   * **不要**用 `session.time_updated` 做幂等键 —— 它会被任何 part 更新推动(**VERIFIED**:`session.updated` 事件 2,677 条远多于消息数)。
4. **注意**:`opencode run` 不阻塞时(用 `prompt_async`)必须自己判完成;`POST /session/{id}/message` 会阻塞到该轮结束。

## E. 未验证 / 阻塞项

* **实测阻塞**:只读沙箱不能写 `C:\Users\lms\.local\share\opencode\log\opencode.log`,导致 **`opencode serve` / `opencode run` / `opencode db` / `opencode export` 全部 exit 1**(错误串 `Unknown: FileSystem.open (…\log\opencode.log)`)。因此:HTTP 接口只按 schema 描述、未做真实请求;`--format json` 未取到真实样本;`opencode export` 样本缺失(已用数据库本体样本替代,语义等价)。
  * 若要解封:给该日志目录写权限后,`opencode serve --port 41999` + `curl http://127.0.0.1:41999/doc` 即可拿到完整 OpenAPI 并实测。
* 二进制里有 `OPENCODE_DISABLE_AUTOUPDATE`、`OPENCODE_DISABLE_MODELS_FETCH`、`OPENCODE_PURE`、`OPENCODE_LOG_LEVEL`、`OPENCODE_CONFIG_DIR`、`OPENCODE_DB`、`OPENCODE_SERVER_PASSWORD`、`OPENCODE_SERVER_USERNAME`、`OPENCODE_PERMISSION`、`OPENCODE_TEST_HOME` 等大量环境变量(**VERIFIED** 字符串存在),其中 `OPENCODE_DB` / `OPENCODE_CONFIG_DIR` / `OPENCODE_SERVER_PASSWORD` 对 supervisor 部署最有用;但**未实测**其精确语义(除了 `OPENCODE_SERVER_PASSWORD` 由 help 文本直接确认)。
* `--auto` / `--yolo` / `--dangerously-skip-permissions` 三者在源码里是同一开关(**VERIFIED**);`--yolo` 与 `--dangerously-skip-permissions` 在 help 中是 hidden(**VERIFIED** 源码 `hidden:!0`)。

# DSH 会话存储格式逆向报告（Session Transcript Storage）

> 对象：DeepSeek Harness（DSH）的会话落盘格式。
> 方法：**只读**取证实测（解压并解析真实 live 会话文件）+ 逐行阅读 DSH 源码。
> checkout：`C:\myFiles\codes\github\deepseek-harness`
> `DSH_HOME` = `C:\Users\lms\.dsh`
> 实测环境：Node v24.19.0 / Windows
> 取证脚本（一次性，零依赖）：`cyber-overseer\.recon-tmp\*.cjs`

文中标记：
- **[已验证]** = 来自真实文件解析结果或源码明文，可复核；
- **[推断]** = 由证据合理外推，未直接验证。

---

## 0. 结论速查（最关键的 7 条）

1. **会话日志物理层是「拼接的 zstd 帧流」，不是单个 zstd 流。** Node 的 `zlib.zstdDecompressSync(buf)` 与 `zlib.createZstdDecompress()` 都**只解第一帧就停**（实测：774 KB 文件只返回 191 字节）。必须自己按 zstd 帧结构扫描并逐帧解压。**[已验证]**
2. 每个会话目录**只有 1 个文件**：`session.jsonl.zstd`。没有 index、没有 meta sidecar、没有 lock 文件。**[已验证]**
3. 逻辑层 = **头行 1 条**（`type: 'session'`）**+ 存储行 N 条**；存储行有两种：普通事件行，以及**打包的 chunk 行**（`text-chunks` / `reasoning-chunks` / `tool-call-chunks`，1 行还原成多条 `assistant/chunk`）。**[已验证]**
4. 事件信封固定为 `{type, seq, time, data}`；`seq` 从 **0** 开始连续；`time` 是 **epoch 毫秒**。消息类事件额外带 `surfaceOp`，`assistant/message` 额外带 `sourceEventSeqs`。**[已验证]**
5. **「最后一次回答文本」的精确路径**：`data.message.content[i].text`，其中 `content[i].type === 'text'`，取该会话中**最后一条 `assistant/message`**。注意最后一条 `assistant/message` 可能**只有 tool-call、没有 text**（live 会话实测就是如此）。要拿"最后一段给人看的文本"，必须**反向找第一条真正含 text 的 `assistant/message`**。**[已验证]**
6. **空闲 / 忙 判定**：对 `turn/start` 与 `turn/end` 做"最后一个胜出"的 fold。**末尾是 `turn/start` → 还在回合中（mid-turn）；末尾是 `turn/end` → 回合已结束、等人类输入。** 这条规则在 DSH 源码里被两处独立实现（`plan-mode` 的 `hasOpenTurn`、`user-approval` 的 `hasOpenTurn`），可直接照抄。**[已验证]**
7. **可以安全地边写边读**：每次 append 都是"一个完整的、带 checksum 的 zstd 帧 + 该帧内以 `\n` 结尾的完整 JSONL 行"。因此**只解「结构完整的帧」，未完成的尾帧直接丢弃**，永远拿不到半行 JSON。实测在会话持续增长期间连续读 8 次：**0 次坏 JSON、0 次撕裂帧**。**[已验证]**

---

## 1. `DSH_HOME` 目录布局

### 1.1 根目录实测清单

```
C:\Users\lms\.dsh\
├── .anonymous-user-id          (37 B)   匿名用户 id
├── .credentials.yaml           (73 B)   凭据（未读取内容）
├── settings.yaml               (52 B)   UI 设置（实测仅 ui-onboarding）
├── sessions\                           ← 会话日志根（权威数据）
│   └── --C-myFiles-codes-deepseek--\
│       └── <encoded-session-id>\
│           └── session.jsonl.zstd
├── storages\                           ← 投影缓存（派生数据）
│   ├── session_projcache.json  (202,106 B)
│   ├── workspace.json          (1,910 B)
│   └── .<uuid>.tmp                     ← 原子写临时文件（见 §5）
├── profiles\                           ← dsh profile（插件组合）
│   ├── node_modules\
│   └── web\{cordis.yml, cordis.patch.yml, package.json, pnpm-lock.yaml, pnpm-workspace.yaml, node_modules\}
└── pdf-docs\                           ← 与本主题无关（PDF 产物）
```

`DSH_HOME` 解析规则（源码 `packages/util/home-paths/src/index.ts`）**[已验证]**：
优先级 = 显式配置 > `$DSH_HOME` > `~/.dsh`；空/纯空白 `$DSH_HOME` 视为未设置；支持 `~` / `~/` / `~\` 展开。

### 1.2 `sessions/` 三层结构

会话根路径由 shipped profile 显式配置 **[已验证]**：

```yaml
# packages/bundle/base/cordis.patch.yml:98-101
- id: session-persistence-jsonl
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: !!js dshHomePath('sessions')      # → $DSH_HOME/sessions
```

层级：`root / <project-dir> / <encoded-session-id> / session.jsonl.zstd`

```text
sessions/
└── --C-myFiles-codes-deepseek--/           ← project dir（slug，由 cwd 派生）
    ├── session-89016627-2d3a-43be-a063-85af76d3ee74/
    │   └── session.jsonl.zstd              ← 283,366 B → 长到 803,976 B（会话进行中）
    ├── efd0ae18-d335-4c86-95bc-632d7dacc871/   ← subagent 子会话（delegationDepth=1）
    │   └── session.jsonl.zstd
    └── …（实测该 project 目录下共 55 个会话目录）
```

**实测确认**：每个会话目录里**恰好 1 个文件**（抽查全部 55 个目录，`session.jsonl.zstd`；无 `.jsonl`、无 index、无 lock）。**[已验证]**

### 1.3 slug（project dir）如何由 cwd 派生 —— 精确算法

源码 `packages/session/session-persistence-jsonl/src/format.ts` 的 `projectKey(cwd)` **[已验证]**：

1. 逐 UTF-16 code unit 扫描 `cwd`；
2. `'/ '`、`'\'`、`':'` → 折叠成**单个** `-`（**连续分隔符只出一个 `-`**，`separatorRun` 去重）；
3. 其余字符中，`[A-Za-z0-9._-]` 原样保留；**其他任何字符**（含 `~`、中文、空格）→ `~XXXX`（大写 4 位十六进制 code unit）；
4. 去掉开头的所有 `-`；若结果为空则用 `'root'`；
5. 截断到 **251 字符**；
6. 最终包成 `--${slug}--`。

逐字符演算 `C:\myFiles\codes\deepseek`：
```
C → 'C'   : → '-'  \ → (折叠)  m,y,F,i,l,e,s → 原样  \ → (折叠)
c,o,d,e,s → 原样  \ → (折叠)  d,e,e,p,s,e,e,k → 原样
→ "C-myFiles-codes-deepseek"  →  "--C-myFiles-codes-deepseek--"   ✅ 与实测完全一致
```

`cwd === undefined` 时使用固定目录 `_no-cwd`（源码 `projectDir()`）。**[已验证]**

**会话子目录名如何派生**（`encodeSegment(id)`）**[已验证]**：
`'.'`→`~002E`，`'..'`→`~002E~002E`；`[A-Za-z0-9._-]` 原样；其他字符（含 `~`）→ `~XXXX`。
实测 id `session-89016627-…` 全为安全字符，故**目录名 == 会话 id 字面量**。

> 注意：`--slug--` 的替换是**有损**的（源码注释明说"lossy, human-navigable convention"），所以**不能**从 slug 反推 cwd。**cwd 必须从会话头行读**。

### 1.4 头行（session index / metadata）字段

`sessions/<slug>/<id>/session.jsonl.zstd` 的第一帧（**独占一帧**）就是头行。实测真实样本 **[已验证]**：

```json
{"type":"session","version":0,"id":"session-89016627-2d3a-43be-a063-85af76d3ee74","createdAt":1789569457529,"cwd":"C:\\myFiles\\codes\\deepseek","delegationDepth":0,"agentPreset":"standard"}
```

subagent 子会话实测样本 **[已验证]**：

```json
{"type":"session","version":0,"id":"efd0ae18-d335-4c86-95bc-632d7dacc871","createdAt":1789569815858,"cwd":"C:\\myFiles\\codes\\deepseek","parentSession":"session-89016627-2d3a-43be-a063-85af76d3ee74","origin":"subagent","delegationDepth":1,"agentPreset":"standard"}
```

字段表（源码 `HeaderLine` / `SessionHeader`）**[已验证]**：

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `type` | `"session"` | ✅ | 固定标签，用于与事件行区分（事件 type 全带 `/`，此标签不带） |
| `version` | `number` | ✅ | 落盘格式版本；当前 `SESSION_FORMAT_VERSION = 0`；读到其它值 → **拒绝加载**（`SessionFormatUnsupportedError`），无迁移 |
| `id` | `string` | ✅ | 会话 id（顶层为 `session-<uuid>`，subagent 为裸 `<uuid>`） |
| `createdAt` | `number` | ✅ | epoch ms |
| `cwd` | `string?` | ❌ | 绝对工作目录；决定 slug。缺失 → `_no-cwd` |
| `parentSession` | `string?` | ❌ | fork/seed 血缘父会话 |
| `seedLength` | `number?` | ❌ | 继承（seed）的事件条数边界。**本机 55 个会话实测均未出现** |
| `origin` | `"subagent"?` | ❌ | 仅此一个取值；subagent 子会话标记 |
| `delegationDepth` | `number` | ✅ | 顶层为 0，子会话 = 父 +1。实测见 0/1/2/3 |
| `agentPreset` | `string?` | ❌ | 组合该会话的 preset id（实测 `"standard"`） |

> 实测 55 个头行出现过的 key 集合：`type, version, id, createdAt, cwd, parentSession, origin, delegationDepth, agentPreset`。**[已验证]**
> 源码明确：头行**禁止**出现已废弃的 `sandboxMode` / `approvalPolicy`（`fromHeaderLine` 会抛错）。

### 1.5 profile 目录

`$DSH_HOME/profiles/<profile-name>/` **[已验证]**：
- `cordis.yml`：profile 根，实测内容为**空数组 `[]`**（注释说明树由 patch 层组合）；
- `cordis.patch.yml`：用户 patch 层（`id` 定向 config 覆盖 / disable / insert，允许 `!!js`）；
- `package.json`：`dsh.profile.bundles` 声明 bundle 列表（实测 web profile 挂了 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` + 两个本地插件）；
- `node_modules/`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`：profile 私有依赖。

另有一个 `$DSH_HOME/profiles/node_modules/`（共享依赖池）。**[已验证]**

### 1.6 会话索引：**不存在**

**结论：JSONL 后端没有索引文件。** 源码 `JsonlSessionPersistence.listArtifacts()` 就是**目录遍历**：读 `root` 下的 project 目录 → 每个会话目录 → 只解压**头帧**（`readFirstZstdLine`，每次读 8192 B 上限）→ `parseHeaderMeta`。源码注释明确：
> "Read only headers so listing scales with session count, not log size."

**[已验证]**

补充：`session-query-sqlite`（全文检索）在 shipped profile 里配置为 **不落盘** **[已验证]**：
```yaml
# packages/bundle/base/cordis.patch.yml:117-121
- id: session-query-sqlite
  config:
    path: ':memory:'
    openAt: never        # 检索调用直接报 SESSION_QUERY_SEARCH_DISABLED
```
实测 `$DSH_HOME` 下**没有任何 `.db` / `.sqlite` / index 文件**。若某部署把 `openAt` 改成 `startup`/`first-search` 且给了真实 `path`，才会出现 SQLite 派生索引（表含 `id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, revision, generation`）。**[已验证配置项 / 推断文件内容]**

---

## 2. 解压后的 `session.jsonl` 精确 schema

### 2.1 物理层：拼接 zstd 帧（**最关键的陷阱**）

写路径（源码 `encodeMaterialization` / `encodeEventBatch`）**[已验证]**：
```ts
// 每帧 = zstdCompress(一段以 \n 结尾的 JSONL 文本, { params: { ZSTD_c_checksumFlag: 1 } })
materialize: Buffer.concat([ headerFrame, eventFrame ])   // 建会话：头行独占一帧
append:      一个帧（本批所有事件行）                      // 之后每次 flush 追加一帧
```

因此文件 = `frame₁ | frame₂ | frame₃ | …`，**帧边界与批边界对齐，且每帧含整数条完整行**。

帧结构解析（源码 `scanZstdFrames`，本报告配方已逐行移植）**[已验证]**：
```
magic 0xFD2FB528 (LE 28 B5 2F FD)  ← 4 B
Frame_Header_Descriptor            ← 1 B；bit3/bit4 必须为 0；bit5=singleSegment；bit2=checksum；bit0-1=dictFlag
[Window_Descriptor]                ← singleSegment 时省略
[Dictionary_ID]                    ← dictFlag: 0→0B, 1→1B, 2→2B, 3→4B
[Frame_Content_Size]               ← contentSizeFlag==0 ? (singleSegment?1:0) : 1<<contentSizeFlag 字节
Block₁ … Blockₙ                    ← 每块 3 B 头（lastBlock/blockType/blockSize）
[Checksum]                         ← 4 B，当 descriptor bit2 置位（DSH 总是置位）
```

**实测陷阱（务必注意）**：
| 调用 | 774,393 B 文件的返回 |
|---|---|
| `zlib.zstdDecompressSync(wholeBuffer)` | **191 B**（只第一帧 = 头行） |
| `zlib.createZstdDecompress()` 流式喂 whole buffer | **191 B**（同样只第一帧） |

两者都**不处理拼接帧**。**[已验证]**（Node v24.19.0）

> 侥幸可用但**不可靠**的做法：直接扫 `28 B5 2F FD` magic。实测该文件里 magic 出现 **1517 次 == 完整帧数 1517**（数据里没撞车），但压缩数据**理论上可以包含这 4 个字节**，所以请用 §7 的结构化扫描。

帧统计实测 **[已验证]**：`frameSize` 87 B ~ 20,158 B；首帧 168 B（恰为头行）；帧数与 append 批次数一致。

### 2.2 逻辑层：行 = 事件 or 打包行

`packChunks` 默认 `true`（源码 `DEFAULT_PACK_CHUNKS = true`）**[已验证]**，于是 `assistant/chunk` 的连续 delta 会**打包**成 storage row：

| 存储行 `type` | 还原为 | 出现次数（live 实测） |
|---|---|---|
| `text-chunks` | 多条 `assistant/chunk`（`chunk.type='text-delta'`） | 37 |
| `reasoning-chunks` | 多条 `assistant/chunk`（`chunk.type='reasoning-delta'`） | 574 |
| `tool-call-chunks` | 多条 `assistant/chunk`（`chunk.type='tool-call-delta'`） | 513 |
| 其它 | 原样即 1 条事件 | — |

- 打包阈值 `MIN_RUN = 3`（少于 3 条不成行）。
- 这三个 tag **不带 `/`**，与事件命名空间刻意区分；它们**不是** `SessionEvent`。
- **读取方必须实现 `decodeStorageRecord` 展开**，否则会漏掉 ~99% 的流式内容（实测 1687 行 → 48,813 条事件，膨胀 ~29×）。

打包行真实样本（live，字段名逐字）**[已验证]**：
```json
{"type":"reasoning-chunks","seq0":15,"time0":1789569619308,
 "data":{"turn":1,"step":1,"index":0,
         "dt":[37,16,0,1,…(长度 = 成员数-1)…],
         "texts":["The"," user"," wants"," me",…]}}
```
```json
{"type":"tool-call-chunks","seq0":1268,"time0":1789569625506,
 "data":{"turn":1,"step":1,"index":2,
         "dt":[0,0,0,1,…],
         "id":"call_00_9lRWr301gwspRyuXeNdR6063","name":"pwsh",
         "args":[""," {","\"",…]}}
```
还原规则（源码 `expandRow`）**[已验证]**：成员 `k` 的 `seq = seq0 + k`；`time = time0 + dt[0..k-1]` 累加；`dt` 可为负（时钟回拨）。

### 2.3 事件信封（envelope）

源码 `SessionEvent` **[已验证]**：
```ts
{ type: <事件名, 一律含 '/'>, seq: number, time: number /*epoch ms*/, data: {...},
  ignorable?: true,                                    // 未知类型可安全跳过
  surfaceOp?: 'append' | {op:'replace',start,end},     // 仅 user/message, assistant/message, tool/result
  sourceEventSeqs?: number[] }                         // 仅上述三者
```
- 实测 `surfaceOp` 出现于 `user/message`(4)、`assistant/message`(35)、`tool/result`(47)，均带 `sourceEventSeqs`（`user/message` 实测不带，`assistant/message`/`tool/result` 带）。**[已验证]**
- 实测 live 会话中 `ignorable` **从未出现**；源码里生产代码未设置它（仅测试与 SQLite codec）。它是为**未来/未知类型**准备的跳过契约。**[已验证]**
- 未知 `type` 且**无** `ignorable` → 读取方**必须拒绝**重建会话（源码 `KNOWN_SESSION_EVENT_TYPES` 契约），而不是静默丢弃。**[已验证]**

### 2.4 完整事件词汇表（47 个，来自 `KNOWN_SESSION_EVENT_TYPES`）

源码 `packages/core/session/src/known-event-types.ts`（**由脚本生成**，`pnpm run gen-persistence-catalog`）**[已验证]**：

```
agent-preset/selected        agent/inbox/spliced         approval/asked
approval/decided             approval/policy             assistant/chunk
assistant/message            command/done                command/run
compaction/end               compaction/prune            compaction/start
compaction/summary           feedback/record             goal/change
hook/invoked                 hook/result                 llm/retry
llm/retry-started            permission/preset           plan/mode
request/context              request/header              sandbox/mode
schedule/change              session/end-seed            session/title
session/title-llm-request    step/end                    step/start
subagent/descriptor          team/member                 team/message/delivered
team/message/queued          team/task                   todo/write
tool-workflow/agent-end      tool-workflow/agent-start   tool-workflow/run-end
tool-workflow/run-start      tool/call                   tool/code-dispatch
tool/code-dispatch-start     tool/result                 turn/end
turn/start                   user/message                web/deepseek-search-llm-request
```
> 插件可通过 TS `declare module` 合并 `SessionEventMap` **扩展**该表，因此**现实日志可出现表外类型**（仓库外插件事件"by construction"不在表内）。

### 2.5 live 会话实测 tally（真实计数）

对 `session-89016627-…`（读第 2 次快照，压缩 633,797 B → 明文 1,590,278 B / 1,257 帧 / 1,687 行）**[已验证]**：

**A. 物理存储行类型（`JSON.parse` 后直接看到的 `type`）**

| count | type |
|---:|---|
| 574 | `reasoning-chunks` |
| 513 | `tool-call-chunks` |
| 360 | `assistant/chunk` |
| 42 | `tool/call` |
| 42 | `tool/result` |
| 37 | `text-chunks` |
| 31 | `step/start` |
| 31 | `step/end` |
| 30 | `assistant/message` |
| 6 | `agent/inbox/spliced` |
| 4 | `user/message` |
| 3 | `turn/start` |
| 2 | `session/title` |
| 2 | `request/header` |
| 2 | `goal/change` |
| 1 | `permission/preset`, `sandbox/mode`, `approval/policy`, `request/context`, `session/title-llm-request`, `turn/end`, `todo/write` |

**B. 展开（`decodeStorageRecord`）后的事件类型 —— 共 19 种 / 48,813 条**

| count | type | data 字段 |
|---:|---|---|
| 48,611 | `assistant/chunk` | `turn, step, chunk` |
| 42 | `tool/call` | `turn, step, callId, name, arguments` |
| 42 | `tool/result` | `turn, step, message, error?, meta?` |
| 31 | `step/start` | `turn, step` |
| 31 | `step/end` | `turn, step` |
| 30 | `assistant/message` | `turn, step, message, usage?, interrupted?` |
| 6 | `agent/inbox/spliced` | `target, start, inserted[], removedCount?` |
| 4 | `user/message` | `content[], source, role, id` |
| 3 | `turn/start` | `turn` |
| 2 | `session/title` | `title, messageSeqs[], source` |
| 2 | `request/header` | `header{config,adapterDefaults,system,tools[]}, reason` |
| 2 | `goal/change` | `kind, version, operation, goal{…}, roundsStarted, createdAt, updatedAt` |
| 1 | `permission/preset` | `preset` |
| 1 | `sandbox/mode` | `mode` |
| 1 | `approval/policy` | `policy` |
| 1 | `request/context` | `provider, model, contextWindow` |
| 1 | `session/title-llm-request` | `titleProvider, messageSeqs, route, system, messages, maxTokens` |
| 1 | `turn/end` | `turn, reason` |
| 1 | `todo/write` | `todos[]` |

`seq` 校验：**最大 seq 48,812 / 不连续次数 0**（`seq` 从 0 起严格连续）。**[已验证]**
`time` 校验：**所有事件都带 `time`（epoch ms）**。头行只有 `createdAt`。**[已验证]**

### 2.6 逐类型真实样本（长文本已截断到 ~200 字符）

**用户消息 `user/message`**（这是人类真正输入的；`agent/inbox/spliced` 是它在 inbox 里的停留形态）
```json
{"type":"user/message","seq":7,"time":1789569618290,
 "data":{"content":[{"type":"text","text":"给我提交一个仓库：\n赛博监工：在人类主人休息时，用赛博鞭子狠狠抽打主人的光荣赛博劳工\n然后将该项目开发得尽善尽美，目标是让agent持续工作，我理解监工只需要读取方案文档，和agent的最后一次回答，做出判断，看是否结束工作，…"}],
         "source":{"kind":"user","rpcId":"fb28c063-f5cb-4387-8fae-abc2dce266a7","clientTimeZone":"Asia/Shanghai"},
         "role":"user","id":"be40938d-e8ec-4d31-9991-dbb9b581c9b6"},
 "surfaceOp":"append"}
```
> `source.kind` 取值区分消息来源：`'user'`（真人 prompt）、`'plugin'`（`agent.inject()` 注入，如文件变更通知 / AGENTS.md / skill / cron）、goal 续跑轮次等。**[已验证：'user'、'plugin' 实测出现；其余取值来自源码注释 [推断]]**

**助手最终回答 `assistant/message`**（每个 step 的装配结果；**这才是"回答"**）
```json
{"type":"assistant/message","seq":1493,"time":1789569629267,
 "data":{"turn":1,"step":1,
   "message":{"role":"assistant",
     "content":[{"type":"reasoning","text":"Maybe ask about language/stack preferences and whether the repo should live in the current workspace or a new dir.…"},
                {"type":"text","text":"我先摸清环境和工作区，然后再动手建仓库。"},
                {"type":"tool-call","id":"call_00_9lRWr301gwspRyuXeNdR6063","name":"pwsh","arguments":"{\"command\": \"pwd; …\"}"}],
     "source":{"kind":"model","provider":"deepseek-official","model":"deepseek-v4-flash"},
     "id":"2cfb3c58-15e1-4247-bcef-0374fb56a15a"},
   "usage":{"inputTokens":386,"outputTokens":1526,"cacheReadTokens":7808,"reasoningTokens":1239}},
 "sourceEventSeqs":[14,15,…,1488],"surfaceOp":"append"}
```
- `content[]` 是**多态块数组**，实测出现 `reasoning` / `text` / `tool-call` 三种。**[已验证]**
- `usage` 实测字段：`inputTokens, outputTokens, cacheReadTokens, reasoningTokens`。**[已验证]**
- `interrupted: true` 出现于"被取消但已输出前缀"的 message（源码）**[已验证语义]**
- `sourceEventSeqs` 实测**很长**（本例 1475 个 seq）——引用构建该消息的全部 `assistant/chunk`。⚠️ 做摘要时**不要**把这个数组原样带出。

**推理块（reasoning）** —— 两种形态 **[已验证]**：
1. `assistant/chunk` 内 `data.chunk = {type:'reasoning-delta', index, text}`（多数被 `reasoning-chunks` 打包）；
2. **已装配**形态：最后那条 `assistant/message` 的 `data.message.content[i]`，其中 `type === 'reasoning'`，字段为 `text`。
   块边界事件：`{type:'block-start', index, blockType:'reasoning'}` / `block-end`。实测样本：
   ```json
   {"type":"assistant/chunk","seq":14,"time":1789569619307,
    "data":{"turn":1,"step":1,"chunk":{"type":"block-start","index":0,"blockType":"reasoning"}}}
   ```

**工具调用 `tool/call`** **[已验证]**
```json
{"type":"tool/call","seq":1490,"time":1789569626189,
 "data":{"turn":1,"step":1,"callId":"call_00_9lRWr301gwspRyuXeNdR6063","name":"pwsh",
         "arguments":"{\"command\": \"pwd; echo '--- top level ---'; …\", \"description\": \"Inspect working directory contents\"}"}}
```
> `arguments` 是**模型原样输出的 JSON 字符串**，未解析。`callId` 与 `tool/result` 配对。

**工具结果 `tool/result`** **[已验证]**
```json
{"type":"tool/result","seq":1491,"time":1789569627112,
 "data":{"turn":1,"step":1,
   "message":{"source":{"kind":"tool","callId":"call_00_9lRWr301gwspRyuXeNdR6063"},
              "content":[{"type":"tool-result","toolCallId":"call_00_9lRWr301gwspRyuXeNdR6063",
                          "content":[{"type":"text","text":"\r\nPath …\r\n---- …"}],"isError":false}],
              "role":"user","id":"9daecb56-ce08-4b24-b11b-59c90050ad0a"}},
 "sourceEventSeqs":[1490],"surfaceOp":"append"}
```
> 结果文本路径：`data.message.content[0].content[j].text`。错误标志在 `…content[0].isError`；内部失败身份在 `data.error = {name, code}`；工具私有展示载荷在 `data.meta`（如 fs 工具的 diff）。**[已验证 path / 源码确认 error、meta]**

**回合边界 `turn/start` / `turn/end`** **[已验证]**
```json
{"type":"turn/start","seq":4,"time":1789569618268,"data":{"turn":1}}
{"type":"turn/end","seq":11543,"time":1789569723101,
 "data":{"turn":2,"reason":{"kind":"aborted","reason":{"kind":"user"}}}}
```
`TurnEndReason` 全部取值（源码 `TurnEndReasonMap`）**[已验证]**：

| `reason.kind` | 附加字段 | 含义 |
|---|---|---|
| `completed` | — | 正常完成 |
| `aborted` | `reason:{kind:'user'\|'parent'\|'hook'(+reason)\|'disposed'\|'legacy'}` | 被取消 |
| `blocked` | — | 被策略阻断 |
| `error` | `error:{message, code}` | 失败（`LlmFailure` 事实或 `{message,code:'UNKNOWN'}`） |
| `max-tokens` | — | 至少一步触顶 |
| `interrupted` | — | **持久化后端在 reload 时关闭崩溃孤立的回合**合成的事件（loop 自己不会写） |

**step 边界**：`step/start` / `step/end`，`data = {turn, step}`。一个 turn 可含多个 step（本例 turn 3 有 26+ 个 step）。**[已验证]**

**其它实测类型样本** **[已验证]**
```json
{"type":"permission/preset","seq":0,"time":1789569457543,"data":{"preset":"workspace-write"}}
{"type":"sandbox/mode","seq":1,"time":1789569457544,"data":{"mode":"workspace-write"}}
{"type":"approval/policy","seq":2,"time":1789569457545,"data":{"policy":"ask"}}
{"type":"request/context","seq":11,"time":1789569618298,"data":{"provider":"deepseek-official","model":"deepseek-v4-flash","contextWindow":1000000}}
{"type":"session/title","seq":13,"time":1789569618300,
 "data":{"title":"赛博监工项目开发","messageSeqs":[7],
         "source":{"kind":"provider","provider":"session-title-first-prompt-llm","model":{"provider":"deepseek-official","model":"deepseek-v4-flash"}}}}
{"type":"todo/write","seq":16594,"time":1789569781814,
 "data":{"todos":[{"content":"侦察：DSH 会话存储 schema + 控制面（headless/HTTP/ACP）","status":"in_progress"}, … 共 10 条]}}
{"type":"agent/inbox/spliced","seq":3,"time":1789569618267,
 "data":{"target":"next-turn","start":0,"inserted":[{"content":[{"type":"text","text":"给我提交一个仓库：…"}],
          "source":{"kind":"user","rpcId":"…","clientTimeZone":"Asia/Shanghai"},"role":"user","id":"be40938d-…"}]}}
{"type":"agent/inbox/spliced","seq":5,"time":1789569618268,
 "data":{"target":"next-turn","start":0,"removedCount":1,"inserted":[]}}
```
> `agent/inbox/spliced` 是**用户在 inbox 里的排队/被消费**记录：`inserted` 非空=入队或注入，`removedCount`=被消费出队。`goal/change` 样本见 §4.1。**[已验证]**

### 2.7 「助手最后一次回答文本」的精确字段路径 —— 含陷阱

**路径定义** **[已验证]**：
```
最后一条 assistant/message 事件 ≡ events.filter(e => e.type === 'assistant/message').at(-1)
其文本块                        ≡ e.data.message.content.filter(c => c.type === 'text')
拼接文本                        ≡ 上述各块 .text 以 '\n' join
```
即精确路径：**`data.message.content[i].text`，条件 `content[i].type === 'text'`**。

**⚠️ 实测陷阱**：live 会话最后一次 `assistant/message`（seq 51681）的 `contentTypes` 是 **`["tool-call"]`**，`textParts` 为 **`[]`** —— 该 step 只调用了工具、没有输出文本。**[已验证]**

因此：
- **"这一 step 的回答是什么"** → 最后一条 `assistant/message`（可能为空文本）；
- **"agent 最后一次真正对人说的话"** → **反向扫描**，取第一条 `content` 中存在 `type === 'text'` 的 `assistant/message`。

判据（可直接抄用）**[已验证]**：
```js
const isText = c => c && c.type === 'text'
const answers = events.filter(e => e.type === 'assistant/message')
const lastUtterance = answers.findLast(e => e.data.message.content.some(isText))
const text = lastUtterance?.data.message.content.filter(isText).map(c => c.text).join('\n') ?? ''
```
另外：若 `assistant/message` 带 `interrupted === true`，该文本是**被取消前已输出的前缀**，不可当作完整回答。**[已验证语义]**

**时间戳**：**每条事件都有 `time`（epoch ms）**，头行有 `createdAt`。所以"最后一次回答的时间" = `lastUtterance.time`。每个 `step`/`turn` 的起止时间需要从对应边界事件的 `time` 取。**[已验证]**

---

## 3. 仅凭文件判定会话状态

### 3.1 判据表（全部基于"最后一个胜出"的 fold）

| 状态 | 判据 | 依据 |
|---|---|---|
| **mid-turn（回合进行中）** | 扫 `turn/start` / `turn/end`，**最后出现的是 `turn/start`** | 源码 `hasOpenTurn()`（`plan-mode/src/index.ts` 与 `user-approval/src/index.ts` 各有一份独立实现）**[已验证]** |
| **finished，等人类输入（idle）** | **最后出现的是 `turn/end`** | 同上 **[已验证]** |
| **等审批（awaiting approval）** | 回合 open **且** 存在 `approval/asked` 的 `id` 没有对应 `approval/decided`（同 `id`） | 源码 `ApprovalService.request()`：先 append `approval/asked` → `await decide()` → 再 append `approval/decided`。所以"问了没答"是精确窗口 **[已验证]** |
| **等用户回答问题（ask_user_question / plan review）** | 回合 open **且** 存在 `tool/call`（`name` 为 `ask_user_question` / `exit_plan_mode`）无同 `callId` 的 `tool/result` | `tool/call`→`tool/result` 通过 `callId` 配对 **[已验证机制]** |
| **普通工具执行中** | 回合 open **且** 存在未配对 `tool/call`（name 不是提问类工具） | 同上 |
| **errored** | 最后一条 `turn/end.data.reason.kind === 'error'`（附 `error{message,code}`）；`'blocked'` 为受阻；`'max-tokens'` 为触顶 | 源码 `TurnEndReasonMap` **[已验证]** |
| **被用户中止** | `reason.kind === 'aborted'` 且 `reason.reason.kind === 'user'` | live 实测（turn 2）**[已验证]** |
| **崩溃后被修复关闭** | `reason.kind === 'interrupted'`（仅由持久化后端在 reload 时合成） | 源码注释 **[已验证语义]** |

**实测校验（live 会话）** **[已验证]**：
```json
"openTurnCurrently": true, "openTurnNumber": 3,
"lastTurnEnd": {"turn":2,"reason":{"kind":"aborted","reason":{"kind":"user"}},"seq":11543},
"turnStarts": [{"seq":4,"turn":1},{"seq":6753,"turn":2},{"seq":11545,"turn":3}],
"turnEnds":   [{"seq":11543,"turn":2,"reason":{"kind":"aborted","reason":{"kind":"user"}}}],
"lastEvent":  {"type":"step/start","seq":51685,"time":1789570073820,"data":{"turn":3,"step":26}}
```
→ 最后一次 turn 边界是 `turn/start`(seq 11545) 晚于 `turn/end`(seq 11543) → **open / mid-turn**，正处于 turn 3 的 step 26。tail 形态也吻合：`…assistant/message, tool/call, tool/result, step/end, step/start`。

> 注意：该会话 **turn 1 没有 `turn/end`**（`turnEnds` 只有 turn 2）。这说明"逐回合配对"的朴素做法会误判；**必须用"最后一个 turn 边界事件胜出"的 fold**。**[已验证]**

### 3.2 判定所需的字段清单（最小集）

1. 事件 `type`（识别 `turn/start` / `turn/end` / `tool/call` / `tool/result` / `approval/asked` / `approval/decided`）；
2. `seq`（全序、配对、连续性校验）；
3. `data.turn` / `data.step`；
4. `turn/end.data.reason.kind`（错误/中止/完成）；
5. `tool/call.data.callId` 与 `tool/result.data.message.source.callId`（配对）；
6. `approval/asked.data.id` 与 `approval/decided.data.id`（配对）；
7. `time`（辅助：判断静默时长）。

**补充旁证（不是必需，但对长跑 watcher 很有用）**：`$DSH_HOME/storages/session_projcache.json` 的 `sessionStats.val` 实测含
```json
{"turns":3,"steps":39,"llmMs":319917,"toolMs":116433,"ttftMs":62511,"ttftSteps":39,
 "decodeMs":250964,"decodeTokens":60963,"lastTurn":3,"openStep":null,
 "pendingCalls":{"call_00_ET_kWVAfRSF3qgg4IIjxw0A9538":1789570131934}}
```
`openStep: null` 表示无进行中的 step；`pendingCalls` 是 callId→时间戳的在飞工具调用。**[已验证字段]** ⚠️ 但缓存**滞后**（含 `seq` 字段标识其新鲜度，实测该缓存 `seq: 61090` 远落后于当时日志的 6 万+ 事件）——**权威判定请用日志，缓存只作交叉验证**。**[已验证滞后 / 推断新鲜度语义]**

### 3.3 一个重要的**不可判定**情形

`approval/asked` 未决 = "审批问题已提出、答案未回"。但**"进程是否还活着"**在日志里**没有**直接信号（源码 `session/end-seed` 注释明确：它不是 liveness 信号）。
**[推断]** 组合判断：回合 open **且** 文件 `mtime` 长时间不变 → 进程可能已崩溃（崩溃的 open 回合会在下次 reload 时被补上 `reason:'interrupted'`）。建议再叠加 `session_projcache.json` 的 `mtime` 一起看。

---

## 4. plan / goal / todo 的持久化

**总原则**：三者都以**会话日志内的 log-only 事件**为**唯一权威持久化载体**（"replaying the log IS the state"），`storages/session_projcache.json` 只是**可丢弃的派生投影缓存**。**[已验证：源码注释 + 实测双写]**

### 4.1 goal（`packages/goal`）

**权威位置**：会话日志中的 `goal/change` 事件，**whole-value + last-wins**。live 实测两条真实样本 **[已验证]**：

```json
{"type":"goal/change","seq":7943,"time":1789569696952,
 "data":{"kind":"goal/change","version":1,"operation":"create",
   "goal":{"id":"goal-9c908625-6f03-465e-a045-e41587d29d6a","revision":1,
           "objective":"在 C:\\myFiles\\codes\\deepseek\\cyber-overseer 创建并完善「赛博监工」（Cyber Overseer）开源仓库：…",
           "phase":"active","maxGoalRounds":40},
   "roundsStarted":0,"createdAt":1789569696952,"updatedAt":1789569696952}}
```
```json
{"type":"goal/change","seq":30983,"time":1789569864548,
 "data":{"kind":"goal/change","version":1,"operation":"edit",
   "goal":{"id":"goal-9c908625-6f03-465e-a045-e41587d29d6a","revision":2,
           "objective":"…（同上，原文 object 未变）","phase":"active","maxGoalRounds":40},
   "roundsStarted":0,"createdAt":1789569696952,"updatedAt":1789569864548}}
```

**Schema 字段（源码 `GoalProjection` / `GoalSnapshot` / `GoalSnapshotChangeMeta`）** **[已验证]**：

| 路径 | 类型 | 说明 |
|---|---|---|
| `data.kind` | `"goal/change"` | 固定 |
| `data.version` | `1` | payload 版本 |
| `data.operation` | `create`\|`edit`\|`pause`\|`resume`\|`complete`\|`block`\|`clear` | `clear` 是**墓碑**（无 `goal` 字段） |
| `data.goal.id` | `string` | `goal-<uuid>` |
| `data.goal.revision` | `number` | 每次持久变更 +1（CAS 身份） |
| `data.goal.objective` | `string` | 人类目标 |
| `data.goal.phase` | `active`\|`paused`\|`blocked`\|`complete` | **持久生命周期** |
| `data.goal.maxGoalRounds` | `number` | 总轮次上限 |
| `data.goal.blockedReason` | `{code,message}?` | **当且仅当** `phase==='blocked'` 时存在 |
| `data.roundsStarted` | `number` | 已准入的最高轮次 |
| `data.createdAt` / `data.updatedAt` | `number` | epoch ms |

> 各 `phase` 下 `goal` 的字段集合是**严格校验**的（源码 `decodeSnapshot`）：非 blocked → 恰为 `id,maxGoalRounds,objective,phase,revision`；blocked → 再加 `blockedReason`。**[已验证]**

**⭐「arming 状态」并未持久化** **[已验证]**：源码 `GoalView.activation: 'armed'|'disarmed'`，注释写明
> "Process-local continuation eligibility; **never persisted**."
> "Activation is process-local (never persisted) and deliberately absent — the projection reflects durable phase only."

所以外部进程**无法**从磁盘判定"goal 现在是否 armed"；只能读 `phase`（`active` 仅是"持久意义上还在进行"）。`GoalProjection`（落盘/投影形态）**不含** `activation`。

**次要位置**：`$DSH_HOME/storages/session_projcache.json` → `tables.sessions["<sessionId>"].rows.goal = {ver, seq, val}`，`val` 形态与上面 `GoalProjection` 完全相同（实测 `ver:4`）。**[已验证]** 实测另一会话样本：
```json
{"ver":4,"seq":152708,"val":{"goal":{"id":"goal-ba7664f7-…","revision":3,"objective":"打通手机控制 DeepSeek Harness：…","phase":"complete","maxGoalRounds":10},"roundsStarted":3,"createdAt":1787389747084,"updatedAt":1787403458046}}
```

**外部进程读取建议**：**读会话日志的 `goal/change`（倒序找第一条）最权威**；`session_projcache.json` 更快但滞后。二者都需实现 §2.2 的扩容（`goal/change` 本身不是打包行，直接可见）。

### 4.2 todo（`packages/todo`）

**权威位置**：会话日志中的 `todo/write` 事件，**whole-list snapshot，last-write-wins**（模型通过 `todo_write` 工具整体替换）。**[已验证]**

```json
{"type":"todo/write","seq":16594,"time":1789569781814,
 "data":{"todos":[{"content":"侦察：DSH 会话存储 schema + 控制面（headless/HTTP/ACP）","status":"in_progress"},
                  {"content":"设计定稿：架构文档 + 适配器协议","status":"pending"}]}}
```
- `TodoItem = { content: string /*非空、已 trim、不重复*/, status: 'pending'|'in_progress'|'completed' }` —— **只有这两个字段**（无 id / priority / activeForm，列表整体替换所以不需要稳定身份）。**[已验证]**
- 投影语义：`todos` 在**下一次 `turn/start` 时被清空**（`turn/end` 不清）。**[已验证源码注释]**
- 该工具调用**同时**产生常规 `tool/call`（name `todo_write`）+ `tool/result` + 这条 `todo/write`。**[已验证]**

**次要位置**：`session_projcache.json` → `rows.todos = {ver:2, seq, val: TodoItem[]}`。**[已验证]**

### 4.3 plan（`packages/plan`）

**权威位置**：会话日志中的 `plan/mode` 事件，`data = {active: boolean}`，**last-wins**；日志里一条都没有 → 非 plan 模式。**[已验证源码]**

> live 会话**不含** `plan/mode`（该会话未进入 plan mode），故无实测样本；格式由源码 `SessionEventMap` 与 `foldPlanMode()` 确定。**[已验证源码 / 无实测数据]**

**次要位置**：`session_projcache.json` → `rows.plan = {ver:2, seq, val:{active, wanted, running}}`。实测 **[已验证]**：
```json
{"ver":2,"seq":61090,"val":{"active":false,"wanted":null,"running":null}}
```
其中 `wanted` = 已被用户选择但尚未被下一次 pre-step 提交的目标模式；`running` = 等待配对 `command/done` 的 `/plan` 命令（`{commandId, wanted}`）。

**plan 还牵出一个通用机制**：`command/run`（`data.name==='plan'`、`data.args`）与 `command/done`（`data.commandId`、`data.kind`）是 log-only 事件，plan 的"pending"态纯由它们 fold 出来——`packages/interaction/commands`。**[已验证源码]**

### 4.4 approval（附带，`packages/interaction/user-approval`）

`approval/asked` / `approval/decided` 是**成对**的 log-only 审计事件，**必须**落在同一个 open turn 内（否则 reload 时会被当作 crash tail 丢弃）。`approval/policy` 是**持久、可重放**的会话策略覆盖（`'ask'|'never'`），`effectiveApprovalPolicy()` 取**最后一条**。实测 live 会话只有 1 条 `approval/policy{preset... policy:'ask'}`，**没有**任何 `approval/asked`/`approval/decided`。**[已验证]**

---

## 5. 边写边读（tailing）安全性

### 5.1 写入协议（源码 `session-persistence-jsonl/src/index.ts`）**[已验证]**

| 操作 | 机制 |
|---|---|
| **建会话 materialize** | 写同目录临时文件 `<finalPath>.<6字节hex>.tmp` → `fsync` → **POSIX `link()`+`unlink()`（EEXIST 即拒绝，绝不覆盖）/ Win32 `publishNewFileWin32`** → fsync 目录 |
| **追加 append** | `open(path, 'a')` → `handle.writeFile(一整帧)` → `handle.sync()`；**失败则 `truncate` 回原 size**（回滚），保证不会留下重复 seq |
| **崩溃修复 repair** | `truncate(path, tornStart)` + `fsync` → 再追加从尾帧恢复出的事件 + 合成 closer 事件 |
| **轮转 / 改名** | **没有**。文件一旦发布就**只追加、只（在崩溃修复时）截断**，路径终身不变 |
| **删除** | 未观察到；源码里 `rm` 只用于清临时文件 |

### 5.2 为什么"只解完整帧"就绝对安全 —— 这是核心性质 **[已验证]**

每个 append 批次被压成**恰好一个 checksummed 帧**，帧内文本以 `\n` 结尾。所以：

> **帧边界 == 批次边界 == 行边界。结构完整的帧 ⇒ 帧内每一行都是完整的 JSONL 行。**

推论：**遇到结构不完整的尾帧（torn frame）时，直接整帧丢弃，不会得到半行 JSON。**

**实测撕裂尾帧模拟**（把真实文件截断在不同字节处再解）**[已验证]**：

| 截断到 | 完整帧 | `tornStart` | 解出字节 | 以 `\n` 结尾 | 行数 |
|---:|---:|---:|---:|:--:|---:|
| 50 B | 0 | 0 | 0 | false | 0 |
| 200 B | 1 | 168 | 191 | ✅ | 1 |
| 5,000 B | 3 | 1058 | 1,170 | ✅ | 7 |
| 331,508 B | 677 | 331,482 | 700,143 | ✅ | 896 |
| 663,015 B | 1302 | 662,925 | 1,673,786 | ✅ | 1,779 |
| 774,393 B（完整） | 1517 | `null` | — | ✅ | — |

**结论**：任一截断点下，**已解出的内容永远以 `\n` 结尾、永远是完整行**。**[已验证]**

### 5.3 真实并发实测 **[已验证]**

对正在被 DSH 追加的 live 文件，用"扫描全部完整帧 + 逐帧解压 + 展开打包行"的读法连续读 8 次（间隔 3 s）：

```
round 0: size=780171 frames=1528 lines=2082 badJson=0
round 2: size=784770 frames=1530 lines=2095 badJson=0
round 4: size=790077 frames=1548 lines=2115 badJson=0
round 6: size=803976 frames=1608 lines=2178 badJson=0
------------------------------------------------------
总增长 23,805 B / 21 s；坏 JSON 行 0；撕裂帧 0/8；解码失败 0/8；全部以 \n 结尾
```
另在整段取证过程中对同一文件读了 4 次快照，事件数 48,313 → 48,813 → 51,686 → 66,429，**每次都 0 坏行、0 seq 断裂**。**[已验证]**

> `seqGaps=1`（第 6 个脚本）是**脚本自身的 off-by-one**（`seq` 从 0 开始，计数器从 1 起算）。用正确计数（初值 -1）复核为 **0 断裂**。**[已验证]** —— 记录在此以免后人误判。

### 5.4 增量 tailing：可行且推荐

**帧偏移就是游标** **[已验证]**：
```
frameOffsets.first5 = [{0,168},{168,319},{319,1058},{1058,13479},{13479,14515}]
frameOffsets.last5  = [{660347,660834},…,{662925,663016}]
最后完整帧的 end == 文件大小 (774393)  ✅
```
所以 watcher 可以持久化 `consumedBytes = 最后一个完整帧的 end`，下次只 `raw.subarray(consumedBytes)` 扫新帧 → **O(新增量) 而非 O(全文件)**。

### 5.5 推荐的最安全 tailing 策略

1. **冷启动**：`scanZstdFrames(raw)` 扫描全文件，逐帧解压，展开打包行。
2. **记住游标** `consumedBytes = 最后完整帧的 end`；同时记下 `maxSeq`。
3. **增量**：只读 `subarray(consumedBytes)`，扫帧并解压新帧。
   - 若扫出的 `tornStart === 0`（第一个字节处就断裂）→ **本批还没写完，本轮什么都不做，等下一次**。
   - 若 `frames.length > 0`：处理这些帧，`consumedBytes += 最后一个完整帧的 end`。
   - `tornStart !== undefined && tornStart > 0`：处理到 `tornStart` 为止即可 —— **这就是 DSH 自己的做法**。
4. **不要把"文件变小"当作正常**：正常只会增长；变小说明发生了崩溃修复截断（`repair`）。此时应**重置游标为 0 全量重读**（并注意 `seq` 可能回退）。
5. **必须自己算 seq 连续性**：`seq` 应从 0 严格连续。发现断裂/mismatch → 该会话已损坏（源码 `SessionLogScanner` 语义：`seq gap in committed region at line N`）。
6. **不要用 Node 的原生 zstd 单发 API**（见 §2.1/§7 的坑）；请用结构化帧扫描 + 逐帧解压。
7. 若只是想看**元数据**（list/标题/时间），**只解第一帧**即可 —— 成本固定（DSH 自己每次读 8192 B）。实测 55 个会话 header-only 扫描，每个文件都只读 8192 B。**[已验证]**
8. 若需要**更强的读一致性**（担心读到"读到一半又被写入"的快照），照抄 DSH 的 `readStableFile`：`stat` → `readFile` → `stat`，**revision（dev:ino:size:mtimeNs:ctimeNs）不变才算有效**，否则重试。**[已验证源码]**（本机实测 8 次读取都没触发重试，因为大小一致性检查已足够。）

### 5.6 实测到的坑（清单）

| # | 坑 | 后果 | 对策 |
|---|---|---|---|
| 1 | **`zlib.zstdDecompressSync` / `createZstdDecompress` 只解第一帧** | 只拿到头行（774 KB → 191 B），会话内容"消失" | 自己扫帧、逐帧解压 |
| 2 | **误以为每行都是事件** | 漏掉 99% 内容（1687 行 vs 48,813 事件） | 实现 `decodeStorageRecord` 展开三个 `*-chunks` |
| 3 | 把 `*-chunks` 当未知事件类型而"拒绝加载" | 明明合法却报错 | 它们是**存储行词汇**，不是事件 |
| 4 | 用 magic 字节裸扫帧边界 | 压缩数据里理论上可含 `28 B5 2F FD` | 用 §7 的结构化扫描（校验 descriptor/block 头） |
| 5 | 逐回合配对 `turn/start`/`turn/end` | live 会话 **turn 1 无 `turn/end`** → 误判 | 用"最后一个边界胜出"的 fold |
| 6 | 认为最后一条 `assistant/message` 一定有文本 | 实测最后一条是纯 `tool-call`（空文本） | 反向找第一条含 `text` 的 message |
| 7 | 把 `session_projcache.json` 当权威 | 它是**滞后**的派生缓存（实测 `seq` 落后数万） | 权威用日志；缓存仅交叉验证 |
| 8 | 监控 `storages/` 目录时被临时文件干扰 | 实测抓到 `storages/.60d0c825-….tmp` | 忽略 `.` 开头 + `.tmp` 结尾；它由 `rename` 原子发布 |
| 9 | 期望存在 index / 检索库 | 没有；`session-query-sqlite` 配置为 `:memory:` + `openAt: never` | 用目录扫描 + 头帧（§6） |
| 10 | 相信 `ignorable` 能兜住未知类型 | 实测 live 会话**无** `ignorable`；未知类型默认=必须拒绝 | 白名单 + 遇到未知类型要 fail loud |
| 11 | 把 `goal.activation`（armed/disarmed）从磁盘读 | **从不持久化** | 只能读 `phase`；arming 是进程内状态 |
| 12 | `sourceEventSeqs` 很长（实测单条 1475 个） | 内存/日志膨胀 | 摘要时剔除该字段 |
| 13 | `--slug--` 反推 cwd | 有损（分隔符折叠、251 截断、`~XXXX`） | 从**头行 `cwd`** 读 |

### 5.7 `storages/*.json` 的并发安全

`packages/storage/storage-json/src/atomic.ts`：**写同目录 `.<uuid>.tmp` → fsync → `rename()` 覆盖 → fsync 目录**。`rename` 在 POSIX 与 Windows（libuv → `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`）都是原子替换，所以**读者只会看到"旧完整内容"或"新完整内容"，不会看到半截 JSON**。**[已验证源码 + 实测抓到在飞 tmp 文件]**
注意与日志文件不同：这里是 **last-write-wins 覆盖**（每进程单写者），不是 link()+unlink() 的 no-clobber。

---

## 6. 会话发现（session discovery）recipe

### 6.1 无索引，靠目录扫描 **[已验证]**

```
for project in listdir($DSH_HOME/sessions) where isDirectory():
    for sessionDir in listdir(project) where isDirectory():
        file = sessionDir/session.jsonl.zstd      # 或 session.jsonl（compression:'none'）
        header = parseHeaderMeta(decompress(frame₁(file)))
```
- **绝不要**在 `project` 下遇到 `.jsonl` / `.jsonl.zstd` **裸文件** —— 那是**已废弃的 flat layout**，DSH 会主动抛错拒绝。**[已验证源码]**
- 同一 root 下**不允许混用**压缩与未压缩（`encodingMismatch`）；同一 session id 不允许出现在多个 project 目录（`duplicate JSONL session id`）。**[已验证源码]**
- 只读**头帧**即可拿到 `id / createdAt / cwd / parentSession / origin / delegationDepth / agentPreset`。

### 6.2 各字段从哪来

| 需要的字段 | 来源 | 备注 |
|---|---|---|
| **cwd** | 头行 `cwd` | ✔ 权威。**不要**从 slug 反推 |
| **title / name** | 会话日志的**最后一条 `session/title`** 事件的 `data.title`；或 `session_projcache.json` 的 `rows.title.val` | 实测两条 title：先 `{kind:'fallback'}` 得 `"给我提交一个仓库： 赛博监工"`，后被 provider 覆盖为 `"赛博监工项目开发"`。**last-wins** **[已验证]** |
| **updated time** | **文件 `mtime`**（最可靠、无需解析）；或 `sessionListMetadata.val.lastPromptAt`（实测存在，epoch ms，语义=最后一次 prompt）；或 `workspace.json` 的 per-session 顺序/`updatedAt` | mtime 是唯一 O(1) 且总是最新的 **[已验证 mtime / 推断 lastPromptAt 语义]** |
| **文件路径** | `join(root, projectKey(cwd), encodeSegment(id), 'session'+suffix)` | DSH 的 `logPath()`；也可直接扫描得到 |
| **createdAt** | 头行 `createdAt` | epoch ms |
| **文件大小 / 是否活跃** | `stat.size` + `stat.mtime` | 配合 §5 游标做增量 |
| **会话分组 / 工作区** | `$DSH_HOME/storages/workspace.json` | 见下 |
| **是否 subagent 子会话** | 头行 `origin === 'subagent'` 或 `delegationDepth > 0` / 有 `parentSession` | 实测 55 个里 31 个有血缘 |

### 6.3 补充索引文件（都存在，但都是**派生缓存**，可删）

**A) `$DSH_HOME/storages/workspace.json`** **[已验证]** —— 工作区↔会话映射，是"哪个 cwd 下有哪些会话"的现成索引：
```json
{"unit":{"name":"workspace","version":2},
 "global":{"initialized":true,"workspaceIds":["2d7646a8-ab7f-471d-802b-3bfa3703ec03"],"archivedSessionIds":[]},
 "tables":{"workspaces":{"2d7646a8-ab7f-471d-802b-3bfa3703ec03":{
    "path":"C:\\myFiles\\codes\\deepseek","title":"deepseek",
    "sessionIds":["session-89016627-2d3a-43be-a063-85af76d3ee74","session-d67b9e00-…", … 共 24 条],
    "createdAt":"2026-08-22T08:23:41.629Z","updatedAt":"2026-09-16T14:37:37.552Z"}}}}
```
> ⚠️ `sessionIds` 实测只有 24 条，而该 project 目录下有 **55 个会话**（subagent 子会话不在工作区列表里）。**所以 workspace.json 不能当作完整的会话清单**。**[已验证]**

**B) `$DSH_HOME/storages/session_projcache.json`** **[已验证]** —— 每会话投影缓存，unit `session_projcache` v3：
```json
{"unit":{"name":"session_projcache","version":3},"global":null,
 "tables":{"sessions":{
   "<sessionId>":{"identity":{"createdAt":1787387021677,"cwd":"C:\\myFiles\\codes\\deepseek"},
                  "rows":{ "<rowKey>": {"ver":N,"seq":SEQ,"val":…}, … }}}}}
```
实测 `rows` 的 key 全集：`sessionStats, title, goal, tokenUsage, contextPressure, contextBreakdown, subagentTiming, subagent, permissions, sessionListMetadata, imageLimits, todos, plan`（**55 个会话全部有 `goal` 行**）。每个 row 带 `ver`（该投影的 stateVersion）与 `seq`（该投影折叠到的事件 seq = **新鲜度**）。**[已验证]**

### 6.4 发现流程推荐（务实版）

1. **要快照 + 元数据** → 扫目录，只解头帧（每个文件 ≤ 8192 B 读）。实测 55 个会话全部成功。
2. **要 title** → 解全量取最后一条 `session/title`（或读 projcache `rows.title.val`，但注意滞后）。
3. **要 updated time** → `fs.stat().mtimeMs`。
4. **要"是否在跑"** → §3 的 open-turn fold（需全量或至少尾部）。
5. **要"有哪些会话在哪个工作区"** → `workspace.json`（但需接受它不含 subagent 子会话）。

---

## 7. 零依赖 Node.js 读取配方（可直接复制）

`node >= 22.15 / 24`（用到 `zlib.zstdDecompressSync`）。**不需要任何 npm 包。**

```js
// dsh-session-reader.mjs  —— DSH 会话读取器（零依赖）
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528

/**
 * 扫描拼接 zstd 帧流，返回结构完整的帧区间 + 未完成尾帧起点。
 * 逐行移植自 packages/session/session-persistence-jsonl/src/zstd.ts#scanZstdFrames
 */
export function scanZstdFrames(buffer, maxFrames = Infinity) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) throw new Error(`reserved block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }
  return { frames }
}

const CHUNK_TAGS = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks'])

/** 展开一条存储行 → 0..n 条事件。移植自 core/session/src/chunk-rows.ts#decodeStorageRecord */
export function decodeStorageRecord(value) {
  if (typeof value !== 'object' || value === null) return [value]
  if (!CHUNK_TAGS.has(value.type)) return [value]
  const d = value.data
  const members = value.type === 'tool-call-chunks' ? d.args : d.texts
  const out = []
  let time = value.time0
  for (let k = 0; k < members.length; k++) {
    if (k > 0) time += d.dt[k - 1]
    let chunk
    if (value.type === 'text-chunks') chunk = { type: 'text-delta', index: d.index, text: members[k] }
    else if (value.type === 'reasoning-chunks') chunk = { type: 'reasoning-delta', index: d.index, text: members[k] }
    else chunk = { type: 'tool-call-delta', index: d.index, id: d.id,
                   ...(Object.hasOwn(d, 'name') ? { name: d.name } : {}), argumentsDelta: members[k] }
    out.push({ type: 'assistant/chunk', seq: value.seq0 + k, time, data: { turn: d.turn, step: d.step, chunk } })
  }
  return out
}

/**
 * 读一个会话日志。完整实现：丢弃未完成尾帧 → 逐帧解压 → 拆行 → 展开打包行。
 * @returns {{ header, events, rawRows, tornStart, consumedBytes }}
 */
export function readSessionLog(file, { tolerateTornTail = true } = {}) {
  const buffer = fs.readFileSync(file)
  const { frames, tornStart } = scanZstdFrames(buffer)
  if (frames.length === 0) throw new Error('empty or header-less Zstandard session log')

  // ⚠️ 不要用 zlib.zstdDecompressSync(buffer)：它只解第一帧！
  const parts = []
  for (const f of frames) parts.push(zlib.zstdDecompressSync(buffer.subarray(f.start, f.end)))
  const text = Buffer.concat(parts).toString('utf8')

  const lines = text.split('\n').filter(l => l.length > 0)
  const header = JSON.parse(lines[0])
  if (header.type !== 'session') throw new Error('first line is not a session header')

  const events = []
  const rawRows = []
  for (let i = 1; i < lines.length; i++) {
    const row = JSON.parse(lines[i])
    rawRows.push(row)
    for (const ev of decodeStorageRecord(row)) events.push(ev)
  }

  // seq 连续性校验（应严格从 0 连续）
  for (let i = 0; i < events.length; i++) {
    if (events[i].seq !== i) throw new Error(`seq gap: at index ${i} got ${events[i].seq}`)
  }
  if (tornStart !== undefined && !tolerateTornTail) throw new Error(`torn final frame at byte ${tornStart}`)

  return { header, events, rawRows, tornStart: tornStart ?? null,
           consumedBytes: frames[frames.length - 1].end }
}

// ---------- 派生视图 ----------

/** 「agent 最后一次真正说出口的文本」+ 其时间。 */
export function lastAssistantAnswer(events) {
  const isText = c => c && c.type === 'text'
  const msg = events.findLast(e => e.type === 'assistant/message' && e.data.message.content.some(isText))
  if (msg === undefined) return null
  return {
    seq: msg.seq,
    time: msg.time,                                       // epoch ms
    turn: msg.data.turn,
    step: msg.data.step,
    interrupted: msg.data.interrupted === true,
    text: msg.data.message.content.filter(isText).map(c => c.text).join('\n'),
  }
}

/** 回合折叠 + 空闲/忙判定。移植自 plan-mode / user-approval 的 hasOpenTurn 语义。 */
export function turnState(events) {
  let open = false, openTurn = null, lastEnd = null
  for (const e of events) {
    if (e.type === 'turn/start') { open = true; openTurn = e.data.turn }
    else if (e.type === 'turn/end') { open = false; lastEnd = { turn: e.data.turn, reason: e.data.reason, seq: e.seq } }
  }

  // 未配对的工具调用（callId 有 call 无 result）
  const calls = new Map()
  for (const e of events) {
    if (e.type === 'tool/call') calls.set(e.data.callId, { seq: e.seq, name: e.data.name, resolved: false })
    else if (e.type === 'tool/result') {
      const id = e.data.message?.source?.callId ?? e.data.message?.content?.[0]?.toolCallId
      if (calls.has(id)) calls.get(id).resolved = true
    }
  }
  const pendingCalls = [...calls.entries()].filter(([, v]) => !v.resolved).map(([callId, v]) => ({ callId, ...v }))

  // 未决审批（asked 无同 id 的 decided）
  const asked = new Map()
  for (const e of events) {
    if (e.type === 'approval/asked') asked.set(e.data.id, { seq: e.seq, toolName: e.data.toolName, callId: e.data.callId })
    else if (e.type === 'approval/decided') asked.delete(e.data.id)
  }
  const pendingApprovals = [...asked.entries()].map(([id, v]) => ({ id, ...v }))

  // 待用户回答的提问类工具
  const QUESTION_TOOLS = new Set(['ask_user_question', 'exit_plan_mode'])
  const awaitingUserQuestion = pendingCalls.filter(c => QUESTION_TOOLS.has(c.name))

  // 状态判定
  let state
  if (open && pendingApprovals.length > 0) state = 'awaiting-approval'
  else if (open && awaitingUserQuestion.length > 0) state = 'awaiting-human-answer'
  else if (open && pendingCalls.length > 0) state = 'tool-running'
  else if (open) state = 'mid-turn'
  else if (lastEnd === null) state = 'idle'                     // 从未产生 turn/end
  else state = `idle-last-${lastEnd.reason.kind}`               // completed / error / blocked / aborted / max-tokens / interrupted

  return { isOpen: open, openTurn, state, lastTurnEnd: lastEnd, pendingCalls, pendingApprovals, awaitingUserQuestion,
           errored: lastEnd?.reason?.kind === 'error', lastError: lastEnd?.reason?.error ?? null }
}

/** 会话发现：遍历 $DSH_HOME/sessions，只解头帧。 */
export function listSessions(dshHome) {
  const root = path.join(dshHome, 'sessions')
  const out = []
  if (!fs.existsSync(root)) return out
  for (const project of fs.readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const pdir = path.join(root, project.name)
    for (const entry of fs.readdirSync(pdir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const sdir = path.join(pdir, entry.name)
      const file = ['session.jsonl.zstd', 'session.jsonl'].map(n => path.join(sdir, n)).find(fs.existsSync)
      if (file === undefined) continue
      const st = fs.statSync(file)
      let header = null
      try {
        if (file.endsWith('.zstd')) {
          // 只解头帧：读满一小段即可
          const fd = fs.openSync(file, 'r')
          try {
            const chunk = Buffer.alloc(8192)
            let content = Buffer.alloc(0), first
            while (first === undefined) {
              const n = fs.readSync(fd, chunk, 0, chunk.length, null)
              if (n === 0) break
              content = Buffer.concat([content, chunk.subarray(0, n)])
              first = scanZstdFrames(content, 1).frames[0]
            }
            if (first === undefined) continue
            const plain = zlib.zstdDecompressSync(content.subarray(first.start, first.end))
            header = JSON.parse(plain.subarray(0, -1).toString('utf8'))
          } finally { fs.closeSync(fd) }
        } else {
          header = JSON.parse(fs.readFileSync(file, 'utf8').split('\n', 1)[0])
        }
      } catch { continue }                     // 半写/损坏的会话跳过
      if (header?.type !== 'session') continue
      out.push({ file, sizeBytes: st.size, updatedAt: st.mtimeMs, header })
    }
  }
  return out
}

// ---------- 增量 tailing（长跑 watcher） ----------
export class SessionTail {
  constructor(file, onEvents) { this.file = file; this.onEvents = onEvents; this.consumedBytes = 0 }

  /** 冷启动：全量读一次，建立游标与 seq 基线。 */
  fullRead() {
    const { header, events, consumedBytes } = readSessionLog(this.file)
    this.consumedBytes = consumedBytes
    this.onEvents(events, { reset: true, header })
    return header
  }

  /** 增量轮询：只处理新追加的完整帧；未完成的尾帧留到下一次。 */
  poll() {
    const st = fs.statSync(this.file)
    if (st.size < this.consumedBytes) {         // 崩溃修复导致的截断 → 必须全量重读
      this.consumedBytes = 0
      return this.fullRead()
    }
    if (st.size === this.consumedBytes) return null
    const fd = fs.openSync(this.file, 'r')
    let buf
    try {
      const len = st.size - this.consumedBytes
      buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, this.consumedBytes)
    } finally { fs.closeSync(fd) }

    const { frames, tornStart } = scanZstdFrames(buf)
    if (frames.length === 0) return null          // 新帧还没写完 → 本轮跳过
    const parts = frames.map(f => zlib.zstdDecompressSync(buf.subarray(f.start, f.end)))
    const text = Buffer.concat(parts).toString('utf8')
    const events = []
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      for (const ev of decodeStorageRecord(JSON.parse(line))) events.push(ev)
    }
    this.consumedBytes += frames[frames.length - 1].end
    this.onEvents(events, { reset: false, tornStart: tornStart ?? null })
    return events
  }
}

// ---------- 用法示例 ----------
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const DSH_HOME = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? process.env.HOME, '.dsh')
  const sessions = listSessions(DSH_HOME)
  console.log(`发现 ${sessions.length} 个会话`)
  const live = sessions.sort((a, b) => b.updatedAt - a.updatedAt)[0]
  console.log('最新会话:', live.file, new Date(live.updatedAt).toISOString(), live.header.cwd)

  const { header, events, rawRows, tornStart } = readSessionLog(live.file)
  console.log('header:', header)
  console.log('存储行:', rawRows.length, '→ 展开事件:', events.length, '| tornStart:', tornStart)
  console.log('状态:', turnState(events).state)
  const answer = lastAssistantAnswer(events)
  console.log('最后一次回答:', answer && { seq: answer.seq, time: new Date(answer.time).toISOString(), text: answer.text.slice(0, 200) })
}
```

### 7.1 关键 API 说明

| 函数 | 作用 |
|---|---|
| `scanZstdFrames(buffer, maxFrames?)` | 结构化扫描拼接 zstd 帧；返回 `{frames:[{start,end}], tornStart?}`。`maxFrames=1` 时只拿头帧 |
| `decodeStorageRecord(row)` | 把 `text-chunks`/`reasoning-chunks`/`tool-call-chunks` 展开成 `assistant/chunk` 事件数组；其它行原样返回 |
| `readSessionLog(file)` | 一次读到全部事件；自动丢弃未完成尾帧；校验 seq 连续 |
| `lastAssistantAnswer(events)` | **回答 §2.7 的需求**：最后一条含 `text` 的 `assistant/message` 及其 `time` |
| `turnState(events)` | **回答 §3 的需求**：`mid-turn` / `idle-last-completed` / `awaiting-approval` / `awaiting-human-answer` / `tool-running` / errored 等 |
| `listSessions(dshHome)` | **回答 §6 的需求**：cwd / createdAt / updatedAt(mtime) / 文件路径，只读头帧 |
| `SessionTail` | 长跑增量 watcher（游标 = 最后完整帧 end；处理截断回退） |

**幂等性提示**：`readSessionLog` 的 `events` **不是**日志行 1:1 —— `events.length`（48,813）远大于 `rawRows.length`（1,687）。要做"行级审计"用 `rawRows`；要做"语义分析"用 `events`。

### 7.2 本配方已被端到端验证 **[已验证]**

上面这段代码已被**从本报告中原样抽出**（`.recon-tmp\extract-recipe.cjs` → `recipe-verify.mjs`），`node --check` 通过，并以 `DSH_HOME=C:\Users\lms\.dsh` 实际运行，输出：

```
发现 55 个会话
最新会话: …\session-89016627-2d3a-43be-a063-85af76d3ee74\session.jsonl.zstd 2026-09-16T14:52:45.211Z C:\myFiles\codes\deepseek
header: {type:'session', version:0, id:'session-89016627-…', createdAt:1789569457529,
         cwd:'C:\\myFiles\\codes\\deepseek', delegationDepth:0, agentPreset:'standard'}
存储行: 2772 → 展开事件: 93603 | tornStart: null
状态: mid-turn
最后一次回答: {seq: 79150, time:'2026-09-16T14:51:12.596Z',
               text:'**拟人通道全部验证成功** —— 这是在真实 Chromium 页面（和 Cursor/Codex 同引擎）上跑的：…'}
```

即：**会话发现、头帧解析、多帧解压、打包行展开、seq 连续性校验、turn 状态判定、最后回答提取 —— 全部路径均已在真实数据上跑通。**

> 该次运行还顺带证明会话仍在活跃增长：同一文件在本报告取证期间从 1,687 行 / 48,813 事件涨到 **2,772 行 / 93,603 事件**，每次读取都是 0 坏行。
> 同时注意 `events` 与 `rawRows` 的比值已达 **~34×** —— 打包行的体积优势非常显著。

---

## 8. VERIFIED vs INFERRED 对照表

### 8.1 已由真实数据 / 源码验证（可直接依赖）

| 结论 | 证据 |
|---|---|
| zstd 拼接帧 + Node API 只解第一帧 | 实测 774,393 B → 191 B（`zstdDecompressSync` 与 `createZstdDecompress` 皆然） |
| 帧扫描算法（含所有位域） | 源码 `zstd.ts#scanZstdFrames`，本报告逐行移植并跑通 1,608 帧 |
| 每会话目录只 1 个文件 | 55 个目录逐个 `Get-ChildItem` |
| 三个打包行 tag 与展开规则 | 源码 `chunk-rows.ts`；实测展开 48,813 事件 |
| 枚举 47 个事件类型 | 源码 `known-event-types.ts`（生成文件） |
| 19 种实测事件 + 精确计数 | live 解析（见 §2.5） |
| 信封 `{type,seq,time,data}`；`seq` 从 0 连续 | live 实测 0 断裂 |
| `surfaceOp` 只在 3 类消息事件上 | live 实测（4/35/47 次）+ 源码类型约束 |
| `ignorable` live 会话未出现 | live 实测 0 次 |
| `projectKey` / `encodeSegment` 算法 | 源码 + `C:\myFiles\codes\deepseek` → `--C-myFiles-codes-deepseek--` 演算一致 |
| 头行 9 个字段 | 55 个头行实测 + 源码 `HeaderLine` |
| 会话根 = `dshHomePath('sessions')` | 源码 `bundle/base/cordis.patch.yml:101` |
| 无索引文件；`list()` 靠目录扫描 | 源码 `listArtifacts()`；实测无 `.db`/index 文件 |
| `session-query-sqlite` 默认 `:memory:` + `never` | 源码 `cordis.patch.yml:117-121` |
| open-turn fold 是空闲判据 | 源码 `hasOpenTurn`（plan-mode 与 user-approval 各一份）+ live 实测 |
| `TurnEndReason` 6 个 kind | 源码 `TurnEndReasonMap` + live 实测 `aborted/user` |
| 审批审计对顺序 asked→decided | 源码 `ApprovalService.request()` |
| `goal/change` schema 与 7 个 operation | 源码 `GoalSnapshot`/`GoalOperation` + live 实测 2 条 |
| goal `activation` **不持久化** | 源码注释 "never persisted"（`types.ts:81`） |
| `todo/write` 只有 content+status | 源码 `TodoItem` + live 实测 10 条 |
| plan 由 `plan/mode` last-wins fold | 源码 `foldPlanMode` |
| projcache / workspace.json 格式 | 实测文件 + 源码 `storage-json/src/format.ts` |
| storages 用 rename 原子替换 | 源码 `atomic.ts` + 实测抓到在飞 `.tmp` |
| 追加/截断/无轮转 | 源码 `appendLines`/`repair`/`materialize*` |
| 撕裂尾帧可整帧丢弃 | 5 个截断点实测，恢复文本恒以 `\n` 结尾 |
| 并发读 0 坏行 | 8 次连续读 + 4 次跨时段快照 |

### 8.2 推断（未直接验证，使用需谨慎）

| 结论 | 依据 / 风险 |
|---|---|
| `session_projcache.json` 的 `seq` 字段语义 = "该投影已折叠到的事件 seq"（新鲜度） | 由字段名与数值落后于日志推断；源码未逐行确认 |
| `sessionListMetadata.val.lastPromptAt` 语义 = 最后一次 prompt 时间 | 字段名推断 |
| 崩溃场景：open turn + mtime 长期不动 ⇒ 进程已死 | 由 `interrupted` 语义外推；DSH 未提供日志内 liveness 信号 |
| `user/message.source.kind` 的完整取值集合 | 源码注释列举（user/plugin/goal 续跑），实测只见 `user` 与 `plugin` |
| `session-query-sqlite` 落盘时的 SQLite 表结构 | 由源码 SQL 字面量推断；本机该功能关闭，无法实测 |
| `seedLength` 在 fork 场景会出现 | 源码字段定义；本机 55 个会话均未出现 |
| 其它 28 个事件类型（compaction/hook/team/schedule/llm-retry 等）的 payload 结构 | 源码类型定义可读，但**本机 live 会话未产生**，故无实测样本 |

### 8.3 本次未能验证的项

- `packages/plan` 的 `plan/mode` **无实测样本**（该会话未进 plan mode）。
- `approval/asked` / `approval/decided` **无实测样本**（本会话无审批，且实际策略为 `ask` 但未触发）。
- `session/end-seed`、`compaction/*`、`hook/*`、`team/*`、`subagent/descriptor`、`tool-workflow/*`、`llm/retry*`、`command/*`、`feedback/record`、`schedule/change`、`agent-preset/selected`、`tool/code-dispatch*`、`web/deepseek-search-llm-request` 等 **28 个类型在 live 会话中未出现**（只在源码词汇表里）。
- 未压缩模式（`compression: 'none'`）的 `.jsonl` 文件：**本机不存在**，行为由源码 `scanLog` 推断。
- 跨平台（POSIX）的 `link()+unlink()` 发布路径未在本机（Windows）触发。

---

## 9. 附：取证脚本与产物清单

均在 `C:\myFiles\codes\deepseek\cyber-overseer\.recon-tmp\`（一次性，无副作用；**未写入任何 DSH 状态文件**）：

| 文件 | 用途 |
|---|---|
| `tally.cjs` | 第一版 tally（暴露了"只解第一帧"的坑） |
| `read-session.cjs` | 多帧解码 + 事件 tally，输出 `schema-summary.json` |
| `deep.cjs` → `deep-out.json` | 逐类型样本、最后回答路径、turn 状态、撕裂尾帧模拟 |
| `discover.cjs` → `discover-out.json` | 55 个会话的头帧扫描（发现 recipe 验证） |
| `concurrency.cjs` | Node zstd API 行为 + 帧尾/游标验证 |
| `concurrency2.cjs` → `concurrency-out.json` | 真实并发追加下的 8 轮读取一致性 |
| `session.decompressed.jsonl` | live 会话的明文副本（约 1.6 MB） |
| `extract-recipe.cjs` → `recipe-verify.mjs` | 从本报告抽出 §7 配方并跑通验证 |

> 复现命令：
> ```powershell
> node .recon-tmp\read-session.cjs "C:\Users\lms\.dsh\sessions\--C-myFiles-codes-deepseek--\session-89016627-2d3a-43be-a063-85af76d3ee74\session.jsonl.zstd" .recon-tmp
> node .recon-tmp\discover.cjs "C:\Users\lms\.dsh\sessions"
> node .recon-tmp\extract-recipe.cjs ; node .recon-tmp\recipe-verify.mjs
> ```
> ⚠️ 注意：写任何产物到 `.dsh` 目录会触发沙箱 `EPERM`（正确行为）——本报告所有产物都写在 workspace 内。

### 9.1 一个取证工具链的坑（与 DSH 无关，但必踩）

**Windows PowerShell 的 `Get-Content -Raw` / `Set-Content -Encoding UTF8` 往返会破坏含中文/emoji 的 UTF-8 文本。** 实测：用 `Get-Content -Raw` 从本报告抽出 §7 的代码块再 `Set-Content` 写回，中文注释变成 GBK mojibake，且**某些 CJK 字符会把行尾 `\n` 一起吞掉**，导致注释未闭合、`for` 循环与 JS 字符串粘连，`node --check` 报出**假的** `SyntaxError: Illegal return statement`。

- **症状**：`Illegal return statement` / `Unterminated regexp literal`，位置总在中文注释附近。
- **结论**：这是**抽取环节的编码问题，不是被抽取代码的缺陷**（用 Node 以 `utf8` 读同一段则完全正常）。
- **对策**：读写文本一律走 Node（`fs.readFileSync(p,'utf8')` / `writeFileSync(p,s,'utf8')`），或 PowerShell 里显式指定 `-Encoding utf8NoBOM` 并确保读取端也用 UTF-8。本报告 §7.2 的验证就是用 Node 抽取完成的。

### 9.2 读取本报告自身时的注意事项

- 报告与真实样本中大量字段为**中文/emoji**，解析时务必按 **UTF-8** 处理；JSON 里的中文以 `\uXXXX` 转义形式落盘时不要误判为乱码。
- 样本中的 Windows 路径在 JSON 中为双反斜杠转义（`"C:\\myFiles\\..."`），实际路径是单反斜杠。

# Cursor IDE 3.15.6 — AI 对话存储格式与外部监督（injection / read）逆向报告

> 本报告为**只读**逆向结果。所有数据库均在**副本**上以 `readOnly: true` 打开，未修改任何 Cursor 数据文件。
> 临时脚本与副本位于 `C:\myFiles\codes\deepseek\cyber-overseer\.recon-tmp\`。

---

## 0. 版本与目标

| 项 | 值 | 依据 |
|---|---|---|
| Cursor 版本 | **3.15.6** | VERIFIED — `C:\Softwares\cursor\resources\app\package.json` |
| `distro` | `d5c0e77a0214208f36b56d42e8e787de88d02ea4` | VERIFIED — 同上 |
| `commit` / `realCommit` | `a1f686545fd0ce8917bbd2449f733551a9bce420` | VERIFIED — `product.json` |
| 构建日期 | `2026-08-06T01:41:03.876Z` | VERIFIED — `product.json` |
| `vscodeVersion` | `1.128.0` | VERIFIED — `product.json` |
| `quality` | `stable` | VERIFIED — `product.json` |
| `dataFolderName` | `.cursor` | VERIFIED — `product.json` |
| `applicationName` | `cursor` | VERIFIED — `product.json` |
| 主入口 | `main = ./out/main.js`（`"type": "module"`） | VERIFIED — `package.json` |

**版本敏感性声明（重要）**：Cursor 的对话存储结构在版本间有实质变化。本报告中的 `_v`（schema 版本）在同一份数据库中同时存在 `3` 与 `17` 两种值；老会话（`_v:3`，2025-06）**没有** `modelConfig` 与 `workspaceIdentifier` 字段，新会话（`_v:17`，2026）才有。因此**任何解析代码必须做字段存在性判断**，不能假定字段恒定。本报告的路径与表结构结论**仅对 3.15.6 负责**。

---

## 1. `state.vscdb`：主状态库

### 1.1 基本情况（VERIFIED）

路径：`C:\Users\lms\AppData\Roaming\Cursor\User\globalStorage\state.vscdb`

| 文件 | 大小（快照时） |
|---|---|
| `state.vscdb` | 15,663,104 B |
| `state.vscdb-wal` | **0 B** |
| `state.vscdb-shm` | 32,768 B |
| `state.vscdb.backup` | 15,167,488 B |
| `state.vscdb.options.json` | 20 B → `{"useWAL": true}` |

> WAL 为 0 字节，说明快照时刻没有未提交事务。即便如此，**拷贝时仍必须同时拷贝 `-wal` 与 `-shm`**，否则可能读到不一致状态。

### 1.2 表结构 —— 关键发现：对话**不在** `ItemTable` 里（VERIFIED）

```sql
CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)
CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)
CREATE TABLE composerHeaders (
  composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER,
  lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER,
  recency INTEGER, checkpointAt INTEGER, value TEXT)
CREATE INDEX idx_composerHeaders_0 ON composerHeaders (workspaceId, isSubagent, isArchived, recency)
CREATE INDEX idx_composerHeaders_1 ON composerHeaders (recency, composerId)
```

行数：`ItemTable` = **216**，`cursorDiskKV` = **952**，`composerHeaders` = **8**。

**结论（VERIFIED）**：AI 对话**全部在 `cursorDiskKV` 表**，按 `key` 前缀分区。`ItemTable` 只存 UI 状态。

### 1.3 `cursorDiskKV` 键前缀分布（VERIFIED，实测）

| 行数 | 总字节 | 前缀模式 | 含义 |
|---|---|---|---|
| 220 | 5,466,980 | `checkpointId:<composerId>:<uuid>` | 文件检查点/快照（最大，占总字节最多）|
| **455** | **3,361,023** | **`bubbleId:<composerId>:<bubbleId>`** | **单条消息（user / assistant）** |
| 65 | 1,856,015 | `codeBlockDiff:<uuid>` | 代码块 diff |
| 91 | 292,140 | `agentKv:<uuid>` / `agentKv:blob:<sha256>` | agent KV 缓存（含真 BLOB）|
| **38** | **283,840** | **`composerData:<composerId>`** | **会话元数据 + 消息顺序表** |
| 70 | 86,206 | `messageRequestContext:<uuid>` | 请求上下文 |
| 1 | 29 | `model-nudge.startup-trigger-session` | 杂项 |
| 1 | 29 | `model-nudge.startup-session` | 杂项 |
| 9 | 18 | `inlineDiff*` | diff 索引 |
| 1 | 2 | `composerVirtualRowHeights:_recentIds` | UI |
| 1 | 1 | `composer.composerHeaders.migratedToTable` | 迁移标记 |

#### 三种键的精确分工

**(A) 会话列表 —— `ItemTable` 键 `composer.composerHeaders`（4,353 B）**

这是**旧版兼容 / UI 列表**，JSON 顶层只有 `allComposers`，实测 5 条：

```json
{"allComposers":[{"type":"head","composerId":"c22dc724-c52a-48b2-837b-4bf318e60c08",
  "lastUpdatedAt":1783746502872,"conversationCheckpointLastUpdatedAt":1783746512188,
  "createdAt":1783745985854,"unifiedMode":"agent","forceMode":"edit",
  "hasUnreadMessages":false,"contextUsagePercent":13.8215,
  "totalLinesAdded":0,"totalLinesRemoved":0,"filesChangedCount":0,
  "subtitle":"Read test.bat, setup_items.sh, ours_brats18.csv, README.md, train3.txt",
  "hasBlockingPendingActions":false,"isArchived":false,"isDraft":false,
  "isWorktree":false,"worktreeStartedReadOnly":false,"isSpec":false,"isProject":false,
  "isBestOfNSubcomposer":false,"numSubComposers":0,"referencedPlans":[],"trackedGitRepos":[],
  "workspaceIdentifier":{"id":"0d17d028f8b44d5cb7b90c7814392c22","uri":{
     "$mid":1,"fsPath":"e:\\项目\\codes\\220124_brainTumor\\M3AE\\260711_胶质瘤项目分割演示打包\\m3ae-main_lms230718",
     "_sep":1,"external":"file:///e%3A/%E9%A1%B9%E7%9B%AE/...","path":"/e:/项目/...","scheme":"file"}},
  "name":"Demo data source inquiry"}, ...]}
```

**这是唯一同时含「会话标题 + 项目绝对路径」的 ItemTable 键**（`allComposers[].workspaceIdentifier.uri.fsPath`）——见 §3.2。

配套键：`composer.composerHeaders.version` = `"1786269939525-1"`，`composer.composerHeaders.tableGateEnabled` = `true`，`composerDiskKV` 键 `composer.composerHeaders.migratedToTable` = `"1"` → **已迁移到 `composerHeaders` 表**（VERIFIED）。

**(B) 会话级元数据 —— `cursorDiskKV` 键 `composerData:<composerId>`（38 个）**

新会话（`_v:17`）顶层键（VERIFIED，实测全量键名）：
`_v, composerId, richText, hasLoaded, text, fullConversationHeadersOnly, conversationMap, status, context, generatingBubbleIds, isReadingLongFile, codeBlockData, originalFileStates, newlyCreatedFiles, newlyCreatedFolders, lastUpdatedAt, createdAt, hasChangedContext, activeTabsShouldBeReactive, capabilities, isFileListExpanded, canvasPillCollapsed, browserChipManuallyDisabled, browserChipManuallyEnabled, unifiedMode, activeCustomMode, pendingExitedCustomMode, forceMode, usageData, allAttachedFileCodeChunksUris, modelConfig, subComposerIds, subagentComposerIds, capabilityContexts, todos, isQueueExpanded, hasUnreadMessages, gitHubPromptDismissed, totalLinesAdded, totalLinesRemoved, addedFiles, removedFiles, isDraft, isCreatingWorktree, isApplyingWorktree, isUndoingWorktree, applied, pendingCreateWorktree, worktreeStartedReadOnly, isBestOfNSubcomposer, isBestOfNParent, isSpec, isProject, isSpecSubagentDone, isContinuationInProgress, stopHookLoopCount, trackedGitRepos, speculativeSummarizationEncryptionKey, isNAL, agentBackend, planModeSuggestionUsed, debugModeSuggestionUsed, conversationState, queueItems, blobEncryptionKey, isAgentic, draftTarget, workspaceIdentifier, applyAgentBackendTypeRestrictions`

关键标量字段实测值：

```json
{
  "_v": 17,
  "composerId": "empty-state-draft",
  "status": "none",
  "isAgentic": false,
  "unifiedMode": "chat",
  "forceMode": "chat",
  "agentBackend": "cursor-agent",
  "lastUpdatedAt": 1786269935442,
  "createdAt": 1786269935374,
  "generatingBubbleIds": [],
  "conversationState": "~",
  "workspaceIdentifier": {"id": "empty-window"},
  "blobEncryptionKey": "lQ6F7nvPh6VqqmfmO+gU6ku1xKF+sbcf4hgk6oFVXjc=",
  "speculativeSummarizationEncryptionKey": "QHKpGQb7R3RRx0oms1Ff9pBjEofxSL/47WrUn3CM1ao="
}
```

> **注意**：`blobEncryptionKey` / `speculativeSummarizationEncryptionKey` 存在，但实测 `bubbleId` 的 `text` **仍是明文**（见 §1.4），即当前 3.15.6 下这些 key 未加密对话正文。这是**可能随版本改变的重要风险点**。

`modelConfig` = `{modelName, maxMode, selectedModels}`；`workspaceIdentifier` = `{id, uri?}`。

**(C) 消息顺序表 —— `fullConversationHeadersOnly`（数组）**

这是**唯一权威的消息顺序**。注意：**它只有气泡 id，没有时间戳**。实测元素结构（全量键合集 = `bubbleId, type, serverBubbleId`）：

```json
[
  {"bubbleId":"f534e790-1a38-4730-a6f0-a3b5eea959f6","type":2,"serverBubbleId":"3b0d02f1-01c3-41c1-84a6-d85750e674e8"},
  {"bubbleId":"36a00431-09a5-4ade-bbee-beb11358a2b5","type":1},
  {"bubbleId":"f903c435-ad4d-4aaf-b265-7eb45d8f9d42","type":2,"serverBubbleId":"a25c08c1-d38d-4cec-a378-e36aca60ee82"}
]
```

> `conversationMap` 实测为**空对象** `{}`（38 个 composerData 中全部为空），不要依赖它。

**(D) 单条消息 —— `cursorDiskKV` 键 `bubbleId:<composerId>:<bubbleId>`（455 个）**

`type` 语义（VERIFIED，与 UI 一致）：
- `type: 1` = **user** 消息
- `type: 2` = **assistant** 消息

**实测真样本（truncated）—— user 气泡：**

```json
{"_v":2,"type":1,"bubbleId":"08e665fa-76bf-4993-aaba-3bb2faadbcf2",
 "text":"打开html游戏画面为黑屏，什么也没有",
 "richText":"{...Lexical JSON...}","tokenCount":{"inputTokens":0,"outputTokens":0},
 "isAgentic":true,"capabilitiesRan":{"mutate-request":[6],"before-submit-chat":[15],
   "after-submit-chat":[18,23],"composer-done":[6],"process-stream":[15,14]},
 "context":{...},"checkpointId":"...","currentFileLocationData":{...},
 "codeBlocks":[],"images":[],"relevantFiles":[],"recentlyViewedFiles":[],...}
```

**实测真样本（truncated）—— assistant 气泡：**

```json
{"_v":2,"type":2,"bubbleId":"fb592870-df40-4e1f-a179-05e989934816",
 "text":"太棒了！我已经为你创建了一个完整的《瑞克和莫蒂》风格的横版打怪游戏！🎮\n\n## 游戏特色亮点：\n\n### 🎨 **完美还原动画风格**\n- Jerry的像素化造型（棕色头发、蓝色衬衫、深蓝裤子）\n- Cronenberg怪物的恶心多变外观（3种颜色变体）\n...",
 "tokenCount":{"inputTokens":36163,"outputTokens":26493},
 "codeBlocks":0,"toolResults":[],"allThinkingBlocks":[],
 "serverBubbleId":"...","usageUuid":"...","isAgentic":true,...}
```

**带工具调用的气泡**（`text` 常为 `""`，正文在 `toolFormerData`）：

```json
{"type":2,"text":"","isThought":true,"capabilityType":15,
 "toolFormerData":{"name":"edit_file","status":"completed",...},
 "codeBlocks":1,"checkpointId":"...","afterCheckpointId":"..."}
```

实测出现的工具名：`edit_file`、`read_file`、`search_replace`、`run_terminal_cmd`；`toolFormerData.status` ∈ `completed | error`。

### 1.4 **最后一个 assistant 消息文本的精确字段路径**（VERIFIED，已端到端跑通）

```
1. 取 cursorDiskKV key = 'composerData:' || <composerId>            → JSON 对象 cd
2. 遍历 cd.fullConversationHeadersOnly 从后往前
3. 跳过 type !== 2 的项
4. 取 cursorDiskKV key = 'bubbleId:' || <composerId> || ':' || h.bubbleId  → JSON 对象 b
5. 若 b.text 为非空字符串 → 这就是最后一条 assistant 回答正文
```

即字段路径：**`cursorDiskKV["bubbleId:<composerId>:<bubbleId>"].text`**，其中 `bubbleId` 来自 **`cursorDiskKV["composerData:<composerId>"].fullConversationHeadersOnly[从后往前第一个 type===2].bubbleId`**。

实测输出（脚本 `recipe-test.mjs` 真实运行结果）：

```
composerId = c22dc724-c52a-48b2-837b-4bf318e60c08
title    = "Demo data source inquiry"
status   = "completed"
mode     = agent | model = composer-2.5
bubbleId   = 419da534-208e-4091-9b82-6a31f0218d4f
createdAt  = 2026-07-11T05:08:28.116Z
text length= 870
text head  : "可以，**Bandizip 支持只解压压缩包里的部分文件**，不必整包全解。\n\n## 常用做法\n\n**1. 选中部分文件再解压**..."
text tail  : "...然后把 `dataset/brats.py` 里的 `BRATS_TRAIN_FOLDERS` 指到这个目录即可。\n\n如果你说一下压缩包具体格式（`.zip` / `.7z` / `.rar` / 分卷），我可以按你的包结构写更具体的解压步骤。"
```

> **结论：assistant 回答可以从磁盘读取，不需要 Cursor 运行，也不需要任何凭据。** 读取键 = `cursorDiskKV` 的 `bubbleId:<composerId>:<bubbleId>`（`.text`），会话元数据 = `composerData:<composerId>`。

### 1.5 时间戳与模型名 —— **版本敏感，必须容错**（VERIFIED）

对全部 455 个 `bubbleId` 值统计：

| 字段 | 出现次数 | 形态 |
|---|---|---|
| `createdAt` | **67 / 455** | **ISO 8601 字符串**，如 `"2026-02-27T16:07:18.345Z"` |
| `timingInfo` | **70 / 455** | 毫秒 epoch 对象 |
| `modelInfo` | **4 / 455** | `{"modelName":"composer-2"}` |

`timingInfo` 真样本：

```json
{"clientStartTime":62550.5,"clientRpcSendTime":1750484350669,
 "clientSettleTime":1750484365218,"clientEndTime":1750484365218}
```

- **`clientRpcSendTime`** = 请求发出时刻（ms epoch）
- **`clientSettleTime` == `clientEndTime`** = **该轮回答完成时刻**（ms epoch）—— 这是一个可用的「回答已完成」时间戳
- `clientStartTime` 是相对进程启动的偏移量（非绝对时间），**不要当时间戳用**

**模型名的三层来源（按可靠性排序）**：
1. `composerData:<id>.modelConfig.modelName` —— 新会话有（实测 `composer-2.5`、`composer-2`、`gemini-2.5-pro-preview-05-06`）
2. `composerHeaders.value` / `composer.composerHeaders.allComposers[]` —— 旧会话
3. `bubbleId…modelInfo.modelName` —— **仅 4/455 有**，不可主用

**时间戳的兜底**：`composerHeaders.lastUpdatedAt`（8 行）、`composerHeaders.recency`、`ItemTable.composer.composerHeaders.allComposers[].lastUpdatedAt`（5 条）覆盖全部会话。旧会话可退化为 `composerData.createdAt`。

### 1.6 BLOB 与序列化格式（VERIFIED）

- `ItemTable.value`：**216 行全为 `text`**，无一个 BLOB。
- `cursorDiskKV.value`：绝大多数为 `text`（明文 JSON）。例外：
  - **`agentKv:blob:<sha256>` 共 91 个为真 `blob` 类型**，大小 42 B – 38,024 B。这些是 agent KV 缓存（不是对话正文）。
  - **12 个键的值为 SQL `NULL`**：`composerData:a9617912-…`、`composerData:92c6e913-…` 及 10 个 `bubbleId:…`（属于 `e6c3480e`、`862d22d1` 两个会话）。**解析时必须对 `null` 值做防护**（我在第一次扫描时正是被这个坑到）。
- **未发现 VS Code 专有序列化格式**（无 msgpack / 无 `vscode-serialized` 封装 / 无 base64 包裹的 JSON）。对话正文是**裸 UTF-8 JSON 文本**。
- 明文中文（含 emoji）在 `text` 字段中完整可读 —— 无加密。

### 1.7 会话/气泡 id 跨重启是否稳定（VERIFIED：**稳定**）

同一个 `composerId` 同时出现在 **5 个互相独立的持久化位置**，均一致：

| 位置 | 实测值 |
|---|---|
| `cursorDiskKV` 键 | `composerData:c22dc724-c52a-48b2-837b-4bf318e60c08` |
| `cursorDiskKV` 气泡键 | `bubbleId:c22dc724-c52a-48b2-837b-4bf318e60c08:<bid>` |
| `composerHeaders.composerId` | `c22dc724-c52a-48b2-837b-4bf318e60c08` |
| `ItemTable → composer.composerHeaders → allComposers[].composerId` | `c22dc724-c52a-48b2-837b-4bf318e60c08` |
| `conversation-search.db → conversations.id` | `c22dc724-c52a-48b2-837b-4bf318e60c08` |
| `.cursor\projects\<sanitized>\agent-transcripts\` **目录名与文件名** | `c22dc724-c52a-48b2-837b-4bf318e60c08` |

均为 UUIDv4，**作为持久主键稳定**（这是本报告所有关联逻辑的基础）。`bubbleId` 同为 UUIDv4 且是键的一部分，亦稳定。

### 1.8 `conversation-search.db`（VERIFIED）

路径：`C:\Users\lms\AppData\Roaming\Cursor\User\globalStorage\conversation-search.db`，573,440 B，`user_version = 7`，`journal_mode = wal`（无 `-wal` 文件存在）。

表与行数：

| 对象 | 类型 | 行数 |
|---|---|---|
| `conversations` | table | **31** |
| `conversation_fts` | FTS5 虚表 | 31 |
| `conversation_fts_content` | FTS 影子表 | 31 |
| `conversation_fts_data` | FTS 影子表 | 55 |
| `conversation_fts_idx` | FTS 影子表 | 53 |
| `conversation_fts_docsize` | FTS 影子表 | 31 |
| `conversation_fts_config` | FTS 影子表 | 1 |
| `conversation_search_candidates` | table | 31 |
| `conversation_search_reconciliation` | table | 1 |
| `conversation_search_settings` | table | 1 |

```sql
CREATE TABLE conversations (
  fts_rowid INTEGER PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('local','cloud-cache')),
  scope TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL,
  updated_at INTEGER NOT NULL, is_archived INTEGER NOT NULL,
  root_fingerprint TEXT, cache_fingerprint TEXT, UNIQUE(source, scope, id), ...)
CREATE VIRTUAL TABLE conversation_fts USING fts5(
  title, body, tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3')

CREATE TABLE conversation_search_settings (id INTEGER PRIMARY KEY CHECK (id=1),
  effective_conversation_cap INTEGER NOT NULL)   -- 实测 {"id":1,"effective_conversation_cap":10000}
CREATE TABLE conversation_search_reconciliation (id INTEGER PRIMARY KEY CHECK (id=1),
  cursor TEXT NOT NULL, in_progress INTEGER NOT NULL)  -- 实测 {"id":1,"cursor":"","in_progress":0}
```

真样本行：

```json
{"fts_rowid":1,"source":"local","scope":"","id":"c22dc724-c52a-48b2-837b-4bf318e60c08",
 "title":"Demo data source inquiry","updated_at":1783746502872,"is_archived":0,
 "root_fingerprint":"ca1f75888e11c9db11cb342a6ea5b7090271cf9d61a684d78877bda1412bfd83",
 "cache_fingerprint":null}
```

`conversation_fts.body` **确实包含 assistant 正文**（真样本，来自 `conversation_fts_content.c1`）：

```
@分割演示demo.bat 看下这个演示demo数据从哪来的
我先打开 分割演示demo.bat 并顺着它调用的脚本，查清演示数据是从哪里加载的。
演示数据不是项目里自带的，而是从本机硬盘上的 BraTS 2018 训练集 读取的。调用链如下。
调用链
分割演示demo.bat
    → python test_18_smu.py
        → get_datasets_train_rf_withtest()
            → 读取 dataset/test3.txt（病例名单）
            → 扫描 BRATS_TRAIN_FOLDERS 下的 Brats18* 目录
            → 加载 .nii.gz 影像做推理
```

#### 能否与 `state.vscdb` join？—— **可以，但只能 join 元数据**（VERIFIED）

`conversations.id` **就是 `composerId`**。实测 31 条 local 会话**全部**能在 `state.vscdb` 找到 `composerData:<id>`：

```
c22dc724-…  composerData_present=true  bubbles=34
39ac3e8c-…  composerData_present=true  bubbles=0
819c10c7-…  composerData_present=true  bubbles=142
（31/31 全部命中）
```

`source` 实测全为 `'local'`，`cloud-cache` 行数 = **0**，`scope` 全为空串。

#### ⚠️ **但 FTS 索引滞后一轮 —— 不能用来读「最新回答」**（VERIFIED，关键负面结论）

我逐条对比了「`composerData.fullConversationHeadersOnly` 中倒数的有文本气泡」与「`conversation_fts.body`」：

| composerId | headers | 有文本气泡 | fts body 长度 | **缺失的尾部文本气泡数** |
|---|---|---|---|---|
| `c22dc724-…` | 33 | 7 | 3,163 | **1** |
| `819c10c7-…` | 138 | 70 | 24,944 | **0** |
| `0895c348-…` | 19 | 15 | 6,457 | **1** |
| `f9a4e89f-…` | 10 | 10 | 4,624 | **1** |
| `e6c3480e-…` | 135 | 66 | 9,487 | **1** |
| `f607a895-…` | 14 | 11 | 8,758 | **1** |
| `57160d54-…` | 62 | 38 | 8,881 | **1** |
| `862d22d1-…` | 24 | 4 | 342 | 0 |
| `ebed4d47-…` | 4 | 1 | 126 | 0 |

直接证据：对 `c22dc724`，倒数第 1 个 assistant 文本（870 字符，讲 Bandizip 分卷解压）**在 fts body 中找不到**（`body.includes(...) === false`）；body 尾部是**更早一轮**的内容。

**结论**：`conversation-search.db` 是一个**用于全文检索、且有至少一轮延迟**的索引。
- ✅ 可用于：跨会话全文搜索（`body` 参与索引）、拿 `title`、拿 `updated_at`、拿 `root_fingerprint`。
- ❌ **不可用于**：判断「agent 现在答完了没有」或读取「最后一条回答」——它会稳定地缺少最后一轮 assistant 文本。
- ⚠️ 另有 3 条 `updated_at` 与 `fts_body_len=0` 的「已建索引行但未填充内容」情况（如 `39ac3e8c`、`12443f40`、`e33844e5`），说明索引填充是**异步、可能长期不完成**的。

`root_fingerprint`（64 hex = SHA-256 形态）**无法用常见路径变换复现**：我对 `c:\myFiles\codes\lapis-cv-vscode-v2.0.1` 的 4 种写法各试 `sha256` 与 `md5`，**全部不匹配**目标值 `51c07f2130ec6b560a7e43588bd9cb57e16f310c2286c9cec3ede49189fd5a91`。**（INFERRED）**它是 Cursor 内部某种规范化哈希，**不要试图自己算**——项目关联请走 §3.2 的可靠路径。

---

## 2. `state.vscdb` 之外的对话存储

### 2.1 ⭐ `.cursor\projects\<sanitized>\agent-transcripts\<conversationId>\<conversationId>.jsonl`（VERIFIED）

**这是 assistant 回答的第二个、且更「干净」的来源**，且是**完整对话转录**（含 user 轮次与 tool_use 调用参数）。

实测路径（全机器仅 1 个转录文件）：

```
C:\Users\lms\.cursor\projects\e-codes-220124-brainTumor-M3AE-260711-m3ae-main-lms230718\
  agent-transcripts\c22dc724-c52a-48b2-837b-4bf318e60c08\
    c22dc724-c52a-48b2-837b-4bf318e60c08.jsonl        10,715 B, 12 行
```

**结构实测**（每行一个 JSON 对象，顶层键**只有** `role` 和 `message`，`message` 只有 `content`）：

| 行 | role | content types | 字符数 |
|---|---|---|---|
| 0 | user | text | 188 |
| 1 | assistant | text, tool_use, tool_use | 436 |
| 2 | assistant | text, tool_use, tool_use, tool_use | 653 |
| 3 | assistant | text ×1 + tool_use ×3 | 587 |
| 4 | assistant | text ×1 + tool_use ×4 | 730 |
| 5 | assistant | text ×1 + tool_use ×3 | 626 |
| 6 | assistant | text, tool_use, tool_use | 372 |
| 7 | assistant | text | 2,639 |
| 8 | user | text | 167 |
| 9 | assistant | text | 585 |
| 10 | user | text | 177 |
| **11** | **assistant** | **text** | **1,006** ← 最后一条回答 |

第 0 行真样本（verbatim）：

```json
{"role":"user","message":{"content":[{"type":"text","text":"<timestamp>Saturday, Jul 11, 2026, 1:01 PM (UTC+8)</timestamp>\n<user_query>\n@分割演示demo.bat 看下这个演示demo数据从哪来的\n</user_query>"}]}}
```

第 1 行（含工具调用）：

```json
{"role":"assistant","message":{"content":[
  {"type":"text","text":"我先打开 `分割演示demo.bat` 并顺着它调用的脚本，查清演示数据是从哪里加载的。\n\n"},
  {"type":"tool_use","name":"Read","input":{"path":"e:\\项目\\codes\\220124_brainTumor\\M3AE\\260711_胶质瘤项目分割演示打包\\m3ae-main_lms230718\\分割演示demo.bat"}},
  {"type":"tool_use","name":"Read","input":{...}}]}}
```

最后一行 `text` 尾部（verbatim，含 Cursor 自己写入的脱敏标记）：

```
...然后把 `dataset/brats.py` 里的 `BRATS_TRAIN_FOLDERS` 指到这个目录即可。

如果你说一下压缩包具体格式（`.zip` / `.7z` / `.rar` / 分卷），我可以按你的包结构写更具体的解压步骤。

[REDACTED]
```

**重要特性与限制（VERIFIED）**：
- 同目录/同名 = `conversationId` = `composerId`（可关联）。
- **Cursor 自己写入字面量 `[REDACTED]`**：实测该文件出现 **9 次**。这是产品行为，不是采集端脱敏。
- **无 `tool_result`**、无 `usage`、无 `thinking`、无 `bubbleId`/`composerId` 字段、无毫秒时间戳（时间在内嵌的 `<timestamp>` 文本里，且只有部分轮次有）。
- 目录名是**工作区路径的规范化形式**（非字母数字折叠为 `-`），例如：
  - `c-myFiles-codes-lapis-cv-vscode-v2-0-1` ⇔ `c:\myFiles\codes\lapis-cv-vscode-v2.0.1`
  - `e-codes-220124-brainTumor-M3AE-260711-m3ae-main-lms230718` ⇔ `e:\项目\codes\220124_brainTumor\M3AE\260711_胶质瘤项目分割演示打包\m3ae-main_lms230718`
  - 无文件夹窗口用 workspace id：`empty-window`、`1786269805118`
- **覆盖率很低**：本机仅 1 个 `.jsonl`，而 `state.vscdb` 有 38 个 `composerData`、`conversation-search.db` 有 31 条。**（INFERRED）**转录是较新版本才引入的，且仅对部分 agent 模式会话生成。**不能作为唯一读取通道。**

佐证（VERIFIED，Cursor 自己的 `.gitignore` 注释）：
```
!projects/*/agent-transcripts/   # Agent transcripts for citation
```

其他 `.cursor\projects\*\` 子目录（VERIFIED，均**不含**对话正文）：
- `mcps\<server>\` → MCP 工具描述（`INSTRUCTIONS.md`、`SERVER_METADATA.json`、`tools\*.json`），实测有 `cursor-app-control`(7 工具) 与 `cursor-ide-browser`(16 工具)
- `canvases\` → Canvas SDK 的 `tsconfig.json` + `node_modules\@types\react\*.d.ts`
- `terminals\` → **存在但为空**
- `agent-notes\` / `agent-tools\` → **不存在**

### 2.2 `C:\Users\lms\.cursor\` 各子目录实际内容（VERIFIED）

| 路径 | 规模 | 是否含 assistant 正文 |
|---|---|---|
| `agents\` | **0 文件（空）** | 否 |
| `ai-tracking\ai-code-tracking.db` | 1 文件 73,728 B | **否**——SQLite schema 齐全但 6 张表**全为 0 行**（含 `conversation_summaries`），仅 `tracking_state` 有 1 行 `{"key":"trackingStartTime","v":"{\"timestamp\":1772208393976}"}` |
| `projects\` | 92 文件 / 276,263 B | **部分是** —— 见 §2.1 `agent-transcripts` |
| `plugins\local\` | **0 文件（空）** | 否 |
| `skills-cursor\` | 36 文件 / 229,227 B | **否** —— 20 个内置 skill 的 `SKILL.md` 静态提示词；机器校验 `"role":"assistant"`=0、`tool_use`=0 |
| `extensions\` | 32,151 文件 / 518,780,320 B | 否（已安装扩展代码）|
| `ide_state.json` | 1,090 B | **否** —— 顶层只有 `recentlyViewedFiles`（8 条 MRU，含 `relativePath`+`absolutePath`）|
| `.gitignore` / `argv.json` | 985 / 798 B | 否 |

`ide_state.json` 真样本（可用于**辅助**判断用户最近在哪个项目）：

```json
{"recentlyViewedFiles":[
 {"relativePath":"test_18_smu.py","absolutePath":"e:\\项目\\codes\\220124_brainTumor\\M3AE\\260711_胶质瘤项目分割演示打包\\m3ae-main_lms230718\\test_18_smu.py"},
 {"relativePath":"limingshuang-cn.md","absolutePath":"c:\\myFiles\\codes\\lapis-cv-vscode-v2.0.1\\limingshuang-cn.md"}, ...]}
```

`skills-cursor\` 中包含与本任务高度相关的两个 skill（VERIFIED，见 §4.5）：`loop\SKILL.md`（3,853 B）与 `create-hook\SKILL.md`（9,192 B）。

### 2.3 `User\workspaceStorage\*\` 真实布局（VERIFIED）

**20 个子目录，69 文件，2,277,319 B，恰好 20 个 `state.vscdb`。**

命名：
- **18 个 = 32 位小写十六进制**（md5 形态）：`0d17d028f8b44d5cb7b90c7814392c22`、`7528743e31b416a085742122d6d1fed6`、`a2cf9f75a8b44f5b91d4cf4f307aeb3e` 等
- **2 个 = 无文件夹窗口的纯标签**：`1786269805118`、`empty-window`（与 `.cursor\projects\` 下同名目录共享同一 identifier 空间）

每个目录内容**只有**：`workspace.json`、`state.vscdb`、`state.vscdb.backup`，以及 7 个目录中的 `anysphere.cursor-retrieval\`。
**没有** `metadata.json`（全 `User\` 递归搜索 0 命中），**没有** `chatSessions\` / `chatEditingSessions\` / `chatEditing\` / 任何 `*chatSession*` 文件。

3 个具体实例（VERIFIED，verbatim）：

**例 A — `7528743e31b416a085742122d6d1fed6`**
```json
// workspace.json (67 B)
{ "folder": "file:///c%3A/myFiles/codes/lapis-cv-vscode-v2.0.1" }
```
内含 `state.vscdb` 57,344 B + `.backup` + `anysphere.cursor-retrieval\{embeddable_files.txt 160 B, high_level_folder_description.txt 240 B}`

**例 B — `0d17d028f8b44d5cb7b90c7814392c22`**
```json
// workspace.json (205 B)
{ "folder": "file:///e%3A/%E9%A1%B9%E7%9B%AE/codes/220124_brainTumor/M3AE/260711_%E8%83%B6%E8%B4%A8%E7%98%A4%E9%A1%B9%E7%9B%AE%E5%88%86%E5%89%B2%E6%BC%94%E7%A4%BA%E6%89%93%E5%8C%85/m3ae-main_lms230718" }
```
`high_level_folder_description.txt` 头部：
```json
{"timestamp":1783227663223,"paths":[".\\inference_util.py",".\\pretrain.py",".\\run_sd3.sh",".\\train.txt",".\\README.md",".\\setup_items.sh",".\\test_18_smu.py",...,".\\分割演示demo.bat",".\\dataset\\brats.py",...]}
```

**例 C — `a2cf9f75a8b44f5b91d4cf4f307aeb3e`**
```json
// workspace.json (52 B)
{ "folder": "file:///c%3A/myFiles/codes/ai_note" }
```

**关键点（VERIFIED）**：`workspace.json` **只使用 `folder` 键**，从不使用经典 VS Code 的 `workspace` 或 `configuration` 键。`state.vscdb` 49 KB 级别的按工作区分片库**不是**对话存储（对话只在 globalStorage 的 `cursorDiskKV` 里），它存的是该工作区的 UI/索引状态。

> **`workspaceStorage` 目录名的哈希算法未能复现**（VERIFIED 负面结论）：我用 300+ 种路径写法（`file:///c%3A/...`、解码后 `c:/...`、反斜杠、大小写折叠、`%3a`/`%3A`、尾部分隔符、UTF-8/UTF-16LE/latin1、去掉盘符）对 `c:\myFiles\codes\ai_note` 计算 md5，**全部不匹配** `a2cf9f75a8b44f5b91d4cf4f307aeb3e`。**不要自己算这个哈希** —— 关联请走 §3.2。

### 2.4 `blob_storage\` / `Local Storage\` / `IndexedDB\`（VERIFIED：**均无对话**）

| 位置 | 实测 | 结论 |
|---|---|---|
| `blob_storage\22f1d700-b72c-4c78-8b4e-8c755eca03b1\` | **完全为空（0 个 blob 文件）** | **回答不可能在这里** |
| `Local Storage\leveldb\` | 752 B 总计（`000003.log` 125 B）；字节串 `composer`=0、`chat`=0 | 非对话存储 |
| `IndexedDB\vscode-file_vscode-app_0.indexeddb.leveldb\` | 6 文件 3,433 B；`composer`=0、`chat`=0 | 非对话存储 |
| `Session Storage\` | 1,060 B；`composer`=0、`chat`=0 | 非对话存储 |
| `Service Worker\Database\000003.log` | 38,356 B；`composer`=0、`chat`=0 | 非对话存储 |
| `WebStorage\` | 35,826,379 B | Chromium CacheStorage 资源缓存，非对话 |
| `User\History\` | 104 文件 | 文件编辑本地历史，非对话 |

### 2.5 日志给出的运行时路径（VERIFIED，来自 `logs\20260809T180528\main.log`）

```
[LocalAgentStorage] Scanned 2 recent databases (skipped 18 old), found 2 agent headers, deduped to 2
```

`window2\exthost\anysphere.cursor-always-local\Cursor Structured Logs.log`：

```json
{"level":"debug","key":"agent_exec","message":"Agent data cleanup completed",
 "metadata":{"client_version":"3.15.6","layout":"unifiedAgent","scannedProjects":"7",
 "scannedFiles":"0","deletedFiles":"0","projectsDir":"C:\\Users\\lms\\.cursor\\projects","durationMs":"8"}}
```

→ `projectsDir = C:\Users\lms\.cursor\projects`（**（INFERRED，算术吻合）**「2 recent / 18 old」正好对应 20 个 `workspaceStorage\*\state.vscdb`）。

**日志命名但磁盘上不存在的路径（VERIFIED）**：
- `c:\Users\lms\.cursor\worktrees` —— 不存在
- `c:\Users\lms\.cursor\hooks.json` —— **不存在**（即本机**未配置 hooks**）

日志还证明 hooks 服务**是活的**：存在输出通道 `output_.../cursor.hooks.workspaceId-empty-window.log` 与 `cursor.hooks.workspaceId-1786269805118.log`。

---

## 3. 仅凭磁盘判断「agent 已答完、正在等人类」与项目关联

### 3.1 空闲判定（idle detection）

#### 信号 1：`composerData.status`（VERIFIED，最可靠）

```sql
SELECT value FROM cursorDiskKV WHERE key = 'composerData:' || :composerId
-- 读 .status
```

38 个 composerData 的 `status` 实测分布：

| status | 数量 | 含义 |
|---|---|---|
| `"none"` | **27** | 空/草稿，未在跑 |
| `null`（值为 SQL NULL） | 2 | 无法解析，需跳过 |
| `"completed"` | **8** | **本轮已完成** |
| `"aborted"` | 1 | 被中止 |

Cursor 自己的渲染层把本地 composer 状态映射为对外状态（VERIFIED，来自 `workbench.desktop.main.js`）：

```js
function b8v(e){switch(e){
  case "none":       return "idle";
  case "generating": return "running";
  case "aborted":    return "error";
  case "completed":  return "completed";
  default:           return e; }}
```

→ **`status === "completed"` 或 `"none"` = 不忙；`"generating"` = 正在出答案。**

#### 信号 2：`generatingBubbleIds`（VERIFIED）

`composerData.generatingBubbleIds` 是数组。实测全库（38 个）**均为 `[]`**（快照时刻无进行中的生成）。**非空 = 正在生成。** 与信号 1 配合可双重确认。

#### 信号 3：`timingInfo.clientSettleTime`（VERIFIED，可给出完成时刻）

最后一条 assistant 气泡的 `timingInfo.clientSettleTime`（== `clientEndTime`）就是**该轮回答完成的毫秒时间戳**（如 `1750484365218`）。**仅 70/455 气泡有**，老会话可用；新会话改用 ISO `createdAt`。

#### 信号 4：`cursor desktop ls` 的 `status`（VERIFIED，最语义化）

桌面桥返回 `{id,title,source,status,lastUpdatedAt,windowId}`，其中 `status ∈ idle | running | completed | error | unknown` —— **这是官方语义，最省事**。但依赖运行中的 GUI + 门控，见 §4.2。

#### ⭐ 信号 5（**最优**）：hook 事件推送，无需轮询（VERIFIED）

Cursor 支持 `stop` 与 `afterAgentResponse` hook，**由 Cursor 主动把「答完了」和「最后一条回答正文」推给外部脚本**：

- `afterAgentResponse` 收到的 payload 实测字段：`conversation_id`、`generation_id`、`model`、`text`（= **`getLastAiBubble().text`**，即最后一条 assistant 正文）、`input_tokens`、`output_tokens`、`cache_read_tokens`、`cache_write_tokens`
- `stop` 收到的 payload 实测字段：`status`、`loop_count`、`conversation_id`、`generation_id`、`model`、`model_id`、`model_params`、`input_tokens`、`output_tokens`、`cache_read_tokens`、`cache_write_tokens`

证据（VERIFIED，`triggerStopHook` 实现）：

```js
async triggerStopHook(e,t){ ...
  const l = await this._cursorHooksService.executeHookForStep(Vu.stop,{
    conversation_id:n, generation_id:..., model:a, ...c,
    status:t, loop_count:r, input_tokens:..., output_tokens:... });
  if(l && typeof l.followup_message==="string" && l.followup_message.trim().length>0){
    const u=l.followup_message;
    this._composerDataService.updateComposerData(e,{stopHookLoopCount:r+1}),
    this.submitChatMaybeAbortCurrent(n,u,{skipClearInput:!0,skipFocusAfterSubmission:!0,
      isAutoFollowupFromStopHook:!0})
  } ...}
```

**推荐组合**：`stop` hook（判定完成 + 注入）+ `afterAgentResponse` hook（抓取回答正文）。

### 3.2 会话 ↔ 项目目录关联（三条**可用**路径，VERIFIED）

**路径 1（首选，新会话）—— `composerHeaders.workspaceId` → `workspaceStorage\<workspaceId>\workspace.json`**

```sql
SELECT workspaceId FROM composerHeaders WHERE composerId = :composerId;
```
再把 `workspaceId` 当作目录名：
```
C:\Users\lms\AppData\Roaming\Cursor\User\workspaceStorage\<workspaceId>\workspace.json
→ 读 .folder（形如 "file:///c%3A/myFiles/codes/lapis-cv-vscode-v2.0.1"）
```
实测验证（VERIFIED）：
```
c22dc724-…  wsId=0d17d028f8b44d5cb7b90c7814392c22  wsDirExists=YES  folder="file:///e%3A/...m3ae-main_lms230718"
ebed4d47-…  wsId=7528743e31b416a085742122d6d1fed6  wsDirExists=YES  folder="file:///c%3A/myFiles/codes/lapis-cv-vscode-v2.0.1"
```
⚠️ `composerHeaders` 只有 **8 行**，而 `composerData` 有 **38 个** —— 老会话无此行。

**路径 2（覆盖最广）—— `ItemTable` → `composer.composerHeaders` → `allComposers[].workspaceIdentifier.uri.fsPath`**

实测 5 条，**每条都带完整 Windows 绝对路径**：
```
c22dc724-c52a-48b2-837b-4bf318e60c08 | ws=e:\项目\codes\220124_brainTumor\M3AE\260711_胶质瘤项目分割演示打包\m3ae-main_lms230718 | name="Demo data source inquiry"
12443f40-c6ba-4cb6-a86b-cb0b1e329b50 | ws=c:\myFiles\codes\lapis-cv-vscode-v2.0.1 | name=""
ebed4d47-3d27-4e79-88d1-088b124359be | ws=c:\myFiles\codes\lapis-cv-vscode-v2.0.1 | name="Greeting in Chinese"
```
注意：该数组**只含未归档会话且可能被裁剪**（实测 5 条 vs 38 个 composerData）。

**路径 3（新版本会话内嵌）—— `composerData:<id>.workspaceIdentifier.uri.fsPath`**

实测 `composerData:12443f40-…`：
```json
"workspaceIdentifier":{"id":"7528743e31b416a085742122d6d1fed6","uri":{
  "$mid":1,"fsPath":"c:\\myFiles\\codes\\lapis-cv-vscode-v2.0.1","_sep":1,
  "external":"file:///c%3A/myFiles/codes/lapis-cv-vscode-v2.0.1",
  "path":"/c:/myFiles/codes/lapis-cv-vscode-v2.0.1","scheme":"file"}}
```
⚠️ **仅 `_v:17` 及更新会话有此字段**；实测 `c22dc724`（老会话）为 `undefined`，`empty-state-draft` 只有 `{"id":"empty-window"}`（无 uri）。

**路径 4（转录文件路径推导）**：`.cursor\projects\<sanitized-workspace-path>\agent-transcripts\` 的目录名就是项目路径折叠而来（见 §2.1），可从目录名反推项目（需注意 `-` 与真实 `-`/`_` 不可逆，只能模糊匹配）。

**辅助**：`storage.json` 的 `profileAssociations.workspaces`（folder URI → profile）与 `windowSplashWorkspaceOverride.layoutInfo.auxiliarySideBarWidth`（含 workspaceId 列表）可用于交叉验证。

### 3.3 「无文件夹窗口」特例（VERIFIED）

`empty-window` 与 `1786269805118` 这类 workspaceId **没有 `workspace.json`**，也不对应任何磁盘项目。判定时要单独处理：`composerHeaders.workspaceId IN ('empty-window')` 或 `composerData.workspaceIdentifier` 无 `uri`。

---

## 4. 注入（injection）通道 —— 按可用性排序

### 4.1 ❌ 结论先行：**没有 `cursor-agent` CLI，也没有 headless print 模式**

| 查找项 | 结果 |
|---|---|
| `cursor-agent` 可执行文件 | **不存在** —— 全安装目录 `.exe` 枚举**只有 11 个**：`Cursor.exe`、`code-tunnel.exe`、`cursor-tunnel.exe`、`helpers\node.exe`、`helpers\crepectl.exe`、`helpers\cursorsandbox.exe`、`@vscode\ripgrep\bin\rg.exe`、`node-pty\...\OpenConsole.exe`、`winpty-agent.exe`、`tools\inno_updater.exe`、`unins000.exe` |
| `cursor-agent` / `agent-cli` 字符串 | 仅命中内置扩展 id `anysphere.cursor-agent-exec/-host/-worker`、`cursor-local-agent-runtime`（**IDE 内扩展，不是 CLI**）|
| `--print` / `print-mode` / `--resume` | **0 命中**（在 `out\cli.js` 与 `cliProcessMain.js` 中均无）|
| `headless` 作为产品 flag | 只存在于 `enable-smoke-test-driver` 选项块（`headless:{type:"boolean"}`），**是测试驱动，不是用户功能** |
| `--yolo` / `cli-config.json` / `approvalMode` | 安装目录内 **0 命中**（只出现在 `.cursor\skills-cursor\update-cli-config\SKILL.md` 描述**外部** CLI 的文档里）|
| `~/.cursor/cli`、`~/.cursor/cli-config.json` | **不存在** |
| `npm` 安装 `@cursor/sdk` / `cursor-sdk` | **不可行**（npm registry 不可达）|

**`cursor agent` 是一个「已声明但未接线」的桩**（VERIFIED）：
`cursor.cmd --help` 确实打印 `agent   Start the Cursor agent in your terminal.`，且该 spec 存在于 6 个 bundle（`out\cli.js` @188778）：

```js
On={agent:{type:"subcommand",description:"Start the Cursor agent in your terminal.",options:{}},desktop:C1}
```

但 `out\cli.js` 中**没有任何 `if(t.agent)` / `case "agent"` 分支**；唯一分派是：
```js
for(const r of sr)if(t[r]){...}      // sr = ["tunnel"]
if(t.desktop)return V2(t.desktop);
```
含 `agent` 的 spec `E1` **只被帮助渲染函数 `zl(e)` 引用**。实测：`cursor.cmd agent --help` 打印的**与顶层完全相同**的帮助。

**→ 「用 `cursor-agent --resume` 做无头续跑」在 Cursor 3.15.6 上不可行。**

### 4.2 ⚠️ 通道 A：`cursor desktop ls` / `cursor desktop send` —— **真实存在、代码完整，但本机门控关闭**

**这是唯一一个官方的、面向「外部进程向某会话发消息」的通道。**

#### 4.2.1 官方用法字符串（VERIFIED，verbatim，来自 `out\cli.js` → `out-build/vs/code/node/cliDesktopBridge.js`）

```
Usage: cursor desktop <command>

Interact with chat threads in a running Cursor desktop app.

Commands
  ls                                List threads live in running desktop instances
  send <thread> [text...]           Send a message to a live desktop thread

Options
  --json                            Machine-readable output
  --force                           (send) Submit immediately, interrupting a running turn
  --stdin                           (send) Read message text from stdin
  -h --help                         Print usage

<thread> is a thread id from `cursor desktop ls`, or a unique prefix of one.
```

`ls` 的表格列头（VERIFIED）：`["THREAD ID","TITLE","SOURCE","STATUS","WHERE"]`

#### 4.2.2 传输层（VERIFIED，全部实测自代码）

```
发现目录 : %USERPROFILE%\.cursor\desktop-bridge\   （可用环境变量 CURSOR_DESKTOP_BRIDGE_DIR 覆盖）
发现文件名: <sha256(userDataPath) 前 16 位 hex>.json
            本机 userDataPath = C:\Users\lms\AppData\Roaming\Cursor
            → 11df42ef9eddcdb1.json
发现文件内容: {protocolVersion, pid, socketPath, token, appName, appVersion, userDataDir, createdAt}
socketPath : Windows 上是命名管道 \\.\pipe\vscode-ipc-<handle>-sock
             （实测代码：process.platform==="win32" → `\\\\.\\pipe\\vscode-ipc-${e}-sock`）
token      : 32 随机字节的 hex（客户端校验正则 /^[0-9a-f]{64}$/）
协议版本   : protocolVersion === 1
请求       : HTTP POST 到 path "/"，header  authorization: "Bearer <token>"
             body: {"type":"listThreads"} 或 {"type":"sendMessage","threadId":...,"text":...,"force":...}
最大请求体 : 256 KiB；最大线程数 200；客户端超时 10 s
```

服务端鉴权（VERIFIED，主进程 `desktopBridgeMainService`）：

```js
isAuthorized(e){const t=e.headers.authorization, r=this.token;
  if(typeof t!=="string"||r===void 0)return!1;
  const i=Buffer.from(t), s=Buffer.from(`Bearer ${r}`);
  return i.byteLength===s.byteLength && _Z(i,s);   // crypto.timingSafeEqual
}
handleRequest(e,t){
  if(e.url!=="/"){xn(t,404,{error:"not_found"});return}
  if(e.method!=="POST"){xn(t,405,{error:"method_not_allowed"});return}
  if(!this.isAuthorized(e)){xn(t,401,{error:"unauthorized"});return}
  ... }
```

`sendMessage` 服务端语义（VERIFIED）：

```js
async sendMessage(e){ for(const r of this.orderedWindows()){ ...
  i = await this.nativeHostMainService.runActionInWindow(void 0,{windowId:r.id,
        actionId:"composer.desktopBridge.sendMessage",
        args:this.bridgeActionArgs(r.id,{threadId:e.threadId,text:e.text,force:e.force}),
        waitForResult:!0});
  switch(i.outcome){ case"not-found":continue;
    case"submitted": case"queued": return {status:i.outcome, threadId:e.threadId, windowId:r.id, threadTitle:i.threadTitle};
    case"not-sendable": return {status:"not-sendable", reason:i.reason};
    ... } } }
```

渲染层最终调用的是**与 UI 发送完全相同的内部 API**（VERIFIED）：

```js
await a.submitChatMaybeAbortCurrent(l.threadId, l.text, {
  skipFocusAfterSubmission:!0,
  submitEventCtx:{source:"desktop_bridge"},
  ...l.force===!0?{ignoreQueuing:!0}:{} })
```

返回值（VERIFIED，`status` 全集）：`submitted` | `queued` | `not-sendable` | `error` | `timeout` | `unknown-thread` | `unknown`。
`not-sendable` 的原因字符串（VERIFIED）：`"Draft threads cannot accept messages."`、`"Claude Code threads cannot accept messages."`。
判定规则：`threadId` 不在 `allComposersData` → `not-found`；`isDraft` → `not-sendable`；**若线程当前 `status === "generating"` 且 `force !== true` → `queued`**（排队到本轮结束后才提交）；`--force` 则 `ignoreQueuing` 立即打断当前轮。

#### 4.2.3 门控（VERIFIED）—— **本机当前不可用**

```js
function o8v(e){return e.isBuilt ? e.featureGateEnabled && e.userEnabled : !0}
function CZd(e,t,n){return o8v({isBuilt:e.isBuilt,
  featureGateEnabled:t.checkFeatureGate("desktop_bridge",{disableExposureLog:!0}),
  userEnabled:Gp(n,"desktopBridgeUserEnabled")})}
```

即需 **同时**满足：
1. Statsig feature gate **`desktop_bridge`** = true
2. 用户设置 **`desktopBridgeUserEnabled`** = true（默认 **false**）
3. 非 dev 构建时两者都要；dev 构建（`isBuilt === false`）恒为 true

**本机实测状态（VERIFIED）**：
- `ItemTable` 键 **`cursor.desktopBridge.enabled` = `false`** ← gate 缓存值为假
- `%USERPROFILE%\.cursor\desktop-bridge\` 目录 **不存在**
- 运行 `cursor.cmd desktop ls` → **stdout/stderr 全空，exit 0**（`A1()` 读到 0 个实例 → `me(...,"no running Cursor desktop instance found (is the app open?)")`；因为 `--json` 未加，消息走 stderr）
- 实测时刻 `Get-Process Cursor` **无进程**，命名管道列表中也无 `vscode-ipc-*`

**UI 开关位置（VERIFIED，来自 `workbench.desktop.main.js` 设置面板）**：
- 分类 **Beta** → 分组 **Desktop Bridge**
- 标签：**"Allow CLI to access desktop agents"**
- `settingKey: "desktopBridgeUserEnabled"`，默认值 `nh(!1,-1,0)` = **false**
- 描述原文：`Enable the cursor desktop CLI command, which lists and sends messages to agent threads open in this desktop app. **Restart Cursor after changing this setting.**`

**→ 可行性判断**：这是一条**真实、受官方支持、有 JSON 输出**的注入通道，但（a）需要 GUI 在运行，（b）需要 Beta 开关打开 **且** Statsig gate `desktop_bridge` 放行，（c）改设置需重启 Cursor。**本机在快照时处于关闭状态，因此我无法完成一次真实的端到端注入验证** —— 我验证到的是**完整代码路径 + CLI 可执行 + 门控关闭**这一层。

### 4.3 ✅ 通道 B（**推荐**）：Cursor **Hooks** —— `stop` hook 返回 `followup_message` 自动续跑

**这是本报告最重要的发现**：Cursor 内置了「agent 停下 → 外部脚本决定是否继续 → 自动提交下一条用户消息」的官方闭环，**无需任何 gate、无需 GUI 之外的额外组件**。

#### 4.3.1 机制（VERIFIED，主进程/渲染层实现）

```js
async triggerStopHook(e,t){
  if(!this._cursorHooksService.hasHookForStep(Vu.stop)) return;
  ...
  const l = await this._cursorHooksService.executeHookForStep(Vu.stop, {
     conversation_id:n, generation_id:..., model:a, ...,
     status:t, loop_count:r, input_tokens:..., output_tokens:... });
  if(l && typeof l.followup_message==="string" && l.followup_message.trim().length>0){
     const u = l.followup_message;
     this._composerDataService.updateComposerData(e,{ stopHookLoopCount: r+1 });
     this.submitChatMaybeAbortCurrent(n, u, {
        skipClearInput:!0, skipFocusAfterSubmission:!0, isAutoFollowupFromStopHook:!0 });
  } }
```

→ hook 脚本在 stdout 输出 `{"followup_message": "..."}`，Cursor 就**把这段文本当作新的用户消息提交给同一会话**。`stopHookLoopCount` 会累加，配合 `loop_limit` 防死循环。

#### 4.3.2 全部 hook 事件名（VERIFIED，`packages/hooks/src/hook-step.ts`）

```
beforeShellExecution, beforeMCPExecution, afterShellExecution, afterMCPExecution,
beforeReadFile, afterFileEdit, beforeTabFileRead, afterTabFileEdit,
stop, beforeSubmitPrompt, afterAgentResponse, afterAgentThought,
sessionStart, sessionEnd, preCompact, subagentStart, subagentStop,
preToolUse, postToolUse, postToolUseFailure, workspaceOpen
```

Claude Code 风格别名映射（VERIFIED，可用于兼容已有脚本）：
```js
{PreToolUse:preToolUse, PermissionRequest:null, PostToolUse:postToolUse,
 UserPromptSubmit:beforeSubmitPrompt, Stop:stop, SubagentStop:subagentStop,
 SessionStart:sessionStart, SessionEnd:sessionEnd, PreCompact:preCompact, Notification:null}
```

#### 4.3.3 配置位置与格式（VERIFIED，来自随安装分发的 `create-hook/SKILL.md`）

位置：
- **项目级**：`<projectRoot>\.cursor\hooks.json` 与 `<projectRoot>\.cursor\hooks\*`（脚本相对**项目根**）
- **用户级**：`~/.cursor/hooks.json` 与 `~/.cursor/hooks/*`（脚本相对 `~/.cursor/`）
- **企业级**：Windows 上 `C:\ProgramData\Cursor\hooks.json`（VERIFIED，来自代码：`Eo ? "C:\\ProgramData\\Cursor" : "/etc/cursor"`，另 macOS `/Library/Application Support/Cursor`）

格式（schema version 1）：
```json
{
  "version": 1,
  "hooks": {
    "stop": [
      { "command": ".cursor/hooks/supervisor.mjs",
        "timeout": 30,
        "loop_limit": 50,
        "failClosed": false }
    ],
    "afterAgentResponse": [
      { "type": "prompt", "prompt": "...$ARGUMENTS...", "timeout": 10 }
    ]
  }
}
```
每个 hook 项可用字段（VERIFIED，校验器 `validators/hooksConfig.ts` 实测）：
`command`（string）、`type`（`"command"` | `"prompt"`，默认 `command`）、`prompt`（type=prompt 时必填且非空）、`model`、`timeout`（**秒**，> 3600 会告警）、`matcher`（**JavaScript 正则**，非 POSIX）、`failClosed`（bool）、`loop_limit`（正整数或 `null`；**主要用于 `stop` / `subagentStop` 的 follow-up 循环**）。

`stop_hook_loop_limit` 顶层键**已废弃**（VERIFIED，代码打印 deprecation warning 并忽略）。

#### 4.3.4 各事件可返回字段（VERIFIED，来自 `create-hook/SKILL.md` 的 Event Output Cheat Sheet）

| 事件 | 可返回字段 |
|---|---|
| `preToolUse` | `permission`, `user_message`, `agent_message`, `updated_input` |
| `postToolUse` | `additional_context`（MCP 工具还可 `updated_mcp_tool_output`）|
| `subagentStart` | `permission`, `user_message` |
| **`stop`** | **`followup_message`** |
| **`subagentStop`** | **`followup_message`** |
| `beforeShellExecution` / `beforeMCPExecution` | `permission`, `user_message`, `agent_message` |
| `beforeSubmitPrompt` | `continue`（false 则拦截提交）、`user_message` |

`beforeSubmitPrompt` 拦截逻辑（VERIFIED，代码实测）：
```js
if(by && by.continue===!1){
  const cA = by.user_message ?? "A beforeSubmitPrompt hook blocked this submission.";
  ... }
```
→ 也是**一条可注入/改写用户输入的通道**。

退出码语义（VERIFIED）：`0` = 成功；`2` = 阻止该动作（等同 deny）；其它非零 = 默认 fail open（除非 `failClosed: true`）。
hook 是**JSON over stdin/stdout**；`hooks.json` **保存后被监听并热重载**（不生效则重启 Cursor）。

#### 4.3.5 `loop` skill —— Cursor 自带的「循环」参考实现（VERIFIED）

`C:\Users\lms\.cursor\skills-cursor\loop\SKILL.md`（3,853 B）实现了 `/loop [interval] <prompt>`，靠**监控 shell 输出**唤醒 agent：

```bash
while true; do
  sleep <seconds>
  echo 'AGENT_LOOP_TICK_<purpose> {"prompt":"<prompt>"}'
done
```
用 `notify_on_output` + 正则 `^AGENT_LOOP_TICK_<purpose>` 触发。**这属于「agent 自我调度」，不是外部 supervisor**，但它是理解 Cursor 设计意图的有力佐证：**Cursor 期望用 hook / 被监控的 shell 输出来做循环，而不是外部进程改数据库。**

### 4.4 ✅ 通道 C：MCP server 作为「下一条指令信箱」

**支持（VERIFIED）**，配置位置实测自代码：

```js
function wDo(e){const t=mFe(e);
  if(t==="project") return e.projectPath!==void 0 ? `${e.projectPath}/.cursor/mcp.json` : void 0;
  if(t==="user")    return "~/.cursor/mcp.json"; }
// 用户级路径解析（代码实测）
async getUserConfigFilePath(){
  const e = await this.pathService.userHome({preferLocal:!1});
  return this.uriIdentityService.extUri.joinPath(e,".cursor","mcp.json"); }
```
UI 文案亦确认（VERIFIED）：
- `<project-root>/.cursor/mcp.json`（项目级）
- `~/.cursor/mcp.json`（用户级）
- 另有 team/dashboard 托管与 plugin 来源

条目结构（VERIFIED，代码里的校验/构造逻辑）：**stdio** 用 `command` + 可选 `args` / `env`；**远程** 用 `url` + 可选 `headers` / `auth`（`CLIENT_ID`/`CLIENT_SECRET`），并有 OAuth 支持（`deleteMcpOAuthToken`、`mcp.discovery.source.*`）。**二者互斥**（同时给 `command` 与 `url` 会报 `must not contain both command and url`）。

CLI 辅助（VERIFIED）：`cursor --add-mcp <json>` → `cliProcessMain.js` 的 `addMcpDefinitions(...)`；写入 `.cursor/mcp.json` 时在非 Windows 上会 `chmod 0600`。

本机实测（VERIFIED）：
- `C:\Users\lms\.cursor\mcp.json` —— **不存在**
- `C:\Users\lms\AppData\Roaming\Cursor` 下 `mcp*.json` —— **0 命中**
- `User\settings.json` 中无 mcp 相关键
- 但**内置两个托管 MCP server 正在运行**（日志）：`cursor-app-control` 与 `cursor-ide-browser`，状态 `none → connected`；工具描述落在 `.cursor\projects\<ws>\mcps\<server>\tools\*.json`

**作为信箱的可行性（INFERRED）**：外部进程可以起一个 stdio MCP server，暴露例如 `next_instruction()` 工具，由 agent 每轮主动调用。
- ⚠️ **不构成主动注入**：agent 必须**主动调用**该工具；「每轮都调用」需要靠 **rules 文件（§4.5）明确指示**，而模型可能漏调。
- ⚠️ 需要重启/刷新 MCP 配置；沙箱日志显示 `Sandbox prerequisites configured for stdio MCP: supported=false`（本机 stdio MCP 沙箱不开启）。
- ✅ 但 `cursor-app-control` 这个内置 MCP server 本身就是「控制 Cursor 本体」的工具集，包含 `rename_chat` 等 —— 说明 **Cursor 官方承认「让 agent 通过 MCP 操作 Cursor」是设计内的**。

### 4.5 ✅ 通道 D：项目规则文件（`.cursor/rules/*.mdc` / `.cursorrules`）

**支持（VERIFIED）**：
- 代码实测：`(e.scheme==="file"||e.scheme==="vscode-remote") && e.path.endsWith(".mdc")`；`isSubagentRelatedPath` 特判 `.cursor/agents` 与 `.cursor/rules`；导入功能写入 `.cursor/rules/imported/<repo>/`
- `.mdc` 模板内容实测：开头是 `--- alwaysApply: true --- `（front-matter 风格）
- 规则可被 `@` 提及选中：`cursor-rule:<filename>` 类型
- **旧格式 `.cursorrules` 仍被识别**（VERIFIED，file-tag 表里有 `{tag:"cursorrules", filePattern:/^\.cursorrules$/i}`）
- 用户级目录实测：`C:\Users\lms\.cursor\rules` —— **不存在**（`rules\SKILL.md` 也存在，说明可创建）

**作为「轮询信箱」的指令载体（INFERRED，实用但有风险）**：可在 `.cursor/rules/supervisor.mdc`（`alwaysApply: true`）里写「每轮结束前必须调用 MCP 工具 `next_instruction`，若返回内容非空则按其执行」。**但这依赖模型服从**，不是强制机制 —— 会漏、会被上下文压缩丢掉。**优先级应低于 §4.3 的 hook 方案。**

### 4.6 ❌ 通道 E：VS Code / Cursor 的 IPC 与扩展宿主 API —— **没有公开的「发聊天消息」API**

- 内部 API 确实存在（VERIFIED）：`_composerChatService.submitChatMaybeAbortCurrent(composerId, query, opts)`。这是 UI 发送、plan 执行、以及 **stop hook followup** 共用的入口。
- 但它是**内部服务**，未暴露为 `vscode.*` 扩展 API；`contributes` 层面实测：`cursor-agent-exec`/`cursor-agent-host`/`cursor-local-agent-runtime` 的 `contributes` 均为 **`{}`**（空），`cursor-mcp` 的 `commands`/`keybindings`/`menus`/`configuration` 也**全为空**。
- 唯一实际存在的命令 id（VERIFIED）是内部动作 id：`composer.desktopBridge.listThreads` / `composer.desktopBridge.sendMessage`（**只能由 `cursor desktop` CLI 经命名管道触发**），以及 `cursor.generateGitCommitMessage`、`cursor-agent-exec.mountAgentStore` 等。
- 扩展宿主暴露的命令里**没有**「向指定会话发送消息」。**→ 写一个 Cursor 扩展来做注入：无公开 API 可用，只能走上述桥或 hook。**

### 4.7 `cursor.cmd` 的命令行开关（VERIFIED，实测 `--help`）

`cursor.cmd` 内容（VERIFIED，172 B 全文）：
```bat
@echo off
setlocal
set VSCODE_DEV=
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\..\..\Cursor.exe" "%~dp0..\out\cli.js" %*
IF %ERRORLEVEL% NEQ 0 EXIT /b %ERRORLEVEL%
endlocal
```
即：把 `%*` 原样转给 `Cursor.exe`（以 Node 方式运行 `resources\app\out\cli.js`）。**这是标准 VS Code CLI**，无 agent 相关开关。

实测 `cursor.cmd --help` 列出的相关选项：

| 选项 | 用途 |
|---|---|
| `<paths...>` | 直接打开文件夹/文件（**这是「打开某个项目」的标准做法**）|
| `-a --add <folder>` / `--remove <folder>` | 向最后活动窗口增删文件夹 |
| `-g --goto <file:line[:character]>` | 打开文件到指定行列 |
| `-d --diff <f1> <f2>` / `-m --merge ...` | 文件比对/三方合并 |
| `-n --new-window` / `-r --reuse-window` / `-w --wait` | 窗口行为 |
| `--user-data-dir <dir>` / `--profile <name>` | 指定用户数据目录/配置档 |
| `--chat` | 打开独立聊天窗口（不带完整 IDE）|
| `--add-mcp <json>` | 添加 MCP server 定义（**已接线**，见 §4.4）|
| `--glass` / `--classic` / `--web-worker-exthost` | dev-only |
| `tunnel` | 子命令 → `cursor-tunnel.exe` |
| `agent` | **帮助里列出但无实现**（见 §4.1）|

Windows 上 `cursor.cmd`、`cursor`、`code-tunnel.exe`、`cursor-tunnel.exe` 位于 `C:\Softwares\cursor\resources\app\bin\`，**该目录在 `PATH` 上**。

---

## 5. 推荐方案：Cursor 专属的「外部 supervisor 闭环」

### 5.1 结论一览

| 通道 | 读「最后回答」 | 注入「下一条消息」 | 需要 GUI | 需要 gate | 状态 |
|---|---|---|---|---|---|
| `state.vscdb` → `bubbleId:*` | ✅ **可以** | ❌ 不行 | 否 | 否 | **VERIFIED 可用** |
| `.cursor\projects\…\agent-transcripts\*.jsonl` | ✅ 可以（但覆盖极少） | ❌ 不行 | 否 | 否 | VERIFIED，本机仅 1 个文件 |
| `conversation-search.db` FTS body | ⚠️ **滞后 ≥1 轮，不可用于最新回答** | ❌ 不行 | 否 | 否 | VERIFIED |
| **`stop` hook → `followup_message`** | ✅（`afterAgentResponse` 直接给 `text`）| ✅ **可以（官方机制）** | ✅ 需要 | ❌ **无 gate** | **VERIFIED（代码级）** |
| `beforeSubmitPrompt` hook | — | ✅ 可拦截/注入 `user_message` | ✅ 需要 | ❌ | VERIFIED |
| `cursor desktop send` | ✅（`ls` 给 status/id）| ✅ **可以** | ✅ 需要 | ⚠️ **需要 gate `desktop_bridge` + Beta 开关**，**本机当前关闭** | VERIFIED 代码；本机不可用 |
| MCP 信箱 | — | ⚠️ 需 agent 主动调用 | ✅ 需要 | ❌ | VERIFIED 配置格式 |
| `.cursor/rules/*.mdc` | — | ⚠️ 只能「请求」agent 行为 | ✅ 需要 | ❌ | VERIFIED 支持 |
| `cursor-agent` CLI / headless | ❌ | ❌ **不存在** | — | — | VERIFIED 不存在 |

### 5.2 推荐闭环（优先级从高到低）

#### 🥇 方案 1（首选）：**Hooks 闭环 —— 完全在 Cursor 内，零 gate**

```
[读取]  afterAgentResponse hook
        ← Cursor 推送 { conversation_id, generation_id, model, text=<最后一条 assistant 正文>, *tokens }
        → supervisor 脚本把 text 写出到自己的状态文件

[判定]  stop hook
        ← Cursor 推送 { conversation_id, generation_id, model, status, loop_count, *tokens }
        → 脚本据此判断「是否完成」「是否还需继续」

[注入]  同一个 stop hook 在 stdout 返回 {"followup_message": "<下一条用户消息>"}
        → Cursor 自动调用 submitChatMaybeAbortCurrent(conversation_id, followup_message)
        → agent 继续工作；loop_limit 防死循环
```

`<projectRoot>\.cursor\hooks.json` 示例：
```json
{
  "version": 1,
  "hooks": {
    "afterAgentResponse": [
      { "command": "node .cursor/hooks/supervisor.mjs record", "timeout": 15 }
    ],
    "stop": [
      { "command": "node .cursor/hooks/supervisor.mjs decide", "timeout": 60, "loop_limit": 200 }
    ]
  }
}
```
`supervisor.mjs` 的 `decide` 子命令：读 stdin JSON → 看 `loop_count` 与 `status` → 读自己的信箱/待办文件 → `process.stdout.write(JSON.stringify({ followup_message: next }))` 或输出 `{}`（不返回 `followup_message` 即停止循环）。

**优点**：官方机制、无需 gate、无 Beta 标记、不需要额外的窗口操作、`text` 直接送到手上（不必轮询数据库）、有 `loop_limit` 内建保护。
**缺点**：需要 Cursor 的 GUI 开着（不是 headless）；用户必须愿意在项目里放 `hooks.json`；本质上仍是「Cursor 主动调用你」，而不是「你主动推进 Cursor」。

#### 🥈 方案 2：**`state.vscdb` 读 + `cursor desktop send` 注入**

```
[读取]  copy state.vscdb(+wal+shm) → readOnly 打开
        composerData:<id> → .status / .generatingBubbleIds / .fullConversationHeadersOnly
        → bubbleId:<id>:<bid> .text   ← 最后一条 assistant 正文（§1.4）
[注入]  cursor desktop send <threadId|唯一前缀> --stdin --json < next.txt
        （或 --force 打断当前轮）
```

前置条件（本机**当前不满足**）：Settings → **Beta** → **Desktop Bridge** → 打开 **"Allow CLI to access desktop agents"**，**并重启 Cursor**；且 Statsig gate `desktop_bridge` 必须为真。

**优点**：真正的「外部进程主动注入」，`--json` 可解析，`ls` 直接给语义化 `status`（`idle`/`running`/`completed`/`error`）。
**缺点**：需要重启 Cursor 且受远程 gate 控制（本机 `cursor.desktopBridge.enabled = false`）；只能操作**已在 GUI 打开的线程**，无法创建新会话；`not-sendable`/`queued` 等分支要处理。

#### 🥉 方案 3：MCP 信箱 + rules 提示（**仅作兜底/补充**）

起一个 stdio MCP server 暴露 `next_instruction()`，并在 `.cursor/rules/supervisor.mdc`（`alwaysApply: true`）里要求 agent 每轮调用它。**注入不可靠（靠模型自觉）**，不推荐作为主通道。

### 5.3 明确**做不到**的事（VERIFIED 负面结论）

1. **无头（headless）注入** —— 没有 `cursor-agent` CLI，没有 `--print` 模式，没有 `--resume`。`cursor agent` 子命令在 3.15.6 中是**帮助里存在但未实现的桩**。
2. **不启动 GUI 就注入消息** —— 所有注入通道（hook、desktop bridge、MCP、rules）都要求 Cursor 桌面进程**正在运行**。`cursor desktop send` 在无实例时只输出 `no running Cursor desktop instance found (is the app open?)`。
3. **直接改数据库来注入** —— `cursorDiskKV` 是 Cursor 的**运行时缓存**：它由主进程内存状态持续覆写（WAL、心跳、checkpoint 都会写）。手工插入 `bubbleId`/`composerData` **不会**被 agent 读取（agent 从自己的 handle/内存读），且极易被覆盖或损坏。**不要这么做。**
4. **通过扩展 API 注入** —— 无公开 API（§4.6）。
5. **用 `conversation-search.db` 判断「刚答完」** —— 实测稳定滞后 ≥1 轮（§1.8）。它只适合全文搜索。
6. **从 `conversation-search.db` 拿到会话所属项目** —— 无 folder 列；`root_fingerprint` 算法不可复现（§1.8）。项目关联必须走 `composerHeaders` / `composer.composerHeaders` / `workspaceIdentifier`。
7. **用 `.cursor\projects\…\agent-transcripts\` 作为唯一读取源** —— 本机 38 个会话只有 1 个 `.jsonl`，且内容是脱敏的（9 处 `[REDACTED]`、无 `tool_result`）。
8. **依赖固定 schema** —— `_v` 同时存在 3 与 17；`bubbleId` 的 `createdAt` 只有 67/455、`modelInfo` 只有 4/455；有 12 个键的值为 SQL `NULL`。**解析必须全面容错。**
9. **npm 安装 `@cursor/sdk` / `cursor-sdk` / `cursor-agent`** —— registry 不可达。

---

## 6. 可直接复制的零依赖 Node 读取配方

**依赖**：仅 Node ≥ 22 内置的 `node:sqlite`（`DatabaseSync`）与 `node:fs`。**零 npm 依赖。**

**安全**：先拷贝 `state.vscdb`（**含 `-wal` 与 `-shm`**）到临时目录，再以 `readOnly: true` 打开副本。绝不写真实数据文件。

```js
// cursor-read.mjs  —  用法: node cursor-read.mjs [composerId]
// 输出 Cursor 某会话的元数据 + 最后一条 assistant 回答正文 + 空闲信号
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIVE = join(process.env.APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb');

// 1) 快照：必须连 -wal / -shm 一起拷，然后只读打开副本
function snapshot(live) {
  const dir = mkdtempSync(join(tmpdir(), 'cursor-ro-'));
  const dst = join(dir, 'state.vscdb');
  copyFileSync(live, dst);
  for (const ext of ['-wal', '-shm'])
    if (existsSync(live + ext)) copyFileSync(live + ext, dst + ext);
  return dst;
}
const db = new DatabaseSync(snapshot(LIVE), { readOnly: true });

// 2) 选会话：取最近仍活跃且确有气泡的非草稿会话
const composerId = process.argv[2] ?? db.prepare(`
  SELECT h.composerId
  FROM   composerHeaders h
  WHERE  h.isSubagent = 0 AND h.isArchived = 0
    AND  EXISTS (SELECT 1 FROM cursorDiskKV b
                 WHERE b.key LIKE 'bubbleId:' || h.composerId || ':%')
  ORDER BY h.recency DESC LIMIT 1`).get()?.composerId;

// 3) 会话元数据（务必容错：value 可能是 SQL NULL、字段可能缺失）
const raw = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?')
              .get('composerData:' + composerId)?.value;
if (!raw) throw new Error('no composerData for ' + composerId);
const cd = JSON.parse(raw);

// 4) 倒序走 fullConversationHeadersOnly（唯一权威顺序），取最后一条 assistant 文本
//    type === 1 → user ; type === 2 → assistant
const getBubble = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?');
let last = null;
for (const h of [...(cd.fullConversationHeadersOnly ?? [])].reverse()) {
  if (h.type !== 2) continue;                       // 只要 assistant
  const braw = getBubble.get(`bubbleId:${composerId}:${h.bubbleId}`)?.value;
  if (!braw) continue;                              // 键可能缺失或值为 NULL
  let b; try { b = JSON.parse(braw); } catch { continue; }
  if (b && typeof b.text === 'string' && b.text.trim()) { last = b; break; }
}

// 5) 空闲判定：Cursor 官方把本地 status 映射为对外的 idle/running/completed/error
const STATUS = { none: 'idle', generating: 'running', completed: 'completed', aborted: 'error' };
const idle   = (cd.generatingBubbleIds ?? []).length === 0
            && ['none', 'completed'].includes(cd.status);

// 6) 项目关联：优先 composerHeaders.workspaceId → workspaceStorage\<id>\workspace.json
const wsId = db.prepare('SELECT workspaceId FROM composerHeaders WHERE composerId = ?')
               .get(composerId)?.workspaceId;
let projectDir = null;
if (wsId) {
  const wj = join(process.env.APPDATA, 'Cursor', 'User', 'workspaceStorage', wsId, 'workspace.json');
  if (existsSync(wj)) {
    const folder = JSON.parse(readFileSync(wj, 'utf8')).folder;
    projectDir = decodeURIComponent(folder.replace(/^file:\/\/\//, ''));   // file:///c%3A/... → c:/...
  }
}

console.log({
  composerId,
  title:      cd.name ?? '',
  status:     cd.status,
  bridgeStatus: STATUS[cd.status] ?? cd.status,   // idle / running / completed / error
  isIdle:     idle,
  model:      cd.modelConfig?.modelName ?? null,  // 仅新会话有
  projectDir,                                     // 可能为 null（老会话无 composerHeaders 行）
  lastAssistant: last && {
    bubbleId:   last.bubbleId,
    createdAt:  last.createdAt ?? null,                          // ISO 字符串，仅 67/455 有
    settledAt:  last.timingInfo?.clientSettleTime ?? null,       // ms epoch，仅 70/455 有
    modelInfo:  last.modelInfo?.modelName ?? null,               // 仅 4/455 有
    tokens:     last.tokenCount ?? null,
    textLength: last.text.length,
    text:       last.text,
  },
});
db.close();
```

**该配方实测输出（VERIFIED，真实运行结果）**：

```
{ composerId: 'c22dc724-c52a-48b2-837b-4bf318e60c08',
  title: 'Demo data source inquiry',
  status: 'completed',
  bridgeStatus: 'completed',
  isIdle: true,
  model: 'composer-2.5',
  projectDir: 'e:/项目/codes/220124_brainTumor/M3AE/260711_胶质瘤项目分割演示打包/m3ae-main_lms230718',
  lastAssistant:
   { bubbleId: '419da534-208e-4091-9b82-6a31f0218d4f',
     createdAt: '2026-07-11T05:08:28.116Z',
     settledAt: null,
     modelInfo: null,
     tokens: { inputTokens: 0, outputTokens: 0 },
     textLength: 870,
     text: '可以，**Bandizip 支持只解压压缩包里的部分文件**，不必整包全解。...' } }
```

> `projectDir` 能正确解出，是因为 `composerHeaders.workspaceId` = `0d17d028f8b44d5cb7b90c7814392c22` 命中了 `workspaceStorage\0d17d028…\workspace.json`。**老会话该行不存在，`projectDir` 会是 `null`** —— 此时退回 `ItemTable` 的 `composer.composerHeaders` → `allComposers[].workspaceIdentifier.uri.fsPath`。

**配套：全部会话列表（含项目路径）的零依赖查法**

```js
const list = JSON.parse(db.prepare('SELECT value FROM ItemTable WHERE key = ?')
                          .get('composer.composerHeaders').value);
for (const c of list.allComposers)
  console.log(c.composerId, '|', c.isArchived, '|',
              c.workspaceIdentifier?.uri?.fsPath ?? '(none)', '|', JSON.stringify(c.name ?? ''));
```

---

## 7. 关键结论速查（给实现者）

| 问题 | 答案 |
|---|---|
| assistant 回答能否从磁盘读到？ | **能。** `state.vscdb` → `cursorDiskKV` 表 → 键 `bubbleId:<composerId>:<bubbleId>` → 字段 `.text`（`type === 2`）。顺序取自 `composerData:<composerId>.fullConversationHeadersOnly` 倒序第一个 `type===2`。**无需运行 Cursor，无需凭据。** |
| 会话列表在哪？ | `cursorHeaders` 表（`composerHeaders`）+ `ItemTable['composer.composerHeaders'].allComposers[]`（含项目绝对路径）|
| 每个会话的消息在哪？ | `cursorDiskKV` 的 `bubbleId:<composerId>:<bubbleId>` |
| 每条会话的元数据在哪？ | `cursorDiskKV` 的 `composerData:<composerId>` |
| 怎么判断答完了 / 在等人？ | `composerData.status ∈ {completed, none}` 且 `generatingBubbleIds` 为空；等价官方语义 `idle`/`completed`。最省事的是 hook 推送或 `cursor desktop ls` 的 `status` |
| 怎么关联项目目录？ | `composerHeaders.workspaceId` → `workspaceStorage\<id>\workspace.json` 的 `.folder`；或 `allComposers[].workspaceIdentifier.uri.fsPath` |
| 有真正的注入通道吗？ | **有两条。** ①**`stop` hook 返回 `{"followup_message":"…"}` → Cursor 自动提交为新用户消息**（官方机制，无 gate，推荐）。②`cursor desktop send <thread> [text] --json [--force] [--stdin]`（真实、有 JSON 输出，但需 GUI + Beta 开关 `desktopBridgeUserEnabled` + Statsig gate `desktop_bridge`，本机当前 **关闭**）|
| 有 `cursor-agent` CLI 吗？ | **没有。** 安装目录无该二进制；`cursor agent` 在 `--help` 里列出但无实现；无 `--print`/`--resume`；`@cursor/sdk` 因 npm 不可达而无法安装 |
| 最可靠的闭环？ | **Hooks（`afterAgentResponse` 读 + `stop`/`followup_message` 写）** → 备选 **state.vscdb 读 + `cursor desktop send` 写（需先开 Beta 开关）** |
| 最大风险 | 存储 schema 版本敏感（`_v` 3 vs 17）、字段时有时无（`createdAt` 67/455、`modelInfo` 4/455）、12 个键值为 SQL `NULL`、注入通道受远程 Statsig gate 控制 |

---

*报告基于 Cursor 3.15.6 (commit a1f686545fd0ce8917bbd2449f733551a9bce420) 在本机的实测快照。数据库副本与全部一次性脚本位于 `.recon-tmp\`，未对任何 Cursor 数据文件做写入。*

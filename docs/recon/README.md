# 逆向报告索引

这些报告不是"猜的文档"，而是**实际打开真实文件、跑通真实命令**之后写下来的记录，
逐条标注了「已实测 / 源码确认 / 推断」。它们解释了代码里那些看起来奇怪的写法**为什么**长这样。

| 报告 | 内容 | 最有价值的几条结论 |
|---|---|---|
| [`dsh-session-storage.md`](dsh-session-storage.md) | DSH 会话文件格式 | ① `session.jsonl.zstd` 是**拼接的多帧 zstd**（Node 自带解码器只解第一帧：774KB → 191B）；② 最后一次回答要**反向**找第一条含 `text` 的 `assistant/message`（最后一条可能只有 tool-call）；③ 忙/闲 = 折叠 `turn/start|end`，**最后一个胜出**；④ 并发读安全：丢掉不完整的尾帧永不产生半行 |
| [`dsh-control-surfaces.md`](dsh-control-surfaces.md) | DSH 外部控制面 | ① headless **没有** `--resume`（每次全新会话），stdout = 最后一条回答；② `POST /api/session.prompt` 真能往活会话插话（`queue`/`steer`）；③ 有现成的 `goal-round-driver` 可以复用；④ SDK JSON-RPC 通道需要先等 `initialize`（帧不串行化）；⑤ **安全：`/api` 无认证，且用户的 web profile 绑在 0.0.0.0** |
| [`codex.md`](codex.md) | Codex CLI | ① `state_5.sqlite/threads` 是权威 cwd→会话索引；② rollout 的 **mtime 不更新**（只有 ctime 走）→ 用 mtime 判活会永远误判；③ `user_message` 没有 turn_id，要归给前一个 `task_started`；④ 单行可达 21MB 必须跳过 |
| [`opencode.md`](opencode.md) | opencode | ① 事件溯源 + 投影：读 `message`/`part` 而不是 `event`；② `step-finish.reason === 'stop'` 才是真的收工；③ `run -c` **不按 cwd 过滤**（永远显式 `-s`）；④ `run` 默认自动拒绝权限请求 |
| [`cursor.md`](cursor.md) | Cursor IDE 3.15.6 | ① 回答在 `cursorDiskKV['bubbleId:…'].text`，顺序看 `composerData.fullConversationHeadersOnly`；② **官方 `stop` 钩子返回 `{"followup_message":…}` 就能注入**（无门控）；③ `conversation-search.db` 滞后 ≥1 轮，**不能**用来读最新回答；④ `cursor-agent` CLI 不存在 |

## 已被代码采纳的结论

| 结论 | 用在哪 |
|---|---|
| 多帧 zstd 必须逐帧解 | `src/util/zstd-frames.mjs`（DSH 适配器的读取层） |
| 最后一次回答要回退找含 `text` 的 `assistant/message` | `src/adapters/dsh-session.mjs` |
| `turn/start|end` 末次折叠判忙闲、`approval/asked` 配对判审批 | `src/adapters/dsh-session.mjs` |
| `POST /api/session.prompt` 信封（queue/steer） | `src/adapters/dsh.mjs` 的 `whip: 'http'`（且硬编码拒绝非本机地址） |
| headless 无 resume、stdout = 最后一条回答 | `src/adapters/dsh.mjs` 的 `whip: 'headless'` |
| ACP 帧形状与"同连接可多轮" | `src/adapters/acp.mjs` + `src/util/jsonrpc-stdio.mjs`（含"先等 initialize"的竞态规避） |
| codex 的 rollout 只有 ctime 会更新 | `src/adapters/codex.mjs` 的活跃判定 |
| `user_message` 没有 turn_id | `src/adapters/codex.mjs` 的回合归并 |
| opencode 的 `step-finish.reason === 'stop'` 判收工 | `src/adapters/opencode.mjs` |
| Cursor 的 `stop` 钩子 `followup_message` | `src/hooks.mjs`（`cw hooks install cursor`） |
| Cursor 只读 `cursorDiskKV`、search.db 滞后 | `src/adapters/cursor.mjs` |
| sqlite 惰性打开 + WAL 需拷贝 | `src/util/sqlite.mjs` |

## 复现方式

报告里附的探针脚本、数据库副本与原始 JSON 证据都在 `.recon-tmp/`（已 gitignore），
例如 `codex-recipes.mjs`（147 行，实测跑通）与 `opencode-recipes.mjs`（99 行，实测跑通）。

## 注意

- 报告里提到的路径、版本号都是**当时那台机器**的状态（Cursor 3.15.6、DSH 0.1.1-rc.2 等）；
  这些格式会随版本变化，代码里的解析都做了容错，但升级后建议重跑一次 `cw doctor`。
- 报告中不含任何密钥内容。若你发现某个工具的凭据是明文存放的，建议轮换并收紧文件权限
  （`docs/SAFETY.md` 里有一条真实发现）。

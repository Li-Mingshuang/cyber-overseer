# 更新日志

本项目的版本记录。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

### 新增

- **多 agent 并行监工**：配置 `agents: [...]`，一个监工进程并行盯多个 agent（Cursor 写前端、codex 改后端）。
  每个条目独立判定/抽鞭（自己的 adapter / 目录 / 方案 / 判定器），轮次/时长/花费**共享一套预算**
  （不会变成 N 倍账单），分项报告 `CW-REPORT-<name>.md` 与独立事件流 `.cyber/agents/<name>/`，
  总报告把结果与预算去向合并成一张表；任一 agent 出错被隔离，不影响其它
- **`cw status --watch`**：终端实时面板——当前轮次、最近判定、最近一条鞭子、验收命令状态、花费、
  距静默期还有多久；多 agent 与单 agent 共用一套渲染；"状态说在跑但很久没落盘"会提示"可能已停"
- **Windows 原生 toast 通知**（`notify.toast`，默认 Windows 上开）：收工/卡住时弹一条，
  内容用 base64 传递（不会变成命令注入）；`cw toast` 可当场自检（本机实测 `CW_TOAST_OK`）
- **DSH 的 SDK stdio JSON-RPC 通道**（`adapter: 'dsh-jsonrpc'`）：常驻 `dsh --profile jrpc` 进程，
  `session/prompt` 注入 + `session.event` / `session.status` 事件流观测；`cw dsh-profile --install`
  一键建 profile（写清单 + patch + pnpm-workspace，并把插件包软链到 `profiles/node_modules`，免管理员），
  已存在的文件绝不覆盖；协议竞态（必须先等 `initialize` 再发 prompt）由单测与真子进程夹具双重钉死
- **拟人通道的 macOS / Linux 驱动**：`osascript`（System Events，Ctrl 组合自动翻成 Command、
  辅助功能权限检测）与 `xdotool` + `xclip/xsel/wl-clipboard`（Wayland 与缺依赖会明确说不可用，
  宁可不动也不误发）；三平台统一接口，`cw doctor` / `cw windows` 给出本平台结论
- **读回强化**：焦点被输入框抢走时，按一串候选点（`readerClickPoints`）挨个"点对话区 → 再复制"；
  可选 `blurComposer: 'esc'` 先把焦点赶出输入框
- **证据强化（两条）**：① 方案文档"合同"防篡改——验收标准/禁止事项/任务清单在第一轮取基线，
  之后任何移除或改写都判定为"改弱了"并**拒绝收工**（`evidence.planGuard`，可用
  `allowPlanWeakening` 显式放行）；② 验收命令的**历史趋势**进报告（"从红到绿 / 一直通过 / 仍未通过"），
  不再只看最后一次
- **`cw "<一句话>"` 一句话起步（零配置）**：自动选 agent（优先 DSH，且本项目已有会话就接着那段对话）、
  嗅探验收命令（package.json / pytest / cargo / go / make / verify.mjs）、生成方案文档
  （写进 `.cyber/PLAN.md`，不碰项目根的 PLAN.md）、直接开跑，并把决定打印给你过目。
  开关：`--plan-only`、`--agent`、`--session`、`--cmd`、`--verify`、`--max-rounds`、`--no-join`
- **`cw sessions --live`**：看清有哪些 agent 会话还活着（● 正在跑 / ○ 空闲在等人 / ▲ 等审批 /
  ▲ 等你回话 / ✖ 出错），带相对时间、标题、项目路径、回合数与事件数
- **`cw ui` 本地图形界面**（零依赖、单文件前端、只监听 127.0.0.1 并校验 Host 头），
  顶部就是「一句话起步」输入框；实时时间线显示每轮判定与抽出去的鞭子原文
- **判定器零配置分支**：没有任务清单时，用「验收命令全绿 + agent 完成宣告（`CW:DONE`）+ 卡死检测」
  判定；验收全绿但没宣告会先要求自查一次，问过之后仍全绿才收工
- CLI 覆盖参数 `--report` / `--journal-dir` / `--state-file`（配合"以项目目录为工作目录"启动）

### 修复

- **拟人通道的焦点探针会删掉主人正在写的草稿**：旧实现"粘贴探针 → Ctrl+A → Delete"清理，
  而"输入框里有没有草稿"是在这之后才检查的——等于先毁掉再检查。现在改成"只读预检 + **Ctrl+Z 撤销**"，
  并在读回"草稿 + 探针"时明确返回 `draft`，调用方一个字符都不动地放弃这一鞭
- **方案文档里的"标记说明文字"被当成 agent 的宣告**：自动生成的方案会写"教 agent 怎么写标记"，
  而判定当时拿方案文档去匹配 `<!-- CW:DONE -->` / `<!-- CW:BLOCKED -->`，导致监工一看方案就判定
  受阻、或凭空判定已完成直接收工。现在标记**只认 agent 的回答**（方案里的字面标记要显式开
  `judge.rule.trustPlanMarker`），生成方案时也不再写出标记的字面形式
- **界面启动监工时相对路径被拼重**：项目配置里的 plan/report/journal/state 常写成"相对仓库根"，
  界面以项目目录为工作目录 → 路径被拼重（实测报错 `读不到方案文档 .../a/a/PLAN.md`）。
  现在界面把这些路径显式钉到项目目录，读取侧也用同一套路径
- 拟人通道：**焦点漂移**（主人中途切窗导致按键/复制作用到别的窗口）与**旧剪贴板被当成 agent 回答**
  两个静默误判路径，分别用"每批按键前复查前台窗口"与"剪贴板哨兵 + 写后回读校验"修掉
- `.ps1` 必须带 UTF-8 BOM（Windows PowerShell 5.1 无 BOM 时按 GBK 读，中文注释会吞引号导致语法错）：
  新增 `npm run fix:ps1-bom` 与 lint 强制检查

### 工程

- 测试 **55 → 134 个用例**：新增多 agent 并行与共享预算、实时面板渲染、toast 防注入、
  三平台驱动（假的 runFn 覆盖命令构造与解析）、DSH JSON-RPC（进程内假传输层 + 真子进程夹具）、
  合同防篡改与验收历史
- `templates/dsh-profile-jrpc/` 的模板文件由生成器产出，并被测试**逐字节比对**（防止文档漂移）
- 文档同步：`docs/ADAPTERS.md` 增加 DSH JSON-RPC 一节与三平台驱动对照表，
  `docs/DESIGN.md` 记录"证据会不会被骗"的两条加固，`docs/SAFETY.md` 记录草稿保护的教训

### OCR

- **接入 RapidOCR（PaddleOCR PP-OCR + ONNX）为默认 OCR 引擎**：`npm run ocr:install` 一键装进
  仓库内隔离 venv；实测中文正文识别字符相似度 **96.4%** vs Windows 自带 **53.7%**
- 可插拔引擎层（rapidocr / windows / command / vlm）+ `npm run bench:ocr` 在自己机器上量准确率

## [0.1.0] — 2026-09-17

第一个可用版本：**让 agent 在人类主人休息时，被抽着把活干完。**

### 核心

- **判定基于证据，不基于 agent 自述**：验收命令的真实退出码 > 方案复选框勾选（每轮重读）>
  工作区改动指纹；判不了就 `needs-human`，绝不瞎猜完成
- **判定器**：`rule`（零成本、可离线）/ `llm`（任意 OpenAI 兼容端点，严格 JSON，解析失败不猜）/
  `human`（终端或文件裁决）/ `chain`（默认：规则优先，判不了才花钱问模型）
- **主循环**：等 agent 空闲 → 读最后一次回答 → 采证据 → 判定 → 抽鞭 → 再判定；
  支持断点续跑、演练模式（`cw watch`）、暂停哨兵（`cw pause`）
- **护栏**：轮次 / 时长 / 花费 / 无进展熔断 / 受阻熔断 / 静默期 / 工作时段 /
  审批不替主人放行 / 失败分类（setup / transient / fatal）
- **交代**：`CW-REPORT.md`（人话报告：为什么停、每轮判定与鞭子原文、还剩什么）+
  `.cyber/journal.jsonl`（机器可读完整事件流）

### 七条抽鞭通道（都能闭环）

| 通道 | 说明 |
|---|---|
| **DSH** | 读多帧 zstd 的 `session.jsonl.zstd`；鞭子走 `dsh --profile headless` / `POST /api/session.prompt` / 拟人 / 自定义命令 |
| **Codex CLI** | 读 `state_5.sqlite` + rollout.jsonl；`codex exec resume` |
| **opencode** | 读 `opencode.db` 投影表；`opencode run -s` |
| **Cursor** | 读 `state.vscdb`；官方 `stop` 钩子返回 `followup_message`（无门控，由 Cursor 自己驱动） |
| **ACP** | Agent Client Protocol 标准通道：同一连接多轮投喂（兼容 DSH / opencode / Zed 生态） |
| **拟人通道** | 任何 GUI agent：UIA/剪贴板读对话框 + 抢焦点粘贴回车，带三道保险 |
| **通用 CLI / MCP 信箱** | 任何 CLI agent / 任何支持 MCP 的 agent |

### 拟人通道的三道保险（唯一能造成不可逆影响的通道）

1. **空闲保险丝**：系统键鼠空闲未达阈值绝不动手（"主人在休息时才抽鞭"是硬条件）
2. **焦点确认 + 漂移复查**：抢焦点后回读前台窗口；每一批按键前再复查一次——
   主人中途切窗时立刻放弃，绝不把字打进别人的窗口
3. **回车前校验**：`Ctrl+A/Ctrl+C` 读回输入框内容与鞭子比对，不一致就放弃，错误指令永不发出

### 实测验证过的事

- 拟人通道端到端（Windows + Chromium 页面）：空闲保险丝 / 抢焦点 / 焦点探针 / 粘贴 /
  回车前校验 / 回车 / 中文与全角符号送达 ✅（`npm run verify:human-sim`）
- ACP 真机握手：对接真实 DSH ACP 服务端 `initialize` → `session/new` → `session/cancel`，
  **零 token 消耗** ✅（`npm run verify:acp`）
- 四家真机会话读取：DSH（解出 5233 个 zstd 帧、准确识别"turn 3 进行中"）、
  codex、opencode（22 会话）、cursor（5 composer）✅
- 离线端到端演示（无网络/无 Key/无真实 agent）：5 轮把"懒惰劳工"抽到验收全绿、退出码 0 ✅
- **OCR 引擎基准**：中文正文识别 RapidOCR **96.4%** vs Windows 自带 **53.7%**（字符相似度）✅

### OCR（辅助读取 + 位置来源）

- **RapidOCR（PaddleOCR PP-OCR + ONNX）为默认引擎**：`npm run ocr:install` 一键装进仓库内隔离 venv
- 可插拔引擎层：`rapidocr` / `windows`（零依赖） / `command`（Umi-OCR、tesseract 等） /
  `vlm`（OpenAI 兼容视觉端点）
- 截图不抢焦点（`PrintWindow`，Chromium 自动用 `PW_RENDERFULLCONTENT` 并检测黑屏）
- `npm run bench:ocr` 在你自己机器上量准确率，结果写 `docs/OCR-BENCH.md`

### 工程

- **零运行时依赖**：不用 `npm install`、无构建步骤；`node bin/cw.mjs` 直接可用
- Node ≥ 22.15（`node:sqlite` 与 `node:zlib` 的 zstd）
- **55 个测试**：离线端到端闭环、护栏、失败分类、MCP JSON-RPC 协议、ACP 协议、Cursor 钩子契约
- 双语文档 + 五份逆向报告（DSH 会话格式、DSH 控制面、codex、opencode、cursor，逐条标注实测/源码/推断）
- CI：lint + 测试 + 离线端到端演示（要求演示真的以"收工"结束）
- dogfooding：本仓库用自己的 `PLAN.md` + `cw.config.mjs`（`cw run` 即可自我监工）

### 已知限制

- 拟人通道的**读回**在"聊天式界面把光标留在输入框"时不可靠（`Ctrl+A` 选不到对话记录）；
  已做三层兜底，推荐配 `readerAdapter` 直接读磁盘会话，或显式指定 `readerClick` 指向对话区
- 拟人通道目前只有 Windows 实现（macOS / Linux 的驱动接口已留好）
- OCR 的文本保真度仍不如直接读会话/剪贴板，定位为兜底与"位置来源"
- 跨连接无法恢复会话（DSH headless 与 ACP 都是新会话；记忆靠工作区）

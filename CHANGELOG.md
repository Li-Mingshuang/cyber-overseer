# 更新日志

本项目的版本记录。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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

# 截图 + OCR：选哪个、能做什么、不能做什么

> 这一页是**实测结论**，不是功能介绍。数据来自本仓库在一台中文 Windows 11 上的真实测量
> （复现：`npm run bench:ocr`，原始输出见 [`OCR-BENCH.md`](OCR-BENCH.md)）。

## 一、结论先说：装 RapidOCR

**同一张图、同一台机器**，8 行样本（4 行中文正文 + 2 行界面小字 + 2 行英文/代码）：

| 提供者 | 整行全对 | 基本读对（≥0.8） | 字符相似度 | 耗时 |
|---|---|---|---|---|
| Windows 自带（`Windows.Media.Ocr`） | 1/8 | 2/8 | **53.7%** | 308ms |
| **RapidOCR（PaddleOCR PP-OCR + ONNX）** | 3/8 | **7/8** | **96.4%** | 3122ms |

原样输出最能说明问题——同一行「赛博监工正在读取对话框内容」：

```
Windows 自带：21Ä(G70                                      ← 中文基本报废
RapidOCR    ：赛博监工正在读取对话框内容                      ← 全对
```

同一行「第 3 轮判定：continue（置信度 0.90）」：

```
Windows 自带：3 *IJE: continue ( ABE 0.90)
RapidOCR    ：第3轮判定：continue（置信度0.90)
```

真实窗口截图（密集浏览器界面）上，RapidOCR 也能读出中文标签页标题
（`影片筛选`／`少年的派`／`天气之子×`），而 Windows 自带只能读英文界面外壳。

### 装它

```bash
npm run ocr:install     # 建隔离 venv + 装 rapidocr-onnxruntime + 自检识别一次
```

- venv 建在仓库内 `.tools/ocr-venv`，**不污染**你的 conda/系统 Python；已 gitignore；
- 模型随 pip 包自带，装完**可离线**使用；
- 会自动检测并使用系统代理（pip 默认不认系统代理，这是国内装包最常见的坑）；
- 国内网络慢的话：`node scripts/install-ocr.mjs --mirror https://pypi.tuna.tsinghua.edu.cn/simple`

### 代价（诚实说）

- 多一个 Python 依赖（约 60MB 包 + 模型）；
- CPU 上每张图 **3–4 秒**（Windows 自带约 0.3 秒）——对"每几分钟看一眼"的监工完全够用，
  不适合逐帧实时；
- 首次调用包含模型加载，会更慢一点。

## 二、四类提供者与它们的定位

`ocr.provider` 可选 `auto`（默认，按下面顺序试）| `rapidocr` | `windows` | `command` | `vlm`。

| 提供者 | 优点 | 缺点 | 适合 |
|---|---|---|---|
| **rapidocr** | 中文准（96.4%）、可离线 | 需 Python、慢 10 倍 | **默认推荐**：读中文正文 |
| windows | 零依赖、快、能顺带截图 | 中文基本不可用（53.7%） | 英文界面、以及"只要位置不要文字" |
| command | 你机器上装了什么都能用 | 需要自己配 | Umi-OCR、tesseract 等 |
| vlm | 对界面截图**理解**最强（不只识字，还能看懂状态） | 要联网 + 额度 | 关键判定、复杂界面 |

自定义命令示例（`cw.config.mjs`）：

```js
export default {
  ocr: {
    provider: 'command',
    command: ['tesseract', '{file}', 'stdout', '-l', 'chi_sim+eng'],  // 或 Umi-OCR 的 --path
    parse: 'text',            // tesseract 用 text；能吐 JSON 行的工具用 jsonl
  },
}
```

视觉模型示例：

```js
export default {
  ocr: {
    provider: 'vlm',
    vlm: {
      baseUrl: 'https://api.deepseek.com/v1',   // 任何 OpenAI 兼容的多模态端点
      model: '<你的视觉模型>',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      prompt: '把这张界面截图里的所有文字原样转写为纯文本，不要总结。',
    },
  },
}
```

## 三、OCR 在本项目里的定位（为什么不是主读取器）

```
读对话内容：  磁盘会话（最准） → 剪贴板（准、快） → OCR（能从像素读，但会有错字）
取位置信息：  UIA（有则用） → OCR 词矩形（总是可用）→ 配置里的相对坐标
辅助证据：    截图附进报告，主人早上能直接看到当时的屏幕
```

即使装了 RapidOCR，**文本渠道依然更优**：会话日志与剪贴板拿到的是零错字原文，OCR 是"从像素猜字"。
所以顺序不变：能读磁盘就读磁盘，读不到再剪贴板，OCR 作为兜底与"位置来源"。

## 四、平台细节（踩过的坑，都已在驱动里处理）

| 坑 | 现象 | 处理 |
|---|---|---|
| `PrintWindow` flag | Chromium/Electron 截出来**全黑**（mean=0/std=0） | 必须 `flag=2`（`PW_RENDERFULLCONTENT`）；驱动自动先试 2 再试 0，并用像素方差判定黑屏 |
| 中文引擎"建不起来" | `TryCreateFromLanguage('zh-Hans-CN')` 返回 null | 必须先加载 `Windows.Globalization.Language` WinRT 类型，否则误判为机器不支持 |
| WinRT 文件路径 | 报"参数错误/路径无效" | `GetFileFromPathAsync` **只接受绝对路径** |
| PowerShell 中文 | 无 BOM 的 UTF-8 被按 GBK 读，注释吞引号 → 语法错 | `.ps1` 一律带 BOM；`npm run lint` 强制检查，`npm run fix:ps1-bom` 修复 |

## 五、还能更好吗

- **视觉模型替代 OCR**：把截图直接交给多模态模型，既识字又"看懂界面状态"（是否在生成、是否弹窗），
  上限最高；代价是联网与额度。已经接好接口（`ocr.provider = 'vlm'`），你只需要配一个能用的模型。
- **PaddleOCR 服务端**：RapidOCR 的"大模型版"（server 版模型）精度更高，但体积与耗时都上去了。
- **按区域 OCR**：先用 UIA/OCR 粗定位对话区，只识别那一块，可以显著提精度与速度——
  这是本项目下一步想做的事（见 `ROADMAP.md`）。

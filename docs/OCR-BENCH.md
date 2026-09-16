# OCR 基准结果（本机实测）

时间：2026-09-16T16:13:48.316Z
样本：4 行正文 + 2 行界面小字 + 2 行代码（见 scripts/bench-ocr.mjs）

| 提供者 | 引擎 | 耗时 | 整行全对 | 基本读对(≥0.8) | 字符相似度 |
| --- | --- | --- | --- | --- | --- |
| windows | en-US | 308ms | 1/8 | 2/8 | 53.7% |
| rapidocr | rapidocr-onnxruntime | 3122ms | 3/8 | 7/8 | 96.4% |

```text
--- windows ---
3 *IJE: continue ( ABE 0.90)
21Ä(G70
npm test 1
iQÄ Beta Allow CLI to access desktop agents
npm test failed exit code 1
CW-RECEIPT: 1 I
--- rapidocr ---
赛博监工正在读取对话框内容
第3轮判定：continue（置信度0.90)
助手：我已经把方案里的第2项做完了。
验收命令npmtest 失败，退出码1
输入消息..发送停止生成
设置 Beta Allow CLl to access desktop agents
npm test failed
exit code 1
CW-RECEIPT：本轮勾选1项」下一步跑验收
```

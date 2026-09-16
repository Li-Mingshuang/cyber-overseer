#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
RapidOCR CLI —— 给赛博监工用的"好用 OCR"桥。

RapidOCR = PaddleOCR 的 PP-OCR 模型 + ONNX Runtime：中文识别是它的主场，纯 CPU 可跑，
模型随 pip 包自带，装完即可离线使用。比 Windows 自带的 Windows.Media.Ocr 在中文界面上准得多
（对比数据见 docs/OCR.md 的基准表）。

用法：
    python rapidocr_cli.py <图片路径> [--json]

输出（stdout，单行 JSON；其它一切信息走 stderr，避免污染解析）：
    {"ok": true, "engine": "rapidocr-onnxruntime", "ms": 123, "lines": [
        {"text": "赛博监工", "x": 20, "y": 15, "w": 160, "h": 28, "score": 0.98}, ...]}

设计约束：
  · 只依赖 `rapidocr_onnxruntime`（或新版 `rapidocr`）；缺了就明确报错，不要静默降级；
  · 输出用 ensure_ascii=False（中文原样输出，Windows 控制台编码由调用方用 UTF-8 处理）；
  · 任何异常都变成 {"ok": false, "error": ...}，让 Node 侧能给出可读的失败原因。
"""

from __future__ import annotations

import argparse
import json
import sys
import time


def load_engine():
    """优先新包名 `rapidocr`，回退旧包 `rapidocr_onnxruntime`。"""
    try:
        from rapidocr import RapidOCR  # 新版（rapidocr>=2）
        return RapidOCR(), "rapidocr"
    except Exception:
        pass
    try:
        from rapidocr_onnxruntime import RapidOCR  # 稳定旧版
        return RapidOCR(), "rapidocr-onnxruntime"
    except Exception as exc:  # pragma: no cover
        raise RuntimeError(
            "RapidOCR 未安装。安装方式：pip install rapidocr-onnxruntime"
            f"（原始错误：{exc}）"
        )


def normalize_result(raw):
    """把不同版本的返回整形为 [[box, text, score], ...]。"""
    if raw is None:
        return []
    # 有些版本返回 (result, elapse)
    if isinstance(raw, tuple) and len(raw) == 2 and isinstance(raw[0], (list, type(None))):
        raw = raw[0]
    if raw is None:
        return []
    if isinstance(raw, dict):  # 新版可能返回对象
        for key in ("boxes", "result", "txts"):
            if key in raw:
                raw = raw[key]
                break
    return list(raw)


def main() -> int:
    parser = argparse.ArgumentParser(description="RapidOCR → JSON（供赛博监工调用）")
    parser.add_argument("image", help="图片路径")
    parser.add_argument("--max-side", type=int, default=0, help="可选：先缩放图片的最长边（0=不缩放）")
    args = parser.parse_args()

    def fail(message: str, code: int = 1) -> int:
        print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
        return code

    try:
        engine, name = load_engine()
    except RuntimeError as exc:
        return fail(str(exc), 3)

    path = args.image
    try:
        started = time.time()
        raw = engine(path)
        elapsed_ms = int((time.time() - started) * 1000)
    except Exception as exc:  # 图片坏了/模型缺失等
        return fail(f"识别失败：{exc}", 4)

    lines = []
    for item in normalize_result(raw):
        try:
            box, text, score = item[0], item[1], item[2]
            xs = [float(point[0]) for point in box]
            ys = [float(point[1]) for point in box]
            lines.append({
                "text": str(text),
                "x": int(min(xs)),
                "y": int(min(ys)),
                "w": int(max(xs) - min(xs)),
                "h": int(max(ys) - min(ys)),
                "score": round(float(score), 3),
            })
        except Exception:
            continue

    # 按阅读顺序排列（上→下，左→右），方便直接当文本用
    lines.sort(key=lambda line: (round(line["y"] / 12), line["x"]))

    print(json.dumps({
        "ok": True,
        "engine": name,
        "ms": elapsed_ms,
        "lines": lines,
        "text": "\n".join(line["text"] for line in lines),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())

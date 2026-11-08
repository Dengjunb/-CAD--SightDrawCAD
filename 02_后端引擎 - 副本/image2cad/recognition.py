# -*- coding: utf-8 -*-
"""
recognition.py
==============
「看图成图」与「图框识读」的联动：把图片生成的 DXF 直接喂给 v1.1 识读引擎，
得到字段-值配对与标准化块 —— 这就是新用法与原始用法之间的闭环。

为什么放在独立模块：
    * 识读引擎是可选依赖（打包时可能只带看图成图），必须能"探测不到就降级"；
    * 识读引擎会写日志、生成副本文件，统一在这里控制输出目录与日志级别，
      不污染看图成图的主流程。
"""
from __future__ import annotations

import importlib
import logging
import os
import sys
from typing import Any, Dict, Optional


def _ensure_titleblock_on_path(extra_dir: str = "") -> bool:
    """让 titleblock 包可导入；返回是否可用。"""
    candidates = [
        extra_dir,
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),  # 项目根
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                     "..", "CAD-TitleBlock-Reader_v1.0(1)"),
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                     "..", "CAD图框识读_交付包_v1.1", "02_源码"),
    ]
    for c in candidates:
        if c and os.path.isdir(os.path.join(c, "titleblock")):
            if c not in sys.path:
                sys.path.insert(0, c)
            break
    try:
        importlib.import_module("titleblock")
        return True
    except Exception:
        return False


def available(extra_dir: str = "") -> bool:
    """识读引擎是否可用（用于 UI 判断要不要显示联动区）。"""
    return _ensure_titleblock_on_path(extra_dir)


def run(dxf_path: str, out_dir: str, extra_dir: str = "") -> Dict[str, Any]:
    """
    对生成的 DXF 跑图框识读。

    返回（JSON 友好）：
        {"ok": bool, "matched": int, "empty": int, "unmatched": int,
         "pairs": [{"label","value","confidence"}], "region": [x,y,x,y],
         "output": 相对 out_dir 的文件名, "elapsed_s": float, "error": str|None}
    """
    if not _ensure_titleblock_on_path(extra_dir):
        return {"ok": False, "error": "未找到 titleblock 识读引擎", "matched": 0,
                "empty": 0, "unmatched": 0, "pairs": []}
    if not os.path.isfile(dxf_path):
        return {"ok": False, "error": "DXF 不存在", "matched": 0,
                "empty": 0, "unmatched": 0, "pairs": []}

    try:
        from titleblock.engine import RecognitionEngine

        logger = logging.getLogger("image2cad.recognition")
        logger.handlers = [logging.NullHandler()]
        logger.propagate = False
        os.makedirs(out_dir, exist_ok=True)
        engine = RecognitionEngine(logger=logger, output_dir=out_dir)
        result = engine.process_file(dxf_path)
        matched = len([p for p in result.pairs if not (p.unmatched_label or p.unmatched_value)])
        empty = len([p for p in result.pairs if p.unmatched_value])
        return {
            "ok": True,
            "matched": matched,
            "empty": empty,
            "unmatched": len(result.unmatched),
            "pairs": [
                {
                    "label": p.label or "",
                    "value": p.value or "",
                    "confidence": round(float(getattr(p, "confidence", 0.0) or 0.0), 2),
                }
                for p in result.pairs[:40]
            ],
            "region": [round(float(v), 2) for v in (result.title_region or (0, 0, 0, 0))],
            "output": os.path.basename(result.stats.get("output_file", "") or ""),
            "elapsed_s": float(result.stats.get("elapsed_s", 0.0)),
            "error": None,
        }
    except Exception as exc:  # 引擎异常不应让整个看图成图流程失败
        return {"ok": False, "error": f"识读失败：{exc}", "matched": 0,
                "empty": 0, "unmatched": 0, "pairs": []}

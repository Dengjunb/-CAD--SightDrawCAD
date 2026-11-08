# -*- coding: utf-8 -*-
"""
mode_a.py
=========
模式 A「图框识读」的 Web 侧封装：把 v1.1 识读引擎包装成「上传 → 出预览/字段/标准化副本」的一次调用。

为什么单独一层：
    * 引擎本身是 CLI/GUI 用的，返回 dataclass；Web API 需要 JSON、相对路径、预览图与中文错误；
    * 需要把「解析 → 识别 → 定位 → 配对 → 建块 → 另存」整理成前端可展示的步骤说明，
      但**不伪造每步耗时**（引擎内部只给总耗时），只展示每步做了什么、得到什么；
    * 识读失败（损坏文件/无后端）要变成可读的中文错误，而不是让服务 500 裸奔。
"""
from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional

from . import recognition as recognition_mod


def _logger() -> logging.Logger:
    logger = logging.getLogger("image2cad.mode_a")
    logger.handlers = [logging.NullHandler()]
    logger.propagate = False
    return logger


def _rel(path: str, base: str) -> str:
    try:
        return os.path.relpath(path, base).replace("\\", "/")
    except ValueError:
        return os.path.basename(path)


def _preview(src: str, out: str, region, max_w: int = 1100, max_h: int = 760) -> Optional[str]:
    """调用 v1.1 预览渲染；失败返回 None（前端隐藏预览区即可）。"""
    try:
        from titleblock.preview import render_dxf_preview
        return render_dxf_preview(src, out, max_w=max_w, max_h=max_h,
                                  highlight=tuple(region) if region else None)
    except Exception:
        return None


def run_titleblock(source_path: str, out_dir: str, export_json: bool = True) -> Dict[str, Any]:
    """
    对一份 .dxf/.dwg 跑图框识读，返回 Web 友好的 JSON。

    返回字段：
        ok, runId, source{name,bytes}, pairs[{label,value,confidence,unmatched}],
        unmatched[...], region[4], stats{...}, steps[...],
        files{preview_before, preview_after, recognized, json}
    失败：
        {"ok": False, "error": "中文原因"}
    """
    out_dir = os.path.abspath(out_dir)
    os.makedirs(out_dir, exist_ok=True)
    if not os.path.isfile(source_path):
        return {"ok": False, "error": "文件不存在"}
    if not recognition_mod.available():
        return {"ok": False, "error": "未找到 titleblock 识读引擎（工程内 titleblock/ 目录缺失）"}

    try:
        from titleblock.engine import RecognitionEngine

        engine = RecognitionEngine(logger=_logger(), output_dir=out_dir)
        result = engine.process_file(source_path)
    except RuntimeError as exc:
        return {"ok": False, "error": str(exc)}
    except Exception as exc:
        return {"ok": False, "error": f"识读失败：{exc}"}

    region = tuple(float(v) for v in (result.title_region or (0, 0, 0, 0)))
    pairs: List[Dict[str, Any]] = []
    for p in result.pairs:
        pairs.append({
            "label": p.label or "",
            "label_raw": p.label_raw or "",
            "value": p.value or "",
            "confidence": round(float(p.confidence or 0.0), 4),
            "unmatched_label": bool(p.unmatched_label),
            "unmatched_value": bool(p.unmatched_value),
        })
    unmatched = []
    for p in result.unmatched:
        unmatched.append({
            "label": p.label or "",
            "value": p.value or "",
            "unmatched_label": bool(p.unmatched_label),
            "unmatched_value": bool(p.unmatched_value),
        })

    stats = dict(result.stats or {})
    output_file = stats.pop("output_file", "") or ""
    recognized_rel = ""
    if output_file and os.path.isfile(output_file):
        recognized_rel = _rel(output_file, out_dir)

    json_rel = ""
    if export_json:
        base = os.path.splitext(os.path.basename(source_path))[0]
        json_path = os.path.join(out_dir, f"{base}.json")
        try:
            RecognitionEngine.write_result_json(result, json_path)
            json_rel = _rel(json_path, out_dir)
        except Exception:
            json_rel = ""

    prev_before = _preview(source_path, os.path.join(out_dir, "preview_before.png"), region)
    prev_after = ""
    if output_file and os.path.isfile(output_file):
        prev_after = _preview(output_file, os.path.join(out_dir, "preview_after.png"), region)

    matched = int(stats.get("matched_pairs", 0))
    steps = [
        {"key": "parse", "title": "解析图纸",
         "detail": f"读取 {os.path.basename(source_path)}，展开 TEXT / MTEXT / 块内文字 / ATTRIB",
         "metrics": {"文字元素": stats.get("text_elements", 0)}},
        {"key": "recognize", "title": "字段识别",
         "detail": "按词表强信号 + 值模式正则判定每个文字是标签还是值（三级标签信号）",
         "metrics": {"强标签": stats.get("labels", 0)}},
        {"key": "locate", "title": "定位标题栏",
         "detail": "对强标签做空间网格聚类，得到标题栏区域并按字高外扩，避免切掉紧邻的值",
         "metrics": {"区域": [round(v, 1) for v in region]}},
        {"key": "pair", "title": "字段-值配对",
         "detail": "行聚类 + 方向打分 + 语义加成后全局降序指派，支持同名标签逐次配对",
         "metrics": {"配对": matched, "空值": stats.get("empty_values", 0),
                      "未匹配": stats.get("unmatched", 0)}},
        {"key": "build", "title": "生成标准化块",
         "detail": "新建 TitleBlock_Standardized 块，按字段原始位置落属性，Tag 块内唯一",
         "metrics": {"块句柄": result.title_block_handle or ""}},
        {"key": "save", "title": "另存副本",
         "detail": "原稿不修改；同格式另存（.dwg 写回失败则回退 .dxf 并告警）",
         "metrics": {"输出": recognized_rel or "（未生成）"}},
    ]

    return {
        "ok": True,
        "runId": os.path.basename(out_dir.rstrip("\\/")) or "",
        "source": {"name": os.path.basename(source_path),
                   "bytes": os.path.getsize(source_path)},
        "pairs": pairs,
        "unmatched": unmatched,
        "region": [round(v, 3) for v in region],
        "stats": {k: v for k, v in stats.items()},
        "steps": steps,
        "files": {
            "preview_before": prev_before and os.path.basename(prev_before) or "",
            "preview_after": prev_after and os.path.basename(prev_after) or "",
            "recognized": recognized_rel,
            "json": json_rel,
        },
        "elapsed_s": float(stats.get("elapsed_s", 0.0) or 0.0),
    }

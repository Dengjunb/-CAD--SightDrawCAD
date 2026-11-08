# -*- coding: utf-8 -*-
"""
manual.py
=========
「看图成图」的手动分步执行（自动 / 手动可切换）。

为什么需要：
    * 自动模式适合大多数情况，但真实图纸往往要“看一眼这一步、改个参数、再往下走”；
    * 手动模式把流水线拆成 9 个可暂停的步骤：读取、预处理、直线、圆、矩形、OCR、DXF、
      质量自检、识读联动。每一步结束即暂停，用户可检查截图与指标、改参数、重跑本步，
      确认后再执行下一步——这就是“人在回路”的半自动作业方式。

实现要点：
    * 每一步的中间结果落盘（cache/loaded.npy、cache/arrays.npz、state.json），
      服务重启后仍可继续；
    * “重跑本步”会按当前参数重算该步，并清空其后的步骤与派生数据，避免新旧结果混用；
    * 自动模式仍走 pipeline.run，本模块不改变自动流程。
"""
from __future__ import annotations

import json
import logging
import os
import time
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np

from . import dxf_writer, imaging, ocr as ocr_mod, rasterize
from . import recognition as recognition_mod
from .config import Options
from .models import Circle, Rect, RunResult, Segment, StepResult, TextBox, VectorScene

# 复用 pipeline 的可视化与换算工具（同一套画面，避免两种模式看起来不一样）
from .pipeline import (_draw_ocr, _draw_vectors, _gray_preview, _mask_preview,
                       _overlay_ink, _save_png, _scale_for)

STAGES: List[Tuple[str, str, str]] = [
    ("load", "读取图像", "读取原图并按长边归一化；得到后续所有步骤的像素基准"),
    ("preprocess", "预处理", "灰度/去噪/二值化/纠偏/清理/文字区/骨架，参数可在此步后调整"),
    ("lines", "直线提取", "Hough + 共线合并 + 横平竖直吸附；可改最短线段与吸附角度后重跑"),
    ("circles", "圆识别", "缩小图 Hough + 圆周支撑率/扇区覆盖率过滤"),
    ("rects", "闭合矩形", "四边共享端点合成闭合 LWPOLYLINE"),
    ("ocr", "文字识别", "Windows 内置 OCR；识别结果落成 DXF TEXT 实体"),
    ("dxf", "生成 CAD", "写出 DXF/SVG/预览；比例按图幅宽度换算"),
    ("quality", "质量自检", "矢量重绘与输入墨迹逐像素比对，给出 F1"),
    ("recognition", "图框识读联动", "把生成的 DXF 交给模式 A 引擎（可选）"),
]

STAGE_STEPS = {
    "load": ["load"],
    "preprocess": ["gray", "binarize", "deskew", "clean", "text", "skeleton"],
    "lines": ["lines"],
    "circles": ["circles"],
    "rects": ["rects"],
    "ocr": ["ocr"],
    "dxf": ["dxf"],
    "quality": ["quality"],
    "recognition": ["recognition"],
}

_CACHE = "cache"


class ManualError(RuntimeError):
    pass


def _state_path(run_dir: str) -> str:
    return os.path.join(run_dir, "state.json")


def _cache_path(run_dir: str, name: str) -> str:
    os.makedirs(os.path.join(run_dir, _CACHE), exist_ok=True)
    return os.path.join(run_dir, _CACHE, name)


def _save_state(state: Dict[str, Any], run_dir: str) -> None:
    with open(_state_path(run_dir), "w", encoding="utf-8") as fh:
        json.dump(state, fh, ensure_ascii=False, indent=1)


def load_session(run_dir: str) -> Dict[str, Any]:
    path = _state_path(run_dir)
    if not os.path.isfile(path):
        raise ManualError("手动会话不存在（缺少 state.json）")
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def session_info(run_dir: str) -> Dict[str, Any]:
    state = load_session(run_dir)
    return payload(state)


def start_session(run_dir: str, source_path: str, options: Optional[Options] = None) -> Dict[str, Any]:
    """创建手动会话，并自动执行第 1 步「读取图像」，返回暂停状态。"""
    options = options or Options()
    run_dir = os.path.abspath(run_dir)
    source_path = os.path.abspath(source_path)
    gray_full = imaging.load_gray(source_path)
    orig_h, orig_w = gray_full.shape[:2]
    state: Dict[str, Any] = {
        "runId": os.path.basename(run_dir),
        "source_path": source_path,
        "source_name": os.path.basename(source_path),
        "source_bytes": os.path.getsize(source_path),
        "orig_w": orig_w,
        "orig_h": orig_h,
        "options": options.to_dict(),
        "stage_done": -1,
        "stage_index": 0,
        "status": "paused",
        "steps": [],
        "segments": [],
        "circles": [],
        "rects": [],
        "text_boxes": [],
        "ocr_lines": [],
        "dxf": {},
        "quality": {},
        "recognition": None,
        "files": {"source": os.path.basename(source_path)},
        "warnings": [],
        "started": time.time(),
        "elapsed_ms": 0.0,
        "result": None,
    }
    _save_state(state, run_dir)
    advance(run_dir, options)
    return session_info(run_dir)


def _append_step(state: Dict[str, Any], run_dir: str, step: StepResult) -> None:
    item = step.to_dict()
    item["stage"] = _current_stage_key(state)
    state["steps"].append(item)


def _current_stage_key(state: Dict[str, Any]) -> str:
    key = state.get("executing") or ""
    if key:
        return str(key)
    idx = int(state.get("stage_done", -1))
    if 0 <= idx < len(STAGES):
        return STAGES[idx][0]
    return ""


def _step_by_key(state: Dict[str, Any], key: str) -> Optional[Dict[str, Any]]:
    for step in reversed(state["steps"]):
        if step.get("key") == key:
            return step
    return None


def _last_emitted_steps(state: Dict[str, Any], keys: List[str]) -> Dict[str, Dict[str, Any]]:
    return {k: _step_by_key(state, k) for k in keys}


def advance(run_dir: str, options: Optional[Options] = None) -> Dict[str, Any]:
    """执行下一个尚未执行的步骤；到末尾时完成并生成结果。"""
    state = load_session(run_dir)
    if state.get("status") == "done":
        return payload(state)
    if state.get("status") == "stopped":
        return payload(state)
    options = options or Options.from_dict(state.get("options") or {})
    index = int(state.get("stage_index", 0))
    if index >= len(STAGES):
        _finalize(state, run_dir)
        _save_state(state, run_dir)
        return payload(state)

    key, title, detail = STAGES[index]
    state["executing"] = key
    t0 = time.time()
    try:
        if key == "load":
            _stage_load(state, run_dir, options)
        elif key == "preprocess":
            _stage_preprocess(state, run_dir, options)
        elif key == "lines":
            _stage_lines(state, run_dir, options)
        elif key == "circles":
            _stage_circles(state, run_dir, options)
        elif key == "rects":
            _stage_rects(state, run_dir, options)
        elif key == "ocr":
            _stage_ocr(state, run_dir, options)
        elif key == "dxf":
            _stage_dxf(state, run_dir, options)
        elif key == "quality":
            _stage_quality(state, run_dir, options)
        elif key == "recognition":
            _stage_recognition(state, run_dir, options)
        else:
            raise ManualError(f"未知步骤：{key}")
    except Exception as exc:
        state["status"] = "error"
        state["error"] = f"步骤「{title}」失败：{exc}"
        state["elapsed_ms"] = (time.time() - state.get("started", time.time())) * 1000
        _save_state(state, run_dir)
        return payload(state)

    state["executing"] = ""
    state["stage_done"] = index
    state["stage_index"] = index + 1
    state["options"] = options.to_dict()
    state["elapsed_ms"] = (time.time() - state.get("started", time.time())) * 1000
    if state["stage_index"] >= len(STAGES):
        _finalize(state, run_dir)
    _save_state(state, run_dir)
    return payload(state)


FIELD_STAGE = {
    "max_side_px": "load",
    "binarize_method": "preprocess", "denoise": "preprocess", "deskew": "preprocess",
    "min_component_ratio": "preprocess", "close_kernel_ratio": "preprocess",
    "detect_text": "preprocess",
    "min_line_ratio": "lines", "max_gap_ratio": "lines", "hough_threshold": "lines",
    "merge_angle_deg": "lines", "merge_dist_ratio": "lines", "merge_gap_ratio": "lines",
    "snap_ortho_deg": "lines", "endpoint_snap_ratio": "lines", "simplify_px": "lines",
    "detect_circles": "circles", "circle_min_ratio": "circles", "circle_max_ratio": "circles",
    "close_loops": "rects", "rect_angle_tol_deg": "rects",
    "ocr": "ocr",
    "scale_mode": "dxf", "sheet_width_mm": "dxf", "dpi": "dxf", "unit": "dxf",
    "layer_outline": "dxf", "layer_center": "dxf", "layer_text": "dxf",
    "layer_frame": "dxf", "dxf_version": "dxf", "export_svg": "dxf", "text_layer": "dxf",
    "run_recognition": "recognition", "recognition_dir": "recognition",
}


def _stage_index(key: str) -> int:
    for i, (k, _, _) in enumerate(STAGES):
        if k == key:
            return i
    return -1


def changed_stage(old_options: Dict[str, Any], new_options: Dict[str, Any]) -> str:
    """参数变化最早影响哪一步（用于“应用参数并重跑”）。"""
    best = len(STAGES)
    best_key = ""
    for field, stage_key in FIELD_STAGE.items():
        if old_options.get(field) != new_options.get(field):
            idx = _stage_index(stage_key)
            if 0 <= idx < best:
                best = idx
                best_key = stage_key
    return best_key


def rerun(run_dir: str, options: Optional[Options] = None,
          stage: Optional[str] = None) -> Dict[str, Any]:
    """按当前参数重跑指定（默认刚完成）步骤，并清空其后的步骤与派生结果。"""
    state = load_session(run_dir)
    if state.get("status") == "done":
        raise ManualError("本次运行已完成，不能再重跑步骤；请重新开始")
    if stage:
        index = _stage_index(stage)
        if index < 0:
            raise ManualError(f"未知步骤：{stage}")
        if index > int(state.get("stage_done", -1)):
            raise ManualError("该步骤尚未执行，无法重跑")
    else:
        index = int(state.get("stage_done", -1))
    if index < 0:
        raise ManualError("还没有可重跑的步骤")
    state["steps"] = [s for s in state["steps"] if _stage_index_of(s) < index]
    _clear_after(state, index)
    state["stage_done"] = index - 1
    state["stage_index"] = index
    state["status"] = "paused"
    state["error"] = None
    state["options"] = (options or Options.from_dict(state.get("options") or {})).to_dict()
    _save_state(state, run_dir)
    return advance(run_dir, options)


def apply_options(run_dir: str, options: Options) -> Dict[str, Any]:
    """
    参数改动后，从最早受影响的已执行步骤开始重跑（而不是盲目重跑最后一步）。
    例：在「直线」步骤改了二值化参数，会回到「预处理」重跑；
        只改最短线段，则从「直线」重跑。
    """
    state = load_session(run_dir)
    old = state.get("options") or {}
    stage_key = changed_stage(old, options.to_dict())
    if not stage_key:
        return rerun(run_dir, options)
    idx = _stage_index(stage_key)
    if idx > int(state.get("stage_done", -1)):
        # 受影响步骤还没执行到，直接保存参数，不重跑
        state["options"] = options.to_dict()
        _save_state(state, run_dir)
        return payload(state)
    return rerun(run_dir, options, stage_key)


def stop(run_dir: str) -> Dict[str, Any]:
    state = load_session(run_dir)
    state["status"] = "stopped"
    state["elapsed_ms"] = (time.time() - state.get("started", time.time())) * 1000
    _save_state(state, run_dir)
    return payload(state)


def _stage_index_of(step: Dict[str, Any]) -> int:
    key = step.get("stage") or ""
    for i, (k, _, _) in enumerate(STAGES):
        if k == key:
            return i
    return -1


def _clear_after(state: Dict[str, Any], index: int) -> None:
    """重跑第 index 步时，清空该步及其后步骤依赖的数据。"""
    key = STAGES[index][0]
    if key == "load":
        state.update({"segments": [], "circles": [], "rects": [], "text_boxes": [],
                      "ocr_lines": [], "dxf": {}, "quality": {}, "recognition": None})
        state["files"] = {"source": state.get("files", {}).get("source", "")}
        return
    if key == "preprocess":
        state.update({"segments": [], "circles": [], "rects": [], "text_boxes": [],
                      "ocr_lines": [], "dxf": {}, "quality": {}, "recognition": None})
        for f in ("dxf", "svg", "preview", "overlay", "recognized"):
            state["files"].pop(f, None)
        return
    if key == "lines":
        state.update({"segments": [], "circles": [], "rects": [], "dxf": {}, "quality": {},
                      "recognition": None})
        return
    if key == "circles":
        state.update({"circles": [], "rects": state.get("rects") or [], "dxf": {},
                      "quality": {}, "recognition": None})
        return
    if key == "rects":
        state.update({"rects": [], "dxf": {}, "quality": {}, "recognition": None})
        return
    if key == "ocr":
        state.update({"ocr_lines": [], "dxf": {}, "quality": {}, "recognition": None})
        return
    if key == "dxf":
        state.update({"dxf": {}, "quality": {}, "recognition": None})
        return
    if key == "quality":
        state.update({"quality": {}, "recognition": None})
        return
    if key == "recognition":
        state["recognition"] = None


# ---------------------------------------------------------------------------
# 各步骤实现
# ---------------------------------------------------------------------------
def _stage_load(state, run_dir, options: Options) -> None:
    t0 = time.time()
    gray_full = imaging.load_gray(state["source_path"])
    orig_h, orig_w = gray_full.shape[:2]
    gray = gray_full
    if max(orig_w, orig_h) > options.max_side_px:
        k = options.max_side_px / float(max(orig_w, orig_h))
        gray = cv2.resize(gray_full, (max(1, int(orig_w * k)), max(1, int(orig_h * k))),
                          interpolation=cv2.INTER_AREA)
    np.save(_cache_path(run_dir, "loaded.npy"), gray)
    state["orig_w"], state["orig_h"] = orig_w, orig_h
    state["width"], state["height"] = gray.shape[1], gray.shape[0]
    rel = os.path.join("steps", "01_load.png")
    _save_png(_gray_preview(gray), os.path.join(run_dir, rel))
    state["files"]["source"] = os.path.basename(state["source_path"])
    detail = (f"原图 {orig_w}×{orig_h}，处理尺寸 {gray.shape[1]}×{gray.shape[0]}"
              + ("（长边按上限缩放，比例不变）" if (orig_w, orig_h) != (gray.shape[1], gray.shape[0]) else ""))
    step = StepResult(key="load", title="读取图像", detail=detail,
                      image=rel.replace("\\", "/"),
                      metrics={"width": gray.shape[1], "height": gray.shape[0],
                               "orig_width": orig_w, "orig_height": orig_h},
                      ms=(time.time() - t0) * 1000)
    _append_step(state, run_dir, step)


def _arrays(run_dir: str) -> Dict[str, np.ndarray]:
    path = os.path.join(run_dir, _CACHE, "arrays.npz")
    if not os.path.isfile(path):
        raise ManualError("缺少预处理缓存，请先执行「预处理」或重跑前序步骤")
    with np.load(path) as data:
        return {k: data[k] for k in data.files}


def _stage_preprocess(state, run_dir, options: Options) -> None:
    t0 = time.time()
    gray = np.load(_cache_path(run_dir, "loaded.npy"))
    pre = imaging.preprocess(gray, options)
    np.savez_compressed(
        os.path.join(run_dir, _CACHE, "arrays.npz"),
        gray=pre["gray"], mask=pre["mask"], clean=pre["clean"],
        skeleton=pre.get("skeleton", np.zeros_like(pre["mask"])),
        text_mask=pre.get("text_mask", np.zeros_like(pre["mask"])),
    )
    state["text_boxes"] = [[float(v) for v in box] for box in (pre.get("text_boxes") or [])]
    state["stroke_width"] = float(pre.get("stroke_width", 1.0) or 1.0)
    state["method"] = pre.get("method", "auto")
    state["skew_deg"] = float(pre.get("skew_deg", 0.0) or 0.0)
    state["preprocess_stats"] = pre.get("stats", {}) or {}
    H, W = pre["mask"].shape[:2]

    def art(name, arr):
        rel = os.path.join("steps", name)
        _save_png(arr, os.path.join(run_dir, rel))
        return rel.replace("\\", "/")

    gray_used = pre["gray"]
    pre_ms = (time.time() - t0) * 1000
    emit = [
        StepResult(key="gray", title="灰度与去噪",
                   detail=f"转 8 位灰度，去噪强度 {options.denoise}（保边滤波抑制纸纹/噪声）",
                   image=art("02_gray.png", _gray_preview(gray_used)),
                   metrics={"denoise": options.denoise, "preprocess_ms": round(pre_ms, 1)}, ms=pre_ms),
        StepResult(key="binarize", title="二值化",
                   detail=f"{state['method']} 二值化：墨迹占比 {(pre['mask'] > 0).mean() * 100:.1f}%",
                   image=art("03_binarize.png", _mask_preview(pre["mask"])),
                   metrics={"method": state["method"],
                            "ink_ratio": round(float((pre["mask"] > 0).mean()), 5)}, ms=0.0),
        StepResult(key="deskew", title="自动纠偏",
                   detail=(f"检测到整体倾斜 {state['skew_deg']:+.2f}°，已反向旋转拉正"
                           if abs(state["skew_deg"]) > 0.05 else "倾斜角度接近 0°，无需纠偏"),
                   image=art("04_deskew.png", _gray_preview(gray_used)),
                   metrics={"skew_deg": round(state["skew_deg"], 2)}, ms=0.0),
        StepResult(key="clean", title="清理与补断",
                   detail=(f"移除 {int((state['preprocess_stats'] or {}).get('components_removed', 0))} 个噪点，"
                           f"闭运算补断；估计笔画宽度 {state['stroke_width']:.1f}px"),
                   image=art("05_clean.png", _mask_preview(pre["clean"])),
                   metrics={"components_removed": int((state['preprocess_stats'] or {}).get('components_removed', 0)),
                            "stroke_width_px": round(state["stroke_width"], 2)}, ms=0.0),
        StepResult(key="text", title="文字区保护",
                   detail=(f"识别 {len(state['text_boxes'])} 处文字区域并从线框提取中排除；"
                           "避免汉字笔画被当成线段"),
                   image=art("06_text.png", _overlay_ink(gray_used, pre.get("text_mask", np.zeros_like(pre["mask"])))),
                   metrics={"text_boxes": len(state["text_boxes"])}, ms=0.0),
        StepResult(key="skeleton", title="骨架细化",
                   detail="单像素中心线：用于接点吸附与闭合判断",
                   image=art("07_skeleton.png", _mask_preview(pre.get("skeleton", np.zeros_like(pre["mask"])))),
                   metrics={"skeleton_px": int((pre.get("skeleton", np.zeros_like(pre["mask"])) > 0).sum())},
                   ms=0.0),
    ]
    for s in emit:
        _append_step(state, run_dir, s)


def _diag(state, clean: Optional[np.ndarray] = None) -> Dict[str, Any]:
    return {"width": state["width"], "height": state["height"],
            "long_side": float(max(state["width"], state["height"])),
            "text_boxes": len(state.get("text_boxes") or []),
            "stroke": float(state.get("stroke_width", 1.5)), "clean": clean}


def _segments(state) -> List[Segment]:
    return [Segment(float(s["x1"]), float(s["y1"]), float(s["x2"]), float(s["y2"]),
                    source=s.get("source", "hough")) for s in (state.get("segments") or [])]


def _stage_lines(state, run_dir, options: Options) -> None:
    from . import vectorize
    t0 = time.time()
    arrays = _arrays(run_dir)
    diag = _diag(state, arrays["clean"])
    segs = vectorize.detect_lines(arrays["clean"], arrays["text_mask"], options, diag)
    segs = vectorize.merge_collinear(segs, options, diag)
    segs = vectorize.snap_segments(segs, options, state["width"], state["height"])
    state["segments"] = [s.to_dict() for s in segs]
    scene = VectorScene(width_px=state["width"], height_px=state["height"],
                        segments=segs, text_boxes=[])
    rel = os.path.join("steps", "08_lines.png")
    _save_png(_draw_vectors(arrays["gray"], scene, circles_color=None,
                            rects_color=None, boxes_color=None),
              os.path.join(run_dir, rel))
    _append_step(state, run_dir, StepResult(
        key="lines", title="直线提取",
        detail=(f"Hough + 共线合并 + 横平竖直吸附（±{options.snap_ortho_deg}°）"
                f" → {len(segs)} 条线段"),
        image=rel.replace("\\", "/"), metrics={"segments": len(segs)},
        ms=(time.time() - t0) * 1000))


def _stage_circles(state, run_dir, options: Options) -> None:
    from . import vectorize
    t0 = time.time()
    arrays = _arrays(run_dir)
    diag = _diag(state, arrays["clean"])
    circles = vectorize.detect_circles(arrays["gray"], arrays["text_mask"], options, diag)
    # 圆弧的弦会被直线检测出来：识别到圆后回头把弦线段删掉（与自动流程一致）
    segs = vectorize.drop_circle_chords(_segments(state), circles, options, diag)
    state["segments"] = [s.to_dict() for s in segs]
    state["circles"] = [c.to_dict() for c in circles]
    scene = VectorScene(width_px=state["width"], height_px=state["height"],
                        segments=[], circles=circles, text_boxes=[])
    rel = os.path.join("steps", "09_circles.png")
    _save_png(_draw_vectors(arrays["gray"], scene, segments_color=None,
                            rects_color=None, boxes_color=None),
              os.path.join(run_dir, rel))
    _append_step(state, run_dir, StepResult(
        key="circles", title="圆识别",
        detail=f"HoughCircles + 圆周支撑率过滤 → {len(circles)} 个圆",
        image=rel.replace("\\", "/"), metrics={"circles": len(circles)},
        ms=(time.time() - t0) * 1000))


def _stage_rects(state, run_dir, options: Options) -> None:
    from . import vectorize
    t0 = time.time()
    arrays = _arrays(run_dir)
    diag = _diag(state, arrays["clean"])
    segs = _segments(state)
    rects = vectorize.find_rects(segs, options, diag)
    state["rects"] = [r.to_dict() for r in rects]
    scene = VectorScene(width_px=state["width"], height_px=state["height"],
                        segments=segs, rects=rects, text_boxes=[])
    rel = os.path.join("steps", "10_rects.png")
    _save_png(_draw_vectors(arrays["gray"], scene, circles_color=None,
                            boxes_color=None),
              os.path.join(run_dir, rel))
    _append_step(state, run_dir, StepResult(
        key="rects", title="闭合矩形重建",
        detail=f"四边共享端点合成闭合轮廓 → {len(rects)} 个矩形（输出 LWPOLYLINE）",
        image=rel.replace("\\", "/"), metrics={"rects": len(rects)},
        ms=(time.time() - t0) * 1000))


def _stage_ocr(state, run_dir, options: Options) -> None:
    t0 = time.time()
    arrays = _arrays(run_dir)
    lines: List[Dict[str, Any]] = []
    error = None
    if options.ocr:
        rel = os.path.join("steps", "ocr_input.png")
        _save_png(_gray_preview(arrays["gray"]), os.path.join(run_dir, rel))
        res = ocr_mod.recognize(os.path.join(run_dir, rel), timeout=60.0)
        if res.get("ok"):
            lines = ocr_mod.lines_to_boxes(res.get("lines", []))
        else:
            error = res.get("error") or "OCR 不可用"
    else:
        error = "已关闭文字识别"
    state["ocr_lines"] = lines
    base = cv2.cvtColor(arrays["gray"], cv2.COLOR_GRAY2BGR)
    canvas = _draw_ocr(base, lines) if lines else base
    rel = os.path.join("steps", "11_ocr.png")
    _save_png(canvas, os.path.join(run_dir, rel))
    _append_step(state, run_dir, StepResult(
        key="ocr", title="文字识别",
        detail=(f"Windows 内置 OCR 识别 {len(lines)} 行文字"
                + (f"（降级：{error}）" if error and not lines else "")
                + "；结果落成 DXF TEXT 实体"),
        image=rel.replace("\\", "/"),
        metrics={"ocr_lines": len(lines),
                 "characters": sum(len(l["text"]) for l in lines)},
        ms=(time.time() - t0) * 1000))


def _scene(state) -> VectorScene:
    return VectorScene(
        width_px=int(state["width"]), height_px=int(state["height"]),
        segments=_segments(state),
        circles=[Circle(float(c["cx"]), float(c["cy"]), float(c["r"])) for c in state.get("circles", [])],
        rects=[Rect(float(r["x"]), float(r["y"]), float(r["w"]), float(r["h"])) for r in state.get("rects", [])],
        text_boxes=[TextBox(*[float(v) for v in b]) for b in (state.get("text_boxes") or [])],
        stroke_width_px=float(state.get("stroke_width", 1.0)),
        scale_mm_per_px=_scale_for(Options.from_dict(state.get("options") or {}),
                                   int(state["width"]), int(state.get("orig_w", state["width"]))),
    )


def _stage_dxf(state, run_dir, options: Options) -> None:
    t0 = time.time()
    scene = _scene(state)
    dxf_path = os.path.join(run_dir, "result.dxf")
    info = dxf_writer.write_dxf(scene, options, dxf_path, state.get("ocr_lines") or [],
                                source_name=state["source_name"])
    svg_rel = ""
    if options.export_svg:
        dxf_writer.write_svg(scene, options, os.path.join(run_dir, "result.svg"),
                             state.get("ocr_lines") or [])
        svg_rel = "result.svg"
    preview_rel = "preview.png"
    rasterize.scene_preview(scene, os.path.join(run_dir, preview_rel))
    state["dxf"] = {"entities": info["entities"], "texts": info["texts"],
                    "unit": options.unit, "scale": scene.scale_mm_per_px}
    state["files"].update({"dxf": "result.dxf", "svg": svg_rel,
                           "preview": preview_rel})
    _append_step(state, run_dir, StepResult(
        key="dxf", title="生成 CAD",
        detail=(f"输出 {options.dxf_version} DXF：{info['entities']} 个几何图元、"
                f"{info['texts']} 个文字实体，单位 {options.unit}"
                f"（1px = {scene.scale_mm_per_px:.3f} {options.unit}）"),
        image=preview_rel,
        metrics={"entities": info["entities"], "texts": info["texts"],
                 "unit": options.unit, "scale": round(scene.scale_mm_per_px, 5)},
        ms=(time.time() - t0) * 1000))


def _stage_quality(state, run_dir, options: Options) -> None:
    t0 = time.time()
    arrays = _arrays(run_dir)
    scene = _scene(state)
    q = rasterize.evaluate(scene, arrays["clean"], arrays["text_mask"], tol_px=3)
    overlay_rel = "overlay.png"
    rasterize.overlay_image(scene, arrays["clean"], os.path.join(run_dir, overlay_rel),
                            cv2.cvtColor(arrays["gray"], cv2.COLOR_GRAY2BGR))
    state["quality"] = q.to_dict()
    state["files"]["overlay"] = overlay_rel
    _append_step(state, run_dir, StepResult(
        key="quality", title="质量自检",
        detail=(f"矢量化重绘与输入墨迹比对：F1 {q.f1:.2f}，召回 {q.recall:.2f}，"
                f"精确 {q.precision:.2f}，平均贴合偏差 {q.chamfer_px:.1f}px —— {q.note}"),
        image=overlay_rel, metrics=q.to_dict(), ms=(time.time() - t0) * 1000))


def _stage_recognition(state, run_dir, options: Options) -> None:
    t0 = time.time()
    result: Optional[Dict[str, Any]] = None
    rel = ""
    if options.run_recognition:
        if not state.get("ocr_lines"):
            result = {"ok": False, "error": "没有识别到文字，无法做图框字段识读",
                      "matched": 0, "empty": 0, "unmatched": 0, "pairs": []}
            detail = "跳过：未识别到文字"
        else:
            result = recognition_mod.run(os.path.join(run_dir, "result.dxf"), run_dir,
                                         extra_dir=options.recognition_dir)
            if result.get("ok"):
                out_name = result.get("output") or ""
                if out_name and os.path.isfile(os.path.join(run_dir, out_name)):
                    state["files"]["recognized"] = out_name
                    rel = os.path.join("steps", "13_recognition.png")
                    try:
                        rasterize.dxf_preview(os.path.join(run_dir, out_name),
                                              os.path.join(run_dir, rel),
                                              max_w=int(state["width"]), max_h=int(state["height"]),
                                              highlight=result.get("region"))
                    except Exception:
                        rel = ""
                detail = (f"识读引擎联动：配对 {result['matched']} 项，空值 {result['empty']} 项，"
                          f"未匹配 {result['unmatched']} 项")
            else:
                detail = f"跳过：{result.get('error')}"
    else:
        detail = "未启用「联动图框识读」；可在参数面板打开后重跑本步"
    state["recognition"] = result
    _append_step(state, run_dir, StepResult(
        key="recognition", title="图框识读联动", detail=detail,
        image=rel.replace("\\", "/") if rel else "",
        metrics={"matched": (result or {}).get("matched", 0)}, ms=(time.time() - t0) * 1000))


# ---------------------------------------------------------------------------
# 完成与状态输出
# ---------------------------------------------------------------------------
def _finalize(state: Dict[str, Any], run_dir: str) -> None:
    if state.get("status") == "done":
        return
    steps = [StepResult(**{k: v for k, v in s.items() if k in StepResult.__dataclass_fields__})
             for s in state["steps"]]
    from .models import QualityReport
    scene = _scene(state)
    quality = QualityReport(**{k: v for k, v in (state.get("quality") or {}).items()
                               if k in QualityReport.__dataclass_fields__})
    files = dict(state.get("files") or {})
    files.update({"report": "report.html", "json": "report.json"})
    if not state.get("recognition"):
        files.pop("recognized", None)
    result = RunResult(
        run_id=state["runId"], created_at=datetime.now().isoformat(timespec="seconds"),
        source_name=state["source_name"], source_width=int(state["orig_w"]),
        source_height=int(state["orig_h"]), source_bytes=int(state["source_bytes"]),
        steps=steps, scene=scene, quality=quality, files=files,
        metrics={"ocr_lines": len(state.get("ocr_lines") or []),
                 "text_characters": sum(len(l["text"]) for l in (state.get("ocr_lines") or [])),
                 "skew_deg": round(float(state.get("skew_deg", 0.0)), 2),
                 "method": state.get("method", ""),
                 "stroke_width_px": round(float(state.get("stroke_width", 1.0)), 2),
                 "scale_mm_per_px": round(scene.scale_mm_per_px, 6),
                 "unit": (Options.from_dict(state.get("options") or {})).unit,
                 "manual": True,
                 "options": state.get("options") or {}},
        warnings=list(state.get("warnings") or []),
        recognition=state.get("recognition"),
        elapsed_ms=float(state.get("elapsed_ms") or 0.0),
    )
    state["result"] = result.to_dict()
    state["status"] = "done"
    with open(os.path.join(run_dir, "report.json"), "w", encoding="utf-8") as fh:
        json.dump(result.to_dict(), fh, ensure_ascii=False, indent=1)
    try:
        from . import report as report_mod
        report_mod.build(result, run_dir)
    except Exception:
        pass


def payload(state: Dict[str, Any]) -> Dict[str, Any]:
    idx = int(state.get("stage_index", 0))
    done = int(state.get("stage_done", -1))
    total = len(STAGES)
    if state.get("status") == "done":
        stage = {"index": total, "total": total, "key": "done", "title": "已完成",
                 "detail": "全部步骤结束，可下载 DXF/SVG/报告"}
    elif idx < total:
        key, title, detail = STAGES[idx]
        stage = {"index": idx + 1, "total": total, "key": key, "title": title, "detail": detail}
    else:
        stage = {"index": total, "total": total, "key": "done", "title": "已完成", "detail": ""}
    steps = [dict(s) for s in state.get("steps") or []]
    return {
        "ok": state.get("status") != "error",
        "runId": state.get("runId"),
        "status": state.get("status"),
        "error": state.get("error"),
        "stage": stage,
        "stageDone": done + 1,
        "totalStages": total,
        "steps": steps,
        "result": state.get("result"),
        "elapsedMs": round(float(state.get("elapsed_ms") or 0.0), 1),
        "options": state.get("options"),
    }

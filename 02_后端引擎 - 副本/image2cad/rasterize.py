# -*- coding: utf-8 -*-
"""
rasterize.py
============
矢量栅格化：把 VectorScene 重新画成像素图，用于
    1) **质量自检**：与输入墨迹逐像素比对，算 precision / recall / F1 / 倒角距离，
       让「生成得像不像」变成可量化、可复现的数字，而不是靠肉眼；
    2) **预览图**：生成白底工程图预览（供 Web UI 与 HTML 报告）；
    3) **叠加图**：原图墨迹（红）+ 矢量化结果（蓝），一眼看出漏画/多画。

坐标：VectorScene 是像素坐标（左上原点、y 向下），直接与输入图对齐，无需换算。
"""
from __future__ import annotations

import math
import os
from typing import Dict, List, Optional, Tuple

import cv2
import numpy as np

from .models import VectorScene, QualityReport


# ---------------------------------------------------------------------------
# 绘制
# ---------------------------------------------------------------------------
def _draw_scene(canvas: np.ndarray, scene: VectorScene, thickness: int,
                color: Tuple[int, int, int], draw_text_boxes: bool = True) -> None:
    """在 BGR/灰度画布上绘制场景图元。"""
    h, w = canvas.shape[:2]

    def P(x: float, y: float) -> Tuple[int, int]:
        # 像素坐标直接取整并夹在画布内，避免 OpenCV 在边界外静默裁剪
        return (int(round(min(max(x, 0), w - 1))), int(round(min(max(y, 0), h - 1))))

    consumed = getattr(scene, "consumed_segments", set()) or set()
    for i, s in enumerate(scene.segments):
        if i in consumed:
            continue
        cv2.line(canvas, P(s.x1, s.y1), P(s.x2, s.y2), color, thickness, lineType=cv2.LINE_8)
    for poly in getattr(scene, "polylines", []) or []:
        pts = poly.pts if hasattr(poly, "pts") else poly.get("pts", [])
        if len(pts) < 2:
            continue
        xy = [P(float(x), float(y)) for x, y in pts]
        closed = bool(getattr(poly, "closed", poly.get("closed", False) if isinstance(poly, dict) else False))
        cv2.polylines(canvas, [np.array(xy, dtype=np.int32)], closed, color, thickness, lineType=cv2.LINE_8)
    for c in scene.circles:
        cv2.circle(canvas, P(c.cx, c.cy), max(1, int(round(c.r))), color, thickness, lineType=cv2.LINE_8)
    for r in scene.rects:
        cv2.rectangle(canvas, P(r.x, r.y), P(r.x + r.w, r.y + r.h), color, thickness, lineType=cv2.LINE_8)
    if draw_text_boxes:
        for tb in scene.text_boxes:
            cv2.rectangle(canvas, P(tb.x, tb.y), P(tb.x + tb.w, tb.y + tb.h), color, 1, lineType=cv2.LINE_8)


def scene_mask(scene: VectorScene, width: int, height: int,
               thickness: Optional[int] = None, with_text_boxes: bool = False) -> np.ndarray:
    """把场景渲染成 0/255 二值掩膜（黑底白线），用于质量计算。"""
    if thickness is None:
        thickness = max(1, int(round(scene.stroke_width_px or 1.0)))
    canvas = np.zeros((height, width), dtype=np.uint8)
    _draw_scene(canvas, scene, thickness, 255, draw_text_boxes=with_text_boxes)
    return canvas


def scene_preview(scene: VectorScene, out_png: str, source: Optional[np.ndarray] = None,
                  with_grid: bool = True, scale: float = 1.0) -> str:
    """
    生成工程图风格预览：白底 + 细网格 + 深色矢量线 + 蓝色文字区框。
    source 不为空时作为底图（灰度转 BGR），用于「叠加在照片上」的预览。
    """
    w = max(32, scene.width_px)
    h = max(32, scene.height_px)
    if scale != 1.0:
        w, h = int(w * scale), int(h * scale)
    if source is not None:
        base = source
        if base.ndim == 2:
            base = cv2.cvtColor(base, cv2.COLOR_GRAY2BGR)
        canvas = cv2.resize(base, (w, h), interpolation=cv2.INTER_AREA)
    else:
        canvas = np.full((h, w, 3), 255, dtype=np.uint8)
        if with_grid:
            step = max(16, int(round(min(w, h) / 28)))
            for gx in range(0, w, step):
                cv2.line(canvas, (gx, 0), (gx, h), (244, 246, 248), 1)
            for gy in range(0, h, step):
                cv2.line(canvas, (0, gy), (w, gy), (244, 246, 248), 1)

    k = w / max(1, scene.width_px)
    scaled = VectorScene(
        width_px=w, height_px=h, stroke_width_px=max(1.0, scene.stroke_width_px * k),
        segments=scene.segments, circles=scene.circles, rects=scene.rects,
        text_boxes=scene.text_boxes,
        polylines=getattr(scene, "polylines", []),
        consumed_segments=getattr(scene, "consumed_segments", set()),
    )
    _draw_scene(canvas, scaled, max(1, int(round(1.2 * k))), (45, 45, 48))
    # 文字区框用蓝色区分（BGR），便于辨认「这块留给文字」
    for tb in scene.text_boxes:
        p1 = (int(round(tb.x * k)), int(round(tb.y * k)))
        p2 = (int(round((tb.x + tb.w) * k)), int(round((tb.y + tb.h) * k)))
        cv2.rectangle(canvas, p1, p2, (190, 120, 30), 1)
    os.makedirs(os.path.dirname(os.path.abspath(out_png)), exist_ok=True)
    cv2.imencode(".png", canvas)[1].tofile(out_png)  # 中文路径安全
    return out_png


def overlay_image(scene: VectorScene, clean_mask: np.ndarray, out_png: str,
                  source_bgr: Optional[np.ndarray] = None) -> str:
    """
    叠加诊断图：底图（原图或灰度）上，输入墨迹画红色、矢量化结果画蓝色，
    重合处接近紫色 —— 最直观的「哪里漏画 / 哪里多画」检查图。
    """
    h, w = scene.height_px, scene.width_px
    if source_bgr is None:
        base = np.full((h, w, 3), 255, dtype=np.uint8)
    else:
        base = source_bgr
        if base.ndim == 2:
            base = cv2.cvtColor(base, cv2.COLOR_GRAY2BGR)
        if base.shape[1] != w or base.shape[0] != h:
            base = cv2.resize(base, (w, h), interpolation=cv2.INTER_AREA)
    ink = np.zeros_like(base)
    ink[clean_mask > 0] = (40, 40, 220)          # 红：输入墨迹
    vec = np.zeros_like(base)
    vec[scene_mask(scene, w, h) > 0] = (220, 90, 40)   # 蓝：矢量重绘
    canvas = cv2.addWeighted(base, 0.35, ink, 0.75, 0)
    canvas = cv2.addWeighted(canvas, 0.8, vec, 0.75, 0)
    os.makedirs(os.path.dirname(os.path.abspath(out_png)), exist_ok=True)
    cv2.imencode(".png", canvas)[1].tofile(out_png)
    return out_png


# ---------------------------------------------------------------------------
# 质量自检
# ---------------------------------------------------------------------------
def evaluate(scene: VectorScene, clean_mask: np.ndarray, text_mask: Optional[np.ndarray] = None,
             tol_px: int = 3) -> QualityReport:
    """
    把矢量化重绘结果与「输入墨迹」对比，给出可信度指标。

    算法：
        * 目标墨迹 = 去噪后二值图 - 文字笔画掩膜（文字不参与矢量化，不能算漏画）；
        * 两侧都做 tol_px 膨胀后再比，避免 1~2 像素的定位误差被判成错误；
        * precision = 矢量像素落在目标墨迹附近的比例（多画/噪声指标）；
        * recall    = 目标墨迹被矢量覆盖的比例（漏画指标）；
        * F1        = 两者的调和平均；
        * chamfer   = 双向平均最近距离（像素），衡量整体贴合度。
    """
    w, h = scene.width_px, scene.height_px
    pred = scene_mask(scene, w, h)
    target = clean_mask.copy()
    if text_mask is not None:
        target[text_mask > 0] = 0

    target_bin = target > 0
    pred_bin = pred > 0
    if not target_bin.any() and not pred_bin.any():
        return QualityReport(note="空图：没有可比较的墨迹")

    k = np.ones((tol_px * 2 + 1, tol_px * 2 + 1), np.uint8)
    target_d = cv2.dilate(target_bin.astype(np.uint8), k) > 0
    pred_d = cv2.dilate(pred_bin.astype(np.uint8), k) > 0

    precision = float((pred_bin & target_d).sum()) / max(1, int(pred_bin.sum()))
    recall = float((target_bin & pred_d).sum()) / max(1, int(target_bin.sum()))
    f1 = 0.0 if precision + recall == 0 else 2 * precision * recall / (precision + recall)

    # 双向倒角距离：各自到对方最近墨迹像素的平均距离
    def _dist(src: np.ndarray, dst: np.ndarray) -> float:
        if not src.any() or not dst.any():
            return 0.0
        dt = cv2.distanceTransform((~dst).astype(np.uint8), cv2.DIST_L2, 3)
        return float(dt[src].mean())

    chamfer = (_dist(pred_bin, target_bin) + _dist(target_bin, pred_bin)) / 2.0

    extra = 0
    for s in scene.segments:
        # 线段中点距离目标墨迹 > 4*tol 视为明显多画的线
        mx = int(round((s.x1 + s.x2) / 2))
        my = int(round((s.y1 + s.y2) / 2))
        if 0 <= mx < w and 0 <= my < h and not target_d[my, mx]:
            extra += 1

    note = "贴合良好" if f1 >= 0.75 else ("基本贴合" if f1 >= 0.55 else "漏画或多画较多，建议调低最短线段/断线合并或提高去噪")
    return QualityReport(
        ink_ratio=float(target_bin.mean()),
        vector_ink_ratio=float(pred_bin.mean()),
        precision=precision,
        recall=recall,
        f1=f1,
        chamfer_px=chamfer,
        extra_segments=extra,
        note=note,
    )


# ---------------------------------------------------------------------------
# DXF -> PNG（复用 v1.1 已有预览实现，保持原始模式视觉一致）
# ---------------------------------------------------------------------------
def dxf_preview(dxf_path: str, out_png: str, max_w: int = 1100, max_h: int = 780,
                highlight=None) -> Optional[str]:
    """调用 titleblock.preview 渲染 DXF；失败返回 None。"""
    try:
        from titleblock.preview import render_dxf_preview
        return render_dxf_preview(dxf_path, out_png, max_w=max_w, max_h=max_h, highlight=highlight)
    except Exception:
        return None

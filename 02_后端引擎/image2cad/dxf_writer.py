# -*- coding: utf-8 -*-
"""
dxf_writer.py
=============
把 VectorScene 写成标准 DXF（AutoCAD 2010+ 兼容）与 SVG 预览。

坐标换算（唯一的换算点，其它模块一律用像素坐标）：
    X_world = px_x * scale
    Y_world = (H - px_y) * scale          # CAD 的 y 轴向上，图像 y 轴向下
其中 scale = 每个像素对应的输出单位数（由 Options.scale_mode 决定）。

输出约定：
    * 图层：轮廓 / 中心线 / 文字区 / 图框 / 尺寸标注（颜色区分，可单独关闭）；
    * 矩形输出为闭合 LWPOLYLINE，圆输出 CIRCLE，OCR 文字落成 TEXT 实体；
    * 可选自动生成线性尺寸标注（主轮廓宽高），并按几何特征自动分类到对应图层，
      强化「制 CAD 图」的可用性；
    * 头部写入 $INSUNITS / $MEASUREMENT，便于追溯。
"""
from __future__ import annotations

import html
import math
import os
from typing import Any, Dict, List, Optional, Tuple

import ezdxf

from .config import Options
from .models import Circle, Rect, Segment, TextBox, VectorScene

_UNIT_CODE = {"mm": 4, "cm": 5, "m": 6, "inch": 1}


def _coord(scene: VectorScene, x: float, y: float) -> Tuple[float, float]:
    """像素坐标 -> DXF 世界坐标（y 翻转）。"""
    s = scene.scale_mm_per_px
    return (x * s, (scene.height_px - y) * s)


def _ensure_layers(doc, options: Options) -> None:
    """建立图层（已存在则跳过），颜色让各类图元一眼可分。"""
    specs = [
        (options.layer_outline, 7),   # 白/黑：轮廓
        (options.layer_center, 4),    # 青：中心线
        (options.layer_text, 3),      # 绿：文字区
        (options.layer_frame, 8),     # 灰：图框
        (options.layer_dim, 2),       # 黄：尺寸标注
    ]
    for name, color in specs:
        if name not in doc.layers:
            doc.layers.add(name, color=color)


def classify_scene(scene: VectorScene, options: Options) -> Tuple[Dict[str, str], Dict[str, int]]:
    """
    把图元分类到图层（像素坐标判断），返回 (seg_layer, rect_layer, counts)。

    规则（启发式，用于让 CAD 图层直观）：
        * 图框：面积最大的轴对齐矩形（通常为图纸外框）；
        * 中心线：穿过某个圆心且两端超出半径 1.2 倍的线段；
        * 轮廓：其余线段 / 圆 / 矩形；
        * 尺寸标注 / 文字区：由后续步骤写入。
    """
    frame_idx = -1
    if options.classify_layers and scene.rects:
        frame_idx = max(range(len(scene.rects)),
                        key=lambda i: scene.rects[i].w * scene.rects[i].h)
        # 只有接近图像外边界的大框才算图框
        r = scene.rects[frame_idx]
        area_ratio = (r.w * r.h) / max(1.0, scene.width_px * scene.height_px)
        if area_ratio < 0.35:
            frame_idx = -1

    # 中心线判定：穿过某个圆心，且长度 > 2.4r
    center_seg = set()
    if options.classify_layers:
        for ci, c in enumerate(scene.circles):
            for i, s in enumerate(scene.segments):
                if i in center_seg:
                    continue
                if s.length < c.r * 2.4:
                    continue
                # 圆心到线段所在直线的距离
                dx, dy = s.x2 - s.x1, s.y2 - s.y1
                norm = math.hypot(dx, dy)
                if norm < 1e-6:
                    continue
                dist = abs(dy * c.cx - dx * c.cy + s.x2 * s.y1 - s.y2 * s.x1) / norm
                if dist <= max(3.0, c.r * 0.06):
                    center_seg.add(i)

    seg_layer: Dict[str, str] = {}
    counts: Dict[str, int] = {options.layer_outline: 0, options.layer_center: 0,
                              options.layer_frame: 0, options.layer_dim: 0,
                              options.layer_text: 0}
    for i, s in enumerate(scene.segments):
        if i in center_seg:
            seg_layer[i] = options.layer_center
            counts[options.layer_center] += 1
        else:
            seg_layer[i] = options.layer_outline
            counts[options.layer_outline] += 1

    rect_layer: Dict[int, str] = {}
    for i, r in enumerate(scene.rects):
        if i == frame_idx:
            rect_layer[i] = options.layer_frame
            counts[options.layer_frame] += 1
        else:
            rect_layer[i] = options.layer_outline
            counts[options.layer_outline] += 1

    counts[options.layer_outline] += len(scene.circles)
    return (seg_layer, rect_layer), counts


def _add_linear_dim(msp, p1: Tuple[float, float], p2: Tuple[float, float],
                    offset: float, text: str, layer: str,
                    text_h: float, ext: float) -> None:
    """手工绘制一条线性尺寸：尺寸线 + 尺寸界线 + 端部斜划 + 文字。"""
    x1, y1 = p1
    x2, y2 = p2
    dx, dy = x2 - x1, y2 - y1
    norm = math.hypot(dx, dy)
    if norm < 1e-6:
        return
    # 外法向（y 轴向上，世界坐标）
    nx, ny = -dy / norm, dx / norm
    q1 = (x1 + nx * offset, y1 + ny * offset)
    q2 = (x2 + nx * offset, y2 + ny * offset)
    # 尺寸线
    msp.add_line(q1, q2, dxfattribs={"layer": layer})
    # 尺寸界线（超出 ext）
    msp.add_line((x1, y1), (x1 + nx * (offset + ext), y1 + ny * (offset + ext)),
                 dxfattribs={"layer": layer})
    msp.add_line((x2, y2), (x2 + nx * (offset + ext), y2 + ny * (offset + ext)),
                 dxfattribs={"layer": layer})
    # 端部斜划（箭头替代，简单可靠）
    for q in (q1, q2):
        t = 0.35 * ext
        msp.add_line((q[0] + (nx + ny) * t, q[1] + (-nx + ny) * t),
                     (q[0] + (nx - ny) * t, q[1] + (-nx - ny) * t),
                     dxfattribs={"layer": layer})
    # 文字
    mid = ((q1[0] + q2[0]) / 2, (q1[1] + q2[1]) / 2)
    msp.add_text(text, dxfattribs={"layer": layer, "height": text_h}).set_placement(mid)


def add_dimensions(doc, msp, scene: VectorScene, options: Options,
                   seg_layer: Dict[str, str], rect_layer: Dict[int, str]) -> int:
    """
    自动为主轮廓生成宽、高两个线性尺寸（像素 -> 毫米换算），返回尺寸数量。
    目标轮廓取除图框外最大的轴对齐矩形；没有矩形则退化为全部图元的包围盒。
    """
    if not options.add_dimensions:
        return 0
    s = scene.scale_mm_per_px
    rects = scene.rects
    # 选非图框最大矩形
    candidate = [r for i, r in enumerate(rects)
                 if rect_layer.get(i) != options.layer_frame]
    if candidate:
        r = max(candidate, key=lambda r: r.w * r.h)
        px = [(r.x, r.y), (r.x + r.w, r.y + r.h)]
    else:
        # 用全部几何包围盒
        xs = [v for seg in scene.segments for v in (seg.x1, seg.x2)]
        ys = [v for seg in scene.segments for v in (seg.y1, seg.y2)]
        xs += [c.cx - c.r for c in scene.circles] + [c.cx + c.r for c in scene.circles]
        ys += [c.cy - c.r for c in scene.circles] + [c.cy + c.r for c in scene.circles]
        if not xs:
            return 0
        px = [(min(xs), min(ys)), (max(xs), max(ys))]
    # 世界坐标（y 翻转）
    p0 = _coord(scene, px[0][0], px[0][1])
    p1 = _coord(scene, px[1][0], px[1][1])
    x0, y0 = min(p0[0], p1[0]), min(p0[1], p1[1])
    x1, y1 = max(p0[0], p1[0]), max(p0[1], p1[1])
    w_mm = (x1 - x0)
    h_mm = (y1 - y0)
    ext = options.dim_extension_mm
    text_h = options.dim_text_height_mm
    layer = options.layer_dim
    n = 0
    if w_mm > 1e-3:
        _add_linear_dim(msp, (x0, y0), (x1, y0), ext, f"{w_mm:.1f}", layer, text_h, ext)
        n += 1
    if h_mm > 1e-3:
        _add_linear_dim(msp, (x0, y0), (x0, y1), ext, f"{h_mm:.1f}", layer, text_h, ext)
        n += 1
    return n


def write_dxf(scene: VectorScene, options: Options, out_path: str,
              ocr_lines: Optional[List[Dict[str, Any]]] = None,
              source_name: str = "") -> Dict[str, Any]:
    """
    写出 DXF，返回统计信息（实体数、范围、单位、图层分类）。

    ocr_lines: [{"text","x","y","w","h"}]（像素坐标），会落成图层文字区的 TEXT。
    """
    doc = ezdxf.new(options.dxf_version, setup=False)
    doc.header["$INSUNITS"] = _UNIT_CODE.get(options.unit, 4)
    doc.header["$MEASUREMENT"] = 1
    _ensure_layers(doc, options)
    msp = doc.modelspace()

    s = scene.scale_mm_per_px
    (seg_layer, rect_layer), counts = classify_scene(scene, options)

    # ---- 直线（按图层分类；已并入多段线的线段跳过，避免重复） ----
    consumed = getattr(scene, "consumed_segments", set()) or set()
    for i, seg in enumerate(scene.segments):
        if i in consumed:
            continue
        p1 = _coord(scene, seg.x1, seg.y1)
        p2 = _coord(scene, seg.x2, seg.y2)
        if math.dist(p1, p2) < 1e-6:
            continue
        msp.add_line(p1, p2, dxfattribs={"layer": seg_layer.get(i, options.layer_outline)})
    # ---- 圆 ----
    for c in scene.circles:
        cx, cy = _coord(scene, c.cx, c.cy)
        msp.add_circle((cx, cy), max(1e-6, c.r * s),
                       dxfattribs={"layer": options.layer_outline})
    # ---- 矩形（闭合多段线，按图层分类） ----
    for i, r in enumerate(scene.rects):
        p1 = _coord(scene, r.x, r.y)
        p2 = _coord(scene, r.x + r.w, r.y + r.h)
        x0, x1 = min(p1[0], p2[0]), max(p1[0], p2[0])
        y0, y1 = min(p1[1], p2[1]), max(p1[1], p2[1])
        msp.add_lwpolyline(
            [(x0, y0), (x1, y0), (x1, y1), (x0, y1)],
            close=True, dxfattribs={"layer": rect_layer.get(i, options.layer_outline)})
    # ---- 链 / 闭合轮廓（LWPOLYLINE） ----
    for poly in getattr(scene, "polylines", []) or []:
        pts = poly.pts if hasattr(poly, "pts") else poly.get("pts", [])
        if len(pts) < 2:
            continue
        xy = [_coord(scene, float(x), float(y)) for x, y in pts]
        closed = bool(getattr(poly, "closed", poly.get("closed", False) if isinstance(poly, dict) else False))
        if closed and math.dist(xy[0], xy[-1]) < 1e-6:
            xy = xy[:-1]
        if len(xy) < 2:
            continue
        msp.add_lwpolyline(xy, close=closed,
                           dxfattribs={"layer": options.layer_outline})
        counts[options.layer_outline] = counts.get(options.layer_outline, 0) + 1

    # ---- 文字区框 ----
    if options.text_layer:
        for tb in scene.text_boxes:
            p1 = _coord(scene, tb.x, tb.y)
            p2 = _coord(scene, tb.x + tb.w, tb.y + tb.h)
            x0, x1 = min(p1[0], p2[0]), max(p1[0], p2[0])
            y0, y1 = min(p1[1], p2[1]), max(p1[1], p2[1])
            msp.add_lwpolyline(
                [(x0, y0), (x1, y0), (x1, y1), (x0, y1)],
                close=True, dxfattribs={"layer": options.layer_text})
            counts[options.layer_text] = counts.get(options.layer_text, 0) + 1
    # ---- OCR 文字 ----
    text_count = 0
    for ln in ocr_lines or []:
        text = str(ln.get("text", "")).strip()
        if not text:
            continue
        w = float(ln.get("w", 0) or 0)
        h = float(ln.get("h", 0) or 0)
        if h <= 0:
            continue
        bx = float(ln.get("x", 0) or 0)
        by = float(ln.get("y", 0) or 0)
        insert = _coord(scene, bx, by + h * 0.85)
        msp.add_text(
            text,
            dxfattribs={
                "layer": options.layer_text,
                "height": max(1e-6, h * 0.72 * s),
            },
        ).set_placement(insert)
        text_count += 1
        counts[options.layer_text] = counts.get(options.layer_text, 0) + 1

    # ---- 自动尺寸标注 ----
    dim_count = add_dimensions(doc, msp, scene, options, seg_layer, rect_layer)
    counts[options.layer_dim] = counts.get(options.layer_dim, 0) + dim_count * 6

    # ---- 头部信息（可追溯） ----
    doc.header["$EXTMIN"] = (0.0, 0.0, 0.0)
    doc.header["$EXTMAX"] = (scene.width_px * s, scene.height_px * s, 0.0)
    try:
        doc.set_modelspace_vport(height=max(scene.height_px * s, 1.0), center=(
            scene.width_px * s / 2.0, scene.height_px * s / 2.0))
    except Exception:
        pass

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    doc.saveas(out_path)
    return {
        "path": out_path,
        "entities": len(scene.segments) + len(scene.circles) + len(scene.rects) + dim_count * 6,
        "texts": text_count,
        "text_boxes": len(scene.text_boxes),
        "dimensions": dim_count,
        "width": scene.width_px,
        "height": scene.height_px,
        "unit": options.unit,
        "classification": counts,
    }


def write_svg(scene: VectorScene, options: Options, out_path: str,
              ocr_lines: Optional[List[Dict[str, Any]]] = None) -> str:
    """写 SVG 预览（浏览器可直接看；与像素坐标一一对应，便于叠加）。"""
    w, h = scene.width_px, scene.height_px

    def esc(v: float) -> str:
        return f"{v:.2f}"

    parts: List[str] = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" '
        f'viewBox="0 0 {w} {h}" preserveAspectRatio="xMidYMid meet">',
        f'<rect x="0" y="0" width="{w}" height="{h}" fill="#ffffff"/>',
        f'<g stroke="#2b2f36" stroke-width="{max(1.0, scene.stroke_width_px * 0.9):.2f}" '
        'fill="none" stroke-linecap="round">',
    ]
    for s in scene.segments:
        parts.append(f'<line x1="{esc(s.x1)}" y1="{esc(s.y1)}" x2="{esc(s.x2)}" y2="{esc(s.y2)}"/>')
    for c in scene.circles:
        parts.append(f'<circle cx="{esc(c.cx)}" cy="{esc(c.cy)}" r="{esc(c.r)}"/>')
    for r in scene.rects:
        parts.append(f'<rect x="{esc(r.x)}" y="{esc(r.y)}" width="{esc(r.w)}" height="{esc(r.h)}"/>')
    parts.append("</g>")

    parts.append('<g fill="none" stroke="#2f7fb5" stroke-width="1.2" stroke-dasharray="5 3">')
    for tb in scene.text_boxes:
        parts.append(f'<rect x="{esc(tb.x)}" y="{esc(tb.y)}" width="{esc(tb.w)}" height="{esc(tb.h)}"/>')
    parts.append("</g>")

    if ocr_lines:
        parts.append('<g fill="#1f5f86" font-family="Microsoft YaHei, sans-serif">')
        for ln in ocr_lines:
            text = str(ln.get("text", "")).strip()
            if not text:
                continue
            hh = float(ln.get("h", 0) or 0)
            if hh <= 0:
                continue
            parts.append(
                f'<text x="{esc(float(ln.get("x", 0)))}" y="{esc(float(ln.get("y", 0)) + hh * 0.85)}" '
                f'font-size="{esc(hh * 0.78)}">{html.escape(text)}</text>')
        parts.append("</g>")

    parts.append("</svg>")
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(parts))
    return out_path

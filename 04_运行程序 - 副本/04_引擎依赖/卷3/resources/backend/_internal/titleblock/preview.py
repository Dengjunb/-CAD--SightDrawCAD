# -*- coding: utf-8 -*-
"""
preview.py
==========
图纸预览渲染：把 .dxf 中的线、圆、弧与文字画成 PNG，供界面展示。

设计取舍：
    * 不依赖 matplotlib / GUI 绘图库，只用 Pillow，保证打包体积可控；
    * 只画模型空间直接图元（LINE / LWPOLYLINE / CIRCLE / ARC / TEXT / MTEXT），
      块参照内部几何暂不展开，避免大图卡顿；
    * 支持高亮标题栏区域（识读结果的 title_region），把"识别发生在哪"画出来。
"""

from __future__ import annotations

import math
import os
from typing import List, Optional, Tuple

from PIL import Image, ImageDraw, ImageFont

import ezdxf

_FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\simsun.ttc",
]


def _font(size: int):
    for p in _FONT_CANDIDATES:
        if os.path.isfile(p):
            try:
                return ImageFont.truetype(p, max(6, int(size)))
            except Exception:
                continue
    return ImageFont.load_default()


def _entity_points(e) -> List[Tuple[float, float, float, float]]:
    """把一个图元近似为若干线段 (x0,y0,x1,y1)。"""
    t = e.dxftype()
    out: List[Tuple[float, float, float, float]] = []
    try:
        if t == "LINE":
            s, d = e.dxf.start, e.dxf.end
            out.append((s.x, s.y, d.x, d.y))
        elif t == "LWPOLYLINE":
            pts = [(p[0], p[1]) for p in e.get_points("xy")]
            for a, b in zip(pts, pts[1:]):
                out.append((a[0], a[1], b[0], b[1]))
            if getattr(e, "closed", False) and len(pts) > 2:
                out.append((pts[-1][0], pts[-1][1], pts[0][0], pts[0][1]))
        elif t == "CIRCLE":
            c, r = e.dxf.center, float(e.dxf.radius)
            n = 24
            pts = [(c.x + r * math.cos(2 * math.pi * i / n),
                    c.y + r * math.sin(2 * math.pi * i / n)) for i in range(n + 1)]
            for a, b in zip(pts, pts[1:]):
                out.append((a[0], a[1], b[0], b[1]))
        elif t == "ARC":
            c, r = e.dxf.center, float(e.dxf.radius)
            a0 = math.radians(float(e.dxf.start_angle))
            a1 = math.radians(float(e.dxf.end_angle))
            if a1 < a0:
                a1 += 2 * math.pi
            n = 18
            pts = [(c.x + r * math.cos(a0 + (a1 - a0) * i / n),
                    c.y + r * math.sin(a0 + (a1 - a0) * i / n)) for i in range(n + 1)]
            for a, b in zip(pts, pts[1:]):
                out.append((a[0], a[1], b[0], b[1]))
    except Exception:
        return out
    return out


def _text_content(e) -> str:
    try:
        if e.dxftype() == "MTEXT":
            plain = getattr(e, "plain_text", None)
            return str(plain()) if callable(plain) else str(e.text)
        return str(e.dxf.text or "")
    except Exception:
        return ""


def render_dxf_preview(path: str, out_png: str, max_w: int = 900, max_h: int = 340,
                       highlight: Optional[Tuple[float, float, float, float]] = None,
                       max_entities: int = 20000) -> Optional[str]:
    """
    渲染 DXF 预览 PNG。返回输出路径；失败返回 None。

    参数:
        path       : .dxf 文件路径（.dwg 不支持，直接返回 None）
        out_png    : 输出 PNG
        max_w/h    : 目标画布尺寸
        highlight  : 需要高亮的区域 (xmin, ymin, xmax, ymax)，通常为标题栏
    """
    if not str(path).lower().endswith(".dxf") or not os.path.isfile(path):
        return None
    try:
        doc = ezdxf.readfile(path)
    except Exception:
        return None

    segs: List[Tuple[float, float, float, float]] = []
    texts = []
    for i, e in enumerate(doc.modelspace()):
        if i > max_entities:
            break
        t = e.dxftype()
        if t in ("TEXT", "MTEXT"):
            try:
                pt = e.dxf.insert
                h = float(getattr(e.dxf, "char_height", 0) or getattr(e.dxf, "height", 0) or 2.5)
                txt = _text_content(e).split("\n")[0]
                if txt:
                    texts.append((float(pt.x), float(pt.y), h, txt))
            except Exception:
                pass
        elif t in ("LINE", "LWPOLYLINE", "CIRCLE", "ARC"):
            segs.extend(_entity_points(e))
        elif t == "INSERT":
            # 块参照：取属性值(ATTRIB)与块内文字，保证"属性图框"也有预览内容
            try:
                candidates = list(getattr(e, "attribs", []))
                for v in e.virtual_entities():
                    if v.dxftype() in ("TEXT", "MTEXT", "ATTDEF"):
                        candidates.append(v)
                for v in candidates:
                    pt = v.dxf.insert
                    h = float(getattr(v.dxf, "char_height", 0) or getattr(v.dxf, "height", 0) or 2.5)
                    txt = _text_content(v).split("\n")[0]
                    if txt:
                        texts.append((float(pt.x), float(pt.y), h, txt))
            except Exception:
                pass

    xs = [v for s in segs for v in (s[0], s[2])] + [t[0] for t in texts]
    ys = [v for s in segs for v in (s[1], s[3])] + [t[1] for t in texts]
    if not xs or not ys:
        return None
    xmin, xmax = min(xs), max(xs)
    ymin, ymax = min(ys), max(ys)
    w = max(xmax - xmin, 1e-6)
    h = max(ymax - ymin, 1e-6)
    margin = 18
    scale = min((max_w - margin * 2) / w, (max_h - margin * 2) / h)
    scale = max(scale, 1e-9)

    def tx(x: float) -> float:
        return margin + (x - xmin) * scale

    def ty(y: float) -> float:
        return margin + (ymax - y) * scale

    img = Image.new("RGB", (max_w, max_h), (253, 254, 255))
    d = ImageDraw.Draw(img)
    # 浅网格，像工程图纸
    for gx in range(0, max_w, 30):
        d.line([(gx, 0), (gx, max_h)], fill=(244, 247, 250))
    for gy in range(0, max_h, 30):
        d.line([(0, gy), (max_w, gy)], fill=(244, 247, 250))

    for x0, y0, x1, y1 in segs:
        d.line([(tx(x0), ty(y0)), (tx(x1), ty(y1))], fill=(62, 78, 92), width=1)

    for x, y, th, txt in texts:
        fs = int(th * scale * 0.95)
        if fs < 6:
            continue
        try:
            d.text((tx(x), ty(y) - fs), txt[:24], font=_font(min(fs, 15)), fill=(30, 44, 58))
        except Exception:
            pass

    if highlight:
        hx0, hy0, hx1, hy1 = highlight
        d.rectangle([tx(hx0), ty(hy1), tx(hx1), ty(hy0)],
                    outline=(222, 138, 24), width=2)

    os.makedirs(os.path.dirname(os.path.abspath(out_png)), exist_ok=True)
    img.save(out_png)
    return out_png
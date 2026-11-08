# -*- coding: utf-8 -*-
"""
make_demo_images.py
===================
生成「看图成图」演示素材：一张机械零件图纸（干净扫描版 + 手机拍照版）
和一张标题栏表格扫描图，并输出像素坐标的真值 JSON，供算法回归/评测使用。

为什么不用 DXF 渲染：演示图需要中文标注与可控的退化（倾斜/噪声/光照），
用 PIL 直接绘制可以精确控制每个图元的位置与线宽，真值即绘制参数本身，
便于对矢量化结果做定量评估（见 tools/eval_roundtrip.py）。
"""
from __future__ import annotations

import json
import math
import os
import random

import numpy as np
from PIL import Image, ImageDraw, ImageFont

W, H = 2200, 1600
INK = (25, 25, 25)
FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\simsun.ttc",
]


def font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def draw_part(draw: ImageDraw.ImageDraw, truth: dict) -> None:
    """法兰盘零件图：外框 + 主视图 + 剖视图 + 中心线 + 标注 + 标题栏。"""
    # 图框（外框留边）
    frame = (80, 70, W - 80, H - 70)
    draw.rectangle(frame, outline=INK, width=3)
    truth["rects"].append({"x": frame[0], "y": frame[1], "w": frame[2] - frame[0], "h": frame[3] - frame[1]})

    # 主视图：矩形零件轮廓 + 四角圆孔
    part = (300, 300, 1150, 950)
    draw.rectangle(part, outline=INK, width=3)
    truth["rects"].append({"x": part[0], "y": part[1], "w": part[2] - part[0], "h": part[3] - part[1]})
    for cx, cy in [(400, 400), (1050, 400), (400, 850), (1050, 850)]:
        draw.ellipse((cx - 55, cy - 55, cx + 55, cy + 55), outline=INK, width=3)
        truth["circles"].append({"cx": cx, "cy": cy, "r": 55})
        # 中心线（十字）
        draw.line((cx - 85, cy, cx + 85, cy), fill=(90, 90, 90), width=1)
        draw.line((cx, cy - 85, cx, cy + 85), fill=(90, 90, 90), width=1)
        truth["lines"].append({"x1": cx - 85, "y1": cy, "x2": cx + 85, "y2": cy, "layer": "center"})
        truth["lines"].append({"x1": cx, "y1": cy - 85, "x2": cx, "y2": cy + 85, "layer": "center"})

    # 内部阶梯轮廓（横线 + 竖线）
    steps = [((300, 625), (1150, 625)), ((720, 625), (720, 950))]
    for (x1, y1), (x2, y2) in steps:
        draw.line((x1, y1, x2, y2), fill=INK, width=3)
        truth["lines"].append({"x1": x1, "y1": y1, "x2": x2, "y2": y2, "layer": "outline"})

    # 剖视图（右侧）：外形 + 中心大孔 + 斜线剖面线
    section = (1300, 320, 1900, 930)
    draw.rectangle(section, outline=INK, width=3)
    truth["rects"].append({"x": section[0], "y": section[1], "w": section[2] - section[0], "h": section[3] - section[1]})
    draw.ellipse((1450, 470, 1750, 770), outline=INK, width=3)
    truth["circles"].append({"cx": 1600, "cy": 620, "r": 150})
    for i in range(-8, 9):
        x_off = i * 42
        p1 = (1300 + max(0, x_off), 930 - max(0, -x_off) * 0)
        # 斜剖面线（45°），限制在矩形内
        x1 = 1300 + (i + 8) * 38
        y1 = 930
        x2 = x1 + 260
        y2 = y1 - 260
        if x2 > 1900:
            y2 -= (x2 - 1900)
            x2 = 1900
        if y2 < 320:
            x1 += (320 - y2)
            y2 = 320
        draw.line((x1, y1, x2, y2), fill=(120, 120, 120), width=1)
        truth["lines"].append({"x1": x1, "y1": y1, "x2": x2, "y2": y2, "layer": "hatch"})

    # 尺寸标注线（水平 + 竖直，带箭头短线）
    dims = [((300, 1080), (1150, 1080)), ((1230, 300), (1230, 950))]
    for (x1, y1), (x2, y2) in dims:
        draw.line((x1, y1, x2, y2), fill=(70, 70, 70), width=2)
        draw.line((x1, y1 - 14, x1, y1 + 14), fill=(70, 70, 70), width=2)
        draw.line((x2, y2 - 14, x2, y2 + 14), fill=(70, 70, 70), width=2)
        truth["lines"].append({"x1": x1, "y1": y1, "x2": x2, "y2": y2, "layer": "dim"})
    return


def draw_titleblock(draw: ImageDraw.ImageDraw, truth: dict) -> None:
    """右下角标题栏：5 行 × 4 列，含中文字段名与值。"""
    x0, y0, w, rows, cols = 1380, 1120, 640, 5, 4
    row_h = 58
    col_w = w / cols
    for r in range(rows + 1):
        y = y0 + r * row_h
        draw.line((x0, y, x0 + w, y), fill=INK, width=3)
        truth["lines"].append({"x1": x0, "y1": y, "x2": x0 + w, "y2": y, "layer": "table"})
    for c in range(cols + 1):
        x = x0 + c * col_w
        draw.line((x, y0, x, y0 + rows * row_h), fill=INK, width=3)
        truth["lines"].append({"x1": x, "y1": y0, "x2": x, "y2": y0 + rows * row_h, "layer": "table"})

    f_label = font(26)
    f_value = font(28)
    rows_data = [
        ("零件名称", "法兰盘", "", ""),
        ("材料", "SKD11", "比例", "1:2"),
        ("设计", "张工", "日期", "2026-10-27"),
        ("审核", "李工", "数量", "1"),
        ("图号", "FL-001", "单位", "mm"),
    ]
    for r, cells in enumerate(rows_data):
        for c, text in enumerate(cells):
            if not text:
                continue
            tx = x0 + c * col_w + 12
            ty = y0 + r * row_h + 14
            draw.text((tx, ty), text, font=f_value if c % 2 else f_label, fill=INK)
            truth["texts"].append({"x": tx, "y": ty, "text": text})


def render_page(kind: str = "part") -> tuple[Image.Image, dict]:
    img = Image.new("RGB", (W, H), "white")
    draw = ImageDraw.Draw(img)
    truth = {"width": W, "height": H, "lines": [], "circles": [], "rects": [], "texts": []}
    f_title = font(44)
    f_note = font(30)
    if kind == "part":
        draw.text((300, 120), "法兰盘零件图", font=f_title, fill=INK)
        truth["texts"].append({"x": 300, "y": 120, "text": "法兰盘零件图"})
        draw_part(draw, truth)
        draw.text((300, 1020), "技术要求：未注公差按 GB/T 1804-m", font=f_note, fill=INK)
        truth["texts"].append({"x": 300, "y": 1020, "text": "技术要求"})
        draw_titleblock(draw, truth)
    else:
        draw.text((300, 120), "图框标题栏（扫描件）", font=f_title, fill=INK)
        draw_titleblock(draw, truth)
    return img, truth


def degrade(img: Image.Image, seed: int = 7) -> Image.Image:
    """模拟手机拍照：倾斜 + 模糊 + 噪声 + 光照不均 + JPEG 压缩。"""
    import cv2
    rng = np.random.default_rng(seed)
    arr = np.array(img)
    # 1) 倾斜 4.2°
    h, w = arr.shape[:2]
    m = cv2.getRotationMatrix2D((w / 2, h / 2), 4.2, 1.0)
    arr = cv2.warpAffine(arr, m, (w, h), flags=cv2.INTER_LINEAR, borderValue=(255, 255, 255))
    # 2) 光照渐变（左上亮、右下暗）
    yy, xx = np.mgrid[0:h, 0:w]
    light = 1.06 - 0.22 * ((xx / w) * 0.55 + (yy / h) * 0.45)
    arr = np.clip(arr.astype(np.float32) * light[..., None], 0, 255).astype(np.uint8)
    # 3) 轻微模糊 + 高斯噪声
    arr = cv2.GaussianBlur(arr, (3, 3), 0.6)
    noise = rng.normal(0, 4.0, arr.shape)
    arr = np.clip(arr.astype(np.float32) + noise, 0, 255).astype(np.uint8)
    # 4) JPEG 压缩痕迹
    ok, enc = cv2.imencode(".jpg", arr, [int(cv2.IMWRITE_JPEG_QUALITY), 72])
    if ok:
        arr = cv2.imdecode(enc, cv2.IMREAD_COLOR)
    return Image.fromarray(arr)


def main(out_dir: str) -> None:
    os.makedirs(out_dir, exist_ok=True)
    part, truth = render_page("part")
    part.save(os.path.join(out_dir, "01-零件图-干净.png"))
    degrade(part).save(os.path.join(out_dir, "02-零件图-拍照.jpg"))
    block, truth_block = render_page("block")
    block.save(os.path.join(out_dir, "03-标题栏-扫描.png"))
    degrade(block, seed=11).save(os.path.join(out_dir, "04-标题栏-拍照.jpg"))
    with open(os.path.join(out_dir, "truth.json"), "w", encoding="utf-8") as fh:
        json.dump({"part": truth, "block": truth_block}, fh, ensure_ascii=False)
    print("demo images ->", out_dir)


if __name__ == "__main__":
    import sys
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "demo", "images"))

# -*- coding: utf-8 -*-
"""
make_patent_figures.py
======================
生成专利交底书附图（黑白线稿，符合专利附图习惯）。

图1 方法总体流程图
图2 文字区保护前后对比示意
图3 图片 → DXF → 字段闭环示意
用法：
    python tools/make_patent_figures.py --out out/专利材料/figs
"""
from __future__ import annotations

import argparse
import os
from typing import List, Tuple

from PIL import Image, ImageDraw, ImageFont

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simsun.ttc",
]


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    path = r"C:\Windows\Fonts\msyhbd.ttc" if bold else None
    candidates = ([path] if path else []) + FONT_CANDIDATES
    for p in candidates:
        if p and os.path.isfile(p):
            try:
                return ImageFont.truetype(p, size)
            except OSError:
                continue
    return ImageFont.load_default()


def box(d: ImageDraw.ImageDraw, xy: Tuple[int, int, int, int], text: str,
        size: int = 30, bold: bool = False, radius: int = 10,
        fill=None, width: int = 4) -> None:
    d.rounded_rectangle(xy, radius=radius, outline="black", width=width, fill=fill)
    lines = text.split("\n")
    f = font(size, bold)
    heights = [d.textbbox((0, 0), ln, font=f)[3] for ln in lines]
    total = sum(heights) + (len(lines) - 1) * 8
    y = xy[1] + (xy[3] - xy[1] - total) // 2
    for ln, h in zip(lines, heights):
        w = d.textbbox((0, 0), ln, font=f)[2]
        d.text((xy[0] + (xy[2] - xy[0] - w) // 2, y), ln, font=f, fill="black")
        y += h + 8


def arrow(d: ImageDraw.ImageDraw, x1: int, y1: int, x2: int, y2: int, width: int = 4) -> None:
    d.line((x1, y1, x2, y2), fill="black", width=width)
    import math
    ang = math.atan2(y2 - y1, x2 - x1)
    L = 18
    for s in (+0.45, -0.45):
        d.line((x2, y2, x2 - L * math.cos(ang + s), y2 - L * math.sin(ang + s)),
               fill="black", width=width)


def fig1(out: str) -> str:
    W, H = 1600, 2140
    img = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(img)
    d.text((W // 2 - 150, 40), "图 1  方法总体流程图", font=font(38, True), fill="black")
    steps = [
        ("S1  图像接入与归一化\n读取扫描件/照片，按长边等比缩放", "S1"),
        ("S2  文字区检测与掩膜保护\n连通域特征筛选 → 行聚类 → 掩膜外扩", "S2"),
        ("S3  二值化、纠偏、去噪与断线闭合\nOtsu/自适应自动择优；Hough 中位角纠偏", "S3"),
        ("S4  几何提取与重建\n直线合并/吸附/端点闭合；圆支撑率过滤；矩形合成", "S4"),
        ("S5  文字识别与 DXF 生成\nOCR 文本落成 TEXT；像素坐标 → 毫米坐标", "S5"),
        ("S6  栅格自检\n矢量重绘与输入墨迹逐像素比对，输出 P/R/F1", "S6"),
        ("S7  图框字段闭环（可选）\nDXF 交由标题栏识读引擎，输出字段与标准化块", "S7"),
    ]
    x0, y = 300, 150
    w, h, gap = 1000, 210, 55
    boxes = []
    for text, _ in steps:
        boxes.append((x0, y, x0 + w, y + h))
        box(d, boxes[-1], text, size=27, bold=False)
        y += h + gap
    for i in range(len(boxes) - 1):
        arrow(d, x0 + w // 2, boxes[i][3], x0 + w // 2, boxes[i + 1][1])
    # 旁注
    notes = [
        ("像素坐标贯穿 S1–S6；\n仅 S5 一次性换算", 1350, boxes[3][1] + 40),
        ("手动模式：9 阶段暂停；\n参数变更从受影响阶段重跑", 1350, boxes[5][1] + 40),
    ]
    for text, nx, ny in notes:
        f = font(22)
        for j, ln in enumerate(text.split("\n")):
            d.text((nx, ny + j * 30), ln, font=f, fill="black")
        d.line((nx - 30, ny + 20, boxes[3][2] + 10, ny + 20), fill="black", width=2)
    img.save(out)
    return out


def fig2(out: str) -> str:
    W, H = 2000, 1180
    img = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(img)
    d.text((W // 2 - 230, 30), "图 2  文字区保护前后对比示意", font=font(38, True), fill="black")

    # 左：未保护
    box(d, (80, 130, 960, 1030), "", width=4)
    d.text((120, 165), "（a）未做文字区保护", font=font(30, True), fill="black")
    # 模拟文字笔画
    import random
    random.seed(7)
    for i in range(9):
        x = 160 + (i % 3) * 240
        y = 270 + (i // 3) * 220
        for k in range(4):
            d.line((x, y + k * 40, x + 160, y + k * 40 + random.randint(-5, 5)),
                   fill="black", width=3)
        d.line((x + 80, y - 10, x + 80, y + 160), fill="black", width=3)
    for x in (120, 740, 900):
        d.line((x, 180, x, 980), fill="black", width=2)
    d.text((120, 940), "汉字笔画被直线检测为 40 条假线段", font=font(26), fill="black")

    # 右：保护后
    box(d, (1040, 130, 1920, 1030), "", width=4)
    d.text((1080, 165), "（b）文字区掩膜保护后", font=font(30, True), fill="black")
    for i in range(9):
        x = 1120 + (i % 3) * 240
        y = 270 + (i // 3) * 220
        d.rectangle((x - 20, y - 20, x + 180, y + 180), outline="black", width=2)
        d.line((x - 20, y - 20, x + 180, y - 20), fill="black", width=2)
        d.line((x - 20, y + 180, x + 180, y + 180), fill="black", width=2)
    d.text((1080, 940), "掩膜内不参与直线检测，仅余 3 条短假线", font=font(26), fill="black")

    d.line((980, 580, 1020, 580), fill="black", width=4)
    d.polygon([(1020, 580), (1000, 570), (1000, 590)], fill="black")
    img.save(out)
    return out


def fig3(out: str) -> str:
    W, H = 2000, 900
    img = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(img)
    d.text((W // 2 - 300, 30), "图 3  图片 → DXF → 图框字段闭环示意", font=font(38, True), fill="black")
    y0 = 260
    box(d, (60, y0, 400, y0 + 240), "图纸图片\n扫描件 / 手机照片", size=28)
    box(d, (520, y0, 980, y0 + 240), "矢量化引擎\nS1–S6：预处理、文字区保护、\n线/圆/矩形、OCR、DXF、自检", size=26)
    box(d, (1100, y0, 1460, y0 + 240), "可编辑 DXF\n轮廓 / 文字区图层\n闭合矩形 + TEXT", size=26)
    box(d, (1580, y0, 1940, y0 + 240), "字段与标准化块\nTitleBlock_Standardized\n字段 JSON", size=24)
    arrow(d, 400, y0 + 120, 520, y0 + 120)
    arrow(d, 980, y0 + 120, 1100, y0 + 120)
    arrow(d, 1460, y0 + 120, 1580, y0 + 120)
    d.text((500, 560), "可选：自动 / 手动分步（9 阶段暂停、参数回退）", font=font(26), fill="black")
    d.rectangle((490, 620, 1500, 700), outline="black", width=3)
    d.text((520, 640), "质量自检：矢量重绘与输入墨迹比对，输出精确率 / 召回率 / F1", font=font(23), fill="black")
    img.save(out)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="out/专利材料/附图")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    for name, fn in (("fig1_flow.png", fig1), ("fig2_textmask.png", fig2), ("fig3_closedloop.png", fig3)):
        print(fn(os.path.join(args.out, name)))


if __name__ == "__main__":
    main()

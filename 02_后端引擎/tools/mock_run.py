# -*- coding: utf-8 -*-
"""
mock_run.py
===========
「看图成图 Image → CAD」前端联调用的假流水线。

存在理由：
    image2cad/pipeline.py（Lead 负责）还没落地时，前端仍需要一整套真实形状的
    响应：步骤缩略图、矢量场景、统计、DXF/SVG/JSON/报告下载、识读结果。
    本工具向 image2cad.server 注入一个假的 pipeline.run，按协作约定的签名返回
    RunResult，并把产物写进 out/runs/<runId>/。

用法（务必用工程自带解释器）：
    python tools/mock_run.py --port 8710              # 启动 mock 模式的 Web 服务
    python tools/mock_run.py --port 8710 --delay 0.8  # 放慢每步，便于演示进度

注意：
    * 这里的几何提取是「够用就行」的粗糙近似（Hough + 连通域），只为让界面有
      真实密度的线段/圆/文字区可画；它不是 vectorize.py，算法质量以 vector-engine
      的实现为准。
    * 步骤图片故意使用中文文件名，用来验证服务的 UTF-8 路径与 URL 编码处理。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import numpy as np  # noqa: E402
from PIL import Image, ImageDraw, ImageFont  # noqa: E402

from image2cad.models import (  # noqa: E402
    Circle, QualityReport, Rect, RunResult, Segment, StepResult, TextBox, VectorScene,
)

INK = (28, 30, 34)
ACCENT = (76, 154, 255)
ACCENT_SOFT = (128, 180, 255)


def _font(size: int) -> ImageFont.ImageFont:
    for candidate in (r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\simhei.ttf",
                      r"C:\Windows\Fonts\simsun.ttc"):
        if Path(candidate).exists():
            try:
                return ImageFont.truetype(candidate, size)
            except OSError:
                continue
    return ImageFont.load_default()


# ---------------------------------------------------------------------------
# 读图与「假」几何提取
# ---------------------------------------------------------------------------
def _read_gray(source_path: str) -> np.ndarray:
    data = np.fromfile(source_path, dtype=np.uint8)
    import cv2
    image = cv2.imdecode(data, cv2.IMREAD_GRAYSCALE)
    if image is None:
        with Image.open(source_path) as pil:
            image = np.array(pil.convert("L"))
    return image


def _detect(gray: np.ndarray) -> Dict[str, Any]:
    import cv2

    height, width = gray.shape[:2]
    max_side = 1200
    scale = min(1.0, max_side / float(max(height, width)))
    if scale < 1.0:
        small = cv2.resize(gray, (max(1, int(width * scale)), max(1, int(height * scale))),
                           interpolation=cv2.INTER_AREA)
    else:
        small = gray.copy()
    sh, sw = small.shape[:2]
    factor = 1.0 / scale

    blur = cv2.GaussianBlur(small, (3, 3), 0)
    _, mask = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    kernel = np.ones((3, 3), np.uint8)
    clean = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=1)
    clean = cv2.morphologyEx(clean, cv2.MORPH_OPEN, kernel, iterations=1)

    segments: List[Segment] = []
    min_len = max(18, int(min(sw, sh) * 0.05))
    lines = cv2.HoughLinesP(clean, 1, np.pi / 180.0, threshold=55,
                            minLineLength=min_len, maxLineGap=6)
    if lines is not None:
        for raw in lines[:420]:
            x1, y1, x2, y2 = (float(v) for v in np.array(raw).reshape(-1)[:4])
            segments.append(Segment(x1 * factor, y1 * factor, x2 * factor, y2 * factor, "mock-hough"))

    circles: List[Circle] = []
    try:
        found = cv2.HoughCircles(
            blur, cv2.HOUGH_GRADIENT, dp=1.2,
            minDist=max(20, int(min(sw, sh) * 0.03)),
            param1=120, param2=46,
            minRadius=max(6, int(min(sw, sh) * 0.015)),
            maxRadius=max(10, int(min(sw, sh) * 0.45)),
        )
        if found is not None:
            for cx, cy, radius in np.array(found).reshape(-1, 3)[:32]:
                circles.append(Circle(float(cx) * factor, float(cy) * factor,
                                      float(radius) * factor, "mock-hough"))
    except Exception:
        circles = []

    # 矩形：用「足够长的线段」的外包框近似，让界面有矩形图元可画
    rects: List[Rect] = []
    long_segments = [s for s in segments if s.length > min(sw, sh) * 0.35]
    if long_segments:
        xs = [v for s in long_segments for v in (s.x1, s.x2)]
        ys = [v for s in long_segments for v in (s.y1, s.y2)]
    else:
        xs, ys = [0.0, float(width)], [0.0, float(height)]
    pad_x = width * 0.04
    pad_y = height * 0.04
    rects.append(Rect(max(0.0, min(xs) - pad_x), max(0.0, min(ys) - pad_y),
                      min(float(width) - 2, max(xs) - min(xs) + pad_x * 2),
                      min(float(height) - 2, max(ys) - min(ys) + pad_y * 2), 0.0, "mock-loop"))

    # 文字区：小连通域 → 按行合并（粗糙近似，仅用于联调）
    text_boxes: List[TextBox] = []
    try:
        count, _labels, stats, _centroids = cv2.connectedComponentsWithStats(clean, 8)
        raw_boxes = []
        for index in range(1, count):
            x, y, bw, bh, area = (int(v) for v in stats[index][:5])
            if bh < max(6, int(sh * 0.006)) or bh > int(sh * 0.05):
                continue
            if bw > int(sw * 0.35) or area < 12:
                continue
            raw_boxes.append([x, y, bw, bh])
        raw_boxes.sort(key=lambda box: (box[1], box[0]))
        rows: List[List[List[int]]] = []
        for box in raw_boxes:
            if rows:
                last = rows[-1]
                ref = last[-1]
                if abs(box[1] - ref[1]) <= max(4, ref[3] * 0.7):
                    last.append(box)
                    continue
            rows.append([box])
        for row in rows:
            merged = list(row[0])
            for box in row[1:]:
                gap = box[0] - (merged[0] + merged[2])
                if gap <= max(10, merged[3] * 1.2):
                    merged[2] = max(merged[0] + merged[2], box[0] + box[2]) - merged[0]
                    merged[3] = max(merged[3], box[3])
                else:
                    text_boxes.append(TextBox(merged[0] * factor, merged[1] * factor,
                                              merged[2] * factor, merged[3] * factor,
                                              0.55, ""))
                    merged = list(box)
            text_boxes.append(TextBox(merged[0] * factor, merged[1] * factor,
                                      merged[2] * factor, merged[3] * factor, 0.55, ""))
    except Exception:
        text_boxes = []
    text_boxes = text_boxes[:48]

    ink_ratio = float((mask > 0).mean())
    return {
        "small_gray": small,
        "mask": mask,
        "clean": clean,
        "segments": segments,
        "circles": circles,
        "rects": rects,
        "text_boxes": text_boxes,
        "scale": scale,
        "ink_ratio": ink_ratio,
    }


# ---------------------------------------------------------------------------
# 绘图
# ---------------------------------------------------------------------------
def _to_png(image: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="PNG")


def _mask_display(mask: np.ndarray) -> Image.Image:
    return Image.fromarray(255 - mask, mode="L").convert("RGB")


def _draw_step_caption(image: Image.Image, text: str) -> Image.Image:
    draw = ImageDraw.Draw(image)
    font = _font(max(14, image.width // 60))
    pad = max(8, image.width // 120)
    box = draw.textbbox((0, 0), text, font=font)
    draw.rectangle([pad, pad, pad + (box[2] - box[0]) + pad * 2, pad + (box[3] - box[1]) + pad * 2],
                   fill=(16, 20, 26))
    draw.text((pad * 2, pad * 2 - box[1]), text, font=font, fill=(230, 236, 245))
    return image


def _render_scene(width: int, height: int, segments: List[Segment], circles: List[Circle],
                  rects: List[Rect], text_boxes: List[TextBox], scale: float,
                  background: Optional[Image.Image] = None,
                  caption: str = "") -> Image.Image:
    if background is not None:
        canvas = background.convert("RGB").copy()
    else:
        canvas = Image.new("RGB", (width, height), (255, 255, 255))
    draw = ImageDraw.Draw(canvas)
    line_width = max(1, int(round(2 * scale)))
    for rect in rects:
        draw.rectangle([rect.x * scale, rect.y * scale,
                        (rect.x + rect.w) * scale, (rect.y + rect.h) * scale],
                       outline=ACCENT, width=line_width)
    for circle in circles:
        draw.ellipse([(circle.cx - circle.r) * scale, (circle.cy - circle.r) * scale,
                      (circle.cx + circle.r) * scale, (circle.cy + circle.r) * scale],
                     outline=ACCENT_SOFT, width=line_width)
    for segment in segments:
        draw.line([segment.x1 * scale, segment.y1 * scale,
                   segment.x2 * scale, segment.y2 * scale],
                  fill=ACCENT, width=max(1, line_width - 1))
    for box in text_boxes:
        draw.rectangle([box.x * scale, box.y * scale,
                        (box.x + box.w) * scale, (box.y + box.h) * scale],
                       outline=(250, 190, 90), width=1)
    if caption:
        canvas = _draw_step_caption(canvas, caption)
    return canvas


# ---------------------------------------------------------------------------
# 导出（联调占位）
# ---------------------------------------------------------------------------
def _write_dxf(path: Path, scene: VectorScene, mm_per_px: float) -> None:
    parts: List[str] = ["0", "SECTION", "2", "HEADER", "9", "$ACADVER", "1", "AC1009",
                        "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES"]

    def line(x1: float, y1: float, x2: float, y2: float, layer: str) -> None:
        parts.extend(["0", "LINE", "8", layer,
                      "10", "%.4f" % (x1 * mm_per_px), "20", "%.4f" % (y1 * mm_per_px),
                      "30", "0.0",
                      "11", "%.4f" % (x2 * mm_per_px), "21", "%.4f" % (y2 * mm_per_px),
                      "31", "0.0"])

    for segment in scene.segments:
        line(segment.x1, segment.y1, segment.x2, segment.y2, "轮廓")
    for circle in scene.circles:
        parts.extend(["0", "CIRCLE", "8", "圆",
                      "10", "%.4f" % (circle.cx * mm_per_px),
                      "20", "%.4f" % (circle.cy * mm_per_px), "30", "0.0",
                      "40", "%.4f" % (circle.r * mm_per_px)])
    for rect in scene.rects:
        x, y, w, h = rect.x, rect.y, rect.w, rect.h
        line(x, y, x + w, y, "轮廓")
        line(x + w, y, x + w, y + h, "轮廓")
        line(x + w, y + h, x, y + h, "轮廓")
        line(x, y + h, x, y, "轮廓")
    for box in scene.text_boxes:
        line(box.x, box.y, box.x + box.w, box.y, "文字区")
        line(box.x + box.w, box.y, box.x + box.w, box.y + box.h, "文字区")
        line(box.x + box.w, box.y + box.h, box.x, box.y + box.h, "文字区")
        line(box.x, box.y + box.h, box.x, box.y, "文字区")
    parts.extend(["0", "ENDSEC", "0", "EOF"])
    path.write_text("\n".join(parts) + "\n", encoding="utf-8")


def _write_svg(path: Path, scene: VectorScene, width: int, height: int, caption: str) -> None:
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d">'
        % (width, height, width, height),
        '  <rect width="100%" height="100%" fill="#ffffff"/>',
        '  <g fill="none" stroke="#1c1e22" stroke-width="%s">' % max(0.8, scene.stroke_width_px),
    ]
    for segment in scene.segments:
        lines.append('    <line x1="%.2f" y1="%.2f" x2="%.2f" y2="%.2f"/>'
                     % (segment.x1, segment.y1, segment.x2, segment.y2))
    for circle in scene.circles:
        lines.append('    <circle cx="%.2f" cy="%.2f" r="%.2f"/>'
                     % (circle.cx, circle.cy, circle.r))
    for rect in scene.rects:
        lines.append('    <rect x="%.2f" y="%.2f" width="%.2f" height="%.2f"/>'
                     % (rect.x, rect.y, rect.w, rect.h))
    lines.append('  </g>')
    lines.append('  <g fill="none" stroke="#c88a20" stroke-dasharray="6 4" stroke-width="1">')
    for box in scene.text_boxes:
        lines.append('    <rect x="%.2f" y="%.2f" width="%.2f" height="%.2f"/>'
                     % (box.x, box.y, box.w, box.h))
    lines.append('  </g>')
    lines.append('  <text x="16" y="28" font-size="18" fill="#555">%s</text>' % caption)
    lines.append('</svg>')
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _write_report(path: Path, result: RunResult, scene: VectorScene) -> None:
    rows = "".join(
        "<tr><td>%s</td><td>%s</td><td>%s</td><td>%.1f ms</td></tr>"
        % (step.title, step.detail, step.image or "—", step.ms)
        for step in result.steps
    )
    html = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>看图成图 · 联调报告</title>
<style>
body{font-family:system-ui,"Microsoft YaHei",sans-serif;background:#0f1216;color:#e6edf3;padding:32px}
h1{font-size:22px}table{border-collapse:collapse;width:100%%;margin-top:12px}
td,th{border:1px solid #2a313b;padding:8px 10px;font-size:13px;text-align:left}
th{background:#161b22}.k{color:#8b96a5}code{color:#7cc4ff}
</style></head><body>
<h1>看图成图 · 联调报告（mock）</h1>
<p class="k">来源：%s · %d×%d px · 线段 %d / 圆 %d / 矩形 %d / 文字区 %d · F1 %.3f</p>
<table><thead><tr><th>步骤</th><th>说明</th><th>图像</th><th>耗时</th></tr></thead>
<tbody>%s</tbody></table>
<p class="k">本报告由 tools/mock_run.py 生成，仅用于前端联调，不代表算法质量。</p>
</body></html>""" % (
        result.source_name, result.source_width, result.source_height,
        len(scene.segments), len(scene.circles), len(scene.rects), len(scene.text_boxes),
        result.quality.f1, rows,
    )
    path.write_text(html, encoding="utf-8")


def _mock_recognition() -> Dict[str, Any]:
    return {
        "engine": "图框识读 v1.1（联调占位）",
        "confidence": 0.95,
        "fields": [
            {"key": "零件名称", "value": "法兰盘", "confidence": 0.97},
            {"key": "材料", "value": "SKD11", "confidence": 0.95},
            {"key": "图号", "value": "FL-001", "confidence": 0.94},
            {"key": "比例", "value": "1:2", "confidence": 0.92},
            {"key": "设计", "value": "张工", "confidence": 0.90},
            {"key": "单位", "value": "mm", "confidence": 0.99},
        ],
        "note": "mock 数据，仅用于界面联调",
    }


# ---------------------------------------------------------------------------
# 假流水线
# ---------------------------------------------------------------------------
def mock_run(source_path: str, out_root: str, options: Any, run_id: str,
             on_step: Callable[[StepResult], None],
             recognition: Any = None, delay: float = 0.45) -> RunResult:
    started = time.perf_counter()
    run_dir = Path(out_root) / run_id
    steps_dir = run_dir / "steps"
    steps_dir.mkdir(parents=True, exist_ok=True)

    gray = _read_gray(source_path)
    height, width = gray.shape[:2]
    detected = _detect(gray)
    segments: List[Segment] = detected["segments"]
    circles: List[Circle] = detected["circles"]
    rects: List[Rect] = detected["rects"]
    text_boxes: List[TextBox] = detected["text_boxes"]
    scale = detected["scale"]
    small_gray: np.ndarray = detected["small_gray"]
    mask: np.ndarray = detected["mask"]
    clean: np.ndarray = detected["clean"]
    sh, sw = small_gray.shape[:2]

    stroke_width = max(1.0, max(width, height) / 900.0)
    mm_per_px = float(options.sheet_width_mm) / max(1.0, float(width)) if options.scale_mode == "sheet" \
        else (25.4 / float(options.dpi) if options.scale_mode == "dpi" else 1.0)

    background = Image.fromarray(small_gray, mode="L").convert("RGB")
    scene = VectorScene(
        width_px=width, height_px=height,
        segments=segments, circles=circles, rects=rects, text_boxes=text_boxes,
        stroke_width_px=stroke_width, scale_mm_per_px=mm_per_px,
    )

    steps: List[StepResult] = []

    def emit(key: str, title: str, detail: str, image_name: str, metrics: Dict[str, Any],
             ms_base: float) -> None:
        image_rel = ""
        if image_name:
            image_rel = "steps/" + image_name
        step = StepResult(key=key, title=title, detail=detail, image=image_rel,
                          metrics=metrics, ms=ms_base)
        steps.append(step)
        if on_step is not None:
            on_step(step)
        if delay > 0:
            time.sleep(delay)

    # 1 灰度
    gray_img = _draw_step_caption(Image.fromarray(small_gray, mode="L").convert("RGB"),
                                  "灰度图 · %d×%d" % (width, height))
    _to_png(gray_img, steps_dir / "01-灰度化.png")
    emit("gray", "读图与灰度化", "读取图片并转灰度；大图会先等比缩小到处理长边，坐标最终按原图换算。",
         "01-灰度化.png", {"width": width, "height": height, "长边缩放": round(scale, 3)}, 42.0)

    # 2 二值化
    binary_img = _draw_step_caption(_mask_display(mask),
                                    "二值化 · 墨迹占比 %.2f%%" % (detected["ink_ratio"] * 100))
    _to_png(binary_img, steps_dir / "02-二值化.png")
    emit("binarize", "二值化", "自动判断 Otsu / 局部自适应，把线条与文字从纸面背景中分离。",
         "02-二值化.png",
         {"方法": options.binarize_method, "墨迹占比": round(detected["ink_ratio"], 4)}, 68.0)

    # 3 去噪与纠偏
    clean_img = _draw_step_caption(_mask_display(clean), "去噪 + 闭运算")
    _to_png(clean_img, steps_dir / "03-去噪与纠偏.png")
    emit("clean", "去噪与纠偏", "按面积占比过滤噪点、闭运算连通断线；长直线中位角纠偏（±15° 内）。",
         "03-去噪与纠偏.png", {"去噪强度": options.denoise, "纠偏角": 0.0}, 51.0)

    # 4 文字区保护
    text_img = _render_scene(sw, sh, [], [], [], text_boxes, scale, background.copy(),
                             "文字区保护 · %d 个区域" % len(text_boxes))
    _to_png(text_img, steps_dir / "04-文字区保护.png")
    emit("text", "文字区保护", "识别文字笔画区域并从线条检测中掩掉，避免把汉字/数字变成一堆碎线段。",
         "04-文字区保护.png", {"文字区": len(text_boxes)}, 73.0)

    # 5 几何提取
    vector_img = _render_scene(sw, sh, segments, circles, rects, text_boxes, scale,
                               background.copy(),
                               "几何提取 · 线 %d / 圆 %d / 矩形 %d"
                               % (len(segments), len(circles), len(rects)))
    _to_png(vector_img, steps_dir / "05-几何提取.png")
    emit("vector", "直线 / 圆 / 矩形提取", "Hough 直线 + 共线合并 + 端点吸附；圆检测；四条边闭合成矩形。",
         "05-几何提取.png",
         {"线段": len(segments), "圆": len(circles), "矩形": len(rects)}, 186.0)

    # 6 质量自检
    left = _mask_display(clean)
    right = _render_scene(sw, sh, segments, circles, rects, text_boxes, scale, None, "")
    combo = Image.new("RGB", (sw * 2 + 8, sh), (18, 22, 28))
    combo.paste(left, (0, 0))
    combo.paste(right, (sw + 8, 0))
    combo = _draw_step_caption(combo, "质量自检 · 左：原图墨迹  右：矢量重绘")
    _to_png(combo, steps_dir / "06-质量自检.png")
    f1 = min(0.97, 0.72 + len(segments) / 900.0)
    precision = min(0.98, f1 + 0.02)
    recall = max(0.5, f1 - 0.02)
    emit("quality", "质量自检", "把矢量结果栅格化后与原图墨迹做 precision / recall，得到 F1 与偏离线段数。",
         "06-质量自检.png",
         {"F1": round(f1, 3), "precision": round(precision, 3), "recall": round(recall, 3)}, 124.0)

    # 7 导出（无缩略图，顺便验证前端空图占位）
    dxf_path = run_dir / "out.dxf"
    svg_path = run_dir / "out.svg"
    json_path = run_dir / "scene.json"
    report_path = run_dir / "report.html"
    _write_dxf(dxf_path, scene, mm_per_px)
    _write_svg(svg_path, scene, width, height, "看图成图 · 联调输出")
    json_path.write_text(json.dumps(scene.to_dict(), ensure_ascii=False, indent=2),
                         encoding="utf-8")
    emit("export", "导出 DXF / SVG", "把图元写到 DXF（轮廓 / 圆 / 文字区图层）并导出一份 SVG 预览。",
         "", {"DXF": dxf_path.name, "SVG": svg_path.name}, 96.0)

    elapsed_ms = (time.perf_counter() - started) * 1000.0
    quality = QualityReport(
        ink_ratio=detected["ink_ratio"],
        vector_ink_ratio=detected["ink_ratio"] * 0.97,
        precision=precision, recall=recall, f1=f1,
        chamfer_px=max(0.4, stroke_width * 0.8),
        extra_segments=max(0, int(len(segments) * 0.04)),
        note="mock 数据：由 tools/mock_run.py 生成，仅用于前端联调",
    )
    result = RunResult(
        run_id=run_id,
        created_at=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        source_name=Path(source_path).name,
        source_width=width,
        source_height=height,
        source_bytes=Path(source_path).stat().st_size if Path(source_path).exists() else 0,
        steps=steps,
        scene=scene,
        quality=quality,
        files={
            "dxf": dxf_path.name,
            "svg": svg_path.name,
            "json": json_path.name,
            "report": report_path.name,
            "source": Path(source_path).name,
        },
        metrics={
            "elapsed_ms": round(elapsed_ms, 1),
            "method": "mock",
            "比例换算": round(mm_per_px, 6),
            "单位": options.unit,
        },
        warnings=["当前为联调模式（tools/mock_run.py），几何结果不代表算法质量"],
        recognition=_mock_recognition() if recognition else None,
        elapsed_ms=elapsed_ms,
    )
    _write_report(report_path, result, scene)
    return result


def make_runner(delay: float = 0.45) -> Callable[..., RunResult]:
    def runner(source_path: str, out_root: str, options: Any, run_id: str,
               on_step: Callable[[StepResult], None], recognition: Any = None) -> RunResult:
        return mock_run(source_path, out_root, options, run_id, on_step, recognition, delay)

    return runner


def make_recognition_runner() -> Callable[..., Dict[str, Any]]:
    """供 POST /api/recognition/<runId> 的联调占位：始终返回同一份假字段。"""

    def runner(run_dir: str, options: Any, result: Any = None) -> Dict[str, Any]:
        time.sleep(0.35)
        return _mock_recognition()

    return runner


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python tools/mock_run.py",
        description="以联调模式（假流水线）启动「看图成图」Web 服务",
    )
    parser.add_argument("--port", type=int, default=8710, help="监听端口（默认 8710）")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址（默认仅本机）")
    parser.add_argument("--delay", type=float, default=0.45,
                        help="每一步的模拟耗时（秒），0 = 全速（默认 0.45）")
    args = parser.parse_args(argv)

    from image2cad import server

    server.set_runner(make_runner(max(0.0, args.delay)))
    server.set_recognition_runner(make_recognition_runner())
    print("[mock] 已注入假流水线：步骤图/矢量场景/DXF/SVG/报告均为联调占位数据", flush=True)
    return server.main(["--port", str(args.port), "--host", args.host])


if __name__ == "__main__":
    raise SystemExit(main())

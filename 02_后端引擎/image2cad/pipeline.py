# -*- coding: utf-8 -*-
"""
pipeline.py
===========
「看图成图」主流水线：图片 -> 预处理 -> 矢量化 -> DXF/SVG -> 质量自检 -> 可选识读联动。

设计要点：
    * **每一步都产出可视化产物**（StepResult.image）。用户说"想看到图片、看到生成 CAD
      的过程"，所以这里把灰度、二值、纠偏、去噪、文字区、骨架、直线、圆、矩形、OCR、
      DXF 预览、质量叠加、识读高亮全部落成 PNG，UI 按顺序展示，而不是只有一个最终结果。
    * **每一步都有可核对的数字**（StepResult.metrics）：图元数、墨迹占比、F1、耗时，
      避免"看起来像"这种不可验收的表述。
    * 失败可定位：任何一步异常都抛出 PipelineError，带步骤中文名，不吞异常。
"""
from __future__ import annotations

import logging
import os
import shutil
import time
import uuid
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional, Tuple

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

try:
    from . import imaging as imaging_mod
    from . import vectorize as vectorize_mod
except Exception as _import_exc:  # 算法模块缺失时给出可读提示，而不是 ImportError 堆栈
    imaging_mod = None  # type: ignore[assignment]
    vectorize_mod = None  # type: ignore[assignment]
    _ALGO_ERROR = str(_import_exc)
else:
    _ALGO_ERROR = ""

from . import dxf_writer, ocr as ocr_mod, rasterize, recognition as recognition_mod
from .config import Options
from .models import (Circle, QualityReport, Rect, RunResult, Segment, StepResult,
                     TextBox, VectorScene)

_FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\simsun.ttc",
]


class PipelineError(RuntimeError):
    """流水线某一步失败（消息含中文步骤名，可直接展示给用户）。"""


def _font(size: int) -> ImageFont.FreeTypeFont:
    for path in _FONT_CANDIDATES:
        if os.path.isfile(path):
            try:
                return ImageFont.truetype(path, max(6, int(size)))
            except OSError:
                continue
    return ImageFont.load_default()


def _save_png(arr: np.ndarray, path: str) -> str:
    """中文路径安全的 PNG 写出（cv2.imencode + tofile）。"""
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    ok, buf = cv2.imencode(".png", arr)
    if not ok:
        raise PipelineError(f"PNG 编码失败：{path}")
    buf.tofile(path)
    return path


def _gray_preview(gray: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)


def _mask_preview(mask: np.ndarray) -> np.ndarray:
    """二值图转"白底黑线"预览（mask 里 255=墨迹）。"""
    return cv2.cvtColor(255 - mask, cv2.COLOR_GRAY2BGR)


def _overlay_ink(gray: np.ndarray, mask: np.ndarray, color=(60, 60, 220)) -> np.ndarray:
    base = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    tint = np.zeros_like(base)
    tint[mask > 0] = color
    return cv2.addWeighted(base, 0.55, tint, 0.75, 0)


def _draw_vectors(base_gray: np.ndarray, scene: VectorScene,
                  segments_color=(220, 120, 20), circles_color=(30, 160, 60),
                  rects_color=(20, 90, 220), boxes_color=(200, 120, 40)) -> np.ndarray:
    """在灰度底图上逐个叠加图元，供过程胶片中"矢量提取结果"步骤展示。"""
    canvas = cv2.cvtColor(base_gray, cv2.COLOR_GRAY2BGR)
    canvas = cv2.addWeighted(canvas, 0.35, np.full_like(canvas, 255), 0.65, 0)
    h, w = canvas.shape[:2]

    def P(x: float, y: float) -> Tuple[int, int]:
        return (int(round(min(max(x, 0), w - 1))), int(round(min(max(y, 0), h - 1))))

    for s in scene.segments:
        if segments_color is not None:
            cv2.line(canvas, P(s.x1, s.y1), P(s.x2, s.y2), segments_color, 2, cv2.LINE_AA)
    for c in scene.circles:
        if circles_color is not None:
            cv2.circle(canvas, P(c.cx, c.cy), max(1, int(round(c.r))), circles_color, 2, cv2.LINE_AA)
    for r in scene.rects:
        if rects_color is not None:
            cv2.rectangle(canvas, P(r.x, r.y), P(r.x + r.w, r.y + r.h), rects_color, 2, cv2.LINE_AA)
    for tb in scene.text_boxes:
        if boxes_color is not None:
            cv2.rectangle(canvas, P(tb.x, tb.y), P(tb.x + tb.w, tb.y + tb.h), boxes_color, 1)
    return canvas


def _draw_ocr(base_bgr: np.ndarray, lines: List[Dict[str, Any]]) -> np.ndarray:
    """OCR 结果可视化：框出文字行并写上识别到的文字（中文用 PIL 才清晰）。"""
    canvas = base_bgr.copy()
    h, w = canvas.shape[:2]
    for ln in lines:
        x, y = int(ln["x"]), int(ln["y"])
        bw, bh = int(ln["w"]), int(ln["h"])
        cv2.rectangle(canvas, (x, y), (x + bw, y + bh), (30, 200, 210), 1)
    pil = Image.fromarray(cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB))
    draw = ImageDraw.Draw(pil)
    for ln in lines:
        text = str(ln.get("text", ""))
        size = max(10, int(float(ln.get("h", 16)) * 0.8))
        try:
            draw.text((int(ln["x"]), int(ln["y"]) - size), text,
                      font=_font(size), fill=(20, 120, 150))
        except Exception:
            pass
    return cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)


def _scale_for(options: Options, width_processed: int, width_original: int) -> float:
    """
    计算「1 处理像素 = 多少输出单位」。注意用**处理后的宽度**：
    图纸物理宽度固定，缩小处理不改变真实尺寸，只降低细节。
    """
    if options.scale_mode == "sheet":
        mm = options.sheet_width_mm / max(1, width_processed)
    elif options.scale_mode == "dpi":
        mm = (25.4 / max(1.0, options.dpi)) * (width_original / max(1, width_processed))
    else:
        mm = 1.0
    if options.unit == "cm":
        return mm / 10.0
    if options.unit == "m":
        return mm / 1000.0
    if options.unit == "inch":
        return mm / 25.4
    return mm


def run(source_path: str, out_root: str = "out/runs", options: Optional[Options] = None,
        run_id: Optional[str] = None,
        on_step: Optional[Callable[[StepResult], None]] = None,
        recognition: bool = False) -> RunResult:
    """
    执行一次看图成图。

    参数:
        source_path : 输入图片路径（png/jpg/bmp/tif）
        out_root    : 运行结果根目录（每次一个 runId 子目录）
        options     : Options；None 用默认值
        run_id      : 指定 runId（测试/复现），None 自动生成
        on_step     : 每完成一步回调（Web UI 实时进度）
        recognition : 是否在生成 DXF 后联动图框识读
    返回:
        RunResult（同时已落盘 report.json / DXF / SVG / 各步骤 PNG）
    """
    if imaging_mod is None or vectorize_mod is None:
        raise PipelineError(
            f"算法模块未就绪（image2cad.imaging / vectorize 导入失败：{_ALGO_ERROR}）")

    t_start = time.time()
    options = (options or Options())
    run_id = run_id or datetime.now().strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
    run_dir = os.path.abspath(os.path.join(out_root, run_id))
    steps_dir = os.path.join(run_dir, "steps")
    os.makedirs(steps_dir, exist_ok=True)

    steps: List[StepResult] = []

    def emit(step: StepResult) -> None:
        steps.append(step)
        if on_step is not None:
            try:
                on_step(step)
            except Exception:
                pass

    def artifact(name: str, arr: np.ndarray) -> str:
        """保存步骤图，返回相对 run_dir 的路径。"""
        rel = os.path.join("steps", name)
        _save_png(arr, os.path.join(run_dir, rel))
        return rel.replace("\\", "/")

    # ---- 0. 读图与尺寸归一化 ----
    t0 = time.time()
    if not os.path.isfile(source_path):
        raise PipelineError(f"图片不存在：{source_path}")
    try:
        gray_full = imaging_mod.load_gray(source_path)
    except Exception as exc:
        raise PipelineError(f"读取图片失败：{exc}") from exc
    orig_h, orig_w = gray_full.shape[:2]
    gray = gray_full
    if max(orig_w, orig_h) > options.max_side_px:
        k = options.max_side_px / float(max(orig_w, orig_h))
        gray = cv2.resize(gray_full, (max(1, int(orig_w * k)), max(1, int(orig_h * k))),
                          interpolation=cv2.INTER_AREA)
    H, W = gray.shape[:2]
    src_ext = os.path.splitext(source_path)[1] or ".png"
    source_rel = f"source{src_ext.lower()}"
    if os.path.abspath(source_path) != os.path.abspath(os.path.join(run_dir, source_rel)):
        try:
            shutil.copyfile(source_path, os.path.join(run_dir, source_rel))
        except Exception:
            # 拷贝失败不影响分析，只是前端不能用源图预览
            source_rel = ""
    emit(StepResult(
        key="load", title="读取图像", detail=(
            f"原图 {orig_w}×{orig_h}，处理尺寸 {W}×{H}"
            + ("（长边按上限缩放，比例不变）" if (orig_w, orig_h) != (W, H) else "")),
        image=artifact("01_load.png", _gray_preview(gray)),
        metrics={"width": W, "height": H, "orig_width": orig_w, "orig_height": orig_h},
        ms=(time.time() - t0) * 1000))

    # ---- 1. 预处理（灰度/去噪/二值/纠偏/去噪点/文字区/骨架）----
    t0 = time.time()
    try:
        pre = imaging_mod.preprocess(gray, options)
    except Exception as exc:
        raise PipelineError(f"预处理失败：{exc}") from exc
    method = pre.get("method", "auto")
    skew = float(pre.get("skew_deg", 0.0) or 0.0)
    mask = pre["mask"]
    clean = pre["clean"]
    skeleton = pre.get("skeleton")
    text_mask = pre.get("text_mask")
    text_boxes = pre.get("text_boxes") or []
    stroke_w = float(pre.get("stroke_width", 1.0) or 1.0)
    stats = pre.get("stats", {}) or {}
    H, W = mask.shape[:2]
    gray_used = pre.get("gray", gray)
    pre_ms = (time.time() - t0) * 1000   # 预处理整体耗时（不拆成假的单步耗时）

    emit(StepResult(
        key="gray", title="灰度与去噪", detail=(
            f"转 8 位灰度，去噪强度 {options.denoise}"
            + "（双边/中值滤波抑制纸纹与扫描噪声）"),
        image=artifact("02_gray.png", _gray_preview(gray_used)),
        metrics={"denoise": options.denoise, "preprocess_ms": round(pre_ms, 1)}, ms=pre_ms))

    ink_ratio = float((mask > 0).mean())
    emit(StepResult(
        key="binarize", title="二值化", detail=(
            ("（深底自动反相后）" if pre.get("polarity") == "inverted" else "")
            + f"{method} 二值化：墨迹占比 {ink_ratio * 100:.1f}%，"
            "把线条与纸面分离（后续所有几何都基于这张图）"),
        image=artifact("03_binarize.png", _mask_preview(mask)),
        metrics={"method": method, "ink_ratio": round(ink_ratio, 5)}, ms=0.0))

    emit(StepResult(
        key="deskew", title="自动纠偏", detail=(
            f"检测到整体倾斜 {skew:+.2f}°，已反向旋转拉正（横线才能吸附成 0°）"
            if abs(skew) > 0.05 else "倾斜角度接近 0°，无需纠偏"),
        image=artifact("04_deskew.png", _gray_preview(gray_used)),
        metrics={"skew_deg": round(skew, 2)}, ms=0.0))

    removed = int(stats.get("components_removed", 0) or 0)
    emit(StepResult(
        key="clean", title="清理与补断", detail=(
            f"移除 {removed} 个噪点连通域，闭运算连接断线；估计笔画宽度 {stroke_w:.1f}px"),
        image=artifact("05_clean.png", _mask_preview(clean)),
        metrics={"components_removed": removed, "stroke_width_px": round(stroke_w, 2)}, ms=0.0))

    tx_boxes = [TextBox(float(x), float(y), float(w), float(h)) for (x, y, w, h) in text_boxes]
    text_overlay = _overlay_ink(gray_used, text_mask if text_mask is not None else np.zeros_like(mask))
    emit(StepResult(
        key="text", title="文字区保护", detail=(
            f"识别 {len(tx_boxes)} 处文字区域并从线框提取中排除，"
            "避免把汉字笔画当成线段（这是图纸矢量化最常见的错误来源）"),
        image=artifact("06_text.png", text_overlay),
        metrics={"text_boxes": len(tx_boxes)}, ms=0.0))

    if skeleton is not None:
        emit(StepResult(
            key="skeleton", title="骨架细化", detail="单像素中心线：用于接点吸附与闭合判断",
            image=artifact("07_skeleton.png", _mask_preview(skeleton)),
            metrics={"skeleton_px": int((skeleton > 0).sum())},
            ms=0.0))

    # ---- 2. 矢量化 ----
    t0 = time.time()
    try:
        segments, circles, rects = vectorize_mod.run(
            clean, text_mask if text_mask is not None else np.zeros_like(clean),
            text_boxes, gray_used, options, W, H,
            hough_gray=pre.get("hough_gray"))
    except Exception as exc:
        raise PipelineError(f"矢量化失败：{exc}") from exc
    scene = VectorScene(width_px=W, height_px=H, segments=segments, circles=circles,
                        rects=rects, text_boxes=tx_boxes, stroke_width_px=stroke_w,
                        scale_mm_per_px=_scale_for(options, W, orig_w),
                        polylines=list(getattr(vectorize_mod, "LAST_POLYLINES", []) or []),
                        consumed_segments=set(getattr(vectorize_mod, "LAST_CONSUMED", set()) or set()))
    vec_ms = (time.time() - t0) * 1000   # 矢量化整体耗时

    line_canvas = _draw_vectors(gray_used, scene, circles_color=None, rects_color=None,
                                boxes_color=None)
    emit(StepResult(
        key="lines", title="直线提取", detail=(
            f"Hough 检测 + 共线合并 + 横平竖直吸附（±{options.snap_ortho_deg}°）"
            f" → {len(segments)} 条线段"),
        image=artifact("08_lines.png", line_canvas),
        metrics={"segments": len(segments), "polylines": len(getattr(vectorize_mod, "LAST_POLYLINES", []) or []),
                 "cad": (getattr(vectorize_mod, "LAST_DIAG", {}) or {}).get("cad", {}),
                 "vectorize_ms": round(vec_ms, 1)}, ms=vec_ms))

    circle_canvas = _draw_vectors(gray_used, scene, segments_color=None,
                                  rects_color=None, boxes_color=None)
    emit(StepResult(
        key="circles", title="圆识别", detail=(
            f"HoughCircles + 边缘支撑率过滤 → {len(circles)} 个圆"),
        image=artifact("09_circles.png", circle_canvas),
        metrics={"circles": len(circles)}, ms=0.0))

    rect_canvas = _draw_vectors(gray_used, scene, segments_color=(150, 150, 150),
                                circles_color=None, boxes_color=None)
    emit(StepResult(
        key="rects", title="闭合矩形重建", detail=(
            f"把共享端点的四条边合并为闭合轮廓 → {len(rects)} 个矩形"
            "（输出为 LWPOLYLINE，不再是四条散线）"),
        image=artifact("10_rects.png", rect_canvas),
        metrics={"rects": len(rects)}, ms=0.0))

    # ---- 3. OCR（Windows 内置，可降级）----
    t0 = time.time()
    ocr_lines: List[Dict[str, Any]] = []
    ocr_error = None
    if options.ocr:
        ocr_input = os.path.join(steps_dir, "ocr_input.png")
        _save_png(_gray_preview(gray_used), ocr_input)
        try:
            ocr_res = ocr_mod.recognize(ocr_input, timeout=60.0)
        except Exception as exc:
            ocr_res = {"ok": False, "error": str(exc), "lines": []}
        if ocr_res.get("ok"):
            ocr_lines = ocr_mod.lines_to_boxes(ocr_res.get("lines", []))
        else:
            ocr_error = ocr_res.get("error") or "OCR 不可用"
    else:
        ocr_error = "已关闭文字识别"
    ocr_canvas = _draw_ocr(cv2.cvtColor(gray_used, cv2.COLOR_GRAY2BGR), ocr_lines) \
        if ocr_lines else cv2.cvtColor(gray_used, cv2.COLOR_GRAY2BGR)
    emit(StepResult(
        key="ocr", title="文字识别", detail=(
            f"Windows 内置 OCR 识别 {len(ocr_lines)} 行文字"
            + (f"（降级：{ocr_error}）" if ocr_error and not ocr_lines else "")
            + "；识别结果会落成 DXF 的真实 TEXT 实体"),
        image=artifact("11_ocr.png", ocr_canvas),
        metrics={"ocr_lines": len(ocr_lines),
                 "characters": sum(len(l["text"]) for l in ocr_lines),
                 "available": not bool(ocr_error) or bool(ocr_lines)},
        ms=(time.time() - t0) * 1000))

    # ---- 4. 输出 DXF / SVG / 预览 ----
    t0 = time.time()
    dxf_path = os.path.join(run_dir, "result.dxf")
    try:
        dxf_info = dxf_writer.write_dxf(scene, options, dxf_path, ocr_lines,
                                        source_name=os.path.basename(source_path))
        svg_rel = ""
        if options.export_svg:
            svg_path = os.path.join(run_dir, "result.svg")
            dxf_writer.write_svg(scene, options, svg_path, ocr_lines)
            svg_rel = "result.svg"
    except Exception as exc:
        raise PipelineError(f"生成 DXF 失败：{exc}") from exc
    preview_rel = "preview.png"
    rasterize.scene_preview(scene, os.path.join(run_dir, preview_rel))
    emit(StepResult(
        key="dxf", title="生成 CAD", detail=(
            f"输出 {options.dxf_version} DXF：{dxf_info['entities']} 个几何图元、"
            f"{dxf_info['texts']} 个文字实体、{len(scene.polylines)} 条链/轮廓，单位 {options.unit}"
            f"（比例 1px = {scene.scale_mm_per_px:.3f} {options.unit}）"),
        image=preview_rel,
        metrics={"entities": dxf_info["entities"], "texts": dxf_info["texts"],
                 "unit": options.unit, "scale": round(scene.scale_mm_per_px, 5),
                 "classification": dxf_info.get("classification", {}),
                 "dimensions": dxf_info.get("dimensions", 0)},
        ms=(time.time() - t0) * 1000))

    # ---- 5. 质量自检 ----
    t0 = time.time()
    try:
        quality = rasterize.evaluate(scene, clean, text_mask, tol_px=3)
        overlay_rel = "overlay.png"
        rasterize.overlay_image(scene, clean, os.path.join(run_dir, overlay_rel),
                                cv2.cvtColor(gray_used, cv2.COLOR_GRAY2BGR))
    except Exception as exc:
        quality = QualityReport(note=f"质量自检失败：{exc}")
        overlay_rel = ""
    emit(StepResult(
        key="quality", title="质量自检", detail=(
            f"矢量化重绘与输入墨迹比对：F1 {quality.f1:.2f}，"
            f"召回 {quality.recall:.2f}，精确 {quality.precision:.2f}，"
            f"平均贴合偏差 {quality.chamfer_px:.1f}px —— {quality.note}"),
        image=overlay_rel,
        metrics=quality.to_dict(), ms=(time.time() - t0) * 1000))

    # ---- 6. 识读联动（可选）----
    recognition_result = None
    recog_rel = ""
    if recognition and options.run_recognition:
        t0 = time.time()
        if not ocr_lines:
            recognition_result = {
                "ok": False,
                "error": "没有识别到文字，无法做图框字段识读（纯线框图纸可忽略此步）",
                "matched": 0, "empty": 0, "unmatched": 0, "pairs": [],
            }
            detail = "跳过：未识别到文字"
        else:
            recognition_result = recognition_mod.run(
                dxf_path, run_dir, extra_dir=options.recognition_dir)
            if recognition_result.get("ok"):
                out_name = recognition_result.get("output") or ""
                if out_name and os.path.isfile(os.path.join(run_dir, out_name)):
                    recog_rel = out_name
                    try:
                        rasterize.dxf_preview(
                            os.path.join(run_dir, out_name),
                            os.path.join(run_dir, "steps", "13_recognition.png"),
                            max_w=W, max_h=H, highlight=recognition_result.get("region"))
                    except Exception:
                        pass
                detail = (
                    f"识读引擎联动：配对 {recognition_result['matched']} 项，"
                    f"空值 {recognition_result['empty']} 项，未匹配 {recognition_result['unmatched']} 项")
            else:
                detail = f"跳过：{recognition_result.get('error')}"
        emit(StepResult(
            key="recognition", title="图框识读联动", detail=detail,
            image=os.path.join("steps", "13_recognition.png").replace("\\", "/")
            if os.path.isfile(os.path.join(run_dir, "steps", "13_recognition.png")) else "",
            metrics={"matched": recognition_result.get("matched", 0),
                     "pairs": len(recognition_result.get("pairs", []))},
            ms=(time.time() - t0) * 1000))

    # ---- 7. 汇总落盘 ----
    result = RunResult(
        run_id=run_id,
        created_at=datetime.now().isoformat(timespec="seconds"),
        source_name=os.path.basename(source_path),
        source_width=orig_w, source_height=orig_h,
        source_bytes=os.path.getsize(source_path),
        steps=steps, scene=scene, quality=quality,
        files={
            "source": source_rel,
            "dxf": "result.dxf",
            "svg": svg_rel,
            "preview": preview_rel,
            "overlay": overlay_rel,
            "report": "report.html",
            "json": "report.json",
            "recognized": recog_rel,
        },
        metrics={
            "ocr_lines": len(ocr_lines),
            "text_characters": sum(len(l["text"]) for l in ocr_lines),
            "skew_deg": round(skew, 2),
            "method": method,
            "stroke_width_px": round(stroke_w, 2),
            "scale_mm_per_px": round(scene.scale_mm_per_px, 6),
            "unit": options.unit,
            "options": options.to_dict(),
        },
        warnings=([f"文字识别降级：{ocr_error}"] if ocr_error else []),
        recognition=recognition_result,
        elapsed_ms=(time.time() - t_start) * 1000,
    )

    import json
    with open(os.path.join(run_dir, "report.json"), "w", encoding="utf-8") as fh:
        json.dump(result.to_dict(), fh, ensure_ascii=False, indent=1)

    # HTML 报告（内嵌图片，可直接发给别人看）
    try:
        from . import report as report_mod
        report_mod.build(result, run_dir)
    except Exception as exc:  # 报告失败不算业务失败
        result.warnings.append(f"HTML 报告生成失败：{exc}")
        with open(os.path.join(run_dir, "report.json"), "w", encoding="utf-8") as fh:
            json.dump(result.to_dict(), fh, ensure_ascii=False, indent=1)

    return result


def run_recognition(run_dir: str, options: Optional[Options] = None,
                    result: Optional[dict] = None) -> Dict[str, Any]:
    """
    对一次已经完成的运行补跑「图框识读」（Web 界面的「重新识读」按钮用）。

    参数：
        run_dir : 运行结果目录（内含 result.dxf）
        options : Options（用到 recognition_dir）
        result  : 现有 report.json 内容（可不传，会自己读盘）
    返回：
        与 recognition.run 相同的 dict；同时把结果写回 run_dir/report.json 的 recognition 字段。
    """
    import json

    options = options or Options()
    run_dir = os.path.abspath(run_dir)
    dxf_path = os.path.join(run_dir, "result.dxf")
    if not os.path.isfile(dxf_path):
        return {"ok": False, "error": "找不到 result.dxf", "matched": 0,
                "empty": 0, "unmatched": 0, "pairs": []}
    res = recognition_mod.run(dxf_path, run_dir, extra_dir=options.recognition_dir)

    # 回写 report.json，保证「报告 / 界面 / 文件」三处一致
    report_path = os.path.join(run_dir, "report.json")
    try:
        if os.path.isfile(report_path):
            with open(report_path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        elif isinstance(result, dict):
            data = result
        else:
            data = None
        if isinstance(data, dict):
            data["recognition"] = res
            with open(report_path, "w", encoding="utf-8") as fh:
                json.dump(data, fh, ensure_ascii=False, indent=1)
    except Exception:
        pass
    return res

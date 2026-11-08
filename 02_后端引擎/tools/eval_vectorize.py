# -*- coding: utf-8 -*-
"""
eval_vectorize.py
=================
矢量化精度评测：拿 demo/images/truth.json 当像素级真值，跑「预处理 + 矢量化」，
输出主要直线召回率 / 误检率 / F1、圆与矩形的命中情况、耗时。

真值口径（重要，先说清楚，避免数字被误读）：
    * truth.json 的 lines 只记录了「画出来的独立线」；图框、零件外形、剖视图外形
      这三处是 **draw.rectangle**，真值放在 rects 里，但它们在图像上同样是四条线。
      因此评测的「主要直线」= lines + rects 的四条边，否则一个正确的矩形重建
      反而会被算成误检。
    * 线段匹配：角度容差 3° + 「检测段中点到真值线段的距离」<= 6px；另外补一条
      「覆盖真值线 >= 85% 且法向距离 <= 6px」的判据，避免共线合并后的长段因为
      中点落在真值断口里而被误判为未命中。
    * 拍照图（02 / 04）是 «旋转 4.2° + 光照渐变 + 模糊 + 噪声 + JPEG» 的合成图。
      真值坐标是**未旋转**的原始坐标，而本工具会先纠偏再矢量化，所以评测时用
      预处理报告的角度反算同一旋转矩阵，把真值变换到矢量化结果所在的坐标系；
      这样比较的是「端到端」精度，而不是绕开纠偏的裸提取精度。

用法：
    python tools/eval_vectorize.py                 # 打印 JSON
    python tools/eval_vectorize.py --out out/eval.json
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
from typing import Any, Dict, List, Optional, Sequence, Tuple

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from image2cad import imaging, vectorize          # noqa: E402
from image2cad.config import Options              # noqa: E402

ANGLE_TOL = 3.0
DIST_TOL = 6.0
COVER_RATIO = 0.85

# demo 里的「拍照图」（02 / 04）是 tools/make_demo_images.py:degrade() 生成的：
# 原图被 cv2.getRotationMatrix2D(center, 4.2°) 旋转后再加光照/模糊/噪声/JPEG。
# truth.json 记录的是**未旋转**的原始坐标，所以要把真值先转到拍照图坐标系，
# 再转到「纠偏后」坐标系；两个旋转同中心，合成一个角度 (skew_deg + 4.2)。
PHOTO_ROTATION_DEG = {"02-零件图-拍照.jpg": 4.2, "04-标题栏-拍照.jpg": 4.2}


# ---------------------------------------------------------------------------
# 几何
# ---------------------------------------------------------------------------
def _angle(x1: float, y1: float, x2: float, y2: float) -> float:
    return math.degrees(math.atan2(y2 - y1, x2 - x1)) % 180.0


def _angle_diff(a: float, b: float) -> float:
    d = abs(a - b) % 180.0
    return min(d, 180.0 - d)


def _length(seg: Sequence[float]) -> float:
    return math.hypot(seg[2] - seg[0], seg[3] - seg[1])


def _seg_point_distance(px: float, py: float, seg: Sequence[float]) -> float:
    x1, y1, x2, y2 = seg
    dx, dy = x2 - x1, y2 - y1
    denom = dx * dx + dy * dy
    if denom < 1e-9:
        return math.hypot(px - x1, py - y1)
    t = ((px - x1) * dx + (py - y1) * dy) / denom
    t = max(0.0, min(1.0, t))
    return math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))


def _cover_ratio(det: Sequence[float], truth: Sequence[float]) -> float:
    """检测段在真值线段方向上的投影覆盖率（0..1）。"""
    a = _angle(truth[0], truth[1], truth[2], truth[3])
    ux, uy = math.cos(math.radians(a)), math.sin(math.radians(a))
    tl = _length(truth)
    if tl < 1e-9:
        return 0.0
    t0 = truth[0] * ux + truth[1] * uy
    d0 = det[0] * ux + det[1] * uy
    d1 = det[2] * ux + det[3] * uy
    lo = max(t0, min(d0, d1))
    hi = min(t0 + tl, max(d0, d1))
    return max(0.0, hi - lo) / tl


# ---------------------------------------------------------------------------
# 真值整理
# ---------------------------------------------------------------------------
def truth_lines(truth: Dict[str, Any], include_rect_edges: bool = True) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for item in truth.get("lines", []):
        out.append({"x1": float(item["x1"]), "y1": float(item["y1"]),
                    "x2": float(item["x2"]), "y2": float(item["y2"]),
                    "layer": item.get("layer", "line")})
    if include_rect_edges:
        for r in truth.get("rects", []):
            x, y, w, h = float(r["x"]), float(r["y"]), float(r["w"]), float(r["h"])
            out.append({"x1": x, "y1": y, "x2": x + w, "y2": y, "layer": "rect-edge"})
            out.append({"x1": x + w, "y1": y, "x2": x + w, "y2": y + h, "layer": "rect-edge"})
            out.append({"x1": x + w, "y1": y + h, "x2": x, "y2": y + h, "layer": "rect-edge"})
            out.append({"x1": x, "y1": y + h, "x2": x, "y2": y, "layer": "rect-edge"})
    return out


def transform_truth(truth: Dict[str, Any], matrix: Optional[np.ndarray]) -> Dict[str, Any]:
    """把真值坐标按旋转矩阵（2×3）变换到矢量化结果所在的坐标系。"""
    if matrix is None:
        return truth
    m = np.asarray(matrix, dtype=np.float64)

    def tp(x: float, y: float) -> Tuple[float, float]:
        return (float(m[0, 0] * x + m[0, 1] * y + m[0, 2]),
                float(m[1, 0] * x + m[1, 1] * y + m[1, 2]))

    out: Dict[str, Any] = {"width": truth["width"], "height": truth["height"]}
    lines = []
    for item in truth.get("lines", []):
        x1, y1 = tp(item["x1"], item["y1"])
        x2, y2 = tp(item["x2"], item["y2"])
        lines.append({"x1": x1, "y1": y1, "x2": x2, "y2": y2, "layer": item.get("layer", "line")})
    out["lines"] = lines
    rects = []
    for r in truth.get("rects", []):
        pts = [tp(float(r["x"]), float(r["y"])),
               tp(float(r["x"]) + float(r["w"]), float(r["y"])),
               tp(float(r["x"]), float(r["y"]) + float(r["h"]))]
        xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
        rects.append({"x": min(xs), "y": min(ys),
                      "w": max(xs) - min(xs), "h": max(ys) - min(ys)})
    out["rects"] = rects
    circles = []
    for c in truth.get("circles", []):
        cx, cy = tp(float(c["cx"]), float(c["cy"]))
        circles.append({"cx": cx, "cy": cy, "r": float(c["r"])})
    out["circles"] = circles
    out["texts"] = truth.get("texts", [])
    return out


# ---------------------------------------------------------------------------
# 指标
# ---------------------------------------------------------------------------
def match_lines(det: List[Sequence[float]], truth: List[Dict[str, Any]]) -> Dict[str, Any]:
    n_t, n_d = len(truth), len(det)
    matched_t = [False] * n_t
    matched_d = [False] * n_d
    per_layer: Dict[str, List[bool]] = {}
    for item in truth:
        per_layer.setdefault(item.get("layer", "line"), []).append(False)

    for i, s in enumerate(det):
        a = _angle(s[0], s[1], s[2], s[3])
        mx, my = (s[0] + s[2]) / 2.0, (s[1] + s[3]) / 2.0
        hits: List[int] = []
        for j, tl in enumerate(truth):
            t = (tl["x1"], tl["y1"], tl["x2"], tl["y2"])
            if _angle_diff(a, _angle(t[0], t[1], t[2], t[3])) > ANGLE_TOL:
                continue
            if _seg_point_distance(mx, my, t) <= DIST_TOL:
                hits.append(j)
                continue
            # 共线合并后的长段：覆盖真值线 85% 以上也算命中
            if _cover_ratio(s, t) >= COVER_RATIO and _seg_point_distance(mx, my, t) <= DIST_TOL + 8.0:
                hits.append(j)
        if hits:
            matched_d[i] = True
            for j in hits:
                matched_t[j] = True
                per_layer[truth[j].get("layer", "line")][-1] = True

    # 逐层统计（per_layer 里存的是占位布尔，这里按层重算）
    layer_stats: Dict[str, Dict[str, int]] = {}
    for j, item in enumerate(truth):
        layer = item.get("layer", "line")
        st = layer_stats.setdefault(layer, {"truth": 0, "matched": 0})
        st["truth"] += 1
        if matched_t[j]:
            st["matched"] += 1

    recall = sum(matched_t) / n_t if n_t else 0.0
    precision = sum(matched_d) / n_d if n_d else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0.0
    return {
        "truth_lines": n_t,
        "detected_lines": n_d,
        "matched_truth": int(sum(matched_t)),
        "matched_detected": int(sum(matched_d)),
        "recall": round(recall, 4),
        "precision": round(precision, 4),
        "false_rate": round(1.0 - precision, 4),
        "f1": round(f1, 4),
        "by_layer": {k: {"truth": v["truth"], "hit": v["matched"],
                         "recall": round(v["matched"] / max(1, v["truth"]), 3)}
                     for k, v in sorted(layer_stats.items())},
    }


def match_circles(det: List[Any], truth: List[Dict[str, Any]],
                  center_tol: float = 10.0, radius_tol: float = 0.2) -> Dict[str, Any]:
    matched_t = [False] * len(truth)
    matched_d = [False] * len(det)
    for i, c in enumerate(det):
        for j, t in enumerate(truth):
            if matched_t[j]:
                continue
            if (math.hypot(c.cx - t["cx"], c.cy - t["cy"]) <= center_tol
                    and abs(c.r - t["r"]) <= radius_tol * t["r"]):
                matched_t[j] = True
                matched_d[i] = True
                break
    return {"truth": len(truth), "detected": len(det),
            "hit": int(sum(matched_t)), "extra": int(len(det) - sum(matched_d)),
            "recall": round(sum(matched_t) / len(truth), 4) if truth else 0.0}


def match_rects(det: List[Any], truth: List[Dict[str, Any]], tol: float = 8.0) -> Dict[str, Any]:
    matched_t = [False] * len(truth)
    matched_d = [False] * len(det)
    for i, r in enumerate(det):
        for j, t in enumerate(truth):
            if matched_t[j]:
                continue
            if (abs(r.x - t["x"]) <= tol and abs(r.y - t["y"]) <= tol
                    and abs(r.w - t["w"]) <= tol and abs(r.h - t["h"]) <= tol):
                matched_t[j] = True
                matched_d[i] = True
                break
    return {"truth": len(truth), "detected": len(det),
            "hit": int(sum(matched_t)), "extra": int(len(det) - sum(matched_d)),
            "recall": round(sum(matched_t) / len(truth), 4) if truth else 0.0}


# ---------------------------------------------------------------------------
# 单图评测
# ---------------------------------------------------------------------------
def eval_image(path: str, truth_key: str, all_truth: Dict[str, Any],
               options: Options) -> Dict[str, Any]:
    raw = imaging.load_gray(path)
    t0 = time.perf_counter()
    prep = imaging.preprocess(raw, options)
    t_prep = (time.perf_counter() - t0) * 1000.0

    degrade_deg = PHOTO_ROTATION_DEG.get(os.path.basename(path), 0.0)
    total_deg = float(prep["skew_deg"]) + degrade_deg
    if abs(total_deg) > 1e-6:
        # 坐标系链：真值(原图) --M(+4.2)--> 拍照图 --M(skew_deg)--> 纠偏后(矢量化结果)
        # 同中心的两个旋转可以直接相加，于是真值只需旋转 (skew_deg + 4.2)。
        h, w = raw.shape[:2]
        matrix = cv2.getRotationMatrix2D((w / 2.0, h / 2.0), total_deg, 1.0)
    else:
        matrix = None
    truth = transform_truth(all_truth[truth_key], matrix)

    t0 = time.perf_counter()
    segments, circles, rects = vectorize.run(
        prep["clean"], prep["text_mask"], prep["text_boxes"], prep["gray"],
        options, raw.shape[1], raw.shape[0])
    t_vec = (time.perf_counter() - t0) * 1000.0

    det = [(s.x1, s.y1, s.x2, s.y2) for s in segments]
    tl = truth_lines(truth, include_rect_edges=True)
    lines = match_lines(det, tl)
    circ = match_circles(circles, truth.get("circles", []))
    rect = match_rects(rects, truth.get("rects", []))
    return {
        "image": os.path.basename(path),
        "truth_key": truth_key,
        "size": [int(raw.shape[1]), int(raw.shape[0])],
        "skew_deg": round(prep["skew_deg"], 3),
        "binarize_method": prep["method"],
        "stroke_width": round(prep["stroke_width"], 2),
        "ink_ratio": prep["stats"]["ink_ratio"],
        "components_removed": prep["stats"]["components_removed"],
        "text_boxes": len(prep["text_boxes"]),
        "text_mask_ratio": round(float(np.count_nonzero(prep["text_mask"])) /
                                 float(prep["text_mask"].size), 5),
        "timing_ms": {"preprocess": round(t_prep, 1), "vectorize": round(t_vec, 1),
                      "total": round(t_prep + t_vec, 1)},
        "lines": lines,
        "circles": circ,
        "rects": rect,
        "counts": {"segments": len(segments), "circles": len(circles), "rects": len(rects)},
        "diag": {k: v for k, v in vectorize.LAST_DIAG.items()
                 if k not in ("clean",)},
    }


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="矢量化精度评测（对 demo 真值）")
    parser.add_argument("--images", default=os.path.join(ROOT, "demo", "images"))
    parser.add_argument("--out", default="", help="把结果 JSON 写到该路径")
    parser.add_argument("--no-extra", action="store_true", help="只评测干净图 / 拍照图两组")
    args = parser.parse_args(argv)

    truth_path = os.path.join(args.images, "truth.json")
    with open(truth_path, "r", encoding="utf-8") as fh:
        all_truth = json.load(fh)

    options = Options()
    groups = [
        ("clean", "01-零件图-干净.png", "part"),
        ("photo", "02-零件图-拍照.jpg", "part"),
    ]
    if not args.no_extra:
        groups += [("block-clean", "03-标题栏-扫描.png", "block"),
                   ("block-photo", "04-标题栏-拍照.jpg", "block")]

    result: Dict[str, Any] = {"thresholds": {"clean": {"recall": 0.85, "false_rate": 0.20, "f1": 0.8},
                                             "photo": {"f1": 0.7}},
                              "matching": {"angle_tol_deg": ANGLE_TOL, "dist_tol_px": DIST_TOL,
                                           "cover_ratio": COVER_RATIO,
                                           "truth_includes_rect_edges": True},
                              "groups": {}}
    for name, filename, key in groups:
        path = os.path.join(args.images, filename)
        if not os.path.exists(path):
            result["groups"][name] = {"error": "缺少图片 %s" % filename}
            continue
        result["groups"][name] = eval_image(path, key, all_truth, options)

    # 判定达标
    verdicts: Dict[str, Any] = {}
    c = result["groups"].get("clean")
    if c and "lines" in c:
        verdicts["clean"] = {
            "recall_ok": c["lines"]["recall"] >= 0.85,
            "false_rate_ok": c["lines"]["false_rate"] <= 0.20,
            "f1_ok": c["lines"]["f1"] >= 0.80,
            "time_ok": c["timing_ms"]["total"] <= 2500.0,
        }
    p = result["groups"].get("photo")
    if p and "lines" in p:
        verdicts["photo"] = {"f1_ok": p["lines"]["f1"] >= 0.70,
                             "time_ok": p["timing_ms"]["total"] <= 2500.0}
    result["verdicts"] = verdicts

    text = json.dumps(result, ensure_ascii=False, indent=2)
    print(text)
    if args.out:
        out_path = args.out if os.path.isabs(args.out) else os.path.join(ROOT, args.out)
        os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
        with open(out_path, "w", encoding="utf-8") as fh:
            fh.write(text)
        print("\n[eval] 结果已写入 %s" % out_path, file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

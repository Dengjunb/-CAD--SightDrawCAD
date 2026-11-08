# -*- coding: utf-8 -*-
"""
eval_roundtrip.py
=================
「看图成图」的定量评测：把矢量化结果与演示图的**真值几何**逐项比对。

为什么需要它：
    * 看图算法很容易"看着像但实际错"；只有和真值比，才能给出召回率/误检率/F1，
      并作为调参依据与验收证据；
    * 演示图（tools/make_demo_images.py）的图元位置是生成时就知道的，真值可控。

口径（与线段合并算法兼容，避免"一条长线覆盖两条真值线"被误判为漏检）：
    * 真值线段 = truth.lines + truth.rects 的四条边，长度 >= 40px 才计入；
    * 真值命中：沿真值线每 12px 采样一点，>=80% 采样点落在某条预测线段的 4px 内；
    * 误检线段：长度 >= 40px，沿预测线段采样 5 点，<60% 点落在真值几何 6px 内；
    * 圆：圆心距 <= 10px 且半径差 <= 10px。
用法：
    python tools/eval_roundtrip.py
    python tools/eval_roundtrip.py --images demo/images/01-零件图-干净.png --json
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
from typing import Any, Dict, List, Optional, Tuple

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from image2cad.config import Options          # noqa: E402
from image2cad.models import Segment         # noqa: E402
from image2cad.pipeline import run as run_pipeline  # noqa: E402

TruthLine = Tuple[float, float, float, float]


def _seg_dist(px: float, py: float, line: TruthLine) -> float:
    """点到**线段**（不是无限直线）的距离。"""
    x1, y1, x2, y2 = line
    dx, dy = x2 - x1, y2 - y1
    norm2 = dx * dx + dy * dy
    if norm2 < 1e-9:
        return math.hypot(px - x1, py - y1)
    t = max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / norm2))
    return math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))


def _sample(line: TruthLine, step: float) -> List[Tuple[float, float]]:
    x1, y1, x2, y2 = line
    length = math.hypot(x2 - x1, y2 - y1)
    n = max(2, int(length / step) + 1)
    return [(x1 + (x2 - x1) * i / (n - 1), y1 + (y2 - y1) * i / (n - 1)) for i in range(n)]


def _seg_as_line(s: Segment) -> TruthLine:
    return (s.x1, s.y1, s.x2, s.y2)


def _truth_lines(truth: Dict[str, Any], include_hatch: bool = False) -> List[Tuple[TruthLine, str]]:
    out: List[Tuple[TruthLine, str]] = []
    for ln in truth.get("lines", []):
        if ln.get("layer") == "hatch" and not include_hatch:
            continue
        line = (ln["x1"], ln["y1"], ln["x2"], ln["y2"])
        if math.hypot(line[2] - line[0], line[3] - line[1]) >= 40:
            out.append((line, ln.get("layer", "outline")))
    for rc in truth.get("rects", []):
        x, y, w, h = rc["x"], rc["y"], rc["w"], rc["h"]
        for line in [(x, y, x + w, y), (x, y + h, x + w, y + h),
                     (x, y, x, y + h), (x + w, y, x + w, y + h)]:
            if math.hypot(line[2] - line[0], line[3] - line[1]) >= 40:
                out.append((line, "rect"))
    return out


def _hit(truth: TruthLine, preds: List[Segment], tol: float = 4.0) -> bool:
    pts = _sample(truth, 12.0)
    if not pts:
        return False
    hits = sum(1 for px, py in pts if any(_seg_dist(px, py, _seg_as_line(s)) <= tol for s in preds))
    return hits / len(pts) >= 0.8


def evaluate_one(image_path: str, truth: Dict[str, Any], out_root: str,
                 options: Optional[Options] = None) -> Dict[str, Any]:
    t0 = time.time()
    result = run_pipeline(image_path, out_root, options, recognition=False)
    d = result.to_dict()
    scene = d["scene"]
    preds = [Segment(s["x1"], s["y1"], s["x2"], s["y2"]) for s in scene["segments"]]
    tlines = _truth_lines(truth)                 # 召回只在主干线上算（剖面线太密）
    tlines_all = _truth_lines(truth, True)       # 精确率要认剖面线，它也是真实几何

    hit_by_layer: Dict[str, List[bool]] = {}
    for line, layer in tlines:
        hit_by_layer.setdefault(layer, []).append(_hit(line, preds))
    matched = sum(sum(v) for v in hit_by_layer.values())
    recall = matched / max(1, len(tlines))

    long_preds = [p for p in preds if p.length >= 40]
    extras = 0
    for p in long_preds:
        pts = _sample(_seg_as_line(p), max(8.0, p.length / 4))
        near = sum(1 for px, py in pts
                   if any(_seg_dist(px, py, tl) <= 6.0 for tl, _ in tlines_all))
        if near / len(pts) < 0.6:
            extras += 1
    precision = (len(long_preds) - extras) / max(1, len(long_preds))
    f1 = 0.0 if precision + recall == 0 else 2 * precision * recall / (precision + recall)

    truth_circles = truth.get("circles", [])
    pred_circles = scene["circles"]
    circle_hits = sum(
        1 for tc in truth_circles
        if any(math.hypot(pc["cx"] - tc["cx"], pc["cy"] - tc["cy"]) <= 10
               and abs(pc["r"] - tc["r"]) <= 10 for pc in pred_circles))

    return {
        "image": os.path.basename(image_path),
        "elapsed_ms": round((time.time() - t0) * 1000, 1),
        "run_id": result.run_id,
        "segments": len(preds),
        "truth_lines": len(tlines),
        "matched_lines": matched,
        "recall": round(recall, 3),
        "extra_segments": extras,
        "precision": round(precision, 3),
        "f1": round(f1, 3),
        "circles": len(pred_circles),
        "truth_circles": len(truth_circles),
        "circles_hit": circle_hits,
        "rects": len(scene["rects"]),
        "quality_f1": d["quality"]["f1"],
        "per_layer": {k: {"total": len(v), "hit": sum(v)} for k, v in hit_by_layer.items()},
    }


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="看图成图回归评测（与演示图真值比对）")
    ap.add_argument("--images", nargs="+", default=[
        os.path.join("demo", "images", "01-零件图-干净.png"),
        os.path.join("demo", "images", "02-零件图-拍照.jpg"),
    ])
    ap.add_argument("--truth", default=os.path.join("demo", "images", "truth.json"))
    ap.add_argument("--out", default=os.path.join("out", "eval"))
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    with open(args.truth, "r", encoding="utf-8") as fh:
        truths = json.load(fh)
    truth = truths["part"]

    results = []
    for img in args.images:
        res = evaluate_one(img, truth, args.out)
        results.append(res)
        print(f"{res['image']:<26} 线段 {res['segments']:>3} 召回 {res['recall']:.3f} "
              f"误检 {res['extra_segments']:>2} 精确 {res['precision']:.3f} F1 {res['f1']:.3f} "
              f"圆 {res['circles_hit']}/{res['truth_circles']} 耗时 {res['elapsed_ms']:.0f}ms")

    os.makedirs(args.out, exist_ok=True)
    out_path = os.path.join(args.out, "eval_roundtrip.json")
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(results, fh, ensure_ascii=False, indent=1)
    print("评测结果 ->", out_path)
    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

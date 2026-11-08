# -*- coding: utf-8 -*-
"""
vectorize.py
============
「看图成图」矢量化：二值图 → 线段 / 圆 / 矩形。

为什么这样设计：
    * **文字笔画必须先掩掉再跑 Hough**：汉字与数字在 Hough 累加器里是成堆的短
      斜线，这是本产品最大的误检来源。预处理已给出 text_mask，这里在检测前
      再做一次掩膜 + 「整条落在文字区里」的线段剔除，双保险。
    * **Hough 参数按尺寸自适应**：阈值、最短线、最大断口全部相对图像长边换算，
      同一套参数才能同时适配 800px 缩略图与 2600px 扫描件。
    * **先合并共线、再吸附、最后合成矩形**：合并统一了同一根线被拆成多段的问题，
      吸附把「手画/扫描的 0.5° 抖动」拉成精确的 0°/90°，矩形合成则利用端点闭合
      把四条边提升为一个真正的闭合轮廓（DXF 里可直接当多段线/矩形）。
    * **圆的支撑率过滤**：HoughCircles 对圆弧/文字很有想象力，因此对每个候选圆
      在**去掉文字区**的二值图上采样圆周做支撑率统计，低于阈值一律否决。
"""
from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Sequence, Tuple

import cv2
import numpy as np

from .models import Circle, Rect, Segment
from . import cadclean

# 最近一次 run() 的诊断信息（供 tools/eval_vectorize.py、调试用；不参与对外契约）
LAST_DIAG: Dict[str, Any] = {}
# 最近一次 run() 的 CAD 拓扑整理结果（pipeline 读取后放进 VectorScene）
LAST_POLYLINES: list = []
LAST_CONSUMED: set = set()

_EPS = 1e-9


# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------
def _long_side(diag: Dict[str, Any]) -> float:
    return float(diag.get("long_side") or max(diag.get("width", 1), diag.get("height", 1)))


def _as_rows(result) -> np.ndarray:
    """把 OpenCV 的返回值归一化为 (N, K) 浮点数组。

    OpenCV 4.x 的 HoughLinesP 返回 (N, 1, 4)、HoughCircles 返回 (1, M, 3)；
    OpenCV 5.0 直接返回 (N, 4) / (M, 3)。统一成 (N, K)，避免版本差异导致索引崩溃。
    """
    if result is None:
        return np.zeros((0, 4), dtype=np.float64)
    arr = np.asarray(result, dtype=np.float64)
    if arr.ndim == 3:
        arr = arr[0] if arr.shape[0] == 1 else arr[:, 0, :]
    elif arr.ndim == 1:
        arr = arr.reshape(1, -1)
    return arr


def _seg_arrays(segments: Sequence[Segment]) -> np.ndarray:
    """把线段列表转成 (n, 4) float64 数组。"""
    if not segments:
        return np.zeros((0, 4), dtype=np.float64)
    return np.array([[s.x1, s.y1, s.x2, s.y2] for s in segments], dtype=np.float64)


def _arrays_seg(arr: np.ndarray, source: str = "hough") -> List[Segment]:
    return [Segment(float(a[0]), float(a[1]), float(a[2]), float(a[3]), source=source) for a in arr]


def _angle_deg(arr: np.ndarray) -> np.ndarray:
    return (np.degrees(np.arctan2(arr[:, 3] - arr[:, 1], arr[:, 2] - arr[:, 0]))) % 180.0


def _point_seg_distance(px: float, py: float, arr: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    """点到线段集合的距离与投影参数 t（0..1 已夹取）。"""
    dx = arr[:, 2] - arr[:, 0]
    dy = arr[:, 3] - arr[:, 1]
    denom = dx * dx + dy * dy
    denom = np.where(denom < _EPS, _EPS, denom)
    t = ((px - arr[:, 0]) * dx + (py - arr[:, 1]) * dy) / denom
    t = np.clip(t, 0.0, 1.0)
    qx = arr[:, 0] + t * dx
    qy = arr[:, 1] + t * dy
    return np.hypot(px - qx, py - qy), t


# ---------------------------------------------------------------------------
# 线段检测
# ---------------------------------------------------------------------------
def detect_lines(clean: np.ndarray, text_mask: Optional[np.ndarray],
                 options, diag: Dict[str, Any]) -> List[Segment]:
    """HoughLinesP 直线检测（掩掉文字区、参数按尺寸自适应）。

    返回按长度降序排列的线段列表（source="hough"）。
    """
    h, w = clean.shape[:2]
    long_side = float(max(h, w))
    work = clean.copy()
    if text_mask is not None and getattr(text_mask, "size", 0) == work.size:
        work[text_mask > 0] = 0

    min_len = max(6, int(round(float(options.min_line_ratio) * long_side)))
    max_gap = max(2, int(round(float(options.max_gap_ratio) * long_side)))
    # 阈值随尺寸放大（累加器票数与线的像素长度成正比），并限制在安全区间
    base = float(getattr(options, "hough_threshold", 40))
    threshold = int(np.clip(base * (long_side / 1800.0), 12.0, 160.0))

    found: List[Segment] = []
    # 只跑一遍主阈值：低阈值补线那遍的收益已被「自适应二值化」覆盖，
    # 而它会让 Hough 的耗时翻倍（实测拍照图 300ms → 170ms）。
    for factor in (1.0,):
        thr = max(8, int(round(threshold * factor)))
        lines = cv2.HoughLinesP(work, 1, np.pi / 360.0, thr,
                                minLineLength=max(4, int(min_len * (0.6 if factor < 1 else 1.0))),
                                maxLineGap=max_gap)
        rows = _as_rows(lines)
        for x1, y1, x2, y2 in rows[:, :4]:
            length = math.hypot(x2 - x1, y2 - y1)
            if length < min_len * (0.8 if factor < 1 else 1.0):
                continue
            found.append(Segment(float(x1), float(y1), float(x2), float(y2), source="hough"))

    # 整条几乎落在文字区里的线段：直接剔除（阈值 0.55，避免误伤压字的图线）
    if text_mask is not None and getattr(text_mask, "size", 0) == clean.size and found:
        arr = _seg_arrays(found)
        keep = np.ones(len(found), dtype=bool)
        for i, (x1, y1, x2, y2) in enumerate(arr):
            ts = np.linspace(0.08, 0.92, 12)
            xs = np.rint(x1 + (x2 - x1) * ts).astype(np.int32)
            ys = np.rint(y1 + (y2 - y1) * ts).astype(np.int32)
            np.clip(xs, 0, w - 1, out=xs)
            np.clip(ys, 0, h - 1, out=ys)
            if float(np.mean(text_mask[ys, xs] > 0)) > 0.55:
                keep[i] = False
        found = [s for s, k in zip(found, keep) if k]

    found.sort(key=lambda s: -s.length)
    diag.setdefault("lines", {})["raw"] = len(found)
    diag["lines"]["hough_threshold"] = threshold
    diag["lines"]["min_len"] = min_len
    return found


def merge_collinear(segments: Sequence[Segment], options, diag: Dict[str, Any]) -> List[Segment]:
    """合并共线 / 近共线线段（同一根线被 Hough 拆成多段、或双边缘各出一条）。

    判定三个条件同时成立才合并：
        1. 角度差 <= options.merge_angle_deg；
        2. 法向距离差 <= options.merge_dist_ratio × 长边；
        3. 沿方向的投影间隙 <= options.merge_gap_ratio × 长边（允许虚线/断口）。
    """
    if len(segments) < 2:
        return list(segments)
    long_side = _long_side(diag)
    arr = _seg_arrays(segments)
    dx = arr[:, 2] - arr[:, 0]
    dy = arr[:, 3] - arr[:, 1]
    length = np.hypot(dx, dy)
    theta = (np.degrees(np.arctan2(dy, dx))) % 180.0
    t = np.radians(theta)
    ux, uy = np.cos(t), np.sin(t)
    rho = -uy * arr[:, 0] + ux * arr[:, 1]
    p1 = ux * arr[:, 0] + uy * arr[:, 1]
    p2 = ux * arr[:, 2] + uy * arr[:, 3]
    tmin = np.minimum(p1, p2)
    tmax = np.maximum(p1, p2)

    tol_ang = float(options.merge_angle_deg)
    tol_dist = max(1.5, float(options.merge_dist_ratio) * long_side)
    tol_gap = max(2.0, float(options.merge_gap_ratio) * long_side)

    n = len(arr)
    parent = list(range(n))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(i: int, j: int) -> None:
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[rj] = ri

    for i in range(n):
        dth = np.abs(theta - theta[i])
        dth = np.minimum(dth, 180.0 - dth)
        drho = np.abs(rho - rho[i])
        gap = np.maximum(tmin - tmax[i], tmin[i] - tmax)
        ok = (dth <= tol_ang) & (drho <= tol_dist) & (gap <= tol_gap)
        ok[: i + 1] = False
        for j in np.nonzero(ok)[0]:
            union(i, int(j))

    groups: Dict[int, List[int]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)

    merged: List[Segment] = []
    for members in groups.values():
        if len(members) == 1:
            idx = members[0]
            merged.append(Segment(*[float(v) for v in arr[idx]], source=segments[idx].source))
            continue
        idx = np.asarray(members)
        wt = np.maximum(length[idx], 1.0)
        th = float(np.average(theta[idx], weights=wt))
        # 角度加权平均可能越过 0/180 边界，取与第一个成员更接近的表示
        if abs(th - theta[idx[0]]) > 90.0:
            th = (th + 180.0) % 180.0
        tr = math.radians(th)
        u = np.array([math.cos(tr), math.sin(tr)])
        nvec = np.array([-u[1], u[0]])
        rh = float(np.average(rho[idx], weights=wt))
        pts = np.vstack([arr[idx][:, :2], arr[idx][:, 2:]])
        proj = pts @ u
        base = nvec * rh
        a = base + u * float(proj.min())
        b = base + u * float(proj.max())
        merged.append(Segment(float(a[0]), float(a[1]), float(b[0]), float(b[1]),
                              source=segments[idx[0]].source))

    merged.sort(key=lambda s: -s.length)
    diag.setdefault("merge", {}).update({"in": n, "out": len(merged),
                                         "tol_ang": tol_ang, "tol_dist": round(tol_dist, 2)})
    return merged


def snap_segments(segments: Sequence[Segment], options, width: int, height: int
                  ) -> List[Segment]:
    """横平竖直吸附 + 端点吸附闭合（T 形接点 / 断口）。

    顺序很重要：先把近轴线的角度拉正，再做端点吸附，否则吸附好的接点会被
    随后的旋转再次拉开。
    """
    if not segments:
        return []
    if options is None:                      # 容错：允许不传 options
        class _Default:
            snap_ortho_deg = 2.0
            endpoint_snap_ratio = 0.006
        options = _Default()
    long_side = float(max(width, height))
    arr = _seg_arrays(segments).copy()

    # 1) 横平竖直吸附：保持中点不变地拉直（角度小，端点位移量级可控）
    tol_ortho = float(getattr(options, "snap_ortho_deg", 2.0))
    if tol_ortho > 0:
        ang = _angle_deg(arr)
        horiz = (ang <= tol_ortho) | (ang >= 180.0 - tol_ortho)
        vert = np.abs(ang - 90.0) <= tol_ortho
        if horiz.any():
            ym = 0.5 * (arr[horiz, 1] + arr[horiz, 3])
            arr[horiz, 1] = ym
            arr[horiz, 3] = ym
        if vert.any():
            xm = 0.5 * (arr[vert, 0] + arr[vert, 2])
            arr[vert, 0] = xm
            arr[vert, 2] = xm

    # 2) 端点吸附：不同线段之间的近邻端点归并到同一坐标（闭合 + T 接点）
    #    容差按长边自适应但设上限：上限过大会把真实长线端点拉到十几像素外的
    #    短线上，破坏刚做好的横平竖直。吸附只允许「沿线方向」的位移，垂线方向
    #    最多移动 tol_perp，横向错位交给第 3 步的投影吸附处理。
    tol_end = min(8.0, max(2.0, float(getattr(options, "endpoint_snap_ratio", 0.006)) * long_side))
    tol_perp = min(3.0, tol_end * 0.5)
    pts = np.vstack([arr[:, :2], arr[:, 2:]]).astype(np.float64)   # 2n × 2
    m = pts.shape[0]
    # 每个端点的所属线段方向（用于判断位移是否沿线方向）
    dirs = np.zeros((m, 2), dtype=np.float64)
    for k in range(len(arr)):
        dx, dy = arr[k, 2] - arr[k, 0], arr[k, 3] - arr[k, 1]
        ln = math.hypot(dx, dy)
        if ln > _EPS:
            dirs[2 * k] = (dx / ln, dy / ln)
            dirs[2 * k + 1] = (dx / ln, dy / ln)
    changed = True
    rounds = 0
    cell = max(2.0, tol_end)
    while changed and rounds < 3:
        changed = False
        rounds += 1
        # 空间哈希：按 cell 分桶，只查 3×3 邻域（避免 O(m²) 距离矩阵）
        buckets: Dict[Tuple[int, int], List[int]] = {}
        for idx in range(m):
            key = (int(pts[idx, 0] // cell), int(pts[idx, 1] // cell))
            buckets.setdefault(key, []).append(idx)
        for i in range(m):
            key = (int(pts[i, 0] // cell), int(pts[i, 1] // cell))
            best_j, best_d = -1, tol_end + 1.0
            for gx in (key[0] - 1, key[0], key[0] + 1):
                for gy in (key[1] - 1, key[1], key[1] + 1):
                    for j in buckets.get((gx, gy), ()):
                        if j == i or i // 2 == j // 2:   # 同一线段的另一端点不能吸附
                            continue
                        d = float(np.hypot(pts[i, 0] - pts[j, 0], pts[i, 1] - pts[j, 1]))
                        if d >= best_d:
                            continue
                        # 位移分解：轴向（沿线）与垂向（横跨线）
                        dx, dy = pts[j, 0] - pts[i, 0], pts[j, 1] - pts[i, 1]
                        ux, uy = dirs[i]
                        perp = abs(dx * uy - dy * ux)
                        if perp > tol_perp:
                            continue
                        best_j, best_d = j, d
            if best_j >= 0:
                target = pts[best_j]
                if np.abs(pts[i] - target).max() > 1e-6:
                    pts[i] = target.copy()
                    changed = True

    arr[:, :2] = pts[: len(arr)]
    arr[:, 2:] = pts[len(arr):]

    # 3) 投影吸附：端点落在另一条线段上（T 形接点）时贴到该线段
    #    只处理真正的小间隙（≤4px），避免把长线端点拖到远处的平行线上。
    tol_proj = min(tol_end, 4.0)
    for i in range(len(arr)):
        for k in (0, 1):
            px, py = arr[i, k * 2], arr[i, k * 2 + 1]
            cand = np.delete(arr, i, axis=0)
            if not len(cand):
                continue
            d, tt = _point_seg_distance(px, py, cand)
            j = int(np.argmin(d))
            if d[j] <= tol_proj and 0.02 < tt[j] < 0.98:
                dx = cand[j, 2] - cand[j, 0]
                dy = cand[j, 3] - cand[j, 1]
                nx = cand[j, 0] + tt[j] * dx
                ny = cand[j, 1] + tt[j] * dy
                arr[i, k * 2] = nx
                arr[i, k * 2 + 1] = ny

    # 4) 去掉退化线段（太短）与重复线段（正反方向、1~2px 抖动都算重复）
    out: List[Segment] = []
    for row in arr:
        length = math.hypot(row[2] - row[0], row[3] - row[1])
        if length < 2.0:
            continue
        cand = Segment(float(row[0]), float(row[1]), float(row[2]), float(row[3]), source="hough")
        dup = False
        for kept in out:
            if (_same_point(cand.x1, cand.y1, kept.x1, kept.y1)
                    and _same_point(cand.x2, cand.y2, kept.x2, kept.y2)):
                dup = True
                break
            if (_same_point(cand.x1, cand.y1, kept.x2, kept.y2)
                    and _same_point(cand.x2, cand.y2, kept.x1, kept.y1)):
                dup = True
                break
        if not dup:
            out.append(cand)
    out.sort(key=lambda s: -s.length)
    return out


def _same_point(x1: float, y1: float, x2: float, y2: float, tol: float = 2.0) -> bool:
    return abs(x1 - x2) <= tol and abs(y1 - y2) <= tol


def _dedupe_segments(segments: Sequence[Segment]) -> List[Segment]:
    """删除端点相同（或仅方向相反）的重复线段，保留首次出现的。"""
    unique: List[Segment] = []
    for s in segments:
        dup = any(_same_point(s.x1, s.y1, k.x1, k.y1)
                  and _same_point(s.x2, s.y2, k.x2, k.y2)
                  or _same_point(s.x1, s.y1, k.x2, k.y2)
                  and _same_point(s.x2, s.y2, k.x1, k.y1)
                  for k in unique)
        if not dup:
            unique.append(s)
    return unique


def drop_circle_chords(segments: Sequence[Segment], circles: Sequence[Circle],
                       options=None, diag: Optional[Dict[str, Any]] = None) -> List[Segment]:
    """剔除「圆心弧被 Hough 拆成的一串短弦」。

    Hough 眼里圆弧就是一堆短直线段，这些弦既不是真实直线，又数量最多（实测
    一段 150px 半径的圆弧能贡献 30+ 条假线），是干净图误检率的主因。
    判据：线段两个端点都落在某个已识别圆的圆周（容差内），且弦长明显短于直径。
    """
    if not circles:
        return list(segments)
    stroke = float((diag or {}).get("stroke", 2.0))
    out: List[Segment] = []
    dropped = 0
    # 小孔内部不可能有真实直线；Hough 在粗圆环上会生成穿过孔心的长弦，
    # 这些弦的两个端点常跑到圆周外 1~2 倍半径处，仅靠「端点在圆周上」删不掉。
    long_side = _long_side(diag or {})
    small_circle = max(20.0, 0.08 * long_side)
    for s in segments:
        chord = False
        for c in circles:
            dist1 = math.hypot(s.x1 - c.cx, s.y1 - c.cy)
            dist2 = math.hypot(s.x2 - c.cx, s.y2 - c.cy)
            # 支撑直线到圆心的距离：<= 0.12r 视为中心线/径向线，必须保留。
            # 否则穿过圆并伸到圆外的中心线会被「长弦」规则整条删掉。
            line_dist = abs((s.y2 - s.y1) * (c.cx - s.x1)
                            - (s.x2 - s.x1) * (c.cy - s.y1)) / max(s.length, _EPS)
            center_line = line_dist <= max(3.0, 0.12 * c.r)
            tol = max(4.0, 1.5 * stroke + 1.0, 0.06 * c.r)
            # 圆内的中心线短划（水平/竖直、穿近圆心、长度 < 0.55r）要保留：
            # 它们的两端也常落在圆周附近，不区分会被当成圆弧弦删掉。
            # 必须同时「穿近圆心」，否则贴在圆周上的短弦（真正的圆弧碎段）会被误留。
            axis_dash = False
            if (s.length <= 0.55 * c.r
                    and (abs(s.y2 - s.y1) <= 0.10 * s.length
                         or abs(s.x2 - s.x1) <= 0.10 * s.length)):
                dash_mid = math.hypot((s.x1 + s.x2) * 0.5 - c.cx,
                                      (s.y1 + s.y2) * 0.5 - c.cy)
                axis_dash = dash_mid <= 0.55 * c.r
            if (abs(dist1 - c.r) <= tol and abs(dist2 - c.r) <= tol
                    and s.length <= 1.15 * c.r and not axis_dash
                    and not center_line):
                chord = True
                break
            if c.r <= small_circle:
                mid = math.hypot((s.x1 + s.x2) * 0.5 - c.cx,
                                 (s.y1 + s.y2) * 0.5 - c.cy)
                # 下限 0.75r：保留圆内的短中心线/十字线（长度通常 < 0.3r），
                # 只删横跨小孔的假弦（长度通常 >= 1r）。
                if (0.75 * c.r <= s.length <= 3.5 * c.r
                        and max(dist1, dist2) <= 2.2 * c.r
                        and mid <= 1.2 * c.r and not center_line):
                    chord = True
                    break
        if chord:
            dropped += 1
        else:
            out.append(s)
    if diag is not None:
        diag.setdefault("circles", {})["chord_dropped"] = dropped
    return out


# ---------------------------------------------------------------------------
# 圆检测
# ---------------------------------------------------------------------------
def _support_map(binary: np.ndarray) -> np.ndarray:
    """墨迹距离场：值 = 该点到最近墨迹像素的距离（越小越「贴着线」）。"""
    ink = (binary > 0).astype(np.uint8)
    return cv2.distanceTransform(1 - ink, cv2.DIST_L2, 3)


def _sample_support(dt: np.ndarray, mask: Optional[np.ndarray], thr: float,
                    cand: np.ndarray, samples: int = 72
                    ) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """批量统计一批候选圆的圆周支撑情况。

    参数:
        dt:   墨迹距离场（值 = 到最近墨迹像素的距离）
        mask: 文字笔画掩膜（掩掉的角度不计入支撑率）
        thr:  判定「贴在线上」的距离阈值
        cand: (C, 3) 的 [cx, cy, r]

    返回:
        support   : (C,) 未被掩膜覆盖的角度里，贴线角度所占比例
        free      : (C,) 圆周上未被文字区覆盖的比例
        med_dist  : (C,) 贴线采样点距离的中位数（越小越贴合）
        max_gap   : (C,) 最长连续不贴线的角度段占比
    """
    n = len(cand)
    if n == 0:
        return (np.zeros(0), np.zeros(0), np.zeros(0), np.zeros(0))
    h, w = dt.shape[:2]
    ang = np.linspace(0.0, 2.0 * math.pi, samples, endpoint=False)
    cos_a, sin_a = np.cos(ang), np.sin(ang)
    xs = np.rint(cand[:, 0:1] + cand[:, 2:3] * cos_a[None, :]).astype(np.int32)
    ys = np.rint(cand[:, 1:2] + cand[:, 2:3] * sin_a[None, :]).astype(np.int32)
    inside = (xs >= 0) & (xs < w) & (ys >= 0) & (ys < h)
    np.clip(xs, 0, max(0, w - 1), out=xs)
    np.clip(ys, 0, max(0, h - 1), out=ys)
    d = np.where(inside, dt[ys, xs], 1e6)
    ok = (d <= thr) & inside
    if mask is not None and getattr(mask, "size", 0) == dt.size:
        free = inside & ~(mask[ys, xs] > 0)
    else:
        free = inside.copy()
    free_n = free.sum(axis=1)
    support = np.where(free_n > 0, (ok & free).sum(axis=1) / np.maximum(free_n, 1), 0.0)
    free_ratio = free_n / float(samples)
    # 贴线采样点的距离中位数（对每行只取 ok 的那些值的中位数）
    dsorted = np.sort(np.where(ok, d, np.inf), axis=1)
    k = ok.sum(axis=1)
    idx = np.maximum(0, (k - 1) // 2)
    med = np.where(k > 0, dsorted[np.arange(n), idx], 99.0)
    # 「是否有大缺口」的向量化版本：把圆周分成 24 个 15° 扇区，
    # 统计「至少有一个采样点贴线」的扇区比例。真正的圆接近 1；
    # 几段圆弧拼出来的假圆总有若干整扇区落空（等价于最大空弧 > 30°）。
    # 用扇区覆盖率而不是「最长连续不贴线段」，是为了避免逐候选的 Python 循环
    # （实测 2000+ 候选时那一步要 150ms 以上）。
    sectors = min(24, samples)
    per = max(1, samples // sectors)
    usable = sectors * per
    ok_s = ok[:, :usable].reshape(n, sectors, per)
    arc_cov = ok_s.any(axis=2).mean(axis=1)
    return support, free_ratio, med, arc_cov




def _same_circle(a: Circle, b: Circle) -> bool:
    """两个圆是否互为「同一个几何圆」的重复检测。

    粗线的内外沿、Hough 与轮廓回退各检出一次时，圆心几乎重合、半径只差
    约一个线宽；但真正的同心圆（齿轮双圈、皮带轮外圈）半径差明显更大。
    因此用「圆心 + 绝对半径差」而不是宽泛的半径比例，避免把双圈并掉。
    """
    center_tol = min(12.0, max(6.5, 0.18 * max(a.r, b.r)))
    radius_tol = min(10.0, max(4.0, 0.18 * max(a.r, b.r)))
    return (math.hypot(a.cx - b.cx, a.cy - b.cy) <= center_tol
            and abs(a.r - b.r) <= radius_tol)


def _contour_circle_fallback(binary: np.ndarray, text_mask, stroke: float,
                             r_min: float, r_max: float, existing,
                             diag: Dict[str, Any]):
    """闭合轮廓圆度回退：轮廓越接近圆（4πA/P² 高）越可能是圆。

    Hough 对「被剖面线 / 尺寸线穿过的圆」容易漏检；这类圆在二值图上仍是闭合环，
    用轮廓圆度 + 最小外接圆可以补回来。方形的圆度是 π/4≈0.785，阈值取 0.88 可区分。
    """
    from .models import Circle as _Circle

    if binary is None or not getattr(binary, "size", 0):
        return []
    mask = binary.copy()
    if text_mask is not None and getattr(text_mask, "size", 0) == mask.size:
        mask[text_mask > 0] = 0
    contours, _ = cv2.findContours(mask, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
    out = []
    for c in contours:
        area = float(cv2.contourArea(c))
        per = float(cv2.arcLength(c, True))
        if per < 30.0 or area < 30.0:
            continue
        circ = 4.0 * math.pi * area / (per * per)
        if circ < 0.88:
            continue
        (cx, cy), r = cv2.minEnclosingCircle(c)
        r = float(r) - stroke * 0.5          # 轮廓是笔画外沿，减半个线宽回到中心线
        if not (r_min <= r <= r_max):
            continue
        # 与已有圆去重：既要比 Hough 结果，也要比本轮已补的圆。
        # 粗圆环的内外两条轮廓会各回退出一个圆（半径差约一个线宽），
        # 只和 existing 比时这两个「孪生圆」会同时进入结果。
        candidate = _Circle(float(cx), float(cy), r)
        dup = False
        for k in list(existing) + out:
            if _same_circle(candidate, k):
                dup = True
                break
        if dup:
            continue
        out.append(candidate)
        diag.setdefault("circles", {}).setdefault("fallback", 0)
        diag["circles"]["fallback"] += 1
    return out


def _radial_circle_candidates(binary: np.ndarray, text_mask, stroke: float,
                              existing: Sequence[Circle], r_min: float, r_max: float,
                              diag: Dict[str, Any]) -> List[Circle]:
    """沿已知圆心做径向墨迹扫描，补回 Hough 漏掉的同心圆。

    Hough 对「半径只差 10~30px 的双圈/多层套圈」容易只检出一个（另一个圆
    的票数被抑制），齿轮外圈、皮带轮外圈实测都会漏。机械图里这些圆几乎
    都以同一圆心同心，因此在已检出的几个大圆心处，按半径扫描整圈墨迹
    支撑率，支撑率 >= 0.92 的连续半径带就是真实圆。
    """
    if binary is None or not getattr(binary, "size", 0) or not existing:
        return []
    from .models import Circle as _Circle

    mask = binary.copy()
    if text_mask is not None and getattr(text_mask, "size", 0) == mask.size:
        mask[text_mask > 0] = 0
    dt = _support_map(mask)
    h, w = mask.shape[:2]
    thr = float(np.clip(0.6 * stroke + 1.2, 1.8, 4.0))
    angles = 240
    ang = np.linspace(0.0, 2.0 * math.pi, angles, endpoint=False)
    ca, sa = np.cos(ang), np.sin(ang)
    out: List[Circle] = []
    # 只取半径最大的 3 个圆心，兼顾同心套圈与耗时（每个圆心约 0.5k×240 次采样）
    for seed in sorted(existing, key=lambda c: -c.r)[:3]:
        radii = np.arange(int(max(10.0, r_min)),
                          int(min(r_max, 0.48 * min(h, w))) + 1, dtype=np.float64)
        if radii.size < 3:
            continue
        xs = np.rint(seed.cx + radii[:, None] * ca[None, :]).astype(np.int32)
        ys = np.rint(seed.cy + radii[:, None] * sa[None, :]).astype(np.int32)
        inside = (xs >= 0) & (xs < w) & (ys >= 0) & (ys < h)
        np.clip(xs, 0, w - 1, out=xs)
        np.clip(ys, 0, h - 1, out=ys)
        support = ((dt[ys, xs] <= thr) & inside).mean(axis=1)

        high = support >= 0.80
        runs: List[Tuple[int, int]] = []
        start = None
        for i, flag in enumerate(high):
            if flag and start is None:
                start = i
            elif not flag and start is not None:
                runs.append((start, i - 1))
                start = None
        if start is not None:
            runs.append((start, len(high) - 1))

        min_width = max(1, int(round(stroke * 0.5)))
        for a, b in runs:
            band = support[a:b + 1]
            if b - a + 1 < min_width or float(band.mean()) < 0.92:
                continue
            r = float(np.average(radii[a:b + 1], weights=np.maximum(band, 1e-6)))
            cand = _Circle(float(seed.cx), float(seed.cy), r)
            if any(_same_circle(cand, k) for k in list(existing) + out):
                continue
            out.append(cand)
            diag.setdefault("circles", {}).setdefault("radial", 0)
            diag["circles"]["radial"] += 1
    return out


def detect_circles(gray: np.ndarray, text_mask: Optional[np.ndarray],
                   options, diag: Dict[str, Any],
                   hough_gray: Optional[np.ndarray] = None) -> List[Circle]:
    """HoughCircles（单尺度 + 高 param2 粗筛）+ 圆周支撑率精筛。

    性能要点（实测把 11.6s 降到 ~0.3s）：
        * 只在长边 900px 的缩小图上跑一次 Hough，半径按缩放比换算；
        * param2 取较高值，先粗筛出少量候选，不做多尺度/多参数循环；
        * 支撑率统计对「所有候选」一次性向量化，只有通过粗筛的少数才做局部精修。
    精度要点：
        * 支撑率在「去噪 clean 且去掉文字区」的距离场上统计，文字笔画不会被当成圆；
        * 同时要求「最长缺口 <= 25% 周长」，几段圆弧拼出来的假圆会被拒。
    """
    if not getattr(options, "detect_circles", True):
        return []
    h, w = gray.shape[:2]
    long_side = float(max(h, w))
    short_side = float(min(h, w))
    r_min = max(4.0, float(options.circle_min_ratio) * long_side)
    r_max = min(float(options.circle_max_ratio) * long_side, 0.45 * short_side)
    if r_max <= r_min:
        return []

    binary = diag.get("clean")
    if binary is None:
        _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    support_binary = binary.copy()
    if text_mask is not None and getattr(text_mask, "size", 0) == support_binary.size:
        support_binary[text_mask > 0] = 0        # 圆的边缘若被文字区掩掉，不计入支撑
    stroke = float(diag.get("stroke", 2.0))
    thr = float(np.clip(0.6 * stroke + 1.2, 1.8, 4.0))
    dt = _support_map(support_binary)

    scale = min(1.0, 900.0 / long_side)
    # 双路 Hough：去噪图 + 未去噪图。两者对同心圆各有偏好（实测法兰的去噪图
    # 只能找到外圆、未去噪图只能找到内孔），取并集再由支撑率/去重统一筛。
    sources = [gray]
    if (hough_gray is not None and getattr(hough_gray, "shape", None) == gray.shape
            and hough_gray is not gray):
        sources.append(hough_gray)
    cand_parts: List[np.ndarray] = []
    for src in sources:
        small = cv2.resize(src, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
        # 不能在中值滤波后再跑 Hough：缩小后细圆弧只剩 1px，中值会把整段弧抹掉
        small = cv2.GaussianBlur(small, (3, 3), 0.8)
        min_dist = max(8, int(round(0.9 * r_min * scale)))
        found = cv2.HoughCircles(
            small, cv2.HOUGH_GRADIENT, dp=1.2, minDist=min_dist, param1=110.0, param2=34.0,
            minRadius=max(3, int(r_min * scale)), maxRadius=max(5, int(r_max * scale)))
        rows = _as_rows(found)
        part = np.zeros((len(rows), 3), dtype=np.float64)
        if len(rows):
            part[:, 0] = rows[:, 0] / scale
            part[:, 1] = rows[:, 1] / scale
            part[:, 2] = rows[:, 2] / scale
        cand_parts.append(part)
    cand = np.vstack(cand_parts) if cand_parts else np.zeros((0, 3), dtype=np.float64)
    diag.setdefault("circles", {})["candidates"] = int(len(cand))
    diag["circles"]["hough_passes"] = len(cand_parts)
    if len(cand) == 0:
        return []

    support, free_ratio, med_dist, arc_cov = _sample_support(dt, text_mask, thr, cand)
    # 粗筛只做「明显不是圆」的排除：Hough 的圆心/半径本来就有一两个像素误差，
    # 拿真圆在粗筛阶段卡太严会漏检，真正的判别放在局部精修之后。
    # 粗筛阶段放宽弧覆盖率：Hough 半径偏 2~3px 时，圆周采样会周期性落到线外，
    # 弧覆盖率暂时掉到 0.7 左右；真正的判别放在半径精修之后（g2 >= 0.96）。
    good = ((support >= 0.55) & (free_ratio >= 0.55) & (med_dist <= 3.0)
            & (arc_cov >= 0.65))
    survivors = cand[good]
    diag["circles"]["after_support"] = int(len(survivors))
    if len(survivors) == 0:
        return []

    # 局部精修（批量向量化）：中心 ±2px、半径 ±4px，取支撑率最高的那一组。
    # 半径步长给到 ±4 是因为 Hough 对细线小孔常偏 2~3px（实测 demo 左下孔的
    # 真半径 54、候选 51.6，只搜 ±2 会永远够不到，支撑率卡在 0.65 被误杀）。
    grid = np.array([(dx, dy, dr) for dx in (-2.0, 0.0, 2.0)
                     for dy in (-2.0, 0.0, 2.0) for dr in (-4.0, -2.0, 0.0, 2.0, 4.0)])
    per = len(grid)
    batch = np.repeat(survivors, per, axis=0)
    batch[:, 0] += np.tile(grid[:, 0], len(survivors))
    batch[:, 1] += np.tile(grid[:, 1], len(survivors))
    batch[:, 2] = np.clip(batch[:, 2] + np.tile(grid[:, 2], len(survivors)), r_min, r_max)
    s2, f2, m2, g2 = _sample_support(dt, text_mask, thr, batch)
    # 精修之后真圆的支撑率应接近 1（圆周几乎每点都贴着墨迹），
    # 支撑率 0.85 以下的基本是「几段弧凑出来的假圆」。
    score2 = np.where((s2 >= 0.85) & (f2 >= 0.55) & (g2 >= 0.96) & (m2 <= 1.5),
                      s2 * (0.4 + 0.6 * f2), -1.0)
    results: List[Tuple[float, Circle]] = []
    for c in range(len(survivors)):
        lo, hi = c * per, (c + 1) * per
        seg = score2[lo:hi]
        k = int(np.argmax(seg))
        if seg[k] < 0:
            continue
        b = batch[lo + k]
        results.append((float(seg[k]), Circle(float(b[0]), float(b[1]), float(b[2]))))

    # 去重：同一圆心 ±5px 且半径接近只留一个
    results.sort(key=lambda t: -t[0])
    kept: List[Circle] = []
    for score, c in results:
        if not any(_same_circle(c, k) for k in kept):
            kept.append(c)

    # ---- 轮廓回退：Hough 漏掉被剖面线/尺寸线穿过的圆时，用闭合轮廓的圆度补 ----
    try:
        extra = _contour_circle_fallback(binary, text_mask, stroke, r_min, r_max, kept, diag)
        kept.extend(extra)
    except Exception as exc:  # 回退失败不影响主流程
        diag.setdefault("circles", {})["fallback_error"] = str(exc)
    # 同心圆补漏：齿轮/皮带轮的 2~3 层套圈只靠 Hough 会漏掉其中 1~2 层。
    try:
        radial = _radial_circle_candidates(binary, text_mask, stroke, kept, r_min, r_max, diag)
        kept.extend(radial)
    except Exception as exc:
        diag.setdefault("circles", {})["radial_error"] = str(exc)
    diag.setdefault("circles", {})["kept"] = len(kept)
    return kept


# ---------------------------------------------------------------------------
# 矩形合成
# ---------------------------------------------------------------------------
def find_rects(segments: Sequence[Segment], options, diag: Dict[str, Any]) -> List[Rect]:
    """把四条互相垂直且端点闭合的边合成矩形（options.close_loops）。

    做法：先用「两条水平线 + 两条垂直线刚好围出一个轴对齐框」的几何约束枚举，
    再用角点距离容差确认闭合。表格网格会自然产出单元格矩形，这是期望行为。
    """
    if not getattr(options, "close_loops", True) or len(segments) < 4:
        return []
    long_side = _long_side(diag)
    stroke = float(diag.get("stroke", 2.0))
    tol_ang = float(options.rect_angle_tol_deg)
    # 角点/边贴合容差：合并 + 吸附之后，横边的端点可能比竖边短几个像素
    # （实测剖视图右边差 5px），容差给到 2 倍笔画宽 + 2。
    tol = max(4.5, 2.0 * stroke + 2.0)
    min_edge = max(10.0, 0.018 * long_side)

    arr = _seg_arrays(segments)
    ang = _angle_deg(arr)
    length = np.hypot(arr[:, 2] - arr[:, 0], arr[:, 3] - arr[:, 1])
    horiz = ((ang <= tol_ang) | (ang >= 180.0 - tol_ang)) & (length >= min_edge)
    vert = (np.abs(ang - 90.0) <= tol_ang) & (length >= min_edge)

    hs: List[Tuple[float, float, float]] = []          # (y, x_lo, x_hi)
    for idx in np.nonzero(horiz)[0]:
        hs.append((0.5 * (arr[idx, 1] + arr[idx, 3]),
                   float(min(arr[idx, 0], arr[idx, 2])), float(max(arr[idx, 0], arr[idx, 2]))))
    vs: List[Tuple[float, float, float]] = []          # (x, y_lo, y_hi)
    for idx in np.nonzero(vert)[0]:
        vs.append((0.5 * (arr[idx, 0] + arr[idx, 2]),
                   float(min(arr[idx, 1], arr[idx, 3])), float(max(arr[idx, 1], arr[idx, 3]))))
    if len(hs) < 2 or len(vs) < 2:
        return []
    hs.sort(); vs.sort()
    min_h = max(6.0, 3.0 * stroke)
    min_w = max(10.0, 0.02 * long_side)

    # 枚举方式：先取一对横边，再在「覆盖了该 y 区间」的竖边里取一对作左右边。
    # 注意用「覆盖」而不是「端点相等」：扫描件的横边常比竖边长出几个像素
    # （剖面线终止在边上会把横边拉长），用端点相等会把真实的剖视图矩形判掉。
    rects: List[Rect] = []
    for i in range(len(hs)):
        y_a, xa0, xa1 = hs[i]
        for j in range(i + 1, len(hs)):
            y_b, xb0, xb1 = hs[j]
            if y_b - y_a < min_h:
                continue
            lo = max(xa0, xb0); hi = min(xa1, xb1)
            if hi - lo < min_w:
                continue
            # 只看「两端都盖住 y_a~y_b」的竖边
            cover = [k for k, (_, y0, y1) in enumerate(vs)
                     if y0 <= y_a + tol and y1 >= y_b - tol]
            for p in range(len(cover)):
                xl = vs[cover[p]][0]
                if xl < lo - tol or xl > hi + tol:
                    continue
                for q in range(p + 1, len(cover)):
                    xr = vs[cover[q]][0]
                    if xr - xl < min_w:
                        continue
                    if xr > hi + tol:
                        break
                    rects.append(Rect(float(xl), float(y_a), float(xr - xl), float(y_b - y_a)))

    # 去重：几乎同位置同尺寸的只留一个
    rects.sort(key=lambda r: -r.w * r.h)
    unique: List[Rect] = []
    for r in rects:
        dup = False
        for k in unique:
            if (abs(r.x - k.x) <= 2.5 and abs(r.y - k.y) <= 2.5
                    and abs(r.w - k.w) <= 3.0 and abs(r.h - k.h) <= 3.0):
                dup = True
                break
        if not dup:
            unique.append(r)

    # 网格图纸（标题栏表格）里 5 行 × 4 列会枚举出 C(6,2)×C(5,2)=150 个「闭合回路」，
    # 每一个几何上都成立（四边都是真实墨线），但对 CAD 而言只是单元格的并集。
    # 取舍：只留「最小闭合单元」（内部不含更小矩形）+ 「大面积图元」（>= 图面 5%，
    # 即图框 / 零件外形 / 剖视图外形这类真正的轮廓）。
    image_area = float(diag.get("width", 0)) * float(diag.get("height", 0)) or 1.0
    area_limit = 0.05 * image_area
    kept: List[Rect] = []
    for r in unique:
        has_child = False
        for o in unique:
            if o is r:
                continue
            if (o.x >= r.x - tol and o.y >= r.y - tol
                    and o.x + o.w <= r.x + r.w + tol and o.y + o.h <= r.y + r.h + tol
                    and o.w * o.h < 0.95 * r.w * r.h):
                has_child = True
                break
        if has_child and r.w * r.h < area_limit:
            continue
        kept.append(r)
    diag.setdefault("rects", {}).update({"h": len(hs), "v": len(vs), "raw": len(rects),
                                         "kept": len(kept)})
    return kept


# ---------------------------------------------------------------------------
# 主入口
# ---------------------------------------------------------------------------
def run(clean: np.ndarray, text_mask: Optional[np.ndarray],
        text_boxes, gray: np.ndarray, options, width: int, height: int,
        hough_gray: Optional[np.ndarray] = None
        ) -> Tuple[List[Segment], List[Circle], List[Rect]]:
    """完整矢量化，返回 (segments, circles, rects)。所有坐标为像素坐标。"""
    global LAST_DIAG
    diag: Dict[str, Any] = {
        "width": int(width), "height": int(height),
        "long_side": float(max(int(width), int(height))),
        "text_boxes": len(text_boxes) if text_boxes is not None else 0,
        "clean": clean,
        "stroke": 1.0,
    }
    # 线宽估计（矩形合成的角点容差、圆的支撑半径都依赖它）
    diag["stroke"] = _estimate_stroke(clean)

    import time as _time

    def _tick(label: str, started: float) -> float:
        now = _time.perf_counter()
        diag.setdefault("ms", {})[label] = round((now - started) * 1000.0, 1)
        return now

    t = _time.perf_counter()
    segments = detect_lines(clean, text_mask, options, diag)
    t = _tick("detect_lines", t)
    segments = merge_collinear(segments, options, diag)
    # 合并近共线线段时可能把两段几乎重合的短线插值成 0 长度段（实测小孔周围
    # 每个孔会留下 1~2 条），它们没有几何意义，直接清掉。
    before = len(segments)
    segments = [s for s in segments
                if math.hypot(s.x2 - s.x1, s.y2 - s.y1) >= 1.0]
    diag.setdefault("merge", {})["degenerate_dropped"] = before - len(segments)
    t = _tick("merge_collinear", t)
    segments = snap_segments(segments, options, width, height)
    t = _tick("snap_segments", t)
    circles = detect_circles(gray, text_mask, options, diag, hough_gray=hough_gray)
    t = _tick("detect_circles", t)
    # 圆弧的「弦」在直线检测里必然出现，识别出圆之后要回头把它们从线段里删掉，
    # 否则一个圆会变成 30+ 条假线（干净图误检率的主要来源）。
    segments = drop_circle_chords(segments, circles, options, diag)
    # 合并/吸附/删弦之后可能留下端点完全相同的重复线（实测六角螺母有一条边
    # 被检出两次），先清一次。
    before = len(segments)
    segments = _dedupe_segments(segments)
    diag.setdefault("segments", {})["duplicates_dropped"] = before - len(segments)
    t = _tick("drop_circle_chords", t)
    rects = find_rects(segments, options, diag)
    _tick("find_rects", t)
    # CAD 拓扑整理：角点闭合 -> 端点归并 -> 串链 / 闭环（输出 LWPOLYLINE，见 cadclean.py）
    global LAST_POLYLINES, LAST_CONSUMED
    LAST_POLYLINES, LAST_CONSUMED = cadclean.build_polylines(segments, rects, options, diag)
    # cadclean 会在原地吸附/合并端点，可能把两条原本差 2~3px 的线改成完全相同；
    # 因此拓扑整理后再去一次重，保证输出 DXF 不出现重叠线。
    before = len(segments)
    segments = _dedupe_segments(segments)
    diag["segments"]["duplicates_after_cadclean"] = before - len(segments)
    _tick("cadclean", t)
    diag["counts"] = {"segments": len(segments), "circles": len(circles), "rects": len(rects),
                      "polylines": len(LAST_POLYLINES)}
    LAST_DIAG = diag
    return segments, circles, rects


def _estimate_stroke(clean: np.ndarray) -> float:
    """估计线宽：墨迹面积 / 骨架长度（对 1px 细线与 3px 粗线同时成立）。

    之所以用「面积 / 骨架长度」而不是距离变换分位数：1 像素细线与 3 像素粗线
    同时存在时，dt 分位数会被细线主导（实测 2*p75 在干净图上 2.74、真值 2.47）。
    （不降采样：0.5 倍降采样 + 阈值会把细线打断，实测线宽从 2.47 掉到 1.79。）
    """
    from .imaging import skeletonize

    if clean is None or not clean.size:
        return 1.5
    ink = float(np.count_nonzero(clean))
    if ink <= 0:
        return 1.5
    skel = float(np.count_nonzero(skeletonize(clean)))
    if skel <= 0:
        return 1.5
    return float(np.clip(ink / skel, 1.0, 8.0))

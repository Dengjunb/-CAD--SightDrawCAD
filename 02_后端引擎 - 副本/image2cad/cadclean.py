# -*- coding: utf-8 -*-
"""
cadclean.py
===========
「线段汤」→ CAD 拓扑整理：把零散线段接成连续链 / 闭合轮廓，输出可直接进 CAD 的
LWPOLYLINE（闭合或开放），而不是一堆互不相连的 LINE。

做三件事（按顺序）：
    1. 角点闭合（close_corners）：两条线端点靠近且夹角明显时，把端点移到两线的交点，
       让拐角真正「焊死」，而不是差几个像素的缺口。
    2. 端点归并（weld_endpoints）：把容差内的端点聚成一个节点，消除重复点。
    3. 链路追踪（trace_chains）：按节点度数把线段串成链；回到起点的链输出闭合轮廓。

坐标约定与 vectorize / models 一致：像素坐标，x 向右、y 向下。输出仍为像素坐标，
换算到毫米由 dxf_writer 统一完成。
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Set, Tuple

from .models import Rect, Segment

Point = Tuple[float, float]


@dataclass
class Polyline:
    """CAD 多段线（像素坐标）。closed=True 表示闭合轮廓。"""
    pts: List[Point]
    closed: bool = False
    source: str = "chain"

    def to_dict(self) -> Dict:
        return {"pts": [[round(x, 2), round(y, 2)] for x, y in self.pts],
                "closed": bool(self.closed), "source": self.source}

    def length_px(self) -> float:
        if len(self.pts) < 2:
            return 0.0
        s = 0.0
        for i in range(len(self.pts) - 1):
            s += math.hypot(self.pts[i + 1][0] - self.pts[i][0], self.pts[i + 1][1] - self.pts[i][1])
        if self.closed:
            s += math.hypot(self.pts[0][0] - self.pts[-1][0], self.pts[0][1] - self.pts[-1][1])
        return s

    def area_px(self) -> float:
        if len(self.pts) < 3:
            return 0.0
        s = 0.0
        n = len(self.pts)
        for i in range(n):
            x1, y1 = self.pts[i]
            x2, y2 = self.pts[(i + 1) % n]
            s += x1 * y2 - x2 * y1
        return abs(s) * 0.5


# ---------------------------------------------------------------------------
# 1) 角点闭合
# ---------------------------------------------------------------------------
def _line_intersection(a1: Point, a2: Point, b1: Point, b2: Point) -> Optional[Point]:
    d1 = (a2[0] - a1[0], a2[1] - a1[1])
    d2 = (b2[0] - b1[0], b2[1] - b1[1])
    den = d1[0] * d2[1] - d1[1] * d2[0]
    if abs(den) < 1e-9:
        return None
    t = ((b1[0] - a1[0]) * d2[1] - (b1[1] - a1[1]) * d2[0]) / den
    return (a1[0] + t * d1[0], a1[1] + t * d1[1])


def close_corners(segments: Sequence[Segment], tol_px: float,
                  min_angle_deg: float = 20.0) -> int:
    """把「端点靠近但没接上」的拐角移到两线交点。原地修改 Segment。返回闭合个数。"""
    n = len(segments)
    if n < 2:
        return 0
    ends = []  # (segment_index, which) which: 0=起点 1=终点
    for i, s in enumerate(segments):
        ends.append((i, 0))
        ends.append((i, 1))
    closed = 0

    def get(segi: int, which: int) -> Point:
        s = segments[segi]
        return (s.x1, s.y1) if which == 0 else (s.x2, s.y2)

    def setp(segi: int, which: int, p: Point) -> None:
        s = segments[segi]
        if which == 0:
            s.x1, s.y1 = p
        else:
            s.x2, s.y2 = p

    for ii in range(len(ends)):
        i, wi = ends[ii]
        for jj in range(ii + 1, len(ends)):
            j, wj = ends[jj]
            if i == j:
                continue
            pi, pj = get(i, wi), get(j, wj)
            d = math.hypot(pi[0] - pj[0], pi[1] - pj[1])
            if d > tol_px:
                continue
            si, sj = segments[i], segments[j]
            ai = math.atan2(si.y2 - si.y1, si.x2 - si.x1)
            aj = math.atan2(sj.y2 - sj.y1, sj.x2 - sj.x1)
            dang = abs(math.degrees(ai - aj)) % 180.0
            if dang < min_angle_deg or dang > 180.0 - min_angle_deg:
                continue  # 近似平行，不做角点闭合
            ip = _line_intersection((si.x1, si.y1), (si.x2, si.y2),
                                    (sj.x1, sj.y1), (sj.x2, sj.y2))
            if ip is None:
                continue
            if math.hypot(ip[0] - pi[0], ip[1] - pi[1]) > tol_px:
                continue
            setp(i, wi, ip)
            setp(j, wj, ip)
            closed += 1
    return closed


# ---------------------------------------------------------------------------
# 2) 端点归并
# ---------------------------------------------------------------------------
def weld_endpoints(segments: Sequence[Segment], tol_px: float) -> Tuple[List[Point], List[Tuple[int, int]]]:
    """把容差内的端点聚成节点。返回 (节点坐标, 每条线段的两端节点号)。"""
    pts: List[Point] = []
    for s in segments:
        pts.append((s.x1, s.y1))
        pts.append((s.x2, s.y2))

    cell = max(tol_px, 1e-6)
    grid: Dict[Tuple[int, int], List[int]] = {}
    node_of: List[int] = []
    centers: List[Point] = []
    for idx, p in enumerate(pts):
        key = (int(round(p[0] / cell)), int(round(p[1] / cell)))
        found = -1
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for cand in grid.get((key[0] + dx, key[1] + dy), ()):  # noqa: E501
                    c = centers[cand]
                    if math.hypot(p[0] - c[0], p[1] - c[1]) <= tol_px:
                        found = cand
                        break
                if found >= 0:
                    break
            if found >= 0:
                break
        if found < 0:
            found = len(centers)
            centers.append(p)
            grid.setdefault(key, []).append(found)
        node_of.append(found)

    edges: List[Tuple[int, int]] = []
    for i in range(len(segments)):
        edges.append((node_of[2 * i], node_of[2 * i + 1]))
    return centers, edges


# ---------------------------------------------------------------------------
# 3) 链路追踪
# ---------------------------------------------------------------------------
def _simplify(pts: List[Point], closed: bool, tol_deg: float = 1.5) -> List[Point]:
    """去掉共线与重复点（角点保留）。"""
    if len(pts) <= 2:
        return pts
    out: List[Point] = [pts[0]]
    for i in range(1, len(pts) - 1):
        ax, ay = out[-1]
        bx, by = pts[i]
        cx, cy = pts[i + 1]
        v1 = (bx - ax, by - ay)
        v2 = (cx - bx, cy - by)
        l1 = math.hypot(*v1)
        l2 = math.hypot(*v2)
        if l1 < 1e-6 or l2 < 1e-6:
            continue
        cosang = (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2)
        cosang = max(-1.0, min(1.0, cosang))
        ang = math.degrees(math.acos(cosang))
        if ang > tol_deg:
            out.append((bx, by))
    out.append(pts[-1])
    if closed and len(out) > 2:
        # 闭合时最后一个点与第一个点重合，去掉重复
        if math.hypot(out[-1][0] - out[0][0], out[-1][1] - out[0][1]) < 1e-6:
            out.pop()
    return out


def trace_chains(nodes: List[Point], edges: List[Tuple[int, int]],
                 segments: Sequence[Segment], min_len_px: float
                 ) -> Tuple[List[Polyline], Set[int]]:
    """按节点度数把边串成链 / 闭合环。返回 (多段线, 被消耗的线段下标)。"""
    adj: Dict[int, List[Tuple[int, int]]] = {}
    for ei, (a, b) in enumerate(edges):
        adj.setdefault(a, []).append((ei, b))
        adj.setdefault(b, []).append((ei, a))

    used = [False] * len(edges)
    polys: List[Polyline] = []
    consumed: Set[int] = set()

    def walk(start_node: int, first_edge: int) -> Tuple[List[int], List[int]]:
        """沿边前进，返回 (节点序列, 边序列)。"""
        seq_nodes = [start_node]
        seq_edges = []
        cur_edge = first_edge
        cur_node = start_node
        while cur_edge >= 0 and not used[cur_edge]:
            used[cur_edge] = True
            seq_edges.append(cur_edge)
            a, b = edges[cur_edge]
            nxt = b if a == cur_node else a
            seq_nodes.append(nxt)
            cur_node = nxt
            # 只沿度数为 2 的节点继续
            if len(adj.get(cur_node, [])) != 2:
                break
            nxt_edges = [e for e, _ in adj[cur_node] if not used[e]]
            if not nxt_edges:
                break
            cur_edge = nxt_edges[0]
        return seq_nodes, seq_edges

    for ei in range(len(edges)):
        if used[ei]:
            continue
        a, b = edges[ei]
        # 从 a 出发正向走
        n1, e1 = walk(a, ei)
        # 反向：从 a 沿未用边继续（如果 a 度数 2）
        cur_edge = -1
        if len(adj.get(a, [])) == 2:
            left = [e for e, _ in adj[a] if not used[e]]
            if left:
                cur_edge = left[0]
        if cur_edge >= 0:
            n0, e0 = walk(a, cur_edge)
            # e0 从 a 出发，反向拼到前面
            seq_nodes = list(reversed(n0)) + n1[1:]
            seq_edges = list(reversed(e0)) + e1
        else:
            seq_nodes, seq_edges = n1, e1

        closed = seq_nodes[0] == seq_nodes[-1] and len(seq_edges) >= 3
        pts = [nodes[k] for k in seq_nodes]
        pts = _simplify(pts, closed)
        if len(pts) < 2:
            continue
        poly = Polyline(pts=pts, closed=closed)
        if poly.length_px() < min_len_px:
            continue
        if closed and poly.area_px() < (min_len_px * min_len_px * 0.02):
            continue
        # 只有多段链才值得变成 LWPOLYLINE；单段保留 LINE 更贴近 CAD 习惯
        if len(seq_edges) < 2 and not closed:
            continue
        poly.source = "loop" if closed else "chain"
        polys.append(poly)
        consumed.update(seq_edges)
    return polys, consumed


# ---------------------------------------------------------------------------
# 对外入口
# ---------------------------------------------------------------------------
def build_polylines(segments: List[Segment], rects: Sequence[Rect], options,
                    diag: Optional[Dict] = None) -> Tuple[List[Polyline], Set[int]]:
    """线段 -> 多段线/闭合轮廓。rects 用于去重（矩形已经单独成实体）。"""
    if not segments:
        return [], set()
    stroke = float(diag.get("stroke", 1.5)) if diag else 1.5
    long_side = float(diag.get("long_side", 1000)) if diag else 1000.0

    corner_tol = max(6.0, stroke * 4.0)
    weld_tol = max(3.0, stroke * 2.0)
    min_len = max(12.0, long_side * 0.012)

    closed_n = close_corners(segments, corner_tol)
    nodes, edges = weld_endpoints(segments, weld_tol)
    polys, consumed = trace_chains(nodes, edges, segments, min_len)

    # 去掉与 Rect 重复的闭合轮廓
    kept: List[Polyline] = []
    for p in polys:
        if p.closed and rects:
            xs = [q[0] for q in p.pts]
            ys = [q[1] for q in p.pts]
            bx0, bx1 = min(xs), max(xs)
            by0, by1 = min(ys), max(ys)
            dup = False
            for r in rects:
                if (abs(bx0 - r.x) < 3 and abs(by0 - r.y) < 3
                        and abs(bx1 - (r.x + r.w)) < 3 and abs(by1 - (r.y + r.h)) < 3):
                    dup = True
                    break
            if dup:
                continue
        kept.append(p)

    if diag is not None:
        diag["cad"] = {
            "corners_closed": closed_n,
            "chains": sum(1 for p in kept if not p.closed),
            "loops": sum(1 for p in kept if p.closed),
            "consumed_segments": len(consumed),
        }
    return kept, consumed

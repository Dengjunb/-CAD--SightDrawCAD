# -*- coding: utf-8 -*-
"""
matcher.py
==========
字段-字段值智能配对模块（核心任务二）。

职责：
    1) 从识别模块的候选集中定位"标题栏（图框）区域"，排除视图尺寸/注释噪声；
    2) 用**自适应距离阈值**把字段标签与其值配对，支持：
       - 多方向配对（值在标签右侧 / 正下方 / 左下方 / 右下方 / 正上方）；
       - 多行/多列文本合并（同一标签对应的多行或多列值合并为完整字符串）；
       - 结合 位置 + 格式 + 语义 综合打分；
    3) 对无法配对的内容打上"未命名字段 / 空值"标记。

关键算法/原理（v1.1 重构）：
    * 标题栏定位（TitleBlockLocator）：锚点密度聚类 + 半径膨胀，取强标签最密集处
      的包围盒作为标题栏原点；标签簇边界会按字高向外扩一圈，使"标签在上、值在下"
      的图框也能把值纳入扫描范围。
    * 全局贪心指派（Pairer）：先按 y 聚成行（行容差取中位字高的 0.7 倍），
      再为每个强标签生成"候选值-方向分"，最后**按分数从高到低全局指派**，
      而不是每个标签各自抢最优值。这样多个标签竞争同一个值时不会出现
      "前一个标签把后面所有值都吃掉"的串位错配。
    * 值候选不再依赖 label/value 的硬分类：只要"标签强信号分 < 2"的文字都可以
      作为值（含中文人名/零件名这类被弱判为标签的文本），从根本上修复
      "零件名称 <- SKD11" 式的整行错位。
    * 逐次配对（不复用同名标签）：同名标签在不同标题栏各自配对，解决
      "单图纸多模号 / 重复标题栏"只配第一个的问题。
    * 覆盖率兜底：所有强标签都产出一项（无值则标空值）；标题栏附近未被使用的
      值补为 Unmatched_label，保证识别内容全部进入块参照。
"""

from __future__ import annotations

import bisect
import math
import re
import statistics
from collections import deque
from typing import Dict, List, Optional, Tuple

from .models import TextElement, FieldCandidate, FieldPair, Point


# ---------------------------------------------------------------------------
# 实现要点（v1.1）
#   1. "行"是配对的骨架：同行右侧优先，其次正下方同列，再考虑斜向与上方；
#   2. 候选边一次性生成后按分数全局指派，避免逐标签贪心造成整行串位；
#   3. 候选值池不按 label/value 硬过滤：只要标签信号分 < 2 就可以当值，
#      从而让"上模仁 / 张三"这类中文值仍能正常配对；
#   4. 同名标签逐次配对（不复用），以支持重复标题栏与单图纸多模号；
#   5. 标题栏附近未被使用的值兜底为 Unmatched_label，保证内容全纳入块参照。
# ---------------------------------------------------------------------------
class TitleBlockLocator:
    """
    标题栏（图框）区域定位器。

    用锚点密度聚类 + 半径膨胀找出标题栏，并给出左下角原点（块参照插入点）。
    """

    # 锚点聚类的归一化距离阈值（在 sx=sy=_cluster_radius 尺度下）
    _CLUSTER_THRESHOLD = 2.2

    @staticmethod
    def _typical_height(elements: List[TextElement]) -> float:
        """文字高度中位数（自适应缩放基准）。"""
        hts = [max(e.height, 1e-3) for e in elements]
        return statistics.median(hts) if hts else 2.5

    @staticmethod
    def _cluster_radius(elements: List[TextElement]) -> float:
        """
        估算锚点聚类半径（约为中位字高的 14 倍）。

        原理：标题栏标签横向跨数百、纵向跨数十个单位，14 倍字高 + 2.2 阈值
        足以连通同一标题栏的标签簇，又不把相距数千单位的两个标题栏并到一起。
        """
        return max(TitleBlockLocator._typical_height(elements) * 14.0, 1e-3)

    @staticmethod
    def _norm_dist(a, b, sx, sy) -> float:
        """在 x/y 方向分别用伸缩系数归一后的欧氏距离。"""
        return math.hypot((b.x - a.x) / sx, (b.y - a.y) / sy)

    # ----------------------------------------------------------------------
    def locate(self, candidates: List[FieldCandidate], elements: List[TextElement]) \
            -> Optional[Tuple[float, float, float, float]]:
        """
        返回标题栏标签簇包围盒 (xmin, ymin, xmax, ymax)；找不到返回 None。

        步骤：
            1) 强标签不足则返回 None；
            2) 以邻居数最多的标签为锚点（标题栏标签最集中）；
            3) 从锚点膨胀：反复加入距离阈值内的标签，直至稳定；
            4) 返回该簇包围盒（按字高向外扩一圈，容纳紧邻的值）。
        """
        labels = [c for c in candidates if c.label_score >= 2]
        if len(labels) < 2:
            return None
        r = self._cluster_radius([c.element for c in labels])
        sx = sy = r
        pts = [c.element for c in labels]
        n = len(pts)

        # 网格索引：以 r 为单元格大小，把每个标签放入 (ix,iy) 网格。
        # 这样"找邻居"只需查当前格及其周围若干层格，整体由 O(N^2) 降到 O(N)。
        cell = r
        grid: Dict[Tuple[int, int], List[int]] = {}
        for i, e in enumerate(pts):
            grid.setdefault((int(e.x // cell), int(e.y // cell)), []).append(i)

        # 邻居层数 = 归一化阈值取整 + 1，保证能覆盖阈值内的所有可能邻居
        layers = int(math.ceil(self._CLUSTER_THRESHOLD)) + 1

        def neighbors_of(i: int) -> List[int]:
            # collect other labels within the normalized-distance threshold
            e = pts[i]
            ix, iy = int(e.x // cell), int(e.y // cell)
            out = []
            for gx in range(ix - layers, ix + layers + 1):
                for gy in range(iy - layers, iy + layers + 1):
                    for j in grid.get((gx, gy), ()):
                        if j != i and self._norm_dist(pts[i], pts[j], sx, sy) <= self._CLUSTER_THRESHOLD:
                            out.append(j)
            return out

        # 种子：网格邻居最多的标签（标题栏标签最集中）
        seed = max(range(n), key=lambda i: len(neighbors_of(i)))

        # 膨胀：BFS，从种子出发反复加入邻近标签直至稳定
        cluster: set = {seed}
        queue = deque([seed])
        while queue:
            i = queue.popleft()
            for j in neighbors_of(i):
                if j not in cluster:
                    cluster.add(j)
                    queue.append(j)

        chosen = [pts[i] for i in cluster]
        if not chosen:
            return None
        h_med = self._typical_height(chosen)
        margin = 2.0 * h_med  # 标签簇外扩一圈，紧贴标签下方的值不再被边界切掉
        xs = [e.x for e in chosen]
        ys = [e.y for e in chosen]
        return (min(xs) - margin, min(ys) - margin,
                max(xs) + margin * 4, max(ys) + margin)


# ---------------------------------------------------------------------------
# 标签 -> 期望值语义（用于配对加分；不是匹配所必需的固定列表）
# ---------------------------------------------------------------------------
def expected_value_type(label_norm: str) -> Optional[str]:
    """根据标签名推断期望的"值语义"；无法推断返回 None。"""
    if not label_norm:
        return None
    t = label_norm
    up = t.upper()
    for kw in ("公差", "偏差"):
        if kw in t:
            return "tolerance"
    for kw in ("比例",):
        if kw in t:
            return "ratio"
    if "SCALE" in up:
        return "ratio"
    for kw in ("日期", "年月"):
        if kw in t:
            return "date"
    if re.search(r"(?<![A-Z])DATE(?![A-Z])", up):
        return "date"
    for kw in ("重量", "质量"):
        if kw in t:
            return "weight"
    if re.search(r"(?<![A-Z])(WT|WEIGHT|MASS)(?![A-Z])", up):
        return "weight"
    for kw in ("数量", "件数"):
        if kw in t:
            return "count"
    if re.search(r"(?<![A-Z])(QTY|QUANTITY)(?![A-Z])", up):
        return "count"
    for kw in ("材料", "材质"):
        if kw in t:
            return "material"
    if re.search(r"(?<![A-Z])(MATL|MATERIAL|MAT)(?![A-Z])", up):
        return "material"
    for kw in ("编号", "图号", "代号", "零件", "图档"):
        if kw in t:
            return "part_no"
    if re.search(r"(?<![A-Z])(PART|DWG|NO|NUMBER)(?![A-Z])", up):
        return "part_no"
    for kw in ("硬度",):
        if kw in t:
            return "hardness"
    if re.search(r"(HRC|HRA|HARDNESS)", up):
        return "hardness"
    for kw in ("粗糙度", "表面", "表面处理"):
        if kw in t:
            return "surface"
    if re.search(r"(?<![A-Z])(SURFACE|ROUGHNESS|FINISH|TREATMENT)(?![A-Z])", up):
        return "surface"
    return None


# 值语义判定辅助正则
_TOL_RE = re.compile(r"^[+-]?\d+(\.\d+)?[=＝][+-]?\d+(\.\d+)?")
_TOL2_RE = re.compile(r"^[±%%][Pp]?\s*\d")
_MATERIAL_RE = re.compile(r"^[A-Za-z]{1,8}\d{1,4}[A-Za-z0-9#\-./]*$|^45#|^\d+#")
_DATE_RE = re.compile(r"^\d{4}[-/\.]\d{1,2}[-/\.]\d{1,2}$|^\d{1,2}[-/\.]\d{1,2}[-/\.]\d{2,4}$")
_RATIO_RE = re.compile(r"^\d+\s*[:：]\s*\d+(\.\d+)?$")
_COUNT_RE = re.compile(r"^\d+$")
_HARDNESS_RE = re.compile(r"^(HRC|HRA|HRB)\d", re.IGNORECASE)
_PARTNO_RE = re.compile(r"^[A-Za-z]{1,8}[\d-]{2,}[A-Za-z0-9_/.-]*$")


def value_semantic(text: str) -> Optional[str]:
    """判断一个值文本的语义类别。"""
    if not text:
        return None
    t = text.strip()
    if _RATIO_RE.search(t):
        return "ratio"
    if _TOL_RE.search(t) or _TOL2_RE.match(t):
        return "tolerance"
    if _HARDNESS_RE.search(t):
        return "hardness"
    if re.match(r"^Ra\s?\d", t, re.IGNORECASE) or re.match(r"^Rz\s?\d", t, re.IGNORECASE):
        return "surface"
    if re.match(r"^IT\d+$", t, re.IGNORECASE):
        return "tolerance"
    if _DATE_RE.search(t):
        return "date"
    if _PARTNO_RE.search(t):
        return "part_no"
    if _MATERIAL_RE.search(t):
        return "material"
    if _COUNT_RE.fullmatch(t):
        return "count"
    return None


# ---------------------------------------------------------------------------
class _Row:
    """
    一行文字（按 y 聚类），行内按 x 升序；附带行中心 y。

    行中心用该行文字 y 坐标的中位数动态更新，使同一行内字高/基线略有差异
    的文字（例如标签 8.5 高、值 6.2 高）仍能稳定归入同一行。
    """

    __slots__ = ("y", "items", "ys")

    def __init__(self, y: float) -> None:
        self.y = y
        self.items: List[FieldCandidate] = []
        self.ys: List[float] = []

    def add(self, c: FieldCandidate) -> None:
        self.items.append(c)
        self.ys.append(c.element.y)
        self.y = statistics.median(self.ys)


# ---------------------------------------------------------------------------
class Pairer:
    """
    字段-字段值配对器（行感知 + 全局贪心指派）。
    """

    def __init__(self, row_tol_ratio: float = 0.7,
                 max_dx_factor: float = 30.0,
                 max_dy_factor: float = 9.0,
                 semantic_bonus: float = 0.30):
        self.row_tol_ratio = row_tol_ratio     # 行容差 / 中位字高
        self.max_dx_factor = max_dx_factor     # 水平搜索半径 / 中位字高
        self.max_dy_factor = max_dy_factor     # 垂直搜索半径 / 中位字高
        self.semantic_bonus = semantic_bonus   # 语义匹配加分

    # ------------------------------------------------------------------
    @staticmethod
    def _rows_linear(cands: List[FieldCandidate], tol: float) -> List[_Row]:
        """
        线性聚行：按 y 降序扫描，与上一行中心相差 <= tol 则归入该行。

        复杂度 O(N·行数)，但行数远小于文字数，且排序只在入口做一次；
        相比"逐行比较全部元素"的写法，万级文字图纸上更稳定。
        """
        rows: List[_Row] = []
        for c in sorted(cands, key=lambda c: -c.element.y):
            y = c.element.y
            if rows and abs(y - rows[-1].y) <= tol:
                rows[-1].add(c)
            else:
                row = _Row(y)
                row.add(c)
                rows.append(row)
        for row in rows:
            row.items.sort(key=lambda c: c.element.x)
        return rows

    # ------------------------------------------------------------------
    @staticmethod
    def _direction_score(dx: float, dy: float, h: float, row_tol: float) -> Optional[float]:
        """
        计算候选值相对标签的方向与归一化得分。

        规则（方向优先级决定配对合理性）：
            - 同行右侧（|dy| <= row_tol 且 dx >= 0）：最高；
            - 正下方同列（|dx| 很小且 dy < 0）：次高；
            - 下方斜向（可接受）；正上方同列（部分图框值在上方）；其它斜向最低。
        返回 None 表示距离过远、方向不可接受。
        """
        h = max(h, 1e-6)
        if abs(dy) <= row_tol and dx >= 0:
            return 1.0 / (1.0 + dx / (8.0 * h))
        if abs(dx) <= 1.0 * h and dy < 0:
            return 0.85 / (1.0 + (-dy) / (4.0 * h))
        if dy < 0 and abs(dx) <= 6.0 * h:
            return 0.55 / (1.0 + math.hypot(dx, dy) / (6.0 * h))
        if abs(dx) <= 1.0 * h and dy > 0:
            return 0.45 / (1.0 + dy / (4.0 * h))
        if dy > 0 and abs(dx) <= 3.0 * h:
            return 0.30 / (1.0 + math.hypot(dx, dy) / (6.0 * h))
        return None

    # ------------------------------------------------------------------
    def pair(self, candidates: List[FieldCandidate],
             region: Tuple[float, float, float, float]) -> Tuple[List[FieldPair],
                                                                 List[FieldPair]]:
        """
        执行配对。返回 (成功配对的 pairs, 未配对项 unmatched)。

        参数:
            candidates : 识别后的候选集（全图，不局限于 region）
            region     : 标题栏标签簇包围盒（用于兜底与原点）
        """
        if not candidates:
            return [], []

        heights = [max(c.element.height, 1e-3) for c in candidates]
        h_med = statistics.median(heights) if heights else 2.5
        row_tol = h_med * self.row_tol_ratio
        rows = self._rows_linear(candidates, row_tol)
        row_of = {}
        for ri, row in enumerate(rows):
            for c in row.items:
                row_of[id(c)] = ri

        # 强标签 = 配对锚点；其余（含弱标签/中文值/纯值）都可以作为候选取值。
        # 这是与 v1.0 的关键差别：不再要求文字"被判定为值"才能当值。
        labels = [c for c in candidates if c.label_score >= 2 and c.element.text.strip()]
        value_pool = [c for c in candidates
                      if c.label_score < 2 and c.element.text.strip()]

        max_dx = self.max_dx_factor * h_med
        max_dy = self.max_dy_factor * h_med
        rows_y = [r.y for r in rows]  # 行按 y 降序

        # ---- 1) 生成候选边（标签 -> 值） ----
        edges: List[Tuple[float, int, int]] = []
        lab_index = {id(c): i for i, c in enumerate(labels)}
        val_index = {id(c): i for i, c in enumerate(value_pool)}
        # 值按行分桶，配对时只扫标签邻近的若干行，避免全图两两比较
        val_by_row: Dict[int, List[FieldCandidate]] = {}
        for v in value_pool:
            val_by_row.setdefault(row_of[id(v)], []).append(v)

        for lab in labels:
            le = lab.element
            expected = expected_value_type(lab.normalized)
            ri = row_of[id(lab)]
            # 只在 y 方向 ±max_dy 的行内找（行按 y 降序，向前/向后都扫）
            lo = bisect.bisect_left([-y for y in rows_y], -(le.y + max_dy))
            hi = bisect.bisect_right([-y for y in rows_y], -(le.y - max_dy))
            for rj in range(lo, hi):
                for v in val_by_row.get(rj, ()):
                    ve = v.element
                    dx = ve.x - le.x
                    dy = ve.y - le.y
                    if abs(dx) > max_dx:
                        continue
                    base = self._direction_score(dx, dy, h_med, row_tol)
                    if base is None:
                        continue
                    bonus = 0.0
                    if expected:
                        vs = value_semantic(ve.text)
                        if vs == expected:
                            bonus = self.semantic_bonus
                    if v.kind == "value":
                        bonus += 0.05
                    edges.append((base + bonus, lab_index[id(lab)], val_index[id(v)]))

        # ---- 2) 全局贪心指派（分数从高到低，双方都空闲才成立） ----
        # 例：多个标签都邻近同一个值时，分数最高的标签先占用，其余标签转而
        # 寻找次优值；这比"每个标签各自取最近值"更能避免连锁错配。
        edges.sort(key=lambda e: -e[0])
        used_val: set = set()
        chosen_for: Dict[int, int] = {}
        score_for: Dict[int, float] = {}
        for score, li, vi in edges:
            if li in chosen_for or vi in used_val:
                continue
            chosen_for[li] = vi
            score_for[li] = score
            used_val.add(vi)

        # ---- 3) 弱标签兜底配对（未命中词表但明显是"标签 + 右侧值"的短中文） ----
        # 放在强标签之后，避免抢走强标签的值；只接受同一行近距离右侧/正下方。
        weak_labels = [c for c in candidates
                       if c.label_score == 1 and c.element.text.strip()
                       and len(c.normalized) >= 2 and id(c) not in lab_index]
        for lab in sorted(weak_labels, key=lambda c: -c.element.y):
            if any(id(c) == id(lab) for c in labels):
                continue
            le = lab.element
            best = None
            best_score = 0.0
            for vi, v in enumerate(value_pool):
                if vi in used_val:
                    continue
                ve = v.element
                dx, dy = ve.x - le.x, ve.y - le.y
                if abs(dy) <= row_tol and 0 <= dx <= 4.0 * h_med:
                    s = 0.9 / (1.0 + dx / (4.0 * h_med))
                elif abs(dx) <= 1.0 * h_med and dy < 0 and (-dy) <= 4.0 * h_med:
                    s = 0.65 / (1.0 + (-dy) / (4.0 * h_med))
                else:
                    continue
                if s > best_score:
                    best_score, best = s, vi
            if best is not None:
                used_val.add(best)
                # 用 (WeakLabel, vi) 记录，稍后与强标签一起产出
                weak_pairs = getattr(self, "_weak_pairs", None)
                if weak_pairs is None:
                    weak_pairs = []
                    self._weak_pairs = weak_pairs
                weak_pairs.append((lab, best, best_score))

        # ---- 4) 产出 FieldPair（逐次配对，不复用同名标签） ----
        # 注意：labels 可能有重名（多联图框），此处的产出顺序按位置排序，
        # 每个 occurrence 都保留，属性 Tag 的唯一化交给 block_builder 处理。
        pairs: List[FieldPair] = []
        produced_labels: Dict[int, bool] = {}

        def emit(lab: FieldCandidate, val: Optional[FieldCandidate], score: float,
                 expected: Optional[str]) -> None:
            le = lab.element
            if val is None:
                pairs.append(FieldPair(
                    label=lab.normalized, label_raw=le.text, value="",
                    confidence=0.0,
                    label_position=Point(le.x, le.y), unmatched_value=True,
                ))
                return
            merged, extra = self._merge_for_label(val, lab, value_pool, used_val,
                                                  h_med, row_tol, expected)
            used_val.update(extra)
            pairs.append(FieldPair(
                label=lab.normalized, label_raw=le.text, value=merged,
                value_raw=merged,
                confidence=min(1.0, round(score, 4)),
                label_position=Point(le.x, le.y),
                value_position=Point(val.element.x, val.element.y),
            ))

        for lab in sorted(labels, key=lambda c: (-c.element.y, c.element.x)):
            li = lab_index[id(lab)]
            vi = chosen_for.get(li)
            val = value_pool[vi] if vi is not None else None
            emit(lab, val, score_for.get(li, 0.0), expected_value_type(lab.normalized))
            produced_labels[id(lab)] = True

        # 弱标签对（若其值未被强标签用掉）
        for lab, vi, score in getattr(self, "_weak_pairs", []):
            if vi in used_val:
                continue
            self._weak_pairs = []
            emit(lab, value_pool[vi], score, expected_value_type(lab.normalized))
            used_val.add(vi)
            produced_labels[id(lab)] = True
        self._weak_pairs = []

        # ---- 5) 未被使用的值 -> 未命名字段（仅标题栏附近，避免把尺寸标注全搬进来） ----
        # 判定"附近"用标签网格做粗筛，再以 sweep_dx 做精确距离判断；
        # 这样既满足"全部识别内容纳入块参照"，又不会把视图尺寸文字搬进块属性。
        unmatched: List[FieldPair] = []
        xmin, ymin, xmax, ymax = region
        sweep_dx = max(30.0 * h_med, (xmax - xmin) * 0.5)
        sweep_dy = max(10.0 * h_med, (ymax - ymin) * 0.5)
        # 标签网格：用于判断"这个值是否紧挨某个强标签"
        lab_cell = max(10.0 * h_med, 1.0)
        lab_grid: Dict[Tuple[int, int], List[TextElement]] = {}
        for lab in labels:
            le = lab.element
            lab_grid.setdefault((int(le.x // lab_cell), int(le.y // lab_cell)), []).append(le)

        def near_label(ve: TextElement) -> bool:
            gx, gy = int(ve.x // lab_cell), int(ve.y // lab_cell)
            for ax in (gx - 1, gx, gx + 1):
                for ay in (gy - 1, gy, gy + 1):
                    for le in lab_grid.get((ax, ay), ()):
                        if math.hypot(ve.x - le.x, ve.y - le.y) <= sweep_dx:
                            return True
            return False

        for vi, v in enumerate(value_pool):
            if vi in used_val:
                continue
            ve = v.element
            inside = (xmin - sweep_dx <= ve.x <= xmax + sweep_dx
                      and ymin - sweep_dy <= ve.y <= ymax + sweep_dy)
            if not (inside or near_label(ve)):
                continue
            unmatched.append(FieldPair(
                label="Unmatched_label", label_raw="Unmatched_label",
                value=ve.text, value_raw=ve.text, confidence=0.0,
                value_position=Point(ve.x, ve.y), unmatched_label=True,
            ))

        return pairs, unmatched

    # ------------------------------------------------------------------
    def _merge_for_label(self, chosen: FieldCandidate, label_cand: FieldCandidate,
                         values: List[FieldCandidate], used_values: set,
                         h: float, row_tol: float, expected: Optional[str]) \
            -> Tuple[str, List[int]]:
        """
        对一个已选值做进一步合并，返回 (合并后的值, 需要标记为已用的值下标)。

        规则：
            - 公差类标签：把标签同行右侧所有公差值整体并入（表格式公差串）；
            - 值位于标签正下方时：把同一列下方的连续多行值并入（多行字段）。
        """
        le = label_cand.element
        parts = [chosen.element.text]
        consumed: List[int] = []

        # --- 情况1：公差列合并（标签右邻的所有公差值） ---
        if expected == "tolerance":
            for vi, v in enumerate(values):
                if id(v) == id(chosen) or vi in used_values:
                    continue
                ve = v.element
                if abs(ve.y - le.y) <= row_tol and ve.x >= le.x and \
                        (value_semantic(ve.text) == "tolerance" or _TOL2_RE.match(ve.text)):
                    parts.append(ve.text)
                    consumed.append(vi)
            return " ".join(dict.fromkeys(parts)), consumed

        # --- 情况2：正下方同列多行合并 ---
        cx, cy = chosen.element.x, chosen.element.y
        if abs(cx - le.x) <= 1.2 * h and cy < le.y:
            h_th = 0.8 * h
            v_th = 8.0 * h
            guard = 0
            while guard < 12:
                guard += 1
                next_cand, next_y, next_vi = None, float("inf"), None
                for vi, v in enumerate(values):
                    if vi in used_values:
                        continue
                    ve = v.element
                    if ve.y < cy - 1e-9 and abs(ve.x - cx) <= h_th \
                            and (cy - ve.y) <= max(v_th, 1.3 * ve.height):
                        if ve.y > next_y:
                            next_cand, next_y, next_vi = v, ve.y, vi
                if next_cand is None:
                    break
                consumed.append(next_vi)
                parts.append(next_cand.element.text)
                cx, cy = next_cand.element.x, next_cand.element.y
        return " / ".join(parts), consumed
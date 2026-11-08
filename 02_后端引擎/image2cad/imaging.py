# -*- coding: utf-8 -*-
"""
imaging.py
==========
「看图成图」预处理链：读图 → 去噪 → 纠偏 → 二值化 → 去噪点 → 文字区保护 → 骨架。

设计要点（为什么这么写）：
    * 墨迹为前景：本模块所有二值图约定 255 = 墨迹（线/字）、0 = 背景。
      下游的 Hough / 连通域 / 形态学都按「非零即前景」处理，避免每处再取反一次。
    * 中文路径：Windows 下 cv2.imread 不能处理非 ASCII 路径，
      因此统一走 np.fromfile + cv2.imdecode。
    * 文字区必须先于直线提取被掩掉：文字笔画（尤其汉字）在 Hough 眼里是
      大量短斜线，是「被误当线段」的第一大来源，所以预处理阶段就把笔画掩膜算好。
    * 纠偏：用 Hough 长直线角度的中位数估计整体倾斜（限 ±15°），
      画布尺寸不变、白底填充，保证后续「横平竖直吸附」有意义。
    * 骨架化：OpenCV 5.0 没有 ximgproc.thinning、环境里也没有 skimage，
      这里用 numpy 向量化的 Zhang-Suen（稀疏像素实现，比整图卷积快一个量级）。
"""
from __future__ import annotations

from typing import Any, Dict, List, Tuple

import cv2
import numpy as np


# ---------------------------------------------------------------------------
# 读图
# ---------------------------------------------------------------------------
def load_gray(path: str) -> np.ndarray:
    """读取任意图片为灰度 uint8，支持中文路径。

    参数:
        path: 图片路径（可以是 .png / .jpg / .bmp / .tif）。

    返回:
        (H, W) 的 uint8 灰度图（0=黑，255=白，尚未取反）。

    异常:
        IOError: 文件不存在或无法解码。
    """
    try:
        raw = np.fromfile(path, dtype=np.uint8)
    except OSError as exc:                     # 路径不存在 / 权限不足
        raise IOError("无法读取图片文件：%s" % path) from exc
    if raw.size == 0:
        raise IOError("图片文件为空或不存在：%s" % path)
    img = cv2.imdecode(raw, cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise IOError("图片解码失败（不是有效图片）：%s" % path)
    if img.ndim == 3:                          # 理论上不会发生，兜底
        img = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    return np.ascontiguousarray(img, dtype=np.uint8)


# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------
def _odd(value: float, minimum: int = 3) -> int:
    """把浮点核尺寸取成不小于 minimum 的奇数。"""
    size = int(round(float(value)))
    if size < minimum:
        size = minimum
    if size % 2 == 0:
        size += 1
    return size


def _denoise(gray: np.ndarray, level: int) -> np.ndarray:
    """按档位去噪（保边优先）：0 关 / 1 轻 / 2 中 / 3 强。

    为什么不用中值滤波：CAD 图纸里中心线、剖面线常常只有 1 像素宽，
    3×3 中值会把它们整条抹掉（实测默认档位下 17 条剖面线 + 8 条中心线全丢）。
    双边滤波在 sigmaColor 较小时只会平滑「亮度差很小」的邻域，因此噪声被压掉、
    1 像素细线的对比度几乎不变。档位只改窗口与 sigma。
    """
    level = int(level)
    if level <= 0:
        return gray
    if level == 1:
        return cv2.bilateralFilter(gray, 5, 25, 3)
    if level == 2:
        # 先抑制亮色椒盐（min 融合保留暗的细线），再双边
        med = cv2.medianBlur(gray, 3)
        fused = np.minimum(gray, med)
        return cv2.bilateralFilter(fused, 7, 40, 5)
    med = cv2.medianBlur(gray, 3)
    fused = np.minimum(gray, med)
    return cv2.bilateralFilter(fused, 9, 60, 7)


def _sauvola(gray: np.ndarray, window: int, k: float = 0.2) -> np.ndarray:
    """Sauvola 局部二值化（用 cv2.blur 做积分均值，避免逐像素循环）。"""
    win = _odd(window, 15)
    gf = gray.astype(np.float32)
    mean = cv2.blur(gf, (win, win))
    mean_sq = cv2.blur(gf * gf, (win, win))
    std = np.sqrt(np.maximum(mean_sq - mean * mean, 0.0))
    thresh = mean * (1.0 + k * (std / 128.0 - 1.0))
    ink = (gf < thresh - 2.0).astype(np.uint8) * 255
    return ink


def binarize(gray: np.ndarray, options) -> Tuple[np.ndarray, str]:
    """按 options.binarize_method 生成二值图（255=墨迹）。

    auto 的择优逻辑：Otsu 的墨迹占比落在 CAD 图纸的合理区间时优先 Otsu
    （全局阈值最稳、空白处不会被噪声放大）；占比异常（过少=断线、过多=底色
    被当成墨迹）或光照明显不均时改用自适应 / Sauvola。
    """
    method = str(getattr(options, "binarize_method", "auto") or "auto").lower()
    _, otsu = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    r_otsu = float(np.count_nonzero(otsu)) / float(otsu.size)

    # 光照不均程度：大核模糊后的亮度标准差（拍照件的渐变会显著抬高它）
    small = cv2.resize(gray, None, fx=0.25, fy=0.25, interpolation=cv2.INTER_AREA)
    low_freq = cv2.GaussianBlur(small, (0, 0), 12)
    gradient = float(low_freq.std())

    def _adaptive() -> np.ndarray:
        win = _odd(max(15.0, min(gray.shape) * 0.02), 15)
        c = 8.0 if r_otsu > 0.02 else 5.0
        return cv2.adaptiveThreshold(
            gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, win, c)

    if method == "otsu":
        return otsu, "otsu"
    if method == "adaptive":
        return _adaptive(), "adaptive"
    if method == "sauvola":
        return _sauvola(gray, max(15.0, min(gray.shape) * 0.035)), "sauvola"

    # auto：Otsu 对「细而淡」的线（1px 中心线/剖面线，或拍照后褪色的线）会整条漏掉。
    # 判据用「自适应比 Otsu 多找回多少墨迹」：明显更多说明 Otsu 漏了淡线；
    # 但如果多到离谱（>2.5 倍）说明自适应在噪声/底色上失控，仍用 Otsu。
    plausible = 5e-4 <= r_otsu <= 0.25
    cand = _adaptive()
    r_ad = float(np.count_nonzero(cand)) / float(cand.size)
    extra = r_ad / max(r_otsu, 1e-6)
    if not plausible:
        return (cand, "adaptive") if 1e-4 <= r_ad <= 0.35 else (otsu, "otsu")
    if 1e-4 <= r_ad <= 0.35 and 1.03 <= extra <= 2.5:
        return cand, "adaptive"           # 自适应找回了被 Otsu 漏掉的淡线
    if gradient >= 14.0 and 1e-4 <= r_ad <= 0.35:
        # 光照明显不均但两法墨迹量接近：选碎斑更少（连通域更少）的那个，
        # 统计在 1/4 缩略图上做，代价可忽略。
        tiny = cv2.resize(otsu, None, fx=0.25, fy=0.25, interpolation=cv2.INTER_NEAREST)
        tiny_b = cv2.resize(cand, None, fx=0.25, fy=0.25, interpolation=cv2.INTER_NEAREST)
        n_a = cv2.connectedComponentsWithStats(tiny, connectivity=8)[0]
        n_b = cv2.connectedComponentsWithStats(tiny_b, connectivity=8)[0]
        return (otsu, "otsu") if n_a <= n_b else (cand, "adaptive")
    return otsu, "otsu"


def _remove_small_components(mask: np.ndarray, ratio: float) -> Tuple[np.ndarray, int]:
    """去掉面积小于 ratio × 全图面积 的连通域（噪点 / JPEG 斑）。"""
    min_area = max(2.0, float(ratio) * float(mask.size))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    if count <= 1:
        return mask, 0
    areas = stats[1:, cv2.CC_STAT_AREA]
    keep = np.zeros(count, dtype=bool)
    keep[1:] = areas >= min_area
    if keep.all():
        return mask, 0
    removed = int(np.count_nonzero(~keep[1:]))
    lut = np.where(keep, 255, 0).astype(np.uint8)
    return lut[labels], removed


# ---------------------------------------------------------------------------
# 纠偏
# ---------------------------------------------------------------------------
def _as_float_rows(result) -> np.ndarray:
    """把 OpenCV 的线/圆返回值归一化为 (N, K) 浮点数组。

    OpenCV 4.x 返回 (N, 1, K)，OpenCV 5.0 直接返回 (N, K)；这里统一成 (N, K)，
    避免同一份代码在两个大版本上索引崩掉。
    """
    if result is None:
        return np.zeros((0, 4), dtype=np.float64)
    arr = np.asarray(result, dtype=np.float64)
    if arr.ndim == 3:
        arr = arr[:, 0, :]
    elif arr.ndim == 1:
        arr = arr.reshape(-1, 4)
    elif arr.ndim != 2:
        arr = arr.reshape(-1, arr.shape[-1])
    return arr


def estimate_skew(mask: np.ndarray) -> float:
    """用 Hough 长直线角度的（按长度加权）中位数估计整体倾斜，返回角度（度，限 ±15）。

    返回值语义：源图相对水平/垂直轴偏了多少度；纠偏时按该值反向旋转。
    没有足够长直线、偏差小于 0.4°、或超过 15°（可能是透视/特殊图纸）时返回 0。
    """
    h, w = mask.shape[:2]
    long_side = float(max(h, w))
    scale = 1000.0 / long_side
    small = cv2.resize(mask, None, fx=scale, fy=scale, interpolation=cv2.INTER_NEAREST)
    min_len = max(20, int(0.12 * max(small.shape)))
    lines = cv2.HoughLinesP(small, 1, np.pi / 360.0, 60,
                            minLineLength=min_len,
                            maxLineGap=max(3, int(0.01 * long_side * scale)))
    rows = _as_float_rows(lines)
    if len(rows) < 3:
        return 0.0
    angles: List[float] = []
    weights: List[float] = []
    for x1, y1, x2, y2 in rows[:, :4]:
        dx, dy = float(x2 - x1), float(y2 - y1)
        length = float(np.hypot(dx, dy))
        if length < min_len:
            continue
        ang = float(np.degrees(np.arctan2(dy, dx))) % 90.0   # 折叠到 [0, 90)
        dev = ang - 90.0 if ang > 45.0 else ang             # 折叠到 [-45, 45)
        angles.append(dev)
        weights.append(length)
    if not angles:
        return 0.0
    order = np.argsort(angles)
    a = np.asarray(angles, dtype=np.float64)[order]
    wt = np.asarray(weights, dtype=np.float64)[order]
    cw = np.cumsum(wt)
    median = float(a[min(len(a) - 1, np.searchsorted(cw, 0.5 * cw[-1]))])
    if abs(median) < 0.4 or abs(median) > 15.0:
        return 0.0
    return median


def _rotate(gray: np.ndarray, angle_deg: float) -> np.ndarray:
    """绕中心旋转（画布尺寸不变，白底填充）。angle_deg>0 = 把内容逆时针转。"""
    h, w = gray.shape[:2]
    matrix = cv2.getRotationMatrix2D((w / 2.0, h / 2.0), float(angle_deg), 1.0)
    return cv2.warpAffine(gray, matrix, (w, h), flags=cv2.INTER_LINEAR,
                          borderMode=cv2.BORDER_CONSTANT, borderValue=255)


# ---------------------------------------------------------------------------
# 骨架化（Zhang-Suen，稀疏实现）
# ---------------------------------------------------------------------------
_ZHANG_SUEN_LUT: Tuple[np.ndarray, np.ndarray, np.ndarray] = (None, None, None)


def _zhang_suen_lut() -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """预计算 Zhang-Suen 的 256 项查表（把 8 邻域打包成一个字节后直接查表）。

    邻域编码：bit k = P(k+2)，即 bit0=P2(上) … bit7=P9(左上)。
    查表同时算好：
        B(P1) = 8 邻域墨迹数，要求 2 <= B <= 6；
        A(P1) = P2..P9,P2 循环里 0->1 的跳变数，要求 A == 1；
        子迭代 1：P2*P4*P6==0 且 P4*P6*P8==0；
        子迭代 2：P2*P4*P8==0 且 P2*P6*P8==0。
    这样每轮迭代只剩「取 8 邻域 + 拼字节 + 查表」，比逐条件算布尔数组快 4~6 倍。
    """
    global _ZHANG_SUEN_LUT
    if _ZHANG_SUEN_LUT[0] is not None:
        return _ZHANG_SUEN_LUT
    lut1 = np.zeros(256, dtype=bool)
    lut2 = np.zeros(256, dtype=bool)
    counts = np.zeros(256, dtype=np.int8)
    for code in range(256):
        bits = [(code >> i) & 1 for i in range(8)]
        b = sum(bits)
        a = sum(1 for i in range(8) if bits[i] == 0 and bits[(i + 1) % 8] == 1)
        p2, p3, p4, p5, p6, p7, p8, p9 = bits
        counts[code] = b
        if 2 <= b <= 6 and a == 1:
            if p2 * p4 * p6 == 0 and p4 * p6 * p8 == 0:
                lut1[code] = True
            if p2 * p4 * p8 == 0 and p2 * p6 * p8 == 0:
                lut2[code] = True
    _ZHANG_SUEN_LUT = (lut1, lut2, counts)
    return _ZHANG_SUEN_LUT


def skeletonize(mask: np.ndarray, max_iter: int = 120) -> np.ndarray:
    """Zhang-Suen 细化，返回同尺寸 uint8 骨架图（255=骨架）。

    实现说明：
        * 只在「当前仍是墨迹」的坐标列表上做邻域查表，迭代规模随墨迹收缩而下降；
        * 8 邻域先打包成一个 uint8（bit0=P2 … bit7=P9），再用 256 项查表决定某个
          像素在本子迭代里是否删除，避免每轮做十几个布尔数组运算；
        * 不依赖 ximgproc / skimage（OpenCV 5.0 没有 thinning、环境里也没有 skimage）。
    """
    ys, xs = np.nonzero(mask > 0)
    if ys.size == 0:
        return np.zeros(mask.shape, dtype=np.uint8)
    lut1, lut2, _ = _zhang_suen_lut()
    h, w = mask.shape[:2]
    # 带 1 像素边框的查表，省掉边界判断
    lab = np.zeros((h + 2, w + 2), dtype=np.uint8)
    lab[ys + 1, xs + 1] = 1
    cy, cx = (ys + 1).astype(np.int32), (xs + 1).astype(np.int32)
    offsets = [(-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1), (0, -1), (-1, -1)]

    for _ in range(int(max_iter)):
        removed_any = False
        for lut in (lut1, lut2):
            if cy.size == 0:
                break
            code = lab[cy - 1, cx].astype(np.uint8)          # P2 = bit0
            code |= lab[cy - 1, cx + 1] << 1                 # P3
            code |= lab[cy, cx + 1] << 2                     # P4
            code |= lab[cy + 1, cx + 1] << 3                 # P5
            code |= lab[cy + 1, cx] << 4                     # P6
            code |= lab[cy + 1, cx - 1] << 5                 # P7
            code |= lab[cy, cx - 1] << 6                     # P8
            code |= lab[cy - 1, cx - 1] << 7                 # P9
            cond = lut[code]
            if not cond.any():
                continue
            lab[cy[cond], cx[cond]] = 0
            keep = ~cond
            cy, cx = cy[keep], cx[keep]
            removed_any = True
        if not removed_any:
            break

    out = np.zeros(mask.shape, dtype=np.uint8)
    if cy.size:
        out[cy - 1, cx - 1] = 255
    return out


# ---------------------------------------------------------------------------
# 文字区检测
# ---------------------------------------------------------------------------
def _looks_like_circle(labels: np.ndarray, label: int,
                       x: int, y: int, w: int, h: int) -> bool:
    """判断连通域是否更像 CAD 圆（孔/外圆）而不是字形。

    CAD 图中的小孔是一圈很细的闭合圆环，和字母「O」「0」在尺寸/笔画宽上
    几乎一样，早期版本会把成排的螺栓孔误判成一行字并整体掩掉，导致孔全部
    丢失。这里用外轮廓的圆度 + 半径一致性区分：
        * 真圆：外轮廓圆度 >= 0.86，半径标准差/均值 <= 0.10；
        * 数字 0/字母 O：圆度通常 <= 0.82，且宽高比明显小于 1（实测 0.58）。
    只对宽高比接近 1 的候选做这项检查，避免误伤「1」「—」等窄/宽字形。
    """
    if h <= 0 or w <= 0:
        return False
    aspect = w / float(h)
    if not (0.78 <= aspect <= 1.28):
        return False
    crop = (labels[y:y + h, x:x + w] == label).astype(np.uint8)
    contours, _ = cv2.findContours(crop, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not contours:
        return False
    contour = max(contours, key=cv2.contourArea)
    area = float(cv2.contourArea(contour))
    perimeter = float(cv2.arcLength(contour, True))
    if perimeter <= 1e-6:
        return False
    circularity = 4.0 * np.pi * area / (perimeter * perimeter)
    if circularity < 0.86:
        return False
    pts = contour.reshape(-1, 2).astype(np.float64)
    center = pts.mean(axis=0)
    radii = np.hypot(pts[:, 0] - center[0], pts[:, 1] - center[1])
    mean_r = float(radii.mean())
    if mean_r <= 1e-6:
        return False
    radial_cv = float(radii.std() / mean_r)
    return radial_cv <= 0.10


def detect_text_boxes(mask: np.ndarray,
                      stroke_width: float) -> Tuple[np.ndarray, List[Tuple[float, float, float, float]]]:
    """检测文字区，返回（膨胀后的文字笔画掩膜，文字区框列表）。

    思路（不用 OCR，纯几何统计）：
        1. 汉字 / 数字的笔画宽度与图线相当，只看笔画宽无法区分；
        2. 但字形是「小尺寸、内部填充率中等、笔画细」的连通域，而图线是
           「长宽比极端或尺寸巨大、内部填充率低」的连通域；
        3. 先用「尺寸区间 + 填充率 + 最大内切半径（笔画粗细）」筛出字形候选，
           再按行聚类（墨迹成行排列）确认文字带；
        4. 最后把候选笔画掩掉并外扩 2 倍笔画宽，避免抗锯齿灰边残留成假线段。
    """
    h_img, w_img = mask.shape[:2]
    sw = max(0.8, float(stroke_width))
    empty = np.zeros(mask.shape, dtype=np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    if count <= 1:
        return empty, []

    min_side = float(np.clip(3.0 * sw, 5.0, 18.0))
    max_side = float(np.clip(30.0 * sw, 24.0, 120.0))
    max_side = min(max_side, 0.5 * min(h_img, w_img))

    # 距离变换：每个连通域的「最大内切半径」= 最粗处的半笔画宽
    dist = cv2.distanceTransform((mask > 0).astype(np.uint8), cv2.DIST_L2, 3)
    thick_limit = 2.3 * sw
    pad = 2

    # 尺寸 / 长宽比 / 填充率用 numpy 一次性筛（组件数上千时这一步占大头）
    left = stats[1:, cv2.CC_STAT_LEFT].astype(np.int32)
    top = stats[1:, cv2.CC_STAT_TOP].astype(np.int32)
    wid = stats[1:, cv2.CC_STAT_WIDTH].astype(np.int32)
    hei = stats[1:, cv2.CC_STAT_HEIGHT].astype(np.int32)
    area = stats[1:, cv2.CC_STAT_AREA].astype(np.float64)
    fill = area / np.maximum(1.0, (wid * hei).astype(np.float64))
    ok = ((wid >= min_side) & (hei >= min_side) & (wid <= max_side) & (hei <= max_side)
          & (wid <= 3.4 * hei) & (hei <= 3.4 * wid)
          & (fill >= 0.10) & (fill <= 0.92))
    shortlist = np.nonzero(ok)[0] + 1

    candidates: List[Tuple[int, int, int, int, int]] = []   # x, y, w, h, label
    for idx in shortlist:
        x = int(left[idx - 1]); y = int(top[idx - 1])
        bw = int(wid[idx - 1]); bh = int(hei[idx - 1])
        # 横向特别宽的单连通域（如被中心线切断后留下的圆弧 + 虚线）不是字；
        # 螺钉孔被中心线切开后就会形成 107x65（宽高比 1.65）的弧段。
        if bw > 1.55 * bh and bw > 2.5 * sw:
            continue
        # 成排小圆（螺栓孔 / 沉孔）是闭合圆环，不能当文字掩掉。
        if _looks_like_circle(labels, int(idx), x, y, bw, bh):
            continue
        y0 = max(0, y - pad); x0 = max(0, x - pad)
        y1 = min(h_img, y + bh + pad); x1 = min(w_img, x + bw + pad)
        if 2.0 * float(dist[y0:y1, x0:x1].max()) > thick_limit:
            continue                                  # 实心块（焊盘 / 涂黑），不是字
        candidates.append((x, y, bw, bh, int(idx)))

    if not candidates:
        return empty, []

    # 行聚类：竖向重叠 >= 55% 且行中心高差 <= 0.6 * 最大字高 视为同一行
    candidates.sort(key=lambda c: c[1] + c[3] / 2.0)
    rows: List[List[Tuple[int, int, int, int, int]]] = []
    for cand in candidates:
        cy = cand[1] + cand[3] / 2.0
        placed = False
        for row in rows:
            ry0 = min(c[1] for c in row); ry1 = max(c[1] + c[3] for c in row)
            overlap = min(ry1, cand[1] + cand[3]) - max(ry0, cand[1])
            if overlap > 0.55 * min(ry1 - ry0, cand[3]) and abs(cy - (ry0 + ry1) / 2.0) <= 0.6 * max_side:
                row.append(cand)
                placed = True
                break
        if not placed:
            rows.append([cand])

    accepted: List[int] = []
    boxes: List[Tuple[float, float, float, float]] = []
    for row in rows:
        # 单字也保留（表格里常见单值单元格）；但要求该字「够像字」：
        # 尺寸不小于 4 倍笔画宽、宽高比接近 1（数字 / 字母 / 汉字）
        if len(row) == 1:
            x, y, bw, bh, idx = row[0]
            if bh < 4.0 * sw or bw < 0.28 * bh:
                continue
        for x, y, bw, bh, idx in row:
            accepted.append(idx)
        x0 = min(c[0] for c in row); y0 = min(c[1] for c in row)
        x1 = max(c[0] + c[2] for c in row); y1 = max(c[1] + c[3] for c in row)
        boxes.append((float(x0), float(y0), float(x1 - x0), float(y1 - y0)))

    if not accepted:
        return empty, []
    lut = np.zeros(count, dtype=np.uint8)
    lut[np.asarray(sorted(set(accepted)), dtype=np.int64)] = 255
    glyphs = lut[labels]
    radius = int(round(float(np.clip(2.0 * sw, 2.0, 6.0))))
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * radius + 1, 2 * radius + 1))
    text_mask = cv2.dilate(glyphs, kernel)
    # 框也外扩同样的余量，保证「框」与「掩膜」语义一致
    boxes = [(max(0.0, x - radius), max(0.0, y - radius),
              w + 2.0 * radius, h + 2.0 * radius) for (x, y, w, h) in boxes]
    boxes.sort(key=lambda b: (round(b[1] / 8.0), b[0]))
    return text_mask, boxes


# ---------------------------------------------------------------------------
# 预处理主入口
# ---------------------------------------------------------------------------
def preprocess(gray: np.ndarray, options) -> Dict[str, Any]:
    """完整预处理，返回固定键字典（见 docs/研发协作约定.md 第 3 节）。

    返回键：
        gray        : 去噪 / 纠偏后的 uint8 灰度（供圆检测用）
        mask        : 原始二值图（255=墨迹）
        clean       : 去噪点 + 闭运算后的二值图（供直线 / 圆提取）
        skeleton    : 骨架图（供可视化）
        text_mask   : 文字笔画掩膜（已膨胀）
        text_boxes  : list[(x, y, w, h)]
        skew_deg    : 纠偏角度（源图倾斜度；未纠偏为 0）
        method      : 实际二值化方法
        stroke_width: 估计笔画宽度（像素）
        polarity    : normal / inverted（深底白线自动反相）
        bg_level    : 估计的背景灰度（极性判定依据）
        stats       : {"ink_ratio", "components_removed", "deskew_deg"}
    """
    gray = np.asarray(gray)
    if gray.ndim == 3:
        gray = cv2.cvtColor(gray, cv2.COLOR_BGR2GRAY)
    if gray.dtype != np.uint8:
        gray = np.clip(gray, 0, 255).astype(np.uint8)
    raw_work = gray.copy()
    work = _denoise(gray, getattr(options, "denoise", 1))

    # 0) 极性判定：深色背景（深色 UI 截图 / 蓝图 / 黑底白线）先反相，
    #    统一成「浅底深线」再走二值化；否则 Otsu 会把整块背景当成墨迹（实测 dark 截图 ink=94%）。
    polarity = "normal"
    bg_level = 255
    if getattr(options, "auto_polarity", True):
        q = (work // 8).astype(np.int32)
        hist = np.bincount(q.ravel(), minlength=32)
        bg_level = int(np.argmax(hist)) * 8 + 4
        if bg_level < 110:
            work = (255 - work).astype(np.uint8)
            raw_work = (255 - raw_work).astype(np.uint8)
            polarity = "inverted"
            # 深底截图反相后，背景常带渐变/UI 阴影，全局 Otsu 会把大片背景当墨迹；
            # 实测 adaptive 的 F1 0.84 / 召回 0.78，优于 otsu 的 0.72 / 0.58。
            if getattr(options, "binarize_method", "auto") == "auto":
                try:
                    import copy as _copy
                    options = _copy.copy(options)
                    options.binarize_method = "adaptive"
                except Exception:
                    pass

    # 1) 纠偏（先粗二值化只为估角，纠偏后重新二值化）
    # 角度约定：estimate_skew 返回的是「线相对水平/垂直轴的倾角」，
    # 而 cv2.getRotationMatrix2D(center, A) 会把线的倾角减少 A，
    # 所以抵消倾角 est 需要施加 A = est（符号写错会变成「越纠越歪」，实测 8° 偏差）。
    skew_deg = 0.0
    if getattr(options, "deskew", True):
        rough, _ = binarize(work, options)
        estimate = estimate_skew(rough)
        if abs(estimate) >= 0.4:
            work = _rotate(work, estimate)
            raw_work = _rotate(raw_work, estimate)
            skew_deg = float(estimate)           # 实际施加的旋转角（= getRotationMatrix2D 的 angle）

    # Hough 用的灰度：保留「纠偏/反相后、去噪前」的版本。
    # 去噪会抹掉小半径圆弧的梯度，实测外圆/内孔同心时，去噪图只能找到外圆，
    # 未去噪图只能找到内孔；两路候选并集才能同时拿到（见 vectorize.detect_circles）。
    hough_gray = raw_work

    # 2) 二值化 → 去噪点
    mask, method = binarize(work, options)
    mask, removed = _remove_small_components(mask, getattr(options, "min_component_ratio", 0.00002))

    # 3) 骨架 + 笔画宽度（墨迹面积 / 骨架长度，对 1px 与 3px 线都成立）
    skeleton = skeletonize(mask)
    ink = float(np.count_nonzero(mask))
    skel = float(np.count_nonzero(skeleton))
    stroke = ink / skel if skel > 0 else 1.5
    stroke = float(np.clip(stroke, 0.8, 20.0))

    # 4) 文字区（在闭运算之前做，避免闭运算把字形糊成实心块导致漏判）
    if getattr(options, "detect_text", True):
        text_mask, text_boxes = detect_text_boxes(mask, stroke)
    else:
        text_mask = np.zeros(mask.shape, dtype=np.uint8)
        text_boxes = []

    # 5) 闭运算连接断线 → clean；文字笔画从 clean 中抹掉（下游按 text_mask 再掩一次）
    long_side = float(max(mask.shape))
    ksize = _odd(max(3.0, getattr(options, "close_kernel_ratio", 0.0012) * long_side), 3)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (ksize, ksize))
    clean = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
    clean[text_mask > 0] = 0

    ink_ratio = float(np.count_nonzero(mask)) / float(mask.size)
    return {
        "gray": work,
        "hough_gray": hough_gray,
        "mask": mask,
        "clean": clean,
        "skeleton": skeleton,
        "text_mask": text_mask,
        "text_boxes": text_boxes,
        "skew_deg": float(skew_deg),
        "method": method,
        "stroke_width": stroke,
        "polarity": polarity,
        "bg_level": bg_level,
        "stats": {
            "ink_ratio": round(ink_ratio, 6),
            "components_removed": int(removed),
            "deskew_deg": round(float(skew_deg), 3),
        },
    }

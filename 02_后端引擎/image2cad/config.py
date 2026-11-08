# -*- coding: utf-8 -*-
"""
config.py
=========
「看图成图」的可调参数与运行选项。

为什么把参数集中在这里：
    * Web UI 的滑杆、CLI 的开关、自动化测试都只依赖这一个 Options 对象，
      避免参数散落在算法内部导致"界面上调了但没生效"；
    * 每个参数都带中文说明与推荐范围（to_ui_schema），UI 可直接渲染，
      新增参数时只改这一处。
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any, Dict, List, Optional


@dataclass
class Options:
    # ---- 预处理 ----
    binarize_method: str = "auto"     # auto / otsu / adaptive / sauvola
    denoise: int = 1                  # 0=关 1=轻 2=中 3=强（中值/双边滤波）
    deskew: bool = True                  # 自动纠偏（±15° 内）
    auto_polarity: bool = True           # 深底白线（截图/蓝图）自动反相成浅底深线               # 自动纠偏（±15° 内）
    min_component_ratio: float = 0.00002   # 小于该面积占比的连通域视为噪点（相对全图）
    close_kernel_ratio: float = 0.0012     # 形态学闭运算核大小（相对长边），可连接断线

    # ---- 直线提取 ----
    min_line_ratio: float = 0.012     # 最小线段长度 / 图像长边
    max_gap_ratio: float = 0.012      # Hough 允许的最大断口 / 图像长边
    hough_threshold: int = 40         # Hough 累加器阈值（自适应后会再校正）
    merge_angle_deg: float = 1.5      # 共线合并的角度容差
    merge_dist_ratio: float = 0.0025  # 共线合并的垂直距离容差 / 长边
    merge_gap_ratio: float = 0.010    # 共线合并的端点间隙容差 / 长边
    snap_ortho_deg: float = 2.0       # 水平/垂直吸附容差（度）
    endpoint_snap_ratio: float = 0.006 # 端点吸附容差 / 长边（T 形接点闭合）
    simplify_px: float = 0.6          # 线段端点直线化简化容差（像素）

    # ---- 圆 / 矩形 / 文字 ----
    detect_circles: bool = True
    circle_min_ratio: float = 0.01    # 最小半径 / 长边
    circle_max_ratio: float = 0.45    # 最大半径 / 长边
    close_loops: bool = True          # 把四条边组成的闭合框输出为矩形
    rect_angle_tol_deg: float = 1.2   # 判定"轴对齐矩形"的角度容差
    detect_text: bool = True          # 文字区检测（掩掉文字笔画，避免被当成线段）
    text_layer: bool = True           # 是否把文字区框保留到 DXF（图层：文字区）
    ocr: bool = True                  # OCR 识别（Windows 内置）；关闭后 DXF 只有文字区框

    # ---- CAD 制作强化：尺寸标注 / 图层分类 ----
    add_dimensions: bool = True       # 自动为主轮廓/图幅生成线性尺寸标注
    classify_layers: bool = True      # 把中心线/图框/尺寸标注整理到对应图层
    dim_text_height_mm: float = 3.5   # 尺寸文字高度（毫米）
    dim_extension_mm: float = 4.0     # 尺寸界线超出量（毫米）

    # ---- 比例与输出 ----
    scale_mode: str = "sheet"         # sheet = 按图幅宽度换算；dpi = 按扫描 DPI；px = 1px=1单位
    sheet_width_mm: float = 297.0     # A4 横向宽度；用户可改为实际图幅
    dpi: float = 300.0                # scale_mode=dpi 时使用
    unit: str = "mm"                  # 输出单位：mm / cm / m / inch
    layer_outline: str = "轮廓"
    layer_center: str = "中心线"
    layer_text: str = "文字区"
    layer_frame: str = "图框"
    layer_dim: str = "尺寸标注"
    dxf_version: str = "R2010"        # 兼容 AutoCAD 2010+
    export_svg: bool = True
    run_recognition: bool = True      # 生成 DXF 后自动调用图框识读引擎（若可用）
    recognition_dir: str = ""         # 自定义 v1.1 引擎目录（留空=自动探测）

    # ---- 运行环境 ----
    max_side_px: int = 2600           # 大图先等比缩小到该长边，控制耗时（输出仍按原比例换算）
    debug_artifacts: bool = True      # 输出中间步骤 PNG

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Optional[Dict[str, Any]]) -> "Options":
        """从 Web 请求/JSON 构造选项，忽略未知键并做基础类型校正。"""
        opts = cls()
        if not data:
            return opts
        for key, value in dict(data).items():
            if not hasattr(opts, key):
                continue
            current = getattr(opts, key)
            try:
                if isinstance(current, bool):
                    setattr(opts, key, bool(value))
                elif isinstance(current, int) and not isinstance(current, bool):
                    setattr(opts, key, int(float(value)))
                elif isinstance(current, float):
                    setattr(opts, key, float(value))
                else:
                    setattr(opts, key, str(value))
            except (TypeError, ValueError):
                continue
        opts.sanitize()
        return opts

    def sanitize(self) -> None:
        """把参数夹到安全范围，避免 UI 误输入导致算法异常/卡死。"""
        self.denoise = max(0, min(3, int(self.denoise)))
        self.hough_threshold = max(10, min(200, int(self.hough_threshold)))
        self.binarize_method = self.binarize_method if self.binarize_method in (
            "auto", "otsu", "adaptive", "sauvola") else "auto"
        self.scale_mode = self.scale_mode if self.scale_mode in ("sheet", "dpi", "px") else "sheet"
        self.unit = self.unit if self.unit in ("mm", "cm", "m", "inch") else "mm"
        self.scale_factor()  # 触发一次校验

    def scale_factor(self) -> float:
        """返回 1 像素对应的输出单位数（只做换算，不改图像）。"""
        if self.scale_mode == "px":
            mm_per_px = 1.0
        elif self.scale_mode == "dpi":
            mm_per_px = 25.4 / max(1.0, float(self.dpi))
        else:
            width_px = getattr(self, "_ref_width_px", 0) or 0
            mm_per_px = (self.sheet_width_mm / width_px) if width_px else 0.0
        if self.unit == "mm":
            return mm_per_px
        if self.unit == "cm":
            return mm_per_px / 10.0
        if self.unit == "m":
            return mm_per_px / 1000.0
        return mm_per_px / 25.4


def ui_schema() -> List[Dict[str, Any]]:
    """Web UI 的控制面板定义（滑杆/开关/下拉），前后端共用一份。"""
    return [
        {"key": "binarize_method", "label": "二值化方式", "type": "select",
         "options": [("auto", "自动判断"), ("otsu", "全局 Otsu"), ("adaptive", "局部自适应"), ("sauvola", "Sauvola")],
         "hint": "自动：按墨迹占比与笔画对比度择优"},
        {"key": "denoise", "label": "去噪强度", "type": "range", "min": 0, "max": 3, "step": 1,
         "hint": "扫描件 0-1；手机拍照 2-3"},
        {"key": "deskew", "label": "自动纠偏", "type": "switch", "hint": "把整体倾斜拉正，避免吸附失效"},
        {"key": "min_line_ratio", "label": "最短线段", "type": "range", "min": 0.003, "max": 0.05, "step": 0.001,
         "hint": "相对图像长边；越大越只保留主干线"},
        {"key": "merge_gap_ratio", "label": "断线合并", "type": "range", "min": 0.0, "max": 0.03, "step": 0.001,
         "hint": "虚线/断口合并容差"},
        {"key": "snap_ortho_deg", "label": "横平竖直吸附", "type": "range", "min": 0.0, "max": 8.0, "step": 0.5,
         "hint": "接近水平/垂直的线吸附为精确 0°/90°"},
        {"key": "detect_circles", "label": "识别圆", "type": "switch"},
        {"key": "close_loops", "label": "闭合矩形识别", "type": "switch", "hint": "四条边合成一个矩形轮廓"},
        {"key": "detect_text", "label": "文字区保护", "type": "switch", "hint": "自动掩掉文字笔画，避免被误当线段"},
        {"key": "ocr", "label": "文字识别(OCR)", "type": "switch", "hint": "Windows 内置 OCR；关闭则只保留文字区框"},
        {"key": "add_dimensions", "label": "自动尺寸标注", "type": "switch", "hint": "为主轮廓/图幅生成线性尺寸，整理到「尺寸标注」图层"},
        {"key": "scale_mode", "label": "比例来源", "type": "select",
         "options": [("sheet", "按图幅宽度"), ("dpi", "按扫描 DPI"), ("px", "1 像素 = 1 单位")]},
        {"key": "sheet_width_mm", "label": "图幅宽度(mm)", "type": "number", "min": 50, "max": 2000, "step": 1,
         "hint": "A4 横向 297 / A3 横向 420"},
        {"key": "max_side_px", "label": "处理长边(px)", "type": "number", "min": 600, "max": 6000, "step": 100,
         "hint": "大图先缩放处理，比例不变"},
        {"key": "run_recognition", "label": "联动图框识读", "type": "switch", "hint": "生成 DXF 后自动跑 v1.1 识读引擎"},
    ]

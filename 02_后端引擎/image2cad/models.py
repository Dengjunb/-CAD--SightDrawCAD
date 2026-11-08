# -*- coding: utf-8 -*-
"""
models.py
=========
看图成图（Image → CAD）核心数据模型。

设计原则：
    * 几何图元一律用**像素坐标**表达（左上角为原点、y 轴向下），
      与 OpenCV 的图像坐标系保持一致；转毫米、转 DXF 时由 writer 统一换算。
    * 每个结果对象都能序列化为 JSON，便于 Web UI / 报告 / 自动化测试复用。

坐标约定：
    * x 向右为正，y 向下为正；
    * Segment 的端点顺序不做保证，比较方向时按角度归一化到 [0, 180)。
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any, Dict, List, Optional, Set


# ---------------------------------------------------------------------------
# 几何图元
# ---------------------------------------------------------------------------
@dataclass
class Segment:
    """一条直线段（像素坐标）。"""
    x1: float
    y1: float
    x2: float
    y2: float
    source: str = "hough"          # 来源：hough / polyline / manual

    @property
    def length(self) -> float:
        return ((self.x2 - self.x1) ** 2 + (self.y2 - self.y1) ** 2) ** 0.5

    @property
    def angle_deg(self) -> float:
        """方向角，归一化到 [0, 180)，单位度。"""
        import math
        a = math.degrees(math.atan2(self.y2 - self.y1, self.x2 - self.x1))
        return a % 180.0

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class Circle:
    """圆（像素坐标）。"""
    cx: float
    cy: float
    r: float
    source: str = "hough"

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class Rect:
    """轴对齐（或带旋转角）矩形轮廓（像素坐标，x/y 为左上角）。"""
    x: float
    y: float
    w: float
    h: float
    angle: float = 0.0             # 仅 0 / 90 表示轴对齐；预留旋转框
    source: str = "loop"

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class TextBox:
    """检测到的文字区域（像素坐标），保留在 CAD 的「文字区」图层。"""
    x: float
    y: float
    w: float
    h: float
    confidence: float = 0.0
    text: str = ""                 # 预留 OCR 结果；无 OCR 时为空

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


# ---------------------------------------------------------------------------
# 场景与步骤
# ---------------------------------------------------------------------------
@dataclass
class VectorScene:
    """一张图矢量化后的全部图元。"""
    width_px: int = 0
    height_px: int = 0
    segments: List[Segment] = field(default_factory=list)
    circles: List[Circle] = field(default_factory=list)
    rects: List[Rect] = field(default_factory=list)
    text_boxes: List[TextBox] = field(default_factory=list)
    stroke_width_px: float = 1.0
    scale_mm_per_px: float = 1.0
    polylines: List[Any] = field(default_factory=list)          # cadclean.Polyline（链/闭合轮廓）
    consumed_segments: Set[int] = field(default_factory=set)    # 已并入多段线的线段下标

    def to_dict(self) -> Dict[str, Any]:
        return {
            "width_px": self.width_px,
            "height_px": self.height_px,
            "stroke_width_px": round(self.stroke_width_px, 3),
            "scale_mm_per_px": round(self.scale_mm_per_px, 6),
            "segments": [s.to_dict() for s in self.segments],
            "circles": [c.to_dict() for c in self.circles],
            "polylines": [p.to_dict() for p in self.polylines],
            "rects": [r.to_dict() for r in self.rects],
            "text_boxes": [t.to_dict() for t in self.text_boxes],
        }

    @property
    def entity_count(self) -> int:
        return (len(self.segments) + len(self.circles) + len(self.polylines)
                + len(self.rects) + len(self.text_boxes))


@dataclass
class StepResult:
    """流水线中的一个可视化步骤（供 UI 的「过程胶片」展示）。"""
    key: str                       # 机器可读 id，如 "binarize"
    title: str                     # 中文标题，如 "二值化"
    detail: str                    # 一句话说明（这步做了什么、为什么）
    image: str = ""                # 相对 run 目录的 PNG 路径（可为空）
    metrics: Dict[str, Any] = field(default_factory=dict)
    ms: float = 0.0                # 该步骤耗时（毫秒）

    def to_dict(self) -> Dict[str, Any]:
        return {
            "key": self.key,
            "title": self.title,
            "detail": self.detail,
            "image": self.image,
            "metrics": self.metrics,
            "ms": round(self.ms, 2),
        }


@dataclass
class QualityReport:
    """矢量化质量自检（与输入墨迹做栅格化对比）。"""
    ink_ratio: float = 0.0         # 输入二值图中墨迹像素占比
    vector_ink_ratio: float = 0.0  # 矢量重绘后的墨迹占比
    precision: float = 0.0         # 矢量图落在输入墨迹上的比例（防乱画）
    recall: float = 0.0            # 输入墨迹被矢量化覆盖的比例（防漏画）
    f1: float = 0.0
    chamfer_px: float = 0.0        # 双向平均最近距离（像素，越小越贴合）
    extra_segments: int = 0        # 明显偏开的线段数（噪声误检）
    note: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "ink_ratio": round(self.ink_ratio, 5),
            "vector_ink_ratio": round(self.vector_ink_ratio, 5),
            "precision": round(self.precision, 4),
            "recall": round(self.recall, 4),
            "f1": round(self.f1, 4),
            "chamfer_px": round(self.chamfer_px, 3),
            "extra_segments": self.extra_segments,
            "note": self.note,
        }


@dataclass
class RunResult:
    """一次「看图成图」运行的完整结果（落盘为 report.json）。"""
    run_id: str
    created_at: str
    source_name: str
    source_width: int
    source_height: int
    source_bytes: int
    steps: List[StepResult] = field(default_factory=list)
    scene: VectorScene = field(default_factory=VectorScene)
    quality: QualityReport = field(default_factory=QualityReport)
    files: Dict[str, str] = field(default_factory=dict)
    metrics: Dict[str, Any] = field(default_factory=dict)
    warnings: List[str] = field(default_factory=list)
    recognition: Optional[Dict[str, Any]] = None
    elapsed_ms: float = 0.0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "runId": self.run_id,
            "createdAt": self.created_at,
            "source": {
                "name": self.source_name,
                "width": self.source_width,
                "height": self.source_height,
                "bytes": self.source_bytes,
            },
            "steps": [s.to_dict() for s in self.steps],
            "metrics": {
                **self.metrics,
                "elapsed_ms": round(self.elapsed_ms, 1),
                "segments": len(self.scene.segments),
                "circles": len(self.scene.circles),
                "rects": len(self.scene.rects),
                "text_boxes": len(self.scene.text_boxes),
            },
            "quality": self.quality.to_dict(),
            "files": self.files,
            "warnings": self.warnings,
            "recognition": self.recognition,
            "scene": self.scene.to_dict(),
        }



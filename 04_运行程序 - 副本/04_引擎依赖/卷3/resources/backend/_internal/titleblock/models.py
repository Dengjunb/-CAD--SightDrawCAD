# -*- coding: utf-8 -*-
"""
models.py
=========
核心数据模型定义。

该项目用于"基于CAD零件图纸信息的智能识读"：
把图框（标题栏）中零散的图元（文字、多行文字、块参照等）识别并配对成
"字段标签 -> 字段值"的结构化数据，最终生成统一命名的标准化块参照。

本模块只负责承载数据，不含业务逻辑，是其它所有模块的共同"契约"。

数据流概览：
    parser（读取CAD）        -> TextElement（统一文字元素）
    field_recognizer（识别）  -> FieldCandidate（潜在字段）
    matcher（配对）           -> FieldPair（标签-值 对）
    block_builder（生成）     -> 写回标题栏左下角原点的一个块参照
"""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import Optional, Tuple, List


# ---------------------------------------------------------------------------
# 坐标系与几何常量
# ---------------------------------------------------------------------------
EPS = 1e-6  # 浮点比较用极小值


@dataclass
class Point:
    """二维点，用于统一表示文字插入点 / 几何坐标。"""
    x: float = 0.0
    y: float = 0.0

    def as_tuple(self) -> Tuple[float, float]:
        return (self.x, self.y)


# ---------------------------------------------------------------------------
# 文字元素（CAD 中每一种文字载体的统一表示）
# ---------------------------------------------------------------------------
@dataclass
class TextElement:
    """
    统一文字元素。

    无论原始图元是 TEXT、MTEXT，还是被包含在某块参照(INSERT)内部，
    都会被标准化成这个结构，从而让上层"识别/配对"模块不关心底层格式。

    属性说明：
        text      : 清洗后的文字内容（去 DXF 控制码、合并多行等）
        raw_text  : 原始文字内容，用于调试
        x, y      : 文字插入点（世界坐标 WCS）
        height    : 字高；若为 0 则用默认值兜底
        layer     : 所在图层名
        style     : 文字样式名
        is_mtext  : 是否多行文字
        owner_block : 若文字位于某 INSERT 块内，这里记录块名（用于回溯）
        insert_owner : 若文字位于某 INSERT 块内，记录该 INSERT 句柄
        handle    : 原始实体句柄（用于保留原始图元属性 / 去重）
        entity_type : 原始图元类型（TEXT/MTEXT/ATTDEF/...）
        color_info   : (颜色索引, 真彩色) 保留原始颜色等属性
        width      : 估算的文字整体宽度（用于多行合并与配对）
    """
    text: str = ""
    raw_text: str = ""
    x: float = 0.0
    y: float = 0.0
    height: float = 2.5
    layer: str = "0"
    style: str = "STANDARD"
    is_mtext: bool = False
    owner_block: Optional[str] = None
    insert_owner: Optional[str] = None
    handle: str = ""
    entity_type: str = "TEXT"
    color_info: Tuple = (256, None)
    width: float = 0.0

    def __repr__(self) -> str:  # pragma: no cover - 仅供调试
        return (f"<Text {self.text!r} @({self.x:.2f},{self.y:.2f}) "
                f"h={self.height:.2f} {self.layer}>")


# ---------------------------------------------------------------------------
# 字段识别结果
# ---------------------------------------------------------------------------
@dataclass
class FieldCandidate:
    """
    单个潜在字段元素（可扮演"标签 label"或"值 value",由识别模块判定）。

    attributes:
        element        : 对应的统一文字元素
        kind           : 'label'（字段名）| 'value'（字段值）| 'unknown'
        normalized     : 标准化后的文本（如去掉空格、全角半角统一）
        semantic_type  : 语义类型（详见 field_recognizer）
        is_multi       : 是否参与多行合并的片段
    """
    element: TextElement
    kind: str = "unknown"
    normalized: str = ""
    semantic_type: str = "text"
    is_multi: bool = False
    # 标签强信号分：>=2 视为强字段标签；1 视为"疑似标签"（仍可被当作值使用）；
    # 0 表示没有标签信号。配对器据此区分"必须是标签"和"可以是值"。
    label_score: int = 0


# ---------------------------------------------------------------------------
# 配对结果
# ---------------------------------------------------------------------------
@dataclass
class FieldPair:
    """
    一个"字段标签 -> 字段值"配对结果。

    约定：
        label             : 字段名（规范化后的标签文字）
        label_raw         : 原始标签文字（保留原名）
        value             : 该字段的值（可能由多行文本合并而来）
        value_raw         : 原始值
        confidence        : 配对置信度 0~1
        label_position    : 标签插入点
        value_position    : 值插入点（多行合并时为第一行位置）
        unmatched_label   : True 表示只有标签而无值
        unmatched_value   : True 表示只有值而无标签
    """
    label: str = ""
    label_raw: str = ""
    value: str = ""
    value_raw: str = ""
    confidence: float = 0.0
    label_position: Point = field(default_factory=Point)
    value_position: Point = field(default_factory=Point)
    unmatched_label: bool = False
    unmatched_value: bool = False


# ---------------------------------------------------------------------------
# 图纸级结构化结果
# ---------------------------------------------------------------------------
@dataclass
class RecognitionResult:
    """
    单张图纸的最终识读结果。

    attributes:
        source_file     : 输入文件路径
        pairs           : 成功配对的 字段标签->值 列表
        unmatched       : 未能配对的内容（label 缺失或 value 缺失）
        all_labels      : 识别到的全部标签（去重前）
        title_origin    : 识别到的标题栏左下角（块参照插入点）
        title_block_handle : 生成的标准化块参照句柄
        title_region    : 标题栏包围盒 (xmin, ymin, xmax, ymax)
        stats           : 统计信息（文本数量、耗时、问题统计等）
    """
    source_file: str = ""
    pairs: List[FieldPair] = field(default_factory=list)
    unmatched: List[FieldPair] = field(default_factory=list)
    all_labels: List[str] = field(default_factory=list)
    title_origin: Point = field(default_factory=Point)
    title_block_handle: str = ""
    title_region: Optional[Tuple[float, float, float, float]] = None
    stats: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        """导出为可 JSON 序列化的字典，便于写入结构化数据文件。"""
        return {
            "source_file": self.source_file,
            "title_origin": self.title_origin.as_tuple(),
            "title_region": self.title_region,
            "fields": [
                {"label": p.label,
                 "label_raw": p.label_raw,
                 "value": p.value,
                 "value_raw": p.value_raw,
                 "confidence": round(p.confidence, 3)}
                for p in self.pairs
            ],
            "unmatched": [
                {"label": p.label, "value": p.value, "label_raw": p.label_raw}
                for p in self.unmatched
            ],
            "stats": self.stats,
        }

# -*- coding: utf-8 -*-
"""image2cad：看图成图（Image → CAD）工具包。

模块职责：
    imaging.py    预处理：灰度、去噪、二值化、纠偏、骨架、文字区
    vectorize.py  矢量化：直线/圆/矩形/文字区
    dxf_writer.py DXF/SVG 写出
    rasterize.py  矢量栅格化（质量自检、预览）
    pipeline.py   流水线编排（步骤可视化 + 落盘）
    report.py     HTML 报告生成
    server.py     本地 Web 服务（双模式：图片→CAD / 图框识读）
    mode_a.py     模式 A 的 Web 封装（字段、预览、标准化副本）
    recognition.py 联动 v1.1 图框识读引擎（图片 → DXF → 字段）
"""
from .config import Options, ui_schema  # noqa: F401
from .models import (  # noqa: F401
    Segment, Circle, Rect, TextBox, VectorScene, StepResult,
    QualityReport, RunResult,
)

__version__ = "2.1.0"

# -*- coding: utf-8 -*-
"""
titleblock - 基于 CAD 零件图纸信息的智能识读工具包。

包含模块：
    models            核心数据模型
    parser            CAD 图形解析层
    field_recognizer  字段智能识别
    matcher           字段-字段值智能配对 + 标题栏定位
    block_builder     块参照标准化生成
    engine            总控引擎
    logger            操作日志
    dwg_backend       .dwg 原生读取后端
"""

from .engine import RecognitionEngine
from .models import RecognitionResult, FieldPair
from .block_builder import BLOCK_NAME

__all__ = [
    "RecognitionEngine",
    "RecognitionResult",
    "FieldPair",
    "BLOCK_NAME",
]

__version__ = "1.0.0"

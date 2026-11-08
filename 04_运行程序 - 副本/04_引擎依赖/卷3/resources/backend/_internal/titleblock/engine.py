# -*- coding: utf-8 -*-
"""
engine.py
=========
总控引擎：串联\"解析 -> 识别 -> 配对 -> 块参照生成 -> 另存\"全流程。

对单张图纸的调用流程：
    1. parser.CADParser 读取 .dxf/.dwg，得到统一文字元素；
    2. field_recognizer.FieldRecognizer 判定每个元素是标签还是值；
    3. matcher.TitleBlockLocator 定位标题栏；matcher.Pairer 完成配对；
    4. block_builder.BlockBuilder 生成标准化块参照并把结果写入副本；
    5. 记录日志与统计，返回 RecognitionResult。

异常处理原则：
    - 文件损坏 / 格式不支持 -> 抛出带友好中文提示的异常，绝不静默崩溃；
    - 任何单步失败都记入日志问题统计，便于 180 天审计。
"""
from __future__ import annotations

import json
import os
import time
from typing import List, Optional, Tuple

from . import parser as parser_mod
from . import field_recognizer as fr_mod
from . import matcher as matcher_mod
from . import block_builder as bb_mod
from . import logger as logger_mod
from .models import (
    RecognitionResult,
    TextElement,
    FieldCandidate,
    FieldPair,
    Point,
)

import logging


class RecognitionEngine:
    """CAD 图框信息智能识读总控。"""

    def __init__(self, logger: Optional[logging.Logger] = None,
                 output_dir: str = "output"):
        # ---- 组装流水线各组件（见各模块 docstring） ----
        self.logger = logger or logger_mod.setup_logger("titleblock")
        self.parser_obj = parser_mod.CADParser()              # 解析层
        self.recognizer = fr_mod.FieldRecognizer()            # 字段识别
        self.locator = matcher_mod.TitleBlockLocator()        # 标题栏定位
        self.pairer = matcher_mod.Pairer()                    # 字段-值配对
        self.builder = bb_mod.BlockBuilder()                  # 块参照生成
        self.output_dir = output_dir                          # 副本输出目录

    # ------------------------------------------------------------------
    def process_file(self, src_path: str) -> RecognitionResult:
        """
        处理单个 CAD 文件（.dxf/.dwg），返回结构化识读结果。

        流程（对应需求三大核心任务）：
            解析(parser) -> 识别(recognizer) -> 定位(locator)
            -> 配对(pairer) -> 块参照生成+另存(builder)

        异常策略：解析/块生成失败抛出带友好中文提示的 RuntimeError；
        副作用：生成 `<原名>_recognized.<同格式>` 副本，原始文件保持不变。
        """
        t0 = time.time()  # 计时起点（性能要求：单文件 <= 1s 级）
        base = os.path.splitext(os.path.basename(src_path))[0]
        ext = os.path.splitext(src_path)[1].lower()  # 保持同格式扩展名

        self.logger.info(f"开始识读: {os.path.basename(src_path)}")

        # ---- 步骤1 解析：.dwg 先经后端转换，再由 ezdxf 统一读取 ----
        try:
            elements, doc = self.parser_obj.parse_document(src_path)
        except Exception as exc:
            # 记录问题统计并给出可操作的提示，而不是让程序崩溃
            self.logger.error(f"解析失败: {os.path.basename(src_path)} -- {exc}")
            raise RuntimeError(
                f"无法解析文件 {os.path.basename(src_path)}：{exc}\n"
                f"请确认文件为有效的 .dxf/.dwg，且已安装所需后端。"
            ) from exc

        # ---- 步骤2 字段识别：判定每个文字元素是标签还是值 ----
        candidates, label_counts = self.recognizer.recognize(elements)
        self.logger.info(
            f"  文字元素={len(elements)} 强标签={len(label_counts)}"
            f" 标签候选={len([c for c in candidates if c.label_score >= 1])}"
            f" 值候选={len([c for c in candidates if c.label_score == 0])}")

        # ---- 步骤3 标题栏定位（找不到标签簇则退化为全图包围盒） ----
        region = self.locator.locate(candidates, elements)
        if region is None:
            # 兜底：无标签时用全部文字的包围盒，保证流程仍能产出结果
            if elements:
                region = (min(e.x for e in elements),
                          min(e.y for e in elements),
                          max(e.x for e in elements),
                          max(e.y for e in elements))
            else:
                region = (0.0, 0.0, 10.0, 10.0)  # 空图纸的占位区域

        # ---- 步骤4 配对：标签-值自适应多方向配对 + 多行合并 ----
        pairs, unmatched = self.pairer.pair(candidates, region)
        matched = len([p for p in pairs if not (p.unmatched_label or p.unmatched_value)])
        empty = len([p for p in pairs if p.unmatched_value])
        self.logger.info(
            f"  标题栏区域={tuple(round(v,1) for v in region)} "
            f"配对={matched} 空值={empty} 未命名={len(unmatched)}")

        # ---- 步骤5 块参照生成 + 同格式另存（原稿不变） ----
        try:
            handle = self.builder.build(doc, pairs, unmatched, region)
        except Exception as exc:
            self.logger.error(f"块参照生成失败: {exc}")
            raise RuntimeError(f"块参照生成失败：{exc}") from exc

        os.makedirs(self.output_dir, exist_ok=True)
        dst = os.path.join(self.output_dir, f"{base}_recognized{ext}")
        try:
            saved = self.builder.save_copy(doc, src_path, dst, self.logger)
        finally:
            # 清理 .dwg -> .dxf 的临时转换文件与临时目录，避免长期运行磁盘堆积
            tmp = getattr(self.parser_obj, "last_converted_path", None)
            if tmp:
                try:
                    os.remove(tmp)
                    os.rmdir(os.path.dirname(tmp))
                except OSError:
                    pass
        self.logger.info(f"  输出: {os.path.basename(saved)}")

        # ---- 步骤6 组装结果与统计（供日志审计与自动化验收） ----
        result = RecognitionResult(
            source_file=src_path,
            pairs=pairs,
            unmatched=unmatched,
            all_labels=[k for k in label_counts],
            title_origin=Point(region[0], region[1]),  # 标题栏左下角=插入点
            title_block_handle=handle,
            title_region=region,
            stats={  # 识读时间/文字量/配对统计（满足日志审计需求）
                "text_elements": len(elements),
                "labels": len(label_counts),
                "matched_pairs": matched,
                "empty_values": empty,
                "unmatched": len(unmatched),
                "elapsed_s": round(time.time() - t0, 4),
                "output_file": saved,
            },
        )
        self.logger.info(
            f"识读完成: {os.path.basename(src_path)} 用时{result.stats['elapsed_s']}s "
            f"配对{matched}项 空值{empty}项")
        return result

    # ------------------------------------------------------------------
    def process_batch(self, files: List[str]) -> List[RecognitionResult]:
        """
        批量处理，返回结果列表；单文件失败不影响其它文件。

        失败的文件以空 RecognitionResult + stats['error'] 占位返回，
        便于上层(如 main.py)统一打印失败原因。
        """
        results: List[RecognitionResult] = []
        for f in files:
            try:
                results.append(self.process_file(f))
            except Exception as exc:
                # 隔离故障：记录日志并继续处理剩余文件（稳定性要求）
                self.logger.error(f"跳过失败文件 {os.path.basename(f)}: {exc}")
                placeholder = RecognitionResult(source_file=f)
                placeholder.stats = {"error": str(exc)}
                results.append(placeholder)
        return results

    # ------------------------------------------------------------------
    @staticmethod
    def write_result_json(result: RecognitionResult, path: str) -> None:
        """把结构化识读结果写入 JSON（UTF-8），便于自动化比对与验收。"""
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(result.to_dict(), fh, ensure_ascii=False, indent=2)

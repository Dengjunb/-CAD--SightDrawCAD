# -*- coding: utf-8 -*-
"""
field_recognizer.py
===================
字段智能识别模块（核心任务一）。

职责：
    1) 把标题栏区域内的每个文字元素判定为"字段标签(label)"或"字段值(value)"；
    2) 对标签做标准化（去空格、全半角统一、大小写归一），支持中英文混合；
    3) 采用**动态识别**：不依赖固定字段列表，通过语义规则+词表启发式
       判断一个文字片段更可能是"字段名"还是"字段值"；
    4) 输出"标签强信号分"，让配对阶段区分"必须作为标签"与"也可以作为值"，
       避免把"上模仁 / 张三"这类中文值一刀切成标签导致整行配对错位。

关键算法/原理：
    * 判定依据是多维度打分，而非单一规则：
        a) 是否为"已知字段关键词"（中文术语/英文缩写，可动态扩展的词表）；
        b) 是否命中"值模式"（数字、比例、日期、零件号、公差、材质码、重量等）；
        c) 文本格式特征（长度、是否含数字、是否全大写缩写等）。
    * 识别结果不再只有 label/value 两种硬判定：
        - label_score >= 2 : 强字段标签（材料、设计、QTY、TITLE...）
        - label_score == 1 : 疑似标签（中文短语但没有命中词表）
        - label_score == 0 : 无标签信号（绝大多数值属于此类）
      配对器只把 >=2 的文本当作"标签锚点"，其余文本仍然可以被当值使用，
      从而兼容"中文值被误判成标签"的真实图框。
    * 消歧：对标准化后相同的标签做合并，输出出现频率（供统计与审计）。
"""

from __future__ import annotations

import re
import unicodedata
from typing import List, Dict, Tuple

from .models import TextElement, FieldCandidate

# ---------------------------------------------------------------------------
# 词表（启发式，可扩展；识别不依赖它，仅作为强信号）
# ---------------------------------------------------------------------------
# 中文高频字段关键词（按工程图纸标题栏的常见写法整理，可继续追加）
CHINESE_LABEL_KEYWORDS = (
    "零件编号", "零件名称", "图纸编号", "图纸名称", "图档编号", "图号", "图名",
    "名称", "编号", "代号", "料号", "产品料号", "产品系列", "物料编号", "物料",
    "材料", "材质", "材料名称", "材料规格", "比例", "重量", "质量", "数量",
    "设计", "设计者", "设计日期", "审核", "审查", "核准", "校对", "批准",
    "批准者", "编制", "日期", "年月日", "版本", "版本号", "标记", "处数",
    "修改", "修改人", "修改日期", "修改标识", "变更原因", "签字", "签名",
    "文件号", "文件名", "单位", "单位名称", "公差", "未注公差", "全局公差",
    "角度公差", "尺寸公差", "表面粗糙度", "粗糙度", "表面处理", "热处理",
    "硬度", "备注", "工艺", "批次", "技术要求", "标题栏", "图样名称",
    "产品名称", "标准化", "旧底图总号", "新底图总号", "描图", "页码", "套数",
    "序号", "模具", "模号", "厂商", "客户", "机型", "投影", "视图", "张数",
    "底图", "图框", "制图", "绘图", "审核者", "设计者", "批准者",
)

# 英文/字母字段关键词（常见标题栏缩写；按单词边界匹配，避免误伤值）
ENGLISH_LABEL_KEYWORDS = (
    "PART", "NAME", "DWG", "DRAWING", "NO", "NUMBER", "MATL", "MATERIAL",
    "MAT", "SCALE", "QTY", "QUANTITY", "WT", "WEIGHT", "MASS", "DATE",
    "DES", "DESIGN", "DESIGNED", "DRN", "DRAWN", "CHK", "CHECK", "APP",
    "APPROVAL", "APPR", "REV", "REVISION", "TITLE", "UNIT", "TOL",
    "TOLERANCE", "MARK", "SIGN", "CUST", "CUSTOMER", "TYPE", "MODEL",
    "MOULD", "MOLD", "VENDOR", "PROCESS", "HARDNESS", "SURFACE", "FINISH",
    "TREATMENT", "TREAT", "HEAT", "STD", "SPEC", "EDITION", "FILE", "DIM",
    "REMARK", "NOTE", "SHEET", "MR", "ORIGIN", "PROJECT", "PAGE",
)

# 与值无关、常见的表格单元格内"非字段标签"的小词（避免把整表文字全当标签）
_INFORMAL_WORDS = {"Invisable", "invisable", "可见", "不可见", "见", "略"}

# ---------------------------------------------------------------------------
# 值模式（正则；命中任意一个 => 更像"字段值"）
# ---------------------------------------------------------------------------
_VALUE_PATTERNS = [
    # 比例： 1:1 、 1：2 、 1:1.5
    re.compile(r"^\d+\s*[:：]\s*\d+(\.\d+)?$"),
    # 纯数字 / 小数 / 负数 / 科学计数
    re.compile(r"^[+-]?\d[\d,.]*$"),
    re.compile(r"^[+-]?\d+\.\d+$"),
    # 带单位或直径/角度的数值： R0.2 、 %%c18 、 45# 、 HRA89-92
    re.compile(r"^(R\d|%|ϕ\d|∅\d)"),                          # noqa: W605
    re.compile(r"^\d+[\#号只件套个pcsPCS]$"),
    # 零件号 / 图号：字母开头含数字与连字符/下划线（如 TP36D00486-P23G）
    re.compile(r"^[A-Za-z]{1,8}[\d-]{2,}[A-Za-z0-9_/.-]*$"),
    # 日期： 2026-5-31 、 2026/5/31 、 2026.5.31
    re.compile(r"^\d{4}[-\/\.]\d{1,2}[-\/\.]\d{1,2}$"),
    re.compile(r"^\d{1,2}[-\/\.]\d{1,2}[-\/\.]\d{2,4}$"),
    # 版本号： V1.0 、 Rev.A 、 A2
    re.compile(r"^[VvRr][\d.]+\w*$"),
    # 硬度/材料： HRC60 、 HRA90 、 SKD11 、 45#钢 、 KD20
    re.compile(r"^(HRC|HRA|HRB)\d", re.IGNORECASE),
    re.compile(r"^[A-Z]{2,6}\d{1,3}[A-Z0-9-]*$"),
    # 重量（数字后带单位）
    re.compile(r"^\d+(\.\d+)?\s*(kg|Kg|g|KG|吨|t)$"),
    # 公差表： 0.00=0.01 、 ±0.01 、 .XX ±0.005
    re.compile(r"^[+-]?\d+(\.\d+)?\s*[=＝]\s*[+-]?\d+(\.\d+)?$"),
    re.compile(r"^[±%%][Pp]?\s*\d"),
    # 尺寸/角度数值（带小数或正负号、带度符号）
    re.compile(r"^\d+(\.\d+)?\s*[°º]"),
]

# ---------------------------------------------------------------------------
# 文本标准化辅助
# ---------------------------------------------------------------------------

def normalize_label(text: str) -> str:
    """
    标准化一个字段标签文字：全角转半角、去空白、去冒号、统一大小写。

    说明：标准化后用于标签合并/去重，同时保留原始文字以便回写。
    """
    if not text:
        return ""
    t = unicodedata.normalize("NFKC", text)
    t = t.replace(" ", "").replace("\u3000", "")
    t = t.rstrip(":：")
    t = t.strip()
    return t


def _has_han(text: str) -> bool:
    """是否包含汉字。"""
    return any(0x4E00 <= ord(ch) <= 0x9FFF for ch in text)


def _has_digit(text: str) -> bool:
    """是否包含阿拉伯数字（值模式的弱信号）。"""
    return any(ch.isdigit() for ch in text)


def _match_value_regex(text: str) -> bool:
    """判断文字是否命中任意一种"值模式"正则。"""
    for pat in _VALUE_PATTERNS:
        if pat.match(text):
            return True
    return False


def _keyword_label_score(text: str) -> int:
    """
    文字命中字段关键词的加分。返回 0~3。

    中文关键词按"包含"匹配（图纸里"修 改 人"会被去空格后再匹配），
    英文关键词按单词边界匹配，避免把 SKD11 / HERMES 这类材料牌号误判。
    """
    up = text.upper().strip(":： ").replace(" ", "")
    score = 0
    for kw in CHINESE_LABEL_KEYWORDS:
        if kw in text.replace(" ", ""):
            score = max(score, 3)
    if score:
        return score
    for kw in ENGLISH_LABEL_KEYWORDS:
        if re.search(r"(?<![A-Za-z])" + re.escape(kw) + r"(?![A-Za-z0-9])", up):
            score = max(score, 2)
    return score


class FieldRecognizer:
    """
    字段智能识别器：为文字元素打上 label/value 标签与标签强信号分。
    """

    def __init__(self, known_fields: Dict[str, str] = None):
        # 可注入的已知字段表：name -> 说明（用于消歧，非必需）
        self.known_fields = known_fields or {}

    # ------------------------------------------------------------------
    def classify(self, te: TextElement) -> Tuple[FieldCandidate, int]:
        """
        判定单个文字元素是"标签"还是"值"。

        返回：
            (FieldCandidate, 标签倾向分 label_score)
        """
        text = te.text
        norm = normalize_label(text)
        if not norm:
            return FieldCandidate(element=te, kind="unknown", normalized=norm), 0

        kw = _keyword_label_score(norm)
        is_value_pattern = _match_value_regex(text)
        has_cn = _has_han(norm)

        # 判定逻辑（动态识别核心）：
        #   - 命中强标签关键词（中/英）          => label（强信号）
        #   - 命中值模式且没有标签关键词         => value
        #   - 无明确信号时：
        #       * 含数字 / 命中值模式            => value
        #       * 纯中文短句（可能是没见过的新字段名，也可能是中文值）
        #                                       => 弱标签（kind=label, score=1），
        #                                          配对阶段仍允许它当值使用
        #       * 其它                           => value
        if kw >= 2:
            kind = "label"
            score = kw
        elif is_value_pattern:
            kind = "value"
            score = 0
        elif _has_digit(norm):
            kind = "value"
            score = 0
        elif has_cn and len(norm) <= 16:
            kind = "label"
            score = 1
        else:
            kind = "value"
            score = 0

        # 过滤明显的非字段噪音（如 Invisable 等表格辅助文字）
        if norm in _INFORMAL_WORDS and kw == 0:
            kind = "unknown"
            score = 0

        # 语义类型
        if score >= 2:
            sem = "label"
        elif is_value_pattern:
            sem = "value"
        elif has_cn:
            sem = "chinese"
        else:
            sem = "alnum"

        cand = FieldCandidate(
            element=te, kind=kind, normalized=norm, semantic_type=sem,
            label_score=score,
        )
        return cand, score

    # ------------------------------------------------------------------
    def recognize(self, elements: List[TextElement]) -> Tuple[List[FieldCandidate],
                                                              Dict[str, int]]:
        """
        对标题栏文字元素批量识别。

        返回：
            (候选列表, 标签统计 dict[label->计数])
        """
        candidates: List[FieldCandidate] = []
        label_counts: Dict[str, int] = {}
        for te in elements:
            cand, _kw = self.classify(te)
            candidates.append(cand)
            if cand.label_score >= 2:
                label_counts[cand.normalized] = label_counts.get(cand.normalized, 0) + 1
        return candidates, label_counts

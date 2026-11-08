# -*- coding: utf-8 -*-
"""
parser.py
=========
CAD 图形解析层。

职责：
    1) 通过 ezdxf 读取 .dxf 文档（.dwg 先经 dwg_backend 转换）；
    2) 把模型空间中的各种文字载体（TEXT / MTEXT / ATTRIB / 块内文字等）
       统一抽成 ``TextElement``，并转换为世界坐标(WCS)；
    3) 估算每个文字元素的宽度，供后续"多行合并 / 配对"使用；
    4) 保留图层、颜色等原始属性，供块参照生成时沿用。

技术说明（关键算法 / 原理）：
    * 块参照展开：INSERT 会把块定义里的文字平移到插入点并缩放/旋转。
      ezdxf 的 ``virtual_entities`` 返回已应用 INSERT 变换的虚拟实体，
      从而拿到真实世界坐标中的文字，是"合并零散图元"的第一步。
    * 坐标取插入点；对 MTEXT/TEXT/ATTRIB 统一用 ``dxf.insert``。
    * 文字清洗：去掉 MTEXT 的 DXF 控制码，还原 %%c/%%d 等转义符，
      并以换行符拼接"多行文字"，为后续"多行文本合并"打基础。
"""

from __future__ import annotations

import math  # noqa: F401 (保留用于宽度/坐标相关计算扩展)

from typing import List, Optional, Tuple

import ezdxf
from ezdxf.entities import DXFEntity

from .models import TextElement


# ---------------------------------------------------------------------------
# 文字清洗常量
# ---------------------------------------------------------------------------
# 常见的 DXF 特殊转义 -> 显示字符 映射（AutoCAD 的 %% 系列转义）
_TRANSLIT_FINAL = {"%%c": "\u2300", "%%d": "\u00b0", "%%p": "\u00b1", "%%%": "%"}


def _dxf_clean_mtext_text(text: str) -> str:
    """
    清洗 MTEXT 文本：移除 DXF 格式控制码，还原转义，合并多行。

    原理：MTEXT 可能包含 {\\F...|...;...} 字体串、\\A1; 对齐控制、\\P 硬换行等。
    这里删除控制前缀，把 \\P 转成换行，并还原 %% 转义为可读字符。
    """
    import re

    t: str = text or ""

    # 1) 去除内联格式串： {\\f字体|b0|i0|c...|p...;内容} -> 保留内容部分。
    def _strip_fmt(m):
        return m.group(1)

    # 匹配 {...} 组并提取内容（内容可能再含其它控制码，下一步统一清理）
    t = re.sub(r"\{\\?[fF][^{}]*;([^{}]*)\}", _strip_fmt, t)

    # 2) 删除残留的单字节控制码： \\H0.7901x; \\C3; \\A1; \\p 等
    t = re.sub(r"\\\\[A-Za-z0-9]+[.;]?", "", t)
    t = t.replace("{\\", "{").replace("}", "")

    # 3) 去掉对齐/方向控制码
    for pat in ("\\A1;", "\\A2;", "\\A0;", "\\p", "{\\", "}"):
        t = t.replace(pat, "")

    # 4) 硬换行 \\P -> 换行符，并还原 %% 转义为可读字符
    t = t.replace("\\P", "\n")
    for k, v in _TRANSLIT_FINAL.items():
        t = t.replace(k, v)

    # 5) 按行清理空白
    lines = [ln.strip() for ln in t.split("\n")]
    t = "\n".join(ln for ln in lines if ln)
    return t.strip()


def _dxf_clean_plain_text(text: str) -> str:
    """清洗普通 TEXT 文本：还原 DXF 转义并去除首尾空白。"""
    t = text or ""
    for k, v in _TRANSLIT_FINAL.items():
        t = t.replace(k, v)
    return t.strip()


def _estimate_text_width(text: str, height: float, chinese_ratio: float = 1.0) -> float:
    """
    估算一行文字的单位宽度（用于配对时的行跨度判断）。

    原理：拉丁字符/数字宽度约 0.6*字高，汉字约 1.0*字高，空格约 0.3*字高。
    用朴素累加模型近似，够用于"字段标签是否同行、值域是否够宽"等判断。
    """
    if not text or height <= 0:
        return 0.0
    w = 0.0
    for ch in text:
        code = ord(ch)
        if 0x4E00 <= code <= 0x9FFF or 0x3000 <= code <= 0x303F:
            w += chinese_ratio * height
        elif ch == " ":
            w += 0.3 * height
        else:
            w += 0.6 * height
    return w


def _extract_text_content(entity: DXFEntity, is_mtext: bool) -> str:
    """从 ezdxf 实体中提取并清洗文字内容。

    原理：ezdxf 的 ``MTEXT.plain_text()`` 能正确去掉 MTEXT 内联格式码
    （如 {\\fSimSun|b0|i0|c134|p2;...}、\\H0.7901x; 等），返回纯文字；
    对普通 TEXT 则直接取 ``dxf.text`` 并做 DXF 转义还原。优先用 plain_text，
    失败时回退到自写清洗函数，保证兼容性。
    """
    if is_mtext:
        # 优先用 ezdxf 的 plain_text() 剥离格式码
        plain = getattr(entity, "plain_text", None)
        if callable(plain):
            try:
                return _dxf_clean_mtext_text(str(plain()))
            except Exception:
                pass
        raw = getattr(entity.dxf, "text", "") or ""
        return _dxf_clean_mtext_text(str(raw))
    raw = getattr(entity.dxf, "text", "") or ""
    return _dxf_clean_plain_text(str(raw))


def _entity_insert_point(entity: DXFEntity) -> Optional[Tuple[float, float]]:
    """取得实体文字插入点（世界坐标）。"""
    ins = getattr(entity.dxf, "insert", None)
    if ins is None:
        return None
    try:
        if hasattr(ins, "x"):
            return (float(ins.x), float(ins.y))
        return (float(ins[0]), float(ins[1]))
    except Exception:
        return None


class CADParser:
    """CAD 图纸解析器：把 .dxf/.dwg 读取为结构化文字元素集合。"""

    def __init__(self, default_height: float = 2.5):
        self.default_height = default_height
        self._doc = None
        # 缓存"内部无文字"的块名：同名块的大量 INSERT 只需检查一次（性能优化）
        self._blocks_without_text = set()
        # .dwg 转出来的临时 .dxf 路径（供上层在保存后清理，避免临时目录堆积）
        self.last_converted_path = None

    # ------------------------------------------------------------------
    def _height_of(self, entity: DXFEntity, style_map: dict) -> float:
        """解析字高，0 时用文字样式默认高度兜底。

        MTEXT 的字高属性名是 char_height，TEXT 才是 height；两者都取不到时
        才回退文字样式的默认高度，避免把多行文字一律当成 2.5 高。
        """
        h = getattr(entity.dxf, "char_height", 0) or getattr(entity.dxf, "height", 0) or 0
        if h <= 0:
            style = getattr(entity.dxf, "style", "Standard")
            info = style_map.get(str(style), {})
            h = float(info.get("height", 0) or 0)
        return float(h) if h > 0 else float(self.default_height)

    # ------------------------------------------------------------------
    def parse_document(self, path: str) -> Tuple[List[TextElement], object]:
        """
        解析文件，返回 (TextElement 列表, ezdxf 文档对象)。

        参数:
            path : .dxf 或 .dwg 路径

        返回:
            text_elements : 统一文字元素列表（按 y 降序、x 升序排序）
            doc           : ezdxf Document（供块参照生成/另存使用）
        """
        self.last_converted_path = None
        if str(path).lower().endswith(".dwg"):
            from .dwg_backend import convert_dwg_to_dxf
            converted = convert_dwg_to_dxf(path)
            if os.path.abspath(converted) != os.path.abspath(path):
                self.last_converted_path = converted
            path = converted

        doc = ezdxf.readfile(path)
        self._doc = doc
        self._blocks_without_text = set()  # 每个文档重置缓存
        msp = doc.modelspace()

        # 文字样式 -> 默认高度 映射（ezdxf 的样式表用 .entries 字典访问）
        style_map = {}
        entries = getattr(doc.styles, "entries", {}) or {}
        for st_name, st in entries.items():
            try:
                style_map[str(st_name)] = {
                    "height": float(getattr(st.dxf, "height", 0) or 0)
                }
            except Exception:
                style_map[str(st_name)] = {"height": 0.0}

        elements: List[TextElement] = []
        seen = set()

        for e in msp:
            etype = e.dxftype()
            if etype in ("TEXT", "MTEXT"):
                self._take_text(e, etype, elements, seen, style_map)
            elif etype == "INSERT":
                self._take_insert(e, elements, seen, style_map)

        elements.sort(key=lambda t: (-t.y, t.x))
        return elements, doc

    # ------------------------------------------------------------------
    def _take_text(self, e, etype, elements, seen, style_map) -> None:
        """收取一个直接文字实体。"""
        handle = str(getattr(e.dxf, "handle", "") or "")
        key = ("direct", handle or id(e))
        if key in seen:
            return
        seen.add(key)
        is_mtext = etype == "MTEXT"
        content = _extract_text_content(e, is_mtext)
        if not content:
            return
        pt = _entity_insert_point(e)
        if pt is None:
            return
        h = self._height_of(e, style_map)
        color_idx = int(getattr(e.dxf, "color", 256) or 256)
        true_color = getattr(e.dxf, "true_color", None)
        te = TextElement(
            text=content,
            raw_text=content,
            x=float(pt[0]), y=float(pt[1]),
            height=h,
            layer=str(getattr(e.dxf, "layer", "0") or "0"),
            style=str(getattr(e.dxf, "style", "STANDARD") or "STANDARD"),
            is_mtext=is_mtext,
            handle=handle,
            entity_type=etype,
            color_info=(color_idx, true_color),
            width=_estimate_text_width(content.split("\n")[0], h),
        )
        elements.append(te)

    # ------------------------------------------------------------------
    def _take_insert(self, ins, elements, seen, style_map) -> None:
        """
        展开一个 INSERT 块参照，取出内部文字并统一到世界坐标。

        原理与优化：
            1) ezdxf 中正确的展开入口是 INSERT 实体自身的 ``virtual_entities()``，
               它会自动应用平移/缩放/旋转变换，返回世界坐标下的虚拟实体；
            2) 大量符号块（箭头 _CLOSEDFILLED、圆点 _Open30 等）内部没有文字，
               先扫描块定义发现无 TEXT/MTEXT/ATTDEF 时直接跳过，避免无谓展开
               （实测可跳过 90%+ 的 INSERT，显著提速）；
            3) 块内 ATTDEF（属性定义）也承载文字信息（"块参照"类标题栏的关键），
               一并提取；
            4) 用 (块名, 插入点, 实体句柄) 组合键去重，防止重复计入。
        """
        block_name = str(getattr(ins.dxf, "name", "*Model_Space") or "*Model_Space")
        ins_pt = _entity_insert_point(ins)
        # --- 优化：块定义内无文字实体则跳过（符号块占绝大多数） ---
        if block_name in self._blocks_without_text:
            return
        blk = self._doc.blocks.get(block_name)
        if blk is None:
            return

        # 使用 INSERT 自身的 virtual_entities() 正确应用变换
        try:
            vlist = list(ins.virtual_entities())
        except Exception:
            self._blocks_without_text.add(block_name)  # 展开失败按无文字处理
            return

        # 从虚拟实体中筛出文字类型；若整块都无文字则缓存跳过标记
        # 块参照自带的属性值(ATTRIB)不在 virtual_entities() 里，它们挂在 INSERT
        # 实体自身；先收集，用于覆盖同名 ATTDEF 的默认文字。
        attrib_values = {}
        for attrib in getattr(ins, "attribs", []):
            tag = str(getattr(attrib.dxf, "tag", "") or "").strip()
            val = _dxf_clean_plain_text(str(getattr(attrib.dxf, "text", "") or ""))
            if tag and val:
                attrib_values[tag] = attrib

        text_entities = [(v, v.dxftype()) for v in vlist
                         if v.dxftype() in ("TEXT", "MTEXT", "ATTDEF")]
        # 同一 tag 已有 ATTRIB 实际值时，ATTDEF 的默认值不再单独计入（否则标签与值重复）
        text_entities = [
            (v, t) for (v, t) in text_entities
            if not (t == "ATTDEF"
                    and str(getattr(v.dxf, "tag", "") or "").strip() in attrib_values)
        ]
        if not text_entities and not attrib_values:
            self._blocks_without_text.add(block_name)
            return

        try:
            sx = float(getattr(ins.dxf, "xscale", 1.0) or 1.0)
        except Exception:
            sx = 1.0

        for v, vtype in text_entities:
            handle = str(getattr(v.dxf, "handle", "") or "")
            key = ("blk", block_name, ins_pt, handle if handle else id(v))
            if key in seen:
                continue
            seen.add(key)
            is_mtext = vtype == "MTEXT"
            content = _extract_text_content(v, is_mtext)
            if not content:
                continue
            pt = _entity_insert_point(v)
            if pt is None:
                continue
            h = self._height_of(v, style_map)
            # 块参照整体缩放时字高按 x 缩放因子校正
            if sx > 0 and abs(sx - 1.0) > 1e-6:
                h *= abs(sx)
            te = TextElement(
                text=content, raw_text=content,
                x=float(pt[0]), y=float(pt[1]),
                height=max(h, 1e-3),
                layer=str(getattr(v.dxf, "layer", "0") or "0"),
                style=str(getattr(v.dxf, "style", "STANDARD") or "STANDARD"),
                is_mtext=is_mtext,
                owner_block=block_name,
                insert_owner=str(getattr(ins.dxf, "handle", "") or ""),
                handle=handle,
                entity_type=vtype,
                color_info=(int(getattr(v.dxf, "color", 256) or 256),
                            getattr(v.dxf, "true_color", None)),
                width=_estimate_text_width(content.split("\n")[0], h),
            )
            elements.append(te)

        # --- 提取块属性实际值（ATTRIB）---
        # 这是"带属性的图框"最常见的数据载体：标签在块定义里，值由块参照的
        # ATTRIB 提供。原实现只读了 ATTDEF，导致这类图框的值全部丢失。
        for tag, attrib in attrib_values.items():
            content = _dxf_clean_plain_text(str(getattr(attrib.dxf, "text", "") or ""))
            pt = _entity_insert_point(attrib)
            if not content or pt is None:
                continue
            h = self._height_of(attrib, style_map)
            elements.append(TextElement(
                text=content, raw_text=content,
                x=float(pt[0]), y=float(pt[1]),
                height=max(h, 1e-3),
                layer=str(getattr(attrib.dxf, "layer", "0") or "0"),
                style=str(getattr(attrib.dxf, "style", "STANDARD") or "STANDARD"),
                is_mtext=False,
                owner_block=block_name,
                insert_owner=str(getattr(ins.dxf, "handle", "") or ""),
                handle=str(getattr(attrib.dxf, "handle", "") or ""),
                entity_type="ATTRIB",
                color_info=(int(getattr(attrib.dxf, "color", 256) or 256),
                            getattr(attrib.dxf, "true_color", None)),
                width=_estimate_text_width(content.split("\n")[0], h),
            ))

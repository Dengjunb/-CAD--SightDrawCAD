# -*- coding: utf-8 -*-
"""
block_builder.py
================
块参照标准化生成模块（核心任务三）。

职责：
    1) 在文档中新建统一命名块 ``TitleBlock_Standardized``；
    2) 把每一对"字段标签->字段值"创建为一个块属性(属性定义 ATTDEF)，
       插入点取标题栏左下角（即块参照插入原点）；
    3) 未匹配内容也纳入块参照：有值无标签 -> 标签记为 ``Unmatched_label``；
       有标签无值 -> 值记为 ``Unmatched_value``；
    4) 保留原始图层、颜色、线型等属性；原稿保持不变，另存新文件（同格式）。

关键算法/原理：
    * 用 ezdxf 的 ``add_block`` 建块定义，再用 ``add_blockref`` 加块参照。
    * 属性用 ``add_attdef``（属性定义）放在块布局内，块参照引用后即为
      ``ATTRIB`` 可见属性，符合"块属性动态根据识别结果创建"的需求。
    * 保存：.dxf 直接由 ezdxf 写出；.dwg 通过 ezdwg 的 to_dwg 转换回二进制。
      原始文件始终不修改。
"""

from __future__ import annotations

import os
from typing import Dict, List, Tuple

import ezdxf

from .models import RecognitionResult, FieldPair, Point
from .dwg_backend import DWGBackendError

# 标准化块名称（需求固定命名）
BLOCK_NAME = "TitleBlock_Standardized"
# 未匹配标记名
UNMATCHED_LABEL = "Unmatched_label"
UNMATCHED_VALUE = "Unmatched_value"


class BlockBuilder:
    """把配对结果写成标准化块参照并另存新图。"""

    # ------------------------------------------------------------------
    @staticmethod
    def _title_origin(region: Tuple[float, float, float, float]) -> Point:
        """标题栏左下角即块参照插入点（region = xmin,ymin,xmax,ymax）。"""
        return Point(region[0], region[1])

    # ------------------------------------------------------------------
    def build(self, doc, pairs: List[FieldPair],
              unmatched: List[FieldPair],
              region: Tuple[float, float, float, float]) -> str:
        """
        在主文档中创建标准化块参照，返回其句柄。

        参数:
            doc      : ezdxf 文档
            pairs    : 配对成功的字段对
            unmatched: 未配对内容
            region   : 标题栏包围盒

        返回:
            块参照实体句柄

        改进（v1.1）：
            * 属性标记(Tag)保证唯一：同名字段自动追加 _2/_3，避免 DXF 中
              重复 Tag 导致 AutoCAD 只认第一个属性；
            * 属性插入点改为"相对标题栏左下角的原始位置"，块参照插入后属性
              仍落在对应字段的格子里，而不是排成一条斜线（可读性/可核对性）；
            * 同位置属性做微小错位，避免完全重叠。
        """
        # 若同名块已存在先删除，保证幂等
        if BLOCK_NAME in doc.blocks:
            doc.blocks.delete_block(BLOCK_NAME, safe=False)
        blk = doc.blocks.new(BLOCK_NAME)
        origin = self._title_origin(region)

        # 收集属性（名称、值、相对插入点）——配对结果优先，未匹配项随后
        attrs: List[Tuple[str, str, float, float]] = []
        used_names: Dict[str, int] = {}

        def unique_tag(base: str) -> str:
            """生成块内唯一属性 Tag（AutoCAD 要求同一块属性名不重复）。"""
            tag = base
            n = used_names.get(base, 0)
            if n:
                tag = f"{base}_{n + 1}"
            used_names[base] = n + 1
            return tag

        def add_attr(name: str, val: str, pos: Point) -> None:
            x = round(pos.x - origin.x, 4)
            y = round(pos.y - origin.y, 4)
            attrs.append((unique_tag(name), val, x, y))

        for p in pairs:
            name = (p.label or UNMATCHED_LABEL).strip() or UNMATCHED_LABEL
            add_attr(name, p.value or UNMATCHED_VALUE, p.label_position)

        for p in unmatched:
            name = UNMATCHED_LABEL if p.unmatched_label else (p.label or UNMATCHED_LABEL)
            pos = p.value_position if p.unmatched_label else p.label_position
            add_attr(name, p.value or UNMATCHED_VALUE, pos)

        # 属性定义放进块布局（插入点 = 原始字段位置相对标题栏左下角）
        placed: Dict[Tuple[float, float], int] = {}
        for name, val, x, y in attrs:
            key = (round(x, 3), round(y, 3))
            if key in placed:  # 同位置轻微错位，避免完全重叠
                offset = placed[key] + 1
                x += 0.6 * offset
                y -= 0.6 * offset
            placed[key] = placed.get(key, 0) + 1
            blk.add_attdef(name, insert=(x, y, 0), text=val, dxfattribs={
                "height": 2.5,
                "layer": "0",
                "color": 7,
            })

        # 在模型空间插入块参照，插入点为标题栏左下角
        msp = doc.modelspace()
        # attribs_follow=1 标记该 INSERT 后随带属性，保证 AutoCAD/ezdxf 正确写入
        blockref = msp.add_blockref(BLOCK_NAME, origin.as_tuple(), dxfattribs={
            "layer": "0",
        })
        blockref.dxf.attribs_follow = 1
        # 逐个为块参照创建可见属性(ATTRIB)，位置与块内属性定义一致
        placed = {}
        for name, val, x, y in attrs:
            key = (round(x, 3), round(y, 3))
            if key in placed:
                offset = placed[key] + 1
                x += 0.6 * offset
                y -= 0.6 * offset
            placed[key] = placed.get(key, 0) + 1
            blockref.add_attrib(name, val, insert=(x, y, 0),
                                dxfattribs={"height": 2.5, "layer": "0", "color": 7})
        return str(blockref.dxf.handle or "")

    # ------------------------------------------------------------------
    @staticmethod
    def save_copy(doc, src_path: str, dst_path: str, logger=None) -> str:
        """
        把修改后的文档另存为新文件，保留原稿不变。

        规则：
            - 输入 .dxf -> 输出 .dxf；
            - 输入 .dwg -> 先存临时 .dxf，再用 ezdwg.to_dwg 转回 .dwg；
              若转换后端不可用则回退保存 .dxf 并告警。

        返回实际保存的路径。
        """
        from .dwg_backend import convert_dxf_to_dwg

        os.makedirs(os.path.dirname(os.path.abspath(dst_path)), exist_ok=True)
        src_ext = os.path.splitext(src_path)[1].lower()
        if src_ext == ".dxf":
            # 输入是 dxf：直接同格式另存
            doc.saveas(dst_path)
            return dst_path
        # 输入是 .dwg：先存临时 .dxf（编辑结果），再用后端转回 .dwg 实现"同格式另存"
        tmp_dxf = dst_path + ".tmp.dxf"
        doc.saveas(tmp_dxf)
        dwg = convert_dxf_to_dwg(tmp_dxf, dst_path)
        if dwg is not None and os.path.exists(dwg):
            if os.path.exists(tmp_dxf):  # 清理临时 dxf
                try:
                    os.remove(tmp_dxf)
                except OSError:
                    pass
            return dwg
        # 无 .dwg 写后端 -> 回退保存 .dxf 并告警（保留原始 .dwg 不变）
        fallback = os.path.splitext(dst_path)[0] + ".dxf"
        if os.path.exists(fallback):
            os.remove(fallback)
        os.replace(tmp_dxf, fallback)
        if logger is not None:
            logger.warning(
                "未找到 .dwg 写后端（ODA File Converter / AutoCAD COM），"
                f"已将结果保存为同内容的 .dxf：{os.path.basename(fallback)}")
        return fallback
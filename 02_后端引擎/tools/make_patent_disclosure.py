# -*- coding: utf-8 -*-
"""
make_patent_disclosure.py
=========================
按既有《专利申请技术交底书》模板（8 行表格）生成新交底书，不改变模板结构。

原则：
    * 模板从 templates/专利技术交底书模板.docx 复制，表格 8 行、标签列、页面设置原样保留；
    * 只填写右列内容与页眉处的名称/联系人占位，不增删行、不改标签；
    * 实测数字、附图与实施例均来自 v2.1 工程，可直接作为专利素材。

用法：
    python tools/make_patent_disclosure.py --out "out/专利材料/专利技术交底书-图纸图像矢量化.docx"
"""
from __future__ import annotations

import argparse
import os
from typing import List

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.shared import Cm, Pt

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATE = os.path.join(ROOT, "templates", "专利技术交底书模板.docx")
FIG_DIR = os.path.join(ROOT, "out", "专利材料", "附图")
TITLE = "一种基于文字区掩膜与栅格自检的图纸图像矢量化及字段闭环方法及系统"


def set_font(run, name: str = "宋体", size: float = 10.5, bold: bool = False) -> None:
    run.font.name = name
    rpr = run._element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        from docx.oxml import OxmlElement
        rfonts = OxmlElement("w:rFonts")
        rpr.append(rfonts)
    rfonts.set(qn("w:ascii"), name)
    rfonts.set(qn("w:hAnsi"), name)
    rfonts.set(qn("w:eastAsia"), name)
    run.font.size = Pt(size)
    run.font.bold = bold


def clear_cell(cell) -> None:
    for p in list(cell.paragraphs):
        p._element.getparent().remove(p._element)


def add_para(cell, text: str, bold: bool = False, size: float = 10.5,
             align=WD_ALIGN_PARAGRAPH.JUSTIFY, first_indent: bool = True,
             space_after: float = 3):
    p = cell.add_paragraph()
    p.alignment = align
    p.paragraph_format.line_spacing = 1.25
    p.paragraph_format.space_after = Pt(space_after)
    if first_indent:
        p.paragraph_format.first_line_indent = Pt(size * 2)
    run = p.add_run(text)
    set_font(run, "宋体", size, bold)
    return p


def add_heading(cell, text: str):
    return add_para(cell, text, bold=True, size=11, first_indent=False, space_after=4)


def fill_header(doc) -> None:
    for p in doc.paragraphs:
        text = p.text.strip()
        if text.startswith("发明/发明名称"):
            if p.runs:
                p.runs[0].text = "发明/发明名称：" + TITLE
                for extra in p.runs[1:]:
                    extra.text = ""
            else:
                p.add_run("发明/发明名称：" + TITLE)
        elif text.startswith("交底书撰写人"):
            if p.runs:
                p.runs[0].text = "交底书撰写人：邓钧宝（网络空间安全 · 2025级）"
            else:
                p.add_run("交底书撰写人：邓钧宝（网络空间安全 · 2025级）")
        elif text.startswith("固定电话"):
            if p.runs:
                p.runs[0].text = "固定电话：          移动电话：17876920447"
                for extra in p.runs[1:]:
                    extra.text = ""
            else:
                p.add_run("固定电话：          移动电话：17876920447")
        elif text.startswith("传真"):
            if p.runs:
                p.runs[0].text = "传真：                邮箱：3157758997@qq.com"
                for extra in p.runs[1:]:
                    extra.text = ""
            else:
                p.add_run("传真：                邮箱：3157758997@qq.com")


def fill_table(doc) -> None:
    table = doc.tables[0]
    rows = table.rows

    # 0 发明名称
    c = rows[0].cells[1]
    clear_cell(c)
    add_para(c, TITLE, bold=True, size=12, align=WD_ALIGN_PARAGRAPH.LEFT, first_indent=False)

    # 1 所属技术领域
    c = rows[1].cells[1]
    clear_cell(c)
    add_para(c, "本发明属于计算机辅助设计（CAD）数据处理、图像处理与图纸信息结构化技术领域，"
                "具体涉及一种将扫描件、手机照片等栅格图纸图像转换为可编辑 DXF 图形、并在同一流程中"
                "完成文字识别、质量自检与图框字段闭环的方法、系统及计算机可读存储介质。")
    add_para(c, "本发明可应用于制造企业的图纸数字化归档、PDM/ERP/MES 基础数据导入、CAD 教学实训、"
                "以及仅有图片、没有原始矢量文件的图纸再利用场景。")

    # 2 背景技术
    c = rows[2].cells[1]
    clear_cell(c)
    add_heading(c, "一、技术背景与需求")
    add_para(c, "二维 CAD 图纸是制造业最普遍的信息载体。存量图纸中有大量只有扫描件、手机照片或 PDF 截图的情况，"
                "既没有 DXF/DWG 源文件，也无法直接提取标题栏字段。制造企业要想把这些图纸用于 PDM、ERP、MES，"
                "通常只能“先照着描一遍图、再手工抄一遍字段”，成本高、易串位、无法审计。")
    add_heading(c, "二、现有技术的方案与缺点")
    add_para(c, "（1）通用 OCR：能识别文字，但不理解 CAD 结构，不会把文字落成 DXF 实体，也不会生成标题栏标准化块；"
                "识别结果与图形之间没有几何对应关系。")
    add_para(c, "（2）通用图像矢量化工具：用边缘/Hough 变换提取线段，但把汉字笔画当成几十条短线段，"
                "一个矩形框被拆成四条互不相连的线；缺少横平竖直吸附、端点闭合与闭合矩形重建，导入 CAD 后无法作为边界使用。")
    add_para(c, "（3）以深度网络为代表的图像转矢量方案：需要大量标注样本与 GPU 训练，模型体积大、不可解释，"
                "在只有 CPU 的办公电脑上难以部署；输出结果缺少可量化的质量指标，出错后无法定位到具体处理步骤。")
    add_para(c, "（4）现有工具普遍缺少“可信度”：矢量结果是否漏画、多画，只能靠肉眼；缺少与输入墨迹逐像素比对的"
                "量化指标，也没有把质量分数反馈到参数调整的机制。")
    add_para(c, "（5）自动与人工脱节：全自动一旦参数不合适只能整条重跑；无法在每一步暂停、查看中间结果、"
                "修改参数后只重算受影响的部分，真实图纸的“最后一公里”仍靠人工返工。")
    add_heading(c, "三、问题产生的原因")
    add_para(c, "上述问题的根源在于：图纸图像中“文字”与“几何”是同一像素集合，现有矢量化方法没有先区分二者；"
                "同时缺少从像素到 CAD 语义（闭合轮廓、图层、文字实体）的重建规则，以及从矢量结果回到像素的"
                "可验证闭环。因此需要一种“先保护文字、再重建几何、最后用栅格自检验证”的一体化方法。")

    # 3 发明目的
    c = rows[3].cells[1]
    clear_cell(c)
    add_para(c, "本发明的目的在于提供一种基于文字区掩膜与栅格自检的图纸图像矢量化及字段闭环方法及系统，"
                "以至少解决以下技术问题：")
    for text in [
        "（1）在不依赖深度学习模型的前提下，将图纸图像中的文字笔画与工程几何分离，避免文字被误检为大量线段；",
        "（2）把散乱线段重建为可编辑的闭合矩形、圆与直线，并完成横平竖直吸附与端点闭合，使 DXF 可直接用于 CAD 编辑；",
        "（3）把 OCR 识别到的文字落成 DXF 的真实 TEXT 实体，使图片生成的 DXF 能被标题栏识读引擎继续处理，"
        "形成“图片 → CAD → 字段”的闭环；",
        "（4）给出与输入墨迹逐像素比对的量化质量指标（精确率、召回率、F1、贴合偏差），使结果可验收、参数可对比；",
        "（5）支持自动与手动分步两种作业方式：手动模式可在阶段之间暂停、查看结果、修改参数，并只重算受影响的阶段。",
    ]:
        add_para(c, text)

    # 4 技术方案简介
    c = rows[4].cells[1]
    clear_cell(c)
    add_para(c, "本发明提供一种基于文字区掩膜与栅格自检的图纸图像矢量化及字段闭环方法，其核心在于："
                "先检测文字区并生成掩膜，使文字笔画不参与几何提取；再在掩膜后的二值图上完成直线、圆与闭合矩形的重建；"
                "随后把 OCR 文字落成 DXF 实体，并用矢量重绘与输入墨迹的逐像素比对给出质量分数；"
                "最后可选地把 DXF 交给标题栏识读引擎，得到字段与标准化块。方法包括以下步骤：")

    steps = [
        ("S1 图像接入与尺度归一化",
         "读取 PNG/JPG/BMP/TIF 等栅格图像并转为 8 位灰度；当图像长边超过设定阈值（如 2600 px）时按长边等比缩放，"
         "保持宽高比不变；记录原始尺寸与处理尺寸。按图幅宽度（如 A4 横向 297 mm）或扫描 DPI 计算比例因子 s，"
         "使后续像素坐标可一次性换算为毫米坐标。"),
        ("S2 文字区检测与掩膜保护",
         "对二值图做连通域分析，按以下特征筛选字形候选：连通域高度处于笔画宽度 w 的 3～30 倍、面积占比处于"
         "全图的设定区间、填充率处于 10%～92%、最大内切圆半径不小于 0.35w；将候选按行聚类（纵向重叠、横向间距"
         "小于设定阈值）得到文字行框；对文字框向外膨胀 2～3w 生成文字掩膜 M_text。在直线/圆检测前把 M_text 区域"
         "置零，并在检测后按采样点再次剔除“整条落在文字区”的线段（采样点落入掩膜比例超过 55% 即剔除）。"),
        ("S3 二值化、纠偏、去噪与断线闭合",
         "同时计算全局 Otsu 与局部自适应阈值结果；以“自适应找回墨迹量 / Otsu 墨迹量”的比值在 1.03～2.5 之间"
         "选择自适应结果，否则采用 Otsu；去噪采用保边双边滤波，避免固定 3×3 中值滤波抹掉 1 像素中心线；"
         "对长直线做 Hough 变换，按线段长度加权取角度中位数作为整体倾角，限 ±15° 内反向旋转纠偏；"
         "按连通域面积占比去除噪点，并用形态学闭运算连接断线。"),
        ("S4 几何提取与语义重建",
         "在掩膜后的二值图上用概率 Hough 提取线段，阈值、最短线长与最大断口均按图像长边自适应；"
         "按角度差、法向距离与投影间隙三条件合并共线线段；对与水平/垂直夹角小于设定容差（如 2°）的线段做"
         "横平竖直吸附；对端点做空间哈希邻域吸附，使 T 形接点闭合；用缩小图上的 HoughCircles 检测圆，"
         "并以圆周支撑率（圆周采样点落在墨迹上的比例）与 24 扇区覆盖率过滤假圆，随后删除两端均在圆周上的"
         "“圆的弦”线段；在整理后的线段集合中枚举横边对与竖边对，按“覆盖关系”而非端点相等判断四条边是否"
         "闭合，合成闭合矩形并输出为闭合 LWPOLYLINE。"),
        ("S5 文字识别与 DXF 生成",
         "对预处理后的灰度图调用系统 OCR（如 Windows.Media.Ocr 中文引擎），得到文字行文本框与文本；"
         "清洗汉字之间的空格、全角标点与常见连字符误识；按像素坐标把文字落成 DXF 的 TEXT 实体，字高取 0.72 倍行高；"
         "将线段、圆、闭合矩形写入“轮廓”图层，文字区框与 TEXT 写入“文字区”图层；像素坐标按 X=x·s、"
         "Y=(H−y)·s 一次性换算为毫米坐标，并写入 DXF 单位与图层信息。"),
        ("S6 栅格自检与质量反馈",
         "把生成的矢量结果重新栅格化为二值图；以“去噪二值图减去文字掩膜”作为目标墨迹；对目标与预测分别膨胀"
         "设定像素（如 3 px）后计算精确率 P（预测落在目标附近的比例）、召回率 R（目标被预测覆盖的比例）、"
         "F1=2PR/(P+R) 与双向平均最近距离 chamfer；当 F1 低于阈值时，提示调整最短线段、断线合并、去噪强度或"
         "文字区保护开关，并可用同一指标比较不同参数。"),
        ("S7 图框字段闭环（可选）",
         "把 S5 生成的 DXF 输入标题栏识读引擎：引擎解析 TEXT/MTEXT/块内文字与 ATTRIB，判定字段标签与字段值，"
         "在自适应定位的标题栏区域内完成行聚类与全局指派配对，输出字段-值对，并生成属性唯一的标准化块参照；"
         "识别结果回填到本次运行的报告与界面。该步骤使“只有图片”的图纸一次操作得到可编辑 DXF 与结构化字段。"),
        ("S8 自动/手动分步控制（从属技术方案）",
         "将 S1～S7 组织为 9 个可暂停阶段：读取、预处理、直线、圆、矩形、OCR、DXF、质量自检、识读联动；"
         "每个阶段结束落盘中间结果并暂停，用户可查看截图与指标、修改参数；系统按参数与阶段的映射关系"
         "（如二值化/去噪对应预处理、最短线段对应直线、图幅对应 DXF）确定最早受影响的阶段，"
         "从该阶段重跑并清空其后结果，避免新旧结果混用。"),
    ]
    for title, body in steps:
        add_heading(c, title)
        add_para(c, body)

    add_heading(c, "系统组成")
    add_para(c, "实现上述方法的系统包括：图像接入与归一化模块、文字区检测与掩膜模块、二值化与纠偏模块、"
                "几何提取与重建模块、OCR 与 DXF 写出模块、栅格自检模块、图框识读闭环模块、"
                "自动/手动分步控制模块，以及运行结果与证据落盘模块。各模块可由同一计算设备执行，"
                "也可分布在局域网内的多台设备上；本发明还提供包含上述方法指令的计算机可读存储介质。")

    # 5 有益效果
    c = rows[5].cells[1]
    clear_cell(c)
    add_para(c, "与现有技术相比，本发明具有以下优点和技术效果（以下数据来自 2200×1600 演示图的真实运行）：")
    effects = [
        "（1）文字不再被误检为线段。关闭文字区保护时，干净图检测到 92 条线段，其中 40 条落在文字框内；"
        "开启保护后为 54 条，仅 3 条长度小于 40 px 的短假线，主干线不受影响；像素级 F1 由 0.919 提升到 0.987。",
        "（2）几何可直接在 CAD 中使用。干净图重建 54 条线段、4 个圆、28 个闭合矩形（含标题栏 5×4 表格的"
        "20 个单元格与 3 个主轮廓），矩形在 DXF 中是闭合 LWPOLYLINE，而不是四条散线。",
        "（3）结果可量化验收。干净图像素还原 F1=0.99（P=1.00、R=0.97、贴合偏差 0.79 px），"
        "拍照图 F1=0.97（P=0.97、R=0.97、0.72 px）；与真值几何比对，主要直线召回率 94.3%，"
        "干净图误检 0 条、拍照图 2 条。",
        "（4）图片可直接得到字段。干净图 OCR 识别 16 行/71 字，联动识读配对 5 项字段"
        "（零件名称、材料、设计、审核、日期），并输出带 8 个属性的标准化块；拍照图 OCR 14 行，配对 4 项（含图号）。",
        "（5）速度适合办公电脑。干净图整链 2.5 秒、拍照图 4.2 秒（含 OCR、DXF 与报告），"
        "无需 GPU、无需联网，原始图像不被修改。",
        "（6）自动/手动一致且可回退。同一干净图自动与手动分步均得到 54 线/4 圆/28 矩形/F1=0.987；"
        "手动模式可在 9 个阶段之间暂停，改参数后只重算受影响阶段。",
    ]
    for text in effects:
        add_para(c, text)

    # 6 具体实施方式
    c = rows[6].cells[1]
    clear_cell(c)
    add_para(c, "下面结合附图与实施例对本发明作进一步说明。本发明可采用 Python 实现核心引擎，"
                "以 OpenCV 完成图像处理，以 ezdxf 读写 DXF，以 Windows.Media.Ocr 完成离线中文识别；"
                "以下实施例的参数仅用于说明，不用于限定保护范围。")

    add_heading(c, "实施例 1：干净扫描件")
    add_para(c, "输入 2200×1600 PNG 扫描件，图幅按 A4 横向 297 mm 换算，比例 1 px≈0.135 mm。"
                "采用 Otsu 二值化、去噪强度 1、自动纠偏；检测到 7 处文字区，掩膜后提取 54 条线段、4 个圆、"
                "28 个矩形；OCR 识别 16 行；输出 86 个几何图元与 16 个 TEXT；质量自检 F1=0.99；"
                "联动识读配对 5 项，整链耗时约 2.5 秒。")

    add_heading(c, "实施例 2：手机拍照件")
    add_para(c, "输入同图经 4.2° 倾斜、光照不均、模糊、噪声与 JPEG 压缩后的 2200×1600 照片。"
                "二值化自动选择自适应阈值；Hough 长直线估计倾角 −4.03°，反向纠偏后横线可吸附为 0°；"
                "提取 71 条线段、5 个圆、29 个矩形；OCR 14 行；F1=0.97；联动识读 4 项；整链耗时约 4.2 秒。")

    add_heading(c, "实施例 3：文字区保护对比")
    add_para(c, "同一干净图，关闭文字区保护时检测到 92 条线段，其中 40 条的中点落在文字框内；"
                "开启保护后为 54 条，仅 3 条短假线；F1 从 0.919 提升到 0.987。该对比可作为参数选择与"
                "专利技术效果的验证数据。")

    add_heading(c, "实施例 4：手动分步与参数回退")
    add_para(c, "在手动模式下，流水线被拆为 9 个阶段，每阶段结束暂停并落盘中间结果。"
                "用户在“直线”阶段发现最短线段过小，修改 min_line_ratio 后触发“应用参数并重跑”，"
                "系统判断该参数仅影响直线阶段，只重跑直线并清空其后结果；若改为二值化方式，"
                "系统则回到预处理阶段重跑。自动与手动结果一致，便于演示与人工核对。")

    add_heading(c, "其他实施方式")
    add_para(c, "（1）二值化可替换为 Sauvola、Niblack 或深度学习分割，只要保留“文字掩膜先行”的顺序；"
                "（2）直线检测可替换为 LSD、EDLines 或骨架追踪，圆检测可替换为 RANSAC 拟合；"
                "（3）OCR 可替换为其他离线/在线引擎，但需保留“文本→DXF TEXT→识读引擎”的落点规则；"
                "（4）比例换算可按图幅宽度、扫描 DPI、已知基准尺寸或用户手绘比例尺；"
                "（5）输出格式除 DXF 外还可输出 SVG、PDF，或写回 DWG（依赖 ODA/AutoCAD 后端）；"
                "（6）方法可在具备 CPU 的普通办公电脑、笔记本或边缘设备上执行，不依赖 GPU 与网络。")

    add_heading(c, "工业实用性")
    add_para(c, "本发明可在制造企业图纸归档、PDM/ERP 数据导入、CAD 教学、图纸质量检查等场景重复实施，"
                "能够把“人工描图+人工抄录”转化为“自动初稿+人工核对”，具有明确的工业实用性。")

    # 7 附图
    c = rows[7].cells[1]
    clear_cell(c)
    add_para(c, "本发明提供以下附图，用于说明方法流程、文字区保护效果与字段闭环：", first_indent=False)
    figs = [
        ("fig1_flow.png", "图 1  方法总体流程图（S1～S7）"),
        ("fig2_textmask.png", "图 2  文字区保护前后对比示意"),
        ("fig3_closedloop.png", "图 3  图片 → DXF → 图框字段闭环示意"),
    ]
    for name, cap in figs:
        path = os.path.join(FIG_DIR, name)
        if not os.path.isfile(path):
            continue
        p = c.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.space_before = Pt(4)
        p.add_run().add_picture(path, width=Cm(8.6))
        cp = add_para(c, cap, size=9.5, align=WD_ALIGN_PARAGRAPH.CENTER, first_indent=False)
        cp.paragraph_format.space_after = Pt(8)


def build(out_path: str) -> str:
    doc = Document(TEMPLATE)
    fill_header(doc)
    fill_table(doc)
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    doc.save(out_path)
    return out_path


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="输出 docx 路径")
    args = ap.parse_args()
    print("已生成：", build(args.out))


if __name__ == "__main__":
    main()

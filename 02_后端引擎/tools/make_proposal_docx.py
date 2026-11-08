# -*- coding: utf-8 -*-
"""
make_proposal_docx.py
=====================
生成《CAD 双模式智能识图系统 v2.1 · 项目申报书》DOCX。

为什么用脚本生成：
    * 申报书里的实测数字、截图、目录结构必须与工程一致，脚本从固定路径取图，
      避免"文档写一套、产品另一套"；
    * 后续版本升级只需改这一处文案与指标，重新生成即可。

用法：
    python tools/make_proposal_docx.py --out "路径/项目申报书.docx"
"""
from __future__ import annotations

import argparse
import os
from typing import Iterable, List, Optional, Tuple

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOT_DIR = os.path.join(ROOT, "docs", "screenshots")
ACCENT = RGBColor(0x1F, 0x4E, 0x79)
MUTED = RGBColor(0x59, 0x59, 0x59)


# ---------------------------------------------------------------------------
# 排版小工具
# ---------------------------------------------------------------------------
def set_run_font(run, name: str = "宋体", size: Optional[float] = None,
                 bold: Optional[bool] = None, color: Optional[RGBColor] = None) -> None:
    run.font.name = name
    rpr = run._element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.append(rfonts)
    rfonts.set(qn("w:ascii"), name)
    rfonts.set(qn("w:hAnsi"), name)
    rfonts.set(qn("w:eastAsia"), name)
    if size is not None:
        run.font.size = Pt(size)
    if bold is not None:
        run.font.bold = bold
    if color is not None:
        run.font.color.rgb = color


def body(doc, text: str, indent: bool = True, size: float = 12,
         bold: bool = False, space_after: float = 6, align=None):
    p = doc.add_paragraph()
    pf = p.paragraph_format
    pf.line_spacing = 1.5
    pf.space_after = Pt(space_after)
    if indent:
        pf.first_line_indent = Pt(size * 2)
    if align is not None:
        p.alignment = align
    run = p.add_run(text)
    set_run_font(run, "宋体", size, bold)
    return p


def bullet(doc, text: str, size: float = 12):
    p = doc.add_paragraph(style="List Bullet")
    p.paragraph_format.line_spacing = 1.5
    p.paragraph_format.space_after = Pt(3)
    run = p.add_run(text)
    set_run_font(run, "宋体", size)
    return p


def numbered(doc, text: str, size: float = 12):
    p = doc.add_paragraph(style="List Number")
    p.paragraph_format.line_spacing = 1.5
    p.paragraph_format.space_after = Pt(3)
    run = p.add_run(text)
    set_run_font(run, "宋体", size)
    return p


def heading(doc, text: str, level: int = 1):
    p = doc.add_paragraph()
    pf = p.paragraph_format
    pf.space_before = Pt(14 if level == 1 else 10)
    pf.space_after = Pt(6)
    pf.line_spacing = 1.3
    run = p.add_run(text)
    if level == 1:
        set_run_font(run, "黑体", 16, True, ACCENT)
        # 下边框
        ppr = p._p.get_or_add_pPr()
        pbdr = OxmlElement("w:pBdr")
        bottom = OxmlElement("w:bottom")
        bottom.set(qn("w:val"), "single")
        bottom.set(qn("w:sz"), "8")
        bottom.set(qn("w:space"), "4")
        bottom.set(qn("w:color"), "1F4E79")
        pbdr.append(bottom)
        ppr.append(pbdr)
    else:
        set_run_font(run, "黑体", 13.5, True, RGBColor(0x2E, 0x2E, 0x2E))
    return p


def caption(doc, text: str):
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_after = Pt(10)
    run = p.add_run(text)
    set_run_font(run, "宋体", 10, False, MUTED)


def shade(cell, color: str = "DCE6F1") -> None:
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), color)
    tc_pr.append(shd)


def table(doc, header: List[str], rows: Iterable[Iterable[str]],
          widths: Optional[List[float]] = None, font_size: float = 10.5):
    t = doc.add_table(rows=1, cols=len(header))
    t.style = "Table Grid"
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    hdr = t.rows[0].cells
    for i, text in enumerate(header):
        hdr[i].text = ""
        p = hdr[i].paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        run = p.add_run(text)
        set_run_font(run, "黑体", font_size, True)
        shade(hdr[i])
    for row in rows:
        cells = t.add_row().cells
        for i, text in enumerate(row):
            cells[i].text = ""
            p = cells[i].paragraphs[0]
            p.paragraph_format.line_spacing = 1.2
            run = p.add_run(str(text))
            set_run_font(run, "宋体", font_size)
    if widths:
        for row in t.rows:
            for i, w in enumerate(widths):
                row.cells[i].width = Cm(w)
    doc.add_paragraph().paragraph_format.space_after = Pt(2)
    return t


def add_page_number_footer(section, text: str) -> None:
    footer = section.footer
    p = footer.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run(text + "    第 ")
    set_run_font(run, "宋体", 9, False, MUTED)
    # PAGE 字段
    fld_begin = OxmlElement("w:fldChar")
    fld_begin.set(qn("w:fldCharType"), "begin")
    instr = OxmlElement("w:instrText")
    instr.set(qn("xml:space"), "preserve")
    instr.text = "PAGE"
    fld_end = OxmlElement("w:fldChar")
    fld_end.set(qn("w:fldCharType"), "end")
    run2 = p.add_run()
    set_run_font(run2, "宋体", 9, False, MUTED)
    run2._r.append(fld_begin)
    run2._r.append(instr)
    run2._r.append(fld_end)
    run3 = p.add_run(" 页")
    set_run_font(run3, "宋体", 9, False, MUTED)


def set_page(section) -> None:
    section.page_width = Cm(21.0)
    section.page_height = Cm(29.7)
    section.top_margin = Cm(2.3)
    section.bottom_margin = Cm(2.2)
    section.left_margin = Cm(2.6)
    section.right_margin = Cm(2.4)


# ---------------------------------------------------------------------------
# 正文
# ---------------------------------------------------------------------------
def build(out_path: str) -> str:
    doc = Document()

    # 默认样式
    normal = doc.styles["Normal"]
    normal.font.name = "宋体"
    normal.font.size = Pt(12)
    normal._element.rPr.rFonts.set(qn("w:eastAsia"), "宋体")

    sec = doc.sections[0]
    set_page(sec)
    add_page_number_footer(sec, "CAD 双模式智能识图系统 v2.1 · 项目申报书")

    # ---------------- 封面 ----------------
    for _ in range(3):
        doc.add_paragraph()
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run("大学生创新创业训练计划 · 创新训练项目")
    set_run_font(run, "黑体", 16, True, ACCENT)

    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(30)
    run = p.add_run("项 目 申 报 书")
    set_run_font(run, "黑体", 34, True)

    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(44)
    run = p.add_run("CAD 双模式智能识图系统")
    set_run_font(run, "黑体", 26, True)

    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run("图框识读 × 看图成图：一张图纸的两条数字化路径")
    set_run_font(run, "宋体", 15, False, MUTED)

    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(10)
    run = p.add_run("版本 v2.1    2026 年 10 月")
    set_run_font(run, "宋体", 13, False, MUTED)

    # 封面信息表
    doc.add_paragraph()
    doc.add_paragraph()
    info = [
        ("项目名称", "CAD 双模式智能识图系统（图框识读 / 看图成图）"),
        ("项目类别", "创新训练项目（软件工具类）"),
        ("申报单位", "广东科技学院"),
        ("项目负责人", "邓钧宝（网络空间安全 · 2025级）"),
        ("指导教师", "李玉坤（讲师）"),
        ("联系方式", "17876920447 / 3157758997@qq.com"),
        ("申报日期", "2026 年 10 月 28 日"),
    ]
    t = doc.add_table(rows=0, cols=2)
    t.style = "Table Grid"
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    for k, v in info:
        cells = t.add_row().cells
        cells[0].width = Cm(3.6)
        cells[1].width = Cm(11.0)
        for cell, text, font, bold in ((cells[0], k, "黑体", True), (cells[1], v, "宋体", False)):
            cell.text = ""
            para = cell.paragraphs[0]
            para.paragraph_format.space_after = Pt(2)
            run = para.add_run(text)
            set_run_font(run, font, 11.5, bold)
        shade(cells[0], "F2F2F2")

    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(28)
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run("本申报书所有实测数字均来自本机真实运行，证据见配套验收材料。")
    set_run_font(run, "楷体", 10.5, False, MUTED)

    doc.add_page_break()

    # ---------------- 摘要 ----------------
    heading(doc, "项目摘要", 1)
    body(doc, "本项目要做一件很具体的事：让 CAD 图纸里的信息，无论以矢量文件还是以一张图片的形式出现，"
              "都能被自动、可核对地变成结构化数据与可编辑图形。")
    body(doc, "产品由两个模式组成。模式 A「图框识读」面向已有 .dxf/.dwg 的场合：解析散落在标题栏里的 "
              "TEXT / MTEXT / 块内文字 / ATTRIB，判定字段标签与字段值并配对，生成统一命名的 "
              "TitleBlock_Standardized 标准化块参照，输出同格式副本与 JSON。模式 B「看图成图」面向只有扫描件、"
              "手机照片的场合：把图片经过灰度去噪、自适应二值化、倾斜纠偏、文字区保护、直线/圆/闭合矩形提取、"
              "横平竖直吸附、系统中文 OCR、质量自检，输出可编辑 DXF、SVG 与过程报告。")
    body(doc, "两个模式不是并列摆设：模式 B 生成的 DXF 可直接交给模式 A 识读，形成“图片 → CAD → 字段”的闭环；"
              "同一套网页工作台用两个页签承载，用户不必在两个程序之间切换。")
    body(doc, "实测（2200×1600 演示图）：干净扫描件 54 条线段 / 4 个圆 / 28 个矩形、像素还原 F1 0.99、"
              "整链 2.5 秒；手机拍照件（倾斜 4.2°、噪声、JPEG 压缩）71 条线段 / 5 个圆 / 29 个矩形、F1 0.97、"
              "整链 4.2 秒；模式 A 示例图框 8 对字段、0.05 秒。工程含 41 项自动化测试、两段 30 秒过程视频、"
              "四组可复现验收证据。")

    heading(doc, "一、背景与痛点", 1)
    body(doc, "CAD 图纸是制造业最普遍的信息载体，但图纸里的信息并不天然可用。")
    bullet(doc, "信息孤岛：一个零件图的标题栏通常有零件名称、图号、材料、比例、数量、设计/审核、日期、"
                "未注公差等十余个字段。它们散落在图纸中，要和 ERP、PDM、MES 对接，只能人工抄录或写一次性脚本。")
    bullet(doc, "录入成本高、易串位：标签在左值在右、标签在上值在下、属性块藏值、同名标签多联图框，"
                "规则稍有变化，抄录就会错行；一个中型项目的人工转录往往以“人天”计。")
    bullet(doc, "图纸只有图片：供应商发来扫描件、车间拍来照片、档案室只有 PDF 截图时，连 CAD 源文件都没有，"
                "更谈不上字段提取；传统做法是“先照着描一遍图，再抄一遍字段”。")
    bullet(doc, "现有工具各管一段：通用 OCR 能认字但不认 CAD 结构，也不会生成块；通用矢量化工具能描线但把汉字拆成"
                "几十条假线段，且不给可信度；CAD 插件要求先有矢量图。缺少一个把“识字段”和“看图成图”打通、"
                "并且过程可核对的本地工具。")
    body(doc, "本项目的判断是：图纸数字化的瓶颈不在“能不能识别”，而在“识别结果敢不敢用、出了问题能不能定位”。"
              "因此产品把“可核对”作为第一设计原则：每一步都有截图和数字，最终结果有像素级自检分数，"
              "原始文件永远不被修改。")

    heading(doc, "二、目标与总体方案", 1)
    body(doc, "目标：交付一个可在普通 Windows 电脑上离线运行的双模式工具，覆盖“有矢量图纸”和“只有图片”两类输入，"
              "把标题栏字段与图形分别变成结构化数据与可编辑 DXF，并提供可复现的验收证据。")
    body(doc, "总体技术路线如下：")
    numbered(doc, "统一入口：本地网页工作台（Python 标准库 HTTP 服务 + 原生前端），顶栏切换“图框识读 / 看图成图”；"
                  "模式 A 同时保留 tkinter GUI、CLI、Electron 三种既有入口。")
    numbered(doc, "模式 A：解析 → 三级标签信号识别 → 标题栏空间聚类 → 全局降序指派配对 → 标准化块生成 → 同格式另存。")
    numbered(doc, "模式 B：读图与尺寸归一化 → 预处理（灰度/去噪/二值/纠偏/去噪点/骨架/文字区）→ 矢量化"
                  "（直线/圆/闭合矩形/吸附）→ 系统 OCR → DXF/SVG → 栅格自检 → 可选联动识读。")
    numbered(doc, "证据链：每次运行落盘 14 步截图、report.json、report.html、DXF/SVG；可回放、可导出 30 秒过程视频；"
                  "41 项自动化测试覆盖算法、流水线、模式 A 与手动分步。")
    body(doc, "关键设计取舍：像素坐标贯穿模式 B 全流程，只在写出 DXF 时一次性换算毫米，避免多套坐标互相污染；"
              "所有参数集中在 Options 一处，界面、命令行、测试共用同一份默认值。")

    heading(doc, "三、关键技术", 1)
    heading(doc, "3.1 模式 A：让字段配对不串位", 2)
    body(doc, "难点不是“认出字”，而是“判断谁是字段名、谁是值，并把它们配成对”。本项目采用三级标签信号"
              "（强标签 / 疑似标签 / 值）：强标签作定位锚点，疑似标签仍可参与配对，避免中文值被误判成标签后整行错位；"
              "配对阶段用行聚类、方向打分与语义加成生成候选边，再全局降序统一指派，而不是逐个标签抢最近值；"
              "同名标签逐次配对，支持多联图框与单图多模号。")
    body(doc, "块生成阶段，属性 Tag 在块内唯一化，属性插入点按字段原始相对位置落点，而不是排成一条斜线；"
              "输入 .dwg 时优先写回 .dwg，缺少 ODA / AutoCAD 后端则回退 .dxf 并告警。")

    heading(doc, "3.2 模式 B：把图片变成敢用的 CAD", 2)
    body(doc, "（1）预处理：灰度后用保边双边滤波去噪（避免 3×3 中值把 1 像素中心线整条抹掉）；二值化在 Otsu 与"
              "自适应之间按“找回墨迹量”自动择优；用 Hough 长直线中位角纠偏（±15°）；按连通域面积去噪点、闭运算补断线。")
    body(doc, "（2）文字区保护：图纸上的汉字是笔画的集合，直线检测会把横竖撇捺当成短线段。本项目先按"
              "“尺寸区间 + 填充率 + 最大内切半径”筛字形候选，再行聚类成文字框，掩膜外扩后从线框提取中排除，"
              "检测后再剔除“整条落在文字区”的线段。实测关闭保护时 92 条线段中 40 条落在文字框内，"
              "开启后 54 条中仅 3 条短假线，像素 F1 由 0.919 提升到 0.987。")
    body(doc, "（3）几何重建：Hough 直线 + 法向/角度/间隙三条件共线合并 + 横平竖直吸附 + 端点吸附闭合；"
              "四条共享端点的边合成闭合 LWPOLYLINE（DXF 里是一个矩形，不是四条散线）；圆检测用缩小图单次 Hough"
              "加圆周支撑率与扇区覆盖率过滤，再剔除圆的弦线段。")
    body(doc, "（4）OCR 与闭环：调用 Windows 自带 Windows.Media.Ocr（简体中文，本地离线），清洗中文空格、"
              "全角标点与常见连字符误识，把文字落成 DXF 的真实 TEXT 实体，再交给模式 A 引擎，实现图片到字段的闭环。")
    body(doc, "（5）质量自检：把矢量结果重新栅格化，与输入墨迹逐像素比对，给出精确率、召回率、F1 与双向倒角距离。"
              "这条数字同时出现在界面、报告与命令行，调参不再靠肉眼。")
    body(doc, "（6）自动 / 手动分步与 CAD 画布：自动模式一键跑完；手动模式把流水线拆成 9 个可暂停阶段"
              "（读取/预处理/直线/圆/矩形/OCR/DXF/自检/识读联动），每步结束暂停，可看截图与指标、改参数后"
              "「应用参数并重跑」——后端按参数最早影响的阶段重算并清空后续结果，再逐步继续。预览区提供网格、"
              "滚轮缩放、拖动平移、坐标读数与图层开关，操作方式接近主流 CAD 查看器。")

    heading(doc, "四、创新点", 1)
    body(doc, "以下每条均给出“问题—做法—效果—边界”，数字来自演示图实测。")

    heading(doc, "创新点 1：把生成过程做成可回看的胶片", 2)
    body(doc, "问题：图片转矢量天然是黑箱，结果不对时不知道该调哪一步。做法：流水线固定 14 个步骤，每步产出截图、"
              "中文说明、指标与耗时，Web 端逐步推送；生成完成后可一键回放（1.5 秒/步，支持键盘），也能导出 30 秒 MP4。"
              "效果：定位从“整条流程”缩小到“单个步骤”，汇报时不用现场跑程序。边界：过程图占磁盘，可关闭。")

    heading(doc, "创新点 2：文字区保护，先认字再矢量化", 2)
    body(doc, "问题：汉字笔画会被 Hough 当成大量假线段，这是图纸矢量化最大的误检来源。做法：小连通域 + 行聚类 + "
              "笔画宽度估计生成文字掩膜，检测前掩膜、检测后二次剔除。效果：假线 40 → 3 条，像素 F1 0.919 → 0.987。"
              "边界：保护的是“不误检”，不是“识别文字”；文字与真实几何重叠时会被一起掩掉。")

    heading(doc, "创新点 3：闭合矩形与横平竖直重建", 2)
    body(doc, "问题：Hough 输出的是散线段，一个框变四条线，导入 CAD 后不能当边界用。做法：共线合并 + 角度吸附 + "
              "端点闭合 + 四边合成闭合轮廓。效果：干净图重建 28 个矩形（含标题栏 5×4 表格 20 个单元格与 3 个主轮廓），"
              "DXF 中可整块选中编辑。边界：只处理轴对齐矩形，旋转矩形仅预留字段。")

    heading(doc, "创新点 4：用栅格自检 F1 给结果打分", 2)
    body(doc, "问题：多画与漏画两个方向的错，肉眼难同时判断。做法：矢量重绘回二值图，与去文字后的输入墨迹逐像素比对"
              "（两侧膨胀 3px），给出 P/R/F1/chamfer。效果：干净件 F1 0.99、拍照件 0.97；与真值几何比对，"
              "主要直线召回 94.3%，误检 0 / 2 条。边界：像素级自检衡量“画得像”，结构对错仍需配合图元数量核对。")

    heading(doc, "创新点 5：图片 → DXF → 字段的闭环", 2)
    body(doc, "问题：用户要的常常不是 DXF，而是字段。做法：OCR 把文字落成 TEXT，再调用模式 A 引擎，"
              "在一次运行内完成“看图、得图、得字段”。效果：干净件 OCR 16 行 / 71 字，联动识读 5 项字段"
              "（零件名称、材料、设计、审核、日期）；拍照件 14 行，配对 4 项（含图号）。边界：OCR 有错字"
              "（SKD11→SKDI1），结果用于省抄录，不替代人工核对。")

    heading(doc, "创新点 6：双模式同页签与参数单一来源", 2)
    body(doc, "问题：两种能力若分属两个程序，用户切换成本高，参数也容易在界面/命令行/测试之间失配。做法："
              "统一 Web 工作台 + 单一 Options + 一份 ui_schema。效果：图框识读与看图成图同页切换；新增参数只改"
              "config.py 一处，前端自动出现控件；41 项测试共用同一套默认值。")

    heading(doc, "创新点 7：人在回路的手动分步与 CAD 式画布", 2)
    body(doc, "问题：全自动只能“整条重跑”，真实图纸需要“看一眼、改个参数、再继续”；通用工具也缺少 CAD 式核对界面。"
              "做法：9 阶段暂停 + 参数影响分析（二值化→预处理、最短线段→直线、图幅→生成 CAD），只重算受影响部分；"
              "画布支持网格、25%–1000% 缩放、平移、像素/毫米坐标与四类图层开关。效果：自动/手动共享同一套算法，"
              "同一干净图两种模式结果一致（54 线 / 4 圆 / 28 矩形 / F1 0.99）；手动可逐步核对并精准回退。"
              "边界：当前只支持查看与调参，不支持手工删线/补线；重跑会丢弃后续阶段结果。")

    heading(doc, "五、完成情况与验证", 1)
    body(doc, "项目已完成可运行版本 v2.1，包含两个模式的完整实现、统一界面、命令行、测试与交付材料。"
              "下表为本机实测结果（演示图 2200×1600）：")
    table(doc,
          ["指标", "干净扫描件", "手机拍照件"],
          [
              ["总耗时（含 OCR / 报告）", "2.5 s", "4.2 s"],
              ["线段 / 圆 / 矩形 / 文字区", "54 / 4 / 28 / 7", "71 / 5 / 29 / 7"],
              ["主要直线召回（真值）", "94.3%", "94.3%"],
              ["误检线段（≥40px）", "0 条", "2 条"],
              ["像素还原 F1", "0.99（P1.00 / R0.97）", "0.97（P0.97 / R0.97）"],
              ["OCR / 识读联动", "16 行 / 5 项", "14 行 / 4 项"],
          ],
          widths=[5.0, 5.4, 5.4])
    body(doc, "模式 A 示例图框（示例1-行列式.dxf）实测：16 个文字元素、8 个强标签、8 对字段、0 空值、0.05 秒，"
              "生成含 8 个属性的 TitleBlock_Standardized 块；属性图框（示例3）可读取 ATTRIB 值。")
    body(doc, "自动化测试 41 项：预处理契约、矢量化几何、流水线 14 步与落盘、DXF 图层/单位/实体、"
              "模式 A 示例识读与损坏文件容错、手动分步（9 阶段暂停 / 参数重跑 / 停止）。正常负载全部通过；满载时性能用例跳过并给出实测值，避免误报。")
    body(doc, "交付证据：每次运行含 14 步截图、report.html、DXF/SVG；两段 30 秒过程视频（H.264，1280×720，浏览器可播）；"
              "5 张界面截图；两组模式 A 证据；两份评测 JSON。所有证据可用随附命令复现。")

    heading(doc, "六、与现有方案对比", 1)
    table(doc,
          ["方案", "能做", "做不到", "本项目差异"],
          [
              ["人工抄录", "任意格式", "慢、易错、无法追溯", "自动配对 + 置信度 + 可复核 JSON"],
              ["通用 OCR", "认字", "不认 CAD 结构、不生成块、不懂字段配对", "OCR 只作一环，结果落成可识读 DXF"],
              ["通用矢量化", "描线", "汉字变假线、无闭合矩形、无质量分数", "文字区保护 + 矩形重建 + F1 自检"],
              ["CAD 插件", "字段提取", "要求先有矢量图", "图片也能走通，并可反向生成 DXF"],
              ["本项目", "两类输入、两种产物、一个闭环", "强透视/手写仍有限", "过程可视化 + 可复现证据链"],
          ],
          widths=[3.4, 4.2, 5.0, 5.4])

    heading(doc, "七、应用场景与价值", 1)
    body(doc, "直接场景：")
    bullet(doc, "制造业图纸转录：把供应商图纸的标题栏批量转成 JSON，导入 ERP/PDM；原始图纸不被修改。")
    bullet(doc, "图纸档案数字化：只有扫描件/照片的历史图纸，先生成可编辑 DXF，再抽取字段建库。")
    bullet(doc, "CAD 教学与实训：把“手绘/拍照 → CAD”的过程可视化，学生能看懂每一步发生了什么。")
    bullet(doc, "图纸质量检查：用 F1 与叠加诊断图快速发现漏线、断线、文字粘连。")
    body(doc, "效率估算（非严格测算，需在试点中校准）：人工转录一张标题栏约 5–10 分钟，模式 A 示例为 0.05 秒级；"
              "人工描一张 A4 图纸约 1–2 小时，模式 B 输出初稿为秒级，仍需人工核对与修整。价值主要在“把重复劳动变成核对劳动”。")

    heading(doc, "八、边界与风险", 1)
    bullet(doc, "模式 B 不做透视校正，强斜拍、褶皱、反光严重的照片效果有限；手绘草图不在适用范围。")
    bullet(doc, "OCR 依赖系统简体中文语言包；小字号、艺术字、手写体识别率有限，错字需人工核对。")
    bullet(doc, "圆与矩形对虚线、被遮挡、文字压线的目标召回有限；干净图仍有 1 个小圆漏检（4/5）。")
    bullet(doc, "模式 A 的 .dwg 写回依赖 ODA File Converter 或本机 AutoCAD，缺失时回退 .dxf。")
    bullet(doc, "输出为“重建线框”，不是原设计参数模型；尺寸需按图幅/比例参数核对。")
    body(doc, "应对：所有结果附质量数字与过程截图；默认不改原文件；关键字段建议人工复核后再入库。")

    heading(doc, "九、实施计划", 1)
    table(doc,
          ["阶段", "内容", "状态"],
          [
              ["v1.0 / v1.1", "图框识读引擎、GUI/CLI/Electron、三级标签信号、ATTRIB、标准化块", "已完成"],
              ["v2.0", "看图成图全链路、Windows OCR、质量自检、图片→DXF→字段闭环", "已完成"],
              ["v2.1", "双模式 Web 工作台、过程回放、过程视频、模式 A Web API、41 项测试", "已完成"],
              ["下一阶段", "Electron 双页签集成；表格短段合并专项；真实车间图纸试点与调参", "计划中"],
              ["后续", "批量与模板化、字段规则配置、PDM/ERP 对接适配", "规划中"],
          ],
          widths=[2.8, 11.0, 2.6])

    heading(doc, "十、预期成果", 1)
    bullet(doc, "软件：可运行的双模式工具 v2.1（源码 + 安装包 + 一键启动），本地离线、无外部服务。")
    bullet(doc, "文档：总览、原用法、看图成图用法、创新点、验收复现、交付清单。")
    bullet(doc, "演示：两段 30 秒过程视频、8 张界面截图、2 组模式 A 证据、2 组模式 B 证据、1 组手动分步证据。")
    bullet(doc, "知识产权：已形成 2 份专利技术交底（图框识读 / 图纸图像矢量化与字段闭环），"
                "并整理权利要求建议 10 项；建议同步申请软件著作权 1 项。")
    bullet(doc, "试点：2–3 家制造企业/实训室的真实图纸试用，形成可量化报告。")

    heading(doc, "十一、团队与分工", 1)
    body(doc, "项目组共 5 人，覆盖网络安全、电子信息、智能科学与技术、英语等专业，按“算法—工程—测试与文档—"
              "检索与传播”分工协作：")
    table(doc,
          ["姓名", "专业 / 年级", "项目分工"],
          [
              ["邓钧宝", "网络空间安全 · 2025级",
               "项目负责人：总体架构、系统集成、本地化部署与安全合规、申报材料统稿"],
              ["马睿", "智能科学与技术 · 2025级",
               "几何重建：直线/圆/闭合矩形、文字区掩膜、质量自检指标"],
              ["李钧耀", "智能科学与技术 · 2025级",
               "OCR 与闭环：文字识别、DXF 实体落点、识读引擎联动、Web 服务"],
          ],
          widths=[2.4, 5.0, 8.2])
    body(doc, "以上为项目组建议分工，实施中可按实际贡献调整。")
    body(doc, "指导教师：李玉坤（讲师），负责技术路线把关、图纸规范指导与项目进度评审。")

    heading(doc, "十二、经费预算", 1)
    body(doc, "本项目经费预算按学校立项批复执行，本申报书不列分项金额。")

    heading(doc, "十三、结语", 1)
    body(doc, "CAD 图纸的数字化，不应该以“再抄一遍、再描一遍”为代价。本项目用两个模式覆盖两类输入，"
              "用过程可视化与栅格自检回答“结果敢不敢用”，用闭环把图片一路送到字段。")
    body(doc, "v2.1 已经把这条链路跑通并留下可复现的证据；下一步是在真实图纸上把它磨到可交付生产使用的程度。")

    # 附件说明
    heading(doc, "附件：配套材料", 1)
    bullet(doc, "安装包：CAD双模式智能识图_v2.1_安装包.zip（解压即用，需 Python 3.10+）")
    bullet(doc, "源码包：CAD双模式智能识图_v2.1_源码.zip（含 tests / tools / 文档）")
    bullet(doc, "验收证据：out/final（模式 B 2 组、模式 A 2 组、评测 JSON）")
    bullet(doc, "演示视频：demo/process/*.mp4（30 秒 × 2）")
    bullet(doc, "界面截图：docs/screenshots/（6 张）")

    # 插图页
    doc.add_page_break()
    heading(doc, "附：系统界面与过程截图", 1)
    shots = [
        ("03-图框识读-结果.png", "图 1  图框识读：标题栏字段、置信度与标准化块结果"),
        ("04-看图成图-结果.png", "图 2  看图成图：14 步过程、统计卡与下载"),
        ("05-生成过程回放.png", "图 3  生成过程回放：逐步查看图片如何变成 CAD"),
        ("06-过程视频-第7步.png", "图 4  过程视频截帧：直线提取步骤"),
    ]
    for name, cap in shots:
        path = os.path.join(SHOT_DIR, name)
        if os.path.isfile(path):
            p = doc.add_paragraph()
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            run = p.add_run()
            run.add_picture(path, width=Cm(15.0))
            caption(doc, cap)

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    doc.save(out_path)
    return out_path


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="生成 CAD 双模式智能识图 v2.1 项目申报书 DOCX")
    ap.add_argument("--out", required=True, help="输出 .docx 路径")
    args = ap.parse_args()
    path = build(args.out)
    print("已生成：", path)

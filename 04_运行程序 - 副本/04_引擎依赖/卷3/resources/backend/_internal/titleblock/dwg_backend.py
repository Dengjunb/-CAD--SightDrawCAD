# -*- coding: utf-8 -*-
"""
dwg_backend.py
==============
.DWG 原生读取后端。

ezdxf 只能直接读取 .dxf，无法读取二进制 .dwg。为了"原生读取主流二维 CAD
文件格式(.dxf 与 .dwg)"的需求，本模块提供 .dwg -> .dxf 的转换后端：

    ezdwg   ：开源纯 Python + 原生扩展的 DWG 读取库（优先，推荐）
    ODA     ：ODA File Converter 命令行工具（若已安装）
    AutoCAD：AutoCAD COM 自动化（若已安装 AutoCAD）

转换后的 .dxf 交给 ezdxf 统一解析与写回，既保证 .dwg 可读，又复用了
ezdxf 成熟、合规的 DXF 编辑/保存能力。原始 .dwg 文件保持不变。

设计要点：
    1. 后端按优先级探测，谁可用就用谁，无需用户手工配置；
    2. 任何后端缺失时抛出带友好提示的异常，而不是让程序崩溃；
    3. 转换是"临时副本"，绝不修改用户的原始文件。
"""

from __future__ import annotations
import os
import shutil
import subprocess
import tempfile
import uuid
from typing import List, Optional


class DWGBackendError(RuntimeError):
    """DWG 转换后端不可用 / 转换失败时抛出，带友好中文提示。"""


def _find_oda_converter() -> Optional[str]:
    """
    探测 ODA File Converter 可执行文件路径（ODAFileConverter.exe）。

    返回：
        找到的可执行文件绝对路径；找不到返回 None。
    """
    candidates: List[str] = []
    # 常见安装目录
    for base in (os.environ.get("ProgramFiles", r"C:\\Program Files"),
                 os.environ.get("ProgramFiles(x86)", r"C:\\Program Files (x86)"),
                 os.path.join(os.environ.get("LOCALAPPDATA", ""), "ODA")):
        if base:
            candidates.append(os.path.join(base, "ODAFileConverter", "ODAFileConverter.exe"))
    # 环境变量 PATH 中查找
    which = shutil.which("ODAFileConverter.exe")
    if which:
        candidates.append(which)
    for c in candidates:
        if c and os.path.isfile(c):
            return c
    return None


def _oda_convert_file(src_path: str, dst_path: str, out_type: str) -> None:
    """
    使用命令行 ODA File Converter 转换单个文件（输入目录模式）。

    ODA 的用法：ODAFileConverter <输入目录> <输出目录> <输出版本> <输出类型> <递归>
    out_type 为 "DXF"（dwg->dxf）或 "DWG"（dxf->dwg）。
    它转换目录下所有文件，因此这里为每次转换建立独立临时目录，避免误转其它文件。
    """
    converter = _find_oda_converter()
    if not converter:
        raise DWGBackendError(
            "未检测到 ODA File Converter。请安装后重试，或安装 ezdwg 库(pip install ezdwg)。")
    workdir = tempfile.mkdtemp(prefix="tbr_oda_in_")
    outdir = tempfile.mkdtemp(prefix="tbr_oda_out_")
    try:
        shutil.copy2(src_path, os.path.join(workdir, os.path.basename(src_path)))
        # 参数以空格分隔：输入目录 输出目录 版本 类型 递归
        # 用参数数组调用（不经过 shell），避免中文/空格路径与命令注入问题
        cmd = [converter, workdir, outdir, "ACAD2018", out_type, "1"]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        ret = proc.returncode
        produced: Optional[str] = None
        if os.path.isdir(outdir):
            wanted = ".dwg" if out_type.upper() == "DWG" else ".dxf"
            for f in os.listdir(outdir):
                if f.lower().endswith(wanted):
                    produced = os.path.join(outdir, f)
                    break
        if ret != 0 or not produced:
            raise DWGBackendError(f"ODA File Converter 转换失败(->{out_type})")
        shutil.copy2(produced, dst_path)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
        shutil.rmtree(outdir, ignore_errors=True)


def _oda_convert_dwg_to_dxf(src_dwg: str, dst_dxf: str) -> None:
    """dwg -> dxf 便捷封装。"""
    _oda_convert_file(src_dwg, dst_dxf, "DXF")


def _oda_convert_dxf_to_dwg(src_dxf: str, dst_dwg: str) -> None:
    """dxf -> dwg 便捷封装。"""
    _oda_convert_file(src_dxf, dst_dwg, "DWG")


def _autocad_convert_dxf_to_dwg(src_dxf: str, dst_dwg: str) -> None:
    """用 AutoCAD COM 把 dxf 另存为 dwg（SaveAs 格式 8 = ACAD2013 dwg）。"""
    import win32com.client  # type: ignore
    import pythoncom  # type: ignore

    pythoncom.CoInitialize()
    app = win32com.client.Dispatch("AutoCAD.Application")
    app.Visible = False
    doc = app.Documents.Open(os.path.abspath(src_dxf), True)
    try:
        doc.SaveAs(os.path.abspath(dst_dwg), 8)
    finally:
        doc.Close(False)
    try:
        app.Quit()
    except Exception:
        pass


def convert_dxf_to_dwg(src_dxf: str, dst_dwg: Optional[str] = None) -> Optional[str]:
    """
    把 .dxf 转回 .dwg（用于 .dwg 输入时\"同格式另存\"）。

    后端顺序：ODA File Converter > AutoCAD COM。均不可用时返回 None。
    """
    if os.path.splitext(src_dxf)[1].lower() == ".dwg":
        return src_dxf  # 已是 dwg
    if dst_dwg is None:
        dst_dwg = os.path.splitext(src_dxf)[0] + ".dwg"

    if _find_oda_converter():
        try:
            _oda_convert_dxf_to_dwg(src_dxf, dst_dwg)
            return dst_dwg
        except DWGBackendError:
            pass
    try:
        _autocad_convert_dxf_to_dwg(src_dxf, dst_dwg)
        return dst_dwg
    except Exception:
        pass
    return None  # 无可用后端 -> 由调用方回退为 .dxf


def convert_dwg_to_dxf(src_dwg: str, dst_dxf: Optional[str] = None) -> str:
    """
    将 .dwg 转换为 .dxf，供 ezdxf 读取。

    后端选择顺序：ezdwg > ODA > AutoCAD COM。

    参数：
        src_dwg : 输入 .dwg 文件路径
        dst_dxf : 输出 .dxf 路径；None 时生成系统临时文件

    返回：
        转换后 .dxf 的路径。

    异常：
        DWGBackendError：所有后端均不可用或转换失败时抛出，
        并给出安装/替代建议，而不是让上层程序崩溃。
    """
    if not os.path.isfile(src_dwg):
        raise DWGBackendError(f"文件不存在：{src_dwg}")
    ext = os.path.splitext(src_dwg)[1].lower()
    if ext == ".dxf":
        return src_dwg  # 本身就是 dxf，无需转换

    if dst_dxf is None:
        tmpdir = tempfile.mkdtemp(prefix="tbr_dwg_")
        dst_dxf = os.path.join(tmpdir, str(uuid.uuid4().hex) + ".dxf")

    # --- 后端 1：ezdwg（优先，纯开源，无 AutoCAD 依赖） ---
    try:
        import ezdwg  # pyright: ignore
        # ezdwg.to_dxf(源, 目标) 完成转换
        ezdwg.to_dxf(os.path.abspath(src_dwg), os.path.abspath(dst_dxf))
        return dst_dxf
    except Exception:
        pass  # ezdwg 不可用或转换失败，尝试下一后端

    # --- 后端 2：ODA File Converter ---
    if _find_oda_converter():
        try:
            _oda_convert_dwg_to_dxf(src_dwg, dst_dxf)
            return dst_dxf
        except DWGBackendError:
            pass

    # --- 后端 3：AutoCAD COM ---
    try:
        import win32com.client  # type: ignore
        import pythoncom  # type: ignore
        pythoncom.CoInitialize()
        app = win32com.client.Dispatch("AutoCAD.Application")
        app.Visible = False
        doc = app.Documents.Open(os.path.abspath(src_dwg), True)
        try:
            doc.SaveAs(os.path.abspath(dst_dxf), 12)  # 12 = ACAD2018 DXF
        finally:
            doc.Close(False)
        try:
            app.Quit()
        except Exception:
            pass
        return dst_dxf
    except Exception:
        pass

    raise DWGBackendError(
        "无法读取 .dwg 文件：未找到任何可用的 DWG 解析后端。\n"
        "请选择其一：\n"
        "  1) 安装开源库 ezdwg：pip install ezdwg\n"
        "  2) 安装 ODA File Converter（ODAFileConverter.exe）\n"
        "  3) 安装 AutoCAD 并提供 COM 自动化支持\n"
        "或先使用 AutoCAD 将 .dwg 另存为 .dxf 后交给本程序。")
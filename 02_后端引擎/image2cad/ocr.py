# -*- coding: utf-8 -*-
"""
ocr.py
======
Windows 内置 OCR（Windows.Media.Ocr）的 Python 封装。

为什么用它：
    * 零第三方依赖：Windows 10/11 自带 OCR 引擎，无需联网、无需安装 tesseract，
      也不把整张图纸上传到云端（隐私与合规）；
    * 中文识别：系统装好「简体中文」语言包即有 zh-Hans-CN 引擎（本项目实测可用）；
    * 输出与本项目同一坐标系（像素、左上原点），可直接落成 DXF 的 TEXT 实体。

降级策略：
    文件缺失 / 系统无 OCR 引擎 / 超时 时返回 ok=False + 中文原因，流水线继续
    输出纯线框 DXF（只是不带文字），不阻塞主流程。
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from typing import Any, Dict, List, Optional

_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ocr_win.ps1")
_CACHE: Optional[bool] = None
_LANGS: Optional[List[str]] = None


def _powershell() -> str:
    """优先 Windows PowerShell 5.1（WinRT 类型投影完整），回退 pwsh。"""
    sys_root = os.environ.get("SystemRoot", r"C:\Windows")
    candidates = [
        os.path.join(sys_root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        "powershell.exe",
        "pwsh.exe",
    ]
    for exe in candidates:
        if os.path.isabs(exe):
            if os.path.isfile(exe):
                return exe
            continue
        return exe
    return "powershell.exe"


def languages(timeout: float = 20.0, refresh: bool = False) -> List[str]:
    """列出系统可用 OCR 语言；失败返回空列表。"""
    global _LANGS, _CACHE
    if _LANGS is not None and not refresh:
        return _LANGS
    script = (
        "[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null;"
        "[Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages"
        " | ForEach-Object { $_.LanguageTag }"
    )
    try:
        proc = subprocess.run(
            [_powershell(), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
             "-Command", script],
            capture_output=True, timeout=timeout,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        out = proc.stdout.decode("utf-8", errors="ignore")
        _LANGS = [line.strip() for line in out.splitlines() if line.strip()]
    except Exception:
        _LANGS = []
    _CACHE = bool(_LANGS)
    return _LANGS


def available() -> bool:
    """检测本机是否具备可用 OCR（结果缓存，避免每次重跑子进程）。"""
    if _CACHE is None:
        languages()
    return bool(_CACHE)


def recognize(image_path: str, language: str = "zh-Hans-CN", timeout: float = 45.0) -> Dict[str, Any]:
    """
    对一张图片做 OCR。

    返回：
        {"ok": bool, "lines": [{"text":str,"x":float,"y":float,"w":float,"h":float}],
         "width":int, "height":int, "language":str, "error":str|None}
    坐标单位是图片像素，原点左上，可直接用于 DXF 落点。
    """
    empty: Dict[str, Any] = {"ok": False, "lines": [], "error": None}
    if not os.path.isfile(_SCRIPT):
        empty["error"] = "缺少 OCR 桥接脚本 ocr_win.ps1"
        return empty
    if not os.path.isfile(image_path):
        empty["error"] = "图片不存在"
        return empty
    try:
        proc = subprocess.run(
            [_powershell(), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
             "-File", _SCRIPT, "-ImagePath", os.path.abspath(image_path), "-Language", language],
            capture_output=True, timeout=timeout,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except subprocess.TimeoutExpired:
        empty["error"] = "OCR 超时"
        return empty
    except Exception as exc:
        empty["error"] = f"OCR 启动失败：{exc}"
        return empty

    raw = proc.stdout.decode("utf-8", errors="ignore").strip()
    if not raw:
        err = proc.stderr.decode("utf-8", errors="ignore").strip()[:200]
        empty["error"] = f"OCR 无输出{('：' + err) if err else ''}"
        return empty
    # 只取最后一行 JSON（脚本异常时可能有杂讯）
    line = raw.splitlines()[-1]
    try:
        data = json.loads(line)
    except json.JSONDecodeError:
        empty["error"] = "OCR 输出不是 JSON"
        return empty
    data.setdefault("lines", [])
    if not data.get("ok"):
        data.setdefault("error", "OCR 引擎不可用")
    return data


_FULLWIDTH = {"．": ".", "－": "-", "：": ":", "／": "/", "％": "%", "，": ",",
               "（": "(", "）": ")", "　": " ", "～": "~", "＝": "="}


def clean_text(text: str) -> str:
    """
    OCR 文本清洗（中文图纸的关键细节）：
        * Windows OCR 会给每个汉字之间加空格（"零 件 名 称"），直接落库/配对会失败，
          这里去掉 CJK 之间与字母数字之间的空格；
        * 全角标点归一（"．" -> "."），避免日期/比例值带全角符号；
        * 压缩多余空白，但保留「字段名 空格 值」这种跨词空格。
    """
    s = str(text or "")
    for k, v in _FULLWIDTH.items():
        s = s.replace(k, v)
    s = re.sub(r"(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])", "", s)
    s = re.sub(r"(?<=[A-Za-z0-9])\s+(?=[A-Za-z0-9])", "", s)
    s = re.sub(r"(?<=[A-Za-z0-9])\s*一\s*(?=[A-Za-z0-9])", "-", s)  # OCR 常把连字符识别成"一"
    s = re.sub(r"\s*([.,:;/])\s*", r"\1", s)   # 去掉标点两侧空格（2026 . 10 . 2 -> 2026.10.2）
    s = re.sub(r"\s+", " ", s).strip()
    return s


def lines_to_boxes(lines: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """把 OCR 行规整为 UI/DXF 需要的结构，过滤空行与异常框。"""
    out: List[Dict[str, Any]] = []
    for ln in lines or []:
        text = clean_text(ln.get("text", ""))
        w = float(ln.get("w", 0) or 0)
        h = float(ln.get("h", 0) or 0)
        if not text or w <= 0 or h <= 0:
            continue
        out.append({
            "text": text,
            "x": float(ln.get("x", 0) or 0),
            "y": float(ln.get("y", 0) or 0),
            "w": w,
            "h": h,
        })
    return out


if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else ""
    print("languages:", languages())
    print(json.dumps(recognize(path), ensure_ascii=False)[:2000])

# -*- coding: utf-8 -*-
"""
report.py
=========
生成单文件 HTML 报告（图片内嵌 base64，双击即可看，适合发给评审/客户）。

报告结构：
    1) 标题区：来源、时间、尺寸、耗时；
    2) 结论卡：图元数 / 文字行 / F1 / 召回 / 比例；
    3) 生成过程：每一步的截图 + 说明 + 指标（对应"能看到生成 CAD 的过程"）；
    4) 质量自检：叠加诊断图与数字；
    5) 识读联动：字段-值表格（如果有）；
    6) 产物清单与参数快照。
"""
from __future__ import annotations

import base64
import html
import io
import json
import os
from typing import Any, Dict, List, Optional

from .models import RunResult

# 报告内嵌图片的最大宽度与 JPEG 质量：原图/步骤图动辄 2~3MB，
# 直接 base64 会让报告膨胀到 20MB+，既难发送也难打开。
_REPORT_IMG_MAX_W = 1100
_REPORT_JPEG_QUALITY = 86


def _b64(path: str, max_w: int = _REPORT_IMG_MAX_W) -> str:
    """把图片压成适合内嵌的 JPEG（base64）；失败返回空串。"""
    try:
        from PIL import Image

        with Image.open(path) as im:
            im = im.convert("RGB")
            if im.width > max_w:
                h = max(1, int(im.height * max_w / im.width))
                im = im.resize((max_w, h), Image.LANCZOS)
            buf = io.BytesIO()
            im.save(buf, format="JPEG", quality=_REPORT_JPEG_QUALITY, optimize=True)
        return base64.b64encode(buf.getvalue()).decode("ascii")
    except Exception:
        try:
            with open(path, "rb") as fh:
                return base64.b64encode(fh.read()).decode("ascii")
        except OSError:
            return ""


def _img_tag(run_dir: str, rel: str, alt: str, cls: str = "") -> str:
    if not rel:
        return '<div class="ph">（此步骤无截图）</div>'
    abs_path = os.path.join(run_dir, rel)
    data = _b64(abs_path)
    if not data:
        return '<div class="ph">（图片缺失）</div>'
    return (f'<img class="{cls}" src="data:image/jpeg;base64,{data}" alt="{html.escape(alt)}" '
            'loading="lazy">')


def _num(v: Any, digits: int = 2) -> str:
    try:
        return f"{float(v):.{digits}f}"
    except (TypeError, ValueError):
        return str(v)


def build(result: RunResult, run_dir: str) -> str:
    """写出 report.html，返回路径。"""
    d = result.to_dict()
    steps = d["steps"]
    m = d["metrics"]
    q = d["quality"]

    step_cards: List[str] = []
    for i, st in enumerate(steps, 1):
        metrics = " · ".join(
            f"{html.escape(str(k))}: {html.escape(str(v))}" for k, v in (st.get("metrics") or {}).items()
            if not isinstance(v, dict))
        step_cards.append(f"""
        <div class="step">
          <div class="step-head">
            <span class="idx">{i:02d}</span>
            <h3>{html.escape(st['title'])}</h3>
            <span class="ms">{_num(st.get('ms', 0), 0)} ms</span>
          </div>
          <p class="detail">{html.escape(st['detail'])}</p>
          <figure>{_img_tag(run_dir, st.get('image', ''), st['title'])}</figure>
          <div class="metrics">{html.escape(metrics)}</div>
        </div>""")

    recog_html = ""
    if d.get("recognition"):
        r = d["recognition"]
        if r.get("ok"):
            rows = "".join(
                f"<tr><td>{html.escape(str(p.get('label', '')))}</td>"
                f"<td>{html.escape(str(p.get('value', '')))}</td></tr>"
                for p in r.get("pairs", []))
            recog_html = f"""
      <section class="card">
        <h2>图框识读联动（图片 → CAD → 字段）</h2>
        <p>配对 <b>{r.get('matched', 0)}</b> 项，空值 <b>{r.get('empty', 0)}</b> 项，
           未匹配 <b>{r.get('unmatched', 0)}</b> 项，耗时 {_num(r.get('elapsed_s', 0), 2)} s。</p>
        <table><thead><tr><th>字段</th><th>值</th></tr></thead><tbody>{rows}</tbody></table>
      </section>"""
        else:
            recog_html = f"""
      <section class="card">
        <h2>图框识读联动</h2>
        <p class="warn">未执行：{html.escape(str(r.get('error', '')))}</p>
      </section>"""

    warnings_html = ""
    if d.get("warnings"):
        items = "".join(f"<li>{html.escape(w)}</li>" for w in d["warnings"])
        warnings_html = f'<section class="card"><h2>提示</h2><ul class="warn">{items}</ul></section>'

    def dl(name: str, label: str) -> str:
        if not name or not os.path.isfile(os.path.join(run_dir, name)):
            return ""
        return f'<a class="btn" href="{html.escape(name)}">{html.escape(label)}</a>'

    downloads = " ".join([
        dl("result.dxf", "下载 DXF"),
        dl("result.svg", "下载 SVG"),
        dl("report.json", "下载 JSON"),
        dl(d.get("files", {}).get("recognized", ""), "下载标准化 DXF"),
    ])

    options_json = html.escape(json.dumps(m.get("options", {}), ensure_ascii=False, indent=1))

    doc = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>看图成图报告 · {html.escape(result.source_name)}</title>
<style>
:root {{
  --bg:#0f1419; --panel:#171e26; --line:#26313d; --text:#dbe4ee;
  --muted:#8b9bac; --accent:#37b3a4; --warn:#e0a53a; --mono:ui-monospace,Consolas,monospace;
}}
* {{ box-sizing:border-box; }}
body {{ margin:0; background:var(--bg); color:var(--text);
  font-family:"Microsoft YaHei","PingFang SC","Segoe UI",sans-serif; line-height:1.65; }}
.wrap {{ max-width:1180px; margin:0 auto; padding:34px 28px 70px; }}
header {{ border-bottom:1px solid var(--line); padding-bottom:20px; margin-bottom:24px; }}
.kicker {{ color:var(--accent); font-size:13px; letter-spacing:.12em; }}
h1 {{ font-size:27px; margin:6px 0 8px; }}
.sub {{ color:var(--muted); font-size:14px; }}
.stats {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr));
  gap:12px; margin:22px 0 28px; }}
.stat {{ background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }}
.stat .k {{ color:var(--muted); font-size:12px; }}
.stat .v {{ font-size:24px; font-weight:600; margin-top:4px; }}
.stat .v small {{ font-size:12px; color:var(--muted); font-weight:400; margin-left:4px; }}
.card {{ background:var(--panel); border:1px solid var(--line); border-radius:12px;
  padding:20px 22px; margin-bottom:18px; }}
section h2 {{ font-size:17px; margin:0 0 10px; }}
.steps {{ display:flex; flex-direction:column; gap:14px; }}
.step {{ background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:16px 18px; }}
.step-head {{ display:flex; align-items:baseline; gap:10px; }}
.step-head h3 {{ font-size:16px; margin:0; flex:1; }}
.idx {{ font-family:var(--mono); color:var(--accent); font-size:13px; }}
.ms {{ color:var(--muted); font-size:12px; font-family:var(--mono); }}
.detail {{ color:var(--muted); font-size:13.5px; margin:6px 0 12px; }}
figure {{ margin:0; background:#fff; border-radius:8px; overflow:hidden; border:1px solid var(--line); }}
figure img {{ display:block; width:100%; height:auto; }}
.metrics {{ font-family:var(--mono); font-size:12px; color:var(--muted); margin-top:10px; word-break:break-all; }}
.ph {{ padding:26px; text-align:center; color:#667; font-size:13px; background:#fafbfc; }}
table {{ width:100%; border-collapse:collapse; font-size:13.5px; margin-top:10px; }}
th,td {{ text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); }}
th {{ color:var(--muted); font-weight:500; }}
.warn {{ color:var(--warn); }}
.btns {{ display:flex; flex-wrap:wrap; gap:10px; margin-top:8px; }}
.btn {{ display:inline-block; padding:8px 14px; border:1px solid var(--accent); color:var(--accent);
  border-radius:7px; text-decoration:none; font-size:13px; }}
.btn:hover {{ background:rgba(55,179,164,.12); }}
.two {{ display:grid; grid-template-columns:1fr 1fr; gap:16px; }}
@media (max-width:860px) {{ .two {{ grid-template-columns:1fr; }} }}
pre {{ background:#0b0f13; border:1px solid var(--line); border-radius:8px; padding:12px;
  font-size:12px; overflow:auto; color:#9fb0c0; }}
footer {{ color:var(--muted); font-size:12px; margin-top:32px; }}
</style>
</head>
<body>
<div class="wrap">
<header>
  <div class="kicker">IMAGE → CAD · 看图成图报告</div>
  <h1>{html.escape(result.source_name)}</h1>
  <div class="sub">{html.escape(result.created_at)} · {result.source_width}×{result.source_height} px ·
    {_num(result.elapsed_ms, 0)} ms · 单位 {html.escape(str(m.get('unit', 'mm')))}</div>
</header>

<div class="stats">
  <div class="stat"><div class="k">直线段</div><div class="v">{m.get('segments', 0)}</div></div>
  <div class="stat"><div class="k">圆</div><div class="v">{m.get('circles', 0)}</div></div>
  <div class="stat"><div class="k">闭合矩形</div><div class="v">{m.get('rects', 0)}</div></div>
  <div class="stat"><div class="k">文字行</div><div class="v">{m.get('text_boxes', 0)}<small>{m.get('ocr_lines', 0)} 行 OCR</small></div></div>
  <div class="stat"><div class="k">还原 F1</div><div class="v">{_num(q.get('f1', 0))}<small>P {_num(q.get('precision', 0))} / R {_num(q.get('recall', 0))}</small></div></div>
  <div class="stat"><div class="k">贴合偏差</div><div class="v">{_num(q.get('chamfer_px', 0), 1)}<small>px</small></div></div>
</div>

<section class="card">
  <h2>原图与矢量化结果</h2>
  <div class="two">
    <figure>{_img_tag(run_dir, d['files'].get('source', ''), '原图')}</figure>
    <figure>{_img_tag(run_dir, 'preview.png', 'CAD 预览')}</figure>
  </div>
  <div class="btns">{downloads}</div>
</section>

<section class="card">
  <h2>生成过程（每一步都可核对）</h2>
  <div class="steps">{''.join(step_cards)}</div>
</section>

<section class="card">
  <h2>质量自检 · 红色=原图墨迹，蓝色=矢量重绘</h2>
  <figure>{_img_tag(run_dir, 'overlay.png', '叠加诊断')}</figure>
  <p class="detail">F1 {_num(q.get('f1', 0))}（精确率 {_num(q.get('precision', 0))} / 召回率 {_num(q.get('recall', 0))}），
     双向平均贴合偏差 {_num(q.get('chamfer_px', 0), 2)} px。{html.escape(str(q.get('note', '')))}</p>
</section>

{recog_html}
{warnings_html}

<section class="card">
  <h2>参数快照</h2>
  <pre>{options_json}</pre>
</section>

<footer>由 CAD 双模式智能识图工具 v2.0 · 看图成图管线自动生成。所有处理均为本地离线执行。</footer>
</div>
</body>
</html>"""

    path = os.path.join(run_dir, "report.html")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(doc)
    return path

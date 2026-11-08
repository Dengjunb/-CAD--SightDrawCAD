# -*- coding: utf-8 -*-
r"""
cli.py
======
命令行入口：批量/单图「看图成图」，以及启动本地 Web 界面。

用法示例：
    python -m image2cad run demo\images\01-零件图-干净.png --out out
    python -m image2cad run scan.png --sheet-width 420 --unit mm --recognition
    python -m image2cad batch demo\images --out out
    python -m image2cad titleblock 示例图纸\示例1-行列式.dxf --out out\tb
    python -m image2cad serve --port 8710 --open

设计取舍：
    * 参数用 argparse 显式列出常用项，其余通过 --opt key=value 透传，避免参数表膨胀；
    * 输出中文、带数字（图元数/F1/耗时），便于直接贴进验收记录；
    * 退出码：0 成功、1 失败（便于脚本判断）。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, List, Optional

from .config import Options
from .pipeline import PipelineError, run as run_pipeline


def _parse_opt(pairs: List[str]) -> Dict[str, Any]:
    """把 --opt key=value 解析成字典（value 自动识别 int/float/bool）。"""
    out: Dict[str, Any] = {}
    for item in pairs:
        if "=" not in item:
            continue
        key, raw = item.split("=", 1)
        low = raw.strip().lower()
        if low in ("true", "yes", "1"):
            out[key] = True
        elif low in ("false", "no", "0"):
            out[key] = False
        else:
            try:
                out[key] = int(raw)
            except ValueError:
                try:
                    out[key] = float(raw)
                except ValueError:
                    out[key] = raw
    return out


def _print_run(result, out_root: str) -> None:
    """把一次运行的关键结论打印成表格样式（中文）。"""
    d = result.to_dict()
    print("=" * 72)
    print(f"图片：{result.source_name}  ({result.source_width}×{result.source_height})")
    print(f"耗时：{result.elapsed_ms / 1000:.2f}s   输出目录：{os.path.join(out_root, result.run_id)}")
    print("-" * 72)
    for st in d["steps"]:
        print(f"[{st['key']:<11}] {st['title']:<8} {st['ms']:>7.1f}ms  {st['detail']}")
    print("-" * 72)
    m, q = d["metrics"], d["quality"]
    print(f"图元：线段 {m['segments']}  圆 {m['circles']}  矩形 {m['rects']}  多段线 {m.get('polylines', 0)}  文字区 {m['text_boxes']}")
    print(f"OCR：{m.get('ocr_lines', 0)} 行 / {m.get('text_characters', 0)} 字")
    print(f"质量：F1 {q['f1']:.2f} (P {q['precision']:.2f} / R {q['recall']:.2f})，"
          f"贴合偏差 {q['chamfer_px']:.2f}px")
    print(f"产物：{d['files'].get('dxf')} / {d['files'].get('svg')} / report.html")
    if d.get("recognition"):
        r = d["recognition"]
        if r.get("ok"):
            print(f"识读联动：配对 {r['matched']} 项，空值 {r['empty']} 项，未匹配 {r['unmatched']} 项")
            for p in r.get("pairs", [])[:10]:
                print(f"    {p['label']} -> {p['value']}")
        else:
            print(f"识读联动：跳过（{r.get('error')}）")
    if d.get("warnings"):
        for w in d["warnings"]:
            print(f"提示：{w}")
    print("=" * 72)


def cmd_run(args) -> int:
    options = Options.from_dict(_parse_opt(args.opt or []))
    if args.sheet_width is not None:
        options.sheet_width_mm = float(args.sheet_width)
    if args.scale_mode:
        options.scale_mode = args.scale_mode
    if args.unit:
        options.unit = args.unit
    if args.dpi is not None:
        options.dpi = float(args.dpi)
    if args.denoise is not None:
        options.denoise = int(args.denoise)
    if args.max_side is not None:
        options.max_side_px = int(args.max_side)
    if args.no_ocr:
        options.ocr = False
    options.sanitize()

    try:
        result = run_pipeline(args.image, args.out, options, recognition=args.recognition)
    except PipelineError as exc:
        print(f"失败：{exc}", file=sys.stderr)
        return 1
    _print_run(result, args.out)
    if args.json:
        print(json.dumps(result.to_dict(), ensure_ascii=False, indent=1))
    return 0


def cmd_batch(args) -> int:
    exts = (".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".webp")
    files: List[str] = []
    for name in sorted(os.listdir(args.dir)):
        if name.lower().endswith(exts):
            files.append(os.path.join(args.dir, name))
    if not files:
        print(f"目录里没有图片：{args.dir}", file=sys.stderr)
        return 1
    failures = 0
    for path in files:
        options = Options.from_dict(_parse_opt(args.opt or []))
        options.sanitize()
        try:
            result = run_pipeline(path, args.out, options, recognition=args.recognition)
            _print_run(result, args.out)
        except PipelineError as exc:
            failures += 1
            print(f"失败：{os.path.basename(path)} -- {exc}", file=sys.stderr)
    print(f"批处理完成：{len(files) - failures}/{len(files)} 成功")
    return 0 if failures == 0 else 1


def cmd_titleblock(args) -> int:
    """模式 A 的命令行入口：识读单个 .dxf/.dwg，打印字段与产物路径。"""
    from .mode_a import run_titleblock

    out_dir = args.out or os.path.join("out", "titleblock")
    os.makedirs(out_dir, exist_ok=True)
    result = run_titleblock(os.path.abspath(args.file), out_dir, export_json=True)
    if not result.get("ok"):
        print(f"失败：{result.get('error')}", file=sys.stderr)
        return 1
    print("=" * 72)
    print(f"图纸：{result['source']['name']}   耗时 {result['elapsed_s']:.3f}s")
    print(f"标题栏区域：{result['region']}")
    print(f"配对 {result['stats'].get('matched_pairs', 0)} 项，"
          f"空值 {result['stats'].get('empty_values', 0)} 项，"
          f"未匹配 {result['stats'].get('unmatched', 0)} 项")
    print("-" * 72)
    for pair in result.get("pairs", []):
        label = pair.get("label") or "（未命名）"
        value = pair.get("value") or "（空值）"
        print(f"  {label:<10} -> {value}")
    print("-" * 72)
    print(f"标准化副本：{os.path.join(out_dir, result['files'].get('recognized', ''))}")
    print(f"识读 JSON：{os.path.join(out_dir, result['files'].get('json', ''))}")
    print("=" * 72)
    return 0


def cmd_serve(args) -> int:
    from .server import serve
    serve(host=args.host, port=args.port, out_root=args.out, open_browser=args.open)
    return 0


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="image2cad",
        description="看图成图：把图纸照片/扫描件转成可编辑的 DXF，并展示完整生成过程。",
    )
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_run = sub.add_parser("run", help="处理单张图片")
    p_run.add_argument("image", help="图片路径（png/jpg/bmp/tif/webp）")
    p_run.add_argument("--out", default="out/runs", help="输出根目录（默认 out/runs）")
    p_run.add_argument("--sheet-width", type=float, default=None, help="图幅宽度 mm（默认 297）")
    p_run.add_argument("--scale-mode", choices=["sheet", "dpi", "px"], default=None)
    p_run.add_argument("--unit", choices=["mm", "cm", "m", "inch"], default=None)
    p_run.add_argument("--dpi", type=float, default=None, help="扫描 DPI（scale-mode=dpi 时用）")
    p_run.add_argument("--denoise", type=int, default=None, help="去噪强度 0-3")
    p_run.add_argument("--max-side", type=int, default=None, help="处理长边像素上限")
    p_run.add_argument("--no-ocr", action="store_true", help="不调用 Windows OCR")
    p_run.add_argument("--recognition", action="store_true", help="生成 DXF 后联动图框识读")
    p_run.add_argument("--opt", action="append", default=[], metavar="KEY=VALUE",
                       help="透传任意 Options 参数，如 --opt min_line_ratio=0.01")
    p_run.add_argument("--json", action="store_true", help="额外打印完整 JSON")
    p_run.set_defaults(func=cmd_run)

    p_batch = sub.add_parser("batch", help="批量处理目录下所有图片")
    p_batch.add_argument("dir", help="图片目录")
    p_batch.add_argument("--out", default="out/runs")
    p_batch.add_argument("--recognition", action="store_true")
    p_batch.add_argument("--opt", action="append", default=[])
    p_batch.set_defaults(func=cmd_batch)

    p_tb = sub.add_parser("titleblock", help="图框识读（模式 A）：识读单个 dxf/dwg")
    p_tb.add_argument("file", help=".dxf / .dwg 图纸路径")
    p_tb.add_argument("--out", default="out/titleblock", help="输出目录（默认 out/titleblock）")
    p_tb.set_defaults(func=cmd_titleblock)

    p_serve = sub.add_parser("serve", help="启动本地 Web 界面")
    p_serve.add_argument("--host", default="127.0.0.1")
    p_serve.add_argument("--port", type=int, default=8710)
    p_serve.add_argument("--out", default="out/runs")
    p_serve.add_argument("--open", action="store_true", help="启动后自动打开浏览器")
    p_serve.set_defaults(func=cmd_serve)
    return ap


def main(argv: Optional[List[str]] = None) -> int:
    ap = build_parser()
    args = ap.parse_args(argv)
    return int(args.func(args) or 0)


if __name__ == "__main__":
    raise SystemExit(main())

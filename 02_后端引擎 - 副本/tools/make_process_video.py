# -*- coding: utf-8 -*-
"""
make_process_video.py
=====================
把一次「看图成图」的 14 个步骤做成一段可分享的过程视频（MP4）。

为什么需要：
    Web 界面里的「播放过程」只能在有环境时看；评审/客户/汇报场景更需要一个
    双击就能播、能发给别人的文件——把「图片 → 每一步 → CAD」按时间轴讲清楚。

编码方式：
    用 OpenCV VideoWriter（MP4V）流式写入（稳定、无需外置依赖），随后如果检测到
    imageio-ffmpeg 就用它转成 H.264（yuv420p + faststart），保证浏览器/手机/平台上传
    都能直接播放；没有 imageio-ffmpeg 时保留 MP4V，仍可在 VLC / Windows 播放器播放。
用法：
    python tools/make_process_video.py out/final/<runId> --out demo/process/01.mp4
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from typing import Any, Dict, Iterator, List, Optional, Tuple

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

W, H, FPS = 1280, 720, 30
BG = (19, 24, 31)
CARD = (28, 36, 46)
TEXT = (224, 232, 241)
MUTED = (139, 155, 170)
ACCENT = (55, 179, 164)
FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
]


def _font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    paths = ([r"C:\Windows\Fonts\msyhbd.ttc"] if bold else []) + FONT_CANDIDATES
    for p in paths:
        if os.path.isfile(p):
            try:
                return ImageFont.truetype(p, size)
            except OSError:
                continue
    return ImageFont.load_default()


def _wrap(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont,
          max_w: int) -> List[str]:
    """按像素宽度换行（中文逐字测量，避免按字符数硬切）。"""
    lines: List[str] = []
    cur = ""
    for ch in str(text):
        if ch == "\n":
            lines.append(cur)
            cur = ""
            continue
        if draw.textlength(cur + ch, font=font) > max_w and cur:
            lines.append(cur)
            cur = ch
        else:
            cur += ch
    if cur:
        lines.append(cur)
    return lines


def _fit(img: Image.Image, box_w: int, box_h: int) -> Image.Image:
    img = img.convert("RGB")
    k = min(box_w / img.width, box_h / img.height)
    return img.resize((max(1, int(img.width * k)), max(1, int(img.height * k))), Image.LANCZOS)


def _base_frame() -> Tuple[Image.Image, ImageDraw.ImageDraw]:
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 64], fill=(15, 20, 26))
    d.text((36, 18), "看图成图 · Image → CAD", font=_font(24, True), fill=TEXT)
    d.text((W - 300, 20), "生成过程回放", font=_font(18), fill=MUTED)
    return img, d


def _draw_step(data: Dict[str, Any], index: int, total: int, run_dir: str) -> Image.Image:
    img, d = _base_frame()
    ox, oy, ow, oh = 36, 88, 776, 556
    d.rounded_rectangle([ox, oy, ox + ow, oy + oh], radius=12, fill=CARD)
    path = os.path.join(run_dir, str(data.get("image", "")))
    if os.path.isfile(path):
        try:
            thumb = _fit(Image.open(path), ow - 24, oh - 24)
            img.paste(thumb, (ox + (ow - thumb.width) // 2, oy + (oh - thumb.height) // 2))
        except Exception:
            pass

    px = 840
    d.text((px, 92), f"{index:02d} / {total:02d}", font=_font(18, True), fill=ACCENT)
    d.text((px, 122), str(data.get("title", "")), font=_font(32, True), fill=TEXT)
    y = 176
    for line in _wrap(d, str(data.get("detail", "")), _font(19), 400)[:6]:
        d.text((px, y), line, font=_font(19), fill=MUTED)
        y += 30
    metrics = {k: v for k, v in (data.get("metrics") or {}).items()
               if isinstance(v, (str, int, float))}
    y = max(y + 18, 330)
    d.text((px, y), "指标", font=_font(16, True), fill=ACCENT)
    y += 28
    for k, v in list(metrics.items())[:7]:
        d.text((px, y), str(k), font=_font(16), fill=MUTED)
        d.text((px + 150, y), str(v), font=_font(16), fill=TEXT)
        y += 26
    ms = data.get("ms")
    if isinstance(ms, (int, float)) and ms > 0:
        d.text((px, y + 6), f"耗时 {ms:.0f} ms", font=_font(16), fill=MUTED)

    d.rectangle([36, 668, W - 36, 674], fill=(45, 56, 68))
    if total:
        d.rectangle([36, 668, 36 + int((W - 72) * index / total), 674], fill=ACCENT)
    d.text((36, 686), "CAD 双模式智能识图工具 v2.0 · 本地离线处理", font=_font(14), fill=MUTED)
    return img


def _intro(report: Dict[str, Any]) -> Image.Image:
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 6], fill=ACCENT)
    d.text((60, 150), "看图成图 · Image → CAD", font=_font(20, True), fill=ACCENT)
    d.text((60, 196), "一张图纸照片，如何一步步变成 CAD", font=_font(46, True), fill=TEXT)
    src = report.get("source", {})
    d.text((60, 300), f"输入：{src.get('name', '')}   {src.get('width', '')}×{src.get('height', '')} px",
           font=_font(22), fill=MUTED)
    d.text((60, 350), "处理：预处理 → 文字区保护 → 直线/圆/矩形 → OCR → DXF → 质量自检",
           font=_font(20), fill=MUTED)
    d.text((60, 402), f"输出：{len(report.get('steps', []))} 个可视化步骤 · 可编辑 DXF · 过程报告",
           font=_font(20), fill=MUTED)
    d.text((60, 540), "CAD 双模式智能识图工具 v2.0", font=_font(18, True), fill=TEXT)
    d.text((60, 574), "全部本地离线执行，原始图片不被修改", font=_font(16), fill=MUTED)
    return img


def _outro(report: Dict[str, Any]) -> Image.Image:
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 6], fill=ACCENT)
    d.text((60, 100), "生成结果", font=_font(20, True), fill=ACCENT)
    d.text((60, 140), "从像素到可编辑 CAD", font=_font(42, True), fill=TEXT)
    m = report.get("metrics", {})
    q = report.get("quality", {})
    stats = [
        ("直线段", m.get("segments", "-")),
        ("圆", m.get("circles", "-")),
        ("闭合矩形", m.get("rects", "-")),
        ("文字区", m.get("text_boxes", "-")),
        ("还原 F1", f"{float(q.get('f1', 0)):.2f}"),
        ("总耗时", f"{float(m.get('elapsed_ms', 0)) / 1000:.1f}s"),
    ]
    for i, (k, v) in enumerate(stats):
        col, row = i % 3, i // 3
        x = 60 + col * 390
        y = 240 + row * 110
        d.text((x, y), k, font=_font(18), fill=MUTED)
        d.text((x, y + 30), str(v), font=_font(40, True), fill=TEXT)
    d.text((60, 520), "DXF 已生成：图层化、闭合矩形、OCR 文字，可直接在 CAD 中编辑",
           font=_font(20), fill=MUTED)
    d.text((60, 560), "图片 → DXF → 图框字段（可选联动）", font=_font(20), fill=ACCENT)
    return img


def _bgr(img: Image.Image) -> np.ndarray:
    return cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)


def _hold(img: Image.Image, seconds: float) -> Iterator[np.ndarray]:
    frame = _bgr(img)
    for _ in range(max(1, int(FPS * seconds))):
        yield frame


def _transition(a: Image.Image, b: Image.Image, frames: int = 12) -> Iterator[np.ndarray]:
    aa = _bgr(a).astype(np.float32)
    bb = _bgr(b).astype(np.float32)
    for i in range(1, frames + 1):
        k = i / (frames + 1)
        yield ((1 - k) * aa + k * bb).astype(np.uint8)


def _frames(report: Dict[str, Any], run_dir: str, step_seconds: float) -> Iterator[np.ndarray]:
    steps = [s for s in report.get("steps", []) if s.get("image")]
    total = len(steps)
    intro = _intro(report)
    yield from _hold(intro, 2.2)
    prev = intro
    for i, step in enumerate(steps, 1):
        cur = _draw_step(step, i, total, run_dir)
        yield from _transition(prev, cur, 12)
        yield from _hold(cur, step_seconds)
        prev = cur
    outro = _outro(report)
    yield from _transition(prev, outro, 14)
    yield from _hold(outro, 2.6)


def _transcode_h264(path: str) -> bool:
    """
    用 imageio-ffmpeg 自带的 ffmpeg 把 MP4V 转成 H.264（yuv420p + faststart）。

    为什么需要：浏览器、手机、抖音/B 站上传都要求 H.264；OpenCV 只能写 MP4V。
    本机实测 DSH 自带的 ffmpeg 受安全软件限制无法写文件，而 imageio-ffmpeg
    下载到 Python site-packages 的 ffmpeg 可以正常转码，因此优先用它。
    """
    try:
        import imageio_ffmpeg
    except Exception:
        return False
    ff = imageio_ffmpeg.get_ffmpeg_exe()
    if not ff or not os.path.isfile(ff):
        return False
    tmp = path + ".h264.mp4"
    cmd = [ff, "-y", "-hide_banner", "-loglevel", "error", "-i", path,
           "-c:v", "libx264", "-preset", "medium", "-crf", "22",
           "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", tmp]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=1800)
        if proc.returncode == 0 and os.path.isfile(tmp) and os.path.getsize(tmp) > 1024:
            os.replace(tmp, path)
            return True
    except Exception:
        pass
    try:
        if os.path.isfile(tmp):
            os.remove(tmp)
    except OSError:
        pass
    return False


def build(run_dir: str, out_mp4: str, step_seconds: float = 1.4) -> str:
    run_dir = os.path.abspath(run_dir)
    with open(os.path.join(run_dir, "report.json"), "r", encoding="utf-8") as fh:
        report = json.load(fh)
    if not [s for s in report.get("steps", []) if s.get("image")]:
        raise RuntimeError("该运行没有步骤截图，无法生成过程视频")

    os.makedirs(os.path.dirname(os.path.abspath(out_mp4)), exist_ok=True)
    writer = cv2.VideoWriter(out_mp4, cv2.VideoWriter_fourcc(*"mp4v"), FPS, (W, H))
    if not writer.isOpened():
        raise RuntimeError("无法创建 MP4 编码器（OpenCV VideoWriter 打开失败）")
    count = 0
    try:
        for frame in _frames(report, run_dir, step_seconds):
            writer.write(frame)
            count += 1
    finally:
        writer.release()
    if count == 0 or not os.path.isfile(out_mp4):
        raise RuntimeError("视频写入失败")
    _transcode_h264(out_mp4)
    return out_mp4


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="把一次看图成图运行渲染成过程视频（MP4）")
    ap.add_argument("run_dir", help="out/final/<runId> 目录（含 report.json 与 steps/）")
    ap.add_argument("--out", default="", help="输出 mp4（默认进程目录下 <runId>_生成过程.mp4）")
    ap.add_argument("--step-seconds", type=float, default=1.4, help="每步停留秒数（默认 1.4）")
    args = ap.parse_args(argv)

    run_dir = os.path.abspath(args.run_dir)
    out = args.out or os.path.join(os.path.dirname(run_dir), os.path.basename(run_dir) + "_生成过程.mp4")
    try:
        path = build(run_dir, out, args.step_seconds)
    except Exception as exc:
        print(f"失败：{exc}", file=sys.stderr)
        return 1
    size = os.path.getsize(path) / (1024 * 1024)
    print(f"已生成：{path}（{size:.1f} MB）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

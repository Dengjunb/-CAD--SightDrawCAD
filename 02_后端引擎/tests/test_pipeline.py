# -*- coding: utf-8 -*-
"""
test_pipeline.py
================
看图成图主流水线的集成测试（Lead 维护）。

覆盖：
    * 预处理返回契约字段齐全；
    * 小图流水线能跑通并落盘 DXF / SVG / JSON / 报告；
    * DXF 图层、单位、文字区与 OCR 文字是否正确写出；
    * 矢量→像素质量自检数值在合理范围；
    * 不依赖 OCR（关闭 OCR 时也能出结果）。
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from image2cad.config import Options          # noqa: E402
from image2cad.pipeline import run           # noqa: E402
from image2cad import imaging, vectorize     # noqa: E402


def _make_drawing(path: str) -> None:
    """生成一张 900×640 的合成图纸：外框 + 内框 + 一条斜线 + 一个圆 + 一段标题栏。"""
    img = np.full((640, 900, 3), 255, dtype=np.uint8)
    ink = (25, 25, 25)
    cv2.rectangle(img, (50, 50), (850, 590), ink, 3)
    cv2.rectangle(img, (120, 120), (520, 420), ink, 3)
    cv2.line(img, (120, 120), (520, 420), ink, 3)
    cv2.circle(img, (700, 220), 70, ink, 3)
    cv2.rectangle(img, (560, 430), (850, 590), ink, 3)
    for y in (470, 510, 550):
        cv2.line(img, (560, y), (850, y), ink, 2)
    cv2.imencode(".png", img)[1].tofile(path)


class TestPipeline(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.mkdtemp(prefix="i2c_test_")
        cls.image = os.path.join(cls.tmp, "drawing.png")
        _make_drawing(cls.image)

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_preprocess_contract(self) -> None:
        gray = imaging.load_gray(self.image)
        self.assertEqual(gray.ndim, 2)
        opts = Options()
        opts.sanitize()
        pre = imaging.preprocess(gray, opts)
        for key in ("gray", "mask", "clean", "skeleton", "text_mask", "text_boxes",
                    "skew_deg", "method", "stroke_width", "stats"):
            self.assertIn(key, pre)
        self.assertEqual(pre["clean"].shape, gray.shape)
        self.assertGreater(int(np.count_nonzero(pre["clean"])), 1000)

    def test_vectorize_returns_geometry(self) -> None:
        gray = imaging.load_gray(self.image)
        opts = Options()
        opts.sanitize()
        pre = imaging.preprocess(gray, opts)
        segs, circles, rects = vectorize.run(
            pre["clean"], pre["text_mask"], pre["text_boxes"], pre["gray"], opts,
            gray.shape[1], gray.shape[0])
        self.assertGreaterEqual(len(segs), 4)       # 外框/内框/斜线/标题栏横线
        self.assertGreaterEqual(len(circles), 1)    # 半径 70 的圆
        self.assertGreaterEqual(len(rects), 1)      # 闭合矩形

    def test_pipeline_outputs(self) -> None:
        opts = Options()
        opts.ocr = False              # 测试不依赖系统 OCR
        opts.run_recognition = False
        result = run(self.image, self.tmp, opts)
        run_dir = os.path.join(self.tmp, result.run_id)
        for name in ("result.dxf", "result.svg", "report.json", "report.html",
                     "preview.png", "overlay.png"):
            self.assertTrue(os.path.isfile(os.path.join(run_dir, name)), name)

        # 步骤齐全且每步有说明
        keys = [s.key for s in result.steps]
        for key in ("load", "gray", "binarize", "deskew", "clean", "text",
                    "skeleton", "lines", "circles", "rects", "ocr", "dxf",
                    "quality"):
            self.assertIn(key, keys)
        self.assertGreaterEqual(len(result.steps), 12)
        for step in result.steps:
            self.assertTrue(step.title and step.detail)

        # 质量自检应有合理数值（合成图很干净，F1 应较高）
        self.assertGreater(result.quality.f1, 0.6)
        self.assertGreater(result.scene.entity_count, 5)

        # report.json 可读且结构稳定
        with open(os.path.join(run_dir, "report.json"), "r", encoding="utf-8") as fh:
            data = json.load(fh)
        for key in ("runId", "steps", "metrics", "quality", "files", "scene"):
            self.assertIn(key, data)

    def test_dxf_structure(self) -> None:
        import ezdxf

        opts = Options()
        opts.ocr = False
        opts.run_recognition = False
        result = run(self.image, self.tmp, opts)
        dxf_path = os.path.join(self.tmp, result.run_id, "result.dxf")
        doc = ezdxf.readfile(dxf_path)
        self.assertEqual(int(doc.header.get("$INSUNITS")), 4)  # mm
        names = {layer.dxf.name for layer in doc.layers}
        self.assertIn(opts.layer_outline, names)
        self.assertIn(opts.layer_text, names)
        types = {e.dxftype() for e in doc.modelspace()}
        self.assertIn("LINE", types)
        self.assertIn("CIRCLE", types)
        self.assertIn("LWPOLYLINE", types)


if __name__ == "__main__":
    unittest.main()

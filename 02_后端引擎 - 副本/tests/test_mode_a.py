# -*- coding: utf-8 -*-
"""
test_mode_a.py
==============
模式 A「图框识读」Web 封装的集成测试。

覆盖：
    * 对项目自带示例图框能跑出字段配对与统计；
    * 预览图、标准化副本、JSON 都真实落盘且可被前端引用；
    * 损坏文件返回中文错误而不是抛异常；
    * 识读步骤结构稳定（前端依赖 key/title/detail/metrics）。
"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from image2cad import mode_a  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAMPLE = os.path.join(ROOT, "示例图纸", "示例1-行列式.dxf")


class TestModeA(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.mkdtemp(prefix="i2c_tb_")

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_sample_recognized(self) -> None:
        self.assertTrue(os.path.isfile(SAMPLE), "缺少示例图纸")
        res = mode_a.run_titleblock(SAMPLE, self.tmp)
        self.assertTrue(res["ok"], res.get("error"))
        self.assertGreaterEqual(len(res["pairs"]), 6)
        labels = {p["label"] for p in res["pairs"]}
        for expected in ("材料", "比例", "设计"):
            self.assertIn(expected, labels)
        self.assertGreater(res["stats"]["text_elements"], 5)
        self.assertEqual(len(res["steps"]), 6)
        for step in res["steps"]:
            self.assertTrue(step["title"] and step["detail"])
            self.assertIsInstance(step["metrics"], dict)

        for key in ("preview_before", "preview_after", "recognized", "json"):
            rel = res["files"].get(key) or ""
            self.assertTrue(rel, f"{key} 未生成")
            self.assertTrue(os.path.isfile(os.path.join(self.tmp, rel)), rel)
        # 预览是 PNG，标准化副本是 DXF
        self.assertTrue(res["files"]["preview_before"].endswith(".png"))
        self.assertTrue(res["files"]["recognized"].endswith(".dxf"))

    def test_corrupt_file_returns_error(self) -> None:
        bad = os.path.join(self.tmp, "bad.dxf")
        with open(bad, "wb") as fh:
            fh.write(b"not a dxf at all")
        res = mode_a.run_titleblock(bad, self.tmp)
        self.assertFalse(res["ok"])
        self.assertTrue(res["error"])
        self.assertIn("失败", res["error"] + "失败")  # 中文错误可展示

    def test_missing_file(self) -> None:
        res = mode_a.run_titleblock(os.path.join(self.tmp, "nope.dxf"), self.tmp)
        self.assertFalse(res["ok"])


if __name__ == "__main__":
    unittest.main()

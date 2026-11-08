# -*- coding: utf-8 -*-
"""
test_manual.py
==============
自动 / 手动分步执行的集成测试。

覆盖：
    * 手动会话从「读取图像」开始并逐步推进到 14 步完成；
    * 每步暂停、步骤可累积，最终生成 DXF / 报告；
    * 改参数后「应用参数并重跑」会从最早受影响的步骤重跑（二值化→预处理、最短线段→直线）；
    * 停止后状态为 stopped，不再继续执行。
"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from image2cad import manual           # noqa: E402
from image2cad.config import Options  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEMO = os.path.join(ROOT, "demo", "images", "01-零件图-干净.png")


class TestManualSession(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="i2c_manual_")
        self.run_dir = os.path.join(self.tmp, "run-1")
        os.makedirs(self.run_dir)
        shutil.copyfile(DEMO, os.path.join(self.run_dir, "source.png"))
        self.source = os.path.join(self.run_dir, "source.png")
        self.options = Options()
        self.options.ocr = False
        self.options.run_recognition = False

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_full_manual_run(self) -> None:
        payload = manual.start_session(self.run_dir, self.source, self.options)
        self.assertEqual(payload["status"], "paused")
        self.assertEqual(payload["stage"]["index"], 2)      # 第 1 步读取已完成
        self.assertEqual(len(payload["steps"]), 1)

        guard = 0
        while payload["status"] == "paused" and guard < 12:
            payload = manual.advance(self.run_dir, self.options)
            guard += 1
        self.assertEqual(payload["status"], "done", payload.get("error"))
        self.assertEqual(len(payload["steps"]), 14)
        result = payload["result"]
        self.assertGreaterEqual(result["metrics"]["segments"], 40)
        self.assertGreater(result["quality"]["f1"], 0.5)
        for name in ("result.dxf", "result.svg", "report.json", "report.html"):
            self.assertTrue(os.path.isfile(os.path.join(self.run_dir, name)), name)

    def test_apply_options_reruns_earliest_stage(self) -> None:
        manual.start_session(self.run_dir, self.source, self.options)
        manual.advance(self.run_dir, self.options)          # 预处理
        manual.advance(self.run_dir, self.options)          # 直线
        # 改二值化相关参数 -> 应回到预处理
        new_options = Options.from_dict({"denoise": 2})
        payload = manual.apply_options(self.run_dir, new_options)
        self.assertEqual(payload["status"], "paused")
        self.assertEqual(payload["stage"]["key"], "lines")  # 下一步是直线
        self.assertEqual(len(payload["steps"]), 7)          # load + 6 预处理
        # 只改直线参数 -> 从直线重跑
        manual.advance(self.run_dir, new_options)           # 直线
        new_options = Options.from_dict({"denoise": 2, "min_line_ratio": 0.02})
        payload = manual.apply_options(self.run_dir, new_options)
        self.assertEqual(payload["stage"]["key"], "circles")
        self.assertEqual(len(payload["steps"]), 8)

    def test_stop(self) -> None:
        manual.start_session(self.run_dir, self.source, self.options)
        payload = manual.stop(self.run_dir)
        self.assertEqual(payload["status"], "stopped")
        payload = manual.advance(self.run_dir, self.options)
        self.assertEqual(payload["status"], "stopped")


if __name__ == "__main__":
    unittest.main()

# -*- coding: utf-8 -*-
"""
test_imaging.py
===============
image2cad.imaging 的单元测试：读图（中文路径）、预处理契约、文字区保护、纠偏、
保边去噪、骨架化。

约定：所有二值图的语义都是 255=墨迹、0=背景；坐标原点左上、y 向下。
"""
from __future__ import annotations

import os
import sys
import unittest

import cv2
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from image2cad import imaging                    # noqa: E402
from image2cad.config import Options             # noqa: E402

DEMO = os.path.join(ROOT, "demo", "images")
CLEAN_PNG = os.path.join(DEMO, "01-零件图-干净.png")
PHOTO_JPG = os.path.join(DEMO, "02-零件图-拍照.jpg")

PREPROCESS_KEYS = {"gray", "hough_gray", "mask", "clean", "skeleton", "text_mask",
                   "text_boxes", "skew_deg", "method", "stroke_width", "stats",
                   "polarity", "bg_level"}


def _has_demo() -> bool:
    return os.path.exists(CLEAN_PNG) and os.path.exists(PHOTO_JPG)


class LoadGrayTest(unittest.TestCase):
    def test_missing_file_raises_ioerror(self):
        with self.assertRaises(IOError):
            imaging.load_gray(os.path.join(DEMO, "不存在的图.png"))

    @unittest.skipUnless(_has_demo(), "缺少 demo 图")
    def test_chinese_path_and_dtype(self):
        # cv2.imread 在 Windows 上读不了中文路径，必须走 np.fromfile + imdecode
        gray = imaging.load_gray(CLEAN_PNG)
        self.assertEqual(gray.dtype, np.uint8)
        self.assertEqual(gray.shape, (1600, 2200))
        self.assertGreater(int(gray.max()), 200)      # 白底
        self.assertLess(int(gray.min()), 80)          # 有墨线

    @unittest.skipUnless(os.path.exists(PHOTO_JPG), "缺少 demo 图")
    def test_jpg_load(self):
        gray = imaging.load_gray(PHOTO_JPG)
        self.assertEqual(gray.shape, (1600, 2200))


class SyntheticDenoiseTest(unittest.TestCase):
    def test_one_pixel_line_survives_denoise(self):
        """回归测试：默认去噪曾用 3×3 中值，把 1 像素宽的中心线整条抹掉。"""
        img = np.full((60, 160), 255, np.uint8)
        img[30, 20:140] = 120
        for level in (0, 1, 2, 3):
            out = imaging._denoise(img, level)
            # 强档（3）会有可接受的对比度下降，但必须仍明显暗于白底（>= 60 灰阶）
            self.assertGreaterEqual(255 - int(out[30, 80]), 60,
                                    "去噪档位 %d 破坏了 1px 细线" % level)

    def test_denoise_reduces_noise(self):
        rng = np.random.default_rng(3)
        img = np.full((80, 80), 250, np.float32)
        noisy = np.clip(img + rng.normal(0, 8, img.shape), 0, 255).astype(np.uint8)
        out = imaging._denoise(noisy, 2)
        self.assertLess(float(out[20:60, 20:60].std()), float(noisy[20:60, 20:60].std()))


class SkeletonizeTest(unittest.TestCase):
    def test_thinning_reduces_and_is_subset(self):
        mask = np.zeros((40, 40), np.uint8)
        mask[12:30, 12:30] = 255                       # 18×18 实心块
        skel = imaging.skeletonize(mask)
        self.assertEqual(skel.shape, mask.shape)
        self.assertEqual(skel.dtype, np.uint8)
        self.assertGreater(int(np.count_nonzero(skel)), 0)
        self.assertLess(int(np.count_nonzero(skel)) * 3, int(np.count_nonzero(mask)))
        self.assertTrue(np.all(mask[skel > 0] == 255), "骨架必须是墨迹的子集")

    def test_thin_line_stays_one_pixel(self):
        mask = np.zeros((40, 120), np.uint8)
        mask[20, 10:110] = 255
        skel = imaging.skeletonize(mask)
        self.assertEqual(int(np.count_nonzero(skel)), 100)
        self.assertTrue(np.all(skel[20, 10:110] == 255))

    def test_empty_mask(self):
        skel = imaging.skeletonize(np.zeros((20, 20), np.uint8))
        self.assertEqual(int(np.count_nonzero(skel)), 0)


class TextRegionTest(unittest.TestCase):
    @unittest.skipUnless(_has_demo(), "缺少 demo 图")
    def test_text_boxes_and_mask_non_empty(self):
        gray = imaging.load_gray(CLEAN_PNG)
        prep = imaging.preprocess(gray, Options())
        self.assertGreater(len(prep["text_boxes"]), 2, "标题栏有多行文字，文字区框不该少于 3 个")
        self.assertGreater(int(np.count_nonzero(prep["text_mask"])), 5000)
        for box in prep["text_boxes"]:
            self.assertEqual(len(box), 4)
            x, y, w, h = box
            self.assertGreater(w, 0)
            self.assertGreater(h, 0)
            # 框必须落在图像内（允许外扩）
            self.assertGreaterEqual(x, 0)
            self.assertGreaterEqual(y, 0)

    @unittest.skipUnless(_has_demo(), "缺少 demo 图")
    def test_title_text_is_masked(self):
        """标题「法兰盘零件图」的笔画应被文字区掩掉大部分（否则会变成假线段）。"""
        gray = imaging.load_gray(CLEAN_PNG)
        prep = imaging.preprocess(gray, Options())
        band = prep["mask"][110:180, 290:540] > 0
        mask_band = prep["text_mask"][110:180, 290:540] > 0
        self.assertGreater(int(band.sum()), 500)
        self.assertGreater(float(np.mean(mask_band[band])), 0.5)

    def test_detect_text_off(self):
        img = np.full((100, 200), 255, np.uint8)
        cv2.putText(img, "AB12", (10, 60), cv2.FONT_HERSHEY_SIMPLEX, 1.4, 20, 3)
        opts = Options()
        opts.detect_text = False
        prep = imaging.preprocess(img, opts)
        self.assertEqual(len(prep["text_boxes"]), 0)
        self.assertEqual(int(np.count_nonzero(prep["text_mask"])), 0)


class PreprocessContractTest(unittest.TestCase):
    @unittest.skipUnless(_has_demo(), "缺少 demo 图")
    def test_keys_shapes_and_values(self):
        gray = imaging.load_gray(CLEAN_PNG)
        prep = imaging.preprocess(gray, Options())
        self.assertEqual(set(prep.keys()), PREPROCESS_KEYS)
        shape = gray.shape
        for key in ("gray", "hough_gray", "mask", "clean", "skeleton", "text_mask"):
            self.assertEqual(prep[key].shape, shape, key)
            self.assertEqual(prep[key].dtype, np.uint8, key)
        for key in ("mask", "clean", "skeleton", "text_mask"):
            values = np.unique(prep[key])
            self.assertTrue(set(values.tolist()) <= {0, 255}, "%s 必须是 0/255" % key)
        self.assertIsInstance(prep["text_boxes"], list)
        self.assertIn(prep["method"], ("otsu", "adaptive", "sauvola"))
        self.assertGreater(prep["stroke_width"], 1.0)
        self.assertLess(prep["stroke_width"], 10.0)
        self.assertEqual(set(prep["stats"].keys()),
                         {"ink_ratio", "components_removed", "deskew_deg"})
        self.assertGreater(prep["stats"]["ink_ratio"], 0.005)
        self.assertLess(prep["stats"]["ink_ratio"], 0.10)
        self.assertGreater(prep["stats"]["components_removed"], 0)

    @unittest.skipUnless(_has_demo(), "缺少 demo 图")
    def test_clean_image_has_no_skew(self):
        gray = imaging.load_gray(CLEAN_PNG)
        prep = imaging.preprocess(gray, Options())
        self.assertEqual(prep["skew_deg"], 0.0)

    def test_deskew_sign_and_same_canvas(self):
        """合成一张倾斜 4° 的图：skew_deg 应为负（源图倾角），纠偏后残余倾角接近 0。"""
        img = np.full((600, 800), 255, np.uint8)
        for y in range(60, 560, 50):
            cv2.line(img, (60, y), (740, y), 25, 3)
        for x in range(60, 760, 100):
            cv2.line(img, (x, 60), (x, 540), 25, 3)
        matrix = cv2.getRotationMatrix2D((400, 300), 4.0, 1.0)
        rotated = cv2.warpAffine(img, matrix, (800, 600), flags=cv2.INTER_LINEAR,
                                 borderValue=255)
        opts = Options()
        prep = imaging.preprocess(rotated, opts)
        self.assertGreater(abs(prep["skew_deg"]), 2.0)
        self.assertLess(abs(prep["skew_deg"]), 8.0)
        self.assertLess(prep["skew_deg"], 0.0, "正角旋转（cv2 约定）的图像应报告负倾角")
        self.assertEqual(prep["gray"].shape, rotated.shape)
        residual = imaging.estimate_skew(prep["mask"])
        self.assertLessEqual(abs(residual), 0.6, "纠偏后残余倾角应接近 0")

        # 关掉纠偏时角度应保持为 0，且不旋转
        opts2 = Options()
        opts2.deskew = False
        prep2 = imaging.preprocess(rotated, opts2)
        self.assertEqual(prep2["skew_deg"], 0.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)

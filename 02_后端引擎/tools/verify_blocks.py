# -*- coding: utf-8 -*-
"""
tools/verify_blocks.py
======================
交付验证工具：检查输出目录中所有 *_recognized*.dxf 是否包含
``TitleBlock_Standardized`` 块参照及其属性数量（验收指标之一：
块参照生成正确率 100%）。

用法：
    py tools/verify_blocks.py [输出目录]     # 默认 output_all
"""
import glob
import os
import sys

import ezdxf  # 需与主程序同一环境

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUT = os.path.join(ROOT, "output_all")
BLOCK_NAME = "TitleBlock_Standardized"


def main() -> int:
    out_dir = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_OUT
    files = sorted(glob.glob(os.path.join(out_dir, "*_recognized*.dxf")))
    if not files:
        print(f"目录 {out_dir} 中未找到 *_recognized*.dxf 输出文件。")
        return 1

    print(f"{'文件':40}{'块定义':>6}{'属性数':>8}")
    ok = 0
    for f in files:
        base = os.path.basename(f)
        try:
            doc = ezdxf.readfile(f)
            # 1) 块定义是否存在
            has_def = any(b.name == BLOCK_NAME for b in doc.blocks)
            # 2) 模型空间中的 INSERT 引用及其属性数量
            n = 0
            for e in doc.modelspace():
                if e.dxftype() == "INSERT" and e.dxf.name == BLOCK_NAME:
                    n = len(list(e.attribs))
            print(f"{base:40}{'YES' if has_def else 'NO':>6}{n:>8}")
            if has_def and n > 0:
                ok += 1
        except Exception as ex:
            print(f"{base:40} 读取失败: {ex}")
    print("-" * 60)
    print(f"结论: {ok}/{len(files)} 个输出包含 {BLOCK_NAME} 块参照与属性")
    return 0 if ok == len(files) else 1


if __name__ == "__main__":
    sys.exit(main())

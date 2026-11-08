# -*- coding: utf-8 -*-
"""
logger.py
=========
操作日志模块。

需求要求：操作日志记录识读时间、文件名、问题统计，保留至少 180 天。
本模块：
    1) 日志写到 logs/ 目录，文件名带日期便于按天归档；
    2) 记录：识读开始/结束时间、输入文件、识别/匹配/块生成统计、异常；
    3) 提供清理过期日志（默认保留 180 天）的能力。

原理：使用 Python 标准库 logging，同时落地到带日期的文件和控制台。
"""
from __future__ import annotations

import datetime
import glob
import logging
import os
from typing import Optional


def _log_dir() -> str:
    """日志目录：优先使用项目 logs/ 目录，可被环境变量覆盖以便部署。"""
    base = os.environ.get("TBR_LOG_DIR", "")
    if base:
        d = base
    else:
        here = os.path.dirname(os.path.abspath(__file__))
        d = os.path.join(os.path.dirname(here), "logs")
    os.makedirs(d, exist_ok=True)
    return d


def setup_logger(name: str = "titleblock", level: int = logging.INFO) -> logging.Logger:
    """
    初始化并返回一个日志器：同时写文件与控制台。

    参数:
        name  : 日志器名
        level : 日志级别

    返回:
        logging.Logger
    """
    logger = logging.getLogger(name)
    logger.setLevel(level)
    if logger.handlers:  # 幂等：避免重复添加 Handler
        return logger

    today = datetime.date.today().strftime("%Y-%m-%d")
    logpath = os.path.join(_log_dir(), f"titleblock_{today}.log")

    fmt = logging.Formatter(
        "%(asctime)s | %(levelname)-7s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    fh = logging.FileHandler(logpath, encoding="utf-8")
    fh.setFormatter(fmt)
    logger.addHandler(fh)

    sh = logging.StreamHandler()
    sh.setFormatter(fmt)
    logger.addHandler(sh)
    return logger


def log_operation(logger: logging.Logger, message: str, level: int = logging.INFO) -> None:
    """记录一条操作日志（统一入口，便于未来加审计）。"""
    logger.log(level, message)


def cleanup_expired_logs(days: int = 180) -> int:
    """
    删除超过 ``days`` 天未修改的日志文件，返回删除数量。

    原理：文件修改时间 < 当前时间 - days 天 即视为过期删除。
    """
    cutoff = datetime.datetime.now() - datetime.timedelta(days=days)
    d = _log_dir()
    removed = 0
    for path in glob.glob(os.path.join(d, "titleblock_*.log")):
        try:
            mtime = datetime.datetime.fromtimestamp(os.path.getmtime(path))
            if mtime < cutoff:
                os.remove(path)
                removed += 1
        except OSError:
            continue
    return removed

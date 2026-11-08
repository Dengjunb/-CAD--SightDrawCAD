# -*- coding: utf-8 -*-
"""
server.py
=========
「CAD 双模式智能识图」本地 Web 服务（Python 标准库，零第三方 Web 框架）。

为什么用 stdlib ThreadingHTTPServer：
    * 交付环境可能不联网、也不希望用户装 Flask/FastAPI；一条 --port 就能起页面；
    * 每个 HTTP 请求一个线程，生成任务再开一个后台线程，页面 400ms 轮询不会互相阻塞。

对外接口（与 docs/研发协作约定.md 第 4 节一致）：
    GET  /                          -> image2cad/web/index.html
    GET  /static/<file>             -> image2cad/web 下的静态文件
    GET  /api/schema                -> {"options": [...], "defaults": {...}, "mock": bool}
    GET  /api/demos                 -> {"demos": [{"name","url","kind"}]}
    POST /api/run                   -> 202 {"runId","status":"running", ...}
    GET  /api/status/<runId>        -> {"runId","status","steps","result","error", ...}
    GET  /runs/<runId>/<path>       -> out/runs/<runId>/<path> 下的产物
    GET  /demo/<file>               -> demo/images/<file>
    POST /api/recognition/<runId>   -> 可选：对已完成的运行补跑图框识读

手动分步（自动/手动切换）：
    POST /api/manual/start          -> 创建手动会话并执行第 1 步
    POST /api/manual/step/<runId>   -> 执行下一步
    POST /api/manual/rerun/<runId>  -> 按当前参数重跑刚完成的步骤
    POST /api/manual/apply/<runId>  -> 参数变更后从受影响步骤重跑
    POST /api/manual/stop/<runId>   -> 停止
    GET  /api/manual/status/<runId> -> 会话状态 + 步骤 + 结果

模式 A（图框识读）：
    GET  /api/titleblock/demos      -> {"demos":[{"name":"示例1-行列式.dxf"}]}
    POST /api/titleblock/run        -> 200 {ok,pairs,unmatched,steps,urls,...}
                                       支持 {"demo": "示例1-行列式.dxf"} 或 {"name","data_b64"}

AI 模型管理（界面「AI 设置」弹窗）：
    GET  /api/ai/models             -> {"models":[{name,base,model,hasKey,keyTail,keyMasked,isDefault}],...}
                                       Key 只回 hasKey / 尾 4 位，明文永不出服务端
    POST /api/ai/models/save        -> body {models:[...], default} 校验后写配置文件
                                       成功 200 {ok,path,count,models:[...]}；失败 400 {ok:false,error}
    POST /api/ai/models/test        -> body {base,key,model[,timeout]} 测连通性（不落盘）
                                       200 {ok,latencyMs,error?,errorType?}

与算法层的衔接：
    server 只负责「收图 → 落盘 → 后台线程调 pipeline.run(...) → 汇总状态」。
    pipeline 的真实实现由 Lead 提供；本模块用 set_runner() 允许 tools/mock_run.py
    注入假流水线，使前端可以完全脱离算法独立联调。

安全：
    * 只监听 127.0.0.1（默认）；
    * /static、/demo、/runs 三个静态路由都做「基准目录约束」检查，
      ../../ 之类的路径穿越一律 403；
    * 上传体积上限 64MB，且必须能被 Pillow 识别为图片。
"""
from __future__ import annotations

import argparse
import base64
import binascii
import inspect
import io
import json
import mimetypes
import re
import threading
import time
import traceback
import uuid
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional
from urllib.parse import unquote, urlparse

from .config import Options, ui_schema
from .ai import (ai_handle, list_models as _ai_list_models, stream_chat as _ai_stream_chat,
                 save_models as _ai_save_models, test_model as _ai_test_model,
                 config_path as _ai_config_path, ai_mock as _ai_mock)

# ---------------------------------------------------------------------------
# 路径常量
# ---------------------------------------------------------------------------
PKG_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = PKG_DIR.parent
WEB_DIR = PKG_DIR / "web"
DEMO_DIR = PROJECT_ROOT / "demo" / "images"
TB_DEMO_DIR = PROJECT_ROOT / "示例图纸"
OUT_ROOT = PROJECT_ROOT / "out"
RUNS_DIR = OUT_ROOT / "runs"

MAX_UPLOAD_BYTES = 64 * 1024 * 1024
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".webp", ".gif"}

# ---------------------------------------------------------------------------
# 运行状态表（进程内）
# ---------------------------------------------------------------------------
_RUNS: Dict[str, Dict[str, Any]] = {}
_LOCK = threading.RLock()
_RUNNER: Optional[Callable[..., Any]] = None
_RECOGNITION_RUNNER: Optional[Callable[..., Any]] = None
_RUN_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$")


def set_runner(fn: Optional[Callable[..., Any]]) -> None:
    """注入自定义流水线（供 tools/mock_run.py 用假数据联调前端）。"""
    global _RUNNER
    _RUNNER = fn


def set_recognition_runner(fn: Optional[Callable[..., Any]]) -> None:
    """注入图框识读实现（mock 联调 / Lead 的 pipeline 未提供时的替代）。"""
    global _RECOGNITION_RUNNER
    _RECOGNITION_RUNNER = fn


def is_mock() -> bool:
    return _RUNNER is not None or _RECOGNITION_RUNNER is not None


# ---------------------------------------------------------------------------
# 路径安全
# ---------------------------------------------------------------------------
def safe_join(base: Path, rel: str) -> Optional[Path]:
    """把相对路径安全地拼到基准目录下；越界/绝对路径返回 None。"""
    rel = (rel or "").strip().replace("\\", "/")
    if not rel or rel.startswith("/"):
        return None
    if any(part == ".." for part in rel.split("/")):
        return None
    base_resolved = base.resolve()
    try:
        target = (base_resolved / rel).resolve()
    except (OSError, ValueError):
        return None
    # 允许 base 本身（目录不许直接下载，后面还会判 is_file）
    if target != base_resolved and base_resolved not in target.parents:
        return None
    return target


def _norm_files(files: Any, run_dir: Path) -> Dict[str, str]:
    """把 RunResult.files 里的绝对路径收敛成「相对 run 目录」的 URL 片段。"""
    out: Dict[str, str] = {}
    if not isinstance(files, dict):
        return out
    run_resolved = run_dir.resolve()
    for key, value in files.items():
        text = str(value).replace("\\", "/").strip()
        if not text:
            continue
        candidate = Path(text)
        if candidate.is_absolute():
            try:
                text = candidate.resolve().relative_to(run_resolved).as_posix()
            except (ValueError, OSError):
                text = candidate.name
        out[str(key)] = text
    return out


# ---------------------------------------------------------------------------
# 运行记录
# ---------------------------------------------------------------------------
def _new_run_id() -> str:
    return time.strftime("run-%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]


def _new_record(run_id: str, source_name: str, source_path: Path, source_bytes: int,
                options: Options) -> Dict[str, Any]:
    return {
        "runId": run_id,
        "status": "running",
        "steps": [],
        "result": None,
        "error": None,
        "createdAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "source": {
            "name": source_name,
            "bytes": source_bytes,
            "url": "/runs/%s/%s" % (run_id, source_path.name),
        },
        "options": options.to_dict(),
        "startedMs": time.time(),
        "elapsedMs": 0.0,
        "mock": is_mock(),
    }


def _status_payload(rec: Dict[str, Any]) -> Dict[str, Any]:
    with _LOCK:
        steps = [dict(item) for item in rec.get("steps", [])]
        result = rec.get("result")
        elapsed = rec.get("elapsedMs") or 0.0
        if rec.get("status") == "running" and rec.get("startedMs"):
            elapsed = (time.time() - rec["startedMs"]) * 1000.0
        if result is not None:
            try:
                # 深拷贝，避免调用方后续修改影响内存记录；不可序列化时原样返回
                result = json.loads(json.dumps(result, ensure_ascii=False))
            except (TypeError, ValueError):
                pass
        return {
            "runId": rec["runId"],
            "status": rec["status"],
            "steps": steps,
            "result": result,
            "error": rec.get("error"),
            "source": rec.get("source"),
            "createdAt": rec.get("createdAt"),
            "elapsedMs": round(float(elapsed), 1),
            "mock": bool(rec.get("mock")),
        }


def _call_with_adaptation(fn: Callable[..., Any], args: List[Any]) -> Any:
    """按被调用方的形参个数裁剪实参，兼容 Lead 可能少声明可选参数的情况。"""
    try:
        sig = inspect.signature(fn)
    except (TypeError, ValueError):
        return fn(*args)
    params = list(sig.parameters.values())
    if any(p.kind is p.VAR_POSITIONAL for p in params):
        return fn(*args)
    positional = [p for p in params if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)]
    count = len(positional)
    return fn(*(args[:count] if count < len(args) else args))


def _default_runner(source_path: str, out_root: str, options: Options, run_id: str,
                    on_step: Callable[[Any], None], recognition: Any) -> Any:
    try:
        from .pipeline import run as pipeline_run
    except Exception as exc:  # ImportError 或模块内部报错
        raise RuntimeError(
            "流水线模块 image2cad.pipeline 当前不可用（%s）。"
            "如需先联调前端，请改用 tools/mock_run.py 启动服务。" % exc
        )
    return _call_with_adaptation(
        pipeline_run,
        [str(source_path), str(out_root), options, run_id, on_step, recognition],
    )


def _execute(rec: Dict[str, Any], source_path: Path, options: Options, run_dir: Path) -> None:
    """后台线程：调用流水线并把步骤/结果写回运行记录。"""

    def on_step(step: Any) -> None:
        try:
            payload = step.to_dict() if hasattr(step, "to_dict") else dict(step)
        except Exception:  # 步骤对象不可序列化时不让整个任务崩掉
            payload = {"key": "unknown", "title": "步骤", "detail": "", "image": "",
                       "metrics": {}, "ms": 0.0}
        with _LOCK:
            rec["steps"].append(payload)
            rec["stepCount"] = len(rec["steps"])

    runner = _RUNNER or _default_runner
    try:
        result = _call_with_adaptation(
            runner,
            [str(source_path), str(RUNS_DIR), options, rec["runId"], on_step,
             bool(options.run_recognition)],
        )
    except Exception as exc:
        message = "生成失败：%s" % (exc or exc.__class__.__name__)
        with _LOCK:
            rec["status"] = "error"
            rec["error"] = message
            rec["elapsedMs"] = (time.time() - rec["startedMs"]) * 1000.0
        try:
            (run_dir / "error.txt").write_text(
                "%s\n\n%s" % (message, traceback.format_exc()), encoding="utf-8")
        except OSError:
            pass
        traceback.print_exc()
        return

    # pipeline 可能返回 RunResult（推荐）、dict，或者 None（只落盘 report.json）
    data: Optional[Dict[str, Any]] = None
    if result is not None:
        if hasattr(result, "to_dict"):
            data = result.to_dict()
        elif isinstance(result, dict):
            data = result
    if data is None:
        report_path = run_dir / "report.json"
        if report_path.is_file():
            try:
                data = json.loads(report_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                data = None
    if data is None:
        with _LOCK:
            rec["status"] = "error"
            rec["error"] = "生成失败：流水线没有返回结果，也没有找到 report.json"
            rec["elapsedMs"] = (time.time() - rec["startedMs"]) * 1000.0
        return

    data.setdefault("runId", rec["runId"])
    # pipeline 只拿到落盘后的 source.<ext>，原始文件名/示例图名只有 server 知道，
    # 这里统一回填，界面统计卡里才能显示用户真正上传的名字。
    source_meta = data.get("source")
    upload_name = (rec.get("source") or {}).get("name")
    if isinstance(source_meta, dict) and upload_name:
        source_meta["name"] = upload_name
    data["files"] = _norm_files(data.get("files"), run_dir)
    result_steps = data.get("steps") or []
    with _LOCK:
        rec["result"] = data
        if len(result_steps) >= len(rec["steps"]):
            rec["steps"] = [dict(s) for s in result_steps]
        rec["status"] = "done"
        rec["error"] = None
        rec["elapsedMs"] = float(data.get("metrics", {}).get("elapsed_ms")
                                 or (time.time() - rec["startedMs"]) * 1000.0)
    try:
        (run_dir / "status.json").write_text(
            json.dumps(_status_payload(rec), ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        pass


# ---------------------------------------------------------------------------
# 示例图
# ---------------------------------------------------------------------------
def _demo_kind(name: str) -> str:
    parts = []
    if "零件图" in name:
        parts.append("零件图")
    elif "标题栏" in name:
        parts.append("标题栏")
    else:
        parts.append("图纸")
    if "干净" in name:
        parts.append("干净扫描")
    elif "拍照" in name or "照片" in name:
        parts.append("手机拍照")
    return " · ".join(parts)


def list_demos() -> List[Dict[str, str]]:
    demos: List[Dict[str, str]] = []
    if not DEMO_DIR.is_dir():
        return demos
    for path in sorted(DEMO_DIR.iterdir(), key=lambda p: p.name):
        if not path.is_file() or path.suffix.lower() not in IMAGE_SUFFIXES:
            continue
        name = path.name
        demos.append({
            "name": name,
            "url": "/demo/" + name,
            "kind": _demo_kind(name),
        })
    return demos


def list_titleblock_demos() -> List[Dict[str, str]]:
    """模式 A 的示例图框（项目内 示例图纸/ 下的 dxf/dwg）。"""
    demos: List[Dict[str, str]] = []
    if not TB_DEMO_DIR.is_dir():
        return demos
    for path in sorted(TB_DEMO_DIR.iterdir(), key=lambda p: p.name):
        if path.is_file() and path.suffix.lower() in (".dxf", ".dwg"):
            demos.append({"name": path.name})
    return demos


def _resolve_demo(name: str) -> Optional[Path]:
    if not name:
        return None
    base = Path(name).name  # 只接受文件名，拒绝目录成分
    if base != name:
        return None
    target = safe_join(DEMO_DIR, base)
    if target is None or not target.is_file():
        return None
    if target.suffix.lower() not in IMAGE_SUFFIXES:
        return None
    return target


def _guess_ext(name: str, data: bytes) -> str:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if data.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if data.startswith(b"GIF8"):
        return ".gif"
    if data.startswith(b"BM"):
        return ".bmp"
    if data.startswith(b"II*\x00") or data.startswith(b"MM\x00*"):
        return ".tif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    suffix = Path(name).suffix.lower()
    return suffix if suffix in IMAGE_SUFFIXES else ".png"


def _verify_image(data: bytes) -> None:
    """用 Pillow 校验图片，避免把任意二进制写进 run 目录。"""
    try:
        from PIL import Image
    except Exception:
        return
    try:
        with Image.open(io.BytesIO(data)) as image:
            width, height = image.size
            # 防解压炸弹：像素总量上限（约 60MP），避免小文件解成超大位图耗尽内存
            if width * height > 60_000_000:
                raise ValueError("图片像素过大（%d×%d，上限 60MP）" % (width, height))
            image.verify()
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError("不是有效的图片文件（%s）" % exc)


# ---------------------------------------------------------------------------
# HTTP 处理
# ---------------------------------------------------------------------------
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
    ".dxf": "application/dxf",
    ".pdf": "application/pdf",
}


def guess_content_type(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in CONTENT_TYPES:
        return CONTENT_TYPES[suffix]
    guessed, _ = mimetypes.guess_type(path.name)
    return guessed or "application/octet-stream"


class Handler(BaseHTTPRequestHandler):
    server_version = "Image2CAD/2.0"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    # -- 基础输出 ----------------------------------------------------------
    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: D401
        try:
            message = fmt % args
        except Exception:
            message = fmt
        print("[web] %s" % message, flush=True)

    def _send_bytes(self, status: int, body: bytes, content_type: str,
                    extra_headers: Optional[Dict[str, str]] = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    # -- SSE 流式输出 -----------------------------------------------------
    def _start_stream(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

    def _stream_send(self, obj) -> None:
        data = ("data: " + json.dumps(obj, ensure_ascii=False) + "\n\n").encode("utf-8")
        self.wfile.write(("%X\r\n" % len(data)).encode("ascii"))
        self.wfile.write(data)
        self.wfile.write(b"\r\n")
        try:
            self.wfile.flush()
        except Exception:
            pass

    def _stream_close(self) -> None:
        try:
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except Exception:
            pass

    def _send_json(self, status: int, payload: Dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send_bytes(status, body, "application/json; charset=utf-8")

    def _send_error_json(self, status: int, message: str) -> None:
        self._send_json(status, {"error": message})

    def _send_file(self, path: Path, download_name: Optional[str] = None) -> bool:
        try:
            body = path.read_bytes()
        except OSError as exc:
            self._send_error_json(500, "读取文件失败：%s" % exc)
            return False
        headers = {}
        if download_name:
            headers["Content-Disposition"] = "attachment; filename*=UTF-8''" + _quote(download_name)
        self._send_bytes(200, body, guess_content_type(path), headers)
        return True

    # -- 请求分发 ----------------------------------------------------------
    def do_HEAD(self) -> None:  # noqa: N802
        self.do_GET()

    def do_GET(self) -> None:  # noqa: N802
        try:
            self._route_get()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            traceback.print_exc()
            try:
                self._send_error_json(500, "服务器内部错误：%s" % exc)
            except Exception:
                pass

    def do_POST(self) -> None:  # noqa: N802
        try:
            self._route_post()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            traceback.print_exc()
            try:
                self._send_error_json(500, "服务器内部错误：%s" % exc)
            except Exception:
                pass

    def _route_get(self) -> None:
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        if path in ("/", "/index.html"):
            self._send_file(WEB_DIR / "index.html")
            return
        if path == "/favicon.ico":
            self._send_bytes(204, b"", "image/x-icon")
            return
        if path.startswith("/static/"):
            rel = path[len("/static/"):]
            target = safe_join(WEB_DIR, rel)
            if target is None or not target.is_file():
                self._send_error_json(404, "静态文件不存在")
                return
            self._send_file(target)
            return
        if path == "/api/schema":
            self._send_json(200, {
                "options": ui_schema(),
                "defaults": Options().to_dict(),
                "mock": is_mock(),
            })
            return
        if path == "/api/demos":
            self._send_json(200, {"demos": list_demos(), "mock": is_mock()})
            return
        if path == "/api/titleblock/demos":
            self._send_json(200, {"demos": list_titleblock_demos()})
            return
        if path.startswith("/api/manual/status/"):
            run_id = path[len("/api/manual/status/"):].strip("/")
            self._handle_manual_status(run_id)
            return
        if path.startswith("/api/status/"):
            run_id = path[len("/api/status/"):].strip("/")
            self._handle_status(run_id)
            return
        if path.startswith("/demo/"):
            rel = path[len("/demo/"):]
            target = safe_join(DEMO_DIR, rel)
            if target is None or not target.is_file():
                self._send_error_json(404, "示例图不存在")
                return
            if target.suffix.lower() not in IMAGE_SUFFIXES:
                self._send_error_json(403, "只允许读取示例图片")
                return
            self._send_file(target)
            return
        if path.startswith("/runs/"):
            remainder = path[len("/runs/"):]
            if "/" not in remainder:
                self._send_error_json(404, "缺少文件路径")
                return
            run_id, rel = remainder.split("/", 1)
            self._handle_run_file(run_id, rel)
            return
        if path == "/api/ai/models":
            self._send_json(200, {
                "models": _ai_list_models(),
                "mock": is_mock(),
                "aiMock": _ai_mock(),
                "configPath": _ai_config_path(),
            })
            return
        if path == "/api/ai/run":
            self._handle_ai_run()
            return
        self._send_error_json(404, "未找到该路径：%s" % path)

    def _handle_status(self, run_id: str) -> None:
        with _LOCK:
            rec = _RUNS.get(run_id)
        if rec is None:
            self._send_error_json(404, "运行记录不存在：%s" % run_id)
            return
        self._send_json(200, _status_payload(rec))

    def _handle_run_file(self, run_id: str, rel: str) -> None:
        if not _RUN_ID_RE.match(run_id):
            self._send_error_json(404, "运行编号不合法")
            return
        run_dir = RUNS_DIR / run_id
        if not run_dir.is_dir():
            self._send_error_json(404, "运行目录不存在")
            return
        target = safe_join(run_dir, rel)
        if target is None:
            self._send_error_json(403, "越权访问：路径超出运行目录")
            return
        if not target.is_file():
            self._send_error_json(404, "文件不存在：%s" % rel)
            return
        self._send_file(target)

    # -- POST --------------------------------------------------------------
    def _read_body(self) -> bytes:
        raw_length = self.headers.get("Content-Length")
        try:
            length = int(raw_length or 0)
        except ValueError:
            raise ValueError("Content-Length 不合法")
        if length <= 0:
            return b""
        if length > MAX_UPLOAD_BYTES:
            raise ValueError("请求体过大（上限 %d MB）" % (MAX_UPLOAD_BYTES // (1024 * 1024)))
        return self.rfile.read(length)

    def _route_post(self) -> None:
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        if path == "/api/run":
            self._handle_run()
            return
        if path == "/api/titleblock/run":
            self._handle_titleblock_run()
            return
        if path == "/api/manual/start":
            self._handle_manual_start()
            return
        if path.startswith("/api/manual/"):
            self._handle_manual_action(path)
            return
        if path.startswith("/api/recognition/"):
            run_id = path[len("/api/recognition/"):].strip("/")
            self._handle_recognition(run_id)
            return
        if path == "/api/ai/chat":
            self._handle_ai_chat_stream()
            return
        if path == "/api/ai/models/save":
            self._handle_ai_models_save()
            return
        if path == "/api/ai/models/test":
            self._handle_ai_models_test()
            return
        if path == "/api/ai/run":
            self._handle_ai_run()
            return
        self._send_error_json(404, "未找到该路径：%s" % path)

    # -- 手动分步 ----------------------------------------------------------
    def _manual_payload(self, payload: Dict[str, Any], run_id: str) -> Dict[str, Any]:
        payload["runId"] = run_id
        files = ((payload.get("result") or {}).get("files") or {})
        payload["urls"] = {
            key: "/runs/%s/%s" % (run_id, value)
            for key, value in files.items() if value
        }
        payload["statusUrl"] = "/api/manual/status/" + run_id
        return payload

    def _manual_run_dir(self, run_id: str) -> Optional[Path]:
        if not _RUN_ID_RE.match(run_id or ""):
            return None
        run_dir = RUNS_DIR / run_id
        if not run_dir.is_dir() or not (run_dir / "state.json").is_file():
            return None
        return run_dir

    def _handle_manual_status(self, run_id: str) -> None:
        run_dir = self._manual_run_dir(run_id)
        if run_dir is None:
            self._send_error_json(404, "手动会话不存在：%s" % run_id)
            return
        try:
            from . import manual
            payload = manual.session_info(str(run_dir))
        except Exception as exc:
            self._send_error_json(500, "读取手动会话失败：%s" % exc)
            return
        self._send_json(200, self._manual_payload(payload, run_id))

    def _handle_manual_start(self) -> None:
        try:
            body = self._read_body()
            payload = json.loads(body.decode("utf-8")) if body else {}
        except (ValueError, UnicodeDecodeError) as exc:
            self._send_error_json(400, "请求无效：%s" % exc)
            return
        if not isinstance(payload, dict):
            self._send_error_json(400, "请求体必须是 JSON 对象")
            return

        demo = payload.get("demo")
        data: Optional[bytes] = None
        source_name = ""
        ext = ".png"
        if demo:
            demo_path = _resolve_demo(str(demo))
            if demo_path is None:
                self._send_error_json(404, "示例图不存在：%s" % demo)
                return
            data = demo_path.read_bytes()
            source_name = demo_path.name
            ext = demo_path.suffix.lower()
        else:
            source_name = str(payload.get("name") or "上传图纸.png")
            data_b64 = payload.get("data_b64") or ""
            if not data_b64:
                self._send_error_json(400, "缺少图片数据：请传 demo 或 name + data_b64")
                return
            if isinstance(data_b64, str) and data_b64.startswith("data:"):
                data_b64 = data_b64.split(",", 1)[-1]
            try:
                data = base64.b64decode(str(data_b64), validate=False)
                _verify_image(data)
            except (binascii.Error, ValueError) as exc:
                self._send_error_json(400, str(exc))
                return
            ext = _guess_ext(source_name, data)

        try:
            options = Options.from_dict(payload.get("options") or {})
        except Exception as exc:
            self._send_error_json(400, "参数无效：%s" % exc)
            return

        run_id = _new_run_id()
        run_dir = RUNS_DIR / run_id
        try:
            run_dir.mkdir(parents=True, exist_ok=True)
            source_path = run_dir / ("source" + ext)
            source_path.write_bytes(data or b"")
        except OSError as exc:
            self._send_error_json(500, "写入运行目录失败：%s" % exc)
            return

        try:
            from . import manual
            result = manual.start_session(str(run_dir), str(source_path), options)
        except Exception as exc:
            traceback.print_exc()
            self._send_error_json(500, "初始化手动会话失败：%s" % exc)
            return
        self._send_json(200, self._manual_payload(result, run_id))

    def _handle_manual_action(self, path: str) -> None:
        remainder = path[len("/api/manual/"):]
        if "/" not in remainder:
            self._send_error_json(404, "缺少操作或运行编号")
            return
        action, run_id = remainder.split("/", 1)
        run_id = run_id.strip("/")
        run_dir = self._manual_run_dir(run_id)
        if run_dir is None:
            self._send_error_json(404, "手动会话不存在：%s" % run_id)
            return
        if action not in ("step", "rerun", "apply", "stop"):
            self._send_error_json(404, "未知手动操作：%s" % action)
            return

        body = b""
        try:
            body = self._read_body()
        except ValueError as exc:
            self._send_error_json(400, str(exc))
            return
        payload: Dict[str, Any] = {}
        if body:
            try:
                payload = json.loads(body.decode("utf-8"))
            except (UnicodeDecodeError, ValueError) as exc:
                self._send_error_json(400, "JSON 解析失败：%s" % exc)
                return
        try:
            options = Options.from_dict(payload.get("options") or {})
        except Exception as exc:
            self._send_error_json(400, "参数无效：%s" % exc)
            return

        try:
            from . import manual
            if action == "step":
                result = manual.advance(str(run_dir), options)
            elif action == "apply":
                result = manual.apply_options(str(run_dir), options)
            elif action == "rerun":
                result = manual.rerun(str(run_dir), options,
                                      payload.get("stage") or None)
            else:
                result = manual.stop(str(run_dir))
        except manual.ManualError as exc:
            self._send_error_json(409, str(exc))
            return
        except Exception as exc:
            traceback.print_exc()
            self._send_error_json(500, "手动步骤执行失败：%s" % exc)
            return
        self._send_json(200, self._manual_payload(result, run_id))

    def _handle_titleblock_run(self) -> None:
        """POST /api/titleblock/run：上传 .dxf/.dwg 或指定示例，同步跑图框识读。"""
        try:
            body = self._read_body()
        except ValueError as exc:
            self._send_error_json(400, str(exc))
            return
        if not body:
            self._send_error_json(400, "请求体为空：需要 {\"demo\":\"示例1-行列式.dxf\"} 或 {\"name\",\"data_b64\"}")
            return
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            self._send_error_json(400, "JSON 解析失败（必须是 UTF-8）：%s" % exc)
            return
        if not isinstance(payload, dict):
            self._send_error_json(400, "请求体必须是 JSON 对象")
            return

        demo = payload.get("demo")
        source_name = ""
        data: Optional[bytes] = None
        ext = ".dxf"

        if demo:
            base = Path(str(demo)).name
            target = safe_join(TB_DEMO_DIR, base)
            if target is None or not target.is_file():
                self._send_error_json(404, "示例图纸不存在：%s" % demo)
                return
            try:
                data = target.read_bytes()
            except OSError as exc:
                self._send_error_json(500, "读取示例图纸失败：%s" % exc)
                return
            source_name = target.name
            ext = target.suffix.lower()
        else:
            source_name = str(payload.get("name") or "上传图纸.dxf")
            data_b64 = payload.get("data_b64") or ""
            if not data_b64:
                self._send_error_json(400, "缺少图纸数据：请传 demo 名称，或 name + data_b64")
                return
            if isinstance(data_b64, str) and data_b64.startswith("data:"):
                data_b64 = data_b64.split(",", 1)[-1]
            try:
                data = base64.b64decode(str(data_b64), validate=False)
            except (binascii.Error, ValueError) as exc:
                self._send_error_json(400, "图纸 base64 解码失败：%s" % exc)
                return
            if not data:
                self._send_error_json(400, "图纸数据为空")
                return
            ext = Path(source_name).suffix.lower()
            if ext not in (".dxf", ".dwg"):
                self._send_error_json(400, "只支持 .dxf / .dwg 图纸")
                return

        run_id = _new_run_id()
        run_dir = RUNS_DIR / run_id
        try:
            run_dir.mkdir(parents=True, exist_ok=True)
            source_path = run_dir / ("source" + ext)
            source_path.write_bytes(data or b"")
        except OSError as exc:
            self._send_error_json(500, "写入运行目录失败：%s" % exc)
            return

        try:
            from .mode_a import run_titleblock
            result = run_titleblock(str(source_path), str(run_dir))
        except Exception as exc:  # 引擎异常不应裸 500
            traceback.print_exc()
            self._send_error_json(500, "图框识读失败：%s" % exc)
            return

        if not result.get("ok"):
            self._send_json(422, result)
            return

        result["runId"] = run_id
        result["source"]["url"] = "/runs/%s/%s" % (run_id, source_path.name)
        result["urls"] = {
            key: "/runs/%s/%s" % (run_id, value)
            for key, value in (result.get("files") or {}).items()
            if value
        }
        self._send_json(200, result)

    def _handle_run(self) -> None:
        try:
            body = self._read_body()
        except ValueError as exc:
            self._send_error_json(400, str(exc))
            return
        if not body:
            self._send_error_json(400, "请求体为空：需要 {\"demo\": \"...\"} 或 {\"name\", \"data_b64\"}")
            return
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            self._send_error_json(400, "JSON 解析失败（必须是 UTF-8）：%s" % exc)
            return
        if not isinstance(payload, dict):
            self._send_error_json(400, "请求体必须是 JSON 对象")
            return

        try:
            options = Options.from_dict(payload.get("options") or {})
        except Exception as exc:
            self._send_error_json(400, "参数无效：%s" % exc)
            return

        demo = payload.get("demo")
        source_name = ""
        data: Optional[bytes] = None
        ext = ".png"

        if demo:
            demo_path = _resolve_demo(str(demo))
            if demo_path is None:
                self._send_error_json(404, "示例图不存在：%s" % demo)
                return
            try:
                data = demo_path.read_bytes()
            except OSError as exc:
                self._send_error_json(500, "读取示例图失败：%s" % exc)
                return
            source_name = demo_path.name
            ext = demo_path.suffix.lower()
        else:
            name = str(payload.get("name") or "上传图纸.png")
            source_name = name
            data_b64 = payload.get("data_b64") or ""
            if not data_b64:
                self._send_error_json(400, "缺少图片数据：请传 demo 名称，或 name + data_b64")
                return
            if isinstance(data_b64, str) and data_b64.startswith("data:"):
                data_b64 = data_b64.split(",", 1)[-1]
            try:
                data = base64.b64decode(str(data_b64), validate=False)
            except (binascii.Error, ValueError) as exc:
                self._send_error_json(400, "图片 base64 解码失败：%s" % exc)
                return
            if not data:
                self._send_error_json(400, "图片数据为空")
                return
            try:
                _verify_image(data)
            except ValueError as exc:
                self._send_error_json(400, str(exc))
                return
            ext = _guess_ext(name, data)

        run_id = _new_run_id()
        run_dir = RUNS_DIR / run_id
        try:
            run_dir.mkdir(parents=True, exist_ok=True)
            source_path = run_dir / ("source" + ext)
            source_path.write_bytes(data or b"")
        except OSError as exc:
            self._send_error_json(500, "写入运行目录失败：%s" % exc)
            return

        rec = _new_record(run_id, source_name or source_path.name, source_path,
                          len(data or b""), options)
        with _LOCK:
            _RUNS[run_id] = rec

        thread = threading.Thread(
            target=_execute,
            args=(rec, source_path, options, run_dir),
            name="image2cad-%s" % run_id,
            daemon=True,
        )
        thread.start()
        self._send_json(202, {
            "runId": run_id,
            "status": "running",
            "source": rec["source"],
            "mock": is_mock(),
            "statusUrl": "/api/status/" + run_id,
        })

    def _handle_recognition(self, run_id: str) -> None:
        with _LOCK:
            rec = _RUNS.get(run_id)
        if rec is None:
            self._send_error_json(404, "运行记录不存在：%s" % run_id)
            return
        if rec["status"] != "done" or not rec.get("result"):
            self._send_error_json(409, "该运行尚未完成，无法识读")
            return
        run_dir = RUNS_DIR / run_id
        hook = _RECOGNITION_RUNNER
        if not callable(hook):
            try:
                from .pipeline import run_recognition as hook  # type: ignore
            except Exception:
                hook = None
        if not callable(hook):
            self._send_error_json(501, "当前流水线未提供图框识读接口（POST /api/recognition 待接入）")
            return
        try:
            options = Options.from_dict(rec.get("options") or {})
            result = _call_with_adaptation(hook, [str(run_dir), options, rec["result"]])
        except Exception as exc:
            traceback.print_exc()
            self._send_error_json(500, "图框识读失败：%s" % exc)
            return
        if hasattr(result, "to_dict"):
            result = result.to_dict()
        with _LOCK:
            rec["result"]["recognition"] = result
        self._send_json(200, {"recognition": result})
    # -- AI 制图助手 ------------------------------------------------------
    def _handle_ai_run(self) -> None:
        body = self._read_body()
        if not body:
            self._send_error_json(400, "缺少请求体")
            return
        try:
            data = json.loads(body.decode("utf-8"))
        except Exception:
            self._send_error_json(400, "请求体不是合法 JSON")
            return
        text = str(data.get("text") or "").strip()
        model = (data.get("model") or None)
        current = data.get("options") if isinstance(data.get("options"), dict) else None
        if not text:
            self._send_error_json(400, "请输入要做什么（例如：把这张图转成CAD并加上尺寸标注）")
            return
        try:
            payload = ai_handle(text, model, current)
            self._send_json(200, payload)
        except Exception as exc:
            self._send_error_json(500, "AI 解析失败：%s" % exc)

    # -- AI 模型管理（界面「AI 设置」弹窗）--------------------------------
    def _read_json_object(self) -> Optional[Dict[str, Any]]:
        """读一个 JSON 对象请求体；不合法时已回过响应，这里返回 None。"""
        try:
            body = self._read_body()
        except ValueError as exc:
            self._send_error_json(400, str(exc))
            return None
        if not body:
            self._send_error_json(400, "缺少请求体")
            return None
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            self._send_error_json(400, "请求体不是合法 JSON：%s" % exc)
            return None
        if not isinstance(payload, dict):
            self._send_error_json(400, "请求体必须是 JSON 对象")
            return None
        return payload

    def _handle_ai_models_save(self) -> None:
        """POST /api/ai/models/save：校验后写入配置文件，保存后立即生效。"""
        payload = self._read_json_object()
        if payload is None:
            return
        result = _ai_save_models(payload.get("models"), payload.get("default"))
        if not result.get("ok"):
            # 校验失败 / 写盘失败：400 + 可读中文原因，不回 500 堆栈
            self._send_json(400, result)
            return
        self._send_json(200, {
            "ok": True,
            "path": result.get("path"),
            "count": result.get("count"),
            "default": result.get("default"),
            "models": _ai_list_models(),
            "configPath": _ai_config_path(),
        })

    def _handle_ai_models_test(self) -> None:
        """POST /api/ai/models/test：发最小 chat 请求测连通性，不落盘。"""
        payload = self._read_json_object()
        if payload is None:
            return
        result = _ai_test_model(
            str(payload.get("base") or ""),
            str(payload.get("key") or ""),
            str(payload.get("model") or ""),
            timeout=payload.get("timeout") or 15,
        )
        # 连不上是正常的诊断结果：HTTP 200 + ok:false + 中文原因，前端好处理
        self._send_json(200, result)

    def _handle_ai_chat_stream(self) -> None:
        body = self._read_body()
        if not body:
            self._send_error_json(400, "缺少请求体")
            return
        try:
            data = json.loads(body.decode("utf-8"))
        except Exception:
            self._send_error_json(400, "请求体不是合法 JSON")
            return
        messages = data.get("messages")
        if not isinstance(messages, list) or not messages:
            text = str(data.get("text") or "").strip()
            if not text:
                self._send_error_json(400, "缺少 messages 或 text")
                return
            messages = [{"role": "user", "content": text}]
        model = data.get("model") or None
        self._start_stream()
        try:
            total = 0
            for piece in _ai_stream_chat(messages, model):
                if not piece:
                    continue
                total += len(piece)
                self._stream_send({"delta": piece})
            self._stream_send({"done": True, "chars": total, "model": model or ""})
        except Exception as exc:
            try:
                self._stream_send({"error": str(exc)})
            except Exception:
                pass
        finally:
            self._stream_close()




def _quote(text: str) -> str:
    from urllib.parse import quote
    return quote(text, safe="")


# ---------------------------------------------------------------------------
# 启动
# ---------------------------------------------------------------------------

def serve(host: str = "127.0.0.1", port: int = 8710,
          out_root: Optional[str] = None, open_browser: bool = False) -> int:
    """启动 Web 服务（供 CLI / 外部脚本调用）。返回进程退出码。"""
    global OUT_ROOT, RUNS_DIR
    if out_root:
        OUT_ROOT = Path(out_root).resolve()
        RUNS_DIR = OUT_ROOT / "runs"
    RUNS_DIR.mkdir(parents=True, exist_ok=True)

    try:
        httpd = ThreadingHTTPServer((host, port), Handler)
    except OSError as exc:
        print("[web] 启动失败：%s（端口 %d 可能被占用）" % (exc, port), flush=True)
        return 2
    httpd.daemon_threads = True

    mode = "联调模式（mock 流水线）" if is_mock() else "真实流水线"
    print("=" * 60, flush=True)
    print("CAD 双模式智能识图  v2.2  ·  %s" % mode, flush=True)
    print("服务地址: http://%s:%d/" % (host, port), flush=True)
    print("输出目录: %s" % RUNS_DIR, flush=True)
    print("按 Ctrl+C 停止服务", flush=True)
    print("=" * 60, flush=True)

    if open_browser:
        def _open() -> None:
            time.sleep(0.8)
            try:
                webbrowser.open("http://%s:%d/" % (host, port))
            except Exception:
                pass
        threading.Thread(target=_open, daemon=True).start()

    try:
        httpd.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        print("\n[web] 已停止", flush=True)
    finally:
        httpd.server_close()
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m image2cad.server",
        description="看图成图 Image → CAD 本地 Web 服务（标准库实现）",
    )
    parser.add_argument("--port", type=int, default=8710, help="监听端口（默认 8710）")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址（默认仅本机 127.0.0.1）")
    parser.add_argument("--out", default=None, help="运行结果目录（默认项目 out/runs）")
    parser.add_argument("--open", action="store_true", help="启动后自动打开浏览器")
    args = parser.parse_args(argv)
    return serve(args.host, args.port, args.out, args.open)


if __name__ == "__main__":
    raise SystemExit(main())
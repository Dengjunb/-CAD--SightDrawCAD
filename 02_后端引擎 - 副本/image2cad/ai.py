# -*- coding: utf-8 -*-
"""
ai.py
=====
「AI 制图助手」：连接不同大模型，用自然语言驱动看图成图 / 制CAD图。

设计目标：
    * 支持任意 OpenAI 兼容的 Chat Completions 接口（DeepSeek / 通义 / 智谱 /
      硅基流动 / 本地 Ollama / vLLM 等），模型列表可配置、可切换；
    * 一个「AI 输入框」：用户用中文自然语言描述任务或调整意图，模型把
      它解析成 Options 字段变化 + 意图动作（run/annotate/classify/apply/describe），
      前端据此应用参数或触发对应操作；
    * 无 API / 未配置时降级到「内置规则解析器」，仍能理解常用的中文指令
      （如：把这张图转成CAD并加尺寸标注、增强线框、竖版图），保证体验可用。

配置：ai_config.json（也可以用环境变量 I2C_AI_CONFIG 指定路径）。字段：
    models: [{name, base, key, model}]   // 可连接多个模型
    default: 默认模型名
    timeout, max_tokens, temperature
未配置时自动探测环境变量 DEEPSEEK_API_KEY 等。

模型管理（界面「AI 设置」弹窗）：
    list_models()   脱敏列表（只回 hasKey / 尾 4 位，明文 Key 不出服务端）
    save_models()   校验后写入配置文件（写盘后下一次 load_config 立即生效，无需重启）
    test_model()    发一个最小 chat completion 请求测连通性，**不落盘**
"""
from __future__ import annotations

import json
import os
import re
import socket
import sys
import time
import urllib.request
import urllib.error
from typing import Any, Dict, List, Optional, Tuple

# 配置文件路径规则（写入与读取用同一套）：
#   1) 环境变量 I2C_AI_CONFIG（最高优先，方便测试 / 多实例）
#   2) 打包成 exe 后：exe 同目录 ai_config.json
#   3) 工程根 ai_config.json（源码运行时）
CONFIG_ENV = "I2C_AI_CONFIG"
CONFIG_NAME = "ai_config.json"
LEGACY_CONFIG_NAME = "ai_cad.json"        # 老版本配置名：现场只有它时仍按它读，升级不丢配置
PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LEGACY_CONFIG_PATH = os.path.join(PROJECT_DIR, LEGACY_CONFIG_NAME)
DEFAULT_CONFIG_PATH = LEGACY_CONFIG_PATH  # 兼容旧代码里的引用（历史常量）
MAX_MODELS = 50


def config_path() -> str:
    """解析当前生效的配置文件路径（只计算，不检查是否存在）。"""
    env = (os.environ.get(CONFIG_ENV) or "").strip()
    if env:
        return os.path.abspath(os.path.expanduser(env))
    if getattr(sys, "frozen", False):
        exe_dir = os.path.dirname(os.path.abspath(sys.executable or ""))
        if exe_dir:
            return os.path.join(exe_dir, CONFIG_NAME)
    return os.path.join(PROJECT_DIR, CONFIG_NAME)


def _read_json(path: str) -> Optional[Dict[str, Any]]:
    """读一个 JSON 对象；不存在 / 不是 JSON / 不是对象都返回 None（不抛异常）。"""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError, UnicodeDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _config_data(path: Optional[str] = None) -> Dict[str, Any]:
    """取「实际生效」的原始配置：优先目标路径；现场只有旧 ai_cad.json 时读旧的。"""
    target = path or config_path()
    data = _read_json(target)
    if data is None and not path:
        data = _read_json(LEGACY_CONFIG_PATH)
    return data or {}


# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------
def _default_models() -> List[Dict[str, str]]:
    """内置推荐模型（可直接选，需各自填 key）。用户可在配置文件覆盖。"""
    return [
        {"name": "DeepSeek", "base": "https://api.deepseek.com", "model": "deepseek-chat"},
        {"name": "通义千问", "base": "https://dashscope.aliyuncs.com/compatible-mode/v1",
         "model": "qwen-plus"},
        {"name": "智谱 GLM", "base": "https://open.bigmodel.cn/api/paas/v4",
         "model": "glm-4-flash"},
        {"name": "硅基流动", "base": "https://api.siliconflow.cn/v1",
         "model": "deepseek-ai/DeepSeek-V3"},
    ]


def load_config(path: Optional[str] = None) -> Dict[str, Any]:
    """读取配置。每次调用都重新读盘，所以保存模型后立即生效（不需要重启服务）。"""
    cfg: Dict[str, Any] = {"models": _default_models(), "default": None,
                           "timeout": 60, "max_tokens": 1200, "temperature": 0.2}
    data = _config_data(path)
    if isinstance(data.get("models"), list) and data["models"]:
        models = [m for m in data["models"]
                  if isinstance(m, dict) and str(m.get("name") or "").strip()]
        if models:
            cfg["models"] = models
    if data.get("default"):
        cfg["default"] = data["default"]
    for k in ("timeout", "max_tokens", "temperature"):
        if k in data:
            cfg[k] = data[k]
    for env, name in (("DEEPSEEK_API_KEY", "DeepSeek"),
                      ("DASHSCOPE_API_KEY", "通义千问"),
                      ("ZHIPU_API_KEY", "智谱 GLM"),
                      ("SILICONFLOW_API_KEY", "硅基流动")):
        if os.environ.get(env) and not cfg.get("default"):
            cfg["default"] = name
    return cfg


# -- Base URL / Key 的公共小工具（列表、调用、测试共用同一套规则）-----------
_ENV_KEY_BY_NAME = {
    "DeepSeek": "DEEPSEEK_API_KEY",
    "通义千问": "DASHSCOPE_API_KEY",
    "智谱 GLM": "ZHIPU_API_KEY",
    "硅基流动": "SILICONFLOW_API_KEY",
}
_VERSION_SEG_RE = re.compile(r"^(?:v\d+(?:beta|alpha)?|beta|alpha)$", re.I)


def _scheme_for(bare: str) -> str:
    """用户没写协议时补一个：本机地址用 http，其余用 https。"""
    host = bare
    if host.startswith("["):                      # [::1]:11434
        host = host.split("]", 1)[0] + "]"
    elif ":" in host:                             # localhost:11434
        host = host.rsplit(":", 1)[0]
    return "http://" if host.strip("[]").lower() in ("localhost", "127.0.0.1", "0.0.0.0", "::1") \
        else "https://"


def normalize_base(base: str) -> str:
    """
    把用户填的 Base URL 规整成 OpenAI 兼容根地址：
        * 没写协议时自动补（本机地址补 http://，其余补 https://）；
        * 去掉末尾多余的 / 与 /chat/completions；
        * 路径里没有版本段（v1 / v4 / beta…）时自动补 /v1。
    例：api.deepseek.com                -> https://api.deepseek.com/v1
        localhost:11434                 -> http://localhost:11434/v1
        https://open.bigmodel.cn/api/paas/v4 -> 原样保留
    """
    text = str(base or "").strip()
    if not text:
        return ""
    if "://" in text:
        _scheme = text.split("://", 1)[0].strip().lower()
        if _scheme not in ("http", "https"):
            return ""                      # file:// / javascript: / data: 一律拒绝
    else:
        text = _scheme_for(text.split("/", 1)[0]) + text
    text = text.rstrip("/")
    for suffix in ("/chat/completions", "/completions"):
        if text.endswith(suffix):
            text = text[: -len(suffix)].rstrip("/")
            break
    if not text:
        return ""
    last = text.rsplit("/", 1)[-1]
    if _VERSION_SEG_RE.match(last):
        return text
    return text + "/v1"


def chat_url(base: str) -> str:
    """由 Base URL 拼出 chat/completions 端点（调用与测试共用，避免两处规则不一致）。"""
    return normalize_base(base) + "/chat/completions"


def model_key(entry: Dict[str, Any]) -> str:
    """取一个模型实际可用的 Key：配置里的 key 优先，其次 keyEnv / 同名内置环境变量。"""
    key = str(entry.get("key") or "").strip()
    if key:
        return key
    env_name = str(entry.get("keyEnv") or "").strip()
    if not env_name:
        env_name = _ENV_KEY_BY_NAME.get(str(entry.get("name") or "").strip(), "")
    if env_name:
        return (os.environ.get(env_name) or "").strip()
    return ""


def mask_key(key: str) -> str:
    """把 Key 打码成 sk-…abcd；前端只看这个，明文 Key 永远不出服务端。"""
    key = str(key or "").strip()
    if not key:
        return ""
    if len(key) <= 6:
        return "…" + key[-2:]
    prefix = "sk-" if key.lower().startswith("sk-") else key[:3]
    return prefix + "…" + key[-4:]


def ai_mock() -> bool:
    """I2C_AI_MOCK=1：AI 相关接口走联调分支（不真的联网）。"""
    return os.environ.get("I2C_AI_MOCK") == "1"


def list_models(path: Optional[str] = None) -> List[Dict[str, Any]]:
    """
    脱敏模型列表（GET /api/ai/models 的数据源）。
    只回 hasKey / keyTail / keyMasked，不含明文 Key。
    """
    cfg = load_config(path)
    out: List[Dict[str, Any]] = []
    models = [m for m in cfg.get("models", []) if isinstance(m, dict)]
    names = [str(m.get("name") or "") for m in models]
    # 配置里没写 default 时，实际生效的是第一条（call_chat 的同类回退），列表照实标出来
    effective = cfg.get("default") if cfg.get("default") in names else (names[0] if names else None)
    for m in models:
        name = str(m.get("name") or "")
        key = model_key(m)
        is_default = bool(name) and name == effective
        out.append({
            "name": name,
            "base": normalize_base(str(m.get("base") or "")),
            "model": str(m.get("model") or name),
            "hasKey": bool(key),
            "keyTail": key[-4:] if key else "",
            "keyMasked": mask_key(key),
            "isDefault": is_default,
            "default": is_default,          # 兼容旧前端读 m.default
        })
    return out


# ---------------------------------------------------------------------------
# 模型管理（界面「AI 设置」弹窗）：校验 / 保存 / 测试连接
# ---------------------------------------------------------------------------
def validate_models(models: Any) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    """
    校验前端提交的模型数组，返回 (规整后的列表, 中文错误)。
    规整项：{name, base, model[, key][, keyEnv][, _clear]}；
    提交里没带 key 时**不等于清空 Key**（前端拿不到明文，留空 = 沿用旧 Key）。
    """
    if not isinstance(models, list):
        return [], "models 必须是数组"
    if not models:
        return [], "至少要保留一个模型（不能全部删除）"
    if len(models) > MAX_MODELS:
        return [], "模型数量过多（最多 %d 个）" % MAX_MODELS
    cleaned: List[Dict[str, Any]] = []
    seen: Dict[str, int] = {}
    for index, raw in enumerate(models, 1):
        if not isinstance(raw, dict):
            return [], "第 %d 条模型不是 JSON 对象" % index
        name = str(raw.get("name") or "").strip()
        if not name:
            return [], "第 %d 条模型缺少「名称」" % index
        if len(name) > 64:
            return [], "第 %d 条模型名称过长（最多 64 个字符）" % index
        low = name.lower()
        if low in seen:
            return [], "模型名称重复：「%s」（名称必须唯一）" % name
        seen[low] = index
        base = normalize_base(str(raw.get("base") or ""))
        if not base:
            return [], "模型「%s」缺少 Base URL" % name
        from urllib.parse import urlparse
        _p = urlparse(base)
        _host = (_p.hostname or "")
        if (_p.scheme not in ("http", "https") or not _p.netloc or not _host
                or any(ch in base for ch in " \t\r\n")
                or "@" in _p.netloc
                or not re.match(r"^[A-Za-z0-9._~\-\[\]]+(:\d{1,5})?$", _p.netloc)):
            return [], "模型「%s」的 Base URL 不是合法的 http(s) 地址：%s" % (name, base)
        model = str(raw.get("model") or "").strip()
        if not model:
            return [], "模型「%s」缺少模型名（例如 deepseek-chat）" % name
        item: Dict[str, Any] = {"name": name, "base": base, "model": model}
        key = raw.get("key")
        if isinstance(key, str) and key.strip():
            item["key"] = key.strip()
        key_env = str(raw.get("keyEnv") or "").strip()
        if key_env:
            item["keyEnv"] = key_env
        if raw.get("clearKey"):
            item["_clear"] = True
        cleaned.append(item)
    return cleaned, None


def save_models(models: Any, default: Any = None,
                path: Optional[str] = None) -> Dict[str, Any]:
    """
    校验并写入配置文件（POST /api/ai/models/save）。
    返回 {ok, path, count, default} 或 {ok: False, error: 中文说明}。
    Key 合并规则：提交里没带 key / 留空 -> 沿用同名旧模型的 Key；clearKey=true -> 清空。
    """
    cleaned, error = validate_models(models)
    if error:
        return {"ok": False, "error": error}
    target = path or config_path()
    existing = _config_data(path)
    old_models = [m for m in (existing.get("models") or []) if isinstance(m, dict)]
    old_by_name: Dict[str, Dict[str, Any]] = {}
    for m in old_models:
        old_name = str(m.get("name") or "").strip()
        if old_name and old_name not in old_by_name:
            old_by_name[old_name] = m

    merged: List[Dict[str, Any]] = []
    for item in cleaned:
        old = old_by_name.get(item["name"]) or {}
        entry: Dict[str, Any] = {"name": item["name"], "base": item["base"],
                                 "model": item["model"]}
        key = item.get("key")
        if key is None:                       # 前端留空：沿用服务端已保存的 Key
            key = str(old.get("key") or "").strip()
        if item.get("_clear"):
            key = ""
        if key:
            entry["key"] = key
        key_env = item.get("keyEnv") or str(old.get("keyEnv") or "").strip()
        if key_env:
            entry["keyEnv"] = key_env
        merged.append(entry)

    names = [entry["name"] for entry in merged]
    default_name = str(default or "").strip()
    if default_name not in names:
        old_default = str(existing.get("default") or "").strip()
        default_name = old_default if old_default in names else names[0]

    out: Dict[str, Any] = {"models": merged, "default": default_name}
    # 保留旧配置里的采样参数，避免只保存模型把其它设置清掉
    for k in ("timeout", "max_tokens", "temperature"):
        if k in existing:
            out[k] = existing[k]

    try:
        parent = os.path.dirname(os.path.abspath(target))
        if parent:
            os.makedirs(parent, exist_ok=True)
        tmp = target + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(out, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        os.replace(tmp, target)               # 原子替换：写一半断电不会留下坏 JSON
    except OSError as exc:
        return {"ok": False, "error": "写入配置文件失败：%s（目标：%s）。"
                                      "请检查该目录是否只读/被占用，或用环境变量 "
                                      "I2C_AI_CONFIG 指定一个可写路径。" % (exc, target)}
    except (TypeError, ValueError) as exc:
        return {"ok": False, "error": "配置内容无法写成 JSON：%s" % exc}
    return {"ok": True, "path": target, "count": len(merged), "default": default_name}


def _elapsed_ms(started: float) -> int:
    return int(round((time.time() - started) * 1000))


def _stored_key_for(base: str, model: str = "", path: Optional[str] = None) -> str:
    """按 Base URL（+ 模型名）在已保存的配置里找 Key，供「测试连接」不落盘使用。"""
    want_base = normalize_base(base)
    want_model = str(model or "").strip()
    entries = [m for m in (_config_data(path).get("models") or []) if isinstance(m, dict)]
    for m in entries:
        if normalize_base(str(m.get("base") or "")) != want_base:
            continue
        if want_model and str(m.get("model") or m.get("name") or "").strip() != want_model:
            continue
        key = model_key(m)
        if key:
            return key
    for m in entries:                          # 退一步：只按模型名匹配
        if want_model and str(m.get("model") or "").strip() == want_model:
            key = model_key(m)
            if key:
                return key
    return ""


def _short(text: str, limit: int = 200) -> str:
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    return text[:limit]


def _describe_test_error(exc: Exception, timeout: float) -> Tuple[str, str]:
    """把调用异常翻译成「分类 + 中文提示」，前端据此分开提示 401 / 404 / 超时。"""
    if isinstance(exc, urllib.error.HTTPError):
        try:
            detail = _short(exc.read().decode("utf-8", errors="replace"), 200)
        except Exception:
            detail = ""
        snippet = ("；服务端说明：" + detail) if detail else ""
        code = int(getattr(exc, "code", 0) or 0)
        if code in (401, 403):
            return "auth", "认证失败（HTTP %d）：API Key 无效、已过期或没有访问权限%s" % (code, snippet)
        if code == 404:
            return "notfound", ("接口不存在（HTTP 404）：请检查 Base URL 是否正确"
                                "（多数情况是少了 /v1，或地址里多了路径）%s" % snippet)
        if code == 400:
            return "badrequest", ("请求被拒绝（HTTP 400）：通常是模型名不存在，"
                                  "或该服务不支持这种调用方式%s" % snippet)
        if code == 429:
            return "ratelimit", "请求过于频繁（HTTP 429）：额度可能已用尽或被限流%s" % snippet
        if 500 <= code < 600:
            return "server", "模型服务出错（HTTP %d）：服务端暂时不可用，请稍后再试%s" % (code, snippet)
        return "http", "调用失败（HTTP %d）%s" % (code, snippet)

    if isinstance(exc, (socket.timeout, TimeoutError)):
        return "timeout", "请求超时（超过 %g 秒）：网络不通或服务端没有响应，可换网络后重试" % timeout
    if isinstance(exc, urllib.error.URLError):
        reason = getattr(exc, "reason", exc)
        text = _short(reason, 160)
        low = text.lower()
        if isinstance(reason, (socket.timeout, TimeoutError)) or "timed out" in low:
            return "timeout", "请求超时（超过 %g 秒）：%s" % (timeout, text)
        if ("name or service not known" in low or "getaddrinfo failed" in low
                or "nodename nor servname" in low or "no address associated" in low):
            return "dns", "无法解析域名：Base URL 里的网址可能写错了（%s）" % text
        # Windows 的拒绝连接是 [WinError 10061] 中文提示，所以同时认错误码与英文
        if (isinstance(reason, ConnectionRefusedError) or "refused" in low
                or "10061" in text or "积极拒绝" in text):
            return "refused", "连接被拒绝：该地址/端口没有服务在监听，请确认 Base URL 与端口（%s）" % text
        if "certificate" in low or "ssl" in low:
            return "ssl", "HTTPS 证书校验失败：%s" % text
        return "network", "无法连接：%s" % text
    return "unknown", "调用失败：%s" % _short(exc, 200)


def test_model(base: str, key: str = "", model: str = "",
               timeout: float = 15.0, path: Optional[str] = None) -> Dict[str, Any]:
    """
    测一个模型的连通性（POST /api/ai/models/test）。**不落盘**：
    只发一个最小 chat completion 请求，返回 {ok, latencyMs, error?, errorType?}。
    key 留空时用服务端已保存的同地址模型 Key（前端永远不持有明文 Key）。
    """
    base_text = str(base or "").strip()
    model_text = str(model or "").strip()
    if "://" in base_text and base_text.split("://", 1)[0].strip().lower() not in ("http", "https"):
        return {"ok": False, "latencyMs": 0, "errorType": "input",
                "error": "只支持 http(s) 接口地址（file://、javascript: 等协议不允许）"}
    if not base_text:
        return {"ok": False, "latencyMs": 0, "errorType": "input",
                "error": "请先填写 Base URL（例如 https://api.deepseek.com）"}
    if not model_text:
        return {"ok": False, "latencyMs": 0, "errorType": "input",
                "error": "请先填写模型名（例如 deepseek-chat）"}
    url = chat_url(base_text)
    api_key = str(key or "").strip()
    if not api_key:
        api_key = _stored_key_for(base_text, model_text, path)
    if not api_key:
        return {"ok": False, "latencyMs": 0, "errorType": "input",
                "error": "还没有可用的 API Key：请填写 Key，或先保存该模型再测试"
                         "（Key 只保存在服务端）"}
    try:
        timeout = max(3.0, min(60.0, float(timeout)))
    except (TypeError, ValueError):
        timeout = 15.0

    if ai_mock():
        return {"ok": True, "latencyMs": 18, "url": url, "model": model_text,
                "mock": True, "note": "联调模式 I2C_AI_MOCK=1：未真正请求模型接口"}

    payload = {
        "model": model_text,
        "messages": [{"role": "user", "content": "ping"}],
        "max_tokens": 8,
        "temperature": 0,
        "stream": False,
    }
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json",
                 "Accept": "application/json",
                 "Authorization": "Bearer " + api_key},
        method="POST")
    started = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read(65536).decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        etype, message = _describe_test_error(exc, timeout)
        return {"ok": False, "latencyMs": _elapsed_ms(started), "errorType": etype,
                "error": message, "url": url}
    except urllib.error.URLError as exc:
        etype, message = _describe_test_error(exc, timeout)
        return {"ok": False, "latencyMs": _elapsed_ms(started), "errorType": etype,
                "error": message, "url": url}
    except (socket.timeout, TimeoutError) as exc:
        return {"ok": False, "latencyMs": _elapsed_ms(started), "errorType": "timeout",
                "error": "请求超时（超过 %g 秒）：网络不通或服务端没有响应，可换网络后重试" % timeout,
                "url": url}
    except Exception as exc:
        return {"ok": False, "latencyMs": _elapsed_ms(started), "errorType": "unknown",
                "error": "调用失败：%s" % _short(exc, 200), "url": url}

    latency = _elapsed_ms(started)
    note = ""
    try:
        data = json.loads(raw) if raw else {}
    except ValueError:
        data = {}
        note = "接口返回的不是标准 JSON（可能不是 OpenAI 兼容地址）"
    if isinstance(data, dict) and data.get("error") and not data.get("choices"):
        detail = data.get("error")
        if isinstance(detail, dict):
            detail = detail.get("message") or detail.get("code") or detail
        return {"ok": False, "latencyMs": latency, "errorType": "server",
                "error": "模型返回错误：%s" % _short(detail, 200), "url": url}
    result: Dict[str, Any] = {"ok": True, "latencyMs": latency, "url": url,
                              "model": model_text}
    if note:
        result["note"] = note
    return result


# ---------------------------------------------------------------------------
# 调用链
# ---------------------------------------------------------------------------
def call_chat(messages: List[Dict[str, str]], model_name: Optional[str] = None,
              cfg: Optional[Dict[str, Any]] = None) -> Tuple[bool, str, Optional[str]]:
    """调用选中的模型（OpenAI 兼容），返回 (ok, content, error)。"""
    cfg = cfg or load_config()
    models = cfg.get("models", [])
    name = model_name or cfg.get("default") or (models[0]["name"] if models else "DeepSeek")
    target = None
    for m in models:
        if isinstance(m, dict) and m.get("name") == name:
            target = m
            break
    if target is None:
        return False, "", f"未找到模型：{name}"
    base = str(target.get("base", "")).rstrip("/")
    if not base:
        return False, "", f"模型 {name} 未配置接口地址 base"
    key = model_key(target)
    if not key:
        return False, "", f"模型 {name} 未配置 API Key（可在界面「AI 设置」里填写，或写环境变量）"
    url = chat_url(base)
    payload = {
        "model": str(target.get("model", name)),
        "messages": messages,
        "temperature": float(cfg.get("temperature", 0.2)),
        "max_tokens": int(cfg.get("max_tokens", 1200)),
    }
    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"),
                                 headers={"Content-Type": "application/json",
                                          "Authorization": "Bearer " + key},
                                 method="POST")
    try:
        with urllib.request.urlopen(req, timeout=float(cfg.get("timeout", 60))) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        content = data["choices"][0]["message"]["content"]
        return True, str(content), None
    except urllib.error.HTTPError as exc:
        return False, "", f"模型 {name} 返回 HTTP {exc.code}: {exc.read().decode('utf-8', errors='replace')[:200]}"
    except Exception as exc:
        return False, "", f"调用模型 {name} 失败：{exc}"


def stream_chat(messages, model_name=None, cfg=None):
    """流式调用（OpenAI 兼容 SSE）：逐段 yield 文本增量。失败抛 RuntimeError。"""
    import time as _time
    cfg = cfg or load_config()

    # 联调模式：I2C_AI_MOCK=1 时不联网，吐一段固定中文，用于验证流式链路
    if os.environ.get("I2C_AI_MOCK") == "1":
        demo = ("（联调模式）已收到本次识图结果：共识别 12 条线段、1 个圆、1 个矩形、2 处文字区，"
                "F1 自检 0.982，用时约 1.8 秒。整体质量良好，轮廓闭合度不错；"
                "建议关注文字区边缘是否漏检，以及虚线合并阈值是否偏大。")
        for i in range(0, len(demo), 5):
            yield demo[i:i + 5]
            _time.sleep(0.02)
        return

    models = cfg.get("models", [])
    name = model_name or cfg.get("default") or (models[0]["name"] if models else "DeepSeek")
    target = None
    for m in models:
        if isinstance(m, dict) and m.get("name") == name:
            target = m
            break
    if target is None:
        raise RuntimeError("未找到模型：%s" % name)
    base = str(target.get("base", "")).rstrip("/")
    if not base:
        raise RuntimeError("模型 %s 未配置接口地址 base" % name)
    key = model_key(target)
    if not key:
        raise RuntimeError("模型 %s 未配置 API Key（可在界面「AI 设置」里填写，或写环境变量）" % name)

    url = chat_url(base)
    payload = {
        "model": str(target.get("model", name)),
        "messages": messages,
        "temperature": float(cfg.get("temperature", 0.2)),
        "max_tokens": int(cfg.get("max_tokens", 1200)),
        "stream": True,
    }
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json",
                 "Accept": "text/event-stream",
                 "Authorization": "Bearer " + key},
        method="POST")
    try:
        resp = urllib.request.urlopen(req, timeout=float(cfg.get("timeout", 60)))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:200]
        raise RuntimeError("模型 %s 返回 HTTP %s: %s" % (name, exc.code, detail))
    except Exception as exc:
        raise RuntimeError("连接模型 %s 失败：%s" % (name, exc))

    with resp:
        for raw in resp:
            try:
                line = raw.decode("utf-8", errors="replace").strip()
            except Exception:
                continue
            if not line or not line.startswith("data:"):
                continue
            chunk = line[5:].strip()
            if chunk == "[DONE]":
                break
            try:
                obj = json.loads(chunk)
            except Exception:
                continue
            for choice in (obj.get("choices") or []):
                delta = choice.get("delta") or {}
                piece = delta.get("content")
                if piece:
                    yield piece



# ---------------------------------------------------------------------------
# 自然语言 -> Options 解析（规则降级；AI 与规则共用同一份字段）
# ---------------------------------------------------------------------------
def parse_options(text: str) -> Dict[str, Any]:
    text = text or ""
    changes: Dict[str, Any] = {}
    low = text.lower()
    if ("竖" in text) or ("竖版" in text) or ("9:16" in text):
        changes["_canvas"] = "portrait"
    if ("横版" in text) or ("横向图" in text) or ("16:9" in text and "9:16" not in text):
        changes["_canvas"] = "landscape"
    if ("方形" in text) or ("1:1" in text) or ("正方" in text):
        changes["_canvas"] = "square"
    m = re.search(r"图幅s*[宽度]?s*([0-9]{2,4})", text)
    if m:
        changes["sheet_width_mm"] = int(m.group(1))
    m = re.search(r"([0-9]{2,4})s*(mm|毫米)", text)
    if m and "sheet_width_mm" not in changes:
        changes["sheet_width_mm"] = int(m.group(1))
    if ("降噪" in text) or ("去噪" in text):
        if ("强" in text) or ("多噪" in text) or ("脏" in text):
            changes["denoise"] = 3
        elif ("轻" in text) or ("少" in text):
            changes["denoise"] = 1
        else:
            changes["denoise"] = 2
    if ("自适应" in text) or ("光照" in text) or ("强光" in text) or ("阴影" in text):
        changes["binarize_method"] = "adaptive"
    if "sauvola" in low or "索沃拉" in text:
        changes["binarize_method"] = "sauvola"
    m = re.search(r"最短线段s*([0-9.]+)", text)
    if m:
        changes["min_line_ratio"] = float(m.group(1))
    m = re.search(r"吸附角度s*([0-9.]+)", text)
    if m:
        changes["snap_ortho_deg"] = float(m.group(1))
    no_ocr = ("不要字" in text) or ("不要识别文字" in text) or ("不识别文字" in text) or ("不OCR" in text) or ("不要OCR" in text) or ("关闭识别" in text)
    if no_ocr:
        changes["ocr"] = False
    elif ("要字" in text) or ("要识别文字" in text) or ("识别文字" in text) or ("ocr" in low):
        changes["ocr"] = True
    no_rec = ("不要联动" in text) or ("不联动" in text) or ("不要识别字段" in text) or ("关闭联动" in text)
    if no_rec:
        changes["run_recognition"] = False
    elif ("联动" in text) or ("识别字段" in text) or ("图框" in text):
        changes["run_recognition"] = True
    return changes


# ---------------------------------------------------------------------------
# 意图动作识别
# ---------------------------------------------------------------------------
def parse_action(text: str) -> Dict[str, Any]:
    """识别用户想做的动作。action ∈ run / annotate / classify / apply / describe。"""
    text = text or ""
    a: Dict[str, Any] = {"action": "apply", "params": parse_options(text)}
    if any(k in text for k in ("转cad", "转成cad", "生成cad", "成图", "制图", "矢量化",
                               "变成cad", "生成dxf", "转dxf", "画成")):
        a["action"] = "run"
    if any(k in text for k in ("标注", "尺寸标注", "标尺寸", "dimension", "标个尺寸", "加个尺寸")):
        a["action"] = "annotate"
        a["annotate"] = True
    if any(k in text for k in ("分类", "图层", "分层", "归类", "图层整理")):
        a["action"] = "classify"
        a["classify"] = True
    if any(k in text for k in ("这个是什么", "解释", "原理", "怎么回事", "怎么用")):
        a["action"] = "describe"
    return a


RULE_HINTS = {
    "run": "我会启动「看图成图」流水线，把这张图变成可编辑的 CAD（DXF），并自动图层分类。",
    "annotate": "我会在生成的 CAD 里自动加上尺寸标注，并整理到「尺寸标注」图层。",
    "classify": "我会把图元自动分类到 轮廓 / 中心线 / 尺寸标注 / 文字 / 图框 图层。",
    "apply": "我会根据你的话调整参数后再执行。",
    "describe": "我会解释这张图当前的识别结果与各图元类型。",
}


def ai_handle(text: str, model_name: Optional[str] = None,
              current_options: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    处理一次 AI 输入。返回：
        {ok, action, parsed, canvas, changes, hint, model, reply, error}
    前端据此：应用 parsed 里的参数、按 action 触发执行、展示 hint/reply。
    """
    action = parse_action(text)
    parsed = action["params"]
    hint = RULE_HINTS.get(action["action"], "")
    reply: Optional[str] = None
    mo_err: Optional[str] = None

    if model_name or load_config().get("default"):
        sys_prompt = (
            "你是 CAD 图纸智能制作助手。用户给你一句话（中文），请判断他想做什么。"
            "只输出 JSON，不要多余文字。字段："
            "action ∈ {run, annotate, classify, apply, describe}，"
            "options 为要调整的 image2cad.Options 字段"
            "（sheet_width_mm, denoise, binarize_method, min_line_ratio, snap_ortho_deg, "
            "ocr, run_recognition），canvas ∈ {portrait, landscape, square} 可选，"
            "reply 为一句中文，说明你对本次任务的动作。"
        )
        ok, content, err = call_chat(
            [{"role": "system", "content": sys_prompt},
             {"role": "user", "content": text or "请解释这个图纸工具怎么用"}],
            model_name)
        if ok:
            try:
                j = json.loads(_strip_json(content))
                if isinstance(j, dict):
                    a = j.get("action") or action["action"]
                    opts = j.get("options") or {}
                    reply = j.get("reply") or hint
                    if j.get("canvas"):
                        opts = dict(opts)
                        opts["_canvas"] = j["canvas"]
                    return {
                        "ok": True, "action": a, "parsed": opts,
                        "canvas": j.get("canvas"),
                        "changes": {k: v for k, v in opts.items() if not k.startswith("_")},
                        "hint": reply, "model": model_name or load_config().get("default"),
                        "reply": reply, "error": None,
                    }
            except Exception:
                reply = content
        else:
            mo_err = err
    return {
        "ok": True, "action": action["action"], "parsed": parsed,
        "canvas": parsed.get("_canvas"),
        "changes": {k: v for k, v in parsed.items() if not k.startswith("_")},
        "hint": hint, "model": model_name or load_config().get("default"),
        "reply": reply, "error": mo_err,
    }


def _strip_json(text: str) -> str:
    if not text:
        return "{}"
    if text.strip().startswith("~"):
        lines = text.splitlines()
        lines = [l for l in lines if not l.strip().startswith("~")]
        return "\n".join(lines)
    return text


if __name__ == "__main__":
    import sys
    arg = sys.argv[1] if len(sys.argv) > 1 else "把这张图转成CAD并加上尺寸标注"
    r = ai_handle(arg, None, None)
    print(json.dumps(r, ensure_ascii=False, indent=1))
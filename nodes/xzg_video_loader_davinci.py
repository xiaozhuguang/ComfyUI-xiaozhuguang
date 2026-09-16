"""
小珠光视频加载-达芬奇
=====================

在「小珠光视频加载器」的全部功能基础上，新增「从 DaVinci Resolve 导入」能力：
- 前端一个按钮：加载视频
- 本模块通过独立的达芬奇桥接脚本（xzg_davinci_bridge.py，subprocess 隔离运行）触达
  本机已运行的 Resolve Studio，把剪辑页当前播放头所在片段自动渲染导出到 ComfyUI。
- 加载视频：达芬奇导出 H.264/MP4 到 input 根目录 → 前端下拉选中

继承 XiaozhuguangVideoLoader，视频解码/预览/上传/快剪联动等能力完全复用，不修改原加载器。
"""

import json
import os
import subprocess
import sys
import time
import traceback

import folder_paths
from server import PromptServer as _PS
from aiohttp import web as _web

from .xzg_video_loader import (
    XiaozhuguangVideoLoader,
)

_BRIDGE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "xzg_davinci_bridge.py")
_DV_INPUT_SUBDIR = ""           # 导出的视频直接放 input 根目录，组合框可列出
_RENDER_TIMEOUT = 1800          # 渲染等待超时（秒）


class XiaozhuguangVideoLoaderDaVinci(XiaozhuguangVideoLoader):
    """小珠光视频加载-达芬奇：复用加载器全部功能，交互前端新增一个达芬奇导入按钮。"""

    # INPUT_TYPES / RETURN_TYPES / FUNCTION / CATEGORY / load_video 全部继承自父类，
    # 只在 CATEGORY 下作为独立节点名出现，由 __init__.py 注册为「小珠光视频加载-达芬奇」。

    @classmethod
    def IS_CHANGED(cls, *args, **kwargs):
        # 达芬奇导入会替换「视频」输入，IS_CHANGED 需与本节点名一致；父类实现已足够，
        # 直接委托父类（父类签名含视频等参数）。
        return super().IS_CHANGED(*args, **kwargs)


# ═══════════════════════════════════════════════════════════════════════════
# 达芬奇桥接 subprocess 调用
# ═══════════════════════════════════════════════════════════════════════════


def _call_bridge(payload):
    """以独立子进程运行达芬奇桥接脚本，返回 dict。超时/异常返回错误 dict。"""
    try:
        proc = subprocess.run(
            [sys.executable, _BRIDGE_PATH],
            input=json.dumps(payload, ensure_ascii=False),
            capture_output=True, text=True, timeout=_RENDER_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"达芬奇渲染等待超时（{_RENDER_TIMEOUT} 秒）"}
    except Exception as e:
        return {"ok": False, "error": f"无法启动达芬奇桥接进程：{e}"}
    out = (proc.stdout or "").strip()
    err = (proc.stderr or "").strip()
    if not out:
        return {"ok": False, "error": f"达芬奇桥接无输出：{err or '（空）'}"}
    try:
        return json.loads(out)
    except Exception:
        return {"ok": False, "error": f"达芬奇桥接返回异常：{out[:500]} / {err[:300]}"}


def _safe_davinci_name(name):
    """转成安全的文件名前缀，供达芬奇 CustomName 使用。"""
    import re as _re
    s = _re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', str(name or "")).strip()
    return s.replace("  ", " ")[:80] or "xzg_dv_import"


# ═══════════════════════════════════════════════════════════════════════════
# 路由安全装饰器（与加载器一致）
# ═══════════════════════════════════════════════════════════════════════════

import functools as _ft
try:
    from .. import xzg_safe_handler as _safe_handler
except Exception:
    import asyncio as _aio

    def _safe_handler(fn):
        def _fmt(exc, status=500):
            return _web.json_response(
                {"error": f"{type(exc).__name__}: {exc}",
                 "traceback": "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))},
                status=status)

        if _aio.iscoroutinefunction(fn):
            @_ft.wraps(fn)
            async def _aw(*a, **kw):
                try:
                    return await fn(*a, **kw)
                except _web.HTTPException:
                    raise
                except BaseException as e:
                    print(f"[小珠光-达芬奇] {fn.__name__}: {type(e).__name__}: {e}")
                    return _fmt(e)
            return _aw

        @_ft.wraps(fn)
        def _sw(*a, **kw):
            try:
                return fn(*a, **kw)
            except _web.HTTPException:
                raise
            except BaseException as e:
                print(f"[小珠光-达芬奇] {fn.__name__}: {type(e).__name__}: {e}")
                return _fmt(e)
        return _sw


_need_routes = True
if getattr(_PS, "instance", None) is not None and getattr(_PS.instance, "routes", None) is not None:

    @_PS.instance.routes.get("/xzg/davinci/status")
    @_safe_handler
    async def xzg_davinci_status(request):
        """检查达芬奇是否可连接，并返回当前项目/时间线/播放头所在片段信息。"""
        result = _call_bridge({"action": "status"})
        return _web.json_response(result)

    @_PS.instance.routes.post("/xzg/davinci/export")
    @_safe_handler
    async def xzg_davinci_export(request):
        """触发从达芬奇导出当前播放头所在片段为视频。
        返回 { ok, filename, clip:{name,start,end} }，filename 为 input 相对文件名。"""
        data = await request.json()
        input_dir = folder_paths.get_input_directory()
        ts = int(time.time() * 1000)
        name = _safe_davinci_name(data.get("name") or "")
        prefix = (name + "_") if name else ""
        base_name = f"xzg_dv_{prefix}{ts}"
        result = _call_bridge({"action": "export",
                               "out_dir": input_dir,
                               "name": base_name,
                               "mode": "video"})
        if result.get("ok"):
            result["filename"] = result.get("filename", "")
        return _web.json_response(result)

    _need_routes = False
"""
小珠光视频加载-化神级
=====================

合并「小珠光视频加载-化神级（达芬奇导入）」与「小珠光视频批处理（片段窗口）」两个节点：

1. 达芬奇导入：前端按钮触达本机 DaVinci Resolve Studio（xzg_davinci_bridge.py，subprocess 隔离），
   把剪辑页当前播放头所在片段自动渲染导出到 ComfyUI input 根目录并加载。
2. 片段窗口：片段起点/片段终点 + 前端「场景逐段批处理」编排器（web/xzg_video_batch.js），
   自动探测视频切点并逐段执行。

继承 XiaozhuguangVideoBatchLoader，视频解码/预览/上传/快剪联动等能力完全复用。
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

from .xzg_video_batch_loader import XiaozhuguangVideoBatchLoader

_BRIDGE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "xzg_davinci_bridge.py")
_DV_INPUT_SUBDIR = ""           # 导出的视频直接放 input 根目录，组合框可列出
_RENDER_TIMEOUT = 1800          # 渲染等待超时（秒）


class XiaozhuguangVideoLoaderDaVinci(XiaozhuguangVideoBatchLoader):
    """小珠光视频加载-化神级：加载器全部功能 + 片段窗口（场景逐段批处理）+ 达芬奇导入。

    INPUT_TYPES / RETURN_TYPES / FUNCTION / CATEGORY / load_video / IS_CHANGED 全部继承自
    「小珠光视频批处理」父类（含片段起点/片段终点），由 __init__.py 注册为「小珠光视频加载-化神级」。"""

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


def _resolve_loader_video_path(filename, file_type="input"):
    """解析加载器当前视频的受限路径，仅允许 ComfyUI input/output/temp 目录内文件。"""
    roots = {
        "input": folder_paths.get_input_directory,
        "output": folder_paths.get_output_directory,
        "temp": folder_paths.get_temp_directory,
    }
    root_fn = roots.get(str(file_type or "input").lower())
    if root_fn is None:
        return None
    root = os.path.abspath(root_fn())
    candidate = os.path.abspath(os.path.join(root, str(filename or "")))
    try:
        if os.path.commonpath([root, candidate]) != root:
            return None
    except ValueError:
        return None
    return candidate if os.path.isfile(candidate) else None


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

    @_PS.instance.routes.post("/xzg/davinci/loader-import")
    @_safe_handler
    async def xzg_davinci_loader_import(request):
        """把化神级视频加载器当前选择的视频导入达芬奇。

        前端仅提交相对文件名和 ComfyUI 文件类型；服务端限制解析范围，避免任意本地路径读取。
        """
        data = await request.json()
        filename = str(data.get("filename") or "")
        file_type = str(data.get("type") or "input")
        abs_path = _resolve_loader_video_path(filename, file_type)
        if not abs_path:
            return _web.json_response({"ok": False, "error": "视频文件不存在，或不在允许的 ComfyUI 目录中"})
        result = _call_bridge({"action": "import", "file_path": abs_path})
        return _web.json_response(result)

    _need_routes = False

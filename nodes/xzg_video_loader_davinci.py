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
import shutil
import subprocess
import sys
import time
import traceback
import uuid
import asyncio
from datetime import datetime

import folder_paths
from server import PromptServer as _PS
from aiohttp import web as _web

from .xzg_video_batch_loader import XiaozhuguangVideoBatchLoader

_BRIDGE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "xzg_davinci_bridge.py")
_DV_INPUT_SUBDIR = ""           # 导出的视频直接放 input 根目录，组合框可列出
_RENDER_TIMEOUT = 1800          # 渲染等待超时（秒）
_DAVINCI_VIDEO_EXPORT_SESSION = uuid.uuid4().hex


def _choose_video_save_path(source_path):
    """用 Windows 原生另存为窗口选择视频副本位置。"""
    if os.name != "nt":
        raise RuntimeError("Windows 原生另存为窗口仅支持 Windows 后端")
    powershell = os.path.join(
        os.environ.get("WINDIR", r"C:\Windows"),
        "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
    )
    if not os.path.isfile(powershell):
        powershell = shutil.which("powershell.exe")
    if not powershell:
        raise FileNotFoundError("找不到 Windows PowerShell（powershell.exe），无法打开另存为窗口")
    ext = os.path.splitext(source_path)[1].lstrip(".") or "mp4"
    env = os.environ.copy()
    env["XZG_VIDEO_SAVE_NAME"] = os.path.basename(source_path)
    env["XZG_VIDEO_SAVE_EXT"] = ext
    script = r'''
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ext = $env:XZG_VIDEO_SAVE_EXT
$dlg = New-Object System.Windows.Forms.SaveFileDialog
$dlg.Title = '导出视频到达芬奇'
$dlg.Filter = "视频文件 (*.$ext)|*.$ext|所有文件 (*.*)|*.*"
$dlg.DefaultExt = $ext
$dlg.AddExtension = $true
$dlg.FileName = $env:XZG_VIDEO_SAVE_NAME
$dlg.OverwritePrompt = $false
$dlg.RestoreDirectory = $true
if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($dlg.FileName)
  [Console]::Write([Convert]::ToBase64String($bytes))
}
'''
    proc = subprocess.run([powershell, "-NoProfile", "-STA", "-Command", script],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300,
        env=env, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or "").strip() or "无法打开 Windows 另存为窗口")
    encoded = (proc.stdout or "").strip()
    if not encoded:
        return None
    import base64
    return base64.b64decode(encoded).decode("utf-8")


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


def _copy_loader_video_to_output(source_path, base_dir, filename_prefix="xzg-davinci",
                                 add_date_stamp=False, add_time_stamp=False):
    """复制加载器源视频到达芬奇导出设置中的目录，返回副本路径。"""
    # 与视频保存节点一致：绝对目录直接使用，相对目录置于 ComfyUI output 下。
    from .xzg_video_combine import _xzg_is_absolute_path, _xzg_sanitize_path

    resolved_base = _xzg_sanitize_path(str(base_dir or "").strip())
    if not resolved_base:
        raise ValueError("自定义输出目录为空")
    destination_dir = (resolved_base if _xzg_is_absolute_path(resolved_base)
                       else os.path.join(folder_paths.get_output_directory(), resolved_base))
    os.makedirs(destination_dir, exist_ok=True)

    prefix = _safe_davinci_name(filename_prefix or "xzg-davinci")
    now = datetime.now()
    stamps = []
    if add_date_stamp:
        stamps.append(now.strftime("%Y-%m-%d"))
    if add_time_stamp:
        stamps.append(now.strftime("%H%M%S"))
    if stamps:
        prefix = "-".join([*stamps, prefix])
    # 以源文件名作为副本名：同一视频重复导出覆盖同一文件，不再每次生成新命名文件；保留容器扩展名。
    ext = os.path.splitext(source_path)[1] or ".mp4"
    stem = _safe_davinci_name(os.path.splitext(os.path.basename(source_path))[0]) or "xzg-davinci"
    destination_path = os.path.join(destination_dir, f"{prefix}_{stem}{ext}")
    shutil.copy2(source_path, destination_path)
    return destination_path


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

    @_PS.instance.routes.get("/xzg/davinci/video-export-session")
    @_safe_handler
    async def xzg_davinci_video_export_session(request):
        return _web.json_response(
            {"session": _DAVINCI_VIDEO_EXPORT_SESSION},
            headers={"Cache-Control": "no-store, no-cache, must-revalidate", "Pragma": "no-cache", "Expires": "0"},
        )

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
            filename = os.path.basename(str(result.get("filename") or ""))
            exported_path = os.path.join(input_dir, filename)
            if not filename or not os.path.isfile(exported_path) or os.path.getsize(exported_path) <= 0:
                return _web.json_response({"ok": False, "error": "达芬奇报告导出成功，但找不到有效的视频文件；请检查渲染格式与 input 目录"})
            result["filename"] = filename
        return _web.json_response(result)

    @_PS.instance.routes.post("/xzg/davinci/loader-import")
    @_safe_handler
    async def xzg_davinci_loader_import(request):
        """把化神级视频加载器当前选择的视频导入达芬奇。

        前端仅提交相对文件名和 ComfyUI 文件类型；服务端限制解析范围，避免任意本地路径读取。
        如选择自定义输出目录，服务端会将已验证的源文件复制过去再导入。
        """
        data = await request.json()
        filename = str(data.get("filename") or "")
        file_type = str(data.get("type") or "input")
        abs_path = _resolve_loader_video_path(filename, file_type)
        if not abs_path:
            return _web.json_response({"ok": False, "error": "视频文件不存在，或不在允许的 ComfyUI 目录中"})
        target_dir = str(data.get("target_dir") or "").strip()
        selected_path = None
        try:
            if target_dir and not os.path.isdir(target_dir):
                target_dir = ""
            if not target_dir:
                selected_path = await asyncio.to_thread(_choose_video_save_path, abs_path)
                if not selected_path:
                    return _web.json_response({"ok": False, "cancelled": True})
                target_dir = os.path.dirname(selected_path)
                target_name = os.path.basename(selected_path)
            else:
                if not os.path.isabs(target_dir):
                    return _web.json_response({"ok": False, "error": "保存目录必须是完整路径"})
                target_name = os.path.basename(str(data.get("target_name") or os.path.basename(abs_path)))
            os.makedirs(target_dir, exist_ok=True)
            from .xzg_audio_loader_davinci import _find_exported_copy
            target_path = await asyncio.to_thread(_find_exported_copy, abs_path, target_dir)
            if target_path is None:
                target_path = selected_path or os.path.join(target_dir, target_name)
                if os.path.exists(target_path) and os.path.normcase(os.path.abspath(abs_path)) != os.path.normcase(os.path.abspath(target_path)):
                    stem, ext = os.path.splitext(target_path)
                    index = 2
                    while os.path.exists(f"{stem}_{index}{ext}"):
                        index += 1
                    target_path = f"{stem}_{index}{ext}"
                if os.path.normcase(os.path.abspath(abs_path)) != os.path.normcase(os.path.abspath(target_path)):
                    await asyncio.to_thread(shutil.copy2, abs_path, target_path)
        except Exception as e:
            return _web.json_response({"ok": False, "error": f"选择或保存视频文件失败：{e}"})
        result = _call_bridge({"action": "import", "file_path": target_path})
        result["copied"] = True
        result["save_directory"] = target_dir
        result["save_filename"] = os.path.basename(target_path)
        return _web.json_response(result)

    _need_routes = False

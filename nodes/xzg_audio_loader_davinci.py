"""
小珠光音频加载器-化神级
======================

在「小珠光音频加载器」基础上，新增「从达芬奇导入」：
把达芬奇播放头所在音频轨道片段渲染导出并加载到本节点。

片段选择与导出策略（见 xzg_davinci_bridge.py action=export_audio）：
- 只取音频轨道播放头所在片段
- 首次导出时要求选择自定义目录；不向默认 output 目录导出

前端（web/xzg_audio_loader.js 化神级分支）在波形区右上角提供
悬浮「从达芬奇导入」按钮：导出 → 刷新音频下拉 → 自动选中并预览。

继承 XiaozhuguangAudioLoader，INPUT_TYPES / load_audio / IS_CHANGED 全部复用。
"""

import asyncio
import hashlib
import os
import shutil
import subprocess
import time
import uuid

import folder_paths
from server import PromptServer as _PS
from aiohttp import web as _web

from .xzg_audio_loader import XiaozhuguangAudioLoader, AUDIO_EXTENSIONS
from .xzg_video_loader_davinci import _call_bridge, _safe_davinci_name
from .xzg_audio_save import ffmpeg_path

_DAVINCI_AUDIO_LOADER_SESSION = uuid.uuid4().hex
_AUDIO_SHA256_CACHE = {}

# 路由安全装饰器（与视频加载器-化神级一致）
import functools as _ft
import traceback as _tb
try:
    from .. import xzg_safe_handler as _safe_handler
except Exception:
    import asyncio as _aio

    def _safe_handler(fn):
        def _fmt(exc, status=500):
            return _web.json_response(
                {"error": f"{type(exc).__name__}: {exc}",
                 "traceback": "".join(_tb.format_exception(type(exc), exc, exc.__traceback__))},
                status=status)

        if _aio.iscoroutinefunction(fn):
            @_ft.wraps(fn)
            async def _aw(*a, **kw):
                try:
                    return await fn(*a, **kw)
                except _web.HTTPException:
                    raise
                except BaseException as e:
                    print(f"[小珠光-达芬奇音频] {fn.__name__}: {type(e).__name__}: {e}")
                    return _fmt(e)
            return _aw

        @_ft.wraps(fn)
        def _sw(*a, **kw):
            try:
                return fn(*a, **kw)
            except _web.HTTPException:
                raise
            except BaseException as e:
                print(f"[小珠光-达芬奇音频] {fn.__name__}: {type(e).__name__}: {e}")
                return _fmt(e)
        return _sw


class XiaozhuguangAudioLoaderDaVinci(XiaozhuguangAudioLoader):
    """小珠光音频加载器-化神级：音频加载器全部功能 + 从达芬奇导入音频。

    INPUT_TYPES / load_audio / IS_CHANGED 全部继承自「小珠光音频加载器」，
    由 __init__.py 注册为「小珠光音频加载器-化神级」；
    前端在波形区提供「从达芬奇导入」悬浮按钮（web/xzg_audio_loader.js 化神级分支）。
    """

    DESCRIPTION = (
        "小珠光音频加载器-化神级：与音频加载器功能一致。\n"
        "额外支持「从达芬奇导入」：把达芬奇播放头所在音频轨道片段渲染导出并加载到本节点。"
    )


_XZG_SAVE_DIALOG_PS = r'''
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
if (-not ('XzgWin32' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class XzgWin32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
}
"@
}
$dlg = New-Object System.Windows.Forms.SaveFileDialog
$dlg.Title = $env:XZG_SAVE_TITLE
$dlg.Filter = $env:XZG_SAVE_FILTER
$dlg.DefaultExt = $env:XZG_SAVE_EXT
$dlg.AddExtension = $true
$dlg.FileName = $env:XZG_SAVE_NAME
$dlg.OverwritePrompt = $false
$dlg.RestoreDirectory = $true
# 隐藏的置顶宿主窗体（屏幕外）：对话框拥有它，弹出后浮在普通窗口之上
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$owner.Bounds = New-Object System.Drawing.Rectangle(-32000, -32000, 1, 1)
$owner.Show()
[System.Windows.Forms.Application]::DoEvents()
try {
  # 本子进程无窗口、没有前台权限；临时把本线程挂到前台线程后即可调用
  # SetForegroundWindow，避免对话框被压在其它窗口后面
  $fg = [XzgWin32]::GetForegroundWindow()
  if ($fg -ne [IntPtr]::Zero) {
    $fgPid = [uint32]0
    $fgThread = [XzgWin32]::GetWindowThreadProcessId($fg, [ref]$fgPid)
    $myThread = [XzgWin32]::GetCurrentThreadId()
    if ($fgThread -and $fgThread -ne $myThread) {
      [void][XzgWin32]::AttachThreadInput($myThread, $fgThread, $true)
      [void][XzgWin32]::SetForegroundWindow($owner.Handle)
      [void][XzgWin32]::BringWindowToTop($owner.Handle)
      [void][XzgWin32]::AttachThreadInput($myThread, $fgThread, $false)
    }
  }
  if ($dlg.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($dlg.FileName)
    [Console]::Write([Convert]::ToBase64String($bytes))
  }
} finally {
  $owner.Dispose()
}
'''


def _xzg_choose_save_path(source_path, title, filter_label, default_ext):
    """弹出 Windows 原生另存为对话框并返回所选绝对路径，取消返回 None。

    对话框由 ComfyUI 后端的无窗口子进程弹出：该进程不在前台，Windows 默认
    拒绝其抢占前台，对话框常被压在其它窗口后面（需最小化所有窗口才能看到）。
    这里用「屏幕外置顶宿主窗体 + AttachThreadInput 抢前台」双保险，确保
    对话框始终显示在最前面。
    """
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
    env = os.environ.copy()
    env["XZG_SAVE_NAME"] = os.path.basename(source_path)
    env["XZG_SAVE_EXT"] = default_ext
    env["XZG_SAVE_TITLE"] = title
    env["XZG_SAVE_FILTER"] = f"{filter_label} (*.{default_ext})|*.{default_ext}|所有文件 (*.*)|*.*"
    proc = subprocess.run(
        [powershell, "-NoProfile", "-STA", "-Command", _XZG_SAVE_DIALOG_PS],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=300, env=env,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if proc.returncode != 0:
        detail = (proc.stderr or "").strip()
        raise RuntimeError(detail or "无法打开 Windows 另存为窗口")
    encoded_path = (proc.stdout or "").strip()
    if not encoded_path:
        return None
    import base64
    return base64.b64decode(encoded_path).decode("utf-8")


def _choose_audio_save_path(source_path):
    """Show the native Windows Save As dialog and return the selected path, or None."""
    return _xzg_choose_save_path(
        source_path,
        title="导出音频到达芬奇",
        filter_label="音频文件",
        default_ext=os.path.splitext(source_path)[1].lstrip(".") or "wav",
    )


def _file_sha256_cache_key(path):
    stat = os.stat(path)
    return (os.path.normcase(os.path.abspath(path)), stat.st_size, stat.st_mtime_ns)


def _cache_audio_sha256(path, digest):
    try:
        key = _file_sha256_cache_key(path)
        _AUDIO_SHA256_CACHE[key] = digest
        while len(_AUDIO_SHA256_CACHE) > 512:
            _AUDIO_SHA256_CACHE.pop(next(iter(_AUDIO_SHA256_CACHE)))
    except OSError:
        pass


def _file_sha256(path):
    key = _file_sha256_cache_key(path)
    cached = _AUDIO_SHA256_CACHE.get(key)
    if cached is not None:
        return cached
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    result = digest.digest()
    _cache_audio_sha256(path, result)
    return result


def _find_exported_copy(source_path, target_dir):
    """Find a byte-identical audio export so repeat clicks can reuse it."""
    try:
        source_size = os.path.getsize(source_path)
        source_ext = os.path.splitext(source_path)[1].lower()
        source_hash = _file_sha256(source_path)
        with os.scandir(target_dir) as entries:
            for entry in entries:
                if not entry.is_file() or os.path.splitext(entry.name)[1].lower() != source_ext:
                    continue
                try:
                    if entry.stat().st_size == source_size and _file_sha256(entry.path) == source_hash:
                        return entry.path
                except OSError:
                    continue
    except (OSError, FileNotFoundError):
        return None
    return None


if getattr(_PS, "instance", None) is not None and getattr(_PS.instance, "routes", None) is not None:

    @_PS.instance.routes.get("/xzg/davinci/audio-loader-session")
    @_safe_handler
    async def xzg_davinci_audio_loader_session(request):
        """Return a new id whenever the ComfyUI backend process starts."""
        return _web.json_response(
            {"session": _DAVINCI_AUDIO_LOADER_SESSION},
            headers={"Cache-Control": "no-store, no-cache, must-revalidate", "Pragma": "no-cache", "Expires": "0"},
        )

    @_PS.instance.routes.post("/xzg/davinci/audio-loader-import")
    @_safe_handler
    async def xzg_davinci_audio_loader_import(request):
        """通过 Windows 原生另存为窗口选择目标文件，复制并导入达芬奇。"""
        try:
            data = await request.json()
        except Exception:
            data = {}
        filename = str(data.get("filename") or "")
        try:
            source = folder_paths.get_annotated_filepath(filename)
        except Exception:
            source = None
        if not source or not os.path.isfile(source):
            return _web.json_response({"ok": False, "error": "音频文件不存在，或不在允许的 ComfyUI 目录中"})
        target_dir = str(data.get("target_dir") or "").strip()
        selected_path = None
        try:
            if target_dir and not os.path.isdir(target_dir):
                target_dir = ""
            if not target_dir:
                selected_path = await asyncio.to_thread(_choose_audio_save_path, source)
                if not selected_path:
                    return _web.json_response({"ok": False, "cancelled": True})
                target_dir = os.path.dirname(selected_path)
                target_name = os.path.basename(selected_path)
            else:
                if not os.path.isabs(target_dir):
                    return _web.json_response({"ok": False, "error": "保存目录必须是完整路径"})
                stem = _safe_davinci_name(os.path.splitext(os.path.basename(source))[0]) or "audio"
                ext = os.path.splitext(source)[1] or ".wav"
                requested_name = str(data.get("target_name") or "").strip()
                target_name = os.path.basename(requested_name) if requested_name else f"{stem}{ext}"
            os.makedirs(target_dir, exist_ok=True)
            target_path = await asyncio.to_thread(_find_exported_copy, source, target_dir)
            if target_path is None:
                target_path = selected_path or os.path.join(target_dir, target_name)
                if os.path.exists(target_path) and os.path.normcase(os.path.abspath(source)) != os.path.normcase(os.path.abspath(target_path)):
                    stem, ext = os.path.splitext(target_path)
                    index = 2
                    while os.path.exists(f"{stem}_{index}{ext}"):
                        index += 1
                    target_path = f"{stem}_{index}{ext}"
                if os.path.normcase(os.path.abspath(source)) != os.path.normcase(os.path.abspath(target_path)):
                    source_hash = await asyncio.to_thread(_file_sha256, source)
                    await asyncio.to_thread(shutil.copy2, source, target_path)
                    _cache_audio_sha256(target_path, source_hash)
        except Exception as e:
            return _web.json_response({"ok": False, "error": f"选择或保存音频文件失败：{e}"})
        result = _call_bridge({"action": "import_audio", "file_path": target_path})
        result["copied"] = True
        result["save_directory"] = target_dir
        result["save_filename"] = os.path.basename(target_path)
        return _web.json_response(result)

    @_PS.instance.routes.post("/xzg/davinci/export_audio")
    @_safe_handler
    async def xzg_davinci_export_audio(request):
        """导出达芬奇当前播放头片段的音频到 input 目录，返回可直接加载的音频文件名。

        桥接导出的产物可能是 wav（纯音频渲染）或视频文件（兜底整段渲染）；
        视频产物用 ffmpeg 抽取为同名 wav（音频加载器可直接加载），中间视频删除。
        """
        try:
            data = await request.json()
        except Exception:
            data = {}
        input_dir = folder_paths.get_input_directory()
        ts = int(time.time() * 1000)
        name = _safe_davinci_name(data.get("name") or "")
        prefix = (name + "_") if name else ""
        base_name = f"xzg_dv_a_{prefix}{ts}"

        result = _call_bridge({
            "action": "export_audio",
            "out_dir": input_dir,
            "name": base_name,
            "switch_back": True,
        })
        if not result.get("ok"):
            return _web.json_response(result)

        filename = result.get("filename") or ""
        if not filename:
            return _web.json_response({"ok": False, "error": "桥接未返回产物文件名"}, status=500)
        src_path = os.path.join(input_dir, filename)
        ext = os.path.splitext(filename)[1].lower().lstrip(".")

        if ext not in AUDIO_EXTENSIONS:
            # 兜底产物是视频文件 → ffmpeg 抽取音频为同名 wav（音频加载器可直接加载）
            wav_name = os.path.splitext(filename)[0] + ".wav"
            wav_path = os.path.join(input_dir, wav_name)
            try:
                proc = subprocess.run(
                    [ffmpeg_path, "-y", "-v", "error", "-i", src_path,
                     "-vn", "-ac", "2", "-ar", "44100", wav_path],
                    capture_output=True, timeout=600, check=False,
                )
            except Exception as e:
                return _web.json_response({"ok": False, "error": f"音频抽取失败：{e}"}, status=500)
            if proc.returncode != 0 or not os.path.isfile(wav_path):
                err = (proc.stderr or b"").decode("utf-8", "replace")
                # MOV/MP4 缺少 moov atom 通常表示达芬奇产物未完成或损坏；
                # 清除无效回退文件，避免之后被文件列表误选。
                for invalid_path in (wav_path, src_path):
                    try:
                        if os.path.isfile(invalid_path):
                            os.remove(invalid_path)
                    except Exception:
                        pass
                if "moov atom not found" in err.lower() or "invalid data found" in err.lower():
                    return _web.json_response(
                        {"ok": False, "error": "达芬奇返回的视频文件不完整或损坏（缺少 moov atom），请稍候再试；已清理无效文件。"},
                        status=502)
                return _web.json_response(
                    {"ok": False, "error": f"音频抽取失败 (rc={proc.returncode})：{err[:300]}"},
                    status=500)
            # 视频中间产物不再需要（音频已抽取），删除避免 input 目录堆积
            try:
                os.remove(src_path)
            except Exception:
                pass
            filename = wav_name

        return _web.json_response({
            "ok": True,
            "filename": filename,
            "source": result.get("source") or "",
            "clip": result.get("clip"),
            "mark_range": result.get("mark_range"),
        })

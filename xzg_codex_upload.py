"""Copy existing media files to the Windows clipboard and paste into Codex or Doubao."""

import asyncio
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import subprocess

from aiohttp import web
import folder_paths
from server import PromptServer

from . import xzg_safe_handler
from .xzg_windows_clipboard import is_local_clipboard_request
from .nodes.xzg_video_save_davinci import _lookup_abs_token


_upload_lock = asyncio.Lock()
_media_extensions = {
    "image": {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".avif"},
    "video": {".mp4", ".webm", ".mkv", ".mov", ".avi", ".gif", ".flv", ".wmv", ".m4v", ".mpg", ".mpeg", ".ts"},
}


def resolve_media_files(names, kind):
    if not isinstance(kind, str) or kind not in _media_extensions or not isinstance(names, list) or not names:
        raise ValueError("请选择图片或视频")
    paths = []
    for name in names:
        if not isinstance(name, str) or not name or "\x00" in name:
            raise ValueError("素材文件名无效")
        filename, base = folder_paths.annotated_filepath(name)
        if base is None:
            base = folder_paths.get_input_directory()
        root = Path(base).resolve()
        path = (root / filename).resolve()
        if not path.is_relative_to(root) or path == root:
            raise ValueError("素材必须位于 ComfyUI 的 input、output 或 temp 目录中")
        if path.suffix.lower() not in _media_extensions[kind]:
            raise ValueError("文件类型与加载器不匹配")
        if not path.is_file():
            raise ValueError("素材文件不存在，请重新选择")
        if str(path) not in paths:
            paths.append(str(path))
    return paths


def activate_target_window(target):
    if os.name != "nt":
        return None
    user = ctypes.WinDLL("user32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    for function, args, result in [
        (user.EnumWindows, [callback_type, wintypes.LPARAM], wintypes.BOOL),
        (user.IsWindowVisible, [wintypes.HWND], wintypes.BOOL),
        (user.GetClassNameW, [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int], ctypes.c_int),
        (user.GetWindowThreadProcessId, [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)], wintypes.DWORD),
        (user.GetForegroundWindow, [], wintypes.HWND),
        (user.SetForegroundWindow, [wintypes.HWND], wintypes.BOOL),
        (user.IsIconic, [wintypes.HWND], wintypes.BOOL),
        (user.ShowWindowAsync, [wintypes.HWND, ctypes.c_int], wintypes.BOOL),
        (kernel.OpenProcess, [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD], wintypes.HANDLE),
        (kernel.QueryFullProcessImageNameW, [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)], wintypes.BOOL),
        (kernel.CloseHandle, [wintypes.HANDLE], wintypes.BOOL),
    ]:
        function.argtypes, function.restype = args, result
    windows = []
    process_names = {"doubao": {"doubao.exe", "豆包.exe"}, "codex": {"codex.exe", "chatgpt.exe"}}[target]

    @callback_type
    def collect_window(hwnd, _):
        if not user.IsWindowVisible(hwnd):
            return True
        name = ctypes.create_unicode_buffer(256)
        user.GetClassNameW(hwnd, name, len(name))
        if name.value == "#32770":
            return True
        pid = wintypes.DWORD()
        user.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        process = kernel.OpenProcess(0x1000, False, pid.value)
        if not process:
            return True
        try:
            path = ctypes.create_unicode_buffer(32768)
            length = wintypes.DWORD(len(path))
            if kernel.QueryFullProcessImageNameW(process, 0, path, ctypes.byref(length)):
                if Path(path.value).name.casefold() in process_names:
                    windows.append(hwnd)
        finally:
            kernel.CloseHandle(process)
        return True

    if not user.EnumWindows(collect_window, 0) or len(windows) != 1:
        return None
    source = user.GetForegroundWindow()
    if not source:
        return None
    handle = windows[0]
    if user.IsIconic(handle):
        user.ShowWindowAsync(handle, 9)
    user.SetForegroundWindow(handle)
    # Preserve the original window even when Windows delays foreground activation.
    return int(source)


def add_codex_attachments(paths, target="codex"):
    if target not in {"codex", "doubao"}:
        raise ValueError("未知附件目标")
    label = "豆包" if target == "doubao" else "Codex"
    script = Path(__file__).with_name("xzg_codex_upload.ps1")
    source_window = activate_target_window(target)
    args = ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-File", str(script)]
    if source_window is not None:
        args.extend(["-SourceWindow", str(source_window)])
    args.extend(["-Target", target])
    completed = subprocess.run(
        args,
        input=json.dumps(paths, ensure_ascii=False),
        capture_output=True, encoding="utf-8", timeout=55,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    try:
        result = json.loads(completed.stdout.strip())
    except json.JSONDecodeError as error:
        raise RuntimeError(f"无法启动{label}上传助手，请检查 PowerShell 脚本执行权限") from error
    if not isinstance(result, dict):
        raise RuntimeError(f"{label}上传助手返回了无效结果")
    if completed.returncode or not result.get("ok"):
        raise RuntimeError(result.get("error") or "添加附件失败")
    return result


@PromptServer.instance.routes.post("/xzg/doubao/attachments")
@xzg_safe_handler
async def doubao_attachments(request):
    return await _attachments(request, "doubao")


@PromptServer.instance.routes.post("/xzg/codex/attachments")
@xzg_safe_handler
async def codex_attachments(request):
    return await _attachments(request, "codex")


async def _attachments(request, target):
    label = "豆包" if target == "doubao" else "Codex"
    if not is_local_clipboard_request(request):
        return web.json_response({"error": f"添加到{label}仅支持通过 localhost 或 127.0.0.1 本机访问"}, status=403)
    if os.name != "nt":
        return web.json_response({"error": f"自动添加到{label}目前仅支持 Windows"}, status=501)
    try:
        data = await request.json()
        if not isinstance(data, dict):
            raise ValueError("请求格式无效")
        token = data.get("abs_token")
        if token:
            if not isinstance(token, str) or data.get("kind") != "video":
                raise ValueError("视频文件令牌无效")
            saved = _lookup_abs_token(token)
            if not saved:
                raise ValueError("视频文件令牌已失效，请重新执行保存节点")
            path = Path(saved)
            if path.suffix.lower() not in _media_extensions["video"] or not path.is_file():
                raise ValueError("保存的视频文件不存在或格式不支持")
            paths = [str(path.resolve())]
        else:
            paths = resolve_media_files(data.get("filenames"), data.get("kind"))
    except (ValueError, OSError) as error:
        return web.json_response({"error": str(error)}, status=400)
    if _upload_lock.locked():
        return web.json_response({"error": "正在添加附件，请等待当前操作完成"}, status=409)
    async with _upload_lock:
        try:
            result = await asyncio.to_thread(add_codex_attachments, paths, target)
        except subprocess.TimeoutExpired:
            return web.json_response({"error": f"操作超时，请检查{label}输入框，确认附件是否已添加后再重试"}, status=504)
        except (RuntimeError, OSError) as error:
            return web.json_response({"error": str(error)}, status=502)
    return web.json_response(result)

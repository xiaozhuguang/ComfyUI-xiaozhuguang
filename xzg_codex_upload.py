"""Copy original media files to the Windows file clipboard without activating apps."""

import asyncio
import json
import os
from pathlib import Path
import shutil
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


def _powershell_executable():
    # Embedded Python / launchers may omit Windows PowerShell from PATH.
    for variable in ("SystemRoot", "WINDIR"):
        root = os.environ.get(variable)
        if not root:
            continue
        # Sysnative reaches native PowerShell from a 32-bit Python process.
        for system_dir in ("Sysnative", "System32"):
            executable = Path(root) / system_dir / "WindowsPowerShell" / "v1.0" / "powershell.exe"
            if executable.is_file():
                return str(executable)
    executable = shutil.which("powershell.exe")
    if executable:
        return executable
    raise RuntimeError("找不到 Windows PowerShell，请检查 Windows 系统目录及 PowerShell 安装")


def add_codex_attachments(paths, target="clipboard"):
    """Legacy function name retained; all targets now only copy files."""
    if target not in {"codex", "doubao", "clipboard"}:
        raise ValueError("未知附件目标")
    script = Path(__file__).with_name("xzg_codex_upload.ps1")
    if not script.is_file():
        raise RuntimeError(f"文件复制助手脚本不存在：{script}，请重新安装或完整更新此插件")
    powershell = _powershell_executable()
    args = [powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-File", str(script)]
    completed = subprocess.run(
        args,
        input=json.dumps(paths, ensure_ascii=False),
        capture_output=True, encoding="utf-8", timeout=55,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    try:
        result = json.loads(completed.stdout.strip())
    except json.JSONDecodeError as error:
        raise RuntimeError("无法启动文件复制助手，请检查 PowerShell 脚本执行权限") from error
    if not isinstance(result, dict):
        raise RuntimeError("文件复制助手返回了无效结果")
    if completed.returncode or not result.get("ok"):
        raise RuntimeError(result.get("error") or result.get("warning") or "复制原文件失败")
    return result


@PromptServer.instance.routes.post("/xzg/clipboard/files")
@xzg_safe_handler
async def clipboard_files(request):
    return await _attachments(request, "clipboard")


# Compatibility routes for previously loaded browser assets: copy only.
@PromptServer.instance.routes.post("/xzg/doubao/attachments")
@xzg_safe_handler
async def doubao_attachments(request):
    return await _attachments(request, "doubao")


@PromptServer.instance.routes.post("/xzg/codex/attachments")
@xzg_safe_handler
async def codex_attachments(request):
    return await _attachments(request, "codex")


async def _attachments(request, target):
    if not is_local_clipboard_request(request):
        return web.json_response({"error": "复制到剪贴板仅支持通过 localhost 或 127.0.0.1 本机访问"}, status=403)
    if os.name != "nt":
        return web.json_response({"error": "复制到剪贴板目前仅支持 Windows"}, status=501)
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
        return web.json_response({"error": "正在复制文件，请等待当前操作完成"}, status=409)
    async with _upload_lock:
        try:
            result = await asyncio.to_thread(add_codex_attachments, paths, target)
        except subprocess.TimeoutExpired:
            return web.json_response({"error": "复制超时，请稍后重试"}, status=504)
        except (RuntimeError, OSError) as error:
            return web.json_response({"error": str(error)}, status=502)
    return web.json_response(result)

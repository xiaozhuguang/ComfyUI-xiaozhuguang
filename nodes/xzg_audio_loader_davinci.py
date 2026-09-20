"""
小珠光音频加载器-化神级
======================

在「小珠光音频加载器」基础上，新增「从达芬奇导入」：
把达芬奇剪辑页当前播放头所在片段的音频渲染导出并加载到本节点。

片段选择与导出策略（见 xzg_davinci_bridge.py action=export_audio）：
- 优先音频轨道播放头片段；音频轨道没有则用视频片段（导出其音轨）
- 优先纯音频渲染（wav）；版本不支持时回退整段渲染，由后端 ffmpeg 抽取音频

前端（web/xzg_audio_loader.js 化神级分支）在波形区右上角提供
悬浮「从达芬奇导入」按钮：导出 → 刷新音频下拉 → 自动选中并预览。

继承 XiaozhuguangAudioLoader，INPUT_TYPES / load_audio / IS_CHANGED 全部复用。
"""

import os
import subprocess
import time

import folder_paths
from server import PromptServer as _PS
from aiohttp import web as _web

from .xzg_audio_loader import XiaozhuguangAudioLoader, AUDIO_EXTENSIONS
from .xzg_video_loader_davinci import _call_bridge, _safe_davinci_name
from .xzg_audio_save import ffmpeg_path

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
        "额外支持「从达芬奇导入」：把达芬奇剪辑页当前播放头所在片段的音频"
        "（优先音频轨道片段，其次视频片段的音轨）渲染导出并加载到本节点。"
    )


if getattr(_PS, "instance", None) is not None and getattr(_PS.instance, "routes", None) is not None:

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
        })

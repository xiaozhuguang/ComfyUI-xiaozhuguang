"""
小珠光视频保存-化神级
=====================

在「小珠光视频保存」（XiaozhuguangVideoCombine）的全部功能基础上，新增「传回达芬奇」能力：
- 复用父类：图像序列合并为视频（mp4/webm/gif，可选音频，保存/预览模式）
- 新增：把 ComfyUI 生成的视频自动导入达芬奇当前项目 —— ImportMedia 进媒体池，
  AddTrack 新建视频轨道，片段落到新轨道并对齐当前播放头所在最上层片段的前端
  （不插入缝隙、不推移、不分割其他轨道）。

触发方式：前端预览区悬浮按钮「导出到达芬奇」手动触发。
"""

import json
import asyncio
import os
import shutil
import subprocess
import sys
import time
import traceback
from datetime import datetime

import folder_paths
from server import PromptServer as _PS
from aiohttp import web as _web

from .xzg_video_combine import XiaozhuguangVideoCombine

_BRIDGE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "xzg_davinci_bridge.py")
_RENDER_TIMEOUT = 1800          # 达芬奇导入等待超时（秒）


class XiaozhuguangVideoSaveDaVinci(XiaozhuguangVideoCombine):
    """小珠光视频保存-化神级：复用保存全部功能，新增「传回达芬奇」。

    继承父类的 INPUT_TYPES / FUNCTION / OUTPUT_NODE / combine_video，
    覆写 combine_video 以在保存后根据「自动导出」开关决定是否导入达芬奇。
    """

    @classmethod
    def INPUT_TYPES(cls):
        base = XiaozhuguangVideoCombine.INPUT_TYPES()
        # 旧工作流兼容字段：前端隐藏并忽略，不再根据它自动发送到快剪。
        # 保留参数位置，避免历史工作流按位置恢复 widget 值时错位。
        base["required"]["自动发送到快剪"] = ("BOOLEAN", {"default": False})
        # 自定义输出目录（与「小珠光图像保存-自定义输出」同一套约定）：
        # 追加在末尾，保证旧工作流按位置恢复 widget 值时不会错位。
        # 关闭「默认输出」后 base_dir 支持绝对路径 / 相对路径（拼 output/ 下）/ {date} 等模板
        base["required"]["use_default_output"] = ("BOOLEAN", {"default": True, "label_on": "默认输出", "label_off": "自定义输出"})
        base["required"]["base_dir"] = ("STRING", {"default": "", "multiline": False})
        # 日期戳/时间戳（与小珠光图像保存-化神级同一套约定）：追加在末尾，保证旧工作流按
        # 位置恢复 widget 值时不会错位。前端隐藏，收进「输出设置」弹窗（与小珠光图片保存-化神级同一设置框）。
        base["required"]["add_date_stamp"] = ("BOOLEAN", {"default": False, "label_on": "开启", "label_off": "关闭"})
        base["required"]["add_time_stamp"] = ("BOOLEAN", {"default": False, "label_on": "开启", "label_off": "关闭"})
        return base

    def combine_video(self, 图像, 帧率, 文件名前缀, 格式, CRF, 模式,
                      自动发送到快剪=False,
                      use_default_output=True, base_dir="",
                      add_date_stamp=False, add_time_stamp=False,
                      音频=None,
                      prompt=None, extra_pnginfo=None, unique_id=None):
        # 调用父类保存逻辑，得到完整 ui（含保存文件信息）
        ui = super().combine_video(
            图像, 帧率, 文件名前缀, 格式, CRF, 模式,
            音频=音频,
            prompt=prompt, extra_pnginfo=extra_pnginfo, unique_id=unique_id,
            use_default_output=use_default_output, base_dir=base_dir,
            add_date_stamp=add_date_stamp, add_time_stamp=add_time_stamp,
        )
        if not ui or not ui.get("ui"):
            return ui

        # 绝对路径输出：文件在 output/ 之外，/view 无法服务；
        # 注册会话级预览令牌（仅本进程会话内可访问，ComfyUI 重启后需重新运行节点）
        video = (ui.get("ui") or {}).get("video") or []
        if video and video[0].get("abs_path") and video[0].get("is_absolute"):
            video[0]["abs_token"] = _register_abs_token(video[0]["abs_path"])

        # 预览模式仍保留 output/preview/<节点ID> 内的临时预览产物，避免改变播放器
        # 的刷新与旧文件清理逻辑。但用户已配置自定义输出目录时，达芬奇应引用该目录
        # 中的副本，而不是 preview 目录中的源文件。
        davinci_path = None
        if video and video[0].get("filename"):
            if 模式 == "预览" and not use_default_output and (base_dir or "").strip():
                try:
                    davinci_path = _copy_preview_to_configured_output(
                        video[0], base_dir, 格式, extra_pnginfo, unique_id,
                    )
                    # 前端只持有会话令牌，不能借由导出接口读取任意本地路径。
                    video[0]["davinci_abs_token"] = _register_abs_token(davinci_path)
                    video[0]["davinci_copied"] = True
                except Exception as _e:
                    ui["ui"]["davinci"] = {
                        "ok": False,
                        "error": f"预览视频复制到自定义输出目录失败：{_e}",
                    }
            else:
                davinci_path = _resolve_abs_path(video[0])

        return ui


def _copy_preview_to_configured_output(video_info, base_dir, video_format,
                                       extra_pnginfo=None, unique_id=None):
    """将预览产物复制到用户配置的输出目录，并返回副本的绝对路径。

    预览本身必须继续存放在 output/preview 下，才能保持现有播放器缓存和旧文件
    清理行为。本函数只为达芬奇准备一份稳定、用户可见的源文件。
    """
    source_path = _resolve_abs_path(video_info)
    if not source_path or not os.path.isfile(source_path):
        raise FileNotFoundError(source_path or "预览视频不存在")

    wf_name = "untitled"
    if isinstance(extra_pnginfo, dict):
        workflow = extra_pnginfo.get("workflow") or {}
        name = workflow.get("name") or workflow.get("filename") or ""
        if name:
            wf_name = os.path.splitext(os.path.basename(str(name)))[0] or wf_name
    context = {
        "_now": datetime.now(),
        "workflow_name": wf_name,
        "node_id": unique_id or "",
        "format": video_format,
    }
    # 与保存模式共用目录模板、非法字符清理与相对路径规则。
    from .xzg_video_combine import _xzg_resolve_template, _xzg_sanitize_path, _xzg_is_absolute_path
    resolved_base = _xzg_sanitize_path(_xzg_resolve_template(base_dir.strip(), context))
    if not resolved_base:
        raise ValueError("自定义输出目录为空")
    if _xzg_is_absolute_path(resolved_base):
        destination_dir = resolved_base
    else:
        destination_dir = os.path.join(folder_paths.get_output_directory(), resolved_base)
    os.makedirs(destination_dir, exist_ok=True)

    # 保留预览生成的文件名；每个预览节点的计数器递增，因而不会覆盖此前导出的版本。
    destination_path = os.path.join(destination_dir, os.path.basename(video_info["filename"]))
    shutil.copy2(source_path, destination_path)
    return destination_path


def _resolve_abs_path(video_info, output_dir=None):
    """由 ui 的 video 项解析出磁盘绝对路径。

    优先采用保存时写入的 abs_path（自定义输出-绝对路径时文件在 output/ 之外）；
    否则按 output 目录 + subfolder 解析（保存/预览模式输出在 output 目录）。
    """
    filename = video_info.get("filename")
    if not filename:
        return None
    abs_path = video_info.get("abs_path")
    if abs_path and os.path.isfile(abs_path):
        return abs_path
    subfolder = (video_info.get("subfolder") or "").strip("/\\")
    out_dir = output_dir or folder_paths.get_output_directory()
    if subfolder:
        # subfolder 可能含相对路径分隔符，需 os.path.join 处理；同时防止路径穿越
        safe_parts = [p for p in subfolder.replace("\\", "/").split("/") if p and p not in (".", "..")]
        if not safe_parts:
            return os.path.join(out_dir, filename)
        return os.path.join(out_dir, *safe_parts, filename)
    return os.path.join(out_dir, filename)


# ═══════════════════════════════════════════════════════════════════════════
# 绝对路径输出：会话级预览令牌
# ═══════════════════════════════════════════════════════════════════════════
# 自定义输出-绝对路径时文件在 ComfyUI output/ 之外，/view 无法服务；
# 保存时注册「令牌 → 绝对路径」，前端只持有令牌，经 /xzg/davinci/view-abs 拉流预览，
# 避免开放任意本地文件读取。令牌仅在当前进程会话内有效（ComfyUI 重启后需重新运行节点）。
import uuid as _uuid

_ABS_FILE_TOKENS = {}
_MAX_ABS_TOKENS = 200


def _register_abs_token(abs_path):
    token = _uuid.uuid4().hex
    _ABS_FILE_TOKENS[token] = abs_path
    if len(_ABS_FILE_TOKENS) > _MAX_ABS_TOKENS:
        _ABS_FILE_TOKENS.pop(next(iter(_ABS_FILE_TOKENS)), None)
    return token


def _lookup_abs_token(token):
    return _ABS_FILE_TOKENS.get(token)


_VIEW_ABS_MIME = {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".m4v": "video/mp4",
    ".mkv": "video/x-matroska",
    ".gif": "image/gif",
}


# ═══════════════════════════════════════════════════════════════════════════
# 达芬奇桥接 subprocess 调用（复用加载-化神级同样的隔离方式）
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
        return {"ok": False, "error": f"达芬奇导入等待超时（{_RENDER_TIMEOUT} 秒）"}
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


# ═══════════════════════════════════════════════════════════════════════════
# 路由安全装饰器（与加载-化神级一致）
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

    @_PS.instance.routes.post("/xzg/davinci/save-import")
    @_safe_handler
    async def xzg_davinci_save_import(request):
        """把已保存的视频导入达芬奇。请求体：{ filename, subfolder, abs_token? }。

        由前端把该节点最近一次保存的文件信息上报（保存模式产物在 output 目录；
        自定义输出-绝对路径时携带 abs_token，由后端令牌解析出真实路径），
        后端解析出绝对路径后调用桥接 import。返回桥接结果。
        """
        data = await request.json()
        abs_token = data.get("abs_token") or ""
        if abs_token:
            # 绝对路径输出：仅接受本节点本次会话保存过的文件（令牌守卫）
            abs_path = _lookup_abs_token(abs_token)
            if not abs_path or not os.path.isfile(abs_path):
                return _web.json_response({"ok": False, "error": "文件不存在或已失效（ComfyUI 重启后需重新运行节点）"})
        else:
            filename = data.get("filename") or ""
            subfolder = data.get("subfolder") or ""
            if not filename:
                return _web.json_response({"ok": False, "error": "缺少 filename"})
            abs_path = _resolve_abs_path({"filename": filename, "subfolder": subfolder})
            if not abs_path or not os.path.isfile(abs_path):
                return _web.json_response({"ok": False, "error": f"文件不存在：{abs_path}"})
        target_dir = str(data.get("target_dir") or "").strip()
        selected_path = None
        try:
            from .xzg_video_loader_davinci import _choose_video_save_path
            from .xzg_audio_loader_davinci import _find_exported_copy
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
        result = await asyncio.to_thread(_call_bridge, {"action": "import", "file_path": target_path})
        result["save_directory"] = target_dir
        result["save_filename"] = os.path.basename(target_path)
        result["copied"] = True
        return _web.json_response(result)

    @_PS.instance.routes.get("/xzg/davinci/view-abs")
    @_safe_handler
    async def xzg_davinci_view_abs(request):
        """按会话令牌读取本节点保存的绝对路径视频（支持 Range，供 <video> 预览/拖动）。

        仅接受 _register_abs_token 登记过的文件路径，不开放任意本地文件读取。
        """
        token = (request.query.get("token") or "").strip()
        abs_path = _lookup_abs_token(token) if token else None
        if not abs_path or not os.path.isfile(abs_path):
            return _web.json_response({"error": "预览文件不存在或已失效"}, status=404)
        ext = os.path.splitext(abs_path)[1].lower()
        ctype = _VIEW_ABS_MIME.get(ext, "application/octet-stream")
        try:
            return _web.FileResponse(abs_path, headers={"Content-Type": ctype, "Accept-Ranges": "bytes"})
        except Exception as e:
            return _web.json_response({"error": str(e)}, status=500)

    _need_routes = False

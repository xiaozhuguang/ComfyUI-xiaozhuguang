"""
小珠光视频编辑器后端 API
提供视频探测、单帧导出、时间线渲染功能
所有产物写入 input 目录
"""
import os
import re
import time
import subprocess
import folder_paths
from aiohttp import web

from .xzg_video_loader import ffmpeg_path, ENCODE_ARGS

VIDEO_EXTENSIONS = {'webm', 'mp4', 'mkv', 'gif', 'mov', 'avi', 'flv', 'wmv', 'm4v', 'mpg', 'mpeg', 'ts'}


def resolve_path(filename, file_type):
    """根据 type 解析文件路径，返回 (abs_path, basename)"""
    if file_type == "output":
        base = folder_paths.get_output_directory()
    elif file_type == "temp":
        base = folder_paths.get_temp_directory()
    else:
        base = folder_paths.get_input_directory()
    safe = os.path.basename(filename)
    return os.path.join(base, safe), safe


def list_input_videos():
    """列出 input 目录的所有视频文件"""
    input_dir = folder_paths.get_input_directory()
    videos = []
    if os.path.isdir(input_dir):
        for f in sorted(os.listdir(input_dir)):
            fp = os.path.join(input_dir, f)
            if os.path.isfile(fp):
                ext = os.path.splitext(f)[1].lower().lstrip('.')
                if ext in VIDEO_EXTENSIONS:
                    mtime = os.path.getmtime(fp)
                    videos.append({"name": f, "mtime": mtime})
    # 按修改时间倒序（最新的在前）
    videos.sort(key=lambda v: v["mtime"], reverse=True)
    return [v["name"] for v in videos]


def probe_video(filename, file_type):
    """探测视频元数据
    用 `ffmpeg -i video` 让 ffmpeg 在无输出时报错退出（exit 1），
    但 stderr 中包含完整的流信息和 Duration，解析即可。
    注意：不能加 -c copy，否则在 copy 模式下不解析帧信息，可能卡住。
    """
    video_path, _ = resolve_path(filename, file_type)
    if not os.path.isfile(video_path):
        raise Exception(f"file not found: {filename}")

    args = [ffmpeg_path, "-i", video_path]
    try:
        proc = subprocess.run(args, stdout=subprocess.DEVNULL,
                              stderr=subprocess.PIPE, timeout=30, check=False)
    except subprocess.TimeoutExpired:
        raise Exception("FFmpeg probe timeout (30s)")
    lines = proc.stderr.decode(*ENCODE_ARGS)

    size_base = None
    fps_base = None
    duration = 0.0
    has_audio = False
    for line in lines.split('\n'):
        m = re.search(r"^ *Stream .* Video.*, ([1-9]|\d{2,})x(\d+)", line)
        if m is not None:
            size_base = [int(m.group(1)), int(m.group(2))]
            fps_match = re.search(r", ([\d\.]+) fps", line)
            fps_base = float(fps_match.group(1)) if fps_match else 1.0
        am = re.search(r"^ *Stream .* Audio:", line)
        if am is not None:
            has_audio = True
    durs_match = re.search(r"Duration: (\d+:\d+:\d+\.\d+),", lines)
    if durs_match:
        durs = durs_match.group(1).split(':')
        duration = int(durs[0]) * 3600 + int(durs[1]) * 60 + float(durs[2])
    if size_base is None:
        raise Exception("Failed to parse video info (no video stream)")
    return {
        "filename": filename,
        "type": file_type,
        "width": size_base[0],
        "height": size_base[1],
        "fps": fps_base,
        "duration": duration,
        "has_audio": has_audio,
    }


def extract_frame(filename, file_type, time_sec):
    """提取单帧为 PNG，写入 input 目录"""
    video_path, _ = resolve_path(filename, file_type)
    if not os.path.isfile(video_path):
        raise Exception(f"file not found: {filename}")
    if time_sec < 0:
        time_sec = 0.0

    input_dir = folder_paths.get_input_directory()
    os.makedirs(input_dir, exist_ok=True)
    out_name = f"frame_{int(time.time() * 1000)}.png"
    out_path = os.path.join(input_dir, out_name)

    cmd = [ffmpeg_path, "-y", "-v", "error",
           "-ss", f"{time_sec:.3f}",
           "-i", video_path,
           "-frames:v", "1",
           "-q:v", "2",
           out_path]
    proc = subprocess.run(cmd, capture_output=True, timeout=60)
    if proc.returncode != 0:
        err = proc.stderr.decode(*ENCODE_ARGS)
        raise Exception(f"ffmpeg failed: {err[:500]}")
    if not os.path.isfile(out_path):
        raise Exception("frame not produced")
    return out_name


def render_timeline(timeline, output_name=None):
    """渲染时间线：多源多片段拼接为 mp4
    timeline: [{filename, type, start, end}, ...]
    """
    if not timeline:
        raise Exception("timeline is empty")
    if len(timeline) > 30:
        raise Exception("too many clips (max 30)")

    if not output_name:
        output_name = f"edit_{int(time.time() * 1000)}.mp4"

    # 收集唯一源文件
    sources = []
    source_map = {}
    source_audio = {}  # key -> bool 是否有音频流
    for clip in timeline:
        key = f"{clip['filename']}|{clip['type']}"
        if key not in source_map:
            path, _ = resolve_path(clip['filename'], clip['type'])
            if not os.path.isfile(path):
                raise Exception(f"file not found: {clip['filename']}")
            source_map[key] = len(sources)
            sources.append(path)
            try:
                info = probe_video(clip['filename'], clip['type'])
                source_audio[key] = bool(info.get('has_audio'))
            except Exception:
                source_audio[key] = True

    # 规整片段
    norm_clips = []
    for clip in timeline:
        try:
            start = float(clip['start'])
            end = float(clip['end'])
        except (TypeError, ValueError, KeyError):
            continue
        if start < 0:
            start = 0
        if end < 0:
            end = 0
        if start > end:
            start, end = end, start
        if end - start < 0.01:
            continue
        key = f"{clip['filename']}|{clip['type']}"
        norm_clips.append({
            "filename": clip['filename'],
            "type": clip['type'],
            "start": start,
            "end": end,
            "has_audio": source_audio.get(key, True),
        })
    if not norm_clips:
        raise Exception("no valid clips")

    any_audio = any(c['has_audio'] for c in norm_clips)

    # 构建 ffmpeg 命令
    cmd = [ffmpeg_path, "-y", "-v", "error"]
    for s in sources:
        cmd += ["-i", s]

    # 构建 filter_complex：每段 trim + concat
    filter_parts = []
    v_labels = []
    a_labels = []
    concat_input = []
    for i, clip in enumerate(norm_clips):
        key = f"{clip['filename']}|{clip['type']}"
        src_idx = source_map[key]
        s, e = clip['start'], clip['end']
        dur = e - s
        filter_parts.append(
            f"[{src_idx}:v:0]trim=start={s:.3f}:end={e:.3f},setpts=PTS-STARTPTS,format=yuv420p[v{i}]"
        )
        v_labels.append(f"[v{i}]")
        if any_audio:
            if clip['has_audio']:
                filter_parts.append(
                    f"[{src_idx}:a:0]atrim=start={s:.3f}:end={e:.3f},asetpts=PTS-STARTPTS[a{i}]"
                )
            else:
                filter_parts.append(
                    f"anullsrc=channel_layout=stereo:sample_rate=44100:duration={dur:.3f}[a{i}]"
                )
            a_labels.append(f"[a{i}]")
        concat_input.append(f"[v{i}]")
        if any_audio:
            concat_input.append(f"[a{i}]")

    n = len(norm_clips)
    if any_audio:
        filter_parts.append(f"{''.join(concat_input)}concat=n={n}:v=1:a=1[outv][outa]")
    else:
        filter_parts.append(f"{''.join(concat_input)}concat=n={n}:v=1:a=0[outv]")

    cmd += ["-filter_complex", ";".join(filter_parts),
            "-map", "[outv]"]
    if any_audio:
        cmd += ["-map", "[outa]",
                "-c:a", "aac", "-b:a", "128k"]
    cmd += [
        "-c:v", "libx264", "-preset", "fast", "-crf", "20",
        "-pix_fmt", "yuv420p",
    ]

    # 输出到 input 目录
    input_dir = folder_paths.get_input_directory()
    os.makedirs(input_dir, exist_ok=True)
    safe_out = os.path.basename(output_name)
    if not safe_out.lower().endswith(".mp4"):
        safe_out += ".mp4"
    out_path = os.path.join(input_dir, safe_out)
    cmd.append(out_path)

    proc = subprocess.run(cmd, capture_output=True, timeout=600)
    if proc.returncode != 0:
        err = proc.stderr.decode(*ENCODE_ARGS)
        raise Exception(f"ffmpeg failed: {err[:800]}")
    if not os.path.isfile(out_path):
        raise Exception("output not produced")
    return safe_out


# ═══════════════════════════════════════════════════════════════════════════
# 路由注册 — 用和 xzg_video_loader.py 完全一样的方式（已验证可用）
# ═══════════════════════════════════════════════════════════════════════════
from server import PromptServer as _xzg_ve_PS
import functools as _xzg_ve_ft
import traceback as _xzg_ve_tb
import asyncio as _xzg_ve_aio

# 路由安全装饰器（与 xzg_video_loader.py 一致的 fallback 模式）
try:
    from .. import xzg_safe_handler as _xzg_ve_safe
except Exception:
    def _xzg_ve_safe(fn):
        def _fmt(exc, status=500):
            tb_s = ''.join(_xzg_ve_tb.format_exception(type(exc), exc, exc.__traceback__))
            try:
                return web.json_response(
                    {'error': '%s: %s' % (type(exc).__name__, exc), 'traceback': tb_s}, status=status)
            except Exception:
                return web.Response(status=500, text='%s: %s\n\n%s' % (type(exc).__name__, exc, tb_s))
        if _xzg_ve_aio.iscoroutinefunction(fn):
            @_xzg_ve_ft.wraps(fn)
            async def _aw(*a, **kw):
                try:
                    return await fn(*a, **kw)
                except web.HTTPException:
                    raise
                except BaseException as e:
                    print('[小珠光路由异常] %s: %s: %s' % (fn.__name__, type(e).__name__, e))
                    _xzg_ve_tb.print_exc()
                    return _fmt(e)
            return _aw
        @_xzg_ve_ft.wraps(fn)
        def _sw(*a, **kw):
            try:
                return fn(*a, **kw)
            except web.HTTPException:
                raise
            except BaseException as e:
                print('[小珠光路由异常] %s: %s: %s' % (fn.__name__, type(e).__name__, e))
                _xzg_ve_tb.print_exc()
                return _fmt(e)
        return _sw

if getattr(_xzg_ve_PS, 'instance', None) is not None:

    @_xzg_ve_PS.instance.routes.post("/xzg_video_editor_list")
    @_xzg_ve_safe
    async def xzg_video_editor_list_route(request):
        videos = list_input_videos()
        return web.json_response({"videos": videos})

    @_xzg_ve_PS.instance.routes.post("/xzg_video_editor_probe")
    @_xzg_ve_safe
    async def xzg_video_editor_probe_route(request):
        data = await request.json()
        filename = data.get("filename", "")
        file_type = data.get("type", "input")
        if not filename:
            return web.json_response({"error": "filename required"}, status=400)
        info = probe_video(filename, file_type)
        return web.json_response(info)

    @_xzg_ve_PS.instance.routes.post("/xzg_video_editor_extract_frame")
    @_xzg_ve_safe
    async def xzg_video_editor_extract_frame_route(request):
        data = await request.json()
        filename = data.get("filename", "")
        file_type = data.get("type", "input")
        time_sec = float(data.get("time", 0.0))
        out_name = extract_frame(filename, file_type, time_sec)
        return web.json_response({"filename": out_name, "type": "input", "time": time_sec})

    @_xzg_ve_PS.instance.routes.post("/xzg_video_editor_render")
    @_xzg_ve_safe
    async def xzg_video_editor_render_route(request):
        data = await request.json()
        timeline = data.get("timeline", [])
        output_name = data.get("output_name")
        out_name = render_timeline(timeline, output_name)
        return web.json_response({"filename": out_name, "type": "input", "clips_count": len(timeline)})

    print("[小珠光] 视频编辑器 API 路由已注册: /xzg_video_editor_*")
else:
    print("[小珠光] 警告: PromptServer.instance 未初始化, 视频编辑器 API 路由未注册")

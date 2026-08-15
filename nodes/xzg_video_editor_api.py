"""
小珠光视频编辑器后端 API
提供视频探测、单帧导出、时间线渲染功能
所有产物写入 input 目录
"""
import os
import re
import time
import json
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

    # 过小的文件视为损坏，直接删除（防止反复探测失败）
    try:
        file_size = os.path.getsize(video_path)
    except Exception:
        file_size = 0
    if file_size < 1024:
        try:
            os.remove(video_path)
        except Exception:
            pass
        raise Exception(f"文件损坏或过小 ({file_size} bytes)，已删除")

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
        # 无法解析视频流：不删除文件（可能是 ffmpeg 正则未匹配，文件本身正常）
        # 仅返回错误，让前端标记 failed 但不删除文件，下次可重试
        raise Exception("无法解析视频流（ffmpeg 未识别分辨率信息）")

    # 获取视频实际帧数（用 -c copy 模式遍历 packet，速度快且准确）
    # 避免 round(fps * duration) 的浮点误差（如 85 帧视频被算成 102 帧）
    frame_count = None
    try:
        count_args = [ffmpeg_path, "-i", video_path, "-c", "copy", "-f", "null", "-"]
        count_proc = subprocess.run(count_args, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.PIPE, timeout=60, check=False)
        count_lines = count_proc.stderr.decode(*ENCODE_ARGS)
        # ffmpeg 输出最后一行包含 "frame= XX"
        frame_match = re.search(r"frame=\s*(\d+)\s", count_lines)
        if frame_match:
            frame_count = int(frame_match.group(1))
    except Exception:
        pass
    # 回退：用 round(fps * duration) 估算
    if (frame_count is None or frame_count <= 0) and fps_base and fps_base > 0 and duration > 0:
        frame_count = round(fps_base * duration)
    # 若获取到准确帧数，反算精确 duration（消除 ffmpeg duration 浮点误差）
    if frame_count and fps_base and fps_base > 0:
        accurate_duration = frame_count / fps_base
        if accurate_duration > 0:
            duration = accurate_duration

    return {
        "filename": filename,
        "type": file_type,
        "width": size_base[0],
        "height": size_base[1],
        "fps": fps_base,
        "duration": duration,
        "has_audio": has_audio,
        "frame_count": frame_count,
        "file_size": file_size,
    }


def extract_frame(filename, file_type, time_sec, small=False):
    """提取单帧为图片，写入 input 目录
    small=True: 缩放到高度 120px + JPEG（缩略图用，体积小、IO 快）
    small=False: 全分辨率 PNG（导出帧用）
    """
    video_path, _ = resolve_path(filename, file_type)
    if not os.path.isfile(video_path):
        raise Exception(f"file not found: {filename}")
    if time_sec < 0:
        time_sec = 0.0

    input_dir = folder_paths.get_input_directory()
    os.makedirs(input_dir, exist_ok=True)

    if small:
        # 缩略图模式：高度 120px + JPEG q5（按高度缩放保持比例，体积约为 PNG 的 1/10）
        out_name = f"frame_{int(time.time() * 1000)}_{int(time_sec * 1000)}.jpg"
        out_path = os.path.join(input_dir, out_name)
        cmd = [ffmpeg_path, "-y", "-v", "error",
               "-ss", f"{time_sec:.3f}",
               "-i", video_path,
               "-frames:v", "1",
               "-vf", "scale=-1:120",
               "-q:v", "5",
               out_path]
    else:
        # 全分辨率 PNG（导出帧用）
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


def extract_thumbs_batch(filename, file_type, clip_start, clip_end, count):
    """批量提取缩略图（单次 ffmpeg 进程，用 fps 滤镜均匀采样）
    clip_start/clip_end: 片段在源视频中的起止时间（秒）
    count: 需要的缩略图数量
    返回: [{filename, subfolder, index}, ...] 按顺序
    """
    if count <= 0 or clip_end <= clip_start:
        return []
    video_path, _ = resolve_path(filename, file_type)
    if not os.path.isfile(video_path):
        raise Exception(f"file not found: {filename}")

    input_dir = folder_paths.get_input_directory()
    os.makedirs(input_dir, exist_ok=True)

    # 批量帧输出目录（用时间戳隔离，避免命名冲突）
    batch_id = f"batch_{int(time.time() * 1000)}"
    batch_dir = os.path.join(input_dir, batch_id)
    os.makedirs(batch_dir, exist_ok=True)

    dur = clip_end - clip_start
    # fps 滤镜：按 count/dur 频率均匀采样，单进程提取所有帧
    fps_filter = count / dur

    out_pattern = os.path.join(batch_dir, "thumb_%03d.jpg")
    cmd = [ffmpeg_path, "-y", "-v", "error",
           "-ss", f"{clip_start:.3f}",
           "-t", f"{dur:.3f}",
           "-i", video_path,
           "-vf", f"fps={fps_filter:.6f},scale=-1:120",
           "-q:v", "5",
           out_pattern]
    proc = subprocess.run(cmd, capture_output=True, timeout=120)
    if proc.returncode != 0:
        err = proc.stderr.decode(*ENCODE_ARGS)
        raise Exception(f"ffmpeg batch failed: {err[:500]}")

    # 收集生成的文件，按顺序返回
    results = []
    for i in range(count):
        fname = f"thumb_{i + 1:03d}.jpg"
        fpath = os.path.join(batch_dir, fname)
        if os.path.isfile(fpath):
            results.append({
                "filename": fname,
                "subfolder": batch_id,
                "index": i,
            })
    return results


def extract_thumbs_full(filename, file_type, interval=0.3, max_count=400, known_duration=0):
    """按源视频全片固定间隔提取缩略图流（达芬奇式：与片段裁剪无关，一次生成永久复用）
    filename/file_type: 源视频标识
    interval: 采样间隔（秒），默认 0.3s 一张
    max_count: 单视频最大采样数，防止超长视频生成过多
    known_duration: 已知时长（>0 时跳过重复 probe，由合并接口传入避免二次探测）
    返回: { results: [{filename, subfolder, time}], duration, interval, count }
        time: 该缩略图对应的源视频时间戳（秒）
    磁盘持久化：基于视频名+大小+mtime 生成稳定 batch_id，已存在则直接返回不重新生成
    """
    video_path, _ = resolve_path(filename, file_type)
    if not os.path.isfile(video_path):
        raise Exception(f"file not found: {filename}")

    if known_duration > 0:
        duration = known_duration
    else:
        try:
            info = probe_video(filename, file_type)
            duration = float(info.get("duration", 0)) if info else 0.0
        except Exception:
            duration = 0.0

    if duration <= 0:
        return {"results": [], "duration": 0, "interval": interval, "count": 0}

    # 实际采样数（按 interval 间隔，限制上限）
    count = int(duration / interval) + 1
    if count > max_count:
        # 间隔太短，自动放大以不超过 max_count
        interval = duration / max_count
        count = max_count

    input_dir = folder_paths.get_input_directory()
    os.makedirs(input_dir, exist_ok=True)

    # 稳定的 batch_id：基于视频名+大小+mtime，避免刷新后重新生成
    try:
        fsize = os.path.getsize(video_path)
        fmtime = int(os.path.getmtime(video_path))
    except Exception:
        fsize = 0
        fmtime = 0
    import hashlib
    sig = hashlib.md5(f"{filename}|{file_type}|{fsize}|{fmtime}|{interval:.4f}".encode()).hexdigest()[:12]
    batch_id = f"full_{sig}"
    batch_dir = os.path.join(input_dir, batch_id)

    # 磁盘缓存命中：目录已存在且有缩略图文件，直接返回列表
    expected_count = count
    if os.path.isdir(batch_dir):
        results = []
        for i in range(expected_count):
            fname = f"t_{i + 1:04d}.jpg"
            fpath = os.path.join(batch_dir, fname)
            if os.path.isfile(fpath):
                results.append({
                    "filename": fname,
                    "subfolder": batch_id,
                    "time": round(i * interval, 3),
                    "index": i,
                })
        if len(results) > 0:
            return {
                "results": results,
                "duration": round(duration, 3),
                "interval": round(interval, 4),
                "count": len(results),
            }

    # 缓存未命中：生成缩略图
    os.makedirs(batch_dir, exist_ok=True)
    out_pattern = os.path.join(batch_dir, "t_%04d.jpg")
    cmd = [ffmpeg_path, "-y", "-v", "error",
           "-i", video_path,
           "-vf", f"fps=1/{interval:.4f},scale=-1:120",
           "-q:v", "5",
           "-frames:v", str(count),
           out_pattern]
    proc = subprocess.run(cmd, capture_output=True, timeout=180)
    if proc.returncode != 0:
        err = proc.stderr.decode(*ENCODE_ARGS)
        raise Exception(f"ffmpeg full thumbs failed: {err[:500]}")

    # 收集文件并计算时间戳（第 i 张对应 time = i * interval）
    results = []
    for i in range(count):
        fname = f"t_{i + 1:04d}.jpg"
        fpath = os.path.join(batch_dir, fname)
        if os.path.isfile(fpath):
            results.append({
                "filename": fname,
                "subfolder": batch_id,
                "time": round(i * interval, 3),
                "index": i,
            })
    return {
        "results": results,
        "duration": round(duration, 3),
        "interval": round(interval, 4),
        "count": len(results),
    }


def probe_and_extract_thumbs_full(filename, file_type, interval=0.3, max_count=400):
    """合并接口：一次调用完成探测 + 缩略图流生成
    上传完成后前端调用此接口，避免拖到时间线时再等待缩略图生成
    返回: { info: {...probe结果}, thumbs: {...extract_thumbs_full结果}, thumbs_error: str|None }
    probe 失败抛异常（文件损坏会被删除）；thumbs 失败仅返回 thumbs_error，不影响视频本身
    """
    info = probe_video(filename, file_type)
    thumbs = None
    thumbs_error = None
    try:
        # 传入已知 duration，避免 extract_thumbs_full 内部重复 probe
        thumbs = extract_thumbs_full(filename, file_type, interval, max_count,
                                     known_duration=float(info.get("duration", 0)))
    except Exception as e:
        thumbs_error = f"{type(e).__name__}: {e}"
        print(f"[小珠光] 缩略图流生成失败（视频本身正常）: {filename}: {thumbs_error}")
    return {"info": info, "thumbs": thumbs, "thumbs_error": thumbs_error}


def render_timeline(timeline, output_name=None, target_w=None, target_h=None, target_fps=None):
    """渲染时间线：多源多片段拼接为 mp4
    timeline: [{filename, type, start, end}, ...]
    target_w/target_h: 目标分辨率（>0 时覆盖首个片段分辨率）
    target_fps: 目标帧率（>0 时覆盖首个片段帧率）
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
    source_info = {}   # key -> probe 结果（含 width/height/fps）
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
                source_info[key] = info
                source_audio[key] = bool(info.get('has_audio'))
            except Exception:
                source_info[key] = None
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

    # 以首个片段分辨率/帧率为基准统一所有片段（不同分辨率 concat 会失败）
    # 若调用方传入 target_w/target_h/target_fps（>0），则覆盖基准值
    first_key = f"{norm_clips[0]['filename']}|{norm_clips[0]['type']}"
    first_info = source_info.get(first_key)
    if not first_info:
        raise Exception("无法探测首个片段的分辨率，不能渲染")
    base_w = int(target_w) if (target_w and int(target_w) > 0) else int(first_info['width'])
    base_h = int(target_h) if (target_h and int(target_h) > 0) else int(first_info['height'])
    base_fps = float(target_fps) if (target_fps and float(target_fps) > 0) else (first_info.get('fps') or 30.0)
    # 帧率用 %g 格式化（30.0→"30", 29.97→"29.97", 23.976→"23.976"）
    base_fps_str = f"{base_fps:g}"

    # 构建 ffmpeg 命令
    cmd = [ffmpeg_path, "-y", "-v", "error"]
    for s in sources:
        cmd += ["-i", s]

    # 构建 filter_complex：每段 trim + scale/pad 统一分辨率 + concat
    filter_parts = []
    v_labels = []
    a_labels = []
    concat_input = []
    for i, clip in enumerate(norm_clips):
        key = f"{clip['filename']}|{clip['type']}"
        src_idx = source_map[key]
        s, e = clip['start'], clip['end']
        dur = e - s
        # scale 保持宽高比缩放到基准内，pad 补黑边到基准尺寸，统一帧率/SAR/像素格式
        filter_parts.append(
            f"[{src_idx}:v:0]trim=start={s:.3f}:end={e:.3f},setpts=PTS-STARTPTS,"
            f"scale={base_w}:{base_h}:force_original_aspect_ratio=decrease,"
            f"pad={base_w}:{base_h}:(ow-iw)/2:(oh-ih)/2:black,"
            f"fps={base_fps_str},setsar=1,format=yuv420p[v{i}]"
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
        small = bool(data.get("small", False))
        out_name = extract_frame(filename, file_type, time_sec, small)
        return web.json_response({"filename": out_name, "type": "input", "time": time_sec, "small": small})

    @_xzg_ve_PS.instance.routes.post("/xzg_video_editor_extract_thumbs_batch")
    @_xzg_ve_safe
    async def xzg_video_editor_extract_thumbs_batch_route(request):
        data = await request.json()
        filename = data.get("filename", "")
        file_type = data.get("type", "input")
        clip_start = float(data.get("start", 0.0))
        clip_end = float(data.get("end", 0.0))
        count = int(data.get("count", 1))
        results = extract_thumbs_batch(filename, file_type, clip_start, clip_end, count)
        return web.json_response({"results": results, "count": len(results)})

    @_xzg_ve_PS.instance.routes.post("/xzg_video_editor_extract_thumbs_full")
    @_xzg_ve_safe
    async def xzg_video_editor_extract_thumbs_full_route(request):
        data = await request.json()
        filename = data.get("filename", "")
        file_type = data.get("type", "input")
        interval = float(data.get("interval", 0.3))
        result = extract_thumbs_full(filename, file_type, interval)
        return web.json_response(result)

    @_xzg_ve_PS.instance.routes.post("/xzg_video_editor_probe_and_thumbs")
    @_xzg_ve_safe
    async def xzg_video_editor_probe_and_thumbs_route(request):
        data = await request.json()
        filename = data.get("filename", "")
        file_type = data.get("type", "input")
        interval = float(data.get("interval", 0.3))
        result = probe_and_extract_thumbs_full(filename, file_type, interval)
        return web.json_response(result)

    @_xzg_ve_PS.instance.routes.post("/xzg_video_editor_render")
    @_xzg_ve_safe
    async def xzg_video_editor_render_route(request):
        data = await request.json()
        timeline = data.get("timeline", [])
        output_name = data.get("output_name")
        target_w = data.get("target_width")
        target_h = data.get("target_height")
        target_fps = data.get("target_fps")
        out_name = render_timeline(timeline, output_name, target_w, target_h, target_fps)
        return web.json_response({"filename": out_name, "type": "input", "clips_count": len(timeline)})

    print("[小珠光] 视频编辑器 API 路由已注册: /xzg_video_editor_*")
else:
    print("[小珠光] 警告: PromptServer.instance 未初始化, 视频编辑器 API 路由未注册")

"""
小珠光视频编辑器后端 API
提供视频探测、单帧导出、时间线渲染功能
所有产物写入 input 目录
"""
import os
import re
import time
import json
import shutil
import subprocess
import folder_paths
from datetime import datetime
from aiohttp import web

from .xzg_video_loader import ffmpeg_path, ENCODE_ARGS

VIDEO_EXTENSIONS = {'webm', 'mp4', 'mkv', 'gif', 'mov', 'avi', 'flv', 'wmv', 'm4v', 'mpg', 'mpeg', 'ts'}
AUDIO_EXTENSIONS = {'mp3', 'wav', 'aac', 'ogg', 'flac', 'm4a', 'opus', 'wma', 'aiff', 'aif'}
IMAGE_EXTENSIONS = {'jpg', 'jpeg', 'png', 'bmp', 'webp', 'tiff', 'tif'}

# 快剪专属目录：上传的视频、音频、图片、缩略图都存放在 input/<XZG_VE_ROOT>/ 下
# 不再每次重启清理，改为前端"一键清理缓存"按钮手动清理
XZG_VE_ROOT = "fastcut-cache"
# 媒体按类型分目录：video/audio/image
VIDEO_SUBDIR = f"{XZG_VE_ROOT}/video"
AUDIO_SUBDIR = f"{XZG_VE_ROOT}/audio"
IMAGE_SUBDIR = f"{XZG_VE_ROOT}/image"
# 缩略图统一子目录：嵌套在 fastcut-cache/thumbs/ 下
THUMBS_ROOT = f"{XZG_VE_ROOT}/thumbs"
THUMBS_FRAMES_SUBDIR = f"{THUMBS_ROOT}/frames"  # 单帧缩略图子路径（相对 input）
# 图片在时间线上的默认时长（秒）
IMAGE_DEFAULT_DURATION = 5.0

# 非法文件名字符（与化神级保持一致）
_INVALID_CHARS_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def _xzg_sanitize(name):
    """把文件名中的非法字符替换为 _（与化神级 _sanitize 逻辑一致）"""
    if not name:
        return name
    drive = ""
    m = re.match(r'^([A-Za-z]:)', name)
    if m:
        drive = m.group(1)
        name = name[len(drive):]
    name = _INVALID_CHARS_RE.sub("_", name)
    name = name.strip().strip(".")
    return drive + name


def _xzg_is_absolute_path(p):
    """判断是否为绝对路径（跨平台，与化神级一致）"""
    if not p:
        return False
    if len(p) >= 2 and p[1] == ':' and p[0].isalpha():
        return True
    return p.startswith('/') or p.startswith('\\')


def _is_audio_file(filename):
    ext = os.path.splitext(filename)[1].lower().lstrip('.')
    return ext in AUDIO_EXTENSIONS


def _is_image_file(filename):
    ext = os.path.splitext(filename)[1].lower().lstrip('.')
    return ext in IMAGE_EXTENSIONS


def _media_subdir(filename):
    """根据文件扩展名返回对应的子目录（相对 input，如 fastcut-cache/video）"""
    if _is_audio_file(filename):
        return AUDIO_SUBDIR
    if _is_image_file(filename):
        return IMAGE_SUBDIR
    return VIDEO_SUBDIR


def resolve_path(filename, file_type):
    """根据 type 解析文件路径，返回 (abs_path, safe_relative_path)
    支持子目录路径（如 'fastcut-cache/video.mp4'），安全过滤 .. 防止路径穿越
    """
    if file_type == "output":
        base = folder_paths.get_output_directory()
    elif file_type == "temp":
        base = folder_paths.get_temp_directory()
    else:
        base = folder_paths.get_input_directory()
    # 安全过滤：替换路径分隔符，禁止 .. 防止路径穿越
    safe = filename.replace("\\", "/").lstrip("/")
    parts = []
    for p in safe.split("/"):
        if p in ("", ".", ".."):
            continue
        parts.append(p)
    if not parts:
        return base, ""
    safe_rel = "/".join(parts)
    return os.path.join(base, *parts), safe_rel


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


def list_input_media():
    """列出快剪专属目录 fastcut-cache/{video,audio,image} 下的所有媒体文件，每项标记 is_audio/is_image
    返回的 name 为相对 input 的子路径（如 'fastcut-cache/video/demo.mp4'）
    """
    input_dir = folder_paths.get_input_directory()
    media = []
    for subdir, is_audio, is_image in [
        (VIDEO_SUBDIR, False, False),
        (AUDIO_SUBDIR, True, False),
        (IMAGE_SUBDIR, False, True),
    ]:
        ve_sub = os.path.join(input_dir, *subdir.split("/"))
        if not os.path.isdir(ve_sub):
            continue
        for f in sorted(os.listdir(ve_sub)):
            fp = os.path.join(ve_sub, f)
            if not os.path.isfile(fp):
                continue
            ext = os.path.splitext(f)[1].lower().lstrip('.')
            ok = (ext in VIDEO_EXTENSIONS) if not is_audio and not is_image else \
                 (ext in AUDIO_EXTENSIONS) if is_audio else (ext in IMAGE_EXTENSIONS)
            if ok:
                media.append({
                    "name": f"{subdir}/{f}",
                    "mtime": os.path.getmtime(fp),
                    "is_audio": is_audio,
                    "is_image": is_image,
                })
    media.sort(key=lambda v: v["mtime"], reverse=True)
    return media


# ═══════════════════════════════════════════════════════════════════════════
#  缩略图缓存清理：每次 ComfyUI 启动时执行一次
# ═══════════════════════════════════════════════════════════════════════════

# 严格的命名模式匹配，确保只删除本插件生成的文件/目录，绝对不误删用户数据
_RE_FRAME_FILE = re.compile(r'^frame_\d+(?:_\d+)?\.(?:jpg|jpeg|png)$', re.IGNORECASE)
_RE_THUMB_SUBDIR = re.compile(r'^(?:batch_\d+|full_[0-9a-f]{12})$')
# 子目录内合法文件模式（进一步确认是我们的缩略图目录）
_RE_THUMB_FILE_BATCH = re.compile(r'^thumb_\d{3}\.jpg$', re.IGNORECASE)
_RE_THUMB_FILE_FULL = re.compile(r'^t_\d{4}\.jpg$', re.IGNORECASE)


def _is_thumb_subdir_safe(subdir_path, dir_name):
    """二次校验子目录内文件全部为小珠光的缩略图，彻底避免误删用户目录"""
    try:
        entries = list(os.listdir(subdir_path))
    except OSError:
        return False
    if not entries:
        # 空目录：只要名字匹配就可以删（也不会有损失）
        return True
    # 确定当前目录类型：batch_ 或 full_
    if dir_name.startswith("batch_"):
        pattern = _RE_THUMB_FILE_BATCH
    else:  # full_
        pattern = _RE_THUMB_FILE_FULL
    # 所有条目必须是文件且匹配命名模式（不能有子目录或奇怪的文件）
    for n in entries:
        child = os.path.join(subdir_path, n)
        if not os.path.isfile(child):
            return False
        if not pattern.match(n):
            return False
    return True


def _rmtree_force(path):
    """强制删除目录树：处理 Windows 只读属性 + 文件占用重试。
    ignore_errors=True 会静默吞掉所有错误导致删除失败但无日志，
    这里改用 onerror 回调：遇到只读文件先 chmod 再删，并打印失败原因。
    返回 True 表示最终删除成功（目录已不存在）。
    """
    if not os.path.exists(path):
        return True

    def _on_error(func, target, exc_info):
        # 只读文件/目录：先去掉只读属性再重试
        try:
            os.chmod(target, 0o777)
        except Exception:
            pass
        try:
            func(target)  # 重试原操作（os.remove / os.rmdir）
        except Exception as e:
            # 仍然失败（通常是文件被占用）：打印原因但不中断整体流程
            print(f"[小珠光] 缩略图清理：无法删除 {os.path.basename(target)}: {type(e).__name__}: {e}")

    try:
        shutil.rmtree(path, onerror=_on_error)
    except Exception as e:
        print(f"[小珠光] 缩略图清理：rmtree 异常 {os.path.basename(path)}: {e}")
    # 最终以"目录是否还存在"判定成功与否
    return not os.path.exists(path)


def clear_xzg_cache():
    """一键清理快剪所有历史缓存（手动触发，不再在重启时自动执行）
    清理范围：
      1) input/fastcut-cache/   ← 快剪专属目录（上传的媒体文件 + 缩略图），整目录删除
      2) input/frame_<timestamp>.jpg/.png   ← 旧：散落根目录的 extract_frame 单帧产物（向后兼容）
      3) input/batch_<timestamp>/...        ← 旧：散落根目录的 extract_thumbs_batch 目录（向后兼容）
      4) input/full_<md5>/...               ← 旧：散落根目录的 extract_thumbs_full 目录（向后兼容）
      5) input/xzg_thumbs/                  ← 旧：改造前根目录下的缩略图总目录（向后兼容）
    返回 dict 供 API 响应使用
    """
    result = {"removed_files": 0, "removed_dirs": 0, "failed_dirs": 0, "error": None}
    try:
        input_dir = folder_paths.get_input_directory()
    except Exception:
        result["error"] = "无法获取 input 目录"
        print(f"[小珠光] 缓存清理：{result['error']}")
        return result
    if not input_dir or not os.path.isdir(input_dir):
        result["error"] = "input 目录不存在"
        print(f"[小珠光] 缓存清理：{result['error']}")
        return result

    # ══════════════════════════════════════════════════════════════════
    # ① 快剪专属目录 fastcut-cache/ → 整目录 rmtree（媒体文件 + 缩略图）
    # ══════════════════════════════════════════════════════════════════
    ve_dir = os.path.join(input_dir, XZG_VE_ROOT)
    if os.path.isdir(ve_dir):
        if _rmtree_force(ve_dir):
            result["removed_dirs"] += 1
        else:
            result["failed_dirs"] += 1

    # ══════════════════════════════════════════════════════════════════
    # ② 旧：向后兼容——清理改造前散落在 input 根目录的历史遗留缩略图
    #    保留原严格正则 + 二次校验，彻底避免误删
    # ══════════════════════════════════════════════════════════════════
    try:
        entries = list(os.listdir(input_dir))
    except OSError:
        entries = []

    for name in entries:
        full = os.path.join(input_dir, name)
        try:
            # 根目录旧单帧文件
            if os.path.isfile(full) and _RE_FRAME_FILE.match(name):
                try:
                    os.chmod(full, 0o777)
                    os.remove(full)
                    result["removed_files"] += 1
                except OSError as e:
                    print(f"[小珠光] 缓存清理：无法删除文件 {name}: {e}")
                continue

            # 根目录旧缩略图子目录
            if os.path.isdir(full) and _RE_THUMB_SUBDIR.match(name):
                if _is_thumb_subdir_safe(full, name):
                    if _rmtree_force(full):
                        result["removed_dirs"] += 1
                    else:
                        result["failed_dirs"] += 1
                continue

            # 根目录旧 xzg_thumbs 总目录（改造前）
            if os.path.isdir(full) and name == "xzg_thumbs":
                if _rmtree_force(full):
                    result["removed_dirs"] += 1
                else:
                    result["failed_dirs"] += 1
                continue
        except Exception:
            continue

    msg = (f"[小珠光] 缓存清理：删除 {result['removed_files']} 个散落单帧文件 + "
           f"{result['removed_dirs']} 个目录（含 fastcut-cache 总目录）")
    if result["failed_dirs"]:
        msg += f"；{result['failed_dirs']} 个目录删除失败（文件可能被占用）"
    print(msg)
    return result


def delete_media(filename, file_type="input"):
    """删除单个媒体文件及其关联的缩略图缓存
    1) 删除媒体文件本身（input/fastcut-cache/video|audio|image/xxx）
    2) 删除该媒体对应的 full 缩略图（基于 sig 前缀匹配，sig = md5(filename|type|fsize|fmtime|interval)）
    返回 dict: { removed_media, removed_thumbs, error }
    """
    result = {"removed_media": False, "removed_thumbs": 0, "error": None}
    try:
        input_dir = folder_paths.get_input_directory()
    except Exception:
        result["error"] = "无法获取 input 目录"
        return result

    video_path, _ = resolve_path(filename, file_type)
    if not os.path.isfile(video_path):
        result["error"] = f"文件不存在: {filename}"
        return result

    # 删除前获取文件大小和修改时间，用于计算缩略图 sig
    try:
        fsize = os.path.getsize(video_path)
        fmtime = int(os.path.getmtime(video_path))
    except Exception:
        fsize = 0
        fmtime = 0

    # 删除媒体文件本身
    try:
        os.chmod(video_path, 0o777)
        os.remove(video_path)
        result["removed_media"] = True
    except OSError as e:
        result["error"] = f"删除文件失败: {e}"
        print(f"[小珠光] 删除媒体失败: {filename}: {e}")
        return result

    # 删除关联的 full 缩略图（sig 前缀匹配）
    # sig = md5(f"{filename}|{file_type}|{fsize}|{fmtime}|{interval:.4f}")[:12]
    # 由于 interval 可能不同，遍历 thumbs 目录删除所有以相同 sig 前缀开头的文件
    import hashlib
    # sig 基础部分（不含 interval）：filename|file_type|fsize|fmtime
    sig_base = f"{filename}|{file_type}|{fsize}|{fmtime}|"
    thumbs_dir = os.path.join(input_dir, *THUMBS_ROOT.split("/"))
    if os.path.isdir(thumbs_dir):
        try:
            for name in os.listdir(thumbs_dir):
                # full 缩略图命名：{sig}_t_0001.jpg
                if not name.endswith(".jpg") or "_t_" not in name:
                    continue
                # 尝试常见 interval 值匹配 sig
                for interval in [0.3, 0.5, 1.0, 0.2, 0.1]:
                    sig = hashlib.md5(f"{sig_base}{interval:.4f}".encode()).hexdigest()[:12]
                    if name.startswith(sig + "_t_"):
                        try:
                            fp = os.path.join(thumbs_dir, name)
                            os.chmod(fp, 0o777)
                            os.remove(fp)
                            result["removed_thumbs"] += 1
                        except OSError:
                            pass
                        break
        except OSError as e:
            print(f"[小珠光] 删除缩略图时出错: {e}")

    return result


def probe_video(filename, file_type):
    """探测视频/图片元数据
    图片：用 ffprobe 获取宽高，duration 返回 0（前端用 IMAGE_DEFAULT_DURATION 填充）
    视频：用 `ffmpeg -i video` 让 ffmpeg 在无输出时报错退出（exit 1），
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

    # 图片：用 ffmpeg 解析宽高，返回固定结构（duration=0，前端填充默认时长）
    if _is_image_file(filename):
        args = [ffmpeg_path, "-i", video_path]
        try:
            proc = subprocess.run(args, stdout=subprocess.DEVNULL,
                                  stderr=subprocess.PIPE, timeout=15, check=False)
        except subprocess.TimeoutExpired:
            raise Exception("FFmpeg probe image timeout (15s)")
        lines = proc.stderr.decode(*ENCODE_ARGS)
        size_base = None
        for line in lines.split('\n'):
            m = re.search(r"^ *Stream .* Video.*, ([1-9]|\d{2,})x(\d+)", line)
            if m is not None:
                size_base = [int(m.group(1)), int(m.group(2))]
                break
        if size_base is None:
            raise Exception("无法解析图片分辨率")
        return {
            "filename": filename,
            "type": file_type,
            "width": size_base[0],
            "height": size_base[1],
            "fps": 0,
            "duration": 0,
            "has_audio": False,
            "audio_only": False,
            "frame_count": 1,
            "file_size": file_size,
            "is_image": True,
            "default_duration": IMAGE_DEFAULT_DURATION,
        }

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

    # 纯音频文件（无视频流但有音频流）：返回 audio_only 标记，不抛错
    if size_base is None:
        if has_audio and duration > 0:
            return {
                "filename": filename,
                "type": file_type,
                "width": 0,
                "height": 0,
                "fps": 0,
                "duration": duration,
                "has_audio": True,
                "audio_only": True,
                "frame_count": 0,
                "file_size": file_size,
            }
        # 既无视频流也无音频流：文件异常
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
        "audio_only": False,
        "frame_count": frame_count,
        "file_size": file_size,
    }


def extract_frame(filename, file_type, time_sec, small=False):
    """提取单帧为图片，写入 input/fastcut-cache/thumbs/frames 目录
    small=True: 缩放到高度 120px + JPEG（缩略图用，体积小、IO 快）
    small=False: 全分辨率 PNG（导出帧用）
    返回: out_name（仅 basename）；子路径固定为 THUMBS_FRAMES_SUBDIR
    """
    video_path, _ = resolve_path(filename, file_type)
    if not os.path.isfile(video_path):
        raise Exception(f"file not found: {filename}")
    if time_sec < 0:
        time_sec = 0.0

    input_dir = folder_paths.get_input_directory()
    # 输出统一嵌套到：input/fastcut-cache/thumbs/frames
    out_dir = os.path.join(input_dir, *THUMBS_FRAMES_SUBDIR.split("/"))
    os.makedirs(out_dir, exist_ok=True)

    # 图片：直接复制原图作为"帧"，无需 ffmpeg 转码
    if _is_image_file(filename):
        import shutil as _shutil
        ext = os.path.splitext(filename)[1].lower()
        out_name = f"frame_{int(time.time() * 1000)}{ext}"
        out_path = os.path.join(out_dir, out_name)
        try:
            _shutil.copy2(video_path, out_path)
        except Exception as e:
            raise Exception(f"copy image frame failed: {e}")
        return out_name

    if small:
        # 缩略图模式：高度 120px + JPEG q5（按高度缩放保持比例，体积约为 PNG 的 1/10）
        out_name = f"frame_{int(time.time() * 1000)}_{int(time_sec * 1000)}.jpg"
        out_path = os.path.join(out_dir, out_name)
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
        out_path = os.path.join(out_dir, out_name)
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
    返回: [{filename, subfolder, index}, ...] 按顺序；subfolder = "fastcut-cache/thumbs/batch_xxx"
    """
    if count <= 0 or clip_end <= clip_start:
        return []
    video_path, _ = resolve_path(filename, file_type)
    if not os.path.isfile(video_path):
        raise Exception(f"file not found: {filename}")

    input_dir = folder_paths.get_input_directory()
    os.makedirs(input_dir, exist_ok=True)

    # 扁平存放：所有缩略图直接放在 fastcut-cache/thumbs/ 下，文件名带 batch_id 前缀避免冲突
    batch_id = int(time.time() * 1000)
    thumbs_rel = THUMBS_ROOT  # 相对 input 的 subfolder
    thumbs_dir = os.path.join(input_dir, *thumbs_rel.split("/"))
    os.makedirs(thumbs_dir, exist_ok=True)

    dur = clip_end - clip_start
    # fps 滤镜：按 count/dur 频率均匀采样，单进程提取所有帧
    fps_filter = count / dur

    out_pattern = os.path.join(thumbs_dir, f"{batch_id}_thumb_%03d.jpg")
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
        fname = f"{batch_id}_thumb_{i + 1:03d}.jpg"
        fpath = os.path.join(thumbs_dir, fname)
        if os.path.isfile(fpath):
            results.append({
                "filename": fname,
                "subfolder": thumbs_rel,
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

    # 纯音频文件：跳过缩略图生成（音频无视觉内容）
    if _is_audio_file(filename):
        return {"results": [], "duration": known_duration or 0, "interval": interval, "count": 0}

    # 图片：缩略图就是自身，直接返回（subfolder 为图片所在目录）
    if _is_image_file(filename):
        # 图片名拆分为 subfolder + basename
        safe = filename.replace("\\", "/").lstrip("/")
        parts = [p for p in safe.split("/") if p not in ("", ".", "..")]
        basename = parts[-1] if parts else filename
        subfolder = "/".join(parts[:-1]) if len(parts) > 1 else ""
        return {
            "results": [{
                "filename": basename,
                "subfolder": subfolder,
                "time": 0,
                "index": 0,
            }],
            "duration": 0,
            "interval": interval,
            "count": 1,
        }

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

    # 稳定的 sig：基于视频名+大小+mtime，避免刷新后重新生成
    try:
        fsize = os.path.getsize(video_path)
        fmtime = int(os.path.getmtime(video_path))
    except Exception:
        fsize = 0
        fmtime = 0
    import hashlib
    sig = hashlib.md5(f"{filename}|{file_type}|{fsize}|{fmtime}|{interval:.4f}".encode()).hexdigest()[:12]
    # 扁平存放：所有缩略图直接放在 fastcut-cache/thumbs/ 下，文件名带 sig 前缀避免冲突
    thumbs_rel = THUMBS_ROOT  # 相对 input 的 subfolder
    thumbs_dir = os.path.join(input_dir, *thumbs_rel.split("/"))
    os.makedirs(thumbs_dir, exist_ok=True)

    # 磁盘缓存命中：检查 sig 前缀的文件是否存在
    expected_count = count
    def _thumb_name(i):
        return f"{sig}_t_{i + 1:04d}.jpg"

    results = []
    for i in range(expected_count):
        fname = _thumb_name(i)
        fpath = os.path.join(thumbs_dir, fname)
        if os.path.isfile(fpath):
            results.append({
                "filename": fname,
                "subfolder": thumbs_rel,
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

    # 缓存未命中：生成缩略图（扁平命名，直接输出到 thumbs_dir）
    out_pattern = os.path.join(thumbs_dir, f"{sig}_t_%04d.jpg")
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
        fname = _thumb_name(i)
        fpath = os.path.join(thumbs_dir, fname)
        if os.path.isfile(fpath):
            results.append({
                "filename": fname,
                "subfolder": thumbs_rel,
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


# NVENC 硬件编码可用性缓存（None=未检测, True/False=检测结果）
_XZG_VE_NVENC_CACHE = None


def _xzg_ve_nvenc_available():
    """检测 ffmpeg 是否支持 h264_nvenc 硬件编码，结果缓存避免重复检测"""
    global _XZG_VE_NVENC_CACHE
    if _XZG_VE_NVENC_CACHE is not None:
        return _XZG_VE_NVENC_CACHE
    try:
        proc = subprocess.run(
            [ffmpeg_path, "-hide_banner", "-encoders"],
            capture_output=True, timeout=10
        )
        out = proc.stdout.decode(*ENCODE_ARGS) + proc.stderr.decode(*ENCODE_ARGS)
        _XZG_VE_NVENC_CACHE = "h264_nvenc" in out
        print(f"[小珠光] NVENC 硬件编码可用性: {_XZG_VE_NVENC_CACHE}")
    except Exception as e:
        _XZG_VE_NVENC_CACHE = False
        print(f"[小珠光] NVENC 检测失败，回退软编: {e}")
    return _XZG_VE_NVENC_CACHE


def render_timeline(timeline, output_name=None, target_w=None, target_h=None, target_fps=None, quality="medium",
                    use_default_output=True, base_dir="", filename_prefix="xzg-edit", add_date_stamp=False, add_time_stamp=False):
    """渲染时间线：多源多片段拼接为 mp4
    timeline: [{filename, type, start, end}, ...]
    target_w/target_h: 目标分辨率（>0 时覆盖首个片段分辨率）
    target_fps: 目标帧率（>0 时覆盖首个片段帧率）
    quality: 质量等级 high/medium/low → CRF/CQ 10/20/28
    输出设置（与小珠光图像保存-化神级完全一致）：
      use_default_output=True → 输出到 ComfyUI output 目录，前缀固定 xzg-edit
      use_default_output=False → 输出到 base_dir，前缀 = filename_prefix + 日期戳/时间戳
    """
    if not timeline:
        raise Exception("timeline is empty")
    if len(timeline) > 30:
        raise Exception("too many clips (max 30)")

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

    # 规整片段（含 kind 和时间线位置 tlStart）
    norm_clips = []
    for clip in timeline:
        try:
            start = float(clip['start'])
            end = float(clip['end'])
            tl_start = float(clip.get('tlStart', 0))
            kind = clip.get('kind', 'video')
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
        # 前端标记 skip_audio=true 表示音频已独立拆分，即使源 has_audio=true 也不再从视频提
        raw_has_audio = source_audio.get(key, True)
        skip_flag = bool(clip.get('skip_audio', False))
        norm_clips.append({
            "filename": clip['filename'],
            "type": clip['type'],
            "start": start,
            "end": end,
            "tlStart": tl_start,
            "kind": kind,
            "has_audio": False if skip_flag else raw_has_audio,
            "skip_audio": skip_flag,
        })
    if not norm_clips:
        raise Exception("no valid clips")

    # 调试日志：打印规整后的片段信息
    print(f"[小珠光] render_timeline: {len(norm_clips)} clips")
    for c in norm_clips:
        print(f"  kind={c['kind']} file={c['filename']} start={c['start']:.3f} end={c['end']:.3f} tlStart={c['tlStart']:.3f} has_audio={c['has_audio']}")

    # 分离视频轨和音频轨
    norm_video = [c for c in norm_clips if c['kind'] != 'audio']
    norm_audio = [c for c in norm_clips if c['kind'] == 'audio']

    # 总时长 = max(视频末尾, 音频末尾)
    video_end = max([c['tlStart'] + (c['end'] - c['start']) for c in norm_video] + [0]) if norm_video else 0
    audio_end = max([c['tlStart'] + (c['end'] - c['start']) for c in norm_audio] + [0]) if norm_audio else 0
    total_duration = max(video_end, audio_end)
    if total_duration < 0.01:
        raise Exception("timeline too short")

    # 音频来源：独立音频片段 或 从视频提取
    has_independent_audio = len(norm_audio) > 0
    has_video_audio = any(c['has_audio'] for c in norm_video)
    any_audio = has_independent_audio or has_video_audio

    # 以首个视频片段分辨率/帧率为基准统一所有片段
    base_key = f"{norm_video[0]['filename']}|{norm_video[0]['type']}" if norm_video else f"{norm_clips[0]['filename']}|{norm_clips[0]['type']}"
    first_info = source_info.get(base_key)
    if not first_info:
        raise Exception("无法探测首个片段的分辨率，不能渲染")
    base_w = int(target_w) if (target_w and int(target_w) > 0) else int(first_info['width'])
    base_h = int(target_h) if (target_h and int(target_h) > 0) else int(first_info['height'])
    base_fps = float(target_fps) if (target_fps and float(target_fps) > 0) else (first_info.get('fps') or 30.0)
    base_fps_str = f"{base_fps:g}"

    # 构建 ffmpeg 命令
    cmd = [ffmpeg_path, "-y", "-v", "error"]
    for s in sources:
        cmd += ["-i", s]

    # 构建 filter_complex：视频轨和音频轨分别处理
    # 终点之前所有区域都是输出：空白=黑屏+静音，空白+音频=黑屏+音频，视频+空音频=视频+静音
    filter_parts = []
    v_labels = []
    a_labels = []
    v_idx = 0
    a_idx = 0

    # ── 视频轨：排序，左侧空隙黑屏，中间空隙黑屏，末尾补齐黑屏 ──
    norm_video.sort(key=lambda c: c['tlStart'])
    v_prev_end = 0.0
    for clip in norm_video:
        curr_start = clip['tlStart']
        dur = clip['end'] - clip['start']
        # 空隙填充黑屏（左侧 + 中间）
        if curr_start > v_prev_end + 0.01:
            gap = curr_start - v_prev_end
            filter_parts.append(
                f"color=black:s={base_w}x{base_h}:d={gap:.3f}:r={base_fps_str},"
                f"scale={base_w}:{base_h}:force_original_aspect_ratio=decrease,"
                f"pad={base_w}:{base_h}:(ow-iw)/2:(oh-ih)/2:black,"
                f"fps={base_fps_str},setsar=1,format=yuv420p[v{v_idx}]"
            )
            v_labels.append(f"[v{v_idx}]")
            v_idx += 1
        # 视频片段
        key = f"{clip['filename']}|{clip['type']}"
        src_idx = source_map[key]
        s, e = clip['start'], clip['end']
        is_img = _is_image_file(clip['filename'])
        if is_img:
            # 图片：单帧，用 loop 滤镜复制帧到指定时长（start/end 在前端已设为 0/duration）
            dur_clip = e - s
            filter_parts.append(
                f"[{src_idx}:v:0]loop=loop=-1:size=1:start=0,"
                f"trim=duration={dur_clip:.3f},setpts=PTS-STARTPTS,"
                f"scale={base_w}:{base_h}:force_original_aspect_ratio=decrease,"
                f"pad={base_w}:{base_h}:(ow-iw)/2:(oh-ih)/2:black,"
                f"fps={base_fps_str},setsar=1,format=yuv420p[v{v_idx}]"
            )
        else:
            filter_parts.append(
                f"[{src_idx}:v:0]trim=start={s:.3f}:end={e:.3f},setpts=PTS-STARTPTS,"
                f"scale={base_w}:{base_h}:force_original_aspect_ratio=decrease,"
                f"pad={base_w}:{base_h}:(ow-iw)/2:(oh-ih)/2:black,"
                f"fps={base_fps_str},setsar=1,format=yuv420p[v{v_idx}]"
            )
        v_labels.append(f"[v{v_idx}]")
        v_idx += 1
        v_prev_end = curr_start + dur
    # 末尾补齐黑屏到总时长
    if total_duration > v_prev_end + 0.01:
        gap = total_duration - v_prev_end
        filter_parts.append(
            f"color=black:s={base_w}x{base_h}:d={gap:.3f}:r={base_fps_str},"
            f"scale={base_w}:{base_h}:force_original_aspect_ratio=decrease,"
            f"pad={base_w}:{base_h}:(ow-iw)/2:(oh-ih)/2:black,"
            f"fps={base_fps_str},setsar=1,format=yuv420p[v{v_idx}]"
        )
        v_labels.append(f"[v{v_idx}]")
        v_idx += 1

    # ── 音频轨 ──
    if has_independent_audio:
        # 独立音频片段：排序，空隙静音，末尾补齐静音
        norm_audio.sort(key=lambda c: c['tlStart'])
        a_prev_end = 0.0
        for clip in norm_audio:
            curr_start = clip['tlStart']
            dur = clip['end'] - clip['start']
            if curr_start > a_prev_end + 0.01:
                gap = curr_start - a_prev_end
                filter_parts.append(
                    f"anullsrc=channel_layout=stereo:sample_rate=44100:duration={gap:.3f}[a{a_idx}]"
                )
                a_labels.append(f"[a{a_idx}]")
                a_idx += 1
            key = f"{clip['filename']}|{clip['type']}"
            src_idx = source_map[key]
            s, e = clip['start'], clip['end']
            filter_parts.append(
                f"[{src_idx}:a:0]atrim=start={s:.3f}:end={e:.3f},asetpts=PTS-STARTPTS[a{a_idx}]"
            )
            a_labels.append(f"[a{a_idx}]")
            a_idx += 1
            a_prev_end = curr_start + dur
        if total_duration > a_prev_end + 0.01:
            gap = total_duration - a_prev_end
            filter_parts.append(
                f"anullsrc=channel_layout=stereo:sample_rate=44100:duration={gap:.3f}[a{a_idx}]"
            )
            a_labels.append(f"[a{a_idx}]")
            a_idx += 1
    elif has_video_audio:
        # 从视频提取音频：跟随视频轨位置，空隙静音，无音频流视频用 anullsrc
        v_prev_end = 0.0
        for clip in norm_video:
            curr_start = clip['tlStart']
            dur = clip['end'] - clip['start']
            if curr_start > v_prev_end + 0.01:
                gap = curr_start - v_prev_end
                filter_parts.append(
                    f"anullsrc=channel_layout=stereo:sample_rate=44100:duration={gap:.3f}[a{a_idx}]"
                )
                a_labels.append(f"[a{a_idx}]")
                a_idx += 1
            key = f"{clip['filename']}|{clip['type']}"
            src_idx = source_map[key]
            s, e = clip['start'], clip['end']
            if clip['has_audio']:
                filter_parts.append(
                    f"[{src_idx}:a:0]atrim=start={s:.3f}:end={e:.3f},asetpts=PTS-STARTPTS[a{a_idx}]"
                )
            else:
                filter_parts.append(
                    f"anullsrc=channel_layout=stereo:sample_rate=44100:duration={dur:.3f}[a{a_idx}]"
                )
            a_labels.append(f"[a{a_idx}]")
            a_idx += 1
            v_prev_end = curr_start + dur
        if total_duration > v_prev_end + 0.01:
            gap = total_duration - v_prev_end
            filter_parts.append(
                f"anullsrc=channel_layout=stereo:sample_rate=44100:duration={gap:.3f}[a{a_idx}]"
            )
            a_labels.append(f"[a{a_idx}]")
            a_idx += 1

    # concat 视频轨和音频轨（片段数独立）
    n_v = len(v_labels)
    if any_audio and a_labels:
        n_a = len(a_labels)
        filter_parts.append(f"{''.join(v_labels)}concat=n={n_v}:v=1:a=0[outv]")
        filter_parts.append(f"{''.join(a_labels)}concat=n={n_a}:v=0:a=1[outa]")
    else:
        filter_parts.append(f"{''.join(v_labels)}concat=n={n_v}:v=1:a=0[outv]")

    cmd += ["-filter_complex", ";".join(filter_parts),
            "-map", "[outv]"]
    if any_audio:
        cmd += ["-map", "[outa]",
                "-c:a", "aac", "-b:a", "128k"]
    # 编码器：优先 NVENC 硬编（大幅提速），否则 libx264 veryfast（比 fast 快约 2 倍）
    # 质量：high→CRF/CQ 10（视觉无损）、medium→20（默认均衡）、low→28（压缩）
    q_map = {"high": 10, "medium": 20, "low": 28}
    q_val = q_map.get(quality, 20)
    if _xzg_ve_nvenc_available():
        cmd += ["-c:v", "h264_nvenc", "-preset", "p4", "-cq", str(q_val), "-pix_fmt", "yuv420p"]
    else:
        cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", str(q_val), "-pix_fmt", "yuv420p"]

    # ═══════════════════════════════════════════════════════════════════
    # 输出目录 + 文件名（与小珠光图像保存-化神级完全一致）
    # ═══════════════════════════════════════════════════════════════════
    if use_default_output:
        # 默认输出：ComfyUI output 目录，前缀固定 xzg-edit，_ 分隔
        out_dir = folder_paths.get_output_directory()
        out_type = "output"
        resolved_prefix = "xzg-edit"
        prefix_sep = "_"
    else:
        # 自定义输出：base_dir + 前缀/日期戳/时间戳
        now = datetime.now()
        _custom = _xzg_sanitize(filename_prefix or "")
        _date = now.strftime("%Y%m%d") if add_date_stamp else ""
        _time = now.strftime("%H%M%S") if add_time_stamp else ""
        # 日期-时间拼接
        _dt = ""
        if _date and _time:
            _dt = f"{_date}-{_time}"
        elif _date:
            _dt = _date
        elif _time:
            _dt = _time
        if _dt and _custom:
            resolved_prefix = f"{_dt}-{_custom}"
        elif _dt:
            resolved_prefix = _dt
        elif _custom:
            resolved_prefix = _custom
        else:
            resolved_prefix = "xzg-edit"
        prefix_sep = "-"
        # 输出目录：绝对路径直接用，相对路径拼到 ComfyUI output/ 下
        resolved_base = _xzg_sanitize(base_dir or "")
        if resolved_base and _xzg_is_absolute_path(resolved_base):
            out_dir = resolved_base
        elif resolved_base:
            out_dir = os.path.join(folder_paths.get_output_directory(), resolved_base)
        else:
            out_dir = folder_paths.get_output_directory()
        out_type = "output"
    os.makedirs(out_dir, exist_ok=True)

    # 生成唯一文件名：前缀 + 序号（避免覆盖同名文件）
    counter = 1
    while True:
        safe_out = f"{resolved_prefix}{prefix_sep}{counter:04d}.mp4"
        out_path = os.path.join(out_dir, safe_out)
        if not os.path.exists(out_path):
            break
        counter += 1
    cmd.append(out_path)

    proc = subprocess.run(cmd, capture_output=True, timeout=600)
    if proc.returncode != 0:
        err = proc.stderr.decode(*ENCODE_ARGS)
        raise Exception(f"ffmpeg failed: {err[:800]}")
    if not os.path.isfile(out_path):
        raise Exception("output not produced")
    return safe_out, out_type


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
        media = list_input_media()
        return web.json_response({"media": media, "videos": [m["name"] for m in media]})

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
        return web.json_response({
            "filename": out_name,
            "subfolder": THUMBS_FRAMES_SUBDIR,  # 帧缩略图统一放到 fastcut-cache/thumbs/frames
            "type": "input",
            "time": time_sec,
            "small": small,
        })

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
        quality = data.get("quality", "medium")
        use_default_output = data.get("use_default_output", True)
        base_dir = data.get("base_dir", "")
        filename_prefix = data.get("filename_prefix", "xzg-edit")
        add_date_stamp = data.get("add_date_stamp", False)
        add_time_stamp = data.get("add_time_stamp", False)
        out_name, out_type = render_timeline(timeline, output_name, target_w, target_h, target_fps, quality,
                                             use_default_output, base_dir, filename_prefix, add_date_stamp, add_time_stamp)
        return web.json_response({"filename": out_name, "type": out_type, "clips_count": len(timeline)})

    @_xzg_ve_PS.instance.routes.post("/xzg_video_editor_clear_cache")
    @_xzg_ve_safe
    async def xzg_video_editor_clear_cache_route(request):
        # 一键清理缓存：删除整个 fastcut-cache 目录（上传的媒体文件 + 缩略图）+ 旧遗留
        # 不再在重启时自动执行，仅由前端"一键清理缓存"按钮手动触发
        result = clear_xzg_cache()
        # 返回清理后 fastcut-cache 目录是否仍存在
        try:
            input_dir = folder_paths.get_input_directory()
            still_exists = os.path.isdir(os.path.join(input_dir, XZG_VE_ROOT))
        except Exception:
            still_exists = False
        return web.json_response({
            "cleaned": not still_exists,
            "still_exists": still_exists,
            "removed_files": result["removed_files"],
            "removed_dirs": result["removed_dirs"],
            "failed_dirs": result["failed_dirs"],
            "error": result["error"],
        })

    @_xzg_ve_PS.instance.routes.post("/xzg_video_editor_delete_media")
    @_xzg_ve_safe
    async def xzg_video_editor_delete_media_route(request):
        # 删除单个媒体文件及其关联的缩略图缓存
        data = await request.json()
        filename = data.get("filename", "")
        file_type = data.get("type", "input")
        if not filename:
            return web.json_response({"error": "filename required"}, status=400)
        result = delete_media(filename, file_type)
        return web.json_response({
            "removed_media": result["removed_media"],
            "removed_thumbs": result["removed_thumbs"],
            "error": result["error"],
        })

    @_xzg_ve_PS.instance.routes.post("/xzg_video_editor_check_exists")
    @_xzg_ve_safe
    async def xzg_video_editor_check_exists_route(request):
        # 批量检测媒体文件是否存在（用于检测手工删除的缓存文件）
        data = await request.json()
        items = data.get("items", [])
        missing = []
        for it in items:
            name = it.get("name", "")
            ftype = it.get("type", "input")
            if not name:
                continue
            try:
                fp, _ = resolve_path(name, ftype)
                if not os.path.isfile(fp):
                    missing.append(name)
            except Exception:
                missing.append(name)
        return web.json_response({"missing": missing})

    print("[小珠光] 视频编辑器 API 路由已注册: /xzg_video_editor_*")
else:
    print("[小珠光] 警告: PromptServer.instance 未初始化, 视频编辑器 API 路由未注册")

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
    """把文件名中的非法字符替换为 _（与化神级 _sanitize 逻辑一致）
    注意：本函数只用于单个文件名 / 前缀 / 单段目录名；对于整段路径请用 _xzg_sanitize_path
    """
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


def _xzg_sanitize_path(p):
    """清理目录路径（保留路径分隔符 / \\ 以及盘符）。
    按 '/' 或 '\\' 拆成多段，每段单独用非法字符规则替换成 '_'，再按原风格拼回。
    用于 base_dir 等用户选择的目录，避免 C:\\Users\\Desktop 变成 C:__Users_Desktop
    """
    if not p:
        return p
    # 提取 Windows 盘符（如 "C:"），仅保留字母和冒号
    drive = ""
    rest = p
    m = re.match(r'^([A-Za-z]:)', p)
    if m:
        drive = m.group(1)
        rest = p[len(drive):]
    # 判断用的是哪种分隔符（优先反斜杠，其次正斜杠）
    sep = "\\" if ("\\" in rest and "/" not in rest) else "/"
    raw_segments = re.split(r"[\\/]", rest)
    cleaned = []
    for seg in raw_segments:
        if seg == "":
            # 保留连续分隔符的含义（例如开头的 / 代表绝对路径）
            cleaned.append("")
            continue
        # 单段：只替换 < > : " | ? * 以及控制字符；盘符已单独处理，所以这里把 ':' 也视为非法
        seg_clean = re.sub(r'[<>:"|?*\x00-\x1f]', "_", seg)
        seg_clean = seg_clean.strip().strip(".")
        cleaned.append(seg_clean)
    result = sep.join(cleaned)
    # 如果开头原来是分隔符（例如 \server\share 或 /home），确保 join 后仍然有
    if rest and (rest[0] == "\\" or rest[0] == "/"):
        if not result.startswith(sep):
            result = sep + result.lstrip(sep)
    # 规范化重复分隔符（如 \\server\share 开头保留双反斜，其他压缩为一个）
    if result.startswith("\\\\"):
        # UNC 路径：\\?\ 或 \\server\share 保留
        pass
    else:
        result = re.sub(r"[\\/]{2,}", lambda m, s=sep: s, result)
    return drive + result


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


def extract_frame(filename, file_type, time_sec, small=False,
                  use_default_output=True, base_dir="", filename_prefix="xzg-edit",
                  add_date_stamp=False, add_time_stamp=False):
    """提取单帧为图片
    small=True:  缩放到高度 120px + JPEG（缩略图用），输出到 input/fastcut-cache/thumbs/frames
    small=False: 全分辨率 PNG（导出帧用），输出目录与视频导出的输出设置一致
    返回: (out_name, out_type, out_subfolder)
      - out_name: 文件名（basename 或 含子路径的相对名）
      - out_type: "input" 或 "output"
      - out_subfolder: 子目录（相对 type 根目录），空字符串表示无
    """
    video_path, _ = resolve_path(filename, file_type)
    if not os.path.isfile(video_path):
        raise Exception(f"file not found: {filename}")
    if time_sec < 0:
        time_sec = 0.0

    # ── small 缩略图：固定写入 input/fastcut-cache/thumbs/frames（原逻辑不变） ──
    if small:
        input_dir = folder_paths.get_input_directory()
        out_dir = os.path.join(input_dir, *THUMBS_FRAMES_SUBDIR.split("/"))
        os.makedirs(out_dir, exist_ok=True)
        out_subfolder = THUMBS_FRAMES_SUBDIR
        out_type = "input"

        if _is_image_file(filename):
            import shutil as _shutil
            ext = os.path.splitext(filename)[1].lower()
            out_name = f"frame_{int(time.time() * 1000)}_{int(time_sec * 1000)}{ext}"
            out_path = os.path.join(out_dir, out_name)
            try:
                _shutil.copy2(video_path, out_path)
            except Exception as e:
                raise Exception(f"copy image frame failed: {e}")
            return out_name, out_type, out_subfolder

        # 缩略图模式：高度 120px + JPEG q5
        out_name = f"frame_{int(time.time() * 1000)}_{int(time_sec * 1000)}.jpg"
        out_path = os.path.join(out_dir, out_name)
        cmd = [ffmpeg_path, "-y", "-v", "error",
               "-ss", f"{time_sec:.3f}",
               "-i", video_path,
               "-frames:v", "1",
               "-vf", "scale=-1:120",
               "-q:v", "5",
               out_path]
        proc = subprocess.run(cmd, capture_output=True, timeout=60)
        if proc.returncode != 0:
            err = proc.stderr.decode(*ENCODE_ARGS)
            raise Exception(f"ffmpeg failed: {err[:500]}")
        if not os.path.isfile(out_path):
            raise Exception("frame not produced")
        return out_name, out_type, out_subfolder

    # ── 非 small 导出帧：目录与视频导出输出设置一致 ──
    if use_default_output:
        # 默认输出：ComfyUI output 目录，前缀固定 xzg-edit
        out_root = folder_paths.get_output_directory()
        out_type = "output"
        resolved_prefix = "xzg-edit"
        prefix_sep = "_"
        out_subfolder_rel = ""  # 直接放根目录
    else:
        # 自定义输出：base_dir + 前缀/日期戳/时间戳
        now = datetime.now()
        _custom = _xzg_sanitize(filename_prefix or "")
        _date = now.strftime("%Y%m%d") if add_date_stamp else ""
        _time = now.strftime("%H%M%S") if add_time_stamp else ""
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
        resolved_base = _xzg_sanitize_path(base_dir or "")
        if resolved_base and _xzg_is_absolute_path(resolved_base):
            out_root = resolved_base
            out_type = "absolute"  # 标记为绝对路径，前端/view 不可直接访问
            out_subfolder_rel = ""
        elif resolved_base:
            out_root = folder_paths.get_output_directory()
            out_type = "output"
            out_subfolder_rel = resolved_base  # 相对 output/ 的子目录
        else:
            out_root = folder_paths.get_output_directory()
            out_type = "output"
            out_subfolder_rel = ""

    # 拼接实际 out_dir（如果是 absolute 模式直接 out_root；否则 out_root + 子目录）
    if out_type == "absolute":
        out_dir = out_root
    elif out_subfolder_rel:
        out_dir = os.path.join(out_root, *out_subfolder_rel.split("/"))
    else:
        out_dir = out_root
    os.makedirs(out_dir, exist_ok=True)

    # 源文件是图片：直接复制（改扩展名保持原格式）
    if _is_image_file(filename):
        import shutil as _shutil
        ext = os.path.splitext(filename)[1].lower() or ".png"
        counter = 1
        while True:
            out_name = f"{resolved_prefix}{prefix_sep}{counter:04d}{ext}"
            out_path = os.path.join(out_dir, out_name)
            if not os.path.exists(out_path):
                break
            counter += 1
        try:
            _shutil.copy2(video_path, out_path)
        except Exception as e:
            raise Exception(f"copy image frame failed: {e}")
        # 返回格式：subfolder 下的相对名（供 /view 端点使用）
        if out_subfolder_rel:
            rel_name = f"{out_subfolder_rel.replace(os.sep, '/')}/{out_name}"
        else:
            rel_name = out_name
        return rel_name, out_type, out_subfolder_rel

    # 全分辨率 PNG（导出帧用），按前缀+序号生成唯一文件名
    counter = 1
    while True:
        out_name = f"{resolved_prefix}{prefix_sep}{counter:04d}.png"
        out_path = os.path.join(out_dir, out_name)
        if not os.path.exists(out_path):
            break
        counter += 1
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
    if out_subfolder_rel:
        rel_name = f"{out_subfolder_rel.replace(os.sep, '/')}/{out_name}"
    else:
        rel_name = out_name
    return rel_name, out_type, out_subfolder_rel


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
                    use_default_output=True, base_dir="", filename_prefix="xzg-edit", add_date_stamp=False, add_time_stamp=False,
                    audio_only=False, audio_format="mp3", audio_bitrate="128"):
    """渲染时间线：多源多片段拼接为视频 或 仅导出音频
    timeline: [{filename, type, start, end}, ...]
    target_w/target_h: 目标分辨率（>0 时覆盖首个片段分辨率，audio_only 时忽略）
    target_fps: 目标帧率（>0 时覆盖首个片段帧率，audio_only 时可忽略）
    quality: 视频质量等级 high/medium/low → CRF/CQ 10/20/28（audio_only 时忽略）
    audio_only: True 仅输出音频（无视频流），此时 output_ext = audio_format
    audio_format: "mp3" / "flac" / "wav"（与小珠光音频保存完全一致）
    audio_bitrate: MP3 比特率 kbps（"320"/"192"/"128"），FLAC/WAV 忽略（无损）
    输出设置（与小珠光图像保存-化神级完全一致）：
      use_default_output=True → 输出到 ComfyUI output 目录，前缀固定 xzg-edit
      use_default_output=False → 输出到 base_dir，前缀 = filename_prefix + 日期戳/时间戳
    返回: (safe_out, out_type, extra_dict)
      safe_out:     相对 output 的文件名（可能含子目录分隔符 /）
      out_type:     "output" 或 "absolute"
      extra_dict:   {"audio_only": bool, "audio_format": str|null, "video": bool, "extension": str}
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
            raw_track = clip.get('track')
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
        # track 规范化：video 在 {v1, v2}，audio 在 {a1, a2}，不合法回默认
        if kind == 'audio':
            track = 'a2' if raw_track == 'a2' else 'a1'
        else:
            track = 'v2' if raw_track == 'v2' else 'v1'
        key = f"{clip['filename']}|{clip['type']}"
        # 前端标记 skip_audio=true 表示音频已独立拆分，即使源 has_audio=true 也不再从视频提
        raw_has_audio = source_audio.get(key, True)
        skip_flag = bool(clip.get('skip_audio', False))
        # 视频变换属性（大小/移动/裁剪/透明度/音量）透传
        def _f(key, default):
            v = clip.get(key, default)
            if v is None:
                return default
            return v
        norm_clips.append({
            "filename": clip['filename'],
            "type": clip['type'],
            "start": start,
            "end": end,
            "tlStart": tl_start,
            "kind": kind,
            "track": track,
            "has_audio": False if skip_flag else raw_has_audio,
            "skip_audio": skip_flag,
            "scale": float(_f("scale", 1.0)),
            "offsetX": float(_f("offsetX", 0.0)),
            "offsetY": float(_f("offsetY", 0.0)),
            "cropLeft": float(_f("cropLeft", 0.0)),
            "cropRight": float(_f("cropRight", 0.0)),
            "cropTop": float(_f("cropTop", 0.0)),
            "cropBottom": float(_f("cropBottom", 0.0)),
            "opacity": float(_f("opacity", 1.0)),
            "volume": float(_f("volume", 1.0)),
        })
    if not norm_clips:
        raise Exception("no valid clips")

    # 调试日志：打印规整后的片段信息
    print(f"[小珠光] render_timeline: {len(norm_clips)} clips")
    for c in norm_clips:
        print(f"  kind={c['kind']} track={c['track']} file={c['filename']} start={c['start']:.3f} end={c['end']:.3f} tlStart={c['tlStart']:.3f} has_audio={c['has_audio']}")

    # 分离视频轨（v1 下层/v2 上层）和音频轨（a1/a2）
    norm_video = [c for c in norm_clips if c['kind'] != 'audio']
    norm_video_v1 = [c for c in norm_video if c['track'] != 'v2']
    norm_video_v2 = [c for c in norm_video if c['track'] == 'v2']
    norm_audio = [c for c in norm_clips if c['kind'] == 'audio']

    # ── audio_only 纯音频模式：若没有任何音频来源（连从视频提的都没有）就报错 ──
    if audio_only:
        # 先尝试解析是否有可提取的音频源；否则直接抛错
        any_audio_probe = (
            len(norm_audio) > 0
            or any(
                (not bool(c.get('skip_audio', False))) and source_audio.get(f"{c['filename']}|{c['type']}", False)
                for c in norm_video
            )
        )
        if not any_audio_probe:
            raise Exception("时间线上没有任何音频来源，无法仅导出音频。请添加音频片段，或包含带音频的视频片段。")
        # audio_only 时忽略视频分辨率计算，直接跳过视频轨（base_w/h 仍保留以防 filter 复用）
        base_w = 0
        base_h = 0
        base_fps = 0.0
        base_fps_str = "0"
        video_only_audio = False  # 不再需要黑屏填充，我们直接丢弃视频轨
    else:
        # 只有音频、无视频：用黑屏填充整个视频轨（默认 1280x720 @ 30fps）
        video_only_audio = (len(norm_video) == 0 and len(norm_audio) > 0)
        DEFAULT_BLACK_W = 1280
        DEFAULT_BLACK_H = 720
        DEFAULT_BLACK_FPS = 30.0

        # 以首个视频片段分辨率/帧率为基准统一所有片段
        # 只有音频时：使用默认黑屏分辨率/帧率
        if video_only_audio:
            base_w = int(target_w) if (target_w and int(target_w) > 0) else DEFAULT_BLACK_W
            base_h = int(target_h) if (target_h and int(target_h) > 0) else DEFAULT_BLACK_H
            base_fps = float(target_fps) if (target_fps and float(target_fps) > 0) else DEFAULT_BLACK_FPS
        else:
            base_key = f"{norm_video[0]['filename']}|{norm_video[0]['type']}" if norm_video else f"{norm_clips[0]['filename']}|{norm_clips[0]['type']}"
            first_info = source_info.get(base_key)
            if not first_info:
                raise Exception("无法探测首个片段的分辨率，不能渲染")
            base_w = int(target_w) if (target_w and int(target_w) > 0) else int(first_info['width'])
            base_h = int(target_h) if (target_h and int(target_h) > 0) else int(first_info['height'])
            if base_w <= 0 or base_h <= 0:
                base_w = base_w if base_w > 0 else DEFAULT_BLACK_W
                base_h = base_h if base_h > 0 else DEFAULT_BLACK_H
            base_fps = float(target_fps) if (target_fps and float(target_fps) > 0) else (first_info.get('fps') or 30.0)
            if base_fps <= 0:
                base_fps = DEFAULT_BLACK_FPS
        base_fps_str = f"{base_fps:g}"

    # 总时长 = max(视频末尾, 音频末尾)
    video_end = max([c['tlStart'] + (c['end'] - c['start']) for c in norm_video] + [0]) if norm_video else 0
    audio_end = max([c['tlStart'] + (c['end'] - c['start']) for c in norm_audio] + [0]) if norm_audio else 0
    total_duration = max(video_end, audio_end)
    if total_duration < 0.01:
        raise Exception("timeline too short")

    # 调试：打印音频片段裁剪信息，便于排查「裁剪后加载器仍显示原时长」
    if norm_audio:
        print(f"[小珠光-调试] total_duration={total_duration:.3f} audio_only={audio_only}")
        for c in norm_audio:
            print(f"  audio track={c['track']} start={c['start']:.3f} end={c['end']:.3f} "
                  f"dur={c['end']-c['start']:.3f} tlStart={c['tlStart']:.3f}")

    # 音频来源：独立音频片段 或 从视频提取
    has_independent_audio = len(norm_audio) > 0
    has_video_audio = any(c['has_audio'] for c in norm_video)
    any_audio = has_independent_audio or has_video_audio

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

    def _vid_transform(clip, base_w, base_h):
        """生成单个视频片段的「裁剪→contain缩放→大小缩放→移动居中pad」filter 片段。
        返回逗号连接的 filter 字符串（不含 trim/loop、fps/setsar/format）。
        """
        parts = []
        cl = max(0.0, min(0.99, float(clip.get('cropLeft', 0.0))))
        cr = max(0.0, min(0.99, float(clip.get('cropRight', 0.0))))
        ct = max(0.0, min(0.99, float(clip.get('cropTop', 0.0))))
        cb = max(0.0, min(0.99, float(clip.get('cropBottom', 0.0))))
        if (cl + cr + ct + cb) > 0.001:
            # 裁掉四边比例：w=iw*(1-cl-cr) h=ih*(1-ct-cb) x=iw*cl y=ih*ct
            parts.append(
                f"crop=iw*(1-{cl:g}-{cr:g}):ih*(1-{ct:g}-{cb:g}):iw*{cl:g}:ih*{ct:g}"
            )
        # contain 到目标分辨率
        parts.append(f"scale={base_w}:{base_h}:force_original_aspect_ratio=decrease")
        # 大小缩放（scale）
        sc = float(clip.get('scale', 1.0))
        if abs(sc - 1.0) > 0.001 and sc > 0:
            parts.append(f"scale=iw*{sc:g}:ih*{sc:g}")
        # 移动 + 居中 pad（偏移像素）
        ox = float(clip.get('offsetX', 0.0))
        oy = float(clip.get('offsetY', 0.0))
        parts.append(f"pad={base_w}:{base_h}:(ow-iw)/2+{ox:g}:(oh-ih)/2+{oy:g}:black")
        return ",".join(parts)

    def _vid_opacity(clip):
        """片段透明度：透明时返回「format=rgba,colorchannelmixer=aa=xxx,format=yuva420p」，
        不透明时返回 None（直接 format=yuva420p）。
        必须先转 rgba 再设置 alpha（与透明黑的做法一致），否则 yuva420p 上 aa 不生效。"""
        op = float(clip.get('opacity', 1.0))
        op = max(0.0, min(1.0, op))
        if abs(op - 1.0) < 0.001:
            return None
        return f"format=rgba,colorchannelmixer=aa={op:g},format=yuva420p"

    # ── 视频轨：排序，左侧空隙黑屏，中间空隙黑屏，末尾补齐黑屏 ──
    # V1（下层视频，track!=v2）：按 tlStart 拼接成完整时间线（[vbase]）
    # V2（上层视频，track==v2）：逐段生成后 overlay 在 [vbase] 上（X重叠时 V2 覆盖 V1）
    # 只有音频模式：整个视频轨只生成一条黑屏，覆盖 total_duration
    # audio_only 纯音频模式：跳过所有视频轨 filter，v_labels 留空
    if not audio_only:
        if video_only_audio:
            # 无视频（仅音频）：一条黑屏占位（后续无 V2 overlay）
            filter_parts.append(
                f"color=black:s={base_w}x{base_h}:d={total_duration:.3f}:r={base_fps_str},"
                f"scale={base_w}:{base_h}:force_original_aspect_ratio=decrease,"
                f"pad={base_w}:{base_h}:(ow-iw)/2:(oh-ih)/2:black,"
                f"fps={base_fps_str},setsar=1,format=yuv420p[v{v_idx}]"
            )
            v_labels.append(f"[v{v_idx}]")
            v_idx += 1
        else:
            # ── 第一步：V1（下层）完整拼接为 [vbase]（带 alpha，支持片段透明度）──
            norm_video_v1.sort(key=lambda c: c['tlStart'])
            v_prev_end = 0.0
            for clip in norm_video_v1:
                curr_start = clip['tlStart']
                dur = clip['end'] - clip['start']
                # 空隙填充黑屏（左侧 + 中间）：不透明黑，与片段同为 yuva420p
                if curr_start > v_prev_end + 0.01:
                    gap = curr_start - v_prev_end
                    filter_parts.append(
                        f"color=black:s={base_w}x{base_h}:d={gap:.3f}:r={base_fps_str},"
                        f"scale={base_w}:{base_h}:force_original_aspect_ratio=decrease,"
                        f"pad={base_w}:{base_h}:(ow-iw)/2:(oh-ih)/2:black,"
                        f"fps={base_fps_str},setsar=1,format=yuva420p[v{v_idx}]"
                    )
                    v_labels.append(f"[v{v_idx}]")
                    v_idx += 1
                # 视频片段（V1）：裁剪/大小/移动/透明度
                key = f"{clip['filename']}|{clip['type']}"
                src_idx = source_map[key]
                s, e = clip['start'], clip['end']
                is_img = _is_image_file(clip['filename'])
                xf = _vid_transform(clip, base_w, base_h)
                op = _vid_opacity(clip)
                fmt_tail = op if op else "format=yuva420p"
                if is_img:
                    dur_clip = e - s
                    filter_parts.append(
                        f"[{src_idx}:v:0]loop=loop=-1:size=1:start=0,"
                        f"trim=duration={dur_clip:.3f},setpts=PTS-STARTPTS,"
                        f"{xf},"
                        f"fps={base_fps_str},setsar=1,{fmt_tail}[v{v_idx}]"
                    )
                else:
                    filter_parts.append(
                        f"[{src_idx}:v:0]trim=start={s:.3f}:end={e:.3f},setpts=PTS-STARTPTS,"
                        f"{xf},"
                        f"fps={base_fps_str},setsar=1,{fmt_tail}[v{v_idx}]"
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
                    f"fps={base_fps_str},setsar=1,format=yuva420p[v{v_idx}]"
                )
                v_labels.append(f"[v{v_idx}]")
                v_idx += 1
            # V1 全部 concat → [vbase]（带 alpha）
            n_v1 = len(v_labels)
            if n_v1 > 0:
                filter_parts.append(f"{''.join(v_labels)}concat=n={n_v1}:v=1:a=0[vbase]")
                v_labels.clear()
                # V1 是带 alpha 的层：先叠到黑底得到不透明 V1 结果（V1 片段半透明时露出黑底）
                filter_parts.append(
                    f"color=black:s={base_w}x{base_h}:d={total_duration:.3f}:r={base_fps_str},"
                    f"setsar=1,format=yuva420p[vblack]"
                )
                filter_parts.append(f"[vblack][vbase]overlay=x=0:y=0:format=auto:eof_action=pass[v{v_idx}]")
                base_layer = f"[v{v_idx}]"
                v_idx += 1
            else:
                base_layer = None

            # ── 第二步：V2（上层，track=v2）构建为整条时间线 [v2base] ──
            #    与 V1 base 完全对称：透明黑空隙 + V2 片段 + 末尾透明黑 → concat 成一条从 0
            #    覆盖到 total_duration 的完整视频流，保证 overlay 两路输入帧始终对齐（不会缺帧停顿）。
            #    空隙用透明黑(alpha=0)、V2 片段转 yuva420p(不透明)；
            #    最后 [v1base][v2base]overlay 走 alpha 合成：V2 片段所在 X 窗口自然覆盖 V1，
            #    其余时段 V2 全透明 → V1 完整透出，互不裁剪。
            #    ⚠️ 不用 overlay 的 enable 表达式：其 t 取第 2 路输入(overlay)自身 PTS，而 V2 片段
            #       setpts 从 0 起算，enable='between(t,tls,tle)' 永远不会命中，V2 会完全不显示。
            norm_video_v2.sort(key=lambda c: c['tlStart'])
            v2_prev_end = 0.0
            v2_labels = []
            for clip in norm_video_v2:
                curr_start = max(0.0, float(clip['tlStart']))
                dur_clip = clip['end'] - clip['start']
                if curr_start + 0.001 >= total_duration or dur_clip <= 0:
                    continue  # 完全在总时长之后 / 无时长，忽略
                # V2 空隙：透明黑（alpha=0），overlay 时完全不遮挡 V1
                if curr_start > v2_prev_end + 0.01:
                    gap = curr_start - v2_prev_end
                    filter_parts.append(
                        f"color=black:s={base_w}x{base_h}:d={gap:.3f}:r={base_fps_str},"
                        f"setsar=1,format=rgba,colorchannelmixer=aa=0,format=yuva420p[v{v_idx}]"
                    )
                    v2_labels.append(f"[v{v_idx}]")
                    v_idx += 1
                # V2 片段（带 alpha，支持裁剪/大小/移动/透明度）
                key = f"{clip['filename']}|{clip['type']}"
                src_idx = source_map[key]
                s, e = clip['start'], clip['end']
                is_img = _is_image_file(clip['filename'])
                xf = _vid_transform(clip, base_w, base_h)
                op = _vid_opacity(clip)
                fmt_tail = op if op else "format=yuva420p"
                if is_img:
                    filter_parts.append(
                        f"[{src_idx}:v:0]loop=loop=-1:size=1:start=0,"
                        f"trim=duration={dur_clip:.3f},setpts=PTS-STARTPTS,"
                        f"{xf},"
                        f"fps={base_fps_str},setsar=1,{fmt_tail}[v{v_idx}]"
                    )
                else:
                    filter_parts.append(
                        f"[{src_idx}:v:0]trim=start={s:.3f}:end={e:.3f},setpts=PTS-STARTPTS,"
                        f"{xf},"
                        f"fps={base_fps_str},setsar=1,{fmt_tail}[v{v_idx}]"
                    )
                v2_labels.append(f"[v{v_idx}]")
                v_idx += 1
                v2_prev_end = curr_start + dur_clip
            # V2 末尾补齐透明黑到总时长
            if total_duration > v2_prev_end + 0.01:
                gap = total_duration - v2_prev_end
                filter_parts.append(
                    f"color=black:s={base_w}x{base_h}:d={gap:.3f}:r={base_fps_str},"
                    f"setsar=1,format=rgba,colorchannelmixer=aa=0,format=yuva420p[v{v_idx}]"
                )
                v2_labels.append(f"[v{v_idx}]")
                v_idx += 1
            # V2 全部 concat → [v2base]
            if v2_labels:
                filter_parts.append(f"{''.join(v2_labels)}concat=n={len(v2_labels)}:v=1:a=0[v2base]")
                if base_layer:
                    # V1(不透明) 打底 + V2(带 alpha) 叠加：alpha 合成，V2 只在片段窗口覆盖 V1
                    filter_parts.append(f"{base_layer}[v2base]overlay=x=0:y=0:format=auto:eof_action=pass[v{v_idx}]")
                    base_layer = f"[v{v_idx}]"
                    v_idx += 1
                else:
                    # 没有 V1 时先建整段不透明黑屏做底，再叠 V2（透明区最终显黑）
                    filter_parts.append(
                        f"color=black:s={base_w}x{base_h}:d={total_duration:.3f}:r={base_fps_str},"
                        f"fps={base_fps_str},setsar=1,format=yuv420p[v{v_idx}]"
                    )
                    base_layer = f"[v{v_idx}]"
                    v_idx += 1
                    filter_parts.append(f"{base_layer}[v2base]overlay=x=0:y=0:format=auto:eof_action=pass[v{v_idx}]")
                    base_layer = f"[v{v_idx}]"
                    v_idx += 1
            # 把最终 base_layer 作为视频输出 concat 片段加入 v_labels
            if base_layer:
                v_labels.append(base_layer)

    # ── 音频轨：按轨道独立生成完整时间线，最后 amix 混音（剪辑软件逻辑，互不裁剪） ──
    #
    # 共四条可能的音频源：
    #   a1  : 独立音频轨（track=a1 的 norm_audio），整条 total_duration
    #   a2  : 独立音频轨（track=a2 的 norm_audio），整条 total_duration
    #   av1 : 从 V1 视频片段提音频（has_audio=True 的 norm_video_v1），整条 total_duration
    #   av2 : 从 V2 视频片段提音频（has_audio=True 的 norm_video_v2），整条 total_duration
    # 每条源单独生成 total_duration 长的完整音频流；有几条 amix 几条；一条没有则 anullsrc 补静音。
    #
    # 为了便于复用，先写一个 inline 生成"单条音频轨完整流"的小函数：
    #   build_full_audio(clips, get_has_audio, extract_audio)
    #     - clips 是按 tlStart 已排好序、带 tlStart/start/end 的片段列表（可能为空）
    #     - get_has_audio(clip) -> bool；extract_audio(clip) -> 生成带 atrim 的 ffmpeg filter 链尾部标签
    #     - 返回最终整条音频的 pad label；如果整轨完全没内容，返回 None
    # （这里为了避免 Python 闭包对 filter_parts/a_idx 副作用问题，直接 inline 生成四条。）

    mixed_audio_inputs = []  # 每个元素为 "[aN]" 标签，用于最后 amix
    # 统一音频格式：amix 与 concat 都严格要求所有输入通道/采样率/采样格式一致
    AUDIO_FMT = "aformat=sample_fmts=fltp:channel_layouts=stereo:sample_rates=44100"

    def _build_full_audio_from_clips(clips, has_audio_predicate, extract_audio_filter):
        """生成单条总时长 total_duration 的完整音频 pad label；若无任何内容返回 None。
        两遍扫描：先检查是否有真音频，有才生成 filter 链，避免在 filter_parts 中留下孤立 label。
        """
        nonlocal a_idx
        # 第一遍：检查是否有真音频
        has_real_audio = any(has_audio_predicate(c) for c in clips)
        if not has_real_audio:
            # 整条轨只有静音 → 丢弃，不写入任何 filter
            return None
        # 第二遍：有真音频，生成完整 filter 链
        local_labels = []
        prev_end = 0.0
        for clip in clips:
            curr_start = float(clip['tlStart'])
            dur = float(clip['end'] - clip['start'])
            # 前置静音
            if curr_start > prev_end + 0.01:
                gap = curr_start - prev_end
                lbl = f"[a{a_idx}]"
                filter_parts.append(
                    f"anullsrc=channel_layout=stereo:sample_rate=44100:duration={gap:.3f},"
                    f"{AUDIO_FMT}{lbl}"
                )
                local_labels.append(lbl)
                a_idx += 1
                prev_end = curr_start
            if has_audio_predicate(clip):
                lbl = f"[a{a_idx}]"
                key = f"{clip['filename']}|{clip['type']}"
                src_idx = source_map[key]
                s, e = float(clip['start']), float(clip['end'])
                # 音量（volume，0~2）
                vol = float(clip.get('volume', 1.0))
                vol = max(0.0, min(2.0, vol))
                vol_tail = f"volume={vol:g}," if abs(vol - 1.0) > 0.001 else ""
                filter_parts.append(
                    f"[{src_idx}:a:0]atrim=start={s:.3f}:end={e:.3f},asetpts=PTS-STARTPTS,"
                    f"{vol_tail}{AUDIO_FMT}{lbl}"
                )
                local_labels.append(lbl)
                a_idx += 1
            else:
                # 无音频：该片段时长用静音占位，保证轨内对齐
                lbl = f"[a{a_idx}]"
                filter_parts.append(
                    f"anullsrc=channel_layout=stereo:sample_rate=44100:duration={dur:.3f},"
                    f"{AUDIO_FMT}{lbl}"
                )
                local_labels.append(lbl)
                a_idx += 1
            prev_end = curr_start + dur
        # 末尾补齐静音到 total_duration
        if float(total_duration) > prev_end + 0.01:
            gap = float(total_duration) - prev_end
            lbl = f"[a{a_idx}]"
            filter_parts.append(
                f"anullsrc=channel_layout=stereo:sample_rate=44100:duration={gap:.3f},"
                f"{AUDIO_FMT}{lbl}"
            )
            local_labels.append(lbl)
            a_idx += 1
        n = len(local_labels)
        if n <= 0:
            return None
        if n == 1:
            return local_labels[0]
        concat_lbl = f"[a{a_idx}]"
        a_idx += 1
        filter_parts.append(f"{''.join(local_labels)}concat=n={n}:v=0:a=1,{AUDIO_FMT}{concat_lbl}")
        return concat_lbl

    # ① 独立音频轨 a1 (track=a1)
    a1_clips = sorted([c for c in norm_audio if c['track'] == 'a1'], key=lambda c: c['tlStart'])
    a1_label = _build_full_audio_from_clips(
        a1_clips,
        has_audio_predicate=lambda c: True,  # 独立音频片段本身就是音频
        extract_audio_filter=None,
    )
    if a1_label:
        mixed_audio_inputs.append(a1_label)

    # ② 独立音频轨 a2 (track=a2)
    a2_clips = sorted([c for c in norm_audio if c['track'] == 'a2'], key=lambda c: c['tlStart'])
    a2_label = _build_full_audio_from_clips(
        a2_clips,
        has_audio_predicate=lambda c: True,
        extract_audio_filter=None,
    )
    if a2_label:
        mixed_audio_inputs.append(a2_label)

    # ③ 从 V1 视频片段提音频 av1（只有带 has_audio 的片段才贡献真音频）
    av1_clips = sorted([c for c in norm_video_v1], key=lambda c: c['tlStart'])
    av1_label = _build_full_audio_from_clips(
        av1_clips,
        has_audio_predicate=lambda c: bool(c.get('has_audio', False)),
        extract_audio_filter=None,
    )
    if av1_label:
        mixed_audio_inputs.append(av1_label)

    # ④ 从 V2 视频片段提音频 av2
    av2_clips = sorted([c for c in norm_video_v2], key=lambda c: c['tlStart'])
    av2_label = _build_full_audio_from_clips(
        av2_clips,
        has_audio_predicate=lambda c: bool(c.get('has_audio', False)),
        extract_audio_filter=None,
    )
    if av2_label:
        mixed_audio_inputs.append(av2_label)

    # concat 视频轨（视频始终 1 条输出 [outv]，v_labels 里一般只有 base_layer 这 1 个 label）
    n_v = len(v_labels)
    # audio_only 且无音频轨不可能走到这（前面有校验），这里只做分支
    if not audio_only:
        if n_v <= 0:
            raise Exception("视频输出未生成（v_labels 为空）")
        if n_v == 1:
            # 单段：直接作为 outv，避免 concat 空跑（去掉 alpha，兼容编码器）
            filter_parts.append(f"{v_labels[0]}format=yuv420p[outv]")
        else:
            filter_parts.append(f"{''.join(v_labels)}concat=n={n_v}:v=1:a=0,format=yuv420p[outv]")

    # ── 音频最终输出：多轨 amix；一轨都没有 → 静音兜底 / 纯音频模式报错 ──
    if len(mixed_audio_inputs) == 0:
        if audio_only:
            raise Exception("音频轨无任何音频来源，无法仅导出音频。")
        # 视频模式无任何音频：补一条完整时间的静音（保证 -map [outa] 一致）
        any_audio = False
        if not audio_only:
            lbl = f"[a{a_idx}]"
            filter_parts.append(
                f"anullsrc=channel_layout=stereo:sample_rate=44100:duration={total_duration:.3f},"
                f"{AUDIO_FMT}{lbl}"
            )
            a_idx += 1
            mixed_audio_inputs.append(lbl)
            any_audio = True  # 有静音占位，仍然输出 [outa]
    else:
        any_audio = True

    if any_audio and len(mixed_audio_inputs) > 0:
        if len(mixed_audio_inputs) == 1:
            filter_parts.append(f"{mixed_audio_inputs[0]}{AUDIO_FMT}[outa]")
        else:
            # amix：duration=first 以首条 total_duration 长的轨为基准；
            # 不使用 normalize=0（部分旧版 ffmpeg 不支持），默认 1/n 归一化避免爆音。
            n_in = len(mixed_audio_inputs)
            filter_parts.append(
                f"{''.join(mixed_audio_inputs)}amix=inputs={n_in}:duration=first:dropout_transition=0,"
                f"{AUDIO_FMT}[outa]"
            )

    # ── 编码器与 map 参数：视频模式 / 纯音频模式分支 ──
    if audio_only:
        # 纯音频：仅 map 音频，不用视频编码器；format 在 mp3/flac/wav 之间切换
        audio_format = audio_format if audio_format in ("mp3", "flac", "wav") else "mp3"
        AUDIO_FORMATS = {
            "mp3":  {"encoder": "libmp3lame", "extension": "mp3"},
            "wav":  {"encoder": "pcm_s16le",   "extension": "wav"},
            "flac": {"encoder": "flac",       "extension": "flac"},
        }
        fmt_info = AUDIO_FORMATS[audio_format]
        cmd += ["-filter_complex", ";".join(filter_parts),
                "-map", "[outa]",
                "-c:a", fmt_info["encoder"]]
        # MP3 → bitrate；FLAC → compression_level 5；WAV → 无损（无额外参数）
        if audio_format == "mp3":
            try:
                br = max(16, min(320, int(audio_bitrate)))
            except (TypeError, ValueError):
                br = 128
            cmd += ["-b:a", f"{br}k"]
        elif audio_format == "flac":
            cmd += ["-compression_level", "5"]
        out_ext = fmt_info["extension"]
    else:
        # 调试：打印完整 filter_complex，便于排查透明度/裁剪/移动/大小/音量
        fc_str = ";".join(filter_parts)
        print("[小珠光-调试] filter_complex:")
        print(fc_str)
        cmd += ["-filter_complex", fc_str,
                "-map", "[outv]"]
        if any_audio:
            cmd += ["-map", "[outa]",
                    "-c:a", "aac", "-b:a", "128k"]
        # 编码器：优先 NVENC 硬编（大幅提速），否则 libx264 veryfast
        q_map = {"high": 10, "medium": 20, "low": 28}
        q_val = q_map.get(quality, 20)
        if _xzg_ve_nvenc_available():
            cmd += ["-c:v", "h264_nvenc", "-preset", "p4", "-cq", str(q_val), "-pix_fmt", "yuv420p"]
        else:
            cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", str(q_val), "-pix_fmt", "yuv420p"]
        out_ext = "mp4"

    # ═══════════════════════════════════════════════════════════════════
    # 输出目录 + 文件名（与小珠光图像保存-化神级完全一致）
    # ═══════════════════════════════════════════════════════════════════
    if use_default_output:
        # 默认输出：ComfyUI output 目录，前缀固定 xzg-edit，_ 分隔
        out_dir = folder_paths.get_output_directory()
        out_type = "output"
        resolved_prefix = "xzg-edit"
        prefix_sep = "_"
        out_subfolder_rel = ""
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
        resolved_base = _xzg_sanitize_path(base_dir or "")
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
        safe_out = f"{resolved_prefix}{prefix_sep}{counter:04d}.{out_ext}"
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
    # out_subfolder_rel 是 custom 模式下相对 output/ 的子目录（default/saveas 为空）
    # 与 extract_frame 保持一致：若 out_dir != output_root（或绝对路径），safe_out 前面拼子目录
    if out_type != "absolute" and out_subfolder_rel:
        rel_prefix = out_subfolder_rel.replace("\\", "/").rstrip("/")
        safe_out_rel = f"{rel_prefix}/{safe_out}"
    else:
        safe_out_rel = safe_out
    extra = {
        "audio_only": bool(audio_only),
        "audio_format": audio_format if audio_only else None,
        "video": not audio_only,
        "extension": out_ext,
        # 子目录信息（前端下载 URL 构造要区分 subfolder / basename）
        "subfolder": out_subfolder_rel,
        "basename": safe_out,
    }
    return safe_out_rel, out_type, extra


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
        # 输出设置（仅 small=False 导出帧时使用；small=True 缩略图忽略，固定走 input 缓存）
        use_default_output = bool(data.get("use_default_output", True))
        base_dir = data.get("base_dir", "")
        filename_prefix = data.get("filename_prefix", "xzg-edit")
        add_date_stamp = bool(data.get("add_date_stamp", False))
        add_time_stamp = bool(data.get("add_time_stamp", False))
        out_name, out_type, out_subfolder = extract_frame(
            filename, file_type, time_sec, small,
            use_default_output=use_default_output,
            base_dir=base_dir,
            filename_prefix=filename_prefix,
            add_date_stamp=add_date_stamp,
            add_time_stamp=add_time_stamp,
        )
        return web.json_response({
            "filename": out_name,
            "subfolder": out_subfolder,
            "type": out_type,
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
        output_mode = data.get("output_mode", "default")  # default / saveas / custom
        use_default_output = data.get("use_default_output", True)
        base_dir = data.get("base_dir", "")
        filename_prefix = data.get("filename_prefix", "xzg-edit")
        add_date_stamp = data.get("add_date_stamp", False)
        add_time_stamp = data.get("add_time_stamp", False)
        # 纯音频导出
        audio_only = bool(data.get("audio_only", False))
        audio_format = data.get("audio_format", "mp3")   # mp3 / flac / wav
        audio_bitrate = data.get("audio_bitrate", "128")  # 320 / 192 / 128（kbps，仅 mp3 生效）
        # default / saveas 都走 use_default_output=true；saveas 仅前端触发下载对话框
        print(f"[小珠光快剪] 导出模式: {output_mode}, use_default_output={use_default_output}, audio_only={audio_only}, audio_format={audio_format}")
        out_name, out_type, extra = render_timeline(
            timeline, output_name, target_w, target_h, target_fps, quality,
            use_default_output, base_dir, filename_prefix, add_date_stamp, add_time_stamp,
            audio_only=audio_only, audio_format=audio_format, audio_bitrate=audio_bitrate,
        )
        resp = {
            "filename": out_name,
            "type": out_type,
            "clips_count": len(timeline),
            "output_mode": output_mode,
        }
        # 把 extra 信息一并返回（audio_only / audio_format / video / extension / subfolder / basename）
        if isinstance(extra, dict):
            resp.update(extra)
        return web.json_response(resp)

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

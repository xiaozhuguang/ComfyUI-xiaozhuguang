"""
小珠光视频加载器
参考 Video Helper Suite 的 LoadVideoFFmpegUpload 节点，使用 FFmpeg 解码视频帧
支持视频上传、视频文件选择、强制帧率、自定义宽高、帧数上限、起始时间等
"""

import os
import subprocess
import re
import time
import hashlib
import numpy as np
import torch
import folder_paths
from comfy.utils import ProgressBar

VIDEO_EXTENSIONS = {'webm', 'mp4', 'mkv', 'gif', 'mov', 'avi', 'flv', 'wmv', 'm4v', 'mpg', 'mpeg', 'ts'}

BIGMAX = int(1e9)
DIMMAX = 16384
ENCODE_ARGS = ['utf-8', 'replace']


def ffmpeg_suitability(path):
    try:
        version = subprocess.run([path, "-version"], check=True,
                                 capture_output=True).stdout.decode(*ENCODE_ARGS)
    except:
        return 0
    score = 0
    simple_criterion = [("libvpx", 20), ("264", 10), ("265", 3),
                        ("svtav1", 5), ("libopus", 1)]
    for criterion in simple_criterion:
        if version.find(criterion[0]) >= 0:
            score += criterion[1]
    copyright_index = version.find('2000-2')
    if copyright_index >= 0:
        try:
            score += int(version[copyright_index + 5:copyright_index + 9]) // 10
        except:
            pass
    return score


def _get_ffmpeg_path():
    import shutil
    
    if "VHS_FORCE_FFMPEG_PATH" in os.environ:
        return os.environ.get("VHS_FORCE_FFMPEG_PATH")
    
    ffmpeg_paths = []
    try:
        from imageio_ffmpeg import get_ffmpeg_exe
        imageio_ffmpeg_path = get_ffmpeg_exe()
        ffmpeg_paths.append(imageio_ffmpeg_path)
    except:
        pass
    
    if "VHS_USE_IMAGEIO_FFMPEG" in os.environ:
        return imageio_ffmpeg_path
    
    system_ffmpeg = shutil.which("ffmpeg")
    if system_ffmpeg is not None:
        ffmpeg_paths.append(system_ffmpeg)
    
    if os.path.isfile("ffmpeg"):
        ffmpeg_paths.append(os.path.abspath("ffmpeg"))
    if os.path.isfile("ffmpeg.exe"):
        ffmpeg_paths.append(os.path.abspath("ffmpeg.exe"))
    
    comfyui_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
    ffmpeg_bin = os.path.join(comfyui_dir, "ffmpeg", "bin")
    if os.path.isdir(ffmpeg_bin):
        if os.path.isfile(os.path.join(ffmpeg_bin, "ffmpeg.exe")):
            ffmpeg_paths.append(os.path.join(ffmpeg_bin, "ffmpeg.exe"))
        elif os.path.isfile(os.path.join(ffmpeg_bin, "ffmpeg")):
            ffmpeg_paths.append(os.path.join(ffmpeg_bin, "ffmpeg"))
    
    if len(ffmpeg_paths) == 0:
        print("[小珠光视频加载器] No valid ffmpeg found.")
        return None
    elif len(ffmpeg_paths) == 1:
        return ffmpeg_paths[0]
    else:
        return max(ffmpeg_paths, key=ffmpeg_suitability)


ffmpeg_path = _get_ffmpeg_path()


_ffmpeg_major_version = None


def _get_ffmpeg_major_version():
    """获取 FFmpeg 主版本号（缓存），失败返回 0。"""
    global _ffmpeg_major_version
    if _ffmpeg_major_version is not None:
        return _ffmpeg_major_version
    if ffmpeg_path is None:
        _ffmpeg_major_version = 0
        return 0
    try:
        result = subprocess.run(
            [ffmpeg_path, "-version"],
            capture_output=True, timeout=10
        )
        output = (result.stdout + result.stderr).decode(*ENCODE_ARGS)
        match = re.search(r"ffmpeg version (\d+)", output)
        if match:
            _ffmpeg_major_version = int(match.group(1))
        else:
            _ffmpeg_major_version = 0
    except Exception:
        _ffmpeg_major_version = 0
    return _ffmpeg_major_version


def float_or_int(value, default=0):
    try:
        if isinstance(value, bool):
            return int(value)
        f = float(value)
        if f.is_integer():
            return int(f)
        return f
    except (TypeError, ValueError):
        return default


def calculate_file_hash(filepath):
    try:
        mtime = os.path.getmtime(filepath)
        fsize = os.path.getsize(filepath)
        h = hashlib.md5()
        h.update(f"{filepath}|{mtime}|{fsize}".encode("utf-8"))
        return h.hexdigest()
    except Exception:
        return "0"


AUDIO_SAMPLE_RATE = 44100


def extract_audio(video, start_time=0.0, duration=None, sample_rate=AUDIO_SAMPLE_RATE):
    """用 FFmpeg 从视频中提取音频，返回 (waveform_tensor, sample_rate)。
    waveform 形状: [channels, samples]，float32，范围 [-1, 1]。
    无音轨时返回 (None, sample_rate)。
    """
    if start_time < 0:
        start_time = 0.0

    args = [ffmpeg_path, "-v", "error", "-vn"]
    if start_time > 0:
        if start_time > 4:
            args += ["-ss", str(start_time - 4), "-i", video, "-ss", "4"]
        else:
            args += ["-ss", str(start_time), "-i", video]
    else:
        args += ["-i", video]

    if duration is not None and duration > 0:
        args += ["-t", str(duration)]

    args += [
        "-ac", "2",
        "-ar", str(sample_rate),
        "-f", "f32le",
        "-",
    ]

    try:
        proc = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=600)
    except Exception as e:
        print(f'[小珠光视频加载器] 音频提取失败: {e}')
        return None, sample_rate

    if proc.returncode != 0:
        err = proc.stderr.decode(*ENCODE_ARGS)
        if "does not contain any stream" in err or "Invalid data found" in err or "match: No such file" in err:
            return None, sample_rate
        print(f'[小珠光视频加载器] 音频提取警告 (rc={proc.returncode}): {err[:500]}')
        return None, sample_rate

    raw = proc.stdout
    if not raw or len(raw) < 4:
        return None, sample_rate

    audio_np = np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).T
    audio_np = np.clip(audio_np, -1.0, 1.0)
    waveform = torch.from_numpy(audio_np.astype(np.float32))
    return waveform, sample_rate


def target_size(width, height, custom_width, custom_height, downscale_ratio=8):
    if downscale_ratio is None:
        downscale_ratio = 8
    if custom_width == 0 and custom_height == 0:
        pass
    elif custom_height == 0:
        height *= custom_width / width
        width = custom_width
    elif custom_width == 0:
        width *= custom_height / height
        height = custom_height
    else:
        width = custom_width
        height = custom_height
    width = int(width / downscale_ratio + 0.5) * downscale_ratio
    height = int(height / downscale_ratio + 0.5) * downscale_ratio
    return width, height


def _build_framerate_filters(force_rate, source_fps):
    """构建帧率转换滤镜，使用与达芬奇时间线相同的 Bresenham floor 映射算法。

    达芬奇算法（通过实测验证）：
      输出的第 k 帧 = floor(k × source_fps / target_fps)

    降帧（src > dst）用 ffmpeg select 滤镜实现（已通过测试验证）：
      30→24: 丢弃第 5/10/15/20/25/30 帧
      60→24: 保留 0,2,5,7,10,12,15,17,20,22,25,27...
      25→24: 丢弃第 25/50/75... 帧
      60→30: 保留偶数帧（0,2,4,...）

    升帧（src < dst）返回空滤镜，由 Python 端按 floor(k*src/dst) 缓存前一帧 yield：
      24→25: 第1帧重复一次（0,0,1,2,...,23）

    Args:
        force_rate: 目标帧率（0 表示不转换）
        source_fps: 源视频帧率
    Returns:
        tuple: (filters: list[str], is_upscale: bool)
    """
    from math import gcd

    if force_rate <= 0:
        return [], False
    if source_fps <= 0:
        return [f"fps=fps={force_rate}"], False

    # 升帧：返回空滤镜，由 Python 端处理帧复制
    if force_rate > source_fps:
        return [], True

    # 等帧率：直通
    if force_rate == source_fps:
        return [], False

    # 降帧：用 select + Bresenham floor 映射
    # 仅处理整数帧率；非整数帧率（如 29.97）回退 fps 滤镜
    if source_fps != int(source_fps) or force_rate != int(force_rate):
        return [f"fps=fps={force_rate}:round=down"], False

    src = int(source_fps)
    dst = int(force_rate)
    g = gcd(src, dst)
    p = src // g  # 周期长度
    q = dst // g  # 每周期保留帧数

    # 周期过长 → 回退 fps 滤镜
    if p > 120:
        return [f"fps=fps={force_rate}:round=down"], False

    # Bresenham/floor 映射：周期内保留的位置集合
    keep_positions = sorted(set(int(k * p / q) for k in range(q)))
    pos_exprs = [f"eq(mod(n\\,{p})\\,{pos})" for pos in keep_positions]
    select_expr = "+".join(pos_exprs)
    return [f"select={select_expr}"], False



def ffmpeg_frame_generator(video, force_rate, frame_load_cap, skip_frames,
                           custom_width, custom_height, downscale_ratio=8,
                           aspect_ratio=None, ratio_mode=1, ratio_dim=0):
    args_input = ["-i", video]
    args_dummy = [ffmpeg_path] + args_input + ['-c', 'copy', '-frames:v', '1', "-f", "null", "-"]
    size_base = None
    fps_base = None
    alpha = False
    try:
        dummy_res = subprocess.run(args_dummy, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.PIPE, check=True)
    except subprocess.CalledProcessError as e:
        raise Exception("FFmpeg probe failed:\n" + e.stderr.decode(*ENCODE_ARGS))
    lines = dummy_res.stderr.decode(*ENCODE_ARGS)

    if "Video: vp9 " in lines:
        args_input = ["-c:v", "libvpx-vp9"] + args_input
        args_dummy = [ffmpeg_path] + args_input + ['-c', 'copy', '-frames:v', '1', "-f", "null", "-"]
        try:
            dummy_res = subprocess.run(args_dummy, stdout=subprocess.DEVNULL,
                                       stderr=subprocess.PIPE, check=True)
        except subprocess.CalledProcessError as e:
            raise Exception("FFmpeg probe vp9 failed:\n" + e.stderr.decode(*ENCODE_ARGS))
        lines = dummy_res.stderr.decode(*ENCODE_ARGS)

    for line in lines.split('\n'):
        match = re.search(r"^ *Stream .* Video.*, ([1-9]|\d{2,})x(\d+)", line)
        if match is not None:
            size_base = [int(match.group(1)), int(match.group(2))]
            fps_match = re.search(r", ([\d\.]+) fps", line)
            if fps_match:
                fps_base = float(fps_match.group(1))
            else:
                fps_base = 1.0
            alpha = re.search(r"(yuva|rgba|bgra|gbra)", line) is not None
            break
    else:
        raise Exception("Failed to parse video info. FFmpeg output:\n" + lines)

    durs_match = re.search(r"Duration: (\d+:\d+:\d+\.\d+),", lines)
    if durs_match:
        durs = durs_match.group(1).split(':')
        duration = int(durs[0]) * 3600 + int(durs[1]) * 60 + float(durs[2])
    else:
        duration = 0.0

    # 将跳过帧数转换为起始时间（基于源视频帧率）
    start_time = skip_frames / fps_base if fps_base > 0 else 0.0

    if start_time > 0:
        if start_time > 4:
            post_seek = ['-ss', '4']
            args_input = ['-ss', str(start_time - 4)] + args_input
        else:
            post_seek = ['-ss', str(start_time)]
    else:
        post_seek = []

    args_all_frames = [ffmpeg_path, "-v", "error", "-an"] + args_input + ["-pix_fmt", "rgba64le"] + post_seek

    # 应用视频比例约束（自定义比例时跳过）
    if aspect_ratio and aspect_ratio != "自定义比例":
        _ratio_map = {
            "原始比例": None,  # 从源视频计算
            "竖屏9:16": 9 / 16,
            "竖屏3:4": 3 / 4,
            "横屏16:9": 16 / 9,
            "横屏4:3": 4 / 3,
            "等比1:1": 1.0,
        }
        _ratio = _ratio_map.get(aspect_ratio)
        if _ratio is None and aspect_ratio == "原始比例":
            _ratio = size_base[0] / size_base[1]
        if _ratio is not None:
            # ratio_mode: 1=长边, 2=短边, 3=宽度, 4=高度
            if ratio_mode == 1:  # 长边
                if _ratio >= 1.0:  # 横屏，宽为长边
                    custom_width = ratio_dim if ratio_dim > 0 else max(size_base[0], size_base[1])
                    custom_height = custom_width / _ratio
                else:  # 竖屏，高为长边
                    custom_height = ratio_dim if ratio_dim > 0 else max(size_base[0], size_base[1])
                    custom_width = custom_height * _ratio
            elif ratio_mode == 2:  # 短边
                if _ratio >= 1.0:  # 横屏，高为短边
                    custom_height = ratio_dim if ratio_dim > 0 else min(size_base[0], size_base[1])
                    custom_width = custom_height * _ratio
                else:  # 竖屏，宽为短边
                    custom_width = ratio_dim if ratio_dim > 0 else min(size_base[0], size_base[1])
                    custom_height = custom_width / _ratio
            elif ratio_mode == 3:  # 宽度
                custom_width = ratio_dim if ratio_dim > 0 else size_base[0]
                custom_height = custom_width / _ratio
            elif ratio_mode == 4:  # 高度
                custom_height = ratio_dim if ratio_dim > 0 else size_base[1]
                custom_width = custom_height * _ratio

    vfilters = []
    # 帧率转换（与达芬奇相同的 Bresenham floor 映射）
    fr_filters, is_upscale = _build_framerate_filters(force_rate, fps_base)
    vfilters.extend(fr_filters)
    if custom_width != 0 or custom_height != 0:
        size = target_size(size_base[0], size_base[1], custom_width,
                           custom_height, downscale_ratio=downscale_ratio)
        src_ar = size_base[0] / size_base[1]
        dst_ar = size[0] / size[1]
        if abs(src_ar - dst_ar) < 0.01:
            # 宽高比一致 → 仅缩放
            vfilters.append(f"scale={size[0]}:{size[1]}")
        else:
            # 宽高比不同 → 缩放到覆盖目标比例后裁剪（无黑边填充）
            vfilters.append(f"scale={size[0]}:{size[1]}:force_original_aspect_ratio=increase")
            vfilters.append(f"crop={size[0]}:{size[1]}")
        vfilters.append("setsar=1")
    else:
        size = size_base

    if len(vfilters) > 0:
        args_all_frames += ["-vf", ",".join(vfilters)]

    # 用源帧数推导目标帧数，避免 ffmpeg duration 浮点精度误差
    # ffmpeg 报告的 duration 可能有偏差（如 30/16=1.875 报为 1.88），导致帧数多/少 1
    # 正确方式：source_frames = round(fps_base × duration)，再按比例计算目标帧数
    source_frame_count = round(fps_base * duration) if fps_base > 0 else 0
    if force_rate and fps_base > 0:
        yieldable_frames = source_frame_count * force_rate / fps_base
    else:
        yieldable_frames = source_frame_count
    if frame_load_cap > 0:
        yieldable_frames = min(yieldable_frames, frame_load_cap)

    # 降帧时始终限制输出帧数到 floor(源帧数 × 目标帧率/源帧率)
    # select 滤镜按周期模式匹配，可能输出超出时长的帧（如 60fps 30帧→25fps 应12帧，select 输出13帧）
    if not is_upscale:
        args_all_frames += ["-frames:v", str(int(yieldable_frames))]

    yield (size_base[0], size_base[1], fps_base, duration, fps_base * duration,
           1.0 / (force_rate or fps_base), yieldable_frames, size[0], size[1], alpha)

    # 降帧时使用 passthrough 同步：FFmpeg >= 7 用 -fps_mode，< 7 用 -vsync
    if not is_upscale:
        if _get_ffmpeg_major_version() >= 7:
            args_all_frames += ["-fps_mode", "passthrough"]
        else:
            args_all_frames += ["-vsync", "0"]
    args_all_frames += ["-f", "rawvideo", "-"]

    pbar = ProgressBar(int(yieldable_frames)) if yieldable_frames > 0 else None
    frames_added = 0

    try:
        with subprocess.Popen(args_all_frames, stdout=subprocess.PIPE) as proc:
            bpi = size[0] * size[1] * 8

            def _read_one_frame():
                """从 ffmpeg stdout 读取一帧，返回 numpy 数组或 None（EOF）"""
                buf = bytearray(bpi)
                off = 0
                while off < bpi:
                    chunk = proc.stdout.read(bpi - off)
                    if not chunk:
                        return None
                    buf[off:off + len(chunk)] = chunk
                    off += len(chunk)
                frame = np.frombuffer(buf, dtype=np.dtype(np.uint16).newbyteorder("<")
                                      ).reshape(size[1], size[0], 4) / 65535.0
                if not alpha:
                    frame = frame[:, :, :-1]
                return frame

            if is_upscale:
                # 升帧：按 floor(k * src/dst) 选择/复制帧（与达芬奇一致）
                # 24→25: [0,0,1,2,...,23]（第1帧重复）
                src_n = 0
                prev_frame = None
                for k in range(int(yieldable_frames)):
                    target = int(k * fps_base / force_rate)  # floor(k * src/dst)
                    # 读取直到 src_n > target，确保 prev_frame 是 target 帧数据
                    while src_n <= target:
                        prev_frame = _read_one_frame()
                        if prev_frame is None:
                            break
                        src_n += 1
                    if prev_frame is None:
                        break
                    yield prev_frame
                    frames_added += 1
                    if pbar is not None:
                        pbar.update_absolute(frames_added, int(yieldable_frames))
            else:
                # 降帧/直通：select 滤镜已选择帧，直接 yield
                current_bytes = bytearray(bpi)
                current_offset = 0
                prev_frame = None
                while True:
                    bytes_read = proc.stdout.read(bpi - current_offset)
                    if bytes_read is None:
                        time.sleep(.05)
                        continue
                    if len(bytes_read) == 0:
                        break
                    current_bytes[current_offset:len(bytes_read)] = bytes_read
                    current_offset += len(bytes_read)
                    if current_offset == bpi:
                        if prev_frame is not None:
                            yield prev_frame
                            frames_added += 1
                            if pbar is not None:
                                pbar.update_absolute(frames_added, int(yieldable_frames))
                        prev_frame = np.frombuffer(current_bytes,
                                                   dtype=np.dtype(np.uint16).newbyteorder("<")
                                                   ).reshape(size[1], size[0], 4) / 65535.0
                        if not alpha:
                            prev_frame = prev_frame[:, :, :-1]
                        current_offset = 0
                if prev_frame is not None:
                    yield prev_frame
                    frames_added += 1
                    if pbar is not None:
                        pbar.update_absolute(frames_added, int(yieldable_frames))
    except BrokenPipeError:
        try:
            err = proc.stderr.read().decode(*ENCODE_ARGS)
        except Exception:
            err = ""
        raise Exception("FFmpeg read error:\n" + err)


class XiaozhuguangVideoLoader:
    """
    小珠光视频加载器
    使用 FFmpeg 解码视频为帧序列，支持上传文件、选择输入目录视频
    """

    @classmethod
    def INPUT_TYPES(cls):
        input_dir = folder_paths.get_input_directory()
        files = []
        try:
            if os.path.isdir(input_dir):
                for f in os.listdir(input_dir):
                    fp = os.path.join(input_dir, f)
                    if os.path.isfile(fp):
                        ext = os.path.splitext(f)[1].lower().lstrip('.')
                        if ext in VIDEO_EXTENSIONS:
                            files.append(f)
        except Exception:
            pass
        return {
            "required": {
                "视频": (sorted(files),),
                "强制帧率": ("FLOAT", {"default": 0, "min": 0, "max": 240, "step": 0.001}),
                "视频比例": (["自定义比例", "原始比例", "竖屏9:16", "竖屏3:4", "横屏16:9", "横屏4:3", "等比1:1"], {"default": "自定义比例"}),
                "自定义宽度": ("INT", {"default": 0, "min": 0, "max": DIMMAX, "step": 8}),
                "自定义高度": ("INT", {"default": 0, "min": 0, "max": DIMMAX, "step": 8}),
                "跳过帧数": ("INT", {"default": 0, "min": 0, "max": BIGMAX, "step": 1}),
                "帧数上限": ("INT", {"default": 0, "min": 0, "max": BIGMAX, "step": 1}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("IMAGE", "AUDIO", "VHS_VIDEOINFO")
    RETURN_NAMES = ("图像", "音频", "视频信息")
    FUNCTION = "load_video"
    CATEGORY = "xiaozhuguang"
    OUTPUT_NODE = True

    def load_video(self, 视频, 强制帧率=0, 视频比例="原始比例", 自定义宽度=0, 自定义高度=0,
                   帧数上限=0, 跳过帧数=0, unique_id=None):
        强制帧率 = int(强制帧率)
        video_path = folder_paths.get_annotated_filepath(视频)
        if not video_path or not os.path.isfile(video_path):
            raise ValueError(f"Invalid video file: {视频}")

        downscale_ratio = 8

        # 非自定义比例时：自定义宽度作为计算方式(1=长边/2=短边/3=宽度/4=高度)，自定义高度作为边长尺寸
        if 视频比例 != "自定义比例":
            ratio_mode = max(1, min(4, int(自定义宽度 or 1)))
            ratio_dim = max(0, int(自定义高度 or 0))
            cw, ch = 0, 0  # 由比例逻辑接管
        else:
            ratio_mode = 1
            ratio_dim = 0
            cw, ch = 自定义宽度, 自定义高度

        gen = ffmpeg_frame_generator(
            video=video_path,
            force_rate=强制帧率,
            frame_load_cap=帧数上限,
            skip_frames=跳过帧数,
            custom_width=cw,
            custom_height=ch,
            downscale_ratio=downscale_ratio,
            aspect_ratio=视频比例,
            ratio_mode=ratio_mode,
            ratio_dim=ratio_dim,
        )

        info = next(gen)
        (src_w, src_h, src_fps, src_dur, src_frames,
         target_frame_time, yieldable, new_w, new_h, alpha) = info

        frames = []
        try:
            for frame in gen:
                frames.append(frame)
        except StopIteration:
            pass

        if not frames:
            raise RuntimeError("No frames decoded from video")

        channels = 4 if alpha else 3
        image_tensor = torch.from_numpy(
            np.stack(frames).astype(np.float32)
        ).view(-1, new_h, new_w, channels)

        loaded_fps = 1.0 / target_frame_time if target_frame_time > 0 else src_fps
        loaded_count = image_tensor.shape[0]
        loaded_duration = loaded_count * target_frame_time

        audio_start = 跳过帧数 / src_fps if src_fps > 0 else 0.0
        audio_duration = loaded_duration if loaded_duration > 0 else None
        waveform, sr = extract_audio(
            video_path,
            start_time=audio_start,
            duration=audio_duration,
            sample_rate=AUDIO_SAMPLE_RATE,
        )
        if waveform is None or waveform.numel() == 0:
            audio_samples = max(int(AUDIO_SAMPLE_RATE * loaded_duration), 1)
            audio = {
                "waveform": torch.zeros(1, 2, audio_samples, dtype=torch.float32),
                "sample_rate": AUDIO_SAMPLE_RATE,
            }
        else:
            expected_samples = max(int(AUDIO_SAMPLE_RATE * loaded_duration), 1)
            actual_samples = waveform.shape[-1]
            if actual_samples > expected_samples:
                waveform = waveform[..., :expected_samples]
            elif actual_samples < expected_samples:
                pad = expected_samples - actual_samples
                waveform = torch.nn.functional.pad(waveform, (0, pad))
            audio = {
                "waveform": waveform.unsqueeze(0),
                "sample_rate": AUDIO_SAMPLE_RATE,
            }

        video_info = {
            "source_fps": src_fps,
            "source_frame_count": src_frames,
            "source_duration": src_dur,
            "source_width": src_w,
            "source_height": src_h,
            "loaded_fps": loaded_fps,
            "loaded_frame_count": loaded_count,
            "loaded_duration": loaded_duration,
            "loaded_width": new_w,
            "loaded_height": new_h,
            "filename": 视频,
        }

        # ═══════════════════════════════════════════════════════════════════
        # 生成预览视频：按目标宽高/帧率/跳过帧/帧数上限用 ffmpeg 转码
        # 生成一个临时视频文件，通过 ui 返回给前端，覆盖在预览区
        # ═══════════════════════════════════════════════════════════════════
        preview_ui = {}
        try:
            temp_dir = folder_paths.get_temp_directory()
            preview_filename = f"xzg_preview_{unique_id or 'node'}_{int(time.time() * 1000)}.mp4"
            preview_path = os.path.join(temp_dir, preview_filename)

            # 构建 vf 滤镜（基于已解码的 info：src_w/src_h 原始尺寸，new_w/new_h 目标尺寸）
            src_ar = src_w / src_h if src_h > 0 else 1.0
            dst_ar = new_w / new_h if new_h > 0 else 1.0
            vf_parts = []
            if new_w != src_w or new_h != src_h:
                if abs(src_ar - dst_ar) < 0.01:
                    vf_parts.append(f"scale={new_w}:{new_h}")
                else:
                    vf_parts.append(f"scale={new_w}:{new_h}:force_original_aspect_ratio=increase")
                    vf_parts.append(f"crop={new_w}:{new_h}")
                vf_parts.append("setsar=1")
            # 帧率滤镜：降帧用 select（与帧提取一致），升帧用 fps round=down（预览可接受末帧重复）
            fr_filters, _is_upscale = _build_framerate_filters(强制帧率, src_fps)
            if _is_upscale:
                # 升帧：预览视频用 fps 滤镜（mp4 输出需要 PTS，无法 Python 端处理）
                fr_filters = [f"fps=fps={强制帧率}:round=down"]
            if fr_filters:
                vf_parts = fr_filters + vf_parts

            cmd = [ffmpeg_path, "-y", "-v", "error"]
            # 起始时间（跳过帧数 → 时间）
            start_time = 跳过帧数 / src_fps if src_fps > 0 else 0.0
            if start_time > 0:
                if start_time > 4:
                    cmd += ["-ss", str(start_time - 4), "-i", video_path, "-ss", "4"]
                else:
                    cmd += ["-ss", str(start_time), "-i", video_path]
            else:
                cmd += ["-i", video_path]

            # 输出帧率（容器元数据，fps 滤镜已处理帧选择/复制）
            if 强制帧率 > 0:
                cmd += ["-r", str(强制帧率)]

            # vf 滤镜
            if vf_parts:
                cmd += ["-vf", ",".join(vf_parts)]

            # 帧数上限
            if 帧数上限 > 0:
                cmd += ["-frames:v", str(帧数上限)]

            # 持续时间限制
            if loaded_duration > 0:
                cmd += ["-t", str(loaded_duration)]

            # 编码参数：H.264 + AAC，快速预设
            cmd += ["-c:v", "libx264", "-preset", "fast", "-crf", "23",
                    "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-b:a", "128k",
                    preview_path]

            proc = subprocess.run(cmd, capture_output=True, timeout=120)
            if proc.returncode != 0:
                err = proc.stderr.decode(*ENCODE_ARGS)
                print(f"[小珠光视频加载器] 预览视频转码失败 (rc={proc.returncode}): {err[:500]}")
            elif os.path.isfile(preview_path):
                # ui 字段的值必须是数组（ComfyUI 的约定，参考 videos 字段格式）
                preview_ui = {
                    "video_preview": [{
                        "filename": preview_filename,
                        "subfolder": "",
                        "type": "temp",
                    }]
                }
                print(f"[小珠光视频加载器] 预览视频已生成: {preview_filename}")
        except Exception as e:
            print(f"[小珠光视频加载器] 预览视频生成异常: {e}")

        if image_tensor.size(3) == 4:
            rgb = image_tensor[:, :, :, :3]
            result = (rgb, audio, video_info)
        else:
            result = (image_tensor, audio, video_info)

        return {"result": result, "ui": preview_ui}

    @classmethod
    def IS_CHANGED(cls, 视频, 强制帧率=0, 视频比例="原始比例", 自定义宽度=0, 自定义高度=0,
                   帧数上限=0, 跳过帧数=0, **kwargs):
        try:
            path = folder_paths.get_annotated_filepath(视频)
            file_hash = calculate_file_hash(path)
        except Exception:
            file_hash = "0"
        # 将所有影响输出的参数纳入变化检测，避免参数变化时被缓存跳过
        return f"{file_hash}|{强制帧率}|{视频比例}|{自定义宽度}|{自定义高度}|{帧数上限}|{跳过帧数}"

    @classmethod
    def VALIDATE_INPUTS(cls, 视频, **kwargs):
        if not folder_paths.exists_annotated_filepath(视频):
            return f"Invalid video file: {视频}"
        return True


# ═══════════════════════════════════════════════════════════════════════════
# 分块上传支持（并发 + 断点续传 + 1GB 限制）
# 比 Load Video UI 的改进：
#   1. 偏移量写入（非追加）→ 支持并发上传和断点续传
#   2. 预分配文件空间 → 无碎片，写入速度快
#   3. 会话管理 → 中断后可恢复，无需从头重传
#   4. 分块校验 → 跟踪已接收分块，重复分块自动跳过
# ═══════════════════════════════════════════════════════════════════════════
import uuid as _xzg_uuid
import threading as _xzg_threading
import time as _xzg_time

from server import PromptServer as _xzg_PS
from aiohttp import web as _xzg_web2

# 路由安全装饰器（与音频加载器一致的 fallback 模式）
import functools as _xzg_ft2
import traceback as _xzg_tb2
try:
    from .. import xzg_safe_handler as _xzg_safe_handler
except Exception:
    import asyncio as _xzg_aio2
    def _xzg_safe_handler(fn):
        def _fmt(exc, status=500):
            tb_s = ''.join(_xzg_tb2.format_exception(type(exc), exc, exc.__traceback__))
            try:
                return _xzg_web2.json_response(
                    {'error': '%s: %s' % (type(exc).__name__, exc), 'traceback': tb_s}, status=status)
            except Exception:
                return _xzg_web2.Response(status=500, text='%s: %s\n\n%s' % (type(exc).__name__, exc, tb_s))
        if _xzg_aio2.iscoroutinefunction(fn):
            @_xzg_ft2.wraps(fn)
            async def _aw(*a, **kw):
                try: return await fn(*a, **kw)
                except _xzg_web2.HTTPException: raise
                except BaseException as e:
                    print('[小珠光路由异常] %s: %s: %s' % (fn.__name__, type(e).__name__, e))
                    _xzg_tb2.print_exc()
                    return _fmt(e)
            return _aw
        @_xzg_ft2.wraps(fn)
        def _sw(*a, **kw):
            try: return fn(*a, **kw)
            except _xzg_web2.HTTPException: raise
            except BaseException as e:
                print('[小珠光路由异常] %s: %s: %s' % (fn.__name__, type(e).__name__, e))
                _xzg_tb2.print_exc()
                return _fmt(e)
        return _sw

# 上传会话存储
_xzg_video_sessions = {}
_xzg_video_sessions_lock = _xzg_threading.Lock()
_XZG_VIDEO_MAX_SIZE = 1024 * 1024 * 1024  # 1GB
_XZG_VIDEO_SESSION_TIMEOUT = 3600  # 会话超时 1 小时


def _xzg_secure_video_filename(name):
    """生成安全的文件名，防止路径穿越。重名时加序号后缀，不加时间戳前缀"""
    import re as _re
    # 只保留文件名部分（去掉路径）
    name = os.path.basename(name)
    # 替换危险字符
    name = _re.sub(r'[^\w.\-]', '_', name)
    if not name:
        name = 'video.mp4'
    # 重名时加序号后缀（如 video.mp4 → video_1.mp4）
    upload_dir = folder_paths.get_input_directory()
    base, ext = os.path.splitext(name)
    final_name = name
    seq = 1
    while os.path.exists(os.path.join(upload_dir, final_name)):
        final_name = f"{base}_{seq}{ext}"
        seq += 1
    return final_name


def _xzg_cleanup_video_sessions():
    """清理超时的上传会话"""
    now = _xzg_time.time()
    with _xzg_video_sessions_lock:
        expired = [sid for sid, s in _xzg_video_sessions.items()
                   if now - s.get('last_activity', 0) > _XZG_VIDEO_SESSION_TIMEOUT]
        for sid in expired:
            session = _xzg_video_sessions.pop(sid, None)
            # 清理未完成的临时文件
            if session and not session.get('done'):
                try:
                    if os.path.exists(session['file_path']):
                        os.remove(session['file_path'])
                except Exception:
                    pass


if getattr(_xzg_PS, 'instance', None) is not None:

    @_xzg_PS.instance.routes.post("/xzg/video_upload_start")
    @_xzg_safe_handler
    async def xzg_video_upload_start(request):
        """启动分块上传会话，预分配文件空间"""
        data = await request.json()
        filename = data.get("filename", "")
        total_size = int(data.get("total_size", 0))
        total_chunks = int(data.get("total_chunks", 0))

        if not filename or total_size <= 0 or total_chunks <= 0:
            return _xzg_web2.json_response({"error": "参数无效"}, status=400)

        # 1GB 硬限制
        if total_size > _XZG_VIDEO_MAX_SIZE:
            return _xzg_web2.json_response({"error": "文件超过 1GB 限制"}, status=413)

        _xzg_cleanup_video_sessions()

        safe_name = _xzg_secure_video_filename(filename)
        upload_dir = folder_paths.get_input_directory()
        os.makedirs(upload_dir, exist_ok=True)
        file_path = os.path.join(upload_dir, safe_name)

        # 预分配文件空间（truncate 到目标大小，支持偏移量写入）
        with open(file_path, 'wb') as f:
            f.truncate(total_size)

        session_id = str(_xzg_uuid.uuid4())
        with _xzg_video_sessions_lock:
            _xzg_video_sessions[session_id] = {
                'filename': safe_name,
                'file_path': file_path,
                'total_size': total_size,
                'total_chunks': total_chunks,
                'received_chunks': set(),
                'received_bytes': 0,
                'created_at': _xzg_time.time(),
                'last_activity': _xzg_time.time(),
                'done': False,
            }

        return _xzg_web2.json_response({
            "session_id": session_id,
            "filename": safe_name,
        })

    @_xzg_PS.instance.routes.post("/xzg/video_upload_chunk")
    @_xzg_safe_handler
    async def xzg_video_upload_chunk(request):
        """上传单个分块（偏移量写入，支持并发和断点续传）"""
        post = await request.post()
        session_id = post.get("session_id", "")
        chunk_index = int(post.get("chunk_index", -1))
        chunk_offset = int(post.get("chunk_offset", -1))
        chunk_file = post.get("chunk")

        if not session_id or chunk_index < 0 or chunk_offset < 0 or not chunk_file:
            return _xzg_web2.json_response({"error": "参数无效"}, status=400)

        with _xzg_video_sessions_lock:
            session = _xzg_video_sessions.get(session_id)
            if not session:
                return _xzg_web2.json_response({"error": "会话不存在或已过期"}, status=404)
            session['last_activity'] = _xzg_time.time()

            # 已接收的分块直接跳过（断点续传）
            if chunk_index in session['received_chunks']:
                return _xzg_web2.json_response({
                    "status": "duplicate",
                    "received": len(session['received_chunks']),
                    "total": session['total_chunks'],
                })

            if chunk_index >= session['total_chunks']:
                return _xzg_web2.json_response({"error": "分块索引越界"}, status=400)

            file_path = session['file_path']
            total_chunks = session['total_chunks']

        # 读取分块数据
        chunk_data = chunk_file.file.read()
        chunk_size = len(chunk_data)

        # 偏移量写入（每个分块写入到文件的指定位置，互不重叠）
        with open(file_path, 'r+b') as f:
            f.seek(chunk_offset)
            f.write(chunk_data)

        with _xzg_video_sessions_lock:
            session['received_chunks'].add(chunk_index)
            session['received_bytes'] += chunk_size
            received_count = len(session['received_chunks'])

            # 所有分块已接收 → 验证文件大小并标记完成
            if received_count >= total_chunks:
                session['done'] = True
                # 验证最终文件大小与预期一致（防止损坏文件残留）
                actual_size = 0
                try:
                    actual_size = os.path.getsize(file_path)
                except Exception:
                    pass
                if actual_size != session['total_size']:
                    # 文件大小不匹配，删除损坏文件
                    try:
                        os.remove(file_path)
                    except Exception:
                        pass
                    return _xzg_web2.json_response({
                        "error": f"文件大小不匹配 (预期 {session['total_size']}，实际 {actual_size})，已删除损坏文件",
                    }, status=500)
                return _xzg_web2.json_response({
                    "status": "done",
                    "filename": session['filename'],
                    "received": received_count,
                    "total": total_chunks,
                })

        return _xzg_web2.json_response({
            "status": "ok",
            "received": received_count,
            "total": total_chunks,
        })

    @_xzg_PS.instance.routes.get("/xzg/video_upload_status")
    @_xzg_safe_handler
    async def xzg_video_upload_status(request):
        """查询上传会话状态（用于断点续传）"""
        session_id = request.query.get("session_id", "")
        if not session_id:
            return _xzg_web2.json_response({"error": "session_id required"}, status=400)

        with _xzg_video_sessions_lock:
            session = _xzg_video_sessions.get(session_id)
            if not session:
                return _xzg_web2.json_response({"error": "会话不存在或已过期"}, status=404)
            return _xzg_web2.json_response({
                "session_id": session_id,
                "filename": session['filename'],
                "total_size": session['total_size'],
                "total_chunks": session['total_chunks'],
                "received_chunks": sorted(session['received_chunks']),
                "received_count": len(session['received_chunks']),
                "done": session['done'],
            })

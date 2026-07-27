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
    if force_rate != 0:
        vfilters.append("fps=fps=" + str(force_rate))
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

    yieldable_frames = (force_rate or fps_base) * duration
    if frame_load_cap > 0:
        args_all_frames += ["-frames:v", str(frame_load_cap)]
        yieldable_frames = min(yieldable_frames, frame_load_cap)

    yield (size_base[0], size_base[1], fps_base, duration, fps_base * duration,
           1.0 / (force_rate or fps_base), yieldable_frames, size[0], size[1], alpha)

    args_all_frames += ["-f", "rawvideo", "-"]

    pbar = ProgressBar(int(yieldable_frames)) if yieldable_frames > 0 else None
    frames_added = 0

    try:
        with subprocess.Popen(args_all_frames, stdout=subprocess.PIPE) as proc:
            bpi = size[0] * size[1] * 8
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
    except BrokenPipeError:
        try:
            err = proc.stderr.read().decode(*ENCODE_ARGS)
        except Exception:
            err = ""
        raise Exception("FFmpeg read error:\n" + err)

    if prev_frame is not None:
        yield prev_frame
        frames_added += 1
        if pbar is not None:
            pbar.update_absolute(frames_added, int(yieldable_frames))


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
                "强制帧率": (["0", "16", "24", "25", "30", "60"], {"default": "0"}),
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

        if image_tensor.size(3) == 4:
            rgb = image_tensor[:, :, :, :3]
            return (rgb, audio, video_info)
        return (image_tensor, audio, video_info)

    @classmethod
    def IS_CHANGED(cls, 视频, **kwargs):
        try:
            path = folder_paths.get_annotated_filepath(视频)
            return calculate_file_hash(path)
        except Exception:
            return "0"

    @classmethod
    def VALIDATE_INPUTS(cls, 视频, **kwargs):
        if not folder_paths.exists_annotated_filepath(视频):
            return f"Invalid video file: {视频}"
        return True

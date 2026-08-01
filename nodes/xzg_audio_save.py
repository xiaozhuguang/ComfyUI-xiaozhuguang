"""
小珠光音频保存
将 AUDIO tensor 保存为多种格式（MP3/WAV/FLAC），支持质量调节、文件前缀自定义
前端显示波形预览，右键音轨直接保存到桌面
"""

import os
import subprocess
import json
import numpy as np
import torch
import folder_paths
from comfy.utils import ProgressBar

# 添加 PromptServer 路由
from server import PromptServer

# ---------- 小珠光路由安全装饰器 ----------
import asyncio as _xzg_asyncio
import functools as _xzg_ft
import traceback as _xzg_tb
try:
    from aiohttp import web as _xzg_web
except Exception:
    import types as _xzg_t
    _xzg_web = _xzg_t.ModuleType('aiohttp.web')
    class _R:
        def __init__(self, *a, **kw): pass
    _xzg_web.Response = _R
    _xzg_web.json_response = lambda *a, **kw: {'_json': (a, kw)}
    class _HTTPE(Exception): pass
    _xzg_web.HTTPException = _HTTPE

try:
    from .. import xzg_safe_handler as _xsh, _safe_dir as _xsd
    xzg_safe_handler = _xsh
    _safe_dir = _xsd
except Exception:
    def xzg_safe_handler(fn):
        def _fmt_resp(exc, status=500):
            tb_s = ''.join(_xzg_tb.format_exception(type(exc), exc, exc.__traceback__))
            try:
                return _xzg_web.json_response(
                    {'error': '%s: %s' % (type(exc).__name__, exc), 'traceback': tb_s},
                    status=status,
                )
            except Exception:
                return _xzg_web.Response(status=500, text='%s: %s\n\n%s' % (type(exc).__name__, exc, tb_s))
        if _xzg_asyncio.iscoroutinefunction(fn):
            @_xzg_ft.wraps(fn)
            async def _aw(*a, **kw):
                try:
                    return await fn(*a, **kw)
                except _xzg_web.HTTPException:
                    raise
                except BaseException as e:
                    print('[小珠光路由异常] %s: %s: %s' % (fn.__name__, type(e).__name__, e))
                    _xzg_tb.print_exc()
                    return _fmt_resp(e)
            return _aw
        else:
            @_xzg_ft.wraps(fn)
            def _sw(*a, **kw):
                try:
                    return fn(*a, **kw)
                except _xzg_web.HTTPException:
                    raise
                except BaseException as e:
                    print('[小珠光路由异常] %s: %s: %s' % (fn.__name__, type(e).__name__, e))
                    _xzg_tb.print_exc()
                    return _fmt_resp(e)
            return _sw

    def _safe_dir(fn_name, fallback_subdir):
        import folder_paths as _fp
        d = getattr(_fp, fn_name)()
        if d:
            os.makedirs(d, exist_ok=True)
            return d
        fallback = os.path.join(getattr(_fp, 'models_dir', os.getcwd()), fallback_subdir)
        os.makedirs(fallback, exist_ok=True)
        print('[小珠光] folder_paths.%s() 返回 None，兜底使用: %s' % (fn_name, fallback))
        return fallback
# ---------------- END ----------------
from aiohttp import web


def _routes():
    inst = getattr(PromptServer, 'instance', None)
    if inst is not None:
        return inst.routes
    class _Fallback:
        def _noop(self, path):
            def deco(fn): return fn
            return deco
        post = put = delete = patch = get = _noop
    return _Fallback()


routes = _routes()


ENCODE_ARGS = ['utf-8', 'replace']


def ffmpeg_suitability(path):
    """评估 ffmpeg 的适用性"""
    try:
        version = subprocess.run([path, "-version"], check=True, capture_output=True).stdout.decode(*ENCODE_ARGS)
    except:
        return 0
    score = 0
    simple_criterion = [("libmp3lame", 20), ("flac", 5)]
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
    """查找 ffmpeg 路径"""
    import shutil

    if "VHS_FORCE_FFMPEG_PATH" in os.environ:
        return os.environ.get("VHS_FORCE_FFMPEG_PATH")

    ffmpeg_paths = []
    try:
        from imageio_ffmpeg import get_ffmpeg_exe
        ffmpeg_paths.append(get_ffmpeg_exe())
    except:
        pass

    if "VHS_USE_IMAGEIO_FFMPEG" in os.environ and len(ffmpeg_paths) > 0:
        return ffmpeg_paths[-1]

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
        for exe in ["ffmpeg.exe", "ffmpeg"]:
            p = os.path.join(ffmpeg_bin, exe)
            if os.path.isfile(p):
                ffmpeg_paths.append(p)

    if len(ffmpeg_paths) == 0:
        print("[小珠光音频保存] No valid ffmpeg found.")
        return None
    elif len(ffmpeg_paths) == 1:
        return ffmpeg_paths[0]
    else:
        return max(ffmpeg_paths, key=ffmpeg_suitability)


ffmpeg_path = _get_ffmpeg_path()

# 音频格式定义：编码器 + 扩展名 + MIME
AUDIO_FORMATS = {
    "mp3": {"encoder": "libmp3lame", "extension": "mp3", "mime": "audio/mpeg"},
    "wav": {"encoder": "pcm_s16le",   "extension": "wav", "mime": "audio/wav"},
    "flac":{"encoder": "flac",       "extension": "flac","mime": "audio/flac"},
}

WAVEFORM_SAMPLES = 500  # 前端波形显示的采样点数


def generate_waveform_peaks(waveform, num_samples=WAVEFORM_SAMPLES):
    """从完整波形生成降采样的峰值数据用于前端显示"""
    if waveform is None or waveform.numel() == 0:
        return []

    # 取左声道（或混合双声道）
    if waveform.shape[0] >= 2:
        mono = (waveform[0] + waveform[1]) / 2.0
    else:
        mono = waveform[0]

    total_samples = mono.shape[0]
    if total_samples <= num_samples:
        peaks = []
        for i in range(total_samples):
            v = float(mono[i].item())
            peaks.append([v, v])
        return peaks

    samples_per_bin = total_samples / num_samples
    peaks = []
    mono_np = mono.numpy()

    for i in range(num_samples):
        start_idx = int(i * samples_per_bin)
        end_idx = int((i + 1) * samples_per_bin)
        if end_idx > total_samples:
            end_idx = total_samples
        if start_idx >= end_idx:
            peaks.append([0.0, 0.0])
            continue
        chunk = mono_np[start_idx:end_idx]
        peaks.append([float(np.min(chunk)), float(np.max(chunk))])

    return peaks


def save_audio_to_file(waveform, sample_rate, output_path, format_name="mp3", quality=128):
    """使用 FFmpeg 将音频 tensor 保存为指定格式文件
    
    Args:
        waveform: [batch, channels, samples] float32 tensor，范围 [-1, 1]
        sample_rate: 采样率（如 44100）
        output_path: 输出文件完整路径
        format_name: "mp3" / "wav" / "flac"
        quality: 质量参数。MP3=比特率(kbps)，FLAC/WAV忽略（无损）
    """
    if ffmpeg_path is None:
        raise RuntimeError("FFmpeg is required but not found")

    if waveform is None or waveform.numel() == 0:
        raise ValueError("No audio data to save")

    fmt = AUDIO_FORMATS.get(format_name)
    if fmt is None:
        raise ValueError(f"Unsupported format: {format_name}")

    # 处理 tensor 维度：[batch, channels, samples] → [samples * channels interleaved]
    audio_tensor = waveform
    if audio_tensor.dim() == 3:
        audio_tensor = audio_tensor.squeeze(0)
    
    channels = audio_tensor.size(0) if audio_tensor.dim() >= 2 else 1
    
    # 转为 [samples, channels] 交错格式（FFmpeg f32le 输入需要）
    if audio_tensor.dim() == 2:
        audio_tensor = audio_tensor.transpose(0, 1)  # [channels, samples] → [samples, channels]

    # 确保数据在 [-1, 1]
    audio_tensor = torch.clamp(audio_tensor.float(), -1.0, 1.0)
    
    # 转为 f32le bytes
    audio_bytes = audio_tensor.contiguous().cpu().numpy().tobytes()

    # 构建 FFmpeg 命令：从 stdin（f32le PCM）编码到目标格式
    encoder = fmt["encoder"]
    
    # 质量参数映射
    if format_name == "wav":
        # WAV 无损，不需要额外参数
        extra_args = []
    elif format_name == "flac":
        # FLAC 无损（或可设 compression_level）
        extra_args = ["-compression_level", "5"]
    else:
        # MP3 → bitrate
        quality_val = max(16, min(320, int(quality)))
        extra_args = ["-b:a", f"{quality_val}k"]

    args = [
        ffmpeg_path, "-v", "error",
        "-f", "f32le",
        "-ar", str(sample_rate),
        "-ac", str(channels),
        "-i", "-",
        "-c:a", encoder,
    ] + extra_args + ["-y", output_path]

    try:
        proc = subprocess.run(
            args, input=audio_bytes, capture_output=True, check=False, timeout=600
        )
        if proc.returncode != 0:
            err = proc.stderr.decode(*ENCODE_ARGS) if proc.stderr else ""
            raise RuntimeError(f"FFmpeg encoding failed (rc={proc.returncode}):\n{err[:500]}")
    except subprocess.TimeoutExpired:
        raise RuntimeError("FFmpeg encoding timed out (>600s)")

    return output_path


class XiaozhuguangAudioSave:
    """小珠光音频保存 - 将 AUDIO tensor 保存为多种格式"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "音频": ("AUDIO",),
                "格式": (["mp3", "wav", "flac"], {"default": "mp3"}),
                "质量": (["320", "192", "128"], {"default": "128"}),
                "文件名前缀": ("STRING", {"default": "xzg-audio"}),
            },
            "optional": {
                "模式": (["保存", "预览"], {"default": "保存"}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "save_audio"
    CATEGORY = "xiaozhuguang"
    OUTPUT_NODE = True

    def save_audio(self, 音频, 格式, 质量, 文件名前缀,
                   模式="保存", **kwargs):
        if ffmpeg_path is None:
            raise RuntimeError("FFmpeg not found. Please install FFmpeg.")

        waveform = None
        sample_rate = 44100

        try:
            waveform = 音频.get("waveform")
            sample_rate = 音频.get("sample_rate", 44100)
        except Exception:
            pass

        if waveform is None or waveform.numel() == 0:
            raise ValueError("Invalid audio data")

        is_preview = (模式 == "预览")

        # 质量转为 int（无损格式忽略）
        quality_val = int(质量) if str(质量).isdigit() else 128

        # 生成波形峰值数据（保存和预览模式都需要）
        w_for_peaks = waveform.squeeze(0) if waveform.dim() == 3 else waveform
        peaks = generate_waveform_peaks(w_for_peaks)
        actual_duration = w_for_peaks.shape[-1] / sample_rate if w_for_peaks.numel() > 0 else 0.0

        # 扩展名（两种模式都要用）
        ext = AUDIO_FORMATS[格式]["extension"]

        # ── 预览模式：仍编码音频，但保存到 ComfyUI temp 目录（不落盘到 output） ──
        if is_preview:
            import uuid
            temp_dir = _safe_dir('get_temp_directory',   'temp')
            os.makedirs(temp_dir, exist_ok=True)
            random_tag = uuid.uuid4().hex[:12]
            preview_filename = f"xzg_preview_{random_tag}.{ext}"
            preview_filepath = os.path.join(temp_dir, preview_filename)
            # 复用同一套 ffmpeg 编码逻辑，输出到 temp
            save_audio_to_file(waveform, sample_rate, preview_filepath, format_name=格式, quality=quality_val)
            return {
                "result": (),
                "ui": {
                    "audio_saved": [{
                        "filename": preview_filename,
                        "subfolder": "",
                        "type": "temp",
                        "format": 格式,
                        "quality": quality_val,
                        "duration": actual_duration,
                        "sample_rate": sample_rate,
                        "peaks": peaks,
                        "preview": True,
                    }],
                },
            }

        # 保存模式：输出到 output 目录
        base_dir = _safe_dir('get_output_directory', 'output')
        output_dir = base_dir
        subfolder = ""

        # 文件名：前缀_序号.扩展名（自动递增避免覆盖）
        ext = AUDIO_FORMATS[格式]["extension"]
        filename_base = f"{文件名前缀}"
        
        max_counter = 0
        import re
        matcher = re.compile(f"{re.escape(filename_base)}_(\\d+)\\D*\\.{ext}$", re.IGNORECASE)
        try:
            for existing_file in os.listdir(output_dir):
                match = matcher.fullmatch(existing_file)
                if match:
                    file_counter = int(match.group(1))
                    if file_counter > max_counter:
                        max_counter = file_counter
        except Exception:
            pass

        counter = max_counter + 1
        filename = f"{filename_base}_{counter:05d}.{ext}"
        filepath = os.path.join(output_dir, filename)

        # 保存文件
        save_audio_to_file(waveform, sample_rate, filepath, format_name=格式, quality=quality_val)

        return {
            "result": (),
            "ui": {
                "audio_saved": [{
                    "filename": filename,
                    "subfolder": subfolder,
                    "type": "output",
                    "format": 格式,
                    "quality": quality_val,
                    "duration": actual_duration,
                    "sample_rate": sample_rate,
                    "peaks": peaks,
                }],
            },
        }


# ═══════════════════════════════════════════════════════════════════════
# API 路由：获取已保存音频的 URL（供前端右键下载用）
# ═══════════════════════════════════════════════════════════════════════

@routes.get("/xzg/audio_saved_url")
@xzg_safe_handler
async def get_audio_saved_url(request):
    """根据文件名返回可访问的音频 URL"""
    filename = request.query.get("filename", "")
    subfolder = request.query.get("subfolder", "")
    file_type = request.query.get("type", "output")

    if not filename:
        return web.json_response({"error": "filename required"}, status=400)

    try:
        if file_type == "temp":
            base_dir = _safe_dir('get_temp_directory',   'temp')
        else:
            base_dir = _safe_dir('get_output_directory', 'output')

        full_path = os.path.join(base_dir, subfolder, filename) if subfolder else os.path.join(base_dir, filename)
        
        if not os.path.isfile(full_path):
            return web.json_response({"error": "file not found"}, status=404)

        # 返回 view URL（ComfyUI 标准）
        url_params = f"?filename={filename}"
        if subfolder:
            url_params += f"&subfolder={subfolder}"
        url_params += f"&type={file_type}"

        return web.json_response({
            "url": f"/view{url_params}",
            "filename": filename,
        })
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


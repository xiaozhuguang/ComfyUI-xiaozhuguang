"""
小珠光音频保存
将 AUDIO tensor 保存为多种格式（MP3/WAV/FLAC），支持质量调节、文件前缀自定义
前端显示波形预览，右键音轨直接保存到桌面
"""

import os
import shutil
import subprocess
import json
import time
from datetime import datetime
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


class XiaozhuguangAudioSaveDaVinci:
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
                # 音量：仅前端监听预览用，不影响最终文件输出
                "音量": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 3.0, "step": 0.01}),
                # 自动发送到快剪：保存完成后把音频加入快剪媒体库（前端执行完成回调里发送；
                # 开关由前端隐藏，交互入口在波形右键菜单，与视频保存-化神级的隐藏开关模式一致）
                "自动发送到快剪": ("BOOLEAN", {"default": False}),
                # 自动导出到达芬奇：保存完成后把音频导入达芬奇当前项目（媒体池 + 空白音频
                # 轨道/无则新建 + 对齐播放头片段前端），开关由前端隐藏在悬浮按钮图标上
                "自动导出到达芬奇": ("BOOLEAN", {"default": False}),
                # 达芬奇导出副本的输出设置；前端收进悬浮「输出设置」弹窗。
                "use_default_output": ("BOOLEAN", {"default": True}),
                "base_dir": ("STRING", {"default": "", "multiline": False}),
                "filename_custom": ("STRING", {"default": "xzg-audio", "multiline": False}),
                "add_date_stamp": ("BOOLEAN", {"default": False}),
                "add_time_stamp": ("BOOLEAN", {"default": False}),
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
                   模式="保存", 音量=1.0, 自动导出到达芬奇=False, **kwargs):
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
            davinci_token = ""
            # 与视频保存-化神级一致：预览继续使用 temp 文件，但自定义输出时另存一份
            # 给达芬奇作为稳定源文件。
            if not kwargs.get("use_default_output", True) and str(kwargs.get("base_dir") or "").strip():
                try:
                    copied = _copy_audio_path_to_configured_output(preview_filepath, {
                        "base_dir": kwargs.get("base_dir", ""),
                        "filename_prefix": kwargs.get("filename_custom", "xzg-audio"),
                        "add_date_stamp": kwargs.get("add_date_stamp", False),
                        "add_time_stamp": kwargs.get("add_time_stamp", False),
                    })
                    davinci_token = _register_audio_abs_token(copied)
                except Exception as e:
                    print(f"[小珠光音频保存] 预览副本创建失败：{e}")
            preview_davinci = None
            if 自动导出到达芬奇 and davinci_token:
                preview_davinci = _dv_call_bridge({"action": "import_audio", "file_path": _AUDIO_ABS_FILE_TOKENS[davinci_token]})
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
                        "davinci_abs_token": davinci_token,
                        "davinci": preview_davinci,
                    }],
                },
            }

        # 保存模式：与视频保存-化神级一致，直接落盘。默认写 output/；
        # 关闭「默认输出」后 base_dir 生效：绝对路径直接使用（文件在 output 之外，走令牌拉流预览），
        # 相对路径拼到 output/ 下并并入 subfolder（仍可经 /view 访问）。
        use_default = bool(kwargs.get("use_default_output", True))
        custom_base = str(kwargs.get("base_dir") or "").strip()
        is_absolute_base = False
        subfolder_extra = ""
        output_dir = _safe_dir('get_output_directory', 'output')
        prefix = 文件名前缀
        if not use_default and custom_base:
            from .xzg_video_combine import (_xzg_resolve_template, _xzg_sanitize_path,
                                            _xzg_is_absolute_path)
            _ctx = {"_now": datetime.now(), "workflow_name": "", "node_id": "", "format": 格式}
            _date = _xzg_sanitize_path(_xzg_resolve_template("{date}", _ctx)) if kwargs.get("add_date_stamp") else ""
            _time = _xzg_sanitize_path(_xzg_resolve_template("{time}", _ctx)) if kwargs.get("add_time_stamp") else ""
            if _date and _time:
                _dt = f"{_date}-{_time}"
            elif _date:
                _dt = _date
            elif _time:
                _dt = _time
            else:
                _dt = ""
            prefix = str(kwargs.get("filename_custom") or "xzg-audio")
            if _dt:
                prefix = f"{_dt}-{prefix}" if prefix else _dt
            resolved_base = _xzg_sanitize_path(_xzg_resolve_template(custom_base, _ctx))
            if resolved_base and _xzg_is_absolute_path(resolved_base):
                output_dir = resolved_base
                is_absolute_base = True
            elif resolved_base:
                output_dir = os.path.join(_safe_dir('get_output_directory', 'output'), resolved_base)
                subfolder_extra = resolved_base
            os.makedirs(output_dir, exist_ok=True)

        # 文件名前缀可含子目录；get_save_image_path 解析 subfolder 并创建父目录。
        # 返回：full_output_folder, filename(前缀), counter, subfolder, filename_prefix
        full_output_folder, filename, _, subfolder, _ = folder_paths.get_save_image_path(
            prefix, output_dir
        )
        # 自定义输出-相对路径：把 base_dir 相对目录并入 subfolder，使 /view 与达芬奇导出能正确定位
        if subfolder_extra:
            subfolder = os.path.normpath(os.path.join(subfolder_extra, subfolder)) if subfolder else subfolder_extra

        # 计算下一个可用计数器（按实际扩展名扫描目标目录，避免 get_save_image_path
        # 基于 .png 的计数与该格式不符）
        import re
        max_counter = 0
        matcher = re.compile(f"{re.escape(filename)}_(\\d+)\\D*\\.{ext}$", re.IGNORECASE)
        try:
            for existing_file in os.listdir(full_output_folder):
                match = matcher.fullmatch(existing_file)
                if match:
                    file_counter = int(match.group(1))
                    if file_counter > max_counter:
                        max_counter = file_counter
        except Exception:
            pass

        counter = max_counter + 1
        filename = f"{filename}_{counter:05d}.{ext}"
        filepath = os.path.join(full_output_folder, filename)

        # 保存主文件（直接落到上面解析出的 output_dir / 自定义目录）
        save_audio_to_file(waveform, sample_rate, filepath, format_name=格式, quality=quality_val)

        # 绝对路径自定义输出：文件在 output/ 之外，/view 无法服务。复用视频模块令牌，
        # 前端经 /xzg/davinci/view-abs 拉流预览，「导出到达芬奇」用同一令牌导入。
        abs_token = ""
        if is_absolute_base and _dv_register_abs_token is not None:
            try:
                abs_token = _dv_register_abs_token(filepath)
            except Exception as e:
                print(f"[小珠光音频保存] 绝对路径令牌登记失败：{e}")

        # 自动导出到达芬奇：直接导入已落盘的成品（自定义绝对路径走令牌解析）。
        # 与视频保存-化神级一致：桥接失败不阻塞保存，结果挂在 ui 供前端提示。
        davinci_result = None
        if 自动导出到达芬奇:
            try:
                if abs_token and _dv_lookup_abs_token is not None:
                    dv_path = _dv_lookup_abs_token(abs_token)
                else:
                    dv_path = filepath
                dv = _dv_call_bridge({"action": "import_audio", "file_path": dv_path})
                davinci_result = dv
                if not dv.get("ok"):
                    print(f"[小珠光音频保存] 自动导出到达芬奇失败：{dv.get('error', '导入失败')}")
            except Exception as e:
                davinci_result = {"ok": False, "error": str(e)}
                print(f"[小珠光音频保存] 自动导出到达芬奇异常：{e}")

        saved_info = {
            "filename": filename,
            "subfolder": subfolder,
            "type": "output",
            "format": 格式,
            "quality": quality_val,
            "duration": actual_duration,
            "sample_rate": sample_rate,
            "peaks": peaks,
        }
        # 绝对路径自定义输出：abs_token 供前端预览拉流；davinci_abs_token 供手动导出导入
        if abs_token:
            saved_info["abs_token"] = abs_token
            saved_info["davinci_abs_token"] = abs_token
        if davinci_result is not None:
            saved_info["davinci"] = davinci_result

        return {
            "result": (),
            "ui": {
                "audio_saved": [saved_info],
            },
        }


# ═══════════════════════════════════════════════════════════════════════
# 导出到达芬奇（参考视频保存-化神级 xzg_video_save_davinci.py）：
# 复用其桥接子进程调用与 output 路径解析，action=import_audio 落音频轨道
# ═══════════════════════════════════════════════════════════════════════

try:
    from .xzg_video_save_davinci import (
        _call_bridge as _dv_call_bridge,
        _resolve_abs_path as _dv_resolve_abs_path,
        _register_abs_token as _dv_register_abs_token,
        _lookup_abs_token as _dv_lookup_abs_token,
    )
except Exception as _e:
    _dv_call_bridge = None
    _dv_register_abs_token = None
    _dv_lookup_abs_token = None
    print(f"[小珠光音频保存] 达芬奇桥接模块加载失败：{_e}")

    def _dv_resolve_abs_path(info):
        """兜底：output 目录 + subfolder + filename（与视频保存解析逻辑一致）"""
        filename = info.get("filename")
        if not filename:
            return None
        subfolder = (info.get("subfolder") or "").strip("/\\")
        out_dir = _safe_dir('get_output_directory', 'output')
        if subfolder:
            safe_parts = [p for p in subfolder.replace("\\", "/").split("/") if p and p not in (".", "..")]
            if not safe_parts:
                return os.path.join(out_dir, filename)
            return os.path.join(out_dir, *safe_parts, filename)
        return os.path.join(out_dir, filename)


_AUDIO_ABS_FILE_TOKENS = {}


def _register_audio_abs_token(path):
    import uuid
    token = uuid.uuid4().hex
    _AUDIO_ABS_FILE_TOKENS[token] = path
    if len(_AUDIO_ABS_FILE_TOKENS) > 200:
        _AUDIO_ABS_FILE_TOKENS.pop(next(iter(_AUDIO_ABS_FILE_TOKENS)), None)
    return token


def _copy_audio_path_to_configured_output(source_path, output_options):
    from .xzg_video_combine import _xzg_is_absolute_path, _xzg_sanitize_path
    base = _xzg_sanitize_path(str(output_options.get("base_dir") or "").strip())
    if not base:
        raise ValueError("自定义输出目录为空")
    target_dir = base if _xzg_is_absolute_path(base) else os.path.join(folder_paths.get_output_directory(), base)
    os.makedirs(target_dir, exist_ok=True)
    prefix = _safe_audio_export_name(output_options.get("filename_prefix") or "xzg-audio")
    now = datetime.now()
    stamps = ([now.strftime("%Y-%m-%d")] if output_options.get("add_date_stamp") else [])
    if output_options.get("add_time_stamp"):
        stamps.append(now.strftime("%H%M%S"))
    if stamps:
        prefix = "-".join([*stamps, prefix])
    target = os.path.join(target_dir, f"{prefix}_{int(time.time() * 1000)}{os.path.splitext(source_path)[1] or '.wav'}")
    shutil.copy2(source_path, target)
    return target


def _safe_audio_export_name(name):
    import re
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', str(name or "")).strip()[:80] or "xzg-audio"


@routes.post("/xzg/davinci/audio-save-import")
@xzg_safe_handler
async def xzg_davinci_audio_save_import(request):
    """先按音频加载器-化神级的另存为逻辑复制到用户选定目录，再导入达芬奇。"""
    try:
        data = await request.json()
    except Exception:
        data = {}
    abs_token = data.get("abs_token") or ""
    if abs_token:
        abs_path = ""
        if _dv_lookup_abs_token is not None:
            try:
                abs_path = _dv_lookup_abs_token(abs_token) or ""
            except Exception:
                abs_path = ""
        if not abs_path:
            abs_path = _AUDIO_ABS_FILE_TOKENS.get(abs_token) or ""
    else:
        filename = data.get("filename") or ""
        subfolder = data.get("subfolder") or ""
        if not filename:
            return web.json_response({"ok": False, "error": "缺少 filename"})
        file_type = str(data.get("type") or "output")
        if file_type == "temp":
            # 预览模式产物位于 ComfyUI temp。只接受 temp 根目录内的相对文件路径，
            # 随后会复制到用户选择的稳定目录，再交给达芬奇导入。
            temp_root = os.path.abspath(_safe_dir('get_temp_directory', 'temp'))
            clean_name = str(filename).replace("\\", "/")
            clean_subfolder = str(subfolder or "").replace("\\", "/")
            parts = [p for p in (clean_subfolder + "/" + clean_name).split("/") if p and p != "."]
            if (not parts or os.path.isabs(clean_name) or os.path.isabs(clean_subfolder)
                    or os.path.splitdrive(clean_subfolder)[0]
                    or os.path.basename(clean_name) != clean_name
                    or any(p == ".." for p in parts)):
                return web.json_response({"ok": False, "error": "预览音频路径无效"})
            abs_path = os.path.abspath(os.path.join(temp_root, *parts))
            if os.path.commonpath([temp_root, abs_path]) != temp_root:
                return web.json_response({"ok": False, "error": "预览音频路径超出 temp 目录"})
        else:
            abs_path = _dv_resolve_abs_path({"filename": filename, "subfolder": subfolder})
    if not abs_path or not os.path.isfile(abs_path):
        return web.json_response({"ok": False, "error": "导出副本不存在或已失效，请重新执行节点"})

    # 复用音频加载器-化神级的 Windows 原生保存对话框、内容去重和重名避让逻辑。
    stage = "初始化导出"
    try:
        from .xzg_audio_loader_davinci import (
            _choose_audio_save_path,
            _find_exported_copy,
            _file_sha256,
            _cache_audio_sha256,
        )
        selected_path = None
        target_dir = str(data.get("target_dir") or "").strip()
        target_name = str(data.get("target_name") or "").strip()
        # 同一后端会话会记住上次选择的目录。若该目录已被移动、删除或所在盘符离线，
        # 不要继续对失效路径复制文件，重新打开另存为窗口让用户选择有效位置。
        if target_dir and not os.path.isdir(target_dir):
            target_dir = ""
            target_name = ""
        if not target_dir:
            stage = "打开 Windows 另存为窗口"
            selected_path = await _xzg_asyncio.to_thread(_choose_audio_save_path, abs_path)
            if not selected_path:
                return web.json_response({"ok": False, "cancelled": True})
            target_dir = os.path.dirname(selected_path)
            target_name = os.path.basename(selected_path)
        elif not os.path.isabs(target_dir):
            return web.json_response({"ok": False, "error": "保存目录必须是完整路径"})

        stage = "检查目标目录"
        os.makedirs(target_dir, exist_ok=True)
        stage = "查找已有副本"
        target_path = await _xzg_asyncio.to_thread(_find_exported_copy, abs_path, target_dir)
        if target_path is None:
            if not target_name:
                stem = _safe_audio_export_name(os.path.splitext(os.path.basename(abs_path))[0])
                target_name = stem + (os.path.splitext(abs_path)[1] or ".wav")
            target_name = os.path.basename(target_name)
            target_path = selected_path or os.path.join(target_dir, target_name)
            stage = "检查目标文件名"
            if os.path.exists(target_path) and os.path.normcase(os.path.abspath(abs_path)) != os.path.normcase(os.path.abspath(target_path)):
                stem, ext = os.path.splitext(target_path)
                index = 2
                while os.path.exists(f"{stem}_{index}{ext}"):
                    index += 1
                target_path = f"{stem}_{index}{ext}"
            if os.path.normcase(os.path.abspath(abs_path)) != os.path.normcase(os.path.abspath(target_path)):
                stage = "计算音频文件摘要"
                source_hash = await _xzg_asyncio.to_thread(_file_sha256, abs_path)
                stage = "复制音频文件"
                await _xzg_asyncio.to_thread(shutil.copy2, abs_path, target_path)
                _cache_audio_sha256(target_path, source_hash)

        stage = "启动达芬奇导入"
        result = await _xzg_asyncio.to_thread(_dv_call_bridge, {"action": "import_audio", "file_path": target_path})
        result["save_directory"] = target_dir
        result["save_filename"] = os.path.basename(target_path)
        result["copied"] = True
        return web.json_response(result)
    except Exception as e:
        return web.json_response({"ok": False, "error": f"{stage}失败：{e}"})


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


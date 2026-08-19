"""
小珠光音频加载器
使用 FFmpeg 加载音频文件，支持波形显示、音频截断
支持常用音频格式：mp3, wav, ogg, flac, aac, m4a, wma, opus, amr, ac3 等
"""

import os
import subprocess
import re
import hashlib
import numpy as np
import torch
import folder_paths
from aiohttp import web
from server import PromptServer
import uuid
import threading
import time

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

AUDIO_EXTENSIONS = {
    'mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma', 'opus',
    'amr', 'ac3', 'aiff', 'au', 'mka', 'mp2', 'ra', 'voc', 'w64'
}

ENCODE_ARGS = ['utf-8', 'replace']
WAVEFORM_SAMPLES = 500  # 前端波形显示的采样点数


def ffmpeg_suitability(path):
    try:
        version = subprocess.run([path, "-version"], check=True,
                                 capture_output=True).stdout.decode(*ENCODE_ARGS)
    except:
        return 0
    score = 0
    simple_criterion = [("libmp3lame", 20), ("libvorbis", 10),
                        ("libopus", 10), ("flac", 5)]
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
        print("[小珠光音频加载器] No valid ffmpeg found.")
        return None
    elif len(ffmpeg_paths) == 1:
        return ffmpeg_paths[0]
    else:
        return max(ffmpeg_paths, key=ffmpeg_suitability)


ffmpeg_path = _get_ffmpeg_path()


def calculate_file_hash(filepath):
    try:
        mtime = os.path.getmtime(filepath)
        fsize = os.path.getsize(filepath)
        h = hashlib.md5()
        h.update(f"{filepath}|{mtime}|{fsize}".encode("utf-8"))
        return h.hexdigest()
    except Exception:
        return "0"


def probe_audio_info(audio_path):
    """探测音频信息：时长、采样率、声道数、比特率等"""
    if not ffmpeg_path:
        return None

    args = [ffmpeg_path, "-i", audio_path, "-f", "null", "-"]
    try:
        proc = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=30)
    except Exception as e:
        print(f'[小珠光音频加载器] 探测音频信息失败: {e}')
        return None

    info = proc.stderr.decode(*ENCODE_ARGS)

    result = {
        'duration': 0.0,
        'sample_rate': 44100,
        'channels': 2,
        'bitrate': 0,
    }

    # 解析时长
    dur_match = re.search(r"Duration: (\d+:\d+:\d+\.\d+),", info)
    if dur_match:
        durs = dur_match.group(1).split(':')
        result['duration'] = int(durs[0]) * 3600 + int(durs[1]) * 60 + float(durs[2])

    # 解析音频流信息
    audio_match = re.search(
        r"Stream .* Audio.*?, (\d+) Hz.*?, (\d+)[ch]",
        info
    )
    if audio_match:
        result['sample_rate'] = int(audio_match.group(1))
        result['channels'] = int(audio_match.group(2))

    # 解析比特率
    br_match = re.search(r", (\d+) kb/s", info)
    if br_match:
        result['bitrate'] = int(br_match.group(1))

    return result


def load_audio(audio_path, start_time=0.0, duration=None, sample_rate=44100):
    """用 FFmpeg 加载音频，返回 (waveform_tensor, sample_rate)。
    waveform 形状: [channels, samples]，float32，范围 [-1, 1]。
    """
    if start_time < 0:
        start_time = 0.0

    args = [ffmpeg_path, "-v", "error"]
    if start_time > 0:
        args += ["-ss", str(start_time)]
    args += ["-i", audio_path]

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
        print(f'[小珠光音频加载器] 音频加载失败: {e}')
        return None, sample_rate

    if proc.returncode != 0:
        err = proc.stderr.decode(*ENCODE_ARGS)
        print(f'[小珠光音频加载器] 音频加载失败 (rc={proc.returncode}): {err[:500]}')
        return None, sample_rate

    raw = proc.stdout
    if not raw or len(raw) < 4:
        return None, sample_rate

    audio_np = np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).T
    audio_np = np.clip(audio_np, -1.0, 1.0)
    waveform = torch.from_numpy(audio_np.astype(np.float32))
    return waveform, sample_rate


def generate_waveform_peaks(waveform, num_samples=WAVEFORM_SAMPLES):
    """从完整波形生成降采样的峰值数据用于前端显示。
    返回: peaks 数组，每个元素为 [min, max]，范围 [-1, 1]
    """
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

    # 将音频分成 num_samples 段，每段取 min/max
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


# ═══════════════════════════════════════════════════════════════════════
# 音频解码进度跟踪（后台线程 + 轮询）
# ═══════════════════════════════════════════════════════════════════════
_xzg_decode_jobs = {}
_xzg_decode_jobs_lock = threading.Lock()
_XZG_DECODE_JOB_TTL = 120  # 完成后保留时间（秒）
_XZG_DECODE_TIMEOUT = 600  # 解码超时（秒）

# 波形峰值缓存：同一音频文件（input 已存在的）切换工作流/刷新页面时跳过重新解码
# 键 = 绝对路径；值 = {mtime, size, peaks, duration, sample_rate, cached_at}
# mtime+size 校验：文件被覆盖上传时自动失效
_xzg_peaks_cache = {}
_xzg_peaks_cache_lock = threading.Lock()
_XZG_PEAKS_CACHE_MAX = 200  # 每条仅 500×2 个浮点数（约 8KB），200 条上限足够且内存可控


def _xzg_get_cached_peaks(audio_path):
    """读取峰值缓存；文件 mtime/size 变化则视为失效返回 None"""
    key = os.path.abspath(audio_path)
    try:
        st = os.stat(key)
    except OSError:
        return None
    with _xzg_peaks_cache_lock:
        entry = _xzg_peaks_cache.get(key)
        if not entry or entry['mtime'] != st.st_mtime or entry['size'] != st.st_size:
            _xzg_peaks_cache.pop(key, None)
            return None
        entry['cached_at'] = time.time()  # 刷新时间用于 FIFO 淘汰
        return {'peaks': entry['peaks'], 'duration': entry['duration'],
                'sample_rate': entry['sample_rate']}


def _xzg_store_peaks(audio_path, peaks, duration, sample_rate):
    """写入峰值缓存（FIFO 淘汰最旧条目）"""
    key = os.path.abspath(audio_path)
    try:
        st = os.stat(key)
        mtime, size = st.st_mtime, st.st_size
    except OSError:
        return
    with _xzg_peaks_cache_lock:
        if len(_xzg_peaks_cache) >= _XZG_PEAKS_CACHE_MAX and key not in _xzg_peaks_cache:
            oldest = min(_xzg_peaks_cache.items(), key=lambda kv: kv[1]['cached_at'])[0]
            _xzg_peaks_cache.pop(oldest, None)
        _xzg_peaks_cache[key] = {
            'mtime': mtime, 'size': size,
            'peaks': peaks, 'duration': duration,
            'sample_rate': sample_rate,
            'cached_at': time.time(),
        }


def _xzg_cleanup_old_jobs():
    """清理过期的解码任务"""
    now = time.time()
    with _xzg_decode_jobs_lock:
        expired = [jid for jid, job in _xzg_decode_jobs.items()
                   if job.get('done') and job.get('finished_at')
                   and now - job['finished_at'] > _XZG_DECODE_JOB_TTL]
        for jid in expired:
            del _xzg_decode_jobs[jid]


def _xzg_decode_audio_thread(audio_path, sample_rate, job_id, total_duration):
    """在后台线程中解码音频，实时更新进度。
    进度基于已接收的字节数 vs 预期总字节数计算，不依赖 FFmpeg 的 -progress 输出。
    """
    try:
        if not ffmpeg_path:
            with _xzg_decode_jobs_lock:
                job = _xzg_decode_jobs.get(job_id)
                if job:
                    job['error'] = 'FFmpeg not found'
                    job['done'] = True
                    job['finished_at'] = time.time()
            return

        # 预期总字节数 = 采样率 × 声道数 × 每样本字节数(f32le=4) × 时长
        # f32le: float32 little-endian, 2 channels interleaved
        bytes_per_second = sample_rate * 2 * 4
        expected_bytes = int(bytes_per_second * total_duration) if total_duration > 0 else 0

        args = [ffmpeg_path, "-v", "error",
                "-i", audio_path,
                "-ac", "2", "-ar", str(sample_rate),
                "-f", "f32le", "-"]

        proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

        stdout_chunks = []
        bytes_read = 0
        start_time = time.time()

        while True:
            chunk = proc.stdout.read(8192)
            if not chunk:
                break
            stdout_chunks.append(chunk)
            bytes_read += len(chunk)

            # 基于字节数计算进度
            if expected_bytes > 0:
                progress = min(1.0, bytes_read / expected_bytes)
                decoded_time = bytes_read / bytes_per_second
            else:
                # 无法确定总时长，使用不确定进度
                progress = -1
                decoded_time = bytes_read / bytes_per_second if bytes_per_second > 0 else 0

            with _xzg_decode_jobs_lock:
                job = _xzg_decode_jobs.get(job_id)
                if job:
                    job['progress'] = progress
                    job['decoded_time'] = decoded_time

            if time.time() - start_time > _XZG_DECODE_TIMEOUT:
                proc.kill()
                with _xzg_decode_jobs_lock:
                    job = _xzg_decode_jobs.get(job_id)
                    if job:
                        job['error'] = '解码超时 (%ds)' % _XZG_DECODE_TIMEOUT
                        job['done'] = True
                        job['finished_at'] = time.time()
                return

        proc.wait()
        stderr_output = proc.stderr.read().decode(*ENCODE_ARGS)
        raw = b''.join(stdout_chunks)

        if proc.returncode != 0:
            with _xzg_decode_jobs_lock:
                job = _xzg_decode_jobs.get(job_id)
                if job:
                    job['error'] = stderr_output[:500] or 'ffmpeg exited with code %d' % proc.returncode
                    job['done'] = True
                    job['finished_at'] = time.time()
            return

        if not raw or len(raw) < 4:
            with _xzg_decode_jobs_lock:
                job = _xzg_decode_jobs.get(job_id)
                if job:
                    job['error'] = 'No audio data'
                    job['done'] = True
                    job['finished_at'] = time.time()
            return

        audio_np = np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).T
        audio_np = np.clip(audio_np, -1.0, 1.0)
        waveform = torch.from_numpy(audio_np.astype(np.float32))
        peaks = generate_waveform_peaks(waveform, WAVEFORM_SAMPLES)
        actual_duration = waveform.shape[-1] / sample_rate

        # 解码成功 → 写入峰值缓存（下次同文件免解码）
        _xzg_store_peaks(audio_path, peaks, actual_duration, sample_rate)

        with _xzg_decode_jobs_lock:
            job = _xzg_decode_jobs.get(job_id)
            if job:
                job['peaks'] = peaks
                job['duration'] = actual_duration
                job['progress'] = 1.0
                job['decoded_time'] = actual_duration
                job['done'] = True
                job['finished_at'] = time.time()
    except Exception as e:
        with _xzg_decode_jobs_lock:
            job = _xzg_decode_jobs.get(job_id)
            if job:
                job['error'] = str(e)
                job['done'] = True
                job['finished_at'] = time.time()


class XiaozhuguangAudioLoader:
    """
    小珠光音频加载器
    使用 FFmpeg 加载音频文件，支持波形显示、音频截断
    """

    @classmethod
    def INPUT_TYPES(cls):
        input_dir = _safe_dir('get_input_directory',  'input')
        files = []
        try:
            if os.path.isdir(input_dir):
                for f in os.listdir(input_dir):
                    fp = os.path.join(input_dir, f)
                    if os.path.isfile(fp):
                        ext = os.path.splitext(f)[1].lower().lstrip('.')
                        if ext in AUDIO_EXTENSIONS:
                            files.append(f)
        except Exception:
            pass
        return {
            "required": {
                "音频": (sorted(files),),
                "起始时间(秒)": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 86400.0, "step": 0.1}),
                "时长(秒)": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 86400.0, "step": 0.1}),
                "音量": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 3.0, "step": 0.01}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("AUDIO",)
    RETURN_NAMES = ("音频",)
    FUNCTION = "load_audio"
    CATEGORY = "xiaozhuguang"

    def load_audio(self, 音频, **kwargs):
        # 兼容不同参数名（带括号或下划线）
        起始时间_秒 = kwargs.get("起始时间(秒)", kwargs.get("起始时间_秒", 0.0))
        时长_秒 = kwargs.get("时长(秒)", kwargs.get("时长_秒", 0.0))
        音量 = kwargs.get("音量", 1.0)
        audio_path = folder_paths.get_annotated_filepath(音频)
        if not audio_path or not os.path.isfile(audio_path):
            raise ValueError(f"Invalid audio file: {音频}")

        # 先探测音频信息
        info = probe_audio_info(audio_path)
        sr = info['sample_rate'] if info else 44100
        total_duration = info['duration'] if info and info['duration'] > 0 else 0.0

        start_time = max(0.0, float(起始时间_秒))

        # 限制起始时间不超过总时长
        if total_duration > 0 and start_time >= total_duration:
            start_time = max(0.0, total_duration - 0.01)

        # 计算时长，限制不超过总时长 - 起始时间
        duration = float(时长_秒) if 时长_秒 > 0 else None
        if duration is not None and total_duration > 0:
            max_dur = total_duration - start_time
            if duration > max_dur:
                duration = max(max_dur, 0.01)

        # 加载完整音频用于生成波形
        full_waveform, _ = load_audio(audio_path, start_time=0.0, duration=None, sample_rate=sr)

        # 加载截断后的音频
        waveform, sample_rate = load_audio(audio_path, start_time=start_time, duration=duration, sample_rate=sr)

        # 应用音量增益
        vol = max(0.0, min(3.0, float(音量)))
        if waveform is not None and vol != 1.0:
            waveform = waveform * vol
            waveform = torch.clamp(waveform, -1.0, 1.0)
        if full_waveform is not None and vol != 1.0:
            full_waveform = full_waveform * vol
            full_waveform = torch.clamp(full_waveform, -1.0, 1.0)

        if waveform is None or waveform.numel() == 0:
            audio_samples = max(int(sample_rate * (duration or 1.0)), 1)
            waveform = torch.zeros(1, 2, audio_samples, dtype=torch.float32)
            audio = {
                "waveform": waveform,
                "sample_rate": sample_rate,
            }
        else:
            audio = {
                "waveform": waveform.unsqueeze(0),
                "sample_rate": sample_rate,
            }

        # 生成完整波形的峰值数据（用于前端显示）
        full_peaks = generate_waveform_peaks(full_waveform, WAVEFORM_SAMPLES)

        # 生成截断后波形的峰值数据
        cut_peaks = generate_waveform_peaks(waveform, WAVEFORM_SAMPLES)

        # 计算实际时长
        actual_duration = waveform.shape[-1] / sample_rate if waveform is not None and waveform.shape[-1] > 0 else 0.0

        audio_info = {
            "filename": 音频,
            "sample_rate": sample_rate,
            "channels": waveform.shape[1] if waveform is not None else 2,
            "total_duration": info['duration'] if info else 0.0,
            "start_time": start_time,
            "duration": duration if duration else (info['duration'] - start_time if info else 0.0),
            "actual_duration": actual_duration,
            "full_peaks": full_peaks,
            "cut_peaks": cut_peaks,
            "bitrate": info['bitrate'] if info else 0,
        }

        # 用 ui 返回波形数据给前端
        return {
            "result": (audio,),
            "ui": {
                "audio_info": [audio_info],
            },
        }

    @classmethod
    def IS_CHANGED(cls, 音频, **kwargs):
        try:
            path = folder_paths.get_annotated_filepath(音频)
            return calculate_file_hash(path)
        except Exception:
            return "0"

    @classmethod
    def VALIDATE_INPUTS(cls, 音频, **kwargs):
        if not folder_paths.exists_annotated_filepath(音频):
            return f"Invalid audio file: {音频}"
        return True


# 注册 API 路由
# 防御性：只有 PromptServer 已初始化 instance 时注册路由，避免直接 import 测试时炸
if getattr(PromptServer, 'instance', None) is not None:
    @PromptServer.instance.routes.get("/xzg/audio_waveform")
    @xzg_safe_handler
    async def get_audio_waveform(request):
        """获取音频波形数据（前端预览用，无需完整执行节点）"""
        filename = request.query.get("filename", "")
        if not filename:
            return web.json_response({"error": "filename is required"}, status=400)

        try:
            audio_path = folder_paths.get_annotated_filepath(filename)
        except Exception:
            return web.json_response({"error": "file not found"}, status=404)

        if not audio_path or not os.path.isfile(audio_path):
            return web.json_response({"error": "file not found"}, status=404)

        info = probe_audio_info(audio_path)
        sr = info['sample_rate'] if info else 44100

        # 峰值缓存命中：直接返回（此端点为旧版前端回退路径，同样免重复解码）
        cached = _xzg_get_cached_peaks(audio_path)
        if cached is not None:
            return web.json_response({
                "filename": filename,
                "duration": cached['duration'],
                "sample_rate": cached['sample_rate'],
                "channels": info['channels'] if info else 2,
                "peaks": cached['peaks'],
            })

        waveform, _ = load_audio(audio_path, start_time=0.0, duration=None, sample_rate=sr)
        peaks = generate_waveform_peaks(waveform, WAVEFORM_SAMPLES)
        decoded_duration = (waveform.shape[-1] / sr) if waveform is not None and waveform.shape[-1] > 0 else 0.0

        # 解码成功 → 写入峰值缓存
        if waveform is not None and waveform.shape[-1] > 0:
            _xzg_store_peaks(audio_path, peaks, decoded_duration, sr)

        return web.json_response({
            "filename": filename,
            "duration": info['duration'] if info else 0.0,
            "sample_rate": sr,
            "channels": info['channels'] if info else 2,
            "peaks": peaks,
        })

    @PromptServer.instance.routes.post("/xzg/audio_decode_start")
    @xzg_safe_handler
    async def start_audio_decode(request):
        """启动音频解码任务（带进度跟踪），返回 job_id"""
        data = await request.json()
        filename = data.get("filename", "")
        if not filename:
            return web.json_response({"error": "filename is required"}, status=400)

        try:
            audio_path = folder_paths.get_annotated_filepath(filename)
        except Exception:
            return web.json_response({"error": "file not found"}, status=404)

        if not audio_path or not os.path.isfile(audio_path):
            return web.json_response({"error": "file not found"}, status=404)

        # 清理旧任务
        _xzg_cleanup_old_jobs()

        # 峰值缓存命中：直接返回已完成的 job，跳过 FFmpeg 解码线程
        # （同一文件切换工作流/刷新页面时波形秒出）
        cached = _xzg_get_cached_peaks(audio_path)
        if cached is not None:
            job_id = str(uuid.uuid4())
            with _xzg_decode_jobs_lock:
                _xzg_decode_jobs[job_id] = {
                    'progress': 1.0,
                    'decoded_time': cached['duration'],
                    'total_duration': cached['duration'],
                    'sample_rate': cached['sample_rate'],
                    'done': True,
                    'error': None,
                    'peaks': cached['peaks'],
                    'duration': cached['duration'],
                    'created_at': time.time(),
                    'finished_at': time.time(),
                }
            return web.json_response({
                "job_id": job_id,
                "total_duration": cached['duration'],
                "sample_rate": cached['sample_rate'],
                "cached": True,
            })

        info = probe_audio_info(audio_path)
        sr = info['sample_rate'] if info else 44100
        total_duration = info['duration'] if info else 0.0

        job_id = str(uuid.uuid4())
        with _xzg_decode_jobs_lock:
            _xzg_decode_jobs[job_id] = {
                'progress': 0.0,
                'decoded_time': 0.0,
                'total_duration': total_duration,
                'sample_rate': sr,
                'done': False,
                'error': None,
                'peaks': None,
                'duration': 0.0,
                'created_at': time.time(),
                'finished_at': None,
            }

        # 在后台线程中解码
        thread = threading.Thread(
            target=_xzg_decode_audio_thread,
            args=(audio_path, sr, job_id, total_duration),
            daemon=True
        )
        thread.start()

        return web.json_response({
            "job_id": job_id,
            "total_duration": total_duration,
            "sample_rate": sr,
        })

    @PromptServer.instance.routes.get("/xzg/audio_decode_progress")
    @xzg_safe_handler
    async def poll_audio_decode_progress(request):
        """轮询音频解码进度"""
        job_id = request.query.get("job_id", "")
        if not job_id:
            return web.json_response({"error": "job_id is required"}, status=400)

        with _xzg_decode_jobs_lock:
            job = _xzg_decode_jobs.get(job_id)
            if job is None:
                return web.json_response({"error": "job not found"}, status=404)

            result = {
                "progress": job['progress'],
                "decoded_time": job['decoded_time'],
                "total_duration": job['total_duration'],
                "done": job['done'],
                "error": job['error'],
            }
            if job['done'] and job['peaks'] is not None:
                result['peaks'] = job['peaks']
                result['duration'] = job['duration']
                result['sample_rate'] = job['sample_rate']

        # 定期清理过期任务
        _xzg_cleanup_old_jobs()

        return web.json_response(result)

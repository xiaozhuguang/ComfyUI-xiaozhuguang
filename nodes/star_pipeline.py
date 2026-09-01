# -*- coding: utf-8 -*-
"""Star Upscale pipeline - pure functions (testable outside ComfyUI).

完全集成自 ComfyUI-TopazStarlight（本文件对应原 star_pipeline.py），
随小珠光插件分发。引擎固定位于 <ComfyUI>/models/star_upscale，与本文件位置无关。

Single-engine support (2026-08-31):
  - upscaleserver/   = 1.7.1 engine  -> 2.6 (slp-26), Astra family incl. Fast
Engine is chosen per model_id. Each engine uses its bundled ffmpeg (binstar).
Astra-family models require >= 9 input frames (short-clip path is broken).
"""
import os, subprocess, sys, shutil, tempfile, uuid
from pathlib import Path

# 本文件位于 <ComfyUI>/custom_nodes/ComfyUI-xiaozhuguang/nodes/star_pipeline.py
_NODE_DIR   = Path(__file__).resolve().parent               # .../ComfyUI-xiaozhuguang/nodes
_PLUGIN_DIR = _NODE_DIR.parent                              # .../ComfyUI-xiaozhuguang
# 引擎固定位于 <ComfyUI>/models/star_upscale（无论插件放在哪个 custom_nodes 子目录都成立）
_ENGINE     = _PLUGIN_DIR.parent.parent / 'models' / 'star_upscale'
_COMFY_ROOT = _PLUGIN_DIR.parent.parent                     # .../ComfyUI

_TVMD = _NODE_DIR / 'tvmd'          # 干净授权目录 (随节点分发, 1KB)

# 模型 -> 引擎目录 / ffmpeg 目录
MODEL_ENGINE = {
    'slp-26':      ('upscaleserver', 'binstar'),   # 2.6 模型 -> 1.7.1 引擎
    'astra':       ('upscaleserver', 'binstar'),   # Astra 家族 -> 1.7.1 引擎
    'astrahq':     ('upscaleserver', 'binstar'),
    'astrasharp':  ('upscaleserver', 'binstar'),
    'astrafast':   ('upscaleserver', 'binstar'),
}
ASTRA_MODELS = ('astra', 'astrahq', 'astrasharp', 'astrafast')
MIN_FRAMES_ASTRA = 9   # Astra 家族最短帧数 (两版引擎均验证: <9 帧走坏路径)

# ── h264 编码器自动选择：优先硬件 nvenc（要求能真正加载 libnvidia-encode.so），
#    不可用时回退软件 libx264（跨平台 / 云镜像稳定）。结果按 ffmpeg 路径缓存。
#    注意：h264_nvenc 能被 `-encoders` 列出 ≠ .so 能加载（晨羽云 这类镜像即如此），
#    因此必须做一次真实短编码探测才能判定可用性。
_ENC_CACHE: dict = {}


def _probe_encoder(exe, enc):
    """用 16x16 灰帧做一次 1s 真实编码，验证该编码器确实能跑通。"""
    exe = str(exe)
    out = os.path.join(tempfile.gettempdir(),
                       f'xzg_enc_{uuid.uuid4().hex[:8]}.mp4')
    try:
        cmd = [exe, '-y', '-loglevel', 'error',
               '-f', 'lavfi', '-i', 'color=c=gray:s=16x16:d=1',
               '-c:v', enc, '-pix_fmt', 'yuv420p', '-t', '1', out]
        r = subprocess.run(cmd, capture_output=True)
        return r.returncode == 0 and os.path.isfile(out) and os.path.getsize(out) > 0
    except Exception:
        return False
    finally:
        try:
            if os.path.isfile(out):
                os.remove(out)
        except OSError:
            pass


def _resolve_h264_encoder(exe):
    """返回该 ffmpeg 实际可用的 h264 编码器名：优先 nvenc，失败回退 libx264。"""
    exe = str(exe)
    if exe in _ENC_CACHE:
        return _ENC_CACHE[exe]
    enc = 'h264_nvenc' if _probe_encoder(exe, 'h264_nvenc') else 'libx264'
    _ENC_CACHE[exe] = enc
    return enc


def _h264_encode_args(exe, qp):
    """生成该 ffmpeg 的 h264 编码参数（-c:v ...）：nvenc 用硬件参数，否则软件。"""
    enc = _resolve_h264_encoder(exe)
    if enc == 'h264_nvenc':
        return ['-c:v', 'h264_nvenc', '-preset', 'p7', '-tune', 'hq',
                '-rc', 'constqp', '-qp', str(qp), '-pix_fmt', 'yuv420p']
    # 软件退路：crf 语义与 constqp qp 近似（值越小越无损）
    return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', str(qp),
            '-pix_fmt', 'yuv420p']


def _ns_encode_string(exe):
    """神经服务器 --ffmpeg-encoding 用参数串：按实际编码器返回对应配置。"""
    enc = _resolve_h264_encoder(exe)
    if enc == 'h264_nvenc':
        return ('-c:v h264_nvenc -profile:v high -pix_fmt yuv420p -g 30 -preset p7 '
                '-tune hq -rc constqp -qp 18 -rc-lookahead 20 -spatial_aq 1 '
                '-aq-strength 15 -b:v 0 -bf 0')
    return ('-c:v libx264 -profile:v high -pix_fmt yuv420p -g 30 '
            '-crf 18 -preset veryfast')

# ffmpeg 运行冒烟检测结果缓存 (避免每次调用都起子进程)
_FFMPEG_PROBE_CACHE: dict = {}

def _probe_ffmpeg(exe):
    """冒烟检测 ffmpeg 是否可运行 (跳过缺 DLL / 损坏的构建).
    部分构建复制过来时没带配套 DLL, `-version` 直接 STATUS_DLL_NOT_FOUND 崩溃."""
    exe = str(exe)
    if exe in _FFMPEG_PROBE_CACHE:
        return _FFMPEG_PROBE_CACHE[exe]
    ok = False
    try:
        r = subprocess.run([exe, '-version'], capture_output=True, timeout=15)
        ok = r.returncode == 0
    except Exception:
        ok = False
    _FFMPEG_PROBE_CACHE[exe] = ok
    return ok


def _resolve_ffprobe(ffmpeg_path):
    """由 ffmpeg 路径推断同名 ffprobe (大小写无关), 兜底用 PATH 上的 ffprobe."""
    dp = Path(ffmpeg_path)
    cand = dp.with_name('ffprobe.exe')
    if cand.is_file():
        return str(cand)
    p = shutil.which('ffprobe')
    return p if p else str(cand)


def _ffmpeg_for(model_id):
    """返回 (ffmpeg.exe, ffprobe.exe) 绝对路径, 按模型选引擎配套 ffmpeg."""
    _, ff_dir = MODEL_ENGINE.get(model_id, ('upscaleserver', 'binstar'))
    cand = [
        _ENGINE / ff_dir / 'ffmpeg.exe',
        _ENGINE / 'binstar' / 'ffmpeg.exe',
        _COMFY_ROOT.parent / 'ffmpeg' / 'bin' / 'ffmpeg.exe',
        Path(r'D:\APP\ffmpeg\bin\ffmpeg.exe'),
    ]
    for c in cand:
        if c.is_file() and _probe_ffmpeg(c):
            return str(c), _resolve_ffprobe(c)
    w = shutil.which('ffmpeg')
    if w and _probe_ffmpeg(w):
        return w, _resolve_ffprobe(w)
    raise RuntimeError('ffmpeg not found - install ffmpeg or put it on PATH')


# --------------------------------------------------------------------------
# engine detection
# --------------------------------------------------------------------------

def _find_bundled(model_id='slp-26'):
    eng_dir, _ = MODEL_ENGINE.get(model_id, ('upscaleserver', 'binstar'))
    ns = _ENGINE / eng_dir / 'neuroserver.exe'
    if ns.is_file():
        tvmd = _ENGINE / 'tvmd'
        return {
            'name': 'bundled(%s)' % eng_dir,
            'ns': str(ns),
            'model_store': str(_ENGINE / 'models'),
            'tvai_dir': str(tvmd) if (tvmd / 'VR.lic').is_file() else str(_TVMD),
            'lic': str(_TVMD / 'VR.lic') if not (tvmd / 'VR.lic').is_file() else str(tvmd / 'VR.lic'),
        }
    return None


def _resolve_engine(model_id='slp-26'):
    e = _find_bundled(model_id)
    if e is None:
        raise RuntimeError('未找到引擎: 请把 star_upscale 放在 ComfyUI 目录的 models 下')
    return e


def _ensure_tvmd():
    if not (_TVMD / 'VR.lic').is_file():
        _TVMD.mkdir(parents=True, exist_ok=True)
        for cand in (_ENGINE / 'tvmd',):
            if (cand / 'VR.lic').is_file():
                shutil.copy(cand / 'VR.lic', _TVMD / 'VR.lic')
                shutil.copy(cand / 'VR.lic', _TVMD / 'Topaz.lic')
                break


def engine_info(model_id='slp-26'):
    e = _resolve_engine(model_id)
    return e['name'], e['ns'], e['model_store']


def _node_ffmpeg():
    """节点自用 ffmpeg (写临时视频/读回输出): 优先全功能版 (软解h264 + nvenc).
    binstar 是 1.7.1 引擎特供 (禁软解, 带 tvai_up), 不能用于节点读写.
    候选先做运行冒烟检测, 自动跳过缺 DLL 的损坏构建."""
    cand = [
        _ENGINE / 'bin' / 'ffmpeg.exe',
        _COMFY_ROOT.parent / 'ffmpeg' / 'bin' / 'ffmpeg.exe',   # ComfyUI-aki 自带全功能版
        _ENGINE / 'binstar' / 'ffmpeg.exe',
        Path(r'D:\APP\ffmpeg\bin\ffmpeg.exe'),
    ]
    for c in cand:
        if c.is_file() and _probe_ffmpeg(c):
            return str(c), _resolve_ffprobe(c)
    w = shutil.which('ffmpeg')
    if w and _probe_ffmpeg(w):
        return w, _resolve_ffprobe(w)
    raise RuntimeError('ffmpeg not found - install ffmpeg or put it on PATH')


def write_frames_to_video(frames_uint8, fps, path, qp=14):
    """frames_uint8: (B,H,W,3) uint8 RGB -> h264 mp4 (优先 nvenc，无则软件 libx264)."""
    ffmpeg, _ = _node_ffmpeg()
    b, h, w, c = frames_uint8.shape
    cmd = [ffmpeg, '-y', '-loglevel', 'error',
           '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{w}x{h}', '-r', str(fps), '-i', '-',
           ] + _h264_encode_args(ffmpeg, qp) + [path]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    _, err = p.communicate(input=frames_uint8.tobytes())
    if p.returncode != 0:
        raise RuntimeError(f'ffmpeg encode failed: {err.decode(errors="replace")[:300]}')


import re as _re
_PROGRESS_JSON = _re.compile(r'"status"\s*:\s*"RUNNING"[^}]*?"progress"\s*:\s*(\d+)(?:\.\d+)?', _re.IGNORECASE)
_FRAME_PROG = _re.compile(r'(\d+)\s*[/of:]\s*/\s*(\d+)', _re.IGNORECASE)


def run_upscale(in_path, out_path, scale, frames, w, h, strength=1.0, model_id='slp-26', log=print,
                max_gpu_mem=16, on_progress=None):
    """Run the neuroserver on a video file (engine chosen per model_id).

    on_progress(current, total) 可选回调: 每次从 stdout 中发现 frame 进度时触发,
    current 0..total。用于把进度条渲染到节点上。
    """
    if model_id in ASTRA_MODELS and frames < MIN_FRAMES_ASTRA:
        raise RuntimeError(
            f'Astra 系列模型需要至少 {MIN_FRAMES_ASTRA} 帧输入 (当前 {frames} 帧), '
            '两版引擎的短视频路径均存在缺陷。请用更长的视频 (或提高帧率)。')

    eng = _resolve_engine(model_id)
    ffmpeg, ffprobe = _ffmpeg_for(model_id)
    env = os.environ.copy()
    # 神经服务器内部也会调 ffmpeg/ffprobe，子进程 PATH 必须能找到 (1.7.1 必须自带版)
    env['PATH'] = str(Path(ffmpeg).parent) + os.pathsep + env.get('PATH', '')
    env['TOPAZ_MODEL_STORE'] = eng['model_store']
    if eng['tvai_dir']:
        env['TVAI_MODEL_DIR'] = eng['tvai_dir']
        env['TOPAZLABS_LICENSE'] = eng['lic']
    else:
        env.pop('TVAI_MODEL_DIR', None)
        env.pop('TOPAZLABS_LICENSE', None)
    if model_id == 'slp-26':
        # 1.7.1 GUI 原版参数: 2.6 模型带 softness(默认1), Astra 家族不带
        filters = '[{"model": "%s", "enhancement_strength": %s, "softness": 1}]' % (model_id, strength)
    else:
        filters = '[{"model": "%s", "enhancement_strength": %s}]' % (model_id, strength)
    # 输出尺寸取整并对齐到偶数（h264/yuv420p 要求偶数宽高）
    ow = int(round(w * scale)); ow += ow % 2
    oh = int(round(h * scale)); oh += oh % 2
    cmd = [eng['ns'], '--once',
           '--input-path', in_path,
           '--output-path', out_path,
           '--start-frame-idx', '0',
           '--end-frame-idx', str(frames),
           '--max-gpu-mem', str(max_gpu_mem),
           '--filters', filters,
           '--output-width', str(ow),
           '--output-height', str(oh),
           '--upscale-factor', str(scale),
           '--ffmpeg-encoding', _ns_encode_string(ffmpeg)]
    log('  [StarUpscale] 开始处理 ...')
    proc = subprocess.Popen(cmd, env=env, cwd=str(Path(eng['ns']).parent),
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                            encoding='utf-8', errors='replace')
    bar = _make_terminal_bar(frames, model_id)
    pbar_cur = [0]
    try:
        _check_interrupt()
        for line in proc.stdout:
            _check_interrupt()
            line = line.rstrip()
            if line and _want_log(line):
                log('  [StarUpscale] ' + line)
            cur = _parse_progress(line, frames)
            if cur is not None and cur > pbar_cur[0]:
                delta = cur - pbar_cur[0]
                pbar_cur[0] = cur
                if on_progress:
                    on_progress(cur, frames)
                if bar is not None:
                    bar.update(delta)
    finally:
        if bar is not None:
            if pbar_cur[0] < frames:
                bar.update(frames - pbar_cur[0])
            bar.close()
        if proc.poll() is None:          # 中断或异常: 强制终止子进程, 避免僵尸占显存
            try:
                proc.terminate()
                proc.wait(timeout=5)
            except Exception:
                proc.kill()
    proc.wait()
    if proc.returncode != 0:
        raise RuntimeError(f'neuroserver failed (exit {proc.returncode})')
    if not os.path.isfile(out_path):
        raise RuntimeError('neuroserver produced no output file')


_NOISE_MARK = ('INFO:interface', 'INFO:topserving', 'INFO:local_model_service',
               'INFO:models.',  'sys.path', 'TOPAZ_RUNNER_DIR', 'TOPAZ_MODEL_STORE',
               'USE_DML', 'Windows Version', 'platform:', 'Machine ID', 'Auth file does not exist',
               'Watermark', 'has valid license', 'License checked out', 'Getting model for request',
               'Available GPUs', 'GPU name for', 'GPU manufacture', 'torch version',
               'VariablePool', 'Phase 1', 'Phase 2', 'DiT tiling')
_WANT_MARK = ('single_shot_process', 'error', 'ERROR', 'Error', 'failed', 'Traceback',
              'Exception', 'INVALID', 'WARNING')
# 引擎模型服务诊断噪音 (WARNING:models. 前缀的权重校验/分块提示等, 无害但刷屏),
# 必须优先于 _WANT_MARK 判定, 否则 "WARNING" 命中保留标记仍会打印。
_SUPPRESS_MARK = ('WARNING:models.',)


def _want_log(line):
    """过滤神经服务器的自检/启动噪音, 只保留关键进展与错误行."""
    low = line.strip()
    if not low:
        return False
    # 进度 JSON 不打印 (避免刷屏), 但其数据仍被 _parse_progress 用来驱动进度条
    if _PROGRESS_JSON.search(low):
        return False
    # 引擎模型服务诊断噪音 -> 静默 (如 Weight verification skipped / got N frames instead of M)
    if any(k in low for k in _SUPPRESS_MARK):
        return False
    if any(k.lower() in low.lower() for k in _WANT_MARK):
        return True
    # 自检/启动/处理细节噪音 -> 静默
    if any(k in low for k in _NOISE_MARK):
        return False
    return True


def _parse_progress(line, frames):
    """从神经服务器单行输出解析当前完成帧数(0..frames), 无进度则返回 None."""
    if line[:1] == '\r':
        line = line[1:]
    mj = _PROGRESS_JSON.search(line)
    if mj:
        return frames * int(mj.group(1)) // 100
    m = _FRAME_PROG.search(line)
    if m:
        total = int(m.group(2))
        if total > 0:
            return min(int(m.group(1)), total)
    return None


def _make_terminal_bar(total, model_id):
    """后端终端 tqdm 进度条 (采样器风格)。非 TTY 或不可用时返回 None."""
    if not total:
        return None
    try:
        import sys as _sys
        if not _sys.stderr.isatty():
            return None
        from tqdm import tqdm
        return tqdm(total=total, desc='Star[%s]' % model_id, unit='帧',
                    leave=False, dynamic_ncols=True)
    except Exception:
        return None


def _check_interrupt():
    """ComfyUI 中断检查: 命中则抛异常 (节点层会被执行引擎捕获为取消/false 输出)."""
    from comfy import model_management
    model_management.throw_exception_if_processing_interrupted()


def read_video_to_frames(path):
    """mp4 -> (B,H,W,3) uint8 RGB numpy array.

    解码到临时 raw 文件再读回, 不走 stdout 管道——超大原始数据经管道传给父进程时,
    Windows 下易触发 "[out#0/rawvideo] Error submitting a packet to the muxer:
    Broken pipe" 一类的管道断裂导致读取失败。
    """
    import numpy as np
    ffmpeg, ffprobe = _node_ffmpeg()
    probe = subprocess.run([ffprobe, '-v', 'error', '-select_streams', 'v:0',
                            '-show_entries', 'stream=width,height',
                            '-of', 'csv=p=0', path], capture_output=True, text=True)
    w, h = probe.stdout.strip().split(',')
    w, h = int(w), int(h)
    raw_path = path + '.raw'
    try:
        p = subprocess.run([ffmpeg, '-loglevel', 'error', '-y', '-i', path,
                            '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw_path],
                           capture_output=True)
        if p.returncode != 0:
            raise RuntimeError(f'ffmpeg decode failed: {p.stderr.decode(errors="replace")[:300]}')
        raw = np.fromfile(raw_path, dtype=np.uint8)
    finally:
        try:
            if os.path.isfile(raw_path):
                os.remove(raw_path)
        except OSError:
            pass
    n = raw.size // (w * h * 3)
    return raw[: n * w * h * 3].reshape(n, h, w, 3)

"""
小珠光视频保存
参考 VHS VideoCombine 节点，将图像序列合并为视频
支持 mp4/webm/gif 格式，可选音频合并
"""

import os
import sys
import subprocess
import json
import re
import numpy as np
import torch
from PIL import Image
from datetime import datetime
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


# ---------- 自定义输出目录支持（与「小珠光图像保存-自定义输出」同一套约定） ----------
# 关闭「默认输出」后 base_dir 支持：绝对路径直接使用 / 相对路径拼到 output/ 下 / {date} 等模板
_XZG_INVALID_CHARS_RE = re.compile(r'[<>:"|?*\x00-\x1f]')


def _xzg_is_absolute_path(p: str) -> bool:
    """判断是否为绝对路径（跨平台）。"""
    if not p:
        return False
    # Windows: D:\, D:/, \, / ；Linux/Mac: /home
    if len(p) >= 2 and p[1] == ':' and p[0].isalpha():
        return True
    return p.startswith('/') or p.startswith('\\')


def _xzg_sanitize_path(name: str) -> str:
    r"""把路径中的非法字符替换为 _，保留 / 和 \ 作为路径分隔符，并去掉首尾空白和点。
    Windows 盘符冒号（如 C:）会被保留，避免破坏绝对路径。
    """
    if not name:
        return name
    drive = ""
    m = re.match(r'^([A-Za-z]:)', name)
    if m:
        drive = m.group(1)
        name = name[len(drive):]
    name = _XZG_INVALID_CHARS_RE.sub("_", name)
    name = name.strip().strip(".")
    return drive + name


def _xzg_resolve_template(template: str, context: dict) -> str:
    """把 {date} {time} {datetime} {timestamp_ms} {workflow} {node_id} {format} 占位符替换为实际值。
    不含占位符时原样返回（兼容旧用法）。同一执行共享同一时间戳（context["_now"]）。
    """
    if not template:
        return template
    now: datetime = context.get("_now") or datetime.now()
    import time as _time
    replacements = {
        "{date}": now.strftime("%Y-%m-%d"),
        "{time}": now.strftime("%H%M%S"),
        "{datetime}": now.strftime("%Y%m%d-%H%M%S"),
        "{timestamp_ms}": str(int(_time.time() * 1000)),
        "{workflow}": _xzg_sanitize_path(str(context.get("workflow_name", "untitled"))) or "untitled",
        "{node_id}": str(context.get("node_id", "")),
        "{format}": str(context.get("format", "")),
    }
    result = template
    for k, v in replacements.items():
        result = result.replace(k, v)
    return result


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


BIGMAX = int(1e9)
ENCODE_ARGS = ['utf-8', 'replace']


def ffmpeg_suitability(path):
    """评估 ffmpeg 的适用性，参考 VHS 的实现"""
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
    """参考 VHS 的 ffmpeg 路径检测逻辑"""
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
        print("[小珠光视频合并] No valid ffmpeg found.")
        return None
    elif len(ffmpeg_paths) == 1:
        return ffmpeg_paths[0]
    else:
        return max(ffmpeg_paths, key=ffmpeg_suitability)


ffmpeg_path = _get_ffmpeg_path()


# 视频格式定义（参考 VHS video_formats 目录的 JSON 配置）
VIDEO_FORMATS = {
    "mp4": {
        "extension": "mp4",
        "main_pass": [
            "-n", "-c:v", "libx264",
            "-pix_fmt", "yuv420p",
            "-crf", "16",
            "-preset", "slow",
            "-tune", "film",
            "-aq-mode", "3",
            "-vf", "scale=out_color_matrix=bt709",
            "-color_range", "tv", "-colorspace", "bt709",
            "-color_primaries", "bt709", "-color_trc", "bt709",
        ],
        "audio_pass": ["-c:a", "aac", "-movflags", "use_metadata_tags"],
    },
    "webm": {
        "extension": "webm",
        "main_pass": [
            "-n",
            "-pix_fmt", "yuv420p",
            "-crf", "20",
            "-b:v", "0",
            "-vf", "scale=out_color_matrix=bt709",
            "-color_range", "tv", "-colorspace", "bt709",
            "-color_primaries", "bt709", "-color_trc", "bt709",
        ],
        "audio_pass": ["-c:a", "libvorbis"],
    },
    "gif": {
        "extension": "gif",
        "main_pass": [
            "-n", "-loop", "0",
            "-vf", "split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse",
        ],
        "audio_pass": [],
    },
}


def tensor_to_bytes(tensor):
    """将图像 tensor 转换为 uint8 bytes"""
    return tensor_to_int(tensor, 8).astype(np.uint8)


def tensor_to_int(tensor, bits):
    """参考 VHS tensor_to_int，将浮点 tensor 转为整数数组"""
    tensor = tensor.cpu().numpy()
    return np.clip(tensor, 0, 1) * (2**bits - 1)


def ffmpeg_process(args, file_path, env):
    """参考 VHS ffmpeg_process 的生成器协程实现

    通过 yield 接收每帧的字节数据，写入 ffmpeg 的 stdin。
    使用 with 上下文管理器确保进程正确退出。
    """
    res = b''
    frame_data = yield
    total_frames_output = 0
    with subprocess.Popen(args + [file_path], stderr=subprocess.PIPE,
                          stdin=subprocess.PIPE, env=env) as proc:
        try:
            while frame_data is not None:
                proc.stdin.write(frame_data)
                frame_data = yield
                total_frames_output += 1
            proc.stdin.flush()
            proc.stdin.close()
            res = proc.stderr.read()
        except BrokenPipeError as e:
            err = proc.stderr.read()
            raise RuntimeError("An error occurred in the ffmpeg subprocess:\n" \
                    + err.decode(*ENCODE_ARGS))
    yield total_frames_output
    if len(res) > 0:
        print(res.decode(*ENCODE_ARGS), end="", file=sys.stderr)


def _build_main_pass(format_name, crf):
    """根据 CRF 值构建主编码参数，动态替换 -crf 值"""
    base = list(VIDEO_FORMATS[format_name]["main_pass"])
    if format_name == "mp4":
        crf_val = max(0, min(51, crf))
        for i, arg in enumerate(base):
            if arg == "-crf" and i + 1 < len(base):
                base[i + 1] = str(crf_val)
                break
    elif format_name == "webm":
        # 将 mp4 的 CRF 范围 0-51 等比映射到 webm 的 0-63
        crf_val = max(0, min(63, round(crf * 63 / 51)))
        for i, arg in enumerate(base):
            if arg == "-crf" and i + 1 < len(base):
                base[i + 1] = str(crf_val)
                break
    # gif 无 CRF 参数，不做修改
    return base


def export_to_video(image_tensors, output_file, frame_rate, format="mp4",
                    audio=None, crf=16):
    """将图像 tensor 列表导出为视频文件

    完全参考 VHS 的实现：
    - 视频帧通过生成器协程逐帧写入 ffmpeg stdin
    - 音频采用第二次 ffmpeg 调用，通过 stdin 传入 f32le PCM 数据
    - 使用 -c:v copy 避免视频重新编码
    - crf：0-51 CRF 值，越低画质越好（文件越大），默认 16
    """
    if ffmpeg_path is None:
        raise RuntimeError("FFmpeg is required but not found")

    if not isinstance(image_tensors, torch.Tensor) or image_tensors.size(0) == 0:
        raise ValueError("No images to combine")

    num_frames = image_tensors.size(0)
    first_image = image_tensors[0]
    # 取消维度扩展（如果有）
    while first_image.dim() > 3:
        first_image = first_image[0]
    height, width = first_image.shape[0], first_image.shape[1]
    has_alpha = first_image.shape[-1] == 4

    video_format = VIDEO_FORMATS.get(format)
    if video_format is None:
        raise ValueError(f"Unsupported format: {format}")

    if has_alpha:
        i_pix_fmt = "rgba"
    else:
        i_pix_fmt = "rgb24"

    # 构建 ffmpeg 命令（参考 VHS 的 args 构建）
    dimensions = f"{width}x{height}"
    args = [ffmpeg_path, "-v", "error", "-f", "rawvideo", "-pix_fmt", i_pix_fmt,
            "-color_range", "pc", "-colorspace", "rgb", "-color_primaries", "bt709",
            "-color_trc", "iec61966-2-1",
            "-s", dimensions, "-r", str(frame_rate), "-i", "-"]

    # 主编码参数（根据 CRF 动态设置）
    args += _build_main_pass(format, crf)

    # 环境变量（参考 VHS）
    env = os.environ.copy()

    # 启动 ffmpeg 生成器协程
    pbar = ProgressBar(num_frames)
    output_process = ffmpeg_process(args, output_file, env)
    output_process.send(None)  # 启动生成器

    # 逐帧写入
    for i in range(num_frames):
        img = image_tensors[i]
        while img.dim() > 3:
            img = img[0]
        img_bytes = tensor_to_bytes(img).tobytes()
        pbar.update(1)
        output_process.send(img_bytes)

    # 关闭管道并等待终止
    try:
        total_frames_output = output_process.send(None)
        output_process.send(None)
    except StopIteration:
        pass

    # 音频合并：参考 VHS，使用第二次 ffmpeg 调用，通过 stdin 传入 f32le 音频数据
    if audio is not None and format != "gif":
        a_waveform = None
        try:
            a_waveform = audio.get("waveform")
        except Exception:
            pass
        if a_waveform is not None:
            sample_rate = audio.get("sample_rate", 44100)
            extension = video_format["extension"]
            output_file_with_audio = output_file[:-len(extension)] + f"-audio.{extension}"
            if not video_format.get("audio_pass"):
                video_format["audio_pass"] = ["-c:a", "libopus"]

            channels = a_waveform.size(1) if a_waveform.dim() >= 2 else 1
            min_audio_dur = total_frames_output / frame_rate + 1
            apad = ["-af", "apad=whole_dur=" + str(min_audio_dur)]

            mux_args = [ffmpeg_path, "-v", "error", "-n", "-i", output_file,
                        "-ar", str(sample_rate), "-ac", str(channels),
                        "-f", "f32le", "-i", "-", "-c:v", "copy"] \
                        + video_format["audio_pass"] \
                        + apad + ["-shortest", output_file_with_audio]

            # 将音频 tensor 转为 f32le 字节流
            audio_tensor = a_waveform
            if audio_tensor.dim() == 3:
                audio_tensor = audio_tensor.squeeze(0)
            # VHS 使用 .squeeze(0).transpose(0,1) 得到 [samples, channels]
            if audio_tensor.dim() == 2:
                audio_tensor = audio_tensor.transpose(0, 1)
            audio_data = audio_tensor.contiguous().cpu().numpy().tobytes()

            try:
                res = subprocess.run(mux_args, input=audio_data,
                                     env=env, capture_output=True, check=True)
            except subprocess.CalledProcessError as e:
                raise RuntimeError("An error occured in the ffmpeg subprocess:\n" \
                        + e.stderr.decode(*ENCODE_ARGS))
            if res.stderr:
                print(res.stderr.decode(*ENCODE_ARGS), end="", file=sys.stderr)
            # 用带音频的文件替换原文件
            try:
                os.replace(output_file_with_audio, output_file)
            except OSError:
                pass


class XiaozhuguangVideoCombine:
    """
    小珠光视频保存
    将图像序列合并为视频文件，支持 mp4/webm/gif 格式，可选音频合并
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE",),
                "帧率": ("FLOAT", {"default": 8, "min": 1, "step": 1}),
                "文件名前缀": ("STRING", {"default": "xzg_video"}),
                "格式": (["mp4", "webm", "gif"], {"default": "mp4"}),
                "CRF": ("INT", {"default": 16, "min": 0, "max": 51, "step": 1}),
                "模式": (["保存", "预览"], {"default": "保存"}),
            },
            "optional": {
                "音频": ("AUDIO",),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "combine_video"
    CATEGORY = "xiaozhuguang"
    OUTPUT_NODE = True

    def combine_video(self, 图像, 帧率, 文件名前缀, 格式, CRF,
                      模式, 音频=None,
                      prompt=None, extra_pnginfo=None, unique_id=None,
                      use_default_output=True, base_dir="",
                      add_date_stamp=False, add_time_stamp=False):
        if not isinstance(图像, torch.Tensor) or 图像.size(0) == 0:
            return ()

        is_save = (模式 == "保存")
        is_absolute_base = False
        subfolder_extra = ""  # 自定义输出-相对路径：base_dir 目录并入 ui subfolder（供 /view 与达芬奇导出定位）
        if is_save:
            # 保存模式：默认写入 output/（可含用户前缀子目录），返回 type="output"；
            # 关闭「默认输出」后 base_dir 生效：绝对路径直接使用 / 相对路径拼到 output/ 下 /
            # 空值维持 output/ 根目录；base_dir 支持 {date} {time} {datetime} {workflow} 等模板
            output_dir = _safe_dir('get_output_directory', 'output')
            prefix = 文件名前缀 or "xzg_video"
            if not use_default_output:
                wf_name = "untitled"
                if extra_pnginfo and isinstance(extra_pnginfo, dict):
                    wf = extra_pnginfo.get("workflow") or {}
                    name = wf.get("name") or wf.get("filename") or ""
                    if name:
                        base = os.path.splitext(os.path.basename(str(name)))[0]
                        if base:
                            wf_name = base
                # 同一次执行共享同一时间戳，保证同批文件进同一文件夹
                ctx = {
                    "_now": datetime.now(),
                    "workflow_name": wf_name,
                    "node_id": unique_id or "",
                    "format": 格式,
                }
                # 日期戳/时间戳（与小珠光图像保存-化神级同一套约定）：独立开关，
                # 开启时按「日期-时间-文件名前缀」顺序用 - 拼接；仅保存模式的自定义输出生效，
                # 默认输出/预览模式保持原行为，且与 base_dir 模板共享同一时间戳
                _date = _xzg_sanitize_path(_xzg_resolve_template("{date}", ctx)) if add_date_stamp else ""
                _time = _xzg_sanitize_path(_xzg_resolve_template("{time}", ctx)) if add_time_stamp else ""
                _dt = ""
                if _date and _time:
                    _dt = f"{_date}-{_time}"
                elif _date:
                    _dt = _date
                elif _time:
                    _dt = _time
                if _dt:
                    prefix = f"{_dt}-{prefix}" if prefix else _dt
                resolved_base = _xzg_sanitize_path(_xzg_resolve_template(base_dir or "", ctx))
                if resolved_base and _xzg_is_absolute_path(resolved_base):
                    # 绝对路径：直接作为输出根目录（文件在 output/ 之外，预览走会话令牌拉流）
                    output_dir = resolved_base
                    is_absolute_base = True
                elif resolved_base:
                    # 相对路径：拼到 output/ 下；目录并入 subfolder，文件仍可经 /view 访问
                    output_dir = os.path.join(_safe_dir('get_output_directory', 'output'), resolved_base)
                    subfolder_extra = resolved_base
                # base_dir 为空 → 维持 output/ 根目录（与旧行为完全一致）
                os.makedirs(output_dir, exist_ok=True)
        else:
            # 预览模式：写入持久化 output/preview/<节点id>/ 子目录（而非 temp，temp 重启即清，
            # 会导致「重启后文件消失 ↔ 前端判定内容未变不重载」的死循环）。返回 type="output"。
            output_dir = _safe_dir('get_output_directory', 'output')
            node_id = str(unique_id) if unique_id else (文件名前缀 or "preview")
            prefix = os.path.join("preview", node_id, 文件名前缀 or "xzg_video")

        # 输出根目录固定为 output_dir；文件名前缀可含子目录（如 "xzg_video/xxx"），
        # get_save_image_path 会解析出 subfolder 并把文件写到 output_dir/subfolder 下
        # 获取可用的文件计数器（full_output_folder 已包含前缀内的子目录）。
        # 返回顺序：full_output_folder, filename, counter, subfolder, filename_prefix
        full_output_folder, filename, _, subfolder, _ = folder_paths.get_save_image_path(
            prefix, output_dir
        )
        # 自定义输出-相对路径：把 base_dir 相对目录并入 subfolder，使 /view 与达芬奇导出能正确定位
        if subfolder_extra:
            subfolder = os.path.normpath(os.path.join(subfolder_extra, subfolder)) if subfolder else subfolder_extra

        # 计算下一个可用的计数器
        max_counter = 0
        matcher = re.compile(f"{re.escape(filename)}_(\\d+)\\D*\\..+", re.IGNORECASE)
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

        extension = VIDEO_FORMATS[格式]["extension"]
        file = f"{filename}_{counter:05}.{extension}"
        file_path = os.path.join(full_output_folder, file)

        export_to_video(
            image_tensors=图像,
            output_file=file_path,
            frame_rate=帧率,
            format=格式,
            crf=CRF,
            audio=音频,
        )

        # 预览模式：清理本子目录内的旧同前缀文件（只保留最新），避免累积。
        # 每次真实重跑都会因计数器递增而生成新文件名 → 前端 key 变化 → 触发重载刷新预览；
        # 输入未变时节点不会被重跑，文件保持不变 → 前端判定未变化不再读条（保持惰性）。
        if not is_save:
            try:
                for old_name in os.listdir(full_output_folder):
                    if old_name == file:
                        continue
                    if matcher.fullmatch(old_name):
                        try:
                            os.remove(os.path.join(full_output_folder, old_name))
                        except OSError:
                            pass
            except Exception:
                pass

        ui = {
            "result": (),
            "ui": {
                # 单数 video：前端 parseNodeOutput 以数组键名作为 mediaType，
                # isVideo 检查 mediaType==="video"（单数），复数 videos 会退化为依赖文件名后缀识别。
                "video": [{
                    "filename": file,
                    "subfolder": subfolder,
                    # 保存模式输出到 output，返回 "output"；预览模式也写入持久化的
                    # output/preview/<节点id>/ 子目录，故同样返回 "output"（文件跨重启存在）。
                    "type": "output",
                    "format": 格式,
                    "frame_rate": 帧率,
                    # 真实写入帧数：前端播放条总帧数优先采用实测值，
                    # 避免用 容器时长×帧率 推算（音轨尾差会让容器时长虚长，如 459 帧 → 460）
                    "frame_count": int(图像.size(0)),
                    # 磁盘绝对路径（后端解析/达芬奇导入用；不随工作流序列化）。
                    # 绝对路径输出时文件在 output/ 之外，/view 无法服务，
                    # 化神级节点会再注入 abs_token 供前端经 /xzg/davinci/view-abs 拉流预览。
                    "abs_path": file_path,
                    "is_absolute": is_absolute_base,
                }],
                "output_dir": output_dir,
            }
        }
        return ui


# 获取输出目录和临时目录路径的 API 端点
@routes.get("/xzg/get_output_dir")
@xzg_safe_handler
async def xzg_get_output_dir(request):
    return _xzg_web.json_response({
        "output_dir": _safe_dir('get_output_directory', 'output'),
        "temp_dir": _safe_dir('get_temp_directory',   'temp'),
    })

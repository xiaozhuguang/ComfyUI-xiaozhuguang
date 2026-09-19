# -*- coding: utf-8 -*-
"""
小珠光视频加载低内存版
与「小珠光视频加载器」功能/输入输出完全一致，仅优化长视频加载的内存峰值：

A1. 预分配 + 流式堆叠：按探测帧数一次性 np.empty 预分配输出缓冲，ffmpeg 逐帧
    直接写入，砍掉旧实现「frames list → np.stack → astype」的两份完整副本，
    内存峰值从 ~3× 最终结果降到 ~1×（A2 的 uint16 中间缓存在预分配方案下
    反而增加峰值，已被 A1 吸收，不再需要）。

其余行为（预览视频转码、音频提取、视频信息、上传/播放器前端）与原版一致；
前端播放器配套流式音频/流式打开/ LRU 解码器池（见 web/xzg_video_loader.js LM 分支）。
"""
import os
import time

import numpy as np
import torch

from folder_paths import get_annotated_filepath

from comfy.utils import ProgressBar

from .xzg_video_loader import (
    XiaozhuguangVideoLoader,
    ffmpeg_frame_generator,
    extract_audio,
    AUDIO_SAMPLE_RATE,
    FIT_MODE_MAP,
    ENCODE_ARGS,
    _build_framerate_filters,
    _finalize_source_frame_count,
)


class XiaozhuguangVideoLoaderLM(XiaozhuguangVideoLoader):
    """
    小珠光视频加载低内存版
    继承原加载器的全部输入/输出与前端交互，仅重写 load_video 的帧堆叠阶段（A1）：
    预分配输出缓冲 + 逐帧流式写入，消除 list/stack/astype 的整段副本。
    """

    DESCRIPTION = (
        "小珠光视频加载低内存版：与视频加载器功能一致。\n"
        "针对长视频优化内存峰值：帧数据流式写入预分配缓冲（峰值≈最终结果的1倍，"
        "原版≈3倍）；配套前端播放器采用流式打开（整文件不驻留内存）、流式音频"
        "（不整段解码PCM）、LRU解码器池（切换视频自动释放）。"
    )

    def load_video(self, 视频, 强制帧率=0, 视频比例="原始比例", 比例模式="裁剪(crop)", 自定义宽度=0, 自定义高度=0,
                   帧数上限=0, 跳过帧数=0, unique_id=None):
        强制帧率 = int(强制帧率)
        video_path = get_annotated_filepath(视频)
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

        fit_mode = FIT_MODE_MAP.get(比例模式, "crop")

        pbar = ProgressBar(1000)
        pbar.update_absolute(0, 1000)

        def progress_cb(done, total):
            try:
                pct = min(1.0, max(0.0, done / max(1, total)))
                pbar.update_absolute(int(600 * pct), 1000)
            except Exception:
                pass

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
            fit_mode=fit_mode,
            progress_cb=progress_cb,
        )

        info = next(gen)
        (src_w, src_h, src_fps, src_dur, src_frames,
         target_frame_time, yieldable, new_w, new_h, alpha) = info

        # ══ A1：预分配 + 流式堆叠 ═══════════════════════════════════════════
        # 探测帧数为预估（VFR/seek 误差可能偏差 ±1），预留少量余量；
        # 实际超出时按 1.5 倍扩容（历史数据整体复制一次，均摊成本极低）
        ch_count = 4 if alpha else 3
        cap = max(8, int(yieldable) + 8) if yieldable and yieldable > 0 else 64
        buf = np.empty((cap, new_h, new_w, ch_count), np.float32)
        count = 0
        try:
            for frame in gen:
                if count >= buf.shape[0]:
                    grow = np.empty((buf.shape[0] * 3 // 2 + 8, new_h, new_w, ch_count), np.float32)
                    grow[:count] = buf[:count]
                    buf = grow
                buf[count] = frame
                count += 1
        except StopIteration:
            pass

        if count == 0:
            raise RuntimeError("No frames decoded from video")
        pbar.update_absolute(650, 1000)  # 读帧+流式堆叠完成（原版的 600/650 两阶段合一）

        # buf[:count] 是连续视图，torch.from_numpy 零复制
        image_tensor = torch.from_numpy(buf[:count]).view(-1, new_h, new_w, ch_count)

        loaded_fps = 1.0 / target_frame_time if target_frame_time > 0 else src_fps
        loaded_count = image_tensor.shape[0]
        loaded_duration = loaded_count * target_frame_time

        # ── 音频提取（与原版一致）──
        audio_start = 跳过帧数 / src_fps if src_fps > 0 else 0.0
        audio_duration = loaded_duration if loaded_duration > 0 else None
        pbar.update_absolute(700, 1000)
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
        pbar.update_absolute(750, 1000)

        # 全片原样加载时用解码实测帧数修正源总帧数（与加载器一致，播放条分母对齐真实帧数）
        src_frames_final = _finalize_source_frame_count(
            src_frames, loaded_count,
            skip_frames=max(0, int(跳过帧数 or 0)),
            frame_limit=max(0, int(帧数上限 or 0)),
            force_rate=强制帧率,
        )
        video_info = {
            "source_fps": src_fps,
            "source_frame_count": src_frames_final,
            "source_duration": src_dur,
            "source_width": src_w,
            "source_height": src_h,
            "loaded_fps": loaded_fps,
            "loaded_frame_count": loaded_count,
            "loaded_duration": loaded_duration,
            "loaded_width": new_w,
            "loaded_height": new_h,
            "skip_frames": max(0, int(跳过帧数 or 0)),
            "frame_limit": max(0, int(帧数上限 or 0)),
            "filename": 视频,
        }

        # ── 预览视频转码（与原版一致）──
        preview_ui = {}
        try:
            import folder_paths
            import subprocess
            temp_dir = folder_paths.get_temp_directory()
            preview_filename = f"xzg_preview_lm_{unique_id or 'node'}_{int(time.time() * 1000)}.mp4"
            preview_path = os.path.join(temp_dir, preview_filename)

            src_ar = src_w / src_h if src_h > 0 else 1.0
            dst_ar = new_w / new_h if new_h > 0 else 1.0
            vf_parts = []
            if new_w != src_w or new_h != src_h:
                if abs(src_ar - dst_ar) < 0.01:
                    vf_parts.append(f"scale={new_w}:{new_h}:flags=lanczos")
                elif fit_mode == "fill":
                    vf_parts.append(f"scale={new_w}:{new_h}:flags=lanczos")
                elif fit_mode == "letterbox":
                    vf_parts.append(f"scale={new_w}:{new_h}:flags=lanczos:force_original_aspect_ratio=decrease")
                    vf_parts.append(f"pad={new_w}:{new_h}:(ow-iw)/2:(oh-ih)/2:color=black")
                else:
                    vf_parts.append(f"scale={new_w}:{new_h}:flags=lanczos:force_original_aspect_ratio=increase")
                    vf_parts.append(f"crop={new_w}:{new_h}")
                vf_parts.append("setsar=1")
            fr_filters, _is_upscale = _build_framerate_filters(强制帧率, src_fps)
            if _is_upscale:
                fr_filters = [f"fps=fps={强制帧率}:round=down"]
            if fr_filters:
                vf_parts = fr_filters + vf_parts

            from .xzg_video_loader import ffmpeg_path
            cmd = [ffmpeg_path, "-y", "-v", "error"]
            start_time = 跳过帧数 / src_fps if src_fps > 0 else 0.0
            if start_time > 0:
                if start_time > 4:
                    cmd += ["-ss", str(start_time - 4), "-i", video_path, "-ss", "4"]
                else:
                    cmd += ["-ss", str(start_time), "-i", video_path]
            else:
                cmd += ["-i", video_path]

            if 强制帧率 > 0:
                cmd += ["-r", str(强制帧率)]
            if vf_parts:
                cmd += ["-vf", ",".join(vf_parts)]
            if 帧数上限 > 0:
                cmd += ["-frames:v", str(帧数上限)]
            if loaded_duration > 0:
                cmd += ["-t", str(loaded_duration)]

            cmd += ["-c:v", "libx264", "-preset", "fast", "-crf", "23",
                    "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-b:a", "128k",
                    preview_path]

            cmd = cmd[:-1] + ["-progress", "pipe:1", cmd[-1]]
            _progress_target = loaded_duration if loaded_duration and loaded_duration > 0 else 1.0
            _last_pct = 750
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            for _raw in proc.stdout:
                _line = _raw.decode('utf-8', 'replace').strip()
                _t = None
                if _line.startswith('out_time_us='):
                    try:
                        _t = int(_line.split('=', 1)[1]) / 1000000.0
                    except Exception:
                        _t = None
                elif _line.startswith('out_time_ms='):
                    try:
                        _t = int(_line.split('=', 1)[1]) / 1000.0
                    except Exception:
                        _t = None
                if _t is None or _progress_target <= 0:
                    continue
                _ratio = min(1.0, max(0.0, _t / _progress_target))
                _cur = int(750 + _ratio * 200)
                if _cur > _last_pct:
                    _last_pct = _cur
                    pbar.update_absolute(_cur, 1000)
            try:
                proc.wait(timeout=120)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
            _err = proc.stderr.read().decode(*ENCODE_ARGS)
            if proc.returncode != 0:
                print(f"[小珠光视频加载低内存版] 预览视频转码失败 (rc={proc.returncode}): {_err[:500]}")
            elif os.path.isfile(preview_path):
                preview_ui = {
                    "video_preview": [{
                        "filename": preview_filename,
                        "subfolder": "",
                        "type": "temp",
                    }],
                    "video_info": [video_info],
                }
            pbar.update_absolute(950, 1000)
        except Exception as e:
            print(f"[小珠光视频加载低内存版] 预览视频生成异常: {e}")

        if image_tensor.size(3) == 4:
            rgb = image_tensor[:, :, :, :3]
            result = (rgb, audio, video_info)
        else:
            result = (image_tensor, audio, video_info)

        pbar.update_absolute(1000, 1000)
        return {"result": result, "ui": preview_ui}

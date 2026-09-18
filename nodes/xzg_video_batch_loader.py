"""
小珠光视频批处理（含合并过渡节点）

1. XiaozhuguangVideoBatchLoader「小珠光视频批处理」（内部基类，不再单独注册）：
   在「小珠光视频加载器」基础上增加「片段起点/片段终点」参数，输出接口与原加载器完全一致。
   现作为「小珠光视频加载-化神级」（XiaozhuguangVideoLoaderDaVinci）的父类，
   配合前端「场景逐段批处理」编排器（web/xzg_video_batch.js）逐段加载视频。

2. XiaozhuguangVideoBatchMerge「小珠光视频批处理合并」（缓冲式过渡节点）：
   - 逐段运行（执行合并=False）：接收上游 图像/音频，把当前段流式编码为
    无音轨视频（-an）+ PCM WAV 缓冲到 input/xzg_batch_buffer/（ffmpeg 逐帧写
    stdin，内存≈单段常数），同时把输入原样传给下游（直通）；
   - 最终合并（执行合并=True）：concat 分段视频（流复制）→ 解码为帧张量；
     音频用分段 WAV 样本级拼接（音频全程只编码一次，段间无 priming 空隙、按 帧数/帧率 精确对齐）；
     输出 图像/音频 → 下游「小珠光视频保存」产出并预览最终完整视频。
   编排器会在逐段阶段排除合并节点下游（保存节点只在最后跑一次）。
   注意：最终合并需把完整视频解码为张量，内存 ≈ 整个视频的帧张量，长视频慎用。
   「执行合并」由前端编排器在最后一步自动置位（也可手动勾选触发）。
"""

import os
import time
import wave
import shutil

import numpy as np
import torch
import folder_paths
from comfy.utils import ProgressBar

from .xzg_video_loader import (
    XiaozhuguangVideoLoader,
    calculate_file_hash,
    ffmpeg_frame_generator,
)
from .xzg_video_combine import export_to_video
from .xzg_video_editor_api import get_batch_buffer_dir, concat_video_files


def _write_wav_int16(path, waveform, sample_rate):
    """把 [channels, samples] 的 float 波形写成 16bit PCM WAV（缓冲中间格式，无损拼接）"""
    w = waveform.detach().cpu().float()
    if w.dim() == 1:
        w = w.unsqueeze(0)
    if w.dim() == 3:
        w = w.squeeze(0)
    channels, _ = w.shape
    data = (w.transpose(0, 1).clamp_(-1.0, 1.0).numpy() * 32767.0).astype("<i2")
    with wave.open(path, "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(2)
        wf.setframerate(int(sample_rate))
        wf.writeframes(data.tobytes())


class XiaozhuguangVideoBatchLoader(XiaozhuguangVideoLoader):
    """小珠光视频批处理：视频加载器 + 片段窗口（片段起点/终点，0 值表示默认：起点 0 / 终点=片尾）"""

    @classmethod
    def INPUT_TYPES(cls):
        t = super().INPUT_TYPES()
        t["required"]["片段起点"] = ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1e6, "step": 0.001})
        t["required"]["片段终点"] = ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1e6, "step": 0.001})
        return t

    def load_video(self, 视频, 强制帧率=0, 视频比例="原始比例", 比例模式="裁剪(crop)", 自定义宽度=0, 自定义高度=0,
                   帧数上限=0, 跳过帧数=0, 片段起点=0.0, 片段终点=0.0, unique_id=None):
        return self.load_video_impl(
            视频=视频,
            强制帧率=强制帧率,
            视频比例=视频比例,
            比例模式=比例模式,
            自定义宽度=自定义宽度,
            自定义高度=自定义高度,
            帧数上限=帧数上限,
            跳过帧数=跳过帧数,
            片段起点=片段起点,
            片段终点=片段终点,
            unique_id=unique_id,
        )

    @classmethod
    def IS_CHANGED(cls, 视频, 强制帧率=0, 视频比例="原始比例", 比例模式="裁剪(crop)", 自定义宽度=0, 自定义高度=0,
                   帧数上限=0, 跳过帧数=0, 片段起点=0.0, 片段终点=0.0, **kwargs):
        try:
            path = folder_paths.get_annotated_filepath(视频)
            file_hash = calculate_file_hash(path)
        except Exception:
            file_hash = "0"
        # 片段窗口必须纳入变化检测，否则逐段运行时节点会被缓存跳过
        return f"{file_hash}|{强制帧率}|{视频比例}|{比例模式}|{自定义宽度}|{自定义高度}|{帧数上限}|{跳过帧数}|{片段起点}|{片段终点}"


class XiaozhuguangVideoBatchMerge:
    """小珠光视频批处理合并：缓冲式过渡节点，上游进 → 缓冲 → 下游出（最终完整视频经保存节点预览）"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "执行合并": ("BOOLEAN", {"default": False}),
                # 帧率只允许从输入端口接入（forceInput：无手工控件），由上游计算保证准确
                "帧率": ("FLOAT", {"forceInput": True}),
            },
            "optional": {
                "图像": ("IMAGE",),
                "音频": ("AUDIO",),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("IMAGE", "AUDIO")
    RETURN_NAMES = ("图像", "音频")
    FUNCTION = "merge_videos"
    CATEGORY = "xiaozhuguang"
    # 必须为输出节点：逐段阶段下游保存节点被编排器排除后，
    # 只有靠本节点自身作为输出节点才会被执行（执行缓冲），否则缓冲区永远为空
    OUTPUT_NODE = True

    def _resolve_fps(self, 帧率):
        """缓冲帧率：只能来自「帧率」输入端口（由上游计算提供）"""
        fps = float(帧率 or 0)
        if fps <= 0:
            raise ValueError("帧率必须大于 0：请检查上游「帧率」输入的计算来源")
        return fps

    def _buffer_segment(self, 图像, 音频, fps):
        """缓冲模式：当前段 → 无音轨视频 + 精确对齐的 WAV。
        缓冲位置：input/xzg_batch_buffer/"""
        buf_dir = get_batch_buffer_dir()
        os.makedirs(buf_dir, exist_ok=True)
        # 文件名带毫秒时间戳：唯一、可按名排序，且不会被同目录的后续分段覆盖
        tok = int(time.time() * 1000)
        idx = len([f for f in os.listdir(buf_dir) if f.startswith("seg_") and f.endswith(".mp4")]) + 1

        seg_video = os.path.join(buf_dir, f"seg_{tok}_{idx:05d}.mp4")
        export_to_video(
            image_tensors=图像,
            output_file=seg_video,
            frame_rate=fps,
            format="mp4",
            audio=None,   # 视频不带音轨：音频单独走 WAV，避免每段 AAC priming 造成拼接顿挫
            crf=16,
        )
        # 编码结果校验：防止 ffmpeg 静默失败导致"报告已缓冲但文件不存在"
        if not os.path.isfile(seg_video) or os.path.getsize(seg_video) == 0:
            raise RuntimeError(
                f"分段视频编码失败（未生成有效文件）: {seg_video}\n请查看 ComfyUI 控制台上方的 ffmpeg 报错")
        print(f"[小珠光批处理合并] 已缓冲第 {idx} 段 ({图像.shape[0]} 帧) → {seg_video}")

        has_audio = (
            isinstance(音频, dict)
            and 音频.get("waveform") is not None
            and 音频["waveform"].numel() > 0
        )
        if has_audio:
            waveform = 音频["waveform"]
            sr = int(音频.get("sample_rate") or 44100)
            if waveform.dim() == 3:
                waveform = waveform.squeeze(0)
            # 音频长度严格对齐到 段帧数/帧率 对应的样本数 → 拼接后与视频零漂移
            target = int(round(图像.shape[0] / fps * sr))
            cur = waveform.shape[-1]
            if cur < target:
                waveform = torch.nn.functional.pad(waveform, (0, target - cur))
            elif cur > target:
                waveform = waveform[..., :target]
            _write_wav_int16(os.path.join(buf_dir, f"seg_{tok}_{idx:05d}.wav"), waveform, sr)

        return {
            "index": idx,
            "filename": os.path.basename(seg_video),
            "frames": int(图像.shape[0]),
            "with_audio": has_audio,
        }

    def _finalize(self):
        """最终合并：concat 分段视频（流复制）→ 解码为帧张量；
        音频用分段 WAV 样本级拼接（零间隙零重编码）"""
        buf_dir = get_batch_buffer_dir()
        print(f"[小珠光批处理合并] 开始最终合并，缓冲目录: {buf_dir}，"
              f"存在: {os.path.isdir(buf_dir)}")
        mp4s = sorted(f for f in os.listdir(buf_dir) if f.endswith(".mp4")) if os.path.isdir(buf_dir) else []
        wavs = sorted(f for f in os.listdir(buf_dir) if f.endswith(".wav")) if os.path.isdir(buf_dir) else []
        if not mp4s:
            raise ValueError(
                f"缓冲区为空（{buf_dir}）。逐段阶段合并节点未被执行或未缓冲成功，请检查：\n"
                "① 合并节点的「图像」输入是否已从「视频批处理」下游链路接入（不接则逐段时不会执行合并节点）；\n"
                "② 逐段运行时每段日志是否显示「已缓冲」")

        # 拼接中间文件与清单都放在缓冲目录内（与缓冲同盘，避免跨盘写 C 盘临时目录）
        tmp_video_name, _, seg_count = concat_video_files(
            [os.path.join(buf_dir, f) for f in mp4s], buf_dir, "xzg_batch_tmp")
        tmp_video = os.path.join(buf_dir, tmp_video_name)
        try:
            pbar = ProgressBar(1000)

            # 1. 视频流：解码拼接结果为帧张量
            gen = ffmpeg_frame_generator(
                video=tmp_video,
                force_rate=0,      # 按缓冲帧率直通
                frame_load_cap=0,  # 不限帧数
                skip_frames=0,
                custom_width=0,
                custom_height=0,
            )
            info = next(gen)
            (src_w, src_h, src_fps, src_dur, src_frames,
             target_frame_time, yieldable, new_w, new_h, alpha) = info

            frames = []
            done = 0
            total = max(1, int(yieldable))
            for frame in gen:
                frames.append(frame)
                done += 1
                pbar.update_absolute(min(799, int(800 * done / total)), 1000)
            if not frames:
                raise RuntimeError("合并视频解码失败：未读到任何帧")

            channels = 4 if alpha else 3
            image_tensor = torch.from_numpy(
                np.stack(frames).astype(np.float32)
            ).view(-1, new_h, new_w, channels)
            if channels == 4:
                image_tensor = image_tensor[:, :, :, :3]
            pbar.update_absolute(850, 1000)

            # 2. 音频流：分段 WAV 样本级拼接（Python 直读 WAV，零间隙零重编码）
            audio = None
            if wavs:
                chunks = []
                sr = None
                channels_a = None
                for wp in [os.path.join(buf_dir, f) for f in wavs]:
                    with wave.open(wp, "rb") as w:
                        cur_sr = w.getframerate()
                        cur_ch = w.getnchannels()
                        if sr is None:
                            sr, channels_a = cur_sr, cur_ch
                        elif (cur_sr, cur_ch) != (sr, channels_a):
                            raise ValueError(
                                f"各段音频参数不一致，无法拼接: {sorted({(sr, channels_a), (cur_sr, cur_ch)})}")
                        raw = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2")
                    chunk = raw.reshape(-1, cur_ch).T.astype(np.float32) / 32767.0
                    chunks.append(chunk)
                waveform = torch.from_numpy(np.concatenate(chunks, axis=1)).float()
                audio = {
                    "waveform": waveform.unsqueeze(0),  # [1, channels, samples]
                    "sample_rate": sr,
                }
            pbar.update_absolute(1000, 1000)
            _ = seg_count  # 保留：段数信息可用于后续扩展
            # 合并成功，立即清空缓冲目录（分段视频/WAV 已无保留价值，不留垃圾）
            shutil.rmtree(buf_dir, ignore_errors=True)
            return (image_tensor, audio)
        finally:
            try:
                os.remove(tmp_video)
            except Exception:
                pass

    def merge_videos(self, 执行合并=False, 帧率=0, 图像=None, 音频=None, unique_id=None):
        if 执行合并:
            return self._finalize()
        # 缓冲模式：先缓冲当前段，再把输入原样传给下游（直通）
        if 图像 is None:
            raise ValueError("缓冲模式需要图像输入：请把处理链的「图像」接入本节点")
        fps = self._resolve_fps(帧率)
        info = self._buffer_segment(图像, 音频, fps)
        return {"result": (图像, 音频), "ui": {"buffered": [info]}}


NODE_CLASS_MAPPINGS = {
    "XiaozhuguangVideoBatchMerge": XiaozhuguangVideoBatchMerge,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XiaozhuguangVideoBatchMerge": "小珠光视频批处理合并",
}

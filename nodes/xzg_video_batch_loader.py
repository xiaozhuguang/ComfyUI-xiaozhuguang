"""
小珠光视频批处理（含硬切拼接节点）

1. XiaozhuguangVideoBatchLoader「小珠光视频批处理」（内部基类，不再单独注册）：
   在「小珠光视频加载器」基础上增加「内存模式」，输出接口与原加载器完全一致。
   现作为「小珠光视频加载-化神级」（XiaozhuguangVideoLoaderDaVinci）的父类，
   配合前端「场景逐段批处理」编排器（web/xzg_video_batch.js）逐段加载视频。
   分段窗口只由「跳过帧数/帧数上限」表达（片段起点/终点、补帧到已从面板移除）。

2. XiaozhuguangVideoBatchMerge「小珠光视频分段合并」（内存拼接节点）：
   - 每段处理完成后，将图像张量和音频波形复制到 CPU 内存；不生成分段视频或 WAV 文件；
   - 最后按顺序拼接内存张量，输出完整图像与音频供视频保存节点编码。
   - 分段之间硬切衔接；最终合并后立即释放该节点的内存缓存。
   注意：分段结果会一直占用主机内存到最终合并完成，长视频或高分辨率素材需要足够内存。
   「执行合并」由前端编排器在最后一步自动置位。
"""

import torch
import folder_paths

from .xzg_video_loader import (
    BIGMAX,
    XiaozhuguangVideoLoader,
    calculate_file_hash,
    _resolve_video_widget,
)
from .xzg_video_batch_memory import append_segment, get_segments, clear_node_segments


class XiaozhuguangVideoBatchLoader(XiaozhuguangVideoLoader):
    """小珠光视频批处理：视频加载器 + 内存模式（分段窗口由 跳过帧数/帧数上限 表达）"""

    @classmethod
    def INPUT_TYPES(cls):
        t = super().INPUT_TYPES()
        # 内存模式（低内存版功能并入）：标准=list+堆叠；低内存=预分配流式写入
        t["required"]["内存模式"] = (["标准", "低内存"], {"default": "标准"})
        # 把可见控件放在「帧数上限」之后，保持节点面板紧凑
        required = t["required"]
        reordered = {}
        for name, spec in required.items():
            if name == "内存模式":
                continue
            reordered[name] = spec
            if name == "帧数上限":
                reordered["内存模式"] = required["内存模式"]
        t["required"] = reordered
        # 片段起点/片段终点/补帧到 已从节点面板移除（分段改由「小珠光场景切点分段」负责）；
        # load_video / IS_CHANGED 的签名仍保留这几个参数（默认 0），仅用于旧工作流兼容。
        return t

    def load_video(self, 视频, 强制帧率=0, 视频比例="原始比例", 比例模式="裁剪(crop)", 自定义宽度=0, 自定义高度=0,
                   帧数上限=0, 跳过帧数=0, 片段起点=0.0, 片段终点=0.0, 内存模式="标准",
                   补帧到=0, unique_id=None):
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
            内存模式=内存模式,
            补帧到=补帧到,
            unique_id=unique_id,
        )

    @classmethod
    def IS_CHANGED(cls, 视频, 强制帧率=0, 视频比例="原始比例", 比例模式="裁剪(crop)", 自定义宽度=0, 自定义高度=0,
                   帧数上限=0, 跳过帧数=0, 片段起点=0.0, 片段终点=0.0, 内存模式="标准",
                   补帧到=0, **kwargs):
        # 空选或文件被删时，与 load_video_impl 走同一套兜底逻辑，保证缓存键稳定。
        视频, _ = _resolve_video_widget(视频)
        try:
            path = folder_paths.get_annotated_filepath(视频)
            file_hash = calculate_file_hash(path)
        except Exception:
            file_hash = "0"
        # 片段窗口/内存模式必须纳入变化检测，否则逐段运行时节点会被缓存跳过
        return f"{file_hash}|{强制帧率}|{视频比例}|{比例模式}|{自定义宽度}|{自定义高度}|{帧数上限}|{跳过帧数}|{片段起点}|{片段终点}|{内存模式}|{补帧到}"


class XiaozhuguangVideoBatchMerge:
    """小珠光视频分段合并：分段结果暂存在进程内存，最终输出完整图像与音频。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "执行合并": ("BOOLEAN", {"default": False}),
                # 编排器专用：末段为满足 17N+5（复制末帧）补齐的帧数，合并成片前裁掉（0=不裁）
                "末尾裁帧": ("INT", {"default": 0, "min": 0, "max": BIGMAX, "step": 1}),
            },
            "optional": {
                # 端口顺序 = 图像 → 音频 → 帧率（required 在前、optional 在后）
                "图像": ("IMAGE",),
                "音频": ("AUDIO",),
                # 帧率只允许从输入端口接入（forceInput：无手工控件），由上游计算保证准确；
                # 放在 optional 只是为了排在音频后面，未接入时缓冲模式会给出明确报错
                "帧率": ("FLOAT", {"forceInput": True}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("IMAGE", "AUDIO")
    RETURN_NAMES = ("图像", "音频")
    FUNCTION = "merge_videos"
    CATEGORY = "小珠光/视频"
    # 必须为输出节点：逐段阶段下游保存节点被编排器排除后，
    # 只有靠本节点自身作为输出节点才会执行，才能收集每段处理结果
    OUTPUT_NODE = True

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # 内存段缓存是执行时写入/清理的状态，同样的输入也必须重新收集或合并。
        return float("NaN")

    def _resolve_fps(self, 帧率):
        """缓冲帧率：只能来自「帧率」输入端口（由上游计算提供）"""
        fps = float(帧率 or 0)
        if fps <= 0:
            raise ValueError("帧率必须大于 0：请检查上游「帧率」输入的计算来源")
        return fps

    def _buffer_segment(self, 图像, 音频, fps, node_id=None, trim_tail=0):
        """将当前段复制到 CPU 内存，避免切片视图继续占用整片上游张量。"""
        trim_tail = max(0, int(trim_tail or 0))
        if trim_tail and int(图像.shape[0]) > trim_tail:
            图像 = 图像[:-trim_tail]
        image_memory = 图像.detach().to(device="cpu").contiguous().clone()
        audio_memory = None
        has_audio = isinstance(音频, dict) and 音频.get("waveform") is not None and 音频["waveform"].numel() > 0
        if has_audio:
            waveform = 音频["waveform"]
            if waveform.dim() == 1:
                waveform = waveform.unsqueeze(0)
            if waveform.dim() == 3:
                waveform = waveform.squeeze(0)
            sr = int(音频.get("sample_rate") or 44100)
            target = int(round(image_memory.shape[0] / fps * sr))
            waveform = waveform[..., :target]
            if waveform.shape[-1] < target:
                waveform = torch.nn.functional.pad(waveform, (0, target - waveform.shape[-1]))
            audio_memory = {"waveform": waveform.detach().to(device="cpu").contiguous().clone(), "sample_rate": sr}
        info = append_segment(node_id, image_memory, audio_memory, fps, {
            "filename": "memory", "frames": int(image_memory.shape[0]), "with_audio": bool(has_audio),
        })
        print(f"[小珠光视频分段合并] 已缓存第 {info['index']} 段（{image_memory.shape[0]} 帧）→ 进程内存")
        return info

    def _finalize(self, node_id=None, fps=0, tail_trim=0):
        """按顺序直接拼接进程内存中的图像张量和音频波形。"""
        segments = get_segments(node_id)
        if not segments:
            raise ValueError("内存缓存为空：请先运行场景切点分段批处理，并确认处理链连接到本合并节点")
        print(f"[小珠光视频分段合并] 开始内存合并，共 {len(segments)} 段")
        image_tensor = torch.cat([item["image"] for item in segments], dim=0)
        audio_items = [item["audio"] for item in segments if item["audio"] is not None]
        audio = None
        if audio_items:
            first_wave = audio_items[0]["waveform"]
            sr = int(audio_items[0]["sample_rate"])
            channels = int(first_wave.shape[-2])
            chunks = []
            for item in segments:
                current = item["audio"]
                expected = int(round(item["image"].shape[0] / float(item["fps"] or fps or 1) * sr))
                if current is None:
                    chunks.append(torch.zeros((channels, expected), dtype=first_wave.dtype))
                    continue
                waveform = current["waveform"]
                if int(current["sample_rate"]) != sr or int(waveform.shape[-2]) != channels:
                    raise ValueError("各段音频采样率或声道数不一致，无法合并")
                chunks.append(waveform)
            audio = {"waveform": torch.cat(chunks, dim=-1).unsqueeze(0), "sample_rate": sr}
        image_tensor, audio = self._trim_output_tail(
            image_tensor, audio, tail_trim, float(segments[-1]["fps"] or fps or 0))
        clear_node_segments(node_id)
        return (image_tensor, audio)

    @staticmethod
    def _trim_output_tail(image, audio, frames, fps):
        """裁掉末尾补帧，并按相同时长裁剪音频。"""
        n = max(0, int(frames or 0))
        if n <= 0 or image is None or image.shape[0] <= n:
            return image, audio
        image = image[:-n]
        if audio and fps > 0:
            sr = int(audio.get("sample_rate") or 0)
            samples = int(round(n / float(fps) * sr)) if sr > 0 else 0
            waveform = audio.get("waveform")
            if waveform is not None and samples > 0:
                audio = {"waveform": waveform[..., :-samples], "sample_rate": sr}
        return image, audio

    def merge_videos(self, 执行合并=False, 帧率=0, 图像=None, 音频=None, 末尾裁帧=0,
                     unique_id=None):
        if 执行合并:
            try:
                return self._finalize(unique_id, fps=帧率, tail_trim=末尾裁帧)
            except Exception:
                clear_node_segments(unique_id)
                raise
        if 图像 is None:
            raise ValueError("缓冲模式需要图像输入：请把处理链的「图像」接入本节点")
        fps = self._resolve_fps(帧率)
        info = self._buffer_segment(图像, 音频, fps, unique_id, trim_tail=末尾裁帧)
        info["node"] = str(unique_id)
        return {"result": (图像, 音频), "ui": {"buffered": [info]}}


NODE_CLASS_MAPPINGS = {
    "XiaozhuguangVideoBatchMerge": XiaozhuguangVideoBatchMerge,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XiaozhuguangVideoBatchMerge": "小珠光视频分段合并",
}

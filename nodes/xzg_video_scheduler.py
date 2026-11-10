"""
小珠光场景切点分段
==================
只看上游喂进来的整片「图像 / 音频 / 遮罩」和帧率，不关心上游跳过了多少帧、
加载上限是多少——段表就是这张整片图像上的帧号区间。

- 「图像」接整片帧（从第 0 帧起、覆盖全片时长），「音频」接整片音轨，
  「帧率」直接输入（段表的时间轴换算、音频切片都依赖它）；
- 本节点只做内存内切片：按「段表 + 当前段」切出本段，不重新解码、不做 FFmpeg 定位，
  段起点/帧数即整片帧号切片的左右边界，切点绝对精确；
- 没接音频时输出等长静音（不会静默改变帧数）。
- 批次遮罩按图像相同区间切片；数量不足时延用最后一张，未接入时输出等量全黑遮罩。

段表格式："0:124,124:248,248:372"（起始帧:结束帧，0-based 右开区间，逗号/分号分隔）。
段与段首尾相接（相邻段不重复读任何帧）。
段表由本节点分析实际输入图像生成；前端只编排缓存片段的执行。
"""
import torch
from comfy.model_management import throw_exception_if_processing_interrupted

from .xzg_video_loader import AUDIO_SAMPLE_RATE

# 一次批处理内的素材快照：unique_id:batch -> {"frames", "audio", "fps", "mask"}。
# 只持有实际输入的引用；准备阶段写入，最后一段/中断/异常时清除。
_SCHEDULER_SNAPSHOT = {}



class XiaozhuguangVideoScheduler:
    """小珠光场景切点分段：只按上游整片素材切出当前段（不自己解码视频）。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # 前端写：分段结果（隐藏控件）与本轮第几段（隐藏控件）
                "段表": ("STRING", {"default": "", "multiline": False}),
                "当前段": ("INT", {"default": 0, "min": 0, "max": 1000000, "step": 1}),
                "场景阈值": ("FLOAT", {"default": 0.35, "min": 0.05, "max": 0.95, "step": 0.01}),
            },
            "optional": {
                # 上游整片素材：图像（整片帧）、音频（整片音轨）
                "图像": ("IMAGE",),
                "音频": ("AUDIO",),
                "帧率": ("FLOAT", {"forceInput": True}),
                "遮罩": ("MASK",),
                "缓存批次": ("STRING", {"default": ""}),
                "分段模式": (["场景切点", "4N+1", "17N+5", "自定义"], {"default": "场景切点"}),
                "分段帧数": ("INT", {"default": 100, "min": 1, "max": 1000000, "step": 1,
                                    "tooltip": "自定义模式的每段帧数，或规则模式的帧数上限。"}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("IMAGE", "AUDIO", "FLOAT", "INT", "MASK")
    RETURN_NAMES = (
        "图像",
        "音频",
        "帧率",
        "本段帧数",
        "遮罩",
    )
    FUNCTION = "schedule"
    CATEGORY = "小珠光/视频"
    OUTPUT_NODE = True

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # 每段/每次重试都执行缓存切片，避免执行结果缓存跳过本轮缓冲
        return float("NaN")

    @staticmethod
    def _detect_segments(frames, threshold):
        """在实际图像上计算相邻帧变化；小批缩略图避免复制整片高清素材。"""
        total = int(frames.shape[0])
        cuts = [0]
        previous = None
        previous_mafd = 0.0
        with torch.no_grad():
            for offset in range(0, total, 32):
                throw_exception_if_processing_interrupted()
                # Subsample before converting dtype: bound temporary memory for 4K inputs.
                sample = frames[offset:offset + 32,
                                ::max(1, frames.shape[1] // 128),
                                ::max(1, frames.shape[2] // 128), :3]
                small = torch.nn.functional.interpolate(
                    sample.permute(0, 3, 1, 2).float(),
                    size=(64, 64), mode="area")
                for local, frame in enumerate(small):
                    if previous is not None:
                        mafd = float((frame - previous).abs().mean().item())
                        # scene 阈值采用 8-bit 平均差 / 100 的尺度。
                        # IMAGE 是 0..1；漏乘 255/100 会让默认 0.35 过于保守。
                        score = min(1.0, min(mafd, abs(mafd - previous_mafd)) * 2.55)
                        if score >= float(threshold):
                            cuts.append(offset + local)
                        previous_mafd = mafd
                    previous = frame
        cuts.append(total)
        return [(a, b, 0) for a, b in zip(cuts, cuts[1:]) if b > a]

    @staticmethod
    def _fixed_segments(total, mode, limit):
        if mode == "自定义":
            step, base = 1, 1
        elif mode == "4N+1":
            step, base = 4, 1
        else:
            step, base = 17, 5
        if limit < base:
            raise ValueError(f"{mode} 模式的分段帧数至少为 {base}")
        length = limit - (limit - base) % step
        segments = [(start, min(start + length, total), 0) for start in range(0, total, length)]
        remainder = total % length
        padding = (base - remainder) % step if remainder >= base else base - remainder
        return segments, padding if remainder else 0

    @staticmethod
    def _slice_audio(waveform, sr, start_sec, end_sec):
        """在整片波形上按时间区间切片，返回 [1, C, samples]；区间超出末端的部分补零。"""
        w = waveform
        if w.dim() == 3:
            w = w[0]
        elif w.dim() == 1:
            w = w.unsqueeze(0)
        total = w.shape[-1]
        a = max(0, int(round(start_sec * sr))) if sr > 0 else 0
        b = int(round(end_sec * sr)) if (sr > 0 and end_sec > start_sec) else total
        b = max(a, b)
        seg = w[:, min(a, total):min(b, total)]
        pad = (b - a) - seg.shape[-1]
        if pad > 0:
            seg = torch.nn.functional.pad(seg, (0, pad))
        return seg.unsqueeze(0)

    @staticmethod
    def _slice_masks(mask, start, end, image):
        count = int(image.shape[0])
        if mask is None or mask.numel() == 0:
            return image.new_zeros((count, image.shape[1], image.shape[2]))
        if mask.dim() == 2:
            mask = mask.unsqueeze(0)
        if mask.dim() != 3:
            raise ValueError("遮罩需要是 [帧数, 高度, 宽度] 的批次遮罩")
        segment = mask[start:end]
        missing = count - int(segment.shape[0])
        if missing == count:
            return mask[-1:].expand(count, -1, -1)
        if missing > 0:
            segment = torch.cat([segment, mask[-1:].expand(missing, -1, -1)], dim=0)
        return segment

    def schedule(self, 段表="", 当前段=0, 场景阈值=0.35,
                 帧率=0, 图像=None, 音频=None, unique_id=None, 遮罩=None, 缓存批次="",
                 分段模式="场景切点", 分段帧数=100):
        # 外层只负责快照生命周期：任何异常都先清掉本节点快照。快照持有整片张量引用，
        # 不清理会让 ComfyUI 也无法回收这块内存，中断的批处理会一直占着。
        snapshot_key = f"{unique_id}:{缓存批次}" if unique_id else ""
        try:
            return self._schedule_segment(
                段表, 当前段,
                帧率, 图像, 音频, 遮罩, snapshot_key, 场景阈值, 分段模式, 分段帧数,
            )
        except Exception:
            if snapshot_key:
                _SCHEDULER_SNAPSHOT.pop(snapshot_key, None)
            raise

    def _schedule_segment(self, 段表, 当前段,
                          帧率, 图像, 音频, 遮罩, snapshot_key, threshold, mode, limit):
        preparing = int(当前段 or 0) == 1000000
        snapshot = _SCHEDULER_SNAPSHOT.get(snapshot_key) if snapshot_key else None
        if 图像 is not None:
            if int(图像.shape[0]) <= 0:
                raise ValueError("上游「图像」为空，无法分段")
            if mode == "场景切点":
                segments, padding = self._detect_segments(图像, threshold), 0
            else:
                segments, padding = self._fixed_segments(int(图像.shape[0]), mode, limit)
            snapshot = {"frames": 图像, "audio": 音频, "fps": 帧率, "mask": 遮罩,
                        "segments": segments, "padding": padding}
            if snapshot_key:
                _SCHEDULER_SNAPSHOT[snapshot_key] = snapshot
        if snapshot is None:
            raise ValueError("本轮分段素材缓存已释放，请重新运行工作流以接收图像并生成分段")
        full_frames = snapshot["frames"]
        音频, 帧率, 遮罩 = snapshot["audio"], snapshot["fps"], snapshot["mask"]
        material_source = "节点缓存"
        total = int(full_frames.shape[0])
        if total <= 0:
            raise ValueError("上游「图像」为空，无法分段")

        try:
            fps = float(帧率 or 0)
        except (TypeError, ValueError):
            fps = 0.0
        if fps <= 0:
            raise ValueError("帧率必须大于 0")

        full_wave = None              # 整片音频波形：上游直传，没有则输出等长静音
        full_sr = AUDIO_SAMPLE_RATE

        # 音频：上游直传整片波形则只切片；没接音频时下面按段输出等长静音
        if 音频 is not None and isinstance(音频, dict):
            full_wave = 音频.get("waveform")
            full_sr = int(音频.get("sample_rate") or AUDIO_SAMPLE_RATE)

        segs = snapshot["segments"]
        table = ",".join(f"{a}:{b}" for a, b, _ in segs)
        if preparing:
            return {"ui": {"scene_table": [table], "scene_fps": [fps], "scene_frames": [total],
                           "scene_tail_pad": [snapshot["padding"]]},
                    "result": (full_frames[:1], {"waveform": full_frames.new_zeros((1, 2, 1)),
                                               "sample_rate": AUDIO_SAMPLE_RATE}, fps, 1,
                               self._slice_masks(遮罩, 0, 1, full_frames[:1]))}
        index = int(当前段 or 0)
        if index < 0 or index >= len(segs):
            raise ValueError(f"当前段 {index} 超出缓存段表范围（共 {len(segs)} 段），请重新运行工作流")
        start, end = int(segs[index][0]), int(segs[index][1])
        head = max(0, int(segs[index][2] or 0)) if len(segs[index]) > 2 else 0
        if total > 0:
            start = min(max(0, start), total)
        end = max(start, end)
        # 头部重叠：从第 2 段起往前多取 head 帧（与前一段尾部重叠，本段处理链的
        # 时间上下文更完整）；重叠部分由合并节点按缓冲文件名记录的帧数裁掉，成片时长不变
        decode_start = max(0, start - head)
        count = max(0, end - decode_start)
        # 诊断用：确认后端每轮收到的「当前段」是否真的在递增，以及素材来自上游还是快照。
        print(
            f"[小珠光场景切点分段] 第 {index + 1}/{len(segs)} 段："
            f"帧 {decode_start}-{end - 1}（{count} 帧"
            + (f"，含头部重叠 {head} 帧" if head > 0 else "")
            + f"），素材={material_source}，总帧 {total}"
        )
        if count <= 0:
            raise ValueError(
                f"当前段没有帧（{decode_start}-{end}）：段表与上游「图像」不匹配"
                f"（整片只有 {total} 帧，段表起点 {start} 已越界）。"
                "常见原因：工作流从别的视频/工作流复制而来，段表是旧值；"
                "或探测分段时切换了工作流。请重新打开批处理面板预览分段后重试")

        # 图像：整片张量按段切片（含头部重叠帧；内存视图，不复制、不重新解码）
        image_tensor = full_frames[decode_start:min(end, total)] if total > 0 else full_frames[decode_start:end]
        mask_tensor = self._slice_masks(遮罩, decode_start, min(end, total), image_tensor)
        padding = snapshot["padding"] if index == len(segs) - 1 else 0
        if padding:
            image_tensor = torch.cat((image_tensor, image_tensor[-1:].expand(padding, -1, -1, -1)))
            mask_tensor = torch.cat((mask_tensor, mask_tensor[-1:].expand(padding, -1, -1)))
            count += padding

        start_sec = (start / fps) if fps > 0 else 0.0
        end_sec = (end / fps) if fps > 0 else 0.0

        # 音频：整片波形切片（样本数与段帧数等长）；无音轨时给等长静音
        if full_wave is not None and full_sr > 0:
            audio = {
                "waveform": self._slice_audio(full_wave, full_sr, start_sec, end_sec),
                "sample_rate": full_sr,
            }
            if padding:
                samples = round((end + padding) / fps * full_sr) - round(end_sec * full_sr)
                audio["waveform"] = torch.nn.functional.pad(audio["waveform"], (0, samples))
        else:
            samples = max(int(round(full_sr * count / fps)), 1) if fps > 0 else max(count, 1)
            audio = {
                "waveform": torch.zeros((1, 2, samples), dtype=torch.float32),
                "sample_rate": int(full_sr or AUDIO_SAMPLE_RATE),
            }

        # 最后一段执行完即释放快照，下一轮准备阶段重新接收素材。
        if snapshot_key and index >= len(segs) - 1:
            _SCHEDULER_SNAPSHOT.pop(snapshot_key, None)

        return (
            image_tensor,
            audio,
            float(fps),
            int(count),
            mask_tensor,
        )


NODE_CLASS_MAPPINGS = {
    "XiaozhuguangVideoScheduler": XiaozhuguangVideoScheduler,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XiaozhuguangVideoScheduler": "小珠光场景切点分段",
}


# Explicit release for interruption/errors outside the scheduler (e.g. downstream failures).
from aiohttp import web
from server import PromptServer


@PromptServer.instance.routes.post("/xzg_video_scheduler_release")
async def release_scheduler_cache(request):
    data = await request.json()
    _SCHEDULER_SNAPSHOT.pop(f"{data.get('node_id')}:{data.get('batch', '')}", None)
    return web.json_response({"ok": True})

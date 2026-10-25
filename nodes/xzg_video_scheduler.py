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
段表由前端场景切点探测生成，不再按固定帧数均分。
"""
import os

import torch

from .xzg_video_loader import AUDIO_SAMPLE_RATE

# 一次批处理内的素材快照：unique_id -> {"frames", "audio", "fps", "mask"}。
# 只持有上游对象引用，不复制张量；第 0 段写入，最后一段执行后清除。
_SCHEDULER_SNAPSHOT = {}

# 快照锁定开关：默认开启。设置环境变量 XZG_SCHEDULER_SNAPSHOT=0 可退回
# 「每段都从上游取素材」的旧行为，用于排查或临时绕过。
_SNAPSHOT_ENABLED = str(os.environ.get("XZG_SCHEDULER_SNAPSHOT", "1")).strip().lower() not in (
    "0", "false", "off", "no",
)


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

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # 每段/每次重试都真实解码：段参数变化必然重算，重试时不至于命中缓存而跳过执行
        return float("NaN")

    @staticmethod
    def _parse_table(text, total):
        """解析场景段表，非法项忽略，按全片帧数裁剪。"""
        segs = []
        for part in str(text or "").replace(";", ",").replace("，", ",").split(","):
            part = part.strip()
            if not part:
                continue
            sep = ":" if ":" in part else ("-" if "-" in part else "")
            if not sep:
                continue
            fields = part.split(sep)
            if len(fields) < 2:
                continue
            try:
                start, end = int(float(fields[0])), int(float(fields[1]))
            except (TypeError, ValueError):
                continue
            start = max(0, start)
            if total > 0:
                start = min(start, total)
            if end > start:
                segs.append((start, end, 0))
        return segs

    @staticmethod
    def _table_fits_video(segs, total):
        """场景区间必须连续覆盖当前素材，仅末段允许少量补帧。"""
        if total <= 0 or not segs or segs[0][0] != 0:
            return False
        if any(left[1] != right[0] for left, right in zip(segs, segs[1:])):
            return False
        return segs[-1][0] < total and segs[-1][1] == total

    def _build_segments(self, table, total):
        """仅使用场景探测段表，缺失或不匹配时要求重新探测。"""
        segs = self._parse_table(table, total)
        if not segs or not self._table_fits_video(segs, total):
            raise ValueError("请运行工作流，重新探测当前视频的场景切点后分段")
        return [(start, end, 0) for start, end, _ in segs]

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
        a = min(a, total)
        b = int(round(end_sec * sr)) if (sr > 0 and end_sec > start_sec) else total
        b = max(a, b)
        seg = w[:, a:min(b, total)]
        pad = b - seg.shape[-1]
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
                 帧率=0, 图像=None, 音频=None, unique_id=None, 遮罩=None):
        # 外层只负责快照生命周期：任何异常都先清掉本节点快照。快照持有整片张量引用，
        # 不清理会让 ComfyUI 也无法回收这块内存，中断的批处理会一直占着。
        snapshot_key = str(unique_id or "")
        try:
            return self._schedule_segment(
                段表, 当前段,
                帧率, 图像, 音频, 遮罩, snapshot_key,
            )
        except Exception:
            if snapshot_key:
                _SCHEDULER_SNAPSHOT.pop(snapshot_key, None)
            raise

    def _schedule_segment(self, 段表, 当前段,
                          帧率, 图像, 音频, 遮罩, snapshot_key):
        # 本节点只按段切片：整片帧必须由上游「图像」提供（不再自己解码视频文件）
        if 图像 is None:
            raise ValueError("请把整片「图像」接到本节点（从第 0 帧起覆盖全片）；"
                             "本节点只按段切片，不再自己解码视频")
        # 一次批处理内锁定素材：每次运行都从第 0 段开始，故第 0 段抓取上游引用
        # （不复制张量），其余段复用同一份，中途换片/上游重跑不会污染这一批。
        material_source = "上游"
        if _SNAPSHOT_ENABLED and snapshot_key:
            segment_index = max(0, int(当前段 or 0))
            snapshot = _SCHEDULER_SNAPSHOT.get(snapshot_key)
            # 分辨率可在上游加载器动态修改。若快照残留自上一次中断/手动执行，
            # 即使当前段不是 0，也要按输入张量的形状刷新，不能继续切旧尺寸的帧。
            snapshot_shape = tuple(snapshot["frames"].shape) if snapshot is not None else None
            input_shape = tuple(图像.shape)
            resolution_changed = (
                snapshot_shape is not None
                and len(snapshot_shape) >= 3
                and len(input_shape) >= 3
                and snapshot_shape[-3:-1] != input_shape[-3:-1]
            )
            if segment_index == 0 or snapshot is None or resolution_changed:
                snapshot = {"frames": 图像, "audio": 音频, "fps": 帧率, "mask": 遮罩}
                _SCHEDULER_SNAPSHOT[snapshot_key] = snapshot
                material_source = "上游（分辨率变化，已刷新快照）" if resolution_changed else "上游（已锁定）"
            else:
                material_source = "快照"
            full_frames = snapshot["frames"]
            音频 = snapshot["audio"]
            帧率 = snapshot["fps"]
            遮罩 = snapshot["mask"]
        else:
            full_frames = 图像
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

        segs = self._build_segments(段表, total)
        index = max(0, min(int(当前段 or 0), len(segs) - 1))
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

        start_sec = (start / fps) if fps > 0 else 0.0
        end_sec = (end / fps) if fps > 0 else 0.0

        # 音频：整片波形切片（样本数与段帧数等长）；无音轨时给等长静音
        if full_wave is not None and full_sr > 0:
            audio = {
                "waveform": self._slice_audio(full_wave, full_sr, start_sec, end_sec),
                "sample_rate": full_sr,
            }
        else:
            samples = max(int(round(full_sr * count / fps)), 1) if fps > 0 else max(count, 1)
            audio = {
                "waveform": torch.zeros((1, 2, samples), dtype=torch.float32),
                "sample_rate": int(full_sr or AUDIO_SAMPLE_RATE),
            }

        # 最后一段执行完即释放快照，避免整片张量长期驻留；下一次运行第 0 段会重新抓取。
        if _SNAPSHOT_ENABLED and snapshot_key and index >= len(segs) - 1:
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

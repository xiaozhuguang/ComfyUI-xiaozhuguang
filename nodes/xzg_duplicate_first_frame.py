import torch
import math
import torch.nn.functional as F
from comfy.utils import repeat_to_batch_size


class XiaozhuguangDuplicateFirstFrame:
    """
    小珠光帧优化
    根据原始帧数自动计算补帧数量，复制首帧填充
    4N+1：ceil(a/4)*4 + 5 - a；17N+5：ceil(a/17)*17 + 5 - a
    开启下限：开启后，用尾帧补至下限值（向上对齐到所选帧数规则）

    图像与遮罩均可独立输入（至少连一个）：
    - 双输入：遮罩按与图像完全相同的补帧规则处理（单帧遮罩自动复制到图像帧数，
      空间尺寸不一致时最近邻对齐），输出同帧数遮罩
    - 仅遮罩：以遮罩帧数为基准独立补帧，图像输出为 None（反之亦然）
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "multi_fill": ("BOOLEAN", {"default": False}),
                "min_frames": ("INT", {"default": 73, "min": 1, "max": 2147483647, "step": 1,
                                      "tooltip": "开启下限时生效，自动向上对齐到所选帧数规则；不足时复制尾帧补足。"}),
                "frame_rule": (["4N+1", "17N+5"], {"default": "4N+1",
                               "tooltip": "复制首帧前补至少5帧，并使总帧数满足所选规则。"}),
                "fps": ("FLOAT", {"forceInput": True, "min": 0.01, "max": 1000.0,
                                  "tooltip": "必须连接输入视频的帧率，并与视频合成帧率一致，用于计算音频补静音和裁剪时长。"}),
            },
            "optional": {
                "image": ("IMAGE",),
                "mask": ("MASK",),
                "audio": ("AUDIO",),
            },
        }

    # mask 输出放在末尾：旧工作流节点刷新定义时只需在末尾追加新输出槽，
    # 既有连线（image/frame_count/original_count/front_fill）位置不变、无需重连
    RETURN_TYPES = ("IMAGE", "INT", "INT", "INT", "MASK", "AUDIO")
    RETURN_NAMES = ("image", "frame_count", "original_count", "front_fill", "mask", "audio")
    FUNCTION = "execute"
    CATEGORY = "小珠光/视频"

    @classmethod
    def IS_CHANGED(cls, multi_fill=False, image=None, mask=None, min_frames=73, frame_rule="4N+1", fps=24.0, audio=None):
        # 纯函数：前置输入未变则直接使用 ComfyUI 缓存，不重算
        return None

    def execute(self, multi_fill=False, image=None, mask=None, min_frames=73, frame_rule="4N+1", fps=24.0, audio=None):
        if image is None and mask is None:
            raise ValueError("[小珠光] 帧优化缺少输入：image 与 mask 至少连接一个")

        # 空批次：有任一连接输入为空帧即按空处理（已连接的输出返回 1 帧空张量）
        if (image is not None and image.shape[0] == 0) or (mask is not None and mask.shape[0] == 0):
            empty_img = torch.zeros(1, 1, 1, 3) if image is not None else None
            empty_mask = torch.zeros(1, 1, 1) if mask is not None else None
            return (empty_img, 0, 0, 0, empty_mask, None)

        # 参考帧数：优先图像，未连图像时用遮罩
        batch_count = image.shape[0] if image is not None else mask.shape[0]

        period, offset = (17, 5) if frame_rule == "17N+5" else (4, 1)
        front_fill = ((batch_count + period - 1) // period) * period + 5 - batch_count

        back_fill = 0
        if multi_fill:
            lower_bound = max(1, int(min_frames))
            target = max(0, (lower_bound - offset + period - 1) // period) * period + offset
            current = batch_count + front_fill
            if current < target:
                back_fill = target - current

        # ── 图像 ──
        result = None
        if image is not None:
            first_frame = image[0:1].clone()
            last_frame = image[-1:].clone()
            result = torch.cat([first_frame] * front_fill + [image], dim=0)
            if back_fill > 0:
                result = torch.cat([result] + [last_frame] * back_fill, dim=0)

        # ── 遮罩：按与图像完全相同的补帧规则处理 ──
        mask_out = None
        if mask is not None:
            if mask.dim() == 2:
                mask = mask.unsqueeze(0)
            # 双输入时：单帧遮罩自动复制到图像帧数；数量不一致时对齐到图像帧数；
            # 空间尺寸与图像不一致时最近邻对齐（遮罩插值用 nearest 保持二值边界）。
            # 注意：IMAGE 是 4D (B,H,W,C)，空间尺寸应取 shape[-3:-1] 而非 [-2:]（那是 W,C）
            if image is not None:
                if mask.shape[0] != batch_count:
                    mask = repeat_to_batch_size(mask, batch_count)
                if mask.shape[-2:] != image.shape[-3:-1]:
                    mask = F.interpolate(
                        mask.unsqueeze(1),
                        size=(image.shape[-3], image.shape[-2]),
                        mode="nearest",
                    ).squeeze(1)
            m_first = mask[0:1].clone()
            m_last = mask[-1:].clone()
            mask_out = torch.cat([m_first] * front_fill + [mask], dim=0)
            if back_fill > 0:
                mask_out = torch.cat([mask_out] + [m_last] * back_fill, dim=0)

        out_batch = batch_count + front_fill + back_fill
        audio_out = None
        if audio is not None:
            if not math.isfinite(fps) or fps <= 0:
                raise ValueError("[小珠光] 音频同步帧率必须为正数")
            sample_rate = audio["sample_rate"]
            if sample_rate <= 0:
                raise ValueError("[小珠光] 音频采样率必须为正数")
            waveform = audio["waveform"]
            # 以视频时间轴计算采样位置，避免逐段取整造成累积误差。
            start = round(front_fill * sample_rate / fps)
            end = round((front_fill + batch_count) * sample_rate / fps)
            total = round(out_batch * sample_rate / fps)
            source_samples = end - start
            aligned = waveform[..., :source_samples]
            aligned = F.pad(aligned, (0, max(0, source_samples - aligned.shape[-1])))
            audio_out = {**audio, "waveform": F.pad(aligned, (start, total - end))}
        return (result, out_batch, batch_count, front_fill, mask_out, audio_out)

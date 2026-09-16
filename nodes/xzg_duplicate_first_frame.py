import torch
import math
import torch.nn.functional as F
from comfy.utils import repeat_to_batch_size


class XiaozhuguangDuplicateFirstFrame:
    """
    小珠光帧优化
    根据原始帧数自动计算补帧数量，复制首帧填充
    补帧公式：ceil(a/4)*4 + 5 - a，其中a为原始帧数
    多参补帧：开启后，若总帧数不足73帧，则用尾帧补足到73帧

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
            },
            "optional": {
                "image": ("IMAGE",),
                "mask": ("MASK",),
            },
        }

    # mask 输出放在末尾：旧工作流节点刷新定义时只需在末尾追加新输出槽，
    # 既有连线（image/frame_count/original_count/front_fill）位置不变、无需重连
    RETURN_TYPES = ("IMAGE", "INT", "INT", "INT", "MASK")
    RETURN_NAMES = ("image", "frame_count", "original_count", "front_fill", "mask")
    FUNCTION = "execute"
    CATEGORY = "xiaozhuguang"

    @classmethod
    def IS_CHANGED(cls, multi_fill=False, image=None, mask=None):
        # 纯函数：前置输入未变则直接使用 ComfyUI 缓存，不重算
        return None

    def execute(self, multi_fill=False, image=None, mask=None):
        if image is None and mask is None:
            raise ValueError("[小珠光] 帧优化缺少输入：image 与 mask 至少连接一个")

        # 空批次：有任一连接输入为空帧即按空处理（已连接的输出返回 1 帧空张量）
        if (image is not None and image.shape[0] == 0) or (mask is not None and mask.shape[0] == 0):
            empty_img = torch.zeros(1, 1, 1, 3) if image is not None else None
            empty_mask = torch.zeros(1, 1, 1) if mask is not None else None
            return (empty_img, empty_mask, 0, 0, 0)

        # 参考帧数：优先图像，未连图像时用遮罩
        batch_count = image.shape[0] if image is not None else mask.shape[0]

        front_fill = math.ceil(batch_count / 4) * 4 + 5 - batch_count

        back_fill = 0
        if multi_fill:
            target = 73
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
        return (result, out_batch, batch_count, front_fill, mask_out)
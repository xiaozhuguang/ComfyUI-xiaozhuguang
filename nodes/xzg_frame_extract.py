import torch


class XiaozhuguangFrameExtract:
    """
    小珠光帧提取
    从补帧后的批量图像/遮罩中提取原始内容
    去掉前补帧和后补帧，保留中间的原始帧
    支持仅图像、仅遮罩、或两者同时输入
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "optional": {
                "image": ("IMAGE",),
                "mask": ("MASK",),
                "front_fill": ("INT", {"default": 0, "min": 0, "max": 99999, "step": 1, "forceInput": True}),
                "back_fill": ("INT", {"default": 0, "min": 0, "max": 99999, "step": 1, "forceInput": True}),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "mask")
    FUNCTION = "execute"
    CATEGORY = "xiaozhuguang"

    @classmethod
    def IS_CHANGED(cls, image=None, mask=None, front_fill=0, back_fill=0):
        return float("NaN")

    def execute(self, image=None, mask=None, front_fill=0, back_fill=0):
        has_image = image is not None
        has_mask = mask is not None

        if not has_image and not has_mask:
            empty = torch.zeros(1, 1, 1, 3, dtype=torch.float32)
            empty_mask = torch.zeros(1, 1, 1, dtype=torch.float32)
            return (empty, empty_mask)

        if has_image:
            batch_count = image.shape[0]
            img_h, img_w = image.shape[1], image.shape[2]
        else:
            mask_in = mask.clone()
            if mask_in.dim() == 2:
                mask_in = mask_in.unsqueeze(0)
            batch_count = mask_in.shape[0]
            img_h, img_w = mask_in.shape[1], mask_in.shape[2]

        if batch_count == 0:
            empty = torch.zeros(1, max(img_h, 1), max(img_w, 1), 3, dtype=image.dtype if has_image else torch.float32)
            empty_mask = torch.zeros(1, max(img_h, 1), max(img_w, 1), dtype=torch.float32)
            return (empty, empty_mask)

        start = front_fill
        end = batch_count - back_fill

        if start >= end or start >= batch_count:
            empty = torch.zeros(1, img_h, img_w, 3, dtype=image.dtype if has_image else torch.float32)
            empty_mask = torch.zeros(1, img_h, img_w, dtype=torch.float32)
            print(f'[小珠光帧提取] 提取范围无效: 前补={front_fill}, 后补={back_fill}, 总帧数={batch_count}')
            return (empty, empty_mask)

        if start < 0:
            start = 0
        if end > batch_count:
            end = batch_count

        out_image = None
        if has_image:
            out_image = image[start:end].clone()
            out_batch = out_image.shape[0]
            print(f'[小珠光帧提取] 图像: 输入 {batch_count} 帧, 去前补 {front_fill} 帧, 去后补 {back_fill} 帧, 输出 {out_batch} 帧')
        else:
            out_image = torch.zeros(end - start, img_h, img_w, 3, dtype=torch.float32)

        out_mask = None
        if has_mask:
            mask_in = mask.clone()
            if mask_in.dim() == 2:
                mask_in = mask_in.unsqueeze(0)
            mask_batch = mask_in.shape[0]
            m_start = min(start, mask_batch)
            m_end = min(end, mask_batch)
            if m_start >= m_end:
                out_mask = torch.zeros(1, mask_in.shape[1], mask_in.shape[2], dtype=mask_in.dtype)
            else:
                out_mask = mask_in[m_start:m_end].clone()
            print(f'[小珠光帧提取] 遮罩: 输入 {mask_batch} 帧, 输出 {out_mask.shape[0]} 帧')
        else:
            out_mask = torch.zeros(end - start, img_h, img_w, dtype=torch.float32)

        return (out_image, out_mask)

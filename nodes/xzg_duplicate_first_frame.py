import torch
import math


class XiaozhuguangDuplicateFirstFrame:
    """
    小珠光帧优化
    根据原始帧数自动计算补帧数量，复制首帧填充
    补帧公式：ceil(a/4)*4 + 5 - a，其中a为原始帧数
    多参补帧：开启后，若总帧数不足73帧，则用尾帧补足到73帧
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "multi_fill": ("BOOLEAN", {"default": False}),
            },
        }

    RETURN_TYPES = ("IMAGE", "INT", "INT", "INT", "INT", "IMAGE", "IMAGE")
    RETURN_NAMES = ("image", "frame_count", "original_count", "front_fill", "back_fill", "first_frame", "last_frame")
    FUNCTION = "execute"
    CATEGORY = "xiaozhuguang"

    @classmethod
    def IS_CHANGED(cls, image, multi_fill=False):
        return float("NaN")

    def execute(self, image, multi_fill=False):
        batch_count = image.shape[0]
        if batch_count == 0:
            empty = torch.zeros(1, 1, 1, 3, dtype=image.dtype)
            return (empty, 0, 0, 0, 0, empty, empty)

        front_fill = math.ceil(batch_count / 4) * 4 + 5 - batch_count

        first_frame = image[0:1].clone()
        last_frame = image[-1:].clone()
        front_dup = [first_frame] * front_fill
        result = torch.cat(front_dup + [image], dim=0)

        back_fill = 0
        if multi_fill:
            target = 73
            current = result.shape[0]
            if current < target:
                back_fill = target - current
                back_dup = [last_frame] * back_fill
                result = torch.cat([result] + back_dup, dim=0)

        out_batch = result.shape[0]
        mode = "多参补帧" if multi_fill else "标准补帧"
        print(f'[小珠光帧优化] [{mode}] 输入 {batch_count} 帧, 前补 {front_fill} 帧, 后补 {back_fill} 帧, 输出 {out_batch} 帧')

        return (result, out_batch, batch_count, front_fill, back_fill, first_frame, last_frame)
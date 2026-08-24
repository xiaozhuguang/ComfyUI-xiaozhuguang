import torch


class XiaozhuguangMaskInvert:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"mask": ("MASK",)}}

    RETURN_TYPES = ("MASK",)
    RETURN_NAMES = ("遮罩",)
    FUNCTION = "execute"
    CATEGORY = "xiaozhuguang"
    DESCRIPTION = "反转遮罩（白黑互换）：1.0 - mask，直接张量运算，支持 GPU 与批量。"

    def execute(self, mask):
        if mask.dim() == 2:
            mask = torch.unsqueeze(mask, 0)
        return (1.0 - mask,)
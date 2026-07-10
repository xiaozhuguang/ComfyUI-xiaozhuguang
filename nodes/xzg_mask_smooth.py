import torch
import torch.nn.functional as F


class XiaozhuguangMaskSmooth:
    """
    小珠光遮罩钝化
    通过帧间平滑减少遮罩的跳动
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "遮罩": ("MASK",),
                "平滑方式": (["滑动窗口均值", "指数移动平均", "高斯加权"], {"default": "滑动窗口均值"}),
                "窗口大小": ("INT", {"default": 5, "min": 1, "max": 31, "step": 2}),
                "平滑强度": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.01}),
            },
        }

    RETURN_TYPES = ("MASK",)
    RETURN_NAMES = ("遮罩",)
    FUNCTION = "execute"
    CATEGORY = "小珠光"

    def execute(self, 遮罩, 平滑方式, 窗口大小, 平滑强度):
        mask = 遮罩
        if mask.dim() == 2:
            mask = mask.unsqueeze(0)

        B, H, W = mask.shape

        if B <= 1 or 窗口大小 <= 1 or 平滑强度 <= 0:
            return (mask,)

        radius = 窗口大小 // 2

        if 平滑方式 == "滑动窗口均值":
            result = self._sliding_window_average(mask, radius, 平滑强度)
        elif 平滑方式 == "指数移动平均":
            result = self._ema(mask, 平滑强度)
        else:
            result = self._gaussian_weighted(mask, radius, 平滑强度)

        result = torch.clamp(result, 0.0, 1.0)
        return (result,)

    def _sliding_window_average(self, mask, radius, strength):
        B, H, W = mask.shape
        result = mask.clone()

        for i in range(B):
            start = max(0, i - radius)
            end = min(B, i + radius + 1)
            window = mask[start:end]
            avg = window.mean(dim=0)
            result[i] = mask[i] * (1 - strength) + avg * strength

        return result

    def _ema(self, mask, strength):
        B, H, W = mask.shape
        result = mask.clone()

        alpha = strength
        for i in range(1, B):
            result[i] = result[i - 1] * (1 - alpha) + mask[i] * alpha

        result_backward = mask.clone()
        for i in range(B - 2, -1, -1):
            result_backward[i] = result_backward[i + 1] * (1 - alpha) + mask[i] * alpha

        result = (result + result_backward) / 2
        return result

    def _gaussian_weighted(self, mask, radius, strength):
        B, H, W = mask.shape
        result = mask.clone()

        window_size = radius * 2 + 1
        sigma = radius / 2.0
        x = torch.arange(window_size, dtype=torch.float32) - radius
        gauss = torch.exp(-x.pow(2) / (2 * sigma.pow(2)))
        gauss = gauss / gauss.sum()

        for i in range(B):
            weighted_sum = torch.zeros(H, W, dtype=mask.dtype, device=mask.device)
            weight_sum = 0.0

            for j in range(-radius, radius + 1):
                idx = i + j
                if 0 <= idx < B:
                    w = gauss[j + radius]
                    weighted_sum += mask[idx] * w
                    weight_sum += w

            if weight_sum > 0:
                avg = weighted_sum / weight_sum
                result[i] = mask[i] * (1 - strength) + avg * strength

        return result

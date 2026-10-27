import math
import torch
import torch.nn.functional as F


class XiaozhuguangFrameExtract:
    """
    小珠光帧提取
    从补帧后的批量图像/遮罩中提取原始内容
    前补帧 N：裁剪掉最前面的 N 张图像
    原始帧数 M：踢掉前补帧后，从第 N+1 张起获取 M 张图像
    支持仅图像、仅遮罩、或两者同时输入
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "optional": {
                "fps": ("FLOAT", {"default": 24.0, "min": 0.01, "max": 1000.0, "step": 0.01,
                                  "tooltip": "音频裁剪使用的帧率，须与帧优化和视频合成帧率一致；未接音频时不生效。"}),
                "image": ("IMAGE",),
                "mask": ("MASK",),
                "fetch_count": ("INT", {"default": 99999, "min": 0, "max": 99999, "step": 1, "forceInput": True}),
                "front_fill": ("INT", {"default": 0, "min": 0, "max": 99999, "step": 1, "forceInput": True}),
                "audio": ("AUDIO",),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK", "AUDIO")
    RETURN_NAMES = ("image", "mask", "audio")
    FUNCTION = "execute"
    CATEGORY = "小珠光/视频"

    @classmethod
    def IS_CHANGED(cls, image=None, mask=None, fetch_count=99999, front_fill=0, audio=None, fps=24.0):
        # 纯函数：输入未变（含 front_fill/fetch_count 等参数）则直接使用缓存，不重算
        return None

    def execute(self, image=None, mask=None, fetch_count=99999, front_fill=0, audio=None, fps=24.0):
        has_image = image is not None
        has_mask = mask is not None

        if not has_image and not has_mask:
            empty = torch.zeros(1, 1, 1, 3, dtype=torch.float32)
            empty_mask = torch.zeros(1, 1, 1, dtype=torch.float32)
            return (empty, empty_mask, None)

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
            return (empty, empty_mask, None)

        start = front_fill
        count = fetch_count

        if count <= 0 or start >= batch_count:
            empty = torch.zeros(1, img_h, img_w, 3, dtype=image.dtype if has_image else torch.float32)
            empty_mask = torch.zeros(1, img_h, img_w, dtype=torch.float32)
            return (empty, empty_mask, None)

        if start < 0:
            start = 0

        end = start + count
        if end > batch_count:
            end = batch_count

        if end <= start:
            empty = torch.zeros(1, img_h, img_w, 3, dtype=image.dtype if has_image else torch.float32)
            empty_mask = torch.zeros(1, img_h, img_w, dtype=torch.float32)
            return (empty, empty_mask, None)

        out_image = None
        if has_image:
            out_image = image[start:end].clone()
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
        else:
            out_mask = torch.zeros(end - start, img_h, img_w, dtype=torch.float32)

        audio_out = None
        if audio is not None:
            if not math.isfinite(fps) or fps <= 0:
                raise ValueError("[小珠光] 音频裁剪帧率必须为正数")
            sample_rate = audio["sample_rate"]
            if sample_rate <= 0:
                raise ValueError("[小珠光] 音频采样率必须为正数")
            sample_start = round(start * sample_rate / fps)
            sample_end = round(end * sample_rate / fps)
            waveform = audio["waveform"][..., sample_start:sample_end].clone()
            # 短音频补静音，保证音频覆盖实际提取的画面区间。
            waveform = F.pad(waveform, (0, max(0, sample_end - sample_start - waveform.shape[-1])))
            audio_out = {**audio, "waveform": waveform}
        return (out_image, out_mask, audio_out)

# -*- coding: utf-8 -*-
"""小珠光节点: star_upscale（Star Upscale 2.6，调用外部 neuroserver 引擎）。

完全集成自 ComfyUI-TopazStarlight 的 nodes.py（原节点类 StarUpscale，映射键保持
"StarUpscale" 以兼容既有工作流；显示名 star_upscale）。引擎与模型位于
<ComfyUI>/models/star_upscale，由本包 nodes/star_pipeline.py 负责定位与调用。
所有输入名使用中文，便于识别。
"""
import os, tempfile, uuid
import numpy as np
import torch
import torch.nn.functional as F
try:
    from comfy.utils import ProgressBar
    _HAS_PBAR = True
except Exception:
    ProgressBar = None
    _HAS_PBAR = False
from .star_pipeline import write_frames_to_video, run_upscale, read_video_to_frames

# 输入编码质量 (NVENC constqp, 越小越无损)。固定 10，不再暴露到界面。
_INPUT_ENCODE_Q = 10

# 星光 (Starlight) 模型原生只支持 1X/2X/3X/4X 整数倍 (官方: Minimum/2x/3x/4x)。
# 输出严格 = 输入 × 所选倍数，不做任何目标尺寸取整/重采样。
_NATIVE_FACTORS = (1, 2, 3, 4)
_UPSCALE_CHOICES = [f'{f}X' for f in _NATIVE_FACTORS]   # ["1X","2X","3X","4X"]


def _auto_max_gpu_mem():
    """自动取"显卡总显存-1GiB"作为引擎显存上限, 不再让用户手动设置。

    引擎的 max_gpu_mem 只是"天花板"不是"目标"：设多大都不会让显存占用变高，
    只会限制最高可用量（输入不够大时根本用不满）。因此直接按显卡容量自动给一个
    足够高的上限即可，用户无需关心。
    """
    try:
        import torch
        if torch.cuda.is_available():
            total = torch.cuda.get_device_properties(0).total_memory / (1024 ** 3)
            return max(8.0, round(total - 1.0, 1))
    except Exception:
        pass
    return 47.0


class StarUpscale:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE",),
                "帧率": ("FLOAT", {"default": 24.0, "min": 0.1, "max": 240.0, "step": 1.0, "round": 1.0,
                                   "tooltip": "和视频实际帧率一致，支持小数输入（如 23.976 / 29.97）；界面按整数显示，内部自动取整"}),
                "放大倍数": (_UPSCALE_CHOICES, {
                             "default": "2X",
                             "tooltip": "模型原生整数倍（星光只支持 1X/2X/3X/4X）：输出 = 输入×倍数，不重采样。"
                                        "1X=只增强不放大；模型输出上限 4K（输入已达 4K 时更高倍数会被引擎封顶）"}),
                "细节": ("FLOAT", {"default": 1.0, "min": 0.5, "max": 1.5, "step": 0.1,
                                   "tooltip": "细节增强力度：0.7柔和 / 1.0默认 / 1.3细节最猛"}),
                "输出长边": ("INT", {"default": 0, "min": 0, "max": 7680, "step": 1,
                                     "tooltip": "可选：原生倍数放大完成后，把输出长边对齐到该像素值（只缩小不放大，0=不限制保持原样）。"
                                                "例：2X 放大的 3840 长边配 2160 → 缩小到 2K；若原生输出已小于该值则保持不动。"}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    FUNCTION = "run"
    CATEGORY = "Star Upscale"

    def run(self, 图像, 帧率, 放大倍数, 细节, 输出长边, unique_id=None):
        b, h, w, c = 图像.shape
        if c != 3:
            raise ValueError(f'Star Upscale expects RGB images, got {c} channels')
        frames = (图像 * 255.0).clamp(0, 255).cpu().numpy().astype(np.uint8)

        model_id = "slp-26"   # 固定: 2.6 模型 (1.7.1 引擎 upscaleserver)

        # 帧率：接受浮点输入，内部取整为整数
        fps = int(round(帧率))

        # 原生整数倍 1X/2X/3X/4X：输出严格 = 输入 × 倍数，不重采样。
        scale = int(放大倍数[0])   # "2X" -> 2
        ow = int(round(w * scale)); ow += ow % 2
        oh = int(round(h * scale)); oh += oh % 2

        tag = uuid.uuid4().hex[:10]
        tmp = tempfile.gettempdir()
        in_video = os.path.join(tmp, f'star_in_{tag}.mp4')
        out_video = os.path.join(tmp, f'star_out_{tag}.mp4')
        try:
            print(f'[StarUpscale] {b}帧 {w}x{h} -> {ow}x{oh} ({放大倍数} 原生) 细节{细节} fps={fps}')
            write_frames_to_video(frames, fps, in_video, _INPUT_ENCODE_Q)
            pbar = ProgressBar(b, node_id=unique_id) if (_HAS_PBAR and b > 0) else None
            def _on_progress(cur, total):
                if pbar is not None:
                    pbar.update_absolute(min(cur, total), total)
            run_upscale(in_video, out_video, scale, b, w, h, 细节, model_id,
                        max_gpu_mem=_auto_max_gpu_mem(), on_progress=_on_progress)
            out_frames = read_video_to_frames(out_video)
            tensor = torch.from_numpy(out_frames.astype(np.float32) / 255.0)
            # 输出长边控制：原生倍数放大完成后，长边大于目标则缩小对齐（只缩小不放大）
            if 输出长边 > 0:
                bh, bw = tensor.shape[1], tensor.shape[2]
                cur_long = max(bw, bh)
                if cur_long > 输出长边:
                    s = 输出长边 / cur_long
                    nw = int(round(bw * s)); nw += nw % 2
                    nh = int(round(bh * s)); nh += nh % 2
                    t = tensor.permute(0, 3, 1, 2)
                    t = F.interpolate(t, size=(nh, nw), mode='bicubic', align_corners=False)
                    tensor = t.permute(0, 2, 3, 1)
                    print(f'[StarUpscale] 长边控制: {cur_long} -> {max(nw, nh)}')
            print(f'[StarUpscale] 完成: {tensor.shape[0]}帧 @ {tensor.shape[2]}x{tensor.shape[1]}')
        finally:
            for f in (in_video, out_video):
                try:
                    if os.path.isfile(f):
                        os.remove(f)
                except OSError:
                    pass

        return (tensor,)


NODE_CLASS_MAPPINGS = {
    "StarUpscale": StarUpscale,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "StarUpscale": "star_upscale",
}

import os
import json
from nodes import PreviewImage
import folder_paths
import numpy as np
import torch
from PIL import Image


class XiaozhuguangImageCompare(PreviewImage):
    """小珠光图像对比 - 在画布上对比两张图像，支持减少卡顿模式"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                "a": ("IMAGE",),
                "b": ("IMAGE",),
                "reduce_lag": ("BOOLEAN", {"default": False, "label_on": "开启", "label_off": "关闭"}),
                "show_line": ("BOOLEAN", {"default": True, "label_on": "开启", "label_off": "关闭"}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO"
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "compare_images"
    CATEGORY = "xiaozhuguang"
    OUTPUT_NODE = True
    DESCRIPTION = "对比两张图像，鼠标拖拽分割线查看差异。开启减少卡顿：JPG+3840px+Q85；关闭：JPG+6400px+Q80"

    def compare_images(self, a=None, b=None, reduce_lag=False, show_line=True,
                       filename_prefix="xzg.compare.",
                       prompt=None, extra_pnginfo=None):

        result = {"ui": {"a_images": [], "b_images": []}}

        # 开启模式: JPG + 3840px + Q85; 关闭模式: JPG + 6400px + Q85
        max_side = 3840 if reduce_lag else 6400
        quality = 85

        if a is not None and len(a) > 0:
            result['ui']['a_images'] = self._save_compressed(a, filename_prefix + "comp.", max_side, quality)

        if b is not None and len(b) > 0:
            result['ui']['b_images'] = self._save_compressed(b, filename_prefix + "comp.", max_side, quality)

        return result

    def _save_compressed(self, images, prefix="xzg.comp.", max_side=3840, quality=85):
        """GPU 加速缩放 + JPG 快速保存"""
        output_dir = folder_paths.get_temp_directory()
        os.makedirs(output_dir, exist_ok=True)
        results = []

        for i, tensor in enumerate(images):
            # GPU 加速缩放: [B,H,W,C] -> [1,C,H,W] -> resize -> [H,W,C]
            img = tensor.unsqueeze(0).permute(0, 3, 1, 2)
            h, w = img.shape[2], img.shape[3]

            if max(w, h) > max_side:
                ratio = max_side / max(w, h)
                new_w = int(w * ratio)
                new_h = int(h * ratio)
                img = torch.nn.functional.interpolate(img, size=(new_h, new_w), mode='bicubic', align_corners=False)

            # 转回 numpy/PIL 并保存为 JPG（比 WebP 快很多）
            img = img.squeeze(0).permute(1, 2, 0).cpu().numpy()
            pil_img = Image.fromarray((img * 255).clip(0, 255).astype(np.uint8))

            import random
            filename = f"{prefix}{''.join(random.choice('abcdefghijklmnopqrstuvwxyz0123456789') for _ in range(8))}_{i}.jpg"
            filepath = os.path.join(output_dir, filename)
            pil_img.save(filepath, "JPEG", quality=quality, optimize=True)
            results.append({
                "filename": filename,
                "subfolder": "",
                "type": "temp"
            })

        return results

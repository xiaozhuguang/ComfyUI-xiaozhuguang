import os
import random
import numpy as np
import torch
from PIL import Image
import folder_paths
from nodes import PreviewImage

# 用于懒编码：预览节点执行时仅存原始像素(uint8)，右键保存真实分辨率图时才临时编码 PNG
REAL_STORE = {}


class XiaozhuguangImagePreview(PreviewImage):
    """小珠光预览 - 在画布上预览图像，支持减小卡顿(极速流畅)模式。
    预览图为压缩图(速度与对比节点一致)，下方显示真实分辨率；
    右键菜单保存真实分辨率原图时，才临时编码全分辨率 PNG。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                "images": ("IMAGE",),
                "reduce_lag": ("BOOLEAN", {"default": False, "label_on": "开启", "label_off": "关闭"}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "preview_images"
    CATEGORY = "xiaozhuguang"
    OUTPUT_NODE = True
    DESCRIPTION = "预览图像（支持多图）。预览为压缩图，下方显示真实分辨率；右键保存时才临时编码真实分辨率 PNG"

    def preview_images(self, images=None, reduce_lag=False,
                       filename_prefix="xzg.preview.",
                       prompt=None, extra_pnginfo=None):

        result = {"ui": {"xzg_preview": []}}

        # 开启减少卡顿: JPG + 3840px + Q85; 关闭(极速流畅): JPG + 6400px + Q80
        max_side = 3840 if reduce_lag else 6400
        quality = 85 if reduce_lag else 80

        if images is not None and len(images) > 0:
            result['ui']['xzg_preview'] = self._save_preview(images, filename_prefix, max_side, quality)

        return result

    def _save_preview(self, images, prefix="xzg.preview.", max_side=3840, quality=85):
        """仅产出压缩预览图(显示) + 真实宽高 + 一个懒编码令牌；
        真实分辨率原图(PNG)只在右键保存时由后端临时编码，避免拖慢执行速度。"""
        output_dir = folder_paths.get_temp_directory()
        os.makedirs(output_dir, exist_ok=True)
        rand = lambda: "".join(random.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(8))

        # 令牌：用于右键时回查原始全分辨率图像
        token = "".join(random.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(16))
        REAL_STORE[token] = []
        # 控制内存：过多则丢弃最早的执行结果
        if len(REAL_STORE) > 100:
            old = next(iter(REAL_STORE))
            REAL_STORE.pop(old, None)

        results = []
        for i, tensor in enumerate(images):
            h, w = tensor.shape[0], tensor.shape[1]

            # 仅保存原始像素（uint8，CPU）到内存，供右键时编码 PNG，不在此处编码
            real_np = (tensor.cpu().numpy() * 255).clip(0, 255).astype(np.uint8)
            REAL_STORE[token].append(real_np)

            # 压缩预览：GPU 加速缩放 + JPG 快速保存（仅用于画布显示）
            img = tensor.unsqueeze(0).permute(0, 3, 1, 2)
            if max(w, h) > max_side:
                ratio = max_side / max(w, h)
                new_w = int(w * ratio)
                new_h = int(h * ratio)
                img = torch.nn.functional.interpolate(img, size=(new_h, new_w), mode='bicubic', align_corners=False)

            img = img.squeeze(0).permute(1, 2, 0).cpu().numpy()
            pil_img = Image.fromarray((img * 255).clip(0, 255).astype(np.uint8))

            comp_name = f"{prefix}{rand()}_{i}.jpg"
            pil_img.save(os.path.join(output_dir, comp_name), "JPEG", quality=quality, optimize=True)

            results.append({
                "filename": comp_name,
                "subfolder": "",
                "type": "temp",
                "real_token": token,
                "real_index": i,
                "real_width": int(w),
                "real_height": int(h),
            })

        return results

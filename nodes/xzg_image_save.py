import os
import random
import numpy as np
import torch
from PIL import Image
import folder_paths
from nodes import PreviewImage
from .xzg_image_preview import REAL_STORE


class XiaozhuguangImageSave(PreviewImage):
    """小珠光保存 - 保存图像为 JPG(压缩) 或 PNG(无损)，画布预览始终为压缩JPG(流畅)。
    与小珠光预览完全相似的显示体验，但增加实际文件保存功能。
    JPG保存使用与预览相同的压缩参数；PNG保存为全分辨率无损。
    右键菜单可下载真实分辨率PNG(懒编码)或压缩JPG。
    文件名固定为 xzg-save_序号，用户可通过 output_path 自定义输出文件夹。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
            },
            "optional": {
                "output_path": ("STRING", {"default": "", "multiline": False}),
                "save_format": (["JPG", "PNG"], {"default": "JPG"}),
                "reduce_lag": ("BOOLEAN", {"default": False, "label_on": "开启", "label_off": "关闭"}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "save_images"
    CATEGORY = "xiaozhuguang"
    OUTPUT_NODE = True
    DESCRIPTION = "保存图像：JPG(压缩)或PNG(无损)。画布预览始终为压缩JPG(流畅)。右键可下载真实分辨率PNG或压缩JPG。"

    def save_images(self, images, output_path="", save_format="JPG", reduce_lag=False,
                    prompt=None, extra_pnginfo=None):

        max_side = 3840 if reduce_lag else 6400
        quality = 85 if reduce_lag else 80

        # 输出目录（用户可自定义子文件夹）
        if output_path and output_path.strip():
            base_dir = os.path.join(folder_paths.get_output_directory(), output_path.strip().strip("/\\"))
            subfolder = output_path.strip()
        else:
            base_dir = folder_paths.get_output_directory()
            subfolder = ""
        os.makedirs(base_dir, exist_ok=True)

        # 临时目录（预览图）
        temp_dir = folder_paths.get_temp_directory()
        os.makedirs(temp_dir, exist_ok=True)

        rand = lambda: "".join(random.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(8))

        # 文件名前缀：固定 xzg-save，后接5位序号避免重复
        filename_prefix = "xzg-save"

        # 懒编码令牌：用于右键保存真实分辨率 PNG
        token = "".join(random.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(16))
        REAL_STORE[token] = []
        if len(REAL_STORE) > 100:
            old = next(iter(REAL_STORE))
            REAL_STORE.pop(old, None)

        saved = []
        entries = []
        counter = 0

        for i, tensor in enumerate(images):
            h, w = tensor.shape[0], tensor.shape[1]

            # 存储原始像素（uint8，CPU），供右键时编码 PNG
            real_np = (tensor.cpu().numpy() * 255).clip(0, 255).astype(np.uint8)
            REAL_STORE[token].append(real_np)

            # GPU 加速压缩（仅做一次，用于预览和 JPG 保存）
            img = tensor.unsqueeze(0).permute(0, 3, 1, 2)
            if max(w, h) > max_side:
                ratio = max_side / max(w, h)
                new_w = int(w * ratio)
                new_h = int(h * ratio)
                img = torch.nn.functional.interpolate(img, size=(new_h, new_w), mode='bicubic', align_corners=False)
            img = img.squeeze(0).permute(1, 2, 0).cpu().numpy()
            compressed_pil = Image.fromarray((img * 255).clip(0, 255).astype(np.uint8))

            # 保存压缩 JPG 预览到临时目录（画布显示，始终 JPG）
            preview_fname = f"xzg.save.preview.{rand()}_{i}.jpg"
            compressed_pil.save(os.path.join(temp_dir, preview_fname), "JPEG", quality=quality, optimize=True)

            # 保存到输出目录
            while True:
                fname = f"{filename_prefix}_{counter:05d}"
                if save_format == "PNG":
                    full_path = os.path.join(base_dir, fname + ".png")
                else:
                    full_path = os.path.join(base_dir, fname + ".jpg")
                if not os.path.exists(full_path):
                    break
                counter += 1

            if save_format == "PNG":
                # 全分辨率 PNG（无损）
                Image.fromarray(real_np).save(full_path, "PNG")
            else:
                # 压缩 JPG（与预览相同的压缩参数）
                compressed_pil.save(full_path, "JPEG", quality=quality, optimize=True)

            saved.append({
                "filename": os.path.basename(full_path),
                "subfolder": subfolder,
                "type": "output"
            })

            entries.append({
                "filename": preview_fname,
                "subfolder": "",
                "type": "temp",
                "real_token": token,
                "real_index": i,
                "real_width": int(w),
                "real_height": int(h),
            })
            counter += 1

        result = {"ui": {"xzg_preview": entries, "saved": saved}}
        return result

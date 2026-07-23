import os
import random
import numpy as np
import torch
from PIL import Image
import folder_paths
from nodes import PreviewImage


class XiaozhuguangImageSave(PreviewImage):
    """小珠光保存 - 保存图像为 JPG 95% 或 PNG，并支持减少卡顿(极速流畅)预览模式。
    预览图为压缩图，下方显示真实分辨率；右键菜单可保存真实分辨率原图(即所保存的文件)。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "output_path": ("STRING", {"default": "", "multiline": False}),
                "filename_prefix": ("STRING", {"default": "xzg_save"}),
                "save_format": (["JPG 95%", "PNG"], {"default": "JPG 95%"}),
            },
            "optional": {
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
    DESCRIPTION = "保存图像：JPG 95% 或 PNG。预览为压缩图，下方显示真实分辨率；右键可保存真实分辨率原图"

    def save_images(self, images, output_path="", filename_prefix="xzg_save",
                    save_format="JPG 95%", reduce_lag=False,
                    prompt=None, extra_pnginfo=None):

        # 真实保存（全分辨率）：保存文件本身即为真实分辨率原图
        saved = self._save_full(images, output_path, filename_prefix, save_format)

        # 预览（压缩，用于前端画布显示）
        max_side = 3840 if reduce_lag else 6400
        quality = 85 if reduce_lag else 80
        preview = self._save_compressed(images, "xzg.save.preview.", max_side, quality)

        # 合并：预览图用于显示，real 指向保存的全分辨率文件，并附带真实宽高
        entries = []
        for i, (comp, real) in enumerate(zip(preview, saved)):
            h, w = images[i].shape[0], images[i].shape[1]
            entries.append({
                "filename": comp["filename"],
                "subfolder": comp["subfolder"],
                "type": comp["type"],
                "real": real,
                "real_width": int(w),
                "real_height": int(h),
            })

        result = {"ui": {"xzg_preview": entries, "saved": saved}}
        return result

    def _save_full(self, images, output_path, filename_prefix, save_format):
        if output_path and output_path.strip():
            base_dir = os.path.join(folder_paths.get_output_directory(), output_path.strip().strip("/\\"))
        else:
            base_dir = folder_paths.get_output_directory()
        os.makedirs(base_dir, exist_ok=True)

        saved = []
        counter = 0
        for tensor in images:
            img = (tensor.cpu().numpy() * 255).clip(0, 255).astype(np.uint8)
            pil = Image.fromarray(img)

            # 避免覆盖：查找可用文件名
            while True:
                fname = f"{filename_prefix}_{counter:05d}"
                if save_format == "PNG":
                    full = os.path.join(base_dir, fname + ".png")
                    if not os.path.exists(full):
                        break
                    counter += 1
                    continue
                else:
                    full = os.path.join(base_dir, fname + ".jpg")
                    if not os.path.exists(full):
                        break
                    counter += 1
                    continue

            if save_format == "PNG":
                pil.save(full, "PNG", pnginfo=None)
                saved.append({"filename": os.path.basename(full), "subfolder": output_path.strip() if output_path.strip() else "", "type": "output"})
            else:
                pil.save(full, "JPEG", quality=95, optimize=False, subsampling=0)
                saved.append({"filename": os.path.basename(full), "subfolder": output_path.strip() if output_path.strip() else "", "type": "output"})
            counter += 1

        return saved

    def _save_compressed(self, images, prefix="xzg.save.preview.", max_side=3840, quality=85):
        """GPU 加速缩放 + JPG 快速保存（仅预览显示，非真实分辨率）"""
        output_dir = folder_paths.get_temp_directory()
        os.makedirs(output_dir, exist_ok=True)
        rand = lambda: "".join(random.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(8))
        results = []

        for i, tensor in enumerate(images):
            img = tensor.unsqueeze(0).permute(0, 3, 1, 2)
            h, w = img.shape[2], img.shape[3]

            if max(w, h) > max_side:
                ratio = max_side / max(w, h)
                new_w = int(w * ratio)
                new_h = int(h * ratio)
                img = torch.nn.functional.interpolate(img, size=(new_h, new_w), mode='bicubic', align_corners=False)

            img = img.squeeze(0).permute(1, 2, 0).cpu().numpy()
            pil_img = Image.fromarray((img * 255).clip(0, 255).astype(np.uint8))

            filename = f"{prefix}{rand()}_{i}.jpg"
            pil_img.save(os.path.join(output_dir, filename), "JPEG", quality=quality, optimize=True)
            results.append({
                "filename": filename,
                "subfolder": "",
                "type": "temp",
            })

        return results

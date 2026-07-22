import os
import json
from nodes import PreviewImage
import folder_paths
import numpy as np
from PIL import Image


class XiaozhuguangImageCompare(PreviewImage):
    """小珠光图像对比 - 在画布上对比两张图像，缩放时显示缩略图，停止后加载原图"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                "a": ("IMAGE",),
                "b": ("IMAGE",),
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
    DESCRIPTION = "对比两张图像，鼠标拖拽分割线查看差异。缩放画布时显示压缩图保证流畅，停止缩放后加载原图"

    def compare_images(self, a=None, b=None,
                       filename_prefix="xzg.compare.",
                       prompt=None, extra_pnginfo=None):

        result = {"ui": {"a_images": [], "b_images": [], "a_thumbs": [], "b_thumbs": []}}

        if a is not None and len(a) > 0:
            full = self.save_images(a, filename_prefix, prompt, extra_pnginfo)['ui']['images']
            thumbs = self._save_thumbnails(a, filename_prefix + "thumb.")
            result['ui']['a_images'] = full
            result['ui']['a_thumbs'] = thumbs

        if b is not None and len(b) > 0:
            full = self.save_images(b, filename_prefix, prompt, extra_pnginfo)['ui']['images']
            thumbs = self._save_thumbnails(b, filename_prefix + "thumb.")
            result['ui']['b_images'] = full
            result['ui']['b_thumbs'] = thumbs

        return result

    def _save_thumbnails(self, images, prefix="xzg.thumb."):
        """保存缩略图版本（最大 512px），返回与 save_images 相同格式的数据"""
        output_dir = folder_paths.get_temp_directory()
        os.makedirs(output_dir, exist_ok=True)
        results = []

        for i, tensor in enumerate(images):
            img = tensor.cpu().numpy()
            img = (img * 255).clip(0, 255).astype(np.uint8)
            pil_img = Image.fromarray(img)

            # 缩放到最长边 512px
            w, h = pil_img.size
            max_side = 512
            if max(w, h) > max_side:
                ratio = max_side / max(w, h)
                new_w = int(w * ratio)
                new_h = int(h * ratio)
                pil_img = pil_img.resize((new_w, new_h), Image.LANCZOS)

            import random
            filename = f"{prefix}{''.join(random.choice('abcdefghijklmnopqrstuvwxyz0123456789') for _ in range(8))}_{i}.jpg"
            filepath = os.path.join(output_dir, filename)
            pil_img.save(filepath, "JPEG", quality=75)
            results.append({
                "filename": filename,
                "subfolder": "",
                "type": "temp"
            })

        return results
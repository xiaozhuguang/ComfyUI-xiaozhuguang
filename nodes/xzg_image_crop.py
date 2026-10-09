
import math
import torch
import numpy as np
import cv2
import re


class XiaozhuguangImageCrop:
    CATEGORY = "小珠光/图片"
    DESCRIPTION = "根据mask裁剪单张图像区域并调整大小，批次输入自动使用第一张图片和第一个遮罩"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "resize_mode": (["lanczos", "nearest-exact", "bilinear", "bicubic"], {"default": "lanczos"}),
            },
            "optional": {
                "mask": ("MASK", {"tooltip": "裁剪遮罩，可不连接；未连接时自动按输入图大小生成全黑遮罩（即整图裁剪）"}),
                "Box_grow_factor": ("FLOAT", {"default": 1.0, "min": 1.0, "max": 5.0, "step": 0.05, "tooltip": "裁剪区域的扩展倍数，1.0表示不扩展，大于1.0表示按比例扩大"}),
                "kilopixels": ("FLOAT", {"default": 1000.0, "min": 100.0, "max": 10000.0, "step": 10.0, "tooltip": "目标图像的千像素数（十进制，1千像素=1000像素）。1000千像素=1000*1000像素，4194千像素≈2048*2048像素"}),
                "divisible_by": ("INT", {"default": 8, "min": 1, "max": 1024, "step": 1, "tooltip": "目标分辨率必须被此数字整除"}),
                "ratio": (["auto", "1:1", "4:3", "3:4", "16:9", "9:16"], {"default": "auto", "tooltip": "裁剪比例模式，auto为自动检测最接近比例"}),
                "startup_threshold": ("FLOAT", {"default": 0.4, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": "当mask的box面积与输入图像的面积占比达到此阈值时，跳过ratio和box_grow_factor判断"}),
                "fill_color": ("STRING", {"default": "#FFFFFF", "tooltip": "边界超出时的填充颜色，支持hex格式(#FFFFFF/#FFF)或颜色名称(red/blue/green等)"}),
                "Box_grow_pixels": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 1, "tooltip": "在倍数扩展后，裁剪框上下左右每边增加的原图像素数，仅扩大裁剪范围，不膨胀遮罩；10表示50×50裁剪框扩为70×70，倍数为2时裁剪框为120×120。裁剪框按所选比例进一步补齐；auto达到启动阈值时跳过裁剪框扩展。遮罩随图像正常裁剪和缩放。0为不扩展"}),
            }
        }

    RETURN_TYPES = ("IMAGE", "XZG_IMAGE_CROPBOX", "MASK")
    RETURN_NAMES = ("cropped_image", "crop_box", "cropped_mask")
    FUNCTION = "crop_and_resize"

    def _find_best_aspect_ratio(self, width, height):
        aspect_ratios = [(1, 1), (4, 3), (3, 4), (16, 9), (9, 16)]
        input_ratio = width / height
        best_ratio = aspect_ratios[0]
        min_diff = float('inf')
        for ratio in aspect_ratios:
            ratio_value = ratio[0] / ratio[1]
            diff = abs(input_ratio - ratio_value)
            if diff < min_diff:
                min_diff = diff
                best_ratio = ratio
        return best_ratio

    def _hex_to_rgb(self, hex_color):
        color_names = {
            'white': (255, 255, 255),
            'black': (0, 0, 0),
            'red': (255, 0, 0),
            'green': (0, 128, 0),
            'blue': (0, 0, 255),
            'yellow': (255, 255, 0),
            'cyan': (0, 255, 255),
            'magenta': (255, 0, 255),
            'orange': (255, 165, 0),
            'pink': (255, 192, 203),
            'purple': (128, 0, 128),
            'gray': (128, 128, 128),
            'grey': (128, 128, 128),
        }
        hex_color = hex_color.strip().lower()
        if hex_color in color_names:
            return color_names[hex_color]
        hex_color = hex_color.lstrip('#')
        if len(hex_color) == 3:
            hex_color = ''.join([c*2 for c in hex_color])
        if not re.match('^[0-9a-f]{6}$', hex_color):
            return (255, 255, 255)
        r = int(hex_color[0:2], 16)
        g = int(hex_color[2:4], 16)
        b = int(hex_color[4:6], 16)
        return (r, g, b)

    def _calculate_target_dimensions(self, kilopixels, aspect_ratio, divisible_by=1):
        # 千像素→总像素（十进制）：1千像素=1000像素，故总像素 = 千像素*1000；如2048*2048=4194304像素≈4194千像素
        total_pixels = kilopixels * 1000
        width_ratio, height_ratio = aspect_ratio
        aspect_ratio_value = width_ratio / height_ratio
        target_height = int((total_pixels / aspect_ratio_value) ** 0.5)
        target_width = int(target_height * aspect_ratio_value)
        if divisible_by > 1:
            target_width = ((target_width + divisible_by - 1) // divisible_by) * divisible_by
            target_height = ((target_height + divisible_by - 1) // divisible_by) * divisible_by
        elif divisible_by == 1:
            target_width = target_width + 1 if target_width % 2 != 0 else target_width
            target_height = target_height + 1 if target_height % 2 != 0 else target_height
        return (target_width, target_height)



    def _compute_crop_box(self, mask_np, width, height, Box_grow_factor, ratio, startup_threshold, Box_grow_pixels=0):
        """根据 mask（numpy 灰度图 (H,W)）计算裁剪框，返回 (crop_x1,crop_y1,crop_x2,crop_y2), best_aspect_ratio"""
        coords = np.argwhere(mask_np > 0)
        if coords.shape[0] == 0:
            bbox = (0, 0, width, height)
        else:
            x1 = int(coords[:, 1].min())
            y1 = int(coords[:, 0].min())
            x2 = int(coords[:, 1].max()) + 1
            y2 = int(coords[:, 0].max()) + 1
            bbox = (x1, y1, x2, y2)

        x1, y1, x2, y2 = bbox
        bbox_width = x2 - x1
        bbox_height = y2 - y1

        image_area = width * height
        bbox_area = bbox_width * bbox_height
        area_ratio = bbox_area / image_area

        # 仅 auto 模式才允许“mask 占比达阈值即跳过比例/扩展”：
        # 用户显式指定 ratio（如 1:1）时，即使 mask 充满整图也应按该比例裁剪，
        # 超出部分用 fill_color 补齐，而不是直接输出整图。
        skip_ratio_and_grow = ratio == "auto" and area_ratio >= startup_threshold

        if skip_ratio_and_grow:
            crop_x1, crop_y1, crop_x2, crop_y2 = 0, 0, width, height
            best_aspect_ratio = (width, height)
        else:
            if ratio != "auto":
                width_ratio, height_ratio = map(int, ratio.split(":"))
                best_aspect_ratio = (width_ratio, height_ratio)
            else:
                best_aspect_ratio = self._find_best_aspect_ratio(bbox_width, bbox_height)
            width_ratio, height_ratio = best_aspect_ratio

            center_x = (x1 + x2) // 2
            center_y = (y1 + y2) // 2

            if width_ratio >= height_ratio:
                half_width = math.ceil(max(bbox_width, bbox_height * width_ratio / height_ratio) * Box_grow_factor / 2)
                half_height = int(half_width * height_ratio / width_ratio)
            else:
                half_height = math.ceil(max(bbox_height, bbox_width * height_ratio / width_ratio) * Box_grow_factor / 2)
                half_width = int(half_height * width_ratio / height_ratio)

            # 解析式已逼近最终尺寸（Box_grow>=1 通常已覆盖 bbox），此兜底仅防 int 舍入差 1 像素
            while half_width * 2 < bbox_width or half_height * 2 < bbox_height:
                if width_ratio >= height_ratio:
                    half_width += 1
                    half_height = int(half_width * height_ratio / width_ratio)
                else:
                    half_height += 1
                    half_width = int(half_height * width_ratio / height_ratio)

            crop_x1 = center_x - half_width
            crop_y1 = center_y - half_height
            crop_x2 = center_x + half_width
            crop_y2 = center_y + half_height

            if Box_grow_pixels > 0:
                expanded_width = half_width * 2 + Box_grow_pixels * 2
                expanded_height = half_height * 2 + Box_grow_pixels * 2
                crop_width = math.ceil(max(expanded_width, expanded_height * width_ratio / height_ratio))
                crop_height = math.ceil(max(expanded_height, expanded_width * height_ratio / width_ratio))
                crop_x1 = math.floor((x1 + x2 - crop_width) / 2)
                crop_y1 = math.floor((y1 + y2 - crop_height) / 2)
                crop_x2 = crop_x1 + crop_width
                crop_y2 = crop_y1 + crop_height

        return (crop_x1, crop_y1, crop_x2, crop_y2), best_aspect_ratio

    _CV2_INTERP = {
        "lanczos": cv2.INTER_LANCZOS4,
        "nearest-exact": cv2.INTER_NEAREST,
        "bilinear": cv2.INTER_LINEAR,
        "bicubic": cv2.INTER_CUBIC,
    }

    def _process_single_image(self, img, mask, resize_mode, kilopixels, divisible_by, original_width, original_height, crop_coords, fill_color=(255, 255, 255), Box_grow_pixels=0):
        # img: (H,W,3) uint8，mask: (H,W) uint8 —— 用 numpy/vc2( C 实现) 替代 PIL，大幅提速
        crop_x1, crop_y1, crop_x2, crop_y2 = crop_coords

        pad_left = max(0, -crop_x1)
        pad_top = max(0, -crop_y1)
        pad_right = max(0, crop_x2 - img.shape[1])
        pad_bottom = max(0, crop_y2 - img.shape[0])

        padded_w = img.shape[1]
        padded_h = img.shape[0]
        if pad_left > 0 or pad_top > 0 or pad_right > 0 or pad_bottom > 0:
            padded_w = padded_w + pad_left + pad_right
            padded_h = padded_h + pad_top + pad_bottom
            img_p = np.full((padded_h, padded_w, 3), fill_color, dtype=np.uint8)
            mask_p = np.zeros((padded_h, padded_w), dtype=np.uint8)
            img_p[pad_top:pad_top + img.shape[0], pad_left:pad_left + img.shape[1]] = img
            mask_p[pad_top:pad_top + img.shape[0], pad_left:pad_left + img.shape[1]] = mask
            img, mask = img_p, mask_p
            crop_x1 += pad_left
            crop_y1 += pad_top
            crop_x2 += pad_left
            crop_y2 += pad_top

        crop_box = (crop_x1, crop_y1, crop_x2, crop_y2)
        cropped_image = img[crop_y1:crop_y2, crop_x1:crop_x2]
        cropped_mask = mask[crop_y1:crop_y2, crop_x1:crop_x2]

        crop_width = crop_x2 - crop_x1
        crop_height = crop_y2 - crop_y1
        actual_aspect_ratio = (crop_width, crop_height)

        target_dimensions = self._calculate_target_dimensions(kilopixels, actual_aspect_ratio, divisible_by)
        target_width, target_height = target_dimensions
        interp = self._CV2_INTERP.get(resize_mode, cv2.INTER_LANCZOS4)
        resized_image = cv2.resize(cropped_image, (target_width, target_height), interpolation=interp)
        resized_mask = cv2.resize(cropped_mask, (target_width, target_height), interpolation=interp)

        crop_info = {
            "original_coords": crop_box,
            "padded_size": (padded_w, padded_h),
            "original_image_size": (original_width, original_height),
            "pad_info": (pad_left, pad_top, pad_right, pad_bottom),
            "fill_color": fill_color
        }

        return resized_image, resized_mask, crop_info

    def crop_and_resize(self, image, resize_mode, mask=None, Box_grow_factor=1.0, kilopixels=1000.0, divisible_by=1, ratio="auto", startup_threshold=0.4, fill_color="#FFFFFF", Box_grow_pixels=0):
        original_height, original_width = image.shape[1:3]
        img8 = np.clip(image[0].cpu().numpy() * 255, 0, 255).astype(np.uint8)
        if mask is None:
            mask8 = np.zeros((original_height, original_width), dtype=np.uint8)
        else:
            single_mask = mask if mask.ndim == 2 else mask[0]
            if single_mask.ndim == 3:
                single_mask = single_mask[..., 0]
            mask8 = np.clip(single_mask.cpu().numpy() * 255, 0, 255).astype(np.uint8)
        fill_color_rgb = self._hex_to_rgb(fill_color)
        crop_coords, _ = self._compute_crop_box(
            mask8, original_width, original_height, Box_grow_factor, ratio, startup_threshold, Box_grow_pixels
        )
        resized_image, resized_mask, crop_info = self._process_single_image(
            img8, mask8, resize_mode, kilopixels, divisible_by,
            original_width, original_height, crop_coords, fill_color_rgb, Box_grow_pixels
        )
        output_image = torch.from_numpy(resized_image.astype(np.float32) / 255.0).unsqueeze(0)
        output_mask = torch.from_numpy(resized_mask.astype(np.float32) / 255.0).unsqueeze(0)
        return (output_image, crop_info, output_mask)


NODE_CLASS_MAPPINGS = {
    "XiaozhuguangImageCrop": XiaozhuguangImageCrop,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XiaozhuguangImageCrop": "小珠光图像裁剪",
}

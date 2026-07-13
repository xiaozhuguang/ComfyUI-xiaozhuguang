
import math
import torch
import numpy as np
from PIL import Image, ImageOps
import cv2
import re


class XiaozhuguangATBC:
    CATEGORY = "小珠光"
    DESCRIPTION = "根据mask裁剪图像区域并调整大小"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "mask": ("MASK",),
                "resize_mode": (["NaN", "lanczos", "nearest-exact", "bilinear", "bicubic"], {"default": "lanczos"}),
            },
            "optional": {
                "Box_grow_factor": ("FLOAT", {"default": 1.0, "min": 1.0, "max": 5.0, "step": 0.05, "tooltip": "裁剪区域的扩展倍数，1.0表示不扩展，大于1.0表示按比例扩大"}),
                "megapixels": ("FLOAT", {"default": 1.0, "min": 0.1, "max": 10.0, "step": 0.1, "tooltip": "目标图像的百万像素数，以1024*1024为1百万像素基准"}),
                "divisible_by": ("INT", {"default": 8, "min": 1, "max": 1024, "step": 1, "tooltip": "目标分辨率必须被此数字整除"}),
                "ratio": (["auto", "1:1", "4:3", "3:4", "16:9", "9:16"], {"default": "auto", "tooltip": "裁剪比例模式，auto为自动检测最接近比例"}),
                "startup_threshold": ("FLOAT", {"default": 0.4, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": "当mask的box面积与输入图像的面积占比达到此阈值时，跳过ratio和box_grow_factor判断"}),
                "fill_color": ("STRING", {"default": "#FFFFFF", "tooltip": "边界超出时的填充颜色，支持hex格式(#FFFFFF/#FFF)或颜色名称(red/blue/green等)"}),
                "temporal_smoothing": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 0.98, "step": 0.05, "tooltip": "时间平滑系数，0为不开启，越大越平滑（0-0.98）。对视频帧的裁剪框进行指数移动平均，减少抖动"}),
            }
        }

    RETURN_TYPES = ("IMAGE", "CROPBOX", "MASK")
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

    def _calculate_target_dimensions(self, megapixels, aspect_ratio, divisible_by=1):
        total_pixels = megapixels * 1024 * 1024
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

    def _clamp_bbox(self, bbox, width, height):
        x0, y0, x1, y1 = bbox
        width = max(1, int(width))
        height = max(1, int(height))
        x0 = max(0, min(width - 1, int(x0)))
        y0 = max(0, min(height - 1, int(y0)))
        x1 = max(x0 + 1, min(width, int(x1)))
        y1 = max(y0 + 1, min(height, int(y1)))
        return (x0, y0, x1, y1)

    def _smooth_bboxes(self, bboxes, width, height, smoothing):
        if not bboxes:
            return []
        alpha = max(0.0, min(0.98, float(smoothing)))
        if alpha <= 0.0:
            return bboxes
        centers = []
        for bbox in bboxes:
            x0, y0, x1, y1 = bbox
            cx = (x0 + x1) / 2.0
            cy = (y0 + y1) / 2.0
            centers.append((cx, cy))
        prev_cx, prev_cy = centers[0]
        smoothed_centers = []
        for cx, cy in centers:
            prev_cx = prev_cx * alpha + cx * (1.0 - alpha)
            prev_cy = prev_cy * alpha + cy * (1.0 - alpha)
            smoothed_centers.append((prev_cx, prev_cy))
        req_half_w = 0
        req_half_h = 0
        for i, bbox in enumerate(bboxes):
            x0, y0, x1, y1 = bbox
            scx, scy = smoothed_centers[i]
            left_dist = scx - x0
            right_dist = x1 - scx
            top_dist = scy - y0
            bottom_dist = y1 - scy
            hw = max(left_dist, right_dist)
            hh = max(top_dist, bottom_dist)
            if hw > req_half_w:
                req_half_w = hw
            if hh > req_half_h:
                req_half_h = hh
        req_half_w = min(req_half_w, width / 2.0)
        req_half_h = min(req_half_h, height / 2.0)
        final_w = int(math.ceil(req_half_w * 2))
        final_h = int(math.ceil(req_half_h * 2))
        half_w = final_w / 2.0
        half_h = final_h / 2.0
        min_cx = half_w
        max_cx = width - half_w
        min_cy = half_h
        max_cy = height - half_h
        smoothed = []
        for cx, cy in smoothed_centers:
            cx = max(min_cx, min(max_cx, cx))
            cy = max(min_cy, min(max_cy, cy))
            x0 = int(round(cx - half_w))
            y0 = int(round(cy - half_h))
            x1 = x0 + final_w
            y1 = y0 + final_h
            smoothed.append((x0, y0, x1, y1))
        return smoothed

    def _compute_crop_box(self, pil_image, pil_mask, Box_grow_factor, ratio, startup_threshold):
        pil_mask = pil_mask.convert('L')
        bbox = pil_mask.getbbox()
        if bbox is None:
            bbox = (0, 0, pil_image.width, pil_image.height)

        x1, y1, x2, y2 = bbox
        bbox_width = x2 - x1
        bbox_height = y2 - y1

        image_area = pil_image.width * pil_image.height
        bbox_area = bbox_width * bbox_height
        area_ratio = bbox_area / image_area

        skip_ratio_and_grow = area_ratio >= startup_threshold

        if skip_ratio_and_grow:
            crop_x1, crop_y1, crop_x2, crop_y2 = 0, 0, pil_image.width, pil_image.height
            best_aspect_ratio = (pil_image.width, pil_image.height)
        else:
            if ratio != "auto":
                width_ratio, height_ratio = map(int, ratio.split(":"))
                best_aspect_ratio = (width_ratio, height_ratio)
            else:
                best_aspect_ratio = self._find_best_aspect_ratio(bbox_width, bbox_height)
            width_ratio, height_ratio = best_aspect_ratio

            if width_ratio >= height_ratio:
                base_size = max(bbox_width, math.ceil(bbox_height * width_ratio / height_ratio))
            else:
                base_size = max(bbox_height, math.ceil(bbox_width * height_ratio / width_ratio))

            target_size = int(math.ceil(base_size * Box_grow_factor))

            center_x = (x1 + x2) // 2
            center_y = (y1 + y2) // 2

            if width_ratio >= height_ratio:
                half_width = target_size // 2
                half_height = int(half_width * height_ratio / width_ratio)
            else:
                half_height = target_size // 2
                half_width = int(half_height * width_ratio / height_ratio)

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

        return (crop_x1, crop_y1, crop_x2, crop_y2), best_aspect_ratio

    def _process_single_image(self, pil_image, pil_mask, resize_mode, megapixels, divisible_by, original_width, original_height, crop_coords, fill_color=(255, 255, 255)):
        crop_x1, crop_y1, crop_x2, crop_y2 = crop_coords

        pad_left = max(0, -crop_x1)
        pad_top = max(0, -crop_y1)
        pad_right = max(0, crop_x2 - pil_image.width)
        pad_bottom = max(0, crop_y2 - pil_image.height)

        if pad_left > 0 or pad_top > 0 or pad_right > 0 or pad_bottom > 0:
            pil_image = ImageOps.expand(pil_image, (pad_left, pad_top, pad_right, pad_bottom), fill=fill_color)
            pil_mask = ImageOps.expand(pil_mask, (pad_left, pad_top, pad_right, pad_bottom), fill=0)
            crop_x1 += pad_left
            crop_y1 += pad_top
            crop_x2 += pad_left
            crop_y2 += pad_top

        crop_box = (crop_x1, crop_y1, crop_x2, crop_y2)
        cropped_image = pil_image.crop(crop_box)
        cropped_mask = pil_mask.crop(crop_box)

        crop_width = crop_x2 - crop_x1
        crop_height = crop_y2 - crop_y1
        actual_aspect_ratio = (crop_width, crop_height)

        if resize_mode == "NaN":
            resized_image = cropped_image
            resized_mask = cropped_mask
            if divisible_by > 1:
                width, height = cropped_image.size
                new_width = ((width + divisible_by - 1) // divisible_by) * divisible_by
                new_height = ((height + divisible_by - 1) // divisible_by) * divisible_by
                if new_width != width or new_height != height:
                    resized_image = cropped_image.resize((new_width, new_height), Image.LANCZOS)
                    resized_mask = cropped_mask.resize((new_width, new_height), Image.LANCZOS)
        else:
            target_dimensions = self._calculate_target_dimensions(megapixels, actual_aspect_ratio, divisible_by)
            resample_filter = {
                "lanczos": Image.LANCZOS,
                "nearest-exact": Image.NEAREST,
                "bilinear": Image.BILINEAR,
                "bicubic": Image.BICUBIC
            }.get(resize_mode, Image.LANCZOS)
            resized_image = cropped_image.resize(target_dimensions, resample_filter)
            resized_mask = cropped_mask.resize(target_dimensions, resample_filter)

        crop_info = {
            "original_coords": crop_box,
            "padded_size": (pil_image.width, pil_image.height),
            "original_image_size": (original_width, original_height),
            "pad_info": (pad_left, pad_top, pad_right, pad_bottom),
            "fill_color": fill_color
        }

        return resized_image, resized_mask, crop_info

    def crop_and_resize(self, image, mask, resize_mode, Box_grow_factor=1.0, megapixels=1.0, divisible_by=1, ratio="auto", startup_threshold=0.4, fill_color="#FFFFFF", temporal_smoothing=0.0):
        image_batch_size = image.shape[0]
        mask_batch_size = mask.shape[0] if len(mask.shape) == 3 else 1
        batch_size = max(image_batch_size, mask_batch_size)

        original_width = image.shape[2]
        original_height = image.shape[1]

        fill_color_rgb = self._hex_to_rgb(fill_color)

        pil_images = []
        pil_masks = []

        for i in range(batch_size):
            single_image = image[i] if i < image_batch_size else image[0]
            if len(mask.shape) == 3:
                single_mask = mask[i] if i < mask_batch_size else mask[0]
            else:
                single_mask = mask

            img_np = np.clip(single_image.cpu().numpy() * 255, 0, 255).astype(np.uint8)
            pil_image = Image.fromarray(img_np)

            mask_np = np.clip(single_mask.cpu().numpy() * 255, 0, 255).astype(np.uint8)
            if len(mask_np.shape) > 2:
                mask_np = mask_np[:, :, 0]
            pil_mask = Image.fromarray(mask_np, mode='L')

            pil_images.append(pil_image)
            pil_masks.append(pil_mask)

        crop_boxes = []
        for i in range(batch_size):
            crop_coords, _ = self._compute_crop_box(
                pil_images[i], pil_masks[i], Box_grow_factor, ratio, startup_threshold
            )
            crop_boxes.append(crop_coords)

        if temporal_smoothing > 0 and batch_size > 1:
            crop_boxes = self._smooth_bboxes(crop_boxes, original_width, original_height, temporal_smoothing)

        output_images = []
        output_masks = []
        crop_infos = []

        for i in range(batch_size):
            resized_image, resized_mask, crop_info = self._process_single_image(
                pil_images[i], pil_masks[i], resize_mode,
                megapixels, divisible_by,
                original_width, original_height,
                crop_boxes[i],
                fill_color_rgb
            )

            img_tensor = np.array(resized_image).astype(np.float32) / 255.0
            mask_tensor = np.array(resized_mask).astype(np.float32) / 255.0

            output_images.append(img_tensor)
            output_masks.append(mask_tensor)
            crop_infos.append(crop_info)

        output_image = torch.from_numpy(np.stack(output_images, axis=0))
        output_mask = torch.from_numpy(np.stack(output_masks, axis=0))

        crop_info_batch = {
            "batch_size": batch_size,
            "crop_infos": crop_infos
        }

        return (output_image, crop_info_batch, output_mask)


NODE_CLASS_MAPPINGS = {
    "XiaozhuguangATBC": XiaozhuguangATBC,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XiaozhuguangATBC": "ATBC",
}

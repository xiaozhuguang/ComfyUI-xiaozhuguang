
import math
from concurrent.futures import ThreadPoolExecutor
import torch
import numpy as np
import cv2
from PIL import Image
import re


DEFAULT_POSITION_SMOOTHING = 3.5
DEFAULT_SCALE_SMOOTHING = 8.5


class XiaozhuguangATBC:
    CATEGORY = "小珠光/其他"
    DEPRECATED = True
    DESCRIPTION = "根据mask裁剪图像区域并调整大小"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
            },
            "optional": {
                "mask": ("MASK", {"tooltip": "输入遮罩，保留灰度。单张复用于整批，其他数量须与图片数一致。未连接时走整图缩放及补边，保留ATR回贴信息。"}),
                "Box_grow_factor": ("FLOAT", {"default": 1.0, "min": 1.0, "max": 5.0, "step": 0.05, "tooltip": "裁剪区域的扩展倍数，1.0表示不扩展，大于1.0表示按比例扩大"}),
                "kilopixels": ("FLOAT", {"default": 1000.0, "min": 100.0, "max": 10000.0, "step": 10.0, "tooltip": "目标图像的千像素数（十进制，1千像素=1000像素）。1000千像素=1000*1000像素，4194千像素≈2048*2048像素"}),
                "divisible_by": ("INT", {"default": 32, "min": 1, "max": 1024, "step": 1, "tooltip": "目标分辨率必须被此数字整除"}),
                "ratio": (["auto", "1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16"], {"default": "auto", "tooltip": "auto以整批裁剪框宽、高的中位数和目标千像素统一估算输出尺寸，在宽高上下相邻的32倍数候选中优先选择总像素最接近目标的尺寸，各帧扩充裁剪框完整覆盖遮罩，整批输出尺寸相同。整除数与32共同对齐。"}),
                "enable_crop": ("BOOLEAN", {"default": True, "tooltip": "开启：按遮罩、比例和扩展裁剪。关闭：保留整图，按原图比例执行目标千像素缩放和整除对齐，忽略裁剪比例、扩展、平滑和遮罩求和。"}),
                "fill_color": ("STRING", {"default": "#FFFFFF", "tooltip": "边界超出时的填充颜色，支持hex格式(#FFFFFF/#FFF)或颜色名称(red/blue/green等)"}),
                "sum_mask": ("BOOLEAN", {"default": False, "tooltip": "合并当前批次的全部遮罩，锁定原画面上的裁剪位置和大小。各帧输出各自的遮罩。"}),
                "margin_percent": ("FLOAT", {"default": 10.0, "min": 0.0, "max": 100.0, "step": 1.0, "tooltip": "按遮罩外接框短边计算四边相同的像素边距，0关闭。自动比例以加边后的框确定宽高比，固定比例可能在某个方向额外留边。"}),
                "position_smoothing_frames": ("INT", {"default": 21, "min": 1, "max": 240, "step": 1, "tooltip": "位置平滑的帧数，1关闭。数值越大，裁剪中心移动越平缓。"}),
                "scale_smoothing_frames": ("INT", {"default": 51, "min": 1, "max": 240, "step": 1, "tooltip": "缩放平滑的帧数，1关闭。数值越大，裁剪框大小变化越平缓。"}),
            }
        }

    RETURN_TYPES = ("IMAGE", "CROPBOX", "MASK")
    RETURN_NAMES = ("cropped_image", "crop_box", "cropped_mask")
    FUNCTION = "crop_and_resize"

    def _auto_aspect_ratio(self, width, height):
        # Normalize to height=1 so tracking size rounding stays at pixel scale,
        # even for arbitrary dimensions or half-pixel batch medians.
        return (float(width) / float(height), 1.0)

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

    def _calculate_auto_dimensions(self, kilopixels, aspect_ratio, divisible_by=32):
        """Choose the closest pixel budget among grid neighbors of the mask shape."""
        total = kilopixels * 1000
        aspect = aspect_ratio[0] / aspect_ratio[1]
        multiple = math.lcm(32, max(1, int(divisible_by)))
        ideal_w = math.sqrt(total * aspect)
        ideal_h = math.sqrt(total / aspect)
        widths = {max(multiple, int(fn(ideal_w / multiple)) * multiple)
                  for fn in (math.floor, math.ceil)}
        heights = {max(multiple, int(fn(ideal_h / multiple)) * multiple)
                   for fn in (math.floor, math.ceil)}
        return min(((w, h) for w in widths for h in heights),
                   key=lambda size: (abs(size[0] * size[1] - total),
                                     abs(math.log((size[0] / size[1]) / aspect)), size))

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

    def _clamp_bbox(self, bbox, width, height):
        x0, y0, x1, y1 = bbox
        width = max(1, int(width))
        height = max(1, int(height))
        x0 = max(0, min(width - 1, int(x0)))
        y0 = max(0, min(height - 1, int(y0)))
        x1 = max(x0 + 1, min(width, int(x1)))
        y1 = max(y0 + 1, min(height, int(y1)))
        return (x0, y0, x1, y1)

    def _compute_crop_box(self, mask_np, width, height, Box_grow_factor, ratio, startup_threshold=None, Box_grow_pixels=0, enable_crop=True, min_margin=0):
        """根据 mask（numpy 灰度图 (H,W)）计算裁剪框，返回 (crop_x1,crop_y1,crop_x2,crop_y2), best_aspect_ratio"""
        # Resize/smoothing filters can leave tiny non-zero values across the
        # whole frame. Ignore those tails when finding the mask bounding box.
        coords = np.argwhere(mask_np > 1)
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

        # startup_threshold is accepted only for legacy callers; cropping is explicit.
        if not enable_crop:
            crop_x1, crop_y1, crop_x2, crop_y2 = 0, 0, width, height
            best_aspect_ratio = (width, height)
        else:
            if ratio != "auto":
                width_ratio, height_ratio = map(float, ratio.split(":"))
                best_aspect_ratio = (width_ratio, height_ratio)
            else:
                margin = min_margin if coords.shape[0] else 0
                best_aspect_ratio = self._auto_aspect_ratio(
                    bbox_width + 2 * margin, bbox_height + 2 * margin)
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

        if (enable_crop and min_margin > 0 and coords.shape[0] > 0
                and min(x1 - crop_x1, y1 - crop_y1, crop_x2 - x2, crop_y2 - y2) < min_margin):
            # Preserve all existing expansion; only grow when a side lacks context.
            cx, cy = (crop_x1 + crop_x2) / 2, (crop_y1 + crop_y2) / 2
            ar_w, ar_h = best_aspect_ratio
            half_w = max(cx - crop_x1, cx - (x1 - min_margin), x2 + min_margin - cx)
            half_h = max(cy - crop_y1, cy - (y1 - min_margin), y2 + min_margin - cy)
            units = math.ceil(max(2 * half_w / ar_w, 2 * half_h / ar_h))
            w, h = math.ceil(units * ar_w), math.ceil(units * ar_h)
            crop_x1, crop_y1 = math.floor(cx - w / 2), math.floor(cy - h / 2)
            crop_x2, crop_y2 = crop_x1 + w, crop_y1 + h

        return (crop_x1, crop_y1, crop_x2, crop_y2), best_aspect_ratio

    @staticmethod
    def _resize_numpy(image, width, height, resize_mode="Pillow Lanczos"):
        legacy_modes = {"lanczos": cv2.INTER_LANCZOS4, "nearest-exact": cv2.INTER_NEAREST,
                        "bilinear": cv2.INTER_LINEAR, "bicubic": cv2.INTER_CUBIC}
        if resize_mode in legacy_modes:
            return cv2.resize(image, (width, height), interpolation=legacy_modes[resize_mode])
        if resize_mode == "Lanczos4 (legacy)":
            return cv2.resize(image, (width, height), interpolation=cv2.INTER_LANCZOS4)
        if resize_mode == "OpenCV Area":
            # Only reduce axes here; a mixed shrink/enlarge uses Lanczos4 afterward.
            reduced = cv2.resize(image, (min(width, image.shape[1]), min(height, image.shape[0])), interpolation=cv2.INTER_AREA)
            if reduced.shape[:2] != (height, width):
                reduced = cv2.resize(reduced, (width, height), interpolation=cv2.INTER_LANCZOS4)
            return reduced
        filters = {"Pillow Lanczos": Image.Resampling.LANCZOS,
                   "Pillow Lanczos (fast)": Image.Resampling.LANCZOS,
                   "Pillow Bicubic": Image.Resampling.BICUBIC,
                   "Pillow Bilinear": Image.Resampling.BILINEAR}
        return np.asarray(Image.fromarray(image).resize(
            (width, height), filters[resize_mode],
            reducing_gap=3.0 if resize_mode == "Pillow Lanczos (fast)" else None))

    @staticmethod
    def _subject_box(mask):
        ys, xs = np.where(mask > 1)
        if not len(xs):
            return None
        return (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)

    def _unexpanded_seam_box(self, mask, width, height, ratio):
        box, _ = self._compute_crop_box(mask, width, height, 1.0, ratio, Box_grow_pixels=0)
        return self._clamp_bbox(box, width, height)

    def _process_single_image(self, img, mask, resize_mode, kilopixels, divisible_by, original_width, original_height, crop_coords, fill_color=(255, 255, 255), Box_grow_pixels=0):
        cropped_image, cropped_mask, crop_info, target_width, target_height = self._crop_single_image(
            img, mask, kilopixels, divisible_by, original_width, original_height, crop_coords, fill_color
        )
        resize = lambda data, w, h: self._resize_numpy(data, w, h, resize_mode)
        resized_image = self._resize_valid_crop(cropped_image, target_width, target_height, crop_info, fill_color, resize)
        resized_mask = self._resize_valid_crop(cropped_mask, target_width, target_height, crop_info, 0, resize)
        return resized_image, resized_mask, crop_info

    @staticmethod
    def _resize_valid_crop(image, width, height, info, fill, resize):
        """Resample real pixels separately from source padding; record its inverse."""
        x0, y0, x1, y1 = info["original_coords"]
        left, top, _, _ = info["pad_info"]
        ow, oh = info["original_image_size"]
        sw, sh = x1 - x0, y1 - y0
        valid = (max(0, left - x0), max(0, top - y0),
                 min(sw, left + ow - x0), min(sh, top + oh - y0))
        vx0, vy0, vx1, vy1 = valid
        if vx1 <= vx0 or vy1 <= vy0 or valid == (0, 0, sw, sh):
            return resize(image, width, height)
        dx0 = max(0, min(width - 1, round(vx0 * width / sw)))
        dy0 = max(0, min(height - 1, round(vy0 * height / sh)))
        dx1 = max(dx0 + 1, min(width, round(vx1 * width / sw)))
        dy1 = max(dy0 + 1, min(height, round(vy1 * height / sh)))
        result = np.empty((height, width) + image.shape[2:], dtype=image.dtype)
        result[...] = fill
        result[dy0:dy1, dx0:dx1] = resize(image[vy0:vy1, vx0:vx1], dx1-dx0, dy1-dy0)
        info["source_valid_box"] = valid
        info["output_valid_box"] = (dx0, dy0, dx1, dy1)
        info["output_size"] = (width, height)
        return result

    def _crop_single_image(self, img, mask, kilopixels, divisible_by, original_width, original_height, crop_coords, fill_color, align_crop=True, auto_ratio=False, target_dimensions=None, required_subject=None, fitted_box=None):
        # img: (H,W,3) uint8; mask: (H,W) uint8.
        crop_x1, crop_y1, crop_x2, crop_y2 = crop_coords
        crop_width, crop_height = crop_x2 - crop_x1, crop_y2 - crop_y1
        dimensions = self._calculate_auto_dimensions if auto_ratio else self._calculate_target_dimensions
        target_width, target_height = target_dimensions or dimensions(
            kilopixels, (crop_width, crop_height), divisible_by)
        if align_crop:
            box = fitted_box if fitted_box is not None else self._fit_crop_to_output(
                crop_coords, original_width, original_height, target_width / target_height, required_subject)
            if any(edge != int(edge) for edge in box):
                cropped, cropped_mask = self._sample_subpixel_crop(
                    img, mask, box, target_width, target_height, fill_color)
                x0, y0, x1, y1 = math.floor(box[0]), math.floor(box[1]), math.ceil(box[2]), math.ceil(box[3])
                left, top = max(0, -x0), max(0, -y0)
                right, bottom = max(0, x1-original_width), max(0, y1-original_height)
                info = {
                    "original_coords": (x0+left, y0+top, x1+left, y1+top),
                    "original_image_size": (original_width, original_height),
                    "padded_size": (original_width+left+right, original_height+top+bottom),
                    "pad_info": (left, top, right, bottom), "fill_color": fill_color,
                    "output_size": (target_width, target_height),
                    "output_content_box": (0, 0, target_width, target_height),
                    "subpixel_box": box,
                }
                return cropped, cropped_mask, info, target_width, target_height
            crop_x1, crop_y1, crop_x2, crop_y2 = map(int, box)

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

        crop_info = {
            "original_coords": crop_box,
            "padded_size": (padded_w, padded_h),
            "original_image_size": (original_width, original_height),
            "output_size": (target_width, target_height),
            "output_content_box": (0, 0, target_width, target_height),
            "pad_info": (pad_left, pad_top, pad_right, pad_bottom),
            "fill_color": fill_color
        }

        return cropped_image, cropped_mask, crop_info, target_width, target_height

    @staticmethod
    def _plan_centers(low, high, target):
        """Whole-clip minimum-travel path inside strict per-frame corridors."""
        from scipy.optimize import linprog
        from scipy.sparse import coo_matrix
        n = len(low)
        if n == 1:
            return np.clip(target, low, high)
        # Variables: centers, absolute inter-frame movements, absolute center offsets.
        rows, cols, data, rhs = [], [], [], []
        def constraint(terms, limit):
            row = len(rhs)
            for col, value in terms:
                rows.append(row); cols.append(col); data.append(value)
            rhs.append(limit)
        for i in range(n - 1):
            constraint([(i + 1, 1), (i, -1), (n + i, -1)], 0)
            constraint([(i + 1, -1), (i, 1), (n + i, -1)], 0)
        offset = 2 * n - 1
        for i in range(n):
            constraint([(i, 1), (offset + i, -1)], target[i])
            constraint([(i, -1), (offset + i, -1)], -target[i])
        cost = np.r_[np.zeros(n), np.ones(n - 1), np.full(n, 0.001)]
        bounds = list(zip(low, high)) + [(0, None)] * (2 * n - 1)
        result = linprog(cost, A_ub=coo_matrix((data, (rows, cols)), shape=(len(rhs), len(cost))).tocsr(),
                         b_ub=rhs, bounds=bounds, method="highs")
        if not result.success:
            raise RuntimeError(f"ATBC视频轨迹规划失败：{result.message}")
        return result.x[:n]

    @staticmethod
    def _face_tracking_boxes(raw, valid, n, ar, factor, margin_percent, min_margin,
                             position_smoothing, scale_smoothing):
        from scipy.ndimage import gaussian_filter1d, median_filter

        frames = np.arange(n)
        centers = (raw[:, :2] + raw[:, 2:]) / 2
        heights = raw[:, 3] - raw[:, 1]
        def smooth(samples, sigma):
            trajectory = np.interp(frames, valid, samples)
            if sigma == 0:
                return trajectory
            trajectory = median_filter(trajectory, size=3, mode="nearest")
            return gaussian_filter1d(trajectory, sigma=sigma, mode="nearest")

        center_path = np.column_stack([smooth(axis, position_smoothing) for axis in centers.T])
        desired_height = np.exp(smooth(np.log(heights), scale_smoothing)) * factor

        # Use the smoothed geometry for context too. Constraining it to every
        # raw detection would reintroduce jitter when the crop is tight.
        widths = raw[:, 2] - raw[:, 0]
        face_width = np.exp(smooth(np.log(widths), scale_smoothing))
        face_height = desired_height / factor
        margin = min_margin if margin_percent is None else (
            np.minimum(face_width, face_height) * margin_percent / 100)
        ratio = ar[0] / ar[1]
        crop_height = np.maximum.reduce([
            desired_height, face_height + 2 * margin, (face_width + 2 * margin) / ratio
        ])
        sizes = np.column_stack([crop_height * ratio, crop_height])
        starts = center_path - sizes / 2
        return [tuple(box) for box in np.column_stack([starts, starts + sizes])]

    def _tracking_boxes(self, masks, width, height, factor, pixels, ratio, preference, scaling, min_margin=0, face_composition=False, margin_percent=None,
                        face_position_smoothing=DEFAULT_POSITION_SMOOTHING,
                        face_scale_smoothing=DEFAULT_SCALE_SMOOTHING):
        from scipy.ndimage import gaussian_filter1d, maximum_filter1d
        n = len(masks)
        valid = [i for i, frame in enumerate(masks) if np.any(frame > 1 / 255)]
        if not valid:
            return [(0, 0, width, height)] * n
        raw = []
        for i in valid:
            ys, xs = np.where(masks[i] > 1 / 255)
            raw.append((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))
        raw = np.asarray(raw, dtype=float)
        if ratio == "auto":
            widths, heights = (raw[:, 2:] - raw[:, :2]).T
            margins = (min_margin if margin_percent is None else
                       np.minimum(widths, heights) * margin_percent / 100)
            ar = self._auto_aspect_ratio(np.median(widths + 2 * margins),
                                         np.median(heights + 2 * margins))
            ratio = f"{ar[0]}:{ar[1]}"
        else:
            ar = tuple(map(int, ratio.split(":")))
        if face_composition:
            return self._face_tracking_boxes(raw, valid, n, ar, factor, margin_percent, min_margin,
                                             face_position_smoothing, face_scale_smoothing)
        required = []
        for i in valid:
            box, _ = self._compute_crop_box(masks[i] * 255, width, height, factor, ratio, None, pixels, min_margin=min_margin)
            required.append(box)
        # Missing detections interpolate between valid frames; ends hold nearest detection.
        required = np.asarray(required, dtype=float)
        extents = np.stack([np.interp(np.arange(n), valid, required[:, axis]) for axis in range(4)], axis=1)
        extents[:, :2] = np.floor(extents[:, :2])
        extents[:, 2:] = np.ceil(extents[:, 2:])
        units = np.maximum((extents[:, 2] - extents[:, 0]) / ar[0],
                           (extents[:, 3] - extents[:, 1]) / ar[1])
        stable = preference == "稳定优先"
        if scaling == "固定大小":
            units[:] = units.max() * (1.15 if stable else 1.0)
        else:
            if face_scale_smoothing > 0:
                # Spread a required enlargement to both sides of the frame that needs it.
                radius = math.ceil(2 * face_scale_smoothing)
                envelope = maximum_filter1d(units, size=2 * radius + 1, mode="nearest")
                smoothed = gaussian_filter1d(envelope, sigma=face_scale_smoothing, mode="nearest")
                units = np.maximum(units, smoothed)
            if stable:
                units *= 1.15
        aspect_units = np.asarray(ar)
        half_sizes = units[:, None] * aspect_units / 2
        low = extents[:, 2:] - half_sizes
        high = np.maximum(low, extents[:, :2] + half_sizes)
        target = (extents[:, :2] + extents[:, 2:]) / 2
        centers = np.column_stack([
            self._plan_centers(low[:, axis], high[:, axis], target[:, axis])
            for axis in range(2)
        ])
        if face_position_smoothing > 0:
            centers = gaussian_filter1d(centers, sigma=face_position_smoothing, axis=0, mode="nearest")
            # A tight crop has no room to follow the smoothed path. Reserve a
            # little context before projecting the path back onto coverage limits.
            needed = 2 * np.max(np.maximum(centers - extents[:, :2],
                                           extents[:, 2:] - centers) / aspect_units, axis=1)
            fit_limit = min(width / ar[0], height / ar[1])
            expanded = np.clip(needed, units, np.maximum(units, np.minimum(units * 1.25, fit_limit)))
            if scaling == "固定大小":
                units[:] = expanded.max()
            else:
                units = expanded
            half_sizes = units[:, None] * aspect_units / 2
            low = extents[:, 2:] - half_sizes
            high = np.maximum(low, extents[:, :2] + half_sizes)
        centers = np.clip(centers, low, high)
        sizes = 2 * half_sizes
        starts = centers - half_sizes
        return [tuple(box) for box in np.column_stack([starts, starts + sizes])]

    @staticmethod
    def _fit_crop_to_output(box, width, height, output_aspect, subject):
        x0, y0, x1, y1 = box
        desired_h = max(y1 - y0, (x1 - x0) / output_aspect)
        max_h = min(height, width / output_aspect)
        sx0, sy0, sx1, sy1 = subject if subject is not None else (0, 0, 0, 0)
        required_h = max(sy1 - sy0, (sx1 - sx0) / output_aspect)
        crop_h = max(required_h, min(desired_h, max_h))
        crop_w = crop_h * output_aspect

        def place(center, size, length, low, high):
            # Maximize the real image covered on each axis, then keep the subject.
            limit = length - size
            start_min, start_max = min(0.0, limit), max(0.0, limit)
            if subject is not None:
                start_min = max(start_min, high - size)
                start_max = min(start_max, low)
            return min(max(center - size / 2, start_min), start_max)

        x = place((x0 + x1) / 2, crop_w, width, sx0, sx1)
        y = place((y0 + y1) / 2, crop_h, height, sy0, sy1)
        return tuple(float(round(edge, 10)) for edge in (x, y, x + crop_w, y + crop_h))

    @staticmethod
    def _sample_subpixel_crop(image, mask, box, width, height, color):
        # Pixel centers in the output map to pixel centers in the source.
        x0, y0, x1, y1 = box
        sx, sy = (x1 - x0) / width, (y1 - y0) / height
        matrix = np.array([[sx, 0, x0 + (sx - 1) / 2],
                           [0, sy, y0 + (sy - 1) / 2]], dtype=np.float64)
        size = (width, height)
        flags = cv2.WARP_INVERSE_MAP | cv2.INTER_LINEAR
        cropped = cv2.warpAffine(image, matrix, size, flags=flags, borderMode=cv2.BORDER_REPLICATE)
        cropped_mask = cv2.warpAffine(mask, matrix, size, flags=flags, borderMode=cv2.BORDER_REPLICATE)
        xs = x0 + (np.arange(width) + 0.5) * sx
        ys = y0 + (np.arange(height) + 0.5) * sy
        inside = ((ys >= 0) & (ys < image.shape[0]))[:, None] & ((xs >= 0) & (xs < image.shape[1]))
        cropped[~inside] = color
        cropped_mask[~inside] = 0
        return cropped, cropped_mask

    def _tracked_crop_and_resize(self, image, mask, factor, pixels, ratio, preference, scaling,
                                 kilopixels, divisible_by, fill_color, alignment_mode="扩充", min_margin=30,
                                 face_composition=False, margin_percent=None,
                                 face_position_smoothing=DEFAULT_POSITION_SMOOTHING,
                                 face_scale_smoothing=DEFAULT_SCALE_SMOOTHING):
        n, height, width, channels = image.shape
        if channels not in (3, 4):
            raise ValueError("ATBC · 高级：稳定跟踪需要RGB或RGBA图像。")
        masks = mask.detach().float().cpu().numpy()
        if masks.ndim == 4 and masks.shape[-1] == 1:
            masks = masks[..., 0]
        if masks.ndim == 2:
            masks = masks[None]
        if masks.ndim != 3 or masks.shape[1:] != (height, width):
            raise ValueError("ATBC · 高级：遮罩宽高必须与图片一致。")
        if len(masks) not in (1, n):
            raise ValueError(f"ATBC · 高级：遮罩数量与图片数量不匹配（图片 {n} 张，遮罩 {len(masks)} 张）。请提供1张或与图片数量相同的遮罩。")
        if len(masks) == 1:
            masks = np.broadcast_to(masks, (n, height, width))
        if preference not in ("稳定优先", "紧凑优先") or scaling not in ("固定大小", "动态缩放"):
            raise ValueError("ATBC · 高级：未知跟踪选项。")
        boxes = self._tracking_boxes(masks, width, height, factor, pixels, ratio, preference, scaling,
                                     min_margin, face_composition, margin_percent,
                                     face_position_smoothing, face_scale_smoothing)
        seam_boxes = [self._unexpanded_seam_box(frame * 255, width, height, ratio) for frame in masks]
        # One output resolution for the whole clip; each frame has its own inverse geometry.
        first = boxes[0]
        aspect = (first[2] - first[0]) / (first[3] - first[1])
        if face_composition and ratio != "auto":
            ar_w, ar_h = map(int, ratio.split(":"))
            aspect = ar_w / ar_h
        content_h = max(1, round(math.sqrt(kilopixels * 1000 / aspect)))
        content_w = max(1, round(content_h * aspect))
        multiple = max(1, int(divisible_by))
        out_w = math.ceil(content_w / multiple) * multiple
        out_h = math.ceil(content_h / multiple) * multiple
        if ratio == "auto":
            out_w, out_h = self._calculate_auto_dimensions(kilopixels, (aspect, 1), divisible_by)
        subjects = [self._subject_box(frame * 255) for frame in masks]
        boxes = [self._fit_crop_to_output(box, width, height, out_w / out_h, subject)
                 for box, subject in zip(boxes, subjects)]
        valid_frames = [index for index, subject in enumerate(subjects) if subject is not None]
        missing_frames = [index for index, subject in enumerate(subjects) if subject is None]
        if valid_frames and missing_frames:
            # Interpolate the final crop geometry so boundary shifts and
            # padding on valid frames also carry through detection gaps.
            anchors = np.asarray([boxes[index] for index in valid_frames])
            interpolated = np.column_stack([
                np.interp(missing_frames, valid_frames, edges) for edges in anchors.T
            ])
            for index, box in zip(missing_frames, interpolated):
                boxes[index] = tuple(box)
        content_w, content_h = out_w, out_h
        left, top = 0, 0
        color = np.asarray(self._hex_to_rgb(fill_color), dtype=np.float32) / 255
        if channels == 4:
            color = np.r_[color, np.float32(1)]
        outputs, output_masks, infos = [], [], []
        for i, (x0, y0, x1, y1) in enumerate(boxes):
            try:
                import comfy.model_management as management
                management.throw_exception_if_processing_interrupted()
            except ImportError:
                pass
            source = image[i].detach().float().cpu().numpy()
            valid_info = {}
            subpixel = face_composition or any(edge != int(edge) for edge in (x0, y0, x1, y1))
            if subpixel:
                subpixel_box = (x0, y0, x1, y1)
                resized, resized_mask = self._sample_subpixel_crop(
                    source, masks[i], subpixel_box, out_w, out_h, color)
                # The integer envelope is the destination for ATR blending.
                x0, y0 = math.floor(x0), math.floor(y0)
                x1, y1 = math.ceil(x1), math.ceil(y1)
                pw, ph = x1 - x0, y1 - y0
            else:
                x0, y0, x1, y1 = map(int, (x0, y0, x1, y1))
                pw, ph = x1 - x0, y1 - y0
                crop = np.empty((ph, pw, channels), dtype=np.float32); crop[:] = color
                crop_mask = np.zeros((ph, pw), dtype=np.float32)
                sx0, sy0, sx1, sy1 = max(0, x0), max(0, y0), min(width, x1), min(height, y1)
                if sx1 > sx0 and sy1 > sy0:
                    crop[sy0-y0:sy1-y0, sx0-x0:sx1-x0] = source[sy0:sy1, sx0:sx1]
                    crop_mask[sy0-y0:sy1-y0, sx0-x0:sx1-x0] = masks[i, sy0:sy1, sx0:sx1]
                pl, pt, pr, pb = max(0, -x0), max(0, -y0), max(0, x1-width), max(0, y1-height)
                valid_info = {"original_coords": (x0+pl, y0+pt, x1+pl, y1+pt),
                              "pad_info": (pl, pt, pr, pb), "original_image_size": (width, height)}
                resized = self._resize_valid_crop(crop, content_w, content_h, valid_info, color,
                    lambda data, w, h: cv2.resize(data, (w, h), interpolation=cv2.INTER_LANCZOS4))
                resized_mask = self._resize_valid_crop(crop_mask, content_w, content_h, valid_info, 0,
                    lambda data, w, h: cv2.resize(data, (w, h), interpolation=cv2.INTER_LINEAR))
            canvas = np.empty((out_h, out_w, channels), dtype=np.float32); canvas[:] = color
            canvas_mask = np.zeros((out_h, out_w), dtype=np.float32)
            canvas[top:top+content_h, left:left+content_w] = np.clip(resized, 0, 1)
            canvas_mask[top:top+content_h, left:left+content_w] = np.clip(resized_mask, 0, 1)
            pl, pt, pr, pb = max(0, -x0), max(0, -y0), max(0, x1-width), max(0, y1-height)
            infos.append({"original_coords": (x0+pl, y0+pt, x1+pl, y1+pt),
                          "padded_size": (width+pl+pr, height+pt+pb),
                          "original_image_size": (width, height), "pad_info": (pl, pt, pr, pb),
                          "fill_color": tuple(self._hex_to_rgb(fill_color)),
                          "output_size": (out_w, out_h),
                          "output_content_box": (left, top, left+content_w, top+content_h),
                          "source_crop_size": (pw, ph), "alignment_mode": alignment_mode})
            if subpixel:
                infos[-1]["subpixel_box"] = subpixel_box
            infos[-1]["seam_box"] = seam_boxes[i]
            infos[-1]["subject_box"] = subjects[i]
            subject = infos[-1]["subject_box"]
            infos[-1]["min_margin"] = min_margin
            if face_composition and margin_percent is not None:
                infos[-1]["min_margin"] = 0 if subject is None else math.ceil(
                    min(subject[2] - subject[0], subject[3] - subject[1]) * margin_percent / 100)
            if "output_valid_box" in valid_info:
                infos[-1].update({key: valid_info[key] for key in ("source_valid_box", "output_valid_box")})
            outputs.append(torch.from_numpy(canvas)); output_masks.append(torch.from_numpy(canvas_mask))
        return torch.stack(outputs), {"batch_size": n, "crop_infos": infos}, torch.stack(output_masks)

    @staticmethod
    def _normalize_mask_input(mask):
        if mask is None:
            return None
        if mask.ndim in (2, 3):
            return mask
        if mask.ndim == 4:
            if mask.shape[-1] == 1:
                return mask[..., 0]
        raise ValueError("ATBC · 高级：遮罩输入需要 [批次, 高, 宽] 或 [高, 宽] 的 MASK 格式。")

    def crop_and_resize(self, image, resize_mode="Pillow Lanczos", mask=None, Box_grow_factor=1.0, kilopixels=1000.0, divisible_by=32, ratio="auto", startup_threshold=0.4, fill_color="#FFFFFF", mask_smooth=0.0, sum_mask=False, Box_grow_pixels=0, enable_crop=True, crop_mode="人脸构图", tracking_preference="稳定优先", tracking_scale="固定大小", alignment_mode="扩充", min_margin=None, margin_percent=10.0,
                        face_position_smoothing=DEFAULT_POSITION_SMOOTHING,
                        face_scale_smoothing=DEFAULT_SCALE_SMOOTHING,
                        position_smoothing_frames=None, scale_smoothing_frames=None):
        for frames in (position_smoothing_frames, scale_smoothing_frames):
            if frames is not None and (type(frames) is not int or not 1 <= frames <= 240):
                raise ValueError("ATBC 平滑帧数必须为 1 到 240 的整数。")
        if position_smoothing_frames is not None:
            face_position_smoothing = 0.0 if position_smoothing_frames == 1 else max(0.5, position_smoothing_frames / 6)
        if scale_smoothing_frames is not None:
            face_scale_smoothing = 0.0 if scale_smoothing_frames == 1 else max(0.5, scale_smoothing_frames / 6)
        if isinstance(margin_percent, bool) or not isinstance(margin_percent, (int,float)) or not math.isfinite(margin_percent) or not 0 <= margin_percent <= 100:
            raise ValueError("ATBC：边距比例必须为0到100的有限数值。")
        # Accept saved API prompts from before removal of the smoothing widget.
        if crop_mode == "遮罩平滑":
            crop_mode = "逐帧裁剪"
        # The retired alignment argument is accepted for saved API prompts.
        alignment_mode = "扩充"
        face_composition = crop_mode == "人脸构图"
        face_margin_percent = margin_percent if face_composition and min_margin is None else None
        if face_margin_percent is not None and enable_crop and not sum_mask and mask is not None:
            min_margin = 0
        if min_margin is None:
            normalized = self._normalize_mask_input(mask)
            short_sides = []
            if normalized is not None:
                arrays = normalized.detach().cpu().numpy()
                if arrays.ndim == 2:
                    arrays = arrays[None]
                for frame in arrays:
                    ys, xs = np.where(frame > 1/255)
                    if len(xs):
                        short_sides.append(min(int(xs.max()-xs.min()+1), int(ys.max()-ys.min()+1)))
            min_margin = math.ceil(max(short_sides, default=0) * margin_percent / 100)
        # Legacy API keyword remains accepted; pixel expansion is superseded by min_margin.
        Box_grow_pixels = 0
        # ComfyUI widgets may be replaced by arbitrary upstream values when
        # converted to inputs, so validate every ATBC control at runtime.
        enum_options = {
            "ratio": ("auto", "1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16"),
            "crop_mode": ("逐帧裁剪", "视频稳定跟踪", "人脸构图"),
            "tracking_preference": ("稳定优先", "紧凑优先"),
            "tracking_scale": ("固定大小", "动态缩放"),
        }
        for name, allowed in enum_options.items():
            value = locals()[name]
            if not isinstance(value, str) or value not in allowed:
                raise ValueError(f"ATBC · 高级：{name} 输入无效：{value!r}。可选值：{'、'.join(allowed)}。")

        numeric_ranges = {
            "Box_grow_factor": (1.0, 5.0), "kilopixels": (100.0, 10000.0),
            "divisible_by": (1, 1024),
            "min_margin": (0, 16384),
            "face_position_smoothing": (0.0, 40.0), "face_scale_smoothing": (0.0, 40.0),
        }
        for name, (minimum, maximum) in numeric_ranges.items():
            value = locals()[name]
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not minimum <= value <= maximum:
                raise ValueError(f"ATBC · 高级：{name} 必须是 {minimum} 到 {maximum} 之间的有限数值，收到 {value!r}。")
        if isinstance(min_margin, bool) or not isinstance(min_margin, int):
            raise ValueError("ATBC · 高级：min_margin 必须是整数。")
        if isinstance(divisible_by, bool) or not isinstance(divisible_by, int):
            raise ValueError(f"ATBC · 高级：divisible_by 必须是整数，收到 {divisible_by!r}。")
        for name, value in (("enable_crop", enable_crop), ("sum_mask", sum_mask)):
            if not isinstance(value, bool):
                raise ValueError(f"ATBC · 高级：{name} 必须是布尔值，收到 {value!r}。")
        if not isinstance(fill_color, str):
            raise ValueError(f"ATBC · 高级：fill_color 必须是颜色名称或十六进制字符串，收到 {fill_color!r}。")
        color_names = {"white", "black", "red", "green", "blue", "yellow", "cyan", "magenta", "orange", "pink", "purple", "gray", "grey"}
        normalized_color = fill_color.strip().lower().lstrip("#")
        if normalized_color not in color_names and not re.fullmatch(r"(?:[0-9a-f]{3}|[0-9a-f]{6})", normalized_color):
            raise ValueError(f"ATBC · 高级：无效填充颜色 {fill_color!r}，请输入支持的颜色名称或 #RGB/#RRGGBB。")
        resize_mode = "Pillow Lanczos"
        mask = self._normalize_mask_input(mask)
        enable_crop = bool(enable_crop) and mask is not None
        if enable_crop and not sum_mask and crop_mode in ("视频稳定跟踪", "人脸构图"):
            return self._tracked_crop_and_resize(image, mask, Box_grow_factor, Box_grow_pixels,
                                                 ratio, tracking_preference, tracking_scale,
                                                 kilopixels, divisible_by, fill_color, alignment_mode, min_margin,
                                                 face_composition, face_margin_percent,
                                                 face_position_smoothing, face_scale_smoothing)
        image_batch_size = image.shape[0]

        original_width = image.shape[2]
        original_height = image.shape[1]

        fill_color_rgb = self._hex_to_rgb(fill_color)

        # (B) 一次性整批转换，避免逐帧 cpu/numpy 多层拷贝
        img8 = np.clip(image.cpu().numpy() * 255, 0, 255).astype(np.uint8)  # (B,H,W,3)
        if mask is None:
            # 未连接遮罩时走整图缩放/补边路径，输出对应尺寸的全黑遮罩。
            mask8 = np.zeros((image_batch_size, original_height, original_width), dtype=np.uint8)
            mask_batch_size = image_batch_size
            mask_batched = True
        else:
            mask8 = np.clip(mask.cpu().numpy() * 255, 0, 255).astype(np.uint8)
            if mask8.ndim == 4:  # (B,H,W,1)：去掉单通道
                mask8 = mask8[..., 0]
            mask_batched = mask8.ndim == 3  # (B,H,W)；否则 (H,W) 单遮罩
            mask_batch_size = mask8.shape[0] if mask_batched else 1
        if mask is not None and mask_batch_size not in (1, image_batch_size):
            raise ValueError(
                f"ATBC · 高级：遮罩数量与图片数量不匹配（图片 {image_batch_size} 张，遮罩 {mask_batch_size} 张）。"
                "请提供 1 张遮罩供所有图片复用，或提供与图片数量相同的遮罩。"
            )
        batch_size = image_batch_size

        summed_mask = None
        if enable_crop and sum_mask and batch_size > 1:
            summed_mask = (np.clip(mask8.sum(axis=0, dtype=np.float32), 0, 255).astype(np.uint8)
                           if mask_batched else mask8)

        seam_boxes = None
        if enable_crop:
            if summed_mask is not None:
                seam_boxes = [self._unexpanded_seam_box(summed_mask, original_width, original_height, ratio)] * batch_size
            else:
                seam_boxes = [self._unexpanded_seam_box(
                    mask8[i if mask_batch_size > 1 else 0] if mask_batched else mask8,
                    original_width, original_height, ratio) for i in range(batch_size)]

        if not enable_crop:
            crop_boxes = [(0, 0, original_width, original_height)] * batch_size
        elif summed_mask is not None:
            unified_crop_coords, _ = self._compute_crop_box(
                summed_mask, original_width, original_height, Box_grow_factor, ratio, startup_threshold, Box_grow_pixels, min_margin=min_margin
            )
            crop_boxes = [unified_crop_coords] * batch_size
        else:
            crop_boxes = []
            img_w = img8.shape[2]
            img_h = img8.shape[1]
            for i in range(batch_size):
                m_i = mask8[i if i < mask_batch_size else 0] if mask_batched else mask8
                crop_coords, _ = self._compute_crop_box(m_i, img_w, img_h, Box_grow_factor, ratio, startup_threshold, Box_grow_pixels, min_margin=min_margin)
                crop_boxes.append(crop_coords)
        # Pick one resolution before processing any frame. Per-frame source
        # windows may vary, but must fit this shared output aspect and budget.
        target_dimensions = None
        if enable_crop:
            if ratio == "auto":
                batch_aspect = (np.median([box[2] - box[0] for box in crop_boxes]),
                                np.median([box[3] - box[1] for box in crop_boxes]))
                target_dimensions = self._calculate_auto_dimensions(kilopixels, batch_aspect, divisible_by)
            else:
                target_dimensions = self._calculate_target_dimensions(
                    kilopixels, tuple(map(int, ratio.split(":"))), divisible_by)

        fixed_box = None
        if summed_mask is not None:
            out_w, out_h = target_dimensions
            fixed_box = self._fit_crop_to_output(
                unified_crop_coords, original_width, original_height, out_w / out_h,
                self._subject_box(summed_mask))

        frames = []
        for i in range(batch_size):
            img_i = img8[i] if i < image_batch_size else img8[0]
            m_i = mask8[i] if mask_batched and i < mask_batch_size else mask8[0] if mask_batched else mask8
            subject = self._subject_box(m_i) if enable_crop else None
            frames.append(self._crop_single_image(
                img_i, m_i, kilopixels, divisible_by, original_width, original_height,
                crop_boxes[i], fill_color_rgb, align_crop=enable_crop,
                auto_ratio=enable_crop and ratio == "auto", target_dimensions=target_dimensions,
                required_subject=subject, fitted_box=fixed_box,
            ))
            if seam_boxes is not None:
                frames[-1][2]["seam_box"] = seam_boxes[i]
                frames[-1][2]["subject_box"] = subject

        def resize_frame(frame):
            cropped_image, cropped_mask, info, target_width, target_height = frame
            info["alignment_mode"] = alignment_mode
            info["min_margin"] = min_margin
            if not enable_crop:
                height, width = cropped_image.shape[:2]
                scale = math.sqrt(kilopixels * 1000 / (width * height))
                content_width = max(1, round(width * scale))
                content_height = max(1, round(height * scale))
                multiple = max(1, int(divisible_by))
                target_width = math.ceil(content_width / multiple) * multiple
                target_height = math.ceil(content_height / multiple) * multiple
                image = self._resize_numpy(cropped_image, content_width, content_height, resize_mode)
                mask = self._resize_numpy(cropped_mask, content_width, content_height, resize_mode)
                padded_image = np.full((target_height, target_width, image.shape[2]), fill_color_rgb, dtype=image.dtype)
                padded_mask = np.zeros((target_height, target_width), dtype=mask.dtype)
                left = (target_width - content_width) // 2
                top = (target_height - content_height) // 2
                right = left + content_width
                bottom = top + content_height
                padded_image[top:bottom, left:right] = image
                padded_mask[top:bottom, left:right] = mask
                info["output_size"] = (target_width, target_height)
                info["output_content_box"] = (left, top, right, bottom)
                return padded_image, padded_mask
            if "subpixel_box" in info:
                return cropped_image, cropped_mask
            resize = lambda data, w, h: self._resize_numpy(data, w, h, resize_mode)
            return (self._resize_valid_crop(cropped_image, target_width, target_height, info, fill_color_rgb, resize),
                    self._resize_valid_crop(cropped_mask, target_width, target_height, info, 0, resize))
        if batch_size > 1:
            with ThreadPoolExecutor(max_workers=min(8, batch_size)) as pool:
                resized_frames = list(pool.map(resize_frame, frames))
        else:
            resized_frames = [resize_frame(frames[0])]

        output_images = [images.astype(np.float32) / 255.0 for images, _ in resized_frames]
        output_masks = [masks.astype(np.float32) / 255.0 for _, masks in resized_frames]
        crop_infos = [frame[2] for frame in frames]

        if batch_size > 1:
            max_h = max(img.shape[0] for img in output_images)
            max_w = max(img.shape[1] for img in output_images)
            need_pad = any(img.shape[0] != max_h or img.shape[1] != max_w for img in output_images)
            if need_pad:
                padded_images = []
                padded_masks = []
                fill_r = fill_color_rgb[0] / 255.0
                fill_g = fill_color_rgb[1] / 255.0
                fill_b = fill_color_rgb[2] / 255.0
                fill_pixel = np.array([fill_r, fill_g, fill_b], dtype=np.float32)
                for img_arr, mask_arr in zip(output_images, output_masks):
                    h, w = img_arr.shape[:2]
                    pad_h = max_h - h
                    pad_w = max_w - w
                    if pad_h > 0 or pad_w > 0:
                        pad_right = pad_w // 2
                        pad_left = pad_w - pad_right
                        pad_bottom = pad_h // 2
                        pad_top = pad_h - pad_bottom
                        new_img = np.tile(fill_pixel, (max_h, max_w, 1))
                        new_img[pad_top:pad_top+h, pad_left:pad_left+w, :] = img_arr
                        padded_images.append(new_img)
                        new_mask = np.zeros((max_h, max_w), dtype=np.float32)
                        new_mask[pad_top:pad_top+h, pad_left:pad_left+w] = mask_arr
                        padded_masks.append(new_mask)
                    else:
                        padded_images.append(img_arr)
                        padded_masks.append(mask_arr)
                output_images = padded_images
                output_masks = padded_masks

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
    "XiaozhuguangATBC": "ATBC · 高级",
}

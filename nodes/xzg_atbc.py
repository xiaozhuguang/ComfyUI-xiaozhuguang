
import math
from concurrent.futures import ThreadPoolExecutor
import torch
import numpy as np
import cv2
from PIL import Image
import re


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
                "mask": ("MASK,IMAGE", {"tooltip": "支持MASK或IMAGE。图片按灰度亮度转换（与小珠光图像↔遮罩一致）；白1黑0，保留灰度。单张复用于整批，其他数量须与图片数一致。未连接时走整图缩放及补边，保留ATR回贴信息。"}),
                "Box_grow_factor": ("FLOAT", {"default": 1.0, "min": 1.0, "max": 5.0, "step": 0.05, "tooltip": "裁剪区域的扩展倍数，1.0表示不扩展，大于1.0表示按比例扩大"}),
                "kilopixels": ("FLOAT", {"default": 1000.0, "min": 100.0, "max": 10000.0, "step": 10.0, "tooltip": "目标图像的千像素数（十进制，1千像素=1000像素）。1000千像素=1000*1000像素，4194千像素≈2048*2048像素"}),
                "divisible_by": ("INT", {"default": 8, "min": 1, "max": 1024, "step": 1, "tooltip": "目标分辨率必须被此数字整除"}),
                "ratio": (["auto", "1:1", "4:3", "3:4", "16:9", "9:16"], {"default": "auto", "tooltip": "裁剪比例模式，auto为自动检测最接近比例"}),
                "enable_crop": ("BOOLEAN", {"default": True, "tooltip": "开启：按遮罩、比例和扩展裁剪。关闭：保留整图，按原图比例执行目标千像素缩放和整除对齐，忽略裁剪比例、扩展、平滑和遮罩求和。"}),
                "fill_color": ("STRING", {"default": "#FFFFFF", "tooltip": "边界超出时的填充颜色，支持hex格式(#FFFFFF/#FFF)或颜色名称(red/blue/green等)"}),
                "sum_mask": ("BOOLEAN", {"default": False, "tooltip": "开启后，将所有帧的遮罩求和（截断到0-1）后统一计算裁剪框，所有帧输出尺寸一致"}),
                "Box_grow_pixels": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 1, "tooltip": "在倍数扩展后，裁剪框上下左右每边增加的原图像素数，仅扩大裁剪范围，不膨胀遮罩；10表示50×50裁剪框扩为70×70，倍数为2时裁剪框为120×120。裁剪框按所选比例进一步补齐；关闭裁剪时忽略此项。遮罩随图像正常裁剪和缩放。0为不扩展"}),
                "crop_mode": (["遮罩平滑", "视频稳定跟踪"], {"default": "遮罩平滑", "tooltip": "稳定跟踪分析整段遮罩规划轨迹；关闭裁剪、未接遮罩或开启遮罩求和时不生效。"}),
                "mask_smooth": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 0.98, "step": 0.05, "tooltip": "遮罩时间平滑系数，0为不开启，越大越平滑（0-0.98）。对视频帧的裁剪框位置进行指数移动平均，减少画面抖动"}),
                "tracking_preference": (["稳定优先", "紧凑优先"], {"default": "稳定优先", "tooltip": "仅稳定跟踪生效。稳定优先使用较大范围减少移动；紧凑优先保持较小范围。均不缩减扩展参数要求的范围。"}),
                "tracking_scale": (["固定大小", "动态缩放"], {"default": "固定大小", "tooltip": "仅稳定跟踪生效。固定大小只移动；动态缩放同时规划大小，输出分辨率统一，ATR按每帧记录恢复。"}),
                "mask_binarize": ("BOOLEAN", {"default": False, "tooltip": "将输入遮罩或图片转换后的灰度遮罩二值化：大于阈值为白色1，其余为黑色0。关闭时保留灰度。"}),
                "mask_threshold": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": "仅开启遮罩二值化时生效；0表示所有非黑色变白，0.5表示大于0.5变白。等于阈值为黑色。"}),
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

    def _smooth_bboxes(self, bboxes, width, height, smoothing, aspect_ratio=None):
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
        if aspect_ratio is not None:
            ar_w, ar_h = aspect_ratio
            target_ratio = ar_w / ar_h
            current_ratio = req_half_w / req_half_h if req_half_h > 0 else 1.0
            if current_ratio > target_ratio:
                new_half_h = req_half_w / target_ratio
                new_half_w = new_half_h * target_ratio
            else:
                new_half_w = req_half_h * target_ratio
                new_half_h = new_half_w / target_ratio
            req_half_w = new_half_w
            req_half_h = new_half_h
        final_w = int(math.ceil(req_half_w * 2))
        final_h = int(math.ceil(req_half_h * 2))
        half_w = final_w / 2.0
        half_h = final_h / 2.0
        smoothed = []
        for cx, cy in smoothed_centers:
            # Keep the smoothed crop centered on the mask, even when that
            # places part of it beyond the source frame. _process_single_image
            # pads those areas with fill_color, matching the summed-mask path.
            x0 = int(round(cx - half_w))
            y0 = int(round(cy - half_h))
            x1 = x0 + final_w
            y1 = y0 + final_h
            smoothed.append((x0, y0, x1, y1))
        return smoothed

    def _compute_crop_box(self, mask_np, width, height, Box_grow_factor, ratio, startup_threshold=None, Box_grow_pixels=0, enable_crop=True):
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

    def _process_single_image(self, img, mask, resize_mode, kilopixels, divisible_by, original_width, original_height, crop_coords, fill_color=(255, 255, 255), Box_grow_pixels=0):
        cropped_image, cropped_mask, crop_info, target_width, target_height = self._crop_single_image(
            img, mask, kilopixels, divisible_by, original_width, original_height, crop_coords, fill_color
        )
        resized_image = self._resize_numpy(cropped_image, target_width, target_height, resize_mode)
        resized_mask = self._resize_numpy(cropped_mask, target_width, target_height, resize_mode)
        return resized_image, resized_mask, crop_info

    def _crop_single_image(self, img, mask, kilopixels, divisible_by, original_width, original_height, crop_coords, fill_color):
        # img: (H,W,3) uint8; mask: (H,W) uint8.
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
        crop_info = {
            "original_coords": crop_box,
            "padded_size": (padded_w, padded_h),
            "original_image_size": (original_width, original_height),
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

    def _tracking_boxes(self, masks, width, height, factor, pixels, ratio, preference, scaling):
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
            ar = self._find_best_aspect_ratio(np.median(raw[:, 2] - raw[:, 0]), np.median(raw[:, 3] - raw[:, 1]))
            ratio = f"{ar[0]}:{ar[1]}"
        else:
            ar = tuple(map(int, ratio.split(":")))
        required = []
        for i in valid:
            box, _ = self._compute_crop_box(masks[i] * 255, width, height, factor, ratio, None, pixels)
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
            # Look ahead through brief size dips, then soften transitions without losing coverage.
            envelope = maximum_filter1d(units, size=9 if stable else 3, mode="nearest")
            units = np.maximum(units, gaussian_filter1d(envelope, sigma=2 if stable else 1, mode="nearest"))
            units *= 1.15 if stable else 1.0
        units = np.ceil(units).astype(np.int64)
        widths, heights = units * ar[0], units * ar[1]
        centers = []
        for axis, sizes in ((0, widths), (1, heights)):
            low = extents[:, axis + 2] - sizes / 2
            high = extents[:, axis] + sizes / 2
            centers.append(self._plan_centers(low, high, (extents[:, axis] + extents[:, axis + 2]) / 2))
        boxes = []
        for i in range(n):
            # Integer placement is clamped to the feasible interval, never cutting requested margins.
            x = int(np.clip(round(centers[0][i] - widths[i] / 2),
                            math.ceil(extents[i, 2] - widths[i]), math.floor(extents[i, 0])))
            y = int(np.clip(round(centers[1][i] - heights[i] / 2),
                            math.ceil(extents[i, 3] - heights[i]), math.floor(extents[i, 1])))
            boxes.append((x, y, x + int(widths[i]), y + int(heights[i])))
        return boxes

    def _tracked_crop_and_resize(self, image, mask, factor, pixels, ratio, preference, scaling,
                                 kilopixels, divisible_by, fill_color):
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
        boxes = self._tracking_boxes(masks, width, height, factor, pixels, ratio, preference, scaling)
        # One output resolution for the whole clip; each frame has its own inverse geometry.
        first = boxes[0]
        aspect = (first[2] - first[0]) / (first[3] - first[1])
        content_h = max(1, round(math.sqrt(kilopixels * 1000 / aspect)))
        content_w = max(1, round(content_h * aspect))
        multiple = max(1, int(divisible_by))
        out_w = math.ceil(content_w / multiple) * multiple
        out_h = math.ceil(content_h / multiple) * multiple
        left, top = (out_w - content_w) // 2, (out_h - content_h) // 2
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
            pw, ph = x1 - x0, y1 - y0
            source = image[i].detach().float().cpu().numpy()
            crop = np.empty((ph, pw, channels), dtype=np.float32); crop[:] = color
            crop_mask = np.zeros((ph, pw), dtype=np.float32)
            sx0, sy0, sx1, sy1 = max(0, x0), max(0, y0), min(width, x1), min(height, y1)
            if sx1 > sx0 and sy1 > sy0:
                crop[sy0-y0:sy1-y0, sx0-x0:sx1-x0] = source[sy0:sy1, sx0:sx1]
                crop_mask[sy0-y0:sy1-y0, sx0-x0:sx1-x0] = masks[i, sy0:sy1, sx0:sx1]
            resized = cv2.resize(crop, (content_w, content_h), interpolation=cv2.INTER_LANCZOS4)
            resized_mask = cv2.resize(crop_mask, (content_w, content_h), interpolation=cv2.INTER_LINEAR)
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
                          "source_crop_size": (pw, ph)})
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
            if mask.shape[-1] in (3, 4):
                return (mask[..., :3] * mask.new_tensor([0.299, 0.587, 0.114])).sum(dim=-1)
        raise ValueError("ATBC · 高级：遮罩／图片输入需要MASK或RGB、RGBA、灰度IMAGE格式。")

    def crop_and_resize(self, image, resize_mode="Pillow Lanczos", mask=None, Box_grow_factor=1.0, kilopixels=1000.0, divisible_by=1, ratio="auto", startup_threshold=0.4, fill_color="#FFFFFF", mask_smooth=0.0, sum_mask=False, Box_grow_pixels=0, enable_crop=True, crop_mode="遮罩平滑", tracking_preference="稳定优先", tracking_scale="固定大小", mask_binarize=False, mask_threshold=0.5):
        resize_mode = "Pillow Lanczos"
        mask = self._normalize_mask_input(mask)
        if mask is not None and mask_binarize:
            mask = (mask > float(mask_threshold)).to(dtype=mask.dtype)
        enable_crop = bool(enable_crop) and mask is not None
        if enable_crop and not sum_mask and crop_mode == "视频稳定跟踪":
            return self._tracked_crop_and_resize(image, mask, Box_grow_factor, Box_grow_pixels,
                                                 ratio, tracking_preference, tracking_scale,
                                                 kilopixels, divisible_by, fill_color)
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

        if not enable_crop:
            crop_boxes = [(0, 0, original_width, original_height)] * batch_size
            smooth_aspect_ratio = None
        elif sum_mask and batch_size > 1:
            if mask_batched:
                sum_mask_np = np.clip(mask8[:min(mask_batch_size, batch_size)].astype(np.float32).sum(axis=0), 0, 255).astype(np.uint8)
            else:
                sum_mask_np = mask8
            unified_crop_coords, _ = self._compute_crop_box(
                sum_mask_np, img8.shape[2], img8.shape[1], Box_grow_factor, ratio, startup_threshold, Box_grow_pixels
            )
            crop_boxes = [unified_crop_coords] * batch_size
            smooth_aspect_ratio = None
        else:
            crop_boxes = []
            aspect_ratios = []
            img_w = img8.shape[2]
            img_h = img8.shape[1]
            for i in range(batch_size):
                m_i = mask8[i if i < mask_batch_size else 0] if mask_batched else mask8
                crop_coords, ar = self._compute_crop_box(m_i, img_w, img_h, Box_grow_factor, ratio, startup_threshold, Box_grow_pixels)
                crop_boxes.append(crop_coords)
                aspect_ratios.append(ar)
            if ratio != "auto":
                width_ratio, height_ratio = map(int, ratio.split(":"))
                smooth_aspect_ratio = (width_ratio, height_ratio)
            else:
                smooth_aspect_ratio = aspect_ratios[0] if aspect_ratios else None

        if enable_crop and mask_smooth > 0 and batch_size > 1 and not sum_mask:
            crop_boxes = self._smooth_bboxes(crop_boxes, original_width, original_height, mask_smooth, smooth_aspect_ratio)

        frames = []
        for i in range(batch_size):
            img_i = img8[i] if i < image_batch_size else img8[0]
            m_i = mask8[i] if mask_batched and i < mask_batch_size else mask8[0] if mask_batched else mask8
            frames.append(self._crop_single_image(
                img_i, m_i, kilopixels, divisible_by, original_width, original_height,
                crop_boxes[i], fill_color_rgb
            ))

        def resize_frame(frame):
            cropped_image, cropped_mask, info, target_width, target_height = frame
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
            return (self._resize_numpy(cropped_image, target_width, target_height, resize_mode),
                    self._resize_numpy(cropped_mask, target_width, target_height, resize_mode))
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

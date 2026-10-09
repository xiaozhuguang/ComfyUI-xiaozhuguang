import logging
import torch
import torch.nn.functional as F
import numpy as np
import cv2


class XiaozhuguangATR:
    CATEGORY = "小珠光/其他"
    DEPRECATED = True
    DESCRIPTION = "将处理后的图像粘贴回原图"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "original_image": ("IMAGE",),
                "processed_image": ("IMAGE",),
                "crop_box": ("CROPBOX",),
                "blur_amount": ("INT", {"default": 0, "min": 0, "max": 500, "step": 1, "tooltip": "接缝高斯羽化半径；只控制边缘模糊，不改变遮罩范围。未连接遮罩时作用于裁剪框边缘"}),
                "mask_expand": ("INT", {"default": 0, "min": -500, "max": 500, "step": 1, "tooltip": "独立调整遮罩范围：正值向外扩张，负值向内收缩，0=不变"}),
            },
            "optional": {
                "mask": ("MASK",),
                "compute_device": (["auto", "GPU", "CPU"], {"default": "auto", "tooltip": "auto 优先使用 GPU；CPU 使用原 OpenCV 算法。GPU 按小批次处理，缩放与羽化可能有少量像素舍入差异"}),
                "edge_color_match": ("BOOLEAN", {"default": False, "tooltip": "跟随遮罩收缩和羽化后的实际接缝，分析附近对应像素并修正色偏，中心保持原色"}),
                "color_band_width": ("INT", {"default": 16, "min": 1, "max": 256, "step": 1, "tooltip": "沿最终融合遮罩的 50% 轮廓向内分析的带宽，单位为原图像素"}),
                "color_match_strength": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.05}),
                "color_correction_range": ("INT", {"default": 128, "min": 1, "max": 512, "step": 1, "tooltip": "始终覆盖最终羽化过渡带，并从实际接缝向内逐渐减弱；此值控制向内延伸范围，单位为原图像素"}),
                "color_temporal_smooth": ("FLOAT", {"default": 0.8, "min": 0.0, "max": 0.98, "step": 0.05, "tooltip": "视频色偏参数的时间平滑；0为关闭，仅在本次批次内生效"}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("restored_image",)
    FUNCTION = "restore_image"

    def _restore_single_image(self, orig_np, proc_np, crop_info, blur_amount, mask_expand, single_mask=None, color_options=None, color_state=None):
        original_coords = crop_info["original_coords"]
        padded_size = crop_info["padded_size"]
        original_image_size = crop_info["original_image_size"]
        pad_info = crop_info["pad_info"]
        fill_color = crop_info.get("fill_color", (255, 255, 255))

        pad_left, pad_top, pad_right, pad_bottom = pad_info

        crop_width = original_coords[2] - original_coords[0]
        crop_height = original_coords[3] - original_coords[1]
        x1, y1 = original_coords[0], original_coords[1]

        resized_processed = cv2.resize(
            proc_np, (crop_width, crop_height), interpolation=cv2.INTER_LANCZOS4
        )

        ow, oh = original_image_size
        if tuple(padded_size) == (ow, oh):
            restored = orig_np.copy()
        else:
            padded_w, padded_h = padded_size
            restored = np.full(
                (padded_h, padded_w, 3),
                np.asarray(fill_color, dtype=np.uint8),
                dtype=np.uint8
            )
            restored[pad_top:pad_top + oh, pad_left:pad_left + ow] = orig_np

        padded_original = restored.copy()
        if single_mask is not None:
            restored = self._apply_mask_blend(
                restored,
                resized_processed,
                padded_original,
                original_coords,
                single_mask,
                blur_amount,
                mask_expand,
                color_options, color_state, crop_info
            )
        else:
            restored[y1:y1 + crop_height, x1:x1 + crop_width] = resized_processed
            if blur_amount > 0 or mask_expand != 0 or color_options is not None:
                restored = self._apply_bbox_edge_blur(
                    restored,
                    padded_original,
                    original_coords,
                    blur_amount,
                    mask_expand,
                    color_options, color_state, crop_info
                )

        if pad_left > 0 or pad_top > 0 or pad_right > 0 or pad_bottom > 0:
            restored = restored[pad_top:pad_top + oh, pad_left:pad_left + ow]

        return restored

    def restore_image(self, original_image, processed_image, crop_box, blur_amount, mask_expand=0, mask=None, compute_device="auto", edge_color_match=False, color_band_width=16, color_match_strength=0.5, color_correction_range=128, color_temporal_smooth=0.8):
        color_options = (color_band_width, color_match_strength, color_correction_range, color_temporal_smooth) if edge_color_match and color_match_strength > 0 else None
        if compute_device != "CPU" and torch.cuda.is_available():
            try:
                return self._restore_gpu(original_image, processed_image, crop_box, blur_amount, mask_expand, mask, color_options)
            except torch.cuda.OutOfMemoryError:
                logging.warning("ATR GPU 显存不足，回退到 CPU；可将计算设备设为 CPU。")
        batch_size = original_image.shape[0]

        if "batch_size" in crop_box:
            crop_infos = crop_box["crop_infos"]
        else:
            crop_infos = [crop_box] * batch_size

        orig8 = np.clip(original_image.cpu().numpy() * 255, 0, 255).astype(np.uint8)
        proc8 = np.clip(processed_image.cpu().numpy() * 255, 0, 255).astype(np.uint8)
        # 兼容上游 4 通道(RGBA)图像：截断为 3 通道 RGB，避免混合时广播形状不匹配
        if orig8.ndim == 4 and orig8.shape[-1] == 4:
            orig8 = orig8[..., :3]
        if proc8.ndim == 4 and proc8.shape[-1] == 4:
            proc8 = proc8[..., :3]

        mask8 = None
        mask_batched = False
        if mask is not None:
            m = np.clip(mask.cpu().numpy() * 255, 0, 255).astype(np.uint8)
            if m.ndim == 4:  # (B,H,W,1)：去掉单通道
                m = m[..., 0]
            mask_batched = m.ndim == 3  # (B,H,W)；否则 (H,W) 单遮罩
            mask8 = m

        output_images = []
        color_state = [None]
        for i in range(batch_size):
            orig_np = orig8[i] if i < orig8.shape[0] else orig8[0]
            proc_np = proc8[i] if i < proc8.shape[0] else proc8[0]
            crop_info = crop_infos[i] if i < len(crop_infos) else crop_infos[0]

            single_mask = None
            if mask8 is not None:
                single_mask = mask8[i if i < mask8.shape[0] else 0] if mask_batched else mask8

            restored = self._restore_single_image(
                orig_np, proc_np, crop_info, blur_amount, mask_expand, single_mask, color_options, color_state
            )
            output_images.append(restored.astype(np.float32) / 255.0)

        output_image = torch.from_numpy(np.stack(output_images, axis=0))
        return (output_image,)

    @staticmethod
    def _color_pad(support, radius, crop_info):
        x1, y1, x2, y2 = crop_info["original_coords"]
        left, top, _, _ = crop_info["pad_info"]
        ow, oh = crop_info["original_image_size"]
        padded = F.pad(support, (radius, radius, radius, radius), value=1)
        # 实际图像边界没有回贴接缝；只有位于原图内部的裁剪边缘补零。
        if x1 > left:
            padded[..., :radius] = 0
        if x2 < left + ow:
            padded[..., -radius:] = 0
        if y1 > top:
            padded[..., :radius, :] = 0
        if y2 < top + oh:
            padded[..., -radius:, :] = 0
        return padded

    def _match_edge_color(self, processed, original, mask, crop_info, options, state):
        band, strength, reach, smoothing = options
        height, width = processed.shape[-2:]
        alpha = torch.ones_like(processed[:, :1]) if mask is None else mask / 255
        support = (alpha >= 0.5).to(processed.dtype)
        transition = 4 * alpha * (1 - alpha)
        x1, y1, _, _ = crop_info["original_coords"]
        left, top, _, _ = crop_info["pad_info"]
        ow, oh = crop_info["original_image_size"]
        rows = torch.arange(height, device=processed.device) + y1
        cols = torch.arange(width, device=processed.device) + x1
        valid_region = ((rows >= top) & (rows < top + oh))[:, None] & ((cols >= left) & (cols < left + ow))[None, :]
        support = torch.where(valid_region, support, 1)
        padded = self._color_pad(support, band, crop_info)
        inner = -F.max_pool2d(-padded, (1, band * 2 + 1), stride=1)
        inner = -F.max_pool2d(-inner, (band * 2 + 1, 1), stride=1)
        ring = (support - inner).clamp_(0, 1) * valid_region
        usable = ((processed > 8) & (processed < 247) & (original > 8) & (original < 247)).all(dim=1, keepdim=True)
        samples = ring * (0.25 + 0.75 * transition) * usable
        count = samples.sum(dim=(-2, -1), keepdim=True)
        differences = (original - processed).clamp(-64, 64)
        offsets = ((differences * samples).sum(dim=(-2, -1), keepdim=True) / count.clamp_min(1)).clamp(-32, 32)
        smoothed = []
        previous, previous_valid = state[0] if state[0] is not None else (None, None)
        for i in range(processed.shape[0]):
            current = offsets[i:i + 1]
            enough = count[i:i + 1] >= 16
            if previous is not None:
                current = torch.where(previous_valid, previous * smoothing + current * (1 - smoothing), current)
                previous = torch.where(enough, current, previous)
                previous_valid = previous_valid | enough
            else:
                previous = torch.where(enough, current, 0)
                previous_valid = enough
            smoothed.append(torch.where(enough, previous, 0))
        state[0] = (previous, previous_valid)
        offsets = torch.cat(smoothed)
        padded = self._color_pad(support, reach, crop_info)
        average = F.avg_pool2d(padded, (1, reach * 2 + 1), stride=1)
        average = F.avg_pool2d(average, (reach * 2 + 1, 1), stride=1)
        inward_weight = (2 * (1 - average)).clamp_(0, 1) * support
        # 覆盖最终羽化过渡带的两侧，避免在 50% 融合轮廓处突然开启修正。
        weight = torch.maximum(inward_weight, transition) * (alpha > 0) * valid_region
        return (processed + offsets * weight * strength).round().clamp_(0, 255)

    def _match_edge_color_numpy(self, processed, original, final_mask, crop_info, options, state):
        processed_tensor = torch.from_numpy(processed.astype(np.float32)).movedim(-1, 0).unsqueeze(0)
        original_tensor = torch.from_numpy(original.astype(np.float32)).movedim(-1, 0).unsqueeze(0)
        mask_tensor = torch.from_numpy(final_mask.astype(np.float32))[None, None]
        result = self._match_edge_color(processed_tensor, original_tensor, mask_tensor, crop_info, options, state)
        return result[0].movedim(0, -1).numpy().astype(np.uint8)

    @staticmethod
    def _gpu_resize(image, width, height):
        # OpenCV 使用 Lanczos4；按两个轴分别执行 8 tap 插值，避免生成大采样张量。
        for axis, size in ((-1, width), (-2, height)):
            old_size = image.shape[axis]
            if old_size == size:
                continue
            coords = (torch.arange(size, device=image.device, dtype=torch.float32) + 0.5) * (old_size / size) - 0.5
            base = coords.floor().long()
            offsets = torch.arange(-3, 5, device=image.device)
            indices = base[:, None] + offsets[None, :]
            distance = coords[:, None] - indices
            weights = torch.sinc(distance) * torch.sinc(distance / 4)
            weights = weights / weights.sum(dim=1, keepdim=True)
            weight_shape = [1] * image.ndim
            weight_shape[axis] = size
            resized = None
            for tap in range(8):
                values = image.index_select(axis, indices[:, tap].clamp(0, old_size - 1))
                values = values * weights[:, tap].reshape(weight_shape)
                resized = values if resized is None else resized + values
            image = resized
        return image.round().clamp_(0, 255)

    @staticmethod
    def _gpu_gaussian(mask, radius):
        if radius == 0:
            return mask
        weights = torch.as_tensor(cv2.getGaussianKernel(radius * 2 + 1, 0).ravel(), device=mask.device, dtype=torch.float32)
        for axis in (-1, -2):
            length = mask.shape[axis]
            indices = torch.arange(-radius, length + radius, device=mask.device)
            if length == 1:
                indices = torch.zeros_like(indices)
            else:
                period = 2 * (length - 1)
                indices = indices.remainder(period)
                indices = torch.minimum(indices, period - indices)
            padded = mask.index_select(axis, indices)
            kernel = weights.reshape(1, 1, 1, -1) if axis == -1 else weights.reshape(1, 1, -1, 1)
            mask = F.conv2d(padded, kernel)
        return mask.round().clamp_(0, 255)

    @staticmethod
    def _gpu_erode(mask, radius):
        if radius == 0:
            return mask
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (radius * 2 + 1,) * 2)
        offsets = {}
        for row, values in enumerate(kernel):
            offsets.setdefault(int(np.count_nonzero(values)), []).append(row - radius)
        result = torch.full_like(mask, 255)
        height = mask.shape[-2]
        for width, rows in offsets.items():
            horizontal = -F.max_pool2d(-mask, (1, width), stride=1, padding=(0, width // 2))
            for offset in rows:
                start, end = max(0, -offset), min(height, height - offset)
                if start < end:
                    region = result[:, :, start:end]
                    torch.minimum(region, horizontal[:, :, start + offset:end + offset], out=region)
        return result

    @staticmethod
    def _gpu_dilate(mask, radius):
        if radius == 0:
            return mask
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (radius * 2 + 1,) * 2)
        offsets = {}
        for row, values in enumerate(kernel):
            offsets.setdefault(int(np.count_nonzero(values)), []).append(row - radius)
        result = torch.zeros_like(mask)
        height = mask.shape[-2]
        for width, rows in offsets.items():
            horizontal = F.max_pool2d(mask, (1, width), stride=1, padding=(0, width // 2))
            for offset in rows:
                start, end = max(0, -offset), min(height, height - offset)
                if start < end:
                    region = result[:, :, start:end]
                    torch.maximum(region, horizontal[:, :, start + offset:end + offset], out=region)
        return result

    def _restore_gpu_chunk(self, original, processed, crop_info, radius, mask_expand, mask, color_options=None, color_state=None):
        x1, y1, x2, y2 = crop_info["original_coords"]
        width, height = x2 - x1, y2 - y1
        ow, oh = crop_info["original_image_size"]
        pw, ph = crop_info["padded_size"]
        left, top, _, _ = crop_info["pad_info"]
        processed = self._gpu_resize(processed, width, height)
        if (pw, ph) == (ow, oh):
            restored = original.clone()
        else:
            color = torch.as_tensor(crop_info.get("fill_color", (255, 255, 255)), device=original.device, dtype=torch.float32)
            restored = color.reshape(1, 3, 1, 1).expand(original.shape[0], 3, ph, pw).clone()
            restored[:, :, top:top + oh, left:left + ow] = original
        if mask is not None:
            mask = self._gpu_resize(mask, width, height)
        if mask is not None:
            if mask_expand > 0:
                mask = self._gpu_dilate(mask, mask_expand)
            elif mask_expand < 0:
                mask = self._gpu_erode(mask, -mask_expand)
            mask = self._gpu_gaussian(mask, radius)
            if color_options is not None:
                processed = self._match_edge_color(processed, restored[:, :, y1:y2, x1:x2], mask, crop_info, color_options, color_state)
            mask = mask / 255
            original_crop = restored[:, :, y1:y2, x1:x2]
            original_crop[:] = (processed * mask + original_crop * (1 - mask)).floor().clamp_(0, 255)
        else:
            margin = abs(mask_expand) + radius + 1
            rx1, ry1 = max(0, x1 - margin), max(0, y1 - margin)
            rx2, ry2 = min(pw, x2 + margin), min(ph, y2 + margin)
            roi = restored[:, :, ry1:ry2, rx1:rx2]
            original_roi = roi.clone()
            weights = torch.zeros((1, 1, ry2 - ry1, rx2 - rx1), device=original.device)
            # 二值矩形的腐蚀可直接收缩坐标；贴着实际图像边界的一侧不收缩。
            ex1 = x1 - mask_expand if x1 > 0 else max(0, x1 - mask_expand)
            ey1 = y1 - mask_expand if y1 > 0 else max(0, y1 - mask_expand)
            ex2 = x2 + mask_expand if x2 < pw else min(pw, x2 + mask_expand)
            ey2 = y2 + mask_expand if y2 < ph else min(ph, y2 + mask_expand)
            if ex1 < ex2 and ey1 < ey2:
                weights[:, :, ey1 - ry1:ey2 - ry1, ex1 - rx1:ex2 - rx1] = 255
            weights = self._gpu_gaussian(weights, radius)
            if color_options is not None:
                final_mask = weights[:, :, y1 - ry1:y2 - ry1, x1 - rx1: x2 - rx1]
                processed = self._match_edge_color(processed, restored[:, :, y1:y2, x1:x2], final_mask, crop_info, color_options, color_state)
            roi[:, :, y1 - ry1:y2 - ry1, x1 - rx1:x2 - rx1] = processed
            weights = weights / 255
            roi[:] = (roi * weights + original_roi * (1 - weights)).floor().clamp_(0, 255)
        return restored[:, :, top:top + oh, left:left + ow].movedim(1, -1) / 255

    def _restore_gpu(self, original_image, processed_image, crop_box, blur_amount, mask_expand, mask, color_options=None):
        device = original_image.device if original_image.is_cuda else torch.device("cuda")
        batch_size = original_image.shape[0]
        infos = crop_box["crop_infos"] if "batch_size" in crop_box else [crop_box]
        if mask is not None:
            if mask.ndim == 4:
                mask = mask[..., 0]
            if mask.ndim == 2:
                mask = mask.unsqueeze(0)
        output = torch.empty((*original_image.shape[:3], 3), dtype=torch.float32, device="cpu")
        start = 0
        color_state = [None]
        while start < batch_size:
            info = infos[start] if start < len(infos) else infos[0]
            # 仅将连续相同裁剪框合批，保留移动裁剪框的帧顺序。
            pw, ph = info["padded_size"]
            x1, y1, x2, y2 = info["original_coords"]
            frame_pixels = max(pw * ph, processed_image.shape[1] * processed_image.shape[2],
                               processed_image.shape[1] * (x2 - x1), (y2 - y1) * (x2 - x1))
            free_bytes = torch.cuda.mem_get_info(device)[0]
            chunk_size = max(1, min(8, int(free_bytes * 0.25) // (frame_pixels * 128)))
            end = start + 1
            while end < min(start + chunk_size, batch_size) and (infos[end] if end < len(infos) else infos[0]) == info:
                end += 1
            original = original_image[start:end, ..., :3].to(device=device, dtype=torch.float32).movedim(-1, 1)
            proc_indices = [i if i < processed_image.shape[0] else 0 for i in range(start, end)]
            processed = processed_image[proc_indices, ..., :3].to(device=device, dtype=torch.float32).movedim(-1, 1)
            original = (original * 255).clamp_(0, 255).floor_()
            processed = (processed * 255).clamp_(0, 255).floor_()
            chunk_mask = None
            if mask is not None:
                mask_indices = [i if i < mask.shape[0] else 0 for i in range(start, end)]
                chunk_mask = mask[mask_indices].to(device=device, dtype=torch.float32).unsqueeze(1)
                chunk_mask = (chunk_mask * 255).clamp_(0, 255).floor_()
            result = self._restore_gpu_chunk(original, processed, info, blur_amount, mask_expand, chunk_mask, color_options, color_state)
            output[start:end] = result.cpu()
            start = end
        return (output,)

    def _erode_mask(self, mask, radius):
        # 将椭圆核按行拆为水平线段，保持原椭圆腐蚀结果。
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (radius * 2 + 1,) * 2)
        row_offsets = {}
        for row, values in enumerate(kernel):
            width = int(np.count_nonzero(values))
            row_offsets.setdefault(width, []).append(row - radius)
        result = np.full_like(mask, 255)
        height = mask.shape[0]
        for width, offsets in row_offsets.items():
            horizontal = cv2.erode(mask, np.ones((1, width), dtype=np.uint8))
            for offset in offsets:
                start = max(0, -offset)
                end = min(height, height - offset)
                if start < end:
                    np.minimum(result[start:end], horizontal[start + offset:end + offset], out=result[start:end])
        return result

    def _apply_mask_blend(self, restored_np, processed_np, original_np, crop_coords, input_mask, blur_amount, mask_expand, color_options=None, color_state=None, crop_info=None):
        x1, y1, x2, y2 = crop_coords
        crop_width = x2 - x1
        crop_height = y2 - y1

        # input_mask 已是 (H,W) uint8，resize 到裁剪尺寸
        mask_np = cv2.resize(input_mask, (crop_width, crop_height), interpolation=cv2.INTER_LANCZOS4)

        if mask_expand != 0:
            abs_expand = abs(mask_expand)
            if mask_expand > 0:
                kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (abs_expand * 2 + 1, abs_expand * 2 + 1))
                mask_np = cv2.dilate(mask_np, kernel, iterations=1)
            else:
                mask_np = self._erode_mask(mask_np, abs_expand)

        if blur_amount > 0:
            kernel_size = blur_amount * 2 + 1
            mask_np = cv2.GaussianBlur(mask_np, (kernel_size, kernel_size), 0)

        if color_options is not None:
            processed_np = self._match_edge_color_numpy(processed_np, original_np[y1:y2, x1:x2], mask_np, crop_info, color_options, color_state)

        mask_float = mask_np.astype(np.float32) / 255.0
        mask_3ch = np.stack([mask_float] * 3, axis=-1)

        original_crop = original_np[y1:y2, x1:x2].astype(np.float32)
        blended_crop = (
            processed_np.astype(np.float32) * mask_3ch
            + original_crop * (1 - mask_3ch)
        ).astype(np.uint8)
        restored_np[y1:y2, x1:x2] = blended_crop

        return restored_np

    def _apply_bbox_edge_blur(self, restored_np, original_np, crop_coords, blur_amount, mask_expand, color_options=None, color_state=None, crop_info=None):
        x1, y1, x2, y2 = crop_coords
        img_h, img_w = restored_np.shape[:2]

        # 留足收缩/扩展和模糊的边界，触及原图边缘时保留 OpenCV 的边界行为。
        margin = abs(mask_expand) + blur_amount + 1
        roi_x1, roi_y1 = max(0, x1 - margin), max(0, y1 - margin)
        roi_x2, roi_y2 = min(img_w, x2 + margin), min(img_h, y2 + margin)
        bbox_mask = np.zeros((roi_y2 - roi_y1, roi_x2 - roi_x1), dtype=np.uint8)
        bbox_mask[y1 - roi_y1:y2 - roi_y1, x1 - roi_x1:x2 - roi_x1] = 255

        if mask_expand != 0:
            abs_expand = abs(mask_expand)
            # 矩形遮罩的腐蚀结果与椭圆核相同，矩形核可使用快速可分离算法。
            kernel_shape = cv2.MORPH_RECT if mask_expand < 0 else cv2.MORPH_ELLIPSE
            kernel = cv2.getStructuringElement(kernel_shape, (abs_expand * 2 + 1, abs_expand * 2 + 1))
            if mask_expand > 0:
                bbox_mask = cv2.dilate(bbox_mask, kernel, iterations=1)
            else:
                bbox_mask = cv2.erode(bbox_mask, kernel, iterations=1)

        if blur_amount > 0:
            kernel_size = blur_amount * 2 + 1
            bbox_mask = cv2.GaussianBlur(bbox_mask, (kernel_size, kernel_size), 0)

        if color_options is not None:
            final_mask = bbox_mask[y1 - roi_y1:y2 - roi_y1, x1 - roi_x1:x2 - roi_x1]
            restored_np[y1:y2, x1:x2] = self._match_edge_color_numpy(
                restored_np[y1:y2, x1:x2], original_np[y1:y2, x1:x2], final_mask, crop_info, color_options, color_state
            )

        mask_float = bbox_mask.astype(np.float32) / 255.0
        mask_3ch = np.stack([mask_float] * 3, axis=-1)

        restored_roi = restored_np[roi_y1:roi_y2, roi_x1:roi_x2]
        original_roi = original_np[roi_y1:roi_y2, roi_x1:roi_x2]
        restored_roi[:] = (
            restored_roi.astype(np.float32) * mask_3ch
            + original_roi.astype(np.float32) * (1 - mask_3ch)
        ).astype(np.uint8)

        return restored_np


NODE_CLASS_MAPPINGS = {
    "XiaozhuguangATR": XiaozhuguangATR,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XiaozhuguangATR": "ATR · 高级",
}

import torch
import torch.nn.functional as F
import numpy as np
import cv2


class XiaozhuguangImageRestore:
    CATEGORY = "小珠光/图片"
    DESCRIPTION = "将处理后的单张图像粘贴回原图，批次输入自动使用第一张图片和第一个遮罩"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "original_image": ("IMAGE",),
                "processed_image": ("IMAGE",),
                "crop_box": ("XZG_IMAGE_CROPBOX",),
                "blur_amount": ("INT", {"default": 0, "min": 0, "max": 500, "step": 1, "tooltip": "接缝羽化半径；未连接遮罩时作用于裁剪框边缘"}),
                "mask_expand": ("INT", {"default": 0, "min": -500, "max": 500, "step": 1, "tooltip": "独立调整遮罩范围：正值向外扩张，负值向内收缩，0=不变"}),
                "edge_color_match": ("BOOLEAN", {"default": False, "tooltip": "根据最终遮罩的接缝区域修正处理图像的颜色偏差"}),
                "color_band_width": ("INT", {"default": 16, "min": 1, "max": 256, "step": 1, "tooltip": "沿最终融合遮罩的50%轮廓向内分析的带宽，单位为原图像素"}),
                "color_match_strength": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.05}),
                "color_correction_range": ("INT", {"default": 128, "min": 1, "max": 512, "step": 1, "tooltip": "覆盖羽化过渡带并向接缝内侧渐弱的范围，单位为原图像素"}),
                "color_temporal_smooth": ("FLOAT", {"default": 0.8, "min": 0.0, "max": 0.98, "step": 0.05, "tooltip": "批次内颜色修正量的时间平滑，0为关闭"}),
            },
            "optional": {
                "mask": ("MASK",),
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

    def restore_image(self, original_image, processed_image, crop_box, blur_amount, mask_expand=0, edge_color_match=False, color_band_width=16, color_match_strength=0.5, color_correction_range=128, color_temporal_smooth=0.8, mask=None):
        if "batch_size" in crop_box:
            crop_box = crop_box["crop_infos"][0]
        orig8 = np.clip(original_image[0].cpu().numpy() * 255, 0, 255).astype(np.uint8)[..., :3]
        proc8 = np.clip(processed_image[0].cpu().numpy() * 255, 0, 255).astype(np.uint8)[..., :3]
        mask8 = None
        if mask is not None:
            single_mask = mask if mask.ndim == 2 else mask[0]
            if single_mask.ndim == 3:
                single_mask = single_mask[..., 0]
            mask8 = np.clip(single_mask.cpu().numpy() * 255, 0, 255).astype(np.uint8)
        color_options = (color_band_width, color_match_strength, color_correction_range, color_temporal_smooth) if edge_color_match and color_match_strength > 0 else None
        color_state = [None]
        restored = self._restore_single_image(
            orig8, proc8, crop_box, blur_amount, mask_expand, mask8, color_options, color_state
        )
        return (torch.from_numpy(restored.astype(np.float32) / 255.0).unsqueeze(0),)

    def _apply_mask_blend(self, restored_np, processed_np, original_np, crop_coords, input_mask, blur_amount, mask_expand, color_options=None, color_state=None, crop_info=None):
        x1, y1, x2, y2 = crop_coords
        crop_width = x2 - x1
        crop_height = y2 - y1

        # input_mask 已是 (H,W) uint8，resize 到裁剪尺寸
        mask_np = cv2.resize(input_mask, (crop_width, crop_height), interpolation=cv2.INTER_LANCZOS4)

        if mask_expand != 0:
            abs_expand = abs(mask_expand)
            kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (abs_expand * 2 + 1, abs_expand * 2 + 1))
            if mask_expand > 0:
                mask_np = cv2.dilate(mask_np, kernel, iterations=1)
            else:
                mask_np = cv2.erode(mask_np, kernel, iterations=1)

        if blur_amount > 0:
            kernel_size = blur_amount * 2 + 1
            mask_np = cv2.GaussianBlur(mask_np, (kernel_size, kernel_size), 0)

        if color_options is not None:
            processed_np = self._match_edge_color_numpy(
                processed_np, original_np[y1:y2, x1:x2], mask_np, crop_info, color_options, color_state
            )

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

        bbox_mask = np.zeros((img_h, img_w), dtype=np.uint8)
        bbox_mask[y1:y2, x1:x2] = 255

        if mask_expand != 0:
            abs_expand = abs(mask_expand)
            kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (abs_expand * 2 + 1, abs_expand * 2 + 1))
            if mask_expand > 0:
                bbox_mask = cv2.dilate(bbox_mask, kernel, iterations=1)
            else:
                bbox_mask = cv2.erode(bbox_mask, kernel, iterations=1)

        if blur_amount > 0:
            kernel_size = blur_amount * 2 + 1
            bbox_mask = cv2.GaussianBlur(bbox_mask, (kernel_size, kernel_size), 0)

        if color_options is not None:
            final_mask = bbox_mask[y1:y2, x1:x2]
            restored_np[y1:y2, x1:x2] = self._match_edge_color_numpy(
                restored_np[y1:y2, x1:x2], original_np[y1:y2, x1:x2],
                final_mask, crop_info, color_options, color_state
            )

        mask_float = bbox_mask.astype(np.float32) / 255.0
        mask_3ch = np.stack([mask_float] * 3, axis=-1)

        result = (
            restored_np.astype(np.float32) * mask_3ch
            + original_np.astype(np.float32) * (1 - mask_3ch)
        ).astype(np.uint8)

        return result

    @staticmethod
    def _color_pad(support, radius, crop_info):
        x1, y1, x2, y2 = crop_info["original_coords"]
        left, top, _, _ = crop_info["pad_info"]
        ow, oh = crop_info["original_image_size"]
        padded = F.pad(support, (radius, radius, radius, radius), value=1)
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
        alpha = mask / 255
        support = (alpha >= 0.5).to(processed.dtype)
        transition = 4 * alpha * (1 - alpha)
        x1, y1, _, _ = crop_info["original_coords"]
        left, top, _, _ = crop_info["pad_info"]
        ow, oh = crop_info["original_image_size"]
        rows = torch.arange(height) + y1
        cols = torch.arange(width) + x1
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
        weight = torch.maximum(inward_weight, transition) * (alpha > 0) * valid_region
        return (processed + offsets * weight * strength).round().clamp_(0, 255)

    def _match_edge_color_numpy(self, processed, original, final_mask, crop_info, options, state):
        processed_tensor = torch.from_numpy(processed.astype(np.float32)).movedim(-1, 0).unsqueeze(0)
        original_tensor = torch.from_numpy(original.astype(np.float32)).movedim(-1, 0).unsqueeze(0)
        mask_tensor = torch.from_numpy(final_mask.astype(np.float32))[None, None]
        result = self._match_edge_color(processed_tensor, original_tensor, mask_tensor, crop_info, options, state)
        return result[0].movedim(0, -1).numpy().astype(np.uint8)


NODE_CLASS_MAPPINGS = {
    "XiaozhuguangImageRestore": XiaozhuguangImageRestore,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XiaozhuguangImageRestore": "小珠光 图像回贴",
}

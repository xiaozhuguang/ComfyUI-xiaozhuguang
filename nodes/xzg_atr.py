import torch
import numpy as np
import cv2


class XiaozhuguangATR:
    CATEGORY = "xiaozhuguang"
    DESCRIPTION = "将处理后的图像粘贴回原图"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "original_image": ("IMAGE",),
                "processed_image": ("IMAGE",),
                "crop_box": ("CROPBOX",),
                "blur_amount": ("INT", {"default": 0, "min": 0, "max": 500, "step": 1, "tooltip": "边缘羽化值，对mask边缘或bbox边缘应用高斯模糊"}),
                "mask_expand": ("INT", {"default": 0, "min": -500, "max": 500, "step": 1, "tooltip": "遮罩扩展值，正值扩展，负值收缩"}),
            },
            "optional": {
                "mask": ("MASK",),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("restored_image",)
    FUNCTION = "restore_image"

    def _restore_single_image(self, orig_np, proc_np, crop_info, blur_amount, mask_expand, single_mask=None):
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
                mask_expand
            )
        else:
            restored[y1:y1 + crop_height, x1:x1 + crop_width] = resized_processed
            if blur_amount > 0 or mask_expand != 0:
                restored = self._apply_bbox_edge_blur(
                    restored,
                    padded_original,
                    original_coords,
                    blur_amount,
                    mask_expand
                )

        if pad_left > 0 or pad_top > 0 or pad_right > 0 or pad_bottom > 0:
            restored = restored[pad_top:pad_top + oh, pad_left:pad_left + ow]

        return restored

    def restore_image(self, original_image, processed_image, crop_box, blur_amount, mask_expand, mask=None):
        batch_size = original_image.shape[0]

        if "batch_size" in crop_box:
            crop_infos = crop_box["crop_infos"]
        else:
            crop_infos = [crop_box] * batch_size

        orig8 = np.clip(original_image.cpu().numpy() * 255, 0, 255).astype(np.uint8)
        proc8 = np.clip(processed_image.cpu().numpy() * 255, 0, 255).astype(np.uint8)

        mask8 = None
        mask_batched = False
        if mask is not None:
            m = np.clip(mask.cpu().numpy() * 255, 0, 255).astype(np.uint8)
            if m.ndim == 4:  # (B,H,W,1)：去掉单通道
                m = m[..., 0]
            mask_batched = m.ndim == 3  # (B,H,W)；否则 (H,W) 单遮罩
            mask8 = m

        output_images = []
        for i in range(batch_size):
            orig_np = orig8[i] if i < orig8.shape[0] else orig8[0]
            proc_np = proc8[i] if i < proc8.shape[0] else proc8[0]
            crop_info = crop_infos[i] if i < len(crop_infos) else crop_infos[0]

            single_mask = None
            if mask8 is not None:
                single_mask = mask8[i] if mask_batched else mask8

            restored = self._restore_single_image(
                orig_np, proc_np, crop_info, blur_amount, mask_expand, single_mask
            )
            output_images.append(restored.astype(np.float32) / 255.0)

        output_image = torch.from_numpy(np.stack(output_images, axis=0))
        return (output_image,)

    def _apply_mask_blend(self, restored_np, processed_np, original_np, crop_coords, input_mask, blur_amount, mask_expand):
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

        mask_float = mask_np.astype(np.float32) / 255.0
        mask_3ch = np.stack([mask_float] * 3, axis=-1)

        original_crop = original_np[y1:y2, x1:x2].astype(np.float32)
        blended_crop = (
            processed_np.astype(np.float32) * mask_3ch
            + original_crop * (1 - mask_3ch)
        ).astype(np.uint8)
        restored_np[y1:y2, x1:x2] = blended_crop

        return restored_np

    def _apply_bbox_edge_blur(self, restored_np, original_np, crop_coords, blur_amount, mask_expand):
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

        mask_float = bbox_mask.astype(np.float32) / 255.0
        mask_3ch = np.stack([mask_float] * 3, axis=-1)

        result = (
            restored_np.astype(np.float32) * mask_3ch
            + original_np.astype(np.float32) * (1 - mask_3ch)
        ).astype(np.uint8)

        return result


NODE_CLASS_MAPPINGS = {
    "XiaozhuguangATR": XiaozhuguangATR,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XiaozhuguangATR": "ATR",
}

import torch
import numpy as np
from PIL import Image
import cv2


class XiaozhuguangATR:
    CATEGORY = "小珠光"
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

    def _restore_single_image(self, original_pil, processed_pil, crop_info, blur_amount, mask_expand, single_mask=None):
        original_coords = crop_info["original_coords"]
        padded_size = crop_info["padded_size"]
        original_image_size = crop_info["original_image_size"]
        pad_info = crop_info["pad_info"]
        fill_color = crop_info.get("fill_color", (255, 255, 255))

        pad_left, pad_top, pad_right, pad_bottom = pad_info

        crop_width = original_coords[2] - original_coords[0]
        crop_height = original_coords[3] - original_coords[1]
        resized_processed = processed_pil.resize((crop_width, crop_height), Image.LANCZOS)

        restored_image = original_pil.copy()
        if padded_size != (original_image_size[0], original_image_size[1]):
            restored_image = Image.new("RGB", padded_size, fill_color)
            orig_region = (
                pad_left,
                pad_top,
                pad_left + original_image_size[0],
                pad_top + original_image_size[1]
            )
            restored_image.paste(original_pil, orig_region)

        padded_original = restored_image.copy()

        if single_mask is not None:
            restored_image = self._apply_mask_blend(
                restored_image,
                resized_processed,
                padded_original,
                original_coords,
                single_mask,
                blur_amount,
                mask_expand
            )
        else:
            restored_image.paste(resized_processed, original_coords[:2])
            if blur_amount > 0 or mask_expand != 0:
                restored_image = self._apply_bbox_edge_blur(
                    restored_image,
                    padded_original,
                    original_coords,
                    blur_amount,
                    mask_expand
                )

        if pad_left > 0 or pad_top > 0 or pad_right > 0 or pad_bottom > 0:
            restored_image = restored_image.crop((
                pad_left,
                pad_top,
                pad_left + original_image_size[0],
                pad_top + original_image_size[1]
            ))

        return restored_image

    def restore_image(self, original_image, processed_image, crop_box, blur_amount, mask_expand, mask=None):
        batch_size = original_image.shape[0]

        if "batch_size" in crop_box:
            crop_infos = crop_box["crop_infos"]
        else:
            crop_infos = [crop_box] * batch_size

        output_images = []

        for i in range(batch_size):
            single_original = original_image[i]
            single_processed = processed_image[i]
            crop_info = crop_infos[i] if i < len(crop_infos) else crop_infos[0]

            orig_np = np.clip(single_original.cpu().numpy() * 255, 0, 255).astype(np.uint8)
            original_pil = Image.fromarray(orig_np)

            proc_np = np.clip(single_processed.cpu().numpy() * 255, 0, 255).astype(np.uint8)
            processed_pil = Image.fromarray(proc_np)

            single_mask = None
            if mask is not None:
                if len(mask.shape) == 3:
                    single_mask = mask[i] if i < mask.shape[0] else mask[0]
                else:
                    single_mask = mask

            restored_image = self._restore_single_image(
                original_pil, processed_pil, crop_info,
                blur_amount, mask_expand, single_mask
            )

            img_tensor = np.array(restored_image).astype(np.float32) / 255.0
            output_images.append(img_tensor)

        output_image = torch.from_numpy(np.stack(output_images, axis=0))

        return (output_image,)

    def _apply_mask_blend(self, restored_image, resized_processed, original_image, crop_coords, input_mask, blur_amount, mask_expand):
        restored_np = np.array(restored_image)
        processed_np = np.array(resized_processed)
        original_np = np.array(original_image)

        x1, y1, x2, y2 = crop_coords
        crop_width = x2 - x1
        crop_height = y2 - y1

        if torch.is_tensor(input_mask):
            mask_np = np.clip(input_mask.cpu().numpy() * 255, 0, 255).astype(np.uint8)
            if len(mask_np.shape) > 2:
                mask_np = mask_np[0] if mask_np.shape[0] == 1 else mask_np[:, :, 0]
        else:
            mask_np = input_mask

        pil_mask = Image.fromarray(mask_np, mode='L')
        resized_mask = pil_mask.resize((crop_width, crop_height), Image.LANCZOS)
        mask_np = np.array(resized_mask)

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

        original_crop = original_np[y1:y2, x1:x2]
        blended_crop = (processed_np * mask_3ch + original_crop * (1 - mask_3ch)).astype(np.uint8)
        restored_np[y1:y2, x1:x2] = blended_crop

        return Image.fromarray(restored_np)

    def _apply_bbox_edge_blur(self, restored_image, original_image, crop_coords, blur_amount, mask_expand):
        restored_np = np.array(restored_image)
        original_np = np.array(original_image)

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

        result_np = (restored_np * mask_3ch + original_np * (1 - mask_3ch)).astype(np.uint8)

        return Image.fromarray(result_np)


NODE_CLASS_MAPPINGS = {
    "XiaozhuguangATR": XiaozhuguangATR,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XiaozhuguangATR": "ATR",
}

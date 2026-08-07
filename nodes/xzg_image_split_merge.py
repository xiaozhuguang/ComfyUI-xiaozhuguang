import torch
import numpy as np
import cv2


class XiaozhuguangImageSplitter:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "split_x": ("INT", {
                    "default": 2,
                    "min": 0,
                    "max": 8,
                    "step": 2
                }),
                "split_y": ("INT", {
                    "default": 2,
                    "min": 0,
                    "max": 8,
                    "step": 2
                }),
                "overlap": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": 256,
                    "step": 8
                })
            },
            "optional": {
                "mask": ("MASK",),
            }
        }
    RETURN_NAMES = ("images", "masks", "split_data", "merge_weights")
    RETURN_TYPES = ("IMAGE", "MASK", "SPLIT_DATA", "MASK")
    INPUT_IS_LIST = ("image", "mask",)  # image和mask都是列表输入
    OUTPUT_IS_LIST = (True, True, False, True)
    FUNCTION = "split_image"
    CATEGORY = "xiaozhuguang"

    def create_feather_mask(self, h, w, overlap, pos, full_h, full_w, device):
        """创建羽化权重遮罩"""
        mask = torch.zeros((h, w), dtype=torch.float32, device=device)
        h_start, h_end, w_start, w_end = pos["full_pos"]

        # 先创建基础遮罩（重叠区域为1，非重叠区域为0）
        if h_start != 0:  # 上边重叠
            mask[:overlap, :] = 1
        if h_end != full_h:  # 下边重叠
            mask[-overlap:, :] = 1
        if w_start != 0:  # 左边重叠
            mask[:, :overlap] = 1
        if w_end != full_w:  # 右边重叠
            mask[:, -overlap:] = 1

        if overlap > 0:
            # 转换为numpy进行高斯模糊
            mask_np = mask.cpu().numpy().astype(np.float32)
            kernel_size = overlap * 2 + 1
            sigma = overlap / 2
            mask_np = cv2.GaussianBlur(mask_np, (kernel_size, kernel_size), sigma)
            mask = torch.from_numpy(mask_np).to(device)

        # 返回合并权重（1 - 羽化遮罩）
        return 1 - mask

    def split_single_image(self, image, split_x, split_y, overlap, mask=None):
        """处理单个图像的分割"""
        B, H, W, C = image.shape
        split_x = max(1, split_x)
        split_y = max(1, split_y)

        base_h_size = H // split_y
        base_w_size = W // split_x

        splits = []
        mask_splits = []
        weight_masks = []
        block_positions = []
        device = image.device

        for y in range(split_y):
            for x in range(split_x):
                h_start = y * base_h_size
                w_start = x * base_w_size
                h_end = (y + 1) * base_h_size
                w_end = (x + 1) * base_w_size

                # 所有块都向内扩展
                if x > 0:  # 如果不是第一列，向左扩展
                    w_start -= overlap
                if x < split_x - 1:  # 如果不是最后一列，向右扩展
                    w_end += overlap
                if y > 0:  # 如果不是第一行，向上扩展
                    h_start -= overlap
                if y < split_y - 1:  # 如果不是最后一行，向下扩展
                    h_end += overlap

                split = image[0:1, h_start:h_end, w_start:w_end, :]
                splits.append(split)

                # 处理遮罩分割
                if mask is not None:
                    mask_split = mask[0:1, h_start:h_end, w_start:w_end]
                    mask_splits.append(mask_split)

                pos_info = {
                    "x_ratio": x / split_x,
                    "y_ratio": y / split_y,
                    "width_ratio": 1 / split_x,
                    "height_ratio": 1 / split_y,
                    "overlap": overlap,
                    "orig_pos": (y * base_h_size,
                               (y + 1) * base_h_size,
                               x * base_w_size,
                               (x + 1) * base_w_size),
                    "full_pos": (h_start, h_end, w_start, w_end)
                }
                block_positions.append(pos_info)

                # 生成合并权重遮罩
                h, w = h_end - h_start, w_end - w_start
                if overlap > 0:
                    weight_mask = self.create_feather_mask(h, w, overlap, pos_info, H, W, device)
                else:
                    weight_mask = torch.ones((h, w), dtype=torch.float32, device=device)
                weight_masks.append(weight_mask.unsqueeze(0))

        return splits, mask_splits, weight_masks, block_positions, (H, W), (base_h_size, base_w_size)

    def split_image(self, image, split_x, split_y, overlap, mask=None):
        """处理图像列表"""
        # 确保其他参数不是列表
        split_x = split_x[0] if isinstance(split_x, list) else split_x
        split_y = split_y[0] if isinstance(split_y, list) else split_y
        overlap = overlap[0] if isinstance(overlap, list) else overlap

        all_splits = []
        all_mask_splits = []
        all_weight_masks = []
        all_block_positions = []
        original_sizes = []
        block_sizes = []

        # 处理每个输入图像
        for i, img in enumerate(image):
            # 获取对应的遮罩（如果有的话）
            current_mask = None
            if mask is not None and len(mask) > i:
                current_mask = mask[i].unsqueeze(0) if len(mask[i].shape) == 2 else mask[i]

            splits, mask_splits, weight_masks, positions, orig_size, block_size = self.split_single_image(
                img.unsqueeze(0) if len(img.shape) == 3 else img,
                split_x, split_y, overlap, current_mask
            )
            all_splits.extend(splits)
            all_mask_splits.extend(mask_splits)
            all_weight_masks.extend(weight_masks)
            all_block_positions.extend(positions)
            original_sizes.append(orig_size)
            block_sizes.append(block_size)

        # 创建包含所有图像信息的split_data
        split_data = {
            "original_sizes": original_sizes,  # 每个输入图像的原始尺寸
            "split_x": split_x,
            "split_y": split_y,
            "block_positions": all_block_positions,
            "original_block_sizes": block_sizes,  # 每个输入图像的块尺寸
            "overlap": overlap,
            "images_count": len(image),  # 添加输入图像数量信息
            "has_mask": mask is not None  # 记录是否有遮罩
        }

        # 如果没有遮罩，返回空列表作为遮罩输出
        if not all_mask_splits:
            all_mask_splits = []

        return (all_splits, all_mask_splits, split_data, all_weight_masks)


class XiaozhuguangImageMerger:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "split_data": ("SPLIT_DATA",),
            },
            "optional": {
                "masks": ("MASK",),
            }
        }
    INPUT_IS_LIST = ("images", "masks",)
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("merged",)
    OUTPUT_IS_LIST = (True,)  # 返回多个合并后的图像
    FUNCTION = "merge_image"
    CATEGORY = "xiaozhuguang"

    def create_feather_mask(self, h, w, overlap, pos, full_h, full_w, device):
        mask = torch.zeros((h, w), dtype=torch.float32, device=device)
        h_start, h_end, w_start, w_end = pos["full_pos"]

        # 先创建基础遮罩（重叠区域为1，非重叠区域为0）
        if h_start != 0:  # 上边重叠
            mask[:overlap, :] = 1
        if h_end != full_h:  # 下边重叠
            mask[-overlap:, :] = 1
        if w_start != 0:  # 左边重叠
            mask[:, :overlap] = 1
        if w_end != full_w:  # 右边重叠
            mask[:, -overlap:] = 1

        if overlap > 0:
            # 转换为numpy进行高斯模糊
            mask_np = mask.cpu().numpy().astype(np.float32)
            kernel_size = overlap * 2 + 1
            sigma = overlap / 2
            mask_np = cv2.GaussianBlur(mask_np, (kernel_size, kernel_size), sigma)
            mask = torch.from_numpy(mask_np).to(device)

        return mask

    def merge_single_image(self, image_blocks, original_size, block_positions, overlap, device, mask_blocks=None):
        """合并单个图像的分块"""
        H, W = original_size
        channels = image_blocks[0].shape[-1]

        merged = torch.zeros((1, H, W, channels), device=device)
        weights_sum = torch.zeros((1, H, W, 1), device=device)

        # 如果有遮罩，初始化合并后的遮罩
        merged_mask = None
        mask_weights_sum = None
        if mask_blocks is not None:
            merged_mask = torch.zeros((1, H, W), device=device)
            mask_weights_sum = torch.zeros((1, H, W), device=device)

        for i, (block, pos) in enumerate(zip(image_blocks, block_positions)):
            h_start, h_end, w_start, w_end = pos["full_pos"]
            current_block = block.squeeze() if len(block.shape) != 3 else block
            h, w = h_end - h_start, w_end - w_start

            if overlap > 0:
                mask = self.create_feather_mask(h, w, overlap, pos, H, W, device)
                mask = mask.unsqueeze(0)
                merge_weights = (1 - mask).unsqueeze(-1)
            else:
                merge_weights = torch.ones((1, h, w, 1), device=device)

            current_block = current_block.unsqueeze(0) if len(current_block.shape) == 3 else current_block

            merged[0, h_start:h_end, w_start:w_end, :] += current_block[0] * merge_weights[0]
            weights_sum[0, h_start:h_end, w_start:w_end, :] += merge_weights[0]

            # 处理遮罩合并
            if mask_blocks is not None and i < len(mask_blocks):
                current_mask_block = mask_blocks[i]
                if len(current_mask_block.shape) == 3:
                    current_mask_block = current_mask_block.squeeze(0)
                elif len(current_mask_block.shape) == 4:
                    current_mask_block = current_mask_block[0]

                mask_weight = merge_weights[0, :, :, 0] if overlap > 0 else torch.ones((h, w), device=device)
                merged_mask[0, h_start:h_end, w_start:w_end] += current_mask_block * mask_weight
                mask_weights_sum[0, h_start:h_end, w_start:w_end] += mask_weight

        # 归一化图像
        valid_mask = weights_sum > 0
        merged[valid_mask.repeat(1, 1, 1, channels)] /= weights_sum[valid_mask].repeat_interleave(channels)

        # 归一化遮罩
        if merged_mask is not None:
            valid_mask_mask = mask_weights_sum > 0
            merged_mask[valid_mask_mask] /= mask_weights_sum[valid_mask_mask]

        return merged, merged_mask

    def merge_image(self, images, split_data, masks=None):
        split_data = split_data[0]

        images_count = split_data["images_count"]
        original_sizes = split_data["original_sizes"]
        block_positions = split_data["block_positions"]
        overlap = split_data["overlap"]  # 从split_data中获取overlap
        blocks_per_image = len(block_positions) // images_count
        device = images[0].device
        has_mask = split_data.get("has_mask", False)

        merged_images = []

        # 处理每个原始图像
        for i in range(images_count):
            start_idx = i * blocks_per_image
            end_idx = (i + 1) * blocks_per_image

            # 获取当前图像的分块和位置信息
            current_blocks = images[start_idx:end_idx]
            current_positions = block_positions[start_idx:end_idx]

            # 获取当前图像的遮罩分块（如果有的话）
            current_mask_blocks = None
            if masks is not None and has_mask and len(masks) > start_idx:
                current_mask_blocks = masks[start_idx:end_idx]

            # 合并当前图像的分块
            merged, merged_mask = self.merge_single_image(
                current_blocks,
                original_sizes[i],
                current_positions,
                overlap,  # 使用从split_data中获取的overlap
                device,
                current_mask_blocks
            )

            merged_images.append(merged)

        return (merged_images,)


NODE_CLASS_MAPPINGS = {
    "XiaozhuguangImageSplitter": XiaozhuguangImageSplitter,
    "XiaozhuguangImageMerger": XiaozhuguangImageMerger,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XiaozhuguangImageSplitter": "IS",
    "XiaozhuguangImageMerger": "IM",
}

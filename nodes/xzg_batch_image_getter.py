import torch


class XiaozhuguangBatchImageGetter:
    """把图像加载器的批次/列表输出拆为固定编号的单图输出。"""

    OUTPUT_COUNT = 20

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "输出数量": ("INT", {"default": 7, "min": 1, "max": cls.OUTPUT_COUNT, "step": 1}),
            },
            "optional": {
                # 保留历史输入键“图像”，使旧工作流的图像连线继续匹配。
                # 可选端口：允许输入为空（未连接）或上游被绕过（前端会直接删除该连线，
                # 导致后端调用时图像参数缺失），两种情况都等同于阻断，所有输出为空（None）。
                "图像": ("IMAGE", {"input_is_list": True}),
            },
        }

    RETURN_TYPES = ("IMAGE",) * OUTPUT_COUNT
    RETURN_NAMES = tuple(str(i) for i in range(1, OUTPUT_COUNT + 1))
    FUNCTION = "get_images"
    CATEGORY = "小珠光/图片"
    INPUT_IS_LIST = (True, True)
    DESCRIPTION = "把图像批次或列表按顺序拆为单图；输出数量控制端口数量，缺少的图像输出为空。"

    @staticmethod
    def _single_image(image):
        if isinstance(image, torch.Tensor) and image.dim() == 3:
            return image.unsqueeze(0)
        return image

    @classmethod
    def _flatten_images(cls, images):
        """兼容加载器的列表模式、batch 模式和执行器造成的一层嵌套。"""
        if images is None:
            return []
        if isinstance(images, torch.Tensor):
            if images.dim() == 4:
                return [images[i:i + 1] for i in range(images.shape[0])]
            return [cls._single_image(images)]
        if not isinstance(images, (list, tuple)):
            return [cls._single_image(images)]

        result = []
        for image in images:
            if isinstance(image, (list, tuple)):
                result.extend(cls._flatten_images(image))
            elif isinstance(image, torch.Tensor) and image.dim() == 4:
                result.extend(image[i:i + 1] for i in range(image.shape[0]))
            elif image is not None:
                result.append(cls._single_image(image))
        return result

    @staticmethod
    def _flatten_masks(masks):
        """把遮罩列表或 [N,H,W] 批次展平为逐张遮罩。"""
        if masks is None:
            return []
        if isinstance(masks, torch.Tensor):
            if masks.dim() == 2:
                return [masks.unsqueeze(0)]
            if masks.dim() == 3:
                return [masks[i:i + 1] for i in range(masks.shape[0])]
            if masks.dim() == 4:
                return [masks[i] for i in range(masks.shape[0])]
            return []
        if not isinstance(masks, (list, tuple)):
            return []
        result = []
        for mask in masks:
            if mask is None:
                continue
            if isinstance(mask, (list, tuple)):
                result.extend(XiaozhuguangBatchImageGetter._flatten_masks(mask))
            elif isinstance(mask, torch.Tensor) and mask.dim() == 3:
                result.extend(mask[i:i + 1] for i in range(mask.shape[0]))
            elif isinstance(mask, torch.Tensor) and mask.dim() == 2:
                result.append(mask.unsqueeze(0))
            elif isinstance(mask, torch.Tensor) and mask.dim() == 4:
                result.extend(mask[i] for i in range(mask.shape[0]))
            elif isinstance(mask, torch.Tensor):
                result.append(mask)
        return result

    @staticmethod
    def _looks_like_image(value):
        if isinstance(value, (list, tuple)):
            return next((XiaozhuguangBatchImageGetter._looks_like_image(item)
                         for item in value if item is not None), False)
        if not isinstance(value, torch.Tensor):
            return False
        if value.dim() == 4:
            return True
        # ComfyUI 的 IMAGE 标准形状为 [B,H,W,C]，MASK 为 [B,H,W]。
        return False

    def get_images(self, 图像=None, 输出数量=None):
        # 图像参数带默认值：上游被绕过时前端会删除该连线，后端调用时参数完全缺失，
        # 若无默认值会直接 TypeError；缺参/传 None/传非图像值（如旧版旁路直通来的
        # 字符串控件值）一律视为阻断，所有输出为空。
        if 输出数量 is None:
            输出数量 = 7
        images = self._flatten_images(图像) if self._looks_like_image(图像) else []
        # INPUT_IS_LIST 会把普通数值控件包成一层 list。
        if isinstance(输出数量, (list, tuple)):
            输出数量 = 输出数量[0] if 输出数量 else 1
        try:
            output_count = max(1, min(self.OUTPUT_COUNT, int(输出数量)))
        except (TypeError, ValueError):
            output_count = 1
        # 缺图严格返回 None，绝不钳制或复用最后一张图。
        image_outputs = tuple(images[i] if i < len(images) and i < output_count else None for i in range(self.OUTPUT_COUNT))
        return image_outputs


class XiaozhuguangBatchMaskGetter(XiaozhuguangBatchImageGetter):
    """把遮罩批次或列表拆为固定编号的单张遮罩。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "输出数量": ("INT", {"default": 7, "min": 1, "max": cls.OUTPUT_COUNT, "step": 1}),
            },
            "optional": {"遮罩": ("MASK", {"input_is_list": True})},
        }

    RETURN_TYPES = ("MASK",) * 20
    RETURN_NAMES = tuple(str(i) for i in range(1, 21))
    FUNCTION = "get_masks"
    DESCRIPTION = "把遮罩批次或列表按顺序拆为单张遮罩；输出数量控制端口数量，缺少的遮罩输出为空。"

    def get_masks(self, 遮罩=None, 输出数量=None):
        masks = self._flatten_masks(遮罩)
        if isinstance(输出数量, (list, tuple)):
            输出数量 = 输出数量[0] if 输出数量 else 1
        try:
            count = max(1, min(self.OUTPUT_COUNT, int(7 if 输出数量 is None else 输出数量)))
        except (TypeError, ValueError):
            count = 1
        return tuple(masks[i] if i < len(masks) and i < count else None for i in range(self.OUTPUT_COUNT))


NODE_CLASS_MAPPINGS = {"XiaozhuguangBatchImageGetter": XiaozhuguangBatchImageGetter, "XiaozhuguangBatchMaskGetter": XiaozhuguangBatchMaskGetter}
NODE_DISPLAY_NAME_MAPPINGS = {"XiaozhuguangBatchImageGetter": "小珠光批次列表图像获取-阻断", "XiaozhuguangBatchMaskGetter": "小珠光批次列表遮罩获取-阻断"}

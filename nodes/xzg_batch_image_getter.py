import torch


class _AnyType(str):
    def __eq__(self, other):
        return True

    def __ne__(self, other):
        return False


ANY_TYPE = _AnyType("*")


class XiaozhuguangBatchImageGetter:
    """把图像加载器的批次/列表输出拆为固定编号的单图输出。"""

    OUTPUT_COUNT = 20

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # 保留历史输入键“图像”，使旧工作流的图像连线继续匹配；通用类型同时接受 MASK。
                "图像": (ANY_TYPE, {"input_is_list": True}),
                "输出数量": ("INT", {"default": 7, "min": 1, "max": cls.OUTPUT_COUNT, "step": 1}),
            },
        }

    RETURN_TYPES = ("IMAGE",) * OUTPUT_COUNT + ("MASK",) * OUTPUT_COUNT
    RETURN_NAMES = tuple(str(i) for i in range(1, OUTPUT_COUNT + 1)) + tuple(f"遮罩{i}" for i in range(1, OUTPUT_COUNT + 1))
    FUNCTION = "get_images"
    CATEGORY = "小珠光/图片"
    INPUT_IS_LIST = (True, True)
    DESCRIPTION = (
        "一个通用输入端口自动识别 IMAGE 或 MASK：批次/列表中的图像按顺序拆到 1 至 20，遮罩拆到遮罩1至遮罩20。"
        "输入不足输出数量时，对应输出为 None。"
    )

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

    def get_images(self, 图像, 输出数量):
        if self._looks_like_image(图像):
            images = self._flatten_images(图像)
            masks = []
        else:
            images = []
            masks = self._flatten_masks(图像)
        # INPUT_IS_LIST 会把普通数值控件包成一层 list。
        if isinstance(输出数量, (list, tuple)):
            输出数量 = 输出数量[0] if 输出数量 else 1
        try:
            output_count = max(1, min(self.OUTPUT_COUNT, int(输出数量)))
        except (TypeError, ValueError):
            output_count = 1
        # 缺图严格返回 None，绝不钳制或复用最后一张图。
        image_outputs = tuple(images[i] if i < len(images) and i < output_count else None for i in range(self.OUTPUT_COUNT))
        mask_outputs = tuple(masks[i] if i < len(masks) and i < output_count else None for i in range(self.OUTPUT_COUNT))
        return image_outputs + mask_outputs


NODE_CLASS_MAPPINGS = {"XiaozhuguangBatchImageGetter": XiaozhuguangBatchImageGetter}
NODE_DISPLAY_NAME_MAPPINGS = {"XiaozhuguangBatchImageGetter": "小珠光批次或列表图像获取"}

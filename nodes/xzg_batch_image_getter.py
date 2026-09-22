import torch


class XiaozhuguangBatchImageGetter:
    """把图像加载器的批次/列表输出拆为固定编号的单图输出。"""

    OUTPUT_COUNT = 20

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE", {"input_is_list": True}),
                "输出数量": ("INT", {"default": 7, "min": 1, "max": cls.OUTPUT_COUNT, "step": 1}),
            },
        }

    RETURN_TYPES = ("IMAGE",) * OUTPUT_COUNT
    RETURN_NAMES = tuple(str(i) for i in range(1, OUTPUT_COUNT + 1))
    FUNCTION = "get_images"
    CATEGORY = "xiaozhuguang"
    INPUT_IS_LIST = (True, True)
    DESCRIPTION = (
        "填写输出数量后，将批次或列表图像按顺序拆到编号输出。第 N 个输出仅对应第 N 张图；"
        "当输入图片不足 N 张时该输出为 None，用于阻断下游数据。"
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

    def get_images(self, 图像, 输出数量):
        images = self._flatten_images(图像)
        # INPUT_IS_LIST 会把普通数值控件包成一层 list。
        if isinstance(输出数量, (list, tuple)):
            输出数量 = 输出数量[0] if 输出数量 else 1
        try:
            output_count = max(1, min(self.OUTPUT_COUNT, int(输出数量)))
        except (TypeError, ValueError):
            output_count = 1
        # 缺图严格返回 None，绝不钳制或复用最后一张图。
        return tuple(images[i] if i < len(images) and i < output_count else None for i in range(self.OUTPUT_COUNT))


NODE_CLASS_MAPPINGS = {"XiaozhuguangBatchImageGetter": XiaozhuguangBatchImageGetter}
NODE_DISPLAY_NAME_MAPPINGS = {"XiaozhuguangBatchImageGetter": "小珠光批次阻断器"}

import torch


class XiaozhuguangImageFromList:
    """按索引从图像或遮罩的列表、批次中连续取出指定数量。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # input_is_list：一次接收完整列表（上游若为图像加载器列表模式的 IMAGE 输出，
                # 因本端口声明了 INPUT_IS_LIST，会拿到整段 list 而非被逐元素拆开）
                "images": ("IMAGE,MASK", {"input_is_list": True}),
                "index": ("INT", {"default": 0, "min": 0, "max": 999999, "step": 1}),
                "length": ("INT", {"default": 1, "min": 1, "max": 999999, "step": 1}),
                "output_mode": (["列表", "批次"], {"default": "列表"}),
            },
        }

    RETURN_TYPES = ("IMAGE,MASK",)
    RETURN_NAMES = ("图像／遮罩",)
    FUNCTION = "get_image"
    CATEGORY = "小珠光/图片"
    INPUT_IS_LIST = True
    OUTPUT_IS_LIST = (True,)
    DESCRIPTION = "支持 IMAGE 或 MASK 的批次、列表输入。自 index 起取 length 项，index 从 0 开始，0 为第一项，越界自动钳制。列表输出支持不同尺寸；批次输出要求尺寸一致。"

    def _to_list(self, images):
        if isinstance(images, (list, tuple)):
            out = []
            for item in images:
                if item is not None:
                    out.extend(self._to_list(item))
            return out
        if not isinstance(images, torch.Tensor) or images.dim() not in (2, 3, 4):
            raise ValueError("输入需要 IMAGE [N,H,W,C] 或 MASK [N,H,W] / [H,W]")
        if images.dim() == 2:
            images = images.unsqueeze(0)
        return [images[i:i + 1] for i in range(images.shape[0])]

    def get_image(self, images, index, length, output_mode="列表"):
        # 剥掉标量控件被执行器套的一层 list（上游 OUTPUT_IS_LIST 广播时，非 list 端口也会收到长度为 1 的列表）
        if isinstance(index, (list, tuple)):
            index = index[0]
        if isinstance(length, (list, tuple)):
            length = length[0]

        try:
            idx = int(index)
        except (TypeError, ValueError):
            idx = 0
        try:
            length = max(1, int(length))
        except (TypeError, ValueError):
            length = 1

        if isinstance(output_mode, (list, tuple)):
            output_mode = output_mode[0]

        all_imgs = self._to_list(images)
        if len(all_imgs) == 0:
            raise ValueError("图像／遮罩列表为空，无法选取")

        # 越界索引钳制到首项或末项。
        start = max(0, min(idx, len(all_imgs) - 1))
        end = start + length

        # 单张/多张统一返回 list：保证 OUTPUT_IS_LIST=True 下 extend() 行为一致，
        # 不会把单个 tensor 沿第一维误拆成三维切片，从而造成"无数 3px 小图"。
        _out = all_imgs[start:end]
        if len(_out) <= 0:
            _out = [all_imgs[start]]
        if output_mode == "批次":
            if any(item.shape[1:] != _out[0].shape[1:] for item in _out):
                raise ValueError("批次输出要求图像／遮罩尺寸一致，请改用列表输出")
            return ([torch.cat(_out, dim=0)],)
        return ([item.clone() for item in _out],)


NODE_CLASS_MAPPINGS = {
    "XiaozhuguangImageFromList": XiaozhuguangImageFromList,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XiaozhuguangImageFromList": "小珠光从列表获取图像",
}

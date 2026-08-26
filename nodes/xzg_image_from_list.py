import torch


class XiaozhuguangImageFromList:
    """小珠光从列表获取图像
    从 IMAGE 输入（可为 Python 列表 / 已堆叠的 batch / 单张）中，自 index 起连续取 length 张。
    - index 支持负数（-1 取最后一张），越界自动钳制到首张/末张
    - length 为连续取图的「数量」：如共有 4 张、index=1、length=3，则取第 2、3、4 张；
      length=1（默认）等价于原来的单取逻辑
    - 多张时返回列表，靠 OUTPUT_IS_LIST 广播，下游对每张图各执行一次（与图像加载器列表模式一致，尺寸不一致可分别预览）
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # input_is_list：一次接收完整列表（上游若为图像加载器列表模式的 IMAGE 输出，
                # 因本端口声明了 INPUT_IS_LIST，会拿到整段 list 而非被逐元素拆开）
                "images": ("IMAGE", {"input_is_list": True}),
                "index": ("INT", {"default": 0, "min": -999999, "max": 999999, "step": 1}),
                "length": ("INT", {"default": 1, "min": 1, "max": 999999, "step": 1}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    FUNCTION = "get_image"
    CATEGORY = "xiaozhuguang"
    INPUT_IS_LIST = (True, True, True)
    OUTPUT_IS_LIST = (True,)
    DESCRIPTION = "从 IMAGE 列表输入中，自 index 起连续取 length 张图（index 支持负数，越界自动钳制）。length 为取图数量：如列表 4 张、index=1、length=3，则取第 2、3、4 张。支持图片尺寸不一致，返回列表并广播，下游逐张执行（与小珠光图像加载器列表模式一致）。length=1 为单取。"

    def _to_4d(self, it):
        # 归一为 4 维 [1,H,W,C]；兼容：4D 单张 [1,H,W,C]、3D [H,W,C]
        if isinstance(it, torch.Tensor):
            if it.dim() == 4:
                return it.clone()
            if it.dim() == 3:
                return it.unsqueeze(0).clone()
        return it

    def _to_list(self, images):
        # 统一为「元素是 4 维单张图 [1,H,W,C]」的列表
        if isinstance(images, torch.Tensor):
            if images.dim() == 4:
                # batch [N,H,W,C]：按行拆成单张
                return [self._to_4d(torch.unbind(images, dim=0)[i]) for i in range(images.shape[0])]
            return [self._to_4d(images)]
        if isinstance(images, (list, tuple)):
            # 展平一层，兼容 [[...]] 双重包裹；元素可能是 4D(单张或小 batch)/3D
            out = []
            for it in images:
                if it is None:
                    continue
                if isinstance(it, torch.Tensor) and it.dim() == 4 and it.shape[0] > 1:
                    for i in range(it.shape[0]):
                        out.append(self._to_4d(torch.unbind(it, dim=0)[i]))
                else:
                    out.append(self._to_4d(it))
            return out
        return [self._to_4d(images)]

    def get_image(self, images, index, length):
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

        all_imgs = self._to_list(images)
        if len(all_imgs) == 0:
            raise ValueError("图像列表为空，无法从列表中取图")

        # 负数索引：从末尾倒数；越界自动钳制
        if idx < 0:
            idx = len(all_imgs) + idx
        start = max(0, min(idx, len(all_imgs) - 1))
        end = start + length

        # 单张/多张统一返回 list：保证 OUTPUT_IS_LIST=True 下 extend() 行为一致，
        # 不会把单个 tensor 沿第一维误拆成三维切片，从而造成"无数 3px 小图"。
        _out = all_imgs[start:end]
        if len(_out) <= 0:
            _out = [all_imgs[start]]
        return (_out,)


NODE_CLASS_MAPPINGS = {
    "XiaozhuguangImageFromList": XiaozhuguangImageFromList,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XiaozhuguangImageFromList": "小珠光从列表获取图像",
}

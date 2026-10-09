class XiaozhuguangImageSize:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像或遮罩": ("IMAGE,MASK",),
            },
        }

    RETURN_TYPES = ("INT", "INT", "INT", "INT", "STRING")
    RETURN_NAMES = ("宽度", "高度", "长边", "短边", "分辨率")
    OUTPUT_IS_LIST = (True, True, True, True, True)
    FUNCTION = "execute"
    CATEGORY = "小珠光/图片"
    DESCRIPTION = (
        "获取图像尺寸或遮罩非零区域的外接矩形尺寸（裁掉空白边缘）。"
        "同一接口可连接图像或遮罩，自动识别。"
        "分辨率格式为宽×高；全黑遮罩返回0×0。批次逐张输出。"
    )

    def execute(self, 图像或遮罩):
        sizes = []
        if 图像或遮罩.dim() in (2, 3):
            遮罩 = 图像或遮罩
            if 遮罩.dim() == 2:
                遮罩 = 遮罩.unsqueeze(0)
            for mask in 遮罩:
                active = mask > 0
                rows = active.any(dim=1).nonzero(as_tuple=True)[0]
                columns = active.any(dim=0).nonzero(as_tuple=True)[0]
                if rows.numel() == 0:
                    sizes.append((0, 0))
                else:
                    width = int((columns[-1] - columns[0]).item()) + 1
                    height = int((rows[-1] - rows[0]).item()) + 1
                    sizes.append((width, height))
        elif 图像或遮罩.dim() == 4:
            batch, height, width, _ = 图像或遮罩.shape
            sizes = [(int(width), int(height))] * batch
        else:
            raise ValueError("请输入 IMAGE [批次, 高度, 宽度, 通道] 或 MASK [批次, 高度, 宽度]。")

        return (
            [w for w, h in sizes],
            [h for w, h in sizes],
            [max(w, h) for w, h in sizes],
            [min(w, h) for w, h in sizes],
            [f"{w}×{h}" for w, h in sizes],
        )

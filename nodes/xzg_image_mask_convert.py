class XiaozhuguangImageMaskConvert:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "channel": (["灰度亮度", "红通道", "绿通道", "蓝通道"], {
                    "default": "灰度亮度",
                    "tooltip": "灰度亮度：将RGB按亮度加权转换为遮罩；也可单独提取红、绿、蓝通道。仅影响图像转遮罩。",
                }),
                "binarize": ("BOOLEAN", {"default": False, "tooltip": "开启后，图像转遮罩时按阈值输出纯黑白遮罩；关闭时保留灰度。仅影响图像转遮罩。"}),
                "threshold": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": "二值化阈值（0-1）。像素值大于等于阈值输出1，否则输出0。"}),
            },
            # source 为可选输入：未连接时不触发内核校验报错（Required input is missing），
            # execute 收到 None 直接输出空值
            "optional": {
                "source": ("IMAGE,MASK", {"tooltip": "连接图像时输出遮罩；连接遮罩时输出 RGB 灰度图像。未连接时输出空值，不报错。"}),
            },
        }

    RETURN_TYPES = ("IMAGE,MASK",)
    RETURN_NAMES = ("输出",)
    FUNCTION = "execute"
    CATEGORY = "小珠光/图片"
    DESCRIPTION = "一个输入、一个输出，自动识别图像或遮罩并转换为另一种类型，支持批量。通道与二值化选项仅影响图像转遮罩。未连接输入时输出空值，不报错。"

    @classmethod
    def VALIDATE_INPUTS(cls, channel):
        if channel not in ("灰度亮度", "红通道", "绿通道", "蓝通道", "luminance", "red", "green", "blue"):
            return "未知的图像转遮罩通道。"
        return True

    def execute(self, source, channel="灰度亮度", binarize=False, threshold=0.5):
        channel = {"灰度亮度": "luminance", "红通道": "red", "绿通道": "green", "蓝通道": "blue"}.get(channel, channel)
        if source is None:
            return (None,)
        if source.ndim == 4:
            image = source
            if image.shape[-1] not in (1, 3, 4):
                raise ValueError("图像需要 [批次, 高, 宽, 通道] 格式，支持灰度、RGB 或 RGBA。")
            if image.shape[-1] == 1:
                output_mask = image[..., 0]
            elif channel == "luminance":
                output_mask = (image[..., :3] * image.new_tensor([0.299, 0.587, 0.114])).sum(dim=-1)
            else:
                output_mask = image[..., {"red": 0, "green": 1, "blue": 2}[channel]]
            if binarize:
                output_mask = (output_mask >= float(threshold)).to(output_mask.dtype)
            return (output_mask,)
        if source.ndim in (2, 3):
            mask = source
            if mask.ndim == 2:
                mask = mask.unsqueeze(0)
            output_image = mask.unsqueeze(-1).repeat(1, 1, 1, 3)
            return (output_image,)
        raise ValueError("输入需要 IMAGE [批次, 高, 宽, 通道] 或 MASK [批次, 高, 宽] / [高, 宽] 格式。")

class XiaozhuguangImageMaskConvert:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "channel": (["灰度亮度", "红通道", "绿通道", "蓝通道"], {
                    "default": "灰度亮度",
                    "tooltip": "灰度亮度：将RGB按亮度加权转换为遮罩；也可单独提取红、绿、蓝通道。仅影响图像转遮罩。",
                }),
            },
            "optional": {
                "image": ("IMAGE", {"tooltip": "转换为遮罩；无输入时遮罩输出为 None。"}),
                "mask": ("MASK", {"tooltip": "转换为RGB灰度图像；无输入时图像输出为 None。"}),
            },
        }

    RETURN_TYPES = ("MASK", "IMAGE")
    RETURN_NAMES = ("mask", "image")
    FUNCTION = "execute"
    CATEGORY = "小珠光/图片"
    DESCRIPTION = "图像与遮罩双向独立转换，支持批量。缺少对应输入时返回 None，与小珠光数据阻断一致。"

    @classmethod
    def VALIDATE_INPUTS(cls, channel):
        if channel not in ("灰度亮度", "红通道", "绿通道", "蓝通道", "luminance", "red", "green", "blue"):
            return "未知的图像转遮罩通道。"
        return True

    def execute(self, channel="灰度亮度", image=None, mask=None):
        channel = {"灰度亮度": "luminance", "红通道": "red", "绿通道": "green", "蓝通道": "blue"}.get(channel, channel)
        output_image = None
        output_mask = None
        if image is not None and image.numel() > 0:
            if image.ndim == 3:
                image = image.unsqueeze(0)
            if image.ndim != 4 or image.shape[-1] not in (1, 3, 4):
                raise ValueError("图像需要 [批次, 高, 宽, 通道] 格式，支持灰度、RGB 或 RGBA。")
            if image.shape[-1] == 1:
                output_mask = image[..., 0]
            elif channel == "luminance":
                output_mask = (image[..., :3] * image.new_tensor([0.299, 0.587, 0.114])).sum(dim=-1)
            else:
                output_mask = image[..., {"red": 0, "green": 1, "blue": 2}[channel]]
        if mask is not None and mask.numel() > 0:
            if mask.ndim == 4 and mask.shape[-1] == 1:
                mask = mask[..., 0]
            if mask.ndim == 2:
                mask = mask.unsqueeze(0)
            if mask.ndim != 3:
                raise ValueError("遮罩需要 [批次, 高, 宽] 或 [高, 宽] 格式。")
            output_image = mask.unsqueeze(-1).repeat(1, 1, 1, 3)
        return output_mask, output_image

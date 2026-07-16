import torch


class XiaozhuguangFirstLastFrame:
    """
    小珠光首尾帧
    读取批量图片的首帧和尾帧，分别输出
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
            },
        }

    RETURN_TYPES = ("IMAGE", "IMAGE")
    RETURN_NAMES = ("first_frame", "last_frame")
    FUNCTION = "execute"
    CATEGORY = "xiaozhuguang"

    def execute(self, image):
        if image.shape[0] == 0:
            empty = torch.zeros(1, 1, 1, 3, dtype=image.dtype)
            return (empty, empty)

        first_frame = image[0:1]
        last_frame = image[-1:]

        return (first_frame, last_frame)

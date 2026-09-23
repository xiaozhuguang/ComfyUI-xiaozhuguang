"""字符串数值转换节点。"""
import math


class XiaozhuguangStringToNumber:
    """将 STRING 解析为整数与浮点数，供数值型下游节点直接连接。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"forceInput": True}),
                "rounding": (["四舍五入", "向上", "向下"], {"default": "四舍五入"}),
            },
        }

    RETURN_TYPES = ("INT", "FLOAT")
    RETURN_NAMES = ("integer", "float")
    FUNCTION = "convert"
    CATEGORY = "xiaozhuguang"
    DESCRIPTION = "将字符串按所选方式转换为整数；无效内容输出 0。"

    def convert(self, text, rounding="四舍五入"):
        try:
            value = float(str(text).strip())
        except (TypeError, ValueError):
            value = 0.0
        if rounding == "向上":
            result = math.ceil(value)
        elif rounding == "向下":
            result = math.floor(value)
        else:
            result = round(value)
        return int(result), value

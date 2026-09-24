"""字符串数值转换节点。"""
import math


class _XzgTextType(str):
    """通配文本端口，可连接到任意下游输入类型。"""

    def __ne__(self, other):
        return False


_XZG_TEXT_TYPE = _XzgTextType("*")


class XiaozhuguangStringToNumber:
    """将 STRING 同时输出为原文本、整数与浮点数。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"forceInput": True}),
                "rounding": (["四舍五入", "向上", "向下"], {"default": "四舍五入"}),
            },
        }

    RETURN_TYPES = ("INT", "FLOAT", _XZG_TEXT_TYPE)
    RETURN_NAMES = ("integer", "float", "text")
    FUNCTION = "convert"
    CATEGORY = "xiaozhuguang"
    DESCRIPTION = "将字符串按所选方式转换为整数，同时输出浮点数与原文本；无效数值输出 0。"

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
        return int(result), value, str(text)

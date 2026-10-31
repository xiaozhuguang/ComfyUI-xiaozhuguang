"""通用值类型转换节点。"""
import math
import json


class _XzgTextType(str):
    """通配文本端口，可连接到任意下游输入类型。"""

    def __ne__(self, other):
        return False


_XZG_TEXT_TYPE = _XzgTextType("*")


class XiaozhuguangStringToNumber:
    """将任意输入转换为文本、整数、浮点数与字符串。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("*", {"forceInput": True}),
                "rounding": (["四舍五入", "向上", "向下"], {"default": "四舍五入"}),
            },
        }

    RETURN_TYPES = ("INT", "FLOAT", _XZG_TEXT_TYPE, "STRING")
    RETURN_NAMES = ("integer", "float", "text", "string")
    FUNCTION = "convert"
    CATEGORY = "小珠光/逻辑"
    DESCRIPTION = "将任意输入转换为整数、浮点数、文本和字符串；无法解析为数值时整数与浮点输出 0。"

    @staticmethod
    def _to_text(value):
        if isinstance(value, str):
            return value
        if isinstance(value, (int, float, bool)):
            return str(value)
        if hasattr(value, "tolist"):
            value = value.tolist()
        try:
            return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        except (TypeError, ValueError):
            return str(value)

    def convert(self, text, rounding="四舍五入"):
        text_value = self._to_text(text)
        try:
            if isinstance(text, bool):
                value = float(text)
            elif isinstance(text, (int, float)):
                value = float(text)
            else:
                value = float(text_value.strip())
        except (TypeError, ValueError):
            value = 0.0
        if not math.isfinite(value):
            value = 0.0
        if rounding == "向上":
            result = math.ceil(value)
        elif rounding == "向下":
            result = math.floor(value)
        else:
            result = round(value)
        return int(result), value, text_value, text_value

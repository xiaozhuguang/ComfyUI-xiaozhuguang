class AnyType(str):
    def __ne__(self, other):
        return False


class XiaozhuguangDataIsEmpty:
    @classmethod
    def INPUT_TYPES(cls):
        return {"optional": {"输入": (AnyType("*"),)}}

    RETURN_TYPES = ("BOOLEAN",)
    RETURN_NAMES = ("是否为空",)
    INPUT_IS_LIST = True
    FUNCTION = "execute"
    CATEGORY = "小珠光/逻辑"
    DESCRIPTION = "无输入或输入全部为 None 时输出 TRUE，有数据时输出 false。0、false、空字符串均视为有效数据。绕过后仍透传数据时输出 false。"

    def execute(self, 输入=None):
        # Receive the whole execution list, including an empty output list;
        # avoid ComfyUI mapping zero items and skipping this check entirely.
        empty = 输入 is None or (isinstance(输入, (list, tuple)) and all(item is None for item in 输入))
        return (empty,)

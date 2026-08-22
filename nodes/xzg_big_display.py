"""
小珠光大字展示 / Big Display
参考 comfyui-easy-use 的 easy showAnything（展示任何节点），功能对齐但其前端将文字/数字/整数放大显示，
类似小珠光标题的大字效果。
输入：任意类型（文本 / 数字 / 整数 / 列表等），返回 {"ui": {"text": [...]}} 供前端大字渲染。
"""

import json

try:
    from nodes import MAX_RESOLUTION  # 兼容，实际未用
except Exception:
    pass


class AnyType(str):
    """万能类型：允许任意类型输入直接连到 input。"""
    def __ne__(self, __value: object) -> bool:
        return False


any_type = AnyType("*")


class XiaozhuguangBigDisplay:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                "input": (any_type, {}),
            },
        }

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "execute"
    CATEGORY = "xiaozhuguang"
    OUTPUT_NODE = True
    OUTPUT_IS_LIST = ()
    DESCRIPTION = "大字展示：任意输入（文本/数字/整数）转为大字显示在节点上，与 showAnything 同样支持任意类型。"
    IS_CHANGED = True

    def execute(self, input=None):
        values = []
        if input is not None:
            if isinstance(input, (str, int, float, bool)):
                values.append(str(input))
            elif isinstance(input, list) and len(input) <= 60:
                values = [str(x) for x in input]
            else:
                try:
                    values.append(json.dumps(input, indent=4, ensure_ascii=False))
                except Exception:
                    try:
                        values.append(str(input))
                    except Exception:
                        values.append("<unserializable>")
        return {"ui": {"text": values}}
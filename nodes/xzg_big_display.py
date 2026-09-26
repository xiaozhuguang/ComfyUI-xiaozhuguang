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
                "input": (any_type, {"input_is_list": True}),
            },
        }

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "execute"
    CATEGORY = "xiaozhuguang"
    OUTPUT_NODE = True
    OUTPUT_IS_LIST = ()
    INPUT_IS_LIST = (True,)
    DESCRIPTION = "大字展示：任意输入（文本/数字/整数）转为大字显示在节点上，与 showAnything 同样支持任意类型。"
    # 注意：不能用 IS_CHANGED = True（布尔量会被当作函数调用而报 "bool object is not callable"）
    # 且必须接收节点输入（ComfyUI 会把 input 等作为关键字参数传入），始终返回 True 以刷新大字展示
    @classmethod
    def IS_CHANGED(cls, *args, **kwargs):
        return True

    def execute(self, input=None):
        values = []
        inputs = input if isinstance(input, (list, tuple)) else ([] if input is None else [input])
        for item in inputs:
            if item is None:
                continue
            items = item if isinstance(item, (list, tuple)) and len(item) <= 60 else [item]
            for value in items:
                if isinstance(value, (str, int, float, bool)):
                    values.append(str(value))
                else:
                    try:
                        values.append(json.dumps(value, indent=4, ensure_ascii=False))
                    except Exception:
                        try:
                            values.append(str(value))
                        except Exception:
                            values.append("<unserializable>")
        return {"ui": {"text": values}}

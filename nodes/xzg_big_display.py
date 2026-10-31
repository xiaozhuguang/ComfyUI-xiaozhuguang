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
                "input_b": (any_type, {"input_is_list": True}),
            },
        }

    # 带一个「输出」端口把输入原样透传：可以接下游，先显示再继续跑，
    # 不必像纯终端节点那样在链路中间把数据截断
    RETURN_TYPES = (any_type, any_type)
    RETURN_NAMES = ("A", "B")
    FUNCTION = "execute"
    CATEGORY = "小珠光/其他"
    OUTPUT_NODE = True
    # 必须与 RETURN_TYPES 等长：留空元组时部分内核会按 RETURN_TYPES 下标取用而越界（IndexError）
    OUTPUT_IS_LIST = (False, False)
    INPUT_IS_LIST = (True,)
    DESCRIPTION = "A/B 两路可选输入，默认显示 A，双击切换显示；只接一路时显示该路。A/B 输出分别原样透传，不受显示切换影响。"
    # 注意：不能用 IS_CHANGED = True（布尔量会被当作函数调用而报 "bool object is not callable"）
    # 且必须接收节点输入（ComfyUI 会把 input 等作为关键字参数传入），始终返回 True 以刷新大字展示
    @classmethod
    def IS_CHANGED(cls, *args, **kwargs):
        return True

    def execute(self, input=None, input_b=None):
        text_a, output_a = self._format_input(input)
        text_b, output_b = self._format_input(input_b)
        return {"ui": {"text": text_a if input is not None else text_b,
                       "text_a": text_a, "text_b": text_b,
                       "connected_a": [input is not None], "connected_b": [input_b is not None]},
                "result": (output_a, output_b)}

    @staticmethod
    def _format_input(input):
        values = []
        inputs = input if isinstance(input, (list, tuple)) else ([] if input is None else [input])
        # 透传输出：INPUT_IS_LIST 会把单个输入包成列表，这里解包，让下游拿到的就是原对象；
        # 空列表（未接线）输出 None，避免下游对空结果取下标越界
        passthrough = input
        if isinstance(input, (list, tuple)):
            if len(input) == 1:
                passthrough = input[0]
            elif not input:
                passthrough = None
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
        return values, passthrough

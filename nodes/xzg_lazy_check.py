class AnyType(str):
    """用于表示任意类型的特殊类，在类型比较时总是返回相等"""
    def __eq__(self, _) -> bool:
        return True

    def __ne__(self, __value: object) -> bool:
        return False


any = AnyType("*")


class XiaozhuguangInputLazyCheck:
    """小珠光输入惰性判断
    输入A有内容则输出A（B之前的工作流不计算），输入A无内容则输出B。
    A 为非惰性输入（始终求值），B 为惰性输入（仅当 A 为空时才求值）。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                "A": (any, {"input_is_list": True}),
                "B": (any, {"lazy": True, "input_is_list": True}),
            }
        }

    RETURN_TYPES = (any, "BOOLEAN")
    RETURN_NAMES = ("输出", "判断")
    # 整组接收上游列表；透传口维持原列表，判断口固定输出一个布尔值。
    INPUT_IS_LIST = (True, True)
    OUTPUT_IS_LIST = (True, True)
    FUNCTION = "execute"
    CATEGORY = "xiaozhuguang"
    DESCRIPTION = "输入A有内容则输出A（跳过B的计算），输入A无内容则输出B。批次/列表整体透传；判断口每次只输出一个值：输出A时为false，输出B时为true。"

    @staticmethod
    def _has_value(value):
        if value is None:
            return False
        if isinstance(value, (list, tuple)):
            for item in value:
                if item is not None:
                    return True
            return False
        return True

    @staticmethod
    def _as_output_list(value):
        if value is None:
            return []
        return list(value) if isinstance(value, (list, tuple)) else [value]

    def check_lazy_status(self, A=None, B=None):
        # 一次检查整个 A 列表；仅当 A 没有任何有效项时请求惰性输入 B。
        if not self._has_value(A) and B is None:
            return ["B"]
        return None

    def execute(self, A=None, B=None):
        use_a = self._has_value(A)
        selected = A if use_a else B
        # 判断输出声明为 list，确保即使透传多张图，结果仍只有一个布尔项。
        return (self._as_output_list(selected), [not use_a])

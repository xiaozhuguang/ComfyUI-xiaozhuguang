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
                "A": (any,),
                "B": (any, {"lazy": True}),
            }
        }

    RETURN_TYPES = (any,)
    RETURN_NAMES = ("输出",)
    FUNCTION = "execute"
    CATEGORY = "xiaozhuguang"
    DESCRIPTION = "输入A有内容则输出A（跳过B的计算），输入A无内容则输出B。B为惰性输入，仅当A为空时才计算B的上游工作流。"

    def check_lazy_status(self, A=None, B=None):
        # A 为非惰性，始终已求值
        # A 有内容时不需要 B，直接执行
        # A 为空（None）时才请求 B
        result = []
        if A is None and B is None:
            result.append("B")
        return result if result else None

    def execute(self, A=None, B=None):
        if A is not None:
            return (A,)
        else:
            return (B,)

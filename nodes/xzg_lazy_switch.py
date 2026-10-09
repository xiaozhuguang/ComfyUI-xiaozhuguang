"""小珠光单路惰性开关。"""


class _LazySwitchAnyType(str):
    """允许惰性开关的输入和输出连接任意类型。"""

    def __ne__(self, other):
        return False


_LAZY_SWITCH_ANY = _LazySwitchAnyType("*")


class XiaozhuguangLazySwitch:
    """按布尔值选择一路输入，并只计算被选中分支。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "boolean": ("BOOLEAN", {"default": True}),
                "ON_TRUE": (_LAZY_SWITCH_ANY, {"lazy": True}),
                "ON_FALSE": (_LAZY_SWITCH_ANY, {"lazy": True}),
            }
        }

    RETURN_TYPES = (_LAZY_SWITCH_ANY,)
    RETURN_NAMES = ("OUTPUT",)
    FUNCTION = "switch"
    CATEGORY = "小珠光/逻辑"

    def check_lazy_status(self, boolean, ON_TRUE=None, ON_FALSE=None):
        if boolean:
            return ["ON_TRUE"] if ON_TRUE is None else None
        return ["ON_FALSE"] if ON_FALSE is None else None

    def switch(self, boolean, ON_TRUE=None, ON_FALSE=None):
        return (ON_TRUE if boolean else ON_FALSE,)


NODE_CLASS_MAPPINGS = {
    "XiaozhuguangLazySwitch": XiaozhuguangLazySwitch,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XiaozhuguangLazySwitch": "小珠光惰性开关",
}

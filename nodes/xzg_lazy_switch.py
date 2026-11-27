"""小珠光单路和双路惰性开关。"""

from comfy_api.latest import io


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


class XiaozhuguangLazySwitch2way(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="XiaozhuguangLazySwitch2way",
            display_name="小珠光惰性开关-双路",
            category=XiaozhuguangLazySwitch.CATEGORY,
            inputs=[
                io.Boolean.Input("boolean", default=True),
                io.AnyType.Input("ON_TRUE", lazy=True),
                io.AnyType.Input("on_true", lazy=True),
                io.AnyType.Input("ON_FALSE", lazy=True),
                io.AnyType.Input("on_false", lazy=True),
            ],
            outputs=[io.AnyType.Output("OUTPUT"), io.AnyType.Output("output")],
        )

    @classmethod
    def check_lazy_status(cls, boolean, ON_TRUE=None, on_true=None, ON_FALSE=None, on_false=None):
        selected = (("ON_TRUE", ON_TRUE), ("on_true", on_true)) if boolean else (
            ("ON_FALSE", ON_FALSE), ("on_false", on_false)
        )
        return [name for name, value in selected if value is None]

    @classmethod
    def execute(cls, boolean, ON_TRUE=None, on_true=None, ON_FALSE=None, on_false=None):
        return io.NodeOutput(ON_TRUE, on_true) if boolean else io.NodeOutput(ON_FALSE, on_false)


NODE_CLASS_MAPPINGS = {
    "XiaozhuguangLazySwitch": XiaozhuguangLazySwitch,
    "XiaozhuguangLazySwitch2way": XiaozhuguangLazySwitch2way,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XiaozhuguangLazySwitch": "小珠光惰性开关",
    "XiaozhuguangLazySwitch2way": "小珠光惰性开关-双路",
}

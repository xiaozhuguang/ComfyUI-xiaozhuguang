class XiaozhuguangSelector:
    """
    小珠光标签选择器
    通过点击按钮选择标签，输出对应的整数值
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "标签": ("STRING", {"default": "0"}),
                "_xz_settings": ("STRING", {"default": "", "multiline": True}),
            },
        }

    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("数值",)
    FUNCTION = "select"
    CATEGORY = "小珠光"

    def select(self, 标签, _xz_settings=""):
        try:
            val = int(标签)
            return (val,)
        except (ValueError, TypeError):
            return (0,)




class XiaozhuguangTitle:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    OUTPUT_NODE = False
    FUNCTION = "execute"
    CATEGORY = "小珠光"

    def execute(self):
        return ()


class XiaozhuguangNumberSwitch:
    """
    小珠光编号切换
    通过选择器在多个任意类型数据之间切换输出
    选择器 0-49 对应输入口 值0~值49
    """

    @classmethod
    def INPUT_TYPES(cls):
        optional = {}
        for i in range(50):
            optional[f"值{i}"] = ("*", {})
        return {
            "required": {
                "选择": ("INT", {"default": 0, "min": 0, "max": 49, "step": 1, "display": "number", "forceInput": True}),
            },
            "optional": optional,
        }

    RETURN_TYPES = ("*",)
    RETURN_NAMES = ("输出",)
    FUNCTION = "switch"
    CATEGORY = "小珠光"

    def switch(self, 选择, **kwargs):
        选择 = min(max(选择, 0), 49)
        val = kwargs.get(f"值{选择}")
        return (val,)




class AnyType(str):
    def __ne__(self, __value: object) -> bool:
        return False

any_type = AnyType("*")


class XiaozhuguangUniversalSlider:
    """
    小珠光万能滑条
    支持浮点 / 整数双模式切换，右键切换类型
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "值": ("FLOAT", {
                    "default": 0.50,
                    "min": -999999,
                    "max": 999999,
                    "step": 0.01,
                    "display": "slider",
                }),
            },
            "hidden": {
                "output_type": (["float", "int"], {"default": "float"}),
            },
        }

    RETURN_TYPES = (any_type,)
    RETURN_NAMES = ("*",)
    FUNCTION = "execute"
    CATEGORY = "小珠光"

    def execute(self, 值, output_type="float"):
        processed_value = round(float(值), 10)
        if output_type == "int":
            return (int(round(processed_value)),)
        else:
            return (processed_value,)

    @classmethod
    def IS_CHANGED(cls, 值, output_type="float"):
        processed_value = round(float(值), 10)
        if output_type == "int":
            return int(round(processed_value))
        return processed_value


NODE_CLASS_MAPPINGS = {
    "XiaozhuguangSelector": XiaozhuguangSelector,
    "XiaozhuguangTitle": XiaozhuguangTitle,
    "XiaozhuguangNumberSwitch": XiaozhuguangNumberSwitch,
    "XiaozhuguangUniversalSlider": XiaozhuguangUniversalSlider,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XiaozhuguangSelector": "小珠光选择器",
    "XiaozhuguangTitle": "小珠光标题",
    "XiaozhuguangNumberSwitch": "小珠光编号切换",
    "XiaozhuguangUniversalSlider": "小珠光万能滑条",
}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

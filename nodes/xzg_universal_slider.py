"""
Xiaozhuguang Universal Slider
Supports float/int dual mode switching, ultra-wide range native slider
"""

class AnyType(str):
    def __ne__(self, __value: object) -> bool:
        return False

any_type = AnyType("*")


class XiaozhuguangUniversalSlider:

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "value": ("FLOAT", {
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
    RETURN_NAMES = ("output",)
    FUNCTION = "execute"
    CATEGORY = "xiaozhuguang"

    def execute(self, value, output_type="float"):
        processed_value = round(float(value), 10)
        if output_type == "int":
            return (int(round(processed_value)),)
        else:
            return (processed_value,)

    @classmethod
    def IS_CHANGED(cls, value, output_type="float"):
        processed_value = round(float(value), 10)
        if output_type == "int":
            return int(round(processed_value))
        return processed_value


NODE_CLASS_MAPPINGS = {
    "XiaozhuguangUniversalSlider": XiaozhuguangUniversalSlider,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XiaozhuguangUniversalSlider": "Xiaozhuguang Universal Slider",
}

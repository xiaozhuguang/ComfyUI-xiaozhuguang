"""
小珠光获取控件值
连接任意节点的任意输出，获取该节点的所有控件值
"""

import json
import os


class XiaozhuguangGetWidget:
    """
    小珠光获取控件值
    连接目标节点的任意输出，获取该节点的控件值
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                "target_output": ("*", {}),
                "widget_name": ("STRING", {"default": "", "multiline": False, "tooltip": "Leave empty to output all widget values; specify widget_name to output the corresponding value"}),
                "show_widget_prefix": ("BOOLEAN", {"default": True, "tooltip": "Enable to output 'widget_name: value' format, disable to output only the value"}),
                "show_extension": ("BOOLEAN", {"default": True, "tooltip": "Enable to show file extension (e.g., .PNG, .jpg, etc.), disable to remove the extension"}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "dynprompt": "DYNPROMPT",
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("widget_value",)
    FUNCTION = "get_widget"
    CATEGORY = "xiaozhuguang"
    OUTPUT_NODE = False

    @classmethod
    def IS_CHANGED(cls, target_output=None, widget_name="", show_widget_prefix=True, show_extension=True, **kwargs):
        return float("NaN")

    def _format_value(self, val, show_extension=True):
        if isinstance(val, list):
            if len(val) >= 1 and isinstance(val[0], str):
                result = val[0]
            else:
                result = json.dumps(val, ensure_ascii=False)
        elif isinstance(val, dict):
            result = json.dumps(val, ensure_ascii=False)
        else:
            result = str(val)

        if not show_extension:
            base, ext = os.path.splitext(result)
            if ext and len(ext) <= 8 and ext.lower() in ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.mp4', '.avi', '.mov', '.mkv', '.mp3', '.wav', '.flac', '.txt', '.json', '.safetensors', '.ckpt', '.pt', '.pth']:
                result = base

        return result

    def _is_link(self, val):
        if not isinstance(val, list) or len(val) < 2:
            return False
        if not isinstance(val[0], (int, str)):
            return False
        if not isinstance(val[1], int):
            return False
        return True

    def get_widget(self, unique_id, dynprompt, target_output=None, widget_name="", show_widget_prefix=True, show_extension=True):
        current_node = dynprompt.get_node(unique_id)
        current_inputs = current_node.get("inputs", {})

        target_link = current_inputs.get("target_output")
        if target_link is None:
            raise ValueError("请连接目标节点的任意输出到「目标节点输出」输入口")

        if not self._is_link(target_link):
            raise ValueError("请连接目标节点的任意输出到「目标节点输出」输入口")

        target_node_id = target_link[0]

        if not dynprompt.has_node(target_node_id):
            raise KeyError(f"在prompt中找不到节点: {target_node_id}")

        node_data = dynprompt.get_node(target_node_id)
        inputs = node_data.get("inputs", {})

        if widget_name and widget_name.strip():
            name = widget_name.strip()
            if name in inputs:
                val = inputs[name]
                formatted_val = self._format_value(val, show_extension)
                if show_widget_prefix:
                    single_val = f"{name}: {formatted_val}"
                else:
                    single_val = formatted_val
            else:
                available = ", ".join(inputs.keys())
                raise NameError(f"找不到控件「{name}」，可用控件: {available}")
        else:
            items = []
            for k, v in inputs.items():
                formatted_val = self._format_value(v, show_extension)
                if show_widget_prefix:
                    items.append(f"{k}: {formatted_val}")
                else:
                    items.append(formatted_val)
            single_val = "\n".join(items)

        return (single_val,)


NODE_CLASS_MAPPINGS = {
    "XiaozhuguangGetWidget": XiaozhuguangGetWidget,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XiaozhuguangGetWidget": "Xiaozhuguang Get Widget",
}

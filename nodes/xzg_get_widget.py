"""
小珠光获取控件值
连接任意节点的任意输出，获取该节点的所有控件值
"""

import json
import os

try:
    from nodes import NODE_CLASS_MAPPINGS as _NODE_CLASS_MAPPINGS
except Exception:
    _NODE_CLASS_MAPPINGS = None


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

    def _lookup_default_input(self, class_type, name):
        """从目标节点定义（INPUT_TYPES）读取控件的默认值兜底。

        场景：首次执行时，目标节点的某个输入（如 WanAnimatePlus LoraSelectMulti 的 model）
        因上游不在「获取控件值」节点可达链被 ComfyUI 的 prompt 剪枝移除，导致 dynprompt
        inputs 里缺失；而控件本身在节点定义中存在且有默认值。此时用默认值兜底输出，避免
        首次执行误报「找不到控件」，重跑后目标节点补全即读到真实值。
        返回 (默认值, 是否找到默认值)。
        """
        if not _NODE_CLASS_MAPPINGS:
            return None, False
        cls = _NODE_CLASS_MAPPINGS.get(class_type)
        if cls is None:
            return None, False
        try:
            it = cls.INPUT_TYPES() if callable(getattr(cls, "INPUT_TYPES", None)) else None
        except Exception:
            return None, False
        if not isinstance(it, dict):
            return None, False
        spec = None
        for group in ("required", "optional"):
            g = it.get(group, {})
            if isinstance(g, dict) and name in g:
                spec = g[name]
                break
        if spec is None:
            return None, False
        if isinstance(spec, (list, tuple)) and len(spec) >= 2 and isinstance(spec[1], dict) and "default" in spec[1]:
            return spec[1]["default"], True
        return None, False

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
                # 首次执行常见的 input 被 prompt 剪枝场景：控件在节点定义中存在且有默认值，
                # 用默认值兜底输出，避免误报；重跑后读到真实值。
                class_type = node_data.get("class_type") or ""
                default_val, has_default = self._lookup_default_input(class_type, name)
                if has_default:
                    formatted_val = self._format_value(default_val, show_extension)
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

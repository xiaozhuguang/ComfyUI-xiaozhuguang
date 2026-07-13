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
                "目标节点输出": ("*", {}),
                "控件名": ("STRING", {"default": "", "multiline": False, "tooltip": "留空输出全部控件值；指定控件名则输出对应的值"}),
                "显示控件名前缀": ("BOOLEAN", {"default": True, "tooltip": "开启则输出「控件名: 值」格式，关闭则只输出值"}),
                "显示文件扩展名": ("BOOLEAN", {"default": True, "tooltip": "开启则显示文件扩展名（如 .PNG、.jpg 等），关闭则去掉扩展名"}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "dynprompt": "DYNPROMPT",
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("控件值",)
    FUNCTION = "get_widget"
    CATEGORY = "小珠光"
    OUTPUT_NODE = False

    @classmethod
    def IS_CHANGED(cls, 目标节点输出=None, 控件名="", 显示控件名前缀=True, 显示文件扩展名=True, **kwargs):
        return float("NaN")

    def _format_value(self, val, 显示文件扩展名=True):
        if isinstance(val, list):
            if len(val) >= 1 and isinstance(val[0], str):
                result = val[0]
            else:
                result = json.dumps(val, ensure_ascii=False)
        elif isinstance(val, dict):
            result = json.dumps(val, ensure_ascii=False)
        else:
            result = str(val)

        if not 显示文件扩展名:
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

    def get_widget(self, unique_id, dynprompt, 目标节点输出=None, 控件名="", 显示控件名前缀=True, 显示文件扩展名=True):
        current_node = dynprompt.get_node(unique_id)
        current_inputs = current_node.get("inputs", {})

        target_link = current_inputs.get("目标节点输出")
        if target_link is None:
            raise ValueError("请连接目标节点的任意输出到「目标节点输出」输入口")

        if not self._is_link(target_link):
            raise ValueError("请连接目标节点的任意输出到「目标节点输出」输入口")

        target_node_id = target_link[0]

        if not dynprompt.has_node(target_node_id):
            raise KeyError(f"在prompt中找不到节点: {target_node_id}")

        node_data = dynprompt.get_node(target_node_id)
        inputs = node_data.get("inputs", {})

        if 控件名 and 控件名.strip():
            name = 控件名.strip()
            if name in inputs:
                val = inputs[name]
                formatted_val = self._format_value(val, 显示文件扩展名)
                if 显示控件名前缀:
                    single_val = f"{name}: {formatted_val}"
                else:
                    single_val = formatted_val
            else:
                available = ", ".join(inputs.keys())
                raise NameError(f"找不到控件「{name}」，可用控件: {available}")
        else:
            items = []
            for k, v in inputs.items():
                formatted_val = self._format_value(v, 显示文件扩展名)
                if 显示控件名前缀:
                    items.append(f"{k}: {formatted_val}")
                else:
                    items.append(formatted_val)
            single_val = "\n".join(items)

        return (single_val,)


NODE_CLASS_MAPPINGS = {
    "XiaozhuguangGetWidget": XiaozhuguangGetWidget,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XiaozhuguangGetWidget": "小珠光获取控件值",
}

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
                "extra_pnginfo": "EXTRA_PNGINFO",
                "prompt": "PROMPT",
                "unique_id": "UNIQUE_ID",
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

    def get_widget(self, extra_pnginfo, prompt, unique_id, 目标节点输出=None, 控件名="", 显示控件名前缀=True, 显示文件扩展名=True):
        workflow = extra_pnginfo.get("workflow", {})
        all_nodes = workflow.get("nodes", [])

        definitions = workflow.get("definitions", {})
        subgraphs = definitions.get("subgraphs", [])

        subgraph_id_to_parent = {}
        for node in all_nodes:
            node_type = node.get("type", "")
            if "-" in node_type and len(node_type) == 36:
                subgraph_id_to_parent[node_type] = node["id"]

        node_to_subgraph_map = {}
        link_to_node_map = {}
        extended_nodes = list(all_nodes)

        for subgraph in subgraphs:
            subgraph_id = subgraph.get("id", "")
            parent_node_id = subgraph_id_to_parent.get(subgraph_id)
            subgraph_nodes = subgraph.get("nodes", [])
            for node in subgraph_nodes:
                if parent_node_id is not None:
                    node_to_subgraph_map[node["id"]] = parent_node_id
            extended_nodes.extend(subgraph_nodes)

            subgraph_links = subgraph.get("links", [])
            for link in subgraph_links:
                if isinstance(link, dict):
                    link_to_node_map[link["id"]] = link["origin_id"]
                elif isinstance(link, list) and len(link) >= 2:
                    link_to_node_map[link[0]] = link[1]

        if isinstance(unique_id, str) and ":" in unique_id:
            unique_id_int = int(unique_id.split(":")[-1])
            subgraph_prefix = ":".join(unique_id.split(":")[:-1])
        else:
            unique_id_int = int(unique_id)
            subgraph_prefix = None

        target_link_id = None
        for node in extended_nodes:
            if node["type"] == "XiaozhuguangGetWidget" and node["id"] == unique_id_int:
                node_inputs = node.get("inputs", [])
                for inp in node_inputs:
                    if inp["name"] == "目标节点输出":
                        target_link_id = inp.get("link")
                        break

            node_outputs = node.get("outputs", [])
            if not node_outputs:
                continue
            for output in node_outputs:
                node_links = output.get("links", [])
                if not node_links:
                    continue
                for link in node_links:
                    link_to_node_map[link] = node["id"]

        if target_link_id is None:
            raise ValueError("请连接目标节点的任意输出到「目标节点输出」输入口")

        target_node_id = link_to_node_map.get(target_link_id)
        if target_node_id is None:
            raise ValueError("无法找到目标节点，请确保连线正确")

        target_subgraph_parent = node_to_subgraph_map.get(target_node_id)
        if target_subgraph_parent is not None:
            prompt_key = f"{target_subgraph_parent}:{target_node_id}"
        elif subgraph_prefix is not None:
            prompt_key = f"{subgraph_prefix}:{target_node_id}"
        else:
            prompt_key = str(target_node_id)

        if prompt_key not in prompt:
            prompt_key = str(target_node_id)

        if prompt_key not in prompt:
            raise KeyError(f"在prompt中找不到节点: {prompt_key}")

        node_data = prompt[prompt_key]
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

class AnyType(str):
    """用于表示任意类型的特殊类，在类型比较时总是返回相等"""
    def __eq__(self, _) -> bool:
        return True

    def __ne__(self, __value: object) -> bool:
        return False


any = AnyType("*")


class XiaozhuguangListCount:
    """小珠光列表计数
    计算输入列表的元素总数，常用于小珠光图像加载器「列表」模式等多元素输出。
    通过 INPUT_IS_LIST 一次性接收整个列表（不会被执行引擎逐元素展开）。
    特殊兼容：若列表恰为单个批处理张量（如加载器「批次」模式的输出 [batch]），
    则按批次大小统计，保证"总数=图片张数"的直觉。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "列表": (any, {"input_is_list": True}),
            },
        }

    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("数量",)
    FUNCTION = "count"
    CATEGORY = "xiaozhuguang"
    INPUT_IS_LIST = (True,)
    DESCRIPTION = "计算输入列表的元素总数：列表取 len()；单个批处理张量按 batch 维统计；字典/其它容器取长度。"

    def count(self, 列表):
        if 列表 is None:
            return (0,)

        if isinstance(列表, (list, tuple)):
            # 特殊兼容：批次模式加载器返回 [batch]（单元素列表包着一个多帧张量），按批次大小统计
            if len(列表) == 1 and hasattr(列表[0], "shape") and getattr(列表[0], "shape", (0,))[0] > 1:
                return (int(列表[0].shape[0]),)
            return (len(列表),)

        if hasattr(列表, "shape"):
            return (int(列表.shape[0]),)

        if isinstance(列表, dict):
            return (len(列表),)

        return (1,)


NODE_CLASS_MAPPINGS = {
    "XiaozhuguangListCount": XiaozhuguangListCount,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XiaozhuguangListCount": "小珠光列表总数",
}

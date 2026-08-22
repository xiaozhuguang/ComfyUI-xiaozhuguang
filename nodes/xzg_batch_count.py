class AnyType(str):
    """用于表示任意类型的特殊类，在类型比较时总是返回相等"""
    def __eq__(self, _) -> bool:
        return True

    def __ne__(self, __value: object) -> bool:
        return False


any = AnyType("*")


class XiaozhuguangBatchCount:
    """小珠光批次计数
    完全参考 comfyui_essentials 的 🔧 Batch Count（BatchCount+）：
    计算输入批次中元素的数量。输入可以是任意类型：
      - 张量（ndarray / torch.Tensor）：取 shape[0]（batch 维）
      - 列表 / 字典：取 len()
    常用于条件逻辑、调试、按批次大小动态调整下游处理。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "批次": (any,),
            }
        }

    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("整数",)
    FUNCTION = "execute"
    CATEGORY = "xiaozhuguang"
    DESCRIPTION = "计算输入批次中元素的数量：张量取形状 batch 维 size；LATENT 字典取 samples 张量的 batch 维；列表/字典取长度。完全参考 comfyui_essentials 的 Batch Count 节点。"

    def execute(self, 批次):
        count = 0
        if hasattr(批次, "shape"):
            count = int(批次.shape[0])
        elif isinstance(批次, dict) and "samples" in 批次:
            count = int(批次["samples"].shape[0])
        elif isinstance(批次, (list, dict)):
            count = len(批次)
        return (count,)

    @classmethod
    def IS_CHANGED(cls, 批次):
        # 批次内容变化即重新计算（返回序列化指纹，避免惰性缓存）
        try:
            import hashlib
            import torch
            if isinstance(批次, torch.Tensor):
                return hashlib.sha256(批次.numpy().tobytes()).hexdigest()
        except Exception:
            pass
        return repr(getattr(批次, "shape", None)) + str(len(批次) if isinstance(批次, (list, dict)) else "")
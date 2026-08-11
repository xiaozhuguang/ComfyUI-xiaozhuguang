"""小珠光随机种子节点 - 使用 ComfyUI 原生 control_after_generate 机制，
额外提供单次随机按钮和历史种子记录。"""


class XiaozhuguangSeed:
    """小珠光随机种子 - 模仿 rgthree 和官方种子节点，带历史种子记录。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "seed": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": 0xffffffffffffffff,
                    "step": 1,
                }),
            },
        }

    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("SEED",)
    FUNCTION = "execute"
    CATEGORY = "xiaozhuguang"
    OUTPUT_NODE = True

    def execute(self, seed):
        return (seed,)

class AnyType(str):
    """用于表示任意类型的特殊类，在类型比较时总是返回相等"""
    def __eq__(self, _) -> bool:
        return True

    def __ne__(self, __value: object) -> bool:
        return False

    def __hash__(self) -> int:
        return hash(str(self))


any = AnyType("*")


class XiaozhuguangBypassCheck:
    """小珠光绕过判断
    检测「输入」插槽所连接的上游节点是否为绕过(bypass)状态。
    只输出一个布尔：true=已绕过，false=开启。不透传上游数据。

    注意：绕过状态是前端画布状态（node.mode===4），后端无法从数据值推断。
    因此由前端在提交(grapToPrompt)时读取上游节点状态，注入隐藏参数
    bypass_status 回传给本节点执行。
    「输入」仅用于前端确定检测对象，声明为 lazy 且所有情况下不求值，
    避免连接重型节点时触发无谓计算。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                # 用于前端定位"要检测的上游节点"，lazy 属性保证运行时不求值
                "输入": (any, {"lazy": True}),
                # 前端注入的检测结果，非暴露插槽，仅当作普通可选输入传入
                "bypass_status": ("BOOLEAN", {"default": False}),
            }
        }

    RETURN_TYPES = ("BOOLEAN",)
    RETURN_NAMES = ("判断",)
    FUNCTION = "execute"
    CATEGORY = "xiaozhuguang"
    DESCRIPTION = "检测「输入」所连接的上游节点是否为绕过状态。返回 true=已绕过，false=开启。上游绕过检测由前端提交时完成并注入，本节点自身始终执行。"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # 保证每次运行都重新执行，避免结果被缓存成常 false
        return float("NaN")

    def check_lazy_status(self, 输入=None, bypass_status=False):
        # 「输入」永远不需要求值——本节点只看 bypass_status，不消费上游数据
        return []

    def execute(self, 输入=None, bypass_status=False):
        print(f"[小珠光]绕过判断 execute: bypass_status={bypass_status!r} (type={type(bypass_status).__name__})")
        return (bool(bypass_status),)
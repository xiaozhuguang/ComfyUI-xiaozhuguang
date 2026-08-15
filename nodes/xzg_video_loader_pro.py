"""
小珠光视频加载-化神级
在「小珠光视频加载器」基础上增加内嵌视频编辑器入口（全屏 Modal）
- 节点逻辑完全复用 XiaozhuguangVideoLoader
- 前端通过 widget 按钮触发编辑器，编辑结果写回 input 目录并切换下拉
"""

from .xzg_video_loader import XiaozhuguangVideoLoader


class XiaozhuguangVideoLoaderPro(XiaozhuguangVideoLoader):
    """
    小珠光视频加载-化神级
    继承自小珠光视频加载器，节点行为完全一致
    仅前端注册名不同，以挂载专属的「视频编辑器」按钮
    """

    CATEGORY = "xiaozhuguang"

    @classmethod
    def INPUT_TYPES(cls):
        # 复用父类配置，但「视频」字段默认为空（与普通版区分：新建节点不预选视频）
        types = super().INPUT_TYPES()
        required = dict(types.get("required", {}))
        # 把视频下拉的第一个值替换为空字符串占位，作为默认值
        video_entry = required.get("视频")
        if isinstance(video_entry, tuple) and len(video_entry) >= 1:
            required["视频"] = ([""] + list(video_entry[0]),) + tuple(video_entry[1:])
        types["required"] = required
        return types

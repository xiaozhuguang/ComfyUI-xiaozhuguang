"""
小珠光视频信息读取
连接小珠光视频加载器的视频信息输出端口，读取视频的详细信息
参考 VHS Video Info 节点的实现方式
"""

import os


class XiaozhuguangVideoInfoReader:
    """
    小珠光视频信息读取
    连接小珠光视频加载器的视频信息输出端口
    输出原始视频和加载后的帧率、帧数、时长、宽度、高度，以及文件名称
    """

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "视频信息": ("VHS_VIDEOINFO",),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    CATEGORY = "xiaozhuguang"

    RETURN_TYPES = ("FLOAT", "INT", "INT", "INT", "STRING")
    RETURN_NAMES = (
        "加载帧率",
        "加载帧数",
        "加载宽度",
        "加载高度",
        "文件名称",
    )
    FUNCTION = "get_video_info"

    def get_video_info(self, 视频信息, unique_id=None):
        info = 视频信息 or {}
        keys = ["fps", "frame_count", "width", "height"]

        loaded_info = []

        for key in keys:
            loaded_info.append(info.get(f"loaded_{key}", 0))

        filename = str(info.get("filename", ""))
        # 去掉文件扩展名
        filename = os.path.splitext(filename)[0]

        return (*loaded_info, filename)

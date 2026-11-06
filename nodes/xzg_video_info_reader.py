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
                "video_info": ("VHS_VIDEOINFO",),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    CATEGORY = "小珠光/视频"

    RETURN_TYPES = ("FLOAT", "INT", "INT", "INT", "STRING", "INT", "INT")
    RETURN_NAMES = (
        "帧率",
        "帧数",
        "宽度",
        "高度",
        "名称",
        "跳过帧数",
        "索引",
    )
    FUNCTION = "get_video_info"

    # The loader submits xzg_video_index as an input. ComfyUI tracks it, loading
    # parameters and file changes through video_info's upstream cache signature.

    def get_video_info(self, video_info, unique_id=None, prompt=None, extra_pnginfo=None):
        info = video_info or {}
        keys = ["fps", "frame_count", "width", "height"]

        loaded_info = []

        for key in keys:
            loaded_info.append(info.get(f"loaded_{key}", 0))

        # 「帧数」输出真实帧数：加载器开「补帧到」（切点修复对齐）时会把 loaded_frame_count
        # 改成补帧后的数量（末段 76 → 90），下游按时长/帧数计算会被虚增、成片变长。
        # 这里减掉加载器记录的 padded_frame_count，还原本段真实解码到的帧数。
        padded = 0
        try:
            padded = int(info.get("padded_frame_count", 0) or 0)
        except (TypeError, ValueError):
            padded = 0
        if padded > 0:
            try:
                real = int(loaded_info[1] or 0) - padded
            except (TypeError, ValueError):
                real = None
            if real is not None and real >= 0:
                loaded_info[1] = real

        # 跳过帧数：加载器记录的已跳过的帧数（兼容旧版加载器未记录时回退 0）
        skip_frames = info.get("skip_frames", 0)
        try:
            skip_frames = int(skip_frames)
        except (TypeError, ValueError):
            skip_frames = 0

        filename = str(info.get("filename", ""))
        # 去掉文件扩展名
        filename = os.path.splitext(filename)[0]

        index_value = info.get("xzg_video_index", 0)
        if prompt and unique_id is not None:
            link = prompt.get(str(unique_id), {}).get("inputs", {}).get("video_info")
            if isinstance(link, (list, tuple)) and len(link) == 2:
                source = prompt.get(str(link[0]), {})
                if source.get("class_type") == "XiaozhuguangVideoLoaderDaVinci":
                    index_value = source.get("inputs", {}).get("xzg_video_index", 0)
                    if "xzg_video_index" not in source.get("inputs", {}):
                        # Older browser modules submit only the filename. Recover
                        # its position from this task's saved queue, not live UI state.
                        nodes = (extra_pnginfo or {}).get("workflow", {}).get("nodes", [])
                        saved = next((n for n in nodes if str(n.get("id")) == str(link[0])), {})
                        props = saved.get("properties", {})
                        queue = props.get("xzgVideoQueue", [])
                        filename_value = source.get("inputs", {}).get("视频")
                        if props.get("xzgMultiVideo") and filename_value in queue:
                            index_value = queue.index(filename_value)
        try:
            video_index = max(0, int(str(index_value or "0").strip()))
        except (TypeError, ValueError):
            video_index = 0

        return (*loaded_info, filename, skip_frames, video_index)

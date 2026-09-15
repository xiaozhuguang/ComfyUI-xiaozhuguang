# -*- coding: utf-8 -*-
"""
视频水印检测（原独立插件 Comfyui-Video-Watermark-Detection-xzg，已并入小珠光）。

节点：
  - VideoWatermarkDetector        视频水印检测-小珠光（仅手工跟踪模式：
    视窗内逐轨道打关键帧（矩形/多边形），帧间线性插值生成逐帧遮罩）
"""
from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

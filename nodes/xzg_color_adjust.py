# -*- coding: utf-8 -*-
"""
小珠光颜色调整
亮度 / 对比度 / 饱和度 三参数纯张量颜色调整（极速版）：

- 全批次一次算完：整条流水线只有几次逐元素 kernel，无 Python 循环、无 PIL、
  无色彩空间往返，CPU/GPU 均可直接跑，输入输出dtype保持一致。
- 精度：三参数 step 均为 0.01。
- 快速路径：三参数全为默认值时零拷贝原样返回（连 clamp 都不做）。

处理顺序（与主流图像编辑器一致）：亮度 → 对比度 → 饱和度。
  亮度  ：x + brightness            （-1~1，0=不变）
  对比度：(x - 0.5) * contrast + 0.5 （0~3，1=不变）
  饱和度：gray + (x - gray) * saturation，gray = Rec.601 亮度
          （0~3，1=不变，0=纯灰度）
"""
import torch

# Rec.601 亮度权重（图像编辑器通用）
_LUMA = (0.299, 0.587, 0.114)


class XiaozhuguangColorAdjust:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE",),
                "亮度": ("FLOAT", {"default": 0.0, "min": -1.0, "max": 1.0, "step": 0.01,
                                   "tooltip": "亮度偏移：0=不变，正数提亮，负数压暗"}),
                "对比度": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 3.0, "step": 0.01,
                                     "tooltip": "对比度系数：1=不变，>1 增强，<1 降低，0=纯灰"}),
                "饱和度": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 3.0, "step": 0.01,
                                     "tooltip": "饱和度系数：1=不变，>1 增艳，<1 去色，0=纯灰度"}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    FUNCTION = "execute"
    CATEGORY = "xiaozhuguang"
    DESCRIPTION = (
        "颜色调整极速版：亮度/对比度/饱和度（精度 0.01），支持批次图像输入输出。\n"
        "纯张量逐元素运算整批一次算完，无循环无 PIL；三参数全默认时零拷贝直通。"
    )

    def execute(self, 图像, 亮度=0.0, 对比度=1.0, 饱和度=1.0):
        亮度 = float(亮度)
        对比度 = float(对比度)
        饱和度 = float(饱和度)

        # 快速路径：全默认 → 原样返回（零拷贝、零 kernel）
        if 亮度 == 0.0 and 对比度 == 1.0 and 饱和度 == 1.0:
            return (图像,)

        orig_dtype = 图像.dtype
        x = 图像 if 图像.dtype == torch.float32 else 图像.to(torch.float32)

        # 亮度
        if 亮度 != 0.0:
            x = x + 亮度
        # 对比度
        if 对比度 != 1.0:
            x = (x - 0.5) * 对比度 + 0.5
        # 饱和度：gray + (x - gray) * sat（等价 x*(sat) + gray*(1-sat)，少一次乘法）
        if 饱和度 != 1.0:
            r, g, b = x[..., 0:1], x[..., 1:2], x[..., 2:3]
            gray = r * _LUMA[0] + g * _LUMA[1] + b * _LUMA[2]
            x = gray + (x - gray) * 饱和度

        x = x.clamp_(0.0, 1.0)
        return (x.to(orig_dtype),)

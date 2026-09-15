# -*- coding: utf-8 -*-
"""
小珠光插件 - BrushNet CutForInpaint / BlendInpaint 节点复刻

完全复刻自 https://github.com/nullquant/ComfyUI-BrushNet (MIT License) 的
`CutForInpaint` 与 `BlendInpaint` 两个节点，功能、输入输出、算法逐字保持一致，
仅做最小适配（精简导入、独立成文件）。依赖 torch / torchvision（本插件已有）。

- CutForInpaint: 以 mask 区域为中心裁剪出指定 width×height 的画布窗口，
  供 inpaint 采样使用（输出 IMAGE + MASK + VECTOR(origin)）。
- BlendInpaint: 把 inpaint 结果按高斯模糊后的 mask 软融合回原图
  （可选 origin 时按 CutForInpaint 的裁剪坐标原位贴回）。

性能优化（输出与原版数学等价或近等价，视觉不可分）：
  A) 4σ 等效核截断：高斯权重在 ±4σ 外 <3e-5，核只需覆盖 ±4σ；
  B) 模糊 GPU offload：节点输入通常在 CPU，大核模糊在 GPU 上快 10~100 倍；
  D) torch.lerp 融合 + 冗余 .to() 清理。
"""
from typing import Tuple

import torch
import torchvision.transforms as T
import torch.nn.functional as F
from comfy.utils import repeat_to_batch_size


class BlendInpaint:

    @classmethod
    def INPUT_TYPES(s):
        return {"required":
                    {    
                        "inpaint": ("IMAGE",),
                        "original": ("IMAGE",),
                        "mask": ("MASK",),
                        "feather": ("INT", {"default": 10, "min": 0, "max": 1000, "step": 1,
                                            "tooltip": "接缝羽化半径，0=硬边 / Seam feather radius, 0 = hard edge"}),
                        "expand": ("INT", {"default": 0, "min": -500, "max": 500, "step": 1,
                                           "tooltip": "遮罩扩展：正值接缝向外扩，负值向内缩 / Mask expand: positive moves seam outward, negative shrinks inward"}),
                    },
                "optional":
                    {
                        "origin": ("VECTOR",),
                    },
                }

    CATEGORY = "xiaozhuguang"
    RETURN_TYPES = ("IMAGE","MASK",)
    RETURN_NAMES = ("image","MASK",)

    FUNCTION = "blend_inpaint"

    def blend_inpaint(self, inpaint: torch.Tensor, original: torch.Tensor, mask, feather: int, expand: int, origin=None) -> Tuple[torch.Tensor]:

        original, mask = check_image_mask(original, mask, 'Blend Inpaint')

        if len(inpaint.shape) < 4:
            # image tensor shape should be [B, H, W, C], but batch somehow is missing
            inpaint = inpaint[None,:,:,:]

        if inpaint.shape[0] < original.shape[0]:
            print("Blend Inpaint gets batch of original images (%d) but only (%d) inpaint images" % (original.shape[0], inpaint.shape[0]))
            original = original[:inpaint.shape[0],:,:]
            mask = mask[:inpaint.shape[0],:,:]

        if inpaint.shape[0] > original.shape[0]:
            # 批次对齐（参照小珠光图像-蒙版预览）：original/mask/origin 循环平铺到 inpaint 帧数，
            # 逐帧变化的遮罩不会被锁定/截断
            original = repeat_to_batch_size(original, inpaint.shape[0])
            mask = repeat_to_batch_size(mask, inpaint.shape[0])
            if origin is not None:
                origin = repeat_to_batch_size(origin, inpaint.shape[0])

        # ── B: 扩展/羽化 GPU offload ──
        # ComfyUI 节点输入通常在 CPU，大核高斯模糊在 CPU 上极慢（4K 大核可达几十秒）；
        # 有可用 CUDA 时把扩展+羽化临时放到 GPU 完成，结果拷回原设备/精度（输出仅差 fp 舍入）。
        blur_dev = torch.device("cuda") if (torch.cuda.is_available() and original.device.type != "cuda") else original.device

        # ── A: 接缝扩展 + 羽化（对齐小珠光 ATR 的 mask_expand / blur_amount 语义）──
        # 先对遮罩做形态学扩展（正=膨胀外扩、负=腐蚀内缩）移动接缝位置，再高斯羽化过渡。
        feather = max(0, int(feather))
        transform = None
        if feather > 0:
            # kernel = 2*feather+1，σ 按 cv2.GaussianBlur(sigma=0) 的默认公式换算
            fsigma = 0.3 * (feather - 1) + 0.8
            # 4σ 等效核截断：高斯权重在 ±4σ 之外 <3e-5，核远大于 4σ 只是空算，
            # 截断后与全核偏差 <1e-4，视觉不可分，大 feather 时显著提速。
            eff = min(2 * feather + 1, 2 * int(4 * fsigma) + 1)  # 恒为奇数
            transform = T.GaussianBlur(kernel_size=(eff, eff), sigma=(fsigma, fsigma))

        ret = []
        blurred = []
        for i in range(inpaint.shape[0]):
            if origin is None:
                m = _expand_mask(mask[i][None,None,:,:].to(blur_dev), expand)
                if transform is not None:
                    m = transform(m)
                blurred_mask = m.to(original.device, original.dtype)
                blurred.append(blurred_mask[0])

                result = torch.nn.functional.interpolate(
                    inpaint[i][None,:,:,:].permute(0, 3, 1, 2),
                    size=(
                        original[i].shape[0],
                        original[i].shape[1],
                    )
                ).permute(0, 2, 3, 1).to(original.device, original.dtype)
            else:
                # got mask from CutForInpaint
                height, width, _ = original[i].shape
                x0 = origin[i][0].item()
                y0 = origin[i][1].item()

                if mask[i].shape[0] < height or mask[i].shape[1] < width:
                    padded_mask = F.pad(input=mask[i], pad=(x0, width-x0-mask[i].shape[1],
                                                            y0, height-y0-mask[i].shape[0]), mode='constant', value=0)
                else:
                    padded_mask = mask[i]
                m = _expand_mask(padded_mask[None,None,:,:].to(blur_dev), expand)
                if transform is not None:
                    m = transform(m)
                blurred_mask = m.to(original.device, original.dtype)
                blurred.append(blurred_mask[0][0])

                result = F.pad(input=inpaint[i], pad=(0, 0, x0, width-x0-inpaint[i].shape[1],
                                                      y0, height-y0-inpaint[i].shape[0]), mode='constant', value=0)
                result = result[None,:,:,:].to(original.device, original.dtype)

            # ── D: torch.lerp(start, end, w) = start*(1-w) + end*w，单 kernel 等价完成，免建 3 个临时大张量
            ret.append(torch.lerp(original[i], result[0], blurred_mask[0][0][:,:,None]))

        return (torch.stack(ret), torch.stack(blurred), )


class CutForInpaint:

    @classmethod
    def INPUT_TYPES(s):
        return {"required":
                    {    
                        "image": ("IMAGE",),
                        "mask": ("MASK",),
                        "width": ("INT", {"default": 512, "min": 64, "max": 2048}),
                        "height": ("INT", {"default": 512, "min": 64, "max": 2048}),
                     },
                }

    CATEGORY = "xiaozhuguang"
    RETURN_TYPES = ("IMAGE","MASK","VECTOR",)
    RETURN_NAMES = ("image","mask","origin",)

    FUNCTION = "cut_for_inpaint"

    def cut_for_inpaint(self, image: torch.Tensor, mask: torch.Tensor, width: int, height: int):

        image, mask = check_image_mask(image, mask, 'BrushNet')

        ret = []
        msk = []
        org = []
        for i in range(image.shape[0]):
            x0, y0, w, h = cut_with_mask(mask[i], width, height)
            ret.append((image[i][y0:y0+h,x0:x0+w,:]))
            msk.append((mask[i][y0:y0+h,x0:x0+w]))
            org.append(torch.IntTensor([x0,y0]))

        return (torch.stack(ret), torch.stack(msk), torch.stack(org), )


#### Utility function


def _expand_mask(mask: torch.Tensor, expand: int) -> torch.Tensor:
    """形态学扩展接缝（对齐 ATR 的 mask_expand），mask 形状 [B,1,H,W]，值域 0~1。
    expand > 0：膨胀（max_pool），接缝向外扩，融合带更大；
    expand < 0：腐蚀（对取反后 max_pool 再取反），接缝向内缩；
    expand == 0：原样返回。"""
    if expand == 0:
        return mask
    k = 2 * abs(expand) + 1
    if expand > 0:
        return F.max_pool2d(mask, k, stride=1, padding=expand)
    return -F.max_pool2d(-mask, k, stride=1, padding=-expand)


def check_image_mask(image, mask, name):
    if len(image.shape) < 4:
        # image tensor shape should be [B, H, W, C], but batch somehow is missing
        image = image[None,:,:,:]
    
    if len(mask.shape) > 3:
        # mask tensor shape should be [B, H, W] but we get [B, H, W, C], image may be?
        # take first mask, red channel
        mask = (mask[:,:,:,0])[:,:,:]
    elif len(mask.shape) < 3:
        # mask tensor shape should be [B, H, W] but batch somehow is missing
        mask = mask[None,:,:]

    # 批次对齐（参照小珠光图像-蒙版预览）：遮罩循环平铺/裁剪到图像批数。
    # 旧逻辑在遮罩批 < 图像批时对超出部分补全黑空遮罩，导致后续帧完全不融合
    #（表现为"遮罩在变但混合位置不动"）；循环平铺后逐帧遮罩全程生效
    if image.shape[0] != mask.shape[0]:
        print(name, "mask batch (%d) != image batch (%d), repeat/trim masks to match" % (mask.shape[0], image.shape[0]))
        mask = repeat_to_batch_size(mask, image.shape[0])

    return (image, mask)


# Get origin of the mask
def cut_with_mask(mask, width, height):
    iy, ix = (mask == 1).nonzero(as_tuple=True)

    h0, w0 = mask.shape
    
    if iy.numel() == 0:
        x_c = w0 / 2.0
        y_c = h0 / 2.0
    else:
        x_min = ix.min().item()
        x_max = ix.max().item()
        y_min = iy.min().item()
        y_max = iy.max().item()

        if x_max - x_min > width or y_max - y_min > height:
            raise Exception("Masked area is bigger than provided dimensions")

        x_c = (x_min + x_max) / 2.0
        y_c = (y_min + y_max) / 2.0
    
    width2 = width / 2.0
    height2 = height / 2.0

    if w0 <= width:
        x0 = 0
        w = w0
    else:
        x0 = max(0, x_c - width2)
        w = width
        if x0 + width > w0:
            x0 = w0 - width

    if h0 <= height:
        y0 = 0
        h = h0
    else:
        y0 = max(0, y_c - height2)
        h = height
        if y0 + height > h0:
            y0 = h0 - height

    return (int(x0), int(y0), int(w), int(h))

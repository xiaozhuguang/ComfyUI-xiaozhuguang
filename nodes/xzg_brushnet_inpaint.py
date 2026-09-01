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
"""
from typing import Tuple

import torch
import torchvision.transforms as T
import torch.nn.functional as F


class BlendInpaint:

    @classmethod
    def INPUT_TYPES(s):
        return {"required":
                    {    
                        "inpaint": ("IMAGE",),
                        "original": ("IMAGE",),
                        "mask": ("MASK",),
                        "kernel": ("INT", {"default": 10, "min": 1, "max": 1000}),
                        "sigma": ("FLOAT", {"default": 10.0, "min": 0.01, "max": 1000}),
                     },
                "optional":
                    {
                        "origin": ("VECTOR",),
                    },
                }

    CATEGORY = "inpaint"
    RETURN_TYPES = ("IMAGE","MASK",)
    RETURN_NAMES = ("image","MASK",)

    FUNCTION = "blend_inpaint"

    def blend_inpaint(self, inpaint: torch.Tensor, original: torch.Tensor, mask, kernel: int, sigma:int, origin=None) -> Tuple[torch.Tensor]:

        original, mask = check_image_mask(original, mask, 'Blend Inpaint')

        if len(inpaint.shape) < 4:
            # image tensor shape should be [B, H, W, C], but batch somehow is missing
            inpaint = inpaint[None,:,:,:]

        if inpaint.shape[0] < original.shape[0]:
            print("Blend Inpaint gets batch of original images (%d) but only (%d) inpaint images" % (original.shape[0], inpaint.shape[0]))
            original = original[:inpaint.shape[0],:,:]
            mask = mask[:inpaint.shape[0],:,:]

        if inpaint.shape[0] > original.shape[0]:
            # batch over inpaint
            count = 0
            original_list = []
            mask_list = []
            origin_list = []
            while (count < inpaint.shape[0]):
                for i in range(original.shape[0]):
                    original_list.append(original[i][None,:,:,:])
                    mask_list.append(mask[i][None,:,:])
                    if origin is not None:
                        origin_list.append(origin[i][None,:])
                    count += 1
                    if count >= inpaint.shape[0]:
                        break
            original = torch.concat(original_list, dim=0)
            mask = torch.concat(mask_list, dim=0)
            if origin is not None:
                origin = torch.concat(origin_list, dim=0)

        if kernel % 2 == 0:
            kernel += 1
        transform = T.GaussianBlur(kernel_size=(kernel, kernel), sigma=(sigma, sigma))

        ret = []
        blurred = []
        for i in range(inpaint.shape[0]):
            if origin is None:
                blurred_mask = transform(mask[i][None,None,:,:]).to(original.device).to(original.dtype)
                blurred.append(blurred_mask[0])

                result = torch.nn.functional.interpolate(
                    inpaint[i][None,:,:,:].permute(0, 3, 1, 2), 
                    size=(
                        original[i].shape[0], 
                        original[i].shape[1],
                    )
                ).permute(0, 2, 3, 1).to(original.device).to(original.dtype)
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
                blurred_mask = transform(padded_mask[None,None,:,:]).to(original.device).to(original.dtype)
                blurred.append(blurred_mask[0][0])

                result = F.pad(input=inpaint[i], pad=(0, 0, x0, width-x0-inpaint[i].shape[1], 
                                                      y0, height-y0-inpaint[i].shape[0]), mode='constant', value=0)
                result = result[None,:,:,:].to(original.device).to(original.dtype)

            ret.append(original[i] * (1.0 - blurred_mask[0][0][:,:,None]) + result[0] * blurred_mask[0][0][:,:,None])

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

    CATEGORY = "inpaint"
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

    if image.shape[0] > mask.shape[0]:
        print(name, "gets batch of images (%d) but only %d masks" % (image.shape[0], mask.shape[0]))
        if mask.shape[0] == 1: 
            print(name, "will copy the mask to fill batch")
            mask = torch.cat([mask] * image.shape[0], dim=0)
        else:
            print(name, "will add empty masks to fill batch")
            empty_mask = torch.zeros([image.shape[0] - mask.shape[0], mask.shape[1], mask.shape[2]])
            mask = torch.cat([mask, empty_mask], dim=0)
    elif image.shape[0] < mask.shape[0]:
        print(name, "gets batch of images (%d) but too many (%d) masks" % (image.shape[0], mask.shape[0]))
        mask = mask[:image.shape[0],:,:]

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

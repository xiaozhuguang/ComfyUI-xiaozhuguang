import torch
import torch.nn.functional as F
import math
import re
import numpy as np


def _hex_to_rgb(color: str):
    """解析 '#RRGGBB' -> (r, g, b) 0..255。"""
    m = re.fullmatch(r'#?([0-9a-fA-F]{6})', (color or '').strip())
    if not m:
        return (0, 0, 0)
    v = int(m.group(1), 16)
    return (v >> 16) & 255, (v >> 8) & 255, v & 255


# 可映射到 torch 插值的方法；其余（lanczos）回退到 PIL。
_TORCH_METHOD = {
    'nearest': 'nearest',
    'bilinear': 'bilinear',
    'bicubic': 'bicubic',
}


def _round_up_to_multiple(number: int, multiple: int) -> int:
    if number % multiple:
        return number + multiple - number % multiple
    return number


def _torch_resize_batch(imgs: torch.Tensor, target_w: int, target_h: int,
                        method: str, bg_rgb, fit: str):
    """
    整批 [B, C, H, W] 张量一次缩放，避免逐图 tensor->PIL->tensor 往返。
    返回 None 表示该方法需走 PIL。
    """
    mode = _TORCH_METHOD.get(method)
    if mode is None:
        return None

    B, C, H, W = imgs.shape
    device = imgs.device
    align = False if mode in ('bilinear', 'bicubic') else None
    antialias = True if mode in ('bilinear', 'bicubic') else None

    def interp(t, w, h):
        return F.interpolate(t, size=(h, w), mode=mode,
                             align_corners=align, antialias=antialias)

    if fit in ('fill', 'crop'):
        if fit == 'fill':
            return interp(imgs, target_w, target_h)
        # crop：按目标比例中心裁剪后再缩放
        scale = max(target_w / W, target_h / H)
        crop_w = max(1, min(W, int(round(target_w / scale))))
        crop_h = max(1, min(H, int(round(target_h / scale))))
        left = (W - crop_w) // 2
        top = (H - crop_h) // 2
        cropped = imgs[:, :, top:top + crop_h, left:left + crop_w]
        return interp(cropped, target_w, target_h)

    # letterbox：等比缩放至合适尺寸，居中放在背景上
    scale = min(target_w / W, target_h / H)
    fit_w = max(1, int(round(W * scale)))
    fit_h = max(1, int(round(H * scale)))
    resized = interp(imgs, fit_w, fit_h)

    if fit_w == target_w and fit_h == target_h:
        return resized

    # 背景色只取前 C 个通道：RGB 取 3 个，mask(单通道) 取 1 个
    vals = list(bg_rgb)[:C] if len(bg_rgb) >= C else list(bg_rgb) + [0] * (C - len(bg_rgb))
    bg = torch.tensor([v / 255.0 for v in vals],
                      dtype=imgs.dtype, device=device).view(1, C, 1, 1)
    out = bg.expand(B, C, target_h, target_w).clone()
    left = (target_w - fit_w) // 2
    top = (target_h - fit_h) // 2
    out[:, :, top:top + fit_h, left:left + fit_w] = resized
    return out


class XiaozhuguangImageScaleByAspectRatioV2:
    """小珠光图片缩放（torch 批量提速版）。"""

    @classmethod
    def INPUT_TYPES(cls):
        ratio_list = ['尺寸输入', '原始比例', '自定义比例', '1:1', '3:2', '4:3', '16:9', '2:3', '3:4', '9:16']
        fit_mode = ['letterbox', 'crop', 'fill']
        method_mode = ['lanczos', 'bicubic', 'bilinear', 'nearest']
        multiple_list = ['8', '16', '32', '64', '128', '256', '512', 'None']
        scale_to_list = ['None', 'longest', 'shortest', 'width', 'height', 'total_pixel(kilo pixel)']
        return {
            "required": {
                "aspect_ratio": (ratio_list,),
                "宽度": ("INT", {"default": 1, "min": 1, "max": 100000000, "step": 1}),
                "高度": ("INT", {"default": 1, "min": 1, "max": 100000000, "step": 1}),
                "fit": (fit_mode,),
                "method": (method_mode,),
                "round_to_multiple": (multiple_list,),
                "scale_to_side": (scale_to_list,),  # 按哪条边缩放
                "scale_to_length": ("INT", {"default": 1024, "min": 4, "max": 100000000, "step": 1}),
                "background_color": ("STRING", {"default": "#000000"}),
            },
            "optional": {
                "image": ("IMAGE",),
                "mask": ("MASK",),
            }
        }

    RETURN_TYPES = ("IMAGE", "MASK", "INT", "INT")
    RETURN_NAMES = ("图像", "遮罩", "宽度", "高度")
    FUNCTION = "execute"
    CATEGORY = "xiaozhuguang"
    DESCRIPTION = "按宽高比特定目标尺寸缩放图像/遮罩（torch 批量提速版），支持 letterbox/crop/fill。"

    def _resize_pil_fallback(self, images, target_w, target_h, fit, method, bg_rgb, is_mask):
        """lanczos 等方法回退到 PIL 逐图处理。"""
        from PIL import Image as _PIL
        sampler = _PIL.LANCZOS
        if method == "bicubic":
            sampler = _PIL.BICUBIC
        elif method == "bilinear":
            sampler = _PIL.BILINEAR
        elif method == "nearest":
            sampler = _PIL.NEAREST
        bg = '#%02x%02x%02x' % bg_rgb if not is_mask else '#000000'
        outs = []
        for img in images:  # list of [1,H,W,C] tensors
            arr = (img[0].detach().cpu().numpy() * 255.0).clip(0, 255)
            if not is_mask:
                pil = _PIL.fromarray(arr.astype('uint8'))
            else:
                pil = _PIL.fromarray(arr.astype('uint8')).convert('L')
            orig_w, orig_h = pil.size
            if fit == 'letterbox':
                if orig_w / orig_h > target_w / target_h:
                    fw = target_w
                    fh = int(target_w / orig_w * orig_h)
                else:
                    fh = target_h
                    fw = int(target_h / orig_h * orig_w)
                fimg = pil.resize((fw, fh), sampler)
                ret = _PIL.new('RGB' if not is_mask else 'L',
                               size=(target_w, target_h), color=bg)
                ret.paste(fimg, box=((target_w - fw) // 2, (target_h - fh) // 2))
            elif fit == 'crop':
                if orig_w / orig_h > target_w / target_h:
                    fw = int(orig_h * target_w / target_h)
                    fimg = pil.crop(((orig_w - fw) // 2, 0,
                                     (orig_w - fw) // 2 + fw, orig_h))
                else:
                    fh = int(orig_w * target_h / target_w)
                    fimg = pil.crop((0, (orig_h - fh) // 2,
                                     orig_w, (orig_h - fh) // 2 + fh))
                ret = fimg.resize((target_w, target_h), sampler)
            else:
                ret = pil.resize((target_w, target_h), sampler)
            if is_mask:
                ret = ret.convert('L')
                out = torch.from_numpy(
                    np.asarray(ret).astype('float32') / 255.0
                ).reshape(1, target_h, target_w)
            else:
                ret = ret.convert('RGB')
                out = torch.from_numpy(
                    np.asarray(ret).astype('float32') / 255.0
                ).permute(2, 0, 1).unsqueeze(0).permute(0, 2, 3, 1)
            outs.append(out)
        return torch.cat(outs, dim=0)

    def execute(self, aspect_ratio, 宽度, 高度,
                fit, method, round_to_multiple, scale_to_side, scale_to_length,
                background_color, image=None, mask=None):
        orig_images = []
        orig_masks = []
        orig_width = orig_height = 0
        target_width = target_height = 0

        if image is not None:
            orig_images = [torch.unsqueeze(i, 0) for i in image]
            orig_height, orig_width = orig_images[0].size(1), orig_images[0].size(2)

        if mask is not None:
            if mask.dim() == 2:
                mask = torch.unsqueeze(mask, 0)
            for m in mask:
                orig_masks.append(torch.unsqueeze(m, 0))
            if orig_masks:
                _h, _w = orig_masks[0].size(1), orig_masks[0].size(2)
                if (orig_width > 0 and orig_width != _w) or (orig_height > 0 and orig_height != _h):
                    raise ValueError("小珠光图片缩放：mask 与 image 尺寸不一致")
                elif orig_width + orig_height == 0:
                    orig_width, orig_height = _w, _h

        if orig_width + orig_height == 0:
            raise ValueError("小珠光图片缩放：image 与 mask 至少输入一个")

        if aspect_ratio == '尺寸输入':
            # 直接把下方两个数值输入当作目标宽/高，忽略比例与缩放边逻辑
            target_width = 宽度
            target_height = 高度
        else:
            if aspect_ratio == '原始比例':
                ratio = orig_width / orig_height
            elif aspect_ratio == '自定义比例':
                ratio = 宽度 / 高度
            else:
                s = aspect_ratio.split(":")
                ratio = int(s[0]) / int(s[1])

            if ratio > 1:
                if scale_to_side == 'longest':
                    target_width = scale_to_length
                    target_height = int(target_width / ratio)
                elif scale_to_side == 'shortest':
                    target_height = scale_to_length
                    target_width = int(target_height * ratio)
                elif scale_to_side == 'width':
                    target_width = scale_to_length
                    target_height = int(target_width / ratio)
                elif scale_to_side == 'height':
                    target_height = scale_to_length
                    target_width = int(target_height * ratio)
                elif scale_to_side == 'total_pixel(kilo pixel)':
                    target_width = math.sqrt(ratio * scale_to_length * 1000)
                    target_height = target_width / ratio
                    target_width = int(target_width)
                    target_height = int(target_height)
                else:
                    target_width = orig_width
                    target_height = int(target_width / ratio)
            else:
                if scale_to_side == 'longest':
                    target_height = scale_to_length
                    target_width = int(target_height * ratio)
                elif scale_to_side == 'shortest':
                    target_width = scale_to_length
                    target_height = int(target_width / ratio)
                elif scale_to_side == 'width':
                    target_width = scale_to_length
                    target_height = int(target_width / ratio)
                elif scale_to_side == 'height':
                    target_height = scale_to_length
                    target_width = int(target_height * ratio)
                elif scale_to_side == 'total_pixel(kilo pixel)':
                    target_width = math.sqrt(ratio * scale_to_length * 1000)
                    target_height = target_width / ratio
                    target_width = int(target_width)
                    target_height = int(target_height)
                else:
                    target_height = orig_height
                    target_width = int(target_height * ratio)

        if aspect_ratio != '尺寸输入' and round_to_multiple != 'None':
            multiple = int(round_to_multiple)
            target_width = _round_up_to_multiple(target_width, multiple)
            target_height = _round_up_to_multiple(target_height, multiple)

        target_width = max(1, target_width)
        target_height = max(1, target_height)

        bg_rgb = _hex_to_rgb(background_color)

        ret_images = None
        if orig_images:
            images_t = torch.cat(orig_images, dim=0).permute(0, 3, 1, 2)  # [B,C,H,W]
            out = _torch_resize_batch(images_t, target_width, target_height,
                                      method, bg_rgb, fit)
            if out is not None:
                ret_images = out.permute(0, 2, 3, 1)  # [B,H,W,C]
            else:
                ret_images = self._resize_pil_fallback(
                    orig_images, target_width, target_height, fit, method, bg_rgb, False)

        ret_masks = None
        if orig_masks:
            masks_t = torch.cat(orig_masks, dim=0).unsqueeze(1)  # [B,1,H,W]
            out = _torch_resize_batch(masks_t, target_width, target_height,
                                      method, (0, 0, 0), fit)
            if out is not None:
                ret_masks = out.squeeze(1)  # [B,H,W]
            else:
                ret_masks = self._resize_pil_fallback(
                    orig_masks, target_width, target_height, fit, method, (0, 0, 0), True)

        return (ret_images, ret_masks, target_width, target_height)


NODE_CLASS_MAPPINGS = {
    "XiaozhuguangImageScaleByAspectRatioV2": XiaozhuguangImageScaleByAspectRatioV2,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XiaozhuguangImageScaleByAspectRatioV2": "小珠光图片缩放",
}
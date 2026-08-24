# 图像-蒙版预览（穿透合成·极速版，纯透出，不保存预览）
# 在 comfyui-kjnodes 的 ImageAndMaskPreview 基础上做速度优化，并**始终内置穿透模式**：
# 直接返回合成图像，不做任何预览保存。
#   1) 合成阶段弃用 comfy_extras.nodes_mask.composite —— 该通用函数会做
#      冗余的全幅 source bilinear 插值(resize_source=True) + repeat_to_batch_size
#      + inverse_mask + 多次逐点运算；而本场景(同尺寸图像上叠纯色蒙版)等价于
#      一次 alpha 混合：image*(1-a) + color*a。
#   2) 不再用 `.expand().clone()` 物化一份完整 BxHxWx3 的纯色张量再逐通道写值，
#      改用一个 (1,1,1,3) 的颜色张量直接广播参与混合。
# 结果与 ImageAndMaskPreview 数学等价，但大幅减少张量分配与算子数量。
import torch
import torch.nn.functional as F
from PIL import ImageColor
from comfy.utils import repeat_to_batch_size


def _color_to_rgba(color_string: str):
    """解析颜色字符串 -> (r,g,b,a)。a 恒在 0-255，若原串未给出 alpha 则返回 255。"""
    def _norm(values):
        if all(0 <= v <= 1 for v in values):
            return [int(v * 255) for v in values]
        return [int(v) for v in values]

    if ',' in color_string:
        try:
            values = [float(c.strip()) for c in color_string.split(',')]
            values = _norm(values)
            r, g, b = values[0], values[1], values[2]
            a = values[3] if len(values) >= 4 else 255
            return (r, g, b, a)
        except ValueError:
            pass
    elif color_string.startswith('#'):
        hex_str = color_string.lstrip('#')
        if len(hex_str) in (6, 8) and all(c in '0123456789ABCDEFabcdef' for c in hex_str):
            if len(hex_str) == 6:
                return (int(hex_str[0:2], 16), int(hex_str[2:4], 16), int(hex_str[4:6], 16), 255)
            return (int(hex_str[0:2], 16), int(hex_str[2:4], 16), int(hex_str[4:6], 16), int(hex_str[6:8], 16))
        elif hex_str:
            rgbe = len(hex_str) == 4
            if rgbe or len(hex_str) == 3:
                vals = [int(hex_str[i], 16) * 17 for i in range(3)]
                if rgbe:
                    vals.append(int(hex_str[3], 16) * 17)
                return (vals[0], vals[1], vals[2], vals[3] if rgbe else 255)
    else:
        # 颜色名或单灰度值
        try:
            v = float(color_string.strip())
            v = int(v * 255) if 0 <= v <= 1 else int(v)
            return (v, v, v, 255)
        except ValueError:
            try:
                rgb = ImageColor.getrgb(color_string)
                return (rgb[0], rgb[1], rgb[2], rgb[3] if len(rgb) > 3 else 255)
            except ValueError:
                return (0, 0, 0, 255)

    return (0, 0, 0, 255)


def _mask_to_alpha(mask, mask_opacity, alpha_factor, invert, image):
    """把输入 mask 转成与 image 空间尺寸、批次一致的 alpha (B,H,W)。"""
    if mask.ndim == 2:
        alpha = mask.unsqueeze(0)            # (1,H',W')
    else:
        alpha = mask                          # (B',H',W')

    if invert:
        alpha = 1.0 - alpha                   # 遮罩反转

    alpha = alpha * mask_opacity
    if alpha_factor < 1.0:
        alpha = alpha * alpha_factor

    # 空间尺寸不一致时再插值（批次尺寸可以任意，交给 repeat 处理）
    if alpha.shape[-2:] != image.shape[-2:]:
        alpha = F.interpolate(
            alpha.unsqueeze(1),
            size=(image.shape[1], image.shape[2]),
            mode='bilinear',
            align_corners=False,
        ).squeeze(1)

    alpha = alpha.clamp(0.0, 1.0)
    alpha = repeat_to_batch_size(alpha, image.shape[0])   # -> (B,H,W)
    return alpha


class XiaozhuguangImageMaskPreview:
    """小珠光图像-蒙版预览（穿透合成·极速版）。

    始终内置穿透模式：无论输入为何，都直接返回合成图像，不做任何预览保存。
    仅连接遮罩时：遮罩转灰度 RGB 输出；仅连接图像时：原样透传；
    两者都有时：用单次 alpha 混合 image*(1-a)+color*a 替代通用 composite。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mask_opacity": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
                "mask_color": ("STRING", {"default": "255, 255, 255", "tooltip": "RGB (255,255,255) 或 RGBA (255,255,255,128) 或 Hex (#RRGGBB / #RRGGBBAA)"}),
                "invert_mask": ("BOOLEAN", {"default": False, "label_on": "反转", "label_off": "不反转"}),
            },
            "optional": {
                "image": ("IMAGE",),
                "mask": ("MASK",),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("composite",)
    FUNCTION = "execute"
    CATEGORY = "xiaozhuguang"
    OUTPUT_NODE = False
    DESCRIPTION = """始终内置穿透模式：直接返回合成结果，不保存预览。
    仅图像：原样透传；仅遮罩：灰度 RGB 输出；两者都有：把遮罩按 mask_color/mask_opacity
    叠加到图像上合成。invert_mask 开启时反转遮罩后再生效。mask_color 支持 RGB/RGBA/Hex，
    支持每色透明度。相比 kjnodes 同名节点，合成用单次 alpha 混合替代通用 composite，
    速度更快、零预览磁盘开销。"""

    def execute(self, mask_opacity, mask_color, invert_mask, image=None, mask=None):
        if mask is not None and image is None:
            # 仅遮罩：转灰度 RGB 输出
            composite = mask.reshape((-1, 1, mask.shape[-2], mask.shape[-1])).movedim(1, -1).expand(-1, -1, -1, 3)
        elif image is not None:
            # 仅图像 或 图像+遮罩
            r, g, b, a = _color_to_rgba(mask_color)
            alpha_factor = a / 255.0
            if mask is None:
                composite = image                     # 仅图像：直接透传，零拷贝
            else:
                # 极小张量分配：颜色只有一个 (1,1,1,3)，非整幅 BxHxWx3
                color_rgb = torch.tensor(
                    [r / 255.0, g / 255.0, b / 255.0],
                    dtype=image.dtype,
                    device=image.device,
                ).view(1, 1, 1, 3)
                alpha = _mask_to_alpha(mask, mask_opacity, alpha_factor, invert_mask, image).unsqueeze(-1)  # (B,H,W,1)
                # 单次 fma 式 alpha 混合，等价 composite 结果
                composite = image * (1.0 - alpha) + color_rgb * alpha
        else:
            # 两者都空：错误提示（与 kjnodes 不同，这里不抛未定义变量）
            raise ValueError("[小珠光] 图像-蒙版预览缺少输入：image 与 mask 至少连接一个")

        return (composite,)
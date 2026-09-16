# 图像-蒙版预览（穿透合成·极速版，纯透出，不保存预览）
# 始终内置穿透模式：直接返回合成图像，不做任何预览保存。
#   1) 合成阶段不做全幅源图插值、批次对齐、多次逐点运算——
#      本场景(同尺寸图像上叠纯色蒙版)就是一次 alpha 混合：image*(1-a) + color*a。
#   2) 不物化整幅 BxHxWx3 纯色张量再逐通道写值，
#      用一个 (1,1,1,3) 的颜色张量直接广播参与混合，大幅减少张量分配与算子数量。
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


def _mosaic_image(image, block: int):
    """把整幅图像马赛克化：缩小到 1/block 再用最近邻放大回原尺寸（纯 tensor，GPU 可用）。
    image: (B,H,W,C) -> (B,H,W,C)"""
    b, h, w, c = image.shape
    block = max(2, int(block))
    bh = max(1, h // block)
    bw = max(1, w // block)
    small = F.interpolate(
        image.permute(0, 3, 1, 2),
        size=(bh, bw),
        mode="bilinear",
        align_corners=False,
    )
    big = F.interpolate(small, size=(h, w), mode="nearest")
    return big.permute(0, 2, 3, 1)


def _colored_mosaic_image(image, block: int):
    """固定彩色马赛克：每块颜色由块坐标的确定性散列生成（同一块永远同一颜色，
    跨帧/跨批次稳定不闪烁），与图像内容无关。低分辨率色块网格最近邻放大回原尺寸。
    image: (B,H,W,C) -> (B,H,W,C)"""
    b, h, w, c = image.shape
    block = max(2, int(block))
    bh = max(1, h // block)
    bw = max(1, w // block)
    device = image.device
    rows = torch.arange(bh, device=device).view(-1, 1)
    cols = torch.arange(bw, device=device).view(1, -1)
    # int64 确定性散列（乘大素数取模）→ HSV 构造，保证每块都是彩色
    hue = ((rows * 73856093 + cols * 19349663) % 1000003).float() / 1000003.0
    sat = 0.45 + 0.45 * ((rows * 83492791 + cols * 33180797 + 17) % 999983).float() / 999983.0
    val = 0.55 + 0.35 * ((rows * 15485863 + cols * 2971215073 + 53) % 99991).float() / 99991.0
    # HSV -> RGB（向量化）
    h6 = hue * 6.0
    i = torch.floor(h6).long() % 6
    f = h6 - torch.floor(h6)
    p = val * (1.0 - sat)
    q = val * (1.0 - sat * f)
    t = val * (1.0 - sat * (1.0 - f))
    r = torch.where(i == 0, val, torch.where(i == 1, q, torch.where(i == 2, p, torch.where(i == 3, p, torch.where(i == 4, t, p)))))
    g = torch.where(i == 0, t, torch.where(i == 1, val, torch.where(i == 2, q, torch.where(i == 3, p, torch.where(i == 4, p, q)))))
    b_ = torch.where(i == 0, p, torch.where(i == 1, p, torch.where(i == 2, t, torch.where(i == 3, val, torch.where(i == 4, q, p)))))
    small = torch.stack([r, g, b_], dim=-1).unsqueeze(0).expand(b, bh, bw, 3)
    big = F.interpolate(
        small.permute(0, 3, 1, 2).to(image.dtype),
        size=(h, w),
        mode="nearest",
    )
    return big.permute(0, 2, 3, 1)


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
    两者都有时：单次 alpha 混合 image*(1-a)+color*a 输出合成图。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mask_opacity": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
                "mask_color": ("STRING", {"default": "255, 255, 255", "tooltip": "RGB (255,255,255) 或 RGBA (255,255,255,128) 或 Hex (#RRGGBB / #RRGGBBAA)"}),
                "invert_mask": ("BOOLEAN", {"default": False, "label_on": "反转", "label_off": "不反转"}),
                # 追加在末尾：旧工作流的 widgets_values 按序对齐不受影响
                "fill_mode": (["纯色", "马赛克", "彩色马赛克"], {"default": "纯色", "tooltip": "遮罩区域的填充内容：纯色=mask_color；马赛克=遮罩区域图像像素化；彩色马赛克=固定彩色块（每块颜色由块位置决定，跨帧稳定不闪烁）。均按 mask_opacity 渐变混合"}),
                "mosaic_block": ("INT", {"default": 16, "min": 2, "max": 512, "step": 1, "tooltip": "马赛克块大小（像素）。仅填充模式=马赛克时生效"}),
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
    仅图像：原样透传；仅遮罩：灰度 RGB 输出；两者都有：按 fill_mode 把遮罩区域
    合成到图像上——纯色=mask_color 纯色叠加；马赛克=遮罩区域图像像素化；彩色马赛克=
    固定彩色块（每块颜色由块位置决定，跨帧稳定不闪烁）。块大小由 mosaic_block 控制。
    invert_mask 开启时反转遮罩后再生效，mask_opacity 控制混合强度（渐变遮罩同样支持）。
    马赛克/彩色马赛克模式下 mask_color 的 alpha 不参与。"""

    def execute(self, mask_opacity, mask_color, invert_mask, fill_mode="纯色", mosaic_block=16, image=None, mask=None):
        if mask is not None and image is None:
            # 仅遮罩：转灰度 RGB 输出（马赛克模式无图像可像素化，保持灰度输出）
            composite = mask.reshape((-1, 1, mask.shape[-2], mask.shape[-1])).movedim(1, -1).expand(-1, -1, -1, 3)
        elif image is not None:
            # 仅图像 或 图像+遮罩
            r, g, b, a = _color_to_rgba(mask_color)
            alpha_factor = a / 255.0
            if mask is None:
                composite = image                     # 仅图像：直接透传，零拷贝
            else:
                alpha = _mask_to_alpha(mask, mask_opacity, alpha_factor, invert_mask, image).unsqueeze(-1)  # (B,H,W,1)
                if fill_mode == "马赛克":
                    # 马赛克：填充内容 = 像素化后的图像本身（mask_color 不参与）
                    fill = _mosaic_image(image, mosaic_block).to(image.dtype)
                elif fill_mode == "彩色马赛克":
                    # 固定彩色马赛克：块颜色由块坐标决定，与图像内容无关
                    fill = _colored_mosaic_image(image, mosaic_block).to(image.dtype)
                else:
                    # 纯色：极小张量分配，颜色只有一个 (1,1,1,3)
                    fill = torch.tensor(
                        [r / 255.0, g / 255.0, b / 255.0],
                        dtype=image.dtype,
                        device=image.device,
                    ).view(1, 1, 1, 3)
                # 单次 fma 式 alpha 混合，等价 composite 结果
                composite = image * (1.0 - alpha) + fill * alpha
        else:
            # 两者都空：明确报错提示
            raise ValueError("[小珠光] 图像-蒙版预览缺少输入：image 与 mask 至少连接一个")

        return (composite,)
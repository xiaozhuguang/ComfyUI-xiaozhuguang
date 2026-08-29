import os
import random
import numpy as np
import torch
from PIL import Image
import folder_paths
from nodes import PreviewImage


class AnyType(str):
    """万能类型：允许 MASK 直接接到 images 输入点（方案B），执行时内部识别。"""
    def __ne__(self, __value: object) -> bool:
        return False


ANY_TYPE = AnyType("*")

# 用于懒编码：执行时仅存原始像素(uint8)，右键保存真实分辨率图时才临时编码 PNG
REAL_STORE = {}


def _xzg_make_checkerboard(w, h, cell=8, c1=255, c2=220):
    """生成 Photoshop 风格透明指示棋盘格背景（ffffff / dcdcdc 交替）。
    返回 RGB 模式的 PIL Image。cell 为方格边长（像素）。"""
    # 按行生成一行的棋盘格，再按行复制，避免逐像素绘制
    row_odd = np.tile(np.where(np.arange(w) // cell % 2 == 0, c1, c2), (cell, 1))
    row_even = np.tile(np.where(np.arange(w) // cell % 2 == 1, c1, c2), (cell, 1))
    pair = np.concatenate([row_odd, row_even], axis=0)  # (2*cell, w)
    reps = int(np.ceil(h / (2 * cell)))
    board = np.concatenate([pair] * reps, axis=0)[:h]  # (h, w)
    # 扩展为 3 通道 RGB
    board_rgb = np.stack([board, board, board], axis=-1).astype(np.uint8)
    return Image.fromarray(board_rgb, "RGB")


def _xzg_composite_checkerboard(rgba_pil, cell=8):
    """将 RGBA 图像合成到棋盘格背景上（alpha 混合），返回 RGB 图像。"""
    w, h = rgba_pil.size
    bg = _xzg_make_checkerboard(w, h, cell=cell).convert("RGBA")
    composed = Image.alpha_composite(bg, rgba_pil).convert("RGB")
    return composed


class XiaozhuguangImageSave(PreviewImage):
    """小珠光图像保存 - 保存图像为 JPG(压缩) 或 PNG(无损)，画布预览始终为压缩JPG(流畅)。
    与小珠光图像预览完全相似的显示体验，但增加实际文件保存功能。
    JPG保存使用与预览相同的压缩参数；PNG保存为全分辨率无损。
    右键菜单可下载真实分辨率PNG(懒编码)或压缩JPG。
    文件名固定为 xzg-save_序号，用户可通过 output_path 自定义输出文件夹。
    支持保存/预览模式切换：保存模式输出文件到output目录，预览模式仅显示不保存。
    images 输入点兼容 IMAGE 与 MASK（方案B）：接到 MASK 时自动识别单通道并转黑白 3 通道预览、保存为 PNG。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": (ANY_TYPE,),
            },
            "optional": {
                "output_path": ("STRING", {"default": "", "multiline": False}),
                "save_format": (["JPG", "PNG"], {"default": "JPG"}),
                "reduce_lag": ("BOOLEAN", {"default": False, "label_on": "开启", "label_off": "关闭"}),
                "mode": (["Save", "Preview"], {"default": "Save"}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "save_images"
    CATEGORY = "xiaozhuguang"
    OUTPUT_NODE = True

    def save_images(self, images, output_path="", save_format="JPG", reduce_lag=False, mode="Save",
                    prompt=None, extra_pnginfo=None):

        max_side = 3840 if reduce_lag else 6400
        quality = 85 if reduce_lag else 80

        # 兼容老工作流的中文值
        mode_norm = "Preview" if str(mode) in ("预览", "Preview", "preview") else "Save"
        is_preview_mode = (mode_norm == "Preview")

        # 输出目录（用户可自定义子文件夹）— 仅保存模式需要
        if not is_preview_mode:
            if output_path and output_path.strip():
                base_dir = os.path.join(folder_paths.get_output_directory(), output_path.strip().strip("/\\"))
                subfolder = output_path.strip()
            else:
                base_dir = folder_paths.get_output_directory()
                subfolder = ""
            os.makedirs(base_dir, exist_ok=True)

        # 临时目录（预览图）
        temp_dir = folder_paths.get_temp_directory()
        os.makedirs(temp_dir, exist_ok=True)

        rand = lambda: "".join(random.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(8))

        # 文件名前缀：固定 xzg-save，后接5位序号避免重复
        filename_prefix = "xzg-save"

        # 懒编码令牌：用于右键保存真实分辨率 PNG
        token = "".join(random.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(16))
        REAL_STORE[token] = []
        if len(REAL_STORE) > 100:
            old = next(iter(REAL_STORE))
            REAL_STORE.pop(old, None)

        saved = []
        entries = []
        counter = 0

        # 预扫描：批次中任一张图带 alpha 通道则强制 PNG 输出（JPG 无法保留透明度）
        batch_has_alpha = any((t.dim() == 3 and t.shape[2] == 4) for t in images)
        if batch_has_alpha:
            save_format = "PNG"

        for i, tensor in enumerate(images):
            # 方案B：MASK（单通道 0~1）直接接 images 输入点，运行时识别并转黑白 3 通道
            is_mask = (tensor.dim() == 2) or (tensor.dim() == 3 and tensor.shape[2] == 1)
            if is_mask:
                if tensor.dim() == 2:
                    rgb = tensor.unsqueeze(-1).expand(-1, -1, 3)
                else:
                    rgb = tensor.expand(-1, -1, 3)
                tensor = rgb
                if batch_has_alpha is False:
                    save_format = "PNG"  # 黑白遮罩建议无损 PNG

            h, w = tensor.shape[0], tensor.shape[1]
            has_alpha = (tensor.dim() == 3 and tensor.shape[2] == 4)

            # 存储原始像素（uint8，CPU），供右键时编码 PNG
            real_np = (tensor.cpu().numpy() * 255).clip(0, 255).astype(np.uint8)
            REAL_STORE[token].append(real_np)

            # GPU 加速压缩（仅做一次，用于预览和 JPG 保存）
            img = tensor.unsqueeze(0).permute(0, 3, 1, 2)
            if max(w, h) > max_side:
                ratio = max_side / max(w, h)
                new_w = int(w * ratio)
                new_h = int(h * ratio)
                img = torch.nn.functional.interpolate(img, size=(new_h, new_w), mode='bicubic', align_corners=False)
            img = img.squeeze(0).permute(1, 2, 0).cpu().numpy()
            compressed_pil = Image.fromarray((img * 255).clip(0, 255).astype(np.uint8))

            # 预览始终为 JPG（减少卡顿）：RGBA 合成到棋盘格背景后转 RGB（Photoshop 风格透明指示）
            if compressed_pil.mode != "RGB":
                if compressed_pil.mode == "RGBA":
                    # 格子大小按图像尺寸自适应（最长边 / 32，范围 16~40px）
                    _cell = max(16, min(40, max(w, h) // 32))
                    jpg_pil = _xzg_composite_checkerboard(compressed_pil, cell=_cell)
                else:
                    jpg_pil = compressed_pil.convert("RGB")
            else:
                jpg_pil = compressed_pil

            # 保存压缩 JPG 预览到临时目录（画布显示，始终 JPG）
            preview_fname = f"xzg.save.preview.{rand()}_{i}.jpg"
            jpg_pil.save(os.path.join(temp_dir, preview_fname), "JPEG", quality=quality, optimize=True)

            # 保存到输出目录（仅保存模式；RGBA 已强制 PNG）
            saved_info = None
            if not is_preview_mode:
                while True:
                    fname = f"{filename_prefix}_{counter:05d}"
                    if save_format == "PNG":
                        full_path = os.path.join(base_dir, fname + ".png")
                    else:
                        full_path = os.path.join(base_dir, fname + ".jpg")
                    if not os.path.exists(full_path):
                        break
                    counter += 1

                if save_format == "PNG":
                    # 全分辨率 PNG（无损）；RGBA 保留 alpha 通道（透明背景）
                    Image.fromarray(real_np).save(full_path, "PNG")
                else:
                    # JPG 输出使用原图全分辨率（预览的 3840/6400 降采样仅用于画布防卡顿，不影响输出尺寸）
                    full_pil = Image.fromarray(real_np)
                    if full_pil.mode != "RGB":
                        if full_pil.mode == "RGBA":
                            _cell = max(16, min(40, max(w, h) // 32))
                            full_pil = _xzg_composite_checkerboard(full_pil, cell=_cell)
                        else:
                            full_pil = full_pil.convert("RGB")
                    full_pil.save(full_path, "JPEG", quality=quality, optimize=True)

                saved_info = {
                    "filename": os.path.basename(full_path),
                    "subfolder": subfolder,
                    "type": "output"
                }
                saved.append(saved_info)

            entries.append({
                "filename": preview_fname,
                "subfolder": "",
                "type": "temp",
                "real_token": token,
                "real_index": i,
                "real_width": int(w),
                "real_height": int(h),
                # 标记是否含 alpha 通道：前端据此强制右键只允许 PNG 保存
                "has_alpha": bool(has_alpha),
                # 保存模式下附带 output 目录文件信息，右键可直接下载，无需懒编码
                "saved_filename": saved_info["filename"] if saved_info else None,
                "saved_subfolder": saved_info["subfolder"] if saved_info else None,
                "saved_type": saved_info["type"] if saved_info else None,
            })
            counter += 1

        # 兼容前端媒体管理（媒体资产）：节点输出必须含标准 ui.images 才会被登记/展示。
        # 保存模式 → 实际保存到 output 的文件(type=output)；预览模式 → 临时预览(type=temp)。
        if is_preview_mode:
            images_ui = [
                {"filename": e["filename"], "subfolder": e["subfolder"], "type": e["type"]}
                for e in entries
            ]
        else:
            images_ui = saved

        result = {"ui": {"xzg_preview": entries, "saved": saved, "images": images_ui}}
        return result

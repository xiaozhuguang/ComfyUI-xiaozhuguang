"""
小珠光图像保存-自定义输出
基于小珠光图像保存，增加：
  1) output_path 支持 {date} {time} {datetime} {workflow} {node_id} {format} 模板变量
  2) filename_prefix 支持相同模板变量，可自定义文件名前缀
  3) 同一次执行内共享同一时间戳，保证进同一文件夹
  4) 路径非法字符自动替换为 _，避免 Windows 路径问题
  5) base_dir 支持绝对路径（可配合前端文件夹选择器使用）
空值完全兼容小珠光图像保存的旧行为（output/ 根目录 + xzg-save_00000 文件名）
"""
import os
import re
import random
import numpy as np
import torch
from PIL import Image
from datetime import datetime
import folder_paths
from nodes import PreviewImage

# 用于懒编码：执行时仅存原始像素(uint8)，右键保存真实分辨率图时才临时编码 PNG
# 与 xzg_image_save 共享同一个 REAL_STORE（同一懒编码路由 /xzg_save_real）
from .xzg_image_save import REAL_STORE, _xzg_composite_checkerboard

# 路径非法字符（Windows）→ 下划线，保留路径分隔符 / 和 \
_INVALID_CHARS_RE = re.compile(r'[<>:"|?*\x00-\x1f]')


def _is_absolute_path(p: str) -> bool:
    """判断是否为绝对路径（跨平台）。"""
    if not p:
        return False
    # Windows: D:\, D:/, \, /  ；Linux/Mac: /home
    if len(p) >= 2 and p[1] == ':' and p[0].isalpha():
        return True
    return p.startswith('/') or p.startswith('\\')


def _sanitize(name: str) -> str:
    r"""把路径中的非法字符替换为 _，保留 / 和 \ 作为路径分隔符，并去掉首尾空白和点。
    Windows 盘符冒号（如 C:）会被保留，避免破坏绝对路径。
    """
    if not name:
        return name
    drive = ""
    m = re.match(r'^([A-Za-z]:)', name)
    if m:
        drive = m.group(1)
        name = name[len(drive):]
    name = _INVALID_CHARS_RE.sub("_", name)
    name = name.strip().strip(".")
    return drive + name


def _resolve_template(template: str, context: dict) -> str:
    """把 {date} {time} {datetime} {workflow} {node_id} {format} 占位符替换为实际值。
    不含占位符时原样返回（兼容旧用法）。
    """
    if not template:
        return template
    now: datetime = context.get("_now") or datetime.now()
    import time as _time
    replacements = {
        "{date}": now.strftime("%Y-%m-%d"),
        "{time}": now.strftime("%H%M%S"),
        "{datetime}": now.strftime("%Y%m%d-%H%M%S"),
        "{timestamp_ms}": str(int(_time.time() * 1000)),
        "{workflow}": _sanitize(str(context.get("workflow_name", "untitled"))) or "untitled",
        "{node_id}": str(context.get("node_id", "")),
        "{format}": str(context.get("format", "")),
    }
    result = template
    for k, v in replacements.items():
        result = result.replace(k, v)
    return result


class XiaozhuguangImageSaveCustom(PreviewImage):
    """小珠光图像保存-自定义输出
    保存图像为 JPG(压缩) 或 PNG(无损)，画布预览始终为压缩JPG(流畅)。
    与小珠光图像保存完全相似的显示体验，但 output_path / filename_prefix 支持
    {date} {time} {datetime} {workflow} {node_id} {format} 模板变量，
    可按日期/工作流名自动分文件夹，文件名带时间戳。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
            },
            "optional": {
                "base_dir": ("STRING", {"default": "", "multiline": False}),
                "filename_custom": ("STRING", {"default": "xzg-save", "multiline": False}),
                "add_date_stamp": ("BOOLEAN", {"default": False, "label_on": "开启", "label_off": "关闭"}),
                "add_time_stamp": ("BOOLEAN", {"default": False, "label_on": "开启", "label_off": "关闭"}),
                "use_default_output": ("BOOLEAN", {"default": True, "label_on": "默认输出", "label_off": "自定义输出"}),
                "save_format": (["JPG", "PNG"], {"default": "JPG"}),
                "reduce_lag": ("BOOLEAN", {"default": False, "label_on": "开启", "label_off": "关闭"}),
                "mode": (["Save", "Preview"], {"default": "Save"}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "save_images"
    CATEGORY = "xiaozhuguang"
    OUTPUT_NODE = True

    def save_images(self, images, base_dir="",
                    filename_custom="xzg-save", add_date_stamp=False, add_time_stamp=False,
                    use_default_output=True, save_format="JPG", reduce_lag=False, mode="Save",
                    prompt=None, extra_pnginfo=None, unique_id=None):

        max_side = 3840 if reduce_lag else 6400
        quality = 85 if reduce_lag else 80

        # 兼容老工作流的中文值
        mode_norm = "Preview" if str(mode) in ("预览", "Preview", "preview") else "Save"
        is_preview_mode = (mode_norm == "Preview")

        # ── 默认输出（use_default_output=True）：与原「小珠光图像保存」节点逻辑完全一致
        #    忽略 base_dir / 自定义前缀 / 日期戳 / 时间戳，文件名固定 xzg-save_序号，保存在 output/ 根目录
        if use_default_output:
            # 输出目录（与 XiaozhuguangImageSave 完全一致）
            if not is_preview_mode:
                base_dir_full = folder_paths.get_output_directory()
                subfolder = ""
                os.makedirs(base_dir_full, exist_ok=True)
            resolved_prefix = "xzg-save"
            prefix_sep = "_"  # 原节点使用 _ 分隔
            is_absolute_base = False
        else:
            # ── 自定义输出：走原有 base_dir + 前缀/日期戳/时间戳 逻辑 ──
            # 模板上下文：从 extra_pnginfo 提取工作流名
            wf_name = "untitled"
            if extra_pnginfo and isinstance(extra_pnginfo, dict):
                wf = extra_pnginfo.get("workflow") or {}
                name = wf.get("name") or wf.get("filename") or ""
                if name:
                    base = os.path.splitext(os.path.basename(str(name)))[0]
                    if base:
                        wf_name = base

            # 同一次执行共享同一时间戳
            now = datetime.now()
            ctx = {
                "_now": now,
                "workflow_name": wf_name,
                "node_id": unique_id or "",
                "format": save_format,
            }

            # ── 解析模板 ──
            resolved_base = _resolve_template(base_dir or "", ctx)
            # 允许 filename_custom 为空字符串：仅当空且日期戳/时间戳都关时才回退默认 xzg-save
            _custom_raw = filename_custom if filename_custom is not None else ""
            _custom = _resolve_template(_custom_raw, ctx) if _custom_raw else ""
            _custom = _sanitize(_custom) if _custom else ""
            # 日期戳和时间戳独立控制
            _date = _sanitize(_resolve_template("{date}", ctx)) if add_date_stamp else ""
            _time = _sanitize(_resolve_template("{time}", ctx)) if add_time_stamp else ""
            # 日期-时间 拼接
            _dt = ""
            if _date and _time:
                _dt = f"{_date}-{_time}"
            elif _date:
                _dt = _date
            elif _time:
                _dt = _time
            if _dt and _custom:
                resolved_prefix = f"{_dt}-{_custom}"
            elif _dt:
                resolved_prefix = _dt
            elif _custom:
                resolved_prefix = _custom
            else:
                resolved_prefix = "xzg-save"
            # 清理路径中的非法字符
            resolved_base = _sanitize(resolved_base) if resolved_base else ""
            resolved_prefix = resolved_prefix or "xzg-save"

            # ── 输出目录（仅保存模式） ──
            # 优先级：base_dir（绝对路径）> base_dir（相对路径，拼到 ComfyUI output/ 下）> ComfyUI output/
            subfolder = ""
            is_absolute_base = False  # 标记是否使用绝对路径（影响前端下载方式）
            if not is_preview_mode:
                if resolved_base and _is_absolute_path(resolved_base):
                    # base_dir 是绝对路径：直接作为根目录
                    is_absolute_base = True
                    base_dir_full = resolved_base
                    subfolder = resolved_base
                elif resolved_base:
                    # base_dir 是相对路径：拼到 ComfyUI output/ 下
                    base_dir_full = os.path.join(folder_paths.get_output_directory(), resolved_base)
                    subfolder = resolved_base
                else:
                    base_dir_full = folder_paths.get_output_directory()
                os.makedirs(base_dir_full, exist_ok=True)
            prefix_sep = "-"  # 自定义模式用 - 分隔

        # 临时目录（预览图）
        temp_dir = folder_paths.get_temp_directory()
        os.makedirs(temp_dir, exist_ok=True)

        rand = lambda: "".join(random.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(8))

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
                    fname = f"{resolved_prefix}{prefix_sep}{counter:05d}"
                    if save_format == "PNG":
                        full_path = os.path.join(base_dir_full, fname + ".png")
                    else:
                        full_path = os.path.join(base_dir_full, fname + ".jpg")
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

                # 仅当非绝对路径时才提供 saved 信息给前端直接下载
                # 绝对路径无法通过 ComfyUI /view 路由下载（会拼接 output 目录），
                # 此时前端走懒编码（real_token）路径下载全分辨率 PNG
                if not is_absolute_base:
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

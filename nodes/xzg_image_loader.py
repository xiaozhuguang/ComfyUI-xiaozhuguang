import os
import io
import hashlib
import torch
import numpy as np
from PIL import Image, ImageOps
import folder_paths
import node_helpers
from aiohttp import web
from server import PromptServer

# ---------- 小珠光路由安全装饰器 ----------
import asyncio as _xzg_asyncio
import functools as _xzg_ft
import traceback as _xzg_tb
try:
    from aiohttp import web as _xzg_web
except Exception:
    import types as _xzg_t
    _xzg_web = _xzg_t.ModuleType('aiohttp.web')
    class _R:
        def __init__(self, *a, **kw): pass
    _xzg_web.Response = _R
    _xzg_web.json_response = lambda *a, **kw: {'_json': (a, kw)}
    class _HTTPE(Exception): pass
    _xzg_web.HTTPException = _HTTPE

try:
    from .. import xzg_safe_handler as _xsh, _safe_dir as _xsd
    xzg_safe_handler = _xsh
    _safe_dir = _xsd
except Exception:
    def xzg_safe_handler(fn):
        def _fmt_resp(exc, status=500):
            tb_s = ''.join(_xzg_tb.format_exception(type(exc), exc, exc.__traceback__))
            try:
                return _xzg_web.json_response(
                    {'error': '%s: %s' % (type(exc).__name__, exc), 'traceback': tb_s},
                    status=status,
                )
            except Exception:
                return _xzg_web.Response(status=500, text='%s: %s\n\n%s' % (type(exc).__name__, exc, tb_s))
        if _xzg_asyncio.iscoroutinefunction(fn):
            @_xzg_ft.wraps(fn)
            async def _aw(*a, **kw):
                try:
                    return await fn(*a, **kw)
                except _xzg_web.HTTPException:
                    raise
                except BaseException as e:
                    print('[小珠光路由异常] %s: %s: %s' % (fn.__name__, type(e).__name__, e))
                    _xzg_tb.print_exc()
                    return _fmt_resp(e)
            return _aw
        else:
            @_xzg_ft.wraps(fn)
            def _sw(*a, **kw):
                try:
                    return fn(*a, **kw)
                except _xzg_web.HTTPException:
                    raise
                except BaseException as e:
                    print('[小珠光路由异常] %s: %s: %s' % (fn.__name__, type(e).__name__, e))
                    _xzg_tb.print_exc()
                    return _fmt_resp(e)
            return _sw

    def _safe_dir(fn_name, fallback_subdir):
        import folder_paths as _fp
        d = getattr(_fp, fn_name)()
        if d:
            os.makedirs(d, exist_ok=True)
            return d
        fallback = os.path.join(getattr(_fp, 'models_dir', os.getcwd()), fallback_subdir)
        os.makedirs(fallback, exist_ok=True)
        print('[小珠光] folder_paths.%s() 返回 None，兜底使用: %s' % (fn_name, fallback))
        return fallback
# ---------------- END ----------------


def _routes():
    """防御性取 routes：ComfyUI 正常启动时 PromptServer 已有 instance；导入测试阶段则返回临时兜底。"""
    inst = getattr(PromptServer, 'instance', None)
    if inst is not None:
        return inst.routes
    # 兜底：提供最小 duck-typed 路由对象，只保证装饰器语法不炸
    class _Fallback:
        def _noop(self, path):
            def deco(fn): return fn
            return deco
        post = put = delete = patch = get = _noop
    return _Fallback()


routes = _routes()

_thumb_cache_dir = None
DEFAULT_THUMB_SIZE = 256


def _xzg_make_checkerboard(w, h, cell=8, c1=255, c2=220):
    """生成 Photoshop 风格透明指示棋盘格背景（ffffff / dcdcdc 交替）。
    返回 RGB 模式的 PIL Image。cell 为方格边长（像素）。"""
    row_odd = np.tile(np.where(np.arange(w) // cell % 2 == 0, c1, c2), (cell, 1))
    row_even = np.tile(np.where(np.arange(w) // cell % 2 == 1, c1, c2), (cell, 1))
    pair = np.concatenate([row_odd, row_even], axis=0)  # (2*cell, w)
    reps = int(np.ceil(h / (2 * cell)))
    board = np.concatenate([pair] * reps, axis=0)[:h]  # (h, w)
    board_rgb = np.stack([board, board, board], axis=-1).astype(np.uint8)
    return Image.fromarray(board_rgb, "RGB")


def _get_thumb_cache_dir():
    global _thumb_cache_dir
    if _thumb_cache_dir is None:
        _thumb_cache_dir = os.path.join(_safe_dir('get_temp_directory',   'temp'), "xzg_thumbs")
        os.makedirs(_thumb_cache_dir, exist_ok=True)
    return _thumb_cache_dir


def _get_thumb_cache_key(filename, size):
    try:
        filename = _normalize_annotated_filename(filename)
        fpath = folder_paths.get_annotated_filepath(filename)
        if not fpath or not os.path.isfile(fpath):
            return None
        mtime = str(os.path.getmtime(fpath))
        fsize = str(os.path.getsize(fpath))
        # v2: 缓存版本号，区分旧版全 JPEG 缓存（现在 RGBA 输出 PNG）
        raw = f"v2_{filename}_{size}_{mtime}_{fsize}"
        return hashlib.md5(raw.encode('utf-8')).hexdigest()
    except Exception:
        return None


IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tiff", ".tif", ".svg"}


def _parse_crop_data(crop_str):
    """解析前端上传的裁剪矩形 JSON：形如 [x, y, w, h]（原图像素）。
    无效输入返回 None（不裁剪）。"""
    if not crop_str or not str(crop_str).strip():
        return None
    import json as _json
    try:
        v = _json.loads(str(crop_str))
        if isinstance(v, (list, tuple)) and len(v) == 4:
            x, y, w, h = [int(round(float(a))) for a in v]
            if w > 0 and h > 0:
                return (x, y, w, h)
    except Exception:
        pass
    return None


def _clamp_crop(crop, orig_w, orig_h):
    """把裁剪矩形 clamp 到图片范围内，保证至少 1x1 有效。"""
    x, y, w, h = crop
    x = max(0, min(x, max(0, orig_w - 1)))
    y = max(0, min(y, max(0, orig_h - 1)))
    w = max(1, min(w, orig_w - x))
    h = max(1, min(h, orig_h - y))
    return (x, y, w, h)


def _crop_tensor(img_t, crop, orig_w, orig_h):
    """对 IMAGE 张量 (1, H, W, 3) 按原图像素矩形裁剪。"""
    x, y, w, h = _clamp_crop(crop, orig_w, orig_h)
    if x == 0 and y == 0 and w == orig_w and h == orig_h:
        return img_t
    pil = Image.fromarray((img_t[0].numpy() * 255).astype(np.uint8))
    pil = pil.crop((x, y, x + w, y + h))
    arr = np.array(pil).astype(np.float32) / 255.0
    return torch.from_numpy(arr)[None,]


def _crop_mask(mask_t, crop, orig_w, orig_h):
    """对 3D 遮罩 (1, H, W) 按原图像素矩形裁剪。"""
    x, y, w, h = _clamp_crop(crop, orig_w, orig_h)
    return mask_t[:, y:y + h, x:x + w]


def _normalize_annotated_filename(name: str) -> str:
    if not name:
        return name
    for suffix in ("[output]", "[input]", "[temp]"):
        spaced = " " + suffix
        if name.endswith(suffix) and not name.endswith(spaced):
            return name[: -len(suffix)] + spaced
    return name


@routes.get("/xzg_input_files")
@xzg_safe_handler
async def xzg_input_files(request):
    input_dir = _safe_dir('get_input_directory',  'input')
    if not os.path.isdir(input_dir):
        return web.json_response([])

    files = []
    try:
        for f in os.listdir(input_dir):
            full_path = os.path.join(input_dir, f)
            if os.path.isfile(full_path):
                ext = os.path.splitext(f)[1].lower()
                if ext in IMAGE_EXTENSIONS:
                    stat = os.stat(full_path)
                    files.append({
                        "name": f,
                        "type": "image",
                        "size": stat.st_size,
                        "mtime": stat.st_mtime,
                    })
    except Exception as e:
        return web.Response(status=500, text=str(e))

    files.sort(key=lambda x: x["name"].lower())
    return web.json_response(files)


@routes.get("/xzg_output_files")
@xzg_safe_handler
async def xzg_output_files(request):
    output_dir = _safe_dir('get_output_directory', 'output')
    if not os.path.isdir(output_dir):
        return web.json_response([])

    files = []
    try:
        for root, dirs, fnames in os.walk(output_dir):
            for f in fnames:
                ext = os.path.splitext(f)[1].lower()
                if ext in IMAGE_EXTENSIONS:
                    full_path = os.path.join(root, f)
                    rel_path = os.path.relpath(full_path, output_dir)
                    stat = os.stat(full_path)
                    files.append({
                        "name": rel_path.replace("\\", "/"),
                        "type": "image",
                        "size": stat.st_size,
                        "mtime": stat.st_mtime,
                    })
    except Exception as e:
        return web.Response(status=500, text=str(e))

    files.sort(key=lambda x: x["name"].lower())
    return web.json_response(files)


@routes.get("/xzg_image_loader_thumb")
@xzg_safe_handler
async def xzg_image_loader_thumb(request):
    filename = request.rel_url.query.get("filename", "")
    size = int(request.rel_url.query.get("size", str(DEFAULT_THUMB_SIZE)))

    if not filename:
        return web.Response(status=400, text="filename required")

    filename = _normalize_annotated_filename(filename)
    image_path = folder_paths.get_annotated_filepath(filename)
    if not image_path or not os.path.isfile(image_path):
        return web.Response(status=404, text="image not found")

    cache_dir = _get_thumb_cache_dir()
    cache_key = _get_thumb_cache_key(filename, size)
    cache_path = os.path.join(cache_dir, cache_key) if cache_key else None

    etag = cache_key or None
    if_none_match = request.headers.get("If-None-Match", "")
    if etag and if_none_match == etag:
        return web.Response(status=304)

    if cache_path and os.path.isfile(cache_path):
        try:
            with open(cache_path, "rb") as f:
                data = f.read()
            headers = {"Cache-Control": "no-cache"}
            if etag:
                headers["ETag"] = etag
            return web.Response(
                body=data,
                content_type="image/jpeg",
                headers=headers,
            )
        except Exception:
            pass

    try:
        img = node_helpers.pillow(Image.open, image_path)
        img = ImageOps.exif_transpose(img)
        # 有 alpha 通道时合成到棋盘格背景后输出 JPG（保留抠图效果，同时保持 JPG 压缩避免卡顿）
        if 'A' in img.getbands():
            if img.mode != "RGBA":
                img = img.convert("RGBA")
            _cell = max(16, min(40, max(img.size) // 32))
            bg = _xzg_make_checkerboard(img.size[0], img.size[1], cell=_cell).convert("RGBA")
            img = Image.alpha_composite(bg, img).convert("RGB")
        else:
            if img.mode != "RGB":
                img = img.convert("RGB")

        img.thumbnail((size, size), Image.LANCZOS)

        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=90, optimize=False)
        buf.seek(0)
        data = buf.getvalue()

        if cache_path:
            try:
                with open(cache_path, "wb") as f:
                    f.write(data)
            except Exception:
                pass

        headers = {"Cache-Control": "no-cache"}
        if etag:
            headers["ETag"] = etag
        return web.Response(
            body=data,
            content_type="image/jpeg",
            headers=headers,
        )
    except Exception as e:
        return web.Response(status=500, text=str(e))


@routes.get("/xzg_image_info")
@xzg_safe_handler
async def xzg_image_info(request):
    """返回图片原始尺寸（width/height），用于前端分辨率显示。
    轻量实现：仅读取图片头信息，不加载完整像素数据。"""
    filename = request.rel_url.query.get("filename", "")
    if not filename:
        return web.json_response({"error": "filename required"}, status=400)

    filename = _normalize_annotated_filename(filename)
    image_path = folder_paths.get_annotated_filepath(filename)
    if not image_path or not os.path.isfile(image_path):
        return web.json_response({"error": "image not found"}, status=404)

    try:
        with Image.open(image_path) as img:
            w, h = img.size
        return web.json_response({"width": int(w), "height": int(h)})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@routes.post("/xzg_delete_images")
@xzg_safe_handler
async def xzg_delete_images(request):
    try:
        data = await request.json()
    except Exception:
        return web.Response(status=400, text="invalid json")

    filenames = data.get("files", [])
    source = data.get("source", "input")

    if source not in ("input", "output"):
        return web.Response(status=400, text="invalid source")

    if source == "input":
        base_dir = _safe_dir('get_input_directory',  'input')
    else:
        base_dir = _safe_dir('get_output_directory', 'output')

    deleted = []
    errors = []

    for fn in filenames:
        try:
            if not fn:
                continue
            fn_clean = fn
            for suffix in (" [input]", " [output]", " [temp]"):
                if fn_clean.endswith(suffix):
                    fn_clean = fn_clean[: -len(suffix)]
                    break

            full_path = os.path.normpath(os.path.join(base_dir, fn_clean))
            if not full_path.startswith(os.path.normpath(base_dir)):
                errors.append(f"{fn}: path traversal")
                continue
            if not os.path.isfile(full_path):
                errors.append(f"{fn}: not found")
                continue
            os.remove(full_path)
            deleted.append(fn)
        except Exception as e:
            errors.append(f"{fn}: {e}")

    return web.json_response({"deleted": deleted, "errors": errors})


@routes.post("/xzg_copy_output_to_input")
@xzg_safe_handler
async def xzg_copy_output_to_input(request):
    try:
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"copied": [], "errors": ["invalid json"]}, status=400)

        filenames = data.get("files", [])
        output_dir = _safe_dir('get_output_directory', 'output')
        input_dir = _safe_dir('get_input_directory',  'input')

        copied = []
        errors = []

        import shutil

        for fn in filenames:
            try:
                if not fn:
                    continue

                src_path = os.path.normpath(os.path.join(output_dir, fn))
                if not src_path.startswith(os.path.normpath(output_dir)):
                    errors.append(f"{fn}: path traversal")
                    continue
                if not os.path.isfile(src_path):
                    errors.append(f"{fn}: not found")
                    continue

                basename = os.path.basename(fn)
                dst_name = basename
                dst_path = os.path.join(input_dir, dst_name)

                if os.path.exists(dst_path):
                    copied.append({"original": fn, "input_name": dst_name})
                    continue

                shutil.copy2(src_path, dst_path)
                copied.append({"original": fn, "input_name": dst_name})
            except Exception as e:
                errors.append(f"{fn}: {e}")

        return web.json_response({"copied": copied, "errors": errors})
    except Exception as e:
        return web.json_response({"copied": [], "errors": [str(e)]}, status=500)


class XiaozhuguangImageLoader:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image_list": ("STRING", {"default": ""}),
                "index": ("INT", {"default": 0, "min": 0, "max": 999999}),
                "batch_mode": ("BOOLEAN", {"default": True, "label_on": "批次", "label_off": "列表"}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "mask_data": ("STRING", {"default": ""}),
                "crop_data": ("STRING", {"default": ""}),  # 裁剪矩形 [x,y,w,h]，仅单图模式使用
                "upload_mode": ("STRING", {"default": "append"}),  # append=多图 / replace=单图，前端持久化用
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("images", "mask")
    OUTPUT_IS_LIST = (True, False)
    FUNCTION = "load_images"
    CATEGORY = "xiaozhuguang"

    def load_images(self, image_list, index, batch_mode, unique_id=None, mask_data="", crop_data="", upload_mode="append"):
        # 调试：打印遮罩数据长度
        mask_len = len(mask_data) if mask_data else 0
        print(f"[小珠光图像加载器] mask_data 长度: {mask_len}, 前50字符: {str(mask_data)[:50]}")
        # 空图或无效输入时返回空遮罩（3D 形状匹配官方 LoadImage 默认值）
        empty_mask = torch.zeros((1, 64, 64), dtype=torch.float32)
        if not image_list or not image_list.strip():
            return ([], empty_mask)

        names = [n.strip() for n in image_list.split("\n") if n.strip()]
        if not names:
            return ([], empty_mask)

        # 裁剪矩形（仅单图/列表模式生效，作用于 index 指向的图）
        crop = _parse_crop_data(crop_data)

        images = []
        orig_sizes = []  # 每张图裁剪前的原始尺寸 (w, h)
        image_alphas = []  # 每张图的 alpha 通道（无 alpha 则 None），用于无用户遮罩时回退提取
        for name in names:
            try:
                name_norm = _normalize_annotated_filename(name)
                image_path = folder_paths.get_annotated_filepath(name_norm)
                if not image_path or not os.path.isfile(image_path):
                    continue

                img = node_helpers.pillow(Image.open, image_path)
                img = ImageOps.exif_transpose(img)
                orig_sizes.append(img.size)  # (w, h)
                # 在 convert("RGB") 之前提取 alpha 通道（与官方 LoadImage 一致）
                alpha = img.getchannel('A') if 'A' in img.getbands() else None
                image = img.convert("RGB")
                image = np.array(image).astype(np.float32) / 255.0
                image = torch.from_numpy(image)[None,]
                images.append(image)
                image_alphas.append(alpha)
            except Exception:
                continue

        # 解析遮罩数据
        # 语义约定：白色(255 / 1.0) = 用户绘制过的区域；黑色(0 / 0.0) = 未绘制区域
        # 无用户遮罩数据时，从图片 alpha 通道提取（与官方 LoadImage 行为一致）：
        #   alpha=255(不透明)→mask=0(未遮罩)，alpha=0(透明)→mask=1(已遮罩)
        # 所有返回均为 3D 张量 (1, H, W)，匹配官方 LoadImage 的 MASK 输出形状
        def _decode_mask(mask_str, ref_h, ref_w, pil_alpha=None):
            if ref_h <= 0 or ref_w <= 0:
                return torch.zeros((1, max(1, ref_h), max(1, ref_w)), dtype=torch.float32)
            if not mask_str:
                # 无用户绘制的遮罩，尝试从图片 alpha 通道提取（与官方 LoadImage 一致）
                if pil_alpha is not None:
                    try:
                        if pil_alpha.size != (ref_w, ref_h):
                            pil_alpha = pil_alpha.resize((ref_w, ref_h), Image.LANCZOS)
                        arr = np.array(pil_alpha).astype(np.float32) / 255.0
                        # 反转：alpha=255(不透明)→mask=0，alpha=0(透明)→mask=1
                        mask = 1. - torch.from_numpy(arr)
                        return mask.unsqueeze(0)  # (1, H, W) — 3D
                    except Exception as e:
                        print(f"[小珠光图像加载器] alpha 遮罩提取失败: {e}")
                return torch.zeros((1, ref_h, ref_w), dtype=torch.float32)
            try:
                # 支持 "data:image/png;base64,xxx" 格式或纯 base64
                if mask_str.startswith("data:"):
                    import base64
                    _, b64part = mask_str.split(",", 1)
                    raw = base64.b64decode(b64part)
                else:
                    import base64
                    raw = base64.b64decode(mask_str)
                mask_pil = Image.open(io.BytesIO(raw)).convert("L")
                if mask_pil.size != (ref_w, ref_h):
                    mask_pil = mask_pil.resize((ref_w, ref_h), Image.LANCZOS)
                arr = np.array(mask_pil).astype(np.float32) / 255.0
                return torch.from_numpy(arr).unsqueeze(0)  # (1, H, W) — 3D
            except Exception as e:
                print(f"[小珠光图像加载器] 遮罩解码失败: {e}")
                return torch.zeros((1, ref_h, ref_w), dtype=torch.float32)

        # 裁剪：对 index 指向的图生效，与 batch_mode 无关（兼容单图模式批次/列表）
        # 仅当存在裁剪矩形且索引有效时应用
        idx = max(0, min(int(index), len(images) - 1)) if images else 0
        # 记录裁剪前后尺寸，供遮罩同步
        crop_src_idx = None   # 被裁剪的图片索引
        crop_orig_size = None # 该图片裁剪前的原始尺寸 (w, h)
        if crop and images and 0 <= idx < len(images):
            crop_orig_size = orig_sizes[idx]
            ow, oh = crop_orig_size
            # 前端裁剪坐标取自「最长边3840px」的压缩预览图（preview）。
            # 原图最长边 >3840 时需把预览坐标按比例换算回原图像素，否则大图裁剪位置错位。
            spr = max(ow, oh)
            if spr > 3840:
                ratio = spr / 3840.0
                crop = (int(round(crop[0] * ratio)),
                        int(round(crop[1] * ratio)),
                        int(round(crop[2] * ratio)),
                        int(round(crop[3] * ratio)))
            images[idx] = _crop_tensor(images[idx], crop, ow, oh)
            crop_src_idx = idx

        if batch_mode:
            if len(images) == 0:
                return ([], torch.zeros((1, 64, 64), dtype=torch.float32))

            max_h = max(img.shape[1] for img in images)
            max_w = max(img.shape[2] for img in images)

            resized = []
            for img in images:
                _, h, w, _ = img.shape

                if h == max_h and w == max_w:
                    resized.append(img)
                    continue

                scale = max(max_h / h, max_w / w)
                new_h = int(round(h * scale))
                new_w = int(round(w * scale))

                img_pil = Image.fromarray((img[0].numpy() * 255).astype(np.uint8))
                img_pil = img_pil.resize((new_w, new_h), Image.LANCZOS)

                left = (new_w - max_w) // 2
                top = (new_h - max_h) // 2
                img_pil = img_pil.crop((left, top, left + max_w, top + max_h))

                arr = np.array(img_pil).astype(np.float32) / 255.0
                tensor = torch.from_numpy(arr)[None,]
                resized.append(tensor)

            batch = torch.cat(resized, dim=0)
            # 批次模式下遮罩尺寸对齐到批次尺寸，用 index 对应的图参考尺寸解码
            ref_h, ref_w = max_h, max_w
            idx = max(0, min(int(index), len(image_alphas) - 1)) if image_alphas else 0
            ref_alpha = image_alphas[idx] if 0 <= idx < len(image_alphas) else None
            if crop_src_idx is not None and crop_orig_size is not None:
                # 遮罩需与裁剪同步：先用原尺寸解码，再把裁剪区域裁出来
                ow, oh = crop_orig_size
                mask_full = _decode_mask(mask_data, oh, ow, ref_alpha)
                mask_out = _crop_mask(mask_full, crop, ow, oh)
                # 若裁剪后其它图被拉到批次尺寸，遮罩也需对齐（单图模式通常无需）
                if batch.shape[0] > 1 and mask_out.shape[0] == 1:
                    mask_out = mask_out.repeat(batch.shape[0], 1, 1)
            else:
                mask_out = _decode_mask(mask_data, ref_h, ref_w, ref_alpha)
                # 批次模式下将遮罩扩展到与批次相同的数量 (N, H, W)
                if batch.shape[0] > 1 and mask_out.shape[0] == 1:
                    mask_out = mask_out.repeat(batch.shape[0], 1, 1)
            return ([batch], mask_out)
        else:
            # 列表模式：每张图独立放入列表，OUTPUT_IS_LIST 驱动下游 N 次执行
            # 遮罩对齐到 index 对应的图像尺寸
            idx = max(0, min(int(index), len(images) - 1)) if images else 0
            if len(images) > 0 and 0 <= idx < len(images):
                _, ref_h, ref_w, _ = images[idx].shape
            else:
                ref_h, ref_w = 64, 64
            ref_alpha = image_alphas[idx] if 0 <= idx < len(image_alphas) else None
            if crop_src_idx is not None and crop_orig_size is not None:
                # 遮罩需与裁剪同步：先用原尺寸解码，再把裁剪区域裁出来
                ow, oh = crop_orig_size
                mask_full = _decode_mask(mask_data, oh, ow, ref_alpha)
                mask_out = _crop_mask(mask_full, crop, ow, oh)
            else:
                mask_out = _decode_mask(mask_data, ref_h, ref_w, ref_alpha)
            return (images, mask_out)


NODE_CLASS_MAPPINGS = {
    "XiaozhuguangImageLoader": XiaozhuguangImageLoader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XiaozhuguangImageLoader": "小珠光图像加载器",
}

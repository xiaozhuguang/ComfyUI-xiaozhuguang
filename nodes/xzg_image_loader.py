import os
import io
import hashlib
import json
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


def _parse_crop_data(crop_str, image_name=None):
    """解析前端上传的裁剪矩形 JSON。
    支持两种格式：
    1. 旧格式：[x, y, w, h]（原图像素），直接返回
    2. 新格式：{ "图片名1": [x,y,w,h], "图片名2": [x,y,w,h], ... }
       按 image_name 从映射中提取对应图片的裁剪区域（每张图独立维护裁剪）。
    无效输入返回 None（不裁剪）。"""
    if not crop_str or not str(crop_str).strip():
        return None
    try:
        v = json.loads(str(crop_str))
        if isinstance(v, (list, tuple)) and len(v) == 4:
            # 旧格式：纯数组，直接返回（兼容旧工作流）
            x, y, w, h = [int(round(float(a))) for a in v]
            if w > 0 and h > 0:
                return (x, y, w, h)
        if isinstance(v, dict) and image_name:
            # 新格式：映射，按当前图片名提取
            # 尝试精确匹配，然后尝试去掉 [output]/[input]/[temp] 后缀匹配
            names_to_try = [image_name]
            base_name = image_name
            for suffix in [" [output]", " [input]", " [temp]", "[output]", "[input]", "[temp]"]:
                if base_name.endswith(suffix):
                    base_name = base_name[:-len(suffix)]
                    break
            if base_name != image_name:
                names_to_try.append(base_name)
            for name in names_to_try:
                if name in v and isinstance(v[name], (list, tuple)) and len(v[name]) == 4:
                    x, y, w, h = [int(round(float(a))) for a in v[name]]
                    if w > 0 and h > 0:
                        return (x, y, w, h)
    except Exception:
        pass
    return None


def _parse_mask_data(mask_str, image_name=None):
    """解析旧版单张遮罩或按图片名保存的遮罩映射。"""
    if not mask_str or not str(mask_str).strip():
        return ""
    value = str(mask_str).strip()
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return value
    if not isinstance(parsed, dict) or not image_name:
        return ""
    # 前端会以界面文件名保存键；后端可能收到带/不带空格的注释文件名。
    names_to_try = [image_name]
    normalized = _normalize_annotated_filename(image_name)
    if normalized not in names_to_try:
        names_to_try.append(normalized)
    for suffix in (" [output]", " [input]", " [temp]"):
        if normalized.endswith(suffix):
            base_name = normalized[:-len(suffix)]
            if base_name not in names_to_try:
                names_to_try.append(base_name)
            break
    for name in names_to_try:
        data = parsed.get(name)
        if isinstance(data, str) and data:
            return data
    return ""


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
                        # 给 output 图片保留来源标记，避免与 input 中同名文件混淆。
                        "name": _normalize_annotated_filename(rel_path.replace("\\", "/") + " [output]"),
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
    if filename.endswith(" [output]"):
        rel_path = filename[:-len(" [output]")]
        output_dir = os.path.realpath(_safe_dir('get_output_directory', 'output'))
        image_path = os.path.realpath(os.path.join(output_dir, rel_path))
        if os.path.commonpath([output_dir, image_path]) != output_dir:
            return web.Response(status=400, text="invalid output path")
    else:
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

                fn_clean = fn[:-len(" [output]")] if fn.endswith(" [output]") else fn
                output_root = os.path.realpath(output_dir)
                src_path = os.path.realpath(os.path.join(output_root, fn_clean))
                if os.path.commonpath([output_root, src_path]) != output_root:
                    errors.append(f"{fn}: path traversal")
                    continue
                if not os.path.isfile(src_path):
                    errors.append(f"{fn}: not found")
                    continue

                basename = os.path.basename(fn_clean)
                stem, ext = os.path.splitext(basename)
                dst_name = basename
                dst_path = os.path.join(input_dir, dst_name)
                # 同名 input 文件可能是另一张图，不能将它误认为已复制的 output 图片。
                # 给 output 副本分配稳定且唯一的名称，保证后续 annotated lookup 命中正确内容。
                suffix = 1
                while os.path.exists(dst_path):
                    dst_name = f"{stem}_output_{suffix}{ext}"
                    dst_path = os.path.join(input_dir, dst_name)
                    suffix += 1

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
                "batch_align": ("BOOLEAN", {"default": False, "label_on": "留边", "label_off": "裁剪"}),
                "max_images": ("INT", {"default": 0, "min": 0, "max": 999999, "step": 1}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "mask_data": ("STRING", {"default": ""}),
                "crop_data": ("STRING", {"default": ""}),  # 裁剪矩形 [x,y,w,h]，仅单图模式使用
                "upload_mode": ("STRING", {"default": "append"}),  # append=多图 / replace=单图，前端持久化用
                "mask_output_enabled": ("BOOLEAN", {"default": False}),
                "mask_output_color": ("STRING", {"default": "#ff0000"}),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("images", "mask")
    OUTPUT_IS_LIST = (True, True)
    FUNCTION = "load_images"
    CATEGORY = "xiaozhuguang"

    def load_images(self, image_list, index, batch_mode, batch_align=False, max_images=0, unique_id=None, mask_data="", crop_data="", upload_mode="append", mask_output_enabled=False, mask_output_color="#ff0000"):
        mask_output_enabled = mask_output_enabled is True or str(mask_output_enabled).strip().lower() in ("true", "1")
        if not image_list or not image_list.strip():
            return ([], [])

        names = [n.strip() for n in image_list.split("\n") if n.strip()]
        if not names:
            return ([], [])

        # 裁剪矩形改为逐图解析（见下方 crops_loaded）：每张图按自己的映射矩形独立裁剪

        images = []
        loaded_names = []
        orig_sizes = []  # 每张图裁剪前的原始尺寸 (w, h)
        image_alphas = []  # 每张图的 alpha 通道（无 alpha 则 None），用于无用户遮罩时回退提取
        crops_loaded = []  # 与 images 对齐，每张图自己的裁剪矩形（原图像素，None=该图不裁剪）
        for name in names:
            try:
                name_norm = _normalize_annotated_filename(name)
                if name_norm.endswith(" [output]"):
                    output_root = os.path.realpath(_safe_dir('get_output_directory', 'output'))
                    rel_path = name_norm[:-len(" [output]")]
                    image_path = os.path.realpath(os.path.join(output_root, rel_path))
                    if os.path.commonpath([output_root, image_path]) != output_root:
                        continue
                else:
                    image_path = folder_paths.get_annotated_filepath(name_norm)
                if not image_path or not os.path.isfile(image_path):
                    continue

                img = node_helpers.pillow(Image.open, image_path)
                img = ImageOps.exif_transpose(img)
                orig_size = img.size  # (w, h)
                # 每张图独立裁剪：解析该图在映射中的矩形，把"压缩预览(3840)"坐标换算回原图像素
                _crop_i = _parse_crop_data(crop_data, name)
                if _crop_i:
                    _ow0, _oh0 = orig_size
                    _spr0 = max(_ow0, _oh0)
                    if _spr0 > 3840:
                        _ratio0 = _spr0 / 3840.0
                        _crop_i = (int(round(_crop_i[0] * _ratio0)),
                                   int(round(_crop_i[1] * _ratio0)),
                                   int(round(_crop_i[2] * _ratio0)),
                                   int(round(_crop_i[3] * _ratio0)))
                # 在 convert("RGB") 之前提取 alpha 通道（与官方 LoadImage 一致）
                alpha = img.getchannel('A') if 'A' in img.getbands() else None
                image = img.convert("RGB")
                image = np.array(image).astype(np.float32) / 255.0
                image = torch.from_numpy(image)[None,]
                images.append(image)
                loaded_names.append(name)
                orig_sizes.append(orig_size)
                image_alphas.append(alpha)
                # 仅在图成功载入 images 后再对齐追加裁剪，避免失败图导致列表错位
                crops_loaded.append(_crop_i)
            except Exception:
                continue

        # 加载图片上限：max_images>0 时最多加载前 N 张（默认 0 表示无限制），对批次/列表模式均生效
        try:
            limit = int(max_images)
        except (TypeError, ValueError):
            limit = 0
        if limit > 0:
            images = images[:limit]
            loaded_names = loaded_names[:limit]
            orig_sizes = orig_sizes[:limit]
            image_alphas = image_alphas[:limit]
            crops_loaded = crops_loaded[:limit]

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
                import base64
                # 支持 "data:image/png;base64,xxx" 格式或纯 base64
                if mask_str.startswith("data:"):
                    _, b64part = mask_str.split(",", 1)
                else:
                    b64part = mask_str
                # 容错修复：工作流 JSON 保存/载入/复制往返可能丢失 '=' 填充或混入空白/引号，
                # 这里只保留合法 base64 字符并按长度补齐填充，避免 Incorrect padding
                b64part = "".join(ch for ch in str(b64part).strip() if ch in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=")
                b64part += "=" * ((4 - len(b64part) % 4) % 4)
                # 1) 过滤/补齐后只剩填充或空 → 用户从未画过遮罩（常见 data: 前缀后空、只有脏字符），不告警
                if not b64part or b64part.strip("=") == "":
                    return torch.zeros((1, ref_h, ref_w), dtype=torch.float32)
                raw = base64.b64decode(b64part)
                # 2) 解码后字节过小（<8 字节的 PNG 签名也不够）→ 无效脏数据，不告警
                if len(raw) < 8:
                    return torch.zeros((1, ref_h, ref_w), dtype=torch.float32)
                mask_pil = Image.open(io.BytesIO(raw)).convert("L")
                if mask_pil.size != (ref_w, ref_h):
                    mask_pil = mask_pil.resize((ref_w, ref_h), Image.LANCZOS)
                arr = np.array(mask_pil).astype(np.float32) / 255.0
                return torch.from_numpy(arr).unsqueeze(0)  # (1, H, W) — 3D
            except Exception as e:
                # 3) 真正的解码失败（有完整 base64 payload 也解出足量字节，但 PIL 无法识别），才打印告警
                print(f"[小珠光图像加载器] 遮罩解码失败: {e}")
                return torch.zeros((1, ref_h, ref_w), dtype=torch.float32)

        # 合成只作用于 IMAGE，独立的 MASK 输出保持原始遮罩值不变。
        overlay_rgb = (1.0, 0.0, 0.0)
        try:
            color = str(mask_output_color or "#ff0000").strip()
            if len(color) == 7 and color.startswith("#"):
                overlay_rgb = tuple(int(color[i:i + 2], 16) / 255.0 for i in (1, 3, 5))
        except (TypeError, ValueError):
            pass

        def _apply_mask_tint(image_tensor, mask_tensor):
            # IMAGE 输出是硬边纯色覆盖，不沿用编辑器预览的半透明度。
            alpha = (mask_tensor >= 0.5).to(dtype=image_tensor.dtype).unsqueeze(-1)
            color_tensor = torch.tensor(overlay_rgb, dtype=image_tensor.dtype, device=image_tensor.device)
            return (image_tensor * (1.0 - alpha) + color_tensor * alpha).clamp(0.0, 1.0)

        # 逐图裁剪图片与遮罩，保持每个输出项同尺寸。
        for _ci, _crop in enumerate(crops_loaded):
            if _crop:
                _ow, _oh = orig_sizes[_ci]
                images[_ci] = _crop_tensor(images[_ci], _crop, _ow, _oh)

        masks = []
        for i, name in enumerate(loaded_names):
            orig_w, orig_h = orig_sizes[i]
            mask = _decode_mask(_parse_mask_data(mask_data, name), orig_h, orig_w, image_alphas[i])
            if crops_loaded[i]:
                mask = _crop_mask(mask, crops_loaded[i], orig_w, orig_h)
            masks.append(mask)

        if batch_mode:
            if len(images) == 0:
                return ([], [])

            # 目标尺寸：批次内所有图最长边的最大值，以第一张图的宽高比为基准
            first_h, first_w = images[0].shape[1], images[0].shape[2]
            max_long = max(max(img.shape[1], img.shape[2]) for img in images)
            if first_w >= first_h:
                max_w = max_long
                max_h = max(1, int(round(max_long * first_h / first_w)))
            else:
                max_h = max_long
                max_w = max(1, int(round(max_long * first_w / first_h)))

            use_letterbox = bool(batch_align)

            resized = []
            resized_masks = []
            for img, mask in zip(images, masks):
                _, h, w, _ = img.shape

                if h == max_h and w == max_w:
                    resized.append(img)
                    resized_masks.append(mask)
                    continue

                img_pil = Image.fromarray((img[0].numpy() * 255).astype(np.uint8))
                mask_pil = Image.fromarray((mask[0].numpy() * 255).clip(0, 255).astype(np.uint8))
                if use_letterbox:
                    # letterbox 留边：等比缩放至完全放入 max_w×max_h，四周用黑色填充补齐
                    scale = min(max_h / h, max_w / w)
                    new_h = max(1, int(round(h * scale)))
                    new_w = max(1, int(round(w * scale)))
                    img_pil = img_pil.resize((new_w, new_h), Image.LANCZOS)
                    canvas = Image.new("RGB", (max_w, max_h), (0, 0, 0))
                    left = (max_w - new_w) // 2
                    top = (max_h - new_h) // 2
                    canvas.paste(img_pil, (left, top))
                    img_pil = canvas
                    mask_pil = mask_pil.resize((new_w, new_h), Image.LANCZOS)
                    mask_canvas = Image.new("L", (max_w, max_h), 0)
                    mask_canvas.paste(mask_pil, (left, top))
                    mask_pil = mask_canvas
                else:
                    # 裁剪对齐（默认）：等比放大铺满 max_w×max_h，居中裁剪超出的长边
                    scale = max(max_h / h, max_w / w)
                    new_h = int(round(h * scale))
                    new_w = int(round(w * scale))
                    img_pil = img_pil.resize((new_w, new_h), Image.LANCZOS)
                    left = (new_w - max_w) // 2
                    top = (new_h - max_h) // 2
                    img_pil = img_pil.crop((left, top, left + max_w, top + max_h))
                    mask_pil = mask_pil.resize((new_w, new_h), Image.LANCZOS)
                    mask_pil = mask_pil.crop((left, top, left + max_w, top + max_h))

                arr = np.array(img_pil).astype(np.float32) / 255.0
                tensor = torch.from_numpy(arr)[None,]
                resized.append(tensor)
                mask_arr = np.array(mask_pil).astype(np.float32) / 255.0
                resized_masks.append(torch.from_numpy(mask_arr).unsqueeze(0))

            batch = torch.cat(resized, dim=0)
            mask_batch = torch.cat(resized_masks, dim=0)
            if mask_output_enabled:
                batch = _apply_mask_tint(batch, mask_batch)
            return ([batch], [mask_batch])
        else:
            if mask_output_enabled:
                images = [_apply_mask_tint(image, mask) for image, mask in zip(images, masks)]
            return (images, masks)


NODE_CLASS_MAPPINGS = {
    "XiaozhuguangImageLoader": XiaozhuguangImageLoader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XiaozhuguangImageLoader": "小珠光图片加载器-化神级",
}

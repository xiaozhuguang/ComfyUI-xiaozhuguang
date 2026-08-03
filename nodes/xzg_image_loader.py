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
        raw = f"{filename}_{size}_{mtime}_{fsize}"
        return hashlib.md5(raw.encode('utf-8')).hexdigest() + ".jpg"
    except Exception:
        return None


IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tiff", ".tif", ".svg"}


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
                "batch_mode": ("BOOLEAN", {"default": True}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "mask_data": ("STRING", {"default": ""}),
                "upload_mode": ("STRING", {"default": "append"}),  # append=多图 / replace=单图，前端持久化用
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("图像", "遮罩")
    OUTPUT_IS_LIST = (True, False)
    FUNCTION = "load_images"
    CATEGORY = "xiaozhuguang"

    def load_images(self, image_list, index, batch_mode, unique_id=None, mask_data="", upload_mode="append"):
        # 调试：打印遮罩数据长度
        mask_len = len(mask_data) if mask_data else 0
        print(f"[小珠光图像加载器] mask_data 长度: {mask_len}, 前50字符: {str(mask_data)[:50]}")
        # 空图或无效输入时返回全黑遮罩（未绘制=没有任何区域被遮罩）
        empty_mask = torch.zeros((1, 1), dtype=torch.float32)
        if not image_list or not image_list.strip():
            return ([], empty_mask)

        names = [n.strip() for n in image_list.split("\n") if n.strip()]
        if not names:
            return ([], empty_mask)

        images = []
        for name in names:
            try:
                name_norm = _normalize_annotated_filename(name)
                image_path = folder_paths.get_annotated_filepath(name_norm)
                if not image_path or not os.path.isfile(image_path):
                    continue

                img = node_helpers.pillow(Image.open, image_path)
                img = ImageOps.exif_transpose(img)
                image = img.convert("RGB")
                image = np.array(image).astype(np.float32) / 255.0
                image = torch.from_numpy(image)[None,]
                images.append(image)
            except Exception:
                continue

        # 解析遮罩数据（单图模式使用第一张图的尺寸）
        # 语义约定：白色(255 / 1.0) = 用户绘制过的区域；黑色(0 / 0.0) = 未绘制区域
        # —— 无数据或失败时返回全黑(zeros)，代表"没画任何东西，没遮罩任何部分"
        def _decode_mask(mask_str, ref_h, ref_w):
            if ref_h <= 0 or ref_w <= 0:
                return torch.zeros((max(1, ref_h), max(1, ref_w)), dtype=torch.float32)
            if not mask_str:
                return torch.zeros((ref_h, ref_w), dtype=torch.float32)
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
                return torch.from_numpy(arr)
            except Exception as e:
                print(f"[小珠光图像加载器] 遮罩解码失败: {e}")
                return torch.zeros((ref_h, ref_w), dtype=torch.float32)

        if batch_mode:
            if len(images) == 0:
                return ([], torch.zeros((1, 1), dtype=torch.float32))

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
            mask_out = _decode_mask(mask_data, ref_h, ref_w)
            return ([batch], mask_out)
        else:
            # 列表模式：每张图独立放入列表，OUTPUT_IS_LIST 驱动下游 N 次执行
            # 遮罩对齐到 index 对应的图像尺寸
            idx = max(0, min(int(index), len(images) - 1)) if images else 0
            if len(images) > 0 and 0 <= idx < len(images):
                _, ref_h, ref_w, _ = images[idx].shape
            else:
                ref_h, ref_w = 1, 1
            mask_out = _decode_mask(mask_data, ref_h, ref_w)
            return (images, mask_out)


NODE_CLASS_MAPPINGS = {
    "XiaozhuguangImageLoader": XiaozhuguangImageLoader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XiaozhuguangImageLoader": "小珠光图像加载器",
}

import os
import io
import hashlib
import time
import json
import base64
import shutil
import tempfile
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
_media_thumb_cache_dir = None
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


def _get_media_thumb_cache_dir():
    global _media_thumb_cache_dir
    if _media_thumb_cache_dir is None:
        # 媒体库缩略图缓存放系统临时目录（与其他图片缩略图同类位置），每月自动清理，不占用 ComfyUI 项目目录
        try:
            root = tempfile.gettempdir()
        except Exception:
            root = _media_library_dir()
        _media_thumb_cache_dir = os.path.join(root, "xiaozhuguang", "xzg_media_thumbs")
        os.makedirs(_media_thumb_cache_dir, exist_ok=True)
    return _media_thumb_cache_dir


def _clean_media_thumb_cache(max_age_days=30):
    """定期清理超过指定天数未使用的媒体库缩略图缓存（默认保留最近 1 个月）。"""
    try:
        cache_dir = _get_media_thumb_cache_dir()
        if not os.path.isdir(cache_dir):
            return
        cutoff = time.time() - max_age_days * 86400
        with os.scandir(cache_dir) as entries:
            for entry in entries:
                if not entry.name.startswith("media_"):
                    continue
                try:
                    st = entry.stat()
                    if st.st_mtime < cutoff:
                        os.remove(entry.path)
                except OSError:
                    pass
    except Exception:
        pass


def _clear_thumb_cache_on_startup():
    """每次载入节点模块时清理 input/output 缩略图的后端磁盘缓存。"""
    try:
        temp_root = os.path.realpath(_safe_dir('get_temp_directory', 'temp'))
        cache_dir = os.path.join(temp_root, "xzg_thumbs")
        # 只处理预期的直属缓存目录；不跟随目录或文件符号链接。
        if os.path.islink(cache_dir) or not os.path.isdir(cache_dir):
            return
        removed = 0
        with os.scandir(cache_dir) as entries:
            for entry in entries:
                if (len(entry.name) != 32 or
                        any(ch not in "0123456789abcdef" for ch in entry.name) or
                        not entry.is_file(follow_symlinks=False)):
                    continue
                try:
                    os.remove(entry.path)
                    removed += 1
                except OSError as exc:
                    print(f"[小珠光图片加载器] 清理缩略图失败: {entry.name}: {exc}")
        if removed:
            print(f"[小珠光图片加载器] 启动时已清理 {removed} 个 input/output 缩略图缓存")
    except OSError as exc:
        print(f"[小珠光图片加载器] 启动时清理缩略图缓存失败: {exc}")


_clear_thumb_cache_on_startup()


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
MEDIA_IMAGE_EXTENSIONS = IMAGE_EXTENSIONS - {".svg"}
MEDIA_MAX_FILE_BYTES = 100 * 1024 * 1024


def _media_library_dir():
    """媒体库文件保存在 ComfyUI 用户目录，供同一后端的浏览器会话共享。"""
    base = folder_paths.get_user_directory()
    path = os.path.join(base, "xiaozhuguang", "media_library", "images")
    os.makedirs(path, exist_ok=True)
    return path


def _media_order_path():
    return os.path.join(os.path.dirname(_media_library_dir()), "order.json")


def _media_ordered_names(directory):
    available = []
    for name in os.listdir(directory):
        if _media_safe_name(name) and os.path.isfile(os.path.join(directory, name)):
            available.append(name)
    available.sort(key=lambda name: os.path.getmtime(os.path.join(directory, name)), reverse=True)
    try:
        with open(_media_order_path(), "r", encoding="utf-8") as source:
            saved = json.load(source)
        if not isinstance(saved, list):
            saved = []
    except (OSError, ValueError):
        saved = []
    current = set(available)
    ordered = []
    seen = set()
    for name in saved + available:
        if isinstance(name, str) and name in current and name not in seen:
            ordered.append(name)
            seen.add(name)
    return ordered


def _media_write_order(names):
    target = _media_order_path()
    fd, temp_path = tempfile.mkstemp(prefix=".order-", dir=os.path.dirname(target))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            json.dump(names, out, ensure_ascii=False)
        os.replace(temp_path, target)
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)


def _media_safe_name(name):
    if not isinstance(name, str) or not name or len(name) > 240:
        return None
    if name != os.path.basename(name) or "/" in name or "\\" in name or name in (".", ".."):
        return None
    if name.rstrip(" .") != name or any(ord(ch) < 32 or ch in '<>:"|?*' for ch in name):
        return None
    if os.path.splitext(name)[0].upper() in {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}:
        return None
    if os.path.splitext(name)[1].lower() not in MEDIA_IMAGE_EXTENSIONS:
        return None
    return name


def _media_unique_name(directory, name):
    stem, ext = os.path.splitext(name)
    candidate = name
    n = 1
    while os.path.exists(os.path.join(directory, candidate)):
        candidate = f"{stem}_{n}{ext}"
        n += 1
    return candidate


def _media_validate_image(path):
    with Image.open(path) as img:
        img.verify()


@routes.get("/xzg/media-library")
@xzg_safe_handler
async def xzg_media_library_list(request):
    directory = _media_library_dir()
    items = []
    for name in _media_ordered_names(directory):
        path = os.path.join(directory, name)
        if os.path.isfile(path):
            stat = os.stat(path)
            version = f"{stat.st_mtime_ns}-{stat.st_ctime_ns}-{stat.st_size}"
            items.append({"name": name, "size": stat.st_size, "mtime": stat.st_mtime, "version": version})
    return web.json_response({"items": items}, headers={"Cache-Control": "no-store"})


@routes.put("/xzg/media-library/order")
@xzg_safe_handler
async def xzg_media_library_order(request):
    data = await request.json()
    names = data.get("names")
    directory = _media_library_dir()
    current = _media_ordered_names(directory)
    if not isinstance(names, list) or any(not isinstance(name, str) for name in names) or len(names) != len(current) or set(names) != set(current):
        return web.json_response({"error": "invalid image order"}, status=400)
    _media_write_order(names)
    return web.json_response({"names": names})


@routes.put("/xzg/media-library/rename")
@xzg_safe_handler
async def xzg_media_library_rename(request):
    data = await request.json()
    old_name = _media_safe_name(data.get("old_name"))
    new_name = _media_safe_name(data.get("new_name"))
    if not old_name or not new_name:
        return web.json_response({"error": "invalid image name"}, status=400)
    if os.path.splitext(old_name)[1].lower() != os.path.splitext(new_name)[1].lower():
        return web.json_response({"error": "image extension cannot change"}, status=400)
    directory = _media_library_dir()
    old_path = os.path.join(directory, old_name)
    new_path = os.path.join(directory, new_name)
    if not os.path.isfile(old_path):
        return web.json_response({"error": "image not found"}, status=404)
    if new_name == old_name:
        return web.json_response({"name": old_name})
    case_only_rename = os.path.normcase(old_path) == os.path.normcase(new_path)
    if os.path.exists(new_path) and not case_only_rename:
        return web.json_response({"error": "image name already exists"}, status=409)
    order = _media_ordered_names(directory)
    if case_only_rename:
        fd, temp_path = tempfile.mkstemp(prefix=".rename-", dir=directory)
        os.close(fd)
        os.remove(temp_path)
        os.rename(old_path, temp_path)
        try:
            os.rename(temp_path, new_path)
        except Exception:
            os.rename(temp_path, old_path)
            raise
    else:
        os.rename(old_path, new_path)
    _media_write_order([new_name if name == old_name else name for name in order])
    return web.json_response({"name": new_name})


@routes.get("/xzg/media-library/file")
@xzg_safe_handler
async def xzg_media_library_file(request):
    name = _media_safe_name(request.query.get("name"))
    if not name:
        return web.Response(status=400, text="invalid name")
    path = os.path.join(_media_library_dir(), name)
    if not os.path.isfile(path):
        return web.Response(status=404, text="not found")
    return web.FileResponse(path, headers={"X-Content-Type-Options": "nosniff"})


@routes.get("/xzg/media-library/thumb")
@xzg_safe_handler
async def xzg_media_library_thumb(request):
    name = _media_safe_name(request.query.get("name"))
    if not name:
        return web.Response(status=400, text="invalid name")
    path = os.path.join(_media_library_dir(), name)
    if not os.path.isfile(path):
        return web.Response(status=404, text="not found")

    # 媒体库缩略图磁盘缓存 + ETag（与 input 加载器同机制）：浏览器缓存缩略图，
    # 重新打开媒体库命中 304/磁盘缓存，不再每次重新生成与下载；图片更新后 mtime 变 → ETag 变 → 强制刷新。
    etag = None
    cache_path = None
    try:
        mtime = str(os.path.getmtime(path))
        fsize = str(os.path.getsize(path))
        raw = "media_v1_{0}_{1}_{2}_{3}".format(name, 192, mtime, fsize)
        etag = hashlib.md5(raw.encode("utf-8")).hexdigest()
        cache_path = os.path.join(_get_media_thumb_cache_dir(), "media_" + etag)
    except Exception:
        etag = None
        cache_path = None

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
            return web.Response(body=data, content_type="image/png", headers=headers)
        except Exception:
            pass

    with Image.open(path) as source:
        img = ImageOps.exif_transpose(source)
        img.thumbnail((192, 192), Image.LANCZOS)
        if img.mode not in ("RGB", "RGBA"):
            img = img.convert("RGBA" if "A" in img.getbands() else "RGB")
        buffer = io.BytesIO()
        img.save(buffer, format="PNG")
    data = buffer.getvalue()

    if cache_path:
        try:
            with open(cache_path, "wb") as f:
                f.write(data)
        except Exception:
            pass

    # 定期清理超过 1 个月的媒体库缩略图缓存（生成新缩略图时顺手执行，低频不卡顿）
    _clean_media_thumb_cache(30)

    headers = {"Cache-Control": "no-cache"}
    if etag:
        headers["ETag"] = etag
    return web.Response(body=data, content_type="image/png", headers=headers)


@routes.delete("/xzg/media-library/thumb-cache")
@xzg_safe_handler
async def xzg_media_library_thumb_cache_clear(request):
    """清理媒体库缩略图磁盘缓存（media_* 前缀），强制下次全部重新生成。"""
    removed = 0
    try:
        cache_dir = _get_media_thumb_cache_dir()
        if os.path.isdir(cache_dir):
            for fname in os.listdir(cache_dir):
                if fname.startswith("media_"):
                    try:
                        os.remove(os.path.join(cache_dir, fname))
                        removed += 1
                    except Exception:
                        pass
    except Exception:
        pass
    return web.json_response({"removed": removed})


@routes.post("/xzg/media-library/upload")
@xzg_safe_handler
async def xzg_media_library_upload(request):
    reader = await request.multipart()
    part = await reader.next()
    if not part or part.name != "file":
        return web.json_response({"error": "file required"}, status=400)
    name = _media_safe_name(part.filename)
    if not name:
        return web.json_response({"error": "unsupported image name or type"}, status=400)
    directory = _media_library_dir()
    fd, temp_path = tempfile.mkstemp(prefix=".upload-", dir=directory)
    try:
        size = 0
        with os.fdopen(fd, "wb") as out:
            while chunk := await part.read_chunk(size=1024 * 1024):
                size += len(chunk)
                if size > MEDIA_MAX_FILE_BYTES:
                    return web.json_response({"error": "image exceeds 100 MB"}, status=413)
                out.write(chunk)
        _media_validate_image(temp_path)
        stored_name = _media_unique_name(directory, name)
        os.replace(temp_path, os.path.join(directory, stored_name))
        _media_write_order(_media_ordered_names(directory))
        return web.json_response({"name": stored_name})
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=400)
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)


@routes.post("/xzg/media-library/add-cropped-loader-image")
@xzg_safe_handler
async def xzg_media_library_add_cropped_loader_image(request):
    data = await request.json()
    annotated_name = _normalize_annotated_filename(str(data.get("filename") or "").strip())
    crop = data.get("crop")
    if not annotated_name or not isinstance(crop, (list, tuple)) or len(crop) != 4:
        return web.json_response({"error": "filename and crop rectangle are required"}, status=400)

    if annotated_name.endswith(" [output]"):
        output_root = os.path.realpath(_safe_dir("get_output_directory", "output"))
        rel_path = annotated_name[:-len(" [output]")]
        image_path = os.path.realpath(os.path.join(output_root, rel_path))
        try:
            if os.path.commonpath([output_root, image_path]) != output_root:
                return web.json_response({"error": "invalid image path"}, status=400)
        except ValueError:
            return web.json_response({"error": "invalid image path"}, status=400)
    else:
        image_path = folder_paths.get_annotated_filepath(annotated_name)
    if not image_path or not os.path.isfile(image_path):
        return web.json_response({"error": "source image not found"}, status=404)

    try:
        x, y, w, h = (int(round(float(value))) for value in crop)
    except (TypeError, ValueError, OverflowError):
        return web.json_response({"error": "invalid crop rectangle"}, status=400)
    w, h = max(1, w), max(1, h)

    with node_helpers.pillow(Image.open, image_path) as opened:
        source = ImageOps.exif_transpose(opened).convert("RGB")
    orig_w, orig_h = source.size
    max_edge = max(orig_w, orig_h)
    if max_edge > 3840:
        scale = max_edge / 3840.0
        x, y, w, h = (int(round(value * scale)) for value in (x, y, w, h))
        w, h = max(1, w), max(1, h)

    if w > 50000 or h > 50000 or w * h > 150_000_000:
        return web.json_response({"error": "cropped image dimensions are too large"}, status=413)

    padding_rgb = _parse_crop_padding_color(json.dumps({"__padding_color": data.get("padding_color", "#ffffff")}))
    cropped = Image.new("RGB", (w, h), padding_rgb)
    sx0, sy0 = max(0, x), max(0, y)
    sx1, sy1 = min(orig_w, x + w), min(orig_h, y + h)
    if sx1 > sx0 and sy1 > sy0:
        cropped.paste(source.crop((sx0, sy0, sx1, sy1)), (sx0 - x, sy0 - y))

    base_name = annotated_name
    for suffix in (" [output]", " [input]", " [temp]"):
        if base_name.endswith(suffix):
            base_name = base_name[:-len(suffix)]
            break
    stem = os.path.splitext(os.path.basename(base_name.replace("\\", "/")))[0] or "image"
    stored_name = _media_safe_name(f"{stem}_crop.png")
    if not stored_name:
        return web.json_response({"error": "unsupported source image name"}, status=400)

    directory = _media_library_dir()
    fd, temp_path = tempfile.mkstemp(prefix=".crop-", dir=directory)
    os.close(fd)
    try:
        cropped.save(temp_path, format="PNG", compress_level=3)
        if os.path.getsize(temp_path) > MEDIA_MAX_FILE_BYTES:
            return web.json_response({"error": "cropped image exceeds 100 MB"}, status=413)
        final_name = _media_unique_name(directory, stored_name)
        os.replace(temp_path, os.path.join(directory, final_name))
        _media_write_order(_media_ordered_names(directory))
        return web.json_response({"name": final_name})
    finally:
        cropped.close()
        source.close()
        if os.path.exists(temp_path):
            os.remove(temp_path)


@routes.delete("/xzg/media-library")
@xzg_safe_handler
async def xzg_media_library_delete(request):
    data = await request.json()
    names = data.get("names", [])
    if not isinstance(names, list) or any(not _media_safe_name(name) for name in names):
        return web.json_response({"error": "invalid names"}, status=400)
    directory = _media_library_dir()
    for name in names:
        path = os.path.join(directory, name)
        if os.path.isfile(path):
            os.remove(path)
    _media_write_order(_media_ordered_names(directory))
    return web.json_response({"deleted": names})


@routes.post("/xzg/media-library/to-input")
@xzg_safe_handler
async def xzg_media_library_to_input(request):
    data = await request.json()
    names = data.get("names", [])
    if not isinstance(names, list) or any(not _media_safe_name(name) for name in names):
        return web.json_response({"error": "invalid names"}, status=400)
    source_dir = _media_library_dir()
    input_dir = _safe_dir('get_input_directory', 'input')
    copied = []
    for name in names:
        source = os.path.join(source_dir, name)
        if not os.path.isfile(source):
            return web.json_response({"error": f"image not found: {name}"}, status=404)
        target_name = _media_unique_name(input_dir, name)
        shutil.copy2(source, os.path.join(input_dir, target_name))
        copied.append(target_name)
    return web.json_response({"names": copied})


@routes.get("/xzg/media-library/backup")
@xzg_safe_handler
async def xzg_media_library_backup(request):
    directory = _media_library_dir()
    files = []
    order = _media_ordered_names(directory)
    for name in order:
        path = os.path.join(directory, name)
        if os.path.isfile(path):
            with open(path, "rb") as source:
                files.append({"name": name, "data": base64.b64encode(source.read()).decode("ascii")})
    return web.json_response({"version": 2, "order": order, "files": files})


@routes.post("/xzg/media-library/restore")
@xzg_safe_handler
async def xzg_media_library_restore(request):
    request._client_max_size = 1024 * 1024 * 1024
    data = await request.json()
    files = data.get("files")
    if not isinstance(files, list):
        return web.json_response({"error": "invalid backup"}, status=400)
    directory = _media_library_dir()
    staged = []
    try:
        for entry in files:
            name = _media_safe_name(entry.get("name") if isinstance(entry, dict) else None)
            encoded = entry.get("data") if isinstance(entry, dict) else None
            if not name or not isinstance(encoded, str):
                raise ValueError("invalid image entry")
            raw = base64.b64decode(encoded, validate=True)
            if len(raw) > MEDIA_MAX_FILE_BYTES:
                raise ValueError("image exceeds 100 MB")
            fd, path = tempfile.mkstemp(prefix=".restore-", dir=directory)
            staged.append((name, path))
            with os.fdopen(fd, "wb") as out:
                out.write(raw)
            _media_validate_image(path)
        for name, path in staged:
            os.replace(path, os.path.join(directory, name))
        backed_up_order = data.get("order")
        imported = [name for name, _ in staged]
        if (not isinstance(backed_up_order, list) or
                any(not isinstance(name, str) for name in backed_up_order) or
                set(backed_up_order) != set(imported) or len(backed_up_order) != len(imported)):
            backed_up_order = imported
        existing = _media_ordered_names(directory)
        _media_write_order(backed_up_order + [name for name in existing if name not in backed_up_order])
        return web.json_response({"restored": len(staged)})
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=400)
    finally:
        for _, path in staged:
            if os.path.exists(path):
                os.remove(path)


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


def _parse_crop_padding_color(crop_str):
    """Read the optional canvas padding color stored alongside crop rectangles."""
    try:
        value = crop_str if isinstance(crop_str, dict) else json.loads(str(crop_str or ""))
        color = value.get("__padding_color", "#ffffff") if isinstance(value, dict) else "#ffffff"
        color = str(color).strip().lstrip("#")
        if len(color) == 3:
            color = "".join(ch * 2 for ch in color)
        if len(color) == 6 and all(ch in "0123456789abcdefABCDEF" for ch in color):
            return tuple(int(color[i:i + 2], 16) for i in (0, 2, 4))
    except Exception:
        pass
    return (255, 255, 255)


def _parse_image_transform(crop_str, image_name):
    """Read per-image flip values stored with crop data."""
    default = {"flip_x": False, "flip_y": False}
    try:
        value = json.loads(str(crop_str or ""))
        transforms = value.get("__transforms", {}) if isinstance(value, dict) else {}
        item = {}
        if isinstance(transforms, dict):
            candidates = [image_name, _normalize_annotated_filename(image_name)]
            for suffix in (" [output]", " [input]", " [temp]"):
                if candidates[-1].endswith(suffix):
                    candidates.append(candidates[-1][:-len(suffix)])
                    break
            for candidate in candidates:
                if candidate in transforms:
                    item = transforms[candidate]
                    break
        if not isinstance(item, dict):
            return default
        return {
            "flip_x": bool(item.get("flip_x", False)),
            "flip_y": bool(item.get("flip_y", False)),
        }
    except (TypeError, ValueError, OverflowError):
        return default


def _transform_pil(image, transform):
    if transform.get("flip_x"):
        image = image.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    if transform.get("flip_y"):
        image = image.transpose(Image.Transpose.FLIP_TOP_BOTTOM)
    return image


def _transform_tensor(img_t, transform):
    pil = Image.fromarray((img_t[0].numpy().clip(0, 1) * 255).astype(np.uint8), mode="RGB")
    pil = _transform_pil(pil, transform)
    arr = np.array(pil).astype(np.float32) / 255.0
    return torch.from_numpy(arr)[None,]


def _transform_mask(mask_t, transform):
    mask = Image.fromarray((mask_t[0].detach().cpu().numpy().clip(0, 1) * 255).astype(np.uint8), mode="L")
    if transform.get("flip_x"):
        mask = mask.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    if transform.get("flip_y"):
        mask = mask.transpose(Image.Transpose.FLIP_TOP_BOTTOM)
    arr = np.array(mask).astype(np.float32) / 255.0
    return torch.from_numpy(arr)[None,]


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


def _crop_tensor(img_t, crop, orig_w, orig_h, padding_rgb=(255, 255, 255)):
    """裁剪 IMAGE 张量；矩形超出原图时以白色补齐。"""
    x, y, w, h = (int(round(float(v))) for v in crop)
    w, h = max(1, w), max(1, h)
    if x == 0 and y == 0 and w == orig_w and h == orig_h:
        return img_t
    pil = Image.fromarray((img_t[0].numpy() * 255).astype(np.uint8))
    fill = tuple(padding_rgb[:len(pil.getbands())])
    if len(fill) != len(pil.getbands()):
        fill = (255,) * len(pil.getbands())
    out = Image.new(pil.mode, (w, h), fill)
    sx0, sy0 = max(0, x), max(0, y)
    sx1, sy1 = min(orig_w, x + w), min(orig_h, y + h)
    if sx1 > sx0 and sy1 > sy0:
        part = pil.crop((sx0, sy0, sx1, sy1))
        out.paste(part, (sx0 - x, sy0 - y))
    arr = np.array(out).astype(np.float32) / 255.0
    return torch.from_numpy(arr)[None,]


def _crop_mask(mask_t, crop, orig_w, orig_h):
    """裁剪遮罩；图像之外的补边区域保持未遮罩。"""
    x, y, w, h = (int(round(float(v))) for v in crop)
    w, h = max(1, w), max(1, h)
    out = torch.zeros((mask_t.shape[0], h, w), dtype=mask_t.dtype, device=mask_t.device)
    sx0, sy0 = max(0, x), max(0, y)
    sx1, sy1 = min(orig_w, x + w), min(orig_h, y + h)
    if sx1 > sx0 and sy1 > sy0:
        out[:, sy0 - y:sy1 - y, sx0 - x:sx1 - x] = mask_t[:, sy0:sy1, sx0:sx1]
    return out


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
        crop_padding_rgb = _parse_crop_padding_color(crop_data)
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
        transforms_loaded = []
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
                transforms_loaded.append(_parse_image_transform(crop_data, name))
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
            transforms_loaded = transforms_loaded[:limit]

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
                images[_ci] = _crop_tensor(images[_ci], _crop, _ow, _oh, crop_padding_rgb)

        masks = []
        for i, name in enumerate(loaded_names):
            orig_w, orig_h = orig_sizes[i]
            mask = _decode_mask(_parse_mask_data(mask_data, name), orig_h, orig_w, image_alphas[i])
            if crops_loaded[i]:
                mask = _crop_mask(mask, crops_loaded[i], orig_w, orig_h)
            transform = transforms_loaded[i]
            if transform["flip_x"] or transform["flip_y"]:
                images[i] = _transform_tensor(images[i], transform)
                mask = _transform_mask(mask, transform)
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

import os
import io
import hashlib
import time
import json
import base64
import shutil
import tempfile
import zipfile
import secrets
import contextvars
import subprocess
import re
from contextlib import contextmanager
import torch
import numpy as np
from PIL import Image, ImageOps
import folder_paths
import node_helpers
from aiohttp import web
from server import PromptServer
from .xzg_video_loader import VIDEO_EXTENSIONS, ffmpeg_path, _get_ffprobe_path
from .xzg_audio_loader import AUDIO_EXTENSIONS

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
MEDIA_MAX_VIDEO_BYTES = 10 * 1024 * 1024 * 1024
_media_kind = contextvars.ContextVar("xzg_media_library_kind", default="image")
_media_video_thumbnail_slots = _xzg_asyncio.Semaphore(2)
MEDIA_VIDEO_FORMATS = "mov,matroska,webm,gif,avi,flv,asf,mpeg,mpegts"
MEDIA_AUDIO_FORMATS = "mp3,wav,ogg,flac,aac,mov,asf,amr,ac3,aiff,au,matroska,rm,voc,w64,mpeg"


@contextmanager
def _media_library_context(kind):
    token = _media_kind.set(kind)
    try:
        yield
    finally:
        _media_kind.reset(token)


def _media_library_handler(function):
    @_xzg_ft.wraps(function)
    async def wrapped(request):
        kind = request.query.get("kind", "image")
        if kind not in ("image", "video", "audio"):
            return web.json_response({"error": "invalid media kind"}, status=400)
        with _media_library_context(kind):
            return await function(request)
    return wrapped


def _media_max_file_bytes():
    return MEDIA_MAX_VIDEO_BYTES if _media_kind.get() != "image" else MEDIA_MAX_FILE_BYTES


def _media_library_dir():
    """媒体库文件保存在 ComfyUI 用户目录，供同一后端的浏览器会话共享。"""
    base = folder_paths.get_user_directory()
    path = os.path.join(base, "xiaozhuguang", "media_library", {"image": "images", "video": "videos", "audio": "audio"}[_media_kind.get()])
    os.makedirs(path, exist_ok=True)
    return path


def _media_order_path():
    return os.path.join(os.path.dirname(_media_library_dir()), "order.json" if _media_kind.get() == "image" else _media_kind.get() + "-order.json")


def _media_ordered_names(directory):
    """返回媒体库全部图片的相对路径列表（含一级子文件夹）。
    根目录图片为 'name.ext'，文件夹图片为 'folder/name.ext'，按 order.json 记录排序（缺失时按修改时间倒序）。"""
    available = []
    for name in os.listdir(directory):
        full = os.path.join(directory, name)
        if os.path.isdir(full) and _media_safe_folder(name):
            for fname in os.listdir(full):
                if _media_safe_name(fname) and os.path.isfile(os.path.join(full, fname)):
                    available.append(name + "/" + fname)
        elif _media_safe_name(name) and os.path.isfile(full):
            available.append(name)
    available.sort(key=lambda rel: os.path.getmtime(_media_resolve_path(directory, rel)), reverse=True)
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
    extensions = {"." + ext for ext in (AUDIO_EXTENSIONS if _media_kind.get() == "audio" else VIDEO_EXTENSIONS)} if _media_kind.get() != "image" else MEDIA_IMAGE_EXTENSIONS
    if os.path.splitext(name)[1].lower() not in extensions:
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


def _media_safe_folder(folder):
    """校验文件夹名（一级分类名），通过则原样返回，否则 None。"""
    if not isinstance(folder, str) or not folder or len(folder) > 120:
        return None
    if folder != os.path.basename(folder) or "/" in folder or "\\" in folder or folder in (".", ".."):
        return None
    if folder.rstrip(" .") != folder or any(ord(ch) < 32 or ch in '<>:"|?*' for ch in folder):
        return None
    if folder.upper() in {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}:
        return None
    return folder


def _media_safe_rel(rel):
    """校验媒体库相对路径：'name.ext'（根目录）或 'folder/name.ext'（一级文件夹），通过则原样返回，否则 None。"""
    if not isinstance(rel, str) or not rel or len(rel) > 480:
        return None
    parts = rel.split("/")
    if len(parts) == 1:
        folder = ""
        fname = parts[0]
    elif len(parts) == 2:
        folder, fname = parts
        if not _media_safe_folder(folder):
            return None
    else:
        return None
    if not _media_safe_name(fname):
        return None
    return rel


def _media_resolve_path(directory, rel):
    """把媒体库相对路径安全解析为绝对路径，防止目录穿越。非法路径抛 ValueError。"""
    rel = _media_safe_rel(rel)
    if not rel:
        raise ValueError("invalid media path")
    root_real = os.path.realpath(directory)
    path = os.path.realpath(os.path.join(root_real, *rel.split("/")))
    if path != root_real and os.path.commonpath([root_real, path]) != root_real:
        raise ValueError("invalid media path")
    return path


def _text_box_preview_dir():
    path = os.path.join(folder_paths.get_user_directory(), "xiaozhuguang", "text_box_previews")
    os.makedirs(path, exist_ok=True)
    return path


def _text_box_preview_path(preview_id):
    if not isinstance(preview_id, str) or not re.fullmatch(r"[a-f0-9]{32}", preview_id):
        raise ValueError("invalid preview id")
    return os.path.join(_text_box_preview_dir(), preview_id + ".webp")


@routes.get("/xzg/text-box-preview/{preview_id}")
@xzg_safe_handler
async def xzg_text_box_preview_get(request):
    try:
        path = _text_box_preview_path(request.match_info.get("preview_id"))
    except ValueError:
        return web.json_response({"error": "invalid preview id"}, status=400)
    if not os.path.isfile(path):
        return web.json_response({"error": "preview not found"}, status=404)
    return web.FileResponse(path, headers={"Cache-Control": "public, max-age=3600"})


@routes.delete("/xzg/text-box-preview/{preview_id}")
@xzg_safe_handler
async def xzg_text_box_preview_delete(request):
    try:
        path = _text_box_preview_path(request.match_info.get("preview_id"))
    except ValueError:
        return web.json_response({"error": "invalid preview id"}, status=400)
    if os.path.isfile(path):
        os.remove(path)
    return web.json_response({"deleted": True})


def _media_folder_of(rel):
    """返回相对路径所属文件夹（根目录返回 ''）。"""
    idx = rel.find("/")
    return rel[:idx] if idx >= 0 else ""


def _media_folder_order_path():
    return os.path.join(os.path.dirname(_media_library_dir()), "folders.json" if _media_kind.get() == "image" else _media_kind.get() + "-folders.json")


def _media_read_folder_order():
    try:
        with open(_media_folder_order_path(), "r", encoding="utf-8") as source:
            saved = json.load(source)
        return saved if isinstance(saved, list) else []
    except (OSError, ValueError):
        return []


def _media_write_folder_order(names):
    target = _media_folder_order_path()
    fd, temp_path = tempfile.mkstemp(prefix=".folders-", dir=os.path.dirname(target))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            json.dump(names, out, ensure_ascii=False)
        os.replace(temp_path, target)
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)


def _media_folders(directory):
    """返回媒体库全部一级子文件夹（含空文件夹，便于新建后立即进入再上传）。"""
    folders = []
    for name in os.listdir(directory):
        full = os.path.join(directory, name)
        if os.path.isdir(full) and _media_safe_folder(name):
            folders.append(name)
    # 优先按 folders.json 保存的顺序排列，缺失的按名称排在其后；无顺序记录时按名称排序。
    saved = _media_read_folder_order()
    current = set(folders)
    ordered = []
    seen = set()
    for name in saved:
        if name in current and name not in seen:
            ordered.append(name)
            seen.add(name)
    for name in sorted(folders):
        if name not in seen:
            ordered.append(name)
            seen.add(name)
    return ordered


def _media_validate_image(path):
    if _media_kind.get() != "image":
        is_audio = _media_kind.get() == "audio"
        probe = _get_ffprobe_path()
        if not probe:
            raise ValueError("FFprobe is required for the video media library")
        result = subprocess.run([probe, "-v", "error", "-protocol_whitelist", "file,pipe", "-format_whitelist", MEDIA_AUDIO_FORMATS if is_audio else MEDIA_VIDEO_FORMATS,
            "-select_streams", "a:0" if is_audio else "v:0", "-show_entries",
            "stream=sample_rate,channels" if is_audio else "stream=width,height", "-of", "json", path], capture_output=True, timeout=30)
        streams = json.loads(result.stdout).get("streams", []) if result.returncode == 0 else []
        dimensions = ("sample_rate", "channels") if is_audio else ("width", "height")
        if not streams or any(not streams[0].get(key) for key in dimensions):
            raise ValueError("file has no readable audio stream" if is_audio else "file has no readable video stream")
        return
    with Image.open(path) as img:
        img.verify()


@routes.get("/xzg/media-library")
@xzg_safe_handler
@_media_library_handler
async def xzg_media_library_list(request):
    directory = _media_library_dir()
    folder = (request.query.get("folder") or "").strip()
    # “全部”视图：folder=__all__ 时返回所有图片（根目录 + 各子文件夹）
    all_view = folder == "__all__"
    if not all_view and folder and not _media_safe_folder(folder):
        return web.json_response({"error": "invalid folder"}, status=400)
    folders = _media_folders(directory)
    items = []
    for rel in _media_ordered_names(directory):
        rel_folder = _media_folder_of(rel)
        if not all_view and rel_folder != folder:
            continue
        path = _media_resolve_path(directory, rel)
        if os.path.isfile(path):
            stat = os.stat(path)
            version = f"{stat.st_mtime_ns}-{stat.st_ctime_ns}-{stat.st_size}"
            items.append({"name": rel, "folder": rel_folder, "size": stat.st_size, "mtime": stat.st_mtime, "version": version})
    return web.json_response({"folders": folders, "folder": folder, "items": items}, headers={"Cache-Control": "no-store"})


@routes.put("/xzg/media-library/order")
@xzg_safe_handler
@_media_library_handler
async def xzg_media_library_order(request):
    data = await request.json()
    names = data.get("names")
    folder = (data.get("folder") or "").strip()
    if folder and folder != "__all__" and not _media_safe_folder(folder):
        return web.json_response({"error": "invalid folder"}, status=400)
    directory = _media_library_dir()
    current = _media_ordered_names(directory)
    if not isinstance(names, list) or any(not _media_safe_rel(name) for name in names):
        return web.json_response({"error": "invalid image order"}, status=400)
    if folder == "__all__":
        # “全部”视图：对聚合后的全局顺序直接重排（可跨文件夹拖动）
        if len(names) != len(current) or set(names) != set(current):
            return web.json_response({"error": "invalid image order"}, status=400)
        _media_write_order(names)
        return web.json_response({"names": names})
    folder_cur = [rel for rel in current if _media_folder_of(rel) == folder]
    if len(names) != len(folder_cur) or set(names) != set(folder_cur):
        return web.json_response({"error": "invalid image order"}, status=400)
    # 仅重排目标文件夹的顺序，其它文件夹（及根目录）内部顺序与相对位置保持不变
    if folder == "":
        new_order = list(names) + [rel for rel in current if _media_folder_of(rel) != ""]
    else:
        new_order = []
        inserted = False
        for rel in current:
            if _media_folder_of(rel) == folder:
                if not inserted:
                    new_order.extend(names)
                    inserted = True
            else:
                new_order.append(rel)
        if not inserted:
            new_order.extend(names)
    _media_write_order(new_order)
    return web.json_response({"names": names})


@routes.put("/xzg/media-library/rename")
@xzg_safe_handler
@_media_library_handler
async def xzg_media_library_rename(request):
    data = await request.json()
    old_name = _media_safe_rel(data.get("old_name"))
    new_name = _media_safe_rel(data.get("new_name"))
    if not old_name or not new_name:
        return web.json_response({"error": "invalid image name"}, status=400)
    if _media_folder_of(old_name) != _media_folder_of(new_name):
        return web.json_response({"error": "folder cannot change on rename"}, status=400)
    if os.path.splitext(old_name)[1].lower() != os.path.splitext(new_name)[1].lower():
        return web.json_response({"error": "image extension cannot change"}, status=400)
    directory = _media_library_dir()
    old_path = _media_resolve_path(directory, old_name)
    new_path = _media_resolve_path(directory, new_name)
    if not os.path.isfile(old_path):
        return web.json_response({"error": "image not found"}, status=404)
    if new_name == old_name:
        return web.json_response({"name": old_name})
    case_only_rename = os.path.normcase(old_path) == os.path.normcase(new_path)
    if os.path.exists(new_path) and not case_only_rename:
        return web.json_response({"error": "image name already exists"}, status=409)
    order = _media_ordered_names(directory)
    if case_only_rename:
        fd, temp_path = tempfile.mkstemp(prefix=".rename-", dir=os.path.dirname(old_path))
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
@_media_library_handler
async def xzg_media_library_file(request):
    name = _media_safe_rel(request.query.get("name"))
    if not name:
        return web.Response(status=400, text="invalid name")
    path = _media_resolve_path(_media_library_dir(), name)
    if not os.path.isfile(path):
        return web.Response(status=404, text="not found")
    return web.FileResponse(path, headers={"X-Content-Type-Options": "nosniff"})


@routes.get("/xzg/media-library/thumb")
@xzg_safe_handler
@_media_library_handler
async def xzg_media_library_thumb(request):
    name = _media_safe_rel(request.query.get("name"))
    if not name:
        return web.Response(status=400, text="invalid name")
    path = _media_resolve_path(_media_library_dir(), name)
    if not os.path.isfile(path):
        return web.Response(status=404, text="not found")

    # 媒体库缩略图磁盘缓存 + ETag（与 input 加载器同机制）：浏览器缓存缩略图，
    # 重新打开媒体库命中 304/磁盘缓存，不再每次重新生成与下载；图片更新后 mtime 变 → ETag 变 → 强制刷新。
    etag = None
    cache_path = None
    try:
        mtime = str(os.path.getmtime(path))
        fsize = str(os.path.getsize(path))
        raw = "media_v2_{0}_{1}_{2}_{3}_{4}".format(_media_kind.get(), name, 192, mtime, fsize)
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

    if _media_kind.get() != "image":
        if not ffmpeg_path:
            return web.Response(status=503, text="FFmpeg is required for media thumbnails")
        is_audio = _media_kind.get() == "audio"
        args = [ffmpeg_path, "-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe",
                "-format_whitelist", MEDIA_AUDIO_FORMATS if is_audio else MEDIA_VIDEO_FORMATS, "-threads", "1"]
        if is_audio:
            args += ["-t", "30"]
        args += ["-i", path]
        if is_audio:
            args += ["-filter_complex", "[0:a:0]aformat=channel_layouts=mono,showwavespic=s=192x96:colors=0xaaaaaa[wave]", "-map", "[wave]"]
        else:
            args += ["-map", "0:v:0", "-vf", "scale=192:192:force_original_aspect_ratio=decrease"]
        args += ["-frames:v", "1", "-threads", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"]
        async with _media_video_thumbnail_slots:
            result = await _media_archive_io(subprocess.run, args, capture_output=True, timeout=30)
        if result.returncode or not result.stdout:
            return web.Response(status=422, text="cannot generate media thumbnail")
        data = result.stdout
    else:
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
@_media_library_handler
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
@_media_library_handler
async def xzg_media_library_upload(request):
    reader = await request.multipart()
    part = await reader.next()
    if not part or part.name != "file":
        return web.json_response({"error": "file required"}, status=400)
    preview_upload = request.query.get("purpose") == "text_box_preview"
    name = _media_safe_name(part.filename)
    if not name:
        return web.json_response({"error": "unsupported media name or type"}, status=400)
    root_dir = _text_box_preview_dir() if preview_upload else _media_library_dir()
    fd, temp_path = tempfile.mkstemp(prefix=".upload-", dir=root_dir)
    try:
        size = 0
        with os.fdopen(fd, "wb") as out:
            while chunk := await part.read_chunk(size=1024 * 1024):
                size += len(chunk)
                if size > (50 * 1024 * 1024 if preview_upload else _media_max_file_bytes()):
                    limit_message = "image exceeds 50 MB" if preview_upload else ("media exceeds 10 GB" if _media_kind.get() != "image" else "image exceeds 100 MB")
                    return web.json_response({"error": limit_message}, status=413)
                await _media_archive_io(out.write, chunk)
        # 先完整读取图片内容，再读 folder 字段（aiohttp 按顺序解析 multipart，
        # 若提前 next() 推进会破坏当前 part 数据流，导致图片内容损坏无法识别）
        folder = ""
        if not preview_upload:
            try:
                folder_part = await reader.next()
                if folder_part and folder_part.name == "folder":
                    folder = _media_safe_folder((await folder_part.read()).decode("utf-8", "replace").strip()) or ""
            except Exception:
                folder = ""
        directory = os.path.join(root_dir, folder) if folder else root_dir
        os.makedirs(directory, exist_ok=True)
        await _media_archive_io(_media_validate_image, temp_path)
        if preview_upload:
            preview_id = secrets.token_hex(16)
            target = _text_box_preview_path(preview_id)
            with Image.open(temp_path) as opened:
                if opened.width * opened.height > 100_000_000:
                    return web.json_response({"error": "image dimensions exceed 100 megapixels"}, status=413)
                opened.load()
                oriented = ImageOps.exif_transpose(opened)
                image = oriented.convert("RGBA" if "A" in oriented.getbands() else "RGB")
                if oriented is not opened:
                    oriented.close()
            image.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
            image.save(temp_path, format="WEBP", quality=82, method=4)
            width, height = image.size
            image.close()
            os.replace(temp_path, target)
            return web.json_response({"id": preview_id, "width": width, "height": height, "size": os.path.getsize(target)})
        stored_name = _media_unique_name(directory, name)
        os.replace(temp_path, os.path.join(directory, stored_name))
        _media_write_order(_media_ordered_names(root_dir))
        return web.json_response({"name": (folder + "/" if folder else "") + stored_name})
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=400)
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)


@routes.post("/xzg/media-library/folder")
@xzg_safe_handler
@_media_library_handler
async def xzg_media_library_folder_create(request):
    data = await request.json()
    name = _media_safe_folder(data.get("name"))
    if not name:
        return web.json_response({"error": "invalid folder name"}, status=400)
    directory = _media_library_dir()
    target = os.path.join(directory, name)
    if os.path.exists(target):
        return web.json_response({"error": "folder already exists"}, status=409)
    os.makedirs(target, exist_ok=True)
    return web.json_response({"name": name})


@routes.delete("/xzg/media-library/folder")
@xzg_safe_handler
@_media_library_handler
async def xzg_media_library_folder_delete(request):
    data = await request.json()
    name = _media_safe_folder(data.get("folder"))
    if not name:
        return web.json_response({"error": "invalid folder"}, status=400)
    directory = _media_library_dir()
    target = os.path.join(directory, name)
    if not os.path.isdir(target):
        return web.json_response({"error": "folder not found"}, status=404)
    if any(os.path.isfile(os.path.join(target, f)) for f in os.listdir(target)):
        return web.json_response({"error": "folder is not empty"}, status=400)
    os.rmdir(target)
    _media_write_order(_media_ordered_names(directory))
    return web.json_response({"deleted": name})


@routes.put("/xzg/media-library/folder-rename")
@xzg_safe_handler
@_media_library_handler
async def xzg_media_library_folder_rename(request):
    data = await request.json()
    old_name = _media_safe_folder(data.get("old_name"))
    new_name = _media_safe_folder(data.get("new_name"))
    if not old_name or not new_name:
        return web.json_response({"error": "invalid folder name"}, status=400)
    if new_name == old_name:
        return web.json_response({"name": old_name})
    directory = _media_library_dir()
    old_path = os.path.join(directory, old_name)
    if not os.path.isdir(old_path):
        return web.json_response({"error": "folder not found"}, status=404)
    new_path = os.path.join(directory, new_name)
    case_only_rename = os.path.normcase(old_path) == os.path.normcase(new_path)
    if os.path.exists(new_path) and not case_only_rename:
        return web.json_response({"error": "folder name already exists"}, status=409)
    if case_only_rename:
        # 仅大小写变化的改名：Windows 下直接 rename 会冲突，借助临时名两步完成。
        import tempfile
        fd, temp_path = tempfile.mkstemp(prefix=".rename-", dir=os.path.dirname(old_path))
        os.close(fd)
        os.remove(temp_path)
        temp_path = os.path.join(directory, ".rename-" + old_name)
        os.rename(old_path, temp_path)
        try:
            os.rename(temp_path, new_path)
        except Exception:
            os.rename(temp_path, old_path)
            raise
    else:
        os.rename(old_path, new_path)
    # 重命名后 order.json 中该文件夹下的相对路径前缀随之变化，重建排序记录。
    _media_write_order(_media_ordered_names(directory))
    return web.json_response({"name": new_name})


@routes.put("/xzg/media-library/folder-order")
@xzg_safe_handler
@_media_library_handler
async def xzg_media_library_folder_order(request):
    data = await request.json()
    names = data.get("names")
    if not isinstance(names, list) or any(not _media_safe_folder(name) for name in names):
        return web.json_response({"error": "invalid folder order"}, status=400)
    directory = _media_library_dir()
    current = set(_media_folders(directory))
    if set(names) != current:
        return web.json_response({"error": "invalid folder order"}, status=400)
    _media_write_folder_order(list(names))
    return web.json_response({"names": names})


@routes.put("/xzg/media-library/move")
@xzg_safe_handler
@_media_library_handler
async def xzg_media_library_move(request):
    data = await request.json()
    names = data.get("names", [])
    folder = (data.get("folder") or "").strip()
    if folder and not _media_safe_folder(folder):
        return web.json_response({"error": "invalid folder"}, status=400)
    if not isinstance(names, list) or not names or any(not _media_safe_rel(n) for n in names):
        return web.json_response({"error": "invalid names"}, status=400)
    directory = _media_library_dir()
    target_dir = os.path.join(directory, folder) if folder else directory
    os.makedirs(target_dir, exist_ok=True)
    moved = []
    for rel in names:
        src = _media_resolve_path(directory, rel)
        if not os.path.isfile(src):
            continue
        fname = rel.split("/")[-1]
        dest = os.path.join(target_dir, fname)
        if os.path.normcase(os.path.realpath(src)) == os.path.normcase(os.path.realpath(dest)):
            moved.append(rel)
            continue
        tname = _media_unique_name(target_dir, fname)
        shutil.move(src, os.path.join(target_dir, tname))
        moved.append((folder + "/" if folder else "") + tname)
    _media_write_order(_media_ordered_names(directory))
    return web.json_response({"names": moved})


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
@_media_library_handler
async def xzg_media_library_delete(request):
    data = await request.json()
    names = data.get("names", [])
    if not isinstance(names, list) or any(not _media_safe_rel(name) for name in names):
        return web.json_response({"error": "invalid names"}, status=400)
    directory = _media_library_dir()
    for name in names:
        path = _media_resolve_path(directory, name)
        if os.path.isfile(path):
            os.remove(path)
    _media_write_order(_media_ordered_names(directory))
    return web.json_response({"deleted": names})


@routes.post("/xzg/media-library/to-input")
@xzg_safe_handler
@_media_library_handler
async def xzg_media_library_to_input(request):
    data = await request.json()
    names = data.get("names", [])
    if not isinstance(names, list) or any(not _media_safe_rel(name) for name in names):
        return web.json_response({"error": "invalid names"}, status=400)
    source_dir = _media_library_dir()
    input_dir = _safe_dir('get_input_directory', 'input')
    copied = []
    for rel in names:
        source = _media_resolve_path(source_dir, rel)
        if not os.path.isfile(source):
            return web.json_response({"error": f"image not found: {rel}"}, status=404)
        folder = "" if _media_kind.get() != "image" else _media_folder_of(rel)
        target_dir = os.path.join(input_dir, folder) if folder else input_dir
        os.makedirs(target_dir, exist_ok=True)
        target_name = _media_unique_name(target_dir, rel.split("/")[-1])
        await _media_archive_io(shutil.copy2, source, os.path.join(target_dir, target_name))
        copied.append((folder + "/" if folder else "") + target_name)
    return web.json_response({"names": copied})


@routes.post("/xzg/media-library/add-video")
@xzg_safe_handler
async def xzg_media_library_add_video(request):
    return await _media_add_loaded(request, "video")


@routes.post("/xzg/media-library/add-audio")
@xzg_safe_handler
async def xzg_media_library_add_audio(request):
    return await _media_add_loaded(request, "audio")


async def _media_add_loaded(request, kind):
    data = await request.json()
    source_type = data.get("type", "input")
    filename = data.get("filename")
    if source_type not in ("input", "output", "temp") or not isinstance(filename, str) or not filename or os.path.isabs(filename):
        return web.json_response({"error": "invalid media source"}, status=400)
    token = data.get("abs_token")
    if token:
        from .xzg_video_save_davinci import _lookup_abs_token
        source = _lookup_abs_token(token)
        if not source and kind == "audio":
            from .xzg_audio_save import _AUDIO_ABS_FILE_TOKENS
            source = _AUDIO_ABS_FILE_TOKENS.get(token)
        if not source:
            return web.json_response({"error": "saved media token expired; execute the node again"}, status=400)
        source = os.path.realpath(source)
    else:
        root = os.path.realpath(_safe_dir("get_" + source_type + "_directory", source_type))
        source = os.path.realpath(os.path.join(root, filename))
        try:
            if os.path.commonpath([root, source]) != root:
                raise ValueError("invalid media source")
        except ValueError:
            return web.json_response({"error": "invalid media source"}, status=400)
    with _media_library_context(kind):
        name = _media_safe_name(os.path.basename(source))
        if not name or not os.path.isfile(source):
            return web.json_response({"error": "media not found or unsupported type"}, status=400)
        if os.path.getsize(source) > MEDIA_MAX_VIDEO_BYTES:
            return web.json_response({"error": "media exceeds 10 GB"}, status=413)
        directory = _media_library_dir()
        fd, temporary = tempfile.mkstemp(prefix=".upload-", dir=directory)
        os.close(fd)
        try:
            await _media_archive_io(shutil.copy2, source, temporary)
            await _media_archive_io(_media_validate_image, temporary)
            name = _media_unique_name(directory, name)
            os.replace(temporary, os.path.join(directory, name))
            _media_write_order(_media_ordered_names(directory))
            return web.json_response({"name": name})
        except (ValueError, OSError, subprocess.TimeoutExpired) as exc:
            return web.json_response({"error": str(exc)}, status=400)
        finally:
            if os.path.exists(temporary):
                os.remove(temporary)


MEDIA_ARCHIVE_MAX_BYTES = 20 * 1024 * 1024 * 1024
MEDIA_CONFIG_MAX_BYTES = 100 * 1024 * 1024
_media_pending_archives = {}


async def _media_archive_io(function, *args, **kwargs):
    task = _xzg_asyncio.create_task(_xzg_asyncio.to_thread(function, *args, **kwargs))
    try:
        return await _xzg_asyncio.shield(task)
    except _xzg_asyncio.CancelledError:
        # Finish disk work before the caller closes or deletes its temporary file.
        await task
        raise


def _media_discard_archive(token):
    pending = _media_pending_archives.pop(token, None)
    if pending:
        path, timer = pending
        timer.cancel()
        if os.path.isfile(path):
            os.remove(path)


MEDIA_ARCHIVE_LIBRARIES = (("mediaLibrary", "images", "image"), ("videoLibrary", "videos", "video"), ("audioLibrary", "audio", "audio"))


def _media_build_archive(path, config):
    total = 0
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
        for key, prefix, kind in MEDIA_ARCHIVE_LIBRARIES:
            media = config.get(key)
            if media is None:
                continue
            with _media_library_context(kind):
                directory = _media_library_dir()
                order = _media_ordered_names(directory)
                media.update(version=3, files=[{"name": name} for name in order],
                             order=order, folders=_media_folders(directory))
                for name in order:
                    source = _media_resolve_path(directory, name)
                    size = os.path.getsize(source)
                    if size > _media_max_file_bytes():
                        raise ValueError("media file exceeds size limit")
                    total += size
                    if total > MEDIA_ARCHIVE_MAX_BYTES:
                        raise ValueError("archive exceeds 20 GB")
                    archive.write(source, prefix + "/" + name)
        if config.get("textBoxPreviews") is not None:
            preview_dir = _text_box_preview_dir()
            preview_ids = sorted(name[:-5] for name in os.listdir(preview_dir)
                                 if re.fullmatch(r"[a-f0-9]{32}\.webp", name)
                                 and os.path.isfile(os.path.join(preview_dir, name)))
            config["textBoxPreviews"] = {"version": 1, "files": preview_ids}
            for preview_id in preview_ids:
                source = _text_box_preview_path(preview_id)
                total += os.path.getsize(source)
                if total > MEDIA_ARCHIVE_MAX_BYTES:
                    raise ValueError("archive exceeds 20 GB")
                archive.write(source, "text_box_previews/" + preview_id + ".webp")
        metadata = json.dumps(config, ensure_ascii=False).encode("utf-8")
        if len(metadata) > MEDIA_CONFIG_MAX_BYTES:
            raise ValueError("config exceeds 100 MB")
        if total + len(metadata) > MEDIA_ARCHIVE_MAX_BYTES:
            raise ValueError("archive exceeds 20 GB")
        archive.writestr("config.json", metadata, compress_type=zipfile.ZIP_DEFLATED)
    if os.path.getsize(path) > MEDIA_ARCHIVE_MAX_BYTES:
        raise ValueError("archive exceeds 20 GB")


def _media_archive_config(archive):
    entries = archive.infolist()
    names = [entry.filename for entry in entries]
    if len(names) != len(set(name.casefold() for name in names)):
        raise ValueError("duplicate archive entries")
    if sum(entry.file_size for entry in entries) > MEDIA_ARCHIVE_MAX_BYTES:
        raise ValueError("archive exceeds 20 GB")
    for entry in entries:
        if entry.flag_bits & 1 or ((entry.external_attr >> 16) & 0o170000) == 0o120000:
            raise ValueError("encrypted entries and symbolic links are unsupported")
        if entry.filename == "config.json":
            if entry.file_size > MEDIA_CONFIG_MAX_BYTES:
                raise ValueError("config exceeds 100 MB")
            continue
        prefix, separator, rel = entry.filename.partition("/")
        if not separator or prefix not in ("images", "videos", "audio", "text_box_previews"):
            raise ValueError("invalid archive path")
        if prefix == "text_box_previews":
            if not re.fullmatch(r"[a-f0-9]{32}\.webp", rel) or entry.file_size > 50 * 1024 * 1024:
                raise ValueError("invalid text box preview image")
            continue
        with _media_library_context({"images": "image", "videos": "video", "audio": "audio"}[prefix]):
            if not _media_safe_rel(rel):
                raise ValueError("invalid archive path")
            if entry.file_size > _media_max_file_bytes():
                raise ValueError("media file exceeds size limit")
    config = json.loads(archive.read("config.json"))
    if (not isinstance(config, dict) or config.get("format") != "xiaozhuguang-config"
            or config.get("version") not in (8, 9, 10, 11)):
        raise ValueError("unsupported backup format")
    for key, prefix, kind in MEDIA_ARCHIVE_LIBRARIES:
        media = config.get(key)
        media_names = [name[len(prefix) + 1:] for name in names if name.startswith(prefix + "/")]
        if media is None:
            if media_names:
                raise ValueError("missing media manifest")
            continue
        if not isinstance(media, dict) or media.get("version") != 3:
            raise ValueError("invalid media manifest")
        files, order, folders = media.get("files"), media.get("order"), media.get("folders")
        with _media_library_context(kind):
            if (not isinstance(files, list) or any(not isinstance(entry, dict) for entry in files)
                    or not isinstance(order, list) or any(not _media_safe_rel(name) for name in order)
                    or [entry.get("name") for entry in files] != order
                    or len(order) != len(media_names) or set(order) != set(media_names)
                    or not isinstance(folders, list) or any(not _media_safe_folder(name) for name in folders)
                    or len(folders) != len(set(name.casefold() for name in folders))
                    or {name.casefold() for name in order if "/" not in name} & {name.casefold() for name in folders}
                    or any(_media_folder_of(name) and _media_folder_of(name) not in folders for name in order)):
                raise ValueError("invalid media manifest")
    preview_manifest = config.get("textBoxPreviews")
    preview_ids = [name[len("text_box_previews/"):-5] for name in names if name.startswith("text_box_previews/") and name.endswith(".webp")]
    if preview_manifest is None:
        if preview_ids:
            raise ValueError("missing text box preview manifest")
    elif (not isinstance(preview_manifest, dict) or preview_manifest.get("version") != 1
          or not isinstance(preview_manifest.get("files"), list)
          or any(not isinstance(item, str) or not re.fullmatch(r"[a-f0-9]{32}", item) for item in preview_manifest["files"])
          or len(preview_manifest["files"]) != len(set(preview_manifest["files"]))
          or set(preview_manifest["files"]) != set(preview_ids)):
        raise ValueError("invalid text box preview manifest")
    return config


def _media_read_archive(path, restore=False):
    with zipfile.ZipFile(path) as archive:
        config = _media_archive_config(archive)
        if not restore:
            return config
        selected = ({key: True for key, _, _ in MEDIA_ARCHIVE_LIBRARIES} | {"textBoxPreviews": True}) if restore is True else restore
        libraries = [(key, prefix, kind, config[key]) for key, prefix, kind in MEDIA_ARCHIVE_LIBRARIES
                     if selected.get(key) and config.get(key) is not None]
        restore_previews = bool(selected.get("textBoxPreviews") and config.get("textBoxPreviews") is not None)
        if not libraries and not restore_previews:
            raise ValueError("backup has no selected media library")
        root = os.path.dirname(_media_library_dir())
        # Validate both libraries before committing; keep originals for rollback.
        with tempfile.TemporaryDirectory(prefix=".archive-", dir=root) as staging:
            staged, histories = [], []
            for key, prefix, kind, media in libraries:
                with _media_library_context(kind):
                    directory = _media_library_dir()
                    for name in media["order"]:
                        target = _media_resolve_path(directory, name)
                        if os.path.exists(target) and not os.path.isfile(target):
                            raise ValueError("media path conflicts with an existing directory")
                        temporary = os.path.join(staging, str(len(staged)))
                        with archive.open(prefix + "/" + name) as source, open(temporary, "wb") as out:
                            shutil.copyfileobj(source, out, 1024 * 1024)
                        _media_validate_image(temporary)
                        staged.append((target, temporary))
                    histories.append((kind, directory, media, _media_ordered_names(directory), _media_folders(directory)))
            committed, created_folders = [], []
            try:
                for kind, directory, media, old_order, old_folders in histories:
                    with _media_library_context(kind):
                        for folder in media["folders"]:
                            placeholder = {"video": "placeholder.mp4", "image": "placeholder.png", "audio": "placeholder.wav"}[kind]
                            target = os.path.dirname(_media_resolve_path(directory, folder + "/" + placeholder))
                            if not os.path.exists(target):
                                os.mkdir(target)
                                created_folders.append(target)
                for index, (target, temporary) in enumerate(staged):
                    original = os.path.join(staging, "original-" + str(index)) if os.path.exists(target) else None
                    if original:
                        os.replace(target, original)
                    committed.append((target, original))
                    os.replace(temporary, target)
                for kind, directory, media, old_order, old_folders in histories:
                    with _media_library_context(kind):
                        _media_write_order(media["order"] + [name for name in old_order if name not in media["order"]])
                        _media_write_folder_order(media["folders"] + [name for name in old_folders if name not in media["folders"]])
            except Exception:
                for target, original in reversed(committed):
                    if os.path.isfile(target):
                        os.remove(target)
                    if original:
                        os.replace(original, target)
                for target in reversed(created_folders):
                    os.rmdir(target)
                for kind, directory, media, old_order, old_folders in histories:
                    with _media_library_context(kind):
                        _media_write_order(old_order)
                        _media_write_folder_order(old_folders)
                raise
        restored_previews = 0
        if restore_previews:
            preview_dir = _text_box_preview_dir()
            with tempfile.TemporaryDirectory(prefix=".text-box-preview-restore-", dir=os.path.dirname(preview_dir)) as staging:
                staged_previews = []
                for preview_id in config["textBoxPreviews"]["files"]:
                    target = _text_box_preview_path(preview_id)
                    temporary = os.path.join(staging, preview_id + ".webp")
                    with archive.open("text_box_previews/" + preview_id + ".webp") as source, open(temporary, "wb") as out:
                        shutil.copyfileobj(source, out, 1024 * 1024)
                    with Image.open(temporary) as image:
                        if image.format != "WEBP" or max(image.size) > 1024:
                            raise ValueError("invalid text box preview image")
                        image.verify()
                    staged_previews.append((target, temporary))
                for target, temporary in staged_previews:
                    os.replace(temporary, target)
                restored_previews = len(staged_previews)
        return {"restored": sum(len(media["order"]) for key, _, _, media in libraries if key == "mediaLibrary"),
                "restoredVideos": sum(len(media["order"]) for key, _, _, media in libraries if key == "videoLibrary"),
                "restoredAudios": sum(len(media["order"]) for key, _, _, media in libraries if key == "audioLibrary"),
                "restoredTextBoxPreviews": restored_previews}


@routes.post("/xzg/media-library/backup")
@xzg_safe_handler
async def xzg_media_library_archive_backup(request):
    request._client_max_size = MEDIA_CONFIG_MAX_BYTES
    config = await request.json()
    if (not isinstance(config, dict) or config.get("format") != "xiaozhuguang-config"
            or config.get("version") not in (8, 9, 10, 11) or
            any(config.get(key) is not None and not isinstance(config[key], dict) for key, _, _ in MEDIA_ARCHIVE_LIBRARIES)):
        return web.json_response({"error": "invalid config"}, status=400)
    fd, path = tempfile.mkstemp(suffix=".zip")
    os.close(fd)
    try:
        try:
            await _media_archive_io(_media_build_archive, path, config)
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        response = web.StreamResponse(headers={"Content-Type": "application/zip",
            "Content-Disposition": 'attachment; filename="xiaozhuguang-backup.zip"',
            "Content-Length": str(os.path.getsize(path))})
        await response.prepare(request)
        with open(path, "rb") as source:
            while True:
                chunk = await _media_archive_io(source.read, 1024 * 1024)
                if not chunk:
                    break
                await response.write(chunk)
        await response.write_eof()
        return response
    finally:
        os.remove(path)


@routes.post("/xzg/media-library/archive")
@xzg_safe_handler
async def xzg_media_library_archive_upload(request):
    fd, path = tempfile.mkstemp(suffix=".zip")
    os.close(fd)
    retained = False
    try:
        size = 0
        with open(path, "wb") as out:
            async for chunk in request.content.iter_chunked(1024 * 1024):
                size += len(chunk)
                if size > MEDIA_ARCHIVE_MAX_BYTES:
                    return web.json_response({"error": "archive exceeds 20 GB"}, status=413)
                await _media_archive_io(out.write, chunk)
        config = await _media_archive_io(_media_read_archive, path)
        token = secrets.token_urlsafe(32)
        timer = _xzg_asyncio.get_running_loop().call_later(30 * 60, _media_discard_archive, token)
        _media_pending_archives[token] = (path, timer)
        retained = True
        return web.json_response({"config": config, "token": token})
    except (ValueError, KeyError, OSError, zipfile.BadZipFile, RuntimeError) as exc:
        return web.json_response({"error": str(exc)}, status=400)
    finally:
        if not retained:
            os.remove(path)


@routes.post("/xzg/media-library/archive/restore")
@xzg_safe_handler
async def xzg_media_library_archive_restore(request):
    data = await request.json()
    token = data.get("token") if isinstance(data, dict) else None
    pending = _media_pending_archives.pop(token, None) if isinstance(token, str) else None
    if not pending:
        return web.json_response({"error": "backup expired; please select the ZIP again"}, status=400)
    path, timer = pending
    timer.cancel()
    try:
        selected = data.get("libraries", {key: True for key, _, _ in MEDIA_ARCHIVE_LIBRARIES} | {"textBoxPreviews": True})
        if not isinstance(selected, dict) or any(key not in ("mediaLibrary", "videoLibrary", "audioLibrary", "textBoxPreviews") or not isinstance(value, bool) for key, value in selected.items()):
            return web.json_response({"error": "invalid library selection"}, status=400)
        result = await _media_archive_io(_media_read_archive, path, selected)
        return web.json_response(result)
    except (ValueError, KeyError, OSError, zipfile.BadZipFile, RuntimeError) as exc:
        return web.json_response({"error": str(exc)}, status=400)
    finally:
        os.remove(path)


@routes.delete("/xzg/media-library/archive")
@xzg_safe_handler
async def xzg_media_library_archive_discard(request):
    data = await request.json()
    token = data.get("token") if isinstance(data, dict) else None
    if not isinstance(token, str):
        return web.json_response({"error": "invalid backup token"}, status=400)
    _media_discard_archive(token)
    return web.json_response({"discarded": True})


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
            rel = _media_safe_rel(entry.get("name") if isinstance(entry, dict) else None)
            encoded = entry.get("data") if isinstance(entry, dict) else None
            if not rel or not isinstance(encoded, str):
                raise ValueError("invalid image entry")
            raw = base64.b64decode(encoded, validate=True)
            if len(raw) > MEDIA_MAX_FILE_BYTES:
                raise ValueError("image exceeds 100 MB")
            target_path = _media_resolve_path(directory, rel)
            target_dir = os.path.dirname(target_path)
            os.makedirs(target_dir, exist_ok=True)
            fd, path = tempfile.mkstemp(prefix=".restore-", dir=target_dir)
            staged.append((target_path, path))
            with os.fdopen(fd, "wb") as out:
                out.write(raw)
            _media_validate_image(path)
        for target_path, path in staged:
            os.replace(path, target_path)
        backed_up_order = data.get("order")
        imported = [os.path.relpath(tp, directory).replace("\\", "/") for tp, _ in staged]
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
    arr = (img_t[0].detach().cpu().numpy().clip(0, 1) * 255).astype(np.uint8)
    pil = Image.fromarray(arr, mode="RGBA" if arr.shape[-1] == 4 else "RGB")
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


# ═══════════════════════════════════════════════════════════════════════════
# 空选兜底图片（与「小珠光视频加载-化神级」同一机制）
# 用户没在节点上加载任何图片，或所列图片全部丢失/加载失败时，自动加载内置占位图片，
# 让节点能留在工作流上直接跑通而不返回空列表。
# 图片随插件分发（assets/xzg_theme_icon.png），不依赖外部绝对路径。
# ═══════════════════════════════════════════════════════════════════════════
_FALLBACK_IMAGE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "assets", "xzg_theme_icon.png"
)
# ComfyUI 的 get_annotated_filepath 只接受 input 目录下的相对文件名，拒绝任意绝对路径。
# 因此首次使用时把内置占位图片复制到 input 目录下一个固定文件名，再传相对名给解码逻辑。
_FALLBACK_IMAGE_INPUT_NAME = "xzg_fallback_theme.png"


def _ensure_fallback_image_in_input():
    """确保 input 目录下存在兜底占位图片，返回它在 input 下的相对文件名。"""
    try:
        input_dir = folder_paths.get_input_directory()
        dst = os.path.join(input_dir, _FALLBACK_IMAGE_INPUT_NAME)
        if os.path.isfile(_FALLBACK_IMAGE) and not os.path.isfile(dst):
            shutil.copy2(_FALLBACK_IMAGE, dst)
            print(f"[小珠光图像加载器] 已复制内置占位图片到 input/{_FALLBACK_IMAGE_INPUT_NAME}")
        if os.path.isfile(dst):
            return _FALLBACK_IMAGE_INPUT_NAME
    except Exception as e:
        print(f"[小珠光图像加载器] 准备兜底图片失败：{e}")
    return ""


def _fallback_image_names():
    """空选/全部丢失时回退到的图片文件名列表；无法准备占位图片时返回空列表。"""
    name = _ensure_fallback_image_in_input()
    return [name] if name else []


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
                "remove_alpha": ("BOOLEAN", {"default": False}),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("images", "mask")
    OUTPUT_IS_LIST = (True, True)
    FUNCTION = "load_images"
    CATEGORY = "xiaozhuguang"

    def load_images(self, image_list, index, batch_mode, batch_align=False, max_images=0, remove_alpha=False, unique_id=None, mask_data="", crop_data="", upload_mode="append", mask_output_enabled=False, mask_output_color="#ff0000"):
        mask_output_enabled = mask_output_enabled is True or str(mask_output_enabled).strip().lower() in ("true", "1")
        remove_alpha = remove_alpha is True or str(remove_alpha).strip().lower() in ("true", "1")
        crop_padding_rgb = _parse_crop_padding_color(crop_data)
        # 空选/所列图片全部丢失时回退到内置占位图片（防报错，与视频加载器同一机制）。
        names = [n.strip() for n in (image_list or "").split("\n") if n.strip()]

        # 裁剪矩形改为逐图解析（见下方 crops_loaded）：每张图按自己的映射矩形独立裁剪
        def _load_names(names_list):
            images = []
            loaded_names = []
            orig_sizes = []  # 每张图裁剪前的原始尺寸 (w, h)
            image_alphas = []  # 每张图的 alpha 通道（无 alpha 则 None），用于无用户遮罩时回退提取
            crops_loaded = []  # 与 images 对齐，每张图自己的裁剪矩形（原图像素，None=该图不裁剪）
            transforms_loaded = []
            for name in names_list:
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
                    # 保留原图 Alpha 到 IMAGE 的第 4 通道，除非用户主动选择移除。
                    alpha = img.getchannel('A') if 'A' in img.getbands() and not remove_alpha else None
                    if remove_alpha and 'A' in img.getbands():
                        # 合成到不透明背景，避免透明像素的 RGB 残留造成色边。
                        rgba = img.convert("RGBA")
                        opaque = Image.new("RGBA", rgba.size, (0, 0, 0, 255))
                        img = Image.alpha_composite(opaque, rgba).convert("RGB")
                    elif 'A' in img.getbands():
                        img = img.convert("RGBA")
                    else:
                        img = img.convert("RGB")
                    image = img
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
            return images, loaded_names, orig_sizes, image_alphas, crops_loaded, transforms_loaded

        images, loaded_names, orig_sizes, image_alphas, crops_loaded, transforms_loaded = _load_names(names)
        if not images:
            # 空选（image_list 为空）或所列文件全部缺失/加载失败：加载内置占位图片，避免输出空列表。
            fallback_names = _fallback_image_names()
            if fallback_names:
                images, loaded_names, orig_sizes, image_alphas, crops_loaded, transforms_loaded = _load_names(fallback_names)

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
            tinted_rgb = image_tensor[..., :3] * (1.0 - alpha) + color_tensor * alpha
            if image_tensor.shape[-1] > 3:
                return torch.cat((tinted_rgb, image_tensor[..., 3:]), dim=-1).clamp(0.0, 1.0)
            return tinted_rgb.clamp(0.0, 1.0)

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

                img_arr = (img[0].numpy().clip(0, 1) * 255).astype(np.uint8)
                img_pil = Image.fromarray(img_arr, mode="RGBA" if img_arr.shape[-1] == 4 else "RGB")
                mask_pil = Image.fromarray((mask[0].numpy() * 255).clip(0, 255).astype(np.uint8))
                if use_letterbox:
                    # letterbox 留边：等比缩放至完全放入 max_w×max_h，四周用黑色填充补齐
                    scale = min(max_h / h, max_w / w)
                    new_h = max(1, int(round(h * scale)))
                    new_w = max(1, int(round(w * scale)))
                    img_pil = img_pil.resize((new_w, new_h), Image.LANCZOS)
                    canvas = Image.new(img_pil.mode, (max_w, max_h), (0, 0, 0, 0) if img_pil.mode == "RGBA" else (0, 0, 0))
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
    "XiaozhuguangImageLoader": "小珠光图像加载器-化神级",
}

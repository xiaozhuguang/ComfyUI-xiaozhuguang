"""Store decoded comparison frames on disk and serve byte ranges on demand."""

import asyncio
import hashlib
import os
import re
import json
import secrets
import subprocess
import time

from aiohttp import web
import folder_paths
from server import PromptServer

from .xzg_video_loader import _xzg_loader_abs, ffmpeg_path
from .xzg_video_save_davinci import _lookup_abs_token


_FRAME = re.compile(rb"pts_time:\s*(\S+).*?\bs:(\d+)x(\d+)")
_CACHES = {}
_MAX_IDLE_SECONDS = 1800

# 持久化对比缓存：按「源文件 + 区间 + 分辨率」复用，避免每次打开都重新解码。
_CACHE_ROOT = os.path.join(folder_paths.get_user_directory(), "xzg_compare_cache")
_CACHE_LIMIT_BYTES = 20 * 1024 ** 3
_CACHE_MAX_AGE_SECONDS = 7 * 24 * 3600
_ORPHAN_GRACE_SECONDS = 3600
_CLEANUP_INTERVAL_SECONDS = 300
_KEY_LOCKS = {}
_last_cleanup = 0.0


def _comparison_pixel_format(path):
    """优先使用 I420 缓存：同等分辨率下数据量约为 RGBA 的 1/2.7，浏览器绘制也更快。

    返回 (pixel_format, color)，color 为 VideoFrame 需要的色彩元数据。
    只对 8bit 4:2:0 生效；10bit/4:2:2/4:4:4 仍回退 RGBA。
    """
    probe = subprocess.run(
        [ffmpeg_path, "-nostdin", "-hide_banner", "-i", path],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=15,
    )
    stream = next((line for line in probe.stderr.splitlines() if b"Video:" in line), b"")
    match = re.search(rb"\b(yuvj?420p)(?!\d)(?:\(([^)]*)\))?", stream)
    if not match:
        return "rgba", None
    full_range = match.group(1) == b"yuvj420p"
    params = [
        part.strip()
        for item in (match.group(2) or b"").split(b",")
        for part in item.split(b"/")
    ]
    if b"pc" in params or b"jpeg" in params:
        full_range = True
    elif b"tv" in params:
        full_range = False
    # HDR/未知传递函数回退 RGBA，避免 I420 色彩错误。
    if any(part in {b"smpte2084", b"arib-std-b67", b"pq", b"hlg"} for part in params):
        return "rgba", None
    matrices = {
        b"bt709": "bt709", b"bt470bg": "bt470bg", b"smpte170m": "smpte170m",
        b"bt2020nc": "bt2020-ncl", b"bt2020ncl": "bt2020-ncl",
    }
    transfers = {
        b"bt709": "bt709", b"iec61966-2-1": "iec61966-2-1", b"smpte170m": "smpte170m",
        b"linear": "linear",
    }
    primaries_map = {
        b"bt709": "bt709", b"bt470bg": "bt470bg", b"smpte170m": "smpte170m", b"bt2020": "bt2020",
    }
    matrix = next((matrices[p] for p in params if p in matrices), "bt709")
    transfer = next((transfers[p] for p in params if p in transfers), "bt709")
    primaries = next((primaries_map[p] for p in params if p in primaries_map), "bt709")
    return "yuv420p", {
        "transfer": transfer, "matrix": matrix, "primaries": primaries, "full_range": full_range,
    }


def _frame_size(width, height, pixel_format):
    if pixel_format == "yuv420p":
        return width * height + 2 * ((width + 1) // 2) * ((height + 1) // 2)
    return width * height * 4


def _safe_unlink(path):
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    except OSError:
        pass


def _compare_cache_key(path, stat, start, end, max_height, pixel_format):
    raw = "|".join((
        os.path.realpath(path), str(stat.st_size), str(stat.st_mtime_ns),
        f"{start:.6f}", f"{end:.6f}", str(max_height), pixel_format,
    ))
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:32]


def _load_cache_meta(meta_path, cache_path):
    try:
        with open(meta_path, "r", encoding="utf-8") as handle:
            meta = json.load(handle)
        if not meta.get("frames") or int(meta.get("bytes", -1)) != os.path.getsize(cache_path):
            return None
        return meta
    except (OSError, ValueError, TypeError):
        return None


def _write_cache_meta(meta_path, meta):
    temp_path = meta_path + ".tmp"
    with open(temp_path, "w", encoding="utf-8") as handle:
        json.dump(meta, handle)
    os.replace(temp_path, meta_path)


def _touch_cache_meta(meta_path, meta):
    now = time.time()
    if now - float(meta.get("last_access") or 0) < 60:
        return
    meta["last_access"] = now
    try:
        _write_cache_meta(meta_path, meta)
    except OSError:
        pass


def _cleanup_persistent_cache(force=False):
    """按「最久未用」清理：超过 7 天或总量超过 20GB 时淘汰，正在使用的文件不动。"""
    global _last_cleanup
    now = time.time()
    if not force and now - _last_cleanup < _CLEANUP_INTERVAL_SECONDS:
        return
    _last_cleanup = now
    try:
        names = os.listdir(_CACHE_ROOT)
    except OSError:
        return
    active = {entry[0] for entry in _CACHES.values()}
    records = []
    total = 0
    for name in names:
        if not name.endswith(".json"):
            continue
        meta_path = os.path.join(_CACHE_ROOT, name)
        raw_path = meta_path[:-5] + ".raw"
        if not os.path.isfile(raw_path):
            _safe_unlink(meta_path)
            continue
        try:
            size = os.path.getsize(raw_path)
            with open(meta_path, "r", encoding="utf-8") as handle:
                meta = json.load(handle)
        except (OSError, ValueError):
            continue
        if int(meta.get("bytes", -1)) != size:
            continue
        records.append((
            float(meta.get("last_access") or os.path.getmtime(meta_path)),
            size, meta_path, raw_path,
        ))
        total += size
    for last_access, size, meta_path, raw_path in sorted(records):
        if raw_path in active:
            continue
        if total <= _CACHE_LIMIT_BYTES and now - last_access <= _CACHE_MAX_AGE_SECONDS:
            break
        _safe_unlink(raw_path)
        _safe_unlink(meta_path)
        total -= size
    # 清理中断留下的孤儿 raw 文件（超过 1 小时仍没有 meta）。
    for name in names:
        if not name.endswith(".raw"):
            continue
        raw_path = os.path.join(_CACHE_ROOT, name)
        if os.path.exists(raw_path[:-4] + ".json"):
            continue
        try:
            if now - os.path.getmtime(raw_path) > _ORPHAN_GRACE_SECONDS:
                _safe_unlink(raw_path)
        except OSError:
            pass


def _wipe_persistent_cache():
    """每次 ComfyUI 启动时清空：缓存只在单次运行期间复用。"""
    try:
        names = os.listdir(_CACHE_ROOT)
    except OSError:
        return
    for name in names:
        if name.endswith((".raw", ".json", ".tmp")):
            _safe_unlink(os.path.join(_CACHE_ROOT, name))


def _remove_cache(token):
    entry = _CACHES.get(token)
    if not entry:
        return
    path = entry[0]
    if path.startswith(_CACHE_ROOT + os.sep):
        # 持久缓存只在 LRU/过期清理时删除，避免重复解码。
        _CACHES.pop(token, None)
        return
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    except OSError:
        # Windows can keep a file open until an in-flight range response closes.
        _CACHES[token] = (path, 0)
        return
    _CACHES.pop(token, None)


try:
    os.makedirs(_CACHE_ROOT, exist_ok=True)
    _wipe_persistent_cache()
except OSError:
    pass


async def _serve_cached_frames(request, cache_path, meta_path, meta):
    """直接复用已生成的持久缓存，不再运行 FFmpeg。"""
    _touch_cache_meta(meta_path, meta)
    cache_token = secrets.token_urlsafe(24)
    _CACHES[cache_token] = (cache_path, time.monotonic())
    response = web.StreamResponse(headers={
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-store",
    })
    try:
        await response.prepare(request)
        await response.write(json.dumps({"progress": 1}).encode() + b"\n")
        await response.write(json.dumps({
            "token": cache_token, "frames": meta["frames"], "format": meta["format"],
            "color": meta.get("color"), "reused": True,
        }).encode() + b"\n")
    except ConnectionError:
        _remove_cache(cache_token)
    return response


@PromptServer.instance.routes.get("/xzg/video_compare_frames/{token}")
async def read_video_compare_frames(request):
    token = request.match_info["token"]
    entry = _CACHES.get(token)
    if not entry:
        return web.Response(status=404)
    path, _ = entry
    _CACHES[token] = (path, time.monotonic())
    return web.FileResponse(path, headers={"Cache-Control": "no-store"})


@PromptServer.instance.routes.delete("/xzg/video_compare_frames/{token}")
async def release_video_compare_frames(request):
    _remove_cache(request.match_info["token"])
    return web.Response(status=204)


@PromptServer.instance.routes.post("/xzg/video_compare_frames")
async def video_compare_frames(request):
    try:
        data = await request.json()
        token = data.get("token")
        if token:
            path = _lookup_abs_token(token)
        else:
            filename = data["filename"]
            media_type = data.get("type", "input")
            subfolder = data.get("subfolder", "")
            if media_type not in ("input", "output", "temp"):
                raise ValueError("Invalid media type")
            path = os.path.realpath(_xzg_loader_abs(filename, media_type, subfolder))
            root = os.path.realpath(_xzg_loader_abs("", media_type))
            if os.path.commonpath((root, path)) != root:
                raise ValueError("Invalid media path")
        start, end = float(data["start"]), float(data["end"])
        if not 0 <= start < end < float("inf"):
            raise ValueError("Invalid comparison range")
        try:
            max_height = int(data.get("max_height") or 0)
        except (TypeError, ValueError):
            max_height = 0
        if max_height and not 120 <= max_height <= 2160:
            max_height = 0
    except (KeyError, TypeError, ValueError):
        return web.Response(status=400, text="Invalid comparison request")
    if not path or not os.path.isfile(path):
        return web.Response(status=404, text="Video source unavailable")

    now = time.monotonic()
    for cache_token, (_, last_read) in list(_CACHES.items()):
        if now - last_read > _MAX_IDLE_SECONDS:
            _remove_cache(cache_token)

    pixel_format, color = (
        await asyncio.to_thread(_comparison_pixel_format, path) if data.get("i420") else ("rgba", None)
    )
    try:
        stat = os.stat(path)
        key = _compare_cache_key(path, stat, start, end, max_height, pixel_format)
    except OSError:
        return web.Response(status=404, text="Video source unavailable")
    cache_path = os.path.join(_CACHE_ROOT, f"{key}.raw")
    meta_path = os.path.join(_CACHE_ROOT, f"{key}.json")

    cached = _load_cache_meta(meta_path, cache_path)
    if cached:
        return await _serve_cached_frames(request, cache_path, meta_path, cached)

    lock = _KEY_LOCKS.setdefault(key, asyncio.Lock())
    async with lock:
        # 等锁期间可能已被另一个请求生成完成。
        cached = _load_cache_meta(meta_path, cache_path)
        if cached:
            return await _serve_cached_frames(request, cache_path, meta_path, cached)

        # 代理模式：按最长边/高度上限缩小缓存帧（类似剪辑软件的代理媒体），
        # 大幅降低逐帧读取带宽与浏览器绘制开销；不放大原本更小的视频。
        filters = f"trim=start={start}:end={end}"
        if max_height:
            filters += f",scale=-2:min(ih\\,{max_height})"
        filters += f",format={pixel_format},showinfo=checksum=0"
        command = [
            ffmpeg_path, "-nostdin", "-hide_banner", "-v", "info", "-i", path,
            "-map", "0:v:0", "-an", "-sn", "-dn",
            "-vf", filters,
            "-fps_mode", "passthrough", "-threads:v", "1", "-f", "rawvideo", "-y", cache_path,
        ]
        try:
            process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        except Exception:
            _safe_unlink(cache_path)
            raise
        frames = asyncio.Queue()
        loop = asyncio.get_running_loop()

        def read_timestamps():
            try:
                for line in process.stderr:
                    match = _FRAME.search(line)
                    if match:
                        pts, width, height = match.groups()
                        loop.call_soon_threadsafe(frames.put_nowait, (float(pts), int(width), int(height)))
            finally:
                loop.call_soon_threadsafe(frames.put_nowait, None)

        timestamps = asyncio.create_task(asyncio.to_thread(read_timestamps))
        response = web.StreamResponse(headers={
            "Content-Type": "application/x-ndjson",
            "Cache-Control": "no-store",
        })
        cache_token = None
        index = []
        last_percent = -1
        try:
            await response.prepare(request)
            while (frame := await frames.get()) is not None:
                pts, width, height = frame
                index.append(frame)
                percent = max(0, min(99, int((pts - start) / (end - start) * 100)))
                if percent != last_percent:
                    last_percent = percent
                    await response.write(json.dumps({"progress": percent / 100}).encode() + b"\n")
            expected_size = sum(_frame_size(width, height, pixel_format) for _, width, height in index)
            if await asyncio.to_thread(process.wait) != 0 or not index or os.path.getsize(cache_path) != expected_size:
                await response.write(b'{"error":"FFmpeg did not complete the frame cache"}\n')
                return response
            meta = {
                "key": key, "source": os.path.realpath(path),
                "source_size": stat.st_size, "source_mtime_ns": stat.st_mtime_ns,
                "start": start, "end": end, "max_height": max_height,
                "format": pixel_format, "color": color,
                "frames": index, "bytes": expected_size, "last_access": time.time(),
            }
            _write_cache_meta(meta_path, meta)
            cache_token = secrets.token_urlsafe(24)
            _CACHES[cache_token] = (cache_path, time.monotonic())
            await response.write(json.dumps({
                "token": cache_token, "frames": index, "format": pixel_format,
                "color": color, "reused": False,
            }).encode() + b"\n")
            return response
        except ConnectionError:
            if cache_token:
                _remove_cache(cache_token)
            return response
        finally:
            if process.poll() is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
            await asyncio.gather(timestamps, asyncio.to_thread(process.wait), return_exceptions=True)
            process.stderr.close()
            if not cache_token:
                _safe_unlink(cache_path)
            _cleanup_persistent_cache()

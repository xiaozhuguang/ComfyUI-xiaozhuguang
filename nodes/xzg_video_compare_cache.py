"""Store decoded comparison frames on disk and serve byte ranges on demand."""

import asyncio
import os
import re
import json
import secrets
import subprocess
import tempfile
import time

from aiohttp import web
import folder_paths
from server import PromptServer

from .xzg_video_loader import _xzg_loader_abs, ffmpeg_path
from .xzg_video_save_davinci import _lookup_abs_token


_FRAME = re.compile(rb"pts_time:\s*(\S+).*?\bs:(\d+)x(\d+)")
_CACHES = {}
_MAX_IDLE_SECONDS = 1800


def _comparison_pixel_format(path):
    probe = subprocess.run(
        [ffmpeg_path, "-nostdin", "-hide_banner", "-i", path],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=15,
    )
    stream = next((line for line in probe.stderr.splitlines() if b"Video:" in line), b"")
    # The browser's I420 path preserves limited-range BT.709 YUV samples.
    match = re.search(rb"\byuv420p\(tv, bt709(?:/bt709/(bt709|iec61966-2-1))?(?:, [^)]*)?\)", stream)
    if match:
        return "yuv420p", (match[1] or b"bt709").decode()
    return "rgba", None


def _frame_size(width, height, pixel_format):
    if pixel_format == "yuv420p":
        return width * height + 2 * ((width + 1) // 2) * ((height + 1) // 2)
    return width * height * 4


def _remove_cache(token):
    entry = _CACHES.get(token)
    if entry:
        try:
            os.unlink(entry[0])
        except FileNotFoundError:
            pass
        except OSError:
            # Windows can keep a file open until an in-flight range response closes.
            _CACHES[token] = (entry[0], 0)
            return
        _CACHES.pop(token, None)


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
    except (KeyError, TypeError, ValueError):
        return web.Response(status=400, text="Invalid comparison request")
    if not path or not os.path.isfile(path):
        return web.Response(status=404, text="Video source unavailable")

    now = time.monotonic()
    for cache_token, (_, last_read) in list(_CACHES.items()):
        if now - last_read > _MAX_IDLE_SECONDS:
            _remove_cache(cache_token)

    pixel_format, transfer = (
        await asyncio.to_thread(_comparison_pixel_format, path) if data.get("i420") else ("rgba", None)
    )
    fd, cache_path = tempfile.mkstemp(
        prefix="xzg_compare_", suffix=f".{pixel_format}", dir=folder_paths.get_temp_directory()
    )
    os.close(fd)
    command = [
        ffmpeg_path, "-nostdin", "-hide_banner", "-v", "info", "-i", path,
        "-map", "0:v:0", "-an", "-sn", "-dn",
        "-vf", f"trim=start={start}:end={end},format={pixel_format},showinfo=checksum=0",
        "-fps_mode", "passthrough", "-threads:v", "1", "-f", "rawvideo", "-y", cache_path,
    ]
    try:
        process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    except Exception:
        os.unlink(cache_path)
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
        cache_token = secrets.token_urlsafe(24)
        _CACHES[cache_token] = (cache_path, time.monotonic())
        await response.write(json.dumps({
            "token": cache_token, "frames": index, "format": pixel_format, "transfer": transfer,
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
        if not cache_token and os.path.exists(cache_path):
            os.unlink(cache_path)

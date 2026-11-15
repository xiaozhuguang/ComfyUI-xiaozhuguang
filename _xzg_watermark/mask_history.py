"""Compressed, per-node mask history stored in the ComfyUI user directory."""
import asyncio
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
from threading import Lock

from aiohttp import web
import folder_paths
from server import PromptServer


_lock = Lock()
_routes = PromptServer.instance.routes


def _history_path(key):
    if not isinstance(key, str) or not re.fullmatch(r"[0-9a-f]{36}", key):
        raise ValueError("无效的遮罩历史标识")
    return Path(folder_paths.get_user_directory()) / "xiaozhuguang" / "manual_mask_history" / (key + ".json.gz")


def _read(path):
    if not path.exists():
        return []
    with gzip.open(path, "rt", encoding="utf-8") as stream:
        return json.load(stream)


def _store(path, entries):
    with _lock:
        versions = _read(path)
        changed = False
        for entry in entries:
            data = entry.get("data")
            video_id = entry.get("videoId")
            saved_at = entry.get("savedAt")
            if (not isinstance(data, str) or not isinstance(video_id, str) or not video_id
                    or type(saved_at) is not int):
                raise ValueError("无效的遮罩历史版本")
            version_id = hashlib.sha256((video_id + "\0" + data).encode()).hexdigest()
            if not any(version["id"] == version_id for version in versions):
                versions.append({"id": version_id, "videoId": video_id, "savedAt": saved_at, "data": data})
                changed = True
        if not changed:
            return
        versions.sort(key=lambda version: version["savedAt"], reverse=True)
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
            temp = Path(stream.name)
        try:
            with gzip.open(temp, "wt", encoding="utf-8", compresslevel=3) as stream:
                json.dump(versions[:10], stream, ensure_ascii=False, separators=(",", ":"))
            os.replace(temp, path)
        finally:
            temp.unlink(missing_ok=True)


def _load(path):
    with _lock:
        return _read(path)


@_routes.post("/xzg/manual-mask/history/{key}")
async def save_history(request):
    try:
        entries = await request.json()
        if not isinstance(entries, list) or not 1 <= len(entries) <= 11 or any(not isinstance(entry, dict) for entry in entries):
            raise ValueError("无效的遮罩历史请求")
        await asyncio.to_thread(_store, _history_path(request.match_info["key"]), entries)
        return web.json_response({"ok": True})
    except ValueError as error:
        return web.json_response({"error": str(error)}, status=400)


@_routes.get("/xzg/manual-mask/history/{key}")
async def load_history(request):
    try:
        versions = await asyncio.to_thread(_load, _history_path(request.match_info["key"]))
        video_id = request.query.get("video")
        version_id = request.query.get("version")
        matches = [version for version in versions if version["videoId"] == video_id]
        if version_id:
            version = next((item for item in matches if item["id"] == version_id), None)
            return web.json_response(version or {"error": "历史版本已移除"}, status=200 if version else 404)
        return web.json_response([{key: value for key, value in item.items() if key != "data"} for item in matches])
    except ValueError as error:
        return web.json_response({"error": str(error)}, status=400)

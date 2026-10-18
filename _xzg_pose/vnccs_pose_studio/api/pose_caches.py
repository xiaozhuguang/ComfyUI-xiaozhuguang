"""HTTP adapter for Pose Studio capture cache."""

from ..nodes.posestudio import caches as pose_cache
from ..nodes.shared.paths import _vnccs_safe_id


def _vnccs_content_length_ok(request, max_bytes):
    try:
        raw_length = request.headers.get("Content-Length")
        if raw_length is None:
            return not getattr(request, "can_read_body", False)
        length = int(raw_length)
    except (TypeError, ValueError):
        return False
    return 0 <= length <= int(max_bytes or 0)


def _vnccs_register_capture_cache():
    try:
        from server import PromptServer
        from aiohttp import web
    except ImportError:
        return

    @PromptServer.instance.routes.post("/vnccs/pose_captures_upload")
    async def vnccs_pose_captures_upload(request):
        if not _vnccs_content_length_ok(request, pose_cache._CAPTURE_CACHE_MAX_TOTAL_CHARS + 1024 * 1024):
            return web.json_response({"error": "captured_images payload is too large"}, status=413)
        try:
            data = await request.json()
            if not isinstance(data, dict):
                return web.json_response({"error": "request body must be an object"}, status=400)
            capture_id = data.get("capture_id")
            if not isinstance(capture_id, str) or not capture_id:
                return web.json_response({"error": "missing capture_id"}, status=400)
            capture_id = _vnccs_safe_id(capture_id, "capture")
            captured_images = pose_cache._vnccs_validate_capture_payload(data)
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=400)

        pose_cache.VNCCS_CAPTURE_CACHE.pop(capture_id, None)
        pose_cache.VNCCS_CAPTURE_CACHE[capture_id] = {"captured_images": captured_images}
        while len(pose_cache.VNCCS_CAPTURE_CACHE) > pose_cache._CAPTURE_CACHE_MAX:
            del pose_cache.VNCCS_CAPTURE_CACHE[next(iter(pose_cache.VNCCS_CAPTURE_CACHE))]
        return web.json_response({"status": "ok", "capture_id": capture_id})

    @PromptServer.instance.routes.get("/vnccs/pose_captures/{capture_id}")
    async def vnccs_pose_captures_get(request):
        capture_id = _vnccs_safe_id(request.match_info["capture_id"], "capture")
        entry = pose_cache.vnccs_get_capture_cache(capture_id)
        if not entry:
            return web.json_response({"error": "not found"}, status=404)
        return web.json_response(entry)



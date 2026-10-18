"""Pose capture cache shared by HTTP and graph execution."""
import json
import os
from ..shared.paths import _vnccs_safe_id

_CAPTURE_CACHE_MAX_IMAGES = 600


_CAPTURE_CACHE_MAX_TOTAL_CHARS = 64 * 1024 * 1024


def _vnccs_validate_capture_payload(data):
    captured_images = data.get("captured_images", [])
    if not isinstance(captured_images, list):
        raise ValueError("captured_images must be a list")
    if len(captured_images) > _CAPTURE_CACHE_MAX_IMAGES:
        raise ValueError(f"captured_images limit is {_CAPTURE_CACHE_MAX_IMAGES}")
    total_chars = 0
    for image in captured_images:
        if not isinstance(image, str):
            raise ValueError("captured_images entries must be strings")
        total_chars += len(image)
        if total_chars > _CAPTURE_CACHE_MAX_TOTAL_CHARS:
            raise ValueError("captured_images payload is too large")
    return captured_images


VNCCS_CAPTURE_CACHE = {}


_CAPTURE_CACHE_MAX = 10


def vnccs_get_capture_cache(capture_id):
    capture_id = _vnccs_safe_id(capture_id, "capture")
    entry = VNCCS_CAPTURE_CACHE.pop(capture_id, None)
    if entry is not None:
        VNCCS_CAPTURE_CACHE[capture_id] = entry
    return entry



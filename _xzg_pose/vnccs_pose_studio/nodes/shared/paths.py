"""ComfyUI-managed runtime roots shared by node services."""
import os
import re

# This package is vendored below the existing xiaozhuguang extension.
_EXTENSION_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

_SAFE_ID_RE = re.compile(r"[^A-Za-z0-9_-]+")

def _vnccs_runtime_temp_root():
    try:
        import folder_paths

        root = folder_paths.get_temp_directory()
    except Exception:
        root = os.path.join(_EXTENSION_ROOT, ".runtime_cache")
    os.makedirs(root, exist_ok=True)
    return root


def _vnccs_user_data_root():
    """Keep all Pose Studio persistent data under the parent plugin's user root."""
    root = os.path.join(_xiaozhuguang_user_data_root(), "vnssc")
    os.makedirs(root, exist_ok=True)
    return root


def _xiaozhuguang_user_data_root():
    """Return the extension's shared ComfyUI user-data directory."""
    try:
        import folder_paths

        root = folder_paths.get_user_directory()
    except Exception:
        root = os.path.join(_EXTENSION_ROOT, ".runtime_cache", "user")
    root = os.path.join(root, "xiaozhuguang")
    os.makedirs(root, exist_ok=True)
    return root


def _vnccs_safe_id(value, fallback="item"):
    cleaned = _SAFE_ID_RE.sub("_", str(value or "")).strip("_")
    return cleaned[:128].rstrip("_") or fallback

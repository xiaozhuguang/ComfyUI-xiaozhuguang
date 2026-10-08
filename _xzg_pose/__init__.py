"""小珠光视频姿势编辑器：从独立 comfyui-pose 插件并入。"""

from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

try:
    from . import routes  # noqa: F401  # Register preview endpoints with ComfyUI.
except ModuleNotFoundError as exc:
    # Keep pure pose-core usage available outside ComfyUI; in ComfyUI these
    # modules are supplied by the host application.
    if exc.name not in {"aiohttp", "server"}:
        raise

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

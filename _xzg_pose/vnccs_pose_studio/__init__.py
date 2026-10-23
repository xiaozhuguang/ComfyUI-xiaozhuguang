from .deps import (
    dependency_error_message,
    ensure_pose_dependencies,
    pose_dependency_state,
)

from .nodes.pose_studio import VNCCS_PoseStudio

NODE_CLASS_MAPPINGS = {
    "VNCCS_PoseStudio": VNCCS_PoseStudio,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VNCCS_PoseStudio": "VNCCS 姿势工作室",
}

# Browser assets are served by the parent plugin's top-level web/ directory.
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

import json
import numpy as np

_SAM3D_MAX_UPLOAD_BYTES = 32 * 1024 * 1024
_SAM3D_MAX_PIXELS = 4096 * 4096

from .api.pose_caches import (
    _vnccs_content_length_ok,
    _vnccs_register_capture_cache,
)

# 注册姿势库 API
try:
    from .nodes.posestudio.library import get_library_path
    get_library_path()
except Exception as e:
    print(f"[VNCCS] Failed to initialize Pose Library storage: {e}")

def _vnccs_register_pose_library():
    try:
        from server import PromptServer
        from .api.pose_library import register_routes
        register_routes(PromptServer.instance.app)
    except Exception as e:
        print(f"[VNCCS] Failed to register Pose Library API: {e}")

_vnccs_register_pose_library()

# 注册 Pose Studio 运行时同步 API
def _vnccs_register_pose_sync():
    try:
        from server import PromptServer
        from .api.pose_capture_sync import register_routes
        register_routes(PromptServer.instance.app)
    except Exception as e:
        print(f"[VNCCS] Failed to register Pose Sync API: {e}")

_vnccs_register_pose_sync()

# === Pose Studio 捕获缓存 ===

_vnccs_register_capture_cache()



def _vnccs_register_sam3d_pose_import():
    try:
        from server import PromptServer
        from aiohttp import web
    except Exception:
        return

    @PromptServer.instance.routes.get("/vnccs/sam3d/import_status/{task_id}")
    async def vnccs_sam3d_import_status(request):
        try:
            from .nodes.pose_studio import _load_bundled_sam3d
            import importlib
            sam3d = _load_bundled_sam3d()
            progress = importlib.import_module(f"{sam3d.__name__}.progress")

            return web.json_response(progress.get_task(request.match_info["task_id"]))
        except Exception as e:
            return web.json_response({
                "status": "unknown",
                "message": str(e),
                "progress": 0,
            })

    @PromptServer.instance.routes.post("/vnccs/sam3d/unload_models")
    async def vnccs_sam3d_unload_models(request):
        try:
            import asyncio
            import importlib
            from .nodes.pose_studio import _load_bundled_sam3d

            sam3d = _load_bundled_sam3d()
            runtime = importlib.import_module(f"{sam3d.__name__}.runtime")
            wait_for_models = str(request.query.get("wait") or "").strip().lower() in {"1", "true", "yes"}
            result = await asyncio.to_thread(runtime.unload_recognition_models, wait=wait_for_models)
            return web.json_response(result)
        except RuntimeError as exc:
            return web.json_response({"error": str(exc)}, status=409)
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)

    @PromptServer.instance.routes.post("/vnccs/sam3d/process_image_to_pose_json")
    async def vnccs_sam3d_process_image_to_pose_json(request):
        try:
            import io
            import json
            import asyncio
            import torch
            from PIL import Image

            if not _vnccs_content_length_ok(request, _SAM3D_MAX_UPLOAD_BYTES + 1024 * 1024):
                return web.json_response({"error": "image upload is too large"}, status=413)
            post = await request.post()
            image_field = post.get("image")
            if image_field is None or not hasattr(image_field, "file"):
                return web.json_response({"error": "missing image"}, status=400)
            task_id = str(post.get("task_id") or "")
            auto_unload = str(post.get("auto_unload") or "").strip().lower() in {"1", "true", "yes"}

            image_bytes = image_field.file.read()
            if len(image_bytes) > _SAM3D_MAX_UPLOAD_BYTES:
                return web.json_response({"error": "image upload is too large"}, status=413)
            pil_image = Image.open(io.BytesIO(image_bytes))
            if pil_image.width * pil_image.height > _SAM3D_MAX_PIXELS:
                return web.json_response({"error": "image dimensions are too large"}, status=413)
            pil_image = pil_image.convert("RGB")
            image_np = np.asarray(pil_image).astype(np.float32) / 255.0
            image_tensor = torch.from_numpy(image_np).unsqueeze(0)

            def run_sam3d_process():
                from .nodes.pose_studio import _load_bundled_sam3d
                import importlib
                sam3d = _load_bundled_sam3d()
                progress = importlib.import_module(f"{sam3d.__name__}.progress")

                progress.start_task(task_id)
                with progress.task_context(task_id):
                    progress.update("Step 0/6: 检查姿势识别依赖…", 1)
                    deps_result = ensure_pose_dependencies()
                    if deps_result["missing"]:
                        raise RuntimeError(dependency_error_message())
                    progress.update("Step 1/6: Image uploaded. Preparing SAM 3D Body import...", 2)
                    try:
                        pose_result = sam3d.process_image_to_pose_json(image_tensor)
                    except Exception:
                        if auto_unload:
                            runtime = importlib.import_module(f"{sam3d.__name__}.runtime")
                            runtime.unload_recognition_models(wait=True)
                        raise
                    unload_result = None
                    if auto_unload:
                        progress.update("姿势已识别，正在卸载识别模型…", 96)
                        runtime = importlib.import_module(f"{sam3d.__name__}.runtime")
                        unload_result = runtime.unload_recognition_models(wait=True)
                        progress.finish("姿势识别完成，模型已卸载。")
                    return pose_result, unload_result

            pose_json, unload_result = await asyncio.to_thread(run_sam3d_process)

            try:
                pose_data = json.loads(pose_json)
            except Exception:
                pose_data = None

            return web.json_response({
                "status": "success",
                "pose_json": pose_json,
                "pose_data": pose_data,
                "model_unload": unload_result,
            })
        except Exception as e:
            message = dependency_error_message(exc=e) if isinstance(e, ModuleNotFoundError) else str(e)
            try:
                from .nodes.pose_studio import _load_bundled_sam3d
                import importlib
                sam3d = _load_bundled_sam3d()
                progress = importlib.import_module(f"{sam3d.__name__}.progress")
                with progress.task_context(task_id if "task_id" in locals() else ""):
                    progress.fail(message)
            except Exception:
                pass
            import traceback
            traceback.print_exc()
            return web.json_response({"error": message}, status=500)

    @PromptServer.instance.routes.post("/vnccs/sam3d/render_mesh_overlay")
    async def vnccs_sam3d_render_mesh_overlay(request):
        try:
            import asyncio

            if not _vnccs_content_length_ok(request, 32 * 1024 * 1024):
                return web.json_response({"error": "mesh overlay payload is too large"}, status=413)
            data = await request.json()
            pose_data = data.get("pose_data")
            if not isinstance(pose_data, dict):
                return web.json_response({"error": "missing pose_data"}, status=400)
            body_preset = data.get("body_preset") if isinstance(data.get("body_preset"), dict) else {}
            pose_adjust = float(data.get("pose_adjust") or 0.0)

            def build_overlay():
                from .nodes.pose_studio import _load_bundled_sam3d
                import importlib
                sam3d = _load_bundled_sam3d()
                pose_import = importlib.import_module(f"{sam3d.__name__}.pose_import")

                deps_result = ensure_pose_dependencies()
                if deps_result["missing"]:
                    raise RuntimeError(dependency_error_message())
                return pose_import.process_pose_json_to_overlay_mesh(
                    pose_data,
                    body_preset=body_preset,
                    pose_adjust=pose_adjust,
                )

            mesh_data = await asyncio.to_thread(build_overlay)
            return web.json_response({"status": "success", "mesh": mesh_data})
        except Exception as e:
            message = dependency_error_message(exc=e) if isinstance(e, ModuleNotFoundError) else str(e)
            import traceback
            traceback.print_exc()
            return web.json_response({"error": message}, status=500)

    @PromptServer.instance.routes.get("/vnccs/sam3d/dependency_status")
    async def vnccs_sam3d_dependency_status(request):
        return web.json_response(pose_dependency_state())

_vnccs_register_sam3d_pose_import()

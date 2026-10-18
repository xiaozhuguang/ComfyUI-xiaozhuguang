"""VNCCS Pose Studio - Combined mesh editor and multi-pose generator.

Combines Character Studio mesh sliders with dynamic pose tabs.
Each pose stores bone rotations and global model rotation.
Outputs rendered mesh images with skin material.

MakeHuman morphing, skinning, posing, and rendering run in the browser widget.
The Python node only synchronizes captures and converts them to ComfyUI outputs.
"""

import json
import os
import base64
import re
import uuid
import importlib
import importlib.util
import sys
import types
from io import BytesIO
import hashlib
import threading
from collections import OrderedDict
import torch
import numpy as np
from PIL import Image, ImageOps
_CAPTURED_IMAGE_MAX_COUNT = 600
_CAPTURED_IMAGE_MAX_TOTAL_CHARS = 64 * 1024 * 1024
_CAPTURED_IMAGE_MAX_BYTES = 32 * 1024 * 1024
_CAPTURED_IMAGE_MAX_PIXELS = 4096 * 4096
_CAPTURED_IMAGE_MAX_TOTAL_PIXELS = 64 * 1024 * 1024
_POSE_OUTPUT_MAX_PIXELS = 4096 * 4096
_SAM_POSE_RESULT_CACHE = OrderedDict()
_SAM_POSE_RESULT_CACHE_LOCK = threading.Lock()
_SAM_POSE_RESULT_CACHE_LIMIT = 8


def _pose_image_digest(image_tensor):
    tensor = image_tensor.detach().to(device="cpu").contiguous()
    array = tensor.numpy()
    digest = hashlib.sha256()
    digest.update(str(tuple(tensor.shape)).encode("ascii"))
    digest.update(str(tensor.dtype).encode("ascii"))
    digest.update(memoryview(array).cast("B"))
    return digest.hexdigest()


def _load_bundled_sam3d():
    """Load the bundled SAM package from this file's tree, independent of plugin name."""
    package_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "vnccs_sam3d"))
    init_path = os.path.join(package_dir, "__init__.py")
    if not os.path.isfile(init_path):
        raise ModuleNotFoundError(f"Bundled vnccs_sam3d package not found beside Pose Studio: {package_dir}")

    package_parent = (__package__ or "").rsplit(".nodes", 1)[0]
    if not package_parent or package_parent == (__package__ or ""):
        raise ImportError(f"Could not determine Pose Studio package name from {__package__!r}")
    parent_package = sys.modules.get(package_parent)
    if parent_package is None:
        parent_package = types.ModuleType(package_parent)
        parent_package.__package__ = package_parent
        parent_package.__path__ = [os.path.dirname(package_dir)]
        sys.modules[package_parent] = parent_package
    else:
        search_paths = getattr(parent_package, "__path__", None)
        if search_paths is not None and os.path.dirname(package_dir) not in search_paths:
            parent_package.__path__ = [os.path.dirname(package_dir), *search_paths]
    package_key = f"{package_parent}.vnccs_sam3d"
    module = sys.modules.get(package_key)
    if module is None:
        spec = importlib.util.spec_from_file_location(
            package_key,
            init_path,
            submodule_search_locations=[package_dir],
        )
        if spec is None or spec.loader is None:
            raise ImportError(f"Could not load bundled vnccs_sam3d package from {package_dir}")
        module = importlib.util.module_from_spec(spec)
        sys.modules[package_key] = module
        try:
            spec.loader.exec_module(module)
        except Exception:
            sys.modules.pop(package_key, None)
            raise
    return module

def _decode_pose_images(captured_images, expected_size=None):
    if not isinstance(captured_images, list):
        raise ValueError("captured_images must be a list")
    if len(captured_images) > _CAPTURED_IMAGE_MAX_COUNT:
        raise ValueError(f"captured_images limit is {_CAPTURED_IMAGE_MAX_COUNT}")

    rendered_images = []
    total_chars = 0
    total_pixels = 0
    for b64 in captured_images:
        if not isinstance(b64, str) or not b64:
            raise ValueError("captured_images entries must be non-empty strings")
        total_chars += len(b64)
        if total_chars > _CAPTURED_IMAGE_MAX_TOTAL_CHARS:
            raise ValueError("captured_images payload is too large")
        if "," in b64:
            b64 = b64.split(",", 1)[1]

        img_data = base64.b64decode(b64)
        if len(img_data) > _CAPTURED_IMAGE_MAX_BYTES:
            raise ValueError("captured image is too large")
        img = Image.open(BytesIO(img_data))
        if img.width * img.height > _CAPTURED_IMAGE_MAX_PIXELS:
            raise ValueError("captured image dimensions are too large")
        total_pixels += img.width * img.height
        if total_pixels > _CAPTURED_IMAGE_MAX_TOTAL_PIXELS:
            raise ValueError("Captured sequence is too large. Reduce resolution or frame count.")
        img = img.convert('RGB')
        if expected_size and img.size != expected_size:
            # A stale capture can survive a canvas-size edit in older workflows.
            # Enforce the requested tensor dimensions while preserving the full
            # pose and its aspect ratio; unused canvas area stays black.
            fitted = ImageOps.contain(img, expected_size, method=Image.Resampling.LANCZOS)
            normalized = Image.new("RGB", expected_size, (0, 0, 0))
            normalized.paste(fitted, ((expected_size[0] - fitted.width) // 2,
                                      (expected_size[1] - fitted.height) // 2))
            img = normalized
        rendered_images.append(img)
    return rendered_images


def _positive_int(value, name, default):
    if value is None:
        value = default
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be a positive integer") from exc
    if not number.is_integer() or number < 1:
        raise ValueError(f"{name} must be a positive integer")
    return int(number)


# === Main Node Class ===


class VNCCS_PoseStudio:
    """Pose Studio with mesh editing and multiple pose generation."""
    
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    OUTPUT_IS_LIST = (True,)
    OUTPUT_NODE = False
    FUNCTION = "generate"
    CATEGORY = "小珠光/图片"
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # ALL settings come from widget via pose_data
                "pose_data": ("STRING", {"multiline": True, "default": "{}", "dynamicPrompts": False}),
            },
            "optional": {
                "pose_image": ("IMAGE",),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID"
            }
        }

    @classmethod
    def IS_CHANGED(
        cls,
        pose_data: str = "{}",
        pose_image=None,
        unique_id: str = None,
    ):
        change_key = pose_data
        if pose_image is None:
            return change_key
        try:
            return f"{change_key}|pose_image:{_pose_image_digest(pose_image)}"
        except Exception:
            return f"{change_key}|pose_image:{id(pose_image)}"

    def _wait_for_frontend_sync(
        self,
        unique_id,
        start_time,
        timeout=15.0,
        sync_token=None,
    ):
        import time
        import folder_paths

        temp_dir = folder_paths.get_temp_directory()
        token_suffix = f"_{sync_token}" if sync_token else ""
        file_id = re.sub(r"[^A-Za-z0-9_-]+", "_", f"{unique_id}{token_suffix}").strip("_")[:128]
        filepath = os.path.join(temp_dir, f"vnccs_debug_{file_id}.json")

        while time.time() - start_time < timeout:
            if os.path.exists(filepath) and os.path.getmtime(filepath) > start_time - 1.0:
                try:
                    with open(filepath, "r", encoding="utf-8") as f:
                        sync_data = json.load(f)
                    try:
                        os.remove(filepath)
                    except Exception:
                        pass
                    return sync_data
                except Exception:
                    pass
            time.sleep(0.1)
        return None

    def _apply_pose_image_via_frontend(
        self,
        pose_image,
        unique_id,
        apply_mode="pose",
    ):
        if pose_image is None:
            return None
        if not unique_id:
            raise RuntimeError("Pose image analysis requires an active browser widget.")

        try:
            from server import PromptServer
            import time
            try:
                from ..vnccs_sam3d import process_image_to_pose_json, progress
            except ModuleNotFoundError as import_error:
                if not str(import_error.name or "").endswith("vnccs_sam3d"):
                    raise
                sam3d_package = _load_bundled_sam3d()
                process_image_to_pose_json = sam3d_package.process_image_to_pose_json
                progress = importlib.import_module(f"{sam3d_package.__name__}.progress")

            task_id = f"node-{unique_id}-pose-image"
            progress.start_task(task_id)
            with progress.task_context(task_id):
                image_key = _pose_image_digest(pose_image[:1])
                with _SAM_POSE_RESULT_CACHE_LOCK:
                    pose_json = _SAM_POSE_RESULT_CACHE.get(image_key)
                    if pose_json is not None:
                        _SAM_POSE_RESULT_CACHE.move_to_end(image_key)
                if pose_json is not None:
                    progress.update("Reusing pose analysis for this unchanged image...", 100, status="complete")
                else:
                    progress.update("Step 1/6: Pose image input received. Preparing SAM 3D Body import...", 2)
                    pose_json = process_image_to_pose_json(pose_image[:1])
                    if isinstance(pose_json, str) and pose_json:
                        with _SAM_POSE_RESULT_CACHE_LOCK:
                            _SAM_POSE_RESULT_CACHE[image_key] = pose_json
                            _SAM_POSE_RESULT_CACHE.move_to_end(image_key)
                            while len(_SAM_POSE_RESULT_CACHE) > _SAM_POSE_RESULT_CACHE_LIMIT:
                                _SAM_POSE_RESULT_CACHE.popitem(last=False)
            try:
                pose_payload = json.loads(pose_json)
            except Exception:
                pose_payload = None
            if not pose_payload:
                raise RuntimeError("SAM import returned empty pose data.")

            sync_token = uuid.uuid4().hex
            start_time = time.time()
            event_payload = {
                "node_id": unique_id,
                "pose_data": pose_payload,
                "source_resolution": {
                    "width": int(pose_image.shape[2]),
                    "height": int(pose_image.shape[1]),
                } if getattr(pose_image, "ndim", 0) == 4 else None,
                "apply_mode": apply_mode,
                "sync_token": sync_token,
            }
            PromptServer.instance.send_sync("vnccs_apply_sam3d_pose", event_payload)
            synced = self._wait_for_frontend_sync(
                unique_id,
                start_time,
                # Leave enough time for model and capture setup, plus upload.
                timeout=150.0,
                sync_token=sync_token,
            )
            if synced:
                if isinstance(synced, dict) and synced.get("sync_error"):
                    return synced
                print("[VNCCS Pose Studio] Applied pose_image SAM pose through frontend sync.")
                return synced
            raise RuntimeError("Pose image frontend sync timed out.")
        except Exception as e:
            raise RuntimeError(f"Pose image SAM import failed: {e}") from e
    
    def generate(
        self,
        pose_data: str = "{}",
        pose_image=None,
        unique_id: str = None
    ):
        """Generate rendered mesh images for all poses."""
        
        # Parse pose data
        try:
            data = json.loads(pose_data) if pose_data else {}
            use_edited_pose = isinstance(data, dict) and data.pop("_vnccs_use_edited_pose", False) is True
            open_editor_after_import = isinstance(data, dict) and data.pop("_vnccs_open_editor_after_import", False) is True
            if isinstance(data, dict):
                data.pop("_vnccs_request_id", None)
            pose_image_synced = False
            if pose_image is not None and not use_edited_pose:
                synced = self._apply_pose_image_via_frontend(
                    pose_image,
                    unique_id,
                    "pose_and_open_editor" if open_editor_after_import else "pose",
                )
                if isinstance(synced, dict):
                    if synced.get("sync_error"):
                        raise RuntimeError(f"Pose Studio frontend sync failed: {synced['sync_error']}")
                    data = synced
                    pose_image_synced = True
            
            # --- LIVE SYNC with Frontend ---
            # Request a fresh capture/sync from the frontend on every run.
            if unique_id and not pose_image_synced:
                sync_error_message = None
                try:
                    from server import PromptServer
                    import time
                    sync_token = uuid.uuid4().hex
                    start_time = time.time()
                    PromptServer.instance.send_sync("vnccs_req_pose_sync", {
                        "node_id": unique_id,
                        "sync_token": sync_token,
                    })
                    # Frontend scene readiness allows 120 seconds before capture.
                    sync_timeout = 150.0
                    synced = self._wait_for_frontend_sync(
                        unique_id,
                        start_time,
                        timeout=sync_timeout,
                        sync_token=sync_token,
                    )
                    if synced:
                        if isinstance(synced, dict) and synced.get("sync_error"):
                            sync_error_message = str(synced["sync_error"])
                        else:
                            data = synced
                    else:
                        sync_error_message = "Live capture timed out; old captures cannot be used."
                except Exception as e:
                    sync_error_message = str(e)
                if sync_error_message:
                    raise RuntimeError(f"Pose Studio frontend sync failed: {sync_error_message}")
            # ---------------------------------------------
            
        except (json.JSONDecodeError, TypeError):
            data = {}

        # Fallback: if live sync produced no captured_images, try LRU cache
        if isinstance(data, dict) and not data.get("captured_images"):
            capture_id = data.get("capture_id")
            if capture_id:
                try:
                    from .posestudio.caches import vnccs_get_capture_cache
                    cached = vnccs_get_capture_cache(capture_id)
                    if cached:
                        data["captured_images"] = cached.get("captured_images", [])
                        print(f"[VNCCS Pose Studio] Loaded {len(data['captured_images'])} captures from LRU cache (id={capture_id})")
                except Exception as e:
                    print(f"[VNCCS Pose Studio] Cache fallback failed: {e}")

        if not isinstance(data, dict):
            print(f"Pose Studio Error: pose_data is not a dict, got {type(data)}. Using default.")
            data = {}
        
        export = data.get("export", {})
        view_width = _positive_int(export.get("view_width", export.get("view_size", 512)), "view_width", 512)
        view_height = _positive_int(export.get("view_height", export.get("view_size", 512)), "view_height", 512)
        if view_width * view_height > _POSE_OUTPUT_MAX_PIXELS:
            raise ValueError("Pose Studio output dimensions are too large")
        self.OUTPUT_IS_LIST = (True,)
            
        # === 1. Try Client-Side Rendered Images (CSR) ===
        # If frontend sent captured images, use them directly.
        captured_images = data.get("captured_images", [])
        
        if captured_images:
            rendered_images = _decode_pose_images(captured_images, (view_width, view_height))
            
            if rendered_images:
                # Convert to tensors
                tensors = []
                for img in rendered_images:
                    np_img = np.array(img).astype(np.float32) / 255.0
                    tensors.append(torch.from_numpy(np_img))

                tensor_list = [tensor.unsqueeze(0) for tensor in tensors]
                # Send the first white-model render to ComfyUI's node preview as
                # well as preserving the existing IMAGE output connection.
                import folder_paths
                try:
                    active_index = max(0, min(len(rendered_images) - 1, int(data.get("activeTab", 0))))
                except (TypeError, ValueError):
                    active_index = 0
                preview_name = f"vnccs_pose_preview_{uuid.uuid4().hex}.png"
                preview_path = os.path.join(folder_paths.get_temp_directory(), preview_name)
                rendered_images[active_index].save(preview_path, format="PNG")
                return {
                    "ui": {"images": [{"filename": preview_name, "subfolder": "", "type": "temp"}]},
                    "result": (tensor_list,),
                }

        raise RuntimeError(
            "Pose Studio did not receive images rendered by the browser widget. "
            "Backend 3D rendering has been removed; keep the ComfyUI browser tab open "
            "and ensure WebGL is available while the workflow executes."
        )
    
# Node mappings
NODE_CLASS_MAPPINGS = {
    "VNCCS_PoseStudio": VNCCS_PoseStudio
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VNCCS_PoseStudio": "VNCCS Pose Studio"
}

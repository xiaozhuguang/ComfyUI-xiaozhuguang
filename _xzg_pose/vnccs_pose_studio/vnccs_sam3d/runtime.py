"""Release models owned by the bundled pose recognition runtime."""

import gc
import sys

from ..nodes.shared.model_operation_lock import MODEL_OPERATION_LOCK


def unload_recognition_models(*, wait=False):
    # Never release a model while an image or overlay job is using it.
    if not MODEL_OPERATION_LOCK.acquire(blocking=bool(wait)):
        raise RuntimeError("姿势识别正在运行，请完成后再卸载显存。")
    try:
        process = sys.modules.get(f"{__package__}.processing.process")
        mask = sys.modules.get(f"{__package__}.processing.birefnet_mask")
        torch = sys.modules.get("torch")
        cuda = torch.cuda if torch is not None and torch.cuda.is_available() else None
        if cuda:
            cuda.synchronize()
        before_allocated = cuda.memory_allocated() if cuda else 0
        before_reserved = cuda.memory_reserved() if cuda else 0
        unloaded = 0
        if process is not None:
            cache = getattr(process, "_MODEL_CACHE", {})
            unloaded += len(cache)
            cache.clear()
            face_cache = getattr(process, "_FACE_BS_CACHE", {})
            for key in face_cache:
                face_cache[key] = {} if key in ("region_ids", "region_deltas") else None
        if mask is not None:
            model_lock = getattr(mask, "_MODEL_LOCK", None)
            if model_lock is not None:
                model_lock.acquire()
            try:
                unloaded += int(getattr(mask, "_MODEL", None) is not None)
                mask._MODEL = None
                mask._DEVICE = None
            finally:
                if model_lock is not None:
                    model_lock.release()
        gc.collect()
        if cuda:
            cuda.empty_cache()
            try:
                cuda.ipc_collect()
            except Exception:
                pass
            cuda.synchronize()
        after_allocated = cuda.memory_allocated() if cuda else 0
        after_reserved = cuda.memory_reserved() if cuda else 0
        return {
            "status": "success",
            "unloaded_models": unloaded,
            "released_allocated_mib": round(max(0, before_allocated - after_allocated) / (1024 * 1024), 1),
            "released_reserved_mib": round(max(0, before_reserved - after_reserved) / (1024 * 1024), 1),
            "allocated_after_mib": round(after_allocated / (1024 * 1024), 1),
        }
    finally:
        MODEL_OPERATION_LOCK.release()

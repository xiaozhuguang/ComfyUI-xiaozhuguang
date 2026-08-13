import gc
import logging
import threading
from typing import Any

import torch

logger = logging.getLogger("LongCatAudioDiT")

_cache_lock = threading.Lock()
_cached_model: Any = None
_cached_tokenizer: Any = None
_cached_key: tuple = ()
# 模型卸载模式（三态）：
#   "full_unload": 完全卸载（del + empty_cache + gc），显存彻底释放
#   "offload_cpu": offload 到 CPU（保留权重，下次推理 resume 回 GPU，平衡显存与速度）
#   "keep_gpu":    完全保持 GPU（永不离开 GPU，占显存换最快连续推理速度）
_unload_mode: str = "offload_cpu"
_offloaded: bool = False

cancel_event: threading.Event = threading.Event()

# 生成进行中标志：防止 soft_empty_cache 在生成期间卸载或 offload 模型
_generating: bool = False


def get_cache_key(
    model_path: str, device: str, precision: str, attention: str,
    tokenizer_name: str = "auto",
) -> tuple:
    return (model_path, device, precision, attention, tokenizer_name)


def get_cached_model():
    return _cached_model, _cached_tokenizer, _cached_key


def set_cached_model(model: Any, tokenizer: Any, key: tuple, unload_mode: str = "offload_cpu"):
    global _cached_model, _cached_tokenizer, _cached_key, _unload_mode, _offloaded
    with _cache_lock:
        _cached_model = model
        _cached_tokenizer = tokenizer
        _cached_key = key
        _unload_mode = unload_mode
        _offloaded = False


def set_unload_mode(unload_mode: str):
    """设置模型卸载模式。用于 _get_model 在加载/复用模型时临时保护模型不被误卸载。"""
    global _unload_mode
    with _cache_lock:
        _unload_mode = unload_mode


def set_generating(generating: bool):
    """设置生成进行中标志。生成期间 soft_empty_cache 不会卸载/offload 模型。"""
    global _generating
    with _cache_lock:
        _generating = generating


def is_offloaded() -> bool:
    with _cache_lock:
        return _offloaded


def offload_model_to_cpu() -> None:
    global _offloaded
    with _cache_lock:
        if _cached_model is None:
            return
        if _offloaded:
            return

        # 原逻辑：检测到 ComfyUI VBAR/aimdo 时跳过手动 offload，交给 ComfyUI 自动管理。
        # 实际问题：aimdo 只管 ComfyUI 内置 model_management 注册的模型，不管 AudioDiT
        # 这种外部缓存模型，结果显存始终不释放。改为统一走实际 CPU offload。
        try:
            _cached_model.to("cpu")
            _offloaded = True
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            gc.collect()
            mode = []
            if getattr(_cached_model, "_vbar_active", False):
                mode.append("VBAR")
            if getattr(_cached_model, "_aimdo_auto", False):
                mode.append("aimdo")
            mode_str = f" ({'+'.join(mode)} active, but aimdo does not manage AudioDiT)" if mode else ""
            logger.info(f"Model offloaded to CPU. VRAM freed.{mode_str}")
        except Exception as e:
            logger.warning(f"Failed to offload model: {e}")


def resume_model_to_cuda(device: str = "cuda") -> None:
    global _offloaded
    with _cache_lock:
        if _cached_model is None:
            return
        if not _offloaded:
            return
        try:
            _cached_model.to(device)
            _offloaded = False
            logger.info(f"Model resumed to {device}.")
        except Exception as e:
            logger.warning(f"Failed to resume model: {e}")


def unload_model():
    global _cached_model, _cached_tokenizer, _cached_key, _unload_mode, _offloaded
    with _cache_lock:
        if _cached_model is not None:
            logger.info("Unloading LongCat-AudioDiT model from memory...")
            # Move to CPU first so CUDA tensors are freed before deletion
            try:
                _cached_model.to("cpu")
            except Exception:
                pass
            del _cached_model
            del _cached_tokenizer
            _cached_model = None
            _cached_tokenizer = None
            _cached_key = ()
            _unload_mode = "full_unload"
            _offloaded = False
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
                torch.cuda.synchronize()
            gc.collect()
            logger.info("Model unloaded and VRAM freed.")


def _detect_vbar():
    """Detect if ComfyUI's dynamic VRAM management (VBAR/aimdo) is available.

    Returns:
        tuple: (vbar_available, aimdo_available)
            - vbar_available: True if ModelVBAR class can be imported (explicit VBAR mode)
            - aimdo_available: True if comfy_aimdo package is installed (auto memory management)
    """
    try:
        import comfy_aimdo
        from comfy_aimdo.model_vbar import ModelVBAR

        return True, True
    except ImportError:
        pass
    try:
        import comfy_aimdo

        return False, True
    except ImportError:
        pass
    return False, False


def _hook_comfy_model_management():
    try:
        import comfy.model_management as mm

        _original = mm.soft_empty_cache

        def _patched_soft_empty_cache(*args, **kwargs):
            # 生成进行中：完全跳过，防止误卸载/offload 模型
            if _generating:
                return _original(*args, **kwargs)
            if _cached_model is None:
                return _original(*args, **kwargs)
            # 三种卸载模式：
            #   keep_gpu:    不动，模型完全保持在 GPU
            #   offload_cpu: offload 到 CPU（若已 offloaded 则 skip）
            #   full_unload: 完全卸载
            if _unload_mode == "keep_gpu":
                pass
            elif _unload_mode == "offload_cpu":
                offload_model_to_cpu()
            else:  # full_unload 或未知值
                unload_model()
            return _original(*args, **kwargs)

        mm.soft_empty_cache = _patched_soft_empty_cache
        logger.debug(
            "Hooked comfy.model_management.soft_empty_cache for LongCat-AudioDiT unload."
        )
    except Exception:
        pass


_hook_comfy_model_management()

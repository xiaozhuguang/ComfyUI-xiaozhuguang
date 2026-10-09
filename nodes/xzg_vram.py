"""Global VRAM preparation, executed on the prompt worker before node execution."""
import functools
import gc
import math
import threading
import time
from aiohttp import web
from server import PromptServer
from comfy import model_management as mm
import execution

_lock = threading.RLock()
_defaults = dict(enabled=False, reserved=0.6, clean_gpu_before=False, clean_gpu_after=False)
_default_reserved = getattr(mm, "EXTRA_RESERVED_VRAM", 0)
_changed_reserved = False
_state = dict(stage="idle", message="", updated_at=0, actual_gb=None)

def validate(data):
    result = dict(_defaults)
    for key in ("enabled", "clean_gpu_before", "clean_gpu_after"):
        if key in data:
            if not isinstance(data[key], bool):
                raise ValueError("开关必须为布尔值")
            result[key] = data[key]
    for key, minimum in (("reserved", -2),):
        if key in data:
            value = float(data[key])
            if not math.isfinite(value) or value < minimum:
                raise ValueError("预留参数超出范围")
            result[key] = value
    return result

def snapshot():
    with _lock:
        result = dict(**_state)
        result["actual_gb"] = getattr(mm, "EXTRA_RESERVED_VRAM", 0) / 1024**3
        return result

def report(stage, message, **values):
    with _lock:
        _state.update(stage=stage, message=message, updated_at=time.time(), **values)
    PromptServer.instance.send_sync("xzg_vram_state", snapshot())

@PromptServer.instance.routes.get("/xzg/vram_settings")
async def get_settings(request):
    return web.json_response(snapshot())

def prepare(prompt_id, config):
    try:
        if config["clean_gpu_before"]:
            report("cleaning", "正在卸载模型并清理显存…", prompt_id=prompt_id)
            gc.collect()
            mm.unload_all_models()
            mm.soft_empty_cache()
        if not config["enabled"]:
            report("cleaned" if config["clean_gpu_before"] else "idle",
                   "运行前已清理显存和模型" if config["clean_gpu_before"] else "",
                   prompt_id=prompt_id)
            return
        if config["clean_gpu_before"]:
            report("cleaned", "运行前已清理显存和模型", prompt_id=prompt_id)
        report("setting", "正在设置显存预留…", prompt_id=prompt_id)
        value = config["reserved"]
        fallback = False
        try:
            import torch
            free, total = torch.cuda.mem_get_info(mm.get_torch_device())
            value += (total - free) / 1024**3
            if value >= total / 1024**3:
                raise ValueError("预留量不能达到或超过显卡总容量")
        except ValueError:
            raise
        except Exception:
            fallback = True
            value = config["reserved"]
        value = max(0.0, value)
        setter = getattr(mm, "set_extra_reserved_vram", None)
        if setter:
            setter(value)
        else:
            mm.EXTRA_RESERVED_VRAM = int(value * 1024**3)
        global _changed_reserved
        _changed_reserved = True
        actual = mm.EXTRA_RESERVED_VRAM
        try:
            import comfy.memory_management as memory
            if getattr(memory, "aimdo_enabled", False):
                import comfy_aimdo.control as control
                headroom = getattr(getattr(control, "lib", None), "set_simple_vram_headroom", None)
                if headroom:
                    headroom(int(actual))
        except Exception as error:
            report("error", f"预留已设置，DynamicVRAM 同步失败：{error}", actual_gb=actual / 1024**3)
            return
        report("ready", f"预留已设为 {actual / 1024**3:.2f} GB" + ("（检测失败，使用额外预留值）" if fallback else ""), actual_gb=actual / 1024**3)
    except Exception as error:
        report("error", f"显存准备失败：{error}")

if not getattr(execution.PromptExecutor.execute_async, "_xzg_vram_hook", False):
    _original = execution.PromptExecutor.execute_async

    @functools.wraps(_original)
    async def execute_with_vram(self, prompt, prompt_id, *args, **kwargs):
        extra_data = args[0] if args else kwargs.get("extra_data", {})
        try:
            workflow = (extra_data or {}).get("extra_pnginfo", {}).get("workflow", {})
            raw_config = workflow.get("extra", {}).get("xzg_vram_settings", {})
            config = validate(raw_config if isinstance(raw_config, dict) else {})
        except (ValueError, TypeError, AttributeError):
            config = dict(_defaults)
        global _changed_reserved
        if _changed_reserved:
            mm.EXTRA_RESERVED_VRAM = _default_reserved
            setter = getattr(mm, "set_extra_reserved_vram", None)
            if setter:
                setter(_default_reserved / 1024**3)
            try:
                import comfy.memory_management as memory
                if getattr(memory, "aimdo_enabled", False):
                    import comfy_aimdo.control as control
                    headroom = getattr(getattr(control, "lib", None), "set_simple_vram_headroom", None)
                    if headroom:
                        headroom(int(mm.EXTRA_RESERVED_VRAM))
            except Exception as error:
                report("error", f"恢复默认预留失败：{error}", prompt_id=prompt_id)
            _changed_reserved = False
        clean_after = config["clean_gpu_after"]
        prepare(prompt_id, config)
        if snapshot()["stage"] != "error":
            start_parts = []
            if config["enabled"]:
                start_parts.append(f"预留 {snapshot()['actual_gb']:.2f} GB")
            if config["clean_gpu_before"]:
                start_parts.append("运行前已清理显存和模型")
            if start_parts:
                report("start_done", " · ".join(start_parts), prompt_id=prompt_id)
        try:
            return await _original(self, prompt, prompt_id, *args, **kwargs)
        finally:
            end_parts = []
            if clean_after:
                try:
                    report("cleaning_after", "运行后正在卸载模型并清理显存…", prompt_id=prompt_id)
                    mm.unload_all_models()
                    gc.collect()
                    mm.soft_empty_cache()
                    report("cleaned", "运行后已清理显存和模型", prompt_id=prompt_id)
                    end_parts.append("已清理显存和模型")
                except Exception as error:
                    report("error", f"运行后清理失败：{error}", prompt_id=prompt_id)
            if end_parts:
                report("end_done", " · ".join(end_parts), prompt_id=prompt_id)

    execute_with_vram._xzg_vram_hook = True
    execution.PromptExecutor.execute_async = execute_with_vram

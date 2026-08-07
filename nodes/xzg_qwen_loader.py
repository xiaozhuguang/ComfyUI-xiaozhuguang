"""
小珠光 Qwen Model Loader
加载本地 GGUF LLM 模型，供小珠光 Minimax-H3 提示词节点使用。
输出 BSAI_QWEN_MODEL 类型，与 BSAI 插件兼容。
"""

# ---------------------------------------------------------------------------
# DLL bootstrap: two layers of defence on Win10+/Python 3.8+:
#   1. os.add_dll_directory() — official per-process DLL search path
#      (bypasses PATH ordering and "SafeDllSearchMode" quirks)
#   2. PATH prepend — fallback for LoadLibrary("basename.dll") callers that
#      don't use AddDllDirectory (older extensions / ctypes CDLL).
# llama-cpp-python ships ggml.dll / llama.dll under site-packages/llama_cpp/{bin,lib}
# and they often can't resolve their own transitive deps (c10 / CUDA cudart /
# VC++ CRT / libiomp5md) from the default ComfyUI launcher PATH. Register all
# likely dirs before `import llama_cpp` so the loader can resolve them.
# ---------------------------------------------------------------------------
import os as _xzg_os
import sys as _xzg_sys
def _xzg_add_dll_dir(p: str) -> None:
    if not isinstance(p, str) or not p or not _xzg_os.path.isdir(p):
        return
    p = _xzg_os.path.abspath(p)
    # Layer 1: official Win10+ DLL search directory
    try:
        add_dll_dir = getattr(_xzg_os, "add_dll_directory", None)
        if callable(add_dll_dir):
            try:
                add_dll_dir(p)
            except (FileNotFoundError, OSError):
                pass
    except Exception:
        pass
    # Layer 2: PATH prepend (legacy fallback)
    cur = _xzg_os.environ.get("PATH", "")
    entries = cur.split(_xzg_os.pathsep) if cur else []
    if p not in entries:
        _xzg_os.environ["PATH"] = p + (_xzg_os.pathsep + cur if cur else "")

# 1) torch/lib (c10.dll, torch_cuda.dll, libiomp5md.dll)
try:
    import torch as _xzg_torch
    _xzg_add_dll_dir(_xzg_os.path.join(_xzg_os.path.dirname(_xzg_torch.__file__), "lib"))
except Exception:
    pass

# 2) CUDA Toolkit (ggml-cuda builds need cudart64 / nvrtc / npps at runtime)
#
# Discovery order (most specific → most generic, first hit wins):
#   1. Explicit CUDA_PATH env var (user / launcher override)
#   2. NVIDIA-installer specific env vars like CUDA_PATH_V13_3, CUDA_PATH_V12_6, etc.
#      (probes all combinations of major ∈ {11..14}, minor ∈ {0..9})
#   3. Default installer locations on ALL fixed drives (C: .. Z:), scanning
#      versions from newest to oldest. Many users install CUDA on D: or
#      another large-volume drive, so just checking C:\Program Files misses
#      those installations.
#
# If nothing is found we silently fall through: PyTorch wheels ship their own
# copies of cudart64 / cufft64 / nvrtc64 / cublas64 inside torch/lib (which
# was registered above), so inference-only usage (the typical ComfyUI case)
# does NOT require a full CUDA Toolkit install on the system.
def _xzg_probe_cuda_root():
    # --- 1. explicit CUDA_PATH ---
    env_cuda = _xzg_os.environ.get("CUDA_PATH", None)
    if env_cuda and _xzg_os.path.isdir(env_cuda):
        return env_cuda

    # --- 2. NVIDIA installer env vars: CUDA_PATH_V<MAJOR>_<MINOR> ---
    for major in (14, 13, 12, 11):
        for minor in range(9, -1, -1):
            key = f"CUDA_PATH_V{major}_{minor}"
            p = _xzg_os.environ.get(key, None)
            if p and _xzg_os.path.isdir(p):
                return p

    # --- 3. default install dirs on every fixed drive ---
    drives = []
    try:
        import string as _xzg_str
        import ctypes as _xzg_ct
        DRIVE_FIXED = 3
        bitmask = _xzg_ct.windll.kernel32.GetLogicalDrives()
        for i, letter in enumerate(_xzg_str.ascii_uppercase):
            if bitmask & (1 << i):
                root = f"{letter}:\\"
                try:
                    if _xzg_ct.windll.kernel32.GetDriveTypeW(root) == DRIVE_FIXED:
                        drives.append(f"{letter}:")
                except Exception:
                    # Fallback: assume it exists if we got here
                    drives.append(f"{letter}:")
    except Exception:
        # If Win32 probe fails for any reason, try the common suspects anyway
        drives = ["C:", "D:", "E:", "F:", "G:"]

    versions_newest_first = (
        # CUDA 14 (future)
        "v14.3", "v14.2", "v14.1", "v14.0",
        # CUDA 13 (current PyTorch cu130 matches this line)
        "v13.4", "v13.3", "v13.2", "v13.1", "v13.0",
        # CUDA 12.x (widely deployed, PyTorch cu121/cu124/cu126 targets)
        "v12.8", "v12.7", "v12.6", "v12.5", "v12.4", "v12.3", "v12.2", "v12.1", "v12.0",
        # CUDA 11.x (legacy, still common on older builds / server GPUs)
        "v11.8", "v11.7", "v11.6", "v11.5", "v11.4", "v11.3", "v11.2", "v11.1", "v11.0",
    )

    for drive in drives:
        base = _xzg_os.path.join(drive + _xzg_os.sep if drive.endswith(":") else drive,
                                 "Program Files", "NVIDIA GPU Computing Toolkit", "CUDA")
        try:
            if not _xzg_os.path.isdir(base):
                continue
            for ver in versions_newest_first:
                p = _xzg_os.path.join(base, ver)
                if _xzg_os.path.isdir(p):
                    return p
        except Exception:
            continue
    return None

_cuda_root = _xzg_probe_cuda_root()
del _xzg_probe_cuda_root
if _cuda_root and _xzg_os.path.isdir(_cuda_root):
    # NOTE: CUDA 13.x moved 64-bit runtime DLLs (cudart64_13.dll, cufft64_12.dll,
    # nvrtc64_130_0.dll, ...) to bin/x64. Older CUDA 12.x keep them in bin. Add both.
    for _sub in (
        _xzg_os.path.join("bin", "x64"),
        "bin",
        "libnvvp",
        _xzg_os.path.join("extras", "CUPTI", "lib64"),
        _xzg_os.path.join("lib", "x64"),
    ):
        _xzg_add_dll_dir(_xzg_os.path.join(_cuda_root, _sub))

# 3) llama-cpp-python's own DLL directories (ggml.dll / llama.dll live here)
_sp = None
for _p in getattr(_xzg_sys, "path", []):
    if _p and _xzg_os.path.isdir(_p) and _xzg_os.path.basename(_p.rstrip("\\/")).lower() == "site-packages":
        _sp = _p
        break
if _sp is None:
    _sp = _xzg_os.path.join(_xzg_sys.base_prefix, "Lib", "site-packages")
try:
    import llama_cpp as _xzg_llama_pkg
    _llama_base = _xzg_os.path.dirname(_xzg_llama_pkg.__file__)
    _xzg_add_dll_dir(_xzg_os.path.join(_llama_base, "bin"))
    _xzg_add_dll_dir(_xzg_os.path.join(_llama_base, "lib"))
except Exception:
    for _cand in (
        _xzg_os.path.join(_sp, "llama_cpp", "bin"),
        _xzg_os.path.join(_sp, "llama_cpp", "lib"),
    ):
        _xzg_add_dll_dir(_cand)

# 4) Python base / DLLs (VC++ CRT / python312.dll)
_xzg_add_dll_dir(_xzg_os.path.join(_xzg_sys.base_prefix, "DLLs"))
_xzg_add_dll_dir(_xzg_sys.base_prefix)
del _xzg_add_dll_dir, _xzg_os, _xzg_sys

import os
import gc
import inspect

import folder_paths
import comfy.model_management as mm

try:
    from llama_cpp import Llama
except Exception as _xzg_llama_err:
    # Replace the silent None with a log entry that tells the user WHY it failed
    import logging as _xzg_log
    _xzg_log.warning(
        "[小珠光 QwenLoader] from llama_cpp import Llama failed with %s: %s. "
        "XiaozhuguangQwenModelLoader will raise '未安装' until this import succeeds. "
        "If you just installed llama-cpp-python, restart ComfyUI so the PATH bootstrap at "
        "the top of xzg_qwen_loader.py takes effect.",
        type(_xzg_llama_err).__name__, _xzg_llama_err,
    )
    del _xzg_log
    Llama = None

try:
    from llama_cpp.llama_chat_format import Qwen3VLChatHandler
except Exception:
    Qwen3VLChatHandler = None

try:
    from llama_cpp.llama_chat_format import Qwen35ChatHandler
except Exception:
    Qwen35ChatHandler = None

try:
    from llama_cpp.llama_chat_format import Gemma4ChatHandler
except Exception:
    Gemma4ChatHandler = None


# ============================================================
# 辅助函数
# ============================================================

def _xzg_list_llm_files():
    """列出 ComfyUI/models/LLM/ 下的模型文件。"""
    folder_name = "LLM"
    llm_dir = os.path.join(folder_paths.models_dir, folder_name)
    try:
        if folder_name not in folder_paths.folder_names_and_paths:
            folder_paths.folder_names_and_paths[folder_name] = (
                [llm_dir],
                {".gguf", ".safetensors", ".bin", ".pth", ".pt"},
            )
    except Exception:
        pass
    try:
        return folder_paths.get_filename_list("LLM")
    except Exception:
        return []


def _xzg_get_free_vram_bytes():
    """获取当前可用显存（字节）。返回 None 表示无法检测。"""
    try:
        import torch
        if torch.cuda.is_available():
            free, _total = torch.cuda.mem_get_info()
            return free
    except Exception:
        pass
    return None


def _xzg_auto_adjust_gpu_layers(model_path, mmproj_path, n_ctx, n_gpu_layers):
    """根据可用显存自动调整 GPU 层数，防止 OOM 导致段错误。"""
    if n_gpu_layers != -1:
        return n_gpu_layers, None

    free_vram = _xzg_get_free_vram_bytes()
    if free_vram is None:
        return n_gpu_layers, None

    model_size = os.path.getsize(model_path) if os.path.exists(model_path) else 0
    mmproj_size = os.path.getsize(mmproj_path) if mmproj_path and os.path.exists(mmproj_path) else 0

    kv_cache_estimate = int(n_ctx * (model_size + mmproj_size) * 1.3e-5)
    safety_margin = 1 * 1024 ** 3
    total_needed = model_size + mmproj_size + kv_cache_estimate + safety_margin

    free_vram_gb = free_vram / 1024 ** 3
    model_gb = model_size / 1024 ** 3
    mmproj_gb = mmproj_size / 1024 ** 3
    kv_gb = kv_cache_estimate / 1024 ** 3
    print(
        f"[小珠光 ModelLoader] VRAM 检测: "
        f"可用={free_vram_gb:.1f}GB, "
        f"模型={model_gb:.1f}GB, mmproj={mmproj_gb:.2f}GB, "
        f"KV缓存≈{kv_gb:.2f}GB, 合计≈{total_needed / 1024**3:.1f}GB"
    )

    if total_needed <= free_vram:
        return n_gpu_layers, None

    available_for_model = free_vram - safety_margin - mmproj_size - kv_cache_estimate
    if available_for_model <= 0:
        return 0, (
            f"显存严重不足！可用 VRAM={free_vram_gb:.1f}GB，"
            f"模型需要约={total_needed / 1024**3:.1f}GB。\n"
            f"已将 GPU 层数设为 0（纯 CPU 推理），速度会很慢。"
        )

    ratio = available_for_model / model_size if model_size > 0 else 0
    est_layers_per_gb = 64 / 21.8
    est_total_layers = max(1, int(model_size / (1024**3) * est_layers_per_gb))
    adjusted_layers = max(1, int(est_total_layers * ratio))

    return adjusted_layers, (
        f"显存不足，无法全部加载到 GPU！\n"
        f"  可用 VRAM: {free_vram_gb:.1f}GB\n"
        f"  模型大小: {model_gb:.1f}GB + mmproj: {mmproj_gb:.2f}GB\n"
        f"  GPU层数从 -1（全部）自动调整为 {adjusted_layers}（部分 offload 到 CPU）"
    )


def _xzg_is_model_valid(llm):
    """检测 llama 模型对象是否仍然有效（未被关闭）。"""
    if llm is None:
        return False
    try:
        ctx = getattr(llm, "_ctx", None)
        if ctx is None:
            return False
        n_ctx_raw = getattr(llm, "n_ctx", None)
        if n_ctx_raw is None:
            return False
        if callable(n_ctx_raw):
            if n_ctx_raw() is None or n_ctx_raw() == 0:
                return False
        return True
    except Exception:
        return False


# ============================================================
# 模型存储（独立于 BSAI）
# ============================================================

class _XZG_QwenStorage:
    model = None
    settings = None
    # 标记当前存储中的模型是否已被主动卸载（区别于"尚未加载"）
    unloaded = False

    @classmethod
    def unload(cls):
        try:
            if cls.model and hasattr(cls.model, "close"):
                cls.model.close()
        except Exception:
            pass
        # 显式清除底层上下文属性，确保 _xzg_is_model_valid 对已关闭对象返回 False
        # （llama_cpp 某些版本的 close() 不会清空 _ctx，导致误判为有效）
        if cls.model is not None:
            for attr in ("_ctx", "_model", "_chat_handler", "ctx", "model"):
                try:
                    setattr(cls.model, attr, None)
                except Exception:
                    pass
        cls.model = None
        cls.unloaded = True
        gc.collect()
        mm.soft_empty_cache()

    @classmethod
    def load(cls, config):
        if Llama is None:
            raise RuntimeError(
                "llama-cpp-python (llama_cpp) 未安装。请安装：pip install llama-cpp-python"
            )

        if cls.model is not None and cls.settings == config:
            if _xzg_is_model_valid(cls.model):
                return cls.model
            cls.model = None

        if cls.model is not None:
            cls.unload()

        model_path = os.path.join(folder_paths.models_dir, "LLM", config["model"])
        if not os.path.exists(model_path):
            raise FileNotFoundError(f"模型文件未找到: {model_path}")

        mmproj = config.get("mmproj", "None")
        mmproj_path = None
        if mmproj and mmproj not in ("None", "无", ""):
            mmproj_path = os.path.join(folder_paths.models_dir, "LLM", mmproj)
            if not os.path.exists(mmproj_path):
                raise FileNotFoundError(f"mmproj 文件未找到: {mmproj_path}")

        family = config["family"]
        think = config.get("think", False)
        n_ctx = int(config.get("n_ctx", 8192))
        n_gpu_layers = int(config.get("n_gpu_layers", -1))

        # VRAM 预检测
        n_gpu_layers, vram_warning = _xzg_auto_adjust_gpu_layers(
            model_path, mmproj_path, n_ctx, n_gpu_layers
        )
        if vram_warning:
            print(f"[小珠光 ModelLoader] {vram_warning}")

        chat_handler = None
        if mmproj_path:
            if family in ("Qwen3.5-VL", "Qwen3.6-VL"):
                if Qwen35ChatHandler is None:
                    raise RuntimeError(
                        "当前 llama-cpp-python 不支持 Qwen35ChatHandler，请更新 llama-cpp-python。"
                    )
                try:
                    chat_handler = Qwen35ChatHandler(
                        clip_model_path=mmproj_path, enable_thinking=think, verbose=False
                    )
                except Exception:
                    chat_handler = Qwen35ChatHandler(clip_model_path=mmproj_path, verbose=False)
            elif family == "Qwen3-VL":
                if Qwen3VLChatHandler is None:
                    raise RuntimeError(
                        "当前 llama-cpp-python 不支持 Qwen3VLChatHandler，请更新 llama-cpp-python。"
                    )
                try:
                    chat_handler = Qwen3VLChatHandler(
                        clip_model_path=mmproj_path, force_reasoning=think, verbose=False
                    )
                except Exception:
                    chat_handler = Qwen3VLChatHandler(clip_model_path=mmproj_path, verbose=False)
            elif family == "Gemma4":
                if Gemma4ChatHandler is None:
                    raise RuntimeError(
                        "当前 llama-cpp-python 不支持 Gemma4ChatHandler，请更新 llama-cpp-python到0.3.36+。"
                    )
                try:
                    chat_handler = Gemma4ChatHandler(
                        clip_model_path=mmproj_path, enable_thinking=think, verbose=False
                    )
                except Exception:
                    chat_handler = Gemma4ChatHandler(clip_model_path=mmproj_path, verbose=False)

        llama_kwargs = {
            "model_path": model_path,
            "chat_handler": chat_handler,
            "n_ctx": n_ctx,
            "n_gpu_layers": n_gpu_layers,
            "verbose": False,
        }

        try:
            sig = inspect.signature(Llama.__init__)
            if "flash_attn" in sig.parameters:
                llama_kwargs["flash_attn"] = True
        except Exception:
            pass

        try:
            cls.model = Llama(**llama_kwargs)
            cls.settings = dict(config)
            cls.unloaded = False
            return cls.model
        except ValueError as e:
            if "Failed to create context with model" in str(e):
                raise RuntimeError(
                    "模型加载失败：Failed to create context with model\n"
                    "可能的原因：\n"
                    "1. 模型文件损坏或格式不兼容\n"
                    "2. llama-cpp-python 版本不支持该模型\n"
                    "3. 显存不足\n"
                    "4. 模型文件路径错误"
                )
            raise


# ============================================================
# 小珠光 Qwen Model Loader 节点
# ============================================================

class XiaozhuguangQwenModelLoader:
    """加载本地 GGUF LLM 模型，供小珠光 Minimax-H3 提示词节点使用。"""

    @classmethod
    def INPUT_TYPES(s):
        all_files = _xzg_list_llm_files()
        model_list = [
            f
            for f in all_files
            if "mmproj" not in f.lower()
            and os.path.splitext(f)[1].lower() in [".gguf", ".safetensors", ".bin", ".pth", ".pt"]
        ]
        mmproj_list = ["None"] + [
            f
            for f in all_files
            if "mmproj" in f.lower()
            and os.path.splitext(f)[1].lower() in [".gguf", ".safetensors", ".bin"]
        ]

        if not model_list:
            model_list = ["(将模型放入 models/LLM)"]

        return {
            "required": {
                "model_family": (
                    ["Qwen3-VL", "Qwen3.5-VL", "Qwen3.6-VL", "Gemma4"],
                    {"default": "Qwen3.6-VL", "tooltip": "模型系列 / Model family"},
                ),
                "model_file": (
                    model_list,
                    {"tooltip": "主模型文件 (.gguf) 放在 ComfyUI/models/LLM/"},
                ),
                "mmproj": (
                    mmproj_list,
                    {"default": "None", "tooltip": "多模态 mmproj 文件；纯文本选 None"},
                ),
                "context_length": (
                    "INT",
                    {"default": 16384, "min": 1024, "max": 327680, "step": 256,
                     "tooltip": "上下文长度，建议 16384+ / Context length"},
                ),
                "gpu_layers": (
                    "INT",
                    {"default": -1, "min": -1, "max": 9999, "step": 1,
                     "tooltip": "-1=全部上GPU，显存不足时自动降级"},
                ),
            },
            "hidden": {
                "enable_thinking": ("BOOLEAN", {"default": False}),
            }
        }

    RETURN_TYPES = ("BSAI_QWEN_MODEL",)
    RETURN_NAMES = ("qwen_model",)
    FUNCTION = "load"
    CATEGORY = "小珠光"

    def load(self, model_family, model_file, mmproj, context_length, gpu_layers, enable_thinking=False):
        if model_file.startswith("(将模型放入"):
            raise RuntimeError(
                "未找到模型文件。请将 .gguf 模型放入 ComfyUI/models/LLM/ 并重启。"
            )

        if model_family in ("Qwen3-VL", "Qwen3.5-VL", "Qwen3.6-VL", "Gemma4"):
            if mmproj == "None":
                raise RuntimeError(
                    f"{model_family} 是多模态模型，需要 mmproj 文件。\n"
                    "请在 'mmproj' 选项中选择对应的视觉投影文件。"
                )

        config = {
            "family": model_family,
            "model": model_file,
            "mmproj": mmproj,
            "think": bool(enable_thinking),
            "n_ctx": int(context_length),
            "n_gpu_layers": int(gpu_layers),
        }
        model = _XZG_QwenStorage.load(config)
        return (model,)
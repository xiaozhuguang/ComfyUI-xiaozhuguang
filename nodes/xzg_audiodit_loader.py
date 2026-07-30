"""
小珠光 AudioDiT 离线加载器 / Xiaozhuguang AudioDiT Offline Loader
----------------------------------
基于 LongCat-AudioDIT-TTS 原插件的建模库与推理流程复用，
但 100% 剥离「推理时自动从 HuggingFace 下载模型 / tokenizer」的行为：

  · 默认严格离线模式：模型缺失 → 清晰报错（应放置的本地路径 + 下载 URL）
  · 扫描本地模型时只列出「真实存在于磁盘」的目录（不再显示 "xxx (auto download)" 虚项）
  · 支持 ComfyUI/models/audiodit/ 多个子目录放模型
  · tokenizer 仅在本地查找（umt5-base-tokenizer 目录），缺失时直接提示手动放置

注：原插件的 audiodit/ 建模库与 loader/model_cache 工具已移植到本插件内部：
  - _xzg_audiodit/                  （原 audiodit/ 包，相对导入不变）
  - nodes/xzg_longcat_loader.py     （原 nodes/loader.py）
  - nodes/xzg_longcat_model_cache.py（原 nodes/model_cache.py）
本节点不再依赖外部插件 ComfyUI-LongCat-AudioDIT-TTS，可独立运行。
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

# —— 直接复用移植到本插件内部的 LongCat 工具（不再注入 sys.path） ——
from .xzg_longcat_loader import (
    _has_safetensors_metadata,
    _is_fp8_model,
    _load_model_direct,
    approx_duration_from_text,
    normalize_text,
    numpy_audio_to_comfy,
    patch_attention,
    resolve_device,
    resolve_precision,
)
from .xzg_longcat_model_cache import _detect_vbar

logger = logging.getLogger("XiaozhuguangAudioDiT")
if not logger.handlers:
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("[小珠光AudioDiT] %(message)s"))
    logger.addHandler(_h)
logger.setLevel(logging.INFO)
logger.propagate = False

# Suppress verbose transformers warnings about logits processors
logging.getLogger("transformers").setLevel(logging.ERROR)

# ---------------------------------------------------------------- #
#  模型目录（与原插件同用 folder_paths.models_dir / audiodit）
# ---------------------------------------------------------------- #
MODELS_FOLDER_NAME = "audiodit"
_LOCAL_TOKENIZER_DIRNAME = "umt5-base-tokenizer"

# 参考原插件 HF_MODELS 的目录名映射（用于缺失时给出下载提示）
_KNOWN_MODEL_HINTS: dict[str, dict[str, str]] = {
    "LongCat-AudioDiT-1B": {
        "repo_id": "meituan-longcat/LongCat-AudioDiT-1B",
        "desc": "1B params (FP32 ~6GB)",
    },
    "LongCat-AudioDiT-3.5B": {
        "repo_id": "meituan-longcat/LongCat-AudioDiT-3.5B",
        "desc": "3.5B params (FP32 ~14GB)",
    },
    "LongCat-AudioDiT-3.5B-bf16": {
        "repo_id": "drbaph/LongCat-AudioDiT-3.5B-bf16",
        "desc": "3.5B params (~7GB VRAM, bf16 quantized)",
    },
    "LongCat-AudioDiT-3.5B-fp8": {
        "repo_id": "drbaph/LongCat-AudioDiT-3.5B-fp8",
        "desc": "3.5B params (~4GB VRAM, fp8 quantized, dequantized to bf16 at load)",
    },
}
DEFAULT_KNOWN_NAME = "LongCat-AudioDiT-3.5B-bf16"
_KNOWN_TOKENIZER_REPO = "google/umt5-base"


def _get_models_base() -> Path:
    try:
        import folder_paths  # type: ignore

        base = Path(folder_paths.models_dir) / MODELS_FOLDER_NAME
    except ImportError:
        base = Path(__file__).resolve().parent.parent / "checkpoints"
    base.mkdir(parents=True, exist_ok=True)
    return base


def register_folder_xzg() -> None:
    try:
        import folder_paths  # type: ignore

        base = str(_get_models_base())
        folder_paths.add_model_folder_path(MODELS_FOLDER_NAME, base)
    except ImportError:
        pass


# ---------------------------------------------------------------- #
#  本地模型 / tokenizer 扫描（永不触网）
# ---------------------------------------------------------------- #
def _dir_has_model_files(entry: Path) -> bool:
    if not entry.is_dir():
        return False
    has_config = (entry / "config.json").is_file()
    has_weights = any(
        f.suffix in {".safetensors", ".pt", ".pth", ".ckpt", ".bin"}
        for f in entry.iterdir()
        if f.is_file()
    )
    return has_config or has_weights


def _dir_has_tokenizer_files(entry: Path) -> bool:
    if not entry.is_dir():
        return False
    # 常见 tokenizer 文件（至少要有 tokenizer_config.json + spiece.model 或 tokenizer.json）
    return (
        (entry / "tokenizer_config.json").is_file()
        and (
            (entry / "spiece.model").is_file()
            or (entry / "tokenizer.json").is_file()
            or (entry / "sentencepiece.bpe.model").is_file()
        )
    )


def scan_local_models() -> list[str]:
    """只列出 ComfyUI/models/audiodit/ 下真实存在的模型目录，不显示 (auto download) 虚项。"""
    base = _get_models_base()
    names: list[str] = []
    try:
        for entry in sorted(base.iterdir()):
            if entry.name == _LOCAL_TOKENIZER_DIRNAME:
                continue  # tokenizer 目录不作为模型列出
            if _dir_has_model_files(entry):
                names.append(entry.name)
    except OSError as e:
        logger.warning(f"扫描 {base} 失败: {e}")
    return names


def resolve_model_path_xzg(name: str) -> Path:
    """严格离线解析模型目录；不存在直接给出可操作的错误提示。"""
    if not name:
        raise FileNotFoundError("[小珠光AudioDiT] 未选择模型。")

    base = _get_models_base()
    candidate = base / name

    if candidate.is_dir() and _dir_has_model_files(candidate):
        return candidate

    # 构建清晰错误（包括本地路径 + 推荐 HF 下载地址）
    hint_lines = [
        f"[小珠光AudioDiT] 本地未找到模型目录: {candidate}",
        f"本节点采用「严格离线」模式，不会在推理时联网下载。",
        f"请手动下载到下面的目录后再使用：",
        f"  目标目录: {candidate}",
    ]
    if name in _KNOWN_MODEL_HINTS:
        hint_lines.append(f"  HuggingFace: https://huggingface.co/{_KNOWN_MODEL_HINTS[name]['repo_id']}")
        hint_lines.append(f"  说明: {_KNOWN_MODEL_HINTS[name]['desc']}")
    else:
        # 未知名字也放一条最常用的 3.5B-bf16 提示
        default_url = f"https://huggingface.co/{_KNOWN_MODEL_HINTS[DEFAULT_KNOWN_NAME]['repo_id']}"
        hint_lines.append(f"  推荐模型（bf16 量化，省显存）: {default_url}")
    raise FileNotFoundError("\n".join(hint_lines))


def _find_local_tokenizer(text_encoder_hint: str) -> Path:
    """只在本地找 tokenizer 目录；永远不调用 huggingface_hub。

    查找顺序（最先命中优先）：
      1) ComfyUI/models/audiodit/umt5-base-tokenizer/  （本插件推荐放置处）
      2) 同层级的 umt5-base / models--google--umt5-base 目录（用户可能直接把整个 HF 仓库拷过来）
      3) huggingface_hub 本地缓存（~/.cache/huggingface/hub/.../snapshots/...）
      4) HF_HOME / TRANSFORMERS_CACHE 环境变量指向的缓存
    """
    base = _get_models_base()
    candidates: list[Path] = []

    # 1) 本插件共享目录下的专用 tokenizer 子目录
    candidates.append(base / _LOCAL_TOKENIZER_DIRNAME)

    # 2) 同层级的 umt5-base / google--umt5-base 目录
    candidates.append(base / "umt5-base")
    candidates.append(base / "models--google--umt5-base")

    # 3) HF 缓存（models--google--umt5-base / snapshots / <hash> / ...）
    hf_home = Path(
        os.environ.get("HF_HOME")
        or os.environ.get("TRANSFORMERS_CACHE")
        or (Path.home() / ".cache" / "huggingface" / "hub")
    )
    repo_dir = hf_home / "models--google--umt5-base"
    if repo_dir.is_dir():
        snapshots = repo_dir / "snapshots"
        if snapshots.is_dir():
            # 最新一个 snapshot
            snaps = sorted(snapshots.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)
            for s in snaps:
                candidates.append(s)
        candidates.append(repo_dir)

    for p in candidates:
        if _dir_has_tokenizer_files(p):
            logger.info(f"使用本地 tokenizer: {p}")
            return p

    err_lines = [
        "[小珠光AudioDiT] 严格离线模式下未找到 UMT5 tokenizer。",
        "请手动下载以下 tokenizer 文件放入目录:",
        f"  {base / _LOCAL_TOKENIZER_DIRNAME}",
        f"HuggingFace 仓库: https://huggingface.co/{_KNOWN_TOKENIZER_REPO}",
        "至少包含: tokenizer_config.json + spiece.model（或 tokenizer.json）",
        "下载后路径示例:",
        f"  {base / _LOCAL_TOKENIZER_DIRNAME / 'tokenizer_config.json'}",
        f"  {base / _LOCAL_TOKENIZER_DIRNAME / 'spiece.model'}",
    ]
    raise FileNotFoundError("\n".join(err_lines))


# ---------------------------------------------------------------- #
#  模型加载（核心：完全离线；from_pretrained / fp8 反量化 / dtype 等
#  直接沿用移植到本插件内部的 LongCat 实现，保持兼容性）
# ---------------------------------------------------------------- #
def load_model_xzg(model_name: str, device: str, precision: str, attention: str):
    # 1) 严格离线找目录
    model_path = resolve_model_path_xzg(model_name)
    device_str, _ = resolve_device(device)
    dtype = resolve_precision(precision, device_str)

    # 2) 触发 transformers 注册（model_type="audiodit"），并取 AudioDiTModel
    from .._xzg_audiodit import AudioDiTModel  # noqa: F401
    from transformers import AutoTokenizer

    fp8 = _is_fp8_model(model_path)

    logger.info(f"加载 LongCat-AudioDiT 模型: {model_path}")
    if fp8:
        logger.info("检测到 FP8 量化模型 → 加载时将反量化为 BF16")
    logger.info(f"设备: {device_str}, 精度: {dtype}")

    torch_device = torch.device(device_str)

    import warnings
    import transformers
    prev_verbosity = transformers.logging.get_verbosity()
    transformers.logging.set_verbosity_error()

    has_metadata = _has_safetensors_metadata(model_path)

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        if has_metadata:
            model = AudioDiTModel.from_pretrained(
                str(model_path),
                torch_dtype=torch.bfloat16,
                local_files_only=True,    # ← 关键：严格离线
            )
        else:
            logger.debug("safetensors 缺少 format metadata → 走直接 safetensors 加载路径")
            model = _load_model_direct(
                model_path, AudioDiTModel, torch.bfloat16
            )
    transformers.logging.set_verbosity(prev_verbosity)

    # 3) weight_norm 修复 & FP8 反量化（直接沿用移植过来的实现）
    safetensors_path = model_path / "model.safetensors"
    if safetensors_path.exists():
        from safetensors.torch import load_file

        sd = load_file(str(safetensors_path))
        wn_keys = {k: v for k, v in sd.items() if "weight_g" in k or "weight_v" in k}
        if wn_keys:
            model.load_state_dict(wn_keys, strict=False)
            logger.info(f"修复 {len(wn_keys)} 个 weight_norm 参数")
        if fp8:
            import json
            scales_file = model_path / "fp8_scales.json"
            if scales_file.exists():
                with open(scales_file) as f:
                    fp8_scales = json.load(f)
                dequantized = 0
                for name, scale_val in fp8_scales.items():
                    if name not in sd:
                        continue
                    tensor = sd[name]
                    if tensor.dtype != torch.float8_e4m3fn:
                        continue
                    deq = tensor.to(torch.bfloat16) * scale_val
                    parts = name.split(".")
                    obj = model
                    for p in parts[:-1]:
                        obj = obj[int(p)] if p.isdigit() else getattr(obj, p)
                    new_param = nn.Parameter(deq, requires_grad=False)
                    setattr(obj, parts[-1], new_param)
                    dequantized += 1
                if dequantized > 0:
                    logger.info(
                        f"FP8 → BF16 反量化完成: {dequantized} 个张量"
                        f"（相对 bf16 模型节省 ~{dequantized * 2:.0f}MB 下载体积）"
                    )

    # 4) dtype 精细化（UMT5 层 norm 怕 fp16 溢出，保持 bf16 及以上）
    vae_dtype = torch.bfloat16 if device_str == "cuda" else torch.float32
    _DTYPE_RANK = {torch.float16: 1, torch.bfloat16: 2, torch.float32: 3}
    text_encoder_dtype = (
        dtype if _DTYPE_RANK.get(dtype, 0) >= _DTYPE_RANK[torch.bfloat16] else torch.bfloat16
    )
    if hasattr(model, "text_encoder"):
        model.text_encoder.to(text_encoder_dtype)
    if hasattr(model, "transformer"):
        model.transformer.to(dtype)
    if hasattr(model, "vae"):
        model.vae.to(vae_dtype)
    model.to(torch_device)
    model.eval()

    # 5) 严格离线加载 tokenizer（local_files_only=True + 本地路径）
    tok_local = _find_local_tokenizer(getattr(model.config, "text_encoder_model", _KNOWN_TOKENIZER_REPO))
    tokenizer = AutoTokenizer.from_pretrained(str(tok_local), local_files_only=True)

    # 6) Attention patch（复用移植过来的 flash/sdpa/sage 实现）
    if attention != "auto":
        patch_attention(model, attention, device_str)

    # 7) VBAR / aimdo 动态显存复用
    model._vbar_active = False
    model._aimdo_auto = False
    if device_str == "cuda":
        try:
            vbar_avail, aimdo_avail = _detect_vbar()
            if vbar_avail:
                model._vbar_active = True
                logger.info("检测到 ComfyUI VBAR 显式动态显存管理")
            elif aimdo_avail:
                model._aimdo_auto = True
                logger.info("检测到 ComfyUI aimdo 自动显存分配")
        except Exception:
            pass

    return model, tokenizer

"""Locate Pose Studio model directories on local and cloud ComfyUI installs.

Pose Studio expects its weights under ``<ComfyUI>/models/vnccs-xzg``. On cloud
images the real model root is not always identical to
``folder_paths.models_dir`` (data mounts, symlinked model directories, custom
base paths), and one-click archive extraction often produces an extra
``vnccs-xzg/vnccs-xzg`` level. This module searches every plausible root,
tolerates the duplicated nesting, and builds error messages that list the
paths that were actually checked.

An explicit override is available through the ``XZG_VNCCS_MODEL_DIR`` (or
``VNCCS_XZG_MODEL_DIR``) environment variable; it may point either at the
models root or directly at the ``vnccs-xzg`` folder.
"""

from __future__ import annotations

import os
import shutil
import threading

NESTED_DIR = "vnccs-xzg"
_ENV_VARS = ("XZG_VNCCS_MODEL_DIR", "VNCCS_XZG_MODEL_DIR")
_MAX_NESTING = 2
_DOWNLOAD_LOCK = threading.Lock()


def _download_repo_files(repo_id, relative_parts, filenames, label, revision="main"):
    """Download only missing files from Hugging Face into the resolved model directory."""
    roots = candidate_models_roots()
    if not roots:
        raise RuntimeError("无法定位 ComfyUI 的 models 目录，请设置 XZG_VNCCS_MODEL_DIR。")
    model_dir = os.path.join(roots[0], *relative_parts)
    os.makedirs(model_dir, exist_ok=True)
    try:
        from huggingface_hub import hf_hub_download
    except ImportError as exc:
        raise RuntimeError(
            f"下载 {label} 需要 huggingface_hub。请在 ComfyUI Python 环境运行："
            "python -m pip install -U huggingface_hub"
        ) from exc

    with _DOWNLOAD_LOCK:
        for filename in filenames:
            destination = os.path.join(model_dir, *filename.split("/"))
            if os.path.isfile(destination) and os.path.getsize(destination) > 0:
                continue
            os.makedirs(os.path.dirname(destination), exist_ok=True)
            print(f"[VNCCS] Downloading {label}: {filename} from {repo_id}")
            try:
                cached = hf_hub_download(
                    repo_id=repo_id,
                    filename=filename,
                    revision=revision,
                )
                if os.path.normcase(os.path.abspath(cached)) != os.path.normcase(os.path.abspath(destination)):
                    shutil.copy2(cached, destination)
            except Exception as exc:
                raise RuntimeError(
                    f"自动下载 {label} 失败（{repo_id}/{filename}）：{exc}\n"
                    "请确认网络可访问 Hugging Face；若仓库为 gated 模型，请先登录 Hugging Face、"
                    "接受模型许可，并设置 HF_TOKEN 环境变量后重启 ComfyUI。"
                ) from exc
    return model_dir


def ensure_sam3d_downloaded():
    """Fetch the official gated SAM 3D Body files when they are absent locally."""
    parts = (NESTED_DIR, "sam3dbody")
    required = ("model.ckpt", "assets/mhr_model.pt")
    existing = resolve_model_dir(parts, required)
    if existing:
        return existing
    return _download_repo_files(
        "facebook/sam-3d-body-dinov3", parts, required, "SAM 3D Body"
    )


def ensure_birefnet_downloaded():
    """Fetch the public BiRefNet Lite snapshot when absent locally."""
    parts = (NESTED_DIR, "birefnet", "BiRefNet_lite")
    if resolve_model_dir(parts, ("config.json",)):
        return resolve_model_dir(parts, ("config.json",))
    try:
        from huggingface_hub import snapshot_download
    except ImportError as exc:
        raise RuntimeError(
            "下载 BiRefNet Lite 需要 huggingface_hub。请在 ComfyUI Python 环境运行："
            "python -m pip install -U huggingface_hub"
        ) from exc
    roots = candidate_models_roots()
    if not roots:
        raise RuntimeError("无法定位 ComfyUI 的 models 目录，请设置 XZG_VNCCS_MODEL_DIR。")
    model_dir = os.path.join(roots[0], *parts)
    os.makedirs(model_dir, exist_ok=True)
    with _DOWNLOAD_LOCK:
        try:
            snapshot_download(
                repo_id="ZhengPeng7/BiRefNet_lite",
                local_dir=model_dir,
                ignore_patterns=["*.md", ".gitattributes"],
            )
        except Exception as exc:
            raise RuntimeError(
                f"自动下载 BiRefNet Lite 失败：{exc}\n请确认网络可访问 Hugging Face。"
            ) from exc
    return model_dir


def _add_unique(items, seen, path):
    if not path:
        return
    try:
        absolute = os.path.abspath(path)
        key = os.path.normcase(absolute)
    except Exception:
        return
    if key in seen:
        return
    seen.add(key)
    items.append(absolute)


def _folder_paths_models_dir():
    try:
        import folder_paths
    except Exception:
        return ""
    return str(getattr(folder_paths, "models_dir", "") or "")


def _plugin_models_dir():
    """``<ComfyUI>/models`` derived from this file, independent of folder_paths."""
    current = os.path.abspath(os.path.dirname(__file__))
    for _ in range(10):
        parent = os.path.dirname(current)
        if parent == current:
            break
        if os.path.basename(current).lower() == "custom_nodes":
            return os.path.join(parent, "models")
        current = parent
    return ""


def candidate_models_roots():
    """Model roots to search, most explicit first."""
    roots, seen = [], set()
    for name in _ENV_VARS:
        raw = (os.environ.get(name) or "").strip().strip('"').strip("'")
        if not raw:
            continue
        normalized = os.path.normpath(raw)
        if os.path.basename(normalized).lower() == NESTED_DIR:
            _add_unique(roots, seen, os.path.dirname(normalized))
        else:
            _add_unique(roots, seen, normalized)
    _add_unique(roots, seen, _folder_paths_models_dir())
    _add_unique(roots, seen, _plugin_models_dir())
    return roots


def _relative_variants(relative_parts):
    parts = tuple(str(part) for part in relative_parts if part)
    variants, seen = [], set()

    def push(candidate):
        if not candidate:
            return
        key = tuple(item.lower() for item in candidate)
        if key in seen:
            return
        seen.add(key)
        variants.append(candidate)

    if parts and parts[0].lower() == NESTED_DIR:
        tail = parts[1:]
        push(parts)
        for depth in range(1, _MAX_NESTING + 1):
            push((NESTED_DIR,) * depth + parts)
        # Legacy layout without the vnccs-xzg prefix.
        push(tail)
        for depth in range(1, _MAX_NESTING + 1):
            push((NESTED_DIR,) * depth + tail)
    else:
        push(parts)
    return variants


def model_dirs(relative_parts):
    """Every candidate absolute directory for the requested relative layout."""
    directories = []
    for root in candidate_models_roots():
        for parts in _relative_variants(relative_parts):
            directories.append(os.path.join(root, *parts))
    return directories


def has_required_files(directory, required_files=()):
    if not directory or not os.path.isdir(directory):
        return False
    for item in required_files:
        if not os.path.isfile(os.path.join(directory, item)):
            return False
    return True


def resolve_model_dir(relative_parts, required_files=()):
    """First existing candidate directory, or ``""`` when nothing matches."""
    for directory in model_dirs(relative_parts):
        if has_required_files(directory, required_files):
            return directory
    return ""


def missing_model_message(relative_parts, label, required_files=()):
    """Actionable error text listing the searched models roots."""
    tail = tuple(relative_parts)[1:]
    lines = [
        f"缺少 {label} 模型，插件会尝试从 Hugging Face 自动下载。",
        "已查找以下 models 目录（[缺失] 表示目录不存在或缺少必需文件）：",
    ]
    roots = candidate_models_roots()
    for root in roots:
        primary = os.path.join(root, NESTED_DIR, *tail)
        legacy = os.path.join(root, *tail)
        lines.append(f"  - [{_marker(primary, required_files)}] {primary}")
        if os.path.normcase(legacy) != os.path.normcase(primary):
            lines.append(f"  - [{_marker(legacy, required_files)}] {legacy}")
    if required_files:
        names = "、".join(item.replace(os.sep, "/") for item in required_files)
        lines.append(f"必需文件：{names}")
    root = roots[0] if roots else "models"
    lines.append(f"存放目录：{os.path.join(root, NESTED_DIR)}")
    lines.append(f"正确结构示例：{os.path.join(root, NESTED_DIR, *tail)}")
    lines.append("若模型在其他位置，可设置环境变量 XZG_VNCCS_MODEL_DIR 指向模型目录后重启 ComfyUI。")
    return "\n".join(lines)


def _marker(directory, required_files):
    return "已找到" if has_required_files(directory, required_files) else "缺失"

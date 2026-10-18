import os
import folder_paths


# Pose Studio models share a dedicated folder under ComfyUI/models.
MODEL_DIR = os.path.join(folder_paths.models_dir, "vnccs-xzg", "sam3dbody")
LEGACY_MODEL_DIR = os.path.join(folder_paths.models_dir, "sam3dbody")
DEVICE_OPTIONS = ["Auto", "CUDA", "CPU"]


def _resolve_device(device_mode: str) -> str:
    import torch

    normalized = (device_mode or "Auto").strip().lower()
    if normalized == "auto":
        return "cuda" if torch.cuda.is_available() else "cpu"
    if normalized == "cuda":
        if not torch.cuda.is_available():
            raise RuntimeError("[SAM3DBody] CUDA was selected, but CUDA is not available.")
        return "cuda"
    if normalized == "cpu":
        return "cpu"
    raise ValueError(f"[SAM3DBody] Unsupported device mode: {device_mode}")


class LoadSAM3DBodyModel:
    """
    Prepares SAM 3D Body model configuration.

    Model files live in `<ComfyUI>/models/vnccs-xzg/sam3dbody/`;
    existing installations under `<ComfyUI>/models/sam3dbody/` remain usable.
    Missing weights require manual installation from the supplied download link.
    The actual model is loaded lazily inside the isolated worker when
    inference runs.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "device_mode": (DEVICE_OPTIONS, {
                    "default": "Auto",
                    "tooltip": "Auto tries CUDA first and falls back to CPU if CUDA cannot be used"
                }),
            },
        }

    RETURN_TYPES = ("SAM3D_MODEL",)
    RETURN_NAMES = ("model",)
    FUNCTION = "load_model"
    CATEGORY = "SAM3DBody"

    def load_model(self, device_mode):
        """Prepare model config (actual loading happens in inference nodes)."""
        resolved_device = _resolve_device(device_mode)

        model_path = MODEL_DIR
        if not _model_files_exist(model_path) and _model_files_exist(LEGACY_MODEL_DIR):
            model_path = LEGACY_MODEL_DIR
        ckpt_path = os.path.join(model_path, "model.ckpt")
        mhr_path = os.path.join(model_path, "assets", "mhr_model.pt")

        if not _model_files_exist(model_path):
            raise RuntimeError(
                "缺少 SAM 3D Body 模型，请手动下载并解压安装。\n"
                "下载地址：https://pan.quark.cn/s/9a332350f6fc\n"
                f"存放目录：{MODEL_DIR}\n"
                "目录中需包含 model.ckpt、model_config.yaml 和 assets/mhr_model.pt。"
            )

        # Return config dict (not the actual model)
        model_config = {
            "model_path": model_path,
            "ckpt_path": ckpt_path,
            "mhr_path": mhr_path,
            "device_mode": device_mode,
            "device": resolved_device,
        }

        return (model_config,)


# Register node
NODE_CLASS_MAPPINGS = {
    "LoadSAM3DBodyModel": LoadSAM3DBodyModel,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LoadSAM3DBodyModel": "Load SAM 3D Body Model",
}


def _model_files_exist(model_path):
    return (
        os.path.isfile(os.path.join(model_path, "model.ckpt"))
        and os.path.isfile(os.path.join(model_path, "assets", "mhr_model.pt"))
        and os.path.isfile(os.path.join(model_path, "model_config.yaml"))
    )

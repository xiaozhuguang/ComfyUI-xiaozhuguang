import os

from .model_paths import ensure_sam3d_downloaded, missing_model_message, resolve_model_dir

# Pose Studio model layout: <ComfyUI>/models/vnccs-xzg/sam3dbody/
SAM3D_RELATIVE_PARTS = ("vnccs-xzg", "sam3dbody")
# model_config.yaml is intentionally not required: sam_3d_body falls back to
# the bundled copy under vnccs_sam3d/sam_3d_body/configs/ when the model
# folder does not ship one.
SAM3D_REQUIRED_FILES = ("model.ckpt", os.path.join("assets", "mhr_model.pt"))
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
    Every plausible models root is searched (folder_paths.models_dir, the
    ComfyUI install that contains this plugin, and XZG_VNCCS_MODEL_DIR).
    Missing weights are fetched from the official gated Hugging Face repository.
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

        model_path = resolve_model_dir(SAM3D_RELATIVE_PARTS, SAM3D_REQUIRED_FILES)
        if not model_path:
            model_path = ensure_sam3d_downloaded()
            model_path = resolve_model_dir(SAM3D_RELATIVE_PARTS, SAM3D_REQUIRED_FILES) or model_path
        if not model_path:
            raise RuntimeError(
                missing_model_message(SAM3D_RELATIVE_PARTS, "SAM 3D Body", SAM3D_REQUIRED_FILES)
            )

        ckpt_path = os.path.join(model_path, "model.ckpt")
        mhr_path = os.path.join(model_path, "assets", "mhr_model.pt")
        print(f"[SAM3DBody] Using SAM 3D Body model directory: {model_path}")

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

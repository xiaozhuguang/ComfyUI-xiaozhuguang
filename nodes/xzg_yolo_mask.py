"""YOLO object masks for ComfyUI image batches."""

import os
from functools import lru_cache

import torch
import torch.nn.functional as F
import folder_paths


_MODEL_FOLDER = "xzg_ultralytics"
_NO_MODELS = "(请将模型放入 models/ultralytics)"
folder_paths.folder_names_and_paths[_MODEL_FOLDER] = (
    [os.path.join(folder_paths.models_dir, "ultralytics")],
    {".pt", ".onnx", ".engine"},
)


def _available_models():
    return folder_paths.get_filename_list(_MODEL_FOLDER) or [_NO_MODELS]


@lru_cache(maxsize=3)
def _load_model(path):
    try:
        from ultralytics import YOLO
    except ImportError as e:
        raise RuntimeError("缺少 ultralytics 依赖，请在 ComfyUI Python 环境安装 ultralytics。") from e
    return YOLO(path)


class XiaozhuguangYoloMask:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "model": (_available_models(),),
                "confidence": ("FLOAT", {"default": 0.25, "min": 0.01, "max": 1.0, "step": 0.01}),
                "iou": ("FLOAT", {"default": 0.7, "min": 0.01, "max": 1.0, "step": 0.01}),
                "mask_padding": ("INT", {"default": 0, "min": 0, "max": 128, "step": 1}),
                "invert_mask": ("BOOLEAN", {"default": False}),
            },
            "optional": {
                "class_id": ("INT", {"default": -1, "min": -1, "max": 999, "step": 1,
                                       "tooltip": "-1 表示保留所有类别；指定类别编号可只输出该类。请以模型的类别定义为准。"}),
            },
        }

    RETURN_TYPES = ("MASK",)
    RETURN_NAMES = ("遮罩",)
    FUNCTION = "run"
    CATEGORY = "小珠光/视频"
    DESCRIPTION = "使用 Ultralytics YOLO 对 IMAGE 批次逐张检测，将分割轮廓合并为遮罩；检测模型无分割头时使用检测框生成遮罩。模型放在 ComfyUI/models/ultralytics 或其子目录。"

    def run(self, image, model, confidence=0.25, iou=0.7, mask_padding=0, invert_mask=False, class_id=-1):
        if image.ndim != 4 or image.shape[-1] < 3:
            raise ValueError("输入图像需要是 [批次, 高, 宽, RGB] 格式。")
        if not model or model == _NO_MODELS:
            raise RuntimeError("未找到 YOLO 模型。请将权重放入 ComfyUI/models/ultralytics，并刷新节点。")
        model_path = folder_paths.get_full_path_or_raise(_MODEL_FOLDER, model)
        detector = _load_model(os.path.abspath(model_path))
        h, w = image.shape[1:3]
        masks = []
        for frame in image:
            rgb = (frame[..., :3].clamp(0, 1) * 255).to(torch.uint8).cpu().numpy()
            result = detector.predict(source=rgb, conf=float(confidence), iou=float(iou), verbose=False)[0]
            mask = torch.zeros((h, w), dtype=torch.float32)
            boxes = result.boxes
            selected = []
            if boxes is not None and len(boxes):
                classes = boxes.cls.detach().cpu().tolist()
                selected = [idx for idx, c in enumerate(classes) if int(class_id) < 0 or int(c) == int(class_id)]
            if result.masks is not None and selected:
                segs = result.masks.data.detach().float().cpu()
                for idx in selected:
                    seg = F.interpolate(segs[idx:idx + 1, None], size=(h, w), mode="nearest")[0, 0]
                    mask.maximum_(seg)
            elif selected:
                xyxy = boxes.xyxy.detach().cpu()
                for idx in selected:
                    x1, y1, x2, y2 = xyxy[idx].round().int().tolist()
                    x1, x2 = max(0, x1), min(w, x2)
                    y1, y2 = max(0, y1), min(h, y2)
                    if x2 > x1 and y2 > y1:
                        mask[y1:y2, x1:x2] = 1
            if mask_padding:
                radius = int(mask_padding)
                mask = F.max_pool2d(mask[None, None], kernel_size=radius * 2 + 1, stride=1, padding=radius)[0, 0]
            if invert_mask:
                mask = 1 - mask
            masks.append(mask)
        return (torch.stack(masks).to(device=image.device, dtype=image.dtype),)

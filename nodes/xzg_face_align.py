
import torch
import numpy as np
from PIL import Image


_INSIGHTFACE_APP_CACHE = {}
_MEDIAPIPE_FACE_DETECTION_CACHE = {}


def _image_to_rgb_uint8(image, index=0, name="image"):
    if not isinstance(image, torch.Tensor) or image.ndim != 4:
        raise ValueError(f"{name} must be a ComfyUI IMAGE tensor.")
    frame_count = int(image.shape[0])
    if frame_count <= 0:
        raise ValueError(f"{name} has no frames.")
    frame_index = max(0, min(frame_count - 1, int(index)))
    frame = image[frame_index].detach().cpu().float().clamp(0, 1)
    if int(frame.shape[-1]) > 3:
        frame = frame[..., :3]
    if int(frame.shape[-1]) < 3:
        frame = frame[..., :1].repeat(1, 1, 3)
    return (frame.numpy() * 255.0).round().astype("uint8")


def _rgb_uint8_to_image_tensor(image):
    value = np.asarray(image)
    if value.ndim != 3 or int(value.shape[-1]) < 3:
        raise ValueError("image array must have shape [H,W,3].")
    value = value[:, :, :3].astype("float32") / 255.0
    return torch.from_numpy(value).unsqueeze(0).contiguous().clamp(0, 1)


def _select_face_info(candidates, image_w, image_h, name):
    if candidates:
        cx = float(image_w) / 2.0
        cy = float(image_h) / 2.0
        return min(
            candidates,
            key=lambda item: (float(item["center"][0]) - cx) ** 2 + (float(item["center"][1]) - cy) ** 2,
        )
    return {
        "bbox": [0.0, 0.0, float(image_w), float(image_h)],
        "bbox_int": [0, 0, int(image_w), int(image_h)],
        "center": [float(image_w) * 0.5, float(image_h) * 0.5],
        "size": [float(image_w), float(image_h)],
        "score": None,
        "fallback": True,
    }


def _get_mediapipe_detector():
    cache_key = "short_range_0.5"
    detector = _MEDIAPIPE_FACE_DETECTION_CACHE.get(cache_key)
    if detector is not None:
        return detector, {
            "backend": "mediapipe",
            "model_selection": "short_range",
            "min_detection_confidence": 0.5,
        }
    try:
        import mediapipe as mp
        detector = mp.solutions.face_detection.FaceDetection(
            model_selection=0,
            min_detection_confidence=0.5,
        )
        _MEDIAPIPE_FACE_DETECTION_CACHE[cache_key] = detector
        return detector, {
            "backend": "mediapipe",
            "model_selection": "short_range",
            "min_detection_confidence": 0.5,
        }
    except Exception:
        return None, None


def _detect_face_mediapipe(image_rgb, name):
    image_h, image_w = int(image_rgb.shape[0]), int(image_rgb.shape[1])
    detector, model_info = _get_mediapipe_detector()
    if detector is None:
        return None, None
    result = detector.process(image_rgb)
    detections = list(getattr(result, "detections", None) or [])
    candidates = []
    for detection in detections:
        location_data = getattr(detection, "location_data", None)
        relative_bbox = getattr(location_data, "relative_bounding_box", None)
        if relative_bbox is None:
            continue
        x0 = float(relative_bbox.xmin) * float(image_w)
        y0 = float(relative_bbox.ymin) * float(image_h)
        x1 = x0 + float(relative_bbox.width) * float(image_w)
        y1 = y0 + float(relative_bbox.height) * float(image_h)
        x0 = max(0.0, min(float(image_w), x0))
        y0 = max(0.0, min(float(image_h), y0))
        x1 = max(x0 + 1.0, min(float(image_w), x1))
        y1 = max(y0 + 1.0, min(float(image_h), y1))
        score_values = list(getattr(detection, "score", None) or [])
        candidates.append(
            {
                "bbox": [float(x0), float(y0), float(x1), float(y1)],
                "bbox_int": [int(round(x0)), int(round(y0)), int(round(x1)), int(round(y1))],
                "center": [float((x0 + x1) * 0.5), float((y0 + y1) * 0.5)],
                "size": [float(x1 - x0), float(y1 - y0)],
                "score": float(score_values[0]) if score_values else None,
            }
        )
    selected = _select_face_info(candidates, int(image_w), int(image_h), str(name))
    return selected, {**model_info, "candidate_count": int(len(candidates)), "fallback": selected.get("fallback", False)}


def _insightface_providers(provider_mode):
    normalized = str(provider_mode or "auto").strip().lower()
    available = []
    try:
        import onnxruntime as ort
        available = list(ort.get_available_providers())
    except Exception:
        available = []

    if normalized == "cpu":
        return "cpu", ["CPUExecutionProvider"], -1
    if normalized == "cuda":
        if not available or "CUDAExecutionProvider" in available:
            return "cuda", ["CUDAExecutionProvider", "CPUExecutionProvider"], 0
        raise RuntimeError(
            "onnxruntime does not expose CUDAExecutionProvider. Install onnxruntime-gpu or set provider to cpu."
        )
    if "CUDAExecutionProvider" in available:
        return "cuda", ["CUDAExecutionProvider", "CPUExecutionProvider"], 0
    return "cpu", ["CPUExecutionProvider"], -1


def _get_insightface_app(det_size):
    try:
        from insightface.app import FaceAnalysis
    except Exception:
        return None, None

    import folder_paths
    import os

    insightface_root = os.path.join(folder_paths.models_dir, "insightface")

    provider_name, providers, device_id = _insightface_providers("auto")
    cache_key = (provider_name, int(det_size), int(device_id))

    app = _INSIGHTFACE_APP_CACHE.get(cache_key)
    if app is None:
        app = FaceAnalysis(
            name="buffalo_l",
            root=insightface_root,
            providers=providers,
        )
        app.prepare(ctx_id=device_id, det_size=(int(det_size), int(det_size)))
        _INSIGHTFACE_APP_CACHE[cache_key] = app

    return app, {
        "backend": "insightface",
        "model": "buffalo_l",
        "provider": provider_name,
        "det_size": int(det_size),
        "model_root": insightface_root,
    }


def _face_bbox_info(face, image_w, image_h):
    bbox = getattr(face, "bbox", None)
    if bbox is None or len(bbox) != 4:
        return None
    x0, y0, x1, y1 = [float(value) for value in bbox]
    x0 = max(0.0, min(float(image_w), x0))
    y0 = max(0.0, min(float(image_h), y0))
    x1 = max(x0 + 1.0, min(float(image_w), x1))
    y1 = max(y0 + 1.0, min(float(image_h), y1))
    score = getattr(face, "det_score", None)
    return {
        "bbox": [float(x0), float(y0), float(x1), float(y1)],
        "bbox_int": [int(round(x0)), int(round(y0)), int(round(x1)), int(round(y1))],
        "center": [float((x0 + x1) * 0.5), float((y0 + y1) * 0.5)],
        "size": [float(x1 - x0), float(y1 - y0)],
        "score": float(score) if score is not None else None,
    }


def _detect_face_insightface(image_rgb, name, det_size):
    image_h, image_w = int(image_rgb.shape[0]), int(image_rgb.shape[1])
    app, model_info = _get_insightface_app(int(det_size))
    if app is None:
        return None, None
    faces = list(app.get(image_rgb[:, :, ::-1].copy()))
    candidates = []
    for face in faces:
        info = _face_bbox_info(face, int(image_w), int(image_h))
        if info is not None:
            candidates.append(info)
    selected = _select_face_info(candidates, int(image_w), int(image_h), str(name))
    return selected, {"backend": "insightface", **model_info, "candidate_count": int(len(candidates)), "fallback": selected.get("fallback", False)}


def _detect_face_pair(target_rgb, reference_rgb, det_size):
    def try_mediapipe():
        target_info, target_model = _detect_face_mediapipe(target_rgb, "target_image")
        if target_info is None:
            return None
        reference_info, reference_model = _detect_face_mediapipe(reference_rgb, "reference_image")
        if reference_info is None:
            return None
        if target_info.get("fallback") and reference_info.get("fallback"):
            return None
        return target_info, reference_info, {
            "backend_used": "mediapipe",
            "target": target_model,
            "reference": reference_model,
        }

    def try_insightface():
        target_info, target_model = _detect_face_insightface(target_rgb, "target_image", int(det_size))
        if target_info is None:
            return None
        reference_info, reference_model = _detect_face_insightface(reference_rgb, "reference_image", int(det_size))
        if reference_info is None:
            return None
        return target_info, reference_info, {
            "backend_used": "insightface",
            "target": target_model,
            "reference": reference_model,
        }

    result = try_mediapipe()
    if result is not None:
        return result

    result = try_insightface()
    if result is not None:
        return result

    image_h, image_w = int(target_rgb.shape[0]), int(target_rgb.shape[1])
    ref_h, ref_w = int(reference_rgb.shape[0]), int(reference_rgb.shape[1])
    target_info = {
        "bbox": [0.0, 0.0, float(image_w), float(image_h)],
        "bbox_int": [0, 0, int(image_w), int(image_h)],
        "center": [float(image_w) * 0.5, float(image_h) * 0.5],
        "size": [float(image_w), float(image_h)],
        "score": None,
        "fallback": True,
    }
    reference_info = {
        "bbox": [0.0, 0.0, float(ref_w), float(ref_h)],
        "bbox_int": [0, 0, int(ref_w), int(ref_h)],
        "center": [float(ref_w) * 0.5, float(ref_h) * 0.5],
        "size": [float(ref_w), float(ref_h)],
        "score": None,
        "fallback": True,
    }
    return target_info, reference_info, {
        "backend_used": "fallback",
        "note": "both mediapipe and insightface failed, using full image as face",
    }


def _extract_reference_window_no_resize(
    image_rgb,
    x0,
    y0,
    canvas_w,
    canvas_h,
    padding_mode,
    window_fit_mode="shift_inside_reference",
):
    height, width = int(image_rgb.shape[0]), int(image_rgb.shape[1])
    canvas_w = max(1, int(canvas_w))
    canvas_h = max(1, int(canvas_h))
    requested_x0 = int(x0)
    requested_y0 = int(y0)
    requested_x1 = requested_x0 + canvas_w
    requested_y1 = requested_y0 + canvas_h
    normalized_fit_mode = str(window_fit_mode or "shift_inside_reference").strip()
    if normalized_fit_mode not in {"shift_inside_reference", "strict_alignment"}:
        normalized_fit_mode = "shift_inside_reference"
    x0 = requested_x0
    y0 = requested_y0
    if normalized_fit_mode == "shift_inside_reference":
        if canvas_w <= width:
            x0 = max(0, min(int(x0), width - canvas_w))
        if canvas_h <= height:
            y0 = max(0, min(int(y0), height - canvas_h))
    x1 = int(x0) + canvas_w
    y1 = int(y0) + canvas_h
    crop_x0 = max(0, int(x0))
    crop_y0 = max(0, int(y0))
    crop_x1 = min(width, int(x1))
    crop_y1 = min(height, int(y1))
    if crop_x1 <= crop_x0 or crop_y1 <= crop_y0:
        raise RuntimeError("reference crop window did not overlap the reference image.")
    crop = image_rgb[crop_y0:crop_y1, crop_x0:crop_x1, :3]
    pad_left = max(0, -int(x0))
    pad_top = max(0, -int(y0))
    pad_right = max(0, int(x1) - width)
    pad_bottom = max(0, int(y1) - height)
    normalized = str(padding_mode or "white").strip()
    if normalized not in {"white", "black"}:
        normalized = "white"

    if pad_left or pad_top or pad_right or pad_bottom:
        if normalized == "white":
            fill = np.array([255, 255, 255], dtype=np.uint8)
        else:
            fill = np.array([0, 0, 0], dtype=np.uint8)
        output = np.empty((canvas_h, canvas_w, 3), dtype=np.uint8)
        output[:, :, :] = fill.reshape(1, 1, 3)
        output[pad_top : pad_top + int(crop.shape[0]), pad_left : pad_left + int(crop.shape[1]), :] = crop
    else:
        output = crop
    output = output[:canvas_h, :canvas_w, :3]
    if int(output.shape[0]) != canvas_h or int(output.shape[1]) != canvas_w:
        fixed = np.empty((canvas_h, canvas_w, 3), dtype=np.uint8)
        fixed[:, :, :] = output[-1:, -1:, :]
        fixed[: int(output.shape[0]), : int(output.shape[1]), :] = output
        output = fixed
    return output.astype(np.uint8), {
        "fit_mode": normalized_fit_mode,
        "requested_window_xyxy": [int(requested_x0), int(requested_y0), int(requested_x1), int(requested_y1)],
        "window_xyxy": [int(x0), int(y0), int(x1), int(y1)],
        "window_shift_xy": [int(x0) - int(requested_x0), int(y0) - int(requested_y0)],
        "source_overlap_xyxy": [int(crop_x0), int(crop_y0), int(crop_x1), int(crop_y1)],
        "padding": {
            "left": int(pad_left),
            "top": int(pad_top),
            "right": int(pad_right),
            "bottom": int(pad_bottom),
            "mode": normalized,
            "unavoidable": bool(
                ((pad_left or pad_right) and canvas_w > width)
                or ((pad_top or pad_bottom) and canvas_h > height)
            ),
        },
    }


class XiaozhuguangFaceAlign:
    CATEGORY = "xiaozhuguang"
    DESCRIPTION = "将参考图像中的人脸对齐到目标图像的人脸位置和比例"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "target_image": ("IMAGE",),
                "reference_image": ("IMAGE",),
                "target_frame_index": ("INT", {"default": 0, "min": 0, "max": 999999, "step": 1}),
                "padding_mode": (["white", "black"], {"default": "white"}),
                "检测分辨率": ("INT", {"default": 640, "min": 160, "max": 2048, "step": 32}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("aligned_reference_image",)
    FUNCTION = "align"

    def align(
        self,
        target_image,
        reference_image,
        target_frame_index=0,
        padding_mode="white",
        检测分辨率=640,
    ):
        face_scale = 1.0
        x_offset_ratio = 0.0
        y_offset_ratio = 0.0
        det_size = int(检测分辨率)
        face_size_basis = "bbox_width"
        window_fit_mode = "shift_inside_reference"
        target_rgb = _image_to_rgb_uint8(target_image, int(target_frame_index), "target_image")
        reference_rgb = _image_to_rgb_uint8(reference_image, 0, "reference_image")
        target_h, target_w = int(target_rgb.shape[0]), int(target_rgb.shape[1])
        ref_h, ref_w = int(reference_rgb.shape[0]), int(reference_rgb.shape[1])
        if target_h <= 0 or target_w <= 0 or ref_h <= 0 or ref_w <= 0:
            raise ValueError("target_image and reference_image must contain non-empty images.")

        target_info, reference_info, detector_info = _detect_face_pair(
            target_rgb,
            reference_rgb,
            int(det_size),
        )

        target_aspect = float(target_w) / max(1.0, float(target_h))
        scale = max(0.25, min(4.0, float(face_scale)))
        target_relative_size = float(target_info["size"][0]) / max(1.0, float(target_w))
        reference_size = float(reference_info["size"][0])
        canvas_w = int(round(reference_size / max(1e-6, target_relative_size * scale)))
        canvas_h = int(round(float(canvas_w) / max(1e-6, target_aspect)))
        canvas_w = max(1, canvas_w)
        canvas_h = max(1, canvas_h)

        target_relative_center_x = float(target_info["center"][0]) / max(1.0, float(target_w)) + float(x_offset_ratio)
        target_relative_center_y = float(target_info["center"][1]) / max(1.0, float(target_h)) + float(y_offset_ratio)
        ref_center_x = float(reference_info["center"][0])
        ref_center_y = float(reference_info["center"][1])
        window_x0 = int(round(ref_center_x - target_relative_center_x * float(canvas_w)))
        window_y0 = int(round(ref_center_y - target_relative_center_y * float(canvas_h)))
        aligned_rgb, window_info = _extract_reference_window_no_resize(
            reference_rgb,
            window_x0,
            window_y0,
            int(canvas_w),
            int(canvas_h),
            str(padding_mode),
            str(window_fit_mode),
        )
        aligned_reference = _rgb_uint8_to_image_tensor(aligned_rgb)
        return (aligned_reference.contiguous().clamp(0, 1),)


NODE_CLASS_MAPPINGS = {
    "XiaozhuguangFaceAlign": XiaozhuguangFaceAlign,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XiaozhuguangFaceAlign": "Face Align",
}

"""Auto-mask fallback using BiRefNet lite.

Used when the ComfyUI node graph does not provide a MASK input.
The model snapshot is stored under <ComfyUI>/models/vnccs-xzg/birefnet/BiRefNet_lite.
"""

import threading

import cv2
import numpy as np
from PIL import Image

from .. import progress
from .model_paths import ensure_birefnet_downloaded, missing_model_message, resolve_model_dir

_BIREFNET_RELATIVE_PARTS = ("vnccs-xzg", "birefnet", "BiRefNet_lite")
_BIREFNET_REQUIRED_FILES = ("config.json",)
_MODEL_LOCK = threading.Lock()
_MODEL = None
_DEVICE = None


def _select_device():
    import torch

    if torch.cuda.is_available():
        return "cuda"
    xpu = getattr(torch, "xpu", None)
    if xpu is not None and callable(getattr(xpu, "is_available", None)) and xpu.is_available():
        return "xpu"
    return "cpu"


def _ensure_snapshot():
    model_dir = resolve_model_dir(_BIREFNET_RELATIVE_PARTS, _BIREFNET_REQUIRED_FILES)
    if model_dir:
        return model_dir
    model_dir = ensure_birefnet_downloaded()
    resolved = resolve_model_dir(_BIREFNET_RELATIVE_PARTS, _BIREFNET_REQUIRED_FILES)
    if resolved:
        return resolved
    raise RuntimeError(missing_model_message(
        _BIREFNET_RELATIVE_PARTS, "BiRefNet Lite", _BIREFNET_REQUIRED_FILES
    ))


def _load_model():
    global _MODEL, _DEVICE
    with _MODEL_LOCK:
        if _MODEL is not None:
            return _MODEL, _DEVICE or "cpu"

        import torch
        from transformers import AutoModelForImageSegmentation

        torch.set_float32_matmul_precision("high")
        model_dir = _ensure_snapshot()
        device = _select_device()
        print(f"[SAM3DBody] Loading BiRefNet lite from {model_dir} on {device}")
        progress.update(f"Step 3/6: Loading BiRefNet mask model on {device.upper()}...", 52)
        model = AutoModelForImageSegmentation.from_pretrained(
            model_dir,
            trust_remote_code=True,
            local_files_only=True,
        )
        model.to(device)
        model.eval()
        if device == "cuda":
            model.half()

        _MODEL = model
        _DEVICE = device
        return model, device


def _bbox_from_mask(mask_2d):
    rows = np.any(mask_2d > 0, axis=1)
    cols = np.any(mask_2d > 0, axis=0)
    if not rows.any() or not cols.any():
        return None
    rmin, rmax = np.where(rows)[0][[0, -1]]
    cmin, cmax = np.where(cols)[0][[0, -1]]
    return np.array([[cmin, rmin, cmax, rmax]], dtype=np.float32)


def _largest_component(mask_2d):
    num, labels, stats, _ = cv2.connectedComponentsWithStats(mask_2d.astype(np.uint8), connectivity=8)
    if num <= 1:
        return mask_2d.astype(np.uint8)
    best = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    return (labels == best).astype(np.uint8)


def _split_wide_person_component(component, remaining_splits=4):
    """Split a merged side-by-side foreground blob at a strong vertical valley."""
    if remaining_splits <= 0:
        return [component]
    ys, xs = np.where(component > 0)
    if len(xs) < 32:
        return [component]
    x1, x2 = int(xs.min()), int(xs.max()) + 1
    y1, y2 = int(ys.min()), int(ys.max()) + 1
    width, height = x2 - x1, y2 - y1
    if width < 32 or height < 64 or width / height < 0.48:
        return [component]

    # Ignore the arms and head where a single person's silhouette is naturally
    # broad; the torso and upper legs provide a better cue for adjacent people.
    core_y1 = y1 + int(height * 0.2)
    core_y2 = y1 + int(height * 0.82)
    projection = component[core_y1:core_y2, x1:x2].sum(axis=0).astype(np.float32)
    smooth_width = max(3, min(15, (width // 35) | 1))
    if smooth_width % 2 == 0:
        smooth_width += 1
    projection = cv2.GaussianBlur(projection.reshape(1, -1), (smooth_width, 1), 0).reshape(-1)

    start = max(2, int(width * 0.2))
    end = min(width - 2, int(width * 0.8))
    best_cut = None
    best_ratio = 1.0
    side_window = max(3, int(width * 0.12))
    for cut in range(start, end):
        left_peak = float(projection[max(0, cut - 2 * side_window):max(0, cut - side_window)].max(initial=0))
        right_peak = float(projection[min(width, cut + side_window + 1):min(width, cut + 2 * side_window + 1)].max(initial=0))
        shoulder = min(left_peak, right_peak)
        if shoulder <= 0:
            continue
        ratio = float(projection[cut]) / shoulder
        if ratio < best_ratio:
            best_ratio = ratio
            best_cut = cut

    if best_cut is None or best_ratio > 0.42:
        return [component]
    cut_x = x1 + best_cut
    left = component.copy()
    left[:, cut_x:] = 0
    right = component.copy()
    right[:, :cut_x] = 0
    left_area = int(np.count_nonzero(left))
    right_area = int(np.count_nonzero(right))
    if min(left_area, right_area) < max(64, int(np.count_nonzero(component) * 0.18)):
        return [component]
    return (
        _split_wide_person_component(left, remaining_splits - 1)
        + _split_wide_person_component(right, remaining_splits - 1)
    )


def auto_mask_bgr(img_bgr, confidence_threshold=0.5):
    import torch
    from torchvision import transforms

    if img_bgr is None or img_bgr.size == 0:
        raise RuntimeError("[SAM3DBody] BiRefNet received an empty image")

    progress.update("Step 3/6: Segmenting the person and finding the body bounds...", 40)
    model, device = _load_model()
    rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
    pil_image = Image.fromarray(rgb)
    width, height = pil_image.size

    tfm = transforms.Compose([
        transforms.Resize((1024, 1024)),
        transforms.ToTensor(),
        transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
    ])
    input_tensor = tfm(pil_image).unsqueeze(0).to(device)
    if device == "cuda":
        input_tensor = input_tensor.half()

    with torch.no_grad():
        pred = model(input_tensor)[-1].sigmoid().float().cpu().numpy()[0, 0]

    mask_img = Image.fromarray(np.clip(pred * 255.0, 0.0, 255.0).astype(np.uint8), mode="L")
    score_map = np.asarray(mask_img.resize((width, height), Image.BILINEAR), dtype=np.float32) / 255.0
    mask = (score_map >= float(confidence_threshold)).astype(np.uint8)
    if not mask.any():
        raise RuntimeError("[SAM3DBody] BiRefNet produced an empty mask")
    mask = _largest_component(mask)
    bbox = _bbox_from_mask(mask)
    if bbox is None:
        raise RuntimeError("[SAM3DBody] BiRefNet mask bbox is empty")
    progress.update("Step 3/6: Segmentation complete. Body bounds detected.", 54)
    return mask.astype(np.uint8), bbox


def auto_person_masks_bgr(img_bgr, confidence_threshold=0.5, min_area_ratio=0.008):
    """Return separate foreground components for multi-person pose fitting.

    BiRefNet is a foreground segmenter rather than an instance detector, so
    this can separate people only when their masks are spatially disconnected.
    Components are returned from left to right; fragments are discarded and
    merged side-by-side silhouettes are split at strong torso-mask valleys.
    """
    import torch
    from torchvision import transforms

    if img_bgr is None or img_bgr.size == 0:
        raise RuntimeError("[SAM3DBody] BiRefNet received an empty image")
    progress.update("Step 3/6: Separating visible people...", 40)
    model, device = _load_model()
    rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
    pil_image = Image.fromarray(rgb)
    width, height = pil_image.size
    tfm = transforms.Compose([
        transforms.Resize((1024, 1024)),
        transforms.ToTensor(),
        transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
    ])
    input_tensor = tfm(pil_image).unsqueeze(0).to(device)
    if device == "cuda":
        input_tensor = input_tensor.half()
    with torch.no_grad():
        pred = model(input_tensor)[-1].sigmoid().float().cpu().numpy()[0, 0]
    mask_img = Image.fromarray(np.clip(pred * 255.0, 0.0, 255.0).astype(np.uint8), mode="L")
    score_map = np.asarray(mask_img.resize((width, height), Image.BILINEAR), dtype=np.float32) / 255.0
    # Smooth confidence noise before thresholding so tiny edge changes do not
    # create or remove whole connected components between otherwise identical runs.
    score_map = cv2.GaussianBlur(score_map, (0, 0), sigmaX=0.65)
    mask = (score_map >= float(confidence_threshold)).astype(np.uint8)
    if not mask.any():
        raise RuntimeError("[SAM3DBody] BiRefNet produced an empty mask")

    # Join small segmentation gaps within one silhouette before separating
    # disconnected people. This also prevents thin clothing/limb gaps from
    # becoming spurious extra characters.
    close_size = max(5, min(15, int(round(min(width, height) / 120)) | 1))
    close_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (close_size, close_size))
    grouped_mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, close_kernel)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(grouped_mask, connectivity=8)
    min_area = max(64, int(width * height * float(min_area_ratio)))
    components = []
    for label in range(1, count):
        area = int(stats[label, cv2.CC_STAT_AREA])
        if area < min_area:
            continue
        region = labels == label
        component = (mask & region.astype(np.uint8)).astype(np.uint8)
        bbox = _bbox_from_mask(component)
        if bbox is not None:
            for person_component in _split_wide_person_component(component):
                person_bbox = _bbox_from_mask(person_component)
                if person_bbox is None:
                    continue
                person_area = int(np.count_nonzero(person_component))
                if person_area < min_area:
                    continue
                components.append((person_area, person_component, person_bbox))
    if components:
        max_height = max(int(item[2][0, 3] - item[2][0, 1]) for item in components)
        min_person_height = max(48, int(max_height * 0.22))
        components = [
            item for item in components
            if int(item[2][0, 3] - item[2][0, 1]) >= min_person_height
            or item[0] >= int(width * height * 0.02)
        ]
    components.sort(key=lambda item: int(item[2][0, 0]))
    if not components:
        raise RuntimeError("[SAM3DBody] No person-sized foreground components were found")
    progress.update(f"Step 3/6: Found {len(components)} separated foreground region(s).", 54)
    return [(component, bbox) for _, component, bbox in components]

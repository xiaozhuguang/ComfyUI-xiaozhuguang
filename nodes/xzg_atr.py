import logging
import math
import hashlib
from concurrent.futures import ThreadPoolExecutor
import torch
import torch.nn.functional as F
import numpy as np
import cv2
from PIL import Image


class XiaozhuguangATR:
    CATEGORY = "小珠光/其他"
    DEPRECATED = True
    DESCRIPTION = "将处理后的图像粘贴回原图。接缝处理区域输出以红色显示当前接缝轮廓和羽化带，以蓝线显示相同羽化设置下遮罩扩张为0的参考接缝；重合时优先显示蓝线，不标示颜色修正范围。"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "original_image": ("IMAGE",),
                "processed_image": ("IMAGE",),
                "crop_box": ("CROPBOX",),
            },
            "optional": {
                "mask": ("MASK",),
                "edge_color_match": ("BOOLEAN", {"default": False, "tooltip": "分析接缝附近可靠的对应背景，分离亮度与色度进行稳健修正；只作用于羽化过渡区，主体内部保持原色"}),
                "color_match_strength": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.05, "tooltip": "过渡区颜色修正强度；1仍受样本可靠程度及增益、偏移上限约束，0关闭修正"}),
                "color_temporal_smooth": ("FLOAT", {"default": 0.8, "min": 0.0, "max": 0.98, "step": 0.05, "tooltip": "亮度增益、亮度偏移和色度偏移的时间平滑；0关闭。短暂失配延续历史，持续失配逐渐减弱；双路画面结构明显变化时重置，仅在本批次内生效"}),
                "seam_preview": ("BOOLEAN", {"default": False, "tooltip": "仅调试接缝时开启；关闭可跳过预览计算"}),
            }
        }

    RETURN_TYPES = ("IMAGE", "IMAGE")
    RETURN_NAMES = ("restored_image", "seam_preview")
    FUNCTION = "restore_image"

    @staticmethod
    def _resize_numpy(image, width, height, resize_mode="Pillow Lanczos"):
        if resize_mode == "Lanczos4 (legacy)":
            return cv2.resize(image, (width, height), interpolation=cv2.INTER_LANCZOS4)
        if resize_mode == "OpenCV Area":
            # Only reduce axes here; a mixed shrink/enlarge uses Lanczos4 afterward.
            reduced = cv2.resize(image, (min(width, image.shape[1]), min(height, image.shape[0])), interpolation=cv2.INTER_AREA)
            if reduced.shape[:2] != (height, width):
                reduced = cv2.resize(reduced, (width, height), interpolation=cv2.INTER_LANCZOS4)
            return reduced
        filters = {"Pillow Lanczos": Image.Resampling.LANCZOS,
                   "Pillow Lanczos (fast)": Image.Resampling.LANCZOS,
                   "Pillow Bicubic": Image.Resampling.BICUBIC,
                   "Pillow Bilinear": Image.Resampling.BILINEAR}
        return np.asarray(Image.fromarray(image).resize(
            (width, height), filters[resize_mode],
            reducing_gap=3.0 if resize_mode == "Pillow Lanczos (fast)" else None))

    @staticmethod
    def _remove_output_padding(image, crop_info):
        """Remove ATBC alignment padding before resampling (HWC or BHWC)."""
        box = crop_info.get("output_content_box")
        size = crop_info.get("output_size")
        if box is None or size is None:
            return image
        height, width = image.shape[-3:-1]
        sx, sy = width / size[0], height / size[1]
        x0 = max(0, min(width - 1, round(box[0] * sx)))
        y0 = max(0, min(height - 1, round(box[1] * sy)))
        x1 = max(x0 + 1, min(width, round(box[2] * sx)))
        y1 = max(y0 + 1, min(height, round(box[3] * sy)))
        return image[..., y0:y1, x0:x1, :]

    @classmethod
    def _restore_valid_crop(cls, image, info, resize_mode="Pillow Lanczos"):
        """Invert the separately resized real-image region without sampling fill."""
        valid = info.get("output_valid_box")
        source = info.get("source_valid_box")
        if valid is None or source is None:
            return image
        height, width = image.shape[-3:-1]
        out_w, out_h = info["output_size"]
        x0 = max(0, min(width-1, round(valid[0] * width / out_w)))
        y0 = max(0, min(height-1, round(valid[1] * height / out_h)))
        x1 = max(x0+1, min(width, round(valid[2] * width / out_w)))
        y1 = max(y0+1, min(height, round(valid[3] * height / out_h)))
        sx0, sy0, sx1, sy1 = source
        coords = info["original_coords"]
        crop_w, crop_h = coords[2]-coords[0], coords[3]-coords[1]

        def restore(frame):
            content = frame[y0:y1, x0:x1]
            if content.shape[-1] == 1:
                content = cls._resize_numpy(content[..., 0], sx1-sx0, sy1-sy0, resize_mode)[..., None]
            else:
                content = cls._resize_numpy(content, sx1-sx0, sy1-sy0, resize_mode)
            # Padding is discarded after blending; edge extension prevents any
            # subsequent image filter from pulling fill into real boundary pixels.
            return np.pad(content, ((sy0, crop_h-sy1), (sx0, crop_w-sx1), (0, 0)), mode="edge")

        if isinstance(image, torch.Tensor):
            frames = np.clip(image.detach().float().cpu().numpy() * 255, 0, 255).astype(np.uint8)
            restored = np.stack([restore(frame) for frame in frames])
            return torch.from_numpy(restored.astype(np.float32) / 255)
        return restore(image)

    @staticmethod
    def _seam_rect(info):
        """Map the unexpanded source-image seam into the processing crop."""
        if "seam_box" not in info:
            return None
        x0, y0, x1, y1 = info["original_coords"]
        left, top, _, _ = info["pad_info"]
        a, b, c, d = info["seam_box"]
        ow, oh = info["original_image_size"]
        return (0 if a <= 0 else max(0, min(x1-x0, a+left-x0)),
                0 if b <= 0 else max(0, min(y1-y0, b+top-y0)),
                x1-x0 if c >= ow else max(0, min(x1-x0, c+left-x0)),
                y1-y0 if d >= oh else max(0, min(y1-y0, d+top-y0)))

    @staticmethod
    def _pad_seam_mask(mask, margin, info):
        """Keep physical image edges solid; crop edges inside the image are seams."""
        x0, y0, x1, y1 = info["original_coords"]
        left, top, _, _ = info["pad_info"]
        ow, oh = info["original_image_size"]
        if isinstance(mask, torch.Tensor):
            padded = F.pad(mask, (margin,) * 4, mode="replicate")
        else:
            padded = np.pad(mask, margin, mode="edge")
        if x0 > left:
            padded[..., :margin] = 0
        if x1 < left + ow:
            padded[..., -margin:] = 0
        if y0 > top:
            padded[..., :margin, :] = 0
        if y1 < top + oh:
            padded[..., -margin:, :] = 0
        return padded

    def _restore_single_image(self, orig_np, proc_np, crop_info, blur_amount, mask_expand, single_mask=None, color_options=None, color_state=None, seam_data=None, resize_mode="Pillow Lanczos", seam_preview=True, auto_seam=False):
        if single_mask is not None and single_mask.shape[:2] == proc_np.shape[:2]:
            single_mask = self._restore_valid_crop(single_mask[..., None], crop_info, resize_mode)
            single_mask = (single_mask if "output_valid_box" in crop_info else self._remove_output_padding(single_mask, crop_info))[..., 0]
        proc_np = self._restore_valid_crop(proc_np, crop_info, resize_mode)
        if "output_valid_box" not in crop_info:
            proc_np = self._remove_output_padding(proc_np, crop_info)
        original_coords = crop_info["original_coords"]
        padded_size = crop_info["padded_size"]
        original_image_size = crop_info["original_image_size"]
        pad_info = crop_info["pad_info"]
        fill_color = crop_info.get("fill_color", (255, 255, 255))

        pad_left, pad_top, pad_right, pad_bottom = pad_info

        crop_width = original_coords[2] - original_coords[0]
        crop_height = original_coords[3] - original_coords[1]
        x1, y1 = original_coords[0], original_coords[1]

        resized_processed = self._resize_numpy(proc_np, crop_width, crop_height, resize_mode)
        rect = self._seam_rect(crop_info) if single_mask is None and not auto_seam else None
        if rect is not None:
            a, b, c, d = rect
            single_mask = np.zeros((crop_height, crop_width), dtype=np.uint8)
            single_mask[b:d, a:c] = 255

        ow, oh = original_image_size
        if tuple(padded_size) == (ow, oh):
            restored = orig_np.copy()
        else:
            padded_w, padded_h = padded_size
            restored = np.full(
                (padded_h, padded_w, 3),
                np.asarray(fill_color, dtype=np.uint8),
                dtype=np.uint8
            )
            restored[pad_top:pad_top + oh, pad_left:pad_left + ow] = orig_np

        padded_original = restored.copy()
        if auto_seam:
            weights = self._cached_auto_seam_weights(crop_info, single_mask, crop_width, crop_height)
            if seam_data is not None:
                seam_data["mask"] = weights * 255
                seam_data["reference_mask"] = weights * 255
            if color_options is not None:
                resized_processed = self._match_edge_color_numpy(
                    resized_processed, padded_original[y1:y1+crop_height, x1:x1+crop_width],
                    weights * 255, crop_info, color_options, color_state)
            alpha = weights[..., None]
            original_crop = padded_original[y1:y1+crop_height, x1:x1+crop_width]
            restored[y1:y1+crop_height, x1:x1+crop_width] = np.clip(
                resized_processed * alpha + original_crop * (1-alpha), 0, 255).astype(np.uint8)
        elif single_mask is not None:
            restored = self._apply_mask_blend(
                restored,
                resized_processed,
                padded_original,
                original_coords,
                single_mask,
                blur_amount,
                mask_expand,
                color_options, color_state, crop_info, seam_data, resize_mode, bbox_seam=rect is not None
            )
        else:
            restored[y1:y1 + crop_height, x1:x1 + crop_width] = resized_processed
            if blur_amount > 0 or mask_expand != 0 or color_options is not None:
                restored = self._apply_bbox_edge_blur(
                    restored,
                    padded_original,
                    original_coords,
                    blur_amount,
                    mask_expand,
                    color_options, color_state, crop_info, seam_data
                )

        if pad_left > 0 or pad_top > 0 or pad_right > 0 or pad_bottom > 0:
            restored = restored[pad_top:pad_top + oh, pad_left:pad_left + ow]

        if seam_data is not None and seam_preview:
            seam_data["preview"] = self._seam_preview_numpy(restored, crop_info, seam_data)
        return restored

    def _cached_auto_seam_weights(self, info, mask, width, height):
        geometry = tuple((name, tuple(info[name]) if info.get(name) is not None else None)
                         for name in ("original_coords", "pad_info", "original_image_size", "subject_box", "seam_box"))
        key = (geometry, info.get("min_margin"), width, height, None if mask is None else
               (mask.shape, hashlib.blake2b(np.ascontiguousarray(mask).tobytes(), digest_size=16).digest()))
        cached = getattr(self, "_auto_weight_cache", None)
        if cached is not None and cached[0] == key:
            return cached[1]
        weights = self._auto_seam_weights(info, mask, width, height)
        self._auto_weight_cache = (key, weights)
        return weights

    @classmethod
    def _auto_seam_weights(cls, info, mask, width, height):
        """Outward-only smooth transition, constrained by actual crop/image edges."""
        from scipy.ndimage import distance_transform_edt
        x0, y0, x1, y1 = info["original_coords"]
        left, top, _, _ = info["pad_info"]
        ow, oh = info["original_image_size"]
        yy, xx = np.ogrid[:height, :width]
        # Only boundaries inside the real image need a seam. Physical image
        # boundaries cannot reveal an unprocessed neighbour and stay solid.
        edge = np.full((height, width), np.inf, dtype=np.float32)
        for active, distance in ((x0 > left, xx), (x1 < left+ow, width-1-xx),
                                 (y0 > top, yy), (y1 < top+oh, height-1-yy)):
            if active:
                edge = np.minimum(edge, distance)
        if mask is not None:
            soft = cls._resize_numpy(mask, width, height).astype(np.float32) / 255
            core = soft > 1/255
        else:
            box = info.get("subject_box") or info.get("seam_box")
            core = np.zeros((height, width), dtype=bool)
            if box is None:
                # Legacy crop metadata has no subject location: protect an
                # inset rectangle and feather only a conservative outer band.
                inset = max(1, round(min(width, height) * .08))
                core[inset:max(inset+1,height-inset), inset:max(inset+1,width-inset)] = True
            else:
                a,b,c,d = box
                a,b,c,d = a+left-x0,b+top-y0,c+left-x0,d+top-y0
                core[max(0,b):min(height,d), max(0,a):min(width,c)] = True
            soft = core.astype(np.float32)
        if not core.any():
            return np.zeros((height, width), dtype=np.float32)
        if mask is None:
            ys, xs = np.where(core)
            dx = np.maximum(np.maximum(xs.min()-xx, xx-xs.max()), 0)
            dy = np.maximum(np.maximum(ys.min()-yy, yy-ys.max()), 0)
            distance = np.hypot(dx, dy).astype(np.float32)
        else:
            distance = distance_transform_edt(~core).astype(np.float32)
        # Use the entire locally available corridor from subject to crop edge.
        # The subject itself is protected by core=1; reserving another interior
        # plateau or capping by subject size would unnecessarily shorten feathering.
        # Physical image edges have infinite clearance and require no transition.
        margin = max(0., float(info.get("min_margin", 0)))
        if margin > 0:
            # Feather outward from the protected region for 90% of the requested
            # margin; leave the final 10% as untouched original pixels. Extra
            # ratio/alignment padding must not widen the transition.
            reserve = margin * .1
            span = np.minimum(margin * .9, np.maximum(0, distance + edge - reserve))
            t = np.clip(distance / np.maximum(span, 1e-6), 0, 1)
            # Physical frame boundaries are not seams.
            t = np.where(np.isinf(edge), 0, t)
        else:
            # Legacy crop records carry no requested margin.
            span = distance + edge
            t = np.clip(distance / np.maximum(span, 1e-6), 0, 1)
        weights = 1 - t*t*(3-2*t)
        weights = np.maximum(weights, soft)
        weights[core] = 1
        return weights.astype(np.float32)

    def restore_image(self, original_image, processed_image, crop_box, blur_amount=0, mask_expand=0, mask=None, compute_device="GPU", edge_color_match=False, color_band_width=16, color_match_strength=0.5, color_correction_range=128, color_temporal_smooth=0.8, resize_mode="Pillow Lanczos", seam_preview=False, auto_seam=True):
        # Retired controls remain accepted for old API callers; seams are always automatic.
        auto_seam = True
        blur_amount = mask_expand = 0
        resize_mode = "Pillow Lanczos"
        color_options = (color_band_width, color_match_strength, color_correction_range, color_temporal_smooth) if edge_color_match and color_match_strength > 0 else None
        if compute_device != "CPU" and torch.cuda.is_available():
            try:
                return self._restore_gpu(original_image, processed_image, crop_box, blur_amount, mask_expand, mask, color_options, resize_mode, seam_preview)
            except torch.cuda.OutOfMemoryError:
                logging.warning("ATR GPU 显存不足，回退到 CPU；可将计算设备设为 CPU。")
        batch_size = original_image.shape[0]

        if "batch_size" in crop_box:
            crop_infos = crop_box["crop_infos"]
        else:
            crop_infos = [crop_box] * batch_size

        orig8 = np.clip(original_image.cpu().numpy() * 255, 0, 255).astype(np.uint8)
        proc8 = np.clip(processed_image.cpu().numpy() * 255, 0, 255).astype(np.uint8)
        # 兼容上游 4 通道(RGBA)图像：截断为 3 通道 RGB，避免混合时广播形状不匹配
        if orig8.ndim == 4 and orig8.shape[-1] == 4:
            orig8 = orig8[..., :3]
        if proc8.ndim == 4 and proc8.shape[-1] == 4:
            proc8 = proc8[..., :3]

        mask8 = None
        mask_batched = False
        if mask is not None:
            m = np.clip(mask.cpu().numpy() * 255, 0, 255).astype(np.uint8)
            if m.ndim == 4:  # (B,H,W,1)：去掉单通道
                m = m[..., 0]
            mask_batched = m.ndim == 3  # (B,H,W)；否则 (H,W) 单遮罩
            mask8 = m

        output_images = []
        previews = []
        color_state = [None]
        for i in range(batch_size):
            orig_np = orig8[i] if i < orig8.shape[0] else orig8[0]
            proc_np = proc8[i] if i < proc8.shape[0] else proc8[0]
            crop_info = crop_infos[i] if i < len(crop_infos) else crop_infos[0]

            single_mask = None
            if mask8 is not None:
                single_mask = mask8[i if i < mask8.shape[0] else 0] if mask_batched else mask8

            seam_data = {} if seam_preview else None
            restored = self._restore_single_image(
                orig_np, proc_np, crop_info, blur_amount, mask_expand, single_mask, color_options, color_state, seam_data, resize_mode, seam_preview, auto_seam
            )
            output_images.append(restored.astype(np.float32) / 255.0)
            if seam_preview:
                previews.append(seam_data["preview"].astype(np.float32) / 255.0)

        output_image = torch.from_numpy(np.stack(output_images, axis=0))
        return (output_image, torch.from_numpy(np.stack(previews, axis=0)) if seam_preview else output_image)

    def _seam_preview_numpy(self, restored, crop_info, seam_data):
        original_coords = crop_info["original_coords"]
        padded_size = crop_info["padded_size"]
        ow, oh = crop_info["original_image_size"]
        pad_left, pad_top, _, _ = crop_info["pad_info"]
        crop_width = original_coords[2] - original_coords[0]
        crop_height = original_coords[3] - original_coords[1]
        x1, y1, x2, y2 = original_coords
        final_mask = seam_data.get("mask", np.full((crop_height, crop_width), 255, dtype=np.uint8))
        alpha = final_mask.astype(np.float32) / 255.0
        support = torch.from_numpy((alpha >= 0.5).astype(np.float32))[None, None]
        padded = self._color_pad(support, 1, crop_info)
        inner = -F.max_pool2d(-padded, 3, stride=1)
        border = (support - inner)[0, 0].numpy()
        weight = np.maximum(4 * alpha * (1 - alpha), border)
        # Only the crop contains processed pixels; remove padding like the image output.
        full_weight = np.zeros((padded_size[1], padded_size[0]), dtype=np.float32)
        full_weight[y1:y2, x1:x2] = weight
        full_weight = full_weight[pad_top:pad_top + oh, pad_left:pad_left + ow]
        tint = full_weight[..., None] * 0.65
        preview = (restored * (1 - tint) + np.array([255, 32, 32]) * tint).astype(np.uint8)
        reference_mask = seam_data.get("reference_mask", final_mask)
        reference_support = torch.from_numpy((reference_mask >= 128).astype(np.float32))[None, None]
        reference_padded = self._color_pad(reference_support, 1, crop_info)
        reference_inner = -F.max_pool2d(-reference_padded, 3, stride=1)
        reference_border = (reference_support - reference_inner)[0, 0].numpy() > 0
        full_reference = np.zeros((padded_size[1], padded_size[0]), dtype=bool)
        full_reference[y1:y2, x1:x2] = reference_border
        full_reference = full_reference[pad_top:pad_top + oh, pad_left:pad_left + ow]
        preview[full_reference] = (32, 128, 255)
        return preview

    @staticmethod
    def _color_pad(support, radius, crop_info):
        x1, y1, x2, y2 = crop_info["original_coords"]
        left, top, _, _ = crop_info["pad_info"]
        ow, oh = crop_info["original_image_size"]
        padded = F.pad(support, (radius, radius, radius, radius), value=1)
        # 实际图像边界没有回贴接缝；只有位于原图内部的裁剪边缘补零。
        if x1 > left:
            padded[..., :radius] = 0
        if x2 < left + ow:
            padded[..., -radius:] = 0
        if y1 > top:
            padded[..., :radius, :] = 0
        if y2 < top + oh:
            padded[..., -radius:, :] = 0
        return padded

    @staticmethod
    def _estimate_seam_color(y, target, chroma, base):
        """Bounded paired fit with a persistent prior for unchanged background."""
        neutral = y.new_tensor([1., 0., 0., 0.])
        if y.numel() < 32 or base.sum() < 1e-6:
            return None

        def fit(weights):
            total = weights.sum().clamp_min(1e-6)
            mean_y = (y*weights).sum()/total
            mean_t = (target*weights).sum()/total
            variance = ((y-mean_y).square()*weights).sum()/total
            covariance = ((y-mean_y)*(target-mean_t)*weights).sum()/total
            gain = ((covariance+16)/(variance+16)).clamp(.8, 1.25)
            shift = (mean_t-gain*mean_y).clamp(-24, 24)
            tint = ((chroma*weights[:, None]).sum(0)/total).clamp(-16,16)
            residual = ((target-gain*y-shift).square() +
                        (chroma-tint).square().mean(1)).sqrt()
            return torch.stack((gain,shift,tint[0],tint[1])), residual

        _, initial_residual = fit(base)
        identity_residual = ((target-y).square()+chroma.square().mean(1)).sqrt()
        support = (base*(identity_residual<10)).sum()/base.sum()
        initial_error = (initial_residual*base).sum()/base.sum()
        # Do not let a large replaced foreground choose the initial model and
        # later re-enter as an inlier. A clean global exposure shift still uses
        # all paired samples, including its shadow/highlight range.
        prior = ((1-(identity_residual/20).square()).clamp_min(0).square()
                 if support > .2 and initial_error > 4 else torch.ones_like(base))
        weights = base*prior
        for _ in range(5):
            _, residual = fit(weights)
            selected = residual[weights>0.01]
            if selected.numel()<24:
                return None
            median = selected.median()
            mad = (selected-median).abs().median()
            cutoff = (median+3*1.4826*mad).clamp(4,28)
            weights = base*prior*(1-(residual/cutoff).square()).clamp_min(0).square()
        current, residual = fit(weights)  # Refit using the final accepted weights.
        ratio = weights.sum()/base.sum()
        error = (residual*weights).sum()/weights.sum().clamp_min(1e-6)
        if (weights>.05).sum()<24 or ratio<.1 or error>=16:
            return None
        confidence = (ratio/.7).clamp(0,1)
        return neutral+(current-neutral)*confidence

    @staticmethod
    def _seam_scene_cut(source, reference, previous):
        """Use full-crop structure in both streams, independent of sample masks."""
        if previous is None:
            return False
        changed = []
        for current, old in ((source,previous['source']),
                             (reference,previous['reference'])):
            raw = (current-old).abs().mean()
            # Normalizing each channel removes simple exposure/tint changes.
            def structure(value):
                value = value-value.mean((-2,-1),keepdim=True)
                return value/value.square().mean((-2,-1),keepdim=True).sqrt().clamp_min(8)
            difference = (structure(current)-structure(old)).abs().mean()
            changed.append(bool(raw>40 and difference>.65))
        return all(changed)

    def _match_edge_color(self, processed, original, mask, crop_info, options, state):
        band, strength, reach, smoothing = options
        height, width = processed.shape[-2:]
        alpha = torch.ones_like(processed[:, :1]) if mask is None else mask / 255
        support = (alpha >= 0.5).to(processed.dtype)
        transition = 4 * alpha * (1 - alpha)
        x1, y1, _, _ = crop_info["original_coords"]
        left, top, _, _ = crop_info["pad_info"]
        ow, oh = crop_info["original_image_size"]
        rows = torch.arange(height, device=processed.device) + y1
        cols = torch.arange(width, device=processed.device) + x1
        valid_region = ((rows >= top) & (rows < top + oh))[:, None] & ((cols >= left) & (cols < left + ow))[None, :]
        support = torch.where(valid_region, support, 1)
        # Sample the actual middle of the transition, automatically following
        # local feather width. Fully retained content never enters the fit.
        ring = ((alpha > .15) & (alpha < .85)).to(processed.dtype) * valid_region
        # Estimate in luma/chroma coordinates; fit only paired seam pixels.
        luma = processed.new_tensor([.299, .587, .114]).reshape(1, 3, 1, 1)
        src_y = (processed * luma).sum(1, keepdim=True)
        ref_y = (original * luma).sum(1, keepdim=True)
        src_c = processed[:, [0, 2]] - src_y
        ref_c = original[:, [0, 2]] - ref_y
        usable = (src_y > 5) & (src_y < 250) & (ref_y > 5) & (ref_y < 250)
        samples = ring * (0.1 + 0.9 * transition) * usable
        params = []
        previous = state[0]
        source_signature = F.adaptive_avg_pool2d(processed, (12,12))
        reference_signature = F.adaptive_avg_pool2d(original, (12,12))
        neutral = processed.new_tensor([1.,0.,0.,0.])
        for i in range(processed.shape[0]):
            chosen = samples[i,0]>0
            y = src_y[i,0][chosen]
            target = ref_y[i,0][chosen]
            chroma = (ref_c[i]-src_c[i])[:,chosen].T
            base = samples[i,0][chosen]
            stride = max(1, math.ceil(y.numel()/8192))
            y,target,chroma,base = y[::stride],target[::stride],chroma[::stride],base[::stride]
            current = self._estimate_seam_color(y,target,chroma,base)
            source, reference = source_signature[i], reference_signature[i]
            cut = self._seam_scene_cut(source,reference,previous)
            old = None if previous is None or cut or smoothing==0 else previous['params']
            missing = 0
            if current is None:
                missing = 1 if previous is None or cut else previous['missing']+1
                if old is not None:
                    # Same causal policy for CPU frames and GPU chunks: hold
                    # short losses, then fade gradually instead of switching off.
                    current = old if missing<=6 else torch.lerp(old,neutral,.25)
            elif old is not None:
                current = old*smoothing+current*(1-smoothing)
            previous = dict(params=None if current is None else current.detach(),
                            missing=missing,source=source.detach(),reference=reference.detach())
            params.append(neutral if current is None else current)
        state[0] = previous
        parameters = torch.stack(params)
        gain = parameters[:, 0, None, None, None]
        shift = parameters[:, 1, None, None, None]
        tint = parameters[:, 2:, None, None]
        delta_y = src_y * (gain-1) + shift
        dr, db = tint[:, :1], tint[:, 1:]
        dg = -(.299*dr + .114*db)/.587
        correction = delta_y + torch.cat((dr, dg, db), dim=1)
        # A bounded smooth envelope vanishes at both ends; no independent
        # spatial filter can introduce a step at the protected interior.
        weight = transition.square() * valid_region
        return (processed + correction * weight * strength).round().clamp_(0, 255)

    def _match_edge_color_numpy(self, processed, original, final_mask, crop_info, options, state):
        processed_tensor = torch.from_numpy(processed.astype(np.float32)).movedim(-1, 0).unsqueeze(0)
        original_tensor = torch.from_numpy(original.astype(np.float32)).movedim(-1, 0).unsqueeze(0)
        mask_tensor = torch.from_numpy(final_mask.astype(np.float32))[None, None]
        result = self._match_edge_color(processed_tensor, original_tensor, mask_tensor, crop_info, options, state)
        return result[0].movedim(0, -1).numpy().astype(np.uint8)

    @classmethod
    def _prepare_gpu_input(cls, image, width, height, resize_mode, device):
        if resize_mode != "Lanczos4 (legacy)" and image.shape[1:3] != (height, width):
            # Pillow 在 CPU 缩放后再上传，避免 GPU/CPU 之间来回传输。
            arrays = image.cpu().numpy()
            def resize_frame(frame):
                array = np.clip(frame * 255, 0, 255).astype(np.uint8)
                if array.shape[-1] == 1:
                    resized = cls._resize_numpy(array[..., 0], width, height, resize_mode)[..., None]
                else:
                    resized = cls._resize_numpy(array, width, height, resize_mode)
                return resized
            if len(arrays) > 1:
                with ThreadPoolExecutor(max_workers=min(8, len(arrays))) as pool:
                    frames = list(pool.map(resize_frame, arrays))
            else:
                frames = [resize_frame(arrays[0])]
            return torch.from_numpy(np.stack(frames)).to(device=device, dtype=torch.float32).movedim(-1, 1)
        return (image.to(device=device, dtype=torch.float32).movedim(-1, 1) * 255).clamp_(0, 255).floor_()

    @classmethod
    def _gpu_resize(cls, image, width, height, resize_mode="Lanczos4 (legacy)"):
        if image.shape[-2:] == (height, width):
            return image
        if resize_mode != "Lanczos4 (legacy)" and (width < image.shape[-1] or height < image.shape[-2]):
            frames = []
            for frame in image:
                array = frame.movedim(0, -1).clamp(0, 255).byte().cpu().numpy()
                if array.shape[-1] == 1:
                    resized = cls._resize_numpy(array[..., 0], width, height, resize_mode)[..., None]
                else:
                    resized = cls._resize_numpy(array, width, height, resize_mode)
                frames.append(torch.from_numpy(resized.copy()).movedim(-1, 0))
            return torch.stack(frames).to(device=image.device, dtype=image.dtype)
        # OpenCV 使用 Lanczos4；按两个轴分别执行 8 tap 插值，避免生成大采样张量。
        for axis, size in ((-1, width), (-2, height)):
            old_size = image.shape[axis]
            if old_size == size:
                continue
            coords = (torch.arange(size, device=image.device, dtype=torch.float32) + 0.5) * (old_size / size) - 0.5
            base = coords.floor().long()
            offsets = torch.arange(-3, 5, device=image.device)
            indices = base[:, None] + offsets[None, :]
            distance = coords[:, None] - indices
            weights = torch.sinc(distance) * torch.sinc(distance / 4)
            weights = weights / weights.sum(dim=1, keepdim=True)
            weight_shape = [1] * image.ndim
            weight_shape[axis] = size
            resized = None
            for tap in range(8):
                values = image.index_select(axis, indices[:, tap].clamp(0, old_size - 1))
                values = values * weights[:, tap].reshape(weight_shape)
                resized = values if resized is None else resized + values
            image = resized
        return image.round().clamp_(0, 255)

    @staticmethod
    def _gpu_gaussian(mask, radius):
        if radius == 0:
            return mask
        weights = torch.as_tensor(cv2.getGaussianKernel(radius * 2 + 1, 0).ravel(), device=mask.device, dtype=torch.float32)
        for axis in (-1, -2):
            length = mask.shape[axis]
            indices = torch.arange(-radius, length + radius, device=mask.device)
            if length == 1:
                indices = torch.zeros_like(indices)
            else:
                period = 2 * (length - 1)
                indices = indices.remainder(period)
                indices = torch.minimum(indices, period - indices)
            padded = mask.index_select(axis, indices)
            kernel = weights.reshape(1, 1, 1, -1) if axis == -1 else weights.reshape(1, 1, -1, 1)
            mask = F.conv2d(padded, kernel)
        return mask.round().clamp_(0, 255)

    @staticmethod
    def _gpu_erode(mask, radius):
        if radius == 0:
            return mask
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (radius * 2 + 1,) * 2)
        offsets = {}
        for row, values in enumerate(kernel):
            offsets.setdefault(int(np.count_nonzero(values)), []).append(row - radius)
        result = torch.full_like(mask, 255)
        height = mask.shape[-2]
        for width, rows in offsets.items():
            horizontal = -F.max_pool2d(-mask, (1, width), stride=1, padding=(0, width // 2))
            for offset in rows:
                start, end = max(0, -offset), min(height, height - offset)
                if start < end:
                    region = result[:, :, start:end]
                    torch.minimum(region, horizontal[:, :, start + offset:end + offset], out=region)
        return result

    @staticmethod
    def _gpu_dilate(mask, radius):
        if radius == 0:
            return mask
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (radius * 2 + 1,) * 2)
        offsets = {}
        for row, values in enumerate(kernel):
            offsets.setdefault(int(np.count_nonzero(values)), []).append(row - radius)
        result = torch.zeros_like(mask)
        height = mask.shape[-2]
        for width, rows in offsets.items():
            horizontal = F.max_pool2d(mask, (1, width), stride=1, padding=(0, width // 2))
            for offset in rows:
                start, end = max(0, -offset), min(height, height - offset)
                if start < end:
                    region = result[:, :, start:end]
                    torch.maximum(region, horizontal[:, :, start + offset:end + offset], out=region)
        return result

    def _restore_gpu_chunk(self, original, processed, crop_info, radius, mask_expand, mask, color_options=None, color_state=None, seam_data=None, resize_mode="Pillow Lanczos", auto_seam=False):
        x1, y1, x2, y2 = crop_info["original_coords"]
        width, height = x2 - x1, y2 - y1
        ow, oh = crop_info["original_image_size"]
        pw, ph = crop_info["padded_size"]
        left, top, _, _ = crop_info["pad_info"]
        processed = self._gpu_resize(processed, width, height, resize_mode)
        rect = self._seam_rect(crop_info) if mask is None else None
        if rect is not None:
            a, b, c, d = rect
            mask = torch.zeros((1, 1, height, width), device=original.device)
            mask[:, :, b:d, a:c] = 255
        if (pw, ph) == (ow, oh):
            restored = original.clone()
        else:
            color = torch.as_tensor(crop_info.get("fill_color", (255, 255, 255)), device=original.device, dtype=torch.float32)
            restored = color.reshape(1, 3, 1, 1).expand(original.shape[0], 3, ph, pw).clone()
            restored[:, :, top:top + oh, left:left + ow] = original
        if auto_seam:
            weights = []
            for i in range(processed.shape[0]):
                source = None if mask is None else mask[min(i, len(mask)-1), 0].clamp(0,255).byte().cpu().numpy()
                weights.append(torch.from_numpy(self._cached_auto_seam_weights(crop_info, source, width, height)))
            alpha = torch.stack(weights).unsqueeze(1).to(original.device)
            if color_options is not None:
                processed = self._match_edge_color(processed, restored[:, :, y1:y2, x1:x2],
                                                   alpha*255, crop_info, color_options, color_state)
            if seam_data is not None:
                seam_data["mask"] = alpha*255
                seam_data["reference_mask"] = alpha*255
            region = restored[:, :, y1:y2, x1:x2]
            region[:] = (processed*alpha + region*(1-alpha)).floor().clamp_(0,255)
            return restored[:, :, top:top+oh, left:left+ow].movedim(1,-1)/255
        if mask is not None:
            mask = self._gpu_resize(mask, width, height, resize_mode)
        if mask is not None:
            seam_margin = abs(mask_expand) + radius + 1 if rect is not None else 0
            if seam_margin:
                mask = self._pad_seam_mask(mask, seam_margin, crop_info)
            reference_mask = self._gpu_gaussian(mask, radius) if seam_data is not None else None
            if mask_expand > 0:
                mask = self._gpu_dilate(mask, mask_expand)
            elif mask_expand < 0:
                mask = self._gpu_erode(mask, -mask_expand)
            mask = self._gpu_gaussian(mask, radius)
            if seam_margin:
                mask = mask[..., seam_margin:-seam_margin, seam_margin:-seam_margin]
                if reference_mask is not None:
                    reference_mask = reference_mask[..., seam_margin:-seam_margin, seam_margin:-seam_margin]
            if color_options is not None:
                processed = self._match_edge_color(processed, restored[:, :, y1:y2, x1:x2], mask, crop_info, color_options, color_state)
            if seam_data is not None:
                seam_data["mask"] = mask
                seam_data["reference_mask"] = reference_mask
            mask = mask / 255
            original_crop = restored[:, :, y1:y2, x1:x2]
            original_crop[:] = (processed * mask + original_crop * (1 - mask)).floor().clamp_(0, 255)
        else:
            margin = abs(mask_expand) + radius + 1
            rx1, ry1 = max(0, x1 - margin), max(0, y1 - margin)
            rx2, ry2 = min(pw, x2 + margin), min(ph, y2 + margin)
            roi = restored[:, :, ry1:ry2, rx1:rx2]
            original_roi = roi.clone()
            weights = torch.zeros((1, 1, ry2 - ry1, rx2 - rx1), device=original.device)
            if seam_data is not None:
                reference = torch.zeros_like(weights)
                reference[:, :, y1 - ry1:y2 - ry1, x1 - rx1:x2 - rx1] = 255
                reference = self._gpu_gaussian(reference, radius)
                seam_data["reference_mask"] = reference[:, :, y1 - ry1:y2 - ry1, x1 - rx1:x2 - rx1]
            # 二值矩形的腐蚀可直接收缩坐标；贴着实际图像边界的一侧不收缩。
            ex1 = x1 - mask_expand if x1 > 0 else 0
            ey1 = y1 - mask_expand if y1 > 0 else 0
            ex2 = x2 + mask_expand if x2 < pw else pw
            ey2 = y2 + mask_expand if y2 < ph else ph
            if mask_expand > 0:
                # Match CPU's elliptical dilation, including rounded rectangle corners.
                weights[:, :, y1 - ry1:y2 - ry1, x1 - rx1:x2 - rx1] = 255
                weights = self._gpu_dilate(weights, mask_expand)
            elif ex1 < ex2 and ey1 < ey2:
                weights[:, :, ey1 - ry1:ey2 - ry1, ex1 - rx1:ex2 - rx1] = 255
            weights = self._gpu_gaussian(weights, radius)
            if color_options is not None:
                final_mask = weights[:, :, y1 - ry1:y2 - ry1, x1 - rx1: x2 - rx1]
                processed = self._match_edge_color(processed, restored[:, :, y1:y2, x1:x2], final_mask, crop_info, color_options, color_state)
            roi[:, :, y1 - ry1:y2 - ry1, x1 - rx1:x2 - rx1] = processed
            if seam_data is not None:
                seam_data["mask"] = weights[:, :, y1 - ry1:y2 - ry1, x1 - rx1:x2 - rx1]
            weights = weights / 255
            roi[:] = (roi * weights + original_roi * (1 - weights)).floor().clamp_(0, 255)
        return restored[:, :, top:top + oh, left:left + ow].movedim(1, -1) / 255

    def _restore_gpu(self, original_image, processed_image, crop_box, blur_amount, mask_expand, mask, color_options=None, resize_mode="Pillow Lanczos", seam_preview=True):
        device = original_image.device if original_image.is_cuda else torch.device("cuda")
        batch_size = original_image.shape[0]
        infos = crop_box["crop_infos"] if "batch_size" in crop_box else [crop_box]
        if mask is not None:
            if mask.ndim == 4:
                mask = mask[..., 0]
            if mask.ndim == 2:
                mask = mask.unsqueeze(0)
        output = torch.empty((*original_image.shape[:3], 3), dtype=torch.float32, device="cpu")
        previews = torch.empty_like(output) if seam_preview else output
        start = 0
        color_state = [None]
        while start < batch_size:
            info = infos[start] if start < len(infos) else infos[0]
            # 仅将连续相同裁剪框合批，保留移动裁剪框的帧顺序。
            pw, ph = info["padded_size"]
            x1, y1, x2, y2 = info["original_coords"]
            frame_pixels = max(pw * ph, processed_image.shape[1] * processed_image.shape[2],
                               processed_image.shape[1] * (x2 - x1), (y2 - y1) * (x2 - x1))
            free_bytes = torch.cuda.mem_get_info(device)[0]
            chunk_size = max(1, min(8, int(free_bytes * 0.25) // (frame_pixels * 128)))
            end = start + 1
            while end < min(start + chunk_size, batch_size) and (infos[end] if end < len(infos) else infos[0]) == info:
                end += 1
            original = original_image[start:end, ..., :3].to(device=device, dtype=torch.float32).movedim(-1, 1)
            proc_indices = [i if i < processed_image.shape[0] else 0 for i in range(start, end)]
            processed = processed_image[start:end, ..., :3] if end <= processed_image.shape[0] else processed_image[proc_indices, ..., :3]
            padded_processed_size = processed.shape[1:3]
            processed = (self._restore_valid_crop(processed, info, resize_mode) if "output_valid_box" in info
                         else self._remove_output_padding(processed, info))
            processed = self._prepare_gpu_input(processed, x2 - x1, y2 - y1, resize_mode, device)
            original = (original * 255).clamp_(0, 255).floor_()
            chunk_mask = None
            if mask is not None:
                mask_indices = [i if i < mask.shape[0] else 0 for i in range(start, end)]
                source_mask = mask[mask_indices].unsqueeze(-1)
                if source_mask.shape[1:3] == padded_processed_size:
                    source_mask = (self._restore_valid_crop(source_mask, info, resize_mode) if "output_valid_box" in info
                                   else self._remove_output_padding(source_mask, info))
                chunk_mask = self._prepare_gpu_input(source_mask, x2 - x1, y2 - y1, resize_mode, device)
            seam_data = {} if seam_preview else None
            result = self._restore_gpu_chunk(original, processed, info, blur_amount, mask_expand, chunk_mask, color_options, color_state, seam_data, resize_mode, auto_seam=True)
            output[start:end] = result.cpu()
            if seam_preview:
                masks = {key: value.cpu().numpy() for key, value in seam_data.items()}
                for index in range(end - start):
                    frame_data = {key: value[min(index, value.shape[0] - 1), 0] for key, value in masks.items()}
                    frame = (output[start + index].numpy() * 255).round().astype(np.uint8)
                    previews[start + index] = torch.from_numpy(self._seam_preview_numpy(frame, info, frame_data).astype(np.float32) / 255)
            start = end
        return (output, previews)

    def _erode_mask(self, mask, radius):
        # 将椭圆核按行拆为水平线段，保持原椭圆腐蚀结果。
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (radius * 2 + 1,) * 2)
        row_offsets = {}
        for row, values in enumerate(kernel):
            width = int(np.count_nonzero(values))
            row_offsets.setdefault(width, []).append(row - radius)
        result = np.full_like(mask, 255)
        height = mask.shape[0]
        for width, offsets in row_offsets.items():
            horizontal = cv2.erode(mask, np.ones((1, width), dtype=np.uint8))
            for offset in offsets:
                start = max(0, -offset)
                end = min(height, height - offset)
                if start < end:
                    np.minimum(result[start:end], horizontal[start + offset:end + offset], out=result[start:end])
        return result

    def _apply_mask_blend(self, restored_np, processed_np, original_np, crop_coords, input_mask, blur_amount, mask_expand, color_options=None, color_state=None, crop_info=None, seam_data=None, resize_mode="Pillow Lanczos", bbox_seam=False):
        x1, y1, x2, y2 = crop_coords
        crop_width = x2 - x1
        crop_height = y2 - y1

        # input_mask 已是 (H,W) uint8，resize 到裁剪尺寸
        mask_np = self._resize_numpy(input_mask, crop_width, crop_height, resize_mode)
        seam_margin = abs(mask_expand) + blur_amount + 1 if bbox_seam else 0
        if seam_margin:
            mask_np = self._pad_seam_mask(mask_np, seam_margin, crop_info)
        if seam_data is not None:
            reference = mask_np.copy()
            if blur_amount > 0:
                reference = cv2.GaussianBlur(reference, (blur_amount * 2 + 1,) * 2, 0)
            if seam_margin:
                reference = reference[seam_margin:-seam_margin, seam_margin:-seam_margin]
            seam_data["reference_mask"] = reference


        if mask_expand != 0:
            abs_expand = abs(mask_expand)
            if mask_expand > 0:
                kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (abs_expand * 2 + 1, abs_expand * 2 + 1))
                mask_np = cv2.dilate(mask_np, kernel, iterations=1)
            else:
                mask_np = self._erode_mask(mask_np, abs_expand)

        if blur_amount > 0:
            kernel_size = blur_amount * 2 + 1
            mask_np = cv2.GaussianBlur(mask_np, (kernel_size, kernel_size), 0)

        if seam_margin:
            mask_np = mask_np[seam_margin:-seam_margin, seam_margin:-seam_margin]

        if seam_data is not None:
            seam_data["mask"] = mask_np
        if color_options is not None:
            processed_np = self._match_edge_color_numpy(processed_np, original_np[y1:y2, x1:x2], mask_np, crop_info, color_options, color_state)

        mask_float = mask_np.astype(np.float32) / 255.0
        mask_3ch = np.stack([mask_float] * 3, axis=-1)

        original_crop = original_np[y1:y2, x1:x2].astype(np.float32)
        blended_crop = (
            processed_np.astype(np.float32) * mask_3ch
            + original_crop * (1 - mask_3ch)
        ).astype(np.uint8)
        restored_np[y1:y2, x1:x2] = blended_crop

        return restored_np

    def _apply_bbox_edge_blur(self, restored_np, original_np, crop_coords, blur_amount, mask_expand, color_options=None, color_state=None, crop_info=None, seam_data=None):
        x1, y1, x2, y2 = crop_coords
        img_h, img_w = restored_np.shape[:2]

        # 留足收缩/扩展和模糊的边界，触及原图边缘时保留 OpenCV 的边界行为。
        margin = abs(mask_expand) + blur_amount + 1
        roi_x1, roi_y1 = max(0, x1 - margin), max(0, y1 - margin)
        roi_x2, roi_y2 = min(img_w, x2 + margin), min(img_h, y2 + margin)
        bbox_mask = np.zeros((roi_y2 - roi_y1, roi_x2 - roi_x1), dtype=np.uint8)
        bbox_mask[y1 - roi_y1:y2 - roi_y1, x1 - roi_x1:x2 - roi_x1] = 255
        if seam_data is not None:
            reference = bbox_mask.copy()
            if blur_amount > 0:
                reference = cv2.GaussianBlur(reference, (blur_amount * 2 + 1,) * 2, 0)
            seam_data["reference_mask"] = reference[y1 - roi_y1:y2 - roi_y1, x1 - roi_x1:x2 - roi_x1]


        if mask_expand != 0:
            abs_expand = abs(mask_expand)
            # 矩形遮罩的腐蚀结果与椭圆核相同，矩形核可使用快速可分离算法。
            kernel_shape = cv2.MORPH_RECT if mask_expand < 0 else cv2.MORPH_ELLIPSE
            kernel = cv2.getStructuringElement(kernel_shape, (abs_expand * 2 + 1, abs_expand * 2 + 1))
            if mask_expand > 0:
                bbox_mask = cv2.dilate(bbox_mask, kernel, iterations=1)
            else:
                bbox_mask = cv2.erode(bbox_mask, kernel, iterations=1)

        if blur_amount > 0:
            kernel_size = blur_amount * 2 + 1
            bbox_mask = cv2.GaussianBlur(bbox_mask, (kernel_size, kernel_size), 0)

        if seam_data is not None:
            seam_data["mask"] = bbox_mask[y1 - roi_y1:y2 - roi_y1, x1 - roi_x1:x2 - roi_x1]
        if color_options is not None:
            final_mask = bbox_mask[y1 - roi_y1:y2 - roi_y1, x1 - roi_x1:x2 - roi_x1]
            restored_np[y1:y2, x1:x2] = self._match_edge_color_numpy(
                restored_np[y1:y2, x1:x2], original_np[y1:y2, x1:x2], final_mask, crop_info, color_options, color_state
            )

        mask_float = bbox_mask.astype(np.float32) / 255.0
        mask_3ch = np.stack([mask_float] * 3, axis=-1)

        restored_roi = restored_np[roi_y1:roi_y2, roi_x1:roi_x2]
        original_roi = original_np[roi_y1:roi_y2, roi_x1:roi_x2]
        restored_roi[:] = (
            restored_roi.astype(np.float32) * mask_3ch
            + original_roi.astype(np.float32) * (1 - mask_3ch)
        ).astype(np.uint8)

        return restored_np


NODE_CLASS_MAPPINGS = {
    "XiaozhuguangATR": XiaozhuguangATR,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XiaozhuguangATR": "ATR · 高级",
}

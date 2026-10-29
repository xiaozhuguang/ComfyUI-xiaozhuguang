"""Mask cleanup and per-frame morphology using standard SciPy operations."""
import numpy as np
import torch


class XiaozhuguangMaskCleanupRepair:
    CATEGORY = "小珠光/图片"
    RETURN_TYPES = ("MASK",)
    RETURN_NAMES = ("mask",)
    FUNCTION = "execute"
    DESCRIPTION = "视频遮罩：先清理碎片和短暂杂点，再修复形状。自动选择CPU/GPU，分批控制显存，处理后返回CPU并释放本节点GPU临时缓存。无输入返回None。"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "cleanup_enabled": ("BOOLEAN", {"default": True}),
                "threshold": ("FLOAT", {"default": 0.3, "min": 0.0, "max": 1.0, "step": 0.01,
                                         "tooltip": "只用于识别清理区域；存活区域保留原遮罩的软边数值。"}),
                "method": (["收缩重建", "连通区域"], {"default": "收缩重建"}),
                "shrink": ("INT", {"default": 4, "min": 1, "max": 128,
                                    "tooltip": "收缩重建的收缩次数；没有存活核心的独立细碎区域被清除，存活区域恢复原轮廓。"}),
                "min_pixels": ("INT", {"default": 32, "min": 1, "max": 1000000,
                                        "tooltip": "仅连通区域模式使用：区域在单帧中的最大面积下限。"}),
                "min_frames": ("INT", {"default": 2, "min": 1, "max": 1000,
                                        "tooltip": "区域至少持续这些帧；单帧自动跳过。连通区域模式中大主体可豁免持续时间要求。1为关闭时间筛选。"}),
                "edge_grow": ("INT", {"default": 4, "min": 0, "max": 128,
                                       "tooltip": "扩展存活区域的保留范围，保护原有软边；不会生成原遮罩中不存在的白色像素。"}),
                "repair_enabled": ("BOOLEAN", {"default": False}),
                "erode_dilate": ("INT", {"default": 0, "min": -128, "max": 128,
                                          "tooltip": "负值收缩、正值膨胀；绝对值为每侧像素半径。"}),
                "fill_holes": ("INT", {"default": 0, "min": 0, "max": 128,
                                        "tooltip": "灰度闭运算的像素半径，修补小孔和窄缺口；不是无条件填满所有封闭孔洞。"}),
                "remove_isolated_pixels": ("INT", {"default": 0, "min": 0, "max": 32,
                                                    "tooltip": "灰度开运算的像素半径，清除细碎区域；可能改变细小轮廓。"}),
                "smooth": ("INT", {"default": 0, "min": 0, "max": 128,
                                    "tooltip": "先以0.5二值化，再高斯平滑；数值为核半径，会改变原有软边。"}),
                "blur": ("INT", {"default": 0, "min": 0, "max": 128,
                                  "tooltip": "直接对灰度遮罩做高斯模糊，数值为核半径。0不处理。"}),
            },
            "optional": {"mask": ("MASK",)},
        }

    @staticmethod
    def _cleanup(values, temporal, threshold, method, shrink, min_pixels, min_frames, edge_grow, ndi):
        binary = values > threshold
        if not binary.any():
            return np.zeros_like(values)
        connectivity = np.ones((3,) * binary.ndim, dtype=bool)
        labels, count = ndi.label(binary, structure=connectivity)
        objects = ndi.find_objects(labels)
        durations = np.zeros(count + 1, dtype=np.int64)
        for index, region in enumerate(objects, 1):
            durations[index] = region[0].stop - region[0].start if temporal else 1
        if method == "收缩重建":
            # Spatial erosion only; time connectivity is used to recover tracks.
            cross = ndi.generate_binary_structure(2, 1)
            core = np.stack([ndi.binary_erosion(frame, structure=cross, iterations=shrink,
                                               border_value=1) for frame in binary]) if temporal else ndi.binary_erosion(
                                                   binary, structure=cross, iterations=shrink, border_value=1)
            keep = np.zeros(count + 1, dtype=bool)
            keep[np.unique(labels[core])] = True
            keep &= durations >= min_frames
        else:
            peak = np.zeros(count + 1, dtype=np.int64)
            for frame in labels if temporal else labels[None]:
                peak = np.maximum(peak, np.bincount(frame.ravel(), minlength=count + 1))
            peak[0] = 0
            substantial = (peak >= peak.max() * 0.5) & (peak > 0)
            keep = (peak >= min_pixels) & ((durations >= min_frames) | substantial)
        keep[0] = False
        selected = keep[labels]
        if edge_grow:
            cross = ndi.generate_binary_structure(2, 1)
            selected = np.stack([ndi.binary_dilation(frame, structure=cross, iterations=edge_grow)
                                 for frame in selected]) if temporal else ndi.binary_dilation(
                                     selected, structure=cross, iterations=edge_grow)
        return values * selected

    @staticmethod
    def _repair_cpu(values, erode_dilate, fill_holes, remove_isolated_pixels, smooth, blur, ndi, check):
        for i, frame in enumerate(values):
            check()
            if erode_dilate < 0:
                frame = ndi.grey_erosion(frame, size=2 * abs(erode_dilate) + 1, mode="nearest")
            elif erode_dilate > 0:
                frame = ndi.grey_dilation(frame, size=2 * erode_dilate + 1, mode="nearest")
            if fill_holes:
                frame = ndi.grey_closing(frame, size=2 * fill_holes + 1, mode="nearest")
            if remove_isolated_pixels:
                frame = ndi.grey_opening(frame, size=2 * remove_isolated_pixels + 1, mode="nearest")
            if smooth:
                frame = ndi.gaussian_filter((frame > 0.5).astype(np.float32), sigma=max(0.5, smooth / 3), radius=smooth, mode="nearest")
            if blur:
                frame = ndi.gaussian_filter(frame, sigma=max(0.5, blur / 3), radius=blur, mode="nearest")
            values[i] = frame
        return values

    @staticmethod
    def _repair_gpu(values, erode_dilate, fill_holes, remove_isolated_pixels, smooth, blur, check):
        import torch.nn.functional as F
        device = torch.device("cuda", torch.cuda.current_device())
        free = torch.cuda.mem_get_info(device)[0]
        height, width = values.shape[1:]
        radius = max(abs(erode_dilate), fill_holes, remove_isolated_pixels, smooth, blur)
        # Bound concurrent padded buffers; do not retain the whole video on GPU.
        frame_bytes = (height + 2 * radius) * (width + 2 * radius) * 4 * 16
        chunk_size = max(1, min(8, int(free * 0.2) // max(1, frame_bytes)))
        result = np.empty_like(values)

        def morph(x, radius, dilate):
            padded = F.pad(x if dilate else -x, (radius,) * 4, mode="replicate")
            filtered = F.max_pool2d(padded, 2 * radius + 1, stride=1)
            return filtered if dilate else -filtered

        def gaussian(x, radius):
            sigma = max(0.5, radius / 3)
            coords = torch.arange(-radius, radius + 1, device=device, dtype=x.dtype)
            kernel = torch.exp(-coords.square() / (2 * sigma * sigma))
            kernel /= kernel.sum()
            x = F.conv2d(F.pad(x, (radius, radius, 0, 0), mode="replicate"), kernel.view(1, 1, 1, -1))
            return F.conv2d(F.pad(x, (0, 0, radius, radius), mode="replicate"), kernel.view(1, 1, -1, 1))

        with torch.inference_mode():
            for start in range(0, len(values), chunk_size):
                check()
                x = torch.from_numpy(values[start:start + chunk_size]).unsqueeze(1).to(device)
                if erode_dilate:
                    x = morph(x, abs(erode_dilate), erode_dilate > 0)
                if fill_holes:
                    x = morph(morph(x, fill_holes, True), fill_holes, False)
                if remove_isolated_pixels:
                    x = morph(morph(x, remove_isolated_pixels, False), remove_isolated_pixels, True)
                if smooth:
                    x = gaussian((x > 0.5).float(), smooth)
                if blur:
                    x = gaussian(x, blur)
                result[start:start + len(x)] = x[:, 0].cpu().numpy()
                del x
        return result

    def execute(self, cleanup_enabled=True, threshold=0.3,
                method="收缩重建", shrink=4, min_pixels=32, min_frames=2, edge_grow=4,
                repair_enabled=False, erode_dilate=0, fill_holes=0,
                remove_isolated_pixels=0, smooth=0, blur=0, mask=None):
        if mask is None or mask.numel() == 0:
            return (None,)
        if not cleanup_enabled and not repair_enabled:
            return (mask,)
        from scipy import ndimage as ndi
        try:
            from comfy.model_management import throw_exception_if_processing_interrupted as check
        except ImportError:
            check = lambda: None
        check()
        source = mask
        if source.ndim == 4 and source.shape[-1] == 1:
            source = source[..., 0]
        if source.ndim == 2:
            source = source.unsqueeze(0)
        if source.ndim != 3:
            raise ValueError("遮罩需要[批次, 高, 宽]或[高, 宽]格式。")
        if method not in ("收缩重建", "连通区域"):
            raise ValueError("未知的遮罩处理模式。")
        values = source.detach().to(device="cpu", dtype=torch.float32).numpy().copy()
        if cleanup_enabled:
            temporal = len(values) > 1
            if temporal:
                values = self._cleanup(values, True, threshold, method, shrink, min_pixels, min_frames, edge_grow, ndi)
            else:
                for i in range(len(values)):
                    check()
                    values[i] = self._cleanup(values[i], False, threshold, method, shrink, min_pixels, 1, edge_grow, ndi)
        if repair_enabled and any((erode_dilate, fill_holes, remove_isolated_pixels, smooth, blur)):
            options = (erode_dilate, fill_holes, remove_isolated_pixels, smooth, blur)
            # Small jobs cost less on CPU than a round trip across PCIe.
            use_gpu = torch.cuda.is_available() and values.size >= 256 * 256
            if use_gpu:
                try:
                    values = self._repair_gpu(values, *options, check)
                    print("[小珠光遮罩清理修复] 修复使用GPU分批处理，输出已转回CPU。")
                except torch.cuda.OutOfMemoryError:
                    print("[小珠光遮罩清理修复] GPU显存不足，回退CPU。")
                    use_gpu = False
                finally:
                    # GPU helper scope has ended; release only unused allocator blocks.
                    torch.cuda.empty_cache()
            if not use_gpu:
                values = self._repair_cpu(values, *options, ndi, check)
        check()
        return (torch.from_numpy(np.clip(values, 0, 1)).to(dtype=mask.dtype),)

"""Track an outline using local regions of the original input frames."""
import math
import time

import cv2
import numpy as np


MAX_STEPS = 600


def track_outline(image, frame_indices, start, end, polygon):
    if (type(start) is not int or type(end) is not int
            or not 0 <= start < len(frame_indices) or not 0 <= end < len(frame_indices) or start == end):
        raise ValueError("请选择有效的跟踪起点和方向")
    if (not isinstance(polygon, list) or not 3 <= len(polygon) <= 4096
            or any(not isinstance(point, list) or len(point) != 2
                   or any(type(v) not in (int, float) or not -16 <= v <= 16 for v in point)
                   for point in polygon)):
        raise ValueError("遮罩轮廓无效，请重新绘制")

    _, height, width, _ = image.shape
    size = np.array([width, height])
    outline = np.asarray(polygon, dtype=np.float64) * size
    accumulated = np.eye(3)
    transforms = []
    reliable = []
    direction = 1 if end > start else -1
    limit = min(abs(end - start), MAX_STEPS)
    deadline = time.monotonic() + 45
    reason = "limit" if limit < abs(end - start) else "complete"
    options = dict(winSize=(21, 21), maxLevel=3)

    def gray(index, bounds, dimensions):
        x0, y0, x1, y1 = bounds
        pixels = image[frame_indices[index], y0:y1, x0:x1, :3].detach().cpu().numpy()
        if dimensions != (x1 - x0, y1 - y0):
            pixels = cv2.resize(pixels.astype(np.float32, copy=False), dimensions, interpolation=cv2.INTER_AREA)
        rgb = np.clip(pixels * 255, 0, 255).astype(np.uint8)
        return cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)

    def estimate(previous, current, outline):
        if cv2.absdiff(previous, current).mean() > 65:
            return None
        mask = np.zeros_like(previous)
        cv2.fillPoly(mask, [np.rint(outline).astype(np.int32)], 255)
        points = cv2.goodFeaturesToTrack(previous, 100, .01, 4, mask=mask)
        if points is None or len(points) < 4:
            return None
        moved, status, error = cv2.calcOpticalFlowPyrLK(previous, current, points, None, **options)
        if moved is None or not np.isfinite(moved).all():
            return None
        returned, reverse_status, _ = cv2.calcOpticalFlowPyrLK(current, previous, moved, None, **options)
        if returned is None:
            return None
        p, q = points.reshape(-1, 2), moved.reshape(-1, 2)
        valid = ((status.ravel() == 1) & (reverse_status.ravel() == 1)
                 & (error.ravel() < 30) & (np.linalg.norm(returned.reshape(-1, 2) - p, axis=1) < 1.5)
                 & (q >= 0).all(axis=1) & (q < current.shape[::-1]).all(axis=1))
        if valid.sum() < 4 or valid.mean() < .4:
            return None
        matrix, inliers = cv2.estimateAffinePartial2D(p[valid], q[valid], method=cv2.RANSAC,
                                                    ransacReprojThreshold=2)
        if (matrix is None or inliers is None or inliers.sum() < 4 or inliers.mean() < .6
                or not .8 < math.hypot(*matrix[:, 0]) < 1.25):
            return None
        return matrix

    previous = start
    cached_reference = None
    reference_key = None
    for offset in range(1, limit + 1):
        if time.monotonic() >= deadline:
            reason = "limit"
            break
        current = start + offset * direction
        low, high = outline.min(axis=0), outline.max(axis=0)
        padding = np.maximum(48, (high - low) * .5)
        origin = np.maximum(0, np.floor(low - padding)).astype(int)
        extent = np.minimum(size, np.ceil(high + padding)).astype(int)
        crop_size = extent - origin
        matrix = None
        if min(crop_size) >= 8:
            factor = min(1, 1024 / max(crop_size))
            dimensions = tuple(np.maximum(1, np.rint(crop_size * factor)).astype(int))
            bounds = (*origin, *extent)
            scale = np.asarray(dimensions) / crop_size
            key = (previous, bounds, dimensions)
            if key != reference_key:
                cached_reference = gray(previous, bounds, dimensions)
                reference_key = key
            current_gray = gray(current, bounds, dimensions)
            matrix = estimate(cached_reference, current_gray, (outline - origin) * scale)
            if matrix is not None:
                matrix[:, :2] *= scale
                matrix /= scale[:, None]
                matrix[:, 2] += origin - matrix[:, :2] @ origin
                cached_reference = current_gray
                reference_key = (current, bounds, dimensions)
        reliable.append(matrix is not None)
        # Hold the last reliable transform through gaps, then retry against that same frame.
        if matrix is not None:
            outline = outline @ matrix[:, :2].T + matrix[:, 2]
            accumulated[:2] = matrix @ accumulated
            previous = current
        normalized = accumulated[:2].copy()
        normalized[:, :2] *= size
        normalized /= size[:, None]
        transforms.append(normalized.tolist())
    return {"transforms": transforms, "reliable": reliable, "reason": reason}

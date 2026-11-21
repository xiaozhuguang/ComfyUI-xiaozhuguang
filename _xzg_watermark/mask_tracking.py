"""Track an outline using local regions of the original input frames."""
import math

import cv2
import numpy as np


def _project(points, matrix):
    weights = points @ matrix[2, :2] + matrix[2, 2]
    if not np.isfinite(weights).all() or weights.min() <= 0 or weights.min() < weights.max() * .15:
        return None
    projected = (points @ matrix[:2, :2].T + matrix[:2, 2]) / weights[:, None]
    return projected if np.isfinite(projected).all() else None


def _match_patch(image, patch, mask):
    scores = cv2.matchTemplate(image, patch, cv2.TM_CCOEFF_NORMED, mask=mask)
    scores[~np.isfinite(scores)] = -1
    _, best, _, (x, y) = cv2.minMaxLoc(scores)
    if best < .8:
        return None
    # Ignore nearby samples of the same peak when checking for repeated patterns.
    radius = max(3, min(patch.shape) // 5)
    scores[max(0, y - radius):y + radius + 1, max(0, x - radius):x + radius + 1] = -1
    if best - scores.max() < .07:
        return None
    return np.array([x, y])


def _patch_translation(previous, current, outline):
    low = np.maximum(0, np.floor(outline.min(axis=0))).astype(int)
    high = np.minimum(previous.shape[::-1], np.ceil(outline.max(axis=0))).astype(int)
    width, height = high - low
    if min(width, height) < 5 or (width, height) == previous.shape[::-1]:
        return None
    x, y = low
    patch = previous[y:y + height, x:x + width]
    mask = np.zeros_like(patch)
    cv2.fillPoly(mask, [np.rint(outline - low).astype(np.int32)], 255)
    inside = patch[mask != 0]
    if inside.size < 25 or inside.std() < 5:
        return None
    target = _match_patch(current, patch, mask)
    if target is None:
        return None
    tx, ty = target
    matched = current[ty:ty + height, tx:tx + width]
    origin = _match_patch(previous, matched, mask)
    if origin is None or np.linalg.norm(origin - low) > 2:
        return None
    matrix = np.eye(3)
    matrix[:2, 2] = target - low
    return matrix


def track_outline(image, frame_indices, start, end, polygon, progress=None):
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
    original = outline.copy()
    normalization = np.diag([width, height, 1.])
    accumulated = np.eye(3)
    transforms = []
    reliable = []
    direction = 1 if end > start else -1
    options = dict(winSize=(31, 31), maxLevel=3)

    def gray(index, bounds, dimensions):
        x0, y0, x1, y1 = bounds
        pixels = image[frame_indices[index], y0:y1, x0:x1, :3].detach().cpu().numpy()
        if dimensions != (x1 - x0, y1 - y0):
            pixels = cv2.resize(pixels.astype(np.float32, copy=False), dimensions, interpolation=cv2.INTER_AREA)
        rgb = np.clip(pixels * 255, 0, 255).astype(np.uint8)
        return cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)

    def feature_transform(previous, current, outline):
        mask = np.zeros_like(previous)
        cv2.fillPoly(mask, [np.rint(outline).astype(np.int32)], 255)
        points = cv2.goodFeaturesToTrack(previous, 250, .01, 4, mask=mask)
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
        if valid.sum() < 4:
            return None
        p, q = p[valid], q[valid]
        matrix, inliers = cv2.estimateAffinePartial2D(p, q, method=cv2.RANSAC,
                                                    ransacReprojThreshold=2)
        similarity = (valid.mean() >= .4 and matrix is not None and inliers is not None and inliers.sum() >= 4
                      and inliers.mean() >= .6 and .8 < math.hypot(*matrix[:, 0]) < 1.25)
        # A partially occluded plane can still have enough well-distributed inliers.
        if len(p) >= max(8, len(valid) * .12):
            planar, support = cv2.findHomography(p, q, cv2.RANSAC, 2.0)
            if (planar is not None and support is not None and support.mean() >= .65
                    and support.sum() >= max(8, len(valid) * .12)):
                supported = support.ravel() != 0
                matches = p[supported]
                low, high = outline.min(axis=0), outline.max(axis=0)
                box = np.array([low, [high[0], low[1]], high, [low[0], high[1]]])
                warped = _project(box, planar)
                if (warped is not None
                        and cv2.contourArea(cv2.convexHull(matches)) >= .15 * np.prod(high - low)):
                    lengths = np.linalg.norm(np.roll(warped, -1, axis=0) - warped, axis=1)
                    ratios = lengths / np.maximum(np.tile(high - low, 2), 1.)
                    if (np.all((ratios > .65) & (ratios < 1.55))
                            and cv2.contourArea(warped.astype(np.float32), oriented=True) > 0):
                        if not similarity:
                            return planar
                        predicted = _project(matches, planar)
                        if predicted is not None:
                            residual = np.linalg.norm(predicted - q[supported], axis=1)
                            simpler = np.linalg.norm(matches @ matrix[:, :2].T + matrix[:, 2] - q[supported], axis=1)
                            if np.mean(simpler - residual) > .35:
                                return planar
        return np.vstack((matrix, [0., 0., 1.])) if similarity else None

    previous = start
    cached_reference = None
    reference_key = None
    for offset in range(1, abs(end - start) + 1):
        current = start + offset * direction
        low, high = outline.min(axis=0), outline.max(axis=0)
        padding = np.maximum(96, (high - low) * .5)
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
            local_outline = (outline - origin) * scale
            matrix = feature_transform(cached_reference, current_gray, local_outline)
            if matrix is None:
                matrix = _patch_translation(cached_reference, current_gray, local_outline)
            if matrix is not None:
                crop = np.eye(3)
                crop[0, 0], crop[1, 1] = scale
                crop[:2, 2] = -origin * scale
                candidate = np.linalg.solve(crop, matrix @ crop) @ accumulated
                projected = _project(original, candidate)
                if projected is not None:
                    # Keep the homogeneous scale bounded over long sequences.
                    accumulated = candidate / np.max(np.abs(candidate[2]))
                    outline = projected
                    previous = current
                    cached_reference = current_gray
                    reference_key = (current, bounds, dimensions)
                else:
                    matrix = None
        reliable.append(matrix is not None)
        # Hold the last reliable transform through gaps, then retry against that same frame.
        normalized = np.linalg.solve(normalization, accumulated @ normalization)
        transforms.append(normalized.tolist())
        if progress is not None:
            progress(offset)
    return {"transforms": transforms, "reliable": reliable, "reason": "complete"}

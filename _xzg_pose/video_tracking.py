"""CPU optical-flow tracking of one joint between explicit manual anchors."""
import math
import time
from collections import OrderedDict


MAX_TRACK_FRAMES = 600


def validate_request(data, payload):
    if not isinstance(payload, dict):
        raise ValueError('追踪请求格式无效')
    images, frames = data['images'], data['frames']
    if images is None or len(images) != len(frames) or len(images) < 2:
        raise ValueError('请将原视频逐帧 IMAGE 接入节点 images 输入，再执行节点')
    if payload.get('source_digest') != data['source_digest']:
        raise ValueError('视频会话已改变，请重新打开编辑器')
    start, end = payload.get('start'), payload.get('end')
    if any(type(v) is not int for v in (start, end)) or not 0 <= start < end < len(frames):
        raise ValueError('请选择有效的补全区间')
    if end - start + 1 > MAX_TRACK_FRAMES:
        raise ValueError('单次最多追踪 600 帧，请用手工关键帧拆分区间')
    person, joint = payload.get('person'), payload.get('joint')
    if type(person) is not int or person < 0 or type(joint) is not int or not 0 <= joint < 18:
        raise ValueError('请选择具体人物和关节')
    if any(person >= len(frames[i]['people']) for i in range(start, end + 1)):
        raise ValueError('区间内人物缺失，请拆分区间后追踪')
    anchors = payload.get('anchors')
    if not isinstance(anchors, list) or len(anchors) != 2:
        raise ValueError('视频追踪必须在两个绿色手工关键帧之间执行')
    previous = start - 1
    for anchor in anchors:
        if not isinstance(anchor, dict) or type(anchor.get('frame')) is not int or not previous < anchor['frame'] <= end:
            raise ValueError('手工锚点必须按帧排序且不能重复')
        if any(type(anchor.get(k)) not in (int, float) or not math.isfinite(anchor[k]) or not 0 <= anchor[k] <= 1 for k in ('x', 'y')):
            raise ValueError('追踪锚点必须位于视频画面内')
        previous = anchor['frame']
    if anchors[0]['frame'] != start or anchors[-1]['frame'] != end:
        raise ValueError('请先手工调整补全区间的起点和终点')
    return start, end, anchors


def track_joint(data, payload, cancelled=None, progress=None):
    start, end, anchors = validate_request(data, payload)
    import cv2
    import numpy as np

    deadline = time.monotonic() + 120
    cache = OrderedDict()
    shape = tuple(data['images'][0].shape)
    if len(shape) != 3 or shape[2] < 3:
        raise ValueError('追踪需要 RGB 视频帧')
    height, width = shape[:2]
    scale = min(1.0, 640 / max(width, height))
    w, h = max(1, round(width * scale)), max(1, round(height * scale))
    radius = max(10, min(26, round(min(w, h) * .055)))
    completed, total = 0, (end - start) * 2

    def check():
        if cancelled is not None and cancelled.is_set():
            raise InterruptedError('已取消视频追踪')
        if time.monotonic() > deadline:
            raise ValueError('追踪超时，请缩短区间后重试')

    def gray(index):
        check()
        if index in cache:
            cache.move_to_end(index)
            return cache[index]
        tensor = data['images'][index]
        pixels = tensor.detach().cpu().numpy() if hasattr(tensor, 'detach') else np.asarray(tensor)
        if tuple(pixels.shape) != shape:
            raise ValueError('视频帧尺寸必须保持一致')
        pixels = np.clip(pixels[..., :3] * 255, 0, 255).astype(np.uint8)
        if (width, height) != (w, h):
            pixels = cv2.resize(pixels, (w, h), interpolation=cv2.INTER_AREA)
        result = cv2.cvtColor(pixels, cv2.COLOR_RGB2GRAY)
        cache[index] = result
        while len(cache) > 8:
            cache.popitem(last=False)
        return result

    def step(previous, current, point):
        # Reseed local texture every frame, keeping the anatomical point as an offset.
        mask = np.zeros_like(previous)
        cv2.circle(mask, tuple(np.rint(point).astype(int)), radius, 255, -1)
        points = cv2.goodFeaturesToTrack(previous, 30, .01, 3, mask=mask, blockSize=3)
        if points is None or len(points) < 4:
            return None
        options = dict(winSize=(21, 21), maxLevel=3,
                       criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, .01))
        moved, status, error = cv2.calcOpticalFlowPyrLK(previous, current, points, None, **options)
        if moved is None:
            return None
        returned, back_status, _ = cv2.calcOpticalFlowPyrLK(current, previous, moved, None, **options)
        if returned is None:
            return None
        p, q = points.reshape(-1, 2), moved.reshape(-1, 2)
        valid = ((status.ravel() == 1) & (back_status.ravel() == 1)
                 & (np.linalg.norm(returned.reshape(-1, 2) - p, axis=1) < 1.5)
                 & (error.ravel() < 25) & np.isfinite(q).all(axis=1)
                 & (q[:, 0] >= 0) & (q[:, 0] < w) & (q[:, 1] >= 0) & (q[:, 1] < h))
        if valid.sum() < 4 or valid.mean() < .35:
            return None
        delta = q[valid] - p[valid]
        motion = np.median(delta, axis=0)
        coherent = np.linalg.norm(delta - motion, axis=1) < max(3, radius * .25)
        if coherent.sum() < 4 or coherent.mean() < .5:
            return None
        # A local affine fit accounts for rotation instead of assuming translation only.
        matrix, inliers = cv2.estimateAffinePartial2D(p[valid][coherent], q[valid][coherent],
                                                    method=cv2.RANSAC, ransacReprojThreshold=2)
        if matrix is None or inliers.sum() < 4:
            return None
        local_scale = np.linalg.norm(matrix[:, 0])
        target = matrix[:, :2] @ point + matrix[:, 2]
        if not .8 < local_scale < 1.25 or not np.isfinite(target).all():
            return None
        if np.linalg.norm(target - point) > max(12, min(w, h) * .15):
            return None
        if not 0 <= target[0] < w or not 0 <= target[1] < h:
            return None
        # Reject abrupt scene changes rather than carry the point into a new shot.
        if np.mean(np.abs(previous[::8, ::8].astype(float) - current[::8, ::8])) > 65:
            return None
        quality = float(valid.mean() * coherent.mean() * inliers.mean())
        return target, quality

    def direction(first, last, anchor, other):
        nonlocal completed
        point = np.array([anchor['x'] * w, anchor['y'] * h], dtype=np.float64)
        result = {first: (point.copy(), 1.0)}
        increment = 1 if last > first else -1
        previous = gray(first)
        alive = True
        for index in range(first + increment, last + increment, increment):
            check()
            if alive:
                current = gray(index)
                tracked = step(previous, current, point)
                if tracked is None:
                    alive = False
                else:
                    point, quality = tracked
                    result[index] = (point.copy(), quality)
                    previous = current
            completed += 1
            if progress:
                progress(completed, total)
        if last in result:
            target = np.array([other['x'] * w, other['y'] * h])
            if np.linalg.norm(result[last][0] - target) > max(8, radius * .8):
                # Reaching the other anchor at the wrong location indicates drift.
                return {first: result[first]}
        return result

    points, failed = [], []
    for first, last in zip(anchors, anchors[1:]):
        a, b = first['frame'], last['frame']
        forward = direction(a, b, first, last)
        backward = direction(b, a, last, first)
        for index in range(a + 1, b):
            check()
            f, r = forward.get(index), backward.get(index)
            if f is not None and r is not None:
                if np.linalg.norm(f[0] - r[0]) > max(8, radius * .8):
                    failed.append(index)
                    continue
                t = (index - a) / (b - a)
                wf, wr = (1 - t) * f[1], t * r[1]
                point = (f[0] * wf + r[0] * wr) / max(1e-8, wf + wr)
                quality = min(f[1], r[1])
            elif f is not None or r is not None:
                point, quality = f if f is not None else r
                quality *= .7
            else:
                failed.append(index)
                continue
            if quality < .3:
                failed.append(index)
            else:
                points.append({'frame': index, 'x': float(point[0] / w),
                               'y': float(point[1] / h), 'confidence': float(quality)})
    return {'points': points, 'failed_frames': failed, 'start': start, 'end': end}

# -*- coding: utf-8 -*-
"""
Comfyui-Video-Watermark-Detection-xzg —— 视频遮罩手工跟踪（原视频水印检测，手工跟踪版）

只保留「手工跟踪」模式：
1. 视窗内逐轨道打关键帧（矩形框 / 手绘多边形），帧间线性插值生成逐帧遮罩；
2. 预览下发全部帧（逐帧精确打点追踪）；
4. 默认用最近的关键帧补齐首尾，兼容形状之间按帧号线性插值。

历史说明：
  原 YOLO 自动检测（yolo11x-train28-best）与 SAM3 / SAM3.1 语义分割模式已下线，
  相关推理代码不再接线。模型权重文件仍保留在 models/yolo、models/sam3 原处未动，
  内部代码包 _xzg_sam3 原样保留（不再被本节点引用）。
  旧版 threshold / tracking / max_miss_frames / mask_expand_x / mask_expand_y
  控件已删除；model_name 保留为隐藏占位（前端不显示）。旧工作流的
  widgets_values 错位由前端 onConfigure 迁移钩子自动重映射，
  regions_data（手工标注）不受影响。
"""
import os
import time
import json
import random
import hashlib
import asyncio
import weakref
from bisect import bisect_right
import cv2
import numpy as np
import torch
import folder_paths
from aiohttp import web
from server import PromptServer

from .mask_tracking import track_outline
from . import mask_history

MANUAL_MODEL_NAME = "手工跟踪"

# 预览结果缓存：key=(视频内容哈希,帧数,宽,高,max_side,max_frames) -> {files, idx, vid}
# 同视频重复"点击加载视频"直接复用已落盘文件（秒回）；temp 被清理时按文件存在性自动失效
_PREVIEW_CACHE = {}
_LATEST_TRACKING_SOURCE = None
_TRACK_PROGRESS = {}


@PromptServer.instance.routes.get("/xzg/manual-mask/progress/{job}")
async def manual_mask_progress(request):
    return web.json_response({"processed": _TRACK_PROGRESS.get(request.match_info["job"], [0])[0]})


@PromptServer.instance.routes.post("/xzg/manual-mask/track")
async def track_manual_mask(request):
    try:
        payload = await request.json()
        if not isinstance(payload, dict):
            raise ValueError("跟踪请求无效")
        entry = next((entry for entry in _PREVIEW_CACHE.copy().values()
                      if entry["vid"] == payload.get("video_id")
                      and entry["files"][0]["filename"] == payload.get("first_frame")), None)
        if entry is None:
            raise ValueError("预览已失效，请重新加载视频")
        image = entry["source"]()
        if image is None:
            raise ValueError("原始视频帧已释放，请点击加载视频后重新跟踪")
        job = payload.get("job")
        if job is not None and (not isinstance(job, str) or len(job) != 32 or job in _TRACK_PROGRESS):
            raise ValueError("无效的跟踪任务标识")
        counter = [0]
        def progress(processed):
            counter[0] = processed

        if job:
            _TRACK_PROGRESS[job] = counter
        try:
            result = await asyncio.to_thread(track_outline, image, entry["idx"],
                                             payload.get("start"), payload.get("end"),
                                             payload.get("polygon"), progress)
        finally:
            if job:
                _TRACK_PROGRESS.pop(job, None)
        return web.json_response(result)
    except ValueError as error:
        return web.json_response({"error": str(error)}, status=400)

# =====================================================================
# 参数说明的唯一知识源（Single Source of Truth）
# 后续要维护"参数作用 / 视频调参建议"，只改这里：
#   - 参数悬停提示（tooltip）自动生成
# 不要再单独改 INPUT_TYPES 里的 tooltip 字符串。
# =====================================================================
_PARAM_DOCS = {
    "regions_data": {
        "default": "",
        "desc": "手工跟踪标注数据（前端视窗自动写入，无需手填）：各轨道关键帧的矩形框/手绘多边形（归一化 0~1）与采样帧号。",
        "tip": "在节点视窗里选轨道、逐帧打关键帧即可；关键帧之间自动线性插值。",
    },
}


def _param_tooltip(name):
    """由 _PARAM_DOCS 生成参数悬停提示：作用 + 视频建议。"""
    doc = _PARAM_DOCS[name]
    return f"{doc['desc']} 视频建议：{doc['tip']}"


def _box_to_px(r, W, H):
    """将矩形中心和尺寸分别量化，避免等宽框平移时宽度跳变。"""
    try:
        x1 = float(r["x1"]); y1 = float(r["y1"])
        x2 = float(r["x2"]); y2 = float(r["y2"])
    except Exception:
        return None
    px1 = max(0.0, min(float(W), x1 * W)); py1 = max(0.0, min(float(H), y1 * H))
    px2 = max(0.0, min(float(W), x2 * W)); py2 = max(0.0, min(float(H), y2 * H))
    if px2 - px1 < 1.0 or py2 - py1 < 1.0:
        return None
    width = int(round(px2 - px1, 9) + 0.5)
    height = int(round(py2 - py1, 9) + 0.5)
    left = int((px1 + px2 - width) / 2 + 0.5)
    top = int((py1 + py2 - height) / 2 + 0.5)
    return left, top, min(W, left + width), min(H, top + height)


def _poly_to_px(poly, W, H):
    """归一化 [[x,y],...] -> 像素浮点点列；非法 / 少于 3 点返回 None。
    不做 [0,W]x[0,H] 逐顶点钳制：前端手绘允许画进黑边（轨迹绕到图像外侧
    以完整覆盖边角），逐顶点钳制会让贴边笔迹变形、顶点间连线切掉角部；
    超界顶点交由 cv2.fillPoly 光栅化时按画布边界自然裁剪，遮罩不会越界。"""
    if not isinstance(poly, (list, tuple)) or len(poly) < 3:
        return None
    try:
        pts = [(float(p[0]) * W, float(p[1]) * H) for p in poly]
    except Exception:
        return None
    return pts


def _poly_signed_area(pts):
    """多边形有向面积（符号判定绕向）。归一化坐标与像素坐标之间是正定线性映射，
    绕向符号一致，直接用归一化坐标判定即可。"""
    s = 0.0
    n = len(pts)
    for i in range(n):
        x1, y1 = float(pts[i][0]), float(pts[i][1])
        x2, y2 = float(pts[(i + 1) % n][0]), float(pts[(i + 1) % n][1])
        s += x1 * y2 - x2 * y1
    return s / 2.0


def _align_poly(pb, pa):
    """把手绘多边形 pb 对齐到 pa 的对应关系——插值只考虑形状本身，不考虑空间翻转：
    1) 绕向统一：有向面积符号与 pa 相反时整体反转（一帧顺时针、一帧逆时针不再互相穿插）；
    2) 起点对齐：循环旋转使首点为距 pa 首点最近的点（起笔位置不同不再折叠）。
    前提：pb/pa 均为前端 resamplePoly 输出的等长闭合点列。
    对齐后再逐点线性插值，即为纯形状渐变。"""
    pts = [[float(p[0]), float(p[1])] for p in pb]
    if _poly_signed_area(pts) * _poly_signed_area(pa) < 0:
        pts.reverse()
    a0 = (float(pa[0][0]), float(pa[0][1]))
    bi, bd = 0, None
    for i, p in enumerate(pts):
        d = (p[0] - a0[0]) ** 2 + (p[1] - a0[1]) ** 2
        if bd is None or d < bd:
            bd, bi = d, i
    return pts[bi:] + pts[:bi]


def _interpolate_rectangle(keyframes, keys, index, t, fill_edges):
    a, b = keys[index - 1:index + 1]
    span = b - a

    def box(frame):
        region = keyframes[frame][0]
        if region.get("poly") or not all(k in region for k in ("x1", "y1", "x2", "y2")):
            return None
        x1, y1, x2, y2 = (float(region[k]) for k in ("x1", "y1", "x2", "y2"))
        return (x1 + x2) / 2, (y1 + y2) / 2, x2 - x1, y2 - y1

    def tangent(first, second, left_span, right_span):
        if first * second <= 0:
            return 0
        w1, w2 = 2 * right_span + left_span, right_span + 2 * left_span
        return (w1 + w2) / (w1 / first + w2 / second)

    left, right = box(a), box(b)
    previous = box(keys[index - 2]) if index > 1 else None
    following = box(keys[index + 1]) if index + 1 < len(keys) else None
    values = []
    for i, (start, end) in enumerate(zip(left, right)):
        slope = (end - start) / span
        m0 = m1 = 0 if fill_edges else slope
        if previous is not None:
            distance = a - keys[index - 2]
            m0 = tangent((start - previous[i]) / distance, slope, distance, span)
        if following is not None:
            distance = keys[index + 1] - b
            m1 = tangent(slope, (following[i] - end) / distance, span, distance)
        # Keep the middle of the span close to constant speed. Match tangent
        # speeds near the keys so a long ease does not create a fast middle.
        ramp = 0.2
        cruise = (slope - ramp * (m0 + m1) / 2) / (1 - ramp)
        if t < ramp:
            values.append(start + span * t * (m0 + (cruise - m0) * t / (2 * ramp)))
        elif t > 1 - ramp:
            tail = 1 - t
            values.append(end - span * tail * (m1 + (cruise - m1) * tail / (2 * ramp)))
        else:
            values.append(start + span * (m0 * ramp / 2 + cruise * (t - ramp / 2)))
    x, y, w, h = values
    return {"x1": x - w / 2, "y1": y - h / 2, "x2": x + w / 2, "y2": y + h / 2}


def _fill_box_or_poly(masks, t, r, W, H):
    """按 r 是否带 poly 用多边形 / 矩形填充 masks[t]；非法输入静默跳过。"""
    if isinstance(r, dict) and r.get("poly"):
        pts = _poly_to_px(r["poly"], W, H)
        if pts:
            cv2.fillPoly(masks[t], [np.array(pts, np.int32)], 255)
        return
    rect = _box_to_px(r, W, H)
    if rect:
        x1, y1, x2, y2 = rect
        masks[t, y1:y2, x1:x2] = 255


def _parse_regions(data):
    """解析手工跟踪标注（前端视窗画框写入）：返回 (manual_kf, sample_idx, fill_edges)。
    manual_kf: {tid: {预览帧序: [{x1,y1,x2,y2} | {poly:[[x,y],...]}]}}
    sample_idx: 预览帧序 -> 实际帧号 的映射表；空表示未同步（按实际帧号处理）。"""
    if not data:
        return {}, [], True
    try:
        d = json.loads(data) if isinstance(data, str) else data
    except Exception:
        return {}, [], True
    if not isinstance(d, dict):
        return {}, [], True
    manual = d.get("manual") if isinstance(d.get("manual"), dict) else {}
    try:
        sample_idx = [int(x) for x in (d.get("sample_idx") or [])]
    except Exception:
        sample_idx = []
    return manual, sample_idx, d.get("fill_edges") is not False


def _build_preview(image, max_side=1280, max_frames=12):
    """视频预览：均匀采样帧（<=max_frames 帧，含首尾）缩放到长边 <= max_side，
    供前端视窗播放 / 拖动并打关键帧。手工跟踪模式传 max_frames=总帧数（逐帧精确打点）。

    性能（点击加载视频慢的根治）：
    1) 结果缓存：同视频（内容哈希+帧数+尺寸）重复加载直接复用已落盘文件，秒回；
       缓存文件被 ComfyUI 清理 temp 后自动失效重建。
    2) JPEG（质量 80）替代 PNG：预览编码快 5~10 倍、体积小 5~10 倍（仅预览用途）。
    3) 逐帧流式处理：边转换/缩放/落盘/算哈希边丢弃，不再物化整栈 float32 大张量
      （千帧视频原实现会临时占用数 GB 内存）。
    4) 缩放用 cv2.INTER_AREA（SIMD 优化的区域平均下采样，速度快且抗混叠，
       比 PIL LANCZOS 快数倍）；全程 uint8 处理，不再经过 float32 转换。
    vid 为逐帧 uint8 字节流增量 md5：同视频同算法稳定、换视频必变。
    前端仅用它做会话内「是否换了视频」检测（标注持久化在 regions_data 控件值里，
    与 video_id 无关），因此缩放/编码算法变更不影响已有工作流的标注。"""
    global _LATEST_TRACKING_SOURCE
    from .. import tensor_to_pil
    from PIL import Image as _PILImage
    B = int(image.shape[0])
    if B > max_frames:
        idx = sorted(set(int(round(i * (B - 1) / (max_frames - 1))) for i in range(max_frames)))
    else:
        idx = list(range(B))

    # 缓存命中：同视频直接复用已落盘的预览文件（temp 被清理则自动失效重建）
    W, H = int(image.shape[2]), int(image.shape[1])
    cache_key = (_video_id(image), B, W, H, max_side, max_frames)
    out_dir = folder_paths.get_temp_directory()
    cached = _PREVIEW_CACHE.get(cache_key)
    if cached and all(os.path.exists(os.path.join(out_dir, f["filename"])) for f in cached["files"]):
        cached["source"] = weakref.ref(image)
        _LATEST_TRACKING_SOURCE = image
        return cached["files"], cached["idx"], cached["vid"]

    w0, h0 = W, H
    scale = max_side / max(w0, h0) if max(w0, h0) > max_side else 1.0
    nw, nh = (max(1, int(w0 * scale)), max(1, int(h0 * scale))) if scale < 1.0 else (w0, h0)

    # 逐帧流式：转换 → 缩放 → 哈希增量 → JPEG 落盘，单帧临时对象即弃
    hasher = hashlib.md5()
    files = []
    os.makedirs(out_dir, exist_ok=True)
    token = "".join(random.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(8))
    for j, fi in enumerate(idx):
        arr = np.asarray(tensor_to_pil(image[fi:fi + 1])[0], dtype=np.uint8)
        if scale < 1.0:
            # 区域平均下采样：SIMD 优化，比 LANCZOS 快数倍，且下采样场景抗混叠质量好
            arr = cv2.resize(arr, (nw, nh), interpolation=cv2.INTER_AREA)
        hasher.update(arr.tobytes())
        fname = f"xzg_wmdet_{token}_{j}.jpg"
        _PILImage.fromarray(arr).save(os.path.join(out_dir, fname), "JPEG", quality=80)
        files.append({"filename": fname, "subfolder": "", "type": "temp"})
    vid = hasher.hexdigest()

    _PREVIEW_CACHE[cache_key] = {"files": files, "idx": idx, "vid": vid, "source": weakref.ref(image)}
    _LATEST_TRACKING_SOURCE = image
    if len(_PREVIEW_CACHE) > 24:  # 防无界增长：超出保留最近的 24 个视频
        for k in list(_PREVIEW_CACHE.keys())[:-24]:
            _PREVIEW_CACHE.pop(k, None)
    return files, idx, vid


def _video_id(image):
    """Hash every input frame so videos with matching sampled frames keep distinct previews."""
    digest = hashlib.md5()
    for frame in image:
        pixels = frame.detach().cpu().contiguous().numpy()
        digest.update(pixels)
    return digest.hexdigest()


class VideoWatermarkDetector:
    """视频遮罩手工跟踪节点（显示名）：批量帧输入 -> 逐帧遮罩（检测图输出已取消）。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                # 模式已固定为手工跟踪（界面隐藏此下拉）。控件保留为隐藏占位：
                # 旧版工作流 widgets_values 的对位由前端 onConfigure 迁移钩子处理。
                "model_name": ([MANUAL_MODEL_NAME], {"default": MANUAL_MODEL_NAME}),
                "regions_data": ("STRING", {
                    "default": "",
                    "tooltip": _param_tooltip("regions_data")}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    OUTPUT_NODE = False  # 普通队列仅在下游需要遮罩时执行。
    HAS_INTERMEDIATE_OUTPUT = True  # Replay the editor preview when the MASK is cached.
    RETURN_TYPES = ("MASK",)
    RETURN_NAMES = ("颜色遮罩批次",)
    FUNCTION = "detect"
    CATEGORY = "小珠光/视频"
    DESCRIPTION = ""  # 悬停不弹使用说明（说明走前端视窗「使用说明」按钮）

    def detect(self, image, model_name=MANUAL_MODEL_NAME,
               regions_data="", unique_id=None, **kwargs):
        B, H, W, C = image.shape
        if B == 0:
            raise ValueError("[视频水印检测] 输入图像批次为空")
        if C not in (3, 4):
            raise ValueError(f"[视频水印检测] 仅支持 RGB/RGBA 图像，当前通道数 {C}")

        t_start = time.time()
        n = B                       # 手工跟踪处理全部帧（逐帧精确打点）
        sel = list(range(B))

        manual_kf, sample_idx, fill_edges = _parse_regions(regions_data)
        preview, sample_idx_out, vid = _build_preview(image, max_side=768, max_frames=n)
        try:
            data = json.loads(regions_data) if isinstance(regions_data, str) else regions_data
            auto = data.get("auto_tracking", {})
            source_id = data.get("video_id") or (auto.get("video_id") if isinstance(auto, dict) else None)
            if source_id and source_id != vid:
                manual_kf = {}
            tracked = auto["tracks"] if auto["video_id"] == vid else {}
            if not isinstance(tracked, dict):
                tracked = {}
        except (AttributeError, KeyError, TypeError, ValueError):
            tracked = {}

        track_masks = {}
        for track_id, track in manual_kf.items():
            try:
                track_index = int(track_id) - 1
            except (TypeError, ValueError):
                continue
            if not 0 <= track_index < 8 or not isinstance(track, dict):
                continue
            kf_actual = {}
            for key, regions in track.items():
                try:
                    frame = int(key)
                except (TypeError, ValueError):
                    continue
                if frame < 0 or not isinstance(regions, list):
                    continue
                if sample_idx and frame >= len(sample_idx):
                    continue
                actual = sample_idx[frame] if sample_idx else frame
                boxes = [box for box in regions if isinstance(box, dict)]
                if 0 <= actual < n and boxes:
                    kf_actual[actual] = boxes
            keys = sorted(kf_actual)
            if not keys:
                continue
            track_mask = track_masks.setdefault(
                track_index, np.zeros((n, H, W), dtype=np.uint8))
            auto_frames = tracked.get(track_id, {})
            if not isinstance(auto_frames, dict):
                auto_frames = {}

            rectangles = [None] * n
            for t in range(n):
                boxes_here = kf_actual.get(t)
                if boxes_here is None:
                    region = auto_frames.get(str(t))
                    if isinstance(region, dict):
                        boxes_here = [region]
                if boxes_here is None:
                    index = bisect_right(keys, t)
                    if index == 0 or index == len(keys):
                        if not fill_edges:
                            continue
                        boxes_here = kf_actual[keys[0] if index == 0 else keys[-1]]
                    else:
                        a, b = keys[index - 1:index + 1]
                        ra, rb = kf_actual[a][0], kf_actual[b][0]
                        tt = (t - a) / (b - a)
                        pa, pb = ra.get("poly"), rb.get("poly")
                        if (isinstance(pa, list) and isinstance(pb, list)
                                and len(pa) == len(pb) and len(pa) >= 3):
                            pb = _align_poly(pb, pa)
                            boxes_here = [{"poly": [[x + (u - x) * tt, y + (v - y) * tt]
                                                    for (x, y), (u, v) in zip(pa, pb)]}]
                        elif not pa and not pb and all(k in ra and k in rb for k in ("x1", "y1", "x2", "y2")):
                            boxes_here = [_interpolate_rectangle(kf_actual, keys, index, tt, fill_edges)]
                        elif fill_edges:
                            boxes_here = kf_actual[a if tt < 0.5 else b]
                        else:
                            continue
                rect = None
                if boxes_here and len(boxes_here) == 1 and not boxes_here[0].get("poly"):
                    rect = _box_to_px(boxes_here[0], W, H)
                if rect is None:
                    for r in boxes_here or ():
                        _fill_box_or_poly(track_mask, t, r, W, H)
                else:
                    rectangles[t] = rect

            margin = 4
            previous = None
            for t, rect in enumerate(rectangles):
                if rect is None:
                    previous = None
                    continue
                # Only suppress a one-frame excursion. Holding a small forward step
                # would turn steady motion into a staircase of larger jumps.
                if (previous is not None and t + 1 < n and rectangles[t + 1] == previous
                        and all(abs(edge - old) <= margin for edge, old in zip(rect, previous))):
                    rect = previous
                x1, y1, x2, y2 = rect
                previous = rect
                track_mask[t, max(0, y1 - margin):min(H, y2 + margin),
                           max(0, x1 - margin):min(W, x2 + margin)] = 255

        # ---- 2) 遮罩转张量（检测分辨率=原尺寸，无需缩放）----
        ordered_masks = [track_masks[index] for index in sorted(track_masks)]
        mask_batch = (torch.from_numpy(np.stack(ordered_masks)).float().div_(255.0)
                      if ordered_masks else torch.zeros((0, n, H, W), dtype=torch.float32))

        # 检测图（可视化 IMAGE）输出已按需求取消：原来占执行耗时的
        # 全帧 uint8 转换 / np.stack / float32 归一化（约 2/3 内存开销）整体删除，
        # 关键帧插值结果仍由前端预览视窗承担展示职责。

        print(f"[视频水印检测] 完成: {n}帧, 模式=manual(手工跟踪), "
              f"耗时 {time.time() - t_start:.2f}s")
        # 预览帧数：手工跟踪取全部帧（逐帧精确打点追踪）；
        # 长边压到 768（仅前端视窗显示用，关键帧为归一化坐标，输出遮罩始终按原始分辨率计算）
        return {
            "ui": {"preview": [{"preview_str": json.dumps({"frames": preview, "sample_idx": sample_idx_out, "video_id": vid}, ensure_ascii=False),
                                "is_init": True}]},
            "result": (mask_batch,),
        }


class XZGManualTrackingLoadPreview(VideoWatermarkDetector):
    """Only used by the editor's explicit load request, never saved in workflows."""

    OUTPUT_NODE = True
    CATEGORY = "小珠光/内部"
    DEPRECATED = True



class XZGSelectTrackedMask:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mask_batch": ("MASK",),
                "color_index": ("INT", {"default": 0, "min": 0, "max": 7,
                    "tooltip": "按实际绘制过的颜色轨道顺序从 0 开始。"}),
            },
        }

    RETURN_TYPES = ("MASK",)
    RETURN_NAMES = ("逐帧遮罩",)
    FUNCTION = "select"
    CATEGORY = "小珠光/视频"

    def select(self, mask_batch, color_index=0):
        if not 0 <= color_index < len(mask_batch):
            return (mask_batch.new_zeros(mask_batch.shape[1:]),)
        return (mask_batch[color_index],)


NODE_CLASS_MAPPINGS = {
    "VideoWatermarkDetector": VideoWatermarkDetector,
    "XZGManualTrackingLoadPreview": XZGManualTrackingLoadPreview,
    "XZGSelectTrackedMask": XZGSelectTrackedMask,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VideoWatermarkDetector": "小珠光视频遮罩手工跟踪",
    "XZGSelectTrackedMask": "小珠光跟踪遮罩颜色选择",
}

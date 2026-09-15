# -*- coding: utf-8 -*-
"""
Comfyui-Video-Watermark-Detection-xzg —— 视频遮罩手工跟踪（原视频水印检测，手工跟踪版）

只保留「手工跟踪」模式：
1. 视窗内逐轨道打关键帧（矩形框 / 手绘多边形），帧间线性插值生成逐帧遮罩；
2. 预览下发全部帧（逐帧精确打点追踪）；
3. 遮罩支持时域膨胀（temporal_dilate）；
4. 单关键帧轨道全帧沿用，多关键帧轨道按帧号线性插值（矩形对角插值 / 同点数多边形逐点插值）。

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
import cv2
import numpy as np
import torch
import torch.nn.functional as F
import folder_paths

MANUAL_MODEL_NAME = "手工跟踪"

# 预览结果缓存：key=(视频内容哈希,帧数,宽,高,max_side,max_frames) -> {files, idx, vid}
# 同视频重复"点击加载视频"直接复用已落盘文件（秒回）；temp 被清理时按文件存在性自动失效
_PREVIEW_CACHE = {}

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
    "temporal_dilate": {
        "default": "0",
        "desc": "时域膨胀核大小（0=关闭，任意整数，内部自动取奇数核）：把每帧遮罩与其前后对称若干帧取并集，兜底关键帧之间的遗漏。",
        "tip": "关键帧打稀了仍有个别帧缺遮罩时设 3~5；水印移动快时设大了会拖出轨迹带。",
    },
}


def _param_tooltip(name):
    """由 _PARAM_DOCS 生成参数悬停提示：作用 + 视频建议。"""
    doc = _PARAM_DOCS[name]
    return f"{doc['desc']} 视频建议：{doc['tip']}"


def _box_to_px(r, W, H):
    """单个归一化框 x1,y1,x2,y2 -> 像素 (px1,py1,px2,py2)；空 / 面积过小返回 None。"""
    try:
        x1 = float(r["x1"]); y1 = float(r["y1"])
        x2 = float(r["x2"]); y2 = float(r["y2"])
    except Exception:
        return None
    px1 = max(0.0, min(float(W), x1 * W)); py1 = max(0.0, min(float(H), y1 * H))
    px2 = max(0.0, min(float(W), x2 * W)); py2 = max(0.0, min(float(H), y2 * H))
    if px2 - px1 < 1.0 or py2 - py1 < 1.0:
        return None
    return (px1, py1, px2, py2)


def _poly_to_px(poly, W, H):
    """归一化 [[x,y],...] -> 像素浮点点列；非法 / 少于 3 点返回 None。"""
    if not isinstance(poly, (list, tuple)) or len(poly) < 3:
        return None
    try:
        pts = [(max(0.0, min(float(W), float(p[0]) * W)),
                max(0.0, min(float(H), float(p[1]) * H))) for p in poly]
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


def _fill_box_or_poly(masks, t, r, W, H):
    """按 r 是否带 poly 用多边形 / 矩形填充 masks[t]；非法输入静默跳过。"""
    if isinstance(r, dict) and r.get("poly"):
        pts = _poly_to_px(r["poly"], W, H)
        if pts:
            cv2.fillPoly(masks[t], [np.array(pts, np.int32)], 255)
        return
    rect = _box_to_px(r, W, H)
    if rect:
        x1, y1, x2, y2 = [int(v) for v in rect]
        x1 = max(0, min(W, x1)); y1 = max(0, min(H, y1))
        x2 = max(0, min(W, x2)); y2 = max(0, min(H, y2))
        if x2 > x1 and y2 > y1:
            masks[t][y1:y2, x1:x2] = 255


def _parse_regions(data):
    """解析手工跟踪标注（前端视窗画框写入）：返回 (manual_kf, sample_idx)。
    manual_kf: {tid: {预览帧序: [{x1,y1,x2,y2} | {poly:[[x,y],...]}]}}
    sample_idx: 预览帧序 -> 实际帧号 的映射表；空表示未同步（按实际帧号处理）。"""
    if not data:
        return {}, []
    try:
        d = json.loads(data) if isinstance(data, str) else data
    except Exception:
        return {}, []
    if not isinstance(d, dict):
        return {}, []
    manual = d.get("manual") if isinstance(d.get("manual"), dict) else {}
    try:
        sample_idx = [int(x) for x in (d.get("sample_idx") or [])]
    except Exception:
        sample_idx = []
    return manual, sample_idx


def _dilate_time(masks, k):
    """时域膨胀：时间维 max pooling（等价 uint8 逐帧 OR，核 k，奇数）。
    GPU 分块位运算（uint8，显存 ~1.5GB）；无 GPU 回退 CPU max_pool。
    返回 uint8 [n,h,w]。"""
    if k <= 1 or len(masks) < k:
        return masks
    masks = np.stack(masks) if isinstance(masks, list) else np.asarray(masks)
    n, h, w = masks.shape
    pad = k // 2
    if torch.cuda.is_available():
        chunk = max(64, min(1024, int(1.5e9 / (h * w))))        # uint8 1B/像素/帧
        out = np.empty_like(masks)
        for s in range(0, n, chunk):
            e = min(n, s + chunk)
            lo = max(0, s - pad)
            hi = min(n, e + pad)
            nb = e - s
            t = torch.from_numpy(masks[lo:hi]).to("cuda")       # uint8
            t = torch.nn.functional.pad(t, (0, 0, 0, 0, pad, pad))  # 时间轴两端补 0
            acc = torch.zeros((nb, h, w), dtype=torch.uint8, device="cuda")
            for off in range(k):
                acc |= t[off:off + nb]
            out[s:e] = acc.cpu().numpy()
        return out
    t = torch.from_numpy(masks.astype(np.float32))              # [n,h,w]
    t = t.permute(1, 2, 0).reshape(h * w, 1, n)                 # [hw,1,n]
    t = F.max_pool1d(t, kernel_size=k, stride=1, padding=pad)
    return t.reshape(h, w, n).permute(2, 0, 1).numpy().astype(np.uint8)


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

    _PREVIEW_CACHE[cache_key] = {"files": files, "idx": idx, "vid": vid}
    if len(_PREVIEW_CACHE) > 24:  # 防无界增长：超出保留最近的 24 个视频
        for k in list(_PREVIEW_CACHE.keys())[:-24]:
            _PREVIEW_CACHE.pop(k, None)
    return files, idx, vid


def _video_id(image):
    """轻量视频特征：采样数帧缩放为 32x32 的 uint8 再 hash，用于判断「是否换了视频」。
    （与前端预览 JSON 里的 video_id 相互独立，仅后端内部做换视频检测。）
    同一视频重复执行特征不变，换成不同视频则必不同。"""
    b = image.detach().cpu().numpy()
    b = np.asarray(b, np.float32)
    if b.ndim != 4 or b.shape[0] == 0:
        return hashlib.md5(b.tobytes()).hexdigest()
    step = max(1, b.shape[0] // 4)
    chunks = []
    for f in b[::step][:4]:
        try:
            f = cv2.resize(f, (32, 32), interpolation=cv2.INTER_AREA)
        except Exception:
            pass
        chunks.append((np.clip(f, 0, 1) * 255).astype(np.uint8).tobytes())
    return hashlib.md5(b"".join(chunks)).hexdigest()


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
                "temporal_dilate": ("INT", {
                    "default": 0, "min": 0, "max": 100, "step": 2,
                    "tooltip": _param_tooltip("temporal_dilate")}),
                "regions_data": ("STRING", {
                    "default": "",
                    "tooltip": _param_tooltip("regions_data")}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    OUTPUT_NODE = True  # 标记为输出节点，rgtree/右键"仅执行到本节点"等功能可用
    RETURN_TYPES = ("MASK",)
    RETURN_NAMES = ("逐帧遮罩",)
    FUNCTION = "detect"
    CATEGORY = "xzg/视频遮罩手工跟踪"
    DESCRIPTION = ""  # 悬停不弹使用说明（说明走前端视窗「使用说明」按钮）

    def detect(self, image, model_name=MANUAL_MODEL_NAME,
               temporal_dilate=0, regions_data="", unique_id=None, **kwargs):
        B, H, W, C = image.shape
        if B == 0:
            raise ValueError("[视频水印检测] 输入图像批次为空")
        if C not in (3, 4):
            raise ValueError(f"[视频水印检测] 仅支持 RGB/RGBA 图像，当前通道数 {C}")

        t_start = time.time()
        n = B                       # 手工跟踪处理全部帧（逐帧精确打点）
        sel = list(range(B))

        # 换了视频：作废上一视频残留的采样帧号映射，避免旧标注错位
        # （前端清空发生在执行后的 onExecuted，第一次新视频执行必须由后端兜底拦截）
        _last_vid = getattr(self, "_last_video_id", None)
        cur_vid = _video_id(image)
        self._last_video_id = cur_vid
        manual_kf, sample_idx = _parse_regions(regions_data)
        if _last_vid is not None and _last_vid != cur_vid:
            sample_idx = []

        # ---- 1) 手工跟踪：不跑模型，遮罩由关键帧插值直接生成 ----
        masks = np.zeros((n, H, W), dtype=np.uint8)
        if manual_kf:
            try:
                sf = [int(x) for x in sample_idx] if sample_idx else []
                if sf:
                    for tid, kf_pv in manual_kf.items():
                        if not isinstance(kf_pv, dict): continue
                        kf_actual = { sf[int(k)]: [b for b in v if isinstance(b, dict)]
                                      for k, v in kf_pv.items() if int(k) < len(sf) }
                        keys = sorted(kf_actual.keys())
                        if not keys: continue
                        single = len(keys) == 1
                        for t in range(B):
                            boxes_here = []
                            if t in kf_actual and kf_actual[t]:
                                boxes_here = kf_actual[t]
                            elif single:
                                boxes_here = kf_actual[keys[0]]
                            else:
                                a = max([k for k in keys if k <= t], default=None)
                                b = min([k for k in keys if k >= t], default=None)
                                if a is not None and b is not None and a != b and kf_actual[a] and kf_actual[b]:
                                    ra, rb = kf_actual[a][0], kf_actual[b][0]
                                    tt = (t - a) / (b - a)
                                    # 两侧均为同点数多边形 → 逐点线性插值（先对齐绕向/起点，防翻转）
                                    pa = ra.get("poly") if isinstance(ra, dict) else None
                                    pb = rb.get("poly") if isinstance(rb, dict) else None
                                    if (isinstance(pa, list) and isinstance(pb, list)
                                            and len(pa) == len(pb) and len(pa) >= 3):
                                        pb = _align_poly(pb, pa)
                                        boxes_here = [{'poly': [[pa[i][0] + (pb[i][0] - pa[i][0]) * tt,
                                                                 pa[i][1] + (pb[i][1] - pa[i][1]) * tt]
                                                                for i in range(len(pa))]}]
                                    else:
                                        boxes_here = [{'x1': ra['x1']+(rb['x1']-ra['x1'])*tt,
                                                       'y1': ra['y1']+(rb['y1']-ra['y1'])*tt,
                                                       'x2': ra['x2']+(rb['x2']-ra['x2'])*tt,
                                                       'y2': ra['y2']+(rb['y2']-ra['y2'])*tt}]
                            for r in boxes_here:
                                _fill_box_or_poly(masks, t, r, W, H)
            except Exception as _me:
                print(f'[视频水印检测] 手工遮罩插值失败: {_me}')

        if temporal_dilate > 0:
            masks = _dilate_time(masks, int(temporal_dilate) | 1)

        # ---- 2) 遮罩转张量（检测分辨率=原尺寸，无需缩放）----
        # from_numpy 直用 masks（省一次整栈拷贝）；.float().div_(255) 原地归一化（省一次中间张量）
        mask_tensor = torch.from_numpy(masks).float().div_(255.0)   # [n,H,W]

        # 检测图（可视化 IMAGE）输出已按需求取消：原来占执行耗时的
        # 全帧 uint8 转换 / np.stack / float32 归一化（约 2/3 内存开销）整体删除，
        # 关键帧插值结果仍由前端预览视窗承担展示职责。

        print(f"[视频水印检测] 完成: {n}帧, 模式=manual(手工跟踪), "
              f"耗时 {time.time() - t_start:.2f}s")
        # 预览帧数：手工跟踪取全部帧（逐帧精确打点追踪）；
        # 长边压到 768（仅前端视窗显示用，关键帧为归一化坐标，输出遮罩始终按原始分辨率计算）
        preview, sample_idx_out, vid = _build_preview(image, max_side=768, max_frames=int(image.shape[0]))
        return {
            "ui": {"preview": [{"preview_str": json.dumps({"frames": preview, "sample_idx": sample_idx_out, "video_id": vid}, ensure_ascii=False),
                                "is_init": True}]},
            "result": (mask_tensor,),
        }


NODE_CLASS_MAPPINGS = {
    "VideoWatermarkDetector": VideoWatermarkDetector,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VideoWatermarkDetector": "小珠光视频遮罩手工跟踪",
}

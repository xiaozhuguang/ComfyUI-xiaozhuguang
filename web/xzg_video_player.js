/**
 * 小珠光视频播放器 · 高扩展性架构
 *
 * 架构设计：
 *   container (根容器)
 *     ├─ videoStage (视频舞台，背景深色)
 *     │    └─ videoSurface (视频画面区域，自适应比例，居中，响应点击)
 *     │         └─ <video> (真实视频元素)
 *     │    └─ controlsLayer (控制层，悬浮在视频上)
 *     │         ├─ playOverlay (中央播放/暂停图标)
 *     │         └─ bottomBar (底部控制条：进度条、时间等)
 *     └─ placeholder (无视频时的提示)
 *
 * 核心特性：
 *   - 精确点击区域：只有视频画面区域(videoSurface)响应播放/暂停/双击
 *   - 完全自主控制：无浏览器原生controls，双击不全屏
 *   - 模块化：controlsLayer可独立扩展控制功能
 *   - 高性能：原生<video>硬件解码
 *   - 响应式：自适应容器，保持视频宽高比
 */

import { app } from "../../scripts/app.js";
import {
    downloadVideo,
    xzgTimestamp,
} from "./xzg_save_utils.js";

const DEFAULT_BG = "#1a1a1a";
const SURFACE_BG = "#000";

export class XiaozhuguangVideoPlayer {
    constructor(options = {}) {
        this.container = options.container || document.createElement("div");
        this.onDblClick = options.onDblClick || null;
        this.onLoadedMetadata = options.onLoadedMetadata || null;
        this.onPlay = options.onPlay || null;
        this.onPause = options.onPause || null;
        this.onTimeUpdate = options.onTimeUpdate || null;
        this.onEnded = options.onEnded || null;
        this.onError = options.onError || null;
        this.onSaveToDesktop = options.onSaveToDesktop || null;
        this.onLoadRangeStartDrag = options.onLoadRangeStartDrag || null;
        this.onLoadRangeEndDrag = options.onLoadRangeEndDrag || null;
        this.placeholderText = options.placeholderText ?? "🎬 双击加载视频";

        this._video = null;
        this._videoSurface = null;
        this._controlsLayer = null;
        this._playOverlay = null;
        this._bottomBar = null;
        this._timeDisplay = null;
        this._progressContainer = null;
        this._progressBar = null;
        this._progressFill = null;
        this._progressThumb = null;
        this._progressShine = null; // 流星高亮流光
        this._loadRangeStart = null;
        this._loadRangeEnd = null;
        this._loadRangeFill = null;
        this._skipFrames = 0;
        this._frameLimit = 0;
        this._frameDisplay = null;
        this._placeholder = null;
        this._loadingSpinner = null;
        this._stage = null;
        this._contextMenu = null;
        this._contextMenuDesktop = null;
        this._contextMenuSaveAs = null;
        this._src = "";
        this._destroyed = false;
        this._dblClickTimer = null;
        this._clickHandled = false;
        this._isDragging = false;
        this._dragOverlay = null;
        this._manualFrameRate = false;
        this._backendFps = false;
        this._detectingFps = false;
        this._videoRatio = 16 / 9;
        this._customRatio = null;
        this._frameRate = 24;
        this._totalFrames = null; // 后端实际加载的帧数（优先使用）
        this._sourceTotalFrames = null; // 原始视频的总帧数（不受帧率调整影响）
        this._fpsDetected = false;
        this._resizeObserver = null;
        this._progressRafId = null;
        this._isDraggingMarker = false;
        this._draggingMarkerType = null;
        this._markerDragOverlay = null;
        this._markerDragStartFrame = 0;
        this._markerDragEndFrame = 0;
        // 循环/单次播放：false=单次（播放到蓝杠停止），true=循环（蓝杠→红杠重新开始）
        this._loopPlayback = false;
        this._loopBtn = null;

        this._buildDOM();
    }

    _buildDOM() {
        const el = this.container;
        el.style.position = "relative";
        el.style.width = "100%";
        el.style.height = "100%";
        el.style.background = DEFAULT_BG;
        el.style.overflow = "hidden";
        el.style.pointerEvents = "none";

        this._placeholder = document.createElement("div");
        this._placeholder.style.cssText =
            "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;" +
            "color:#666;font-size:12px;z-index:0;pointer-events:auto;cursor:pointer;";
        this._placeholder.textContent = this.placeholderText;
        if (this.onDblClick) {
            this._placeholder.addEventListener("dblclick", this._onPlaceholderDblClick);
        }
        this._placeholder.addEventListener("wheel", this._forwardWheel, { passive: false });
        el.appendChild(this._placeholder);

        this._stage = document.createElement("div");
        this._stage.style.cssText =
            "position:relative;width:100%;height:100%;display:flex;align-items:center;" +
            "justify-content:center;z-index:1;pointer-events:auto;";
        this._stage.addEventListener("wheel", this._forwardWheel, { passive: false });
        this._stage.addEventListener("dblclick", this._onStageDblClick);
        this._stage.addEventListener("contextmenu", this._onContextMenu);

        this._videoSurface = document.createElement("div");
        this._videoSurface.style.cssText =
            "position:relative;max-width:100%;max-height:100%;background:" + SURFACE_BG + ";" +
            "cursor:pointer;overflow:visible;display:none;pointer-events:auto;";
        this._videoSurface.addEventListener("click", this._onSurfaceClick);
        this._videoSurface.addEventListener("dblclick", this._onSurfaceDblClick);
        this._videoSurface.addEventListener("wheel", this._forwardWheel, { passive: false });
        this._videoSurface.addEventListener("contextmenu", this._onContextMenu);

        this._video = document.createElement("video");
        this._video.setAttribute("playsinline", "");
        this._video.controls = false;
        this._video.controlsList = "nodownload nofullscreen noremoteplayback";
        this._video.disablePictureInPicture = true;
        this._video.style.cssText =
            "width:100%;height:100%;display:block;background:#000;object-fit:fill;pointer-events:none;";
        this._video.preload = "metadata";

        this._video.addEventListener("loadedmetadata", this._onLoadedMeta);
        this._video.addEventListener("play", this._onPlayEvt);
        this._video.addEventListener("pause", this._onPauseEvt);
        this._video.addEventListener("ended", this._onEndedEvt);
        this._video.addEventListener("timeupdate", this._onTimeUpdateEvt);
        this._video.addEventListener("error", this._onErrorEvt);

        this._videoSurface.appendChild(this._video);

        // 加载进度图：旋转圆环
        this._loadingSpinner = document.createElement("div");
        this._loadingSpinner.style.cssText =
            "position:absolute;inset:0;display:none;align-items:center;justify-content:center;" +
            "z-index:5;pointer-events:none;background:rgba(0,0,0,0.3);";
        const spinnerRing = document.createElement("div");
        spinnerRing.style.cssText =
            "width:36px;height:36px;border:3px solid rgba(255,255,255,0.2);" +
            "border-top-color:#FFD700;border-radius:50%;" +
            "animation:xzgVideoSpin 0.8s linear infinite;";
        this._loadingSpinner.appendChild(spinnerRing);
        this._videoSurface.appendChild(this._loadingSpinner);

        // 注入 keyframes（仅一次）
        if (!document.getElementById("xzg-video-spin-style")) {
            const styleEl = document.createElement("style");
            styleEl.id = "xzg-video-spin-style";
            styleEl.textContent = "@keyframes xzgVideoSpin{to{transform:rotate(360deg);}}";
            document.head.appendChild(styleEl);
        }

        this._controlsLayer = document.createElement("div");
        this._controlsLayer.style.cssText =
            "position:absolute;inset:0;pointer-events:none;z-index:2;";

        // 中央三角播放标记 → 已隐藏，改用左下角小图标
        this._playOverlay = document.createElement("div");
        this._playOverlay.style.display = "none";

        // 循环/单次播放切换按钮（左上角）
        this._loopBtn = document.createElement("span");
        this._loopBtn.style.cssText =
            "position:absolute;left:6px;top:6px;z-index:15;" +
            "color:rgba(255,255,255,0.55);font-size:12px;font-family:sans-serif;" +
            "cursor:pointer;pointer-events:auto;user-select:none;" +
            "text-shadow:0 1px 3px rgba(0,0,0,0.6);" +
            "transition:color 0.15s;";
        this._loopBtn.textContent = "→";
        this._loopBtn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this._loopPlayback = !this._loopPlayback;
            this._loopBtn.textContent = this._loopPlayback ? "⇆" : "→";
            this._loopBtn.style.color = this._loopPlayback ? "#FFD700" : "rgba(255,255,255,0.55)";
        });
        this._controlsLayer.appendChild(this._loopBtn);

        this._bottomBar = document.createElement("div");
        this._bottomBar.style.cssText =
            "position:absolute;left:-1px;right:-1px;bottom:-1px;padding:0 0 4px;min-height:60px;" +
            "background:linear-gradient(transparent 0%,rgba(0,0,0,0.5) 40%,rgba(0,0,0,0.9) 100%);" +
            "display:flex;flex-direction:column-reverse;pointer-events:auto;z-index:10;";

        // 时间显示行（紧贴播放条上方），左下角：播放图标 + 时间 + 帧数
        const timeRow = document.createElement("div");
        timeRow.style.cssText =
            "display:flex;align-items:flex-end;padding:0 6px 0;" +
            "line-height:1;pointer-events:none;gap:6px;";

        this._timeDisplay = document.createElement("span");
        this._timeDisplay.style.cssText =
            "color:#fff;font-size:10px;font-family:monospace;" +
            "font-variant-numeric:tabular-nums;" +
            "width:80px;text-shadow:0 1px 3px rgba(0,0,0,0.6);";
        this._timeDisplay.textContent = "00:00 / 00:00";

        this._frameDisplay = document.createElement("span");
        this._frameDisplay.style.cssText =
            "color:#fff;font-size:10px;font-family:monospace;" +
            "font-variant-numeric:tabular-nums;" +
            "width:60px;text-align:right;" +
            "text-shadow:0 1px 3px rgba(0,0,0,0.6);";
        this._frameDisplay.textContent = "";

        timeRow.appendChild(this._timeDisplay);
        timeRow.appendChild(this._frameDisplay);

        // 播放条容器（离底部留空，避免贴近下边缘）
        this._progressContainer = document.createElement("div");
        this._progressContainer.style.cssText =
            "margin-bottom:12px;pointer-events:auto;";

        // 暗色播放条轨道（红蓝区间外始终为暗色）
        this._progressBar = document.createElement("div");
        this._progressBar.style.cssText =
            "width:100%;height:3px;background:rgba(255,255,255,0.04);" +
            "pointer-events:none;position:relative;";

        // 已播放填充（从红杠位置开始，始终亮白色）
        this._progressFill = document.createElement("div");
        this._progressFill.style.cssText =
            "position:absolute;left:0;top:0;height:100%;background:rgba(255,255,255,0.95);width:0%;" +
            "pointer-events:none;will-change:left,width;";

        // 激光小亮点（精确位于播放进度位置：一半在填充内，一半在填充外）
        this._progressShine = document.createElement("div");
        this._progressShine.style.cssText =
            "position:absolute;top:50%;right:0;transform:translate(50%,-50%);" +
            "width:3px;height:3px;border-radius:50%;" +
            "background:rgba(255,255,255,0.92);" +
            "pointer-events:none;z-index:5;" +
            "display:none;will-change:opacity,box-shadow,transform,width,height;" +
            "box-shadow:0 0 1.5px 0.6px rgba(255,255,255,0.6),0 0 3px 1.2px rgba(255,255,255,0.28);" +
            "filter:drop-shadow(0 0 1px rgba(255,255,255,0.5));" +
            "animation:xzgLaserPulse 0.9s ease-in-out infinite alternate;";
        this._progressFill.appendChild(this._progressShine);

        // 注入激光小亮点脉冲 keyframes（仅一次）
        if (!document.getElementById("xzg-video-shine-style")) {
            const styleEl = document.createElement("style");
            styleEl.id = "xzg-video-shine-style";
            styleEl.textContent = `
@keyframes xzgLaserPulse {
  0%   { opacity: 0.72; width:3px; height:3px;
         box-shadow:0 0 1.2px 0.5px rgba(255,255,255,0.5),0 0 2.5px 1px rgba(255,255,255,0.22);
         filter:drop-shadow(0 0 0.8px rgba(255,255,255,0.45));
         transform:translate(50%,-50%) scale(1); }
  50%  { opacity: 0.88; width:3.5px; height:3.5px;
         box-shadow:0 0 2px 0.8px rgba(255,255,255,0.72),0 0 4.5px 1.8px rgba(255,255,255,0.38);
         filter:drop-shadow(0 0 1.5px rgba(255,255,255,0.6));
         transform:translate(50%,-50%) scale(1.03); }
  100% { opacity: 0.78; width:3.1px; height:3.1px;
         box-shadow:0 0 1.5px 0.6px rgba(255,255,255,0.62),0 0 3.5px 1.4px rgba(255,255,255,0.3);
         filter:drop-shadow(0 0 1.1px rgba(255,255,255,0.52));
         transform:translate(50%,-50%) scale(1.01); }
}
`;
            document.head.appendChild(styleEl);
        }

        // 播放点圆点指示器（隐藏，不使用绿色圆形播放头）
        this._progressThumb = document.createElement("div");
        this._progressThumb.style.cssText =
            "position:absolute;background:transparent;border-radius:50%;" +
            "pointer-events:none;display:none;transform:translateX(-50%);" +
            "box-shadow:none;";

        // 加载区间填充（白色高亮，表示实际加载的帧范围）
        this._loadRangeFill = document.createElement("div");
        this._loadRangeFill.style.cssText =
            "position:absolute;top:0;height:100%;background:rgba(255,255,255,0.45);" +
            "pointer-events:none;display:none;";

        // 加载区间起始标记（红色竖线，表示跳过帧的分界，8px宽可拖拽）
        this._loadRangeStart = document.createElement("div");
        this._loadRangeStart.style.cssText =
            "position:absolute;top:-2px;width:8px;height:calc(100% + 4px);" +
            "background:linear-gradient(to right,transparent 3px,#ef4444 3px,#ef4444 5px,transparent 5px);" +
            "pointer-events:auto;display:none;transform:translateX(-50%);" +
            "cursor:ew-resize;z-index:5;" +
            "filter:drop-shadow(0 0 4px rgba(239,68,68,0.8));";

        // 加载区间结束标记（蓝色竖线，表示加载帧的分界，8px宽可拖拽）
        this._loadRangeEnd = document.createElement("div");
        this._loadRangeEnd.style.cssText =
            "position:absolute;top:-2px;width:8px;height:calc(100% + 4px);" +
            "background:linear-gradient(to right,transparent 3px,#3b82f6 3px,#3b82f6 5px,transparent 5px);" +
            "pointer-events:auto;display:none;transform:translateX(-50%);" +
            "cursor:ew-resize;z-index:5;" +
            "filter:drop-shadow(0 0 4px rgba(59,130,246,0.8));";

        this._progressBar.appendChild(this._loadRangeFill);
        this._progressBar.appendChild(this._loadRangeStart);
        this._progressBar.appendChild(this._loadRangeEnd);
        this._progressBar.appendChild(this._progressFill);
        this._progressBar.appendChild(this._progressThumb);
        this._progressContainer.appendChild(this._progressBar);
        // 标记条可拖拽
        this._loadRangeStart.addEventListener("pointerdown", this._onMarkerDown);
        this._loadRangeEnd.addEventListener("pointerdown", this._onMarkerDown);
        // 整个底部区域（渐变背景到进度条）都是拖动判定区
        this._bottomBar.addEventListener("pointerdown", this._onProgressDown);
        this._bottomBar.addEventListener("pointermove", this._onProgressMove);
        this._bottomBar.addEventListener("pointerup", this._onProgressUp);
        this._bottomBar.addEventListener("wheel", this._forwardWheel, { passive: false });

        // column-reverse 下先添加进度条容器（底部），再添加时间行（紧贴其上）
        this._bottomBar.appendChild(this._progressContainer);
        this._bottomBar.appendChild(timeRow);
        this._controlsLayer.appendChild(this._bottomBar);

        this._videoSurface.appendChild(this._controlsLayer);
        this._stage.appendChild(this._videoSurface);
        el.appendChild(this._stage);

        if (typeof ResizeObserver !== "undefined") {
            this._resizeObserver = new ResizeObserver(() => {
                this._updateSurfaceSize();
            });
            this._resizeObserver.observe(el);
        }

        requestAnimationFrame(() => this._updateSurfaceSize());

        // === 右键菜单 ===
        this._contextMenu = document.createElement("div");
        this._contextMenu.style.cssText =
            "position:fixed;display:none;z-index:99999;min-width:150px;" +
            "background:#2a2a2a;border:1px solid #444;border-radius:6px;" +
            "box-shadow:0 4px 12px rgba(0,0,0,0.5);padding:4px 0;pointer-events:auto;";
        const menuItemStyle =
            "padding:6px 16px;color:#ddd;cursor:pointer;font-size:12px;white-space:nowrap;";

        this._contextMenuDesktop = document.createElement("div");
        this._contextMenuDesktop.style.cssText = menuItemStyle;
        this._contextMenuDesktop.innerHTML =
            '<span style="display:inline-block;width:18px;">📥</span> 保存视频';
        this._contextMenuDesktop.addEventListener("click", (e) => {
            e.stopPropagation();
            this._hideContextMenu();
            this.onSaveToDesktop?.();
        });
        this._contextMenu.addEventListener("mouseleave", () => this._hideContextMenu());
        this._contextMenuDesktop.addEventListener("mouseenter", () => {
            this._contextMenuDesktop.style.background = "#3a3a3a";
        });
        this._contextMenuDesktop.addEventListener("mouseleave", () => {
            this._contextMenuDesktop.style.background = "";
        });

        this._contextMenu.appendChild(this._contextMenuDesktop);
        document.body.appendChild(this._contextMenu);

        document.addEventListener("click", this._onDocClick);
        document.addEventListener("keydown", this._onDocKeyDown);
    }

    _updateSurfaceSize() {
        if (!this._videoSurface || this._destroyed) return;
        const el = this.container;
        const containerW = el.clientWidth || el.offsetWidth || 320;
        const containerH = el.clientHeight || el.offsetHeight || 240;
        // 优先使用自定义比例，否则用视频原始比例
        const ratio = this._customRatio || this._videoRatio || 16 / 9;

        let w = containerW;
        let h = containerW / ratio;
        if (h > containerH) {
            h = containerH;
            w = containerH * ratio;
        }

        // 尺寸取整，避免亚像素渲染导致视频边缘漏底
        w = Math.round(w);
        h = Math.round(h);

        this._videoSurface.style.width = w + "px";
        this._videoSurface.style.height = h + "px";
        this._updateProgressBarSize(h);
    }

    _updateProgressBarSize(surfaceH) {
        // 播放条轨道高度 ≈ 视频高度的 0.6%（原1.2%缩减50%），最小 3px，最大 8px
        const barH = Math.max(3, Math.min(8, Math.round(surfaceH * 0.006)));
        // 点击热区高度 ≈ 轨道的 8 倍，最小 30px，最大 80px（保持不变，方便交互）
        const hitH = Math.max(30, Math.min(80, Math.round(barH * 8)));
        // 播放点圆点（已隐藏，无需调整尺寸）
        const thumbSize = barH + 6;
        const thumbTop = Math.round((barH - thumbSize) / 2);

        if (this._progressBar) {
            this._progressBar.style.height = barH + "px";
            const marginTop = Math.round((hitH - barH) / 2);
            this._progressBar.style.marginTop = marginTop + "px";
            // 帧刻度：每帧 1px 竖线
            this._updateFrameTicks();
        }
        if (this._progressThumb) {
            this._progressThumb.style.width = thumbSize + "px";
            this._progressThumb.style.height = thumbSize + "px";
            this._progressThumb.style.top = thumbTop + "px";
        }
    }

    _updateFrameTicks() {
        if (!this._video || !this._video.duration) return;
        const fps = this._frameRate || 24;
        const totalFrames = Math.round(this._video.duration * fps);
        if (totalFrames <= 1) return;
        const bar = this._progressBar;
        if (!bar) return;
        // 延时取 bar 宽度以确保布局完成
        requestAnimationFrame(() => {
            const barW = bar.offsetWidth || 300;
            // 帧边界线 = totalFrames - 1（第一帧在左边缘，最后一帧在右边缘）
            const boundaries = totalFrames - 1;
            const spacing = boundaries > 0 ? barW / boundaries : barW;
            if (spacing >= 2) {
                // 每个周期末尾画一条 1px 竖线作为帧边界，底色为暗色
                bar.style.background = `rgba(255,255,255,0.04) repeating-linear-gradient(
                    to right,
                    transparent 0px,
                    transparent ${spacing - 1}px,
                    rgba(255,255,255,0.10) ${spacing - 1}px,
                    rgba(255,255,255,0.10) ${spacing}px
                )`;
            } else {
                bar.style.background = 'rgba(255,255,255,0.04)';
            }
        });
    }

    _formatTime(seconds) {
        if (!isFinite(seconds) || seconds < 0) seconds = 0;
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }

    _onLoadedMeta = () => {
        if (this._video.videoWidth && this._video.videoHeight) {
            this._videoRatio = this._video.videoWidth / this._video.videoHeight;
            this._applyVideoFit();
            this._updateSurfaceSize();
        }
        this._placeholder.style.display = "none";
        this._updateLoadRangeMarkers();
        this.onLoadedMetadata?.(this);
    };

    _onPlayEvt = () => {
        this._startProgressRaf();
        this.autoDetectFps();
        // 播放时激活流星高亮流光
        if (this._progressShine) {
            this._progressShine.style.display = "block";
        }
        this.onPlay?.(this);
    };

    _onPauseEvt = () => {
        this._stopProgressRaf();
        // 暂停时隐藏流星光流（拖动中除外，拖动结束会单独处理）
        if (this._progressShine && !this._isDragging) {
            this._progressShine.style.display = "none";
        }
        this.onPause?.(this);
    };

    _onEndedEvt = () => {
        if (!this._isDragging && !this._isDraggingMarker) {
            this._stopProgressRaf();
            if (this._progressShine) {
                this._progressShine.style.display = "none";
            }
            if (this._loopPlayback) {
                // 循环模式：从红杠（跳过帧）位置重新开始
                const fps = this._frameRate || 24;
                this._video.currentTime = this._skipFrames / fps;
                this._video.play().catch(() => {});
            }
            // 单次模式：视频自然结束，不做额外处理
            this.onEnded?.(this);
        }
    };

    _updateProgressDisplay(cur, dur) {
        // 拖拽中：完全不更新视觉（参考 WhatDreamsCost：ontimeupdate 中 if(dragging) return）
        if (this._isDragging) return;

        if (dur > 0) {
            const fps = this._frameRate || 24;
            // 优先使用后端实际加载的帧数，避免前端推算误差
            const totalFrames = this._totalFrames || Math.max(1, Math.round(dur * fps));
            const curFrameIdx = Math.min(Math.floor(cur * fps), totalFrames - 1);
            const pct = totalFrames > 1 ? (curFrameIdx / (totalFrames - 1)) * 100 : 0;
            const startPct = this._getStartPct();
            this._progressFill.style.left = startPct + "%";
            this._progressFill.style.width = Math.max(0, pct - startPct) + "%";
            if (this._progressThumb) {
                this._progressThumb.style.left = pct + "%";
                this._progressThumb.style.display = "none";
            }
            if (this._frameDisplay) {
                if (!this._fpsDetected) {
                    this._frameDisplay.textContent = "";
                } else {
                    this._frameDisplay.textContent = `${curFrameIdx + 1} / ${totalFrames}`;
                }
            }
            this._timeDisplay.textContent = `${this._formatTime(cur)} / ${this._formatTime(dur)}`;
        }
    }

    _startProgressRaf() {
        this._stopProgressRaf();
        const loop = () => {
            if (this._destroyed || !this._video || this._video.paused) return;
            this._updateProgressDisplay(this._video.currentTime, this._video.duration || 0);
            this._progressRafId = requestAnimationFrame(loop);
        };
        this._progressRafId = requestAnimationFrame(loop);
    }

    _stopProgressRaf() {
        if (this._progressRafId != null) {
            cancelAnimationFrame(this._progressRafId);
            this._progressRafId = null;
        }
    }

    _onTimeUpdateEvt = () => {
        if (this._video && this._progressFill && this._timeDisplay) {
            const cur = this._video.currentTime;
            const dur = this._video.duration || 0;
            this._updateProgressDisplay(cur, dur);

            // 播放到蓝杠位置时停止或循环
            if (!this._isDragging && !this._isDraggingMarker && cur > 0) {
                const endFrame = this._computeEndFrame();
                const fps = this._frameRate || 24;
                const endTime = endFrame / fps;
                if (cur >= endTime - 0.05) {
                    if (this._loopPlayback) {
                        // 循环模式：跳回红杠位置重新开始
                        this._video.currentTime = this._skipFrames / fps;
                    } else {
                        // 单次模式：停止播放
                        this._video.pause();
                    }
                }
            }
        }
        this.onTimeUpdate?.(this);
    };

    _onErrorEvt = (e) => {
        if (this._video.error) {
            console.warn("[小珠光] 视频加载错误:", this._video.error);
        }
        // 加载失败时隐藏加载进度图
        if (this._loadingSpinner) this._loadingSpinner.style.display = "none";
        this.onError?.(this, e);
    };

    _onSurfaceClick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._clickHandled = true;
        setTimeout(() => {
            if (this._clickHandled) {
                this.togglePlay();
            }
        }, 200);
    };

    _onSurfaceDblClick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._clickHandled = false;
        this.onDblClick?.();
    };

    _onPlaceholderDblClick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.onDblClick?.();
    };

    _onStageDblClick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.onDblClick?.();
    };

    _forwardWheel = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const cv = app.canvas;
        if (!cv?.canvas || !cv?.ds) return;
        const ds = cv.ds;
        const minS = ds.min_scale || 0.1;
        const maxS = ds.max_scale || 10;

        // 鼠标滚轮 → 画布缩放（以鼠标所在位置为中心）
        const factor = e.deltaY > 0 ? 1 / 1.1 : 1.1;
        const ns = ds.scale * factor;
        if (ns < minS || ns > maxS) return;
        if (typeof ds.changeScale === "function") {
            ds.changeScale(ns, [e.clientX, e.clientY]);
        } else {
            ds.scale = ns;
        }
        cv.setDirty(true, true);
    };

    _seekByClientX(clientX) {
        if (!this._video || !this._video.duration) return;
        const fps = this._frameRate || 24;
        const rect = this._progressBar.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        // 优先使用后端实际加载的帧数
        const totalFrames = this._totalFrames || Math.max(1, Math.round(this._video.duration * fps));
        const endFrame = this._computeEndFrame();
        const frameIdx = Math.max(this._skipFrames, Math.min(Math.floor(ratio * totalFrames), endFrame));
        const pct = totalFrames > 1 ? (frameIdx / (totalFrames - 1)) * 100 : 0;
        // 视觉同步：填充从红杠位置开始，宽度实时跟随
        if (this._progressFill) {
            const startPct = this._getStartPct();
            this._progressFill.style.left = startPct + "%";
            this._progressFill.style.width = Math.max(0, pct - startPct) + "%";
        }
        if (this._progressThumb) {
            this._progressThumb.style.left = pct + "%";
            this._progressThumb.style.display = "none";
        }
        // 更新帧数和时间
        const curTime = (frameIdx + 0.5) / fps;
        this._timeDisplay.textContent = `${this._formatTime(curTime)} / ${this._formatTime(this._video.duration)}`;
        if (this._frameDisplay) {
            if (!this._fpsDetected) this._frameDisplay.textContent = "";
            else this._frameDisplay.textContent = `${frameIdx + 1} / ${totalFrames}`;
        }
        // seek 视频
        this.seek(curTime);
    }

    _onProgressDown = (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        // 先标记拖动状态，再 pause 视频
        this._isDragging = true;
        // 拖动时也显示流星光流，跟随播放头
        if (this._progressShine) {
            this._progressShine.style.display = "block";
        }
        this._video?.pause();
        if (this._video) {
            this._savedLoop = this._video.loop;
            this._video.loop = false;
        }
        this._seekByClientX(e.clientX);
        // 创建全屏遮罩，捕获拖动期间所有指针事件，防止穿透到画布
        if (!this._dragOverlay) {
            this._dragOverlay = document.createElement("div");
            this._dragOverlay.style.cssText =
                "position:fixed;inset:0;z-index:999999;cursor:ew-resize;" +
                "background:transparent;pointer-events:auto;";
        }
        document.body.appendChild(this._dragOverlay);
        this._dragOverlay.addEventListener("pointermove", this._onProgressMove);
        this._dragOverlay.addEventListener("pointerup", this._onProgressUp);
        this._dragOverlay.addEventListener("pointercancel", this._onProgressUp);
        // 兜底：mouseup 也监听
        window.addEventListener("mouseup", this._onProgressUp);
    };

    _onProgressMove = (e) => {
        if (!this._isDragging) return;
        e.preventDefault();
        e.stopPropagation();
        this._seekByClientX(e.clientX);
    };

    _cleanupDrag = () => {
        this._isDragging = false;
        // 拖动结束后：当前处于暂停状态，隐藏流星光流
        if (this._progressShine) {
            this._progressShine.style.display = "none";
        }
        if (this._dragOverlay) {
            this._dragOverlay.removeEventListener("pointermove", this._onProgressMove);
            this._dragOverlay.removeEventListener("pointerup", this._onProgressUp);
            this._dragOverlay.removeEventListener("pointercancel", this._onProgressUp);
            this._dragOverlay.remove();
        }
        window.removeEventListener("mouseup", this._onProgressUp);
        if (this._video && this._savedLoop !== undefined) {
            this._video.loop = this._savedLoop;
            this._savedLoop = undefined;
        }
    };

    _onProgressUp = (e) => {
        if (!this._isDragging) return;
        this._cleanupDrag();
        // 阻止后续 click 事件触发 togglePlay
        const suppressClick = (ev) => {
            ev.stopPropagation();
            ev.preventDefault();
            window.removeEventListener("click", suppressClick, true);
        };
        window.addEventListener("click", suppressClick, true);
    };

    // ── 标记条拖拽 ──

    _computeEndFrame() {
        const totalFrames = this.getSourceTotalFrames();
        if (!totalFrames) return 0;
        if (this._frameLimit > 0) {
            return Math.min(this._skipFrames + this._frameLimit, totalFrames) - 1;
        }
        return totalFrames - 1;
    }

    _getStartPct() {
        const totalFrames = this.getSourceTotalFrames();
        if (!totalFrames || totalFrames <= 1) return 0;
        return (this._skipFrames / (totalFrames - 1)) * 100;
    }

    _resetPlaybackToStart() {
        // 进度填充重置到红杠位置，宽度归零
        const startPct = this._getStartPct();
        if (this._progressFill) {
            this._progressFill.style.left = startPct + "%";
            this._progressFill.style.width = "0%";
        }
        // 视频跳转到红杠位置
        if (this._video) {
            const fps = this._frameRate || 24;
            this._video.currentTime = this._skipFrames > 0 ? this._skipFrames / fps : 0;
            // 更新时间/帧数显示
            if (this._timeDisplay) {
                this._timeDisplay.textContent = `${this._formatTime(this._video.currentTime)} / ${this._formatTime(this._video.duration || 0)}`;
            }
            if (this._frameDisplay) {
                if (!this._fpsDetected) {
                    this._frameDisplay.textContent = "";
                } else {
                    const totalFrames = this._totalFrames || this.getTotalFrames();
                    this._frameDisplay.textContent = `${this._skipFrames + 1} / ${totalFrames}`;
                }
            }
        }
    }

    _onMarkerDown = (e) => {
        if (e.button !== 0) return;
        if (!this._video || !this._video.duration) return;
        const totalFrames = this.getSourceTotalFrames();
        if (!totalFrames || totalFrames <= 1) return;

        e.preventDefault();
        e.stopPropagation();

        this._isDraggingMarker = true;
        this._draggingMarkerType = e.currentTarget === this._loadRangeStart ? 'start' : 'end';
        // 记录拖拽开始时另一端的约束位置
        this._markerDragStartFrame = this._skipFrames;
        this._markerDragEndFrame = this._computeEndFrame();

        if (this._video) {
            this._savedLoop = this._video.loop;
            this._video.loop = false;
            this._video.pause();
        }

        if (!this._markerDragOverlay) {
            this._markerDragOverlay = document.createElement("div");
            this._markerDragOverlay.style.cssText =
                "position:fixed;inset:0;z-index:999999;cursor:ew-resize;" +
                "background:transparent;pointer-events:auto;";
        }
        document.body.appendChild(this._markerDragOverlay);
        this._markerDragOverlay.addEventListener("pointermove", this._onMarkerMove);
        this._markerDragOverlay.addEventListener("pointerup", this._onMarkerUp);
        this._markerDragOverlay.addEventListener("pointercancel", this._onMarkerUp);
        window.addEventListener("mouseup", this._onMarkerUp);

        this._updateMarkerFromClientX(e.clientX);
    };

    _onMarkerMove = (e) => {
        if (!this._isDraggingMarker) return;
        e.preventDefault();
        e.stopPropagation();
        this._updateMarkerFromClientX(e.clientX);
    };

    _onMarkerUp = (e) => {
        if (!this._isDraggingMarker) return;
        const markerType = this._draggingMarkerType;
        this._isDraggingMarker = false;
        this._draggingMarkerType = null;

        if (this._markerDragOverlay) {
            this._markerDragOverlay.removeEventListener("pointermove", this._onMarkerMove);
            this._markerDragOverlay.removeEventListener("pointerup", this._onMarkerUp);
            this._markerDragOverlay.removeEventListener("pointercancel", this._onMarkerUp);
            this._markerDragOverlay.remove();
        }
        window.removeEventListener("mouseup", this._onMarkerUp);

        if (this._video && this._savedLoop !== undefined) {
            this._video.loop = this._savedLoop;
            this._savedLoop = undefined;
        }

        // 通知拖拽结束（isEnd=true）
        if (markerType === 'start') {
            this.onLoadRangeStartDrag?.(this._skipFrames, true);
        } else {
            this.onLoadRangeEndDrag?.(this._frameLimit, true);
        }
    };

    _updateMarkerFromClientX(clientX) {
        const totalFrames = this.getSourceTotalFrames();
        if (!totalFrames || totalFrames <= 1) return;

        const rect = this._progressBar.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        const frameIndex = Math.round(ratio * (totalFrames - 1));

        if (this._draggingMarkerType === 'start') {
            // 红杠：约束在 [0, endFrame]
            const clamped = Math.max(0, Math.min(frameIndex, this._markerDragEndFrame));
            this._skipFrames = clamped;
            this._updateLoadRangeMarkers();
            this._resetPlaybackToStart();
            this.onLoadRangeStartDrag?.(clamped, false);
        } else {
            // 蓝杠：约束在 [startFrame, totalFrames-1]
            const clamped = Math.max(this._markerDragStartFrame, Math.min(frameIndex, totalFrames - 1));
            // frameIndex → frameLimit（0=加载全部剩余帧）
            const frameLimit = (clamped >= totalFrames - 1) ? 0 : clamped - this._markerDragStartFrame + 1;
            this._frameLimit = frameLimit;
            this._updateLoadRangeMarkers();
            this._resetPlaybackToStart();
            this.onLoadRangeEndDrag?.(frameLimit, false);
        }
    }

    getSrc() {
        return this._src || "";
    }

    _onContextMenu = (e) => {
        e.preventDefault();
        if (!this._src) return;
        this._showContextMenu(e.clientX, e.clientY);
    };

    _showContextMenu(x, y) {
        const menu = this._contextMenu;
        if (!menu) return;
        const showDesktop = typeof this.onSaveToDesktop === "function";
        if (!showDesktop) return;
        this._contextMenuDesktop.style.display = showDesktop ? "" : "none";
        menu.style.left = x + "px";
        menu.style.top = y + "px";
        menu.style.display = "block";
        // 超出视口则反方向弹出
        requestAnimationFrame(() => {
            const rect = menu.getBoundingClientRect();
            if (rect.right > window.innerWidth) menu.style.left = (x - rect.width) + "px";
            if (rect.bottom > window.innerHeight) menu.style.top = (y - rect.height) + "px";
        });
    }

    _hideContextMenu = () => {
        if (this._contextMenu) this._contextMenu.style.display = "none";
    };

    _onDocClick = () => {
        this._hideContextMenu();
    };

    _onDocKeyDown = (e) => {
        if (e.key === "Escape") this._hideContextMenu();
    };

    /**
     * 下载视频：统一走 File System Access API（首次默认桌面，二次默认上次路径）。
     * @param {string} url - 视频 URL
     * @param {string} [filename] - 建议文件名（含扩展名），留空则自动生成带时间戳的文件名
     */
    static async downloadVideo(url, filename) {
        await downloadVideo(url, filename || `xzg-video-${xzgTimestamp()}.mp4`);
    }

    /**
     * 另存为视频：与 downloadVideo 相同逻辑，首次默认桌面，二次默认上次路径。
     */
    static async saveAsVideo(url, filename) {
        await downloadVideo(url, filename || `xzg-video-${xzgTimestamp()}.mp4`);
    }

    resize() {
        this._updateSurfaceSize();
    }

    _resetProgress() {
        if (this._progressFill) {
            this._progressFill.style.left = "0%";
            this._progressFill.style.width = "0%";
        }
        // 重置时隐藏流星光流
        if (this._progressShine) {
            this._progressShine.style.display = "none";
        }
        if (this._progressThumb) {
            this._progressThumb.style.left = "0%";
            this._progressThumb.style.display = "none";
        }
        if (this._timeDisplay) this._timeDisplay.textContent = "00:00 / 00:00";
        if (this._frameDisplay) this._frameDisplay.textContent = "";
    }

    load(src) {
        if (this._destroyed) return;
        this._src = src || "";
        // 加载新视频时重置帧率检测状态
        this._backendFps = false;
        // 强制帧率模式下保留 _fpsDetected 状态，避免 autoDetectFps 被阻塞后帧率显示丢失
        if (!this._manualFrameRate) {
            this._fpsDetected = false;
        }
        this._sourceFps = null;
        this._sourceTotalFrames = null;
        this._totalFrames = null;
        if (this._loadRangeStart) this._loadRangeStart.style.display = "none";
        if (this._loadRangeEnd) this._loadRangeEnd.style.display = "none";
        if (this._loadRangeFill) this._loadRangeFill.style.display = "none";
        if (this._video) {
            this._video.pause();
            this._stopProgressRaf();
            this._resetProgress();
            if (src) {
                this._video.src = src;
                this._video.load();
                this._placeholder.style.display = "none";
                this._videoSurface.style.display = "block";
                // 显示加载进度图
                if (this._loadingSpinner) this._loadingSpinner.style.display = "flex";
                // 立即注册监听器，避免 rAF 滞后导致 video 已缓存时 loadedmetadata 提前触发
                const onMeta = () => {
                    this._video.removeEventListener("loadedmetadata", onMeta);
                    this.autoDetectFps();
                    this._updateDisplay();
                    const onCanPlay = () => {
                        this._video.removeEventListener("canplay", onCanPlay);
                        this._updateDisplay();
                        // 视频可播放时隐藏加载进度图
                        if (this._loadingSpinner) this._loadingSpinner.style.display = "none";
                    };
                    this._video.addEventListener("canplay", onCanPlay);
                };
                this._video.addEventListener("loadedmetadata", onMeta);
                requestAnimationFrame(() => {
                    this._updateSurfaceSize();
                });
            } else {
                this._video.removeAttribute("src");
                this._video.load();
                this._placeholder.style.display = "flex";
                this._videoSurface.style.display = "none";
                this._videoRatio = 16 / 9;
                if (this._loadingSpinner) this._loadingSpinner.style.display = "none";
            }
        }
    }

    play() {
        if (this._video && this._src) {
            const fps = this._frameRate || 24;
            const cur = this._video.currentTime;
            const startTime = this._skipFrames / fps;
            const endFrame = this._computeEndFrame();
            const endTime = endFrame / fps;
            // 仅当当前位置在红蓝区间外时，才从红杠开始播放
            if (cur < startTime || cur >= endTime) {
                this._video.currentTime = startTime;
            }
            this._video.play().catch(() => {});
        }
    }

    pause() {
        this._video?.pause();
    }

    togglePlay() {
        if (!this._video || !this._src) return;
        if (this._video.paused) {
            this.play();
        } else {
            this.pause();
        }
    }

    seek(time) {
        if (this._video) this._video.currentTime = time;
    }

    setMuted(muted) {
        if (this._video) this._video.muted = !!muted;
    }

    setPlaybackRate(rate) {
        if (this._video) this._video.playbackRate = rate;
    }

    setLoop(loop) {
        if (this._video) this._video.loop = !!loop;
    }

    setCustomSize(w, h) {
        const cw = Math.max(0, Math.floor(w || 0));
        const ch = Math.max(0, Math.floor(h || 0));
        if (cw > 0 && ch > 0) {
            this._customRatio = cw / ch;
        } else {
            this._customRatio = null;
        }
        this._applyVideoFit();
        this._updateSurfaceSize();
    }

    _applyVideoFit() {
        if (!this._video) return;
        if (!this._customRatio || !this._videoRatio) {
            // 无自定义比例 → 拉伸填满
            this._video.style.objectFit = "fill";
            this._video.style.objectPosition = "center";
            return;
        }
        const src_ar = this._videoRatio;
        const dst_ar = this._customRatio;
        if (Math.abs(src_ar - dst_ar) < 0.01) {
            // 宽高比一致 → 拉伸填满（仅分辨率调整）
            this._video.style.objectFit = "fill";
            this._video.style.objectPosition = "center";
        } else {
            // 宽高比不同 → cover 模式（居中裁剪）
            this._video.style.objectFit = "cover";
            this._video.style.objectPosition = "center";
        }
    }

    setFrameRate(fps) {
        if (typeof fps === "number" && fps > 0) {
            this._frameRate = fps;
            this._manualFrameRate = true;
            this._backendFps = false;
            this._fpsDetected = true;
            this._updateProgressBarSize(this._videoSurface?.offsetHeight || 200);
            this._updateProgressDisplay(this._video?.currentTime || 0, this._video?.duration || 0);
            this._updateLoadRangeMarkers();
            this.onFpsChange?.(fps);
        }
    }

    resetFrameRate() {
        this._manualFrameRate = false;
        this._backendFps = false;
        this._fpsDetected = false;
        this._totalFrames = null;
        this._frameRate = 24;
        this._updateProgressBarSize(this._videoSurface?.offsetHeight || 200);
        this._updateDisplay();
        this._updateLoadRangeMarkers();
        this.onFpsChange?.(24);
        // 触发自动检测（如果视频正在播放）
        requestAnimationFrame(() => this.autoDetectFps());
    }

    applyBackendFps(fps) {
        if (typeof fps === "number" && fps > 0) {
            this._frameRate = fps;
            this._backendFps = true;
            this._fpsDetected = true;
            this._updateFrameTicks();
            this._updateDisplay();
            this._updateLoadRangeMarkers();
            this.onFpsChange?.(fps);
        }
    }

    getFrameRate() {
        return this._frameRate || 24;
    }

    getTotalFrames() {
        if (this._totalFrames) return this._totalFrames;
        if (this._video && this._video.duration > 0) {
            return Math.max(1, Math.round(this._video.duration * (this._frameRate || 24)));
        }
        return 0;
    }

    getSourceTotalFrames() {
        if (this._sourceTotalFrames) return this._sourceTotalFrames;
        if (this._video && this._video.duration > 0) {
            const srcFps = this._sourceFps || this._frameRate || 24;
            return Math.max(1, Math.round(this._video.duration * srcFps));
        }
        return 0;
    }

    setTotalFrames(count) {
        if (typeof count === "number" && count > 0) {
            this._totalFrames = count;
            if (this._sourceTotalFrames === null) {
                this._sourceTotalFrames = count;
            }
            this._updateFrameTicks();
            this._updateDisplay();
            this._updateLoadRangeMarkers();
        }
    }

    setLoadRange(skipFrames, frameLimit) {
        this._skipFrames = Math.max(0, parseInt(skipFrames) || 0);
        this._frameLimit = Math.max(0, parseInt(frameLimit) || 0);
        this._updateLoadRangeMarkers();
        this._resetPlaybackToStart();
    }

    _updateLoadRangeMarkers() {
        if (!this._progressBar || !this._video || !this._video.duration) return;
        const totalSourceFrames = this.getSourceTotalFrames();
        if (!totalSourceFrames || totalSourceFrames <= 1) {
            if (this._loadRangeStart) this._loadRangeStart.style.display = "none";
            if (this._loadRangeEnd) this._loadRangeEnd.style.display = "none";
            if (this._loadRangeFill) this._loadRangeFill.style.display = "none";
            return;
        }
        const startFrame = this._skipFrames;
        let endFrame;
        if (this._frameLimit > 0) {
            endFrame = Math.min(startFrame + this._frameLimit, totalSourceFrames) - 1;
        } else {
            endFrame = totalSourceFrames - 1;
        }
        if (startFrame >= totalSourceFrames || endFrame < 0 || startFrame > endFrame) {
            if (this._loadRangeStart) this._loadRangeStart.style.display = "none";
            if (this._loadRangeEnd) this._loadRangeEnd.style.display = "none";
            if (this._loadRangeFill) this._loadRangeFill.style.display = "none";
            return;
        }
        const denom = totalSourceFrames - 1;
        const startPct = (startFrame / denom) * 100;
        const endPct = (endFrame / denom) * 100;
        // 竖杠宽 2px + translateX(-50%) → 左右各 1px。边界处需偏移避免被 overflow:hidden 裁剪
        const barW = this._progressBar.offsetWidth || 300;
        const edgeOffsetPct = barW > 0 ? (1 / barW) * 100 : 0.35;
        // 红色引导线始终显示（跳过帧数=0 时在最左侧 0% 位置）
        if (this._loadRangeStart) {
            this._loadRangeStart.style.display = "block";
            this._loadRangeStart.style.left = Math.max(edgeOffsetPct, startPct) + "%";
        }
        // 蓝色引导线始终显示（帧数上限=0 时在最右侧 100% 位置）
        if (this._loadRangeEnd) {
            this._loadRangeEnd.style.display = "block";
            this._loadRangeEnd.style.left = Math.min(100 - edgeOffsetPct, endPct) + "%";
        }
        // 加载区间填充始终显示
        if (this._loadRangeFill) {
            this._loadRangeFill.style.display = "block";
            this._loadRangeFill.style.left = startPct + "%";
            this._loadRangeFill.style.width = (endPct - startPct) + "%";
        }
    }

    autoDetectFps() {
        if (this._manualFrameRate || this._backendFps || this._detectingFps) return;
        const video = this._video;
        if (!video || !video.src) return;
        this._detectingFps = true;

        // 方案 A：用隐藏的 offscreen video 解码，不影响主视频画面
        if (typeof HTMLVideoElement.prototype.requestVideoFrameCallback === "function") {
            // 创建离屏 video（不挂载到 DOM，不显示）
            const probe = document.createElement("video");
            probe.src = video.src;
            probe.muted = true;
            probe.style.position = "absolute";
            probe.style.width = "1px";
            probe.style.height = "1px";
            probe.style.opacity = "0";
            probe.style.pointerEvents = "none";
            probe.style.left = "-9999px";
            document.body.appendChild(probe);

            let prevMediaTime = null;
            const samples = [];
            let seekCount = 0;
            const maxSeeks = 20;
            const initialFps = this._frameRate || 24;
            const step = 1 / initialFps;
            let seekTarget = 0;
            let done = false;

            const cleanup = () => {
                done = true;
                this._detectingFps = false;
                try { probe.pause(); probe.removeAttribute("src"); probe.load(); } catch (_) {}
                probe.remove();
            };

            const onMeta = () => {
                probe.removeEventListener("loadedmetadata", onMeta);
                const dur = probe.duration || 0;
                const cb = (now, metadata) => {
                    if (done || this._destroyed || this._backendFps) {
                        cleanup();
                        return;
                    }
                    const mt = metadata.mediaTime;
                    if (prevMediaTime !== null) {
                        const dt = mt - prevMediaTime;
                        if (dt > 0.001 && dt < 1) samples.push(dt);
                    }
                    prevMediaTime = mt;
                    seekCount++;
                    if (samples.length >= 8 || seekCount >= maxSeeks) {
                        cleanup();
                        if (samples.length > 0) {
                            samples.sort((a, b) => a - b);
                            const median = samples[Math.floor(samples.length / 2)];
                            const detectedFps = Math.round(1 / median);
                        if (detectedFps >= 1 && detectedFps <= 120) {
                            this._frameRate = detectedFps;
                            this._fpsDetected = true;
                            this._updateFrameTicks();
                            this._updateDisplay();
                            this._updateLoadRangeMarkers();
                            this.onFpsChange?.(detectedFps);
                        }
                        }
                    } else {
                        seekTarget += step;
                        if (dur > 0 && seekTarget >= dur) seekTarget = 0;
                        probe.currentTime = seekTarget;
                        probe.requestVideoFrameCallback(cb);
                    }
                };
                probe.currentTime = 0;
                probe.requestVideoFrameCallback(cb);
            };
            probe.addEventListener("loadedmetadata", onMeta);
            // 加载超时保护
            setTimeout(() => { if (!done && samples.length === 0) cleanup(); }, 8000);
            return;
        }

        // 方案 B：不支持 requestVideoFrameCallback 时，等待后端 onExecuted 提供
        this._detectingFps = false;
    }

    _updateDisplay() {
        // 一次性刷新当前进度显示，供检测 fps 后调用
        this._updateProgressDisplay(this._video?.currentTime || 0, this._video?.duration || 0);
    }

    get isPlaying() { return this._video ? !this._video.paused : false; }
    get currentTime() { return this._video?.currentTime ?? 0; }
    get duration() { return this._video?.duration ?? 0; }
    get videoWidth() { return this._video?.videoWidth ?? 0; }
    get videoHeight() { return this._video?.videoHeight ?? 0; }
    get videoElement() { return this._video; }
    get src() { return this._src; }

    setPlaceholder(text) {
        if (this._placeholder) this._placeholder.textContent = text;
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this._stopProgressRaf();
        if (this._dblClickTimer) {
            clearTimeout(this._dblClickTimer);
            this._dblClickTimer = null;
        }
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
            this._resizeObserver = null;
        }
        if (this._placeholder) {
            this._placeholder.removeEventListener("dblclick", this._onPlaceholderDblClick);
            this._placeholder.removeEventListener("wheel", this._forwardWheel);
            this._placeholder.remove();
        }
        if (this._bottomBar) {
            this._bottomBar.removeEventListener("mousedown", this._onProgressDown);
            this._bottomBar.removeEventListener("wheel", this._forwardWheel);
        }
        // 清理可能的拖拽监听残留
        document.removeEventListener("mousemove", this._onProgressMove);
        document.removeEventListener("mouseup", this._onProgressUp);
        window.removeEventListener("mouseup", this._onMarkerUp);
        if (this._markerDragOverlay) {
            this._markerDragOverlay.removeEventListener("pointermove", this._onMarkerMove);
            this._markerDragOverlay.removeEventListener("pointerup", this._onMarkerUp);
            this._markerDragOverlay.removeEventListener("pointercancel", this._onMarkerUp);
            this._markerDragOverlay.remove();
            this._markerDragOverlay = null;
        }
        if (this._loadRangeStart) {
            this._loadRangeStart.removeEventListener("pointerdown", this._onMarkerDown);
        }
        if (this._loadRangeEnd) {
            this._loadRangeEnd.removeEventListener("pointerdown", this._onMarkerDown);
        }
        if (this._videoSurface) {
            this._videoSurface.removeEventListener("click", this._onSurfaceClick);
            this._videoSurface.removeEventListener("dblclick", this._onSurfaceDblClick);
            this._videoSurface.removeEventListener("wheel", this._forwardWheel);
            this._videoSurface.removeEventListener("contextmenu", this._onContextMenu);
        }
        if (this._video) {
            this._video.pause();
            this._video.removeAttribute("src");
            this._video.load();
            this._video.removeEventListener("loadedmetadata", this._onLoadedMeta);
            this._video.removeEventListener("play", this._onPlayEvt);
            this._video.removeEventListener("pause", this._onPauseEvt);
            this._video.removeEventListener("ended", this._onEndedEvt);
            this._video.removeEventListener("timeupdate", this._onTimeUpdateEvt);
            this._video.removeEventListener("error", this._onErrorEvt);
        }
        if (this._placeholder) this._placeholder.remove();
        if (this._loadingSpinner) this._loadingSpinner.remove();
        if (this._video) this._video.remove();
        if (this._videoSurface) this._videoSurface.remove();
        if (this._progressContainer) this._progressContainer.remove();
        if (this._progressThumb) this._progressThumb.remove();
        if (this._frameDisplay) this._frameDisplay.remove();
        if (this._stage) {
            this._stage.removeEventListener("wheel", this._forwardWheel);
            this._stage.removeEventListener("dblclick", this._onStageDblClick);
            this._stage.removeEventListener("contextmenu", this._onContextMenu);
            this._stage.remove();
        }
        this._video = null;
        this._videoSurface = null;
        this._loadingSpinner = null;
        this._controlsLayer = null;
        this._playOverlay = null;
        this._bottomBar = null;
        this._timeDisplay = null;
        this._progressContainer = null;
        this._progressBar = null;
        this._progressFill = null;
        this._progressThumb = null;
        this._progressShine = null;
        this._loadRangeStart = null;
        this._loadRangeEnd = null;
        this._loadRangeFill = null;
        this._frameDisplay = null;
        this._loopBtn = null;
        this._placeholder = null;
        this._stage = null;
        this._progressRafId = null;
        if (this._contextMenu) {
            document.removeEventListener("click", this._onDocClick);
            document.removeEventListener("keydown", this._onDocKeyDown);
            this._contextMenu.remove();
        }
        this._contextMenu = null;
        this._contextMenuDesktop = null;
    }
}

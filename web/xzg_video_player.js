/**
 * 小珠光视频播放器 · Canvas 解码架构
 *
 * 架构设计：
 *   container (根容器)
 *     ├─ videoStage (视频舞台，背景深色)
 *     │    └─ videoSurface (视频画面区域，自适应比例，居中，响应点击)
 *     │         └─ <canvas> (Canvas 解码渲染目标)
 *     │    └─ controlsLayer (控制层，悬浮在视频上)
 *     │         ├─ playOverlay (中央播放/暂停图标)
 *     │         └─ bottomBar (底部控制条：进度条、时间等)
 *     └─ placeholder (无视频时的提示)
 *
 * 核心特性：
 *   - 精确点击区域：只有视频画面区域(videoSurface)响应播放/暂停/双击
 *   - 完全自主控制：无浏览器原生controls，双击不全屏
 *   - 模块化：controlsLayer可独立扩展控制功能
 *   - 高性能：Canvas 直接解码（mediabunny + WebCodecs），无 keyframe 限制
 *   - 响应式：自适应容器，保持视频宽高比
 *
 * 渲染管线：decoderPool → VideoDecoderInstance.renderFrame → canvas
 *   - 帧缓存命中零延迟 drawImage
 *   - 最近帧降级显示（拖动永不卡顿）
 *   - RAF 节流（mousemove 合并到每帧一次）
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
    downloadVideo,
    xzgTimestamp,
} from "./xzg_save_utils.js";
import { loaderDecoderPool } from "./xzg_frame_decoder.js";

// mediabunny 库加载状态（懒加载）
let _mbLoaded = false;
async function _ensureMediabunny() {
    if (_mbLoaded || window.mb) { _mbLoaded = true; return; }
    await import("./lib/mediabunny.min.mjs").then(m => {
        window.mb = m.default || m;
        _mbLoaded = true;
    }).catch(e => {
        console.error("[小珠光] mediabunny 加载失败:", e);
        throw e;
    });
}

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
        this.onSourceFpsDetected = options.onSourceFpsDetected || null;
        this.placeholderText = options.placeholderText ?? "🎬 双击加载视频";

        this._canvas = null;          // Canvas 渲染目标（替代 <video>）
        this._currentDecoder = null;  // 当前 VideoDecoderInstance
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
        // 红蓝条对应的帧数显示（红=起点/跳过帧数，蓝=终点/帧数上限）
        this._redFrameDisplay = null;
        this._blueFrameDisplay = null;
        this._placeholder = null;
        this._loadingSpinner = null;
        this._stage = null;
        this._contextMenu = null;
        this._contextMenuDesktop = null;
        this._contextMenuSaveAs = null;
        this._src = "";
        this._currentFilename = "";  // 当前视频文件名（用于 decoderPool key）
        this._currentType = "input";  // 当前视频类型
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
        this._sourceFps = null;    // 原始视频帧率（decoder.fps）
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
        // 静音状态
        this._muted = false;
        this._muteBtn = null;
        this._buttonRow = null;

        // ── Canvas 解码相关状态 ──
        this._scrubRafId = null;        // seek RAF 节流 ID
        this._playbackRaf = 0;          // 播放循环 RAF ID
        this._playbackIterator = null;  // 播放迭代器
        this._playbackIteratorDone = false;  // 迭代器是否已耗尽（所有源帧已解码完）
        this._playbackBuffer = [];      // 预缓冲队列
        this._playbackBufferSize = 10;  // 预缓冲帧数
        this._playbackStartFrame = 0;   // 播放起始帧
        this._playbackStartTime = 0;    // 播放起始时间（performance.now）
        this._isBuffering = false;      // 预缓冲锁
        this._audioCtx = null;          // AudioContext
        this._audioGain = null;         // 音量控制节点
        this._audioSource = null;       // 当前音频源
        this._fullAudioBuffer = null;   // 完整音频缓冲
        this._audioPlayStartTime = 0;   // 音频播放起始时间
        this._audioPlayStartOffset = 0; // 音频播放起始偏移
        this._currentTime = 0;          // 当前播放时间（秒）
        this._isPlayingState = false;   // 播放状态（P7: 显式初始化）
        this._playbackRate = 1;         // 播放速率（P16: 支持变速）
        this._loadToken = 0;            // 加载竞态 guard（P1）
        this._audioDecoding = false;    // 音频解码中标志（P4: 防止重复解码）

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

        // Canvas 解码渲染目标（替代 <video>）
        this._canvas = document.createElement("canvas");
        this._canvas.style.cssText =
            "width:100%;height:100%;display:block;background:#000;object-fit:fill;pointer-events:none;";
        this._videoSurface.appendChild(this._canvas);

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

        // 播放模式按钮行（左下角，时间码上方）
        this._buttonRow = document.createElement("div");
        this._buttonRow.style.cssText =
            "display:flex;align-items:center;padding:0 6px 4px;gap:8px;" +
            "pointer-events:none;";

        // 循环/单次播放切换按钮（金黄色）
        this._loopBtn = document.createElement("span");
        this._loopBtn.style.cssText =
            "color:#FFD700;font-size:12px;font-family:sans-serif;" +
            "cursor:pointer;pointer-events:auto;user-select:none;" +
            "text-shadow:0 1px 3px rgba(0,0,0,0.6);" +
            "transition:color 0.15s;";
        this._loopBtn.textContent = "→";
        this._loopBtn.addEventListener("pointerdown", (e) => { e.stopPropagation(); });
        this._loopBtn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this._loopPlayback = !this._loopPlayback;
            this._loopBtn.textContent = this._loopPlayback ? "⇆" : "→";
        });
        this._buttonRow.appendChild(this._loopBtn);

        // 静音按钮（播放模式按钮右侧，金黄色）
        this._muteBtn = document.createElement("span");
        this._muteBtn.style.cssText =
            "color:#FFD700;font-size:12px;font-family:sans-serif;" +
            "cursor:pointer;pointer-events:auto;user-select:none;" +
            "text-shadow:0 1px 3px rgba(0,0,0,0.6);" +
            "transition:color 0.15s;";
        this._muteBtn.textContent = "🔊";
        this._muteBtn.addEventListener("pointerdown", (e) => { e.stopPropagation(); });
        this._muteBtn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this._muted = !this._muted;
            this._applyMute();
            this._muteBtn.textContent = this._muted ? "🔇" : "🔊";
        });
        this._buttonRow.appendChild(this._muteBtn);

        this._bottomBar = document.createElement("div");
        this._bottomBar.style.cssText =
            "position:absolute;left:-1px;right:-1px;bottom:-1px;padding:0 0 4px;" +
            "display:flex;flex-direction:column-reverse;pointer-events:auto;z-index:10;";

        // 时间显示行（紧贴播放条上方），左下角：时间码
        const timeRow = document.createElement("div");
        timeRow.style.cssText =
            "display:flex;align-items:flex-end;padding:0 6px 0;" +
            "line-height:1;pointer-events:none;gap:6px;";

        this._timeDisplay = document.createElement("span");
        this._timeDisplay.style.cssText =
            "color:#fff;font-size:8px;font-family:monospace;" +
            "font-variant-numeric:tabular-nums;" +
            "width:64px;text-shadow:0 1px 3px rgba(0,0,0,0.6);";
        this._timeDisplay.textContent = "00:00 / 00:00";

        // 白色帧数显示（紧贴播放条上方，靠视频右边右对齐）
        this._frameDisplay = document.createElement("span");
        this._frameDisplay.style.cssText =
            "color:#fff;font-size:8px;font-family:monospace;" +
            "font-variant-numeric:tabular-nums;text-shadow:0 1px 3px rgba(0,0,0,0.6);" +
            "white-space:nowrap;pointer-events:none;margin-left:auto;";
        this._frameDisplay.textContent = "";

        timeRow.appendChild(this._timeDisplay);
        timeRow.appendChild(this._frameDisplay);

        // 播放条容器（离底部留空，避免贴近下边缘）
        this._progressContainer = document.createElement("div");
        this._progressContainer.style.cssText =
            "margin-bottom:12px;position:relative;pointer-events:none;";

        // 播放条阴影渐变层：绝对定位跟随播放条实际位置，上下各 5px，透明度 0-50-0
        // pointer-events:none 纯视觉层，不影响底部拖动判定区
        this._progressShade = document.createElement("div");
        this._progressShade.style.cssText =
            "position:absolute;left:-1px;right:-1px;pointer-events:none;" +
            "background:linear-gradient(transparent 0%,rgba(0,0,0,0.5) 50%,transparent 100%);";

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

        // 红色竖线上方的帧数标签（作为进度条子元素，直接相对进度条定位避免边缘裁剪）
        this._redFrameDisplay = document.createElement("span");
        this._redFrameDisplay.style.cssText =
            "position:absolute;bottom:calc(100% + 2px);left:0;transform:translateX(0);" +
            "color:#FF5555;font-size:7px;font-family:monospace;" +
            "font-variant-numeric:tabular-nums;" +
            "text-shadow:0 1px 3px rgba(0,0,0,0.6);" +
            "white-space:nowrap;pointer-events:none;z-index:6;";
        this._redFrameDisplay.textContent = "";

        // 加载区间结束标记（蓝色竖线，表示加载帧的分界，8px宽可拖拽）
        this._loadRangeEnd = document.createElement("div");
        this._loadRangeEnd.style.cssText =
            "position:absolute;top:-2px;width:8px;height:calc(100% + 4px);" +
            "background:linear-gradient(to right,transparent 3px,#3b82f6 3px,#3b82f6 5px,transparent 5px);" +
            "pointer-events:auto;display:none;transform:translateX(-50%);" +
            "cursor:ew-resize;z-index:5;" +
            "filter:drop-shadow(0 0 4px rgba(59,130,246,0.8));";

        // 蓝色竖线上方的帧数标签（作为进度条子元素，直接相对进度条定位避免边缘裁剪）
        this._blueFrameDisplay = document.createElement("span");
        this._blueFrameDisplay.style.cssText =
            "position:absolute;bottom:calc(100% + 2px);left:0;transform:translateX(0);" +
            "color:#5599FF;font-size:7px;font-family:monospace;" +
            "font-variant-numeric:tabular-nums;" +
            "text-shadow:0 1px 3px rgba(0,0,0,0.6);" +
            "white-space:nowrap;pointer-events:none;z-index:6;";
        this._blueFrameDisplay.textContent = "";

        this._progressBar.appendChild(this._loadRangeFill);
        this._progressBar.appendChild(this._loadRangeStart);
        this._progressBar.appendChild(this._loadRangeEnd);
        this._progressBar.appendChild(this._redFrameDisplay);
        this._progressBar.appendChild(this._blueFrameDisplay);
        this._progressBar.appendChild(this._progressFill);
        this._progressBar.appendChild(this._progressThumb);
        this._progressContainer.appendChild(this._progressShade);
        this._progressContainer.appendChild(this._progressBar);
        // 标记条可拖拽
        this._loadRangeStart.addEventListener("pointerdown", this._onMarkerDown);
        this._loadRangeEnd.addEventListener("pointerdown", this._onMarkerDown);
        // 整个底部区域（渐变背景到进度条）都是拖动判定区
        this._bottomBar.addEventListener("pointerdown", this._onProgressDown);
        this._bottomBar.addEventListener("pointermove", this._onProgressMove);
        this._bottomBar.addEventListener("pointerup", this._onProgressUp);
        this._bottomBar.addEventListener("wheel", this._forwardWheel, { passive: false });

        // column-reverse 下先添加进度条容器（底部），再添加时间行（紧贴其上），最后添加按钮行（最上层）
        this._bottomBar.appendChild(this._progressContainer);
        this._bottomBar.appendChild(timeRow);
        this._bottomBar.appendChild(this._buttonRow);
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
            // 阴影渐变层跟随播放条实际位置：上下各 5px，保证阴影中心与播放条精确对齐
            if (this._progressShade) {
                this._progressShade.style.top = (marginTop - 5) + "px";
                this._progressShade.style.height = (barH + 10) + "px";
            }
            // 帧刻度：每帧 1px 竖线
            this._updateFrameTicks();
            // 进度条宽度变化后，重新定位红蓝帧号标签（像素定位需跟随 resize）
            this._repositionRangeLabels();
        }
        if (this._progressThumb) {
            this._progressThumb.style.width = thumbSize + "px";
            this._progressThumb.style.height = thumbSize + "px";
            this._progressThumb.style.top = thumbTop + "px";
        }
    }

    // 重新定位红蓝帧号标签：resize 后进度条宽度变化，像素定位的标签需要重算
    _repositionRangeLabels() {
        if (!this._progressBar || !this._canvas) return;
        const dur = this.duration;
        if (dur <= 0) return;
        const barW = this._progressBar.offsetWidth || 300;
        // 从竖线的 left 百分比反推标签位置，确保标签始终紧跟竖线
        if (this._loadRangeStart && this._loadRangeStart.style.display !== "none") {
            const leftPct = parseFloat(this._loadRangeStart.style.left) || 0;
            this._positionRedLabel(leftPct, barW);
        }
        if (this._loadRangeEnd && this._loadRangeEnd.style.display !== "none") {
            const leftPct = parseFloat(this._loadRangeEnd.style.left) || 0;
            this._positionBlueLabel(leftPct, barW);
        }
    }

    _updateFrameTicks() {
        const dur = this.duration;
        if (!this._canvas || dur <= 0) return;
        const fps = this._frameRate || 24;
        const totalFrames = Math.round(dur * fps);
        if (totalFrames <= 1) return;
        const bar = this._progressBar;
        if (!bar) return;
        // 延时取 bar 宽度以确保布局完成
        requestAnimationFrame(() => {
            // P18: 防御 destroyed
            if (this._destroyed) return;
            const barW = bar.offsetWidth || 300;
            // 帧边界线 = totalFrames（进度条按帧数等分：30 帧 → 30 格 → 31 个刻度点 0~30）
            const boundaries = totalFrames;
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

    // 更新红蓝条对应的帧数显示
    // 红=起点（跳过帧数 _skipFrames），蓝=终点（_computeEndFrame 计算结果）
    _updateRangeDisplay() {
        const dur = this.duration;
        if (!this._redFrameDisplay || !this._canvas || dur <= 0) {
            if (this._redFrameDisplay) this._redFrameDisplay.textContent = "";
            if (this._blueFrameDisplay) this._blueFrameDisplay.textContent = "";
            return;
        }
        const fps = this._frameRate || 24;
        const startFrame = this._skipFrames;
        const endFrame = this._computeEndFrame();

        // 红色标签：起点帧号（0-based，与主帧数显示一致）
        this._redFrameDisplay.textContent = this._fpsDetected
            ? `${startFrame}`
            : "";

        // 蓝色标签：终点帧号（0-based）
        this._blueFrameDisplay.textContent = this._fpsDetected
            ? `${endFrame}`
            : "";
    }

    // Canvas 解码架构：不再有 <video> 事件，这些方法保留为空壳兼容外部调用
    _onLoadedMeta = () => {
        // 由 _loadDecoderAsync 触发，不再由 video 事件触发
    };
    _onPlayEvt = () => { /* Canvas 架构由 _startPlaybackLoop 驱动 */ };
    _onPauseEvt = () => { /* Canvas 架构由 _stopPlaybackLoop 驱动 */ };
    _onTimeUpdateEvt = () => { /* Canvas 架构在播放循环中更新 */ };

    // Canvas 架构：_onEndedEvt 仅在非循环模式下由 _startPlaybackLoop 调用
    // P12: 移除循环分支死代码（循环由 _startPlaybackLoop 内联处理）
    _onEndedEvt = () => {
        this._stopProgressRaf();
        if (this._progressShine) {
            this._progressShine.style.display = "none";
        }
        this.onEnded?.(this);
    };

    _onErrorEvt = (e) => {
        const msg = e?.message || String(e);
        console.warn("[小珠光] 视频加载错误:", msg);
        // P14: 在 UI 上展示错误信息（复用 timeDisplay）
        if (this._loadingSpinner) this._loadingSpinner.style.display = "none";
        if (this._placeholder) this._placeholder.style.display = "flex";
        if (this._videoSurface) this._videoSurface.style.display = "none";
        if (this._timeDisplay) this._timeDisplay.textContent = "错误: " + msg.slice(0, 40);
        // 清理解码器引用
        this._currentDecoder = null;
        this._resetProgress();
        this.onError?.(this, e);
    };

    _updateProgressDisplay(cur, dur) {
        if (this._isDragging) return;
        if (this._isDraggingMarker) return;

        if (dur > 0) {
            const fps = this._frameRate || 24;
            const sourceTotalFrames = this.getSourceTotalFrames();
            const totalFrames = sourceTotalFrames || this._totalFrames || Math.max(1, Math.round(dur * fps));
            const endFrame = this._computeEndFrame();
            const curFrameIdx = Math.min(Math.floor(cur * fps), endFrame);
            // 进度条按帧数等分：分母用 totalFrames，使最右侧（curFrameIdx=totalFrames）对应 100%
            const pct = totalFrames > 0 ? (curFrameIdx / totalFrames) * 100 : 0;
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
                    // 0-based：最左=0，最右=totalFrames（与编辑器时间线一致）
                    this._frameDisplay.textContent = `${curFrameIdx} / ${totalFrames}`;
                }
            }
            this._timeDisplay.textContent = `${this._formatTime(cur)} / ${this._formatTime(dur)}`;
            this._updateRangeDisplay();
        }
    }

    _startProgressRaf() {
        this._stopProgressRaf();
        const loop = () => {
            if (this._destroyed || !this._canvas || !this._isPlayingState) return;
            this._updateProgressDisplay(this._currentTime, this.duration || 0);
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

    _onSurfaceClick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        // 立即响应播放/暂停，双击上传通过 _onSurfaceDblClick 回调处理
        // 若双击回调中需要撤销播放，可自行在 onDblClick 中 togglePlay
        this.togglePlay();
    };

    _onSurfaceDblClick = (e) => {
        e.preventDefault();
        e.stopPropagation();
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
        const dur = this.duration;
        if (!this._canvas || dur <= 0) return;
        const fps = this._frameRate || 24;
        const rect = this._progressBar.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        const sourceTotalFrames = this.getSourceTotalFrames();
        const totalFrames = sourceTotalFrames || this._totalFrames || Math.max(1, Math.round(dur * fps));
        const endFrame = this._computeEndFrame();
        const frameIdx = Math.max(this._skipFrames, Math.min(Math.floor(ratio * totalFrames), endFrame));
        // 进度条按帧数等分：分母用 totalFrames
        const pct = totalFrames > 0 ? (frameIdx / totalFrames) * 100 : 0;
        if (this._progressFill) {
            const startPct = this._getStartPct();
            this._progressFill.style.left = startPct + "%";
            this._progressFill.style.width = Math.max(0, pct - startPct) + "%";
        }
        if (this._progressThumb) {
            this._progressThumb.style.left = pct + "%";
            this._progressThumb.style.display = "none";
        }
        const curTime = frameIdx / fps;
        this._timeDisplay.textContent = `${this._formatTime(curTime)} / ${this._formatTime(dur)}`;
        if (this._frameDisplay) {
            if (!this._fpsDetected) this._frameDisplay.textContent = "";
            else this._frameDisplay.textContent = `${frameIdx} / ${totalFrames}`;
        }
        this._updateRangeDisplay();
        this.seek(curTime);
    }

    _onProgressDown = (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        this._isDragging = true;
        if (this._progressShine) {
            this._progressShine.style.display = "block";
        }
        // Canvas 架构：暂停播放循环
        this._stopPlaybackLoop();
        this._stopAudio();
        this._savedLoop = this._loopPlayback;
        this._seekByClientX(e.clientX);
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
        if (this._savedLoop !== undefined) {
            this._loopPlayback = this._savedLoop;
            this._savedLoop = undefined;
        }
    };

    _onProgressUp = (e) => {
        if (!this._isDragging) return;
        this._cleanupDrag();
        const suppressClick = (ev) => {
            ev.stopPropagation();
            ev.preventDefault();
            window.removeEventListener("click", suppressClick, true);
        };
        window.addEventListener("click", suppressClick, true);
    };

    // ── 标记条拖拽 ──

    // 加载范围终点（0-based 帧号，最大 = totalFrames）
    // 注意：此值为"进度条位置/显示帧号"，实际解码帧索引最大为 totalFrames-1
    _computeEndFrame() {
        const totalFrames = this.getSourceTotalFrames();
        if (!totalFrames) return 0;
        if (this._frameLimit > 0) {
            return Math.min(this._skipFrames + this._frameLimit, totalFrames);
        }
        return totalFrames;
    }

    _getStartPct() {
        const totalFrames = this.getSourceTotalFrames();
        if (!totalFrames || totalFrames <= 0) return 0;
        // 进度条按帧数等分：分母用 totalFrames
        return (this._skipFrames / totalFrames) * 100;
    }

    _resetPlaybackToStart() {
        const startPct = this._getStartPct();
        if (this._progressFill) {
            this._progressFill.style.left = startPct + "%";
            this._progressFill.style.width = "0%";
        }
        if (this._canvas) {
            const fps = this._frameRate || 24;
            const seekTime = this._skipFrames / fps;
            this.seek(seekTime);
            const dur = this.duration || 0;
            if (this._timeDisplay) {
                this._timeDisplay.textContent = `${this._formatTime(this._skipFrames / fps)} / ${this._formatTime(dur)}`;
            }
            if (this._frameDisplay) {
                if (!this._fpsDetected) {
                    this._frameDisplay.textContent = "";
                } else {
                    const totalFrames = this._totalFrames || this.getTotalFrames();
                    this._frameDisplay.textContent = `${this._skipFrames} / ${totalFrames}`;
                }
            }
            this._updateRangeDisplay();
        }
    }

    _onMarkerDown = (e) => {
        if (e.button !== 0) return;
        const dur = this.duration;
        if (!this._canvas || dur <= 0) return;
        const totalFrames = this.getSourceTotalFrames();
        if (!totalFrames || totalFrames <= 1) return;

        e.preventDefault();
        e.stopPropagation();

        this._isDraggingMarker = true;
        this._draggingMarkerType = e.currentTarget === this._loadRangeStart ? 'start' : 'end';
        this._markerDragStartFrame = this._skipFrames;
        this._markerDragEndFrame = this._computeEndFrame();

        // Canvas 架构：暂停播放循环
        this._stopPlaybackLoop();
        this._stopAudio();
        this._savedLoop = this._loopPlayback;

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

        if (this._savedLoop !== undefined) {
            this._loopPlayback = this._savedLoop;
            this._savedLoop = undefined;
        }

        this._resetPlaybackToStart();

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
        // 进度条按帧数等分：分母用 totalFrames，使最右侧能到达 totalFrames
        const frameIndex = Math.round(ratio * totalFrames);

        if (this._draggingMarkerType === 'start') {
            // 红杠：约束在 [0, endFrame]
            const clamped = Math.max(0, Math.min(frameIndex, this._markerDragEndFrame));
            this._skipFrames = clamped;
            this._updateLoadRangeMarkers();
            this._resetPlaybackToStart();
            this.onLoadRangeStartDrag?.(clamped, false);
        } else {
            // 蓝杠：约束在 [startFrame, totalFrames]
            const clamped = Math.max(this._markerDragStartFrame, Math.min(frameIndex, totalFrames));
            // frameIndex → frameLimit（0=加载全部剩余帧）
            const frameLimit = (clamped >= totalFrames) ? 0 : clamped - this._markerDragStartFrame;
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
        // 重置时清空红蓝条对应值显示
        this._updateRangeDisplay();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Canvas 解码架构核心：load/play/pause/seek
    // ═══════════════════════════════════════════════════════════════════════════

    // 从 URL 中解析 filename 和 type
    _parseVideoUrl(url) {
        if (!url) return { filename: "", type: "input" };
        try {
            const u = new URL(url, location.origin);
            return {
                filename: u.searchParams.get("filename") || "",
                type: u.searchParams.get("type") || "input",
                subfolder: u.searchParams.get("subfolder") || "",
            };
        } catch (_) {
            return { filename: "", type: "input" };
        }
    }

    // 解码源切换：探测视频编码，若 WebCodecs 无法解码（如 HEVC），切换为后端兜底转码的 H.264 产物 URL。
    // 仅在解码入口使用；返回 null 表示原片可直接解码（零开销，沿用原 src）。
    async _ensureDecodableUrl(filename, type, subfolder) {
        try {
            const resp = await api.fetchApi("/xzg/video_ensure_h264", {
                method: "POST",
                body: JSON.stringify({ filename, type: type || "input", subfolder: subfolder || "" }),
            });
            const data = await resp.json();
            if (!(data && data.transcoded && data.filename)) return null;
            const params = new URLSearchParams({ type: data.type || "input" });
            const slashIdx = data.filename.lastIndexOf("/");
            if (slashIdx >= 0) {
                params.set("subfolder", data.filename.substring(0, slashIdx));
                params.set("filename", data.filename.substring(slashIdx + 1));
            } else {
                params.set("filename", data.filename);
            }
            return `/view?${params.toString()}`;
        } catch (_) {
            return null;
        }
    }

    async _loadDecoderAsync(src) {
        // P1: 竞态 guard —— 每次 load 递增 token，异步完成后校验是否仍是最新
        const token = ++this._loadToken;
        // 对齐 VHS：使用原生 <video> 的节点加载时不弹转圈（即便每次都在 reload 也不显示"读条"）。
        // 加载期间保留上一帧画面，避免黑屏 + 转圈动画造成的"读条"观感。
        if (this._loadingSpinner) this._loadingSpinner.style.display = "none";
        try {
            await _ensureMediabunny();
            if (typeof VideoDecoder === 'undefined') {
                throw new Error("当前浏览器不支持 WebCodecs，请使用 Chrome 94+/Edge 94+/Safari 16.4+");
            }
            const { filename, type, subfolder } = this._parseVideoUrl(src);
            this._currentFilename = filename;
            this._currentType = type;
            // P2: filename 为空时（blob:/data: URL）使用 src 作为 key，避免池化串台
            const poolKey = filename || src;
            const poolType = filename ? type : "blob";
            // 解码源切换：HEVC 等 WebCodecs 解不了的编码 → 用后端转码的 H.264 源（懒触发、有缓存）
            let playSrc = src;
            if (filename) {
                const switched = await this._ensureDecodableUrl(filename, type, subfolder);
                if (switched) playSrc = switched;
            }
            const decoder = await loaderDecoderPool.get(poolKey, poolType, playSrc);
            // P1: 校验 token，若期间又调用了 load 则放弃本次结果
            if (token !== this._loadToken) return;
            this._currentDecoder = decoder;
            // 设置视频比例
            if (decoder.width && decoder.height) {
                this._videoRatio = decoder.width / decoder.height;
                this._applyVideoFit();
            }
            // 帧率：直接使用 decoder.fps（mediabunny 精确计算，无需 autoDetectFps）
            if (!this._manualFrameRate && !this._backendFps) {
                const fps = decoder.fps || 30;
                if (fps > 0 && fps <= 120) {
                    this._frameRate = fps;
                    this._sourceFps = fps;
                    this._sourceTotalFrames = decoder.frameCount || Math.round(decoder.duration * fps);
                    this._fpsDetected = true;
                    this._updateFrameTicks();
                    this._updateLoadRangeMarkers();
                    this.onFpsChange?.(fps);
                    this.onSourceFpsDetected?.(fps);
                }
            }
            // P6: 同步 canvas 内部分辨率，避免 drawImage 拉伸模糊
            if (decoder.previewWidth && decoder.previewHeight) {
                this._canvas.width = decoder.previewWidth;
                this._canvas.height = decoder.previewHeight;
            } else if (decoder.width && decoder.height) {
                this._canvas.width = decoder.width;
                this._canvas.height = decoder.height;
            }
            // 隐藏占位提示，显示 canvas
            this._placeholder.style.display = "none";
            this._videoSurface.style.display = "block";
            this._updateSurfaceSize();
            // 渲染首帧
            // 修复首帧黑屏：renderFrame 是 fire-and-forget（只调度 RAF、不等待解码绘制完成），
            // 且部分视频在 time=0 处取不到帧（首帧 PTS 非 0）→ 偶发"首帧黑屏、播放一次后正常"。
            // 改用 renderFrameAwait 真正等待绘制完成（内部带 time=0 时间容错）；不存在时回退旧逻辑。
            const startFrame = this._skipFrames > 0 ? this._skipFrames : 0;
            const targetFrame = Math.max(0, Math.min(startFrame, Math.max(0, decoder.frameCount - 1)));
            if (typeof decoder.renderFrameAwait === "function") {
                await decoder.renderFrameAwait(targetFrame, this._canvas);
            } else {
                await decoder.renderFrame(targetFrame, this._canvas, true);
            }
            if (token !== this._loadToken) return;
            this._currentTime = targetFrame / (this._frameRate || 24);
            this._updateDisplay();
            this._updateLoadRangeMarkers();
            this._updateRangeDisplay();
            // P4: 后台预解码音频（不阻塞首帧渲染），避免首次播放时音频延迟
            this._preloadAudio(decoder);
            // 触发 onLoadedMetadata 回调
            this.onLoadedMetadata?.(this);
            this._updateSurfaceSize();
        } catch (e) {
            if (token !== this._loadToken) return;
            console.error("[小珠光] Canvas 解码加载失败:", e);
            this._onErrorEvt(e);
        } finally {
            if (token === this._loadToken && this._loadingSpinner) {
                this._loadingSpinner.style.display = "none";
            }
        }
    }

    // P4: 后台预解码音频，首次播放时直接使用，无延迟
    async _preloadAudio(decoder) {
        if (!decoder || !decoder.hasAudio) return;
        if (this._fullAudioBuffer || this._audioDecoding) return;
        this._audioDecoding = true;
        try {
            this._fullAudioBuffer = await decoder.decodeFullAudio();
        } catch (e) {
            console.warn("[小珠光] 预解码音频失败:", e);
        } finally {
            this._audioDecoding = false;
        }
    }

    load(src) {
        if (this._destroyed) return;
        this._src = src || "";
        this._backendFps = false;
        if (!this._manualFrameRate) {
            this._fpsDetected = false;
        }
        this._sourceFps = null;
        this._sourceTotalFrames = null;
        this._totalFrames = null;
        // 停止播放：加载新视频后进入暂停态。
        // 若不重置 _isPlayingState（旧播放残留 true），后续 seek 恢复播放头时会触发
        // _startAudioPlayback → 新视频只出声、画面静止（视频迭代器未启动）。
        this._isPlayingState = false;
        this._stopPlaybackLoop();
        this._stopAudio();
        // 切换视频时必须清除旧音频缓冲，否则会播放上一个视频的声音
        this._fullAudioBuffer = null;
        this._audioDecoding = false;
        this._stopProgressRaf();
        this._resetProgress();
        if (this._loadRangeStart) this._loadRangeStart.style.display = "none";
        if (this._loadRangeEnd) this._loadRangeEnd.style.display = "none";
        if (this._loadRangeFill) this._loadRangeFill.style.display = "none";
        if (src) {
            this._currentDecoder = null;  // 重置引用，_loadDecoderAsync 会重新赋值
            this._placeholder.style.display = "none";
            this._videoSurface.style.display = "block";
            this._loadDecoderAsync(src);
            requestAnimationFrame(() => {
                this._updateSurfaceSize();
            });
        } else {
            this._currentDecoder = null;
            this._currentFilename = "";
            this._placeholder.style.display = "flex";
            this._videoSurface.style.display = "none";
            this._videoRatio = 16 / 9;
            if (this._loadingSpinner) this._loadingSpinner.style.display = "none";
        }
    }

    play() {
        if (!this._canvas || !this._src || !this._currentDecoder) return;
        const fps = this._frameRate || 24;
        // P11: 边界保护 —— _skipFrames 越界时纠正
        const totalFrames = this.getSourceTotalFrames();
        if (totalFrames > 0 && this._skipFrames >= totalFrames) {
            this._skipFrames = Math.max(0, totalFrames - 1);
        }
        const cur = this._currentTime;
        const startTime = this._skipFrames / fps;
        const endFrame = this._computeEndFrame();
        const endTime = endFrame / fps;
        // P11: 若 startTime > endTime（无效范围），直接从 0 播放到末尾
        const effectiveStart = startTime <= endTime ? startTime : 0;
        // 播放结束或位置越界时回到起点（含裁剪起点 _skipFrames）
        // 容差 0.05s：避免浮点精度导致 cur 略小于 endTime 时误判为未结束
        if (cur < effectiveStart || cur >= endTime - 0.05) {
            this.seek(effectiveStart);
        }
        this._isPlayingState = true;
        this._startPlaybackLoop();
        this._startAudioPlayback();
        this._startProgressRaf();
        if (this._progressShine) this._progressShine.style.display = "block";
        this.onPlay?.(this);
    }

    pause() {
        this._isPlayingState = false;
        this._stopPlaybackLoop();
        // P10: 暂停时停止音频源但不丢弃已解码的 buffer，避免重复解码
        this._stopAudioSource();
        this._stopProgressRaf();
        if (this._progressShine && !this._isDragging) {
            this._progressShine.style.display = "none";
        }
        this.onPause?.(this);
    }

    togglePlay() {
        if (!this._canvas || !this._src) return;
        if (this._isPlayingState) {
            this.pause();
        } else {
            this.play();
        }
    }

    // seek：RAF 节流 + 最近帧降级（拖动跟手，不卡顿）
    seek(time) {
        if (!this._canvas || !this._currentDecoder) return;
        const dur = this.duration;
        const target = Math.max(0, Math.min(time, dur));
        this._currentTime = target;
        this._updateProgressDisplay(target, dur);
        // P5: 若正在播放，重置音频位置以保持同步
        if (this._isPlayingState) {
            this._startAudioPlayback();
        }
        if (this._scrubRafId) return;
        this._scrubRafId = requestAnimationFrame(() => {
            this._scrubRafId = null;
            const t = this._currentTime;
            const fps = this._frameRate || 24;
            const targetFrame = Math.max(0, Math.min(
                Math.round(t * fps),
                Math.max(0, this._currentDecoder.frameCount - 1)
            ));
            this._currentDecoder.renderFrame(targetFrame, this._canvas, true);
        });
    }

    setMuted(muted) {
        this._muted = !!muted;
        this._applyMute();
    }

    _applyMute() {
        if (this._audioGain) {
            this._audioGain.gain.value = this._muted ? 0 : 1;
        }
    }

    setPlaybackRate(rate) {
        // P16: 支持变速播放
        const r = Math.max(0.25, Math.min(4, rate || 1));
        if (this._isPlayingState) {
            // 变速时重置播放起点为当前帧，避免时间漂移
            const fps = this._frameRate || 24;
            this._playbackStartFrame = Math.round(this._currentTime * fps);
            this._playbackStartTime = performance.now();
        }
        this._playbackRate = r;
    }

    setLoop(loop) {
        this._loopPlayback = !!loop;
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
        if (!this._canvas) return;
        if (!this._customRatio || !this._videoRatio) {
            this._canvas.style.objectFit = "fill";
            this._canvas.style.objectPosition = "center";
            return;
        }
        const src_ar = this._videoRatio;
        const dst_ar = this._customRatio;
        if (Math.abs(src_ar - dst_ar) < 0.01) {
            this._canvas.style.objectFit = "fill";
            this._canvas.style.objectPosition = "center";
        } else {
            this._canvas.style.objectFit = "cover";
            this._canvas.style.objectPosition = "center";
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 播放循环：播放迭代器 + 预缓冲队列（参考编辑器架构）
    // ═══════════════════════════════════════════════════════════════════════════
    _startPlaybackLoop() {
        this._stopPlaybackLoop();
        if (!this._canvas || !this._currentDecoder) return;
        const decoder = this._currentDecoder;
        const fps = this._frameRate || 24;
        const startLocalTime = this._currentTime;
        const startFrame = Math.max(0, Math.round(startLocalTime * fps));
        // 创建播放迭代器
        this._playbackIterator = decoder.createPlaybackIterator(startLocalTime);
        this._playbackIteratorDone = false;
        this._playbackBuffer = [];
        this._playbackStartFrame = startFrame;
        this._playbackStartTime = performance.now();
        this._isBuffering = false;
        this._fillPlaybackBuffer();
        // P16: 变速播放：frameDuration 除以速率
        const rate = this._playbackRate || 1;
        const frameDuration = 1000 / fps / rate;
        let lastFrame = startFrame;
        let lastRafTime = performance.now();
        const loop = () => {
            if (!this._isPlayingState || !this._currentDecoder) {
                this._playbackRaf = 0;
                return;
            }
            const now = performance.now();
            // P17: 标签页后台恢复时 RAF 间隔过大，重置计时避免快进追赶
            const rafDelta = now - lastRafTime;
            lastRafTime = now;
            if (rafDelta > 500) {
                // 后台恢复：重置起始时间，跳到当前应播放的帧
                this._playbackStartTime = now - (lastFrame - this._playbackStartFrame) * frameDuration;
            }
            const elapsedMs = now - this._playbackStartTime;
            const expectedFrame = this._playbackStartFrame + Math.floor(elapsedMs / frameDuration);
            const framesToAdvance = Math.min(expectedFrame - lastFrame, 5); // P17: 限制单次追赶帧数
            if (framesToAdvance > 0) {
                for (let i = 0; i < framesToAdvance; i++) {
                    if (this._playbackBuffer.length > 0) {
                        const frame = this._playbackBuffer.shift();
                        const ctx = this._canvas.getContext('2d');
                        ctx.drawImage(frame.canvas, 0, 0, decoder.previewWidth || decoder.width, decoder.previewHeight || decoder.height);
                        this._currentTime = frame.timestamp;
                        lastFrame++;
                        this._fillPlaybackBuffer();
                    } else {
                        break;
                    }
                }
            }
            // 检查播放结束
            const endFrame = this._computeEndFrame();
            const endTime = endFrame / fps;
            // buffer 耗尽且迭代器已结束：所有源帧已播放完，触发结束
            // 修复：85帧视频最后一帧 timestamp=84/fps < endTime=85/fps，原判断不触发
            if (this._currentTime >= endTime ||
                (this._playbackBuffer.length === 0 && this._playbackIteratorDone && !this._isBuffering)) {
                if (this._loopPlayback) {
                    // P3: 循环回到起点时重建迭代器和清空 buffer，避免第二轮卡死
                    const startTime = this._skipFrames / fps;
                    this._currentTime = startTime;
                    this._playbackIterator = decoder.createPlaybackIterator(startTime);
                    this._playbackIteratorDone = false;
                    this._playbackBuffer = [];
                    this._playbackStartTime = performance.now();
                    this._playbackStartFrame = this._skipFrames;
                    lastFrame = this._skipFrames;
                    this._fillPlaybackBuffer();
                    this._startAudioPlayback();
                } else {
                    // 非循环：定位到结束时间，确保播放头停在最终位置
                    this._currentTime = endTime;
                    this._updateProgressDisplay(endTime, this.duration);
                    this._isPlayingState = false;
                    this._onEndedEvt();
                    this._playbackRaf = 0;
                    return;
                }
            }
            this._playbackRaf = requestAnimationFrame(loop);
        };
        this._playbackRaf = requestAnimationFrame(loop);
    }

    async _fillPlaybackBuffer() {
        if (this._isBuffering || !this._isPlayingState) return;
        if (!this._playbackIterator) return;
        this._isBuffering = true;
        try {
            while (this._playbackBuffer.length < this._playbackBufferSize && this._isPlayingState) {
                const result = await this._playbackIterator.next();
                if (result.done) {
                    this._playbackIteratorDone = true;  // 所有源帧已解码完
                    break;
                }
                const wc = result.value;
                if (wc && wc.canvas) {
                    const copy = document.createElement('canvas');
                    copy.width = wc.canvas.width;
                    copy.height = wc.canvas.height;
                    copy.getContext('2d').drawImage(wc.canvas, 0, 0);
                    this._playbackBuffer.push({ canvas: copy, timestamp: wc.timestamp });
                }
            }
        } catch (e) {
            console.error("[小珠光] 预缓冲失败:", e);
        } finally {
            this._isBuffering = false;
        }
    }

    _stopPlaybackLoop() {
        if (this._playbackRaf) {
            cancelAnimationFrame(this._playbackRaf);
            this._playbackRaf = 0;
        }
        this._playbackIterator = null;
        this._playbackIteratorDone = false;
        this._playbackBuffer = [];
        this._isBuffering = false;
        // 释放解码器上的播放迭代器：renderFrame/readFrameCached 在 _playbackIter 活跃时
        // 跳过随机寻址渲染（防与 canvases() 迭代器争抢 sink）。停止播放后若不释放，
        // _playbackIter 残留，后续拖动 seek 的画面更新被屏蔽（只有再次播放才刷新）。
        if (this._currentDecoder && typeof this._currentDecoder.stopPlaybackIterator === "function") {
            this._currentDecoder.stopPlaybackIterator();
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 音频播放（基于 AudioContext + AudioBufferSink）
    // ═══════════════════════════════════════════════════════════════════════════
    _ensureAudioContext() {
        if (!this._audioCtx) {
            this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            this._audioGain = this._audioCtx.createGain();
            this._audioGain.connect(this._audioCtx.destination);
            this._applyMute();
        }
        if (this._audioCtx.state === 'suspended') this._audioCtx.resume();
    }

    async _startAudioPlayback() {
        if (!this._currentDecoder || !this._currentDecoder.hasAudio) return;
        this._ensureAudioContext();
        if (!this._fullAudioBuffer) {
            this._fullAudioBuffer = await this._currentDecoder.decodeFullAudio();
        }
        if (!this._fullAudioBuffer) return;
        const localTime = this._currentTime;
        // 音频播放时长必须严格限定到（可能被加载上限截断的）画面结束点，否则截断后
        // 画面提前停、声音却一路播完。endTime 与画面播放结束共用 _computeEndFrame()。
        const fps = this._frameRate || this._currentDecoder.fps || 24;
        const endTime = this._computeEndFrame() / fps;
        const playLen = Math.max(endTime - localTime, 0.001);
        this._stopAudioSource();
        try {
            this._audioSource = this._audioCtx.createBufferSource();
            this._audioSource.buffer = this._fullAudioBuffer;
            this._audioSource.connect(this._audioGain);
            this._audioSource.start(0, localTime, playLen);
            this._audioPlayStartOffset = localTime;
            this._audioPlayStartTime = this._audioCtx.currentTime;
        } catch (e) {
            console.warn("[小珠光] 音频播放失败:", e);
        }
    }

    _stopAudioSource() {
        if (this._audioSource) {
            try { this._audioSource.stop(); } catch (_) {}
            this._audioSource = null;
        }
    }

    _stopAudio() {
        // P10: 仅停止音频源，保留已解码的 _fullAudioBuffer，避免重复解码
        this._stopAudioSource();
    }

    setFrameRate(fps) {
        if (typeof fps === "number" && fps > 0) {
            this._frameRate = fps;
            this._manualFrameRate = true;
            this._backendFps = false;
            this._fpsDetected = true;
            this._updateProgressBarSize(this._videoSurface?.offsetHeight || 200);
            this._updateProgressDisplay(this._currentTime || 0, this.duration || 0);
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
        // Canvas 架构：fps 由 decoder 直接提供，重新读取
        if (this._currentDecoder) {
            const fps = this._currentDecoder.fps || 30;
            if (fps > 0 && fps <= 120) {
                this._frameRate = fps;
                this._sourceFps = fps;
                this._sourceTotalFrames = this._currentDecoder.frameCount || Math.round(this._currentDecoder.duration * fps);
                this._fpsDetected = true;
                this._updateFrameTicks();
                this._updateDisplay();
                this._updateLoadRangeMarkers();
                this.onFpsChange?.(fps);
                this.onSourceFpsDetected?.(fps);
            }
        }
    }

    applyBackendFps(fps) {
        if (typeof fps === "number" && fps > 0) {
            this._frameRate = fps;
            this._sourceFps = fps;
            this._backendFps = true;
            this._fpsDetected = true;
            this._updateFrameTicks();
            this._updateDisplay();
            this._updateLoadRangeMarkers();
            this.onFpsChange?.(fps);
            this.onSourceFpsDetected?.(fps);
        }
    }

    getFrameRate() {
        return this._frameRate || 24;
    }

    getTotalFrames() {
        if (this._totalFrames) return this._totalFrames;
        const dur = this.duration;
        if (dur > 0) {
            return Math.max(1, Math.round(dur * (this._frameRate || 24)));
        }
        return 0;
    }

    getSourceTotalFrames() {
        if (this._sourceTotalFrames) return this._sourceTotalFrames;
        const dur = this.duration;
        if (dur > 0) {
            const srcFps = this._sourceFps || this._frameRate || 24;
            return Math.max(1, Math.round(dur * srcFps));
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
        this._updateRangeDisplay();
    }

    _updateLoadRangeMarkers() {
        const dur = this.duration;
        if (!this._progressBar || !this._canvas || dur <= 0) return;
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
            endFrame = Math.min(startFrame + this._frameLimit, totalSourceFrames);
        } else {
            endFrame = totalSourceFrames;
        }
        if (startFrame >= totalSourceFrames || endFrame < 0 || startFrame > endFrame) {
            if (this._loadRangeStart) this._loadRangeStart.style.display = "none";
            if (this._loadRangeEnd) this._loadRangeEnd.style.display = "none";
            if (this._loadRangeFill) this._loadRangeFill.style.display = "none";
            return;
        }
        // 进度条按帧数等分：分母用 totalSourceFrames，使最右侧（endFrame=totalSourceFrames）对应 100%
        const denom = totalSourceFrames;
        const startPct = (startFrame / denom) * 100;
        const endPct = (endFrame / denom) * 100;
        const barW = this._progressBar.offsetWidth || 300;
        const edgeOffsetPct = barW > 0 ? (1 / barW) * 100 : 0.35;
        if (this._loadRangeStart) {
            this._loadRangeStart.style.display = "block";
            const clampedStartPct = Math.max(edgeOffsetPct, startPct);
            this._loadRangeStart.style.left = clampedStartPct + "%";
            this._positionRedLabel(clampedStartPct, barW);
        }
        if (this._loadRangeEnd) {
            this._loadRangeEnd.style.display = "block";
            const clampedEndPct = Math.min(100 - edgeOffsetPct, endPct);
            this._loadRangeEnd.style.left = clampedEndPct + "%";
            this._positionBlueLabel(clampedEndPct, barW);
        }
        if (this._loadRangeFill) {
            this._loadRangeFill.style.display = "block";
            this._loadRangeFill.style.left = startPct + "%";
            this._loadRangeFill.style.width = (endPct - startPct) + "%";
        }
    }

    _positionRedLabel(pct, barW) {
        if (!this._redFrameDisplay) return;
        const centerPx = (pct / 100) * barW;
        const leftPx = centerPx + 5;
        this._redFrameDisplay.style.left = leftPx + "px";
        this._redFrameDisplay.style.transform = "translateX(0)";
    }

    _positionBlueLabel(pct, barW) {
        if (!this._blueFrameDisplay) return;
        const centerPx = (pct / 100) * barW;
        const rightPx = centerPx - 5;
        this._blueFrameDisplay.style.left = rightPx + "px";
        this._blueFrameDisplay.style.transform = "translateX(-100%)";
    }

    // Canvas 架构：fps 由 decoder 精确提供，无需复杂的 autoDetectFps
    // 保留空壳方法兼容外部调用（_onPlayEvt 等历史代码可能引用）
    autoDetectFps() {
        if (this._manualFrameRate || this._backendFps || this._detectingFps) return;
        if (!this._currentDecoder) return;
        const fps = this._currentDecoder.fps || 30;
        if (fps > 0 && fps <= 120) {
            this._frameRate = fps;
            this._sourceFps = fps;
            this._sourceTotalFrames = this._currentDecoder.frameCount || Math.round(this._currentDecoder.duration * fps);
            this._fpsDetected = true;
            this._updateFrameTicks();
            this._updateDisplay();
            this._updateLoadRangeMarkers();
            this.onFpsChange?.(fps);
            this.onSourceFpsDetected?.(fps);
        }
    }

    _updateDisplay() {
        this._updateProgressDisplay(this._currentTime || 0, this.duration || 0);
    }

    // Canvas 架构 getters
    get isPlaying() { return !!this._isPlayingState; }
    get currentTime() { return this._currentTime ?? 0; }
    get duration() { return this._currentDecoder?.duration ?? 0; }
    get videoWidth() { return this._currentDecoder?.width ?? 0; }
    get videoHeight() { return this._currentDecoder?.height ?? 0; }
    // 兼容外部访问：返回 null（Canvas 架构无 video 元素）
    get videoElement() { return null; }
    get src() { return this._src; }

    setPlaceholder(text) {
        if (this._placeholder) this._placeholder.textContent = text;
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        // Canvas 架构清理
        this._stopPlaybackLoop();
        this._stopAudio();
        this._stopProgressRaf();
        if (this._scrubRafId) {
            cancelAnimationFrame(this._scrubRafId);
            this._scrubRafId = null;
        }
        if (this._audioCtx) {
            try { this._audioCtx.close(); } catch (_) {}
            this._audioCtx = null;
            this._audioGain = null;
            this._audioSource = null;
        }
        // 释放当前解码器引用（池化管理，不主动销毁）
        this._currentDecoder = null;
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
            // P8: 修正事件类型为 pointerdown（与注册时一致）
            this._bottomBar.removeEventListener("pointerdown", this._onProgressDown);
            this._bottomBar.removeEventListener("wheel", this._forwardWheel);
        }
        // P8: 从 document 清理改为从 window 清理（与注册位置一致）
        window.removeEventListener("mousemove", this._onProgressMove);
        window.removeEventListener("mouseup", this._onProgressUp);
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
        if (this._placeholder) this._placeholder.remove();
        if (this._loadingSpinner) this._loadingSpinner.remove();
        if (this._canvas) this._canvas.remove();
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
        this._canvas = null;
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
        this._redFrameDisplay = null;
        this._blueFrameDisplay = null;
        this._loopBtn = null;
        this._muteBtn = null;
        this._buttonRow = null;
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

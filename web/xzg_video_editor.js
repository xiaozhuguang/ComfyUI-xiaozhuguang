/**
 * 小珠光视频编辑器 · 化神级
 * 多视频版 — 支持加载多个视频、拖拽到时间线、调整入出点、拼接导出
 *
 * 布局:
 *   ┌──────────────────────────────────────────────┐
 *   │  Header (标题 + 关闭)                          │
 *   ├──────────┬───────────────────────┬────────────┤
 *   │ 媒体库    │   预览区               │ 属性面板    │
 *   │ (拖拽源)  │   <video>             │ 入/出点     │
 *   │           │   播放控制             │ 片段列表    │
 *   ├──────────┴───────────────────────┴────────────┤
 *   │  时间线 (可拖拽片段, 可调整入出点, 可删除)       │
 *   ├──────────────────────────────────────────────┤
 *   │  Footer (状态 + 取消/生成)                     │
 *   └──────────────────────────────────────────────┘
 */
import { api } from "../../scripts/api.js";

const API_LIST = "/xzg_video_editor_list";
const API_PROBE = "/xzg_video_editor_probe";
const API_EXTRACT = "/xzg_video_editor_extract_frame";
const API_RENDER = "/xzg_video_editor_render";

// 全局缩略图缓存（跨编辑器实例持久，避免每次打开重新加载）
// 结构: { mediaKey: { url: string | null, failed: boolean } }
// url 存在则为成功缓存；url=null 且 failed=true 表示之前失败不再重试
const _XZG_VE_THUMB_CACHE = {};
// 全局"正在加载中"集合，避免并发重复请求
const _XZG_VE_THUMB_LOADING = new Set();

// 全局探测缓存（跨编辑器实例持久，避免每次打开重新跑 ffmpeg probe）
// 结构: { mediaKey: { state: "ok", info: {...}, mtime: number } | { state: "failed", error: str, mtime: number } }
const _XZG_VE_PROBE_CACHE = {};
// 全局"正在探测中"集合，避免并发重复请求
const _XZG_VE_PROBE_LOADING = new Set();

const VIDEO_EXTS = ["webm", "mp4", "mkv", "gif", "mov", "avi", "flv", "wmv", "m4v", "mpg", "mpeg", "ts"];

function _isVideo(name) {
    const ext = name.split(".").pop()?.toLowerCase();
    return VIDEO_EXTS.includes(ext);
}

function _fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const sec = s - m * 60;
    return `${m.toString().padStart(2, "0")}:${sec.toFixed(2).padStart(5, "0")}`;
}

function _el(tag, cls, text, parent) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
}

async function _postJson(url, body) {
    const resp = await api.fetchApi(url, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
    });
    const text = await resp.text();
    try {
        return JSON.parse(text);
    } catch (_) {
        throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
}

export class XiaozhuguangVideoEditor {
    constructor(opts = {}) {
        this.onCancel = opts.onCancel || (() => {});
        this.onApplied = opts.onApplied || (() => {});
        this.initialFilename = opts.filename || "";
        this.initialType = opts.type || "input";

        // 媒体库: [{name, type, info: {width,height,fps,duration}}]
        this.mediaLibrary = [];
        // 时间线片段: [{id, filename, type, start, end, name}]
        this.timeline = [];
        this.selectedClipIds = new Set();  // 多选集合
        this._clipIdCounter = 0;
        this._root = null;
        this._video = null;
        this._draggingClip = null;
        this._destroyed = false;
        this._currentVideoSrc = null;
        this._keyHandler = null;  // 键盘事件引用，close 时移除
        this._selectionBox = null;  // 框选矩形元素
        this._hiddenKey = "xzg_ve_hidden_media";  // localStorage key
        this.selectedMediaNames = new Set();  // 媒体库多选集合
        this._mediaSelBox = null;  // 媒体库框选矩形
        // 缩略图模式开关（localStorage 持久化）
        this._thumbModeKey = "xzg_ve_thumb_mode";
        this._thumbnailMode = localStorage.getItem(this._thumbModeKey) === "1";
        // 缩略图 URL 使用全局缓存 _XZG_VE_THUMB_CACHE（跨实例持久化）
        // 缩略图大小滑条（长边 px，持久化）
        this._thumbSizeKey = "xzg_ve_thumb_size";
        this._thumbSize = 160;
        try {
            const v = parseInt(localStorage.getItem(this._thumbSizeKey), 10);
            if (v >= 90 && v <= 180) this._thumbSize = v;
        } catch (_) {}
        // 媒体库面板宽度持久化
        this._mediaWidthKey = "xzg_ve_media_width";
        this._mediaPanel = null;
        this._resizer = null;
    }

    // 读取隐藏名单（localStorage 持久化）
    _getHiddenSet() {
        try {
            const raw = localStorage.getItem(this._hiddenKey);
            return new Set(raw ? JSON.parse(raw) : []);
        } catch (_) { return new Set(); }
    }

    _saveHiddenSet(set) {
        try { localStorage.setItem(this._hiddenKey, JSON.stringify([...set])); } catch (_) {}
    }

    _addHidden(name) {
        const s = this._getHiddenSet();
        s.add(name);
        this._saveHiddenSet(s);
    }

    open() {
        this._build();
        document.body.appendChild(this._root);
        // 键盘删除监听
        this._keyHandler = (e) => this._onKeyDown(e);
        window.addEventListener("keydown", this._keyHandler);
        this._loadMediaLibrary();
        // 如果有初始视频, 直接加入时间线
        if (this.initialFilename) {
            this._addToLibraryAndTimeline(this.initialFilename, this.initialType);
        }
    }

    close() {
        if (this._destroyed) return;
        this._destroyed = true;
        if (this._keyHandler) {
            window.removeEventListener("keydown", this._keyHandler);
            this._keyHandler = null;
        }
        if (this._video) {
            try { this._video.pause(); } catch (_) {}
            this._video.src = "";
        }
        if (this._root?.parentNode) this._root.parentNode.removeChild(this._root);
        this._root = null;
        this._video = null;
    }

    _onKeyDown(e) {
        // 输入框中不响应删除键
        const tag = (e.target?.tagName || "").toLowerCase();
        if (tag === "input" || tag === "textarea" || e.target?.isContentEditable) return;
        if (e.key === "Delete" || e.key === "Backspace") {
            const mediaSel = this.selectedMediaNames.size > 0;
            const clipSel = this.selectedClipIds.size > 0;
            if (!mediaSel && !clipSel) return;
            e.preventDefault();
            // 删除选中的媒体
            if (mediaSel) {
                const names = Array.from(this.selectedMediaNames);
                for (const name of names) {
                    const idx = this.mediaLibrary.findIndex(m => m.name === name);
                    if (idx >= 0) {
                        this.mediaLibrary.splice(idx, 1);
                        this._addHidden(name);
                    }
                }
                this.selectedMediaNames.clear();
                this._renderMediaList();
                this._setStatus(`已删除 ${names.length} 个媒体`);
            }
            // 删除选中的片段
            if (clipSel) {
                const ids = Array.from(this.selectedClipIds);
                for (const id of ids) {
                    const idx = this.timeline.findIndex(c => c.id === id);
                    if (idx >= 0) this.timeline.splice(idx, 1);
                }
                this.selectedClipIds.clear();
                this._renderTimeline();
                this._renderProps();
                if (mediaSel) {
                    this._setStatus(`已删除 ${ids.length} 个片段 + ${this._status.textContent || ""}`);
                } else {
                    this._setStatus(`已删除 ${ids.length} 个片段`);
                }
            }
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  UI 构建
    // ═══════════════════════════════════════════════════════════
    _build() {
        const root = document.createElement("div");
        root.className = "xzg-ve-root";
        root.innerHTML = `
            <div class="xzg-ve-modal">
                <div class="xzg-ve-header">
                    <span class="xzg-ve-title">🎬 小珠光视频编辑器 · 化神级</span>
                    <span class="xzg-ve-status"></span>
                    <button class="xzg-ve-close">×</button>
                </div>
                <div class="xzg-ve-body">
                    <div class="xzg-ve-media-panel">
                        <div class="xzg-ve-panel-header">
                            <span>媒体库</span>
                            <div class="xzg-ve-media-btns">
                                <button class="xzg-ve-thumb-btn" title="切换缩略图/列表模式">缩略图</button>
                                <button class="xzg-ve-clear-btn">🗑 清空</button>
                                <button class="xzg-ve-add-btn">＋ 添加</button>
                            </div>
                        </div>
                        <div class="xzg-ve-media-list">
                            <div class="xzg-ve-thumb-size-bar">
                                <input type="range" min="90" max="180" value="160" class="xzg-ve-thumb-size-range">
                                <span class="xzg-ve-thumb-size-val">160</span>
                            </div>
                        </div>
                    </div>
                    <div class="xzg-ve-media-resizer" title="拖动调整媒体库宽度"></div>
                    <div class="xzg-ve-preview-panel">
                        <div class="xzg-ve-preview">
                            <video class="xzg-ve-video" playsinline></video>
                            <div class="xzg-ve-preview-empty">从媒体库拖拽视频到时间线</div>
                        </div>
                        <div class="xzg-ve-preview-controls">
                            <button class="xzg-ve-play-btn">▶</button>
                            <span class="xzg-ve-time">00:00.00 / 00:00.00</span>
                            <button class="xzg-ve-frame-btn">📷 导出帧</button>
                        </div>
                    </div>
                    <div class="xzg-ve-props-panel">
                        <div class="xzg-ve-panel-header">属性</div>
                        <div class="xzg-ve-props-content"></div>
                    </div>
                </div>
                <div class="xzg-ve-timeline-panel">
                    <div class="xzg-ve-timeline-header">
                        <span>时间线</span>
                        <span class="xzg-ve-tl-info"></span>
                    </div>
                    <div class="xzg-ve-timeline" tabindex="0">
                        <div class="xzg-ve-tl-track"></div>
                        <div class="xzg-ve-tl-playhead"></div>
                    </div>
                </div>
                <div class="xzg-ve-footer">
                    <button class="xzg-ve-btn xzg-ve-btn-clear-tl">🗑 清空时间线</button>
                    <div class="xzg-ve-footer-right">
                        <button class="xzg-ve-btn xzg-ve-btn-cancel">取消</button>
                        <button class="xzg-ve-btn xzg-ve-btn-apply">⏩ 生成并应用</button>
                    </div>
                </div>
            </div>
        `;
        this._root = root;
        this._video = root.querySelector(".xzg-ve-video");
        this._mediaList = root.querySelector(".xzg-ve-media-list");
        this._timeline = root.querySelector(".xzg-ve-timeline");
        this._tlTrack = root.querySelector(".xzg-ve-tl-track");
        this._playhead = root.querySelector(".xzg-ve-tl-playhead");
        this._status = root.querySelector(".xzg-ve-status");
        this._timeLabel = root.querySelector(".xzg-ve-time");
        this._propsContent = root.querySelector(".xzg-ve-props-content");
        this._tlInfo = root.querySelector(".xzg-ve-tl-info");
        this._previewEmpty = root.querySelector(".xzg-ve-preview-empty");

        // 事件绑定
        root.querySelector(".xzg-ve-close").onclick = () => this._cancel();
        root.querySelector(".xzg-ve-btn-cancel").onclick = () => this._cancel();
        root.querySelector(".xzg-ve-btn-apply").onclick = () => this._render();
        root.querySelector(".xzg-ve-btn-clear-tl").onclick = () => this._clearTimeline();
        root.querySelector(".xzg-ve-add-btn").onclick = () => this._addFromInput();
        root.querySelector(".xzg-ve-clear-btn").onclick = () => this._clearMediaLibrary();
        this._thumbBtn = root.querySelector(".xzg-ve-thumb-btn");
        this._updateThumbBtn();
        this._thumbBtn.onclick = () => this._toggleThumbMode();
        // 缩略图大小滑条
        this._thumbSizeBar = root.querySelector(".xzg-ve-thumb-size-bar");
        this._thumbSizeRange = root.querySelector(".xzg-ve-thumb-size-range");
        this._thumbSizeVal = root.querySelector(".xzg-ve-thumb-size-val");
        this._thumbSizeRange.value = this._thumbSize;
        this._thumbSizeVal.textContent = this._thumbSize;
        this._applyThumbSize();
        this._thumbSizeRange.addEventListener("input", () => {
            this._thumbSize = parseInt(this._thumbSizeRange.value, 10) || 160;
            this._thumbSizeVal.textContent = this._thumbSize;
            this._applyThumbSize();
        });
        this._thumbSizeRange.addEventListener("change", () => {
            try { localStorage.setItem(this._thumbSizeKey, String(this._thumbSize)); } catch (_) {}
        });
        // 媒体库宽度拖动调整
        this._mediaPanel = root.querySelector(".xzg-ve-media-panel");
        this._resizer = root.querySelector(".xzg-ve-media-resizer");
        this._restoreMediaWidth();
        this._bindResizer();
        root.querySelector(".xzg-ve-play-btn").onclick = () => this._togglePlay();
        root.querySelector(".xzg-ve-frame-btn").onclick = () => this._exportFrame();
        this._video.addEventListener("click", () => this._togglePlay());
        this._video.addEventListener("timeupdate", () => this._onTimeUpdate());
        this._video.addEventListener("loadedmetadata", () => this._updateTimeDisplay());

        // 时间线拖放
        this._timeline.addEventListener("dragover", (e) => {
            e.preventDefault();
            this._timeline.classList.add("xzg-ve-drag-over");
        });
        this._timeline.addEventListener("dragleave", () => {
            this._timeline.classList.remove("xzg-ve-drag-over");
        });
        this._timeline.addEventListener("drop", (e) => {
            e.preventDefault();
            this._timeline.classList.remove("xzg-ve-drag-over");
            const name = e.dataTransfer.getData("text/x-media-name");
            const type = e.dataTransfer.getData("text/x-media-type") || "input";
            if (name) {
                this._addClipToTimeline(name, type);
            }
        });

        // 时间线框选：在时间线空白区域 mousedown 启动
        this._timeline.addEventListener("mousedown", (e) => this._onTimelineMouseDown(e));

        // 媒体库框选：在媒体列表空白区域 mousedown 启动
        this._mediaList.addEventListener("mousedown", (e) => this._onMediaListMouseDown(e));

        // Ctrl+滚轮缩放缩略图
        this._mediaList.addEventListener("wheel", (e) => {
            if (!e.ctrlKey && !e.metaKey) return;
            e.preventDefault();
            e.stopPropagation();
            this._thumbSize = Math.max(90, Math.min(180, this._thumbSize - e.deltaY * 0.1));
            if (this._thumbSizeRange) this._thumbSizeRange.value = this._thumbSize;
            if (this._thumbSizeVal) this._thumbSizeVal.textContent = this._thumbSize;
            this._applyThumbSize();
            try { localStorage.setItem(this._thumbSizeKey, String(this._thumbSize)); } catch (_) {}
        }, { passive: false });

        this._injectStyle();
    }

    _injectStyle() {
        if (document.getElementById("xzg-ve-style")) return;
        const st = document.createElement("style");
        st.id = "xzg-ve-style";
        st.textContent = `
        .xzg-ve-root {
            position: fixed; inset: 0; background: rgba(0,0,0,0.85);
            z-index: 100000; display: flex; align-items: center; justify-content: center;
            font-family: system-ui, -apple-system, "Microsoft YaHei", sans-serif;
            color: #eee; user-select: none;
        }
        .xzg-ve-modal {
            width: 98vw; height: 95vh; background: #1e1e1e; border: 1px solid #444;
            border-radius: 8px; display: flex; flex-direction: column; overflow: hidden;
        }
        .xzg-ve-header {
            height: 40px; padding: 0 12px; background: #2a2a2a;
            display: flex; align-items: center; gap: 12px;
            border-bottom: 1px solid #333; flex-shrink: 0;
        }
        .xzg-ve-title { font-size: 14px; font-weight: 600; color: #dcc85b; white-space: nowrap; }
        .xzg-ve-status { font-size: 12px; color: #888; flex: 1; overflow: hidden;
            text-overflow: ellipsis; white-space: nowrap; }
        .xzg-ve-close { background: transparent; border: 0; color: #aaa; font-size: 20px;
            cursor: pointer; padding: 0 6px; line-height: 1; }
        .xzg-ve-close:hover { color: #ff6b6b; }
        .xzg-ve-body { flex: 1; display: flex; min-height: 0; }
        .xzg-ve-media-panel {
            width: 220px; background: #252525; border-right: 1px solid #333;
            display: flex; flex-direction: column; flex-shrink: 0;
        }
        .xzg-ve-media-resizer {
            width: 8px; cursor: col-resize; background: transparent;
            flex-shrink: 0; position: relative; transition: background 0.15s;
        }
        .xzg-ve-media-resizer::after {
            content: ""; position: absolute; left: 50%; top: 50%;
            transform: translate(-50%, -50%);
            width: 2px; height: 24px; background: #555; border-radius: 1px;
            transition: background 0.15s, height 0.15s;
        }
        .xzg-ve-media-resizer:hover::after,
        .xzg-ve-media-resizer.xzg-ve-resizing::after {
            background: #dcc85b; height: 32px;
        }
        .xzg-ve-panel-header {
            padding: 8px 10px; font-size: 12px; color: #dcc85b;
            display: flex; justify-content: space-between; align-items: center;
            border-bottom: 1px solid #333; flex-shrink: 0;
        }
        .xzg-ve-add-btn {
            background: #353535; border: 1px solid #444; color: #dcc85b;
            font-size: 11px; padding: 3px 8px; border-radius: 3px; cursor: pointer;
        }
        .xzg-ve-add-btn:hover { background: #454545; }
        .xzg-ve-media-btns { display: flex; gap: 4px; }
        .xzg-ve-clear-btn {
            background: #353535; border: 1px solid #444; color: #ff6b6b;
            font-size: 11px; padding: 3px 8px; border-radius: 3px; cursor: pointer;
        }
        .xzg-ve-clear-btn:hover { background: #5a2a2a; border-color: #ff6b6b; }
        .xzg-ve-thumb-btn {
            background: #353535; border: 1px solid #dcc85b; color: #dcc85b;
            font-size: 11px; padding: 3px 8px; border-radius: 3px; cursor: pointer;
        }
        .xzg-ve-thumb-btn:hover { background: #454545; }
        .xzg-ve-media-list { flex: 1; overflow-y: auto; padding: 4px; position: relative; }
        /* 缩略图模式：网格布局，列宽由滑条控制（长边 px） */
        .xzg-ve-media-list.xzg-ve-list-thumb {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(var(--xzg-thumb-w, 160px), 1fr));
            gap: 4px; align-content: start;
        }
        /* 缩略图大小滑条容器 */
        .xzg-ve-thumb-size-bar {
            display: none; padding: 4px 10px; align-items: center; gap: 8px;
            background: #2a2a2a; border-top: 1px solid #333; flex-shrink: 0;
        }
        .xzg-ve-thumb-size-bar.xzg-ve-visible { display: flex; }
        .xzg-ve-list-thumb .xzg-ve-thumb-size-bar { grid-column: 1 / -1; }
        .xzg-ve-thumb-size-bar input[type="range"] {
            flex: 1; height: 4px; -webkit-appearance: none; appearance: none;
            background: #444; border-radius: 2px; outline: none;
        }
        .xzg-ve-thumb-size-bar input[type="range"]::-webkit-slider-thumb {
            -webkit-appearance: none; appearance: none;
            width: 12px; height: 12px; border-radius: 50%;
            background: #dcc85b; cursor: pointer; border: 0;
        }
        .xzg-ve-thumb-size-bar input[type="range"]::-moz-range-thumb {
            width: 12px; height: 12px; border-radius: 50%;
            background: #dcc85b; cursor: pointer; border: 0;
        }
        .xzg-ve-thumb-size-val {
            color: #dcc85b; font-size: 10px; min-width: 36px; text-align: right;
        }
        .xzg-ve-media-sel-box {
            position: absolute; background: rgba(102, 153, 255, 0.15);
            border: 1px dashed #6699ff; pointer-events: none; z-index: 10;
        }
        .xzg-ve-media-item {
            padding: 6px 8px; margin-bottom: 4px; background: #2a2a2a;
            border-radius: 4px; cursor: grab; font-size: 11px; border: 1px solid transparent;
            transition: border-color 0.15s; position: relative;
        }
        .xzg-ve-media-item:hover { background: #303030; }
        .xzg-ve-media-item:active { cursor: grabbing; }
        /* 选中态：保持黑底白字（与拖动预览一致，无蓝色高亮） */
        .xzg-ve-media-item.xzg-ve-media-selected,
        .xzg-ve-media-item.xzg-ve-media-selected:hover {
            background: #000000 !important;
        }
        .xzg-ve-media-item.xzg-ve-media-selected .xzg-ve-media-name,
        .xzg-ve-media-item.xzg-ve-media-selected .xzg-ve-media-info {
            color: #ffffff !important;
        }
        /* 缩略图模式下的项布局 */
        .xzg-ve-list-thumb .xzg-ve-media-item { margin-bottom: 0; padding: 4px; }
        /* 缩略图模式选中项：2px 红框 */
        .xzg-ve-list-thumb .xzg-ve-media-item.xzg-ve-media-selected {
            border-color: #fa5b4a !important;
            border-width: 2px !important;
        }
        .xzg-ve-media-thumb {
            width: 100%; aspect-ratio: 16/9; background: #000;
            border-radius: 3px; overflow: hidden; margin-bottom: 4px;
            display: flex; align-items: center; justify-content: center;
            position: relative;
        }
        .xzg-ve-media-thumb img {
            width: 100%; height: 100%; object-fit: contain; display: block;
        }
        .xzg-ve-media-thumb-placeholder {
            color: #444; font-size: 10px;
        }
        .xzg-ve-media-name { color: #ddd; overflow: hidden; text-overflow: ellipsis;
            white-space: nowrap; }
        .xzg-ve-media-info { color: #666; font-size: 10px; margin-top: 2px; }
        .xzg-ve-media-info-err { color: #ff6b6b; }
        .xzg-ve-preview-panel {
            flex: 1; min-width: 0; display: flex; flex-direction: column;
        }
        .xzg-ve-preview {
            flex: 1; background: #000; position: relative;
            display: flex; align-items: center; justify-content: center;
            min-height: 0;
        }
        .xzg-ve-video { max-width: 100%; max-height: 100%; display: none; }
        .xzg-ve-video.xzg-ve-active { display: block; }
        .xzg-ve-preview-empty {
            color: #555; font-size: 14px; text-align: center;
        }
        .xzg-ve-preview-empty.xzg-ve-hidden { display: none; }
        .xzg-ve-preview-controls {
            height: 36px; padding: 0 10px; background: #2a2a2a;
            display: flex; align-items: center; gap: 10px; flex-shrink: 0;
            border-top: 1px solid #333;
        }
        .xzg-ve-play-btn {
            width: 28px; height: 28px; border-radius: 50%; background: #353535;
            border: 1px solid #555; color: #fff; cursor: pointer; font-size: 12px;
        }
        .xzg-ve-play-btn:hover { background: #a67c00; border-color: #a67c00; }
        .xzg-ve-time { font-size: 11px; color: #999; font-family: monospace; flex: 1; }
        .xzg-ve-frame-btn {
            background: #353535; border: 1px solid #444; color: #ddd;
            font-size: 11px; padding: 4px 8px; border-radius: 3px; cursor: pointer;
        }
        .xzg-ve-frame-btn:hover { background: #454545; }
        .xzg-ve-props-panel {
            width: 220px; background: #252525; border-left: 1px solid #333;
            display: flex; flex-direction: column; flex-shrink: 0;
        }
        .xzg-ve-props-content { flex: 1; overflow-y: auto; padding: 8px 10px; font-size: 11px; }
        .xzg-ve-prop-row { margin-bottom: 8px; }
        .xzg-ve-prop-label { color: #888; margin-bottom: 3px; }
        .xzg-ve-prop-input {
            width: 100%; padding: 4px 6px; background: #1a1a1a; border: 1px solid #444;
            border-radius: 3px; color: #ddd; font-size: 11px; box-sizing: border-box;
        }
        .xzg-ve-prop-input:focus { border-color: #dcc85b; outline: none; }
        .xzg-ve-timeline-panel {
            height: 120px; background: #2a2a2a; border-top: 1px solid #333; flex-shrink: 0;
            display: flex; flex-direction: column;
        }
        .xzg-ve-timeline-header {
            height: 24px; padding: 0 10px; display: flex; align-items: center;
            justify-content: space-between; font-size: 11px; color: #888;
            border-bottom: 1px solid #333; flex-shrink: 0;
        }
        .xzg-ve-tl-info { color: #6699ff; font-size: 10px; }
        .xzg-ve-timeline {
            flex: 1; position: relative; background: #1a1a1a; overflow: hidden;
            min-height: 0; padding: 4px 0;
        }
        .xzg-ve-timeline.xzg-ve-drag-over { background: #2a2a3a; }
        .xzg-ve-sel-box {
            position: absolute; background: rgba(102, 153, 255, 0.15);
            border: 1px dashed #6699ff; pointer-events: none; z-index: 10;
        }
        .xzg-ve-tl-track {
            position: absolute; left: 4px; right: 4px; top: 50%; height: 40px;
            transform: translateY(-50%); background: #111; border-radius: 4px;
            display: flex; gap: 2px; padding: 2px; overflow-x: auto; overflow-y: hidden;
        }
        .xzg-ve-clip {
            flex-shrink: 0; height: 100%; min-width: 30px; border-radius: 3px;
            background: #3a3a3a; border: 1px solid #555; cursor: pointer;
            display: flex; flex-direction: column; justify-content: center;
            padding: 0 6px; position: relative; font-size: 9px; color: #ddd;
            overflow: hidden; transition: border-color 0.15s;
        }
        .xzg-ve-clip:hover { border-color: #dcc85b; }
        .xzg-ve-clip.xzg-ve-selected { border-color: #6699ff; border-width: 2px; }
        .xzg-ve-clip-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .xzg-ve-clip-time { color: #888; font-size: 8px; }
        .xzg-ve-clip-handle {
            position: absolute; top: 0; bottom: 0; width: 6px; cursor: ew-resize;
            background: rgba(255,255,255,0.1);
        }
        .xzg-ve-clip-handle-left { left: 0; border-radius: 3px 0 0 3px; }
        .xzg-ve-clip-handle-right { right: 0; border-radius: 0 3px 3px 0; }
        .xzg-ve-clip-del {
            position: absolute; top: -1px; right: -1px; width: 14px; height: 14px;
            background: #ff6b6b; color: #fff; border: 0; border-radius: 0 3px 0 3px;
            font-size: 10px; cursor: pointer; display: none; line-height: 14px;
            text-align: center; padding: 0;
        }
        .xzg-ve-clip:hover .xzg-ve-clip-del { display: block; }
        .xzg-ve-tl-playhead {
            position: absolute; top: 0; bottom: 0; width: 2px; background: #fff;
            z-index: 5; pointer-events: none; display: none; left: 0;
        }
        .xzg-ve-tl-playhead.xzg-ve-active { display: block; }
        .xzg-ve-timeline-empty {
            position: absolute; inset: 0; display: flex; align-items: center;
            justify-content: center; color: #444; font-size: 12px; pointer-events: none;
        }
        .xzg-ve-footer {
            height: 40px; padding: 0 12px; background: #2a2a2a; border-top: 1px solid #333;
            display: flex; align-items: center; justify-content: space-between; flex-shrink: 0;
        }
        .xzg-ve-btn {
            padding: 6px 12px; background: #353535; color: #ddd; border: 1px solid #444;
            border-radius: 4px; cursor: pointer; font-size: 12px;
        }
        .xzg-ve-btn:hover { background: #454545; }
        .xzg-ve-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .xzg-ve-btn-apply { background: #a67c00; color: #fff; border-color: #a67c00; }
        .xzg-ve-btn-apply:hover { background: #c89500; }
        .xzg-ve-btn-clear-tl { font-size: 11px; }
        .xzg-ve-footer-right { display: flex; gap: 8px; }
        `;
        document.head.appendChild(st);
    }

    // ═══════════════════════════════════════════════════════════
    //  媒体库
    // ═══════════════════════════════════════════════════════════

    // 根据 name+type 创建媒体对象，若全局探测缓存命中则直接填充 info 与 probeState
    _makeMediaItem(name, type) {
        const key = `${name}|${type}`;
        const cached = _XZG_VE_PROBE_CACHE[key];
        if (cached && cached.state === "ok") {
            return { name, type, info: cached.info, probeState: "ok", error: null };
        } else if (cached && cached.state === "failed") {
            return { name, type, info: null, probeState: "failed", error: cached.error };
        }
        return { name, type, info: null, probeState: "pending", error: null };
    }

    async _loadMediaLibrary() {
        this._setStatus("加载媒体库...");
        try {
            const data = await _postJson(API_LIST, {});
            if (data.error) throw new Error(data.error);
            const hidden = this._getHiddenSet();
            const videos = (data.videos || []).filter(name => !hidden.has(name));
            let pendingCount = 0;
            for (const name of videos) {
                if (!this.mediaLibrary.find(m => m.name === name)) {
                    const item = this._makeMediaItem(name, "input");
                    this.mediaLibrary.push(item);
                    if (item.probeState === "pending") pendingCount++;
                }
            }
            this._renderMediaList();
            if (pendingCount > 0) {
                this._setStatus(`媒体库已加载 (${videos.length} 个视频), 探测中...`);
                // 串行 probe 避免并发阻塞 ffmpeg
                this._probeQueue();
            } else {
                this._setStatus(`媒体库已加载 (${videos.length} 个视频)`);
            }
        } catch (e) {
            this._setStatus(`加载失败: ${e.message}`);
        }
    }

    async _probeQueue() {
        for (const m of this.mediaLibrary) {
            if (m.probeState !== "pending") continue;
            const key = this._mediaKey(m);
            // 二次检查缓存：另一个实例可能已完成探测
            const cached = _XZG_VE_PROBE_CACHE[key];
            if (cached && cached.state === "ok") {
                m.info = cached.info;
                m.probeState = "ok";
                m.error = null;
                this._renderMediaList();
                continue;
            } else if (cached && cached.state === "failed") {
                m.probeState = "failed";
                m.error = cached.error;
                this._renderMediaList();
                continue;
            }
            // 全局去重：已在探测中就等结果，此处跳过并延后处理
            if (_XZG_VE_PROBE_LOADING.has(key)) continue;
            _XZG_VE_PROBE_LOADING.add(key);
            m.probeState = "probing";
            this._renderMediaList();
            try {
                const info = await _postJson(API_PROBE, { filename: m.name, type: m.type });
                if (info.error) {
                    m.probeState = "failed";
                    m.error = info.error;
                    _XZG_VE_PROBE_CACHE[key] = { state: "failed", error: info.error, mtime: Date.now() };
                } else {
                    m.info = info;
                    m.probeState = "ok";
                    m.error = null;
                    _XZG_VE_PROBE_CACHE[key] = { state: "ok", info, mtime: Date.now() };
                }
            } catch (e) {
                m.probeState = "failed";
                m.error = e.message;
                _XZG_VE_PROBE_CACHE[key] = { state: "failed", error: e.message, mtime: Date.now() };
            } finally {
                _XZG_VE_PROBE_LOADING.delete(key);
            }
            this._renderMediaList();
            // 若时间线已有该视频的片段，同步更新其时长
            if (m.info) {
                for (const clip of this.timeline) {
                    if (clip.filename === m.name && clip.durationPending) {
                        clip.sourceDuration = m.info.duration;
                        // 限制 end 不超过真实时长
                        if (clip.end > m.info.duration) clip.end = m.info.duration;
                        if (clip.start > clip.end - 0.1) clip.start = Math.max(0, clip.end - 0.1);
                        clip.durationPending = false;
                    }
                }
                this._renderTimeline();
                if (this.selectedClipIds.size > 0) this._renderProps();
            }
        }
        const okCount = this.mediaLibrary.filter(m => m.probeState === "ok").length;
        this._setStatus(`媒体库探测完成 (${okCount}/${this.mediaLibrary.length} 成功)`);
    }

    _renderMediaList() {
        const list = this._mediaList;
        // 保存缩略图滑条（在列表内部），避免被 innerHTML 清掉
        const sizeBar = list.querySelector(".xzg-ve-thumb-size-bar");
        list.innerHTML = "";
        // 缩略图模式：列表容器加 grid 类
        list.classList.toggle("xzg-ve-list-thumb", this._thumbnailMode);
        // 先添加媒体项
        if (this.mediaLibrary.length === 0) {
            _el("div", "xzg-ve-timeline-empty", "点击「＋ 添加」上传视频", list);
        } else {
            for (const m of this.mediaLibrary) {
            const item = _el("div", "xzg-ve-media-item", null, list);
            item.draggable = true;
            item.dataset.name = m.name;
            item.dataset.type = m.type;
            if (this.selectedMediaNames.has(m.name)) item.classList.add("xzg-ve-media-selected");
            // 缩略图模式：上方放缩略图
            if (this._thumbnailMode) {
                const thumbWrap = _el("div", "xzg-ve-media-thumb", null, item);
                thumbWrap.dataset.name = m.name;
                thumbWrap.dataset.type = m.type;
                const key = this._mediaKey(m);
                const cacheEntry = _XZG_VE_THUMB_CACHE[key];
                if (cacheEntry && cacheEntry.url) {
                    const img = _el("img", null, null, thumbWrap);
                    img.src = cacheEntry.url;
                } else if (cacheEntry && cacheEntry.failed) {
                    _el("div", "xzg-ve-media-thumb-placeholder", "❌", thumbWrap);
                } else {
                    _el("div", "xzg-ve-media-thumb-placeholder", "加载中", thumbWrap);
                    this._loadThumbnail(m);
                }
            }
            _el("div", "xzg-ve-media-name", m.name, item);
            let infoText = "";
            let infoClass = "xzg-ve-media-info";
            if (m.probeState === "ok" && m.info) {
                infoText = `${m.info.width}×${m.info.height} · ${_fmtTime(m.info.duration)}`;
            } else if (m.probeState === "failed") {
                infoText = "❌ 探测失败";
                infoClass += " xzg-ve-media-info-err";
                item.title = m.error || "未知错误";
            } else if (m.probeState === "probing") {
                infoText = "⏳ 探测中...";
            } else {
                infoText = "⌛ 等待探测";
            }
            _el("div", infoClass, infoText, item);
            // mousedown 选中（不影响拖拽，dragstart 在 mousedown 之后触发）
            item.addEventListener("mousedown", (e) => {
                if (e.ctrlKey || e.metaKey) {
                    if (this.selectedMediaNames.has(m.name)) {
                        this.selectedMediaNames.delete(m.name);
                    } else {
                        this.selectedMediaNames.add(m.name);
                    }
                } else {
                    if (!this.selectedMediaNames.has(m.name)) {
                        this.selectedMediaNames = new Set([m.name]);
                    }
                }
                // 点媒体时清空时间线选中
                if (this.selectedClipIds.size > 0) {
                    this.selectedClipIds.clear();
                    this._renderTimeline();
                    this._renderProps();
                }
                this._renderMediaList();
                e.stopPropagation();
            });
            item.addEventListener("dragstart", (e) => {
                e.dataTransfer.setData("text/x-media-name", m.name);
                e.dataTransfer.setData("text/x-media-type", m.type);
                e.dataTransfer.effectAllowed = "copy";
            });
            item.addEventListener("dblclick", () => {
                this._addClipToTimeline(m.name, m.type);
            });
        }
        } // end else (mediaLibrary not empty)
        // 重新追加缩略图滑条到列表末尾
        if (sizeBar) list.appendChild(sizeBar);
    }

    // ═══════════════════════════════════════════════════════════
    //  缩略图模式辅助方法
    // ═══════════════════════════════════════════════════════════
    _mediaKey(m) {
        return `${m.name}|${m.type}`;
    }

    _toggleThumbMode() {
        this._thumbnailMode = !this._thumbnailMode;
        try { localStorage.setItem(this._thumbModeKey, this._thumbnailMode ? "1" : "0"); } catch (_) {}
        this._updateThumbBtn();
        this._updateThumbSizeBarVisibility();
        this._renderMediaList();
    }

    _updateThumbBtn() {
        if (!this._thumbBtn) return;
        this._thumbBtn.textContent = this._thumbnailMode ? "缩略图" : "列表";
    }

    _updateThumbSizeBarVisibility() {
        if (this._thumbSizeBar) {
            this._thumbSizeBar.classList.toggle("xzg-ve-visible", this._thumbnailMode);
        }
    }

    // 应用缩略图大小（通过 CSS 变量控制网格列宽）
    _applyThumbSize() {
        if (this._mediaList) {
            this._mediaList.style.setProperty("--xzg-thumb-w", this._thumbSize + "px");
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  媒体库面板宽度拖动调整
    // ═══════════════════════════════════════════════════════════
    _restoreMediaWidth() {
        try {
            const w = parseInt(localStorage.getItem(this._mediaWidthKey), 10);
            if (w >= 160 && w <= 600 && this._mediaPanel) {
                this._mediaPanel.style.width = w + "px";
            }
        } catch (_) {}
    }

    _saveMediaWidth(w) {
        try { localStorage.setItem(this._mediaWidthKey, String(w)); } catch (_) {}
    }

    _bindResizer() {
        if (!this._resizer || !this._mediaPanel) return;
        this._resizer.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this._resizer.classList.add("xzg-ve-resizing");
            const panel = this._mediaPanel;
            const startX = e.clientX;
            const startW = panel.getBoundingClientRect().width;
            const onMove = (ev) => {
                let w = startW + (ev.clientX - startX);
                if (w < 160) w = 160;
                if (w > 600) w = 600;
                panel.style.width = w + "px";
            };
            const onUp = () => {
                window.removeEventListener("mousemove", onMove);
                window.removeEventListener("mouseup", onUp);
                this._resizer.classList.remove("xzg-ve-resizing");
                const finalW = Math.round(panel.getBoundingClientRect().width);
                this._saveMediaWidth(finalW);
                this._setStatus(`媒体库宽度: ${finalW}px`);
            };
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
        });
    }

    // 异步加载缩略图：probe 完成后取视频第 1 秒（或中段）的帧
    async _loadThumbnail(m) {
        const key = this._mediaKey(m);
        const cached = _XZG_VE_THUMB_CACHE[key];
        if (cached) {
            // 已命中缓存（成功或失败），直接填 UI
            if (cached.url) this._applyThumbImg(m, cached.url);
            else if (cached.failed) this._applyThumbPlaceholder(m, "❌");
            return;
        }
        if (_XZG_VE_THUMB_LOADING.has(key)) return;
        _XZG_VE_THUMB_LOADING.add(key);
        try {
            // 等 probe 完成（最多等 12s）
            const t0 = Date.now();
            while (m.probeState !== "ok" && m.probeState !== "failed") {
                if (Date.now() - t0 > 12000) break;
                await new Promise(r => setTimeout(r, 300));
            }
            if (m.probeState !== "ok") {
                _XZG_VE_THUMB_CACHE[key] = { url: null, failed: true };
                this._applyThumbPlaceholder(m, "❌");
                return;
            }
            const dur = m.info?.duration || 0;
            const t = dur > 2 ? Math.min(1, dur * 0.1) : 0;
            const data = await _postJson(API_EXTRACT, {
                filename: m.name, type: m.type, time: t,
            });
            if (data.error) throw new Error(data.error);
            // data.filename 是 input 目录下的 png 名
            const url = `/view?filename=${encodeURIComponent(data.filename)}&type=input&subfolder=&t=${Date.now()}`;
            _XZG_VE_THUMB_CACHE[key] = { url, failed: false };
            this._applyThumbImg(m, url);
        } catch (e) {
            _XZG_VE_THUMB_CACHE[key] = { url: null, failed: true };
            this._applyThumbPlaceholder(m, "❌");
        } finally {
            _XZG_VE_THUMB_LOADING.delete(key);
        }
    }

    // 把已缓存的缩略图填入对应的 DOM（避免全量重渲染打断框选）
    _applyThumbImg(m, url) {
        const items = this._mediaList?.querySelectorAll(".xzg-ve-media-thumb");
        if (!items) return;
        for (const wrap of items) {
            if (wrap.dataset.name === m.name && wrap.dataset.type === m.type) {
                if (wrap.querySelector("img")) continue;
                wrap.innerHTML = "";
                const img = _el("img", null, null, wrap);
                img.src = url;
            }
        }
    }

    _applyThumbPlaceholder(m, text) {
        const items = this._mediaList?.querySelectorAll(".xzg-ve-media-thumb");
        if (!items) return;
        for (const wrap of items) {
            if (wrap.dataset.name === m.name && wrap.dataset.type === m.type) {
                if (wrap.querySelector("img")) continue;
                wrap.innerHTML = "";
                _el("div", "xzg-ve-media-thumb-placeholder", text, wrap);
            }
        }
    }

    _removeMedia(name) {
        const idx = this.mediaLibrary.findIndex(m => m.name === name);
        if (idx < 0) return;
        this.mediaLibrary.splice(idx, 1);
        this.selectedMediaNames.delete(name);
        this._addHidden(name);  // 持久化到黑名单，下次不再加载
        this._renderMediaList();
        this._setStatus(`已从媒体库移除: ${name}（文件未删除）`);
    }

    _clearMediaLibrary() {
        if (this.mediaLibrary.length === 0) {
            this._setStatus("媒体库已为空");
            return;
        }
        const n = this.mediaLibrary.length;
        // 全部加入黑名单
        const hidden = this._getHiddenSet();
        for (const m of this.mediaLibrary) hidden.add(m.name);
        this._saveHiddenSet(hidden);
        this.mediaLibrary = [];
        this.selectedMediaNames.clear();
        this._renderMediaList();
        this._setStatus(`已清空媒体库 (${n} 个视频，文件未删除)`);
    }

    async _addFromInput() {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = VIDEO_EXTS.map(e => "." + e).join(",");
        input.multiple = true;
        input.onchange = async () => {
            const files = Array.from(input.files || []).filter(f => _isVideo(f.name));
            if (files.length === 0) return;
            this._setStatus(`上传 ${files.length} 个文件...`);
            const uploaded = [];
            for (const f of files) {
                try {
                    const name = await this._uploadFile(f);
                    if (!this.mediaLibrary.find(m => m.name === name)) {
                        this.mediaLibrary.push(this._makeMediaItem(name, "input"));
                        uploaded.push(name);
                    }
                } catch (e) {
                    this._setStatus(`上传失败: ${e.message}`);
                }
            }
            this._renderMediaList();
            if (uploaded.length > 0) {
                this._setStatus(`已上传 ${uploaded.length} 个视频, 探测中...`);
                this._probeQueue();
            }
        };
        input.click();
    }

    async _uploadFile(file) {
        // 复用已有的上传 API
        const chunkSize = 20 * 1024 * 1024;
        const totalChunks = Math.ceil(file.size / chunkSize);
        const safeName = `${Date.now()}_${file.name.replace(/[^\w.\-]/g, "_")}`;

        // 启动会话
        const startResp = await _postJson("/xzg/video_upload_start", {
            filename: safeName,
            total_size: file.size,
            total_chunks: totalChunks,
        });
        if (startResp.error) throw new Error(startResp.error);
        const sessionId = startResp.session_id;
        const filename = startResp.filename;

        // 上传分块
        for (let i = 0; i < totalChunks; i++) {
            const offset = i * chunkSize;
            const blob = file.slice(offset, Math.min(offset + chunkSize, file.size));
            const formData = new FormData();
            formData.append("session_id", sessionId);
            formData.append("chunk_index", i);
            formData.append("chunk_offset", offset);
            formData.append("chunk", blob, `chunk_${i}`);
            const resp = await api.fetchApi("/xzg/video_upload_chunk", {
                method: "POST",
                body: formData,
            });
            const data = await resp.json();
            if (data.error) throw new Error(data.error);
        }
        return filename;
    }

    async _addToLibraryAndTimeline(filename, type) {
        let newItem = null;
        if (!this.mediaLibrary.find(m => m.name === filename)) {
            newItem = this._makeMediaItem(filename, type);
            this.mediaLibrary.push(newItem);
            this._renderMediaList();
            if (newItem.probeState === "pending") this._probeQueue();
        }
        this._addClipToTimeline(filename, type);
    }

    // ═══════════════════════════════════════════════════════════
    //  时间线
    // ═══════════════════════════════════════════════════════════
    _addClipToTimeline(filename, type) {
        const media = this.mediaLibrary.find(m => m.name === filename);
        const duration = media?.info?.duration || 0;
        // 即使 probe 未完成或失败也允许添加，用占位时长 60s（probe 完成后会自动更新）
        const placeholderDur = duration > 0 ? duration : 60;
        const clip = {
            id: ++this._clipIdCounter,
            filename,
            type,
            name: filename,
            start: 0,
            end: placeholderDur,
            sourceDuration: placeholderDur,
            durationPending: duration <= 0,  // 标记等 probe 完成后更新
        };
        this.timeline.push(clip);
        this.selectedClipIds = new Set([clip.id]);
        this._renderTimeline();
        this._renderProps();
        this._loadClipToPreview(clip);
        if (duration > 0) {
            this._setStatus(`已添加片段: ${filename} (${_fmtTime(duration)})`);
        } else {
            this._setStatus(`已添加片段: ${filename} (时长待探测，使用占位 60s)`);
        }
    }

    _renderTimeline() {
        const track = this._tlTrack;
        track.innerHTML = "";
        if (this.timeline.length === 0) {
            _el("div", "xzg-ve-timeline-empty", "拖拽媒体库中的视频到此处", track);
            this._tlInfo.textContent = "";
            return;
        }
        // 计算总时长
        const total = this.timeline.reduce((s, c) => s + (c.end - c.start), 0);
        this._tlInfo.textContent = `${this.timeline.length} 片段 · 总时长 ${_fmtTime(total)}`;

        for (const clip of this.timeline) {
            const el = _el("div", "xzg-ve-clip", null, track);
            if (this.selectedClipIds.has(clip.id)) el.classList.add("xzg-ve-selected");
            // 宽度按片段时长占比（最小 60px）
            const w = Math.max(60, (clip.end - clip.start) * 30);
            el.style.width = `${w}px`;

            _el("div", "xzg-ve-clip-name", clip.name, el);
            _el("div", "xzg-ve-clip-time", `${_fmtTime(clip.start)}→${_fmtTime(clip.end)}`, el);

            // 左右拖拽手柄
            const lh = _el("div", "xzg-ve-clip-handle xzg-ve-clip-handle-left", null, el);
            const rh = _el("div", "xzg-ve-clip-handle xzg-ve-clip-handle-right", null, el);
            const del = _el("button", "xzg-ve-clip-del", "×", el);

            el.addEventListener("mousedown", (e) => {
                if (e.target === lh || e.target === rh || e.target === del) return;
                e.stopPropagation();
            });
            el.addEventListener("click", (e) => {
                if (e.target === lh || e.target === rh || e.target === del) return;
                if (e.ctrlKey || e.metaKey) {
                    // Ctrl/Cmd 切换选中
                    if (this.selectedClipIds.has(clip.id)) {
                        this.selectedClipIds.delete(clip.id);
                    } else {
                        this.selectedClipIds.add(clip.id);
                    }
                } else {
                    // 单选
                    this.selectedClipIds = new Set([clip.id]);
                    this._loadClipToPreview(clip);
                }
                // 点片段时清空媒体选中
                if (this.selectedMediaNames.size > 0) {
                    this.selectedMediaNames.clear();
                    this._renderMediaList();
                }
                this._renderTimeline();
                this._renderProps();
            });

            // 拖拽重排
            el.draggable = true;
            el.addEventListener("dragstart", (e) => {
                this._draggingClip = clip.id;
                e.dataTransfer.setData("text/x-clip-id", String(clip.id));
                e.dataTransfer.effectAllowed = "move";
            });
            el.addEventListener("dragover", (e) => e.preventDefault());
            el.addEventListener("drop", (e) => {
                e.preventDefault();
                const srcId = parseInt(e.dataTransfer.getData("text/x-clip-id"));
                if (srcId && srcId !== clip.id) {
                    this._reorderClip(srcId, clip.id);
                }
            });

            // 调整入点
            lh.addEventListener("pointerdown", (e) => this._onHandleDown(e, clip, "left"));
            rh.addEventListener("pointerdown", (e) => this._onHandleDown(e, clip, "right"));
            del.addEventListener("click", (e) => {
                e.stopPropagation();
                this._deleteClip(clip.id);
            });
        }
    }

    _reorderClip(srcId, dstId) {
        const srcIdx = this.timeline.findIndex(c => c.id === srcId);
        const dstIdx = this.timeline.findIndex(c => c.id === dstId);
        if (srcIdx < 0 || dstIdx < 0) return;
        const [clip] = this.timeline.splice(srcIdx, 1);
        this.timeline.splice(dstIdx, 0, clip);
        this._renderTimeline();
    }

    _deleteClip(id) {
        const idx = this.timeline.findIndex(c => c.id === id);
        if (idx < 0) return;
        this.timeline.splice(idx, 1);
        this.selectedClipIds.delete(id);
        this._renderTimeline();
        this._renderProps();
    }

    _clearTimeline() {
        this.timeline = [];
        this.selectedClipIds.clear();
        this._renderTimeline();
        this._renderProps();
        this._video.src = "";
        this._video.classList.remove("xzg-ve-active");
        this._previewEmpty.classList.remove("xzg-ve-hidden");
        this._playhead.classList.remove("xzg-ve-active");
    }

    // ═══════════════════════════════════════════════════════════
    //  框选
    // ═══════════════════════════════════════════════════════════
    _onTimelineMouseDown(e) {
        // 只在时间线空白区域（非片段、非手柄、非删除按钮）启动框选
        const target = e.target;
        if (target.closest(".xzg-ve-clip")) return;
        // 只接受左键
        if (e.button !== 0) return;

        const tlRect = this._timeline.getBoundingClientRect();
        const startX = e.clientX - tlRect.left;
        const startY = e.clientY - tlRect.top;

        // 创建选择框元素
        const box = document.createElement("div");
        box.className = "xzg-ve-sel-box";
        box.style.left = `${startX}px`;
        box.style.top = `${startY}px`;
        box.style.width = "0px";
        box.style.height = "0px";
        this._timeline.appendChild(box);
        this._selectionBox = box;

        // 非 Ctrl 点击 → 清空选中
        if (!e.ctrlKey && !e.metaKey) {
            this.selectedClipIds.clear();
            this._renderTimeline();
            this._renderProps();
            if (this.selectedMediaNames.size > 0) {
                this.selectedMediaNames.clear();
                this._renderMediaList();
            }
        }

        let curX = startX, curY = startY;
        const onMove = (ev) => {
            curX = ev.clientX - tlRect.left;
            curY = ev.clientY - tlRect.top;
            const left = Math.min(curX, startX);
            const top = Math.min(curY, startY);
            const w = Math.abs(curX - startX);
            const h = Math.abs(curY - startY);
            box.style.left = `${left}px`;
            box.style.top = `${top}px`;
            box.style.width = `${w}px`;
            box.style.height = `${h}px`;
        };
        const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
            // 计算选择框与每个片段的交集
            const boxRect = box.getBoundingClientRect();
            this.selectedClipIds = new Set();
            const clips = this._tlTrack.querySelectorAll(".xzg-ve-clip");
            clips.forEach((clipEl, i) => {
                const r = clipEl.getBoundingClientRect();
                // 矩形相交判定
                const intersect = !(r.right < boxRect.left || r.left > boxRect.right ||
                                     r.bottom < boxRect.top || r.top > boxRect.bottom);
                if (intersect) {
                    const clip = this.timeline[i];
                    if (clip) this.selectedClipIds.add(clip.id);
                }
            });
            // 选择框太小时（点击空白）→ 已清空选中，保持空
            if (box.parentNode) box.parentNode.removeChild(box);
            this._selectionBox = null;
            this._renderTimeline();
            this._renderProps();
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        e.preventDefault();
    }

    _onMediaListMouseDown(e) {
        // 只在媒体列表空白区域（非媒体项）启动框选
        if (e.target.closest(".xzg-ve-media-item")) return;
        if (e.button !== 0) return;

        const listRect = this._mediaList.getBoundingClientRect();
        const startX = e.clientX - listRect.left;
        const startY = e.clientY - listRect.top;

        // 非 Ctrl 点击 → 先清空选中并重渲染列表
        // 注意：必须在 appendChild(box) 之前执行 _renderMediaList，
        // 因为 _renderMediaList 内部会 innerHTML="" 把 box 一起清掉
        if (!e.ctrlKey && !e.metaKey) {
            this.selectedMediaNames.clear();
            this._renderMediaList();
        }

        const box = document.createElement("div");
        box.className = "xzg-ve-sel-box xzg-ve-media-sel-box";
        box.style.left = `${startX}px`;
        box.style.top = `${startY}px`;
        box.style.width = "0px";
        box.style.height = "0px";
        this._mediaList.appendChild(box);
        this._mediaSelBox = box;

        const onMove = (ev) => {
            const curX = ev.clientX - listRect.left;
            const curY = ev.clientY - listRect.top;
            const left = Math.min(curX, startX);
            const top = Math.min(curY, startY);
            const w = Math.abs(curX - startX);
            const h = Math.abs(curY - startY);
            box.style.left = `${left}px`;
            box.style.top = `${top}px`;
            box.style.width = `${w}px`;
            box.style.height = `${h}px`;
            // 实时高亮被框选矩形覆盖的媒体项（黑底白字，与最终选中态一致）
            const boxL = listRect.left + left;
            const boxT = listRect.top + top;
            const boxR = boxL + w;
            const boxB = boxT + h;
            const items = this._mediaList.querySelectorAll(".xzg-ve-media-item");
            items.forEach((itemEl) => {
                const r = itemEl.getBoundingClientRect();
                const intersect = !(r.right < boxL || r.left > boxR ||
                                     r.bottom < boxT || r.top > boxB);
                itemEl.classList.toggle("xzg-ve-media-selected", intersect);
            });
        };
        const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
            const boxRect = box.getBoundingClientRect();
            // 非 Ctrl → 替换选中；Ctrl → 追加选中
            if (!e.ctrlKey && !e.metaKey) {
                this.selectedMediaNames = new Set();
            }
            const items = this._mediaList.querySelectorAll(".xzg-ve-media-item");
            items.forEach((itemEl) => {
                const r = itemEl.getBoundingClientRect();
                const intersect = !(r.right < boxRect.left || r.left > boxRect.right ||
                                     r.bottom < boxRect.top || r.top > boxRect.bottom);
                if (intersect) {
                    const name = itemEl.dataset.name;
                    if (name) this.selectedMediaNames.add(name);
                }
            });
            if (box.parentNode) box.parentNode.removeChild(box);
            this._mediaSelBox = null;
            this._renderMediaList();
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        e.preventDefault();
    }

    _onHandleDown(e, clip, which) {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startVal = which === "left" ? clip.start : clip.end;
        const media = this.mediaLibrary.find(m => m.name === clip.filename);
        const maxDur = media?.info?.duration || clip.sourceDuration;

        const move = (ev) => {
            // 1px = 0.05s
            const delta = (ev.clientX - startX) * 0.05;
            let newVal = startVal + delta;
            newVal = Math.max(0, Math.min(maxDur, newVal));
            if (which === "left") {
                clip.start = Math.min(newVal, clip.end - 0.1);
            } else {
                clip.end = Math.max(newVal, clip.start + 0.1);
            }
            this._renderTimeline();
            this._renderProps();
        };
        const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
    }

    // ═══════════════════════════════════════════════════════════
    //  预览
    // ═══════════════════════════════════════════════════════════
    _loadClipToPreview(clip) {
        if (!clip) return;
        const url = this._videoUrl(clip.filename, clip.type);
        this._video.src = url;
        this._video.classList.add("xzg-ve-active");
        this._previewEmpty.classList.add("xzg-ve-hidden");
        this._currentClip = clip;
        // 跳到片段起始位置
        this._video.addEventListener("loadedmetadata", () => {
            this._video.currentTime = clip.start;
        }, { once: true });
    }

    _videoUrl(filename, type) {
        const params = new URLSearchParams({ filename, type: type || "input" });
        return `/view?${params.toString()}`;
    }

    _togglePlay() {
        if (!this._video.src) return;
        if (this._video.paused) {
            this._video.play().catch(() => {});
            this._root.querySelector(".xzg-ve-play-btn").textContent = "⏸";
        } else {
            this._video.pause();
            this._root.querySelector(".xzg-ve-play-btn").textContent = "▶";
        }
    }

    _onTimeUpdate() {
        this._updateTimeDisplay();
        // 更新播放头位置（相对于当前片段在时间线上的位置）
        if (this._currentClip) {
            const clip = this._currentClip;
            const t = this._video.currentTime;
            // 播放头在片段内的进度
            const progress = (t - clip.start) / (clip.end - clip.start);
            // 找到片段在时间线上的偏移
            let offset = 0;
            for (const c of this.timeline) {
                if (c.id === clip.id) break;
                offset += (c.end - c.start);
            }
            const clipDur = clip.end - clip.start;
            const tlTotal = this.timeline.reduce((s, c) => s + (c.end - c.start), 0);
            if (tlTotal > 0) {
                const pct = ((offset + progress * clipDur) / tlTotal) * 100;
                this._playhead.style.left = `calc(4px + ${pct}% * (100% - 8px) / 100%)`;
                this._playhead.classList.add("xzg-ve-active");
            }
            // 超出出点 → 停止
            if (t >= clip.end) {
                this._video.pause();
                this._root.querySelector(".xzg-ve-play-btn").textContent = "▶";
            }
        }
    }

    _updateTimeDisplay() {
        const cur = this._video.currentTime || 0;
        const dur = this._video.duration || 0;
        this._timeLabel.textContent = `${_fmtTime(cur)} / ${_fmtTime(dur)}`;
    }

    // ═══════════════════════════════════════════════════════════
    //  属性面板
    // ═══════════════════════════════════════════════════════════
    _renderProps() {
        const c = this._propsContent;
        c.innerHTML = "";
        const selClips = this.timeline.filter(cl => this.selectedClipIds.has(cl.id));
        if (selClips.length === 0) {
            _el("div", "", "未选中片段", c);
            return;
        }
        if (selClips.length > 1) {
            _el("div", "xzg-ve-prop-row", null, c);
            _el("div", "xzg-ve-prop-label", `已选中 ${selClips.length} 个片段`, c);
            const totalDur = selClips.reduce((s, cl) => s + (cl.end - cl.start), 0);
            _el("div", "", `总时长 ${_fmtTime(totalDur)}`, c);
            const delBtn = _el("button", "xzg-ve-btn", "🗑 删除选中", c);
            delBtn.style.width = "100%";
            delBtn.style.marginTop = "6px";
            delBtn.style.background = "#5a2a2a";
            delBtn.onclick = () => {
                const ids = Array.from(this.selectedClipIds);
                for (const id of ids) {
                    const idx = this.timeline.findIndex(cl => cl.id === id);
                    if (idx >= 0) this.timeline.splice(idx, 1);
                }
                this.selectedClipIds.clear();
                this._renderTimeline();
                this._renderProps();
                this._setStatus(`已删除 ${ids.length} 个片段`);
            };
            return;
        }
        const clip = selClips[0];
        const row1 = _el("div", "xzg-ve-prop-row", null, c);
        _el("div", "xzg-ve-prop-label", "文件", row1);
        _el("div", "", clip.name, row1);

        const row2 = _el("div", "xzg-ve-prop-row", null, c);
        _el("div", "xzg-ve-prop-label", "入点 (秒)", row2);
        const inInput = _el("input", "xzg-ve-prop-input", null, row2);
        inInput.type = "number";
        inInput.step = "0.01";
        inInput.min = "0";
        inInput.max = String(clip.sourceDuration);
        inInput.value = clip.start.toFixed(2);
        inInput.onchange = () => {
            const v = parseFloat(inInput.value) || 0;
            clip.start = Math.max(0, Math.min(v, clip.end - 0.1));
            this._renderTimeline();
            this._renderProps();
        };

        const row3 = _el("div", "xzg-ve-prop-row", null, c);
        _el("div", "xzg-ve-prop-label", "出点 (秒)", row3);
        const outInput = _el("input", "xzg-ve-prop-input", null, row3);
        outInput.type = "number";
        outInput.step = "0.01";
        outInput.min = "0";
        outInput.max = String(clip.sourceDuration);
        outInput.value = clip.end.toFixed(2);
        outInput.onchange = () => {
            const v = parseFloat(outInput.value) || 0;
            clip.end = Math.max(clip.start + 0.1, Math.min(v, clip.sourceDuration));
            this._renderTimeline();
            this._renderProps();
        };

        const row4 = _el("div", "xzg-ve-prop-row", null, c);
        _el("div", "xzg-ve-prop-label", "片段时长", row4);
        _el("div", "", _fmtTime(clip.end - clip.start), row4);

        const row5 = _el("div", "xzg-ve-prop-row", null, c);
        const btn = _el("button", "xzg-ve-btn", "载入到预览", row5);
        btn.style.width = "100%";
        btn.onclick = () => this._loadClipToPreview(clip);
    }

    // ═══════════════════════════════════════════════════════════
    //  导出
    // ═══════════════════════════════════════════════════════════
    async _exportFrame() {
        if (!this._video.src) {
            this._setStatus("无视频播放");
            return;
        }
        const t = this._video.currentTime || 0;
        if (!this._currentClip) return;
        this._setStatus(`导出 ${_fmtTime(t)} 处单帧...`);
        try {
            const data = await _postJson(API_EXTRACT, {
                filename: this._currentClip.filename,
                type: this._currentClip.type,
                time: t,
            });
            if (data.error) throw new Error(data.error);
            this._setStatus(`已导出帧: ${data.filename}`);
        } catch (e) {
            this._setStatus(`导出失败: ${e.message}`);
        }
    }

    async _render() {
        if (this.timeline.length === 0) {
            this._setStatus("时间线为空");
            return;
        }
        const btn = this._root.querySelector(".xzg-ve-btn-apply");
        btn.disabled = true;
        btn.textContent = "生成中...";
        const tlData = this.timeline.map(c => ({
            filename: c.filename,
            type: c.type,
            start: c.start,
            end: c.end,
        }));
        this._setStatus(`正在渲染 ${tlData.length} 个片段...`);
        try {
            const data = await _postJson(API_RENDER, { timeline: tlData });
            if (data.error) throw new Error(data.error);
            this._setStatus(`已生成: ${data.filename}`);
            this.onApplied(data.filename, data.type);
            setTimeout(() => this._cancel(), 600);
        } catch (e) {
            this._setStatus(`生成失败: ${e.message}`);
            btn.disabled = false;
            btn.textContent = "⏩ 生成并应用";
        }
    }

    _cancel() {
        this.onCancel();
        this.close();
    }

    _setStatus(msg) {
        if (this._status) this._status.textContent = msg;
    }
}

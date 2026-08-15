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
import { decoderPool, VideoDecoderInstance } from "./xzg_frame_decoder.js";

const API_PROBE = "/xzg_video_editor_probe";
const API_EXTRACT = "/xzg_video_editor_extract_frame";
const API_THUMBS_FULL = "/xzg_video_editor_extract_thumbs_full";
const API_PROBE_AND_THUMBS = "/xzg_video_editor_probe_and_thumbs";
const API_RENDER = "/xzg_video_editor_render";

// mediabunny 库加载状态（需在 HTML 中先加载 /extensions/xiaozhuguang/lib/mediabunny.min.mjs）
let _mbLoaded = false;
async function _ensureMediabunny() {
    if (_mbLoaded || window.mb) { _mbLoaded = true; return; }
    // 动态加载 mediabunny（作为模块）
    await import("./lib/mediabunny.min.mjs").then(m => {
        window.mb = m.default || m;
        _mbLoaded = true;
        console.log("[xzg-ve] mediabunny 已加载");
    }).catch(e => {
        console.error("[xzg-ve] mediabunny 加载失败:", e);
        throw e;
    });
}

// 全局缩略图缓存（跨编辑器实例持久，避免每次打开重新加载）
// 结构: { mediaKey: { url: string | null, failed: boolean } }
// url 存在则为成功缓存；url=null 且 failed=true 表示之前失败不再重试
const _XZG_VE_THUMB_CACHE = {};
// 全局"正在加载中"集合，避免并发重复请求
const _XZG_VE_THUMB_LOADING = new Set();

// 达芬奇式源视频缩略图流缓存（按 name|type 隔离，与片段裁剪无关，一次生成永久复用）
// 结构: { mediaKey: { thumbs: [{url, time}], interval, duration, failed: bool } }
// thumbs 按 time 升序；片段显示时按 [clip.start, clip.end] 范围筛选 + 按需等间隔抽样
const _XZG_VE_FULL_THUMB_STREAM = {};
const _XZG_VE_FULL_THUMB_STREAM_LOADING = new Set();

// 全局探测缓存（跨编辑器实例持久，避免每次打开重新跑 ffmpeg probe）
// 结构: { mediaKey: { state: "ok", info: {...}, mtime: number } | { state: "failed", error: str, mtime: number } }
const _XZG_VE_PROBE_CACHE = {};
// 全局"正在探测中"集合，避免并发重复请求
const _XZG_VE_PROBE_LOADING = new Set();

// 会话媒体列表（sessionStorage）：按节点 ID 隔离，每个化神级节点有独立的媒体库记忆
// - 浏览器刷新/ComfyUI 重启 → sessionStorage 自动清空 → 媒体库从空开始
// - 同一会话内多次打开同一节点的编辑器 → 保留已加载的视频列表
// - 不同节点的媒体库互不影响
// UI 偏好（缩略图模式/大小/面板宽度）用 localStorage 持久化，不受影响
const _XZG_VE_SESSION_MEDIA_PREFIX = "xzg_ve_session_media_";

function _xzgVeSessionKey(nodeId) {
    return _XZG_VE_SESSION_MEDIA_PREFIX + (nodeId || "default");
}

function _xzgVeGetSessionMedia(nodeId) {
    try {
        const raw = sessionStorage.getItem(_xzgVeSessionKey(nodeId));
        return raw ? JSON.parse(raw) : [];
    } catch (_) { return []; }
}

function _xzgVeSaveSessionMedia(nodeId, list) {
    try { sessionStorage.setItem(_xzgVeSessionKey(nodeId), JSON.stringify(list)); } catch (_) {}
}

function _xzgVeAddSessionMedia(nodeId, name, type) {
    const list = _xzgVeGetSessionMedia(nodeId);
    if (!list.find(m => m.name === name && m.type === type)) {
        list.push({ name, type });
        _xzgVeSaveSessionMedia(nodeId, list);
    }
}

function _xzgVeRemoveSessionMedia(nodeId, name) {
    const list = _xzgVeGetSessionMedia(nodeId).filter(m => m.name !== name);
    _xzgVeSaveSessionMedia(nodeId, list);
}

// 记录上次打开编辑器时节点的当前视频名（per nodeId）
// 用于检测节点是否更换了视频：变化时重置媒体库和时间线
const _XZG_VE_LAST_NODE_VIDEO_PREFIX = "xzg_ve_last_node_video_";
function _xzgVeLastNodeVideoKey(nodeId) {
    return _XZG_VE_LAST_NODE_VIDEO_PREFIX + (nodeId || "default");
}
function _xzgVeGetLastNodeVideo(nodeId) {
    try { return sessionStorage.getItem(_xzgVeLastNodeVideoKey(nodeId)) || ""; } catch (_) { return ""; }
}
function _xzgVeSetLastNodeVideo(nodeId, name) {
    try { sessionStorage.setItem(_xzgVeLastNodeVideoKey(nodeId), name || ""); } catch (_) {}
}

// 时间线会话持久化（按节点 ID 隔离，浏览器刷新自动清空）
const _XZG_VE_SESSION_TL_PREFIX = "xzg_ve_session_tl_";
function _xzgVeTlKey(nodeId) { return _XZG_VE_SESSION_TL_PREFIX + (nodeId || "default"); }
function _xzgVeGetSessionTimeline(nodeId) {
    try {
        const raw = sessionStorage.getItem(_xzgVeTlKey(nodeId));
        return raw ? JSON.parse(raw) : [];
    } catch (_) { return []; }
}
function _xzgVeSaveSessionTimeline(nodeId, timeline) {
    try {
        const data = timeline.map(c => ({
            filename: c.filename, type: c.type, name: c.name,
            start: c.start, end: c.end,
            sourceDuration: c.sourceDuration, durationPending: c.durationPending,
            borderColor: c.borderColor || "",
            tlStart: c.tlStart != null ? c.tlStart : -1,
        }));
        sessionStorage.setItem(_xzgVeTlKey(nodeId), JSON.stringify(data));
    } catch (_) {}
}
function _xzgVeClearSessionTimeline(nodeId) {
    try { sessionStorage.removeItem(_xzgVeTlKey(nodeId)); } catch (_) {}
}

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

// 刻度标签简短格式：< 60s 显示秒，≥60s 显示 mm:ss
function _fmtTickTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    if (s < 60) return s.toFixed(s < 10 ? 1 : 0) + "s";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s - m * 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
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
        this.nodeId = opts.nodeId || "";  // 节点 ID，用于隔离媒体库会话记忆
        // 外部传入的初始媒体列表（批量上传多个视频时使用）：[{name, type}]
        this.extraMedia = Array.isArray(opts.extraMedia) ? opts.extraMedia : [];
        // 剪辑界面与节点参数完全解耦：帧率始终用原视频帧率，分辨率由编辑器内自定义设置
        // _renderTargetW/H: 渲染目标分辨率（null=用首个片段原分辨率）
        this._renderTargetW = null;
        this._renderTargetH = null;

        // 媒体库: [{name, type, info: {width,height,fps,duration}}]
        this.mediaLibrary = [];
        // 时间线片段: [{id, filename, type, start, end, name}]
        this.timeline = [];
        this.selectedClipIds = new Set();  // 多选集合
        this._clipIdCounter = 0;
        this._root = null;
        this._canvas = null;       // 预览区 canvas（替代 <video>）
        this._draggingClip = null;
        this._destroyed = false;
        // 历史记录栈（用于 Ctrl+Z / Ctrl+Shift+Z 撤销/重做）
        this._undoStack = [];
        this._redoStack = [];
        this._historyMax = 50;
        // E12: 已移除 _currentVideoSrc（<video> 架构残留）
        this._keyHandler = null;  // 键盘事件引用，close 时移除
        this._selectionBox = null;  // 框选矩形元素
        // 时间线全局播放状态
        this._tlGlobalTime = 0;      // 当前全局播放位置（秒）
        this._tlPlaying = false;      // 是否正在播放
        // E13: 已移除 _tlSeeking（<video> 架构残留）
        this._currentClip = null;     // 当前加载到 canvas 的片段
        this._playheadDrag = false;  // 播放头拖动中
        // Canvas 解码相关：当前解码器实例 + RAF 节流
        this._currentDecoder = null;  // 当前激活的 VideoDecoderInstance
        this._scrubRafId = null;     // 拖动播放头的 RAF 节流 ID
        // E14: 已移除 _pendingScrubX（<video> 架构残留）
        // 播放预缓冲队列
        this._playbackIterator = null;
        this._playbackIteratorDone = false;  // 迭代器是否已结束（无更多帧）
        this._playbackBuffer = [];
        this._playbackBufferSize = 10;
        this._isBuffering = false;
        this._playbackStartFrame = 0;
        this._playbackStartTime = 0;
        // 音频
        this._audioCtx = null;
        this._audioGain = null;
        this._audioSource = null;
        this._fullAudioBuffer = null;
        this._audioPlayStartOffset = 0;
        this._audioPlayStartTime = 0;
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
        // 时间线面板高度持久化（全局共享）
        this._tlHeightKey = "xzg_ve_tl_height";
        this._tlHeight = 120;
        try {
            const v = parseInt(localStorage.getItem(this._tlHeightKey), 10);
            if (v >= 80 && v <= 500) this._tlHeight = v;
        } catch (_) {}
        this._tlPanel = null;
        this._tlResizer = null;
        this._tlVideoHeader = null;       // 视频轨道头
        this._tlAudioHeader = null;       // 音频轨道头
        this._tlResizerTop = null;        // 上手柄（调整视频高度）
        this._tlResizerMid = null;        // 中手柄（调整视频/音频分配比例）
        this._tlResizerBottom = null;     // 下手柄（调整音频高度）
        this._tlVideoHeight = 60;         // 视频头/轨道高度
        this._tlAudioHeight = 50;         // 音频头/轨道高度
        this._tlVideoTopOffset = 0;      // 视频顶部偏移（相对 16.66%，向下为正）
        this._tlHeightsCustomized = false; // 是否已通过手柄自定义高度（false=默认居中）
        this._playbackRaf = 0;  // 播放时 rAF 循环 id
        // 时间线缩放（Alt+滚轮）与横向滚动
        this._tlZoom = 1;        // 缩放倍数（1=基础30px/s，>1=放大，<1=缩小留白）
        this._tlScrollLeft = 0;  // 横向滚动偏移（px）
        this._tlLeftPad = 150;   // 左侧占位区宽度（px）
        this._thumbLoadingCount = 0;   // 正在加载缩略图的片段计数（>0 时显示全局提示）
        this._tlThumbLoadingHint = null; // 全局缩略图渲染提示元素（挂载到时间线视口）
        this._tlInHandleDrag = false;  // 正在拖动片段手柄裁剪
    }

    open() {
        this._build();
        document.body.appendChild(this._root);
        // DOM 挂载后初始化轨道布局（设置视频/音频 top 位置）
        this._applyTrackLayout();
        // 键盘删除监听
        this._keyHandler = (e) => this._onKeyDown(e);
        // capture 阶段监听，确保在 LiteGraph 画布（bubble 阶段 stopPropagation）之前收到 keydown
        window.addEventListener("keydown", this._keyHandler, true);
        // 窗口大小变化时重绘时间刻度
        this._resizeHandler = () => { this._applyTrackLayout(); this._renderTimeline(); };
        window.addEventListener("resize", this._resizeHandler);
        this._loadMediaLibrary();
        // 不自动把节点当前视频加入时间线，时间线从空开始
        // 用户从媒体库自行拖入需要的片段
    }

    close() {
        if (this._destroyed) return;
        this._destroyed = true;
        this._stopPlaybackLoop();
        this._stopAudio();
        this._hideLoadingOverlay();
        if (this._scrubRafId) { cancelAnimationFrame(this._scrubRafId); this._scrubRafId = null; }
        if (this._keyHandler) {
            window.removeEventListener("keydown", this._keyHandler, true);
            this._keyHandler = null;
        }
        if (this._resizeHandler) {
            window.removeEventListener("resize", this._resizeHandler);
            this._resizeHandler = null;
        }
        // Canvas 解码器不在这里关闭（由 decoderPool 统一管理，跨实例复用）
        this._currentDecoder = null;
        // 清理本实例仍在探测中的 key，避免其他实例永久等待
        for (const m of this.mediaLibrary) {
            if (m.probeState === "probing") {
                const key = this._mediaKey(m);
                _XZG_VE_PROBE_LOADING.delete(key);
                // 重置为 pending，便于下次打开时重试
                m.probeState = "pending";
            }
        }
        if (this._root?.parentNode) this._root.parentNode.removeChild(this._root);
        this._root = null;
        this._canvas = null;
    }

    _onKeyDown(e) {
        // 输入框中不响应快捷键
        const tag = (e.target?.tagName || "").toLowerCase();
        if (tag === "input" || tag === "textarea" || e.target?.isContentEditable) return;
        // Ctrl+Z 撤销 / Ctrl+Shift+Z 重做（也支持 Ctrl+Y 重做）
        if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) {
            e.preventDefault();
            if (e.shiftKey) this._redo();
            else this._undo();
            return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key === "y") {
            e.preventDefault();
            this._redo();
            return;
        }
        // 空格键播放/暂停
        if (e.key === " " || e.code === "Space") {
            // 按住空格会重复触发 keydown，忽略 repeat 避免快速切换播放/暂停
            if (e.repeat) { e.preventDefault(); return; }
            // 焦点在按钮上时，空格键会触发按钮 click，preventDefault 阻止默认 click 避免双重触发，直接执行播放/暂停
            if (this.timeline.length > 0) {
                e.preventDefault();
                this._toggleTimelinePlay();
            }
            return;
        }
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
                        _xzgVeRemoveSessionMedia(this.nodeId, name);
                    }
                }
                this.selectedMediaNames.clear();
                this._renderMediaList();
                this._setStatus(`已删除 ${names.length} 个媒体`);
            }
            // 删除选中的片段
            if (clipSel) {
                this._pushHistory();
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
            return;
        }
        // 左右箭头：单帧步进；Shift+左右箭头：10帧步进
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            if (this.timeline.length === 0) return;
            e.preventDefault();
            const fps = this._currentClip ? this._getClipFps(this._currentClip) : 30;
            const frames = e.shiftKey ? 10 : 1;
            const dt = (e.key === "ArrowRight" ? frames : -frames) / fps;
            const total = this._getTimelineTotalDuration();
            let newTime = this._tlGlobalTime + dt;
            newTime = Math.max(0, Math.min(total, newTime));
            // 步进时暂停播放
            if (this._tlPlaying) this._toggleTimelinePlay();
            this._seekToGlobalTime(newTime);
            return;
        }
        // S 键：在播放头位置分割选中的片段
        if (e.key === "s" || e.key === "S") {
            if (this.timeline.length === 0) return;
            e.preventDefault();
            this._splitClipAtPlayhead();
            return;
        }
    }

    // 分割：在播放头位置切割选中片段（或播放头所在的片段）
    _splitClipAtPlayhead() {
        const gtime = this._tlGlobalTime;

        // 计算每个片段在时间轴上的绝对位置（tlStart=null 的自动追加）
        let autoEnd = 0;
        const tlPositions = this.timeline.map(c => {
            const dur = c.end - c.start;
            let ts = c.tlStart;
            if (ts == null) ts = autoEnd;
            autoEnd = ts + dur;
            return { clip: c, tlStart: ts, tlEnd: ts + dur, origEnd: c.end };
        });

        // 找到播放头所在的片段
        let target = null;
        for (const r of tlPositions) {
            if (r.tlEnd <= 0) continue;
            if (gtime >= r.tlStart && gtime < r.tlEnd) { target = r; break; }
        }
        // 如果没找到，尝试选中的片段
        if (!target && this.selectedClipIds.size > 0) {
            target = tlPositions.find(r => this.selectedClipIds.has(r.clip.id));
        }
        if (!target) return;

        const leftClip = target.clip;
        const splitTl = gtime - target.tlStart; // 分割点在片段内的偏移（秒）
        const clipLocalTime = leftClip.start + splitTl; // 对应源视频时间
        // 不能在片段开头或结尾分割
        if (clipLocalTime <= leftClip.start + 0.05 || clipLocalTime >= target.origEnd - 0.05) return;

        this._pushHistory();
        // 确保 leftClip 的 tlStart 被固定
        leftClip.tlStart = target.tlStart;
        leftClip.end = clipLocalTime;

        const rightClip = {
            id: ++this._clipIdCounter,
            filename: leftClip.filename,
            type: leftClip.type,
            name: leftClip.name,
            start: clipLocalTime,
            end: target.origEnd,
            sourceDuration: leftClip.sourceDuration,
            durationPending: leftClip.durationPending,
            borderColor: leftClip.borderColor || "",
            tlStart: target.tlStart + splitTl,
        };

        const idx = this.timeline.findIndex(c => c === leftClip);
        this.timeline.splice(idx + 1, 0, rightClip);
        this.selectedClipIds = new Set([rightClip.id]);
        this._renderTimeline();
        this._renderProps();
        this._setStatus(`已在 ${_fmtTime(gtime)} 分割片段`);
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
                                <button class="xzg-ve-thumb-btn">缩略图</button>
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
                    <div class="xzg-ve-media-resizer"></div>
                    <div class="xzg-ve-preview-panel">
                        <div class="xzg-ve-preview">
                            <canvas class="xzg-ve-canvas"></canvas>
                            <div class="xzg-ve-preview-empty">从媒体库拖拽视频到时间线</div>
                        </div>
                        <div class="xzg-ve-preview-controls">
                            <button class="xzg-ve-play-btn"></button>
                            <span class="xzg-ve-time">00:00.00 / 00:00.00</span>
                            <span class="xzg-ve-frames">0 / 0 帧</span>
                            <button class="xzg-ve-frame-btn">📷 导出帧</button>
                        </div>
                    </div>
                    <div class="xzg-ve-props-panel">
                        <div class="xzg-ve-panel-header">属性</div>
                        <div class="xzg-ve-props-content"></div>
                    </div>
                </div>
                <div class="xzg-ve-timeline-resizer"></div>
                <div class="xzg-ve-timeline-panel">
                    <div class="xzg-ve-timeline-header">
                        <span>时间线</span>
                        <span class="xzg-ve-tl-info"></span>
                    </div>
                    <div class="xzg-ve-timeline" tabindex="0">
                        <div class="xzg-ve-tl-leftpad">
                            <div class="xzg-ve-track-resizer xzg-ve-resizer-top"></div>
                            <div class="xzg-ve-track-header xzg-ve-video-header">
                                <span class="xzg-ve-track-name">视频</span>
                            </div>
                            <div class="xzg-ve-track-resizer xzg-ve-resizer-mid"></div>
                            <div class="xzg-ve-track-header xzg-ve-audio-header">
                                <span class="xzg-ve-track-name">音频</span>
                            </div>
                            <div class="xzg-ve-track-resizer xzg-ve-resizer-bottom"></div>
                        </div>
                        <div class="xzg-ve-tl-scrub-divider"></div>
                        <div class="xzg-ve-tl-video-top"></div>
                        <div class="xzg-ve-tl-scrub">
                            <div class="xzg-ve-tl-ticks"></div>
                        </div>
                        <div class="xzg-ve-tl-track xzg-ve-video-track"></div>
                        <div class="xzg-ve-tl-track xzg-ve-audio-track"></div>
                        <div class="xzg-ve-tl-divider"></div>
                        <div class="xzg-ve-tl-playhead"></div>
                    </div>
                </div>
                <div class="xzg-ve-footer">
                    <button class="xzg-ve-btn xzg-ve-btn-clear-tl">🗑 清空时间线</button>
                    <div class="xzg-ve-render-opts">
                        <span class="xzg-ve-render-label">宽</span>
                        <input type="number" class="xzg-ve-render-w" min="0" max="4096" placeholder="--" disabled>
                        <span class="xzg-ve-render-label">高</span>
                        <input type="number" class="xzg-ve-render-h" min="0" max="4096" placeholder="--" disabled>
                        <select class="xzg-ve-render-presets" disabled>
                            <option value="0">自定义</option>
                            <option value="832x480">832x480</option>
                            <option value="960x540">960x540</option>
                            <option value="1024x576">1024x576</option>
                            <option value="1152x648">1152x648</option>
                            <option value="1280x720">1280x720</option>
                            <option value="1344x756">1344x756</option>
                            <option value="1600x900">1600x900</option>
                            <option value="1920x1080">1920x1080</option>
                        </select>
                        <button class="xzg-ve-btn xzg-ve-btn-portrait" disabled>使用竖屏分辨率</button>
                    </div>
                    <div class="xzg-ve-footer-right">
                        <button class="xzg-ve-btn xzg-ve-btn-cancel">返回画布</button>
                        <button class="xzg-ve-btn xzg-ve-btn-apply">⏩ 生成并应用</button>
                    </div>
                </div>
                <div class="xzg-ve-loading-overlay">
                    <div class="xzg-ve-loading-box">
                        <div class="xzg-ve-loading-spinner"></div>
                        <div class="xzg-ve-loading-text">正在加载视频...</div>
                        <div class="xzg-ve-loading-bar-bg">
                            <div class="xzg-ve-loading-bar-fill"></div>
                        </div>
                        <div class="xzg-ve-loading-pct">0%</div>
                        <div class="xzg-ve-loading-size">0 MB / 0 MB</div>
                    </div>
                </div>
            </div>
        `;
        this._root = root;
        this._canvas = root.querySelector(".xzg-ve-canvas");
        this._mediaList = root.querySelector(".xzg-ve-media-list");
        this._timeline = root.querySelector(".xzg-ve-timeline");
        this._tlTrack = root.querySelector(".xzg-ve-video-track");
        this._tlAudioTrack = root.querySelector(".xzg-ve-audio-track");
        this._tlDivider = root.querySelector(".xzg-ve-tl-divider");
        this._tlVideoTopDivider = root.querySelector(".xzg-ve-tl-video-top");
        // 全局缩略图渲染提示：挂载到时间线视口（非滚动内容），始终居中，不随片段滚动/缩放移动
        this._tlThumbLoadingHint = _el("div", "xzg-ve-clip-thumb-loading", "缩略图渲染中", this._timeline);
        this._playhead = root.querySelector(".xzg-ve-tl-playhead");
        this._status = root.querySelector(".xzg-ve-status");
        this._timeLabel = root.querySelector(".xzg-ve-time");
        this._framesLabel = root.querySelector(".xzg-ve-frames");
        this._propsContent = root.querySelector(".xzg-ve-props-content");
        this._tlInfo = root.querySelector(".xzg-ve-tl-info");
        this._previewEmpty = root.querySelector(".xzg-ve-preview-empty");
        // 加载遮罩元素引用（大视频加载进度显示）
        this._loadingOverlay = root.querySelector(".xzg-ve-loading-overlay");
        this._loadingText = root.querySelector(".xzg-ve-loading-text");
        this._loadingBarFill = root.querySelector(".xzg-ve-loading-bar-fill");
        this._loadingPct = root.querySelector(".xzg-ve-loading-pct");
        this._loadingSize = root.querySelector(".xzg-ve-loading-size");

        // 事件绑定
        root.querySelector(".xzg-ve-close").onclick = () => this._cancel();
        root.querySelector(".xzg-ve-btn-cancel").onclick = () => this._cancel();
        root.querySelector(".xzg-ve-btn-apply").onclick = () => this._render();
        root.querySelector(".xzg-ve-btn-clear-tl").onclick = () => this._clearTimeline();
        // 渲染分辨率控件：预设选择 → 自动填入宽高；竖屏按钮 → 交换宽高使较大值为高
        const presetsSel = root.querySelector(".xzg-ve-render-presets");
        const wInput = root.querySelector(".xzg-ve-render-w");
        const hInput = root.querySelector(".xzg-ve-render-h");
        if (presetsSel) {
            presetsSel.onchange = () => {
                const v = presetsSel.value;
                if (v && v !== "0") {
                    const [pw, ph] = v.split("x").map(Number);
                    wInput.value = pw;
                    hInput.value = ph;
                } else {
                    wInput.value = 0;
                    hInput.value = 0;
                }
            };
        }
        if (wInput && hInput) {
            // 输入框手动修改时，预设自动切回"原始"（避免与输入值不同步）
            wInput.oninput = () => { if (presetsSel) presetsSel.value = "0"; };
            hInput.oninput = () => { if (presetsSel) presetsSel.value = "0"; };
        }
        const portraitBtn = root.querySelector(".xzg-ve-btn-portrait");
        if (portraitBtn) {
            portraitBtn.onclick = () => {
                const cw = Number(wInput.value || 0);
                const ch = Number(hInput.value || 0);
                if (cw <= 0 || ch <= 0) return;
                // 竖屏：较大值为高，较小值为宽
                if (cw > ch) {
                    wInput.value = ch;
                    hInput.value = cw;
                }
                // 同步预设列表：尝试匹配交换后的值（如 900x1600），无匹配则选"原始"
                if (presetsSel) {
                    const newW = wInput.value;
                    const newH = hInput.value;
                    const target = `${newW}x${newH}`;
                    let matched = false;
                    for (const opt of presetsSel.options) {
                        if (opt.value === target) {
                            presetsSel.value = target;
                            matched = true;
                            break;
                        }
                    }
                    if (!matched) presetsSel.value = "0";
                }
            };
        }
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
        // 时间线高度拖动调整
        this._tlPanel = root.querySelector(".xzg-ve-timeline-panel");
        this._tlResizer = root.querySelector(".xzg-ve-timeline-resizer");
        this._tlVideoHeader = root.querySelector(".xzg-ve-video-header");
        this._tlAudioHeader = root.querySelector(".xzg-ve-audio-header");
        this._tlResizerTop = root.querySelector(".xzg-ve-resizer-top");
        this._tlResizerMid = root.querySelector(".xzg-ve-resizer-mid");
        this._tlResizerBottom = root.querySelector(".xzg-ve-resizer-bottom");
        this._restoreTimelineHeight();
        this._bindTimelineResizer();
        this._initTrackResizer();
        this._applyTrackLayout();
        root.querySelector(".xzg-ve-play-btn").onclick = (e) => {
            this._toggleTimelinePlay();
            e.currentTarget.blur();  // 点击后立即失焦，避免空格播放时残留焦点高亮
        };
        root.querySelector(".xzg-ve-frame-btn").onclick = () => this._exportFrame();
        // canvas 点击切换播放
        this._canvas.addEventListener("click", () => this._toggleTimelinePlay());

        // 播放头本体 pointer-events: none，点击穿透到下层（刻度区由 scrub 处理）
        // 上方 1/4 拖动区：按住鼠标拖动控制播放头（点击即跳转 + 拖动跟随）
        this._tlScrub = root.querySelector(".xzg-ve-tl-scrub");
        this._tlTicks = root.querySelector(".xzg-ve-tl-ticks");
        this._tlScrub.addEventListener("mousedown", (e) => this._onScrubDown(e));

        // 时间线拖放：拖动时实时预览片段在轨道上的位置，松开后落入
        this._timeline.addEventListener("dragenter", (e) => {
            e.preventDefault();
            this._tlTrack.classList.add("xzg-ve-drag-over");
        });
        this._timeline.addEventListener("dragover", (e) => {
            e.preventDefault();
            this._tlTrack.classList.add("xzg-ve-drag-over");
            // 实时预览：根据鼠标 X 位置显示片段占位
            const name = e.dataTransfer.types.includes("text/x-media-name");
            if (!name) return;
            this._showDragPreview(e.clientX);
        });
        this._timeline.addEventListener("dragleave", (e) => {
            // 仅当离开整个 timeline 才取消高亮和预览
            if (!this._timeline.contains(e.relatedTarget)) {
                this._tlTrack.classList.remove("xzg-ve-drag-over");
                this._hideDragPreview();
            }
        });
        this._timeline.addEventListener("drop", (e) => {
            e.preventDefault();
            this._tlTrack.classList.remove("xzg-ve-drag-over");
            this._hideDragPreview();
            const name = e.dataTransfer.getData("text/x-media-name");
            const type = e.dataTransfer.getData("text/x-media-type") || "input";
            if (name) {
                // 根据鼠标 X 位置计算放置点（秒，鼠标对应片段中心点）
                const media = this.mediaLibrary.find(m => m.name === name);
                const md = media?.info?.duration || 0;
                const dur = md > 0 ? md : 60;
                const tlStart = this._clientXToTlStart(e.clientX, dur);
                this._addClipToTimeline(name, type, tlStart);
            }
        });

        // 时间线框选：在时间线空白区域 mousedown 启动
        this._timeline.addEventListener("mousedown", (e) => this._onTimelineMouseDown(e));

        // 时间线缩放（Alt+滚轮）与横向滚动（普通滚轮）
        this._timeline.addEventListener("wheel", (e) => this._onTimelineWheel(e), { passive: false });

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
        this._initCtxMenu();
        this._updateTimeDisplay();
    }

    // ═══════════════════════════════════════════════════════════
    //  片段右键菜单（颜色 → 红橙黄绿青蓝紫）
    // ═══════════════════════════════════════════════════════════
    _initCtxMenu() {
        // 颜色预设：红 / 橙 / 黄 / 绿 / 青 / 蓝 / 紫
        const COLORS = [
            { label: "红", value: "#e53935" },
            { label: "橙", value: "#fb8c00" },
            { label: "黄", value: "#fdd835" },
            { label: "绿", value: "#43a047" },
            { label: "青", value: "#00acc1" },
            { label: "蓝", value: "#1e88e5" },
            { label: "紫", value: "#8e24aa" },
        ];
        const menu = document.createElement("div");
        menu.className = "xzg-ve-ctx-menu";
        const COLOR_OPTIONS = COLORS;
        const sub = document.createElement("div");
        sub.className = "xzg-ve-ctx-submenu";
        for (const c of COLOR_OPTIONS) {
            const item = document.createElement("div");
            item.className = "xzg-ve-ctx-item";
            const swatch = document.createElement("span");
            swatch.className = "xzg-ve-ctx-swatch";
            swatch.style.background = c.value;
            item.appendChild(swatch);
            const text = document.createElement("span");
            text.textContent = c.label;
            item.appendChild(text);
            // 用 mousedown 而非 click：避免全局 mousedown 捕获阶段隐藏菜单后元素 display:none 导致 click 不触发
            item.addEventListener("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                this._applyClipColor(c.value);
                this._hideCtxMenu();
            });
            sub.appendChild(item);
        }

        // 一级菜单：颜色（带 ▸ 展开子菜单）
        const colorItem = document.createElement("div");
        colorItem.className = "xzg-ve-ctx-item xzg-ve-ctx-has-sub";
        colorItem.innerHTML = `<span>颜色</span><span class="xzg-ve-ctx-arrow">▸</span>`;
        colorItem.appendChild(sub);
        menu.appendChild(colorItem);

        // 分割：在播放头位置分割当前右键的片段
        const splitItem = document.createElement("div");
        splitItem.className = "xzg-ve-ctx-item";
        splitItem.innerHTML = `<span>✂ 分割</span>`;
        splitItem.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const id = parseInt(this._ctxMenu.dataset.clipId);
            if (id) {
                this.selectedClipIds = new Set([id]);
                this._splitClipAtPlayhead();
            }
            this._hideCtxMenu();
        });
        menu.appendChild(splitItem);

        // 删除
        const delItem = document.createElement("div");
        delItem.className = "xzg-ve-ctx-item";
        delItem.innerHTML = `<span>🗑 删除</span>`;
        delItem.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const id = parseInt(this._ctxMenu.dataset.clipId);
            if (id) this._deleteClip(id);
            this._hideCtxMenu();
        });
        menu.appendChild(delItem);

        // 显示/隐藏控制
        this._ctxMenu = menu;
        this._root.appendChild(menu);

        // 捕获阶段 mousedown：若事件源自菜单内部（颜色项），放行让它走自己的 handler；
        // 否则（点击空白/其他片段）隐藏菜单
        const hideAll = (e) => {
            if (menu.contains(e.target)) return;
            this._hideCtxMenu();
        };
        document.addEventListener("mousedown", hideAll, true);
        document.addEventListener("contextmenu", hideAll, true);
        window.addEventListener("blur", hideAll);
        window.addEventListener("resize", hideAll);
        menu.addEventListener("contextmenu", (e) => e.preventDefault());
    }

    _showCtxMenu(e, clipId) {
        e.preventDefault();
        e.stopPropagation();
        // 目标片段 id 存到菜单 dataset：即便点击时捕获阶段的 mousedown 先隐藏了菜单也不会丢失
        this._ctxMenu.dataset.clipId = clipId;
        const menu = this._ctxMenu;
        menu.classList.add("xzg-ve-ctx-show");
        // 先显示一次用于测量尺寸，再调整位置避免越界
        const rootRect = this._root.getBoundingClientRect();
        let x = e.clientX - rootRect.left;
        let y = e.clientY - rootRect.top;
        menu.style.left = "0px";
        menu.style.top = "0px";
        const mw = menu.offsetWidth;
        const mh = menu.offsetHeight;
        const subItem = menu.querySelector(".xzg-ve-ctx-has-sub");
        const subW = (menu.querySelector(".xzg-ve-ctx-submenu") || {}).offsetWidth || 120;
        // 主菜单位置
        if (x + mw > rootRect.width) x = Math.max(0, rootRect.width - mw);
        if (y + mh > rootRect.height) y = Math.max(0, rootRect.height - mh);
        menu.style.left = x + "px";
        menu.style.top = y + "px";
        // 子菜单位置（默认右侧，空间不足则左侧）
        if (subItem) {
            const sub = menu.querySelector(".xzg-ve-ctx-submenu");
            if (sub) {
                const itemRect = subItem.getBoundingClientRect();
                const rootR = this._root.getBoundingClientRect();
                const rightX = (itemRect.right - rootR.left) + 2;
                const leftX = (itemRect.left - rootR.left) - subW - 2;
                const topY = itemRect.top - rootR.top;
                if (rightX + subW <= rootR.width - 4) {
                    sub.style.left = (itemRect.width - 2) + "px";
                    sub.style.top = ((itemRect.top - menu.getBoundingClientRect().top)) + "px";
                } else {
                    sub.style.left = (-subW - 2) + "px";
                    sub.style.top = ((itemRect.top - menu.getBoundingClientRect().top)) + "px";
                }
            }
        }
    }

    _hideCtxMenu() {
        if (this._ctxMenu) this._ctxMenu.classList.remove("xzg-ve-ctx-show");
    }

    _applyClipColor(color) {
        const id = parseInt(this._ctxMenu?.dataset.clipId, 10);
        if (!id) return;
        const ids = this.selectedClipIds.has(id)
            ? Array.from(this.selectedClipIds)
            : [id];
        for (const cid of ids) {
            const clip = this.timeline.find(c => c.id === cid);
            if (clip) clip.borderColor = color || "";
        }
        // 直接更新当前DOM的CSS变量（避免整段重建导致缩略图闪烁）
        for (const cid of ids) {
            const el = this._tlTrack.querySelector(`.xzg-ve-clip[data-clip-id="${cid}"]`);
            if (el) {
                if (color) el.style.setProperty("--xzg-ve-clip-border", color);
                else el.style.removeProperty("--xzg-ve-clip-border");
            }
        }
        this._saveTimelineSession();
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
            color: #eee; user-select: none; -webkit-user-select: none;
        }
        .xzg-ve-root * { user-select: none; -webkit-user-select: none; }
        .xzg-ve-root input, .xzg-ve-root textarea, .xzg-ve-root [contenteditable] {
            user-select: text; -webkit-user-select: text;
        }
        .xzg-ve-modal {
            width: 98vw; height: 95vh; background: #2a2a2a; border: 1px solid #444;
            border-radius: 8px; display: flex; flex-direction: column; overflow: hidden;
            position: relative; /* 供加载遮罩 absolute 定位 */
        }
        .xzg-ve-header {
            height: 40px; padding: 0 12px; background: #2a2a2a;
            display: flex; align-items: center; gap: 12px;
            border-bottom: 1px solid #535353; flex-shrink: 0;
            box-shadow: 0 1px 0 0 rgba(83,83,83,0.5), inset 0 -1px 0 0 rgba(83,83,83,0.5);
        }
        .xzg-ve-title { font-size: 14px; font-weight: 600; color: #dcc85b; white-space: nowrap; }
        .xzg-ve-status { font-size: 12px; color: #888; flex: 1; overflow: hidden;
            text-overflow: ellipsis; white-space: nowrap; }
        .xzg-ve-close { background: transparent; border: 0; color: #aaa; font-size: 20px;
            cursor: pointer; padding: 0 6px; line-height: 1; }
        .xzg-ve-close:hover { color: #ff6b6b; }
        .xzg-ve-body { flex: 1; display: flex; min-height: 0; }
        /* 加载遮罩：大视频加载期间显示进度，禁用所有操作 */
        .xzg-ve-loading-overlay {
            position: absolute; inset: 0; z-index: 10000;
            background: rgba(0, 0, 0, 0.75);
            display: none; align-items: center; justify-content: center;
            pointer-events: auto; backdrop-filter: blur(2px);
        }
        .xzg-ve-loading-overlay.xzg-ve-active { display: flex; }
        .xzg-ve-loading-box {
            background: #2a2a2a; border: 1px solid #444; border-radius: 10px;
            padding: 28px 40px; text-align: center; min-width: 320px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.5);
        }
        .xzg-ve-loading-spinner {
            width: 36px; height: 36px; margin: 0 auto 14px;
            border: 3px solid #444; border-top-color: #dcc85b; border-radius: 50%;
            animation: xzg-ve-spin 0.8s linear infinite;
        }
        @keyframes xzg-ve-spin { to { transform: rotate(360deg); } }
        .xzg-ve-loading-text { font-size: 14px; color: #dcc85b; margin-bottom: 16px; font-weight: 600; }
        .xzg-ve-loading-bar-bg {
            width: 280px; height: 6px; background: #2a2a2a; border-radius: 3px;
            overflow: hidden; margin: 0 auto;
        }
        .xzg-ve-loading-bar-fill {
            height: 100%; width: 0%; background: #dcc85b; border-radius: 3px;
            transition: width 0.15s ease-out;
        }
        .xzg-ve-loading-pct { font-size: 13px; color: #fff; margin-top: 10px; font-weight: 600; }
        .xzg-ve-loading-size { font-size: 11px; color: #888; margin-top: 4px; }
        .xzg-ve-media-panel {
            width: 220px; background: #2a2a2a; border-right: 1px solid #535353;
            display: flex; flex-direction: column; flex-shrink: 0;
            box-shadow: 1px 0 0 0 rgba(83,83,83,0.5), inset -1px 0 0 0 rgba(83,83,83,0.5);
        }
        .xzg-ve-media-resizer {
            width: 8px; cursor: col-resize; background: transparent;
            flex-shrink: 0; position: relative; transition: background 0.15s;
        }
        .xzg-ve-media-resizer::after {
            content: ""; position: absolute; left: 50%; top: 50%;
            transform: translate(-50%, -50%);
            width: 2px; height: 24px; background: #717070; border-radius: 1px;
            transition: background 0.15s, height 0.15s;
        }
        .xzg-ve-media-resizer:hover::after,
        .xzg-ve-media-resizer.xzg-ve-resizing::after {
            background: #FFFFFF; height: 32px;
        }
        .xzg-ve-panel-header {
            padding: 8px 10px; font-size: 12px; color: #dcc85b;
            display: flex; justify-content: space-between; align-items: center;
            border-bottom: 1px solid #535353; flex-shrink: 0;
            box-shadow: 0 1px 0 0 rgba(83,83,83,0.5), inset 0 -1px 0 0 rgba(83,83,83,0.5);
        }
        .xzg-ve-add-btn {
            background: #2a2a2a; border: 1px solid #444; color: #dcc85b;
            font-size: 11px; padding: 3px 8px; border-radius: 3px; cursor: pointer;
        }
        .xzg-ve-add-btn:hover { background: #454545; }
        .xzg-ve-media-btns { display: flex; gap: 4px; }
        .xzg-ve-clear-btn {
            background: #2a2a2a; border: 1px solid #444; color: #ff6b6b;
            font-size: 11px; padding: 3px 8px; border-radius: 3px; cursor: pointer;
        }
        .xzg-ve-clear-btn:hover { background: #5a2a2a; border-color: #ff6b6b; }
        .xzg-ve-thumb-btn {
            background: #2a2a2a; border: 1px solid #dcc85b; color: #dcc85b;
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
            background: #2a2a2a; border-top: 1px solid #535353; flex-shrink: 0;
            box-shadow: 0 -1px 0 0 rgba(83,83,83,0.5), inset 0 1px 0 0 rgba(83,83,83,0.5);
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
            position: relative;
        }
        .xzg-ve-preview {
            flex: 1; background: #1d1d1d; position: relative;
            display: flex; align-items: center; justify-content: center;
            min-height: 0;
        }
        .xzg-ve-canvas { max-width: 100%; max-height: 100%; display: none; image-rendering: auto; }
        .xzg-ve-canvas.xzg-ve-active { display: block; }
        .xzg-ve-preview-empty {
            color: #555; font-size: 14px; text-align: center;
        }
        .xzg-ve-preview-empty.xzg-ve-hidden { display: none; }
        .xzg-ve-preview-controls {
            position: absolute; bottom: 0; left: 0; right: 0;
            height: 36px; padding: 0 10px;
            display: flex; align-items: center; gap: 10px; flex-shrink: 0;
            z-index: 5; background: transparent;
        }
        .xzg-ve-play-btn {
            width: 28px; height: 28px; border-radius: 50%; background: #2a2a2a;
            border: 1px solid #555; color: #fff; cursor: pointer; font-size: 12px;
            display: inline-flex; align-items: center; justify-content: center;
            padding: 0;
        }
        /* 播放符号 ▶：CSS 三角形，精确居中（字形 ▶ 默认偏左） */
        .xzg-ve-play-btn.xzg-ve-playing::before {
            content: ""; display: inline-block;
            border-style: solid; border-width: 6px 0 6px 10px;
            border-color: transparent transparent transparent #fff;
            margin-left: 2px;
        }
        /* 暂停符号 ❚❚：两根竖线，对称居中 */
        .xzg-ve-play-btn:not(.xzg-ve-playing)::before {
            content: ""; display: inline-block;
            width: 10px; height: 12px;
            border-left: 3px solid #fff; border-right: 3px solid #fff;
            box-sizing: border-box;
        }
        .xzg-ve-play-btn:hover { background: rgba(255, 255, 255, 0.18); border-color: rgba(255, 255, 255, 0.18); }
        /* 禁用按钮默认焦点轮廓，避免空格播放时残留高亮 */
        .xzg-ve-play-btn:focus, .xzg-ve-play-btn:focus-visible { outline: none; }
        .xzg-ve-play-btn:focus:not(:hover) { background: #2a2a2a; border-color: #555; }
        .xzg-ve-time { font-size: 14px; color: #FFFFFF; font-family: monospace; flex: 1; }
        .xzg-ve-frames { font-size: 14px; color: #FFFFFF; font-family: monospace; margin-right: 8px; }
        .xzg-ve-frame-btn {
            background: #2a2a2a; border: 1px solid #444; color: #ddd;
            font-size: 11px; padding: 4px 8px; border-radius: 3px; cursor: pointer;
        }
        .xzg-ve-frame-btn:hover { background: #454545; }
        .xzg-ve-props-panel {
            width: 220px; background: #2a2a2a; border-left: 1px solid #535353;
            display: flex; flex-direction: column; flex-shrink: 0;
            box-shadow: -1px 0 0 0 rgba(83,83,83,0.5), inset 1px 0 0 0 rgba(83,83,83,0.5);
        }
        .xzg-ve-props-content { flex: 1; overflow-y: auto; padding: 8px 10px; font-size: 11px; }
        .xzg-ve-prop-row { margin-bottom: 8px; }
        .xzg-ve-prop-label { color: #888; margin-bottom: 3px; }
        .xzg-ve-prop-input {
            width: 100%; padding: 4px 6px; background: #2a2a2a; border: 1px solid #444;
            border-radius: 3px; color: #ddd; font-size: 11px; box-sizing: border-box;
        }
        .xzg-ve-prop-input:focus { border-color: #dcc85b; outline: none; }
        .xzg-ve-timeline-panel {
            background: #2a2a2a; flex-shrink: 0;
            display: flex; flex-direction: column;
        }
        .xzg-ve-timeline-resizer {
            height: 8px; cursor: row-resize; background: #2a2a2a;
            flex-shrink: 0; position: relative; transition: background 0.15s;
            border-top: 1px solid #535353;
            box-shadow: 0 -1px 0 0 rgba(83,83,83,0.5), inset 0 1px 0 0 rgba(83,83,83,0.5);
        }
        .xzg-ve-timeline-resizer::after {
            content: ""; position: absolute; left: 50%; top: 50%;
            transform: translate(-50%, -50%);
            width: 32px; height: 2px; background: #717070; border-radius: 1px;
            transition: background 0.15s, width 0.15s;
        }
        .xzg-ve-timeline-resizer.xzg-ve-resizing::after {
            background: #FFFFFF; width: 40px;
        }
        .xzg-ve-timeline-header {
            height: 24px; padding: 0 10px; display: flex; align-items: center;
            justify-content: space-between; font-size: 11px; color: #888;
            border-bottom: 1px solid #535353; flex-shrink: 0;
            box-shadow: 0 1px 0 0 rgba(83,83,83,0.5), inset 0 -1px 0 0 rgba(83,83,83,0.5);
        }
        .xzg-ve-tl-info { color: #6699ff; font-size: 10px; }
        .xzg-ve-timeline {
            flex: 1; position: relative; background: #2a2a2a; overflow: clip;
            overflow-clip-margin: 10px; /* 允许播放头标记伸出边界10px不被裁剪 */
            min-height: 0; padding: 4px 0;
            outline: none; /* 按空格播放时容器获焦点，屏蔽浏览器默认白色轮廓 */
        }
        .xzg-ve-timeline.xzg-ve-drag-over,
        .xzg-ve-tl-track.xzg-ve-drag-over {
            background: rgba(144, 238, 144, 0.18); border-color: rgba(144, 238, 144, 0.6);
            box-shadow: inset 0 0 10px rgba(144, 238, 144, 0.25);
        }
        /* 拖放预览：半透明片段占位，跟随鼠标 X 显示放置位置 */
        .xzg-ve-clip-preview {
            position: absolute; top: 0; bottom: 0;
            background: rgba(220, 200, 91, 0.15);
            border: 1px dashed #dcc85b;
            border-radius: 3px;
            pointer-events: none; z-index: 15;
            display: flex; align-items: stretch;
            overflow: hidden;
        }
        .xzg-ve-sel-box {
            position: absolute; background: rgba(102, 153, 255, 0.15);
            border: 1px dashed #6699ff; pointer-events: none; z-index: 10;
        }
        /* 左侧 150px 占位区：包含轨道头区（达芬奇式：视频头+音频头垂直排列） */
        .xzg-ve-tl-leftpad {
            position: absolute; top: 0; bottom: 0; left: 0; width: 150px;
            background: #2a2a2a; border-right: 1px solid #535353;
            box-shadow: 1px 0 0 0 rgba(83,83,83,0.5), inset -1px 0 0 0 rgba(83,83,83,0.5);
            z-index: 6; overflow: hidden;
        }
        /* 轨道头：absolute 定位，top 由 JS 统一设置 */
        .xzg-ve-video-header {
            position: absolute; left: 0; right: 0; height: 60px;
            padding: 4px 8px;
            display: flex; align-items: center; background: #2a2a2a;
        }
        .xzg-ve-audio-header {
            position: absolute; left: 0; right: 0; height: 50px;
            padding: 4px 8px;
            display: flex; align-items: center; background: #2a2a2a;
        }
        .xzg-ve-track-name {
            color: #ddd; font-size: 12px; flex: 1;
            user-select: none; -webkit-user-select: none;
        }
        /* 三个手柄：top(视频高度)、mid(视频/音频分配比例)、bottom(音频高度)
           都用 absolute + top 定位，由 JS _applyTrackLayout 统一计算 */
        .xzg-ve-track-resizer {
            position: absolute; left: 0; right: 0; height: 8px;
            cursor: ns-resize; z-index: 7;
        }
        .xzg-ve-track-resizer::after {
            content: ""; position: absolute; left: 50%; top: 50%;
            transform: translate(-50%, -50%);
            width: 28px; height: 2px; background: #717070; border-radius: 1px;
            transition: background 0.15s, width 0.15s;
        }
        .xzg-ve-track-resizer:hover::after,
        .xzg-ve-track-resizer.xzg-ve-resizing::after {
            background: #FFFFFF; width: 36px;
        }
        /* 刻度线下方贯穿左右的分界线：1px实线 #1a1919 */
        .xzg-ve-tl-scrub-divider {
            position: absolute; top: calc(16.66% - 0.5px); left: 0; right: 0; height: 1px;
            z-index: 7; pointer-events: none;
            background: #1a1919;
        }
        /* 上方刻度线区：按住鼠标拖动控制播放头（避开左侧150px占位），高度为时间线高度的 1/6 */
        .xzg-ve-tl-scrub {
            position: absolute; top: 0; left: 150px; right: 0; height: 16.66%;
            z-index: 3; cursor: ew-resize;
            user-select: none; -webkit-user-select: none;
            overflow: hidden;
        }
        .xzg-ve-tl-ticks {
            position: absolute; left: 0; top: 0; bottom: 0;
            pointer-events: none; will-change: transform;
        }
        .xzg-ve-tl-tick {
            position: absolute; top: 0; bottom: 0; width: 1px;
            background: #444;
        }
        .xzg-ve-tl-tick-major { background: #666; }
        .xzg-ve-tl-tick-label {
            position: absolute; top: 2px; left: 3px; color: #777;
            font-size: 9px; white-space: nowrap; pointer-events: none;
        }
        .xzg-ve-tl-scrub.xzg-ve-scrubbing,
        .xzg-ve-tl-scrub.xzg-ve-scrubbing * { cursor: ew-resize !important; }
        .xzg-ve-tl-track {
            position: absolute; left: 150px; right: 4px; top: 16.66%;
            background: #2a2a2a; border-radius: 4px;
            box-sizing: border-box;
            /* absolute 定位容器，子片段用 absolute + left 自由摆布 */
            padding: 2px 2px 2px 0;
            overflow-x: auto; overflow-y: hidden;
            scrollbar-width: none;
            -ms-overflow-style: none;
        }
        /* 视频轨道：bottom 贴死分割线（去除下圆角+下内边距） */
        .xzg-ve-video-track {
            background: #2a2a2a;
            border-bottom-left-radius: 0;
            border-bottom-right-radius: 0;
            padding: 2px 2px 0 0;
        }
        /* 音频轨道：top 贴死分割线（去除上圆角+上内边距） */
        .xzg-ve-audio-track {
            background: #2a2a2a;
            border-top-left-radius: 0;
            border-top-right-radius: 0;
            padding: 0 2px 2px 0;
        }
        /* 视频轨道内片段：height:100%填满content-box；父box-sizing:border-box高度vH已含顶部2pxpadding
           → 片段底部正好=轨道底部=分割线顶部（midTop），零缝隙 */
        .xzg-ve-video-track .xzg-ve-clip { height: 100%; }
        /* 音频轨道内片段：height:100%填满content-box；父box-sizing:border-box高度aH已含底部2pxpadding
           → 片段正好停在2px下padding上边缘，不越过轨道 */
        .xzg-ve-audio-track .xzg-ve-clip { height: 100%; }
        /* 视频轨道上边缘：贯穿左侧手柄区+右侧轨道区的1px实线 #1a1919 */
        .xzg-ve-tl-video-top {
            position: absolute; left: 0; right: 0; height: 1px;
            z-index: 7; pointer-events: none;
            background: #1a1919;
        }
        /* 音视频之间5px贯穿左右分割线：上1px黑 + 中3px#535353 + 下1px黑，z-7 穿透左侧手柄区 */
        .xzg-ve-tl-divider {
            position: absolute; left: 0; right: 0; height: 5px;
            background: linear-gradient(to bottom, #000 0 1px, #535353 1px 4px, #000 4px 5px);
            z-index: 7; pointer-events: none;
        }
        .xzg-ve-tl-track::-webkit-scrollbar { display: none; } /* Chrome/Safari 隐藏滚动条 */
        .xzg-ve-clip {
            position: absolute; height: calc(100% - 4px); min-width: 30px; border-radius: 3px;
            background: #2a2a2a; border: 1px solid #000; cursor: pointer;
            font-size: 9px; color: #ddd;
            overflow: hidden;
            user-select: none; -webkit-user-select: none; -webkit-user-drag: none;
            --xzg-ve-clip-border: #4376a1; /* 默认色，可通过 JS 覆盖 */
        }
        /* 内边框：上/左/右各2px，下边25px向上延伸；始终保留片段本体颜色 */
        .xzg-ve-clip::after {
            content: ""; position: absolute; inset: 0; pointer-events: none;
            z-index: 5; box-sizing: border-box;
            border: 2px solid var(--xzg-ve-clip-border);
            border-bottom-width: 25px;
        }
        /* 选中态：::before 红色覆盖层，仅3px均匀覆盖周长，不取消 ::after 的本体颜色 */
        .xzg-ve-clip::before {
            content: ""; position: absolute; inset: 0; pointer-events: none;
            z-index: 6; box-sizing: border-box;
            border: 3px solid transparent;
            border-radius: inherit;
        }
        .xzg-ve-clip.xzg-ve-selected::before {
            border-color: #fa5b4a;
        }
        .xzg-ve-clip.xzg-ve-selected {
            border-color: #000;
        }
        /* 缩略图带：多个缩略图横向拼接填满片段 */
        .xzg-ve-clip-thumbs {
            position: absolute; top: 0; bottom: 0; left: 0; display: flex; gap: 0;
            background: #2a2a2a; overflow: hidden;
        }
        .xzg-ve-clip-thumb {
            flex-shrink: 0; height: 100%;
            object-fit: cover; display: block; background: transparent;
            border: 0; outline: none; padding: 0; margin: 0;
            line-height: 0; font-size: 0; vertical-align: top;
            opacity: 0; transition: opacity 0.15s;
        }
        /* 图片加载完成后淡入显示（逐步显示，无白边） */
        .xzg-ve-clip-thumb.xzg-ve-thumb-loaded { opacity: 1; }
        /* 缩略图生成中提示（达芬奇式：金色字样固定在左侧占位区中央，不随片段滚动/缩放移动） */
        .xzg-ve-clip-thumb-loading {
            position: absolute; left: 75px; top: 50%; transform: translate(-50%, -50%);
            z-index: 100; pointer-events: none;
            color: #dcc85b; font-size: 16px; font-weight: bold;
            text-shadow: 0 0 4px rgba(0,0,0,0.8);
            opacity: 0; transition: opacity 0.2s;
            white-space: nowrap;
        }
        .xzg-ve-clip-thumb-loading.xzg-ve-show { opacity: 1; }
        /* 底部信息条（名称）覆盖在缩略图之上，z-10 高于边框伪元素 */
        .xzg-ve-clip-info {
            position: absolute; left: 0; right: 0; bottom: 0; z-index: 10;
            padding: 2px 6px; font-size: 14px; color: #fff;
            background: transparent;
            pointer-events: none;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .xzg-ve-clip-handle {
            position: absolute; top: 0; bottom: 0; width: 16px;
            background: transparent; z-index: 7;
        }
        .xzg-ve-clip-handle-left {
            left: 0; border-radius: 3px 0 0 3px;
            /* 竖杠在 x=3,7（手柄边缘，片段左边缘），箭头朝片段内部（右） */
            cursor: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Cline x1='3' y1='0' x2='3' y2='24' stroke='%23ff4444' stroke-width='2'/%3E%3Cline x1='7' y1='0' x2='7' y2='24' stroke='%23ff4444' stroke-width='2'/%3E%3Cpath d='M11 12h10M18 7l5 5-5 5' stroke='%23ff4444' stroke-width='2.5' fill='none'/%3E%3C/svg%3E") 5 12, e-resize;
        }
        .xzg-ve-clip-handle-right {
            right: 0; border-radius: 0 3px 3px 0;
            /* 竖杠在 x=13,17（手柄边缘，片段右边缘），箭头朝片段内部（左） */
            cursor: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Cpath d='M13 12H3M6 7l-5 5 5 5' stroke='%23ff4444' stroke-width='2.5' fill='none'/%3E%3Cline x1='17' y1='0' x2='17' y2='24' stroke='%23ff4444' stroke-width='2'/%3E%3Cline x1='21' y1='0' x2='21' y2='24' stroke='%23ff4444' stroke-width='2'/%3E%3C/svg%3E") 19 12, w-resize;
        }
        /* 桥接手柄：相邻片段交界处 ±5px，滚动裁剪（左尾+右头同步移动） */
        .xzg-ve-clip-bridge {
            position: absolute; top: 0; bottom: 0; width: 10px;
            background: transparent; z-index: 8;
            cursor: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Cpath d='M10 12H1M6 7l-5 5 5 5' stroke='%23ff4444' stroke-width='2.5' fill='none'/%3E%3Cline x1='10' y1='0' x2='10' y2='24' stroke='%23ff4444' stroke-width='2'/%3E%3Cline x1='14' y1='0' x2='14' y2='24' stroke='%23ff4444' stroke-width='2'/%3E%3Cpath d='M14 12h9M18 7l5 5-5 5' stroke='%23ff4444' stroke-width='2.5' fill='none'/%3E%3C/svg%3E") 12 12, ew-resize;
        }
        .xzg-ve-clip-del {
            position: absolute; top: -1px; right: -1px; width: 14px; height: 14px;
            background: #ff6b6b; color: #fff; border: 0; border-radius: 0 3px 0 3px;
            font-size: 10px; cursor: pointer; display: none; line-height: 14px;
            text-align: center; padding: 0; z-index: 3;
        }
        .xzg-ve-clip:hover .xzg-ve-clip-del { display: block; }
        .xzg-ve-clip-name { color: rgba(255,255,255,0.85); font-weight: normal; }
        .xzg-ve-clip-time { color: rgba(255,255,255,0.6); }
        /* 片段右键菜单：一级菜单 + 子菜单（悬停展开） */
        .xzg-ve-ctx-menu {
            position: absolute;
            min-width: 110px;
            background: #2a2a2a;
            border: 1px solid #3f3f3f;
            border-radius: 6px;
            box-shadow: 0 6px 20px rgba(0,0,0,0.55);
            padding: 4px 0;
            z-index: 999999;
            display: none;
            font-size: 12px;
            color: #eee;
        }
        .xzg-ve-ctx-menu.xzg-ve-ctx-show { display: block; }
        .xzg-ve-ctx-item {
            display: flex; align-items: center; gap: 8px;
            padding: 6px 12px;
            cursor: pointer;
            line-height: 1;
            white-space: nowrap;
            position: relative;
        }
        .xzg-ve-ctx-item:hover { background: #3a3a3a; }
        .xzg-ve-ctx-arrow { margin-left: auto; color: #888; font-size: 11px; }
        .xzg-ve-ctx-swatch {
            display: inline-block;
            width: 14px; height: 14px;
            border-radius: 3px;
            flex-shrink: 0;
            box-shadow: 0 0 0 1px rgba(255,255,255,0.12) inset;
        }
        .xzg-ve-ctx-sep {
            height: 1px; background: #3f3f3f; margin: 4px 8px;
        }
        .xzg-ve-ctx-submenu {
            position: absolute;
            top: -5px;
            left: calc(100% + 2px);
            min-width: 90px;
            background: #2a2a2a;
            border: 1px solid #3f3f3f;
            border-radius: 6px;
            box-shadow: 0 6px 20px rgba(0,0,0,0.55);
            padding: 4px 0;
            display: none;
            opacity: 0;
            transition: opacity 0.12s;
        }
        .xzg-ve-ctx-has-sub:hover > .xzg-ve-ctx-submenu {
            display: block;
            opacity: 1;
        }
        .xzg-ve-tl-playhead {
            position: absolute; top: 0; bottom: 0; width: 2px; background: #ff4444;
            z-index: 20; pointer-events: none; display: none; left: 0;
        }
        .xzg-ve-tl-playhead::before {
            content: ""; position: absolute; top: 0; left: 50%;
            transform: translateX(-50%);
            width: 14px; height: 8px; background: #ff4444;
            border-radius: 1px;
        }
        .xzg-ve-tl-playhead::after {
            content: ""; position: absolute; top: 8px; left: 50%;
            transform: translateX(-50%);
            width: 0; height: 0;
            border-left: 6px solid transparent;
            border-right: 6px solid transparent;
            border-top: 8px solid #ff4444;
        }
        .xzg-ve-tl-playhead.xzg-ve-active { display: block; }
        .xzg-ve-timeline-empty {
            position: absolute; inset: 0; display: flex; align-items: center;
            justify-content: center; color: #444; font-size: 12px; pointer-events: none;
        }
        .xzg-ve-footer {
            height: 40px; padding: 0 12px; background: #2a2a2a; border-top: 1px solid #535353;
            display: flex; align-items: center; justify-content: space-between; flex-shrink: 0;
            box-shadow: 0 -1px 0 0 rgba(83,83,83,0.5), inset 0 1px 0 0 rgba(83,83,83,0.5);
        }
        .xzg-ve-btn {
            padding: 6px 12px; background: #2a2a2a; color: #ddd; border: 1px solid #444;
            border-radius: 4px; cursor: pointer; font-size: 12px;
        }
        .xzg-ve-btn:hover { background: #454545; }
        .xzg-ve-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .xzg-ve-btn-apply { background: #a67c00; color: #fff; border-color: #a67c00; }
        .xzg-ve-btn-apply:hover { background: #c89500; }
        .xzg-ve-btn-clear-tl { font-size: 11px; }
        .xzg-ve-footer-right { display: flex; gap: 8px; }
        .xzg-ve-render-opts {
            display: flex; align-items: center; gap: 6px;
            margin-left: 12px; color: #aaa; font-size: 12px;
        }
        .xzg-ve-render-label { color: #888; }
        .xzg-ve-render-opts input[type="number"] {
            background: #2a2a2a; color: #ddd; border: 1px solid #444;
            border-radius: 3px; padding: 2px 4px; font-size: 12px;
            width: 56px; text-align: center;
        }
        .xzg-ve-render-opts input[type="number"]:focus { border-color: #777; outline: none; }
        .xzg-ve-render-opts input[type="number"]::-webkit-inner-spin-button,
        .xzg-ve-render-opts input[type="number"]::-webkit-outer-spin-button {
            -webkit-appearance: none; margin: 0;
        }
        .xzg-ve-render-opts input[type="number"] { -moz-appearance: textfield; }
        .xzg-ve-render-opts select {
            background: #2a2a2a; color: #ddd; border: 1px solid #444;
            border-radius: 3px; padding: 2px 6px; font-size: 12px; cursor: pointer;
        }
        .xzg-ve-render-opts select:hover { border-color: #777; }
        .xzg-ve-btn-portrait { font-size: 11px; padding: 3px 8px; }
        .xzg-ve-render-opts input:disabled, .xzg-ve-render-opts select:disabled,
        .xzg-ve-btn-portrait:disabled { opacity: 0.4; cursor: not-allowed; }
        `;
        document.head.appendChild(st);
    }

    // ═══════════════════════════════════════════════════════════
    //  媒体库
    // ═══════════════════════════════════════════════════════════

    // 根据 name+type 创建媒体对象，若全局探测缓存命中则直接填充 info 与 probeState
    _makeMediaItem(name, type, displayName) {
        const key = `${name}|${type}`;
        const dn = displayName || name;
        const cached = _XZG_VE_PROBE_CACHE[key];
        if (cached && cached.state === "ok") {
            return { name, type, displayName: dn, info: cached.info, probeState: "ok", error: null };
        } else if (cached && cached.state === "failed") {
            return { name, type, displayName: dn, info: null, probeState: "failed", error: cached.error };
        }
        return { name, type, displayName: dn, info: null, probeState: "pending", error: null };
    }

    async _loadMediaLibrary() {
        // 检测节点当前视频是否更换：对比上次打开时记录的视频名
        // 若更换了视频 → 重置媒体库和时间线，只保留当前视频
        const lastNodeVideo = _xzgVeGetLastNodeVideo(this.nodeId);
        const currentNodeVideo = this.initialFilename || "";
        const nodeVideoChanged = currentNodeVideo && lastNodeVideo && currentNodeVideo !== lastNodeVideo;
        if (nodeVideoChanged) {
            // 节点更换了视频：清空会话媒体列表和时间线，从当前视频重新开始
            _xzgVeSaveSessionMedia(this.nodeId, []);
            _xzgVeClearSessionTimeline(this.nodeId);
        }
        // 记录本次打开时的节点当前视频名（供下次对比）
        if (currentNodeVideo) {
            _xzgVeSetLastNodeVideo(this.nodeId, currentNodeVideo);
        }

        // 先读取 sessionStorage（按节点 ID 隔离的会话媒体列表）
        const sessionMedia = _xzgVeGetSessionMedia(this.nodeId);
        const sessionEmpty = sessionMedia.length === 0;
        // 只有 sessionStorage 为空时（首次打开或更换了视频）才把节点当前视频加入媒体库
        // 这样「生成并应用」后节点当前视频变为生成结果，下次打开不会污染媒体库
        if (sessionEmpty && this.initialFilename && !this.mediaLibrary.find(m => m.name === this.initialFilename)) {
            const item = this._makeMediaItem(this.initialFilename, this.initialType || "input");
            this.mediaLibrary.push(item);
            _xzgVeAddSessionMedia(this.nodeId, this.initialFilename, this.initialType || "input");
        }
        // 外部传入的初始媒体（批量上传多视频时）：始终加入（用户主动上传）
        for (const m of this.extraMedia) {
            if (m.name && !this.mediaLibrary.find(item => item.name === m.name)) {
                const item = this._makeMediaItem(m.name, m.type || "input");
                this.mediaLibrary.push(item);
                _xzgVeAddSessionMedia(this.nodeId, m.name, m.type || "input");
            }
        }
        // 从 sessionStorage 读取当前会话已加载的视频（浏览器刷新后自动清空）
        for (const m of sessionMedia) {
            if (!this.mediaLibrary.find(item => item.name === m.name)) {
                const item = this._makeMediaItem(m.name, m.type || "input");
                this.mediaLibrary.push(item);
            }
        }
        // 统计所有 pending 项（包括 initialFilename，否则单个视频时 _probeQueue 不会被调用）
        const pendingCount = this.mediaLibrary.filter(m => m.probeState === "pending").length;
        // 恢复上次会话的时间线（按 nodeId 隔离）
        this._restoreTimelineSession();
        this._renderMediaList();
        const total = this.mediaLibrary.length;
        if (pendingCount > 0) {
            this._setStatus(`媒体库已加载 (${total} 个视频), 探测中...`);
            this._probeQueue();
        } else if (total > 0) {
            this._setStatus(`媒体库已加载 (${total} 个视频)`);
        } else {
            this._setStatus("媒体库为空，点击「＋ 添加」上传视频");
        }
    }

    async _probeQueue() {
        // 防止重复执行：如果已在运行，标记需要再次执行
        if (this._probeRunning) {
            console.log("[xzg-ve] probeQueue: 已在运行, 标记 dirty");
            this._probeDirty = true;
            return;
        }
        console.log("[xzg-ve] probeQueue: 启动, mediaLibrary=", this.mediaLibrary.length, "个");
        this._probeRunning = true;
        try {
            do {
                this._probeDirty = false;
                // 先收集待探测项的快照（避免循环中 splice 导致迭代器跳过元素）
                const pending = this.mediaLibrary.filter(m => m.probeState === "pending");
                console.log("[xzg-ve] probeQueue: 本轮 pending=", pending.length, "个");
                for (const m of pending) {
            if (m.probeState !== "pending") continue;
            const key = this._mediaKey(m);
            // 二次检查缓存：另一个实例可能已完成探测
            const cached = _XZG_VE_PROBE_CACHE[key];
            if (cached && cached.state === "ok") {
                console.log("[xzg-ve] probeQueue: 缓存命中(ok), name=", m.name);
                m.info = cached.info;
                m.probeState = "ok";
                m.error = null;
                this._renderMediaList();
                continue;
            } else if (cached && cached.state === "failed") {
                console.log("[xzg-ve] probeQueue: 缓存命中(failed), name=", m.name);
                m.probeState = "failed";
                m.error = cached.error;
                // 仅当文件确实损坏（后端已删除）时才移除，否则保留可重试
                const isCorrupted = m.error && (
                    m.error.includes("已删除") ||
                    m.error.includes("文件损坏或过小") ||
                    m.error.includes("file not found")
                );
                if (isCorrupted) {
                    this._setStatus(`视频 "${m.name}" 文件损坏，已从媒体库移除`);
                    const idx = this.mediaLibrary.findIndex(item => item.name === m.name && item.type === m.type);
                    if (idx >= 0) this.mediaLibrary.splice(idx, 1);
                    _xzgVeRemoveSessionMedia(this.nodeId, m.name);
                    for (let i = this.timeline.length - 1; i >= 0; i--) {
                        if (this.timeline[i].filename === m.name) {
                            this.timeline.splice(i, 1);
                        }
                    }
                    this._renderTimeline();
                    if (this.selectedClipIds.size > 0) this._renderProps();
                } else {
                    this._setStatus(`视频 "${m.name}" 探测失败: ${m.error}（文件保留，可重试）`);
                }
                this._renderMediaList();
                continue;
            }
            // 全局去重：已在探测中则等待完成后从缓存读取
            if (_XZG_VE_PROBE_LOADING.has(key)) {
                console.log("[xzg-ve] probeQueue: 已在探测中, 等待其他实例, name=", m.name);
                m.probeState = "probing";
                this._renderMediaList();
                // 轮询等待另一个实例完成探测（最多 30 秒）
                const waitStart = Date.now();
                while (_XZG_VE_PROBE_LOADING.has(key) && Date.now() - waitStart < 30000) {
                    await new Promise(r => setTimeout(r, 300));
                }
                // 从缓存读取结果
                const cached2 = _XZG_VE_PROBE_CACHE[key];
                if (cached2 && cached2.state === "ok") {
                    m.info = cached2.info;
                    m.probeState = "ok";
                    m.error = null;
                } else if (cached2 && cached2.state === "failed") {
                    m.probeState = "failed";
                    m.error = cached2.error;
                    // 仅当文件确实损坏（后端已删除）时才移除，否则保留可重试
                    const isCorrupted = m.error && (
                        m.error.includes("已删除") ||
                        m.error.includes("文件损坏或过小") ||
                        m.error.includes("file not found")
                    );
                    if (isCorrupted) {
                        this._setStatus(`视频 "${m.name}" 文件损坏，已从媒体库移除`);
                        const idx = this.mediaLibrary.findIndex(item => item.name === m.name && item.type === m.type);
                        if (idx >= 0) this.mediaLibrary.splice(idx, 1);
                        _xzgVeRemoveSessionMedia(this.nodeId, m.name);
                        for (let i = this.timeline.length - 1; i >= 0; i--) {
                            if (this.timeline[i].filename === m.name) {
                                this.timeline.splice(i, 1);
                            }
                        }
                        this._renderTimeline();
                        if (this.selectedClipIds.size > 0) this._renderProps();
                    } else {
                        this._setStatus(`视频 "${m.name}" 探测失败: ${m.error}（文件保留，可重试）`);
                    }
                } else {
                    // 等待超时仍未完成，重置为 pending 以便下次重试
                    m.probeState = "pending";
                }
                this._renderMediaList();
                continue;
            }
            _XZG_VE_PROBE_LOADING.add(key);
            m.probeState = "probing";
            this._renderMediaList();
            let probeFailed = false;
            try {
                console.log("[xzg-ve] probeQueue: 发送 probe+thumbs 请求, name=", m.name, "type=", m.type);
                this._setStatus(`正在处理 "${m.name}" (探测+缩略图生成)...`);
                const resp = await _postJson(API_PROBE_AND_THUMBS, {
                    filename: m.name, type: m.type, interval: 0.3
                });
                console.log("[xzg-ve] probeQueue: probe+thumbs 返回, name=", m.name);
                if (resp.error) {
                    m.probeState = "failed";
                    m.error = resp.error;
                    _XZG_VE_PROBE_CACHE[key] = { state: "failed", error: resp.error, mtime: Date.now() };
                    probeFailed = true;
                } else {
                    const info = resp.info;
                    m.info = info;
                    m.probeState = "ok";
                    m.error = null;
                    _XZG_VE_PROBE_CACHE[key] = { state: "ok", info, mtime: Date.now() };
                    console.log("[xzg-ve] probeQueue: probe 成功, name=", m.name, "duration=", info.duration);
                    // 预填充缩略图流缓存（上传时即生成，拖到时间线时零等待）
                    // thumbs 可能为 null（生成失败），此时拖到时间线时会按需重新请求
                    const thumbsData = resp.thumbs;
                    if (thumbsData && thumbsData.results && thumbsData.results.length > 0) {
                        const mediaKey = `${m.name}|${m.type}`;
                        const thumbs = thumbsData.results.map(r => ({
                            url: `/view?filename=${encodeURIComponent(r.filename)}&type=input&subfolder=${encodeURIComponent(r.subfolder || "")}&t=${Date.now()}`,
                            time: r.time || 0,
                        }));
                        _XZG_VE_FULL_THUMB_STREAM[mediaKey] = {
                            thumbs, interval: thumbsData.interval || 0.3,
                            duration: thumbsData.duration || 0, failed: false,
                        };
                        console.log("[xzg-ve] probeQueue: 缩略图流已预填充, name=", m.name, "count=", thumbs.length);
                    } else if (resp.thumbs_error) {
                        console.warn("[xzg-ve] probeQueue: 缩略图流生成失败（视频正常）, name=", m.name, "err=", resp.thumbs_error);
                    }
                }
            } catch (e) {
                console.log("[xzg-ve] probeQueue: probe+thumbs 异常, name=", m.name, "error=", e.message);
                m.probeState = "failed";
                m.error = e.message;
                _XZG_VE_PROBE_CACHE[key] = { state: "failed", error: e.message, mtime: Date.now() };
                probeFailed = true;
            } finally {
                _XZG_VE_PROBE_LOADING.delete(key);
            }
            // probe 失败：文件仍在（后端不再删除），保留在媒体库中允许下次重试
            // 仅当文件确实过小（< 1024 字节，后端会删除）时才移除
            if (probeFailed) {
                const isCorrupted = m.error && (
                    m.error.includes("已删除") ||
                    m.error.includes("文件损坏或过小") ||
                    m.error.includes("file not found")
                );
                if (isCorrupted) {
                    this._setStatus(`视频 "${m.name}" 文件损坏，已从媒体库移除`);
                    const idx = this.mediaLibrary.findIndex(item => item.name === m.name && item.type === m.type);
                    if (idx >= 0) this.mediaLibrary.splice(idx, 1);
                    _xzgVeRemoveSessionMedia(this.nodeId, m.name);
                    for (let i = this.timeline.length - 1; i >= 0; i--) {
                        if (this.timeline[i].filename === m.name) {
                            this.timeline.splice(i, 1);
                        }
                    }
                    this._renderTimeline();
                    if (this.selectedClipIds.size > 0) this._renderProps();
                } else {
                    this._setStatus(`视频 "${m.name}" 探测失败: ${m.error}（文件保留，可重试）`);
                    this._renderMediaList();
                }
                continue;
            }
            this._renderMediaList();
            // 若时间线已有该视频的片段，同步更新其时长
            if (m.info) {
                let firstClipUpdated = false;
                for (const clip of this.timeline) {
                    if (clip.filename === m.name && clip.durationPending) {
                        clip.sourceDuration = m.info.duration;
                        // 限制 end 不超过真实时长
                        if (clip.end > m.info.duration) clip.end = m.info.duration;
                        if (clip.start > clip.end - 0.1) clip.start = Math.max(0, clip.end - 0.1);
                        clip.durationPending = false;
                        // 若是首个片段，标记需要同步分辨率
                        if (clip === this.timeline[0]) firstClipUpdated = true;
                    }
                }
                this._renderTimeline();
                if (this.selectedClipIds.size > 0) this._renderProps();
                // 首个片段 probe 完成后同步分辨率（首次添加时 probe 未完成的情况）
                if (firstClipUpdated) this._syncResFromFirstClip();
            }
        }
            const okCount = this.mediaLibrary.filter(m => m.probeState === "ok").length;
            this._setStatus(`媒体库处理完成 (${okCount}/${this.mediaLibrary.length} 成功, 缩略图已预生成)`);
            console.log("[xzg-ve] probeQueue: 本轮完成, ok=", okCount, "/", this.mediaLibrary.length, "dirty=", this._probeDirty);
            // 循环后再次检查：运行期间可能新增了 pending 项（如上传新视频）
            } while (this._probeDirty);
        } finally {
            this._probeRunning = false;
            console.log("[xzg-ve] probeQueue: 退出");
        }
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
                    console.log("[xzg-ve] render: 触发缩略图加载, name=", m.name, "probeState=", m.probeState);
                    this._loadThumbnail(m);
                }
            }
            _el("div", "xzg-ve-media-name", m.displayName || m.name, item);
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
                // 设置空 drag image，取消浏览器默认的半透明拖动元素（仅保留时间线上的金色虚线预览框）
                const emptyImg = new Image();
                emptyImg.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
                e.dataTransfer.setDragImage(emptyImg, 0, 0);
                // 保存到实例变量，供 dragover 预览读取（dragover 无法读 dataTransfer）
                this._dragPreviewName = m.name;
                this._dragPreviewType = m.type;
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

    _restoreTimelineHeight() {
        if (this._tlPanel) {
            this._tlPanel.style.height = this._tlHeight + "px";
        }
    }

    _saveTimelineHeight(h) {
        try { localStorage.setItem(this._tlHeightKey, String(h)); } catch (_) {}
    }

    _bindTimelineResizer() {
        if (!this._tlResizer || !this._tlPanel) return;
        this._tlResizer.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this._tlResizer.classList.add("xzg-ve-resizing");
            const panel = this._tlPanel;
            const startY = e.clientY;
            const startH = panel.getBoundingClientRect().height;
            const onMove = (ev) => {
                // 向上拖增大高度，向下拖减小
                let h = startH + (startY - ev.clientY);
                if (h < 80) h = 80;
                if (h > 500) h = 500;
                panel.style.height = h + "px";
            };
            const onUp = () => {
                window.removeEventListener("mousemove", onMove);
                window.removeEventListener("mouseup", onUp);
                this._tlResizer.classList.remove("xzg-ve-resizing");
                const finalH = Math.round(panel.getBoundingClientRect().height);
                this._tlHeight = finalH;
                this._saveTimelineHeight(finalH);
                this._setStatus(`时间线高度: ${finalH}px`);
                // 时间线整体高度变化不影响轨道高度（仅改变下方留白），片段宽高、缩略图均不变
                // scrub 区高度（25%）随容器变化，需刷新轨道位置、刻度与播放头
                this._applyTrackLayout();
                this._renderTicks();
                this._updatePlayhead();
            };
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
        });
    }

    // 同步三个手柄、视频/音频轨道头与轨道的 top 位置（达芬奇式）
    // 布局（自上而下）：上手柄 → 视频头/轨道 → 中手柄 → 音频头/轨道 → 下手柄
    _applyTrackLayout() {
        // 未自定义高度时：默认让音视频中间线在刻度以下区域的中线对齐
        if (!this._tlHeightsCustomized && this._timeline) {
            const tlH = Math.max(1, this._timeline.clientHeight - 8); // padding 4+4
            const trackAreaH = Math.round(tlH * 0.8334); // 扣除 16.66% 刻度区域
            const mid = Math.max(40, Math.floor(trackAreaH / 2));
            this._tlVideoHeight = mid;
            this._tlAudioHeight = Math.max(30, mid);
        }
        const vOff = this._tlVideoTopOffset || 0;
        const vH = this._tlVideoHeight;
        const aH = this._tlAudioHeight;
        const vTop = vOff;              // 视频头/轨道 top（相对 16.66%）
        const midTop = vOff + vH;       // 视频底部 = 分割线上边缘
        const aTop = vOff + vH + 5;     // 音频顶 = 分割线下边缘（+5px，与5px分割线紧贴无间隙）
        const botTop = aTop + aH;       // 音频底部
        // 用 calc(16.66% + Npx) 保证刻度线区域高度随时间线容器高度自适应
        const calc = (n) => `calc(16.66% + ${n}px)`;
        // 视频上边缘贯穿最左的1px实线：中线对齐视频顶部
        if (this._tlVideoTopDivider) this._tlVideoTopDivider.style.top = calc(vTop - 0.5);
        if (this._tlResizerTop) this._tlResizerTop.style.top = calc(vTop - 4);
        if (this._tlVideoHeader) this._tlVideoHeader.style.top = calc(vTop);
        if (this._tlVideoHeader) this._tlVideoHeader.style.height = vH + "px";
        if (this._tlTrack) {
            this._tlTrack.style.top = calc(vTop);
            this._tlTrack.style.height = vH + "px";
        }
        // 中手柄中心对齐5px分割线的中线（midTop + 2.5）
        if (this._tlResizerMid) this._tlResizerMid.style.top = calc(midTop + 2.5 - 4);
        // 音视频之间 5px 贯穿分割线：上边缘贴视频底 (midTop)，下边缘贴音频顶 (aTop = midTop+5)
        if (this._tlDivider) this._tlDivider.style.top = calc(midTop);
        if (this._tlAudioHeader) {
            this._tlAudioHeader.style.top = calc(aTop);
            this._tlAudioHeader.style.height = aH + "px";
        }
        if (this._tlAudioTrack) {
            this._tlAudioTrack.style.top = calc(aTop);
            this._tlAudioTrack.style.height = aH + "px";
        }
        if (this._tlResizerBottom) this._tlResizerBottom.style.top = calc(botTop - 4);
    }

    // 三个手柄：
    //   top    - 调整视频高度（_tlVideoHeight），上下拖动增减视频高度，音频位置随之上下平移但高度不变
    //   mid    - 视频与音频整体上下平移（调整 _tlVideoTopOffset），两者高度均不变
    //   bottom - 调整音频高度（_tlAudioHeight），上下拖动增减音频高度
    _initTrackResizer() {
        // 上手柄：调整视频高度（视频底部固定，顶部随手柄上下移动，音频位置不变）
        if (this._tlResizerTop) {
            this._tlResizerTop.addEventListener("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                this._tlHeightsCustomized = true;
                this._tlResizerTop.classList.add("xzg-ve-resizing");
                const startY = e.clientY;
                const startVH = this._tlVideoHeight;
                const startOff = this._tlVideoTopOffset || 0;
                const vBottom = startOff + startVH; // 视频底部固定基准
                const onMove = (ev) => {
                    // 手柄在视频顶部：向上拖→顶部上移→视频变高；向下拖→顶部下移→视频变窄
                    // 保持 vOff + vH = vBottom 不变 → 视频底/音频顶不动
                    const delta = ev.clientY - startY;
                    let newVH = Math.max(40, Math.round(startVH - delta));
                    // 限制 newVH 不超过 vBottom，保证 vOff >= 0
                    if (newVH > vBottom) newVH = vBottom;
                    this._tlVideoHeight = newVH;
                    this._tlVideoTopOffset = vBottom - newVH;
                    this._applyTrackLayout();
                };
                const onUp = () => {
                    window.removeEventListener("mousemove", onMove);
                    window.removeEventListener("mouseup", onUp);
                    this._tlResizerTop.classList.remove("xzg-ve-resizing");
                };
                window.addEventListener("mousemove", onMove);
                window.addEventListener("mouseup", onUp);
            });
        }
        // 中手柄：视频/音频整体上下平移（高度不变，调整 _tlVideoTopOffset）
        if (this._tlResizerMid) {
            this._tlResizerMid.addEventListener("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                this._tlHeightsCustomized = true;
                this._tlResizerMid.classList.add("xzg-ve-resizing");
                const startY = e.clientY;
                const startOff = this._tlVideoTopOffset || 0;
                const onMove = (ev) => {
                    // 向下拖增大 _tlVideoTopOffset，视频与音频整体下移；向上拖减小偏移
                    const delta = ev.clientY - startY;
                    this._tlVideoTopOffset = Math.max(0, Math.round(startOff + delta));
                    this._applyTrackLayout();
                };
                const onUp = () => {
                    window.removeEventListener("mousemove", onMove);
                    window.removeEventListener("mouseup", onUp);
                    this._tlResizerMid.classList.remove("xzg-ve-resizing");
                };
                window.addEventListener("mousemove", onMove);
                window.addEventListener("mouseup", onUp);
            });
        }
        // 下手柄：调整音频高度
        if (this._tlResizerBottom) {
            this._tlResizerBottom.addEventListener("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                this._tlHeightsCustomized = true;
                this._tlResizerBottom.classList.add("xzg-ve-resizing");
                const startY = e.clientY;
                const startAH = this._tlAudioHeight;
                const onMove = (ev) => {
                    const delta = ev.clientY - startY;
                    this._tlAudioHeight = Math.max(30, Math.round(startAH + delta));
                    this._applyTrackLayout();
                };
                const onUp = () => {
                    window.removeEventListener("mousemove", onMove);
                    window.removeEventListener("mouseup", onUp);
                    this._tlResizerBottom.classList.remove("xzg-ve-resizing");
                };
                window.addEventListener("mousemove", onMove);
                window.addEventListener("mouseup", onUp);
            });
        }
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
        if (_XZG_VE_THUMB_LOADING.has(key)) {
            console.log("[xzg-ve] thumb: 已在加载中, 跳过, name=", m.name);
            return;
        }
        _XZG_VE_THUMB_LOADING.add(key);
        console.log("[xzg-ve] thumb: 开始加载, name=", m.name, "probeState=", m.probeState);
        try {
            // 等 probe 完成（最多等 12s）
            const t0 = Date.now();
            while (m.probeState !== "ok" && m.probeState !== "failed") {
                if (Date.now() - t0 > 12000) break;
                await new Promise(r => setTimeout(r, 300));
            }
            console.log("[xzg-ve] thumb: probe 等待结束, name=", m.name, "state=", m.probeState, "耗时=", Date.now() - t0, "ms");
            if (m.probeState !== "ok") {
                console.warn("[xzg-ve] thumb: probe 未成功, state=", m.probeState, "name=", m.name);
                _XZG_VE_THUMB_CACHE[key] = { url: null, failed: true };
                this._applyThumbPlaceholder(m, "❌");
                return;
            }
            const dur = m.info?.duration || 0;
            const t = dur > 2 ? Math.min(1, dur * 0.1) : 0;
            console.log("[xzg-ve] thumb: 发送 extract_frame 请求, name=", m.name, "time=", t);
            const data = await _postJson(API_EXTRACT, {
                filename: m.name, type: m.type, time: t,
            });
            console.log("[xzg-ve] thumb: extract_frame 返回, name=", m.name, "data=", data);
            if (data.error) throw new Error(data.error);
            // data.filename 是 input 目录下的 png 名
            const url = `/view?filename=${encodeURIComponent(data.filename)}&type=input&subfolder=&t=${Date.now()}`;
            _XZG_VE_THUMB_CACHE[key] = { url, failed: false };
            this._applyThumbImg(m, url);
            console.log("[xzg-ve] thumb: 缩略图已应用, name=", m.name, "url=", url);
        } catch (e) {
            console.error("[xzg-ve] thumb 加载失败:", m.name, e.message);
            _XZG_VE_THUMB_CACHE[key] = { url: null, failed: true };
            this._applyThumbPlaceholder(m, "❌");
        } finally {
            _XZG_VE_THUMB_LOADING.delete(key);
        }
    }

    // 把已缓存的缩略图填入对应的 DOM（避免全量重渲染打断框选）
    _applyThumbImg(m, url) {
        const items = this._mediaList?.querySelectorAll(".xzg-ve-media-thumb");
        if (!items || items.length === 0) {
            console.warn("[xzg-ve] _applyThumbImg: 未找到 thumb 容器, name=", m.name);
            return;
        }
        let applied = false;
        for (const wrap of items) {
            if (wrap.dataset.name === m.name && wrap.dataset.type === m.type) {
                if (wrap.querySelector("img")) continue;
                wrap.innerHTML = "";
                const img = _el("img", null, null, wrap);
                img.src = url;
                applied = true;
            }
        }
        if (!applied) {
            console.warn("[xzg-ve] _applyThumbImg: 未匹配到 DOM, name=", m.name, "items=", items.length);
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
        _xzgVeRemoveSessionMedia(this.nodeId, name);  // 从会话列表移除
        this._renderMediaList();
        this._setStatus(`已从媒体库移除: ${name}（文件未删除）`);
    }

    _clearMediaLibrary() {
        if (this.mediaLibrary.length === 0) {
            this._setStatus("媒体库已为空");
            return;
        }
        const n = this.mediaLibrary.length;
        this.mediaLibrary = [];
        this.selectedMediaNames.clear();
        _xzgVeSaveSessionMedia(this.nodeId, []);  // 清空会话列表
        this._renderMediaList();
        this._setStatus(`已清空媒体库 (${n} 个视频，文件未删除)`);
    }

    async _addFromInput() {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = VIDEO_EXTS.map(e => "." + e).join(",");
        input.multiple = true;
        input.style.display = "none";
        document.body.appendChild(input);
        input.onchange = async () => {
            document.body.removeChild(input);
            const files = Array.from(input.files || []).filter(f => _isVideo(f.name));
            if (files.length === 0) return;
            this._setStatus(`上传 ${files.length} 个文件...`);
            const uploaded = [];
            for (const f of files) {
                try {
                    const { filename: diskName, displayName } = await this._uploadFile(f);
                    if (!this.mediaLibrary.find(m => m.name === diskName)) {
                        this.mediaLibrary.push(this._makeMediaItem(diskName, "input", displayName));
                        _xzgVeAddSessionMedia(this.nodeId, diskName, "input");  // 写入会话列表
                        uploaded.push(diskName);
                    }
                } catch (e) {
                    // 上传失败（含文件损坏被后端删除），不加入媒体库
                    this._setStatus(`上传失败: ${e.message}`);
                }
            }
            this._renderMediaList();
            if (uploaded.length > 0) {
                this._setStatus(`已上传 ${uploaded.length} 个视频, 探测+缩略图生成中...`);
                this._probeQueue();
            }
        };
        input.click();
    }

    async _uploadFile(file) {
        // 复用已有的上传 API
        const chunkSize = 20 * 1024 * 1024;
        const totalChunks = Math.ceil(file.size / chunkSize);
        // 保留原始文件名（后端处理重名加序号）
        const safeName = file.name.replace(/[^\w.\-]/g, "_");

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
        // 返回磁盘文件名 + 原始显示名
        return { filename, displayName: file.name };
    }

    async _addToLibraryAndTimeline(filename, type) {
        let newItem = null;
        if (!this.mediaLibrary.find(m => m.name === filename)) {
            newItem = this._makeMediaItem(filename, type);
            this.mediaLibrary.push(newItem);
            _xzgVeAddSessionMedia(this.nodeId, filename, type);  // 写入会话列表
            this._renderMediaList();
            if (newItem.probeState === "pending") this._probeQueue();
        }
        this._addClipToTimeline(filename, type);
    }

    // ═══════════════════════════════════════════════════════════
    //  时间线
    // ═══════════════════════════════════════════════════════════
    // 从 sessionStorage 恢复上次会话的时间线
    _restoreTimelineSession() {
        const saved = _xzgVeGetSessionTimeline(this.nodeId);
        if (!saved.length) return;
        for (const s of saved) {
            // 仅恢复媒体库中存在的视频（避免引用已删除的文件）
            if (!this.mediaLibrary.find(m => m.name === s.filename)) continue;
            this.timeline.push({
                id: ++this._clipIdCounter,
                filename: s.filename,
                type: s.type || "input",
                name: s.name || s.filename,
                start: s.start || 0,
                end: s.end || 0,
                sourceDuration: s.sourceDuration || 0,
                durationPending: !!s.durationPending,
                borderColor: s.borderColor || "",
                tlStart: s.tlStart != null && s.tlStart >= 0 ? s.tlStart : null,
            });
        }
        if (this.timeline.length > 0) {
            this._renderTimeline();
            this._setStatus(`已恢复上次时间线 (${this.timeline.length} 片段)`);
            // 默认加载第一个片段的第一帧到预览区（避免空白）
            // 延迟到 probe 完成后再加载，确保片段的 start/end 已修正
            this._loadFirstClipPreview();
            // 恢复时间线后，等待首个片段 probe 完成再启用并填充分辨率控件
            this._syncResFromFirstClipWhenReady();
        }
    }

    // 等待首个片段 probe 完成后，启用并填充分辨率控件（用于恢复时间线场景）
    async _syncResFromFirstClipWhenReady() {
        if (this.timeline.length === 0) return;
        const firstClip = this.timeline[0];
        const media = this.mediaLibrary.find(m => m.name === firstClip.filename && m.type === (firstClip.type || "input"));
        if (!media) return;
        const t0 = Date.now();
        while (media.probeState !== "ok" && media.probeState !== "failed") {
            if (Date.now() - t0 > 12000) return;
            await new Promise(r => setTimeout(r, 300));
        }
        if (!this._root || media.probeState !== "ok") return;
        // 恢复期间用户可能清空时间线，再次校验
        if (this.timeline.length === 0) return;
        this._syncResFromFirstClip();
    }

    // 加载第一个片段的第一帧到预览区（用于打开编辑器时显示画面，而非空白）
    async _loadFirstClipPreview() {
        if (this.timeline.length === 0) return;
        const firstClip = this.timeline[0];
        // 等待 probe 完成，确保 clip.start/end 已修正
        const media = this.mediaLibrary.find(m => m.name === firstClip.filename && m.type === firstClip.type);
        if (!media) return;
        const t0 = Date.now();
        while (media.probeState !== "ok" && media.probeState !== "failed") {
            if (Date.now() - t0 > 12000) return;
            await new Promise(r => setTimeout(r, 300));
        }
        if (media.probeState !== "ok" || !this._root) return;
        // 重新检查 firstClip 仍存在（可能被用户操作删除）
        const stillExists = this.timeline.find(c => c.id === firstClip.id);
        if (!stillExists) return;
        // 仅在 canvas 还未加载任何片段时才加载（避免覆盖用户后续操作）
        if (this._currentClip && this._currentDecoder) return;
        this._tlGlobalTime = 0;
        this._loadClipAtTime(firstClip, firstClip.start || 0, false);
        this._updatePlayhead();
        this._updateTimeDisplay();
    }

    // 保存当前时间线到 sessionStorage
    _saveTimelineSession() {
        _xzgVeSaveSessionTimeline(this.nodeId, this.timeline);
    }

    // ─── 历史记录（Ctrl+Z / Ctrl+Shift+Z）───
    // 深拷贝当前 timeline 状态推入 undo 栈，并清空 redo 栈
    _pushHistory() {
        const snapshot = this.timeline.map(c => ({ ...c }));
        this._undoStack.push(snapshot);
        if (this._undoStack.length > this._historyMax) this._undoStack.shift();
        this._redoStack = [];
    }
    // 撤销：当前状态压入 redo，恢复 undo 栈顶
    _undo() {
        if (this._undoStack.length === 0) return;
        const current = this.timeline.map(c => ({ ...c }));
        this._redoStack.push(current);
        const prev = this._undoStack.pop();
        this.timeline = prev;
        this.selectedClipIds.clear();
        this._renderTimeline();
        this._saveTimelineSession();
        this._seekToGlobalTime(this._tlGlobalTime);
    }
    // 重做：当前状态压入 undo，恢复 redo 栈顶
    _redo() {
        if (this._redoStack.length === 0) return;
        const current = this.timeline.map(c => ({ ...c }));
        this._undoStack.push(current);
        const next = this._redoStack.pop();
        this.timeline = next;
        this.selectedClipIds.clear();
        this._renderTimeline();
        this._saveTimelineSession();
        this._seekToGlobalTime(this._tlGlobalTime);
    }

    _addClipToTimeline(filename, type, tlStart = null) {
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
            borderColor: "",
            tlStart: tlStart,  // 拖放时按鼠标位置放置；其他调用方式默认 null 自动追加
        };
        this._pushHistory();
        this.timeline.push(clip);
        // 拖放时（tlStart 非 null）：处理与已有片段的交集（裁剪/切割）
        if (tlStart != null) {
            this._applyClipOverlapTrim(clip);
            // 处理新片段完全在某个现有片段内部的情况：切割该片段为两段
            this._splitClipForInsertion(clip);
        }
        this.selectedClipIds = new Set([clip.id]);
        this._renderTimeline();
        this._renderProps();
        this._loadClipToPreview(clip);
        // 首个片段加入时间线时，自动用其分辨率作为初始渲染分辨率
        if (this.timeline.length === 1) {
            this._syncResFromFirstClip();
        }
        if (duration > 0) {
            this._setStatus(`已添加片段: ${filename} (${_fmtTime(duration)})`);
        } else {
            this._setStatus(`已添加片段: ${filename} (时长待探测，使用占位 60s)`);
        }
    }

    _renderTimeline() {
        const track = this._tlTrack;
        // 达芬奇式保留：先收集旧片段的缩略图 img，重建后再移入对应新片段，避免缩放时缩略图清空闪烁
        // 旧 img 在 _loadClipThumbs 中由新缩略图加载完成后逐步替换（淡入过渡）
        const oldThumbsByClipId = new Map();
        for (const oldEl of track.querySelectorAll(".xzg-ve-clip")) {
            const oldId = parseInt(oldEl.dataset.clipId);
            if (!oldId) continue;
            const oldWrap = oldEl.querySelector(".xzg-ve-clip-thumbs");
            if (oldWrap) {
                const imgs = Array.from(oldWrap.querySelectorAll("img.xzg-ve-clip-thumb"));
                if (imgs.length > 0) oldThumbsByClipId.set(oldId, imgs);
            }
        }
        track.innerHTML = "";
        // 持久化当前时间线（恢复时由 _restoreTimelineSession 接管，不会循环）
        this._saveTimelineSession();
        // 收集本次渲染的 clip 元素，稍后异步加载缩略图
        const pendingThumbs = [];
        if (this.timeline.length === 0) {
            _el("div", "xzg-ve-timeline-empty", "拖拽媒体库中的视频到此处", track);
            this._tlInfo.textContent = "";
            // 无片段时仍渲染刻度（始终充满画布）
            this._renderTicks();
            this._applyTlScroll();
            this._updatePlayhead();
            return;
        }
        // 计算内容总时长（裁剪后各片段时长之和，用于信息显示）
        const contentTotal = this.timeline.reduce((s, c) => s + (c.end - c.start), 0);
        this._tlInfo.textContent = `${this.timeline.length} 片段 · 总时长 ${_fmtTime(contentTotal)}`;
        // 片段宽度按缩放后的内容宽度计算（Alt+滚轮可缩放）
        const pxPerSec = this._getPxPerSec();
        this._clampScrollLeft();

        // 计算每个片段的渲染位置：tlStart=null 自动追加到上一片段末尾，否则用 tlStart×pxPerSec
        let autoEnd = 0; // 时间轴上自动追加的末尾（秒）
        const clipRects = []; // {clip, x, w, tlStart, tlEnd}
        for (const clip of this.timeline) {
            const dur = clip.end - clip.start;
            const w = Math.max(30, dur * pxPerSec);
            let ts;
            if (clip.tlStart != null) {
                ts = clip.tlStart;
            } else {
                ts = autoEnd;
            }
            const x = ts * pxPerSec;
            clipRects.push({ clip, x, w, tlStart: ts, tlEnd: ts + dur });
            autoEnd = ts + dur;
        }

        for (const { clip, x, w } of clipRects) {
            const el = _el("div", "xzg-ve-clip", null, track);
            el.dataset.clipId = clip.id;
            if (this.selectedClipIds.has(clip.id)) el.classList.add("xzg-ve-selected");
            // 自定义 3px 向内收边框颜色（持久化值 → CSS 变量）
            if (clip.borderColor) el.style.setProperty("--xzg-ve-clip-border", clip.borderColor);
            el.style.width = `${w}px`;
            el.style.left = `${x}px`;

            // 缩略图带（宽度=片段宽度，裁剪时通过 transform 偏移让左侧被裁掉）+ 底部信息条
            const thumbsWrap = _el("div", "xzg-ve-clip-thumbs", null, el);
            thumbsWrap.style.width = `${w}px`;
            const info = _el("div", "xzg-ve-clip-info", null, el);
            _el("span", "xzg-ve-clip-name", clip.name, info);

            // 左右拖拽手柄
            const lh = _el("div", "xzg-ve-clip-handle xzg-ve-clip-handle-left", null, el);
            const rh = _el("div", "xzg-ve-clip-handle xzg-ve-clip-handle-right", null, el);
            const del = _el("button", "xzg-ve-clip-del", "×", el);

            // 保留旧缩略图：移入新 thumbsWrap 作为占位（新缩略图加载完后逐步替换）
            const oldImgs = oldThumbsByClipId.get(clip.id);
            if (oldImgs) {
                for (const img of oldImgs) {
                    thumbsWrap.appendChild(img);
                }
            }

            // 自由拖动（mousedown 在片段主体，非手柄/删除按钮）
            el.addEventListener("mousedown", (e) => {
                if (e.target === lh || e.target === rh || e.target === del) return;
                e.preventDefault(); // 阻止浏览器默认拖拽/文字选择行为，确保 pointermove 实时跟随
                e.stopPropagation();
                // Alt+拖动：复制片段（原片段保留），显示金色预览框（与媒体库拖入一致），松开后才落入时间线
                if (e.altKey) {
                    this._startClipAltDrag(e, clip);
                } else {
                    this._startClipDrag(e, clip, clipRects);
                }
            });
            el.addEventListener("click", (e) => {
                if (e.target === lh || e.target === rh || e.target === del) return;
                // 拖动后误触 click 跳过选中（_clipDragged 标记）
                if (this._clipDragged) { this._clipDragged = false; return; }
                if (e.ctrlKey || e.metaKey) {
                    if (this.selectedClipIds.has(clip.id)) {
                        this.selectedClipIds.delete(clip.id);
                    } else {
                        this.selectedClipIds.add(clip.id);
                    }
                } else {
                    this.selectedClipIds = new Set([clip.id]);
                }
                if (this.selectedMediaNames.size > 0) {
                    this.selectedMediaNames.clear();
                    this._renderMediaList();
                }
                // 仅更新选中态 class，不重建 DOM，避免缩略图重新加载导致闪烁
                this._updateClipSelection();
                this._renderProps();
            });

            // 右键菜单：颜色 → 红橙黄绿青蓝紫
            el.addEventListener("contextmenu", (e) => this._showCtxMenu(e, clip.id));

            // 调整入点
            lh.addEventListener("pointerdown", (e) => this._onHandleDown(e, clip, "left"));
            rh.addEventListener("pointerdown", (e) => this._onHandleDown(e, clip, "right"));
            del.addEventListener("click", (e) => {
                e.stopPropagation();
                this._deleteClip(clip.id);
            });
            // 收集本片段待加载缩略图
            if (!this._tlInHandleDrag) {
                pendingThumbs.push({ wrap: thumbsWrap, clip, width: w });
            }
        }
        // 检测相邻片段并添加桥接手柄（交界处 ±5px，滚动裁剪：左尾+右头同步移动，避免中间断开）
        const EPS_SEC = 0.02; // 相邻容差（秒），避免浮点误差
        const sortedRects = [...clipRects].sort((a, b) => a.tlStart - b.tlStart);
        for (let i = 0; i < sortedRects.length - 1; i++) {
            const a = sortedRects[i];
            const b = sortedRects[i + 1];
            const aDur = a.clip.end - a.clip.start;
            const aRight = a.tlStart + aDur;
            const bLeft = b.tlStart;
            if (Math.abs(aRight - bLeft) < EPS_SEC) {
                const bridgeX = a.x + a.w; // 交界处 x 坐标
                const bridge = _el("div", "xzg-ve-clip-bridge", null, track);
                bridge.style.left = `${bridgeX - 5}px`;
                bridge.style.height = "100%";
                bridge.addEventListener("pointerdown", (e) => this._onBridgeHandleDown(e, a.clip, b.clip));
            }
        }
        // 计算内容总宽度（最后一个片段右边缘 + 视口宽度尾部留白，确保播放头在末尾也能居中）
        const tailPad = this._getViewWidth();
        const maxRight = clipRects.length > 0
            ? Math.max(...clipRects.map(r => r.x + r.w)) + tailPad
            : tailPad;
        // 设置 track 内容宽度（通过子元素 absolute 定位，需显式设 scrollWidth）
        track.style.width = "";
        // 尾部占位（保证可滚动到最右）
        const tailSpacer = _el("div", "xzg-ve-clip-tail-spacer", null, track);
        tailSpacer.style.cssText = `position: absolute; left: ${maxRight - tailPad}px; width: ${tailPad}px; height: 100%;`;
        // 异步加载所有片段缩略图（不阻塞渲染）
        for (const { wrap, clip, width } of pendingThumbs) {
            this._loadClipThumbs(wrap, clip, width);
        }
        // 重渲染后同步播放头位置、时间显示、刻度、横向滚动
        this._renderTicks();
        this._applyTlScroll();
        this._updatePlayhead();
        this._updateTimeDisplay();
    }

    // 片段自由拖动 + 磁吸（基于时间轴秒数，非像素）
    _startClipDrag(e, clip, clipRects) {
        const startX = e.clientX;
        const pxPerSec = this._getPxPerSec();
        const myRect = clipRects.find(r => r.clip === clip);
        const origTlStart = myRect ? myRect.tlStart : (clip.tlStart || 0);
        let moved = false;
        this._clipDragged = false;
        const SNAP_SEC = 15 / pxPerSec; // 磁吸阈值（15px，秒）
        let dragEl = null;

        const move = (ev) => {
            const dx = ev.clientX - startX;
            if (!moved && Math.abs(dx) < 3) return;
            if (!moved) this._pushHistory();
            moved = true;
            this._clipDragged = true;
            let newTlStart = origTlStart + dx / pxPerSec;
            newTlStart = Math.max(0, newTlStart);

            // 磁吸：片段左右边缘与时间轴起点(0)及其他片段边缘对齐
            const myDur = clip.end - clip.start;
            const myLeft = newTlStart;
            const myRight = newTlStart + myDur;
            let snapped = false;
            // 吸附到时间轴起点（0）
            if (!snapped && Math.abs(myLeft) < SNAP_SEC) { newTlStart = 0; snapped = true; }
            if (!snapped && Math.abs(myRight) < SNAP_SEC) { newTlStart = -myDur; snapped = true; }
            // 吸附到其他片段边缘
            if (!snapped) {
                for (const r of clipRects) {
                    if (r.clip === clip) continue;
                    const oLeft = r.tlStart;
                    const oRight = r.tlStart + (r.clip.end - r.clip.start);
                    if (Math.abs(myLeft - oLeft) < SNAP_SEC) { newTlStart = oLeft; snapped = true; break; }
                    if (Math.abs(myLeft - oRight) < SNAP_SEC) { newTlStart = oRight; snapped = true; break; }
                    if (Math.abs(myRight - oLeft) < SNAP_SEC) { newTlStart = oLeft - myDur; snapped = true; break; }
                    if (Math.abs(myRight - oRight) < SNAP_SEC) { newTlStart = oRight - myDur; snapped = true; break; }
                }
            }
            newTlStart = Math.max(0, newTlStart);

            clip.tlStart = newTlStart;
            // 直接更新 DOM，避免重建闪烁
            if (!dragEl) dragEl = this._tlTrack.querySelector(`.xzg-ve-clip[data-clip-id="${clip.id}"]`);
            if (dragEl) {
                dragEl.style.left = `${newTlStart * pxPerSec}px`;
                // 拖动期间被拖动片段显示在最上层，覆盖其他片段
                dragEl.style.zIndex = "100";
            }
            if (myRect) {
                myRect.x = newTlStart * pxPerSec;
                myRect.tlStart = newTlStart;
                myRect.tlEnd = newTlStart + myDur;
            }
        };
        const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            if (moved) {
                // 恢复 z-index
                if (dragEl) dragEl.style.zIndex = "";
                // 与媒体库拖入一致：先重叠裁剪，再切割落入片段内部的场景
                this._applyClipOverlapTrim(clip);
                this._splitClipForInsertion(clip);
                this._renderTimeline();
                this._saveTimelineSession();
            }
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
    }

    // Alt+拖动复制片段：原片段保留，拖动期间只显示金色预览框（与媒体库拖入一致），松开后才创建副本落入时间线
    _startClipAltDrag(e, srcClip) {
        const startX = e.clientX;
        const srcDur = srcClip.end - srcClip.start;
        let moved = false;
        this._clipDragged = false;

        const move = (ev) => {
            const dx = ev.clientX - startX;
            if (!moved && Math.abs(dx) < 3) return;
            if (!moved) {
                this._pushHistory();
                moved = true;
            }
            this._clipDragged = true;
            // 显示金色预览框（使用源片段实际时长，鼠标对应片段中心点）
            this._showDragPreview(ev.clientX, srcDur, "center");
        };
        const up = (ev) => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            this._hideDragPreview();
            if (moved) {
                // 创建副本，加入 timeline 并设置最终位置（鼠标对应片段中心点）
                const tlStart = this._clientXToTlStart(ev.clientX, srcDur, "center");
                const copy = {
                    id: ++this._clipIdCounter,
                    filename: srcClip.filename,
                    type: srcClip.type,
                    name: srcClip.name,
                    start: srcClip.start,
                    end: srcClip.end,
                    sourceDuration: srcClip.sourceDuration,
                    durationPending: srcClip.durationPending,
                    borderColor: srcClip.borderColor,
                    tlStart: tlStart,
                };
                this.timeline.push(copy);
                // 与媒体库拖入一致：先重叠裁剪，再切割落入片段内部的场景
                this._applyClipOverlapTrim(copy);
                this._splitClipForInsertion(copy);
                this._renderTimeline();
                this._saveTimelineSession();
            }
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
    }

    // 重叠裁剪：被拖动片段保持完整，被覆盖片段的 start/end 被真正裁剪
    // 所有计算基于时间轴秒数，与 pxPerSec 无关，缩放不影响结果
    _applyClipOverlapTrim(draggedClip) {
        const draggedId = draggedClip ? draggedClip.id : -1;
        const dDur = draggedClip.end - draggedClip.start;
        const dLeft = draggedClip.tlStart;
        const dRight = dLeft + dDur;

        for (const c of this.timeline) {
            if (c.id === draggedId) continue;
            const cDur = c.end - c.start;
            const cLeft = c.tlStart;
            const cRight = cLeft + cDur;

            // 无重叠
            if (dLeft >= cRight || dRight <= cLeft) continue;

            const overlapSec = Math.min(dRight, cRight) - Math.max(dLeft, cLeft);
            if (overlapSec <= 0) continue;

            if (dLeft > cLeft && dRight < cRight) {
                // 被拖动片段完全在 C 内部（前后都有余量）：跳过，由 _splitClipForInsertion 切割为前后两段
                continue;
            } else if (dLeft >= cLeft && dRight <= cRight) {
                // 被拖动片段与 C 边界重合的完全覆盖：裁掉 C 的右侧到 dLeft
                c.end = c.start + (dLeft - cLeft);
            } else if (dLeft >= cLeft) {
                // 被拖动片段覆盖 C 的右侧 → 裁剪 C 的 end
                c.end = Math.max(c.start + 0.1, c.end - overlapSec);
            } else if (dRight <= cRight) {
                // 被拖动片段覆盖 C 的左侧 → 裁剪 C 的 start
                c.start = Math.min(c.end - 0.1, c.start + overlapSec);
                c.tlStart = dRight; // C 的起始位置右移到被拖动片段右侧
            } else {
                // 被拖动片段完全覆盖 C → C 被完全裁掉
                c.start = c.end - 0.1;
                c.tlStart = dRight;
            }
        }
    }

    // 拖放插入切割：新片段完全落入某个现有片段内部时，将该片段切割为前后两段
    // 新片段 [dLeft, dRight] 完全在 C [cLeft, cRight] 内部 → C 切为两段，中间留给新片段
    _splitClipForInsertion(newClip) {
        const dLeft = newClip.tlStart;
        const dDur = newClip.end - newClip.start;
        const dRight = dLeft + dDur;

        for (const c of [...this.timeline]) {
            if (c.id === newClip.id) continue;
            const cDur = c.end - c.start;
            const cLeft = c.tlStart;
            const cRight = cLeft + cDur;

            // 新片段完全在 C 内部（C 前后都有余量）
            if (dLeft > cLeft && dRight < cRight) {
                // 切割点在源视频中的时间
                const splitSourceTime = c.start + (dLeft - cLeft);
                const splitSourceEnd = c.start + (dRight - cLeft);

                // 原 C 的前半段保留（start 不变，end 缩短到切割点）
                const origEnd = c.end;
                const origTlStart = c.tlStart;
                c.end = splitSourceTime;

                // 创建后半段作为新片段
                const rightPart = {
                    id: ++this._clipIdCounter,
                    filename: c.filename,
                    type: c.type,
                    name: c.name,
                    start: splitSourceEnd,
                    end: origEnd,
                    sourceDuration: c.sourceDuration,
                    durationPending: c.durationPending,
                    borderColor: c.borderColor,
                    tlStart: dRight,
                };
                this.timeline.push(rightPart);
            }
        }
    }

    // 同步从缓存更新缩略图（拖动时调用，利用已缓存的缩略图流，复用现有 img，仅更新 src）
    // 避免异步重建 DOM 导致的闪烁/空白；图片已在浏览器缓存时秒显示
    _syncThumbsFromCache(clip, thumbsWrap, clipWidth) {
        if (!thumbsWrap || !thumbsWrap.isConnected) return;
        const media = this.mediaLibrary.find(m => m.name === clip.filename && m.type === clip.type);
        if (!media) return;
        const mediaKey = `${clip.filename}|${clip.type}`;
        const stream = _XZG_VE_FULL_THUMB_STREAM[mediaKey];
        if (!stream || !stream.thumbs || stream.thumbs.length === 0) return;

        const clipEl = thumbsWrap.parentElement;
        const clipH = clipEl ? clipEl.clientHeight : 60;
        const vw = media.info?.width || 16;
        const vh = media.info?.height || 9;
        const aspect = vw / vh;
        const thumbW = Math.max(20, Math.round(clipH * aspect));
        const need = Math.max(1, Math.ceil(clipWidth / thumbW));

        // 从缓存流中筛选当前 [start, end] 范围的缩略图
        let inRange = stream.thumbs.filter(t => t.time >= clip.start && t.time <= clip.end);
        let selected = [];
        if (inRange.length === 0) {
            const mid = (clip.start + clip.end) / 2;
            const closest = stream.thumbs.reduce((best, t) =>
                Math.abs(t.time - mid) < Math.abs(best.time - mid) ? t : best, stream.thumbs[0]);
            selected = [closest];
        } else if (inRange.length <= need) {
            for (let i = 0; i < need; i++) selected.push(inRange[i % inRange.length]);
        } else {
            const step = (inRange.length - 1) / Math.max(1, need - 1);
            for (let i = 0; i < need; i++) {
                const idx = Math.min(inRange.length - 1, Math.round(i * step));
                selected.push(inRange[idx]);
            }
        }

        // 复用现有 img，仅更新 src；数量不匹配时追加/移除（不重建 DOM，避免闪烁）
        const existingImgs = Array.from(thumbsWrap.querySelectorAll("img.xzg-ve-clip-thumb"));
        while (existingImgs.length > selected.length) {
            const extra = existingImgs.pop();
            if (extra) extra.remove();
        }
        while (existingImgs.length < selected.length) {
            const img = _el("img", "xzg-ve-clip-thumb", null, thumbsWrap);
            img.alt = "";
            img.style.width = thumbW + "px";
            existingImgs.push(img);
        }
        // 更新 src（用 dataset.url 比较，避免重复设置相同 src）
        // 关键：不移除 xzg-ve-thumb-loaded 类，让旧图片保持显示，
        // 浏览器在 src 改变时会保持旧图片显示直到新图片就绪，避免空白闪烁
        for (let i = 0; i < selected.length; i++) {
            const img = existingImgs[i];
            const url = selected[i].url;
            if (img.dataset.url !== url) {
                img.dataset.url = url;
                // 仅对新 img（从未加载过）设置 onload 淡入；已有图片的 img 保持显示，src 更新后自然替换
                if (!img.classList.contains("xzg-ve-thumb-loaded")) {
                    img.onload = () => img.classList.add("xzg-ve-thumb-loaded");
                }
                img.src = url;
            } else if (img.complete && !img.classList.contains("xzg-ve-thumb-loaded")) {
                img.classList.add("xzg-ve-thumb-loaded");
            }
        }
    }

    // 达芬奇式缩略图：源视频级缩略图流（一次生成永久复用，裁剪/缩放零成本）
    // 裁剪仅改变显示范围筛选，不重新生成；缩放仅改变显示张数，不重新生成
    async _loadClipThumbs(wrap, clip, clipWidth) {
        const dur = clip.end - clip.start;
        if (dur <= 0 || !wrap.isConnected) return;
        // 等 probe 完成（获取视频宽高比）
        const media = this.mediaLibrary.find(m => m.name === clip.filename && m.type === clip.type);
        if (!media) return;
        const t0 = Date.now();
        while (media.probeState !== "ok" && media.probeState !== "failed") {
            if (Date.now() - t0 > 12000) break;
            await new Promise(r => setTimeout(r, 300));
        }
        if (media.probeState !== "ok") return;
        const vw = media.info?.width || 16;
        const vh = media.info?.height || 9;
        const aspect = vw / vh;

        // 片段高度（从 DOM 获取实际渲染高度）
        const clipEl = wrap.parentElement;
        const clipH = clipEl ? clipEl.clientHeight : 60;
        // 单张缩略图宽度 = 片段高度 × 视频宽高比
        const thumbW = Math.max(20, Math.round(clipH * aspect));
        const need = Math.max(1, Math.ceil(clipWidth / thumbW));

        // 获取源视频缩略图流（按 filename|type 缓存，一次生成永久复用）
        const mediaKey = `${clip.filename}|${clip.type}`;
        const stream = await this._ensureFullThumbStream(media, mediaKey);
        if (!stream || !stream.thumbs || stream.thumbs.length === 0) return;

        // 从流中按 [clip.start, clip.end] 范围筛选缩略图（裁剪零成本：仅改变筛选范围）
        let inRange = stream.thumbs.filter(t => t.time >= clip.start && t.time <= clip.end);

        // 按 need 数量均匀选取（缩放零成本：仅改变显示张数）
        let selected = [];
        if (inRange.length === 0) {
            // 范围内无缩略图（片段太短），取最接近片段中点的一张
            const mid = (clip.start + clip.end) / 2;
            const closest = stream.thumbs.reduce((best, t) =>
                Math.abs(t.time - mid) < Math.abs(best.time - mid) ? t : best, stream.thumbs[0]);
            selected = [closest];
        } else if (inRange.length <= need) {
            // 范围内缩略图不足以铺满（裁剪后变短 / 放大后 need 变大）
            // 循环重复 inRange 直至铺满 need 张，确保整段片段都有缩略图（无缝循环）
            for (let i = 0; i < need; i++) {
                selected.push(inRange[i % inRange.length]);
            }
        } else {
            // 等间隔抽样到 need 张（首尾必选，中间均匀取）
            const step = (inRange.length - 1) / Math.max(1, need - 1);
            for (let i = 0; i < need; i++) {
                const idx = Math.min(inRange.length - 1, Math.round(i * step));
                selected.push(inRange[idx]);
            }
        }

        // 保留旧缩略图：先记录旧 img 元素，新缩略图加载完成后逐步替换
        const oldImgs = Array.from(wrap.querySelectorAll("img.xzg-ve-clip-thumb"));

        // 高度变化导致 need 变化时，旧 img 数量可能多于新需求
        // 多余的旧 img 无法被 onload 逐索引移除，会永久残留 → 先从尾部移除多余的
        while (oldImgs.length > selected.length) {
            const extra = oldImgs.pop();
            if (extra && extra.isConnected) extra.remove();
        }

        // 创建新占位 img（opacity:0，加载完后淡入）
        const newImgs = [];
        for (let i = 0; i < selected.length; i++) {
            const img = _el("img", "xzg-ve-clip-thumb", null, wrap);
            img.alt = "";
            img.style.width = thumbW + "px";
            newImgs.push(img);
        }

        // 逐步设置 img.src：浏览器逐个加载，每个加载完成后淡入显示
        // 同时移除对应位置的旧 img（新旧交替，无空白闪烁）
        let loadedCount = 0;
        const totalToLoad = selected.length;
        for (let i = 0; i < totalToLoad; i++) {
            const img = newImgs[i];
            const url = selected[i].url;
            if (!img.isConnected || !url) {
                loadedCount++;
                continue;
            }
            img.onload = () => {
                img.classList.add("xzg-ve-thumb-loaded");
                if (oldImgs[i] && oldImgs[i].isConnected) {
                    oldImgs[i].remove();
                }
                loadedCount++;
            };
            img.src = url;
        }
    }

    // 获取源视频缩略图流（按 mediaKey 缓存 + 并发去重）
    // 达芬奇式核心：源视频级缩略图流只生成一次，之后所有片段共享、裁剪/缩放零成本
    // 上传时已预生成，拖到时间线时仅从后端取文件列表（秒回），不显示进度提示
    async _ensureFullThumbStream(media, mediaKey) {
        // 缓存命中：直接返回
        const cached = _XZG_VE_FULL_THUMB_STREAM[mediaKey];
        if (cached) return cached;

        // 并发去重：已有请求在进行，等待结果
        if (_XZG_VE_FULL_THUMB_STREAM_LOADING.has(mediaKey)) {
            const waitStart = Date.now();
            while (_XZG_VE_FULL_THUMB_STREAM_LOADING.has(mediaKey)) {
                if (Date.now() - waitStart > 30000) break; // 防死等
                await new Promise(r => setTimeout(r, 100));
            }
            return _XZG_VE_FULL_THUMB_STREAM[mediaKey];
        }

        // 首次请求：仅标记 loading，不显示全局提示
        // 上传时已通过合并接口预生成缩略图流，此处仅从后端磁盘缓存取文件列表（秒回）
        _XZG_VE_FULL_THUMB_STREAM_LOADING.add(mediaKey);

        try {
            const data = await _postJson(API_THUMBS_FULL, {
                filename: media.name,
                type: media.type,
                interval: 0.3,
            });
            if (data.error) throw new Error(data.error);

            const thumbs = (data.results || []).map(r => ({
                url: `/view?filename=${encodeURIComponent(r.filename)}&type=input&subfolder=${encodeURIComponent(r.subfolder || "")}&t=${Date.now()}`,
                time: r.time || 0,
            }));

            const stream = {
                thumbs,
                interval: data.interval || 0.3,
                duration: data.duration || 0,
                failed: false,
            };
            _XZG_VE_FULL_THUMB_STREAM[mediaKey] = stream;
            return stream;
        } catch (e) {
            console.error("[xzg-ve] 源视频缩略图流加载失败:", media.name, e.message);
            const stream = { thumbs: [], interval: 0.3, duration: 0, failed: true };
            _XZG_VE_FULL_THUMB_STREAM[mediaKey] = stream;
            return stream;
        } finally {
            _XZG_VE_FULL_THUMB_STREAM_LOADING.delete(mediaKey);
        }
    }

    // 全局缩略图渲染提示：引用计数管理显示/隐藏（挂载到时间线视口中央）
    _incThumbLoading() {
        this._thumbLoadingCount++;
        if (this._tlThumbLoadingHint) {
            this._tlThumbLoadingHint.classList.add("xzg-ve-show");
        }
    }

    _decThumbLoading() {
        this._thumbLoadingCount = Math.max(0, this._thumbLoadingCount - 1);
        if (this._thumbLoadingCount === 0 && this._tlThumbLoadingHint) {
            this._tlThumbLoadingHint.classList.remove("xzg-ve-show");
        }
    }

    // 渲染时间刻度（根据总时长和缩放自动选择刻度间隔）
    _renderTicks() {
        const ticks = this._tlTicks;
        if (!ticks) return;
        ticks.innerHTML = "";
        const pxPerSec = this._getPxPerSec();
        // 刻度始终充满整个可视画布：用视口宽度（含滚动偏移）作为刻度长度
        // 不再跟随片段总长度，即使无片段或片段很短也铺满刻度
        const viewWidth = this._getViewWidth();
        const scrollLeft = this._tlScrollLeft || 0;
        const ticksWidth = viewWidth + scrollLeft + viewWidth; // 尾部留白 = 视口宽度，与内容区一致
        if (ticksWidth <= 0) return;
        // ticks 容器：ticks 是 .xzg-ve-tl-scrub（left:150px）的子元素
        // 对齐基准 = 播放头 _tlLeftPad = 150px（相对 timeline）
        // ticks 相对 scrub 的 left = 0，刻度0与左侧分界线（150px）对齐
        ticks.style.left = "0px";
        ticks.style.width = ticksWidth + "px";

        // 自动选择主刻度间隔，使主刻度间距约 60-120px
        const candidates = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
        let majorStep = candidates[0];
        for (const step of candidates) {
            const majorPx = step * pxPerSec;
            if (majorPx >= 60) { majorStep = step; break; }
            majorStep = step;
        }
        // 次刻度步长：密度翻倍（原步长 ÷2）
        const oldMinorStep = majorStep >= 60 ? majorStep / 4 : majorStep / 5;
        const minorStep = oldMinorStep / 2;

        // 刻度绘制范围 = 可视画布覆盖的时间范围（从 0 到 ticksWidth/pxPerSec）
        // 不限制在片段总时长内，确保刻度始终充满画布
        const endTime = ticksWidth / pxPerSec;

        // 次刻度：密度×2。原有位置用 30% 短刻度，新插入位置用再短50%（15%）的超短刻度
        let idx = 0;
        for (let t = 0; t <= endTime + 0.001; t += minorStep) {
            const x = t * pxPerSec;
            const tick = _el("div", "xzg-ve-tl-tick", null, ticks);
            tick.style.left = x + "px";
            tick.style.height = (idx % 2 === 0) ? "30%" : "15%";
            idx++;
        }
        // 主刻度 + 标签（加长20%：55% × 1.2 = 66%）
        for (let t = 0; t <= endTime + 0.001; t += majorStep) {
            const x = t * pxPerSec;
            const tick = _el("div", "xzg-ve-tl-tick xzg-ve-tl-tick-major", null, ticks);
            tick.style.left = x + "px";
            tick.style.height = "66%";
            const label = _el("div", "xzg-ve-tl-tick-label", _fmtTickTime(t), ticks);
            label.style.left = (x + 3) + "px";
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
        // 无片段时禁用分辨率控件并显示 --
        this._disableRenderOpts();
        // 清空 canvas
        if (this._canvas) {
            const ctx = this._canvas.getContext('2d');
            ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
            this._canvas.classList.remove("xzg-ve-active");
        }
        this._currentDecoder = null;
        this._previewEmpty.classList.remove("xzg-ve-hidden");
        this._playhead.classList.remove("xzg-ve-active");
        this._updatePlayBtn(false);
        this._tlPlaying = false;
        this._tlGlobalTime = 0;
        this._currentClip = null;
        this._updateTimeDisplay();
    }

    // ═══════════════════════════════════════════════════════════
    //  框选
    // ═══════════════════════════════════════════════════════════
    // 时间线滚轮：Alt+滚轮缩放，普通滚轮横向滚动
    _onTimelineWheel(e) {
        const total = this._getTimelineTotalDuration();
        if (total <= 0) return;
        e.preventDefault();
        const rect = this._timeline.getBoundingClientRect();
        // 内容区起点 = timeline左 + 左侧占位（刻度0与左侧分界线对齐）
        const contentLeft = rect.left + this._tlLeftPad;
        // 鼠标在内容中的位置（含滚动偏移）
        const mouseX = e.clientX - contentLeft + this._tlScrollLeft;

        if (e.altKey) {
            // 以播放头为中心缩放：缩放后播放头尽量位于视口中央
            const oldPxPerSec = this._getPxPerSec();
            const viewWidth = this._getViewWidth();

            // 向上滚（deltaY<0）放大，向下滚（deltaY>0）缩小
            const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
            let newZoom = this._tlZoom * factor;
            // 允许缩小到 0.1（右侧留白），放大到 20
            newZoom = Math.max(0.1, Math.min(20, newZoom));
            this._tlZoom = newZoom;
            const newPxPerSec = this._getPxPerSec();
            const newPlayheadX = this._tlGlobalTime * newPxPerSec;

            // 始终尝试让播放头居中，clamp 自动处理边界
            // 只要内容足够宽（maxScroll 足够大），播放头就能居中
            this._tlScrollLeft = newPlayheadX - viewWidth / 2;
            this._clampScrollLeft();
            this._renderTimeline();
        } else {
            // 普通滚轮：横向滚动
            const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
            this._tlScrollLeft += delta;
            this._clampScrollLeft();
            this._applyTlScroll();
        }
    }

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

        // 非 Ctrl 点击 → 清空选中（仅切换 class，不重建 DOM，避免闪烁）
        if (!e.ctrlKey && !e.metaKey) {
            this.selectedClipIds.clear();
            this._updateClipSelection();
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
            // 仅更新选中态 class，不重建 DOM，避免松开鼠标时闪烁
            this._updateClipSelection();
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
        this._pushHistory();  // 记录裁剪前状态，支持 Ctrl+Z 撤销
        this._tlInHandleDrag = true;
        const pxPerSec0 = this._getPxPerSec();
        // 构建 clipRects 用于磁吸（基于当前片段状态计算其他片段的 tlStart 与时长）
        const clipRects = this.timeline.map(c => {
            const dur = c.end - c.start;
            const ts = c.tlStart != null ? c.tlStart : 0;
            return { clip: c, tlStart: ts, tlEnd: ts + dur };
        });
        const startX = e.clientX;
        const media = this.mediaLibrary.find(m => m.name === clip.filename);
        const sourceDuration = media?.info?.duration || clip.sourceDuration || Infinity;

        // OpenCut 模式（compute-resize.ts / buildResizeUpdate）：
        // 每个 element 有 startTime(时间轴位置) / duration(时长) / trimStart(源入点) / trimEnd(源出点余量)
        // 映射到我们的字段：
        //   OpenCut.startTime  → clip.tlStart
        //   OpenCut.duration   → clip.end - clip.start
        //   OpenCut.trimStart  → clip.start
        //   OpenCut.trimEnd    → sourceDuration - clip.end
        //
        // 左手柄 (side="left")：startTime += deltaTime, trimStart += deltaTime, duration -= deltaTime, trimEnd 不变
        //   → 头部移动，尾部位置不动
        // 右手柄 (side="right")：startTime 不变, trimEnd -= deltaTime, duration += deltaTime, trimStart 不变
        //   → 尾部移动，头部位置不动
        const start0 = clip.start;
        const end0 = clip.end;
        const tlStart0 = clip.tlStart;
        const dur0 = end0 - start0;
        const minDuration = 0.1;
        const SNAP_SEC = 15 / pxPerSec0; // 磁吸阈值（15px，秒）

        const move = (ev) => {
            const pxPerSec = this._getPxPerSec();
            const dx = ev.clientX - startX;
            const deltaTime = dx / pxPerSec;

            if (which === "left") {
                // 左手柄：tlStart 和 start 同步移动 deltaTime，end 不变
                // clamp: start >= 0（源入点不越界），duration >= minDuration
                const maxDelta = dur0 - minDuration;  // 右拖上限（裁头部，最短保留 minDuration）
                const minDelta = -start0;              // 左拖下限（扩展头部到源起点）
                let clampedDelta = Math.max(minDelta, Math.min(maxDelta, deltaTime));
                let newStart = start0 + clampedDelta;
                let newTlStart = tlStart0 + clampedDelta;
                // 磁吸：左边缘(tlStart)与时间轴起点(0)及其他片段左右边缘对齐
                const myLeft = newTlStart;
                if (Math.abs(myLeft) < SNAP_SEC) {
                    newTlStart = 0; newStart = start0 + (newTlStart - tlStart0);
                } else {
                    for (const r of clipRects) {
                        if (r.clip === clip) continue;
                        const oLeft = r.tlStart;
                        const oRight = r.tlStart + (r.clip.end - r.clip.start);
                        if (Math.abs(myLeft - oLeft) < SNAP_SEC) { newTlStart = oLeft; break; }
                        if (Math.abs(myLeft - oRight) < SNAP_SEC) { newTlStart = oRight; break; }
                    }
                    newStart = start0 + (newTlStart - tlStart0);
                }
                clip.start = newStart;
                clip.tlStart = newTlStart;
                clip.end = end0;
            } else {
                // 右手柄：end 移动 deltaTime，tlStart 和 start 不变
                // clamp: end <= sourceDuration（源出点不越界），duration >= minDuration
                const maxDelta = (sourceDuration === Infinity ? Infinity : sourceDuration - end0);  // 右拖上限（扩展尾部到源末尾）
                const minDelta = -(dur0 - minDuration);  // 左拖下限（裁尾部，最短保留 minDuration）
                let clampedDelta = Math.max(minDelta, Math.min(maxDelta, deltaTime));
                let newEnd = end0 + clampedDelta;
                // 磁吸：右边缘(tlStart + dur)与其他片段左右边缘对齐
                const myRight = tlStart0 + (newEnd - start0);
                for (const r of clipRects) {
                    if (r.clip === clip) continue;
                    const oLeft = r.tlStart;
                    const oRight = r.tlStart + (r.clip.end - r.clip.start);
                    if (Math.abs(myRight - oLeft) < SNAP_SEC) { newEnd = start0 + (oLeft - tlStart0); break; }
                    if (Math.abs(myRight - oRight) < SNAP_SEC) { newEnd = start0 + (oRight - tlStart0); break; }
                }
                clip.end = newEnd;
                clip.tlStart = tlStart0;
                clip.start = start0;
            }
            // 直接更新片段DOM（不调用 _renderTimeline，避免缩略图重新加载导致重新分布）
            // 同步 thumbsWrap 宽度 + 缓存同步缩略图（重新均匀分布），避免扩展区域空白
            const clipEl = this._tlTrack.querySelector(`[data-clip-id="${clip.id}"]`);
            if (clipEl) {
                const newDur = clip.end - clip.start;
                const newWidth = Math.max(30, newDur * pxPerSec);
                const newX = clip.tlStart * pxPerSec;
                clipEl.style.width = `${newWidth}px`;
                clipEl.style.left = `${newX}px`;
                clipEl.style.zIndex = "100";
                const thumbsWrap = clipEl.querySelector(".xzg-ve-clip-thumbs");
                if (thumbsWrap) {
                    thumbsWrap.style.width = `${newWidth}px`;
                    // 移除 transform 偏移，由 _syncThumbsFromCache 统一更新缩略图（避免偏移与重新分布冲突导致右侧空白）
                    thumbsWrap.style.transform = "";
                    this._syncThumbsFromCache(clip, thumbsWrap, newWidth);
                }
            }
            this._renderProps();
        };
        const up = () => {
            this._tlInHandleDrag = false;
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            // 恢复 z-index
            const clipEl = this._tlTrack.querySelector(`[data-clip-id="${clip.id}"]`);
            if (clipEl) clipEl.style.zIndex = "";
            // 裁剪手柄松开后，应用重叠裁剪（被拖动片段保持完整，被覆盖片段自动裁剪）
            this._applyClipOverlapTrim(clip);
            this._renderTimeline();
            this._saveTimelineSession();
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
    }

    // 桥接手柄：相邻片段交界处滚动裁剪
    // 往右拖：左片段 end += deltaTime，右片段 start += deltaTime, tlStart += deltaTime
    //   → 等同左片段右手柄往右拖（←|），同时右片段头部同步右移保持相邻
    // 往左拖：左片段 end += deltaTime（负值），右片段 start += deltaTime（负值），tlStart 同步
    //   → 等同右片段左手柄往左拖（|→），同时左片段尾部同步左移保持相邻
    _onBridgeHandleDown(e, leftClip, rightClip) {
        e.preventDefault();
        e.stopPropagation();
        this._pushHistory();  // 记录桥接裁剪前状态，支持 Ctrl+Z 撤销
        this._tlInHandleDrag = true;
        const startX = e.clientX;

        const leftStart0 = leftClip.start;
        const leftEnd0 = leftClip.end;
        const leftTlStart0 = leftClip.tlStart;
        const rightStart0 = rightClip.start;
        const rightEnd0 = rightClip.end;
        const rightTlStart0 = rightClip.tlStart;

        const leftMedia = this.mediaLibrary.find(m => m.name === leftClip.filename);
        const leftSourceDur = leftMedia?.info?.duration || leftClip.sourceDuration || Infinity;
        const rightMedia = this.mediaLibrary.find(m => m.name === rightClip.filename);
        const rightSourceDur = rightMedia?.info?.duration || rightClip.sourceDuration || Infinity;

        const minDuration = 0.1;
        const leftDur0 = leftEnd0 - leftStart0;
        const rightDur0 = rightEnd0 - rightStart0;

        const move = (ev) => {
            const pxPerSec = this._getPxPerSec();
            const dx = ev.clientX - startX;
            const deltaTime = dx / pxPerSec;

            // 右拖上限：min(左片段源出点剩余, 右片段最短保留)
            const maxDelta = Math.min(
                leftSourceDur === Infinity ? Infinity : leftSourceDur - leftEnd0,
                rightDur0 - minDuration
            );
            // 左拖下限：max(右片段源入点下限, 左片段最短保留)
            const minDelta = Math.max(
                -rightStart0,
                -(leftDur0 - minDuration)
            );
            const clampedDelta = Math.max(minDelta, Math.min(maxDelta, deltaTime));

            leftClip.end = leftEnd0 + clampedDelta;
            rightClip.start = rightStart0 + clampedDelta;
            rightClip.tlStart = rightTlStart0 + clampedDelta;
            leftClip.tlStart = leftTlStart0;

            // 同步更新两个片段 DOM（thumbsWrap 宽度同步 + 缓存同步缩略图，避免扩展区域空白）
            const leftEl = this._tlTrack.querySelector(`[data-clip-id="${leftClip.id}"]`);
            if (leftEl) {
                const newLeftDur = leftClip.end - leftClip.start;
                const newLeftWidth = Math.max(30, newLeftDur * pxPerSec);
                leftEl.style.width = `${newLeftWidth}px`;
                leftEl.style.zIndex = "100";
                const thumbsWrap = leftEl.querySelector(".xzg-ve-clip-thumbs");
                if (thumbsWrap) {
                    thumbsWrap.style.width = `${newLeftWidth}px`;
                    thumbsWrap.style.transform = "";
                    this._syncThumbsFromCache(leftClip, thumbsWrap, newLeftWidth);
                }
            }
            const rightEl = this._tlTrack.querySelector(`[data-clip-id="${rightClip.id}"]`);
            if (rightEl) {
                const newRightDur = rightClip.end - rightClip.start;
                const newRightWidth = Math.max(30, newRightDur * pxPerSec);
                const newRightX = rightClip.tlStart * pxPerSec;
                rightEl.style.width = `${newRightWidth}px`;
                rightEl.style.left = `${newRightX}px`;
                rightEl.style.zIndex = "100";
                const thumbsWrap = rightEl.querySelector(".xzg-ve-clip-thumbs");
                if (thumbsWrap) {
                    thumbsWrap.style.width = `${newRightWidth}px`;
                    // 移除 transform 偏移，由 _syncThumbsFromCache 统一更新缩略图（避免偏移与重新分布冲突导致右侧空白）
                    thumbsWrap.style.transform = "";
                    this._syncThumbsFromCache(rightClip, thumbsWrap, newRightWidth);
                }
            }
            this._renderProps();
        };
        const up = () => {
            this._tlInHandleDrag = false;
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            const leftEl = this._tlTrack.querySelector(`[data-clip-id="${leftClip.id}"]`);
            if (leftEl) leftEl.style.zIndex = "";
            const rightEl = this._tlTrack.querySelector(`[data-clip-id="${rightClip.id}"]`);
            if (rightEl) rightEl.style.zIndex = "";
            this._renderTimeline();
            this._saveTimelineSession();
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
    }

    // ═══════════════════════════════════════════════════════════
    //  预览与时间线播放
    // ═══════════════════════════════════════════════════════════

    _videoUrl(filename, type) {
        const params = new URLSearchParams({ filename, type: type || "input" });
        return `/view?${params.toString()}`;
    }

    // 时间线总时长（所有片段时长之和）
    _getTimelineTotalDuration() {
        // 返回时间轴的绝对末尾位置（最后一个片段的 tlEnd）
        // 基于 tlStart 计算，而非裁剪时长之和，确保裁剪头部时时间轴跨度不变（刻度/内容宽度稳定）
        // tlStart 为 null 时自动追加到上一片段末尾
        if (this.timeline.length === 0) return 0;
        let autoEnd = 0;
        let lastEnd = 0;
        for (const clip of this.timeline) {
            const dur = clip.end - clip.start;
            const ts = clip.tlStart != null ? clip.tlStart : autoEnd;
            lastEnd = ts + dur;
            autoEnd = lastEnd;
        }
        return lastEnd;
    }

    // 时间线内容区可视宽度（扣除左侧150px占位 + 右侧4px padding）
    _getViewWidth() {
        if (!this._timeline) return 800;
        const rect = this._timeline.getBoundingClientRect();
        return Math.max(100, rect.width - 4 - this._tlLeftPad);
    }
    // 时间线内容宽度 = 总时长 × 每秒像素数 + 右侧留白
    // 尾部留白 = 视口宽度，确保播放头在最后一个片段末尾时也能居中（右侧留出大量空间拖入媒体）
    _getContentWidth() {
        return this._getTimelineTotalDuration() * this._getPxPerSec() + this._getViewWidth();
    }
    // 每秒对应像素数 = 基础值 30 × 缩放倍数
    _getPxPerSec() {
        return 30 * this._tlZoom;
    }
    // 鼠标 X 坐标转时间轴秒数（用于拖放定位）
    // align: "left" → 鼠标对应片段左边缘（媒体库拖入）；"center" → 鼠标对应片段中心点（Alt+拖动复制）
    _clientXToTlStart(clientX, duration = 0, align = "left") {
        const trackRect = this._tlTrack.getBoundingClientRect();
        // track 已通过 CSS left:150px 偏移，trackRect.left 已是占位区之后的位置，无需再减 _tlLeftPad
        const xRelative = clientX - trackRect.left + this._tlScrollLeft;
        const pxPerSec = this._getPxPerSec();
        const mouseSec = Math.max(0, xRelative / pxPerSec);
        // align="center" 时鼠标对应片段中心 → tlStart = mouseSec - duration/2；align="left" 时鼠标对应片段左边缘 → tlStart = mouseSec
        return Math.max(0, align === "center" ? mouseSec - duration / 2 : mouseSec);
    }
    // 拖放预览：根据鼠标 X 显示半透明片段占位（位置与最终落入位置一致）
    // duration 可选：Alt+拖动复制片段时传入源片段实际时长，媒体库拖入时不传（从 mediaLibrary 查找）
    // align: "left"（默认，媒体库拖入，鼠标对应片段左边缘）或 "center"（Alt+拖动复制，鼠标对应片段中心点）
    _showDragPreview(clientX, duration, align = "left") {
        const pxPerSec = this._getPxPerSec();

        let dur = duration;
        if (dur == null) {
            // 获取拖放的媒体信息以计算预览宽度
            const name = this._dragPreviewName;
            dur = 5; // 默认预览时长 5s
            if (name) {
                const media = this.mediaLibrary.find(m => m.name === name);
                const md = media?.info?.duration;
                if (md && md > 0) dur = md;
            }
        }

        // 鼠标 X → 时间轴秒数（align 控制鼠标对应片段左边缘或中心点）
        const tlStart = this._clientXToTlStart(clientX, dur, align);
        const leftPx = tlStart * pxPerSec;
        const widthPx = Math.max(30, dur * pxPerSec);

        let preview = this._tlTrack.querySelector(".xzg-ve-clip-preview");
        if (!preview) {
            preview = document.createElement("div");
            preview.className = "xzg-ve-clip-preview";
            this._tlTrack.appendChild(preview);
        }
        preview.style.left = `${leftPx}px`;
        preview.style.width = `${widthPx}px`;
    }
    _hideDragPreview() {
        const preview = this._tlTrack.querySelector(".xzg-ve-clip-preview");
        if (preview) preview.remove();
        this._dragPreviewName = null;
        this._dragPreviewType = null;
    }
    // 限制 scrollLeft 在合法范围 [0, maxScroll]
    _clampScrollLeft() {
        const max = Math.max(0, this._getContentWidth() - this._getViewWidth());
        if (this._tlScrollLeft < 0) this._tlScrollLeft = 0;
        if (this._tlScrollLeft > max) this._tlScrollLeft = max;
    }
    // 应用横向滚动：同步刻度容器 transform + 片段容器 scrollLeft + 播放头位置
    _applyTlScroll() {
        if (this._tlTicks) {
            this._tlTicks.style.transform = `translateX(${-this._tlScrollLeft}px)`;
        }
        // 同步 track 的原生 scrollLeft，使片段随刻度同步滚动
        if (this._tlTrack) {
            this._tlTrack.scrollLeft = this._tlScrollLeft;
        }
        this._updatePlayhead();
    }
    // 播放时自动滚动：播放头接近可视区右边缘时向左滚动跟随
    _autoScrollToPlayhead() {
        const pxPerSec = this._getPxPerSec();
        const playheadX = this._tlGlobalTime * pxPerSec;
        const viewWidth = this._getViewWidth();
        const margin = 60; // 距右/左边缘多少 px 开始滚动
        // 判断播放头是否在最后一个片段：剩余时间轴长度 <= 当前片段剩余时长 → 最后一个片段
        // 最后一个片段时播放头居中滚动（留出右侧大量留白便于拖入媒体），否则贴右边缘滚动
        const isLastClip = (() => {
            const total = this._getTimelineTotalDuration();
            if (total <= 0) return true;
            // 当前播放片段的末尾位置
            const found = this._findClipByGlobalTime(this._tlGlobalTime);
            if (!found) return false;
            const clipTlEnd = (found.clip.tlStart ?? 0) + (found.clip.end - found.clip.start);
            return Math.abs(clipTlEnd - total) < 0.01;
        })();
        // 居中阈值：最后一个片段用 1/2（播放头跑到视图中间，右侧留白），
        //          非最后片段用 margin（贴右边缘滚动，最小滚动量）
        const rightThreshold = isLastClip ? viewWidth / 2 : viewWidth - margin;
        if (playheadX - this._tlScrollLeft > rightThreshold) {
            this._tlScrollLeft = playheadX - rightThreshold;
            this._clampScrollLeft();
            this._applyTlScroll();
        } else if (playheadX - this._tlScrollLeft < margin) {
            this._tlScrollLeft = Math.max(0, playheadX - margin);
            this._clampScrollLeft();
            this._applyTlScroll();
        }
    }

    // 根据全局时间找到对应的片段及片段内偏移
    // 返回 { clip, clipIndex, localTime } 或 null
    _findClipByGlobalTime(globalTime) {
        // 基于 tlStart 和片段时长查找，正确处理片段间空隙（空隙处返回 null → 黑屏）
        for (let i = 0; i < this.timeline.length; i++) {
            const clip = this.timeline[i];
            const dur = clip.end - clip.start;
            // E10: 跳过零时长片段（避免时间计算偏移）
            if (dur <= 0) continue;
            const clipStart = clip.tlStart ?? 0;
            const clipEnd = clipStart + dur;
            if (globalTime >= clipStart && globalTime < clipEnd) {
                return { clip, clipIndex: i, localTime: clip.start + (globalTime - clipStart) };
            }
        }
        return null;
    }

    // 计算片段在时间线上的全局起始偏移
    _getClipGlobalOffset(clipId) {
        let offset = 0;
        for (const c of this.timeline) {
            if (c.id === clipId) break;
            offset += (c.end - c.start);
        }
        return offset;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Canvas 解码架构：用 mediabunny 直接解码视频帧到 canvas
    // 核心优势：
    //   1. 精确按时间戳解码（无 keyframe 限制）
    //   2. 帧缓存命中零延迟 drawImage
    //   3. 最近帧降级显示（拖动永不卡顿）
    //   4. RAF 节流（mousemove 合并到每帧一次）
    // ═══════════════════════════════════════════════════════════════════════════

    // 加载遮罩：大视频首次加载时显示进度，期间禁用所有操作
    _showLoadingOverlay(filename) {
        if (!this._loadingOverlay) return;
        this._loadingText.textContent = `正在加载: ${filename}`;
        this._loadingBarFill.style.width = "0%";
        this._loadingPct.textContent = "0%";
        this._loadingSize.textContent = "0 MB / 0 MB";
        this._loadingOverlay.classList.add("xzg-ve-active");
    }
    _hideLoadingOverlay() {
        if (!this._loadingOverlay) return;
        this._loadingOverlay.classList.remove("xzg-ve-active");
    }
    _updateLoadingProgress(received, total) {
        if (!this._loadingOverlay || !this._loadingOverlay.classList.contains("xzg-ve-active")) return;
        const pct = total > 0 ? Math.min(100, (received / total) * 100) : 0;
        this._loadingBarFill.style.width = pct.toFixed(1) + "%";
        this._loadingPct.textContent = pct.toFixed(0) + "%";
        const recMb = (received / 1048576).toFixed(1);
        const totMb = (total / 1048576).toFixed(1);
        this._loadingSize.textContent = `${recMb} MB / ${totMb} MB`;
    }

    // 确保 mediabunny 库已加载 + WebCodecs 可用
    async _ensureDecoderReady() {
        await _ensureMediabunny();
        if (typeof VideoDecoder === 'undefined') {
            throw new Error("当前浏览器不支持 WebCodecs，请使用 Chrome 94+/Edge 94+/Safari 16.4+");
        }
    }

    // 加载片段到 canvas 并定位到 localTime
    // 切换片段时切换解码器实例（decoderPool 缓存复用）
    // E1/E4: 添加竞态 guard + 停止旧播放循环/音频 + 切换片段时清空音频 buffer
    async _loadClipAtTime(clip, localTime, autoplay) {
        // E4: 竞态 guard —— 用 clipId 标记当前目标
        this._loadClipToken = (this._loadClipToken || 0) + 1;
        const token = this._loadClipToken;
        // E1: 先停止旧的播放循环和音频（避免 await 期间旧循环继续更新 _tlGlobalTime）
        this._stopPlaybackLoop();
        this._stopAudioSource();
        // E3: 切换片段时清空旧音频 buffer（不同片段音频不同）
        if (this._currentClip && this._currentClip.id !== clip.id) {
            this._fullAudioBuffer = null;
        }
        this._currentClip = clip;
        this._canvas.classList.add("xzg-ve-active");
        this._previewEmpty.classList.add("xzg-ve-hidden");

        try {
            await this._ensureDecoderReady();
            // E4: 校验 token
            if (token !== this._loadClipToken) return;
            // 获取或创建该视频的解码器（池化复用，避免重复加载）
            const url = this._videoUrl(clip.filename, clip.type);
            // 首次加载（缓存未命中）：不显示进度遮罩，后台静默加载
            // （上传时已预生成缩略图，拖到时间线时无需额外进度提示）
            const isCached = decoderPool.getCached(clip.filename, clip.type);
            this._hideLoadingOverlay();
            // 从 probe 结果获取文件大小（避免 /view 无 Content-Length 头时进度不准）
            const media = this.mediaLibrary.find(m => m.name === clip.filename && m.type === clip.type);
            const knownTotal = media?.info?.file_size || 0;
            const decoder = await decoderPool.get(clip.filename, clip.type, url, (received, total) => {
                if (token === this._loadClipToken) {
                    this._updateLoadingProgress(received, total);
                }
            }, knownTotal);
            if (token !== this._loadClipToken) {
                // 被后续加载抢占：不隐藏遮罩（新加载会接管）
                return;
            }
            this._currentDecoder = decoder;
            // 加载完成隐藏遮罩
            if (!isCached) {
                this._hideLoadingOverlay();
            }

            // E7: 同步 canvas 内部分辨率，避免 drawImage 拉伸模糊
            const cw = decoder.previewWidth || decoder.width;
            const ch = decoder.previewHeight || decoder.height;
            if (cw && ch && (this._canvas.width !== cw || this._canvas.height !== ch)) {
                this._canvas.width = cw;
                this._canvas.height = ch;
            }

            // 计算目标帧号
            const fps = decoder.fps || 30;
            const targetFrame = Math.max(0, Math.min(
                Math.round(localTime * fps),
                Math.max(0, decoder.frameCount - 1)
            ));

            // 渲染目标帧到 canvas（带缓存 + 最近帧降级）
            await decoder.renderFrame(targetFrame, this._canvas, true);
            if (token !== this._loadClipToken) return;

            // 若在播放，启动播放循环 + 音频
            if (autoplay && this._tlPlaying) {
                this._startPlaybackLoop();
                this._startAudioPlayback();
            }
            this._updatePlayBtn(this._tlPlaying);
        } catch (e) {
            // 加载失败也要隐藏遮罩
            this._hideLoadingOverlay();
            if (token !== this._loadClipToken) return;
            console.error("[xzg-ve] 加载片段失败:", clip.filename, e.message);
            this._setStatus(`加载失败: ${e.message}`);
        }
    }

    // 加载片段到预览区（仅在添加片段到空时间线时调用，用于首次显示画面）
    _loadClipToPreview(clip) {
        if (!clip) return;
        const offset = this._getClipGlobalOffset(clip.id);
        this._tlGlobalTime = offset;
        this._seekToGlobalTime(offset);
    }

    // 跳转到全局时间（拖动播放头或点击轨道时调用）
    // 用 RAF 节流 + 最近帧降级，实现极致跟手性
    _seekToGlobalTime(globalTime) {
        const total = this._getTimelineTotalDuration();
        if (total <= 0) return;
        this._tlGlobalTime = Math.max(0, Math.min(globalTime, total));
        this._updatePlayhead();
        this._updateTimeDisplay();

        const found = this._findClipByGlobalTime(this._tlGlobalTime);
        if (!found) {
            // 空隙处：清空 canvas 显示黑屏，停止当前解码与音频
            this._clearCanvasForGap();
            return;
        }

        // 同一片段：直接解码目标帧（不重新加载解码器，避免闪烁）
        if (this._currentClip && this._currentClip.id === found.clip.id && this._currentDecoder) {
            const fps = this._currentDecoder.fps || 30;
            const targetFrame = Math.max(0, Math.min(
                Math.round(found.localTime * fps),
                Math.max(0, this._currentDecoder.frameCount - 1)
            ));
            // renderFrame 内部带缓存 + 最近帧降级 + RAF 节流
            this._currentDecoder.renderFrame(targetFrame, this._canvas, true);
            return;
        }
        // 切换片段：异步加载新解码器
        this._loadClipAtTime(found.clip, found.localTime, this._tlPlaying);
    }

    // 拖动播放头时的 RAF 节流（合并 mousemove 到每帧一次）
    _scheduleScrubSeek(globalTime) {
        this._tlGlobalTime = Math.max(0, Math.min(globalTime, this._getTimelineTotalDuration()));
        this._updatePlayhead();
        this._updateTimeDisplay();
        if (this._scrubRafId) return;
        this._scrubRafId = requestAnimationFrame(() => {
            this._scrubRafId = null;
            // 延迟读取 _tlGlobalTime，确保用最新值
            const gt = this._tlGlobalTime;
            const found = this._findClipByGlobalTime(gt);
            if (!found) return;
            // 切换片段或同片段 seek
            if (this._currentClip && this._currentClip.id === found.clip.id && this._currentDecoder) {
                const fps = this._currentDecoder.fps || 30;
                const targetFrame = Math.max(0, Math.min(
                    Math.round(found.localTime * fps),
                    Math.max(0, this._currentDecoder.frameCount - 1)
                ));
                this._currentDecoder.renderFrame(targetFrame, this._canvas, true);
            } else {
                this._loadClipAtTime(found.clip, found.localTime, false);
            }
        });
    }

    // 切换播放/暂停
    _toggleTimelinePlay() {
        if (this.timeline.length === 0) return;
        const total = this._getTimelineTotalDuration();
        // 播放到末尾时从头开始
        if (this._tlGlobalTime >= total - 0.05) {
            this._tlGlobalTime = 0;
        }
        this._tlPlaying = !this._tlPlaying;
        if (this._tlPlaying) {
            this._updatePlayBtn(true);
            // 先查找当前位置的片段，空隙处需启动空隙等待逻辑
            const found = this._findClipByGlobalTime(this._tlGlobalTime);
            if (found) {
                // 同一片段且解码器已就绪：直接启动播放循环
                if (this._currentClip && this._currentClip.id === found.clip.id && this._currentDecoder) {
                    this._startPlaybackLoop();
                    this._startAudioPlayback();
                } else {
                    // 切换到目标片段，加载完成后启动播放（_loadClipAtTime 内部启动播放循环）
                    this._loadClipAtTime(found.clip, found.localTime, true);
                }
            } else {
                // 空隙处：找下一个片段，启动空隙等待
                const candidates = this.timeline
                    .map(c => ({ clip: c, tlStart: c.tlStart ?? 0, dur: c.end - c.start }))
                    .filter(x => x.dur > 0 && x.tlStart > this._tlGlobalTime - 0.001)
                    .sort((a, b) => a.tlStart - b.tlStart);
                if (candidates.length > 0) {
                    this._clearCanvasForGap();
                    this._scheduleGapAdvance(candidates[0].tlStart, candidates[0].clip);
                } else {
                    // 末尾无后续片段：停止播放
                    this._tlPlaying = false;
                    this._updatePlayBtn(false);
                }
            }
        } else {
            this._updatePlayBtn(false);
            this._stopPlaybackLoop();
            this._stopAudio();
        }
    }

    // rAF 驱动的播放循环：用播放迭代器 + 预缓冲队列
    // E6/E8/E11: 闭包用捕获的 clip.id 做存活检查 + 限制追赶帧数 + 边界保护
    _startPlaybackLoop() {
        this._stopPlaybackLoop();
        if (!this._currentClip || !this._currentDecoder) return;

        const clip = this._currentClip;
        const decoder = this._currentDecoder;
        const clipId = clip.id;  // E6: 闭包捕获 clipId 用于存活检查
        const fps = decoder.fps || 30;
        // 基于 tlStart 计算片段全局偏移（正确处理空隙）
        const offset = clip.tlStart ?? 0;
        const startLocalTime = clip.start + (this._tlGlobalTime - offset);
        // E11: 边界保护 —— 起始位置超过片段末尾时 clamp
        const clampedStart = Math.min(startLocalTime, clip.end - 0.001);
        const startFrame = Math.max(0, Math.round(clampedStart * fps));

        // 创建播放迭代器（从当前位置顺序解码）
        this._playbackIterator = decoder.createPlaybackIterator(clampedStart);
        this._playbackIteratorDone = false;
        this._playbackBuffer = [];
        this._playbackStartFrame = startFrame;
        this._playbackStartTime = performance.now();
        this._isBuffering = false;

        // 启动预缓冲
        this._fillPlaybackBuffer();

        const frameDuration = 1000 / fps;
        let lastFrame = startFrame;
        let lastRafTime = performance.now();

        const loop = () => {
            // E6: 用捕获的 clipId 检查，切换片段后旧循环自动停止
            if (!this._tlPlaying || !this._currentClip || this._currentClip.id !== clipId) {
                this._playbackRaf = 0;
                return;
            }
            const now = performance.now();
            // E8: 后台标签恢复时 RAF 间隔过大，重置计时避免快进追赶
            const rafDelta = now - lastRafTime;
            lastRafTime = now;
            if (rafDelta > 500) {
                this._playbackStartTime = now - (lastFrame - this._playbackStartFrame) * frameDuration;
            }
            const elapsedMs = now - this._playbackStartTime;
            const expectedFrame = this._playbackStartFrame + Math.floor(elapsedMs / frameDuration);
            // E8: 限制单次追赶帧数，避免卡顿后画面跳跃
            const framesToAdvance = Math.min(expectedFrame - lastFrame, 5);

            if (framesToAdvance > 0) {
                for (let i = 0; i < framesToAdvance; i++) {
                    if (this._playbackBuffer.length > 0) {
                        const frame = this._playbackBuffer.shift();
                        // 绘制到 canvas
                        const ctx = this._canvas.getContext('2d');
                        ctx.drawImage(frame.canvas, 0, 0, decoder.previewWidth || decoder.width, decoder.previewHeight || decoder.height);
                        // 更新全局时间
                        this._tlGlobalTime = offset + (frame.timestamp - clip.start);
                        lastFrame++;
                        this._updatePlayhead();
                        this._updateTimeDisplay();
                        this._autoScrollToPlayhead();
                        // 持续预缓冲
                        this._fillPlaybackBuffer();
                    } else {
                        break;
                    }
                }
            }
            // 超出片段出点 → 切换下一个片段
            const localTime = clip.start + (this._tlGlobalTime - offset);
            if (localTime >= clip.end) {
                this._advanceToNextClip();
                this._playbackRaf = 0;
                return;
            }
            // 缓冲区为空且迭代器已结束（无更多帧可解码）→ 强制推进到片段末尾，触发下一个片段切换
            // 避免最后一帧 timestamp < clip.end 导致播放循环卡住无法继续
            if (this._playbackBuffer.length === 0 && this._playbackIteratorDone) {
                this._tlGlobalTime = offset + (clip.end - clip.start);
                this._updatePlayhead();
                this._updateTimeDisplay();
                this._advanceToNextClip();
                this._playbackRaf = 0;
                return;
            }
            this._playbackRaf = requestAnimationFrame(loop);
        };
        this._playbackRaf = requestAnimationFrame(loop);
    }

    // 预缓冲：异步解码若干帧到队列
    async _fillPlaybackBuffer() {
        if (this._isBuffering || !this._tlPlaying) return;
        if (!this._playbackIterator) return;
        this._isBuffering = true;
        try {
            while (this._playbackBuffer.length < this._playbackBufferSize && this._tlPlaying) {
                const result = await this._playbackIterator.next();
                if (result.done) { this._playbackIteratorDone = true; break; }
                const wc = result.value;
                if (wc && wc.canvas) {
                    // 复制 canvas（避免 mediabunny 内部回收）
                    const copy = document.createElement('canvas');
                    copy.width = wc.canvas.width;
                    copy.height = wc.canvas.height;
                    copy.getContext('2d').drawImage(wc.canvas, 0, 0);
                    this._playbackBuffer.push({ canvas: copy, timestamp: wc.timestamp });
                }
            }
        } catch (e) {
            console.error("[xzg-ve] 预缓冲失败:", e);
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
    }

    // 当前片段播放完毕，切换到下一个片段
    // E2: 停止旧音频 + 新片段音频由 _loadClipAtTime 内部启动
    _advanceToNextClip() {
        if (!this._currentClip) return;
        const clipDur = this._currentClip.end - this._currentClip.start;
        const curTlStart = this._currentClip.tlStart ?? 0;
        this._tlGlobalTime = curTlStart + clipDur;
        if (!this._tlPlaying) return;

        // 按 tlStart 排序找到时间顺序上的下一个片段（拖放后数组顺序可能不按时间排列）
        const curTlEnd = this._tlGlobalTime;
        const candidates = this.timeline
            .filter(c => c.id !== this._currentClip.id)
            .map(c => ({ clip: c, tlStart: c.tlStart ?? 0, dur: c.end - c.start }))
            .filter(x => x.dur > 0 && x.tlStart + x.dur > curTlEnd - 0.001)
            .sort((a, b) => a.tlStart - b.tlStart);

        if (candidates.length > 0) {
            const next = candidates[0].clip;
            const nextTlStart = next.tlStart ?? 0;
            // 空隙处理：若下一个片段的 tlStart 大于当前全局时间，先进入空隙黑屏等待
            if (nextTlStart > this._tlGlobalTime + 0.001) {
                this._clearCanvasForGap();
                this._scheduleGapAdvance(nextTlStart, next);
            } else {
                this._updatePlayhead();
                this._updateTimeDisplay();
                this._loadClipAtTime(next, next.start, true);
            }
        } else {
            // 末尾 → 停止
            this._tlPlaying = false;
            this._updatePlayBtn(false);
            this._stopPlaybackLoop();
            this._stopAudio();
            this._tlGlobalTime = this._getTimelineTotalDuration();
            this._updatePlayhead();
            this._updateTimeDisplay();
        }
    }
    // 空隙期间黑屏等待，到达下一个片段起始时间后加载该片段
    _scheduleGapAdvance(targetTlStart, nextClip) {
        let lastTime = performance.now();
        const check = () => {
            if (!this._tlPlaying) return;
            const now = performance.now();
            const dt = (now - lastTime) / 1000;
            lastTime = now;
            // 空隙期间正常推进全局时间（播放循环已停止，需要手动推进）
            this._tlGlobalTime = Math.min(targetTlStart, this._tlGlobalTime + dt);
            if (this._tlGlobalTime >= targetTlStart - 0.001) {
                this._tlGlobalTime = targetTlStart;
                this._loadClipAtTime(nextClip, nextClip.start, true);
                return;
            }
            this._updatePlayhead();
            this._updateTimeDisplay();
            this._autoScrollToPlayhead();
            requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
    }
    // 空隙处：清空 canvas 显示黑屏，停止当前解码与音频
    _clearCanvasForGap() {
        this._stopPlaybackLoop();
        this._stopAudio();
        if (this._canvas) {
            const ctx = this._canvas.getContext("2d");
            if (ctx) {
                ctx.fillStyle = "#000";
                ctx.fillRect(0, 0, this._canvas.width, this._canvas.height);
            }
        }
        this._currentClip = null;
        this._currentDecoder = null;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 音频播放（基于 AudioContext + AudioBufferSink）
    // ═══════════════════════════════════════════════════════════════════════════
    _ensureAudioContext() {
        if (!this._audioCtx) {
            this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            this._audioGain = this._audioCtx.createGain();
            this._audioGain.connect(this._audioCtx.destination);
        }
        if (this._audioCtx.state === 'suspended') this._audioCtx.resume();
    }

    async _startAudioPlayback() {
        if (!this._currentDecoder || !this._currentDecoder.hasAudio) return;
        this._ensureAudioContext();
        // 首次播放时解码完整音频缓冲
        if (!this._fullAudioBuffer) {
            this._fullAudioBuffer = await this._currentDecoder.decodeFullAudio();
        }
        if (!this._fullAudioBuffer) return;
        const clip = this._currentClip;
        const offset = this._getClipGlobalOffset(clip.id);
        const localTime = clip.start + (this._tlGlobalTime - offset);
        this._stopAudioSource();
        try {
            this._audioSource = this._audioCtx.createBufferSource();
            this._audioSource.buffer = this._fullAudioBuffer;
            this._audioSource.connect(this._audioGain);
            this._audioSource.start(0, localTime);
            this._audioPlayStartOffset = localTime;
            this._audioPlayStartTime = this._audioCtx.currentTime;
        } catch (e) {
            console.warn("[xzg-ve] 音频播放失败:", e);
        }
    }

    _stopAudioSource() {
        if (this._audioSource) {
            try { this._audioSource.stop(); } catch (_) {}
            this._audioSource = null;
        }
    }

    _stopAudio() {
        this._stopAudioSource();
        this._fullAudioBuffer = null;  // 切换片段时清空，下次重新解码
    }

    _updatePlayhead() {
        const total = this._getTimelineTotalDuration();
        if (total > 0) {
            const pxPerSec = this._getPxPerSec();
            // 播放头位置 = 左侧占位 + 时间×pxPerSec - 滚动偏移
            let x = this._tlLeftPad + this._tlGlobalTime * pxPerSec - this._tlScrollLeft;
            // 限制播放头在时间线可视内容区域内，不跑出右侧
            // 右边界 = 左侧占位 + 内容宽度（总时长×pxPerSec）
            const maxX = this._tlLeftPad + total * pxPerSec - this._tlScrollLeft;
            x = Math.min(x, maxX);
            // 左边界不小于左侧占位区
            x = Math.max(x, this._tlLeftPad - this._tlScrollLeft);
            this._playhead.style.left = x + "px";
            this._playhead.classList.add("xzg-ve-active");
        } else {
            this._playhead.classList.remove("xzg-ve-active");
        }
    }

    _updatePlayBtn(playing) {
        const btn = this._root?.querySelector(".xzg-ve-play-btn");
        if (btn) {
            btn.textContent = "";
            btn.classList.toggle("xzg-ve-playing", !!playing);
        }
    }

    _updateTimeDisplay() {
        const total = this._getTimelineTotalDuration();
        this._timeLabel.textContent = `${_fmtTime(this._tlGlobalTime)} / ${_fmtTime(total)}`;
        // 帧数 = 时间 × fps（取当前片段帧率，无则用 30）
        const fps = this._currentClip ? this._getClipFps(this._currentClip) : 30;
        // 总帧数：后端 probe 已用 frame_count 反算精确 duration，故 round(total * fps) 无浮点误差
        const totalFrames = Math.max(1, Math.round(total * fps));
        // 帧号 0-based：最左侧=0，最右侧=totalFrames
        // 用 round 而非 floor：使最右侧（globalTime≈total）精确显示 totalFrames
        const curFrame = Math.max(0, Math.min(totalFrames, Math.round(this._tlGlobalTime * fps)));
        if (this._framesLabel) {
            this._framesLabel.textContent = `${curFrame} / ${totalFrames} 帧`;
        }
    }

    // 获取片段帧率：始终使用原视频帧率（与节点参数完全解耦）
    _getClipFps(clip) {
        const media = this.mediaLibrary.find(m => m.name === clip.filename && m.type === clip.type);
        return media?.info?.fps || 30;
    }

    // 鼠标 X 坐标 → 全局时间（考虑左侧占位、缩放和横向滚动）
    _mouseXToGlobalTime(e) {
        const total = this._getTimelineTotalDuration();
        if (total <= 0) return null;
        const pxPerSec = this._getPxPerSec();
        if (pxPerSec <= 0) return null;
        const rect = this._timeline.getBoundingClientRect();
        // 内容区起点 = timeline左 + 左侧占位（刻度0与左侧分界线对齐）
        const contentLeft = rect.left + this._tlLeftPad;
        // 鼠标在内容中的位置 = 可见位置 + 滚动偏移
        const x = e.clientX - contentLeft + this._tlScrollLeft;
        const t = x / pxPerSec;
        return Math.max(0, Math.min(total, t));
    }

    // 播放头拖动（Canvas 架构：用 _scheduleScrubSeek 节流 + 最近帧降级）
    // E9: 拖动期间停止音频，松开后重启
    // 限制：仅当点击落在上方刻度线区域（.xzg-ve-tl-scrub）时才允许拖动
    _onPlayheadDown(e) {
        // 先判断点击位置是否在刻度线区域内，不在则不响应（也不阻止冒泡，让片段点击等逻辑正常进行）
        const scrubRect = this._tlScrub.getBoundingClientRect();
        if (e.clientX < scrubRect.left || e.clientX > scrubRect.right ||
            e.clientY < scrubRect.top || e.clientY > scrubRect.bottom) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        this._playheadDrag = true;
        const wasPlaying = this._tlPlaying;
        if (wasPlaying) {
            this._stopPlaybackLoop();
            this._stopAudioSource();
        }
        const prevBodyCursor = document.body.style.cursor;
        document.body.style.cursor = "ew-resize";
        const move = (ev) => {
            const gt = this._mouseXToGlobalTime(ev);
            if (gt == null) return;
            this._scheduleScrubSeek(gt);
        };
        const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            this._playheadDrag = false;
            document.body.style.cursor = prevBodyCursor;
            if (wasPlaying) {
                this._tlPlaying = true;
                this._updatePlayBtn(true);
                this._startPlaybackLoop();
                this._startAudioPlayback();
            }
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
    }

    // 上方 1/4 拖动区：点击立即跳转 + 按住拖动跟随
    // E9: 拖动期间停止音频
    _onScrubDown(e) {
        e.preventDefault();
        e.stopPropagation();
        const gt0 = this._mouseXToGlobalTime(e);
        if (gt0 == null) return;
        this._seekToGlobalTime(gt0);
        this._playheadDrag = true;
        const wasPlaying = this._tlPlaying;
        if (wasPlaying) {
            this._stopPlaybackLoop();
            this._stopAudioSource();
        }
        const prevBodyCursor = document.body.style.cursor;
        document.body.style.cursor = "ew-resize";
        this._tlScrub.classList.add("xzg-ve-scrubbing");
        const move = (ev) => {
            const gt = this._mouseXToGlobalTime(ev);
            if (gt == null) return;
            this._scheduleScrubSeek(gt);
        };
        const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            this._playheadDrag = false;
            document.body.style.cursor = prevBodyCursor;
            this._tlScrub.classList.remove("xzg-ve-scrubbing");
            if (wasPlaying) {
                this._tlPlaying = true;
                this._updatePlayBtn(true);
                this._startPlaybackLoop();
                this._startAudioPlayback();
            }
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
    }

    // ═══════════════════════════════════════════════════════════
    // 仅更新片段选中态 class（不重建 DOM，避免缩略图重新加载闪烁）
    _updateClipSelection() {
        if (!this._tlTrack) return;
        for (const el of this._tlTrack.querySelectorAll(".xzg-ve-clip")) {
            const id = parseInt(el.dataset.clipId);
            if (this.selectedClipIds.has(id)) {
                el.classList.add("xzg-ve-selected");
            } else {
                el.classList.remove("xzg-ve-selected");
            }
        }
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
    }

    // ═══════════════════════════════════════════════════════════
    //  导出
    // ═══════════════════════════════════════════════════════════
    async _exportFrame() {
        if (!this._currentDecoder || !this._currentClip) {
            this._setStatus("无视频播放");
            return;
        }
        // E5: 全局时间 → 片段本地时间（后端需要源视频内的时间戳）
        const offset = this._getClipGlobalOffset(this._currentClip.id);
        const localTime = this._currentClip.start + (this._tlGlobalTime - offset);
        const t = Math.max(0, localTime);
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

    // 用首个片段的原分辨率填充宽高输入框（首个片段加入时间线时调用）
    _syncResFromFirstClip() {
        if (this.timeline.length === 0) return;
        const first = this.mediaLibrary.find(m => m.name === this.timeline[0].filename);
        if (!first || !first.info) return;
        const w = first.info.width;
        const h = first.info.height;
        if (w > 0 && h > 0) {
            const wInput = this._root.querySelector(".xzg-ve-render-w");
            const hInput = this._root.querySelector(".xzg-ve-render-h");
            const presetsSel = this._root.querySelector(".xzg-ve-render-presets");
            const portraitBtn = this._root.querySelector(".xzg-ve-btn-portrait");
            if (wInput) { wInput.value = w; wInput.disabled = false; }
            if (hInput) { hInput.value = h; hInput.disabled = false; }
            if (presetsSel) { presetsSel.value = "0"; presetsSel.disabled = false; }
            if (portraitBtn) portraitBtn.disabled = false;
        }
    }

    // 无片段时禁用所有分辨率控件并显示 --
    _disableRenderOpts() {
        const wInput = this._root.querySelector(".xzg-ve-render-w");
        const hInput = this._root.querySelector(".xzg-ve-render-h");
        const presetsSel = this._root.querySelector(".xzg-ve-render-presets");
        const portraitBtn = this._root.querySelector(".xzg-ve-btn-portrait");
        if (wInput) { wInput.value = ""; wInput.disabled = true; }
        if (hInput) { hInput.value = ""; hInput.disabled = true; }
        if (presetsSel) { presetsSel.value = "0"; presetsSel.disabled = true; }
        if (portraitBtn) portraitBtn.disabled = true;
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
        // 渲染参数：帧率始终用原视频（后端默认取首个片段帧率）
        // 分辨率：读取宽/高输入框，0 表示用首个片段原分辨率
        const renderOpts = { timeline: tlData };
        const wInput = this._root.querySelector(".xzg-ve-render-w");
        const hInput = this._root.querySelector(".xzg-ve-render-h");
        const tw = Math.max(0, Math.round(Number(wInput?.value || 0)));
        const th = Math.max(0, Math.round(Number(hInput?.value || 0)));
        if (tw > 0 && th > 0) {
            renderOpts.target_width = tw;
            renderOpts.target_height = th;
        }
        try {
            const data = await _postJson(API_RENDER, renderOpts);
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

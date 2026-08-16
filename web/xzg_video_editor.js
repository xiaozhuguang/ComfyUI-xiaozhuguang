/**
 * 小珠光 · 快剪 — 独立视频编辑器
 * 多视频版 — 支持加载多个视频、拖拽到时间线、调整入出点、拼接导出
 * 完全独立于加载器节点，通过菜单栏「快剪」按钮打开，渲染产物保存到 input/ 或 output/
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
 *   │  Footer (状态 + 取消/导出)                     │
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

// 从 localStorage 安全读取 JSON（解析失败返回默认值）
function _xzgVeLoadJson(key, defaultValue) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return defaultValue;
        const v = JSON.parse(raw);
        return (v !== null && v !== undefined) ? v : defaultValue;
    } catch (_) {
        return defaultValue;
    }
}

// 独立媒体库列表（localStorage）：编辑器完全独立，不再依赖节点 ID
// - 跨浏览器刷新/ComfyUI 重启持久保留，用户可随时继续编辑
// - 文件被删除时 probe 会优雅失败，不影响其他媒体
const _XZG_VE_MEDIA_KEY = "xzg_ve_media_list";

function _xzgVeGetSessionMedia() {
    try {
        const raw = localStorage.getItem(_XZG_VE_MEDIA_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch (_) { return []; }
}

function _xzgVeSaveSessionMedia(list) {
    try { localStorage.setItem(_XZG_VE_MEDIA_KEY, JSON.stringify(list)); } catch (_) {}
}

function _xzgVeAddSessionMedia(name, type, fp) {
    const list = _xzgVeGetSessionMedia();
    if (!list.find(m => m.name === name && m.type === type)) {
        list.push({ name, type, fp: fp || "" });
        _xzgVeSaveSessionMedia(list);
    }
}

function _xzgVeRemoveSessionMedia(name) {
    const list = _xzgVeGetSessionMedia().filter(m => m.name !== name);
    _xzgVeSaveSessionMedia(list);
}

// 时间线持久化（localStorage）：编辑器独立后跨会话保留编辑状态
const _XZG_VE_TL_KEY = "xzg_ve_timeline";
function _xzgVeGetSessionTimeline() {
    try {
        const raw = localStorage.getItem(_XZG_VE_TL_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch (_) { return []; }
}
function _xzgVeSaveSessionTimeline(timeline) {
    try {
        const data = timeline.map(c => ({
            filename: c.filename, type: c.type, name: c.name,
            start: c.start, end: c.end,
            sourceDuration: c.sourceDuration, durationPending: c.durationPending,
            borderColor: c.borderColor || "",
            tlStart: c.tlStart != null ? c.tlStart : -1,
            audioTlStart: c.audioTlStart != null ? c.audioTlStart : -1,
            kind: c.kind || "video",
            skip_audio: c.skip_audio === true ? true : undefined,
            pairedWith: c.pairedWith != null ? c.pairedWith : undefined,
        }));
        localStorage.setItem(_XZG_VE_TL_KEY, JSON.stringify(data));
    } catch (_) {}
}
function _xzgVeClearSessionTimeline() {
    try { localStorage.removeItem(_XZG_VE_TL_KEY); } catch (_) {}
}

// 时间线布局不持久化：刷新/重启后恢复默认布局

const VIDEO_EXTS = ["webm", "mp4", "mkv", "gif", "mov", "avi", "flv", "wmv", "m4v", "mpg", "mpeg", "ts"];
const AUDIO_EXTS = ["mp3", "wav", "aac", "ogg", "flac", "m4a", "opus", "wma", "aiff", "aif"];
const IMAGE_EXTS = ["jpg", "jpeg", "png", "bmp", "webp", "tiff", "tif"];

function _isVideo(name) {
    const ext = name.split(".").pop()?.toLowerCase();
    return VIDEO_EXTS.includes(ext);
}

function _isAudio(name) {
    const ext = name.split(".").pop()?.toLowerCase();
    return AUDIO_EXTS.includes(ext);
}

function _isImage(name) {
    const ext = name.split(".").pop()?.toLowerCase();
    return IMAGE_EXTS.includes(ext);
}

// 是否为视频、音频或图片（用于上传接受过滤）
function _isMedia(name) {
    return _isVideo(name) || _isAudio(name) || _isImage(name);
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
    constructor() {
        // 编辑器完全独立：不再接收节点参数（filename/type/nodeId/onApplied/onCancel）
        // _renderTargetW/H: 渲染目标分辨率（null=用首个片段原分辨率）
        this._renderTargetW = null;
        this._renderTargetH = null;
        // 输出目录设置（与小珠光图像保存-化神级完全一致）
        // useDefaultOutput=true → ComfyUI output 目录，前缀固定 xzg-edit
        // useDefaultOutput=false → 自定义目录 base_dir + 前缀/日期戳/时间戳
        this._xzgVeOutputKey = "xzg_ve_output_settings";
        const savedOutput = _xzgVeLoadJson(this._xzgVeOutputKey, {});
        this._useDefaultOutput = savedOutput.use_default_output !== false;  // 默认 true
        this._baseDir = savedOutput.base_dir || "";
        this._filenamePrefix = savedOutput.filename_prefix || "xzg-edit";
        this._addDateStamp = !!savedOutput.add_date_stamp;
        this._addTimeStamp = !!savedOutput.add_time_stamp;

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
        this._audioBufferCache = new Map();  // key: "filename|type" -> AudioBuffer（波形共享缓存）
        this._audioPlayStartOffset = 0;
        this._audioPlayStartTime = 0;
        this._playingAudioClipId = null;  // 当前 _fullAudioBuffer 对应的音频 clip ID
        this.selectedMediaNames = new Set();  // 媒体库多选集合
        this._mediaSelBox = null;  // 媒体库框选矩形
        // 离线媒体集合：磁盘上不存在的媒体文件名（手工删除或被清理）
        this.offlineMediaNames = new Set();
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
        // 时间线面板高度（刷新/重启后恢复默认值，不持久化）
        this._tlHeightKey = "xzg_ve_tl_height";
        this._tlHeight = 280;
        this._tlPanel = null;
        this._tlResizer = null;
        this._tlVideoHeader = null;       // 视频轨道头
        this._tlAudioHeader = null;       // 音频轨道头
        this._tlResizerTop = null;        // 上手柄（调整视频高度）
        this._tlResizerMid = null;        // 中手柄（调整视频/音频分配比例）
        this._tlResizerBottom = null;     // 下手柄（调整音频高度）
        this._tlVideoHeight = 80;         // 视频头/轨道高度
        this._tlAudioHeight = 70;         // 音频头/轨道高度
        this._tlVideoTopOffset = 0;      // 视频顶部偏移（相对 35px 刻度区域底部，向下为正）
        this._tlHeightsCustomized = false; // 是否已通过手柄自定义高度（false=默认居中）
        // 刷新/重启后恢复默认布局（不恢复 sessionStorage）
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
        // 屏蔽 Alt 键激活浏览器菜单（Alt+滚轮缩放时间线时按 Alt 会触发 Edge 菜单）
        this._altKeyHandler = (e) => {
            if (e.key === "Alt") {
                e.preventDefault();
                e.stopImmediatePropagation();
            }
        };
        window.addEventListener("keydown", this._altKeyHandler, true);
        // 窗口大小变化时重绘时间刻度
        this._resizeHandler = () => { this._applyTrackLayout(); this._renderTimeline(); };
        window.addEventListener("resize", this._resizeHandler);
        // 缩略图和媒体文件已持久化到 fastcut-cache 目录，不再在打开时自动清理
        // 改为前端"一键清理缓存"按钮手动触发（/xzg_video_editor_clear_cache）
        this._loadMediaLibrary();
        // 自动检测离线媒体：页面重新可见 / 窗口获得焦点 / 定时轮询
        // 覆盖场景：用户在文件管理器中删除了缓存文件后切回浏览器
        this._autoCheckOffline = async () => {
            if (this._destroyed) return;
            if (document.visibilityState === "hidden") return;
            // 防抖：距离上次检测超过 5 秒才重新检测
            const now = Date.now();
            if (this._lastOfflineCheck && now - this._lastOfflineCheck < 5000) return;
            this._lastOfflineCheck = now;
            const oldOffline = new Set(this.offlineMediaNames);
            await this._checkOfflineMedia();
            // 只有离线状态变化时才刷新 UI（避免不必要的渲染）
            if (oldOffline.size !== this.offlineMediaNames.size ||
                [...this.offlineMediaNames].some(n => !oldOffline.has(n))) {
                this._renderMediaList();
                this._renderTimeline();
            }
        };
        // visibilitychange：切换浏览器标签页回来时触发
        document.addEventListener("visibilitychange", this._autoCheckOffline);
        // focus：从其他应用（如文件管理器）切回浏览器窗口时触发
        // visibilitychange 不会在此场景触发（标签页从未隐藏，只是失去焦点）
        window.addEventListener("focus", this._autoCheckOffline);
        // 定时轮询：捕获编辑器保持焦点时发生的文件删除（如终端命令、其他进程）
        // 单次检测开销 ~30ms（本地 syscall + 1 个 HTTP），15s 间隔几乎无性能压力
        this._offlinePollTimer = setInterval(() => {
            if (!this._destroyed && document.visibilityState === "visible") {
                this._autoCheckOffline();
            }
        }, 15000);
        // 时间线从空开始或从 localStorage 恢复，用户从媒体库自行拖入需要的片段
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
        if (this._altKeyHandler) {
            window.removeEventListener("keydown", this._altKeyHandler, true);
            this._altKeyHandler = null;
        }
        if (this._resizeHandler) {
            window.removeEventListener("resize", this._resizeHandler);
            this._resizeHandler = null;
        }
        if (this._autoCheckOffline) {
            document.removeEventListener("visibilitychange", this._autoCheckOffline);
            window.removeEventListener("focus", this._autoCheckOffline);
            this._autoCheckOffline = null;
        }
        if (this._offlinePollTimer) {
            clearInterval(this._offlinePollTimer);
            this._offlinePollTimer = null;
        }
        // 移除全局 contextmenu 屏蔽监听
        if (this._onContextMenu) {
            document.removeEventListener("contextmenu", this._onContextMenu);
            this._onContextMenu = null;
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
        // 空格键播放/暂停
        if (e.key === " " || e.code === "Space") {
            // 始终阻止浏览器默认行为（防止滚动、按钮激活、菜单弹出等）
            e.preventDefault();
            e.stopImmediatePropagation();
            // 焦点在按钮上时按空格会触发 :active 高亮，preventDefault 无法阻止
            // 主动 blur 按钮消除高亮
            const ae = document.activeElement;
            if (ae && ae.tagName === "BUTTON") ae.blur();
            // 按住空格会重复触发 keydown，忽略 repeat 避免快速切换播放/暂停
            if (e.repeat) return;
            if (this.timeline.length > 0) {
                this._toggleTimelinePlay();
            }
            return;
        }
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
            // 始终阻止浏览器默认行为（防止滚动、按钮激活、菜单弹出等）
            e.preventDefault();
            // 按住空格会重复触发 keydown，忽略 repeat 避免快速切换播放/暂停
            if (e.repeat) return;
            // 焦点在按钮上时，空格键会触发按钮 click，preventDefault 阻止默认 click 避免双重触发，直接执行播放/暂停
            if (this.timeline.length > 0) {
                this._toggleTimelinePlay();
            }
            return;
        }
        if (e.key === "Delete" || e.key === "Backspace") {
            const mediaSel = this.selectedMediaNames.size > 0;
            const clipSel = this.selectedClipIds.size > 0;
            if (!mediaSel && !clipSel) return;
            e.preventDefault();
            this._pushHistory();
            // 删除选中的媒体（同步删除后端缓存文件，避免重新上传时生成 _1 文件）
            if (mediaSel) {
                const names = Array.from(this.selectedMediaNames);
                this.selectedMediaNames.clear();
                // 异步删除后端文件 + 更新前端状态
                (async () => {
                    for (const name of names) {
                        await this._removeMedia(name);
                    }
                })();
            }
            // 删除选中的片段：如果删掉了「带配对关系的视频片段」，同步删掉它的配对音频（精确匹配 pairedWith）
            if (clipSel) {
                const ids = Array.from(this.selectedClipIds);
                // 收集被删除片段的配对 ID（通过 pairedWith 字段精确匹配）
                const pairedIdsToDelete = new Set();
                for (const id of ids) {
                    const c = this.timeline.find(cc => cc.id === id);
                    if (c && c.pairedWith != null) {
                        pairedIdsToDelete.add(c.pairedWith);
                    }
                }
                // 删除用户选中的片段
                for (const id of ids) {
                    const idx = this.timeline.findIndex(c => c.id === id);
                    if (idx >= 0) this.timeline.splice(idx, 1);
                }
                // 同步删除：被删片段的配对片段（精确 ID 匹配，不影响其他同源片段）
                if (pairedIdsToDelete.size > 0) {
                    for (let i = this.timeline.length - 1; i >= 0; i--) {
                        if (pairedIdsToDelete.has(this.timeline[i].id)) {
                            this.timeline.splice(i, 1);
                        }
                    }
                }
                this.selectedClipIds.clear();
            }
            this._renderTimeline();
            this._renderProps();
            if (mediaSel && clipSel) {
                this._setStatus(`已删除媒体 + 时间线片段`);
            } else if (mediaSel) {
                this._setStatus(`已删除媒体及其引用的时间线片段`);
            } else if (clipSel) {
                this._setStatus(`已删除时间线片段`);
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
    // 支持多选：选中视频→分割视频，选中音频→分割音频，一起选中→一起分割
    // 纯音频片段用 audioTlStart 定位，视频片段用 tlStart
    _splitClipAtPlayhead() {
        const gtime = this._tlGlobalTime;

        // 计算每个片段在时间轴上的绝对位置（按 kind 选择位置字段）
        const tlPositions = this.timeline.map(c => {
            const dur = c.end - c.start;
            const posField = c.kind === "audio" ? "audioTlStart" : "tlStart";
            const ts = c[posField] != null ? c[posField] : 0;
            return { clip: c, tlStart: ts, tlEnd: ts + dur, origEnd: c.end, posField };
        });

        // 收集要分割的目标片段：
        // 1. 有选中片段时，仅分割选中的片段（支持多选）
        // 2. 无选中片段时，分割播放头所在的片段
        let targets = [];
        if (this.selectedClipIds.size > 0) {
            targets = tlPositions.filter(r => this.selectedClipIds.has(r.clip.id));
        } else {
            for (const r of tlPositions) {
                if (r.tlEnd <= 0) continue;
                if (gtime >= r.tlStart && gtime < r.tlEnd) { targets = [r]; break; }
            }
        }
        if (targets.length === 0) return;

        const newClipIds = new Set();
        let splitCount = 0;
        // 先计算所有可分割的目标，确认有分割后再压栈（避免无操作时污染 undo 栈）
        const validTargets = targets.filter(t => {
            const leftClip = t.clip;
            const splitTl = gtime - t.tlStart;
            const clipLocalTime = leftClip.start + splitTl;
            return clipLocalTime > leftClip.start + 0.05 && clipLocalTime < t.origEnd - 0.05;
        });
        if (validTargets.length === 0) return;

        this._pushHistory();
        for (const target of validTargets) {
            const leftClip = target.clip;
            const splitTl = gtime - target.tlStart; // 分割点在片段内的偏移（秒）
            const clipLocalTime = leftClip.start + splitTl; // 对应源视频时间

            // 确保 leftClip 的位置字段被固定
            leftClip[target.posField] = target.tlStart;
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
                audioTlStart: target.tlStart + splitTl,
                kind: leftClip.kind || "video",
            };

            const idx = this.timeline.findIndex(c => c === leftClip);
            this.timeline.splice(idx + 1, 0, rightClip);
            newClipIds.add(rightClip.id);
            splitCount++;
        }
        this.selectedClipIds = newClipIds;
        this._renderTimeline();
        this._renderProps();
        this._setStatus(`已在 ${_fmtTime(gtime)} 分割 ${splitCount} 个片段`);
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
                    <span class="xzg-ve-title">🎬 小珠光 · 快剪</span>
                    <span class="xzg-ve-status"></span>
                    <div class="xzg-ve-header-right">
                        <button class="xzg-ve-btn xzg-ve-btn-output-settings" style="padding:4px 12px;font-size:12px;color:#fff;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">输出目录设置</button>
                        <span class="xzg-ve-quality-label">质量</span>
                        <select class="xzg-ve-quality-select">
                            <option value="high">高 (CRF 10)</option>
                            <option value="medium" selected>中 (CRF 20)</option>
                            <option value="low">低 (CRF 28)</option>
                        </select>
                        <button class="xzg-ve-btn xzg-ve-btn-apply">导出</button>
                        <button class="xzg-ve-btn xzg-ve-btn-cancel">×</button>
                    </div>
                </div>
                <div class="xzg-ve-body">
                    <div class="xzg-ve-media-panel">
                        <div class="xzg-ve-panel-header">
                            <div class="xzg-ve-media-title-group">
                                <span>媒体库</span>
                                <button class="xzg-ve-refresh-btn" title="检测离线媒体">刷新</button>
                                <button class="xzg-ve-cache-btn" title="删除所有上传的媒体文件和缩略图缓存">一键清理缓存</button>
                            </div>
                            <div class="xzg-ve-media-btns">
                                <button class="xzg-ve-thumb-btn"></button>
                                <button class="xzg-ve-clear-btn">🗑</button>
                                <button class="xzg-ve-add-btn">
                                    <svg width="20" height="16" viewBox="0 0 20 16" xmlns="http://www.w3.org/2000/svg">
                                        <!-- 文件夹外框 -->
                                        <path d="M1 4 L1 14 Q1 15 2 15 L18 15 Q19 15 19 14 L19 6 Q19 5 18 5 L10 5 L8 3 L2 3 Q1 3 1 4 Z" fill="none" stroke="#fff" stroke-width="1.4"/>
                                        <!-- 内部播放三角按钮 -->
                                        <polygon points="8,7.5 8,12.5 12.5,10" fill="#fff"/>
                                    </svg>
                                </button>
                            </div>
                        </div>
                        <div class="xzg-ve-media-list">
                        </div>
                    </div>
                    <div class="xzg-ve-media-resizer"></div>
                    <div class="xzg-ve-preview-panel">
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
                            <button class="xzg-ve-portrait-lock" disabled title="锁定竖屏"></button>
                            <button class="xzg-ve-btn xzg-ve-btn-portrait" disabled>使用竖屏分辨率</button>
                            <span class="xzg-ve-render-label xzg-ve-render-label-fps">帧率</span>
                            <select class="xzg-ve-render-fps-sel" disabled>
                                <option value="0">自定义</option>
                                <option value="16">16</option>
                                <option value="24">24</option>
                                <option value="25">25</option>
                                <option value="30">30</option>
                                <option value="60">60</option>
                                <option value="120">120</option>
                            </select>
                            <input type="number" class="xzg-ve-render-fps" min="0" max="240" step="1" placeholder="--" disabled>
                        </div>
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
                        <button class="xzg-ve-btn xzg-ve-btn-clear-tl">🗑 清空时间线</button>
                        <button class="xzg-ve-btn xzg-ve-btn-reset-layout" title="恢复视频/音频轨道高度和位置为默认居中布局（不影响已加载内容）"><span class="xzg-ve-reset-icon">↺</span> 恢复默认布局</button>
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
                        <div class="xzg-ve-tl-audio-bottom"></div>
                        <div class="xzg-ve-tl-divider"></div>
                        <div class="xzg-ve-tl-playhead"></div>
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
        this._tlAudioBottomDivider = root.querySelector(".xzg-ve-tl-audio-bottom");
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
        root.querySelector(".xzg-ve-btn-cancel").onclick = () => this._cancel();
        root.querySelector(".xzg-ve-btn-apply").onclick = () => this._render();
        root.querySelector(".xzg-ve-btn-clear-tl").onclick = () => this._clearTimeline();
        // 输出目录设置按钮：复用小珠光图像保存-化神级的目录浏览器对话框
        // 通过模拟 node + widget 的方式对接全局 _xzgShowDirBrowser
        const outputSettingsBtn = root.querySelector(".xzg-ve-btn-output-settings");
        // 更新按钮文字：显示当前输出目录设置摘要
        this._updateOutputBtn = () => {
            if (!outputSettingsBtn) return;
            if (this._useDefaultOutput) {
                outputSettingsBtn.textContent = "输出目录设置: 默认";
                outputSettingsBtn.title = "默认输出到 ComfyUI output 目录，前缀 xzg-edit";
            } else {
                // 显示目录名 + 前缀
                const parts = (this._baseDir || "").replace(/[\\/]+$/, "").split(/[\\/]/);
                const last = parts[parts.length - 1] || this._baseDir || "(未选目录)";
                outputSettingsBtn.textContent = `输出目录设置: ${last}`;
                const stamps = [];
                if (this._addDateStamp) stamps.push("日期");
                if (this._addTimeStamp) stamps.push("时间");
                const stampStr = stamps.length ? ` + ${stamps.join("/")}` : "";
                outputSettingsBtn.title = `目录: ${this._baseDir || "(未选)"}\n前缀: ${this._filenamePrefix}${stampStr}`;
            }
        };
        if (outputSettingsBtn) {
            outputSettingsBtn.onclick = () => {
                // 检查全局对话框是否可用（由 xzg_image_save.js 挂载到 window）
                if (typeof window._xzgShowDirBrowser !== 'function') {
                    console.warn("[小珠光] 全局目录浏览器不可用，请确保 xzg_image_save.js 已加载");
                    return;
                }
                // 构造模拟 node + widget，对接全局对话框
                // _xzgDirBrowserConfirm 会设置 widget.value 并调用 callback
                const self = this;
                const baseDirWidget = {
                    name: "base_dir",
                    value: this._baseDir || "",
                    callback: function(v) {
                        self._baseDir = v;
                        self._saveOutputSettings();
                        self._updateOutputBtn();
                    }
                };
                const defaultOutputWidget = {
                    name: "use_default_output",
                    value: this._useDefaultOutput,
                    callback: function(v) {
                        self._useDefaultOutput = !!v;
                        self._saveOutputSettings();
                        self._updateOutputBtn();
                    }
                };
                const prefixWidget = {
                    name: "filename_prefix",
                    value: this._filenamePrefix,
                    callback: function(v) {
                        self._filenamePrefix = v || "xzg-edit";
                        self._saveOutputSettings();
                        self._updateOutputBtn();
                    }
                };
                const dateWidget = {
                    name: "add_date_stamp",
                    value: this._addDateStamp,
                    callback: function(v) {
                        self._addDateStamp = !!v;
                        self._saveOutputSettings();
                        self._updateOutputBtn();
                    }
                };
                const timeWidget = {
                    name: "add_time_stamp",
                    value: this._addTimeStamp,
                    callback: function(v) {
                        self._addTimeStamp = !!v;
                        self._saveOutputSettings();
                        self._updateOutputBtn();
                    }
                };
                const fakeNode = {
                    widgets: [baseDirWidget],
                    setDirtyCanvas: () => {},
                    _xzgBaseDirWidget: baseDirWidget,
                    _xzgDefaultOutputWidget: defaultOutputWidget,
                    _xzgPrefixCustomWidget: prefixWidget,
                    _xzgDateStampWidget: dateWidget,
                    _xzgTimeStampWidget: timeWidget,
                };
                window._xzgShowDirBrowser(fakeNode);
            };
        }
        this._updateOutputBtn();
        root.querySelector(".xzg-ve-btn-reset-layout").onclick = (e) => { e.currentTarget.blur(); this._resetTrackLayout(); };
        // 渲染分辨率控件：预设选择 → 自动填入宽高；竖屏按钮 → 交换宽高使较大值为高
        const presetsSel = root.querySelector(".xzg-ve-render-presets");
        const wInput = root.querySelector(".xzg-ve-render-w");
        const hInput = root.querySelector(".xzg-ve-render-h");
        const portraitLockBtn = root.querySelector(".xzg-ve-portrait-lock");
        // 根据当前宽高同步竖屏方块激活态（宽<高 视为竖屏）
        const _syncPortraitLock = () => {
            if (!portraitLockBtn) return;
            const cw = Number(wInput.value || 0);
            const ch = Number(hInput.value || 0);
            portraitLockBtn.classList.toggle("xzg-ve-active", cw > 0 && ch > 0 && cw < ch);
        };
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
                _syncPortraitLock();
            };
        }
        if (wInput && hInput) {
            // 输入框手动修改时，预设自动切回"原始"（避免与输入值不同步）
            wInput.oninput = () => { if (presetsSel) presetsSel.value = "0"; _syncPortraitLock(); };
            hInput.oninput = () => { if (presetsSel) presetsSel.value = "0"; _syncPortraitLock(); };
        }
        // 帧率下拉列表：选择具体数值 → 填入输入框并禁用手动输入；选择"自定义" → 启用输入框
        const fpsSel = root.querySelector(".xzg-ve-render-fps-sel");
        const fpsInputEl = root.querySelector(".xzg-ve-render-fps");
        if (fpsSel && fpsInputEl) {
            fpsSel.onchange = () => {
                const v = fpsSel.value;
                if (v && v !== "0") {
                    fpsInputEl.value = v;
                    fpsInputEl.disabled = true;
                } else {
                    // 自定义：启用输入框，保留原值供编辑
                    fpsInputEl.disabled = false;
                }
            };
            // 输入框手动修改时，下拉自动切回"自定义"（避免与选择项不同步）
            fpsInputEl.oninput = () => { if (fpsSel) fpsSel.value = "0"; };
        }
        // "使用竖屏分辨率"按钮仅作文字说明，点击由左侧方块承担
        const portraitBtn = root.querySelector(".xzg-ve-btn-portrait");
        if (portraitBtn) portraitBtn.onclick = null;
        // 竖屏方块：点击切换激活态并执行竖屏逻辑
        if (portraitLockBtn) {
            portraitLockBtn.onclick = () => {
                if (portraitLockBtn.disabled) return;
                portraitLockBtn.classList.toggle("xzg-ve-active");
                const active = portraitLockBtn.classList.contains("xzg-ve-active");
                const cw = Number(wInput.value || 0);
                const ch = Number(hInput.value || 0);
                if (cw <= 0 || ch <= 0) return;
                // 激活时确保竖屏（宽<高），取消时确保横屏（宽>高）
                if (active && cw > ch) {
                    wInput.value = ch;
                    hInput.value = cw;
                } else if (!active && cw < ch) {
                    wInput.value = ch;
                    hInput.value = cw;
                }
                // 同步预设列表：尝试匹配交换后的值，无匹配则选"自定义"
                if (presetsSel) {
                    const target = `${wInput.value}x${hInput.value}`;
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
        root.querySelector(".xzg-ve-cache-btn").onclick = () => this._clearCache();
        root.querySelector(".xzg-ve-refresh-btn").onclick = () => this._refreshOfflineStatus();
        this._thumbBtn = root.querySelector(".xzg-ve-thumb-btn");
        this._updateThumbBtn();
        this._thumbBtn.onclick = () => this._toggleThumbMode();
        // 缩略图大小：仅通过 Ctrl+滚轮 调整（无滑条 UI）
        this._applyThumbSize();
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
                // 根据鼠标 X 位置计算放置点（秒，鼠标对应片段左边缘）+ 磁吸对齐
                const media = this.mediaLibrary.find(m => m.name === name);
                const isImg = _isImage(name) || media?.info?.is_image === true;
                const md = media?.info?.duration || 0;
                // 图片 duration=0，使用默认 5 秒；视频 probe 未完成用 60 秒占位
                const dur = isImg ? (media?.info?.default_duration || 5) : (md > 0 ? md : 60);
                let tlStart = this._clientXToTlStart(e.clientX, dur);
                tlStart = this._snapTlStart(tlStart, dur);
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
            this._applyThumbSize();
            try { localStorage.setItem(this._thumbSizeKey, String(this._thumbSize)); } catch (_) {}
        }, { passive: false });

        this._injectStyle();
        this._initCtxMenu();
        this._updateTimeDisplay();

        // 屏蔽整个编辑器根元素上的浏览器右键菜单（保留自定义右键菜单）
        this._onContextMenu = (e) => e.preventDefault();
        document.addEventListener("contextmenu", this._onContextMenu);
    }

    // ═══════════════════════════════════════════════════════════
    //  片段右键菜单（颜色 → 9色板）
    // ═══════════════════════════════════════════════════════════
    _initCtxMenu() {
        // 颜色预设（用户指定色板，与选中态红色 #fa5b4a 形成较大反差）
        const COLORS = [
            { label: "橙",   value: "#EB6E00" },
            { label: "金黄", value: "#E2A91C" },
            { label: "黄绿", value: "#9FC615" },
            { label: "青绿", value: "#448F64" },
            { label: "青",   value: "#009899" },
            { label: "海蓝", value: "#156284" },
            { label: "蓝",   value: "#4376A1" },
            { label: "粉",   value: "#E98CB5" },
            { label: "棕",   value: "#8C5A3F" },
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
        // 子菜单位置（默认右侧，空间不足则左侧；纵向根据菜单项实际位置自适应避免跑出界面）
        if (subItem) {
            const sub = menu.querySelector(".xzg-ve-ctx-submenu");
            if (sub) {
                // 测量子菜单真实高度（临时显示避免 display:none 导致 offsetHeight=0）
                const oldDisp = sub.style.display;
                const oldVis = sub.style.visibility;
                sub.style.visibility = "hidden";
                sub.style.display = "block";
                const subW = sub.offsetWidth || 120;
                const subH = sub.offsetHeight || 260;
                sub.style.display = oldDisp;
                sub.style.visibility = oldVis;

                const itemRect = subItem.getBoundingClientRect();
                const rootR = this._root.getBoundingClientRect();
                const menuRect = menu.getBoundingClientRect();
                // 基于菜单项实际位置计算上下可用空间
                const itemTopInRoot = itemRect.top - rootR.top;
                const spaceBelow = rootR.height - itemTopInRoot - 4;
                const spaceAbove = itemTopInRoot - 4;
                // 子菜单 top（相对菜单顶部）
                let subTop;
                if (spaceBelow >= subH) {
                    // 下方充足：向下展开，顶部对齐菜单项
                    subTop = itemRect.top - menuRect.top;
                } else if (spaceAbove >= subH) {
                    // 上方充足：向上展开，底部对齐菜单项顶部
                    subTop = itemRect.top - menuRect.top - subH;
                } else {
                    // 两侧都不够：选较大一侧贴边展开
                    if (spaceBelow >= spaceAbove) {
                        // 贴下边：子菜单底部对齐 root 底部
                        subTop = (rootR.height - 4 - subH) - (menuRect.top - rootR.top);
                    } else {
                        // 贴上边：子菜单顶部对齐 root 顶部
                        subTop = 4 - (menuRect.top - rootR.top);
                    }
                    subTop = Math.max(0, subTop);
                }
                // 横向：右侧空间足够则右侧，否则左侧
                const rightX = (itemRect.right - rootR.left) + 2;
                if (rightX + subW <= rootR.width - 4) {
                    sub.style.left = (itemRect.width - 2) + "px";
                } else {
                    sub.style.left = (-subW - 2) + "px";
                }
                sub.style.top = subTop + "px";
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
            // 音频片段同步更新边框颜色（音频轨道上的波形元素）
            const aEl = this._tlAudioTrack?.querySelector(`.xzg-ve-audio-clip[data-clip-id="${cid}"]`);
            if (aEl) {
                if (color) aEl.style.setProperty("--xzg-ve-clip-border", color);
                else aEl.style.removeProperty("--xzg-ve-clip-border");
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
        .xzg-ve-title { font-size: 16px; font-weight: 600; color: #dcc85b; white-space: nowrap; }
        .xzg-ve-status { font-size: 12px; color: #888; flex: 1; overflow: hidden;
            text-overflow: ellipsis; white-space: nowrap; }
        .xzg-ve-header-right { display: flex; gap: 8px; align-items: center; margin-left: auto; }
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
            background: #2a2a2a; border: none; color: #fff;
            font-size: 11px; padding: 3px 6px; border-radius: 3px; cursor: pointer;
            display: inline-flex; align-items: center; justify-content: center;
            width: 32px; height: 24px; box-sizing: border-box;
            line-height: 1;
        }
        .xzg-ve-add-btn:hover { background: #454545; }
        .xzg-ve-add-btn svg { display: block; }
        .xzg-ve-add-btn svg polygon,
        .xzg-ve-add-btn svg rect { fill: #fff; }
        .xzg-ve-media-btns { display: flex; gap: 4px; }
        .xzg-ve-media-title-group { display: flex; align-items: center; gap: 6px; }
        .xzg-ve-cache-btn {
            background: #2a2a2a; border: none; color: #ff6b6b;
            font-size: 12px; padding: 2px 6px; border-radius: 3px; cursor: pointer;
            height: 24px; box-sizing: border-box; line-height: 1;
            white-space: nowrap;
        }
        .xzg-ve-cache-btn:hover { background: #5a2a2a; }
        .xzg-ve-refresh-btn {
            background: #2a2a2a; border: none; color: #ddd;
            font-size: 12px; padding: 2px 6px; border-radius: 3px; cursor: pointer;
            height: 24px; box-sizing: border-box; line-height: 1;
            white-space: nowrap;
        }
        .xzg-ve-refresh-btn:hover { background: #454545; }
        .xzg-ve-clear-btn {
            background: #2a2a2a; border: none; color: #ff6b6b;
            font-size: 18px; padding: 3px 6px; border-radius: 3px; cursor: pointer;
            display: inline-flex; align-items: center; justify-content: center;
            width: 32px; height: 24px; box-sizing: border-box;
            line-height: 1;
        }
        .xzg-ve-clear-btn:hover { background: #5a2a2a; }
        .xzg-ve-thumb-btn {
            background: #2a2a2a; border: none; color: #fff;
            font-size: 11px; padding: 3px 6px; border-radius: 3px; cursor: pointer;
            display: inline-flex; align-items: center; justify-content: center;
            width: 32px; height: 24px; box-sizing: border-box;
        }
        .xzg-ve-thumb-btn:hover { background: #454545; }
        .xzg-ve-thumb-btn svg { display: block; }
        /* 缩略图模式图标：2×2 网格 */
        .xzg-ve-thumb-icon-grid rect { fill: #fff; }
        /* 列表模式图标：3行方格+粗线 */
        .xzg-ve-thumb-icon-list rect { fill: #fff; }
        .xzg-ve-media-list { flex: 1; overflow-y: auto; padding: 4px; position: relative; }
        /* 缩略图模式：网格布局，列宽由滑条控制（长边 px） */
        .xzg-ve-media-list.xzg-ve-list-thumb {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(var(--xzg-thumb-w, 160px), 1fr));
            gap: 4px; align-content: start;
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
        /* 离线媒体项：磁盘上不存在的媒体文件，红色背景 + 大红字提示 */
        .xzg-ve-media-item.xzg-ve-media-offline {
            background: #5a1a1a;
        }
        .xzg-ve-media-item.xzg-ve-media-offline:hover { background: #6a2a2a; }
        .xzg-ve-media-offline-label {
            position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
            z-index: 10; pointer-events: none;
            color: #ff3b30; font-size: 25px; font-weight: bold;
            text-shadow: 0 0 6px rgba(0,0,0,0.9), 0 0 2px rgba(0,0,0,1);
            white-space: nowrap;
        }
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
            width: 25px; height: 25px; border-radius: 50%; background: #2a2a2a;
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
            position: relative;
            height: 36px; padding: 0 10px; display: flex; align-items: center;
            justify-content: flex-start; gap: 8px; font-size: 14px; color: #888;
            border-bottom: 1px solid #535353; flex-shrink: 0;
            box-shadow: 0 1px 0 0 rgba(83,83,83,0.5), inset 0 -1px 0 0 rgba(83,83,83,0.5);
        }
        .xzg-ve-tl-info {
            color: #6699ff; font-size: 14px;
            margin-left: auto;
        }
        .xzg-ve-btn.xzg-ve-btn-reset-layout {
            padding: 4px 10px; font-size: 14px; line-height: 1;
            border: none;
            border-radius: 3px;
        }
        .xzg-ve-btn.xzg-ve-btn-reset-layout:hover { background: #454545; }
        .xzg-ve-reset-icon { font-size: 16px; }
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
            background: #303030;
            z-index: 6; overflow: hidden;
        }
        /* 左右分界线：与音视频轨道分隔线一致的5px黑边样式（左1px黑+中3px#535353+右1px黑） */
        .xzg-ve-tl-leftpad::after {
            content: ""; position: absolute; top: 0; bottom: 0; right: 0; width: 5px;
            background: linear-gradient(to right, #000 0 1px, #535353 1px 4px, #000 4px 5px);
            z-index: 8; pointer-events: none;
        }
        /* 轨道头：absolute 定位，top 由 JS 统一设置 */
        .xzg-ve-video-header {
            position: absolute; left: 0; right: 0; height: 60px;
            padding: 4px 8px;
            display: flex; align-items: center; background: #303030;
        }
        .xzg-ve-audio-header {
            position: absolute; left: 0; right: 0; height: 50px;
            padding: 4px 8px;
            display: flex; align-items: center; background: #303030;
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
            position: absolute; top: 34.5px; left: 0; right: 0; height: 1px;
            z-index: 7; pointer-events: none;
            background: #1a1919;
        }
        /* 上方刻度线区：按住鼠标拖动控制播放头（避开左侧150px占位），高度固定 35px */
        .xzg-ve-tl-scrub {
            position: absolute; top: 0; left: 150px; right: 0; height: 35px;
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
            position: absolute; left: 150px; right: 4px; top: 35px;
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
        /* 音频轨道波形元素：与视频轨道片段一一对应，定位对齐 */
        /* box-sizing:border-box 让 border 计入 height:100%，波形完整适应轨道高度不被裁剪 */
        .xzg-ve-audio-clip {
            position: absolute; height: 100%; min-width: 30px; border-radius: 3px;
            overflow: hidden; cursor: pointer;
            background: #448F64; border: 1px solid #000;
            font-size: 9px; color: #ddd;
            user-select: none; -webkit-user-select: none; -webkit-user-drag: none;
            box-sizing: border-box;
            --xzg-ve-clip-border: #4376A1; /* 默认色（色板蓝），可通过 JS 覆盖（与视频片段一致） */
        }
        /* 内边框：上/左/右各2px，下边25px向上延伸；与视频片段 ::after 完全一致 */
        .xzg-ve-audio-clip::after {
            content: ""; position: absolute; inset: 0; pointer-events: none;
            z-index: 5; box-sizing: border-box;
            border: 2px solid var(--xzg-ve-clip-border);
            border-bottom-width: 25px;
        }
        /* 选中态：::before 红色覆盖层，与视频片段 ::before 完全一致 */
        .xzg-ve-audio-clip::before {
            content: ""; position: absolute; inset: 0; pointer-events: none;
            z-index: 6; box-sizing: border-box;
            border: 3px solid transparent;
            border-radius: inherit;
        }
        .xzg-ve-audio-clip.xzg-ve-selected::before {
            border-color: #fa5b4a;
        }
        .xzg-ve-audio-clip.xzg-ve-selected {
            border-color: #000;
        }
        .xzg-ve-audio-clip .xzg-ve-clip-handle {
            position: absolute; top: 0; bottom: 0; width: 16px;
            z-index: 7;
        }
        .xzg-ve-audio-clip .xzg-ve-clip-handle-left {
            left: 0;
            cursor: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Cline x1='3' y1='0' x2='3' y2='24' stroke='%23ff4444' stroke-width='2'/%3E%3Cline x1='7' y1='0' x2='7' y2='24' stroke='%23ff4444' stroke-width='2'/%3E%3Cpath d='M11 12h10M18 7l5 5-5 5' stroke='%23ff4444' stroke-width='2.5' fill='none'/%3E%3C/svg%3E") 5 12, e-resize;
        }
        .xzg-ve-audio-clip .xzg-ve-clip-handle-right {
            right: 0;
            cursor: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Cpath d='M13 12H3M6 7l-5 5 5 5' stroke='%23ff4444' stroke-width='2.5' fill='none'/%3E%3Cline x1='17' y1='0' x2='17' y2='24' stroke='%23ff4444' stroke-width='2'/%3E%3Cline x1='21' y1='0' x2='21' y2='24' stroke='%23ff4444' stroke-width='2'/%3E%3C/svg%3E") 19 12, w-resize;
        }
        .xzg-ve-audio-clip .xzg-ve-clip-del {
            display: none;
        }
        /* 波形 canvas：扣除底部25px色带，不进入色带区域 */
        .xzg-ve-waveform { display: block; position: absolute; top: 0; left: 0; width: 100%; height: calc(100% - 25px); }
        /* 紧凑模式：轨道高度<50px时，波形区<色带，波形扩展到色带区域显示 */
        .xzg-ve-audio-compact .xzg-ve-waveform { height: 100%; }
        .xzg-ve-audio-compact .xzg-ve-audio-clip::after { display: none; }
        /* 视频轨道上边缘：贯穿左侧手柄区+右侧轨道区的1px实线 #1a1919 */
        .xzg-ve-tl-video-top {
            position: absolute; left: 0; right: 0; height: 1px;
            z-index: 7; pointer-events: none;
            background: #1a1919;
        }
        /* 音频轨道下边缘：贯穿左侧手柄区+右侧轨道区的1px实线 #1a1919 */
        .xzg-ve-tl-audio-bottom {
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
            --xzg-ve-clip-border: #4376A1; /* 默认色（色板蓝），可通过 JS 覆盖 */
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
        /* 缩略图带：多个缩略图横向拼接填满片段（扣除底部25px色带，不进入色带区域） */
        .xzg-ve-clip-thumbs {
            position: absolute; top: 0; bottom: 25px; left: 0; display: flex; gap: 0;
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
        .xzg-ve-clip-name { color: rgba(255,255,255,0.85); font-weight: normal; }
        .xzg-ve-clip-time { color: rgba(255,255,255,0.6); }
        /* 离线媒体：媒体库中被删除的片段，红色背景 + 大红字提示 */
        .xzg-ve-clip.xzg-ve-clip-offline,
        .xzg-ve-audio-clip.xzg-ve-clip-offline {
            background: #5a1a1a;
        }
        .xzg-ve-clip.xzg-ve-clip-offline::after {
            border-color: #ff3b30;
            border-bottom-color: #8a1a1a;
        }
        .xzg-ve-clip-offline-label {
            position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
            z-index: 10; pointer-events: none;
            color: #ff3b30; font-size: 25px; font-weight: bold;
            text-shadow: 0 0 6px rgba(0,0,0,0.9), 0 0 2px rgba(0,0,0,1);
            white-space: nowrap;
        }
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
            z-index: 1000; pointer-events: none; display: none; left: 0;
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
        .xzg-ve-btn {
            padding: 6px 12px; background: #2a2a2a; color: #ddd; border: none;
            border-radius: 4px; cursor: pointer; font-size: 12px;
        }
        .xzg-ve-btn:hover { background: #454545; }
        .xzg-ve-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .xzg-ve-btn-apply {
            background: transparent; color: #dcc85b; border: none;
            font-size: 16px; font-weight: bold;
        }
        .xzg-ve-btn-apply:hover { background: rgba(220, 200, 91, 0.15); }
        .xzg-ve-btn-cancel {
            background: transparent; color: #ff3b30; border: none;
            font-size: 32px; font-weight: bold; line-height: 1; padding: 0 4px;
            display: flex; align-items: center;
        }
        .xzg-ve-btn-cancel:hover { background: #5a2a2a; color: #ff6b6b; }
        .xzg-ve-btn-clear-tl {
            font-size: 14px; color: #ff6b6b;
            border: none;
            padding: 4px 10px; line-height: 1;
            border-radius: 3px;
        }
        .xzg-ve-btn-clear-tl:hover { background: #5a2a2a; }
        .xzg-ve-quality-label { color: #ddd; opacity: 0.4; font-size: 12px; font-weight: bold; }
        .xzg-ve-quality-select {
            background: #1D1D1D; color: #ddd; border: 1px solid #000;
            border-radius: 3px; padding: 2px 6px; font-size: 12px; cursor: pointer;
            outline: none; height: 26px; box-sizing: border-box;
        }
        .xzg-ve-quality-select option { background: #1D1D1D; color: #fff; }
        .xzg-ve-quality-select:focus { border-color: #777; }
        .xzg-ve-render-opts {
            height: 32px; padding: 0 10px;
            display: flex; align-items: center; gap: 6px;
            background: #2a2a2a; border-bottom: 1px solid #000;
            color: #aaa; font-size: 12px; flex-shrink: 0;
        }
        .xzg-ve-render-label { color: #888; }
        .xzg-ve-render-opts input[type="number"] {
            background: #1D1D1D; color: #ddd; border: 1px solid #000;
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
            background: #1D1D1D; color: #ddd; border: 1px solid #000;
            border-radius: 3px; padding: 2px 6px; font-size: 12px; cursor: pointer;
        }
        .xzg-ve-render-opts select:hover { border-color: #777; }
        .xzg-ve-btn-portrait, .xzg-ve-btn-portrait:hover {
            font-size: 12px; padding: 0; margin-left: 4px;
            background: transparent; border: none; cursor: default;
            color: #ddd; opacity: 0.4; vertical-align: middle;
        }
        .xzg-ve-render-label-fps { margin-left: 10px; }
        .xzg-ve-portrait-lock {
            width: 18px; height: 18px; padding: 0; margin-left: 4px;
            background: #1D1D1D; border: 1px solid #000; cursor: pointer;
            display: inline-flex; align-items: center; justify-content: center;
            vertical-align: middle;
        }
        .xzg-ve-portrait-lock::after {
            content: ""; width: 5px; height: 9px;
            border: solid #fff; border-width: 0 2px 2px 0;
            transform: rotate(45deg) translate(-1px, -1px);
            opacity: 0; transition: opacity 0.15s;
        }
        .xzg-ve-portrait-lock.xzg-ve-active::after { opacity: 1; }
        .xzg-ve-portrait-lock:disabled { opacity: 0.4; cursor: not-allowed; }
        .xzg-ve-render-opts input:disabled, .xzg-ve-render-opts select:disabled,
        .xzg-ve-btn-portrait:disabled { opacity: 0.4; cursor: not-allowed; }
        `;
        document.head.appendChild(st);
    }

    // ═══════════════════════════════════════════════════════════
    //  媒体库
    // ═══════════════════════════════════════════════════════════

    // 根据 name+type 创建媒体对象，若全局探测缓存命中则直接填充 info 与 probeState
    _makeMediaItem(name, type, displayName, fp) {
        const key = `${name}|${type}`;
        const dn = displayName || name;
        const isAudio = _isAudio(name);
        const isImage = _isImage(name);
        const cached = _XZG_VE_PROBE_CACHE[key];
        if (cached && cached.state === "ok") {
            return { name, type, displayName: dn, info: cached.info, probeState: "ok", error: null, isAudio, isImage, fp: fp || "" };
        } else if (cached && cached.state === "failed") {
            return { name, type, displayName: dn, info: null, probeState: "failed", error: cached.error, isAudio, isImage, fp: fp || "" };
        }
        return { name, type, displayName: dn, info: null, probeState: "pending", error: null, isAudio, isImage, fp: fp || "" };
    }

    async _loadMediaLibrary() {
        // 独立编辑器：从 localStorage 读取持久化的媒体列表，无节点依赖
        const sessionMedia = _xzgVeGetSessionMedia();
        for (const m of sessionMedia) {
            if (!this.mediaLibrary.find(item => item.name === m.name)) {
                // 显示名只取 basename，不显示上级目录（如 fastcut-cache/video.mp4 → video.mp4）
                const baseName = m.name.split("/").pop();
                const item = this._makeMediaItem(m.name, m.type || "input", baseName, m.fp);
                this.mediaLibrary.push(item);
            }
        }
        // 检测离线媒体：磁盘上不存在的文件（手工删除或被清理）
        await this._checkOfflineMedia();
        // 统计所有 pending 项（离线媒体跳过探测）
        const pendingCount = this.mediaLibrary.filter(m => m.probeState === "pending" && !this.offlineMediaNames.has(m.name)).length;
        // 恢复上次的时间线
        this._restoreTimelineSession();
        this._renderMediaList();
        const total = this.mediaLibrary.length;
        const offlineCount = this.offlineMediaNames.size;
        if (pendingCount > 0) {
            this._setStatus(`媒体库已加载 (${total} 个视频), 探测中...`);
            this._probeQueue();
        } else if (total > 0) {
            const offlineMsg = offlineCount > 0 ? `，${offlineCount} 个离线` : "";
            this._setStatus(`媒体库已加载 (${total} 个视频${offlineMsg})`);
        } else {
            this._setStatus("媒体库为空，点击「＋ 添加」上传视频");
        }
    }

    async _checkOfflineMedia() {
        // 批量检测媒体文件是否存在，更新 offlineMediaNames 集合
        // 检测范围：媒体库 + 时间线片段引用的媒体（可能已从媒体库移除但片段仍引用）
        const itemsMap = new Map();
        for (const m of this.mediaLibrary) {
            itemsMap.set(m.name, { name: m.name, type: m.type || "input" });
        }
        // 时间线片段可能引用已从媒体库移除的媒体，也要检测
        for (const clip of this.timeline) {
            if (!itemsMap.has(clip.filename)) {
                itemsMap.set(clip.filename, { name: clip.filename, type: clip.type || "input" });
            }
        }
        if (itemsMap.size === 0) {
            this.offlineMediaNames.clear();
            return;
        }
        const items = Array.from(itemsMap.values());
        try {
            const resp = await _postJson("/xzg_video_editor_check_exists", { items });
            const missing = new Set(resp.missing || []);
            // 检测恢复的媒体：之前在离线集合中（probeState=failed 或被标记离线），现在文件已存在
            // 清除所有相关缓存，触发重新探测 + 重新生成缩略图/波形
            let recovered = false;
            for (const m of this.mediaLibrary) {
                const wasOffline = this.offlineMediaNames.has(m.name);
                if (!missing.has(m.name) && (m.probeState === "failed" || wasOffline)) {
                    this._invalidateMediaCaches(m);
                    m.probeState = "pending";
                    m.error = null;
                    recovered = true;
                }
            }
            // 更新离线集合：基于检测结果增删，不直接替换
            // 避免 mediaLibrary 中已移除但时间线仍引用的媒体丢失离线标记
            for (const name of missing) {
                this.offlineMediaNames.add(name);
            }
            for (const item of items) {
                if (!missing.has(item.name)) {
                    this.offlineMediaNames.delete(item.name);
                }
            }
            if (recovered) {
                this._renderMediaList();
                this._renderTimeline();
                this._probeQueue();
            }
        } catch (e) {
            console.warn("[小珠光] 检测离线媒体失败:", e);
        }
    }

    async _refreshOfflineStatus() {
        // 手动刷新：检测磁盘上媒体文件是否存在，更新离线状态
        this._setStatus("正在检测离线媒体...");
        await this._checkOfflineMedia();
        this._renderMediaList();
        this._renderTimeline();
        const offlineCount = this.offlineMediaNames.size;
        const total = this.mediaLibrary.length;
        if (offlineCount > 0) {
            this._setStatus(`检测完成：${offlineCount}/${total} 个媒体离线`);
        } else if (total > 0) {
            this._setStatus(`检测完成：所有 ${total} 个媒体文件正常`);
        } else {
            this._setStatus("媒体库为空");
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
                // 探测成功：文件已恢复在线，从离线集合移除
                if (this.offlineMediaNames.has(m.name)) {
                    this.offlineMediaNames.delete(m.name);
                    this._renderTimeline();
                }
                this._renderMediaList();
                continue;
            } else if (cached && cached.state === "failed") {
                console.log("[xzg-ve] probeQueue: 缓存命中(failed), name=", m.name);
                m.probeState = "failed";
                m.error = cached.error;
                // 文件不存在（手工删除或被清理）：标记为离线，保留媒体库项和时间线片段
                const isNotFound = m.error && m.error.includes("file not found");
                if (isNotFound) {
                    this.offlineMediaNames.add(m.name);
                    this._setStatus(`视频 "${m.name}" 文件不存在（离线媒体）`);
                    this._renderTimeline();
                } else {
                    // 文件损坏或过小（后端已删除）：从媒体库移除并删除时间线片段
                    const isCorrupted = m.error && (
                        m.error.includes("已删除") ||
                        m.error.includes("文件损坏或过小")
                    );
                    if (isCorrupted) {
                        this._setStatus(`视频 "${m.name}" 文件损坏，已从媒体库移除`);
                        const idx = this.mediaLibrary.findIndex(item => item.name === m.name && item.type === m.type);
                        if (idx >= 0) this.mediaLibrary.splice(idx, 1);
                        _xzgVeRemoveSessionMedia(m.name);
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
                        _xzgVeRemoveSessionMedia(m.name);
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
                    // 探测成功：文件已恢复在线，从离线集合移除
                    if (this.offlineMediaNames.has(m.name)) {
                        this.offlineMediaNames.delete(m.name);
                    }
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
                // 文件不存在（手工删除或被清理）：标记为离线，保留媒体库项和时间线片段
                const isNotFound = m.error && m.error.includes("file not found");
                if (isNotFound) {
                    this.offlineMediaNames.add(m.name);
                    this._setStatus(`视频 "${m.name}" 文件不存在（离线媒体）`);
                    this._renderTimeline();
                } else {
                    const isCorrupted = m.error && (
                        m.error.includes("已删除") ||
                        m.error.includes("文件损坏或过小")
                    );
                    if (isCorrupted) {
                        this._setStatus(`视频 "${m.name}" 文件损坏，已从媒体库移除`);
                        const idx = this.mediaLibrary.findIndex(item => item.name === m.name && item.type === m.type);
                        if (idx >= 0) this.mediaLibrary.splice(idx, 1);
                        _xzgVeRemoveSessionMedia(m.name);
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
                }
                continue;
            }
            this._renderMediaList();
            // 若时间线已有该视频的片段，同步更新其时长
            if (m.info) {
                let firstClipUpdated = false;
                let hasVideoStream = (m.info.width || 0) > 0 && (m.info.height || 0) > 0;
                for (const clip of this.timeline) {
                    if (clip.filename === m.name && clip.durationPending) {
                        clip.sourceDuration = m.info.duration;
                        // 限制 end 不超过真实时长
                        if (clip.end > m.info.duration) clip.end = m.info.duration;
                        if (clip.start > clip.end - 0.1) clip.start = Math.max(0, clip.end - 0.1);
                        clip.durationPending = false;
                        // 若是首个片段或首个有视频流的片段，标记需要同步分辨率
                        if (clip === this.timeline[0] || hasVideoStream) firstClipUpdated = true;
                    }
                }
                this._renderTimeline();
                if (this.selectedClipIds.size > 0) this._renderProps();
                // 首个片段或首个视频片段 probe 完成后同步分辨率
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
            // 离线媒体：添加离线类，禁用拖拽
            const isOffline = this.offlineMediaNames.has(m.name);
            if (isOffline) {
                item.classList.add("xzg-ve-media-offline");
                item.draggable = false;
            }
            // 缩略图模式：上方放缩略图（音频文件显示🎵占位，不触发视频缩略图加载）
            if (this._thumbnailMode) {
                const thumbWrap = _el("div", "xzg-ve-media-thumb", null, item);
                thumbWrap.dataset.name = m.name;
                thumbWrap.dataset.type = m.type;
                if (isOffline) {
                    // 离线媒体：显示大红字"离线媒体"
                    _el("div", "xzg-ve-media-offline-label", "离线媒体", thumbWrap);
                } else if (m.isAudio) {
                    _el("div", "xzg-ve-media-thumb-placeholder", "🎵", thumbWrap);
                } else if (m.isImage || _isImage(m.name)) {
                    // 图片：直接用原图作为缩略图
                    const url = this._videoUrl(m.name, m.type);
                    const img = document.createElement("img");
                    img.src = url;
                    img.style.width = "100%";
                    img.style.height = "100%";
                    img.style.objectFit = "cover";
                    img.style.display = "block";
                    img.draggable = false;
                    thumbWrap.appendChild(img);
                } else {
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
            }
            _el("div", "xzg-ve-media-name", m.displayName || m.name, item);
            let infoText = "";
            let infoClass = "xzg-ve-media-info";
            const isAudio = m.isAudio;
            const isImg = m.isImage || _isImage(m.name);
            if (isOffline) {
                infoText = "❌ 离线媒体";
                infoClass += " xzg-ve-media-info-err";
            } else if (m.probeState === "ok" && m.info) {
                if (isAudio) {
                    infoText = `🎵 音频 · ${_fmtTime(m.info.duration)}`;
                } else if (isImg) {
                    infoText = `🖼 图片 · ${m.info.width}×${m.info.height}`;
                } else {
                    infoText = `${m.info.width}×${m.info.height} · ${_fmtTime(m.info.duration)}`;
                }
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
    }

    // ═══════════════════════════════════════════════════════════
    //  缩略图模式辅助方法
    // ═══════════════════════════════════════════════════════════
    _mediaKey(m) {
        return `${m.name}|${m.type}`;
    }

    // 清除媒体相关的所有缓存（离线恢复时调用，触发重新探测 + 重新生成缩略图/波形）
    // 覆盖视频/音频/图片三类媒体的所有缓存点：
    //   - 视频：探测 + 媒体库单张缩略图 + 时间线整段缩略图流 + 解码器 + 音轨波形
    //   - 音频：探测 + 音频波形（无缩略图）
    //   - 图片：探测（缩略图直接用原图 URL，无额外缓存）
    _invalidateMediaCaches(m) {
        const key = this._mediaKey(m);
        delete _XZG_VE_PROBE_CACHE[key];               // 探测缓存（宽高/时长）
        delete _XZG_VE_THUMB_CACHE[key];               // 媒体库单张缩略图（视频）
        delete _XZG_VE_FULL_THUMB_STREAM[key];         // 时间线整段缩略图流（视频）
        _XZG_VE_FULL_THUMB_STREAM_LOADING.delete(key); // 去重锁（允许重新请求）
        this._audioBufferCache.delete(key);            // 音频波形缓存（音频 + 视频音轨）
        decoderPool.close(m.name, m.type);             // 视频解码器（跨实例全局缓存）
        // 如果被清除的解码器正是当前正在使用的，重置 _currentDecoder 和 _currentClip
        // 避免播放时复用已关闭的解码器导致播放头不动
        if (this._currentClip && this._currentClip.filename === m.name && this._currentClip.type === m.type) {
            this._currentDecoder = null;
            this._currentClip = null;
            this._stopPlaybackLoop();
            this._stopAudio();
            this._updatePlayBtn(false);
            this._tlPlaying = false;
        }
    }

    _toggleThumbMode() {
        this._thumbnailMode = !this._thumbnailMode;
        try { localStorage.setItem(this._thumbModeKey, this._thumbnailMode ? "1" : "0"); } catch (_) {}
        this._updateThumbBtn();
        this._renderMediaList();
    }

    _updateThumbBtn() {
        if (!this._thumbBtn) return;
        // 缩略图模式：2×2 网格图标；列表模式：3 行方格 + 粗线图标
        if (this._thumbnailMode) {
            this._thumbBtn.innerHTML = `
                <svg class="xzg-ve-thumb-icon-grid" width="18" height="14" viewBox="0 0 20 16" xmlns="http://www.w3.org/2000/svg">
                    <rect x="0" y="0" width="9" height="7"/>
                    <rect x="11" y="0" width="9" height="7"/>
                    <rect x="0" y="9" width="9" height="7"/>
                    <rect x="11" y="9" width="9" height="7"/>
                </svg>`;
        } else {
            this._thumbBtn.innerHTML = `
                <svg class="xzg-ve-thumb-icon-list" width="18" height="14" viewBox="0 0 20 16" xmlns="http://www.w3.org/2000/svg">
                    <rect x="0" y="0" width="4" height="4"/>
                    <rect x="6" y="1.5" width="14" height="2"/>
                    <rect x="0" y="6" width="4" height="4"/>
                    <rect x="6" y="7.5" width="14" height="2"/>
                    <rect x="0" y="12" width="4" height="4"/>
                    <rect x="6" y="13.5" width="14" height="2"/>
                </svg>`;
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

    // 刷新/重启后恢复默认布局，不持久化（保留空方法避免破坏调用）
    _saveTimelineHeight(h) {}
    _saveTlLayout() {}

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
                let h = startH + (startY - ev.clientY);
                // 最小高度 = 36(header) + 35(刻度) + 0(留白) + 25(视频) + 5(分割线) + 25(音频) = 126
                if (h < 126) h = 126;
                if (h > 500) h = 500;
                panel.style.height = h + "px";

                const tlH = Math.max(1, this._timeline.clientHeight);
                const trackAreaH = tlH - 35;

                const dVH = 80, dAH = 70, minT = 25;
                const defaultContentH = dVH + 5 + dAH; // 115
                const minContentH = minT + 5 + minT;   // 55

                let vH, aH, vOff;
                if (trackAreaH >= defaultContentH) {
                    // 空间充足：默认轨道高度 + 对称留白
                    vH = dVH; aH = dAH;
                    vOff = Math.floor((trackAreaH - defaultContentH) / 2);
                } else if (trackAreaH >= minContentH) {
                    // 空间不足：按比例平分压缩轨道高度，留白=0
                    const overflow = defaultContentH - trackAreaH;
                    const vCap = dVH - minT, aCap = dAH - minT, totalCap = vCap + aCap;
                    const cutV = Math.round(overflow * vCap / totalCap);
                    const cutA = overflow - cutV;
                    vH = dVH - cutV; aH = dAH - cutA;
                    vOff = 0;
                } else {
                    // 极限：都到最小值，禁止继续下拖
                    vH = minT; aH = minT; vOff = 0;
                    panel.style.height = (36 + 35 + minContentH) + "px";
                }

                this._tlVideoHeight = vH;
                this._tlAudioHeight = aH;
                this._tlVideoTopOffset = vOff;
                this._applyTrackLayout();
            };
            const onUp = () => {
                window.removeEventListener("mousemove", onMove);
                window.removeEventListener("mouseup", onUp);
                this._tlResizer.classList.remove("xzg-ve-resizing");
                const finalH = Math.round(panel.getBoundingClientRect().height);
                this._tlHeight = finalH;
                this._saveTimelineHeight(finalH);
                this._saveTlLayout(); // 持久化压缩后的轨道高度/偏移
                this._setStatus(`时间线高度: ${finalH}px`);
                this._applyTrackLayout();
                this._renderTicks();
                this._updatePlayhead();
            };
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
        });

        // Shift+鼠标滚轮：在视频/音频轨道上调整对应轨道高度
        const onTrackWheel = (which) => (e) => {
            if (!e.shiftKey) return;
            e.preventDefault();
            e.stopPropagation();
            // 滚轮向上(deltaY<0)增大高度，向下(deltaY>0)减小高度
            const delta = e.deltaY < 0 ? 5 : -5;
            this._tlHeightsCustomized = true;
            const tlH = Math.max(1, this._timeline.clientHeight);
            const trackAreaH = tlH - 35;
            const dVH = 80, dAH = 70, minT = 25, gap = 5;
            let vH = this._tlVideoHeight, aH = this._tlAudioHeight;
            const otherH = which === "video" ? aH : vH;
            const maxCur = trackAreaH - otherH - gap;
            if (which === "video") {
                vH = Math.max(minT, Math.min(dVH, vH + delta));
                vH = Math.min(vH, Math.max(minT, maxCur));
            } else {
                aH = Math.max(minT, Math.min(dAH, aH + delta));
                aH = Math.min(aH, Math.max(minT, maxCur));
            }
            this._tlVideoHeight = vH;
            this._tlAudioHeight = aH;
            // 重新计算对称留白
            const totalContentH = vH + gap + aH;
            this._tlVideoTopOffset = totalContentH <= trackAreaH
                ? Math.max(0, Math.floor((trackAreaH - totalContentH) / 2))
                : 0;
            this._applyTrackLayout();
        };
        if (this._tlTrack) this._tlTrack.addEventListener("wheel", onTrackWheel("video"), { passive: false });
        if (this._tlAudioTrack) this._tlAudioTrack.addEventListener("wheel", onTrackWheel("audio"), { passive: false });
    }

    // 一键恢复默认布局：重置预览区与时间线占比、视频/音频轨道高度和位置为默认值，
    // 不影响已加载的视频、时间线片段内容、媒体库内容
    _resetTrackLayout() {
        // 恢复时间线面板默认高度（预览区与时间线的分割占比）
        this._tlHeight = 280;
        if (this._tlPanel) this._tlPanel.style.height = "280px";
        this._saveTimelineHeight(280);
        // 恢复轨道高度和位置
        this._tlVideoHeight = 80;
        this._tlAudioHeight = 70;
        this._tlVideoTopOffset = 0;
        this._tlHeightsCustomized = false; // false 触发 _applyTrackLayout 的自动居中逻辑
        this._applyTrackLayout();
        this._saveTlLayout();
        this._renderTicks();
        this._updatePlayhead();
    }

    // 同步三个手柄、视频/音频轨道头与轨道的 top 位置（达芬奇式）
    // 布局（自上而下）：上手柄 → 视频头/轨道 → 中手柄 → 音频头/轨道 → 下手柄
    _applyTrackLayout() {
        // 默认布局：视频60px、音频50px（初始值），未自定义时让音视频整体居中于可用区域
        if (!this._tlHeightsCustomized && this._timeline) {
            const tlH = Math.max(1, this._timeline.clientHeight);
            const trackAreaH = tlH - 35; // 扣除固定 35px 刻度区域
            const totalH = this._tlVideoHeight + 5 + this._tlAudioHeight;
            // 整体居中：上方留白 = (可用高度 - 音视频总高度) / 2
            this._tlVideoTopOffset = Math.max(0, Math.floor((trackAreaH - totalH) / 2));
        }
        const vOff = this._tlVideoTopOffset || 0;
        const vH = this._tlVideoHeight;
        const aH = this._tlAudioHeight;
        const vTop = vOff;              // 视频头/轨道 top（相对 35px 刻度区域底部）
        const midTop = vOff + vH;       // 视频底部 = 分割线上边缘
        const aTop = vOff + vH + 5;     // 音频顶 = 分割线下边缘（+5px，与5px分割线紧贴无间隙）
        const botTop = aTop + aH;       // 音频底部
        // 用 calc(35px + Npx)：刻度区域固定 35px，不随时间线高度变化
        const calc = (n) => `calc(35px + ${n}px)`;
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
            // 紧凑模式：音频轨道高度<50px时，波形区<25px色带，波形扩展到色带区域显示
            this._tlAudioTrack.classList.toggle("xzg-ve-audio-compact", aH < 50);
        }
        // 音频下边缘贯穿最左的1px实线：中线对齐音频底部
        if (this._tlAudioBottomDivider) this._tlAudioBottomDivider.style.top = calc(botTop - 0.5);
        if (this._tlResizerBottom) this._tlResizerBottom.style.top = calc(botTop - 4);
        // 轨道高度变化后重绘所有波形，使波形上下收缩自适应新高度（不被裁剪）
        // 用 requestAnimationFrame 延迟到下一帧，确保浏览器已回流、canvas.clientHeight 反映新高度
        requestAnimationFrame(() => {
            this._redrawAllWaveforms();
            // 同步所有视频片段缩略图（按新高度重新计算缩略图数量和宽度）
            this._syncAllClipThumbs();
        });
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
                    let newVH = Math.max(25, Math.round(startVH - delta));
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
                    this._saveTlLayout();
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
                    let newOff = Math.max(0, Math.round(startOff + delta));
                    // 限制音频下边缘不超出时间线容器可用区域底部（刻度区以下区域）
                    // 刻度区域固定 35px
                    const tlH = Math.max(1, this._timeline.clientHeight);
                    const trackAreaH = tlH - 35;
                    const vH = this._tlVideoHeight;
                    const aH = this._tlAudioHeight;
                    const maxOff = Math.max(0, Math.round(trackAreaH - vH - 5 - aH));
                    if (newOff > maxOff) newOff = maxOff;
                    this._tlVideoTopOffset = newOff;
                    this._applyTrackLayout();
                };
                const onUp = () => {
                    window.removeEventListener("mousemove", onMove);
                    window.removeEventListener("mouseup", onUp);
                    this._tlResizerMid.classList.remove("xzg-ve-resizing");
                    this._saveTlLayout();
                };
                window.addEventListener("mousemove", onMove);
                window.addEventListener("mouseup", onUp);
            });
        }
        // 下手柄：调整音频高度（下拖极限不超过时间线容器底部）
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
                    // 计算时间线容器的可用高度上限：刻度区域(固定35px)以下至容器底部
                    const tlH = Math.max(1, this._timeline.clientHeight);
                    const trackAreaH = tlH - 35;
                    const vOff = this._tlVideoTopOffset || 0;
                    const vH = this._tlVideoHeight;
                    const maxAH = Math.max(25, Math.round(trackAreaH - vOff - vH - 5));
                    this._tlAudioHeight = Math.max(25, Math.min(maxAH, Math.round(startAH + delta)));
                    this._applyTrackLayout();
                };
                const onUp = () => {
                    window.removeEventListener("mousemove", onMove);
                    window.removeEventListener("mouseup", onUp);
                    this._tlResizerBottom.classList.remove("xzg-ve-resizing");
                    this._saveTlLayout();
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
            // data.filename + data.subfolder 是 input 下的完整子路径
            const url = `/view?filename=${encodeURIComponent(data.filename)}&type=input&subfolder=${encodeURIComponent(data.subfolder || "")}&t=${Date.now()}`;
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

    async _removeMedia(name) {
        const idx = this.mediaLibrary.findIndex(m => m.name === name);
        if (idx < 0) return;
        // 从媒体库移除，并删除后端缓存文件（避免重新上传时后端加序号生成 _1 文件）
        this.mediaLibrary.splice(idx, 1);
        this.selectedMediaNames.delete(name);
        _xzgVeRemoveSessionMedia(name);  // 从会话列表移除
        // 标记为离线：时间线片段引用该媒体的会显示"离线媒体"大红字
        this.offlineMediaNames.add(name);
        // 删除后端媒体文件 + 关联缩略图（静默失败：文件可能已不存在）
        try {
            await _postJson("/xzg_video_editor_delete_media", { filename: name, type: "input" });
        } catch (e) {
            console.warn("[小珠光] 删除后端缓存文件失败:", e);
        }
        this._renderMediaList();
        // 刷新时间线：引用该媒体的片段显示为离线媒体
        this._renderTimeline();
        this._setStatus(`已从媒体库移除: ${name}`);
    }

    async _clearMediaLibrary() {
        if (this.mediaLibrary.length === 0) {
            this._setStatus("媒体库已为空");
            return;
        }
        const n = this.mediaLibrary.length;
        const names = this.mediaLibrary.map(m => m.name);
        // 全部标记为离线：时间线片段显示"离线媒体"大红字
        for (const name of names) this.offlineMediaNames.add(name);
        this.mediaLibrary = [];
        this.selectedMediaNames.clear();
        _xzgVeSaveSessionMedia([]);  // 清空会话列表
        // 并行删除后端所有媒体文件 + 关联缩略图（静默失败：文件可能已不存在）
        await Promise.all(names.map(name =>
            _postJson("/xzg_video_editor_delete_media", { filename: name, type: "input" })
                .catch(e => console.warn("[小珠光] 删除后端缓存文件失败:", name, e))
        ));
        this._renderMediaList();
        // 刷新时间线：所有片段显示为离线媒体
        this._renderTimeline();
        this._setStatus(`已清空媒体库 (${n} 个媒体)`);
    }

    async _clearCache() {
        // 一键清理缓存：删除整个 fastcut-cache 目录（上传的媒体文件 + 缩略图）
        if (!confirm("将删除所有上传的媒体文件和缩略图缓存（不可恢复），媒体库和时间线将被清空。确认清理？")) return;
        this._setStatus("正在清理缓存...");
        try {
            const resp = await _postJson("/xzg_video_editor_clear_cache", {});
            if (resp.error) throw new Error(resp.error);
            // 文件已被后端删除，清空前端媒体库
            this.mediaLibrary = [];
            this.selectedMediaNames.clear();
            _xzgVeSaveSessionMedia([]);
            // 时间线片段引用的文件已被删除，一并清空
            this._clearTimeline();
            this._renderMediaList();
            const detail = [];
            if (resp.removed_dirs) detail.push(`${resp.removed_dirs} 个目录`);
            if (resp.removed_files) detail.push(`${resp.removed_files} 个文件`);
            this._setStatus(`缓存已清理（${detail.join(" + ") || "无内容"}），媒体库和时间线已清空`);
        } catch (e) {
            this._setStatus(`清理缓存失败: ${e.message}`);
            console.warn("[小珠光] 清理缓存失败:", e);
        }
    }

    async _addFromInput() {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = VIDEO_EXTS.concat(AUDIO_EXTS).concat(IMAGE_EXTS).map(e => "." + e).join(",");
        input.multiple = true;
        input.style.display = "none";
        document.body.appendChild(input);
        input.onchange = async () => {
            document.body.removeChild(input);
            const files = Array.from(input.files || []).filter(f => _isMedia(f.name));
            if (files.length === 0) return;
            this._setStatus(`上传 ${files.length} 个文件...`);
            const uploaded = [];
            const skipped = [];
            let needsTimelineRefresh = false;  // 离线恢复时需要刷新时间线
            for (const f of files) {
                // 文件指纹：name + size + lastModified，三者相同视为同一文件
                const fp = `${f.name}|${f.size}|${f.lastModified}`;
                // 上传前检查媒体库是否已有相同指纹的项
                // 离线媒体（文件被手工删除）允许重新上传以恢复，不跳过
                const existing = this.mediaLibrary.find(m => m.fp === fp &&
                    m.probeState !== "failed" && !this.offlineMediaNames.has(m.name));
                if (existing) {
                    skipped.push(f.name);
                    continue;
                }
                try {
                    // 上传文件：后端 _xzg_secure_video_filename 在重名时加序号
                    // 媒体库删除时已同步删除后端文件，所以重新上传同名文件会用原文件名
                    const { safeName, subfolder } = this._computeUploadPaths(f);
                    const { filename: diskName, displayName } = await this._uploadFile(f, safeName, subfolder);
                    // 检查是否为离线恢复（媒体可能仍在库中，也可能已被 _removeMedia 移除但时间线仍引用）
                    const wasOffline = this.offlineMediaNames.has(diskName);
                    const existItem = this.mediaLibrary.find(m => m.name === diskName);
                    if (!existItem) {
                        // 新增媒体（或从媒体库移除后重新上传）
                        const newItem = this._makeMediaItem(diskName, "input", displayName, fp);
                        this.mediaLibrary.push(newItem);
                        _xzgVeAddSessionMedia(diskName, "input", fp);  // 写入会话列表（含指纹）
                        this.offlineMediaNames.delete(diskName);
                        uploaded.push(diskName);
                        // 离线恢复：媒体已从媒体库移除但时间线片段仍引用，需要清除旧缓存 + 刷新时间线
                        if (wasOffline) {
                            this._invalidateMediaCaches(newItem);
                            needsTimelineRefresh = true;
                        }
                    } else if (wasOffline) {
                        // 离线恢复：媒体仍在库中（文件被手工删除后重新上传到原路径）
                        // 清除所有相关缓存，触发重新探测 + 重新生成缩略图/波形
                        this.offlineMediaNames.delete(diskName);
                        this._invalidateMediaCaches(existItem);
                        existItem.probeState = "pending";
                        existItem.error = null;
                        existItem.fp = fp;  // 更新指纹（重新上传的文件 lastModified 可能不同）
                        _xzgVeAddSessionMedia(diskName, "input", fp);
                        uploaded.push(diskName);
                        needsTimelineRefresh = true;
                    }
                } catch (e) {
                    // 上传失败（含文件损坏被后端删除），不加入媒体库
                    this._setStatus(`上传失败: ${e.message}`);
                }
            }
            this._renderMediaList();
            if (needsTimelineRefresh) {
                // 离线恢复时刷新时间线（去掉"离线媒体"红字和红色背景）
                this._renderTimeline();
            }
            if (uploaded.length > 0) {
                this._setStatus(`已上传 ${uploaded.length} 个视频, 探测+缩略图生成中...`);
                this._probeQueue();
            } else if (skipped.length > 0) {
                this._setStatus(`${skipped.length} 个文件已存在，已跳过`);
            }
        };
        input.click();
    }

    _computeUploadPaths(file) {
        // 保留原始文件名（仅替换文件系统非法字符，保留中文/空格等；后端处理重名加序号）
        const safeName = file.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/^[\s.]+|[\s.]+$/g, "");
        // 按文件类型路由到对应子目录：video/audio/image
        let subfolder = "fastcut-cache/video";
        if (_isAudio(file.name)) subfolder = "fastcut-cache/audio";
        else if (_isImage(file.name)) subfolder = "fastcut-cache/image";
        return { safeName, subfolder };
    }

    async _uploadFile(file, safeName, subfolder) {
        // 复用已有的上传 API
        const chunkSize = 20 * 1024 * 1024;
        const totalChunks = Math.ceil(file.size / chunkSize);
        // safeName 和 subfolder 由 _computeUploadPaths 预计算（用于上传前删除离线残留）

        // 启动会话
        const startResp = await _postJson("/xzg/video_upload_start", {
            filename: safeName,
            total_size: file.size,
            total_chunks: totalChunks,
            subfolder: subfolder,
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
        // 检测是否从离线恢复（之前在 offlineMediaNames 中）
        const wasOffline = this.offlineMediaNames.has(filename);
        if (!this.mediaLibrary.find(m => m.name === filename)) {
            // 显示名只取 basename，不显示上级目录
            const baseName = filename.split("/").pop();
            newItem = this._makeMediaItem(filename, type, baseName);
            this.mediaLibrary.push(newItem);
            _xzgVeAddSessionMedia(filename, type);  // 写入会话列表
            // 新上传的文件必然在线，确保不在离线集合中
            this.offlineMediaNames.delete(filename);
            this._renderMediaList();
            if (newItem.probeState === "pending") this._probeQueue();
        } else if (wasOffline) {
            // 媒体已在库中但从离线恢复：清除所有相关缓存，触发重新探测 + 重新生成缩略图/波形
            this.offlineMediaNames.delete(filename);
            const m = this.mediaLibrary.find(item => item.name === filename);
            if (m) {
                this._invalidateMediaCaches(m);
                m.probeState = "pending";
                m.error = null;
            }
            this._renderMediaList();
            this._renderTimeline();
            this._probeQueue();
        }
        this._addClipToTimeline(filename, type);
    }

    // ═══════════════════════════════════════════════════════════
    //  时间线
    // ═══════════════════════════════════════════════════════════
    // 从 sessionStorage 恢复上次会话的时间线
    _restoreTimelineSession() {
        const saved = _xzgVeGetSessionTimeline();
        if (!saved.length) return;
        for (const s of saved) {
            // 仅恢复媒体库中存在的视频（避免引用已删除的文件）
            if (!this.mediaLibrary.find(m => m.name === s.filename)) continue;
            // kind 优先从持久化恢复；否则依据媒体 isAudio 推断
            const media = this.mediaLibrary.find(m => m.name === s.filename);
            const kind = s.kind || (media?.isAudio ? "audio" : "video");
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
                audioTlStart: s.audioTlStart != null && s.audioTlStart >= 0 ? s.audioTlStart : null,
                skip_audio: s.skip_audio === true ? true : undefined,
                kind,
                pairedWith: s.pairedWith != null ? s.pairedWith : undefined,
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
        _xzgVeSaveSessionTimeline(this.timeline);
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
        const isImage = _isImage(filename) || media?.info?.is_image === true;
        const duration = media?.info?.duration || 0;
        // 图片：固定默认时长 5 秒（probe 返回 duration=0，前端用默认值填充）
        // 即使 probe 未完成或失败也允许添加，用占位时长 60s（probe 完成后会自动更新）
        const placeholderDur = isImage ? (media?.info?.default_duration || 5) :
                               (duration > 0 ? duration : 60);
        // kind: "audio" = 纯音频片段（无视频流），"video" = 含视频流片段（默认）
        // 图片视为视频片段（静止画面）
        const kind = (media?.isAudio || (media?.info?.audio_only === true)) ? "audio" : "video";
        const hasAudio = media?.info?.has_audio === true;
        this._pushHistory();
        // 按 kind 设置对应位置字段：视频用 tlStart，音频用 audioTlStart
        const isVideoClip = kind === "video";
        const clip = {
            id: ++this._clipIdCounter,
            filename,
            type,
            name: filename,
            start: 0,
            end: placeholderDur,
            sourceDuration: placeholderDur,
            durationPending: isImage ? false : (duration <= 0),  // 图片时长固定，无需等 probe
            borderColor: "",
            tlStart: isVideoClip ? tlStart : null,
            audioTlStart: isVideoClip ? null : tlStart,  // 纯音频片段位置存在 audioTlStart
            kind,  // 片段类型：video / audio（纯音频）
        };
        // 视频含音频流：同时创建独立的音频片段，在音频轨道独立存在、可单独拖动/裁剪
        let audioClip = null;
        if (kind === "video" && hasAudio) {
            // 标记视频片段：音频已独立拆分（即使后来删除了音频片段，也不要再从视频本身提音频）
            clip.skip_audio = true;
            audioClip = {
                id: ++this._clipIdCounter,
                filename,
                type,
                name: filename,
                start: 0,
                end: placeholderDur,
                sourceDuration: placeholderDur,
                durationPending: isImage ? false : (duration <= 0),
                borderColor: "",
                tlStart: null,          // 视频片段专用字段，音频片段不使用
                audioTlStart: tlStart,  // 音频独立位置，初始与视频对齐
                kind: "audio",
                pairedWith: clip.id,    // 标记配对的视频片段 ID
            };
            // 视频片段也标记配对的音频 ID
            clip.pairedWith = audioClip.id;
        }
        // ⚠️ 顺序必须：先 video → 后 audio。避免 _findClipByGlobalTime 在相同时间点优先返回 audio，
        //    导致 _seekToGlobalTime 误判为纯音频，显示黑屏音频占位（用户感觉无法播放视频）
        this.timeline.push(clip);
        if (audioClip) this.timeline.push(audioClip);
        // 拖放时（tlStart 非 null）：处理与已有片段的交集（裁剪/切割）
        if (tlStart != null) {
            this._applyClipOverlapTrim(clip);
            this._splitClipForInsertion(clip);
            if (audioClip) {
                this._applyClipOverlapTrim(audioClip);
                this._splitClipForInsertion(audioClip);
            }
        }
        this.selectedClipIds = new Set([clip.id]);
        this._renderTimeline();
        this._renderProps();
        this._loadClipToPreview(clip);
        // 添加首个视频片段时，自动用其分辨率作为初始渲染分辨率（纯音频片段无分辨率，跳过）
        if (kind === "video") {
            const hasPrevVideo = this.timeline.some(c => c !== clip && c.kind !== "audio");
            if (!hasPrevVideo) this._syncResFromFirstClip();
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
        // 同步清空音频轨道
        if (this._tlAudioTrack) this._tlAudioTrack.innerHTML = "";
        // 持久化当前时间线（恢复时由 _restoreTimelineSession 接管，不会循环）
        this._saveTimelineSession();
        // 收集本次渲染的 clip 元素，稍后异步加载缩略图
        const pendingThumbs = [];
        const pendingWaveforms = [];
        if (this.timeline.length === 0) {
            _el("div", "xzg-ve-timeline-empty", "拖拽媒体库中的视频到此处", track);
            this._tlInfo.textContent = "";
            // 无片段时禁用分辨率控件
            this._disableRenderOpts();
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

        // 计算每个片段的渲染位置：视频/音频分别维护独立的 autoEnd
        // ════════════════════════════════════════════════════════
        // 先按实际位置字段排序，保证 autoEnd 与片段顺序无关（避免 timeline 数组乱序导致位置错乱）
        const sortedByVideo = [...this.timeline].filter(c => c.kind !== "audio")
            .sort((a, b) => {
                const at = a.tlStart != null ? a.tlStart : Infinity;
                const bt = b.tlStart != null ? b.tlStart : Infinity;
                return at - bt;
            });
        const sortedByAudio = [...this.timeline].filter(c => c.kind === "audio")
            .sort((a, b) => {
                const at = a.audioTlStart != null ? a.audioTlStart : Infinity;
                const bt = b.audioTlStart != null ? b.audioTlStart : Infinity;
                return at - bt;
            });

        // 分别计算视频/音频的 autoEnd 基准（用于 null 片段自动追加）
        let autoEndVideo = 0;
        for (const c of sortedByVideo) {
            if (c.tlStart != null) autoEndVideo = Math.max(autoEndVideo, c.tlStart + (c.end - c.start));
            else autoEndVideo += (c.end - c.start);
        }
        let autoEndAudio = 0;
        for (const c of sortedByAudio) {
            if (c.audioTlStart != null) autoEndAudio = Math.max(autoEndAudio, c.audioTlStart + (c.end - c.start));
            else autoEndAudio += (c.end - c.start);
        }

        // 按 timeline 原始顺序收集 clipRects（保持 UI 交互稳定）
        let accVideo = 0;
        let accAudio = 0;
        const clipRects = [];
        for (const clip of this.timeline) {
            const dur = clip.end - clip.start;
            const w = Math.max(30, dur * pxPerSec);
            const isVideoClip = clip.kind !== "audio";

            let tsVideo, tsAudio;
            if (isVideoClip) {
                if (clip.tlStart != null) {
                    tsVideo = clip.tlStart;
                } else {
                    // 无位置：占位追加，保证所有 null 视频片段共享同一 accVideo
                    tsVideo = autoEndVideo - dur + 0; // 暂存占位，下面统一重算
                }
            }
            if (clip.kind === "audio") {
                if (clip.audioTlStart != null) {
                    tsAudio = clip.audioTlStart;
                } else {
                    tsAudio = 0; // 暂存占位
                }
            }

            // ═══════ 统一 null 位置追加逻辑 ═══════
            // 视频：null 片段按出现顺序依次追加到视频末尾
            if (isVideoClip) {
                if (clip.tlStart == null) {
                    tsVideo = accVideo >= autoEndVideo ? accVideo : (clip.tlStart ?? autoEndVideo);
                    if (tsVideo < accVideo) tsVideo = accVideo;
                    accVideo = tsVideo + dur;
                } else {
                    tsVideo = clip.tlStart;
                    accVideo = Math.max(accVideo, tsVideo + dur);
                }
            } else {
                // 纯音频：null 片段按出现顺序依次追加到音频末尾
                if (clip.audioTlStart == null) {
                    tsAudio = accAudio >= autoEndAudio ? accAudio : (clip.audioTlStart ?? autoEndAudio);
                    if (tsAudio < accAudio) tsAudio = accAudio;
                    accAudio = tsAudio + dur;
                } else {
                    tsAudio = clip.audioTlStart;
                    accAudio = Math.max(accAudio, tsAudio + dur);
                }
            }

            // 视频片段 x 基于视频轨道 tsVideo
            const xVideo = (isVideoClip ? tsVideo : 0) * pxPerSec;
            clipRects.push({
                clip,
                x: xVideo,
                w,
                tlStart: isVideoClip ? tsVideo : (clip.tlStart ?? 0),
                tlEnd: isVideoClip ? tsVideo + dur : 0,
                audioTlStart: clip.kind === "audio" ? tsAudio : (clip.audioTlStart ?? (isVideoClip ? tsVideo : 0)),
            });
        }

        for (const rect of clipRects) {
            const { clip, w } = rect;
            const x = rect.x;
            // 在音频轨道创建波形元素：仅纯音频片段（kind==="audio"）
            // 视频片段的音频已作为独立的音频片段存在于音频轨道，不再在此渲染
            if (this._tlAudioTrack && !this._tlInHandleDrag && clip.kind === "audio") {
                const wfMediaExists = !this.offlineMediaNames.has(clip.filename);
                const wfEl = _el("div", "xzg-ve-audio-clip", null, this._tlAudioTrack);
                wfEl.dataset.clipId = clip.id;
                // 音频片段位置：使用 clipRects 中统一计算好的 audioTlStart（已含 null→autoEndAudio 兜底）
                const aTs = rect.audioTlStart;
                wfEl.style.left = `${aTs * pxPerSec}px`;
                wfEl.style.width = `${w}px`;
                if (this.selectedClipIds.has(clip.id)) wfEl.classList.add("xzg-ve-selected");
                if (!wfMediaExists) wfEl.classList.add("xzg-ve-clip-offline");
                // 自定义边框颜色（与视频片段一致，通过 CSS 变量控制 ::after 彩色边框）
                if (clip.borderColor) wfEl.style.setProperty("--xzg-ve-clip-border", clip.borderColor);
                if (!wfMediaExists) {
                    // 离线音频：显示大红字提示，不加载波形
                    _el("div", "xzg-ve-clip-offline-label", "离线媒体", wfEl);
                } else {
                    const wfCanvas = _el("canvas", "xzg-ve-waveform", null, wfEl);
                    // 底部信息条（名称）：与视频片段一致，覆盖在色带区域
                    const wfInfo = _el("div", "xzg-ve-clip-info", null, wfEl);
                    _el("span", "xzg-ve-clip-name", clip.name, wfInfo);
                    pendingWaveforms.push({ el: wfEl, canvas: wfCanvas, clip, width: w });
                }
                // 左右拖拽手柄
                const wLh = _el("div", "xzg-ve-clip-handle xzg-ve-clip-handle-left", null, wfEl);
                const wRh = _el("div", "xzg-ve-clip-handle xzg-ve-clip-handle-right", null, wfEl);
                // 拖动（与视频片段共用同一逻辑）
                wfEl.addEventListener("mousedown", (e) => {
                    if (e.target === wLh || e.target === wRh) return;
                    e.preventDefault();
                    e.stopPropagation();
                    if (e.altKey) {
                        this._startClipAltDrag(e, clip);
                    } else {
                        this._startClipDrag(e, clip, clipRects, "audio");
                    }
                });
                // 点击选中（与视频片段一致）
                wfEl.addEventListener("click", (e) => {
                    if (e.target === wLh || e.target === wRh) return;
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
                    this._updateClipSelection();
                    this._renderProps();
                });
                // 右键菜单
                wfEl.addEventListener("contextmenu", (e) => this._showCtxMenu(e, clip.id));
                // 调整入出点
                wLh.addEventListener("pointerdown", (e) => this._onHandleDown(e, clip, "left"));
                wRh.addEventListener("pointerdown", (e) => this._onHandleDown(e, clip, "right"));
            }

            // 纯音频片段：不在视频轨道渲染（仅音频轨道显示波形）
            if (clip.kind === "audio") continue;
            // 离线检测：磁盘上是否存在该片段引用的媒体文件
            const mediaExists = !this.offlineMediaNames.has(clip.filename);
            const el = _el("div", "xzg-ve-clip", null, track);
            el.dataset.clipId = clip.id;
            if (this.selectedClipIds.has(clip.id)) el.classList.add("xzg-ve-selected");
            if (!mediaExists) el.classList.add("xzg-ve-clip-offline");
            // 自定义 3px 向内收边框颜色（持久化值 → CSS 变量）
            if (clip.borderColor) el.style.setProperty("--xzg-ve-clip-border", clip.borderColor);
            el.style.width = `${w}px`;
            el.style.left = `${x}px`;

            // 缩略图带（宽度=片段宽度，裁剪时通过 transform 偏移让左侧被裁掉）+ 底部信息条
            const thumbsWrap = _el("div", "xzg-ve-clip-thumbs", null, el);
            thumbsWrap.style.width = `${w}px`;
            const info = _el("div", "xzg-ve-clip-info", null, el);
            _el("span", "xzg-ve-clip-name", clip.name, info);

            // 离线媒体：显示大红字提示，不加载缩略图
            if (!mediaExists) {
                _el("div", "xzg-ve-clip-offline-label", "离线媒体", thumbsWrap);
            } else {
                // 保留旧缩略图：移入新 thumbsWrap 作为占位（新缩略图加载完后逐步替换）
                const oldImgs = oldThumbsByClipId.get(clip.id);
                if (oldImgs) {
                    for (const img of oldImgs) {
                        thumbsWrap.appendChild(img);
                    }
                }
            }

            // 左右拖拽手柄
            const lh = _el("div", "xzg-ve-clip-handle xzg-ve-clip-handle-left", null, el);
            const rh = _el("div", "xzg-ve-clip-handle xzg-ve-clip-handle-right", null, el);

            // 自由拖动（mousedown 在片段主体，非手柄）
            el.addEventListener("mousedown", (e) => {
                if (e.target === lh || e.target === rh) return;
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
                if (e.target === lh || e.target === rh) return;
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
            // 收集本片段待加载缩略图（离线片段跳过）
            if (!this._tlInHandleDrag && mediaExists) {
                pendingThumbs.push({ wrap: thumbsWrap, clip, width: w });
            }
        }
        // 检测相邻片段并添加桥接手柄（交界处 ±5px，滚动裁剪：左尾+右头同步移动，避免中间断开）
        // 视频片段和音频片段分别在各轨道创建桥接手柄
        const EPS_SEC = 0.02; // 相邻容差（秒），避免浮点误差
        // 视频轨道桥接手柄
        const videoSorted = clipRects.filter(r => r.clip.kind !== "audio").sort((a, b) => a.tlStart - b.tlStart);
        for (let i = 0; i < videoSorted.length - 1; i++) {
            const a = videoSorted[i];
            const b = videoSorted[i + 1];
            const aDur = a.clip.end - a.clip.start;
            const aRight = a.tlStart + aDur;
            const bLeft = b.tlStart;
            if (Math.abs(aRight - bLeft) < EPS_SEC) {
                const bridgeX = a.x + a.w;
                const bridge = _el("div", "xzg-ve-clip-bridge", null, track);
                bridge.style.left = `${bridgeX - 5}px`;
                bridge.style.height = "100%";
                bridge.addEventListener("pointerdown", (e) => this._onBridgeHandleDown(e, a.clip, b.clip));
            }
        }
        // 音频轨道桥接手柄（音频片段之间相邻时创建）
        if (this._tlAudioTrack) {
            const audioSorted = clipRects.filter(r => r.clip.kind === "audio")
                .sort((a, b) => (a.audioTlStart || 0) - (b.audioTlStart || 0));
            for (let i = 0; i < audioSorted.length - 1; i++) {
                const a = audioSorted[i];
                const b = audioSorted[i + 1];
                const aDur = a.clip.end - a.clip.start;
                const aRight = (a.audioTlStart || 0) + aDur;
                const bLeft = (b.audioTlStart || 0);
                if (Math.abs(aRight - bLeft) < EPS_SEC) {
                    const aX = (a.audioTlStart || 0) * pxPerSec;
                    const bridgeX = aX + a.w;
                    const bridge = _el("div", "xzg-ve-clip-bridge", null, this._tlAudioTrack);
                    bridge.style.left = `${bridgeX - 5}px`;
                    bridge.style.height = "100%";
                    bridge.addEventListener("pointerdown", (e) => this._onBridgeHandleDown(e, a.clip, b.clip));
                }
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
        // 音频轨道同样设置尾部占位，保证与视频轨道同步滚动
        if (this._tlAudioTrack) {
            const aTail = _el("div", "xzg-ve-clip-tail-spacer", null, this._tlAudioTrack);
            aTail.style.cssText = `position: absolute; left: ${maxRight - tailPad}px; width: ${tailPad}px; height: 100%;`;
        }
        // 异步加载所有片段缩略图（不阻塞渲染）
        for (const { wrap, clip, width } of pendingThumbs) {
            this._loadClipThumbs(wrap, clip, width);
        }
        // 异步加载所有片段音频波形（不阻塞渲染）
        for (const { el, canvas, clip, width } of pendingWaveforms) {
            this._loadClipWaveform(el, canvas, clip, width);
        }
        // 重渲染后同步播放头位置、时间显示、刻度、横向滚动
        this._renderTicks();
        this._applyTlScroll();
        this._updatePlayhead();
        this._updateTimeDisplay();
    }

    // 片段自由拖动 + 磁吸 + 帧对齐（基于时间轴秒数，非像素）
    // 音视频完全独立：拖动视频只改 tlStart，拖动音频只改 audioTlStart
    // 拖动位置始终对齐到帧边界，确保导出时帧精确
    _startClipDrag(e, clip, clipRects, source = "video") {
        const startX = e.clientX;
        const pxPerSec = this._getPxPerSec();
        const myRect = clipRects.find(r => r.clip === clip);
        // 拖动位置字段：视频用 tlStart，音频用 audioTlStart（完全独立）
        const origField = source === "audio" ? "audioTlStart" : "tlStart";
        const origTlStart = myRect ? (myRect[origField] != null ? myRect[origField] : (clip[origField] || 0)) : (clip[origField] || 0);
        let moved = false;
        this._clipDragged = false;
        const SNAP_SEC = 15 / pxPerSec; // 磁吸阈值（15px，秒）
        let dragEl = null;

        // 帧对齐：将时间量化到最近的帧边界
        const clipFps = this._getClipFps(clip) || 30;
        const snapToFrame = (t) => {
            if (!clipFps || clipFps <= 0) return t;
            return Math.round(t * clipFps) / clipFps;
        };

        // 多选拖动：当前片段在选中集合中且选中数>1时，所有选中片段一起移动（保持相对位置）
        const isMultiDrag = this.selectedClipIds.has(clip.id) && this.selectedClipIds.size > 1;
        // 收集所有需联动的选中片段（排除磁吸参考集合中的非选中片段）
        // group[i] = { c, field, origPos, el }
        const group = [];
        if (isMultiDrag) {
            for (const r of clipRects) {
                if (this.selectedClipIds.has(r.clip.id)) {
                    const field = r.clip.kind === "audio" ? "audioTlStart" : "tlStart";
                    const pos = r[field] != null ? r[field] : (r.clip[field] || 0);
                    group.push({ c: r.clip, field, origPos: pos, el: null, rect: r });
                }
            }
        }
        // 磁吸参考集合：多选拖动时，其他选中片段也作为"已占用"区域，主片段吸附时跳过它们
        const snapSkipIds = isMultiDrag ? this.selectedClipIds : null;

        const move = (ev) => {
            const dx = ev.clientX - startX;
            if (!moved && Math.abs(dx) < 3) return;
            if (!moved) {
                this._pushHistory();
                // 拖动开始时自动选中该片段（多选模式下已在集合中，无需重置）
                if (!isMultiDrag && !this.selectedClipIds.has(clip.id)) {
                    this.selectedClipIds = new Set([clip.id]);
                    this._updateClipSelection();
                    this._renderProps();
                }
            }
            moved = true;
            this._clipDragged = true;
            let newTlStart = origTlStart + dx / pxPerSec;
            newTlStart = Math.max(0, newTlStart);

            // 磁吸：片段左右边缘与时间轴起点(0)及其他片段边缘对齐
            // 其他片段按 kind 选择对应位置字段（音频用 audioTlStart，视频用 tlStart），实现音频↔视频双向吸附
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
                    // 多选拖动：跳过其他选中片段（它们会一起移动，不应作为吸附目标）
                    if (snapSkipIds && snapSkipIds.has(r.clip.id)) continue;
                    const posField = r.clip.kind === "audio" ? "audioTlStart" : "tlStart";
                    const oLeft = r.clip[posField] != null ? r.clip[posField] : (r.tlStart || 0);
                    const oRight = oLeft + (r.clip.end - r.clip.start);
                    if (Math.abs(myLeft - oLeft) < SNAP_SEC) { newTlStart = oLeft; snapped = true; break; }
                    if (Math.abs(myLeft - oRight) < SNAP_SEC) { newTlStart = oRight; snapped = true; break; }
                    if (Math.abs(myRight - oLeft) < SNAP_SEC) { newTlStart = oLeft - myDur; snapped = true; break; }
                    if (Math.abs(myRight - oRight) < SNAP_SEC) { newTlStart = oRight - myDur; snapped = true; break; }
                }
            }
            newTlStart = Math.max(0, newTlStart);
            // 帧对齐：将位置量化到最近的帧边界（磁吸目标已是帧对齐的，对齐不影响吸附结果）
            newTlStart = snapToFrame(newTlStart);

            // 音视频完全独立：仅更新对应轨道的位置字段
            clip[origField] = newTlStart;

            // 直接更新 DOM，避免重建闪烁
            if (source === "video") {
                if (!dragEl) dragEl = this._tlTrack.querySelector(`.xzg-ve-clip[data-clip-id="${clip.id}"]`);
                if (dragEl) {
                    dragEl.style.left = `${newTlStart * pxPerSec}px`;
                    dragEl.style.zIndex = "100";
                }
            } else if (source === "audio" && this._tlAudioTrack) {
                const wfEl = this._tlAudioTrack.querySelector(`.xzg-ve-audio-clip[data-clip-id="${clip.id}"]`);
                if (wfEl) {
                    wfEl.style.left = `${newTlStart * pxPerSec}px`;
                    wfEl.style.zIndex = "100";
                }
            }
            if (myRect) {
                myRect.x = newTlStart * pxPerSec;
                myRect[origField] = newTlStart;
            }

            // 多选拖动：其他选中片段应用相同位移（磁吸后的总位移），并帧对齐
            if (isMultiDrag) {
                const delta = newTlStart - origTlStart;
                for (const g of group) {
                    if (g.c === clip) continue; // 主片段已处理
                    let np = g.origPos + delta;
                    np = Math.max(0, np);
                    // 帧对齐：每个片段用自己的帧率量化
                    const gFps = this._getClipFps(g.c) || 30;
                    if (gFps > 0) np = Math.round(np * gFps) / gFps;
                    g.c[g.field] = np;
                    // 更新 DOM（按片段类型查找对应轨道元素）
                    if (g.el === null) {
                        if (g.c.kind === "audio" && this._tlAudioTrack) {
                            g.el = this._tlAudioTrack.querySelector(`.xzg-ve-audio-clip[data-clip-id="${g.c.id}"]`);
                        } else {
                            g.el = this._tlTrack.querySelector(`.xzg-ve-clip[data-clip-id="${g.c.id}"]`);
                        }
                    }
                    if (g.el) {
                        g.el.style.left = `${np * pxPerSec}px`;
                        g.el.style.zIndex = "100";
                    }
                    if (g.rect) {
                        g.rect.x = np * pxPerSec;
                        g.rect[g.field] = np;
                    }
                }
            }
        };
        const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            if (moved) {
                // 恢复 z-index（主片段 + 多选拖动的其他片段）
                if (dragEl) dragEl.style.zIndex = "";
                if (isMultiDrag) {
                    for (const g of group) {
                        if (g.el && g.c !== clip) g.el.style.zIndex = "";
                    }
                }
                // 音视频完全独立：拖动后均进行重叠裁剪和切割（在各自轨道内）
                // 多选拖动：对所有移动的选中片段都执行裁剪和切割
                if (isMultiDrag) {
                    for (const g of group) {
                        this._applyClipOverlapTrim(g.c);
                        this._splitClipForInsertion(g.c);
                    }
                } else {
                    this._applyClipOverlapTrim(clip);
                    this._splitClipForInsertion(clip);
                }
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
            // 根据源片段类型决定预览框所在轨道
            this._showDragPreview(ev.clientX, srcDur, "center", srcClip.kind || "video");
        };
        const up = (ev) => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            this._hideDragPreview();
            if (moved) {
                // 创建副本，加入 timeline 并设置最终位置（鼠标对应片段中心点）+ 磁吸对齐
                let tlStart = this._clientXToTlStart(ev.clientX, srcDur, "center");
                tlStart = this._snapTlStart(tlStart, srcDur);
                const kind = srcClip.kind || "video";
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
                    skip_audio: srcClip.skip_audio === true ? true : undefined, // 同步「音频已独立拆分」标记
                    // 按 kind 设置对应位置字段：视频用 tlStart，音频用 audioTlStart
                    tlStart: kind === "video" ? tlStart : null,
                    audioTlStart: kind === "audio" ? tlStart : null,
                    kind,
                };
                this.timeline.push(copy);
                this._applyClipOverlapTrim(copy);
                this._splitClipForInsertion(copy);

                // 拖什么复制什么：拖视频只复制视频，拖音频只复制音频
                // 不再自动同步复制配对音频（原 skip_audio 机制下副本视频会静音，
                // 用户如需音频可单独拖动音频片段复制）

                this._renderTimeline();
                this._saveTimelineSession();
            }
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
    }

    // 重叠裁剪：被拖动片段保持完整，被覆盖片段的 start/end 被真正裁剪
    // 所有计算基于时间轴秒数，与 pxPerSec 无关，缩放不影响结果
    // 支持音频片段：按 kind 选择对应位置字段（音频用 audioTlStart，视频用 tlStart）
    _applyClipOverlapTrim(draggedClip) {
        const draggedId = draggedClip ? draggedClip.id : -1;
        const dDur = draggedClip.end - draggedClip.start;
        const dPosField = draggedClip.kind === "audio" ? "audioTlStart" : "tlStart";
        const dLeft = draggedClip[dPosField] != null ? draggedClip[dPosField] : 0;
        const dRight = dLeft + dDur;

        // 收集完全覆盖时需要删除的片段 id（遍历中不能修改数组，统一删除）
        const toDelete = new Set();

        for (const c of this.timeline) {
            if (c.id === draggedId) continue;
            // 音视频完全独立：不同类型的片段互不裁剪
            if ((c.kind || "video") !== (draggedClip.kind || "video")) continue;
            const cDur = c.end - c.start;
            const cPosField = c.kind === "audio" ? "audioTlStart" : "tlStart";
            const cLeft = c[cPosField] != null ? c[cPosField] : 0;
            const cRight = cLeft + cDur;

            // 无重叠
            if (dLeft >= cRight || dRight <= cLeft) continue;

            const overlapSec = Math.min(dRight, cRight) - Math.max(dLeft, cLeft);
            if (overlapSec <= 0) continue;

            if (dLeft > cLeft && dRight < cRight) {
                // 被拖动片段完全在 C 内部（前后都有余量）：跳过，由 _splitClipForInsertion 切割为前后两段
                continue;
            } else if (dLeft <= cLeft && dRight >= cRight) {
                // 被拖动片段完全覆盖 C（含边界重合）→ 直接删除 C，不残留
                toDelete.add(c.id);
            } else if (dLeft >= cLeft) {
                // 被拖动片段覆盖 C 的右侧 → 裁剪 C 的 end 到 dLeft
                c.end = c.start + (dLeft - cLeft);
            } else if (dRight <= cRight) {
                // 被拖动片段覆盖 C 的左侧 → 裁剪 C 的 start，位置右移到 dRight
                c.start = c.start + overlapSec;
                c[cPosField] = dRight;
            }
        }

        // 删除被完全覆盖的片段
        if (toDelete.size > 0) {
            this.timeline = this.timeline.filter(c => !toDelete.has(c.id));
            // 从选中集合中移除已删除的片段
            for (const id of toDelete) this.selectedClipIds.delete(id);
        }
    }

    // 拖放插入切割：新片段完全落入某个现有片段内部时，将该片段切割为前后两段
    // 新片段 [dLeft, dRight] 完全在 C [cLeft, cRight] 内部 → C 切为两段，中间留给新片段
    // 支持音频片段：按 kind 选择对应位置字段
    _splitClipForInsertion(newClip) {
        const dPosField = newClip.kind === "audio" ? "audioTlStart" : "tlStart";
        const dLeft = newClip[dPosField] != null ? newClip[dPosField] : 0;
        const dDur = newClip.end - newClip.start;
        const dRight = dLeft + dDur;

        for (const c of [...this.timeline]) {
            if (c.id === newClip.id) continue;
            // 音视频完全独立：不同类型的片段互不切割
            if ((c.kind || "video") !== (newClip.kind || "video")) continue;
            const cDur = c.end - c.start;
            const cPosField = c.kind === "audio" ? "audioTlStart" : "tlStart";
            const cLeft = c[cPosField] != null ? c[cPosField] : 0;
            const cRight = cLeft + cDur;

            // 新片段完全在 C 内部（C 前后都有余量）
            if (dLeft > cLeft && dRight < cRight) {
                // 切割点在源视频中的时间
                const splitSourceTime = c.start + (dLeft - cLeft);
                const splitSourceEnd = c.start + (dRight - cLeft);

                // 原 C 的前半段保留（start 不变，end 缩短到切割点）
                const origEnd = c.end;
                c.end = splitSourceTime;

                // 创建后半段作为新片段（保留原片段的所有属性）
                // 按 kind 设置对应位置字段：视频用 tlStart，音频用 audioTlStart
                const rightKind = c.kind || "video";
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
                    skip_audio: c.skip_audio === true ? true : undefined,
                    tlStart: rightKind === "audio" ? null : dRight,
                    audioTlStart: rightKind === "audio" ? dRight : null,
                    kind: rightKind,
                };
                this.timeline.push(rightPart);
            }
        }
    }

    // 同步所有视频片段的缩略图（轨道高度变化时调用，按新高度重新计算缩略图数量和宽度）
    _syncAllClipThumbs() {
        if (!this._tlTrack) return;
        const videoClips = this._tlTrack.querySelectorAll(".xzg-ve-clip");
        videoClips.forEach((clipEl) => {
            const cid = parseInt(clipEl.dataset.clipId);
            const clip = this.timeline.find(c => c.id === cid);
            if (!clip || clip.kind === "audio") return;
            const thumbsWrap = clipEl.querySelector(".xzg-ve-clip-thumbs");
            if (!thumbsWrap) return;
            // 用当前片段宽度重新同步（_syncThumbsFromCache 内部会按新高度计算 thumbW）
            const width = parseInt(clipEl.style.width) || clipEl.clientWidth;
            this._syncThumbsFromCache(clip, thumbsWrap, width);
        });
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

        // 缩略图带实际高度（已扣除底部25px色带：CSS top:0; bottom:25px）
        // 必须用 thumbsWrap.clientHeight 而非父片段 clientHeight，否则比例计算错误
        const thumbH = Math.max(20, thumbsWrap.clientHeight || (thumbsWrap.parentElement?.clientHeight || 60) - 25);
        const vw = media.info?.width || 16;
        const vh = media.info?.height || 9;
        const aspect = vw / vh;
        const thumbW = Math.max(20, Math.round(thumbH * aspect));
        // need = 整数张数 + 不足一张时追加1张（末尾显示半张，与达芬奇一致）
        const fullCount = Math.floor(clipWidth / thumbW);
        const need = Math.max(1, fullCount + (clipWidth % thumbW > 0 ? 1 : 0));

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
            existingImgs.push(img);
        }
        // 统一更新所有 img 的宽度（高度变化后 thumbW 改变，已有 img 也需更新）
        // 末尾不足一张缩略图时，最后一张宽度设为剩余宽度（显示半张，与达芬奇一致）
        // 复用上方已计算的 fullCount（同一函数作用域内）
        const remainder = clipWidth - fullCount * thumbW;
        for (let i = 0; i < existingImgs.length; i++) {
            const isLast = i === existingImgs.length - 1;
            existingImgs[i].style.width = (isLast && remainder > 0 && remainder < thumbW) ? remainder + "px" : thumbW + "px";
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
        // 纯音频片段无视频流，跳过缩略图加载（音频轨道显示波形）
        if (clip.kind === "audio" || media.isAudio || media.info?.audio_only === true) return;
        // 图片：用原图填充整个缩略图带（单张拉伸铺满）
        const isImg = _isImage(clip.filename) || media.info?.is_image === true;
        if (isImg) {
            const oldImgs = Array.from(wrap.querySelectorAll("img.xzg-ve-clip-thumb"));
            const img = _el("img", "xzg-ve-clip-thumb", null, wrap);
            img.alt = "";
            img.style.width = clipWidth + "px";
            img.style.height = "100%";
            img.style.objectFit = "cover";
            img.onload = () => {
                img.classList.add("xzg-ve-thumb-loaded");
                for (const old of oldImgs) if (old.isConnected) old.remove();
            };
            img.src = this._videoUrl(clip.filename, clip.type);
            return;
        }
        const t0 = Date.now();
        while (media.probeState !== "ok" && media.probeState !== "failed") {
            if (Date.now() - t0 > 12000) break;
            await new Promise(r => setTimeout(r, 300));
        }
        if (media.probeState !== "ok") return;
        const vw = media.info?.width || 16;
        const vh = media.info?.height || 9;
        const aspect = vw / vh;

        // 缩略图带实际高度（已扣除底部25px色带：CSS top:0; bottom:25px）
        // 必须用 wrap.clientHeight 而非父片段 clientHeight，否则比例计算错误
        // 首次渲染时 wrap 可能尚未回流，用父片段高度减去25px色带作为兜底
        const clipEl = wrap.parentElement;
        const parentH = clipEl ? clipEl.clientHeight : 60;
        const thumbH = Math.max(20, wrap.clientHeight || (parentH - 25));
        // 单张缩略图宽度 = 缩略图带高度 × 视频宽高比
        const thumbW = Math.max(20, Math.round(thumbH * aspect));
        // need = 整数张数 + 不足一张时追加1张（末尾显示半张，与达芬奇一致）
        const fullCount = Math.floor(clipWidth / thumbW);
        const need = Math.max(1, fullCount + (clipWidth % thumbW > 0 ? 1 : 0));

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

        // 末尾不足一张缩略图时，最后一张宽度设为剩余宽度（显示半张，与达芬奇一致）
        // 复用上方已计算的 fullCount 和 remainder（同一函数作用域内）
        const remainder = clipWidth - fullCount * thumbW;

        // 缩放时间线时旧 img 宽度与新 thumbW 不一致 → 会出现空隙显示为黑块
        // 立即调整旧 img 宽度匹配新布局，避免缩放/滚动时空隙（新 img 加载完后淡入替换）
        for (let i = 0; i < oldImgs.length && i < selected.length; i++) {
            const isLast = i === selected.length - 1;
            oldImgs[i].style.width = (isLast && remainder > 0 && remainder < thumbW) ? remainder + "px" : thumbW + "px";
        }
        const newImgs = [];
        for (let i = 0; i < selected.length; i++) {
            const img = _el("img", "xzg-ve-clip-thumb", null, wrap);
            img.alt = "";
            // 最后一张且有剩余空间时，宽度设为剩余宽度；否则用标准宽度
            const isLast = i === selected.length - 1;
            img.style.width = (isLast && remainder > 0 && remainder < thumbW) ? remainder + "px" : thumbW + "px";
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

    // 加载片段音频波形：获取 AudioBuffer → 按 clip 范围提取峰值 → canvas 绘制
    async _loadClipWaveform(el, canvas, clip, clipWidth) {
        const dur = clip.end - clip.start;
        if (dur <= 0 || !el.isConnected) return;
        const mediaKey = `${clip.filename}|${clip.type}`;
        const media = this.mediaLibrary.find(m => m.name === clip.filename && m.type === clip.type);
        const isAudioOnly = clip.kind === "audio" || media?.isAudio || media?.info?.audio_only === true;
        // 从缓存取 AudioBuffer
        let audioBuf = this._audioBufferCache.get(mediaKey);
        if (!audioBuf) {
            try {
                if (isAudioOnly) {
                    // 纯音频文件：用 fetch + AudioContext.decodeAudioData 解码（无视频流，无法用 VideoDecoder）
                    audioBuf = await this._decodeStandaloneAudio(clip.filename, clip.type);
                } else {
                    // 视频文件：用 decoderPool 解码音轨
                    const url = this._videoUrl(clip.filename, clip.type);
                    const decoder = await decoderPool.get(clip.filename, clip.type, url);
                    if (!decoder || !decoder.hasAudio) return;
                    audioBuf = await decoder.decodeFullAudio();
                }
                if (audioBuf) this._audioBufferCache.set(mediaKey, audioBuf);
            } catch (e) {
                console.warn("[小珠光] 波形音频解码失败:", clip.filename, e);
                return;
            }
        }
        if (!audioBuf || !el.isConnected) return;
        // 从 AudioBuffer 提取 clip 范围的峰值数据（按当前 clipWidth 下采样）
        const peaks = this._extractPeaks(audioBuf, clip.start, clip.end, clipWidth);
        if (!peaks) return;
        // 绘制波形到 canvas
        this._drawWaveform(canvas, peaks);
        // 缓存 peaks 到 canvas 元素，便于轨道高度变化时重绘（无需重新解码）
        canvas._xzgPeaks = peaks;
    }

    // 同步从 AudioBuffer 提取指定时间范围的峰值数据（max abs 下采样到指定宽度）
    // 用于波形渲染：拖动裁剪时按新的 start/end 实时提取，避免旧 peaks 被压缩显示
    _extractPeaks(audioBuf, clipStart, clipEnd, width) {
        if (!audioBuf || width <= 0) return null;
        const sr = audioBuf.sampleRate;
        const startSample = Math.floor(clipStart * sr);
        const endSample = Math.min(audioBuf.length, Math.floor(clipEnd * sr));
        const totalSamples = endSample - startSample;
        if (totalSamples <= 0) return null;
        const numCh = audioBuf.numberOfChannels;
        let data;
        if (numCh === 1) {
            data = audioBuf.getChannelData(0);
        } else {
            // 多声道：取第 0 声道（与 _loadClipWaveform 保持一致）
            data = audioBuf.getChannelData(0);
        }
        // 下采样：每像素列对应一个峰值（max abs）
        const peaks = new Float32Array(width);
        const samplesPerPeak = totalSamples / width;
        for (let i = 0; i < width; i++) {
            const s0 = startSample + Math.floor(i * samplesPerPeak);
            const s1 = Math.min(endSample, startSample + Math.floor((i + 1) * samplesPerPeak));
            let peak = 0;
            for (let s = s0; s < s1; s++) {
                const v = Math.abs(data[s]);
                if (v > peak) peak = v;
            }
            peaks[i] = peak;
        }
        return peaks;
    }

    // 按 clip 的当前 start/end 范围重新提取 peaks 并重绘（拖动裁剪时实时刷新波形）
    // width 可选：拖动时传入新宽度避免浏览器未回流时 clientWidth 仍为旧值导致 peaks 长度不匹配
    _refreshWaveformForClip(clip, width) {
        if (clip.kind !== "audio" || !this._tlAudioTrack) return;
        const wfEl = this._tlAudioTrack.querySelector(`.xzg-ve-audio-clip[data-clip-id="${clip.id}"]`);
        if (!wfEl) return;
        const canvas = wfEl.querySelector("canvas.xzg-ve-waveform");
        if (!canvas) return;
        const mediaKey = `${clip.filename}|${clip.type}`;
        const audioBuf = this._audioBufferCache.get(mediaKey);
        if (!audioBuf) return;
        const w = Math.max(1, Math.floor(width != null ? width : (canvas.clientWidth || wfEl.clientWidth)));
        const peaks = this._extractPeaks(audioBuf, clip.start, clip.end, w);
        if (peaks) {
            this._drawWaveform(canvas, peaks, w);
            canvas._xzgPeaks = peaks;
        }
    }

    // 重绘音频轨道所有可见波形（轨道高度变化时调用，波形自适应新高度）
    _redrawAllWaveforms() {
        if (!this._tlAudioTrack) return;
        const clips = this._tlAudioTrack.querySelectorAll(".xzg-ve-audio-clip");
        // 紧凑模式：音频轨道高度<50px时，波形区<色带，波形扩展到色带区域显示（占满整个片段高度）
        const isCompact = this._tlAudioTrack.classList.contains("xzg-ve-audio-compact");
        for (const clipEl of clips) {
            const canvas = clipEl.querySelector("canvas.xzg-ve-waveform");
            if (!canvas || !canvas._xzgPeaks) continue;
            // 用音频片段实际高度计算波形高度（紧凑模式占满，否则扣除底部25px色带）
            const clipH = clipEl.clientHeight || 0;
            const wfH = Math.max(0, isCompact ? clipH : clipH - 25);
            const wfW = parseInt(clipEl.style.width) || clipEl.clientWidth || 0;
            if (wfH <= 0 || wfW <= 0) continue;
            // 设置 canvas 位图尺寸（CSS 尺寸 + dpr 缩放）
            const dpr = window.devicePixelRatio || 1;
            canvas.width = wfW * dpr;
            canvas.height = wfH * dpr;
            canvas.style.width = wfW + "px";
            canvas.style.height = wfH + "px";
            const ctx = canvas.getContext("2d");
            ctx.setTransform(1, 0, 0, 1, 0, 0); // 重置变换矩阵
            ctx.scale(dpr, dpr);
            ctx.clearRect(0, 0, wfW, wfH);
            const midY = wfH / 2;
            const maxH = wfH / 2 - 1;
            ctx.fillStyle = "#fff";
            const peaks = canvas._xzgPeaks;
            const len = peaks.length;
            for (let i = 0; i < len; i++) {
                const peak = peaks[i];
                if (peak <= 0) continue;
                const barH = Math.max(1, peak * maxH);
                const x = (i / len) * wfW;
                const barW = Math.max(1, wfW / len);
                ctx.fillRect(x, midY - barH, barW, barH * 2);
            }
        }
    }

    // 纯音频文件独立解码：fetch 整个文件 → AudioContext.decodeAudioData
    // 缓存在 _audioBufferCache，按 mediaKey 共享（同文件多个片段复用）
    async _decodeStandaloneAudio(filename, type) {
        const mediaKey = `${filename}|${type}`;
        const cached = this._audioBufferCache.get(mediaKey);
        if (cached) return cached;
        this._ensureAudioContext();
        const url = this._videoUrl(filename, type);
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`fetch failed: ${resp.status}`);
        const arrBuf = await resp.arrayBuffer();
        const audioBuf = await this._audioCtx.decodeAudioData(arrBuf);
        this._audioBufferCache.set(mediaKey, audioBuf);
        return audioBuf;
    }

    // 将峰值数据绘制为波形
    // overrideW 可选：拖动时传入明确宽度，避免未回流时 clientWidth 为旧值导致波形错位
    _drawWaveform(canvas, peaks, overrideW) {
        if (!canvas || !canvas.isConnected) return;
        // 读取 canvas 自身尺寸（正常模式扣除25px色带；紧凑模式占满整个片段高度）
        const w = overrideW != null ? overrideW : (canvas.clientWidth || canvas.parentElement?.clientWidth || 0);
        const h = canvas.clientHeight || canvas.parentElement?.clientHeight || 0;
        if (w <= 0 || h <= 0) return;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width = w + "px";
        canvas.style.height = h + "px";
        const ctx = canvas.getContext("2d");
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, w, h);
        // 中线
        const midY = h / 2;
        const maxH = h / 2 - 1; // 上下各留 1px
        // 波形颜色：白色
        ctx.fillStyle = "#fff";
        const len = peaks.length;
        for (let i = 0; i < len; i++) {
            const peak = peaks[i];
            if (peak <= 0) continue;
            const barH = Math.max(1, peak * maxH);
            const x = (i / len) * w;
            const barW = Math.max(1, w / len);
            ctx.fillRect(x, midY - barH, barW, barH * 2);
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

    // 渲染时间刻度（帧对齐：所有刻度落在帧边界上，标签显示帧号）
    // 与播放头帧对齐配合，拖动播放头时吸附到刻度对应的帧
    _renderTicks() {
        const ticks = this._tlTicks;
        if (!ticks) return;
        ticks.innerHTML = "";
        const pxPerSec = this._getPxPerSec();
        const fps = this._getTimelineFps() || 30;
        const frameDur = 1 / fps; // 每帧时长（秒）
        // 刻度始终充满整个可视画布：用视口宽度（含滚动偏移）作为刻度长度
        const viewWidth = this._getViewWidth();
        const scrollLeft = this._tlScrollLeft || 0;
        const ticksWidth = viewWidth + scrollLeft + viewWidth; // 尾部留白 = 视口宽度
        if (ticksWidth <= 0) return;
        // ticks 容器：ticks 是 .xzg-ve-tl-scrub（left:150px）的子元素
        ticks.style.left = "0px";
        ticks.style.width = ticksWidth + "px";

        // 主刻度间隔（帧数）：使主刻度间距约 60-120px
        const candidates = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600];
        let majorFrames = candidates[0];
        for (const f of candidates) {
            const majorPx = f * frameDur * pxPerSec;
            if (majorPx >= 60) { majorFrames = f; break; }
            majorFrames = f;
        }
        // 次刻度细分：主刻度 ÷4（或 ÷5）得中刻度，再 ÷2 得最细刻度
        const subDiv = (majorFrames % 4 === 0) ? 4 : 5;
        const midFrames = Math.max(1, Math.floor(majorFrames / subDiv));
        const minorFrames = Math.max(1, Math.floor(midFrames / 2));

        // 刻度绘制范围 = 可视画布覆盖的帧范围（从 0 帧到 ticksWidth 对应帧数）
        const endTime = ticksWidth / pxPerSec;
        const totalFrames = Math.ceil(endTime * fps);

        // 最细次刻度：按位置是否为 mid/major 决定高度（3级：66% / 30% / 15%）
        for (let f = 0; f <= totalFrames; f += minorFrames) {
            const x = f * frameDur * pxPerSec;
            const tick = _el("div", "xzg-ve-tl-tick", null, ticks);
            tick.style.left = x + "px";
            const isMid = (f % midFrames === 0);
            const isMajor = (f % majorFrames === 0);
            tick.style.height = isMajor ? "66%" : (isMid ? "30%" : "15%");
        }
        // 主刻度 + 帧号标签
        for (let f = 0; f <= totalFrames; f += majorFrames) {
            const x = f * frameDur * pxPerSec;
            const tick = _el("div", "xzg-ve-tl-tick xzg-ve-tl-tick-major", null, ticks);
            tick.style.left = x + "px";
            tick.style.height = "66%";
            const label = _el("div", "xzg-ve-tl-tick-label", String(f), ticks);
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
        this._saveTimelineSession();
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
        this._updatePlayBtn(false);
        this._tlPlaying = false;
        this._tlGlobalTime = 0;
        this._currentClip = null;
        this._updateTimeDisplay();
        this._updatePlayhead();
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
        if (target.closest(".xzg-ve-audio-clip")) return;
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

        // Ctrl/Meta 框选：在已有选中基础上增减；非 Ctrl：清空后重新选
        const initialSelected = (e.ctrlKey || e.metaKey) ? new Set(this.selectedClipIds) : null;
        if (!initialSelected) {
            this.selectedClipIds.clear();
            this._updateClipSelection();
            if (this.selectedMediaNames.size > 0) {
                this.selectedMediaNames.clear();
                this._renderMediaList();
            }
        }

        // 计算当前选择框相交的片段 id（视频 + 音频）
        const calcIntersect = () => {
            const boxRect = box.getBoundingClientRect();
            const ids = new Set();
            this._tlTrack.querySelectorAll(".xzg-ve-clip").forEach((clipEl) => {
                const r = clipEl.getBoundingClientRect();
                const intersect = !(r.right < boxRect.left || r.left > boxRect.right ||
                                     r.bottom < boxRect.top || r.top > boxRect.bottom);
                if (intersect) {
                    const cid = parseInt(clipEl.dataset.clipId);
                    if (this.timeline.some(c => c.id === cid)) ids.add(cid);
                }
            });
            const audioClips = this._tlAudioTrack?.querySelectorAll(".xzg-ve-audio-clip") || [];
            audioClips.forEach((clipEl) => {
                const r = clipEl.getBoundingClientRect();
                const intersect = !(r.right < boxRect.left || r.left > boxRect.right ||
                                     r.bottom < boxRect.top || r.top > boxRect.bottom);
                if (intersect) {
                    const cid = parseInt(clipEl.dataset.clipId);
                    if (this.timeline.some(c => c.id === cid)) ids.add(cid);
                }
            });
            return ids;
        };

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
            // 实时更新选中态：Ctrl 时合并初始选中，否则仅保留相交片段
            const intersectIds = calcIntersect();
            if (initialSelected) {
                this.selectedClipIds = new Set([...initialSelected, ...intersectIds]);
            } else {
                this.selectedClipIds = intersectIds;
            }
            this._updateClipSelection();
        };
        const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
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
            // 点媒体库空白处时清空时间线选中
            if (this.selectedClipIds.size > 0) {
                this.selectedClipIds.clear();
                this._updateClipSelection();
                this._renderProps();
            }
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
        // 拖动手柄时自动选中该片段
        if (!this.selectedClipIds.has(clip.id)) {
            this.selectedClipIds = new Set([clip.id]);
            this._updateClipSelection();
            this._renderProps();
        }
        this._tlInHandleDrag = true;
        const pxPerSec0 = this._getPxPerSec();
        // 构建 clipRects 用于磁吸（按 kind 选择位置字段：音频用 audioTlStart，视频用 tlStart）
        const clipRects = this.timeline.map(c => {
            const dur = c.end - c.start;
            const posField = c.kind === "audio" ? "audioTlStart" : "tlStart";
            const ts = c[posField] != null ? c[posField] : 0;
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
        const isAudioClip = clip.kind === "audio";
        // 音频片段用 audioTlStart 作为位置基准，视频片段用 tlStart
        const posField0 = isAudioClip ? "audioTlStart" : "tlStart";
        const posStart0 = isAudioClip ? (clip.audioTlStart != null ? clip.audioTlStart : 0)
                                      : (clip.tlStart != null ? clip.tlStart : 0);
        const dur0 = end0 - start0;
        const minDuration = 0.1;
        const SNAP_SEC = 15 / pxPerSec0; // 磁吸阈值（15px，秒）

        const move = (ev) => {
            const pxPerSec = this._getPxPerSec();
            const dx = ev.clientX - startX;
            const deltaTime = dx / pxPerSec;

            if (which === "left") {
                // 左手柄：位置字段(tlStart/audioTlStart) 和 start 同步移动 deltaTime，end 不变
                // clamp: start >= 0（源入点不越界），duration >= minDuration
                const maxDelta = dur0 - minDuration;  // 右拖上限（裁头部，最短保留 minDuration）
                const minDelta = -start0;              // 左拖下限（扩展头部到源起点）
                let clampedDelta = Math.max(minDelta, Math.min(maxDelta, deltaTime));
                let newStart = start0 + clampedDelta;
                let newPos = posStart0 + clampedDelta;
                // 磁吸：左边缘(位置)与时间轴起点(0)及其他片段左右边缘对齐
                const myLeft = newPos;
                if (Math.abs(myLeft) < SNAP_SEC) {
                    newPos = 0; newStart = start0 + (newPos - posStart0);
                } else {
                    for (const r of clipRects) {
                        if (r.clip === clip) continue;
                        const oLeft = r.tlStart;
                        const oRight = r.tlStart + (r.clip.end - r.clip.start);
                        if (Math.abs(myLeft - oLeft) < SNAP_SEC) { newPos = oLeft; break; }
                        if (Math.abs(myLeft - oRight) < SNAP_SEC) { newPos = oRight; break; }
                    }
                    newStart = start0 + (newPos - posStart0);
                }
                clip.start = newStart;
                clip[posField0] = newPos;
                clip.end = end0;
            } else {
                // 右手柄：end 移动 deltaTime，位置字段(tlStart/audioTlStart) 和 start 不变
                // clamp: end <= sourceDuration（源出点不越界），duration >= minDuration
                const maxDelta = (sourceDuration === Infinity ? Infinity : sourceDuration - end0);  // 右拖上限（扩展尾部到源末尾）
                const minDelta = -(dur0 - minDuration);  // 左拖下限（裁尾部，最短保留 minDuration）
                let clampedDelta = Math.max(minDelta, Math.min(maxDelta, deltaTime));
                let newEnd = end0 + clampedDelta;
                // 磁吸：右边缘(位置 + dur)与其他片段左右边缘对齐
                const myRight = posStart0 + (newEnd - start0);
                for (const r of clipRects) {
                    if (r.clip === clip) continue;
                    const oLeft = r.tlStart;
                    const oRight = r.tlStart + (r.clip.end - r.clip.start);
                    if (Math.abs(myRight - oLeft) < SNAP_SEC) { newEnd = start0 + (oLeft - posStart0); break; }
                    if (Math.abs(myRight - oRight) < SNAP_SEC) { newEnd = start0 + (oRight - posStart0); break; }
                }
                clip.end = newEnd;
                clip[posField0] = posStart0;
                clip.start = start0;
            }
            // 直接更新片段DOM（不调用 _renderTimeline，避免缩略图重新加载导致重新分布）
            const newPosValue = clip[posField0] != null ? clip[posField0] : 0;
            const newDur = clip.end - clip.start;
            const newWidth = Math.max(30, newDur * pxPerSec);
            const newX = newPosValue * pxPerSec;
            if (isAudioClip) {
                // 纯音频片段：更新音频轨道波形元素
                if (this._tlAudioTrack) {
                    const wfEl = this._tlAudioTrack.querySelector(`.xzg-ve-audio-clip[data-clip-id="${clip.id}"]`);
                    if (wfEl) {
                        wfEl.style.width = `${newWidth}px`;
                        wfEl.style.left = `${newX}px`;
                        wfEl.style.zIndex = "100";
                        // 按裁剪后的 start/end 范围重新提取 peaks，波形实时反映裁剪范围
                        // 传入 newWidth 避免浏览器未回流时 clientWidth 仍为旧值导致 peaks 长度不匹配
                        this._refreshWaveformForClip(clip, newWidth);
                    }
                }
            } else {
                // 视频片段：更新视频轨道元素
                const clipEl = this._tlTrack.querySelector(`[data-clip-id="${clip.id}"]`);
                if (clipEl) {
                    clipEl.style.width = `${newWidth}px`;
                    clipEl.style.left = `${newX}px`;
                    clipEl.style.zIndex = "100";
                    const thumbsWrap = clipEl.querySelector(".xzg-ve-clip-thumbs");
                    if (thumbsWrap) {
                        thumbsWrap.style.width = `${newWidth}px`;
                        thumbsWrap.style.transform = "";
                        this._syncThumbsFromCache(clip, thumbsWrap, newWidth);
                    }
                }
                // 视频片段的音频已独立，不再同步音频轨道
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
            if (this._tlAudioTrack) {
                const wfEl = this._tlAudioTrack.querySelector(`.xzg-ve-audio-clip[data-clip-id="${clip.id}"]`);
                if (wfEl) wfEl.style.zIndex = "";
            }
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
        const rightStart0 = rightClip.start;
        const rightEnd0 = rightClip.end;

        // 按片段类型选择位置字段：音频用 audioTlStart，视频用 tlStart
        const isAudio = leftClip.kind === "audio";
        const posField = isAudio ? "audioTlStart" : "tlStart";
        const leftPos0 = isAudio ? (leftClip.audioTlStart != null ? leftClip.audioTlStart : 0)
                                  : (leftClip.tlStart != null ? leftClip.tlStart : 0);
        const rightPos0 = isAudio ? (rightClip.audioTlStart != null ? rightClip.audioTlStart : 0)
                                    : (rightClip.tlStart != null ? rightClip.tlStart : 0);

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
            rightClip[posField] = rightPos0 + clampedDelta;
            leftClip[posField] = leftPos0;

            const newLeftDur = leftClip.end - leftClip.start;
            const newRightDur = rightClip.end - rightClip.start;
            const newLeftWidth = Math.max(30, newLeftDur * pxPerSec);
            const newRightWidth = Math.max(30, newRightDur * pxPerSec);
            const newRightX = rightClip[posField] * pxPerSec;

            if (isAudio) {
                // 音频片段：更新音频轨道波形元素
                const leftWf = this._tlAudioTrack?.querySelector(`.xzg-ve-audio-clip[data-clip-id="${leftClip.id}"]`);
                if (leftWf) {
                    leftWf.style.width = `${newLeftWidth}px`;
                    leftWf.style.zIndex = "100";
                    // 按裁剪后的 leftClip.end 重新提取 peaks，波形实时反映左片段尾部裁剪
                    // 传入 newLeftWidth 避免浏览器未回流时 clientWidth 仍为旧值导致 peaks 长度不匹配
                    this._refreshWaveformForClip(leftClip, newLeftWidth);
                }
                const rightWf = this._tlAudioTrack?.querySelector(`.xzg-ve-audio-clip[data-clip-id="${rightClip.id}"]`);
                if (rightWf) {
                    rightWf.style.width = `${newRightWidth}px`;
                    rightWf.style.left = `${newRightX}px`;
                    rightWf.style.zIndex = "100";
                    // 按裁剪后的 rightClip.start 重新提取 peaks，波形实时反映右片段头部裁剪
                    // 传入 newRightWidth 避免浏览器未回流时 clientWidth 仍为旧值导致 peaks 长度不匹配
                    this._refreshWaveformForClip(rightClip, newRightWidth);
                }
            } else {
                // 视频片段：更新视频轨道元素
                const leftEl = this._tlTrack.querySelector(`[data-clip-id="${leftClip.id}"]`);
                if (leftEl) {
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
                    rightEl.style.width = `${newRightWidth}px`;
                    rightEl.style.left = `${newRightX}px`;
                    rightEl.style.zIndex = "100";
                    const thumbsWrap = rightEl.querySelector(".xzg-ve-clip-thumbs");
                    if (thumbsWrap) {
                        thumbsWrap.style.width = `${newRightWidth}px`;
                        thumbsWrap.style.transform = "";
                        this._syncThumbsFromCache(rightClip, thumbsWrap, newRightWidth);
                    }
                }
            }
            this._renderProps();
        };
        const up = () => {
            this._tlInHandleDrag = false;
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            // 恢复 z-index
            if (isAudio) {
                const leftWf = this._tlAudioTrack?.querySelector(`.xzg-ve-audio-clip[data-clip-id="${leftClip.id}"]`);
                if (leftWf) leftWf.style.zIndex = "";
                const rightWf = this._tlAudioTrack?.querySelector(`.xzg-ve-audio-clip[data-clip-id="${rightClip.id}"]`);
                if (rightWf) rightWf.style.zIndex = "";
            } else {
                const leftEl = this._tlTrack.querySelector(`[data-clip-id="${leftClip.id}"]`);
                if (leftEl) leftEl.style.zIndex = "";
                const rightEl = this._tlTrack.querySelector(`[data-clip-id="${rightClip.id}"]`);
                if (rightEl) rightEl.style.zIndex = "";
            }
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
        const params = new URLSearchParams({ type: type || "input" });
        // 支持 subfolder 路径（如 'fastcut-cache/video.mp4'），拆分为 subfolder + filename
        const slashIdx = filename.lastIndexOf("/");
        if (slashIdx >= 0) {
            params.set("subfolder", filename.substring(0, slashIdx));
            params.set("filename", filename.substring(slashIdx + 1));
        } else {
            params.set("filename", filename);
        }
        return `/view?${params.toString()}`;
    }

    // 时间线总时长（所有片段在时间轴上覆盖范围的最大末尾）
    _getTimelineTotalDuration() {
        // 返回所有片段末尾位置的最大值（音视频独立轨道，取最远末尾）
        // 纯音频片段用 audioTlStart 定位，视频片段用 tlStart
        // tlStart/audioTlStart 为 null 时按数组顺序自动追加到上一片段末尾
        if (this.timeline.length === 0) return 0;
        let autoEnd = 0;
        let maxEnd = 0;
        for (const clip of this.timeline) {
            const dur = clip.end - clip.start;
            const posField = clip.kind === "audio" ? "audioTlStart" : "tlStart";
            const ts = clip[posField] != null ? clip[posField] : autoEnd;
            const end = ts + dur;
            autoEnd = end;
            if (end > maxEnd) maxEnd = end;
        }
        return maxEnd;
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
    // 磁吸：片段左右边缘吸附到时间轴起点(0)及其他片段边缘，阈值15px
    // 支持音频↔视频双向吸附：遍历所有片段，按其 kind 选择对应位置字段
    // tlStart：当前 tlStart；dur：片段时长；excludeId：拖动中需排除的片段 id（可选）
    _snapTlStart(tlStart, dur, excludeId = null) {
        const pxPerSec = this._getPxPerSec();
        const SNAP_SEC = 15 / pxPerSec;
        const myLeft = tlStart;
        const myRight = tlStart + dur;
        // 吸附到时间轴起点（0）
        if (Math.abs(myLeft) < SNAP_SEC) return 0;
        if (Math.abs(myRight) < SNAP_SEC) return -dur;
        // 吸附到其他片段边缘（音频用 audioTlStart，视频用 tlStart）
        for (const c of this.timeline) {
            if (c.id === excludeId) continue;
            const posField = c.kind === "audio" ? "audioTlStart" : "tlStart";
            const oLeft = c[posField] != null ? c[posField] : 0;
            const oRight = oLeft + (c.end - c.start);
            if (Math.abs(myLeft - oLeft) < SNAP_SEC) return oLeft;
            if (Math.abs(myLeft - oRight) < SNAP_SEC) return oRight;
            if (Math.abs(myRight - oLeft) < SNAP_SEC) return oLeft - dur;
            if (Math.abs(myRight - oRight) < SNAP_SEC) return oRight - dur;
        }
        return Math.max(0, tlStart);
    }
    // 拖放预览：根据鼠标 X 显示半透明片段占位（位置与最终落入位置一致）
    // duration 可选：Alt+拖动复制片段时传入源片段实际时长，媒体库拖入时不传（从 mediaLibrary 查找）
    // align: "left"（默认，媒体库拖入，鼠标对应片段左边缘）或 "center"（Alt+拖动复制，鼠标对应片段中心点）
    // kind: "video"（默认，预览框显示在视频轨道）或 "audio"（预览框显示在音频轨道）
    _showDragPreview(clientX, duration, align = "left", kind = "video") {
        const pxPerSec = this._getPxPerSec();

        let dur = duration;
        if (dur == null) {
            // 获取拖放的媒体信息以计算预览宽度
            const name = this._dragPreviewName;
            dur = 5; // 默认预览时长 5s
            if (name) {
                const media = this.mediaLibrary.find(m => m.name === name);
                // 媒体库音频文件强制 kind=audio
                if (media?.isAudio) kind = "audio";
                const isImg = _isImage(name) || media?.info?.is_image === true;
                if (isImg) {
                    // 图片：duration=0，使用 default_duration（5秒）
                    dur = media?.info?.default_duration || 5;
                } else {
                    const md = media?.info?.duration;
                    if (md && md > 0) dur = md;
                }
            }
        }

        // 鼠标 X → 时间轴秒数（align 控制鼠标对应片段左边缘或中心点）
        let tlStart = this._clientXToTlStart(clientX, dur, align);
        // 磁吸：预览也应用吸附效果，与其他片段边缘对齐
        tlStart = this._snapTlStart(tlStart, dur);
        const leftPx = tlStart * pxPerSec;
        const widthPx = Math.max(30, dur * pxPerSec);

        // 根据片段类型选择预览框所在的轨道
        const targetTrack = kind === "audio" ? this._tlAudioTrack : this._tlTrack;
        if (!targetTrack) return;
        let preview = targetTrack.querySelector(".xzg-ve-clip-preview");
        if (!preview) {
            preview = document.createElement("div");
            preview.className = "xzg-ve-clip-preview";
            targetTrack.appendChild(preview);
        }
        preview.style.left = `${leftPx}px`;
        preview.style.width = `${widthPx}px`;
    }
    _hideDragPreview() {
        // 从两个轨道都移除预览框
        if (this._tlTrack) {
            const v = this._tlTrack.querySelector(".xzg-ve-clip-preview");
            if (v) v.remove();
        }
        if (this._tlAudioTrack) {
            const a = this._tlAudioTrack.querySelector(".xzg-ve-clip-preview");
            if (a) a.remove();
        }
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
        // 同步音频轨道滚动
        if (this._tlAudioTrack) {
            this._tlAudioTrack.scrollLeft = this._tlScrollLeft;
        }
        // 更新片段文件名位置：滚动时文字始终粘在可见区域左侧
        this._updateClipLabels();
        this._updatePlayhead();
    }

    // 片段文件名跟随滚动：当片段左部分超出视口时，文字粘在可见区域左侧
    _updateClipLabels() {
        if (!this._tlTrack) return;
        const scrollLeft = this._tlScrollLeft;
        for (const el of this._tlTrack.querySelectorAll(".xzg-ve-clip")) {
            const clipLeft = parseFloat(el.style.left) || 0;
            const clipWidth = parseFloat(el.style.width) || 0;
            const info = el.querySelector(".xzg-ve-clip-info");
            if (!info) continue;
            // 文字偏移：粘在视口左边缘，但不超过片段右边界（保留 60px 显示空间）
            const offset = Math.max(0, Math.min(scrollLeft - clipLeft, Math.max(0, clipWidth - 60)));
            info.style.left = offset > 0 ? `${offset}px` : "";
        }
    }
    // 播放时自动滚动（达芬奇式）：
    // 1. 播放头从左向右移动，到达视图 95% 位置时触发滚动
    // 2. 片段整体左移，播放头回到视图中间 50% 位置
    // 3. 播放头继续右移，再次到达 95% 时重复，直到内容末尾无法滚动
    _autoScrollToPlayhead() {
        const pxPerSec = this._getPxPerSec();
        const playheadX = this._tlGlobalTime * pxPerSec;
        const viewWidth = this._getViewWidth();
        // 触发阈值：视图右侧 99%
        const triggerThreshold = viewWidth * 0.99;
        // 回落位置：视图中间 50%
        const resetPosition = viewWidth * 0.50;
        // 播放头相对视口的位置
        const playheadInView = playheadX - this._tlScrollLeft;
        // 播放头到达 99% → 滚动使播放头回到 50%
        if (playheadInView > triggerThreshold) {
            this._tlScrollLeft = playheadX - resetPosition;
            this._clampScrollLeft();
            this._applyTlScroll();
            // 检查刻度是否覆盖新可视范围，不够则重新渲染
            const viewWidthNow = this._getViewWidth();
            const requiredWidth = this._tlScrollLeft + viewWidthNow + viewWidthNow;
            const currentWidth = parseFloat(this._tlTicks.style.width) || 0;
            if (currentWidth < requiredWidth) {
                this._renderTicks();
            }
        }
        // 不回滚：播放头左移时不自动滚动（避免拖动播放头时视图跳动）
    }

    // 根据全局时间找到对应的片段及片段内偏移
    // 返回 { clip, clipIndex, localTime } 或 null
    _findClipByGlobalTime(globalTime) {
        // 基于 tlStart/audioTlStart 和片段时长查找，正确处理片段间空隙（空隙处返回 null → 黑屏）
        // 音频片段用 audioTlStart 定位（音频轨道位置），视频片段用 tlStart
        // ⚠️ 两段式查找：优先返回 video 命中；只有时间轴此处无视频片段时才返回纯 audio 命中
        //    防止音视频片段 tlStart 相同时，音频排在 timeline 数组前导致预览显示🎵黑屏
        let audioHit = null;
        for (let i = 0; i < this.timeline.length; i++) {
            const clip = this.timeline[i];
            const dur = clip.end - clip.start;
            if (dur <= 0) continue;
            const clipStart = this._getClipTlStart(clip);
            const clipEnd = clipStart + dur;
            if (globalTime >= clipStart && globalTime < clipEnd) {
                if (clip.kind !== "audio") {
                    // 视频片段命中：直接返回（最高优先级）
                    return { clip, clipIndex: i, localTime: clip.start + (globalTime - clipStart) };
                } else if (!audioHit) {
                    // 独立音频命中：先缓存，等确认此时间点无视频后再返回
                    audioHit = { clip, clipIndex: i, localTime: clip.start + (globalTime - clipStart) };
                }
            }
        }
        // 没有任何 video 命中；若有纯音频命中则返回（画面显示🎵图标占位）
        return audioHit;
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

    // 按 kind 返回片段在时间线上的起始位置（音频用 audioTlStart，视频用 tlStart）
    // null 视为 0；统一所有位置字段访问，避免音频片段误用 tlStart 导致播放头跳跃
    _getClipTlStart(clip) {
        if (!clip) return 0;
        if (clip.kind === "audio") {
            return clip.audioTlStart != null ? clip.audioTlStart : 0;
        }
        return clip.tlStart != null ? clip.tlStart : 0;
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
            this._playingAudioClipId = null;
        }
        this._currentClip = clip;
        this._canvas.classList.add("xzg-ve-active");
        this._previewEmpty.classList.add("xzg-ve-hidden");

        // 纯音频片段：跳过视频解码，黑屏显示音频图标，仅播放音频
        const media = this.mediaLibrary.find(m => m.name === clip.filename && m.type === clip.type);
        const isAudioOnly = clip.kind === "audio" || media?.isAudio || media?.info?.audio_only === true;
        // 图片片段：直接用 Image 加载并绘制到 canvas，无需 VideoDecoder
        const isImageClip = _isImage(clip.filename) || media?.info?.is_image === true;
        if (isImageClip) {
            this._currentDecoder = null;
            this._canvas.classList.add("xzg-ve-active");
            this._previewEmpty.classList.add("xzg-ve-hidden");
            this._hideLoadingOverlay();
            try {
                const url = this._videoUrl(clip.filename, clip.type);
                const img = new Image();
                img.crossOrigin = "anonymous";
                await new Promise((resolve, reject) => {
                    img.onload = resolve;
                    img.onerror = () => reject(new Error("图片加载失败"));
                    img.src = url;
                });
                if (token !== this._loadClipToken) return;
                // 同步 canvas 内部分辨率
                if (img.naturalWidth && img.naturalHeight) {
                    this._canvas.width = img.naturalWidth;
                    this._canvas.height = img.naturalHeight;
                }
                const ctx = this._canvas.getContext("2d");
                ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
                ctx.drawImage(img, 0, 0, this._canvas.width, this._canvas.height);
                // 缓存图片元素供播放循环复用
                this._currentImageEl = img;
                // 加载成功且需要自动播放：启动图片播放循环
                if (autoplay && this._tlPlaying) {
                    this._startPlaybackLoop();
                }
            } catch (e) {
                this._hideLoadingOverlay();
                if (token !== this._loadClipToken) return;
                console.error("[xzg-ve] 加载图片片段失败:", clip.filename, e.message);
                this._setStatus(`加载失败: ${e.message}`);
            }
            return;
        }
        this._currentImageEl = null;
        if (isAudioOnly) {
            this._currentDecoder = null;
            this._clearCanvasForAudio();
            this._hideLoadingOverlay();
            // 预解码音频缓冲（用于播放）
            try {
                if (!this._fullAudioBuffer) {
                    this._fullAudioBuffer = await this._decodeStandaloneAudio(clip.filename, clip.type);
                }
                if (token !== this._loadClipToken) return;
                if (autoplay && this._tlPlaying) {
                    this._startAudioOnlyPlaybackLoop(clip, localTime);
                    this._startAudioPlayback();
                }
                this._updatePlayBtn(this._tlPlaying);
            } catch (e) {
                this._hideLoadingOverlay();
                if (token !== this._loadClipToken) return;
                console.error("[xzg-ve] 加载音频片段失败:", clip.filename, e.message);
                this._setStatus(`加载失败: ${e.message}`);
            }
            return;
        }

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

    // 纯音频片段：清空 canvas 显示音频占位（黑底 + 🎵 图标）
    _clearCanvasForAudio() {
        if (!this._canvas) return;
        const ctx = this._canvas.getContext("2d");
        if (!ctx) return;
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, this._canvas.width, this._canvas.height);
        // 绘制中央🎵图标（简单文字）
        ctx.fillStyle = "#888";
        ctx.font = `${Math.max(40, Math.floor(this._canvas.height / 4))}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("🎵", this._canvas.width / 2, this._canvas.height / 2);
    }

    // 纯音频片段的播放循环：用 RAF 推进 _tlGlobalTime，到达片段末尾切换下一个
    _startAudioOnlyPlaybackLoop(clip, startLocalTime) {
        this._stopPlaybackLoop();
        if (!this._currentClip || this._currentClip.id !== clip.id) return;
        const offset = this._getClipTlStart(clip);
        const clampedStart = Math.min(startLocalTime, clip.end - 0.001);
        this._playbackStartFrame = 0;
        this._playbackStartTime = performance.now() - (clampedStart - clip.start) * 1000;
        const clipId = clip.id;
        const loop = () => {
            if (!this._tlPlaying || !this._currentClip || this._currentClip.id !== clipId) {
                this._playbackRaf = 0;
                return;
            }
            const now = performance.now();
            const elapsedSec = (now - this._playbackStartTime) / 1000;
            const localTime = clip.start + elapsedSec;
            this._tlGlobalTime = offset + (localTime - clip.start);
            this._updatePlayhead();
            this._updateTimeDisplay();
            this._autoScrollToPlayhead();
            if (localTime >= clip.end) {
                this._advanceToNextClip();
                this._playbackRaf = 0;
                return;
            }
            this._playbackRaf = requestAnimationFrame(loop);
        };
        this._playbackRaf = requestAnimationFrame(loop);
    }

    // 加载片段到预览区（仅在添加片段到空时间线时调用，用于首次显示画面）
    _loadClipToPreview(clip) {
        if (!clip) return;
        // 用片段的时间线起始位置作为初始全局时间（音频用 audioTlStart，视频用 tlStart）
        const offset = this._getClipTlStart(clip);
        this._tlGlobalTime = offset;
        this._seekToGlobalTime(offset);
    }

    // 跳转到全局时间（拖动播放头或点击轨道时调用）
    // 用 RAF 节流 + 最近帧降级，实现极致跟手性
    _seekToGlobalTime(globalTime) {
        // 仅保留下限0，去除上限，允许播放头自由拖动到内容区域外
        this._tlGlobalTime = Math.max(0, globalTime);
        this._updatePlayhead();
        this._updateTimeDisplay();
        // 时间线无片段时仅更新播放头位置，不做片段查找
        const total = this._getTimelineTotalDuration();
        if (total <= 0) return;

        const found = this._findClipByGlobalTime(this._tlGlobalTime);
        if (!found) {
            // 空隙处：清空 canvas 显示黑屏，停止当前解码与音频
            this._clearCanvasForGap();
            return;
        }

        // 纯音频片段：仅更新 canvas 占位，不调用视频解码
        if (found.clip.kind === "audio") {
            // 切换到该片段时清空 canvas 为音频占位，并预加载音频缓冲
            if (!this._currentClip || this._currentClip.id !== found.clip.id) {
                this._currentClip = found.clip;
                this._currentDecoder = null;
                this._fullAudioBuffer = null;  // 切换片段时清空，触发重新解码
                this._playingAudioClipId = null;
                this._clearCanvasForAudio();
                this._decodeStandaloneAudio(found.clip.filename, found.clip.type).then(buf => {
                    if (buf && this._currentClip && this._currentClip.id === found.clip.id) {
                        this._fullAudioBuffer = buf;
                    }
                }).catch(e => console.warn("[小珠光] 音频预解码失败:", e));
            }
            return;
        }

        // 同一片段：直接解码目标帧（不重新加载解码器，避免闪烁）
        // 图片片段无解码器：同一图片无需重新加载（画面保持不变）
        if (this._currentClip && this._currentClip.id === found.clip.id && (this._currentDecoder || this._currentImageEl)) {
            if (this._currentDecoder) {
                const fps = this._currentDecoder.fps || 30;
                const targetFrame = Math.max(0, Math.min(
                    Math.round(found.localTime * fps),
                    Math.max(0, this._currentDecoder.frameCount - 1)
                ));
                // renderFrame 内部带缓存 + 最近帧降级 + RAF 节流
                this._currentDecoder.renderFrame(targetFrame, this._canvas, true);
            }
            return;
        }
        // 切换片段：异步加载新解码器
        this._loadClipAtTime(found.clip, found.localTime, this._tlPlaying);
    }

    // 拖动播放头时的 RAF 节流（合并 mousemove 到每帧一次）
    _scheduleScrubSeek(globalTime) {
        // 仅保留下限0，去除上限，允许播放头自由拖动到内容区域外
        this._tlGlobalTime = Math.max(0, globalTime);
        this._updatePlayhead();
        this._updateTimeDisplay();
        if (this._scrubRafId) return;
        this._scrubRafId = requestAnimationFrame(() => {
            this._scrubRafId = null;
            // 延迟读取 _tlGlobalTime，确保用最新值
            const gt = this._tlGlobalTime;
            const found = this._findClipByGlobalTime(gt);
            if (!found) return;
            // 纯音频片段：仅更新播放头位置，不调用视频解码
            if (found.clip.kind === "audio") {
                if (!this._currentClip || this._currentClip.id !== found.clip.id) {
                    this._currentClip = found.clip;
                    this._currentDecoder = null;
                    this._fullAudioBuffer = null;
                    this._playingAudioClipId = null;
                    this._clearCanvasForAudio();
                    this._decodeStandaloneAudio(found.clip.filename, found.clip.type).then(buf => {
                        if (buf && this._currentClip && this._currentClip.id === found.clip.id) {
                            this._fullAudioBuffer = buf;
                        }
                    }).catch(e => console.warn("[小珠光] 音频预解码失败:", e));
                }
                return;
            }
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
                // 纯音频片段：用独立播放循环（无视频解码）
                if (found.clip.kind === "audio") {
                    if (this._currentClip && this._currentClip.id === found.clip.id) {
                        // 同片段且音频缓冲已就绪：直接启动音频循环
                        this._startAudioOnlyPlaybackLoop(found.clip, found.localTime);
                        this._startAudioPlayback();
                    } else {
                        this._loadClipAtTime(found.clip, found.localTime, true);
                    }
                } else if (this._currentClip && this._currentClip.id === found.clip.id && (this._currentDecoder || this._currentImageEl)) {
                    // 同一片段且解码器/图片已就绪：直接启动播放循环
                    this._startPlaybackLoop();
                    this._startAudioPlayback();
                } else {
                    // 切换到目标片段，加载完成后启动播放（_loadClipAtTime 内部启动播放循环）
                    this._loadClipAtTime(found.clip, found.localTime, true);
                }
            } else {
                // 空隙处：找下一个片段，启动空隙等待
                const candidates = this.timeline
                    .map(c => ({ clip: c, tlStart: this._getClipTlStart(c), dur: c.end - c.start }))
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
    // 帧率：按编辑器帧率输入框的设置（_getClipFps），与渲染输出一致
    // 丢帧补帧：复用节点 Bresenham floor 规则 —— 输出第 k 帧 = floor(k × source_fps / target_fps)
    //   降帧（src>dst）：跳过中间帧，只显示 floor 映射对应的源帧
    //   升帧（src<dst）：重复显示前一帧，直到下一源帧的 floor 映射到达
    //   视频时长不变（基于时间推进，不基于源帧数）
    _startPlaybackLoop() {
        this._stopPlaybackLoop();
        if (!this._currentClip) return;
        // 图片片段：无解码器，用轻量循环推进时间线（画面保持静止）
        if (!this._currentDecoder && this._currentImageEl) {
            this._startImagePlaybackLoop();
            return;
        }
        if (!this._currentDecoder) return;

        const clip = this._currentClip;
        const decoder = this._currentDecoder;
        const clipId = clip.id;  // E6: 闭包捕获 clipId 用于存活检查
        const targetFps = this._getClipFps(clip);  // 编辑器设置的目标帧率
        const srcFps = decoder.fps || targetFps;   // 视频原始帧率
        // 基于 tlStart/audioTlStart 计算片段全局偏移（正确处理空隙，音频用 audioTlStart）
        const offset = this._getClipTlStart(clip);
        const startLocalTime = clip.start + (this._tlGlobalTime - offset);
        // E11: 边界保护 —— 起始位置超过片段末尾时 clamp
        const clampedStart = Math.min(startLocalTime, clip.end - 0.001);
        // 起始目标帧号（基于目标帧率）
        const startTargetFrame = Math.max(0, Math.round(clampedStart * targetFps));

        // 创建播放迭代器（从当前位置顺序解码，按视频原始帧率解码）
        this._playbackIterator = decoder.createPlaybackIterator(clampedStart);
        this._playbackIteratorDone = false;
        this._playbackBuffer = [];
        this._playbackStartFrame = startTargetFrame;
        this._playbackStartTime = performance.now();
        this._isBuffering = false;
        this._lastShownFrame = null;  // 升帧率时重复显示的上一帧

        // 启动预缓冲
        this._fillPlaybackBuffer();

        const frameDuration = 1000 / targetFps;  // 目标帧率下的每帧时长
        let lastFrame = startTargetFrame;
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
                    // 当前目标帧号（0-based，基于目标帧率）
                    const targetFrameIdx = lastFrame + 1;
                    // Bresenham floor 映射：目标第 k 帧对应源第 floor(k × srcFps / targetFps) 帧
                    const srcFrameIdx = Math.floor(targetFrameIdx * srcFps / targetFps);
                    // 源帧对应的时间点（秒）
                    const srcVideoTime = srcFrameIdx / srcFps;
                    // 从 buffer 取出所有早于 srcVideoTime 的帧，保留最后一个（跳过被丢弃的帧）
                    let frame = this._lastShownFrame;
                    while (this._playbackBuffer.length > 0 && this._playbackBuffer[0].timestamp <= srcVideoTime + 0.001) {
                        frame = this._playbackBuffer.shift();
                    }
                    if (frame) {
                        this._lastShownFrame = frame;
                        // 绘制到 canvas
                        const ctx = this._canvas.getContext('2d');
                        ctx.drawImage(frame.canvas, 0, 0, decoder.previewWidth || decoder.width, decoder.previewHeight || decoder.height);
                        // 更新全局时间：按目标帧率推进（与渲染输出一致）
                        this._tlGlobalTime = offset + (targetFrameIdx / targetFps - clip.start);
                        lastFrame++;
                        this._updatePlayhead();
                        this._updateTimeDisplay();
                        this._autoScrollToPlayhead();
                        // 持续预缓冲
                        this._fillPlaybackBuffer();
                    } else if (this._playbackBuffer.length === 0) {
                        // buffer 为空且无上一帧：等待预缓冲
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
            // 缓冲区为空且迭代器已结束（无更多帧可解码）：当前片段已播放完毕，切换下一个
            // 不做循环播放：迭代器耗尽即结束，不再用 renderFrame 逐帧渲染后半段
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
                if (result.done) {
                    this._playbackIteratorDone = true;
                    console.warn(`[小珠光] 迭代器耗尽 clip=${this._currentClip?.filename} startLocalTime=${(this._currentClip?.start||0)} bufferLen=${this._playbackBuffer.length}`);
                    break;
                }
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
        this._lastShownFrame = null;
    }

    // 当前片段播放完毕，切换到下一个片段
    // E2: 停止旧音频 + 新片段音频由 _loadClipAtTime 内部启动
    _advanceToNextClip() {
        if (!this._currentClip) return;
        const clipDur = this._currentClip.end - this._currentClip.start;
        const curTlStart = this._getClipTlStart(this._currentClip);
        this._tlGlobalTime = curTlStart + clipDur;
        if (!this._tlPlaying) return;

        // 按时间线起始位置排序找到下一个片段（拖放后数组顺序可能不按时间排列）
        // 音频用 audioTlStart，视频用 tlStart（统一通过 _getClipTlStart 取值）
        const curTlEnd = this._tlGlobalTime;
        // 容差 +0.001：排除与当前片段同时结束的片段（同文件的视频/音频片段起始位置和时长相同）
        const candidates = this.timeline
            .filter(c => c.id !== this._currentClip.id)
            .map(c => ({ clip: c, tlStart: this._getClipTlStart(c), dur: c.end - c.start }))
            .filter(x => x.dur > 0 && x.tlStart + x.dur > curTlEnd + 0.001)
            .sort((a, b) => a.tlStart - b.tlStart);

        if (candidates.length > 0) {
            const next = candidates[0].clip;
            const nextTlStart = this._getClipTlStart(next);
            // 空隙处理：若下一个片段的起始位置大于当前全局时间，先进入空隙黑屏等待
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
    // 图片播放循环：仅推进时间线，画面保持静止，到达片段末尾时加载下一个片段
    _startImagePlaybackLoop() {
        const clip = this._currentClip;
        if (!clip) return;
        const clipId = clip.id;
        const offset = this._getClipTlStart(clip);
        const clipEndGlobal = offset + (clip.end - clip.start);
        let lastTime = performance.now();
        const loop = () => {
            if (!this._tlPlaying || !this._currentClip || this._currentClip.id !== clipId) {
                this._playbackRaf = 0;
                return;
            }
            const now = performance.now();
            const dt = (now - lastTime) / 1000;
            lastTime = now;
            this._tlGlobalTime += dt;
            // 到达片段末尾：停止并切换到下一个片段
            if (this._tlGlobalTime >= clipEndGlobal - 0.001) {
                this._tlGlobalTime = clipEndGlobal;
                this._stopPlaybackLoop();
                this._advanceToNextClip();
                return;
            }
            this._updatePlayhead();
            this._updateTimeDisplay();
            this._autoScrollToPlayhead();
            this._playbackRaf = requestAnimationFrame(loop);
        };
        this._playbackRaf = requestAnimationFrame(loop);
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
        // 在当前 _tlGlobalTime 时间点：
        //   1. 优先找 timeline 上命中的 kind=audio 独立片段（按 audioTlStart 计算范围）
        //   2. 只有命中了独立音频片段才播放（未命中则完全静音）
        //   3. 不再从 video decoder 提取音轨 —— 因为独立音频片段支持任意拖动、裁剪、错位，
        //      必须按 timeline 上独立音频片段的编辑结果来播放，才能与后端 render_timeline 导出保持一致
        let audioClip = null;
        const gt = this._tlGlobalTime;
        for (let i = 0; i < this.timeline.length; i++) {
            const c = this.timeline[i];
            if (c.kind !== "audio") continue;
            const dur = c.end - c.start;
            if (dur <= 0) continue;
            const cs = c.audioTlStart != null ? c.audioTlStart : 0;
            const ce = cs + dur;
            if (gt >= cs && gt < ce) {
                audioClip = c;
                break;
            }
        }
        // 没找到当前时间点要播的独立音频 → 静音
        if (!audioClip) return;
        // 切换了新的音频 clip → 清空缓存，触发重新解码
        if (this._playingAudioClipId !== audioClip.id) {
            this._fullAudioBuffer = null;
            this._playingAudioClipId = audioClip.id;
        }
        this._ensureAudioContext();
        // 首次播放（或切换 clip 后）：用 decodeStandaloneAudio 解码，不依赖 video decoder
        // 这样无论 audioClip 是「纯音频文件」还是「视频拆分出来的独立音轨」都可以统一处理
        if (!this._fullAudioBuffer) {
            try {
                this._fullAudioBuffer = await this._decodeStandaloneAudio(audioClip.filename, audioClip.type);
            } catch (e) {
                console.warn("[xzg-ve] 独立音频解码失败:", audioClip.filename, e.message);
                this._fullAudioBuffer = null;
            }
        }
        if (!this._fullAudioBuffer) return;
        const clip = audioClip;
        const offset = clip.audioTlStart != null ? clip.audioTlStart : 0;
        const localTime = clip.start + (gt - offset);
        const clampedLocal = Math.max(clip.start, Math.min(clip.end - 0.001, localTime));
        this._stopAudioSource();
        try {
            this._audioSource = this._audioCtx.createBufferSource();
            this._audioSource.buffer = this._fullAudioBuffer;
            this._audioSource.connect(this._audioGain);
            this._audioSource.start(0, clampedLocal);
            this._audioPlayStartOffset = clampedLocal;
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
        this._playingAudioClipId = null;
    }

    _updatePlayhead() {
        const pxPerSec = this._getPxPerSec();
        // 播放头位置 = 左侧占位 + 时间×pxPerSec - 滚动偏移
        let x = this._tlLeftPad + this._tlGlobalTime * pxPerSec - this._tlScrollLeft;
        // 下限：左侧占位区分界线（不随滚动变化，占位区是 fixed 不滚动的）
        x = Math.max(x, this._tlLeftPad);
        this._playhead.style.left = x + "px";
        this._playhead.classList.add("xzg-ve-active");
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

    // 获取统一帧率：读取编辑器帧率输入框（>0 时用该帧率），否则回退到片段原始帧率
    _getClipFps(clip) {
        // 编辑器内帧率输入框 > 0 时统一使用该帧率
        const fpsInput = this._root?.querySelector(".xzg-ve-render-fps");
        const fpsVal = Number(fpsInput?.value || 0);
        if (fpsVal > 0) return fpsVal;
        // 回退：片段自身原始帧率
        const media = this.mediaLibrary.find(m => m.name === clip.filename && m.type === clip.type);
        return media?.info?.fps || 30;
    }

    // 时间轴统一帧率：用于播放头帧对齐（导出 fps 优先，未设置则回退 30）
    _getTimelineFps() {
        const fpsInput = this._root?.querySelector(".xzg-ve-render-fps");
        const fpsVal = Number(fpsInput?.value || 0);
        if (fpsVal > 0) return fpsVal;
        return 30;
    }

    // 鼠标 X 坐标 → 全局时间（考虑左侧占位、缩放和横向滚动）
    // 帧对齐：拖动播放头时最小调整单位为 1 帧，对齐到时间轴统一帧率边界
    _mouseXToGlobalTime(e) {
        const pxPerSec = this._getPxPerSec();
        if (pxPerSec <= 0) return null;
        const rect = this._timeline.getBoundingClientRect();
        // 内容区起点 = timeline左 + 左侧占位（刻度0与左侧分界线对齐）
        const contentLeft = rect.left + this._tlLeftPad;
        // 鼠标在内容中的位置 = 可见位置 + 滚动偏移
        const x = e.clientX - contentLeft + this._tlScrollLeft;
        const t = x / pxPerSec;
        // 仅保留下限0，允许自由拖动到内容区域外
        let tt = Math.max(0, t);
        // 帧对齐：量化到最近的帧边界（最小单位 1 帧）
        const fps = this._getTimelineFps();
        if (fps > 0) tt = Math.round(tt * fps) / fps;
        return tt;
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
        // 同步音频轨道波形元素的选中态
        if (this._tlAudioTrack) {
            for (const el of this._tlAudioTrack.querySelectorAll(".xzg-ve-audio-clip")) {
                const id = parseInt(el.dataset.clipId);
                if (this.selectedClipIds.has(id)) {
                    el.classList.add("xzg-ve-selected");
                } else {
                    el.classList.remove("xzg-ve-selected");
                }
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
        const offset = this._getClipTlStart(this._currentClip);
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
        // 跳过纯音频片段，查找首个有视频流的片段用于同步分辨率
        let first = null;
        for (const clip of this.timeline) {
            const m = this.mediaLibrary.find(media => media.name === clip.filename && media.type === (clip.type || "input"));
            if (m && m.info && m.info.width > 0 && m.info.height > 0) {
                first = m;
                break;
            }
        }
        if (!first) return;
        const w = first.info.width;
        const h = first.info.height;
        if (w > 0 && h > 0) {
            const wInput = this._root.querySelector(".xzg-ve-render-w");
            const hInput = this._root.querySelector(".xzg-ve-render-h");
            const presetsSel = this._root.querySelector(".xzg-ve-render-presets");
            const portraitBtn = this._root.querySelector(".xzg-ve-btn-portrait");
            const portraitLockBtn = this._root.querySelector(".xzg-ve-portrait-lock");
            const fpsInput = this._root.querySelector(".xzg-ve-render-fps");
            if (wInput) { wInput.value = w; wInput.disabled = false; }
            if (hInput) { hInput.value = h; hInput.disabled = false; }
            if (presetsSel) { presetsSel.value = "0"; presetsSel.disabled = false; }
            if (portraitBtn) portraitBtn.disabled = false;
            if (portraitLockBtn) {
                portraitLockBtn.disabled = false;
                // 分辨率已是竖屏（宽<高）则激活对勾
                portraitLockBtn.classList.toggle("xzg-ve-active", w < h);
            }
            // 帧率：默认填入首个片段原始帧率，用户可修改
            // 图片 fps=0，使用默认 30
            const effectiveFps = first.info.fps || (first.info.is_image ? 30 : 0);
            if (fpsInput && effectiveFps > 0) {
                fpsInput.value = effectiveFps;
                fpsInput.disabled = false;
                // 同步下拉选中项：匹配预设则选中对应项，不匹配则选"自定义"
                const fpsSelEl = this._root.querySelector(".xzg-ve-render-fps-sel");
                if (fpsSelEl) {
                    fpsSelEl.disabled = false;
                    const target = String(effectiveFps);
                    let matched = false;
                    for (const opt of fpsSelEl.options) {
                        if (opt.value === target) { fpsSelEl.value = target; matched = true; break; }
                    }
                    if (!matched) {
                        fpsSelEl.value = "0";
                        // 非预设值，输入框保持可编辑（自定义）
                        fpsInput.disabled = false;
                    } else {
                        // 命中预设，输入框禁用（与 onchange 行为一致）
                        fpsInput.disabled = true;
                    }
                }
            }
        }
    }

    // 无片段时禁用所有分辨率控件并显示 --
    _disableRenderOpts() {
        const wInput = this._root.querySelector(".xzg-ve-render-w");
        const hInput = this._root.querySelector(".xzg-ve-render-h");
        const presetsSel = this._root.querySelector(".xzg-ve-render-presets");
        const portraitBtn = this._root.querySelector(".xzg-ve-btn-portrait");
        const portraitLockBtn = this._root.querySelector(".xzg-ve-portrait-lock");
        const fpsInput = this._root.querySelector(".xzg-ve-render-fps");
        if (wInput) { wInput.value = ""; wInput.disabled = true; }
        if (hInput) { hInput.value = ""; hInput.disabled = true; }
        if (presetsSel) { presetsSel.value = "0"; presetsSel.disabled = true; }
        if (portraitBtn) portraitBtn.disabled = true;
        if (portraitLockBtn) { portraitLockBtn.disabled = true; portraitLockBtn.classList.remove("xzg-ve-active"); }
        if (fpsInput) { fpsInput.value = ""; fpsInput.disabled = true; }
        const fpsSelDis = this._root.querySelector(".xzg-ve-render-fps-sel");
        if (fpsSelDis) { fpsSelDis.value = "0"; fpsSelDis.disabled = true; }
    }

    // ═══════════════════════════════════════════════════════════
    //  文件夹选择对话框：复用小珠光图像保存-化神级的全局 _xzgShowDirBrowser
    //  （无需自定义对话框，通过模拟 node + widget 对接全局对话框）
    // ═══════════════════════════════════════════════════════════

    async _render() {
        if (this.timeline.length === 0) {
            this._setStatus("时间线为空");
            return;
        }
        const btn = this._root.querySelector(".xzg-ve-btn-apply");
        btn.disabled = true;
        btn.textContent = "导出中...";
        // 渲染数据：包含视频和音频片段，各自计算时间线位置
        // 视频用 tlStart，音频用 audioTlStart；为 null 时各自自动追加
        // ════════════════════════════════════════════════════════
        // 先按实际位置字段排序计算基准 autoEnd，避免 timeline 数组乱序导致 null 片段错位
        const videoClipsSorted = [...this.timeline].filter(c => c.kind !== "audio")
            .sort((a, b) => {
                const at = a.tlStart != null ? a.tlStart : Infinity;
                const bt = b.tlStart != null ? b.tlStart : Infinity;
                return at - bt;
            });
        const audioClipsSorted = [...this.timeline].filter(c => c.kind === "audio")
            .sort((a, b) => {
                const at = a.audioTlStart != null ? a.audioTlStart : Infinity;
                const bt = b.audioTlStart != null ? b.audioTlStart : Infinity;
                return at - bt;
            });
        // 计算基准末尾：所有显式定位片段的最大终点 + null 片段按顺序占用的时长
        let baseEndVideo = 0;
        for (const c of videoClipsSorted) {
            if (c.tlStart != null) baseEndVideo = Math.max(baseEndVideo, c.tlStart + (c.end - c.start));
            else baseEndVideo += (c.end - c.start);
        }
        let baseEndAudio = 0;
        for (const c of audioClipsSorted) {
            if (c.audioTlStart != null) baseEndAudio = Math.max(baseEndAudio, c.audioTlStart + (c.end - c.start));
            else baseEndAudio += (c.end - c.start);
        }

        const tlData = [];
        let accVideo = 0;
        let accAudio = 0;
        for (const c of this.timeline) {
            const dur = c.end - c.start;
            if (c.kind === "audio") {
                let ts;
                if (c.audioTlStart != null) {
                    ts = c.audioTlStart;
                    accAudio = Math.max(accAudio, ts + dur);
                } else {
                    ts = accAudio >= baseEndAudio ? accAudio : baseEndAudio;
                    if (ts < accAudio) ts = accAudio;
                    accAudio = ts + dur;
                }
                tlData.push({
                    filename: c.filename,
                    type: c.type,
                    start: c.start,
                    end: c.end,
                    kind: "audio",
                    tlStart: ts,
                });
            } else {
                let ts;
                if (c.tlStart != null) {
                    ts = c.tlStart;
                    accVideo = Math.max(accVideo, ts + dur);
                } else {
                    ts = accVideo >= baseEndVideo ? accVideo : baseEndVideo;
                    if (ts < accVideo) ts = accVideo;
                    accVideo = ts + dur;
                }
                const vEntry = {
                    filename: c.filename,
                    type: c.type,
                    start: c.start,
                    end: c.end,
                    kind: "video",
                    tlStart: ts,
                };
                // 独立音频拆分标记：true 时告诉后端不要从该视频再自动提音频（即使源 has_audio=true）
                if (c.skip_audio === true) vEntry.skip_audio = true;
                tlData.push(vEntry);
            }
        }
        this._setStatus(`正在渲染 ${tlData.length} 个片段...`);
        // 渲染参数：帧率读取编辑器帧率输入框（_getClipFps），与预览播放一致
        // 分辨率：读取宽/高输入框，0 表示用首个片段原分辨率
        const renderOpts = { timeline: tlData };
        // 输出目录设置（与化神级一致）：use_default_output / base_dir / filename_prefix / 日期戳 / 时间戳
        renderOpts.use_default_output = this._useDefaultOutput;
        if (!this._useDefaultOutput) {
            renderOpts.base_dir = this._baseDir || "";
            renderOpts.filename_prefix = this._filenamePrefix || "xzg-edit";
            renderOpts.add_date_stamp = this._addDateStamp;
            renderOpts.add_time_stamp = this._addTimeStamp;
            // 非默认输出但未选目录：提示用户先设置
            if (!this._baseDir) {
                this._setStatus("请先点击\"输出目录设置\"选择输出目录");
                btn.disabled = false;
                btn.textContent = "导出";
                return;
            }
        }
        // 传入帧率给后端（>0 时覆盖首个片段帧率）
        if (this.timeline.length > 0) {
            const fps = this._getClipFps(this.timeline[0]);
            if (fps > 0) renderOpts.target_fps = fps;
        }
        const wInput = this._root.querySelector(".xzg-ve-render-w");
        const hInput = this._root.querySelector(".xzg-ve-render-h");
        const tw = Math.max(0, Math.round(Number(wInput?.value || 0)));
        const th = Math.max(0, Math.round(Number(hInput?.value || 0)));
        if (tw > 0 && th > 0) {
            renderOpts.target_width = tw;
            renderOpts.target_height = th;
        }
        // 质量等级：high/medium/low 传给后端决定 CRF/CQ
        const qSel = this._root.querySelector(".xzg-ve-quality-select");
        if (qSel && qSel.value) renderOpts.quality = qSel.value;
        try {
            const data = await _postJson(API_RENDER, renderOpts);
            if (data.error) throw new Error(data.error);
            // 导出成功提示：显示文件名和保存位置
            const locLabel = this._useDefaultOutput
                ? "ComfyUI output 目录"
                : (this._baseDir || "output 目录");
            this._setStatus(`✅ 已导出: ${data.filename} （保存到 ${locLabel}）`);
            btn.disabled = false;
            btn.textContent = "导出";
        } catch (e) {
            this._setStatus(`导出失败: ${e.message}`);
            btn.disabled = false;
            btn.textContent = "导出";
        }
    }

    _cancel() {
        this.close();
    }

    // 保存输出目录设置到 localStorage（与化神级一致的字段名）
    _saveOutputSettings() {
        try {
            localStorage.setItem(this._xzgVeOutputKey, JSON.stringify({
                use_default_output: this._useDefaultOutput,
                base_dir: this._baseDir,
                filename_prefix: this._filenamePrefix,
                add_date_stamp: this._addDateStamp,
                add_time_stamp: this._addTimeStamp,
            }));
        } catch (_) {}
    }

    _setStatus(msg) {
        if (this._status) this._status.textContent = msg;
    }
}

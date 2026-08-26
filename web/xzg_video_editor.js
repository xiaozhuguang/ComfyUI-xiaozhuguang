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
import { app } from "../../scripts/app.js";
import { decoderPool, VideoDecoderInstance } from "./xzg_frame_decoder.js";
import { downloadVideo, xzgDownload, downloadAudio } from "./xzg_save_utils.js";

const API_PROBE = "/xzg_video_editor_probe";
const API_EXTRACT = "/xzg_video_editor_extract_frame";
const API_THUMBS_FULL = "/xzg_video_editor_extract_thumbs_full";
const API_PROBE_AND_THUMBS = "/xzg_video_editor_probe_and_thumbs";
const API_RENDER = "/xzg_video_editor_render";

// 快剪界面导出分辨率/帧率持久化键：编辑器导出时写入，silentRender（加载器快速导出）读取保持一致
const XZG_VE_RENDER_SETTINGS_KEY = "xzg_ve_render_settings";

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
            track: c.track || (c.kind === "audio" ? "a1" : "v1"),
            skip_audio: c.skip_audio === true ? true : undefined,
            pairedWith: c.pairedWith != null ? c.pairedWith : undefined,
            scale: c.scale != null ? c.scale : 1,
            offsetX: c.offsetX != null ? c.offsetX : 0,
            offsetY: c.offsetY != null ? c.offsetY : 0,
            cropLeft: c.cropLeft != null ? c.cropLeft : 0,
            cropRight: c.cropRight != null ? c.cropRight : 0,
            cropTop: c.cropTop != null ? c.cropTop : 0,
            cropBottom: c.cropBottom != null ? c.cropBottom : 0,
            opacity: c.opacity != null ? c.opacity : 1,
            volume: c.volume != null ? c.volume : 1,
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

// 小珠光风格确认对话框（替代原生 confirm）
// 样式参考小珠光工作流管理/图像加载器的统一确认对话框：
//   半透明遮罩 + 居中深色圆角对话框 + 金色(#dcc85b)确定按钮
// 返回 Promise<boolean>：确定 → true，取消/点击遮罩/Escape → false
function _xzgVeConfirm(message, okText) {
    return new Promise((resolve) => {
        const overlay = document.createElement("div");
        overlay.style.cssText =
            "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);" +
            "z-index:999999;display:flex;align-items:center;justify-content:center;";
        const close = (val) => { overlay.remove(); resolve(val); };
        overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) close(false); });

        const dialog = document.createElement("div");
        dialog.style.cssText =
            "background:#1e1e1e;border:1px solid #3a3a3a;border-top:2px solid #dcc85b;" +
            "border-radius:8px;padding:18px 22px;min-width:320px;max-width:90vw;" +
            "box-shadow:0 4px 24px rgba(0,0,0,0.6);";
        dialog.addEventListener("pointerdown", (e) => e.stopPropagation());

        const msg = document.createElement("div");
        msg.style.cssText = "font-size:13px;color:#ddd;margin-bottom:16px;line-height:1.6;white-space:pre-wrap;";
        msg.textContent = message;
        dialog.appendChild(msg);

        const btnRow = document.createElement("div");
        btnRow.style.cssText = "display:flex;gap:10px;justify-content:flex-end;";

        const cancelBtn = document.createElement("button");
        cancelBtn.textContent = "取消";
        cancelBtn.style.cssText =
            "padding:6px 16px;background:#2a2a2a;color:#ddd;border:1px solid #444;" +
            "border-radius:4px;cursor:pointer;font-size:12px;";
        cancelBtn.addEventListener("mouseenter", () => cancelBtn.style.background = "#3a3a3a");
        cancelBtn.addEventListener("mouseleave", () => cancelBtn.style.background = "#2a2a2a");
        cancelBtn.addEventListener("click", () => close(false));

        const okBtn = document.createElement("button");
        okBtn.textContent = okText || "确定";
        okBtn.style.cssText =
            "padding:6px 16px;background:#dcc85b;color:#1e1e1e;border:none;" +
            "border-radius:4px;cursor:pointer;font-size:12px;font-weight:bold;";
        okBtn.addEventListener("mouseenter", () => okBtn.style.filter = "brightness(1.1)");
        okBtn.addEventListener("mouseleave", () => okBtn.style.filter = "");
        okBtn.addEventListener("click", () => close(true));

        btnRow.appendChild(cancelBtn);
        btnRow.appendChild(okBtn);
        dialog.appendChild(btnRow);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        okBtn.focus();
    });
}

// 批量导出静帧目录选择对话框：仅支持"输出目录"和"自定义目录"，不支持另存为
// 返回 Promise<'default'|'custom'|null>：null = 取消
function _xzgVeFrameExportDialog(hasCustomDir) {
    return new Promise((resolve) => {
        const overlay = document.createElement("div");
        overlay.style.cssText =
            "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);" +
            "z-index:999999;display:flex;align-items:center;justify-content:center;";
        const close = (val) => { overlay.remove(); resolve(val); };
        overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) close(null); });

        const dialog = document.createElement("div");
        dialog.style.cssText =
            "background:#1e1e1e;border:1px solid #3a3a3a;border-top:2px solid #dcc85b;" +
            "border-radius:8px;padding:18px 22px;min-width:320px;max-width:90vw;" +
            "box-shadow:0 4px 24px rgba(0,0,0,0.6);";
        dialog.addEventListener("pointerdown", (e) => e.stopPropagation());

        const title = document.createElement("div");
        title.style.cssText = "font-size:14px;color:#dcc85b;font-weight:bold;margin-bottom:14px;";
        title.textContent = "批量导出静帧 — 选择输出目录";
        dialog.appendChild(title);

        const btnRow = document.createElement("div");
        btnRow.style.cssText = "display:flex;gap:10px;justify-content:center;flex-wrap:wrap;";

        const makeBtn = (text, mode, isPrimary) => {
            const btn = document.createElement("button");
            btn.textContent = text;
            btn.style.cssText = isPrimary
                ? "padding:8px 20px;background:#dcc85b;color:#1e1e1e;border:none;border-radius:4px;cursor:pointer;font-size:13px;font-weight:bold;"
                : "padding:8px 20px;background:#2a2a2a;color:#ddd;border:1px solid #444;border-radius:4px;cursor:pointer;font-size:13px;";
            btn.addEventListener("mouseenter", () => {
                btn.style.filter = isPrimary ? "brightness(1.1)" : "";
                btn.style.background = isPrimary ? "" : "#3a3a3a";
            });
            btn.addEventListener("mouseleave", () => {
                btn.style.filter = "";
                btn.style.background = isPrimary ? "" : "#2a2a2a";
            });
            btn.addEventListener("click", () => close(mode));
            return btn;
        };

        btnRow.appendChild(makeBtn("输出目录", "default", true));
        btnRow.appendChild(makeBtn("自定义目录", "custom", hasCustomDir));
        dialog.appendChild(btnRow);

        const cancelBtn = document.createElement("button");
        cancelBtn.textContent = "取消";
        cancelBtn.style.cssText =
            "display:block;margin:14px auto 0;padding:6px 20px;background:transparent;color:#888;border:none;" +
            "cursor:pointer;font-size:12px;";
        cancelBtn.addEventListener("mouseenter", () => cancelBtn.style.color = "#ddd");
        cancelBtn.addEventListener("mouseleave", () => cancelBtn.style.color = "#888");
        cancelBtn.addEventListener("click", () => close(null));
        dialog.appendChild(cancelBtn);

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
    });
}

export class XiaozhuguangVideoEditor {
    constructor(options = {}) {
        // 编辑器完全独立：不再接收节点参数（filename/type/nodeId/onApplied/onCancel）
        // _confirmCallback: 由视频加载器等打开时传入，点"确认"后导出并回调；
        //   直接打开（菜单栏）时为 null，点"确认"仅关闭窗口
        this._confirmCallback = typeof options.confirmCallback === "function" ? options.confirmCallback : null;
        // _modeFilter: 加载器限定模式 —— "audio"（音频加载器打开：只留音频格式，隐藏导出按钮）
        //                                          "video"（视频加载器打开：只留视频格式，隐藏导出按钮）
        //               null = 独立打开（菜单栏），完整 UI
        this._modeFilter = (options.modeFilter === "audio" || options.modeFilter === "video") ? options.modeFilter : null;
        // _renderTargetW/H: 渲染目标分辨率（null=用首个片段原分辨率）
        this._renderTargetW = null;
        this._renderTargetH = null;
        // 输出目录设置
        //   output_mode: "default" → 默认输出到 ComfyUI output 目录，前缀固定 xzg-edit
        //               "saveas"  → 另存为（浏览器下载对话框）
        //               "custom"  → 自定义目录 base_dir + 前缀/日期戳/时间戳
        this._xzgVeOutputKey = "xzg_ve_output_settings";
        const savedOutput = _xzgVeLoadJson(this._xzgVeOutputKey, {});
        // output_mode 优先，其次兼容旧字段 use_default_output；首次默认 "saveas"（另存为）
        let savedMode = savedOutput.output_mode;
        if (!savedMode) {
            if (savedOutput.use_default_output === false) savedMode = "custom";
            else if (savedOutput.use_default_output === true) savedMode = "default";
            else savedMode = "saveas";  // 无配置时首次默认 = 另存为
        }
        this._outputMode = savedMode;
        this._useDefaultOutput = (this._outputMode === "default");  // 向后兼容
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
        // 轨道空隙选中（单轨道操作）：{ track: "v1"|"v2"|"a1"|"a2", start, end }
        // 点击轨道空白处选中两片段之间的空隙，Delete 后空隙后方片段前移贴合（不影响其他轨道）
        this._selectedGap = null;
        this._gapSelEl = null;   // 空隙选中框 DOM 元素（渲染在各轨道容器内）
        // 轨道名单击高亮（单选）：null | "v1" | "v2" | "a1" | "a2"
        // 单击轨道头名称 → 该名称红色+加粗+加大字体，其他轨道名恢复默认
        this._activeTrackName = null;
        // 媒体库 Shift 范围选择锚点（上次单选/Ctrl点选的媒体名）；Shift+点击选中锚点到当前项之间的全部媒体
        this._mediaSelAnchor = null;
        // 时间线片段 Shift 范围选择锚点（clip id）；Shift+点击选中同轨道锚点到当前片段之间的全部片段（含两端）
        this._clipSelAnchor = null;
        // 最近交互区域："media"（媒体库）| "timeline"（时间线）；Ctrl+A 据此分流全选对象
        this._lastFocusArea = "media";
        this._magnetEnabled = true;  // 磁吸开关：true=开启(红)，false=关闭(灰)
        // 快捷键配置（固定默认键位，不可自定义）
        this._shortcutKeys = this._defaultShortcuts();
        // 清理旧版本遗留的自定义快捷键本地存储
        try { localStorage.removeItem("xzg_ve_shortcuts"); } catch (_) {}
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
        this._playbackDecoder = null;  // 真正持有活跃播放迭代器的解码器（≠_currentDecoder，切换片段时序不同）
        this._playbackIteratorDone = false;  // 迭代器是否已结束（无更多帧）
        this._playbackBuffer = [];
        this._playbackBufferSize = 10;
        this._isBuffering = false;
        this._playbackStartFrame = 0;
        this._playbackStartTime = 0;
        this._playbackStartGlobalTime = 0;  // 音频播放循环起始全局时间
        // 音频
        this._audioCtx = null;
        this._audioGain = null;
        this._audioSources = {};   // clipId -> { source, buffer, startTime, startOffset }（多源混音）
        this._audioBuffers = {};   // clipId -> AudioBuffer（解码缓存）
        this._audioBufferCache = new Map();  // key: "filename|type" -> AudioBuffer（波形共享缓存）
        this._audioDecodePending = new Set();  // clipId 集合：正在解码的片段，防止并发重复解码
        this._audioPlayStartOffset = 0;
        this._audioPlayStartTime = 0;
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
        // 属性面板宽度持久化
        this._propsWidthKey = "xzg_ve_props_width";
        this._propsPanel = null;
        this._propsResizer = null;
        // 时间线面板高度（刷新/重启后恢复默认值，不持久化）
        this._tlHeightKey = "xzg_ve_tl_height";
        this._tlHeight = 350;
        this._tlPanel = null;
        this._tlResizer = null;
        this._tlVideoHeader = null;       // V1 视频轨道头
        this._tlAudioHeader = null;       // 音频轨道头
        this._tlV2TopHeader = null;       // V2-上 轨道头
        this._tlV2BotHeader = null;       // V2-下 轨道头
        this._tlResizerTop = null;        // V1 上手柄（调整 V1 高度，V2-上 联动）
        this._tlResizerMid = null;        // 中手柄（V1+音频整体平移，V2 上/下 此消彼长）
        this._tlResizerBottom = null;     // 音频下手柄（调整音频高度，V2-下 联动）
        this._tlResizerV2Top = null;      // V2-上 手柄（调整 V2-上 高度）
        this._tlResizerV2Bot = null;      // V2-下 手柄（调整 V2-下 高度）
        this._tlVideoHeight = 78;         // V1 轨道高度（默认布局由 _applyTrackLayout 四轨均分覆盖）
        this._tlAudioHeight = 78;         // A1 轨道高度（同上）
        this._tlV2TopHeight = 78;         // V2 轨道高度（同上；占位避免 0 时 _yToTrack 误判）
        this._tlV2BotHeight = 77;         // A2 轨道高度（同上）
        this._tlHeightsCustomized = false; // 是否已通过手柄自定义高度（false=默认居中）
        this._tlViewMode = "both";        // 视图模式：both=视频+音频，video=仅视频，audio=仅音频（双击轨道头文字切换）
        this._tlMaximizedTrack = null;   // 最大化轨道：null=正常，"v1"/"v2"/"a1"/"a2"=该轨道最大化，其他25px
        this._markerFlags = [];          // 旗标列表：{ time: 秒 }
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
        // ── 预览画面缩放：滚轮放大/缩小（以鼠标为中心），Z / 「重置视图」按钮恢复居中 ──
        // ResizeObserver：预览容器尺寸变化时（窗口 resize、拖动分隔条），
        //   保持画面相对位置不跳，使用 keepTransform=true
        if (typeof ResizeObserver !== "undefined" && this._previewHost) {
            this._previewResizeObserver = new ResizeObserver(() => {
                if (this._destroyed) return;
                this._applyPreviewFrameSize(true);
            });
            this._previewResizeObserver.observe(this._previewHost);
        }
        // 预览滚轮缩放（不影响渲染输出，只改显示大小）
        //   以鼠标位置为缩放中心：鼠标指向的像素点在缩放前后保持屏幕坐标不变
        if (this._previewHost) {
            this._previewWheelHandler = (e) => {
                // 直接阻止事件向画布/其他监听器传播，避免同时触发 ComfyUI 布局缩放
                e.preventDefault();
                e.stopPropagation();
                const hostRect = this._previewHost.getBoundingClientRect();
                const hx = e.clientX - hostRect.left;
                const hy = e.clientY - hostRect.top;
                // 每格 ΔY=100 ≈ ×÷1.1 倍；按住 Ctrl/MacCmd 更精细 ×÷1.03
                const factor = (e.ctrlKey || e.metaKey)
                    ? (e.deltaY > 0 ? 1 / 1.03 : 1.03)
                    : (e.deltaY > 0 ? 1 / 1.1 : 1.1);
                this._zoomPreviewAtPoint(hx, hy, factor);
            };
            this._previewHost.addEventListener("wheel", this._previewWheelHandler, { passive: false, capture: true });
        }
        // 屏蔽 Ctrl/Meta+滚轮：防止触发浏览器页面缩放（Chrome/Edge/Safari 都会把 Ctrl+滚轮解释为页面 zoom）
        // 必须 passive:false + capture 阶段才生效；仅在编辑器打开期间生效，关闭时移除
        this._ctrlZoomBlocker = (e) => {
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                e.stopPropagation();
            }
        };
        window.addEventListener("wheel", this._ctrlZoomBlocker, { passive: false, capture: true });
        // 中键按住拖动：在视频/音频轨道区域（排除左侧功能区和上方刻度区）平移时间线
        // 用 capture 阶段在片段/手柄 stopPropagation 之前拦截，保证点在片段上也能拖动
        this._middleBtnPanHandler = (e) => {
            if (e.button !== 1) return;
            if (!this._timeline) return;
            const path = e.composedPath();
            // 命中视频或音频轨道（含 V2-上 / V2-下 视频轨道，排除左侧 150px 功能区、刻度区 35px 及刻度拖动条、时间线外部）
            const onVTrack = path.some(el => el?.classList?.contains?.("xzg-ve-video-track") ||
                el?.classList?.contains?.("xzg-ve-video2-top-track") ||
                el?.classList?.contains?.("xzg-ve-video2-bot-track"));
            const onATrack = path.some(el => el?.classList?.contains?.("xzg-ve-audio-track"));
            if (!onVTrack && !onATrack) return;
            // 命中时间线的 resizer 手柄或刻度区：不启动平移
            const onResizer = path.some(el => el?.classList?.contains?.("xzg-ve-track-resizer") ||
                el?.classList?.contains?.("xzg-ve-tl-scrub"));
            if (onResizer) return;
            e.preventDefault();
            e.stopPropagation();
            const startClientX = e.clientX;
            const startScroll = this._tlScrollLeft;
            const onMove = (ev) => {
                const dx = ev.clientX - startClientX;
                this._tlScrollLeft = startScroll - dx;
                this._clampScrollLeft();
                this._applyTlScroll();
            };
            const onUp = () => {
                window.removeEventListener("mousemove", onMove);
                window.removeEventListener("mouseup", onUp);
            };
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
        };
        window.addEventListener("mousedown", this._middleBtnPanHandler, { capture: true });
        // 初始化预览尺寸（DOM 挂载后）
        this._applyPreviewFrameSize(false);
        // 时间线从空开始或从 localStorage 恢复，用户从媒体库自行拖入需要的片段
    }

    close() {
        if (this._destroyed) return;
        // 关闭前：若存在 confirmCallback 且尚未消费（无 callbackCalled 标记），发送空结果通知调用方
        // （避免调用方按钮一直停在"等待确认..."状态）
        if (this._confirmCallback && !this._confirmCallbackCalled) {
            this._confirmCallbackCalled = true;
            try { this._confirmCallback({}); } catch (_) {}
        }
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
        // 回收 _initCtxMenu 挂的全局 hideAll 监听（历史版本从不移除，document/window 捕获层会累积）
        if (this._ctxMenuHideAll) {
            document.removeEventListener("mousedown", this._ctxMenuHideAll, true);
            document.removeEventListener("contextmenu", this._ctxMenuHideAll, true);
            window.removeEventListener("blur", this._ctxMenuHideAll);
            window.removeEventListener("resize", this._ctxMenuHideAll);
            this._ctxMenuHideAll = null;
        }
        // 预览缩放监听 & ResizeObserver 清理
        if (this._previewResizeObserver) {
            try { this._previewResizeObserver.disconnect(); } catch (_) {}
            this._previewResizeObserver = null;
        }
        if (this._previewWheelHandler && this._previewHost) {
            this._previewHost.removeEventListener("wheel", this._previewWheelHandler, { capture: true });
            this._previewWheelHandler = null;
        }
        if (this._ctrlZoomBlocker) {
            window.removeEventListener("wheel", this._ctrlZoomBlocker, { capture: true });
            this._ctrlZoomBlocker = null;
        }
        // 交互区域激活监听清理（capture 阶段）
        if (this._tlFocusHandler && this._timeline) {
            this._timeline.removeEventListener("mousedown", this._tlFocusHandler, true);
            this._tlFocusHandler = null;
        }
        if (this._mediaFocusHandler && this._mediaList) {
            this._mediaList.removeEventListener("mousedown", this._mediaFocusHandler, true);
            this._mediaFocusHandler = null;
        }
        if (this._middleBtnPanHandler) {
            window.removeEventListener("mousedown", this._middleBtnPanHandler, { capture: true });
            this._middleBtnPanHandler = null;
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

    // ── 快捷键配置 ──────────────────────────────────────────────────
    _defaultShortcuts() {
        return {
            playpause: "Space",        // 播放/暂停
            delete: "Delete",          // 删除选中
            frameskip: "ArrowLeft",    // 帧步进（左/右）
            split: "b",                // 分割
            addflag: "m",              // 添加旗标
            fitview: "e",              // 时间线适配宽度
            zoom10: "r",               // 以播放头为中心显示 10 秒
            resetzoom: "z",            // 重置预览缩放
            undo: "ctrl+z",            // 撤销
            redo: "ctrl+shift+z",      // 重做
        };
    }
    // 打开使用说明书弹窗：详细介绍操作、功能与快捷键
    _openManual() {
        const self = this;
        const overlay = document.createElement("div");
        overlay.style.cssText =
            "position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:999999;display:flex;align-items:center;justify-content:center;";
        const close = () => overlay.remove();
        overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) close(); });

        const dialog = document.createElement("div");
        dialog.style.cssText =
            "background:#1e1e1e;border:1px solid #3a3a3a;border-top:2px solid #ff5252;" +
            "border-radius:8px;padding:18px 22px;min-width:440px;max-width:680px;max-height:82vh;overflow-y:auto;" +
            "box-shadow:0 4px 24px rgba(0,0,0,0.6);";
        dialog.addEventListener("pointerdown", (e) => e.stopPropagation());

        // 分区标题 / 正文行
        const sectionTitle = (t) => {
            const el = document.createElement("div");
            el.style.cssText = "font-size:13px;color:#ff5252;font-weight:bold;margin:16px 0 6px;";
            el.textContent = t;
            dialog.appendChild(el);
        };
        const textRow = (t) => {
            const el = document.createElement("div");
            el.style.cssText = "font-size:12px;color:#ccc;line-height:1.9;";
            el.innerHTML = t;
            dialog.appendChild(el);
        };

        const title = document.createElement("div");
        title.style.cssText = "font-size:15px;color:#ff5252;font-weight:bold;margin-bottom:4px;";
        title.textContent = "小珠光 · 快剪 使用说明书";
        dialog.appendChild(title);
        const sub = document.createElement("div");
        sub.style.cssText = "font-size:11px;color:#888;margin-bottom:6px;";
        sub.textContent = "导入素材 → 时间线剪辑 → 导出成片";
        dialog.appendChild(sub);

        // ── 一、基本操作 ──
        sectionTitle("一、基本操作");
        textRow("1. 导入媒体：点击媒体库左上角「＋」按钮上传视频 / 音频 / 图片；空白处按住拖动可框选多个媒体。");
        textRow("2. 添加到时间线：从媒体库按住素材拖到时间线轨道（视频 / 图片 → V1、V2 轨道；音频 → A1、A2 轨道），出现金色预览框后松手即可落位。");
        textRow("3. 播放预览：按「空格」播放 / 暂停；按「← / →」逐帧步进；按住 Shift（Shift+← / Shift+→）按秒步进，步进幅度按当前帧率换算（如 30fps 跳 30 帧 = 1 秒）；点击时间线刻度尺可定位播放头。");
        textRow("4. 保存：点击「确认」将时间线保存到节点；点击「导出」直接导出成片；点击「×」关闭快剪（不保存）。");

        // ── 二、时间线编辑 ──
        sectionTitle("二、时间线编辑");
        textRow("· 选择片段：单击选中；Ctrl+点击 可增减多选；空白处按住拖动可框选。多选后可整体移动 / 删除 / 分割。");
        textRow("· 移动片段：直接拖动片段；上下拖动可跨轨道（视频 V1 ↔ V2，音频 A1 ↔ A2）。");
        textRow("· 复制片段：按住 Alt 并拖动片段，原片段保留，松手后生成副本。");
        textRow("· 修剪长度：拖动片段的左右边缘，可缩短或恢复片段长度。");
        textRow("· 分割：将播放头移到目标位置，按「B」或点击工具栏「分割」按钮，在播放头处切开片段。");
        textRow("· 删除：选中片段后按「Delete」。");
        textRow("· 磁吸：工具栏「🧲」开关（红 = 开，灰 = 关），开启后拖动时片段自动吸附对齐边缘与播放头。");
        textRow("· 旗标：按「M」在播放头处添加旗标，用于标记关键位置；右键「旗标」按钮清空所有旗标。");
        textRow("· 缩放时间线：按住 Alt + 滚轮缩放；按「E」时间线适配总宽度；按「R」以播放头为中心显示 10 秒。");
        textRow("· 平移：中键按住拖动可平移时间线。");
        textRow("· 轨道高度：在轨道上按住 Shift + 滚轮调整高度；时间线左上角按钮可恢复默认布局。");
        textRow("· 撤销 / 重做：Ctrl+Z 撤销，Ctrl+Shift+Z（或 Ctrl+Y）重做。");

        // ── 三、预览与属性 ──
        sectionTitle("三、预览与属性");
        textRow("· 预览缩放：在预览画面上滚动滚轮放大 / 缩小（以鼠标位置为中心）；按「Z」重置视图。");
        textRow("· 片段属性：选中片段后，右侧属性面板可调整——视频：大小、水平 / 垂直移动、四边裁剪、透明度、音量；音频：音量。");
        textRow("· 滑条精调：按住 Alt 拖动属性滑条可进行精细微调。");
        textRow("· 分辨率 / 帧率：预览区上方可设置导出分辨率与帧率。");

        // ── 四、快捷键 ──
        sectionTitle("四、快捷键（固定键位）");
        const SC_LABELS = {
            playpause: "播放 / 暂停",
            frameskip: "帧步进（← / →，+Shift 按秒步进）",
            delete: "删除选中",
            split: "分割片段",
            addflag: "添加旗标",
            fitview: "时间线适配宽度",
            zoom10: "缩放显示 10 秒",
            resetzoom: "重置预览视图",
            undo: "撤销",
            redo: "重做",
        };
        const scTable = document.createElement("div");
        scTable.style.cssText = "border:1px solid #3a3a3a;border-radius:6px;padding:4px 12px;";
        for (const action of Object.keys(self._defaultShortcuts())) {
            const row = document.createElement("div");
            row.style.cssText = "display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid #2a2a2a;";
            const name = document.createElement("span");
            name.style.cssText = "font-size:12px;color:#ddd;";
            name.textContent = SC_LABELS[action] || action;
            const key = document.createElement("span");
            key.style.cssText = "background:#2a2a2a;border:1px solid #4a4a4a;border-radius:4px;padding:2px 10px;font-size:12px;color:#fff;white-space:nowrap;";
            key.textContent = self._shortcutLabel(self._shortcutKeys[action]);
            row.appendChild(name);
            row.appendChild(key);
            scTable.appendChild(row);
        }
        dialog.appendChild(scTable);
        const scTip = document.createElement("div");
        scTip.style.cssText = "font-size:11px;color:#888;margin-top:6px;line-height:1.8;";
        scTip.innerHTML =
            "· 帧步进组合：← / → 单帧步进；Shift+← / Shift+→ 按 1 秒步进（按当前帧率换算，如 30fps 跳 30 帧）。";
        dialog.appendChild(scTip);

        // ── 五、导出 ──
        sectionTitle("五、导出");
        textRow("· 格式：视频 MP4（质量高 CRF10 / 中 CRF20 / 低 CRF28）；音频 MP3（320 / 192 / 128 kbps）；WAV / FLAC 无损。");
        textRow("· 输出目录：点击顶栏「输出目录设置」选择导出位置。");
        textRow("· 点击「导出」开始渲染，进度显示在顶栏状态区。");

        // 底部按钮
        const btnRow = document.createElement("div");
        btnRow.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:16px;";
        const closeBtn = document.createElement("button");
        closeBtn.textContent = "关闭";
        closeBtn.style.cssText = "background:#3a4a6a;color:#fff;border:none;border-radius:4px;padding:5px 16px;font-size:12px;cursor:pointer;";
        closeBtn.addEventListener("click", close);
        btnRow.appendChild(closeBtn);
        dialog.appendChild(btnRow);

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
    }
    // 判断按键事件是否匹配某个绑定（支持纯键 / ctrl+ / shift+ / alt+ / Space / 方向键）
    _matchShortcut(e, binding) {
        if (!binding) return false;
        const parts = binding.toLowerCase().split("+");
        let keyPart = parts.pop();
        const needsCtrl = parts.includes("ctrl") || parts.includes("meta");
        const needsShift = parts.includes("shift");
        const needsAlt = parts.includes("alt");
        // 解析按键部分：Space / Delete / ArrowLeft 等保留大小写，单字符转小写
        if (/^[a-z0-9]$/i.test(keyPart)) keyPart = keyPart.toLowerCase();
        let eventKey;
        if (keyPart === "space") eventKey = " ";
        else if (keyPart === "arrowleft") eventKey = "ArrowLeft";
        else if (keyPart === "arrowright") eventKey = "ArrowRight";
        else if (keyPart === "delete") eventKey = "Delete";
        else eventKey = keyPart;
        // 键匹配：兼容 e.key（可能大小写/特殊字符）与 e.code（如 KeyZ）
        let keyMatches;
        if (eventKey.length === 1 && /[a-z0-9]/i.test(eventKey)) {
            keyMatches = e.key.toLowerCase() === eventKey.toLowerCase();
        } else {
            keyMatches = (e.key === eventKey) || (e.code === eventKey);
        }
        if (!keyMatches) return false;
        const ctrl = e.ctrlKey || e.metaKey;
        if (ctrl !== needsCtrl) return false;
        if (e.shiftKey !== needsShift) return false;
        if (e.altKey !== needsAlt) return false;
        return true;
    }
    // 把绑定转成可读字符串（用于设置弹窗显示）
    _shortcutLabel(binding) {
        if (!binding) return "未设置";
        return binding.split("+").map(p => {
            if (p === "ctrl") return "Ctrl";
            if (p === "shift") return "Shift";
            if (p === "alt") return "Alt";
            if (p === "meta") return "Cmd";
            if (p === "space") return "空格";
            if (p === "arrowleft") return "←";
            if (p === "arrowright") return "→";
            if (p === "delete") return "Del";
            return p.toUpperCase();
        }).join("+");
    }

    _onKeyDown(e) {
        // 空格键播放/暂停
        if (this._matchShortcut(e, this._shortcutKeys.playpause)) {
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
        // Ctrl+A / Cmd+A：全选。按最近交互区域分流：
        //   timeline（刚点过时间线片段）→ 全选所有片段；media / 默认 → 全选媒体库
        if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
            if (this._lastFocusArea === "timeline" && this.timeline.length > 0) {
                e.preventDefault();
                e.stopImmediatePropagation();
                this._clearGapSelection();
                this.selectedClipIds = new Set(this.timeline.map(c => c.id));
                if (this.selectedMediaNames.size > 0) {
                    this.selectedMediaNames.clear();
                    this._renderMediaList();
                }
                this._updateClipSelection();
                this._renderProps();
                this._setStatus(`已全选 ${this.selectedClipIds.size} 个片段（Delete 删除）`);
            } else if (this.mediaLibrary.length > 0) {
                e.preventDefault();
                e.stopImmediatePropagation();
                this.selectedMediaNames = new Set(this.mediaLibrary.map(m => m.name));
                this._renderMediaList();
                this._setStatus(`已全选 ${this.selectedMediaNames.size} 个媒体（Delete 删除）`);
            }
            return;
        }
        // Ctrl+Z 撤销 / Ctrl+Shift+Z 重做（也支持 Ctrl+Y 重做）
        if (this._matchShortcut(e, this._shortcutKeys.undo)) {
            e.preventDefault();
            this._undo();
            return;
        }
        if (this._matchShortcut(e, this._shortcutKeys.redo) || (this._shortcutKeys.redo === "ctrl+shift+z" && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y")) {
            e.preventDefault();
            this._redo();
            return;
        }
        if (this._matchShortcut(e, this._shortcutKeys.delete) || e.key === "Backspace") {
            const mediaSel = this.selectedMediaNames.size > 0;
            const clipSel = this.selectedClipIds.size > 0;
            const gapSel = !!this._selectedGap;
            // 快剪编辑器打开期间，Delete/Backspace 一律拦截并阻止向 ComfyUI 画布传播：
            // 从音频/视频加载器进入时，加载器节点仍处于画布选中状态，若快剪内无选中片段
            // 直接 return 放行，事件会穿透到 LiteGraph 删除该节点（删光音轨所有音频后误删节点）
            e.preventDefault();
            e.stopImmediatePropagation();
            if (!mediaSel && !clipSel && !gapSel) return;
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
            // 删除选中的片段：视频与配对音频拆分后各自独立，删除任意一方都不级联删除另一方
            //   - 单独删配对音频：视频保留，skip_audio=true 继续静音
            //   - 单独删视频：配对音频继续存在（变成独立音频片段）
            if (clipSel) {
                const ids = Array.from(this.selectedClipIds);
                for (const id of ids) {
                    const idx = this.timeline.findIndex(c => c.id === id);
                    if (idx >= 0) this.timeline.splice(idx, 1);
                }
                this.selectedClipIds.clear();
            }
            // 删除选中的轨道空隙（无片段、无媒体选中时）：空隙后方片段前移贴合，单轨道操作
            // 媒体删除会级联移除其引用片段，与空隙前移叠加会产生意外位移，故互斥执行
            if (gapSel && !clipSel && !mediaSel) {
                this._deleteSelectedGap();
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
            // gapSel 独有场景的状态提示由 _deleteSelectedGap 内部设置（含轨道名与移动片段数）
            return;
        }
        // 左右箭头：单帧步进；Shift+左右箭头：1秒步进（按当前帧率，24fps=24帧，30fps=30帧）
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            if (this.timeline.length === 0) return;
            e.preventDefault();
            const fps = this._currentClip ? this._getClipFps(this._currentClip) : 30;
            const frames = e.shiftKey ? fps : 1;
            const dt = (e.key === "ArrowRight" ? frames : -frames) / fps;
            const total = this._getTimelineTotalDuration();
            let newTime = this._tlGlobalTime + dt;
            newTime = Math.max(0, Math.min(total, newTime));
            // 步进时暂停播放
            if (this._tlPlaying) this._toggleTimelinePlay();
            this._seekToGlobalTime(newTime);
            return;
        }
        // 分割（与工具栏剪刀按钮同功能）
        // stopImmediatePropagation 防止穿透到画布触发编组开关面板（画布 B 键）
        if (this._matchShortcut(e, this._shortcutKeys.split)) {
            if (this.timeline.length === 0) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            const ae = document.activeElement;
            if (ae && ae.tagName === "BUTTON") ae.blur();
            this._splitClipAtPlayhead();
            return;
        }
        // 添加旗标
        if (this._matchShortcut(e, this._shortcutKeys.addflag)) {
            e.preventDefault();
            e.stopImmediatePropagation();
            // 焦点在按钮上时按键可能触发 :active 高亮，preventDefault 无法阻止
            const ae = document.activeElement;
            if (ae && ae.tagName === "BUTTON") ae.blur();
            this._addMarkerFlag();
            return;
        }
        // 时间线适配宽度
        if (this._matchShortcut(e, this._shortcutKeys.fitview)) {
            e.preventDefault();
            e.stopImmediatePropagation();
            if (!e.repeat) this._fitTimelineToView();
            return;
        }
        // 以播放头为中心缩放显示 10 秒
        if (this._matchShortcut(e, this._shortcutKeys.zoom10)) {
            e.preventDefault();
            e.stopImmediatePropagation();
            if (!e.repeat) this._zoomToTenSeconds();
            return;
        }
        // 重置预览视图（缩放 100% + 居中），和「重置视图」按钮一致
        if (this._matchShortcut(e, this._shortcutKeys.resetzoom)) {
            e.preventDefault();
            this._resetPreviewZoom();
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
                track: leftClip.track || (leftClip.kind === "audio" ? "a1" : "v1"),
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
                        <button class="xzg-ve-btn xzg-ve-btn-manual" title="使用说明书"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#ff5252" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg></button>
                        <button class="xzg-ve-btn xzg-ve-btn-output-settings" title="输出目录设置">输出目录设置</button>
                        <span class="xzg-ve-format-label">格式</span>
                        <select class="xzg-ve-format-select">
                            <option value="video-mp4" selected>视频 MP4</option>
                            <option value="audio-mp3">音频 MP3</option>
                            <option value="audio-wav">音频 WAV</option>
                            <option value="audio-flac">音频 FLAC</option>
                        </select>
                        <span class="xzg-ve-quality-label">质量</span>
                        <select class="xzg-ve-quality-select" data-mode="video">
                            <option value="high" selected>高 (CRF 10)</option>
                            <option value="medium">中 (CRF 20)</option>
                            <option value="low">低 (CRF 28)</option>
                        </select>
                        <button class="xzg-ve-btn xzg-ve-btn-apply">导出</button>
                        <button class="xzg-ve-btn xzg-ve-btn-cancel">确认</button>
                        <button class="xzg-ve-btn xzg-ve-btn-close-x" title="关闭快剪（不导出）">×</button>
                    </div>
                </div>
                <div class="xzg-ve-body">
                    <div class="xzg-ve-media-panel">
                        <div class="xzg-ve-panel-header">
                            <div class="xzg-ve-media-title-group">
                                <span style="color:#fff;">媒体库</span>
                                <button class="xzg-ve-cache-btn" title="删除所有上传的媒体文件和缩略图缓存">一键清理缓存</button>
                            </div>
                            <div class="xzg-ve-media-btns">
                                <button class="xzg-ve-thumb-btn"></button>
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
                            <button type="button" class="xzg-ve-btn xzg-ve-btn-reset-view" title="重置视图（快捷键：Z）" aria-label="重置视图">
                                <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true" focusable="false">
                                    <path d="M3 2 H6 V3 H4 V6 H3 V2.5 Z" fill="none" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="miter"/>
                                    <path d="M15 2 H12 V3 H14 V6 H15 V2.5 Z" fill="none" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="miter"/>
                                    <path d="M3 16 H6 V15 H4 V12 H3 V15.5 Z" fill="none" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="miter"/>
                                    <path d="M15 16 H12 V15 H14 V12 H15 V15.5 Z" fill="none" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="miter"/>
                                </svg>
                            </button>
                        </div>
                        <div class="xzg-ve-preview">
                            <div class="xzg-ve-preview-frame">
                                <canvas class="xzg-ve-canvas"></canvas>
                            </div>
                            <div class="xzg-ve-preview-empty">从媒体库拖拽视频到时间线</div>
                        </div>
                        <div class="xzg-ve-preview-controls">
                            <button class="xzg-ve-play-btn"></button>
                            <span class="xzg-ve-time">00:00.00 / 00:00.00</span>
                            <span class="xzg-ve-frames">0 / 0 帧</span>
                            <button class="xzg-ve-frame-btn">📷 批量导出静帧</button>
                        </div>
                    </div>
                    <div class="xzg-ve-props-resizer"></div>
                    <div class="xzg-ve-props-panel">
                        <div class="xzg-ve-props-tabs">
                            <button class="xzg-ve-props-tab xzg-ve-props-tab-active" data-type="video">视频</button>
                            <button class="xzg-ve-props-tab" data-type="audio">音频</button>
                        </div>
                        <div class="xzg-ve-props-content"></div>
                    </div>
                </div>
                <div class="xzg-ve-timeline-resizer"></div>
                <div class="xzg-ve-timeline-panel">
                    <div class="xzg-ve-timeline-header">
                        <button class="xzg-ve-magnet-btn" title="磁吸：开启（红）/ 关闭（灰）">🧲</button>
                        <button class="xzg-ve-split-btn" title="分割 (B)">
                            <svg class="xzg-ve-split-svg" width="25" height="25" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" shape-rendering="geometricPrecision">
                                <circle cx="4.5" cy="14.5" r="2.5" fill="none" stroke="rgb(0,255,0)" stroke-width="1.4" vector-effect="non-scaling-stroke"/>
                                <circle cx="4.5" cy="5.5" r="2.5" fill="none" stroke="rgb(0,255,0)" stroke-width="1.4" vector-effect="non-scaling-stroke"/>
                                <line x1="6.6" y1="12.7" x2="17" y2="4" stroke="rgb(0,255,0)" stroke-width="1.4" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
                                <line x1="6.6" y1="7.3" x2="17" y2="16" stroke="rgb(0,255,0)" stroke-width="1.4" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
                            </svg>
                        </button>
                        <button class="xzg-ve-flag-btn" title="添加旗标 (M) | 右键清空所有旗标">
                            <svg class="xzg-ve-flag-btn-svg" width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="#4a9eff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <line x1="4" y1="2" x2="4" y2="22"/>
                                <path d="M4,4 L18,4 L14,10 L18,16 L4,16"/>
                            </svg>
                        </button>
                        <button class="xzg-ve-ruler-btn" title="时间线适配宽度 (E)">
                            <svg class="xzg-ve-ruler-svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                                <rect x="2" y="8" width="20" height="8" rx="2"/>
                                <line x1="6" y1="8" x2="6" y2="11"/>
                                <line x1="10" y1="8" x2="10" y2="11"/>
                                <line x1="14" y1="8" x2="14" y2="11"/>
                                <line x1="18" y1="8" x2="18" y2="11"/>
                            </svg>
                        </button>
                        <button class="xzg-ve-rulerzoom-btn" title="以播放头为中心显示 10 秒 (R)">
                            <svg class="xzg-ve-rulerzoom-svg" width="32" height="32" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <rect x="2" y="8" width="16" height="6" rx="2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                                <line x1="5" y1="8" x2="5" y2="10.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                                <line x1="8" y1="8" x2="8" y2="10.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                                <line x1="11" y1="8" x2="11" y2="10.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                                <circle cx="17" cy="17" r="4" fill="none" stroke="currentColor" stroke-width="2"/>
                                <line x1="20" y1="20" x2="22.5" y2="22.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                            </svg>
                        </button>
                        <span class="xzg-ve-tl-info"></span>
                    </div>
                    <div class="xzg-ve-timeline" tabindex="0">
                        <div class="xzg-ve-tl-leftpad">
                            <button class="xzg-ve-btn xzg-ve-btn-reset-layout" title="恢复视频/音频轨道高度和位置为默认居中布局（不影响已加载内容）"><svg class="xzg-ve-reset-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#dcc85b" stroke-width="2" stroke-linecap="round"><line x1="3" y1="5" x2="21" y2="5"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="3" y1="20" x2="21" y2="20"/></svg></button>
                            <div class="xzg-ve-track-header xzg-ve-video2-top-header">
                                <span class="xzg-ve-track-name">V2</span>
                            </div>
                            <div class="xzg-ve-track-header xzg-ve-video-header">
                                <span class="xzg-ve-track-name">V1</span>
                            </div>
                            <div class="xzg-ve-track-header xzg-ve-audio-header">
                                <span class="xzg-ve-track-name">A1</span>
                            </div>
                            <div class="xzg-ve-track-header xzg-ve-video2-bot-header">
                                <span class="xzg-ve-track-name">A2</span>
                            </div>
                        </div>
                        <div class="xzg-ve-tl-scrub-divider"></div>
                        <!-- V2-上 顶边缘 1px 实线（原 .xzg-ve-tl-video-top 复用，语义改为 V2-上 最顶） -->
                        <div class="xzg-ve-tl-video-top"></div>
                        <div class="xzg-ve-tl-scrub">
                            <div class="xzg-ve-tl-ticks"></div>
                        </div>
                        <div class="xzg-ve-tl-track xzg-ve-video2-top-track"></div>
                        <div class="xzg-ve-tl-track xzg-ve-video-track"></div>
                        <div class="xzg-ve-tl-track xzg-ve-audio-track"></div>
                        <div class="xzg-ve-tl-track xzg-ve-video2-bot-track"></div>
                        <!-- V2-下 底边缘 1px 实线（原 .xzg-ve-tl-audio-bottom 复用，语义改为 V2-下 最底） -->
                        <div class="xzg-ve-tl-audio-bottom"></div>
                        <!-- 四个手柄：时间线直接子元素，贯穿整个时间线左右（A2 最底不再放手柄） -->
                        <div class="xzg-ve-track-resizer xzg-ve-resizer-v2-top"></div>
                        <div class="xzg-ve-track-resizer xzg-ve-resizer-top"></div>
                        <div class="xzg-ve-track-resizer xzg-ve-resizer-mid"></div>
                        <div class="xzg-ve-track-resizer xzg-ve-resizer-bottom"></div>
                        <!-- 二条分割线：V1↔音频（mid）、音频↔V2-下（v2bot） -->
                        <div class="xzg-ve-tl-divider xzg-ve-tl-divider-mid"></div>
                        <div class="xzg-ve-tl-divider xzg-ve-tl-divider-v2bot"></div>
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
        this._previewFrame = root.querySelector(".xzg-ve-preview-frame");
        this._previewHost = root.querySelector(".xzg-ve-preview");
        // 离屏 canvas：作为 decoder 渲染目标（decoder 内部会重置 canvas.width/height，不能直接用主 canvas）
        this._offscreenCanvas = document.createElement("canvas");
        // 预览画面缩放：只改变显示大小，不影响渲染输出的分辨率
        //   zoom=1 时自然 contain 到预览容器，tx/ty 按居中定位
        //   所有定位用 transform: translate(tx, ty) scale(zoom) + transform-origin 0 0
        this._previewZoom = 1;   // 范围 0.1 ~ 8
        this._previewTx = 0;
        this._previewTy = 0;
        this._mediaList = root.querySelector(".xzg-ve-media-list");
        this._timeline = root.querySelector(".xzg-ve-timeline");
        this._tlTrack = root.querySelector(".xzg-ve-video-track");
        this._tlAudioTrack = root.querySelector(".xzg-ve-audio-track");
        this._tlV2TopTrack = root.querySelector(".xzg-ve-video2-top-track");
        this._tlV2BotTrack = root.querySelector(".xzg-ve-video2-bot-track");
        this._tlDivider = root.querySelector(".xzg-ve-tl-divider-mid");
        this._tlVideoTopDivider = root.querySelector(".xzg-ve-tl-video-top");   // 语义：V2上↔V1 之间 1px 细实线分隔
        this._tlAudioBottomDivider = root.querySelector(".xzg-ve-tl-audio-bottom"); // 语义：V2-下 最底 1px 实线
        this._tlDividerV2Bot = root.querySelector(".xzg-ve-tl-divider-v2bot"); // 音频↔V2-下 分割线
        // 全局缩略图渲染提示：挂载到时间线视口（非滚动内容），始终居中，不随片段滚动/缩放移动
        this._tlThumbLoadingHint = _el("div", "xzg-ve-clip-thumb-loading", "缩略图渲染中", this._timeline);
        this._playhead = root.querySelector(".xzg-ve-tl-playhead");
        this._status = root.querySelector(".xzg-ve-status");
        this._timeLabel = root.querySelector(".xzg-ve-time");
        this._framesLabel = root.querySelector(".xzg-ve-frames");
        this._propsContent = root.querySelector(".xzg-ve-props-content");
        this._propsTab = "video";  // 属性面板切换标签：video / audio
        this._propsTabs = root.querySelector(".xzg-ve-props-tabs");
        this._activeRange = null;  // 当前正在拖动的属性滑条
        this._compositeBusy = false; // 多轨合成渲染防抖
        this._compositeV1Cache = null;   // 播放合成时缓存的 V1 底层帧
        this._compositeV1Pending = false; // V1 帧是否在途渲染
        // ── OpenCut 式统一时钟多轨渲染状态 ──
        this._playClockStart = 0;    // 统一时钟：本次播放起始墙钟时间
        this._playClockGt = 0;       // 统一时钟：本次播放起始全局时间
        // VideoCache 式预解码（参照 OpenCut）：clipId -> 该视频层预解码状态 { decoder, iterClip, busy }。
        // 预解码迭代器把「未来窗口」的帧写入 decoder 的 FrameCache，播放/平滑前进读缓存零成本；
        // 拖动大跳/倒带时才暂停预置 → 精确解码一帧 → 从新位置重建预取。渲染读缓存与预取可并发。
        this._vcache = new Map();
        this._vcacheWindowSec = 1.2;   // 预解码窗口（秒，按 fps 折算帧数），保证播放预取跟手又不过度解码
        this._renderInFlight = false; // 统一渲染在途锁（最新优先，禁止并发争抢解码器）
        this._renderPendingGt = null; // 渲染期见的新目标 gt（在途结束后接力绘制，保证跟手）
        this._tlInfo = root.querySelector(".xzg-ve-tl-info");
        this._previewEmpty = root.querySelector(".xzg-ve-preview-empty");
        // 加载遮罩元素引用（大视频加载进度显示）
        this._loadingOverlay = root.querySelector(".xzg-ve-loading-overlay");
        this._loadingText = root.querySelector(".xzg-ve-loading-text");
        this._loadingBarFill = root.querySelector(".xzg-ve-loading-bar-fill");
        this._loadingPct = root.querySelector(".xzg-ve-loading-pct");
        this._loadingSize = root.querySelector(".xzg-ve-loading-size");

        // 事件绑定
        // 属性面板「视频/音频」标签切换
        this._propsTabs?.querySelectorAll(".xzg-ve-props-tab").forEach(tab => {
            tab.addEventListener("click", () => {
                this._propsTab = tab.dataset.type === "audio" ? "audio" : "video";
                this._syncPropsTabs();
                this._renderProps();
            });
        });
        root.querySelector(".xzg-ve-btn-cancel").onclick = () => this._cancel();
        root.querySelector(".xzg-ve-btn-close-x").onclick = () => this.close();
        root.querySelector(".xzg-ve-btn-apply").onclick = () => this._render();
        // 格式切换：视频（CRF 高中低）/ 音频 MP3（比特率 320/192/128）/ FLAC·WAV（单选项「无损」占位）
        const formatSel = root.querySelector(".xzg-ve-format-select");
        const qualitySel = root.querySelector(".xzg-ve-quality-select");
        if (formatSel && qualitySel) {
            this._syncQualityOptions = (fmt) => {
                const f = fmt || formatSel.value || "video-mp4";
                const prevVal = qualitySel.value;
                // 清空重建
                qualitySel.innerHTML = "";
                const add = (value, text, sel = false) => {
                    const o = document.createElement("option");
                    o.value = value;
                    o.textContent = text;
                    if (sel) o.selected = true;
                    qualitySel.appendChild(o);
                };
                if (f.startsWith("video-")) {
                    add("high",   "高 (CRF 10)");
                    add("medium", "中 (CRF 20)", true);
                    add("low",    "低 (CRF 28)");
                    qualitySel.dataset.mode = "video";
                    qualitySel.disabled = false;
                } else if (f === "audio-mp3") {
                    add("320", "320 kbps", true);
                    add("192", "192 kbps");
                    add("128", "128 kbps");
                    qualitySel.dataset.mode = "audio";
                    qualitySel.disabled = false;
                } else {
                    // FLAC / WAV：无损，无质量选择
                    add("lossless", "无损", true);
                    qualitySel.dataset.mode = "audio";
                    qualitySel.disabled = true;
                }
                // 恢复原值（若匹配）
                for (let i = 0; i < qualitySel.options.length; i++) {
                    if (qualitySel.options[i].value === prevVal) {
                        qualitySel.selectedIndex = i;
                        break;
                    }
                }
            };
            formatSel.addEventListener("change", () => this._syncQualityOptions(formatSel.value));
            this._syncQualityOptions(formatSel.value);
        }
        // 模式过滤（加载器限定模式）：按 _modeFilter 重建格式下拉 + 隐藏「导出」按钮
        //   audio → 只留音频格式（默认 MP3）；video → 只留视频 MP4；null → 完整列表
        //   每次调用从头重建，模式切换（如单例复用时）自然可逆
        const XZG_VE_FORMATS = [
            { value: "video-mp4", label: "视频 MP4" },
            { value: "audio-mp3", label: "音频 MP3" },
            { value: "audio-wav", label: "音频 WAV" },
            { value: "audio-flac", label: "音频 FLAC" },
        ];
        this._applyModeFilter = () => {
            const formatSel2 = this._root?.querySelector(".xzg-ve-format-select");
            const applyBtn = this._root?.querySelector(".xzg-ve-btn-apply");
            if (!formatSel2) return;
            const mode = this._modeFilter;
            // 限定模式（加载器打开）隐藏「导出」按钮；独立模式恢复
            if (applyBtn) applyBtn.style.display = mode ? "none" : "";
            // 直接打开（无 confirmCallback）：隐藏「确认」按钮（点了没意义）
            const cancelBtn = this._root?.querySelector(".xzg-ve-btn-cancel");
            if (cancelBtn) cancelBtn.style.display = this._confirmCallback ? "" : "none";
            const allowed = XZG_VE_FORMATS.filter(f =>
                mode === "audio" ? f.value.startsWith("audio-")
                : mode === "video" ? f.value.startsWith("video-")
                : true
            );
            const prev = formatSel2.value;
            formatSel2.innerHTML = "";
            for (const f of allowed) {
                const o = document.createElement("option");
                o.value = f.value;
                o.textContent = f.label;
                formatSel2.appendChild(o);
            }
            // 保留仍允许的原选中值，否则取默认（audio→MP3, video→MP4, 完整→MP4）
            formatSel2.value = (prev && allowed.some(f => f.value === prev))
                ? prev
                : (allowed[0]?.value || "video-mp4");
            this._syncQualityOptions?.(formatSel2.value);
            // 音频加载器打开：隐藏视频轨道，A1/A2 均分高度
            if (mode === "audio") {
                this._tlViewMode = "audio";
                this._tlHeightsCustomized = true;
                this._tlMaximizedTrack = null;
                this._clearGapSelection(); // 模式切换：清空旧空隙选中（隐藏轨道不可见，避免误删）
                const tlH = Math.max(1, (this._timeline && this._timeline.clientHeight > 0) ? this._timeline.clientHeight : 400);
                const trackAreaH = tlH - 35;
                this._tlV2TopHeight = 0;
                this._tlVideoHeight = 0;
                const eachH = Math.floor((trackAreaH - 1) / 2);
                this._tlAudioHeight = eachH;
                this._tlV2BotHeight = eachH;
                // 音频模式固定偏移 71（无 5px 粗分割线），面板高度需匹配轨道总高
                // 避免初始 Shift+滚轮时面板从 350 跳变到正确高度，导致 A2 视觉跳高
                const audioFixedOff = 71;
                const audioPanelH = audioFixedOff + eachH * 2;
                if (this._tlPanel) this._tlPanel.style.height = audioPanelH + "px";
                this._tlHeight = audioPanelH;
                this._applyTrackLayout();
            } else if (mode === "video") {
                // 视频加载器打开：保持四轨均分（默认行为）
                this._tlViewMode = "both";
                this._tlHeightsCustomized = false;
                this._tlMaximizedTrack = null;
                this._clearGapSelection(); // 模式切换：清空旧空隙选中（隐藏轨道不可见，避免误删）
                this._applyTrackLayout();
            }
            // mode === null（独立打开）：不强制重置布局，保留用户当前布局
        };
        this._applyModeFilter();
        // 输出目录设置按钮：复用小珠光图像保存-化神级的目录浏览器对话框
        // 通过模拟 node + widget 的方式对接全局 _xzgShowDirBrowser
        const outputSettingsBtn = root.querySelector(".xzg-ve-btn-output-settings");
        // 更新按钮 tooltip：显示当前输出目录设置摘要（三种模式：默认/另存为/自定义目录）
        // 按钮本身固定显示文字「输出目录设置」，模式信息只放在 title 悬浮提示
        this._updateOutputBtn = () => {
            if (!outputSettingsBtn) return;
            outputSettingsBtn.textContent = "输出目录设置";
            if (this._outputMode === "default") {
                outputSettingsBtn.title = "输出目录设置：默认（输出到 ComfyUI output 目录，前缀 xzg-edit）";
            } else if (this._outputMode === "saveas") {
                outputSettingsBtn.title = "输出目录设置：另存为（导出时弹出浏览器另存为对话框，手动选择保存位置和文件名）";
            } else {
                // custom：目录名 + 前缀 + 戳
                const parts = (this._baseDir || "").replace(/[\\/]+$/, "").split(/[\\/]/);
                const last = parts[parts.length - 1] || this._baseDir || "(未选目录)";
                const stamps = [];
                if (this._addDateStamp) stamps.push("日期");
                if (this._addTimeStamp) stamps.push("时间");
                const stampStr = stamps.length ? ` + ${stamps.join("/")}` : "";
                outputSettingsBtn.title = `输出目录设置：${last}\n目录: ${this._baseDir || "(未选)"}\n前缀: ${this._filenamePrefix}${stampStr}`;
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
                const outputModeWidget = {
                    name: "output_mode",
                    value: this._outputMode,
                    callback: function(v) {
                        // v: "default" | "saveas" | "custom"
                        self._outputMode = v || "default";
                        self._useDefaultOutput = (self._outputMode === "default");  // 向后兼容
                        self._saveOutputSettings();
                        self._updateOutputBtn();
                    }
                };
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
                        // 旧版兼容：从 use_default_output 同步到 outputMode
                        if (self._outputMode !== "saveas") {
                            self._outputMode = self._useDefaultOutput ? "default" : "custom";
                        }
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
                    _xzgOutputModeWidget: outputModeWidget,
                    _xzgBaseDirWidget: baseDirWidget,
                    _xzgDefaultOutputWidget: defaultOutputWidget,
                    _xzgPrefixCustomWidget: prefixWidget,
                    _xzgDateStampWidget: dateWidget,
                    _xzgTimeStampWidget: timeWidget,
                };
                window._xzgShowDirBrowser(fakeNode);
            };
        }
        const manualBtn = root.querySelector(".xzg-ve-btn-manual");
        if (manualBtn) manualBtn.onclick = () => { manualBtn.blur(); this._openManual(); };
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
                // 切换分辨率后预览即时按新比例 letterbox
                if (typeof this._persistRenderRes === 'function') this._persistRenderRes();
                if (typeof this._refreshCurrentFrame === 'function') this._refreshCurrentFrame();
            };
        }
        if (wInput && hInput) {
            // 输入框手动修改时，预设自动切回"原始"（避免与输入值不同步）
            wInput.oninput = () => {
                if (presetsSel) presetsSel.value = "0";
                _syncPortraitLock();
                if (typeof this._persistRenderRes === 'function') this._persistRenderRes();
                if (typeof this._refreshCurrentFrame === 'function') this._refreshCurrentFrame();
            };
            hInput.oninput = () => {
                if (presetsSel) presetsSel.value = "0";
                _syncPortraitLock();
                if (typeof this._persistRenderRes === 'function') this._persistRenderRes();
                if (typeof this._refreshCurrentFrame === 'function') this._refreshCurrentFrame();
            };
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
                if (typeof this._persistRenderRes === 'function') this._persistRenderRes();
            };
            // 输入框手动修改时，下拉自动切回"自定义"（避免与选择项不同步）
            fpsInputEl.oninput = () => { if (fpsSel) fpsSel.value = "0"; this._persistRenderRes(); };
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
                // 交换后预览按新分辨率比例重新 letterbox
                if (typeof this._persistRenderRes === 'function') this._persistRenderRes();
                if (typeof this._refreshCurrentFrame === 'function') this._refreshCurrentFrame();
            };
        }
        // 「重置视图」按钮：恢复 100% 居中
        const resetViewBtn = root.querySelector(".xzg-ve-btn-reset-view");
        if (resetViewBtn) {
            resetViewBtn.onclick = (e) => { e.preventDefault(); this._resetPreviewZoom(); };
        }
        root.querySelector(".xzg-ve-add-btn").onclick = () => this._addFromInput();
        root.querySelector(".xzg-ve-cache-btn").onclick = () => this._clearCache();
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
        // 属性面板宽度拖动调整
        this._propsPanel = root.querySelector(".xzg-ve-props-panel");
        this._propsResizer = root.querySelector(".xzg-ve-props-resizer");
        this._restorePropsWidth();
        this._bindPropsResizer();
        // 时间线高度拖动调整
        this._tlPanel = root.querySelector(".xzg-ve-timeline-panel");
        this._tlResizer = root.querySelector(".xzg-ve-timeline-resizer");
        this._tlVideoHeader = root.querySelector(".xzg-ve-video-header");
        this._tlAudioHeader = root.querySelector(".xzg-ve-audio-header");
        this._tlV2TopHeader = root.querySelector(".xzg-ve-video2-top-header");
        this._tlV2BotHeader = root.querySelector(".xzg-ve-video2-bot-header");
        this._tlResizerTop = root.querySelector(".xzg-ve-resizer-top");
        this._tlResizerMid = root.querySelector(".xzg-ve-resizer-mid");
        this._tlResizerBottom = root.querySelector(".xzg-ve-resizer-bottom");
        this._tlResizerV2Top = root.querySelector(".xzg-ve-resizer-v2-top");
        this._tlResizerV2Bot = root.querySelector(".xzg-ve-resizer-v2-bot");
        this._restoreTimelineHeight();
        this._bindTimelineResizer();
        this._initTrackResizer();
        this._applyTrackLayout();
        root.querySelector(".xzg-ve-play-btn").onclick = (e) => {
            this._toggleTimelinePlay();
            e.currentTarget.blur();  // 点击后立即失焦，避免空格播放时残留焦点高亮
        };
        root.querySelector(".xzg-ve-frame-btn").onclick = () => this._exportFrame();
        root.querySelector(".xzg-ve-split-btn").onclick = (e) => {
            e.currentTarget.blur();
            if (this.timeline.length > 0) this._splitClipAtPlayhead();
        };
        const magnetBtn = root.querySelector(".xzg-ve-magnet-btn");
        if (magnetBtn) {
            // 磁吸开关：开启=红色，关闭=灰色
            const applyMagnetStyle = () => {
                if (this._magnetEnabled) {
                    magnetBtn.classList.remove("xzg-ve-magnet-off");
                    magnetBtn.style.color = "#ff4444";  // 红
                } else {
                    magnetBtn.classList.add("xzg-ve-magnet-off");
                    magnetBtn.style.color = "#181882";  // 未激活：深蓝
                }
            };
            applyMagnetStyle();
            magnetBtn.onclick = (e) => {
                e.currentTarget.blur();
                this._magnetEnabled = !this._magnetEnabled;
                applyMagnetStyle();
                this._setStatus(this._magnetEnabled ? "磁吸：开启" : "磁吸：关闭");
            };
        }
        root.querySelector(".xzg-ve-flag-btn").onclick = (e) => {
            e.currentTarget.blur();
            this._addMarkerFlag();
        };
        const rulerBtn = root.querySelector(".xzg-ve-ruler-btn");
        if (rulerBtn) rulerBtn.onclick = (e) => { e.currentTarget.blur(); this._fitTimelineToView(); };
        const rulerZoomBtn = root.querySelector(".xzg-ve-rulerzoom-btn");
        if (rulerZoomBtn) rulerZoomBtn.onclick = (e) => { e.currentTarget.blur(); this._zoomToTenSeconds(); };
        root.querySelector(".xzg-ve-flag-btn").oncontextmenu = (e) => {
            e.preventDefault();
            if (this._markerFlags.length > 0) {
                this._markerFlags = [];
                this._renderMarkerFlags();
                this._setStatus("已清空所有旗标");
            }
        };
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
        });
        this._timeline.addEventListener("dragover", (e) => {
            e.preventDefault();
            // 实时预览：根据鼠标 X 位置显示片段占位
            const name = e.dataTransfer.types.includes("text/x-media-name");
            if (!name) return;
            this._showDragPreview(e.clientX, null, "left", "video", e.clientY);
        });
        this._timeline.addEventListener("dragleave", (e) => {
            // 仅当离开整个 timeline 才取消预览
            if (!this._timeline.contains(e.relatedTarget)) {
                this._hideDragPreview();
            }
        });
        this._timeline.addEventListener("drop", (e) => {
            e.preventDefault();
            this._hideDragPreview();
            const name = e.dataTransfer.getData("text/x-media-name");
            const type = e.dataTransfer.getData("text/x-media-type") || "input";
            if (name) {
                // 根据鼠标 X 位置计算放置点（秒，鼠标对应片段左边缘）+ 磁吸对齐
                const media = this.mediaLibrary.find(m => m.name === name);
                const isImg = _isImage(name) || media?.info?.is_image === true;
                const isAudio = media?.isAudio || (media?.info?.audio_only === true);
                // 音频加载器模式：所有拖入（包括视频）强制作为音频处理
                const kind = (this._modeFilter === "audio" || isAudio) ? "audio" : "video";
                const md = media?.info?.duration || 0;
                // 图片 duration=0，使用默认 5 秒；视频 probe 未完成用 60 秒占位
                const dur = isImg ? (media?.info?.default_duration || 5) : (md > 0 ? md : 60);
                let tlStart = this._clientXToTlStart(e.clientX, dur);
                tlStart = this._snapTlStart(tlStart, dur);
                // 根据鼠标 Y 判断落在哪个轨道（V2/V1/A1/A2）
                const track = this._yToTrack(e.clientY, kind);
                this._addClipToTimeline(name, type, tlStart, track);
            }
        });

        // 交互区域激活（Ctrl+A 分流）：capture 阶段监听容器 mousedown，
        // 在后代元素（片段/刻度区/轨道手柄等 stopPropagation）之前执行，确保任何单击都能标记焦点区域
        //   单击时间线任何区域（片段、轨道空白、刻度区、播放头、轨道头、手柄）→ 激活时间线（Ctrl+A 全选片段）
        //   单击媒体库任何区域（媒体项、空白）→ 激活媒体库（Ctrl+A 全选媒体）
        this._tlFocusHandler = (e) => {
            if (e.button === 0 || e.button === 2) this._lastFocusArea = "timeline";
        };
        this._timeline.addEventListener("mousedown", this._tlFocusHandler, true);
        this._mediaFocusHandler = (e) => {
            if (e.button === 0 || e.button === 2) this._lastFocusArea = "media";
        };
        this._mediaList.addEventListener("mousedown", this._mediaFocusHandler, true);

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

        // 一级菜单顺序：分割 → 标记 → 删除 → 颜色
        // 分割：在播放头位置分割当前右键的片段
        const splitItem = document.createElement("div");
        splitItem.className = "xzg-ve-ctx-item";
        splitItem.innerHTML = `<span class="xzg-ve-ctx-icon" aria-hidden="true">✂</span><span class="xzg-ve-ctx-label">分割 B</span>`;
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

        // 标记：在当前播放头位置添加旗标
        const flagItem = document.createElement("div");
        flagItem.className = "xzg-ve-ctx-item";
        flagItem.innerHTML = `<span class="xzg-ve-ctx-icon" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4a9eff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="2" x2="4" y2="22"/><path d="M4,4 L18,4 L14,10 L18,16 L4,16"/></svg></span><span class="xzg-ve-ctx-label">标记 M</span>`;
        flagItem.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this._addMarkerFlag();
            this._hideCtxMenu();
        });
        menu.appendChild(flagItem);

        // 删除
        const delItem = document.createElement("div");
        delItem.className = "xzg-ve-ctx-item";
        delItem.innerHTML = `<span class="xzg-ve-ctx-icon" aria-hidden="true">🗑</span><span class="xzg-ve-ctx-label">删除</span>`;
        delItem.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const id = parseInt(this._ctxMenu.dataset.clipId);
            if (id) this._deleteClip(id);
            this._hideCtxMenu();
        });
        menu.appendChild(delItem);

        // 颜色（带 ▸ 展开子菜单）
        const colorItem = document.createElement("div");
        colorItem.className = "xzg-ve-ctx-item xzg-ve-ctx-has-sub";
        colorItem.innerHTML = `<span class="xzg-ve-ctx-icon" aria-hidden="true"></span><span class="xzg-ve-ctx-label">颜色</span><span class="xzg-ve-ctx-arrow">▸</span>`;
        colorItem.appendChild(sub);
        menu.appendChild(colorItem);

        // 显示/隐藏控制
        this._ctxMenu = menu;
        this._root.appendChild(menu);

        // 捕获阶段 mousedown：若事件源自菜单内部（颜色项），放行让它走自己的 handler；
        // 否则（点击空白/其他片段）隐藏菜单
        // 挂到实例引用并在 close() 配对回收，避免每次打开编辑器都重复 add、document/window 捕获层累积
        this._ctxMenuHideAll = (e) => {
            // e.target 可能是非 Node（如 window 的 blur/resize），contains 会抛错，需先判断
            const t = e && e.target;
            if (t && t.nodeType === 1 && menu.contains(t)) return;
            this._hideCtxMenu();
        };
        document.addEventListener("mousedown", this._ctxMenuHideAll, true);
        document.addEventListener("contextmenu", this._ctxMenuHideAll, true);
        window.addEventListener("blur", this._ctxMenuHideAll);
        window.addEventListener("resize", this._ctxMenuHideAll);
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
            width: 100vw; height: 100vh; background: #2a2a2a; border: none;
            border-radius: 0; display: flex; flex-direction: column; overflow: hidden;
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
            white-space: nowrap; display: flex; align-items: center; gap: 4px; }
        .xzg-ve-media-icon { flex-shrink: 0; width: 14px; height: 14px; }
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
            min-height: 0;
            overflow: hidden;  /* 不用滚动条，画面超出部分裁切，通过缩放 + 平移观察 */
        }
        /* 预览画布框：采用 absolute 定位 + transform(translate + scale)
           - left/top = 0 固定，画面位置完全由 JS 写入 translate(tx, ty) 控制
           - transform-origin: 0 0，这样 translate 就是左上角到容器左上角的像素距离，计算直观
           - width/height = natural (contain 到容器时的尺寸，不随 zoom 变)，缩放由 scale 承担
           - 这样就不需要滚动条，缩放围绕鼠标像素位置精准计算 */
        .xzg-ve-preview-frame {
            position: absolute; left: 0; top: 0;
            background: #000; box-shadow: 0 0 0 1px rgba(255,255,255,0.05);
            transform-origin: 0 0;
            display: flex; align-items: center; justify-content: center;
            line-height: 0;
            /* 默认尺寸：open 后 JS 会根据目标分辨率 contain 重新赋值 */
            width: 640px; height: 360px;
        }
        .xzg-ve-canvas { width: 100%; height: 100%; display: none; image-rendering: auto; }
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
        /* 暂停符号 ❚❚：两根竖线，对称居中（正在播放时显示） */
        .xzg-ve-play-btn.xzg-ve-playing::before {
            content: ""; display: inline-block;
            width: 10px; height: 12px;
            border-left: 3px solid #fff; border-right: 3px solid #fff;
            box-sizing: border-box;
        }
        /* 播放符号 ▶：CSS 三角形，精确居中（暂停时显示；字形 ▶ 默认偏左） */
        .xzg-ve-play-btn:not(.xzg-ve-playing)::before {
            content: ""; display: inline-block;
            border-style: solid; border-width: 6px 0 6px 10px;
            border-color: transparent transparent transparent #fff;
            margin-left: 2px;
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
        .xzg-ve-props-resizer {
            width: 8px; cursor: col-resize; background: transparent;
            flex-shrink: 0; position: relative; transition: background 0.15s;
        }
        .xzg-ve-props-resizer::after {
            content: ""; position: absolute; left: 50%; top: 50%;
            transform: translate(-50%, -50%);
            width: 2px; height: 0; background: transparent; border-radius: 1px;
            transition: background 0.15s, height 0.15s;
        }
        .xzg-ve-props-resizer:hover::after,
        .xzg-ve-props-resizer.xzg-ve-resizing::after {
            background: #FFFFFF; height: 32px;
        }
        .xzg-ve-props-panel {
            width: 220px; background: #2a2a2a; border-left: 1px solid #535353;
            display: flex; flex-direction: column; flex-shrink: 0;
            box-shadow: -1px 0 0 0 rgba(83,83,83,0.5), inset 1px 0 0 0 rgba(83,83,83,0.5);
        }
        .xzg-ve-props-tabs {
            display: flex; border-bottom: 1px solid #535353; flex-shrink: 0;
        }
        .xzg-ve-props-tab {
            flex: 1; padding: 6px 0; background: transparent; border: none;
            color: #888; font-size: 12px; cursor: pointer;
            border-bottom: 2px solid transparent;
        }
        .xzg-ve-props-tab:hover { color: #ccc; }
        .xzg-ve-props-tab-active { color: #fff; border-bottom-color: #dcc85b; font-weight: bold; }
        .xzg-ve-props-tab:focus, .xzg-ve-props-tab:focus-visible { outline: none; }
        .xzg-ve-props-content { flex: 1; overflow-y: auto; padding: 8px 10px; font-size: 11px; }
        .xzg-ve-prop-row { margin-bottom: 8px; }
        .xzg-ve-prop-label { color: #888; margin-bottom: 3px; }
        .xzg-ve-prop-input {
            width: 100%; padding: 4px 6px; background: #2a2a2a; border: 1px solid #444;
            border-radius: 3px; color: #ddd; font-size: 11px; box-sizing: border-box;
        }
        .xzg-ve-prop-input:focus { border-color: #dcc85b; outline: none; }
        .xzg-ve-prop-range-wrap { display: flex; align-items: center; gap: 4px; }
        .xzg-ve-prop-range { flex: 1; min-width: 0; height: 4px; accent-color: #dcc85b; outline: none; }
        .xzg-ve-prop-range:focus { outline: none; box-shadow: none; }
        .xzg-ve-prop-range.xzg-ve-prop-range-changed { accent-color: #e04848; }
        .xzg-ve-prop-range-val { color: #ddd; font-size: 10px; min-width: 28px; text-align: right; }
        .xzg-ve-prop-reset {
            width: 20px; height: 20px; padding: 0; flex-shrink: 0;
            background: transparent; border: none; color: #888; font-size: 14px;
            cursor: pointer; border-radius: 3px; line-height: 1;
        }
        .xzg-ve-prop-reset:hover { background: #454545; color: #fff; }
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
        .xzg-ve-magnet-btn {
            position: absolute;
            width: 20px; height: 20px; background: transparent; border: none;
            cursor: pointer; padding: 0;
            display: inline-flex; align-items: center; justify-content: center;
            font-size: 20px; line-height: 1;
            /* 开口朝上 */
            transform: rotate(90deg);
            /* 放在分割剪刀左侧 */
            left: calc(150px + (100% - 150px) / 2 - 66px);
            top: 6px;
        }
        .xzg-ve-magnet-btn.xzg-ve-magnet-off { filter: grayscale(1) opacity(0.85); }
        .xzg-ve-magnet-btn:focus, .xzg-ve-magnet-btn:focus-visible { outline: none; }
        .xzg-ve-split-btn {
            position: absolute;
            width: 25px; height: 25px; background: transparent; border: none;
            cursor: pointer; padding: 0;
            display: inline-flex; align-items: center; justify-content: center;
            /* x 位置：扣除左侧150px占位区后，对齐到 resizer 手柄小条左侧一点 */
            left: calc(150px + (100% - 150px) / 2 - 20px);
            transform: translateX(-50%);
        }
        .xzg-ve-split-btn svg circle, .xzg-ve-split-btn svg line { transition: stroke 0.15s ease; }
        .xzg-ve-split-btn:hover svg circle, .xzg-ve-split-btn:hover svg line { stroke: rgb(0,255,100); }
        .xzg-ve-split-btn:focus, .xzg-ve-split-btn:focus-visible { outline: none; }
        .xzg-ve-flag-btn {
            position: absolute;
            width: 25px; height: 25px; background: transparent; border: none;
            cursor: pointer; padding: 0;
            display: inline-flex; align-items: center; justify-content: center;
            left: calc(150px + (100% - 150px) / 2 + 5px);
            top: 6px;
        }
        .xzg-ve-flag-btn svg { transition: stroke 0.15s ease; }
        .xzg-ve-flag-btn:hover svg { stroke: #7abfff; }
        .xzg-ve-flag-btn:focus, .xzg-ve-flag-btn:focus-visible { outline: none; }
        .xzg-ve-ruler-btn, .xzg-ve-rulerzoom-btn {
            position: absolute;
            width: 32px; height: 32px; background: transparent; border: none;
            cursor: pointer; padding: 0;
            display: inline-flex; align-items: center; justify-content: center;
            color: rgba(255,255,255,0.75);
            top: -3px;
        }
        .xzg-ve-ruler-btn svg, .xzg-ve-rulerzoom-btn svg { transition: color 0.15s ease; }
        .xzg-ve-ruler-btn:hover svg, .xzg-ve-rulerzoom-btn:hover svg { color: #7abfff; }
        .xzg-ve-ruler-btn:focus, .xzg-ve-ruler-btn:focus-visible,
        .xzg-ve-rulerzoom-btn:focus, .xzg-ve-rulerzoom-btn:focus-visible { outline: none; }
        .xzg-ve-ruler-btn { left: calc(150px + (100% - 150px) / 2 + 305px); }
        .xzg-ve-rulerzoom-btn { left: calc(150px + (100% - 150px) / 2 + 350px); }
        .xzg-ve-marker-flag {
            position: absolute; top: 2px; width: 12px; height: 14px;
            pointer-events: auto; cursor: pointer; z-index: 5;
        }
        .xzg-ve-marker-flag:hover { opacity: 0.7; }
        .xzg-ve-btn.xzg-ve-btn-reset-layout {
            position: absolute; top: 2px; left: 2px; right: 2px;
            height: 30px; padding: 0; font-size: 12px; line-height: 1;
            border: none; border-radius: 3px;
            background: transparent; color: #aaa;
            display: flex; align-items: center; justify-content: center;
            cursor: pointer; z-index: 10;
        }
        .xzg-ve-btn.xzg-ve-btn-reset-layout:hover { background: #454545; color: #ddd; }
        .xzg-ve-reset-icon { vertical-align: middle; }
        .xzg-ve-timeline {
            flex: 1; position: relative; background: #2a2a2a; overflow: clip;
            overflow-clip-margin: 10px; /* 允许播放头标记伸出边界10px不被裁剪 */
            min-height: 0; padding: 4px 0;
            outline: none; /* 按空格播放时容器获焦点，屏蔽浏览器默认白色轮廓 */
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
        /* 轨道空隙选中框（与拖动预览框同风格：金色虚线 + 半透明金色填充） */
        .xzg-ve-gap-sel {
            position: absolute; top: 0; bottom: 0;
            background: rgba(220, 200, 91, 0.15);
            border: 1px dashed #dcc85b;
            border-radius: 3px;
            pointer-events: none; z-index: 15;
            box-sizing: border-box;
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
        /* V2-上 / V2-下 轨道头：复用视频头视觉（高度由 JS 设置覆盖 60px 默认值） */
        .xzg-ve-video2-top-header,
        .xzg-ve-video2-bot-header {
            position: absolute; left: 0; right: 0;
            padding: 4px 8px;
            display: flex; align-items: center; background: #303030;
        }
        .xzg-ve-track-name {
            color: #ddd; font-size: 12px; flex: 1;
            user-select: none; -webkit-user-select: none;
            cursor: pointer; /* 双击可切换仅视频/仅音频显示 */
        }
        /* 轨道名单击高亮：红色 + 加粗 + 加大字体（单选，同时仅一个轨道名高亮） */
        .xzg-ve-track-name.xzg-ve-track-name-active {
            color: #ff5252;
            font-weight: 700;
            font-size: 15px;
        }
        /* 三个手柄：top(视频高度)、mid(视频/音频分配比例)、bottom(音频高度)
           都用 absolute + top 定位，由 JS _applyTrackLayout 统一计算 */
        .xzg-ve-track-resizer {
            position: absolute; left: 0; right: 0; height: 8px;
            cursor: ns-resize; z-index: 7;
        }
        .xzg-ve-track-resizer::after {
            content: ""; position: absolute; left: 75px; top: 50%;
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
        /* A1 / A2（音频副轨道）：A1 下贴 V1 交界细分隔线；A2 上贴音频↔A2 5px 分割线 */
        .xzg-ve-video2-top-track {
            background: #2a2a2a;
            border-bottom-left-radius: 0;
            border-bottom-right-radius: 0;
            padding: 2px 2px 0 0;  /* 下padding 0，贴细分隔线 */
        }
        .xzg-ve-video2-bot-track {
            background: #2a2a2a;
            border-top-left-radius: 0;
            border-top-right-radius: 0;
            padding: 0 2px 2px 0;  /* 上padding 0，贴5px分割线 */
        }
        /* 视频轨道内片段：height:100%填满content-box；父box-sizing:border-box高度vH已含顶部2pxpadding
           → 片段底部正好=轨道底部=分割线顶部（midTop），零缝隙 */
        .xzg-ve-video-track .xzg-ve-clip { height: 100%; }
        .xzg-ve-video2-top-track .xzg-ve-clip { height: 100%; }
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
        .xzg-ve-clip-name { color: rgba(255,255,255,0.85); font-weight: normal; font-size: 12px; }
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
        /* 图标占位：固定 16px 宽度，保证文字左对齐 */
        .xzg-ve-ctx-icon {
            display: inline-flex; align-items: center; justify-content: center;
            width: 16px; height: 16px;
            flex-shrink: 0;
            font-size: 12px;
            line-height: 1;
        }
        .xzg-ve-ctx-label { flex: 1; }
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
            position: absolute; top: 0; bottom: 0; width: 1px; background: #ff4444;
            box-shadow: -1px 0 0 #ff4444, 1px 0 0 #ff4444;
            z-index: 1000; pointer-events: none; display: none; left: 0;
            will-change: left;
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
        .xzg-ve-btn.xzg-ve-btn-manual {
            background: transparent; color: #ff5252; border: none;
            border-radius: 4px; padding: 0 7px; font-size: 16px; line-height: 1;
            margin-right: 4px; cursor: pointer;
            display: inline-flex; align-items: center; justify-content: center;
        }
        .xzg-ve-btn.xzg-ve-btn-manual svg { display: block; }
        .xzg-ve-btn.xzg-ve-btn-manual:hover {
            background: transparent;
        }
        .xzg-ve-btn.xzg-ve-btn-manual:focus,
        .xzg-ve-btn.xzg-ve-btn-manual:focus-visible { outline: none; }
        .xzg-ve-btn.xzg-ve-btn-output-settings {
            background: transparent; color: #fff; border: none;
            border-radius: 4px; padding: 3px 10px; font-size: 12px;
            white-space: nowrap;
        }
        .xzg-ve-btn.xzg-ve-btn-output-settings:hover {
            background: rgba(255, 255, 255, 0.15);
        }
        .xzg-ve-btn.xzg-ve-btn-output-settings:focus,
        .xzg-ve-btn.xzg-ve-btn-output-settings:focus-visible { outline: none; }
        .xzg-ve-btn-apply {
            background: transparent; color: #dcc85b; border: none;
            font-size: 16px; font-weight: bold;
        }
        .xzg-ve-btn-apply:hover { background: rgba(220, 200, 91, 0.15); }
        .xzg-ve-btn-cancel {
            background: transparent; color: #dcc85b; border: none;
            font-size: 16px; font-weight: bold;
        }
        .xzg-ve-btn-cancel:hover { background: rgba(220, 200, 91, 0.15); }
        /* 右上角 X 按钮：直接关闭，不触发导出计算 */
        .xzg-ve-btn-close-x {
            background: transparent;
            color: #ff6b6b;
            border: none;
            font-size: 22px;
            font-weight: bold;
            line-height: 1;
            padding: 4px 8px;
            margin-left: 6px;
            height: 26px;
            box-sizing: border-box;
            cursor: pointer;
            border-radius: 3px;
            outline: none;
            user-select: none;
            -webkit-tap-highlight-color: transparent;
        }
        .xzg-ve-btn-close-x:hover {
            background: #5a2a2a;   /* 小珠光统一：× 按钮悬停红色方格底色 */
            color: #ff6b6b;
        }
        .xzg-ve-btn-close-x:focus,
        .xzg-ve-btn-close-x:focus-visible {
            outline: none;
            box-shadow: none;
        }
        .xzg-ve-quality-label { color: #fff; font-size: 12px; font-weight: bold; margin-left: 10px; }
        .xzg-ve-format-label  { color: #fff; font-size: 12px; font-weight: bold; }
        .xzg-ve-quality-select,
        .xzg-ve-format-select {
            background: #1D1D1D; color: #fff; border: 1px solid #000;
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
        .xzg-ve-render-label { color: #fff; }
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
        .xzg-ve-render-opts select:focus { border-color: #000; outline: none; }
        .xzg-ve-btn-portrait, .xzg-ve-btn-portrait:hover {
            font-size: 12px; padding: 0; margin-left: 4px;
            background: transparent; border: none; cursor: default;
            color: #fff; vertical-align: middle;
        }
        /* 分辨率栏「重置视图」按钮：四角图标（fit-to-view），跟随竖屏方块尺寸 */
        .xzg-ve-btn-reset-view {
            width: 18px; height: 18px; padding: 0; margin-left: 6px;
            background: transparent; border: none; cursor: pointer;
            display: inline-flex; align-items: center; justify-content: center;
            vertical-align: middle; border-radius: 3px;
            transition: background 0.15s;
            outline: none; user-select: none; -webkit-tap-highlight-color: transparent;
        }
        .xzg-ve-btn-reset-view:hover { background: rgba(220, 200, 91, 0.15); }
        .xzg-ve-btn-reset-view:focus, .xzg-ve-btn-reset-view:focus-visible { outline: none; }
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
        .xzg-ve-render-opts input:disabled, .xzg-ve-render-opts select:disabled { opacity: 0.4; cursor: not-allowed; }
        .xzg-ve-btn-portrait:disabled { color: #fff; cursor: not-allowed; }
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
        // 音频加载器模式：自动清理时间线上「看不到的视频」片段，避免影响导出时长
        if (this._modeFilter === "audio") {
            const videoClips = this.timeline.filter(c => c.kind !== "audio");
            if (videoClips.length > 0) {
                this.timeline = this.timeline.filter(c => c.kind === "audio");
                for (const v of videoClips) this.selectedClipIds.delete(v.id);
                this._saveTimelineSession();
                this._renderTimeline();
                this._renderProps();
                this._setStatus(`已自动清理 ${videoClips.length} 个视频片段（音频模式）`);
            }
        }
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
                // 探测成功 → 同步清掉「单个缩略图失败黑名单 + loading 去重锁」
                // 否则清理缓存后重导入，列表渲染会先读 THUMB_CACHE.failed=true → 直接显示 ❌，
                // 不再触发 _loadThumbnail 重试
                delete _XZG_VE_THUMB_CACHE[key];
                _XZG_VE_THUMB_LOADING.delete(key);
                // 探测成功：文件已恢复在线，从离线集合移除
                if (this.offlineMediaNames.has(m.name)) {
                    this.offlineMediaNames.delete(m.name);
                    this._renderTimeline();
                }
                this._renderMediaList();
                continue;
            } else if (cached && cached.state === "failed") {
                // 之前探测失败过：但「一键清理缓存后重新导入 / 重新上传恢复离线」场景下，
                // 文件已在磁盘上重新存在 → 必须重试，不能永远走失败黑名单
                console.log("[xzg-ve] probeQueue: 缓存命中(failed), 清掉后重试, name=", m.name);
                delete _XZG_VE_PROBE_CACHE[key];
                m.error = cached.error;
                // 重置 probeState 为 pending，标记 dirty，循环重新跑探测
                m.probeState = "pending";
                this._probeDirty = true;
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
                        // 清理时间线缩略图流级的失败缓存与 loading 锁，
                        // 确保之前失败过的同 key，能拿到新的 thumbs 不再永远走失败态
                        _XZG_VE_FULL_THUMB_STREAM_LOADING.delete(mediaKey);
                        console.log("[xzg-ve] probeQueue: 缩略图流已预填充, name=", m.name, "count=", thumbs.length);
                    } else if (resp.thumbs_error) {
                        console.warn("[xzg-ve] probeQueue: 缩略图流生成失败（视频正常）, name=", m.name, "err=", resp.thumbs_error);
                    }
                    // 探测 + 缩略图流返回后：必须同步清「媒体库单缩略图失败黑名单 / loading 锁」
                    // 否则 renderMediaList 读 THUMB_CACHE.failed=true 会直接显示 ❌，不触发 _loadThumbnail 重试
                    delete _XZG_VE_THUMB_CACHE[key];
                    _XZG_VE_THUMB_LOADING.delete(key);
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
            // 名称：根据媒体类型添加对应图标
            const isAudioIcon = m.isAudio;
            const isImgIcon = m.isImage || _isImage(m.name);
            const nameDiv = _el("div", "xzg-ve-media-name", null, item);
            // SVG 图标
            const iconSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            iconSvg.setAttribute("viewBox", "0 0 24 24");
            iconSvg.setAttribute("fill", "none");
            iconSvg.setAttribute("stroke-width", "2");
            iconSvg.setAttribute("stroke-linecap", "round");
            iconSvg.setAttribute("stroke-linejoin", "round");
            iconSvg.classList.add("xzg-ve-media-icon");
            if (isAudioIcon) {
                // 双音符 🎵（紫色）
                iconSvg.setAttribute("stroke", "#6953B0");
                iconSvg.innerHTML = '<path d="M9,3 V17"/><ellipse cx="7" cy="17" rx="3" ry="2.5"/><path d="M9,5 L17,9"/><path d="M17,9 V19"/><ellipse cx="15" cy="19" rx="3" ry="2.5"/>';
            } else if (isImgIcon) {
                // 图片（绿色）
                iconSvg.setAttribute("stroke", "#4CAF50");
                iconSvg.innerHTML = '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21,15 16,10 5,21"/>';
            } else {
                // 摄像机（视频，橙色）
                iconSvg.setAttribute("stroke", "#FF8C00");
                iconSvg.innerHTML = '<polygon points="23,7 16,12 23,17"/><rect x="1" y="5" width="15" height="14" rx="2"/><circle cx="8.5" cy="12" r="1.5"/>';
            }
            nameDiv.appendChild(iconSvg);
            nameDiv.appendChild(document.createTextNode(" " + (m.displayName || m.name)));
            let infoText = "";
            let infoClass = "xzg-ve-media-info";
            const isAudio = m.isAudio;
            const isImg = m.isImage || _isImage(m.name);
            if (isOffline) {
                infoText = "❌ 离线媒体";
                infoClass += " xzg-ve-media-info-err";
            } else if (m.probeState === "ok" && m.info) {
                if (isAudio) {
                    infoText = `音频 · ${_fmtTime(m.info.duration)}`;
                } else if (isImg) {
                    infoText = `图片 · ${m.info.width}×${m.info.height}`;
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
            // Ctrl/Meta+点击：增减选择；Shift+点击：范围选择（锚点到当前项之间全部，含两端）；
            // 普通点击：单选（重置锚点）
            item.addEventListener("mousedown", (e) => {
                if (e.shiftKey && this._mediaSelAnchor) {
                    // Shift 范围选择：锚点 → 当前项（含两端）
                    const names = this.mediaLibrary.map(mm => mm.name);
                    const ai = names.indexOf(this._mediaSelAnchor);
                    const ci = names.indexOf(m.name);
                    if (ai >= 0 && ci >= 0) {
                        const [from, to] = ai <= ci ? [ai, ci] : [ci, ai];
                        this.selectedMediaNames = new Set(names.slice(from, to + 1));
                    } else {
                        // 锚点不在当前列表（已删除）：退化为单选并重置锚点
                        this.selectedMediaNames = new Set([m.name]);
                        this._mediaSelAnchor = m.name;
                    }
                } else if (e.ctrlKey || e.metaKey) {
                    if (this.selectedMediaNames.has(m.name)) {
                        this.selectedMediaNames.delete(m.name);
                    } else {
                        this.selectedMediaNames.add(m.name);
                    }
                    this._mediaSelAnchor = m.name; // Ctrl 点选也更新锚点（Shift 以最后操作项为基准）
                } else {
                    if (!this.selectedMediaNames.has(m.name)) {
                        this.selectedMediaNames = new Set([m.name]);
                    }
                    this._mediaSelAnchor = m.name; // 单选重置锚点
                }
                // 点媒体时清空时间线选中（含轨道空隙选中）
                this._clearGapSelection();
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

    // ═══════════════════════════════════════════════════════════
    //  属性面板宽度拖动调整（手柄在属性面板最左侧）
    // ═══════════════════════════════════════════════════════════
    _restorePropsWidth() {
        try {
            const w = parseInt(localStorage.getItem(this._propsWidthKey), 10);
            if (w >= 160 && w <= 600 && this._propsPanel) {
                this._propsPanel.style.width = w + "px";
            }
        } catch (_) {}
    }

    _savePropsWidth(w) {
        try { localStorage.setItem(this._propsWidthKey, String(w)); } catch (_) {}
    }

    _bindPropsResizer() {
        if (!this._propsResizer || !this._propsPanel) return;
        this._propsResizer.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this._propsResizer.classList.add("xzg-ve-resizing");
            const panel = this._propsPanel;
            const startX = e.clientX;
            const startW = panel.getBoundingClientRect().width;
            const onMove = (ev) => {
                // 属性面板在右侧，向左拖（startX - clientX）增大宽度
                let w = startW + (startX - ev.clientX);
                if (w < 160) w = 160;
                if (w > 600) w = 600;
                panel.style.width = w + "px";
            };
            const onUp = () => {
                window.removeEventListener("mousemove", onMove);
                window.removeEventListener("mouseup", onUp);
                this._propsResizer.classList.remove("xzg-ve-resizing");
                const finalW = Math.round(panel.getBoundingClientRect().width);
                this._savePropsWidth(finalW);
                this._setStatus(`属性面板宽度: ${finalW}px`);
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
            // 记录起始四轨道高度：拖动面板高度时四轨道同等压缩/扩张（每条 ±Δ/4，保留相对差异）
            const sV2t = this._tlV2TopHeight;
            const sVH = this._tlVideoHeight;
            const sAH = this._tlAudioHeight;
            const sV2b = this._tlV2BotHeight;
            const minT = 25;
            this._tlHeightsCustomized = true; // 拖动期间不走 _applyTrackLayout 自动均分，直接应用等量变化
            const onMove = (ev) => {
                let h = startH + (startY - ev.clientY);
                // 音频加载器模式：仅 A1/A2 两轨可见，V2-上/V1 隐藏且高度保持 0
                //   最小高度 = 36(header) + 35(刻度) + 25*2(两轨) = 121
                //   固定偏移 = 71（无 5px 粗分割线，A1↔A2 1px 细线为 overlaid 不占高）
                // 通用模式：四轨可见，最小 176，固定偏移 76（含 5px 粗分割线）
                const isAudioMode = this._modeFilter === "audio";
                const minH = isAudioMode ? 121 : 176;
                const fixedOff = isAudioMode ? 71 : 76;
                if (h < minH) h = minH;
                if (h > 500) h = 500;
                const delta = h - startH;   // 面板高度变化量（正=变高，负=变矮）
                if (isAudioMode) {
                    // delta 等量分配给 A1/A2；压缩时钳制到 25px，超出部分相互补偿
                    const d2 = delta / 2;
                    let vals2 = [sAH + d2, sV2b + d2];
                    if (delta < 0) {
                        let clamped = 0;
                        vals2 = vals2.map(v => {
                            if (v < minT) { clamped += minT - v; return minT; }
                            return v;
                        });
                        let guard = 0;
                        while (clamped > 0.5 && guard < 4) {
                            guard++;
                            const candIdx = [];
                            let candSum = 0;
                            for (let i = 0; i < 2; i++) {
                                if (vals2[i] > minT + 0.001) { candIdx.push(i); candSum += vals2[i] - minT; }
                            }
                            if (!candIdx.length) break;
                            let redist = 0;
                            for (const i of candIdx) {
                                const cap = vals2[i] - minT;
                                const share = Math.min(cap, clamped * cap / candSum);
                                vals2[i] -= share;
                                redist += share;
                            }
                            clamped -= redist;
                            if (redist <= 0.001) break;
                        }
                    }
                    this._tlV2TopHeight = 0;
                    this._tlVideoHeight = 0;
                    this._tlAudioHeight = Math.round(vals2[0]);
                    this._tlV2BotHeight = Math.round(vals2[1]);
                    // 面板高度 = 36 header + 35 刻度 + A1 + A2（无 5px 粗分割线）
                    const trackSum2 = this._tlAudioHeight + this._tlV2BotHeight;
                    panel.style.height = Math.max(minH, fixedOff + trackSum2) + "px";
                    this._applyTrackLayout();
                    return;
                }
                const d = delta / 4;        // 等量增减量（每轨）
                // 各轨道先等量增减
                let vals = [sV2t + d, sVH + d, sAH + d, sV2b + d];
                if (delta < 0) {
                    // 压缩：先对每条轨道钳制到最小 25px；被钳掉的空间按“剩余可压缩量”比例补偿给仍可压缩的轨道，
                    // 避免 V1/A1/A2 已被压到极限时，继续拖分界手柄把它们的值压成负数、挤出边界消失
                    let clamped = 0;
                    vals = vals.map(v => {
                        if (v < minT) { clamped += minT - v; return minT; }
                        return v;
                    });
                    let guard = 0;
                    while (clamped > 0.5 && guard < 8) {
                        guard++;
                        const candIdx = [];
                        let candSum = 0;
                        for (let i = 0; i < 4; i++) {
                            if (vals[i] > minT + 0.001) { candIdx.push(i); candSum += vals[i] - minT; }
                        }
                        if (!candIdx.length) break;
                        let redist = 0;
                        for (const i of candIdx) {
                            const cap = vals[i] - minT;   // 该轨道剩余可压缩量
                            const share = Math.min(cap, clamped * cap / candSum);
                            vals[i] -= share;
                            redist += share;
                        }
                        clamped -= redist;
                        if (redist <= 0.001) break;
                    }
                }
                this._tlV2TopHeight = Math.round(vals[0]);
                this._tlVideoHeight = Math.round(vals[1]);
                this._tlAudioHeight = Math.round(vals[2]);
                this._tlV2BotHeight = Math.round(vals[3]);
                // 面板高度与实际四轨总高保持一致（36 header + 35 刻度 + 轨道总高 + 5px 粗分割），
                // 轨道已全到极限时面板不再下压，轨道不会被挤出边界
                const trackSum = this._tlV2TopHeight + this._tlVideoHeight + this._tlAudioHeight + this._tlV2BotHeight;
                panel.style.height = Math.max(minH, fixedOff + trackSum) + "px";
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
                this._syncAllClipThumbs();
                this._renderTicks();
                this._updatePlayhead();
            };
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
        });

        // Shift+鼠标滚轮：在 V2上/V1/音频/V2下 轨道上调整对应轨道高度（与手柄拖动规则一致，可达极限）
        const onTrackWheel = (which) => (e) => {
            if (!e.shiftKey) return;
            e.preventDefault();
            e.stopPropagation();
            // 滚轮向上(deltaY<0)增大高度，向下(deltaY>0)减小高度
            const delta = e.deltaY < 0 ? 10 : -10;
            this._tlHeightsCustomized = true;
            const minT = 25;
            // 只改当前轨道高度，其他轨道保持不变
            const fields = { v2top: "_tlV2TopHeight", video: "_tlVideoHeight", audio: "_tlAudioHeight", v2bot: "_tlV2BotHeight" };
            const f = fields[which];
            if (!f) return;
            // 音频加载器模式：仅 A1/A2 两轨可见，固定偏移 71（无 5px 粗分割线）、最小 121
            // 通用模式：四轨可见，固定偏移 76（含 5px 粗分割线）、最小 176
            const isAudioMode = this._modeFilter === "audio";
            const fixedOff = isAudioMode ? 71 : 76;
            const minH = isAudioMode ? 121 : 176;
            // 当前轨道上限 = 面板上限(500) - 固定偏移 - 其他轨道之和，保证时间线底部不溢出
            const sum = this._tlV2TopHeight + this._tlVideoHeight + this._tlAudioHeight + this._tlV2BotHeight;
            const maxT = Math.max(minT, (500 - fixedOff) - (sum - this[f]));
            this[f] = Math.min(Math.max(minT, this[f] + delta), maxT);
            // 面板高度 = 36 header + 35 刻度 + (5px 粗分割) + 轨道总高
            // 其他轨道不变 → 底部固定，预览/时间线分界随面板高度自适应
            const trackSum = this._tlV2TopHeight + this._tlVideoHeight + this._tlAudioHeight + this._tlV2BotHeight;
            const panelH = Math.max(minH, fixedOff + trackSum);
            if (this._tlPanel) this._tlPanel.style.height = panelH + "px";
            this._tlHeight = panelH;
            this._applyTrackLayout();
        };
        if (this._tlV2TopTrack) this._tlV2TopTrack.addEventListener("wheel", onTrackWheel("v2top"), { passive: false });
        if (this._tlTrack) this._tlTrack.addEventListener("wheel", onTrackWheel("video"), { passive: false });
        if (this._tlAudioTrack) this._tlAudioTrack.addEventListener("wheel", onTrackWheel("audio"), { passive: false });
        if (this._tlV2BotTrack) this._tlV2BotTrack.addEventListener("wheel", onTrackWheel("v2bot"), { passive: false });
    }

    // 一键恢复默认布局：重置预览区与时间线占比、V2上/V1/音频/V2下 轨道高度为默认值，
    // 不影响已加载的视频、时间线片段内容、媒体库内容
    _resetTrackLayout() {
        // 恢复时间线面板默认高度（预览区与时间线的分割占比）
        this._tlHeight = 350;
        if (this._tlPanel) this._tlPanel.style.height = "350px";
        this._saveTimelineHeight(350);
        this._tlMaximizedTrack = null; // 清除双击最大化轨道状态
        this._clearGapSelection(); // 布局重置后轨道显示状态可能变化，清空空隙选中
        // 音频加载器模式：仅显示音频轨道，A1/A2 均分高度
        if (this._modeFilter === "audio") {
            this._tlViewMode = "audio";
            this._tlHeightsCustomized = true;
            const tlH = Math.max(1, (this._timeline && this._timeline.clientHeight > 0) ? this._timeline.clientHeight : 400);
            const trackAreaH = tlH - 35;
            this._tlV2TopHeight = 0;
            this._tlVideoHeight = 0;
            const eachH = Math.floor((trackAreaH - 1) / 2);
            this._tlAudioHeight = eachH;
            this._tlV2BotHeight = eachH;
        } else {
            this._tlViewMode = "both";
            this._tlHeightsCustomized = false;
        }
        this._applyTrackLayout();
        this._saveTlLayout();
        this._renderTicks();
        this._updatePlayhead();
    }

    // 同步五个手柄、V2上/V1/音频/V2下 轨道头与轨道的 top 位置（达芬奇式）
    // 布局（自上而下）：
    //   V2-上手柄 → V2-上头/轨道 → V2-上↔V1 分割线 → V1 上手柄 → V1 头/轨道
    //   → 中手柄 → V1↔音频 分割线 → 音频头/轨道 → 音频↔V2-下 分割线 → V2-下 手柄 → V2-下 头/轨道
    _applyTrackLayout() {
        // 默认布局（未自定义）：V2 / V1 / A1 / A2 四轨道平均分配
        //   trackAreaH = 面板高 - 35(刻度区)，扣除 5px 粗分割线后均分 4 份（余数补前面轨道），每条最小 25px
        if (!this._tlHeightsCustomized && this._timeline && this._timeline.clientHeight > 0) {
            const tlH = Math.max(1, this._timeline.clientHeight);
            const trackAreaH = tlH - 35;
            const dividers = 5; // 1 条 5px 粗分割（V1↔A1 视频/音频大分界）；V2↔V1、A1↔A2 仅 1px 细线不计入
            const minT = 25;
            const avail = Math.max(minT * 4, trackAreaH - dividers);
            const q = Math.floor(avail / 4), r = avail - q * 4;
            this._tlV2TopHeight = q + (r > 0 ? 1 : 0);
            this._tlVideoHeight = q + (r > 1 ? 1 : 0);
            this._tlAudioHeight = q + (r > 2 ? 1 : 0);
            this._tlV2BotHeight = q;
        }
        // 最大化轨道：选中轨道铺满，其他3轨压缩到25px
        const maxTrack = this._tlMaximizedTrack;
        if (maxTrack) {
            const tlH = Math.max(1, (this._timeline && this._timeline.clientHeight > 0) ? this._timeline.clientHeight : 400);
            const trackAreaH = tlH - 35;
            // 分割线：V2-V1 1px + V1-A1 5px + A1-A2 1px = 7px
            const maxH = Math.max(25, trackAreaH - 7 - 25 * 3);
            const set = { v2: "_tlV2TopHeight", v1: "_tlVideoHeight", a1: "_tlAudioHeight", a2: "_tlV2BotHeight" };
            for (const [k, f] of Object.entries(set)) {
                this[f] = k === maxTrack ? maxH : 25;
            }
        }
        const v2tH = this._tlV2TopHeight;
        const vH = this._tlVideoHeight;
        const aH = this._tlAudioHeight;
        const v2bH = this._tlV2BotHeight;
        // 隐藏轨道仍参与位置计算，切换回来不跳位
        const mode = this._tlViewMode || "both";
        const showV = mode !== "audio";
        const showA = mode !== "video";
        // A1 / A2（音频副轨道，跟随音频显示）
        if (this._tlV2TopHeader) this._tlV2TopHeader.style.display = showV ? "" : "none";
        if (this._tlV2TopTrack) this._tlV2TopTrack.style.display = showV ? "" : "none";
        if (this._tlV2BotHeader) this._tlV2BotHeader.style.display = showA ? "" : "none";
        if (this._tlV2BotTrack) this._tlV2BotTrack.style.display = showA ? "" : "none";
        if (this._tlResizerV2Top) this._tlResizerV2Top.style.display = showV ? "" : "none";
        // A1↔A2 1px 细分隔（音频组内部细分隔）：需音频显示
        if (this._tlDividerV2Bot) this._tlDividerV2Bot.style.display = showA ? "" : "none";
        // V2↔V1 1px 细实线分隔（视频组内部细分隔）：需视频显示
        if (this._tlVideoTopDivider) this._tlVideoTopDivider.style.display = showV ? "" : "none";
        // V1 视频
        if (this._tlVideoHeader) this._tlVideoHeader.style.display = showV ? "" : "none";
        if (this._tlTrack) this._tlTrack.style.display = showV ? "" : "none";
        if (this._tlResizerTop) this._tlResizerTop.style.display = showV ? "" : "none";
        // 中手柄 / V1↔音频 分割线（需 V1+音频同时显示）
        if (this._tlResizerMid) this._tlResizerMid.style.display = (showV && showA) ? "" : "none";
        if (this._tlDivider) this._tlDivider.style.display = (showV && showA) ? "" : "none";
        // 音频
        if (this._tlAudioHeader) this._tlAudioHeader.style.display = showA ? "" : "none";
        if (this._tlAudioTrack) this._tlAudioTrack.style.display = showA ? "" : "none";
        if (this._tlResizerBottom) this._tlResizerBottom.style.display = showA ? "" : "none";
        // A2 底边缘 1px 实线（A2 最底，需 A2 显示）
        if (this._tlAudioBottomDivider) this._tlAudioBottomDivider.style.display = showA ? "" : "none";

        // 位置计算（相对 35px 刻度区域底部，向下为正）
        //   视频组（上）：V2 → V1（中间 1px 细分隔）
        //   5px 粗大分界：V1↔A1（视频/音频大分界，仅 mid 一条）
        //   音频组（下）：A1 → A2（中间 1px 细分隔，A1↔A2）
        const v2tTop = 0;                 // V2 顶（紧贴刻度区下沿）
        const v1Top = v2tH;               // V1 顶 = V2 底（中间 1px 细分隔，无 5px 粗线）
        const midTop = v1Top + vH;        // V1 底 = V1↔A1 5px 粗分割线上沿（大分界）
        // 音频加载器模式：无视频轨道，音频从顶部开始（无 5px 粗分割线）
        const aTop = this._modeFilter === "audio" ? 0 : (midTop + 5);
        const botTop = aTop + aH;         // A1 底 = A1↔A2 交界处（1px 细分隔）
        const v2bTop = botTop;            // A2 顶 = A1 底（中间 1px 细分隔，无 5px 粗线）
        // 用 calc(35px + Npx)：刻度区域固定 35px，不随时间线高度变化
        const calc = (n) => `calc(35px + ${n}px)`;

        // V2↔V1 1px 细实线分隔：紧贴 V2 底 / V1 顶 交界上方 0.5px
        if (this._tlVideoTopDivider) this._tlVideoTopDivider.style.top = calc(v1Top - 0.5);
        // V2 手柄：中心对齐 V2 底（= V1 顶）
        if (this._tlResizerV2Top) this._tlResizerV2Top.style.top = calc(v1Top - 4);
        // V2 头 / 轨道
        if (this._tlV2TopHeader) {
            this._tlV2TopHeader.style.top = calc(v2tTop);
            this._tlV2TopHeader.style.height = v2tH + "px";
        }
        if (this._tlV2TopTrack) {
            this._tlV2TopTrack.style.top = calc(v2tTop);
            this._tlV2TopTrack.style.height = v2tH + "px";
        }
        // V1 上手柄：中心对齐 V1 顶（与 V2 手柄中心位置相同，叠加无碍）
        if (this._tlResizerTop) this._tlResizerTop.style.top = calc(v1Top - 4);
        // V1 头 / 轨道
        if (this._tlVideoHeader) {
            this._tlVideoHeader.style.top = calc(v1Top);
            this._tlVideoHeader.style.height = vH + "px";
        }
        if (this._tlTrack) {
            this._tlTrack.style.top = calc(v1Top);
            this._tlTrack.style.height = vH + "px";
        }
        // 中手柄：中心对齐 V1↔A1 5px 粗分割线（mid）的中线（midTop + 2.5）
        if (this._tlResizerMid) this._tlResizerMid.style.top = calc(midTop + 2.5 - 4);
        // V1↔A1 5px 粗分割线（mid，视频/音频大分界）
        if (this._tlDivider) this._tlDivider.style.top = calc(midTop);
        // A1 头 / 轨道
        if (this._tlAudioHeader) {
            this._tlAudioHeader.style.top = calc(aTop);
            this._tlAudioHeader.style.height = aH + "px";
        }
        if (this._tlAudioTrack) {
            this._tlAudioTrack.style.top = calc(aTop);
            this._tlAudioTrack.style.height = aH + "px";
            // 紧凑模式：A1 轨道高度<50px时，波形区<25px色带，波形扩展到色带区域显示
            this._tlAudioTrack.classList.toggle("xzg-ve-audio-compact", aH < 50);
        }
        // A1↔A2 1px 细实线分隔（覆盖 5px 渐变视觉，A1↔A2 交界处上方 0.5px）
        if (this._tlDividerV2Bot) {
            this._tlDividerV2Bot.style.top = calc(botTop - 0.5);
            this._tlDividerV2Bot.style.height = "1px";
            this._tlDividerV2Bot.style.background = "#1a1919";
        }
        // A1 下手柄：中心对齐 A1 底（A1↔A2 交界处）
        if (this._tlResizerBottom) this._tlResizerBottom.style.top = calc(botTop - 4);
        // A2 头 / 轨道
        if (this._tlV2BotHeader) {
            this._tlV2BotHeader.style.top = calc(v2bTop);
            this._tlV2BotHeader.style.height = v2bH + "px";
        }
        if (this._tlV2BotTrack) {
            this._tlV2BotTrack.style.top = calc(v2bTop);
            this._tlV2BotTrack.style.height = v2bH + "px";
            // 紧凑模式（与 A1 一致）：A2 高度<50px 时波形扩展到色带区域显示
            this._tlV2BotTrack.classList.toggle("xzg-ve-audio-compact", v2bH < 50);
        }
        // A2 最底 1px 实线
        if (this._tlAudioBottomDivider) this._tlAudioBottomDivider.style.top = calc(v2bTop + v2bH - 0.5);

        // 轨道高度变化后重绘所有波形，使波形上下收缩自适应新高度（不被裁剪）
        // 用 requestAnimationFrame 延迟到下一帧，确保浏览器已回流、canvas.clientHeight 反映新高度
        requestAnimationFrame(() => {
            this._redrawAllWaveforms();
        });
    }

    // 五个手柄：
    //   v2-top - 调整 V2-上 高度（_tlV2TopHeight），顶部固定（紧贴刻度区下沿 35px），底部移动
    //   top    - 调整 V1 高度（_tlVideoHeight），V1 顶固定（= V2-上 底，中间仅 1px 细分隔），V1 底移动，V2-上 联动
    //   mid    - V1+音频整体上下平移，V2-上 / V2-下 此消彼长（高度之和不变）
    //   bottom - 调整音频高度（_tlAudioHeight），音频顶固定（= V1 底 + 5px），音频底移动，V2-下 联动
    //   v2-bot - 调整 V2-下 高度（_tlV2BotHeight），顶部固定（= 音频底 + 5px），底部移动
    _initTrackResizer() {
        // V2-上 手柄：调整 V2-上 高度（顶部固定，底部移动）
        if (this._tlResizerV2Top) {
            this._tlResizerV2Top.addEventListener("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                this._tlHeightsCustomized = true;
                this._tlResizerV2Top.classList.add("xzg-ve-resizing");
                const startY = e.clientY;
                const startV2t = this._tlV2TopHeight;
                const onMove = (ev) => {
                    // 向下拖→V2-上 底下移→v2tH 增大；向上拖→v2tH 减小
                    const delta = ev.clientY - startY;
                    const tlH = Math.max(1, this._timeline.clientHeight);
                    const trackAreaH = tlH - 35;
                    const gap = 5; // 1 条 5px 粗分割（V1↔A1 视频/音频大分界）；V2↔V1、A1↔A2 仅 1px 细线不计入
                    const maxV2t = Math.max(25, trackAreaH - this._tlVideoHeight - this._tlAudioHeight - this._tlV2BotHeight - gap);
                    this._tlV2TopHeight = Math.max(25, Math.min(maxV2t, Math.round(startV2t + delta)));
                    this._applyTrackLayout();
                };
                const onUp = () => {
                    window.removeEventListener("mousemove", onMove);
                    window.removeEventListener("mouseup", onUp);
                    this._tlResizerV2Top.classList.remove("xzg-ve-resizing");
                    this._saveTlLayout();
                    this._syncAllClipThumbs();
                };
                window.addEventListener("mousemove", onMove);
                window.addEventListener("mouseup", onUp);
            });
        }
        // V1 上手柄：调整 V1 高度（V1 顶固定 = V2-上 底，V1 底移动，V2-上 联动）
        if (this._tlResizerTop) {
            this._tlResizerTop.addEventListener("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                this._tlHeightsCustomized = true;
                this._tlResizerTop.classList.add("xzg-ve-resizing");
                const startY = e.clientY;
                const startVH = this._tlVideoHeight;
                const startV2t = this._tlV2TopHeight; // V2-上 联动基准
                const onMove = (ev) => {
                    // 向上拖→V1 顶上移→V1 变高，V2-上 变矮；向下拖→V1 变窄，V2-上 变高
                    // V1 顶固定（= V2-上 底，位置不变）→ newV2t + newVH = startV2t + startVH
                    const delta = ev.clientY - startY;
                    let newVH = Math.max(25, Math.round(startVH - delta));
                    let newV2t = startV2t + (startVH - newVH);
                    if (newV2t < 25) {
                        newV2t = 25;
                        newVH = startVH + startV2t - 25; // 反推 V1，保证 V1 顶固定
                    }
                    this._tlVideoHeight = newVH;
                    this._tlV2TopHeight = newV2t;
                    this._applyTrackLayout();
                };
                const onUp = () => {
                    window.removeEventListener("mousemove", onMove);
                    window.removeEventListener("mouseup", onUp);
                    this._tlResizerTop.classList.remove("xzg-ve-resizing");
                    this._saveTlLayout();
                    this._syncAllClipThumbs();
                };
                window.addEventListener("mousemove", onMove);
                window.addEventListener("mouseup", onUp);
            });
        }
        // 中手柄：视频组(V2+V1) ↔ 音频组(A1+A2) 的分界
        //   向上拖→视频组整体压缩（V2/V1 按比例缩，各自极限 25px），音频组扩张
        //   向下拖→音频组整体压缩（A1/A2 按比例缩，各自极限 25px），视频组扩张
        //   组内某条先到 25px 后，其余压缩量全部给另一条（V2 和 V1 都能压到 25，A1 和 A2 同理）
        if (this._tlResizerMid) {
            this._tlResizerMid.addEventListener("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                this._tlHeightsCustomized = true;
                this._tlResizerMid.classList.add("xzg-ve-resizing");
                const startY = e.clientY;
                const startV2t = this._tlV2TopHeight;
                const startVH = this._tlVideoHeight;
                const startAH = this._tlAudioHeight;
                const startV2b = this._tlV2BotHeight;
                const startV = startV2t + startVH;        // 视频组总高
                const startA = startAH + startV2b;        // 音频组总高
                const total = startV + startA;            // 两组总高恒定（时间线区域高固定）
                const minT = 25;
                const minGroup = minT * 2;                // 每组极限 = 两条轨道各 25px
                const ratioV2t = startV > 0 ? startV2t / startV : 0.5;
                const ratioAH = startA > 0 ? startAH / startA : 0.5;
                const onMove = (ev) => {
                    const delta = ev.clientY - startY;
                    let newV = startV + delta;            // 向下拖→视频组变大
                    if (newV < minGroup) newV = minGroup; // 视频组极限（V2=V1=25）
                    if (newV > total - minGroup) newV = total - minGroup; // 音频组极限（A1=A2=25）
                    const newA = total - newV;
                    // 视频组内分配：按起始比例，先到 25px 的定住，余量给另一条
                    let v2t = Math.round(newV * ratioV2t);
                    if (v2t < minT) v2t = minT;
                    let vH = newV - v2t;
                    if (vH < minT) { vH = minT; v2t = newV - vH; }
                    // 音频组内分配：同上
                    let aH = Math.round(newA * ratioAH);
                    if (aH < minT) aH = minT;
                    let v2b = newA - aH;
                    if (v2b < minT) { v2b = minT; aH = newA - v2b; }
                    this._tlV2TopHeight = v2t;
                    this._tlVideoHeight = vH;
                    this._tlAudioHeight = aH;
                    this._tlV2BotHeight = v2b;
                    this._applyTrackLayout();
                };
                const onUp = () => {
                    window.removeEventListener("mousemove", onMove);
                    window.removeEventListener("mouseup", onUp);
                    this._tlResizerMid.classList.remove("xzg-ve-resizing");
                    this._saveTlLayout();
                    this._syncAllClipThumbs();
                };
                window.addEventListener("mousemove", onMove);
                window.addEventListener("mouseup", onUp);
            });
        }
        // 下手柄：调整音频高度（音频顶固定 = V1 底 + 5px，音频底移动，V2-下 联动）
        if (this._tlResizerBottom) {
            this._tlResizerBottom.addEventListener("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                this._tlHeightsCustomized = true;
                this._tlResizerBottom.classList.add("xzg-ve-resizing");
                const startY = e.clientY;
                const startAH = this._tlAudioHeight;
                const startV2b = this._tlV2BotHeight; // V2-下 联动基准
                const onMove = (ev) => {
                    // 向下拖→音频底下移→aH 增大，V2-下 减小；向上拖反之
                    // 音频顶固定 → v2b_new = startV2b - (newAH - startAH)
                    const delta = ev.clientY - startY;
                    let newAH = Math.max(25, Math.round(startAH + delta));
                    let newV2b = startV2b - (newAH - startAH);
                    if (newV2b < 25) {
                        newV2b = 25;
                        newAH = startAH + startV2b - 25; // 反推音频，保证音频顶固定
                    }
                    this._tlAudioHeight = newAH;
                    this._tlV2BotHeight = newV2b;
                    this._applyTrackLayout();
                };
                const onUp = () => {
                    window.removeEventListener("mousemove", onMove);
                    window.removeEventListener("mouseup", onUp);
                    this._tlResizerBottom.classList.remove("xzg-ve-resizing");
                    this._saveTlLayout();
                    this._syncAllClipThumbs();
                };
                window.addEventListener("mousemove", onMove);
                window.addEventListener("mouseup", onUp);
            });
        }
        // A2 最底手柄已移除：A2 高度由面板高度手柄（四轨等量）与恢复默认布局控制，不再单独拖动
        // 双击轨道头文字：最大化该轨道（其他3轨压缩到25px），再次双击恢复
        //   V1头 → V1最大化；V2头 → V2最大化；A1头 → A1最大化；A2头 → A2最大化
        const toggleSingle = (track) => () => {
            if (this._tlMaximizedTrack === track) {
                this._tlMaximizedTrack = null;
                this._tlHeightsCustomized = false;
            } else {
                this._tlMaximizedTrack = track;
                this._tlHeightsCustomized = true;
            }
            this._applyTrackLayout();
            // 轨道高度变化后同步缩略图尺寸（clip 通过 CSS height:100% 自动适配，仅缩略图需手动更新）
            this._syncAllClipThumbs();
            const names = { v1: "V1", v2: "V2", a1: "A1", a2: "A2" };
            this._setStatus(this._tlMaximizedTrack ? `${names[this._tlMaximizedTrack]}最大化（双击文字恢复）` : "显示全部轨道");
        };
        if (this._tlVideoHeader) this._tlVideoHeader.addEventListener("dblclick", toggleSingle("v1"));
        if (this._tlV2TopHeader) this._tlV2TopHeader.addEventListener("dblclick", toggleSingle("v2"));
        if (this._tlV2BotHeader) this._tlV2BotHeader.addEventListener("dblclick", toggleSingle("a2"));
        if (this._tlAudioHeader) this._tlAudioHeader.addEventListener("dblclick", toggleSingle("a1"));
        // 单击轨道头：该轨道名高亮（红色+加粗+加大字体），再单击同轨道取消激活，其他轨道名恢复默认
        const setActiveName = (track) => (e) => {
            e.stopPropagation();
            const next = this._activeTrackName === track ? null : track; // 再单击取消激活
            this._setActiveTrackName(next);
            const names = { v1: "V1", v2: "V2", a1: "A1", a2: "A2" };
            this._setStatus(next ? `${names[next]} 轨道已激活（再单击取消）` : `${names[track]} 已取消激活`);
        };
        if (this._tlVideoHeader) this._tlVideoHeader.addEventListener("click", setActiveName("v1"));
        if (this._tlV2TopHeader) this._tlV2TopHeader.addEventListener("click", setActiveName("v2"));
        if (this._tlV2BotHeader) this._tlV2BotHeader.addEventListener("click", setActiveName("a2"));
        if (this._tlAudioHeader) this._tlAudioHeader.addEventListener("click", setActiveName("a1"));
    }

    // 设置轨道名单击高亮（单选）：track 为 null 时全部恢复默认
    // track 变化时同步按当前播放头位置更新片段选中（激活轨道优先）
    _setActiveTrackName(track) {
        const prev = this._activeTrackName;
        this._activeTrackName = track || null;
        const headers = {
            v1: this._tlVideoHeader, v2: this._tlV2TopHeader,
            a1: this._tlAudioHeader, a2: this._tlV2BotHeader,
        };
        for (const key of Object.keys(headers)) {
            const header = headers[key];
            if (!header) continue;
            const nameEl = header.querySelector(".xzg-ve-track-name");
            if (!nameEl) continue;
            if (this._activeTrackName === key) nameEl.classList.add("xzg-ve-track-name-active");
            else nameEl.classList.remove("xzg-ve-track-name-active");
        }
        // 激活轨道变化 → 立即按播放头当前位置重算选中片段
        if (prev !== this._activeTrackName) this._syncSelectionToPlayhead();
    }

    // 按播放头当前位置同步片段选中（拖动播放头 / 激活轨道变化时调用）
    // 规则：
    //   1. 有激活轨道（_activeTrackName）→ 仅在该轨道上找播放头命中的片段并选中
    //   2. 无激活轨道 → 默认激活"最上面的片段"：V2 → V1 → A1 → A2（与轨道视觉从上到下一致）
    //   3. 命中片段与当前选中不同才更新（避免拖动播放头过程中重复渲染属性面板）
    //   4. 空隙处命不中任何片段 → 清空选中（保持播放头语义：选中=播放头正下方的片段）
    // 加载器限定模式（audio/video）下隐藏轨道不参与查找
    _syncSelectionToPlayhead() {
        if (!this._timeline || this.timeline.length === 0) return;
        // 多选守卫：Ctrl 多选 / Shift 范围选择的状态下，播放头移动不覆盖多选
        // （仅在无选中或单选时跟随播放头自动切换选中片段）
        if (this.selectedClipIds.size > 1) return;
        const gt = this._tlGlobalTime || 0;
        // 收集播放头命中的片段（含轨道归属）
        const hits = [];
        for (let i = 0; i < this.timeline.length; i++) {
            const clip = this.timeline[i];
            const dur = clip.end - clip.start;
            if (dur <= 0) continue;
            let track;
            if (clip.kind === "audio") {
                if (this._modeFilter === "video") continue;
                track = clip.track === "a2" ? "a2" : "a1";
            } else {
                if (this._modeFilter === "audio") continue;
                track = clip.track === "v2" ? "v2" : "v1";
            }
            const clipStart = this._getClipTlStart(clip);
            if (gt >= clipStart && gt < clipStart + dur) {
                hits.push({ clip, track });
            }
        }
        if (hits.length === 0) {
            // 空隙处：清空选中
            if (this.selectedClipIds.size > 0) {
                this.selectedClipIds.clear();
                this._updateClipSelection();
                this._renderProps();
            }
            return;
        }
        // 激活轨道优先；无激活轨道时最上层优先（轨道视觉从上到下：V2 → V1 → A1 → A2）
        const order = ["v2", "v1", "a1", "a2"];
        let target = null;
        if (this._activeTrackName) {
            target = hits.find(h => h.track === this._activeTrackName) || null;
        }
        if (!target) {
            for (const t of order) {
                const found = hits.find(h => h.track === t);
                if (found) { target = found; break; }
            }
        }
        if (!target) return;
        // 命中片段与当前选中相同则不重复更新
        if (this.selectedClipIds.size === 1 && this.selectedClipIds.has(target.clip.id)) return;
        this.selectedClipIds = new Set([target.clip.id]);
        this._clearGapSelection(); // 片段选中与空隙选中互斥
        this._updateClipSelection();
        this._renderProps();
    }

    // 切换时间线视图模式：both=视频+音频，video=仅视频，audio=仅音频
    // 隐藏轨道仍参与布局计算，切回时位置高度保持不变
    _setTlViewMode(mode) {
        if (this._tlViewMode === mode) return;
        this._tlViewMode = mode;
        this._tlHeightsCustomized = true; // 保持当前位置，不再自动居中
        this._clearGapSelection(); // 视图切换后选中轨道可能被隐藏，清空空隙选中避免不可见误删
        this._applyTrackLayout();
        this._setStatus(mode === "video" ? "仅显示视频轨道（双击文字恢复）"
            : mode === "audio" ? "仅显示音频轨道（双击文字恢复）"
            : "显示视频+音频轨道");
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
                filename: m.name, type: m.type, time: t, small: true,
            });
            console.log("[xzg-ve] thumb: extract_frame 返回, name=", m.name, "data=", data);
            if (data.error) throw new Error(data.error);
            // data.filename + data.subfolder 是 input 下的完整子路径（small=true 时 type=input）
            const url = `/view?filename=${encodeURIComponent(data.filename)}&type=${encodeURIComponent(data.type || "input")}&subfolder=${encodeURIComponent(data.subfolder || "")}&t=${Date.now()}`;
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
        // 删除前弹小珠光风格确认对话框
        const ok = await _xzgVeConfirm(
            "确定要一键清理缓存吗？\n\n将删除所有上传的媒体文件和缩略图缓存（不可恢复），\n媒体库和时间线将被清空。",
            "清理"
        );
        if (!ok) return;
        this._setStatus("正在清理缓存...");
        try {
            const resp = await _postJson("/xzg_video_editor_clear_cache", {});
            if (resp.error) throw new Error(resp.error);
            // 文件已被后端删除，清空前端媒体库
            this.mediaLibrary = [];
            this.selectedMediaNames.clear();
            this.offlineMediaNames.clear();
            _xzgVeSaveSessionMedia([]);
            // 时间线片段引用的文件已被删除，一并清空
            this._clearTimeline();

            // ═══════════════════════════════════════════════════════════
            //  关键：清理所有全局内存态缓存 / 失败黑名单 / LOADING 去重锁
            //  —— 否则同名视频重新导入时，会命中「老失败标记 / 已删文件URL」，
            //     出现「一键清理缓存后，再次导入视频，缩略图经常不生成」。
            // ═══════════════════════════════════════════════════════════
            for (const k of Object.keys(_XZG_VE_THUMB_CACHE))      delete _XZG_VE_THUMB_CACHE[k];
            for (const k of Object.keys(_XZG_VE_FULL_THUMB_STREAM)) delete _XZG_VE_FULL_THUMB_STREAM[k];
            for (const k of Object.keys(_XZG_VE_PROBE_CACHE))       delete _XZG_VE_PROBE_CACHE[k];
            _XZG_VE_THUMB_LOADING.clear();
            _XZG_VE_FULL_THUMB_STREAM_LOADING.clear();
            _XZG_VE_PROBE_LOADING.clear();
            // 单实例级缓存：音频波形 / 解码器 / 正在解码的去重锁 / 帧级 AudioBuffer
            try { this._audioBufferCache.clear(); } catch (_) {}
            try { this._audioDecodePending.clear(); } catch (_) {}
            try { this._audioBuffers = {}; } catch (_) {}
            try { if (typeof decoderPool !== "undefined" && decoderPool && typeof decoderPool.closeAll === "function") decoderPool.closeAll(); } catch (_) {}
            // 播放相关：防止清理后仍引用旧 clip / decoder
            this._currentDecoder = null;
            this._currentClip = null;
            this._stopPlaybackLoop();
            this._stopAudio();
            this._updatePlayBtn(false);
            this._tlPlaying = false;

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
                name: (s.name || s.filename).split("/").pop().split("\\").pop(),  // 色带显示文件名（不含路径）
                start: s.start || 0,
                end: s.end || 0,
                sourceDuration: s.sourceDuration || 0,
                durationPending: !!s.durationPending,
                borderColor: s.borderColor || "",
                tlStart: s.tlStart != null && s.tlStart >= 0 ? s.tlStart : null,
                audioTlStart: s.audioTlStart != null && s.audioTlStart >= 0 ? s.audioTlStart : null,
                skip_audio: s.skip_audio === true ? true : undefined,
                kind,
                track: s.track || (kind === "audio" ? "a1" : "v1"),
                pairedWith: s.pairedWith != null ? s.pairedWith : undefined,
                // 视频变换属性（恢复，带默认值兜底）
                scale: s.scale != null && s.scale > 0 ? s.scale : 1,
                offsetX: s.offsetX != null ? s.offsetX : 0,
                offsetY: s.offsetY != null ? s.offsetY : 0,
                cropLeft: s.cropLeft != null ? s.cropLeft : 0,
                cropRight: s.cropRight != null ? s.cropRight : 0,
                cropTop: s.cropTop != null ? s.cropTop : 0,
                cropBottom: s.cropBottom != null ? s.cropBottom : 0,
                opacity: s.opacity != null ? s.opacity : 1,
                volume: s.volume != null ? s.volume : 1,
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
        this._clearGapSelection();
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
        this._clearGapSelection();
        this._renderTimeline();
        this._saveTimelineSession();
        this._seekToGlobalTime(this._tlGlobalTime);
    }

    _addClipToTimeline(filename, type, tlStart = null, track = null) {
        const media = this.mediaLibrary.find(m => m.name === filename);
        const isImage = _isImage(filename) || media?.info?.is_image === true;
        const duration = media?.info?.duration || 0;
        // 图片：固定默认时长 5 秒（probe 返回 duration=0，前端用默认值填充）
        // 即使 probe 未完成或失败也允许添加，用占位时长 60s（probe 完成后会自动更新）
        const placeholderDur = isImage ? (media?.info?.default_duration || 5) :
                               (duration > 0 ? duration : 60);
        // kind: "audio" = 纯音频片段（无视频流），"video" = 含视频流片段（默认）
        // 图片视为视频片段（静止画面）
        // 音频加载器模式：所有拖入（包括视频、图片）强制视为纯音频片段，提取音频流
        const isAudioKind = (this._modeFilter === "audio") || media?.isAudio || (media?.info?.audio_only === true);
        const kind = isAudioKind ? "audio" : "video";
        const hasAudio = media?.info?.has_audio === true;
        // 轨道映射：video 只能在 v1/v2；audio 只能在 a1/a2
        //   未指定 track：视频默认 v1，音频默认 a1；
        //   用户拖到 V2 轨道 → 视频 track=v2；音频拖到 A2 → track=a2
        //   视频+音频配对规则：V1 视频 配 A1 音频；V2 视频 配 A2 音频（V1↔A1、V2↔A2 音视频匹配）
        let videoTrack, audioTrack;
        if (kind === "audio") {
            audioTrack = (track === "a2" || track === "v2") ? "a2" : "a1";
        } else {
            videoTrack = (track === "v2") ? "v2" : "v1";
            audioTrack = (videoTrack === "v2") ? "a2" : "a1";
        }
        this._pushHistory();
        // 按 kind 设置对应位置字段：视频用 tlStart，音频用 audioTlStart
        const isVideoClip = kind === "video";
        const clip = {
            id: ++this._clipIdCounter,
            filename,
            type,
            name: filename.split("/").pop().split("\\").pop(),  // 色带显示文件名（不含路径）
            start: 0,
            end: placeholderDur,
            sourceDuration: placeholderDur,
            durationPending: isImage ? false : (duration <= 0),  // 图片时长固定，无需等 probe
            borderColor: "",
            tlStart: isVideoClip ? tlStart : null,
            audioTlStart: isVideoClip ? null : tlStart,  // 纯音频片段位置存在 audioTlStart
            kind,  // 片段类型：video / audio（纯音频）
            track: isVideoClip ? videoTrack : audioTrack,
            // 视频变换属性（仅视频片段使用）
            scale: 1,     // 大小缩放比例（0.1~3）
            offsetX: 0,   // 移动：水平偏移（像素，正=右，负=左）
            offsetY: 0,   // 移动：垂直偏移（像素，正=下，负=上）
            cropLeft: 0,     // 裁剪左：从左边裁掉的比例（0~1）
            cropRight: 0,    // 裁剪右：从右边裁掉的比例（0~1）
            cropTop: 0,      // 裁剪上：从上面裁掉的比例（0~1）
            cropBottom: 0,   // 裁剪下：从下面裁掉的比例（0~1）
            opacity: 1,   // 透明度（0~1）
            volume: 1,    // 音量（0~2）
        };
        // 视频含音频流：同时创建独立的音频片段，在音频轨道独立存在、可单独拖动/裁剪
        // 音频加载器模式：跳过（主片段本身已是 audio，无需再拆分配对）
        let audioClip = null;
        if (kind === "video" && hasAudio && this._modeFilter !== "audio") {
            // 标记视频片段：音频已独立拆分（即使后来删除了音频片段，也不要再从视频本身提音频）
            clip.skip_audio = true;
            audioClip = {
                id: ++this._clipIdCounter,
                filename,
                type,
                name: filename.split("/").pop().split("\\").pop(),  // 色带显示文件名（不含路径）
                start: 0,
                end: placeholderDur,
                sourceDuration: placeholderDur,
                durationPending: isImage ? false : (duration <= 0),
                borderColor: "",
                tlStart: null,          // 视频片段专用字段，音频片段不使用
                audioTlStart: tlStart,  // 音频独立位置，初始与视频对齐
                kind: "audio",
                track: audioTrack,      // V1↔A1、V2↔A2 音视频匹配
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
        this._clearGapSelection(); // 新片段入轨选中，清空空隙选中（互斥）
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
        const v2Track = this._tlV2TopTrack;   // V2 上层视频轨道
        const a1Track = this._tlAudioTrack;   // A1 主音频轨道
        const a2Track = this._tlV2BotTrack;   // A2 下层音频轨道
        // 达芬奇式保留：先收集旧片段的缩略图 img，重建后再移入对应新片段，避免缩放时缩略图清空闪烁
        // 旧 img 在 _loadClipThumbs 中由新缩略图加载完成后逐步替换（淡入过渡）
        const oldThumbsByClipId = new Map();
        const collectOldThumbs = (t) => {
            if (!t) return;
            for (const oldEl of t.querySelectorAll(".xzg-ve-clip")) {
                const oldId = parseInt(oldEl.dataset.clipId);
                if (!oldId) continue;
                const oldWrap = oldEl.querySelector(".xzg-ve-clip-thumbs");
                if (oldWrap) {
                    const imgs = Array.from(oldWrap.querySelectorAll("img.xzg-ve-clip-thumb"));
                    if (imgs.length > 0) oldThumbsByClipId.set(oldId, imgs);
                }
            }
        };
        collectOldThumbs(track);
        collectOldThumbs(v2Track);
        if (track) track.innerHTML = "";
        if (v2Track) v2Track.innerHTML = "";
        if (a1Track) a1Track.innerHTML = "";
        if (a2Track) a2Track.innerHTML = "";
        // 持久化当前时间线（恢复时由 _restoreTimelineSession 接管，不会循环）
        this._saveTimelineSession();
        // 收集本次渲染的 clip 元素，稍后异步加载缩略图
        const pendingThumbs = [];
        const pendingWaveforms = [];
        if (this.timeline.length === 0) {
            if (track) _el("div", "xzg-ve-timeline-empty", "拖拽媒体库中的视频到此处", track);
            // V2 空提示：与 V1 一致
            if (v2Track) _el("div", "xzg-ve-timeline-empty", "拖拽媒体库中的视频到此处", v2Track);
            // A1 / A2 空提示：提示拖音频
            if (a1Track) _el("div", "xzg-ve-timeline-empty", "拖拽媒体库中的音频到此处", a1Track);
            if (a2Track) _el("div", "xzg-ve-timeline-empty", "拖拽媒体库中的音频到此处", a2Track);
            this._tlInfo.textContent = "";
            // 无片段时禁用分辨率控件
            this._disableRenderOpts();
            // 无片段时仍渲染刻度（始终充满画布）
            this._renderTicks();
            this._applyTlScroll();
            this._updatePlayhead();
            // 轨道容器已清空重建，重渲染空隙选中框（内部校验有效性）
            this._renderGapSelection();
            return;
        }
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

            // 片段 x：视频用 tsVideo，音频用 tsAudio（确保 maxRight 包含音频实际位置）
            const xVideo = (isVideoClip ? tsVideo : (tsAudio || 0)) * pxPerSec;
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
            //   clip.track === "a2" → 渲染到 A2（下音频轨道 _tlV2BotTrack）
            //   其他（默认 "a1"）→ 渲染到 A1（主音频轨道 _tlAudioTrack）
            if (clip.kind === "audio") {
                const dstAudioTrack = clip.track === "a2" ? a2Track : a1Track;
                if (dstAudioTrack && !this._tlInHandleDrag) {
                    const wfMediaExists = !this.offlineMediaNames.has(clip.filename);
                    const wfEl = _el("div", "xzg-ve-audio-clip", null, dstAudioTrack);
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
                    // 左右拖拽手柄（宽度随时间线缩放调整，缩小后避免判定范围过大）
                    const wHandleW = Math.max(8, Math.min(16, pxPerSec * 0.4));
                    const wLh = _el("div", "xzg-ve-clip-handle xzg-ve-clip-handle-left", null, wfEl);
                    const wRh = _el("div", "xzg-ve-clip-handle xzg-ve-clip-handle-right", null, wfEl);
                    wLh.style.width = `${wHandleW}px`;
                    wRh.style.width = `${wHandleW}px`;
                    // 拖动（与视频片段共用同一逻辑）
                    wfEl.addEventListener("mousedown", (e) => {
                        if (e.target === wLh || e.target === wRh) return;
                        if (e.button !== 0) return;
                        e.preventDefault();
                        e.stopPropagation();
                        if (e.altKey) {
                            this._startClipAltDrag(e, clip);
                        } else {
                            this._startClipDrag(e, clip, clipRects, "audio");
                        }
                    });
                    // 点击选中（与视频片段一致：Shift 范围 / Ctrl 增减 / 单选）
                    wfEl.addEventListener("click", (e) => {
                        if (e.target === wLh || e.target === wRh) return;
                        if (this._clipDragged) { this._clipDragged = false; return; }
                        this._handleClipClickSelection(clip, e);
                    });
                    // 右键菜单
                    wfEl.addEventListener("contextmenu", (e) => this._showCtxMenu(e, clip.id));
                    // 调整入出点
                    wLh.addEventListener("pointerdown", (e) => this._onHandleDown(e, clip, "left"));
                    wRh.addEventListener("pointerdown", (e) => this._onHandleDown(e, clip, "right"));
                }
            }

            // 纯音频片段：不在视频轨道渲染（仅音频轨道显示波形）
            if (clip.kind === "audio") continue;
            // 离线检测：磁盘上是否存在该片段引用的媒体文件
            const mediaExists = !this.offlineMediaNames.has(clip.filename);
            // 视频片段根据 clip.track 分发到 V1 / V2：
            //   track=v2 → 上层视频轨道 V2（_tlV2TopTrack）
            //   其他（默认 v1）→ 主视频轨道 V1（_tlTrack）
            const dstVideoTrack = clip.track === "v2" ? v2Track : track;
            if (!dstVideoTrack) continue;
            const el = _el("div", "xzg-ve-clip", null, dstVideoTrack);
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

            // 左右拖拽手柄（宽度随时间线缩放调整，缩小后避免判定范围过大）
            const handleW = Math.max(8, Math.min(16, pxPerSec * 0.4));
            const lh = _el("div", "xzg-ve-clip-handle xzg-ve-clip-handle-left", null, el);
            const rh = _el("div", "xzg-ve-clip-handle xzg-ve-clip-handle-right", null, el);
            lh.style.width = `${handleW}px`;
            rh.style.width = `${handleW}px`;

            // 自由拖动（mousedown 在片段主体，非手柄）
            el.addEventListener("mousedown", (e) => {
                if (e.target === lh || e.target === rh) return;
                if (e.button !== 0) return;
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
                // Shift 范围选择（同轨道锚点→当前，含两端）/ Ctrl 增减 / 单选
                this._handleClipClickSelection(clip, e);
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
        // 各轨道在各自轨道独立创建桥接手柄
        const EPS_SEC = 0.02; // 相邻容差（秒），避免浮点误差
        // 构建桥梁辅助：按轨道分组，在轨道容器创建相邻桥
        const buildBridges = (sorted, dstTrack, getLeft, getRight, getX) => {
            if (!dstTrack) return;
            for (let i = 0; i < sorted.length - 1; i++) {
                const a = sorted[i];
                const b = sorted[i + 1];
                const aRight = getRight(a);
                const bLeft = getLeft(b);
                if (Math.abs(aRight - bLeft) < EPS_SEC) {
                    const bridgeX = getX(a) + a.w;
                    const bridge = _el("div", "xzg-ve-clip-bridge", null, dstTrack);
                    // 宽度随时间线缩放调整，缩小后避免判定范围过大
                    const bridgeW = Math.max(6, Math.min(14, pxPerSec * 0.4));
                    bridge.style.width = `${bridgeW}px`;
                    bridge.style.left = `${bridgeX - bridgeW / 2}px`;
                    bridge.style.height = "100%";
                    bridge.addEventListener("pointerdown", (e) => this._onBridgeHandleDown(e, a.clip, b.clip));
                }
            }
        };
        // V1 视频桥接（track = clip.track !== "v2"）
        const v1Sorted = clipRects.filter(r => r.clip.kind !== "audio" && r.clip.track !== "v2")
            .sort((a, b) => a.tlStart - b.tlStart);
        buildBridges(v1Sorted, track,
            r => r.tlStart,
            r => r.tlStart + (r.clip.end - r.clip.start),
            r => r.x);
        // V2 视频桥接
        const v2Sorted = clipRects.filter(r => r.clip.kind !== "audio" && r.clip.track === "v2")
            .sort((a, b) => a.tlStart - b.tlStart);
        buildBridges(v2Sorted, v2Track,
            r => r.tlStart,
            r => r.tlStart + (r.clip.end - r.clip.start),
            r => r.x);
        // A1 音频桥接
        const a1Sorted = clipRects.filter(r => r.clip.kind === "audio" && r.clip.track !== "a2")
            .sort((a, b) => (a.audioTlStart || 0) - (b.audioTlStart || 0));
        buildBridges(a1Sorted, a1Track,
            r => (r.audioTlStart || 0),
            r => (r.audioTlStart || 0) + (r.clip.end - r.clip.start),
            r => (r.audioTlStart || 0) * pxPerSec);
        // A2 音频桥接
        const a2Sorted = clipRects.filter(r => r.clip.kind === "audio" && r.clip.track === "a2")
            .sort((a, b) => (a.audioTlStart || 0) - (b.audioTlStart || 0));
        buildBridges(a2Sorted, a2Track,
            r => (r.audioTlStart || 0),
            r => (r.audioTlStart || 0) + (r.clip.end - r.clip.start),
            r => (r.audioTlStart || 0) * pxPerSec);
        // 计算内容总宽度（最后一个片段右边缘 + 视口宽度尾部留白，确保播放头在末尾也能居中）
        const tailPad = this._getViewWidth();
        const maxRight = clipRects.length > 0
            ? Math.max(...clipRects.map(r => r.x + r.w)) + tailPad
            : tailPad;
        // 每条轨道都设置尾部占位，保证 4 条轨道可同步滚动到最右
        const addTailSpacer = (t) => {
            if (!t) return;
            t.style.width = "";
            const ts = _el("div", "xzg-ve-clip-tail-spacer", null, t);
            ts.style.cssText = `position: absolute; left: ${maxRight - tailPad}px; width: ${tailPad}px; height: 100%; pointer-events: none;`;
        };
        addTailSpacer(track);
        addTailSpacer(v2Track);
        addTailSpacer(a1Track);
        addTailSpacer(a2Track);
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
        // 轨道容器已清空重建，重渲染空隙选中框（内部校验有效性）
        this._renderGapSelection();
    }

    // 片段归属轨道（kind 决定唯一轨道：纯音频→A1/A2，视频→V1/V2）
    _clipTrackOf(clip) {
        if (clip.kind === "audio") return clip.track === "a2" ? "a2" : "a1";
        return clip.track === "v2" ? "v2" : "v1";
    }
    // 片段在轨道上的起始位置（音频用 audioTlStart，视频用 tlStart）
    _clipStartOf(clip) {
        const v = clip.kind === "audio" ? clip.audioTlStart : clip.tlStart;
        return v ?? 0;
    }
    // 片段点击选中统一处理（视频片段 el 与音频片段 wfEl 共用）：
    //   Shift+点击 → 范围选择：同轨道锚点到当前片段之间（时间序，含两端）全部片段
    //                不同轨道或锚点已删 → 退化为单选并重置锚点
    //   Ctrl/Meta+点击 → 增减选择（并更新锚点）
    //   普通点击 → 单选（重置锚点）
    _handleClipClickSelection(clip, e) {
        // 选中片段时清空空隙选中（两者互斥）
        this._clearGapSelection();
        if (e.shiftKey && this._clipSelAnchor) {
            const anchorClip = this.timeline.find(c => c.id === this._clipSelAnchor);
            if (anchorClip && this._clipTrackOf(anchorClip) === this._clipTrackOf(clip)) {
                // 同轨道范围选择：按轨道位置收集 [min, max] 区间内（含两端）的所有片段
                const track = this._clipTrackOf(clip);
                const lo = Math.min(this._clipStartOf(anchorClip), this._clipStartOf(clip));
                const hi = Math.max(this._clipStartOf(anchorClip), this._clipStartOf(clip));
                const ids = new Set();
                for (const c of this.timeline) {
                    if (this._clipTrackOf(c) !== track) continue;
                    const s = this._clipStartOf(c);
                    if (s >= lo - 1e-6 && s <= hi + 1e-6) ids.add(c.id);
                }
                this.selectedClipIds = ids;
            } else {
                // 不同轨道或锚点已删：退化为单选并重置锚点
                this.selectedClipIds = new Set([clip.id]);
                this._clipSelAnchor = clip.id;
            }
        } else if (e.ctrlKey || e.metaKey) {
            if (this.selectedClipIds.has(clip.id)) {
                this.selectedClipIds.delete(clip.id);
            } else {
                this.selectedClipIds.add(clip.id);
            }
            this._clipSelAnchor = clip.id; // Ctrl 点选也更新锚点（Shift 以最后操作项为基准）
        } else {
            this.selectedClipIds = new Set([clip.id]);
            this._clipSelAnchor = clip.id; // 单选重置锚点
        }
        // 片段选中与媒体选中互斥
        if (this.selectedMediaNames.size > 0) {
            this.selectedMediaNames.clear();
            this._renderMediaList();
        }
        // 仅更新选中态 class，不重建 DOM，避免缩略图重新加载导致闪烁
        this._updateClipSelection();
        this._renderProps();
    }

    // 片段自由拖动 + 磁吸 + 帧对齐（基于时间轴秒数，非像素）
    // 音视频完全独立：拖动视频只改 tlStart，拖动音频只改 audioTlStart
    // 拖动位置始终对齐到帧边界，确保导出时帧精确
    // 在 4 条轨道（V1/V2/A1/A2）上查找指定 clip 的 DOM 元素，找不到返回 null
    _findClipEl(clip) {
        if (!clip) return null;
        const isAudio = clip.kind === "audio";
        const cls = isAudio ? ".xzg-ve-audio-clip" : ".xzg-ve-clip";
        const sel = `${cls}[data-clip-id="${clip.id}"]`;
        const tracks = isAudio
            ? [this._tlAudioTrack, this._tlV2BotTrack]    // A1 / A2
            : [this._tlTrack, this._tlV2TopTrack];        // V1 / V2
        for (const t of tracks) {
            if (!t) continue;
            const el = t.querySelector(sel);
            if (el) return el;
        }
        return null;
    }
    _startClipDrag(e, clip, clipRects, source = "video") {
        const startX = e.clientX;
        const startY = e.clientY;
        const pxPerSec = this._getPxPerSec();
        const myRect = clipRects.find(r => r.clip === clip);
        // 拖动位置字段：视频用 tlStart，音频用 audioTlStart（完全独立）
        const origField = source === "audio" ? "audioTlStart" : "tlStart";
        const origTlStart = myRect ? (myRect[origField] != null ? myRect[origField] : (clip[origField] || 0)) : (clip[origField] || 0);
        const origTrack = clip.track || (clip.kind === "audio" ? "a1" : "v1");
        let moved = false;
        this._clipDragged = false;
        const SNAP_SEC = 15 / pxPerSec; // 磁吸阈值（15px，秒）
        let dragEl = null;
        let lastClientY = startY;   // 记录最后一次 pointermove 的 clientY（用于 pointerup 判断最终落轨道）
        let finalTlStart = origTlStart;  // 拖动结束后的最终位置（move 中不断更新，up 中应用）
        let singlePreviewEl = null;       // 单片段拖动预览框
        let singlePrevPreviewTrack = null;

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
        // 多选拖动整体下限：组内最左片段碰到 0 时整组刹停，而不是让每个片段各自裁到 0（否则会互相挤压）。
        //   delta = newTlStart - origTlStart，要求所有组员 g.origPos + delta >= 0 ⇒ delta >= -minGroupPos
        //   即 newTlStart >= origTlStart - minGroupPos。单片段拖动时 minGroupPos = origTlStart ⇒ 下限 = 0（保持原行为）。
        const minGroupPos = isMultiDrag ? Math.min(...group.map(g => g.origPos)) : origTlStart;
        const tlMinBound = origTlStart - minGroupPos;  // ≥ 0

        const move = (ev) => {
            lastClientY = ev.clientY;
            const dx = ev.clientX - startX;
            const dy = ev.clientY - startY;
            const shiftHeld = ev.shiftKey;
            let newTlStart = origTlStart;  // 默认保持原位（Shift模式锁定）
            // Shift+拖动：仅上下切换轨道，锁定X位置
            if (shiftHeld) {
                if (!moved && Math.abs(dy) < 3) return;
                if (!moved) {
                    this._pushHistory();
                    this._clearGapSelection(); // 拖动选中片段，清空空隙选中（互斥）
                    if (!isMultiDrag && !this.selectedClipIds.has(clip.id)) {
                        this.selectedClipIds = new Set([clip.id]);
                        this._updateClipSelection();
                        this._renderProps();
                    }
                    // 拖动开始时隐藏本体片段，仅显示预览虚线
                    if (!dragEl) dragEl = this._findClipEl(clip);
                    if (dragEl) dragEl.style.display = "none";
                    if (isMultiDrag) {
                        for (const g of group) {
                            if (g.c === clip) continue;
                            g.el = this._findClipEl(g.c);
                            if (g.el) g.el.style.display = "none";
                        }
                    }
                }
                moved = true;
                this._clipDragged = true;
            } else {
            if (!moved && Math.abs(dx) < 3) return;
            if (!moved) {
                this._pushHistory();
                // 拖动开始时自动选中该片段（多选模式下已在集合中，无需重置）
                this._clearGapSelection(); // 拖动选中片段，清空空隙选中（互斥）
                if (!isMultiDrag && !this.selectedClipIds.has(clip.id)) {
                    this.selectedClipIds = new Set([clip.id]);
                    this._updateClipSelection();
                    this._renderProps();
                }
                // 拖动开始时隐藏本体片段，仅显示预览虚线
                if (!dragEl) dragEl = this._findClipEl(clip);
                if (dragEl) dragEl.style.display = "none";
                if (isMultiDrag) {
                    for (const g of group) {
                        if (g.c === clip) continue;
                        g.el = this._findClipEl(g.c);
                        if (g.el) g.el.style.display = "none";
                    }
                }
            }
            moved = true;
            this._clipDragged = true;
            // 按住 Alt：拖动速度降为原来的 20%（移动更精细）
            newTlStart = origTlStart + (ev.altKey ? dx * 0.2 : dx) / pxPerSec;
            newTlStart = Math.max(tlMinBound, newTlStart);

            // 磁吸（仅在磁吸开启时生效）：片段左右边缘与时间轴起点(0)及其他片段边缘对齐
            if (this._magnetEnabled) {
                const myDur = clip.end - clip.start;
                const myLeft = newTlStart;
                const myRight = newTlStart + myDur;
                let snapped = false;
                // 吸附到时间轴起点（0）
                if (!snapped && Math.abs(myLeft) < SNAP_SEC) { newTlStart = 0; snapped = true; }
                if (!snapped && Math.abs(myRight) < SNAP_SEC) { newTlStart = -myDur; snapped = true; }
                // 吸附到播放头位置
                if (!snapped) {
                    const playheadT = this._tlGlobalTime != null ? this._tlGlobalTime : 0;
                    if (Math.abs(myLeft - playheadT) < SNAP_SEC) { newTlStart = playheadT; snapped = true; }
                    else if (Math.abs(myRight - playheadT) < SNAP_SEC) { newTlStart = playheadT - myDur; snapped = true; }
                }
                // 吸附到其他片段边缘
                if (!snapped) {
                    for (const r of clipRects) {
                        if (r.clip === clip) continue;
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
            }
            newTlStart = Math.max(tlMinBound, newTlStart);
            newTlStart = snapToFrame(newTlStart);
            } // end else (normal drag)
            // 拖动期间：本体片段已隐藏，在目标轨道显示金色虚线预览框
            const trackMap = { v1: this._tlTrack, v2: this._tlV2TopTrack, a1: this._tlAudioTrack, a2: this._tlV2BotTrack };
            finalTlStart = newTlStart;  // 记录最终位置，供 up 中应用
            const curTrack = this._yToTrack(ev.clientY, clip.kind);
            // 多选拖动：为每个选中片段创建/更新预览框
            if (isMultiDrag) {
                const delta = newTlStart - origTlStart;
                // 轨道偏移：主片段轨道变化量，同类型片段跟随偏移
                const trackIdxV = { v2: 0, v1: 1 };
                const trackNamesV = ["v2", "v1"];
                const trackIdxA = { a1: 0, a2: 1 };
                const trackNamesA = ["a1", "a2"];
                const mainOrigTrackIdx = (clip.kind === "audio" ? trackIdxA : trackIdxV)[origTrack] ?? 0;
                const mainCurTrackIdx = (clip.kind === "audio" ? trackIdxA : trackIdxV)[curTrack] ?? 0;
                const trackDelta = mainCurTrackIdx - mainOrigTrackIdx;
                for (const g of group) {
                    const gOrigTrack = g.c.track || (g.c.kind === "audio" ? "a1" : "v1");
                    let gCurTrack;
                    if (g.c.kind === clip.kind) {
                        // 同类型：跟随主片段轨道偏移
                        const idxMap = g.c.kind === "audio" ? trackIdxA : trackIdxV;
                        const names = g.c.kind === "audio" ? trackNamesA : trackNamesV;
                        const gIdx = idxMap[gOrigTrack] ?? 0;
                        gCurTrack = names[Math.max(0, Math.min(names.length - 1, gIdx + trackDelta))] || gOrigTrack;
                    } else {
                        // 不同类型：保持原轨道
                        gCurTrack = gOrigTrack;
                    }
                    if (gCurTrack !== g.prevPreviewTrack || !g.previewEl) {
                        if (g.previewEl) { g.previewEl.remove(); g.previewEl = null; }
                        const tgt = trackMap[gCurTrack];
                        if (tgt) {
                            g.previewEl = document.createElement("div");
                            g.previewEl.className = "xzg-ve-clip-preview";
                            tgt.appendChild(g.previewEl);
                        }
                        g.prevPreviewTrack = gCurTrack;
                    }
                    if (g.previewEl) {
                        let gPos = g.origPos + delta;
                        if (shiftHeld) gPos = g.origPos; // Shift锁定X位置
                        const gDur = g.c.end - g.c.start;
                        g.previewEl.style.left = `${Math.max(0, gPos) * pxPerSec}px`;
                        g.previewEl.style.width = `${Math.max(30, gDur * pxPerSec)}px`;
                    }
                }
            } else {
                // 单片段拖动：单个预览框
                if (curTrack !== singlePrevPreviewTrack || !singlePreviewEl) {
                    if (singlePreviewEl) { singlePreviewEl.remove(); singlePreviewEl = null; }
                    const tgt = trackMap[curTrack];
                    if (tgt) {
                        singlePreviewEl = document.createElement("div");
                        singlePreviewEl.className = "xzg-ve-clip-preview";
                        tgt.appendChild(singlePreviewEl);
                    }
                    singlePrevPreviewTrack = curTrack;
                }
                if (singlePreviewEl) {
                    const dur = clip.end - clip.start;
                    singlePreviewEl.style.left = `${newTlStart * pxPerSec}px`;
                    singlePreviewEl.style.width = `${Math.max(30, dur * pxPerSec)}px`;
                }
            }
        };
        const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            if (moved) {
                // 移除所有预览框
                if (singlePreviewEl) { singlePreviewEl.remove(); singlePreviewEl = null; }
                if (isMultiDrag) {
                    for (const g of group) {
                        if (g.previewEl) { g.previewEl.remove(); g.previewEl = null; }
                    }
                }
                // 恢复本体片段显示
                if (dragEl) dragEl.style.display = "";
                if (isMultiDrag) {
                    for (const g of group) {
                        if (g.el && g.c !== clip) g.el.style.display = "";
                    }
                }
                // 应用最终位置到数据
                clip[origField] = finalTlStart;
                // 多选拖动：其他选中片段应用相同位移
                if (isMultiDrag) {
                    const delta = finalTlStart - origTlStart;
                    for (const g of group) {
                        if (g.c === clip) continue;
                        let np = g.origPos + delta;
                        np = Math.max(0, np);
                        const gFps = this._getClipFps(g.c) || 30;
                        if (gFps > 0) np = Math.round(np * gFps) / gFps;
                        g.c[g.field] = np;
                    }
                }
                // ═══ 跨轨道切换：根据最终鼠标 Y 更新 clip.track（组内切换）═══
                //   视频：只能在视频组内 V1↔V2 切换
                //   音频：只能在音频组内 A1↔A2 切换
                //   多选拖动：所有选中片段跟随主片段落位轨道切换（如果类型允许）
                const dstTrack = this._yToTrack(lastClientY, clip.kind);
                if (dstTrack !== origTrack) {
                    // 主片段：改 track（类型已由 _yToTrack 强制合法）
                    clip.track = dstTrack;
                    // 音视频配对规则：V1↔A1、V2↔A2。
                    //   如果主 clip 是视频且有 pairedWith 音频片段，联动把配对音频也切到与视频匹配的轨道
                    if (clip.kind !== "audio" && clip.pairedWith != null) {
                        const paired = this.timeline.find(c => c.id === clip.pairedWith);
                        if (paired && paired.kind === "audio") {
                            paired.track = dstTrack === "v2" ? "a2" : "a1";
                        }
                    }
                    //   如果主 clip 是音频且有 pairedWith 视频片段，联动把配对视频切到与音频匹配的轨道
                    if (clip.kind === "audio" && clip.pairedWith != null) {
                        const paired = this.timeline.find(c => c.id === clip.pairedWith);
                        if (paired && paired.kind !== "audio") {
                            paired.track = dstTrack === "a2" ? "v2" : "v1";
                        }
                    }
                    // 多选：所有其他选中片段跟随切换（按各自 kind 合法落位，使用轨道偏移而非同一 Y 坐标）
                    if (isMultiDrag) {
                        const trackIdxV = { v2: 0, v1: 1 };
                        const trackNamesV = ["v2", "v1"];
                        const trackIdxA = { a1: 0, a2: 1 };
                        const trackNamesA = ["a1", "a2"];
                        const mainTrackDelta = (clip.kind === "audio"
                            ? (trackIdxA[dstTrack] ?? 0) - (trackIdxA[origTrack] ?? 0)
                            : (trackIdxV[dstTrack] ?? 1) - (trackIdxV[origTrack] ?? 1));
                        for (const g of group) {
                            if (g.c === clip) continue;
                            const gOrigTrack = g.c.track || (g.c.kind === "audio" ? "a1" : "v1");
                            let gDst = gOrigTrack;
                            if (g.c.kind === clip.kind) {
                                const idxMap = g.c.kind === "audio" ? trackIdxA : trackIdxV;
                                const names = g.c.kind === "audio" ? trackNamesA : trackNamesV;
                                const gIdx = idxMap[gOrigTrack] ?? 0;
                                gDst = names[Math.max(0, Math.min(names.length - 1, gIdx + mainTrackDelta))] || gOrigTrack;
                            }
                            g.c.track = gDst;
                            // 联动配对（V1↔A1、V2↔A2）
                            if (g.c.kind !== "audio" && g.c.pairedWith != null) {
                                const gp = this.timeline.find(c => c.id === g.c.pairedWith);
                                if (gp && gp.kind === "audio") {
                                    gp.track = gDst === "v2" ? "a2" : "a1";
                                }
                            }
                            if (g.c.kind === "audio" && g.c.pairedWith != null) {
                                const gp = this.timeline.find(c => c.id === g.c.pairedWith);
                                if (gp && gp.kind !== "audio") {
                                    gp.track = gDst === "a2" ? "v2" : "v1";
                                }
                            }
                        }
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
            // 根据源片段类型决定预览框所在轨道；Alt+拖动支持跨轨道复制（鼠标Y落到哪条轨道）
            this._showDragPreview(ev.clientX, srcDur, "center", srcClip.kind || "video", ev.clientY);
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
                // Alt+拖动跨轨道复制：根据鼠标Y落到哪条轨道决定新 clip.track
                //   视频只能在 v1/v2；音频只能在 a1/a2
                const dstTrack = this._yToTrack(ev.clientY, kind);
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
                    track: dstTrack,
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
            // 轨道独立：不同轨道互不裁剪（V1 与 V2 允许重叠交叉，上层覆盖；A1 与 A2 同理）
            const _tk = (cl) => cl.track || (cl.kind === "audio" ? "a1" : "v1");
            if (_tk(c) !== _tk(draggedClip)) continue;
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
            // 轨道独立：不同轨道互不切割（V1 与 V2 允许重叠交叉；A1 与 A2 同理）
            const _tk = (cl) => cl.track || (cl.kind === "audio" ? "a1" : "v1");
            if (_tk(c) !== _tk(newClip)) continue;
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
                    track: c.track || (rightKind === "audio" ? "a1" : "v1"),
                };
                this.timeline.push(rightPart);
            }
        }
    }

    // 同步所有视频片段的缩略图（轨道高度变化时调用，按新高度重新计算缩略图数量和宽度）
    _syncAllClipThumbs() {
        if (!this._tlTrack) return;
        // V1 + V2 两条视频轨道统一遍历
        const videoTracks = [this._tlTrack, this._tlV2TopTrack].filter(Boolean);
        for (const t of videoTracks) {
            t.querySelectorAll(".xzg-ve-clip").forEach((clipEl) => {
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
                    const url = await this._decodeSource(clip.filename, clip.type);
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
        // 绘制波形到 canvas（应用音量增益）
        canvas._xzgGain = clip.volume != null ? clip.volume : 1;
        this._drawWaveform(canvas, peaks, undefined, canvas._xzgGain);
        // 缓存 peaks 到 canvas 元素，便于轨道高度变化时重绘（无需重新解码）
        canvas._xzgPeaks = peaks;
    }

    // 同步从 AudioBuffer 提取指定时间范围的峰值数据（max abs 下采样到指定宽度）
    // 用于波形渲染：拖动裁剪时按新的 start/end 实时提取，避免旧 peaks 被压缩显示
    // —— 针对 Alt+滚轮极大放大（每像素对应 <1 个采样）专门处理：
    //    老逻辑用 Math.floor 算 s0/s1，会出现 s0==s1，内循环不执行，peak=0 残留，
    //    最终整片波形 barH=0 → 视觉上变成"一片白"。
    //    修复：① samplesPerPeak>=1 时改为 ceil 边界，保证区间至少覆盖 1 个样本；
    //          ② samplesPerPeak<1 时反向填充：按样本遍历，把 peak 铺到该样本对应的像素范围。
    _extractPeaks(audioBuf, clipStart, clipEnd, width) {
        if (!audioBuf || width <= 0) return null;
        const sr = audioBuf.sampleRate;
        const startSample = Math.floor(clipStart * sr);
        const endSample = Math.min(audioBuf.length, Math.max(startSample + 1, Math.floor(clipEnd * sr)));
        const totalSamples = endSample - startSample;
        if (totalSamples <= 0) return null;
        const numCh = audioBuf.numberOfChannels;
        const data = audioBuf.getChannelData(0); // 多声道：取第 0 声道与旧代码保持一致
        const peaks = new Float32Array(width);
        const samplesPerPeak = totalSamples / width;

        if (samplesPerPeak >= 1) {
            // —— 正常/缩小：每个像素对应 ≥1 个样本，取区间 max(abs)
            for (let i = 0; i < width; i++) {
                // 用 ceil 向上取整右端点，避免 Math.floor 导致的零长度区间；
                // 并强制 s1 = max(s0+1, s1)，确保每个像素至少扫描 1 个样本
                const s0 = startSample + Math.floor(i * samplesPerPeak);
                const s1 = Math.min(endSample, Math.max(s0 + 1, startSample + Math.ceil((i + 1) * samplesPerPeak)));
                let peak = 0;
                for (let s = s0; s < s1; s++) {
                    const v = Math.abs(data[s]);
                    if (v > peak) peak = v;
                }
                peaks[i] = peak;
            }
        } else {
            // —— 极大放大：1 个样本跨多个像素。反向遍历样本，每个样本的 peak 同步写到
            //    它所覆盖的所有像素列，保证像素列不会出现 peak=0 导致的「空白条带」
            const pxPerSample = width / totalSamples; // > 1
            for (let s = 0; s < totalSamples; s++) {
                const peak = Math.abs(data[startSample + s]);
                if (peak <= 0) continue;
                const xStart = Math.floor(s * pxPerSample);
                const xEnd = Math.min(width, Math.ceil((s + 1) * pxPerSample));
                for (let x = xStart; x < xEnd; x++) {
                    if (peaks[x] < peak) peaks[x] = peak;
                }
            }
            // 补齐可能未覆盖的首/尾列（浮点误差导致极少数列仍 0）：用最近邻复制
            for (let i = 1; i < width; i++) {
                if (peaks[i] === 0) peaks[i] = peaks[i - 1];
            }
            for (let i = width - 2; i >= 0; i--) {
                if (peaks[i] === 0) peaks[i] = peaks[i + 1];
            }
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
            canvas._xzgGain = clip.volume != null ? clip.volume : 1;
            this._drawWaveform(canvas, peaks, w, canvas._xzgGain);
            canvas._xzgPeaks = peaks;
        }
    }

    // 音量调节时实时预览：用缓存的峰值重绘波形，幅度随音量变化
    _refreshWaveformVolume(clip) {
        if (clip.kind !== "audio") return;
        const audioTracks = [this._tlAudioTrack, this._tlV2BotTrack].filter(Boolean);
        for (const t of audioTracks) {
            const wfEl = t.querySelector(`.xzg-ve-audio-clip[data-clip-id="${clip.id}"]`);
            if (!wfEl) continue;
            const canvas = wfEl.querySelector("canvas.xzg-ve-waveform");
            if (!canvas || !canvas._xzgPeaks) continue;
            canvas._xzgGain = clip.volume != null ? clip.volume : 1;
            const w = canvas.clientWidth || parseInt(wfEl.style.width) || wfEl.clientWidth || 0;
            this._drawWaveform(canvas, canvas._xzgPeaks, w > 0 ? w : undefined, canvas._xzgGain);
        }
    }

    // 重绘音频轨道所有可见波形（轨道高度变化时调用，波形自适应新高度）
    _redrawAllWaveforms() {
        if (!this._tlAudioTrack) return;
        const MAX_CANVAS_W = 16000;   // 与 _drawWaveform 一致，避免极端放大时 canvas 超限全白
        const dpr = window.devicePixelRatio || 1;
        // A1 + A2 两条音频轨道统一遍历
        const audioTracks = [this._tlAudioTrack, this._tlV2BotTrack].filter(Boolean);
        for (const t of audioTracks) {
        const isCompact = t.classList.contains("xzg-ve-audio-compact");
        for (const clipEl of t.querySelectorAll(".xzg-ve-audio-clip")) {
            const canvas = clipEl.querySelector("canvas.xzg-ve-waveform");
            if (!canvas || !canvas._xzgPeaks) continue;
            // 用音频片段实际高度计算波形高度（紧凑模式占满，否则扣除底部25px色带）
            const clipH = clipEl.clientHeight || 0;
            const wfH = Math.max(0, isCompact ? clipH : clipH - 25);
            let wfW = parseInt(clipEl.style.width) || clipEl.clientWidth || 0;
            if (wfH <= 0 || wfW <= 0) continue;
            // 逻辑宽上限：防止 Alt+滚轮极端放大时 canvas.width * dpr 超限
            let drawW = wfW;
            if (drawW > MAX_CANVAS_W) drawW = MAX_CANVAS_W;
            // 设置 canvas 位图尺寸（CSS 尺寸 + dpr 缩放）
            canvas.width = drawW * dpr;
            canvas.height = wfH * dpr;
            canvas.style.width = wfW + "px";
            canvas.style.height = wfH + "px";
            const ctx = canvas.getContext("2d");
            if (!ctx) continue;
            ctx.setTransform(1, 0, 0, 1, 0, 0); // 重置变换矩阵
            ctx.scale(dpr, dpr);
            ctx.clearRect(0, 0, drawW, wfH);
            const midY = wfH / 2;
            const maxH = wfH / 2 - 1;
            ctx.fillStyle = "#fff";
            const peaks = canvas._xzgPeaks;
            const len = peaks.length;
            // 音量增益兜底：null/undefined → 默认 1（避免 clip 未设 volume 时被画成 0 波形）
            let g = 1;
            const vGain = canvas._xzgGain;
            if (vGain == null) g = 1;
            else if (vGain <= 0) g = 0;
            else g = Math.min(vGain, 3);
            // 像素→peaks 最近邻：保证无论 drawW 是否裁剪 MAX_CANVAS_W / peaks 长度是否匹配，
            // 都不会因浮点折叠出现全 0 条带（「一片白」）
            for (let x = 0; x < drawW; x++) {
                const idx = Math.min(len - 1, Math.floor((x / drawW) * len));
                const peak = peaks[idx];
                if (peak <= 0) continue;
                const barH = Math.min(maxH, peak * g * maxH);
                if (barH <= 0) continue;
                ctx.fillRect(x, midY - barH, 1, barH * 2);
            }
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
    _drawWaveform(canvas, peaks, overrideW, gain) {
        if (!canvas || !canvas.isConnected) return;
        // 读取 canvas 自身尺寸（正常模式扣除25px色带；紧凑模式占满整个片段高度）
        let w = overrideW != null ? overrideW : (canvas.clientWidth || canvas.parentElement?.clientWidth || 0);
        const h = canvas.clientHeight || canvas.parentElement?.clientHeight || 0;
        if (w <= 0 || h <= 0) return;
        const dpr = window.devicePixelRatio || 1;
        // Alt+滚轮放大到极限时，clipWidth 可能达到 3~6 万像素；dpr 倍增后超过浏览器 canvas
        // 一维上限（通常 2^15=32767），导致 width 赋值被忽略或 getContext 静默空，画布全白。
        // 解决：对 CSS 逻辑宽做一次「安全上限裁剪」（超过上限则缩放到上限，并在绘制时
        // 保持 peaks→px 的正确映射比，视觉无损）。
        const MAX_CANVAS_W = 16000;   // 逻辑宽上限（×常见 dpr=2 → 32k 位图宽，非常安全）
        let drawW = w;
        let scale = 1;
        if (drawW > MAX_CANVAS_W) {
            scale = MAX_CANVAS_W / drawW;
            drawW = MAX_CANVAS_W;
        }
        canvas.width = drawW * dpr;
        canvas.height = h * dpr;
        canvas.style.width = w + "px";
        canvas.style.height = h + "px";
        const ctx = canvas.getContext("2d");
        if (!ctx) return;  // 防御：极端 DPR/宽 导致创建失败，避免异常
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, drawW, h);
        // 中线
        const midY = h / 2;
        const maxH = h / 2 - 1; // 上下各留 1px
        // 音量增益：null/undefined 视为默认 1（未设置过 clip.volume 时安全兜底）；
        // 负数/零 → 0 不再绘制（静音=无波形，与背景一致是正确语义，不是 bug）
        let g = 1;
        if (gain == null) g = 1;
        else if (gain <= 0) g = 0;
        else g = Math.min(gain, 3);
        // 波形颜色：白色
        ctx.fillStyle = "#fff";
        const len = peaks.length;
        // peaks 长度与 drawW 不一致时（如 MAX_CANVAS_W 裁剪、或 _redrawAllWaveforms 复用时）
        // 以「像素→最近邻 peaks 下标」映射，保证峰值不被错误折叠成全 0 条带
        for (let x = 0; x < drawW; x++) {
            const idx = Math.min(len - 1, Math.floor((x / drawW) * len));
            const peak = peaks[idx];
            if (peak <= 0) continue;
            const barH = Math.min(maxH, peak * g * maxH);
            if (barH <= 0) continue;
            ctx.fillRect(x, midY - barH, 1, barH * 2);
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
        // 渲染旗标
        this._renderMarkerFlags();
    }

    _addMarkerFlag() {
        const time = this._tlGlobalTime || 0;
        // 避免重复：同一秒内不重复添加（容差 0.1 秒）
        const exists = this._markerFlags.some(f => Math.abs(f.time - time) < 0.1);
        if (exists) return;
        this._markerFlags.push({ time });
        this._markerFlags.sort((a, b) => a.time - b.time);
        this._renderMarkerFlags();
    }

    _renderMarkerFlags() {
        const ticks = this._tlTicks;
        if (!ticks) return;
        // 移除旧旗标 DOM
        ticks.querySelectorAll(".xzg-ve-marker-flag").forEach(el => el.remove());
        const pxPerSec = this._getPxPerSec();
        const scrollLeft = this._tlScrollLeft || 0;
        for (const f of this._markerFlags) {
            const x = f.time * pxPerSec - scrollLeft;
            const flag = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            flag.setAttribute("viewBox", "0 0 24 24");
            flag.setAttribute("fill", "none");
            flag.setAttribute("stroke", "#4a9eff");
            flag.setAttribute("stroke-width", "2");
            flag.setAttribute("stroke-linecap", "round");
            flag.setAttribute("stroke-linejoin", "round");
            flag.classList.add("xzg-ve-marker-flag");
            flag.style.left = (x - 6) + "px";
            flag.innerHTML = '<line x1="4" y1="2" x2="4" y2="22"/><path d="M4,4 L18,4 L14,10 L18,16 L4,16"/>';
            flag.title = `旗标 ${_fmtTime(f.time)}（右键删除）`;
            flag.addEventListener("contextmenu", (e) => {
                e.preventDefault();
                e.stopPropagation();
                this._markerFlags = this._markerFlags.filter(m => m !== f);
                this._renderMarkerFlags();
            });
            ticks.appendChild(flag);
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
        this._clearGapSelection();
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
        // 仅保留 Alt+滚轮缩放时间线，取消普通滚轮横向滚动
        if (!e.altKey) return;
        e.preventDefault();
        const rect = this._timeline.getBoundingClientRect();
        // 内容区起点 = timeline左 + 左侧占位（刻度0与左侧分界线对齐）
        const contentLeft = rect.left + this._tlLeftPad;
        // 鼠标在内容中的位置（含滚动偏移）
        const mouseX = e.clientX - contentLeft + this._tlScrollLeft;

        // 以播放头为中心缩放：缩放后播放头尽量位于视口中央
        const oldPxPerSec = this._getPxPerSec();
        const viewWidth = this._getViewWidth();

        // 向上滚（deltaY<0）放大，向下滚（deltaY>0）缩小
        const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
        let newZoom = this._tlZoom * factor;
        // 允许缩小到 0.1（右侧留白），放大到 100
        newZoom = Math.max(0.1, Math.min(100, newZoom));
        this._tlZoom = newZoom;
        const newPxPerSec = this._getPxPerSec();
        const newPlayheadX = this._tlGlobalTime * newPxPerSec;

        // 始终尝试让播放头居中，clamp 自动处理边界
        // 只要内容足够宽（maxScroll 足够大），播放头就能居中
        this._tlScrollLeft = newPlayheadX - viewWidth / 2;
        this._clampScrollLeft();
        this._renderTimeline();
    }

    _onTimelineMouseDown(e) {
        // 用 composedPath 替代 target.closest，确保捕获 ::after 等伪元素区域的点击
        const path = e.composedPath();
        const isOnClip = path.some(el => el?.classList?.contains?.("xzg-ve-clip") || el?.classList?.contains?.("xzg-ve-audio-clip"));
        // 只在时间线空白区域（非片段、非手柄、非删除按钮）启动框选
        if (isOnClip) return;
        // 只接受左键
        if (e.button !== 0) return;

        const tlRect = this._timeline.getBoundingClientRect();
        const startX = e.clientX - tlRect.left;
        const startY = e.clientY - tlRect.top;
        // 记录按下位置：区分"点击"（选中轨道空隙）与"拖动"（框选）
        const downClientX = e.clientX;
        const downClientY = e.clientY;
        let dragged = false;

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
        // 清空动作延迟到确认拖动时执行：点击（未拖动）走空隙选中/清空逻辑，避免闪烁

        // 计算当前选择框相交的片段 id（视频 V1+V2 + 音频 A1+A2）
        const calcIntersect = () => {
            const boxRect = box.getBoundingClientRect();
            const ids = new Set();
            const testEl = (clipEl) => {
                const r = clipEl.getBoundingClientRect();
                const intersect = !(r.right < boxRect.left || r.left > boxRect.right ||
                                     r.bottom < boxRect.top || r.top > boxRect.bottom);
                if (intersect) {
                    const cid = parseInt(clipEl.dataset.clipId);
                    if (this.timeline.some(c => c.id === cid)) ids.add(cid);
                }
            };
            // 视频片段：V1（_tlTrack）+ V2（_tlV2TopTrack）
            for (const t of [this._tlTrack, this._tlV2TopTrack]) {
                if (!t) continue;
                t.querySelectorAll(".xzg-ve-clip").forEach(testEl);
            }
            // 音频片段：A1（_tlAudioTrack）+ A2（_tlV2BotTrack）
            for (const t of [this._tlAudioTrack, this._tlV2BotTrack]) {
                if (!t) continue;
                t.querySelectorAll(".xzg-ve-audio-clip").forEach(testEl);
            }
            return ids;
        };

        let curX = startX, curY = startY;
        const onMove = (ev) => {
            // 超过 5px 视为拖动（框选）；未超过则保持点击语义，不显示框
            if (!dragged) {
                if (Math.abs(ev.clientX - downClientX) <= 5 && Math.abs(ev.clientY - downClientY) <= 5) return;
                dragged = true;
                // 确认拖动：清空选中（原 mousedown 时为非 Ctrl 的行为，移至此处）
                if (!initialSelected) {
                    this.selectedClipIds.clear();
                    this._updateClipSelection();
                    this._clearGapSelection();
                    if (this.selectedMediaNames.size > 0) {
                        this.selectedMediaNames.clear();
                        this._renderMediaList();
                    }
                }
            }
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
            if (box.parentNode) box.parentNode.removeChild(box);
            this._selectionBox = null;
            if (!dragged) {
                // 点击空白（未拖动）：尝试选中点击处的轨道空隙
                // 命中 → 选中空隙（清空片段选中）；未命中 → 清空选中（与原行为一致）
                // Ctrl/Meta+点击空白：保留已有选中（原框选语义），不做空隙选中
                if (!initialSelected) {
                    this.selectedClipIds.clear();
                    this._updateClipSelection();
                    this._clearGapSelection();
                    if (this.selectedMediaNames.size > 0) {
                        this.selectedMediaNames.clear();
                        this._renderMediaList();
                    }
                    this._trySelectGapAt(downClientX, downClientY, e);
                }
            } else {
                // 仅更新选中态 class，不重建 DOM，避免松开鼠标时闪烁
                this._updateClipSelection();
            }
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
            // 点媒体库空白处时清空时间线选中（含轨道空隙选中）
            this._clearGapSelection();
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
        if (e.button !== 0) return;  // 只接受左键，右键保留给菜单
        e.preventDefault();
        e.stopPropagation();
        this._pushHistory();  // 记录裁剪前状态，支持 Ctrl+Z 撤销
        // 拖动手柄时自动选中该片段（清空空隙选中，两者互斥）
        this._clearGapSelection();
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
        // 图片为静帧：源时长视为无限，向右可无限拉长。
        // 不要用 clip.sourceDuration（图片创建时=placeholderDur=5）当上限，否则 maxDelta=0，右拉被钳死无法加长。
        const isImgClip = _isImage(clip.filename) || media?.info?.is_image === true;
        const sourceDuration = isImgClip ? Infinity : (media?.info?.duration || clip.sourceDuration || Infinity);
        // 拖动裁剪：隐藏本体 + 金色虚线预览框（与移动片段一致）
        let moved = false;
        let dragEl = null;            // 本体元素（拖动时隐藏）
        let previewEl = null;         // 金色虚线预览框
        let previewTrack = null;      // 预览框所在轨道
        let newStartVal = clip.start, newEndVal = clip.end, newPosVal = 0;

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
            // 按住 Alt：拖动速度降为原来的 20%（裁剪更精细）
            const moveScale = ev.altKey ? 0.2 : 1;
            const deltaTime = (dx * moveScale) / pxPerSec;
            let newStart, newEnd, newPos;

            if (which === "left") {
                // 左手柄：位置字段(tlStart/audioTlStart) 和 start 同步移动 deltaTime，end 不变
                // clamp: start >= 0（源入点不越界），duration >= minDuration
                const maxDelta = dur0 - minDuration;  // 右拖上限（裁头部，最短保留 minDuration）
                const minDelta = -start0;              // 左拖下限（扩展头部到源起点）
                let clampedDelta = Math.max(minDelta, Math.min(maxDelta, deltaTime));
                newStart = start0 + clampedDelta;
                newPos = posStart0 + clampedDelta;
                newEnd = end0;
                // 磁吸（仅磁吸开启时）：左边缘(位置)与时间轴起点(0)及其他片段左右边缘对齐
                if (this._magnetEnabled) {
                    const myLeft = newPos;
                    if (Math.abs(myLeft) < SNAP_SEC) {
                        newPos = 0; newStart = start0 + (newPos - posStart0);
                    } else {
                        // 吸附到播放头位置
                        const playheadT = this._tlGlobalTime != null ? this._tlGlobalTime : 0;
                        if (Math.abs(myLeft - playheadT) < SNAP_SEC) {
                            newPos = playheadT; newStart = start0 + (newPos - posStart0);
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
                    }
                }
            } else {
                // 右手柄：end 移动 deltaTime，位置字段(tlStart/audioTlStart) 和 start 不变
                // clamp: end <= sourceDuration（源出点不越界），duration >= minDuration
                const maxDelta = (sourceDuration === Infinity ? Infinity : sourceDuration - end0);  // 右拖上限（扩展尾部到源末尾）
                const minDelta = -(dur0 - minDuration);  // 左拖下限（裁尾部，最短保留 minDuration）
                let clampedDelta = Math.max(minDelta, Math.min(maxDelta, deltaTime));
                newEnd = end0 + clampedDelta;
                newStart = start0;
                newPos = posStart0;
                // 磁吸（仅磁吸开启时）：右边缘(位置 + dur)与其他片段左右边缘及播放头对齐
                if (this._magnetEnabled) {
                    const myRight = posStart0 + (newEnd - start0);
                    let snappedPh = false;
                    // 吸附到播放头位置
                    const playheadT = this._tlGlobalTime != null ? this._tlGlobalTime : 0;
                    if (Math.abs(myRight - playheadT) < SNAP_SEC) {
                        newEnd = start0 + (playheadT - posStart0); snappedPh = true;
                    }
                    if (!snappedPh) {
                        for (const r of clipRects) {
                            if (r.clip === clip) continue;
                            const oLeft = r.tlStart;
                            const oRight = r.tlStart + (r.clip.end - r.clip.start);
                            if (Math.abs(myRight - oLeft) < SNAP_SEC) { newEnd = start0 + (oLeft - posStart0); break; }
                            if (Math.abs(myRight - oRight) < SNAP_SEC) { newEnd = start0 + (oRight - posStart0); break; }
                        }
                    }
                }
            }

            if (!moved) {
                moved = true;
                // 首次移动：隐藏本体片段，仅显示金色虚线预览框（与移动片段一致）
                const trackMap = { v1: this._tlTrack, v2: this._tlV2TopTrack, a1: this._tlAudioTrack, a2: this._tlV2BotTrack };
                const tName = clip.track || (isAudioClip ? "a1" : "v1");
                const tgt = trackMap[tName] || this._tlTrack;
                if (isAudioClip) {
                    if (this._tlAudioTrack) {
                        const wfEl = this._tlAudioTrack.querySelector(`.xzg-ve-audio-clip[data-clip-id="${clip.id}"]`);
                        if (wfEl) { dragEl = wfEl; dragEl.style.display = "none"; }
                    }
                } else {
                    const clipEl = this._tlTrack.querySelector(`[data-clip-id="${clip.id}"]`)
                        || this._tlV2TopTrack?.querySelector(`[data-clip-id="${clip.id}"]`);
                    if (clipEl) { dragEl = clipEl; dragEl.style.display = "none"; }
                }
                if (tgt) {
                    previewEl = document.createElement("div");
                    previewEl.className = "xzg-ve-clip-preview";
                    tgt.appendChild(previewEl);
                    previewTrack = tName;
                }
            }

            // 保存最终裁剪值（up 时应用）
            newStartVal = newStart;
            newEndVal = newEnd;
            newPosVal = newPos;

            // 更新金色虚线预览框的位置/大小
            if (previewEl) {
                const px = this._getPxPerSec();
                const leftPx = newPos * px;
                const widthPx = Math.max(30, (newEnd - newStart) * px);
                previewEl.style.left = `${leftPx}px`;
                previewEl.style.width = `${widthPx}px`;
            }
        };
        const up = () => {
            this._tlInHandleDrag = false;
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            // 移除预览框，恢复本体显示
            if (previewEl) { previewEl.remove(); previewEl = null; }
            if (dragEl) dragEl.style.display = "";
            if (moved) {
                // 应用最终裁剪值到片段数据
                clip.start = newStartVal;
                clip.end = newEndVal;
                clip[posField0] = newPosVal;
                // 裁剪手柄松开后，应用重叠裁剪（被拖动片段保持完整，被覆盖片段自动裁剪）
                this._applyClipOverlapTrim(clip);
                this._renderTimeline();
                this._saveTimelineSession();
            }
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
        // 图片为静帧：源时长不限（不把 sourceDuration=placeholder=5 当上限）
        const leftIsImg = _isImage(leftClip.filename) || leftMedia?.info?.is_image === true;
        const leftSourceDur = leftIsImg ? Infinity : (leftMedia?.info?.duration || leftClip.sourceDuration || Infinity);
        const rightMedia = this.mediaLibrary.find(m => m.name === rightClip.filename);
        const rightIsImg = _isImage(rightClip.filename) || rightMedia?.info?.is_image === true;
        const rightSourceDur = rightIsImg ? Infinity : (rightMedia?.info?.duration || rightClip.sourceDuration || Infinity);

        const minDuration = 0.1;
        const leftDur0 = leftEnd0 - leftStart0;
        const rightDur0 = rightEnd0 - rightStart0;

        const move = (ev) => {
            const pxPerSec = this._getPxPerSec();
            const dx = ev.clientX - startX;
            // 按住 Alt：拖动速度降为原来的 20%（裁剪更精细）
            const moveScale = ev.altKey ? 0.2 : 1;
            const deltaTime = (dx * moveScale) / pxPerSec;

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

    // 解码源切换：探测视频编码，若 WebCodecs 无法解码（如 HEVC），切换为后端兜底转码的 H.264 产物 URL。
    // 仅在解码入口使用；图片/缩略图/纯音频走原始 _videoUrl，不受影响。
    // 结果按 filename|type 缓存，同一文件只探测一次。解码器 key 仍用原始 filename|type，
    // 保证 decoderPool 缓存/预加载判断不被破坏。
    async _decodeSource(filename, type) {
        const key = `${type || "input"}::${filename}`;
        if (!this._decodeSrcPromise) this._decodeSrcPromise = new Map();
        if (this._decodeSrcPromise.has(key)) return this._decodeSrcPromise.get(key);
        const p = (async () => {
            let url = this._videoUrl(filename, type);
            try {
                const resp = await api.fetchApi("/xzg_video_editor_ensure_h264", {
                    method: "POST",
                    body: JSON.stringify({ filename, type: type || "input" }),
                });
                const data = await resp.json();
                if (data && data.transcoded && data.filename && data.subfolder) {
                    url = this._videoUrl(data.filename, data.type || "input");
                }
            } catch (_) {}
            return url;
        })();
        this._decodeSrcPromise.set(key, p);
        return p;
    }

    // 时间线总时长（所有片段在时间轴上覆盖范围的最大末尾）
    _getTimelineTotalDuration() {
        // 返回所有片段末尾位置的最大值（音视频独立轨道，取最远末尾）
        // 纯音频片段用 audioTlStart 定位，视频片段用 tlStart
        // tlStart/audioTlStart 为 null 时按数组顺序自动追加到上一片段末尾
        // 音频加载器模式：完全忽略视频片段，只计算音频
        if (this.timeline.length === 0) return 0;
        let autoEnd = 0;
        let maxEnd = 0;
        for (const clip of this.timeline) {
            if (this._modeFilter === "audio" && clip.kind !== "audio") continue;
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
    // 时间线适配宽度：缩放到让全部内容刚好铺满可视区
    _fitTimelineToView() {
        const total = this._getTimelineTotalDuration();
        const viewWidth = this._getViewWidth();
        if (total <= 0 || viewWidth <= 0) return;
        // 留 5% 边距，避免内容紧贴右边界
        let newZoom = (viewWidth * 0.95) / (total * 30);
        newZoom = Math.max(0.1, Math.min(100, newZoom));
        this._tlZoom = newZoom;
        this._tlScrollLeft = 0;
        this._clampScrollLeft();
        this._renderTimeline();
        this._setStatus("时间线适配宽度");
    }
    // 缩放到显示 10 秒内容（10 倍帧率帧数），以当前播放头为中心，左右均分各 5 秒
    _zoomToTenSeconds() {
        const viewWidth = this._getViewWidth();
        if (viewWidth <= 0) return;
        // 让 10 秒刚好铺满可视区：zoom = 可视宽 / (10s * 30px/s)
        let newZoom = viewWidth / (10 * 30);
        newZoom = Math.max(0.1, Math.min(100, newZoom));
        this._tlZoom = newZoom;
        // 以播放头为中心：播放头 X 位于视口正中，左右各 5 秒
        const playheadX = this._tlGlobalTime * this._getPxPerSec();
        this._tlScrollLeft = playheadX - viewWidth / 2;
        this._clampScrollLeft();
        this._renderTimeline();
        this._setStatus(`时间线缩放：以播放头为中心显示 10 秒`);
    }
    // 鼠标 X 坐标转时间轴秒数（用于拖放定位）
    // align: "left" → 鼠标对应片段左边缘（媒体库拖入）；"center" → 鼠标对应片段中心点（Alt+拖动复制）
    // 根据鼠标 clientY 判断落在 V2/V1/A1/A2 哪个轨道区间
    // 坐标系：_timeline 区域 top 0~35px 是刻度区；轨道区 top=35px，向下为正
    //   V2 区间: [35, 35+v2tH)
    //   V1 区间: [35+v2tH, 35+v2tH+vH)
    //   5px 粗分割: [35+v2tH+vH, 35+v2tH+vH+5)    （视频/音频大分界）
    //   A1 区间: [35+v2tH+vH+5, 35+v2tH+vH+5+aH)
    //   A2 区间: [35+v2tH+vH+5+aH, +∞)
    // 参数 kind 用来过滤不合理轨道：
    //   kind="video" 时，落在音频区 → 返回 v1；落在 A1/A2 → 返回 v1（视频只能落 V1/V2，优先 V1）
    //   kind="audio" 时，落在视频区 → 返回 a1（音频只能落 A1/A2，优先 A1）
    _yToTrack(clientY, kind = "video") {
        if (!this._timeline) return kind === "audio" ? "a1" : "v1";
        const tlRect = this._timeline.getBoundingClientRect();
        const relY = clientY - tlRect.top - 35; // 相对轨道区顶部（刻度区底部）
        const v2tH = this._tlV2TopHeight || 0;
        const vH = this._tlVideoHeight || 0;
        const aH = this._tlAudioHeight || 0;
        const v1End = v2tH + vH;        // V1 底 = V1↔A1 粗分割线上沿
        const a1Start = v1End + 5;      // A1 顶 = 粗分割线下沿
        const a1End = a1Start + aH;     // A1 底 = A1↔A2 细分隔
        let track;
        if (relY < v2tH) track = "v2";
        else if (relY < v1End) track = "v1";
        else if (relY < a1Start) track = kind === "audio" ? "a1" : "v1";  // 落在 5px 粗分界：按 kind 选邻近
        else if (relY < a1End) track = "a1";
        else track = "a2";
        // 按 kind 纠正不合理轨道
        if (kind === "audio") {
            if (track !== "a1" && track !== "a2") return "a1";
        } else {
            if (track !== "v1" && track !== "v2") return "v1";
        }
        return track;
    }
    _clientXToTlStart(clientX, duration = 0, align = "left") {
        // 使用与 _mouseXToGlobalTime 完全一致的参考系：_timeline.getBoundingClientRect() + _tlLeftPad
        // 避免混用 _tlTrack.getBoundingClientRect() 导致在纯音频模式下（V1高度=0）X坐标计算错位
        const pxPerSec = this._getPxPerSec();
        if (pxPerSec <= 0) return 0;
        const tlRect = this._timeline.getBoundingClientRect();
        const contentLeft = tlRect.left + this._tlLeftPad;
        const xRelative = clientX - contentLeft + this._tlScrollLeft;
        const mouseSec = Math.max(0, xRelative / pxPerSec);
        // align="center" 时鼠标对应片段中心 → tlStart = mouseSec - duration/2；align="left" 时鼠标对应片段左边缘 → tlStart = mouseSec
        let ts = Math.max(0, align === "center" ? mouseSec - duration / 2 : mouseSec);
        // 帧对齐：量化到时间轴统一帧率边界（与播放头 _mouseXToGlobalTime、刻度 _renderTicks 一致）
        // 否则拖入的片段会落在半帧位置，与播放头/刻度错位
        const fps = this._getTimelineFps();
        if (fps > 0) ts = Math.round(ts * fps) / fps;
        return Math.max(0, ts);
    }
    // 磁吸：片段左右边缘吸附到时间轴起点(0)及其他片段边缘，阈值15px
    // 支持音频↔视频双向吸附：遍历所有片段，按其 kind 选择对应位置字段
    // tlStart：当前 tlStart；dur：片段时长；excludeId：拖动中需排除的片段 id（可选）
    _snapTlStart(tlStart, dur, excludeId = null) {
        // 磁吸关闭时不做任何吸附，直接返回原位置
        if (!this._magnetEnabled) return tlStart;
        const pxPerSec = this._getPxPerSec();
        const SNAP_SEC = 15 / pxPerSec;
        const myLeft = tlStart;
        const myRight = tlStart + dur;
        // 吸附到时间轴起点（0）
        if (Math.abs(myLeft) < SNAP_SEC) return 0;
        if (Math.abs(myRight) < SNAP_SEC) return -dur;
        // 吸附到播放头位置
        const playheadT = this._tlGlobalTime != null ? this._tlGlobalTime : 0;
        if (Math.abs(myLeft - playheadT) < SNAP_SEC) return playheadT;
        if (Math.abs(myRight - playheadT) < SNAP_SEC) return playheadT - dur;
        // 吸附到其他片段边缘（音频用 audioTlStart，视频用 tlStart）
        // 音频加载器模式：完全忽略视频片段，只吸附到音频片段
        for (const c of this.timeline) {
            if (c.id === excludeId) continue;
            if (this._modeFilter === "audio" && c.kind !== "audio") continue;
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
    // clientY: 可选，传入后用 _yToTrack 精确选中 V2/V1 或 A1/A2 预览轨道
    _showDragPreview(clientX, duration, align = "left", kind = "video", clientY = null) {
        // 音频加载器模式：所有拖入媒体强制视为音频，摒弃视频轨道干扰
        if (this._modeFilter === "audio") kind = "audio";
        const pxPerSec = this._getPxPerSec();

        let dur = duration;
        let dragMedia = null;  // 保存媒体引用，用于后续音频轨道预览判断
        if (dur == null) {
            // 获取拖放的媒体信息以计算预览宽度
            const name = this._dragPreviewName;
            dur = 5; // 默认预览时长 5s
            if (name) {
                const media = this.mediaLibrary.find(m => m.name === name);
                dragMedia = media;
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

        // 根据轨道选择预览框所在的轨道：
        //   video + track=v2 → V2 上轨道
        //   video + track=v1 → V1 主轨道
        //   audio + track=a1 → A1 主音频轨道
        //   audio + track=a2 → A2 下音频轨道
        const track = clientY != null ? this._yToTrack(clientY, kind)
                                      : (kind === "audio" ? "a1" : "v1");
        let targetTrack;
        if (kind === "audio") {
            targetTrack = track === "a2" ? this._tlV2BotTrack : this._tlAudioTrack;
        } else {
            targetTrack = track === "v2" ? this._tlV2TopTrack : this._tlTrack;
        }
        if (!targetTrack) return;
        // 视频含音频时，对应音频轨道也需显示预览框（V2→A2，V1→A1）
        const hasAudio = kind === "video" && dragMedia?.info?.has_audio === true;
        const audioTrackName = hasAudio ? (track === "v2" ? "a2" : "a1") : null;
        const audioTargetTrack = audioTrackName === "a2" ? this._tlV2BotTrack : (audioTrackName === "a1" ? this._tlAudioTrack : null);
        // 先清除其他轨道上残留的旧预览（避免拖到不同轨道后旧框还在）
        // 视频含音频时保留音频轨道预览不清除
        const allTracks = [this._tlTrack, this._tlAudioTrack, this._tlV2TopTrack, this._tlV2BotTrack];
        for (const t of allTracks) {
            if (t && t !== targetTrack && t !== audioTargetTrack) {
                const p = t.querySelector(".xzg-ve-clip-preview");
                if (p) p.remove();
            }
        }
        let preview = targetTrack.querySelector(".xzg-ve-clip-preview");
        if (!preview) {
            preview = document.createElement("div");
            preview.className = "xzg-ve-clip-preview";
            targetTrack.appendChild(preview);
        }
        preview.style.left = `${leftPx}px`;
        preview.style.width = `${widthPx}px`;
        // 视频含音频：同时在音频轨道显示预览框
        if (hasAudio && audioTargetTrack) {
            let audioPreview = audioTargetTrack.querySelector(".xzg-ve-clip-preview");
            if (!audioPreview) {
                audioPreview = document.createElement("div");
                audioPreview.className = "xzg-ve-clip-preview";
                audioTargetTrack.appendChild(audioPreview);
            }
            audioPreview.style.left = `${leftPx}px`;
            audioPreview.style.width = `${widthPx}px`;
        }
    }
    _hideDragPreview() {
        // 从所有轨道（V1、A1、V2、A2）都移除预览框
        const allTracks = [this._tlTrack, this._tlAudioTrack, this._tlV2TopTrack, this._tlV2BotTrack];
        for (const t of allTracks) {
            if (!t) continue;
            const p = t.querySelector(".xzg-ve-clip-preview");
            if (p) p.remove();
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
            this._renderMarkerFlags();
        }
        // 同步 4 条轨道（V1/V2/A1/A2）的原生 scrollLeft，使片段随刻度同步滚动
        // 缺一会导致该轨道片段不随时间线平移，缩放（播放头居中使 scrollLeft 变化）时与播放头逐渐错位
        for (const t of [this._tlTrack, this._tlV2TopTrack, this._tlAudioTrack, this._tlV2BotTrack]) {
            if (t) {
                t.scrollLeft = this._tlScrollLeft;
            }
        }
        // 更新片段文件名位置：滚动时文字始终粘在可见区域左侧
        this._updateClipLabels();
        this._updatePlayhead();
    }

    // 片段文件名跟随滚动：当片段左部分超出视口时，文字粘在可见区域左侧
    _updateClipLabels() {
        if (!this._tlTrack) return;
        const scrollLeft = this._tlScrollLeft;
        // V1 + V2 两条视频轨道统一遍历
        for (const t of [this._tlTrack, this._tlV2TopTrack]) {
            if (!t) continue;
            for (const el of t.querySelectorAll(".xzg-ve-clip")) {
                const clipLeft = parseFloat(el.style.left) || 0;
                const clipWidth = parseFloat(el.style.width) || 0;
                const info = el.querySelector(".xzg-ve-clip-info");
                if (!info) continue;
                // 文字偏移：粘在视口左边缘，但不超过片段右边界（保留 60px 显示空间）
                const offset = Math.max(0, Math.min(scrollLeft - clipLeft, Math.max(0, clipWidth - 60)));
                info.style.left = offset > 0 ? `${offset}px` : "";
            }
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
        // ⚠️ 多轨视频优先级：V2（上层视频，clip.track=="v2"）> V1（下层视频）
        //   同时间点 V2 与 V1 在 X 方向重叠 → 返回 V2（V2 画面覆盖 V1 显示）
        //   只有该时间点无任何 V2 命中才回落 V1；无视频命中才返回纯 audio 命中
        // 音频加载器模式：完全忽略视频片段，只查找音频
        let v2Hit = null;       // V2 上层视频命中
        let v1Hit = null;       // V1 下层视频命中（兜底）
        let audioHit = null;    // 纯音频命中
        for (let i = 0; i < this.timeline.length; i++) {
            const clip = this.timeline[i];
            if (this._modeFilter === "audio" && clip.kind !== "audio") continue;
            const dur = clip.end - clip.start;
            if (dur <= 0) continue;
            const clipStart = this._getClipTlStart(clip);
            const clipEnd = clipStart + dur;
            if (!(globalTime >= clipStart && globalTime < clipEnd)) continue;
            if (clip.kind !== "audio") {
                const h = { clip, clipIndex: i, localTime: clip.start + (globalTime - clipStart) };
                if (clip.track === "v2") {
                    if (!v2Hit) v2Hit = h;
                } else {
                    if (!v1Hit) v1Hit = h;
                }
            } else if (!audioHit) {
                audioHit = { clip, clipIndex: i, localTime: clip.start + (globalTime - clipStart) };
            }
        }
        // 返回优先级：V2 → V1 → audioHit → null
        return v2Hit || v1Hit || audioHit || null;
    }

    // 返回某个全局时间点所有活跃的视频片段（用于多轨合成预览），按轨道 V1→V2 排序。
    // 返回 [{ clip, localTime, track }]；无视频命中返回 []。
    _getVideoLayersAt(globalTime) {
        const layers = [];
        for (let i = 0; i < this.timeline.length; i++) {
            const clip = this.timeline[i];
            if (clip.kind === "audio") continue;
            const dur = clip.end - clip.start;
            if (dur <= 0) continue;
            const clipStart = this._getClipTlStart(clip);
            const clipEnd = clipStart + dur;
            if (!(globalTime >= clipStart && globalTime < clipEnd)) continue;
            layers.push({ clip, localTime: clip.start + (globalTime - clipStart), track: clip.track === "v2" ? "v2" : "v1" });
        }
        // V1 在下层，V2 在上层
        layers.sort((a, b) => (a.track === "v2" ? 1 : 0) - (b.track === "v2" ? 1 : 0));
        return layers;
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
        // E1: 先停止旧的播放循环（避免 await 期间旧循环继续更新 _tlGlobalTime）
        this._stopPlaybackLoop();
        // 音频源管理由 _startAudioPlayback 统一负责（定期调用时自动停止非活跃源、启动活跃源）
        // 视频片段切换时音频独立播放，不应中断；音频缓冲也不应清空（各片段按 clip.id 独立缓存）
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
                // letterbox 模式：主 canvas 按目标分辨率比例 contain + 居中绘制图片（上下/左右黑边）
                this._drawSourceToCanvas(img);
                // 统一内核渲染当前时间点所有层（含跨轨穿透）
                this._renderTimelineFrame(this._tlGlobalTime);
                // 缓存图片元素供播放循环复用
                this._imgElement = img;
                this._currentImageEl = img;
                this._imgLoadedFile = clip.filename;
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
        this._imgElement = null;
        this._currentImageEl = null;
        this._imgLoadedFile = null;
        if (isAudioOnly || this._modeFilter === "audio") {
            this._currentDecoder = null;
            this._canvas.classList.add("xzg-ve-active");
            this._previewEmpty.classList.add("xzg-ve-hidden");
            // 音频加载器模式：纯黑屏，不显示🎵图标
            if (this._modeFilter === "audio") {
                this._clearCanvasBlack();
            } else {
                this._clearCanvasForAudio();
            }
            this._hideLoadingOverlay();
            // 预解码音频缓冲并启动所有活跃音频片段（多源混音）
            try {
                if (autoplay && this._tlPlaying) {
                    // 统一时钟播放：音频片段与视频/图片一致走单一时钟 _startPlaybackLoop，
                    // 逐 tick 的 _checkAudioBoundary 负责音频源启停，_renderTimelineFrame 对无视频层点清底。
                    this._startPlaybackLoop();
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
            const url = await this._decodeSource(clip.filename, clip.type);
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

            // Letterbox 预览：主 canvas 内部分辨率固定 = 目标分辨率（导出宽高）
            // 解码器渲到离屏 canvas（decoder 会重置它的 width/height 为 previewWidth/previewHeight）
            // 然后我们手动 letterbox 贴到主 canvas

            // 计算目标帧号
            const fps = decoder.fps || 30;
            const targetFrame = Math.max(0, Math.min(
                Math.round(localTime * fps),
                Math.max(0, decoder.frameCount - 1)
            ));

            // 渲染目标帧到离屏 canvas（decoder 会重置其 width/height = preview 尺寸）
            await decoder.renderFrame(targetFrame, this._offscreenCanvas, true);
            if (token !== this._loadClipToken) return;
            // 统一内核：渲染当前时间点所有可见层（含跨轨穿透），播放与 seek 共用
            this._renderTimelineFrame(this._tlGlobalTime);

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
        this._syncPreviewCanvasSize();  // 确保 canvas 尺寸 = 目标分辨率
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

    // 音频加载器模式：纯黑屏，无任何图标
    _clearCanvasBlack() {
        if (!this._canvas) return;
        this._syncPreviewCanvasSize();
        const ctx = this._canvas.getContext("2d");
        if (!ctx) return;
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, this._canvas.width, this._canvas.height);
    }

    // ── 预览画布按「目标渲染分辨率」letterbox 显示 ──────────────────────
    // 优先级：手动设置宽高 > 首个带分辨率的片段 > 默认 1280x720
    _getTargetResolution() {
        if (this._root) {
            const wInput = this._root.querySelector(".xzg-ve-render-w");
            const hInput = this._root.querySelector(".xzg-ve-render-h");
            const tw = Math.max(0, Math.round(Number(wInput?.value || 0)));
            const th = Math.max(0, Math.round(Number(hInput?.value || 0)));
            if (tw > 0 && th > 0) return { w: tw, h: th };
        }
        // 回退：时间线中首个带分辨率的片段
        if (this.timeline && this.mediaLibrary) {
            for (const clip of this.timeline) {
                const m = this.mediaLibrary.find(mm => mm.name === clip.filename && mm.type === (clip.type || "input"));
                if (m && m.info && m.info.width > 0 && m.info.height > 0) {
                    return { w: m.info.width, h: m.info.height };
                }
            }
        }
        // 默认（导出端和纯音频时一致）
        return { w: 1280, h: 720 };
    }

    // 根据当前目标分辨率，同步预览框的比例与定位
    // 由于已改用 absolute + transform 精确控制，这里仅委托 apply
    _updatePreviewFrameAspect() {
        this._applyPreviewFrameSize(false);
    }

    // 把当前 _previewTx / _previewTy / _previewZoom 写入 CSS transform（transform-origin 已在 CSS 设为 0 0）
    _writePreviewTransform() {
        if (!this._previewFrame) return;
        const tx = Math.round(this._previewTx * 100) / 100;
        const ty = Math.round(this._previewTy * 100) / 100;
        const zm = Math.round(this._previewZoom * 10000) / 10000;
        this._previewFrame.style.transform = `translate(${tx}px, ${ty}px) scale(${zm})`;
    }

    /**
     * 按「目标分辨率比例」contain 到 .xzg-ve-preview 容器得到 natural 尺寸。
     * 预览画面通过 transform(translate + scale) 定位：
     *   - zoom=1 且 center=true（初始化/重置）：画面居中显示（tx,ty 自动计算）
     *   - 容器尺寸变化（keepTransform=true，即 ResizeObserver、用户改分辨率等不强制回到中心）：
     *     保持画面中心相对容器中心的比例不变（避免画面突然跳到居中）
     *
     * @param {boolean} keepTransform  true=按比例保留当前相对位置；false=回到居中
     */
    _applyPreviewFrameSize(keepTransform = false) {
        const frame = this._previewFrame;
        const host = this._previewHost;
        if (!frame || !host) return;
        const { w: tw, h: th } = this._getTargetResolution();
        if (!(tw > 0 && th > 0)) return;

        const hostW = Math.max(1, host.clientWidth);
        const hostH = Math.max(1, host.clientHeight);
        const ratio = tw / th;
        // contain 算法：naturalW × naturalH 即 zoom=1 时画面的 CSS 尺寸（不乘 zoom）
        let naturalW = Math.min(hostW, hostH * ratio);
        let naturalH = naturalW / ratio;
        if (naturalH > hostH) {
            naturalH = hostH;
            naturalW = naturalH * ratio;
        }
        naturalW = Math.max(1, Math.round(naturalW));
        naturalH = Math.max(1, Math.round(naturalH));
        frame.style.width = naturalW + "px";
        frame.style.height = naturalH + "px";

        const zoom = this._previewZoom;
        const scaledW = naturalW * zoom;
        const scaledH = naturalH * zoom;
        const centerTx = (hostW - scaledW) / 2;
        const centerTy = (hostH - scaledH) / 2;

        if (!keepTransform) {
            // false：初始化 / 重置 / 用户明确要求居中
            this._previewTx = centerTx;
            this._previewTy = centerTy;
        } else {
            // true：容器或目标分辨率变化导致 natural / host 变了，
            //       保留画面中心相对容器中心的比例（避免突然跳到中心）
            //       比例 = (当前画面中心 - 容器中心) / natural * zoom 映射
            //       简化：按画面中心相对容器中心的偏移比例来保存
            if (naturalW > 0 && naturalH > 0 && scaledW > 0 && scaledH > 0) {
                // 当前画面中心相对容器中心的偏移（像素）
                const oldCenterX = this._previewTx + scaledW / 2 - hostW / 2;
                const oldCenterY = this._previewTy + scaledH / 2 - hostH / 2;
                // 按比例映射：如果 natural 变了 (目标分辨率变化) 或 host 变了，也要保持大致位置
                // 简化：直接用旧的偏移像素，新 centerTx + 旧偏移
                // （这样用户感觉画面"中心没变"，符合直觉）
                this._previewTx = centerTx + oldCenterX;
                this._previewTy = centerTy + oldCenterY;
            } else {
                this._previewTx = centerTx;
                this._previewTy = centerTy;
            }
        }
        this._writePreviewTransform();
    }

    /**
     * 以 host 内的相对坐标 (hx, hy) 为缩放中心调整预览缩放倍率。
     * 保证同一个 frame 坐标点在缩放前后都对应屏幕上相同的鼠标位置。
     * @param {number} hx 鼠标相对预览容器 host 的 X
     * @param {number} hy 鼠标相对预览容器 host 的 Y
     * @param {number} factor 缩放系数（>1 放大）
     * @returns {boolean} 是否真的发生了变化（clamp 到边界可能不变）
     */
    _zoomPreviewAtPoint(hx, hy, factor) {
        if (!this._previewHost || !this._previewFrame) return false;
        const before = this._previewZoom;
        let next = before * factor;
        next = Math.max(0.1, Math.min(8, next));
        if (Math.abs(next - before) < 0.001) return false;
        // 1) 算 (hx, hy) 对应 frame 坐标系的点（以 frame 左上角为原点，不考虑缩放）
        //    frame 坐标系中坐标 = (屏幕坐标 - translate) / zoom
        const frameX = (hx - this._previewTx) / before;
        const frameY = (hy - this._previewTy) / before;
        // 2) 应用新 zoom，让同一个 frameX/Y 点仍落在 (hx, hy)
        //    hx = tx2 + frameX * next  =>  tx2 = hx - frameX * next
        this._previewZoom = next;
        this._previewTx = hx - frameX * next;
        this._previewTy = hy - frameY * next;
        this._writePreviewTransform();
        return true;
    }

    /** 重置预览视图：zoom=1 并且画面居中（对应工具栏按钮 + Z 快捷键） */
    _resetPreviewZoom() {
        this._previewZoom = 1;
        this._applyPreviewFrameSize(false);  // false = 居中
    }

    // 同步主 canvas 的内部分辨率到「目标分辨率」，同时保证 wrapper div 比例一致
    // 注：decoder 渲染到离屏 canvas，不会再修改主 canvas 的宽高
    _syncPreviewCanvasSize() {
        if (!this._canvas) return;
        this._updatePreviewFrameAspect();
        const { w, h } = this._getTargetResolution();
        if (w > 0 && h > 0 && (this._canvas.width !== w || this._canvas.height !== h)) {
            this._canvas.width = w;
            this._canvas.height = h;
        }
    }

    /**
     * 把源图像（canvas/img/video）以 contain+letterbox 方式画到主 canvas（目标分辨率）：
     *   - 先整屏黑色填充（保证两侧/上下黑底）
     *   - 按 contain 比例计算居中的绘制矩形
     *   - drawImage(src, dx, dy, dW, dH)
     * @param {HTMLCanvasElement|HTMLImageElement|HTMLVideoElement} src 源图像
     * @param {number} [srcW] 源图像宽；不传则取 naturalWidth/width
     * @param {number} [srcH] 源图像高；不传则取 naturalHeight/height
     */
    _drawSourceToCanvas(src, srcW, srcH) {
        if (!this._canvas || !src) return;
        this._syncPreviewCanvasSize();
        const canvas = this._canvas;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        // 先填黑底（letterbox 区域的黑）
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        this._paintClipFrame(ctx, canvas.width, canvas.height, src, srcW, srcH, this._currentClip);
    }

    // 把单个片段的帧绘制到指定 context（不填黑底、不做尺寸同步），应用裁剪/大小/移动/透明度。
    // 供多层合成时从底层到顶层依次调用。
    _paintClipFrame(ctx, TW, TH, src, srcW, srcH, c) {
        if (!src || !ctx) return;
        if (srcW == null) {
            srcW = src.naturalWidth || src.videoWidth || src.width || 0;
        }
        if (srcH == null) {
            srcH = src.naturalHeight || src.videoHeight || src.height || 0;
        }
        if (!(srcW > 0 && srcH > 0 && TW > 0 && TH > 0)) return;
        // 应用裁剪 / 大小缩放 / 透明度（音频无这些属性）
        const scale = (c && c.scale != null && c.scale > 0) ? c.scale : 1;
        const opacity = (c && c.opacity != null) ? Math.min(1, Math.max(0, c.opacity)) : 1;
        const cropLeft = (c && c.cropLeft != null) ? Math.min(1, Math.max(0, c.cropLeft)) : 0;
        const cropRight = (c && c.cropRight != null) ? Math.min(1, Math.max(0, c.cropRight)) : 0;
        const cropTop = (c && c.cropTop != null) ? Math.min(1, Math.max(0, c.cropTop)) : 0;
        const cropBottom = (c && c.cropBottom != null) ? Math.min(1, Math.max(0, c.cropBottom)) : 0;
        // 移动：水平/垂直像素偏移
        const offsetX = (c && c.offsetX != null) ? c.offsetX : 0;
        const offsetY = (c && c.offsetY != null) ? c.offsetY : 0;
        // 先按完整源图 contain 到画布（含 scale），得到画面在画布上的绘制矩形（大小/位置保持不变）
        const baseScale = Math.min(TW / srcW, TH / srcH) * scale;
        const dW = Math.max(1, Math.round(srcW * baseScale));
        const dH = Math.max(1, Math.round(srcH * baseScale));
        const dx = Math.round((TW - dW) / 2);
        const dy = Math.round((TH - dH) / 2);
        // 裁剪：从画面四边裁掉指定比例，剩余区域保持原大小与位置（不重新缩放适应）
        const keepW = Math.max(0.01, 1 - cropLeft - cropRight);   // 水平保留比例
        const keepH = Math.max(0.01, 1 - cropTop - cropBottom);    // 垂直保留比例
        const cropPx = cropLeft * dW;   // 保留区域起点（相对画面矩形）
        const cropPy = cropTop * dH;
        const cropPw = Math.max(1, Math.round(keepW * dW));
        const cropPh = Math.max(1, Math.round(keepH * dH));
        // 把保留区域映射回源图坐标
        const sx = cropPx / dW * srcW;
        const sy = cropPy / dH * srcH;
        const sw = cropPw / dW * srcW;
        const sh = cropPh / dH * srcH;
        // 高质量 + 透明度；保留区域在画布上保持原大小绘制，并应用移动偏移
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.globalAlpha = opacity;
        ctx.drawImage(src, sx, sy, sw, sh, dx + cropPx + offsetX, dy + cropPy + offsetY, cropPw, cropPh);
        ctx.globalAlpha = 1;
    }

    // 获取/复用一块离屏 canvas，供多轨合成时渲染某一层帧
    _getLayerCanvas() {
        if (!this._layerCanvas) this._layerCanvas = document.createElement("canvas");
        return this._layerCanvas;
    }

    // 多轨合成用的独立层画布池：每层一个独占 canvas，杜绝多轨并发取帧写同一画布互相覆盖（错乱）。
    _takeLayerCanvas() {
        if (this._layerPool && this._layerPool.length) return this._layerPool.pop();
        return document.createElement("canvas");
    }
    _releaseLayerCanvas(c) {
        if (!c) return;
        if (!this._layerPool) this._layerPool = [];
        if (this._layerPool.length < 8) this._layerPool.push(c);
    }

    // 渲染单个片段在某局部时间的一帧，返回 { src, srcW, srcH }（Promise；失败返回 null）
    async _renderLayerFrame(clip, localTime) {
        if (!clip) return null;
        const media = this.mediaLibrary.find(m => m.name === clip.filename && m.type === clip.type);
        const isImage = _isImage(clip.filename) || media?.info?.is_image === true;
        if (isImage) {
            // 图片：优先复用当前主图（V2 上层场景）；否则独立加载该图片并缓存到 clip，
            // 保证 V1 底层图片片段也能渲染出来（不依赖 this._imgElement 的单一加载态）。
            if (this._imgElement && this._imgLoadedFile === clip.filename) {
                return { src: this._imgElement, srcW: this._imgElement.naturalWidth, srcH: this._imgElement.naturalHeight };
            }
            if (clip._layerImg && clip._layerImg.complete && clip._layerImg.naturalWidth > 0) {
                return { src: clip._layerImg, srcW: clip._layerImg.naturalWidth, srcH: clip._layerImg.naturalHeight };
            }
            if (!clip._layerImgPromise) {
                clip._layerImgPromise = new Promise((resolve) => {
                    const img = new Image();
                    img.onload = () => { clip._layerImg = img; resolve(true); };
                    img.onerror = () => { resolve(false); };
                    img.src = this._videoUrl(clip.filename, clip.type);
                });
            }
            const ready = await clip._layerImgPromise;
            if (ready && clip._layerImg) {
                return { src: clip._layerImg, srcW: clip._layerImg.naturalWidth, srcH: clip._layerImg.naturalHeight };
            }
            return null;
        }
        try {
            const decoder = await decoderPool.get(clip.filename, clip.type, await this._decodeSource(clip.filename, clip.type), () => {});
            const fps = decoder.fps || 30;
            // 帧号为源视频的绝对帧号：localTime 已是绝对源时间（= clip.start + 时间轴偏移），
            // 不能再减 clip.start，否则裁掉头部的片段播放时又会从源第 0 帧开始。
            const loc = Math.max(0, localTime);
            const f = Math.max(0, Math.min(Math.round(loc * fps), Math.max(0, decoder.frameCount - 1)));
            const tmp = this._getLayerCanvas();
            // 用 readFrameCached：真正等待该帧解码完成并写入 tmp（resolve 时内容已就绪）。
            // 不能用 renderFrame——它未命中缓存时只做后台 rAF 调度并立即返回，
            // await 后 tmp 仍是空画布，导致多轨合成时视频底层(下层)画不出来/黑屏。
            const ok = await decoder.readFrameCached(f, tmp);
            if (ok && tmp.width > 0 && tmp.height > 0) {
                return { src: tmp, srcW: tmp.width, srcH: tmp.height };
            }
        } catch (_) {}
        return null;
    }

    // 判单层取帧：图片层走 _renderLayerFrame；视频层走缓存优先取帧。
    // layerCanvas：该层独占画布，仅在视频层 seek 未命中需精确解码时使用（避免多发层共享画布互相覆盖）。
    async _frameForLayer(layer, layerCanvas) {
        const clip = layer?.clip;
        if (!clip || clip.kind === "audio") return null;
        const media = this.mediaLibrary.find(m => m.name === clip.filename && m.type === clip.type);
        const isImage = _isImage(clip.filename) || media?.info?.is_image === true;
        if (isImage) return this._renderLayerFrame(clip, layer.localTime);
        return this._renderVideoLayerFrame(layer, layerCanvas);
    }

    // VideoCache 式取视频帧：渲染走「只读 FrameCache」——命中即零成本绘制（纯 Map 读，不触碰 sink）；
    // 未命中播放路径显示最近帧顶住画面并后台预取追平，绝不在此停迭代器/await 硬解码（那是卡顿与起播黑屏根因）。
    // 非播放（seek/拖帧/刷新）未命中才停预取迭代器→精确解码，且用最近帧兜底，消除“前拖/起播黑屏”。
    // 返回 { src, srcW, srcH } 或 null；src 优先为缓存 canvas（只读源），解码路径为独立 layerCanvas。
    async _renderVideoLayerFrame(layer, layerCanvas) {
        const clip = layer?.clip;
        if (!clip) return null;
        try {
            const decoder = await decoderPool.get(clip.filename, clip.type, await this._decodeSource(clip.filename, clip.type), () => {});
            if (!decoder || !decoder._track || decoder.frameCount <= 0) return null;
            const fps = decoder.fps || 30;
            // 帧号为源视频的绝对帧号，layer.localTime 已是绝对源时间，不能再减 clip.start，
            // 否则裁掉头部的片段播放时又从源第 0 帧开始。
            const loc = Math.max(0, layer.localTime);
            const target = Math.max(0, Math.min(Math.round(loc * fps), decoder.frameCount - 1));

            // 播放路径：读缓存（零等待）。命中直接出帧；未命中最近帧顶住（不黑屏）+ 后台预取追平。
            if (this._tlPlaying) {
                const cached = decoder.getCachedFrameSync(target);
                let src = null;
                if (cached) {
                    src = cached;
                } else {
                    const f = decoder._cache.findClosest(target);
                    const c = f >= 0 ? decoder._cache.get(f) : null;
                    src = c || null;
                }
                this._vcachePrefetch(clip, decoder, target);   // 后台追平（不阻塞本帧）
                if (src) return { src, srcW: src.width, srcH: src.height };
                return null;
            }

            // 非播放（seek/拖帧/刷新）：命中直接出；未命中停预取迭代器→精确解码进独有 layerCanvas；
            // 解码期间/失败用最近帧顶住，避免“前拖/起播黑屏”。
            const cached = decoder.getCachedFrameSync(target);
            if (cached) return { src: cached, srcW: cached.width, srcH: cached.height };
            await this._stopVcache(clip, decoder);
            const ok = await decoder.readFrameCached(target, layerCanvas);
            if (ok && layerCanvas.width > 0 && layerCanvas.height > 0) {
                return { src: layerCanvas, srcW: layerCanvas.width, srcH: layerCanvas.height };
            }
            const f = decoder._cache.findClosest(target);
            const nearest = f >= 0 ? decoder._cache.get(f) : null;
            if (nearest) return { src: nearest, srcW: nearest.width, srcH: nearest.height };
            return null;
        } catch (_) {
            return null;
        }
    }

    // 预解码（fire-and-forget，单飞行）：把「target 之后一窗口」的顺序帧解入 decoder 的 FrameCache，
    // 让播放渲染命中缓存、保持预取领先。播放期间【永不停止】迭代器（停止会摧毁预取优势并导致起播卡顿）。
    // 仅当 无迭代器 / decoder 或 clip 变化 / 目标明显前跳超过窗口 时才重建迭代器。
    // 铁律：预取领先量封顶 target+winFrames，领先已足时本次调用零拉帧——预取速率必须锁定为
    // 播放速率，绝不按调用频率（RAF 60-100次/秒）多拉，否则领先量按解码速度膨胀并挤掉目标帧。
    _vcachePrefetch(clip, decoder, targetFrame) {
        if (!this._tlPlaying || !decoder) return;
        let st = this._vcache.get(clip.id);
        if (!st) { st = { decoder: null, iterClip: null, busy: false, topFilled: -1 }; this._vcache.set(clip.id, st); }
        if (st.busy) return;
        st.busy = true;
        const fps = decoder.fps || 30;
        const winFrames = Math.max(24, Math.round(this._vcacheWindowSec * fps));
        (async () => {
            try {
                // 节拍锁定：领先量已足（迭代器有效且 topFilled ≥ target+窗口）时本次不拉帧。
                // 否则预取会按 RAF 调用频率（60-100次/秒）每次多拉 1 帧，领先量按"解码速度"
                // 而非"播放速度"膨胀；FrameCache 按"距 targetFrame 最远先淘汰"会把播放目标帧
                // 挤出缓存，渲染未命中 findClosest 取到预取头附近的未来帧 → 画面渐进加速
                // （时间码仍 1x，约 2-3 秒后开始，暂停再播重演）。
                if (decoder._playbackIter && st.decoder === decoder && st.iterClip === clip.id &&
                    st.topFilled >= targetFrame + winFrames) {
                    // 仅刷新淘汰中心到当前播放目标，保护目标邻域
                    decoder._targetFrame = targetFrame;
                    decoder._cache.targetFrame = targetFrame;
                    return;
                }
                // 需要重建：无迭代器 / 句柄或 clip 变了 / 预取已明显落后于目标（大前跳，如切换片段）
                if (!decoder._playbackIter || st.decoder !== decoder || st.iterClip !== clip.id ||
                    st.topFilled < targetFrame - winFrames) {
                    decoder.stopPlaybackIterator();
                    decoder.createPlaybackIterator(Math.max(0, (targetFrame - winFrames) / fps));
                    st.decoder = decoder;
                    st.iterClip = clip.id;
                    st.topFilled = -1;
                }
                const it = decoder._playbackIter;
                if (!it) return;
                const fillTo = targetFrame + winFrames;
                for (let guard = 0; guard < winFrames + 12 && decoder._playbackIter === it; guard++) {
                    const r = await it.next();
                    if (decoder._playbackIter !== it) break;
                    if (r.done) break;
                    const wc = r.value;
                    if (!wc || !wc.canvas) continue;
                    const f = Math.round((wc.timestamp || 0) * fps);
                    if (f > st.topFilled) {
                        const copy = document.createElement("canvas");
                        copy.width = wc.canvas.width;
                        copy.height = wc.canvas.height;
                        copy.getContext("2d").drawImage(wc.canvas, 0, 0);
                        // 淘汰中心锚定"当前播放目标帧"而非预取头：缓存优先保留正在显示/
                        // 即将显示的邻域，预取头侧的未来帧先被淘汰，目标帧永不被挤出。
                        decoder._targetFrame = targetFrame;
                        decoder._cache.targetFrame = targetFrame;
                        decoder._cache.add(f, copy);
                        st.topFilled = f;
                    }
                    if (f >= fillTo) break;
                }
            } catch (_e) {
                // 预取失败不影响渲染（下帧重试）
            } finally {
                st.busy = false;
            }
        })();
    }

    // 停掉某 video 层的预取迭代器，释放 sink；同时把该层 vcache 标记为非 busy，
    // 使紧接着的 readFrameCached 能随机寻址解码（sink 单操作约束）。仅 seek/刷新（非播放）时调用。
    async _stopVcache(clip, decoder) {
        if (decoder && decoder._playbackIter) {
            decoder.stopPlaybackIterator();
        }
        if (clip) {
            const st = this._vcache.get(clip.id);
            if (st) st.busy = false;
        }
    }

    // 判断某全局时间点是否存在 V1(底)+V2(顶) 同时可见（需≥2 层且两轨都有）
    _hasBothVideoLayers(globalTime) {
        const layers = this._getVideoLayersAt(globalTime);
        if (layers.length < 2) return false;
        const hasV1 = layers.some(l => l.track === "v1");
        const hasV2 = layers.some(l => l.track === "v2");
        return hasV1 && hasV2;
    }

    // ═══ 统一多轨合成内核（OpenCut 式：任意可见视频层，从底到顶逐层叠加，穿透属性在
    // _paintClipFrame 里按各 layer.clip 的 scale/opacity/crop/offset 自动生效）═══
    // frameResolver(layer) → Promise<{src,srcW,srcH}|null>：为某层取帧（底层 V1 可走顺序缓存，
    // 其余走 _renderLayerFrame）。播放路径要求 V1 用缓存以避免逐帧 seek，故取帧策略由调用方注入。
    // 展示语义：任一帧解码期间【保留上一次画面】，全部就绪后一次性清底+逐层绘制，避免黑/画面摇摆。
    // 返回 true 表示已合成绘制；false 表示无需合成（调用方走单层逻辑）。
    async _composeLayersAt(globalTime, frameResolver) {
        const layers = this._getVideoLayersAt(globalTime);
        if (layers.length < 2) return false;
        const frames = [];
        let failedAll = true;
        for (const layer of layers) {
            let fr = null;
            try { fr = frameResolver ? await frameResolver(layer) : null; } catch (_e) { fr = null; }
            frames.push({ layer, frame: fr });
            if (fr && fr.src) failedAll = false;
        }
        // 一层帧都没有就绪 → 本次不绘制（保留旧画面），避免整个黑屏
        if (failedAll) return false;
        return this._drawComposedFrames(frames);
    }

    // 统一绘制内核：清底 + 从底到顶逐层绘制，所有合成路径共用（杜绝多套"清底+循环"行为分裂）。
    _drawComposedFrames(frames) {
        if (!frames || !frames.length) return false;
        if (!frames.some(({ frame }) => frame && frame.src)) return false;
        this._syncPreviewCanvasSize();
        const canvas = this._canvas;
        const ctx = canvas.getContext("2d");
        if (!ctx) return false;
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        let painted = false;
        for (const { layer, frame } of frames) {
            if (!frame || !frame.src) continue;
            // layer.clip 携带 scale/opacity/crop/offset，_paintClipFrame 内自动应用 → 上层透明/裁剪即穿透露出下层
            this._paintClipFrame(ctx, canvas.width, canvas.height, frame.src, frame.srcW, frame.srcH, layer.clip);
            painted = true;
        }
        return painted;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // OpenCut 式统一时钟多轨渲染内核
    // 单一渲染入口 _renderTimelineFrame(gt)：任意全局时间点，取当前点所有可见视频/图片层，
    // 各自在对应 localTime 出帧，从底到顶统一合成。播放与 seek/拖动共用本内核，
    // 不再有「单活跃片段 + 重叠打补丁」的切换/回拨/独立 V1 缓存逻辑。
    // 视频层走「每片段独立顺序解码器 + 预取缓冲」（只由播放时钟推进），图片层直接取缓存。
    // ═══════════════════════════════════════════════════════════════════════════

    // 清空预览画布（空隙 / 纯音频区）
    _clearPreviewCanvas() {
        if (!this._canvas) return;
        this._syncPreviewCanvasSize();
        const ctx = this._canvas.getContext("2d");
        if (!ctx) return;
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, this._canvas.width, this._canvas.height);
    }

    // 统一渲染：渲染全局时间 gt 处所有可见视频/图片层，从底到顶合成。
    // 最新优先：若上一帧渲染仍在途，记录最新 gt 并在在途任务结束后接力绘制 → 保证跟手且不漏最新帧。
    // 图片层与视频层并行取帧；任一帧未就绪则保留旧画面，避免黑屏/摇摆。
    // 返回 true 表示已触发渲染；false 表示当前 gt 无视频层（调用方按语义处理空画面）。
    async _renderTimelineFrame(gt) {
        if (this._renderInFlight) { this._renderPendingGt = gt; return false; }
        this._renderInFlight = true;
        try {
            // 播放态：只渲染当前 gt 一帧，绝不回读/排空 _renderPendingGt 追赶。
            // 若在播放中靠「每 tick 写入的 pending + while 排空」，缓存热走后绘制速度会快于墙钟
            // （每轮都显示最新 gt，解码多快就显示多快），导致播放过几秒逐渐加速、与 1x 音频脱节。
            // 与 OpenCut 一致：每 tick 由同一时钟推进 gt，显示帧由 target=round(loc*fps)
            // 从 gt 推导，天然按 1x 节拍走（重复 tick 落到同帧号=同一帧，不产生多余新帧）。
            if (this._tlPlaying) {
                await this._renderLayersOnce(gt);
                return true;
            }
            // seek/拖动/刷新：可合并追赶最新 pending（只保留最新那次 seek，避免逐次拖动各自爆帧）
            let cur = gt;
            while (cur != null) {
                await this._renderLayersOnce(cur);
                cur = this._renderPendingGt; this._renderPendingGt = null;
            }
        } finally {
            this._renderInFlight = false;
            this._renderPendingGt = null;
        }
        return true;
    }

    // 渲染单个全局时间点 gt 的所有可见视频/图片层并合成（播放与 seek 共用的单帧内核）。
    // 无可见层则清空预览。有层但帧均未就绪（倒带重建迭代器 / 起播首帧解码中）→ 保留上一次画面，
    // 避免倒带或起播时黑屏闪烁；真正的空隙/纯音频（无任何层）在此统一清底。
    async _renderLayersOnce(gt) {
        const layers = this._getVideoLayersAt(gt);
        if (layers.length === 0) {
            this._clearPreviewCanvas();
            return;
        }
        // 与 OpenCut 的 VideoCache 一致：图片/视频层取帧统一为「读缓存为主 + 未命中才精解码」：
        // 图片层即时取帧；视频层命中预取 FrameCache 则零成本，拖动/倒带跨窗口才精解码一帧。不再逐帧硬解。
        // 每层配一个独占 canvas（视频层 seek 精确解码写入），多轨并发互不覆盖。
        const targets = layers.map(() => this._takeLayerCanvas());
        const jobs = layers.map((layer, i) =>
            this._frameForLayer(layer, targets[i]).then(f => f || null).catch(() => null)
        );
        const results = await Promise.all(jobs);
        const frames = [];
        for (let i = 0; i < layers.length; i++) {
            const f = results[i];
            if (f && f.src) frames.push({ layer: layers[i], frame: f });
        }
        if (frames.length) this._drawComposedFrames(frames);
        for (const c of targets) this._releaseLayerCanvas(c);
    }

    /**
     * 当用户修改了分辨率/切换了预设，立即刷新当前预览帧：
     *   - 有视频解码器 & 当前帧号 → 渲离屏再 letterbox 贴回
     *   - 有图片 Image → 重新 drawSourceToCanvas
     *   - 纯音频 → 重新画黑屏音乐符（此时 sync 了目标分辨率）
     */
    _refreshCurrentFrame() {
        this._syncPreviewCanvasSize();
        // 统一内核：任何可见视频/图片层（不含纯音频）都由此渲染。
        const layers = this._getVideoLayersAt(this._tlGlobalTime);
        if (layers.length > 0) {
            this._renderTimelineFrame(this._tlGlobalTime);
            return;
        }
        // 纯音频（无视频层）→ 音乐符占位 / 纯黑
        const clip = this._currentClip;
        const found = this._findClipByGlobalTime(this._tlGlobalTime);
        const c = found ? found.clip : clip;
        if (!c) return;
        const media = this.mediaLibrary.find(m => m.name === c.filename && m.type === c.type);
        if (this._modeFilter === "audio") {
            this._clearCanvasBlack();
        } else {
            const isAudioOnly = c.kind === "audio" || media?.isAudio || media?.info?.audio_only === true;
            if (isAudioOnly) { this._clearCanvasForAudio(); return; }
            this._clearPreviewCanvas();
        }
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
        // 播放头位置变化 → 同步选中该位置的片段（激活轨道优先，未激活时最上层片段）
        this._syncSelectionToPlayhead();
        const total = this._getTimelineTotalDuration();
        // 播放中拖动播放头：把统一时钟基准重置到新位置，使播放从此处连续推进
        if (this._tlPlaying) {
            this._playClockStart = performance.now();
            this._playClockGt = this._tlGlobalTime;
        }
        if (total <= 0) return;
        const found = this._findClipByGlobalTime(this._tlGlobalTime);
        // 纯音频点（无任何视频层）：音频占位；视频层由统一内核渲染（此处无视频层）
        const vLayers = this._getVideoLayersAt(this._tlGlobalTime);
        if (vLayers.length === 0) {
            if (found && found.clip.kind === "audio" &&
                (!this._currentClip || this._currentClip.id !== found.clip.id)) {
                this._currentClip = found.clip;
                this._currentDecoder = null;
                this._clearCanvasForAudio();
                this._decodeStandaloneAudio(found.clip.filename, found.clip.type).then(buf => {
                    if (buf && this._currentClip && this._currentClip.id === found.clip.id) {
                        this._audioBuffers[found.clip.id] = buf;
                    }
                }).catch(e => console.warn("[小珠光] 音频预解码失败:", e));
                return;
            }
            if (this._modeFilter === "audio" && found &&
                (!this._currentClip || this._currentClip.id !== found.clip.id)) {
                this._currentClip = found.clip;
                this._currentDecoder = null;
                this._clearCanvasBlack();
            } else {
                this._clearPreviewCanvas();
            }
            return;
        }
        // 统一内核：渲染当前 gt 处所有可见视频/图片层（含跨轨穿透），播放与 seek 共用。
        this._renderTimelineFrame(this._tlGlobalTime);
    }

    // 拖动播放头时的 RAF 节流（合并 mousemove 到每帧一次）
    _scheduleScrubSeek(globalTime) {
        // 仅保留下限0，去除上限，允许播放头自由拖动到内容区域外
        this._tlGlobalTime = Math.max(0, globalTime);
        this._updatePlayhead();
        this._updateTimeDisplay();
        // 播放头位置变化 → 同步选中该位置的片段（激活轨道优先，未激活时最上层片段）
        this._syncSelectionToPlayhead();
        if (this._scrubRafId) return;
        this._scrubRafId = requestAnimationFrame(() => {
            this._scrubRafId = null;
            // 延迟读取 _tlGlobalTime，确保用最新值
            const gt = this._tlGlobalTime;
            const found = this._findClipByGlobalTime(gt);
            // 纯音频点（无任何视频层）：音频占位；视频层由统一内核渲染
            const vLayers = this._getVideoLayersAt(gt);
            if (vLayers.length === 0) {
                if (found && found.clip.kind === "audio" &&
                    (!this._currentClip || this._currentClip.id !== found.clip.id)) {
                    this._currentClip = found.clip;
                    this._currentDecoder = null;
                    this._clearCanvasForAudio();
                } else {
                    this._clearPreviewCanvas();
                }
                return;
            }
            // 统一内核：拖动/seek 渲染当前 gt 所有可见层（含跨轨穿透）
            this._renderTimelineFrame(gt);
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
            // 统一时钟播放：不再按单片段切换加载，统一循环每 tick 渲染当前 gt 的所有可见层。
            this._startPlaybackLoop();
            this._startAudioPlayback();
        } else {
            this._updatePlayBtn(false);
            this._stopPlaybackLoop();
            this._stopAudio();
        }
    }

    // rAF 驱动的统一播放循环（OpenCut 单时钟多轨模型）：
    // 用一个共享时钟按墙钟推进全局时间，每 tick 调用 _renderTimelineFrame(gt) 渲染
    // 当前时间点所有可见视频/图片层，从底到顶合成。不再按「单活跃片段」切换加载，
    // 因此没有按帧切片段、重叠打补丁、逐片段 seek 等导致的不稳定。
    // 视频/图片层取帧统一走「对当前时间随机取帧 + FrameCache」，与 OpenCut 的 VideoCache 一致。
    _startPlaybackLoop() {
        this._stopPlaybackLoop();
        const total = this._getTimelineTotalDuration();
        const startGt = Math.min(Math.max(0, this._tlGlobalTime), Math.max(0, total));
        this._playClockStart = performance.now();
        this._playClockGt = startGt;
        let lastT = performance.now();
        let lastGt = startGt;

        const loop = () => {
            if (!this._tlPlaying) { this._playbackRaf = 0; return; }
            const now = performance.now();
            // E8: 后台标签恢复时 RAF 间隔过大，重置基准避免快进追赶
            if (now - lastT > 500) {
                this._playClockStart = now - ((lastGt - this._playClockGt) * 1000);
            }
            const gt = this._playClockGt + ((now - this._playClockStart) / 1000);
            lastT = now;
            lastGt = gt;
            const prevGt = this._tlGlobalTime;
            this._tlGlobalTime = gt;
            this._renderTimelineFrame(gt);   // 统一内核：当前 gt 所有层
            this._checkAudioBoundary(prevGt, gt);
            this._updatePlayhead();
            this._updateTimeDisplay();
            this._autoScrollToPlayhead();
            this._syncSelectionToPlayhead();
            // 已到（或超过）总时长 → 停止。总时长由最长轨道决定（音频尾部也计入）。
            if (gt >= total - 0.001) {
                this._tlGlobalTime = total;
                this._updatePlayhead();
                this._updateTimeDisplay();
                this._tlPlaying = false;
                this._updatePlayBtn(false);
                this._stopPlaybackLoop();
                this._stopAudio();
                this._playbackRaf = 0;
                return;
            }
            this._playbackRaf = requestAnimationFrame(loop);
        };
        this._playbackRaf = requestAnimationFrame(loop);
    }


    _stopPlaybackLoop() {
        if (this._playbackRaf) {
            cancelAnimationFrame(this._playbackRaf);
            this._playbackRaf = 0;
        }
        // 关键：显式关闭旧迭代器并释放 sink。
        // 若仅置 null，mediabunny 的 canvases() 迭代器仍占用 sink，
        // 后续合成层的 getCanvas() 随机寻址渲染会全部失败（V1 底层画面无法绘制），
        // 且在途的 _fillPlaybackBuffer 会把旧片段的帧污染进新片段的播放缓冲，
        // 导致新片段帧永远弹不出、播放头冻结在新片段头部。
        if (this._playbackIterator) {
            try {
                const r = this._playbackIterator.return?.();
                if (r && typeof r.then === "function") r.catch(() => {});
            } catch (_) {}
            this._playbackIterator = null;
        }
        if (this._playbackDecoder && typeof this._playbackDecoder.stopPlaybackIterator === "function") {
            this._playbackDecoder.stopPlaybackIterator();
        }
        this._playbackDecoder = null;
        this._compositeV1Cache = null;
        this._playbackIteratorDone = false;
        this._playbackBuffer = [];
        this._isBuffering = false;
        this._lastShownFrame = null;
        // VideoCache 预解码：停止播放时释放所有预取迭代器占用的 sink（不关闭 decoder，decoder 共享复用），
        // 使接下来的 seek/单帧预览 readFrameCached 能随机寻址解码；同时清空预解码状态。
        for (const st of this._vcache.values()) {
            st.busy = false;
            if (st.decoder && st.decoder._playbackIter) {
                try { st.decoder.stopPlaybackIterator(); } catch (_) {}
            }
        }
        this._vcache.clear();
        // 与 OpenCut 一致：取帧走 VideoCache「读 FrameCache + 未命中才精解码」。
        this._renderInFlight = false;
        this._renderPendingGt = null;
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

    // 检测音频片段边界变化：仅在片段开始/结束时调用 _startAudioPlayback，避免频繁调用干扰音频线程
    _checkAudioBoundary(prevGt, currGt) {
        if (prevGt === currGt) return;
        for (let i = 0; i < this.timeline.length; i++) {
            const c = this.timeline[i];
            if (c.kind !== "audio") continue;
            const dur = c.end - c.start;
            if (dur <= 0) continue;
            const cs = c.audioTlStart != null ? c.audioTlStart : 0;
            const ce = cs + dur;
            // 检测是否跨越了片段的起始或结束边界
            if ((prevGt < cs && currGt >= cs) || (prevGt < ce && currGt >= ce)) {
                this._startAudioPlayback();
                return;
            }
        }
    }

    async _startAudioPlayback() {
        // 多源混音：找到当前时间点所有活跃的 kind=audio 独立片段，同时播放
        const gt = this._tlGlobalTime;
        const activeClips = [];
        for (let i = 0; i < this.timeline.length; i++) {
            const c = this.timeline[i];
            if (c.kind !== "audio") continue;
            const dur = c.end - c.start;
            if (dur <= 0) continue;
            const cs = c.audioTlStart != null ? c.audioTlStart : 0;
            const ce = cs + dur;
            if (gt >= cs && gt < ce) {
                activeClips.push(c);
            }
        }
        // 停止已不再活跃的音频源
        const activeIds = new Set(activeClips.map(c => c.id));
        for (const [id, src] of Object.entries(this._audioSources)) {
            if (!activeIds.has(id)) {
                try { src.source.stop(); } catch (_) {}
                delete this._audioSources[id];
            }
        }
        this._ensureAudioContext();
        // 预解码：提前解码即将在 0.3s 内开始的音频片段，减少切换延迟
        const lookahead = gt + 0.3;
        for (let i = 0; i < this.timeline.length; i++) {
            const c = this.timeline[i];
            if (c.kind !== "audio") continue;
            const dur = c.end - c.start;
            if (dur <= 0) continue;
            const cs = c.audioTlStart != null ? c.audioTlStart : 0;
            if (cs > gt && cs < lookahead && !this._audioBuffers[c.id] && !activeIds.has(c.id)) {
                // 去重：同一片段已有解码在途（含预解码和活跃解码），跳过避免并发 decodeAudioData 干扰音频线程
                if (this._audioDecodePending && this._audioDecodePending.has(c.id)) continue;
                if (!this._audioDecodePending) this._audioDecodePending = new Set();
                this._audioDecodePending.add(c.id);
                // 异步预解码，不阻塞当前帧
                this._decodeStandaloneAudio(c.filename, c.type).then(buf => {
                    if (buf) this._audioBuffers[c.id] = buf;
                }).catch(() => {}).finally(() => {
                    this._audioDecodePending.delete(c.id);
                });
            }
        }
        // 为每个活跃片段启动音频源（已播放的跳过）
        for (const clip of activeClips) {
            if (this._audioSources[clip.id]) continue;  // 已在播放
            // 解码音频缓冲
            if (!this._audioBuffers[clip.id]) {
                // 去重：同一片段已有解码在途，跳过避免并发重复创建 source
                if (this._audioDecodePending && this._audioDecodePending.has(clip.id)) continue;
                if (!this._audioDecodePending) this._audioDecodePending = new Set();
                this._audioDecodePending.add(clip.id);
                try {
                    this._audioBuffers[clip.id] = await this._decodeStandaloneAudio(clip.filename, clip.type);
                } catch (e) {
                    console.warn("[xzg-ve] 独立音频解码失败:", clip.filename, e.message);
                    continue;
                } finally {
                    this._audioDecodePending.delete(clip.id);
                }
            }
            // await 后重新检查：并发的另一波调用可能已启动此片段的 source
            if (this._audioSources[clip.id]) continue;
            const buffer = this._audioBuffers[clip.id];
            if (!buffer) continue;
            const offset = clip.audioTlStart != null ? clip.audioTlStart : 0;
            const localTime = clip.start + (gt - offset);
            const clampedLocal = Math.max(clip.start, Math.min(clip.end - 0.001, localTime));
            const source = this._audioCtx.createBufferSource();
            source.buffer = buffer;
            // 每个片段独立的音量增益（应用 clip.volume）
            const gain = this._audioCtx.createGain();
            gain.gain.value = (clip.volume != null ? clip.volume : 1);
            source.connect(gain);
            gain.connect(this._audioGain);
            source.start(0, clampedLocal, clip.end - clampedLocal);
            this._audioSources[clip.id] = { source, gain, buffer, startTime: this._audioCtx.currentTime, startOffset: clampedLocal };
        }
        // 完全没有活跃片段 → 静音
        if (activeClips.length === 0) {
            this._stopAudioSource();
        }
    }

    _stopAudioSource(clipId) {
        if (clipId != null) {
            const src = this._audioSources[clipId];
            if (src) {
                try { src.source.stop(); } catch (_) {}
                try { src.gain && src.gain.disconnect(); } catch (_) {}
                delete this._audioSources[clipId];
            }
        } else {
            for (const [id, src] of Object.entries(this._audioSources)) {
                try { src.source.stop(); } catch (_) {}
                try { src.gain && src.gain.disconnect(); } catch (_) {}
                delete this._audioSources[id];
            }
        }
    }

    _stopAudio() {
        this._stopAudioSource();  // 停止所有音频源
        this._audioBuffers = {};  // 清空所有缓冲
    }

    _updatePlayhead() {
        const pxPerSec = this._getPxPerSec();
        // 播放头位置 = 左侧占位 + 时间×pxPerSec - 滚动偏移
        let x = this._tlLeftPad + this._tlGlobalTime * pxPerSec - this._tlScrollLeft;
        // 下限：左侧占位区分界线（不随滚动变化，占位区是 fixed 不滚动的）
        x = Math.max(x, this._tlLeftPad);
        this._playhead.style.left = Math.round(x) + "px";
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
        // 帧数 = 时间 × fps（取当前片段帧率，无则用 30）
        const fps = this._currentClip ? this._getClipFps(this._currentClip) : 30;
        // 时间码格式 MM:SS:FF（帧号 0 到 fps-1，到 fps 进位到秒）
        const fmtTC = (s) => {
            if (!isFinite(s) || s < 0) s = 0;
            const totalFrames = Math.round(s * fps);
            const m = Math.floor(totalFrames / (fps * 60));
            const sec = Math.floor(totalFrames / fps) % 60;
            const ff = totalFrames % fps;
            return `${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}:${ff.toString().padStart(2, "0")}`;
        };
        this._timeLabel.textContent = `${fmtTC(this._tlGlobalTime)} / ${fmtTC(total)}`;
        // 总帧数：后端 probe 已用 frame_count 反算精确 duration，故 round(total * fps) 无浮点误差
        const totalFrames = Math.max(1, Math.round(total * fps));
        // 帧号 0-based：最左侧=0，最右侧=totalFrames
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
        // 音频加载器模式：不查找媒体 fps，直接回退 30（摒弃视频干扰）
        if (this._modeFilter === "audio") return 30;
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
        // 磁吸：播放头吸附到各轨道片段的头尾（受磁铁开关控制）
        if (this._magnetEnabled) {
            const SNAP_SEC = 15 / pxPerSec;
            let best = null, bestDist = SNAP_SEC;
            if (Math.abs(tt - 0) < bestDist) { best = 0; bestDist = Math.abs(tt - 0); } // 时间轴起点
            for (const c of this.timeline) {
                const left = this._getClipTlStart(c);
                const right = left + (c.end - c.start);
                if (Math.abs(tt - left) < bestDist) { best = left; bestDist = Math.abs(tt - left); }
                if (Math.abs(tt - right) < bestDist) { best = right; bestDist = Math.abs(tt - right); }
            }
            if (best != null) tt = Math.max(0, best);
        }
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
        if (e.button !== 0) return;  // 只接受左键，右键保留给菜单
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
        // V1 + V2 所有视频片段元素（不同轨道容器统一遍历）
        const videoTracks = [this._tlTrack, this._tlV2TopTrack].filter(Boolean);
        for (const t of videoTracks) {
            for (const el of t.querySelectorAll(".xzg-ve-clip")) {
                const id = parseInt(el.dataset.clipId);
                if (this.selectedClipIds.has(id)) {
                    el.classList.add("xzg-ve-selected");
                } else {
                    el.classList.remove("xzg-ve-selected");
                }
            }
        }
        // 同步音频轨道（A1 + A2）波形元素的选中态
        const audioTracks = [this._tlAudioTrack, this._tlV2BotTrack].filter(Boolean);
        for (const t of audioTracks) {
            for (const el of t.querySelectorAll(".xzg-ve-audio-clip")) {
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
    //  轨道空隙选中（单轨道操作）
    //  点击轨道空白处选中两片段之间的空隙，Delete 后空隙后方片段前移贴合
    // ═══════════════════════════════════════════════════════════

    // 收集指定轨道上所有已定位片段（按时间排序），返回 [{clip, start, end}]
    // 轨道归属与渲染规则一致：视频 track==="v2"→V2 否则 V1；音频 track==="a2"→A2 否则 A1
    _getTrackClips(track) {
        const arr = [];
        for (const clip of this.timeline) {
            const dur = clip.end - clip.start;
            if (dur <= 0) continue;
            if (clip.kind === "audio") {
                if (clip.audioTlStart == null) continue;
                const onA2 = clip.track === "a2";
                if ((track === "a1" && !onA2) || (track === "a2" && onA2)) {
                    arr.push({ clip, start: clip.audioTlStart, end: clip.audioTlStart + dur });
                }
            } else {
                if (clip.tlStart == null) continue;
                const onV2 = clip.track === "v2";
                if ((track === "v1" && !onV2) || (track === "v2" && onV2)) {
                    arr.push({ clip, start: clip.tlStart, end: clip.tlStart + dur });
                }
            }
        }
        arr.sort((a, b) => a.start - b.start);
        return arr;
    }

    // 点击轨道空白处：尝试选中该位置的空隙（两片段之间 / 起点到首片段之间）
    // 未命中空隙则保持清空选中（与原"点击空白清空选中"行为兼容）
    _trySelectGapAt(clientX, clientY, e) {
        // Ctrl/Meta+点击：保留已有选中（原框选语义），不做空隙选中
        if (e && (e.ctrlKey || e.metaKey)) return;
        if (!this._timeline) return;
        const tlRect = this._timeline.getBoundingClientRect();
        // 左侧 150px 功能区与 35px 刻度区不响应
        if (clientX < tlRect.left + this._tlLeftPad) return;
        if (clientY < tlRect.top + 35) return;
        // 根据 Y 确定轨道（与 _yToTrack 相同的分区规则）
        const relY = clientY - tlRect.top - 35;
        const v2tH = this._tlV2TopHeight || 0;
        const vH = this._tlVideoHeight || 0;
        const aH = this._tlAudioHeight || 0;
        const v1End = v2tH + vH;
        const a1Start = v1End + 5;
        const a1End = a1Start + aH;
        let track = null;
        if (relY < v2tH) track = "v2";
        else if (relY < v1End) track = "v1";
        else if (relY < a1Start) return;   // 5px 粗分割线：不响应
        else if (relY < a1End) track = "a1";
        else track = "a2";
        // 加载器限定模式 / 双击轨道头视图模式下隐藏轨道不响应
        const viewMode = this._tlViewMode || "both";
        const isVideoTrack = track === "v1" || track === "v2";
        if (isVideoTrack && (this._modeFilter === "audio" || viewMode === "audio")) return;
        if (!isVideoTrack && (this._modeFilter === "video" || viewMode === "video")) return;
        // X → 时间（与 _mouseXToGlobalTime 同参考系，不做磁吸）
        const pxPerSec = this._getPxPerSec();
        if (pxPerSec <= 0) return;
        const x = clientX - (tlRect.left + this._tlLeftPad) + this._tlScrollLeft;
        const t = Math.max(0, x / pxPerSec);
        // 在该轨道上查找空隙
        const clips = this._getTrackClips(track);
        if (clips.length === 0) return;   // 空轨道无空隙
        let gap = null;
        // 前导空隙：0 → 首片段起点
        if (t < clips[0].start && clips[0].start > 0) {
            gap = { track, start: 0, end: clips[0].start };
        } else {
            // 中间空隙：片段 i 的 end → 片段 i+1 的 start
            for (let i = 0; i < clips.length - 1; i++) {
                if (t >= clips[i].end && t < clips[i + 1].start) {
                    gap = { track, start: clips[i].end, end: clips[i + 1].start };
                    break;
                }
            }
        }
        // 尾部空隙（最后片段之后）不可选：后方无片段，删除无意义
        // 忽略半帧以内的极小空隙（浮点误差产生的假空隙）
        const fps = this._getTimelineFps();
        const minGap = fps > 0 ? 0.5 / fps : 0.001;
        if (gap && gap.end - gap.start > minGap) {
            this._selectedGap = gap;
            this._renderGapSelection();
            const tn = { v1: "V1", v2: "V2", a1: "A1", a2: "A2" }[track];
            this._setStatus(`已选中 ${tn} 轨道空隙 ${_fmtTime(gap.start)} → ${_fmtTime(gap.end)}，按 Delete 删除并前移后方片段`);
        }
    }

    // 渲染空隙选中框（金色虚线，与拖动预览框同风格）
    // 每次渲染校验空隙仍然有效（片段拖动/删除后空隙可能消失或移位），过期则清空选中
    _renderGapSelection() {
        // 移除旧框
        if (this._gapSelEl) { this._gapSelEl.remove(); this._gapSelEl = null; }
        const gap = this._selectedGap;
        if (!gap) return;
        // 轨道隐藏（视图模式切换）时清空选中，避免不可见状态误删
        const mode = this._tlViewMode || "both";
        const isVideoTrack = gap.track === "v1" || gap.track === "v2";
        const trackVisible = isVideoTrack ? (mode !== "audio") : (mode !== "video");
        // 校验空隙与当前片段布局一致：边界必须精确对应某对相邻片段的交界（半帧容差）
        const fps = this._getTimelineFps();
        const eps = fps > 0 ? 0.5 / fps : 0.001;
        const clips = this._getTrackClips(gap.track);
        let valid = trackVisible && clips.length > 0;
        if (valid) {
            const near = (a, b) => Math.abs(a - b) <= eps;
            let matched = false;
            // 前导空隙：0 → 首片段起点
            if (near(gap.start, 0) && near(gap.end, clips[0].start)) matched = true;
            // 中间空隙：片段 i 的 end → 片段 i+1 的 start
            for (let i = 0; i < clips.length - 1 && !matched; i++) {
                if (near(clips[i].end, gap.start) && near(clips[i + 1].start, gap.end)) matched = true;
            }
            valid = matched;
        }
        if (!valid) { this._selectedGap = null; return; }
        const trackEl = {
            v1: this._tlTrack, v2: this._tlV2TopTrack,
            a1: this._tlAudioTrack, a2: this._tlV2BotTrack,
        }[gap.track];
        if (!trackEl) return;
        const pxPerSec = this._getPxPerSec();
        if (pxPerSec <= 0) return;
        const el = document.createElement("div");
        el.className = "xzg-ve-gap-sel";
        el.style.left = `${gap.start * pxPerSec}px`;
        el.style.width = `${Math.max(4, (gap.end - gap.start) * pxPerSec)}px`;
        trackEl.appendChild(el);
        this._gapSelEl = el;
    }

    // 清空空隙选中（数据 + DOM）
    _clearGapSelection() {
        this._selectedGap = null;
        if (this._gapSelEl) { this._gapSelEl.remove(); this._gapSelEl = null; }
    }

    // 删除选中空隙：该轨道上空隙后方（起点 ≥ 空隙终点）的片段整体前移贴合
    // 单轨道操作：其他轨道（含配对音轨）不受影响
    _deleteSelectedGap() {
        const gap = this._selectedGap;
        if (!gap) return;
        const shift = gap.end - gap.start;
        // 帧对齐量化（与 _clientXToTlStart 一致），半帧容差判定边界
        const fps = this._getTimelineFps();
        const q = (v) => (fps > 0 ? Math.round(v * fps) / fps : v);
        const eps = fps > 0 ? 0.5 / fps : 0.001;
        let moved = 0;
        for (const clip of this.timeline) {
            let pos = null;
            let onTrack = false;
            if (clip.kind === "audio") {
                onTrack = (gap.track === "a1" && clip.track !== "a2") || (gap.track === "a2" && clip.track === "a2");
                pos = clip.audioTlStart;
            } else {
                onTrack = (gap.track === "v1" && clip.track !== "v2") || (gap.track === "v2" && clip.track === "v2");
                pos = clip.tlStart;
            }
            if (!onTrack || pos == null) continue;
            // 仅移动起点在空隙终点之后（含恰好贴合）的片段
            if (pos >= gap.end - eps) {
                const newPos = Math.max(0, q(pos - shift));
                if (clip.kind === "audio") clip.audioTlStart = newPos;
                else clip.tlStart = newPos;
                moved++;
            }
        }
        const tn = { v1: "V1", v2: "V2", a1: "A1", a2: "A2" }[gap.track];
        this._clearGapSelection();
        if (moved > 0) {
            this._saveTimelineSession();
            this._setStatus(`已删除 ${tn} 轨道空隙（${_fmtTime(shift)}），${moved} 个片段前移贴合`);
        } else {
            this._setStatus(`空隙后方无片段，${tn} 轨道未变化`);
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  属性面板
    // ═══════════════════════════════════════════════════════════
    _renderProps() {
        const c = this._propsContent;
        c.innerHTML = "";
        // 自动切换标签：当前标签类型无选中片段，而另一类型有选中时，切到有选中的类型
        const allSel = this.timeline.filter(cl => this.selectedClipIds.has(cl.id));
        if (allSel.length > 0) {
            const hasVideo = allSel.some(cl => cl.kind !== "audio");
            const hasAudio = allSel.some(cl => cl.kind === "audio");
            if (this._propsTab === "audio" && !hasAudio && hasVideo) this._propsTab = "video";
            else if (this._propsTab === "video" && !hasVideo && hasAudio) this._propsTab = "audio";
        }
        // 按当前标签过滤选中片段
        const selClips = allSel.filter(cl =>
            (this._propsTab === "audio") ? (cl.kind === "audio") : (cl.kind !== "audio"));
        this._syncPropsTabs();
        if (selClips.length === 0) {
            _el("div", "", "未选中片段", c);
            return;
        }
        if (selClips.length > 1) {
            _el("div", "xzg-ve-prop-row", null, c);
            _el("div", "xzg-ve-prop-label", `已选中 ${selClips.length} 个片段`, c).style.color = "#fff";
            const totalDur = selClips.reduce((s, cl) => s + (cl.end - cl.start), 0);
            _el("div", "", `总时长 ${_fmtTime(totalDur)}`, c).style.color = "#fff";
            const delBtn = _el("button", "xzg-ve-btn", "🗑 删除选中", c);
            delBtn.style.width = "100%";
            delBtn.style.marginTop = "6px";
            delBtn.style.background = "#5a2a2a";
            delBtn.onclick = () => {
                // 只删除当前标签类型下的选中片段
                const ids = selClips.map(cl => cl.id);
                for (const id of ids) {
                    const idx = this.timeline.findIndex(cl => cl.id === id);
                    if (idx >= 0) this.timeline.splice(idx, 1);
                }
                for (const id of ids) this.selectedClipIds.delete(id);
                this._renderTimeline();
                this._renderProps();
                this._setStatus(`已删除 ${ids.length} 个片段`);
            };
            return;
        }
        const clip = selClips[0];
        if (clip.kind === "audio") {
            // 音频片段：只显示 音量调节
            this._renderAudioVolumeControl(c, clip);
        } else {
            // 视频片段：只显示 大小 / 移动 / 裁剪 / 透明度
            this._renderVideoTransformControls(c, clip);
        }
    }

    // 音频片段音量调节（预览即时生效）
    _renderAudioVolumeControl(c, clip) {
        const row = _el("div", "xzg-ve-prop-row", null, c);
        _el("div", "xzg-ve-prop-label", "音量", row);
        const wrap = _el("div", "xzg-ve-prop-range-wrap", null, row);
        const slider = _el("input", "xzg-ve-prop-range", null, wrap);
        slider.type = "range";
        slider.min = "0";
        slider.max = "2";
        slider.step = "0.05";
        const vol = (clip.volume != null ? clip.volume : 1);
        slider.value = String(vol);
        const fmt = (v) => v.toFixed(2);
        const valSpan = _el("span", "xzg-ve-prop-range-val", fmt(vol), wrap);
        const applyVol = (v) => {
            clip.volume = Math.max(0, Math.min(2, v));
            this._saveTimelineSession();
            // 若该片段正在播放，实时更新其增益
            const src = this._audioSources[clip.id];
            if (src && src.gain) src.gain.gain.value = clip.volume;
            // 实时预览：波形幅度随音量变化
            this._refreshWaveformVolume(clip);
        };
        // 值偏离默认值 1 时滑条变红
        const applyColor = () => {
            const v = parseFloat(slider.value);
            slider.classList.toggle("xzg-ve-prop-range-changed", Math.abs(v - 1) > 0.001);
        };
        applyColor();
        // 音量滑条：原生 range 拖动（默认行为）
        slider.addEventListener("input", () => {
            valSpan.textContent = fmt(parseFloat(slider.value));
            applyVol(parseFloat(slider.value));
            applyColor();
        });
        // 重置按钮
        const resetBtn = _el("button", "xzg-ve-prop-reset", "↺", wrap);
        resetBtn.title = "重置";
        resetBtn.addEventListener("click", () => {
            slider.value = "1";
            valSpan.textContent = "1.00";
            applyVol(1);
            applyColor();
        });
    }

    // 视频片段变换控件：大小调节、裁剪（可折叠）、透明度（预览即时生效）
    _renderVideoTransformControls(c, clip) {
        // 滑条：parent 为可选的父容器（默认属性内容区）；defaultVal 用于滑条的重置按钮
        // fineDrag：true 时启用 Alt+拖动精调（相对增量），其他滑条保持原生 range 默认行为
        const makeSlider = (label, min, max, step, val, onChange, parent, defaultVal, fineDrag) => {
            const host = parent || c;
            const row = _el("div", "xzg-ve-prop-row", null, host);
            _el("div", "xzg-ve-prop-label", label, row);
            const wrap = _el("div", "xzg-ve-prop-range-wrap", null, row);
            const slider = _el("input", "xzg-ve-prop-range", null, wrap);
            slider.type = "range";
            slider.min = String(min);
            slider.max = String(max);
            slider.step = String(step);
            slider.value = String(val);
            const baseStep = step;
            const defaultV = defaultVal != null ? defaultVal : min;
            const fmt = (v) => v.toFixed(baseStep < 0.1 ? 2 : 1);
            const valSpan = _el("span", "xzg-ve-prop-range-val", fmt(val), wrap);
            // 值偏离默认值时滑条变红（提示该参数被修改过）
            const applyColor = () => {
                const v = parseFloat(slider.value);
                const diff = Math.abs(v - defaultV);
                const tol = Math.max(baseStep / 2, 0.0001);
                slider.classList.toggle("xzg-ve-prop-range-changed", diff > tol);
            };
            applyColor();
            if (fineDrag) {
                // 仅移动水平/垂直：手动控制，按住 Alt 时位移降为 20%（提高精细度）
                slider.addEventListener("pointerdown", (e) => {
                    e.preventDefault();
                    this._activeRange = slider;
                    const startCX = e.clientX;
                    const startVal = parseFloat(slider.value);
                    const snap = (v) => {
                        let s = min + Math.round((v - min) / baseStep) * baseStep;
                        return Math.max(min, Math.min(max, Math.round(s * 100000) / 100000));
                    };
                    const onMove = (ev) => {
                        if (this._activeRange !== slider) return;
                        const factor = ev.altKey ? 0.2 : 1;
                        const ratio = (ev.clientX - startCX) * factor / Math.max(slider.getBoundingClientRect().width, 1);
                        const nv = snap(startVal + ratio * (max - min));
                        slider.value = String(nv);
                        const v = parseFloat(slider.value);
                        onChange(v);
                        valSpan.textContent = fmt(v);
                        applyColor();
                    };
                    const cleanup = () => {
                        document.removeEventListener("pointermove", onMove, true);
                        document.removeEventListener("pointerup", onUp, true);
                        this._activeRange = null;
                    };
                    const onUp = () => cleanup();
                    document.addEventListener("pointermove", onMove, true);
                    document.addEventListener("pointerup", onUp, true);
                });
            }
            // 原生 range 拖动（其余滑条）→ input 事件
            slider.addEventListener("input", () => {
                const v = parseFloat(slider.value);
                onChange(v);
                valSpan.textContent = fmt(v);
                applyColor();
            });
            // 重置按钮：重置回默认值
            const resetBtn = _el("button", "xzg-ve-prop-reset", "↺", wrap);
            resetBtn.title = "重置";
            resetBtn.addEventListener("click", () => {
                const d = defaultVal != null ? defaultVal : min;
                slider.value = String(d);
                valSpan.textContent = fmt(d);
                onChange(d);
                applyColor();
            });
            return { slider, valSpan, row, resetBtn };
        };
        const refresh = () => {
            this._saveTimelineSession();
            // 确保当前加载的是被修改的片段，再刷新预览（含多轨合成），保证拖动时实时显示
            if (!this._currentClip || this._currentClip.id !== clip.id) {
                const tlStart = this._getClipTlStart(clip) || 0;
                const localTime = clip.start + (this._tlGlobalTime - tlStart);
                this._loadClipAtTime(clip, Math.max(0, localTime), false);
            } else {
                this._refreshCurrentFrame();
            }
        };
        // 大小调节（默认 1；步进 0.01 提高精度）
        makeSlider("大小", 0.1, 3, 0.01, clip.scale || 1, (v) => {
            clip.scale = v;
            refresh();
        }, null, 1);
        // 移动：水平/垂直像素偏移（直接显示，不折叠；默认 0，范围 ±2000px，每次最小 1；Alt+拖动精调）
        makeSlider("移动水平", -2000, 2000, 1, clip.offsetX || 0, (v) => {
            clip.offsetX = v;
            refresh();
        }, null, 0, true);
        makeSlider("移动垂直", -2000, 2000, 1, clip.offsetY || 0, (v) => {
            clip.offsetY = v;
            refresh();
        }, null, 0, true);
        // 裁剪：左/右/上/下（直接显示，不折叠；被裁掉的比例，视频大小与位置不变；默认 0）
        makeSlider("裁剪左", 0, 1, 0.01, clip.cropLeft || 0, (v) => {
            clip.cropLeft = v;
            refresh();
        }, null, 0);
        makeSlider("裁剪右", 0, 1, 0.01, clip.cropRight || 0, (v) => {
            clip.cropRight = v;
            refresh();
        }, null, 0);
        makeSlider("裁剪上", 0, 1, 0.01, clip.cropTop || 0, (v) => {
            clip.cropTop = v;
            refresh();
        }, null, 0);
        makeSlider("裁剪下", 0, 1, 0.01, clip.cropBottom || 0, (v) => {
            clip.cropBottom = v;
            refresh();
        }, null, 0);
        // 透明度（默认 1）
        makeSlider("透明度", 0, 1, 0.05, clip.opacity != null ? clip.opacity : 1, (v) => {
            clip.opacity = v;
            refresh();
        }, null, 1);
        // 重置按钮
        const resetRow = _el("div", "xzg-ve-prop-row", null, c);
        const resetBtn = _el("button", "xzg-ve-btn", "重置视频变换", resetRow);
        resetBtn.style.width = "100%";
        resetBtn.style.fontSize = "16px";
        resetBtn.style.color = "#e04848";
        resetBtn.style.fontWeight = "bold";
        resetBtn.onclick = () => {
            clip.scale = 1; clip.offsetX = 0; clip.offsetY = 0;
            clip.cropLeft = 0; clip.cropRight = 0;
            clip.cropTop = 0; clip.cropBottom = 0; clip.opacity = 1;
            this._renderProps();
            refresh();
        };
    }

    // 同步属性面板「视频/音频」标签的激活态
    _syncPropsTabs() {
        if (!this._propsTabs) return;
        const tabs = this._propsTabs.querySelectorAll(".xzg-ve-props-tab");
        for (const t of tabs) {
            const active = t.dataset.type === this._propsTab;
            t.classList.toggle("xzg-ve-props-tab-active", active);
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  导出
    // ═══════════════════════════════════════════════════════════
    async _exportFrame() {
        // 弹出对话框选择导出模式（仅支持输出目录/自定义目录，不支持另存为）
        const hasCustomDir = !!(this._baseDir);
        const mode = await _xzgVeFrameExportDialog(hasCustomDir);
        if (!mode) return;  // 用户取消

        // 有旗标时：批量导出每个旗标所在帧
        if (this._markerFlags.length > 0) {
            await this._exportFramesAtFlags(mode);
            return;
        }
        if (!this._currentDecoder || !this._currentClip) {
            this._setStatus("无视频播放");
            return;
        }
        // E5: 全局时间 → 片段本地时间（后端需要源视频内的时间戳）
        const offset = this._getClipTlStart(this._currentClip);
        const localTime = this._currentClip.start + (this._tlGlobalTime - offset);
        const t = Math.max(0, localTime);
        this._setStatus(`导出 ${_fmtTime(t)} 处单帧...`);
        const isCustom = (mode === "custom");
        const payload = {
            filename: this._currentClip.filename,
            type: this._currentClip.type,
            time: t,
            small: false,
            use_default_output: !isCustom,
            output_mode: mode,
        };
        if (isCustom) {
            payload.base_dir = this._baseDir || "";
            payload.filename_prefix = this._filenamePrefix || "xzg-edit";
            payload.add_date_stamp = this._addDateStamp;
            payload.add_time_stamp = this._addTimeStamp;
            if (!this._baseDir) {
                this._setStatus("请先点击\"输出目录设置\"选择输出目录");
                return;
            }
        }
        try {
            const data = await _postJson(API_EXTRACT, payload);
            if (data.error) throw new Error(data.error);
            const display = data.filename || "(未命名)";
            if (data.type === "output") {
                const sub = data.subfolder ? `/${data.subfolder}` : "";
                this._setStatus(`✅ 已导出静帧: output${sub}/${display}`);
            } else if (data.type === "absolute") {
                this._setStatus(`✅ 已导出静帧: ${display}`);
            } else {
                this._setStatus(`已导出静帧: ${display}`);
            }
        } catch (e) {
            this._setStatus(`导出失败: ${e.message}`);
        }
    }

    // 批量导出所有旗标位置的帧
    async _exportFramesAtFlags(mode) {
        const flags = this._markerFlags;
        if (flags.length === 0) return;
        const isCustom = (mode === "custom");
        if (isCustom && !this._baseDir) {
            this._setStatus("请先点击\"输出目录设置\"选择输出目录");
            return;
        }
        let success = 0;
        let failed = 0;
        for (let i = 0; i < flags.length; i++) {
            const f = flags[i];
            this._setStatus(`导出旗标 ${i + 1}/${flags.length} (${_fmtTime(f.time)})...`);
            const found = this._findClipByGlobalTime(f.time);
            if (!found || found.clip.kind === "audio") {
                failed++;
                continue;
            }
            const clip = found.clip;
            const offset = this._getClipTlStart(clip);
            const localTime = clip.start + (f.time - offset);
            const t = Math.max(0, localTime);
            const payload = {
                filename: clip.filename,
                type: clip.type,
                time: t,
                small: false,
                use_default_output: !isCustom,
                output_mode: mode,
            };
            if (isCustom) {
                payload.base_dir = this._baseDir || "";
                payload.filename_prefix = this._filenamePrefix || "xzg-edit";
                payload.add_date_stamp = this._addDateStamp;
                payload.add_time_stamp = this._addTimeStamp;
            }
            try {
                const data = await _postJson(API_EXTRACT, payload);
                if (data.error) throw new Error(data.error);
                // 批量导出：静默保存到 output 目录，不弹另存为对话框
                success++;
            } catch (e) {
                failed++;
                console.warn("[小珠光] 旗标导出失败:", e);
            }
        }
        this._setStatus(`✅ 旗标导出完成: ${success} 成功${failed > 0 ? `, ${failed} 失败` : ""}`);
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
            // 同步预览外观比例与 canvas 内部分辨率 = 首片段分辨率
            this._syncPreviewCanvasSize();
            // 持久化到渲染设置，供 silentRender（加载器快速导出）保持一致
            if (typeof this._persistRenderRes === 'function') this._persistRenderRes();
            // 如果此时已有渲染到 canvas 的当前帧（比如拖入后立即播放/seek），重新按目标比例 letterbox 画一次
            if (this._currentClip) this._refreshCurrentFrame();
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

    // ═══════════════════════════════════════════════════════════
    //  渲染参数构造 + 格式（video/audio）辅助
    // ═══════════════════════════════════════════════════════════
    _buildTimelineData() {
        return _buildTimelineData(this.timeline);
    }

    /**
     * 构造渲染参数（_render / _cancel / silentRender 共用）
     * @param {'default'|'saveas'|'custom'|null} forceMode 覆盖输出模式（_cancel 传 'default'：固定 output 目录）
     * @returns { renderOpts: object, mode: string, audioOnly: boolean, audioFormat: string|null, isCustom: boolean, bitrateOrQuality: string }
     */
    _buildRenderOpts(forceMode = null) {
        const tlData = this._buildTimelineData();
        const renderOpts = { timeline: tlData };

        // 输出目录设置（三种模式）
        let mode = forceMode || this._outputMode || "default";
        const isCustom = (mode === "custom");
        renderOpts.use_default_output = !isCustom;
        renderOpts.output_mode = mode;
        if (isCustom) {
            renderOpts.base_dir = this._baseDir || "";
            renderOpts.filename_prefix = this._filenamePrefix || "xzg-edit";
            renderOpts.add_date_stamp = this._addDateStamp;
            renderOpts.add_time_stamp = this._addTimeStamp;
        }
        // 帧率 + 分辨率
        let targetFps = 0;
        if (this.timeline.length > 0) {
            targetFps = this._getClipFps(this.timeline[0]);
            if (targetFps > 0) renderOpts.target_fps = targetFps;
        }
        const wInput = this._root?.querySelector(".xzg-ve-render-w");
        const hInput = this._root?.querySelector(".xzg-ve-render-h");
        const tw = Math.max(0, Math.round(Number(wInput?.value || 0)));
        const th = Math.max(0, Math.round(Number(hInput?.value || 0)));
        if (tw > 0 && th > 0) { renderOpts.target_width = tw; renderOpts.target_height = th; }
        // 持久化快剪界面分辨率/帧率，供 silentRender（加载器快速导出）保持一致
        this._persistRenderRes();

        // 格式 + 质量/比特率
        const formatSel = this._root?.querySelector(".xzg-ve-format-select");
        const fmt = (formatSel && formatSel.value) || "video-mp4";
        const audioOnly = fmt.startsWith("audio-");
        const audioFormat = audioOnly ? fmt.slice("audio-".length) : null;
        renderOpts.audio_only = audioOnly;
        if (audioOnly && audioFormat) {
            renderOpts.audio_format = audioFormat;
            // 比特率：FLAC/WAV 下拉被禁用，默认 128 也行（后端忽略）
            const qSel = this._root?.querySelector(".xzg-ve-quality-select");
            renderOpts.audio_bitrate = (qSel && qSel.value) ? String(qSel.value) : "320";
        } else {
            // 视频模式：quality 传 high/medium/low
            const qSel = this._root?.querySelector(".xzg-ve-quality-select");
            if (qSel && qSel.value) renderOpts.quality = qSel.value;
        }

        return {
            renderOpts, mode,
            audioOnly, audioFormat,
            isCustom,
            bitrateOrQuality: renderOpts.quality || renderOpts.audio_bitrate || "",
        };
    }

    // 把快剪界面当前的分辨率/帧率持久化，供 silentRender（加载器快速导出）保持一致
    _persistRenderRes() {
        const wInput = this._root?.querySelector(".xzg-ve-render-w");
        const hInput = this._root?.querySelector(".xzg-ve-render-h");
        const fpsInput = this._root?.querySelector(".xzg-ve-render-fps");
        const tw = Math.max(0, Math.round(Number(wInput?.value || 0)));
        const th = Math.max(0, Math.round(Number(hInput?.value || 0)));
        const fps = Math.max(0, Number(fpsInput?.value || 0));
        try {
            localStorage.setItem(XZG_VE_RENDER_SETTINGS_KEY, JSON.stringify({ tw, th, fps }));
        } catch (_) {}
    }

    async _render() {
        if (this.timeline.length === 0) {
            this._setStatus("时间线为空");
            return;
        }
        const btn = this._root.querySelector(".xzg-ve-btn-apply");
        btn.disabled = true;
        btn.textContent = "导出中...";
        // 构造渲染参数（_cancel / silentRender 复用同一方法）
        const { renderOpts, mode, audioOnly, audioFormat, isCustom } = this._buildRenderOpts();
        if (isCustom && !this._baseDir) {
            this._setStatus("请先点击\"输出目录设置\"选择输出目录");
            btn.disabled = false;
            btn.textContent = "导出";
            return;
        }
        const tlCount = renderOpts.timeline ? renderOpts.timeline.length : 0;
        const kindLabel = audioOnly ? `音频 ${(audioFormat || "").toUpperCase()}` : "视频 MP4";
        this._setStatus(`正在导出 ${kindLabel} · ${tlCount} 个片段...`);
        try {
            const data = await _postJson(API_RENDER, renderOpts);
            if (data.error) throw new Error(data.error);
            const saveasAudioOnly = audioOnly && (data.audio_only || data.extension && data.extension !== "mp4");
            // saveas 模式：使用 File System Access API 弹出另存为对话框
            //   视频走 downloadVideo（记忆 xzg_video），音频走 downloadAudio（记忆 xzg_audio）
            if (mode === "saveas" && data.filename) {
                try {
                    const fname = data.filename;
                    const rawName = fname.split("/").pop() || (saveasAudioOnly ? "xzg-edit.mp3" : "xzg-edit.mp4");
                    const viewSub = data.subfolder ? `&subfolder=${encodeURIComponent(data.subfolder)}` : "";
                    const viewUrl = api.apiURL(
                        `/view?filename=${encodeURIComponent(fname)}&type=${encodeURIComponent(data.type || "output")}${viewSub}${app.getRandParam()}`
                    );
                    if (saveasAudioOnly) {
                        await downloadAudio(viewUrl, rawName);
                    } else {
                        await downloadVideo(viewUrl, rawName);
                    }
                    this._setStatus(`✅ 已导出${saveasAudioOnly ? "音频" : ""}: ${rawName} （另存为完成）`);
                } catch (dlErr) {
                    if (dlErr?.name === "AbortError") {
                        this._setStatus(`已导出${saveasAudioOnly ? "音频" : ""}: ${data.filename} （用户取消另存为，文件已保存到 ComfyUI output 目录）`);
                    } else {
                        console.warn("[小珠光] 另存为失败，文件已保存到 output 目录:", dlErr);
                        this._setStatus(`✅ 已导出${saveasAudioOnly ? "音频" : ""}: ${data.filename} （保存到 ComfyUI output 目录）`);
                    }
                }
            } else {
                let locLabel;
                if (mode === "default") locLabel = "ComfyUI output 目录";
                else locLabel = this._baseDir || "output 目录";
                this._setStatus(`✅ 已导出${saveasAudioOnly ? "音频" : ""}: ${data.filename} （保存到 ${locLabel}）`);
            }
            // 通知外部（视频加载器 / 音频加载器等注册的回调），与静默导出一致
            if (typeof window._xzgOnVideoEditorExport === 'function') {
                try {
                    // 新：传完整 data（加载器根据 audio_only 字段消费）
                    window._xzgOnVideoEditorExport(data);
                    // 兼容旧签名：当回调用 (filename, type) 形式时确保能被正确接收
                    if (window._xzgOnVideoEditorExport.length >= 2) {
                        window._xzgOnVideoEditorExport(data.filename, data.type || "output");
                    }
                }
                catch (e) { console.warn("[小珠光] 导出回调异常:", e); }
            }
            // 如果本实例有 confirmCallback（从加载器等打开），也通知一下
            if (this._confirmCallback && !this._confirmCallbackCalled) {
                this._confirmCallbackCalled = true;
                try {
                    // 与全局回调相同：传完整 data（加载器根据 audio_only / video 字段消费）
                    this._confirmCallback(data);
                } catch (_) {}
            }
            btn.disabled = false;
            btn.textContent = "导出";
        } catch (e) {
            this._setStatus(`导出失败: ${e.message}`);
            btn.disabled = false;
            btn.textContent = "导出";
        }
    }

    async _cancel() {
        // 有回调 → 来自视频加载器/音频加载器：点"确认"执行导出并回传，再关闭
        // 无回调 → 直接打开：点"确认"仅关闭窗口
        if (this._confirmCallback) {
            const cancelBtn = this._root?.querySelector(".xzg-ve-btn-cancel");
            if (this.timeline.length === 0) {
                this._setStatus("时间线为空");
                this._confirmCallbackCalled = true;
                try { this._confirmCallback({ error: "快剪时间线为空，请先添加片段" }); } catch (_) {}
                this.close();
                return;
            }
            // 按钮进入加载态
            if (cancelBtn) { cancelBtn.disabled = true; cancelBtn.textContent = "确认中..."; }
            try {
                // 使用输出目录固定 default（保证文件一定在 ComfyUI output 中，加载器/view 都能访问）
                const { renderOpts, audioOnly, audioFormat } = this._buildRenderOpts("default");
                const kindLabel = audioOnly ? `音频 ${(audioFormat || "").toUpperCase()}` : "视频 MP4";
                this._setStatus(`正在为确认回调导出 ${kindLabel}...`);
                const data = await _postJson(API_RENDER, renderOpts);
                if (data.error) throw new Error(data.error);
                // 调用外部回调（视频/音频加载器注册的接收函数）——传完整 data
                if (typeof window._xzgOnVideoEditorExport === 'function') {
                    try { window._xzgOnVideoEditorExport(data); }
                    catch (e) { console.warn("[小珠光] 导出回调异常:", e); }
                }
                // 调用实例回调
                this._confirmCallbackCalled = true;
                try { this._confirmCallback(data); } catch (_) {}
                this.close();
            } catch (e) {
                this._setStatus(`确认导出失败: ${e.message}`);
                if (cancelBtn) { cancelBtn.disabled = false; cancelBtn.textContent = "确认"; }
                this._confirmCallbackCalled = true;
                try { this._confirmCallback({ error: e.message }); } catch (_) {}
            }
        } else {
            // 直接打开 → 仅关闭
            this.close();
        }
    }

    // 保存输出目录设置到 localStorage
    _saveOutputSettings() {
        try {
            localStorage.setItem(this._xzgVeOutputKey, JSON.stringify({
                output_mode: this._outputMode,
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

// ═══════════════════════════════════════════════════════════════
//  全局辅助：从 timeline 片段列表构造带时间定位的渲染数据
// （类方法 _buildTimelineData / 静默导出 silentRender 都用它）
// ═══════════════════════════════════════════════════════════════
function _buildTimelineData(timeline) {
    const videoClipsSorted = [...timeline].filter(c => c.kind !== "audio")
        .sort((a, b) => {
            const at = a.tlStart != null ? a.tlStart : Infinity;
            const bt = b.tlStart != null ? b.tlStart : Infinity;
            return at - bt;
        });
    const audioClipsSorted = [...timeline].filter(c => c.kind === "audio")
        .sort((a, b) => {
            const at = a.audioTlStart != null ? a.audioTlStart : Infinity;
            const bt = b.audioTlStart != null ? b.audioTlStart : Infinity;
            return at - bt;
        });
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
    for (const c of timeline) {
        const dur = c.end - c.start;
        if (c.kind === "audio") {
            let ts;
            if (c.audioTlStart != null) { ts = c.audioTlStart; accAudio = Math.max(accAudio, ts + dur); }
            else { ts = accAudio >= baseEndAudio ? accAudio : baseEndAudio; if (ts < accAudio) ts = accAudio; accAudio = ts + dur; }
            tlData.push({
                filename: c.filename, type: c.type, start: c.start, end: c.end,
                kind: "audio", tlStart: ts, track: c.track || "a1",
                volume: c.volume != null ? c.volume : 1,
            });
        } else {
            let ts;
            if (c.tlStart != null) { ts = c.tlStart; accVideo = Math.max(accVideo, ts + dur); }
            else { ts = accVideo >= baseEndVideo ? accVideo : baseEndVideo; if (ts < accVideo) ts = accVideo; accVideo = ts + dur; }
            const vEntry = {
                filename: c.filename, type: c.type, start: c.start, end: c.end,
                kind: "video", tlStart: ts, track: c.track || "v1",
            };
            if (c.skip_audio === true) vEntry.skip_audio = true;
            // 视频变换属性（大小/移动/裁剪/透明度）透传给后端
            vEntry.scale = c.scale != null ? c.scale : 1;
            vEntry.offsetX = c.offsetX != null ? c.offsetX : 0;
            vEntry.offsetY = c.offsetY != null ? c.offsetY : 0;
            vEntry.cropLeft = c.cropLeft != null ? c.cropLeft : 0;
            vEntry.cropRight = c.cropRight != null ? c.cropRight : 0;
            vEntry.cropTop = c.cropTop != null ? c.cropTop : 0;
            vEntry.cropBottom = c.cropBottom != null ? c.cropBottom : 0;
            vEntry.opacity = c.opacity != null ? c.opacity : 1;
            tlData.push(vEntry);
        }
    }
    return tlData;
}

// ═══════════════════════════════════════════════════════════════
//  静默导出：供视频加载器等外部调用，不打开编辑器界面
//  从 localStorage 读取时间线数据，直接调用后端渲染 API
//  成功后调用 window._xzgOnVideoEditorExport?.(filename, type)
// ═══════════════════════════════════════════════════════════════
async function _xzgVideoEditorSilentRender() {
    const timeline = _xzgVeGetSessionTimeline();
    if (!timeline || timeline.length === 0) {
        return { error: "快剪时间线为空，请先在快剪编辑器中添加片段" };
    }

    // 构造渲染数据（复用 _buildTimelineData 与 _render/_cancel 完全一致）
    const tlData = _buildTimelineData(timeline);

    // 从 localStorage 读取最后一次输出设置（格式/质量），与编辑器保持一致
    let audioOnly = false, audioFormat = "mp3", audioBitrate = "320", quality = "medium";
    try {
        const raw = localStorage.getItem(XZG_VE_SESSION_KEY);
        if (raw) {
            const obj = JSON.parse(raw) || {};
            audioOnly = !!obj.audio_only;
            audioFormat = obj.audio_format || "mp3";
            audioBitrate = obj.audio_bitrate || "320";
            quality = obj.quality || "medium";
        }
    } catch (_) {}

    // 渲染参数：强制 default 模式（保存到 ComfyUI output 目录）
    // 分辨率/帧率跟随快剪界面设置（编辑器导出时持久化），无则后端用源视频参数
    const renderOpts = {
        timeline: tlData,
        use_default_output: true,
        output_mode: "default",
    };
    try {
        const rs = JSON.parse(localStorage.getItem(XZG_VE_RENDER_SETTINGS_KEY) || "{}");
        const rw = Math.max(0, Math.round(Number(rs.tw || 0)));
        const rh = Math.max(0, Math.round(Number(rs.th || 0)));
        if (rw > 0 && rh > 0) { renderOpts.target_width = rw; renderOpts.target_height = rh; }
        const rf = Math.max(0, Number(rs.fps || 0));
        if (rf > 0) renderOpts.target_fps = rf;
    } catch (_) {}
    if (audioOnly) {
        renderOpts.audio_only = true;
        renderOpts.audio_format = audioFormat;
        if (audioFormat === "mp3") renderOpts.audio_bitrate = audioBitrate;
    } else {
        renderOpts.quality = quality;
    }

    try {
        const data = await _postJson(API_RENDER, renderOpts);
        if (data.error) throw new Error(data.error);
        // 调用外部回调（视频/音频加载器等注册的接收函数）——传完整 data
        if (typeof window._xzgOnVideoEditorExport === 'function') {
            try { window._xzgOnVideoEditorExport(data); }
            catch (e) { console.warn("[小珠光] 导出回调异常:", e); }
        }
        return data;
    } catch (e) {
        console.warn("[小珠光] 静默导出失败:", e);
        return { error: e.message };
    }
}

// 暴露到 window 供外部调用
window._xzgVideoEditor = {
    silentRender: _xzgVideoEditorSilentRender,
};

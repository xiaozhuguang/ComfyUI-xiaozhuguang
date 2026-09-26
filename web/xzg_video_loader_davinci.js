import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
    bindVideoLoaderInteractions,
    _applyWidgetStyles,
    _xzgCreateNumberWidget,
    _xzgCreateComboWidget,
} from "./xzg_video_loader.js";

// 小珠光视频加载-化神级（XiaozhuguangVideoLoaderDaVinci）
// 复用「小珠光视频加载器」全部交互（播放器预览 / 上传 / 视频下拉 / 快剪联动等），
// 额外新增「加载视频」按钮，通过后端路由触达本机 DaVinci Resolve Studio，
// 把剪辑页当前播放头所在片段自动导出为视频并加载到本节点。
const DAVINCI_NODE = "XiaozhuguangVideoLoaderDaVinci";
function _videoLoaderDavinciKey(node) {
    const parts = (node?.graph?.nodes || []).filter(n => n?.id != null && n.type).map(n => `${n.id}:${n.type}`).sort();
    let h = 5381;
    for (const part of parts) for (let i = 0; i < part.length; i++) h = ((h << 5) + h + part.charCodeAt(i)) >>> 0;
    return `xzg_video_loader_davinci_${h}_${node?.id ?? ""}`;
}
function _restoreVideoLoaderDavinciTarget(node) {
    try {
        const value = JSON.parse(localStorage.getItem(_videoLoaderDavinciKey(node)));
        if (value?.directory) {
            node._xzgVideoDavinciSession = value.session || "";
            node._xzgVideoDavinciOutputDir = value.directory;
            node._xzgVideoDavinciOutputName = value.filename || "";
        }
    } catch (_) {}
}

const _tr = (s) => s;

// 达芬奇专用三瓣图标：三瓣同尺寸、彼此以窄缝分隔，不使用 emoji 或方向箭头。
const _CLAPPER_SVG =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none"' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"' +
    'style="display:block">' +
    '<path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z"/>' +
    '<path d="m6.2 5.3 3.1 3.9"/>' +
    '<path d="m12.4 3.4 3.1 4"/>' +
    '<path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>' +
    '</svg>';

function _davinciCloverIcon() {
    const styleId = "xzg-davinci-clover-style";
    if (!document.getElementById(styleId)) {
        const style = document.createElement("style");
        style.id = styleId;
        style.textContent = `
            .xzg-davinci-clover { position:relative; display:inline-block; width:16px; height:15px; flex:0 0 16px; }
            .xzg-davinci-clover > i { position:absolute; width:8px; height:8px; box-sizing:border-box; border-radius:50%; box-shadow:inset 1px 1px 2px rgba(255,255,255,.42), 0 1px 1px rgba(0,0,0,.3); }
            .xzg-davinci-clover .xzg-dv-blue { top:0; left:4px; background:linear-gradient(135deg,#47e7ff,#22c9e9 45%,#3f91d7 78%,#d8f6b3); }
            .xzg-davinci-clover .xzg-dv-green { top:6.93px; left:0; background:linear-gradient(135deg,#fbf264,#dfee4c 52%,#9ac83a); }
            .xzg-davinci-clover .xzg-dv-red { top:6.93px; left:8px; background:linear-gradient(135deg,#f14c69,#ed5968 52%,#ee9250); }
            @keyframes xzg-davinci-clover-spin { to { transform:rotate(360deg); } }
            .xzg-davinci-clover.spinning { transform-origin:50% 50%; animation:xzg-davinci-clover-spin .8s linear infinite; }
        `;
        document.head.appendChild(style);
    }
    return '<span class="xzg-davinci-clover" aria-hidden="true"><i class="xzg-dv-blue"></i><i class="xzg-dv-green"></i><i class="xzg-dv-red"></i></span>';
}

function _toast(msg, isError = false) {
    const el = document.createElement("div");
    el.style.cssText =
        "position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:1000002;" +
        "padding:8px 16px;border-radius:6px;font-size:13px;color:#fff;" +
        "box-shadow:0 4px 16px rgba(0,0,0,.4);pointer-events:none;opacity:0;" +
        "transition:opacity .25s;max-width:80vw;word-break:break-all;";
    el.style.background = isError ? "rgba(198,40,40,.95)" : "rgba(30,30,30,.95)";
    if (isError) el.style.border = "1px solid #ef9a9a";
    el.textContent = msg;
    document.body.appendChild(el);
    requestAnimationFrame(() => {
        el.style.opacity = "1";
        setTimeout(() => {
            el.style.opacity = "0";
            setTimeout(() => el.remove(), 260);
        }, 3000);
    });
}

async function _davinciStatus(node) {
    try {
        const resp = await api.fetchApi("/xzg/davinci/status");
        if (!resp.ok) return { ok: false, error: `状态接口 ${resp.status}` };
        return await resp.json();
    } catch (e) {
        return { ok: false, error: String(e) };
    }
}

async function _davinciExport(node, busyBtn, labelSpan, label) {
    busyBtn.disabled = true;
    _setLoaderDavinciBusy(node, true, "准备从达芬奇加载…");
    labelSpan.textContent = "正在从达芬奇加载…";
    try {
        _setLoaderDavinciBusy(node, true, "正在从达芬奇加载…");
        const resp = await api.fetchApi("/xzg/davinci/export", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode: "video" }),
        });
        const data = await resp.json();
        if (!data?.ok) {
            _toast("[达芬奇导入] " + (data?.error || "导出失败"), true);
            return;
        }
        const selected = await _selectImportedVideo(node, data.filename);
        if (!selected) throw new Error("达芬奇已导出，但节点没有成功加载新视频；请检查 input 目录和视频文件");
        const clipName = data?.clip?.name;
        _toast(`已导入视频${clipName ? `「${clipName}」` : ""}`);
    } catch (e) {
        _toast("[达芬奇导入] " + String(e), true);
    } finally {
        _setLoaderDavinciBusy(node, false);
        busyBtn.disabled = false;
        labelSpan.textContent = label;
    }
}

async function _selectImportedVideo(node, filename) {
    if (!filename) return false;
    const w = node.widgets?.find((x) => x.name === "视频");
    const player = node._xzgVideoPlayer;
    if (!w && !player?.load) return false;
    let values = [];
    try {
        const resp = await api.fetchApi("/object_info/" + DAVINCI_NODE);
        if (resp.ok) {
            const info = await resp.json();
            const list = info?.[DAVINCI_NODE]?.input?.required?.["视频"]?.[0];
            if (Array.isArray(list)) values = list.slice();
        }
    } catch (_) {}
    // object_info 可能在渲染刚完成时仍返回旧列表；精确加入本次产物，绝不退回旧视频。
    if (!values.includes(filename)) values.push(filename);
    if (w) {
        w.options = w.options || {};
        w.options.values = values;
        w.value = filename;
        try { w.callback?.(filename); } catch (e) { console.warn("[小珠光] 视频下拉刷新失败，继续直接加载导出文件", e); }
    }
    // 显式刷新播放器，避免 widget callback 在节点初始化重绑期间尚未接入播放器。
    if (player?.load) {
        const url = `/view?${new URLSearchParams({ filename, type: "input" })}&rand=${Math.random()}`;
        try { player.setPreviewLoaded?.(false); } catch (_) {}
        player.load(url);
    }
    node.setDirtyCanvas?.(true, true);
    return true;
}

async function _onImportClick(node, btn, labelSpan) {
    const st = await _davinciStatus(node);
    if (!st?.ok) {
        _toast(
            "[达芬奇导入] 无法连接达芬奇。" + (st?.error || "") +
            " 需 Resolve Studio 已打开，且偏好设置→系统配置→外部脚本使用设为「本地 Local」。",
            true
        );
        return;
    }
    if (!st.clip) {
        _toast("[达芬奇导入] 当前播放头下没有视频片段，请先在调色页/剪辑页把播放头置于要导出的片段上。", true);
        return;
    }
    await _davinciExport(node, btn, labelSpan, "达芬奇");
}

// 移除历史遗留的顶部「加载视频」widget 按钮（若有），避免与预览区按钮重复。
function _removeLegacyTopButton(node) {
    const old = node.widgets?.find((w) => w.name === "加载视频");
    if (!old) return;
    old.callback = null;
    try { node.removeWidget(old); } catch (_) {}
    if (node.setup && node.setup.seg && node.setup.seg.layout?.items) {
        try {
            node.setup.seg.layout.items = node.setup.seg.layout.items.filter(
                (it) => it.type !== "widget" || it.widget?.name !== "加载视频"
            );
        } catch (_) {}
    }
    try { old.dispose?.(); } catch (_) {}
}

// 在预览区内创建「从达芬奇导入」按钮，样式与「从快剪加载」一致并排其左；
// 鼠标进入预览区显示，离开隐藏。
function _createPreviewDavinciButton(node) {
    if (node._xzgDavinciBtn) return node._xzgDavinciBtn;
    const pc = node._xzgPreviewContainer;
    if (!pc) return null;
    const fastcutBtn = node._xzgFastcutBtn || null;

    const btn = document.createElement("button");
    btn.title = "从达芬奇剪辑页导出当前播放头所在片段并加载";
    btn.style.cssText =
        "position:absolute;top:6px;right:6px;z-index:102;" +
        "display:inline-flex;align-items:center;gap:4px;" +
        "height:22px;box-sizing:border-box;padding:2px 6px;font-size:11px;line-height:1;" +
        "background:transparent;color:#3ef558;border:none;" +
        "cursor:pointer;pointer-events:auto;" +
        "transition:color 0.15s,opacity 0.2s;opacity:0;";
    btn.innerHTML = `${_davinciCloverIcon()}<span>达芬奇</span>`;
    const labelSpan = btn.querySelector("span:last-child");
    pc.appendChild(btn);

    // 达芬奇贴预览区最右（cssText 已是 right:6px），「从快剪加载」排在它左侧
    const alignFastcut = () => {
        if (btn.offsetWidth > 0 && fastcutBtn) {
            fastcutBtn.style.right = (btn.offsetWidth + 12) + "px";
        }
    };
    const onOver = () => { alignFastcut(); btn.style.opacity = "1"; };
    const onOut = (e) => {
        if (!pc.contains(e.relatedTarget) && !btn.disabled) btn.style.opacity = "0";
    };
    pc.addEventListener("mouseover", onOver);
    pc.addEventListener("mouseout", onOut);

    btn.addEventListener("mouseenter", () => {
        if (btn.disabled) return;
        btn.style.color = "#fff";
        btn.querySelector(".xzg-davinci-clover")?.classList.add("spinning");
    });
    btn.addEventListener("mouseleave", () => {
        btn.style.color = "#3ef558";
        btn.querySelector(".xzg-davinci-clover")?.classList.remove("spinning");
    });
    btn.addEventListener("wheel", _forwardCanvasWheel, { passive: false });
    btn.onclick = () => { if (!btn.disabled) _onImportClick(node, btn, labelSpan); };

    node._xzgDavinciBtn = btn;
    return btn;
}

// 悬浮按钮属于 DOM 覆盖层；直接把滚轮交还 LiteGraph 画布，避免停在按钮上时无法缩放画布。
function _forwardCanvasWheel(e) {
    const canvas = app.canvas?.canvas;
    if (!canvas) return;
    e.preventDefault();
    e.stopPropagation();
    canvas.dispatchEvent(new WheelEvent("wheel", {
        deltaY: e.deltaY, deltaX: e.deltaX,
        clientX: e.clientX, clientY: e.clientY,
        ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey,
        bubbles: true, cancelable: true,
    }));
}

// 当前加载视频的来源信息。组合框默认来自 input，也兼容从 output/temp 拖入的带类型后缀文件名。
function _getLoadedVideoInfo(node) {
    const raw = String(node.widgets?.find((w) => w.name === "视频")?.value || "");
    if (!raw) return null;
    for (const [suffix, type] of [[" [output]", "output"], [" [input]", "input"], [" [temp]", "temp"]]) {
        if (raw.endsWith(suffix)) return { filename: raw.slice(0, -suffix.length), type };
    }
    return { filename: raw, type: "input" };
}

// 导出设置只由前端在点击「导出到达芬奇」时提交，不参与加载器的视频解码参数。
// 使用普通隐藏 widget 保持设置可随工作流保存，并复用图片/视频保存节点的目录选择弹窗。
function _hideOutputSettingWidget(w) {
    if (!w) return;
    w.type = "hidden";
    w.hidden = true;
    w.draw = () => {};
    w.computeSize = () => [0, 0];
    w.mouse = () => false;
}

function _ensureLoaderOutputSettings(node) {
    const find = (name) => node.widgets?.find(w => w.name === name);
    const add = (type, name, value) => node.addWidget(type, name, value, () => {});
    const defW = find("use_default_output") || add("toggle", "use_default_output", true);
    const baseW = find("base_dir") || add("text", "base_dir", "");
    const prefixW = find("文件名前缀") || add("text", "文件名前缀", "xzg-davinci");
    const dateW = find("add_date_stamp") || add("toggle", "add_date_stamp", false);
    const timeW = find("add_time_stamp") || add("toggle", "add_time_stamp", false);
    [defW, baseW, prefixW, dateW, timeW].forEach(_hideOutputSettingWidget);
    node._xzgDefaultOutputWidget = defW;
    node._xzgBaseDirWidget = baseW;
    node._xzgPrefixCustomWidget = prefixW;
    node._xzgDateStampWidget = dateW;
    node._xzgTimeStampWidget = timeW;
}

function _setLoaderDavinciBusy(node, busy, message = "") {
    const pc = node._xzgPreviewContainer;
    if (!pc) return;
    if (busy && !node._xzgDavinciBusyOverlay) {
        const overlay = document.createElement("div");
        overlay.style.cssText = "position:absolute;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.96);color:#f2fff3;font:bold clamp(20px,4vw,36px) sans-serif;text-shadow:0 2px 8px #000;pointer-events:auto;text-align:center;";
        pc.appendChild(overlay);
        node._xzgDavinciBusyOverlay = overlay;
    }
    if (busy) {
        node._xzgDavinciBusyOverlay.textContent = message || "准备导出…";
        node._xzgDavinciBusyOverlay.style.display = "flex";
        node._xzgDavinciActionBusy = true;
    } else {
        if (node._xzgDavinciBusyOverlay) node._xzgDavinciBusyOverlay.style.display = "none";
        node._xzgDavinciActionBusy = false;
    }
}

function _openLoaderOutputSettings(node) {
    if (typeof window._xzgShowDirBrowser !== "function") {
        _toast("输出设置弹窗不可用（图像保存模块未加载），请刷新页面重试。", true);
        return;
    }
    window._xzgShowDirBrowser(node);
}

function _layoutPreviewActions(node) {
    // 视觉左→右：从快剪加载 · 发送到快剪 · 输出设置 · 从达芬奇加载 · 导出到达芬奇。
    // 本数组按「右 → 左」（最右在前）排列：导出到达芬奇、从达芬奇加载、输出设置、发送到快剪、从快剪加载。
    const buttons = [
        node._xzgLoaderExportDavinciBtn,
        node._xzgDavinciBtn,
        node._xzgLoaderQuickCutBtn,
        node._xzgFastcutBtn,
    ].filter(Boolean);
    let right = 6;
    for (const btn of buttons) {
        btn.style.right = right + "px";
        right += (btn.offsetWidth || 0) + 6;
    }
}

async function _sendLoadedToQuickCut(node, btn, labelSpan) {
    const info = _getLoadedVideoInfo(node);
    if (!info?.filename) {
        _toast("[发送到快剪] 请先选择或上传视频。", true);
        return;
    }
    btn.disabled = true;
    labelSpan.textContent = "正在发送…";
    try {
        // 启动器会在按需加载快剪模块后转交真实媒体接收器。
        await window._xzgVideoEditorReceiveMedia(info.filename, info.type);
        _toast("已加入快剪媒体库（打开快剪即可拖入轨道使用）");
    } catch (e) {
        _toast("[发送到快剪] " + String(e), true);
    } finally {
        btn.disabled = false;
        labelSpan.textContent = "发送";
    }
}

async function _exportLoadedToDavinci(node, btn, labelSpan) {
    const info = _getLoadedVideoInfo(node);
    if (!info?.filename) {
        _toast("[导出到达芬奇] 请先选择或上传视频。", true);
        return;
    }
    btn.disabled = true;
    _setLoaderDavinciBusy(node, true, "准备导出…");
    try {
        const sessionResp = await api.fetchApi(`/xzg/davinci/video-export-session?_=${Date.now()}`, { cache: "no-store" });
        const sessionInfo = await sessionResp.json();
        if (!sessionResp.ok || !sessionInfo?.session) throw new Error(sessionInfo?.error || "无法确认 ComfyUI 会话状态");
        const session = sessionInfo.session;
        const sameSession = node._xzgVideoDavinciSession === session && !!node._xzgVideoDavinciOutputDir;
        const status = sameSession ? "正在导出到达芬奇…" : "选择保存位置…";
        _setLoaderDavinciBusy(node, true, status);
        labelSpan.textContent = status;
        const resp = await api.fetchApi("/xzg/davinci/loader-import", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...info,
                target_dir: sameSession ? node._xzgVideoDavinciOutputDir : "",
                target_name: sameSession ? node._xzgVideoDavinciOutputName : "",
            }),
        });
        // 反向代理/旧后端可能返回纯文本 404/405；不要把它伪装成 JSON 解析异常。
        const raw = await resp.text();
        let data;
        try {
            data = raw ? JSON.parse(raw) : {};
        } catch (_) {
            throw new Error(`接口响应 ${resp.status}: ${raw.slice(0, 180) || "（空响应）"}`);
        }
        if (!resp.ok) {
            throw new Error(data?.error || `接口响应 ${resp.status}`);
        }
        if (data?.save_directory) {
            node._xzgVideoDavinciSession = session;
            node._xzgVideoDavinciOutputDir = data.save_directory;
            node._xzgVideoDavinciOutputName = data.save_filename || node._xzgVideoDavinciOutputName;
            try { localStorage.setItem(_videoLoaderDavinciKey(node), JSON.stringify({ session, directory: data.save_directory, filename: node._xzgVideoDavinciOutputName || "" })); } catch (_) {}
        }
        if (data?.cancelled) return;
        if (!data?.ok) {
            _toast("[导出到达芬奇] " + (data?.error || "导入失败"), true);
            return;
        }
        if (data?.duplicate) {
            _toast("[导出到达芬奇] " + (data?.message || "该位置已存在相同片段，未重复导入"));
            return;
        }
        const clip = data.clip ? `「${data.clip}」` : "";
        const track = data.track != null ? `V${data.track}` : "";
        _toast(`已导出至达芬奇${clip} ${track} ${data.record_frame != null ? `@帧${data.record_frame}` : ""}`.trim());
    } catch (e) {
        _toast("[导出到达芬奇] " + String(e), true);
    } finally {
        _setLoaderDavinciBusy(node, false);
        btn.disabled = false;
        labelSpan.textContent = "导出";
    }
}

function _createLoaderActionButton(node, key, color, text, title, onClick, iconHtml = '<span style="font-size:13px;">🎬</span>') {
    if (node[key]) return node[key];
    const pc = node._xzgPreviewContainer;
    if (!pc) return null;
    const btn = document.createElement("button");
    btn.title = title;
    btn.style.cssText =
        "position:absolute;top:6px;right:6px;z-index:102;" +
        "display:inline-flex;align-items:center;gap:4px;height:22px;box-sizing:border-box;padding:2px 6px;font-size:11px;line-height:1;" +
        `background:transparent;color:${color};border:none;cursor:pointer;pointer-events:auto;` +
        "transition:color 0.15s,opacity 0.2s;opacity:0;";
    btn.innerHTML = `${iconHtml}<span>${text}</span>`;
    const clover = btn.querySelector(".xzg-davinci-clover");
    const labelSpan = btn.querySelector("span:last-child");
    pc.appendChild(btn);
    const _refreshVis = () => {
        if (node._xzgFastcutEditorOpen) { btn.style.opacity = "0"; return; }  // 快剪编辑器打开时全隐藏
        if (btn.disabled) { btn.style.opacity = "1"; return; }  // busy 按钮常显
        const anyBusy = ["_xzgLoaderQuickCutBtn","_xzgLoaderExportDavinciBtn","_xzgDavinciBtn"].some(k => node[k]?.disabled);
        btn.style.opacity = anyBusy ? "0" : (pc.matches(":hover") ? "1" : btn.style.opacity);
    };
    const onOver = () => { _layoutPreviewActions(node); _refreshVis(); };
    const onOut = (e) => { if (!pc.contains(e.relatedTarget)) btn.style.opacity = "0"; };
    pc.addEventListener("mouseover", onOver);
    pc.addEventListener("mouseout", onOut);
    btn.addEventListener("mouseenter", () => {
        if (btn.disabled) return;
        btn.style.color = "#fff";
        clover?.classList.add("spinning");
    });
    btn.addEventListener("mouseleave", () => {
        btn.style.color = color;
        clover?.classList.remove("spinning");
    });
    btn.addEventListener("wheel", _forwardCanvasWheel, { passive: false });
    btn.onclick = () => { if (!btn.disabled) onClick(btn, labelSpan); };
    node[key] = btn;
    requestAnimationFrame(() => _layoutPreviewActions(node));
    return btn;
}

function _createLoaderQuickCutButton(node) {
    return _createLoaderActionButton(
        node, "_xzgLoaderQuickCutBtn", "#ffd76a", "发送",
        "把当前加载的视频发送到快剪媒体库（打开快剪后可手动拖入轨道使用）",
        (btn, label) => _sendLoadedToQuickCut(node, btn, label),
        _CLAPPER_SVG
    );
}

function _createLoaderExportDavinciButton(node) {
    return _createLoaderActionButton(
        node, "_xzgLoaderExportDavinciBtn", "#3ef558", "导出",
        "把当前加载的视频导入达芬奇（进媒体池 + 复用空白轨道/无则新建 + 对齐播放头片段前端）",
        (btn, label) => _exportLoadedToDavinci(node, btn, label),
        _davinciCloverIcon()
    );
}

function _createLoaderOutputSettingsButton(node) {
    return _createLoaderActionButton(
        node, "_xzgLoaderOutSettingsBtn", "#8ab4f8", "设置",
        "设置导出到达芬奇前的视频副本目录、文件名前缀与日期/时间戳",
        () => _openLoaderOutputSettings(node),
        '<span style="font-size:13px;line-height:1;">⚙</span>'
    );
}

app.registerExtension({
    name: "Xiaozhuguang.VideoLoader.DaVinci",
    getCustomWidgets() {
        return {
            XZGINT: (node, name, data) => _xzgCreateNumberWidget(node, name, data),
            XZGFLOAT: (node, name, data) => _xzgCreateNumberWidget(node, name, data),
            XZGCOMBO: (node, name, data) => _xzgCreateComboWidget(node, name, data),
        };
    },
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== DAVINCI_NODE) return;
        {
            // 与加载器一致的 widgetType 注入（数值/下拉走小珠光自定义控件，绕过原生 combo）
            if (nodeData.input?.required?.["强制帧率"]) {
                nodeData.input.required["强制帧率"][1].widgetType = "XZGFLOAT";
            }
            for (const [k, inp] of Object.entries({ ...nodeData.input?.required, ...nodeData.input?.optional })) {
                if (!inp || !inp[1]) continue;
                if (["INT", "FLOAT"].includes(inp[0])) {
                    inp[1].widgetType ??= "XZG" + inp[0];
                } else if (Array.isArray(inp[0])) {
                    inp[1].widgetType ??= "XZGCOMBO";
                }
            }

            const correctOutputs = [_tr("图像"), _tr("音频"), _tr("视频信息")];
            if (nodeData.outputs && Array.isArray(nodeData.outputs)) {
                nodeData.outputs.forEach((out, i) => {
                    if (correctOutputs[i]) out.name = correctOutputs[i];
                });
            }
            if (nodeData.output_name && Array.isArray(nodeData.output_name)) {
                nodeData.output_name = nodeData.output_name.slice(0, correctOutputs.length)
                    .map((n, i) => correctOutputs[i] || n);
            }

            const origOnNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const r = origOnNodeCreated?.apply(this, arguments);
                requestAnimationFrame(() => _restoreVideoLoaderDavinciTarget(this));
                // 内存模式（低内存版功能并入）：由 widget 值动态决定 isLM，
                // 切换时通过 _xzgSetVideoLoaderMode 销毁重建播放器并重载当前视频。
                bindVideoLoaderInteractions(this, () => {
                    const mw = this.widgets?.find((w) => w.name === "内存模式");
                    return (mw?.value || "标准") === "低内存";
                }, { fastcut: true });
                // 化神级：最小宽度与默认宽度均为 500（基础加载器默认 300）
                this.minWidth = 360;
                this.setSize([360, Math.max(this.size?.[1] || 360, 360)]);
                // 钩住「内存模式」widget 变化：切换后重建播放器（XZGCOMBO 通过 _xzgCb 挂载回调）
                const _modeWidget = this.widgets?.find((w) => w.name === "内存模式");
                if (_modeWidget && !_modeWidget._xzgModeHooked) {
                    _modeWidget._xzgModeHooked = true;
                    const _origModeCb = _modeWidget._xzgCb;
                    _modeWidget._xzgCb = (v) => {
                        _origModeCb?.(v);
                        this._xzgSetVideoLoaderMode?.(v === "低内存");
                    };
                }
                _applyWidgetStyles(this);
                _removeLegacyTopButton(this);
                _createPreviewDavinciButton(this);
                _createLoaderExportDavinciButton(this);
                _createLoaderQuickCutButton(this);
                requestAnimationFrame(() => _layoutPreviewActions(this));
                if (this.outputs) {
                    this.outputs.forEach((out, i) => {
                        if (correctOutputs[i]) {
                            out.name = correctOutputs[i];
                            out.label = correctOutputs[i];
                        }
                    });
                }
                return r;
            };

            // 尺寸持久化修复：刷新浏览器后节点恢复默认大小。
            // 本节点有多个扩展环节（批处理编排器异步注入控件、达芬奇按钮等），异步注入
            // 发生在 configure 之后，可能把恢复好的尺寸重新覆盖为默认值。
            // onConfigure 收到的 data 即节点在工作流里的序列化数据（含用户保存的 size）。
            // 策略：加载后短时间内持续检测，一旦尺寸被异步初始化逻辑重置为默认值
            // （300×500 或 360×500）就按保存值恢复；用户手动拖拽后的尺寸不会被覆盖。
            const origOnConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function (data) {
                const r = origOnConfigure?.apply(this, arguments);
                try {
                    requestAnimationFrame(() => _restoreVideoLoaderDavinciTarget(this));
                    // 工作流加载后同步内存模式：widget 值恢复可能与当前播放器构建模式不一致（无变化时内部自动跳过）
                    const _mw = this.widgets?.find((w) => w.name === "内存模式");
                    if (_mw) this._xzgSetVideoLoaderMode?.((_mw.value || "标准") === "低内存");
                    const node = this;
                    if (Array.isArray(data?.size) && data.size[0] > 0 && data.size[1] > 0) {
                        const savedSize = [data.size[0], data.size[1]];
                        node.size = savedSize.slice();
                        let tries = 0;
                        const applySavedSize = () => {
                            try {
                                const s = node.size;
                                const isDefault = s && (
                                    (Math.round(s[0]) === 300 && Math.round(s[1]) === 500) ||
                                    (Math.round(s[0]) === 360 && Math.round(s[1]) === 500)
                                );
                                const savedIsDefault =
                                    (Math.round(savedSize[0]) === 300 && Math.round(savedSize[1]) === 500) ||
                                    (Math.round(savedSize[0]) === 360 && Math.round(savedSize[1]) === 500);
                                if (isDefault && !savedIsDefault) {
                                    node.size = savedSize.slice();
                                    node.setDirtyCanvas?.(true, true);
                                }
                            } catch (e) { /* ignore */ }
                            if (++tries < 20) setTimeout(applySavedSize, 100); // 持续约 2 秒
                        };
                        setTimeout(applySavedSize, 0);
                    }
                } catch (e) { /* ignore */ }
                return r;
            };

            const origOnDrawBackground = nodeType.prototype.onDrawBackground;
            nodeType.prototype.onDrawBackground = function (ctx) {
                if (this._xzgVideoPlayer && this._xzgUpdateBypassState) {
                    this._xzgUpdateBypassState();
                }
                return origOnDrawBackground?.apply(this, arguments);
            };
        }
    },
});

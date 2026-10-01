import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// 小珠光视频保存-化神级（XiaozhuguangVideoSaveDaVinci）
// 复用「小珠光视频保存」的全部交互（预览/缓存/恢复见父类 xzg_video_combine.js 注册器），
// 额外在预览区叠加「导出到达芬奇」悬浮按钮：把该节点最近一次保存的视频导入达芬奇
// （进当前媒体池 + 新建视频轨道 + 对齐播放头所在最上层片段前端，不推移/不分割）。
const SAVE_DAVINCI_NODE = "XiaozhuguangVideoSaveDaVinci";
const _videoDavinciTargetKey = (node) => {
    const parts = (node?.graph?.nodes || []).filter(n => n?.id != null && n.type)
        .map(n => `${n.id}:${n.type}`).sort();
    let h = 5381;
    for (const part of parts) for (let i = 0; i < part.length; i++) h = ((h << 5) + h + part.charCodeAt(i)) >>> 0;
    return `xzg_video_davinci_target_${h}_${node?.id ?? ""}`;
};
function _loadVideoDavinciTarget(node) {
    // 刷新浏览器后只恢复 session（用于判断 ComfyUI 是否重启），
    // 不恢复 directory/filename：否则会复用上次导出的旧目录和旧文件名，
    // 导致不弹文件夹选择对话框、且达芬奇里的文件名和 output 当前文件名对不上。
    try {
        const value = JSON.parse(localStorage.getItem(_videoDavinciTargetKey(node)));
        if (value?.session) {
            node._xzgVideoDavinciSession = value.session || "";
        }
    } catch (_) {}
}
function _saveVideoDavinciTarget(node, session, data) {
    try {
        localStorage.setItem(_videoDavinciTargetKey(node), JSON.stringify({
            session, directory: data.save_directory,
            filename: data.save_filename || node._xzgVideoDavinciOutputName || "",
        }));
    } catch (_) {}
}

const _tr = (s) => s;

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

// 悬浮按钮是 DOM 层，鼠标在按钮上时不会命中播放器的滚轮处理区。
// 显式转发给 LiteGraph 画布，保持与预览区域一致的缩放体验。
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

// 场记板（clapperboard）SVG 图标：stroke 用 currentColor，可随 CSS color 变色。
// emoji 🎬 由系统字体渲染、无法染色，故开关状态色改用此 SVG 呈现
const _CLAPPER_SVG =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
    'style="display:block">' +
    '<path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z"/>' +
    '<path d="m6.2 5.3 3.1 3.9"/>' +
    '<path d="m12.4 3.4 3.1 4"/>' +
    '<path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>' +
    '</svg>';

// 达芬奇四叶草开关图标：outline=true → 灰色线框（未激活）；否则彩色三叶草（已激活）
function _xzgDvToggleClover(outline) {
    const id = "xzg-dv-toggle-clover-style";
    if (!document.getElementById(id)) {
        const st = document.createElement("style");
        st.id = id;
        st.textContent =
            ".xzg-dv-tclover{position:relative;display:inline-block;width:16px;height:15px;flex:0 0 16px;vertical-align:middle;outline:none;box-shadow:none;}" +
            ".xzg-dv-tclover>i{position:absolute;width:8px;height:8px;box-sizing:border-box;border-radius:50%;}" +
            ".xzg-dv-tclover .c-blue{top:0;left:4px;background:linear-gradient(135deg,#47e7ff,#22c9e9 45%,#3f91d7 78%,#d8f6b3);}" +
            ".xzg-dv-tclover .c-green{top:6.93px;left:0;background:linear-gradient(135deg,#fbf264,#dfee4c 52%,#9ac83a);}" +
            ".xzg-dv-tclover .c-red{top:6.93px;left:8px;background:linear-gradient(135deg,#f14c69,#ed5968 52%,#ee9250);}" +
            "@keyframes xzg-dv-clover-spin{to{transform:rotate(360deg);}}" +
            ".xzg-dv-tclover.spinning{transform-origin:50% 50%;animation:xzg-dv-clover-spin .8s linear infinite;}" +
            ".xzg-dv-tclover.outline>i{background:transparent;border:1.3px solid #6b7280;}";
        document.head.appendChild(st);
    }
    return '<span class="xzg-dv-tclover' + (outline ? " outline" : "") + '" aria-hidden="true">' +
        '<i class="c-blue"></i><i class="c-green"></i><i class="c-red"></i></span>';
}

// 齿轮 SVG 图标（「输出设置」悬浮按钮用）：stroke=currentColor，可随 CSS color 变色
const _GEAR_SVG =
    '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
    'style="display:block">' +
    '<circle cx="12" cy="12" r="3"/>' +
    '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>' +
    '</svg>';

// 从节点最近一次保存的输出信息里取 filename/subfolder（预览缓存与 properties 都是信息的来源）
function _getSavedVideoInfo(node) {
    const info = node._xzgVideoOutput || node.properties?._xzgVideoOutput;
    if (info && info.filename) return {
        filename: info.filename,
        subfolder: info.subfolder || "",
        type: info.type || "output",
        abs_token: info.abs_token || "",
        davinci_abs_token: info.davinci_abs_token || "",
        is_absolute: !!info.is_absolute,
    };
    const player = node._xzgVideoPlayer;
    if (player && player._videoInfo && player._videoInfo.filename) {
        const v = player._videoInfo;
        return {
            filename: v.filename,
            subfolder: v.subfolder || "",
            type: v.type || "output",
            abs_token: v.abs_token || "",
            davinci_abs_token: v.davinci_abs_token || "",
            is_absolute: !!v.is_absolute,
        };
    }
    return null;
}

function _setSaveDavinciBusy(node, busy, message = "") {
    const pc = node._xzgPreviewContainer;
    if (!pc) return;
    if (busy && !node._xzgDavinciBusyOverlay) {
        const overlay = document.createElement("div");
        overlay.style.cssText = "position:absolute;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.72);color:#f2fff3;font:bold clamp(20px,4vw,36px) sans-serif;text-shadow:0 2px 8px #000;pointer-events:auto;text-align:center;";
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

async function _exportToDavinci(node, btn, labelSpan, label) {
    const info = _getSavedVideoInfo(node);
    if (!info || !info.filename) {
        _toast("[导出到达芬奇] 当前节点还没有已保存的视频，请先执行一次「保存」模式。", true);
        return;
    }
    btn.disabled = true;
    _setSaveDavinciBusy(node, true, "准备导出…");
    try {
        const sessionResp = await api.fetchApi(`/xzg/davinci/video-export-session?_=${Date.now()}`, { cache: "no-store" });
        const sessionInfo = await sessionResp.json();
        if (!sessionResp.ok || !sessionInfo?.session) throw new Error(sessionInfo?.error || "无法确认 ComfyUI 会话状态");
        const session = sessionInfo.session;
        const sameSession = node._xzgVideoDavinciSession === session && !!node._xzgVideoDavinciOutputDir;
        const status = sameSession ? "正在导出到达芬奇…" : "选择保存位置…";
        _setSaveDavinciBusy(node, true, status);
        if (labelSpan) labelSpan.textContent = status;
        const body = { filename: info.filename, subfolder: info.subfolder,
            target_dir: sameSession ? node._xzgVideoDavinciOutputDir : "",
            // target_name 始终传空：后端用 output 当前文件的实际文件名（abs_path 的 basename），
            // 不复用 localStorage 里的旧文件名，避免和 output 里新保存的名字对不上。
            target_name: "",
            // 仅视频轨道开关：widget.value=true 表示不导音频，故 import_audio 取反。
            import_audio: !node._xzgDvVideoOnlyWidget?.value };
        // 预览模式 + 自定义输出：优先使用后端为达芬奇准备的目录副本。
        // 自定义绝对路径保存则仍使用预览令牌；两者都不会向前端暴露真实路径。
        if (info.davinci_abs_token) body.abs_token = info.davinci_abs_token;
        else if (info.abs_token) body.abs_token = info.abs_token;
        const resp = await api.fetchApi("/xzg/davinci/save-import", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        const data = await resp.json();
        if (data?.save_directory) {
            node._xzgVideoDavinciSession = session;
            node._xzgVideoDavinciOutputDir = data.save_directory;
            node._xzgVideoDavinciOutputName = data.save_filename || node._xzgVideoDavinciOutputName;
            _saveVideoDavinciTarget(node, session, data);
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
        _setSaveDavinciBusy(node, false);
        btn.disabled = false;
        if (labelSpan) labelSpan.textContent = label;
    }
}

async function _sendToQuickCut(node, btn, labelSpan) {
    const info = _getSavedVideoInfo(node);
    if (!info || !info.filename) {
        _toast("[发送到快剪] 当前节点还没有已保存的视频，请先执行一次「保存」模式。", true);
        return;
    }
    // 自定义输出-绝对路径：快剪媒体库从 ComfyUI 目录读取，暂不支持 output/ 之外的文件
    if (info.is_absolute) {
        _toast("[发送到快剪] 自定义绝对路径输出暂不支持发送到快剪，可直接在保存文件夹中使用该视频。", true);
        return;
    }
    if (typeof window._xzgVideoEditorReceiveMedia !== "function") {
        _toast("[发送到快剪] 快剪模块未加载，请刷新页面。", true);
        return;
    }
    if (btn) btn.disabled = true;
    if (labelSpan) labelSpan.textContent = "正在发送…";
    try {
        await window._xzgVideoEditorReceiveMedia(info.filename, info.type || "output");
        _toast("已加入快剪媒体库（打开快剪即可拖入轨道使用）");
    } catch (e) {
        _toast("[发送到快剪] " + String(e), true);
    } finally {
        if (btn) btn.disabled = false;
        if (labelSpan) labelSpan.textContent = "发送到快剪";
    }
}

async function _favoriteSavedVideo(node, btn) {
    const info = _getSavedVideoInfo(node);
    if (!info?.filename) return _toast("请先执行节点生成视频。", true);
    btn.disabled = true;
    try {
        const response = await api.fetchApi("/xzg/media-library/add-video", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filename: [info.subfolder, info.filename].filter(Boolean).join("/"),
                type: info.type, abs_token: info.abs_token || info.davinci_abs_token || "" }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "收藏失败");
        _toast("已收藏到视频媒体库");
    } catch (error) { _toast(error.message || "收藏失败", true); }
    finally { btn.disabled = false; }
}

function _createQuickCutButton(node, favorite = false) {
    const buttonKey = favorite ? "_xzgVideoFavoriteBtn" : "_xzgQuickCutBtn";
    if (node[buttonKey]) return node[buttonKey];
    const pc = node._xzgPreviewContainer;
    if (!pc) return null;

    const btn = document.createElement("button");
    btn.title = "把当前节点保存的视频发送到快剪媒体库（打开快剪后可手动拖入轨道使用）";
    btn.style.cssText =
        "position:absolute;top:6px;right:0;z-index:102;" +
        "display:inline-flex;align-items:center;gap:4px;" +
        "height:22px;box-sizing:border-box;padding:2px 6px;font-size:11px;line-height:1;" +
        "background:transparent;color:#ffd76a;border:none;" +
        "cursor:pointer;pointer-events:auto;" +
        "transition:color 0.15s,opacity 0.2s;opacity:0;";
    btn.innerHTML = `<span style="cursor:pointer;">${_CLAPPER_SVG}</span><span>发送</span>`;
    if (favorite) {
        btn.title = "收藏当前视频到视频媒体库";
        btn.style.right = "auto";
        btn.style.left = "6px";
        btn.innerHTML = '<span style="font-size:13px">☆</span><span>收藏</span>';
    }
    const iconSpan = btn.querySelector("span:first-child");
    const labelSpan = btn.querySelector("span:last-child");
    pc.appendChild(btn);

    // 图标保持金色常亮；点击图标或文字都执行一次手动发送，不再切换自动发送状态。
    iconSpan.style.color = "#ffd76a";
    iconSpan.title = "点击发送到快剪";

    // 排在「导出到达芬奇」按钮左侧：按其宽度留 12px 间隙对齐
    const alignRight = () => {
        if (favorite) return;
        const dvBtn = node._xzgDavinciSaveBtn;
        if (dvBtn && dvBtn.offsetWidth > 0) {
            btn.style.right = (dvBtn.offsetWidth + 12) + "px";
        }
    };
    const onOver = () => { alignRight(); btn.style.opacity = "1"; };
    const onOut = (e) => {
        if (!pc.contains(e.relatedTarget) && !btn.disabled) btn.style.opacity = "0";
    };
    pc.addEventListener("mouseover", onOver);
    pc.addEventListener("mouseout", onOut);

    btn.addEventListener("mouseenter", () => {
        if (!btn.disabled) {
            btn.style.color = "#fff";
            iconSpan.style.color = "#fff";
        }
    });
    btn.addEventListener("mouseleave", () => {
        btn.style.color = "#ffd76a";
        iconSpan.style.color = "#ffd76a";
    });
    btn.addEventListener("wheel", _forwardCanvasWheel, { passive: false });
    btn.onclick = () => { if (!btn.disabled) {
        if (favorite) _favoriteSavedVideo(node, btn);
        else _sendToQuickCut(node, btn, labelSpan);
    } };

    node[buttonKey] = btn;
    return btn;
}

// ═══════════════════════════════════════════════════════════════════
// 「输出设置」悬浮按钮
// 把 use_default_output / base_dir / add_date_stamp / add_time_stamp 四个参数收进
// 「小珠光图片保存-化神级」同一个共享设置弹窗（window._xzgShowDirBrowser），
// 弹窗选项与其完全一致（输出模式单选/自定义前缀/日期戳/时间戳/目录浏览）；
// 参数 widget 仍保留在 widgets 数组里参与序列化，只是不绘制。
// ═══════════════════════════════════════════════════════════════════

// 标准隐藏手法（与图像保存节点一致）：type="hidden" 让新版 ComfyUI 前端
// isWidgetVisible 返回 false、跳过布局占位；widget 仍随工作流序列化
function _hideVideoSettingWidget(w) {
    if (!w) return;
    w.type = "hidden";
    w.hidden = true;
    w.draw = function () {};
    w.computeSize = function () { return [0, 0]; };
    w.mouse = function () { return false; };
}

// 打开「输出设置」：直接复用「小珠光图片保存-化神级」的共享设置弹窗
// （window._xzgShowDirBrowser，由 xzg_image_save.js 全局注册），弹窗选项与其完全一致：
// 输出模式单选（默认输出 output / 自定义目录；「另存为」对保存节点隐藏）+ 自定义前缀 +
// 日期戳 + 时间戳 + 目录浏览（面包屑 / 最近使用 / 新建文件夹），非自定义模式自动灰显目录区。
function _xzgOpenVideoOutputSettings(node) {
    if (typeof window._xzgShowDirBrowser !== "function") {
        _toast("输出设置弹窗不可用（图像保存模块未加载），请刷新页面重试。", true);
        return;
    }
    window._xzgShowDirBrowser(node);
}

function _createOutputSettingsButton(node) {
    if (node._xzgOutSettingsBtn) return node._xzgOutSettingsBtn;
    const pc = node._xzgPreviewContainer;
    if (!pc) return null;

    const btn = document.createElement("button");
    btn.title = "输出设置（与小珠光图片保存-化神级同一设置框）：默认输出 / 自定义目录 / 自定义前缀 / 日期戳 / 时间戳";
    btn.style.cssText =
        "position:absolute;top:6px;right:0;z-index:102;" +
        "display:inline-flex;align-items:center;gap:4px;" +
        "height:22px;box-sizing:border-box;padding:2px 6px;font-size:11px;line-height:1;" +
        "background:transparent;color:#8ab4f8;border:none;" +
        "cursor:pointer;pointer-events:auto;" +
        "transition:color 0.15s,opacity 0.2s;opacity:0;";
    btn.innerHTML = `<span style="cursor:pointer;">${_GEAR_SVG}</span><span>设置</span>`;

    // 排在最左侧：right = 导出按钮宽 + 快剪按钮宽 + 两处间隙
    const alignRight = () => {
        const dvBtn = node._xzgDavinciSaveBtn;
        const qcBtn = node._xzgQuickCutBtn;
        const w = (dvBtn?.offsetWidth || 0) + (qcBtn?.offsetWidth || 0);
        btn.style.right = (w + 24) + "px";
    };
    const onOver = () => { alignRight(); btn.style.opacity = "1"; };
    const onOut = (e) => {
        if (!pc.contains(e.relatedTarget)) btn.style.opacity = "0";
    };
    pc.addEventListener("mouseover", onOver);
    pc.addEventListener("mouseout", onOut);

    btn.addEventListener("mouseenter", () => btn.style.color = "#fff");
    btn.addEventListener("mouseleave", () => btn.style.color = "#8ab4f8");
    btn.addEventListener("wheel", _forwardCanvasWheel, { passive: false });
    btn.onclick = () => _xzgOpenVideoOutputSettings(node);

    pc.appendChild(btn);
    node._xzgOutSettingsBtn = btn;
    return btn;
}

function _createExportDavinciButton(node) {
    if (node._xzgDavinciSaveBtn) return node._xzgDavinciSaveBtn;
    const pc = node._xzgPreviewContainer;
    if (!pc) return null;

    const btn = document.createElement("button");
    btn.title = "把当前节点保存的视频导入达芬奇（进媒体池 + 复用空白轨道/无则新建 + 对齐播放头片段前端）";
    btn.style.cssText =
        "position:absolute;top:6px;right:6px;z-index:102;" +
        "display:inline-flex;align-items:center;gap:4px;" +
        "height:22px;box-sizing:border-box;padding:2px 6px;font-size:11px;line-height:1;" +
        "background:transparent;color:#3ef558;border:none;" +
        "cursor:pointer;pointer-events:auto;" +
        "transition:color 0.15s,opacity 0.2s;opacity:0;outline:none;-webkit-tap-highlight-color:transparent;box-shadow:none;";
    btn.innerHTML = `<span>${_xzgDvToggleClover(false)}</span><span>导出</span>`;
    const iconSpan = btn.querySelector("span:first-child");
    // 图标包装器内部也有一个三叶草 span；只取按钮直接子级文字标签，避免忙碌
    // 状态更新时把三叶草替换成状态文字。
    const labelSpan = btn.lastElementChild;
    pc.appendChild(btn);

    iconSpan.title = "手动导出到达芬奇";

    const onOver = () => { btn.style.opacity = "1"; };
    const onOut = (e) => {
        if (!pc.contains(e.relatedTarget) && !btn.disabled) btn.style.opacity = "0";
    };
    pc.addEventListener("mouseover", onOver);
    pc.addEventListener("mouseout", onOut);

    btn.addEventListener("mouseenter", () => {
        if (btn.disabled) return;
        btn.style.color = "#fff";
        iconSpan.querySelector(".xzg-dv-tclover")?.classList.add("spinning");
    });
    btn.addEventListener("mouseleave", () => {
        btn.style.color = "#3ef558";
        iconSpan.querySelector(".xzg-dv-tclover")?.classList.remove("spinning");
    });
    btn.addEventListener("wheel", _forwardCanvasWheel, { passive: false });
    btn.onclick = () => { if (!btn.disabled) _exportToDavinci(node, btn, labelSpan, "导出"); };

    node._xzgDavinciSaveBtn = btn;
    return btn;
}

app.registerExtension({
    name: "Xiaozhuguang.VideoSave.DaVinci",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData?.name !== SAVE_DAVINCI_NODE) return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnNodeCreated?.apply(this, arguments);

            // 化神级：最小宽度与默认宽度均为 360。
            this.minWidth = 360;
            try { this.setSize([360, Math.max(this.size?.[1] || 360, 360)]); } catch (e) {}
            // 尺寸持久化标志：onConfigure 从工作流恢复尺寸时会置 true，
            // 阻止下方 rAF 末尾的 setSize(computeSize()) 覆盖用户手动调好的尺寸。
            this._xzgRestoredSize = false;

            // 父类注册器已在本节点的 onNodeCreated 里创建好预览容器；
            // 这里在其基础上叠加「导出到达芬奇」悬浮按钮。父类注册器是同一扩展，
            // 需等它执行完（onNodeCreated 内 addDOMWidget）。用 rAF 确保容器已就绪。
            requestAnimationFrame(() => {
                _createExportDavinciButton(this);
                _createQuickCutButton(this);
                _createQuickCutButton(this, true);
                // 输出设置：隐藏 use_default_output / base_dir / add_date_stamp / add_time_stamp 参数
                // widget（保留在数组中参与序列化），由预览区「输出设置」悬浮按钮打开与小珠光图片
                // 保存-化神级同一个共享设置弹窗统一设置。自定义前缀映射到「文件名前缀」widget；
                // 共享弹窗回写依赖 _xzgDefaultOutputWidget / _xzgPrefixCustomWidget /
                // _xzgDateStampWidget / _xzgTimeStampWidget 这组引用名（与图像保存-化神级一致）。
                const defW = this.widgets?.find(w => w.name === "use_default_output") || null;
                const baseW = this.widgets?.find(w => w.name === "base_dir") || null;
                const prefixW = this.widgets?.find(w => w.name === "文件名前缀") || null;
                const dateW = this.widgets?.find(w => w.name === "add_date_stamp") || null;
                const timeW = this.widgets?.find(w => w.name === "add_time_stamp") || null;
                this._xzgDefaultOutputWidget = defW;
                this._xzgBaseDirWidget = baseW;
                this._xzgPrefixCustomWidget = prefixW;
                this._xzgDateStampWidget = dateW;
                this._xzgTimeStampWidget = timeW;
                _hideVideoSettingWidget(defW);
                _hideVideoSettingWidget(baseW);
                _hideVideoSettingWidget(dateW);
                _hideVideoSettingWidget(timeW);
                // 导出音频开关：隐藏在节点上，由输出设置弹窗里的「仅视频轨道」勾选框控制。
                const audioW = this.widgets?.find(w => w.name === "仅视频") || null;
                this._xzgExportAudioWidget = audioW;
                _hideVideoSettingWidget(audioW);
                // 「仅视频」widget：隐藏在节点上，由输出设置弹窗里的
                // 「仅视频轨道（不带音频）」勾选框双向绑定（弹窗读 node._xzgDvVideoOnlyWidget）。
                this._xzgDvVideoOnlyWidget = this.widgets?.find(w => w.name === "仅视频") || null;
                _createOutputSettingsButton(this);
                // 自动导出开关已取消；旧工作流字段保留隐藏以兼容序列化，但不再自动发送。
                _hideVideoSettingWidget(this.widgets?.find(w => w.name === "自动导出到达芬奇"));
                _hideVideoSettingWidget(this.widgets?.find(w => w.name === "自动发送到快剪"));

                // 清理多余的输入口：后端 INPUT_TYPES 只声明了 图像/帧率/音频 三个端口型 input。
                // 隐藏 widget（自动发送到快剪 / use_default_output / base_dir / 日期戳 / 时间戳）
                // 在旧版本若被右键「转换为输入」、或被旧工作流序列化残留，会在 node.inputs 里
                // 留下未连线的多余口，画在预览黑块左侧，拖拽连线时还能吸附。这里把不在白名单、
                // 且未连接（link == null）的多余 input 口移除；已连接的保留，不破坏既有工作流。
                const _expectedInputs = ["图像", "帧率", "音频"];
                for (let i = this.inputs.length - 1; i >= 0; i--) {
                    const inp = this.inputs[i];
                    if (inp && !_expectedInputs.includes(inp.name) && inp.link == null) {
                        try { this.removeInput(i); } catch (_) {}
                    }
                }

                // 仅新建节点（没有从工作流恢复尺寸）时才按 widget 布局重算尺寸；
                // 从工作流恢复的节点（_xzgRestoredSize=true）保留用户手动调好的尺寸。
                if (!this._xzgRestoredSize) {
                    try { this.setSize(this.computeSize()); } catch (e) {}
                }
            });
            return r;
        };

        // 尺寸持久化：从工作流恢复时，直接用 data.size；并设置 _xzgRestoredSize=true
        // 阻止 onNodeCreated rAF 里的 setSize(computeSize()) 覆盖。rAF 里再恢复一次，
        // 确保在 onNodeCreated 的 rAF（隐藏 widget / 清理输入口）跑完之后仍然是用户尺寸。
        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (data) {
            const r = origOnConfigure?.apply(this, arguments);
            try {
                const node = this;
                const savedSize = (Array.isArray(data?.size) && data.size[0] > 0 && data.size[1] > 0)
                    ? [data.size[0], data.size[1]] : null;
                if (savedSize) {
                    node._xzgRestoredSize = true;
                    node.size = savedSize.slice();
                }
                requestAnimationFrame(() => {
                    const parts = (node.graph?.nodes || []).filter(n => n?.id != null && n.type)
                        .map(n => `${n.id}:${n.type}`).sort();
                    let h = 5381;
                    for (const part of parts) for (let i = 0; i < part.length; i++) h = ((h << 5) + h + part.charCodeAt(i)) >>> 0;
                    _loadVideoDavinciTarget(node);

                    // 加载旧工作流时 inputs 可能被序列化恢复出多余的未连接口（画在预览区左侧），
                    // 与 onNodeCreated 同一套白名单清理。已连接的口保留。
                    const _expected = ["图像", "帧率", "音频"];
                    for (let i = (node.inputs?.length || 0) - 1; i >= 0; i--) {
                        const inp = node.inputs[i];
                        if (inp && !_expected.includes(inp.name) && inp.link == null) {
                            try { node.removeInput(i); } catch (_) {}
                        }
                    }
                    // 再恢复一次尺寸（onNodeCreated 的 rAF 可能刚跑完）
                    if (savedSize) {
                        node.size = savedSize.slice();
                        node.setDirtyCanvas?.(true, true);
                    }
                });
            } catch (e) { /* ignore */ }
            return r;
        };
    },
});

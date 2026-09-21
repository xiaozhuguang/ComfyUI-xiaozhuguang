import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// 小珠光视频保存-化神级（XiaozhuguangVideoSaveDaVinci）
// 复用「小珠光视频保存」的全部交互（预览/缓存/恢复见父类 xzg_video_combine.js 注册器），
// 额外在预览区叠加「导出到达芬奇」悬浮按钮：把该节点最近一次保存的视频导入达芬奇
// （进当前媒体池 + 新建视频轨道 + 对齐播放头所在最上层片段前端，不推移/不分割）。
const SAVE_DAVINCI_NODE = "XiaozhuguangVideoSaveDaVinci";

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
            is_absolute: !!v.is_absolute,
        };
    }
    return null;
}

async function _exportToDavinci(node, btn, labelSpan, label) {
    const info = _getSavedVideoInfo(node);
    if (!info || !info.filename) {
        _toast("[导出到达芬奇] 当前节点还没有已保存的视频，请先执行一次「保存」模式。", true);
        return;
    }
    btn.disabled = true;
    if (labelSpan) labelSpan.textContent = "正在导出到达芬奇…";
    try {
        const body = { filename: info.filename, subfolder: info.subfolder };
        // 自定义输出-绝对路径：携带会话令牌，由后端解析真实路径（不把绝对路径暴露给前端）
        if (info.abs_token) body.abs_token = info.abs_token;
        const resp = await api.fetchApi("/xzg/davinci/save-import", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        const data = await resp.json();
        if (!data?.ok) {
            _toast("[导出到达芬奇] " + (data?.error || "导入失败"), true);
            return;
        }
        const clip = data.clip ? `「${data.clip}」` : "";
        const track = data.track != null ? `V${data.track}` : "";
        _toast(`已导出至达芬奇${clip} ${track} ${data.record_frame != null ? `@帧${data.record_frame}` : ""}`.trim());
    } catch (e) {
        _toast("[导出到达芬奇] " + String(e), true);
    } finally {
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

function _createQuickCutButton(node) {
    if (node._xzgQuickCutBtn) return node._xzgQuickCutBtn;
    const pc = node._xzgPreviewContainer;
    if (!pc) return null;

    const btn = document.createElement("button");
    btn.title = "把当前节点保存的视频发送到快剪媒体库（打开快剪后可手动拖入轨道使用）";
    btn.style.cssText =
        "position:absolute;top:6px;right:0;z-index:102;" +
        "display:inline-flex;align-items:center;gap:4px;" +
        "padding:2px 6px;font-size:11px;line-height:1;" +
        "background:transparent;color:#ffd76a;border:none;" +
        "cursor:pointer;pointer-events:auto;" +
        "transition:color 0.15s,opacity 0.2s;opacity:0;";
    btn.innerHTML = `<span style="cursor:pointer;">${_CLAPPER_SVG}</span><span>发送到快剪</span>`;
    const iconSpan = btn.querySelector("span:first-child");
    const labelSpan = btn.querySelector("span:last-child");
    pc.appendChild(btn);

    // 🎬 图标 = 「自动发送到快剪」开关（开=绿色 / 关=灰色），文字 = 手动发送
    const renderAuto = () => {
        const on = !!(node._xzgAutoSendQcWidget && node._xzgAutoSendQcWidget.value);
        // SVG 图标 stroke=currentColor：开=金色（与「发送到快剪」文字同色）/ 关=灰色
        iconSpan.style.color = on ? "#ffd76a" : "#6b7280";
        iconSpan.title = on
            ? "自动发送：开（保存完成自动加入快剪；点击关闭）"
            : "自动发送：关（点击开启，保存完成后自动加入快剪媒体池）";
    };
    iconSpan.onclick = (e) => {
        e.stopPropagation(); // 只切开关，不触发手动发送
        if (!node._xzgAutoSendQcWidget) return;
        const w = node._xzgAutoSendQcWidget;
        w.value = !w.value;
        renderAuto();
        _toast(w.value ? "已开启自动发送到快剪" : "已关闭自动发送到快剪");
    };
    renderAuto();

    // 排在「导出到达芬奇」按钮左侧：按其宽度留 12px 间隙对齐
    const alignRight = () => {
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

    btn.addEventListener("mouseenter", () => { if (!btn.disabled) btn.style.color = "#fff"; });
    btn.addEventListener("mouseleave", () => { if (!btn.disabled) btn.style.color = "#ffd76a"; });
    btn.onclick = () => { if (!btn.disabled) _sendToQuickCut(node, btn, labelSpan); };

    node._xzgQuickCutBtn = btn;
    node._xzgQcBtnIconRender = renderAuto;
    return btn;
}

function _createAutoExportToggle(node, widgetName, stateKey) {
    // 开关本体是节点 widget（BOOLEAN，随工作流序列化），这里只把它藏出节点界面；
    // 开关的交互入口在各悬浮按钮的 🎬 图标上 —— 后端逻辑完全不动。
    const w = (node.widgets || []).find(w => w.name === widgetName);
    if (w && !w._xzgHidden) {
        // 标准隐藏手法：converted-widget 仍参与序列化，computeSize 折叠不占高度
        w.type = "converted-widget";
        w.computeSize = () => [0, -4];
        w.hidden = true;
        w._xzgHidden = true;
        try { node.setSize(node.computeSize()); } catch (e) {}
    }
    node[stateKey] = w || null;
    return w;
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
        "padding:2px 6px;font-size:11px;line-height:1;" +
        "background:transparent;color:#8ab4f8;border:none;" +
        "cursor:pointer;pointer-events:auto;" +
        "transition:color 0.15s,opacity 0.2s;opacity:0;";
    btn.innerHTML = `<span style="cursor:pointer;">${_GEAR_SVG}</span><span>输出设置</span>`;

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
        "padding:2px 6px;font-size:11px;line-height:1;" +
        "background:transparent;color:#3ef558;border:none;" +
        "cursor:pointer;pointer-events:auto;" +
        "transition:color 0.15s,opacity 0.2s;opacity:0;";
    btn.innerHTML = `<span style="cursor:pointer;">${_CLAPPER_SVG}</span><span>导出到达芬奇</span>`;
    const iconSpan = btn.querySelector("span:first-child");
    const labelSpan = btn.querySelector("span:last-child");
    pc.appendChild(btn);

    // 🎬 图标 = 「自动导出到达芬奇」开关（开=绿色 / 关=灰色），文字 = 手动导出。
    // 开关本体是隐藏的 BOOLEAN widget，点击只切 widget.value，仍随工作流序列化。
    const renderAuto = () => {
        const on = !!(node._xzgAutoExportWidget && node._xzgAutoExportWidget.value);
        // SVG 图标 stroke=currentColor，纯靠图标自身变色：开=绿色 / 关=灰色
        iconSpan.style.color = on ? "#3ef558" : "#6b7280";
        iconSpan.title = on
            ? "自动导出：开（点击关闭；点文字则立即手动导出）"
            : "自动导出：关（点击开启，保存完成后自动导入达芬奇）";
    };
    iconSpan.onclick = (e) => {
        e.stopPropagation(); // 只切开关，不触发手动导出
        if (!node._xzgAutoExportWidget) return;
        const w = node._xzgAutoExportWidget;
        w.value = !w.value;
        renderAuto();
        _toast(w.value ? "已开启自动导出到达芬奇" : "已关闭自动导出到达芬奇");
    };
    renderAuto();

    const onOver = () => { btn.style.opacity = "1"; };
    const onOut = (e) => {
        if (!pc.contains(e.relatedTarget) && !btn.disabled) btn.style.opacity = "0";
    };
    pc.addEventListener("mouseover", onOver);
    pc.addEventListener("mouseout", onOut);

    btn.addEventListener("mouseenter", () => { if (!btn.disabled) btn.style.color = "#fff"; });
    btn.addEventListener("mouseleave", () => { if (!btn.disabled) btn.style.color = "#3ef558"; });
    btn.onclick = () => { if (!btn.disabled) _exportToDavinci(node, btn, labelSpan, "导出到达芬奇"); };

    node._xzgDavinciSaveBtn = btn;
    node._xzgDavinciBtnIconRender = renderAuto;
    return btn;
}

app.registerExtension({
    name: "Xiaozhuguang.VideoSave.DaVinci",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData?.name !== SAVE_DAVINCI_NODE) return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnNodeCreated?.apply(this, arguments);

            // 自动发送到快剪：执行完成且开关开启时，静默发送到快剪媒体池/V2 轨道。
            // 关键：父类把 onExecuted 设为「实例属性」（node.onExecuted = ...，见
            // xzg_video_combine.js 注册器），会遮蔽原型方法——必须包裹实例本身才生效。
            const origExec = this.onExecuted;
            this.onExecuted = function (output) {
                const r2 = origExec?.apply(this, arguments);
                const w = this._xzgAutoSendQcWidget;
                if (w && w.value) {
                    const btn = this._xzgQuickCutBtn;
                    const labelSpan = btn?.querySelector("span:last-child");
                    try { _sendToQuickCut(this, btn, labelSpan)?.catch?.(() => {}); } catch (e) {}
                }
                return r2;
            };

            // 父类注册器已在本节点的 onNodeCreated 里创建好预览容器；
            // 这里在其基础上叠加「导出到达芬奇」悬浮按钮。父类注册器是同一扩展，
            // 需等它执行完（onNodeCreated 内 addDOMWidget）。用 rAF 确保容器已就绪。
            requestAnimationFrame(() => {
                _createExportDavinciButton(this);
                _createQuickCutButton(this);
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
                _createOutputSettingsButton(this);
                // 藏两个开关 widget 并把引用给图标渲染函数（图标状态依赖 widget.value）
                _createAutoExportToggle(this, "自动导出到达芬奇", "_xzgAutoExportWidget");
                _createAutoExportToggle(this, "自动发送到快剪", "_xzgAutoSendQcWidget");
                this._xzgDavinciBtnIconRender?.();
                this._xzgQcBtnIconRender?.();
                try { this.setSize(this.computeSize()); } catch (e) {}
            });
            return r;
        };

        // 尺寸持久化修复：刷新浏览器后节点恢复默认大小。
        // 本节点 onNodeCreated 内会隐藏开关 widget 并 setSize(computeSize())，异步发生在
        // configure 之后，可能把恢复好的尺寸重新覆盖为默认值（300×500）。onConfigure 收到的
        // data 含用户保存的 size；加载后短时间内持续检测，一旦尺寸被重置回默认值就按保存值
        // 恢复；用户手动拖拽后的尺寸不等于默认值，不会被覆盖。
        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (data) {
            const r = origOnConfigure?.apply(this, arguments);
            try {
                const node = this;
                if (Array.isArray(data?.size) && data.size[0] > 0 && data.size[1] > 0) {
                    const savedSize = [data.size[0], data.size[1]];
                    node.size = savedSize.slice();
                    let tries = 0;
                    const applySavedSize = () => {
                        try {
                            const s = node.size;
                            const isDefault = s && Math.round(s[0]) === 300 && Math.round(s[1]) === 500;
                            if (isDefault && (Math.round(savedSize[0]) !== 300 || Math.round(savedSize[1]) !== 500)) {
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
    },
});
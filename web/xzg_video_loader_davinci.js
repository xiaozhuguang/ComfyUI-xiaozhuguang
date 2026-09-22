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

const _tr = (s) => s;

// 达芬奇专用三瓣图标：三瓣同尺寸、彼此以窄缝分隔，不使用 emoji 或方向箭头。
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
    labelSpan.textContent = "正在从达芬奇导出…";
    try {
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
        await _selectImportedVideo(node, data.filename);
        const clipName = data?.clip?.name;
        _toast(`已导入视频${clipName ? `「${clipName}」` : ""}`);
    } catch (e) {
        _toast("[达芬奇导入] " + String(e), true);
    } finally {
        busyBtn.disabled = false;
        labelSpan.textContent = label;
    }
}

async function _selectImportedVideo(node, filename) {
    try {
        const resp = await api.fetchApi("/object_info/" + DAVINCI_NODE);
        if (!resp.ok) return;
        const info = await resp.json();
        const list = info?.[DAVINCI_NODE]?.input?.required?.["视频"]?.[0];
        if (!Array.isArray(list)) return;
        const w = node.widgets?.find((x) => x.name === "视频");
        if (!w) return;
        w.options = w.options || {};
        w.options.values = list;
        if (list.includes(filename)) {
            w.value = filename;
            w.callback?.(filename);
        } else if (list.length > 0) {
            w.value = list[list.length - 1];
            w.callback?.(w.value);
        }
        node.setDirtyCanvas?.(true, true);
    } catch (_) {}
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
    await _davinciExport(node, btn, labelSpan, "从达芬奇导入");
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
        "padding:2px 6px;font-size:11px;line-height:1;" +
        "background:transparent;color:#3ef558;border:none;" +
        "cursor:pointer;pointer-events:auto;" +
        "transition:color 0.15s,opacity 0.2s;opacity:0;";
    btn.innerHTML = `${_davinciCloverIcon()}<span>从达芬奇导入</span>`;
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

    btn.addEventListener("mouseenter", () => { if (!btn.disabled) btn.style.color = "#fff"; });
    btn.addEventListener("mouseleave", () => { if (!btn.disabled) btn.style.color = "#3ef558"; });
    btn.onclick = () => { if (!btn.disabled) _onImportClick(node, btn, labelSpan); };

    node._xzgDavinciBtn = btn;
    return btn;
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

function _layoutPreviewActions(node) {
    // 右 → 左：从达芬奇导入、导出到达芬奇、从快剪加载、发送到快剪。
    const buttons = [
        node._xzgDavinciBtn,
        node._xzgLoaderExportDavinciBtn,
        node._xzgFastcutBtn,
        node._xzgLoaderQuickCutBtn,
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
        labelSpan.textContent = "发送到快剪";
    }
}

async function _exportLoadedToDavinci(node, btn, labelSpan) {
    const info = _getLoadedVideoInfo(node);
    if (!info?.filename) {
        _toast("[导出到达芬奇] 请先选择或上传视频。", true);
        return;
    }
    btn.disabled = true;
    labelSpan.textContent = "正在导出到达芬奇…";
    try {
        const resp = await api.fetchApi("/xzg/davinci/loader-import", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(info),
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
        labelSpan.textContent = "导出到达芬奇";
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
        "display:inline-flex;align-items:center;gap:4px;padding:2px 6px;font-size:11px;line-height:1;" +
        `background:transparent;color:${color};border:none;cursor:pointer;pointer-events:auto;` +
        "transition:color 0.15s,opacity 0.2s;opacity:0;";
    btn.innerHTML = `${iconHtml}<span>${text}</span>`;
    const labelSpan = btn.querySelector("span:last-child");
    pc.appendChild(btn);
    const onOver = () => { _layoutPreviewActions(node); btn.style.opacity = "1"; };
    const onOut = (e) => { if (!pc.contains(e.relatedTarget) && !btn.disabled) btn.style.opacity = "0"; };
    pc.addEventListener("mouseover", onOver);
    pc.addEventListener("mouseout", onOut);
    btn.addEventListener("mouseenter", () => { if (!btn.disabled) btn.style.color = "#fff"; });
    btn.addEventListener("mouseleave", () => { if (!btn.disabled) btn.style.color = color; });
    btn.onclick = () => { if (!btn.disabled) onClick(btn, labelSpan); };
    node[key] = btn;
    requestAnimationFrame(() => _layoutPreviewActions(node));
    return btn;
}

function _createLoaderQuickCutButton(node) {
    return _createLoaderActionButton(
        node, "_xzgLoaderQuickCutBtn", "#ffd76a", "发送到快剪",
        "把当前加载的视频发送到快剪媒体库（打开快剪后可手动拖入轨道使用）",
        (btn, label) => _sendLoadedToQuickCut(node, btn, label)
    );
}

function _createLoaderExportDavinciButton(node) {
    return _createLoaderActionButton(
        node, "_xzgLoaderExportDavinciBtn", "#3ef558", "导出到达芬奇",
        "把当前加载的视频导入达芬奇（进媒体池 + 复用空白轨道/无则新建 + 对齐播放头片段前端）",
        (btn, label) => _exportLoadedToDavinci(node, btn, label),
        _davinciCloverIcon()
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
                // 内存模式（低内存版功能并入）：由 widget 值动态决定 isLM，
                // 切换时通过 _xzgSetVideoLoaderMode 销毁重建播放器并重载当前视频。
                bindVideoLoaderInteractions(this, () => {
                    const mw = this.widgets?.find((w) => w.name === "内存模式");
                    return (mw?.value || "标准") === "低内存";
                }, { fastcut: true });
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
            // 策略：加载后短时间内持续检测，一旦尺寸被重置回默认值（300×500）就按保存值
            // 恢复；用户手动拖拽后的尺寸不等于默认值，不会被覆盖。
            const origOnConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function (data) {
                const r = origOnConfigure?.apply(this, arguments);
                try {
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

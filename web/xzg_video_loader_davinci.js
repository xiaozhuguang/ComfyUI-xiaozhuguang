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
    btn.innerHTML = '<span style="font-size:13px;">🎬</span><span>从达芬奇导入</span>';
    const labelSpan = btn.querySelector("span:last-child");
    pc.appendChild(btn);

    const alignRight = () => {
        if (fastcutBtn && fastcutBtn.offsetWidth > 0) {
            btn.style.right = (fastcutBtn.offsetWidth + 12) + "px";
        }
    };
    const onOver = () => { alignRight(); btn.style.opacity = "1"; };
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
            for (const inp of Object.values({ ...nodeData.input?.required, ...nodeData.input?.optional })) {
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
                bindVideoLoaderInteractions(this, false);
                _applyWidgetStyles(this);
                _removeLegacyTopButton(this);
                _createPreviewDavinciButton(this);
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
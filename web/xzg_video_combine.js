import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { XiaozhuguangVideoPlayer } from "./xzg_video_player.js";

// ═══════════════════════════════════════════════════════════════════════
// 自定义数值 widget（VHS 同款方案：从源头创建 canvas 不认识的 widget 类型）
// ═══════════════════════════════════════════════════════════════════════
function _xzgWidgetNumberMouse(event, [x, y], node) {
    const widgetWidth = this._xzgDrawW || this.width || node.size[0];
    const oldValue = this.value;
    const step = this._xzgStep || 1;
    const min = this._xzgMin;
    const max = this._xzgMax;

    const clamp = (v) => {
        if (min != null && v < min) v = min;
        if (max != null && v > max) v = max;
        return v;
    };

    if (event.type === 'pointermove') {
        if (event.deltaX) {
            this.value = clamp(this.value + event.deltaX);
            app.canvas._xzgValueDragged = true;
        }
    } else if (event.type === 'pointerup') {
        if (app.canvas._xzgValueDragged) {
            this.value = clamp(Math.round(this.value / step) * step);
        } else {
            app.canvas._xzgAllowPrompt = true;
            app.canvas?.prompt?.(
                this.label || this.name,
                this.value,
                (v) => {
                    this.value = clamp(Number(v));
                    if (this.callback) this.callback(this.value);
                    node.setDirtyCanvas?.(true, true);
                },
                event
            );
            return true;
        }
        app.canvas._xzgValueDragged = false;
    }

    if (oldValue !== this.value) {
        if (this.callback) this.callback(this.value);
        node.setDirtyCanvas?.(true, true);
    }
    return true;
}

function _xzgDrawWidget(ctx, node, width, y, H) {
    this._xzgDrawW = width;
    const pad = 16;
    const r = 6;
    const w = width - pad * 2;
    ctx.fillStyle = '#2a2a2a';
    ctx.beginPath();
    if (ctx.roundRect) { ctx.roundRect(pad, y + 1, w, H - 2, r); } else { ctx.rect(pad, y + 1, w, H - 2); }
    ctx.fill();
    ctx.strokeStyle = '#444';
    ctx.stroke();
    ctx.fillStyle = '#9ab';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.label || this.name || '', pad + 6, y + H / 2);
    const valueText = String(this.value);
    ctx.fillStyle = this._xzgValueColor || '#fff';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(valueText, width - pad - 6, y + H / 2);
}

// combo / button 同款圆角风格
function _xzgDrawComboWidget(ctx, node, width, y, H) {
    this._xzgDrawW = width;
    const pad = 16, r = 6;
    const w = width - pad * 2;
    ctx.fillStyle = '#2a2a2a';
    ctx.beginPath();
    if (ctx.roundRect) { ctx.roundRect(pad, y + 1, w, H - 2, r); } else { ctx.rect(pad, y + 1, w, H - 2); }
    ctx.fill();
    ctx.strokeStyle = '#444';
    ctx.stroke();
    // 左侧标签（超长省略）
    ctx.fillStyle = '#9ab';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const labelText = this.label || this.name || '';
    const labelMaxW = width - pad * 2 - 54;
    if (ctx.measureText(labelText).width > labelMaxW) {
        let truncated = labelText;
        while (ctx.measureText(truncated + '…').width > labelMaxW && truncated.length > 0) {
            truncated = truncated.slice(0, -1);
        }
        ctx.fillText(truncated + '…', pad + 6, y + H / 2);
    } else {
        ctx.fillText(labelText, pad + 6, y + H / 2);
    }
    // 右侧：当前值（超长省略）
    const displayText = this._xzgDisplayVal ? this._xzgDisplayVal(String(this.value ?? '')) : String(this.value ?? '');
    ctx.fillStyle = '#fff';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'right';
    const valMaxW = width - pad * 2 - 54;
    if (ctx.measureText(displayText).width > valMaxW) {
        let truncated = displayText;
        while (ctx.measureText(truncated + '…').width > valMaxW && truncated.length > 0) {
            truncated = truncated.slice(0, -1);
        }
        ctx.fillText(truncated + '…', width - pad - 16, y + H / 2);
    } else {
        ctx.fillText(displayText, width - pad - 16, y + H / 2);
    }
    // 右侧下拉箭头 ▼
    ctx.fillStyle = '#888';
    ctx.beginPath();
    const dx = width - pad - 8, dy = y + H / 2;
    ctx.moveTo(dx - 4, dy - 2);
    ctx.lineTo(dx + 4, dy - 2);
    ctx.lineTo(dx, dy + 3);
    ctx.closePath();
    ctx.fill();
}

// 强制帧率 combo 的 mouse 处理器：点击弹出下拉列表，禁止拖拽
function _xzgFpsComboMouse(event, [x, y], node) {
    if (event.type === 'pointerup') {
        _xzgShowComboDropdown(this, node, event);
        return true;
    }
    return true;
}

// 显示 combo 下拉列表（DOM 方式）
function _xzgShowComboDropdown(widget, node, event) {
    const old = document.querySelector('.xzg-fps-dropdown');
    if (old) old.remove();

    const values = widget.options?.values || ["mp4", "webm", "gif"];
    const canvasRect = app.canvas?.canvas?.getBoundingClientRect?.();
    if (!canvasRect) return;

    let wx = event.clientX;
    let wy = event.clientY;
    if (!wx || !wy) {
        const pad = 16;
        const nodeX = (node.pos?.[0] || 0) * app.canvas.ds.scale + canvasRect.left;
        const nodeY = (node.pos?.[1] || 0) * app.canvas.ds.scale + canvasRect.top;
        const widgetIdx = node.widgets?.indexOf(widget) ?? 0;
        const widgetY = nodeY + node.widgets?.slice(0, widgetIdx).reduce((s, w) => s + (w.computeSize?.(node.size[0])?.[1] || 20), 0) || 0;
        wx = nodeX + node.size[0] * app.canvas.ds.scale - pad;
        wy = widgetY;
    }

    const dropdown = document.createElement('div');
    dropdown.className = 'xzg-fps-dropdown';
    dropdown.style.cssText = `
        position: fixed; z-index: 99999;
        left: ${Math.max(4, wx - 60)}px; top: ${wy + 4}px;
        min-width: 80px;
        background: #2a2a2a; border: 1px solid #555; border-radius: 6px;
        padding: 4px 0; box-shadow: 0 4px 16px rgba(0,0,0,0.5);
    `;

    values.forEach(v => {
        const item = document.createElement('div');
        const displayText = widget._xzgDisplayVal ? widget._xzgDisplayVal(String(v)) : String(v);
        item.textContent = displayText;
        const selected = String(v) === String(widget.value);
        item.style.cssText = `
            padding: 4px 16px; cursor: pointer; font-size: 13px;
            color: ${selected ? '#FFD700' : '#ccc'};
            background: ${selected ? '#333' : 'transparent'};
        `;
        item.onmouseenter = () => { item.style.background = '#444'; };
        item.onmouseleave = () => { item.style.background = selected ? '#333' : 'transparent'; };
        item.addEventListener('pointerdown', (e) => e.stopPropagation());
        item.onclick = (e) => {
            e.stopPropagation();
            widget.value = v;
            if (widget.callback) widget.callback(v);
            node.setDirtyCanvas?.(true, true);
            dropdown.remove();
        };
        dropdown.appendChild(item);
    });

    dropdown.addEventListener('pointerdown', (e) => e.stopPropagation());

    const close = (e) => {
        if (!dropdown.contains(e.target)) {
            dropdown.remove();
            document.removeEventListener('pointerdown', close, true);
        }
    };
    document.addEventListener('pointerdown', close, true);

    document.body.appendChild(dropdown);
}

function _xzgCreateNumberWidget(node, inputName, inputData) {
    const opts = inputData[1] || {};
    const w = {
        name: inputName,
        type: 'xzg-number',
        value: opts.default ?? 0,
        options: {},
        _xzgStep: opts.step || 1,
        _xzgMin: opts.min,
        _xzgMax: opts.max,
        computeSize(width) { return [width, 20]; },
        draw: _xzgDrawWidget,
        mouse: _xzgWidgetNumberMouse,
        callback(v) { if (this._xzgCb) this._xzgCb(v); },
    };
    if (!node.widgets) node.widgets = [];
    node.widgets.push(w);
    return w;
}

function _xzgPatchCanvasPrompt() {
    if (app.canvas._xzgPromptPatched) return;
    const origPrompt = app.canvas.prompt;
    app.canvas.prompt = function () {
        if (app.canvas._xzgAllowPrompt) {
            app.canvas._xzgAllowPrompt = false;
            app.canvas._xzgLastPromptMs = Date.now();
            return origPrompt.apply(this, arguments);
        }
        if (app.canvas._xzgValueDragged) {
            app.canvas._xzgValueDragged = false;
            return null;
        }
        if (app.canvas._xzgLastPromptMs && Date.now() - app.canvas._xzgLastPromptMs < 300) {
            return null;
        }
        return origPrompt.apply(this, arguments);
    };
    app.canvas._xzgPromptPatched = true;
}

const VIDEO_PREVIEW_WIDGET_NAME = "xzg_video_combine_preview";
const VIDEO_PREVIEW_MIN_H = 100;

function getVideoUrl(filename, type, subfolder) {
    if (!filename) return "";
    const params = new URLSearchParams({
        filename: filename,
        type: type || "output",
    });
    if (subfolder) params.set("subfolder", subfolder);
    return `/view?${params.toString()}&rand=${Math.random()}`;
}

function _extractFilename(url) {
    try {
        const params = new URLSearchParams(new URL(url, location.origin).search);
        const name = params.get("filename");
        return name || "video.mp4";
    } catch (_) {
        return "video.mp4";
    }
}

app.registerExtension({
    name: "xiaozhuguang.video_combine",
    getCustomWidgets() {
        return {
            XZGINT: (node, name, data) => _xzgCreateNumberWidget(node, name, data),
            XZGFLOAT: (node, name, data) => _xzgCreateNumberWidget(node, name, data),
        };
    },
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData?.name !== "XiaozhuguangVideoCombine") return;

        for (const inp of Object.values({ ...nodeData.input?.required, ...nodeData.input?.optional })) {
            if (["INT", "FLOAT"].includes(inp[0]) && inp[1]) {
                inp[1].widgetType ??= "XZG" + inp[0];
            }
        }

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origOnNodeCreated?.apply(this, arguments);

            const node = this;

            const playerContainer = document.createElement("div");
            playerContainer.style.width = "100%";
            playerContainer.style.background = "#1a1a1a";
            playerContainer.style.position = "relative";
            playerContainer.style.pointerEvents = "none";

            const player = new XiaozhuguangVideoPlayer({
                container: playerContainer,
                placeholderText: "",
                onSaveToDesktop: () => {
                    const url = player.getSrc();
                    if (!url) return;
                    XiaozhuguangVideoPlayer.downloadVideo(url, _extractFilename(url));
                },
                onSaveAs: () => {
                    const url = player.getSrc();
                    if (!url) return;
                    XiaozhuguangVideoPlayer.saveAsVideo(url, _extractFilename(url));
                },
            });

            node.resizable = true;
            node.minWidth = 300;
            node.minHeight = 500;
            const origSetSize = node.setSize;
            node.setSize = function(size) {
                size[0] = Math.max(size[0], this.minWidth || 300);
                size[1] = Math.max(size[1], this.minHeight || 500);
                return origSetSize?.apply(this, arguments);
            };
            node.setSize([300, 500]);

            const previewWidget = node.addDOMWidget(
                VIDEO_PREVIEW_WIDGET_NAME,
                "video",
                playerContainer,
                {
                    hideOnZoom: false,
                    getValue() {
                        const info = player._videoInfo;
                        return info ? {
                            filename: info.filename || "",
                            type: info.type || "output",
                            subfolder: info.subfolder || "",
                        } : null;
                    },
                    setValue(v) {
                        if (!v) { player.load(""); return; }
                        if (typeof v === "string") {
                            // 旧版兼容：仅 URL 字符串
                            if (v !== player.src) player.load(v);
                            return;
                        }
                        const filename = v.filename;
                        const type = v.type || "output";
                        const subfolder = v.subfolder || "";
                        if (!filename) { player.load(""); return; }
                        const url = getVideoUrl(filename, type, subfolder);
                        if (url && url !== player.src) {
                            player._videoInfo = { filename, type, subfolder };
                            player.load(url);
                        }
                    },
                }
            );

            previewWidget.computeLayoutSize = function () {
                return { minHeight: VIDEO_PREVIEW_MIN_H, minWidth: 0 };
            };

            previewWidget.onRemove = () => {
                player.destroy();
            };

            const origOnResize = node.onResize;
            node.onResize = function (size) {
                const r = origOnResize?.apply(this, arguments);
                requestAnimationFrame(() => player.resize());
                return r;
            };

            const origOnRemoved = node.onRemoved;
            node.onRemoved = function () {
                player.destroy();
                return origOnRemoved?.apply(this, arguments);
            };

            const origOnConfigure = node.onConfigure;
            node.onConfigure = function (info) {
                origOnConfigure?.apply(this, arguments);
                requestAnimationFrame(() => player.resize());
            };

            // 执行完成后加载输出视频
            const origOnExecuted = node.onExecuted;
            node.onExecuted = function (output) {
                origOnExecuted?.apply(this, arguments);
                if (!output || !player) return;
                const ui = output.ui || output;
                const videos = ui?.videos;
                if (Array.isArray(videos) && videos.length > 0) {
                    const v = videos[0];
                    player._videoInfo = {
                        filename: v.filename || "",
                        type: v.type || "output",
                        subfolder: v.subfolder || "",
                    };
                    const url = getVideoUrl(v.filename, v.type, v.subfolder);
                    if (url) {
                        player.load(url);
                        if (typeof v.frame_rate === "number" && v.frame_rate > 0) {
                            player.setFrameRate?.(v.frame_rate);
                        }
                    }
                }
            };

            node._xzgVideoPlayer = player;

            _xzgPatchCanvasPrompt();

            // 统一渲染风格：combo 用圆角 draw
            for (const w of this.widgets || []) {
                if (w.name === '格式') {
                    w.draw = _xzgDrawComboWidget;
                    w.mouse = _xzgFpsComboMouse;
                } else if (w.name === '帧率') {
                    w._xzgValueColor = '#fff';
                } else if (w.name === '文件名前缀') {
                    // STRING 文本框：圆角矩形 + 标签 + 值
                    w.draw = _xzgDrawWidget;
                    if (!w._xzgValueColor) w._xzgValueColor = '#fff';
                } else if (w.name === 'CRF') {
                    w.draw = function(ctx, node, width, y, H) {
                        this._xzgDrawW = width;
                        const pad = 16, r = 6;
                        const wr = width - pad * 2;
                        ctx.fillStyle = '#2a2a2a';
                        ctx.beginPath();
                        if (ctx.roundRect) { ctx.roundRect(pad, y + 1, wr, H - 2, r); } else { ctx.rect(pad, y + 1, wr, H - 2); }
                        ctx.fill();
                        ctx.strokeStyle = '#444';
                        ctx.stroke();
                        // 左侧标签
                        ctx.fillStyle = '#9ab';
                        ctx.font = '12px sans-serif';
                        ctx.textAlign = 'left';
                        ctx.textBaseline = 'middle';
                        ctx.fillText(this.label || this.name || '', pad + 6, y + H / 2);
                        // 右侧数值
                        const valueText = String(this.value);
                        ctx.font = '14px sans-serif';
                        const vw = ctx.measureText(valueText).width;
                        ctx.fillStyle = '#fff';
                        ctx.textAlign = 'right';
                        ctx.fillText(valueText, width - pad - 6, y + H / 2);
                        // 注释文字（右对齐，在数值左侧）
                        ctx.fillStyle = '#555';
                        ctx.font = '10px sans-serif';
                        ctx.textAlign = 'right';
                        ctx.fillText('数值越大质量越差 默认19', width - pad - 6 - vw - 10, y + H / 2);
                    };
                } else if (w.name === '保存到输出目录') {
                    // BOOLEAN 开关：圆角矩形 + 标签 + 保存/预览状态
                    w.draw = function(ctx, node, width, y, H) {
                        this._xzgDrawW = width;
                        const pad = 16, r = 6;
                        const wr = width - pad * 2;
                        ctx.fillStyle = '#2a2a2a';
                        ctx.beginPath();
                        if (ctx.roundRect) { ctx.roundRect(pad, y + 1, wr, H - 2, r); } else { ctx.rect(pad, y + 1, wr, H - 2); }
                        ctx.fill();
                        ctx.strokeStyle = '#444';
                        ctx.stroke();
                        // 左侧标签
                        ctx.fillStyle = '#9ab';
                        ctx.font = '12px sans-serif';
                        ctx.textAlign = 'left';
                        ctx.textBaseline = 'middle';
                        ctx.fillText(this.label || this.name || '', pad + 6, y + H / 2);
                        // 右侧状态：保存/预览
                        const stateText = this.value ? '保存' : '预览';
                        ctx.fillStyle = this.value ? '#dcc85b' : '#a855f7';
                        ctx.font = '13px sans-serif';
                        ctx.textAlign = 'right';
                        ctx.fillText(stateText, width - pad - 6, y + H / 2);
                    };
                }
            }

            requestAnimationFrame(() => player.resize());
        };
    },
});

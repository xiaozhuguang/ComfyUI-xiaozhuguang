import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { XiaozhuguangVideoPlayer } from "./xzg_video_player.js";
import { xzgLang } from "./xzg_i18n.js";
import { xzgEnableCanvasPanOnSpace } from "./xzg_save_utils.js";

// ═══════════════════════════════════════════════════════════════════════
// 小珠光视频保存 - 双语翻译表
// ═══════════════════════════════════════════════════════════════════════
const _LABEL_MAP = {
    "图像": "Images",
    "帧率": "Frame Rate",
    "文件名前缀": "Filename Prefix",
    "格式": "Format",
    "CRF": "CRF",
    "模式": "Mode",
    "音频": "Audio",
    // 下拉值翻译
    "保存": "Save",
    "预览": "Preview",
    // CRF 注释翻译
    "数值越大质量越差 默认19": "Higher = lower quality, default 19",
};

function _tr(zh) {
    const lang = xzgLang();
    return (lang === "en" && _LABEL_MAP[zh]) ? _LABEL_MAP[zh] : zh;
}

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
    // 属性面板切换等触发节点 reflow 时，widget 传入的宽/高可能与 node.size 暂时不一致，
    // 强制把该行绘制限制在节点实际边界内，避免溢出节点（与波形钳制一致）
    const _nW = node?.size?.[0], _nH = node?.size?.[1];
    if (_nW != null && _nW > 0) width = Math.max(1, Math.min(width, _nW));
    if (_nH != null && _nH > 0) H = Math.max(1, Math.min(H, Math.max(0, _nH - y)));
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
    const labelText = this._xzgLabel ? this._xzgLabel() : (this.label || this.name || '');
    ctx.fillText(labelText, pad + 6, y + H / 2);
    const valueText = String(this.value);
    ctx.fillStyle = this._xzgValueColor || '#fff';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(valueText, width - pad - 6, y + H / 2);
}

// combo / button 同款圆角风格
function _xzgDrawComboWidget(ctx, node, width, y, H) {
    // 属性面板切换等触发节点 reflow 时，widget 传入的宽/高可能与 node.size 暂时不一致，
    // 强制把该行绘制限制在节点实际边界内，避免溢出节点（与波形钳制一致）
    const _nW = node?.size?.[0], _nH = node?.size?.[1];
    if (_nW != null && _nW > 0) width = Math.max(1, Math.min(width, _nW));
    if (_nH != null && _nH > 0) H = Math.max(1, Math.min(H, Math.max(0, _nH - y)));
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
    const labelText = this._xzgLabel ? this._xzgLabel() : (this.label || this.name || '');
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
    dropdown.className = 'xzg-fps-dropdown notranslate';
    dropdown.setAttribute('translate', 'no');
    dropdown.dataset.noTranslate = '1';
    dropdown.dataset.xzgFpsDropdown = '1';
    dropdown.style.cssText = `
        position: fixed; z-index: 99999;
        left: ${Math.max(4, wx - 60)}px; top: ${wy + 4}px;
        min-width: 80px;
        background: #2a2a2a; border: 1px solid #555; border-radius: 6px;
        padding: 4px 0; box-shadow: 0 4px 16px rgba(0,0,0,0.5);
    `;

    const createdItems = [];
    values.forEach(v => {
        const item = document.createElement('div');
        item.className = 'notranslate';
        item.setAttribute('translate', 'no');
        item.dataset.noTranslate = '1';
        const displayText = widget._xzgDisplayVal ? widget._xzgDisplayVal(String(v)) : String(v);
        item.dataset.xzgRawValue = String(v);
        item.dataset.xzgDisplay = displayText;
        item.textContent = displayText;
        createdItems.push({ el: item, expected: displayText, raw: String(v) });
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

    // 兜底：对抗 PromptAssistant 等外部 MutationObserver 篡改下拉文字
    const repairIfTampered = () => {
        if (!document.body.contains(dropdown)) return;
        createdItems.forEach(({ el, expected }) => {
            if (el.textContent !== expected) {
                console.warn("[小珠光 video_save dropdown] 检测到外部插件篡改下拉项文本，已修复:",
                    JSON.stringify(el.textContent), "->", JSON.stringify(expected));
                el.textContent = expected;
            }
        });
    };
    Promise.resolve().then(repairIfTampered);
    setTimeout(repairIfTampered, 10);
    setTimeout(repairIfTampered, 50);

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

// 模块级全局视频输出缓存：跨 tab 重建节点后恢复预览的关键
// key: 节点 id 字符串；value: { filename, type, subfolder, frame_rate }
// 借鉴 ComfyUI 原生 setNodeOutputsByExecutionId 全局 store 思路：
// executed 事件到达时无条件写入（即使节点已销毁），切回 tab 重建节点后从此读取恢复
const _xzgVideoOutputCache = new Map();

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
    init() {
        // 模块级全局 executed 监听器：节点销毁期间（切 tab）也能写入 cache
        // 解决节点级监听器随 onRemoved 移除导致事件丢失的问题
        api.addEventListener("executed", (event) => {
            const detail = event.detail;
            if (!detail || !detail.output) return;
            const ui = detail.output.ui || detail.output;
            const videos = ui?.videos || ui?.video;
            if (!Array.isArray(videos) || videos.length === 0) return;
            const v = videos[0];
            if (!v || !v.filename) return;
            const execNode = String(detail.node || detail.display_node || "");
            const localId = execNode.split(":").pop();
            const info = {
                filename: v.filename || "",
                type: v.type || "output",
                subfolder: v.subfolder || "",
            };
            if (typeof v.frame_rate === "number" && v.frame_rate > 0) {
                info.frame_rate = v.frame_rate;
            }
            _xzgVideoOutputCache.set(localId, info);
        });
    },
    getCustomWidgets() {
        return {
            XZGINT: (node, name, data) => _xzgCreateNumberWidget(node, name, data),
            XZGFLOAT: (node, name, data) => _xzgCreateNumberWidget(node, name, data),
        };
    },
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData?.name !== "XiaozhuguangVideoCombine") return;

        // 给 combo widget（格式、模式）设置 XZGINT 类型，避免原生 combo 下拉列表
        // 模式：仅需点击切换 保存/预览，不弹列表
        for (const inp of Object.values({ ...nodeData.input?.required, ...nodeData.input?.optional })) {
            if (Array.isArray(inp[0]) && typeof inp[1] === 'object') {
                inp[1].widgetType = "XZGINT";
            }
        }

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
            // 启用空格+拖动平移画布（DOM widget 默认会拦截 pointer 事件）
            xzgEnableCanvasPanOnSpace(playerContainer);

            // Bypass 紫色覆盖层
            const bypassOverlay = document.createElement("div");
            bypassOverlay.style.cssText =
                "position:absolute;inset:0;background-color:rgba(106,36,106,0.6);pointer-events:none;z-index:100;display:none;";
            playerContainer.appendChild(bypassOverlay);

            const updateBypassState = () => {
                if (node.mode === 4) {
                    bypassOverlay.style.display = "block";
                } else {
                    bypassOverlay.style.display = "none";
                }
            };
            updateBypassState();
            node._xzgUpdateBypassState = updateBypassState;

            const player = new XiaozhuguangVideoPlayer({
                container: playerContainer,
                placeholderText: "🎬 暂无视频",
                onSaveToDesktop: () => {
                    const url = player.getSrc();
                    if (!url) return;
                    XiaozhuguangVideoPlayer.downloadVideo(url, _extractFilename(url));
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
            
            // 获取目录路径
            const modeWidget = node.widgets.find(w => w.name === '模式');

            const updateOutputDirDisplay = async () => {
                try {
                    const response = await api.fetchApi('/xzg/get_output_dir');
                    const data = await response.json();
                    const isSave = (modeWidget?.value ?? '保存') !== '预览';
                    const baseDir = isSave ? data.output_dir : data.temp_dir;
                    node._xzgFullOutputDir = baseDir;
                    node.setDirtyCanvas(true, true);
                } catch (e) {
                    console.error('[小珠光视频保存] 获取输出目录失败:', e);
                }
            };
            updateOutputDirDisplay();

            const previewWidget = node.addDOMWidget(
                VIDEO_PREVIEW_WIDGET_NAME,
                "video",
                playerContainer,
                {
                    hideOnZoom: false,
                    getValue() {
                        // 优先从 properties 读取（跨 tab 重建后 player._videoInfo 会丢失）
                        const info = node.properties?._xzgVideoOutput || player._videoInfo;
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
                            const info = { filename, type, subfolder };
                            player._videoInfo = info;
                            // 同步 properties，保证后续序列化/重建可恢复
                            node.properties = node.properties || {};
                            node.properties._xzgVideoOutput = info;
                            player.load(url);
                        }
                    },
                }
            );

            previewWidget.computeLayoutSize = function () {
                return { minHeight: VIDEO_PREVIEW_MIN_H, minWidth: 0 };
            };
            // 修复：ComfyUI（属性面板/线性模式渲染等）会把 DOM widget 的 width 写成
            // 面板侧行宽度，而画布侧 DOM 宿主宽度 = widget.width - margin*2，
            // 一旦该值大于节点实际宽度，预览区就会溢出节点（随属性面板开/关变化）。
            // 这里把 width 定义为只读访问器，始终跟随节点实际宽度，忽略污染性写入。
            Object.defineProperty(previewWidget, 'width', {
                configurable: true,
                get() { return node.size?.[0] || 0; },
                set(_) { /* 忽略外部写入，防止预览区溢出节点 */ },
            });

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
                api.removeEventListener("executed", _onApiExecuted);
                _visibilityObserver.disconnect();
                player.destroy();
                return origOnRemoved?.apply(this, arguments);
            };

            const origOnConfigure = node.onConfigure;
            node.onConfigure = function (info) {
                origOnConfigure?.apply(this, arguments);
                requestAnimationFrame(() => {
                    player.resize();
                    if (player._destroyed) return;
                    // 切 tab 重建 / 加载工作流后恢复视频预览
                    // 优先级 1：模块级全局 cache（executed 事件写入，跨节点重建稳定）
                    // 优先级 2：node.properties（工作流保存/加载场景兜底）
                    const saved = _xzgVideoOutputCache.get(String(node.id))
                                 || node.properties?._xzgVideoOutput;
                    if (saved && saved.filename) {
                        const key = `${saved.filename}|${saved.type || ""}|${saved.subfolder || ""}`;
                        if (player._lastAppliedKey !== key) {
                            player._lastAppliedKey = key;
                            player._videoInfo = saved;
                            if (saved.frame_rate) player.setFrameRate?.(saved.frame_rate);
                            const url = getVideoUrl(saved.filename, saved.type, saved.subfolder);
                            if (url) {
                                const visible = playerContainer.clientWidth > 0 && playerContainer.clientHeight > 0;
                                if (visible) {
                                    player.load(url);
                                } else {
                                    player._pendingVideoUrl = url;
                                }
                            }
                        }
                    }
                });
            };

            // 执行完成后加载输出视频
            // 提取为独立函数，供 onExecuted 和 api executed 事件共用
            // 关键：视频信息同步写入 node.properties，跨 tab 重建后可恢复
            // （借鉴 ComfyUI 原生 setNodeOutputsByExecutionId 全局 store 思路）
            const _applyVideoOutput = (output) => {
                if (!output || !player) return;
                const ui = output.ui || output;

                // 更新输出目录显示（使用执行返回的路径）
                if (ui?.output_dir) {
                    node._xzgFullOutputDir = ui.output_dir;
                    node.setDirtyCanvas(true, true);
                }

                // 兼容 output.videos / output.video 两种字段名
                const videos = ui?.videos || ui?.video;
                if (Array.isArray(videos) && videos.length > 0) {
                    const v = videos[0];
                    const info = {
                        filename: v.filename || "",
                        type: v.type || "output",
                        subfolder: v.subfolder || "",
                    };
                    if (typeof v.frame_rate === "number" && v.frame_rate > 0) {
                        info.frame_rate = v.frame_rate;
                    }
                    // 关键：先无条件写入模块级全局 cache
                    // 切 tab 重建节点后，onConfigure/ResizeObserver 从此读取恢复预览
                    _xzgVideoOutputCache.set(String(node.id), info);
                    // 同步 properties（工作流保存/加载场景兜底）
                    node.properties = node.properties || {};
                    node.properties._xzgVideoOutput = info;
                    // player 已销毁时只存信息，等重建后由 onConfigure 恢复
                    if (player._destroyed) return;
                    // 去重：同一视频不重复加载（onExecuted 与 api 事件可能同时触发）
                    const key = `${info.filename}|${info.type || ""}|${info.subfolder || ""}`;
                    if (player._lastAppliedKey === key) return;
                    player._lastAppliedKey = key;
                    player._videoInfo = info;
                    const url = getVideoUrl(info.filename, info.type, info.subfolder);
                    if (url) {
                        if (info.frame_rate) player.setFrameRate?.(info.frame_rate);
                        // 容器可见时立即加载；不可见时只记录 pending，等 ResizeObserver 触发
                        const visible = playerContainer.clientWidth > 0 && playerContainer.clientHeight > 0;
                        if (visible) {
                            player.load(url);
                        } else {
                            player._pendingVideoUrl = url;
                        }
                    }
                }
            };

            const origOnExecuted = node.onExecuted;
            node.onExecuted = function (output) {
                origOnExecuted?.apply(this, arguments);
                _applyVideoOutput(output);
            };

            // 补充：监听 api executed 事件，解决切换工作流后 onExecuted 不触发的问题。
            // ComfyUI 前端只在当前 rootGraph 中查找节点调用 onExecuted，切换 tab 后
            // 原工作流的节点不在当前 rootGraph 中，onExecuted 不会被调用。
            const _onApiExecuted = (event) => {
                const detail = event.detail;
                if (!detail || !detail.output) return;
                // 匹配节点 id（兼容子图 executionId 格式 "parentId:childId"，取最后一段）
                const execNode = String(detail.node || detail.display_node || "");
                const localId = execNode.split(":").pop();
                if (localId !== String(node.id)) return;
                // 无条件调用：_applyVideoOutput 内部会先写模块级 cache（即使 player 销毁），
                // 再判断 player 是否可用决定是否立即 load
                _applyVideoOutput(detail.output);
            };
            api.addEventListener("executed", _onApiExecuted);

            // 监听容器可见性变化：切 tab 时 DOM widget 容器尺寸变为 0，
            // 切回时从 0 变为非 0。此时若有待加载视频就 load，确保预览刷新。
            let _containerVisible = playerContainer.clientWidth > 0 && playerContainer.clientHeight > 0;
            const _visibilityObserver = new ResizeObserver(() => {
                if (player._destroyed) return;
                const visible = playerContainer.clientWidth > 0 && playerContainer.clientHeight > 0;
                if (visible && !_containerVisible) {
                    // 容器从不可见变为可见（切回 tab）
                    if (player._pendingVideoUrl) {
                        const url = player._pendingVideoUrl;
                        player._pendingVideoUrl = null;
                        player.load(url);
                    } else if (player.getSrc() && player._currentDecoder) {
                        // 已有视频，重新渲染当前帧（canvas 在不可见时可能渲染异常）
                        player.seek(player._currentTime || 0);
                        player._updateSurfaceSize?.();
                    } else {
                        // player 无视频但有缓存记录：从模块级 cache / properties 恢复
                        // （覆盖 onConfigure 恢复时机遗漏的场景）
                        const saved = _xzgVideoOutputCache.get(String(node.id))
                                     || node.properties?._xzgVideoOutput;
                        if (saved && saved.filename) {
                            const key = `${saved.filename}|${saved.type || ""}|${saved.subfolder || ""}`;
                            if (player._lastAppliedKey !== key) {
                                player._lastAppliedKey = key;
                                player._videoInfo = saved;
                                if (saved.frame_rate) player.setFrameRate?.(saved.frame_rate);
                                const url = getVideoUrl(saved.filename, saved.type, saved.subfolder);
                                if (url) player.load(url);
                            }
                        }
                    }
                }
                _containerVisible = visible;
            });
            _visibilityObserver.observe(playerContainer);

            node._xzgVideoPlayer = player;

            _xzgPatchCanvasPrompt();

            // 统一渲染风格：combo 用圆角 draw；所有 widget 加双语 label / value 显示
            for (const w of this.widgets || []) {
                // 修复（同「视频/音频」栏）：ComfyUI 会把 widget.width 写成面板侧行宽度，
                // 一旦大于节点实际宽度，行绘制/交互命中区就会溢出节点、且随属性面板开/关变化。
                // 这里把 width 改为只读访问器，始终跟随节点实际宽度，忽略污染性写入。
                if (w.name !== VIDEO_PREVIEW_WIDGET_NAME && !w._xzgWidthFixed) {
                    w._xzgWidthFixed = true;
                    try {
                        Object.defineProperty(w, 'width', {
                            configurable: true,
                            get() { return node.size?.[0] || 0; },
                            set(_) { /* 忽略外部写入，防止行溢出节点 */ },
                        });
                    } catch (_) {}
                }
                // 给每个 widget 绑定动态双语 label（随语言切换）
                if (w.name === '帧率' || w.name === '文件名前缀' || w.name === '格式' || w.name === 'CRF' || w.name === '模式') {
                    w._xzgLabel = () => _tr(w.name);
                }
                if (w.name === '格式') {
                    w.draw = _xzgDrawComboWidget;
                    w.mouse = _xzgFpsComboMouse;
                    w.value = String(w.value ?? "mp4");
                    w.options = w.options || {};
                    w.options.values = ["mp4", "webm", "gif"];
                    // 格式：保持英文原样（技术名词不翻译）
                    w._xzgDisplayVal = (v) => String(v);
                } else if (w.name === '帧率') {
                    w.draw = _xzgDrawWidget;
                    w._xzgValueColor = '#fff';
                    if (typeof w.mouse !== 'function') w.mouse = _xzgWidgetNumberMouse;
                } else if (w.name === '文件名前缀') {
                    // STRING 文本框：圆角矩形 + 标签 + 值
                    w.draw = _xzgDrawWidget;
                    if (!w._xzgValueColor) w._xzgValueColor = '#fff';
                } else if (w.name === 'CRF') {
                    w.draw = function(ctx, node, width, y, H) {
                        // 属性面板 reflow 时防止溢出节点
                        const _nW = node?.size?.[0], _nH = node?.size?.[1];
                        if (_nW != null && _nW > 0) width = Math.max(1, Math.min(width, _nW));
                        if (_nH != null && _nH > 0) H = Math.max(1, Math.min(H, Math.max(0, _nH - y)));
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
                        ctx.fillText((this._xzgLabel ? this._xzgLabel() : (this.label || this.name || '')), pad + 6, y + H / 2);
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
                        ctx.fillText(_tr('数值越大质量越差 默认19'), width - pad - 6 - vw - 10, y + H / 2);
                    };
                } else if (w.name === '模式') {
                    // 模式：保存/预览 切换开关（与音频保存一致）
                    w.value = String(w.value ?? "保存");
                    w.options = w.options || {};
                    w.options.values = ["保存", "预览"];
                    w._xzgDisplayVal = (v) => _tr(String(v));
                    w.draw = function(ctx, nd, width, y, H) {
                        // 属性面板 reflow 时防止溢出节点
                        const _nW = nd?.size?.[0], _nH = nd?.size?.[1];
                        if (_nW != null && _nW > 0) width = Math.max(1, Math.min(width, _nW));
                        if (_nH != null && _nH > 0) H = Math.max(1, Math.min(H, Math.max(0, _nH - y)));
                        this._xzgDrawW = width;
                        const pad = 16, r = 6, wr = width - pad * 2;
                        ctx.fillStyle = '#2a2a2a';
                        ctx.beginPath();
                        if (ctx.roundRect) ctx.roundRect(pad, y + 1, wr, H - 2, r); else ctx.rect(pad, y + 1, wr, H - 2);
                        ctx.fill();
                        ctx.strokeStyle = '#444';
                        ctx.stroke();
                        // 左侧标签
                        ctx.fillStyle = '#9ab';
                        ctx.font = '12px sans-serif';
                        ctx.textAlign = 'left';
                        ctx.textBaseline = 'middle';
                        ctx.fillText((this._xzgLabel ? this._xzgLabel() : '模式'), pad + 6, y + H / 2);
                        // 右侧状态：保存=金色，预览=蓝色
                        const isSave = this.value !== '预览';
                        const dispVal = this._xzgDisplayVal ? this._xzgDisplayVal(this.value || '保存') : (this.value || '保存');
                        ctx.fillStyle = isSave ? '#FFD700' : '#88ccff';
                        ctx.font = '13px sans-serif';
                        ctx.textAlign = 'right';
                        ctx.fillText(dispVal, width - pad - 6, y + H / 2);
                    };
                    w.mouse = function(event, [x, y], node) {
                        // 拦截命中，阻止 ComfyUI 把点击交给原生逻辑弹输入框；pointerup 才会切换
                        if (event.type === 'pointerdown') return true;
                        if (event.type === 'pointerup') {
                            this.value = (this.value === '预览') ? '保存' : '预览';
                            node.setDirtyCanvas?.(true, true);
                            updateOutputDirDisplay();
                            return true;
                        }
                        return true;
                    };
                }
            }

            requestAnimationFrame(() => player.resize());
        };

        // 绕过状态更新（画布重绘时同步）
        const origOnDrawBackground = nodeType.prototype.onDrawBackground;
        nodeType.prototype.onDrawBackground = function (ctx) {
            if (this._xzgUpdateBypassState) {
                this._xzgUpdateBypassState();
            }
            return origOnDrawBackground?.apply(this, arguments);
        };
    },
});

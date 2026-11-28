import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { xzgT } from "./xzg_i18n.js";

const maskHistoryRecorders = new WeakMap();
const queueMaskHistory = api.queuePrompt;
api.queuePrompt = async function (index, prompt, ...args) {
    const pending = [];
    if (!prompt?.xzgExecuteToNode) {
        for (const [id, entry] of Object.entries(prompt?.output || {})) {
            if (entry.class_type !== "VideoWatermarkDetector") continue;
            const node = app.graph?.getNodeById(id);
            const record = node && maskHistoryRecorders.get(node);
            const data = entry.inputs?.regions_data;
            if (record && typeof data === "string") pending.push([record, data]);
        }
    }
    const result = await queueMaskHistory.call(this, index, prompt, ...args);
    if (result?.prompt_id != null) {
        for (const [record, data] of pending) record(data);
    }
    return result;
};

const getRealURL = obj => {
    return api.apiURL(`/view?filename=${encodeURIComponent(obj.filename)}&type=${obj.type}&subfolder=${obj.subfolder}&rand=${Math.random()}`)
}

const chainCallback = (object, property, callback) => {
    if (object == undefined) {
        console.error("Tried to add callback to non-existant object")
        return;
    }
    if (property in object) {
        const callback_orig = object[property]
        object[property] = function () {
            const r = callback_orig.apply(this, arguments);
            callback.apply(this, arguments);
            return r
        };
    } else {
        object[property] = callback;
    }
}

// ============================================================================
// 会话级点缓存：切换工作流 / 更换图片均不丢失；仅刷新浏览器（模块重载）后清空
// key: `${workflowKey}::${nodeId}`，value 与 info widget 的 JSON 同构
// ============================================================================
const POINTS_SESSION_CACHE = new Map();

const getSessionWfKey = () => {
    try {
        const wfStore = app?.extensionManager?.workflow;
        if (wfStore?.workflows && Array.isArray(wfStore.workflows) && typeof wfStore.isActive === 'function') {
            const wf = wfStore.workflows.find(w => wfStore.isActive(w));
            if (wf) return String(wf.path || wf.name || wf.id || "");
        }
    } catch (e) {}
    return "";
};

const sessionCacheKey = (node) => `${getSessionWfKey()}::${node?.id}`;

app.registerExtension({
    name: "Comfy.Xiaozhuguang.PointsEditor",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        const nodeName = nodeData.name;
        if (nodeName === "XiaozhuguangPointsEditor") {
            chainCallback(nodeType.prototype, "onNodeCreated", function() {
                const container = document.createElement("div");
                // 高度由 ComfyUI 的 DOM widget 布局统一管理，避免画布缩放后出现透明溢出区域。
                container.style.cssText = "position: relative; width: 100%; min-width: 0; min-height: 0; background: #0f1011; overflow: hidden; box-sizing: border-box; border-radius: 4px; margin: 0; padding: 0; display: flex; flex-direction: column;";

                const toolbar = document.createElement("div");
                toolbar.style.cssText = "flex: 0 0 32px; width: 100%; background: #222; display: flex; align-items: center; justify-content: space-between; padding: 0 4px; box-sizing: border-box; border-bottom: 1px solid #333; z-index: 10;";

                const leftGroup = document.createElement("div");
                leftGroup.style.display = "flex";
                leftGroup.style.gap = "4px";

                const createBtn = (iconSvg, title, onClick, isActive = false) => {
                    const btn = document.createElement("div");
                    btn.style.cssText = `width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; cursor: pointer; border-radius: 4px; color: ${isActive ? '#fff' : '#ccc'}; background-color: ${isActive ? '#444' : 'transparent'};`;
                    btn.innerHTML = iconSvg;
                    btn.title = title;
                    btn.onmouseover = () => { if (!btn.classList.contains("active")) btn.style.backgroundColor = "#333"; };
                    btn.onmouseout = () => { if (!btn.classList.contains("active")) btn.style.backgroundColor = "transparent"; };
                    btn.onclick = onClick;
                    return btn;
                };

                const undoIcon = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z"/></svg>`;
                const redoIcon = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M18.4 10.6C16.55 9 14.15 8 11.5 8c-4.65 0-8.58 3.03-9.96 7.22L3.9 16c1.05-3.19 4.05-5.5 7.6-5.5 1.95 0 3.73.72 5.12 1.88L13 16h9V7l-3.6 3.6z"/></svg>`;
                const resetIcon = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`;
                const pointIcon = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>`;
                const boxIcon = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2" stroke-dasharray="4 4"/></svg>`;
                const undoBtn = createBtn(undoIcon, "撤销", () => this.undo());
                const redoBtn = createBtn(redoIcon, "重做", () => this.redo());
                const resetBtn = createBtn(resetIcon, "清空全部", () => {
                    const { positivePoints, negativePoints, bboxes } = this.canvasWidget;
                    if (positivePoints.length === 0 && negativePoints.length === 0 && bboxes.length === 0) return;
                    this.canvasWidget.positivePoints = [];
                    this.canvasWidget.negativePoints = [];
                    this.canvasWidget.bboxes = [];
                    this.canvasWidget.history = [];
                    this.canvasWidget.historyIndex = -1;
                    this.redrawCanvas();
                    this.updateUndoRedoUI();
                    this.updateWidgetValue();
                });

                leftGroup.appendChild(undoBtn);
                leftGroup.appendChild(redoBtn);
                leftGroup.appendChild(resetBtn);

                const rightGroup = document.createElement("div");
                rightGroup.style.display = "flex";
                rightGroup.style.gap = "4px";

                let pointBtn, boxBtn;

                const setMode = (mode) => {
                    this.canvasWidget.mode = mode;
                    pointBtn.style.backgroundColor = mode === 'point' ? '#444' : 'transparent';
                    pointBtn.classList.toggle("active", mode === 'point');
                    pointBtn.style.color = mode === 'point' ? '#fff' : '#ccc';
                    boxBtn.style.backgroundColor = mode === 'box' ? '#444' : 'transparent';
                    boxBtn.classList.toggle("active", mode === 'box');
                    boxBtn.style.color = mode === 'box' ? '#fff' : '#ccc';
                    // 修复 7: 框模式用 crosshair，点模式也用 crosshair（统一）
                    canvas.style.cursor = 'crosshair';
                };

                pointBtn = createBtn(pointIcon, "点模式 (P)", () => setMode('point'), true);
                pointBtn.classList.add("active");
                boxBtn = createBtn(boxIcon, "框模式 (B)", () => setMode('box'), false);

                rightGroup.appendChild(pointBtn);
                rightGroup.appendChild(boxBtn);

                toolbar.appendChild(leftGroup);
                toolbar.appendChild(rightGroup);
                container.appendChild(toolbar);

                const canvasWrapper = document.createElement("div");
                canvasWrapper.style.cssText = "flex: 1 1 0; width: 100%; min-width: 0; min-height: 0; position: relative; overflow: hidden; display: flex; align-items: center; justify-content: center; background: #0f1011;";
                container.appendChild(canvasWrapper);

                const canvas = document.createElement("canvas");
                canvas.width = 512;
                canvas.height = 512;
                canvas.style.cssText = "display: block; width: 100%; height: 100%; min-width: 0; min-height: 0; object-fit: contain; cursor: crosshair;";
                canvasWrapper.appendChild(canvas);

                const ctx = canvas.getContext("2d");

                const tracker = document.createElement("div");
                // 始终占位 48px：播放条槽（20px）+ 帧显示行，多帧/单帧布局统一，避免切换时画布尺寸跳变
                tracker.style.cssText = "flex: 0 0 48px; width: 100%; background: #222; display: flex; flex-direction: column; align-items: stretch; gap: 3px; padding: 4px 8px; box-sizing: border-box; border-top: 1px solid #333;";

                // 播放条槽（无阴影背景）：播放头滑块放入其中，位于帧显示上方
                const kfBar = document.createElement("div");
                kfBar.className = "xzg-kfbar";
                kfBar.style.cssText = "position:relative;width:100%;height:20px;background:transparent;border-radius:2px;";

                const frameInfo = document.createElement("div");
                frameInfo.style.cssText = "color: #ccc; font-family: monospace; font-size: 14px; min-width: 40px; text-align: center; user-select: none;";
                frameInfo.innerText = "0/0";

                const slider = document.createElement("input");
                slider.type = "range";
                slider.min = "0";
                slider.max = "0";
                slider.value = "0";
                slider.step = "1";
                slider.disabled = true;
                slider.style.cssText = "position:absolute;left:0;top:50%;transform:translateY(-50%);width:100%;height:4px;cursor:default;accent-color:#e8c547;opacity:0.3;pointer-events:none;";

                tracker.appendChild(kfBar);
                kfBar.appendChild(slider);
                tracker.appendChild(frameInfo);
                container.appendChild(tracker);

                slider.addEventListener("input", (e) => {
                    // 帧号 0..总帧数：v=0 第1帧，v=总帧数显示最后一帧画面（30帧时 0..30，0/30、29/30、30/30）
                    const v = parseInt(e.target.value);
                    this.canvasWidget.frameIndex = v;
                    const idx = Math.min(v, Math.max(0, this.canvasWidget.previewFrames.length - 1));
                    this.canvasWidget.frameInfo.innerText = `${v}/${this.canvasWidget.previewFrames.length}`;
                    this.updateWidgetValue();

                    const img = new Image();
                    img.onload = () => {
                        applyCanvasImage(img);
                    };
                    img.src = getRealURL(this.canvasWidget.previewFrames[idx]);
                });

                this.canvasWidget = {
                    canvas: canvas,
                    canvasWrapper: canvasWrapper,   // prototype.redrawCanvas 通过它取容器尺寸
                    ctx: ctx,
                    container: container,
                    tracker: tracker,
                    slider: slider,
                    frameInfo: frameInfo,
                    image: null,
                    positivePoints: [],
                    negativePoints: [],
                    bboxes: [],
                    hoveredItem: null,     // 修复 1: 悬停标记 {type:'point', subType:'pos'|'neg', index}
                    movingItem: null,       // 修复 1: 拖拽移动中的项目
                    mode: 'point',
                    history: [],
                    historyIndex: -1,
                    isDrawingBox: false,
                    currentBox: null,
                    frameIndex: 0,
                    previewFrames: [],
                    clarity: 1.0,           // 修复 8: 前端知晓清晰度
                    MAX_HISTORY: 50,        // 修复 5: 限制历史数量
                    // 性能优化：原图渲染的离屏缓存 + rAF 合并标记
                    _baseCache: (() => { const c = document.createElement("canvas"); c.width = 1; c.height = 1; return c; })(),
                    _baseKey: null,          // { image, w, h }：决定是否重建原图缓存
                    _redrawScheduled: false,
                };

                // 修复（同「视频加载器」栏）：显式传 hideOnZoom: false，
                // 否则 ComfyUI 默认 hideOnZoom: true，画布缩放低于阈值（low_quality）时
                // 会把整个点编辑器 DOM 设成 display:none，缩小画布后预览即消失。
                const widget = this.addDOMWidget("canvas", "points_editor", container, { hideOnZoom: false });
                // DOM widget 的外层可能比可见内容更大。根容器默认点击穿透，只有真实
                // 交互区接收事件，避免节点下方的透明占位拦截画布拖动或滚轮缩放。
                container.style.pointerEvents = "none";
                toolbar.style.pointerEvents = "auto";
                canvasWrapper.style.pointerEvents = "auto";
                tracker.style.pointerEvents = "auto";
                // 修复（同「视频/音频」栏）：ComfyUI 会把 DOM widget 的 width 写成面板侧行宽度，
                // 而画布侧 DOM 宿主宽度 = widget.width - margin*2，一旦该值大于节点实际宽度，
                // 点编辑画布就会溢出节点、且随属性面板开/关变化。
                // 这里把 width 改为只读访问器，始终跟随节点实际宽度（node），忽略污染性写入。
                const _xzgPtNode = this;
                Object.defineProperty(widget, 'width', {
                    configurable: true,
                    get() { return _xzgPtNode?.size?.[0] || 0; },
                    set(_) { /* 忽略外部写入，防止点编辑画布溢出节点 */ },
                });
                this.canvasWidget.domWidget = widget;

                const infoWidget = this.widgets.find(w => w.name == 'info')
                if (infoWidget) {
                    infoWidget.computeSize = _ => [0, 0];
                    infoWidget.hidden = true;
                    this._infoWidget = infoWidget;
                    setTimeout(() => {
                        if (infoWidget.element) infoWidget.element.style.display = 'none';
                        if (infoWidget.inputEl) infoWidget.inputEl.style.display = 'none';
                    }, 50);
                }
                setTimeout(_ => {
                    // 恢复优先级：会话缓存（切工作流回来 / 撤销删除） > info widget（工作流文件保存的点）
                    let data = null;
                    try {
                        const cached = POINTS_SESSION_CACHE.get(sessionCacheKey(this));
                        if (cached) data = cached;
                    } catch (e) {}
                    if (!data && infoWidget && infoWidget.value) {
                        try { data = JSON.parse(infoWidget.value); } catch (e) { data = null; }
                    }
                    if (data) {
                        if (Array.isArray(data.positive_coords)) {
                            this.canvasWidget.positivePoints = data.positive_coords.map(p => ({ x: p.x, y: p.y }));
                        }
                        if (Array.isArray(data.negative_coords)) {
                            this.canvasWidget.negativePoints = data.negative_coords.map(p => ({ x: p.x, y: p.y }));
                        }
                        if (Array.isArray(data.bbox)) {
                            this.canvasWidget.bboxes = data.bbox.map(b => ({ x: b.x, y: b.y, w: b.w, h: b.h }));
                        }
                        if (typeof data.frame_index === 'number' && this.canvasWidget.slider) {
                            this.canvasWidget.frameIndex = data.frame_index;
                            this.canvasWidget.slider.value = data.frame_index;
                            // 刷新后尚未执行（无预览帧）：显示 0/0，避免无画面却出现 "12/1" 这类残留帧号
                            this.canvasWidget.frameInfo.innerText = this.canvasWidget.previewFrames.length
                                ? `${data.frame_index}/${this.canvasWidget.previewFrames.length}`
                                : "0/0";
                        }
                        // 同步回 info widget：未执行前保存工作流也能带上点数据
                        if (infoWidget) {
                            infoWidget.value = JSON.stringify({
                                positive_coords: this.canvasWidget.positivePoints,
                                negative_coords: this.canvasWidget.negativePoints,
                                bbox: this.canvasWidget.bboxes,
                                frame_index: this.canvasWidget.frameIndex
                            });
                        }
                        this.redrawCanvas();
                    }
                }, 1)

                // 不设置 computeSize（旧的 [width, -1] 会短路 ComfyUI 的弹性布局，
                // 导致 DOM 容器在缩放时溢出节点）。由 computeLayoutSize 提供最小高度，
                // 其余空间交给前端 DOM widget 统一计算和缩放。
                widget.computeLayoutSize = () => ({ minHeight: 270, minWidth: 0 });
                chainCallback(this, "onDrawForeground", function(ctx) {
                    syncCanvasSize();
                });
                if (typeof ResizeObserver !== "undefined") {
                    const resizeObserver = new ResizeObserver(() => syncCanvasSize());
                    resizeObserver.observe(canvasWrapper);
                    chainCallback(this, "onRemoved", () => resizeObserver.disconnect());
                }

                chainCallback(this, "onExecuted", function(message) {
                    if (message.preview && message.preview[0]) {
                        const { preview_str } = message.preview[0];
                        const previewData = JSON.parse(preview_str);
                        this.canvasWidget.previewFrames = previewData;
                        // 不再因图像变化（is_init）重置点：换图/重跑仅更新预览，点与历史保留
                        if (previewData.length > 1) {
                            // 多帧：启用滑条
                            slider.disabled = false;
                            slider.style.opacity = "1";
                            slider.style.pointerEvents = "";
                            slider.style.cursor = "pointer";
                            slider.max = previewData.length;
                            slider.value = Math.min(this.canvasWidget.frameIndex, previewData.length);
                            this.canvasWidget.frameInfo.innerText = `${Math.min(this.canvasWidget.frameIndex, previewData.length)}/${previewData.length}`;
                        } else {
                            // 单帧：tracker 保持占位，禁用滑条，布局与多帧一致
                            slider.disabled = true;
                            slider.style.opacity = "0.3";
                            slider.style.pointerEvents = "none";
                            slider.style.cursor = "default";
                            slider.max = 0;
                            slider.value = 0;
                            this.canvasWidget.frameIndex = 0;
                            this.canvasWidget.frameInfo.innerText = previewData.length === 1 ? "0/1" : "0/0";
                        }

                        const img = new Image();
                        img.onload = () => {
                            applyCanvasImage(img);
                        };

                        if (previewData?.length > 0) {
                            if (this.canvasWidget.frameIndex > previewData.length) {
                                // 新预览帧数变少：钳制到顶端（保持查看位置，不重置点）。画面索引取 min(v, 总帧数-1) →
                                this.canvasWidget.frameIndex = previewData.length;
                            }
                            slider.value = Math.min(this.canvasWidget.frameIndex, previewData.length);
                            this.canvasWidget.frameInfo.innerText = `${Math.min(this.canvasWidget.frameIndex, previewData.length)}/${previewData.length}`;
                            img.src = getRealURL(previewData[Math.min(this.canvasWidget.frameIndex, previewData.length - 1)]);
                        }
                    }
                });

                // 修复 5: 优化历史记录——限制数量，使用浅拷贝替代深拷贝
                this.addToHistory = () => {
                    const { positivePoints, negativePoints, bboxes, history, historyIndex, MAX_HISTORY } = this.canvasWidget;
                    if (historyIndex < history.length - 1) {
                        this.canvasWidget.history = history.slice(0, historyIndex + 1);
                    }
                    const state = {
                        positivePoints: positivePoints.map(p => ({ x: p.x, y: p.y })),
                        negativePoints: negativePoints.map(p => ({ x: p.x, y: p.y })),
                        bboxes: bboxes.map(b => ({ x: b.x, y: b.y, w: b.w, h: b.h }))
                    };
                    this.canvasWidget.history.push(state);
                    this.canvasWidget.historyIndex++;
                    // 限制历史数量
                    if (this.canvasWidget.history.length > MAX_HISTORY) {
                        this.canvasWidget.history.shift();
                        this.canvasWidget.historyIndex--;
                    }
                    this.updateUndoRedoUI();
                    this.updateWidgetValue();
                };

                this.undo = () => {
                    const { history, historyIndex } = this.canvasWidget;
                    if (historyIndex > 0) {
                        this.canvasWidget.historyIndex--;
                        const state = history[this.canvasWidget.historyIndex];
                        this.restoreState(state);
                    } else if (historyIndex === 0) {
                        this.canvasWidget.historyIndex--;
                        this.restoreState({ positivePoints: [], negativePoints: [], bboxes: [] });
                    }
                    this.updateUndoRedoUI();
                };

                this.redo = () => {
                    const { history, historyIndex } = this.canvasWidget;
                    if (historyIndex < history.length - 1) {
                        this.canvasWidget.historyIndex++;
                        const state = history[this.canvasWidget.historyIndex];
                        this.restoreState(state);
                    }
                    this.updateUndoRedoUI();
                };

                this.restoreState = (state) => {
                    this.canvasWidget.positivePoints = state.positivePoints.map(p => ({ x: p.x, y: p.y }));
                    this.canvasWidget.negativePoints = state.negativePoints.map(p => ({ x: p.x, y: p.y }));
                    this.canvasWidget.bboxes = state.bboxes.map(b => ({ x: b.x, y: b.y, w: b.w, h: b.h }));
                    this.redrawCanvas();
                    this.updateWidgetValue();
                };

                this.updateUndoRedoUI = () => {
                    const { historyIndex, history, positivePoints, negativePoints, bboxes } = this.canvasWidget;
                    undoBtn.style.color = historyIndex >= 0 ? '#ccc' : '#555';
                    undoBtn.style.cursor = historyIndex >= 0 ? 'pointer' : 'default';
                    redoBtn.style.color = historyIndex < history.length - 1 ? '#ccc' : '#555';
                    redoBtn.style.cursor = historyIndex < history.length - 1 ? 'pointer' : 'default';
                    const hasContent = positivePoints.length > 0 || negativePoints.length > 0 || bboxes.length > 0;
                    resetBtn.style.color = hasContent ? '#ccc' : '#555';
                    resetBtn.style.cursor = hasContent ? 'pointer' : 'default';
                };

                this.updateWidgetValue = () => {
                    const { positivePoints, negativePoints, bboxes, image, frameIndex } = this.canvasWidget;
                    // 输出真实帧索引：UI 帧号 clamp 到 [0, 总帧数-1]
                    const realIdx = Math.min(frameIndex, Math.max(0, this.canvasWidget.previewFrames.length - 1));
                    const info_widget = this._infoWidget;
                    if (info_widget) {
                        info_widget.value = image ? JSON.stringify({
                            positive_coords: positivePoints,
                            negative_coords: negativePoints,
                            bbox: bboxes,
                            frame_index: realIdx
                        }) : '';
                    }
                    // 写入会话缓存（深拷贝）：换图 / 切工作流后不丢失，仅刷新浏览器清空
                    try {
                        POINTS_SESSION_CACHE.set(sessionCacheKey(this), {
                            positive_coords: positivePoints.map(p => ({ x: p.x, y: p.y })),
                            negative_coords: negativePoints.map(p => ({ x: p.x, y: p.y })),
                            bbox: bboxes.map(b => ({ x: b.x, y: b.y, w: b.w, h: b.h })),
                            frame_index: realIdx
                        });
                    } catch (e) {}
                }

                // 性能优化：用 requestAnimationFrame 合并 mousemove 期间的多次重绘，一帧只画一次
                this.scheduleRedraw = () => {
                    const w = this.canvasWidget;
                    if (w._redrawScheduled) return;
                    w._redrawScheduled = true;
                    requestAnimationFrame(() => {
                        w._redrawScheduled = false;
                        this.redrawCanvas();
                    });
                };

                // ===== 黑边布局：画布位图 = 容器尺寸（×devicePixelRatio），图像在中间 contain 显示 =====
                // 四周强制保留 ≥ MIN_EDGE_BLACK(15px) 黑边；比例不适配造成的黑色留白也属于黑边（均可起笔框选）。
                const MIN_EDGE_BLACK = 15;
                const calcImageLayout = () => {
                    const dispW = canvasWrapper.clientWidth || 1;
                    const dispH = canvasWrapper.clientHeight || 1;
                    const w = this.canvasWidget;
                    const imgW = w.image ? (w.image.width || 1) : 1;
                    const imgH = w.image ? (w.image.height || 1) : 1;
                    const cw = Math.max(1, dispW - MIN_EDGE_BLACK * 2);
                    const ch = Math.max(1, dispH - MIN_EDGE_BLACK * 2);
                    const imgRatio = imgW / imgH;
                    const cRatio = cw / ch;
                    let drawW, drawH;
                    if (imgRatio > cRatio) { drawW = cw; drawH = cw / imgRatio; }
                    else { drawH = ch; drawW = ch * imgRatio; }
                    return {
                        dispW, dispH, imgW, imgH,
                        imgLeft: (dispW - drawW) / 2,
                        imgTop: (dispH - drawH) / 2,
                        drawW, drawH,
                        scale: drawW / imgW,
                    };
                };
                // redrawCanvas 是 prototype 方法，闭包变量不可达：把布局函数挂到 canvasWidget 供其调用
                this.canvasWidget.calcImageLayout = calcImageLayout;

                // 画布位图尺寸 = 容器像素 × devicePixelRatio（高分屏清晰）；节点 resize / 换图 / 跨屏时才变化
                const syncCanvasSize = () => {
                    const dpr = window.devicePixelRatio || 1;
                    const bw = Math.max(1, Math.round((canvasWrapper.clientWidth || 1) * dpr));
                    const bh = Math.max(1, Math.round((canvasWrapper.clientHeight || 1) * dpr));
                    if (canvas.width !== bw || canvas.height !== bh) {
                        canvas.width = bw;
                        canvas.height = bh;
                        this.redrawCanvas();
                    }
                };

                // 换图/换帧：更新当前图像并重绘（位图尺寸由 syncCanvasSize 同步）
                const applyCanvasImage = (img) => {
                    this.canvasWidget.image = img;
                    syncCanvasSize();
                    this.redrawCanvas();
                };

                // 坐标转换：屏幕像素 → 图像坐标（基于图像在画布内的 contain 布局）
                // allowOut=true（画框）时允许坐标进入四周黑边（强制 5px 边距 + 比例不适配留白），
                // 从而可以从黑边起笔、向图像内框选；点模式仍钳制在图像范围内。
                const getCoords = (e, allowOut = false) => {
                    const rect = canvas.getBoundingClientRect();
                    const L = calcImageLayout();
                    // ComfyUI 缩放画布时 DOM widget 层整体被 CSS transform scale：
                    // getBoundingClientRect() 返回缩放后的屏幕尺寸，而布局计算基于
                    // clientWidth（CSS 布局尺寸）。把屏幕偏移按 rect/布局 比值归一化，
                    // 回到与绘制一致的布局坐标系，否则缩放后画框/悬停会错位不跟手。
                    const kx = rect.width > 0 ? L.dispW / rect.width : 1;
                    const ky = rect.height > 0 ? L.dispH / rect.height : 1;
                    const cssX = (e.clientX - rect.left) * kx;
                    const cssY = (e.clientY - rect.top) * ky;
                    let x = (cssX - L.imgLeft) / L.scale;
                    let y = (cssY - L.imgTop) / L.scale;
                    if (allowOut) {
                        const mx = Math.max(L.imgLeft / L.scale, MIN_EDGE_BLACK / L.scale);
                        const my = Math.max(L.imgTop / L.scale, MIN_EDGE_BLACK / L.scale);
                        return {
                            x: Math.max(-mx, Math.min(L.imgW + mx, x)),
                            y: Math.max(-my, Math.min(L.imgH + my, y))
                        };
                    }
                    return {
                        x: Math.max(0, Math.min(L.imgW, x)),
                        y: Math.max(0, Math.min(L.imgH, y))
                    };
                };

                // 修复 1: 查找附近的可交互项目
                const findHitItem = (coords, image) => {
                    if (!image) return null;
                    const w = this.canvasWidget;
                    const pointRadius = Math.max(4, Math.min(image.width, image.height) * 0.015);
                    // 先检查正面点
                    for (let i = w.positivePoints.length - 1; i >= 0; i--) {
                        const p = w.positivePoints[i];
                        if (Math.hypot(coords.x - p.x, coords.y - p.y) < pointRadius) {
                            return { type: 'point', subType: 'pos', index: i };
                        }
                    }
                    // 再检查负面点
                    for (let i = w.negativePoints.length - 1; i >= 0; i--) {
                        const p = w.negativePoints[i];
                        if (Math.hypot(coords.x - p.x, coords.y - p.y) < pointRadius) {
                            return { type: 'point', subType: 'neg', index: i };
                        }
                    }
                    // 检查边界框
                    for (let i = w.bboxes.length - 1; i >= 0; i--) {
                        const b = w.bboxes[i];
                        if (coords.x >= b.x && coords.x <= b.x + b.w && coords.y >= b.y && coords.y <= b.y + b.h) {
                            return { type: 'box', index: i };
                        }
                    }
                    return null;
                };

                canvasWrapper.addEventListener('pointerdown', (e) => {
                    // 指针捕获：从边缘按下并拖出画布/节点时，后续 pointermove/pointerup
                    // 仍持续派发到本元素，避免松手在画布外导致事件丢失、框永远画不完。
                    try { canvasWrapper.setPointerCapture(e.pointerId); } catch (_) {}
                    const coords = getCoords(e);
                    const w = this.canvasWidget;
                    if (!w.image) return;

                    // 修复 1: Shift+左键 = 拖拽移动已有点/框
                    if (e.shiftKey && e.button === 0) {
                        const hit = findHitItem(coords, w.image);
                        if (hit) {
                            w.movingItem = { ...hit, startX: coords.x, startY: coords.y };
                            return;
                        }
                    }

                    const { mode } = w;
                    if (mode === 'point') {
                        // 修复 1: 右键点击已有项 = 删除
                        if (e.button === 2) {
                            const hit = findHitItem(coords, w.image);
                            if (hit) {
                                e.preventDefault();
                                if (hit.type === 'point') {
                                    if (hit.subType === 'pos') w.positivePoints.splice(hit.index, 1);
                                    else w.negativePoints.splice(hit.index, 1);
                                } else {
                                    w.bboxes.splice(hit.index, 1);
                                }
                                w.hoveredItem = null;
                                this.addToHistory();
                                this.redrawCanvas();
                                return;
                            }
                        }

                        if (e.button === 0) {
                            // 左键不覆盖已有项 = 添加新点
                            const hit = findHitItem(coords, w.image);
                            if (!hit) {
                                w.positivePoints.push({ x: coords.x, y: coords.y });
                                this.addToHistory();
                                this.redrawCanvas();
                            }
                        } else if (e.button === 2 && !findHitItem(coords, w.image)) {
                            // 右键空白处 = 添加负面点
                            w.negativePoints.push({ x: coords.x, y: coords.y });
                            this.addToHistory();
                            this.redrawCanvas();
                        }
                    } else if (mode === 'box') {
                        if (e.button === 0) {
                            const hit = findHitItem(coords, w.image);
                            if (!hit || hit.type !== 'box') {
                                // 画框允许从黑边起笔：用含黑边范围的坐标
                                const c2 = getCoords(e, true);
                                w.isDrawingBox = true;
                                w.currentBox = { x: c2.x, y: c2.y, w: 0, h: 0 };
                            }
                        } else if (e.button === 2) {
                            const hit = findHitItem(coords, w.image);
                            if (hit && hit.type === 'box') {
                                e.preventDefault();
                                w.bboxes.splice(hit.index, 1);
                                w.hoveredItem = null;
                                this.addToHistory();
                                this.redrawCanvas();
                                return;
                            }
                        }
                    }
                });

                canvasWrapper.addEventListener('pointermove', (e) => {
                    const w = this.canvasWidget;
                    const coords = getCoords(e);
                    if (!w.image) return;

                    // 修复 1: 拖拽移动项目
                    if (w.movingItem) {
                        const dx = coords.x - w.movingItem.startX;
                        const dy = coords.y - w.movingItem.startY;
                        if (w.movingItem.type === 'point') {
                            const arr = w.movingItem.subType === 'pos' ? w.positivePoints : w.negativePoints;
                            if (arr[w.movingItem.index]) {
                                arr[w.movingItem.index].x += dx;
                                arr[w.movingItem.index].y += dy;
                            }
                        } else {
                            if (w.bboxes[w.movingItem.index]) {
                                w.bboxes[w.movingItem.index].x += dx;
                                w.bboxes[w.movingItem.index].y += dy;
                            }
                        }
                        w.movingItem.startX = coords.x;
                        w.movingItem.startY = coords.y;
                        this.scheduleRedraw();
                        return;
                    }

                    const { mode, isDrawingBox, currentBox } = w;
                    // 修复 1: 悬停检测
                    w.hoveredItem = findHitItem(coords, w.image);
                    canvas.style.cursor = w.hoveredItem ? 'pointer' : 'crosshair';

                    if (mode === 'box' && isDrawingBox && currentBox) {
                        // 框终点允许进入黑边（与起点一致用含黑边坐标）
                        const c2 = getCoords(e, true);
                        currentBox.w = c2.x - currentBox.x;
                        currentBox.h = c2.y - currentBox.y;
                        this.scheduleRedraw();
                    }
                });

                canvasWrapper.addEventListener('pointerup', (e) => {
                    const w = this.canvasWidget;
                    if (!w.image) return;

                    // 修复 1: 结束拖拽（记录历史）
                    if (w.movingItem) {
                        this.addToHistory();
                        w.movingItem = null;
                        this.redrawCanvas();
                        return;
                    }

                    const { mode, isDrawingBox, currentBox } = w;
                    if (mode === 'box' && isDrawingBox && currentBox) {
                        // 外边缘封闭：允许从黑边起笔/收笔，但最终换算时把超出图像
                        // 范围的部分钳制回图像边缘（黑边部分不计入实际框体）
                        const _iw = w.image ? w.image.width : 0;
                        const _ih = w.image ? w.image.height : 0;
                        const _bx1 = Math.min(currentBox.x, currentBox.x + currentBox.w);
                        const _by1 = Math.min(currentBox.y, currentBox.y + currentBox.h);
                        const _bx2 = Math.max(currentBox.x, currentBox.x + currentBox.w);
                        const _by2 = Math.max(currentBox.y, currentBox.y + currentBox.h);
                        const box = {
                            x: Math.max(0, Math.min(_bx1, _iw)),
                            y: Math.max(0, Math.min(_by1, _ih)),
                            w: 0,
                            h: 0
                        };
                        box.w = Math.max(0, Math.min(_bx2, _iw)) - box.x;
                        box.h = Math.max(0, Math.min(_by2, _ih)) - box.y;
                        if (box.w > 5 && box.h > 5) {
                            w.bboxes.push(box);
                            this.addToHistory();
                        }
                        w.isDrawingBox = false;
                        w.currentBox = null;
                        this.redrawCanvas();
                    }
                });

                // 滚轮事件转发给 ComfyUI 画布（整个节点区域都需要）
                const forwardWheel = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const cvs = app.canvas?.canvas;
                    if (cvs) {
                        const ev = new WheelEvent('wheel', {
                            deltaX: e.deltaX, deltaY: e.deltaY,
                            deltaMode: e.deltaMode,
                            clientX: e.clientX, clientY: e.clientY,
                            bubbles: true, cancelable: true
                        });
                        cvs.dispatchEvent(ev);
                    }
                };
                container.addEventListener('wheel', forwardWheel, { passive: false });

                canvasWrapper.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                });

                // 修复 1: 键盘快捷键
                const onKeyDown = (e) => {
                    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
                    switch (e.key.toLowerCase()) {
                        case 'delete':
                        case 'backspace':
                            // 删除最后添加的项目（简单实现）
                            if (this.canvasWidget.bboxes.length > 0) {
                                this.canvasWidget.bboxes.pop();
                                this.addToHistory();
                                this.redrawCanvas();
                            } else if (this.canvasWidget.positivePoints.length > 0) {
                                this.canvasWidget.positivePoints.pop();
                                this.addToHistory();
                                this.redrawCanvas();
                            } else if (this.canvasWidget.negativePoints.length > 0) {
                                this.canvasWidget.negativePoints.pop();
                                this.addToHistory();
                                this.redrawCanvas();
                            }
                            break;
                        case 'z':
                            if (e.ctrlKey && !e.shiftKey) {
                                e.preventDefault();
                                this.undo();
                            } else if (e.ctrlKey && e.shiftKey) {
                                e.preventDefault();
                                this.redo();
                            }
                            break;
                        case 'p':
                            setMode('point');
                            break;
                        case 'b':
                            setMode('box');
                            break;
                    }
                };
                document.addEventListener('keydown', onKeyDown);
                this._cleanupKeys = () => document.removeEventListener('keydown', onKeyDown);

                syncCanvasSize();
                this.redrawCanvas();

                // 只设置宽度限制初始大小，高度由 computeSize 动态决定
                const MIN_W = 270;
                const MIN_H = 350;
                const nodeWidth = Math.max(MIN_W, this.size[0] || MIN_W);
                const nodeHeight = Math.max(MIN_H, this.size[1] || MIN_H);
                this.setSize([nodeWidth, nodeHeight]);

                // 包装 setSize 强制最小尺寸约束，防止拖动过小
                const origSetSize = this.setSize.bind(this);
                this.setSize = function (size) {
                    const w = Math.max(size?.[0] || this.size?.[0] || MIN_W, MIN_W);
                    const h = Math.max(size?.[1] || this.size?.[1] || MIN_H, MIN_H);
                    return origSetSize([w, h]);
                };

                this.updateUndoRedoUI();
            });

            nodeType.prototype.redrawCanvas = function() {
                const { canvas, ctx, image, positivePoints, negativePoints, bboxes, currentBox, mode, _baseCache, _baseKey, canvasWrapper, calcImageLayout } = this.canvasWidget;
                const dpr = window.devicePixelRatio || 1;
                // 位图 = 容器 × dpr：之后统一用 CSS px 坐标绘制
                ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

                // 性能优化：无图像时画占位提示（文本绘制开销小，直接画一次即可）
                if (!image) {
                    if (this.canvasWidget._baseKey) this.canvasWidget._baseKey = null;
                    const dw = canvasWrapper.clientWidth || 300;
                    const dh = canvasWrapper.clientHeight || 300;
                    ctx.clearRect(0, 0, dw, dh);
                    ctx.fillStyle = "#0f1011";
                    ctx.fillRect(0, 0, dw, dh);
                    ctx.fillStyle = "#ddd";
                    ctx.font = "34px sans-serif";
                    ctx.textAlign = "center";
                    ctx.fillText("🖼️", dw / 2, dh / 2 - 50);
                    ctx.font = "20px sans-serif";
                    ctx.fillText("从您自己的图像或视频开始", dw / 2, dh / 2 + 10);
                    const tips = [
                        "左键：加正面点 | 右键：加负面点",
                        "左键拖动：画框  | 右键：删点/框",
                    ];
                    tips.forEach((t, i) => {
                        ctx.font = "14px sans-serif";
                        ctx.fillText(t, dw / 2, dh / 2 + 50 + i * 22);
                    });
                    return;
                }

                const L = calcImageLayout();

                // 性能优化：原图只在换图时才写进离屏 _baseCache（尺寸 = 图像原始像素），
                // 绘制时再缩放到画布上的显示区域；节点 resize 不清缓存。
                if (!_baseKey || _baseKey.image !== image) {
                    _baseCache.width = image.width || 1;
                    _baseCache.height = image.height || 1;
                    const bctx = _baseCache.getContext("2d");
                    bctx.clearRect(0, 0, _baseCache.width, _baseCache.height);
                    bctx.drawImage(image, 0, 0);
                    this.canvasWidget._baseKey = { image };
                }

                ctx.clearRect(0, 0, L.dispW, L.dispH);
                // 黑边：铺满整个画布（含强制 5px 边距与比例不适配留白，均可框选起笔）
                ctx.fillStyle = "#000000";
                ctx.fillRect(0, 0, L.dispW, L.dispH);
                // 图像居中绘制在黑色留白内
                ctx.drawImage(_baseCache, L.imgLeft, L.imgTop, L.drawW, L.drawH);

                let pointSize = Math.max(2, Math.min(L.drawW, L.drawH) * 0.008);

                // 绘制边界框（图像坐标 → 画布 CSS px：imgLeft + 图像像素 × scale）
                ctx.lineWidth = 2;
                for (const box of bboxes) {
                    const hit = this.canvasWidget.hoveredItem;
                    const isHovered = hit && hit.type === 'box' && bboxes[hit.index] === box;
                    ctx.strokeStyle = isHovered ? "#66bbff" : "#3399ff";
                    ctx.fillStyle = isHovered ? "rgba(102, 187, 255, 0.2)" : "rgba(51, 153, 255, 0.1)";
                    ctx.lineWidth = isHovered ? 3 : 2;
                    ctx.strokeRect(L.imgLeft + box.x * L.scale, L.imgTop + box.y * L.scale, box.w * L.scale, box.h * L.scale);
                    ctx.fillRect(L.imgLeft + box.x * L.scale, L.imgTop + box.y * L.scale, box.w * L.scale, box.h * L.scale);
                }

                if (currentBox) {
                    // 实时预览框同样在外边缘封闭：黑边内的拖拽段不显示框体，
                    // 预览框始终与最终换算结果一致（钳制在图像范围内）
                    const _iw = image ? image.width : 0;
                    const _ih = image ? image.height : 0;
                    const _bx1 = Math.min(currentBox.x, currentBox.x + currentBox.w);
                    const _by1 = Math.min(currentBox.y, currentBox.y + currentBox.h);
                    const _cx1 = Math.max(0, Math.min(_bx1, _iw));
                    const _cy1 = Math.max(0, Math.min(_by1, _ih));
                    const _cx2 = Math.max(0, Math.min(_bx1 + Math.abs(currentBox.w), _iw));
                    const _cy2 = Math.max(0, Math.min(_by1 + Math.abs(currentBox.h), _ih));
                    ctx.strokeStyle = "#0ff";
                    ctx.lineWidth = 2;
                    ctx.setLineDash([5, 5]);
                    ctx.strokeRect(L.imgLeft + _cx1 * L.scale, L.imgTop + _cy1 * L.scale, (_cx2 - _cx1) * L.scale, (_cy2 - _cy1) * L.scale);
                    ctx.setLineDash([]);
                }

                // 正面点
                for (let i = 0; i < positivePoints.length; i++) {
                    const point = positivePoints[i];
                    const hit = this.canvasWidget.hoveredItem;
                    const isHovered = hit && hit.type === 'point' && hit.subType === 'pos' && hit.index === i;
                    ctx.strokeStyle = isHovered ? "#33cc33" : "#139613";
                    ctx.fillStyle = isHovered ? "#33cc33" : "#139613";
                    ctx.lineWidth = isHovered ? 3 : 2;
                    ctx.beginPath();
                    ctx.arc(L.imgLeft + point.x * L.scale, L.imgTop + point.y * L.scale, pointSize, 0, 2 * Math.PI);
                    ctx.fill();
                    ctx.stroke();
                }

                // 负面点
                for (let i = 0; i < negativePoints.length; i++) {
                    const point = negativePoints[i];
                    const hit = this.canvasWidget.hoveredItem;
                    const isHovered = hit && hit.type === 'point' && hit.subType === 'neg' && hit.index === i;
                    ctx.strokeStyle = isHovered ? "#ff4444" : "#8A1616";
                    ctx.fillStyle = isHovered ? "#ff4444" : "#8A1616";
                    ctx.lineWidth = isHovered ? 3 : 2;
                    ctx.beginPath();
                    ctx.arc(L.imgLeft + point.x * L.scale, L.imgTop + point.y * L.scale, pointSize, 0, 2 * Math.PI);
                    ctx.fill();
                    ctx.stroke();
                }
            };
        }
    }
})

/* ============================================================================
 * 视频遮罩手工跟踪（原视频水印检测）- 区域标注视窗
 * 挂在「已被验证能加载」的 xzg_points_editor 模块内（复用其 import/chainCallback/getRealURL）。
 * 原因：独立模块 xzg_watermark_detect.js 在本 fork 的前端预加载中被丢弃（vite:preloadError），
 * 导致它从未执行；而点编辑器作为早期文件已进入预加载清单，可稳定加载。
 * 功能：执行后在预览帧上画「检测区 / 排除区」多框，写入 regions_data（后端按区域过滤）。
 * ========================================================================== */
function wm_ensureViewer(node) {
    if (node.wmdetWidget) return;   // 已有视窗
    try {
        const dataWidget = node.widgets?.find(w => w.name === 'regions_data');
        if (!dataWidget) {
            // 找不到新参数多半是后端未重启：旧版本 widget 名为 detect_region/detect_region_data
            const hasOld = node.widgets?.some(w => w.name === 'detect_region') || node.widgets?.some(w => w.name === 'detect_region_data');
            console.error(`[小珠光][水印] 找不到 filter_enabled/regions_data widget（hasOld=${!!hasOld}）。若 hasOld=true，请完全重启 ComfyUI 后端再刷新页面。`);
            return;
        }

        // ---- 容器（工具栏 + 帧控制栏 + 画布）----
        const container = document.createElement("div");
        container.style.cssText = "position: relative; width: 100%; background: #0f1011; overflow: hidden; box-sizing: border-box; border-radius: 4px; margin: 0; padding: 0; display: flex; flex-direction: column;";
        let trackingRequest = null;

        const toolbar = document.createElement("div");
        // 加高 8px（28→36）：容纳加大 4px 后的「点击加载视频」行，避免文字贴边
        toolbar.style.cssText = "flex:0 0 54px;width:100%;background:var(--xzg-wmdet-toolbar-bg,#222);display:flex;align-items:center;gap:12px;padding:0 12px;box-sizing:border-box;border-bottom:1px solid #333;z-index:10;overflow-x:auto;scrollbar-width:thin;";
        container.appendChild(toolbar);
        // 工具栏（点击加载视频这一栏）屏蔽浏览器原生右键菜单；
        // 轨道数字等自带右键菜单的元素会 stopPropagation，不受影响
        toolbar.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
        });

        let tStyle = document.getElementById("xzg-wmdet-title-css");
        if (!tStyle) { tStyle = document.createElement("style"); tStyle.id = "xzg-wmdet-title-css"; document.head.appendChild(tStyle); }
        tStyle.textContent = `.xzg-wmdet-title{font-family:sans-serif;font-size:14px;user-select:none;}
.xzg-wmdet-t-off{color:#e8c547;}
.xzg-wmdet-t-filter{background:linear-gradient(120deg,#3ef558 30%,#000000 50%,#3ef558 70%);background-size:200% 100%;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;animation:xzgWmdetSweep 4.5s linear infinite;}
.xzg-wmdet-t-manual{background:linear-gradient(120deg,#cba46c 30%,#000000 50%,#cba46c 70%);background-size:200% 100%;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;animation:xzgWmdetSweep 4.5s linear infinite;}
.xzg-wmdet-run-gold{color:#d8d8d8;animation:none;font-weight:400;}
.xzg-wmdet-ft-off{color:#e53935;animation:none;font-size:14px;font-weight:400;}
.xzg-wmdet-ft-filter{color:#3ef558;animation:none;font-size:14px;font-weight:400;}
.xzg-wmdet-ft-manual{color:#cba46c;animation:none;font-size:14px;font-weight:400;}
.xzg-wmdet-tracking > .xzg-wmdet-dim::after{content:"";position:absolute;inset:0;background:rgba(0,0,0,.6);z-index:31;cursor:wait;}
.xzg-wmdet-tracking{--xzg-wmdet-toolbar-bg:#0e0e0e;}
.xzg-wmdet-tracking .xzg-wmdet-dim-controls,.xzg-wmdet-tracking .xzg-wmdet-tracking-group > :not(.xzg-wmdet-tracking-active){filter:brightness(.4);}
.xzg-wmdet-tracking .xzg-wmdet-tracking-active{font-variant-numeric:tabular-nums;}
@keyframes xzgWmdetSweep{0%{background-position:130% 0;}100%{background-position:-30% 0;}}`;
        const trackBar = document.createElement("div");
        trackBar.style.cssText = "display:flex;flex:0 0 auto;align-items:center;justify-content:flex-start;gap:16px;";
        const colorTracks = document.createElement("div");
        colorTracks.style.cssText = "display:flex;align-items:center;gap:5px;";
        trackBar.appendChild(colorTracks);
        const trackBtns = [];
        let trackUnlocked = new Set([1]);
        const selectTrack = tid => {
            state.curveDraft = null; state.curveDrag = null; state.rectDrag = null;
            state.trackingAreaDraft = null;
            state.trackId = tid; state.shapeSelected = true;
            refreshTrackBtns();
            redraw();
        };
        for (let t = 1; t <= 8; t++) {
            (function(t){
                const b = document.createElement("div");
                // 随工具栏整体放大：框 14→20px、数字 14→18px，间隙 4→6px
                b.style.cssText = "width:20px;height:20px;display:flex;align-items:center;justify-content:center;cursor:pointer;border-radius:4px;font-size:14px;font-weight:400;user-select:none;border:1px solid transparent;position:relative;font-variant-numeric:tabular-nums;";
                b.innerText = String(t);
                // 选中圆点：当前选中轨道数字的高亮框下方的小圆点提醒（与数字同一中心）
                const dot = document.createElement("div");
                dot.style.cssText = "position:absolute;left:0;right:0;margin:0 auto;bottom:-5px;width:4px;height:4px;border-radius:50%;display:none;";
                b.appendChild(dot);
                b._dot = dot;
                b.onclick = (e) => {
                    e.stopPropagation();
                    selectTrack(t);
                };
                // 右键轨道数字：删除当前分类（轨道 1 不可删；删除后数字消失，可用「+」再加回）
                if (t > 1) b.addEventListener("contextmenu", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    showBarMenu(e.clientX, e.clientY, [
                        {
                            label: "删除当前分类",
                            fn: () => {
                                if (state.manualKeyframes[t]) delete state.manualKeyframes[t];
                                delete state.autoTracking.tracks[t];
                                if (state.trackingAreas) delete state.trackingAreas[t];
                                trackUnlocked.delete(t);
                                if (state.trackId === t) state.trackId = 1;
                                writeData();
                                redraw();           // redraw 内部会 drawKfBar，三角随之消失
                                refreshTrackBtns(); // 轨道边框/选中状态同步
                            },
                        },
                    ]);
                });
                Object.assign(b.style, {width: "28px", height: "30px", fontSize: "14px"});
                colorTracks.appendChild(b); trackBtns.push(b);
            })(t);
        }
        const addTrackBtn = document.createElement("button");
        addTrackBtn.type = "button";
        addTrackBtn.textContent = "+";
        addTrackBtn.title = "增加颜色轨道";
        addTrackBtn.setAttribute("aria-label", addTrackBtn.title);
        addTrackBtn.style.cssText = "width:22px;height:22px;padding:0;line-height:1;border:1px dashed #666;border-radius:4px;background:transparent;color:#aaa;font-size:14px;cursor:pointer;";
        addTrackBtn.onclick = e => {
            e.stopPropagation();
            const next = trackBtns.findIndex((_, index) => !trackUnlocked.has(index + 1)) + 1;
            if (!next) return;
            if (e.detail > 0) addTrackBtn.blur();
            trackUnlocked.add(next);
            selectTrack(next);
        };
        Object.assign(addTrackBtn.style, {width: "30px", height: "32px", fontSize: "14px"});
        colorTracks.appendChild(addTrackBtn);
        const fillEdgesBtn = document.createElement("button");
        fillEdgesBtn.type = "button";
        fillEdgesBtn.style.cssText = "width:30px;height:30px;padding:0;border:1px solid #666;border-radius:4px;color:#eee;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;";
        const refreshFillEdgesBtn = () => {
            const allowEmpty = !state.fillEdges;
            fillEdgesBtn.innerHTML = allowEmpty
                ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16v14H4z"/><path d="M8 9h8M8 12h5"/><path d="m4 20 16-16"/></svg>'
                : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16v14H4z"/><path d="M8 9h8M8 12h5"/><path d="M8 16h8"/></svg>';
            fillEdgesBtn.title = allowEmpty
                ? "允许遮罩为空：轨道首尾没有标注的帧留空（点击关闭）"
                : "允许遮罩为空：关闭，轨道首尾沿用最近的遮罩（点击开启）";
            fillEdgesBtn.setAttribute("aria-label", fillEdgesBtn.title);
            fillEdgesBtn.setAttribute("aria-pressed", String(allowEmpty));
            fillEdgesBtn.style.background = allowEmpty ? "#6b522b" : "#3a3a3c";
        };
        fillEdgesBtn.onclick = (e) => {
            e.stopPropagation();
            // Pointer clicks should not leave the toggle focused during frame stepping.
            if (e.detail > 0) fillEdgesBtn.blur();
            state.fillEdges = !state.fillEdges;
            refreshFillEdgesBtn();
            writeData();
            redraw();
        };
        Object.assign(fillEdgesBtn.style, {height: "30px"});
        trackBar.appendChild(fillEdgesBtn);
        // 仅显示当前分类：激活后播放条三角与画布画框只显示当前颜色轨道。
        // 文案/配色随状态切换：激活=当前分类色的单色文案；关闭=按 1-8 轨道色逐字对应的多彩文案
        let _solo = false;
        const soloBtn = document.createElement("div");
        soloBtn.style.cssText = "height:20px;padding:0 8px;display:flex;align-items:center;justify-content:center;cursor:pointer;border-radius:4px;background:#3a3a3c;font-size:14px;font-weight:400;user-select:none;white-space:nowrap;flex-shrink:0;margin-left:4px;border:none;box-sizing:border-box;";
        soloBtn.title = "仅显示当前颜色分类的关键帧与画框（再次点击恢复显示全部分类）";
        const SOLO_TEXT_ON = "显示当前";
        const SOLO_TEXT_OFF = "显示全部";
        const refreshSoloBtn = () => {
            if (_solo) {
                const c = TRACK_COLORS[(state.trackId - 1) % TRACK_COLORS.length];
                soloBtn.innerHTML = `<span style="color:${c}">${SOLO_TEXT_ON}</span>`;
                soloBtn.style.backgroundColor = "#4a4a4e";
            } else {
                soloBtn.innerHTML = SOLO_TEXT_OFF.split("").map((ch, i) =>
                    `<span style="color:${TRACK_COLORS[i % TRACK_COLORS.length]}">${ch}</span>`).join("");
                soloBtn.style.backgroundColor = "#3a3a3c";
            }
        };
        soloBtn.onclick = (e) => {
            e.stopPropagation();
            _solo = !_solo;
            refreshSoloBtn();
            redraw(); // redraw 内部会 drawKfBar，播放条三角与画布同步刷新
        };
        soloBtn.onmouseover = () => { if (!_solo) soloBtn.style.backgroundColor = "#4a4a4e"; };
        soloBtn.onmouseout = () => { if (!_solo) soloBtn.style.backgroundColor = "#3a3a3c"; };
        // 注意：此处不能立即调用 refreshSoloBtn()——state/TRACK_COLORS 尚未初始化（定义在后方），
        // 立即执行会抛错并中断整个视窗创建。初始填充由稍后的 applySwitch→refreshTrackBtns 完成
        colorTracks.appendChild(soloBtn);
        const mkCtrlBtn = (label, title) => {
            const btn = document.createElement("div");
            btn.textContent = label;
            btn.title = title;
            btn.style.cssText = "height:20px;min-width:20px;padding:0 4px;display:flex;align-items:center;justify-content:center;cursor:pointer;border-radius:4px;background:#3a3a3c;font-size:14px;color:#ccc;user-select:none;white-space:nowrap;flex-shrink:0;margin-left:4px;border:none;box-sizing:border-box;";
            btn.onmouseover = () => { btn.style.backgroundColor = "#4a4a4e"; };
            btn.onmouseout = () => { btn.style.backgroundColor = "#3a3a3c"; };
            return btn;
        };
        let playbackRequest = null;
        const stopPlay = () => {
            if (playbackRequest === null) return;
            cancelAnimationFrame(playbackRequest);
            playbackRequest = null;
            refreshPlaybackButton();
        };
        const togglePlayback = () => {
            if (playbackRequest !== null) { stopPlay(); return; }
            const last = state.frames.length - 1;
            if (last < 1) return;
            if (state.frameIdx >= last) showFrame(0);
            const startFrame = state.frameIdx;
            const startedAt = performance.now();
            const frameDurationMs = 100; // 10 FPS
            const tick = now => {
                const frame = startFrame + Math.floor((now - startedAt) / frameDurationMs);
                const nextFrame = Math.min(frame, last);
                if (nextFrame > state.frameIdx) showFrame(nextFrame);
                if (frame > last) { stopPlay(); return; }
                playbackRequest = requestAnimationFrame(tick);
            };
            playbackRequest = requestAnimationFrame(tick);
            refreshPlaybackButton();
        };
        const trackingButtonIcon = direction => {
            const leftArrow = '<path d="M2 12h6m-3-3-3 3 3 3"/>';
            const rightArrow = '<path d="M30 12h-6m3-3 3 3-3 3"/>';
            return `<svg width="38" height="34" viewBox="0 0 32 24" fill="none" stroke="currentColor" stroke-width="1.0" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 8V5h3M23 8V5h-3M9 16v3h3M23 16v3h-3M16 9v6m-3-3h6"/>${direction <= 0 ? leftArrow : ""}${direction >= 0 ? rightArrow : ""}</svg>`;
        };
        const trackDirections = [
            [-1, "向后跟踪", "← 靶标方向：向后跟踪"],
            [0, "双向跟踪", "靶标双向：向前及向后跟踪"],
            [1, "向前跟踪", "靶标方向：向前跟踪"],
        ];
        const autoTrackBtns = trackDirections.map(([direction, label, title]) => {
            const btn = mkCtrlBtn(label, `${title}。右键可清除当前轨道的自动结果`);
            btn.style.backgroundColor = "#24445a";
            btn.style.color = "#d8efff";
            btn.style.border = "1px solid #46748f";
            btn.onmouseover = () => { btn.style.backgroundColor = "#315b75"; };
            btn.onmouseout = () => { btn.style.backgroundColor = "#24445a"; };
            btn.innerHTML = trackingButtonIcon(direction);
            btn.setAttribute("aria-label", label);
            btn.style.width = "58px";
            btn.style.minWidth = "58px";
            btn.style.padding = "0 6px";
            btn.style.height = "44px";
            btn.style.display = "inline-flex";
            btn.style.alignItems = "center";
            btn.style.justifyContent = "center";
            btn.onclick = e => {
                e.stopPropagation();
                if (!trackingRequest) runMaskTracking(direction);
            };
            btn.oncontextmenu = e => {
                e.preventDefault();
                e.stopPropagation();
                const track = state.trackId;
                if (trackingRequest) return;
                const frame = state.frameIdx;
                const items = [{
                    label: "绘制独立跟踪区域",
                    fn: () => {
                        state.trackingAreaDraft = {track, frame};
                        trackingNotice("在当前画面拖出矩形，圈住与目标一起移动的纹理");
                    },
                }];
                if (state.trackingAreas?.[track]?.[frame]) items.push({
                    label: "取消当前帧的独立跟踪区域",
                    fn: () => {
                        delete state.trackingAreas[track][frame];
                        writeData();
                    },
                });
                if (activeAutoTracks()[track]) items.push({
                    label: "清除当前轨道的自动跟踪",
                    fn: () => {
                        delete state.autoTracking.tracks[track];
                        writeData();
                        redraw();
                    },
                });
                showBarMenu(e.clientX, e.clientY, items);
            };
            return btn;
        });
        toolbar.appendChild(trackBar);
        // 键盘 ← / → 逐帧，↑ / ↓ 跳转关键帧：仅当鼠标悬停在本预览面板内时生效（pointerenter/leave 维护标记），
        // 避免抢占 ComfyUI 画布与其他节点的按键；输入类元素聚焦时忽略。
        // 注意：ComfyUI 前端的"跳转上/下一个节点"快捷键监听在 window 捕获/冒泡阶段，
        // 必须在 window 捕获阶段最先拦截（stopImmediatePropagation）才能屏蔽它
        let _panelHover = false;
        let workspace = null;
        container.addEventListener("pointerenter", () => { _panelHover = true; });
        container.addEventListener("pointerleave", () => { _panelHover = false; });
        window.addEventListener("keydown", (e) => {
            if (trackingRequest) {
                e.preventDefault();
                e.stopImmediatePropagation();
                return;
            }
            if ((!_panelHover && !workspace) || !container.isConnected) return;
            const isSpace = e.code === "Space" || e.key === " ";
            const isHorizontalArrow = e.key === "ArrowLeft" || e.key === "ArrowRight";
            const isVerticalArrow = e.key === "ArrowUp" || e.key === "ArrowDown";
            if (!isSpace && !isHorizontalArrow && !isVerticalArrow) return;
            if (e.altKey || e.metaKey) return;
            const ae = document.activeElement;
            if (ae && ((ae.matches("input, textarea, select") && !(isVerticalArrow && ae === slider)) ||
                ae.isContentEditable ||
                (isSpace && ae.matches("button")))) return;
            e.preventDefault();
            e.stopImmediatePropagation(); // 阻止 ComfyUI 的节点跳转快捷键
            if (isSpace) {
                if (e.repeat) return;
                togglePlayback();
                return;
            }
            stopPlay(); // 手动步进时停止正/反向自动播放
            const nf = state.frames.length;
            if (!nf) return;
            const delta = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
            if (isVerticalArrow) {
                const tracks = _solo ? [state.manualKeyframes[state.trackId]] : Object.values(state.manualKeyframes);
                let next = delta < 0 ? -1 : nf;
                for (const keys of tracks) {
                    for (const [key, regions] of Object.entries(keys || {})) {
                        const frame = Number(key);
                        if (!Number.isInteger(frame) || frame < 0 || frame >= nf || !regions?.length) continue;
                        if (delta < 0 ? frame < state.frameIdx && frame > next : frame > state.frameIdx && frame < next) {
                            next = frame;
                        }
                    }
                }
                if (next >= 0 && next < nf) showFrame(next);
                return;
            }
            const to = Math.max(0, Math.min(nf - 1, state.frameIdx + delta));
            if (to !== state.frameIdx) showFrame(to);
        }, true);
        // 从已有数据推导已解锁轨道（加载含多轨道标注的工作流时自动点亮对应数字）
        const syncTrackUnlockedFromData = () => {
            try {
                const kfsAll = state.manualKeyframes || {};
                Object.keys(kfsAll).forEach(tidStr => {
                    const t = Number(tidStr);
                    if (t >= 1 && t <= 8 && Object.values(kfsAll[t] || {}).some(fr => Array.isArray(fr) && fr.length)) {
                        trackUnlocked.add(t);
                    }
                });
            } catch (e) {}
        };
        const refreshTrackBtns = () => {
            syncTrackUnlockedFromData();
            refreshSoloBtn(); // solo 激活时，文案颜色跟随当前选中的分类色
            trackBtns.forEach((b, idx) => {
                const tid = idx + 1;
                const color = TRACK_COLORS[idx];
                const selected = tid === state.trackId;
                b.style.display = trackUnlocked.has(tid) ? "flex" : "none";
                b.title = `轨道 ${tid}`;
                b.style.color = color;
                b.style.borderColor = selected ? color : "transparent";
                b._dot.style.display = selected ? "block" : "none";
                b._dot.style.background = color;
            });
            addTrackBtn.hidden = trackUnlocked.size >= trackBtns.length;
            trackBar.style.display = (state.mode === "manual") ? "flex" : "none";
            refreshToolBtn();
        };

        // 标注工具切换：▭ 框选 / ✎ 手绘（仅手工跟踪模式显示）
        const toolBtn = document.createElement("div");
        toolBtn.style.cssText = "height:20px;min-width:64px;padding:0 8px;margin-left:4px;display:flex;align-items:center;justify-content:center;gap:6px;cursor:pointer;border-radius:4px;background:#3a3a3c;font-size:14px;font-weight:400;user-select:none;border:none;box-sizing:border-box;white-space:nowrap;flex-shrink:0;";
        toolBtn.onmouseover = () => { toolBtn.style.backgroundColor = "#4a4a4e"; };
        toolBtn.onmouseout = () => { toolBtn.style.backgroundColor = "#3a3a3c"; };
        toolBtn.title = "标注工具：框选 / 曲线；点击打点自动生成弧线，可拖动方向手柄，点击首点闭合；当前关键帧可拖点调整";
        toolbar.insertBefore(toolBtn, trackBar);
        const refreshToolBtn = () => {
            const c = TRACK_COLORS[(state.trackId-1) % TRACK_COLORS.length];
            toolBtn.style.display = (state.mode === "manual") ? "flex" : "none";
            toolBtn.style.color = c;
            toolBtn.style.borderColor = "transparent";
            if (state.tool === "brush") {
                toolBtn.innerHTML = "<span>✎</span> 曲线";
            } else {
                // 长方形框图标（宽>高），与文字同为块级 flex 项，保证垂直居中
                toolBtn.innerHTML = '<svg style="display:block;flex-shrink:0" width="16" height="13" viewBox="0 0 12 10" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1.5" y="1.5" width="9" height="7" rx="1"/></svg><span style="display:block;line-height:13px">框选</span>';
            }
        };
        toolBtn.onclick = (e) => {
            e.stopPropagation();
            state.curveDraft = state.curveDrag = state.rectDrag = null;
            state.tool = state.tool === "rect" ? "brush" : "rect";
            writeData(false);
            refreshToolBtn();
            redraw();
        };

        const right = document.createElement("div");
        right.style.display = "flex";
        right.style.alignItems = "center";
        right.style.gap = "6px";
        right.style.flexShrink = "0";
        right.style.marginLeft = "auto";   // 无论其他元素隐藏与否，右侧组始终贴右
        toolbar.appendChild(right);
        const scrubSensitivity = document.createElement("label");
        scrubSensitivity.style.cssText = "display:flex;align-items:center;gap:5px;color:#bbb;font:12px sans-serif;white-space:nowrap;flex-shrink:0;";
        scrubSensitivity.textContent = "右键灵敏度";
        const scrubFramesInput = document.createElement("input");
        scrubFramesInput.type = "text";
        scrubFramesInput.inputMode = "numeric";
        const sensitivityKey = "xzg.manualMask.scrubSensitivity";
        const normalizeSensitivity = value => String(Math.max(1, Math.min(99999, parseInt(value, 10) || 10)));
        const readSensitivity = () => {
            try {
                scrubFramesInput.value = normalizeSensitivity(localStorage.getItem(sensitivityKey));
            } catch {}
        };
        const saveSensitivity = () => {
            scrubFramesInput.value = normalizeSensitivity(scrubFramesInput.value);
            try { localStorage.setItem(sensitivityKey, scrubFramesInput.value); } catch {}
        };
        scrubFramesInput.value = "10";
        readSensitivity();
        container.addEventListener("pointerenter", readSensitivity);
        scrubFramesInput.title = "右键拖动预览画面可调灵敏度，数值越大移动越快";
        scrubFramesInput.style.cssText = "width:27px;height:24px;box-sizing:border-box;background:#151515;color:#eee;border:1px solid #555;border-radius:4px;padding:2px 1px;text-align:center;user-select:text;";
        let scrubValueOverlay = null;
        scrubFramesInput.addEventListener("change", saveSensitivity);
        scrubFramesInput.addEventListener("keydown", e => e.stopPropagation());
        scrubSensitivity.appendChild(scrubFramesInput);
        toolbar.insertBefore(scrubSensitivity, right);

        const hint = document.createElement("div");
        hint.style.cssText = "color: #777; font-size:14px; user-select: none; display: none; white-space: nowrap;";
        hint.innerText = "左键框选";
        right.appendChild(hint);


        // 「引入上游图片」按钮：手动执行当前节点（含上游）引入画面（切换模式不再自动引入）
        const runBtn = document.createElement("div");
        // 加高 8px（20→28）、文字加大 4px（14→18，⏎ 符号随字号等比变大）
        runBtn.style.cssText = "height: 20px; min-width: 64px; padding: 0 8px; display: flex; align-items: center; justify-content: center; cursor: pointer; border-radius: 4px; background: #3a3a3c; color: #d8d8d8; font-size:14px; font-weight: 400; user-select: none; box-sizing: border-box; white-space: nowrap; flex-shrink: 0;";
        runBtn.innerHTML = '<span style="display:block;transform:translateY(-1px)">点击加载视频<span style="font-size:14px">⏎</span></span>';
        runBtn.title = "执行当前节点（含上游），预览检测画面";
        runBtn.onmouseover = () => { runBtn.style.backgroundColor = "#4a4a4e"; };
        runBtn.onmouseout = () => { runBtn.style.backgroundColor = "#3a3a3c"; };
        // 点击加载视频：不清空已画标注（持久化方案——同视频重复执行保留标注）
        runBtn.onclick = (e) => { e.stopPropagation(); startProgress(); runUpstream(); };
        // 颜色/文字跟随模式：手工跟踪=暗金+短文案（旧自动检测模式的荧光绿分支已下线，仅保留防御）
        const updateRunBtn = () => {
            const m = state.mode;
            runBtn.style.display = "flex";
            runBtn.style.color = (m === "filter") ? "#3ef558" : "#cba46c";
            runBtn.innerHTML = (m === "filter")
                ? '<span style="display:block;transform:translateY(-1px)">点击加载视频<span style="font-size:14px">⏎</span></span>'
                  + '<span style="color:#888;font-weight:400;margin-left:20px">1、不操作为全域跟踪</span>'
                  + '<span style="color:#888;font-weight:400;margin-left:20px">2、点击加载时候，画方框为限定区域跟踪</span>'
                : '<span style="display:block;transform:translateY(-1px)">点击加载视频<span style="font-size:14px">⏎</span></span>';
        };

        // 仅执行到本节点（含上游）：按钮 / 右键菜单共用
        let queueingUpstream = false;
        const runUpstream = async () => {
            if (queueingUpstream) return;
            queueingUpstream = true;
            const targetIds = new Set([String(node.id)]);
            const orig = api.queuePrompt;
            const hook = async function (index, prompt, ...args) {
                if (!prompt?.output?.[String(node.id)]) {
                    throw new Error("当前节点未包含在执行图中，请重新加载工作流后重试");
                }
                if (prompt && prompt.output) {
                    const oldOutput = prompt.output;
                    const newOutput = {};
                    const visited = new Set();
                    const collect = (val) => {
                        if (!Array.isArray(val)) return;
                        const sid = String(val[0]);
                        if (val.length === 2 && typeof val[0] === "string" && Number.isInteger(val[1]) && oldOutput[sid]) {
                            addNode(sid);
                            return;
                        }
                        for (const it of val) collect(it);
                    };
                    const addNode = (id) => {
                        const id2 = String(id);
                        if (visited.has(id2)) return;
                        const def = oldOutput[id2];
                        if (!def) return;
                        visited.add(id2);
                        newOutput[id2] = def;
                        const ins = def.inputs || {};
                        for (const k of Object.keys(ins)) collect(ins[k]);
                    };
                    for (const id of targetIds) addNode(id);
                    // 仅本次主动加载将目标提升为输出节点；普通队列保持按需执行。
                    const targetId = String(node.id);
                    newOutput[targetId] = {
                        ...newOutput[targetId],
                        class_type: "XZGManualTrackingLoadPreview",
                    };
                    prompt.output = newOutput;
                    // 前端批处理拦截器必须放行本次局部执行，不能重新启动整条工作流。
                    prompt.xzgExecuteToNode = String(node.id);
                }
                if (api.queuePrompt === hook) api.queuePrompt = orig;
                return orig.call(api, index, prompt, ...args);
            };
            try {
                api.queuePrompt = hook;
                await app.queuePrompt(0);
            } catch (err) {
                console.error("[小珠光][水印] 执行失败:", err);
                hideProgress();
            } finally {
                if (api.queuePrompt === hook) api.queuePrompt = orig;
                queueingUpstream = false;
            }
        };

        // 右键菜单追加：仅执行到本节点
        {
            const origGet = node.getExtraMenuOptions ? node.getExtraMenuOptions.bind(node) : null;
            node.getExtraMenuOptions = function (canvas, options) {
                if (origGet) { try { origGet(canvas, options); } catch (e) {} }
                options.push({
                    content: "仅执行到本节点（含上游）",
                    callback: runUpstream,
                });
            };
        }
        // 模式固定为手工跟踪（旧版三态模型下拉已取消）。
        // model_name 控件保留为隐藏占位：维持旧工作流 widgets_values 对位，
        // 避免删除首控件导致 regions_data（手工标注）整体错位丢失。
        const modelWidget = node.widgets?.find(w => w.name === 'model_name');
        if (modelWidget) {
            modelWidget.computeSize = () => [0, 0];
            modelWidget.hidden = true;
            setTimeout(() => {
                const el = modelWidget.element || modelWidget.inputEl;
                if (el) el.style.display = 'none';
            }, 50);
        }
        toolbar.insertBefore(runBtn, toolbar.firstChild);

        // 说明书按钮：位于「点击加载视频」左侧，笔记本图标（缩小占用空间），点击弹出使用说明
        const helpBtn = document.createElement("div");
        helpBtn.style.cssText = "height:20px;background:#3a3a3c;border:none;border-radius:4px;color:#FFD700;cursor:pointer;user-select:none;white-space:nowrap;flex-shrink:0;padding:0 6px;margin-right:8px;display:flex;align-items:center;justify-content:center;box-sizing:border-box;";
        helpBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>';
        helpBtn.title = "使用说明";
        helpBtn.onmouseover = () => { helpBtn.style.color = "#FFA500"; helpBtn.style.backgroundColor = "#4a4a4e"; };
        helpBtn.onmouseout = () => { helpBtn.style.color = "#FFD700"; helpBtn.style.backgroundColor = "#3a3a3c"; };
        helpBtn.onclick = (e) => { e.stopPropagation(); try { showWmDetHelp(); } catch (err) { console.error("[小珠光][水印] showWmDetHelp 错误:", err); } };
        toolbar.insertBefore(helpBtn, runBtn);
        const clearBtn = document.createElement("div");
        // 小垃圾桶：仅删除当前颜色分类（当前轨道）的关键帧
        const clearCurBtn = document.createElement("div");
        clearCurBtn.style.cssText = "width: 20px; height: 20px; display: flex; align-items: center; justify-content: center; cursor: pointer; border-radius: 4px; color: #ccc; user-select: none; flex-shrink: 0;";
        clearCurBtn.innerHTML = '<svg width="14.4" height="14.4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6M14 11v6"></path><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"></path></svg>';
        clearCurBtn.title = "删除当前颜色分类的关键帧";
        clearCurBtn.onmouseover = () => { clearCurBtn.style.backgroundColor = "#333"; };
        clearCurBtn.onmouseout = () => { clearCurBtn.style.backgroundColor = "transparent"; };
        clearCurBtn.onclick = (e) => {
            e.stopPropagation();
            if (state.manualKeyframes[state.trackId]) {
                delete state.manualKeyframes[state.trackId];
                delete state.autoTracking.tracks[state.trackId];
                if (state.trackingAreas) delete state.trackingAreas[state.trackId];
                writeData();
                redraw();
                refreshTrackBtns();
            }
        };
        clearBtn.style.cssText = "width: 20px; height: 20px; display: flex; align-items: center; justify-content: center; cursor: pointer; border-radius: 4px; color: #ccc; font-size:14px; user-select: none; flex-shrink: 0;";
        clearBtn.innerHTML = '<svg width="16.8" height="16.8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6M14 11v6"></path><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"></path></svg>';
        clearBtn.title = "删除全部标注（所有分类的关键帧 + 检测/排除区）";
        clearBtn.onmouseover = () => { clearBtn.style.backgroundColor = "#333"; };
        clearBtn.onmouseout = () => { clearBtn.style.backgroundColor = "transparent"; };
        clearBtn.onclick = (e) => {
            e.stopPropagation();
            state.detectRegions = [];
            state.excludeRegions = [];
            state.manualKeyframes = {};
            state.autoTracking = {tracks: {}};
            state.trackingAreas = {};
            trackUnlocked = new Set([1]); // 除轨道 1 外，其他分类的数字一并收回
            state.trackId = 1;
            writeData();
            redraw();
            refreshTrackBtns();
        };
        const clearGroup = document.createElement("div");
        clearGroup.style.cssText = "display:flex;align-items:center;gap:6px;";
        for (const button of [clearCurBtn, clearBtn]) {
            Object.assign(button.style, {width: "32px", height: "34px"});
            const icon = button.querySelector("svg");
            icon.setAttribute("width", button === clearCurBtn ? "18" : "21");
            icon.setAttribute("height", button === clearCurBtn ? "18" : "21");
            clearGroup.appendChild(button);
        }

        hint.innerText = "左键框选 (检测区)";

        const resetViewBtn = mkCtrlBtn("恢复视图", "恢复预览的默认大小和居中位置");
        resetViewBtn.style.color = "#FFD700";
        resetViewBtn.onclick = e => {
            e.stopPropagation();
            resetPreviewView();
        };
        const trackingGroup = document.createElement("div");
        trackingGroup.style.cssText = "display:flex;align-items:center;gap:8px;";
        for (const button of [...autoTrackBtns, resetViewBtn]) {
            Object.assign(button.style, {height: "34px", padding: "0 10px", marginLeft: "0", fontSize: "14px", lineHeight: "20px"});
        }
        const undoBtn = mkCtrlBtn("撤销", "撤销上一步");
        const redoBtn = mkCtrlBtn("重做", "恢复已撤销的操作");
        for (const [button, direction] of [[undoBtn, -1], [redoBtn, 1]]) {
            button.style.height = "34px";
            button.style.padding = "0 10px";
            button.onclick = e => { e.stopPropagation(); stepEditHistory(direction); };
        }
        const historyBtn = mkCtrlBtn("历史", "查看自动保存的遮罩版本");
        Object.assign(historyBtn.style, {height: "34px", padding: "0 10px"});
        historyBtn.onclick = e => {
            e.stopPropagation();
            openMaskHistory();
        };
        trackingGroup.append(...autoTrackBtns, undoBtn, redoBtn, clearGroup, historyBtn, resetViewBtn);
        trackBar.appendChild(trackingGroup);
        const fullscreenBtn = mkCtrlBtn("全屏编辑", "打开全屏编辑");
        Object.assign(fullscreenBtn.style, {height: "34px", padding: "0 10px"});
        fullscreenBtn.onclick = e => {
            e.stopPropagation();
            if (workspace) closeWorkspace();
            else openWorkspace();
        };
        const playbackBtn = document.createElement("button");
        playbackBtn.type = "button";
        playbackBtn.style.cssText = "width:42px;height:42px;flex:0 0 42px;border:1px solid #666;border-radius:50%;padding:0;display:grid;place-items:center;background:#3a3a3c;color:#fff;cursor:pointer;";
        const refreshPlaybackButton = () => {
            const playing = playbackRequest !== null;
            playbackBtn.title = playing ? "暂停" : "播放";
            playbackBtn.setAttribute("aria-label", playbackBtn.title);
            playbackBtn.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${playing ? "M6 4h4v16H6z M14 4h4v16h-4z" : "M8 3l14 9-14 9z"}"/></svg>`;
        };
        playbackBtn.onclick = e => {
            e.stopPropagation();
            if (e.detail > 0) playbackBtn.blur();
            togglePlayback();
        };
        refreshPlaybackButton();
        right.appendChild(fullscreenBtn);
        for (const button of [helpBtn, runBtn, toolBtn, soloBtn]) {
            Object.assign(button.style, {height: "34px", padding: "0 10px", marginLeft: "0", marginRight: "0"});
        }
        helpBtn.querySelector("svg")?.setAttribute("width", "20");
        helpBtn.querySelector("svg")?.setAttribute("height", "20");

        // 播放控件固定在首行，关键帧轨道在下方增加高度。
        const playbackRowHeight = 66;
        const laneHeight = 18;
        const tracker = document.createElement("div");
        tracker.style.cssText = `flex:0 0 ${playbackRowHeight + 1}px;width:100%;background:#222;position:relative;display:grid;grid-template-columns:42px auto minmax(0,1fr);grid-template-rows:${playbackRowHeight}px;align-items:center;padding:0 8px;box-sizing:border-box;border-bottom:1px solid #333;column-gap:4px;`;
        container.appendChild(tracker);
        tracker.appendChild(playbackBtn);
        // 播放条和关键帧三角均屏蔽浏览器原生右键菜单。
        tracker.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
        });

        const frameInfo = document.createElement("div");
        frameInfo.style.cssText = "color: #ccc; font-family: monospace; font-size: 14px; min-width: 44px; text-align: right; user-select: none;";
        frameInfo.innerText = "0/0";
        tracker.appendChild(frameInfo);


        const slider = document.createElement("input");
        slider.type = "range";
        slider.min = "0";
        slider.max = "0";
        slider.value = "0";
        slider.step = "1";
        slider.disabled = true;
        slider.style.cssText = "justify-self:stretch;min-width:0;height:4px;cursor:default;accent-color:#e8c547;opacity:0.3;pointer-events:none;position:relative;z-index:4;";
        // 播放头手柄：圆形 → 三角形+竖杠（金色，与 accent-color 一致）。
        // 实心倒三角 + 下方竖线，SVG data URI 作为 thumb 背景；
        // 全局注入一次，多个节点共用。thumb 宽 16px 高 20px，
        // getThumbRadius() 读到 16px/2=8px，竖杠对齐公式自动适用。
        if (!document.getElementById('xzg-wmdet-slider-style')) {
            const st = document.createElement('style');
            st.id = 'xzg-wmdet-slider-style';
            st.textContent = `
.xzg-wmdet-slider{-webkit-appearance:none;appearance:none;background:transparent;height:4px;will-change:transform;transform:translateZ(0);}
.xzg-wmdet-slider::-webkit-slider-runnable-track{height:4px;border-radius:2px;background:transparent;}
.xzg-wmdet-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:16px;height:35px;margin-top:-15px;background:url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 35'><circle cx='8' cy='6' r='5.5' fill='%23ffffff'/><line x1='8' y1='11.5' x2='8' y2='34' stroke='%23ffffff' stroke-width='2.4'/></svg>") no-repeat center/contain;border:none;cursor:pointer;}
.xzg-wmdet-slider::-moz-range-track{height:4px;border-radius:2px;background:transparent;}
.xzg-wmdet-slider::-moz-range-thumb{width:16px;height:35px;background:url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 35'><circle cx='8' cy='6' r='5.5' fill='%23ffffff'/><line x1='8' y1='11.5' x2='8' y2='34' stroke='%23ffffff' stroke-width='2.4'/></svg>") no-repeat center/contain;border:none;border-radius:0;cursor:pointer;}
`;
            document.head.appendChild(st);
        }
        slider.classList.add('xzg-wmdet-slider');
        tracker.appendChild(slider);
        // 播放条刻度层：覆盖滑块区域，绘制 0..N 刻度竖线与关键帧竖杠（pointer-events:none 不挡滑块拖动）
        const kfBar = document.createElement("div");
        // z-index 7 高于点击判定区(6)：关键帧三角需要可点击（pointer-events:auto），
        // 层内其余元素仍 pointer-events:none，拖动换帧不受影响
        kfBar.style.cssText = "position:absolute;left:0;top:0;height:100%;pointer-events:none;z-index:7;";
        tracker.appendChild(kfBar);
        // 播放条拖动判定区：覆盖滑块区域（不含播放/暂停按钮与左侧帧显示），点击/拖动换算为帧值
        const hitzone = document.createElement("div");
        hitzone.style.cssText = "position:absolute;top:0;right:0;bottom:0;left:0;z-index:6;cursor:pointer;";
        tracker.appendChild(hitzone);
        requestAnimationFrame(() => { hitzone.style.left = (slider.offsetLeft || 0) + "px"; });
        let dragging = false;
        let rightDragging = false;
        let previewScrub = null;
        let suppressPreviewContextMenuUntil = 0;
        window.addEventListener("contextmenu", e => {
            if (!previewScrub && Date.now() > suppressPreviewContextMenuUntil) return;
            e.preventDefault();
            e.stopImmediatePropagation();
        }, true);
        window.addEventListener("pointermove", e => {
            if (previewScrub?.pointerId !== e.pointerId) return;
            suppressPreviewContextMenuUntil = Date.now() + 800;
            e.preventDefault();
            if (!previewScrub.mode) {
                const dx = Math.abs(e.clientX - previewScrub.startX);
                const dy = Math.abs(e.clientY - previewScrub.startY);
                if (Math.max(dx, dy) < 4) return;
                previewScrub.mode = dy > dx ? "sensitivity" : "seek";
            }
            if (previewScrub.mode === "sensitivity") {
                const delta = Math.round((previewScrub.startY - e.clientY) / 4);
                const value = Math.max(1, Math.min(99999, previewScrub.startSensitivity + delta));
                scrubFramesInput.value = String(value);
                if (scrubValueOverlay) {
                    scrubValueOverlay.textContent = `右键灵敏度 ${value}`;
                    scrubValueOverlay.style.display = "flex";
                }
                return;
            }
            const frame = Math.round(previewScrub.startFrame +
                (e.clientX - previewScrub.startX) / previewScrub.width *
                previewScrub.frameSpan);
            showFrame(Math.max(0, Math.min(state.frames.length - 1, frame)));
        }, true);
        const endPreviewScrub = e => {
            if (previewScrub?.pointerId !== e.pointerId) return;
            const { mode, startX, startY } = previewScrub;
            if (mode === "sensitivity") saveSensitivity();
            previewScrub = null;
            suppressPreviewContextMenuUntil = Date.now() + 800;
            if (scrubValueOverlay) scrubValueOverlay.style.display = "none";
            if (e.type === "pointerup" && !mode &&
                Math.max(Math.abs(e.clientX - startX), Math.abs(e.clientY - startY)) < 4) {
                handleCurveRightClick(e);
            }
        };
        window.addEventListener("pointerup", endPreviewScrub, true);
        window.addEventListener("pointercancel", endPreviewScrub, true);
        window.addEventListener("blur", () => {
            if (previewScrub) endPreviewScrub({pointerId: previewScrub.pointerId, type: "blur"});
        });
        // 播放头拖动残影：按下时在播放头"原位置"放一个半透明同款播放头（三角+竖杠），
        // 拖动期间保持不动作为原位置参照；松开后播放头已落实到新位置，残影消失。
        let thumbGhost = null;
        const removeThumbGhost = () => { if (thumbGhost) { thumbGhost.remove(); thumbGhost = null; } };
        const spawnThumbGhost = () => {
            removeThumbGhost();
            const nf = state.frames.length;
            if (nf < 1 || slider.clientWidth <= 0) return;
            // 与 setFrameFromX 同一套几何换算：thumb 宽 16px，水平行程 = 宽度-16；
            // 垂直方向 thumb(35px) 相对 4px 轨道 margin-top:-15px
            const frac = nf > 1 ? state.frameIdx / (nf - 1) : 0;
            thumbGhost = document.createElement("div");
            thumbGhost.style.cssText = `position:absolute;width:16px;height:35px;opacity:0.65;pointer-events:none;z-index:5;background:url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 35'><circle cx='8' cy='6' r='5.2' fill='none' stroke='%23ffffff' stroke-width='1.6' stroke-dasharray='3 2'/><line x1='8' y1='13' x2='8' y2='34' stroke='%23ffffff' stroke-width='2.4' stroke-dasharray='4 3'/></svg>") no-repeat center/contain;`;
            thumbGhost.style.left = (slider.offsetLeft + frac * Math.max(0, slider.clientWidth - 16)) + "px";
            thumbGhost.style.top = (slider.offsetTop - 15) + "px";
            tracker.appendChild(thumbGhost);
        };
        const setFrameFromX = (clientX) => {
            const nf = state.frames.length;
            if (nf < 1) return;
            const rect = slider.getBoundingClientRect();
            const w = rect.width;
            if (w <= 0) return;
            const r = 8;
            const frac = (clientX - rect.left - r) / (w - 2 * r);
            const fr = Math.max(0, Math.min(nf - 1, Math.round(frac * (nf - 1))));
            if (fr !== state.frameIdx) showFrame(fr);
        };
        tracker.addEventListener("pointerdown", e => {
            if (e.button !== 2 || trackingRequest || !state.frames.length) return;
            const rect = slider.getBoundingClientRect();
            if (e.clientX < rect.left || e.clientX > rect.right) return;
            e.preventDefault();
            e.stopPropagation();
            rightDragging = true;
            tracker.setPointerCapture(e.pointerId);
            stopPlay();
            setFrameFromX(e.clientX);
        }, true);
        tracker.addEventListener("pointermove", e => {
            if (rightDragging) {
                e.preventDefault();
                setFrameFromX(e.clientX);
            }
        });
        hitzone.addEventListener("pointerdown", (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            dragging = true;
            hitzone.setPointerCapture(e.pointerId);
            spawnThumbGhost(); // 先在播放头原位置留半透明残影，再让播放头跳到点击处
            setFrameFromX(e.clientX);
        });
        hitzone.addEventListener("contextmenu", e => {
            e.preventDefault();
            e.stopPropagation();
        });
        tracker.addEventListener("contextmenu", e => {
            if (rightDragging) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            if (trackingRequest || !state.frames.length) return;
            const bounds = slider.getBoundingClientRect();
            if (!bounds.width) return;
            const radius = getThumbRadius() * bounds.width / (slider.clientWidth || bounds.width);
            const frame = Math.round((e.clientX - bounds.left - radius) /
                Math.max(1, bounds.width - 2 * radius) * (state.frames.length - 1));
            const keys = state.manualKeyframes[state.trackId] || {};
            const anchors = Object.keys(keys).map(Number)
                .filter(index => index >= 0 && index < state.frames.length && keys[index]?.length)
                .sort((a, b) => a - b);
            const left = anchors.findLast(index => index < frame);
            const right = anchors.find(index => index > frame);
            if (keys[frame]?.length || left === undefined || right === undefined) return;
            const frames = activeAutoTracks()[state.trackId];
            showBarMenu(e.clientX, e.clientY, [{
                label: `清除第 ${left}–${right} 帧之间的自动跟踪`,
                fn: () => {
                    if (!frames) return;
                    for (let index = left; index <= right; index++) {
                        delete frames[state.sampleIdx[index] ?? index];
                    }
                    writeData();
                    redraw();
                },
            }]);
        });
        window.addEventListener("mousemove", (e) => {
            if (dragging || rightDragging) setFrameFromX(e.clientX);
        });
        window.addEventListener("pointermove", e => {
            if (dragging || rightDragging) setFrameFromX(e.clientX);
        }, true);
        window.addEventListener("mouseup", () => {
            dragging = false;
            rightDragging = false;
            removeThumbGhost(); // 播放头落实新位置，残影消失
        });
        const stopTimelineDrag = () => {
            dragging = false;
            rightDragging = false;
            removeThumbGhost();
        };
        window.addEventListener("pointerup", stopTimelineDrag, true);
        window.addEventListener("pointercancel", stopTimelineDrag, true);
        window.addEventListener("blur", stopTimelineDrag);

        const canvasWrapper = document.createElement("div");
        // flex:1 让它吃掉 tool 条/帧条之外的全部容器高度，否则高度由 canvas 子元素推导，
        // 画面大小会被锁死、无法随预览窗自适应；padding:30px 为视频四周保留黑色留边，
        // 画方框时不会贴到节点内边缘。
        canvasWrapper.style.cssText = "flex:1; width:100%; min-height:0; box-sizing:border-box; position:relative; overflow:hidden; padding:30px; display:flex; align-items:center; justify-content:center; background:#0f1011;";
        container.appendChild(canvasWrapper);
        scrubValueOverlay = document.createElement("div");
        scrubValueOverlay.style.cssText = "position:absolute;inset:0;z-index:30;display:none;align-items:center;justify-content:center;color:#fff;font:600 42px sans-serif;text-shadow:0 2px 12px #000,0 0 24px #000;background:transparent;pointer-events:none;user-select:none;";
        canvasWrapper.appendChild(scrubValueOverlay);

        const canvas = document.createElement("canvas");
        canvas.width = 512;
        canvas.height = 320;
        // canvas 显示尺寸由 _updateSurfaceCss 按「图像宽高比」直接写 inline px，
        // 显示框与图像严格同比例、不依赖容器高度或 object-fit → 视频绝不变形。
        canvas.style.cssText = "display: block; cursor: crosshair;";
        canvasWrapper.appendChild(canvas);
        const ctx = canvas.getContext("2d");

        // ---- 手绘黑边显示 overlay ----
        // 主画布位图 = 图像本身（黑边是 wrapper 的 30px 留白，在 canvas 元素之外），
        // 黑边内的笔画画在主画布上会被位图边界裁掉。此 overlay 覆盖整个 wrapper
        // （含黑边），仅承载绘制期间的实时笔迹；松手即清除——存储的多边形轮廓
        // 仍由主画布裁剪到视频区显示，遮罩后端用完整多边形（边角覆盖不受影响）。
        const brushOverlay = document.createElement("canvas");
        brushOverlay.style.cssText = "position:absolute; inset:0; width:100%; height:100%; pointer-events:none; z-index:2;";
        canvasWrapper.appendChild(brushOverlay);
        const syncBrushOverlaySize = () => {
            const dpr = window.devicePixelRatio || 1;
            // 位图跟随实际屏幕尺寸，而非未缩放的节点布局尺寸。
            // 放大预览时增加像素数量，避免控制点和曲线被拉伸模糊。
            const rect = brushOverlay.getBoundingClientRect();
            const bw = Math.max(1, Math.round((rect.width || 1) * dpr));
            const bh = Math.max(1, Math.round((rect.height || 1) * dpr));
            if (brushOverlay.width !== bw || brushOverlay.height !== bh) {
                brushOverlay.width = bw;
                brushOverlay.height = bh;
            }
        };
        const clearBrushOverlay = () => {
            brushOverlay.getContext("2d").setTransform(1, 0, 0, 1, 0, 0);
            brushOverlay.getContext("2d").clearRect(0, 0, brushOverlay.width, brushOverlay.height);
        };
        const overlayScreenScale = () => {
            const width = brushOverlay.clientWidth;
            return width > 0 ? brushOverlay.getBoundingClientRect().width / width : 1;
        };
        // The video and overlay have independent transforms.
        const controlScreenScale = () => {
            const width = canvas.clientWidth;
            return width > 0 ? canvas.getBoundingClientRect().width / width : overlayScreenScale();
        };
        const curveOutline = (curve, closed = true) => {
            if (!curve.some(node => node.roundness !== undefined)) return curve;
            const point = (a, b, t) => ({x:a.x+(b.x-a.x)*t, y:a.y+(b.y-a.y)*t});
            return curve.flatMap((node, i) => {
                const prev = curve[i-1] || (closed ? curve.at(-1) : node);
                const next = curve[i+1] || (closed ? curve[0] : node);
                const amount = node.roundness ?? .25;
                const entry = point(node, prev, amount), exit = point(node, next, amount);
                return [
                    {...entry, in:entry, out:point(entry,node,2/3)},
                    {...exit, in:point(exit,node,2/3), out:exit},
                ];
            });
        };
        const curveCornerGuide = (prev, node, next) => {
            const tangent = (a, b, t) => {
                const u = 1 - t;
                return Object.fromEntries(['x', 'y'].map(axis => [axis,
                    u*u*(a.out[axis]-a[axis]) + 2*u*t*(b.in[axis]-a.out[axis]) + t*t*(b[axis]-b.in[axis])]));
            };
            const start = cubicPoint(prev, node, .7), end = cubicPoint(node, next, .3);
            const incoming = tangent(prev, node, .7), outgoing = tangent(node, next, .3);
            const cross = incoming.x*outgoing.y - incoming.y*outgoing.x;
            if (Math.abs(cross) < 1e-10) return null;
            const dx = end.x-start.x, dy = end.y-start.y;
            const t = (dx*outgoing.y-dy*outgoing.x)/cross;
            const s = (dx*incoming.y-dy*incoming.x)/cross;
            if (t <= 0 || s >= 0) return null;
            const joint = {x:start.x+t*incoming.x, y:start.y+t*incoming.y};
            if (Math.hypot(joint.x-node.x,joint.y-node.y) > Math.hypot(dx,dy)) return null;
            return {start, joint, end};
        };
        const curveControls = (curve, cr, scale, closed = true) => {
            const xs = curve.map(a => a.x), ys = curve.map(a => a.y);
            const left = Math.min(...xs), right = Math.max(...xs);
            const top = Math.min(...ys), bottom = Math.max(...ys);
            const cx = (left + right) / 2, cy = (top + bottom) / 2;
            const pad = 12 * scale;
            const box = {x1:left-pad/cr.width, y1:top-pad/cr.height,
                x2:right+pad/cr.width, y2:bottom+pad/cr.height};
            const handles = curve.map((a, i) => {
                const prev = curve[i - 1] || (closed ? curve.at(-1) : a);
                const next = curve[i + 1] || (closed ? curve[0] : a);
                const outward = neighbor => {
                    const x = (a.x - neighbor.x) * cr.width, y = (a.y - neighbor.y) * cr.height;
                    const length = Math.hypot(x, y) || 1;
                    return {x: x / length, y: y / length};
                };
                const before = outward(prev), after = outward(next);
                let dx = before.x + after.x, dy = before.y + after.y;
                if (Math.hypot(dx, dy) < .05) {
                    dx = (a.x-cx)*cr.width; dy = (a.y-cy)*cr.height;
                }
                const length = Math.hypot(dx, dy);
                const ux = length ? dx/length : 0, uy = length ? dy/length : -1;
                const tangent = (Math.hypot((a.in.x-a.x)*cr.width,(a.in.y-a.y)*cr.height) +
                    Math.hypot((a.out.x-a.x)*cr.width,(a.out.y-a.y)*cr.height)) / 2;
                const reach = nodeHandleReach(a, scale, tangent);
                return {x:a.x+ux*reach/cr.width, y:a.y+uy*reach/cr.height, ux, uy};
            });
            const guides = curve.map((node, i) => {
                const prev = curve[i - 1] || (closed ? curve.at(-1) : null);
                const next = curve[i + 1] || (closed ? curve[0] : null);
                return node.roundness === undefined && prev && next && curve.length >= 3
                    ? curveCornerGuide(prev, node, next) : null;
            });
            return {box, handles, guides, anchors: curve.map((node, i) => guides[i]?.joint || node)};
        };
        const nodeHandleReach = (node, scale, tangent) => 10 * scale +
            (node.roundness === undefined ? Math.min(26 * scale, tangent) : 52 * scale * node.roundness);
        const drawActiveOverlay = () => {
            if (!state.image) { clearBrushOverlay(); return; }
            const region = state.shapeSelected ? visibleTrackRegions(state.trackId, editFrame())[0] : null;
            const curve = state.curveDraft || region?.curve;
            const rect = state.shapeSelected && !state.curveDraft && region && !region.poly ? region : null;
            const hasBrush = !!curve?.length;
            const hasRect = !!state.drawing;
            const hasTracks = state.mode === "manual";
            if (!hasBrush && !hasRect && !rect && !hasTracks) { clearBrushOverlay(); return; }
            syncBrushOverlaySize();
            const bctx = brushOverlay.getContext("2d");
            // 用 overlay 位图和实际屏幕尺寸的比例映射绘图坐标。
            // 控制点跟随视频预览缩放，轮廓线按节点缩放绘制。
            const or = brushOverlay.getBoundingClientRect();
            bctx.setTransform(1, 0, 0, 1, 0, 0);
            bctx.clearRect(0, 0, brushOverlay.width, brushOverlay.height);
            if (!or.width || !or.height) return;
            bctx.setTransform(brushOverlay.width / or.width, 0, 0, brushOverlay.height / or.height, 0, 0);
            const cr = canvas.getBoundingClientRect();
            if (!cr.width) return;
            const controlScale = controlScreenScale();
            const lineScale = overlayScreenScale();
            const rectangleLineWidth = 2 * lineScale;
            const anchorHalf = 2.5 * controlScale;
            const handleRadius = 2 * controlScale;
            const cc = state.mode === "manual" ? TRACK_COLORS[(state.trackId - 1) % 8] : "#22c55e";
            const hover = state.controlHover;
            const highlight = "#00ffff";
            bctx.lineJoin = "round";
            bctx.lineCap = "round";
            // All saved and interpolated outlines use the screen-resolution overlay.
            // Keep image pixels separate so zoom never enlarges a rasterized outline.
            if (hasTracks) {
                bctx.save();
                bctx.beginPath();
                bctx.rect(cr.left-or.left, cr.top-or.top, cr.width, cr.height);
                bctx.clip();
                for (const tid of Object.keys(state.manualKeyframes).map(Number)) {
                    if (_solo && tid !== state.trackId) continue;
                    for (const r of visibleTrackRegions(tid, tid === state.trackId ? editFrame() : state.frameIdx)) {
                        if (!state.curveDraft && tid === state.trackId && region?.curve) continue;
                        const pos = p => [cr.left-or.left+p.x*cr.width, cr.top-or.top+p.y*cr.height];
                        bctx.strokeStyle = TRACK_COLORS[(tid-1)%TRACK_COLORS.length];
                        bctx.lineWidth = r.poly || r.curve ? lineScale : rectangleLineWidth;
                        bctx.beginPath();
                        if (r.curve?.length) {
                            const outline = curveOutline(r.curve);
                            bctx.moveTo(...pos(outline[0]));
                            outline.forEach((a,i) => {
                                const b=outline[(i+1)%outline.length];
                                bctx.bezierCurveTo(...pos(a.out),...pos(b.in),...pos(b));
                            });
                            bctx.closePath();
                        } else if (r.poly?.length) {
                            r.poly.forEach(([x,y],i) => i ? bctx.lineTo(...pos({x,y})) : bctx.moveTo(...pos({x,y})));
                            bctx.closePath();
                        } else {
                            const [x,y]=pos({x:r.x1,y:r.y1});
                            bctx.rect(x,y,(r.x2-r.x1)*cr.width,(r.y2-r.y1)*cr.height);
                        }
                        bctx.stroke();
                    }
                }
                const area = state.trackingAreas?.[state.trackId]?.[state.frameIdx];
                if (area) {
                    bctx.strokeStyle = "#80ffff";
                    bctx.lineWidth = controlScale;
                    bctx.setLineDash([4 * controlScale, 4 * controlScale]);
                    bctx.strokeRect(cr.left - or.left + area.x1 * cr.width,
                        cr.top - or.top + area.y1 * cr.height, (area.x2 - area.x1) * cr.width,
                        (area.y2 - area.y1) * cr.height);
                }
                bctx.restore();
                bctx.setLineDash([]);
            }
            if (hasBrush) {
                const pos = p => [cr.left - or.left + p.x * cr.width, cr.top - or.top + p.y * cr.height];
                bctx.strokeStyle = cc;
                bctx.fillStyle = cc;
                bctx.lineWidth = lineScale;
                bctx.beginPath();
                let previewCurve = curve;
                const pointer = state.curvePreviewPointer;
                if (state.curveDraft && !state.curveDrag && pointer) {
                    const point = {x:(pointer.clientX-cr.left)/cr.width, y:(pointer.clientY-cr.top)/cr.height};
                    const near = anchor => Math.hypot((anchor.x-point.x)*cr.width, (anchor.y-point.y)*cr.height)
                        < CURVE_CONTROL_HIT_RADIUS * controlScale;
                    if (!near(curve.at(-1)) && !(curve.length >= 3 && near(curve[0]))) {
                        previewCurve = [...curve, {...point, in:point, out:point, roundness:.25}];
                    }
                }
                const closed = !state.curveDraft || previewCurve.length >= 3;
                const outline = curveOutline(previewCurve, closed);
                bctx.moveTo(...pos(outline[0]));
                const count = closed ? outline.length : outline.length - 1;
                for (let i = 0; i < count; i++) {
                    const a = outline[i], b = outline[(i + 1) % outline.length];
                    bctx.bezierCurveTo(...pos(a.out), ...pos(b.in), ...pos(b));
                }
                if (closed) bctx.closePath();
                bctx.stroke();
                bctx.strokeStyle = "#467aff";
                bctx.setLineDash([5 * lineScale, 4 * lineScale]);
                bctx.save();
                if (closed) {
                    // Show only the portions of the anchor polygon outside the outline.
                    bctx.rect(0, 0, or.width, or.height);
                    bctx.clip("evenodd");
                }
                bctx.beginPath();
                bctx.moveTo(...pos(previewCurve[0]));
                for (const anchor of previewCurve.slice(1)) bctx.lineTo(...pos(anchor));
                if (closed) bctx.closePath();
                bctx.stroke();
                bctx.restore();
                bctx.setLineDash([]);
                const {box, handles, guides, anchors} = curveControls(previewCurve, cr, controlScale, closed);
                if (!state.curveDraft) {
                    const [left, top] = pos({x:box.x1, y:box.y1});
                    const [right, bottom] = pos({x:box.x2, y:box.y2});
                    bctx.strokeStyle = "#fff";
                    bctx.setLineDash([3 * lineScale, 3 * lineScale]);
                    bctx.strokeRect(left, top, right-left, bottom-top);
                    bctx.setLineDash([]);
                    bctx.fillStyle = "#fff";
                    const cornerHalf = Math.min(handleRadius, (right - left) / 12, (bottom - top) / 12);
                    for (const x of [left, (left + right)/2, right]) {
                        for (const y of [top, (top + bottom)/2, bottom]) {
                            if (x === (left + right)/2 && y === (top + bottom)/2) continue;
                            bctx.fillRect(x-cornerHalf, y-cornerHalf, 2*cornerHalf, 2*cornerHalf);
                        }
                    }
                }
                curve.forEach((a, i) => {
                    const [hx, hy] = pos(handles[i]);
                    bctx.strokeStyle = "#467aff";
                    const guide = guides[i];
                    if (guide) {
                        bctx.setLineDash([5 * lineScale, 4 * lineScale]);
                        bctx.beginPath();
                        bctx.moveTo(...pos(guide.start));
                        bctx.lineTo(...pos(guide.joint));
                        bctx.lineTo(...pos(guide.end));
                        bctx.stroke();
                        bctx.setLineDash([]);
                    }
                    bctx.beginPath(); bctx.moveTo(...pos(guide?.joint || a)); bctx.lineTo(hx, hy); bctx.stroke();
                    bctx.fillStyle = hover?.kind === "handle" && hover.index === i ? highlight : "#467aff";
                    bctx.fillRect(hx-handleRadius, hy-handleRadius, 2*handleRadius, 2*handleRadius);
                    const [x, y] = pos(anchors[i]);
                    bctx.fillStyle = hover?.kind === "anchor" && hover.index === i ? highlight : "#dbe8ff";
                    bctx.strokeStyle = "#467aff";
                    bctx.fillRect(x - anchorHalf, y - anchorHalf, anchorHalf * 2, anchorHalf * 2);
                    bctx.strokeRect(x - anchorHalf, y - anchorHalf, anchorHalf * 2, anchorHalf * 2);
                });
            }
            if (rect) {
                const side = Math.min(10 * controlScale, Math.abs(rect.x2 - rect.x1) * cr.width / 6,
                                      Math.abs(rect.y2 - rect.y1) * cr.height / 6);
                const half = side / 2;
                bctx.strokeStyle = "#101820"; bctx.fillStyle = "#FFD700";
                bctx.lineWidth = Math.min(controlScale, half);
                for (const [x, y] of [[rect.x1, rect.y1], [rect.x2, rect.y1], [rect.x2, rect.y2], [rect.x1, rect.y2]]) {
                    const keys = hover?.keys;
                    bctx.fillStyle = keys?.length === 2 && rect[keys[0]] === x && rect[keys[1]] === y
                        ? highlight : "#FFD700";
                    const px = cr.left-or.left+x*cr.width, py = cr.top-or.top+y*cr.height;
                    bctx.fillRect(px-half, py-half, side, side);
                    bctx.strokeRect(px-half, py-half, side, side);
                }
                if (lockedEditFrame() !== null) {
                    const x = cr.left - or.left + (rect.x1 + rect.x2) * cr.width / 2;
                    const y = cr.top - or.top + (rect.y1 + rect.y2) * cr.height / 2;
                    const scale = lineScale;
                    bctx.fillStyle = "#101820";
                    bctx.beginPath();
                    bctx.arc(x, y, 10 * scale, 0, 2 * Math.PI);
                    bctx.fill();

                    bctx.strokeStyle = "#FFD700";
                    bctx.lineWidth = 1.5 * scale;
                    bctx.beginPath();
                    bctx.arc(x, y - scale, 3 * scale, Math.PI, 2 * Math.PI);
                    bctx.stroke();
                    bctx.strokeRect(x - 5 * scale, y - scale, 10 * scale, 6 * scale);
                }
            }
            if (hasRect) {
                // 方框实时预览：跟随鼠标、不钳制（黑边内也显示）；松手提交时才钳制到视频外边缘
                const iw = canvas.width || 1, ih = canvas.height || 1;
                const rx1 = Math.min(state.drawing.x1, state.drawing.x2) / iw;
                const ry1 = Math.min(state.drawing.y1, state.drawing.y2) / ih;
                const rx2 = Math.max(state.drawing.x1, state.drawing.x2) / iw;
                const ry2 = Math.max(state.drawing.y1, state.drawing.y2) / ih;
                bctx.strokeStyle = cc;
                bctx.lineWidth = rectangleLineWidth;
                bctx.setLineDash([]);
                bctx.strokeRect(cr.left - or.left + rx1 * cr.width, cr.top - or.top + ry1 * cr.height,
                    (rx2 - rx1) * cr.width, (ry2 - ry1) * cr.height);
                bctx.setLineDash([]);
            }
        };

        // 开关关闭时的提示遮罩（视窗始终可见，仅禁用框选）
        const overlay = document.createElement("div");
        overlay.style.cssText = "position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; background: rgba(120,40,120,0.6); color: #fff; font-size: 14px; z-index: 5; pointer-events: none; text-align: center; gap: 6px;";
        overlay.innerHTML = '';
        overlay.style.display = "none";
        canvasWrapper.appendChild(overlay);

        // ---- 加载进度条：点击「点击加载视频」后显示，实时反映后端检测进度 ----
        const progEl = document.createElement("div");
        progEl.style.cssText = "position:absolute;left:0;top:0;right:0;height:18px;background:rgba(0,0,0,0.6);display:none;align-items:center;overflow:hidden;z-index:6;pointer-events:none;box-sizing:border-box;border-bottom:1px solid #333;";
        const progFill = document.createElement("div");
        progFill.style.cssText = "position:absolute;left:0;top:0;bottom:0;width:0%;background:linear-gradient(90deg,#e8c547,#ffd700);transition:width .15s linear;";
        const progText = document.createElement("span");
        progText.style.cssText = "position:absolute;left:0;right:0;text-align:center;color:#fff;font-size:11px;line-height:18px;";
        progText.textContent = "加载中…";
        progEl.appendChild(progFill);
        progEl.appendChild(progText);
        canvasWrapper.appendChild(progEl);

        let runActive = false;
        let runProgTimer = null;
        const updateProg = (v, m) => {
            if (!runActive) return;
            let pct = 0;
            if (m > 0) pct = Math.max(0, Math.min(1, v / m));
            progFill.style.width = (pct * 100) + "%";
            progText.textContent = (m > 0) ? Math.round(pct * 100) + "%" : "加载中…";
        };
        const startProgress = () => {
            runActive = true;
            progFill.style.width = "0%";
            progText.textContent = "加载中…";
            progEl.style.display = "flex";
            clearTimeout(runProgTimer);
            runProgTimer = setTimeout(hideProgress, 120000);   // 兜底防卡住
            const g = (window.__xzgWmProgG = window.__xzgWmProgG || { list: [], bound: false });
            const bind = () => {
                if (g.bound || !window.api) return;
                g.bound = true;
                try {
                    window.api.addEventListener("progress", (e) => {
                        const d = (e && e.detail) || {};
                        const v = (typeof d.value === "number") ? d.value : 0;
                        const m = (typeof d.max === "number") ? d.max : 0;
                        (g.list || []).slice().forEach(t => { try { t(v, m); } catch (_) {} });
                    });
                } catch (_) {}
            };
            if (!g.list.includes(updateProg)) g.list.push(updateProg);
            bind();
        };
        function hideProgress() {
            runActive = false;
            clearTimeout(runProgTimer);
            progEl.style.display = "none";
            const g = window.__xzgWmProgG;
            if (g && g.list) { const i = g.list.indexOf(updateProg); if (i >= 0) g.list.splice(i, 1); }
        }

        // ---- DOM widget 注册（缩小画布时视窗不消失）----
        const widget = node.addDOMWidget("wmdet", "watermark_detect", container, { hideOnZoom: false });
        node.wmdetWidget = widget;

        // ---- 高度治理（方向1：高度单一来源 = 前端布局，根治节点下方死区）----
        // 死区根因链（已核实前端 1.51.9 源码）：
        //   1) 旧 widget.computeSize 返回 [width,-1] → _arrangeWidgets 的 computeSize
        //      分支优先，computedHeight = -1+4 = 3px，computeLayoutSize(minHeight:220)
        //      分支被短路成死代码 → 前端 DomWidgets 给 wrapper 的高度≈0；
        //   2) 容器真实高度由 syncH 手写（node高-widget.y-16，画布逻辑像素），
        //      而定位由前端按缩放换算 —— 高度不随缩放、位置随缩放，缩小画布(ds<1)时
        //      容器底边越过节点绘制底边 d·(1-ds)-16px，形成溢出条带；
        //   3) 溢出条带被 canvasWrapper(flex:1, pointer-events:auto) 填满 → 滚轮/拖画布失效。
        // 新方案：删除 computeSize 占位，让 _arrangeWidgets 走 computeLayoutSize 弹性
        // 分支（minHeight 保底 + 吸收节点剩余空间）；前端 DomWidget 组件会为
        // widget.element 挂 h-full/w-full 并按布局结果统一定位/定尺寸 —— 高度单一来源。
        // pointer-events 治理维持不变：容器 eventless，仅交互子区域恢复 auto。
        const _enablePTE = (el) => { if (el) el.style.pointerEvents = "auto"; };
        if (container) container.style.pointerEvents = "none";
        _enablePTE(toolbar);   // 执行按钮/框选/手绘/轨道 1-8/关/垃圾桶
        _enablePTE(trackBar);  // 手工跟踪轨道按钮
        _enablePTE(tracker);   // 帧号 + 播放条拖动区(hitzone)
        _enablePTE(canvasWrapper); // 画布框选/涂抹、overlay 与进度条自身已显式 none
        // 宽度防溢出（同点编辑器）：始终跟随节点实际宽度
        const _xzgNode = node;
        Object.defineProperty(widget, 'width', {
            configurable: true,
            get() { return _xzgNode?.size?.[0] || 0; },
            set(_) { /* 忽略外部写入 */ },
        });
        // 注意：不再设置 widget.computeSize（旧返回 [width,-1]）——
        // 高度由 computeLayoutSize + 前端布局接管（见下方尺寸管理段）。

        // 隐藏 regions_data 输入框
        dataWidget.computeSize = () => [0, 0];
        dataWidget.hidden = true;
        setTimeout(() => { if (dataWidget.element || dataWidget.inputEl) (dataWidget.element || dataWidget.inputEl).style.display = 'none'; }, 50);

        // ---- 状态 ----
        const state = {
            image: null,            // 当前显示帧
            mode: 'off',            // 初始化即固定 'manual'（off/filter 仅存于历史防御分支）
            manualKeyframes: {},
            lockedKeyframe: null,
            autoTracking: {tracks: {}},
            fillEdges: true,
            trackId: 1,
            sampleIdx: [],
            frames: [],             // 预加载的采样帧 Image 数组
            frameIdx: 0,
            detectRegions: [],      // 检测区（归一化 0~1 {x1,y1,x2,y2}）
            excludeRegions: [],     // 排除区（归一化 0~1 {x1,y1,x2,y2}）
            // (mode 已在上方定义)         // 'detect' | 'exclude'
            drawing: null,          // 正在画的框（图像坐标）
            shapeSelected: true, curveDraft: null, curveDrag: null, rectDrag: null,
            tool: 'rect',           // 'rect' 框选 | 'brush' 贝塞尔曲线
        };

        // ---- 图像 contain 居中布局 ----
        const TRACK_COLORS = ['#ff3b30','#30d158','#ffd60a','#0a84ff','#cba46c','#00bcd4','#bf5af2','#c0c0c0'];
        const calcLayout = () => {
            // 画布内部像素固定为图像分辨率（见 syncSize：state.image 加载后一次性设置），
            // 画面与检测框都按此坐标绘制；canvas 的 CSS 尺寸由 _updateSurfaceCss 在 30px 留边内
            // 以 contain 方式精确设定，浏览器等比显示。
            const iw = canvas.width || 1, ih = canvas.height || 1;
            return { dispW: iw, dispH: ih, imgW: iw, imgH: ih, left: 0, top: 0, dw: iw, dh: ih, scale: 1 };
        };

        // contain 适配 + 严格等比：canvas 在「去掉 30px 黑边后」的可视区域内，
        // 取容器宽/高 ÷ 图像宽/高的较小缩放系数，直接写 inline 宽高，由 flex 居中的宿主
        // 自动居中。画面始终完整可见、任意节点宽高组合都不变形也不被裁切，比例始终不变。
        const PAD = 30; // 视频与节点框之间的黑色留边（与 wrapper 的 padding:30px 保持一致）
        const _updateSurfaceCss = () => {
            const av = (canvasWrapper.clientWidth || 0) - 2 * PAD;
            const ah = (canvasWrapper.clientHeight || 0) - 2 * PAD;
            if (av < 1 || ah < 1) return;
            const iw = canvas.width || 1, ih = canvas.height || 1;
            const s = Math.min(av / iw, ah / ih);
            const wPx = Math.max(1, Math.round(iw * s)) + "px";
            const hPx = Math.max(1, Math.round(ih * s)) + "px";
            if (canvas.style.width !== wPx) canvas.style.width = wPx;
            if (canvas.style.height !== hPx) canvas.style.height = hPx;
        };
        const syncSize = () => {
            // canvas 内部像素固定为图像分辨率：state.image 加载后一次性设置，之后不再随容器变化，
            // 从根上避免「画布像素=y 随节点高度→ 画面缩放/跳变」。
            const iw = state.image ? (state.image.width || 0) : 0;
            const ih = state.image ? (state.image.height || 0) : 0;
            if (iw > 0 && ih > 0 && (canvas.width !== iw || canvas.height !== ih)) {
                canvas.width = iw; canvas.height = ih; redraw();
            }
            _updateSurfaceCss();
            // 播放条横条/竖杠每次同步都刷新：首次布局（宽为 0）时绘制会跳过，
            // 布局完成后若不触发尺寸变化就永远不会补画，故无条件执行
            drawKfBar();
        };

        // 屏幕坐标 → 图像坐标（含 ComfyUI 画布缩放归一化，与点编辑器一致）
        const toImg = (e) => {
            const rect = canvas.getBoundingClientRect();
            const L = calcLayout();
            const kx = rect.width > 0 ? L.dispW / rect.width : 1;
            const ky = rect.height > 0 ? L.dispH / rect.height : 1;
            const cssX = (e.clientX - rect.left) * kx;
            const cssY = (e.clientY - rect.top) * ky;
            return { x: (cssX - L.left) / L.scale, y: (cssY - L.top) / L.scale };
        };

        // ---- 绘制 ----
        // 手绘轨迹按弧长均匀重采样为 n 点（闭合轮廓，顶点数固定便于插值）
        const resamplePoly = (pts, n) => {
            if (!pts || !pts.length) return [];
            if (pts.length === 1) { const p = pts[0]; return Array(n).fill([p.x, p.y]); }
            const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
            const seg = []; let total = 0;
            for (let i = 1; i < pts.length; i++) { const d = dist(pts[i-1], pts[i]); seg.push(d); total += d; }
            if (total < 1e-9) { const p = pts[0]; return Array(n).fill([p.x, p.y]); }
            const out = []; let acc = 0, si = 0;
            for (let i = 0; i < n; i++) {
                const target = (i / n) * total;
                while (si < seg.length - 1 && acc + seg[si] < target) { acc += seg[si]; si++; }
                const tt = Math.max(0, Math.min(1, (target - acc) / (seg[si] || 1)));
                const a = pts[si], b = pts[si + 1];
                out.push([a.x + (b.x - a.x) * tt, a.y + (b.y - a.y) * tt]);
            }
            return out;
        };
        // Automatic smooth tangents: short edges limit handles to avoid large overshoots.
        // Explicitly adjusted handles remain manual when neighbouring anchors change.
        const smoothCurve = (curve, closed) => {
            if (curve.length < 2) return;
            curve.forEach((a, i) => {
                if (!a.auto) return;
                const prev = curve[i > 0 ? i-1 : closed ? curve.length-1 : 0];
                const next = curve[i+1 < curve.length ? i+1 : closed ? 0 : i];
                const dx = next.x-prev.x, dy = next.y-prev.y;
                const length = Math.hypot(dx,dy);
                const before = Math.hypot(a.x-prev.x,a.y-prev.y)/3;
                const after = Math.hypot(next.x-a.x,next.y-a.y)/3;
                const ux = length > 1e-9 ? dx/length : 0;
                const uy = length > 1e-9 ? dy/length : 0;
                a.in = {x:a.x-ux*before, y:a.y-uy*before};
                a.out = {x:a.x+ux*after, y:a.y+uy*after};
            });
        };
        const isCurveCorner = a => Math.hypot(a.in.x-a.x,a.in.y-a.y)<1e-9 && Math.hypot(a.out.x-a.x,a.out.y-a.y)<1e-9;
        const toggleCurveCorner = (curve, i, closed) => {
            const a=curve[i];
            if (a.roundness !== undefined) {
                a.roundness = a.roundness ? 0 : .25;
                return;
            }
            if (isCurveCorner(a)) {
                if (a.smoothHandles) {
                    const h=a.smoothHandles;
                    a.in={x:a.x+h.in.x,y:a.y+h.in.y};
                    a.out={x:a.x+h.out.x,y:a.y+h.out.y};
                    a.auto=h.auto;
                    delete a.smoothHandles;
                } else a.auto=true;
                smoothCurve(curve,closed);
            } else {
                a.smoothHandles={in:{x:a.in.x-a.x,y:a.in.y-a.y},out:{x:a.out.x-a.x,y:a.out.y-a.y},auto:a.auto};
                a.in={x:a.x,y:a.y}; a.out={x:a.x,y:a.y}; a.auto=false;
            }
        };
        const cubicPoint = (a, b, t) => {
            const u = 1-t;
            const value = k => u*u*u*a[k]+3*u*u*t*a.out[k]+3*u*t*t*b.in[k]+t*t*t*b[k];
            return {x:value('x'), y:value('y')};
        };
        // 命中范围以节点布局像素为基准，与可见手柄一起随画布缩放。
        const CONTROL_HIT_RADIUS = 15;
        const CURVE_CONTROL_HIT_RADIUS = 10;
        const OUTLINE_HIT_RADIUS = 8;
        const hitCurveSegment = (curve, p, width, height, closed) => {
            const outline = curveOutline(curve, closed);
            let best = null;
            const distance = q => ((q.x-p.x)*width)**2+((q.y-p.y)*height)**2;
            for (let i=0; i<(closed ? outline.length : outline.length-1); i++) {
                if (outline !== curve && i % 2 === 0) continue;
                const a=outline[i], b=outline[(i+1)%outline.length];
                // Search each small interval, including curves with multiple local minima.
                for (let j=0; j<64; j++) {
                    let lo=j/64, hi=(j+1)/64;
                    for (let k=0; k<12; k++) {
                        const l=lo+(hi-lo)/3, r=hi-(hi-lo)/3;
                        if (distance(cubicPoint(a,b,l)) < distance(cubicPoint(a,b,r))) hi=r; else lo=l;
                    }
                    const t=(lo+hi)/2, d=distance(cubicPoint(a,b,t));
                    if (d<(OUTLINE_HIT_RADIUS * controlScreenScale())**2 && (!best || d<best.d)) {
                        best={i:outline === curve ? i : Math.floor(i/2),t,d,point:cubicPoint(a,b,t)};
                    }
                }
            }
            return best;
        };
        const insideCurve = (curve, p) => {
            const pts=curvePoly(curve);
            let inside=false;
            for (let i=0,j=pts.length-1;i<pts.length;j=i++) {
                const [x,y]=pts[i], [u,v]=pts[j];
                if ((y>p.y)!==(v>p.y) && p.x<(u-x)*(p.y-y)/(v-y)+x) inside=!inside;
            }
            return inside;
        };
        const hitEditableRegion = (r, p, cr) => {
            // Rectangles can be activated anywhere inside; curves retain outline selection.
            if (r.curve) return insideCurve(r.curve,p) || !!hitCurveSegment(r.curve,p,cr.width,cr.height,true);
            if (!r.poly && p.x>=r.x1 && p.x<=r.x2 && p.y>=r.y1 && p.y<=r.y2) return true;
            const vertices=r.poly || [[r.x1,r.y1],[r.x2,r.y1],[r.x2,r.y2],[r.x1,r.y2]];
            const px=p.x*cr.width, py=p.y*cr.height;
            return vertices.some((v,i) => {
                const w=vertices[(i+1)%vertices.length];
                const ax=v[0]*cr.width, ay=v[1]*cr.height;
                const dx=(w[0]-v[0])*cr.width, dy=(w[1]-v[1])*cr.height;
                const length=dx*dx+dy*dy;
                const t=length ? Math.max(0,Math.min(1,((px-ax)*dx+(py-ay)*dy)/length)) : 0;
                return Math.hypot(px-ax-t*dx,py-ay-t*dy)<OUTLINE_HIT_RADIUS * controlScreenScale();
            });
        };
        const splitCurveSegment = (curve, i, t) => {
            const a=curve[i], b=curve[(i+1)%curve.length];
            const lerp=(p,q)=>({x:p.x+(q.x-p.x)*t,y:p.y+(q.y-p.y)*t});
            const p=lerp(a,a.out), q=lerp(a.out,b.in), r=lerp(b.in,b);
            const u=lerp(p,q), v=lerp(q,r), point=lerp(u,v);
            a.out=p; b.in=r; a.auto=false; b.auto=false;
            curve.splice(i+1,0,{...point,in:u,out:v,auto:false});
            return i+1;
        };
        // Keep editable cubic anchors alongside the polygon consumed by the mask backend.
        const curvePoly = (curve) => {
            curve = curveOutline(curve);
            const pts = [];
            curve.forEach((a, i) => {
                const b = curve[(i + 1) % curve.length];
                for (let j = 0; j < 32; j++) {
                    const t = j / 32, u = 1 - t;
                    const value = k => u*u*u*a[k] + 3*u*u*t*a.out[k] + 3*u*t*t*b.in[k] + t*t*t*b[k];
                    pts.push({x: value('x'), y: value('y')});
                }
            });
            pts.push({...pts[0]});
            return resamplePoly(pts, 96);
        };
        const saveCurve = (curve, original) => {
            const tid = state.trackId;
            const auto = state.autoTracking;
            const frames = auto?.video_id === state.srcKey ? auto?.tracks?.[tid] : null;
            if (original?.length === curve.length && frames && lockedEditFrame() === null) {
                const start = state.frameIdx;
                for (const direction of [-1, 1]) {
                    for (let distance = 1; distance < 12; distance++) {
                        const frame = start + direction * distance;
                        if (frame < 0 || frame >= state.frames.length || state.manualKeyframes[tid]?.[frame]?.length) break;
                        const region = frames[state.sampleIdx[frame] ?? frame];
                        if (region?.curve?.length !== curve.length) break;
                        const weight = 1 - distance / 12;
                        region.curve.forEach((node, i) => {
                            const offset = (point, edited, base) => {
                                point.x += (edited.x - base.x) * weight;
                                point.y += (edited.y - base.y) * weight;
                            };
                            offset(node, curve[i], original[i]);
                            offset(node.in, curve[i].in, original[i].in);
                            offset(node.out, curve[i].out, original[i].out);
                            if (curve[i].roundness !== undefined && node.roundness !== undefined) {
                                node.roundness = Math.max(0, Math.min(.5,
                                    node.roundness + (curve[i].roundness - (original[i].roundness ?? .25)) * weight));
                            }
                        });
                        region.poly = curvePoly(region.curve);
                        region.manual_transition = true;
                    }
                }
            }
            state.manualKeyframes[tid] ||= {};
            state.manualKeyframes[tid][editFrame()] = [{curve, poly: curvePoly(curve)}];
            writeData(); refreshTrackBtns();
        };
        const cancelCurve = () => {
            if (state.curveDrag && !state.curveDraft) saveCurve(state.curveDrag.curve, state.curveDrag.original);
            finishRectDrag();
            state.curveDraft = null; state.curveDrag = null; redraw();
        };
        window.addEventListener('keydown', e => {
            if (!_panelHover || e.key !== 'Escape') return;
            e.preventDefault(); e.stopPropagation(); cancelCurve();
        });
        // 多边形有向面积（符号判定绕向；归一化坐标与像素坐标绕向一致）
        const polySignedArea = (pts) => {
            let s = 0;
            for (let i = 0; i < pts.length; i++) {
                const a = pts[i], b = pts[(i + 1) % pts.length];
                s += a[0] * b[1] - b[0] * a[1];
            }
            return s / 2;
        };
        // 多边形插值对齐：绕向统一（反则反转）+ 起点对齐（旋转到距前帧首点最近）——
        // 两帧关键帧绘制方向/起笔位置不同时，中间帧不再翻转折叠，只做形状渐变
        const alignPoly = (pb, pa) => {
            let pts = pb.map(p => [p[0], p[1]]);
            if (polySignedArea(pts) * polySignedArea(pa) < 0) pts.reverse();
            let bi = 0, bd = Infinity;
            for (let i = 0; i < pts.length; i++) {
                const d = (pts[i][0] - pa[0][0]) ** 2 + (pts[i][1] - pa[0][1]) ** 2;
                if (d < bd) { bd = d; bi = i; }
            }
            return pts.slice(bi).concat(pts.slice(0, bi));
        };
        // Match the backend's monotone interpolation of rectangle centers and sizes.
        const interpolateRectangle = (kfs, keys, index, t) => {
            const a = keys[index - 1], b = keys[index], span = b - a;
            const box = frame => {
                const r = kfs[frame]?.[0];
                if (!r || r.poly || r.curve) return null;
                return [(r.x1 + r.x2) / 2, (r.y1 + r.y2) / 2, r.x2 - r.x1, r.y2 - r.y1];
            };
            const tangent = (first, second, leftSpan, rightSpan) => {
                if (first * second <= 0) return 0;
                const w1 = 2 * rightSpan + leftSpan, w2 = rightSpan + 2 * leftSpan;
                return (w1 + w2) / (w1 / first + w2 / second);
            };
            const previous = box(keys[index - 2]), following = box(keys[index + 1]);
            const right = box(b);
            const [x, y, w, h] = box(a).map((start, i) => {
                const end = right[i], slope = (end - start) / span;
                const leftSpan = a - keys[index - 2], rightSpan = keys[index + 1] - b;
                const edgeSlope = state.fillEdges ? 0 : slope;
                const m0 = previous ? tangent((start - previous[i]) / leftSpan, slope, leftSpan, span) : edgeSlope;
                const m1 = following ? tangent(slope, (following[i] - end) / rightSpan, span, rightSpan) : edgeSlope;
                const ramp = .2;
                const cruise = (slope - ramp * (m0 + m1) / 2) / (1 - ramp);
                if (t < ramp) return start + span * t * (m0 + (cruise - m0) * t / (2 * ramp));
                if (t > 1 - ramp) {
                    const tail = 1 - t;
                    return end - span * tail * (m1 + (cruise - m1) * tail / (2 * ramp));
                }
                return start + span * (m0 * ramp / 2 + cruise * (t - ramp / 2));
            });
            return {x1:x - w / 2, y1:y - h / 2, x2:x + w / 2, y2:y + h / 2};
        };
        // Resolve the same outline for drawing, hovering and promotion to a keyframe.
        const visibleTrackRegions = (tid, frame) => {
            const kfs = state.manualKeyframes[tid] || {};
            if (kfs[frame]?.length) return kfs[frame];
            const auto = state.autoTracking;
            const tracked = auto?.video_id === state.srcKey
                ? auto?.tracks?.[tid]?.[state.sampleIdx?.[frame] ?? frame] : null;
            if (tracked) return [tracked];
            const keys = Object.keys(kfs).map(Number)
                .filter(k => Number.isInteger(k) && k >= 0 && k < state.frames.length && kfs[k]?.length)
                .sort((a,b)=>a-b);
            if (!keys.length) return [];
            const before = keys.filter(k => k < frame).at(-1);
            const after = keys.find(k => k > frame);
            if (before === undefined || after === undefined) {
                return state.fillEdges ? kfs[before ?? after] : [];
            }
            const a = kfs[before][0], b = kfs[after][0], t = (frame-before)/(after-before);
            const mix = (x,y) => x+(y-x)*t;
            if (a.curve && b.curve && a.curve.length === b.curve.length) {
                // Match anchor order and winding before interpolating handles.
                const pa = a.curve.map(q => [q.x,q.y]);
                const pb = b.curve.map(q => [q.x,q.y]);
                const aligned = alignPoly(pb,pa);
                const reverse = polySignedArea(pa)*polySignedArea(pb)<0;
                const curve = a.curve.map((q,i) => {
                    const j = pb.findIndex(v => v[0]===aligned[i][0] && v[1]===aligned[i][1]);
                    const r = b.curve[j];
                    const point = (u,v) => ({x:mix(u.x,v.x), y:mix(u.y,v.y)});
                    const node = {...point(q,r), in:point(q.in,reverse?r.out:r.in), out:point(q.out,reverse?r.in:r.out), auto:false};
                    if (q.roundness !== undefined || r.roundness !== undefined) node.roundness = mix(q.roundness ?? .25, r.roundness ?? .25);
                    return node;
                });
                return [{curve, poly:curvePoly(curve)}];
            }
            if (a.poly && b.poly && a.poly.length===b.poly.length && a.poly.length>=3) {
                const aligned = alignPoly(b.poly,a.poly);
                return [{poly:a.poly.map((q,i)=>[mix(q[0],aligned[i][0]),mix(q[1],aligned[i][1])])}];
            }
            if (!a.poly && !b.poly) return [interpolateRectangle(kfs, keys, keys.indexOf(after), t)];
            return state.fillEdges ? kfs[t < 0.5 ? before : after] : [];
        };
        const isLockedKeyframe = (tid, frame) => {
            const lock = state.lockedKeyframe;
            return !!lock && lock.track === state.manualKeyframes[tid] && lock.frame === frame;
        };
        const lockedEditFrame = () => {
            const lock = state.lockedKeyframe;
            return lock && lock.frame < state.frames.length && isLockedKeyframe(state.trackId, lock.frame) &&
                lock.track[lock.frame]?.length ? lock.frame : null;
        };
        const editFrame = () => lockedEditFrame() ?? state.frameIdx;
        const promoteVisibleRegion = tid => {
            const kfs = state.manualKeyframes[tid];
            const frame = tid === state.trackId ? editFrame() : state.frameIdx;
            if (kfs[frame]?.length) return kfs[frame][0];
            const regions = JSON.parse(JSON.stringify(visibleTrackRegions(tid,frame)));
            if (!regions.length) return null;
            // Old polygon-only tracks remain editable as closed, straight cubic segments.
            for (const r of regions) if (r.poly && !r.curve) {
                r.curve = r.poly.map(([x,y])=>({x,y,in:{x,y},out:{x,y},auto:false}));
            }
            kfs[frame] = regions;
            return regions[0];
        };
        const drawRegionBox = (r, color, fill, label) => {
            const L = calcLayout();
            ctx.save();
            if (r.poly && Array.isArray(r.poly) && r.poly.length >= 3) {
                // 多边形：1px 实线、无填充（与矩形框一致的细线样式）。
                // 裁剪到视频区显示：手绘允许画进黑边（绘制中黑边内实时显示笔迹），
                // 松手成关键帧后黑边内轮廓不再显示，仅显示视频区内的部分；
                // 数据仍保存完整多边形（含黑边段），后端遮罩由 fillPoly 按画布裁剪，
                // 边角覆盖能力不受影响。
                ctx.save();
                ctx.beginPath();
                ctx.rect(L.left, L.top, L.dw, L.dh);
                ctx.clip();
                ctx.strokeStyle = color;
                ctx.lineWidth = 1;
                ctx.beginPath();
                r.poly.forEach((p, i) => {
                    const px = L.left + p[0] * L.dw, py = L.top + p[1] * L.dh;
                    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
                });
                ctx.closePath();
                ctx.stroke();
                if (fill) { ctx.fillStyle = fill; ctx.fill(); }
                ctx.restore();
                if (label) { ctx.fillStyle = color; ctx.font = "14px sans-serif"; ctx.textAlign = "left"; ctx.fillText(label, L.left + r.poly[0][0] * L.dw + 3, L.top + r.poly[0][1] * L.dh + 14); }
                ctx.restore();
                return;
            }
            const px = L.left + r.x1 * L.dw, py = L.top + r.y1 * L.dh;
            const pw = (r.x2 - r.x1) * L.dw, ph = (r.y2 - r.y1) * L.dh;
            ctx.strokeStyle = color;
            ctx.lineWidth = 1;
            ctx.strokeRect(px, py, pw, ph);
            if (fill) { ctx.fillStyle = fill; ctx.fillRect(px, py, pw, ph); }
            if (label) { ctx.fillStyle = color; ctx.font = "14px sans-serif"; ctx.textAlign = "left"; ctx.fillText(label, px + 3, py + 14); }
            ctx.restore();
        };

        // 命中检测（图像像素坐标）：多边形用射线法，矩形用包含判断
        const hitTestBox = (r, px, py, L) => {
            if (r && r.poly && Array.isArray(r.poly) && r.poly.length >= 3) {
                let inside = false;
                const pts = r.poly.map(p => [p[0] * L.imgW, p[1] * L.imgH]);
                for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
                    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
                    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
                }
                return inside;
            }
            return px >= r.x1 * L.imgW && px <= r.x2 * L.imgW && py >= r.y1 * L.imgH && py <= r.y2 * L.imgH;
        };

        const redraw = () => {
            drawKfBar();
            const L = calcLayout();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, L.dispW, L.dispH);
            ctx.fillStyle = "#0f1011";
            ctx.fillRect(0, 0, L.dispW, L.dispH);
            if (state.image) {
                ctx.drawImage(state.image, L.left, L.top, L.dw, L.dh);
                state.detectRegions.forEach(r => drawRegionBox(r, "#22c55e", null, "检测"));
                // 标注轮廓由屏幕分辨率 overlay 绘制，视频画布仅保留图像。
                // 方框/涂抹的实时预览均已迁移至 brushOverlay（覆盖含黑边的整个 wrapper 区域）：
                // 主画布位图=图像本身，黑边内笔画会被位图边界裁掉，主画布不再负责实时预览
            }
            drawActiveOverlay();
        };

        // 读取原生 range thumb 的真实半径（WebKit/Moz），读不到兜底 8px。
        // 刻度/竖杠坐标系必须基于此半径：thumb 中心只落在 [r, 宽-r] 区间。
        const getThumbRadius = () => {
            // thumb 宽度由本文件注入样式固定为 16px，半径恒定 8px。
            // 不动态读取计算样式，避免个别浏览器伪元素返回异常值导致对齐/宽度计算错误
            return 8;
        };

        // ---- 轨道和画布的右键菜单 ----
        let _barMenuEl = null;
        const closeBarMenu = () => { if (_barMenuEl) { _barMenuEl.remove(); _barMenuEl = null; } };
        const showBarMenu = (x, y, items) => {
            closeBarMenu();
            const menu = document.createElement("div");
            menu.style.cssText = "position:fixed;z-index:100000;min-width:130px;padding:4px;background:rgba(24,26,33,0.97);border:1px solid rgba(255,255,255,0.16);border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,0.55);color:#e8e8e8;font:13px/1.4 sans-serif;user-select:none;";
            items.forEach(({ label, fn, color }) => {
                const it = document.createElement("div");
                it.style.cssText = "padding:6px 12px;border-radius:5px;cursor:pointer;white-space:nowrap;";
                if (color) it.style.color = color;
                it.innerText = label;
                it.addEventListener("mouseenter", () => { it.style.background = "rgba(255,255,255,0.08)"; });
                it.addEventListener("mouseleave", () => { it.style.background = "transparent"; });
                it.addEventListener("click", (ev) => { ev.stopPropagation(); closeBarMenu(); fn(); });
                menu.appendChild(it);
            });
            (workspace?.overlay || document.body).appendChild(menu);
            const r = menu.getBoundingClientRect();
            menu.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4)) + "px";
            menu.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) + "px";
            _barMenuEl = menu;
        };
        // 点击菜单外任意处关闭
        document.addEventListener("pointerdown", (e) => {
            if (_barMenuEl && !_barMenuEl.contains(e.target)) closeBarMenu();
        }, true);

        const scaleAllRectangles = factor => {
            stopPlay();
            const rectangles = new Set();
            for (const track of Object.values(state.manualKeyframes)) {
                for (const regions of Object.values(track)) {
                    for (const region of regions) rectangles.add(region);
                }
            }
            for (const track of Object.values(activeAutoTracks())) {
                for (const region of Object.values(track)) rectangles.add(region);
            }
            let changed = false;
            for (const region of rectangles) {
                if (!region || region.poly || region.curve) continue;
                const {x1, y1, x2, y2} = region;
                if (![x1, y1, x2, y2].every(Number.isFinite) || x1 >= x2 || y1 >= y2) continue;
                const dx = (x2 - x1) * (factor - 1) / 2;
                const dy = (y2 - y1) * (factor - 1) / 2;
                Object.assign(region, {x1: x1 - dx, y1: y1 - dy, x2: x2 + dx, y2: y2 + dy});
                changed = true;
            }
            if (changed) {
                writeData();
                updateCurveCursor();
                redraw();
            } else {
                app.extensionManager?.toast?.add({
                    summary: "全局调整", detail: "当前视频没有可调整的矩形框", severity: "info",
                });
            }
        };

        // ---- 关键帧拖动：按住三角左右移动，松手落位 ----
        // 拖动状态放在节点闭包层：拖动过程中 showFrame→redraw 会重建三角元素，
        // 状态不能挂在元素上，否则重建即丢
        let _kfDrag = null; // { trackId, from, cur }
        // 与播放条拖拽（setFrameFromX）同一套坐标换算：thumb 中心落在 [r, 宽-r]
        const kfFrameAtX = (clientX) => {
            const nf = state.frames.length;
            const rect = slider.getBoundingClientRect();
            const w = rect.width;
            if (w <= 0 || nf < 1) return -1;
            const r = 8;
            const frac = (clientX - rect.left - r) / (w - 2 * r);
            return Math.max(0, Math.min(nf - 1, Math.round(frac * (nf - 1))));
        };
        window.addEventListener("mousemove", (e) => {
            if (!_kfDrag) return;
            const to = kfFrameAtX(e.clientX);
            if (to < 0 || to === _kfDrag.cur) return;
            const km = state.manualKeyframes[_kfDrag.trackId];
            if (!km) return;
            const data = km[_kfDrag.cur];
            if (!data) { _kfDrag = null; return; }
            if (isLockedKeyframe(_kfDrag.trackId, _kfDrag.cur)) state.lockedKeyframe.frame = to;
            else if (isLockedKeyframe(_kfDrag.trackId, to)) state.lockedKeyframe = null;
            delete km[_kfDrag.cur];
            km[to] = data;   // 目标位置已有关键帧时直接覆盖
            _kfDrag.cur = to;
            showFrame(to);   // 播放头、帧号、画面跟随拖动位置
        });
        window.addEventListener("mouseup", () => {
            if (!_kfDrag) return;
            if (_kfDrag.cur !== _kfDrag.from) writeData(); // 位置有变化才持久化
            _kfDrag = null;
        });

        const drawKfBar = () => {
            const nf = (state.frames || []).length;
            const kfsAll = state.manualKeyframes || {};
            const tids = !nf ? [] : _solo ? [state.trackId] : Object.keys(kfsAll).map(Number).sort((a, b) => a - b);
            const requiredHeight = `${playbackRowHeight + 1 + tids.length * laneHeight}px`;
            if (tracker.style.flexBasis !== requiredHeight) tracker.style.flexBasis = requiredHeight;
            // 以滑块 content box 为基准（补偿可能的 border/padding），
            // 保证刻度坐标与浏览器定位 thumb 使用的坐标系完全一致
            const left = slider.offsetLeft + ((slider.offsetWidth - slider.clientWidth) / 2);
            const barTop = slider.offsetTop;
            const w = slider.clientWidth || slider.offsetWidth;
            if (!w) { kfBar.innerHTML = ""; requestAnimationFrame(() => drawKfBar()); return; }
            kfBar.style.left = left + "px";
            kfBar.style.right = Math.max(0, tracker.clientWidth - left - w) + "px";
            // 点击判定区左边界与滑条左缘保持同步（帧号文本宽度变化会推移滑条位置）
            hitzone.style.left = left + "px";
            // 播放头 thumb 中心只落在 [r, 宽-r] 区间（原生 range 行为），
            // 横条/竖杠按同一坐标系摆放，才能与播放头竖条一一对齐
            const r = getThumbRadius();
            const usable = Math.max(0, w - 2 * r);
            const nfDiv = Math.max(1, nf - 1);  // 帧索引 0..N-1 作为刻度分母
            const posX = (i) => r + (nf ? (i / nfDiv) * usable : 0);
            const frag = document.createDocumentFragment();
            // 播放条横条：始终显示，两端对齐 thumb 中心可达范围 [r, 宽-r]
            const bar = document.createElement("div");
            const barW = nf > 0 ? Math.max(0, posX(nf - 1) - posX(0)) : usable;
            const barLeft = Math.max(0, Math.min(w - 2, posX(0)));
            bar.style.cssText = `position:absolute;left:${barLeft}px;top:${barTop}px;width:${Math.max(4, barW)}px;height:4px;border-radius:2px;background:#5f5f5f;`;
            frag.appendChild(bar);
            const auto = state.autoTracking;
            const tracked = auto?.video_id === state.srcKey ? auto?.tracks?.[state.trackId] : null;
            if (tracked) {
                const keys = state.manualKeyframes[state.trackId] || {};
                const usesTracking = frame => frame >= 0 && frame < nf &&
                    !keys[frame]?.length && !!tracked[state.sampleIdx?.[frame] ?? frame];
                let start = null;
                for (let frame = 0; frame <= nf; frame++) {
                    const joinsTracking = keys[frame]?.length && usesTracking(frame + 1) &&
                        (frame === 0 || usesTracking(frame - 1));
                    if (usesTracking(frame) || joinsTracking) {
                        start ??= frame;
                    } else if (start !== null) {
                        const x = posX(Math.max(0, start - .5));
                        const end = posX(Math.min(nf - 1, frame - .5));
                        const segment = document.createElement("div");
                        segment.style.cssText = `position:absolute;left:${x}px;top:${barTop}px;width:${Math.max(1, end-x)}px;height:4px;background:#30d158;pointer-events:none;`;
                        frag.appendChild(segment);
                        start = null;
                    }
                }
            }
            // 每个已建立的颜色分类占用独立播放条，关键帧不会挤在同一行。
            tids.forEach((tid, lane) => {
                const kfs = kfsAll[tid] || {};
                const trackColor = TRACK_COLORS[(tid - 1) % TRACK_COLORS.length];
                const laneY = playbackRowHeight + 1 + lane * laneHeight;
                const laneBar = document.createElement("div");
                laneBar.style.cssText = `position:absolute;left:${posX(0)}px;top:${laneY + 7}px;width:${Math.max(4, posX(nf - 1) - posX(0))}px;height:4px;border-radius:2px;background:#454545;pointer-events:none;`;
                frag.appendChild(laneBar);
                Object.keys(kfs).map(Number).forEach(fr => {
                    if (!Array.isArray(kfs[fr]) || !kfs[fr].length) return;
                    // 点击热区仅包住三角（16×16，四周留少量余量），不向下延伸到播放条区域，
                    // 避免误触发：三角下方仍走播放条的拖拽换帧判定
                    const hit = document.createElement("div");
                    hit.style.cssText = `position:absolute;left:${posX(fr) - 8}px;top:${laneY}px;width:16px;height:16px;display:flex;align-items:center;justify-content:center;cursor:pointer;pointer-events:auto;`;
                    const locked = isLockedKeyframe(tid, fr);
                    hit.title = `第 ${fr} 帧关键帧（${locked ? "已锁定编辑 / " : ""}点击跳转 / 拖动移动）`;
                    hit.addEventListener("contextmenu", e => {
                        e.preventDefault();
                        e.stopPropagation();
                        showBarMenu(e.clientX, e.clientY, [{
                            label: locked ? "不生成关键帧(关闭)" : "不生成关键帧(开启)",
                            color: locked ? "#30d158" : "#00ffff",
                            fn: () => {
                                if (state.manualKeyframes[tid] !== kfs || !kfs[fr]?.length) return;
                                stopPlay();
                                state.lockedKeyframe = locked ? null : {track: kfs, frame: fr};
                                selectTrack(tid);
                                updateCurveCursor();
                            },
                        }, {
                            label: "全局调整（所有矩形框）",
                            color: "#ffd700",
                            fn: () => showBarMenu(e.clientX, e.clientY, [
                                {label: "放大 5%", fn: () => scaleAllRectangles(1.05)},
                                {label: "放大 10%", fn: () => scaleAllRectangles(1.10)},
                                {label: "放大 20%", fn: () => scaleAllRectangles(1.20)},
                                {label: "缩小 5%", fn: () => scaleAllRectangles(.95)},
                                {label: "缩小 10%", fn: () => scaleAllRectangles(.90)},
                                {label: "缩小 20%", fn: () => scaleAllRectangles(.80)},
                            ]),
                        }, {
                            label: "删除关键帧",
                            color: "#ff6961",
                            fn: () => {
                                if (state.manualKeyframes[tid] !== kfs || !kfs[fr]?.length) return;
                                if (isLockedKeyframe(tid, fr)) state.lockedKeyframe = null;
                                delete kfs[fr];
                                writeData();
                                refreshTrackBtns();
                                redraw();
                            },
                        }]);
                    });
                    // 按住左键开始拖动：移动中播放头与画面跟随，松手落位并持久化
                    hit.addEventListener("mousedown", (e) => {
                        if (e.button !== 0) return;
                        e.preventDefault();
                        e.stopPropagation();
                        spawnThumbGhost(); // 拖关键帧时播放头会跟随，先在播放头原位置留黑色参考残影
                        _kfDrag = { trackId: tid, from: fr, cur: fr };
                    });
                    const mark = document.createElementNS("http://www.w3.org/2000/svg", "svg");
                    mark.setAttribute("width", "14");
                    mark.setAttribute("height", "12");
                    mark.setAttribute("viewBox", "0 0 14 12");
                    mark.style.cssText = "display:block;flex-shrink:0;margin-top:1px;";
                    // 高亮规则：播放头停在关键帧帧号上（三角形正下方）→ 白边高亮；
                    // 鼠标悬停 → 同样高亮；两者都不满足 → 纯色无边框。
                    // showFrame → redraw → drawKfBar 会随播放头移动自动刷新
                    const active = fr === state.frameIdx;
                    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
                    path.setAttribute("d", "M1 1 L13 1 L7 11 Z");
                    path.setAttribute("fill", trackColor);
                    path.setAttribute("stroke", "#ffffff");
                    path.setAttribute("stroke-width", active ? "1.5" : "0");
                    path.setAttribute("stroke-linejoin", "round");
                    if (active) mark.style.filter = "drop-shadow(0 0 3px #ffffff)";
                    mark.appendChild(path);
                    if (locked) {
                        const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
                        dot.setAttribute("cx", "7");
                        dot.setAttribute("cy", "4");
                        dot.setAttribute("r", "2");
                        dot.setAttribute("fill", "#fff");
                        dot.setAttribute("stroke", "#141414");
                        dot.setAttribute("stroke-width", "0.7");
                        mark.appendChild(dot);
                    }
                    hit.addEventListener("mouseenter", () => {
                        path.setAttribute("stroke-width", "1.5");
                        mark.style.filter = "drop-shadow(0 0 3px #ffffff)";
                    });
                    hit.addEventListener("mouseleave", () => {
                        // 移开鼠标后：若播放头仍停在该帧则保持高亮，否则恢复无边框
                        const stillActive = fr === state.frameIdx;
                        path.setAttribute("stroke-width", stillActive ? "1.5" : "0");
                        mark.style.filter = stillActive ? "drop-shadow(0 0 3px #ffffff)" : "";
                    });
                    hit.appendChild(mark);
                    hit.addEventListener("click", (e) => {
                        e.stopPropagation();
                        showFrame(fr);
                    });
                    frag.appendChild(hit);
                });
            });
            kfBar.innerHTML = "";
            kfBar.appendChild(frag);
        };

        // ---- 帧切换 ----
        const clearRegions = () => {
            state.detectRegions = [];
            state.excludeRegions = [];
            state.manualKeyframes = {};
            state.autoTracking = {tracks: {}};
            state.trackingAreas = {};
            state.trackingAreaDraft = null;
            state.drawing = state.curveDraft = state.curveDrag = state.rectDrag = null;
            state.trackId = 1;
            trackUnlocked = new Set([1]);
        };
        const showFrame = (i) => {
            const nf = state.frames.length;
            if (!nf) return;
            state.trackingAreaDraft = null;
            // 0..N-1 索引语义：v=0 首帧，v=N-1 末帧（12 帧显示 0-11）
            i = Math.max(0, Math.min(nf - 1, i));
            // 跳帧预览不做任何清空：检测区/排除区框是跨帧全局的，画框后拖动播放头应保持；
            // 清空只发生在「载入新视频」时（见 onExecuted 里的 video_id 判断）
            state.frameIdx = i; state.shapeSelected = true;
            state.image = state.frames[i];
            state.curveDraft = null; state.curveDrag = null; state.rectDrag = null;
            clearBrushOverlay();
            frameInfo.innerText = `${i}/${nf - 1}`;
            slider.value = i;
            redraw();
        };
        slider.addEventListener("input", (e) => { stopPlay(); showFrame(parseInt(e.target.value)); });

        // 整个帧栏点击/拖动跳转：点空白处按 x 比例跳帧

        // ---- 框选交互 ----
        // 拖动画框的重绘节流：高频 pointermove 合并到每帧一次，拖动预览更流畅
        let _drawRAF = null;
        const scheduleRedraw = () => {
            if (_drawRAF) return;
            _drawRAF = requestAnimationFrame(() => { _drawRAF = null; redraw(); });
        };
        const curveToggleCursor = rounded => {
            const shape=rounded ? 'M12 27 Q12 12 27 12' : 'M12 27 L12 12 L27 12';
            const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36"><path d="M2 2 L2 17 L6 13 L10 21 L13 19 L9 11 L15 11 Z" fill="white" stroke="black" stroke-width="1.5"/><path d="${shape}" fill="none" stroke="#101820" stroke-width="5"/><path d="${shape}" fill="none" stroke="#80ffff" stroke-width="2.5"/></svg>`;
            return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 2 2, pointer`;
        };
        const cornerCursor=curveToggleCursor(false), smoothCursor=curveToggleCursor(true);
        let curveHoverPointer=null, curveAltDown=false;
        const rectDragTarget = (r, p, cr, hitRadius = CONTROL_HIT_RADIUS) => {
            if (!r || r.poly) return null;
            const radius = hitRadius * controlScreenScale();
            const width = (r.x2-r.x1)*cr.width, height = (r.y2-r.y1)*cr.height;
            const handleRadius = Math.min(radius, Math.min(width, height)/3);
            const corners = [['x1','y1'], ['x2','y1'], ['x2','y2'], ['x1','y2']];
            const corner = corners.find(([x,y]) => Math.hypot((r[x]-p.x)*cr.width, (r[y]-p.y)*cr.height)
                < Math.min(radius + 3 * controlScreenScale(), Math.min(width, height)/2));
            if (corner) return {keys:corner, cursor:(corner[0]==='x1') === (corner[1]==='y1') ? 'nwse-resize' : 'nesw-resize'};
            const inX = p.x >= r.x1 && p.x <= r.x2, inY = p.y >= r.y1 && p.y <= r.y2;
            const edges = [['x1',inY,cr.width,p.x], ['x2',inY,cr.width,p.x], ['y1',inX,cr.height,p.y], ['y2',inX,cr.height,p.y]];
            const edge = edges.filter(([key,inside,scale,v]) => inside && Math.abs(r[key]-v)*scale < handleRadius)
                .sort((a,b) => Math.abs(r[a[0]]-a[3])*a[2] - Math.abs(r[b[0]]-b[3])*b[2])[0];
            if (edge) return {keys:[edge[0]], cursor:edge[0][0]==='x' ? 'ew-resize' : 'ns-resize'};
            const inset = Math.min(handleRadius + 3 * controlScreenScale(), Math.min(width, height)*.4);
            return inX && inY && Math.min((p.x-r.x1)*cr.width, (r.x2-p.x)*cr.width,
                (p.y-r.y1)*cr.height, (r.y2-p.y)*cr.height) >= inset ? {keys:[], cursor:'move'} : null;
        };
        const curveBoundsTarget = (box, p, cr) => rectDragTarget(box, p, cr, 6);
        const canMoveCurve = (curve, p, cr) => {
            if (!insideCurve(curve, p)) return false;
            const points = curvePoly(curve);
            const margin = 8 * controlScreenScale();
            return points.every(([x,y], i) => {
                const [u,v] = points[(i+1)%points.length];
                const dx = (u-x)*cr.width, dy = (v-y)*cr.height;
                const px = (p.x-x)*cr.width, py = (p.y-y)*cr.height;
                const t = Math.max(0, Math.min(1, (px*dx+py*dy)/(dx*dx+dy*dy || 1)));
                return Math.hypot(px-t*dx,py-t*dy) >= margin;
            });
        };
        const updateCurveCursor = () => {
            let cursor='crosshair', title='';
            let hover = null;
            if (curveHoverPointer && state.image && state.mode==='manual') {
                const cr=canvas.getBoundingClientRect();
                const p={x:(curveHoverPointer.clientX-cr.left)/cr.width,y:(curveHoverPointer.clientY-cr.top)/cr.height};
                const near=q=>Math.hypot((q.x-p.x)*cr.width,(q.y-p.y)*cr.height)<CURVE_CONTROL_HIT_RADIUS * controlScreenScale();
                const region = state.shapeSelected ? visibleTrackRegions(state.trackId, editFrame())[0] : null;
                const curve = state.curveDraft || region?.curve;
                const controls = curve?.length ? curveControls(curve, cr, controlScreenScale(), !state.curveDraft || curve.length >= 3) : null;
                const anchorIndex = controls?.anchors.findIndex(near) ?? -1;
                const handleIndex = controls?.handles.findIndex(near) ?? -1;
                const anchor = curve?.[anchorIndex];
                const bounds = !state.curveDraft && controls ? curveBoundsTarget(controls.box,p,cr) : null;
                if (state.curveDrag?.kind === 'bounds') {
                    cursor = state.curveDrag.cursor;
                } else if (state.rectDrag) {
                    const {keys, cursor: dragCursor} = state.rectDrag;
                    hover = keys.length ? {kind:"resize", keys} : {kind:"whole"};
                    cursor = dragCursor || "move";
                } else if (state.curveDrag) {
                    const {kind, i:index} = state.curveDrag;
                    hover = {kind:kind === "roundness" ? "handle" : kind, index};
                    cursor = "move";
                } else if (bounds?.keys.length === 2) {
                    cursor = bounds.cursor;
                } else if (anchor && curveAltDown && !state.curveDrag) {
                    const rounded=anchor.roundness === undefined ? isCurveCorner(anchor) : anchor.roundness === 0;
                    cursor=rounded?smoothCursor:cornerCursor;
                    title=rounded?'Alt 单击：恢复平滑曲线':'Alt 单击：转换为尖角';
                } else if (anchor || handleIndex >= 0) {
                    hover = anchor ? {kind:"anchor", index:anchorIndex} : {kind:"handle", index:handleIndex};
                    cursor = "move";
                }
                else if (!state.curveDraft) {
                    const rect = curve?.length
                        ? curveBoundsTarget(curveControls(curve, cr, controlScreenScale()).box, p, cr)
                        : rectDragTarget(region, p, cr);
                    if (rect?.keys.length) {
                        cursor=rect.cursor;
                        if (!curve) hover = {kind:"resize", keys:rect.keys};
                    } else if (curve ? canMoveCurve(curve,p,cr) : rect) {
                        cursor = "move";
                        hover = {kind:"whole"};
                    }
                    if (!rect) {
                        const r = visibleTrackRegions(state.trackId, editFrame())[0];
                        if (r && hitEditableRegion(r, p, cr)) cursor = 'pointer';
                    }
                }
            }
            // The canvas has its own cursor style, so update both the image and its black border.
            canvasWrapper.style.cursor=cursor;
            canvas.style.cursor=cursor;
            canvasWrapper.title=title;
            if (JSON.stringify(state.controlHover) !== JSON.stringify(hover)) {
                state.controlHover = hover;
                drawActiveOverlay();
            }
        };
        canvasWrapper.addEventListener('pointerenter', e => {
            curveHoverPointer={clientX:e.clientX,clientY:e.clientY}; curveAltDown=e.altKey; updateCurveCursor();
            state.curvePreviewPointer = curveHoverPointer;
            if (state.curveDraft) drawActiveOverlay();
        });
        canvasWrapper.addEventListener('pointerleave', () => {
            state.curvePreviewPointer = curveHoverPointer = null;
            updateCurveCursor();
            if (state.curveDraft) drawActiveOverlay();
        });
        window.addEventListener('keydown', e => { if(e.key==='Alt') { if (_panelHover) e.preventDefault(); curveAltDown=true; updateCurveCursor(); } });
        window.addEventListener('keyup', e => { if(e.key==='Alt') { curveAltDown=false; updateCurveCursor(); } });
        window.addEventListener('blur', () => { curveAltDown=false; updateCurveCursor(); });
        const finishCurveDraft = () => {
            const curve = state.curveDraft;
            if (!curve || curve.length < 3) return;
            smoothCurve(curve, true);
            state.curveDraft = state.curveDrag = null;
            saveCurve(curve);
            updateCurveCursor();
            redraw();
        };
        canvasWrapper.addEventListener('pointerdown', (e) => {
            if (e.button === 2 && state.mode === 'manual' && state.curveDraft) {
                e.preventDefault();
                e.stopPropagation();
                suppressPreviewContextMenuUntil = Date.now() + 800;
                stopPlay();
                closeBarMenu();
                finishCurveDraft();
                return;
            }
            if (e.button === 2 && state.image && state.frames.length) {
                e.preventDefault();
                e.stopPropagation();
                const bounds = canvas.getBoundingClientRect();
                if (!bounds.width) return;
                previewScrub = {
                    pointerId: e.pointerId,
                    startX: e.clientX,
                    startY: e.clientY,
                    startFrame: state.frameIdx,
                    width: bounds.width,
                    frameSpan: Math.max(1, parseInt(scrubFramesInput.value, 10) || 10),
                    startSensitivity: Math.max(1, parseInt(scrubFramesInput.value, 10) || 10),
                };
                suppressPreviewContextMenuUntil = Date.now() + 800;
                try { canvasWrapper.setPointerCapture(e.pointerId); } catch (_) {}
                stopPlay();
                return;
            }
            stopPlay();
            if (!state.image) return;
            if (state.mode === 'off') return;   // 关：禁用框选
            if (e.button !== 0) return;
            try { canvasWrapper.setPointerCapture(e.pointerId); } catch (_) {}
            const c = toImg(e);
            if (state.trackingAreaDraft) {
                state.drawing = {start: c, x1: c.x, y1: c.y, x2: c.x, y2: c.y};
                return;
            }
            const frame = editFrame();
            if (!state.curveDraft && state.mode === 'manual') {
                const L=calcLayout(), cr=canvas.getBoundingClientRect();
                const p={x:c.x/L.imgW,y:c.y/L.imgH};
                const selectedVisible = visibleTrackRegions(state.trackId, frame)[0];
                if (selectedVisible && !selectedVisible.poly && !selectedVisible.curve) {
                    const target = rectDragTarget(selectedVisible, p, cr);
                    const region = promoteVisibleRegion(state.trackId);
                    if (region) {
                        state.shapeSelected = true;
                        state.tool = "rect";
                        state.rectDrag = {
                            region,
                            keys: target?.keys || [],
                            cursor: target?.cursor || "move",
                            start: p,
                            grabOffset: target?.keys.length ? null : {x:p.x-region.x1, y:p.y-region.y1},
                            original: {...region},
                        };
                        refreshTrackBtns();
                        refreshToolBtn();
                        updateCurveCursor();
                        redraw();
                        return;
                    }
                }
                const hasCurrentKeyframe = !!state.manualKeyframes[state.trackId]?.[frame]?.length;
                const tids = [state.trackId];
                for (const tid of tids) {
                    if (tid===state.trackId && state.shapeSelected && state.manualKeyframes[tid]?.[frame]?.length) continue;
                    const visible=visibleTrackRegions(tid,frame)[0];
                    if (hasCurrentKeyframe && state.tool === 'brush' &&
                        visible && !visible.curve && !visible.poly) continue;
                    const target = rectDragTarget(visible,p,cr);
                    const selectedCurve = tid === state.trackId && state.shapeSelected ? visible?.curve : null;
                    const controls = selectedCurve?.length ? curveControls(selectedCurve, cr, controlScreenScale()) : null;
                    const handle = controls && ([...controls.anchors, ...controls.handles].some(point =>
                        Math.hypot((point.x-p.x)*cr.width, (point.y-p.y)*cr.height) <
                            CURVE_CONTROL_HIT_RADIUS * controlScreenScale()) || curveBoundsTarget(controls.box,p,cr)?.keys.length);
                    if (!visible || (!target && !handle && !hitEditableRegion(visible,p,cr))) continue;
                    const promoted = !state.manualKeyframes[tid]?.[frame]?.length;
                    const r=promoteVisibleRegion(tid);
                    const curve=r.curve;
                    if (r) {
                        state.trackId=tid; state.shapeSelected=true; state.tool=curve?'brush':'rect';
                        if (!r.poly && !curve) {
                            if (target) state.rectDrag={
                                region:r, keys:target.keys, cursor:target.cursor, start:p,
                                grabOffset: target.keys.length ? null : {x:p.x-r.x1, y:p.y-r.y1},
                                original:{...r},
                            };
                        }
                        if (promoted && !state.rectDrag && !curve) writeData();
                        if (selectedCurve) break;
                        if (curve && canMoveCurve(curve,p,cr)) state.curveDrag={curve,kind:'whole',p};
                        else if (curve && promoted) writeData();
                        refreshTrackBtns(); refreshToolBtn(); updateCurveCursor(); redraw(); return;
                    }
                }
            }
            if (state.mode === "manual" &&
                !state.manualKeyframes[state.trackId]?.[frame]?.length &&
                visibleTrackRegions(state.trackId, frame).length) return;
            const region = state.manualKeyframes[state.trackId]?.[frame]?.[0];
            // An interpolated or tracked curve also occupies this frame, even before it is promoted.
            if (!state.curveDraft && !region) {
                const visible = visibleTrackRegions(state.trackId, frame)[0];
                if (visible?.curve || visible?.poly) return;
            }
            if (state.shapeSelected && state.tool !== 'brush' && !state.curveDraft && region && !region.poly) {
                const cr = canvas.getBoundingClientRect(), L = calcLayout();
                const p = {x:c.x/L.imgW, y:c.y/L.imgH};
                const target = rectDragTarget(region,p,cr);
                if (target) { state.rectDrag = {region, keys:target.keys, cursor:target.cursor, start:p, original:{...region}}; updateCurveCursor(); return; }
            }
            if (state.mode === "manual" && (state.curveDraft || (region?.curve && state.shapeSelected) ||
                (state.tool === "brush" && !region?.poly && !region?.curve))) {
                const L = calcLayout(), p = {x: c.x / L.imgW, y: c.y / L.imgH};
                const cr = canvas.getBoundingClientRect();
                const near = q => Math.hypot((q.x-p.x)*cr.width, (q.y-p.y)*cr.height) < CURVE_CONTROL_HIT_RADIUS * controlScreenScale();
                let curve = state.curveDraft || state.manualKeyframes[state.trackId]?.[frame]?.[0]?.curve;
                if (!e.altKey && state.curveDraft?.length >= 3 && near(curve[0])) {
                    smoothCurve(curve, true); state.curveDraft = null; saveCurve(curve); redraw(); return;
                }
                if (curve) {
                    // Anchors take priority over coincident handles. Alt-drag separates a handle.
                    const controls = curveControls(curve, cr, controlScreenScale(), !state.curveDraft || curve.length >= 3);
                    const target = state.curveDraft ? null : curveBoundsTarget(controls.box,p,cr);
                    for (let i = 0; i < curve.length; i++) {
                        if (target?.keys.length !== 2 && near(controls.anchors[i])) {
                            const kind = e.altKey ? (curve[i].roundness === undefined ? 'out' : 'roundness') : 'anchor';
                            state.curveDrag = {curve, i, kind, p, fresh:e.altKey, cornerClick:e.altKey};
                            return;
                        }
                    }
                    const i = controls.handles.findIndex(near);
                    if (i >= 0 && target?.keys.length !== 2) {
                        state.curveDrag = {curve, i, kind:'roundness', p, handle:controls.handles[i]};
                        return;
                    }
                    if (target?.keys.length) {
                        state.curveDrag = {curve, kind:'bounds', p, box:controls.box, keys:target.keys, cursor:target.cursor};
                        updateCurveCursor();
                        return;
                    }
                }
                if (!state.curveDraft && curve?.length >= 2 && !e.altKey) {
                    const hit = hitCurveSegment(curve,p,cr.width,cr.height,!state.curveDraft);
                    if (hit) {
                        let i = hit.i + 1;
                        if (curve[hit.i].roundness !== undefined) {
                            const point = hit.point;
                            curve.splice(i, 0, {...point, in:{...point}, out:{...point}, roundness:0, auto:false});
                        } else i = splitCurveSegment(curve,hit.i,hit.t);
                        state.curveDrag={curve,i,kind:'anchor',p};
                        if (!state.curveDraft) saveCurve(curve);
                        redraw(); return;
                    }
                }
                if (!state.curveDraft && region?.curve) {
                    if (curve && canMoveCurve(curve,p,cr)) {
                        state.curveDrag={curve,kind:'whole',p}; updateCurveCursor(); return;
                    }
                    return;
                }
                if (!state.curveDraft) { curve = state.curveDraft = []; state.shapeSelected=true; }
                curve.push({...p, in:{...p}, out:{...p}, roundness:.25, auto:false});
                smoothCurve(curve, false);
                state.curveDrag = {curve, i:curve.length-1, kind:'roundness', p, fresh:true};
                redraw(); return;
            }
            if (state.mode === 'manual' && region) return;
            state.shapeSelected=true;
            state.drawing = { start: c, x1: c.x, y1: c.y, x2: c.x, y2: c.y };
        });

        const updateDrawingRect = e => {
            const drawing = state.drawing;
            const {x, y} = toImg(e);
            const {imgW, imgH} = calcLayout();
            const {start} = drawing;
            if (!e.shiftKey) {
                Object.assign(drawing, {x1: start.x, y1: start.y, x2: x, y2: y});
                return;
            }
            const x1 = Math.max(0, Math.min(imgW, start.x));
            const y1 = Math.max(0, Math.min(imgH, start.y));
            const sx = x < x1 ? -1 : 1;
            const sy = y < y1 ? -1 : 1;
            const side = Math.min(Math.max(Math.abs(x - x1), Math.abs(y - y1)),
                sx < 0 ? x1 : imgW - x1, sy < 0 ? y1 : imgH - y1);
            Object.assign(drawing, {x1, y1, x2: x1 + sx * side, y2: y1 + sy * side});
        };

        canvasWrapper.addEventListener('pointermove', (e) => {
            if (previewScrub?.pointerId === e.pointerId) return;
            curveHoverPointer={clientX:e.clientX,clientY:e.clientY}; curveAltDown=e.altKey;
            state.curvePreviewPointer = curveHoverPointer;
            updateCurveCursor();
            if (state.rectDrag) {
                const drag = state.rectDrag;
                const {region, keys, start, original} = drag, c = toImg(e), L = calcLayout();
                const dx = c.x/L.imgW-start.x, dy = c.y/L.imgH-start.y;
                if (!drag.moved) {
                    const cr = canvas.getBoundingClientRect();
                    if (Math.hypot(dx*cr.width, dy*cr.height) < 3) return;
                    drag.moved = true;
                }
                if (!keys.length) {
                    const pointer = {x:c.x/L.imgW, y:c.y/L.imgH};
                    const offset = drag.grabOffset || {x:start.x-original.x1, y:start.y-original.y1};
                    const moveX = Math.max(0, Math.min(1-(original.x2-original.x1), pointer.x-offset.x));
                    const moveY = Math.max(0, Math.min(1-(original.y2-original.y1), pointer.y-offset.y));
                    region.x1=moveX; region.x2=moveX+(original.x2-original.x1);
                    region.y1=moveY; region.y2=moveY+(original.y2-original.y1);
                } else if (e.altKey) {
                    const cx = (original.x1 + original.x2) / 2;
                    const cy = (original.y1 + original.y2) / 2;
                    const xKey = keys.find(key => key[0] === 'x');
                    const yKey = keys.find(key => key[0] === 'y');
                    const maxX = Math.min(cx, 1 - cx) * L.imgW;
                    const maxY = Math.min(cy, 1 - cy) * L.imgH;
                    let halfWidth = xKey ? Math.max(1, (original[xKey] + dx - cx) * L.imgW * (xKey === 'x1' ? -1 : 1))
                        : (original.x2 - original.x1) * L.imgW / 2;
                    let halfHeight = yKey ? Math.max(1, (original[yKey] + dy - cy) * L.imgH * (yKey === 'y1' ? -1 : 1))
                        : (original.y2 - original.y1) * L.imgH / 2;
                    if (e.shiftKey) {
                        const side = xKey && yKey ? Math.max(halfWidth, halfHeight) : xKey ? halfWidth : halfHeight;
                        halfWidth = halfHeight = Math.min(side, maxX, maxY);
                    }
                    const rx = Math.min(halfWidth, maxX) / L.imgW;
                    const ry = Math.min(halfHeight, maxY) / L.imgH;
                    Object.assign(region, {x1: cx - rx, x2: cx + rx, y1: cy - ry, y2: cy + ry});
                } else if (e.shiftKey) {
                    const xKey = keys.find(key => key[0] === 'x');
                    const yKey = keys.find(key => key[0] === 'y');
                    const anchorX = xKey ? original[xKey === 'x1' ? 'x2' : 'x1'] : (original.x1 + original.x2) / 2;
                    const anchorY = yKey ? original[yKey === 'y1' ? 'y2' : 'y1'] : (original.y1 + original.y2) / 2;
                    const width = xKey ? (original[xKey] + dx - anchorX) * L.imgW : 0;
                    const height = yKey ? (original[yKey] + dy - anchorY) * L.imgH : 0;
                    const sx = Math.sign(width) || (xKey === 'x1' ? -1 : 1);
                    const sy = Math.sign(height) || (yKey === 'y1' ? -1 : 1);
                    const maxWidth = xKey ? (sx < 0 ? anchorX : 1 - anchorX) : 2 * Math.min(anchorX, 1 - anchorX);
                    const maxHeight = yKey ? (sy < 0 ? anchorY : 1 - anchorY) : 2 * Math.min(anchorY, 1 - anchorY);
                    const side = Math.min(Math.max(Math.abs(width), Math.abs(height)), maxWidth * L.imgW, maxHeight * L.imgH);
                    Object.assign(region, original);
                    if (xKey) region[xKey] = anchorX + sx * side / L.imgW;
                    else { region.x1 = anchorX - side / (2 * L.imgW); region.x2 = anchorX + side / (2 * L.imgW); }
                    if (yKey) region[yKey] = anchorY + sy * side / L.imgH;
                    else { region.y1 = anchorY - side / (2 * L.imgH); region.y2 = anchorY + side / (2 * L.imgH); }
                } else {
                    Object.assign(region, original);
                    for (const key of keys) {
                        region[key] = Math.max(0, Math.min(1, original[key] + (key[0]==='x' ? dx : dy)));
                    }
                }
                redraw(); return;
            }
            if (state.curveDrag) {
                const d = state.curveDrag, a = d.curve[d.i], c = toImg(e), L = calcLayout();
                if (!state.curveDraft) d.original ||= JSON.parse(JSON.stringify(d.curve));
                const p = {x:c.x/L.imgW, y:c.y/L.imgH};
                if (d.fresh) {
                    const cr = canvas.getBoundingClientRect();
                    if (Math.hypot((p.x-d.p.x)*cr.width,(p.y-d.p.y)*cr.height) < 3) return;
                    d.fresh = false; d.cornerClick = false;
                }
                if (d.kind === 'bounds') {
                    for (const key of d.keys) {
                        const axis = key[0];
                        const pivot = d.box[axis + (key[1] === '1' ? '2' : '1')];
                        const ratio = Math.max(.01, 1 + (p[axis]-d.p[axis]) / (d.box[key]-pivot));
                        d.curve.forEach((node, i) => {
                            const base = d.original[i];
                            node[axis] = pivot + (base[axis]-pivot)*ratio;
                            for (const side of ['in','out']) node[side][axis] = pivot + (base[side][axis]-pivot)*ratio;
                            node.auto = false;
                        });
                    }
                } else if (d.kind === 'roundness') {
                    const cr = canvas.getBoundingClientRect(), scale = controlScreenScale();
                    const handle = d.handle || curveControls(d.curve, cr, scale, !state.curveDraft || d.curve.length >= 3).handles[d.i];
                    const initial = d.initialPointer ||= d.p;
                    const delta = (p.x-initial.x)*cr.width*handle.ux + (p.y-initial.y)*cr.height*handle.uy;
                    if (a.roundness !== undefined) {
                        d.handle = handle;
                        d.initialRoundness ??= a.roundness;
                        a.roundness = Math.max(0, Math.min(.5, d.initialRoundness + delta/(52*scale)));
                    } else {
                    const base = d.original?.[d.i] || a;
                    const originalTangent = d.tangent ??= (Math.hypot((base.in.x-base.x)*cr.width,(base.in.y-base.y)*cr.height) +
                        Math.hypot((base.out.x-base.x)*cr.width,(base.out.y-base.y)*cr.height)) / 2;
                    d.handle = handle;
                    a.auto = true;
                    smoothCurve(d.curve, !state.curveDraft);
                    const tangent = (Math.hypot((a.in.x-a.x)*cr.width,(a.in.y-a.y)*cr.height) +
                        Math.hypot((a.out.x-a.x)*cr.width,(a.out.y-a.y)*cr.height)) / 2;
                    const roundness = Math.max(0, Math.min(2, (originalTangent + delta)/Math.max(1, tangent)));
                    for (const side of ['in','out']) {
                        a[side].x = a.x + (a[side].x-a.x)*roundness;
                        a[side].y = a.y + (a[side].y-a.y)*roundness;
                    }
                    a.auto = false;
                    }
                } else if (d.kind === 'whole') {
                    const dx=p.x-d.p.x, dy=p.y-d.p.y;
                    for (const anchor of d.curve) {
                        for (const q of [anchor,anchor.in,anchor.out]) { q.x+=dx; q.y+=dy; }
                    }
                } else if (d.kind === 'anchor') {
                    const dx = p.x-d.p.x, dy = p.y-d.p.y;
                    for (const q of [a, a.in, a.out]) { q.x += dx; q.y += dy; }
                    smoothCurve(d.curve, !state.curveDraft);
                } else {
                    a.auto = false;
                    a[d.kind] = {...p};
                    if (!e.altKey) a[d.kind === 'in' ? 'out' : 'in'] = {x:2*a.x-p.x, y:2*a.y-p.y};
                }
                if (d.kind !== 'bounds') d.p = p;
                if (!state.curveDraft) {
                    const r = state.manualKeyframes[state.trackId]?.[editFrame()]?.[0];
                    if (r?.curve === d.curve) r.poly = curvePoly(d.curve);
                }
                redraw(); return;
            }
            if (!state.drawing) {
                if (state.curveDraft) drawActiveOverlay();
                return;
            }
            updateDrawingRect(e);
            // 方框实时预览走 overlay（黑边内可见、逐事件刷新跟手）
            drawActiveOverlay();
        });

        canvasWrapper.addEventListener('pointerup', (e) => {
            if (previewScrub?.pointerId === e.pointerId) {
                previewScrub = null;
                return;
            }
            if (state.rectDrag) { finishRectDrag(); redraw(); return; }
            if (state.curveDrag) {
                const d = state.curveDrag, curve = d.curve;
                if (d.cornerClick) {
                    toggleCurveCorner(curve,d.i,!state.curveDraft);
                }
                state.curveDrag = null;
                if (!state.curveDraft) saveCurve(curve, d.original);
                updateCurveCursor(); redraw(); return;
            }
            if (!state.drawing) return;
            updateDrawingRect(e);
            const L = calcLayout();
            const r = {
                x1: Math.max(0, Math.min(1, Math.min(state.drawing.x1, state.drawing.x2) / L.imgW)),
                y1: Math.max(0, Math.min(1, Math.min(state.drawing.y1, state.drawing.y2) / L.imgH)),
                x2: Math.max(0, Math.min(1, Math.max(state.drawing.x1, state.drawing.x2) / L.imgW)),
                y2: Math.max(0, Math.min(1, Math.max(state.drawing.y1, state.drawing.y2) / L.imgH)),
            };
            state.drawing = null;
            clearBrushOverlay();
            if (state.trackingAreaDraft) {
                const {track, frame} = state.trackingAreaDraft;
                state.trackingAreaDraft = null;
                if (r.x2 > r.x1 && r.y2 > r.y1) {
                    state.trackingAreas ||= {};
                    (state.trackingAreas[track] ||= {})[frame] = r;
                    writeData();
                }
                redraw();
                return;
            }
            if (!(r.x2 - r.x1 > 0.002 && r.y2 - r.y1 > 0.002)) return;   // 极小框忽略
            if (state.mode === "manual") {
                const tid = state.trackId;
                if (!state.manualKeyframes[tid]) state.manualKeyframes[tid] = {};
                state.manualKeyframes[tid][state.frameIdx] = [r];
            } else {
                state.detectRegions.push(r);
            }
            writeData();
            redraw();
            refreshTrackBtns();
        });

        const finishRectDrag = () => {
            if (!state.rectDrag) return;
            const {region: r, original} = state.rectDrag;
            if (r.x1 === r.x2) { r.x1 = original.x1; r.x2 = original.x2; }
            if (r.y1 === r.y2) { r.y1 = original.y1; r.y2 = original.y2; }
            [r.x1, r.x2] = [Math.min(r.x1,r.x2), Math.max(r.x1,r.x2)];
            [r.y1, r.y2] = [Math.min(r.y1,r.y2), Math.max(r.y1,r.y2)];
            const edges = ["x1", "y1", "x2", "y2"];
            const changed = edges.some(edge => r[edge] !== original[edge]);
            if (changed) delete r.tracking_origin;
            const auto = state.autoTracking;
            const track = state.trackId;
            const frames = auto?.video_id === state.srcKey ? auto?.tracks?.[track] : null;
            if (changed && frames && lockedEditFrame() === null) {
                const start = state.frameIdx;
                const keys = state.manualKeyframes[track];
                const transitionFrames = 12;
                for (const direction of [-1, 1]) {
                    const pending = [];
                    let anchor = null;
                    let distance = 0;
                    for (let frame = start + direction; frame >= 0 && frame < state.frames.length; frame += direction) {
                        distance++;
                        const manual = keys[frame]?.[0];
                        const tracked = frames[state.sampleIdx?.[frame] ?? frame];
                        const target = manual || tracked;
                        if (!target || !edges.every(edge => Number.isFinite(target[edge]))) break;
                        if (manual || (distance >= transitionFrames && tracked.tracking_reliable !== false)) {
                            anchor = target;
                            break;
                        }
                        pending.push(tracked);
                    }
                    const span = anchor ? distance : Math.max(transitionFrames, pending.length + 1);
                    const corrected = pending.map((tracked, index) => {
                        const t = (index + 1) / span;
                        const result = {};
                        for (const edge of edges) {
                            const base = tracked.tracking_reliable === false
                                ? original[edge] + ((anchor?.[edge] ?? original[edge]) - original[edge]) * t
                                : tracked[edge];
                            result[edge] = base + (r[edge] - original[edge]) * (1 - t);
                        }
                        return result;
                    });
                    for (let i = 0; i < pending.length; i++) {
                        const tracked = pending[i];
                        const next = corrected[i];
                        if (tracked.poly?.length === 4) {
                            tracked.poly = tracked.poly.map(([x, y], corner) => {
                                const horizontal = corner === 0 || corner === 3 ? "x1" : "x2";
                                const vertical = corner < 2 ? "y1" : "y2";
                                return [x + next[horizontal] - tracked[horizontal],
                                    y + next[vertical] - tracked[vertical]];
                            });
                        }
                        Object.assign(tracked, next, {manual_transition: true});
                    }
                }
            }
            state.rectDrag = null; writeData(); refreshTrackBtns(); updateCurveCursor();
        };
        canvasWrapper.addEventListener('pointercancel', () => {
            previewScrub = null;
            finishRectDrag();
            if (state.curveDrag && !state.curveDraft) saveCurve(state.curveDrag.curve, state.curveDrag.original);
            state.trackingAreaDraft = null;
            state.curveDrag = null; state.drawing = null; redraw();
        });
        const handleCurveRightClick = (e) => {
            closeBarMenu();
            if (!state.image || state.mode !== 'manual') return;
            if (state.curveDraft) {
                finishCurveDraft();
                return;
            }
            stopPlay();
            const frame = editFrame();
            const L = calcLayout(), c = toImg(e);
            const p = {x:c.x/L.imgW, y:c.y/L.imgH};
            const cr = canvas.getBoundingClientRect();
            const curve = state.shapeSelected && state.manualKeyframes[state.trackId]?.[frame]?.[0]?.curve;
            if (curve) {
                const distance = q => Math.hypot((q.x-p.x)*cr.width, (q.y-p.y)*cr.height);
                const {anchors, handles} = curveControls(curve, cr, controlScreenScale(), true);
                let closest = CURVE_CONTROL_HIT_RADIUS * controlScreenScale();
                let index = -1;
                for (let i = 0; i < curve.length; i++) {
                    const d = Math.min(distance(anchors[i]), distance(handles[i]));
                    if (d >= closest) continue;
                    closest = d;
                    index = i;
                }
                if (index !== -1 && curve.length > 3) {
                    curve.splice(index, 1);
                    smoothCurve(curve, true);
                    saveCurve(curve);
                    updateCurveCursor();
                    redraw();
                    return;
                }
                if (index !== -1 || insideCurve(curve, p) ||
                    hitCurveSegment(curve, p, cr.width, cr.height, true)) {
                    const track = state.trackId;
                    const keys = state.manualKeyframes[track];
                    showBarMenu(e.clientX, e.clientY, [{
                        label: `删除第 ${frame} 帧曲线`,
                        fn: () => {
                            if (keys[frame]?.[0]?.curve !== curve) return;
                            if (isLockedKeyframe(track, frame)) state.lockedKeyframe = null;
                            delete keys[frame];
                            const tracked = activeAutoTracks()[track];
                            if (tracked) delete tracked[state.sampleIdx[frame] ?? frame];
                            writeData();
                            refreshTrackBtns();
                            redraw();
                        },
                    }]);
                    return;
                }
            }
        };
        canvasWrapper.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            handleCurveRightClick(e);
        });

        // 滚轮事件转发给 ComfyUI 画布（预览区不拦截滚轮，保持画布缩放）
        const forwardWheel = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if ((workspace || e.ctrlKey) && canvasWrapper.contains(e.target)) {
                if (!state.image || !e.deltaY) return;
                const zoom = Math.max(0.1, Math.min(8, view.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
                const bounds = canvas.getBoundingClientRect();
                const scale = previewScreenScale();
                const ratio = zoom / view.zoom;
                view.x += (e.clientX - bounds.left - bounds.width / 2) * (1 - ratio) / scale;
                view.y += (e.clientY - bounds.top - bounds.height / 2) * (1 - ratio) / scale;
                view.zoom = zoom;
                applyPreviewView();
                return;
            }
            if (workspace) return;
            const cvs = app.canvas?.canvas;
            if (cvs) {
                const ev = new WheelEvent('wheel', {
                    deltaX: e.deltaX, deltaY: e.deltaY,
                    deltaMode: e.deltaMode,
                    clientX: e.clientX, clientY: e.clientY,
                    bubbles: true, cancelable: true
                });
                cvs.dispatchEvent(ev);
            }
        };
        container.addEventListener('wheel', forwardWheel, { passive: false });

        const view = {zoom: 1, x: 0, y: 0};
        let viewDrag = null;
        const previewScreenScale = () => canvasWrapper.getBoundingClientRect().width / canvasWrapper.offsetWidth || 1;
        const applyPreviewView = () => {
            canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
            drawActiveOverlay();
        };
        const resetPreviewView = () => {
            Object.assign(view, {zoom: 1, x: 0, y: 0});
            applyPreviewView();
        };
        canvasWrapper.addEventListener("pointerdown", e => {
            const pan = (e.ctrlKey && e.button === 0) || e.button === 1;
            if (!state.image || !pan || viewDrag ||
                state.drawing || state.rectDrag || state.curveDrag) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            stopPlay();
            canvasWrapper.setPointerCapture(e.pointerId);
            viewDrag = {id: e.pointerId, x: e.clientX, y: e.clientY, left: view.x, top: view.y};
            canvas.style.cursor = canvasWrapper.style.cursor = "move";
        }, true);
        canvasWrapper.addEventListener("pointermove", e => {
            if (viewDrag?.id !== e.pointerId) return;
            e.stopImmediatePropagation();
            const scale = previewScreenScale();
            view.x = viewDrag.left + (e.clientX - viewDrag.x) / scale;
            view.y = viewDrag.top + (e.clientY - viewDrag.y) / scale;
            applyPreviewView();
        }, true);
        const endViewDrag = e => {
            if (viewDrag?.id !== e.pointerId) return;
            e.stopImmediatePropagation();
            viewDrag = null;
            canvas.style.cursor = canvasWrapper.style.cursor = "crosshair";
        };
        for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) {
            canvasWrapper.addEventListener(event, endViewDrag, true);
        }

        const openWorkspace = () => {
            const parent = container.parentElement;
            if (!parent) return;
            closeBarMenu();
            const anchor = document.createComment("xzg-video-mask-workspace");
            parent.insertBefore(anchor, container);
            const overlay = document.createElement("div");
            overlay.style.cssText = "position:fixed;inset:0;z-index:1000000;display:flex;box-sizing:border-box;padding:14px;background:#0f1011;";
            overlay.addEventListener("pointerdown", e => e.stopPropagation());
            workspace = {anchor, overlay, style: container.style.cssText};
            overlay.appendChild(container);
            Object.assign(container.style, {height: "100%", flex: "1 1 auto", pointerEvents: "auto"});
            document.body.appendChild(overlay);
            fullscreenBtn.textContent = fullscreenBtn.title = "退出全屏";
            syncSize();
            redraw();
        };
        const closeWorkspace = () => {
            if (!workspace) return;
            const {anchor, overlay, style} = workspace;
            workspace = null;
            closeBarMenu();
            stopPlay();
            _panelHover = false;
            if (anchor.isConnected) anchor.replaceWith(container);
            container.style.cssText = style;
            overlay.remove();
            fullscreenBtn.textContent = "全屏编辑";
            fullscreenBtn.title = "打开全屏编辑";
            if (container.isConnected) {
                resetPreviewView();
                syncSize();
                redraw();
            }
        };
        const onWorkspaceEscape = e => {
            if (!workspace || e.key !== "Escape" || document.querySelector(".xzg-wmdet-help-ok")) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            if (_barMenuEl) closeBarMenu();
            else if (state.curveDraft || state.curveDrag || state.rectDrag) cancelCurve();
            else closeWorkspace();
        };
        window.addEventListener("keydown", onWorkspaceEscape, true);
        chainCallback(node, "onRemoved", () => {
            closeWorkspace();
            window.removeEventListener("keydown", onWorkspaceEscape, true);
        });

        // ---- 数据回写（{detect:[...], exclude:[...]}）----
        const undoHistory = [], redoHistory = [];
        const refreshEditHistory = () => {
            for (const [button, entries] of [[undoBtn, undoHistory], [redoBtn, redoHistory]]) {
                button.setAttribute("aria-disabled", String(!entries.length));
                button.style.opacity = entries.length ? "1" : ".4";
            }
        };
        const resetEditHistory = () => {
            undoHistory.length = redoHistory.length = 0;
            refreshEditHistory();
        };
        const canUseMaskHistory = () => !trackingRequest && !state.curveDraft &&
            !state.curveDrag && !state.rectDrag && !state.drawing && !state.trackingAreaDraft && !_kfDrag;
        const maskHistoryUrl = "/xzg/manual-mask/history/shared";
        const requestMaskHistory = async (url, options) => {
            const response = await api.fetchApi(url, options);
            if (!response.ok) {
                const {error} = await response.json().catch(() => ({}));
                if (response.status === 400 && error === "无效的遮罩历史标识") {
                    throw new Error("当前 ComfyUI 后端尚未加载共享遮罩历史，请重启 ComfyUI 后端并刷新页面");
                }
                throw new Error(error || `遮罩历史读写失败（HTTP ${response.status}）`);
            }
            return response.json();
        };
        const storeMaskHistory = async entry => {
            const legacy = node.properties?.maskHistory;
            const versions = Array.isArray(legacy) ? legacy.slice(0, 10) : [];
            if (entry) versions.push(entry);
            if (!versions.length) return;
            await requestMaskHistory(maskHistoryUrl, {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify(versions),
            });
            if (node.properties.maskHistory === legacy && legacy) {
                delete node.properties.maskHistory;
                node.setDirtyCanvas?.(true, true);
            }
        };
        const saveMaskVersion = async data => {
            try {
                const videoId = JSON.parse(data)?.video_id;
                if (videoId) await storeMaskHistory({videoId, savedAt: Date.now(), data});
                else await storeMaskHistory();
            } catch (error) {
                trackingNotice(error.message, "warn");
            }
        };
        maskHistoryRecorders.set(node, saveMaskVersion);
        const openMaskHistory = async () => {
            if (!state.srcKey || !canUseMaskHistory()) {
                trackingNotice("请先加载视频并结束当前编辑或跟踪");
                return;
            }
            const videoId = state.srcKey;
            try {
                await storeMaskHistory();
                const url = `${maskHistoryUrl}?video=${encodeURIComponent(videoId)}`;
                const versions = await requestMaskHistory(url);
                if (state.srcKey !== videoId || !canUseMaskHistory()) return;
                if (!versions.length) {
                    trackingNotice("当前视频暂无历史版本。完成自动跟踪或运行工作流后会自动记录。");
                    return;
                }
                const items = versions.map(version => ({
                    label: `恢复 ${new Date(version.savedAt).toLocaleString(undefined, {hour12:false})}`,
                    fn: async () => {
                        const previous = dataWidget.value;
                        try {
                            const {data} = await requestMaskHistory(`${url}&version=${encodeURIComponent(version.id)}`);
                            if (state.srcKey !== videoId || !canUseMaskHistory() ||
                                dataWidget.value !== previous || previous === data) return;
                            undoHistory.push(previous || "{}");
                            if (undoHistory.length > 30) undoHistory.shift();
                            redoHistory.length = 0;
                            dataWidget.value = data;
                            trackUnlocked = new Set([1, state.trackId]);
                            readData();
                            refreshTrackBtns();
                            refreshEditHistory();
                            redraw();
                            node.setDirtyCanvas?.(true, true);
                        } catch (error) {
                            trackingNotice(error.message, "warn");
                        }
                    },
                }));
                const bounds = historyBtn.getBoundingClientRect();
                showBarMenu(bounds.left, bounds.bottom + 4, items);
            } catch (error) {
                trackingNotice(error.message, "warn");
            }
        };
        const stepEditHistory = direction => {
            if (trackingRequest || state.curveDrag || state.rectDrag || state.drawing) return;
            const [from, to] = direction < 0 ? [undoHistory, redoHistory] : [redoHistory, undoHistory];
            if (!from.length) return;
            to.push(dataWidget.value);
            dataWidget.value = from.pop();
            state.curveDraft = state.trackingAreaDraft = null;
            trackUnlocked = new Set([1, state.trackId]);
            readData();
            refreshTrackBtns();
            refreshEditHistory();
            redraw();
            node.setDirtyCanvas?.(true, true);
        };
        const writeData = (record = true) => {
            if (!dataWidget) return;
            const data = { detect: state.detectRegions, exclude: state.excludeRegions, mode: state.mode, tool: state.tool, manual: state.manualKeyframes, fill_edges: state.fillEdges, sample_idx: state.sampleIdx || [] };
            if (state.srcKey) data.video_id = state.srcKey;
            if (state.trackingAreas) data.tracking_areas = state.trackingAreas;
            if (Object.keys(state.autoTracking.tracks).length) {
                data.auto_tracking = state.autoTracking;
            }
            const value = JSON.stringify(data);
            if (record && value !== dataWidget.value) {
                undoHistory.push(dataWidget.value || "{}");
                if (undoHistory.length > 30) undoHistory.shift();
                redoHistory.length = 0;
                refreshEditHistory();
            }
            dataWidget.value = value;
            // 不调 callback，避免画框时自动触发节点执行
            try { node.setDirtyCanvas(true, true); } catch (e) {}
        };

        // 恢复工作流已保存的区域（可反复调用：节点创建 / 执行 / 延迟兜底都会重新同步，
        // 保证前端视窗能看到与后端一致的检测/排除框，消除"刷新/重启后框不见了但仍生效"的不一致）
        const readData = () => {
            try {
                if (!dataWidget || !dataWidget.value) return;
                const d = JSON.parse(dataWidget.value);
                if (!d) return;
                state.detectRegions = Array.isArray(d.detect) ? d.detect.filter(v => v && typeof v.x1 === 'number') : [];
                state.excludeRegions = Array.isArray(d.exclude) ? d.exclude.filter(v => v && typeof v.x1 === 'number') : [];
                // 仅手工跟踪模式（旧版模式下拉已隐藏取消）
                state.mode = 'manual';
                state.tool = d.tool === "brush" ? "brush" : "rect";
                refreshToolBtn();
                state.fillEdges = d.fill_edges !== false;
                refreshFillEdgesBtn();
                state.lockedKeyframe = null;
                state.manualKeyframes = (d.manual && typeof d.manual === 'object') ? d.manual : {};
                state.autoTracking = d.auto_tracking?.tracks && typeof d.auto_tracking.tracks === 'object'
                    ? d.auto_tracking : {tracks: {}};
                state.trackingAreas = d.tracking_areas || {};
                if (state.image) { try { syncSize(); } catch (e) {} redraw(); }
            } catch (e) {}
        };
        readData();
        refreshEditHistory();
        refreshFillEdgesBtn();

        // ---- 开关：控制框选可用性 ----
        const applySwitch = () => {
            stopPlay();
            const m = state.mode;
            const active = m !== "off";
            overlay.style.display = active ? "none" : "";
            hint.innerText = (m === "filter") ? "左键框选 (检测区)"
                           : (m === "manual") ? "框选 / 曲线打点；点击首点闭合，Esc 取消" : "未启用";
            runBtn.className = "xzg-wmdet-run-gold";
            updateRunBtn();
            if (!active) { if (state.detectRegions.length) { state.detectRegions = []; writeData(); } }
            syncSize();
            refreshTrackBtns();
            redraw();
        };
        // 初始化：固定手工跟踪模式（无模式下拉）
        state.mode = "manual";
        applySwitch();
        updateRunBtn();  // 初始化执行按钮颜色

        // ---- 绕过/静音状态跟随（与其他节点观感一致，且与画布着色零时差）----
        // 画布对 bypass(mode=4) 节点整体按 alpha=0.2 绘制（静音 mode=2 为 0.4，
        // 底色 NODE_BYPASS_BGCOLOR=#FF00FF），但 DOM 预览浮在 canvas 之上不受影响。
        // 这里按同样的透明度衰减整个预览区，让画布上节点自身的品红底色透出来。
        // 同步时机：挂在 node.onDrawForeground（节点每帧被绘制时触发）——画布着色
        // 与预览衰减同帧生效，无时差；带变更守卫避免每帧样式写入。
        let _lastTint = null;
        const applyModeTint = () => {
            const m = node.mode;
            const v = (m === 4) ? "0.2" : (m === 2) ? "0.4" : "";
            if (v !== _lastTint) { _lastTint = v; container.style.opacity = v; }
        };
        applyModeTint();
        chainCallback(node, "onDrawForeground", applyModeTint);
        const _tintTimer = setInterval(applyModeTint, 1000);  // 兜底：节点未被绘制时（如滚出视口）也能收敛
        chainCallback(node, "onRemoved", () => clearInterval(_tintTimer));

        // 旧工作流迁移：按标注 JSON 字符串的位置恢复 regions_data，
        // 避免过往控件顺序变化覆盖手工标注。
        chainCallback(node, "onConfigure", function () {
            try {
                const vals = this.widgets_values;
                if (!Array.isArray(vals)) return;
                // regions_data 是唯一的 JSON 字符串，以其位置判定格式
                let ri = vals.findIndex(v => typeof v === 'string' && v.length > 2 && v.indexOf('"manual"') >= 0);
                if (ri < 0) {
                    // 空标注兜底：按长度特征定位
                    if (typeof vals[1] === 'string') ri = 1;
                    else if (vals.length === 8 || vals.length === 9) ri = 7;
                    else if (vals.length === 5 || vals.length === 6) ri = 4;
                    else if (vals.length === 3 || vals.length === 4) ri = 2;
                }
                if (ri < 0) return;
                const byName = {};
                (this.widgets || []).forEach(w => { if (w && w.name) byName[w.name] = w; });
                const setW = (name, v) => {
                    if (byName[name] && v !== undefined) try { byName[name].value = v; } catch (e) {}
                };
                setW('model_name', '手工跟踪');          // 模式下拉已取消，占位值固定
                setW('regions_data', typeof vals[ri] === 'string' ? vals[ri] : '');
                resetEditHistory();
                try { readData(); } catch (e) {}   // 重映射后同步视窗标注
            } catch (e) {}
        });

        // ---- 接收预览帧（后端 execute 发来的视频采样帧）----
        let loadedPreview = "";
        let previewGeneration = 0;
        const failedPreviewFrames = new Set();
        const loadPreviewFrame = (file, index, generation) => {
            failedPreviewFrames.delete(index);
            const img = new Image();
            img.onload = () => {
                if (generation !== previewGeneration) return;
                state.frames[index] = img;
                if (index === state.frameIdx) {
                    state.image = img;
                    syncSize();
                    redraw();
                }
            };
            img.onerror = () => {
                if (generation === previewGeneration) failedPreviewFrames.add(index);
            };
            img.src = getRealURL(file);
        };
        for (const surface of [tracker, canvasWrapper]) surface.classList.add("xzg-wmdet-dim");
        for (const controls of [colorTracks, right]) controls.classList.add("xzg-wmdet-dim-controls");
        trackingGroup.classList.add("xzg-wmdet-tracking-group");
        const trackingProgress = document.createElement("progress");
        trackingProgress.setAttribute("aria-label", "遮罩跟踪进度");
        trackingProgress.style.cssText = "position:absolute;inset:0 0 auto;width:100%;height:8px;z-index:32;accent-color:#30d158;pointer-events:none;";
        trackingProgress.hidden = true;
        canvasWrapper.appendChild(trackingProgress);
        let previewFirstFrame = null;
        const activeAutoTracks = () => state.autoTracking.video_id === state.srcKey ? state.autoTracking.tracks : {};
        const trackingNotice = (message, type = "info") => {
            app.extensionManager?.toast?.add({
                summary: "遮罩自动跟踪", detail: message, severity: type, life: 5000,
            });
        };
        const runMaskTracking = async direction => {
            const {trackId, frameIdx: start, srcKey: videoId} = state;
            const keys = state.manualKeyframes[trackId] || {};
            const source = visibleTrackRegions(trackId, start)[0];
            if (!previewFirstFrame || state.frames.length < 2) {
                trackingNotice("请先加载至少两帧视频", "warn");
                return;
            }
            if (!source) {
                trackingNotice("请在当前轨道画好遮罩，再从这一帧开始跟踪", "warn");
                return;
            }
            const spans = (direction ? [direction] : [-1, 1]).map(step => {
                let end = start + step;
                while (end >= 0 && end < state.frames.length && !keys[end]?.length) end += step;
                const anchored = end >= 0 && end < state.frames.length;
                return {step, end: anchored ? end : end - step};
            }).filter(span => span.end !== start);
            if (!spans.length) {
                trackingNotice("该方向没有可跟踪的帧");
                return;
            }
            const area = state.trackingAreas?.[trackId]?.[start];
            const corners = ({x1, y1, x2, y2}) => [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
            const outline = source.poly || corners(source);
            const polygon = area ? corners(area) : outline;
            const generation = previewGeneration;
            const snapshot = dataWidget.value;
            const controller = new AbortController();
            trackingRequest = controller;
            const buttonIndex = trackDirections.findIndex(([step]) => step === direction);
            const button = autoTrackBtns[buttonIndex];
            const total = spans.reduce((sum, span) => sum + Math.abs(span.end - start), 0);
            const updateProgress = processed => {
                trackingProgress.value = Math.max(trackingProgress.value, processed);
                button.textContent = `${Math.floor(100 * trackingProgress.value / total)}%`;
                button.setAttribute("aria-label", `遮罩跟踪进度 ${button.textContent}`);
            };
            const blockInteraction = e => {
                e.preventDefault();
                e.stopImmediatePropagation();
            };
            const blockedEvents = ["pointerdown", "pointermove", "pointerup", "mousedown", "mousemove",
                "mouseup", "click", "dblclick", "auxclick", "contextmenu", "wheel", "touchstart", "touchmove", "keyup"];
            let completed = 0;
            let progressTimer;
            try {
                for (const event of blockedEvents) {
                    window.addEventListener(event, blockInteraction, {capture: true, passive: false});
                }
                trackingProgress.max = total;
                trackingProgress.value = 0;
                updateProgress(0);
                trackingProgress.hidden = false;
                container.classList.add("xzg-wmdet-tracking");
                button.classList.add("xzg-wmdet-tracking-active");
                button.setAttribute("aria-disabled", "true");
                closeBarMenu();
                stopTimelineDrag();
                stopPlay();
                const results = [];
                for (const {step, end} of spans) {
                    const offset = completed;
                    const job = Array.from(crypto.getRandomValues(new Uint8Array(16)),
                        byte => byte.toString(16).padStart(2, "0")).join("");
                    const poll = async () => {
                        try {
                            const response = await api.fetchApi(`/xzg/manual-mask/progress/${job}`,
                                {signal: controller.signal, cache: "no-store"});
                            if (response.ok) {
                                const {processed} = await response.json();
                                if (trackingRequest === controller && !controller.signal.aborted) {
                                    updateProgress(offset + processed);
                                }
                            }
                        } catch {}
                    };
                    progressTimer = setInterval(poll, 250);
                    const response = await api.fetchApi("/xzg/manual-mask/track", {
                        method: "POST",
                        headers: {"Content-Type": "application/json"},
                        body: JSON.stringify({video_id: videoId, first_frame: previewFirstFrame, start, end, polygon, job}),
                        signal: controller.signal,
                    });
                    if (response.status === 404) throw new Error("请重启 ComfyUI 后端并重新加载视频");
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.error || "跟踪请求失败");
                    clearInterval(progressTimer);
                    completed += result.transforms.length;
                    updateProgress(completed);
                    results.push({step, end, result});
                    if (controller.signal.aborted || generation !== previewGeneration) return;
                }
                if (snapshot !== dataWidget.value) {
                    trackingNotice("遮罩已编辑，请从当前标注重新跟踪");
                    return;
                }
                const tracks = activeAutoTracks();
                keys[start] ||= [JSON.parse(JSON.stringify(source))];
                if (start === 0) keys[start][0].tracking_origin = true;
                state.manualKeyframes[trackId] = keys;
                const frames = tracks[trackId] ||= {};
                for (const {step, end, result} of results) {
                    const transforms = result.transforms;
                    for (let frame = start + step; frame !== end + step; frame += step) {
                        delete frames[state.sampleIdx[frame] ?? frame];
                    }
                    const projectRegion = matrix => {
                        const evaluate = ([a, b, c], x, y) => a*x + b*y + c;
                        const weight = (x, y) => matrix[2] ? evaluate(matrix[2], x, y) : 1;
                        const weights = outline.map(point => weight(...point));
                        const minimum = Math.max(...weights) * .15;
                        if (weights.some(w => !Number.isFinite(w) || w <= 0 || w < minimum)) return null;
                        const map = (x, y) => [evaluate(matrix[0], x, y) / weight(x, y),
                            evaluate(matrix[1], x, y) / weight(x, y)];
                        const region = {poly: outline.map(point => map(...point))};
                        if (region.poly.some(point => point.some(v => !Number.isFinite(v)))) return null;
                        if (!source.poly) {
                            const [cx, cy] = map((source.x1 + source.x2) / 2, (source.y1 + source.y2) / 2);
                            const scale = Math.sqrt(Math.abs(polySignedArea(region.poly)) /
                                Math.abs(polySignedArea(outline)));
                            if (!Number.isFinite(scale) || scale <= 0) return null;
                            const halfWidth = (source.x2 - source.x1) * scale / 2;
                            const halfHeight = (source.y2 - source.y1) * scale / 2;
                            return {x1: cx - halfWidth, y1: cy - halfHeight,
                                x2: cx + halfWidth, y2: cy + halfHeight};
                        }
                        if (source.curve?.every(q => [q, q.in, q.out].every(({x, y}) => {
                            const w = weight(x, y);
                            return w > 0 && w >= minimum && map(x, y).every(Number.isFinite);
                        }))) {
                            const point = ({x, y}) => {
                                const [u, v] = map(x, y);
                                return {x: u, y: v};
                            };
                            region.curve = source.curve.map(q => ({
                                ...q, ...point(q), in: point(q.in), out: point(q.out), auto: false,
                            }));
                        }
                        return region;
                    };
                    const anchor = transforms.length === Math.abs(end - start) && result.reliable?.at(-1) !== false
                        ? keys[end]?.[0] : null;
                    const projectedEnd = anchor ? projectRegion(transforms.at(-1)) : null;
                    const targetPoly = anchor && (anchor.poly || corners(anchor));
                    const endPoly = projectedEnd?.poly;
                    const aligned = endPoly && targetPoly.length === endPoly.length ? alignPoly(targetPoly, endPoly) : null;
                    const endCurve = projectedEnd?.curve;
                    const targetCurve = anchor?.curve;
                    const matchingCurves = endCurve && targetCurve?.length === endCurve.length;
                    const edges = ["x1", "y1", "x2", "y2"];
                    let lastRectangle = source;
                    transforms.forEach((matrix, index) => {
                        const frame = start + step * (index + 1);
                        if (keys[frame]?.length) return;
                        const region = result.reliable?.[index] === false ? null : projectRegion(matrix);
                        const frameKey = state.sampleIdx[frame] ?? frame;
                        if (!region) {
                            if (!source.poly) frames[frameKey] = {...lastRectangle, tracking_reliable: false};
                            return;
                        }
                        if (projectedEnd) {
                            const t = (index + 1) / transforms.length;
                            if (!region.poly) {
                                if (!anchor.poly) {
                                    for (const edge of edges) region[edge] += (anchor[edge] - projectedEnd[edge]) * t;
                                }
                            } else if (matchingCurves && region.curve) {
                                const shift = (point, from, to) => ({
                                    x: point.x + (to.x - from.x) * t,
                                    y: point.y + (to.y - from.y) * t,
                                });
                                region.curve = region.curve.map((node, i) => {
                                    const from = endCurve[i], to = targetCurve[i];
                                    const corrected = {...node, ...shift(node, from, to),
                                        in: shift(node.in, from.in, to.in), out: shift(node.out, from.out, to.out)};
                                    if (from.roundness !== undefined || to.roundness !== undefined) {
                                        corrected.roundness = (from.roundness ?? .25)
                                            + ((to.roundness ?? .25) - (from.roundness ?? .25)) * t;
                                    }
                                    return corrected;
                                });
                                region.poly = curvePoly(region.curve);
                            } else {
                                const sample = points => resamplePoly([...points, points[0]].map(([x,y]) => ({x,y})), 96);
                                const points = region.poly;
                                const baseline = aligned ? endPoly : sample(endPoly);
                                const target = aligned || alignPoly(sample(targetPoly), baseline);
                                region.poly = (aligned ? points : sample(points)).map(([x,y], i) => [
                                    x + (target[i][0] - baseline[i][0]) * t,
                                    y + (target[i][1] - baseline[i][1]) * t,
                                ]);
                                delete region.curve;
                            }
                        }
                        if (!source.poly) lastRectangle = region;
                        region.tracking_reliable = true;
                        frames[frameKey] = region;
                    });
                }
                state.autoTracking = {video_id: videoId, tracks};
                writeData();
                void saveMaskVersion(dataWidget.value);
                if (direction && state.trackId === trackId && state.frameIdx === start) {
                    showFrame(start + direction * results[0].result.transforms.length);
                } else redraw();
                await new Promise(resolve => setTimeout(resolve, 600));
            } catch (error) {
                if (!controller.signal.aborted) trackingNotice(error.message || "跟踪失败", "error");
            } finally {
                clearInterval(progressTimer);
                for (const event of blockedEvents) window.removeEventListener(event, blockInteraction, true);
                trackingRequest = null;
                trackingProgress.hidden = true;
                container.classList.remove("xzg-wmdet-tracking");
                button.classList.remove("xzg-wmdet-tracking-active");
                button.removeAttribute("aria-disabled");
                button.innerHTML = trackingButtonIcon(direction);
                button.setAttribute("aria-label", trackDirections[buttonIndex][1]);
            }
        };
        chainCallback(node, "onRemoved", () => trackingRequest?.abort());
        chainCallback(node, "onExecuted", function (message) {
            hideProgress();
            const pv = (Array.isArray(message.preview) ? message.preview[0] : message.preview) || {};
            if (!pv || !pv.preview_str) return;
            try {
            const pd0 = JSON.parse(pv.preview_str);
                const pd = (pd0 && pd0.frames) ? pd0.frames : pd0;
                if (Array.isArray(pd) && pd.length > 0) {
                    if (pv.preview_str === loadedPreview) {
                        state.image = state.frames[state.frameIdx] || null;
                        readData();
                        syncSize();
                        redraw();
                        for (const index of failedPreviewFrames) {
                            loadPreviewFrame(pd[index], index, previewGeneration);
                        }
                        return;
                    }
                    stopPlay();
                    trackingRequest?.abort();
                    loadedPreview = pv.preview_str;
                    previewFirstFrame = pd[0]?.filename;
                    const generation = ++previewGeneration;
                    failedPreviewFrames.clear();
                    state.sampleIdx = pd0.sample_idx || [];
                    const newKey = pd0.video_id;
                    let saved = {};
                    try { saved = JSON.parse(dataWidget.value) || {}; } catch {}
                    const previousKey = saved.video_id || state.srcKey || saved.auto_tracking?.video_id;
                    // 总帧数与图片加载进度无关，关键帧刻度从载入开始就固定。
                    state.frames = new Array(pd.length);
                    state.frameIdx = 0;
                    state.image = null;
                    readData();
                    if (newKey && previousKey && newKey !== previousKey) {
                        clearRegions();
                        resetPreviewView();
                    }
                    if (newKey) {
                        state.srcKey = newKey;
                        if (saved.video_id !== newKey) {
                            writeData(false);
                            resetEditHistory();
                        }
                    }
                    refreshTrackBtns();
                    redraw();
                    pd.forEach((file, index) => loadPreviewFrame(file, index, generation));
                    slider.max = Math.max(0, pd.length - 1);
                    slider.value = 0;
                    slider.disabled = pd.length < 2;
                    slider.style.opacity = pd.length < 2 ? "0.3" : "1";
                    slider.style.pointerEvents = pd.length < 2 ? "none" : "";
                    slider.style.cursor = pd.length < 2 ? "default" : "pointer";
                    frameInfo.innerText = `0/${Math.max(0, pd.length - 1)}`;
                    // 帧号文本宽度固定：按最大帧号位数预留（如 120 帧 → "i/120" 最多 7 字符）。
                    // 否则 38/120 → 100/120 两位变三位时文本变宽，挤压 flex:1 的滑条，
                    // 导致右侧播放条在拖动过程中变窄/位移。monospace 下 1ch = 一个字符宽。
                    const digits = String(Math.max(0, pd.length - 1)).length;
                    frameInfo.style.minWidth = `max(44px, ${(2 * digits + 1)}ch)`;
                    // 修复：加载视频后播放头默认不显示、要拖动一次才出现。
                    // 播放头由 ::-webkit-slider-thumb 伪元素绘制，仅用 JS 改 max/value
                    // 不会触发伪元素重绘（布局克隆/时序问题），首次拖动的值变化才触发原生重绘。
                    // 同步 display 往返 + 强制 reflow 让浏览器立即重绘滑块；
                    // 同时补画播放条横条/关键帧标记（onExecuted 原本不触发 drawKfBar，
                    // 若首帧 onload 时布局未稳定，横条会缺席到下一次 resize 才补上）。
                    requestAnimationFrame(() => {
                        slider.style.display = "none";
                        void slider.offsetHeight;   // 强制 reflow
                        slider.style.display = "";
                        try { drawKfBar(); } catch (e) {}
                    });
                    // 横条缺失修复：加载瞬间前端布局可能尚未稳定，drawKfBar 会以过期的
                    // slider.clientWidth 画出几乎零宽的横条，之后无尺寸变化就不再重画
                    //（拖动才会经 redraw→drawKfBar 补上）。这里错峰多次重画兜底。
                    [120, 300, 700].forEach((t) => setTimeout(() => { try { drawKfBar(); } catch (e) {} }, t));
                }
            } catch (e) {}
        });

        // ---- 尺寸管理（方向1：高度单一来源 = 前端布局，同视频加载器模式）----
        // computeSize 占位已删除：_arrangeWidgets 走 computeLayoutSize 弹性分支，
        // minHeight 保底 + 吸收节点剩余空间；前端 DomWidget 组件为容器挂 h-full/w-full
        // 并按布局结果统一克隆定位/定尺寸。此处不再写 container.style.height
        //（旧 syncH 双写高度 + 定位随缩放换算，是"节点下方死区"的根源）。
        const MIN_PREVIEW_H = 238;
        // 为轨道、空遮罩开关、播放和清理按钮留出一行的宽度。
        const MIN_NODE_W = 905;
        // 本 DOM widget 顶部 y：优先用 LiteGraph 绘制时记录的 widget.y；
        // 否则自己累加前面可见 widget 的 computeSize 高度回退。（仅用于一次性初始尺寸）
        const measureTop = (sizeW) => {
            if (typeof widget.y === 'number' && isFinite(widget.y) && widget.y > 0) return widget.y;
            let top = 0;
            try {
                const idx = node.widgets.indexOf(widget);
                const limit = idx >= 0 ? idx : node.widgets.length;
                for (let i = 0; i < limit; i++) {
                    const w = node.widgets[i];
                    if (!w || w === dataWidget || w.hidden) continue;
                    if (typeof w.computeSize === 'function') {
                        const cs = w.computeSize(sizeW);
                        if (Array.isArray(cs) && cs[1] > 0) top += cs[1];
                    }
                }
            } catch (e) {}
            return top;
        };

        // 告知 ComfyUI 此 DOM widget 的最小高度（同视频加载器；
        // 删除 computeSize 占位后，此弹性分支才真正参与布局与空间分配）
        try { widget.computeLayoutSize = function () { return { minHeight: MIN_PREVIEW_H, minWidth: 0 }; }; } catch (e) {}

        // 初始把节点撑到足够高：参数区 + 最小视窗（仅建节点时一次性；此后高度由前端布局管理）
        const initW = Math.max(MIN_NODE_W, (node.size[0] || MIN_NODE_W));
        const initH = Math.max(MIN_PREVIEW_H + measureTop(initW) + 20, node.size[1] || 0);
        node.setSize([initW, initH]);

        // 画面适配：节点/布局尺寸变化时重算视频 contain 尺寸与播放条（不再写容器高度）
        chainCallback(node, "onResize", () => { syncSize(); });
        // CSS transform/zoom 不触发 ResizeObserver。缩放后若保留旧位图，
        // 需重新生成清晰位图，并保留控制点随画布缩放后的尺寸。
        // 在 DOM 布局完成后同步实际显示几何，使静止与拖动采用同一绘制比例。
        let overlayGeometry = "", overlayWatchStopped = false, overlayWatchFrame = 0;
        const watchOverlayGeometry = () => {
            if (overlayWatchStopped) return;
            if (brushOverlay.isConnected) {
                const r = brushOverlay.getBoundingClientRect();
                const c = canvas.getBoundingClientRect();
                const geometry = [r.width, r.height, c.width, c.height,
                    c.left - r.left, c.top - r.top, window.devicePixelRatio].join(",");
                if (geometry !== overlayGeometry) {
                    overlayGeometry = geometry;
                    drawActiveOverlay();
                }
            }
            overlayWatchFrame = requestAnimationFrame(watchOverlayGeometry);
        };
        overlayWatchFrame = requestAnimationFrame(watchOverlayGeometry);
        chainCallback(node, "onRemoved", () => {
            overlayWatchStopped = true;
            cancelAnimationFrame(overlayWatchFrame);
        });
        if (typeof ResizeObserver !== "undefined") {
            try {
                const ro = new ResizeObserver(() => { try { syncSize(); } catch (e) {} });
                ro.observe(canvasWrapper);
                // 播放条几何自愈：tracker/滑块任何尺寸变化（执行后前端重排版、字体加载、
                // 帧号文本变宽等）都立即重画横条/关键帧标记，横条不再依赖拖动来“补画”
                const ro2 = new ResizeObserver(() => { try { drawKfBar(); } catch (e) {} });
                ro2.observe(tracker);
                ro2.observe(slider);
            } catch (e) {}
        }
        applySwitch();
        // 布局稳定后补画一次播放条横条/竖杠（首次布局宽为 0 时可能被跳过）
        setTimeout(() => { try { drawKfBar(); } catch (e) {} }, 250);
        // 延迟兜底：ComfyUI 加载工作流时 widget 值晚于 onNodeCreated 填充，
        // 到点再同步一次，确保视窗画出与后端一致的标注（持久化方案：刷新后恢复已画框）
        setTimeout(() => { try { readData(); applySwitch(); } catch (e) {} }, 450);
        console.log("[小珠光][水印] 视窗创建完成");
    } catch (err) {
        console.error("[小珠光][水印] 视窗创建异常:", err);
    }
}

// 视频水印检测节点「使用说明」弹窗（与工作流管理器说明书风格一致）
function showWmDetHelp() {
    const existing = document.querySelector(".xzg-wmdet-help-overlay");
    if (existing) { existing.remove(); }
    const overlay = document.createElement("div");
    overlay.className = "xzg-wmdet-help-overlay";
    overlay.style.cssText = "position:fixed;inset:0;z-index:1000002;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;";
    overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) close(); });

    const dialog = document.createElement("div");
    dialog.className = "xzg-wmdet-help-dialog";
    dialog.style.cssText = "background:#1c1c1e;border:1px solid #3a3a3c;border-radius:10px;width:640px;max-width:90vw;max-height:82vh;box-shadow:0 12px 40px rgba(0,0,0,.5);display:flex;flex-direction:column;overflow:hidden;font-family:inherit;";
    dialog.innerHTML = `
        <div style="padding:14px 18px;border-bottom:1px solid #333;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;">
            <div style="font-size:15px;font-weight:bold;color:#FFD700;">小珠光视频遮罩手工跟踪 · 使用说明</div>
            <button class="xzg-wmdet-help-close" style="background:none;border:none;color:#999;font-size:20px;cursor:pointer;padding:0 4px;line-height:1;flex-shrink:0;">×</button>
        </div>
        <div class="xzg-wmdet-help-body" style="padding:16px 20px;overflow-y:auto;color:#d8d8d8;font-size:13px;line-height:1.7;">
            <style>
              .xzg-wmdet-help-body h4{margin:14px 0 6px;font-size:13px;color:#FFD700;}
              .xzg-wmdet-help-body h4:first-child{margin-top:0;}
              .xzg-wmdet-help-body ul{margin:4px 0;padding-left:20px;}
              .xzg-wmdet-help-body li{margin:3px 0;}
            </style>

            <h4>加载与标注</h4>
            <ul>
                <li>点「点击加载视频」，切到要编辑的帧，再选「框选」或「曲线」。默认显示轨道 1，点「＋」可增加颜色轨道，最多 8 条。「显示全部／显示当前」切换预览中可见的轨道。</li>
                <li>点击已有遮罩可将当前帧保存为关键帧。拖动矩形内部可移动，拖动边角可调整大小。点击空白处会保留手柄。</li>
                <li>曲线至少需要三个锚点，右键点击预览区或点击首点完成绘制，按 Esc 取消。拖动锚点或手柄可调整轮廓，点击已选曲线的线段可增加锚点，Alt 单击锚点可切换尖角和平滑曲线。</li>
            </ul>

            <h4>自动跟踪与修正</h4>
            <ul>
                <li>从当前矩形或闭合曲线点「向前跟踪」「向后跟踪」或「双向跟踪」。右键跟踪按钮可在当前帧绘制独立跟踪区域，用一块稳定纹理带动遮罩。每个方向在遇到手工关键帧前停止。</li>
                <li>跟丢时先沿用最近可靠的轮廓，再尝试恢复。拖动矩形或调整曲线锚点和手柄后，修正量会在两侧逐帧减小。</li>
                <li>点击关键帧三角可跳转，拖动可移动关键帧，右键可删除、锁定编辑或全局缩放所有矩形框。锁定的三角会带白色圆点，切换到其他帧后拖动遮罩仍会编辑锁定帧。右键点击两个关键帧之间的播放条，可清除这段自动跟踪并恢复两端之间的手工插值。</li>
            </ul>

            <h4>预览与输出</h4>
            <ul>
                <li>鼠标悬停在预览区时，左右键逐帧切换，上下键跳到上一个或下一个可见轨道的关键帧，空格播放或暂停。Ctrl + 滚轮缩放，按住中键或 Ctrl + 左键拖动平移，点「恢复视图」回到默认大小和位置。</li>
                <li>点「全屏编辑」放大工作区。全屏预览中直接滚轮缩放，按住鼠标中键或 Ctrl + 左键拖动画面。点「退出全屏」或按 Esc 返回节点。</li>
                <li>开启「允许遮罩为空」后，轨道首尾没有标注的帧留空。默认关闭，首尾沿用最近的遮罩。</li>
            </ul>
        </div>
        <div style="padding:12px 18px;border-top:1px solid #333;display:flex;justify-content:flex-end;flex-shrink:0;">
            <button class="xzg-wmdet-help-ok" style="padding:6px 16px;background:#FFD700;color:#1c1c1e;border:none;border-radius:4px;cursor:pointer;font-size:12px;font-weight:bold;">知道了</button>
        </div>`;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const close = () => { try { overlay.remove(); } catch (e) {} };
    dialog.querySelector(".xzg-wmdet-help-close")?.addEventListener("click", close);
    dialog.querySelector(".xzg-wmdet-help-ok")?.addEventListener("click", close);
    dialog.querySelector(".xzg-wmdet-help-ok")?.focus();
    overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
}

// 注册水印检测节点：复用点编辑器已验证的加载机制（beforeRegisterNodeDef + onNodeCreated 链）
app.registerExtension({
    name: "Comfy.Xiaozhuguang.WatermarkDetect",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "VideoWatermarkDetector") return;
        chainCallback(nodeType.prototype, "onNodeCreated", function () {
            wm_applyLabels(this);
            wm_ensureViewer(this);
        });
        chainCallback(nodeType.prototype, "onConfigure", function () {
            wm_applyLabels(this);
        });
    }
});

// 水印检测节点参数标签双语（中文 / English），不改后端参数名（工作流序列化不受影响）
const WM_LABEL_MAP = [
    ["model_name", "模型", "Model"],
    ["regions_data", "区域数据", "Regions data"],
];
function wm_applyLabels(node) {
    if (!node || !node.widgets) return;
    // 隐藏控件仍用于序列化，但其输入口会叠在图像端口附近。
    for (let i = (node.inputs?.length ?? 0) - 1; i >= 0; i--) {
        if (["model_name", "regions_data", "temporal_dilate", "color_index", "fps"].includes(node.inputs[i].name)) {
            node.removeInput(i);
        }
    }
    for (const w of node.widgets) {
        const hit = WM_LABEL_MAP.find(([name]) => name === w.name);
        if (hit) w.label = xzgT(hit[1], hit[2]);
    }
}

// 补建：工作流恢复时可能已有节点实例，稍后统一挂接
setTimeout(() => {
    try {
        const g = app.graph;
        if (g && g._nodes) g._nodes.forEach(n => { if (n.type === "VideoWatermarkDetector") { wm_applyLabels(n); wm_ensureViewer(n); } });
    } catch (e) {}
}, 300);
setTimeout(() => {
    try {
        const g = app.graph;
        if (g && g._nodes) g._nodes.forEach(n => { if (n.type === "VideoWatermarkDetector") { wm_applyLabels(n); wm_ensureViewer(n); } });
    } catch (e) {}
}, 1200);

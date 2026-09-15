import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { xzgT } from "./xzg_i18n.js";

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
                // 注意：高度由 onResize/onDrawForeground 通过 JS 精确控制，与 computeSize 保持一致
                container.style.cssText = "position: relative; width: 100%; background: #0f1011; overflow: hidden; box-sizing: border-box; border-radius: 4px; margin: 0; padding: 0; display: flex; flex-direction: column;";

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
                canvasWrapper.style.cssText = "flex: 1; width: 100%; position: relative; overflow: hidden; display: flex; align-items: center; justify-content: center; background: #0f1011;";
                container.appendChild(canvasWrapper);

                const canvas = document.createElement("canvas");
                canvas.width = 512;
                canvas.height = 512;
                canvas.style.cssText = "display: block; width: 100%; height: 100%; object-fit: contain; cursor: crosshair;";
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

                // 统一偏移量：节点高度 → widget高度的转换
                // 覆盖标题栏(~30px) + 输入/输出连接区 + 间距等非widget区域
                const WIDGET_HEIGHT_OFFSET = 130;

                const calcWidgetHeight = (nodeH) => Math.max(50, nodeH - WIDGET_HEIGHT_OFFSET);

                // 返回 height = -1 告诉 ComfyUI："给我多少空间我都填满"
                widget.computeSize = (width) => [width, -1];

                // 同步更新 container 高度——根据实际节点尺寸计算
                // 性能优化：带守卫，值没变就不写样式，避免 onDrawForeground 每帧强制 reflow
                let lastWidgetH = -1;
                const syncContainerHeight = (size) => {
                    const h = calcWidgetHeight(size[1]);
                    if (h === lastWidgetH) return;
                    lastWidgetH = h;
                    container.style.height = h + 'px';
                };
                chainCallback(this, "onResize", syncContainerHeight);
                chainCallback(this, "onDrawForeground", function(ctx) {
                    syncContainerHeight(this.size);
                    syncCanvasSize();
                });

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
                        const box = {
                            x: Math.min(currentBox.x, currentBox.x + currentBox.w),
                            y: Math.min(currentBox.y, currentBox.y + currentBox.h),
                            w: Math.abs(currentBox.w),
                            h: Math.abs(currentBox.h)
                        };
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
                    ctx.strokeStyle = "#0ff";
                    ctx.lineWidth = 2;
                    ctx.setLineDash([5, 5]);
                    ctx.strokeRect(L.imgLeft + currentBox.x * L.scale, L.imgTop + currentBox.y * L.scale, currentBox.w * L.scale, currentBox.h * L.scale);
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

        const toolbar = document.createElement("div");
        // 加高 8px（28→36）：容纳加大 4px 后的「点击加载视频」行，避免文字贴边
        toolbar.style.cssText = "flex: 0 0 36px; width: 100%; background: #222; display: flex; align-items: center; justify-content: space-between; padding: 0 6px; box-sizing: border-box; border-bottom: 1px solid #333; z-index: 10;";
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
.xzg-wmdet-ft-off{color:#e53935;animation:none;font-size:14px;font-weight:600;}
.xzg-wmdet-ft-filter{color:#3ef558;animation:none;font-size:14px;font-weight:600;}
.xzg-wmdet-ft-manual{color:#cba46c;animation:none;font-size:14px;font-weight:600;}
@keyframes xzgWmdetSweep{0%{background-position:130% 0;}100%{background-position:-30% 0;}}`;
        const trackBar = document.createElement("div");
        trackBar.style.cssText = "display:flex;align-items:center;gap:6px;margin-left:10px;";
        const trackBtns = [];
        let trackUnlocked = new Set([1]); // 已解锁轨道：默认仅 1；点任意占位槽可单独增加该数字的分类（中间可留空）
        for (let t = 1; t <= 8; t++) {
            (function(t){
                const b = document.createElement("div");
                // 随工具栏整体放大：框 14→20px、数字 14→18px，间隙 4→6px
                b.style.cssText = "width:20px;height:20px;display:flex;align-items:center;justify-content:center;cursor:pointer;border-radius:4px;font-size:18px;font-weight:700;user-select:none;border:1px solid transparent;position:relative;font-variant-numeric:tabular-nums;";
                b.innerText = String(t);
                // 选中圆点：当前选中轨道数字的高亮框下方的小圆点提醒（与数字同一中心）
                const dot = document.createElement("div");
                dot.style.cssText = "position:absolute;left:0;right:0;margin:0 auto;bottom:-5px;width:4px;height:4px;border-radius:50%;display:none;";
                b.appendChild(dot);
                b._dot = dot;
                // 已解锁：点击切换到该轨道；占位槽：点击单独增加该数字的分类
                b.onclick = (e) => {
                    e.stopPropagation();
                    trackUnlocked.add(t);
                    state.trackId = t;
                    refreshTrackBtns();
                    drawKfBar();
                    redraw();
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
                                trackUnlocked.delete(t);  // 数字消失；点该槽位的「+」可单独加回
                                if (state.trackId === t) state.trackId = 1;
                                writeData();
                                redraw();           // redraw 内部会 drawKfBar，三角随之消失
                                refreshTrackBtns(); // 轨道边框/选中状态同步
                            },
                        },
                    ]);
                });
                trackBar.appendChild(b); trackBtns.push(b);
            })(t);
        }
        // 占位槽即「+」：显示加号，点击解锁该数字的轨道（无独立 + 按钮）
        // 一键扩展关键帧：把当前颜色分类的最左关键帧复制到第一帧、最右关键帧复制到最后一帧，
        // 使遮罩覆盖视频全程（首尾之外无需再手动画框）
        const extendBtn = document.createElement("div");
        extendBtn.style.cssText = "height:20px;padding:0 8px;display:flex;align-items:center;justify-content:center;cursor:pointer;border-radius:4px;font-size:18px;font-weight:700;color:#cba46c;user-select:none;white-space:nowrap;flex-shrink:0;margin-left:4px;";
        extendBtn.innerText = "一键扩展";
        extendBtn.title = "将当前颜色分类的关键帧扩展到首尾：最左关键帧复制到第一帧，最右关键帧复制到最后一帧";
        extendBtn.onmouseover = () => { extendBtn.style.backgroundColor = "#333"; };
        extendBtn.onmouseout = () => { extendBtn.style.backgroundColor = "transparent"; };
        extendBtn.onclick = (e) => {
            e.stopPropagation();
            const nf = state.frames.length;
            if (nf < 2) return;                                   // 不足两帧无需扩展
            const km = state.manualKeyframes[state.trackId];
            if (!km) return;
            const kfs = Object.keys(km).map(Number)
                .filter(f => Array.isArray(km[f]) && km[f].length)
                .sort((a, b) => a - b);
            if (!kfs.length) return;                              // 当前轨道没有关键帧
            const first = kfs[0], last = kfs[kfs.length - 1];
            let changed = false;
            // 扩展产生的关键帧打标记：播放条上用小一号三角区分（仅会话内有效）
            state.extKf = state.extKf || {};
            if (first !== 0) { km[0] = JSON.parse(JSON.stringify(km[first])); state.extKf[state.trackId + ":0"] = true; changed = true; }
            if (last !== nf - 1) { km[nf - 1] = JSON.parse(JSON.stringify(km[last])); state.extKf[state.trackId + ":" + (nf - 1)] = true; changed = true; }
            if (changed) {
                writeData();
                redraw();
                refreshTrackBtns();
            }
        };
        trackBar.appendChild(extendBtn);
        // 仅显示当前分类：激活后播放条三角与画布画框只显示当前颜色轨道。
        // 文案/配色随状态切换：激活=当前分类色的单色文案；关闭=按 1-8 轨道色逐字对应的多彩文案
        let _solo = false;
        const soloBtn = document.createElement("div");
        soloBtn.style.cssText = "height:20px;padding:0 8px;display:flex;align-items:center;justify-content:center;cursor:pointer;border-radius:4px;font-size:18px;font-weight:700;user-select:none;white-space:nowrap;flex-shrink:0;margin-left:4px;border:1px solid transparent;box-sizing:border-box;";
        soloBtn.title = "仅显示当前颜色分类的关键帧与画框（再次点击恢复显示全部分类）";
        const SOLO_TEXT_ON = "仅显示当前颜色关键帧";
        const SOLO_TEXT_OFF = "显示全部颜色关键帧";
        const refreshSoloBtn = () => {
            if (_solo) {
                const c = TRACK_COLORS[(state.trackId - 1) % TRACK_COLORS.length];
                soloBtn.innerHTML = `<span style="color:${c}">${SOLO_TEXT_ON}</span>`;
                soloBtn.style.borderColor = c;
                soloBtn.style.backgroundColor = "rgba(255,255,255,0.08)";
            } else {
                soloBtn.innerHTML = SOLO_TEXT_OFF.split("").map((ch, i) =>
                    `<span style="color:${TRACK_COLORS[i % TRACK_COLORS.length]}">${ch}</span>`).join("");
                soloBtn.style.borderColor = "#555";
                soloBtn.style.backgroundColor = "transparent";
            }
        };
        soloBtn.onclick = (e) => {
            e.stopPropagation();
            _solo = !_solo;
            refreshSoloBtn();
            redraw(); // redraw 内部会 drawKfBar，播放条三角与画布同步刷新
        };
        soloBtn.onmouseover = () => { if (!_solo) soloBtn.style.backgroundColor = "#333"; };
        soloBtn.onmouseout = () => { if (!_solo) soloBtn.style.backgroundColor = "transparent"; };
        // 注意：此处不能立即调用 refreshSoloBtn()——state/TRACK_COLORS 尚未初始化（定义在后方），
        // 立即执行会抛错并中断整个视窗创建。初始填充由稍后的 applySwitch→refreshTrackBtns 完成
        trackBar.appendChild(soloBtn);
        toolbar.appendChild(trackBar);
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
                const c = TRACK_COLORS[idx];
                const kfsAll = state.manualKeyframes || {};
                const kfs = kfsAll[tid] || {};
                const hasBox = Object.values(kfs).some(fr => Array.isArray(fr) && fr.length);
                const unlocked = trackUnlocked.has(tid); // 未解锁的槽位显示为「+」
                b.title = unlocked ? `轨道 ${tid}` : `点击增加轨道 ${tid}`;
                b.innerText = unlocked ? String(tid) : "+";
                b.style.fontSize = "18px";
                b.style.background = "transparent";
                b.style.borderStyle = unlocked ? "solid" : "dashed";
                if (unlocked) {
                    b.style.color = c;
                    // 仅选中轨道画边框（轨道色），不带辉光；未选中一律无边框
                    const selected = tid === state.trackId;
                    b.style.borderColor = selected ? c : "transparent";
                    b.style.boxShadow = "none";
                    b.style.cursor = "pointer";
                    b.style.pointerEvents = "auto";
                } else {
                    // 占位槽：淡色「+」+ 虚线边，点击解锁该数字
                    b.style.color = "#6b7280";
                    b.style.borderColor = "rgba(255,255,255,0.12)";
                    b.style.cursor = "pointer";
                    b.style.pointerEvents = "auto";
                }
                if (b._dot) { b._dot.style.display = (unlocked && tid === state.trackId) ? "block" : "none"; b._dot.style.background = c; }
            });
            trackBar.style.display = (state.mode === "manual") ? "flex" : "none";
            refreshToolBtn();
        };

        // 标注工具切换：▭ 框选 / ✎ 手绘（仅手工跟踪模式显示）
        const toolBtn = document.createElement("div");
        toolBtn.style.cssText = "height:26px;min-width:68px;padding:0 8px;display:flex;align-items:center;justify-content:center;gap:6px;cursor:pointer;border-radius:4px;font-size:18px;font-weight:700;user-select:none;border:1px solid transparent;box-sizing:border-box;white-space:nowrap;flex-shrink:0;";
        toolBtn.title = "标注工具：框选 / 手绘";
        toolbar.insertBefore(toolBtn, trackBar);
        const refreshToolBtn = () => {
            const c = TRACK_COLORS[(state.trackId-1) % TRACK_COLORS.length];
            toolBtn.style.display = (state.mode === "manual") ? "flex" : "none";
            toolBtn.style.color = c;
            toolBtn.style.borderColor = "transparent";
            if (state.tool === "brush") {
                toolBtn.innerHTML = "<span>✎</span> 手绘";
            } else {
                // 长方形框图标（宽>高），与文字同为块级 flex 项，保证垂直居中
                toolBtn.innerHTML = '<svg style="display:block;flex-shrink:0" width="16" height="13" viewBox="0 0 12 10" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1.5" y="1.5" width="9" height="7" rx="1"/></svg><span style="display:block;line-height:13px">框选</span>';
            }
        };
        toolBtn.onclick = (e) => { e.stopPropagation(); state.tool = (state.tool === "rect") ? "brush" : "rect"; refreshToolBtn(); redraw(); };

        const right = document.createElement("div");
        right.style.display = "flex";
        right.style.alignItems = "center";
        right.style.gap = "6px";
        right.style.flexShrink = "0";
        right.style.marginLeft = "auto";   // 无论其他元素隐藏与否，右侧组始终贴右
        toolbar.appendChild(right);

        const hint = document.createElement("div");
        hint.style.cssText = "color: #777; font-size: 16px; user-select: none; display: none; white-space: nowrap;";
        hint.innerText = "左键框选";
        right.appendChild(hint);


        // 「引入上游图片」按钮：手动执行当前节点（含上游）引入画面（切换模式不再自动引入）
        const runBtn = document.createElement("div");
        // 加高 8px（20→28）、文字加大 4px（14→18，⏎ 符号随字号等比变大）
        runBtn.style.cssText = "height: 28px; min-width: 64px; padding: 0 10px; display: flex; align-items: center; justify-content: center; cursor: pointer; border-radius: 4px; color: #d8d8d8; font-size: 18px; font-weight: 400; user-select: none; box-sizing: border-box; white-space: nowrap; flex-shrink: 0;";
        runBtn.innerHTML = '<span style="font-weight:700">点击加载视频⏎</span>';
        runBtn.title = "执行当前节点（含上游），预览检测画面";
        // 点击加载视频：不清空已画标注（持久化方案——同视频重复执行保留标注）
        runBtn.onclick = (e) => { e.stopPropagation(); startProgress(); runUpstream(); };
        // 颜色/文字跟随模式：手工跟踪=暗金+短文案（旧自动检测模式的荧光绿分支已下线，仅保留防御）
        const updateRunBtn = () => {
            const m = state.mode;
            runBtn.style.display = "flex";
            runBtn.style.color = (m === "filter") ? "#3ef558" : "#cba46c";
            runBtn.innerHTML = (m === "filter")
                ? '<span style="font-weight:700">点击加载视频⏎</span>'
                  + '<span style="color:#888;font-weight:400;margin-left:20px">1、不操作为全域跟踪</span>'
                  + '<span style="color:#888;font-weight:400;margin-left:20px">2、点击加载时候，画方框为限定区域跟踪</span>'
                : '<span style="font-weight:700">点击加载视频⏎</span>';
        };

        // 仅执行到本节点（含上游）：按钮 / 右键菜单共用
        const runUpstream = () => {
            const targetIds = new Set([String(node.id)]);
            const orig = api.queuePrompt;
            const hook = async function (index, prompt, ...args) {
                if (prompt && prompt.output) {
                    const oldOutput = prompt.output;
                    const newOutput = {};
                    const visited = new Set();
                    const collect = (val) => {
                        if (!Array.isArray(val)) return;
                        const sid = String(val[0]);
                        if (oldOutput[sid]) { addNode(sid); return; }
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
                    prompt.output = newOutput;
                }
                api.queuePrompt = orig;
                return orig.call(api, index, prompt, ...args);
            };
            try {
                api.queuePrompt = hook;
                app.queuePrompt(0);
            } catch (err) {
                console.error("[小珠光][水印] 执行失败:", err);
            }
            setTimeout(() => { if (api.queuePrompt !== orig) api.queuePrompt = orig; }, 3000);
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
        helpBtn.style.cssText = "background:none;border:none;color:#FFD700;cursor:pointer;user-select:none;white-space:nowrap;flex-shrink:0;padding:0 2px;margin-right:8px;display:flex;align-items:center;justify-content:center;";
        helpBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>';
        helpBtn.title = "使用说明";
        helpBtn.onmouseover = () => { helpBtn.style.color = "#FFA500"; };
        helpBtn.onmouseout = () => { helpBtn.style.color = "#FFD700"; };
        helpBtn.onclick = (e) => { e.stopPropagation(); try { showWmDetHelp(); } catch (err) { console.error("[小珠光][水印] showWmDetHelp 错误:", err); } };
        toolbar.insertBefore(helpBtn, runBtn);

        const clearBtn = document.createElement("div");
        // 小垃圾桶：仅删除当前颜色分类（当前轨道）的关键帧
        const clearCurBtn = document.createElement("div");
        clearCurBtn.style.cssText = "width: 20px; height: 20px; display: flex; align-items: center; justify-content: center; cursor: pointer; border-radius: 4px; color: #ccc; user-select: none; flex-shrink: 0;";
        clearCurBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6M14 11v6"></path><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"></path></svg>';
        clearCurBtn.title = "删除当前颜色分类的关键帧";
        clearCurBtn.onmouseover = () => { clearCurBtn.style.backgroundColor = "#333"; };
        clearCurBtn.onmouseout = () => { clearCurBtn.style.backgroundColor = "transparent"; };
        clearCurBtn.onclick = (e) => {
            e.stopPropagation();
            if (state.manualKeyframes[state.trackId]) {
                delete state.manualKeyframes[state.trackId];
                writeData();
                redraw();
                refreshTrackBtns();
            }
        };
        clearBtn.style.cssText = "width: 26px; height: 26px; display: flex; align-items: center; justify-content: center; cursor: pointer; border-radius: 4px; color: #ccc; font-size: 18px; user-select: none; flex-shrink: 0;";
        clearBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6M14 11v6"></path><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"></path></svg>';
        clearBtn.title = "删除全部标注（所有分类的关键帧 + 检测/排除区）";
        clearBtn.onmouseover = () => { clearBtn.style.backgroundColor = "#333"; };
        clearBtn.onmouseout = () => { clearBtn.style.backgroundColor = "transparent"; };
        clearBtn.onclick = (e) => {
            e.stopPropagation();
            state.detectRegions = [];
            state.excludeRegions = [];
            state.manualKeyframes = {};
            trackUnlocked = new Set([1]); // 除轨道 1 外，其他分类的数字一并收回
            state.trackId = 1;
            writeData();
            redraw();
            refreshTrackBtns();
        };
        right.appendChild(clearBtn);
        right.insertBefore(clearCurBtn, clearBtn); // 小垃圾桶在大垃圾桶左侧

        hint.innerText = "左键框选 (检测区)";

        // 帧控制栏（帧号 + 滑块）：加高 15px（52→67），为播放条后续优化预留空间
        const tracker = document.createElement("div");
        tracker.style.cssText = "flex: 0 0 67px; width: 100%; background: #222; position:relative; display: flex; align-items: center; justify-content: space-between; padding: 0 8px; box-sizing: border-box; border-bottom: 1px solid #333; gap: 4px;";
        container.appendChild(tracker);
        // 播放条区域屏蔽浏览器原生右键菜单（三角的关键帧菜单已自行 preventDefault，
        // 其余位置右键静默忽略，避免误触浏览器菜单打断标注节奏）
        tracker.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
        });

        const frameInfo = document.createElement("div");
        frameInfo.style.cssText = "color: #ccc; font-family: monospace; font-size: 14px; min-width: 44px; text-align: right; user-select: none;";
        frameInfo.innerText = "0/0";
        tracker.appendChild(frameInfo);

        // 播放画面按钮已移除；stopPlay 保留为空操作，供其余调用点（拖动播放条/切帧）安全调用
        const stopPlay = () => {};

        const slider = document.createElement("input");
        slider.type = "range";
        slider.min = "0";
        slider.max = "0";
        slider.value = "0";
        slider.step = "1";
        slider.disabled = true;
        slider.style.cssText = "flex: 1; height: 4px; cursor: default; accent-color: #e8c547; opacity: 0.3; pointer-events: none; position: relative; z-index: 4;";
        // 播放头手柄：圆形 → 三角形+竖杠（金色，与 accent-color 一致）。
        // 实心倒三角 + 下方竖线，SVG data URI 作为 thumb 背景；
        // 全局注入一次，多个节点共用。thumb 宽 16px 高 20px，
        // getThumbRadius() 读到 16px/2=8px，竖杠对齐公式自动适用。
        if (!document.getElementById('xzg-wmdet-slider-style')) {
            const st = document.createElement('style');
            st.id = 'xzg-wmdet-slider-style';
            st.textContent = `
.xzg-wmdet-slider{-webkit-appearance:none;appearance:none;background:transparent;height:4px;}
.xzg-wmdet-slider::-webkit-slider-runnable-track{height:4px;border-radius:2px;background:transparent;}
.xzg-wmdet-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:16px;height:35px;margin-top:-15px;background:url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 35'><path d='M1.5 0 L14.5 0 L8 13 Z' fill='%23d8d8d8'/><line x1='8' y1='4.3' x2='8' y2='34' stroke='%23d8d8d8' stroke-width='2.4'/></svg>") no-repeat center/contain;border:none;cursor:pointer;}
.xzg-wmdet-slider::-moz-range-track{height:4px;border-radius:2px;background:transparent;}
.xzg-wmdet-slider::-moz-range-thumb{width:16px;height:35px;background:url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 35'><path d='M1.5 0 L14.5 0 L8 13 Z' fill='%23d8d8d8'/><line x1='8' y1='4.3' x2='8' y2='34' stroke='%23d8d8d8' stroke-width='2.4'/></svg>") no-repeat center/contain;border:none;border-radius:0;cursor:pointer;}
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
        hitzone.addEventListener("mousedown", (e) => {
            e.preventDefault();
            dragging = true;
            setFrameFromX(e.clientX);
        });
        window.addEventListener("mousemove", (e) => { if (dragging) setFrameFromX(e.clientX); });
        window.addEventListener("mouseup", () => { dragging = false; });

        const canvasWrapper = document.createElement("div");
        // flex:1 让它吃掉 tool 条/帧条之外的全部容器高度，否则高度由 canvas 子元素推导，
        // 画面大小会被锁死、无法随预览窗自适应；padding:15px 为视频四周保留黑色留边，
        // 画方框时不会贴到节点内边缘。
        canvasWrapper.style.cssText = "flex:1; width:100%; box-sizing:border-box; position:relative; overflow:hidden; padding:15px; display:flex; align-items:center; justify-content:center; background:#0f1011;";
        container.appendChild(canvasWrapper);

        const canvas = document.createElement("canvas");
        canvas.width = 512;
        canvas.height = 320;
        // canvas 显示尺寸由 _updateSurfaceCss 按「图像宽高比」直接写 inline px，
        // 显示框与图像严格同比例、不依赖容器高度或 object-fit → 视频绝不变形。
        canvas.style.cssText = "display: block; cursor: crosshair;";
        canvasWrapper.appendChild(canvas);
        const ctx = canvas.getContext("2d");

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
            trackId: 1,
            sampleIdx: [],
            frames: [],             // 预加载的采样帧 Image 数组
            frameIdx: 0,
            detectRegions: [],      // 检测区（归一化 0~1 {x1,y1,x2,y2}）
            excludeRegions: [],     // 排除区（归一化 0~1 {x1,y1,x2,y2}）
            // (mode 已在上方定义)         // 'detect' | 'exclude'
            drawing: null,          // 正在画的框（图像坐标）
            tool: 'rect',           // manual 模式标注工具：'rect' 框选 | 'brush' 涂抹
            brushPts: [],           // 当前涂抹轨迹（归一化 0~1）
            brushActive: false,     // 是否正在涂抹
        };

        // ---- 图像 contain 居中布局 ----
        const TRACK_COLORS = ['#ff3b30','#30d158','#ffd60a','#0a84ff','#cba46c','#00bcd4','#bf5af2','#c0c0c0'];
        const calcLayout = () => {
            // 画布内部像素固定为图像分辨率（见 syncSize：state.image 加载后一次性设置），
            // 画面与检测框都按此坐标绘制；canvas 的 CSS 尺寸由 _updateSurfaceCss 在 15px 留边内
            // 以 contain 方式精确设定，浏览器等比显示。
            const iw = canvas.width || 1, ih = canvas.height || 1;
            return { dispW: iw, dispH: ih, imgW: iw, imgH: ih, left: 0, top: 0, dw: iw, dh: ih, scale: 1 };
        };

        // contain 适配 + 严格等比：canvas 在「去掉 15px 黑边后」的可视区域内，
        // 取容器宽/高 ÷ 图像宽/高的较小缩放系数，直接写 inline 宽高，由 flex 居中的宿主
        // 自动居中。画面始终完整可见、任意节点宽高组合都不变形也不被裁切，比例始终不变。
        const PAD = 15; // 视频与节点框之间的黑色留边
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
        const drawRegionBox = (r, color, fill, label) => {
            const L = calcLayout();
            if (r.poly && Array.isArray(r.poly) && r.poly.length >= 3) {
                // 多边形：1px 实线、无填充（与矩形框一致的细线样式）
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
                if (label) { ctx.fillStyle = color; ctx.font = "14px sans-serif"; ctx.textAlign = "left"; ctx.fillText(label, L.left + r.poly[0][0] * L.dw + 3, L.top + r.poly[0][1] * L.dh + 14); }
                return;
            }
            const px = L.left + r.x1 * L.dw, py = L.top + r.y1 * L.dh;
            const pw = (r.x2 - r.x1) * L.dw, ph = (r.y2 - r.y1) * L.dh;
            ctx.strokeStyle = color;
            ctx.lineWidth = 1;
            ctx.strokeRect(px, py, pw, ph);
            if (fill) { ctx.fillStyle = fill; ctx.fillRect(px, py, pw, ph); }
            if (label) { ctx.fillStyle = color; ctx.font = "14px sans-serif"; ctx.textAlign = "left"; ctx.fillText(label, px + 3, py + 14); }
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
                // 手工跟踪：多轨关键帧
                if (state.mode === "manual") {
                    // try/catch 防御：插值等异常不得中断 redraw，否则拖动画框的实时预览段
                    //（在函数末尾）永远执行不到，表现为"拖动时无预览、松手才出框"
                    try {
                    const kfsAll = state.manualKeyframes || {};
                    const f = state.frameIdx;
                    Object.keys(kfsAll).forEach(tidStr => {
                        const tid = Number(tidStr);
                        if (_solo && tid !== state.trackId) return; // 仅显示当前分类：其他轨道不画
                        const kfs = kfsAll[tidStr] || {};
                        const keys = Object.keys(kfs).map(Number).filter(k => Array.isArray(kfs[k]) && kfs[k].length).sort((a,b)=>a-b);
                        if (!keys.length) return;
                        const color = TRACK_COLORS[(tid-1) % TRACK_COLORS.length];
                        const isCur = (tid === state.trackId);
                        const cur = kfs[f] || [];
                        cur.forEach(r => drawRegionBox(r, color, null, null));
                        if (!cur.length) {
                            if (keys.length === 1) {
                                const r0 = kfs[keys[0]][0];
                                if (r0) {
                                    drawRegionBox(r0, color, null, null);
                                }
                            } else {
                                let a = null, b = null;
                                for (const k of keys) { if (k <= f) a = k; if (k >= f && b === null) b = k; }
                                if (a !== null && b !== null) {
                                    const t = (f - a) / (b - a);
                                    const ra = kfs[a][0], rb = kfs[b][0];
                                    if (ra && rb && ra.poly && rb.poly && Array.isArray(ra.poly) && Array.isArray(rb.poly) && ra.poly.length === rb.poly.length && ra.poly.length >= 3) {
                                        const pb2 = alignPoly(rb.poly, ra.poly);   // 绕向/起点对齐，防中间帧翻转
                                        const ri = { poly: ra.poly.map((p, i) => [p[0] + (pb2[i][0] - p[0]) * t, p[1] + (pb2[i][1] - p[1]) * t]) };
                                        drawRegionBox(ri, color, null, null);
                                    } else {
                                        const lerp = (x,y) => x + (y-x)*t;
                                        const ri = { x1: lerp(ra.x1,rb.x1), y1: lerp(ra.y1,rb.y1), x2: lerp(ra.x2,rb.x2), y2: lerp(ra.y2,rb.y2) };
                                        drawRegionBox(ri, color, null, null);
                                    }
                                }
                            }
                        }
                    });
                    } catch (e) { console.warn("[小珠光][水印] 关键帧绘制异常(已跳过,不影响预览):", e); }
                }
                if (state.drawing) {
                    // state.drawing 是图像像素坐标，drawRegionBox 按归一化 0~1 绘制，
                    // 直接画会把实时框甩出画布（像素值*dw 过大），故先归一化并钳制。
                    const iw = state.image.width || 1, ih = state.image.height || 1;
                    const clamp01 = (v) => Math.max(0, Math.min(1, v));
                    const dn = {
                        x1: clamp01(Math.min(state.drawing.x1, state.drawing.x2) / iw),
                        y1: clamp01(Math.min(state.drawing.y1, state.drawing.y2) / ih),
                        x2: clamp01(Math.max(state.drawing.x1, state.drawing.x2) / iw),
                        y2: clamp01(Math.max(state.drawing.y1, state.drawing.y2) / ih),
                    };
                    // 画框中途预览框颜色跟随模式：检测模式=绿，手工跟踪模式=蓝（与关键帧框一致）
                    if (state.mode === "manual") {
                        const cc = TRACK_COLORS[(state.trackId-1)%8]; drawRegionBox(dn, cc, null, null);
                    } else {
                        drawRegionBox(dn, "#22c55e", null, null);
                    }
                }
                // 涂抹实时预览：把当前轨迹作为临时多边形绘制（手工跟踪模式）
                if (state.mode === "manual" && state.brushActive && state.brushPts.length >= 2) {
                    const cc = TRACK_COLORS[(state.trackId-1)%8];
                    ctx.strokeStyle = cc;
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    state.brushPts.forEach((p, i) => {
                        const px = L.left + p.x * L.dw, py = L.top + p.y * L.dh;
                        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
                    });
                    ctx.closePath();
                    ctx.stroke();
                }
            }
        };

        // 读取原生 range thumb 的真实半径（WebKit/Moz），读不到兜底 8px。
        // 刻度/竖杠坐标系必须基于此半径：thumb 中心只落在 [r, 宽-r] 区间。
        const getThumbRadius = () => {
            // thumb 宽度由本文件注入样式固定为 16px，半径恒定 8px。
            // 不动态读取计算样式，避免个别浏览器伪元素返回异常值导致对齐/宽度计算错误
            return 8;
        };

        // ---- 播放条右键菜单（关键帧三角 / 播放头共用）----
        let _barMenuEl = null;
        const closeBarMenu = () => { if (_barMenuEl) { _barMenuEl.remove(); _barMenuEl = null; } };
        const showBarMenu = (x, y, items) => {
            closeBarMenu();
            const menu = document.createElement("div");
            menu.style.cssText = "position:fixed;z-index:100000;min-width:130px;padding:4px;background:rgba(24,26,33,0.97);border:1px solid rgba(255,255,255,0.16);border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,0.55);color:#e8e8e8;font:13px/1.4 sans-serif;user-select:none;";
            items.forEach(({ label, fn }) => {
                const it = document.createElement("div");
                it.style.cssText = "padding:6px 12px;border-radius:5px;cursor:pointer;white-space:nowrap;";
                it.innerText = label;
                it.addEventListener("mouseenter", () => { it.style.background = "rgba(255,255,255,0.08)"; });
                it.addEventListener("mouseleave", () => { it.style.background = "transparent"; });
                it.addEventListener("click", (ev) => { ev.stopPropagation(); closeBarMenu(); fn(); });
                menu.appendChild(it);
            });
            document.body.appendChild(menu);
            const r = menu.getBoundingClientRect();
            menu.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4)) + "px";
            menu.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) + "px";
            _barMenuEl = menu;
        };
        // 关键帧三角菜单：删除 / 复制到当前播放头（按三角所属轨道 tid 操作）
        const showKfMenu = (x, y, fr, tid) => showBarMenu(x, y, [
            {
                label: "删除关键帧",
                fn: () => {
                    const km = state.manualKeyframes[tid];
                    if (km && km[fr]) {
                        delete km[fr];
                        writeData();
                        redraw();          // redraw 内部会 drawKfBar，三角随之消失
                        refreshTrackBtns(); // 轨道按钮的关键帧描边状态同步
                    }
                },
            },
            {
                label: "复制关键帧到播放头",
                fn: () => {
                    const km = state.manualKeyframes[tid];
                    const src = km ? km[fr] : null;
                    if (!src || !src.length) return;               // 该三角无关键帧数据
                    if (state.frameIdx === fr) return;             // 播放头就在此帧，无需复制
                    km[state.frameIdx] = JSON.parse(JSON.stringify(src)); // 深拷贝框数据到播放头所在帧
                    writeData();
                    redraw();   // 播放头位置立即出现复制来的框
                    refreshTrackBtns();
                },
            },
        ]);
        // 点击菜单外任意处关闭
        document.addEventListener("mousedown", (e) => { if (_barMenuEl && !_barMenuEl.contains(e.target)) closeBarMenu(); });

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
            // 以滑块 content box 为基准（补偿可能的 border/padding），
            // 保证刻度坐标与浏览器定位 thumb 使用的坐标系完全一致
            const left = slider.offsetLeft + ((slider.offsetWidth - slider.clientWidth) / 2);
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
            bar.style.cssText = `position:absolute;left:${barLeft}px;top:calc(50% - 2px);width:${Math.max(4, barW)}px;height:4px;border-radius:2px;background:#5f5f5f;`;
            frag.appendChild(bar);
            // 关键帧标记：仅显示当前分类时只画当前轨道三角，否则画全部轨道（各自轨道色）。
            // 同一帧被多个分类标记时，三角按层上下排列（每层 13px），避免互相遮挡
            if (nf > 0) {
                const kfsAll = state.manualKeyframes || {};
                const tierAt = {}; // fr -> 该帧已占用的层号
                const tids = _solo ? [state.trackId] : Object.keys(kfsAll).map(Number).sort((a, b) => a - b);
                tids.forEach(tid => {
                    const kfs = kfsAll[tid] || {};
                    const color = TRACK_COLORS[(tid-1) % TRACK_COLORS.length];
                Object.keys(kfs).map(Number).forEach(fr => {
                    const tier = tierAt[fr] || 0;
                    tierAt[fr] = tier + 1;
                    if (!Array.isArray(kfs[fr]) || !kfs[fr].length) return;
                    // 点击热区仅包住三角（16×16，四周留少量余量），不向下延伸到播放条区域，
                    // 避免误触发：三角下方仍走播放条的拖拽换帧判定
                    const hit = document.createElement("div");
                    hit.style.cssText = `position:absolute;left:${posX(fr) - 8}px;top:${tier * 13}px;width:16px;height:16px;display:flex;align-items:center;justify-content:center;cursor:pointer;pointer-events:auto;`;
                    hit.title = `第 ${fr} 帧关键帧（点击跳转 / 拖动移动 / 右键菜单）`;
                    // 按住左键开始拖动：移动中播放头与画面跟随，松手落位并持久化
                    hit.addEventListener("mousedown", (e) => {
                        if (e.button !== 0) return;
                        e.preventDefault();
                        e.stopPropagation();
                        _kfDrag = { trackId: tid, from: fr, cur: fr };
                    });
                    // 扩展（一键扩展复制到首尾）的关键帧用小一号三角，与手画的关键帧区分
                    const ext = !!(state.extKf && state.extKf[tid + ":" + fr]);
                    const mark = document.createElementNS("http://www.w3.org/2000/svg", "svg");
                    mark.setAttribute("width", ext ? "11" : "14");
                    mark.setAttribute("height", ext ? "9" : "12");
                    mark.setAttribute("viewBox", ext ? "0 0 11 9" : "0 0 14 12");
                    mark.style.cssText = "display:block;flex-shrink:0;margin-top:1px;";
                    // 高亮规则：播放头停在关键帧帧号上（三角形正下方）→ 白边高亮；
                    // 鼠标悬停 → 同样高亮；两者都不满足 → 纯色无边框。
                    // showFrame → redraw → drawKfBar 会随播放头移动自动刷新
                    const active = fr === state.frameIdx;
                    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
                    path.setAttribute("d", ext ? "M1 1 L10 1 L5.5 8 Z" : "M1 1 L13 1 L7 11 Z");
                    path.setAttribute("fill", color);
                    path.setAttribute("stroke", "#ffffff");
                    path.setAttribute("stroke-width", active ? "1.5" : "0");
                    path.setAttribute("stroke-linejoin", "round");
                    if (active) mark.style.filter = "drop-shadow(0 0 3px #ffffff)";
                    mark.appendChild(path);
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
                    // 右键三角：弹出关键帧菜单（删除 / 复制到播放头）
                    hit.addEventListener("contextmenu", (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        showKfMenu(e.clientX, e.clientY, fr, tid);
                    });
                    frag.appendChild(hit);
                });
                });
            }
            kfBar.innerHTML = "";
            kfBar.appendChild(frag);
        };

        // ---- 帧切换 ----
        // 自动清空检测区/排除区框（切换样本帧或载入新视频时，避免旧框残留/继续限域）
        const clearRegions = () => {
            if (state.detectRegions.length || state.excludeRegions.length) {
                state.detectRegions = [];
                state.excludeRegions = [];
                writeData();
            }
            // 手工跟踪：载入新视频时同样清空各轨道关键帧框，避免旧视频框残留
            if (state.manualKeyframes && Object.keys(state.manualKeyframes).length) {
                state.manualKeyframes = {};
                writeData();
                redraw();
                refreshTrackBtns();
            }
        };
        const showFrame = (i) => {
            const nf = state.frames.length;
            if (!nf) return;
            // 0..N-1 索引语义：v=0 首帧，v=N-1 末帧（12 帧显示 0-11）
            i = Math.max(0, Math.min(nf - 1, i));
            // 跳帧预览不做任何清空：检测区/排除区框是跨帧全局的，画框后拖动播放头应保持；
            // 清空只发生在「载入新视频」时（见 onExecuted 里的 video_id 判断）
            state.frameIdx = i;
            state.image = state.frames[i];
            state.brushActive = false; state.brushPts = [];
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
        canvasWrapper.addEventListener('pointerdown', (e) => {
            stopPlay();
            if (!state.image) return;
            if (state.mode === 'off') return;   // 关：禁用框选
            // 右键框体删除已移除：删除关键帧统一走「右键播放条三角 → 删除关键帧」，
            // 避免两处删除入口（画布右键按框删除 / 播放条按帧删除）语义混淆
            if (e.button !== 0) return;
            try { canvasWrapper.setPointerCapture(e.pointerId); } catch (_) {}
            const c = toImg(e);
            // 涂抹工具（仅手工跟踪模式）：开始记录轨迹
            if (state.mode === "manual" && state.tool === "brush") {
                const L = calcLayout();
                state.brushActive = true;
                state.brushPts = [{ x: Math.max(0, Math.min(1, c.x / L.imgW)), y: Math.max(0, Math.min(1, c.y / L.imgH)) }];
                redraw();
                return;
            }
            state.drawing = { x1: c.x, y1: c.y, x2: c.x, y2: c.y };
        });

        canvasWrapper.addEventListener('pointermove', (e) => {
            // 涂抹中：按 8px（图像像素）距离节流追加轨迹点
            if (state.brushActive) {
                const c = toImg(e);
                const L = calcLayout();
                const last = state.brushPts[state.brushPts.length - 1];
                const nx = Math.max(0, Math.min(1, c.x / L.imgW)), ny = Math.max(0, Math.min(1, c.y / L.imgH));
                if (!last || Math.hypot((nx - last.x) * L.imgW, (ny - last.y) * L.imgH) >= 8) {
                    state.brushPts.push({ x: nx, y: ny });
                    redraw();
                }
                return;
            }
            if (!state.drawing) return;
            const c = toImg(e);
            state.drawing.x2 = c.x;
            state.drawing.y2 = c.y;
            scheduleRedraw();
        });

        canvasWrapper.addEventListener('pointerup', (e) => {
            // 涂抹结束：轨迹闭合成多边形 → 按弧长重采样 24 点 → 存为当前帧关键帧
            if (state.brushActive) {
                state.brushActive = false;
                const pts = state.brushPts;
                state.brushPts = [];
                if (state.mode !== "manual" || pts.length < 3) { redraw(); return; }
                const poly = resamplePoly(pts, 24);
                const r = { poly };
                const tid = state.trackId;
                if (!state.manualKeyframes[tid]) state.manualKeyframes[tid] = {};
                state.manualKeyframes[tid][state.frameIdx] = [r];
                writeData();
                redraw();
                refreshTrackBtns();
                return;
            }
            if (!state.drawing) return;
            const c = toImg(e);
            state.drawing.x2 = c.x;
            state.drawing.y2 = c.y;
            const L = calcLayout();
            const r = {
                x1: Math.max(0, Math.min(1, Math.min(state.drawing.x1, state.drawing.x2) / L.imgW)),
                y1: Math.max(0, Math.min(1, Math.min(state.drawing.y1, state.drawing.y2) / L.imgH)),
                x2: Math.max(0, Math.min(1, Math.max(state.drawing.x1, state.drawing.x2) / L.imgW)),
                y2: Math.max(0, Math.min(1, Math.max(state.drawing.y1, state.drawing.y2) / L.imgH)),
            };
            state.drawing = null;
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

        canvasWrapper.addEventListener('contextmenu', (e) => e.preventDefault());

        // 滚轮事件转发给 ComfyUI 画布（预览区不拦截滚轮，保持画布缩放）
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

        // ---- 数据回写（{detect:[...], exclude:[...]}）----
        const writeData = () => {
            if (!dataWidget) return;
            dataWidget.value = JSON.stringify({ detect: state.detectRegions, exclude: state.excludeRegions, mode: state.mode, manual: state.manualKeyframes, sample_idx: state.sampleIdx || [] });
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
                if (Array.isArray(d.detect)) state.detectRegions = d.detect.filter(v => v && typeof v.x1 === 'number');
                if (Array.isArray(d.exclude)) state.excludeRegions = d.exclude.filter(v => v && typeof v.x1 === 'number');
                // 仅手工跟踪模式（旧版模式下拉已隐藏取消）
                state.mode = 'manual';
                state.manualKeyframes = (d.manual && typeof d.manual === 'object') ? d.manual : {};
                if (state.image) { try { syncSize(); } catch (e) {} redraw(); }
            } catch (e) {}
        };
        readData();

        // ---- 开关：控制框选可用性 ----
        const applySwitch = () => {
            stopPlay();
            const m = state.mode;
            const active = m !== "off";
            overlay.style.display = active ? "none" : "";
            hint.innerText = (m === "filter") ? "左键框选 (检测区)"
                           : (m === "manual") ? "左键画框 / 涂抹（关键帧）" : "未启用";
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

        // ---- 旧工作流迁移：节点控件历经多轮精简（threshold / tracking /
        // max_miss_frames / mask_expand_x / mask_expand_y 均已删除，model_name 隐藏
        // 占位），按位赋值会整体错位导致 regions_data（手工标注）丢失。这里在
        // onConfigure（控件值已按位套用后）定位 regions_data 并按名回填：
        //   最老 [model, threshold, tracking, max_miss, temporal, ex, ey, regions(, DOM?)]
        //   中间 [model, temporal, ex, ey, regions(, DOM?)]
        //   当前 [model, temporal, regions(, DOM?)]
        chainCallback(node, "onConfigure", function () {
            try {
                const vals = this.widgets_values;
                if (!Array.isArray(vals)) return;
                // regions_data 是唯一的 JSON 字符串，以其位置判定格式
                let ri = vals.findIndex(v => typeof v === 'string' && v.length > 2 && v.indexOf('"manual"') >= 0);
                if (ri < 0) {
                    // 空标注兜底：按长度特征定位
                    if (vals.length === 8 || vals.length === 9) ri = 7;
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
                // temporal_dilate 与 regions_data 之间隔 0 个值（当前）或 2 个值（旧格式 ex/ey）
                setW('temporal_dilate', (ri >= 4 ? (Number(vals[ri - 3]) || 0) : (Number(vals[1]) || 0)));
                setW('regions_data', typeof vals[ri] === 'string' ? vals[ri] : '');
                try { readData(); } catch (e) {}   // 重映射后同步视窗标注
            } catch (e) {}
        });

        // ---- 接收预览帧（后端 execute 发来的视频采样帧）----
        chainCallback(node, "onExecuted", function (message) {
            stopPlay();
            hideProgress();
            const pv = (Array.isArray(message.preview) ? message.preview[0] : message.preview) || {};
            if (!pv || !pv.preview_str) return;
            try {
            const pd0 = JSON.parse(pv.preview_str);
                const pd = (pd0 && pd0.frames) ? pd0.frames : pd0;
                if (pd0 && pd0.sample_idx) state.sampleIdx = pd0.sample_idx;
                if (pd && pd.length > 0) {
                    // 载入「新视频」时才清空区域框：用后端下发的 video_id（视频特征哈希）判断，
                    // 仅当源视频变化时清理；排队/快捷键 D 重复执行同一视频不清，保留已画标注
                    const newKey = (pd0 && pd0.video_id) ? pd0.video_id : (pd[0] ? String(pd[0]).split(/[/\\?]/).pop() : '');
                    if (newKey && state.srcKey && newKey !== state.srcKey) clearRegions();
                    if (newKey) state.srcKey = newKey;
                    state.frames = [];
                    state.frameIdx = 0;
                    state.image = null;
                    pd.forEach((p, i) => {
                        const img = new Image();
                        img.onload = () => {
                            state.frames[i] = img;
                            if (i === 0) { state.image = img; readData(); syncSize(); redraw(); }
                        };
                        img.src = getRealURL(p);
                    });
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
        const MIN_PREVIEW_H = 220;
        // 最小宽度按手工跟踪模式整行标签不被裁切计算（一键扩展/显示全部颜色关键帧同步加大到 18px 后放宽）：
        // 笔记本图标(~24) + 点击加载视频⏎18px(~150) + 框选/手绘(~85) + 轨道1-8(20px框×8+间隙6×7+margin10=212) + 一键扩展18px(~92) + 显示全部颜色关键帧18px(~182) + 垃圾桶×2(50) + 工具栏内边距(12) ≈ 807，留缓冲取 815
        const MIN_NODE_W = 815;
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

            <h4>手工跟踪</h4>
            <ul>
                <li>1、轨道 1-8 各自颜色不同，先选轨道再画框；可选「方框」或「涂抹（手绘）」画目标轮廓</li>
                <li>2、右键播放条上的三角可删除/跳转该关键帧（画布上右键框体不再删除）</li>
                <li>3、在某一颜色分类，在播放头不同进度位置画框，自动跟踪过渡。若当前颜色分类，只画一个框，则代表全帧遮罩。</li>
                <li>4、播放条上方三角标记定位关键帧，点击三角播放头即跳转到该帧</li>
                <li>5、切换不同颜色分类，可跟踪多个目标</li>
                <li>6、「一键扩展」把当前颜色分类的最左/最右关键帧分别复制到第一帧和最后一帧，遮罩覆盖视频全程</li>
            </ul>

            <h4>参数（手工跟踪）</h4>
            <ul>
                <li><b>时域膨胀</b>：0=关闭（建议 3~5）。把每帧遮罩与其前后若干帧合并，兜底关键帧之间遗漏的帧。设太大会让移动快的水印拖出轨迹带。</li>
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
    }
});

// 水印检测节点参数标签双语（中文 / English），不改后端参数名（工作流序列化不受影响）
const WM_LABEL_MAP = [
    ["model_name", "模型", "Model"],
    ["regions_data", "区域数据", "Regions data"],
    ["temporal_dilate", "时域膨胀", "Temporal dilate"],
];
function wm_applyLabels(node) {
    if (!node || !node.widgets) return;
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

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

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

app.registerExtension({
    name: "Comfy.Xiaozhuguang.PointsEditor",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        const nodeName = nodeData.name;
        if (nodeName === "XiaozhuguangPointsEditor") {
            chainCallback(nodeType.prototype, "onNodeCreated", function() {
                const container = document.createElement("div");
                container.style.cssText = "position: relative; width: 100%; height: 100%; background: #0f1011; overflow: hidden; box-sizing: border-box; border-radius: 4px; margin: 0; padding: 0; display: flex; flex-direction: column;";

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
                tracker.style.cssText = "flex: 0 0 32px; width: 100%; background: #222; display: none; align-items: center; justify-content: space-between; padding: 0 8px; box-sizing: border-box; border-top: 1px solid #333; gap: 2px;";

                const frameInfo = document.createElement("div");
                frameInfo.style.cssText = "color: #ccc; font-family: monospace; font-size: 12px; min-width: 40px; text-align: center; user-select: none;";
                frameInfo.innerText = "0/0";

                const slider = document.createElement("input");
                slider.type = "range";
                slider.min = "0";
                slider.max = "0";
                slider.value = "0";
                slider.step = "1";
                slider.style.cssText = "flex: 1; height: 4px; cursor: pointer; accent-color: #e8c547;";

                tracker.appendChild(frameInfo);
                tracker.appendChild(slider);
                container.appendChild(tracker);

                slider.addEventListener("input", (e) => {
                    const frameIndex = parseInt(e.target.value);
                    this.canvasWidget.frameIndex = frameIndex;
                    this.canvasWidget.frameInfo.innerText = `${frameIndex + 1}/${this.canvasWidget.previewFrames.length}`;
                    this.updateWidgetValue();

                    const img = new Image();
                    img.onload = () => {
                        this.canvasWidget.image = img;
                        canvas.width = img.width;
                        canvas.height = img.height;
                        this.redrawCanvas();
                    };
                    img.src = getRealURL(this.canvasWidget.previewFrames[frameIndex]);
                });

                this.canvasWidget = {
                    canvas: canvas,
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
                };

                const widget = this.addDOMWidget("canvas", "points_editor", container);
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
                    if (infoWidget && infoWidget.value) {
                        try {
                            const info = JSON.parse(infoWidget.value);
                            if (Array.isArray(info.positive_coords)) {
                                this.canvasWidget.positivePoints = info.positive_coords;
                            }
                            if (Array.isArray(info.negative_coords)) {
                                this.canvasWidget.negativePoints = info.negative_coords;
                            }
                            if (Array.isArray(info.bbox)) {
                                this.canvasWidget.bboxes = info.bbox;
                            }
                            if (typeof info.frame_index === 'number' && this.canvasWidget.slider) {
                                this.canvasWidget.frameIndex = info.frame_index;
                                this.canvasWidget.slider.value = info.frame_index;
                                this.canvasWidget.frameInfo.innerText = `${info.frame_index + 1}/${this.canvasWidget.previewFrames.length}`;
                            }
                            this.redrawCanvas();
                        } catch (e) {}
                    }
                }, 1)

                widget.computeSize = (width) => {
                    const nodeHeight = this.size ? this.size[1] : 500;
                    const widgetHeight = Math.max(245, nodeHeight - 135);
                    return [width, widgetHeight];
                };

                chainCallback(this, "onResize", function(size) {
                    const containerHeight = Math.max(245, size[1] - 150);
                    container.style.height = containerHeight + "px";
                });

                chainCallback(this, "onDrawForeground", function(ctx) {
                    const containerHeight = Math.max(245, this.size[1] - 150);
                    if (container.style.height !== containerHeight + "px") {
                        container.style.height = containerHeight + "px";
                    }
                });

                chainCallback(this, "onExecuted", function(message) {
                    if (message.preview && message.preview[0]) {
                        const { preview_str, is_init } = message.preview[0];
                        const previewData = JSON.parse(preview_str);
                        this.canvasWidget.previewFrames = previewData;
                        if (is_init) {
                            if (this.canvasWidget.frameIndex >= previewData.length - 1) {
                                this.canvasWidget.frameIndex = 0;
                                this.restoreState({ positivePoints: [], negativePoints: [], bboxes: [] });
                                this.updateWidgetValue();
                                this.canvasWidget.history = [];
                                this.canvasWidget.historyIndex = -1;
                                this.updateUndoRedoUI();
                            }
                        }
                        if (previewData.length > 1) {
                            this.canvasWidget.tracker.style.display = "flex";
                            slider.max = previewData.length - 1;
                            slider.value = this.canvasWidget.frameIndex;
                            this.canvasWidget.frameInfo.innerText = `${this.canvasWidget.frameIndex + 1}/${previewData.length}`;
                        } else {
                            this.canvasWidget.tracker.style.display = "none";
                        }

                        const img = new Image();
                        img.onload = () => {
                            this.canvasWidget.image = img;
                            canvas.width = img.width;
                            canvas.height = img.height;
                            this.redrawCanvas();
                        };

                        if (previewData?.length > 0) {
                            if (this.canvasWidget.frameIndex >= previewData.length) {
                                this.canvasWidget.frameIndex = 0;
                                slider.value = 0;
                            }
                            img.src = getRealURL(previewData[this.canvasWidget.frameIndex]);
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
                    const info_widget = this._infoWidget;
                    if (info_widget) {
                        info_widget.value = image ? JSON.stringify({
                            positive_coords: positivePoints,
                            negative_coords: negativePoints,
                            bbox: bboxes,
                            frame_index: frameIndex
                        }) : '';
                    }
                }

                // 坐标转换：屏幕像素 → 图像坐标（考虑 object-fit:contain 的留白）
                const getCoords = (e) => {
                    const rect = canvas.getBoundingClientRect();
                    const imgW = canvas.width;
                    const imgH = canvas.height;
                    const dispW = rect.width;
                    const dispH = rect.height;
                    const imgRatio = imgW / imgH;
                    const dispRatio = dispW / dispH;
                    let drawW, drawH, offsetX, offsetY;
                    if (imgRatio > dispRatio) {
                        // 图像比例更宽：宽度撑满，上下留白
                        drawW = dispW;
                        drawH = dispW / imgRatio;
                        offsetX = 0;
                        offsetY = (dispH - drawH) / 2;
                    } else {
                        // 图像比例更高：高度撑满，左右留白
                        drawH = dispH;
                        drawW = dispH * imgRatio;
                        offsetX = (dispW - drawW) / 2;
                        offsetY = 0;
                    }
                    const scaleX = imgW / drawW;
                    const scaleY = imgH / drawH;
                    return {
                        x: (e.clientX - rect.left - offsetX) * scaleX,
                        y: (e.clientY - rect.top - offsetY) * scaleY
                    };
                };

                // 修复 1: 查找附近的可交互项目
                const findHitItem = (coords, image) => {
                    if (!image) return null;
                    const w = this.canvasWidget;
                    const pointRadius = Math.max(4, Math.min(canvas.width, canvas.height) * 0.015);
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

                canvas.addEventListener('mousedown', (e) => {
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
                                w.isDrawingBox = true;
                                w.currentBox = { x: coords.x, y: coords.y, w: 0, h: 0 };
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

                canvas.addEventListener('mousemove', (e) => {
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
                        this.redrawCanvas();
                        return;
                    }

                    const { mode, isDrawingBox, currentBox } = w;
                    // 修复 1: 悬停检测
                    w.hoveredItem = findHitItem(coords, w.image);
                    canvas.style.cursor = w.hoveredItem ? 'pointer' : 'crosshair';

                    if (mode === 'box' && isDrawingBox && currentBox) {
                        currentBox.w = coords.x - currentBox.x;
                        currentBox.h = coords.y - currentBox.y;
                        this.redrawCanvas();
                    }
                });

                canvas.addEventListener('mouseup', (e) => {
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

                canvas.addEventListener('contextmenu', (e) => {
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

                this.redrawCanvas();

                const nodeWidth = Math.max(420, this.size[0] || 420);
                const nodeHeight = 540;
                this.setSize([nodeWidth, nodeHeight]);

                this.updateUndoRedoUI();
            });

            nodeType.prototype.redrawCanvas = function() {
                const { canvas, ctx, image, positivePoints, negativePoints, bboxes, currentBox, mode } = this.canvasWidget;

                ctx.clearRect(0, 0, canvas.width, canvas.height);

                let pointSize = Math.max(2, Math.min(canvas.width, canvas.height) * 0.008);

                if (image) {
                    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
                } else {
                    ctx.fillStyle = "transparent";
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                    ctx.fillStyle = "#ddd";
                    ctx.font = "34px sans-serif";
                    ctx.textAlign = "center";
                    ctx.fillText("🖼️", canvas.width / 2, canvas.height / 2 - 50);
                    ctx.font = "20px sans-serif";
                    ctx.fillText("从您自己的图像或视频开始", canvas.width / 2, canvas.height / 2 + 10);
                    const tips = [
                        "左键：加正面点 | 右键：加负面点",
                        "左键拖动：画框  | 右键：删点/框",
                        "Shift+左键拖拽：移动 | Delete：删最后",
                        "Ctrl+Z：撤销 | Ctrl+Shift+Z：重做",
                    ];
                    tips.forEach((t, i) => {
                        ctx.font = "14px sans-serif";
                        ctx.fillText(t, canvas.width / 2, canvas.height / 2 + 50 + i * 22);
                    });
                    return;
                }

                // 绘制边界框
                ctx.lineWidth = 2;
                for (const box of bboxes) {
                    const hit = this.canvasWidget.hoveredItem;
                    const isHovered = hit && hit.type === 'box' && bboxes[hit.index] === box;
                    ctx.strokeStyle = isHovered ? "#66bbff" : "#3399ff";
                    ctx.fillStyle = isHovered ? "rgba(102, 187, 255, 0.2)" : "rgba(51, 153, 255, 0.1)";
                    ctx.lineWidth = isHovered ? 3 : 2;
                    ctx.strokeRect(box.x, box.y, box.w, box.h);
                    ctx.fillRect(box.x, box.y, box.w, box.h);
                }

                if (currentBox) {
                    ctx.strokeStyle = "#0ff";
                    ctx.lineWidth = 2;
                    ctx.setLineDash([5, 5]);
                    ctx.strokeRect(currentBox.x, currentBox.y, currentBox.w, currentBox.h);
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
                    ctx.arc(point.x, point.y, pointSize, 0, 2 * Math.PI);
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
                    ctx.arc(point.x, point.y, pointSize, 0, 2 * Math.PI);
                    ctx.fill();
                    ctx.stroke();
                }
            };
        }
    }
})

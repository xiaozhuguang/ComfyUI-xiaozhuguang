import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
    downloadLazyImage,
    downloadLazyJpg,
} from "./xzg_save_utils.js";

const XZG_IMAGE_SAVE_TYPE = "XiaozhuguangImageSave";
const IMAGE_MARGIN = 6;

// ═══════════════════════════════════════════════════════════════════
// 全局右键菜单 + 三层拦截（window contextmenu / processMouseDown / processContextMenu）
// 不依赖 widget 类的内部方法，确保稳定可用
// ═══════════════════════════════════════════════════════════════════

// 全局共享的右键菜单 DOM
let _xzgImgSaveCtxMenu = null;
let _xzgImgSaveCtxCurrentWidget = null;

function _xzgImgSaveEnsureCtxMenu() {
    if (_xzgImgSaveCtxMenu) return _xzgImgSaveCtxMenu;
    const menuItemStyle = "padding: 6px 16px; color: #ddd; cursor: pointer; font-size: 12px; white-space: nowrap;";
    const menu = document.createElement("div");
    menu.style.cssText =
        "position: fixed; z-index: 99999; background: #2a2a2a; border: 1px solid #555; border-radius: 4px; box-shadow: 0 4px 12px rgba(0,0,0,0.5); display: none; min-width: 120px; padding: 4px 0;";

    // PNG 保存
    const pngItem = document.createElement("div");
    pngItem.style.cssText = menuItemStyle;
    pngItem.innerHTML = `<span style="color:#4CAF50;">PNG保存</span>`;
    pngItem.addEventListener("mouseenter", () => { pngItem.style.background = "#3a3a3a"; });
    pngItem.addEventListener("mouseleave", () => { pngItem.style.background = ""; });
    pngItem.addEventListener("click", () => {
        const w = _xzgImgSaveCtxCurrentWidget;
        _xzgImgSaveHideCtxMenu();
        if (!w) return;
        const imgs = w._value?.images || [];
        const cur = imgs[w.currentIndex] || imgs[0];
        if (cur) downloadImage(cur);
    });
    menu.appendChild(pngItem);

    // JPG 保存
    const jpgItem = document.createElement("div");
    jpgItem.style.cssText = menuItemStyle;
    jpgItem.innerHTML = `<span style="color:#4CAF50;">JPG保存</span>`;
    jpgItem.addEventListener("mouseenter", () => { jpgItem.style.background = "#3a3a3a"; });
    jpgItem.addEventListener("mouseleave", () => { jpgItem.style.background = ""; });
    jpgItem.addEventListener("click", () => {
        const w = _xzgImgSaveCtxCurrentWidget;
        _xzgImgSaveHideCtxMenu();
        if (!w) return;
        const imgs = w._value?.images || [];
        const cur = imgs[w.currentIndex] || imgs[0];
        if (cur) downloadJpgImage(cur);
    });
    menu.appendChild(jpgItem);

    document.body.appendChild(menu);

    // 点击其他地方关闭菜单
    const dismiss = (e) => {
        if (menu.style.display === "block" && !menu.contains(e.target)) {
            _xzgImgSaveHideCtxMenu();
        }
    };
    window.addEventListener("mousedown", dismiss, true);
    window.addEventListener("contextmenu", dismiss, true);

    _xzgImgSaveCtxMenu = menu;
    return menu;
}

function _xzgImgSaveShowCtxMenu(widget, x, y) {
    _xzgImgSaveCtxCurrentWidget = widget;
    const menu = _xzgImgSaveEnsureCtxMenu();
    menu.style.left = x + "px";
    menu.style.top = y + "px";
    menu.style.display = "block";
    requestAnimationFrame(() => {
        const rect = menu.getBoundingClientRect();
        if (rect.right > window.innerWidth) menu.style.left = (x - rect.width) + "px";
        if (rect.bottom > window.innerHeight) menu.style.top = (y - rect.height) + "px";
    });
}

function _xzgImgSaveHideCtxMenu() {
    if (_xzgImgSaveCtxMenu) _xzgImgSaveCtxMenu.style.display = "none";
    _xzgImgSaveCtxCurrentWidget = null;
}

// 检查点击是否在图像保存节点的图像区域内
function _xzgImgSaveIsInImageArea(canvasX, canvasY) {
    let nd = null;
    const canvas = app.canvas;
    if (canvas.getNodeAtPosition) nd = canvas.getNodeAtPosition(canvasX, canvasY);
    else if (canvas.getNodeAtPos) nd = canvas.getNodeAtPos(canvasX, canvasY);
    else if (canvas.graph?.getNodeOnPos) nd = canvas.graph.getNodeOnPos(canvasX, canvasY);

    if (nd?.type !== XZG_IMAGE_SAVE_TYPE) return null;
    const w = nd.canvasWidget;
    if (!w) return null;
    const startY = w._startY ?? 0;
    let imgDrawY = w._imageDrawY;
    let imgDrawH = w._imageDrawH;

    // 后备方案：如果图像区域未被正确设置（可能是首次绘制或旧代码），手动估算
    if (imgDrawH === undefined || imgDrawH === null || imgDrawH <= 0) {
        const hasBtnRow = nd._xzgFormatWidget || nd._xzgLagWidget || nd._xzgModeWidget;
        const btnRowH = hasBtnRow ? 19 : 0;
        imgDrawY = btnRowH; // 相对于 startY 的偏移
        imgDrawH = nd.size[1] - startY - btnRowH - IMAGE_MARGIN;
    }

    if (!imgDrawH || imgDrawH <= 0) return null;
    const localY = canvasY - nd.pos[1] - startY;
    if (localY >= imgDrawY && localY <= imgDrawY + imgDrawH) {
        return w;
    }
    return null;
}

// 安装三层拦截
function _xzgImgSaveInstallHooks(retryCount = 0) {
    const canvasEl = app.canvas?.canvas;
    if (!canvasEl) {
        if (retryCount < 60) {
            setTimeout(() => _xzgImgSaveInstallHooks(retryCount + 1), 100);
        }
        return;
    }
    if (window._xzgImgSaveHooksInstalled) return;
    window._xzgImgSaveHooksInstalled = true;

    // 1. window 捕获阶段拦截 contextmenu（优先级最高）
    window.addEventListener('contextmenu', (e) => {
        const target = e.target;
        if (target !== canvasEl && !canvasEl.contains?.(target)) return;

        const canvas = app.canvas;
        const rect = canvasEl.getBoundingClientRect();
        let x, y;
        if (canvas.convertEventToCanvasCoordinates) {
            try {
                const p = canvas.convertEventToCanvasCoordinates(e);
                if (p) { x = p[0]; y = p[1]; }
            } catch (_) {}
        }
        if (x === undefined || y === undefined) {
            x = (e.clientX - rect.left) / canvas.ds.scale - canvas.ds.offset[0];
            y = (e.clientY - rect.top) / canvas.ds.scale - canvas.ds.offset[1];
        }

        const widget = _xzgImgSaveIsInImageArea(x, y);
        if (widget) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            _xzgImgSaveShowCtxMenu(widget, e.clientX, e.clientY);
            return false;
        }
    }, true);

    // 2. hook processMouseDown
    let LGraphCanvas = null;
    try { if (typeof LGraphCanvas !== 'undefined' && LGraphCanvas?.prototype) LGraphCanvas = LGraphCanvas; } catch (_) {}
    if (!LGraphCanvas) LGraphCanvas = window.LGraphCanvas || null;
    if (!LGraphCanvas && window.LiteGraph?.LGraphCanvas) LGraphCanvas = window.LiteGraph.LGraphCanvas;
    if (!LGraphCanvas && app.canvas?.constructor) LGraphCanvas = app.canvas.constructor;

    if (LGraphCanvas?.prototype?.processMouseDown && !LGraphCanvas.prototype._xzgImgSaveMouseDownPatched) {
        LGraphCanvas.prototype._xzgImgSaveMouseDownPatched = true;
        const origProcessMouseDown = LGraphCanvas.prototype.processMouseDown;
        LGraphCanvas.prototype.processMouseDown = function (e) {
            if (e.button === 2) {
                const cx = e.canvasX ?? e.x ?? 0;
                const cy = e.canvasY ?? e.y ?? 0;
                const widget = _xzgImgSaveIsInImageArea(cx, cy);
                if (widget) {
                    e.preventDefault?.();
                    e.stopPropagation?.();
                    _xzgImgSaveShowCtxMenu(widget, e.clientX, e.clientY);
                    return true;
                }
            }
            return origProcessMouseDown.apply(this, arguments);
        };
    }

    // 3. hook processContextMenu（新版 LiteGraph）
    if (LGraphCanvas?.prototype?.processContextMenu && !LGraphCanvas.prototype._xzgImgSaveCtxMenuPatched) {
        LGraphCanvas.prototype._xzgImgSaveCtxMenuPatched = true;
        const origProcessContextMenu = LGraphCanvas.prototype.processContextMenu;
        LGraphCanvas.prototype.processContextMenu = function (node, e) {
            if (node?.type === XZG_IMAGE_SAVE_TYPE) {
                const cx = e?.canvasX ?? e?.x ?? 0;
                const cy = e?.canvasY ?? e?.y ?? 0;
                const widget = _xzgImgSaveIsInImageArea(cx, cy);
                if (widget) {
                    _xzgImgSaveShowCtxMenu(widget, e?.clientX ?? 0, e?.clientY ?? 0);
                    return;
                }
            }
            return origProcessContextMenu.apply(this, arguments);
        };
    }

    console.log("[小珠光图像保存] 右键菜单拦截已安装");
}

// 启动 hook 安装
_xzgImgSaveInstallHooks();


function imageUrl(data) {
    return api.apiURL(
        `/view?filename=${encodeURIComponent(data.filename)}&type=${data.type}&subfolder=${data.subfolder}${app.getPreviewFormatParam()}${app.getRandParam()}`
    );
}

// PNG 保存 → 统一走懒编码 + File System Access API（首次桌面，二次上次路径）
const downloadImage = downloadLazyImage;
// JPG 保存 → 直接复用压缩预览图 + File System Access API
const downloadJpgImage = downloadLazyJpg;


// ============ 自定义 Widget ============
class XzgImageSaveWidget {
    constructor(name, node) {
        this.type = "custom";
        this.name = name;
        this.node = node;
        this.hitAreas = {};
        this._value = { images: [] };
        this.currentIndex = 0;
        this.gridMode = false;
        this._mousePos = null;
        this._btnFade = 0;
        this._lastClickT = 0;
        this._lastClickPos = null;
        this._imageDrawY = 0;
        this._imageDrawH = 0;
    }

    set value(v) {
        let cleaned;
        if (Array.isArray(v)) {
            cleaned = v.map((d, i) => {
                if (!d || typeof d === "string") {
                    d = { url: d, name: String(i + 1), selected: true };
                }
                return d;
            });
        } else {
            cleaned = (v && v.images) || [];
        }
        this._value.images = cleaned;
        if (this.currentIndex >= cleaned.length) this.currentIndex = 0;
    }

    get value() {
        return this._value;
    }

    _ensureImg(imgData) {
        if (!imgData) return;
        if (imgData.img && imgData.img.naturalWidth) return;
        if (imgData._loading) return;
        imgData._loading = true;
        const newImg = new Image();
        newImg.onload = () => {
            this.node.setDirtyCanvas(true, true);
        };
        newImg.src = imgData.url;
        imgData.img = newImg;
    }

    draw(ctx, node, width, y) {
        this.hitAreas = {};
        this._startY = y;  // 记录图像控件起始 y，供 getWidgetOnPos 判断
        const btnH = 18;
        const imgs = this._value.images;

        // 按钮行：mode（左）+ save_format（中）+ reduce_lag（右），三等分
        const modeWidget = node._xzgModeWidget;
        const lagWidget = node._xzgLagWidget;
        const formatWidget = node._xzgFormatWidget;

        if (modeWidget || formatWidget || lagWidget) {
            const thirdW = width / 3;
            ctx.font = "11px Arial";
            ctx.textBaseline = "middle";

            // 最左侧：保存/预览 切换
            if (modeWidget) {
                ctx.textAlign = "center";
                const isSave = modeWidget.value !== "预览";
                ctx.fillStyle = isSave ? "#FFD700" : "#88ccff";
                ctx.fillText(modeWidget.value || "保存", thirdW / 2, y + btnH / 2);
                this.hitAreas["mode"] = {
                    bounds: [0, y, thirdW, btnH],
                    onDown: () => {
                        modeWidget.value = isSave ? "预览" : "保存";
                        node.setDirtyCanvas(true);
                    }
                };
            }

            // 中间：JPG/PNG 切换（预览模式下灰显且不可点击）
            if (formatWidget) {
                ctx.textAlign = "center";
                const isPreview = modeWidget && modeWidget.value === "预览";
                ctx.fillStyle = isPreview ? "#555555" : "#aaaaaa";
                ctx.fillText(formatWidget.value || "JPG", thirdW + thirdW / 2, y + btnH / 2);
                if (!isPreview) {
                    this.hitAreas["save_format"] = {
                        bounds: [thirdW, y, thirdW, btnH],
                        onDown: () => {
                            formatWidget.value = formatWidget.value === "JPG" ? "PNG" : "JPG";
                            node.setDirtyCanvas(true);
                        }
                    };
                }
            }

            // 最右侧：减小卡顿 / 极速流畅
            if (lagWidget) {
                ctx.textAlign = "center";
                ctx.fillStyle = "#aaaaaa";
                ctx.fillText(lagWidget.value ? "极致流畅" : "减小卡顿", thirdW * 2 + thirdW / 2, y + btnH / 2);
                this.hitAreas["reduce_lag"] = {
                    bounds: [thirdW * 2, y, thirdW, btnH],
                    onDown: () => { lagWidget.value = !lagWidget.value; node.setDirtyCanvas(true); }
                };
            }

            // 分隔竖杠 1px
            ctx.strokeStyle = "#aaaaaa";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(thirdW, y); ctx.lineTo(thirdW, y + btnH);
            ctx.moveTo(thirdW * 2, y); ctx.lineTo(thirdW * 2, y + btnH);
            ctx.stroke();

            y += btnH + 1;
        }

        // 记录图像区域位置（相对于节点内部的坐标）—— 即使没有图片也设置，用于右键检测
        this._imageDrawY = y - this._startY;
        this._imageDrawH = node.size[1] - y - IMAGE_MARGIN;

        if (!imgs.length) {
            return;
        }

        // 图像区域
        if (this.gridMode) {
            this._drawGrid(ctx, node, width, y, imgs);
        } else {
            this._drawSingle(ctx, node, width, y, imgs);
        }
    }

    _drawSingle(ctx, node, width, y, imgs) {
        const imgData = imgs[this.currentIndex];
        if (!imgData) return;
        this._ensureImg(imgData);

        const nodeHeight = node.size[1] - y - IMAGE_MARGIN;
        if (nodeHeight <= 0) return;
        const effW = width - IMAGE_MARGIN * 2;

        let destX = IMAGE_MARGIN, destY = y, targetW = effW, targetH = nodeHeight;
        const img = imgData.img;
        if (img && img.naturalWidth) {
            const natW = img.naturalWidth, natH = img.naturalHeight;
            const imageAspect = natW / natH;
            const widgetAspect = effW / nodeHeight;
            if (imageAspect > widgetAspect) {
                targetW = effW;
                targetH = effW / imageAspect;
            } else {
                targetH = nodeHeight;
                targetW = nodeHeight * imageAspect;
            }
            destX = IMAGE_MARGIN + (effW - targetW) / 2;
            destY = y + (nodeHeight - targetH) / 2;
            ctx.drawImage(img, destX, destY, targetW, targetH);
        }

        // 三等分判定：左 1/3 上一页、中 1/3 网格、右 1/3 下一页
        const drawW = (img && img.naturalWidth) ? targetW : effW;
        const drawX = (img && img.naturalWidth) ? destX : IMAGE_MARGIN;
        const imgLoaded = img && img.naturalWidth;
        const third = drawW / 3;
        const fifth2 = drawW / 5;

        if (imgLoaded && imgs.length > 1) {
            this.hitAreas["prev"] = {
                bounds: [drawX, y, third, nodeHeight],
                onDown: () => this._step(-1, node)
            };
            this.hitAreas["toggle_grid"] = {
                bounds: [drawX + third, y, third, nodeHeight],
                onDown: () => { this.gridMode = !this.gridMode; node.setDirtyCanvas(true, true); }
            };
            this.hitAreas["next"] = {
                bounds: [drawX + third * 2, y, third, nodeHeight],
                onDown: () => this._step(1, node)
            };
        }

        // 图标渐入
        if (imgLoaded && imgs.length > 1) {
            const inY = this._mousePos && this._mousePos[1] >= y && this._mousePos[1] <= y + nodeHeight;
            const inX = this._mousePos && this._mousePos[0] >= drawX && this._mousePos[0] <= drawX + drawW;
            const near = inY && inX;
            if (near) { this._btnFade = Math.min(1, this._btnFade + 0.1); }
            else { this._btnFade = 0; }
            if (this._btnFade > 0.01) {
                const a = this._btnFade;
                const iconY = y + nodeHeight - 12;
                const cx0 = drawX + fifth2 / 2;
                const cx1 = drawX + fifth2 * 2.5;
                const cx2 = drawX + fifth2 * 4.5;
                ctx.textBaseline = "middle";
                ctx.textAlign = "center";

                ctx.font = "16px Arial";
                ctx.fillStyle = `rgba(255,255,255,${a * 0.85})`;
                ctx.fillText("◀", cx0, iconY);

                ctx.font = "33px Arial";
                const ca = a * (this.gridMode ? 0.9 : 0.85);
                ctx.fillStyle = this.gridMode ? `rgba(136,204,255,${ca})` : `rgba(255,255,255,${ca})`;
                ctx.fillText("○", cx1, iconY);

                ctx.font = "16px Arial";
                ctx.fillStyle = `rgba(255,255,255,${a * 0.85})`;
                ctx.fillText("▶", cx2, iconY);
            }
        }
    }

    _drawGrid(ctx, node, width, y, imgs) {
        const gap = 2;
        const effW = width - IMAGE_MARGIN * 2;
        const nodeH = node.size[1] - y - IMAGE_MARGIN;
        let bestCell = 0, bestCols = 1;
        const maxCols = Math.max(1, Math.floor(effW / 30));
        for (let c = 1; c <= maxCols; c++) {
            const rows = Math.ceil(imgs.length / c);
            const cellW = (effW - gap * (c - 1)) / c;
            const cellH = (nodeH - gap * (rows - 1)) / rows;
            const cell = Math.min(cellW, cellH);
            if (cell > bestCell) { bestCell = cell; bestCols = c; }
        }
        const cell = Math.max(20, bestCell);
        const cols = bestCols;
        const rows = Math.ceil(imgs.length / cols);
        const gridW = cols * cell + (cols - 1) * gap;
        const gridH = rows * cell + (rows - 1) * gap;
        const startX = IMAGE_MARGIN + (effW - gridW) / 2;
        const startY = y + (nodeH - gridH) / 2;
        let cx = startX, cy = startY;

        for (let i = 0; i < imgs.length; i++) {
            const imgData = imgs[i];
            this._ensureImg(imgData);
            const img = imgData.img;

            ctx.fillStyle = "rgba(128,128,128,0.4)";
            ctx.fillRect(cx, cy, cell, cell);

            if (img && img.naturalWidth) {
                const ia = img.naturalWidth / img.naturalHeight;
                let tw = cell, th = cell;
                if (ia > 1) th = cell / ia; else tw = cell * ia;
                ctx.drawImage(img, cx + (cell - tw) / 2, cy + (cell - th) / 2, tw, th);
            }

            ctx.fillStyle = "rgba(255,255,255,0.8)";
            ctx.font = "11px Arial";
            ctx.textAlign = "left";
            ctx.textBaseline = "top";
            ctx.fillText(String(i + 1), cx + 3, cy + 2);

            if (img && img.naturalWidth) {
                this.hitAreas["grid_" + i] = {
                    bounds: [cx, cy, cell, cell],
                    index: i,
                    onDown: () => {
                        this.currentIndex = i;
                        this.gridMode = false;
                        node.setDirtyCanvas(true, true);
                    }
                };
            }

            cx += cell + gap;
            if ((i + 1) % cols === 0) { cx = startX; cy += cell + gap; }
        }
    }

    _step(dir, node) {
        const n = this._value.images.length;
        if (n <= 1) return;
        this.currentIndex = (this.currentIndex + dir + n) % n;
        this._ensureImg(this._value.images[this.currentIndex]);
        node.setDirtyCanvas(true, true);
    }

    computeSize(width) {
        const node = this.node;
        const ns = node.size;
        let w = width;
        if (typeof w !== "number" || !isFinite(w)) {
            w = (Array.isArray(ns) ? ns[0] : (typeof ns === "number" ? ns : 270)) || 270;
        }
        // 返回固定最小高度，实际绘制高度由 draw 中的 node.size[1] - y 决定
        // 避免返回 ns[1] 导致与上方文本控件高度叠加引发无限增长
        return [w, 200];
    }

    serializeValue(node, index) {
        // 持久化图片数据，刷新后从工作流恢复显示
        return this._value;
    }

    mouse(event, pos, node) {
        if (event.type === "pointerdown" && event.button === 0) {
            // 双击检测
            const now = performance.now();
            const isDouble = this._lastClickPos &&
                (now - this._lastClickT) < 300 &&
                Math.abs(pos[0] - this._lastClickPos[0]) < 8 &&
                Math.abs(pos[1] - this._lastClickPos[1]) < 8;
            this._lastClickT = now;
            this._lastClickPos = [pos[0], pos[1]];

            for (const [key, area] of Object.entries(this.hitAreas)) {
                const [bx, by, bw, bh] = area.bounds;
                if (pos[0] >= bx && pos[0] <= bx + bw && pos[1] >= by && pos[1] <= by + bh) {
                    if (isDouble && area.onDouble) { area.onDouble(event, pos, node, area); return true; }
                    if (!isDouble && area.onDown) { area.onDown(event, pos, node, area); return true; }
                }
            }
            return true;
        }
        return false;
    }
}


// ============ 自定义节点 ============
class XiaozhuguangImageSaveNode {
    constructor() {
        this.canvasWidget = null;
    }

    onExecuted(output) {
        const imgs = output.xzg_preview || [];
        const imagesToShow = imgs.map((d, i) => ({
            name: String(i + 1),
            selected: i === 0,
            url: imageUrl(d),
            real_token: d.real_token || null,
            real_index: (d.real_index != null) ? d.real_index : i,
            real_width: d.real_width,
            real_height: d.real_height,
        }));
        this.canvasWidget.value = { images: imagesToShow };
        if (imagesToShow.length > 1) {
            this.canvasWidget.gridMode = true;
        }
        this.setDirtyCanvas(true, true);
    }

    onSerialize(serialised) {
        if (this.canvasWidget) {
            for (let [index, wv] of (serialised.widgets_values || []).entries()) {
                if (this.widgets[index] && this.widgets[index].name === "xzg_image_save") {
                    serialised.widgets_values[index] = this.canvasWidget.value.images.map(d => {
                        const copy = { ...d };
                        delete copy.img;
                        delete copy._loading;
                        return copy;
                    });
                }
            }
        }
    }

    onConfigure(o) {
        // 刷新后从 widgets_values 恢复图片数据
        if (this.canvasWidget && o.widgets_values) {
            for (let [index, wv] of o.widgets_values.entries()) {
                if (this.widgets[index] && this.widgets[index].name === "xzg_image_save") {
                    if (wv && Array.isArray(wv) && wv.length > 0) {
                        // wv 是图片数组
                        this.canvasWidget.value = { images: wv };
                        // 重新加载图片
                        for (const imgData of this.canvasWidget._value.images) {
                            if (imgData.url) {
                                this.canvasWidget._ensureImg(imgData);
                            }
                        }
                        if (this.canvasWidget._value.images.length > 1) {
                            this.canvasWidget.gridMode = true;
                        }
                        this.setDirtyCanvas(true, true);
                    } else if (wv && wv.images && Array.isArray(wv.images) && wv.images.length > 0) {
                        // wv 是 { images: [...] } 格式
                        this.canvasWidget.value = wv;
                        for (const imgData of this.canvasWidget._value.images) {
                            if (imgData.url) {
                                this.canvasWidget._ensureImg(imgData);
                            }
                        }
                        if (this.canvasWidget._value.images.length > 1) {
                            this.canvasWidget.gridMode = true;
                        }
                        this.setDirtyCanvas(true, true);
                    }
                    break;
                }
            }
        }
    }

    onMouseMove(e, pos) {
        if (this.canvasWidget) { this.canvasWidget._mousePos = [pos[0], pos[1]]; this.setDirtyCanvas(true, true); }
    }
    onMouseLeave(e, pos) {
        if (this.canvasWidget) { this.canvasWidget._mousePos = null; this.setDirtyCanvas(true, true); }
    }

    onNodeCreated() {
        const node = this;
        const w = this.addCustomWidget(new XzgImageSaveWidget("xzg_image_save", this));
        this.canvasWidget = w;
        // 文本控件(output_path, filename_prefix)在上方，图像控件在下方
        if (this.widgets) {
            this.widgets = [...this.widgets.filter(x => x !== w), w];
        }
        if (!node.getWidgetOnPos.__xzgPatched) {
            node.getWidgetOnPos = function (x, y, includeDisabled, ...rest) {
                const lx = x - node.pos[0];
                const ly = y - node.pos[1];
                const titleH = (typeof LiteGraph !== 'undefined' && LiteGraph.NODE_TITLE_HEIGHT) || 30;
                // 仅在图像控件区域内返回 canvasWidget，文本控件区域返回 null 以保证可交互
                const imgStartY = node.canvasWidget?._startY ?? titleH;
                if (lx >= 0 && lx <= node.size[0] - 12 && ly >= imgStartY && ly <= node.size[1] - 12) {
                    if (node.canvasWidget) return node.canvasWidget;
                }
                return null;
            };
            node.getWidgetOnPos.__xzgPatched = true;
        }
        const s = this.size;
        if (!Array.isArray(s) || !isFinite(s[0]) || !isFinite(s[1])) {
            let n = s;
            if (Array.isArray(n)) n = n[0];
            if (typeof n !== "number" || !isFinite(n)) n = 270;
            this.setSize([n, 300]);
        }
        setTimeout(() => { this.setDirtyCanvas(true, true); }, 0);
    }

    onDrawForeground(ctx, canvas) {
        // 禁用默认 PreviewImage 的小图绘制
    }

    getHelp() {
        return `
            <p>小珠光图像保存节点，支持保存/预览模式切换，保存图像为 JPG(压缩) 或 PNG(无损)，并显示压缩预览。</p>
            <ul>
                <li><strong>保存/预览</strong>：切换模式。保存模式输出文件到output目录；预览模式仅显示不保存（可替代小珠光图像预览）。</li>
                <li><strong>JPG/PNG</strong>：切换保存格式（仅保存模式有效）。JPG使用压缩参数(与预览一致)，PNG为全分辨率无损。</li>
                <li><strong>减少卡顿</strong>：开启后预览压缩为最长边3840px的JPG（质量85）；关闭(极速流畅)：最长边6400px的JPG（质量80）。</li>
                <li><strong>画布预览</strong>：始终为压缩JPG（流畅），与保存格式无关。</li>
                <li><strong>输出路径</strong>：可自定义输出文件夹（相对于output目录），留空则保存到output根目录。</li>
                <li><strong>文件名</strong>：固定为 xzg-save_序号。</li>
            </ul>
            <p><strong>输入</strong>：<code>images</code></p>
        `;
    }

    static category = "xiaozhuguang";
    static title = "小珠光图像保存";
    static type = XZG_IMAGE_SAVE_TYPE;
}


// ============ 注册扩展 ============
app.registerExtension({
    name: "xiaozhuguang.ImageSave",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name === XZG_IMAGE_SAVE_TYPE) {
            nodeType.prototype.previewWidget = null;
            nodeType.prototype.onPreviewRegistered = function () {};

            const origOnNodeCreated = nodeType.prototype.onNodeCreated;
            const origOnExecuted = nodeType.prototype.onExecuted;
            const origOnDrawForeground = nodeType.prototype.onDrawForeground;
            const origOnSerialize = nodeType.prototype.onSerialize;
            const origGetHelp = nodeType.prototype.getHelp;

            const proto = XiaozhuguangImageSaveNode.prototype;

            nodeType.prototype.onNodeCreated = function () {
                this.canvasWidget = null;
                proto.onNodeCreated.call(this);

                // 保存需要引用的 widget 引用，然后从 widgets 数组中完全移除
                // 避免 LiteGraph 为每个隐藏 widget 添加默认间距
                // mode widget 保留在 widgets 数组中（隐藏渲染），确保值能传递给后端
                this._xzgFormatWidget = null;
                this._xzgLagWidget = null;
                this._xzgModeWidget = null;
                if (this.widgets) {
                    this._xzgFormatWidget = this.widgets.find(w => w.name === "save_format") || null;
                    this._xzgLagWidget = this.widgets.find(w => w.name === "reduce_lag") || null;
                    this._xzgModeWidget = this.widgets.find(w => w.name === "mode") || null;

                    // mode widget 保留在数组中但隐藏默认渲染（值需要传递给后端）
                    if (this._xzgModeWidget) {
                        this._xzgModeWidget.draw = function () {};
                        this._xzgModeWidget.computeSize = function () { return [0, 0]; };
                        this._xzgModeWidget.mouse = function () { return false; };
                    }

                    this.widgets = this.widgets.filter(w =>
                        w.name !== "reduce_lag" &&
                        w.name !== "save_format" &&
                        w.name !== "filename_prefix" &&
                        w.name !== "output_path"
                    );
                }
                // 确保画布 widget 在数组中
                if (this.canvasWidget && !this.widgets.includes(this.canvasWidget)) {
                    this.widgets.push(this.canvasWidget);
                }
                // 移除被隐藏控件的输入端口（防止通过连线连接）
                if (this.inputs) {
                    this.inputs = this.inputs.filter(inp =>
                        inp.name !== "reduce_lag" &&
                        inp.name !== "save_format" &&
                        inp.name !== "filename_prefix" &&
                        inp.name !== "output_path"
                    );
                }
            };

            nodeType.prototype.onExecuted = function (output) {
                proto.onExecuted.call(this, output);
            };

            nodeType.prototype.onDrawForeground = function (ctx, canvas) {
                proto.onDrawForeground.call(this, ctx, canvas);
            };

            nodeType.prototype.onSerialize = function (o) {
                proto.onSerialize.call(this, o);
            };

            nodeType.prototype.onConfigure = function (o) {
                proto.onConfigure.call(this, o);
            };

            nodeType.prototype.onMouseMove = function (e, pos) {
                proto.onMouseMove.call(this, e, pos);
            };

            nodeType.prototype.onMouseLeave = function (e, pos) {
                proto.onMouseLeave.call(this, e, pos);
            };

            nodeType.prototype.getHelp = function () {
                return proto.getHelp.call(this);
            };

            // 防御：setSize 前规范 this.size
            const origSetSize = nodeType.prototype.setSize;
            nodeType.prototype.setSize = function (size, skip_compute) {
                if (!Array.isArray(this.size) ||
                    !isFinite(this.size[0]) || !isFinite(this.size[1])) {
                    let n = this.size;
                    if (Array.isArray(n)) n = n[0];
                    if (typeof n !== "number" || !isFinite(n)) n = 270;
                    this.size = [n, n];
                }
                return origSetSize ? origSetSize.call(this, size, skip_compute) : undefined;
            };

            // 最小尺寸限制
            nodeType.prototype.onNodeCreated = (function(orig) {
                return function () {
                    orig.call(this);
                    const MIN_H = 300;
                    this.minHeight = Math.max(this.minHeight || 0, MIN_H);
                    const origSetSize2 = this.setSize.bind(this);
                    this.setSize = function (size) {
                        const w = size?.[0] || this.size?.[0] || 300;
                        const h = Math.max(size?.[1] || this.size?.[1] || 300, MIN_H);
                        origSetSize2([w, h]);
                    };
                };
            })(nodeType.prototype.onNodeCreated);

            // 右键菜单：PNG保存 + JPG保存（与小珠光图像预览一致）
            const origGetExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
            nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
                if (origGetExtraMenuOptions) origGetExtraMenuOptions.call(this, canvas, options);
                if (!options || !Array.isArray(options)) return;
                const w = this.canvasWidget;
                if (w && !w.gridMode && w.value && w.value.images && w.value.images.length) {
                    const cur = w.value.images[w.currentIndex] || w.value.images[0];
                    const saveOpts = [
                        {
                            content: `<span style="color:#4CAF50;">PNG保存</span>`,
                            callback: () => { downloadImage(cur); }
                        },
                        {
                            content: `<span style="color:#4CAF50;">JPG保存</span>`,
                            callback: () => { downloadJpgImage(cur); }
                        }
                    ];
                    options.splice(0, 0, ...saveOpts, null);
                }
            };
        }
    },
});

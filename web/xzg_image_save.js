import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
    downloadLazyImage,
    downloadLazyJpg,
} from "./xzg_save_utils.js";
import { xzgT, xzgTh } from "./xzg_i18n.js";

const XZG_IMAGE_SAVE_TYPE = "XiaozhuguangImageSave";
const XZG_IMAGE_SAVE_CUSTOM_TYPE = "XiaozhuguangImageSaveCustom";
// 支持的节点类型集合（新节点「小珠光图像保存-自定义输出」复用同一前端逻辑）
const XZG_IMAGE_SAVE_TYPES = new Set([XZG_IMAGE_SAVE_TYPE, XZG_IMAGE_SAVE_CUSTOM_TYPE]);
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
    pngItem.innerHTML = `<span style="color:#4CAF50;">${xzgTh("PNG保存", "Save PNG")}</span>`;
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
    jpgItem.innerHTML = `<span style="color:#4CAF50;">${xzgTh("JPG保存", "Save JPG")}</span>`;
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

    // 分隔线
    const sep = document.createElement("div");
    sep.style.cssText = "height:1px;background:#555;margin:4px 0;";
    menu.appendChild(sep);

    // 发送到小珠光图片加载器
    const sendItem = document.createElement("div");
    sendItem.style.cssText = menuItemStyle;
    sendItem.innerHTML = `<span style="color:#88ccff;">${xzgTh("发送到小珠光图片加载器", "Send to Image Loader")}</span>`;
    sendItem.addEventListener("mouseenter", () => { sendItem.style.background = "#3a3a3a"; });
    sendItem.addEventListener("mouseleave", () => { sendItem.style.background = ""; });
    sendItem.addEventListener("click", () => {
        const w = _xzgImgSaveCtxCurrentWidget;
        _xzgImgSaveHideCtxMenu();
        if (!w) return;
        const imgs = w._value?.images || [];
        const cur = imgs[w.currentIndex] || imgs[0];
        if (cur) _xzgSendToImageLoader(cur);
    });
    menu.appendChild(sendItem);

    menu._pngItem = pngItem;
    menu._jpgItem = jpgItem;
    menu._sendItem = sendItem;
    document.body.appendChild(menu);

    // 点击其他地方关闭菜单（pointerdown 覆盖鼠标+触摸，mousedown 兜底，contextmenu 处理右键，keydown Escape）
    const dismiss = (e) => {
        if (menu.style.display === "block" && !menu.contains(e.target)) {
            _xzgImgSaveHideCtxMenu();
        }
    };
    window.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("mousedown", dismiss, true);
    window.addEventListener("contextmenu", dismiss, true);
    window.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && menu.style.display === "block") _xzgImgSaveHideCtxMenu();
    }, true);
    window.addEventListener("wheel", dismiss, true);

    _xzgImgSaveCtxMenu = menu;
    return menu;
}

function _xzgImgSaveShowCtxMenu(widget, x, y) {
    _xzgImgSaveCtxCurrentWidget = widget;
    const menu = _xzgImgSaveEnsureCtxMenu();

    // 当前图片含 alpha 通道时强制 PNG（JPG 无法保留透明度）
    const imgs = widget?._value?.images || [];
    const cur = imgs[widget.currentIndex] || imgs[0];
    const forcePng = !!(cur && cur.has_alpha);

    // 根据 save_format 只显示对应菜单项（RGBA 时强制 PNG）
    const fmt = forcePng ? "PNG" : (widget?.node?._xzgFormatWidget?.value || "JPG");
    if (menu._pngItem) menu._pngItem.style.display = (fmt === "PNG") ? "" : "none";
    if (menu._jpgItem) menu._jpgItem.style.display = (fmt === "JPG") ? "" : "none";

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

// ═══════════════════════════════════════════════════════════════════
// 发送到小珠光图片加载器
// ═══════════════════════════════════════════════════════════════════

// 从 URL 中解析 filename / subfolder / type 参数
function _xzgParseImgUrl(url) {
    try {
        const u = new URL(url, window.location.origin);
        const filename = u.searchParams.get("filename") || "";
        const subfolder = u.searchParams.get("subfolder") || "";
        const type = u.searchParams.get("type") || "output";
        return { filename, subfolder, type };
    } catch (_) {
        return { filename: "", subfolder: "", type: "output" };
    }
}

// 将图像保存节点的 image data 转为加载器的标注文件名：filename [type]，支持 subfolder
// 图片保存节点前端 widget 数据结构：
//   - 保存模式：saved_filename / saved_subfolder / saved_type 有值（output 目录持久化文件）
//   - 预览模式：上述字段为 null，需从 url 解析 temp 预览图文件名
function _xzgFormatLoaderName(imgData) {
    // 优先使用保存模式下的真实文件信息（output 目录）
    let filename = imgData.saved_filename || "";
    let subfolder = imgData.saved_subfolder || "";
    let type = imgData.saved_type || "";

    // 预览模式：从 url 中解析 temp 预览图信息
    if (!filename && imgData.url) {
        const parsed = _xzgParseImgUrl(imgData.url);
        filename = parsed.filename;
        subfolder = parsed.subfolder;
        type = parsed.type;
    }

    if (!filename) return null;

    let name = filename;
    if (subfolder) {
        name = subfolder + "/" + name;
    }
    return name + " [" + (type || "output") + "]";
}

// 查找画布中所有小珠光图像加载器节点
function _xzgFindImageLoaders() {
    const loaders = [];
    const nodes = app.graph?.nodes || [];
    for (const n of nodes) {
        if (n && n.type === "XiaozhuguangImageLoader") {
            loaders.push(n);
        }
    }
    return loaders;
}

// 向指定加载器节点添加图片名（遵循其 upload_mode：replace 替换，append 追加到头部）
function _xzgAppendToLoader(loaderNode, annotatedName) {
    const listWidget = loaderNode.widgets?.find((w) => w.name === "image_list");
    if (!listWidget) return;
    const modeWidget = loaderNode.widgets?.find((w) => w.name === "upload_mode");
    const mode = modeWidget?.value === "replace" ? "replace" : "append";

    const existing = (listWidget.value || "")
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);

    if (mode === "replace") {
        listWidget.value = annotatedName;
    } else {
        // 多图模式：去重后插入到列表头部
        const idx = existing.indexOf(annotatedName);
        if (idx >= 0) existing.splice(idx, 1);
        existing.unshift(annotatedName);
        listWidget.value = existing.join("\n");
    }
    listWidget.callback?.(listWidget.value);

    // 切换到新图片（索引 0）
    const idxWidget = loaderNode.widgets?.find((w) => w.name === "index");
    if (idxWidget) {
        idxWidget.value = 0;
        idxWidget.callback?.(idxWidget.value);
    }
    app.graph.setDirtyCanvas(true);
}

// 多个加载器时弹出选择对话框
function _xzgShowLoaderSelector(loaders, annotatedName) {
    const overlay = document.createElement("div");
    overlay.style.cssText =
        "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:999999;display:flex;align-items:center;justify-content:center;";
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    const dialog = document.createElement("div");
    dialog.style.cssText =
        "background:var(--comfy-menu-bg,#2a2a2a);border:1px solid var(--border-color,#555);border-radius:8px;padding:20px 24px;min-width:300px;max-width:90vw;";
    dialog.onclick = (e) => e.stopPropagation();

    const title = document.createElement("div");
    title.style.cssText = "font-size:13px;color:var(--input-text,#ddd);margin-bottom:14px;";
    title.textContent = xzgTh("选择目标图像加载器", "Select target Image Loader");
    dialog.appendChild(title);

    const list = document.createElement("div");
    list.style.cssText = "display:flex;flex-direction:column;gap:6px;max-height:300px;overflow-y:auto;";
    loaders.forEach((n) => {
        const item = document.createElement("div");
        item.style.cssText =
            "padding:8px 14px;background:var(--comfy-input-bg,#333);color:var(--input-text,#ddd);border:1px solid var(--border-color,#555);border-radius:4px;cursor:pointer;font-size:12px;";
        const label = (n.title || n.type || "Image Loader") + " #" + n.id;
        item.textContent = label;
        item.addEventListener("mouseenter", () => { item.style.borderColor = "#FFD700"; });
        item.addEventListener("mouseleave", () => { item.style.borderColor = "var(--border-color,#555)"; });
        item.addEventListener("click", () => {
            overlay.remove();
            _xzgAppendToLoader(n, annotatedName);
        });
        list.appendChild(item);
    });
    dialog.appendChild(list);

    const cancelBtn = document.createElement("button");
    cancelBtn.style.cssText =
        "margin-top:14px;padding:6px 16px;background:var(--comfy-input-bg,#333);color:var(--input-text,#ddd);border:1px solid var(--border-color,#555);border-radius:4px;cursor:pointer;font-size:12px;width:100%;";
    cancelBtn.textContent = xzgTh("取消", "Cancel");
    cancelBtn.onclick = () => overlay.remove();
    dialog.appendChild(cancelBtn);

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
}

// 主入口：发送当前图片到小珠光图像加载器
function _xzgSendToImageLoader(imgData) {
    if (!imgData) return;
    const annotatedName = _xzgFormatLoaderName(imgData);
    if (!annotatedName) {
        console.warn("[小珠光图像保存] 无法解析图片文件名，发送取消");
        return;
    }
    const loaders = _xzgFindImageLoaders();

    if (loaders.length === 0) {
        const msg = xzgTh(
            "未找到小珠光图像加载器节点，请先添加一个",
            "No Xiaozhuguang Image Loader found. Please add one first."
        );
        console.warn("[小珠光图像保存] " + msg);
        alert(msg);
        return;
    }

    if (loaders.length === 1) {
        _xzgAppendToLoader(loaders[0], annotatedName);
        return;
    }

    _xzgShowLoaderSelector(loaders, annotatedName);
}

// 检查点击是否在图像保存节点的图像区域内
function _xzgImgSaveIsInImageArea(canvasX, canvasY) {
    let nd = null;
    const canvas = app.canvas;
    if (canvas.getNodeAtPosition) nd = canvas.getNodeAtPosition(canvasX, canvasY);
    else if (canvas.getNodeAtPos) nd = canvas.getNodeAtPos(canvasX, canvasY);
    else if (canvas.graph?.getNodeOnPos) nd = canvas.graph.getNodeOnPos(canvasX, canvasY);

    if (!nd || !XZG_IMAGE_SAVE_TYPES.has(nd.type)) return null;
    const w = nd.canvasWidget;
    if (!w) return null;
    const NODE_TITLE_HEIGHT = (typeof LiteGraph !== 'undefined' && LiteGraph.NODE_TITLE_HEIGHT) || 30;
    // widget.draw 的 y 参数是相对于节点左上角的（含 titleH），首次绘制未发生时后备用标题栏高度
    const startY = w._startY ?? NODE_TITLE_HEIGHT;
    let imgDrawY = w._imageDrawY;
    let imgDrawH = w._imageDrawH;

    // 后备方案：如果图像区域未被正确设置（可能是首次绘制或旧代码），手动估算
    if (imgDrawH === undefined || imgDrawH === null || imgDrawH <= 0) {
        const hasBtnRow = nd._xzgFormatWidget || nd._xzgLagWidget || nd._xzgModeWidget || (nd.type === XZG_IMAGE_SAVE_CUSTOM_TYPE);
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
            if (node && XZG_IMAGE_SAVE_TYPES.has(node.type)) {
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

        // 按钮行布局：
        //   原节点（XiaozhuguangImageSave）：三等分 mode / save_format / reduce_lag
        //   自定义节点（XiaozhuguangImageSaveCustom）：四等分 输出目录 / mode / save_format / reduce_lag
        const modeWidget = node._xzgModeWidget;
        const lagWidget = node._xzgLagWidget;
        const formatWidget = node._xzgFormatWidget;
        const isCustom = node.type === XZG_IMAGE_SAVE_CUSTOM_TYPE;

        if (isCustom || modeWidget || formatWidget || lagWidget) {
            const cols = isCustom ? 4 : 3;
            const colW = width / cols;
            ctx.font = "11px Arial";
            ctx.textBaseline = "middle";

            let idx = 0;
            // 保存/预览 切换（内部值 Save/Preview，显示走 xzgT 翻译）
            if (modeWidget) {
                ctx.textAlign = "center";
                // 兼容老工作流的中文值
                const v = String(modeWidget.value || "Save");
                const isSave = !(v === "预览" || v === "Preview" || v === "preview");
                const displayText = isSave ? xzgT("保存", "Save") : xzgT("预览", "Preview");
                ctx.fillStyle = isSave ? "#FFD700" : "#88ccff";
                ctx.fillText(displayText, colW * idx + colW / 2, y + btnH / 2);
                this.hitAreas["mode"] = {
                    bounds: [colW * idx, y, colW, btnH],
                    onDown: () => {
                        modeWidget.value = isSave ? "Preview" : "Save";
                        node.setDirtyCanvas(true);
                    }
                };
                idx++;
            }

            // JPG/PNG 切换（预览模式下灰显且不可点击；RGBA 图像强制 PNG 并灰显）
            if (formatWidget) {
                ctx.textAlign = "center";
                const v = String(modeWidget?.value || "Save");
                const isPreview = (v === "预览" || v === "Preview" || v === "preview");
                // 批次中任一图含 alpha 通道时强制 PNG（JPG 无法保留透明度）
                const hasAlpha = (this._value?.images || []).some(d => d.has_alpha);
                if (hasAlpha) formatWidget.value = "PNG";
                const disabled = isPreview || hasAlpha;
                ctx.fillStyle = disabled ? "#555555" : "#aaaaaa";
                ctx.fillText(formatWidget.value || "JPG", colW * idx + colW / 2, y + btnH / 2);
                if (!disabled) {
                    this.hitAreas["save_format"] = {
                        bounds: [colW * idx, y, colW, btnH],
                        onDown: () => {
                            formatWidget.value = formatWidget.value === "JPG" ? "PNG" : "JPG";
                            node.setDirtyCanvas(true);
                        }
                    };
                }
                idx++;
            }

            // 减小卡顿 / 极速流畅
            if (lagWidget) {
                ctx.textAlign = "center";
                ctx.fillStyle = "#aaaaaa";
                const lagText = lagWidget.value ? xzgT("极致流畅", "Max Smooth") : xzgT("减小卡顿", "Reduce Lag");
                ctx.fillText(lagText, colW * idx + colW / 2, y + btnH / 2);
                this.hitAreas["reduce_lag"] = {
                    bounds: [colW * idx, y, colW, btnH],
                    onDown: () => { lagWidget.value = !lagWidget.value; node.setDirtyCanvas(true); }
                };
                idx++;
            }

            // 自定义节点最右侧：输出目录
            if (isCustom) {
                ctx.textAlign = "center";
                ctx.fillStyle = "#aaaaaa";
                ctx.fillText(xzgT("输出目录", "Output Dir"), colW * idx + colW / 2, y + btnH / 2);
                this.hitAreas["browse_dir"] = {
                    bounds: [colW * idx, y, colW, btnH],
                    onDown: () => {
                        if (typeof _xzgShowDirBrowser === "function") _xzgShowDirBrowser(node);
                    }
                };
                idx++;
            }

            // 分隔竖杠 1px
            ctx.strokeStyle = "#aaaaaa";
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (let i = 1; i < idx; i++) {
                ctx.moveTo(colW * i, y); ctx.lineTo(colW * i, y + btnH);
            }
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

            // 底部显示分辨率（优先使用后端返回的原始分辨率 real_width/real_height，避免显示压缩后的预览图分辨率）
            const rw = imgData.real_width || natW;
            const rh = imgData.real_height || natH;
            const labelText = `${rw} × ${rh}`;
            ctx.font = "11px Arial";
            const textW = ctx.measureText(labelText).width;
            const labelW = textW + 10;
            const labelH = 16;
            const labelX = destX + (targetW - labelW) / 2;
            const labelY = destY + targetH - labelH - 3;
            ctx.fillStyle = "rgba(0,0,0,0.6)";
            ctx.fillRect(labelX, labelY, labelW, labelH);
            ctx.fillStyle = "#ffffff";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(labelText, destX + targetW / 2, labelY + labelH / 2);
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
                const imgX = cx + (cell - tw) / 2;
                const imgY = cy + (cell - th) / 2;
                ctx.drawImage(img, imgX, imgY, tw, th);

                // 网格缩略图底部显示分辨率（cell ≥ 60 时才显示，避免拥挤）
                // 优先使用后端返回的原始分辨率 real_width/real_height
                if (cell >= 60) {
                    const rw = imgData.real_width || img.naturalWidth;
                    const rh = imgData.real_height || img.naturalHeight;
                    const labelText = `${rw}×${rh}`;
                    const saveFont = ctx.font;
                    ctx.font = "6px Arial";
                    const textW = ctx.measureText(labelText).width;
                    const labelH = 8;
                    const labelW = Math.min(tw, textW + 4);
                    const labelX = imgX + (tw - labelW) / 2;
                    const labelY = imgY + th - labelH - 1;
                    ctx.fillStyle = "rgba(0,0,0,0.6)";
                    ctx.fillRect(labelX, labelY, labelW, labelH);
                    ctx.fillStyle = "#ffffff";
                    ctx.textAlign = "center";
                    ctx.textBaseline = "middle";
                    ctx.fillText(labelText, imgX + tw / 2, labelY + labelH / 2);
                    ctx.font = saveFont;
                }
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
        // 返回当前节点实际高度，与 xzg_image_preview 一致。
        // 注：原先返回固定 200 是为了防止上方文本控件被叠加计算导致无限增长，
        // 但目前 mode/save_format/reduce_lag/base_dir 等 widget 均已被 hideWidget（computeSize=[0,0]），
        // 原节点（非化神级）的 output_path/filename_prefix 等也已从 widgets 数组中完全移除，
        // 因此 canvasWidget 的高度直接取 node.size[1] 是安全的，且能避免布局高度与绘制高度不一致造成的错位。
        const h = (Array.isArray(ns) && isFinite(ns[1])) ? ns[1] : 300;
        return [w, h];
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
            // 是否含 alpha 通道：右键强制 PNG 保存
            has_alpha: !!d.has_alpha,
            // 保存模式下附带 output 目录文件信息，右键 PNG 可直接下载，无需懒编码
            saved_filename: d.saved_filename || null,
            saved_subfolder: d.saved_subfolder || null,
            saved_type: d.saved_type || null,
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
        // "输出目录"按钮已合并到 canvasWidget 首行（与 mode/save_format/reduce_lag 同行）
        // 仅 CUSTOM 节点显示"输出目录"按钮，通过 canvasWidget.draw 内部判断节点类型绘制
        if (!node.getWidgetOnPos.__xzgPatched) {
            const origGetWidgetOnPos = node.getWidgetOnPos.bind(node);
            node.getWidgetOnPos = function (x, y, includeDisabled, ...rest) {
                const lx = x - node.pos[0];
                const ly = y - node.pos[1];
                const titleH = (typeof LiteGraph !== 'undefined' && LiteGraph.NODE_TITLE_HEIGHT) || 30;
                // 仅在图像控件区域内返回 canvasWidget，文本控件区域回退到原始查找逻辑
                const imgStartY = node.canvasWidget?._startY ?? titleH;
                if (lx >= 0 && lx <= node.size[0] - 12 && ly >= imgStartY && ly <= node.size[1] - 12) {
                    if (node.canvasWidget) return node.canvasWidget;
                }
                // 文本控件区域：调用原始 getWidgetOnPos 查找文本 widget
                return origGetWidgetOnPos(x, y, includeDisabled, ...rest);
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
        if (XZG_IMAGE_SAVE_TYPES.has(nodeData.name)) {
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
                // mode/save_format/reduce_lag widget 保留在 widgets 数组中（隐藏默认渲染，已由自定义按钮绘制），
                // 确保 LiteGraph 序列化时能把这些值传递给后端
                this._xzgFormatWidget = null;
                this._xzgLagWidget = null;
                this._xzgModeWidget = null;
                this._xzgBaseDirWidget = null;
                this._xzgPrefixCustomWidget = null;
                this._xzgDateStampWidget = null;
                this._xzgTimeStampWidget = null;
                this._xzgDefaultOutputWidget = null;
                if (this.widgets) {
                    this._xzgFormatWidget = this.widgets.find(w => w.name === "save_format") || null;
                    this._xzgLagWidget = this.widgets.find(w => w.name === "reduce_lag") || null;
                    this._xzgModeWidget = this.widgets.find(w => w.name === "mode") || null;
                    this._xzgBaseDirWidget = this.widgets.find(w => w.name === "base_dir") || null;
                    this._xzgPrefixCustomWidget = this.widgets.find(w => w.name === "filename_custom") || null;
                    this._xzgDateStampWidget = this.widgets.find(w => w.name === "add_date_stamp") || null;
                    this._xzgTimeStampWidget = this.widgets.find(w => w.name === "add_time_stamp") || null;
                    this._xzgDefaultOutputWidget = this.widgets.find(w => w.name === "use_default_output") || null;

                    // 保留在数组中但隐藏默认渲染（值需要传递给后端）
                    // type="hidden" 让新版 ComfyUI 前端 isWidgetVisible 返回 false，跳过布局占位
                    const hideWidget = (w) => {
                        if (!w) return;
                        w.type = "hidden";
                        w.hidden = true;
                        w.draw = function () {};
                        w.computeSize = function () { return [0, 0]; };
                        w.mouse = function () { return false; };
                    };
                    hideWidget(this._xzgModeWidget);
                    hideWidget(this._xzgFormatWidget);
                    hideWidget(this._xzgLagWidget);

                    // 规范化 mode 值为英文（防止 i18n 翻译 combo 选项导致后端校验失败）
                    // ComfyUI i18n 可能把 "Save" 翻译成 "保存"、"Preview" 翻译成 "预览"
                    if (this._xzgModeWidget) {
                        const _normModeVal = (v) => {
                            const s = String(v ?? "Save");
                            if (s === "预览" || s === "preview") return "Preview";
                            return "Save"; // "保存"/"Save"/其他 均视为 Save
                        };
                        this._xzgModeWidget.value = _normModeVal(this._xzgModeWidget.value);
                        // 序列化时强制输出英文值，确保后端 INPUT_TYPES 校验通过
                        this._xzgModeWidget.serializeValue = function () {
                            return _normModeVal(this.value);
                        };
                    }
                    // base_dir 通过"输出目录"按钮设置，隐藏文本框
                    hideWidget(this._xzgBaseDirWidget);
                    // filename_custom / add_date_stamp / add_time_stamp / use_default_output 在"输出目录"对话框里设置，隐藏主节点控件
                    hideWidget(this._xzgPrefixCustomWidget);
                    hideWidget(this._xzgDateStampWidget);
                    hideWidget(this._xzgTimeStampWidget);
                    hideWidget(this._xzgDefaultOutputWidget);

                    // 仅原节点过滤 output_path / filename_prefix / filename_custom / add_date_stamp / add_time_stamp / use_default_output
                    if (this.type !== XZG_IMAGE_SAVE_CUSTOM_TYPE) {
                        this.widgets = this.widgets.filter(w =>
                            w.name !== "filename_prefix" &&
                            w.name !== "filename_custom" &&
                            w.name !== "add_date_stamp" &&
                            w.name !== "add_time_stamp" &&
                            w.name !== "use_default_output" &&
                            w.name !== "output_path"
                        );
                    }
                }
                // 确保画布 widget 在数组中
                if (this.canvasWidget && !this.widgets.includes(this.canvasWidget)) {
                    this.widgets.push(this.canvasWidget);
                }
                // 白名单模式：只保留 images 输入端口，移除所有其他输入
                // （包含 hidden 字段、option 控件端口等）
                this.__xzgSanitizeInputs = function () {
                    if (this.inputs && this.inputs.length > 1) {
                        this.inputs = this.inputs.filter(inp => inp.name === "images");
                    }
                };
                this.__xzgSanitizeInputs();
                // 延迟再执行一次，确保 ComfyUI 内部注册完成后仍然有效
                setTimeout(() => this.__xzgSanitizeInputs(), 0);
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
                // 从工作流恢复后：白名单只保留 images 端口（ComfyUI configure 会恢复保存的全部 inputs）
                this.__xzgSanitizeInputs?.call(this);
                // 规范化 mode 值为英文（工作流可能保存了 i18n 翻译后的中文值）
                if (this._xzgModeWidget) {
                    const v = String(this._xzgModeWidget.value ?? "Save");
                    if (v === "预览" || v === "preview") {
                        this._xzgModeWidget.value = "Preview";
                    } else if (v !== "Preview" && v !== "Save") {
                        this._xzgModeWidget.value = "Save";
                    }
                }
                // 再延迟一轮 ensure：configure 后 ComfyUI 内部可能还有后处理
                setTimeout(() => this.__xzgSanitizeInputs?.call(this), 0);
            };

            // 最后一道防线：每次绘制前清理一次 inputs，确保即使其他回调错过了也不留下多余端口
            const _origDrawBackground = nodeType.prototype.onDrawBackground;
            nodeType.prototype.onDrawBackground = function (ctx, canvas) {
                this.__xzgSanitizeInputs?.call(this);
                return _origDrawBackground ? _origDrawBackground.call(this, ctx, canvas) : undefined;
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

            // 右键菜单：PNG保存 + JPG保存 + 发送到小珠光图片加载器
            const origGetExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
            nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
                if (origGetExtraMenuOptions) origGetExtraMenuOptions.call(this, canvas, options);
                if (!options || !Array.isArray(options)) return;
                const w = this.canvasWidget;
                if (w && !w.gridMode && w.value && w.value.images && w.value.images.length) {
                    const cur = w.value.images[w.currentIndex] || w.value.images[0];
                    // 含 alpha 通道时强制 PNG（JPG 无法保留透明度）
                    const fmt = (cur && cur.has_alpha) ? "PNG" : (this._xzgFormatWidget?.value || "JPG");
                    const saveOpts = [];
                    if (fmt === "PNG") {
                        saveOpts.push({
                            content: `<span style="color:#4CAF50;">${xzgTh("PNG保存", "Save PNG")}</span>`,
                            callback: () => { downloadImage(cur); }
                        });
                    } else {
                        saveOpts.push({
                            content: `<span style="color:#4CAF50;">${xzgTh("JPG保存", "Save JPG")}</span>`,
                            callback: () => { downloadJpgImage(cur); }
                        });
                    }
                    // 发送到小珠光图片加载器
                    saveOpts.push({
                        content: `<span style="color:#88ccff;">${xzgTh("发送到小珠光图片加载器", "Send to Image Loader")}</span>`,
                        callback: () => { _xzgSendToImageLoader(cur); }
                    });
                    options.splice(0, 0, ...saveOpts, null);
                }
            };
        }
    },
});


// ═══════════════════════════════════════════════════════════════════
// 文件夹浏览器对话框（仅「小珠光图像保存-自定义输出」节点使用）
// 通过后端 /xzg_list_dirs API 浏览目录，选择后填充到 base_dir widget
// 风格：紧凑尺寸 + 小珠光金色 #dcc85b 主题
// ═══════════════════════════════════════════════════════════════════

let _xzgDirBrowserDlg = null;
let _xzgQuickDirsCache = null;   // {items, drives} 缓存，首次打开时异步拉
let _xzgQuickDirsLoading = null; // Promise，避免并发重复请求
const _xzgDirBrowserState = {
    currentPath: "",
    parentPath: null,
    selectedPath: "",
    targetNode: null,
    targetWidget: null,
};

// 最近使用目录（localStorage，最多5个，不重复，最新在前）
const _XZG_RECENT_KEY = "xzg_save_recent_dirs_v1";
function _xzgRecentDirsGet() {
    try {
        const raw = localStorage.getItem(_XZG_RECENT_KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr.filter(x => typeof x === "string") : [];
    } catch (e) { return []; }
}
function _xzgRecentDirsPush(path) {
    if (!path) return;
    let list = _xzgRecentDirsGet().filter(p => p !== path);
    list.unshift(path);
    if (list.length > 5) list = list.slice(0, 5);
    try { localStorage.setItem(_XZG_RECENT_KEY, JSON.stringify(list)); } catch (e) {}
}
function _xzgRecentDirsClear() {
    try { localStorage.removeItem(_XZG_RECENT_KEY); } catch (e) {}
}

// 懒加载常用位置（桌面/文档/盘符快捷按钮等），缓存复用
async function _xzgEnsureQuickDirs() {
    if (_xzgQuickDirsCache) return _xzgQuickDirsCache;
    if (_xzgQuickDirsLoading) return _xzgQuickDirsLoading;
    _xzgQuickDirsLoading = (async () => {
        try {
            const resp = await api.fetchApi("/xzg_quick_dirs", { method: "POST" });
            const txt = await resp.text();
            const data = JSON.parse(txt);
            _xzgQuickDirsCache = { items: data.items || [], drives: data.drives || [] };
        } catch (e) {
            console.warn("[小珠光] 获取常用位置失败:", e);
            _xzgQuickDirsCache = { items: [], drives: [] };
        }
        return _xzgQuickDirsCache;
    })();
    return _xzgQuickDirsLoading;
}

// 给定一个路径，返回逐级向上找最近存在的父目录或空字符串（我的电脑）
function _xzgClimbToValidParent(path) {
    if (!path) return "";
    let p = path;
    // 最多爬 20 级，防死循环
    for (let i = 0; i < 20; i++) {
        // Windows: "D:\" 这类就爬到顶了 → 上一级是空（我的电脑）
        const norm = p.replace(/[\\/]+$/, "");
        if (/^[A-Za-z]:$/.test(norm) || norm === "/") {
            return norm + (norm.length === 2 ? "\\" : "");  // D:\ 或 /
        }
        const up = p.replace(/[\\/][^\\/]+[\\/]?$/, "");
        if (up === p || !up) return "";
        p = up;
    }
    return "";
}

function _xzgDirBrowserEnsureDlg() {
    if (_xzgDirBrowserDlg) return _xzgDirBrowserDlg;

    const GOLD = "#dcc85b";
    const BG = "#1e1e1e";
    const BG3 = "#2a2a2a";
    const BORDER = "#444";
    const BTN_BG = "#353535";
    const BTN_BORDER = "#555";
    const TEXT = "#ddd";

    const dlg = document.createElement("div");
    dlg.style.cssText = [
        "position: fixed", "top: 50%", "left: 50%", "transform: translate(-50%, -50%)",
        "width: 420px", "height: 360px", `background: ${BG}`, `border: 1px solid ${BORDER}`,
        "border-radius: 4px", "box-shadow: 0 6px 20px rgba(0,0,0,0.6)",
        "display: none", "flex-direction: column", "z-index: 100000",
        "font-family: Arial, sans-serif", `color: ${TEXT}`, "overflow: hidden",
        "user-select: none",
    ].join(";");

    // ── 标题栏（支持拖动移动对话框）──
    const titleBar = document.createElement("div");
    titleBar.style.cssText = `display:flex;align-items:center;justify-content:space-between;padding:5px 10px;background:${BG3};border-bottom:1px solid ${BORDER};cursor:move;`;
    const titleText = document.createElement("span");
    titleText.style.cssText = `font-size:12px;color:${GOLD};font-weight:bold;pointer-events:none;`;
    titleText.textContent = `📁 ${xzgT("选择保存目录", "Select Save Directory")}`;
    const closeBtn = document.createElement("span");
    closeBtn.textContent = "✕";
    closeBtn.style.cssText = "cursor:pointer;color:#888;font-size:13px;padding:1px 5px;";
    closeBtn.addEventListener("mouseenter", () => closeBtn.style.color = TEXT);
    closeBtn.addEventListener("mouseleave", () => closeBtn.style.color = "#888");
    closeBtn.addEventListener("click", () => _xzgDirBrowserHide());
    titleBar.appendChild(titleText);
    titleBar.appendChild(closeBtn);
    dlg.appendChild(titleBar);

    // ── 标题栏拖动移动逻辑 ──
    let _dragState = null; // { startX, startY, origLeft, origTop }
    const _dragOnMove = (ev) => {
        if (!_dragState) return;
        const dx = ev.clientX - _dragState.startX;
        const dy = ev.clientY - _dragState.startY;
        let newLeft = _dragState.origLeft + dx;
        let newTop = _dragState.origTop + dy;
        // 限制在可视区内（至少保留 40px 可见，方便拖回）
        const maxLeft = window.innerWidth - 40;
        const maxTop = window.innerHeight - 40;
        if (newLeft < -dlg.offsetWidth + 40) newLeft = -dlg.offsetWidth + 40;
        if (newTop < -20) newTop = -20;
        if (newLeft > maxLeft) newLeft = maxLeft;
        if (newTop > maxTop) newTop = maxTop;
        dlg.style.left = newLeft + "px";
        dlg.style.top = newTop + "px";
        dlg.style.transform = "none";
    };
    const _dragOnUp = () => {
        if (_dragState) {
            // 记住位置，下次打开复用
            try {
                localStorage.setItem("xzgDirBrowserPos", JSON.stringify({
                    left: dlg.style.left,
                    top: dlg.style.top,
                }));
            } catch (_) {}
            _dragState = null;
        }
        window.removeEventListener("pointermove", _dragOnMove, true);
        window.removeEventListener("pointerup", _dragOnUp, true);
        window.removeEventListener("pointercancel", _dragOnUp, true);
    };
    titleBar.addEventListener("pointerdown", (ev) => {
        // 点击关闭按钮时不拖动
        if (ev.target === closeBtn || closeBtn.contains(ev.target)) return;
        ev.preventDefault();
        // 切换到 left/top 定位（清除居中 transform）
        if (dlg.style.transform !== "none") {
            const rect = dlg.getBoundingClientRect();
            dlg.style.left = rect.left + "px";
            dlg.style.top = rect.top + "px";
            dlg.style.transform = "none";
        }
        const curLeft = parseFloat(dlg.style.left) || 0;
        const curTop = parseFloat(dlg.style.top) || 0;
        _dragState = {
            startX: ev.clientX,
            startY: ev.clientY,
            origLeft: curLeft,
            origTop: curTop,
        };
        window.addEventListener("pointermove", _dragOnMove, true);
        window.addEventListener("pointerup", _dragOnUp, true);
        window.addEventListener("pointercancel", _dragOnUp, true);
    });

    // ── 面包屑 + 两个快捷按钮（盘符 / 新建）──
    const navBar = document.createElement("div");
    navBar.style.cssText = `display:flex;align-items:center;gap:4px;padding:4px 8px;border-bottom:1px solid #333;background:#252525;min-height:26px;`;
    const crumbWrap = document.createElement("div");
    crumbWrap.style.cssText = "flex:1;display:flex;align-items:center;gap:0;overflow:hidden;min-width:0;";
    navBar.appendChild(crumbWrap);

    const mkBtn = (label, gold, title) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.title = title || "";
        b.style.cssText = `background:${BTN_BG};color:${gold ? GOLD : TEXT};border:1px solid ${BTN_BORDER};border-radius:2px;padding:2px 8px;cursor:pointer;font-size:11px;white-space:nowrap;flex-shrink:0;`;
        b.addEventListener("mouseenter", () => { if (b.style.pointerEvents !== "none") b.style.background = "#3a3a3a"; });
        b.addEventListener("mouseleave", () => { if (b.style.pointerEvents !== "none") b.style.background = BTN_BG; });
        return b;
    };
    const newFolderBtn = mkBtn("＋", true, xzgT("新建文件夹", "New Folder"));
    newFolderBtn.addEventListener("click", () => _xzgDirBrowserNewFolder());
    navBar.appendChild(newFolderBtn);
    dlg._crumbWrap = crumbWrap;
    dlg._newFolderBtn = newFolderBtn;
    dlg.appendChild(navBar);

    // ── 列表区域 ──
    const listWrap = document.createElement("div");
    listWrap.style.cssText = `flex:1;overflow-y:auto;padding:2px 4px;background:${BG};`;
    dlg.appendChild(listWrap);
    dlg._listWrap = listWrap;

    // ── 设置区：默认输出 + 自定义前缀 + 日期戳 + 时间戳 开关 ──
    const settingsRow = document.createElement("div");
    settingsRow.style.cssText = `display:flex;align-items:center;gap:8px;padding:4px 10px;border-top:1px solid #333;background:${BG3};flex-wrap:wrap;`;
    // 默认输出开关
    const defaultToggle = document.createElement("label");
    defaultToggle.style.cssText = "font-size:11px;color:#ddd;display:flex;align-items:center;gap:4px;cursor:pointer;user-select:none;white-space:nowrap;";
    const defaultCheck = document.createElement("input");
    defaultCheck.type = "checkbox";
    defaultCheck.style.cssText = `accent-color:${GOLD};cursor:pointer;`;
    defaultToggle.appendChild(defaultCheck);
    const defaultText = document.createElement("span");
    defaultText.textContent = xzgT("默认输出目录", "Default Output Dir");
    defaultToggle.appendChild(defaultText);
    settingsRow.appendChild(defaultToggle);
    // 自定义前缀
    const prefixLabel = document.createElement("label");
    prefixLabel.style.cssText = "font-size:11px;color:#ddd;display:flex;align-items:center;gap:4px;white-space:nowrap;";
    prefixLabel.textContent = xzgT("自定义前缀", "Custom Prefix");
    const prefixInput = document.createElement("input");
    prefixInput.type = "text";
    prefixInput.value = "xzg-save";
    prefixInput.style.cssText = "background:#2a2a2a;color:#ddd;border:1px solid #444;border-radius:2px;padding:2px 6px;font-size:11px;width:110px;";
    prefixLabel.appendChild(prefixInput);
    settingsRow.appendChild(prefixLabel);
    // 日期戳开关
    const dateToggle = document.createElement("label");
    dateToggle.style.cssText = "font-size:11px;color:#ddd;display:flex;align-items:center;gap:4px;cursor:pointer;user-select:none;white-space:nowrap;";
    const dateCheck = document.createElement("input");
    dateCheck.type = "checkbox";
    dateCheck.style.cssText = `accent-color:${GOLD};cursor:pointer;`;
    dateToggle.appendChild(dateCheck);
    const dateText = document.createElement("span");
    dateText.textContent = xzgT("日期戳", "Date Stamp");
    dateToggle.appendChild(dateText);
    settingsRow.appendChild(dateToggle);
    // 时间戳开关
    const timeToggle = document.createElement("label");
    timeToggle.style.cssText = "font-size:11px;color:#ddd;display:flex;align-items:center;gap:4px;cursor:pointer;user-select:none;white-space:nowrap;";
    const timeCheck = document.createElement("input");
    timeCheck.type = "checkbox";
    timeCheck.style.cssText = `accent-color:${GOLD};cursor:pointer;`;
    timeToggle.appendChild(timeCheck);
    const timeText = document.createElement("span");
    timeText.textContent = xzgT("时间戳", "Time Stamp");
    timeToggle.appendChild(timeText);
    settingsRow.appendChild(timeToggle);

    // 默认输出联动：开启后灰显并禁用 路径选择区 + 自定义前缀/日期戳/时间戳
    const _xzgApplyDefaultState = () => {
        const def = !!defaultCheck.checked;
        const setDisabled = (el, label, disabled) => {
            if (!el) return;
            el.disabled = disabled;
            el.style.opacity = disabled ? "0.4" : "1";
            if (label) label.style.opacity = disabled ? "0.4" : "1";
            if (label) label.style.cursor = disabled ? "not-allowed" : "pointer";
        };
        setDisabled(prefixInput, prefixLabel, def);
        setDisabled(dateCheck, dateToggle, def);
        setDisabled(timeCheck, timeToggle, def);
        // 路径选择区整体灰显并禁用交互
        const pathEls = [crumbWrap, newFolderBtn, listWrap, curPathLabel];
        pathEls.forEach(el => {
            if (!el) return;
            el.style.opacity = def ? "0.4" : "1";
            el.style.pointerEvents = def ? "none" : "auto";
        });
    };
    defaultCheck.addEventListener("change", _xzgApplyDefaultState);

    dlg.appendChild(settingsRow);
    dlg._prefixInput = prefixInput;
    dlg._dateCheck = dateCheck;
    dlg._timeCheck = timeCheck;
    dlg._defaultCheck = defaultCheck;
    dlg._applyDefaultState = _xzgApplyDefaultState;

    // ── 底部：路径 + 取消/选择 ──
    const footer = document.createElement("div");
    footer.style.cssText = `display:flex;align-items:center;justify-content:space-between;padding:5px 10px;border-top:1px solid #333;background:${BG3};gap:6px;flex-wrap:wrap;`;
    const curPathLabel = document.createElement("span");
    curPathLabel.style.cssText = "flex:1;font-size:10px;color:#888;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;";
    footer.appendChild(curPathLabel);
    dlg._curPathLabel = curPathLabel;

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = xzgT("取消", "Cancel");
    cancelBtn.style.cssText = `background:${BTN_BG};color:${TEXT};border:1px solid ${BTN_BORDER};border-radius:2px;padding:3px 12px;cursor:pointer;font-size:11px;`;
    cancelBtn.addEventListener("mouseenter", () => cancelBtn.style.background = "#3a3a3a");
    cancelBtn.addEventListener("mouseleave", () => cancelBtn.style.background = BTN_BG);
    cancelBtn.addEventListener("click", () => _xzgDirBrowserHide());
    const selectBtn = document.createElement("button");
    selectBtn.textContent = xzgT("选择", "Select");
    selectBtn.style.cssText = `background:${GOLD};color:#1e1e1e;border:1px solid ${GOLD};border-radius:2px;padding:3px 14px;cursor:pointer;font-size:11px;font-weight:bold;`;
    selectBtn.addEventListener("mouseenter", () => selectBtn.style.filter = "brightness(1.08)");
    selectBtn.addEventListener("mouseleave", () => selectBtn.style.filter = "");
    selectBtn.addEventListener("click", () => _xzgDirBrowserConfirm());
    footer.appendChild(cancelBtn);
    footer.appendChild(selectBtn);
    dlg.appendChild(footer);

    document.body.appendChild(dlg);

    // 点击对话框外部关闭
    window.addEventListener("pointerdown", (e) => {
        if (dlg.style.display === "flex" && !dlg.contains(e.target)) _xzgDirBrowserHide();
    }, true);
    // Escape 关闭
    window.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && dlg.style.display === "flex") _xzgDirBrowserHide();
    }, true);

    _xzgDirBrowserDlg = dlg;
    return dlg;
}

async function _xzgListDirsRequest(path) {
    const resp = await api.fetchApi("/xzg_list_dirs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: path || "" })
    });
    const txt = await resp.text();
    try {
        return JSON.parse(txt);
    } catch (e) {
        return { _raw: txt, _status: resp.status, _jsonErr: e };
    }
}

async function _xzgDirBrowserLoad(path) {
    const dlg = _xzgDirBrowserEnsureDlg();
    dlg._listWrap.innerHTML = `<div style="padding:20px;text-align:center;color:#666;font-size:11px;">${xzgT("加载中...", "Loading...")}</div>`;
    try {
        const data = await _xzgListDirsRequest(path);
        // JSON 解析失败（如 404）
        if (data._jsonErr) {
            console.error("[小珠光] /xzg_list_dirs 响应异常:", data._status, data._raw);
            const hint = data._status === 404
                ? xzgT("路由未注册，请重启 ComfyUI 后端", "Route not found, please restart ComfyUI backend")
                : `HTTP ${data._status}`;
            dlg._listWrap.innerHTML = `<div style="padding:20px;text-align:center;color:#f66;line-height:1.7;">`
                + `<div style="font-size:13px;margin-bottom:6px;">❌ ${hint}</div>`
                + `<div style="font-size:10px;color:#999;word-break:break-all;">${String(data._raw || "").substring(0, 160)}</div>`
                + `</div>`;
            return;
        }
        // 如果返回 "不是有效目录" 错误，自动爬上级目录找最近可访问路径
        if (data.error && /不是有效目录/.test(String(data.error))) {
            const fallback = _xzgClimbToValidParent(data.path || path || "");
            console.warn(`[小珠光] 路径无效 ${data.path || path}，回退到最近有效目录: ${fallback || "(我的电脑)"}`);
            const warnZh = "⚠ 路径无效，正在回退到最近有效目录...";
            const warnEn = "⚠ Invalid path, falling back to nearest valid directory...";
            dlg._listWrap.innerHTML = `<div style="padding:14px 20px;text-align:center;color:#dcc85b;font-size:11px;line-height:1.6;">`
                + `${xzgT(warnZh, warnEn)}${fallback ? "<br>" + fallback : "<br>" + xzgT("我的电脑", "This PC")}`
                + `</div>`;
            if (fallback === (data.path || path || "")) {
                // 爬到顶还是这个目录（已经是盘符根或 /），直接跳我的电脑
                await _xzgDirBrowserLoad("");
            } else if (fallback) {
                await _xzgDirBrowserLoad(fallback);
            } else {
                await _xzgDirBrowserLoad("");
            }
            return;
        }
        _xzgDirBrowserState.currentPath = data.path || "";
        _xzgDirBrowserState.parentPath = (data.parent !== undefined && data.parent !== "") ? data.parent : null;
        _xzgDirBrowserState.selectedPath = data.path || "";
        await _xzgDirBrowserRender(data);
    } catch (e) {
        console.error("[小珠光] 加载目录失败:", e);
        dlg._listWrap.innerHTML = `<div style="padding:20px;text-align:center;color:#f66;font-size:11px;">${xzgT("加载失败", "Load Failed")}: ${e}</div>`;
    }
}

// 把路径切成面包屑段（如 C:\Users\foo → ["我的电脑","C:","Users","foo"]，每段带跳转路径）
function _xzgSplitCrumbs(path) {
    const pcLabel = xzgT("我的电脑", "This PC");
    if (!path) return [{ label: pcLabel, path: "" }];
    // Windows: C:\Users\foo  -> ["C:\\", "Users", "foo"]
    // Unix:    /home/foo   -> ["/",      "home",  "foo"]
    const result = [{ label: pcLabel, path: "" }];
    let isWin = /^[A-Za-z]:/.test(path);
    let normalized = path.replace(/\\/g, "/").replace(/\/+/g, "/");
    if (isWin) {
        const parts = normalized.split("/").filter(Boolean);
        // parts[0] = "C:"
        let acc = "";
        for (let i = 0; i < parts.length; i++) {
            if (i === 0) {
                acc = parts[i] + "\\";
                result.push({ label: parts[i], path: acc });
            } else {
                acc = acc + (acc.endsWith("\\") ? "" : "\\") + parts[i];
                result.push({ label: parts[i], path: acc });
            }
        }
    } else {
        if (!normalized.startsWith("/")) normalized = "/" + normalized;
        const parts = normalized.split("/").filter(Boolean);
        let acc = "";
        for (let i = 0; i < parts.length; i++) {
            acc += "/" + parts[i];
            result.push({ label: parts[i], path: acc });
        }
    }
    return result;
}

async function _xzgDirBrowserRender(data) {
    const dlg = _xzgDirBrowserEnsureDlg();
    const wrap = dlg._listWrap;
    wrap.innerHTML = "";

    const GOLD = "#dcc85b";

    // 当前路径（作为默认选中）— 进入任何目录即默认选中该目录
    const currentPath = data.path || "";
    _xzgDirBrowserState.selectedPath = currentPath;
    dlg._curPathLabel.textContent = currentPath || "";
    dlg._curPathLabel.title = currentPath || "";

    // 新建文件夹按钮可用性
    const inRealDir = !!currentPath;
    dlg._newFolderBtn.style.opacity = inRealDir ? "1" : "0.35";
    dlg._newFolderBtn.style.pointerEvents = inRealDir ? "auto" : "none";

    // ── 渲染面包屑 ──
    const crumbWrap = dlg._crumbWrap;
    crumbWrap.innerHTML = "";
    const crumbs = _xzgSplitCrumbs(currentPath);
    crumbs.forEach((c, idx) => {
        const isLast = idx === crumbs.length - 1;
        if (idx > 0) {
            const sep = document.createElement("span");
            sep.style.cssText = "color:#555;font-size:11px;padding:0 2px;flex-shrink:0;";
            sep.textContent = "▸";
            crumbWrap.appendChild(sep);
        }
        const seg = document.createElement("span");
        seg.textContent = c.label;
        if (isLast) {
            seg.style.cssText = `font-size:11px;color:${GOLD};font-weight:bold;padding:1px 3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px;`;
        } else {
            seg.style.cssText = "font-size:11px;color:#888;padding:1px 3px;cursor:pointer;white-space:nowrap;";
            seg.addEventListener("mouseenter", () => { seg.style.color = "#ddd"; });
            seg.addEventListener("mouseleave", () => { seg.style.color = "#888"; });
            seg.addEventListener("click", () => _xzgDirBrowserLoad(c.path));
        }
        seg.title = c.path || c.label;
        crumbWrap.appendChild(seg);
    });

    // ── 最近使用目录（最多5个，localStorage 保存，最新在前）渲染到列表最顶部 ──
    try {
        const recent = _xzgRecentDirsGet();
        if (recent && recent.length) {
            const panel = document.createElement("div");
            panel.style.cssText = "margin:4px 2px 6px;padding:6px 8px;background:#252525;border:1px solid #333;border-radius:3px;";
            // 标题行：左侧标签 + 右侧清理按钮
            const header = document.createElement("div");
            header.style.cssText = `display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;`;
            const labelEl = document.createElement("div");
            labelEl.style.cssText = `font-size:10px;color:${GOLD};letter-spacing:0.5px;`;
            labelEl.textContent = xzgT("最近使用", "Recent");
            header.appendChild(labelEl);
            const clearBtn = document.createElement("span");
            clearBtn.textContent = "🗑";
            clearBtn.title = xzgT("清空最近使用", "Clear Recent");
            clearBtn.style.cssText = `font-size:14px;color:#ff5555;cursor:pointer;padding:0 6px;user-select:none;line-height:1;`;
            clearBtn.addEventListener("mouseenter", () => clearBtn.style.color = "#ff0000");
            clearBtn.addEventListener("mouseleave", () => clearBtn.style.color = "#ff5555");
            clearBtn.addEventListener("click", () => {
                _xzgRecentDirsClear();
                // 重新渲染当前列表（仅移除最近使用面板，保留其余）
                const cur = _xzgDirBrowserState.currentPath;
                _xzgDirBrowserLoad(cur);
            });
            header.appendChild(clearBtn);
            panel.appendChild(header);

            const row = document.createElement("div");
            row.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;";
            recent.slice(0, 5).forEach(p => {
                const chip = _xzgDirBrowserMakeChip("⏱", p, p);
                if (chip) row.appendChild(chip);
            });
            panel.appendChild(row);
            wrap.appendChild(panel);
        }
    } catch (_) { /* 忽略渲染失败，继续显示下方内容 */ }

    // 错误提示（非"不是有效目录"类的错误）
    if (data.error) {
        const err = document.createElement("div");
        err.style.cssText = "padding:8px 10px;color:#f66;font-size:11px;background:#2a1a1a;border-left:3px solid #f66;margin:4px 2px;";
        err.textContent = "⚠ " + data.error;
        wrap.appendChild(err);
    }

    // 我的电脑（当前在根层时）：C/D/E/F... 统一用 data.drives 列表显示
    if (data.drives && data.drives.length) {
        for (const drv of data.drives) {
            _xzgDirBrowserAddItem(wrap, drv.name + "\\", drv.full_path, true);
        }
        return;
    }

    // 列表第一项：⬆ 返回上级目录（若有上级）
    const hasParent = _xzgDirBrowserState.parentPath !== null;
    if (hasParent) {
        _xzgDirBrowserAddUpItem(wrap, _xzgDirBrowserState.parentPath);
    }

    // 子目录列表
    if (data.dirs && data.dirs.length) {
        for (const d of data.dirs) {
            _xzgDirBrowserAddItem(wrap, d.name, d.full_path, false);
        }
    } else if (!data.error) {
        const empty = document.createElement("div");
        empty.style.cssText = "padding:24px;text-align:center;color:#666;font-size:11px;";
        empty.textContent = xzgT("（此目录没有子文件夹）", "(No subfolders in this directory)");
        wrap.appendChild(empty);
    }
}

// "⬆ 返回上级目录"项：无需单独选中，点击即跳转
function _xzgDirBrowserAddUpItem(wrap, parentPath) {
    const item = document.createElement("div");
    item.style.cssText = "display:flex;align-items:center;gap:5px;padding:3px 8px;cursor:pointer;border-radius:2px;font-size:12px;line-height:1.5;";
    const icon = document.createElement("span");
    icon.style.cssText = "font-size:13px;width:16px;text-align:center;";
    icon.textContent = "⬆";
    const label = document.createElement("span");
    label.textContent = xzgT("返回上级目录", "Parent Directory");
    label.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#888;";
    item.appendChild(icon);
    item.appendChild(label);
    item.addEventListener("mouseenter", () => { item.style.background = "#353535"; label.style.color = "#ddd"; });
    item.addEventListener("mouseleave", () => { item.style.background = ""; label.style.color = "#888"; });
    item.addEventListener("click", () => _xzgDirBrowserLoad(parentPath));
    wrap.appendChild(item);
}

// 常用位置快捷按钮（芯片样式）
function _xzgDirBrowserMakeChip(icon, name, path, isDrive) {
    if (!path) return null;
    const GOLD = "#dcc85b";
    const chip = document.createElement("span");
    chip.style.cssText = [
        "display:inline-flex",
        "align-items:center",
        "gap:3px",
        "padding:2px 7px",
        "font-size:11px",
        "background:#1a1a1a",
        "border:1px solid #3a3a3a",
        "border-radius:10px",
        "cursor:pointer",
        "color:#ddd",
        "transition:all .12s",
        "user-select:none",
        "line-height:1.4",
    ].join(";");
    chip.innerHTML = `<span style="font-size:12px;line-height:1;">${icon || (isDrive ? "💾" : "📁")}</span><span>${name}</span>`;
    chip.title = path;
    chip.addEventListener("mouseenter", () => {
        chip.style.background = "#2c2a1c";
        chip.style.borderColor = GOLD;
        chip.style.color = GOLD;
    });
    chip.addEventListener("mouseleave", () => {
        chip.style.background = "#1a1a1a";
        chip.style.borderColor = "#3a3a3a";
        chip.style.color = "#ddd";
    });
    chip.addEventListener("click", () => _xzgDirBrowserLoad(path));
    return chip;
}

function _xzgDirBrowserAddItem(wrap, name, fullPath, isDrive) {
    const dlg = _xzgDirBrowserDlg;
    const GOLD = "#dcc85b";
    const item = document.createElement("div");
    item.style.cssText = "display:flex;align-items:center;gap:5px;padding:3px 8px;cursor:pointer;border-radius:2px;font-size:12px;line-height:1.5;";
    const icon = document.createElement("span");
    icon.style.cssText = "font-size:13px;width:16px;text-align:center;";
    icon.textContent = isDrive ? "💾" : "📁";
    const label = document.createElement("span");
    label.textContent = name;
    label.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    item.appendChild(icon);
    item.appendChild(label);

    const setIdle = () => {
        if (item.getAttribute("data-xzg-sel") !== "1") {
            item.style.background = "";
            label.style.color = "";
        }
    };
    const setHover = () => {
        if (item.getAttribute("data-xzg-sel") !== "1") {
            item.style.background = "#353535";
        }
    };
    const setSelected = () => {
        item.style.background = "rgba(220,200,91,0.15)";
        label.style.color = GOLD;
    };
    item.addEventListener("mouseenter", setHover);
    item.addEventListener("mouseleave", setIdle);
    // 单击：选中该子目录（作为目标路径）
    item.addEventListener("click", () => {
        _xzgDirBrowserState.selectedPath = fullPath;
        dlg._curPathLabel.textContent = fullPath;
        dlg._curPathLabel.title = fullPath;
        wrap.querySelectorAll('[data-xzg-sel="1"]').forEach(d => {
            d.removeAttribute("data-xzg-sel");
            d.style.background = "";
            const l = d.querySelector("span:last-child");
            if (l) l.style.color = "";
        });
        item.setAttribute("data-xzg-sel", "1");
        setSelected();
    });
    // 双击：进入该目录
    item.addEventListener("dblclick", () => _xzgDirBrowserLoad(fullPath));
    wrap.appendChild(item);
}

function _xzgDirBrowserConfirm() {
    const sel = _xzgDirBrowserState.selectedPath || _xzgDirBrowserState.currentPath;
    const node = _xzgDirBrowserState.targetNode;
    const widget = _xzgDirBrowserState.targetWidget;
    const dlg = _xzgDirBrowserEnsureDlg();
    if (widget && sel) {
        widget.value = sel;
        _xzgRecentDirsPush(sel);
        if (widget.callback) widget.callback(sel);
        console.log("[小珠光] 已选择保存目录:", sel);
    }
    // 保存"默认输出"、"自定义前缀"、"日期戳"、"时间戳"设置回节点
    if (node) {
        if (dlg._defaultCheck && node._xzgDefaultOutputWidget) {
            const v = !!dlg._defaultCheck.checked;
            node._xzgDefaultOutputWidget.value = v;
            if (node._xzgDefaultOutputWidget.callback) node._xzgDefaultOutputWidget.callback(v);
        }
        if (dlg._prefixInput && node._xzgPrefixCustomWidget) {
            // 允许保存空字符串（用户主动清空），由后端决定是否回退默认值
            const v = (dlg._prefixInput.value ?? "").trim();
            node._xzgPrefixCustomWidget.value = v;
            if (node._xzgPrefixCustomWidget.callback) node._xzgPrefixCustomWidget.callback(v);
        }
        if (dlg._dateCheck && node._xzgDateStampWidget) {
            const v = !!dlg._dateCheck.checked;
            node._xzgDateStampWidget.value = v;
            if (node._xzgDateStampWidget.callback) node._xzgDateStampWidget.callback(v);
        }
        if (dlg._timeCheck && node._xzgTimeStampWidget) {
            const v = !!dlg._timeCheck.checked;
            node._xzgTimeStampWidget.value = v;
            if (node._xzgTimeStampWidget.callback) node._xzgTimeStampWidget.callback(v);
        }
        node.setDirtyCanvas(true);
    }
    _xzgDirBrowserHide();
}

function _xzgDirBrowserHide() {
    if (_xzgDirBrowserDlg) _xzgDirBrowserDlg.style.display = "none";
}

async function _xzgShowDirBrowser(node) {
    const dlg = _xzgDirBrowserEnsureDlg();
    _xzgDirBrowserState.targetNode = node;
    let widget = null;
    if (node && node.widgets) {
        widget = node.widgets.find(w => w.name === "base_dir");
    }
    _xzgDirBrowserState.targetWidget = widget;
    // 回显当前节点的"默认输出"设置（必须先回显，后调用 _applyDefaultState）
    if (dlg._defaultCheck && node && node._xzgDefaultOutputWidget) {
        dlg._defaultCheck.checked = !!node._xzgDefaultOutputWidget.value;
    } else if (dlg._defaultCheck) {
        dlg._defaultCheck.checked = false;
    }
    // 回显当前节点的"自定义前缀"、"日期戳"、"时间戳"设置（允许回显空字符串）
    if (dlg._prefixInput && node && node._xzgPrefixCustomWidget) {
        dlg._prefixInput.value = node._xzgPrefixCustomWidget.value ?? "";
    } else if (dlg._prefixInput) {
        dlg._prefixInput.value = "xzg-save";
    }
    if (dlg._dateCheck && node && node._xzgDateStampWidget) {
        dlg._dateCheck.checked = !!node._xzgDateStampWidget.value;
    } else if (dlg._dateCheck) {
        dlg._dateCheck.checked = false;
    }
    if (dlg._timeCheck && node && node._xzgTimeStampWidget) {
        dlg._timeCheck.checked = !!node._xzgTimeStampWidget.value;
    } else if (dlg._timeCheck) {
        dlg._timeCheck.checked = false;
    }
    // 根据"默认输出"状态，同步灰显/启用 自定义前缀/日期戳/时间戳
    if (typeof dlg._applyDefaultState === "function") dlg._applyDefaultState();
    dlg.style.display = "flex";
    // 恢复上次拖动后的位置（若有），否则保持居中
    try {
        const raw = localStorage.getItem("xzgDirBrowserPos");
        if (raw) {
            const pos = JSON.parse(raw);
            if (pos && typeof pos.left === "string" && typeof pos.top === "string") {
                dlg.style.left = pos.left;
                dlg.style.top = pos.top;
                dlg.style.transform = "none";
            }
        }
    } catch (_) {}
    // 始终默认显示我的电脑（C/D/E/F），用户再点具体盘符进入
    await _xzgDirBrowserLoad("");
}

async function _xzgDirBrowserNewFolder() {
    const cur = _xzgDirBrowserState.currentPath;
    if (!cur) {
        alert(xzgT("请先进入某个盘符/目录后再新建文件夹", "Please enter a drive/directory first to create a new folder"));
        return;
    }
    const name = prompt(xzgT("输入新文件夹名称：", "Enter new folder name:"), xzgT("新建文件夹", "New Folder"));
    if (!name) return;
    try {
        const resp = await api.fetchApi("/xzg_mkdir", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ parent: cur, name: name })
        });
        const data = await resp.json();
        if (data.error) {
            alert("创建失败: " + data.error);
            return;
        }
        _xzgDirBrowserLoad(cur);  // 刷新当前目录
    } catch (e) {
        alert("创建失败: " + e);
    }
}

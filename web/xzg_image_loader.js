import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { xzgT, xzgTh } from "./xzg_i18n.js";
import { xzgEnableCanvasPanOnSpace } from "./xzg_save_utils.js";

// ═══════════════════════════════════════════════
//  小珠光图像加载器 · 前端
//  可视化图片卡片网格（参考 Apt_Preset 实现方式）
// ═══════════════════════════════════════════════

function getWidgetByName(node, name) {
    return node?.widgets?.find((w) => w.name === name);
}

function getImageListWidget(node) {
    return getWidgetByName(node, "image_list");
}

function getCardSizeWidget(node) {
    return getWidgetByName(node, "card_size");
}

function getIndexWidget(node) {
    return getWidgetByName(node, "index");
}

function getBatchModeWidget(node) {
    return getWidgetByName(node, "batch_mode");
}

function getMaskDataWidget(node) {
    return getWidgetByName(node, "mask_data");
}

function getCropDataWidget(node) {
    return getWidgetByName(node, "crop_data");
}

function getUploadModeWidget(node) {
    return getWidgetByName(node, "upload_mode");
}

function normalizeAnnotatedName(name) {
    const s = String(name || "").replace(/\r/g, "").trim();
    for (const suffix of ["[output]", "[input]", "[temp]"]) {
        const spaced = " " + suffix;
        if (s.endsWith(suffix) && !s.endsWith(spaced)) {
            return s.slice(0, -suffix.length) + spaced;
        }
    }
    return s;
}

function parseNameList(text) {
    return (text || "")
        .split("\n")
        .map((s) => normalizeAnnotatedName(String(s || "")))
        .filter((s) => s !== "");
}

function setNameList(node, names) {
    const w = getImageListWidget(node);
    if (!w) return;
    const next = Array.isArray(names) ? names : [];
    w.value = next.join("\n");
    w.callback?.(w.value);
}

function getCardSize(node) {
    if (node && node._xzgCardSize != null) return node._xzgCardSize;
    return 128;
}

function setCardSize(node, size) {
    if (!node) return;
    const v = Number(size);
    node._xzgCardSize = Number.isFinite(v) ? Math.floor(v) : 128;
}

// 自适应缩略图算法：确保所有缩略图在节点内完整显示，最大化利用空间
// 考虑卡片 border(1px) 的影响
// 返回 { size: 缩略图大小, cols: 最佳列数, totalWidth: 实际总宽, totalHeight: 实际总高 }
// 完全复刻小珠光图像预览的自适应算法
function computeAutoCardSize(containerWidth, containerHeight, imageCount, gap = 2) {
    const effW = containerWidth;
    const effH = containerHeight;

    if (imageCount <= 0 || effW <= 20 || effH <= 20) {
        return { size: 20, cols: 1 };
    }

    // 自动选最佳列数：缩略图在节点内完全可见，不低于 20px
    let bestCell = 0, bestCols = 1;
    const maxCols = Math.max(1, Math.floor(effW / 30));
    for (let c = 1; c <= maxCols; c++) {
        const rows = Math.ceil(imageCount / c);
        const cellW = (effW - gap * (c - 1)) / c;
        const cellH = (effH - gap * (rows - 1)) / rows;
        const cell = Math.min(cellW, cellH);
        if (cell > bestCell) { bestCell = cell; bestCols = c; }
    }
    const cell = Math.max(20, bestCell);
    return { size: Math.floor(cell), cols: bestCols };
}

function getIndex(node) {
    const w = getIndexWidget(node);
    const v = Number(w?.value);
    return Number.isFinite(v) ? Math.floor(v) : 0;
}

function setIndex(node, idx) {
    const w = getIndexWidget(node);
    if (!w) return;
    const v = Number(idx);
    w.value = Number.isFinite(v) ? Math.floor(v) : 0;
    w.callback?.(w.value);
}

function xzgConfirm(message, onOk) {
    const overlay = document.createElement("div");
    overlay.style.cssText =
        "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:999999;display:flex;align-items:center;justify-content:center;";
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    const dialog = document.createElement("div");
    dialog.style.cssText =
        "background:var(--comfy-menu-bg);border:1px solid var(--border-color);border-radius:8px;padding:20px 24px;min-width:320px;max-width:90vw;";
    dialog.onclick = (e) => e.stopPropagation();

    dialog.innerHTML = `
        <div style="font-size:13px;color:var(--input-text);margin-bottom:16px;line-height:1.5;">${message}</div>
        <div style="display:flex;gap:10px;justify-content:flex-end;">
            <button class="xzg-cancel-btn" style="padding:6px 16px;background:var(--comfy-input-bg);color:var(--input-text);border:1px solid var(--border-color);border-radius:4px;cursor:pointer;font-size:12px;">${xzgTh("取消", "Cancel")}</button>
            <button class="xzg-ok-btn" style="padding:6px 16px;background:#FFD700;color:#333;border:none;border-radius:4px;cursor:pointer;font-size:12px;">${xzgTh("确定", "OK")}</button>
        </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    dialog.querySelector(".xzg-cancel-btn").onclick = () => overlay.remove();
    dialog.querySelector(".xzg-ok-btn").onclick = () => {
        overlay.remove();
        onOk?.();
    };
}

function xzgAlert(message, onClose) {
    const overlay = document.createElement("div");
    overlay.style.cssText =
        "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:999999;display:flex;align-items:center;justify-content:center;";
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    const dialog = document.createElement("div");
    dialog.style.cssText =
        "background:var(--comfy-menu-bg);border:1px solid var(--border-color);border-radius:8px;padding:20px 24px;min-width:320px;max-width:90vw;";
    dialog.onclick = (e) => e.stopPropagation();

    dialog.innerHTML = `
        <div style="font-size:13px;color:var(--input-text);margin-bottom:16px;line-height:1.5;white-space:pre-wrap;">${message}</div>
        <div style="display:flex;gap:10px;justify-content:flex-end;">
            <button class="xzg-ok-btn" style="padding:6px 16px;background:#FFD700;color:#333;border:none;border-radius:4px;cursor:pointer;font-size:12px;">${xzgTh("确定", "OK")}</button>
        </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    dialog.querySelector(".xzg-ok-btn").onclick = () => {
        overlay.remove();
        onClose?.();
    };
}

function getThumbUrl(filename, size = 128) {
    return api.apiURL(`/xzg_image_loader_thumb?filename=${encodeURIComponent(filename)}&size=${encodeURIComponent(size)}`);
}

function getOriginalImageUrl(filename) {
    let type = "input";
    let name = filename;
    if (filename.endsWith(" [output]")) {
        type = "output";
        name = filename.slice(0, -" [output]".length);
    } else if (filename.endsWith(" [input]")) {
        name = filename.slice(0, -" [input]".length);
    } else if (filename.endsWith(" [temp]")) {
        type = "temp";
        name = filename.slice(0, -" [temp]".length);
    }
    return api.apiURL(`/view?filename=${encodeURIComponent(name)}&type=${type}`);
}

// 压缩预览 URL：复用缩略图端点，按最长边缩放到 3840px 并输出 JPG（带缓存）
function getPreviewUrl(filename) {
    return getThumbUrl(filename, 3840);
}

// 原始分辨率缓存：filename → {width, height}
const _xzgImgInfoCache = new Map();

// 异步获取图片原始分辨率（通过后端 /xzg_image_info API，仅读头信息，轻量）
// 返回 Promise<{width, height}>；失败时回退 null
async function _xzgFetchOriginalSize(filename) {
    if (!filename) return null;
    if (_xzgImgInfoCache.has(filename)) return _xzgImgInfoCache.get(filename);
    try {
        const url = api.apiURL(`/xzg_image_info?filename=${encodeURIComponent(filename)}`);
        const resp = await fetch(url);
        if (!resp.ok) { _xzgImgInfoCache.set(filename, null); return null; }
        const data = await resp.json();
        const result = (data && data.width && data.height) ? { width: data.width, height: data.height } : null;
        _xzgImgInfoCache.set(filename, result);
        return result;
    } catch (_) {
        _xzgImgInfoCache.set(filename, null);
        return null;
    }
}

async function uploadOneImage(file) {
    const body = new FormData();
    body.append("image", file, file.name);
    body.append("type", "input");
    const resp = await api.fetchApi("/upload/image", { method: "POST", body });
    if (!resp.ok) throw new Error(await resp.text());
    const json = await resp.json();
    return json?.name;
}

async function uploadFilesSequential(files) {
    const uploaded = [];
    for (const file of files || []) {
        if (!file) continue;
        if (file?.type && !String(file.type).startsWith("image/")) continue;
        try {
            const name = await uploadOneImage(file);
            if (name) uploaded.push(name);
        } catch (e) {
            console.error("Upload failed:", file.name, e);
        }
    }
    return uploaded;
}

// 记住上次保存图片的文件夹 handle，下次默认打开同一文件夹
let _lastImgLoaderSaveFileHandle = null;

// 图片扩展名 → MIME 类型映射
const IMG_LOADER_MIME_MAP = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    svg: "image/svg+xml",
};

/**
 * 保存图片：优先使用 File System Access API 弹出保存对话框，
 * 默认使用上次保存的文件夹，首次默认桌面；不支持则降级为普通下载（浏览器下载目录）
 */
async function xzgSaveImage(url, filename) {
    try {
        const resp = await fetch(url);
        if (!resp.ok) return;
        const blob = await resp.blob();
        const ext = (filename || "").split(".").pop()?.toLowerCase() || "png";
        const mimeType = blob.type || IMG_LOADER_MIME_MAP[ext] || "image/png";

        // 优先使用 File System Access API
        if (typeof window.showSaveFilePicker === "function") {
            try {
                const pickerOpts = {
                    suggestedName: filename || "image.png",
                    types: [{
                        description: xzgT("图片文件", "Image Files"),
                        accept: { [mimeType]: ["." + ext] },
                    }],
                };
                // 有上次保存的 handle 则用它定位文件夹，否则默认桌面
                if (_lastImgLoaderSaveFileHandle) {
                    pickerOpts.startIn = _lastImgLoaderSaveFileHandle;
                } else {
                    pickerOpts.startIn = "desktop";
                }
                const handle = await window.showSaveFilePicker(pickerOpts);
                const writable = await handle.createWritable();
                await writable.write(blob);
                await writable.close();
                // 记住本次保存的 handle，下次默认打开同一文件夹
                _lastImgLoaderSaveFileHandle = handle;
                return true;
            } catch (e) {
                // 用户取消对话框，直接返回，不进行降级下载
                if (e?.name === "AbortError") return false;
                // 其他错误（权限不足等），继续降级
            }
        }

        // 降级：普通下载（浏览器默认下载目录）
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
        return true;
    } catch (e) {
        if (e?.name === "AbortError") return false; // 用户取消
        console.warn("[小珠光] 保存图片失败:", e);
        return false;
    }
}

function createImgBatchUI(node) {
    const container = document.createElement("div");
    container.style.cssText =
        "width:100%;min-width:0;min-height:140px;box-sizing:border-box;overflow:hidden;padding:0;background:var(--comfy-menu-bg);border:1px solid var(--border-color);border-radius:4px;margin:0;display:flex;flex-direction:row;gap:0;z-index:10;position:relative;";
    container.style.userSelect = "none";
    container.style.webkitUserSelect = "none";
    // 启用空格+拖动平移画布（DOM widget 默认会拦截 pointer 事件）
    xzgEnableCanvasPanOnSpace(container);

    // Bypass 紫色覆盖层
    const bypassOverlay = document.createElement("div");
    bypassOverlay.style.cssText =
        "position:absolute;inset:0;background-color:rgba(106, 36, 106, 0.6);pointer-events:none;z-index:100;display:none;";
    container.appendChild(bypassOverlay);

    // 更新 bypass 状态
    const updateBypassState = () => {
        // NodeMode.BYPASS = 4
        if (node.mode === 4) {
            bypassOverlay.style.display = "block";
        } else {
            bypassOverlay.style.display = "none";
        }
    };
    updateBypassState();
    const contextMenu = document.createElement("div");
    contextMenu.style.cssText = `
        position: fixed;
        background: var(--comfy-menu-bg);
        border: 1px solid var(--border-color);
        border-radius: 6px;
        padding: 4px 0;
        min-width: 140px;
        z-index: 100000;
        display: none;
        box-shadow: 0 4px 16px rgba(0,0,0,0.4);
        font-size: 12px;
        color: var(--input-text);
        user-select: none;
    `;
    document.body.appendChild(contextMenu);

    const getSelectedNames = () => {
        const names = parseNameList(getImageListWidget(node)?.value);
        if (selectedIndexes.length > 0) {
            return selectedIndexes.map(i => names[i]).filter(Boolean);
        }
        return [];
    };

    const isImageSelected = (imageName) => {
        const names = parseNameList(getImageListWidget(node)?.value);
        const idx = names.indexOf(imageName);
        return selectedIndexes.includes(idx);
    };

    const showContextMenu = (x, y, imageName) => {
        contextMenu.innerHTML = "";
        const selectedNames = getSelectedNames();
        const rightClickSelected = isImageSelected(imageName);
        const multi = rightClickSelected && selectedNames.length > 1;
        const targetNames = multi ? selectedNames : [imageName];

        const saveItem = document.createElement("div");
        saveItem.textContent = multi ? `${xzgT("保存选中图片", "Save Selected Images")} (${selectedNames.length}${xzgT("张", "")})` : xzgT("保存图片", "Save Image");
        saveItem.style.cssText = "padding:6px 14px;cursor:pointer;white-space:nowrap;";
        saveItem.addEventListener("mouseenter", () => { saveItem.style.background = "var(--comfy-input-bg)"; });
        saveItem.addEventListener("mouseleave", () => { saveItem.style.background = ""; });
        saveItem.addEventListener("click", async () => {
            hideContextMenu();
            for (let i = 0; i < targetNames.length; i++) {
                const n = targetNames[i];
                const url = getOriginalImageUrl(n);
                // 从文件名中提取实际文件名（去掉 [output] [input] [temp] 后缀）
                let realName = n;
                for (const suffix of [" [output]", " [input]", " [temp]"]) {
                    if (realName.endsWith(suffix)) {
                        realName = realName.slice(0, -suffix.length);
                        break;
                    }
                }
                await xzgSaveImage(url, realName);
            }
        });
        contextMenu.appendChild(saveItem);

        contextMenu.style.left = `${x}px`;
        contextMenu.style.top = `${y}px`;
        contextMenu.style.display = "block";

        const rect = contextMenu.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
            contextMenu.style.left = `${window.innerWidth - rect.width - 4}px`;
        }
        if (rect.bottom > window.innerHeight) {
            contextMenu.style.top = `${window.innerHeight - rect.height - 4}px`;
        }
    };

    const hideContextMenu = () => {
        contextMenu.style.display = "none";
    };

    // 裁剪模式右键菜单：应用待选区 / 清空裁剪
    const showCropContextMenu = (x, y) => {
        contextMenu.innerHTML = "";
        const makeItem = (label, color) => {
            const item = document.createElement("div");
            item.textContent = label;
            item.style.cssText = `padding:6px 14px;cursor:pointer;white-space:nowrap;color:${color || "var(--input-text)"};`;
            item.addEventListener("mouseenter", () => { item.style.background = "var(--comfy-input-bg)"; });
            item.addEventListener("mouseleave", () => { item.style.background = ""; });
            return item;
        };
        // 应用裁剪（绿）：与左侧"应用裁剪"按钮一致
        const applyItem = makeItem(xzgT("应用裁剪", "Apply Crop"), "#66CC66");
        applyItem.title = xzgT("以当前选区裁剪图片", "Crop image to current selection");
        applyItem.addEventListener("click", () => {
            hideContextMenu();
            _applyCrop();
        });
        contextMenu.appendChild(applyItem);
        if (_cropPending) {
            // 清除选框（红）：与左侧"清除选框"按钮一致
            const selItem = makeItem(xzgT("清除选框", "Clear Sel"), "#FF6B6B");
            selItem.addEventListener("click", () => {
                hideContextMenu();
                _cropPending = null;
                _cropSelStart = _cropSelCur = null;
                _renderMaskOverlay();
            });
            contextMenu.appendChild(selItem);
        }
        if (_cropPending || cropRect) {
            // 恢复原始（蓝）：与左侧"恢复原始"按钮一致
            const clearItem = makeItem(xzgT("恢复原始", "Restore Original"), "#4A90E2");
            clearItem.addEventListener("click", () => {
                hideContextMenu();
                cropRect = null;
                _cropPending = null;
                _commitCropToWidget();
                _refreshCropPreview(); // 恢复原图显示
                _renderMaskOverlay();
                _updateSingleResLabel();
            });
            contextMenu.appendChild(clearItem);
        }
        contextMenu.style.left = `${x}px`;
        contextMenu.style.top = `${y}px`;
        contextMenu.style.display = "block";
        const rect = contextMenu.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
            contextMenu.style.left = `${window.innerWidth - rect.width - 4}px`;
        }
        if (rect.bottom > window.innerHeight) {
            contextMenu.style.top = `${window.innerHeight - rect.height - 4}px`;
        }
    };

    const dismissContextMenu = (e) => {
        if (contextMenu.style.display === "block" && !contextMenu.contains(e.target)) {
            hideContextMenu();
        }
    };
    // 在 window 捕获阶段监听，确保点击画布等任意位置都能关闭菜单
    // 左键 / 触摸点击空白处，以及在画布任意位置右键，都能关闭菜单
    window.addEventListener("mousedown", dismissContextMenu, true);
    window.addEventListener("pointerdown", dismissContextMenu, true);
    window.addEventListener("contextmenu", dismissContextMenu, true);

    // ═══════════ 遮罩绘制状态 ═══════════
    let maskEnabled = false;               // 遮罩绘制模式是否开启
    let maskTool = "brush";                // brush | eraser
    let brushSize = 30;                    // 画笔大小 px
    let _maskRightErasing = false;         // 右键擦除中（临时覆盖 maskTool 为 eraser）
    let _maskDrawing = false;
    let _maskLastPt = null;
    let _maskHoverPt = null;               // 鼠标在 overlay 上的 CSS 像素坐标，用于笔刷预览
    let _lastCursorZoom = 0;               // 缓存上次光标更新时的 zoom，避免频繁重建
    let _altBrushActive = false;           // Alt+右键按下拖动：调整笔刷大小
    let _altBrushStartX = 0;               // Alt+右键拖动起始 X 坐标
    let _altBrushStartSize = 0;            // Alt+右键拖动起始笔刷大小
    let _maskOrigSize = null;               // 记录遮罩开启前的节点原始大小
    let _maskOrigCanvas = null;              // 记录遮罩开启前的画布状态 { scale, offset }
    let _maskImgZoom = 1;                    // 图片缩放倍率（1x~8x）
    let _maskTx = 0;                         // 当前 CSS translateX（增量累积）
    let _maskTy = 0;                         // 当前 CSS translateY（增量累积）
    let _lastKnownMouseX = 0;                // 全局跟踪的鼠标 X（相对容器），wheel 事件可能坐标滞后
    let _lastKnownMouseY = 0;                // 全局跟踪的鼠标 Y（相对容器）
    // 遮罩离屏 canvas：始终保存"原图尺寸"的遮罩数据，不受 DOM 显示缩放影响
    const maskOffscreen = document.createElement("canvas");
    const maskOffCtx = maskOffscreen.getContext("2d");
    // 记录当前遮罩对应哪张图（文件名），切图时自动重建
    let _maskBoundImageName = null;
    // 遮罩原图真实尺寸（像素），用于映射绘制坐标
    let _maskImgNaturalW = 0;
    let _maskImgNaturalH = 0;

    // ═══════════ 裁剪选区状态（仅单图模式可用，与遮罩同入口） ═══════════
    let cropEnabled = false;            // 裁剪选区模式是否开启
    let cropRect = null;                // 原图像素 { x, y, w, h }，null = 无裁剪
    let _cropOrigSize = null;           // 记录裁剪开启前的节点原始大小
    let _cropOrigCanvas = null;         // 记录裁剪开启前的画布状态 { scale, offset }
    let _cropDrawing = false;           // 拖拽选择矩形中
    let _cropSelStart = null;           // 选区起点（原图像素）
    let _cropSelCur = null;             // 选区当前点（原图像素，拖拽中）
    let _cropPending = null;            // 拖拽出的待应用选区（原图像素），右键「应用裁剪」或双击后才生效
    let _cropResizeCorner = null;       // 正在拖动的裁剪框角（"tl"/"tr"/"bl"/"br"）或 null
    let _cropResizeBase = null;         // 拖动角开始时待选框（原图像素），用于重算
    let _cropResizeAnchorPos = null;    // 拖动角时固定的对角锚点（原图像素 [x,y]）
    let _cropMove = false;              // 是否正在拖动裁剪框整体移动位置
    let _cropMoveStart = null;          // 移动起点（原图像素 [x,y]）
    let _cropMoveBase = null;           // 移动开始时待选框（原图像素 {x,y,w,h}）
    let _cropAspect = null;             // 裁剪比例约束（如 9/16、16/9…），null = 自由比例

    const getImgNameFromEvent = (e) => {
        const cell = e.target.closest("[data-xzg-img-card]");
        if (cell) {
            const idx = parseInt(cell.dataset.xzgIndex, 10);
            const names = parseNameList(getImageListWidget(node)?.value);
            return names[idx];
        }
        if (e.target.closest("#xzg-single-img-container")) {
            const names = parseNameList(getImageListWidget(node)?.value);
            const idx = getIndex(node);
            return names[idx >= 0 && idx < names.length ? idx : 0];
        }
        return null;
    };

    container.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        // 裁剪模式下右键弹出「应用裁剪 / 清空裁剪」菜单
        if (cropEnabled) {
            showCropContextMenu(e.clientX, e.clientY);
            return;
        }
        const imgName = getImgNameFromEvent(e);
        if (imgName) {
            showContextMenu(e.clientX, e.clientY, imgName);
        }
    });

    const sidebar = document.createElement("div");
    // 宽度收缩为内容自适应（按钮已无边框无底色，固定 52px 纯属浪费），
    // 让左侧按钮列尽量靠左、占位最少，图像预览区拿到最大宽度
    sidebar.style.cssText = "display:flex;flex-direction:column;gap:2px;width:auto;min-width:0;flex:0 0 auto;pointer-events:auto;";

    // 画布态侧栏图标集（24 视口 / 1.8px 描边 / 圆角端点，stroke=currentColor 继承按钮前景色）
    const ICON_STR = {
        upload: '<svg viewBox="0 0 24 24"><path d="M12 17V6"/><path d="M6 11l6-6 6 6"/><path d="M4 19h16"/></svg>',
        input: '<svg viewBox="0 0 24 24"><path d="M3 8a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v5"/><path d="M9 13l3 3 3-3"/></svg>',
        output: '<svg viewBox="0 0 24 24"><path d="M3 8a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 14V9"/><path d="M9 12l3-3 3 3"/></svg>',
        del: '<svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>',
        clear: '<svg viewBox="0 0 24 24"><path d="M19 5L9.5 14.5"/><path d="M8 19l-3 3"/><path d="M13 20.5l-4 4"/><path d="M6.5 8.5l.01 0"/><path d="M10 6l.01 0"/><path d="M15 17l-2 2"/><path d="M12.5 12.5L17 8"/></svg>',
        mask: '<svg class="xzg-ic-mask" viewBox="0 0 24 24"><circle class="mr" cx="12" cy="12" r="9.5"/><path class="ml" d="M12 2.5 A9.5 9.5 0 0 1 21.5 12 A9.5 9.5 0 0 1 12 21.5 A4.75 4.75 0 0 1 12 12 A4.75 4.75 0 0 0 12 2.5 Z"/><circle class="o" cx="12" cy="12" r="9.5"/><circle class="er" cx="12" cy="16.75" r="1.15"/></svg>',
        crop: '<svg viewBox="0 0 24 24"><path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/></svg>'
    };

    if (!document.getElementById("xzg-side-ic-style")) {
        const _ics = document.createElement("style");
        _ics.id = "xzg-side-ic-style";
        _ics.textContent = `
            .xzg-ic-btn{display:flex;align-items:center;justify-content:flex-start;gap:6px;width:100%;padding:4px 2px;box-sizing:border-box;border:none;background:transparent;border-radius:4px;cursor:pointer;color:var(--input-text);white-space:nowrap;}
            .xzg-ic-btn:hover{filter:brightness(1.2);}
            .xzg-ic-btn svg{width:20px;height:20px;flex:0 0 auto;display:block;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round;}
            .xzg-ic-btn .xzg-ic-g{display:inline-flex;}
            .xzg-ic-btn .xzg-ic-lb{display:none;overflow:hidden;text-overflow:ellipsis;}
            .xzg-edit .xzg-ic-btn{justify-content:center;}
            .xzg-edit .xzg-ic-btn .xzg-ic-lb{display:inline;}
            .xzg-edit .xzg-ic-btn .xzg-ic-g{display:none;}
            :root{--xzg-mask-dark:#000000;--xzg-mask-light:#f5f5f5;}
            [data-theme="light"]{--xzg-mask-dark:#000000;--xzg-mask-light:#fafafa;}
            .xzg-ic-btn .xzg-ic-mask .o{fill:none;stroke:currentColor;stroke-width:1.5;stroke-linejoin:round;}
            .xzg-ic-btn .xzg-ic-mask .ml{fill:var(--xzg-mask-light);stroke:none;}
            .xzg-ic-btn .xzg-ic-mask .mr{fill:var(--xzg-mask-dark);stroke:none;}
            .xzg-ic-btn .xzg-ic-mask .el{fill:var(--xzg-mask-dark);stroke:none;}
            .xzg-ic-btn .xzg-ic-mask .er{fill:var(--xzg-mask-light);stroke:none;}
        `;
        document.head.appendChild(_ics);
    }

    const mkBtn = (label, title, iconKey) => {
        const b = document.createElement("button");
        b.title = title || label;
        b.className = "xzg-ic-btn";
        if (iconKey) {
            const g = document.createElement("span");
            g.className = "xzg-ic-g";
            g.innerHTML = ICON_STR[iconKey];
            const lb = document.createElement("span");
            lb.className = "xzg-ic-lb";
            lb.textContent = label;
            b.__lb = lb;
            b.appendChild(g);
            b.appendChild(lb);
            b.style.cssText = "font-size:11px;line-height:1.4;width:100%;";
        } else {
            b.textContent = label;
            b.style.cssText =
                "font-size:11px;line-height:1.4;width:100%;text-align:left;overflow:hidden;text-overflow:ellipsis;";
        }
        b.addEventListener("mouseenter", () => {
            b.style.filter = "brightness(1.2)";
        });
        b.addEventListener("mouseleave", () => {
            b.style.filter = "";
        });
        return b;
    };

    const uploadBtn = mkBtn(xzgT("上传", "Upload"), xzgT("上传图片（可多选）", "Upload images (multi-select)"), "upload");
    const folderBtn = mkBtn(xzgT(".input", ".input"), xzgT("从input文件夹选择", "Select from input folder"), "input");
    const outputBtn = mkBtn(xzgT(".output", ".output"), xzgT("从output文件夹选择", "Select from output folder"), "output");
    const deleteBtn = mkBtn(xzgT("删除", "Delete"), xzgT("删除选中", "Delete selected"), "del");
    const clearBtn = mkBtn(xzgT("清空", "Clear"), xzgT("清空全部", "Clear all"), "clear");

    // 5个操作按钮包在组内，加大间距
    const actionGroup = document.createElement("div");
    actionGroup.style.cssText = "display:flex;flex-direction:column;gap:6px;width:100%;";
    actionGroup.appendChild(uploadBtn);
    actionGroup.appendChild(folderBtn);
    actionGroup.appendChild(outputBtn);
    actionGroup.appendChild(deleteBtn);
    actionGroup.appendChild(clearBtn);
    sidebar.appendChild(actionGroup);

    // 初始化：优先从 upload_mode widget 里恢复上次保存的值（append=多图 / replace=单图）
    function _readUploadMode() {
        const w = getUploadModeWidget(node);
        const v = String(w?.value || "").trim().toLowerCase();
        return (v === "replace") ? "replace" : "append";
    }
    // 写入 widget：持久化上传模式，刷新/保存后能恢复
    function _writeUploadMode(mode) {
        const w = getUploadModeWidget(node);
        if (!w) return;
        const m = mode === "replace" ? "replace" : "append";
        if (w.value !== m) {
            w.value = m;
            w.callback?.(m);
        }
    }
    let uploadMode = _readUploadMode();
    let viewMode = uploadMode === "append" ? "grid" : "single";

    // 从 widget 重新同步 uploadMode 和 viewMode（onConfigure 恢复 widget 值后调用）
    function _syncUploadModeFromWidget() {
        const newMode = _readUploadMode();
        if (newMode === uploadMode) return;
        uploadMode = newMode;
        viewMode = uploadMode === "append" ? "grid" : "single";
        if (uploadMode === "append") {
            maskEnabled = false;
            _resetImgZoom();
        }
        updateUploadModeBtn();
        _refreshMaskToolbar();
        _updateMaskCursor();
        redraw(true);
    }

    const uploadModeBtn = document.createElement("button");
    uploadModeBtn.style.cssText =
        "padding:4px 2px;background:transparent;color:var(--input-text);border:none;border-radius:4px;cursor:pointer;font-size:11px;line-height:1.4;width:100%;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-sizing:border-box;";
    uploadModeBtn.addEventListener("mouseenter", () => {
        uploadModeBtn.style.filter = "brightness(1.2)";
    });
    uploadModeBtn.addEventListener("mouseleave", () => {
        uploadModeBtn.style.filter = "";
    });
    uploadModeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const wasAppend = uploadMode === "append";
        uploadMode = uploadMode === "append" ? "replace" : "append";
        viewMode = uploadMode === "append" ? "grid" : "single";
        // 保存到 widget，随工作流持久化
        _writeUploadMode(uploadMode);
        // 切到多图模式自动关闭遮罩绘制
        if (uploadMode === "append") {
            maskEnabled = false;
            _resetImgZoom();
        }
        // 切换到单图模式时，只保留第一张图片
        if (wasAppend && uploadMode === "replace") {
            const names = parseNameList(getImageListWidget(node)?.value);
            if (names.length > 1) {
                setNameList(node, [names[0]]);
                setIndex(node, 0);
            }
        }
        updateUploadModeBtn();
        _refreshMaskToolbar();
        _updateMaskCursor();
        redraw(true);
    });

    const updateUploadModeBtn = () => {
        uploadModeBtn.textContent = uploadMode === "append" ? xzgT("多图", "Multi") : xzgT("单图", "Single");
        uploadModeBtn.title = uploadMode === "append" ? xzgT("批量加载图片模式", "Batch Load Mode") : xzgT("单图加载模式", "Single Load Mode");
        uploadModeBtn.style.border = "none";
        uploadModeBtn.style.background = "transparent";
        uploadModeBtn.style.color = "#FF6B6B";
    };
    updateUploadModeBtn();

    const modeBtn = document.createElement("button");
    modeBtn.style.cssText =
        "padding:4px 2px;background:transparent;color:var(--input-text);border:none;border-radius:4px;cursor:pointer;font-size:11px;line-height:1.4;width:100%;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-sizing:border-box;";
    modeBtn.addEventListener("mouseenter", () => {
        modeBtn.style.filter = "brightness(1.2)";
    });
    modeBtn.addEventListener("mouseleave", () => {
        modeBtn.style.filter = "";
    });

    const getSelColor = () => {
        const w = getBatchModeWidget(node);
        return w?.value === true ? "#66CC66" : "#6699FF";
    };

    const updateModeBtn = () => {
        const w = getBatchModeWidget(node);
        const isBatch = w?.value === true;
        const names = parseNameList(getImageListWidget(node)?.value || "");
        const singleImg = names.length <= 1;
        // 单图加载模式时也禁用
        const isSingleMode = uploadMode === "replace";
        const disabled = singleImg || isSingleMode;
        
        modeBtn.textContent = isBatch ? xzgT("批次", "Batch") : xzgT("列表", "List");
        if (disabled) {
            modeBtn.title = isSingleMode ? xzgT("单图加载模式下不可用", "Not available in single mode") : "";
            modeBtn.style.border = "none";
            modeBtn.style.color = "#666";
            modeBtn.style.cursor = "default";
            modeBtn.style.opacity = "0.4";
        } else {
            modeBtn.title = isBatch ? xzgT("切换为列表模式", "Switch to List Mode") : xzgT("切换为批次模式", "Switch to Batch Mode");
            modeBtn.style.border = "none";
            modeBtn.style.color = isBatch ? "#66CC66" : "#6699FF";
            modeBtn.style.cursor = "pointer";
            modeBtn.style.opacity = "1";
        }
        const cards = grid.querySelectorAll("[data-xzg-img-card]");
        const color = getSelColor();
        cards.forEach((cell, i) => {
            const card = cell.querySelector(":scope > div");
            if (card && selectedIndexes.includes(i)) {
                card.style.borderColor = color;
            }
        });
    };
    
    modeBtn.onclick = (e) => {
        e.stopPropagation();
        const names = parseNameList(getImageListWidget(node)?.value || "");
        if (names.length <= 1) return; // 单图时禁止切换
        if (uploadMode === "replace") return; // 单图加载模式时禁止切换
        const w = getBatchModeWidget(node);
        if (!w) return;
        w.value = !w.value;
        w.callback?.(w.value);
        updateModeBtn();
    };

    const bottomGroup = document.createElement("div");
    bottomGroup.style.cssText = "display:flex;flex-direction:column;gap:2px;width:100%;margin-top:auto;";
    bottomGroup.appendChild(uploadModeBtn);
    bottomGroup.appendChild(modeBtn);
    sidebar.appendChild(bottomGroup);

    // ═══════════ 遮罩绘制工具栏（左侧面板，清空按钮下方） ═══════════
    const maskToolbar = document.createElement("div");
    maskToolbar.style.cssText = "display:none;flex-direction:column;gap:2px;width:100%;";
    const _mkMaskBtn = (label, title, iconKey) => {
        const b = document.createElement("button");
        b.title = title || label;
        if (iconKey) {
            b.className = "xzg-ic-btn";
            const g = document.createElement("span");
            g.className = "xzg-ic-g";
            g.innerHTML = ICON_STR[iconKey];
            const lb = document.createElement("span");
            lb.className = "xzg-ic-lb";
            lb.textContent = label;
            b.__lb = lb;
            b.appendChild(g);
            b.appendChild(lb);
            b.style.cssText = "font-size:11px;line-height:1.4;width:100%;";
        } else {
            b.textContent = label;
            // 编辑界面（遮罩/裁剪工具栏）保持原设计：文字居中
            b.style.cssText =
                "padding:4px 2px;background:transparent;color:var(--input-text);border:none;border-radius:4px;cursor:pointer;font-size:11px;line-height:1.4;width:100%;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-sizing:border-box;";
        }
        b.addEventListener("mouseenter", () => { b.style.filter = "brightness(1.2)"; });
        b.addEventListener("mouseleave", () => { b.style.filter = ""; });
        return b;
    };
    const maskToggleBtn = _mkMaskBtn(xzgT("遮罩", "Mask"), xzgT("开启/关闭遮罩绘制模式（仅单图模式）", "Toggle mask drawing (single mode only)"), "mask");
    const maskBrushBtn = _mkMaskBtn(xzgT("画笔", "Brush"), xzgT("切换到画笔工具", "Switch to Brush"));
    const maskEraserBtn = _mkMaskBtn(xzgT("橡皮", "Eraser"), xzgT("切换到橡皮擦工具", "Switch to Eraser"));
    const maskClearBtn = _mkMaskBtn(xzgT("清空", "Clear"), xzgT("清除整个遮罩", "Clear mask"));
    const maskInvertBtn = _mkMaskBtn(xzgT("反相", "Invert"), xzgT("反相遮罩黑白区域", "Invert mask B/W"));

    // 画笔大小滑条
    const brushSizeRow = document.createElement("div");
    brushSizeRow.style.cssText = "display:flex;flex-direction:column;gap:1px;padding:2px 2px;";
    const brushSizeLabel = document.createElement("div");
    brushSizeLabel.style.cssText = "font-size:10px;color:var(--input-text);text-align:center;line-height:1.3;";
    brushSizeLabel.textContent = `${xzgT("笔刷", "Brush")}:${brushSize}`;
    const brushSizeInput = document.createElement("input");
    brushSizeInput.type = "range";
    brushSizeInput.min = "1";
    brushSizeInput.max = "200";
    brushSizeInput.value = String(brushSize);
    brushSizeInput.style.cssText = "width:100%;margin:0;accent-color:#FFD700;";
    brushSizeInput.addEventListener("input", () => {
        brushSize = parseInt(brushSizeInput.value, 10) || 1;
        brushSizeLabel.textContent = `${xzgT("笔刷", "Brush")}:${brushSize}`;
        _updateMaskCursor();
        _renderBrushPreview();
    });
    brushSizeRow.appendChild(brushSizeLabel);
    brushSizeRow.appendChild(brushSizeInput);

    maskToolbar.appendChild(maskToggleBtn);
    maskToolbar.appendChild(brushSizeRow);
    maskToolbar.appendChild(maskBrushBtn);
    maskToolbar.appendChild(maskEraserBtn);
    maskToolbar.appendChild(maskClearBtn);
    maskToolbar.appendChild(maskInvertBtn);

    // 裁剪选区按钮（与遮罩同一工具栏，仅单图模式显示，互斥开启）
    const cropToggleBtn = _mkMaskBtn(xzgT("裁剪", "Crop"), xzgT("开启/关闭裁剪选区（仅单图模式）", "Toggle crop region (single mode only)"), "crop");
    const cropClearBtn = _mkMaskBtn(xzgT("恢复原始", "Restore Original"), xzgT("撤销裁剪，恢复原图", "Reset crop"));
    // 清除当前待选框并解除拖选锁定，便于重新框选
    const cropSelClearBtn = _mkMaskBtn(xzgT("清除选框", "Clear Sel"), xzgT("清除当前裁剪选框，可重新框选", "Clear current crop selection"));
    // 应用裁剪：把当前选框正式应用到图片
    const cropApplyBtn = _mkMaskBtn(xzgT("应用裁剪", "Apply Crop"), xzgT("应用当前裁剪选框", "Apply current crop region"));
    // 比例裁剪下拉：自由 / 9:16 / 16:9 / 1:1 / 2:3 / 3:2 / 3:4 / 4:3
    const _cropRatios = [["自由", null], ["9:16", 9 / 16], ["16:9", 16 / 9], ["1:1", 1], ["2:3", 2 / 3], ["3:2", 3 / 2], ["3:4", 3 / 4], ["4:3", 4 / 3]];
    const cropRatioRow = document.createElement("div");
    // 编辑界面保持原横向设计（标签+下拉框同行，对齐 hack 在 _refreshMaskToolbar 内）
    cropRatioRow.style.cssText = "display:flex;align-items:center;gap:4px;padding:2px 0;box-sizing:border-box;";
    const cropRatioLabel = document.createElement("span");
    cropRatioLabel.textContent = xzgT("裁剪比例", "Crop Ratio");
    cropRatioLabel.style.cssText = "color:var(--input-text);font-size:11px;white-space:nowrap;flex-shrink:0;";
    const cropRatioSelect = document.createElement("select");
    cropRatioSelect.style.cssText =
        "flex:1;min-width:0;background:var(--comfy-input-bg);color:#FFD700;font-weight:bold;border:1px solid var(--border-color);border-radius:4px;cursor:pointer;font-size:11px;line-height:1.4;padding:4px 2px;box-sizing:border-box;outline:none;";
    cropRatioSelect.style.boxShadow = "none";
    _cropRatios.forEach(([label, ratio]) => {
        const opt = document.createElement("option");
        opt.textContent = label;
        opt.value = ratio === null ? "free" : String(ratio);
        opt.style.color = "#FFFFFF"; // 下拉列表选项白字
        cropRatioSelect.appendChild(opt);
    });
    cropRatioSelect.value = "free"; // 默认为“自由”
    // 统一刷新下拉选中值（依据当前 _cropAspect）
    const refreshCropRatioUI = () => {
        cropRatioSelect.value = _cropAspect === null || _cropAspect === undefined ? "free" : String(_cropAspect);
    };
    // 清除当前裁剪框（待选框 / 已应用裁剪）及选区与拖拽状态，切换到新比例重新框选
    function _clearCropBox() {
        _cropPending = null;
        cropRect = null;
        _cropResizeCorner = null; _cropResizeBase = null; _cropResizeAnchorPos = null;
        _cropMove = false; _cropMoveStart = null; _cropMoveBase = null;
        _cropSelStart = _cropSelCur = null;
        _cropDrawing = false;
    }
    cropRatioSelect.addEventListener("change", (e) => {
        e.stopPropagation();
        const val = cropRatioSelect.value;
        const ratio = val === "free" ? null : parseFloat(val);
        _cropAspect = ratio; // null 即自由比例
        refreshCropRatioUI();
        // 无论切换到具体比例还是自由，都清除现有裁剪框，避免旧框在自由模式下残留
        _clearCropBox();
        _commitCropToWidget();
        _resetImgZoom();
        _refreshCropPreview();
        _renderMaskOverlay();
        _updateSingleResLabel();
    });
    refreshCropRatioUI(); // 默认选中"自由"（_cropAspect 初始为 null）
    cropRatioRow.appendChild(cropRatioLabel);
    cropRatioRow.appendChild(cropRatioSelect);
    maskToolbar.appendChild(cropToggleBtn);
    maskToolbar.appendChild(cropApplyBtn);
    maskToolbar.appendChild(cropClearBtn);
    maskToolbar.appendChild(cropSelClearBtn);
    maskToolbar.appendChild(cropRatioRow);
    actionGroup.appendChild(maskToolbar);

    // 统一的显示状态同步（只在这个函数里改 overlay/eventLayer 的 pointer-events/display，避免多改冲突）
    const _syncMaskLayerVisibility = () => {
        const isSingle = uploadMode === "replace";
        // 遮罩覆盖层始终显示（单图模式下），不受 maskEnabled 影响
        singleMaskOverlay.style.display = isSingle ? "block" : "none";
        singleMaskOverlay.style.pointerEvents = "none";
        // 事件层和笔刷预览仅在绘制模式开启时显示
        const shouldEdit = isSingle && (maskEnabled || cropEnabled);
        singleMaskEventLayer.style.display = shouldEdit ? "block" : "none";
        singleMaskEventLayer.style.pointerEvents = "none";
        if (!shouldEdit) {
            singleBrushPreview.style.display = "none";
            _maskHoverPt = null;
        }
        // singleImgContainer 的 cursor
        if (shouldEdit) {
            singleImgContainer.style.cursor = "crosshair";
        } else {
            singleImgContainer.style.cursor = "";
        }
    };

    // 刷新遮罩工具栏按钮高亮状态
    const _refreshMaskToolbar = () => {
        const isSingle = uploadMode === "replace";
        maskToolbar.style.display = isSingle ? "flex" : "none";
        const editing = maskEnabled || cropEnabled;
        // 编辑界面（遮罩/裁剪开启）：恢复原设计的固定 52px 侧栏 + 居中按钮；
        // 画布态：侧栏内容自适应 + 开关按钮左对齐（预览区最大化）
        sidebar.style.width = editing ? "52px" : "auto";
        sidebar.style.minWidth = editing ? "52px" : "0";
        sidebar.classList.toggle("xzg-edit", editing);
        // 图标按钮的文字形态（lb）仅编辑态显示；画布态走图标
        maskToggleBtn.__lb.textContent = maskEnabled ? xzgT("退出", "Exit") : xzgT("遮罩", "Mask");
        // 遮罩切换按钮：取消边框与底色；编辑态文字金色、画布态图标用普通文字色
        maskToggleBtn.style.border = "none";
        maskToggleBtn.style.background = "transparent";
        maskToggleBtn.style.color = editing ? "#FFD700" : "var(--input-text)";
        maskToggleBtn.style.fontSize = maskEnabled ? "20px" : "12px";
        maskToggleBtn.style.padding = "4px 0";
        maskBrushBtn.style.color = maskTool === "brush" ? "#66CC66" : "var(--input-text)";
        maskBrushBtn.style.borderColor = maskTool === "brush" ? "#66CC66" : "var(--border-color)";
        maskEraserBtn.style.color = maskTool === "eraser" ? "#FF6B6B" : "var(--input-text)";
        maskEraserBtn.style.borderColor = maskTool === "eraser" ? "#FF6B6B" : "var(--border-color)";
        cropToggleBtn.__lb.textContent = cropEnabled ? xzgT("退出", "Exit") : xzgT("裁剪", "Crop");
        // 裁剪切换按钮：取消边框与底色；编辑态文字金色、画布态图标用普通文字色，上移4px
        cropToggleBtn.style.border = "none";
        cropToggleBtn.style.background = "transparent";
        cropToggleBtn.style.color = editing ? "#FFD700" : "var(--input-text)";
        cropToggleBtn.style.fontSize = cropEnabled ? "20px" : "12px";
        cropToggleBtn.style.padding = "4px 0";
        cropToggleBtn.style.marginTop = "-4px";
        cropClearBtn.style.color = cropEnabled ? "#4A90E2" : "var(--input-text)"; // "恢复原始"：蓝色
        cropClearBtn.style.borderColor = cropEnabled ? "#4A90E2" : "var(--border-color)";
        cropSelClearBtn.style.color = cropEnabled ? "#FF6B6B" : "var(--input-text)"; // "清除选框"：红色
        cropSelClearBtn.style.borderColor = cropEnabled ? "#FF6B6B" : "var(--border-color)";
        // 画笔系列仅在遮罩开启时显示；进入裁剪模式时不显示遮罩按钮；遮罩与裁剪互斥
        const vis = maskEnabled ? "" : "none";
        maskToggleBtn.style.display = cropEnabled ? "none" : "";
        cropToggleBtn.style.display = maskEnabled ? "none" : "";
        cropApplyBtn.style.display = (!cropEnabled || maskEnabled) ? "none" : "";
        cropApplyBtn.style.color = cropEnabled && !maskEnabled ? "#66CC66" : "var(--input-text)"; // "应用裁剪"：绿色
        cropApplyBtn.style.borderColor = cropEnabled && !maskEnabled ? "#66CC66" : "var(--border-color)";
        brushSizeRow.style.display = vis;
        maskBrushBtn.style.display = vis;
        maskEraserBtn.style.display = vis;
        maskClearBtn.style.display = vis;
        maskInvertBtn.style.display = vis;
        cropClearBtn.style.display = !cropEnabled ? "none" : "";
        cropSelClearBtn.style.display = !cropEnabled ? "none" : "";
        cropRatioRow.style.display = (!cropEnabled || maskEnabled) ? "none" : "";
        if (cropEnabled && !maskEnabled) {
            // 让「裁剪比例」标签左缘与「应用裁剪」等 4 字按钮的居中文字左缘精确对齐（编辑界面原设计）。
            // 按钮文字左像素 = paddingLeft + (offsetWidth - paddingLeft - paddingRight - textW) / 2
            const btn = cropApplyBtn;
            const bw = btn.offsetWidth;
            if (bw > 0) {
                const cs = getComputedStyle(btn);
                const pl = parseFloat(cs.paddingLeft) || 0;
                const pr = parseFloat(cs.paddingRight) || 0;
                let tw = 0;
                try { const c = document.createElement("canvas").getContext("2d");
                      c.font = `${cs.fontSize || "11px"} ${cs.fontFamily || "sans-serif"}`;
                      tw = c.measureText(btn.textContent || "").width; } catch (_) {}
                cropRatioRow.style.paddingLeft = Math.max(0, pl + (bw - pl - pr - tw) / 2) + "px";
            }
        } else {
            cropRatioRow.style.paddingLeft = "";
        }
        // 开启编辑模式时隐藏上传/.input/.output/删除/清空按钮及左下角单图/列表批次按钮，避免误操作
        const actionBtns = [uploadBtn, folderBtn, outputBtn, deleteBtn, clearBtn, uploadModeBtn, modeBtn];
        actionBtns.forEach(btn => { btn.style.display = editing ? "none" : ""; });
        _syncMaskLayerVisibility();
    };

    maskToggleBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (uploadMode !== "replace") {
            xzgAlert(xzgT("遮罩绘制仅在单图模式下可用", "Mask drawing is only available in single image mode"));
            return;
        }
        if (!maskEnabled) cropEnabled = false; // 互斥：开启遮罩即关闭裁剪
        maskEnabled = !maskEnabled;
        _refreshCropPreview(); // 若退出裁剪预览（切换到遮罩），恢复原图显示
        // 开启遮罩时自动选中节点、调整大小、放大画布
        if (maskEnabled && app?.canvas) {
            app.canvas.selectNode(node);
            if (!_maskOrigSize) {
                _maskOrigSize = [node.size[0], node.size[1]];
            }
            if (!_maskOrigCanvas) {
                _maskOrigCanvas = {
                    scale: app.canvas.ds.scale,
                    offset: [app.canvas.ds.offset[0], app.canvas.ds.offset[1]],
                };
            }
            _persistOrigNodeSize("xzg_mask_orig_size"); // 持久化原始大小，刷新后可恢复
            node.setSize([1280, 720]);
            // 缩放画布使节点充满屏幕
            const cw = app.canvas.canvas.width;
            const ch = app.canvas.canvas.height;
            const scale = Math.min(cw / 1280, ch / 720) * 0.95;
            const nodeCenterX = node.pos[0] + 640;
            const nodeCenterY = node.pos[1] + 360;
            app.canvas.ds.scale = scale;
            app.canvas.ds.offset[0] = cw / (2 * scale) - nodeCenterX;
            app.canvas.ds.offset[1] = ch / (2 * scale) - nodeCenterY;
            app.canvas.setDirty(true, true);
        }
        // 关闭遮罩时恢复原始大小和画布状态
        if (!maskEnabled && _maskOrigSize) {
            node.setSize(_maskOrigSize);
            _maskOrigSize = null;
            _resetImgZoom();
            if (node.properties) delete node.properties.xzg_mask_orig_size; // 清除持久化标记
            if (_maskOrigCanvas && app?.canvas) {
                app.canvas.ds.scale = _maskOrigCanvas.scale;
                app.canvas.ds.offset[0] = _maskOrigCanvas.offset[0];
                app.canvas.ds.offset[1] = _maskOrigCanvas.offset[1];
                _maskOrigCanvas = null;
            }
            app.canvas.setDirty(true, true);
        }
        // 开启时初始化一次离屏 canvas 尺寸
        if (maskEnabled && singleImgEl.complete && singleImgEl.naturalWidth > 0) {
            _ensureOffscreenCanvasSize(singleImgEl.dataset.currentName || singleImgEl.dataset.previewKey, true);
            _renderMaskOverlay();
        }
        _refreshMaskToolbar();
        _updateMaskCursor();
    });
    maskBrushBtn.addEventListener("click", (e) => { e.stopPropagation(); maskTool = "brush"; _refreshMaskToolbar(); _updateMaskCursor(); _renderBrushPreview(); });
    maskEraserBtn.addEventListener("click", (e) => { e.stopPropagation(); maskTool = "eraser"; _refreshMaskToolbar(); _updateMaskCursor(); _renderBrushPreview(); });
    maskClearBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (maskOffscreen.width > 0 && maskOffscreen.height > 0) {
            maskOffCtx.clearRect(0, 0, maskOffscreen.width, maskOffscreen.height);
            _renderMaskOverlay();
            _commitMaskToWidget();
        }
    });
    maskInvertBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (maskOffscreen.width <= 0 || maskOffscreen.height <= 0) return;
        const w = maskOffscreen.width, h = maskOffscreen.height;
        const imgData = maskOffCtx.getImageData(0, 0, w, h);
        const d = imgData.data;
        for (let i = 0; i < d.length; i += 4) {
            d[i] = 255 - d[i];     // R 通道存的是 alpha 值
            d[i + 3] = 255;         // alpha 通道保持完全不透明
        }
        maskOffCtx.putImageData(imgData, 0, 0);
        _renderMaskOverlay();
        _commitMaskToWidget();
    });

    // ═══════════ 裁剪选区：widget 读写 ═══════════
    // 清除全部遮罩绘制数据（离屏 canvas + widget），打开裁剪模式时调用，防止裁剪/遮罩坐标系错位
    function _clearMaskData() {
        if (maskOffscreen.width > 0 && maskOffscreen.height > 0) {
            maskOffCtx.clearRect(0, 0, maskOffscreen.width, maskOffscreen.height);
        }
        _maskBoundImageName = null;
        const w = getMaskDataWidget(node);
        if (w) { w.value = ""; w.callback?.(w.value); }
        _renderMaskOverlay();
    }
    function _commitCropToWidget() {
        const w = getCropDataWidget(node);
        if (!w) return;
        if (!cropRect) { w.value = ""; w.callback?.(w.value); return; }
        w.value = JSON.stringify([cropRect.x, cropRect.y, cropRect.w, cropRect.h]);
        w.callback?.(w.value);
    }
    function _loadCropFromWidget() {
        const w = getCropDataWidget(node);
        const s = w?.value;
        if (s) {
            try {
                const a = JSON.parse(s);
                if (Array.isArray(a) && a.length === 4) {
                    cropRect = { x: Math.round(+a[0]), y: Math.round(+a[1]), w: Math.round(+a[2]), h: Math.round(+a[3]) };
                    return;
                }
            } catch (_) {}
        }
        cropRect = null;
    }

    // ═══════════ 裁剪选区：事件（与遮罩相同入口、同一套坐标映射） ═══════════
    function _cropPxFromEvent(e) {
        const rect = singleImgContainer.getBoundingClientRect();
        const zoomX = singleImgContainer.clientWidth > 0 ? rect.width / singleImgContainer.clientWidth : 1;
        const zoomY = singleImgContainer.clientHeight > 0 ? rect.height / singleImgContainer.clientHeight : 1;
        const px = (e.clientX - rect.left) / zoomX;
        const py = (e.clientY - rect.top) / zoomY;
        const innerPt = _containerPtToInner(px, py);
        if (_isCropPreviewActive()) {
            // 裁剪预览态：视窗显示的是裁剪结果（contain 居中），映射回原图坐标（支持继续裁剪）
            const cw = singleImgContainer.clientWidth;
            const ch = singleImgContainer.clientHeight;
            if (cw <= 0 || ch <= 0 || cropRect.w <= 0 || cropRect.h <= 0) return null;
            const s2 = Math.min(cw / cropRect.w, ch / cropRect.h);
            const x2 = (cw - cropRect.w * s2) / 2;
            const y2 = (ch - cropRect.h * s2) / 2;
            const lx = innerPt.x - x2;
            const ly = innerPt.y - y2;
            // 超出裁剪画面（含黑边区域）不响应框选
            if (lx < 0 || ly < 0 || lx > cropRect.w * s2 || ly > cropRect.h * s2) return null;
            return { x: cropRect.x + lx / s2, y: cropRect.y + ly / s2 };
        }
        // 裁剪允许从图片外（黑边区）开始拖选：返回原图像素坐标，可超出图片边界（负值 / 超界均可）。
        // 绘制与提交阶段都会 clamp 到图片范围，因此越界坐标安全无副作用。
        const drect = _getImageDisplayRect();
        if (drect.scale <= 0) return null;
        return { x: (innerPt.x - drect.x) / drect.scale, y: (innerPt.y - drect.y) / drect.scale };
    }
    function _onCropPointerDown(e) {
        if (!cropEnabled) return;
        if (e.button !== 0) return;
        try { e.preventDefault(); } catch (_) {}
        try { e.stopPropagation(); } catch (_) {}
        // 有待选框时：优先响应"拖动 4 个角调整裁剪框"；未命中角则判定是否在框内——在框内则拖动整体移动，否则锁定
        if (_cropPending) {
            const corner = _cropHandleHit(e);
            if (corner) {
                try { if (singleImgContainer.setPointerCapture) singleImgContainer.setPointerCapture(e.pointerId); } catch (_) {}
                _cropResizeCorner = corner;
                _cropResizeBase = { x: _cropPending.x, y: _cropPending.y, w: _cropPending.w, h: _cropPending.h };
                _cropResizeAnchorPos = _cropCornerPt(_cropResizeBase, _cropOpp(corner));
                _renderMaskOverlay();
            } else if (_cropPendingInPoint(e)) {
                // 命中裁剪框内部：进入"拖动框整体移动位置"
                try { if (singleImgContainer.setPointerCapture) singleImgContainer.setPointerCapture(e.pointerId); } catch (_) {}
                const sp = _cropPxFromEvent(e);
                _cropMove = true;
                _cropMoveStart = sp ? { x: sp.x, y: sp.y } : null;
                _cropMoveBase = { x: _cropPending.x, y: _cropPending.y, w: _cropPending.w, h: _cropPending.h };
                _renderMaskOverlay();
            }
            return;
        }
        const pt = _cropPxFromEvent(e);
        if (!pt) return;
        try { if (singleImgContainer.setPointerCapture) singleImgContainer.setPointerCapture(e.pointerId); } catch (_) {}
        _cropDrawing = true;
        _cropSelStart = { x: pt.x, y: pt.y };
        _cropSelCur = { x: pt.x, y: pt.y };
        _renderMaskOverlay();
    }
    function _onCropPointerMove(e) {
        if (!cropEnabled) return;
        try { e.preventDefault(); } catch (_) {}
        try { e.stopPropagation(); } catch (_) {}
        // 拖动裁剪框整体移动：以起点为基准累加位移，平移待选框
        if (_cropMove) {
            const sp = _cropPxFromEvent(e);
            if (sp && _cropMoveStart && _cropMoveBase) {
                const iw = _maskImgNaturalW || singleImgEl.naturalWidth || 0;
                const ih = _maskImgNaturalH || singleImgEl.naturalHeight || 0;
                let nx = _cropMoveBase.x + (sp.x - _cropMoveStart.x);
                let ny = _cropMoveBase.y + (sp.y - _cropMoveStart.y);
                // clamp 使待选框整体保持在图片边界内
                nx = Math.max(0, Math.min(nx, iw - _cropMoveBase.w));
                ny = Math.max(0, Math.min(ny, ih - _cropMoveBase.h));
                _cropPending = { x: nx, y: ny, w: _cropMoveBase.w, h: _cropMoveBase.h };
            }
            _renderMaskOverlay();
            return;
        }
        // 拖动裁剪框角：以固定对角为锚点重算待选框
        if (_cropResizeCorner) {
            // 用与渲染/命中同一坐标系（_cropBoxToContainer 的逆）映射拖动点，避免缩放态坐标系错乱
            const cp = _cropContainerPt(e);
            const pt = _cropContainerToPixel(cp);
            if (pt) _applyCropResize(pt);
            _renderMaskOverlay();
            return;
        }
        if (!_cropDrawing) return;
        const pt = _cropPxFromEvent(e);
        if (pt) {
            // 若有比例约束，按起点与当前点约束选区宽高比
            const a = _cropAspectAdjust(_cropSelStart.x, _cropSelStart.y, pt.x, pt.y);
            _cropSelCur = { x: a.x, y: a.y };
        }
        _renderMaskOverlay();
    }
    // ── 裁剪框角拖动：几何辅助 ──
    // 双交点容器坐标（含预览态映射），与 _renderMaskOverlay 的坐标变换保持一致
    function _cropOpp(c) { return { tl: "br", tr: "bl", bl: "tr", br: "tl" }[c] || "br"; }
    function _cropCornerPt(box, c) {
        return { tl: [box.x, box.y], tr: [box.x + box.w, box.y], bl: [box.x, box.y + box.h], br: [box.x + box.w, box.y + box.h] }[c];
    }
    // 鼠标所在容器坐标点
    function _cropContainerPt(e) {
        const rect = singleImgContainer.getBoundingClientRect();
        const zoomX = singleImgContainer.clientWidth > 0 ? rect.width / singleImgContainer.clientWidth : 1;
        const zoomY = singleImgContainer.clientHeight > 0 ? rect.height / singleImgContainer.clientHeight : 1;
        return { x: (e.clientX - rect.left) / zoomX, y: (e.clientY - rect.top) / zoomY };
    }
    // 把待选框（原图像素）映射为容器坐标显示矩形
    function _cropBoxToContainer(box) {
        const cw = singleImgContainer.clientWidth, ch = singleImgContainer.clientHeight;
        const rect = _getImageDisplayRect();
        if (_isCropPreviewActive() && cropRect) {
            const s2 = Math.min(cw / cropRect.w, ch / cropRect.h);
            const x2 = (cw - cropRect.w * s2) / 2, y2 = (ch - cropRect.h * s2) / 2;
            return {
                X: x2 + (box.x - cropRect.x) * s2,
                Y: y2 + (box.y - cropRect.y) * s2,
                X2: x2 + (box.x + box.w - cropRect.x) * s2,
                Y2: y2 + (box.y + box.h - cropRect.y) * s2,
            };
        }
        const sc = rect.scale;
        return { X: rect.x + box.x * sc, Y: rect.y + box.y * sc, X2: rect.x + (box.x + box.w) * sc, Y2: rect.y + (box.y + box.h) * sc };
    }
    // 容器坐标 → 原图像素（_cropBoxToContainer 的逆运算，用于角拖动，保证与渲染/命中同一坐标系）
    function _cropContainerToPixel(pt) {
        const cw = singleImgContainer.clientWidth, ch = singleImgContainer.clientHeight;
        const rect = _getImageDisplayRect();
        if (_isCropPreviewActive() && cropRect) {
            const s2 = Math.min(cw / cropRect.w, ch / cropRect.h);
            const x2 = (cw - cropRect.w * s2) / 2, y2 = (ch - cropRect.h * s2) / 2;
            // 拖角时鼠标可能滑出裁剪画面边缘：clamp 到边框对应像素，保证拖动不中断
            const maxX = x2 + cropRect.w * s2, maxY = y2 + cropRect.h * s2;
            const bx = Math.max(x2, Math.min(pt.x, maxX));
            const by = Math.max(y2, Math.min(pt.y, maxY));
            if (s2 <= 0) return null;
            return { x: cropRect.x + (bx - x2) / s2, y: cropRect.y + (by - y2) / s2 };
        }
        if (rect.scale <= 0) return null;
        const ox = (pt.x - rect.x) / rect.scale, oy = (pt.y - rect.y) / rect.scale;
        const iw = _maskImgNaturalW || singleImgEl.naturalWidth || 0;
        const ih = _maskImgNaturalH || singleImgEl.naturalHeight || 0;
        if (ox < 0 || oy < 0 || ox > iw || oy > ih) return null;
        return { x: ox, y: oy };
    }
    // 命中检测：命中断选框的角则返回角名，否则 null
    function _cropHandleHit(e) {
        if (!_cropPending || _cropPending.w <= 0 || _cropPending.h <= 0) return null;
        const p = _cropContainerPt(e);
        const { X, Y, X2, Y2 } = _cropBoxToContainer(_cropPending);
        const t = 13; // 命中阈值（容器像素）：略大于手柄尺寸，避免鼠标略偏即未命中而落入锁定分支
        const hits = { tl: [X, Y], tr: [X2, Y], bl: [X, Y2], br: [X2, Y2] };
        for (const k of ["tl", "tr", "bl", "br"]) {
            const cx = hits[k][0], cy = hits[k][1];
            if (Math.abs(p.x - cx) <= t && Math.abs(p.y - cy) <= t) return k;
        }
        return null;
    }
    // 命中检测：事件坐标是否落在待选框内部（不含角），用于"拖动框整体移动位置"
    function _cropPendingInPoint(e) {
        if (!_cropPending || _cropPending.w <= 0 || _cropPending.h <= 0) return false;
        const p = _cropContainerPt(e);
        const { X, Y, X2, Y2 } = _cropBoxToContainer(_cropPending);
        const m = 8; // 内缩填充因子（容器像素），排除靠近边框（含四角命中带）的窄边区域
        return p.x > X + m && p.x < X2 - m && p.y > Y + m && p.y < Y2 - m;
    }
    // 在选框四角绘制拖动手柄（绿色小方块）
    function _drawCropHandles(ctx, X, Y, X2, Y2) {
        const s = 8, off = s / 2;
        ctx.save();
        ctx.fillStyle = "#66CC66";
        ctx.strokeStyle = "#111";
        ctx.lineWidth = 1;
        const pts = [[X, Y], [X2, Y], [X, Y2], [X2, Y2]];
        for (const [px, py] of pts) {
            ctx.fillRect(px - off, py - off, s, s);
            ctx.strokeRect(px - off + 0.5, py - off + 0.5, s - 1, s - 1);
        }
        ctx.restore();
    }
    // 拖动角重算待选框：锚点（对角）固定，当前角移到鼠标位置
    // 若有比例约束，把移动角调整为满足宽高比的点
    function _cropAspectAdjust(ax, ay, mx, my) {
        const r = _cropAspect;
        if (!r) return { x: mx, y: my };
        const dx = mx - ax, dy = my - ay;
        const sx = dx >= 0 ? 1 : -1, sy = dy >= 0 ? 1 : -1;
        // 以较长的边为主驱动，让另一条边满足比例，避免缩放趋零
        if (Math.abs(dx) >= Math.abs(dy) * r) {
            return { x: mx, y: ay + sx * (Math.abs(dx) / r) };
        }
        return { x: ax + sx * (Math.abs(dy) * r), y: my };
    }
    function _applyCropResize(pt) {
        const c = _cropResizeCorner, a = _cropResizeAnchorPos;
        const iw = _maskImgNaturalW || singleImgEl.naturalWidth || 0;
        const ih = _maskImgNaturalH || singleImgEl.naturalHeight || 0;
        const r = _cropAspect;
        const MIN = 3; // 最小边（像素），与提交时的下限一致
        // 移动角相对锚点的方向（由拖动开始时的角位置决定，拖动中不允许越过锚点反向）
        const dirX = (c === "tr" || c === "br") ? 1 : -1;
        const dirY = (c === "bl" || c === "br") ? 1 : -1;
        // 防翻转：先把鼠标点钳制到锚点的正确一侧（至少留 MIN 距离）再做比例调整。
        // 否则移动角越过对角锚点后，min/max 归一化会让选框跳到对侧；
        // 固定比例时 _cropAspectAdjust 的符号推断还会把另一条边甩到反方向，加剧翻转
        const mx = dirX > 0 ? Math.max(pt.x, a[0] + MIN) : Math.min(pt.x, a[0] - MIN);
        const my = dirY > 0 ? Math.max(pt.y, a[1] + MIN) : Math.min(pt.y, a[1] - MIN);
        const adj = _cropAspectAdjust(a[0], a[1], mx, my);
        // 尺寸 = 移动角沿拖动方向到锚点的绝对距离（钳制后必为正且同侧）
        let w = Math.abs(adj.x - a[0]);
        let h = Math.abs(adj.y - a[1]);
        // 图像边界：从锚点沿拖动方向可用的最大宽高
        const maxW = Math.max(0, dirX > 0 ? iw - a[0] : a[0]);
        const maxH = Math.max(0, dirY > 0 ? ih - a[1] : a[1]);
        if (r) {
            // 比例约束：边界钳制必须等比缩放，否则会破坏宽高比
            const scale = Math.min(1, maxW / Math.max(w, 0.001), maxH / Math.max(h, 0.001));
            w *= scale; h *= scale;
        } else {
            w = Math.min(w, maxW);
            h = Math.min(h, maxH);
        }
        w = Math.max(MIN, w);
        h = Math.max(MIN, h);
        // 从锚点沿拖动方向展开出选框（锚点恒为选框的一个角，不翻转）
        const x = dirX > 0 ? a[0] : a[0] - w;
        const y = dirY > 0 ? a[1] : a[1] - h;
        _cropPending = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
    }
    function _commitCropSelection() {
        if (_cropSelStart && _cropSelCur) {
            const iw = _maskImgNaturalW || singleImgEl.naturalWidth || 0;
            const ih = _maskImgNaturalH || singleImgEl.naturalHeight || 0;
            const x0 = Math.min(_cropSelStart.x, _cropSelCur.x);
            const y0 = Math.min(_cropSelStart.y, _cropSelCur.y);
            const x1 = Math.max(_cropSelStart.x, _cropSelCur.x);
            const y1 = Math.max(_cropSelStart.y, _cropSelCur.y);
            const cx = Math.max(0, Math.min(Math.round(x0), Math.round(iw)));
            const cy = Math.max(0, Math.min(Math.round(y0), Math.round(ih)));
            const cw = Math.max(1, Math.min(Math.round(x1), Math.round(iw)) - cx);
            const ch = Math.max(1, Math.min(Math.round(y1), Math.round(ih)) - cy);
            // 小于 3px 视为单击（如双击应用裁剪时的两次点击），不覆盖已有选区
            if (cw >= 3 && ch >= 3) {
                _cropPending = { x: cx, y: cy, w: cw, h: ch };
            }
        }
        _cropSelStart = null; _cropSelCur = null;
    }
    // 应用裁剪：把待应用选区正式写到 cropRect 并持久化，视窗立即切换为裁剪结果
    function _applyCrop() {
        if (!_cropPending) return;
        cropRect = _cropPending;
        _cropPending = null;
        _commitCropToWidget();
        // 裁剪优先于遮罩：画面一旦被裁剪，旧遮罩立即作废（坐标系已变），
        // 需在裁剪后的画面上重新绘制遮罩
        _clearMaskData();
        _resetImgZoom();
        _refreshCropPreview(); // 视窗立即只显示裁剪画面（contain 自适应放大）
        _renderMaskOverlay();
        _updateSingleResLabel();
    }
    // 裁剪结果预览机制见 _refreshCropPreview：把裁剪区域绘制到独立画布并隐藏原图，替代 transform 缩放方案
    function _onCropPointerUp(e) {
        if (!cropEnabled) return;
        const wasResizing = _cropResizeCorner;
        _cropResizeCorner = null; _cropResizeBase = null; _cropResizeAnchorPos = null;
        if (_cropMove) { // 拖动框移动结束：保留已移动的待选框
            _cropMove = false; _cropMoveStart = null; _cropMoveBase = null;
            try { singleImgContainer.releasePointerCapture?.(e.pointerId); } catch (_) {}
            _renderMaskOverlay();
            return;
        }
        if (wasResizing) { // 拖动角结束：保留调整后的待选框
            try { singleImgContainer.releasePointerCapture?.(e.pointerId); } catch (_) {}
            _renderMaskOverlay();
            return;
        }
        if (!_cropDrawing) return;
        _cropDrawing = false;
        try { singleImgContainer.releasePointerCapture?.(e.pointerId); } catch (_) {}
        _commitCropSelection();
        _renderMaskOverlay();
    }

    // ═══════════ 放大模式节点大小：持久化原始大小到 node.properties ═══════════
    // 进入裁剪/遮罩模式会用 node.setSize([1280,720]) 放大节点，这会写入工作流。
    // 把放大前的原始大小持久化到 node.properties，刷新后 onConfigure 据此恢复，
    // 避免残留的放大值导致"刷新后节点无法还原原来大小"。
    function _persistOrigNodeSize(key) {
        if (!node || !node.size) return;
        node.properties = node.properties || {};
        node.properties[key] = [node.size[0], node.size[1]];
    }
    function _restoreOrigNodeSize(key) {
        if (!node) return;
        const saved = node.properties?.[key];
        if (Array.isArray(saved) && saved.length === 2) {
            const w = Number(saved[0]), h = Number(saved[1]);
            if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
                node.setSize([w, h]);
            }
        }
        if (node.properties) delete node.properties[key];
    }

    // 裁剪开关 / 清空（仅单图模式可用）
    cropToggleBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (uploadMode !== "replace") {
            xzgAlert(xzgT("裁剪选区仅在单图模式下可用", "Crop region is only available in single image mode"));
            return;
        }
        if (!cropEnabled && maskEnabled) maskEnabled = false; // 互斥：开启裁剪即关闭遮罩
        cropEnabled = !cropEnabled;
        // 打开裁剪模式：立即清除现有遮罩信息（裁剪与遮罩不同坐标系，避免残留错位）
        if (cropEnabled) {
            _clearMaskData();
        }
        if (cropEnabled && app?.canvas) {
            app.canvas.selectNode(node);
            if (!_cropOrigSize) _cropOrigSize = [node.size[0], node.size[1]];
            if (!_cropOrigCanvas) _cropOrigCanvas = { scale: app.canvas.ds.scale, offset: [...app.canvas.ds.offset] };
            _persistOrigNodeSize("xzg_crop_orig_size"); // 持久化原始大小，刷新后可恢复
            node.setSize([1280, 720]);
            const cw = app.canvas.canvas.width, ch = app.canvas.canvas.height;
            const scale = Math.min(cw / 1280, ch / 720) * 0.95;
            const nodeCenterX = node.pos[0] + 640, nodeCenterY = node.pos[1] + 360;
            app.canvas.ds.scale = scale;
            app.canvas.ds.offset[0] = cw / (2 * scale) - nodeCenterX;
            app.canvas.ds.offset[1] = ch / (2 * scale) - nodeCenterY;
            app.canvas.setDirty(true, true);
        }
        if (!cropEnabled && _cropOrigSize) {
            node.setSize(_cropOrigSize);
            _cropOrigSize = null;
            _resetImgZoom();
            if (node.properties) delete node.properties.xzg_crop_orig_size; // 清除持久化标记
            if (_cropOrigCanvas && app?.canvas) {
                app.canvas.ds.scale = _cropOrigCanvas.scale;
                app.canvas.ds.offset[0] = _cropOrigCanvas.offset[0];
                app.canvas.ds.offset[1] = _cropOrigCanvas.offset[1];
                _cropOrigCanvas = null;
            }
            app.canvas.setDirty(true, true);
        }
        if (cropEnabled) {
            _loadCropFromWidget();
            if (cropRect) { // 已有裁剪时进入裁剪模式即显示裁剪结果
                _resetImgZoom();
                _refreshCropPreview();
                _updateSingleResLabel();
            }
        }
        if (!cropEnabled) { // 退出裁剪模式：恢复原图显示与分辨率标签
            _refreshCropPreview();
            _updateSingleResLabel();
        }
        _refreshMaskToolbar();
        _renderMaskOverlay();
    });
    cropClearBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!cropEnabled) return;
        cropRect = null;
        _cropPending = null;
        _cropResizeCorner = null; _cropResizeBase = null; _cropResizeAnchorPos = null;
        _cropMove = false; _cropMoveStart = null; _cropMoveBase = null;
        _cropSelStart = _cropSelCur = null;
        _cropAspect = null;
        refreshCropRatioUI();
        _commitCropToWidget();
        // 恢复原始 = 裁剪状态变化：遮罩是相对裁剪画面绘制的，一并清除
        _clearMaskData();
        _resetImgZoom(); // 清空后恢复整图显示
        _refreshCropPreview();
        _renderMaskOverlay();
        _updateSingleResLabel();
    });

    // 清除当前选框：仅移除待选框（_cropPending），保持已应用裁剪的状态不变
    cropSelClearBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!cropEnabled) return;
        _cropPending = null;
        _cropMove = false; _cropMoveStart = null; _cropMoveBase = null;
        _cropSelStart = _cropSelCur = null;
        _renderMaskOverlay(); // 只刷新选框显示
    });

    // 应用裁剪按钮：直接把当前选框应用（等同右键"应用裁剪"）
    cropApplyBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!cropEnabled || !_cropPending) return;
        _applyCrop();
    });

    sidebar.addEventListener("dblclick", (e) => {
        if (e.target.closest("button")) return;
        e.preventDefault();
        e.stopPropagation();
        openUploadDialog();
    });

    let lastNames = null;
    let lastCardSize = null;
    let selectedIndexes = [];
    let lastClickedIndex = -1;

    const mainContent = document.createElement("div");
    mainContent.style.cssText = "flex:1;display:flex;flex-direction:column;pointer-events:auto;min-width:0;min-height:120px;";
    mainContent.style.userSelect = "none";
    mainContent.style.webkitUserSelect = "none";

    const grid = document.createElement("div");
    grid.style.cssText =
        "display:grid;gap:2px;flex:1;min-width:0;min-height:0;overflow:hidden;background:transparent;padding:0;border-radius:2px;align-content:start;justify-content:start;transition:opacity 0.3s ease;";
    grid.style.userSelect = "none";
    grid.style.webkitUserSelect = "none";
    grid.classList.add("xzg-img-grid");

    if (!document.getElementById("xzg-img-grid-scrollbar-style")) {
        const style = document.createElement("style");
        style.id = "xzg-img-grid-scrollbar-style";
        style.textContent = `
            .xzg-img-grid::-webkit-scrollbar {
                width: 6px;
                height: 6px;
            }
            .xzg-img-grid::-webkit-scrollbar-track {
                background: transparent;
            }
            .xzg-img-grid::-webkit-scrollbar-thumb {
                background: rgba(255,255,255,0.05);
                border-radius: 3px;
            }
            .xzg-img-grid::-webkit-scrollbar-thumb:hover {
                background: rgba(255,255,255,0.2);
            }
            @keyframes xzgCardFlipIn {
                0% { transform: rotate3d(var(--fx,0), var(--fy,1), 0, var(--fdeg,90deg)) scale(0.8); opacity: 0; }
                50% { opacity: 1; }
                100% { transform: rotate3d(0, 0, 0, 0deg) scale(1); opacity: 1; }
            }
        `;
        document.head.appendChild(style);
    }

    const emptyTip = document.createElement("div");
    emptyTip.style.cssText =
        "flex:1;display:flex;align-items:flex-start;justify-content:flex-start;background:transparent;border-radius:4px;color:var(--input-text);font-size:8px;opacity:0.55;min-height:40px;padding:6px 4px 4px;box-sizing:border-box;";
    emptyTip.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:5px;width:100%;max-width:280px;font-size:8px;color:var(--input-text);line-height:1.35;">
            <div style="text-align:left;font-size:9px;font-weight:bold;margin-bottom:1px;opacity:0.85;padding-left:12px;">${xzgTh("小珠光图像加载器", "Xiaozhuguang Image Loader")}</div>

            <div style="display:flex;flex-direction:column;gap:1px;">
                <div style="font-weight:bold;opacity:0.75;">${xzgTh("📁 添加图片", "📁 Add Images")}</div>
                <div style="opacity:0.5;padding-left:12px;">${xzgTh("双击空白处 / 点击上传按钮", "Double-click blank / Click upload button")}</div>
                <div style="opacity:0.5;padding-left:12px;">${xzgTh(".input 从输入文件夹选择", ".input Select from input folder")}</div>
                <div style="opacity:0.5;padding-left:12px;">${xzgTh(".output 从输出文件夹选择", ".output Select from output folder")}</div>
            </div>

            <div style="display:flex;flex-direction:column;gap:1px;">
                <div style="font-weight:bold;opacity:0.75;">${xzgTh("🖱️ 鼠标操作", "🖱️ Mouse Operations")}</div>
                <div style="opacity:0.5;padding-left:12px;">${xzgTh("左键点击：选中 / Ctrl多选 / Shift范围选", "Left click: Select / Ctrl+Multi / Shift+Range")}</div>
                <div style="opacity:0.5;padding-left:12px;">${xzgTh("长按卡片拖动：调整顺序", "Long press card to drag: Reorder")}</div>
                <div style="opacity:0.5;padding-left:12px;">${xzgTh("卡片上拖动：框选多个图片", "Drag on card: Box select")}</div>
                <div style="opacity:0.5;padding-left:12px;">${xzgTh("悬停卡片右上角：删除单张", "Hover card corner: Delete")}</div>
            </div>

            <div style="display:flex;flex-direction:column;gap:1px;">
                <div style="font-weight:bold;opacity:0.75;">${xzgTh("🔄 模式切换", "🔄 Mode Switch")}</div>
                <div style="opacity:0.5;padding-left:12px;">${xzgTh("多图/单图：批量加载图片模式 / 单图加载模式", "Multi/Single: Batch load mode / Single load mode")}</div>
                <div style="opacity:0.5;padding-left:12px;">${xzgTh("批次模式：统一分辨率，批量处理", "Batch: Uniform resolution, batch processing")}</div>
                <div style="opacity:0.5;padding-left:12px;">${xzgTh("列表模式：支持不同分辨率，逐张处理", "List: Different resolutions, per-image")}</div>
            </div>

            <div style="display:flex;flex-direction:column;gap:1px;">
                <div style="font-weight:bold;opacity:0.75;">${xzgTh("🖌️ 遮罩 / 裁剪", "🖌️ Mask / Crop")}</div>
                <div style="opacity:0.5;padding-left:12px;">${xzgTh("遮罩：开启后手绘蒙版（画笔/橡皮）", "Mask: Draw mask (brush/eraser)")}</div>
                <div style="opacity:0.5;padding-left:12px;">${xzgTh("裁剪：框选裁剪区域，支持自由/固定比例", "Crop: Select crop region, free/fixed ratio")}</div>
                <div style="opacity:0.5;padding-left:12px;">${xzgTh("遮罩/裁剪开启后，点击【退出】返回", "After Start, click Exit to return")}</div>
            </div>

            <div style="display:flex;flex-direction:column;gap:1px;">
                <div style="font-weight:bold;opacity:0.75;">${xzgTh("💡 提示", "💡 Tips")}</div>
                <div style="opacity:0.5;padding-left:12px;">${xzgTh("缩略图大小根据节点大小自动调整", "Thumbnail size auto-adjusts to node size")}</div>
                <div style="opacity:0.5;padding-left:12px;">${xzgTh("拖动节点边缘可改变节点大小", "Drag node edge to resize")}</div>
            </div>
        </div>
    `;

    emptyTip.addEventListener("dblclick", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openUploadDialog();
    });

    mainContent.appendChild(emptyTip);
    mainContent.appendChild(grid);

    const singleImgContainer = document.createElement("div");
    singleImgContainer.id = "xzg-single-img-container";
    singleImgContainer.style.cssText = "flex:1;display:none;align-items:stretch;justify-content:center;min-width:0;min-height:100px;overflow:hidden;position:relative;width:100%;padding:0;box-sizing:border-box;";
    const singleImgEl = document.createElement("img");
    singleImgEl.style.cssText = "width:100%;height:100%;object-fit:contain;display:block;position:relative;z-index:1;";
    singleImgEl.draggable = false;

    // 单图模式分辨率标签
    const singleResLabel = document.createElement("div");
    singleResLabel.style.cssText =
        "position:absolute;left:50%;bottom:3px;transform:translateX(-50%);z-index:5;" +
        "pointer-events:none;padding:2px 8px;border-radius:3px;" +
        "background:rgba(0,0,0,0.55);color:#fff;font-size:11px;line-height:16px;font-family:Arial,sans-serif;" +
        "display:flex;align-items:center;justify-content:center;white-space:nowrap;";

    // 当前单图的原始分辨率（通过 /xzg_image_info API 获取，与压缩预览图分离）
    let _singleOrigW = 0, _singleOrigH = 0;

    function _updateSingleResLabel() {
        // 存在裁剪选区：显示「真实输出分辨率」（原图像素），而非压缩预览图坐标尺寸。
        // 前端选区坐标取自最长边3840的预览图，需按 原图宽/预览图宽 换算回原图坐标；
        // 该比例在后端同样用于把预览坐标还原为原图像素，故标签与最终输出一致。
        if (cropRect) {
            let w = cropRect.w, h = cropRect.h;
            if (_singleOrigW > 0) {
                const pv = singleImgEl.naturalWidth || 0; // 当前预览图宽度
                if (pv > 0) {
                    const ratio = _singleOrigW / pv; // 原图/预览 等比缩放比
                    if (ratio > 0 && Math.abs(ratio - 1) > 1e-9) {
                        w = Math.round(cropRect.w * ratio);
                        h = Math.round(cropRect.h * ratio);
                    }
                }
            }
            singleResLabel.textContent = `${w} × ${h}`;
            singleResLabel.style.display = "flex";
            return;
        }
        // 优先使用原始分辨率；未取到时回退到压缩预览图的自然尺寸
        const iw = _singleOrigW || _maskImgNaturalW || singleImgEl.naturalWidth || 0;
        const ih = _singleOrigH || _maskImgNaturalH || singleImgEl.naturalHeight || 0;
        if (iw > 0 && ih > 0) {
            singleResLabel.textContent = `${iw} × ${ih}`;
            singleResLabel.style.display = "flex";
        } else {
            singleResLabel.style.display = "none";
        }
    }

    singleImgEl.onerror = () => {
        const names = parseNameList(getImageListWidget(node)?.value);
        if (names.length === 1) {
            const next = names.slice(1);
            setNameList(node, next);
            setIndex(node, 0);
        }
    };
    singleImgEl.onload = () => {
        _maskImgNaturalW = singleImgEl.naturalWidth;
        _maskImgNaturalH = singleImgEl.naturalHeight;
        _updateSingleResLabel();
    };
    singleImgContainer.appendChild(singleImgEl);
    singleImgContainer.appendChild(singleResLabel);

    // 遮罩显示/绘制层：覆盖在图片之上，尺寸与 singleImgContainer 一致
    // 图片在容器内 object-fit:contain，我们需要计算图片实际显示矩形以正确映射坐标
    const singleMaskOverlay = document.createElement("canvas");
    singleMaskOverlay.style.cssText = "position:absolute;inset:0;z-index:2;display:none;pointer-events:none;";
    singleMaskOverlay.width = 1;
    singleMaskOverlay.height = 1;
    singleImgContainer.appendChild(singleMaskOverlay);

    // 绘制监听层：放在遮罩 overlay 上层，接收事件（同尺寸）
    // —— 重点：pointer-events 只在 maskEnabled=true 时才设为 auto，否则不拦截正常点击
    const singleMaskEventLayer = document.createElement("div");
    singleMaskEventLayer.style.cssText = "position:absolute;inset:0;z-index:3;display:block;pointer-events:none;touch-action:none;background:transparent;";
    singleMaskEventLayer.dataset.xzgMaskLayer = "1";
    singleImgContainer.appendChild(singleMaskEventLayer);

    // 笔刷预览圆圈：覆盖在最上层，跟随鼠标显示实际笔刷大小
    const singleBrushPreview = document.createElement("canvas");
    singleBrushPreview.style.cssText = "position:absolute;inset:0;z-index:4;display:none;pointer-events:none;";
    singleBrushPreview.width = 1;
    singleBrushPreview.height = 1;
    singleImgContainer.appendChild(singleBrushPreview);

    mainContent.insertBefore(singleImgContainer, emptyTip);

    // 包装层：用于图片缩放（CSS transform），包裹图片和所有遮罩层
    const singleImgInner = document.createElement("div");
    singleImgInner.style.cssText = "position:absolute;inset:0;transform-origin:0 0;";
    // 将 singleImgEl 和遮罩层移入包装层
    singleImgContainer.appendChild(singleImgInner);
    singleImgInner.appendChild(singleImgEl);
    // 裁剪结果预览画布：应用裁剪后显示裁剪画面（object-fit:contain 自适应放大），替代原图
    // 必须 absolute 定位（脱离文档流），否则会与原图在流内垂直堆叠、画布被挤到容器下方
    const singleCropPreviewCanvas = document.createElement("canvas");
    singleCropPreviewCanvas.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;object-fit:contain;display:none;z-index:2;";
    singleImgInner.appendChild(singleCropPreviewCanvas);
    singleImgInner.appendChild(singleMaskOverlay);
    singleImgInner.appendChild(singleMaskEventLayer);
    singleImgInner.appendChild(singleBrushPreview);

    // ═══════════ 遮罩绘制辅助函数 ═══════════

    // 获取图片在 singleImgContainer 内实际显示的矩形（object-fit:contain）
    function _getImageDisplayRect() {
        const cw = singleImgContainer.clientWidth;
        const ch = singleImgContainer.clientHeight;
        const iw = _maskImgNaturalW || singleImgEl.naturalWidth || 0;
        const ih = _maskImgNaturalH || singleImgEl.naturalHeight || 0;
        if (cw <= 0 || ch <= 0 || iw <= 0 || ih <= 0) {
            return { x: 0, y: 0, w: cw, h: ch, scale: 1 };
        }
        const scale = Math.min(cw / iw, ch / ih);
        const w = iw * scale;
        const h = ih * scale;
        const x = (cw - w) / 2;
        const y = (ch - h) / 2;
        return { x, y, w, h, scale };
    }

    // ═══════════ 裁剪结果预览 ═══════════
    // 应用裁剪后，视窗内只显示裁剪画面：把裁剪区域绘制到独立画布并隐藏原图，
    // 画布用 object-fit:contain 自适应放大，不依赖任何 transform 计算（确定性生效）
    function _isCropPreviewActive() {
        // 只要有裁剪选区（cropRect）就显示裁剪结果，与本会话是否处于裁剪编辑模式无关：
        // 这样退出裁剪模式后，节点上加载的图像仍保持裁剪后的效果
        return !!cropRect;
    }
    // 裁剪预览显示矩形（inner 布局坐标，与 _getImageDisplayRect 同一坐标系）：
    // 视窗中裁剪画面按 object-fit:contain 居中铺满 inner，返回内嵌 scale 与起始偏移
    function _cropPreviewDisplayRect() {
        if (!cropRect || cropRect.w <= 0 || cropRect.h <= 0) return null;
        const cw = singleImgContainer.clientWidth, ch = singleImgContainer.clientHeight;
        if (cw <= 0 || ch <= 0) return null;
        const s2 = Math.min(cw / cropRect.w, ch / cropRect.h);
        if (s2 <= 0) return null;
        const x2 = (cw - cropRect.w * s2) / 2, y2 = (ch - cropRect.h * s2) / 2;
        return { s2, x2, y2, vw: cropRect.w * s2, vh: cropRect.h * s2 };
    }
    // 缓存：同图同选区避免高频 redraw 时重复绘制
    let _lastCropPreviewKey = null;
    function _refreshCropPreview() {
        if (!_isCropPreviewActive()) {
            _lastCropPreviewKey = null;
            singleCropPreviewCanvas.style.display = "none";
            singleImgEl.style.visibility = "";
            return;
        }
        const key = (singleImgEl.dataset.previewKey || "") + "|" +
            cropRect.x + "_" + cropRect.y + "_" + cropRect.w + "_" + cropRect.h;
        if (_lastCropPreviewKey === key) return; // 同图同选区已绘制，跳过
        // 直接读当前 img 的自然尺寸（必须已解码完成，避免画空白）
        const iw = singleImgEl.naturalWidth || 0;
        const ih = singleImgEl.naturalHeight || 0;
        if (iw <= 0 || ih <= 0 || !singleImgEl.complete) return;
        // 裁剪区域 clamp 到图像范围内（切图后 cropRect 可能越界）
        const sx = Math.max(0, Math.min(cropRect.x, iw));
        const sy = Math.max(0, Math.min(cropRect.y, ih));
        const ex = Math.max(sx, Math.min(cropRect.x + cropRect.w, iw));
        const ey = Math.max(sy, Math.min(cropRect.y + cropRect.h, ih));
        const cw2 = ex - sx, ch2 = ey - sy;
        if (cw2 < 1 || ch2 < 1) {
            // 裁剪区域已完全越界：退回原图显示
            singleCropPreviewCanvas.style.display = "none";
            singleImgEl.style.visibility = "";
            return;
        }
        _lastCropPreviewKey = key;
        singleCropPreviewCanvas.width = cw2;
        singleCropPreviewCanvas.height = ch2;
        const cctx = singleCropPreviewCanvas.getContext("2d");
        cctx.clearRect(0, 0, cw2, ch2);
        try {
            cctx.imageSmoothingEnabled = true;
            cctx.imageSmoothingQuality = "high";
            cctx.drawImage(singleImgEl, sx, sy, cw2, ch2, 0, 0, cw2, ch2);
        } catch (_) {}
        singleCropPreviewCanvas.style.display = "block";
        singleImgEl.style.visibility = "hidden"; // 隐藏原图，视窗内只剩裁剪画面
    }

    // 将容器坐标转换为 inner 坐标（基于当前 transform: translate(tx,ty) scale(zoom)）
    function _containerPtToInner(px, py) {
        const zoom = _maskImgZoom || 1;
        return { x: (px - _maskTx) / zoom, y: (py - _maskTy) / zoom };
    }

    // 增量缩放：在当前 transform 基础上叠加，保持鼠标下方图像点不动
    // 使用逐步计算方式：先算鼠标下图像点在 inner 坐标中的位置，再反推新 transform
    function _applyImgZoom(mx, my, delta) {
        const oldZoom = _maskImgZoom;
        const newZoom = Math.max(0.1, Math.min(8, oldZoom * delta));
        const oldTx = _maskTx;
        const oldTy = _maskTy;
        // 步骤1：计算鼠标下方图像点在 inner 坐标中的位置
        const ix = (mx - oldTx) / oldZoom;
        const iy = (my - oldTy) / oldZoom;
        // 步骤2：应用新缩放
        _maskImgZoom = newZoom;
        // 步骤3：反推新 translate，使同一图像点仍位于鼠标下方
        _maskTx = mx - ix * newZoom;
        _maskTy = my - iy * newZoom;
        // 步骤4：应用 CSS transform（使用 matrix 避免 CSS 解析歧义）
        singleImgInner.style.transformOrigin = "0 0";
        singleImgInner.style.transform = `matrix(${newZoom}, 0, 0, ${newZoom}, ${_maskTx}, ${_maskTy})`;
    }

    // 重置图片缩放
    function _resetImgZoom() {
        _maskImgZoom = 1;
        _maskTx = 0;
        _maskTy = 0;
        singleImgInner.style.transform = "";
        singleImgInner.style.transformOrigin = "";
    }

    // 把 overlay 上的坐标映射到离屏 canvas 的像素坐标
    function _overlayPtToOffscreen(px, py) {
        // 裁剪预览态：视窗显示的是裁剪画面，把点击映射回「全图」离屏坐标。
        // 离屏遮罩始终为全图尺寸，后端据此按 cropRect 同步裁剪，保证遮罩贴合裁剪后图像。
        const cp = _isCropPreviewActive() ? _cropPreviewDisplayRect() : null;
        if (cp) {
            const lx = px - cp.x2, ly = py - cp.y2;
            if (lx < 0 || ly < 0 || lx > cp.vw || ly > cp.vh) return null;
            return { x: cropRect.x + lx / cp.s2, y: cropRect.y + ly / cp.s2 };
        }
        const rect = _getImageDisplayRect();
        if (rect.scale <= 0) return null;
        const localX = px - rect.x;
        const localY = py - rect.y;
        if (localX < 0 || localY < 0 || localX > rect.w || localY > rect.h) return null;
        const ox = localX / rect.scale;
        const oy = localY / rect.scale;
        return { x: ox, y: oy };
    }

    // 确保离屏 canvas 匹配当前图的自然尺寸；切图时若换了图则重建；same=true 表示同一图保留已有内容
    function _ensureOffscreenCanvasSize(imageName, keepContent = false) {
        const iw = singleImgEl.naturalWidth;
        const ih = singleImgEl.naturalHeight;
        if (iw <= 0 || ih <= 0) return;
        _maskImgNaturalW = iw;
        _maskImgNaturalH = ih;
        _updateSingleResLabel();

        const sameImage = imageName && _maskBoundImageName === imageName;
        const sameSize = maskOffscreen.width === iw && maskOffscreen.height === ih;
        if (sameImage && sameSize) {
            if (keepContent) return;
            // keepContent=false 时仍需清空（同名图片重新上传场景）
            maskOffCtx.clearRect(0, 0, iw, ih);
            _maskBoundImageName = imageName || null;
            return;
        }

        // 保存旧内容用于缩放迁移（仅当 keepContent=true 且已有内容时）
        let oldSnapshot = null;
        if (keepContent && maskOffscreen.width > 0 && maskOffscreen.height > 0) {
            oldSnapshot = document.createElement("canvas");
            oldSnapshot.width = maskOffscreen.width;
            oldSnapshot.height = maskOffscreen.height;
            oldSnapshot.getContext("2d").drawImage(maskOffscreen, 0, 0);
        }

        maskOffscreen.width = iw;
        maskOffscreen.height = ih;
        // 默认清空（白底 + 完全透明的 alpha，我们用 R 通道存遮罩值并保持 A=255 以便渲染）
        maskOffCtx.clearRect(0, 0, iw, ih);

        if (oldSnapshot && keepContent) {
            maskOffCtx.save();
            maskOffCtx.imageSmoothingEnabled = true;
            maskOffCtx.imageSmoothingQuality = "high";
            maskOffCtx.drawImage(oldSnapshot, 0, 0, oldSnapshot.width, oldSnapshot.height, 0, 0, iw, ih);
            maskOffCtx.restore();
        }

        _maskBoundImageName = imageName || null;
    }

    // 把离屏遮罩渲染到 singleMaskOverlay（同步 overlay canvas 尺寸到容器尺寸，缩放绘制）
    function _renderMaskOverlay() {
        const cw = singleImgContainer.clientWidth;
        const ch = singleImgContainer.clientHeight;
        if (cw <= 0 || ch <= 0) return;
        // 同步 CSS 尺寸（确保 canvas 内部分辨率与 CSS 布局一致，避免坐标偏移）
        singleMaskOverlay.style.width = cw + "px";
        singleMaskOverlay.style.height = ch + "px";
        singleMaskOverlay.style.left = "0";
        singleMaskOverlay.style.top = "0";
        if (singleMaskOverlay.width !== cw || singleMaskOverlay.height !== ch) {
            singleMaskOverlay.width = cw;
            singleMaskOverlay.height = ch;
        }
        const octx = singleMaskOverlay.getContext("2d");
        octx.clearRect(0, 0, cw, ch);
        const rect = _getImageDisplayRect();

        // 裁剪选区：金色实线框 + 半透明金色填充，框外区域压暗（仅单图模式绘制）
        if (cropEnabled && rect.scale > 0 && _isCropPreviewActive()) {
            // 裁剪结果预览态：视窗显示的就是裁剪画面，仅绘制新的待选框（相对裁剪画面的显示矩形，支持继续裁剪）
            const s2 = Math.min(cw / cropRect.w, ch / cropRect.h);
            const x2 = (cw - cropRect.w * s2) / 2;
            const y2 = (ch - cropRect.h * s2) / 2;
            const vw = cropRect.w * s2, vh = cropRect.h * s2;
            const toX = (px) => x2 + (px - cropRect.x) * s2;
            const toY = (py) => y2 + (py - cropRect.y) * s2;
            let bx = null, by = null, bw = 0, bh = 0;
            if (_cropDrawing && _cropSelStart && _cropSelCur) {
                bx = Math.min(_cropSelStart.x, _cropSelCur.x);
                by = Math.min(_cropSelStart.y, _cropSelCur.y);
                bw = Math.abs(_cropSelCur.x - _cropSelStart.x);
                bh = Math.abs(_cropSelCur.y - _cropSelStart.y);
            } else if (_cropPending) {
                bx = _cropPending.x; by = _cropPending.y; bw = _cropPending.w; bh = _cropPending.h;
            }
            if (bx !== null && bw > 0 && bh > 0) {
                const X = Math.max(x2, toX(bx));
                const Y = Math.max(y2, toY(by));
                const X2 = Math.min(x2 + vw, toX(bx + bw));
                const Y2 = Math.min(y2 + vh, toY(by + bh));
                octx.save();
                // evenodd 单次填充"外框-选框"环形压暗，避免四块矩形拼接处的抗锯齿缝隙（浅色线）
                octx.fillStyle = "rgba(0,0,0,0.45)";
                octx.beginPath();
                octx.rect(x2, y2, vw, vh);
                octx.rect(X, Y, Math.max(0, X2 - X), Math.max(0, Y2 - Y));
                octx.fill("evenodd");
                octx.restore();
                octx.save();
                octx.fillStyle = "rgba(102,204,102,0.15)";
                octx.fillRect(X, Y, Math.max(0, X2 - X), Math.max(0, Y2 - Y));
                octx.strokeStyle = "#66CC66";
                octx.lineWidth = 2;
                octx.strokeRect(X + 0.5, Y + 0.5, Math.max(0, X2 - X) - 1, Math.max(0, Y2 - Y) - 1);
                octx.restore();
                if (_cropPending) _drawCropHandles(octx, X, Y, X2, Y2);
            }
        } else if (cropEnabled && rect.scale > 0) {
            const toX = (px) => rect.x + px * rect.scale;
            const toY = (py) => rect.y + py * rect.scale;
            let bx = null, by = null, bw = 0, bh = 0;
            if (_cropDrawing && _cropSelStart && _cropSelCur) {
                const dw = Math.abs(_cropSelCur.x - _cropSelStart.x);
                const dh = Math.abs(_cropSelCur.y - _cropSelStart.y);
                if (dw >= 3 || dh >= 3) { // 已拖出有效面积才显示新选框
                    bx = Math.min(_cropSelStart.x, _cropSelCur.x);
                    by = Math.min(_cropSelStart.y, _cropSelCur.y);
                    bw = dw; bh = dh;
                }
            }
            if (bx === null && _cropPending) { // 按下鼠标但未拖出：保留已有待选框，不让裁剪框消失
                bx = _cropPending.x; by = _cropPending.y; bw = _cropPending.w; bh = _cropPending.h;
            }
            if (bx === null && cropRect) { // 已应用裁剪：保留已有裁剪框作为参考
                bx = cropRect.x; by = cropRect.y; bw = cropRect.w; bh = cropRect.h;
            }
            if (bx !== null && bw > 0 && bh > 0) {
                const X = Math.max(rect.x, toX(bx));
                const Y = Math.max(rect.y, toY(by));
                const X2 = Math.min(rect.x + rect.w, toX(bx + bw));
                const Y2 = Math.min(rect.y + rect.h, toY(by + bh));
                octx.save();
                // evenodd 单次填充"外框-选框"环形压暗，避免四块矩形拼接处的抗锯齿缝隙（浅色线）
                octx.fillStyle = "rgba(0,0,0,0.45)";
                octx.beginPath();
                octx.rect(rect.x, rect.y, rect.w, rect.h);
                octx.rect(X, Y, Math.max(0, X2 - X), Math.max(0, Y2 - Y));
                octx.fill("evenodd");
                octx.restore();
                octx.save();
                octx.fillStyle = "rgba(102,204,102,0.15)";
                octx.fillRect(X, Y, Math.max(0, X2 - X), Math.max(0, Y2 - Y));
                octx.strokeStyle = "#66CC66";
                octx.lineWidth = 2;
                octx.strokeRect(X + 0.5, Y + 0.5, Math.max(0, X2 - X) - 1, Math.max(0, Y2 - Y) - 1);
                octx.restore();
                if (_cropPending && !_cropDrawing) _drawCropHandles(octx, X, Y, X2, Y2);
            }
        }

        // 遮罩显示：非裁剪预览 → 绘制全图遮罩；裁剪预览 → 叠加在裁剪画面上（只画裁剪区域内）
        if (maskOffscreen.width <= 0 || maskOffscreen.height <= 0) return;
        octx.save();
        octx.imageSmoothingEnabled = true;
        octx.imageSmoothingQuality = "high";
        // 遮罩层使用半透红色叠加，白色区域表示遮罩（绘制区域）
        // 先把离屏的 R 通道作为 alpha，渲染一层半透明红色
        const tmp = document.createElement("canvas");
        tmp.width = maskOffscreen.width;
        tmp.height = maskOffscreen.height;
        const tctx = tmp.getContext("2d");
        const src = maskOffCtx.getImageData(0, 0, maskOffscreen.width, maskOffscreen.height);
        const dst = tctx.createImageData(tmp.width, tmp.height);
        const sd = src.data, dd = dst.data;
        for (let i = 0; i < sd.length; i += 4) {
            const v = sd[i]; // R 通道 = 遮罩强度
            dd[i] = 255;                 // R = 红
            dd[i + 1] = 100;             // G
            dd[i + 2] = 100;             // B
            dd[i + 3] = Math.floor(v * 0.45); // A = 遮罩强度 * 半透明
        }
        tctx.putImageData(dst, 0, 0);
        const cp = _isCropPreviewActive() ? _cropPreviewDisplayRect() : null;
        if (cp) {
            // 裁剪预览：只取裁剪区域内那份遮罩，映射到裁剪画面的显示矩形
            const sx = Math.max(0, Math.min(cropRect.x, maskOffscreen.width));
            const sy = Math.max(0, Math.min(cropRect.y, maskOffscreen.height));
            const sw = Math.max(1, Math.min(cropRect.w, maskOffscreen.width - sx));
            const sh = Math.max(1, Math.min(cropRect.h, maskOffscreen.height - sy));
            octx.drawImage(tmp, sx, sy, sw, sh, cp.x2, cp.y2, cp.vw, cp.vh);
            octx.strokeStyle = "rgba(255,215,0,0.35)";
            octx.lineWidth = 1;
            octx.strokeRect(cp.x2 + 0.5, cp.y2 + 0.5, cp.vw - 1, cp.vh - 1);
        } else {
            octx.drawImage(tmp, rect.x, rect.y, rect.w, rect.h);
            octx.strokeStyle = "rgba(255,215,0,0.35)";
            octx.lineWidth = 1;
            octx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
        }
        octx.restore();
    }

    // 更新光标样式（使用 crosshair，笔刷大小由 overlay 预览圆圈显示）
    function _updateMaskCursor() {
        if (!singleMaskEventLayer) return;
        if (!maskEnabled) {
            singleMaskEventLayer.style.cursor = "";
            singleBrushPreview.style.display = "none";
            _maskHoverPt = null;
            _lastCursorZoom = 0;
            return;
        }
        singleMaskEventLayer.style.cursor = "crosshair";
        // 重置缓存，确保下次 hover 时重绘预览
        _lastCursorZoom = 0;
    }

    // 在笔刷预览 canvas 上绘制跟随鼠标的圆圈
    function _renderBrushPreview() {
        if (!maskEnabled) { singleBrushPreview.style.display = "none"; return; }
        if (!_maskHoverPt) { singleBrushPreview.style.display = "none"; return; }
        const cw = singleImgContainer.clientWidth;
        const ch = singleImgContainer.clientHeight;
        if (cw <= 0 || ch <= 0) return;
        const dpr = window.devicePixelRatio || 1;
        // 同步 canvas 尺寸（CSS 保持容器大小，内部缓冲按 dpr 倍率提升分辨率）
        singleBrushPreview.style.width = cw + "px";
        singleBrushPreview.style.height = ch + "px";
        singleBrushPreview.style.left = "0";
        singleBrushPreview.style.top = "0";
        const bufW = Math.round(cw * dpr);
        const bufH = Math.round(ch * dpr);
        if (singleBrushPreview.width !== bufW || singleBrushPreview.height !== bufH) {
            singleBrushPreview.width = bufW;
            singleBrushPreview.height = bufH;
        }
        singleBrushPreview.style.display = "block";
        const ctx = singleBrushPreview.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cw, ch);
        const r = Math.max(1, brushSize / 2);
        const px = _maskHoverPt.x;
        const py = _maskHoverPt.y;
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fillStyle = (_maskRightErasing ? "eraser" : maskTool) === "brush" ? "rgba(0,255,0,0.25)" : "rgba(255,100,100,0.25)";
        ctx.fill();
        ctx.strokeStyle = (_maskRightErasing ? "eraser" : maskTool) === "brush" ? "#0f0" : "#f33";
        ctx.lineWidth = 1;
        ctx.stroke();
    }

    // 在离屏 canvas 上画一段（从 from 到 to 的线段 + 端点），使用画笔/橡皮
    function _maskDrawSegment(fromPt, toPt) {
        if (maskOffscreen.width <= 0 || maskOffscreen.height <= 0) return;
        const tool = _maskRightErasing ? "eraser" : maskTool;
        const radius = Math.max(0.5, brushSize / 2);
        // 显示层的笔刷大小要映射到离屏坐标：裁剪预览态用裁剪画面的显示比例，
        // 否则用整图显示比例，保证笔刷视觉大小与预览圆圈一致
        const cp = _isCropPreviewActive() ? _cropPreviewDisplayRect() : null;
        const dispScale = cp ? cp.s2 : (_getImageDisplayRect().scale || 1);
        const offBrushR = Math.max(0.5, radius / dispScale);

        maskOffCtx.save();
        maskOffCtx.lineCap = "round";
        maskOffCtx.lineJoin = "round";
        maskOffCtx.lineWidth = offBrushR * 2;
        if (tool === "brush") {
            // 画笔：把 RGBA 全部填为 (255,0,0,255)
            maskOffCtx.globalCompositeOperation = "source-over";
            maskOffCtx.strokeStyle = "rgba(255,0,0,1)";
            maskOffCtx.fillStyle = "rgba(255,0,0,1)";
        } else {
            // 橡皮擦：把 RGBA 全部清空为透明 0（清空 R 通道 = 遮罩值 0）
            maskOffCtx.globalCompositeOperation = "source-over";
            maskOffCtx.strokeStyle = "rgba(0,0,0,0)";
            maskOffCtx.fillStyle = "rgba(0,0,0,0)";
            // 用 clearRect 逐段太麻烦，改用 destination-out 配合 alpha=1 可以清空像素到 0,0,0,0
            maskOffCtx.globalCompositeOperation = "destination-out";
            maskOffCtx.strokeStyle = "rgba(255,255,255,1)";
            maskOffCtx.fillStyle = "rgba(255,255,255,1)";
        }
        // 端点补圆（保证点击一下也有圆点，而不是线宽线段）
        if (toPt) {
            maskOffCtx.beginPath();
            maskOffCtx.moveTo(fromPt.x, fromPt.y);
            maskOffCtx.lineTo(toPt.x, toPt.y);
            maskOffCtx.stroke();
            maskOffCtx.beginPath();
            maskOffCtx.arc(toPt.x, toPt.y, offBrushR, 0, Math.PI * 2);
            maskOffCtx.fill();
        } else {
            maskOffCtx.beginPath();
            maskOffCtx.arc(fromPt.x, fromPt.y, offBrushR, 0, Math.PI * 2);
            maskOffCtx.fill();
        }
        maskOffCtx.restore();
    }

    // 序列化离屏遮罩为 base64 PNG（数据 URL），保存到 widget
    let _maskCommitTimer = null;
    function _commitMaskToWidget() {
        if (_maskCommitTimer) clearTimeout(_maskCommitTimer);
        _maskCommitTimer = setTimeout(() => {
            _maskCommitTimer = null;
            const w = getMaskDataWidget(node);
            if (!w) return;
            if (maskOffscreen.width <= 0 || maskOffscreen.height <= 0) {
                w.value = "";
                w.callback?.(w.value);
                return;
            }
            // 导出灰度 PNG：R = 遮罩值，A = 255
            const out = document.createElement("canvas");
            out.width = maskOffscreen.width;
            out.height = maskOffscreen.height;
            const octx = out.getContext("2d");
            const src = maskOffCtx.getImageData(0, 0, out.width, out.height);
            const dst = octx.createImageData(out.width, out.height);
            const sd = src.data, dd = dst.data;
            for (let i = 0; i < sd.length; i += 4) {
                const v = sd[i]; // R = 遮罩强度
                dd[i] = v; dd[i + 1] = v; dd[i + 2] = v; dd[i + 3] = 255;
            }
            octx.putImageData(dst, 0, 0);
            try {
                const dataUrl = out.toDataURL("image/png");
                w.value = dataUrl;
                w.callback?.(w.value);
            } catch (e) {
                console.warn("[小珠光图像加载器] 遮罩序列化失败:", e);
            }
        }, 60);
    }

    // 从 widget 加载已有遮罩到离屏 canvas
    function _loadMaskFromWidget(imageName) {
        const w = getMaskDataWidget(node);
        const data = w?.value;
        if (!data) {
            // 无保存数据 → 清空
            if (maskOffscreen.width > 0 && maskOffscreen.height > 0) {
                maskOffCtx.clearRect(0, 0, maskOffscreen.width, maskOffscreen.height);
            }
            return;
        }
        const img = new Image();
        img.onload = () => {
            if (_maskBoundImageName !== imageName) return; // 异步回来时已切图则丢弃
            if (maskOffscreen.width <= 0 || maskOffscreen.height <= 0) return;
            maskOffCtx.save();
            maskOffCtx.clearRect(0, 0, maskOffscreen.width, maskOffscreen.height);
            // 把灰度 PNG 的 R 通道写入我们的 R 通道，A 置为 255
            const tmp = document.createElement("canvas");
            tmp.width = img.naturalWidth;
            tmp.height = img.naturalHeight;
            tmp.getContext("2d").drawImage(img, 0, 0);
            const src = tmp.getContext("2d").getImageData(0, 0, tmp.width, tmp.height);
            const dst = maskOffCtx.createImageData(maskOffscreen.width, maskOffscreen.height);
            const sd = src.data, dd = dst.data;
            const sw = tmp.width, sh = tmp.height;
            const dw = maskOffscreen.width, dh = maskOffscreen.height;
            // 尺寸不一致 → 最近邻采样
            if (sw === dw && sh === dh) {
                for (let i = 0; i < sd.length; i += 4) {
                    const v = sd[i];
                    dd[i] = v; dd[i + 1] = 0; dd[i + 2] = 0; dd[i + 3] = 255;
                }
            } else {
                for (let y = 0; y < dh; y++) {
                    const sy = Math.min(sh - 1, Math.floor(y * sh / dh));
                    for (let x = 0; x < dw; x++) {
                        const sx = Math.min(sw - 1, Math.floor(x * sw / dw));
                        const si = (sy * sw + sx) * 4;
                        const di = (y * dw + x) * 4;
                        const v = sd[si];
                        dd[di] = v; dd[di + 1] = 0; dd[di + 2] = 0; dd[di + 3] = 255;
                    }
                }
            }
            maskOffCtx.putImageData(dst, 0, 0);
            maskOffCtx.restore();
            _renderMaskOverlay();
        };
        img.onerror = () => { /* 忽略损坏数据，保持空白 */ };
        img.src = data;
    }

    // ═══════════ 遮罩绘制事件绑定 ═══════════
    // 事件一律挂在 singleImgContainer（父）上，统一走捕获阶段，彻底避免子层 pointer-events 设置
    // 失效或 DOM 重排导致的"接不到事件"问题，这是最稳妥的一层。
    // pointer* 只在 maskEnabled=true 时真正进入绘制分支；false 时什么都不做直接放行。

    singleImgEl.draggable = false;

    // 仅阻止冒泡+默认，不杀同元素监听器
    const _softKill = (e) => {
        if (!maskEnabled) return;
        // 只当事件目标在遮罩区域（singleMaskEventLayer/Overlay/Img/Container 自身）才拦
        const path = e.composedPath ? e.composedPath() : [];
        if (!(path.includes(singleMaskEventLayer) || path.includes(singleMaskOverlay) ||
              e.target === singleImgEl || e.target === singleImgContainer)) return;
        try { e.preventDefault(); } catch (_) {}
        try { e.stopPropagation(); } catch (_) {}
    };
    singleImgContainer.addEventListener("mousedown", _softKill, true);
    singleImgContainer.addEventListener("touchstart", _softKill, true);
    singleImgContainer.addEventListener("touchmove", (e) => {
        if (!maskEnabled) return;
        try { e.preventDefault(); } catch (_) {}
        try { e.stopPropagation(); } catch (_) {}
    }, { capture: true, passive: false });
    singleImgContainer.addEventListener("gesturestart", _softKill, true);
    // 遮罩开启时无条件拦截右键菜单：右键已用于擦除/Alt+右键调整笔刷，不弹「保存图片」等菜单
    singleImgContainer.addEventListener("contextmenu", (e) => {
        if (!maskEnabled) return;
        try { e.preventDefault(); } catch (_) {}
        try { e.stopPropagation(); } catch (_) {}
    }, true);
    singleImgContainer.addEventListener("contextmenu", _softKill, true);
    singleImgContainer.addEventListener("dragstart", _softKill, true);
    singleImgContainer.addEventListener("selectstart", _softKill, true);
    singleImgEl.addEventListener("dragstart", (e) => { try { e.preventDefault(); } catch (_) {} }, true);

    function _onMaskPointerDown(e) {
        if (!maskEnabled) return;
        // 左键(0)画笔涂抹遮罩；右键(2)临时擦除遮罩；其它按键忽略
        if (e.button !== 0 && e.button !== 2) return;
        // Alt+右键按下：进入「拖动调整笔刷大小」模式，不绘制也不擦除
        if (e.button === 2 && e.altKey) {
            try { e.preventDefault(); } catch (_) {}
            try { e.stopPropagation(); } catch (_) {}
            try { if (singleImgContainer.setPointerCapture) singleImgContainer.setPointerCapture(e.pointerId); } catch (_) {}
            const rect = singleImgContainer.getBoundingClientRect();
            _altBrushActive = true;
            _maskDrawing = false;
            _altBrushStartX = (e.clientX - rect.left) / (singleImgContainer.clientWidth > 0 ? rect.width / singleImgContainer.clientWidth : 1);
            _altBrushStartSize = brushSize;
            singleImgContainer.style.cursor = "ew-resize";
            return;
        }
        _updateMaskCursor();
        // 判断是否点在遮罩事件层或 img 自身的矩形内（点击 sidebar 不触发）
        // 裁剪预览态原图被隐藏，点击目标变成裁剪预览画布，必须一并放行，否则画遮罩无响应
        const path = e.composedPath ? e.composedPath() : [e.target];
        const hit = path.includes(singleMaskEventLayer) || path.includes(singleMaskOverlay) ||
                    path.includes(singleCropPreviewCanvas) ||
                    e.target === singleImgEl || e.target === singleImgContainer;
        if (!hit) return;
        try { e.preventDefault(); } catch (_) {}
        try { e.stopPropagation(); } catch (_) {}
        const rect = singleImgContainer.getBoundingClientRect();
        const zoomX = singleImgContainer.clientWidth > 0 ? rect.width / singleImgContainer.clientWidth : 1;
        const zoomY = singleImgContainer.clientHeight > 0 ? rect.height / singleImgContainer.clientHeight : 1;
        let px = (e.clientX - rect.left) / zoomX;
        let py = (e.clientY - rect.top) / zoomY;
        // 图片缩放时转换到 inner 坐标
        const innerPt = _containerPtToInner(px, py);
        _maskHoverPt = { x: innerPt.x, y: innerPt.y };
        const pt = _overlayPtToOffscreen(innerPt.x, innerPt.y);
        if (!pt) return;
        // 命中且坐标有效后才设置右键擦除标志（避免误留状态影响预览颜色）
        _maskRightErasing = (e.button === 2);
        _renderBrushPreview();
        _maskDrawing = true;
        _maskLastPt = pt;
        try {
            if (singleImgContainer.setPointerCapture) {
                singleImgContainer.setPointerCapture(e.pointerId);
            }
        } catch (_) {}
        _maskDrawSegment(pt, null);
        _renderMaskOverlay();
    }
    function _onMaskPointerMove(e) {
        if (!_maskDrawing) return;
        try { e.preventDefault(); } catch (_) {}
        try { e.stopPropagation(); } catch (_) {}
        const rect = singleImgContainer.getBoundingClientRect();
        const zoomX = singleImgContainer.clientWidth > 0 ? rect.width / singleImgContainer.clientWidth : 1;
        const zoomY = singleImgContainer.clientHeight > 0 ? rect.height / singleImgContainer.clientHeight : 1;
        let px = (e.clientX - rect.left) / zoomX;
        let py = (e.clientY - rect.top) / zoomY;
        const innerPt = _containerPtToInner(px, py);
        _maskHoverPt = { x: innerPt.x, y: innerPt.y };
        _renderBrushPreview();
        const pt = _overlayPtToOffscreen(innerPt.x, innerPt.y);
        if (!pt) { _maskLastPt = null; return; }
        const from = _maskLastPt || pt;
        _maskDrawSegment(from, pt);
        _maskLastPt = pt;
        _renderMaskOverlay();
    }
    function _onMaskPointerUp(e) {
        // Alt+右键拖动调整笔刷：松开即结束
        if (_altBrushActive) {
            _altBrushActive = false;
            try { singleImgContainer.releasePointerCapture?.(e.pointerId); } catch (_) {}
            singleImgContainer.style.cursor = "crosshair";
        }
        const wasDrawing = _maskDrawing;
        if (wasDrawing) {
            _maskDrawing = false;
            _maskLastPt = null;
            _maskRightErasing = false;
            try { singleImgContainer.releasePointerCapture?.(e.pointerId); } catch (_) {}
            _commitMaskToWidget();
            _renderMaskOverlay();
            _renderBrushPreview(); // 刷新预览（恢复当前 maskTool 颜色）
        }
        if (maskEnabled) {
            try { e.preventDefault(); } catch (_) {}
            try { e.stopPropagation(); } catch (_) {}
        }
    }
    // 统一在 singleImgContainer 捕获阶段处理（先于冒泡阶段的 container.marquee 监听）
    singleImgContainer.addEventListener("pointerdown", _onMaskPointerDown, true);
    singleImgContainer.addEventListener("pointermove", _onMaskPointerMove, true);
    // hover / Alt+拖动调整笔刷大小
    singleImgContainer.addEventListener("pointermove", (e) => {
        if (!maskEnabled) return;
        const rect = singleImgContainer.getBoundingClientRect();
        const zoomX = singleImgContainer.clientWidth > 0 ? rect.width / singleImgContainer.clientWidth : 1;
        const zoomY = singleImgContainer.clientHeight > 0 ? rect.height / singleImgContainer.clientHeight : 1;
        const px = (e.clientX - rect.left) / zoomX;
        const py = (e.clientY - rect.top) / zoomY;
        const innerPt = _containerPtToInner(px, py);
        // Alt+右键按下并拖动调整笔刷大小：直接在 move 里检测（右键按住 e.buttons&2 + Alt），
        // 不依赖 pointerdown 是否到达，鲁棒性最高
        const altRb = !!(e.altKey && (e.buttons & 2));
        if (altRb) {
            if (!_altBrushActive) {
                _altBrushActive = true;
                _altBrushStartX = px;
                _altBrushStartSize = brushSize;
                _maskDrawing = false;   // 若右键已开始擦除，强制中断，优先调整笔刷
                _maskLastPt = null;
                _maskRightErasing = false;
                singleImgContainer.style.cursor = "ew-resize";
            }
            const dx = px - _altBrushStartX;
            const newSize = Math.max(1, Math.min(200, Math.round(_altBrushStartSize + dx)));
            if (newSize !== brushSize) {
                brushSize = newSize;
                try {
                    brushSizeInput.value = String(brushSize);
                    brushSizeLabel.textContent = `${xzgT("笔刷", "Brush")}:${brushSize}`;
                } catch (_) {}
                _renderBrushPreview();
            }
            _maskHoverPt = { x: innerPt.x, y: innerPt.y };
            return;
        }
        // 右键或 Alt 已松开，退出笔刷调整模式
        if (_altBrushActive) {
            _altBrushActive = false;
            singleImgContainer.style.cursor = "crosshair";
        }
        if (_maskDrawing) return;
        // 跟踪鼠标位置用于笔刷预览圆圈
        _maskHoverPt = { x: innerPt.x, y: innerPt.y };
        _renderBrushPreview();
    }, true);
    // 鼠标离开时清除预览和 Alt+右键拖动状态
    singleImgContainer.addEventListener("pointerleave", () => {
        _maskHoverPt = null;
        _altBrushActive = false;
        singleImgContainer.style.cursor = "crosshair";
        _renderBrushPreview();
    }, true);
    // Alt 键松开时退出拖动模式
    window.addEventListener("keyup", (e) => {
        if (e.key === "Alt" && _altBrushActive) {
            _altBrushActive = false;
            if (singleImgContainer) singleImgContainer.style.cursor = "crosshair";
        }
    }, true);
    singleImgContainer.addEventListener("pointerup", _onMaskPointerUp, true);
    singleImgContainer.addEventListener("pointercancel", _onMaskPointerUp, true);
    // 裁剪选区事件（与遮罩同一入口，捕获阶段统一处理）
    singleImgContainer.addEventListener("pointerdown", _onCropPointerDown, true);
    singleImgContainer.addEventListener("pointermove", _onCropPointerMove, true);
    singleImgContainer.addEventListener("pointerup", _onCropPointerUp, true);
    singleImgContainer.addEventListener("pointercancel", _onCropPointerUp, true);
    // 裁剪模式右键：直接在裁剪容器上弹出「应用裁剪/清空裁剪」菜单（捕获阶段，避免被全局拦截）
    singleImgContainer.addEventListener("contextmenu", (e) => {
        if (!cropEnabled) return;
        try { e.preventDefault(); } catch (_) {}
        try { e.stopPropagation(); } catch (_) {}
        showCropContextMenu(e.clientX, e.clientY);
    }, true);
    // pointerleave 不一定要结算（滑出容器还在拖的话，保持 drawing，回来还能续画）
    // 只有 pointerup/cancel 才真正落盘。

    // singleMaskEventLayer 还是保留用于视觉上的 hit 说明，但其 pointer-events
    // 始终为 none（永远不接事件），防止"pointerEvents:auto 没生效"这个最常见坑。
    singleMaskEventLayer.style.pointerEvents = "none";
    singleMaskEventLayer.style.display = "block";
    // 同步一次
    _updateMaskCursor();

    // 容器尺寸变化时重新渲染遮罩层
    const _maskResizeObserver = new ResizeObserver(() => {
        if (singleImgContainer.style.display !== "none") {
            _renderMaskOverlay();
            _renderBrushPreview();
        }
    });
    _maskResizeObserver.observe(singleImgContainer);

    // 图片加载完成后 → 初始化离屏 canvas、尝试加载保存的遮罩
    singleImgEl.addEventListener("load", () => {
        const curName = singleImgEl.dataset.currentName || singleImgEl.dataset.previewKey;
        _resetImgZoom();
        _ensureOffscreenCanvasSize(curName, false);
        _loadMaskFromWidget(curName);
        // 从 widget 加载裁剪数据，并刷新裁剪结果预览（load 后 naturalWidth 已更新）
        _loadCropFromWidget();
        _refreshCropPreview();
        _renderMaskOverlay();
        _updateMaskCursor();
    });

    // 当遮罩开启时，阻止 singleImgContainer 内的 mousedown 冒泡到外层容器（否则会触发卡片拖动/框选等逻辑）
    singleImgContainer.addEventListener("mousedown", (e) => {
        if (!maskEnabled) return;
        // 点击到侧边按钮不阻止（按钮在 sidebar，不在 singleImgContainer 内所以这里基本安全）
        e.preventDefault();
        e.stopPropagation();
    }, true);

    singleImgContainer.addEventListener("dblclick", (e) => {
        if (maskEnabled) {
            // 遮罩开启时不响应双击上传，避免打断绘制
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        if (cropEnabled) {
            // 裁剪模式下双击应用当前待选区裁剪
            _applyCrop();
            return;
        }
        openUploadDialog();
    });

    grid.addEventListener("dblclick", (e) => {
        if (e.target.closest(".del-btn")) return;
        e.preventDefault();
        e.stopPropagation();
        openUploadDialog();
    });

    container.appendChild(sidebar);
    container.appendChild(mainContent);

    // 全局跟踪鼠标位置（wheel 事件的 clientX/Y 可能滞后）
    container.addEventListener("pointermove", (e) => {
        const rect = singleImgContainer.getBoundingClientRect();
        const zoomX = singleImgContainer.clientWidth > 0 ? rect.width / singleImgContainer.clientWidth : 1;
        const zoomY = singleImgContainer.clientHeight > 0 ? rect.height / singleImgContainer.clientHeight : 1;
        _lastKnownMouseX = (e.clientX - rect.left) / zoomX;
        _lastKnownMouseY = (e.clientY - rect.top) / zoomY;
    });

    const onWheel = (e) => {
        // 遮罩/裁剪开启时，画布不再缩放，滚轮缩放图片本身
        if (maskEnabled || cropEnabled) {
            e.preventDefault();
            e.stopPropagation();
            if (singleImgContainer.contains(e.target)) {
                const delta = e.deltaY > 0 ? 0.85 : 1.15;
                // 直接使用 wheel 事件的屏幕坐标计算容器内坐标，避免 _lastKnownMouseX/Y 滞后问题
                const rect = singleImgContainer.getBoundingClientRect();
                const zoomX = singleImgContainer.clientWidth > 0 ? rect.width / singleImgContainer.clientWidth : 1;
                const zoomY = singleImgContainer.clientHeight > 0 ? rect.height / singleImgContainer.clientHeight : 1;
                const mx = (e.clientX - rect.left) / zoomX;
                const my = (e.clientY - rect.top) / zoomY;
                _applyImgZoom(mx, my, delta);
                // 缩放后同步更新 _lastKnownMouseX/Y 和触发 pointermove 让 hover handler 重新计算画笔位置
                _lastKnownMouseX = mx;
                _lastKnownMouseY = my;
                const fakeMove = new PointerEvent("pointermove", {
                    clientX: e.clientX, clientY: e.clientY,
                    bubbles: true, cancelable: true,
                });
                singleImgContainer.dispatchEvent(fakeMove);
            }
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        // 普通滚轮事件传递给画布（用于缩放画布）
        const canvasEl = app.canvas.canvas;
        const newEvent = new WheelEvent("wheel", {
            deltaX: e.deltaX,
            deltaY: e.deltaY,
            deltaZ: e.deltaZ,
            deltaMode: e.deltaMode,
            clientX: e.clientX,
            clientY: e.clientY,
            bubbles: true,
            cancelable: true,
        });
        canvasEl.dispatchEvent(newEvent);
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    grid.addEventListener("wheel", onWheel, { passive: false });
    mainContent.addEventListener("wheel", onWheel, { passive: false });
    singleImgContainer.addEventListener("wheel", onWheel, { passive: false });
    emptyTip.addEventListener("wheel", onWheel, { passive: false });

    // 监听容器尺寸变化，自动重新计算缩略图大小
    let resizeRaf = null;
    let lastCols = 0;
    let flipAnimTimer = null;

    // 随机翻转动画：给每张卡片设置随机轴、角度、方向
    const applyRandomFlip = (cells) => {
        cells.forEach(cell => {
            const axisType = Math.floor(Math.random() * 3);
            let fx, fy;
            if (axisType === 0) { fx = 1; fy = 0; }      // X轴
            else if (axisType === 1) { fx = 0; fy = 1; }  // Y轴
            else { fx = 1; fy = 1; }                       // 对角线
            const deg = 60 + Math.floor(Math.random() * 121);
            const sign = Math.random() < 0.5 ? -1 : 1;
            cell.style.setProperty("--fx", fx);
            cell.style.setProperty("--fy", fy);
            cell.style.setProperty("--fdeg", `${sign * deg}deg`);
        });
    };

    // 更新删除按钮尺寸（跟随卡片边长 20%）
    const _applyDelBtnSize = (delBtn, cardSize) => {
        if (!delBtn) return;
        const delBtnSize = Math.round(cardSize * 0.2);
        const delBtnFont = Math.round(delBtnSize * 0.72);
        delBtn.style.width = `${delBtnSize}px`;
        delBtn.style.height = `${delBtnSize}px`;
        delBtn.style.fontSize = `${delBtnFont}px`;
    };

    const resizeObserver = new ResizeObserver(() => {
        if (resizeRaf) cancelAnimationFrame(resizeRaf);
        resizeRaf = requestAnimationFrame(() => {
            const names = parseNameList(getImageListWidget(node)?.value || "");
            if (names.length > 0) {
                let availW = grid.clientWidth - 12;
                let availH = grid.clientHeight - 12;
                if (availW < 50 || availH < 50) {
                    availW = Math.max(50, node.size[0] - 78);
                    availH = Math.max(50, node.size[1] - 56);
                }
                const { size: newSize, cols: newCols } = computeAutoCardSize(availW, availH, names.length);
                const finalSize = Math.max(20, Math.floor(newSize));
                const currentSize = getCardSize(node);
                
                if (finalSize !== currentSize) {
                    // 列数变化时，卡片翻转动画
                    if (newCols !== lastCols && lastCols > 0) {
                        const cells = grid.querySelectorAll("[data-xzg-img-card]");

                        // 更新布局
                        setCardSize(node, finalSize);
                        lastCardSize = finalSize;
                        grid.style.setProperty("--card-size", `${finalSize}px`);
                        grid.style.gridTemplateColumns = `repeat(${newCols}, ${finalSize}px)`;
                        grid.style.perspective = "600px";

                        // 先清除旧动画状态
                        cells.forEach(cell => {
                            cell.style.width = `${finalSize}px`;
                            cell.style.height = `${finalSize}px`;
                            cell.style.transition = "none";
                            cell.style.animation = "none";
                            _applyDelBtnSize(cell.querySelector(".del-btn"), finalSize);
                        });
                        // 统一强制 reflow 一次，确保所有 cell 的 animation:none 已提交
                        void grid.offsetWidth;
                        // 设置翻转动画，每张卡片随机角度和方向
                        applyRandomFlip(cells);
                        cells.forEach(cell => {
                            cell.style.animation = "xzgCardFlipIn 1s ease-out forwards";
                        });

                        // 动画结束后恢复默认 transition（防重入：清除旧定时器）
                        if (flipAnimTimer) clearTimeout(flipAnimTimer);
                        flipAnimTimer = setTimeout(() => {
                            flipAnimTimer = null;
                            cells.forEach(cell => {
                                cell.style.animation = "";
                                cell.style.transition = "width 0.30s ease-out,height 0.30s ease-out";
                                cell.style.transform = "";
                            });
                            grid.style.perspective = "";
                        }, 1050);
                    } else {
                        // 只更新尺寸（列数不变），随机翻转动画
                        setCardSize(node, finalSize);
                        lastCardSize = finalSize;
                        grid.style.setProperty("--card-size", `${finalSize}px`);
                        grid.style.gridTemplateColumns = `repeat(${newCols}, ${finalSize}px)`;
                        grid.style.perspective = "600px";
                        const cells = grid.querySelectorAll("[data-xzg-img-card]");

                        // 先清除旧动画状态
                        cells.forEach(cell => {
                            cell.style.width = `${finalSize}px`;
                            cell.style.height = `${finalSize}px`;
                            cell.style.transition = "none";
                            cell.style.animation = "none";
                            _applyDelBtnSize(cell.querySelector(".del-btn"), finalSize);
                        });
                        // 统一强制 reflow
                        void grid.offsetWidth;
                        // 随机翻转动画
                        applyRandomFlip(cells);
                        cells.forEach(cell => {
                            cell.style.animation = "xzgCardFlipIn 1s ease-out forwards";
                        });

                        // 动画结束后恢复默认 transition（防重入：清除旧定时器）
                        if (flipAnimTimer) clearTimeout(flipAnimTimer);
                        flipAnimTimer = setTimeout(() => {
                            flipAnimTimer = null;
                            cells.forEach(cell => {
                                cell.style.animation = "";
                                cell.style.transition = "width 0.30s ease-out,height 0.30s ease-out";
                                cell.style.transform = "";
                            });
                            grid.style.perspective = "";
                        }, 1050);
                    }
                    lastCols = newCols;
                }
            }
        });
    });
    resizeObserver.observe(grid);

    let dragSortState = null;
    let marqueeState = null;
    const DRAG_CLICK_THRESHOLD = 5;
    const DRAG_SORT_SCALE_MS = 1000;
    const DRAG_SORT_SCALE = 1.15;
    const LONG_PRESS_MS = 500;
    const LONG_PRESS_ANIM_MS = 150;

    container.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        if (e.target.closest(".del-btn")) return;
        if (e.target.closest("button")) return;
        if (e.target.closest("input")) return;
        // 遮罩绘制模式下，命中遮罩事件层/遮罩覆盖层的 mousedown 直接丢弃，不进入卡片拖选/框选
        if (maskEnabled) {
            if (e.target === singleMaskEventLayer || e.target === singleMaskOverlay ||
                e.composedPath().includes(singleMaskEventLayer) ||
                e.composedPath().includes(singleMaskOverlay)) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation?.();
                return;
            }
        }
        e.stopPropagation();

        const cell = e.target.closest("[data-xzg-img-card]");
        const names = parseNameList(getImageListWidget(node)?.value);
        if (names.length === 0) return;

        const startX = e.clientX;
        const startY = e.clientY;
        const clickedIndex = cell ? parseInt(cell.dataset.xzgIndex, 10) : -1;

        const initialSelected = e.shiftKey || e.ctrlKey || e.metaKey
            ? [...selectedIndexes]
            : [];

        if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
            selectedIndexes = [];
            lastClickedIndex = -1;
        }

        let mode = null;
        let readyTimer = null;
        let moved = false;
        let sortReady = false;

        const marquee = document.createElement("div");
        marquee.style.cssText = `
            position: fixed;
            border: 1px solid ${getSelColor()};
            background: ${getSelColor()}22;
            pointer-events: none;
            z-index: 99998;
            display: none;
        `;
        document.body.appendChild(marquee);

        const cardInner = cell?.querySelector(":scope > div");

        // 按下时立即金边高亮（无过渡，瞬间生效），同时清除其他卡片的高亮
        if (cell && cardInner) {
            cardInner.style.transition = "none";
            cardInner.style.borderColor = getSelColor();
            // 立即清除其他所有卡片的高亮边框
            const allCards = grid.querySelectorAll("[data-xzg-img-card]");
            allCards.forEach((c) => {
                if (c === cell) return;
                const card = c.querySelector(":scope > div");
                if (card) {
                    card.style.transition = "none";
                    card.style.borderColor = "var(--border-color)";
                }
            });
        }

        // 长按 500ms 后放大卡片，进入排序模式
        const startLongPress = () => {
            if (!cell || !cardInner) return;
            readyTimer = setTimeout(() => {
                readyTimer = null;
                if (moved) return; // 已拖动则取消
                sortReady = true;
                // 放大时取消 overflow 裁剪，让卡片悬浮遮挡相邻区域
                cell.style.overflow = "visible";
                cell.style.zIndex = "9999";
                // 先设置过渡，强制 reflow 确保从 transition:none 平滑切换
                cardInner.style.transition = `transform ${LONG_PRESS_ANIM_MS}ms ease-out, box-shadow ${LONG_PRESS_ANIM_MS}ms ease-out`;
                void cardInner.offsetHeight;
                cardInner.style.transform = `scale(${DRAG_SORT_SCALE})`;
                cardInner.style.boxShadow = `0 8px 24px rgba(0,0,0,0.5)`;
            }, LONG_PRESS_MS);
        };

        const enterMarqueeMode = () => {
            mode = "marquee";
            marquee.style.display = "block";
            if (readyTimer) {
                clearTimeout(readyTimer);
                readyTimer = null;
            }
            if (cell && cardInner) {
                cardInner.style.transform = "";
                cardInner.style.boxShadow = "";
                cardInner.style.borderColor = "";
                cardInner.style.transition = "";
                cell.style.zIndex = "";
                cell.style.overflow = "hidden";
            }
            sortReady = false;
        };

        const enterSortMode = () => {
            if (clickedIndex < 0 || !cell) return;
            mode = "sort";
            sortReady = true;
            if (readyTimer) {
                clearTimeout(readyTimer);
                readyTimer = null;
            }

            const cellRect = cell.getBoundingClientRect();
            const ghost = document.createElement("div");
            ghost.className = "xzg-drag-ghost";
            const innerCard = cell.querySelector(":scope > div");
            ghost.innerHTML = innerCard.outerHTML;
            ghost.style.cssText = `
                position: fixed;
                left: ${cellRect.left}px;
                top: ${cellRect.top}px;
                width: ${cellRect.width}px;
                height: ${cellRect.height}px;
                pointer-events: none;
                z-index: 99999;
            `;
            const gCard = ghost.querySelector("div");
            if (gCard) {
                const selColor = getSelColor();
                gCard.style.borderColor = selColor;
                gCard.style.borderWidth = "2px";
                gCard.style.outline = `2px solid ${selColor}`;
                gCard.style.width = "100%";
                gCard.style.height = "100%";
                gCard.style.boxSizing = "border-box";
                gCard.style.transform = `scale(${DRAG_SORT_SCALE})`;
                gCard.style.transformOrigin = "center center";
                gCard.style.boxShadow = `0 4px 16px rgba(0,0,0,0.4), 0 0 8px ${selColor}`;
            }
            document.body.appendChild(ghost);

            cell.style.opacity = "0.3";
            if (cardInner) {
                cardInner.style.transform = "";
                cardInner.style.boxShadow = "";
                cardInner.style.transition = "";
                cell.style.zIndex = "";
                cell.style.overflow = "hidden";
            }

            const allCards = grid.querySelectorAll("[data-xzg-img-card]");
            allCards.forEach((c, ci) => {
                const card = c.querySelector(":scope > div");
                if (card) {
                    card.style.borderColor = ci === clickedIndex ? getSelColor() : "var(--border-color)";
                }
            });

            dragSortState = {
                dragIndex: clickedIndex,
                currentIndex: clickedIndex,
                offsetX: e.clientX - cellRect.left - cellRect.width * (DRAG_SORT_SCALE - 1) / 2,
                offsetY: e.clientY - cellRect.top - cellRect.height * (DRAG_SORT_SCALE - 1) / 2,
                ghost,
                origNames: [...names],
                order: names.map((_, i) => i),
                animating: false,
                cellRect,
            };

            selectedIndexes = [clickedIndex];
            lastClickedIndex = clickedIndex;
            setIndex(node, clickedIndex);
        };

        // 卡片上按下：启动长按定时器，拖动时进入框选；长按后进入排序
        if (cell) {
            startLongPress();
        } else {
            enterMarqueeMode();
        }

        const onMouseMove = (moveE) => {
            const dx = moveE.clientX - startX;
            const dy = moveE.clientY - startY;
            if (Math.max(Math.abs(dx), Math.abs(dy)) > DRAG_CLICK_THRESHOLD) {
                moved = true;
            }
            if (!moved) return;

            if (!mode) {
                if (sortReady) {
                    enterSortMode();
                } else {
                    enterMarqueeMode();
                }
            }

            if (mode === "marquee") {
                const left = Math.min(startX, moveE.clientX);
                const top = Math.min(startY, moveE.clientY);
                const width = Math.abs(dx);
                const height = Math.abs(dy);
                marquee.style.left = `${left}px`;
                marquee.style.top = `${top}px`;
                marquee.style.width = `${width}px`;
                marquee.style.height = `${height}px`;

                const cards = grid.querySelectorAll("[data-xzg-img-card]");
                const newSelected = new Set(initialSelected);
                const mRect = { left, top, right: left + width, bottom: top + height };

                cards.forEach((c, i) => {
                    const r = c.getBoundingClientRect();
                    if (r.right > mRect.left && r.left < mRect.right &&
                        r.bottom > mRect.top && r.top < mRect.bottom) {
                        newSelected.add(i);
                    }
                });

                selectedIndexes = Array.from(newSelected).sort((a, b) => a - b);
                const color = getSelColor();
                cards.forEach((c, i) => {
                    const card = c.querySelector(":scope > div");
                    if (card) {
                        card.style.borderColor = selectedIndexes.includes(i) ? color : "var(--border-color)";
                    }
                });
            } else if (mode === "sort" && dragSortState) {
                dragSortState.ghost.style.left = `${moveE.clientX - dragSortState.offsetX}px`;
                dragSortState.ghost.style.top = `${moveE.clientY - dragSortState.offsetY}px`;
                // 持续确保 ghost 卡片高亮边框不丢失
                const gCard = dragSortState.ghost.querySelector("div");
                if (gCard) {
                    const selColor = getSelColor();
                    gCard.style.borderColor = selColor;
                    gCard.style.borderWidth = "2px";
                    gCard.style.outline = `2px solid ${selColor}`;
                    gCard.style.boxShadow = `0 4px 16px rgba(0,0,0,0.4), 0 0 8px ${selColor}`;
                }

                const ghostRect = dragSortState.ghost.getBoundingClientRect();
                const ghostCx = ghostRect.left + ghostRect.width / 2;
                const ghostCy = ghostRect.top + ghostRect.height / 2;

                const cards = grid.querySelectorAll("[data-xzg-img-card]");
                let targetCard = null;

                for (let i = 0; i < cards.length; i++) {
                    const c = cards[i];
                    if (c.style.opacity === "0.3") continue;
                    const r = c.getBoundingClientRect();
                    if (ghostCx >= r.left && ghostCx <= r.right &&
                        ghostCy >= r.top && ghostCy <= r.bottom) {
                        targetCard = c;
                        break;
                    }
                }

                if (targetCard && !dragSortState.animating) {
                    const currentCard = cards[dragSortState.currentIndex];
                    if (targetCard === currentCard) return;

                    dragSortState.animating = true;
                    const cardsArr = Array.from(cards);

                    const draggedEl = cardsArr[dragSortState.currentIndex];
                    const targetIdx = cardsArr.indexOf(targetCard);
                    const fromLeft = dragSortState.currentIndex < targetIdx;
                    if (fromLeft) {
                        targetCard.after(draggedEl);
                    } else {
                        targetCard.before(draggedEl);
                    }

                    const newCards = grid.querySelectorAll("[data-xzg-img-card]");
                    let newIndex = -1;
                    newCards.forEach((c, i) => {
                        if (c === draggedEl) newIndex = i;
                    });

                    const order = dragSortState.order;
                    const [movedIdx] = order.splice(dragSortState.currentIndex, 1);
                    order.splice(newIndex, 0, movedIdx);
                    dragSortState.currentIndex = newIndex;

                    dragSortState.animating = false;
                }
            }
        };

        const onMouseUp = () => {
            if (readyTimer) {
                clearTimeout(readyTimer);
                readyTimer = null;
            }

            marquee.remove();
            marqueeState = null;
            document.removeEventListener("mousemove", onMouseMove);
            document.removeEventListener("mouseup", onMouseUp);
            document.removeEventListener("contextmenu", onContextMenu);

            if (cell && cardInner && mode !== "sort") {
                cardInner.style.transition = `transform ${LONG_PRESS_ANIM_MS}ms ease-out, box-shadow ${LONG_PRESS_ANIM_MS}ms ease-out, border-color ${LONG_PRESS_ANIM_MS}ms ease-out`;
                void cardInner.offsetHeight;
                cardInner.style.transform = "";
                cardInner.style.boxShadow = "";
                cardInner.style.borderColor = "";
                cell.style.zIndex = "";
                cell.style.overflow = "hidden";
                setTimeout(() => {
                    if (cardInner) cardInner.style.transition = "";
                }, LONG_PRESS_ANIM_MS);
            }

            if (mode === "sort" && dragSortState) {
                const sortState = dragSortState;
                sortState.ghost.remove();

                if (moved) {
                    const preventClick = (ev) => {
                        ev.preventDefault();
                        ev.stopPropagation();
                        ev.stopImmediatePropagation();
                        document.removeEventListener("click", preventClick, true);
                    };
                    document.addEventListener("click", preventClick, true);
                    setTimeout(() => document.removeEventListener("click", preventClick, true), 0);
                }

                const order = sortState.order;
                const origNames = sortState.origNames;
                const newNames = order.map(i => origNames[i]);
                const namesChanged = newNames.some((n, i) => n !== origNames[i]);

                if (moved && namesChanged) {
                    setNameList(node, newNames);
                    const oldIdx = getIndex(node);
                    const newIdx = order.indexOf(oldIdx);
                    setIndex(node, newIdx >= 0 ? newIdx : 0);
                    selectedIndexes = [];
                    lastClickedIndex = -1;
                }

                const cards = grid.querySelectorAll("[data-xzg-img-card]");
                cards.forEach(c => {
                    c.style.opacity = "";
                    c.style.transform = "";
                    c.style.transition = "";
                });

                dragSortState = null;

                if (moved && namesChanged) {
                    lastNames = null;
                    redraw(true);
                    // 顺序调整后触发随机翻转动画（与改变缩略图大小/行列数一致）
                    requestAnimationFrame(() => {
                        const cells = grid.querySelectorAll("[data-xzg-img-card]");
                        if (!cells.length) return;
                        grid.style.perspective = "600px";
                        cells.forEach(cell => {
                            cell.style.transition = "none";
                            cell.style.animation = "none";
                        });
                        void grid.offsetWidth;
                        applyRandomFlip(cells);
                        cells.forEach(cell => {
                            cell.style.animation = "xzgCardFlipIn 1s ease-out forwards";
                        });
                        if (flipAnimTimer) clearTimeout(flipAnimTimer);
                        flipAnimTimer = setTimeout(() => {
                            flipAnimTimer = null;
                            cells.forEach(cell => {
                                cell.style.animation = "";
                                cell.style.transition = "width 0.30s ease-out,height 0.30s ease-out";
                                cell.style.transform = "";
                            });
                            grid.style.perspective = "";
                        }, 1050);
                    });
                }
            } else if (mode === "marquee") {
                if (moved) {
                    redraw(true);
                } else {
                    selectedIndexes = [];
                    lastClickedIndex = -1;
                    const cards = grid.querySelectorAll("[data-xzg-img-card]");
                    cards.forEach((c) => {
                        const card = c.querySelector(":scope > div");
                        if (card) {
                            card.style.borderColor = "var(--border-color)";
                        }
                    });
                }
            } else if (!moved && cell && clickedIndex >= 0) {
                if (e.shiftKey && lastClickedIndex >= 0) {
                    const start = Math.min(lastClickedIndex, clickedIndex);
                    const end = Math.max(lastClickedIndex, clickedIndex);
                    for (let j = start; j <= end; j++) {
                        selectedIndexes.push(j);
                    }
                    selectedIndexes = [...new Set(selectedIndexes)].sort((a, b) => a - b);
                    const cards = grid.querySelectorAll("[data-xzg-img-card]");
                    const color = getSelColor();
                    cards.forEach((c, i) => {
                        const card = c.querySelector(":scope > div");
                        if (card) {
                            const isSelected = selectedIndexes.includes(i);
                            card.style.borderColor = isSelected ? color : "var(--border-color)";
                        }
                    });
                } else if (e.ctrlKey || e.metaKey) {
                    const idx = selectedIndexes.indexOf(clickedIndex);
                    if (idx >= 0) {
                        selectedIndexes.splice(idx, 1);
                    } else {
                        selectedIndexes.push(clickedIndex);
                        selectedIndexes.sort((a, b) => a - b);
                    }
                    lastClickedIndex = clickedIndex;
                    const cards = grid.querySelectorAll("[data-xzg-img-card]");
                    const color = getSelColor();
                    cards.forEach((c, i) => {
                        const card = c.querySelector(":scope > div");
                        if (card) {
                            const isSelected = selectedIndexes.includes(i);
                            card.style.borderColor = isSelected ? color : "var(--border-color)";
                        }
                    });
                } else {
                    selectedIndexes = [clickedIndex];
                    lastClickedIndex = clickedIndex;
                    setIndex(node, clickedIndex);
                    // 仅更新边框，不重建 DOM（否则会破坏 dblclick 事件）
                    const cards = grid.querySelectorAll("[data-xzg-img-card]");
                    const color = getSelColor();
                    cards.forEach((c, i) => {
                        const card = c.querySelector(":scope > div");
                        if (card) {
                            card.style.borderColor = i === clickedIndex ? color : "var(--border-color)";
                        }
                    });
                    if (app?.canvas) app.canvas.setDirty(true, true);
                }
            }
        };

        const onContextMenu = (ev) => {
            ev.preventDefault();
        };

        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
        document.addEventListener("contextmenu", onContextMenu, true);
    });

    const redraw = (forceFull = false) => {
        const names = parseNameList(getImageListWidget(node)?.value);
        const cardSize = getCardSize(node);
        const idx = getIndex(node);

        // 始终从 widget 同步真实值，防止闭包变量 uploadMode 在 onConfigure 之前被初始化
        // 为 "append" 后永远无法被更新（redraw 是调用最频繁的入口，这里最为可靠）
        const w = getUploadModeWidget(node);
        if (w) {
            const modeFromWidget = (String(w.value).trim().toLowerCase() === "replace") ? "replace" : "append";
            if (modeFromWidget !== uploadMode) {
                uploadMode = modeFromWidget;
                if (uploadMode === "append") maskEnabled = false;
                updateUploadModeBtn();
                _refreshMaskToolbar();
                _updateMaskCursor();
            }
        }
        viewMode = uploadMode === "append" ? "grid" : "single";

        const effectiveSingle = viewMode === "single" || (viewMode === "grid" && names.length === 1);

        if (names.length === 0) {
            grid.style.display = "none";
            singleImgContainer.style.display = "none";
            emptyTip.style.display = "flex";
            lastNames = [];
            lastCardSize = cardSize;
            selectedIndexes = [];
            lastClickedIndex = -1;
            return;
        }

        if (effectiveSingle && names.length >= 1) {
            grid.style.display = "none";
            emptyTip.style.display = "none";
            singleImgContainer.style.display = "flex";
            // 统一同步遮罩层显示状态（只通过一个入口改，避免冲突）
            _syncMaskLayerVisibility();
            const curIdx = idx >= 0 && idx < names.length ? idx : 0;
            const name = names[curIdx];
            // 单图/1图模式使用压缩预览（最长边 3840px），避免大图卡顿
            const imgKeyChanged = singleImgEl.dataset.previewKey !== name;
            if (imgKeyChanged) {
                singleImgEl.dataset.previewKey = name;
                singleImgEl.dataset.currentName = name;
                singleImgEl.src = getPreviewUrl(name);
                // 切图时重置原始分辨率，异步获取真实尺寸更新分辨率标签
                _singleOrigW = 0;
                _singleOrigH = 0;
                _xzgFetchOriginalSize(name).then((info) => {
                    if (info && singleImgEl.dataset.previewKey === name) {
                        _singleOrigW = info.width;
                        _singleOrigH = info.height;
                        _updateSingleResLabel();
                    }
                });
            } else if (singleImgEl.complete && singleImgEl.naturalWidth > 0) {
                // 图片已加载好：立即同步离屏 canvas 尺寸，必要时加载保存的遮罩
                _ensureOffscreenCanvasSize(name, false);
                _renderMaskOverlay();
                _updateSingleResLabel();
                // 若原始分辨率尚未获取，补充获取一次
                if (!_singleOrigW) {
                    _xzgFetchOriginalSize(name).then((info) => {
                        if (info && singleImgEl.dataset.previewKey === name) {
                            _singleOrigW = info.width;
                            _singleOrigH = info.height;
                            _updateSingleResLabel();
                        }
                    });
                }
            }
            if (selectedIndexes.length !== 1 || selectedIndexes[0] !== curIdx) {
                selectedIndexes = [curIdx];
            }
            lastClickedIndex = curIdx;
            lastNames = [...names];
            lastCardSize = cardSize;
            // 从 widget 加载裁剪数据并刷新裁剪结果预览：即使不在裁剪模式，
            // 存在裁剪选区时节点上显示的也是裁剪后的效果
            _loadCropFromWidget();
            _refreshCropPreview();
            _refreshMaskToolbar();
            _updateMaskCursor();
            return;
        }

        // 多图网格模式：统一入口同步
        _syncMaskLayerVisibility();

        grid.style.display = "grid";
        singleImgContainer.style.display = "none";
        emptyTip.style.display = "none";

        const namesUnchanged = lastNames && names.length === lastNames.length &&
            names.every((n, i) => n === lastNames[i]);
        const sizeUnchanged = lastCardSize === cardSize;

        if (!forceFull && namesUnchanged && sizeUnchanged) {
            const cards = grid.querySelectorAll("[data-xzg-img-card]");
            cards.forEach((cell, i) => {
                const card = cell.querySelector(":scope > div");
                if (card) {
                    const isSelected = selectedIndexes.includes(i);
                    card.style.borderColor = isSelected ? getSelColor() : "var(--border-color)";
                }
            });
            return;
        }

        lastNames = [...names];
        // 获取 grid 的实际可用空间（clientWidth 已包含 padding，减去后是可用空间）
        let availW = grid.clientWidth - 12;
        let availH = grid.clientHeight - 12;
        if (availW < 50 || availH < 50) {
            availW = Math.max(50, node.size[0] - 78);
            availH = Math.max(50, node.size[1] - 56);
        }

        const { size: autoCardSize, cols: bestCols } = computeAutoCardSize(availW, availH, names.length);

        const contentSize = Math.max(20, Math.floor(autoCardSize));
        setCardSize(node, contentSize);
        lastCardSize = contentSize;
        grid.style.setProperty("--card-size", `${contentSize}px`);
        grid.style.gridTemplateColumns = `repeat(${bestCols}, ${contentSize}px)`;
        grid.innerHTML = "";

        const frag = document.createDocumentFragment();

        names.forEach((name, i) => {
            const isSelected = selectedIndexes.includes(i);
            const cell = document.createElement("div");
            cell.style.cssText = `display:flex;flex-direction:column;cursor:grab;width:${contentSize}px;height:${contentSize}px;overflow:hidden;position:relative;transition:width 0.30s ease-out,height 0.30s ease-out;`;
            cell.dataset.xzgImgCard = "1";
            cell.dataset.xzgIndex = String(i);

            const card = document.createElement("div");
            card.style.cssText = `position:relative;border-radius:2px;border:1px solid ${
                isSelected ? getSelColor() : "var(--border-color)"
            };background:rgba(128,128,128,0.4);width:100%;height:100%;overflow:hidden;box-sizing:border-box;`;

            const thumbEl = document.createElement("img");
            thumbEl.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;object-fit:contain;display:block;transition:opacity 0.15s ease;";
            thumbEl.draggable = false;
            thumbEl.onerror = () => {
                const names = parseNameList(getImageListWidget(node)?.value);
                const idx = names.indexOf(name);
                if (idx >= 0) {
                    const next = names.slice(0, idx).concat(names.slice(idx + 1));
                    setNameList(node, next);
                    const curIdx = getIndex(node);
                    if (curIdx >= next.length) {
                        setIndex(node, Math.max(0, next.length - 1));
                    }
                }
            };
            thumbEl.src = getThumbUrl(name, 512);

            // 删除按钮尺寸跟随卡片缩放：卡片边长的 20%，贴近右上角
            const delBtn = document.createElement("div");
            delBtn.className = "del-btn";
            delBtn.textContent = "×";
            delBtn.style.cssText =
                "position:absolute;top:0;right:0;display:flex;align-items:center;justify-content:center;line-height:1;color:#fff;cursor:pointer;z-index:3;opacity:0;";
            _applyDelBtnSize(delBtn, contentSize);
            delBtn.title = xzgT("删除", "Delete");
            delBtn.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                const names = parseNameList(getImageListWidget(node)?.value);
                const next = names.slice(0, i).concat(names.slice(i + 1));
                setNameList(node, next);
                const curIdx = getIndex(node);
                if (curIdx >= next.length) {
                    setIndex(node, Math.max(0, next.length - 1));
                }
            });
            card.addEventListener("mouseenter", () => {
                delBtn.style.opacity = "1";
            });
            card.addEventListener("mouseleave", () => {
                delBtn.style.opacity = "0";
            });

            const label = document.createElement("div");
            label.textContent = name;
            label.title = name;
            label.className = "xzg-img-label";
            label.style.cssText =
                "position:absolute;left:2px;right:2px;bottom:2px;font-size:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:0.7;line-height:1.2;text-align:center;color:#fff;z-index:1;";

            card.appendChild(thumbEl);
            card.appendChild(delBtn);
            card.appendChild(label);
            cell.appendChild(card);
            frag.appendChild(cell);
        });

        grid.appendChild(frag);
    };

    const openUploadDialog = () => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.multiple = true;
        input.style.display = "none";
        document.body.appendChild(input);

        input.onchange = async (ev) => {
            const files = Array.from(ev.target.files);
            if (files.length === 0) {
                input.remove();
                return;
            }

            const uploaded = await uploadFilesSequential(files);
            if (uploaded.length > 0) {
                if (uploadMode === "replace") {
                    setNameList(node, uploaded);
                    setIndex(node, 0);
                } else {
                    const all = parseNameList(getImageListWidget(node)?.value);
                    const existing = new Set(all);
                    const newOnes = uploaded.filter(n => !existing.has(n));
                    const merged = newOnes.concat(all);
                    setNameList(node, merged);
                    setIndex(node, 0);
                }
                redraw(true);
            }

            input.remove();
        };

        input.click();
    };

    uploadBtn.onclick = (e) => {
        e.stopPropagation();
        openUploadDialog();
    };

    const showFolderDialog = (apiUrl, title, prefix, copyToInput = false, selColor = "#FFD700") => {
        const all = parseNameList(getImageListWidget(node)?.value);
        let selectedSet = new Set();
        if (!copyToInput) {
            if (prefix) {
                all.filter((entry) => entry.endsWith(prefix)).forEach((entry) => {
                    selectedSet.add(entry.slice(0, -prefix.length));
                });
            } else {
                all.filter((entry) => !/\s\[(output|input|temp)\]$/.test(entry)).forEach((entry) => {
                    selectedSet.add(entry);
                });
            }
        }
        let searchText = "";
        let fileData = {};
        let fileNames = [];
        const currentSource = title;

        const fetchFiles = async () => {
            const r = await fetch(api.apiURL(apiUrl));
            const files = await r.json();
            const imgFiles = files
                .filter(f => f.type === "image")
                .sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
            fileData = {};
            imgFiles.forEach(f => { fileData[f.name] = f; });
            fileNames = imgFiles.map(f => f.name);
            return fileData;
        };

        fetchFiles().then(() => {

            const overlay = document.createElement("div");
            overlay.style.cssText =
                "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;";
            overlay.onclick = (e) => {
                if (e.target === overlay) overlay.remove();
            };

            const dialog = document.createElement("div");
            dialog.style.cssText =
                "background:var(--comfy-menu-bg);border:1px solid var(--border-color);border-radius:8px;width:1000px;max-height:80vh;display:flex;flex-direction:column;overflow:hidden;";
            dialog.onclick = (e) => e.stopPropagation();

            dialog.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--border-color);">
                    <div style="font-weight:bold;font-size:14px;color:var(--input-text);">${xzgTh("从", "Select from")} ${title} ${xzgTh("文件夹选择", "folder")}</div>
                    <input type="text" class="search-input" placeholder="${xzgTh("搜索...", "Search...")}" style="padding:4px 8px;background:var(--comfy-input-bg);color:var(--input-text);border:1px solid var(--border-color);border-radius:4px;font-size:12px;width:180px;outline:none;">
                </div>
                <div class="xzg-folder-grid xzg-img-grid" style="flex:1;width:100%;box-sizing:border-box;overflow-y:auto;padding:8px;min-height:360px;"></div>
                <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-top:1px solid var(--border-color);background:var(--comfy-input-bg);">
                    <div style="display:flex;gap:8px;align-items:center;">
                        <span style="font-size:12px;color:var(--input-text);">${xzgTh("已选:", "Selected:")} <span class="selected-count">${selectedSet.size}</span></span>
                        <button class="select-all-btn" style="padding:4px 10px;background:var(--comfy-menu-bg);color:var(--input-text);border:1px solid var(--border-color);border-radius:4px;cursor:pointer;font-size:12px;">${xzgTh("全选", "Select All")}</button>
                        <button class="clear-select-btn" style="padding:4px 10px;background:var(--comfy-menu-bg);color:var(--input-text);border:1px solid var(--border-color);border-radius:4px;cursor:pointer;font-size:12px;">${xzgTh("取消全选", "Deselect All")}</button>
                        <button class="del-selected-btn" style="padding:4px 10px;background:#c0392b;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;">${xzgTh("删除选中", "Delete Selected")}</button>
                    </div>
                    <div style="display:flex;gap:8px;">
                        <button class="cancel-btn" style="padding:6px 16px;background:var(--comfy-menu-bg);color:var(--input-text);border:1px solid var(--border-color);border-radius:4px;cursor:pointer;font-size:12px;">${xzgTh("取消", "Cancel")}</button>
                        <button class="ok-btn" style="padding:6px 16px;background:#FFD700;color:#333;border:none;border-radius:4px;cursor:pointer;font-size:12px;">${xzgTh("载入", "Load")}</button>
                    </div>
                </div>
            `;

            overlay.appendChild(dialog);
            document.body.appendChild(overlay);

            const fileContainer = dialog.querySelector(".xzg-folder-grid");
            const selectedCountEl = dialog.querySelector(".selected-count");

            const getFilteredFiles = () => {
                if (!searchText) return fileNames;
                const lower = searchText.toLowerCase();
                return fileNames.filter(f => f.toLowerCase().includes(lower));
            };

            const updateSelectedCount = () => {
                selectedCountEl.textContent = selectedSet.size;
            };

            let lastClickedIndex = -1;

            const renderThumbs = () => {
                const filtered = getFilteredFiles();
                fileContainer.innerHTML = "";
                fileContainer.style.display = "grid";
                const cols = Math.min(8, Math.max(4, filtered.length));
                fileContainer.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
                fileContainer.style.gap = "2px";
                fileContainer.style.alignContent = "start";

                const frag = document.createDocumentFragment();
                filtered.forEach((name, i) => {
                    const isSelected = selectedSet.has(name);
                    const item = document.createElement("div");
                    item.style.cssText = `
                        position:relative;display:flex;flex-direction:column;align-items:center;gap:2px;
                        padding:2px;border-radius:4px;cursor:pointer;
                        border:1px solid ${isSelected ? selColor : "transparent"};
                        background:${isSelected ? "rgba(255,255,255,0.1)" : "transparent"};
                    `;
                    item.title = name;
                    item.dataset.name = name;
                    item.dataset.index = String(i);

                    const thumb = document.createElement("div");
                    thumb.style.cssText =
                        "width:100%;padding-top:100%;position:relative;border-radius:2px;overflow:hidden;background:rgba(128,128,128,0.4);";
                    const img = document.createElement("img");
                    const fileInfo = fileData[name];
                    const v = fileInfo?.mtime ? `&v=${fileInfo.mtime}` : "";
                    img.src = getThumbUrl(name + prefix, 128) + v;
                    img.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;object-fit:contain;";
                    img.loading = "lazy";
                    img.addEventListener("error", () => {
                        fileNames = fileNames.filter(f => f !== name);
                        delete fileData[name];
                        selectedSet.delete(name);
                        renderThumbs();
                        updateSelectedCount();
                    });
                    thumb.appendChild(img);
                    item.appendChild(thumb);
                    const label = document.createElement("div");
                    label.style.cssText =
                        "font-size:11px;color:var(--input-text);text-align:center;width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
                    label.textContent = name;

                    item.appendChild(label);

                    frag.appendChild(item);
                });
                fileContainer.appendChild(frag);
            };

            fileContainer.addEventListener("dblclick", async (ev) => {
                const item = ev.target.closest("[data-name]");
                if (!item) return;
                ev.preventDefault();
                ev.stopPropagation();
                const name = item.dataset.name;
                if (!name) return;
                selectedSet.clear();
                selectedSet.add(name);
                const ok = await addSelectedImages();
                if (ok !== false) overlay.remove();
            });

            const FILE_DRAG_THRESHOLD = 5;
            fileContainer.addEventListener("mousedown", (ev) => {
                if (ev.button !== 0) return;
                if (ev.target.closest(".del-btn")) return;
                ev.preventDefault();
                ev.stopPropagation();

                const filtered = getFilteredFiles();
                if (filtered.length === 0) return;

                const startX = ev.clientX;
                const startY = ev.clientY;

                const marquee = document.createElement("div");
                marquee.style.cssText = `
                    position: fixed;
                    border: 1px solid ${selColor};
                    background: ${selColor}22;
                    pointer-events: none;
                    z-index: 99999;
                `;
                document.body.appendChild(marquee);

                const clickedItem = ev.target.closest("[data-name]");
                const clickedName = clickedItem?.dataset.name;

                const initialSet = ev.shiftKey || ev.ctrlKey || ev.metaKey
                    ? new Set(selectedSet)
                    : new Set();

                if (!ev.shiftKey && !ev.ctrlKey && !ev.metaKey) {
                    selectedSet.clear();
                    lastClickedIndex = -1;
                }

                let moved = false;

                const onMouseMove = (moveEv) => {
                    const dx = moveEv.clientX - startX;
                    const dy = moveEv.clientY - startY;
                    if (Math.max(Math.abs(dx), Math.abs(dy)) > FILE_DRAG_THRESHOLD) {
                        moved = true;
                    }
                    if (!moved) return;

                    const left = Math.min(startX, moveEv.clientX);
                    const top = Math.min(startY, moveEv.clientY);
                    const width = Math.abs(dx);
                    const height = Math.abs(dy);
                    marquee.style.left = `${left}px`;
                    marquee.style.top = `${top}px`;
                    marquee.style.width = `${width}px`;
                    marquee.style.height = `${height}px`;

                    const items = fileContainer.querySelectorAll("[data-name]");
                    const newSet = new Set(initialSet);
                    const mRect = { left, top, right: left + width, bottom: top + height };

                    items.forEach((item) => {
                        const r = item.getBoundingClientRect();
                        if (r.right > mRect.left && r.left < mRect.right &&
                            r.bottom > mRect.top && r.top < mRect.bottom) {
                            const nm = item.dataset.name;
                            if (nm) newSet.add(nm);
                        }
                    });

                    selectedSet = newSet;
                    items.forEach((item) => {
                        const nm = item.dataset.name;
                        const sel = selectedSet.has(nm);
                        item.style.borderColor = sel ? selColor : "transparent";
                        item.style.background = sel ? "rgba(255,255,255,0.1)" : "transparent";
                    });
                    updateSelectedCount();
                };

                const onMouseUp = () => {
                    marquee.remove();
                    document.removeEventListener("mousemove", onMouseMove);
                    document.removeEventListener("mouseup", onMouseUp);
                    document.removeEventListener("contextmenu", onCtxMenu);
                    if (moved) {
                        renderThumbs();
                    } else if (clickedItem && clickedName) {
                        if (ev.shiftKey && lastClickedIndex >= 0) {
                            const filteredNow = getFilteredFiles();
                            const clickIdx = filteredNow.indexOf(clickedName);
                            if (clickIdx >= 0) {
                                const start = Math.min(lastClickedIndex, clickIdx);
                                const end = Math.max(lastClickedIndex, clickIdx);
                                for (let j = start; j <= end; j++) {
                                    selectedSet.add(filteredNow[j]);
                                }
                            }
                        } else if (ev.ctrlKey || ev.metaKey) {
                            if (selectedSet.has(clickedName)) {
                                selectedSet.delete(clickedName);
                            } else {
                                selectedSet.add(clickedName);
                            }
                            const filteredNow = getFilteredFiles();
                            lastClickedIndex = filteredNow.indexOf(clickedName);
                        } else {
                            selectedSet.clear();
                            selectedSet.add(clickedName);
                            const filteredNow = getFilteredFiles();
                            lastClickedIndex = filteredNow.indexOf(clickedName);
                        }
                        const items = fileContainer.querySelectorAll("[data-name]");
                        items.forEach((item) => {
                            const nm = item.dataset.name;
                            const sel = selectedSet.has(nm);
                            item.style.borderColor = sel ? selColor : "transparent";
                            item.style.background = sel ? "rgba(255,255,255,0.1)" : "transparent";
                        });
                        updateSelectedCount();
                    } else {
                        selectedSet.clear();
                        lastClickedIndex = -1;
                        const items = fileContainer.querySelectorAll("[data-name]");
                        items.forEach((item) => {
                            item.style.borderColor = "transparent";
                            item.style.background = "transparent";
                        });
                        updateSelectedCount();
                    }
                };

                const onCtxMenu = (e) => e.preventDefault();

                document.addEventListener("mousemove", onMouseMove);
                document.addEventListener("mouseup", onMouseUp);
                document.addEventListener("contextmenu", onCtxMenu, true);
            });

            dialog.querySelector(".search-input").addEventListener("input", (ev) => {
                searchText = ev.target.value;
                renderThumbs();
            });

            dialog.querySelector(".select-all-btn").onclick = () => {
                const filtered = getFilteredFiles();
                filtered.forEach(f => selectedSet.add(f));
                renderThumbs();
                updateSelectedCount();
            };

            dialog.querySelector(".clear-select-btn").onclick = () => {
                selectedSet.clear();
                renderThumbs();
                updateSelectedCount();
            };

            dialog.querySelector(".del-selected-btn").onclick = () => {
                if (selectedSet.size === 0) return;
                const count = selectedSet.size;
                xzgConfirm(xzgT(`确认删除选中的 ${count} 张图片？`, `Confirm delete ${count} selected images?`), async () => {
                    try {
                        const res = await api.fetchApi("/xzg_delete_images", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ files: Array.from(selectedSet), source: currentSource }),
                        });
                        let data;
                        try {
                            data = await res.json();
                        } catch {
                            const text = await res.text();
                            throw new Error(text || ("HTTP " + res.status));
                        }
                        if (data.deleted && data.deleted.length > 0) {
                            await fetchFiles();
                            data.deleted.forEach(n => selectedSet.delete(n));
                            const all = parseNameList(getImageListWidget(node)?.value);
                            const deletedSet = new Set(data.deleted.map(n => n + prefix));
                            const remaining = all.filter(f => !deletedSet.has(f));
                            if (remaining.length !== all.length) {
                                setNameList(node, remaining);
                            }
                            renderThumbs();
                            updateSelectedCount();
                        }
                        if (data.errors && data.errors.length > 0) {
                            xzgAlert(xzgT("删除失败", "Delete failed") + ": " + data.errors.join("\n"));
                        }
                    } catch (err) {
                        xzgAlert(xzgT("删除失败", "Delete failed") + ": " + err.message);
                    }
                });
            };

            const addSelectedImages = async () => {
                const selected = Array.from(selectedSet);
                if (selected.length === 0) return;

                let namesToAdd = selected.map(n => n + prefix);
                if (copyToInput) {
                    try {
                        const res = await api.fetchApi("/xzg_copy_output_to_input", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ files: selected }),
                        });
                        const data = await res.json();
                        if (data.copied && data.copied.length > 0) {
                            namesToAdd = data.copied.map(c => c.input_name);
                        }
                        if (data.errors && data.errors.length > 0) {
                            xzgAlert(xzgT("部分图片复制失败", "Some images failed to copy") + ":\n" + data.errors.join("\n"));
                        }
                    } catch (err) {
                        xzgAlert(xzgT("复制图片失败", "Copy images failed") + ": " + err.message);
                        return false;
                    }
                }

                let finalList;
                if (uploadMode === "replace") {
                    finalList = namesToAdd;
                } else {
                    const all = parseNameList(getImageListWidget(node)?.value);
                    const existing = new Set(all);
                    const newOnes = namesToAdd.filter(n => !existing.has(n));
                    finalList = newOnes.concat(all);
                }
                setNameList(node, finalList);
                setIndex(node, 0);
                return true;
            };

            dialog.querySelector(".cancel-btn").onclick = () => {
                overlay.remove();
            };

            dialog.querySelector(".ok-btn").onclick = async () => {
                const ok = await addSelectedImages();
                if (ok !== false) overlay.remove();
            };

            renderThumbs();
        })
        .catch(err => {
            console.error("Failed to load files:", apiUrl, err);
            let msg = xzgT("加载文件列表失败", "Failed to load file list");
            if (err && err.message) msg += "\n" + err.message;
            if (err && err.status) msg += "\nHTTP " + err.status;
            xzgAlert(msg);
        });
    };

    folderBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        showFolderDialog("/xzg_input_files", "input", "", false, getSelColor());
    });

    outputBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        showFolderDialog("/xzg_output_files", "output", " [output]", true, getSelColor());
    });

    deleteBtn.onclick = (e) => {
        e.stopPropagation();
        const names = parseNameList(getImageListWidget(node)?.value);
        if (names.length === 0) return;
        const toDelete = new Set(selectedIndexes.length > 0 ? selectedIndexes : [getIndex(node)]);
        const next = names.filter((_, i) => !toDelete.has(i));
        setNameList(node, next);
        selectedIndexes = [];
        lastClickedIndex = -1;
        const curIdx = getIndex(node);
        if (curIdx >= next.length) {
            setIndex(node, Math.max(0, next.length - 1));
        }
    };

    clearBtn.onclick = (e) => {
        e.stopPropagation();
        const names = parseNameList(getImageListWidget(node)?.value);
        if (names.length === 0) return;
        setNameList(node, []);
        setIndex(node, 0);
    };

    // 画布缩放时同步调整图片名称字体大小（随画布缩小而缩小）
    // ComfyUI DOM widget 通过 CSS transform 缩放整个容器，字体也会随之缩放
    // 但当画布缩小时字体可能过小看不清，这里在画布放大时适当增大字体
    let _lastScale = -1;
    const updateLabelScale = () => {
        const scale = app?.canvas?.ds?.scale ?? 1;
        if (Math.abs(scale - _lastScale) < 0.01) return;
        _lastScale = scale;
        // 画布放大时字体也放大（补偿 CSS transform 的缩放），画布缩小时字体自然缩小
        const fontSize = Math.max(4, Math.round(4 * Math.min(scale, 1.5)));
        const labels = container.querySelectorAll(".xzg-img-label");
        labels.forEach(el => { el.style.fontSize = fontSize + "px"; });
    };

    redraw(true);
    updateModeBtn();

    // 拖放支持：阻止浏览器默认行为，处理图片拖入
    const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tiff', 'tif', 'svg', 'avif'];
    container.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
    }, { capture: true });

    // ── 粘贴上传：Ctrl+V 粘贴剪贴板图片到当前加载器 ──
    const _handlePasteUpload = async (e) => {
        // 输入框中粘贴文本：不拦截，默认粘贴
        const ae = document.activeElement;
        if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return;

        const cd = e.clipboardData || e.originalEvent?.clipboardData;
        if (!cd) return;

        // 1) 优先：图片文件（例如从文件管理器/截图软件复制的图片）
        const files = [];
        if (cd.files && cd.files.length) {
            for (let i = 0; i < cd.files.length; i++) {
                const f = cd.files[i];
                if (f?.type && String(f.type).startsWith("image/")) files.push(f);
            }
        }
        // 2) 兜底：clipboardData.items 中的 image item（从浏览器网页复制的图片）
        if (files.length === 0 && cd.items && cd.items.length) {
            for (const it of cd.items) {
                if (it.kind === "file" && it.type && it.type.startsWith("image/")) {
                    const f = it.getAsFile();
                    if (f) files.push(f);
                }
            }
        }

        if (files.length > 0) {
            e.preventDefault();
            e.stopPropagation();
            // 复制粘贴的图片通常没有名字，生成一个基于时间戳的 PNG 文件名
            const named = files.map((f, i) => {
                let name = f.name || "";
                if (!name || /^(blob|image|clipboard|非图片)$/i.test(name) || !name.includes('.')) {
                    const ts = new Date();
                    const stamp = `${ts.getFullYear()}${String(ts.getMonth()+1).padStart(2,'0')}${String(ts.getDate()).padStart(2,'0')}-${String(ts.getHours()).padStart(2,'0')}${String(ts.getMinutes()).padStart(2,'0')}${String(ts.getSeconds()).padStart(2,'0')}`;
                    const ext = f.type && f.type.includes('/') ? f.type.split('/')[1].split(';')[0].toLowerCase() : 'png';
                    const validExt = IMAGE_EXTS.includes(ext) ? ext : 'png';
                    const suffix = files.length > 1 ? `-${i+1}` : '';
                    name = `clipboard-${stamp}${suffix}.${validExt}`;
                    try {
                        return new File([f], name, { type: f.type || 'image/png' });
                    } catch (_) {
                        Object.defineProperty(f, 'name', { value: name, writable: true });
                        return f;
                    }
                }
                return f;
            });
            const uploaded = await uploadFilesSequential(named);
            if (uploaded.length === 0) return;
            if (uploadMode === "replace") {
                setNameList(node, uploaded);
                setIndex(node, 0);
            } else {
                const all = parseNameList(getImageListWidget(node)?.value);
                const existing = new Set(all);
                const newOnes = uploaded.filter(n => !existing.has(n));
                const merged = newOnes.concat(all);
                setNameList(node, merged);
                setIndex(node, 0);
            }
            redraw(true);
            return;
        }

        // 3) 文本粘贴：复制了文件名（从 ComfyUI 预览面板复制的文件名）
        const textData = cd.getData?.('text/plain') || "";
        if (textData) {
            const lines = String(textData).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
            const names = [];
            for (const rawLine of lines) {
                let rawName = rawLine;
                for (const s of [' [output]', ' [input]', ' [temp]']) {
                    if (rawName.endsWith(s)) {
                        rawName = rawName.slice(0, -s.length);
                        break;
                    }
                }
                const ext = rawName.split('.').pop()?.toLowerCase();
                if (IMAGE_EXTS.includes(ext)) {
                    names.push(rawLine);
                }
            }
            if (names.length > 0) {
                e.preventDefault();
                e.stopPropagation();
                if (uploadMode === "replace") {
                    setNameList(node, names);
                    setIndex(node, 0);
                } else {
                    const all = parseNameList(getImageListWidget(node)?.value);
                    const existing = new Set(all);
                    const newOnes = names.filter(n => !existing.has(n));
                    const merged = newOnes.concat(all);
                    setNameList(node, merged);
                    setIndex(node, 0);
                }
                redraw(true);
            }
        }
    };

    // 只在 container 上捕获，因为 container 覆盖了节点的全部 UI 区域
    container.addEventListener('paste', (e) => {
        _handlePasteUpload(e);
    }, { capture: true });

    // 兜底：用户 Ctrl+V 时，焦点不一定在 container 内（例如侧边栏输入框外）
    // 使用 pointerenter/pointerleave 跟踪鼠标是否在当前节点内，仅在内部时响应
    let _mouseInside = false;
    container.addEventListener('pointerenter', () => { _mouseInside = true; });
    container.addEventListener('pointerleave', () => { _mouseInside = false; });
    const _windowPasteHandler = (e) => {
        if (!_mouseInside) return;
        // 如果 container 已经处理过（e.defaultPrevented），直接跳过
        if (e.defaultPrevented) return;
        _handlePasteUpload(e);
    };
    window.addEventListener('paste', _windowPasteHandler, true);
    // 节点销毁时移除 window 监听，防止泄漏
    const origOnRemoved = node.onRemoved;
    node.onRemoved = function () {
        window.removeEventListener('paste', _windowPasteHandler, true);
        if (origOnRemoved) return origOnRemoved.apply(this, arguments);
    };

    container.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();

        // 1. 操作系统文件拖入 → 上传 + 添加到列表
        const files = Array.from(e.dataTransfer?.files || []).filter(f => {
            if (!f) return false;
            const ext = f.name.split('.').pop()?.toLowerCase();
            return IMAGE_EXTS.includes(ext);
        });
        if (files.length > 0) {
            uploadFilesSequential(files).then(uploaded => {
                if (uploaded.length === 0) return;
                if (uploadMode === "replace") {
                    setNameList(node, uploaded);
                    setIndex(node, 0);
                } else {
                    const all = parseNameList(getImageListWidget(node)?.value);
                    const existing = new Set(all);
                    const newOnes = uploaded.filter(n => !existing.has(n));
                    const merged = newOnes.concat(all);
                    setNameList(node, merged);
                    setIndex(node, 0);
                }
                redraw(true);
            });
            return;
        }

        // 2. ComfyUI 内部拖入（从预览面板/文件列表拖出图片文件名）
        const textData = e.dataTransfer?.getData('text/plain');
        if (textData) {
            let rawName = textData;
            for (const s of [' [output]', ' [input]', ' [temp]']) {
                if (rawName.endsWith(s)) {
                    rawName = rawName.slice(0, -s.length);
                    break;
                }
            }
            const ext = rawName.split('.').pop()?.toLowerCase();
            if (IMAGE_EXTS.includes(ext)) {
                const annotatedName = textData;
                if (uploadMode === "replace") {
                    setNameList(node, [annotatedName]);
                    setIndex(node, 0);
                } else {
                    const all = parseNameList(getImageListWidget(node)?.value);
                    if (!all.includes(annotatedName)) {
                        setNameList(node, [annotatedName].concat(all));
                        setIndex(node, 0);
                    }
                }
                redraw(true);
            }
        }
    }, { capture: true });

    return {
        container,
        grid,
        redraw,
        updateModeBtn,
        updateUploadModeBtn,
        resizeObserver,
        _updateLabelScale: updateLabelScale,
        _updateBypassState: updateBypassState,
        _onWheel: onWheel,
        syncUploadModeFromWidget: _syncUploadModeFromWidget,
        clearMask: () => {
            if (maskOffscreen.width > 0 && maskOffscreen.height > 0) {
                maskOffCtx.clearRect(0, 0, maskOffscreen.width, maskOffscreen.height);
            }
            _maskBoundImageName = null;
            _resetImgZoom();
            _renderMaskOverlay();
        },
        clearCrop: () => {
            cropRect = null;
            _cropPending = null;
            _cropResizeCorner = null; _cropResizeBase = null; _cropResizeAnchorPos = null;
            _cropDrawing = false;
            _cropSelStart = _cropSelCur = null;
            // 同步清空持久化到 widget 的 crop_data，避免后端点裁上一张图的裁剪信息
            _commitCropToWidget();
            _resetImgZoom();
            _refreshCropPreview();
            _renderMaskOverlay();
            _updateSingleResLabel();
        },
        get isSingleMode() { return uploadMode === "replace"; },
    };
}

app.registerExtension({
    name: "xiaozhuguang.image_loader",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "XiaozhuguangImageLoader") {
            // ═══════════════════════════════════════════════════════
            //  在此处强制纠正 nodeData.outputs，确保：
            //   第 0 个输出 = IMAGE 类型，name = "图像"
            //   第 1 个输出 = MASK  类型，name = "遮罩"
            //  用 [对象数组] 形式指定 type+name 双保险，而非仅字符串数组
            // ═══════════════════════════════════════════════════════
            if (!Array.isArray(nodeData.output))       nodeData.output = [];
            if (!Array.isArray(nodeData.output_name))  nodeData.output_name = [];
            if (!Array.isArray(nodeData.output_is_list)) nodeData.output_is_list = [];
            // 端口 0: IMAGE
            nodeData.output[0]       = "IMAGE";
            nodeData.output_name[0]  = xzgT("图像", "images");
            nodeData.output_is_list[0] = true;
            // 端口 1: MASK —— 如果之前是 count/COUNT/数字/图片数量，彻底清掉类型
            nodeData.output[1]       = "MASK";
            nodeData.output_name[1]  = xzgT("遮罩", "mask");
            nodeData.output_is_list[1] = false;
            // 兼容：有些旧版 ComfyUI 用 nodeData.output 是对象数组 {type,name, …}
            if (!Array.isArray(nodeData.outputs)) nodeData.outputs = [];
            nodeData.outputs[0] = Object.assign({}, nodeData.outputs[0] || {}, { type: "IMAGE", name: xzgT("图像", "images"), label: xzgT("图像", "images") });
            nodeData.outputs[1] = Object.assign({}, nodeData.outputs[1] || {}, { type: "MASK",  name: xzgT("遮罩", "mask"), label: xzgT("遮罩", "mask") });
            // 再彻底清空旧缓存残留
            if (Array.isArray(nodeData.output_link_labels)) nodeData.output_link_labels = null;
            if (nodeData.return_names)  nodeData.return_names  = [xzgT("图像", "images"), xzgT("遮罩", "mask")];
            if (nodeData.return_types)  nodeData.return_types  = ["IMAGE", "MASK"];
            if (nodeData.output_is_array) nodeData.output_is_array = [true, false];

            const origOnNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                // 运行时二次保险：修正节点实例的 outputs 数组元信息
                _forceCorrectOutputs(this);
                const r = origOnNodeCreated?.apply(this, arguments);

                const listWidget = getImageListWidget(this);
                if (listWidget) {
                    listWidget.type = "hidden";
                    listWidget.hidden = true;
                    listWidget.computeSize = () => [0, 0];
                }
                const sizeWidget = getCardSizeWidget(this);
                if (sizeWidget) {
                    sizeWidget.type = "hidden";
                    sizeWidget.hidden = true;
                    sizeWidget.computeSize = () => [0, 0];
                }
                const indexWidget = getIndexWidget(this);
                if (indexWidget) {
                    indexWidget.type = "hidden";
                    indexWidget.hidden = true;
                    indexWidget.computeSize = () => [0, 0];
                }
                const batchWidget = getBatchModeWidget(this);
                if (batchWidget) {
                    batchWidget.type = "hidden";
                    batchWidget.hidden = true;
                    batchWidget.computeSize = () => [0, 0];
                }
                let maskWidget = getMaskDataWidget(this);
                // 如果 hidden widget 没有被 ComfyUI 自动创建，手动创建它
                if (!maskWidget) {
                    const w = this.addWidget("string", "mask_data", "", null, { serialize: true });
                    if (w) {
                        maskWidget = w;
                    } else {
                        maskWidget = {
                            name: "mask_data",
                            type: "hidden",
                            value: "",
                            options: { serialize: true },
                            hidden: true,
                            computeSize: () => [0, 0],
                            callback: null,
                        };
                        this.widgets.push(maskWidget);
                    }
                }
                if (maskWidget) {
                    maskWidget.type = "hidden";
                    maskWidget.hidden = true;
                    maskWidget.computeSize = () => [0, 0];
                    maskWidget.options = maskWidget.options || {};
                    maskWidget.options.serialize = true;
                }
                let umWidget = getUploadModeWidget(this);
                // 如果 hidden widget 没有被 ComfyUI 自动创建，手动创建它
                if (!umWidget) {
                    const w = this.addWidget("string", "upload_mode", "append", null, { serialize: true });
                    if (w) {
                        umWidget = w;
                    } else {
                        // addWidget 可能返回 undefined，手动 push
                        umWidget = {
                            name: "upload_mode",
                            type: "hidden",
                            value: "append",
                            options: { serialize: true },
                            hidden: true,
                            computeSize: () => [0, 0],
                            callback: null,
                        };
                        this.widgets.push(umWidget);
                    }
                }
                if (umWidget) {
                    umWidget.type = "hidden";
                    umWidget.hidden = true;
                    umWidget.computeSize = () => [0, 0];
                    umWidget.options = umWidget.options || {};
                    umWidget.options.serialize = true;
                    if (!umWidget.value || (umWidget.value !== "append" && umWidget.value !== "replace")) {
                        umWidget.value = "append";
                    }
                }
                // crop_data：同样兜底创建，缺失会导致裁剪选区无法写入/持久化
                if (!getCropDataWidget(this)) {
                    const cw = this.addWidget("string", "crop_data", "", null, { serialize: true });
                    if (!cw) {
                        this.widgets.push({
                            name: "crop_data",
                            type: "hidden",
                            value: "",
                            options: { serialize: true },
                            hidden: true,
                            computeSize: () => [0, 0],
                            callback: null,
                        });
                    } else {
                        cw.type = "hidden";
                        cw.hidden = true;
                        cw.computeSize = () => [0, 0];
                        cw.options = cw.options || {};
                        cw.options.serialize = true;
                    }
                } else {
                    const cw = getCropDataWidget(this);
                    cw.type = "hidden";
                    cw.hidden = true;
                    cw.computeSize = () => [0, 0];
                    cw.options = cw.options || {};
                    cw.options.serialize = true;
                }

                const ui = createImgBatchUI(this);
                this._xzgImgLoaderUI = ui;

                const MIN_W = 250;
                const MIN_H = 300;

                if (!this.size || this.size[0] < MIN_W || this.size[1] < MIN_H) {
                    this.setSize([Math.max(this.size?.[0] || 0, MIN_W), Math.max(this.size?.[1] || 0, MIN_H)]);
                }
                this.minWidth = Math.max(this.minWidth || 0, MIN_W);
                this.minHeight = Math.max(this.minHeight || 0, MIN_H);

                // 强制最小尺寸，防止标签溢出节点边框
                const origSetSize = this.setSize.bind(this);
                this.setSize = function (size) {
                    const w = Math.max(size[0], MIN_W);
                    const h = Math.max(size[1], MIN_H);
                    origSetSize([w, h]);
                };

                // hideOnZoom:false —— 画布缩小到细节阈值以下时仍显示图片预览，避免被灰色占位矩形替代（与内置图像/视频预览组件一致）
                this.addDOMWidget("xzg_img_loader", "customwidget", ui.container, { hideOnZoom: false });

                // 容器 margin 区域落在 dom-widget 包裹器内，包裹器无滚轮转发，
                // 导致上传按钮上方约 4-10px 区域滚轮失效。给父元素也绑定滚轮转发。
                requestAnimationFrame(() => {
                    const parent = ui.container.parentElement;
                    if (parent && ui._onWheel) {
                        parent.addEventListener("wheel", ui._onWheel, { passive: false });
                    }
                });

                const wIndex = getIndexWidget(this);
                const wList = getImageListWidget(this);
                const wSize = getCardSizeWidget(this);
                const wMask = getMaskDataWidget(this);
                const _nodeSelf = this;

                // 当 index/imageList 变化导致"当前图片名"改变时 → 清空遮罩，避免旧遮罩粘到新图上
                // forceClear=true 时（列表变化）无论名称是否相同都清空
                const _clearMaskIfImageChanged = (forceClear = false) => {
                    const names = parseNameList(getImageListWidget(_nodeSelf)?.value || "");
                    const idx = getIndex(_nodeSelf);
                    const curImg = names[idx >= 0 && idx < names.length ? idx : 0] || "";
                    const prev = ui._lastMaskImageName || null;
                    if (forceClear || (curImg && prev && prev !== curImg)) {
                        if (wMask) {
                            wMask.value = "";
                            wMask.callback?.("");
                        }
                        ui.clearMask?.();
                    }
                    ui._lastMaskImageName = curImg || null;
                };

                if (wIndex) {
                    const origCallback = wIndex.callback;
                    wIndex._xzg_lastValue = wIndex.value;
                    wIndex.callback = function (value) {
                        origCallback?.call(this, value);
                        if (value === wIndex._xzg_lastValue) return;
                        wIndex._xzg_lastValue = value;
                        _clearMaskIfImageChanged();
                        ui.clearCrop?.();
                        ui.redraw(false);
                    };
                }

                if (wList) {
                    const origCallback = wList.callback;
                    wList._xzg_lastValue = wList.value;
                    wList.callback = function (value) {
                        origCallback?.call(this, value);
                        if (value === wList._xzg_lastValue) return;
                        wList._xzg_lastValue = value;
                        _clearMaskIfImageChanged(true);
                        ui.clearCrop?.();
                        ui.updateModeBtn?.();
                        ui.redraw(true);
                    };
                }

                if (wSize) {
                    const origCallback = wSize.callback;
                    wSize._xzg_lastValue = wSize.value;
                    wSize.callback = function (value) {
                        origCallback?.call(this, value);
                        if (value === wSize._xzg_lastValue) return;
                        wSize._xzg_lastValue = value;
                        ui.redraw(true);
                    };
                }

                const wBatch = getBatchModeWidget(this);
                if (wBatch) {
                    const origCallback = wBatch.callback;
                    wBatch.callback = function (value) {
                        origCallback?.call(this, value);
                        ui.updateModeBtn?.();
                    };
                }

                ui.redraw(true);
                // 初始化"当前图片名"，用于切图时判断是否清空遮罩
                {
                    const names = parseNameList(getImageListWidget(this)?.value || "");
                    const idx = getIndex(this);
                    ui._lastMaskImageName = names[idx >= 0 && idx < names.length ? idx : 0] || null;
                }
                return r;
            };

            // ═══════════════════════════════════════════════════════
            //  第三层/第四层保险：
            //   * _forceCorrectOutputs() 在 onNodeCreated + onConfigure + onAfterGraphConfigured
            //     后均调用，彻底兜住老工作流 data.outputs 里残留的 COUNT/图片数量
            //   * onDrawForeground: 直接在绘制端口文字时"用'图像/遮罩'覆盖绘制"，
            //     这是终极手段，只要走到这里无论任何缓存都会显示正确的中文标签
            // ═══════════════════════════════════════════════════════
            function _forceCorrectOutputs(nodeInst) {
                if (!Array.isArray(nodeInst.outputs)) nodeInst.outputs = [];
                const defaults = [
                    { type: "IMAGE", name: xzgT("图像", "images"), shape: -1, label: xzgT("图像", "images") },
                    { type: "MASK",  name: xzgT("遮罩", "mask"), shape: -1, label: xzgT("遮罩", "mask") },
                ];
                defaults.forEach((def, i) => {
                    let o = nodeInst.outputs[i];
                    if (!o) {
                        o = { name: def.name, type: def.type, links: null, slot_index: i };
                        nodeInst.outputs.push(o);
                    }
                    o.type  = def.type;
                    o.name  = def.name;
                    o.label = def.label;
                    if (o.shape === undefined || o.shape === null) o.shape = def.shape;
                    // 防残留：如果旧数据 name/type 里含有 count/图片数量，整项覆写
                    const rawName = String(o.name || "").toLowerCase();
                    const rawType = String(o.type || "").toLowerCase();
                    if (rawName === "count" || rawName === "图片数量" || rawName === "count" ||
                        rawName.includes("count") || rawType.includes("count")) {
                        const links = o.links;
                        const slot  = o.slot_index;
                        Object.assign(o, {
                            type: def.type, name: def.name, label: def.label,
                            links, slot_index: slot, shape: def.shape
                        });
                    }
                });
            }

            // 终极：绘制端口标签时强行覆盖，把第二行(如果有的话)文字直接盖掉
            // 这样无论 this.outputs[i].name 被谁改成了"图片数量"，画出来的一定是"遮罩"
            const origOnDrawForeground = nodeType.prototype.onDrawForeground;
            nodeType.prototype.onDrawForeground = function (ctx, canvas, graphcanvas) {
                const r = origOnDrawForeground?.apply(this, arguments);
                try {
                    // ComfyUI 的 LGraphCanvas.drawNode 会在节点右侧画 outputs 文本，
                    // 用 name/label；我们不能直接改它的绘制流程，就在 onDrawForeground 后
                    // 再把同样位置的文字重新"画一次正确的"（覆盖在原有文字上方）。
                    if (!graphcanvas?.node_output_font) return;
                    if (!this.outputs || this.outputs.length < 2) return;
                    const NODE_TITLE_HEIGHT = (LiteGraph && LiteGraph.NODE_TITLE_HEIGHT) || 30;
                    const NODE_WIDGET_HEIGHT = (LiteGraph && LiteGraph.NODE_WIDGET_HEIGHT) || 20;
                    const NODE_SLOT_HEIGHT  = (LiteGraph && LiteGraph.NODE_SLOT_HEIGHT)  || 20;
                    const slotsStartY = NODE_TITLE_HEIGHT + NODE_WIDGET_HEIGHT * (this.widgets?.length || 0) + 8;
                    const labels = [xzgT("图像", "images"), xzgT("遮罩", "mask")];
                    ctx.save();
                    ctx.font = graphcanvas.node_output_font || "12px Arial";
                    ctx.textAlign = "right";
                    ctx.textBaseline = "middle";
                    for (let i = 0; i < Math.min(this.outputs.length, labels.length); i++) {
                        // 背景盖掉旧文字：在右侧输出区域画一个不透明的小矩形
                        const y = slotsStartY + i * NODE_SLOT_HEIGHT;
                        const textW = Math.round(this.size[0]) - 28;
                        // 取节点背景色（半透明的节点主体色）
                        ctx.fillStyle = this.color || (graphcanvas.colors?.node_bg || "#2a2a2a");
                        ctx.fillRect(textW - 38, y - 9, this.size[0] - textW + 36, 18);
                        // 画正确文字
                        ctx.fillStyle = this.outputs?.[i]?.type === "MASK"
                            ? (graphcanvas.colors?.MASK_TYPE || "#7f7")
                            : (graphcanvas.colors?.STRING_TYPE || "#ccc");
                        ctx.fillText(labels[i], this.size[0] - 22, y);
                    }
                    ctx.restore();
                } catch (_) {}
                return r;
            };

            // 额外：graph 全部 configure 完成后再跑一遍，防止 async 时序问题
            setTimeout(() => {
                try {
                    if (typeof app?.graph?._nodes === "object") {
                        for (const n of app.graph._nodes) {
                            if (n && n.type === nodeData.name) {
                                _forceCorrectOutputs(n);
                                // 同步 upload_mode 到闭包（如果还没被 onConfigure 同步）
                                try { n._xzgImgLoaderUI?.syncUploadModeFromWidget?.(); } catch (_) {}
                            }
                        }
                    }
                } catch (_) {}
            }, 0);

            const origOnConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function (data) {
                const r = origOnConfigure?.apply(this, arguments);
                // configure 调用会从 data.outputs 恢复，刚好调用完覆盖
                _forceCorrectOutputs(this);
                const listWidget = getImageListWidget(this);
                if (listWidget) {
                    listWidget.type = "hidden";
                    listWidget.hidden = true;
                    listWidget.computeSize = () => [0, 0];
                    if (data?.widgets_values && Array.isArray(data.widgets_values)) {
                        const idx = this.widgets?.findIndex(w => w === listWidget);
                        if (idx >= 0 && data.widgets_values[idx] != null) {
                            listWidget.value = data.widgets_values[idx];
                        }
                    }
                    if (data?.properties?.xzg_image_list != null && !listWidget.value) {
                        listWidget.value = data.properties.xzg_image_list;
                    }
                    listWidget._xzg_lastValue = listWidget.value;
                }
                const sizeWidget = getCardSizeWidget(this);
                if (sizeWidget) {
                    sizeWidget.type = "hidden";
                    sizeWidget.hidden = true;
                    sizeWidget.computeSize = () => [0, 0];
                }
                const indexWidget = getIndexWidget(this);
                if (indexWidget) {
                    indexWidget.type = "hidden";
                    indexWidget.hidden = true;
                    indexWidget.computeSize = () => [0, 0];
                }
                const batchWidget = getBatchModeWidget(this);
                if (batchWidget) {
                    batchWidget.type = "hidden";
                    batchWidget.hidden = true;
                    batchWidget.computeSize = () => [0, 0];
                }
                let maskWidget = getMaskDataWidget(this);
                // 如果 hidden widget 没有被 ComfyUI 自动创建，手动创建它
                if (!maskWidget) {
                    const w = this.addWidget("string", "mask_data", "", null, { serialize: true });
                    if (w) {
                        maskWidget = w;
                    } else {
                        maskWidget = {
                            name: "mask_data",
                            type: "hidden",
                            value: "",
                            options: { serialize: true },
                            hidden: true,
                            computeSize: () => [0, 0],
                            callback: null,
                        };
                        this.widgets.push(maskWidget);
                    }
                }
                if (maskWidget) {
                    maskWidget.type = "hidden";
                    maskWidget.hidden = true;
                    maskWidget.computeSize = () => [0, 0];
                    maskWidget.options = maskWidget.options || {};
                    maskWidget.options.serialize = true;
                    // 从 widgets_values 恢复遮罩数据
                    if (data?.widgets_values && Array.isArray(data.widgets_values)) {
                        const idx = this.widgets?.findIndex(w => w === maskWidget);
                        if (idx >= 0 && data.widgets_values[idx] != null) {
                            maskWidget.value = data.widgets_values[idx];
                        }
                    }
                    // 从 properties 恢复（兜底，防止 widgets_values 被截断）
                    if (data?.properties?.xzg_mask_data != null && !maskWidget.value) {
                        maskWidget.value = data.properties.xzg_mask_data;
                    }
                }
                const cropWidget = getCropDataWidget(this);
                if (cropWidget) {
                    cropWidget.type = "hidden";
                    cropWidget.hidden = true;
                    cropWidget.computeSize = () => [0, 0];
                    cropWidget.options = cropWidget.options || {};
                    cropWidget.options.serialize = true;
                    // 从 widgets_values 恢复裁剪数据
                    if (data?.widgets_values && Array.isArray(data.widgets_values)) {
                        const ci = this.widgets?.findIndex(w => w === cropWidget);
                        if (ci >= 0 && data.widgets_values[ci] != null) {
                            cropWidget.value = data.widgets_values[ci];
                        }
                    }
                    // 从 properties 恢复（兜底，防止 widgets_values 被截断）
                    if (data?.properties?.xzg_crop_data != null && !cropWidget.value) {
                        cropWidget.value = data.properties.xzg_crop_data;
                    }
                }
                const umWidget = getUploadModeWidget(this);
                // 从 data.properties 恢复（最可靠，不受 widget 索引影响）
                const propMode = data?.properties?.xzg_upload_mode;
                const restoredMode = (String(propMode || "").trim().toLowerCase() === "replace") ? "replace" : "append";
                if (umWidget) {
                    umWidget.type = "hidden";
                    umWidget.hidden = true;
                    umWidget.computeSize = () => [0, 0];
                    umWidget.options = umWidget.options || {};
                    umWidget.options.serialize = true;
                    umWidget.value = restoredMode;
                }
                // 放大模式残留恢复：若工作流里存的是裁剪/遮罩放大后的尺寸(1280x720)，
                // 且带原始大小标记，则恢复为原始大小并清理标记，避免刷新后节点无法还原大小
                const _restoreWarpedNodeSize = (saved) => {
                    if (Array.isArray(saved) && saved.length === 2 && this.size) {
                        const w = Number(saved[0]), h = Number(saved[1]);
                        if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 &&
                            Math.round(this.size[0]) === 1280 && Math.round(this.size[1]) === 720) {
                            this.setSize([w, h]);
                        }
                    }
                    if (this.properties) {
                        delete this.properties.xzg_crop_orig_size;
                        delete this.properties.xzg_mask_orig_size;
                    }
                };
                _restoreWarpedNodeSize(data?.properties?.xzg_crop_orig_size);
                _restoreWarpedNodeSize(data?.properties?.xzg_mask_orig_size);
                if (this._xzgImgLoaderUI) {
                    // 先确保 upload_mode widget 值已恢复 → 再同步到闭包变量
                    this._xzgImgLoaderUI.syncUploadModeFromWidget?.();
                    this._xzgImgLoaderUI.redraw(true);
                    this._xzgImgLoaderUI.updateModeBtn?.();
                }
                return r;
            };

            const origOnSerialize = nodeType.prototype.onSerialize;
            nodeType.prototype.onSerialize = function (data) {
                const r = origOnSerialize?.apply(this, arguments);
                if (!data.properties) data.properties = {};
                const listWidget = getImageListWidget(this);
                if (listWidget && listWidget.value) {
                    data.properties.xzg_image_list = listWidget.value;
                }
                // upload_mode
                const umWidget = getUploadModeWidget(this);
                const umValue = String(umWidget?.value || "").trim().toLowerCase();
                const expected = (umValue === "replace") ? "replace" : "append";
                data.properties.xzg_upload_mode = expected;
                if (umWidget && data?.widgets_values && Array.isArray(this.widgets)) {
                    const idx = this.widgets.indexOf(umWidget);
                    if (idx >= 0) {
                        data.widgets_values[idx] = expected;
                    }
                }
                // mask_data：显式保存到 properties，确保大数据不被截断
                const maskWidget = getMaskDataWidget(this);
                if (maskWidget && maskWidget.value) {
                    data.properties.xzg_mask_data = maskWidget.value;
                }
                // crop_data：同样显式保存到 properties
                const cropWidget = getCropDataWidget(this);
                if (cropWidget && cropWidget.value) {
                    data.properties.xzg_crop_data = cropWidget.value;
                }
                // 放大模式残留标记：持久化原始节点大小，刷新后可恢复
                if (this.properties?.xzg_crop_orig_size) {
                    data.properties.xzg_crop_orig_size = this.properties.xzg_crop_orig_size;
                }
                if (this.properties?.xzg_mask_orig_size) {
                    data.properties.xzg_mask_orig_size = this.properties.xzg_mask_orig_size;
                }
                return r;
            };

            const origOnRemoved = nodeType.prototype.onRemoved;
            nodeType.prototype.onRemoved = function () {
                if (this._xzgImgLoaderUI?.resizeObserver) {
                    this._xzgImgLoaderUI.resizeObserver.disconnect();
                    this._xzgImgLoaderUI.resizeObserver = null;
                }
                return origOnRemoved?.apply(this, arguments);
            };

            // 画布缩放时同步更新图片名称字体大小，以及 bypass 状态更新
            const origOnDrawBackground = nodeType.prototype.onDrawBackground;
            nodeType.prototype.onDrawBackground = function (ctx) {
                if (this._xzgImgLoaderUI?._updateLabelScale) {
                    this._xzgImgLoaderUI._updateLabelScale();
                }
                // 更新 bypass 覆盖层状态
                if (this._xzgImgLoaderUI?._updateBypassState) {
                    this._xzgImgLoaderUI._updateBypassState();
                }
                return origOnDrawBackground?.apply(this, arguments);
            };

            // 节点大小改变时重新计算缩略图（与 ResizeObserver 协调）
            // 拖拽停止后自动收缩节点，消除多余留白（防抖：每次 onResize 重置定时器）
            const origOnResize = nodeType.prototype.onResize;
            nodeType.prototype.onResize = function (size) {
                const r = origOnResize?.apply(this, arguments);
                if (this._xzgAutoFitting) return r;
                const self = this;
                if (self._xzgResizeTimer) clearTimeout(self._xzgResizeTimer);
                self._xzgResizeTimer = setTimeout(() => {
                    self._xzgResizeTimer = null;
                    const ui = self._xzgImgLoaderUI;
                    if (!ui?.grid) return;
                    // 多图模式下不自适应调整节点大小
                    if (!ui.isSingleMode) return;
                    const names = parseNameList(getImageListWidget(self)?.value || "");
                    if (!names.length) return;
                    const cardSize = getCardSize(self);
                    const colsMatch = ui.grid.style.gridTemplateColumns?.match(/repeat\((\d+)/);
                    const cols = colsMatch ? parseInt(colsMatch[1], 10) : 1;
                    const rows = Math.ceil(names.length / cols);
                    const gap = 2;
                    const gridPad = 12; // grid padding 6px * 2
                    const idealW = cols * cardSize + (cols - 1) * gap + gridPad;
                    const idealH = rows * cardSize + (rows - 1) * gap + gridPad;
                    const excessW = ui.grid.clientWidth - idealW;
                    const excessH = ui.grid.clientHeight - idealH;
                    // 只缩小不放大，且差值 >= 2px 才调整
                    if (Math.max(0, excessW) < 2 && Math.max(0, excessH) < 2) return;
                    const MIN_W = 250, MIN_H = 300;
                    const newW = Math.max(MIN_W, Math.round(self.size[0] - Math.max(0, excessW)));
                    const newH = Math.max(MIN_H, Math.round(self.size[1] - Math.max(0, excessH)));
                    if (newW !== self.size[0] || newH !== self.size[1]) {
                        self._xzgAutoFitting = true;
                        self.setSize([newW, newH]);
                        self._xzgAutoFitting = false;
                    }
                }, 300);
                return r;
            };
        }
    },
});

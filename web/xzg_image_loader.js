import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { xzgT, xzgTh } from "./xzg_i18n.js";

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
        "width:100%;min-width:0;min-height:200px;box-sizing:border-box;overflow:hidden;padding:6px;background:var(--comfy-menu-bg);border:1px solid var(--border-color);border-radius:4px;margin:4px 0;display:flex;flex-direction:row;gap:6px;z-index:10;position:relative;";
    container.style.userSelect = "none";
    container.style.webkitUserSelect = "none";

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
    let _altDragActive = false;            // Alt+左右拖动调整笔刷大小
    let _altDragStartX = 0;                // Alt+拖动起始 X 坐标
    let _altDragStartBrush = 0;            // Alt+拖动起始笔刷大小
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
        const imgName = getImgNameFromEvent(e);
        if (imgName) {
            showContextMenu(e.clientX, e.clientY, imgName);
        }
    });

    const sidebar = document.createElement("div");
    sidebar.style.cssText = "display:flex;flex-direction:column;gap:2px;min-width:52px;width:52px;pointer-events:auto;";

    const mkBtn = (label, title) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.title = title || label;
        b.style.cssText =
            "padding:4px 2px;background:var(--comfy-input-bg);color:var(--input-text);border:1px solid var(--border-color);border-radius:4px;cursor:pointer;font-size:11px;line-height:1.4;width:100%;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-sizing:border-box;";
        b.addEventListener("mouseenter", () => {
            b.style.filter = "brightness(1.2)";
        });
        b.addEventListener("mouseleave", () => {
            b.style.filter = "";
        });
        return b;
    };

    const uploadBtn = mkBtn(xzgT("上传", "Upload"), xzgT("上传图片（可多选）", "Upload images (multi-select)"));
    const folderBtn = mkBtn(xzgT(".input", ".input"), xzgT("从input文件夹选择", "Select from input folder"));
    const outputBtn = mkBtn(xzgT(".output", ".output"), xzgT("从output文件夹选择", "Select from output folder"));
    const deleteBtn = mkBtn(xzgT("删除", "Delete"), xzgT("删除选中", "Delete selected"));
    const clearBtn = mkBtn(xzgT("清空", "Clear"), xzgT("清空全部", "Clear all"));

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
        "padding:4px 2px;background:var(--comfy-input-bg);color:var(--input-text);border:1px solid var(--border-color);border-radius:4px;cursor:pointer;font-size:11px;line-height:1.4;width:100%;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-sizing:border-box;";
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
        uploadModeBtn.style.border = "1px solid var(--border-color)";
        uploadModeBtn.style.background = "transparent";
        uploadModeBtn.style.color = "#FF6B6B";
    };
    updateUploadModeBtn();

    const modeBtn = document.createElement("button");
    modeBtn.style.cssText =
        "padding:4px 2px;background:var(--comfy-input-bg);color:var(--input-text);border:1px solid var(--border-color);border-radius:4px;cursor:pointer;font-size:11px;line-height:1.4;width:100%;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-sizing:border-box;";
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
            modeBtn.style.borderColor = "#666";
            modeBtn.style.borderWidth = "1px";
            modeBtn.style.borderStyle = "solid";
            modeBtn.style.cursor = "default";
            modeBtn.style.opacity = "0.4";
        } else {
            modeBtn.title = isBatch ? xzgT("切换为列表模式", "Switch to List Mode") : xzgT("切换为批次模式", "Switch to Batch Mode");
            modeBtn.style.borderColor = isBatch ? "#66CC66" : "#6699FF";
            modeBtn.style.borderWidth = "1px";
            modeBtn.style.borderStyle = "solid";
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
    const _mkMaskBtn = (label, title) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.title = title || label;
        b.style.cssText =
            "padding:4px 2px;background:var(--comfy-input-bg);color:var(--input-text);border:1px solid var(--border-color);border-radius:4px;cursor:pointer;font-size:11px;line-height:1.4;width:100%;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-sizing:border-box;";
        b.addEventListener("mouseenter", () => { b.style.filter = "brightness(1.2)"; });
        b.addEventListener("mouseleave", () => { b.style.filter = ""; });
        return b;
    };
    const maskToggleBtn = _mkMaskBtn(xzgT("遮罩:关", "Mask:Off"), xzgT("开启/关闭遮罩绘制模式（仅单图模式）", "Toggle mask drawing (single mode only)"));
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
    actionGroup.appendChild(maskToolbar);

    // 统一的显示状态同步（只在这个函数里改 overlay/eventLayer 的 pointer-events/display，避免多改冲突）
    const _syncMaskLayerVisibility = () => {
        const isSingle = uploadMode === "replace";
        // 遮罩覆盖层始终显示（单图模式下），不受 maskEnabled 影响
        singleMaskOverlay.style.display = isSingle ? "block" : "none";
        singleMaskOverlay.style.pointerEvents = "none";
        // 事件层和笔刷预览仅在绘制模式开启时显示
        const shouldEdit = isSingle && maskEnabled;
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
        maskToggleBtn.textContent = maskEnabled ? xzgT("退出遮罩", "Exit Mask") : xzgT("遮罩:关", "Mask:Off");
        maskToggleBtn.style.color = maskEnabled ? "#FF6B6B" : "var(--input-text)";
        maskToggleBtn.style.borderColor = maskEnabled ? "#FF6B6B" : "var(--border-color)";
        maskBrushBtn.style.color = maskTool === "brush" ? "#66CC66" : "var(--input-text)";
        maskBrushBtn.style.borderColor = maskTool === "brush" ? "#66CC66" : "var(--border-color)";
        maskEraserBtn.style.color = maskTool === "eraser" ? "#FF6B6B" : "var(--input-text)";
        maskEraserBtn.style.borderColor = maskTool === "eraser" ? "#FF6B6B" : "var(--border-color)";
        // 遮罩关闭时折叠调整按钮，开启时展开
        const vis = maskEnabled ? "" : "none";
        brushSizeRow.style.display = vis;
        maskBrushBtn.style.display = vis;
        maskEraserBtn.style.display = vis;
        maskClearBtn.style.display = vis;
        maskInvertBtn.style.display = vis;
        // 遮罩开启时隐藏上传/.input/.output/删除/清空按钮及左下角单图/列表批次按钮，避免误操作
        const actionBtns = [uploadBtn, folderBtn, outputBtn, deleteBtn, clearBtn, uploadModeBtn, modeBtn];
        actionBtns.forEach(btn => { btn.style.display = maskEnabled ? "none" : ""; });
        _syncMaskLayerVisibility();
    };

    maskToggleBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (uploadMode !== "replace") {
            xzgAlert(xzgT("遮罩绘制仅在单图模式下可用", "Mask drawing is only available in single image mode"));
            return;
        }
        maskEnabled = !maskEnabled;
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
        "display:grid;gap:2px;flex:1;min-width:0;min-height:0;overflow:hidden;background:transparent;padding:6px;border-radius:2px;align-content:center;justify-content:center;transition:opacity 0.3s ease;";
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
        "flex:1;display:flex;align-items:center;justify-content:center;background:transparent;border-radius:4px;color:var(--input-text);font-size:8px;opacity:0.55;min-height:40px;";
    emptyTip.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:5px;width:100%;max-width:280px;font-size:8px;color:var(--input-text);line-height:1.35;">
            <div style="text-align:center;font-size:9px;font-weight:bold;margin-bottom:1px;opacity:0.85;">${xzgTh("小珠光图像加载器", "Xiaozhuguang Image Loader")}</div>

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
    singleImgContainer.style.cssText = "flex:1;display:none;align-items:stretch;justify-content:center;min-width:0;min-height:100px;overflow:hidden;position:relative;width:100%;";
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

    // 将容器坐标转换为 inner 坐标（基于当前 transform: translate(tx,ty) scale(zoom)）
    function _containerPtToInner(px, py) {
        const zoom = _maskImgZoom || 1;
        return { x: (px - _maskTx) / zoom, y: (py - _maskTy) / zoom };
    }

    // 增量缩放：在当前 transform 基础上叠加，保持鼠标下方图像点不动
    // 使用逐步计算方式：先算鼠标下图像点在 inner 坐标中的位置，再反推新 transform
    function _applyImgZoom(mx, my, delta) {
        const oldZoom = _maskImgZoom;
        const newZoom = Math.max(1, Math.min(8, oldZoom * delta));
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
        if (maskOffscreen.width <= 0 || maskOffscreen.height <= 0) return;
        const rect = _getImageDisplayRect();
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
        octx.drawImage(tmp, rect.x, rect.y, rect.w, rect.h);
        // 再画一圈细边框，标识图像显示区域
        octx.strokeStyle = "rgba(255,215,0,0.35)";
        octx.lineWidth = 1;
        octx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
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
        // 显示层的笔刷大小要映射到离屏坐标：显示 scale → 离屏 scale 是 1/rect.scale
        const rect = _getImageDisplayRect();
        const offBrushR = Math.max(0.5, radius / (rect.scale || 1));

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
    singleImgContainer.addEventListener("contextmenu", _softKill, true);
    singleImgContainer.addEventListener("dragstart", _softKill, true);
    singleImgContainer.addEventListener("selectstart", _softKill, true);
    singleImgEl.addEventListener("dragstart", (e) => { try { e.preventDefault(); } catch (_) {} }, true);

    function _onMaskPointerDown(e) {
        if (!maskEnabled) return;
        // 左键(0)画笔涂抹遮罩；右键(2)临时擦除遮罩；其它按键忽略
        if (e.button !== 0 && e.button !== 2) return;
        _updateMaskCursor();
        // 判断是否点在遮罩事件层或 img 自身的矩形内（点击 sidebar 不触发）
        const path = e.composedPath ? e.composedPath() : [e.target];
        const hit = path.includes(singleMaskEventLayer) || path.includes(singleMaskOverlay) ||
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
        if (!maskEnabled || _maskDrawing) return;
        const rect = singleImgContainer.getBoundingClientRect();
        const zoomX = singleImgContainer.clientWidth > 0 ? rect.width / singleImgContainer.clientWidth : 1;
        const zoomY = singleImgContainer.clientHeight > 0 ? rect.height / singleImgContainer.clientHeight : 1;
        const px = (e.clientX - rect.left) / zoomX;
        const py = (e.clientY - rect.top) / zoomY;
        const innerPt = _containerPtToInner(px, py);
        // Alt+左右拖动调整笔刷大小
        if (e.altKey) {
            if (!_altDragActive) {
                _altDragActive = true;
                _altDragStartX = px;
                _altDragStartBrush = brushSize;
                singleImgContainer.style.cursor = "ew-resize";
            }
            const dx = px - _altDragStartX;
            const newSize = Math.max(1, Math.min(200, Math.round(_altDragStartBrush + dx)));
            if (newSize !== brushSize) {
                brushSize = newSize;
                brushSizeInput.value = String(brushSize);
                brushSizeLabel.textContent = `${xzgT("笔刷", "Brush")}:${brushSize}`;
                _renderBrushPreview();
            }
            _maskHoverPt = { x: innerPt.x, y: innerPt.y };
            return;
        }
        // Alt 松开，退出拖动模式
        if (_altDragActive) {
            _altDragActive = false;
            singleImgContainer.style.cursor = "crosshair";
        }
        // 跟踪鼠标位置用于笔刷预览圆圈
        _maskHoverPt = { x: innerPt.x, y: innerPt.y };
        _renderBrushPreview();
    }, true);
    // 鼠标离开时清除预览和 Alt 拖动状态
    singleImgContainer.addEventListener("pointerleave", () => {
        _maskHoverPt = null;
        _altDragActive = false;
        _renderBrushPreview();
    }, true);
    // Alt 键松开时退出拖动模式
    window.addEventListener("keyup", (e) => {
        if (e.key === "Alt" && _altDragActive) {
            _altDragActive = false;
            if (singleImgContainer) singleImgContainer.style.cursor = "crosshair";
        }
    }, true);
    singleImgContainer.addEventListener("pointerup", _onMaskPointerUp, true);
    singleImgContainer.addEventListener("pointercancel", _onMaskPointerUp, true);
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
        // 遮罩开启时，画布不再缩放，滚轮缩放图片本身
        if (maskEnabled) {
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

                this.addDOMWidget("xzg_img_loader", "customwidget", ui.container);

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

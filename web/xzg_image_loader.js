import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { xzgT, xzgTh } from "./xzg_i18n.js";
import { cloudLoad, cloudSave } from "./xzg_cloud_store.js";
import { xzgEnableCanvasPanOnSpace, xzgPickSaveDirectory, xzgWriteBlobToDir } from "./xzg_save_utils.js";
import { showMediaLibrary } from "./xzg_media_library.js";

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

function getBatchAlignWidget(node) {
    return getWidgetByName(node, "batch_align");
}

function getMaxImagesWidget(node) {
    return getWidgetByName(node, "max_images");
}

// 历史工作流的 widgets_values 发生错位时，append/replace 等模式字符串可能落入 INT 控件。
// 统一归一化为 0（无限制），避免前端校验或执行队列仍收到非整数值。
function normalizeMaxImagesWidget(widget) {
    if (!widget) return 0;
    const raw = widget.value;
    const parsed = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
    const value = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
    widget.value = value;
    return value;
}

// 获取默认的加载上限：>0 时最多显示/加载前 N 张，0 表示无限制
function getMaxImagesLimit(node) {
    return normalizeMaxImagesWidget(getMaxImagesWidget(node));
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

function getMaskOutputEnabledWidget(node) {
    return getWidgetByName(node, "mask_output_enabled");
}

function getMaskOutputColorWidget(node) {
    return getWidgetByName(node, "mask_output_color");
}

function ensureHiddenWidget(node, name, type, value) {
    let widget = getWidgetByName(node, name);
    if (!widget) {
        widget = node.addWidget?.(type, name, value, null, { serialize: true });
        if (!widget) {
            widget = { name, type: "hidden", value, options: { serialize: true }, hidden: true, computeSize: () => [0, 0], callback: null };
            node.widgets = node.widgets || [];
            node.widgets.push(widget);
        }
    }
    widget.type = "hidden";
    widget.hidden = true;
    widget.computeSize = () => [0, 0];
    widget.options = widget.options || {};
    widget.options.serialize = true;
    return widget;
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

async function addOriginalImageToMediaLibrary(imageName, crop = null, paddingColor = "#ffffff") {
    let filename = String(imageName || "").replace(/\s+\[(?:output|input|temp)\]$/, "");
    filename = filename.replace(/\\/g, "/").split("/").pop();
    if (!filename) throw new Error(xzgT("无法获取图片文件名", "Unable to determine the image filename"));

    if (Array.isArray(crop) && crop.length === 4 && Number(crop[2]) > 0 && Number(crop[3]) > 0) {
        const cropResponse = await api.fetchApi("/xzg/media-library/add-cropped-loader-image", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filename: imageName, crop, padding_color: paddingColor }),
        });
        const cropText = await cropResponse.text();
        let cropResult = null;
        try { cropResult = JSON.parse(cropText); } catch (_) {}
        if (!cropResponse.ok) throw new Error(cropResult?.error || cropText || `HTTP ${cropResponse.status}`);
        return cropResult?.name || filename;
    }

    const sourceResponse = await fetch(getOriginalImageUrl(imageName), { cache: "no-store" });
    if (!sourceResponse.ok) {
        throw new Error(xzgT(`读取原图失败（HTTP ${sourceResponse.status}）`, `Failed to read original image (HTTP ${sourceResponse.status})`));
    }
    const originalBlob = await sourceResponse.blob();
    if (!originalBlob.size) throw new Error(xzgT("原图内容为空", "Original image is empty"));

    const formData = new FormData();
    formData.append("file", originalBlob, filename);
    const uploadResponse = await api.fetchApi("/xzg/media-library/upload", { method: "POST", body: formData });
    const responseText = await uploadResponse.text();
    let result = null;
    try { result = JSON.parse(responseText); } catch (_) {}
    if (!uploadResponse.ok) {
        throw new Error(result?.error || responseText || `HTTP ${uploadResponse.status}`);
    }
    return result?.name || filename;
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

// 多图批量保存：目录选择器可用时只选一次文件夹，随后逐个写入；
// 不支持目录选择器的浏览器则触发普通批量下载，不逐张弹另存为窗口。
async function xzgSaveImagesBatch(items) {
    let dirHandle = null;
    if (typeof window.showDirectoryPicker === "function") {
        try {
            dirHandle = await xzgPickSaveDirectory("image");
        } catch (e) {
            if (e?.name === "AbortError") return false;
            console.warn("[小珠光] 选择批量保存文件夹失败:", e);
        }
    }

    if (dirHandle) {
        const usedNames = new Set();
        for (const item of items) {
            const response = await fetch(item.url);
            if (!response.ok) continue;
            const blob = await response.blob();
            const rawName = String(item.filename || "image.png").replace(/\\/g, "/").split("/").pop() || "image.png";
            const dot = rawName.lastIndexOf(".");
            const stem = dot > 0 ? rawName.slice(0, dot) : rawName;
            const ext = dot > 0 ? rawName.slice(dot) : "";
            let filename = rawName;
            let suffix = 2;
            while (usedNames.has(filename.toLowerCase())) {
                filename = `${stem} (${suffix++})${ext}`;
            }
            // 同名文件已存在时递增编号，避免批量保存静默覆盖目录中的旧文件。
            while (true) {
                try {
                    await dirHandle.getFileHandle(filename);
                    filename = `${stem} (${suffix++})${ext}`;
                    while (usedNames.has(filename.toLowerCase())) filename = `${stem} (${suffix++})${ext}`;
                } catch (e) {
                    if (e?.name !== "NotFoundError") throw e;
                    break;
                }
            }
            usedNames.add(filename.toLowerCase());
            await xzgWriteBlobToDir(dirHandle, filename, blob);
        }
        return true;
    }

    // 浏览器不支持目录选择时，走默认下载目录；按序触发下载以减少浏览器拦截。
    for (const item of items) {
        try {
            const response = await fetch(item.url);
            if (!response.ok) continue;
            const blobUrl = URL.createObjectURL(await response.blob());
            const anchor = document.createElement("a");
            anchor.href = blobUrl;
            anchor.download = String(item.filename || "image.png").replace(/\\/g, "/").split("/").pop() || "image.png";
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
        } catch (e) {
            console.warn("[小珠光] 批量保存图片失败:", item.filename, e);
        }
    }
    return true;
}

function captureCanvasSelection(canvas) {
    if (!canvas) return null;
    const selected = canvas.selected_nodes;
    const nodes = selected instanceof Map
        ? [...selected.values()]
        : selected instanceof Set
            ? [...selected]
            : Object.values(selected || {});
    return [...new Set(nodes.filter(Boolean))];
}

function restoreCanvasSelection(canvas, previousNodes, loaderNode) {
    if (!canvas || !Array.isArray(previousNodes)) return;
    const graphNodes = canvas.graph?._nodes || [];
    const validPrevious = previousNodes.filter((item) => graphNodes.includes(item));
    const desiredNodes = [...new Set([...validPrevious, ...(graphNodes.includes(loaderNode) ? [loaderNode] : [])])];
    for (const item of graphNodes) item.selected = desiredNodes.includes(item);

    const selected = canvas.selected_nodes;
    if (selected instanceof Map) {
        selected.clear();
        for (const item of desiredNodes) selected.set(item.id, item);
    } else if (selected instanceof Set) {
        selected.clear();
        for (const item of desiredNodes) selected.add(item);
    } else if (selected && typeof selected === "object") {
        for (const key of Object.keys(selected)) delete selected[key];
        for (const item of desiredNodes) selected[item.id] = item;
    } else {
        canvas.selected_nodes = Object.fromEntries(desiredNodes.map((item) => [item.id, item]));
    }
    canvas.setDirty?.(true, true);
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
        z-index: 1000010;
        display: none;
        box-shadow: 0 4px 16px rgba(0,0,0,0.4);
        font-size: 14px;
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

    // 多图模式下替换指定位置的图片。保留原来的排序、其它图片和当前选择状态。
    function openReplaceImageDialog(imageName, imageIndex) {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.multiple = false;
        input.style.display = "none";
        document.body.appendChild(input);

        input.onchange = async (ev) => {
            const file = ev.target.files?.[0];
            if (!file) {
                input.remove();
                return;
            }
            try {
                const uploaded = await uploadFilesSequential([file]);
                const replacement = uploaded[0];
                // 上传期间列表可能已改变，因此在替换前重新定位目标项。
                const names = parseNameList(getImageListWidget(node)?.value);
                const targetIndex = names[imageIndex] === imageName
                    ? imageIndex
                    : names.indexOf(imageName);
                if (!replacement || targetIndex < 0) return;
                names[targetIndex] = replacement;
                setNameList(node, names);
                setIndex(node, targetIndex);
                selectedIndexes = [targetIndex];
                lastClickedIndex = targetIndex;
                redraw(true);
            } finally {
                input.remove();
            }
        };
        input.click();
    }

    const showContextMenu = (x, y, imageName, imageIndex) => {
        contextMenu.innerHTML = "";
        const imageCount = parseNameList(getImageListWidget(node)?.value).length;
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
            const saveItems = [];
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
                saveItems.push({ url, filename: realName });
            }
            if (saveItems.length > 1) await xzgSaveImagesBatch(saveItems);
            else if (saveItems.length === 1) await xzgSaveImage(saveItems[0].url, saveItems[0].filename);
        });
        if (uploadMode === "append") {
            const appendItem = document.createElement("div");
            appendItem.textContent = xzgT("追加图片", "Append Images");
            appendItem.style.cssText = "padding:6px 14px;cursor:pointer;white-space:nowrap;color:#66CC66;";
            appendItem.addEventListener("mouseenter", () => { appendItem.style.background = "var(--comfy-input-bg)"; });
            appendItem.addEventListener("mouseleave", () => { appendItem.style.background = ""; });
            appendItem.addEventListener("click", () => {
                hideContextMenu();
                openUploadDialog();
            });
            contextMenu.appendChild(appendItem);

            if (imageName && !multi) {
                const replaceItem = document.createElement("div");
                replaceItem.textContent = xzgT("替换图片", "Replace Image");
                replaceItem.style.cssText = "padding:6px 14px;cursor:pointer;white-space:nowrap;color:#FFD700;";
                replaceItem.addEventListener("mouseenter", () => { replaceItem.style.background = "var(--comfy-input-bg)"; });
                replaceItem.addEventListener("mouseleave", () => { replaceItem.style.background = ""; });
                replaceItem.addEventListener("click", () => {
                    hideContextMenu();
                    openReplaceImageDialog(imageName, imageIndex);
                });
                contextMenu.appendChild(replaceItem);
                appendContextMenuDivider();
            }

            if (imageName && imageCount > 1) {
                const clearOthersItem = document.createElement("div");
                clearOthersItem.textContent = xzgT("清除其它", "Clear Others");
                clearOthersItem.style.cssText = "padding:6px 14px;cursor:pointer;white-space:nowrap;color:#ff7777;";
                clearOthersItem.addEventListener("mouseenter", () => { clearOthersItem.style.background = "var(--comfy-input-bg)"; });
                clearOthersItem.addEventListener("mouseleave", () => { clearOthersItem.style.background = ""; });
                clearOthersItem.addEventListener("click", () => {
                    hideContextMenu();
                    const names = parseNameList(getImageListWidget(node)?.value);
                    const currentName = names[imageIndex] || imageName;
                    if (!currentName) return;
                    // 多选时保留所有已选图片；单选时仅保留右键点击的图片。
                    const keepIndexes = multi
                        ? [...selectedIndexes].filter((index) => index >= 0 && index < names.length)
                        : [imageIndex];
                    const keepSet = new Set(keepIndexes);
                    const retainedNames = names.filter((_, index) => keepSet.has(index));
                    if (retainedNames.length === 0) return;
                    const retainedIndexByOriginal = new Map();
                    let nextIndex = 0;
                    names.forEach((_, index) => {
                        if (keepSet.has(index)) retainedIndexByOriginal.set(index, nextIndex++);
                    });
                    setNameList(node, retainedNames);
                    const activeIndex = retainedIndexByOriginal.get(imageIndex) ?? 0;
                    setIndex(node, activeIndex);
                    selectedIndexes = keepIndexes
                        .map((index) => retainedIndexByOriginal.get(index))
                        .filter((index) => index !== undefined)
                        .sort((a, b) => a - b);
                    lastClickedIndex = activeIndex;
                    redraw(true);
                });
                contextMenu.appendChild(clearOthersItem);
                if (!multi) appendContextMenuDivider();
            }
        }
        if (imageName) contextMenu.appendChild(saveItem);

        if (imageName) {
            const libraryItem = document.createElement("div");
            libraryItem.textContent = xzgT("收藏到媒体库", "Add to Media Library");
            libraryItem.style.cssText = "padding:6px 14px;cursor:pointer;white-space:nowrap;";
            libraryItem.addEventListener("mouseenter", () => { libraryItem.style.background = "var(--comfy-input-bg)"; });
            libraryItem.addEventListener("mouseleave", () => { libraryItem.style.background = ""; });
            libraryItem.addEventListener("click", async () => {
                hideContextMenu();
                try {
                    const storedName = await addOriginalImageToMediaLibrary(imageName, _cropByImage[imageName], _cropPaddingColor);
                    if (app?.extensionManager?.toast?.add) {
                        app.extensionManager.toast.add({
                            title: xzgT("已收藏到媒体库", "Added to Media Library"),
                            message: storedName,
                            type: "success",
                            life: 2,
                        });
                    }
                } catch (error) {
                    const message = `${xzgT("收藏到媒体库失败", "Could not add to Media Library")}: ${error?.message || error}`;
                    if (app?.extensionManager?.toast?.add) {
                        app.extensionManager.toast.add({ title: xzgT("收藏失败", "Add failed"), message: error?.message || String(error), type: "error", life: 4 });
                    } else {
                        xzgAlert(message);
                    }
                }
            });
            contextMenu.appendChild(libraryItem);
        }

        // 原图高清查看入口放在菜单最下方：多图模式单张右键，以及单图模式均可用。
        if (imageName && (uploadMode === "replace" || (uploadMode === "append" && !multi))) {
            appendContextMenuDivider();
            const originalItem = document.createElement("div");
            originalItem.textContent = xzgT("查看原图", "View Original Image");
            originalItem.style.cssText = "padding:6px 14px;cursor:pointer;white-space:nowrap;color:#8ecbff;";
            originalItem.addEventListener("mouseenter", () => { originalItem.style.background = "var(--comfy-input-bg)"; });
            originalItem.addEventListener("mouseleave", () => { originalItem.style.background = ""; });
            originalItem.addEventListener("click", () => {
                hideContextMenu();
                openImageLightbox(imageName);
            });
            contextMenu.appendChild(originalItem);
        }

        if (multi) {
            const compareItem = document.createElement("div");
            compareItem.textContent = xzgT("图片对比", "Compare Images");
            compareItem.style.cssText = "padding:6px 14px;cursor:pointer;white-space:nowrap;color:#dcc85b;font-weight:600;";
            compareItem.addEventListener("mouseenter", () => { compareItem.style.background = "var(--comfy-input-bg)"; });
            compareItem.addEventListener("mouseleave", () => { compareItem.style.background = ""; });
            compareItem.addEventListener("click", () => {
                hideContextMenu();
                const compare = window.xzgSyncPreview;
                if (typeof compare?.previewNodes !== "function") {
                    console.warn("[小珠光图片加载器] 图片对比模块未加载");
                    return;
                }
                // previewNodes 会读取本加载器当前多选的原图条目。
                compare.previewNodes([node]);
            });
            // 图片对比默认置顶：插到自定义右键菜单最上方（仅多图模式显示）。
            contextMenu.insertBefore(compareItem, contextMenu.firstChild);
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

    const hideContextMenu = () => {
        contextMenu.style.display = "none";
    };

    const appendContextMenuDivider = () => {
        const divider = document.createElement("div");
        divider.setAttribute("aria-hidden", "true");
        divider.style.cssText = "width:82%;height:0;flex:0 0 auto;margin:2px auto;border-top:1px solid var(--input-text);opacity:.55;";
        contextMenu.appendChild(divider);
    };

    const addResetViewMenuItem = () => {
        const item = document.createElement("div");
        item.textContent = xzgT("重置视图", "Reset View");
        item.style.cssText = "padding:6px 14px;cursor:pointer;white-space:nowrap;";
        item.addEventListener("mouseenter", () => { item.style.background = "var(--comfy-input-bg)"; });
        item.addEventListener("mouseleave", () => { item.style.background = ""; });
        item.addEventListener("click", () => {
            hideContextMenu();
            if (cropEnabled && _imageEditWorkspace) _resetCropView();
            else _resetImgZoom();
            _renderMaskOverlay();
            _renderBrushPreview();
        });
        contextMenu.appendChild(item);
    };

    // 裁剪模式右键菜单：应用待选区 / 清空裁剪
    const showCropContextMenu = (x, y) => {
        contextMenu.innerHTML = "";
        addResetViewMenuItem();
        const makeItem = (label, color) => {
            const item = document.createElement("div");
            item.textContent = label;
            item.style.cssText = `padding:6px 14px;cursor:pointer;white-space:nowrap;color:${color || "var(--input-text)"};`;
            item.addEventListener("mouseenter", () => { item.style.background = "var(--comfy-input-bg)"; });
            item.addEventListener("mouseleave", () => { item.style.background = ""; });
            return item;
        };
        // 仅有有效的待应用选区时提供「应用裁剪」。
        if (_cropPending && _cropPending.w > 0 && _cropPending.h > 0) {
            const applyItem = makeItem(xzgT("应用裁剪", "Apply Crop"), "#66CC66");
            applyItem.title = xzgT("以当前选区裁剪图片", "Crop image to current selection");
            applyItem.addEventListener("click", () => {
                hideContextMenu();
                _applyCrop();
            });
            contextMenu.appendChild(applyItem);
        }
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
        // 始终提供恢复原始，方便在没有裁剪框时从右键菜单明确清除当前裁剪状态。
        const clearItem = makeItem(xzgT("恢复原始", "Restore Original"), "#4A90E2");
        clearItem.addEventListener("click", () => {
            hideContextMenu();
            _restoreOriginalCrop();
        });
        contextMenu.appendChild(clearItem);
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
    let maskPreviewColor = /^#[0-9a-f]{6}$/i.test(node.properties?.xzg_mask_preview_color || "")
        ? node.properties.xzg_mask_preview_color : "#ff0000";
    let maskOutputEnabled = node.properties?.xzg_mask_output_enabled === true ||
        String(getMaskOutputEnabledWidget(node)?.value || "").toLowerCase() === "true";
    let maskCloseEnabled = node.properties?.xzg_mask_close_enabled === true || node.properties?.xzg_mask_close_enabled === 1 ||
        String(node.properties?.xzg_mask_close_enabled || "").toLowerCase() === "true";
    let _maskStrokePoints = [];
    const _maskPreviewRgb = () => {
        const hex = /^#[0-9a-f]{6}$/i.test(maskPreviewColor) ? maskPreviewColor : "#ff0000";
        return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
    };
    let _maskRightErasing = false;         // 右键擦除中（临时覆盖 maskTool 为 eraser）
    let _maskDrawing = false;
    let _maskLastPt = null;
    let _maskHoverPt = null;               // 鼠标在 overlay 上的 CSS 像素坐标，用于笔刷预览
    let _lastCursorZoom = 0;               // 缓存上次光标更新时的 zoom，避免频繁重建
    let _altBrushActive = false;           // Alt+右键按下拖动：调整笔刷大小
    let _altBrushStartX = 0;               // Alt+右键拖动起始 X 坐标
    let _altBrushStartSize = 0;            // Alt+右键拖动起始笔刷大小
    let _imageEditWorkspace = null;            // 裁剪与遮罩共用的全屏编辑工作区
    let _editWorkspaceInitialZoomPending = false; // 进入编辑界面后，图片完成布局时应用一次默认 80% 缩放
    let _maskImgZoom = 1;                    // 图片缩放倍率（1x~8x）
    let _maskTx = 0;                         // 当前 CSS translateX（增量累积）
    let _maskTy = 0;                         // 当前 CSS translateY（增量累积）
    let _viewPanDrag = null;                  // 裁剪界面中键 / Ctrl+左键平移手势
    let _lastKnownMouseX = 0;                // 全局跟踪的鼠标 X（相对容器），wheel 事件可能坐标滞后
    let _lastKnownMouseY = 0;                // 全局跟踪的鼠标 Y（相对容器）
    // 遮罩离屏 canvas：始终保存"原图尺寸"的遮罩数据，不受 DOM 显示缩放影响
    const maskOffscreen = document.createElement("canvas");
    const maskOffCtx = maskOffscreen.getContext("2d");
    // 记录当前遮罩对应哪张图（文件名），切图时自动重建
    let _maskBoundImageName = null;
    let _maskByImage = {};
    let _maskWidgetSource = null;
    // 遮罩原图真实尺寸（像素），用于映射绘制坐标
    let _maskImgNaturalW = 0;
    let _maskImgNaturalH = 0;

    // ═══════════ 裁剪选区状态（仅单图模式可用，与遮罩同入口） ═══════════
    let cropEnabled = false;            // 裁剪选区模式是否开启
    let cropRect = null;                // 原图像素 { x, y, w, h }，null = 无裁剪
    function _enterImageEditWorkspace() {
        if (_imageEditWorkspace || !container.parentElement) return;
        const parent = container.parentElement;
        const anchor = document.createComment("xzg-image-loader-edit-workspace-anchor");
        parent.insertBefore(anchor, container);

        const overlay = document.createElement("div");
        overlay.className = "xzg-img-edit-workspace";
        overlay.style.cssText =
            "position:fixed;inset:0;z-index:1000000;display:flex;align-items:stretch;justify-content:stretch;" +
            "box-sizing:border-box;padding:14px;background:rgba(8,8,8,.96);";
        overlay.addEventListener("pointerdown", (e) => e.stopPropagation());
        overlay.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); });

        _imageEditWorkspace = {
            parent,
            anchor,
            overlay,
            originalStyle: container.style.cssText,
        };
        overlay.appendChild(container);
        container.style.width = "100%";
        container.style.height = "100%";
        container.style.minHeight = "0";
        container.style.flex = "1 1 auto";
        container.style.borderRadius = "8px";
        document.body.appendChild(overlay);
        requestAnimationFrame(() => _renderMaskOverlay());
    }

    function _exitImageEditWorkspace() {
        if (!_imageEditWorkspace) return;
        const workspace = _imageEditWorkspace;
        _imageEditWorkspace = null;
        if (workspace.anchor.parentNode) {
            workspace.anchor.parentNode.insertBefore(container, workspace.anchor);
        } else if (workspace.parent?.isConnected) {
            workspace.parent.appendChild(container);
        }
        container.style.cssText = workspace.originalStyle;
        workspace.anchor.remove();
        workspace.overlay.remove();
        requestAnimationFrame(() => _renderMaskOverlay());
    }
    let _cropDrawing = false;           // 拖拽选择矩形中
    let _cropSelStart = null;           // 选区起点（原图像素）
    let _cropSelCur = null;             // 选区当前点（原图像素，拖拽中）
    let _cropPending = null;            // 拖拽出的待应用选区（原图像素），右键「应用裁剪」或双击后才生效
    let _cropResizeCorner = null;       // 正在拖动的裁剪框角（"tl"/"tr"/"bl"/"br"）或 null
    let _cropResizeBase = null;         // 拖动角开始时待选框（原图像素），用于重算
    let _cropResizeAnchorPos = null;    // 拖动角时固定的对角锚点（原图像素 [x,y]）
    let _cropResizeFromCenter = false;   // Alt 拖动时以裁剪框中心为锚点对称缩放
    let _cropMove = false;              // 是否正在拖动裁剪框整体移动位置
    let _cropMoveStart = null;          // 移动起点（原图像素 [x,y]）
    let _cropMoveBase = null;           // 移动开始时待选框（原图像素 {x,y,w,h}）
    let _cropAspect = null;             // 裁剪比例约束（如 9/16、16/9…），null = 自由比例
    let _cropByImage = {};               // 图片名 -> [x,y,w,h]，每张图独立维护裁剪区域，切换图片不丢失
    let _cropPaddingColor = "#ffffff";   // 图片外裁剪补边颜色
    const _defaultImageTransform = () => ({ flip_x: false, flip_y: false });
    const _imageTransformByName = {};
    let _currentImageTransform = _defaultImageTransform();
    const _normalizeImageTransform = (value) => {
        const t = { ..._defaultImageTransform(), ...(value && typeof value === "object" ? value : {}) };
        return { flip_x: !!t.flip_x, flip_y: !!t.flip_y };
    };

    function _normalizeCropPaddingColor(value) {
        const color = String(value || "").trim();
        if (/^#[0-9a-f]{6}$/i.test(color)) return color.toLowerCase();
        if (/^#[0-9a-f]{3}$/i.test(color)) return "#" + color.slice(1).split("").map((ch) => ch + ch).join("").toLowerCase();
        return "#ffffff";
    }

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
            const cell = e.target.closest("[data-xzg-img-card]");
            const imageIndex = cell ? parseInt(cell.dataset.xzgIndex, 10) : getIndex(node);
            // 右键已选中的图片时保留多选集合，供「保存选中图片」使用；
            // 右键未选中的图片则将它设为唯一选择。
            if (Number.isInteger(imageIndex) && imageIndex >= 0) {
                if (!selectedIndexes.includes(imageIndex)) {
                    selectedIndexes = [imageIndex];
                    lastClickedIndex = imageIndex;
                    setIndex(node, imageIndex);
                    redraw(false);
                }
            }
            showContextMenu(e.clientX, e.clientY, imgName, imageIndex);
        } else if (uploadMode === "append") {
            // 多图区域的空白处也可直接追加，不依赖已有图片。
            showContextMenu(e.clientX, e.clientY, null, -1);
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
        media: '<svg viewBox="0 0 24 24"><path d="M3 8a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="9" cy="12" r="1"/><path d="m6 17 4-3 2 2 2-2 4 3"/></svg>',
        del: '<svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>',
        clear: '<svg viewBox="0 0 24 24"><path d="M19 5L9.5 14.5"/><path d="M8 19l-3 3"/><path d="M13 20.5l-4 4"/><path d="M6.5 8.5l.01 0"/><path d="M10 6l.01 0"/><path d="M15 17l-2 2"/><path d="M12.5 12.5L17 8"/></svg>',
        mask: '<svg class="xzg-ic-mask" viewBox="0 0 24 24"><circle class="mr" cx="12" cy="12" r="9.5"/><path class="ml" d="M12 2.5 A9.5 9.5 0 0 1 21.5 12 A9.5 9.5 0 0 1 12 21.5 A4.75 4.75 0 0 1 12 12 A4.75 4.75 0 0 0 12 2.5 Z"/><circle class="o" cx="12" cy="12" r="9.5"/><circle class="er" cx="12" cy="16.75" r="1.15"/></svg>',
        crop: '<svg viewBox="0 0 24 24"><path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/></svg>'
    };

    if (!document.getElementById("xzg-side-ic-style")) {
        const _ics = document.createElement("style");
        _ics.id = "xzg-side-ic-style";
        _ics.textContent = `
            .xzg-ic-btn{display:flex;align-items:center;justify-content:flex-start;gap:6px;width:100%;padding:var(--xzg-btn-pad-y,4px) 2px;box-sizing:border-box;border:none;background:transparent;border-radius:4px;cursor:pointer;color:var(--input-text);white-space:nowrap;}
            .xzg-ic-btn:hover{filter:brightness(1.2);}
            .xzg-ic-btn svg{width:var(--xzg-ic-size, 20px);height:var(--xzg-ic-size, 20px);flex:0 0 auto;display:block;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round;}
            .xzg-ic-btn .xzg-ic-g{display:inline-flex;}
            .xzg-ic-btn .xzg-ic-lb{display:none;overflow:hidden;text-overflow:ellipsis;}
            .xzg-edit .xzg-ic-btn{justify-content:center;}
            .xzg-edit .xzg-ic-btn .xzg-ic-lb{display:inline;}
            .xzg-edit .xzg-ic-btn .xzg-ic-g{display:none;}
            .xzg-img-edit-workspace .xzg-edit .xzg-ic-btn .xzg-ic-lb{font-size:15px!important;}
            .xzg-img-edit-workspace .xzg-edit .xzg-edit-exit-btn{position:relative;z-index:20;width:max-content!important;min-width:max-content;align-self:flex-start;justify-content:flex-start!important;transform:translate(16px,12px);}
            .xzg-img-edit-workspace .xzg-edit .xzg-edit-exit-btn .xzg-ic-lb{width:max-content;max-width:none;flex:0 0 auto;font-size:45px!important;line-height:1.2;overflow:visible!important;text-overflow:clip!important;white-space:nowrap;}
            .xzg-img-edit-workspace .xzg-edit .xzg-mask-toolbar button:not(.xzg-ic-btn),
            .xzg-img-edit-workspace .xzg-edit .xzg-mask-toolbar select,
            .xzg-img-edit-workspace .xzg-edit .xzg-mask-toolbar > div > span{font-size:15px!important;}
            .xzg-img-edit-workspace .xzg-edit .xzg-mask-toolbar button:not(.xzg-edit-exit-btn){font-size:20px!important;line-height:1.2;}
            .xzg-img-edit-workspace .xzg-crop-ratio-bar .xzg-crop-ratio-btn{font-size:14px!important;line-height:1.2;text-align:center!important;}
            .xzg-img-edit-workspace .xzg-edit .xzg-mask-toolbar .xzg-crop-ratio-text{display:inline-grid;grid-template-columns:2ch 1ch 2ch;width:5ch;text-align:center;}
            .xzg-crop-ratio-options .xzg-crop-ratio-btn:hover{background:rgba(255,255,255,.12)!important;}
            .xzg-img-edit-workspace .xzg-edit .xzg-mask-toolbar .xzg-ic-btn:not(.xzg-edit-exit-btn) .xzg-ic-lb{font-size:20px!important;line-height:1.2;}
            .xzg-img-edit-workspace .xzg-edit .xzg-mask-toolbar select{font-size:20px!important;}
            .xzg-img-edit-workspace .xzg-edit .xzg-mask-toolbar select{color:#fff!important;}
            .xzg-img-edit-workspace .xzg-edit .xzg-mask-toolbar > div > span{font-size:20px!important;}
            :root{--xzg-mask-dark:#000000;--xzg-mask-light:#f5f5f5;}
            [data-theme="light"]{--xzg-mask-dark:#000000;--xzg-mask-light:#fafafa;}
            .xzg-ic-btn .xzg-ic-mask .o{fill:none;stroke:currentColor;stroke-width:1.5;stroke-linejoin:round;}
            .xzg-ic-btn .xzg-ic-mask .ml{fill:var(--xzg-mask-light);stroke:none;}
            .xzg-ic-btn .xzg-ic-mask .mr{fill:var(--xzg-mask-dark);stroke:none;}
            .xzg-ic-btn .xzg-ic-mask .el{fill:var(--xzg-mask-dark);stroke:none;}
            .xzg-ic-btn .xzg-ic-mask .er{fill:var(--xzg-mask-light);stroke:none;}
            /* 上限输入框隐藏 number 上下箭头 */
            .xzg-max-img-input::-webkit-inner-spin-button,
            .xzg-max-img-input::-webkit-outer-spin-button{-webkit-appearance:none;margin:0;}
            .xzg-max-img-input{-moz-appearance:textfield;appearance:textfield;}
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
            b.style.cssText = "font-size:13px;line-height:1.4;width:100%;";
        } else {
            b.textContent = label;
            b.style.cssText =
                "font-size:13px;line-height:1.4;width:100%;text-align:left;overflow:hidden;text-overflow:ellipsis;";
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
    const mediaBtn = mkBtn(xzgT("资源媒体", "Media assets"), xzgT("打开资源媒体库", "Open media library"), "media");
    const deleteBtn = mkBtn(xzgT("删除", "Delete"), xzgT("删除选中", "Delete selected"), "del");
    const clearBtn = mkBtn(xzgT("清空", "Clear"), xzgT("清空全部", "Clear all"), "clear");

    // 操作按钮包在组内，加大间距
    const initialActionGap = "6px";
    const actionGroup = document.createElement("div");
    actionGroup.style.cssText = `display:flex;flex-direction:column;gap:${initialActionGap};width:100%;`;
    const createActionDivider = () => {
        const divider = document.createElement("div");
        divider.setAttribute("aria-hidden", "true");
        divider.style.cssText = "width:82%;height:0;flex:0 0 auto;align-self:center;border-top:1px solid var(--input-text);opacity:.55;";
        return divider;
    };
    const mediaMaskDivider = createActionDivider();
    actionGroup.appendChild(uploadBtn);
    actionGroup.appendChild(folderBtn);
    actionGroup.appendChild(outputBtn);
    actionGroup.appendChild(mediaBtn);
    actionGroup.appendChild(mediaMaskDivider);
    const safetyActionGroup = document.createElement("div");
    safetyActionGroup.style.cssText = `display:flex;flex-direction:column;gap:${initialActionGap};width:100%;margin-top:4px;`;
    const cropDeleteDivider = createActionDivider();
    safetyActionGroup.appendChild(cropDeleteDivider);
    safetyActionGroup.appendChild(deleteBtn);
    safetyActionGroup.appendChild(clearBtn);
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
        _resetImageEditsForModeSwitch();
        uploadMode = newMode;
        viewMode = uploadMode === "append" ? "grid" : "single";
        updateUploadModeBtn();
        _refreshMaskToolbar();
        _updateMaskCursor();
        redraw(true);
    }

    // 加载图片上限输入框：仅多图（append）模式显示，位于“多图”标签上方，0/无输入表示无限制
    const maxImgInput = document.createElement("input");
    maxImgInput.className = "xzg-max-img-input";
    maxImgInput.type = "text";
    maxImgInput.inputMode = "numeric";
    maxImgInput.autocomplete = "off";
    // 显示辅助：0 或空显示无穷符号 ∞，否则显示数字
    const setMaxImgDisplay = () => {
        const w = getMaxImagesWidget(node);
        const num = normalizeMaxImagesWidget(w);
        maxImgInput.value = num > 0 ? String(num) : "∞";
    };
    setMaxImgDisplay();
    maxImgInput.title = xzgT("加载图片上限，0/∞ 表示无限制", "Max images to load, 0/∞ = unlimited");
    maxImgInput.setAttribute("aria-label", xzgT("加载图片上限", "Maximum images to load"));
    maxImgInput.style.cssText =
        "width:calc(2 * var(--xzg-ui-font,10px));max-width:100%;min-width:0;height:20px;flex:0 0 auto;align-self:flex-start;margin:0 0 2px 2px;box-sizing:border-box;padding:0 1px 3px 1px;font-size:var(--xzg-ui-font,10px);line-height:1;font-family:'Segoe UI Symbol','Noto Sans Symbols 2','DejaVu Sans',sans-serif;color:var(--input-text);background:var(--comfy-input-bg,rgba(0,0,0,0.22));border:1px solid var(--border-color,rgba(255,255,255,0.25));border-radius:4px;outline:none;text-align:center;cursor:text;transition:border-color 0.12s ease,box-shadow 0.12s ease,background 0.12s ease;";
    // 输入框交互不冒泡，避免触发节点/侧边栏拖动
    maxImgInput.addEventListener("pointerdown", (e) => e.stopPropagation());
    maxImgInput.addEventListener("mousedown", (e) => e.stopPropagation());
    maxImgInput.addEventListener("click", (e) => e.stopPropagation());
    // 保持原生文本光标行为；点击数字定位插入点，不自动蓝色全选。
    maxImgInput.addEventListener("focus", () => {
        maxImgInput.style.borderColor = "var(--input-text,#fff)";
        maxImgInput.style.background = "var(--comfy-input-bg,rgba(0,0,0,0.4))";
        maxImgInput.style.boxShadow = "0 0 0 1px color-mix(in srgb, var(--input-text,#fff) 25%, transparent)";
    });
    maxImgInput.addEventListener("blur", () => {
        maxImgInput.style.borderColor = "var(--border-color,rgba(255,255,255,0.25))";
        maxImgInput.style.background = "var(--comfy-input-bg,rgba(0,0,0,0.22))";
        maxImgInput.style.boxShadow = "none";
    });
    maxImgInput.addEventListener("change", () => {
        const w = getMaxImagesWidget(node);
        if (!w) return;
        // ∞、空字符串、0 一律视为无限制（0）
        let v = parseInt(maxImgInput.value.replace("∞", "").trim(), 10);
        if (isNaN(v) || v < 0) v = 0;
        w.value = v;
        w.callback?.(v);
        setMaxImgDisplay();
        // 上限变化后刷新预览区，使其与后端输出（前 N 张）联动
        redraw(true);
    });

    const updateMaxImgInput = () => {
        setMaxImgDisplay();
        maxImgInput.style.display = uploadMode === "append" ? "" : "none";
    };

    const uploadModeBtn = document.createElement("button");
    uploadModeBtn.style.cssText =
        "padding:1px 2px;background:transparent;color:var(--input-text);border:none;border-radius:4px;cursor:pointer;font-size:var(--xzg-ui-font,10px);line-height:1.4;width:100%;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-sizing:border-box;";
    uploadModeBtn.addEventListener("mouseenter", () => {
        uploadModeBtn.style.filter = "brightness(1.2)";
    });
    uploadModeBtn.addEventListener("mouseleave", () => {
        uploadModeBtn.style.filter = "";
    });
    uploadModeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const wasAppend = uploadMode === "append";
        _resetImageEditsForModeSwitch();
        uploadMode = uploadMode === "append" ? "replace" : "append";
        viewMode = uploadMode === "append" ? "grid" : "single";
        // 保存到 widget，随工作流持久化
        _writeUploadMode(uploadMode);
        // 切换到单图模式时，只保留第一张图片
        if (wasAppend && uploadMode === "replace") {
            const names = parseNameList(getImageListWidget(node)?.value);
            if (names.length > 1) {
                setNameList(node, [names[0]]);
                setIndex(node, 0);
            }
        }
        updateUploadModeBtn();
        updateModeBtn();
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
        updateMaxImgInput();
    };
    updateUploadModeBtn();

    const modeBtn = document.createElement("button");
    modeBtn.style.cssText =
        "padding:1px 2px;background:transparent;color:var(--input-text);border:none;border-radius:4px;cursor:pointer;font-size:var(--xzg-ui-font,10px);line-height:1.4;width:100%;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-sizing:border-box;";
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
        // 仅单图加载模式禁用；多图模式下即使未加载图片也允许切换列表/批次
        const isSingleMode = uploadMode === "replace";
        const disabled = isSingleMode;
        // 单图模式下隐藏批次/列表按钮（visibility 隐藏以保持布局稳定）
        modeBtn.style.visibility = isSingleMode ? "hidden" : "visible";
        
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
        updateAlignBtn();
    };
    
    modeBtn.onclick = (e) => {
        e.stopPropagation();
        if (uploadMode === "replace") return; // 单图加载模式时禁止切换
        const w = getBatchModeWidget(node);
        if (!w) return;
        w.value = !w.value;
        w.callback?.(w.value);
        updateModeBtn();
    };

    // 批次对齐方式标签切换：裁剪（默认，居中裁剪多出部分）/ 留边（letterbox，黑色填充补齐）
    // 仅在批次模式下显示，列表/单图模式下隐藏
    const alignBtn = document.createElement("button");
    alignBtn.style.cssText = modeBtn.style.cssText;
    alignBtn.addEventListener("mouseenter", () => {
        alignBtn.style.filter = "brightness(1.2)";
    });
    alignBtn.addEventListener("mouseleave", () => {
        alignBtn.style.filter = "";
    });

    const updateAlignBtn = () => {
        const wBatch = getBatchModeWidget(node);
        const isBatch = wBatch?.value === true;
        const names = parseNameList(getImageListWidget(node)?.value || "");
        const singleImg = names.length <= 1;
        const w = getBatchAlignWidget(node);
        const isLetterbox = w?.value === true;
        // 无论显示与否都先写入文案，使隐藏态也占用与显示态一致的高度，杜绝切换批次时菜单位移
        alignBtn.textContent = isLetterbox ? xzgT("留边", "Letterbox") : xzgT("裁剪", "Crop");
        alignBtn.title = isLetterbox ? xzgT("切换为裁剪对齐（居中裁剪多出部分）", "Switch to Crop (center crop)") : xzgT("切换为留边对齐（黑色填充补齐）", "Switch to Letterbox (black bars)");
        // 批次模式下仅加载多张图时显示裁剪/留边；其余情况用 visibility 隐藏（占位保留）
        alignBtn.style.visibility = isBatch && !singleImg ? "visible" : "hidden";
        if (isBatch && !singleImg) {
            alignBtn.style.color = "#FFD700";
            alignBtn.style.cursor = "pointer";
            alignBtn.style.opacity = "1";
        }
    };

    alignBtn.onclick = (e) => {
        e.stopPropagation();
        const w = getBatchAlignWidget(node);
        if (!w) return;
        w.value = !w.value;
        w.callback?.(w.value);
        updateAlignBtn();
    };

    const bottomGroup = document.createElement("div");
    bottomGroup.style.cssText = "display:flex;flex-direction:column;gap:0;width:100%;margin-top:auto;";
    bottomGroup.appendChild(maxImgInput);
    bottomGroup.appendChild(uploadModeBtn);
    bottomGroup.appendChild(modeBtn);
    bottomGroup.appendChild(alignBtn);
    sidebar.appendChild(bottomGroup);

    // ═══════════ 遮罩绘制工具栏（左侧面板，清空按钮下方） ═══════════
    const maskToolbar = document.createElement("div");
    maskToolbar.className = "xzg-mask-toolbar";
    maskToolbar.style.cssText = `display:none;flex-direction:column;gap:${initialActionGap};width:100%;`;
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
    const maskToggleBtn = _mkMaskBtn(xzgT("遮罩", "Mask"), xzgT("开启/关闭当前图片的遮罩绘制", "Toggle mask drawing for the current image"), "mask");
    const maskBrushBtn = _mkMaskBtn(xzgT("画笔", "Brush"), xzgT("切换到画笔工具", "Switch to Brush"));
    const maskEraserBtn = _mkMaskBtn(xzgT("橡皮", "Eraser"), xzgT("切换到橡皮擦工具", "Switch to Eraser"));
    const maskClearBtn = _mkMaskBtn(xzgT("清空", "Clear"), xzgT("清除整个遮罩", "Clear mask"));
    const maskInvertBtn = _mkMaskBtn(xzgT("反相", "Invert"), xzgT("反相遮罩黑白区域", "Invert mask B/W"));

    // 画笔大小滑条
    const brushSizeRow = document.createElement("div");
    brushSizeRow.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:4px;width:100%;box-sizing:border-box;padding:6px 2px 2px;";
    const brushSizeLabel = document.createElement("div");
    brushSizeLabel.style.cssText = "width:100%;box-sizing:border-box;font-size:16px;color:var(--input-text);text-align:center;line-height:1.3;";
    brushSizeLabel.textContent = `${xzgT("笔刷", "Brush")}:${brushSize}`;
    const brushSizeInput = document.createElement("input");
    brushSizeInput.type = "range";
    brushSizeInput.min = "1";
    brushSizeInput.max = "200";
    brushSizeInput.value = String(brushSize);
    const brushSizeHitArea = document.createElement("div");
    brushSizeHitArea.style.cssText = "display:flex;align-items:center;justify-content:center;width:100%;height:424px;min-height:424px;flex:0 0 424px;touch-action:none;cursor:ns-resize;";
    brushSizeInput.setAttribute("aria-label", xzgT("笔刷大小", "Brush size"));
    brushSizeInput.style.cssText = `display:block;align-self:center;box-sizing:border-box;writing-mode:vertical-lr;direction:rtl;width:22px;height:100%;min-height:100%;margin:0;accent-color:${maskPreviewColor};pointer-events:none;`;
    const _setBrushSizeFromPointer = (e) => {
        const rect = brushSizeHitArea.getBoundingClientRect();
        if (rect.height <= 0) return;
        const ratio = Math.max(0, Math.min(1, (rect.bottom - e.clientY) / rect.height));
        brushSize = Math.round(1 + ratio * 199);
        brushSizeInput.value = String(brushSize);
        brushSizeLabel.textContent = `${xzgT("笔刷", "Brush")}:${brushSize}`;
        _updateMaskCursor();
        _renderBrushPreview();
    };
    let brushSizePointerId = null;
    brushSizeHitArea.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        brushSizePointerId = e.pointerId;
        brushSizeHitArea.setPointerCapture(e.pointerId);
        _setBrushSizeFromPointer(e);
    });
    brushSizeHitArea.addEventListener("pointermove", (e) => {
        if (brushSizePointerId !== e.pointerId) return;
        e.preventDefault();
        e.stopPropagation();
        _setBrushSizeFromPointer(e);
    });
    const _finishBrushSizeDrag = (e) => {
        if (brushSizePointerId !== e.pointerId) return;
        e.preventDefault();
        e.stopPropagation();
        brushSizePointerId = null;
        if (brushSizeHitArea.hasPointerCapture(e.pointerId)) brushSizeHitArea.releasePointerCapture(e.pointerId);
    };
    brushSizeHitArea.addEventListener("pointerup", _finishBrushSizeDrag);
    brushSizeHitArea.addEventListener("pointercancel", _finishBrushSizeDrag);
    brushSizeInput.addEventListener("input", () => {
        brushSize = parseInt(brushSizeInput.value, 10) || 1;
        brushSizeLabel.textContent = `${xzgT("笔刷", "Brush")}:${brushSize}`;
        _updateMaskCursor();
        _renderBrushPreview();
    });
    brushSizeHitArea.appendChild(brushSizeInput);
    brushSizeRow.appendChild(brushSizeHitArea);
    brushSizeRow.appendChild(brushSizeLabel);

    const maskColorRow = document.createElement("div");
    maskColorRow.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:3px;padding:3px 0;";
    const maskColorControlRow = document.createElement("div");
    maskColorControlRow.style.cssText = "display:flex;align-items:center;justify-content:center;gap:5px;width:100%;";
    const maskColorLabel = document.createElement("span");
    maskColorLabel.textContent = xzgT("预览色", "Color");
    maskColorLabel.title = xzgT("自定义遮罩预览颜色", "Customize mask preview color");
    maskColorLabel.style.cssText = "font-size:13px;color:var(--input-text);white-space:nowrap;";
    const maskColorInput = document.createElement("input");
    maskColorInput.type = "color";
    maskColorInput.value = maskPreviewColor;
    maskColorInput.title = maskColorLabel.title;
    maskColorInput.style.cssText = "width:36px;height:28px;padding:1px;border:1px solid var(--border-color);border-radius:4px;background:transparent;cursor:pointer;";
    const maskColorPresets = [
        [xzgT("红色", "Red"), "#ff0000"],
        [xzgT("绿色", "Green"), "#00ff00"],
        [xzgT("黄色", "Yellow"), "#ffff00"],
        [xzgT("蓝色", "Blue"), "#0000ff"],
    ];
    const maskColorPresetRow = document.createElement("div");
    maskColorPresetRow.style.cssText = "display:flex;justify-content:center;gap:5px;padding:2px 0;";
    const maskColorPresetButtons = [];
    const _setMaskPreviewColor = (color) => {
        if (!/^#[0-9a-f]{6}$/i.test(color || "")) return;
        maskPreviewColor = color;
        maskColorInput.value = color;
        brushSizeInput.style.accentColor = color;
        if (node.properties) node.properties.xzg_mask_preview_color = maskPreviewColor;
        const colorWidget = getMaskOutputColorWidget(node);
        if (colorWidget) colorWidget.value = maskPreviewColor;
        // 卡片上的遮罩缩略图是独立 canvas，颜色变更后重建以同步预览色。
        if (uploadMode === "append" && grid?.isConnected) redraw(true);
        for (const [preset, presetColor] of maskColorPresetButtons) {
            preset.style.borderColor = presetColor === color.toLowerCase() ? "#fff" : "rgba(255,255,255,0.45)";
            preset.style.boxShadow = presetColor === color.toLowerCase() ? "0 0 0 1px #222" : "none";
        }
        _renderMaskOverlay();
        if (app?.graph?.setDirtyCanvas) app.graph.setDirtyCanvas(true, true);
    };
    for (const [label, color] of maskColorPresets) {
        const preset = document.createElement("button");
        preset.type = "button";
        preset.title = label;
        preset.setAttribute("aria-label", label);
        preset.style.cssText = `width:16px;height:16px;min-width:16px;padding:0;border:1px solid rgba(255,255,255,0.55);border-radius:50%;background:${color};cursor:pointer;`;
        preset.addEventListener("click", (e) => {
            e.stopPropagation();
            _setMaskPreviewColor(color);
        });
        maskColorPresetButtons.push([preset, color]);
        maskColorPresetRow.appendChild(preset);
    }
    for (const [preset, color] of maskColorPresetButtons) {
        if (color === maskPreviewColor.toLowerCase()) {
            preset.style.borderColor = "#fff";
            preset.style.boxShadow = "0 0 0 1px #222";
        }
    }
    maskColorInput.addEventListener("input", () => _setMaskPreviewColor(maskColorInput.value));
    maskColorControlRow.appendChild(maskColorLabel);
    maskColorControlRow.appendChild(maskColorInput);
    maskColorRow.appendChild(maskColorControlRow);
    maskColorRow.appendChild(maskColorPresetRow);

    const maskOutputToggleBtn = _mkMaskBtn(xzgT("输出着色", "Tint Output"),
        xzgT("开关：把遮罩区域按预览色合成到图像输出（遮罩端口仍单独输出）", "Toggle tinting masked regions in IMAGE output; MASK output remains separate"));
    maskOutputToggleBtn.replaceChildren();
    const maskOutputToggleLabel = document.createElement("span");
    maskOutputToggleLabel.textContent = xzgT("着色输出", "Tint Output");
    const maskOutputToggleIndicator = document.createElement("span");
    maskOutputToggleIndicator.setAttribute("aria-hidden", "true");
    maskOutputToggleIndicator.style.cssText = "display:inline-block;width:8px;height:8px;flex:0 0 8px;border-radius:50%;box-sizing:border-box;";
    maskOutputToggleBtn.appendChild(maskOutputToggleLabel);
    maskOutputToggleBtn.appendChild(maskOutputToggleIndicator);
    maskOutputToggleBtn.style.cssText = "display:flex;align-items:center;justify-content:center;gap:5px;width:100%;box-sizing:border-box;padding:5px 2px;border:none;border-radius:4px;font-size:11px;font-weight:600;line-height:1.2;white-space:nowrap;cursor:pointer;transition:background 0.12s ease,color 0.12s ease;";
    maskOutputToggleIndicator.style.transform = "translateX(3px)";
    const _setMaskOutputEnabled = (enabled) => {
        maskOutputEnabled = !!enabled;
        const widget = getMaskOutputEnabledWidget(node);
        if (widget) widget.value = maskOutputEnabled;
        if (node.properties) node.properties.xzg_mask_output_enabled = maskOutputEnabled;
        maskOutputToggleBtn.setAttribute("aria-pressed", String(maskOutputEnabled));
        maskOutputToggleBtn.style.color = maskOutputEnabled ? "#baffc2" : "var(--input-text)";
        maskOutputToggleBtn.style.background = maskOutputEnabled ? "rgba(55,170,75,0.35)" : "rgba(128,128,128,0.12)";
        maskOutputToggleIndicator.style.background = maskOutputEnabled ? "#54e36e" : "transparent";
        maskOutputToggleIndicator.style.border = maskOutputEnabled ? "1px solid #d8ffe0" : "1px solid #9a9a9a";
        if (app?.graph?.setDirtyCanvas) app.graph.setDirtyCanvas(true, true);
    };
    maskOutputToggleBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        _setMaskOutputEnabled(!maskOutputEnabled);
    });
    _setMaskOutputEnabled(maskOutputEnabled);

    const maskCloseToggleBtn = _mkMaskBtn(xzgT("封闭遮罩", "Close Mask"),
        xzgT("开启后，画出接近闭合的轮廓时会自动闭合并填充内部", "Automatically close and fill the inside of a nearly closed brush stroke"));
    maskCloseToggleBtn.replaceChildren();
    const maskCloseToggleLabel = document.createElement("span");
    maskCloseToggleLabel.textContent = xzgT("封闭遮罩", "Close Mask");
    const maskCloseToggleIndicator = document.createElement("span");
    maskCloseToggleIndicator.setAttribute("aria-hidden", "true");
    maskCloseToggleIndicator.style.cssText = "display:inline-block;width:8px;height:8px;flex:0 0 8px;border-radius:50%;box-sizing:border-box;transform:translateX(3px);";
    maskCloseToggleBtn.appendChild(maskCloseToggleLabel);
    maskCloseToggleBtn.appendChild(maskCloseToggleIndicator);
    maskCloseToggleBtn.style.cssText = "display:flex;align-items:center;justify-content:center;gap:5px;width:100%;box-sizing:border-box;padding:5px 2px;border:none;border-radius:4px;font-size:11px;font-weight:600;line-height:1.2;white-space:nowrap;cursor:pointer;transition:background 0.12s ease,color 0.12s ease;";
    const _setMaskCloseEnabled = (enabled) => {
        maskCloseEnabled = !!enabled;
        if (node.properties) node.properties.xzg_mask_close_enabled = maskCloseEnabled;
        maskCloseToggleBtn.setAttribute("aria-pressed", String(maskCloseEnabled));
        maskCloseToggleBtn.style.color = maskCloseEnabled ? "#baffc2" : "var(--input-text)";
        maskCloseToggleBtn.style.background = maskCloseEnabled ? "rgba(55,170,75,0.35)" : "rgba(128,128,128,0.12)";
        maskCloseToggleIndicator.style.background = maskCloseEnabled ? "#54e36e" : "transparent";
        maskCloseToggleIndicator.style.border = maskCloseEnabled ? "1px solid #d8ffe0" : "1px solid #9a9a9a";
        if (app?.graph?.setDirtyCanvas) app.graph.setDirtyCanvas(true, true);
    };
    maskCloseToggleBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        _setMaskCloseEnabled(!maskCloseEnabled);
    });
    _setMaskCloseEnabled(maskCloseEnabled);

    maskToolbar.appendChild(maskToggleBtn);
    maskToolbar.appendChild(maskColorRow);
    maskToolbar.appendChild(maskOutputToggleBtn);
    maskToolbar.appendChild(maskCloseToggleBtn);
    maskToolbar.appendChild(maskBrushBtn);
    maskToolbar.appendChild(maskEraserBtn);
    maskToolbar.appendChild(maskClearBtn);
    maskToolbar.appendChild(maskInvertBtn);
    maskToolbar.appendChild(brushSizeRow);

    // 裁剪选区按钮（与遮罩同一工具栏，仅单图模式显示，互斥开启）
    const cropToggleBtn = _mkMaskBtn(xzgT("裁剪", "Crop"), xzgT("开启/关闭裁剪选区（仅单图模式）", "Toggle crop region (single mode only)"), "crop");
    const cropClearBtn = _mkMaskBtn(xzgT("恢复原始", "Restore Original"), xzgT("撤销裁剪，恢复原图", "Reset crop"));
    // 清除当前待选框并解除拖选锁定，便于重新框选
    const cropSelClearBtn = _mkMaskBtn(xzgT("清除选框", "Clear Sel"), xzgT("清除当前裁剪选框，可重新框选", "Clear current crop selection"));
    // 应用裁剪：把当前选框正式应用到图片
    const cropApplyBtn = _mkMaskBtn(xzgT("应用裁剪", "Apply Crop"), xzgT("应用当前裁剪选框", "Apply current crop region"));
    // 比例按钮在裁剪预览区顶部单行展示，点击即切换，不再使用下拉列表。
    const _cropRatios = [["自由", null], ["9:16", 9 / 16], ["16:9", 16 / 9], ["1:1", 1], ["2:3", 2 / 3], ["3:2", 3 / 2], ["3:4", 3 / 4], ["4:3", 4 / 3]];
    const cropRatioRow = document.createElement("div");
    cropRatioRow.className = "xzg-crop-ratio-bar";
    cropRatioRow.style.cssText = "position:absolute;top:10px;left:50%;transform:translateX(-50%);z-index:20;display:none;flex-direction:row;align-items:center;gap:6px;max-width:calc(100% - 20px);padding:5px 7px;box-sizing:border-box;border:1px solid rgba(255,255,255,.18);border-radius:6px;background:rgba(0,0,0,.68);backdrop-filter:blur(4px);";
    const cropRatioLabel = document.createElement("span");
    cropRatioLabel.className = "xzg-crop-ratio-caption";
    cropRatioLabel.textContent = xzgT("裁剪比例", "Crop Ratio");
    cropRatioLabel.style.cssText = "flex:0 0 auto;padding-left:7px;padding-right:8px;border-left:2px solid #FFD700;border-right:1px solid rgba(255,255,255,.22);font-size:15px;font-weight:700;letter-spacing:.5px;line-height:1.2;color:#f2f2f2;white-space:nowrap;";
    const cropRatioOptions = document.createElement("div");
    cropRatioOptions.className = "xzg-crop-ratio-options";
    cropRatioOptions.style.cssText = "display:flex;flex-direction:row;align-items:center;gap:3px;min-width:0;overflow-x:auto;overflow-y:hidden;overscroll-behavior:contain;white-space:nowrap;";
    const cropRatioButtons = [];
    const _cropRatioMatches = (a, b) => a == null || b == null ? a == null && b == null : Math.abs(a - b) < 1e-9;
    const _selectCropRatio = (ratio) => {
        const hadPending = !!_cropPending;
        const currentBox = _cropPending || cropRect;
        _cropAspect = ratio;
        if (currentBox) {
            let w = currentBox.w, h = currentBox.h;
            if (ratio != null && w > 0 && h > 0) {
                // 保持原裁剪框面积与中心：若每次都只缩短较长边，反复切换比例会累积缩小。
                const area = currentBox.w * currentBox.h;
                w = Math.sqrt(area * ratio);
                h = Math.sqrt(area / ratio);
            }
            w = Math.max(1, Math.round(w));
            h = Math.max(1, Math.round(h));
            const cx = currentBox.x + currentBox.w / 2;
            const cy = currentBox.y + currentBox.h / 2;
            _cropPending = { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h };
            if (!hadPending && cropRect) {
                cropRect = null;
                _lastCropPreviewKey = null;
                _refreshCropPreview();
                _renderTransformPreview();
            }
        }
        refreshCropRatioUI();
        _commitCropToWidget();
        _renderMaskOverlay();
        _updateSingleResLabel();
    };
    _cropRatios.forEach(([label, ratio]) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "xzg-crop-ratio-btn";
        if (ratio == null) {
            const freeLabel = document.createElement("span");
            freeLabel.className = "xzg-crop-ratio-free";
            freeLabel.textContent = label;
            freeLabel.style.cssText = "display:inline-block;width:5ch;text-align:center;";
            button.appendChild(freeLabel);
        } else {
            const [left, right] = String(label).split(":");
            const ratioText = document.createElement("span");
            ratioText.className = "xzg-crop-ratio-text";
            ratioText.innerHTML = `<span style="text-align:right">${left}</span><span>:</span><span style="text-align:left">${right}</span>`;
            button.appendChild(ratioText);
        }
        button.style.cssText = "flex:0 0 auto;min-width:42px;padding:4px 6px;background:transparent;color:#fff;border:1px solid transparent;border-radius:4px;cursor:pointer;font-size:14px;line-height:1.2;text-align:center;white-space:nowrap;box-sizing:border-box;";
        button.addEventListener("click", (e) => {
            e.stopPropagation();
            _selectCropRatio(ratio);
        });
        cropRatioButtons.push({ button, ratio });
        cropRatioOptions.appendChild(button);
    });
    // 选中比例以高亮显示，字号比“裁剪比例”标题小 3px。
    const refreshCropRatioUI = () => {
        cropRatioLabel.textContent = xzgT("裁剪比例", "Crop Ratio");
        for (const { button, ratio } of cropRatioButtons) {
            const selected = _cropRatioMatches(ratio, _cropAspect);
            button.style.color = selected ? "#FFD700" : "#fff";
            button.style.borderColor = selected ? "#FFD700" : "transparent";
            button.style.background = selected ? "rgba(255,215,0,0.12)" : "transparent";
        }
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
    refreshCropRatioUI(); // 默认选中“自由”（_cropAspect 初始为 null）
    cropRatioRow.appendChild(cropRatioLabel);
    cropRatioRow.appendChild(cropRatioOptions);
    const cropPaddingRow = document.createElement("div");
    cropPaddingRow.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:4px;padding:3px 0;margin-top:5px;";
    const cropPaddingControlRow = document.createElement("div");
    cropPaddingControlRow.style.cssText = "display:flex;align-items:center;justify-content:center;gap:7px;width:100%;";
    const cropPaddingLabel = document.createElement("span");
    cropPaddingLabel.textContent = xzgT("填充色", "Fill Color");
    cropPaddingLabel.title = xzgT("裁剪框超出图片时使用的填充颜色", "Fill color used outside the image bounds");
    cropPaddingLabel.style.cssText = "font-size:15px;font-weight:600;color:var(--input-text);white-space:nowrap;";
    const cropPaddingSwatches = document.createElement("div");
    cropPaddingSwatches.style.cssText = "display:flex;justify-content:center;gap:6px;padding:2px 0;";
    const cropPaddingChoices = [
        ["白", "#ffffff"], ["黑", "#000000"], ["红", "#ff0000"],
        ["绿", "#00ff00"], ["蓝", "#0000ff"],
    ];
    const cropPaddingButtons = [];
    const applyCropPaddingColor = (color) => {
        _cropPaddingColor = _normalizeCropPaddingColor(color);
        cropPaddingColorInput.value = _cropPaddingColor;
        for (const item of cropPaddingButtons) {
            const selected = item.dataset.color === _cropPaddingColor;
            item.style.borderColor = selected ? "#fff" : "rgba(255,255,255,.45)";
            item.style.boxShadow = selected ? "0 0 0 1px #222" : "none";
        }
        _lastCropPreviewKey = null;
        _refreshCropPreview();
        _renderTransformPreview();
        _renderMaskOverlay();
        _commitCropToWidget();
    };
    cropPaddingChoices.forEach(([label, color]) => {
        const swatch = document.createElement("button");
        swatch.type = "button";
        swatch.title = `${label} ${color}`;
        swatch.setAttribute("aria-label", `${label} ${color}`);
        swatch.dataset.color = color;
        swatch.style.cssText = `width:16px;height:16px;min-width:16px;padding:0;border-radius:50%;background:${color};border:1px solid rgba(255,255,255,.55);cursor:pointer;`;
        swatch.addEventListener("click", (e) => { e.stopPropagation(); applyCropPaddingColor(color); });
        cropPaddingButtons.push(swatch);
        cropPaddingSwatches.appendChild(swatch);
    });
    const cropPaddingColorInput = document.createElement("input");
    cropPaddingColorInput.type = "color";
    cropPaddingColorInput.title = xzgT("自定义补边颜色", "Custom fill color");
    cropPaddingColorInput.setAttribute("aria-label", cropPaddingColorInput.title);
    cropPaddingColorInput.style.cssText = "width:34px;height:26px;padding:1px;border:1px solid var(--border-color);border-radius:4px;background:transparent;cursor:pointer;";
    cropPaddingColorInput.addEventListener("input", () => applyCropPaddingColor(cropPaddingColorInput.value));
    cropPaddingControlRow.appendChild(cropPaddingLabel);
    cropPaddingControlRow.appendChild(cropPaddingColorInput);
    const syncCropPaddingControls = () => {
        cropPaddingColorInput.value = _cropPaddingColor;
        for (const item of cropPaddingButtons) {
            const selected = item.dataset.color === _cropPaddingColor;
            item.style.borderColor = selected ? "#fff" : "rgba(255,255,255,.45)";
            item.style.boxShadow = selected ? "0 0 0 1px #222" : "none";
        }
    };
    syncCropPaddingControls();
    cropPaddingRow.appendChild(cropPaddingControlRow);
    cropPaddingRow.appendChild(cropPaddingSwatches);
    const makeTransformButton = (label, title) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.title = title;
        button.style.cssText = "padding:2px 4px;background:transparent;color:var(--input-text);border:1px solid var(--border-color);border-radius:3px;cursor:pointer;font-size:12px;white-space:nowrap;";
        return button;
    };
    const flipHorizontalBtn = makeTransformButton(xzgT("左右翻转", "Flip Horizontal"), xzgT("左右翻转图片", "Flip image horizontally"));
    const flipVerticalBtn = makeTransformButton(xzgT("上下翻转", "Flip Vertical"), xzgT("上下翻转图片", "Flip image vertically"));
    // 左右/上下翻转按钮放在裁剪比例栏右侧。
    const cropTransformGroup = document.createElement("div");
    cropTransformGroup.style.cssText = "display:flex;align-items:center;gap:4px;flex:0 0 auto;margin-left:4px;padding-left:7px;border-left:1px solid rgba(255,255,255,.2);";
    cropTransformGroup.appendChild(flipHorizontalBtn);
    cropTransformGroup.appendChild(flipVerticalBtn);
    cropRatioRow.appendChild(cropTransformGroup);
    const syncImageTransformControls = () => {
        flipHorizontalBtn.style.color = _currentImageTransform.flip_x ? "#FFD700" : "var(--input-text)";
        flipVerticalBtn.style.color = _currentImageTransform.flip_y ? "#FFD700" : "var(--input-text)";
    };
    const commitImageTransform = () => {
        const name = singleImgEl.dataset.currentName || singleImgEl.dataset.previewKey;
        if (name) _imageTransformByName[name] = { ..._currentImageTransform };
        _commitCropToWidget();
        _renderTransformPreview();
    };
    const prepareTransformTarget = () => {
        // 待选裁剪框一旦开始翻转，就先应用成当前图片状态。
        if (_cropPending) _applyCrop();
    };
    flipHorizontalBtn.addEventListener("click", (e) => {
        e.stopPropagation(); prepareTransformTarget(); _currentImageTransform.flip_x = !_currentImageTransform.flip_x;
        syncImageTransformControls(); commitImageTransform();
    });
    flipVerticalBtn.addEventListener("click", (e) => {
        e.stopPropagation(); prepareTransformTarget(); _currentImageTransform.flip_y = !_currentImageTransform.flip_y;
        syncImageTransformControls(); commitImageTransform();
    });
    maskToolbar.appendChild(cropToggleBtn);
    maskToolbar.appendChild(cropApplyBtn);
    maskToolbar.appendChild(cropClearBtn);
    maskToolbar.appendChild(cropSelClearBtn);
    maskToolbar.appendChild(cropRatioRow);
    maskToolbar.appendChild(cropPaddingRow);
    actionGroup.appendChild(maskToolbar);
    actionGroup.appendChild(safetyActionGroup);

    // 统一的显示状态同步（只在这个函数里改 overlay/eventLayer 的 pointer-events/display，避免多改冲突）
    const _syncMaskLayerVisibility = () => {
        // 编辑面显示条件：单图模式，或（多图模式下遮罩/裁剪已开启，正聚焦某张图编辑）
        // 裁剪/遮罩开启即进入编辑面（红色遮罩覆盖层 / 裁剪框可在其上绘制）
        const showSingle = uploadMode === "replace" ||
            (uploadMode === "append" && parseNameList(getImageListWidget(node)?.value).length === 1) ||
            (maskEnabled || cropEnabled);
        singleMaskOverlay.style.display = showSingle ? "block" : "none";
        singleMaskOverlay.style.pointerEvents = "none";
        if (singleCropHandlesOverlay) {
            singleCropHandlesOverlay.style.display = cropEnabled && _cropPending ? "block" : "none";
        }
        // 事件层和笔刷预览仅在绘制模式开启时显示
        const shouldEdit = showSingle && (maskEnabled || cropEnabled);
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
        // 遮罩/裁剪工具在单图与多图模式下均可用（多图下聚焦选中图）；子按钮由 editing 状态控制显示
        maskToolbar.style.display = "flex";
        const editing = maskEnabled || cropEnabled;
        // 编辑界面（遮罩/裁剪开启）：统一使用 110px 侧栏；
        // 画布态：侧栏内容自适应 + 开关按钮左对齐（预览区最大化）
        sidebar.style.width = editing ? "110px" : "auto";
        sidebar.style.minWidth = editing ? "110px" : "0";
        sidebar.classList.toggle("xzg-edit", editing);
        // 图标按钮的文字形态（lb）仅编辑态显示；画布态走图标
        maskToggleBtn.__lb.textContent = maskEnabled ? xzgT("退出", "Exit") : xzgT("遮罩", "Mask");
        maskToggleBtn.classList.toggle("xzg-edit-exit-btn", maskEnabled);
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
        cropToggleBtn.classList.toggle("xzg-crop-exit-btn", cropEnabled);
        cropToggleBtn.classList.toggle("xzg-edit-exit-btn", cropEnabled);
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
        cropApplyBtn.style.marginTop = cropEnabled ? "20px" : "";
        cropApplyBtn.style.color = cropEnabled && !maskEnabled ? "#66CC66" : "var(--input-text)"; // "应用裁剪"：绿色
        cropApplyBtn.style.borderColor = cropEnabled && !maskEnabled ? "#66CC66" : "var(--border-color)";
        brushSizeRow.style.display = vis;
        maskColorRow.style.display = vis;
        maskOutputToggleBtn.style.display = vis;
        maskCloseToggleBtn.style.display = vis;
        maskBrushBtn.style.display = vis;
        maskEraserBtn.style.display = vis;
        maskClearBtn.style.display = vis;
        maskInvertBtn.style.display = vis;
        cropClearBtn.style.display = !cropEnabled ? "none" : "";
        cropSelClearBtn.style.display = !cropEnabled ? "none" : "";
        cropRatioRow.style.display = cropEnabled && !maskEnabled ? "flex" : "none";
        cropPaddingRow.style.display = (!cropEnabled || maskEnabled) ? "none" : "";
        // 开启编辑模式时隐藏上传/.input/.output/删除/清空按钮及左下角单图/列表批次按钮，避免误操作
        const actionBtns = [uploadBtn, folderBtn, outputBtn, mediaBtn, deleteBtn, clearBtn, uploadModeBtn, modeBtn, alignBtn, maxImgInput];
        actionBtns.forEach(btn => { btn.style.display = editing ? "none" : ""; });
        safetyActionGroup.style.display = editing ? "none" : "flex";
        mediaMaskDivider.style.display = editing ? "none" : "block";
        // 编辑态结束恢复 display 后，重新同步“留边/裁剪”的占位可见性与“上限”输入框
        updateAlignBtn();
        updateMaxImgInput();
        _syncMaskLayerVisibility();
    };

    maskToggleBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const inMulti = uploadMode === "append";
        if (inMulti) {
            const names = parseNameList(getImageListWidget(node)?.value);
            if (names.length === 0) {
                xzgAlert(xzgT("请先加载图片", "Please load images first"));
                return;
            }
            const idx = Math.max(0, Math.min(getIndex(node), names.length - 1));
            setIndex(node, idx);
            if (selectedIndexes.length !== 1 || selectedIndexes[0] !== idx) {
                selectedIndexes = [idx];
                lastClickedIndex = idx;
            }
        }
        if (!maskEnabled) cropEnabled = false; // 互斥：开启遮罩即关闭裁剪
        maskEnabled = !maskEnabled;
        if (maskEnabled) {
            _editWorkspaceInitialZoomPending = true;
            _enterImageEditWorkspace();
        } else {
            _editWorkspaceInitialZoomPending = false;
            _exitImageEditWorkspace();
            _resetImgZoom();
        }
        syncImageTransformControls();
        _renderTransformPreview();
        // 编辑结束时先提交当前离屏遮罩，再切回常规预览，确保网格缩略图能读到最新数据。
        if (!maskEnabled && inMulti) _commitMaskToWidget();
        _refreshCropPreview(); // 若退出裁剪预览（切换到遮罩），恢复原图显示
        // 开启时初始化一次离屏 canvas 尺寸
        if (maskEnabled && singleImgEl.complete && singleImgEl.naturalWidth > 0) {
            const imageName = singleImgEl.dataset.currentName || singleImgEl.dataset.previewKey;
            _ensureOffscreenCanvasSize(imageName, true);
            // 多图模式的一张图会被归入 effectiveSingle 分支，但模式仍为 append；
            // 首次开启遮罩时也要从按图名存储的数据恢复到离屏 canvas。
            if (inMulti) _loadMaskFromWidget(imageName);
            _renderMaskOverlay();
        }
        _refreshMaskToolbar();
        _updateMaskCursor();
        if (inMulti) {
            redraw(true);
            const imageName = parseNameList(getImageListWidget(node)?.value)[getIndex(node)];
            if (maskEnabled && singleImgEl.complete && singleImgEl.naturalWidth > 0 &&
                (singleImgEl.dataset.currentName || singleImgEl.dataset.previewKey) === imageName) {
                _ensureOffscreenCanvasSize(imageName, true);
                _loadMaskFromWidget(imageName);
            }
            // 单张图的多图模式在常规态走 effectiveSingle；完成编辑后让 overlay
            // 在该预览面继续显示。多张图回到网格后则由卡片遮罩缩略图显示。
            _syncMaskLayerVisibility();
        }
        if (maskEnabled && singleImgEl.complete && singleImgEl.naturalWidth > 0 &&
            (!inMulti || (singleImgEl.dataset.currentName || singleImgEl.dataset.previewKey) ===
                parseNameList(getImageListWidget(node)?.value)[getIndex(node)])) {
            requestAnimationFrame(() => _applyInitialEditWorkspaceZoom());
        }
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
        _maskByImage = {};
        _writeMaskMap();
        _renderMaskOverlay();
    }
    function _syncMaskMapFromWidget() {
        const value = String(getMaskDataWidget(node)?.value || "");
        if (value === _maskWidgetSource) return value;
        _maskWidgetSource = value;
        _maskByImage = {};
        if (!value) return value;
        try {
            const parsed = JSON.parse(value);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                for (const [name, data] of Object.entries(parsed)) {
                    if (name !== "__cur" && typeof data === "string" && data) _maskByImage[name] = data;
                }
            }
        } catch (_) {}
        return value;
    }
    function _writeMaskMap() {
        const w = getMaskDataWidget(node);
        if (!w) return;
        const value = Object.keys(_maskByImage).length ? JSON.stringify(_maskByImage) : "";
        w.value = value;
        _maskWidgetSource = value;
        w.callback?.(value);
        if (node.properties) {
            if (value) node.properties.xzg_mask_data = value;
            else delete node.properties.xzg_mask_data;
        }
        if (app?.graph?.setDirtyCanvas) app.graph.setDirtyCanvas(true, true);
    }
    function _getMaskForImage(imageName) {
        const value = _syncMaskMapFromWidget();
        if (imageName && _maskByImage[imageName]) return _maskByImage[imageName];
        // 兼容旧工作流保存的单张 data URL 遮罩。
        return value.startsWith("data:") ? value : "";
    }
    function _syncMaskList() {
        const value = _syncMaskMapFromWidget();
        const activeNames = new Set(parseNameList(getImageListWidget(node)?.value));
        // 旧工作流可能把单张遮罩直接存成 data URL，而不是按图片名映射。
        // 将它绑定到原图名；若该图已被移除（含清空后同名重新加载），立即丢弃，
        // 避免旧遮罩被错误套用到新加载的图片。
        if (value.startsWith("data:")) {
            const legacyName = _maskBoundImageName || singleImgEl.dataset.currentName || singleImgEl.dataset.previewKey;
            if (legacyName && activeNames.has(legacyName)) _maskByImage[legacyName] = value;
            else _maskByImage = {};
            _writeMaskMap();
            return;
        }
        let changed = false;
        for (const name of Object.keys(_maskByImage)) {
            if (!activeNames.has(name)) {
                delete _maskByImage[name];
                changed = true;
            }
        }
        if (changed) _writeMaskMap();
    }
    function _syncCropList() {
        const activeNames = new Set(parseNameList(getImageListWidget(node)?.value));
        let changed = false;
        for (const name of Object.keys(_cropByImage)) {
            if (!activeNames.has(name)) {
                delete _cropByImage[name];
                delete _cropThumbCache[name];
                changed = true;
            }
        }
        for (const name of Object.keys(_imageTransformByName)) {
            if (!activeNames.has(name)) {
                delete _imageTransformByName[name];
                changed = true;
            }
        }
        const curName = singleImgEl.dataset.currentName || singleImgEl.dataset.previewKey;
        if (curName && !activeNames.has(curName)) {
            cropRect = null;
            _currentImageTransform = _defaultImageTransform();
            syncImageTransformControls();
            _lastCropPreviewKey = null;
            _refreshCropPreview();
            _renderTransformPreview();
            _updateSingleResLabel();
        }
        if (!changed) return;
        const widget = getCropDataWidget(node);
        if (!widget) return;
        const payload = { __cur: curName && activeNames.has(curName) ? curName : "",
            __padding_color: _cropPaddingColor, __transforms: _imageTransformByName };
        for (const name of activeNames) {
            if (_cropByImage[name]) payload[name] = _cropByImage[name];
        }
        const hasCrop = Object.keys(_cropByImage).length > 0;
        const hasTransform = Object.keys(_imageTransformByName).length > 0;
        widget.value = hasCrop || hasTransform || _cropPaddingColor !== "#ffffff" ? JSON.stringify(payload) : "";
        widget.callback?.(widget.value);
        if (node.properties) {
            if (widget.value) node.properties.xzg_crop_data = widget.value;
            else delete node.properties.xzg_crop_data;
        }
        if (app?.graph?.setDirtyCanvas) app.graph.setDirtyCanvas(true, true);
    }
    function _resetImageEditsForModeSwitch() {
        _editWorkspaceInitialZoomPending = false;
        _exitImageEditWorkspace();
        maskEnabled = false;
        cropEnabled = false;
        cropRatioRow.style.display = "none";
        _clearMaskData();

        cropRect = null;
        _cropByImage = {};
        for (const name of Object.keys(_imageTransformByName)) delete _imageTransformByName[name];
        _currentImageTransform = _defaultImageTransform();
        _cropPaddingColor = "#ffffff";
        syncCropPaddingControls(); syncImageTransformControls();
        _cropPending = null;
        _cropResizeCorner = null; _cropResizeBase = null; _cropResizeAnchorPos = null; _cropResizeFromCenter = false;
        _cropMove = false; _cropMoveStart = null; _cropMoveBase = null;
        _cropSelStart = _cropSelCur = null;
        _cropDrawing = false;
        const cropWidget = getCropDataWidget(node);
        if (cropWidget) {
            cropWidget.value = "";
            cropWidget.callback?.(cropWidget.value);
        }

        if (node.properties) {
            delete node.properties.xzg_crop_orig_size;
            delete node.properties.xzg_mask_orig_size;
            delete node.properties.xzg_crop_data;
            delete node.properties.xzg_mask_data;
        }
        _resetImgZoom();
        _refreshCropPreview();
        _renderMaskOverlay();
        _updateSingleResLabel();
        if (app?.graph?.setDirtyCanvas) app.graph.setDirtyCanvas(true, true);
    }
    function _commitCropToWidget() {
        const w = getCropDataWidget(node);
        if (!w) return;
        const curName = singleImgEl.dataset.currentName || singleImgEl.dataset.previewKey;
        // 裁剪变化 → 失效该图网格缩略图的裁剪预览缓存
        _invalidCropThumb(curName);
        // 保存当前图片的裁剪区域到映射（每张图独立维护，切换图片不丢失已有裁剪）
        if (curName) {
            if (cropRect) {
                _cropByImage[curName] = [cropRect.x, cropRect.y, cropRect.w, cropRect.h];
            } else {
                delete _cropByImage[curName];
            }
        }
        // widget 保存映射格式：{ "__cur": "当前图片名", "图片名1": [x,y,w,h], ... }
        // 后端按当前图片名从映射中提取裁剪区域；前端 _loadCropFromWidget 兼容旧格式（纯数组）
        const payload = { __cur: curName || "", __padding_color: _cropPaddingColor, __transforms: _imageTransformByName };
        for (const k in _cropByImage) payload[k] = _cropByImage[k];
        w.value = JSON.stringify(payload);
        w.options = w.options || {};
        w.options.serialize = true;
        w.callback?.(w.value);
        node.properties = node.properties || {};
        node.properties.xzg_crop_data = w.value;
        // 标记工作流已修改，确保切换工作流/保存时 crop_data widget 的最新值被序列化
        if (app?.graph?.setDirtyCanvas) app.graph.setDirtyCanvas(true, true);
    }
    function _loadCropFromWidget() {
        const w = getCropDataWidget(node);
        const s = w?.value;
        const curName = singleImgEl.dataset.currentName || singleImgEl.dataset.previewKey;
        if (!s) {
            cropRect = null; _cropPaddingColor = "#ffffff"; syncCropPaddingControls();
            _currentImageTransform = _defaultImageTransform(); syncImageTransformControls();
            _renderTransformPreview();
            return;
        }
        try {
            const v = JSON.parse(s);
            if (v && typeof v === "object" && !Array.isArray(v) && v.__padding_color) {
                _cropPaddingColor = _normalizeCropPaddingColor(v.__padding_color);
                syncCropPaddingControls();
            }
            if (v && typeof v === "object" && !Array.isArray(v) && v.__transforms && typeof v.__transforms === "object") {
                for (const [name, transform] of Object.entries(v.__transforms)) {
                    _imageTransformByName[name] = _normalizeImageTransform(transform);
                }
            }
            if (Array.isArray(v) && v.length === 4) {
                // 旧格式：纯数组 [x,y,w,h]，视为当前图片的裁剪区域
                cropRect = { x: Math.round(+v[0]), y: Math.round(+v[1]), w: Math.round(+v[2]), h: Math.round(+v[3]) };
                if (curName) _cropByImage[curName] = [cropRect.x, cropRect.y, cropRect.w, cropRect.h];
                _currentImageTransform = _normalizeImageTransform(_imageTransformByName[curName]);
                syncImageTransformControls(); _renderTransformPreview();
                return;
            }
            if (v && typeof v === 'object' && !Array.isArray(v)) {
                // 新格式：映射 { 图片名: [x,y,w,h], ... }，按当前图片名加载。
                // 注意：这里只"合并"widget 里的条目，绝不整体重置 _cropByImage——
                // 否则编辑第二张时某次 widget 暂缺第一张，会把第一张的裁剪从内存映射抹掉，
                // 随后被 _commitCropToWidget 刷回 widget，造成第一张裁剪永久丢失。
                for (const key in v) {
                    if (key === '__cur') continue;
                    if (Array.isArray(v[key]) && v[key].length === 4) {
                        _cropByImage[key] = v[key];
                    }
                }
                // 与当前图片列表对齐：仅清理已不在列表中的镜像裁剪，保留现有图片的裁剪
                try {
                    const activeNames = new Set(parseNameList(getImageListWidget(node)?.value));
                    for (const k in _cropByImage) {
                        if (!activeNames.has(k)) delete _cropByImage[k];
                    }
                } catch (_e) {}
                if (curName && _cropByImage[curName]) {
                    const a = _cropByImage[curName];
                    cropRect = { x: Math.round(+a[0]), y: Math.round(+a[1]), w: Math.round(+a[2]), h: Math.round(+a[3]) };
                } else {
                    cropRect = null;
                }
                _currentImageTransform = _normalizeImageTransform(_imageTransformByName[curName]);
                syncImageTransformControls();
                _renderTransformPreview();
                return;
            }
        } catch (_) {}
        cropRect = null;
        _currentImageTransform = _normalizeImageTransform(_imageTransformByName[curName]);
        syncImageTransformControls(); _renderTransformPreview();
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
            return { x: cropRect.x + lx / s2, y: cropRect.y + ly / s2 };
        }
        // 裁剪允许从图片外（黑边区）开始拖选：返回原图像素坐标，可超出图片边界（负值 / 超界均可）。
        // 绘制、预览和提交都保留越界坐标，输出时使用当前填充色补齐。
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
                _cropResizeFromCenter = !!e.altKey;
                _cropResizeAnchorPos = _cropResizeFromCenter
                    ? [_cropResizeBase.x + _cropResizeBase.w / 2, _cropResizeBase.y + _cropResizeBase.h / 2]
                    : _cropCornerPt(_cropResizeBase, _cropOpp(corner));
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
        _renderTransformPreview();
        _cropSelStart = _snapCropPointToImage(pt);
        _cropSelCur = { ..._cropSelStart };
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
                let nx = _cropMoveBase.x + (sp.x - _cropMoveStart.x);
                let ny = _cropMoveBase.y + (sp.y - _cropMoveStart.y);
                _cropPending = _snapCropBoxToImage({ x: nx, y: ny, w: _cropMoveBase.w, h: _cropMoveBase.h });
            }
            _renderMaskOverlay();
            return;
        }
        // 拖动裁剪框角：以固定对角为锚点重算待选框
        if (_cropResizeCorner) {
            // 用与渲染/命中同一坐标系（_cropBoxToContainer 的逆）映射拖动点，避免缩放态坐标系错乱
            const cp = _cropContainerPt(e);
            const rawPt = _cropContainerToPixel(cp);
            const corner = _cropResizeCorner;
            const pt = rawPt && _snapCropPointToImage(rawPt,
                !["t", "b"].includes(corner), !["l", "r"].includes(corner));
            if (pt) _applyCropResize(pt);
            _renderMaskOverlay();
            return;
        }
        if (!_cropDrawing) {
            const handle = _cropPending ? _cropHandleHit(e) : null;
            singleImgContainer.style.cursor = handle
                ? (["l", "r"].includes(handle) ? "ew-resize" : ["t", "b"].includes(handle) ? "ns-resize" :
                    ["tl", "br"].includes(handle) ? "nwse-resize" : "nesw-resize")
                : (_cropPendingInPoint(e) ? "move" : "crosshair");
            return;
        }
        const rawPt = _cropPxFromEvent(e);
        const pt = rawPt && _snapCropPointToImage(rawPt);
        if (pt) {
            // 保留图像显示区域之外的坐标，输出时以当前填充色补齐。
            _cropSelCur = _cropAspectAdjust(_cropSelStart.x, _cropSelStart.y, pt.x, pt.y);
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
        let X, Y, X2, Y2;
        if (_isCropPreviewActive() && cropRect) {
            const s2 = Math.min(cw / cropRect.w, ch / cropRect.h);
            const x2 = (cw - cropRect.w * s2) / 2, y2 = (ch - cropRect.h * s2) / 2;
            X = x2 + (box.x - cropRect.x) * s2;
            Y = y2 + (box.y - cropRect.y) * s2;
            X2 = x2 + (box.x + box.w - cropRect.x) * s2;
            Y2 = y2 + (box.y + box.h - cropRect.y) * s2;
        } else {
            const sc = rect.scale;
            X = rect.x + box.x * sc;
            Y = rect.y + box.y * sc;
            X2 = rect.x + (box.x + box.w) * sc;
            Y2 = rect.y + (box.y + box.h) * sc;
        }
        // 图片、遮罩与裁剪框处于同一个 CSS transform 内，命中坐标也需应用相同变换。
        const zoom = _maskImgZoom || 1;
        return {
            X: _maskTx + X * zoom, Y: _maskTy + Y * zoom,
            X2: _maskTx + X2 * zoom, Y2: _maskTy + Y2 * zoom,
        };
    }
    // 容器坐标 → 原图像素（_cropBoxToContainer 的逆运算，用于角拖动，保证与渲染/命中同一坐标系）
    function _cropContainerToPixel(pt) {
        const cw = singleImgContainer.clientWidth, ch = singleImgContainer.clientHeight;
        const rect = _getImageDisplayRect();
        const zoom = _maskImgZoom || 1;
        pt = { x: (pt.x - _maskTx) / zoom, y: (pt.y - _maskTy) / zoom };
        if (_isCropPreviewActive() && cropRect) {
            const s2 = Math.min(cw / cropRect.w, ch / cropRect.h);
            const x2 = (cw - cropRect.w * s2) / 2, y2 = (ch - cropRect.h * s2) / 2;
            // 拖角时鼠标滑出裁剪画面边缘仍继续映射，以便裁剪框越过原图边界。
            if (s2 <= 0) return null;
            return { x: cropRect.x + (pt.x - x2) / s2, y: cropRect.y + (pt.y - y2) / s2 };
        }
        if (rect.scale <= 0) return null;
        const ox = (pt.x - rect.x) / rect.scale, oy = (pt.y - rect.y) / rect.scale;
        // 指针捕获后允许继续拖到图片外；越界坐标用于按当前填充色补边。
        return { x: ox, y: oy };
    }
    // 命中检测：命中断选框的角则返回角名，否则 null
    function _cropHandleHit(e) {
        if (!_cropPending || _cropPending.w <= 0 || _cropPending.h <= 0) return null;
        const p = _cropContainerPt(e);
        const { X, Y, X2, Y2 } = _cropBoxToContainer(_cropPending);
        const t = 13; // 命中阈值（容器像素）：略大于手柄尺寸，避免鼠标略偏即未命中而落入锁定分支
        const hits = { tl: [X, Y], tr: [X2, Y], bl: [X, Y2], br: [X2, Y2] };
        let nearest = null, nearestDistance = Infinity;
        for (const k of ["tl", "tr", "bl", "br"]) {
            const cx = hits[k][0], cy = hits[k][1];
            if (Math.abs(p.x - cx) <= t && Math.abs(p.y - cy) <= t) {
                const distance = (p.x - cx) ** 2 + (p.y - cy) ** 2;
                if (distance < nearestDistance) {
                    nearest = k;
                    nearestDistance = distance;
                }
            }
        }
        // 四角命中优先；边的整段（避开角附近）均可拖拽，降低小手柄的精确点击要求。
        if (nearest) return nearest;
        const pad = Math.min(t, Math.max(0, (X2 - X) / 4), Math.max(0, (Y2 - Y) / 4));
        if (p.y >= Y + pad && p.y <= Y2 - pad) {
            if (Math.abs(p.x - X) <= t) return "l";
            if (Math.abs(p.x - X2) <= t) return "r";
        }
        if (p.x >= X + pad && p.x <= X2 - pad) {
            if (Math.abs(p.y - Y) <= t) return "t";
            if (Math.abs(p.y - Y2) <= t) return "b";
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
    // 在独立于图片缩放层的画布上绘制手柄，使其屏幕尺寸不受图片缩放影响。
    function _drawCropHandles(ctx, X, Y, X2, Y2) {
        const containerRect = singleImgContainer.getBoundingClientRect();
        const outerScaleX = Math.max(0.01, singleImgContainer.clientWidth > 0 ? containerRect.width / singleImgContainer.clientWidth : 1);
        const outerScaleY = Math.max(0.01, singleImgContainer.clientHeight > 0 ? containerRect.height / singleImgContainer.clientHeight : 1);
        const scaleX = 1 / outerScaleX;
        const scaleY = 1 / outerScaleY;
        ctx.save();
        ctx.strokeStyle = "#FF3030";
        ctx.globalAlpha = 1;
        ctx.shadowColor = "rgba(0,0,0,0.95)";
        ctx.shadowBlur = 3 / Math.max(outerScaleX, outerScaleY);
        ctx.lineWidth = 2.5 / Math.max(outerScaleX, outerScaleY);
        ctx.lineCap = "square";
        const corners = [
            { x: X, y: Y, sx: -1, sy: -1 },
            { x: X2, y: Y, sx: 1, sy: -1 },
            { x: X, y: Y2, sx: -1, sy: 1 },
            { x: X2, y: Y2, sx: 1, sy: 1 },
        ];
        for (const corner of corners) {
            ctx.save();
            ctx.translate(corner.x, corner.y);
            ctx.scale(corner.sx * scaleX, corner.sy * scaleY);
            // 与编组框图标的 M12 2 L2 12 M8 12 H12 V8 形状一致，以角点为锚。
            ctx.beginPath();
            ctx.moveTo(0, -10);
            ctx.lineTo(-10, 0);
            ctx.moveTo(-4, 0);
            ctx.lineTo(0, 0);
            ctx.lineTo(0, -4);
            ctx.stroke();
            ctx.restore();
        }
        // 边缘中点手柄：Photoshop 风格的小方块，尺寸随显示缩放保持稳定。
        const mids = [
            [(X + X2) / 2, Y], [X2, (Y + Y2) / 2],
            [(X + X2) / 2, Y2], [X, (Y + Y2) / 2],
        ];
        const hx = 5 / outerScaleX, hy = 5 / outerScaleY;
        ctx.shadowBlur = 2 / Math.max(outerScaleX, outerScaleY);
        ctx.fillStyle = "#FF3030";
        ctx.strokeStyle = "#FFFFFF";
        ctx.lineWidth = 1.5 / Math.max(outerScaleX, outerScaleY);
        for (const [mx, my] of mids) {
            ctx.fillRect(mx - hx, my - hy, hx * 2, hy * 2);
            ctx.strokeRect(mx - hx, my - hy, hx * 2, hy * 2);
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
    function _cropImageBounds() {
        if (_isCropPreviewActive() && cropRect) {
            return { left: cropRect.x, top: cropRect.y, right: cropRect.x + cropRect.w, bottom: cropRect.y + cropRect.h };
        }
        const w = _maskImgNaturalW || singleImgEl.naturalWidth || 0;
        const h = _maskImgNaturalH || singleImgEl.naturalHeight || 0;
        return w > 0 && h > 0 ? { left: 0, top: 0, right: w, bottom: h } : null;
    }
    function _cropSnapTolerance() {
        const containerRect = singleImgContainer.getBoundingClientRect();
        const outerX = containerRect.width / (singleImgContainer.clientWidth || 1);
        const outerY = containerRect.height / (singleImgContainer.clientHeight || 1);
        const preview = _isCropPreviewActive() ? _cropPreviewDisplayRect() : null;
        const scaleX = (preview?.s2 || _getImageDisplayRect().scale) * (_maskImgZoom || 1) * outerX;
        const scaleY = (preview?.s2 || _getImageDisplayRect().scale) * (_maskImgZoom || 1) * outerY;
        return { x: scaleX > 0 ? 10 / scaleX : 0, y: scaleY > 0 ? 10 / scaleY : 0 };
    }
    function _snapCropPointToImage(pt, snapX = true, snapY = true) {
        const bounds = _cropImageBounds();
        if (!bounds || !pt) return pt;
        const tolerance = _cropSnapTolerance();
        let x = pt.x, y = pt.y;
        if (snapX) {
            const edge = [bounds.left, bounds.right].sort((a, b) => Math.abs(a - x) - Math.abs(b - x))[0];
            if (Math.abs(edge - x) <= tolerance.x) x = edge;
        }
        if (snapY) {
            const edge = [bounds.top, bounds.bottom].sort((a, b) => Math.abs(a - y) - Math.abs(b - y))[0];
            if (Math.abs(edge - y) <= tolerance.y) y = edge;
        }
        return { x, y };
    }
    function _snapCropBoxToImage(box) {
        const bounds = _cropImageBounds();
        if (!bounds || !box) return box;
        const tolerance = _cropSnapTolerance();
        const dxCandidates = [bounds.left - box.x, bounds.right - box.x,
            bounds.left - (box.x + box.w), bounds.right - (box.x + box.w)];
        const dyCandidates = [bounds.top - box.y, bounds.bottom - box.y,
            bounds.top - (box.y + box.h), bounds.bottom - (box.y + box.h)];
        const dx = dxCandidates.sort((a, b) => Math.abs(a) - Math.abs(b))[0];
        const dy = dyCandidates.sort((a, b) => Math.abs(a) - Math.abs(b))[0];
        return { ...box, x: box.x + (Math.abs(dx) <= tolerance.x ? dx : 0), y: box.y + (Math.abs(dy) <= tolerance.y ? dy : 0) };
    }
    function _applyCropResize(pt) {
        const c = _cropResizeCorner, a = _cropResizeAnchorPos;
        const r = _cropAspect;
        const MIN = 3; // 最小边（像素），与提交时的下限一致
        if (["l", "r", "t", "b"].includes(c) && _cropResizeBase) {
            const base = _cropResizeBase;
            let x = base.x, y = base.y, w = base.w, h = base.h;
            if (_cropResizeFromCenter) {
                const cx = base.x + base.w / 2, cy = base.y + base.h / 2;
                if (c === "l" || c === "r") {
                    w = Math.max(MIN, Math.abs(pt.x - cx) * 2);
                    if (r) {
                        h = Math.max(MIN, w / r);
                        if (h === MIN) w = h * r;
                        y = cy - h / 2;
                    }
                    x = cx - w / 2;
                } else {
                    h = Math.max(MIN, Math.abs(pt.y - cy) * 2);
                    if (r) {
                        w = Math.max(MIN, h * r);
                        if (w === MIN) h = w / r;
                        x = cx - w / 2;
                    }
                    y = cy - h / 2;
                }
                _cropPending = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
                return;
            }
            if (c === "l" || c === "r") {
                const fixedX = c === "l" ? base.x + base.w : base.x;
                const wantedW = c === "l" ? fixedX - pt.x : pt.x - fixedX;
                w = Math.max(MIN, wantedW);
                if (r) {
                    const centerY = base.y + base.h / 2;
                    h = w / r;
                    y = centerY - h / 2;
                }
                x = c === "l" ? fixedX - w : fixedX;
            } else {
                const fixedY = c === "t" ? base.y + base.h : base.y;
                const wantedH = c === "t" ? fixedY - pt.y : pt.y - fixedY;
                h = Math.max(MIN, wantedH);
                if (r) {
                    const centerX = base.x + base.w / 2;
                    w = h * r;
                    h = w / r;
                    x = centerX - w / 2;
                }
                y = c === "t" ? fixedY - h : fixedY;
            }
            _cropPending = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
            return;
        }
        // 移动角相对锚点的方向（由拖动开始时的角位置决定，拖动中不允许越过锚点反向）
        const dirX = (c === "tr" || c === "br") ? 1 : -1;
        const dirY = (c === "bl" || c === "br") ? 1 : -1;
        if (_cropResizeFromCenter) {
            const cx = a[0], cy = a[1];
            let w = Math.max(MIN, Math.abs(pt.x - cx) * 2);
            let h = Math.max(MIN, Math.abs(pt.y - cy) * 2);
            if (r) {
                if (w >= h * r) h = Math.max(MIN, w / r);
                else w = Math.max(MIN, h * r);
                if (w / h > r) w = h * r;
                else h = w / r;
            }
            const x = cx - w / 2, y = cy - h / 2;
            _cropPending = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
            return;
        }
        // 防翻转：先把鼠标点钳制到锚点的正确一侧（至少留 MIN 距离）再做比例调整。
        // 否则移动角越过对角锚点后，min/max 归一化会让选框跳到对侧；
        // 固定比例时 _cropAspectAdjust 的符号推断还会把另一条边甩到反方向，加剧翻转
        const mx = dirX > 0 ? Math.max(pt.x, a[0] + MIN) : Math.min(pt.x, a[0] - MIN);
        const my = dirY > 0 ? Math.max(pt.y, a[1] + MIN) : Math.min(pt.y, a[1] - MIN);
        const adj = _cropAspectAdjust(a[0], a[1], mx, my);
        // 尺寸 = 移动角沿拖动方向到锚点的绝对距离（钳制后必为正且同侧）
        let w = Math.abs(adj.x - a[0]);
        let h = Math.abs(adj.y - a[1]);
        w = Math.max(MIN, w);
        h = Math.max(MIN, h);
        // 从锚点沿拖动方向展开出选框（锚点恒为选框的一个角，不翻转）
        const x = dirX > 0 ? a[0] : a[0] - w;
        const y = dirY > 0 ? a[1] : a[1] - h;
        _cropPending = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
    }
    function _commitCropSelection() {
        if (_cropSelStart && _cropSelCur) {
            const x0 = Math.min(_cropSelStart.x, _cropSelCur.x);
            const y0 = Math.min(_cropSelStart.y, _cropSelCur.y);
            const x1 = Math.max(_cropSelStart.x, _cropSelCur.x);
            const y1 = Math.max(_cropSelStart.y, _cropSelCur.y);
            const cx = Math.round(x0);
            const cy = Math.round(y0);
            const cw = Math.max(1, Math.round(x1) - cx);
            const ch = Math.max(1, Math.round(y1) - cy);
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
        _refreshCropPreview(); // 应用后保留当前缩放和平移视图
        _renderTransformPreview();
        _renderMaskOverlay();
        _updateSingleResLabel();
    }
    // 裁剪结果预览机制见 _refreshCropPreview：把裁剪区域绘制到独立画布并隐藏原图，替代 transform 缩放方案
    function _onCropPointerUp(e) {
        if (!cropEnabled) return;
        const wasResizing = _cropResizeCorner;
        _cropResizeCorner = null; _cropResizeBase = null; _cropResizeAnchorPos = null; _cropResizeFromCenter = false;
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

    // 裁剪开关 / 清空（仅单图模式可用）
    cropToggleBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const inMulti = uploadMode === "append";
        if (inMulti) {
            // 多图模式下裁剪编辑聚焦到当前选中的那张图（index widget 已由卡片点击同步）
            const names = parseNameList(getImageListWidget(node)?.value);
            if (names.length === 0) {
                xzgAlert(xzgT("请先加载图片", "Please load images first"));
                return;
            }
            const idx = Math.max(0, Math.min(getIndex(node), names.length - 1));
            setIndex(node, idx); // 确保编辑目标索引明确
            if (selectedIndexes.length !== 1 || selectedIndexes[0] !== idx) {
                selectedIndexes = [idx];
                lastClickedIndex = idx;
            }
        }
        if (!cropEnabled && maskEnabled) maskEnabled = false; // 互斥：开启裁剪即关闭遮罩
        cropEnabled = !cropEnabled;
        cropRatioRow.style.display = cropEnabled ? "flex" : "none";
        syncImageTransformControls();
        _renderTransformPreview();
        // 打开裁剪模式：立即清除现有遮罩信息（裁剪与遮罩不同坐标系，避免残留错位）
        if (cropEnabled) {
            _clearMaskData();
        }
        if (cropEnabled) {
            _editWorkspaceInitialZoomPending = true;
            _enterImageEditWorkspace();
        } else {
            _editWorkspaceInitialZoomPending = false;
            _exitImageEditWorkspace();
            _resetImgZoom();
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
            _renderTransformPreview();
            _updateSingleResLabel();
        }
        _refreshMaskToolbar();
        _renderMaskOverlay();
        // 多图模式下：进入裁剪需 redraw 切到单图编辑面；布局完成后按聚焦图重新加载并显示裁剪
        //（早前 _loadCropFromWidget 用的是旧 currentName，须等 redraw 绑定目标图后再跑）
        if (inMulti) {
            redraw(true);
            if (cropEnabled) {
                _loadCropFromWidget();
                _renderMaskOverlay();
                if (cropRect) {
                    _resetImgZoom();
                    _refreshCropPreview();
                    _updateSingleResLabel();
                }
            }
        }
        const cropTargetName = inMulti
            ? parseNameList(getImageListWidget(node)?.value)[getIndex(node)]
            : null;
        if (cropEnabled && singleImgEl.complete && singleImgEl.naturalWidth > 0 &&
            (!inMulti || (singleImgEl.dataset.currentName || singleImgEl.dataset.previewKey) === cropTargetName)) {
            requestAnimationFrame(() => _applyInitialEditWorkspaceZoom());
        }
    });
    function _restoreOriginalCrop() {
        if (!cropEnabled) return;
        const currentName = singleImgEl.dataset.currentName || singleImgEl.dataset.previewKey;
        cropRect = null;
        _cropPending = null;
        _currentImageTransform = _defaultImageTransform();
        if (currentName) delete _imageTransformByName[currentName];
        _cropResizeCorner = null; _cropResizeBase = null; _cropResizeAnchorPos = null;
        _cropMove = false; _cropMoveStart = null; _cropMoveBase = null;
        _cropSelStart = _cropSelCur = null;
        _cropAspect = null;
        refreshCropRatioUI();
        syncImageTransformControls();
        _commitCropToWidget();
        // 恢复原始 = 裁剪状态变化：遮罩是相对裁剪画面绘制的，一并清除
        _clearMaskData();
        _resetCropView(); // 恢复整图，并回到裁剪界面默认的 80% 视图
        _refreshCropPreview();
        _renderTransformPreview();
        syncImageTransformControls();
        _renderMaskOverlay();
        _updateSingleResLabel();
    }
    cropClearBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        _restoreOriginalCrop();
    });

    // 清除当前选框：仅移除待选框（_cropPending），保持已应用裁剪的状态不变
    cropSelClearBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!cropEnabled) return;
        _cropPending = null;
        _cropMove = false; _cropMoveStart = null; _cropMoveBase = null;
        _cropSelStart = _cropSelCur = null;
        _renderTransformPreview();
        _renderMaskOverlay(); // 只刷新选框显示
    });

    const _cropEscapeHandler = (e) => {
        if (e.key !== "Escape" || !cropEnabled) return;
        if (!_cropPending && !_cropDrawing) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        _cropPending = null;
        _cropDrawing = false;
        _cropSelStart = _cropSelCur = null;
        _cropResizeCorner = null; _cropResizeBase = null; _cropResizeAnchorPos = null; _cropResizeFromCenter = false;
        _cropMove = false; _cropMoveStart = null; _cropMoveBase = null;
        _renderTransformPreview();
        _renderMaskOverlay();
    };
    window.addEventListener("keydown", _cropEscapeHandler, true);

    // 应用裁剪按钮：直接把当前选框应用（等同右键"应用裁剪"）
    cropApplyBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!cropEnabled || !_cropPending) return;
        _applyCrop();
    });

    sidebar.addEventListener("dblclick", (e) => {
        if (e.target.closest("select")) return;
        if (e.target.closest("button")) return;
        if (e.target.closest("input")) return;
        e.preventDefault();
        e.stopPropagation();
        openUploadDialog();
    });

    let lastNames = null;
    let lastCardSize = null;
    let selectedIndexes = [];
    let lastClickedIndex = -1;
    const mainContent = document.createElement("div");
    mainContent.style.cssText = "flex:1;display:flex;flex-direction:column;pointer-events:auto;min-width:0;min-height:120px;position:relative;overflow:visible;";
    mainContent.style.userSelect = "none";
    mainContent.style.webkitUserSelect = "none";

    const grid = document.createElement("div");
    grid.style.cssText =
        "display:grid;gap:2px;flex:1;min-width:0;min-height:0;overflow:hidden;background:transparent;padding:0;border-radius:2px;align-content:center;justify-content:center;transition:opacity 0.3s ease;";
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
            @keyframes xzgDragSortGlow {
                0%, 100% { box-shadow: 0 0 7px var(--xzg-sort-color); }
                50% { box-shadow: 0 0 18px var(--xzg-sort-color); }
            }
        `;
        document.head.appendChild(style);
    }

    const emptyTip = document.createElement("div");
    emptyTip.style.cssText =
        "flex:1;display:flex;align-items:flex-start;justify-content:flex-start;background:transparent;border-radius:4px;color:var(--input-text);font-size:8px;opacity:0.55;min-height:40px;padding:6px 4px 4px;box-sizing:border-box;";
    emptyTip.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:5px;width:100%;max-width:280px;font-size:8px;color:var(--input-text);line-height:1.35;">
            <div style="text-align:left;font-size:9px;font-weight:bold;margin-bottom:1px;opacity:0.85;padding-left:12px;">${xzgTh("小珠光图像加载器-化神级", "Xiaozhuguang Image Loader - Godlike")}</div>

            <div style="display:flex;flex-direction:column;gap:1px;">
                <div style="font-weight:bold;opacity:0.75;">${xzgTh("📁 添加图片", "📁 Add Images")}</div>
                <div style="opacity:0.5;padding-left:12px;">${xzgTh("点击上传或双击预览区；支持多选", "Click Upload or double-click preview; multi-select supported")}</div>
                <div style="opacity:0.5;padding-left:12px;">${xzgTh(".input 从输入文件夹选择", ".input Select from input folder")}</div>
                <div style="opacity:0.5;padding-left:12px;">${xzgTh(".output 从输出文件夹选择", ".output Select from output folder")}</div>
                <div style="opacity:0.5;padding-left:12px;">${xzgTh("多图模式可继续追加；单图模式会替换当前图片", "Multi mode appends images; Single mode replaces the current image")}</div>
            </div>

            <div style="display:flex;flex-direction:column;gap:1px;">
                <div style="font-weight:bold;opacity:0.75;">${xzgTh("🖱️ 鼠标操作", "🖱️ Mouse Operations")}</div>
                <div style="opacity:0.5;padding-left:12px;">${xzgTh("左键点击选中；Shift范围选；Ctrl+左键多选，Ctrl+拖动框选", "Click to select; Shift-click for range; Ctrl-click to multi-select, Ctrl-drag to marquee-select")}</div>
                <div style="opacity:0.5;padding-left:12px;">${xzgTh("右键缩略图 → 菜单最下方「查看原图」；滚轮缩放、拖动平移", "Right-click a thumbnail → View Original Image at the bottom; wheel to zoom, drag to pan")}</div>
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
                <div style="opacity:0.5;padding-left:12px;">${xzgTh("遮罩：画笔绘制、橡皮擦除；退出后预览区保留半透明红色遮罩", "Mask: Paint or erase; the translucent red overlay stays in preview after Exit")}</div>
                <div style="opacity:0.5;padding-left:12px;">${xzgTh("裁剪：拖拽选区后点【应用裁剪】或双击；支持自由/固定比例", "Crop: Drag a region, then Apply Crop or double-click; free/fixed ratios supported")}</div>
                <div style="opacity:0.5;padding-left:12px;">${xzgTh("退出后预览显示裁剪结果并标记「已裁剪」；删除/清空图片会清除该图编辑数据", "After Exit, preview shows the crop with a Cropped badge; deleting/clearing an image removes its edits")}</div>
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

    const singleCropBadge = document.createElement("div");
    singleCropBadge.className = "xzg-img-cropbadge";
    singleCropBadge.textContent = xzgT("已裁剪", "Cropped");
    singleCropBadge.style.cssText =
        "position:absolute;left:auto;right:12px;top:12px;transform:none;z-index:10;pointer-events:none;font-weight:700;line-height:1.2;" +
        "color:#FFD700;background:rgba(255,215,0,0.20);border:1px solid rgba(255,215,0,0.55);border-radius:5px;padding:6px 14px;font-size:20px;display:none;";

    // 当前单图的原始分辨率（通过 /xzg_image_info API 获取，与压缩预览图分离）
    let _singleOrigW = 0, _singleOrigH = 0;

    function _updateSingleCropBadge() {
        if (cropEnabled) {
            // 裁剪界面保留现有的大号右上角角标样式。
            singleCropBadge.style.cssText =
                "position:absolute;left:auto;right:12px;top:12px;bottom:auto;transform:none;z-index:10;pointer-events:none;font-weight:700;line-height:1.2;" +
                "color:#FFD700;background:rgba(255,215,0,0.20);border:1px solid rgba(255,215,0,0.55);border-radius:5px;padding:6px 14px;font-size:20px;";
        } else {
            // 节点常规单图预览与网格缩略图统一：右下角、暗色半透明底、按卡片尺寸缩放字号。
            singleCropBadge.style.cssText =
                "position:absolute;left:auto;right:1px;top:auto;bottom:1px;transform:none;z-index:10;pointer-events:none;font-weight:600;line-height:1.15;" +
                "color:#ffd54a;background:rgba(0,0,0,0.65);border:0;border-radius:2px 0 0 0;";
            const cardSize = getCardSize(node);
            singleCropBadge.style.fontSize = "16px";
            singleCropBadge.style.padding = `${Math.max(0, Math.round(cardSize * 0.006))}px ${Math.max(1, Math.round(cardSize * 0.015))}px`;
        }
        singleCropBadge.style.display = cropRect ? "block" : "none";
    }

    function _updateSingleResLabel() {
        _updateSingleCropBadge();
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
        requestAnimationFrame(() => _renderTransformPreview());
    };
    singleImgContainer.appendChild(singleImgEl);
    singleImgContainer.appendChild(singleResLabel);
    singleImgContainer.appendChild(singleCropBadge);

    // 遮罩显示/绘制层：覆盖在图片之上，尺寸与 singleImgContainer 一致
    // 图片在容器内 object-fit:contain，我们需要计算图片实际显示矩形以正确映射坐标
    const singleMaskOverlay = document.createElement("canvas");
    singleMaskOverlay.style.cssText = "position:absolute;inset:0;z-index:2;display:none;pointer-events:none;";
    singleMaskOverlay.width = 1;
    singleMaskOverlay.height = 1;
    singleImgContainer.appendChild(singleMaskOverlay);

    // 裁剪角标独立于 singleImgInner，避免图片缩放 transform 改变手柄显示尺寸。
    const singleCropHandlesOverlay = document.createElement("canvas");
    singleCropHandlesOverlay.style.cssText = "position:absolute;inset:0;z-index:6;display:none;pointer-events:none;";
    singleCropHandlesOverlay.width = 1;
    singleCropHandlesOverlay.height = 1;
    singleImgContainer.appendChild(singleCropHandlesOverlay);
    const singleCropPaddingOverlay = document.createElement("canvas");
    singleCropPaddingOverlay.style.cssText = "position:absolute;inset:0;z-index:5;display:none;pointer-events:none;";
    singleCropPaddingOverlay.width = 1;
    singleCropPaddingOverlay.height = 1;
    singleImgContainer.appendChild(singleCropPaddingOverlay);

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
    // 将比例栏叠放在预览区上缘，不挤压图片区域；只在裁剪界面显示。
    mainContent.insertBefore(cropRatioRow, singleImgContainer);

    // 包装层：用于图片缩放（CSS transform），包裹图片和所有遮罩层
    const singleImgInner = document.createElement("div");
    singleImgInner.style.cssText = "position:absolute;inset:0;transform-origin:0 0;";
    // 将 singleImgEl 和遮罩层移入包装层
    singleImgContainer.appendChild(singleImgInner);
    singleImgInner.appendChild(singleImgEl);
    // 裁剪结果预览画布：应用裁剪后显示裁剪画面（object-fit:contain 自适应放大），替代原图
    // 必须 absolute 定位（脱离文档流），否则会与原图在流内垂直堆叠、画布被挤到容器下方
    const singleCropPreviewCanvas = document.createElement("canvas");
    // 保留裁剪结果画布的固有宽高比：明确设置 width/height 为 100% 会在部分节点布局下把画布拉伸。
    singleCropPreviewCanvas.style.cssText = "position:absolute;left:50%;top:50%;width:auto;height:auto;max-width:100%;max-height:100%;object-fit:contain;transform:translate(-50%,-50%);display:none;z-index:2;";
    singleImgInner.appendChild(singleCropPreviewCanvas);
    const singleTransformPreviewCanvas = document.createElement("canvas");
    singleTransformPreviewCanvas.style.cssText = "position:absolute;left:50%;top:50%;width:auto;height:auto;max-width:100%;max-height:100%;object-fit:contain;transform:translate(-50%,-50%);display:none;z-index:3;pointer-events:none;";
    singleImgInner.appendChild(singleTransformPreviewCanvas);
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
            cropRect.x + "_" + cropRect.y + "_" + cropRect.w + "_" + cropRect.h + "|" + _cropPaddingColor;
        if (_lastCropPreviewKey === key) return; // 同图同选区已绘制，跳过
        // 直接读当前 img 的自然尺寸（必须已解码完成，避免画空白）
        const iw = singleImgEl.naturalWidth || 0;
        const ih = singleImgEl.naturalHeight || 0;
        if (iw <= 0 || ih <= 0 || !singleImgEl.complete) return;
        const sx = Math.max(0, cropRect.x);
        const sy = Math.max(0, cropRect.y);
        const ex = Math.min(iw, cropRect.x + cropRect.w);
        const ey = Math.min(ih, cropRect.y + cropRect.h);
        const cw2 = Math.max(0, ex - sx), ch2 = Math.max(0, ey - sy);
        _lastCropPreviewKey = key;
        singleCropPreviewCanvas.width = cropRect.w;
        singleCropPreviewCanvas.height = cropRect.h;
        const cctx = singleCropPreviewCanvas.getContext("2d");
        cctx.fillStyle = _cropPaddingColor;
        cctx.fillRect(0, 0, cropRect.w, cropRect.h);
        try {
            cctx.imageSmoothingEnabled = true;
            cctx.imageSmoothingQuality = "high";
            if (cw2 > 0 && ch2 > 0) {
                cctx.drawImage(singleImgEl, sx, sy, cw2, ch2,
                    sx - cropRect.x, sy - cropRect.y, cw2, ch2);
            }
        } catch (_) {}
        singleCropPreviewCanvas.style.display = "block";
        singleImgEl.style.visibility = "hidden"; // 隐藏原图，视窗内只剩裁剪画面
    }

    function _transformSourceCanvas() {
        if (cropRect && singleCropPreviewCanvas.width > 0 && singleCropPreviewCanvas.height > 0) return singleCropPreviewCanvas;
        return singleImgEl.complete && singleImgEl.naturalWidth > 0 ? singleImgEl : null;
    }

    function _renderTransformPreview() {
        if (!singleTransformPreviewCanvas) return;
        const cropTransformPreview = cropEnabled && !_cropPending && !_cropDrawing && !maskEnabled;
        if (maskEnabled || (cropEnabled && !cropTransformPreview)) {
            singleTransformPreviewCanvas.style.display = "none";
            if (cropRect) {
                singleCropPreviewCanvas.style.visibility = "";
                singleImgEl.style.visibility = "hidden";
            } else singleImgEl.style.visibility = "";
            return;
        }
        const t = _currentImageTransform;
        const active = t.flip_x || t.flip_y;
        if (!active) {
            singleTransformPreviewCanvas.style.display = "none";
            singleCropPreviewCanvas.style.visibility = "";
            if (cropRect) singleImgEl.style.visibility = "hidden";
            else singleImgEl.style.visibility = "";
            return;
        }
        const source = _transformSourceCanvas();
        if (!source) return;
        // HTMLImageElement.width/height 是 CSS 显示尺寸；翻转绘制必须使用原图像素尺寸。
        // canvas 没有 naturalWidth/naturalHeight，回退到它自身的像素尺寸即可。
        const sw = source.naturalWidth || source.width, sh = source.naturalHeight || source.height;
        if (!sw || !sh) return;
        singleTransformPreviewCanvas.width = sw;
        singleTransformPreviewCanvas.height = sh;
        const ctx = singleTransformPreviewCanvas.getContext("2d");
        ctx.clearRect(0, 0, sw, sh);
        ctx.translate(t.flip_x ? sw : 0, t.flip_y ? sh : 0);
        ctx.scale(t.flip_x ? -1 : 1, t.flip_y ? -1 : 1);
        ctx.drawImage(source, 0, 0, sw, sh);
        singleTransformPreviewCanvas.style.display = "block";
        singleTransformPreviewCanvas.style.visibility = "visible";
        singleCropPreviewCanvas.style.visibility = cropRect ? "hidden" : "";
        singleImgEl.style.visibility = "hidden";
    }

    function _viewPointerDown(e) {
        // 编辑界面中键或 Ctrl+左键平移预览；裁剪状态下优先于裁剪框绘制/拖拽。
        if (cropEnabled && _imageEditWorkspace && (e.button === 1 || (e.button === 0 && e.ctrlKey))) {
            const p = _cropContainerPt(e);
            e.preventDefault(); e.stopImmediatePropagation();
            _viewPanDrag = { pointerId: e.pointerId, x: p.x, y: p.y, tx: _maskTx, ty: _maskTy };
            singleImgContainer.style.cursor = "grabbing";
            try { singleImgContainer.setPointerCapture(e.pointerId); } catch (_) {}
            return;
        }
    }

    function _viewPointerMove(e) {
        if (_viewPanDrag && _viewPanDrag.pointerId === e.pointerId) {
            e.preventDefault(); e.stopImmediatePropagation();
            const p = _cropContainerPt(e), drag = _viewPanDrag;
            _maskTx = drag.tx + p.x - drag.x;
            _maskTy = drag.ty + p.y - drag.y;
            singleImgInner.style.transformOrigin = "0 0";
            singleImgInner.style.transform = `matrix(${_maskImgZoom}, 0, 0, ${_maskImgZoom}, ${_maskTx}, ${_maskTy})`;
            _renderMaskOverlay();
            _renderBrushPreview();
            return;
        }
    }

    function _viewPointerUp(e) {
        if (_viewPanDrag && _viewPanDrag.pointerId === e.pointerId) {
            e.preventDefault(); e.stopImmediatePropagation();
            _viewPanDrag = null;
            singleImgContainer.style.cursor = "crosshair";
            try { singleImgContainer.releasePointerCapture(e.pointerId); } catch (_) {}
            return;
        }
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
        // 图片与越界补色有独立绘制层，缩放后需同步重绘。
        _renderMaskOverlay();
    }

    // 重置图片缩放
    function _resetImgZoom() {
        _maskImgZoom = 1;
        _maskTx = 0;
        _maskTy = 0;
        singleImgInner.style.transform = "";
        singleImgInner.style.transformOrigin = "";
        _renderMaskOverlay();
    }

    // 裁剪界面的重置视图回到进入时的 80% 视图，不把预览铺满整个区域。
    function _resetCropView() {
        _resetImgZoom();
        const cw = singleImgContainer.clientWidth;
        const ch = singleImgContainer.clientHeight;
        if (cw > 0 && ch > 0) _applyImgZoom(cw / 2, ch / 2, 0.8);
        _renderTransformPreview();
    }

    function _applyInitialEditWorkspaceZoom(retry = 0) {
        if (!_editWorkspaceInitialZoomPending || !(cropEnabled || maskEnabled) || !_imageEditWorkspace) return;
        const cw = singleImgContainer.clientWidth;
        const ch = singleImgContainer.clientHeight;
        if (cw <= 0 || ch <= 0) {
            if (retry < 12) requestAnimationFrame(() => _applyInitialEditWorkspaceZoom(retry + 1));
            return;
        }
        _editWorkspaceInitialZoomPending = false;
        _resetImgZoom();
        _applyImgZoom(cw / 2, ch / 2, 0.8);
        _renderMaskOverlay();
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
        // 圆心超出预览图边界时不再丢弃：返回真实（允许越界）的离屏坐标，
        // 交由 Canvas 自动裁剪，笔刷圆与图片相交的部分仍能被正确绘制。
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

    function _renderCropHandlesOverlay() {
        if (!singleCropHandlesOverlay) return;
        const cw = singleImgContainer.clientWidth;
        const ch = singleImgContainer.clientHeight;
        const active = cropEnabled && !_cropDrawing && _cropPending && cw > 0 && ch > 0;
        singleCropHandlesOverlay.style.display = active ? "block" : "none";
        if (!active) return;
        const rect = singleImgContainer.getBoundingClientRect();
        const outerScaleX = rect.width / cw || 1;
        const outerScaleY = rect.height / ch || 1;
        const renderScale = Math.max(1, Math.min(4, (window.devicePixelRatio || 1) * Math.max(outerScaleX, outerScaleY)));
        const bw = Math.max(1, Math.round(cw * renderScale));
        const bh = Math.max(1, Math.round(ch * renderScale));
        singleCropHandlesOverlay.style.width = cw + "px";
        singleCropHandlesOverlay.style.height = ch + "px";
        if (singleCropHandlesOverlay.width !== bw || singleCropHandlesOverlay.height !== bh) {
            singleCropHandlesOverlay.width = bw;
            singleCropHandlesOverlay.height = bh;
        }
        const ctx = singleCropHandlesOverlay.getContext("2d");
        ctx.setTransform(renderScale, 0, 0, renderScale, 0, 0);
        ctx.clearRect(0, 0, cw, ch);
        const { X, Y, X2, Y2 } = _cropBoxToContainer(_cropPending);
        _drawCropHandles(ctx, X, Y, X2, Y2);
    }

    // 越界补色独立于图片的缩放层绘制，避免 transform/裁切导致上下补色被图片层盖住。
    function _renderCropPaddingOverlay() {
        if (!singleCropPaddingOverlay) return;
        const cw = singleImgContainer.clientWidth, ch = singleImgContainer.clientHeight;
        const hasBox = cropEnabled && ( _cropDrawing && _cropSelStart && _cropSelCur || _cropPending );
        if (!hasBox || cw <= 0 || ch <= 0) {
            singleCropPaddingOverlay.style.display = "none";
            return;
        }
        const rect = _getImageDisplayRect();
        let bounds, box;
        if (_isCropPreviewActive() && cropRect) {
            const preview = _cropPreviewDisplayRect();
            if (!preview) { singleCropPaddingOverlay.style.display = "none"; return; }
            bounds = { x: preview.x2, y: preview.y2, w: preview.vw, h: preview.vh };
            if (_cropDrawing && _cropSelStart && _cropSelCur) {
                box = { x: Math.min(_cropSelStart.x, _cropSelCur.x), y: Math.min(_cropSelStart.y, _cropSelCur.y),
                    w: Math.abs(_cropSelCur.x - _cropSelStart.x), h: Math.abs(_cropSelCur.y - _cropSelStart.y) };
            } else box = _cropPending;
            const toX = px => bounds.x + (px - cropRect.x) * preview.s2;
            const toY = py => bounds.y + (py - cropRect.y) * preview.s2;
            box = { x: toX(box.x), y: toY(box.y), x2: toX(box.x + box.w), y2: toY(box.y + box.h) };
        } else {
            if (rect.scale <= 0) { singleCropPaddingOverlay.style.display = "none"; return; }
            bounds = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
            if (_cropDrawing && _cropSelStart && _cropSelCur) {
                box = { x: Math.min(_cropSelStart.x, _cropSelCur.x), y: Math.min(_cropSelStart.y, _cropSelCur.y),
                    w: Math.abs(_cropSelCur.x - _cropSelStart.x), h: Math.abs(_cropSelCur.y - _cropSelStart.y) };
            } else box = _cropPending;
            box = { x: rect.x + box.x * rect.scale, y: rect.y + box.y * rect.scale,
                x2: rect.x + (box.x + box.w) * rect.scale, y2: rect.y + (box.y + box.h) * rect.scale };
        }
        const zoom = _maskImgZoom || 1;
        const tx = x => _maskTx + x * zoom, ty = y => _maskTy + y * zoom;
        const X = tx(box.x), Y = ty(box.y), X2 = tx(box.x2), Y2 = ty(box.y2);
        const bx = tx(bounds.x), by = ty(bounds.y), bx2 = tx(bounds.x + bounds.w), by2 = ty(bounds.y + bounds.h);
        const containerRect = singleImgContainer.getBoundingClientRect();
        const outerScaleX = containerRect.width / cw || 1, outerScaleY = containerRect.height / ch || 1;
        const renderScale = Math.max(1, Math.min(4, (window.devicePixelRatio || 1) * Math.max(outerScaleX, outerScaleY)));
        const bw = Math.max(1, Math.round(cw * renderScale)), bh = Math.max(1, Math.round(ch * renderScale));
        singleCropPaddingOverlay.style.width = cw + "px";
        singleCropPaddingOverlay.style.height = ch + "px";
        if (singleCropPaddingOverlay.width !== bw || singleCropPaddingOverlay.height !== bh) {
            singleCropPaddingOverlay.width = bw;
            singleCropPaddingOverlay.height = bh;
        }
        singleCropPaddingOverlay.style.display = "block";
        const ctx = singleCropPaddingOverlay.getContext("2d");
        ctx.setTransform(renderScale, 0, 0, renderScale, 0, 0);
        ctx.clearRect(0, 0, cw, ch);
        ctx.fillStyle = _cropPaddingColor;
        const iy1 = Math.max(Y, by), iy2 = Math.min(Y2, by2);
        const topH = Math.max(0, Math.min(Y2, by) - Y), bottomY = Math.max(Y, by2), bottomH = Math.max(0, Y2 - bottomY);
        if (topH > 0) ctx.fillRect(X, Y, X2 - X, topH);
        if (bottomH > 0) ctx.fillRect(X, bottomY, X2 - X, bottomH);
        if (iy2 > iy1) {
            const leftW = Math.max(0, Math.min(X2, bx) - X), rightX = Math.max(X, bx2), rightW = Math.max(0, X2 - rightX);
            if (leftW > 0) ctx.fillRect(X, iy1, leftW, iy2 - iy1);
            if (rightW > 0) ctx.fillRect(rightX, iy1, rightW, iy2 - iy1);
        }
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
        // canvas 会随图片缩放而被 CSS 放大；提高其 backing resolution 可避免裁剪框和角标变糊。
        // 限制到 4 倍，避免大节点、高缩放时创建过大的临时画布。
        const containerRect = singleImgContainer.getBoundingClientRect();
        const outerScaleX = singleImgContainer.clientWidth > 0 ? containerRect.width / singleImgContainer.clientWidth : 1;
        const outerScaleY = singleImgContainer.clientHeight > 0 ? containerRect.height / singleImgContainer.clientHeight : 1;
        const renderScale = Math.max(1, Math.min(4,
            (window.devicePixelRatio || 1) * (_maskImgZoom || 1) * Math.max(outerScaleX, outerScaleY)));
        const backingWidth = Math.max(1, Math.round(cw * renderScale));
        const backingHeight = Math.max(1, Math.round(ch * renderScale));
        if (singleMaskOverlay.width !== backingWidth || singleMaskOverlay.height !== backingHeight) {
            singleMaskOverlay.width = backingWidth;
            singleMaskOverlay.height = backingHeight;
        }
        const octx = singleMaskOverlay.getContext("2d");
        octx.setTransform(renderScale, 0, 0, renderScale, 0, 0);
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
                const X = toX(bx);
                const Y = toY(by);
                const X2 = toX(bx + bw);
                const Y2 = toY(by + bh);
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
                octx.lineWidth = 1;
                octx.strokeRect(X + 0.5, Y + 0.5, Math.max(0, X2 - X) - 1, Math.max(0, Y2 - Y) - 1);
                octx.restore();
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
                const X = toX(bx);
                const Y = toY(by);
                const X2 = toX(bx + bw);
                const Y2 = toY(by + bh);
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
                octx.lineWidth = 1;
                octx.strokeRect(X + 0.5, Y + 0.5, Math.max(0, X2 - X) - 1, Math.max(0, Y2 - Y) - 1);
                octx.restore();
            }
        }

        _renderCropHandlesOverlay();
        _renderCropPaddingOverlay();
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
        const [maskR, maskG, maskB] = _maskPreviewRgb();
        for (let i = 0; i < sd.length; i += 4) {
            const v = sd[i]; // R 通道 = 遮罩强度
            dd[i] = maskR;
            dd[i + 1] = maskG;
            dd[i + 2] = maskB;
            dd[i + 3] = Math.floor(v * 0.25); // A = 遮罩强度 * 25% 透明度
        }
        tctx.putImageData(dst, 0, 0);
        const cp = _isCropPreviewActive() ? _cropPreviewDisplayRect() : null;
        if (cp) {
            // 裁剪预览中的遮罩仅绘制与原图相交的区域，留出的补边区域保持白色。
            const sx = Math.max(0, cropRect.x), sy = Math.max(0, cropRect.y);
            const ex = Math.min(maskOffscreen.width, cropRect.x + cropRect.w);
            const ey = Math.min(maskOffscreen.height, cropRect.y + cropRect.h);
            const sw = Math.max(0, ex - sx), sh = Math.max(0, ey - sy);
            if (sw > 0 && sh > 0) {
                const dx = cp.x2 + (sx - cropRect.x) / cropRect.w * cp.vw;
                const dy = cp.y2 + (sy - cropRect.y) / cropRect.h * cp.vh;
                const dw = sw / cropRect.w * cp.vw;
                const dh = sh / cropRect.h * cp.vh;
                octx.drawImage(tmp, sx, sy, sw, sh, dx, dy, dw, dh);
            }
        } else {
            octx.drawImage(tmp, rect.x, rect.y, rect.w, rect.h);
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

    function _closeAndFillMaskStroke() {
        const points = _maskStrokePoints;
        if (!maskCloseEnabled || points.length < 3 || maskTool !== "brush" || _maskRightErasing) return;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const pt of points) {
            minX = Math.min(minX, pt.x); minY = Math.min(minY, pt.y);
            maxX = Math.max(maxX, pt.x); maxY = Math.max(maxY, pt.y);
        }
        const diagonal = Math.hypot(maxX - minX, maxY - minY);
        const gap = Math.hypot(points[points.length - 1].x - points[0].x, points[points.length - 1].y - points[0].y);
        const cp = _isCropPreviewActive() ? _cropPreviewDisplayRect() : null;
        const displayScale = cp ? cp.s2 : (_getImageDisplayRect().scale || 1);
        const brushRadius = Math.max(0.5, brushSize / (2 * displayScale));
        // 仅把首尾已经接近的闭合轮廓当作圈选，避免普通开放笔划被大面积误填充。
        if (diagonal < brushRadius * 4 || gap > Math.max(brushRadius * 4, diagonal * 0.18)) return;

        _maskDrawSegment(points[points.length - 1], points[0]);
        maskOffCtx.save();
        maskOffCtx.globalCompositeOperation = "source-over";
        maskOffCtx.fillStyle = "rgba(255,0,0,1)";
        maskOffCtx.beginPath();
        maskOffCtx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) maskOffCtx.lineTo(points[i].x, points[i].y);
        maskOffCtx.closePath();
        maskOffCtx.fill();
        maskOffCtx.restore();
    }

    // 序列化离屏遮罩为 base64 PNG（数据 URL），保存到 widget
    function _commitMaskToWidget() {
        const imageName = _maskBoundImageName;
        if (!imageName || maskOffscreen.width <= 0 || maskOffscreen.height <= 0) return;
        const out = document.createElement("canvas");
        out.width = maskOffscreen.width;
        out.height = maskOffscreen.height;
        const octx = out.getContext("2d");
        const src = maskOffCtx.getImageData(0, 0, out.width, out.height);
        const dst = octx.createImageData(out.width, out.height);
        const sd = src.data, dd = dst.data;
        let hasMask = false;
        for (let i = 0; i < sd.length; i += 4) {
            const v = sd[i];
            dd[i] = v; dd[i + 1] = v; dd[i + 2] = v; dd[i + 3] = 255;
            if (v) hasMask = true;
        }
        if (!hasMask) {
            delete _maskByImage[imageName];
            _writeMaskMap();
            return;
        }
        octx.putImageData(dst, 0, 0);
        try {
            _maskByImage[imageName] = out.toDataURL("image/png");
            _writeMaskMap();
        } catch (e) {
            console.warn("[小珠光图像加载器] 遮罩序列化失败:", e);
        }
    }

    // 从 widget 加载已有遮罩到离屏 canvas
    function _loadMaskFromWidget(imageName) {
        const data = _getMaskForImage(imageName);
        if (!data) {
            // 无保存数据 → 清空
            if (maskOffscreen.width > 0 && maskOffscreen.height > 0) {
                maskOffCtx.clearRect(0, 0, maskOffscreen.width, maskOffscreen.height);
            }
            _renderMaskOverlay();
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

    function _reloadCurrentMaskFromWidget() {
        _syncMaskMapFromWidget();
        const imageName = singleImgEl.dataset.currentName || singleImgEl.dataset.previewKey;
        if (!imageName || !singleImgEl.complete || singleImgEl.naturalWidth <= 0) return;
        _ensureOffscreenCanvasSize(imageName, false);
        _loadMaskFromWidget(imageName);
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
        _maskStrokePoints = (maskTool === "brush" && !_maskRightErasing) ? [{ x: pt.x, y: pt.y }] : [];
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
        if (maskCloseEnabled && maskTool === "brush" && !_maskRightErasing) {
            _maskStrokePoints.push({ x: pt.x, y: pt.y });
        }
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
            // pointerup 可能先于最后一次 pointermove 到达，把终点也纳入路径。
            if (e.type !== "pointercancel") {
                const rect = singleImgContainer.getBoundingClientRect();
                const zoomX = singleImgContainer.clientWidth > 0 ? rect.width / singleImgContainer.clientWidth : 1;
                const zoomY = singleImgContainer.clientHeight > 0 ? rect.height / singleImgContainer.clientHeight : 1;
                const innerPt = _containerPtToInner((e.clientX - rect.left) / zoomX, (e.clientY - rect.top) / zoomY);
                const endPt = _overlayPtToOffscreen(innerPt.x, innerPt.y);
                if (endPt && _maskLastPt && (endPt.x !== _maskLastPt.x || endPt.y !== _maskLastPt.y)) {
                    _maskDrawSegment(_maskLastPt, endPt);
                    if (maskCloseEnabled && maskTool === "brush" && !_maskRightErasing) {
                        _maskStrokePoints.push({ x: endPt.x, y: endPt.y });
                    }
                    _maskLastPt = endPt;
                }
            }
            if (e.type !== "pointercancel") _closeAndFillMaskStroke();
            _maskDrawing = false;
            _maskLastPt = null;
            _maskStrokePoints = [];
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
                _maskStrokePoints = [];
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
    singleImgContainer.addEventListener("pointerdown", _viewPointerDown, true);
    singleImgContainer.addEventListener("pointermove", _viewPointerMove, true);
    singleImgContainer.addEventListener("pointerup", _viewPointerUp, true);
    singleImgContainer.addEventListener("pointercancel", _viewPointerUp, true);
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
            _renderTransformPreview();
        }
    });
    _maskResizeObserver.observe(singleImgContainer);

    // 图片加载完成后 → 初始化离屏 canvas、尝试加载保存的遮罩
    singleImgEl.addEventListener("load", () => {
        const curName = singleImgEl.dataset.currentName || singleImgEl.dataset.previewKey;
        if (!_editWorkspaceInitialZoomPending) _resetImgZoom();
        _ensureOffscreenCanvasSize(curName, false);
        _loadMaskFromWidget(curName);
        // 从 widget 加载裁剪数据，并刷新裁剪结果预览（load 后 naturalWidth 已更新）
        _loadCropFromWidget();
        _refreshCropPreview();
        _renderTransformPreview();
        _renderMaskOverlay();
        _updateMaskCursor();
        _applyInitialEditWorkspaceZoom();
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
        const delBtnSize = Math.round(cardSize * 0.12);
        const delBtnFont = Math.round(delBtnSize * 0.93);
        delBtn.style.width = `${delBtnSize}px`;
        delBtn.style.height = `${delBtnSize}px`;
        delBtn.style.fontSize = `${delBtnFont}px`;
    };

    // 多图顺序徽标：左上角展示 1 起始的加载/输出顺序，随缩略图一起缩放。
    const _applyIndexBadgeSize = (badge, cardSize) => {
        if (!badge) return;
        badge.style.fontSize = `${Math.max(6, Math.round(cardSize * 0.10))}px`;
        badge.style.padding = `${Math.max(0, Math.round(cardSize * 0.012))}px ${Math.max(2, Math.round(cardSize * 0.03))}px`;
    };

    // 多图「已裁剪」角标：右下角展示，随缩略图一起缩放。
    const _applyCropBadgeSize = (badge, cardSize) => {
        if (!badge) return;
        badge.style.fontSize = `${Math.max(6, Math.round(cardSize * 0.05))}px`;
        badge.style.padding = `${Math.max(0, Math.round(cardSize * 0.006))}px ${Math.max(1, Math.round(cardSize * 0.015))}px`;
    };

    const resizeObserver = new ResizeObserver(() => {
        if (resizeRaf) cancelAnimationFrame(resizeRaf);
        resizeRaf = requestAnimationFrame(() => {
            const allNames = parseNameList(getImageListWidget(node)?.value || "");
            // 加载上限联动：自适应尺寸按"实际显示的前 N 张"计算，避免缩略图被隐藏图片挤压变小
            const limit = getMaxImagesLimit(node);
            const names = limit > 0 ? allNames.slice(0, limit) : allNames;
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
                            _applyIndexBadgeSize(cell.querySelector(".xzg-img-index"), finalSize);
                            _applyCropBadgeSize(cell.querySelector(".xzg-img-cropbadge"), finalSize);
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
                            _applyIndexBadgeSize(cell.querySelector(".xzg-img-index"), finalSize);
                            _applyCropBadgeSize(cell.querySelector(".xzg-img-cropbadge"), finalSize);
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
    const DRAG_SORT_SCALE = 1.15;
    const LONG_PRESS_ANIM_MS = 150;

    const openImageLightbox = (imageName) => {
        if (!imageName) return;
        const overlay = document.createElement("div");
        overlay.style.cssText = "position:fixed;inset:0;z-index:200000;background:rgba(0,0,0,0.88);display:flex;align-items:center;justify-content:center;overflow:hidden;";
        const stage = document.createElement("div");
        stage.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;overflow:hidden;cursor:grab;touch-action:none;";
        const image = document.createElement("img");
        image.src = getOriginalImageUrl(imageName);
        image.alt = imageName;
        image.draggable = false;
        image.style.cssText = "position:relative;display:block;max-width:92vw;max-height:92vh;width:auto;height:auto;object-fit:contain;user-select:none;transform-origin:center center;";
        let zoom = 1, tx = 0, ty = 0, dragging = false, startX = 0, startY = 0, baseX = 0, baseY = 0;
        const updateImage = () => { image.style.transform = `translate(${tx}px,${ty}px) scale(${zoom})`; };
        const onMove = (ev) => {
            if (!dragging) return;
            tx = baseX + ev.clientX - startX;
            ty = baseY + ev.clientY - startY;
            updateImage();
        };
        const onUp = () => { dragging = false; stage.style.cursor = "grab"; };
        const onKeyDown = (ev) => { if (ev.key === "Escape") close(); };
        const close = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
            window.removeEventListener("keydown", onKeyDown, true);
            overlay.remove();
        };
        const closeBtn = document.createElement("button");
        closeBtn.type = "button";
        closeBtn.textContent = "×";
        closeBtn.title = xzgT("关闭（Esc）", "Close (Esc)");
        closeBtn.style.cssText = "position:absolute;top:16px;right:18px;z-index:2;width:38px;height:38px;border:0;border-radius:50%;background:rgba(40,40,40,0.8);color:#fff;font-size:28px;line-height:1;cursor:pointer;";
        closeBtn.addEventListener("click", close);
        const hint = document.createElement("div");
        hint.textContent = `${imageName}  ·  ${xzgT("滚轮缩放，拖动平移，Esc 关闭", "Wheel to zoom, drag to pan, Esc to close")}`;
        hint.style.cssText = "position:absolute;left:50%;bottom:14px;transform:translateX(-50%);z-index:2;max-width:85vw;padding:6px 10px;border-radius:4px;background:rgba(0,0,0,0.6);color:#fff;font-size:12px;text-align:center;pointer-events:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
        stage.appendChild(image);
        overlay.append(stage, closeBtn, hint);
        overlay.addEventListener("mousedown", (ev) => {
            if (ev.target === overlay) close();
        });
        overlay.addEventListener("contextmenu", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            close();
        });
        stage.addEventListener("wheel", (ev) => {
            ev.preventDefault();
            const before = zoom;
            zoom = Math.max(0.1, Math.min(12, zoom * (ev.deltaY < 0 ? 1.15 : 1 / 1.15)));
            const anchorX = ev.clientX - window.innerWidth / 2 - tx;
            const anchorY = ev.clientY - window.innerHeight / 2 - ty;
            tx -= anchorX * (zoom / before - 1);
            ty -= anchorY * (zoom / before - 1);
            updateImage();
        }, { passive: false });
        stage.addEventListener("mousedown", (ev) => {
            if (ev.button !== 0) return;
            dragging = true;
            startX = ev.clientX; startY = ev.clientY; baseX = tx; baseY = ty;
            stage.style.cursor = "grabbing";
            ev.preventDefault();
        });
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        window.addEventListener("keydown", onKeyDown, true);
        document.body.appendChild(overlay);
    };

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
        const cell = e.target.closest("[data-xzg-img-card]");
        const preserveCanvasSelection = !!(cell && (e.ctrlKey || e.metaKey));
        const selectionBeforeThumbnailClick = preserveCanvasSelection
            ? captureCanvasSelection(app?.canvas)
            : null;
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
        let moved = false;

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

        // 按下时立即高亮目标卡片。多选/范围选择期间保留既有选中项的边框，避免闪烁。
        if (cell && cardInner) {
            cardInner.style.transition = "none";
            cardInner.style.borderColor = getSelColor();
            if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
                // 普通单选时立即清除其余卡片；组合键选择时要保留原有高亮。
                const allCards = grid.querySelectorAll("[data-xzg-img-card]");
                allCards.forEach((c) => {
                    if (c === cell) return;
                    const card = c.querySelector(":scope > div");
                    if (card) {
                        card.style.transition = "none";
                        card.style.borderColor = "transparent";
                    }
                });
            }
        }

        const enterMarqueeMode = () => {
            mode = "marquee";
            marquee.style.display = "block";
            if (cell && cardInner) {
                cardInner.style.transform = "";
                cardInner.style.boxShadow = "";
                cardInner.style.transition = "";
                cell.style.zIndex = "";
                cell.style.overflow = "hidden";
            }
        };

        const enterSortMode = () => {
            if (clickedIndex < 0 || !cell) return;
            mode = "sort";
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
                gCard.style.transformOrigin = "center center";
                // 预览卡整体缩放，内部的编号与删除 X 会同步参与动画。
                gCard.style.transition = `transform ${LONG_PRESS_ANIM_MS}ms ease-out`;
                gCard.style.transform = "scale(1)";
                gCard.style.boxShadow = `0 4px 16px rgba(0,0,0,0.4), 0 0 8px ${selColor}`;
            }
            // 原卡片的 X 只在悬停时显示；拖拽预览中始终显示，让它和编号一起缩放。
            const ghostDeleteButton = ghost.querySelector(".del-btn");
            if (ghostDeleteButton) ghostDeleteButton.style.opacity = "1";
            document.body.appendChild(ghost);
            requestAnimationFrame(() => {
                if (gCard?.isConnected && !dragSortState?.hasLeftOrigin) {
                    gCard.style.transform = `scale(${DRAG_SORT_SCALE})`;
                }
            });

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
                    card.style.borderColor = ci === clickedIndex ? getSelColor() : "transparent";
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
                hasLeftOrigin: false,
                lastReorderAt: 0,
                cellRect,
            };

            selectedIndexes = [clickedIndex];
            lastClickedIndex = clickedIndex;
            setIndex(node, clickedIndex);
        };

        // Ctrl/Command + 左键拖动始终进入框选；普通卡片内拖动仍用于调整排序，
        // 从卡片空隙拖动则保持原有框选方式。
        const forceMarquee = e.ctrlKey || e.metaKey;
        if (!cell || forceMarquee) enterMarqueeMode();

        const onMouseMove = (moveE) => {
            const dx = moveE.clientX - startX;
            const dy = moveE.clientY - startY;
            if (Math.max(Math.abs(dx), Math.abs(dy)) > DRAG_CLICK_THRESHOLD) {
                moved = true;
            }
            if (!moved) return;

            if (!mode) {
                if (cell) enterSortMode();
                else enterMarqueeMode();
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
                        card.style.borderColor = selectedIndexes.includes(i) ? color : "transparent";
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
                    // 鼠标带着卡片离开原位后，拖拽预览缩到 70% 并持续高亮。
                    if (!dragSortState.hasLeftOrigin) {
                        dragSortState.hasLeftOrigin = true;
                        gCard.style.setProperty("--xzg-sort-color", selColor);
                        gCard.style.transform = "scale(0.7)";
                        gCard.style.animation = "xzgDragSortGlow 420ms ease-in-out infinite";
                    }
                }

                const ghostRect = dragSortState.ghost.getBoundingClientRect();
                const ghostCx = ghostRect.left + ghostRect.width / 2;
                const ghostCy = ghostRect.top + ghostRect.height / 2;

                const cards = grid.querySelectorAll("[data-xzg-img-card]");
                let targetCard = null;

                for (let i = 0; i < cards.length; i++) {
                    const c = cards[i];
                    if (c.style.opacity === "0.3") continue;
                    // 排队动画期间 getBoundingClientRect 会返回视觉中的过渡位置，
                    // 这里必须使用重排后的稳定格子位置，避免指针反复命中相邻卡片。
                    const r = c._xzgStaticRect || c.getBoundingClientRect();
                    if (ghostCx >= r.left && ghostCx <= r.right &&
                        ghostCy >= r.top && ghostCy <= r.bottom) {
                        targetCard = c;
                        break;
                    }
                }

                if (targetCard && !dragSortState.animating) {
                    const currentCard = cards[dragSortState.currentIndex];
                    if (targetCard === currentCard) return;

                    // 快速掠过多个卡片时不叠加重排动画，避免画面抖动。
                    const now = performance.now();
                    if (now - dragSortState.lastReorderAt < 120) return;
                    dragSortState.lastReorderAt = now;

                    dragSortState.animating = true;
                    const cardsArr = Array.from(cards);
                    // 每次重排前先结束上一轮位移动画，避免累积位移造成跳动。
                    cardsArr.forEach((item) => {
                        if (item._xzgQueueTimer) clearTimeout(item._xzgQueueTimer);
                        item.style.transition = "none";
                        item.style.transform = "";
                    });
                    void grid.offsetWidth;
                    // FLIP：记录旧位置，DOM 重排后让其它卡片平滑滑向新位置。
                    const previousRects = new Map(cardsArr.map((item) => [item, item.getBoundingClientRect()]));

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

                    newCards.forEach((c) => {
                        if (c === draggedEl) return;
                        const before = previousRects.get(c);
                        const after = c.getBoundingClientRect();
                        c._xzgStaticRect = after;
                        if (!before) return;
                        const deltaX = before.left - after.left;
                        const deltaY = before.top - after.top;
                        if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) return;
                        c.style.transition = "none";
                        c.style.transformOrigin = "center center";
                        c.style.transform = `translate(${deltaX}px, ${deltaY}px)`;
                        requestAnimationFrame(() => {
                            c.style.transition = "transform 300ms cubic-bezier(0.42, 0, 0.25, 1)";
                            c.style.transform = "translate(0, 0)";
                            c._xzgQueueTimer = setTimeout(() => {
                                c.style.transition = "";
                                c.style.transform = "";
                            }, 320);
                        });
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
                const droppedIndex = sortState.currentIndex;

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
                    delete c._xzgStaticRect;
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
                        // 放下后从拖动中的 70% 状态恢复正常尺寸。
                        const droppedCard = cells[droppedIndex]?.querySelector(":scope > div");
                        if (droppedCard) {
                            const sortColor = getSelColor();
                            droppedCard.style.borderColor = sortColor;
                            droppedCard.style.boxShadow = `0 0 14px ${sortColor}`;
                            droppedCard.style.transition = `transform ${LONG_PRESS_ANIM_MS}ms ease-out, border-color ${LONG_PRESS_ANIM_MS}ms ease-out, box-shadow ${LONG_PRESS_ANIM_MS}ms ease-out`;
                            droppedCard.style.transform = "scale(0.7)";
                            requestAnimationFrame(() => { droppedCard.style.transform = "scale(1)"; });
                            setTimeout(() => {
                                droppedCard.style.transition = "";
                                droppedCard.style.borderColor = "";
                                droppedCard.style.boxShadow = "";
                                droppedCard.style.transform = "";
                            }, LONG_PRESS_ANIM_MS + 30);
                        }
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
                } else if (forceMarquee && cell && clickedIndex >= 0) {
                    // Ctrl/Command 左键单击切换多选；按住拖动仍在上面的 moved 分支执行框选。
                    const selectedAt = selectedIndexes.indexOf(clickedIndex);
                    if (selectedAt >= 0) {
                        // 仅单选时 Ctrl 再点当前缩略图不应清空选择；
                        // 真正进入多选后，才允许通过 Ctrl/Command 点击取消其中一张。
                        if (selectedIndexes.length > 1) selectedIndexes.splice(selectedAt, 1);
                    } else {
                        selectedIndexes.push(clickedIndex);
                        selectedIndexes.sort((a, b) => a - b);
                    }
                    lastClickedIndex = clickedIndex;
                    setIndex(node, clickedIndex);
                    const cards = grid.querySelectorAll("[data-xzg-img-card]");
                    const color = getSelColor();
                    cards.forEach((c, i) => {
                        const card = c.querySelector(":scope > div");
                        if (card) card.style.borderColor = selectedIndexes.includes(i) ? color : "transparent";
                    });
                    redraw(false);
                } else {
                    selectedIndexes = [];
                    lastClickedIndex = -1;
                    const cards = grid.querySelectorAll("[data-xzg-img-card]");
                    cards.forEach((c) => {
                        const card = c.querySelector(":scope > div");
                        if (card) {
                            card.style.borderColor = "transparent";
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
                            card.style.borderColor = isSelected ? color : "transparent";
                        }
                    });
                } else if (e.ctrlKey || e.metaKey) {
                    const idx = selectedIndexes.indexOf(clickedIndex);
                    if (idx >= 0) {
                        if (selectedIndexes.length > 1) selectedIndexes.splice(idx, 1);
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
                            card.style.borderColor = isSelected ? color : "transparent";
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
                            card.style.borderColor = i === clickedIndex ? color : "transparent";
                        }
                    });
                    if (app?.canvas) app.canvas.setDirty(true, true);
                }
            }

            // 组合键缩略图选择时保留原有画布节点，并把当前图片加载器加入选区。
            // 在本监听器结束后再恢复，避免 LiteGraph 在同一次鼠标事件中清除 A 节点。
            if (preserveCanvasSelection && selectionBeforeThumbnailClick) {
                setTimeout(() => restoreCanvasSelection(app?.canvas, selectionBeforeThumbnailClick, node), 0);
            }

        };

        const onContextMenu = (ev) => {
            ev.preventDefault();
        };

        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
        document.addEventListener("contextmenu", onContextMenu, true);
    });
    // ═══════════ 网格缩略图裁剪预览 ═══════════
    // 对图片名存在裁剪区域的卡片，把缩略图换成「裁剪后」画面并打角标。
    // 裁剪矩形 `_cropByImage[name]` = [x,y,w,h]，坐标为「压缩预览(最长边3840)」空间的像素，
    // 与 getPreviewUrl 返回的预览自然尺寸一致，可直接按预览自然坐标裁剪，无需额外换算。
    const _cropThumbCache = {};   // name -> { k: crop特征串, u: 已生成裁剪缩略图 dataURL }
    function _invalidCropThumb(name) { if (name) _cropThumbCache[name] = null; }
    function _gridHasCrop(name) { return Array.isArray(_cropByImage[name]) && _cropByImage[name].length === 4; }
    function _applyMaskThumb(card, name, cardSize) {
        const data = _getMaskForImage(name);
        if (!data) return;
        const [maskR, maskG, maskB] = _maskPreviewRgb();
        const overlay = document.createElement("canvas");
        overlay.className = "xzg-img-mask-thumb";
        overlay.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none;z-index:2;";
        overlay.width = Math.max(1, Math.round(cardSize * 2));
        overlay.height = Math.max(1, Math.round(cardSize * 2));
        const img = new Image();
        img.onload = () => {
            if (!overlay.isConnected) return;
            const ctx = overlay.getContext("2d", { willReadFrequently: true });
            const crop = _cropByImage[name];
            const preview = new Image();
            preview.onload = () => {
                if (!overlay.isConnected) return;
                const hasCrop = Array.isArray(crop) && crop.length === 4 && crop[2] > 0 && crop[3] > 0;
                const [cx, cy, cw, ch] = hasCrop ? crop : [0, 0, preview.naturalWidth, preview.naturalHeight];
                const sx = cx * img.naturalWidth / preview.naturalWidth;
                const sy = cy * img.naturalHeight / preview.naturalHeight;
                const sw = cw * img.naturalWidth / preview.naturalWidth;
                const sh = ch * img.naturalHeight / preview.naturalHeight;
                const scale = Math.min(overlay.width / cw, overlay.height / ch);
                const dw = Math.max(1, Math.round(cw * scale));
                const dh = Math.max(1, Math.round(ch * scale));
                const left = Math.round((overlay.width - dw) / 2);
                const top = Math.round((overlay.height - dh) / 2);
                const maskCanvas = document.createElement("canvas");
                maskCanvas.width = dw;
                maskCanvas.height = dh;
                const mctx = maskCanvas.getContext("2d", { willReadFrequently: true });
                mctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);
                const pixels = mctx.getImageData(0, 0, dw, dh);
                for (let i = 0; i < pixels.data.length; i += 4) {
                    const strength = pixels.data[i];
                    pixels.data[i] = maskR;
                    pixels.data[i + 1] = maskG;
                    pixels.data[i + 2] = maskB;
                    pixels.data[i + 3] = Math.round(strength * 0.25);
                }
                mctx.putImageData(pixels, 0, 0);
                ctx.clearRect(0, 0, overlay.width, overlay.height);
                ctx.drawImage(maskCanvas, left, top);
            };
            preview.onerror = () => {
                const dw = Math.max(1, overlay.width), dh = Math.max(1, Math.round(dw * img.naturalHeight / img.naturalWidth));
                overlay.width = dw; overlay.height = dh;
                ctx.drawImage(img, 0, 0, dw, dh);
                const pixels = ctx.getImageData(0, 0, dw, dh);
                for (let i = 0; i < pixels.data.length; i += 4) {
                    const strength = pixels.data[i];
                    pixels.data[i] = maskR; pixels.data[i + 1] = maskG; pixels.data[i + 2] = maskB;
                    pixels.data[i + 3] = Math.round(strength * 0.25);
                }
                ctx.putImageData(pixels, 0, 0);
            };
            preview.src = getPreviewUrl(name);
        };
        img.onerror = () => overlay.remove();
        img.src = data;
        card.appendChild(overlay);
    }
    function _applyCropThumb(imgEl, name) {
        const rect = _cropByImage[name];
        if (!Array.isArray(rect) || rect.length !== 4 || !imgEl) return;
        const [cx, cy, cw, ch] = rect;
        if (!(cw > 0 && ch > 0)) return;
        const key = name + "|" + rect.join(",") + "|" + _cropPaddingColor;
        const cached = _cropThumbCache[name];
        if (cached && cached.k === key && cached.u) {
            // 裁剪未变：网格重建后生成的是全新的 <img>（src 为未裁剪缩略图），
            // 必须把缓存的裁剪 preview 同步回填到新元素，否则会被误判为"第一张裁剪丢失"
            imgEl.src = cached.u;
            return;
        }
        const prev = document.createElement("img");
        prev.onload = () => {
            if (_cropThumbCache[name]?.k !== key) return; // 期间已变化，丢弃
            const pw = prev.naturalWidth, ph = prev.naturalHeight;
            if (!pw || !ph) return;
            const s = 720 / Math.max(cw, ch);
            const ow = Math.max(1, Math.round(cw * s));
            const oh = Math.max(1, Math.round(ch * s));
            const cv = document.createElement("canvas");
            cv.width = ow; cv.height = oh;
            const ctx = cv.getContext("2d");
            // 按裁剪框自身坐标绘制原图与选区的交集；越界部分保留补色，不能把交集拉伸铺满。
            ctx.fillStyle = _cropPaddingColor;
            ctx.fillRect(0, 0, ow, oh);
            const sx0 = Math.max(0, cx), sy0 = Math.max(0, cy);
            const sx1 = Math.min(pw, cx + cw), sy1 = Math.min(ph, cy + ch);
            if (sx1 > sx0 && sy1 > sy0) {
                const dx = (sx0 - cx) * ow / cw;
                const dy = (sy0 - cy) * oh / ch;
                const dw = (sx1 - sx0) * ow / cw;
                const dh = (sy1 - sy0) * oh / ch;
                ctx.drawImage(prev, sx0, sy0, sx1 - sx0, sy1 - sy0, dx, dy, dw, dh);
            }
            // 填充色需与后端输出逐像素一致，避免 JPEG 有损压缩改变纯色边缘。
            const url = cv.toDataURL("image/png");
            _cropThumbCache[name] = { k: key, u: url };
            imgEl.dataset.cropped = "1";
            imgEl.src = url;
        };
        prev.onerror = () => { _cropThumbCache[name] = null; };
        _cropThumbCache[name] = { k: key, u: null };
        prev.src = getPreviewUrl(name);
    }

    const redraw = (forceFull = false) => {
        const allNames = parseNameList(getImageListWidget(node)?.value);
        // 加载上限联动：预览区与后端输出保持一致，>0 时仅显示前 N 张
        const limit = getMaxImagesLimit(node);
        const names = limit > 0 ? allNames.slice(0, limit) : allNames;
        const cardSize = getCardSize(node);
        const idx = getIndex(node);

        // 始终从 widget 同步真实值，防止闭包变量 uploadMode 在 onConfigure 之前被初始化
        // 为 "append" 后永远无法被更新（redraw 是调用最频繁的入口，这里最为可靠）
        const w = getUploadModeWidget(node);
        if (w) {
            const modeFromWidget = (String(w.value).trim().toLowerCase() === "replace") ? "replace" : "append";
            if (modeFromWidget !== uploadMode) {
                _resetImageEditsForModeSwitch();
                uploadMode = modeFromWidget;
                updateUploadModeBtn();
                _refreshMaskToolbar();
                _updateMaskCursor();
            }
        }
        viewMode = uploadMode === "append" ? "grid" : "single";

        // 多图模式下遮罩/裁剪开启 = 正在聚焦某张图编辑 → 切到单图编辑面（绑定 index 对应的图）
        const editFocus = uploadMode === "append" && (cropEnabled || maskEnabled) && names.length > 0;
        const effectiveSingle = viewMode === "single" || (viewMode === "grid" && names.length === 1) || editFocus;

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
                // 切图时重置裁剪拖拽状态（但不清空 cropRect/_cropByImage）：
                // 裁剪区域按图片名独立保存在 _cropByImage 中，切换图片后
                // 下方 _loadCropFromWidget() 会按新图片名从映射中加载对应裁剪区域，
                // 图片没变时裁剪不丢失，切换回之前裁剪过的图时裁剪自动恢复。
                _cropPending = null;
                _cropSelStart = _cropSelCur = null;
                _cropResizeCorner = null; _cropResizeBase = null; _cropResizeAnchorPos = null;
                _cropMove = false; _cropMoveStart = null; _cropMoveBase = null;
                _xzgFetchOriginalSize(name).then((info) => {
                    if (info && singleImgEl.dataset.previewKey === name) {
                        _singleOrigW = info.width;
                        _singleOrigH = info.height;
                        _updateSingleResLabel();
                    }
                });
            } else if (singleImgEl.complete && singleImgEl.naturalWidth > 0) {
                // 图片已加载好：立即同步离屏 canvas 尺寸，必要时加载保存的遮罩
                _ensureOffscreenCanvasSize(name, true);
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
            _renderTransformPreview();
            _refreshMaskToolbar();
            _updateMaskCursor();
            return;
        }

        // 多图网格模式：统一入口同步
        _loadCropFromWidget();
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
                    card.style.borderColor = isSelected ? getSelColor() : "transparent";
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
                isSelected ? getSelColor() : "transparent"
            };background:#000;width:100%;height:100%;overflow:hidden;box-sizing:border-box;`;

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
                "position:absolute;top:1px;right:1px;display:flex;align-items:center;justify-content:center;box-sizing:border-box;" +
                "padding-top:1px;line-height:0;color:#fff;font-family:Arial,sans-serif;font-weight:bold;cursor:pointer;z-index:3;opacity:0;" +
                "background:rgba(0,0,0,0.55);border-radius:50%;text-shadow:0 1px 2px #000;box-shadow:0 1px 3px rgba(0,0,0,0.4);";
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

            // 编号只在多图网格中创建；i 与实际加载顺序一致，拖动排序后重绘会同步更新。
            const indexBadge = document.createElement("div");
            indexBadge.className = "xzg-img-index";
            indexBadge.textContent = String(i + 1);
            indexBadge.style.cssText =
                "position:absolute;top:0;left:0;z-index:3;line-height:1.15;color:#fff;" +
                "background:rgba(0,0,0,0.72);border-radius:0 0 3px 0;pointer-events:none;font-weight:600;";
            _applyIndexBadgeSize(indexBadge, contentSize);

            const label = document.createElement("div");
            label.textContent = name;
            label.title = name;
            label.className = "xzg-img-label";
            label.style.cssText =
                "position:absolute;left:2px;right:2px;bottom:2px;font-size:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:0.7;line-height:1.2;text-align:center;color:#fff;z-index:1;";

            // 该图已裁剪 → 缩略图显示裁剪后的画面，并加「已裁剪」角标
            if (_gridHasCrop(name)) {
                _applyCropThumb(thumbEl, name);
                const cropBadge = document.createElement("div");
                cropBadge.className = "xzg-img-cropbadge";
                cropBadge.textContent = xzgT("已裁剪", "Cropped");
                cropBadge.style.cssText =
                    "position:absolute;right:1px;bottom:1px;z-index:3;pointer-events:none;font-weight:600;line-height:1.15;" +
                    "color:#ffd54a;background:rgba(0,0,0,0.65);border-radius:2px 0 0 0;padding:0 3px;";
                _applyCropBadgeSize(cropBadge, contentSize);
                card.appendChild(cropBadge);
            }
            card.appendChild(thumbEl);
            card.appendChild(delBtn);
            card.appendChild(indexBadge);
            card.appendChild(label);
            _applyMaskThumb(card, name, contentSize);
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
                    const merged = all.concat(newOnes);
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
                "position:relative;background:var(--comfy-menu-bg);border:1px solid var(--border-color);border-radius:8px;width:1200px;height:800px;display:flex;flex-direction:column;overflow:hidden;";
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

            // ===== 窗口几何记忆：大小/位置（localStorage + 云端持久化，与媒体库一致）=====
            overlay.appendChild(dialog);
            document.body.appendChild(overlay);

            const fileContainer = dialog.querySelector(".xzg-folder-grid");
            const selectedCountEl = dialog.querySelector(".selected-count");

            let filteredSource = null;
            let filteredQuery = null;
            let filteredCache = [];
            const getFilteredFiles = () => {
                if (filteredSource === fileNames && filteredQuery === searchText) return filteredCache;
                filteredSource = fileNames;
                filteredQuery = searchText;
                filteredCache = searchText
                    ? fileNames.filter(f => f.toLowerCase().includes(searchText.toLowerCase()))
                    : fileNames;
                return filteredCache;
            };

            const updateSelectedCount = () => {
                selectedCountEl.textContent = selectedSet.size;
            };

            let lastClickedIndex = -1;

            // 虚拟网格：保留完整文件列表和滚动高度，只创建可视区域附近的卡片。
            fileContainer.style.display = "block";
            fileContainer.style.padding = "0";
            fileContainer.style.scrollbarGutter = "stable";
            const virtualStage = document.createElement("div");
            virtualStage.style.cssText = "position:relative;width:100%;";
            fileContainer.appendChild(virtualStage);
            let lastWindowKey = "";

            const renderThumbs = (force = true) => {
                const filtered = getFilteredFiles();
                const cols = Math.min(8, Math.max(4, filtered.length));
                const gap = 2;
                const inset = 8;
                const cellWidth = Math.max(1, (fileContainer.clientWidth - inset * 2 - gap * (cols - 1)) / cols);
                const thumbSize = Math.max(1, cellWidth - 6);
                const rowHeight = cellWidth + 18;
                const rowPitch = rowHeight + gap;
                const rows = Math.ceil(filtered.length / cols);
                const totalHeight = inset * 2 + Math.max(0, rows * rowHeight + (rows - 1) * gap);
                virtualStage.style.height = `${totalHeight}px`;
                const scrollTop = Math.min(fileContainer.scrollTop, Math.max(0, totalHeight - fileContainer.clientHeight));
                const firstRow = Math.max(0, Math.floor(scrollTop / rowPitch) - 2);
                const lastRow = Math.min(rows, Math.ceil((scrollTop + fileContainer.clientHeight) / rowPitch) + 2);
                const windowKey = `${searchText}|${filtered.length}|${fileContainer.clientWidth}|${firstRow}|${lastRow}`;
                if (!force && windowKey === lastWindowKey) return;
                lastWindowKey = windowKey;

                const frag = document.createDocumentFragment();
                for (let i = firstRow * cols; i < Math.min(filtered.length, lastRow * cols); i++) {
                    const name = filtered[i];
                    const isSelected = selectedSet.has(name);
                    const item = document.createElement("div");
                    item.style.cssText = `
                        position:absolute;left:${inset + (i % cols) * (cellWidth + gap)}px;
                        top:${inset + Math.floor(i / cols) * rowPitch}px;
                        width:${cellWidth}px;height:${rowHeight}px;box-sizing:border-box;
                        display:flex;flex-direction:column;align-items:center;gap:2px;
                        padding:2px;border-radius:4px;cursor:pointer;
                        border:1px solid ${isSelected ? selColor : "transparent"};
                        background:${isSelected ? "rgba(255,255,255,0.1)" : "transparent"};
                    `;
                    item.title = name;
                    item.dataset.name = name;
                    item.dataset.index = String(i);

                    const thumb = document.createElement("div");
                    thumb.style.cssText =
                        `width:${thumbSize}px;height:${thumbSize}px;flex:0 0 auto;position:relative;border-radius:2px;overflow:hidden;background:#000;`;
                    const img = document.createElement("img");
                    const fileInfo = fileData[name];
                    const v = fileInfo?.mtime ? `&v=${fileInfo.mtime}` : "";
                    // Output API 返回的 name 已带 [output] 来源标记；避免重复追加标记。
                    const thumbName = copyToInput && prefix && !name.endsWith(prefix) ? name + prefix : name;
                    img.src = getThumbUrl(thumbName, 128) + v;
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
                }
                virtualStage.replaceChildren(frag);
                if (fileContainer.scrollTop !== scrollTop) fileContainer.scrollTop = scrollTop;
            };
            fileContainer.addEventListener("scroll", () => renderThumbs(false), { passive: true });

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

            const deleteSelected = () => {
                if (selectedSet.size === 0) {
                    xzgAlert(xzgT("请先选中要删除的图片（单击图片使其高亮）", "Select an image first (click one to highlight it)."));
                    return;
                }
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
            dialog.querySelector(".del-selected-btn").onclick = deleteSelected;

            // ===== 键盘 Delete 删除选中图片（与"删除选中"按钮共用逻辑）=====
            let lastDeletePress = 0;
            const doDeleteSelected = () => {
                const now = Date.now();
                if (now - lastDeletePress < 250) return; // 防抖：keydown+keyup 只触发一次
                lastDeletePress = now;
                deleteSelected();
            };
            const onDeleteKeyDown = (event) => {
                // Ctrl+A / ⌘+A 全选当前过滤后的图片（输入框内保留文本全选）
                if ((event.key === "a" || event.key === "A") && (event.ctrlKey || event.metaKey) && !event.repeat) {
                    if (!overlay.isConnected) return;
                    const ta = event.target;
                    if (ta instanceof Element && ta.closest("input, textarea, [contenteditable='true']")) return;
                    event.preventDefault();
                    event.stopPropagation();
                    getFilteredFiles().forEach(f => selectedSet.add(f));
                    renderThumbs();
                    updateSelectedCount();
                    return;
                }
                if (event.key !== "Delete" || event.repeat || !overlay.isConnected) return;
                const target = event.target;
                if (target instanceof Element && target.closest("input, textarea, [contenteditable='true']")) return;
                event.preventDefault();
                event.stopPropagation();
                doDeleteSelected();
            };
            // keyup 兜底：ComfyUI 全局快捷键可能拦截 keydown，但通常不拦 keyup
            const onDeleteKeyUp = (event) => {
                if (event.key !== "Delete" || event.repeat || !overlay.isConnected) return;
                const target = event.target;
                if (target instanceof Element && target.closest("input, textarea, [contenteditable='true']")) return;
                doDeleteSelected();
            };
            window.addEventListener("keydown", onDeleteKeyDown, true);
            window.addEventListener("keyup", onDeleteKeyUp, true);
            const cleanupDeleteKeys = () => {
                window.removeEventListener("keydown", onDeleteKeyDown, true);
                window.removeEventListener("keyup", onDeleteKeyUp, true);
            };
            // 弹窗关闭（overlay 被移除）时自动清理监听，避免残留
            const overlayObserver = new MutationObserver(() => {
                if (!overlay.isConnected) {
                    overlayObserver.disconnect();
                    cleanupDeleteKeys();
                }
            });
            overlayObserver.observe(document.body, { childList: true });

            const addSelectedImages = async () => {
                const selected = Array.from(selectedSet);
                if (selected.length === 0) return;

                let namesToAdd = selected.map(n => (copyToInput ? n : n + prefix));
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
                    finalList = all.concat(newOnes);
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

    mediaBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        showMediaLibrary({
            alertUser: xzgAlert,
            confirmUser: xzgConfirm,
            addImages: (names) => {
                if (!names.length) return;
                if (uploadMode === "replace") {
                    setNameList(node, names);
                } else {
                    const existing = parseNameList(getImageListWidget(node)?.value);
                    setNameList(node, existing.concat(names));
                }
                setIndex(node, 0);
                redraw(true);
            },
        });
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

    // 初次恢复多图工作流会直接绘制网格，不经过单图分支里的工具栏刷新；
    // 先同步一次显隐状态，确保刷新页面后裁剪/遮罩入口可见。
    _refreshMaskToolbar();
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
                const merged = all.concat(newOnes);
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
                    const merged = all.concat(newOnes);
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
        _editWorkspaceInitialZoomPending = false;
        _exitImageEditWorkspace();
        window.removeEventListener("keydown", _cropEscapeHandler, true);
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
                    const merged = all.concat(newOnes);
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
                        setNameList(node, all.concat([annotatedName]));
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
        sidebar,
        actionGroup,
        safetyActionGroup,
        maskToolbar,
        toggleMask: () => maskToggleBtn.click(),
        redraw,
        updateModeBtn,
        updateAlignBtn,
        updateMaxImgInput,
        updateUploadModeBtn,
        resizeObserver,
        _updateLabelScale: updateLabelScale,
        _updateBypassState: updateBypassState,
        _onWheel: onWheel,
        syncUploadModeFromWidget: _syncUploadModeFromWidget,
        commitCurrentMask: _commitMaskToWidget,
        syncMaskList: _syncMaskList,
        syncCropList: _syncCropList,
        reloadMaskFromWidget: _reloadCurrentMaskFromWidget,
        setMaskOutputEnabled: _setMaskOutputEnabled,
        setMaskCloseEnabled: _setMaskCloseEnabled,
        setMaskPreviewColor: (value) => {
            if (!/^#[0-9a-f]{6}$/i.test(value || "")) return;
            _setMaskPreviewColor(value);
        },
        getSelectedCompareItems: () => {
            const allNames = parseNameList(getImageListWidget(node)?.value);
            const limit = getMaxImagesLimit(node);
            const names = limit > 0 ? allNames.slice(0, limit) : allNames;
            // 未选中缩略图时（例如只选中了加载器节点），默认将第一张图片纳入对比。
            const indexes = selectedIndexes.length > 0 ? [...selectedIndexes] : [0];
            return [...new Set(indexes)]
                .map((index) => names[index])
                .filter(Boolean)
                .map((name) => ({
                    name: name.replace(/\s+\[(?:input|output|temp)\]$/i, "").split(/[\\/]/).pop() || name,
                    url: getOriginalImageUrl(name),
                }));
        },
        clearThumbnailSelection: () => {
            selectedIndexes = [];
            lastClickedIndex = -1;
            redraw(false);
        },
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
    // 工作流反序列化前预清洗：如果旧版/错位 JSON 把 upload_mode 的字符串写进 max_images，
    // ComfyUI 在构造整数 widget 前就可能拒绝该值，所以不能只依赖 onConfigure。
    beforeConfigureGraph(graphData) {
        const nodes = Array.isArray(graphData?.nodes) ? graphData.nodes : [];
        for (const node of nodes) {
            if (node?.type !== "XiaozhuguangImageLoader" || !Array.isArray(node.widgets_values)) continue;
            const maxIndex = Array.isArray(node.widgets)
                ? node.widgets.findIndex((widget) => widget?.name === "max_images")
                : -1;
            if (maxIndex >= 0 && maxIndex < node.widgets_values.length) {
                const raw = node.widgets_values[maxIndex];
                const parsed = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
                node.widgets_values[maxIndex] = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
            }
        }
    },
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
            nodeData.output_is_list[1] = true;
            // 兼容：有些旧版 ComfyUI 用 nodeData.output 是对象数组 {type,name, …}
            if (!Array.isArray(nodeData.outputs)) nodeData.outputs = [];
            nodeData.outputs[0] = Object.assign({}, nodeData.outputs[0] || {}, { type: "IMAGE", name: xzgT("图像", "images"), label: xzgT("图像", "images") });
            nodeData.outputs[1] = Object.assign({}, nodeData.outputs[1] || {}, { type: "MASK",  name: xzgT("遮罩", "mask"), label: xzgT("遮罩", "mask") });
            // 再彻底清空旧缓存残留
            if (Array.isArray(nodeData.output_link_labels)) nodeData.output_link_labels = null;
            if (nodeData.return_names)  nodeData.return_names  = [xzgT("图像", "images"), xzgT("遮罩", "mask")];
            if (nodeData.return_types)  nodeData.return_types  = ["IMAGE", "MASK"];
            if (nodeData.output_is_array) nodeData.output_is_array = [true, true];

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
                const batchAlignWidget = getBatchAlignWidget(this);
                if (batchAlignWidget) {
                    batchAlignWidget.type = "hidden";
                    batchAlignWidget.hidden = true;
                    batchAlignWidget.computeSize = () => [0, 0];
                }
                const maxImagesWidget = getMaxImagesWidget(this);
                if (maxImagesWidget) {
                    maxImagesWidget.type = "hidden";
                    maxImagesWidget.hidden = true;
                    maxImagesWidget.computeSize = () => [0, 0];
                    normalizeMaxImagesWidget(maxImagesWidget);
                }
                ensureHiddenWidget(this, "mask_output_enabled", "toggle", false);
                ensureHiddenWidget(this, "mask_output_color", "string", "#ff0000");
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
                const originalOnDeselected = this.onDeselected;
                this.onDeselected = function () {
                    const node = this;
                    // DOM 缩略图的鼠标交互可能触发一次临时的 deselect 回调；
                    // 等 LiteGraph 完成选中态更新后再判断，避免清掉正在操作的选择。
                    requestAnimationFrame(() => {
                        const selected = app?.canvas?.selected_nodes;
                        const stillSelected = !!(
                            node.selected ||
                            selected?.[node.id] === node ||
                            (selected instanceof Map && selected.get(node.id) === node) ||
                            (selected instanceof Set && selected.has(node))
                        );
                        if (!stillSelected) ui.clearThumbnailSelection?.();
                    });
                    if (originalOnDeselected) return originalOnDeselected.apply(this, arguments);
                };
                _updateToolbarIconSize(this);

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
                const _xzgImgDomWidget = this.addDOMWidget("xzg_img_loader", "customwidget", ui.container, {
                    hideOnZoom: false,
                    margin: 5,
                });
                // 修复（同「视频/音频」栏）：ComfyUI 会把 DOM widget 的 width 写成面板侧行宽度，
                // 画布侧 DOM 宿主宽度 = width - margin*2，一旦大于节点实际宽度，图片预览区/按钮栏就会
                // 溢出节点、且随属性面板开/关变化。这里把 width 改为只读访问器，始终跟随节点实际宽度。
                Object.defineProperty(_xzgImgDomWidget, 'width', {
                    configurable: true,
                    get() { return _nodeSelf.size?.[0] || 0; },
                    set(_) { /* 忽略外部写入，防止预览区溢出节点 */ },
                });

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
                const _nodeSelf = this;

                if (wIndex) {
                    const origCallback = wIndex.callback;
                    wIndex._xzg_lastValue = wIndex.value;
                    wIndex.callback = function (value) {
                        origCallback?.call(this, value);
                        if (value === wIndex._xzg_lastValue) return;
                        wIndex._xzg_lastValue = value;
                        ui.commitCurrentMask?.();
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
                        ui.commitCurrentMask?.();
                        ui.syncMaskList?.();
                        ui.syncCropList?.();
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
                const batchAlignWidget = getBatchAlignWidget(this);
                if (batchAlignWidget) {
                    batchAlignWidget.type = "hidden";
                    batchAlignWidget.hidden = true;
                    batchAlignWidget.computeSize = () => [0, 0];
                }
                const maxImagesWidget = getMaxImagesWidget(this);
                if (maxImagesWidget) {
                    maxImagesWidget.type = "hidden";
                    maxImagesWidget.hidden = true;
                    maxImagesWidget.computeSize = () => [0, 0];
                    // 先调用 ComfyUI 原始 onConfigure 完成位置恢复，再把错位字符串清洗为默认无限。
                    normalizeMaxImagesWidget(maxImagesWidget);
                }
                const overlayEnabledWidget = ensureHiddenWidget(this, "mask_output_enabled", "toggle", false);
                const overlayColorWidget = ensureHiddenWidget(this, "mask_output_color", "string", "#ff0000");
                if (data?.widgets_values && Array.isArray(data.widgets_values)) {
                    const enabledIndex = this.widgets?.indexOf(overlayEnabledWidget) ?? -1;
                    const colorIndex = this.widgets?.indexOf(overlayColorWidget) ?? -1;
                    if (enabledIndex >= 0 && data.widgets_values[enabledIndex] != null) overlayEnabledWidget.value = data.widgets_values[enabledIndex];
                    if (colorIndex >= 0 && data.widgets_values[colorIndex] != null) overlayColorWidget.value = data.widgets_values[colorIndex];
                }
                if (data?.properties?.xzg_mask_output_enabled != null) {
                    const savedEnabled = data.properties.xzg_mask_output_enabled;
                    overlayEnabledWidget.value = savedEnabled === true || savedEnabled === 1 || String(savedEnabled).toLowerCase() === "true";
                }
                if (data?.properties?.xzg_mask_preview_color) overlayColorWidget.value = data.properties.xzg_mask_preview_color;
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
                const restoredMaskColor = data?.properties?.xzg_mask_preview_color || this.properties?.xzg_mask_preview_color;
                if (restoredMaskColor) this._xzgImgLoaderUI?.setMaskPreviewColor?.(restoredMaskColor);
                if (data?.properties?.xzg_mask_close_enabled != null) {
                    const savedClose = data.properties.xzg_mask_close_enabled;
                    this._xzgImgLoaderUI?.setMaskCloseEnabled?.(savedClose === true || savedClose === 1 || String(savedClose).toLowerCase() === "true");
                }
                this._xzgImgLoaderUI?.setMaskOutputEnabled?.(
                    data?.properties?.xzg_mask_output_enabled != null
                        ? (data.properties.xzg_mask_output_enabled === true || data.properties.xzg_mask_output_enabled === 1 || String(data.properties.xzg_mask_output_enabled).toLowerCase() === "true")
                        : String(overlayEnabledWidget?.value || "").toLowerCase() === "true"
                );
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
                    this._xzgImgLoaderUI.reloadMaskFromWidget?.();
                    this._xzgImgLoaderUI.updateModeBtn?.();
                    // 恢复 max_images widget 值后同步到“上限”输入框
                    this._xzgImgLoaderUI.updateMaxImgInput?.();
                }
                return r;
            };

            const origOnSerialize = nodeType.prototype.onSerialize;
            nodeType.prototype.onSerialize = function (data) {
                const r = origOnSerialize?.apply(this, arguments);
                // 保存工作流前再规范一次，避免损坏或旧工作流中的模式字符串继续传播。
                normalizeMaxImagesWidget(getMaxImagesWidget(this));
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
                data.properties.xzg_mask_preview_color = this.properties?.xzg_mask_preview_color || "#ff0000";
                const overlayEnabled = getMaskOutputEnabledWidget(this)?.value;
                data.properties.xzg_mask_output_enabled = overlayEnabled === true || overlayEnabled === 1 || String(overlayEnabled).toLowerCase() === "true";
                const closeEnabled = this.properties?.xzg_mask_close_enabled;
                data.properties.xzg_mask_close_enabled = closeEnabled === true || closeEnabled === 1 || String(closeEnabled).toLowerCase() === "true";
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
                    if (Array.isArray(data.widgets_values) && Array.isArray(this.widgets)) {
                        const idx = this.widgets.indexOf(cropWidget);
                        if (idx >= 0) data.widgets_values[idx] = cropWidget.value;
                    }
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
            function _updateToolbarIconSize(nodeInst) {
                const ui = nodeInst?._xzgImgLoaderUI;
                const sidebar = ui?.sidebar;
                if (!sidebar) return;
                const h = nodeInst.size?.[1] || 300;
                const availableHeight = Math.max(0, h - 30);
                const density = Math.max(0, Math.min(1, (availableHeight - 260) / 220));
                // 0.5px 步进：拖拽缩放时所有间距随同一 density 连续平滑变化，
                // 分割线与按钮之间不再出现原先 Math.round 整跳带来的不均匀跳变。
                const px = (v) => `${Math.round(v * 2) / 2}px`;

                // 图标与按钮内边距：随 density 平滑放大
                const iconSize = px(14 + density * 18);
                if (sidebar.style.getPropertyValue("--xzg-ic-size") !== iconSize) {
                    sidebar.style.setProperty("--xzg-ic-size", iconSize);
                }
                const buttonPadding = px(1 + density * 3);
                if (sidebar.style.getPropertyValue("--xzg-btn-pad-y") !== buttonPadding) {
                    sidebar.style.setProperty("--xzg-btn-pad-y", buttonPadding);
                }

                // 组内按钮间距：侧栏、操作组、安全组、遮罩工具栏共用同一节奏
                const itemGapV = 1 + density * 5;   // 按钮间距（1→6px）
                const sideGapV = density * 2;        // 侧栏组间间距（0→2px）
                const itemGap = px(itemGapV);
                const sideGap = px(sideGapV);
                if (sidebar.style.gap !== sideGap) sidebar.style.gap = sideGap;
                if (ui.actionGroup && ui.actionGroup.style.gap !== itemGap) {
                    ui.actionGroup.style.gap = itemGap;
                }

                // 分割线（cropDeleteDivider）是安全组（删除/清空）的首个子元素，为其上方
                // 预留与按钮间距相同的间隙：使「裁剪→垃圾桶」与「资源媒体→遮罩」两处分隔
                // 都等于 2×itemGap，整列节奏均匀，不再出现明显偏大的空隙。
                const sectionGap = px(itemGapV - sideGapV);
                if (ui.safetyActionGroup) {
                    if (ui.safetyActionGroup.style.gap !== itemGap) ui.safetyActionGroup.style.gap = itemGap;
                    if (ui.safetyActionGroup.style.marginTop !== sectionGap) {
                        ui.safetyActionGroup.style.marginTop = sectionGap;
                    }
                }
                if (ui.maskToolbar && ui.maskToolbar.style.gap !== itemGap) {
                    ui.maskToolbar.style.gap = itemGap;
                }
                // 底部文字按钮（上限∞/批量/列表/批次）字号也随 density 缩放，
                // 与上方图标按钮保持同一节奏（8→14px），节点拖大后不再大小不变。
                const uiFont = px(8 + density * 6);
                if (sidebar.style.getPropertyValue("--xzg-ui-font") !== uiFont) {
                    sidebar.style.setProperty("--xzg-ui-font", uiFont);
                }
            }

            const origOnDrawBackground = nodeType.prototype.onDrawBackground;
            nodeType.prototype.onDrawBackground = function (ctx) {
                _updateToolbarIconSize(this);
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
                _updateToolbarIconSize(this);
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

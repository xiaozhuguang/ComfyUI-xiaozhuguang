import { app } from "../../scripts/app.js";
import { XiaozhuguangVideoPlayer } from "./xzg_video_player.js";

// ── 设置项：启用/关闭「视频对比（同步预览）」（设置 → xiaozhuguang）──
const SETTING_VIDEO_COMPARE = "xiaozhuguang.Toggle.EnableVideoCompare";
const IMAGE_SAVE_NODE_TYPES = new Set(["XiaozhuguangImageSave", "XiaozhuguangImageSaveCustom"]);
function isImageSaveNode(node) {
    return !!node && (IMAGE_SAVE_NODE_TYPES.has(node.type) || node.canvasWidget?.name === "xzg_image_save");
}
function isVideoCompareEnabled() {
    try {
        // 新版前端已废弃 getSettingValue 的第二个参数（默认值改由设置项定义提供）
    return app?.ui?.settings?.getSettingValue?.(SETTING_VIDEO_COMPARE) !== false;
    } catch (e) {
        return true;
    }
}
function registerVideoCompareSetting() {
    try {
        const settings = app?.ui?.settings;
        if (!settings?.addSetting) return;
        settings.addSetting({
            id: SETTING_VIDEO_COMPARE,
            name: "[小珠光] 启用「视频对比（同步预览）」",
            defaultValue: true,
            type: "boolean",
            onChange: (v) => { if (!v) closeSyncPreview(); },
        });
    } catch (e) {}
}

/**
 * 小珠光 · 视频节点同步预览
 *
 * 功能：
 * - 在画布上「合并视频」等带视频预览的节点右键菜单中增加「同步预览」；
 *   点击（选中）一个视频节点右键，或多选（框选）多个视频节点后右键，
 *   选择「同步预览」后，这些节点输出的视频加载完成后暂停在开头，
 *   由用户点击播放开始（播放时从头一起播放，并自动开启循环播放）。
 * - 画布空白处右键，当存在选中的视频节点时提供「同步预览选中视频」。
 * - 供快捷键 G（xiaozhuguang 设置中可配置）调用：对当前选中的视频节点同步预览，
 *   无选中时预览画布上全部视频节点。
 */

// ═══════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════

function getVideoUrl(filename, type, subfolder, absToken, previewId) {
    if (!filename) return "";
    if (absToken) return `/xzg/davinci/view-abs?token=${encodeURIComponent(absToken)}&v=${encodeURIComponent(previewId || "")}`;
    const params = new URLSearchParams({
        filename,
        type: type || "output",
    });
    if (subfolder) params.set("subfolder", subfolder);
    if (previewId) params.set("v", previewId);
    return `/view?${params.toString()}`;
}

function _extractFilename(url, fallback = "video.mp4") {
    try {
        const params = new URLSearchParams(new URL(url, location.origin).search);
        return params.get("filename") || fallback;
    } catch (_) {
        return fallback;
    }
}

/** 节点是否有可预览的视频（小珠光合并视频节点带 _xzgVideoPlayer） */
function nodeHasVideo(node) {
    if (!node || node.mode === 4) return false; // bypass 节点不参与预览
    const p = node._xzgVideoPlayer;
    if (!p) return false;
    if (typeof p.getSrc === "function" && p.getSrc()) return true;
    if (p._videoInfo && p._videoInfo.filename) return true;
    return false;
}

/** 从节点取视频 { url, name }（不带节点的裁剪区间），取不到返回 null */
function getVideoFromNode(node) {
    const p = node && node._xzgVideoPlayer;
    if (!p) return null;
    // 保存输出可能尚在等待节点变为可见后加载，getSrc() 此时仍指向旧文件。
    // 保存节点应使用最新执行输出，并保留版本参数以隔离解码缓存。
    if (["XiaozhuguangVideoCombine", "XiaozhuguangVideoSaveDaVinci"].includes(node.type)) {
        const info = p._videoInfo;
        if (info?.filename) return {
            url: getVideoUrl(info.filename, info.type, info.subfolder, info.abs_token, info.preview_id),
            name: info.filename,
        };
    }
    let src = typeof p.getSrc === "function" ? p.getSrc() : null;
    if (!src && p._videoInfo && p._videoInfo.filename) {
        src = getVideoUrl(p._videoInfo.filename, p._videoInfo.type, p._videoInfo.subfolder, p._videoInfo.abs_token, p._videoInfo.preview_id);
    }
    if (!src) return null;
    const item = { url: src, name: _extractFilename(src, p._videoInfo?.filename) };
    // 携带节点自身播放器已应用的加载范围（跳过帧数/帧数上限）：
    // 对比窗口里各视频可以各自有区间（左侧裁剪、右侧完整），
    // 起播/逐帧/拖动都按「各自区间内的相对帧号」对齐（见 seekPlayerToOffset）
    // 预览覆盖（批处理逐段产出的片段文件）本身就是裁好的，再套 skip/limit 会二次偏移
    if (!p._previewLoaded) {
        if (typeof p._skipFrames === "number" && p._skipFrames > 0) item.skipFrames = p._skipFrames;
        if (typeof p._frameLimit === "number" && p._frameLimit > 0) item.frameLimit = p._frameLimit;
    }
    return item;
}

/** 视频加载类节点（其产出视为“原视频”，对比时排在最左侧） */
const VIDEO_LOADER_TYPES = new Set([
    "XiaozhuguangVideoLoader",
    "XiaozhuguangVideoLoaderLM",
    "XiaozhuguangVideoLoaderDaVinci",
]);
function isVideoLoaderNode(node) {
    return !!node && VIDEO_LOADER_TYPES.has(node.type);
}

/** 小珠光图片加载器当前选中的图片。 */
function nodeHasImage(node) {
    if (!node || node.mode === 4) return false;
    if (isImageSaveNode(node)) {
        return (node.canvasWidget?.value?.images || []).some((image) => !!image?.url);
    }
    // ComfyUI 可能在节点重载/旧工作流恢复时调整运行时 type 字符串；
    // image_list 控件才是小珠光图片加载器稳定且唯一的识别标记。
    const list = node.widgets?.find((w) => w.name === "image_list")?.value;
    return typeof list === "string" && list.trim().length > 0;
}

function getImageFromNode(node) {
    if (!nodeHasImage(node)) return null;
    if (isImageSaveNode(node)) {
        const widget = node.canvasWidget;
        const images = widget?.value?.images || [];
        const index = Number.isFinite(widget?.currentIndex) ? widget.currentIndex : 0;
        const image = images[index] || images[0];
        if (!image?.url) return null;
        return {
            kind: "image",
            url: image.url,
            name: image.saved_filename || _extractFilename(image.url),
        };
    }
    const selectedItems = node._xzgImgLoaderUI?.getSelectedCompareItems?.();
    if (Array.isArray(selectedItems) && selectedItems.length) {
        return { ...selectedItems[0], kind: "image" };
    }
    const names = node.widgets.find((w) => w.name === "image_list").value
        .split("\n").map((s) => s.trim()).filter(Boolean);
    const rawIndex = Number(node.widgets.find((w) => w.name === "index")?.value || 0);
    const index = Number.isFinite(rawIndex) ? Math.max(0, Math.min(names.length - 1, Math.floor(rawIndex))) : 0;
    const annotated = names[index];
    let filename = annotated, type = "input";
    for (const suffix of [" [output]", " [input]", " [temp]"]) {
        if (filename.endsWith(suffix)) {
            type = suffix.slice(2, -1);
            filename = filename.slice(0, -suffix.length);
            break;
        }
    }
    const url = `/view?${new URLSearchParams({ filename, type }).toString()}`;
    return { kind: "image", url, name: filename.split(/[\\/]/).pop() || filename };
}

async function getImagesFromNode(node) {
    if (!nodeHasImage(node)) return [];
    if (isImageSaveNode(node)) {
        const items = await node.canvasWidget?.getSelectedCompareItems?.();
        return Array.isArray(items) ? items.map((item) => ({ ...item, kind: "image" })) : [];
    }
    const selectedItems = node._xzgImgLoaderUI?.getSelectedCompareItems?.();
    if (Array.isArray(selectedItems) && selectedItems.length) {
        return selectedItems.map((item) => ({ ...item, kind: "image" }));
    }
    const image = getImageFromNode(node);
    return image ? [image] : [];
}

// 使用原图像素坐标生成裁剪画面；越界部分沿用加载器的补边颜色。
function cropCompareImage(image, crop, paddingColor) {
    if (!Array.isArray(crop) || crop.length !== 4 || !crop.every(Number.isFinite)) return null;
    const [x, y, w, h] = crop;
    if (w <= 0 || h <= 0) return null;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w));
    canvas.height = Math.max(1, Math.round(h));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = paddingColor || "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const sx = Math.max(0, x), sy = Math.max(0, y);
    const ex = Math.min(image.naturalWidth, x + w), ey = Math.min(image.naturalHeight, y + h);
    if (ex > sx && ey > sy) {
        ctx.drawImage(image, sx, sy, ex - sx, ey - sy,
            (sx - x) * canvas.width / w, (sy - y) * canvas.height / h,
            (ex - sx) * canvas.width / w, (ey - sy) * canvas.height / h);
    }
    return canvas.toDataURL("image/png");
}

function nodeHasMedia(node) { return nodeHasVideo(node) || nodeHasImage(node); }

/** 按画布位置排序：x 升序（左→右），x 相同按 y 升序（上→下） */
function _sortByCanvasPos(nodes) {
    return [...nodes].sort((a, b) => {
        const ax = (a.pos && a.pos[0]) || 0;
        const bx = (b.pos && b.pos[0]) || 0;
        if (ax !== bx) return ax - bx;
        const ay = (a.pos && a.pos[1]) || 0;
        const by = (b.pos && b.pos[1]) || 0;
        return ay - by;
    });
}

/** 收集当前选中的视频节点（按画布位置排序；兼容 Map/Set/对象三种形态） */
function getSelectedVideoNodes() {
    const sel = app?.canvas?.selected_nodes;
    const out = [];
    if (!sel) return out;
    if (sel instanceof Map || sel instanceof Set) {
        for (const n of sel.values()) {
            if (nodeHasVideo(n)) out.push(n);
        }
    } else if (typeof sel === "object") {
        for (const id in sel) {
            const n = sel[id];
            if (n && nodeHasVideo(n)) out.push(n);
        }
    }
    return _sortByCanvasPos(out);
}

/** 画布上所有有视频的节点（按画布位置排序） */
function getAllVideoNodes() {
    return _sortByCanvasPos((app?.graph?._nodes || []).filter((n) => nodeHasVideo(n)));
}

function getSelectedMediaNodes() {
    const sel = app?.canvas?.selected_nodes;
    const out = [];
    if (sel instanceof Map || sel instanceof Set) {
        for (const n of sel.values()) if (nodeHasMedia(n)) out.push(n);
    } else if (sel && typeof sel === "object") {
        for (const id in sel) if (nodeHasMedia(sel[id])) out.push(sel[id]);
    }
    // 有些画布版本会短暂重建 selected_nodes 映射；节点自身的 selected
    // 标记可作为兜底，避免快捷键恰好落在重建间隙时看起来没有响应。
    if (out.length === 0) {
        for (const n of app?.graph?._nodes || []) {
            if (n?.selected && nodeHasMedia(n)) out.push(n);
        }
    }
    return _sortByCanvasPos(out);
}

function getAllMediaNodes() {
    return _sortByCanvasPos((app?.graph?._nodes || []).filter(nodeHasMedia));
}

function openImageCompare(items) {
    if (!items.length) return false;
    _ensureStyle();
    closeSyncPreview();
    const overlay = document.createElement("div");
    overlay.className = "xzg-sp-overlay";
    _overlay = overlay;
    const win = document.createElement("div");
    win.className = "xzg-sp-window";
    const header = document.createElement("div");
    header.className = "xzg-sp-header";
    header.style.justifyContent = "flex-start";
    header.style.gap = "8px";
    const title = document.createElement("span");
    title.className = "xzg-sp-title";
    title.textContent = "图片对比";
    const zoomBtn = document.createElement("button"); zoomBtn.className = "xzg-sp-btn"; zoomBtn.textContent = "🔍 100%";
    zoomBtn.title = "滚轮缩放；点击恢复 100% 并将画面居中";
    const zoomSyncBtn = document.createElement("button"); zoomSyncBtn.className = "xzg-sp-btn";
    zoomSyncBtn.textContent = "🔗 缩放同步";
    zoomSyncBtn.title = "切换图片缩放同步状态；双击图片可直接进入不同步缩放";
    const close = document.createElement("button");
    close.className = "xzg-sp-close"; close.textContent = "✕"; close.title = "关闭";
    close.onclick = closeSyncPreview;
    close.style.marginLeft = "auto";
    header.append(title);
    const grid = document.createElement("div");
    grid.className = "xzg-sp-grid";
    const cells = items.map((item) => {
        const cell = document.createElement("div"); cell.className = "xzg-sp-cell";
        const label = document.createElement("div"); label.className = "xzg-sp-label"; label.textContent = item.name;
        const holder = document.createElement("div"); holder.className = "xzg-sp-player";
        const img = document.createElement("img");
        if (item.crop) {
            img.onload = () => {
                img.onload = null;
                const cropped = cropCompareImage(img, item.crop, item.paddingColor);
                if (cropped) img.src = cropped;
            };
        }
        img.src = item.url; img.alt = item.name; img.draggable = false;
        img.style.cssText = "width:100%;height:100%;object-fit:contain;display:block";
        holder.appendChild(img); cell.append(label, holder); grid.appendChild(cell);
        return { cell, holder, img };
    });
    if (cells.length === 2) {
        // 双图默认左右并排，避免竖屏图片在默认自动布局中上下堆叠。
        grid.style.gridTemplateColumns = "repeat(2, minmax(0, 1fr))";
        grid.style.gridTemplateRows = "minmax(0, 1fr)";
    } else if (cells.length === 4) {
        // 四图对比固定为两列两行，便于按顺序逐行查看。
        grid.style.gridTemplateColumns = "repeat(2, minmax(0, 1fr))";
        grid.style.gridTemplateRows = "repeat(2, minmax(0, 1fr))";
    } else if (cells.length === 3) {
        // 三图对比在同一行从左到右排列。
        grid.style.gridTemplateColumns = "repeat(3, minmax(0, 1fr))";
        grid.style.gridTemplateRows = "minmax(0, 1fr)";
    } else if (cells.length === 5 || cells.length === 6) {
        // 五/六图都按三列两行排列；五图时右下角自然留空。
        grid.style.gridTemplateColumns = "repeat(3, minmax(0, 1fr))";
        grid.style.gridTemplateRows = "repeat(2, minmax(0, 1fr))";
    }
    const wipeBtn = document.createElement("button"); wipeBtn.className = "xzg-sp-btn"; wipeBtn.textContent = "🔀 划像对比";
    wipeBtn.title = "在左侧缩略图中选择两张图片";
    const ultrawideBtn = document.createElement("button"); ultrawideBtn.className = "xzg-sp-btn"; ultrawideBtn.textContent = "🖥 带鱼屏";
    ultrawideBtn.title = "双路竖屏图片靠近窗口中间显示";
    ultrawideBtn.style.display = cells.length === 2 ? "" : "none";
    header.append(wipeBtn, zoomSyncBtn, zoomBtn, ultrawideBtn, close);
    let ultrawideMode = false;
    const applyImageCompareLayout = () => {
        if (cells.length !== 2) return;
        const ratios = cells.map(({ holder }) => {
            const img = holder.querySelector("img");
            return img?.naturalWidth > 0 && img?.naturalHeight > 0 ? img.naturalWidth / img.naturalHeight : null;
        });
        const portraitPair = ratios.every((ratio) => ratio != null && ratio < 1);
        if (ultrawideMode && portraitPair) {
            // 为两张图各预留一个 2:3 竖屏视窗；宽度按屏幕可用高/宽计算并居中。
            grid.style.gridTemplateColumns = "repeat(2, minmax(0, min(40vw, calc(66.6667vh - 60px))))";
            grid.style.gridTemplateRows = "auto";
            grid.style.justifyContent = "center";
            grid.style.alignContent = "center";
            for (const { holder } of cells) {
                holder.style.aspectRatio = "2 / 3";
                holder.style.flex = "none";
                holder.style.width = "100%";
                holder.style.height = "auto";
            }
        } else {
            grid.style.gridTemplateColumns = "repeat(2, minmax(0, 1fr))";
            grid.style.gridTemplateRows = "minmax(0, 1fr)";
            grid.style.justifyContent = "";
            grid.style.alignContent = "";
            for (const { holder } of cells) {
                holder.style.aspectRatio = "";
                holder.style.flex = "";
                holder.style.width = "";
                holder.style.height = "";
            }
        }
        ultrawideBtn.disabled = !portraitPair;
        ultrawideBtn.title = portraitPair
            ? "双路竖屏图片靠近窗口中间显示"
            : "带鱼屏模式仅适用于两张竖屏图片";
        ultrawideBtn.classList.toggle("active", ultrawideMode && portraitPair);
    };
    ultrawideBtn.onclick = () => {
        if (ultrawideBtn.disabled) return;
        ultrawideMode = !ultrawideMode;
        applyImageCompareLayout();
    };
    for (const { holder } of cells) {
        const img = holder.querySelector("img");
        img.addEventListener("load", applyImageCompareLayout, { once: true });
    }
    applyImageCompareLayout();
    const wipe = document.createElement("div"); wipe.className = "xzg-sp-wipe";
    const wipeSide = document.createElement("div"); wipeSide.className = "xzg-sp-wipe-side";
    const wipeMain = document.createElement("div"); wipeMain.className = "xzg-sp-wipe-main";
    const wipeLabel = document.createElement("div"); wipeLabel.className = "xzg-sp-wipe-label";
    const originalLabel = document.createElement("span"); originalLabel.textContent = "原图";
    const newLabel = document.createElement("span"); newLabel.textContent = "新图";
    wipeLabel.append(originalLabel, newLabel);
    const wipeStage = document.createElement("div"); wipeStage.className = "xzg-sp-wipe-stage xzg-sp-image-wipe-stage";
    const wipeHint = document.createElement("div"); wipeHint.className = "xzg-sp-wipe-hint";
    wipeHint.textContent = "请在左侧选择两张图片进行划像对比";
    const divider = document.createElement("div"); divider.className = "xzg-sp-wipe-divider";
    divider.title = "拖动分界线进行划像对比";
    wipeStage.append(wipeHint);
    wipeMain.append(wipeLabel, wipeStage, divider);
    wipe.append(wipeSide, wipeMain);
    let wipeOn = false, wipeX = 50;
    let wipePair = [0, 1];
    const updateWipeLabels = () => {
        if (!wipeOn || wipePair.length !== 2) return;
        const stage = wipeStage.getBoundingClientRect();
        const split = stage.left + stage.width * wipeX / 100;
        [originalLabel, newLabel].forEach((label, side) => {
            const { img } = cells[wipePair[side]];
            const rect = img.getBoundingClientRect();
            const scale = Math.min(rect.width / img.naturalWidth, rect.height / img.naturalHeight);
            const width = img.naturalWidth * scale;
            const height = img.naturalHeight * scale;
            const left = Math.max(stage.left, side === 1 ? split : stage.left, rect.left + (rect.width - width) / 2);
            const right = Math.min(stage.right, side === 0 ? split : stage.right, rect.right - (rect.width - width) / 2);
            const top = Math.max(stage.top, rect.top + (rect.height - height) / 2);
            const bottom = Math.min(stage.bottom, rect.bottom - (rect.height - height) / 2);
            label.hidden = !(right > left && bottom > top);
            if (label.hidden) return;
            label.style.left = `${left - stage.left}px`;
            label.style.width = `${right - left}px`;
        });
    };
    const updateWipe = () => {
        wipeMain.style.setProperty("--wipe", `${wipeX}%`);
        updateWipeLabels();
    };
    overlay._xzgWinResize = updateWipeLabels;
    window.addEventListener("resize", updateWipeLabels);
    const layoutWipePair = () => {
        const ready = wipePair.length === 2;
        cells.forEach(({ cell, holder }) => {
            holder.classList.remove("wipe-top");
            cell.appendChild(holder);
        });
        wipeHint.style.display = ready ? "none" : "";
        wipeLabel.style.display = ready ? "" : "none";
        divider.style.display = ready ? "" : "none";
        if (ready) {
            const [left, right] = wipePair;
            wipeStage.append(cells[right].holder, cells[left].holder);
            cells[left].holder.classList.add("wipe-top");
            if (!wipePair.includes(activeIndex)) {
                activeIndex = left;
                updateZoomModeUI();
                applyImageTransform(left);
            }
        }
        thumbs.forEach((thumb, index) => {
            const selected = wipePair.includes(index);
            thumb.classList.toggle("sel", selected);
            thumb.disabled = ready && !selected;
            thumb.classList.toggle("dim", thumb.disabled);
            thumb.setAttribute("aria-pressed", String(selected));
        });
        updateWipeLabels();
    };
    const thumbs = cells.length < 2 ? [] : cells.map(({ img }, index) => {
        const thumb = document.createElement("button");
        thumb.type = "button";
        thumb.className = "xzg-sp-wipe-thumb";
        thumb.title = img.alt;
        thumb.setAttribute("aria-label", img.alt);
        const preview = document.createElement("img");
        preview.alt = "";
        preview.draggable = false;
        const updateThumbnail = () => { preview.src = img.src; };
        img.addEventListener("load", updateThumbnail);
        img.addEventListener("load", updateWipeLabels);
        updateThumbnail();
        const label = document.createElement("span"); label.className = "tag"; label.textContent = img.alt;
        const check = document.createElement("span"); check.className = "chk"; check.textContent = "✓";
        check.setAttribute("aria-hidden", "true");
        thumb.append(preview, label, check);
        thumb.onclick = () => {
            wipePair = wipePair.includes(index)
                ? wipePair.filter(selected => selected !== index)
                : [...wipePair, index].sort((a, b) => a - b);
            layoutWipePair();
        };
        wipeSide.appendChild(thumb);
        return thumb;
    });
    const setWipe = (on) => {
        if (cells.length < 2) return;
        wipeOn = on;
        wipe.classList.toggle("active", on);
        wipe.classList.toggle("multi", on);
        grid.style.display = on ? "none" : "grid";
        if (on) {
            layoutWipePair();
            updateWipe();
        } else for (const c of cells) { c.holder.classList.remove("wipe-top"); c.cell.appendChild(c.holder); }
        wipeBtn.textContent = on ? "⬒ 并排对比" : "🔀 划像对比";
    };
    wipeBtn.style.display = cells.length >= 2 ? "" : "none";
    wipeBtn.onclick = () => setWipe(!wipeOn);
    let zoomSync = true;
    let activeIndex = 0;
    const viewStates = cells.map(() => ({ zoom: 1, panX: 0, panY: 0 }));
    const updateZoomModeUI = () => {
        const syncColor = zoomSync ? "#42d392" : "#ffb74d";
        const syncBackground = zoomSync ? "rgba(35,145,96,.22)" : "rgba(190,112,24,.24)";
        zoomSyncBtn.textContent = zoomSync ? "🔗 同步中" : "⛓ 不同步";
        zoomSyncBtn.style.color = syncColor;
        zoomSyncBtn.style.borderColor = syncColor;
        zoomSyncBtn.style.background = syncBackground;
        zoomSyncBtn.style.fontWeight = "700";
        zoomSyncBtn.title = zoomSync
            ? "同步模式：缩放和移动会作用于所有图片；双击图片可切换为不同步"
            : "不同步模式：缩放和移动只作用于当前图片；双击图片可恢复同步";
        for (let i = 0; i < cells.length; i++) {
            const cell = cells[i].cell;
            if (zoomSync) {
                cell.style.borderColor = "#3f3f3f";
                cell.style.borderWidth = "1px";
                cell.style.boxShadow = "none";
            } else if (i === activeIndex) {
                cell.style.borderColor = "#ff3b30";
                cell.style.borderWidth = "2px";
                cell.style.boxShadow = "inset 0 0 0 1px rgba(255,59,48,.84)";
            } else {
                cell.style.borderColor = "#3f3f3f";
                cell.style.borderWidth = "1px";
                cell.style.boxShadow = "none";
            }
        }
    };
    const applyImageTransform = (onlyIndex = -1) => {
        for (let i = 0; i < cells.length; i++) {
            if (onlyIndex >= 0 && i !== onlyIndex) continue;
            const { holder } = cells[i];
            const state = viewStates[i];
            holder.style.overflow = "hidden";
            const image = holder.querySelector("img");
            if (!image) continue;
            image.style.transformOrigin = "center center";
            image.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
            image.style.willChange = state.zoom === 1 && state.panX === 0 && state.panY === 0 ? "" : "transform";
        }
        zoomBtn.textContent = `🔍 ${Math.round(viewStates[activeIndex]?.zoom * 100 || 100)}%`;
        updateWipeLabels();
    };
    const setZoomSync = (sync) => {
        if (zoomSync === sync) return;
        // 切换状态本身不改任何图片的缩放或位置；同步只作用于之后的滚轮/拖动增量。
        zoomSync = sync;
        updateZoomModeUI();
    };
    zoomSyncBtn.onclick = () => {
        setZoomSync(!zoomSync);
    };
    zoomBtn.onclick = () => {
        const targets = zoomSync ? viewStates : [viewStates[activeIndex]];
        for (const state of targets) Object.assign(state, { zoom: 1, panX: 0, panY: 0 });
        applyImageTransform(zoomSync ? -1 : activeIndex);
    };
    const zoomAt = (index, factor, clientX, clientY, target) => {
        const rect = target.getBoundingClientRect();
        const state = viewStates[index];
        const oldZoom = state.zoom;
        const nextZoom = Math.max(0.1, Math.min(10, oldZoom * factor));
        if (nextZoom === oldZoom) return;
        const x = clientX - rect.left - rect.width / 2;
        const y = clientY - rect.top - rect.height / 2;
        state.panX = x - (x - state.panX) * (nextZoom / oldZoom);
        state.panY = y - (y - state.panY) * (nextZoom / oldZoom);
        state.zoom = nextZoom;
        if (zoomSync) {
            const ratio = nextZoom / oldZoom;
            // 把鼠标锚点按窗格内的相对位置映射到其它图片，
            // 让每张图都围绕对应的同一视觉锚点缩放。
            const anchorRX = rect.width > 0 ? (clientX - rect.left) / rect.width : 0.5;
            const anchorRY = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5;
            for (let i = 0; i < viewStates.length; i++) {
                if (i === index) continue;
                const peer = viewStates[i];
                const peerRect = cells[i].holder.getBoundingClientRect();
                const peerX = (anchorRX - 0.5) * peerRect.width;
                const peerY = (anchorRY - 0.5) * peerRect.height;
                const peerOldZoom = peer.zoom;
                const peerNewZoom = Math.max(0.1, Math.min(10, peerOldZoom * ratio));
                const peerRatio = peerOldZoom > 0 ? peerNewZoom / peerOldZoom : 1;
                peer.panX = peerX - (peerX - peer.panX) * peerRatio;
                peer.panY = peerY - (peerY - peer.panY) * peerRatio;
                peer.zoom = peerNewZoom;
            }
            applyImageTransform();
        } else {
            activeIndex = index;
            applyImageTransform(index);
        }
    };
    for (let index = 0; index < cells.length; index++) {
        const { holder } = cells[index];
        holder.addEventListener("wheel", (e) => {
            // 划像模式由重叠容器统一处理滚轮，避免重叠图层上的事件选错缩放源。
            if (wipeOn) return;
            e.preventDefault();
            activeIndex = index;
            updateZoomModeUI();
            zoomAt(index, e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY, holder);
        }, { passive: false });
        holder.addEventListener("dblclick", (e) => {
            e.preventDefault();
            e.stopPropagation();
            activeIndex = index;
            setZoomSync(!zoomSync);
            applyImageTransform(zoomSync ? -1 : index);
        });
        holder.addEventListener("mousedown", (e) => {
            if (e.button !== 0 && e.button !== 1) return;
            e.preventDefault();
            activeIndex = index;
            updateZoomModeUI();
            const baseStates = viewStates.map((state) => ({ panX: state.panX, panY: state.panY }));
            const startX = e.clientX, startY = e.clientY;
            const move = (ev) => {
                const deltaX = ev.clientX - startX;
                const deltaY = ev.clientY - startY;
                if (zoomSync) {
                    // 保留切回同步时各图片已有的位置差，后续拖动对每张图应用相同位移。
                    for (let i = 0; i < viewStates.length; i++) {
                        viewStates[i].panX = baseStates[i].panX + deltaX;
                        viewStates[i].panY = baseStates[i].panY + deltaY;
                    }
                    applyImageTransform();
                } else {
                    viewStates[index].panX = baseStates[index].panX + deltaX;
                    viewStates[index].panY = baseStates[index].panY + deltaY;
                    applyImageTransform(index);
                }
            };
            const up = () => {
                window.removeEventListener("mousemove", move, true);
                window.removeEventListener("mouseup", up, true);
            };
            window.addEventListener("mousemove", move, true);
            window.addEventListener("mouseup", up, true);
        });
        holder.addEventListener("auxclick", (e) => { if (e.button === 1) e.preventDefault(); });
    }
    updateZoomModeUI();
    let dragging = false;
    const followWipePointer = (e) => {
        const r = wipeStage.getBoundingClientRect();
        if (!r.width) return;
        wipeX = Math.max(0, Math.min(100, (e.clientX - r.left) / r.width * 100));
        updateWipe();
    };
    // 与视频对比划线一致：悬停移动时分界线持续跟随鼠标，无需按住拖动。
    wipeMain.addEventListener("mousemove", followWipePointer);
    wipeMain.addEventListener("wheel", (e) => {
        if (!wipeOn || wipePair.length !== 2) return;
        e.preventDefault();
        e.stopPropagation();
        const rect = wipeStage.getBoundingClientRect();
        if (!rect.width) return;
        const pointerPct = (e.clientX - rect.left) / rect.width * 100;
        const onTopImage = pointerPct <= wipeX;
        const index = wipePair[onTopImage ? 0 : 1];
        activeIndex = index;
        updateZoomModeUI();
        zoomAt(index, e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY, cells[index].holder);
    }, { passive: false });
    const moveWipe = (e) => { if (dragging) followWipePointer(e); };
    divider.onmousedown = (e) => { dragging = true; e.preventDefault(); };
    overlay._xzgWipeMove = moveWipe;
    overlay._xzgWipeUp = () => { dragging = false; };
    window.addEventListener("mousemove", moveWipe, true);
    window.addEventListener("mouseup", overlay._xzgWipeUp, true);
    win.append(header, grid, wipe); overlay.appendChild(win); document.body.appendChild(overlay);
    overlay._xzgOnKey = (e) => { if (e.key === "Escape") closeSyncPreview(); };
    document.addEventListener("keydown", overlay._xzgOnKey, true);
    return true;
}

// ═══════════════════════════════════════════════════════════════
// 同步预览弹窗
// ═══════════════════════════════════════════════════════════════

let _overlay = null;
let _players = [];
let _forceTimer = null;
let _scrubRAF = null;
let _syncLoopOn = true;
let _syncMuted = false;

function applyCompareAudio(players, muted) {
    // Silence the previous leftmost player before enabling the new one.
    for (const p of players) p.player.setMuted(true);
    if (!muted && players.length) players[0].player.setMuted(false);
}

function closeSyncPreview() {
    if (_forceTimer) {
        clearTimeout(_forceTimer);
        _forceTimer = null;
    }
    if (_scrubRAF) {
        cancelAnimationFrame(_scrubRAF);
        _scrubRAF = null;
    }
    if (_overlay && _overlay._xzgOnKey) {
        document.removeEventListener("keydown", _overlay._xzgOnKey, true);
        _overlay._xzgOnKey = null;
    }
    if (_overlay && _overlay._xzgPanMove) {
        window.removeEventListener("mousemove", _overlay._xzgPanMove, true);
        _overlay._xzgPanMove = null;
    }
    if (_overlay && _overlay._xzgPanUp) {
        window.removeEventListener("mouseup", _overlay._xzgPanUp, true);
        _overlay._xzgPanUp = null;
    }
    if (_overlay && _overlay._xzgWipeMove) {
        window.removeEventListener("mousemove", _overlay._xzgWipeMove, true);
        _overlay._xzgWipeMove = null;
    }
    if (_overlay && _overlay._xzgWipeUp) {
        window.removeEventListener("mouseup", _overlay._xzgWipeUp, true);
        _overlay._xzgWipeUp = null;
    }
    if (_overlay && _overlay._xzgWinResize) {
        window.removeEventListener("resize", _overlay._xzgWinResize);
        _overlay._xzgWinResize = null;
    }
    if (_overlay && _overlay._xzgStopThumbs) {
        _overlay._xzgStopThumbs();
        _overlay._xzgStopThumbs = null;
    }
    for (const p of _players) {
        try { p.destroy(); } catch (_) {}
    }
    _players = [];
    if (_overlay) {
        _overlay.remove();
        _overlay = null;
    }
}

function _ensureStyle() {
    if (document.getElementById("xzg-sync-preview-style")) return;
    const st = document.createElement("style");
    st.id = "xzg-sync-preview-style";
    st.textContent = `
    .xzg-sp-overlay {
        position: fixed; inset: 0; z-index: 2147483000;
        background: rgba(0,0,0,0.6);
        display: flex; align-items: center; justify-content: center;
        font-family: system-ui, sans-serif;
    }
    .xzg-sp-window {
        position: relative;
        width: 100%;
        height: 100%;
        background: #1c1c1e;
        display: flex; flex-direction: column;
        overflow: hidden;
    }
    .xzg-sp-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 10px 16px; background: #222; border-bottom: 1px solid #3f3f3f;
        flex-shrink: 0;
    }
    .xzg-sp-title { font-size: 14px; font-weight: 600; color: #dcc85b; }
    .xzg-sp-close {
        background: transparent; color: #ff6b6b; border: none;
        font-size: 20px; cursor: pointer; line-height: 1; padding: 2px 6px;
    }
    .xzg-sp-close:hover { color: #ff9494; }
    .xzg-sp-grid {
        flex: 1; overflow: hidden; padding: 0 14px 14px; /* 去掉与上方控制栏之间的空白 */
        display: grid; gap: 14px;
    }
    .xzg-sp-cell {
        position: relative; display: flex; flex-direction: column;
        background: #000; border: 1px solid #3f3f3f; border-radius: 8px;
        overflow: hidden;
        min-width: 0;
    }
    .xzg-sp-label {
        position: relative; z-index: 3; /* 固定在自己的位置，缩放/平移视频时不跟随、不被盖住 */
        height: 30px; line-height: 30px; box-sizing: border-box; /* 与划像模式标题栏等高 */
        padding: 0 8px; font-size: 15px; color: #dcc85b; text-align: center;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        background: #232323; flex-shrink: 0;
    }
    [data-xzg-video-preview] .xzg-sp-video-label {
        display: flex; justify-content: center; align-items: center; gap: 8px;
        font-size: 18px;
    }
    .xzg-sp-video-name {
        min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .xzg-sp-video-resolution { flex-shrink: 0; }
    .xzg-sp-player {
        position: relative; flex: 1; min-height: 0;
        background: #000 !important; /* 覆盖播放器 _buildDOM 设置的 inline 灰色 #1a1a1a，视频缩小后填充区为黑色 */
    }
    .xzg-sp-ctrl {
        display: flex; align-items: center; gap: 8px;
        padding: 8px 14px; background: #222; border-top: 1px solid #3f3f3f;
        flex-shrink: 0; flex-wrap: wrap;
    }
    .xzg-sp-btn {
        background: #333; color: #eee; border: 1px solid #4a4a4a;
        border-radius: 6px; padding: 6px 12px; cursor: pointer; font-size: 12px;
    }
    .xzg-sp-btn:hover { background: #444; }
    .xzg-sp-btn-primary { background: #2980b9; border-color: #2980b9; }
    .xzg-sp-btn-primary:hover { background: #3498db; }
    .xzg-sp-btn.active { background: #766c28; border-color: #dcc85b; color: #fff3a0; }
    .xzg-sp-status { font-size: 12px; color: #999; white-space: nowrap; }
    .xzg-sp-scrub {
        display: flex; align-items: center; gap: 8px; flex: 1;
        min-width: 220px;
    }
    .xzg-sp-scrub input[type=range] {
        flex: 1; accent-color: #dcc85b; cursor: pointer;
    }
    .xzg-sp-scrub input[type=range]:focus,
    .xzg-sp-scrub input[type=range]:focus-visible {
        outline: none;
    }
    .xzg-sp-scrub-time { font-size: 12px; color: #bbb; white-space: nowrap; }
    /* 帧数显示：位于时间码左侧，右对齐避免数字跳动 */
    .xzg-sp-scrub-frame { font-size: 12px; color: #bbb; white-space: nowrap; text-align: right; }
    .xzg-sp-wipe {
        position: relative; flex: 1; overflow: hidden; background: #000;
        display: none;
    }
    .xzg-sp-wipe.active { display: flex; }
    .xzg-sp-wipe-main {
        position: relative; /* 分界线的定位基准：贯穿标题栏与画面 */
        display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0;
    }
    .xzg-sp-wipe-stage {
        position: relative; flex: 1; min-width: 0; overflow: hidden; background: #000;
    }
    .xzg-sp-wipe-hint {
        position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
        color: #888; font-size: 13px; pointer-events: none; z-index: 6;
    }
    .xzg-sp-wipe-label {
        flex: none; height: 30px; line-height: 30px; box-sizing: border-box; /* 与并排标题栏等高、同底色 */
        position: relative;
        font-size: 15px;
        color: #dcc85b; background: #232323;
    }
    .xzg-sp-wipe-label > span {
        position: absolute; top: 0; text-align: center;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .xzg-sp-wipe-side { display: none; }
    .xzg-sp-wipe.multi .xzg-sp-wipe-side {
        display: flex; flex-direction: column; gap: 8px; padding: 6px;
        width: 130px; flex: 0 0 130px; overflow-y: auto; overflow-x: hidden;
        background: #141414; border-right: 1px solid #2a2a2a;
    }
    .xzg-sp-wipe-thumb {
        position: relative; width: 100%; height: 136px; flex: 0 0 auto;
        border: 1px solid #3a3a3a; border-radius: 6px;
        background: #000; overflow: hidden; cursor: pointer; box-sizing: border-box;
    }
    .xzg-sp-wipe-thumb canvas { display: block; width: 100%; height: 100%; }
    .xzg-sp-wipe-thumb > img { display: block; width: 100%; height: 100%; object-fit: contain; }
    button.xzg-sp-wipe-thumb { padding: 0; }
    .xzg-sp-wipe-thumb .tag {
        position: absolute; left: 5px; top: 4px; font-size: 14px; color: #ddd;
        max-width: calc(100% - 34px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        text-shadow: 0 1px 2px #000; outline: none;
    }
    .xzg-sp-rename-mask {
        position: absolute; inset: 0; z-index: 60; display: flex;
        align-items: center; justify-content: center; background: rgba(0,0,0,.45);
    }
    .xzg-sp-rename-box {
        width: 280px; padding: 12px; display: flex; flex-direction: column; gap: 10px;
        background: #2a2a2c; border: 1px solid #444; border-radius: 8px;
        box-shadow: 0 12px 30px rgba(0,0,0,.55);
    }
    .xzg-sp-rename-title { font-size: 13px; font-weight: 600; color: #dcc85b; }
    .xzg-sp-rename-input {
        height: 30px; padding: 0 8px; font-size: 13px; color: #eee;
        background: #1c1c1e; border: 1px solid #444; border-radius: 6px; outline: none;
    }
    .xzg-sp-rename-input:focus { border-color: #dcc85b; }
    .xzg-sp-rename-btns { display: flex; justify-content: flex-end; gap: 8px; }
    .xzg-sp-rename-btns button {
        height: 26px; padding: 0 14px; font-size: 12px; color: #ddd;
        background: #333; border: 1px solid #4a4a4a; border-radius: 6px; cursor: pointer;
    }
    .xzg-sp-rename-btns button:last-child {
        color: #111; background: #dcc85b; border-color: #dcc85b; font-weight: 600;
    }
    .xzg-sp-wipe-thumb .chk {
        position: absolute; right: 5px; top: 4px; width: 20px; height: 20px;
        border-radius: 50%; border: 1px solid #666; background: rgba(0,0,0,.55);
        color: #111; font-size: 12px; line-height: 20px; text-align: center;
    }
    .xzg-sp-wipe-thumb.sel { border-color: #dcc85b; box-shadow: 0 0 0 1px rgba(220,200,91,.45); }
    .xzg-sp-wipe-thumb.sel .chk { background: #dcc85b; border-color: #dcc85b; }
    .xzg-sp-wipe-thumb.dim { opacity: .38; pointer-events: none; }
    .xzg-sp-wipe .xzg-sp-player {
        position: absolute; inset: 0;
    }
    .xzg-sp-image-wipe-stage > .xzg-sp-player {
        width: auto !important; height: auto !important; aspect-ratio: auto !important;
    }
    .xzg-sp-wipe .xzg-sp-player.wipe-top {                          /* 图片对比上层：按 --wipe 裁剪 */
        z-index: 2;
        clip-path: inset(0 calc(100% - var(--wipe, 50%)) 0 0);
    }
    .xzg-sp-wipe-divider {
        position: absolute; top: 0; bottom: 0; left: var(--wipe, 50%);
        width: 32px; margin-left: -16px; background: transparent; /* 宽命中区，方便拖动 */
        cursor: ew-resize; z-index: 10;
    }
    .xzg-sp-wipe-divider::before {
        content: ""; position: absolute; top: 0; bottom: 0; left: 50%;
        width: 1px; transform: translateX(-50%);
        background: #dcc85b; box-shadow: 0 0 8px rgba(0,0,0,.7);
    }
    /* 划像区域内禁用元素原生拖拽/文本选中，防止按住拖动时出现禁用光标 */
    .xzg-sp-wipe, .xzg-sp-wipe * { -webkit-user-drag: none; user-select: none; }
    `;
    document.head.appendChild(st);
}

/** items: [{ url, name }]，全部从头一起播放、自动循环 */
function openSyncPreview(items) {
    if (!isVideoCompareEnabled()) return false;
    if (!Array.isArray(items) || items.length === 0) return false;
    _ensureStyle();
    closeSyncPreview();

    const overlay = document.createElement("div");
    overlay.className = "xzg-sp-overlay";
    _overlay = overlay;

    // 居中的统一窗口：所有视频在窗口内排版
    const win = document.createElement("div");
    win.className = "xzg-sp-window";

    // 标题栏
    const closeBtn = document.createElement("button");
    closeBtn.className = "xzg-sp-close";
    closeBtn.textContent = "✕";
    closeBtn.title = "关闭";
    closeBtn.addEventListener("click", closeSyncPreview);
    const videoCompareTitle = document.createElement("span");
    videoCompareTitle.className = "xzg-sp-title";
    videoCompareTitle.textContent = items.length === 1 ? "查看视频" : "视频对比";

    // 网格容器：视频加载完成后按实际宽高比重排；五/六路从一开始就固定三列两行。
    const grid = document.createElement("div");
    grid.className = "xzg-sp-grid";
    const _n = items.length;
    const fixedThreeByTwo = _n === 5 || _n === 6;
    const initialColumns = fixedThreeByTwo ? 3 : (_n === 4 ? 2 : _n);
    const initialRows = fixedThreeByTwo || _n === 4 ? 2 : 1;
    grid.style.gridTemplateColumns = `repeat(${initialColumns}, minmax(0, 1fr))`;
    grid.style.gridTemplateRows = `repeat(${initialRows}, minmax(0, 1fr))`;
    // 双路对比保留更大的预读窗口（受播放器 200MB 预算约束），多路时适当收紧。
    const playbackBufferFrames = _n <= 2 ? 24 : 10;
    const updateVideoLabel = (element, { label, player }) => {
        const width = player.videoWidth, height = player.videoHeight;
        const resolution = width > 0 && height > 0 ? `${width}×${height}` : "";
        const title = resolution ? `${label}  ${resolution}` : label;
        if (element.title === title) return;
        element.title = title;
        const name = document.createElement("span");
        name.className = "xzg-sp-video-name";
        name.textContent = label;
        element.replaceChildren(name);
        if (resolution) {
            const dimensions = document.createElement("span");
            dimensions.className = "xzg-sp-video-resolution";
            dimensions.textContent = resolution;
            element.appendChild(dimensions);
        }
    };
    const players = [];
    for (const it of items) {
        const cell = document.createElement("div");
        cell.className = "xzg-sp-cell";
        const label = document.createElement("div");
        label.className = "xzg-sp-label xzg-sp-video-label";
        const filename = (it.name || _extractFilename(it.url)).split(/[\\/]/).pop() || "video.mp4";
        const holder = document.createElement("div");
        holder.className = "xzg-sp-player";
        cell.appendChild(label);
        cell.appendChild(holder);
        grid.appendChild(cell);
        const player = new XiaozhuguangVideoPlayer({
            container: holder,
            placeholderText: "加载中...",
            fit: "contain", // 保持原比例、不裁剪，在播放区域内居中最大化
            ui: false, // 隐藏播放器内置 UI（进度条/红蓝条/时间码/循环·静音按钮）
            exclusiveDecoder: true, // 多视频同时 seek 对比：每个播放器独立解码，避免共享解码器渲染状态互相抢占
            preserveSourceQuality: true,
            playbackBufferFrames,
            // Read the source once before caching, so frame decoding never waits on Range requests.
            // 点击任一视频画面切换播放/暂停时，同步所有视频（与左下角按钮一致：从暂停处继续）
            onPlay: () => syncResume(),
            onPause: () => syncPause(),
        });
        player.setMuted(players.length !== 0); // 默认只播放最左侧视频的音频。
        // 各自套用节点的裁剪区间（跳过帧数/帧数上限）：左侧可只播自己的区间、右侧播完整，
        // 起播与逐帧都按「各自区间内的相对帧号」对齐（见 seekPlayerToOffset）
        if (it.skipFrames || it.frameLimit) {
            try { player.setLoadRange(it.skipFrames || 0, it.frameLimit || 0); } catch (_) {}
        }
        const entry = { player, url: it.url, holder, cell, labelEl: label, label: filename };
        players.push(entry);
        updateVideoLabel(label, entry);
        // closeSyncPreview owns disposal, including players still loading.
        _players.push(player);
    }
    const videoArea = document.createElement("div");
    videoArea.style.cssText = "position:relative;display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden";
    // 屏蔽预览区/缩略图上的浏览器右键菜单（播放器若有自定义右键并阻止冒泡则不受影响）
    videoArea.addEventListener("contextmenu", (e) => e.preventDefault());
    videoArea.appendChild(grid);
    win.appendChild(videoArea);
    const bufferPanel = document.createElement("div");
    bufferPanel.style.cssText = "position:absolute;inset:0;z-index:30;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:rgba(0,0,0,.7);color:white";
    bufferPanel.setAttribute("role", "status");
    const bufferText = document.createElement("span");
    const bufferProgress = document.createElement("progress");
    bufferProgress.max = 100;
    bufferProgress.value = 0;
    bufferProgress.style.cssText = "width: min(360px, 70%);height:16px;accent-color:#e5b55a";
    bufferPanel.append(bufferText, bufferProgress);
    videoArea.appendChild(bufferPanel);
    let mediaReady = false;
    let groupStartTime = null;
    let groupStallStarted = null;
    let groupStalledMs = 0;
    let groupFrame = 0;
    let clockTick = null;
    let clockValue = null;
    const showBuffer = (text, progress) => {
        bufferText.textContent = text;
        bufferProgress.value = progress;
        bufferPanel.style.display = "flex";
    };
    const playbackReadyGate = () => {
        if (groupStartTime != null) return groupStartTime;
        const states = players.map(p => p.player.getPlaybackBufferState());
        if (!mediaReady || states.some(s => !s.exhausted && s.bufferedFrames < s.targetFrames)) return null;
        groupStartTime = performance.now();
        groupStallStarted = null;
        groupStalledMs = 0;
        groupFrame = 0;
        clockTick = null;
        bufferPanel.style.display = "none";
        return groupStartTime;
    };
    const playbackGroupClock = (tick) => {
        if (tick === clockTick) return clockValue;
        clockTick = tick;
        const missingFrames = players.some(({ player }) => {
            const state = player.getPlaybackBufferState();
            return !state.exhausted && state.bufferedFrames === 0;
        });
        if (missingFrames) {
            groupStallStarted ??= tick;
            clockValue = null;
            return clockValue;
        }
        if (groupStallStarted != null) {
            groupStalledMs += tick - groupStallStarted;
            groupStallStarted = null;
        }
        const frameMs = 1000 / playerFps(pickMain());
        const dueFrame = Math.floor((tick - groupStalledMs - groupStartTime + 0.1) / frameMs);
        if (dueFrame > groupFrame) groupFrame++;
        clockValue = groupStartTime + groupFrame * frameMs;
        return clockValue;
    };
    for (const p of players) {
        p.player.playbackReadyGate = playbackReadyGate;
    }

    // 划像对比容器：多路时左侧是缩略图选择栏，右侧舞台内叠加选中的两路做划像
    const wipe = document.createElement("div");
    wipe.className = "xzg-sp-wipe";
    const wipeSide = document.createElement("div");
    wipeSide.className = "xzg-sp-wipe-side";
    const wipeStage = document.createElement("div");
    wipeStage.className = "xzg-sp-wipe-stage";
    const wipeHint = document.createElement("div");
    wipeHint.className = "xzg-sp-wipe-hint";
    // 在预览上方显示当前名称（可在缩略图上双击临时命名）。
    const wipeLabel = document.createElement("div");
    wipeLabel.className = "xzg-sp-wipe-label";
    wipeLabel.style.display = "none";
    const wipeLabels = [document.createElement("span"), document.createElement("span")];
    wipeLabels.forEach(label => { label.className = "xzg-sp-video-label"; });
    wipeLabel.append(...wipeLabels);
    const wipeDivider = document.createElement("div");
    wipeDivider.className = "xzg-sp-wipe-divider";
    wipeDivider.style.display = "none";
    const wipeMain = document.createElement("div");
    wipeMain.className = "xzg-sp-wipe-main";
    wipeStage.append(wipeHint);
    wipeMain.append(wipeLabel, wipeStage, wipeDivider); // 分界线放在标题栏之上，贯穿到画面
    wipe.append(wipeSide, wipeMain);
    videoArea.appendChild(wipe);

    // 控制栏
    const ctrl = document.createElement("div");
    ctrl.className = "xzg-sp-ctrl";
    const mkBtn = (text, tip, cls) => {
        const b = document.createElement("button");
        b.className = "xzg-sp-btn" + (cls ? " " + cls : "");
        b.textContent = text;
        b.title = tip;
        return b;
    };

    let playing = false;
    const playPauseBtn = mkBtn("▶ 播放", _n === 1 ? "播放视频（从头开始）" : "播放全部（从头开始）", "xzg-sp-btn-primary");
    const prevFrameBtn = mkBtn("◀ 上一帧", "上一帧（快捷键 ←）");
    const nextFrameBtn = mkBtn("下一帧 ▶", "下一帧（快捷键 →）");
    const restartBtn = mkBtn("⏮ 回到开头", _n === 1 ? "回到开头重新播放" : "全部回到开头重新播放");
    const muteBtn = mkBtn("🔊", "静音开关（默认仅播放最左侧视频的音频）");
    const zoomSyncBtn = mkBtn(_n === 1 ? "🔗 缩放联动" : "🔗 同步中", _n === 1 ? "切换缩放和移动模式；也可双击视频切换" : "切换视频缩放和移动同步状态；也可双击视频切换");
    const zoomBtn = mkBtn("🔍 100%", "滚轮缩放视频，点击重置");
    const wipeBtn = mkBtn("🔀 划像对比", _n > 2 ? "左侧勾选两个视频，只对这两路做划像对比" : "拖动金色分界线左右对比");
    if (_n < 2) wipeBtn.style.display = "none"; // 单视频无需划像对比
    const ultrawideBtn = mkBtn("🖥 带鱼屏", "双路竖屏时让视频靠近中间，避免在带鱼屏上相距过远");
    if (_n !== 2) ultrawideBtn.style.display = "none";
    let ultrawideMode = false;
    // 播放台：共享进度条，同时控制所有视频的播放进度（按各自时长的比例同步跳转）
    const scrubWrap = document.createElement("div");
    scrubWrap.className = "xzg-sp-scrub";
    const scrubFrame = document.createElement("span");
    scrubFrame.className = "xzg-sp-scrub-frame";
    scrubFrame.textContent = "帧 0/0";
    const scrubTime = document.createElement("span");
    scrubTime.className = "xzg-sp-scrub-time";
    scrubTime.textContent = "00:00 / 00:00";
    const scrubRange = document.createElement("input");
    scrubRange.type = "range";
    scrubRange.min = 0; scrubRange.max = 1000; scrubRange.value = 0;
    scrubRange.title = _n === 1 ? "控制视频的播放进度" : "同步控制所有视频的播放进度";
    scrubWrap.appendChild(scrubFrame);
    scrubWrap.appendChild(scrubTime);
    scrubWrap.appendChild(scrubRange);
    const statusEl = document.createElement("span");
    statusEl.className = "xzg-sp-status";
    statusEl.textContent = "加载中...";

    // 最高帧率作为时间轴锚点，同帧率时保留画布顺序。
    const pickMain = () => {
        let main = null;
        for (const p of players) {
            const d = p.player.duration;
            if (d > 0 && isFinite(d) && (!main || playerFps(p) > playerFps(main))) main = p;
        }
        return main || players[0];
    };
    // ── 按「各自区间内的相对帧号」对齐各路视频 ──────────────────────────
    // 各路可以有自己的裁剪区间：左侧 100~200（100 帧）、右侧 0~100（100 帧）时，
    // 左边第 100 帧对应右边第 0 帧 —— 两边都从「自己区间的起点」开始，按偏移一起播/逐帧。
    const playerFps = (p) => (p.player.getFrameRate ? p.player.getFrameRate() : (p.player._frameRate || 24)) || 24;
    const playerEndFrame = (p) => {
        let end = 0;
        try { end = p.player._computeEndFrame ? p.player._computeEndFrame() : 0; } catch (_) {}
        if (!end || end <= 0) end = p.player.getSourceTotalFrames ? p.player.getSourceTotalFrames() : 0;
        return end;
    };
    // 某一路的区间：skip=起点帧，len=区间帧数
    const playerRange = (p) => {
        const skip = Math.max(0, Number(p.player._skipFrames) || 0);
        const stop = playerEndFrame(p);
        return { skip, len: Math.max(0, stop - skip) };
    };
    // Use the main video's frame units on the shared timeline. Other frame
    // rates must map through seconds, not through equal source frame numbers.
    const compareLength = () => {
        const fps = playerFps(pickMain());
        const lens = players.map((p) => playerRange(p).len / playerFps(p) * fps).filter((n) => n > 0);
        return lens.length ? Math.min(...lens) : 0;
    };
    // 对比时间轴长度（帧）：进度条/时间码都按它换算，与各路的跳过帧无关（始终从 0 开始）
    const timelineFrames = () => {
        const len = compareLength();
        if (len > 0) return len;
        const main = pickMain();
        return playerRange(main).len || Math.round((main.player.duration || 0) * playerFps(main));
    };
    // 某一路当前位于「自己区间内」的第几帧
    const playerOffsetFrames = (p) => {
        const elapsed = (p.player.currentTime || 0) - playerRange(p).skip / playerFps(p);
        return elapsed * playerFps(pickMain());
    };
    // 按「区间内偏移」seek：各自 seek 到自身起点 + offset，并 clamp 在自己的区间内
    const seekPlayerToOffset = (p, offset) => {
        const { skip, len } = playerRange(p);
        const localOffset = offset / playerFps(pickMain()) * playerFps(p);
        const off = Math.max(0, len > 0 ? Math.min(localOffset, len) : localOffset);
        try { return p.player.seek((skip + off) / playerFps(p)); } catch (_) {}
    };
    const seekAllToOffset = (offset) => {
        return Promise.all(players.map(p => seekPlayerToOffset(p, offset)));
    };
    const fmtTime = (t) => {
        if (!isFinite(t) || t < 0) t = 0;
        const m = Math.floor(t / 60), s = Math.floor(t % 60);
        return (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
    };
    let _scrubbing = false;
    let resumeAfterScrub = false;
    let scrubPreviewPending = false;
    let pendingScrubOffset = null;
    let _loopRestarting = false; // 共享循环重启中（避免 rAF 重复触发）
    const scrubOffset = (length) => Math.min(length, Math.round(+scrubRange.value / 1000 * length));
    const previewScrub = async () => {
        if (scrubPreviewPending) return;
        scrubPreviewPending = true;
        try {
            // 按需读取时等待两路返回，再预览最新位置，避免连续拖动取消每一次读帧。
            while (_scrubbing && _overlay === overlay && pendingScrubOffset != null) {
                const offset = pendingScrubOffset;
                pendingScrubOffset = null;
                await seekAllToOffset(offset);
            }
        } finally {
            scrubPreviewPending = false;
        }
    };
    scrubRange.addEventListener("input", () => {
        if (!mediaReady) return;
        if (!_scrubbing) {
            _scrubbing = true;
            resumeAfterScrub = playing;
            if (playing) syncPause();
        }
        const main = pickMain();
        const fps = playerFps(main);
        const len = timelineFrames();
        const off = scrubOffset(len);
        // 时间码按对比时间轴显示（0 起 → 区间长度），不显示源片绝对时间
        scrubTime.textContent = fmtTime(off / fps) + " / " + fmtTime(len / fps);
        scrubFrame.textContent = `帧 ${Math.round(off)}/${Math.round(len)}`;
        pendingScrubOffset = off;
        void previewScrub();
    });
    const finishScrub = () => {
        if (!_scrubbing) return;
        _scrubbing = false;
        pendingScrubOffset = null;
        const length = timelineFrames();
        const offset = scrubOffset(length);
        if (resumeAfterScrub && offset < length) syncResume(offset);
        else seekAllToOffset(offset);
        try { scrubRange.blur(); } catch (_) {}
    };
    scrubRange.addEventListener("change", finishScrub);
    scrubRange.addEventListener("pointercancel", finishScrub);
    // 点击/拖动进度条结束后主动释放焦点，避免播放条被键盘焦点高亮边框包裹
    scrubRange.addEventListener("pointerup", () => {
        // 延后一拍，先让原生 change 事件完成（重置拖动标记），再释放焦点
        setTimeout(() => {
            if (_overlay !== overlay) return;
            finishScrub();
            try { scrubRange.blur(); } catch (_) {}
        }, 0);
    });
    // Check time drift frequently; tolerate frame timestamp quantization,
    // rather than allowing a visible quarter-second gap to persist.
    let _lastAlignAt = 0;
    const ALIGN_INTERVAL = 100;
    const alignPlayers = (now) => {
        if (groupStartTime == null) return;
        if (!playing) return; // 暂停时不强制对齐：避免逐帧浏览时各播放器帧位被拉回主时间
        if (players.every(({ player }) => player.playbackGroupClock)) return;
        if (_lastAlignAt && now - _lastAlignAt < ALIGN_INTERVAL) return;
        _lastAlignAt = now;
        const main = pickMain();
        if (!isFinite(main.player.currentTime)) return;
        // 以「各自区间内的偏移帧」比较漂移（绝对时间因起点不同不可直接比）
        const mainOff = playerOffsetFrames(main);
        for (const p of players) {
            if (p === main) continue;
            const d = p.player.duration;
            if (!d || !isFinite(d) || d <= 0) continue;
            const drift = Math.abs(playerOffsetFrames(p) - mainOff) / playerFps(main);
            const tolerance = 1.5 / Math.min(playerFps(main), playerFps(p));
            if (drift > tolerance) {
                seekPlayerToOffset(p, mainOff);
            }
        }
    };
    const updateBufferStatus = (now) => {
        if (!playing) return;
        const stalled = groupStallStarted != null && now - groupStallStarted >= 300;
        const text = stalled ? "⏳ 等待帧缓存" : "▶ 播放中（自动循环）";
        if (statusEl.textContent !== text) statusEl.textContent = text;
    };
    // 播放中每帧平滑刷新进度条（拖动时暂停刷新；仅数值变化时写入 DOM，避免无谓开销）
    const scrubTick = () => {
        const now = performance.now();
        if (!_scrubbing) {
            // 最高帧率一路走到共同区间末尾时，所有视频一起回到各自的起点。
            if (playing && !_loopRestarting && groupStartTime != null) {
                const ref = pickMain();
                const len = timelineFrames();
                if (ref && len > 0 && playerOffsetFrames(ref) >= len - 1) {
                    _loopRestarting = true;
                    try { syncPlayFromStart(); } catch (_) {}
                    setTimeout(() => { _loopRestarting = false; }, 150);
                }
            }
            alignPlayers(now);
            updateBufferStatus(now);
            const main = pickMain();
            if (main.player.duration > 0) {
                // 进度条与时间码统一按「对比时间轴」：0 → 区间长度，不受跳过帧影响
                const fps = playerFps(main);
                const len = timelineFrames();
                if (len > 0) {
                    const off = Math.max(0, Math.min(len, playerOffsetFrames(main)));
                    const v = Math.max(0, Math.min(1000, Math.round((off / len) * 1000)));
                    if (v !== scrubRange.value) scrubRange.value = v;
                    const txt = fmtTime(off / fps) + " / " + fmtTime(len / fps);
                    if (txt !== scrubTime.textContent) scrubTime.textContent = txt;
                    const frameTxt = `帧 ${Math.round(off)}/${Math.round(len)}`;
                    if (frameTxt !== scrubFrame.textContent) scrubFrame.textContent = frameTxt;
                }
            }
        }
        _scrubRAF = requestAnimationFrame(scrubTick);
    };
    _scrubRAF = requestAnimationFrame(scrubTick);

    // 同步播放/暂停：点击任一视频画面（或左下角按钮）时，所有视频一起播放/暂停
    // _syncing 防止同步动作再次触发 onPlay/onPause 造成递归
    let _syncing = false;
    // 暂停后各路最后显示的帧可能不同。恢复时用同一个区间偏移重建起播基准。
    const syncResume = (offset = playerOffsetFrames(pickMain())) => {
        if (_syncing || !mediaReady) return;
        groupStartTime = null;
        _syncing = true;
        try {
            for (const p of players) {
                if (p.player.isPlaying) p.player.pause();
            }
            seekAllToOffset(offset >= timelineFrames() ? 0 : offset);
            for (const p of players) {
                p.player.play();
            }
            playing = true;
            playPauseBtn.textContent = "⏸ 暂停";
            statusEl.textContent = "▶ 播放中（自动循环）";
        } finally { _syncing = false; }
    };
    // 从头一起播放：各路回到「自己区间的起点」再一起播（左侧 100 帧 ↔ 右侧 0 帧）
    const syncPlayFromStart = () => syncResume(0);
    const syncPause = () => {
        if (_syncing) return;
        _syncing = true;
        try {
            for (const p of players) p.player.pause();
            playing = false;
            groupStallStarted = null;
            playPauseBtn.textContent = "▶ 播放";
            bufferPanel.style.display = mediaReady ? "none" : "flex";
            statusEl.textContent = "已暂停";
        } finally { _syncing = false; }
    };
    // 左下角播放按钮：从暂停处继续；点击视频 onPlay 同样走继续播放
    const playAll = syncResume;
    const pauseAll = syncPause;
    const restartAll = () => {
        if (playing) syncPlayFromStart();
        else seekAllToOffset(0);
    };
    // 逐帧浏览：先暂停全部，然后按「区间内偏移 ± delta」同步跳帧。
    // 左侧区间 100~200、右侧 0~100 时，左侧第 100+k 帧 ↔ 右侧第 0+k 帧，按偏移严格对齐。
    const stepFrame = (delta) => {
        if (!mediaReady) return;
        _syncing = true;
        try {
            for (const p of players) p.player.pause();
        } finally { _syncing = false; }
        playing = false;
        playPauseBtn.textContent = "▶ 播放";
        statusEl.textContent = "已暂停";
        const main = pickMain();
        const targetOffset = Math.max(0, Math.min(timelineFrames(), playerOffsetFrames(main) + delta));
        seekAllToOffset(targetOffset);
    };
    prevFrameBtn.addEventListener("click", () => stepFrame(-1));
    nextFrameBtn.addEventListener("click", () => stepFrame(1));

    playPauseBtn.addEventListener("click", () => {
        if (playing) pauseAll(); else playAll();
    });
    restartBtn.addEventListener("click", restartAll);
    muteBtn.addEventListener("click", () => {
        _syncMuted = !_syncMuted;
        muteBtn.textContent = _syncMuted ? "🔇" : "🔊";
        applyCompareAudio(players, _syncMuted);
    });

    // ── 划像对比 ─────────────────────────────────────────────
    // 2 路：直接整屏叠加划像；
    // 3 路以上：进入划像后左侧出现缩略图，最多勾选两个视频，只对这两路做划像。
    let wipeMode = false;
    let _wipeEdge = 50;          // 分界线位置（0-100，未缩放坐标）
    let _wipePair = [];          // 参与划像的两个视频下标（第一个在左）
    const _thumbItems = [];      // 左侧缩略图 { index, el, canvas, ctx, check }
    let _thumbTimer = null;
    // 关闭窗口时停止缩略图刷新，避免定时器泄漏
    overlay._xzgStopThumbs = () => {
        if (_thumbTimer) { clearInterval(_thumbTimer); _thumbTimer = null; }
    };

    const _updateWipeLabels = () => {
        const ready = _wipePair.length === 2;
        wipeLabel.style.display = ready ? "" : "none";
        if (!ready) return;
        const stage = wipeStage.getBoundingClientRect();
        wipeLabels.forEach((label, side) => {
            const entry = players[_wipePair[side]];
            const { player, holder } = entry;
            updateVideoLabel(label, entry);
            const canvas = player._canvas;
            const frame = canvas?.getBoundingClientRect() ?? stage;
            const pane = holder.getBoundingClientRect();
            const split = pane.left + pane.width * _wipeEdge / 100;
            let width = frame.width;
            if (canvas?.width && canvas.height && canvas.style.objectFit === "contain") {
                const rotated = /rotate\((90|270)deg\)/.test(canvas.style.transform);
                const ratio = rotated ? canvas.height / canvas.width : canvas.width / canvas.height;
                width = Math.min(width, frame.height * ratio);
            }
            const contentLeft = frame.left + (frame.width - width) / 2;
            const left = Math.max(stage.left, pane.left, contentLeft, side === 1 ? split : stage.left);
            const right = Math.min(stage.right, pane.right, contentLeft + width, side === 0 ? split : stage.right);
            label.style.left = `${left - stage.left}px`;
            label.style.width = `${Math.max(0, right - left)}px`;
        });
    };

    const _applyWipePair = () => {
        for (const p of players) p.holder.style.clipPath = "";
        if (_wipePair.length !== 2) return;
        // 不限制在 0~100：缩放/平移后内容边界可能超出舞台，裁切值允许越界
        const e = _wipeEdge;
        // 左侧显示先勾选的视频，右侧显示后勾选的视频（默认 A 在左、B 在右）
        players[_wipePair[0]].holder.style.clipPath = `inset(0 ${100 - e}% 0 0)`; // 左
        players[_wipePair[1]].holder.style.clipPath = `inset(0 0 0 ${e}%)`;        // 右
    };
    // 分界线跟随缩放/平移后的裁切边界
    const updateDividerPos = () => {
        if (_wipePair.length !== 2) return;
        const W = wipeStage.clientWidth;
        if (!W) return;
        const idx = _wipePair[0];
        const t0 = _holderT[idx] || { x: 0, y: 0 };
        const s = _zoomScales[idx] || 1;
        const leftPct = _wipeEdge * s + (t0.x / W) * 100;
        wipeDivider.style.left = Math.max(-4, Math.min(104, leftPct)) + "%";
        _updateWipeLabels();
    };
    // 选中的两路放进舞台，其余留在舞台但隐藏（保持解码/缩略图刷新）
    const _layoutWipePair = () => {
        const ready = _wipePair.length === 2;
        players.forEach((p, i) => {
            const selected = _wipePair.includes(i);
            p.holder.style.position = "absolute";
            p.holder.style.inset = "0";
            p.holder.style.visibility = selected ? "" : "hidden";
            if (p.holder.parentElement !== wipeStage) wipeStage.appendChild(p.holder);
        });
        wipeMain.appendChild(wipeDivider); // 分界线始终在最上层
        wipeDivider.style.display = ready ? "" : "none";
        wipeHint.style.display = ready ? "none" : "";
        wipeHint.textContent = _wipePair.length === 0
            ? "在左侧勾选两个视频进行划像对比"
            : "再勾选一个视频开始划像";
        _applyWipePair();
        _updateWipeLabels();
        requestAnimationFrame(() => {
            for (const p of players) {
                try { p.player.resize?.() } catch (_) {}
            }
            recordHolderBase();
            updateDividerPos();
        });
    };
    const _renderThumbs = () => {
        const maxed = _wipePair.length >= 2;
        for (const t of _thumbItems) {
            const sel = _wipePair.includes(t.index);
            t.el.classList.toggle("sel", sel);
            t.el.classList.toggle("dim", !sel && maxed);
            t.check.textContent = sel ? "✓" : "";
        }
    };
    const _drawThumbs = () => {
        for (const t of _thumbItems) {
            const canvas = t.canvas;
            const ctx = t.ctx;
            ctx.fillStyle = "#000";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            const src = players[t.index].player._canvas;
            if (!src || !src.width || !src.height) continue;
            const s = Math.min(canvas.width / src.width, canvas.height / src.height);
            const dw = src.width * s;
            const dh = src.height * s;
            ctx.drawImage(src, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
        }
    };
    // 临时命名对话框（右键缩略图打开）
    const renameMask = document.createElement("div");
    renameMask.className = "xzg-sp-rename-mask";
    renameMask.style.display = "none";
    const renameBox = document.createElement("div");
    renameBox.className = "xzg-sp-rename-box";
    const renameTitle = document.createElement("div");
    renameTitle.className = "xzg-sp-rename-title";
    renameTitle.textContent = "重命名";
    const renameInput = document.createElement("input");
    renameInput.className = "xzg-sp-rename-input";
    renameInput.maxLength = 10;
    renameInput.placeholder = "输入临时名称（最多 10 字）";
    const renameBtns = document.createElement("div");
    renameBtns.className = "xzg-sp-rename-btns";
    const renameCancelBtn = document.createElement("button");
    renameCancelBtn.textContent = "取消";
    const renameOkBtn = document.createElement("button");
    renameOkBtn.textContent = "确定";
    renameBtns.append(renameCancelBtn, renameOkBtn);
    renameBox.append(renameTitle, renameInput, renameBtns);
    renameMask.appendChild(renameBox);
    win.appendChild(renameMask);
    let _renameIndex = -1;
    const closeRename = () => {
        renameMask.style.display = "none";
        _renameIndex = -1;
    };
    const commitRename = () => {
        if (_renameIndex >= 0) {
            const text = renameInput.value.replace(/\s+/g, " ").trim().slice(0, 10);
            if (text) players[_renameIndex].label = text;
            const item = _thumbItems.find((t) => t.index === _renameIndex);
            const pl = players[_renameIndex];
            if (item) item.tag.textContent = item.tag.title = pl.label;
            updateVideoLabel(pl.labelEl, pl);
            _updateWipeLabels();
        }
        closeRename();
    };
    const openRename = (i) => {
        _renameIndex = i;
        renameInput.value = players[i].label;
        renameMask.style.display = "flex";
        requestAnimationFrame(() => { renameInput.focus(); renameInput.select(); });
    };
    renameOkBtn.addEventListener("click", commitRename);
    renameCancelBtn.addEventListener("click", closeRename);
    renameMask.addEventListener("mousedown", (e) => { if (e.target === renameMask) closeRename(); });
    renameInput.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); commitRename(); }
        else if (e.key === "Escape") { e.preventDefault(); closeRename(); }
    });
    // 并排视图每个视频顶部的名称：右键同样弹出重命名对话框
    players.forEach((p, i) => {
        if (!p.labelEl) return;
        p.labelEl.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            openRename(i);
        });
    });
    // 划像时显示左侧缩略图栏（两路也显示，方便右键重命名；3 路以上还可勾选参与对比的两路）
    if (_n >= 2) {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        players.forEach((p, i) => {
            const el = document.createElement("div");
            el.className = "xzg-sp-wipe-thumb";
            const canvas = document.createElement("canvas");
            canvas.width = Math.round(118 * dpr);
            canvas.height = Math.round(136 * dpr);
            const tag = document.createElement("div");
            tag.className = "tag";
            tag.textContent = p.label;
            tag.title = p.label;
            // 右键缩略图 → 弹出对话框临时命名（名称会显示在划像画面两侧）
            el.addEventListener("contextmenu", (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!wipeMode) return;
                openRename(i);
            });
            const check = document.createElement("div");
            check.className = "chk";
            el.append(canvas, tag, check);
            el.addEventListener("click", () => {
                if (!wipeMode) return;
                if (_n === 2) return; // 只有两路时固定都参与对比，点击不取消
                const selected = _wipePair.includes(i);
                if (!selected && _wipePair.length >= 2) return; // 最多两个
                _wipePair = selected
                    ? _wipePair.filter((x) => x !== i)
                    : _wipePair.concat(i).sort((a, b) => a - b); // 按列表顺序：左为靠前的一路
                // 保持当前缩放/平移与分界线位置，仅切换参与对比的视频
                _layoutWipePair();
                _renderThumbs();
            });
            wipeSide.appendChild(el);
            _thumbItems.push({ index: i, el, canvas, ctx: canvas.getContext("2d"), check, tag });
        });
    }
    const setWipeMode = (on) => {
        if (_n < 2) return;
        wipeMode = on;
        if (on) {
            grid.style.display = "none";
            wipe.classList.add("active");
            wipe.classList.toggle("multi", _n >= 2); // 两路也显示左侧缩略图
            _wipeEdge = 50;
            // 默认选中前两路：A 在左、B 在右（多路可在左侧改选）
            _wipePair = [0, 1];
            for (const p of players) {
                p.holder.style.position = "absolute";
                p.holder.style.inset = "0";
                p.holder.style.clipPath = "";
                wipeStage.appendChild(p.holder);
            }
            wipeMain.appendChild(wipeDivider);
            if (_n === 2) {
                wipeDivider.style.display = "";
                wipeHint.style.display = "none";
                _applyWipePair();
                _updateWipeLabels();
                // 进入后按实际布局定位分界线与名称（缩放/平移状态下也能对齐）
                requestAnimationFrame(() => {
                    for (const p of players) {
                        try { p.player.resize?.() } catch (_) {}
                    }
                    recordHolderBase();
                    updateDividerPos();
                });
            } else {
                _layoutWipePair();
            }
            _renderThumbs();
            _drawThumbs();
            if (_thumbTimer) clearInterval(_thumbTimer);
            _thumbTimer = setInterval(_drawThumbs, 400);
        } else {
            if (_thumbTimer) { clearInterval(_thumbTimer); _thumbTimer = null; }
            wipe.classList.remove("active", "multi");
            wipeDivider.style.display = "none";
            wipeLabel.style.display = "none";
            grid.style.display = "";
            for (const p of players) {
                p.cell.appendChild(p.holder);
                // 恢复播放器默认布局（position:relative 由播放器自己管理，这里清空内联覆盖）
                p.holder.style.position = "";
                p.holder.style.inset = "";
                p.holder.style.visibility = "";
                p.holder.style.clipPath = "";
            }
            _wipePair = [];
            _renderThumbs();
        }
        // 切换视图时重置缩放/平移，避免残留 transform 造成错乱
        for (const p of players) {
            p.holder.style.transform = "none";
            p.holder.style.transformOrigin = "0 0";
        }
        _holderT = players.map(() => ({ x: 0, y: 0 }));
        _zoomScales = players.map(() => 1);
        applyZoomText();
        // 布局/画布尺寸变化后重录基线并校准
        requestAnimationFrame(() => {
            for (const p of players) {
                try { p.player.resize?.() } catch (_) {}
            }
            recordHolderBase();
            if (wipeMode) {
                _applyWipePair();
                updateDividerPos();
            }
        });
        wipeBtn.textContent = on ? "⬒ 并排对比" : "🔀 划像对比";
    };
    wipeBtn.addEventListener("click", () => setWipeMode(!wipeMode));

    // 划像交互：鼠标在舞台内移动即移动分界线（无需按住左键）；分界线也支持按住拖动。
    // 舞台和分界线统一切换整组播放状态。
    let _wiping = false;          // 分界线拖动中
    let _downX = 0, _downY = 0, _downMoved = false; // 按住移动判定：拖动后抑制 click，避免误触播放/暂停
    // 鼠标位置 → 未缩放坐标百分比（消除缩放/平移影响，与 clip-path 坐标一致）
    // 不做 0~100 夹取：缩放/平移后内容坐标可超出舞台，否则分界线会在中途“划不动”
    const pointerContentPct = (e) => {
        const r = wipeStage.getBoundingClientRect();
        if (!r.width) return null;
        const idx = _wipePair[0] ?? 0;
        const t0 = _holderT[idx] || { x: 0, y: 0 };
        const s = _zoomScales[idx] || 1;
        const px = Math.max(0, Math.min(r.width, e.clientX - r.left));
        return ((px - t0.x) / (r.width * s)) * 100;
    };
    const moveEdge = (x) => {
        if (!wipeMode || _wipePair.length !== 2) return;
        _wipeEdge = x;
        _applyWipePair();
        updateDividerPos();
    };
    wipeMain.addEventListener("mousemove", (e) => {
        if (!_downMoved && Math.abs(e.clientX - _downX) + Math.abs(e.clientY - _downY) > 4) _downMoved = true;
        if (_wiping || _wipePair.length !== 2) return; // 拖动中由 onWipeMove 接管
        const x = pointerContentPct(e);
        if (x != null) moveEdge(x);
    });
    // 快速滑动时鼠标可能一次就跨出舞台，最后一帧采样会停在半路（看起来像卡住）。
    // 指针横向离开舞台时直接贴到对应边界，保证快速划到最左/最右。
    wipeStage.addEventListener("mouseleave", (e) => {
        if (!wipeMode || _wiping || _wipePair.length !== 2) return;
        const r = wipeStage.getBoundingClientRect();
        if (e.clientX <= r.left) moveEdge(0);
        else if (e.clientX >= r.right) moveEdge(100);
    });
    wipeMain.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        _downX = e.clientX; _downY = e.clientY;
        _downMoved = false;
        const divider = e.target.closest?.(".xzg-sp-wipe-divider");
        if (!divider || _wipePair.length !== 2) return;
        e.preventDefault();
        e.stopPropagation();
        _wiping = true;
        const x = pointerContentPct(e);
        if (x != null) moveEdge(x);
    });
    wipeMain.addEventListener("click", (e) => {
        if (!wipeMode || _wipePair.length !== 2) return;
        e.stopPropagation();
        if (playing) pauseAll(); else playAll();
    }, true);
    const onWipeMove = (e) => {
        if (!_wiping) return;
        if (!_downMoved && Math.abs(e.clientX - _downX) + Math.abs(e.clientY - _downY) > 4) _downMoved = true;
        const x = pointerContentPct(e);
        if (x != null) moveEdge(x); // 分界线按住拖动：跟手
    };
    const onWipeUp = () => {
        if (_wiping && _downMoved) _suppressClick = true; // 拖动分界线后抑制 click，避免误触播放/暂停
        _wiping = false;
        _downMoved = false;
    };
    window.addEventListener("mousemove", onWipeMove, true);
    window.addEventListener("mouseup", onWipeUp, true);
    overlay._xzgWipeMove = onWipeMove;
    overlay._xzgWipeUp = onWipeUp;
    // 窗口尺寸变化后重新对齐裁切边界与分界线
    const onWinResize = () => {
        if (!wipeMode) return;
        _applyWipePair();
        updateDividerPos();
    };
    window.addEventListener("resize", onWinResize);
    overlay._xzgWinResize = onWinResize;

    ctrl.appendChild(videoCompareTitle);
    ctrl.appendChild(playPauseBtn);
    ctrl.appendChild(prevFrameBtn);
    ctrl.appendChild(nextFrameBtn);
    ctrl.appendChild(restartBtn);
    ctrl.appendChild(muteBtn);
    ctrl.appendChild(zoomSyncBtn);
    ctrl.appendChild(zoomBtn);
    ctrl.appendChild(wipeBtn);
    ctrl.appendChild(ultrawideBtn);
    ctrl.appendChild(scrubWrap);
    ctrl.appendChild(statusEl);
    closeBtn.style.marginLeft = "auto";
    ctrl.appendChild(closeBtn);
    // 控制栏（菜单 + 播放台）置于窗口最顶部，视频区之下
    win.insertBefore(ctrl, videoArea);
    overlay.appendChild(win);

    document.body.appendChild(overlay);
    // 点击窗口外遮罩关闭
    overlay.addEventListener("click", (e) => {
        if (e.target === overlay) closeSyncPreview();
    });

    // 滚轮同步缩放：以鼠标处为锚点的 zoom-to-cursor。
    // 每个窗格用独立 translate + scale，所有窗格同步同倍率；
    // 锚点统一取"鼠标所在窗格内的相对位置"，放大时鼠标指向的内容点保持不动，便于多窗格对比
    let _zoomScales = players.map(() => 1);
    let zoomSync = true;
    let activeIndex = 0;
    const ZOOM_MIN = 0.3, ZOOM_MAX = 20;
    let _zoomAnchorRX = 50, _zoomAnchorRY = 50;
    let _holderBase = []; // 各窗格 scale=1 时的屏幕矩形
    let _holderT = [];    // 各窗格累计 translate
    const applyZoomText = () => {
        zoomBtn.textContent = "🔍 " + Math.round((_zoomScales[activeIndex] || 1) * 100) + "%";
        zoomSyncBtn.textContent = _n === 1
            ? (zoomSync ? "🔗 缩放联动" : "⛓ 独立缩放")
            : (zoomSync ? "🔗 同步中" : "⛓ 不同步");
        zoomSyncBtn.style.color = zoomSync ? "#42d392" : "#ffb74d";
        zoomSyncBtn.style.borderColor = zoomSync ? "#42d392" : "#ffb74d";
        zoomSyncBtn.style.background = zoomSync ? "rgba(35,145,96,.22)" : "rgba(190,112,24,.24)";
        zoomSyncBtn.style.fontWeight = "700";
        players.forEach((p, i) => {
            const active = !zoomSync && i === activeIndex;
            p.cell.style.borderColor = active ? "#ff3b30" : "#3f3f3f";
            p.cell.style.borderWidth = active ? "2px" : "1px";
            p.cell.style.boxShadow = active ? "inset 0 0 0 1px rgba(255,59,48,.84)" : "none";
        });
    };
    const recordHolderBase = () => {
        // 记录各窗格的“布局矩形”（消除 holder 自身 transform 的影响）：
        // 视觉矩形 = 布局矩形经 translate(t)+scale(s) 后，反推可得布局矩形。
        // 始终记录布局矩形可保证基线不被缩放/平移污染，缩放锚点计算长期自洽。
        _holderBase = players.map((p, i) => {
            const r = p.holder.getBoundingClientRect();
            const t = _holderT[i] || { x: 0, y: 0 };
            const s = _zoomScales[i] || 1;
            return {
                left: r.left - t.x,
                top: r.top - t.y,
                width: s > 0 ? r.width / s : r.width,
                height: s > 0 ? r.height / s : r.height,
            };
        });
        // 不重置 _holderT：保留现有缩放/平移状态，锚点依赖 基线+平移+倍率 的自洽关系
    };
    const applyZoom = (factor, sourceIndex) => {
        // 基线失效（未记录/尺寸为 0）时即时重录，确保每个窗格都能被同步缩放
        if (_holderBase.length !== players.length ||
            _holderBase.some(b => !b || !(b.width > 0) || !(b.height > 0))) {
            recordHolderBase();
        }
        const rx = _zoomAnchorRX, ry = _zoomAnchorRY;
        for (let i = 0; i < players.length; i++) {
            if (!zoomSync && i !== sourceIndex) continue;
            const sOld = _zoomScales[i] || 1;
            const sNew = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, sOld * factor));
            if (sNew === sOld) continue;
            const holder = players[i].holder;
            const b = _holderBase[i];
            const t = _holderT[i] || { x: 0, y: 0 };
            // rx/ry 是鼠标在来源窗格中的视窗相对位置；各窗格映射到相同的相对锚点。
            // 从每个窗格自己的平移和缩放状态反算锚点内容坐标，重新同步时也不会重置对侧画面。
            const cX = (b.width * rx / 100 - t.x) / sOld;
            const cY = (b.height * ry / 100 - t.y) / sOld;
            // 缩放后保持该内容点位于其缩放前的屏幕位置不动（b.left + t.x + cX*sOld）
            const nX = t.x + cX * (sOld - sNew);
            const nY = t.y + cY * (sOld - sNew);
            _holderT[i] = { x: nX, y: nY };
            _zoomScales[i] = sNew;
            holder.style.transformOrigin = "0 0";
            holder.style.transform = "translate(" + nX + "px," + nY + "px) scale(" + sNew + ")";
        }
        applyZoomText();
        if (wipeMode) updateDividerPos(); // 缩放后分界线跟随 clip 边界
    };
    const resetZoom = () => {
        _zoomAnchorRX = 50; _zoomAnchorRY = 50;
        for (let i = 0; i < players.length; i++) {
            if (!zoomSync && i !== activeIndex) continue;
            const p = players[i];
            p.holder.style.transform = "none";
            p.holder.style.transformOrigin = "0 0";
            _holderT[i] = { x: 0, y: 0 };
            _zoomScales[i] = 1;
        }
        applyZoomText();
        if (wipeMode) updateDividerPos();
    };
    zoomSyncBtn.addEventListener("click", () => { zoomSync = !zoomSync; applyZoomText(); });
    zoomBtn.addEventListener("click", resetZoom);
    win.addEventListener("dblclick", (e) => {
        const index = players.findIndex((p) => p.holder.contains(e.target));
        if (index < 0) return;
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        activeIndex = index;
        zoomSync = !zoomSync;
        applyZoomText();
    }, true);
    win.addEventListener("wheel", (e) => {
        e.preventDefault();
        e.stopPropagation();
        // 锚点 = 鼠标所在窗格内的相对位置（各窗格统一；鼠标在空白处用中心）。
        // 用布局矩形（基线）判断所在窗格：缩放后窗格视觉溢出会盖住相邻窗格，
        // 若用 getBoundingClientRect 视觉矩形判断，鼠标会被误判到视觉上层的相邻窗格，
        // 导致真正鼠标所在的窗格锚点错乱、逐次累积漂移。
        let rx = 50, ry = 50;
        for (let i = 0; i < players.length; i++) {
            const b = _holderBase[i];
            if (b && b.width > 0 && b.height > 0 &&
                e.clientX >= b.left && e.clientX <= b.left + b.width &&
                e.clientY >= b.top && e.clientY <= b.top + b.height) {
                activeIndex = i;
                // 用鼠标相对窗格的位置做锚点；不同步后两边状态不同，也映射到各自对应位置。
                rx = ((e.clientX - b.left) / b.width) * 100;
                ry = ((e.clientY - b.top) / b.height) * 100;
                rx = Math.max(0, Math.min(100, rx));
                ry = Math.max(0, Math.min(100, ry));
                break;
            }
        }
        _zoomAnchorRX = rx; _zoomAnchorRY = ry;
        applyZoom(e.deltaY < 0 ? 1.1 : (e.deltaY > 0 ? 1 / 1.1 : 1), activeIndex);
    }, { capture: true, passive: false });

    // 鼠标中键 / Ctrl+左键拖动平移：所有窗格同步移动（配合滚轮缩放对比细节）
    let _panning = false;
    let _suppressClick = false; // 平移拖动结束后抑制一次 click，避免误触发播放/暂停
    let _panStartX = 0, _panStartY = 0;
    let _panStartT = [];
    let _panTargetIndexes = [];
    win.addEventListener("mousedown", (e) => {
        _suppressClick = false;
        // 中键，或 Ctrl+左键：进入平移模式
        const wantPan = (e.button === 1) || (e.button === 0 && e.ctrlKey);
        if (!wantPan) return;
        e.preventDefault();
        e.stopPropagation();
        const targetIndex = players.findIndex((p) => p.holder.contains(e.target));
        if (targetIndex < 0) return;
        _suppressClick = e.button === 0;
        _panning = true;
        _panStartX = e.clientX; _panStartY = e.clientY;
        _panStartT = _holderT.map(t => ({ x: t.x, y: t.y }));
        activeIndex = targetIndex;
        _panTargetIndexes = zoomSync ? players.map((_, i) => i) : [targetIndex];
        applyZoomText();
        win.style.cursor = "grabbing";
    }, true);
    // 平移结束后紧接着的 click 一律拦截（阻止播放器 _onSurfaceClick 触发播放/暂停）
    win.addEventListener("click", (e) => {
        if (!_suppressClick) return;
        e.preventDefault();
        e.stopPropagation();
        _suppressClick = false;
    }, true);
    const onPanMove = (e) => {
        if (!_panning) return;
        e.preventDefault();
        const dx = e.clientX - _panStartX;
        const dy = e.clientY - _panStartY;
        for (const i of _panTargetIndexes) {
            const t = _panStartT[i] || { x: 0, y: 0 };
            const nx = t.x + dx;
            const ny = t.y + dy;
            _holderT[i] = { x: nx, y: ny };
            players[i].holder.style.transformOrigin = "0 0";
            players[i].holder.style.transform = "translate(" + nx + "px," + ny + "px) scale(" + (_zoomScales[i] || 1) + ")";
        }
        if (wipeMode) updateDividerPos(); // 平移后分界线跟随 clip 边界
    };
    const onPanUp = () => {
        if (!_panning) return;
        _panning = false;
        win.style.cursor = "";
    };
    window.addEventListener("mousemove", onPanMove, true);
    window.addEventListener("mouseup", onPanUp, true);
    overlay._xzgPanMove = onPanMove;
    overlay._xzgPanUp = onPanUp;
    recordHolderBase(); // 初始布局下记录各窗格基线
    applyZoomText();
    _syncLoopOn = true;
    _syncMuted = false;
    applyCompareAudio(players, _syncMuted);

    // 全部就绪后统一从头播放（8 秒超时兜底：强制播放已就绪的）
    let readyCount = 0;
    let forceStarted = false;
    // 根据视频实际宽高比重排行列：全竖屏(9:16等)时横向排开，让格子高度最大化（画面更大）
    const applyGridLayout = () => {
        const ratios = players.map(p => p.player._videoRatio || 16 / 9);
        let cols, rows;
        const portraitPair = _n === 2 && ratios.every(r => r < 1);
        if (_n === 3 || fixedThreeByTwo) {
            // 三路保持横向一排；五/六路固定三列两行。
            cols = 3;
            rows = fixedThreeByTwo ? 2 : 1;
            grid.style.gridTemplateColumns = "repeat(3, minmax(0, 1fr))";
            grid.style.justifyContent = "";
        } else if (ultrawideMode && portraitPair) {
            // 带鱼屏模式：为两路视频各预留 2:3 竖屏视窗，并把双列整体居中。
            cols = 2;
            rows = 1;
            grid.style.gridTemplateColumns = "repeat(2, minmax(0, min(40vw, calc(66.6667vh - 90px))))";
            grid.style.justifyContent = "center";
        } else if (ratios.every(r => r < 1)) {
            // 全部竖屏：横向排开，让每个格子占满整列高度
            cols = _n <= 4 ? _n : Math.ceil(_n / 2);
            rows = Math.ceil(_n / cols);
            grid.style.gridTemplateColumns = "repeat(" + cols + ", 1fr)";
            grid.style.justifyContent = "";
        } else {
            // 横屏或混合：以 2~3 列为主
            cols = _n === 1 ? 1 : (_n === 2 ? 2 : (_n <= 4 ? 2 : (_n <= 6 ? 3 : 4)));
            rows = Math.ceil(_n / cols);
            grid.style.gridTemplateColumns = "repeat(" + cols + ", 1fr)";
            grid.style.justifyContent = "";
        }
        if (ultrawideMode && portraitPair) {
            grid.style.gridTemplateRows = "auto";
            grid.style.alignContent = "center";
            for (const p of players) {
                p.holder.style.aspectRatio = "2 / 3";
                p.holder.style.flex = "none";
                p.holder.style.width = "100%";
                p.holder.style.height = "auto";
            }
        } else {
            grid.style.gridTemplateRows = "repeat(" + rows + ", 1fr)";
            grid.style.alignContent = "";
            for (const p of players) {
                p.holder.style.aspectRatio = "";
                p.holder.style.flex = "";
                p.holder.style.width = "100%";
                p.holder.style.height = "100%";
            }
        }
        // 横屏/混合画面下不启用，避免意外压缩正常双路对比；保留按钮但禁用并说明原因。
        ultrawideBtn.disabled = !portraitPair;
        ultrawideBtn.title = portraitPair
            ? "双路竖屏时让视频靠近中间，避免在带鱼屏上相距过远"
            : "带鱼屏模式仅适用于两个竖屏视频";
        ultrawideBtn.classList.toggle("active", ultrawideMode && portraitPair);
        // 重排后校准各播放器画布尺寸
        requestAnimationFrame(() => {
            for (const p of players) {
                try { p.player.resize?.(); } catch (_) {}
            }
            recordHolderBase(); // 布局稳定后重新记录窗格基线，保证缩放锚点准确
        });
    };
    ultrawideBtn.addEventListener("click", () => {
        if (ultrawideBtn.disabled) return;
        ultrawideMode = !ultrawideMode;
        applyGridLayout();
    });
    const tryStart = () => {
        if (forceStarted) return;
        if (readyCount >= players.length) {
            forceStarted = true;
            mediaReady = true;
            if (players.length >= 3 || players.some(({ player }) => player._comparisonFile)) {
                for (const { player } of players) player.playbackGroupClock = playbackGroupClock;
            }
            bufferPanel.style.display = "none";
            for (const b of [playPauseBtn, prevFrameBtn, nextFrameBtn, restartBtn, scrubRange]) b.disabled = false;
            applyGridLayout(); // 全部就绪后按比例重排
            statusEl.textContent = "已暂停（点击播放开始）";
            // 保持暂停：进入对比界面停在开头，由用户手动开始
        } else {
            statusEl.textContent = "正在加载视频";
            showBuffer(`正在加载视频 · ${readyCount}/${players.length}`, readyCount / players.length * 100);
        }
    };
    for (const b of [playPauseBtn, prevFrameBtn, nextFrameBtn, restartBtn, scrubRange]) b.disabled = true;

    let loadFailed = false;
    let cacheQueue = Promise.resolve();
    for (const p of players) {
        p.player.onLoadedMetadata = () => {
            // 多路顺序解码压缩源，只在浏览器里缓冲少量原尺寸帧，
            // 避免通过本地 HTTP 持续传输多路未压缩帧。
            if (_overlay !== overlay || loadFailed) return;
            updateVideoLabel(p.labelEl, p);
            _updateWipeLabels();
            if (players.length >= 3) {
                readyCount++;
                tryStart();
                return;
            }
            cacheQueue = cacheQueue.then(async () => {
                if (_overlay !== overlay || loadFailed) return;
                let displayedPercent = -1;
                const name = p.label;
                const renderCacheProgress = () => {
                    const percent = Math.max(0, displayedPercent);
                    statusEl.textContent = players.length === 1
                        ? `正在准备 · ${percent}%`
                        : `正在准备 · 第 ${readyCount + 1}/${players.length} 路 · ${percent}%`;
                    showBuffer(`正在准备视频 · ${readyCount + 1}/${players.length} · ${name} · ${percent}%`,
                        (readyCount + percent / 100) * 100 / players.length);
                };
                renderCacheProgress();
                await p.player.prepareBackendComparisonCache(p.url, progress => {
                    if (_overlay !== overlay || loadFailed) return;
                    const percent = Math.floor(progress * 100);
                    if (percent === displayedPercent) return;
                    displayedPercent = percent;
                    renderCacheProgress();
                });
                if (_overlay !== overlay || loadFailed) return;
                readyCount++;
                seekPlayerToOffset(p, 0);
                if (readyCount === players.length) tryStart();
            }).catch(error => p.player.onError?.(error));
        };
        p.player.onError = (error) => {
            if (_overlay !== overlay || loadFailed) return;
            loadFailed = true;
            if (playing) syncPause();
            console.warn("[小珠光同步预览] 视频加载或缓存失败:", p.url, error);
            const message = `视频加载或缓存失败 · ${p.label}`;
            statusEl.textContent = message;
            showBuffer(message, 0);
        };
        // 关闭播放器自带的独立循环：改由对比窗口按「左侧区间」统一循环（见 scrubTick）
        p.player.setLoop(false);
        p.player.load(p.url);
    }
    tryStart();

    // 布局稳定后校准各播放器画布尺寸
    requestAnimationFrame(() => {
        for (const p of players) {
            try { p.player.resize?.(); } catch (_) {}
        }
    });

    // Esc 关闭；←/→ 逐帧浏览（焦点在输入控件时不响应，避免干扰进度条等）
    const onKey = (e) => {
        if (e.__xzgKeyHandled) return;
        e.__xzgKeyHandled = true;
        const blurPreviewControl = () => {
            const focused = document.activeElement;
            if (focused === scrubRange || (focused?.tagName === "BUTTON" && overlay.contains(focused))) {
                focused.blur();
            }
        };
        if (e.code === "Space" || e.key === " ") {
            e.preventDefault();
            e.stopImmediatePropagation();
            blurPreviewControl();
            if (!e.repeat && mediaReady) {
                if (playing) pauseAll(); else playAll();
            }
            return;
        }
        if (e.key === "Escape") {
            closeSyncPreview();
            return;
        }
        const t = e.target;
        const typing = t && t !== scrubRange &&
            (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
        if (typing) return;
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            e.stopPropagation();
            blurPreviewControl();
            stepFrame(e.key === "ArrowLeft" ? -1 : 1);
        }
    };
    overlay._xzgOnKey = onKey;
    overlay.dataset.xzgVideoPreview = "";
    document.addEventListener("keydown", onKey, true);
    // 焦点在进度条上时也保证方向键/空格优先走同步预览逻辑，而不是浏览器原生 range 行为
    scrubRange.addEventListener("keydown", onKey, true);

    return true;
}

// ═══════════════════════════════════════════════════════════════
// 对外入口
// ═══════════════════════════════════════════════════════════════

/** 对指定节点集合做同步预览 */
async function previewNodes(nodes) {
    const items = [];
    for (const n of nodes || []) {
        const video = getVideoFromNode(n);
        if (video) {
            video._isOriginal = isVideoLoaderNode(n); // 加载器 → 原视频
            items.push(video);
        }
        else {
            try {
                items.push(...await getImagesFromNode(n));
            } catch (error) {
                console.warn("[小珠光同步预览] 读取图片原图失败:", error);
                const message = error?.message || String(error);
                const toast = app?.extensionManager?.toast;
                if (toast?.add) toast.add({ title: "打开图片对比失败", message, type: "error", life: 4 });
                else alert(message);
                return false;
            }
        }
    }
    if (items.length === 0) {
        console.warn("[小珠光同步预览] 选中的节点中没有可预览的视频或图片");
        return false;
    }
    // 视频加载器的预览优先显示，同类节点保持原顺序。
    items.sort((a, b) => (a._isOriginal ? 0 : 1) - (b._isOriginal ? 0 : 1));
    if (items.some((item) => item.kind === "image")) {
        const images = items.filter((item) => item.kind === "image");
        if (images.length !== items.length) {
            console.warn("[小珠光同步预览] 图片与视频暂不支持放在同一个对比窗口");
            return false;
        }
        return openImageCompare(images);
    }
    return openSyncPreview(items);
}

/** 快捷键入口：当前选中的视频/图片节点；无选中时优先沿用全视频预览 */
function previewSelection() {
    if (!isVideoCompareEnabled()) return false;
    let nodes = getSelectedMediaNodes();
    if (nodes.length === 0) {
        nodes = getAllMediaNodes();
    }
    if (nodes.length === 0) {
        console.warn("[小珠光同步预览] 画布上没有可预览的视频或图片节点");
        return false;
    }
    return previewNodes(nodes);
}

// ═══════════════════════════════════════════════════════════════
// 右键菜单扩展（与 xzg_menu_hide 等链式 patch 兼容，幂等）
// ═══════════════════════════════════════════════════════════════

let _patched = false;
function patchContextMenus() {
    if (_patched) return;
    _patched = true;
    const LGC = (typeof LiteGraph !== "undefined") ? LiteGraph.LGraphCanvas : null;
    if (!LGC || !LGC.prototype) return;

    // 节点右键菜单：单视频查看，多视频对比，置顶显示。
    const origNodeMenu = LGC.prototype.getNodeMenuOptions;
    LGC.prototype.getNodeMenuOptions = function (node) {
        let options = origNodeMenu ? origNodeMenu.apply(this, arguments) : [];
        if (Array.isArray(options) && isImageSaveNode(node)) {
            // 统一把保存节点专属操作放在菜单最前面，扩展项与 ComfyUI 项目随后显示。
            const orderedKeys = ["compare", "copy", "save", "library", "original"];
            if (node.type === "XiaozhuguangImageSaveCustom") orderedKeys.splice(4, 0, "send");
            const ownItems = new Map();
            for (let i = options.length - 1; i >= 0; i--) {
                const item = options[i];
                if (item?._xzgImageCompareMenuItem) {
                    ownItems.set("compare", item);
                    options.splice(i, 1);
                } else if (item?._xzgImageSaveMenuItem) {
                    ownItems.set(item._xzgImageSaveMenuItem, item);
                    options.splice(i, 1);
                }
            }
            const ordered = orderedKeys.map((key) => ownItems.get(key)).filter(Boolean);
            if (ordered.length) options.unshift(...ordered, null);
        }
        // 图片保存节点在自身 getExtraMenuOptions 中加入图片对比，兼容不经过
        // LiteGraph 旧式节点菜单钩子的 ComfyUI 前端。
        if (Array.isArray(options) && isVideoCompareEnabled() && nodeHasMedia(node) && !isImageSaveNode(node)) {
            const nodes = nodeHasVideo(node) ? getSelectedVideoNodes() : getSelectedMediaNodes();
            if (!nodes.includes(node)) nodes.push(node);
            options.unshift({
                content: nodeHasImage(node) ? "▧ 图片对比" : (nodes.length === 1 ? "▶ 查看视频" : "▶ 对比视频"),
                color: '#dcc85b',
                callback: () => {
                    let nodes = nodeHasVideo(node) ? getSelectedVideoNodes() : getSelectedMediaNodes();
                    // 保证右键节点本身被包含（多选时选中集合应已含它，兜底补上）
                    if (!nodes.includes(node)) nodes.push(node);
                    previewNodes(nodes);
                },
            });
        }
        return options;
    };

    // 画布空白右键菜单：按选中媒体的数量显示查看或对比入口。
    const origCanvasMenu = LGC.prototype.getCanvasMenuOptions;
    LGC.prototype.getCanvasMenuOptions = function () {
        const options = origCanvasMenu ? origCanvasMenu.apply(this, arguments) : [];
        const nodes = getSelectedMediaNodes();
        if (Array.isArray(options) && isVideoCompareEnabled() && nodes.length > 0) {
            const videosOnly = nodes.every(nodeHasVideo);
            const label = videosOnly ? (nodes.length === 1 ? "▶ 查看视频" : "▶ 对比视频") : "▶ 对比选中的视频/图片";
            options.push(null);
            options.push({
                content: label,
                color: '#dcc85b',
                callback: () => previewSelection(),
            });
        }
        return options;
    };
}

// ═══════════════════════════════════════════════════════════════
// 扩展注册 + 全局暴露（供快捷键等外部调用）
// ═══════════════════════════════════════════════════════════════

app.registerExtension({
    name: "xiaozhuguang.video_sync_preview",
    async setup() {
        registerVideoCompareSetting();
        patchContextMenus();
    },
});

window.xzgSyncPreview = {
    previewSelection,
    previewNodes,
    isEnabled: isVideoCompareEnabled,
    getAllMediaNodes,
    getSelectedMediaNodes,
    openSyncPreview,
    closeSyncPreview,
    nodeHasVideo,
    nodeHasImage,
    getVideoFromNode,
    getImageFromNode,
    getSelectedVideoNodes,
    getSelectedMediaNodes,
};

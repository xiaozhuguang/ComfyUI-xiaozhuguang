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

function getVideoUrl(filename, type, subfolder) {
    if (!filename) return "";
    const params = new URLSearchParams({
        filename,
        type: type || "output",
    });
    if (subfolder) params.set("subfolder", subfolder);
    return `/view?${params.toString()}`;
}

function _extractFilename(url) {
    try {
        const params = new URLSearchParams(new URL(url, location.origin).search);
        return params.get("filename") || "video.mp4";
    } catch (_) {
        return "video.mp4";
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

/** 从节点取视频 { url, name, skipFrames?, frameLimit? }，取不到返回 null */
function getVideoFromNode(node) {
    const p = node && node._xzgVideoPlayer;
    if (!p) return null;
    let src = typeof p.getSrc === "function" ? p.getSrc() : null;
    if (!src && p._videoInfo && p._videoInfo.filename) {
        src = getVideoUrl(p._videoInfo.filename, p._videoInfo.type, p._videoInfo.subfolder);
    }
    if (!src) return null;
    const item = { url: src, name: _extractFilename(src) };
    // 携带节点播放器已应用的加载范围（跳过帧数/帧数上限）：
    // 对比预览创建的是全新播放器，不传的话会播放完整视频，与节点内裁剪后预览不一致
    if (typeof p._skipFrames === "number" && p._skipFrames > 0) item.skipFrames = p._skipFrames;
    if (typeof p._frameLimit === "number" && p._frameLimit > 0) item.frameLimit = p._frameLimit;
    return item;
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
        img.src = item.url; img.alt = item.name; img.draggable = false;
        img.style.cssText = "width:100%;height:100%;object-fit:contain;display:block";
        holder.appendChild(img); cell.append(label, holder); grid.appendChild(cell);
        return { cell, holder };
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
    const swapBtn = document.createElement("button"); swapBtn.className = "xzg-sp-btn"; swapBtn.textContent = "⇄ 交换左右";
    const ultrawideBtn = document.createElement("button"); ultrawideBtn.className = "xzg-sp-btn"; ultrawideBtn.textContent = "🖥 带鱼屏";
    ultrawideBtn.title = "双路竖屏图片靠近窗口中间显示";
    ultrawideBtn.style.display = cells.length === 2 ? "" : "none";
    header.append(swapBtn, wipeBtn, zoomSyncBtn, zoomBtn, ultrawideBtn, close);
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
    const divider = document.createElement("div"); divider.className = "xzg-sp-wipe-divider";
    divider.title = "拖动分界线进行划像对比"; wipe.appendChild(divider);
    let wipeOn = false, swapped = false, wipeX = 50;
    const updateWipe = () => { wipe.style.setProperty("--wipe", `${wipeX}%`); divider.style.left = `${wipeX}%`; };
    const setWipe = (on) => {
        if (cells.length !== 2) return;
        wipeOn = on; wipe.classList.toggle("active", on); grid.style.display = on ? "none" : "grid";
        if (on) {
            wipe.insertBefore(cells[swapped ? 1 : 0].holder, divider);
            wipe.insertBefore(cells[swapped ? 0 : 1].holder, divider);
            cells[swapped ? 0 : 1].holder.classList.add("wipe-top");
            cells[swapped ? 1 : 0].holder.classList.remove("wipe-top");
            updateWipe();
        } else for (const c of cells) { c.holder.classList.remove("wipe-top"); c.cell.appendChild(c.holder); }
        wipeBtn.textContent = on ? "⬒ 并排对比" : "🔀 划像对比";
    };
    wipeBtn.style.display = cells.length === 2 ? "" : "none";
    swapBtn.style.display = cells.length === 2 ? "" : "none";
    wipeBtn.onclick = () => setWipe(!wipeOn);
    swapBtn.onclick = () => {
        swapped = !swapped;
        if (wipeOn) setWipe(true);
        else grid.insertBefore(cells[swapped ? 1 : 0].cell, cells[swapped ? 0 : 1].cell);
    };
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
        const r = wipe.getBoundingClientRect();
        if (!r.width) return;
        wipeX = Math.max(0, Math.min(100, (e.clientX - r.left) / r.width * 100));
        updateWipe();
    };
    // 与视频对比划线一致：悬停移动时分界线持续跟随鼠标，无需按住拖动。
    wipe.addEventListener("mousemove", followWipePointer);
    wipe.addEventListener("wheel", (e) => {
        if (!wipeOn) return;
        e.preventDefault();
        e.stopPropagation();
        const rect = wipe.getBoundingClientRect();
        if (!rect.width) return;
        const pointerPct = (e.clientX - rect.left) / rect.width * 100;
        const onTopImage = pointerPct >= wipeX;
        const index = onTopImage ? (swapped ? 0 : 1) : (swapped ? 1 : 0);
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
    if (cells.length === 2) setWipe(true);
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
let _syncMuted = true;

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
        flex: 1; overflow: hidden; padding: 14px;
        display: grid; gap: 14px;
    }
    .xzg-sp-cell {
        position: relative; display: flex; flex-direction: column;
        background: #000; border: 1px solid #3f3f3f; border-radius: 8px;
        overflow: hidden;
        min-width: 0;
    }
    .xzg-sp-label {
        padding: 6px 8px; font-size: 11px; color: #aaa;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        background: #232323; flex-shrink: 0;
    }
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
    .xzg-sp-scrub-time { font-size: 12px; color: #bbb; white-space: nowrap; }
    .xzg-sp-wipe {
        position: relative; flex: 1; overflow: hidden; background: #000;
        display: none;
    }
    .xzg-sp-wipe.active { display: block; }
    .xzg-sp-wipe .xzg-sp-player {
        position: absolute; inset: 0;
    }
    .xzg-sp-wipe .xzg-sp-player.wipe-top {                          /* 上层：按 --wipe 裁剪 */
        z-index: 2;
        clip-path: inset(0 0 0 var(--wipe, 50%));
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
    videoCompareTitle.textContent = "视频对比";

    // 网格容器：视频加载完成后按实际宽高比重排；五/六路从一开始就固定三列两行。
    const grid = document.createElement("div");
    grid.className = "xzg-sp-grid";
    const _n = items.length;
    const fixedThreeByTwo = _n === 5 || _n === 6;
    grid.style.gridTemplateColumns = fixedThreeByTwo ? "repeat(3, minmax(0, 1fr))" : "repeat(" + _n + ", 1fr)";
    grid.style.gridTemplateRows = fixedThreeByTwo ? "repeat(2, minmax(0, 1fr))" : "repeat(1, 1fr)";
    // 同时播放多路视频时，解码成本远高于画面实际显示尺寸。对比窗口优先流畅度：
    // 两路保留 1440p 细节，三至四路用 1080p，更多路用 720p；逐帧查看仍可精确对齐。
    const previewMaxSide = _n <= 2 ? 1440 : (_n <= 4 ? 1080 : 720);
    // 预读按预览分辨率控制：双路 6 帧（约 0.2 秒）、多路 4 帧。
    // 比原先 4/2 更能吸收高码率瞬时解码波动，同时仍受分辨率上限约束。
    const playbackBufferFrames = _n <= 2 ? 6 : 4;
    const players = [];
    for (const it of items) {
        const cell = document.createElement("div");
        cell.className = "xzg-sp-cell";
        const label = document.createElement("div");
        label.className = "xzg-sp-label";
        label.textContent = it.name || "video";
        label.title = it.url;
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
            previewMaxSide,
            playbackBufferFrames,
            streamSource: true, // 支持 Range 时按需读取，避免整段高码率原片常驻内存
            transcodeMaxBitrateKbps: 10000, // 高于 10 Mbps 的原片生成可复用代理，降低实时解码压力
            // 点击任一视频画面切换播放/暂停时，同步所有视频（与左下角按钮一致：从暂停处继续）
            onPlay: () => syncResume(),
            onPause: () => syncPause(),
        });
        player.setMuted(true); // 多视频同播默认静音，避免声音混杂
        // 应用节点加载范围（跳过帧数/帧数上限）：对比播放器与节点内预览保持相同的裁剪
        if (it.skipFrames || it.frameLimit) {
            try { player.setLoadRange(it.skipFrames || 0, it.frameLimit || 0); } catch (_) {}
        }
        players.push({ player, url: it.url, holder, cell });
    }
    win.appendChild(grid);

    // 划像对比容器（仅两个视频时使用）：两视频重叠，拖动金色分界线左右对比
    const wipe = document.createElement("div");
    wipe.className = "xzg-sp-wipe";
    const wipeDivider = document.createElement("div");
    wipeDivider.className = "xzg-sp-wipe-divider";
    wipeDivider.title = "拖动分界线进行划像对比";
    wipe.appendChild(wipeDivider);
    win.appendChild(wipe);

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
    const playPauseBtn = mkBtn("▶ 播放", "播放全部（从头开始）", "xzg-sp-btn-primary");
    const prevFrameBtn = mkBtn("◀ 上一帧", "上一帧（快捷键 ←）");
    const nextFrameBtn = mkBtn("下一帧 ▶", "下一帧（快捷键 →）");
    const restartBtn = mkBtn("⏮ 回到开头", "全部回到开头重新播放");
    const muteBtn = mkBtn("🔇", "静音开关（默认静音）");
    const zoomSyncBtn = mkBtn("🔗 同步中", "切换视频缩放和移动同步状态；也可双击视频切换");
    const zoomBtn = mkBtn("🔍 100%", "滚轮缩放视频，点击重置");
    const wipeBtn = mkBtn("🔀 划像对比", "两个视频重叠，拖动金色分界线左右对比（仅 2 个视频可用）");
    if (_n !== 2) wipeBtn.style.display = "none"; // 仅两个视频时提供划像对比
    const swapBtn = mkBtn("⇄ 交换左右", "交换两个视频的左右顺序（仅 2 个视频）");
    if (_n !== 2) swapBtn.style.display = "none";
    const ultrawideBtn = mkBtn("🖥 带鱼屏", "双路竖屏时让视频靠近中间，避免在带鱼屏上相距过远");
    if (_n !== 2) ultrawideBtn.style.display = "none";
    let ultrawideMode = false;
    let _swapped = false;
    const setSwap = (s) => {
        _swapped = s;
        // 交换 players 顺序：并排左右 与 划像底层/上层 都随之对调
        [players[0], players[1]] = [players[1], players[0]];
        // 同步交换累计平移：_holderT 与 players 索引一一对应，
        // 基线重录（recordHolderBase）依赖它反推布局矩形，错位会导致缩放锚点错乱
        [_holderT[0], _holderT[1]] = [_holderT[1], _holderT[0]];
        [_zoomScales[0], _zoomScales[1]] = [_zoomScales[1], _zoomScales[0]];
        // 统一让 players[0] 的格子排在前（左侧）
        grid.insertBefore(players[0].cell, players[1].cell);
        if (wipeMode) setWipeMode(true); // 划像模式：重新布置底层/上层
        requestAnimationFrame(() => {
            for (const p of players) {
                try { p.player.resize?.(); } catch (_) {}
            }
            recordHolderBase();
            if (wipeMode) updateDividerPos();
        });
    };
    swapBtn.addEventListener("click", () => setSwap(!_swapped));
    // 播放台：共享进度条，同时控制所有视频的播放进度（按各自时长的比例同步跳转）
    const scrubWrap = document.createElement("div");
    scrubWrap.className = "xzg-sp-scrub";
    const scrubTime = document.createElement("span");
    scrubTime.className = "xzg-sp-scrub-time";
    scrubTime.textContent = "00:00 / 00:00";
    const scrubRange = document.createElement("input");
    scrubRange.type = "range";
    scrubRange.min = 0; scrubRange.max = 1000; scrubRange.value = 0;
    scrubRange.title = "同步控制所有视频的播放进度";
    scrubWrap.appendChild(scrubTime);
    scrubWrap.appendChild(scrubRange);
    const statusEl = document.createElement("span");
    statusEl.className = "xzg-sp-status";
    statusEl.textContent = "加载中...";

    // 主视频（用于进度条/时间显示）：取第一个已有有效时长的
    const pickMain = () => {
        for (const p of players) {
            const d = p.player.duration;
            if (d && isFinite(d) && d > 0) return p;
        }
        return players[0];
    };
    const fmtTime = (t) => {
        if (!isFinite(t) || t < 0) t = 0;
        const m = Math.floor(t / 60), s = Math.floor(t % 60);
        return (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
    };
    let _scrubbing = false;
    const seekAllToRatio = (ratio) => {
        for (const p of players) {
            const d = p.player.duration;
            if (d && isFinite(d) && d > 0) {
                try { p.player.seek(d * ratio); } catch (_) {}
            }
        }
    };
    scrubRange.addEventListener("input", () => {
        _scrubbing = true;
        seekAllToRatio((+scrubRange.value) / 1000);
        const main = pickMain();
        scrubTime.textContent = fmtTime(main.player.currentTime) + " / " + fmtTime(main.player.duration);
    });
    scrubRange.addEventListener("change", () => {
        _scrubbing = false;
    });
    // 多视频同步播放：以主视频为基准做“硬漂移才校准”。
    // 高码率时频繁 seek 会让解码器反复跳回关键帧附近，造成更严重的卡顿与不同步；
    // 因此允许短暂掉帧自行追上，只有明显漂移连续出现才触发一次 seek。
    let _lastAlignAt = 0;
    const ALIGN_INTERVAL = 750;          // 对齐检查间隔（ms）
    const HARD_DRIFT_SECONDS = 0.25;     // 小于约 6 帧（24fps）的偏差不抢占解码
    const HARD_DRIFT_CONFIRMATIONS = 2;  // 连续两次仍明显漂移才硬校准
    const driftCounts = new Map();
    const alignPlayers = (now) => {
        if (!playing) return; // 暂停时不强制对齐：避免逐帧浏览时各播放器帧位被拉回主时间
        if (_lastAlignAt && now - _lastAlignAt < ALIGN_INTERVAL) return;
        _lastAlignAt = now;
        const main = pickMain();
        const master = main.player.currentTime;
        if (!isFinite(master)) return;
        for (const p of players) {
            if (p === main) continue;
            const d = p.player.duration;
            if (!d || !isFinite(d) || d <= 0) continue;
            const ct = p.player.currentTime || 0;
            const drift = Math.abs(ct - master);
            const count = drift > HARD_DRIFT_SECONDS ? (driftCounts.get(p) || 0) + 1 : 0;
            driftCounts.set(p, count);
            if (count >= HARD_DRIFT_CONFIRMATIONS) {
                try { p.player.seek(Math.max(0, Math.min(master, d))); } catch (_) {}
                driftCounts.set(p, 0);
            }
        }
    };
    let _lastBufferStatusText = "";
    const updateBufferStatus = () => {
        if (!playing) return;
        const states = players
            .filter((p) => p.player.duration > 0)
            .map((p) => p.player.getPlaybackBufferState?.());
        if (!states.length) return;
        const minBuffered = Math.min(...states.map((s) => s.bufferedFrames));
        const maxBuffered = Math.max(...states.map((s) => s.bufferedFrames));
        const target = Math.max(...states.map((s) => s.targetFrames));
        const filling = states.some((s) => s.isFilling);
        const range = minBuffered === maxBuffered ? String(minBuffered) : `${minBuffered}-${maxBuffered}`;
        const text = minBuffered === 0 && filling
            ? `⏳ 解码缓冲中 0/${target} 帧`
            : `▶ 播放中 · 缓冲 ${range}/${target} 帧`;
        if (text !== _lastBufferStatusText) {
            statusEl.textContent = text;
            _lastBufferStatusText = text;
        }
    };
    // 播放中每帧平滑刷新进度条（拖动时暂停刷新；仅数值变化时写入 DOM，避免无谓开销）
    const scrubTick = () => {
        const now = performance.now();
        if (!_scrubbing) {
            alignPlayers(now);
            updateBufferStatus();
            const main = pickMain();
            const d = main.player.duration;
            if (d && isFinite(d) && d > 0) {
                const ct = main.player.currentTime || 0;
                const v = Math.max(0, Math.min(1000, (ct / d) * 1000));
                if (v !== scrubRange.value) scrubRange.value = v;
                const txt = fmtTime(ct) + " / " + fmtTime(d);
                if (txt !== scrubTime.textContent) scrubTime.textContent = txt;
            }
        }
        _scrubRAF = requestAnimationFrame(scrubTick);
    };
    _scrubRAF = requestAnimationFrame(scrubTick);

    // 同步播放/暂停：点击任一视频画面（或左下角按钮）时，所有视频一起播放/暂停
    // _syncing 防止同步动作再次触发 onPlay/onPause 造成递归
    let _syncing = false;
    // 从暂停处继续播放：不 seek，各视频从自己的当前进度继续
    const syncResume = () => {
        if (_syncing) return;
        _syncing = true;
        try {
            for (const p of players) {
                if (!p.player.isPlaying) p.player.play();
            }
            playing = true;
            playPauseBtn.textContent = "⏸ 暂停";
            statusEl.textContent = "▶ 播放中（自动循环）";
        } finally { _syncing = false; }
    };
    // 从头一起播放：seek 0 + play（"回到开头"重新播放时使用）
    const syncPlayFromStart = () => {
        if (_syncing) return;
        _syncing = true;
        try {
            for (const p of players) {
                if (!p.player.isPlaying) { p.player.seek(0); p.player.play(); }
            }
            playing = true;
            playPauseBtn.textContent = "⏸ 暂停";
            statusEl.textContent = "▶ 播放中（自动循环）";
        } finally { _syncing = false; }
    };
    const syncPause = () => {
        if (_syncing) return;
        _syncing = true;
        try {
            for (const p of players) p.player.pause();
            playing = false;
            playPauseBtn.textContent = "▶ 播放";
            statusEl.textContent = "已暂停";
        } finally { _syncing = false; }
    };
    // 左下角播放按钮：从暂停处继续；点击视频 onPlay 同样走继续播放
    const playAll = syncResume;
    const pauseAll = syncPause;
    const restartAll = () => {
        _syncing = true; // 阻止 pause/seek 触发同步回调
        try {
            for (const p of players) {
                p.player.pause();
                p.player.seek(0);
            }
        } finally { _syncing = false; }
        if (playing) syncPlayFromStart();
    };
    // 逐帧浏览：先暂停全部，然后各视频同步跳到「主视频当前帧号 ± delta」对应的帧。
    // 以帧号（而非时间）为同步基准：对比场景下第 N 帧画面才有可比性；
    // 各播放器按自己的帧率 seek 到第 N 帧，帧率不同也能逐帧对齐。
    const stepFrame = (delta) => {
        _syncing = true;
        try {
            for (const p of players) p.player.pause();
        } finally { _syncing = false; }
        playing = false;
        playPauseBtn.textContent = "▶ 播放";
        statusEl.textContent = "已暂停";
        const main = pickMain();
        const mfps = main.player.getFrameRate ? main.player.getFrameRate() : (main.player._frameRate || 24);
        const target = Math.round((main.player.currentTime || 0) * mfps) + delta;
        for (const p of players) {
            const pfps = p.player.getFrameRate ? p.player.getFrameRate() : (p.player._frameRate || 24);
            const skip = p.player._skipFrames || 0;
            let end = 0;
            try { end = p.player._computeEndFrame ? p.player._computeEndFrame() : 0; } catch (_) {}
            if (!end || end <= 0) end = p.player.getSourceTotalFrames ? p.player.getSourceTotalFrames() : 0;
            const f = end > 0 ? Math.max(skip, Math.min(target, end)) : Math.max(0, target);
            try { p.player.seek(f / pfps); } catch (_) {}
        }
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
        for (const p of players) p.player.setMuted(_syncMuted);
    });

    // ── 划像对比（仅两个视频）──────────────────────────────
    let wipeMode = false;
    const setWipeMode = (on) => {
        if (_n !== 2) return;
        wipeMode = on;
        if (on) {
            grid.style.display = "none";
            wipe.classList.add("active");
            // 播放器在容器上设置了内联 position:relative，会覆盖 CSS 的 absolute，
            // 因此必须内联强制 absolute + inset:0，两个视频才能真正重叠
            for (const p of players) {
                p.holder.style.position = "absolute";
                p.holder.style.inset = "0";
            }
            // 底层 = 第 1 个视频（全显示），上层 = 第 2 个视频（按 --wipe 裁剪）
            wipe.insertBefore(players[0].holder, wipeDivider);
            wipe.insertBefore(players[1].holder, wipeDivider);
            players[1].holder.classList.add("wipe-top");
            players[0].holder.classList.remove("wipe-top");
        } else {
            grid.style.display = "";
            wipe.classList.remove("active");
            players[0].cell.appendChild(players[0].holder);
            players[1].cell.appendChild(players[1].holder);
            players[1].holder.classList.remove("wipe-top");
            // 恢复播放器默认布局（position:relative 由播放器自己管理，这里清空内联覆盖）
            for (const p of players) {
                p.holder.style.position = "";
                p.holder.style.inset = "";
            }
        }
        // 切换视图时重置缩放/平移，避免残留 transform 造成错乱
        for (const p of players) {
            p.holder.style.transform = "none";
            p.holder.style.transformOrigin = "0 0";
        }
        wipeDivider.style.transform = "none";
        wipeDivider.style.transformOrigin = "0 0";
        _holderT = players.map(() => ({ x: 0, y: 0 }));
        _zoomScales = players.map(() => 1);
        applyZoomText();
        // 布局/画布尺寸变化后重录基线并校准
        requestAnimationFrame(() => {
            for (const p of players) {
                try { p.player.resize?.(); } catch (_) {}
            }
            recordHolderBase();
            if (wipeMode) updateDividerPos();
        });
        wipeBtn.textContent = on ? "⬒ 并排对比" : "🔀 划像对比";
    };
    wipeBtn.addEventListener("click", () => setWipeMode(!wipeMode));

    // 划像交互：鼠标悬停位置即分界线位置（无需按住左键）；左键单击仍由播放器处理播放/暂停。
    // 分界线本身也支持按住拖动微调。
    let _wiping = false;          // 分界线拖动中
    let _wipeX = 50;              // 划像位置（0-100，未缩放坐标，相对 wipe 宽度）
    let _downX = 0, _downY = 0, _downMoved = false; // 按住移动判定：拖动后抑制 click，避免误触播放/暂停
    // 分界线定位到 clip 边界的实际视觉位置：clip 边界 = 未缩放 X% 处经窗格缩放/平移后的位置
    const updateDividerPos = () => {
        const W = wipe.clientWidth;
        if (!W) return;
        const t0 = _holderT[0] || { x: 0, y: 0 };
        const leftPct = _wipeX * (_zoomScales[0] || 1) + (t0.x / W) * 100;
        wipeDivider.style.left = Math.max(-4, Math.min(104, leftPct)) + "%";
    };
    const updateWipe = (e) => {
        const r = wipe.getBoundingClientRect();
        if (!r.width) return;
        // 鼠标指向的内容在本地坐标中的比例（消除缩放与平移的影响）：
        // clip-path 的 inset 百分比相对未缩放内容坐标，直接取容器比例会在放大/平移后错位
        const t0 = _holderT[0] || { x: 0, y: 0 };
        const s = _zoomScales[0] || 1;
        let x = ((e.clientX - r.left - t0.x) / (r.width * s)) * 100;
        x = Math.max(0, Math.min(100, x));
        _wipeX = x;
        wipe.style.setProperty("--wipe", x + "%"); // clip-path 用它（相对窗格本地坐标）
        updateDividerPos();                         // 分界线跟随 clip 边界视觉位置
    };
    wipeDivider.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        _wiping = true;
        _downX = e.clientX; _downY = e.clientY;
        _downMoved = false;
        updateWipe(e);
    });
    // 单击分界线 = 播放/暂停（悬停划像下鼠标总在分界线上，单击即点在分界线上；
    // 拖动分界线后 click 已被 onWipeUp 抑制，不会误触播放）
    wipeDivider.addEventListener("click", (e) => {
        e.stopPropagation();
        if (playing) pauseAll(); else playAll();
    });
    // 悬停划像：鼠标在画面上移动，分界线跟随（无需按住左键）；左键单击由播放器处理播放/暂停
    const onWipeHover = (e) => {
        if (!_downMoved && Math.abs(e.clientX - _downX) + Math.abs(e.clientY - _downY) > 4) _downMoved = true;
        if (_wiping) return; // 分界线拖动中由 onWipeMove 接管
        updateWipe(e);
    };
    wipe.addEventListener("mousemove", onWipeHover);
    wipe.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        _downX = e.clientX; _downY = e.clientY;
        _downMoved = false;
    });
    const onWipeMove = (e) => {
        if (!_wiping) return;
        if (!_downMoved && Math.abs(e.clientX - _downX) + Math.abs(e.clientY - _downY) > 4) _downMoved = true;
        updateWipe(e); // 分界线按住拖动：跟手
    };
    const onWipeUp = () => {
        if (_wiping && _downMoved) _suppressClick = true; // 拖动分界线/画面后抑制 click，避免误触播放/暂停
        _wiping = false;
        _downMoved = false;
    };
    window.addEventListener("mousemove", onWipeMove, true);
    window.addEventListener("mouseup", onWipeUp, true);
    overlay._xzgWipeMove = onWipeMove;
    overlay._xzgWipeUp = onWipeUp;

    ctrl.appendChild(videoCompareTitle);
    ctrl.appendChild(playPauseBtn);
    ctrl.appendChild(prevFrameBtn);
    ctrl.appendChild(nextFrameBtn);
    ctrl.appendChild(restartBtn);
    ctrl.appendChild(muteBtn);
    ctrl.appendChild(zoomSyncBtn);
    ctrl.appendChild(zoomBtn);
    ctrl.appendChild(wipeBtn);
    ctrl.appendChild(swapBtn);
    ctrl.appendChild(ultrawideBtn);
    ctrl.appendChild(scrubWrap);
    ctrl.appendChild(statusEl);
    closeBtn.style.marginLeft = "auto";
    ctrl.appendChild(closeBtn);
    // 控制栏（菜单 + 播放台）置于窗口最顶部，视频区之下
    win.insertBefore(ctrl, grid);
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
    const ZOOM_MIN = 0.3, ZOOM_MAX = 10;
    let _zoomAnchorRX = 50, _zoomAnchorRY = 50;
    let _holderBase = []; // 各窗格 scale=1 时的屏幕矩形
    let _holderT = [];    // 各窗格累计 translate
    const applyZoomText = () => {
        zoomBtn.textContent = "🔍 " + Math.round((_zoomScales[activeIndex] || 1) * 100) + "%";
        zoomSyncBtn.textContent = zoomSync ? "🔗 同步中" : "⛓ 不同步";
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
        // 中键，或 Ctrl+左键：进入平移模式
        const wantPan = (e.button === 1) || (e.button === 0 && e.ctrlKey);
        if (!wantPan) return;
        e.preventDefault();
        e.stopPropagation();
        const targetIndex = players.findIndex((p) => p.holder.contains(e.target));
        if (targetIndex < 0) return;
        _suppressClick = true;
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
    // 缩放状态与基线初始化后再默认启用双视频划像，避免访问尚未初始化的 let 状态。
    if (_n === 2) setWipeMode(true);
    _syncLoopOn = true;
    _syncMuted = true;

    // 全部就绪后统一从头播放（8 秒超时兜底：强制播放已就绪的）
    let readyCount = 0;
    let forceStarted = false;
    // 根据视频实际宽高比重排行列：全竖屏(9:16等)时横向排开，让格子高度最大化（画面更大）
    const applyGridLayout = () => {
        const ratios = players.map(p => p.player._videoRatio || 16 / 9);
        let cols, rows;
        const portraitPair = _n === 2 && ratios.every(r => r < 1);
        if (fixedThreeByTwo) {
            // 五/六路不随视频宽高比改变行列，保持上三下三；五路右下角留空。
            cols = 3;
            rows = 2;
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
            applyGridLayout(); // 全部就绪后按比例重排
            statusEl.textContent = "已暂停（点击播放开始）";
            // 保持暂停：进入对比界面停在开头，由用户手动开始
        } else {
            statusEl.textContent = "加载中... (" + readyCount + "/" + players.length + ")";
        }
    };
    _forceTimer = setTimeout(() => {
        if (forceStarted) return;
        forceStarted = true;
        applyGridLayout(); // 超时兜底：用已加载的比例重排
        statusEl.textContent = "已暂停（部分视频仍在加载）";
        // 超时兜底同样不自动播放
    }, 8000);

    for (const p of players) {
        p.player.onLoadedMetadata = () => {
            readyCount++;
            if (forceStarted) {
                p.player.seek(0); // 后就位的视频停在开头，保持暂停
            } else {
                tryStart();
            }
        };
        p.player.onError = () => {
            statusEl.textContent = "部分视频加载失败，其余正常播放";
        };
        p.player.setLoop(true);
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
        if (e.key === "Escape") {
            closeSyncPreview();
            return;
        }
        const t = e.target;
        const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
        if (typing) return;
        if (e.key === "ArrowLeft") {
            e.preventDefault();
            e.stopPropagation();
            stepFrame(-1);
        } else if (e.key === "ArrowRight") {
            e.preventDefault();
            e.stopPropagation();
            stepFrame(1);
        }
    };
    overlay._xzgOnKey = onKey;
    document.addEventListener("keydown", onKey, true);

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
        if (video) items.push(video);
        else {
            try {
                items.push(...await getImagesFromNode(n));
            } catch (error) {
                console.warn("[小珠光同步预览] 读取图片原图失败:", error);
                return false;
            }
        }
    }
    if (items.length === 0) {
        console.warn("[小珠光同步预览] 选中的节点中没有可预览的视频或图片");
        return false;
    }
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

    // 节点右键菜单：视频节点置顶「▶ 同步预览」（金色，放在菜单最上面）
    const origNodeMenu = LGC.prototype.getNodeMenuOptions;
    LGC.prototype.getNodeMenuOptions = function (node) {
        const options = origNodeMenu ? origNodeMenu.apply(this, arguments) : [];
        // 图片保存节点在自身 getExtraMenuOptions 中加入图片对比，兼容不经过
        // LiteGraph 旧式节点菜单钩子的 ComfyUI 前端。
        if (Array.isArray(options) && isVideoCompareEnabled() && nodeHasMedia(node) && !isImageSaveNode(node)) {
            options.unshift({
                content: `<span style='color:#dcc85b;font-weight:600'>${nodeHasImage(node) ? "▧ 图片对比" : "▶ 同步预览"}</span>`,
                callback: () => {
                    let nodes = getSelectedMediaNodes();
                    // 保证右键节点本身被包含（多选时选中集合应已含它，兜底补上）
                    if (!nodes.includes(node)) nodes.push(node);
                    previewNodes(nodes);
                },
            });
        }
        return options;
    };

    // 画布空白右键菜单：存在选中的视频节点时提供「同步预览选中视频」
    const origCanvasMenu = LGC.prototype.getCanvasMenuOptions;
    LGC.prototype.getCanvasMenuOptions = function () {
        const options = origCanvasMenu ? origCanvasMenu.apply(this, arguments) : [];
        if (Array.isArray(options) && isVideoCompareEnabled() && getSelectedMediaNodes().length > 0) {
            options.push(null);
            options.push({
                content: "<span style='color:#dcc85b;font-weight:600'>▶ 对比选中的视频/图片</span>",
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
    openSyncPreview,
    closeSyncPreview,
    nodeHasVideo,
    nodeHasImage,
    getVideoFromNode,
    getImageFromNode,
    getSelectedVideoNodes,
    getSelectedMediaNodes,
};

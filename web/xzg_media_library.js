import { api } from "../../scripts/api.js";
import { xzgT } from "./xzg_i18n.js";
import { cloudLoad, cloudSave } from "./xzg_cloud_store.js";

const endpoint = "/xzg/media-library";
const thumbnailCacheName = "xzg-media-library-thumbnails-v1";
let thumbnailCacheEpoch = 0;

async function thumbnailBlob(item, epoch) {
    const url = api.apiURL(`${endpoint}/thumb?name=${encodeURIComponent(item.name)}`);
    let cache = null;
    if ("caches" in window) {
        try {
            cache = await caches.open(thumbnailCacheName);
            const stored = await cache.match(url);
            if (stored?.headers.get("X-XZG-File-Version") === String(item.version)) {
                return stored.blob();
            }
        } catch (_) { cache = null; }
    }
    const response = await api.fetchApi(`${endpoint}/thumb?name=${encodeURIComponent(item.name)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    if (cache && epoch === thumbnailCacheEpoch) {
        try {
            await cache.put(url, new Response(blob, {
                headers: { "Content-Type": "image/png", "X-XZG-File-Version": String(item.version) },
            }));
        } catch (_) { /* 存储空间不足时仍可直接显示缩略图 */ }
    }
    return blob;
}

function mediaUrl(path, kind = "image") {
    return endpoint + path + (path.includes("?") ? "&" : "?") + "kind=" + kind;
}

async function mediaRequest(path = "", options = {}, kind = "image") {
    const response = await api.fetchApi(mediaUrl(path, kind), options);
    const body = await response.text();
    let data = null;
    try { data = JSON.parse(body); } catch (_) {}
    if (!response.ok) {
        if (response.status === 404 && !data) {
            throw new Error(xzgT("媒体库后端接口未就绪，请重启 ComfyUI 后端后刷新浏览器", "Media library API is unavailable. Restart the ComfyUI backend and refresh the browser."));
        }
        throw new Error(data?.error || body || `HTTP ${response.status}`);
    }
    if (!data || typeof data !== "object") {
        throw new Error(xzgT("媒体库接口返回了无效数据，请刷新浏览器", "Media library API returned invalid data. Refresh the browser."));
    }
    return data;
}

export function showMediaLibrary({ addImages, alertUser, confirmUser, kind = "image" }) {
    if (!document.getElementById("xzg-media-library-focus-style")) {
        const style = document.createElement("style");
        style.id = "xzg-media-library-focus-style";
        style.textContent = `
            .xzg-media-library-surface {
                --xzg-media-focus-border: #999;
                --xzg-media-focus-border: color-mix(in srgb, var(--comfy-menu-bg, #222) 45%, #ccc 55%);
            }
            .xzg-media-library-surface :focus {
                border-color: var(--xzg-media-focus-border) !important;
                outline: 1px solid var(--xzg-media-focus-border) !important;
                outline-offset: -1px;
            }
        `;
        document.head.appendChild(style);
    }
    const isVideo = kind === "video";
    const isAudio = kind === "audio";
    const geometryKey = kind === "image" ? "xzg_media_library_geometry" : `xzg_${kind}_media_library_geometry`;
    const request = (path = "", options = {}) => mediaRequest(path, options, kind);
    const url = path => mediaUrl(path, kind);
    const ALL_FOLDER = "__all__";
    const activeThumbnailUrls = new Set();
    const releaseThumbnailUrls = () => {
        activeThumbnailUrls.forEach(url => URL.revokeObjectURL(url));
        activeThumbnailUrls.clear();
    };
    // 缩略图内存 Blob 缓存（LRU）：滚动过的地方再次回来完全零网络请求
    const THUMB_MEM_MAX = 300;
    const thumbMemoryCache = new Map();
    const getCachedBlob = (name) => {
        const blob = thumbMemoryCache.get(name);
        if (blob) {
            thumbMemoryCache.delete(name);
            thumbMemoryCache.set(name, blob);
            return blob;
        }
        return null;
    };
    const putCachedBlob = (name, blob) => {
        thumbMemoryCache.delete(name);
        thumbMemoryCache.set(name, blob);
        while (thumbMemoryCache.size > THUMB_MEM_MAX) {
            const oldest = thumbMemoryCache.keys().next().value;
            thumbMemoryCache.delete(oldest);
        }
    };
    const prefetchThumbBlob = (name) => {
        if (thumbMemoryCache.has(name)) return;
        fetch(api.apiURL(url(`/thumb?name=${encodeURIComponent(name)}&v=${thumbnailCacheEpoch}`)))
            .then(r => (r.ok ? r.blob() : null))
            .then(blob => { if (blob) putCachedBlob(name, blob); })
            .catch(() => {});
    };
    const overlay = document.createElement("div");
    overlay.className = "xzg-media-library-surface";
    overlay.dataset.xzgMediaLibrary = "1";
    overlay.style.cssText = "position:fixed;inset:0;z-index:200000;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;";
    const dialog = document.createElement("div");
    dialog.tabIndex = -1;
    // 初始以绝对定位居中显示，之后可由标题栏拖动、右下角手柄缩放。
    dialog.style.cssText = "position:absolute;left:50%;top:50%;width:1200px;height:800px;max-width:calc(100vw - 40px);max-height:calc(100vh - 40px);min-width:560px;min-height:360px;margin:0;transform:translate(-50%,-50%);display:flex;flex-direction:column;background:var(--comfy-menu-bg);color:var(--input-text);border:1px solid var(--border-color);border-radius:8px;overflow:hidden;box-sizing:border-box;";
    dialog.addEventListener("click", event => event.stopPropagation());
    let geometryChanged = false;
    const saveGeometry = () => {
        geometryChanged = true;
        const rect = dialog.getBoundingClientRect();
        cloudSave(geometryKey, { width: rect.width, height: rect.height, x: rect.left, y: rect.top });
    };

    const header = document.createElement("div");
    header.style.cssText = "display:flex;gap:10px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--border-color);cursor:move;user-select:none;touch-action:none;";
    header.title = xzgT("拖动移动窗口", "Drag to move the window");
    // 标题栏拖动：移动 dialog 窗口位置
    let drag = null;
    const onHeaderDown = (event) => {
        if (event.button !== 0 || event.target.closest("input,button")) return;
        const rect = dialog.getBoundingClientRect();
        drag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
        dialog.style.left = `${rect.left}px`;
        dialog.style.top = `${rect.top}px`;
        dialog.style.transform = "none";
        header.setPointerCapture(event.pointerId);
        event.preventDefault();
        event.stopPropagation();
    };
    const onHeaderMove = (event) => {
        if (!drag) return;
        const left = Math.max(0, Math.min(window.innerWidth - dialog.offsetWidth, drag.left + event.clientX - drag.x));
        const top = Math.max(0, Math.min(window.innerHeight - 32, drag.top + event.clientY - drag.y));
        dialog.style.left = `${left}px`;
        dialog.style.top = `${top}px`;
        event.stopPropagation();
    };
    const onHeaderUp = () => { if (drag) saveGeometry(); drag = null; };
    header.addEventListener("pointerdown", onHeaderDown);
    header.addEventListener("pointermove", onHeaderMove);
    header.addEventListener("pointerup", onHeaderUp);
    header.addEventListener("pointercancel", onHeaderUp);

    // 右下角缩放手柄：拖动改变窗口大小
    const resizeHandle = document.createElement("div");
    resizeHandle.title = xzgT("拖动调整窗口大小", "Drag to resize the window");
    resizeHandle.style.cssText = "position:absolute;right:0;bottom:0;width:22px;height:22px;cursor:nwse-resize;touch-action:none;z-index:5;";
    resizeHandle.style.background = "linear-gradient(135deg,transparent 48%,var(--border-color) 48%,var(--border-color) 55%,transparent 55%)";
    let resize = null;
    const onResizeDown = (event) => {
        if (event.button !== 0) return;
        const rect = dialog.getBoundingClientRect();
        dialog.style.left = `${rect.left}px`;
        dialog.style.top = `${rect.top}px`;
        resize = { x: event.clientX, y: event.clientY, w: dialog.offsetWidth, h: dialog.offsetHeight };
        dialog.style.transform = "none";
        resizeHandle.setPointerCapture(event.pointerId);
        event.preventDefault();
        event.stopPropagation();
    };
    const onResizeMove = (event) => {
        if (!resize) return;
        const minW = 560, minH = 360;
        const w = Math.max(minW, Math.min(window.innerWidth - 40, resize.w + event.clientX - resize.x));
        const h = Math.max(minH, Math.min(window.innerHeight - 40, resize.h + event.clientY - resize.y));
        dialog.style.width = `${w}px`;
        dialog.style.height = `${h}px`;
        event.stopPropagation();
    };
    const onResizeUp = () => { if (resize) saveGeometry(); resize = null; };
    resizeHandle.addEventListener("pointerdown", onResizeDown);
    resizeHandle.addEventListener("pointermove", onResizeMove);
    resizeHandle.addEventListener("pointerup", onResizeUp);
    resizeHandle.addEventListener("pointercancel", onResizeUp);
    dialog.appendChild(resizeHandle);

    const title = document.createElement("strong");
    title.textContent = isAudio ? xzgT("资源媒体库 · 音频", "Media library · Audio") : isVideo ? xzgT("资源媒体库 · 视频", "Media library · Videos") : xzgT("资源媒体库 · 图片", "Media library · Images");
    title.style.cssText = "font-size:15px;flex:1;";
    const search = document.createElement("input");
    search.placeholder = isAudio ? xzgT("搜索音频…", "Search audio…") : isVideo ? xzgT("搜索视频…", "Search videos…") : xzgT("搜索图片…", "Search images…");
    search.style.cssText = "width:180px;padding:6px;background:var(--comfy-input-bg);color:var(--input-text);border:1px solid var(--border-color);border-radius:4px;font-size:14px;";
    const closeLibrary = () => {
        saveGeometry();
        closeContextMenu();
        window.removeEventListener("keydown", onLibraryKeyDown, true);
        window.removeEventListener("keyup", onLibraryKeyUp, true);
        window.removeEventListener("keydown", onShiftKeyDown, true);
        window.removeEventListener("keyup", onShiftKeyUp, true);
        window.removeEventListener("blur", onShiftKeyUp);
        releaseThumbnailUrls();
        gridResizeObserver?.disconnect();
        overlay.remove();
    };
    header.append(title, search);

    // 主体：左侧文件夹侧栏 + 右侧图片网格
    const body = document.createElement("div");
    body.style.cssText = "flex:1;display:flex;min-height:0;";
    const sidebar = document.createElement("div");
    sidebar.style.cssText = "width:168px;flex:0 0 168px;overflow:auto;padding:6px;border-right:1px solid var(--border-color);display:flex;flex-direction:column;gap:2px;";

    const grid = document.createElement("div");
    grid.style.cssText = "flex:1;overflow:auto;padding:0;display:block;user-select:none;scrollbarGutter:stable;";
const virtualStage = document.createElement("div");
virtualStage.style.cssText = "position:relative;width:100%;";
grid.appendChild(virtualStage);
let lastWindowKey = "";
    body.append(sidebar, grid);
    const footer = document.createElement("div");
    footer.style.cssText = "display:flex;align-items:center;gap:8px;padding:10px 36px 10px 16px;border-top:1px solid var(--border-color);";
    const makeButton = (label, action) => {
        const button = document.createElement("button");
        button.textContent = label;
        button.style.cssText = "padding:6px 12px;background:var(--comfy-menu-bg);color:var(--input-text);border:1px solid var(--border-color);border-radius:4px;cursor:pointer;font-size:14px;";
        button.onclick = action;
        return button;
    };
    const count = document.createElement("span");
    count.style.cssText = "font-size:14px;opacity:.8;flex:1;";
    const input = document.createElement("input");
    input.type = "file";
    input.accept = isAudio ? ".mp3,.wav,.ogg,.flac,.aac,.m4a,.wma,.opus,.amr,.ac3,.aiff,.au,.mka,.mp2,.ra,.voc,.w64" : isVideo ? ".webm,.mp4,.mkv,.gif,.mov,.avi,.flv,.wmv,.m4v,.mpg,.mpeg,.ts" : "image/png,image/jpeg,image/webp,image/gif,image/bmp,image/tiff";
    input.multiple = true;
    input.hidden = true;
    const upload = makeButton(isAudio ? xzgT("上传音频", "Upload audio") : isVideo ? xzgT("上传视频", "Upload videos") : xzgT("上传图片", "Upload images"), () => input.click());
    const doDelete = (names) => {
        if (!names.length) return;
        confirmUser(isAudio ? xzgT(`确定删除选中的 ${names.length} 个媒体库音频？`, `Delete ${names.length} selected audio files?`) : isVideo ? xzgT(`确定删除选中的 ${names.length} 个媒体库视频？`, `Delete ${names.length} selected library videos?`) : xzgT(`确定删除选中的 ${names.length} 张媒体库图片？`, `Delete ${names.length} selected library images?`), async () => {
            try {
                await request("", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ names }) });
                names.forEach(name => selected.delete(name));
                await refresh();
            } catch (error) { alertUser(error.message); }
        });
    };
    const remove = makeButton(xzgT("删除选中", "Delete selected"), () => doDelete([...selected]));
    remove.style.background = "#c0392b";
    remove.style.color = "#fff";
    remove.style.border = "none";
    const selectAll = makeButton(xzgT("全选", "Select all"), () => {
        visibleItems().forEach(item => selected.add(item.name));
        paintSelection();
        updateCount();
    });
    const clearSelect = makeButton(xzgT("取消全选", "Deselect all"), () => {
        selected.clear();
        lastClickedIndex = -1;
        paintSelection();
        updateCount();
    });
    let loading = false;
    const loadImages = async (names) => {
        if (!names.length || loading) return;
        if ((isVideo || isAudio) && names.length !== 1) {
            alertUser(xzgT("每次只能载入一个文件，请仅选择一个文件", "Select one media file to load into the loader."));
            return;
        }
        loading = true;
        add.disabled = true;
        try {
            const result = await request("/to-input", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ names }) });
            await addImages(result.names || []);
            closeLibrary();
        } catch (error) { alertUser(error.message); }
        finally { loading = false; add.disabled = false; }
    };
    const add = makeButton(xzgT("载入", "Load"), () => loadImages(items.filter(item => selected.has(item.name)).map(item => item.name)));
    add.style.cssText = "padding:6px 16px;background:#FFD700;color:#333;border:none;border-radius:4px;cursor:pointer;font-size:14px;font-weight:bold;";
    const cancel = document.createElement("button");
    cancel.textContent = xzgT("取消", "Cancel");
    cancel.style.cssText = "padding:6px 16px;background:var(--comfy-menu-bg);color:var(--input-text);border:1px solid var(--border-color);border-radius:4px;cursor:pointer;font-size:14px;";
    cancel.onclick = closeLibrary;
    // ---- 文件夹分类：新建 / 移动 / 删除空文件夹 ----
    // 通用文本输入小对话框（返回 Promise<string|null>，null 表示取消）
    const askText = (title, placeholder, initial = "") => new Promise(resolve => {
        const ov = document.createElement("div");
        ov.className = "xzg-media-library-surface";
        ov.dataset.xzgHigher = "1";
        ov.style.cssText = "position:fixed;inset:0;z-index:200002;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;";
        const panel = document.createElement("div");
        panel.style.cssText = "width:min(380px,90vw);padding:18px;background:var(--comfy-menu-bg);color:var(--input-text);border:1px solid var(--border-color);border-radius:8px;box-sizing:border-box;";
        const heading = document.createElement("div");
        heading.textContent = title;
        heading.style.cssText = "font-size:14px;font-weight:bold;margin-bottom:12px;";
        const text = document.createElement("input");
        text.type = "text";
        text.value = initial;
        text.placeholder = placeholder || "";
        text.style.cssText = "width:100%;box-sizing:border-box;padding:7px;background:var(--comfy-input-bg);color:var(--input-text);border:1px solid var(--border-color);border-radius:4px;font-size:14px;";
        const actions = document.createElement("div");
        actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:16px;";
        const ok = makeButton(xzgT("确定", "OK"), () => { const v = text.value.trim(); ov.remove(); resolve(v || null); });
        const c = makeButton(xzgT("取消", "Cancel"), () => { ov.remove(); resolve(null); });
        actions.append(c, ok);
        panel.append(heading, text, actions);
        ov.appendChild(panel);
        document.body.appendChild(ov);
        text.addEventListener("keydown", e => {
            if (e.key === "Enter") { e.preventDefault(); ok.click(); }
            if (e.key === "Escape") c.click();
        });
        text.focus();
        text.select();
    });
    // 移动目标选择对话框：根目录 + 已有文件夹 + 新建
    const chooseFolder = () => new Promise(resolve => {
        const ov = document.createElement("div");
        ov.className = "xzg-media-library-surface";
        ov.dataset.xzgHigher = "1";
        ov.style.cssText = "position:fixed;inset:0;z-index:200002;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;";
        const panel = document.createElement("div");
        panel.style.cssText = "width:min(320px,90vw);padding:14px;background:var(--comfy-menu-bg);color:var(--input-text);border:1px solid var(--border-color);border-radius:8px;box-sizing:border-box;";
        const heading = document.createElement("div");
        heading.textContent = xzgT("移动到文件夹", "Move to folder");
        heading.style.cssText = "font-size:14px;font-weight:bold;margin-bottom:10px;";
        const list = document.createElement("div");
        list.style.cssText = "display:flex;flex-direction:column;gap:4px;max-height:280px;overflow:auto;";
        const makeOption = (label, value) => {
            const row = document.createElement("div");
            row.textContent = label;
            row.style.cssText = "padding:8px 10px;background:var(--comfy-input-bg);color:var(--input-text);border:1px solid var(--border-color);border-radius:4px;cursor:pointer;font-size:14px;";
            row.onclick = () => { ov.remove(); resolve(value); };
            return row;
        };
        list.appendChild(makeOption(xzgT("根目录", "Root")));
        folders.forEach(f => list.appendChild(makeOption(f, f)));
        const actions = document.createElement("div");
        actions.style.cssText = "display:flex;justify-content:flex-end;margin-top:12px;";
        const cancel = makeButton(xzgT("取消", "Cancel"), () => { ov.remove(); resolve(null); });
        actions.appendChild(cancel);
        panel.append(heading, list, actions);
        ov.appendChild(panel);
        document.body.appendChild(ov);
    });
    // 新建文件夹（供根目录行“+”按钮使用）：创建后进入该文件夹
    const createFolder = async () => {
        const name = await askText(xzgT("新建文件夹", "New folder"), xzgT("文件夹名称", "Folder name"));
        if (!name) return;
        try {
            const result = await request("/folder", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
            currentFolder = result.name;
            await refresh();
        } catch (error) { alertUser(error.message); }
    };
    footer.append(upload, selectAll, clearSelect, remove, count, cancel, add, input);
    dialog.append(header, body, footer);
    overlay.appendChild(dialog);
    // 防重复：同一时刻只保留一个媒体库实例，避免多个弹窗持有独立选中集合导致 Delete 状态错乱
    document.querySelectorAll('[data-xzg-media-library="1"]').forEach(el => el.remove());
    document.body.appendChild(overlay);
    // 面板/窗口尺寸变化时自动重排：让缩略图随 grid 可用宽度自适应
    const gridResizeObserver = new ResizeObserver(() => {
        if (grid.isConnected) render(false);
    });
    gridResizeObserver.observe(grid);
    // 抢占键盘焦点到弹窗内，避免 ComfyUI 全局快捷键把 Delete 当成"删除节点"等操作拦截掉
    dialog.focus();

    let items = [];
    let folders = [];
    let currentFolder = ALL_FOLDER;
    const selected = new Set();
    let shiftHeld = false;
    const onShiftKeyDown = event => {
        if (event.key !== "Shift") return;
        shiftHeld = true;
        requestAnimationFrame(() => { if (overlay.isConnected) paintSelection(); });
    };
    const onShiftKeyUp = event => { if (!event.key || event.key === "Shift") shiftHeld = false; };
    window.addEventListener("keydown", onShiftKeyDown, true);
    window.addEventListener("keyup", onShiftKeyUp, true);
    window.addEventListener("blur", onShiftKeyUp);
    // 统一删除逻辑：keydown/keyup 共用，返回是否已处理（弹窗激活且不在输入框内）
    let lastDeleteAt = 0;
    const runDelete = (target) => {
        if (!overlay.isConnected) return false;
        // 防抖：同一次按键的 keydown/keyup 多重监听只执行一次
        const now = Date.now();
        if (now - lastDeleteAt < 250) return false;
        lastDeleteAt = now;
        // 在输入类元素（搜索框、重命名输入框等）内按 Delete 只删字符，不删图片
        if (target instanceof Element && target.closest("input, textarea, [contenteditable='true']")) return false;
        // 只认媒体库自己创建的重命名对话框（带 data-xzg-higher 标记），不误伤其他扩展的高 zIndex 浮层
        if ([...document.body.children].some(child => child !== overlay && child.dataset?.xzgHigher === "1" &&
            getComputedStyle(child).position === "fixed" && Number(getComputedStyle(child).zIndex) > 200000 && child.isConnected)) return false;
        if (!selected.size) {
            // 兜底：若 selected 集合与卡片高亮不同步（罕见的多实例/重绘场景），从高亮卡片重建选中集合
            grid.querySelectorAll("[data-media-name][data-xzg-selected='1']").forEach(card => {
                selected.add(card.dataset.mediaName);
            });
        }
        if (selected.size) {
            remove.click();
        } else {
            // 未选中任何图片时给出明确提示，避免"按了没反应"的困惑
            alertUser(xzgT("请先选中要删除的媒体（单击卡片使其高亮）", "Select media first (click a card to highlight it)."));
        }
        return true;
    };
    const onLibraryKeyDown = event => {
        // ESC 关闭媒体库：有更高层子对话框（重命名/移动/新建/右键菜单）打开时由子层自行处理，不关整窗
        if (event.key === "Escape" && !event.repeat) {
            if (!overlay.isConnected) return;
            const hasHigher = [...document.body.children].some(child => child !== overlay &&
                getComputedStyle(child).position === "fixed" && Number(getComputedStyle(child).zIndex) > 200000 && child.isConnected);
            if (hasHigher) return;
            event.preventDefault();
            event.stopPropagation();
            closeLibrary();
            return;
        }
        // Ctrl+A / ⌘+A 全选当前可见图片（输入框内保留文本全选）
        if ((event.key === "a" || event.key === "A") && (event.ctrlKey || event.metaKey) && !event.repeat) {
            if (!overlay.isConnected) return;
            if (event.target instanceof Element && event.target.closest("input, textarea, [contenteditable='true']")) return;
            event.preventDefault();
            event.stopPropagation();
            visibleItems().forEach(item => selected.add(item.name));
            paintSelection();
            updateCount();
            return;
        }
        if (event.key !== "Delete" || event.repeat) return;
        if (runDelete(event.target)) {
            event.preventDefault();
            event.stopPropagation();
        }
    };
    const onLibraryKeyUp = event => {
        if (event.key !== "Delete" || event.repeat) return;
        runDelete(event.target);
    };
    // 关键：监听同时绑到弹窗元素自身（目标阶段）与 window（兜底），双保险；
    // 只要焦点在弹窗内，dialog 上的监听就一定能收到，绕开 ComfyUI 对全局键盘事件的拦截。
    window.addEventListener("keydown", onLibraryKeyDown, true);
    window.addEventListener("keyup", onLibraryKeyUp, true);
    // 焦点锁定：焦点离开弹窗到外部时拉回弹窗，确保 keydown 的 target 始终在弹窗内，
    // 使 ComfyUI 无法抢走焦点；焦点进入更高层覆盖层（重命名对话框等）时不移回。
    const inHigherOverlay = node => node instanceof Element &&
        [...document.body.children].some(child => child !== overlay &&
            getComputedStyle(child).position === "fixed" && Number(getComputedStyle(child).zIndex) > 200000 && child.contains(node));
    dialog.addEventListener("focusout", event => {
        if (!overlay.isConnected) return;
        const next = event.relatedTarget;
        if (next && dialog.contains(next)) return;
        if (next && inHigherOverlay(next)) return;
        requestAnimationFrame(() => {
            if (!overlay.isConnected) return;
            const active = document.activeElement;
            if (!active) { dialog.focus(); return; }
            if (dialog.contains(active) || inHigherOverlay(active)) return;
            dialog.focus();
        });
    });
    let lastClickedIndex = -1;
    const visibleItems = () => {
        const filter = search.value.trim().toLowerCase();
        return items.filter(item => item.name.toLowerCase().includes(filter));
    };
    const updateCount = () => {
        const where = currentFolder === ALL_FOLDER ? "" : (currentFolder ? `${currentFolder} · ` : "");
        count.textContent = isAudio ? xzgT(`${where}${items.length} 个音频 · 已选 ${selected.size} 个`, `${where}${items.length} audio files · ${selected.size} selected`) : isVideo ? xzgT(`${where}${items.length} 个视频 · 已选 ${selected.size} 个`, `${where}${items.length} videos · ${selected.size} selected`) : xzgT(`${where}${items.length} 张图片 · 已选 ${selected.size} 张`, `${where}${items.length} images · ${selected.size} selected`);
    };
    const paintSelection = () => {
        grid.querySelectorAll("[data-media-name]").forEach(card => {
            const active = selected.has(card.dataset.mediaName);
            card.dataset.xzgSelected = active ? "1" : "0";
            card.style.borderColor = active ? "#ffd700" : "var(--border-color)";
            card.style.boxShadow = active ? "inset 0 0 0 1px #ffd700" : "none";
            card.style.background = "var(--comfy-input-bg)";
        });
        updateCount();
    };
    let contextMenu = null;
    let closeContextMenu = () => {};
    const showRenameDialog = oldName => {
        const slash = oldName.lastIndexOf("/");
        const folder = slash >= 0 ? oldName.slice(0, slash + 1) : "";
        const base = slash >= 0 ? oldName.slice(slash + 1) : oldName;
        const dot = base.lastIndexOf(".");
        const stem = dot >= 0 ? base.slice(0, dot) : base;
        const extension = dot >= 0 ? base.slice(dot) : "";
        const renameOverlay = document.createElement("div");
        renameOverlay.className = "xzg-media-library-surface";
        renameOverlay.dataset.xzgHigher = "1";
        renameOverlay.style.cssText = "position:fixed;inset:0;z-index:200002;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;";
        const panel = document.createElement("div");
        panel.style.cssText = "width:min(420px,90vw);padding:18px;background:var(--comfy-menu-bg);color:var(--input-text);border:1px solid var(--border-color);border-radius:8px;box-sizing:border-box;";
        const heading = document.createElement("div");
        heading.textContent = xzgT("重命名媒体库文件", "Rename library file");
        heading.style.cssText = "font-size:14px;font-weight:bold;margin-bottom:12px;";
        const row = document.createElement("div");
        row.style.cssText = "display:flex;align-items:center;gap:5px;";
        const folderLabel = document.createElement("span");
        folderLabel.textContent = folder;
        folderLabel.title = xzgT("所属文件夹不可在重命名时更改", "Folder cannot change on rename");
        folderLabel.style.cssText = "font-size:14px;opacity:.75;flex:0 0 auto;";
        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.value = stem;
        nameInput.style.cssText = "flex:1;min-width:0;padding:7px;background:var(--comfy-input-bg);color:var(--input-text);border:1px solid var(--border-color);border-radius:4px;";
        const suffix = document.createElement("span");
        suffix.textContent = extension;
        suffix.style.cssText = "font-size:14px;opacity:.75;";
        row.append(folderLabel, nameInput, suffix);
        const actions = document.createElement("div");
        actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:16px;";
        const cancel = makeButton(xzgT("取消", "Cancel"), () => renameOverlay.remove());
        const save = makeButton(xzgT("保存", "Save"), async () => {
            const newName = folder + nameInput.value.trim() + extension;
            if (!nameInput.value.trim()) {
                alertUser(xzgT("文件名称不能为空", "File name cannot be empty"));
                return;
            }
            if (newName === oldName) { renameOverlay.remove(); return; }
            save.disabled = true;
            try {
                const result = await request("/rename", {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ old_name: oldName, new_name: newName }),
                });
                if (selected.delete(oldName)) selected.add(result.name);
                await refresh();
                renameOverlay.remove();
            } catch (error) { alertUser(error.message); }
            finally { save.disabled = false; }
        });
        nameInput.addEventListener("keydown", event => {
            if (event.key === "Enter") { event.preventDefault(); save.click(); }
            if (event.key === "Escape") renameOverlay.remove();
        });
        actions.append(cancel, save);
        panel.append(heading, row, actions);
        renameOverlay.appendChild(panel);
        document.body.appendChild(renameOverlay);
        nameInput.focus();
        nameInput.select();
    };
    const showContextMenu = (name, x, y) => {
        closeContextMenu();
        const menu = document.createElement("div");
        menu.className = "xzg-media-library-surface";
        contextMenu = menu;
        menu.style.cssText = "position:fixed;z-index:200001;min-width:130px;padding:4px;background:var(--comfy-menu-bg);color:var(--input-text);border:1px solid var(--border-color);border-radius:5px;box-shadow:0 6px 18px rgba(0,0,0,.35);";
        const rename = makeButton(xzgT("重命名", "Rename"), () => {
            closeContextMenu();
            showRenameDialog(name);
        });
        rename.style.cssText = "display:block;width:100%;padding:7px 10px;text-align:left;border:0;background:transparent;color:var(--input-text);cursor:pointer;";
        menu.appendChild(rename);
        // 移动到文件夹：该图在多选内则移动整个多选，否则移动当前图
        const move = makeButton(xzgT("移动到文件夹…", "Move to folder…"), async () => {
            const targets = selected.has(name) ? [...selected] : [name];
            closeContextMenu();
            const target = await chooseFolder();
            if (target === null || target === currentFolder) return;
            try {
                const result = await request("/move", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ names: targets, folder: target }) });
                if (selected.has(name)) selected.clear();
                else selected.delete(name);
                lastClickedIndex = -1;
                await refresh();
                if (result.names) alertUser(xzgT(`已移动 ${result.names.length} 个文件`, `Moved ${result.names.length} files`));
            } catch (error) { alertUser(error.message); }
        });
        move.style.cssText = "display:block;width:100%;padding:7px 10px;text-align:left;border:0;background:transparent;color:var(--input-text);cursor:pointer;";
        menu.appendChild(move);
        const separator = document.createElement("div");
        separator.style.cssText = "height:1px;margin:4px 0;background:var(--border-color);";
        menu.appendChild(separator);
        const del = makeButton(xzgT("删除", "Delete"), () => {
            closeContextMenu();
            doDelete(selected.has(name) ? [...selected] : [name]);
        });
        del.style.cssText = "display:block;width:100%;padding:7px 10px;text-align:left;border:0;background:transparent;color:#e04b4b;cursor:pointer;";
        menu.appendChild(del);
        document.body.appendChild(menu);
        const bounds = menu.getBoundingClientRect();
        menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - bounds.width - 4))}px`;
        menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - bounds.height - 4))}px`;
        const onOutside = event => { if (!menu.contains(event.target)) closeContextMenu(); };
        const onEscape = event => { if (event.key === "Escape") closeContextMenu(); };
        closeContextMenu = () => {
            menu.remove();
            document.removeEventListener("pointerdown", onOutside);
            document.removeEventListener("keydown", onEscape);
            if (contextMenu === menu) contextMenu = null;
        };
        document.addEventListener("pointerdown", onOutside);
        document.addEventListener("keydown", onEscape);
    };
    const selectClicked = (name, shiftKey, additiveKey) => {
        const visible = visibleItems();
        const index = visible.findIndex(item => item.name === name);
        if (index < 0) return;
        if (shiftKey) {
            const anchor = lastClickedIndex >= 0 && lastClickedIndex < visible.length
                ? lastClickedIndex
                : visible.findIndex(item => selected.has(item.name));
            if (anchor < 0) {
                selected.add(name);
                lastClickedIndex = index;
            } else {
                for (let i = Math.min(index, anchor); i <= Math.max(index, anchor); i++) {
                    selected.add(visible[i].name);
                }
                lastClickedIndex = anchor;
            }
        } else if (additiveKey) {
            selected.has(name) ? selected.delete(name) : selected.add(name);
            lastClickedIndex = index;
        } else {
            selected.clear();
            selected.add(name);
            lastClickedIndex = index;
        }
        paintSelection();
    };
    const createCard = (item) => {
        const card = document.createElement("div");
        card.dataset.mediaName = item.name;
        card.title = `${item.name}\n${xzgT("拖动调序；双击加入加载器", "Drag to reorder; double-click to add to loader")}`;
        card.style.cssText = `position:absolute;box-sizing:border-box;border:1px solid ${selected.has(item.name) ? "#ffd700" : "var(--border-color)"};box-shadow:${selected.has(item.name) ? "inset 0 0 0 1px #ffd700" : "none"};border-radius:5px;background:var(--comfy-input-bg);color:var(--input-text);cursor:pointer;overflow:hidden;display:flex;flex-direction:column;`;
        card.dataset.xzgSelected = selected.has(item.name) ? "1" : "0";
        const imageBox = document.createElement("div");
        imageBox.className = "xzg-media-image";
        imageBox.style.cssText = "position:relative;width:100%;aspect-ratio:1;padding:4px;box-sizing:border-box;background:#000;";
        const number = document.createElement("span");
        number.textContent = String(items.indexOf(item) + 1);
        number.title = xzgT("媒体库顺序", "Library order");
        number.style.cssText = "position:absolute;top:3px;left:3px;z-index:1;min-width:16px;padding:2px 4px;border-radius:3px;background:rgba(0,0,0,.72);color:#fff;font-size:14px;line-height:1.2;pointer-events:none;";
        const image = document.createElement("img");
        image.loading = "lazy";
        image.draggable = true;
        image.style.cssText = "width:100%;height:100%;object-fit:contain;cursor:grab;";
        image.addEventListener("dragstart", event => {
            if (event.ctrlKey || event.metaKey) { event.preventDefault(); return; }
            dragSource = item.name;
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", item.name);
        });
        imageBox.append(image, number);
        const label = document.createElement("span");
        label.textContent = item.name;
        label.style.cssText = "flex:0 0 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:3px 4px;color:var(--input-text);font-size:12px;line-height:14px;text-align:center;pointer-events:none;";
        if (isAudio) {
            card.style.flexDirection = "row";
            card.style.alignItems = "center";
            imageBox.style.flex = "0 0 auto";
            imageBox.style.aspectRatio = "auto";
            label.title = item.name;
            label.style.cssText = "flex:1;min-width:0;padding:6px 12px;color:var(--input-text);font-size:14px;line-height:20px;text-align:left;white-space:normal;overflow-wrap:anywhere;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;";
        }
        card.append(imageBox, label);
        // 缩略图：优先用内存 Blob 缓存（滚动过的地方零网络请求）；
        // 未命中时同步 URL 立即显示，图片加载完成后后台缓存 blob 供下次零请求
        const memBlob = getCachedBlob(item.name);
        if (memBlob) {
            const objectUrl = URL.createObjectURL(memBlob);
            activeThumbnailUrls.add(objectUrl);
            card._thumbUrl = objectUrl;
            image.src = objectUrl;
            const release = () => {
                URL.revokeObjectURL(objectUrl);
                activeThumbnailUrls.delete(objectUrl);
                card._thumbUrl = null;
            };
            image.onload = release;
            image.onerror = release;
        } else {
            image.src = api.apiURL(url(`/thumb?name=${encodeURIComponent(item.name)}&v=${thumbnailCacheEpoch}`));
            image.onload = () => prefetchThumbBlob(item.name);
            image.onerror = () => prefetchThumbBlob(item.name);
        }
        return card;
    };
    const render = (force = true) => {
        const visible = visibleItems();
        updateCount();
        if (!visible.length) {
            virtualStage.replaceChildren();
            const empty = document.createElement("div");
            empty.dataset.xzgMediaEmpty = "1";
            empty.textContent = items.length ? xzgT("没有匹配的媒体", "No matching media") : isAudio ? xzgT("媒体库为空，点击“上传音频”添加", "Library is empty. Upload audio to get started.") : isVideo ? xzgT("媒体库为空，点击“上传视频”添加", "Library is empty. Upload videos to get started.") : xzgT("媒体库为空，点击“上传图片”添加", "Library is empty. Upload images to get started.");
            empty.style.cssText = "position:absolute;top:80px;left:0;right:0;text-align:center;opacity:.7;";
            virtualStage.appendChild(empty);
            return;
        }
        virtualStage.querySelector('[data-xzg-media-empty="1"]')?.remove();
        const gap = isAudio ? 6 : 2;
        const inset = 8;
        // 列数按可用宽度动态计算，使缩略图大小随面板/窗口尺寸自适应：
        // 目标单元格约 targetCell 宽，且不小于 minCell，也不超过图片数量与上限。
        const availW = grid.clientWidth - inset * 2;
        const targetCell = 200;
        const minCell = 120;
        let cols;
        if (isAudio) {
            cols = 1;
        } else {
            const byTarget = Math.max(1, Math.floor((availW + gap) / (targetCell + gap)));
            const maxByMin = Math.max(1, Math.floor((availW + gap) / (minCell + gap)));
            cols = Math.max(1, Math.min(byTarget, maxByMin, Math.max(1, visible.length), 20));
        }
        const cellWidth = Math.max(1, (grid.clientWidth - inset * 2 - gap * (cols - 1)) / cols);
        const labelHeight = 20;
        const cardHeight = isAudio ? 80 : cellWidth + labelHeight;
        const rowPitch = cardHeight + gap;
        const rows = Math.ceil(visible.length / cols);
        const totalHeight = inset * 2 + Math.max(0, rows * cardHeight + (rows - 1) * gap);
        virtualStage.style.height = totalHeight + "px";
        const scrollTop = Math.min(grid.scrollTop, Math.max(0, totalHeight - grid.clientHeight));
        const firstRow = Math.max(0, Math.floor(scrollTop / rowPitch) - 2);
        const lastRow = Math.min(rows, Math.ceil((scrollTop + grid.clientHeight) / rowPitch) + 2);
        const windowKey = search.value + "|" + visible.length + "|" + grid.clientWidth + "|" + firstRow + "|" + lastRow;
        if (!force && windowKey === lastWindowKey) return;
        lastWindowKey = windowKey;
        // 增量渲染：复用仍在可视窗口内的卡片（img 不重建、缩略图不重载），
        // 只移除滚出窗口的卡片、补建新进入窗口的卡片。
        const wanted = new Map();
        for (let i = firstRow * cols; i < Math.min(visible.length, lastRow * cols); i++) {
            const item = visible[i];
            wanted.set(item.name, { item, col: i % cols, row: Math.floor(i / cols) });
        }
        const existing = new Map();
        virtualStage.querySelectorAll("[data-media-name]").forEach(card => existing.set(card.dataset.mediaName, card));
        existing.forEach((card, name) => {
            const w = wanted.get(name);
            if (w) {
                card.style.left = (inset + w.col * (cellWidth + gap)) + "px";
                card.style.top = (inset + w.row * rowPitch) + "px";
                card.style.width = cellWidth + "px";
                card.style.height = cardHeight + "px";
                const imageBoxEl = card.querySelector(".xzg-media-image");
                if (imageBoxEl) {
                    imageBoxEl.style.width = (isAudio ? Math.min(144, cellWidth * 0.3) : cellWidth) + "px";
                    imageBoxEl.style.height = (isAudio ? cardHeight - 2 : cellWidth) + "px";
                }
            } else {
                if (card._thumbUrl) {
                    URL.revokeObjectURL(card._thumbUrl);
                    activeThumbnailUrls.delete(card._thumbUrl);
                    card._thumbUrl = null;
                }
                card.remove();
            }
        });
        const frag = document.createDocumentFragment();
        wanted.forEach((w, name) => {
            if (existing.has(name)) return;
            const card = createCard(w.item);
            card.style.left = (inset + w.col * (cellWidth + gap)) + "px";
            card.style.top = (inset + w.row * rowPitch) + "px";
            card.style.width = cellWidth + "px";
            card.style.height = cardHeight + "px";
            const imageBoxEl = card.querySelector(".xzg-media-image");
            if (imageBoxEl) {
                imageBoxEl.style.width = (isAudio ? Math.min(144, cellWidth * 0.3) : cellWidth) + "px";
                imageBoxEl.style.height = (isAudio ? cardHeight - 2 : cellWidth) + "px";
            }
            frag.appendChild(card);
        });
        virtualStage.appendChild(frag);
    };
    grid.addEventListener("scroll", () => render(false));
    let dragSource = null;
    let dragTarget = null;
    const clearDragTarget = () => {
        if (dragTarget) dragTarget.style.outline = "";
        dragTarget = null;
    };
    grid.addEventListener("dragover", event => {
        if (!dragSource) return;
        const card = event.target.closest("[data-media-name]");
        if (card && card.dataset.mediaName !== dragSource) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            if (dragTarget !== card) {
                clearDragTarget();
                dragTarget = card;
                card.style.outline = "2px dashed #ffd700";
            }
        }
        // 拖动到列表顶部/底部边缘时自动滚动，支持长距离调序
        const rect = grid.getBoundingClientRect();
        const py = event.clientY;
        const edge = 60;
        if (py < rect.top + edge) {
            grid.scrollTop -= 30;
        } else if (py > rect.bottom - edge) {
            grid.scrollTop += 30;
        }
    });
    grid.addEventListener("drop", async event => {
        if (!dragSource) return;
        event.preventDefault();
        const targetName = event.target.closest("[data-media-name]")?.dataset.mediaName;
        clearDragTarget();
        const sourceName = dragSource;
        dragSource = null;
        if (!targetName || targetName === sourceName) return;
        const oldItems = [...items];
        const from = items.findIndex(item => item.name === sourceName);
        const to = items.findIndex(item => item.name === targetName);
        if (from < 0 || to < 0) return;
        const [moved] = items.splice(from, 1);
        items.splice(to, 0, moved);
        render();
        try {
            await request("/order", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ names: items.map(item => item.name), folder: currentFolder }),
            });
        } catch (error) {
            items = oldItems;
            render();
            alertUser(error.message);
        }
    });
    grid.addEventListener("dragend", () => { dragSource = null; clearDragTarget(); });
    grid.addEventListener("contextmenu", event => {
        const name = event.target.closest("[data-media-name]")?.dataset.mediaName;
        if (!name) return;
        event.preventDefault();
        event.stopPropagation();
        showContextMenu(name, event.clientX, event.clientY);
    });
    let imageClickShift = false;
    grid.addEventListener("click", event => {
        const imageBox = event.target.closest(".xzg-media-image");
        if (!imageBox) return;
        event.stopPropagation();
        const name = imageBox.closest("[data-media-name]")?.dataset.mediaName;
        if (name) selectClicked(name, event.shiftKey || shiftHeld || imageClickShift, event.ctrlKey || event.metaKey);
        imageClickShift = false;
    });
    grid.addEventListener("dblclick", event => {
        const name = event.target.closest("[data-media-name]")?.dataset.mediaName;
        if (!name) return;
        event.preventDefault();
        event.stopPropagation();
        loadImages([name]);
    });
    grid.addEventListener("mousedown", event => {
        imageClickShift = !!event.target.closest(".xzg-media-image") && (event.shiftKey || shiftHeld);
        if (event.button !== 0 || !visibleItems().length) return;
        event.stopPropagation();
        if (!event.ctrlKey && !event.metaKey && event.target.closest(".xzg-media-image")) return;
        event.preventDefault();

        const startX = event.clientX;
        const startY = event.clientY;
        const clickedName = event.target.closest("[data-media-name]")?.dataset.mediaName;
        const shiftSelect = event.shiftKey || shiftHeld;
        const additive = shiftSelect || event.ctrlKey || event.metaKey;
        const initial = additive ? new Set(selected) : new Set();
        let moved = false;

        const marquee = document.createElement("div");
        marquee.style.cssText = "position:fixed;border:1px solid #ffd700;background:transparent;pointer-events:none;z-index:200001;display:none;";
        document.body.appendChild(marquee);

        const onMove = moveEvent => {
            const dx = moveEvent.clientX - startX;
            const dy = moveEvent.clientY - startY;
            if (Math.max(Math.abs(dx), Math.abs(dy)) > 5) moved = true;
            if (!moved) return;
            const left = Math.min(startX, moveEvent.clientX);
            const top = Math.min(startY, moveEvent.clientY);
            const right = Math.max(startX, moveEvent.clientX);
            const bottom = Math.max(startY, moveEvent.clientY);
            marquee.style.display = "block";
            marquee.style.left = `${left}px`;
            marquee.style.top = `${top}px`;
            marquee.style.width = `${right - left}px`;
            marquee.style.height = `${bottom - top}px`;

            selected.clear();
            initial.forEach(name => selected.add(name));
            grid.querySelectorAll("[data-media-name]").forEach(card => {
                const rect = card.getBoundingClientRect();
                if (rect.right > left && rect.left < right && rect.bottom > top && rect.top < bottom) {
                    selected.add(card.dataset.mediaName);
                }
            });
            paintSelection();
        };
        const onUp = () => {
            marquee.remove();
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            document.removeEventListener("contextmenu", onContextMenu, true);
            if (moved) return;

            if (clickedName) {
                selectClicked(clickedName, shiftSelect, event.ctrlKey || event.metaKey);
            } else if (!additive) {
                selected.clear();
                lastClickedIndex = -1;
            }
            paintSelection();
        };
        const onContextMenu = contextEvent => contextEvent.preventDefault();
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
        document.addEventListener("contextmenu", onContextMenu, true);
    });
    // 侧栏文件夹拖拽排序共享状态与辅助函数（容器级监听只绑定一次）
    let folderInsertIndex = null;
    const hasDragType = (event, type) => event.dataTransfer && Array.from(event.dataTransfer.types).includes(type);
    const clearInsertMarker = () => sidebar.querySelector("[data-insert-marker]")?.remove();
    const showInsertMarker = (rows, index) => {
        clearInsertMarker();
        const marker = document.createElement("div");
        marker.dataset.insertMarker = "1";
        marker.style.cssText = "height:3px;flex:none;border-radius:2px;background:#4CAF50;box-shadow:0 0 6px rgba(76,175,80,0.8);margin:0";
        sidebar.insertBefore(marker, rows[index] || null);
    };
    const renderSidebar = () => {
        sidebar.replaceChildren();
        // 拖拽排序状态（仅针对文件夹项），容器级 drop（与文本框预设管理一致）
        const makeItem = (label, value) => {
            const row = document.createElement("div");
            row.style.cssText = "display:flex;align-items:center;gap:6px;padding:6px 8px 6px 9px;border-radius:4px;cursor:pointer;font-size:14px;border:1px solid transparent;box-sizing:border-box;";
            row.style.background = value === currentFolder ? "rgba(255,255,255,.12)" : "transparent";
            const nameEl = document.createElement("span");
            nameEl.textContent = label;
            nameEl.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--input-text);";
            row.appendChild(nameEl);
            const iconBtn = (glyph, title, color, onClick, fontSize = 18) => {
                const btn = document.createElement("button");
                btn.type = "button";
                btn.textContent = glyph;
                btn.title = title;
                btn.style.cssText = `box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;flex:none;width:26px;height:26px;padding:0;background:transparent;border:0;border-radius:4px;color:${color};font-size:${fontSize}px;line-height:26px;cursor:pointer;opacity:.7;`;
                btn.onmouseenter = () => { btn.style.opacity = "1"; btn.style.background = "rgba(255,255,255,.12)"; };
                btn.onmouseleave = () => { btn.style.opacity = ".7"; btn.style.background = "transparent"; };
                btn.onclick = (e) => { e.stopPropagation(); onClick(); };
                return btn;
            };
            if (!value || value === ALL_FOLDER) {
                // “全部/根目录”行：右侧“+”新建文件夹（放大版，突出主入口）
                const addBtn = document.createElement("button");
                addBtn.type = "button";
                addBtn.textContent = "+";
                addBtn.title = xzgT("新建文件夹", "New folder");
                addBtn.style.cssText = "box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;flex:none;width:26px;height:26px;padding:0;background:transparent;border:0;border-radius:4px;color:var(--input-text);font-size:20px;line-height:26px;cursor:pointer;font-weight:bold;opacity:.7;";
                addBtn.onmouseenter = () => { addBtn.style.background = "rgba(255,255,255,.12)"; addBtn.style.opacity = "1"; };
                addBtn.onmouseleave = () => { addBtn.style.background = "transparent"; addBtn.style.opacity = ".7"; };
                addBtn.onclick = (e) => { e.stopPropagation(); createFolder(); };
                row.append(addBtn);
            } else {
                // 文件夹项：可拖拽排序 + 右侧操作图标（✎ 重命名 / × 删除，与文本框-化神级提示词类型管理一致）
                row.draggable = true;
                row.dataset.folderRow = "1";
                row.addEventListener("dragstart", event => {
                    if (event.target.closest("button")) { event.preventDefault(); return; }
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("application/x-xzg-media-folder", value);
                    row.style.opacity = ".5";
                });
                row.addEventListener("dragend", () => {
                    row.style.opacity = "";
                    clearInsertMarker();
                    folderInsertIndex = null;
                });
                row.addEventListener("dragover", event => {
                    if (!hasDragType(event, "application/x-xzg-media-folder")) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    const rect = row.getBoundingClientRect();
                    const rows = [...sidebar.querySelectorAll("[data-folder-row]")];
                    const index = rows.indexOf(row);
                    folderInsertIndex = event.clientY - rect.top < rect.height / 2 ? index : index + 1;
                    showInsertMarker(rows, folderInsertIndex);
                });
                const renameBtn = iconBtn("✎", xzgT("重命名文件夹", "Rename folder"), "var(--input-text)", async () => {
                    const newName = await askText(xzgT("重命名文件夹", "Rename folder"), xzgT("文件夹名称", "Folder name"), value);
                    if (!newName || newName === value) return;
                    try {
                        await request("/folder-rename", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ old_name: value, new_name: newName }) });
                        if (currentFolder === value) currentFolder = newName;
                        await refresh();
                    } catch (error) { alertUser(error.message); }
                });
                const delBtn = iconBtn("×", xzgT("删除文件夹", "Delete folder"), "#c75c5c", () => {
                    confirmUser(xzgT(`确定删除空文件夹「${value}」？`, `Delete empty folder "${value}"?`), async () => {
                        try {
                            await request("/folder", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folder: value }) });
                            if (currentFolder === value) currentFolder = "";
                            await refresh();
                        } catch (error) { alertUser(error.message); }
                    });
                }, 16);
                row.append(renameBtn, delBtn);
            }
            row.onclick = () => {
                if (value === currentFolder) return;
                selected.clear();
                lastClickedIndex = -1;
                currentFolder = value;
                refresh().catch(error => alertUser(error.message));
            };
            return row;
        };
        sidebar.appendChild(makeItem(xzgT("全部", "All"), ALL_FOLDER));
        folders.forEach(f => sidebar.appendChild(makeItem(f, f)));
        const spacer = document.createElement("div");
        spacer.style.cssText = "flex:1;";
        sidebar.appendChild(spacer);
    };
    // 容器级拖放：只要在侧栏内（含行间隙/空白处）松手即可完成排序（绑定一次）
    sidebar.addEventListener("dragover", event => {
        if (!hasDragType(event, "application/x-xzg-media-folder")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
    });
    sidebar.addEventListener("drop", event => {
        const dragged = event.dataTransfer?.getData("application/x-xzg-media-folder");
        if (!dragged || folderInsertIndex == null) return;
        event.preventDefault();
        event.stopPropagation();
        const targetIndex = folderInsertIndex;
        clearInsertMarker();
        folderInsertIndex = null;
        const from = folders.indexOf(dragged);
        if (from < 0) return;
        const to = from < targetIndex ? targetIndex - 1 : targetIndex;
        if (to === from) return;
        const next = [...folders];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        folders = next;
        renderSidebar();
        request("/folder-order", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ names: folders }) })
            .catch(error => alertUser(error.message));
    });
    sidebar.addEventListener("dragend", () => {
        clearInsertMarker();
        folderInsertIndex = null;
    });
    const refresh = async () => {
        const q = currentFolder ? `?folder=${encodeURIComponent(currentFolder)}` : "";
        const result = await request(q);
        folders = result.folders || [];
        items = result.items || [];
        lastClickedIndex = -1;
        renderSidebar();
        render();
    };
    search.oninput = render;
    input.onchange = async () => {
        upload.disabled = true;
        try {
            for (const file of input.files || []) {
                const body = new FormData();
                body.append("file", file);
                if (currentFolder && currentFolder !== ALL_FOLDER) body.append("folder", currentFolder);
                await request("/upload", { method: "POST", body });
            }
            await refresh();
        } catch (error) { alertUser(error.message); }
        finally { input.value = ""; upload.disabled = false; }
    };
    cloudLoad(geometryKey, { fallbackValue: null }).then(saved => {
        if (!overlay.isConnected || geometryChanged || !saved) return;
        if (Number.isFinite(saved.width)) dialog.style.width = `${Math.max(560, Math.min(window.innerWidth - 40, saved.width))}px`;
        if (Number.isFinite(saved.height)) dialog.style.height = `${Math.max(360, Math.min(window.innerHeight - 40, saved.height))}px`;
        if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
            dialog.style.transform = "none";
            dialog.style.left = `${Math.max(0, Math.min(window.innerWidth - dialog.offsetWidth, saved.x))}px`;
            dialog.style.top = `${Math.max(0, Math.min(window.innerHeight - dialog.offsetHeight, saved.y))}px`;
        }
    });
    refresh().catch(error => alertUser(error.message));
}

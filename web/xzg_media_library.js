import { api } from "../../scripts/api.js";
import { xzgT } from "./xzg_i18n.js";
import { cloudLoad, cloudSave } from "./xzg_cloud_store.js";

const endpoint = "/xzg/media-library";
const geometryKey = "xzg_media_library_geometry";
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

async function mediaRequest(path = "", options = {}) {
    const response = await api.fetchApi(endpoint + path, options);
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

export function showMediaLibrary({ addImages, alertUser, confirmUser }) {
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
        fetch(api.apiURL(`${endpoint}/thumb?name=${encodeURIComponent(name)}&v=${thumbnailCacheEpoch}`))
            .then(r => (r.ok ? r.blob() : null))
            .then(blob => { if (blob) putCachedBlob(name, blob); })
            .catch(() => {});
    };
    const overlay = document.createElement("div");
    overlay.dataset.xzgMediaLibrary = "1";
    overlay.style.cssText = "position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;";
    const dialog = document.createElement("div");
    dialog.tabIndex = -1;
    dialog.style.cssText = "position:relative;width:1200px;height:800px;display:flex;flex-direction:column;background:var(--comfy-menu-bg);color:var(--input-text);border:1px solid var(--border-color);border-radius:8px;overflow:hidden;";
    dialog.addEventListener("click", event => event.stopPropagation());

    const header = document.createElement("div");
    header.style.cssText = "display:flex;gap:10px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--border-color);";
    const title = document.createElement("strong");
    title.textContent = xzgT("资源媒体库 · 图片", "Media library · Images");
    title.style.cssText = "font-size:15px;flex:1;";
    const search = document.createElement("input");
    search.placeholder = xzgT("搜索图片…", "Search images…");
    search.style.cssText = "width:180px;padding:6px;background:var(--comfy-input-bg);color:var(--input-text);border:1px solid var(--border-color);border-radius:4px;";
    const closeLibrary = () => {
        closeContextMenu();
        window.removeEventListener("keydown", onLibraryKeyDown, true);
        window.removeEventListener("keyup", onLibraryKeyUp, true);
        window.removeEventListener("keydown", onShiftKeyDown, true);
        window.removeEventListener("keyup", onShiftKeyUp, true);
        window.removeEventListener("blur", onShiftKeyUp);
        releaseThumbnailUrls();
        overlay.remove();
    };
    header.append(title, search);

    const grid = document.createElement("div");
    grid.style.cssText = "flex:1;overflow:auto;padding:0;display:block;user-select:none;scrollbarGutter:stable;";
const virtualStage = document.createElement("div");
virtualStage.style.cssText = "position:relative;width:100%;";
grid.appendChild(virtualStage);
let lastWindowKey = "";
    const footer = document.createElement("div");
    footer.style.cssText = "display:flex;align-items:center;gap:8px;padding:10px 36px 10px 16px;border-top:1px solid var(--border-color);";
    const makeButton = (label, action) => {
        const button = document.createElement("button");
        button.textContent = label;
        button.style.cssText = "padding:6px 12px;background:var(--comfy-menu-bg);color:var(--input-text);border:1px solid var(--border-color);border-radius:4px;cursor:pointer;font-size:12px;";
        button.onclick = action;
        return button;
    };
    const count = document.createElement("span");
    count.style.cssText = "font-size:12px;opacity:.8;flex:1;";
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp,image/gif,image/bmp,image/tiff";
    input.multiple = true;
    input.hidden = true;
    const upload = makeButton(xzgT("上传图片", "Upload images"), () => input.click());
    const doDelete = (names) => {
        if (!names.length) return;
        confirmUser(xzgT(`确定删除选中的 ${names.length} 张媒体库图片？`, `Delete ${names.length} selected library images?`), async () => {
            try {
                await mediaRequest("", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ names }) });
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
        loading = true;
        add.disabled = true;
        try {
            const result = await mediaRequest("/to-input", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ names }) });
            addImages(result.names || []);
            closeLibrary();
        } catch (error) { alertUser(error.message); }
        finally { loading = false; add.disabled = false; }
    };
    const add = makeButton(xzgT("载入", "Load"), () => loadImages(items.filter(item => selected.has(item.name)).map(item => item.name)));
    add.style.cssText = "padding:6px 16px;background:#FFD700;color:#333;border:none;border-radius:4px;cursor:pointer;font-size:12px;font-weight:bold;";
    const cancel = document.createElement("button");
    cancel.textContent = xzgT("取消", "Cancel");
    cancel.style.cssText = "padding:6px 16px;background:var(--comfy-menu-bg);color:var(--input-text);border:1px solid var(--border-color);border-radius:4px;cursor:pointer;font-size:12px;";
    cancel.onclick = closeLibrary;
    footer.append(upload, selectAll, clearSelect, remove, count, cancel, add, input);
    dialog.append(header, grid, footer);
    overlay.appendChild(dialog);
    // 防重复：同一时刻只保留一个媒体库实例，避免多个弹窗持有独立选中集合导致 Delete 状态错乱
    document.querySelectorAll('[data-xzg-media-library="1"]').forEach(el => el.remove());
    document.body.appendChild(overlay);
    // 抢占键盘焦点到弹窗内，避免 ComfyUI 全局快捷键把 Delete 当成"删除节点"等操作拦截掉
    dialog.focus();

    let items = [];
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
            getComputedStyle(child).position === "fixed" && Number(getComputedStyle(child).zIndex) > 99999 && child.isConnected)) return false;
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
            alertUser(xzgT("请先选中要删除的图片（单击图片卡片使其高亮）", "Select an image first (click a card to highlight it)."));
        }
        return true;
    };
    const onLibraryKeyDown = event => {
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
            getComputedStyle(child).position === "fixed" && Number(getComputedStyle(child).zIndex) > 99999 && child.contains(node));
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
        count.textContent = xzgT(`${items.length} 张图片 · 已选 ${selected.size} 张`, `${items.length} images · ${selected.size} selected`);
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
        const dot = oldName.lastIndexOf(".");
        const stem = oldName.slice(0, dot);
        const extension = oldName.slice(dot);
        const renameOverlay = document.createElement("div");
        renameOverlay.dataset.xzgHigher = "1";
        renameOverlay.style.cssText = "position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;";
        const panel = document.createElement("div");
        panel.style.cssText = "width:min(420px,90vw);padding:18px;background:var(--comfy-menu-bg);color:var(--input-text);border:1px solid var(--border-color);border-radius:8px;box-sizing:border-box;";
        const heading = document.createElement("div");
        heading.textContent = xzgT("重命名媒体库图片", "Rename library image");
        heading.style.cssText = "font-size:15px;font-weight:bold;margin-bottom:12px;";
        const row = document.createElement("div");
        row.style.cssText = "display:flex;align-items:center;gap:5px;";
        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.value = stem;
        nameInput.style.cssText = "flex:1;min-width:0;padding:7px;background:var(--comfy-input-bg);color:var(--input-text);border:1px solid var(--border-color);border-radius:4px;";
        const suffix = document.createElement("span");
        suffix.textContent = extension;
        suffix.style.cssText = "font-size:12px;opacity:.75;";
        row.append(nameInput, suffix);
        const actions = document.createElement("div");
        actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:16px;";
        const cancel = makeButton(xzgT("取消", "Cancel"), () => renameOverlay.remove());
        const save = makeButton(xzgT("保存", "Save"), async () => {
            const newName = nameInput.value.trim() + extension;
            if (!nameInput.value.trim()) {
                alertUser(xzgT("图片名称不能为空", "Image name cannot be empty"));
                return;
            }
            if (newName === oldName) { renameOverlay.remove(); return; }
            save.disabled = true;
            try {
                const result = await mediaRequest("/rename", {
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
        contextMenu = menu;
        menu.style.cssText = "position:fixed;z-index:100000;min-width:130px;padding:4px;background:var(--comfy-menu-bg);color:var(--input-text);border:1px solid var(--border-color);border-radius:5px;box-shadow:0 6px 18px rgba(0,0,0,.35);";
        const rename = makeButton(xzgT("重命名", "Rename"), () => {
            closeContextMenu();
            showRenameDialog(name);
        });
        rename.style.cssText = "display:block;width:100%;padding:7px 10px;text-align:left;border:0;background:transparent;color:var(--input-text);cursor:pointer;";
        menu.appendChild(rename);
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
        card.title = `${item.name}\n${xzgT("拖动图片调序；双击加入加载器", "Drag image to reorder; double-click to add to loader")}`;
        card.style.cssText = `position:absolute;box-sizing:border-box;border:1px solid ${selected.has(item.name) ? "#ffd700" : "var(--border-color)"};box-shadow:${selected.has(item.name) ? "inset 0 0 0 1px #ffd700" : "none"};border-radius:5px;background:var(--comfy-input-bg);color:var(--input-text);cursor:pointer;overflow:hidden;display:flex;flex-direction:column;`;
        card.dataset.xzgSelected = selected.has(item.name) ? "1" : "0";
        const imageBox = document.createElement("div");
        imageBox.className = "xzg-media-image";
        imageBox.style.cssText = "position:relative;width:100%;aspect-ratio:1;padding:4px;box-sizing:border-box;background:#000;";
        const number = document.createElement("span");
        number.textContent = String(items.indexOf(item) + 1);
        number.title = xzgT("媒体库顺序", "Library order");
        number.style.cssText = "position:absolute;top:3px;left:3px;z-index:1;min-width:16px;padding:2px 4px;border-radius:3px;background:rgba(0,0,0,.72);color:#fff;font-size:11px;line-height:1.2;pointer-events:none;";
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
        label.style.cssText = "flex:0 0 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:3px 4px;color:var(--input-text);font-size:11px;text-align:center;pointer-events:none;";
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
            image.src = api.apiURL(`${endpoint}/thumb?name=${encodeURIComponent(item.name)}&v=${thumbnailCacheEpoch}`);
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
            empty.textContent = items.length ? xzgT("没有匹配的图片", "No matching images") : xzgT("媒体库为空，点击“上传图片”添加", "Library is empty. Upload images to get started.");
            empty.style.cssText = "position:absolute;top:80px;left:0;right:0;text-align:center;opacity:.7;";
            virtualStage.appendChild(empty);
            return;
        }
        const cols = Math.min(8, Math.max(4, visible.length));
        const gap = 2;
        const inset = 8;
        const cellWidth = Math.max(1, (grid.clientWidth - inset * 2 - gap * (cols - 1)) / cols);
        const labelHeight = 20;
        const cardHeight = cellWidth + labelHeight;
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
                imageBoxEl.style.width = cellWidth + "px";
                imageBoxEl.style.height = cellWidth + "px";
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
            await mediaRequest("/order", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ names: items.map(item => item.name) }),
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
        marquee.style.cssText = "position:fixed;border:1px solid #ffd700;background:transparent;pointer-events:none;z-index:100000;display:none;";
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
    const refresh = async () => {
        const result = await mediaRequest();
        items = result.items || [];
        lastClickedIndex = -1;
        render();
    };
    search.oninput = render;
    input.onchange = async () => {
        upload.disabled = true;
        try {
            for (const file of input.files || []) {
                const body = new FormData();
                body.append("file", file);
                await mediaRequest("/upload", { method: "POST", body });
            }
            await refresh();
        } catch (error) { alertUser(error.message); }
        finally { input.value = ""; upload.disabled = false; }
    };
    refresh().catch(error => alertUser(error.message));
}

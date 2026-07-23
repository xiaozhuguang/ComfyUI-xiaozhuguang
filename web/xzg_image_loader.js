import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { xzgT } from "./xzg_i18n.js";

// ═══════════════════════════════════════════════
//  小珠光图片加载器 · 前端
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
// 完全复刻小珠光预览的自适应算法
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
            <button class="xzg-cancel-btn" style="padding:6px 16px;background:var(--comfy-input-bg);color:var(--input-text);border:1px solid var(--border-color);border-radius:4px;cursor:pointer;font-size:12px;">取消</button>
            <button class="xzg-ok-btn" style="padding:6px 16px;background:#FFD700;color:#333;border:none;border-radius:4px;cursor:pointer;font-size:12px;">确定</button>
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
            <button class="xzg-ok-btn" style="padding:6px 16px;background:#FFD700;color:#333;border:none;border-radius:4px;cursor:pointer;font-size:12px;">确定</button>
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

function createImgBatchUI(node) {
    const container = document.createElement("div");
    container.style.cssText =
        "width:100%;min-width:0;min-height:200px;box-sizing:border-box;overflow:hidden;padding:6px;background:var(--comfy-menu-bg);border:1px solid var(--border-color);border-radius:4px;margin:4px 0;display:flex;flex-direction:row;gap:6px;z-index:10;";
    container.style.userSelect = "none";
    container.style.webkitUserSelect = "none";
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
        saveItem.textContent = multi ? `保存选中图片 (${selectedNames.length}张)` : "保存图片";
        saveItem.style.cssText = "padding:6px 14px;cursor:pointer;white-space:nowrap;";
        saveItem.addEventListener("mouseenter", () => { saveItem.style.background = "var(--comfy-input-bg)"; });
        saveItem.addEventListener("mouseleave", () => { saveItem.style.background = ""; });
        saveItem.addEventListener("click", () => {
            targetNames.forEach((n, i) => {
                setTimeout(() => {
                    const a = document.createElement("a");
                    a.href = getOriginalImageUrl(n);
                    a.download = n;
                    a.click();
                }, i * 150);
            });
            hideContextMenu();
        });
        contextMenu.appendChild(saveItem);

        const copyItem = document.createElement("div");
        copyItem.textContent = multi ? `复制选中图片 (${selectedNames.length}张)` : "复制图片";
        copyItem.style.cssText = "padding:6px 14px;cursor:pointer;white-space:nowrap;";
        copyItem.addEventListener("mouseenter", () => { copyItem.style.background = "var(--comfy-input-bg)"; });
        copyItem.addEventListener("mouseleave", () => { copyItem.style.background = ""; });
        copyItem.addEventListener("click", async () => {
            try {
                const blobs = [];
                for (const n of targetNames) {
                    const res = await fetch(getOriginalImageUrl(n));
                    const blob = await res.blob();
                    blobs.push(blob);
                }
                if (blobs.length === 1) {
                    await navigator.clipboard.write([
                        new ClipboardItem({ [blobs[0].type]: blobs[0] })
                    ]);
                } else {
                    console.warn("[小珠光] 多选图片复制到剪贴板暂不支持，请使用保存功能");
                }
            } catch (err) {
                console.warn("[小珠光] 复制图片失败:", err);
            }
            hideContextMenu();
        });
        contextMenu.appendChild(copyItem);

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

    let uploadMode = "append";

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
        // 切换到单图模式时，只保留第一张图片
        if (wasAppend && uploadMode === "replace") {
            const names = parseNameList(getImageListWidget(node)?.value);
            if (names.length > 1) {
                setNameList(node, [names[0]]);
                setIndex(node, 0);
            }
        }
        updateUploadModeBtn();
        redraw(true);
    });

    const updateUploadModeBtn = () => {
        uploadModeBtn.textContent = uploadMode === "append" ? "多图" : "单图";
        uploadModeBtn.title = uploadMode === "append" ? "批量加载图片模式" : "单图加载模式";
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
        
        modeBtn.textContent = isBatch ? "批次" : "列表";
        if (disabled) {
            modeBtn.title = isSingleMode ? "单图加载模式下不可用" : "";
            modeBtn.style.borderColor = "#666";
            modeBtn.style.borderWidth = "1px";
            modeBtn.style.borderStyle = "solid";
            modeBtn.style.cursor = "default";
            modeBtn.style.opacity = "0.4";
        } else {
            modeBtn.title = isBatch ? "切换为列表模式" : "切换为批次模式";
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
    let viewMode = "grid";

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
        "flex:1;display:flex;align-items:center;justify-content:center;background:transparent;border-radius:4px;color:var(--input-text);font-size:10px;opacity:0.55;min-height:40px;";
    emptyTip.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:5px;width:100%;max-width:280px;font-size:10px;color:var(--input-text);line-height:1.35;">
            <div style="text-align:center;font-size:11px;font-weight:bold;margin-bottom:1px;opacity:0.85;">小珠光图片加载器</div>

            <div style="display:flex;flex-direction:column;gap:1px;">
                <div style="font-weight:bold;opacity:0.75;">📁 添加图片</div>
                <div style="opacity:0.5;padding-left:12px;">双击空白处 / 点击上传按钮</div>
                <div style="opacity:0.5;padding-left:12px;">.input 从输入文件夹选择</div>
                <div style="opacity:0.5;padding-left:12px;">.output 从输出文件夹选择</div>
            </div>

            <div style="display:flex;flex-direction:column;gap:1px;">
                <div style="font-weight:bold;opacity:0.75;">🖱️ 鼠标操作</div>
                <div style="opacity:0.5;padding-left:12px;">左键点击：选中 / Ctrl多选 / Shift范围选</div>
                <div style="opacity:0.5;padding-left:12px;">左键拖动卡片：调整顺序</div>
                <div style="opacity:0.5;padding-left:12px;">空白处拖动：框选多个图片</div>
                <div style="opacity:0.5;padding-left:12px;">悬停卡片右上角：删除单张</div>
            </div>

            <div style="display:flex;flex-direction:column;gap:1px;">
                <div style="font-weight:bold;opacity:0.75;">🔄 模式切换</div>
                <div style="opacity:0.5;padding-left:12px;">多图/单图：批量加载图片模式 / 单图加载模式</div>
                <div style="opacity:0.5;padding-left:12px;">批次模式：统一分辨率，批量处理</div>
                <div style="opacity:0.5;padding-left:12px;">列表模式：支持不同分辨率，逐张处理</div>
            </div>

            <div style="display:flex;flex-direction:column;gap:1px;">
                <div style="font-weight:bold;opacity:0.75;">💡 提示</div>
                <div style="opacity:0.5;padding-left:12px;">缩略图大小根据节点大小自动调整</div>
                <div style="opacity:0.5;padding-left:12px;">拖动节点边缘可改变节点大小</div>
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
    singleImgContainer.style.cssText = "flex:1;display:none;align-items:center;justify-content:center;min-width:0;min-height:100px;overflow:hidden;position:relative;width:100%;";
    const singleImgEl = document.createElement("img");
    singleImgEl.style.cssText = "width:100%;height:100%;object-fit:contain;display:block;background:rgba(128,128,128,0.4);";
    singleImgEl.draggable = false;
    singleImgEl.onerror = () => {
        const names = parseNameList(getImageListWidget(node)?.value);
        if (names.length === 1) {
            const next = names.slice(1);
            setNameList(node, next);
            setIndex(node, 0);
        }
    };
    singleImgContainer.appendChild(singleImgEl);
    mainContent.insertBefore(singleImgContainer, emptyTip);



    singleImgContainer.addEventListener("dblclick", (e) => {
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

    const onWheel = (e) => {
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

        // 按下时立即金边高亮（无过渡，瞬间生效）
        if (cell && cardInner) {
            cardInner.style.transition = "none";
            cardInner.style.borderColor = getSelColor();
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
                gCard.style.borderColor = getSelColor();
                gCard.style.width = "100%";
                gCard.style.height = "100%";
                gCard.style.boxSizing = "border-box";
                gCard.style.transform = `scale(${DRAG_SORT_SCALE})`;
                gCard.style.transformOrigin = "center center";
                gCard.style.boxShadow = "0 4px 16px rgba(0,0,0,0.4)";
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
            const curIdx = idx >= 0 && idx < names.length ? idx : 0;
            const name = names[curIdx];
            // 单图/1图模式使用压缩预览（最长边 3840px），避免大图卡顿
            if (singleImgEl.dataset.previewKey !== name) {
                singleImgEl.dataset.previewKey = name;
                singleImgEl.dataset.currentName = name;
                singleImgEl.src = getPreviewUrl(name);
            }
            if (selectedIndexes.length !== 1 || selectedIndexes[0] !== curIdx) {
                selectedIndexes = [curIdx];
            }
            lastClickedIndex = curIdx;
            lastNames = [...names];
            lastCardSize = cardSize;
            return;
        }

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

            const delBtn = document.createElement("div");
            delBtn.className = "del-btn";
            delBtn.textContent = "×";
            delBtn.style.cssText =
                "position:absolute;top:2px;right:2px;width:18px;height:18px;display:flex;align-items:center;justify-content:center;font-size:14px;line-height:1;background:rgba(0,0,0,0.7);color:#fff;border-radius:50%;cursor:pointer;z-index:3;opacity:0;";
            delBtn.title = "删除";
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
                    <div style="font-weight:bold;font-size:14px;color:var(--input-text);">从 ${title} 文件夹选择</div>
                    <input type="text" class="search-input" placeholder="搜索..." style="padding:4px 8px;background:var(--comfy-input-bg);color:var(--input-text);border:1px solid var(--border-color);border-radius:4px;font-size:12px;width:180px;outline:none;">
                </div>
                <div class="xzg-folder-grid xzg-img-grid" style="flex:1;width:100%;box-sizing:border-box;overflow-y:auto;padding:8px;min-height:360px;"></div>
                <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-top:1px solid var(--border-color);background:var(--comfy-input-bg);">
                    <div style="display:flex;gap:8px;align-items:center;">
                        <span style="font-size:12px;color:var(--input-text);">已选: <span class="selected-count">${selectedSet.size}</span></span>
                        <button class="select-all-btn" style="padding:4px 10px;background:var(--comfy-menu-bg);color:var(--input-text);border:1px solid var(--border-color);border-radius:4px;cursor:pointer;font-size:12px;">全选</button>
                        <button class="clear-select-btn" style="padding:4px 10px;background:var(--comfy-menu-bg);color:var(--input-text);border:1px solid var(--border-color);border-radius:4px;cursor:pointer;font-size:12px;">取消全选</button>
                        <button class="del-selected-btn" style="padding:4px 10px;background:#c0392b;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;">删除选中</button>
                    </div>
                    <div style="display:flex;gap:8px;">
                        <button class="cancel-btn" style="padding:6px 16px;background:var(--comfy-menu-bg);color:var(--input-text);border:1px solid var(--border-color);border-radius:4px;cursor:pointer;font-size:12px;">取消</button>
                        <button class="ok-btn" style="padding:6px 16px;background:#FFD700;color:#333;border:none;border-radius:4px;cursor:pointer;font-size:12px;">载入</button>
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
            let msg = "加载文件列表失败";
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

    return {
        container,
        redraw,
        updateModeBtn,
        resizeObserver,
        _updateLabelScale: updateLabelScale,
        _onWheel: onWheel,
    };
}

app.registerExtension({
    name: "xiaozhuguang.image_loader",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "XiaozhuguangImageLoader") {
            const origOnNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
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

                if (wIndex) {
                    const origCallback = wIndex.callback;
                    wIndex._xzg_lastValue = wIndex.value;
                    wIndex.callback = function (value) {
                        origCallback?.call(this, value);
                        if (value === wIndex._xzg_lastValue) return;
                        wIndex._xzg_lastValue = value;
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

            const origOnConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function (data) {
                const r = origOnConfigure?.apply(this, arguments);
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
                if (this._xzgImgLoaderUI) {
                    this._xzgImgLoaderUI.redraw(true);
                    this._xzgImgLoaderUI.updateModeBtn?.();
                }
                return r;
            };

            const origOnSerialize = nodeType.prototype.onSerialize;
            nodeType.prototype.onSerialize = function (data) {
                const r = origOnSerialize?.apply(this, arguments);
                const listWidget = getImageListWidget(this);
                if (listWidget && listWidget.value) {
                    if (!data.properties) data.properties = {};
                    data.properties.xzg_image_list = listWidget.value;
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

            // 画布缩放时同步更新图片名称字体大小
            const origOnDrawBackground = nodeType.prototype.onDrawBackground;
            nodeType.prototype.onDrawBackground = function (ctx) {
                if (this._xzgImgLoaderUI?._updateLabelScale) {
                    this._xzgImgLoaderUI._updateLabelScale();
                }
                return origOnDrawBackground?.apply(this, arguments);
            };

            // 节点大小改变时重新计算缩略图（与 ResizeObserver 协调）
            const origOnResize = nodeType.prototype.onResize;
            nodeType.prototype.onResize = function (size) {
                const r = origOnResize?.apply(this, arguments);
                // ResizeObserver 会处理重绘，这里不需要额外操作
                return r;
            };
        }
    },
});

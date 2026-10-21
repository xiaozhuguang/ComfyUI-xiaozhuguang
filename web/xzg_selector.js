import { app } from "../../scripts/app.js";

// ═══════════════════════════════════════════════
//  小珠光选择器 · DOM 控件版
//  缩放任意大小都始终清晰
// ═══════════════════════════════════════════════

(function () {
    const ID = "xzg-selector-css";
    if (document.getElementById(ID)) return;
    const s = document.createElement("style");
    s.id = ID;
    s.textContent = ``;
    document.head.appendChild(s);
})();

const clamp = (v, mn, mx) => Math.max(mn, Math.min(mx, v));

// 字号是纯比例：fontScale（百分比）= 文字高度 / 标签高度。
// 绘制时 fontPx = 标签实际高度 × fontScale%，所以拖动缩放节点时比例恒定不变。
const DEFAULT_FONT_SCALE = 50;
const LEGACY_FONT_BASE = 30; // 旧 fontSize 字段的基准标签高度
const normalizeFontScale = (v) => clamp(Math.round(Number(v) || DEFAULT_FONT_SCALE), 20, 90);

function drawLinearGradient(ctx, x, y, w, h, direction, colors) {
    let x0 = x, y0 = y, x1 = x + w, y1 = y + h;
    if (direction === "90deg") { x1 = x + w; y1 = y; }
    else if (direction === "180deg") { x1 = x; y1 = y + h; }
    else if (direction === "270deg") { x0 = x + w; y0 = y; x1 = x; y1 = y + h; }
    else if (direction === "0deg") { x0 = x; y0 = y + h; x1 = x; y1 = y; }
    const grad = ctx.createLinearGradient(x0, y0, x1, y1);
    grad.addColorStop(0, colors.color1);
    grad.addColorStop(0.5, colors.color2);
    grad.addColorStop(1, colors.color3);
    return grad;
}

function drawRadialGradient(ctx, x, y, w, h, colors) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const r = Math.max(w, h) / 2;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, colors.color1);
    grad.addColorStop(0.5, colors.color2);
    grad.addColorStop(1, colors.color3);
    return grad;
}

function getNodeSettings(node, defaults) {
    const sw = node.widgets?.find(w => w.name === "_xz_settings");
    let parsed = {};
    if (sw && sw.value) {
        try { parsed = JSON.parse(sw.value); } catch (e) {}
    }
    const s = { ...defaults, ...parsed };
    const max = Math.max(1, s.count);
    s.columns = Math.max(1, Math.min(s.columns, max));
    s.btnWidth = clamp(s.btnWidth, 30, 300);
    s.btnHeight = clamp(s.btnHeight, 30, 80);
    // fontScale 是纯比例（百分比）：文字高度 / 标签高度，拖动缩放时保持不变。
    // 兼容旧字段：fontSize（标签高 30px 时的字号）与 fontBias（-100~100）。
    if (parsed.fontScale === undefined) {
        let legacyPx;
        if (parsed.fontSize !== undefined) {
            legacyPx = Number(parsed.fontSize) || 15;
        } else if (parsed.fontBias !== undefined) {
            legacyPx = (LEGACY_FONT_BASE / 2) * (1 + (Number(parsed.fontBias) || 0) / 100);
        } else {
            legacyPx = (DEFAULT_FONT_SCALE / 100) * LEGACY_FONT_BASE;
        }
        s.fontScale = Math.round(legacyPx / LEGACY_FONT_BASE * 100);
    }
    s.fontScale = normalizeFontScale(s.fontScale);
    // gapBias 0-100 线性映射到间距 0-40px（bias=0→0px，bias=50→20px，bias=100→40px）
    if (s.gapBias === undefined && s.btnGap !== undefined) {
        s.gapBias = clamp(Math.round(s.btnGap / 40 * 100), 0, 100);
    }
    s.gapBias = clamp(s.gapBias ?? 10, 0, 100);
    s.btnGap = s.gapBias * 0.4;
    if (!s.widths || typeof s.widths !== "object") {
        s.widths = {};
    }
    if (!s.rowBias || typeof s.rowBias !== "object") {
        s.rowBias = {};
    }
    return s;
}

function setNodeSettings(node, settings) {
    const sw = node.widgets?.find(w => w.name === "_xz_settings");
    if (sw) sw.value = JSON.stringify(settings);
}

function getDisplayLabel(value, labels) {
    if (labels[value] && labels[value].trim()) return labels[value];
    return value;
}

function getButtonWidth(index, settings) {
    const key = String(index);
    const bias = (settings.widths && settings.widths[key] !== undefined)
        ? settings.widths[key] : 0;
    // bias: -100~100, 正值变宽，负值变窄，0为等宽
    const weight = 1 + bias / 100;
    return Math.max(20, (settings.btnWidth || 60) * weight);
}

/**
 * 计算按钮布局矩形。
 * 当节点宽度不足以容纳所有按钮时，等比缩小按钮宽度以避免溢出；
 * 当节点宽度有空余时，等比放大按钮宽度以填满空间，避免留白。
 * 当节点高度高于自然内容高度时，等比放大按钮高度以填满垂直空间。
 * 按钮之间的比例关系（由 settings.widths 或 settings.btnWidth 决定）保持不变。
 * @param {number} y - 控件顶部 y 坐标
 * @param {number} W - 节点宽度
 * @param {object} settings - 节点设置
 * @param {number} [availableH] - 可用高度（可选），大于自然高度时缩放按钮高度
 */
function getButtonRects(y, W, settings, availableH) {
    const count = settings.count;
    const cols = settings.columns;
    const gap = settings.btnGap;
    const btnH = settings.btnHeight;
    const rows = Math.ceil(count / cols);
    const rects = [];
    const startY = y + 4;
    const availableW = Math.max(0, W - 12); // 左右各 6px 边距

    // 计算自然内容高度，并根据可用高度缩放按钮高度
    const naturalContentH = rows > 0 ? rows * btnH + (rows - 1) * gap : 0;
    let scaledBtnH = btnH;
    let contentH = naturalContentH;
    if (availableH !== undefined && rows > 0) {
        if (availableH > naturalContentH) {
            // 放大按钮填满空间
            const extraSpace = availableH - naturalContentH;
            scaledBtnH = btnH + extraSpace / rows;
            contentH = availableH;
        } else if (availableH < naturalContentH) {
            // 缩小按钮避免溢出
            const totalGap = (rows - 1) * gap;
            scaledBtnH = Math.max(10, (availableH - totalGap) / rows);
            contentH = availableH;
        }
    }

    for (let r = 0; r < rows; r++) {
        const rowStartIdx = r * cols;
        const rowEndIdx = Math.min(rowStartIdx + cols, count);
        const rowCount = rowEndIdx - rowStartIdx;

        // 计算该行自然宽度（各按钮原始宽度之和 + 间距）
        let naturalWidths = [];
        let naturalRowWidth = 0;
        for (let i = rowStartIdx; i < rowEndIdx; i++) {
            const bw = getButtonWidth(i, settings);
            naturalWidths[i] = bw;
            naturalRowWidth += bw;
        }
        naturalRowWidth += (rowCount - 1) * gap;

        // 按钮宽度：节点宽度足够时等比放大填满；不足时等比压缩按钮以适配宽度，避免标签溢出边界
        let scaledWidths = [];
        let rowWidth;
        if (naturalRowWidth > 0 && rowCount > 0) {
            const totalGap = (rowCount - 1) * gap;
            const naturalContentW = naturalRowWidth - totalGap;
            const availableContentW = Math.max(0, availableW - totalGap);
            if (availableContentW >= naturalContentW) {
                // 节点够宽：放大按钮填满
                const scale = naturalContentW > 0 ? availableContentW / naturalContentW : 1;
                for (let i = rowStartIdx; i < rowEndIdx; i++) {
                    scaledWidths[i] = naturalWidths[i] * scale;
                }
                rowWidth = availableW;
            } else {
                // 节点不够宽：等比压缩按钮，使其适配 availableW，标签自动回到边界内
                const scale = naturalContentW > 0 ? availableContentW / naturalContentW : 1;
                for (let i = rowStartIdx; i < rowEndIdx; i++) {
                    scaledWidths[i] = Math.max(20, naturalWidths[i] * scale);
                }
                // 用实际缩放后的宽度重算行宽，避免最小值钳制导致二次溢出
                rowWidth = totalGap;
                for (let i = rowStartIdx; i < rowEndIdx; i++) {
                    rowWidth += scaledWidths[i];
                }
            }
        } else {
            for (let i = rowStartIdx; i < rowEndIdx; i++) {
                scaledWidths[i] = naturalWidths[i];
            }
            rowWidth = naturalRowWidth;
        }

        const rowStartX = Math.max(6, (W - rowWidth) / 2);
        let curX = rowStartX;
        for (let i = rowStartIdx; i < rowEndIdx; i++) {
            const w = scaledWidths[i];
            rects[i] = {
                x: curX,
                y: startY + r * (scaledBtnH + gap),
                w: w,
                h: scaledBtnH,
            };
            curX += w + gap;
        }
    }

    const contentW = availableW;
    // 字体随按钮高度等比缩放：scaledBtnH / btnH
    const heightScale = btnH > 0 ? scaledBtnH / btnH : 1;
    return { rects, contentW, contentH, heightScale };
}

/**
 * 计算自然内容尺寸（不缩放，用于初始节点大小设置）。
 */
function calcNaturalContentSize(settings) {
    const count = settings.count;
    const cols = settings.columns;
    const gap = settings.btnGap;
    const btnH = settings.btnHeight;
    const rows = Math.ceil(count / cols);
    let maxRowWidth = 0;
    for (let r = 0; r < rows; r++) {
        const rowStartIdx = r * cols;
        const rowEndIdx = Math.min(rowStartIdx + cols, count);
        const rowCount = rowEndIdx - rowStartIdx;
        let rowWidth = 0;
        for (let i = rowStartIdx; i < rowEndIdx; i++) {
            rowWidth += getButtonWidth(i, settings);
        }
        rowWidth += (rowCount - 1) * gap;
        maxRowWidth = Math.max(maxRowWidth, rowWidth);
    }
    const contentH = rows * btnH + (rows - 1) * gap;
    return { contentW: maxRowWidth, contentH };
}


function getSelectorMinContentHeight(node) {
    const settings = getNodeSettings(node, DEFAULT_SETTINGS);
    const rows = Math.ceil(settings.count / settings.columns);
    // Font size is fitted inside each button by paint(); changing it must not
    // change the node's minimum height or undo a user's compact layout.
    return rows * 12 + Math.max(0, rows - 1) * settings.btnGap + 8;
}

// 是否处于 Nodes 2.0：优先用全局标志（加载早期也稳定），
// 不能用 DOM 探测做唯一依据——加载时 DOM 还没挂载，判定会来回翻转，导致刷新后尺寸跳动。
function isVueNodesMode(node) {
    const flag = globalThis.LiteGraph?.vueNodesMode;
    if (typeof flag === "boolean") return flag;
    return !!node?._xzgSelectorUI?.canvas?.closest?.(".lg-node");
}

function getSelectorMinNodeHeight(node) {
    // Nodes 2.0 需要为标题、插槽和底部角标预留空间，否则压缩后按钮会被挤没。
    const reserve = isVueNodesMode(node) ? 64 : 32;
    return Math.max(58, getSelectorMinContentHeight(node) + reserve);
}

// 尺寸持久化：拖拽结束后把尺寸写进 node.properties（properties 一定会写进工作流），
// 这样即使前端没有把 node.size 写回存档，刷新后也不会丢大小。
const SIZE_HINT_KEY = "_xzgSize";
function writeNodeSizeHint(node, w, h) {
    if (!node || !Number.isFinite(w) || !Number.isFinite(h)) return;
    node.properties = node.properties || {};
    const prev = node.properties[SIZE_HINT_KEY];
    if (Array.isArray(prev) && Math.abs(prev[0] - w) < 0.5 && Math.abs(prev[1] - h) < 0.5) return;
    node.properties[SIZE_HINT_KEY] = [Math.round(w), Math.round(h)];
}
function readNodeSizeHint(node) {
    const v = node?.properties?.[SIZE_HINT_KEY];
    if (!Array.isArray(v) || v.length < 2) return null;
    const w = Number(v[0]);
    const h = Number(v[1]);
    return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? [w, h] : null;
}
function applyNodeSizeHint(node) {
    const hint = readNodeSizeHint(node);
    if (!hint || !node?.size) return false;
    const nextW = Math.max(hint[0], getSelectorMinNodeWidth(node));
    const nextH = Math.max(hint[1], getSelectorMinNodeHeight(node));
    if (Math.abs(node.size[0] - nextW) > 0.5 || Math.abs(node.size[1] - nextH) > 0.5) {
        node.size[0] = nextW;
        node.size[1] = nextH;
        node.setDirtyCanvas?.(true, true);
    }
    node._xzgSelectorUI?.refresh?.();
    return true;
}

function getSelectorMinNodeWidth(node) {
    const settings = getNodeSettings(node, DEFAULT_SETTINGS);
    const { contentW } = calcNaturalContentSize(settings);
    // 与布尔选择器完全一致：最小宽度 = 标签自然宽度 + 左右边距（下限 120，上限 420）。
    // 再宽的部分由按钮等比压缩吸收，保证标签不会被节点边界裁掉。
    return Math.min(420, Math.max(120, Math.round(contentW + 12)));
}

function createSelectorDOMWidget(node, tagWidget) {
    const root = document.createElement("div");
    root.style.cssText = "width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;contain:size layout;pointer-events:none;position:relative;";
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "position:absolute;inset:0;display:block;min-width:0;min-height:0;width:100%;height:100%;touch-action:manipulation;cursor:pointer;pointer-events:auto;";
    // The backing bitmap must never participate in node layout: ResizeObserver
    // updates it after each resize, including when the node is shrunk again.
    canvas.width = 1;
    canvas.height = 1;
    root.appendChild(canvas);
    // Legacy LiteGraph can place the DOM widget over its native resize hot zone.
    // Keep a dedicated bottom-right grip and resize the node directly in that case.
    const resizeHandle = document.createElement("div");
    resizeHandle.title = "拖动调整节点大小";
    resizeHandle.style.cssText = "position:absolute;right:0;bottom:0;width:18px;height:18px;box-sizing:border-box;pointer-events:auto;touch-action:none;cursor:nwse-resize;z-index:2;background:transparent;";
    root.appendChild(resizeHandle);
    const ctx = canvas.getContext("2d");
    let width = 0, height = 0, dpr = 1;
    // 位图固定超采样倍数：不跟随画布缩放变化，缩放时浏览器只做整体缩放，
    // 字体不会被重新栅格化，也就不会出现“缩放一次跳一下”的观感。
    const RASTER_SUPERSAMPLE = 2;
    // 最近一次绘制用的按钮矩形；点击时直接用它做命中判定，保证与画面完全一致。
    let lastRects = null;
    const paint = () => {
        if (!width || !height) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);
        const settings = getNodeSettings(node, DEFAULT_SETTINGS);
        const { rects } = getButtonRects(0, width, settings, Math.max(0, height - 8));
        lastRects = rects;
        const current = String(tagWidget.value ?? "0");
        const fontFamily = `"Microsoft YaHei", "微软雅黑", "PingFang SC", "Hiragino Sans GB", "SimHei", Arial, sans-serif`;
        const fontRatio = (settings.fontScale ?? DEFAULT_FONT_SCALE) / 100;
        // 所有标签共用同一个字号：取"高度比例字号"和"每个标签按自身宽度能容纳的字号"
        // 中的最小值。这样不同长度的标签字号一致，也不会被横向压扁（长标签只会让整体字号变小）。
        let fontSize = Infinity;
        for (let i = 0; i < settings.count; i++) {
            const rect = rects[i];
            if (!rect) continue;
            const target = Math.max(1, rect.h * fontRatio);
            const label = getDisplayLabel(String(i), settings.labels);
            let fitted = target;
            if (label) {
                ctx.font = `${target}px ${fontFamily}`;
                const maxTextWidth = Math.max(1, rect.w - 8);
                const textWidth = ctx.measureText(label).width;
                if (textWidth > maxTextWidth) {
                    fitted = Math.max(1, target * maxTextWidth / textWidth);
                }
            }
            fontSize = Math.min(fontSize, fitted);
        }
        if (!isFinite(fontSize)) fontSize = 1;
        ctx.font = `${fontSize}px ${fontFamily}`;
        for (let i = 0; i < settings.count; i++) {
            const rect = rects[i];
            if (!rect) continue;
            const selected = current === String(i);
            ctx.beginPath();
            ctx.roundRect(rect.x, rect.y, rect.w, rect.h, Math.min(5, rect.h / 2));
            ctx.fillStyle = selected
                ? (settings.colors.direction === "radial"
                    ? drawRadialGradient(ctx, rect.x, rect.y, rect.w, rect.h, settings.colors)
                    : drawLinearGradient(ctx, rect.x, rect.y, rect.w, rect.h, settings.colors.direction, settings.colors))
                : (settings.inactiveColor || "#2a2a2a");
            ctx.fill();
            ctx.strokeStyle = selected ? settings.colors.color1 : "#444";
            ctx.lineWidth = 1;
            ctx.stroke();
            const label = getDisplayLabel(String(i), settings.labels);
            ctx.fillStyle = settings.fontColor || "#FFFFFF";
            ctx.textAlign = "center";
            ctx.textBaseline = "alphabetic";
            if (label) {
                // 按字形墨迹盒垂直居中：textBaseline="middle" 是按字体 em 框算的，
                // 中文字形普遍偏上，改用实际墨迹的 ascent/descent 修正基线位置。
                const metrics = ctx.measureText(label);
                const ascent = metrics.actualBoundingBoxAscent;
                const descent = metrics.actualBoundingBoxDescent;
                const baselineOffset = (Number.isFinite(ascent) && Number.isFinite(descent))
                    ? (ascent - descent) / 2
                    : fontSize * 0.38;
                ctx.fillText(label, rect.x + rect.w / 2, rect.y + rect.h / 2 + baselineOffset);
            }
        }
    };
    const resize = () => {
        // 用布局尺寸（clientWidth/Height）而不是 getBoundingClientRect()：
        // 画布缩放时节点层会给 DOM 加 transform，视觉尺寸带缩放系数，
        // 用它算几何会让绘制/点击坐标错位。
        const rect = root.getBoundingClientRect();
        const w = root.clientWidth || rect.width;
        const h = root.clientHeight || rect.height;
        if (!w || !h) return;
        // 尺寸取整，避免亚像素引起的按钮/文字重排抖动。
        width = Math.round(w);
        height = Math.round(h);
        // 显式把画布的 CSS 尺寸对齐到绘制用的整数尺寸：
        // 否则 100% 得到的可能是分数高度，浏览器会对位图再做一次亚像素缩放。
        canvas.style.width = width + "px";
        canvas.style.height = height + "px";
        // 位图分辨率只跟设备像素比和固定超采样倍数有关，与画布缩放无关。
        // 超大节点降低超采样倍数，避免位图占用过大。
        const superSample = width * height > 400000 ? 1 : RASTER_SUPERSAMPLE;
        dpr = (window.devicePixelRatio || 1) * superSample;
        const bw = Math.round(width * dpr);
        const bh = Math.round(height * dpr);
        if (canvas.width !== bw || canvas.height !== bh) {
            canvas.width = bw;
            canvas.height = bh;
        }
        paint();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(root);
    // 只有设备像素比/窗口变化时才需要重新分配位图（缩放画布不需要，避免重栅格化导致跳字）。
    const onWindowResize = () => resize();
    window.addEventListener("resize", onWindowResize);
    const widget = node.addDOMWidget("xzg_selector_ui", "custom", root, {
        hideOnZoom: false, margin: 0,
        getMinHeight: () => getSelectorMinContentHeight(node), getHeight: () => "100%",
    });
    // Nodes 2 使用布局约束分配 DOM 控件高度；仅 getMinHeight 会让首次布局分到零高度。
    widget.computeLayoutSize = () => ({ minHeight: getSelectorMinContentHeight(node), minWidth: 0 });
    // Keep the legacy serialized placeholder between `label` and `_xz_settings`.
    // Existing workflows store settings in that widget position.
    widget.value = null;
    Object.defineProperty(widget, "width", {
        configurable: true,
        get: () => node.size?.[0] || 0,
        set(_) {},
    });
    // 命中判定：优先用最近一次绘制的矩形（与画面完全一致），
    // 点在按钮缝隙（≤6px）时吸附到最近的按钮，避免“点了没反应”。
    const hitTestButton = (x, y) => {
        const rects = lastRects;
        if (!rects) return -1;
        const index = rects.findIndex(r => r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
        if (index >= 0) return index;
        let best = -1;
        let bestDist = Infinity;
        rects.forEach((r, i) => {
            if (!r) return;
            const dx = Math.max(r.x - x, 0, x - (r.x + r.w));
            const dy = Math.max(r.y - y, 0, y - (r.y + r.h));
            const dist = Math.hypot(dx, dy);
            if (dist < bestDist) {
                bestDist = dist;
                best = i;
            }
        });
        return bestDist <= 6 ? best : -1;
    };
    const selectButton = (event) => {
        if (event.button !== 0) return;
        const bounds = canvas.getBoundingClientRect();
        if (!bounds.width || !bounds.height) return;
        // 把鼠标坐标换算回画布本地坐标，抵消节点层 transform 带来的缩放。
        const zoomX = (canvas.clientWidth || bounds.width) / bounds.width;
        const zoomY = (canvas.clientHeight || bounds.height) / bounds.height;
        const x = (event.clientX - bounds.left) * zoomX;
        const y = (event.clientY - bounds.top) * zoomY;
        if (!lastRects) {
            const settings = getNodeSettings(node, DEFAULT_SETTINGS);
            lastRects = getButtonRects(0, width || canvas.clientWidth, settings, Math.max(0, (height || canvas.clientHeight) - 8)).rects;
        }
        const index = hitTestButton(x, y);
        if (index < 0) return;
        tagWidget.value = String(index);
        try { tagWidget.callback?.(tagWidget.value, app.canvas, node); } catch (e) {}
        paint();
        node.setDirtyCanvas?.(true, true);
        event.preventDefault();
        event.stopPropagation();
    };
    // 只监听 pointerdown：同一次点击再叠加 mousedown/click 会在节点被拖动后
    // 用新坐标重新命中一次，导致切换结果被覆盖或看起来“点了没反应”。
    canvas.addEventListener("pointerdown", selectButton);
    // Nodes 1（canvas 渲染）下，DOM 控件盖在画布上，滚轮事件到不了 LiteGraph，
    // 鼠标停在标签上时无法缩放/平移画布。这里把滚轮转交给画布自己的处理函数。
    const forwardWheelToCanvas = (event) => {
        if (globalThis.LiteGraph?.vueNodesMode) return; // Nodes 2.0 由 Vue 层统一处理
        const lcanvas = app.canvas;
        if (!lcanvas) return;
        event.preventDefault();
        event.stopPropagation();
        if (typeof lcanvas.processMouseWheel === "function") {
            lcanvas.processMouseWheel(event);
            return;
        }
        // 兜底：重新派发到 LiteGraph 的画布元素
        lcanvas.canvas?.dispatchEvent(new WheelEvent("wheel", {
            deltaX: event.deltaX,
            deltaY: event.deltaY,
            deltaMode: event.deltaMode,
            clientX: event.clientX,
            clientY: event.clientY,
            ctrlKey: event.ctrlKey,
            shiftKey: event.shiftKey,
            altKey: event.altKey,
            metaKey: event.metaKey,
            bubbles: true,
            cancelable: true,
        }));
    };
    root.addEventListener("wheel", forwardWheelToCanvas, { passive: false });
    resizeHandle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const startX = event.clientX;
        const startY = event.clientY;
        const startWidth = node.size?.[0] || 210;
        const startHeight = node.size?.[1] || 58;
        const zoom = app.canvas?.ds?.scale || 1;
        resizeHandle.setPointerCapture?.(event.pointerId);
        const onMove = (moveEvent) => {
            const nextSize = [
                Math.max(getSelectorMinNodeWidth(node), startWidth + (moveEvent.clientX - startX) / zoom),
                Math.max(getSelectorMinNodeHeight(node), startHeight + (moveEvent.clientY - startY) / zoom),
            ];
            node.size[0] = nextSize[0];
            node.size[1] = nextSize[1];
            node.onResize?.(nextSize);
            // Some Nodes 2.0 resize hooks recalculate the DOM widget's preferred
            // height. Keep the pointer's requested size as the final node size.
            node.size[0] = nextSize[0];
            node.size[1] = nextSize[1];
            node.setDirtyCanvas?.(true, true);
            requestAnimationFrame(resize);
        };
        const onUp = (upEvent) => {
            const finalSize = [...node.size];
            resizeHandle.removeEventListener("pointermove", onMove);
            resizeHandle.removeEventListener("pointerup", onUp);
            resizeHandle.removeEventListener("pointercancel", onUp);
            try { resizeHandle.releasePointerCapture?.(upEvent.pointerId); } catch (_) {}
            node.onResize?.(finalSize);
            node.size[0] = finalSize[0];
            node.size[1] = finalSize[1];
            // 把尺寸写进 properties，刷新/重新加载后据此恢复
            writeNodeSizeHint(node, node.size[0], node.size[1]);
            app.graph?.change?.();
        };
        resizeHandle.addEventListener("pointermove", onMove);
        resizeHandle.addEventListener("pointerup", onUp);
        resizeHandle.addEventListener("pointercancel", onUp);
    });
    const previousCallback = tagWidget.callback;
    tagWidget.callback = function (...args) {
        const result = previousCallback?.apply(this, args);
        requestAnimationFrame(paint);
        return result;
    };
    const previousRemoved = node.onRemoved;
    node.onRemoved = function () {
        observer.disconnect();
        root.removeEventListener("wheel", forwardWheelToCanvas);
        window.removeEventListener("resize", onWindowResize);
        return previousRemoved?.apply(this, arguments);
    };
    node._xzgSelectorUI = {
        refresh: () => requestAnimationFrame(resize),
        canvas,
        hitTest: hitTestButton,
        // 供设置面板等外部改动尺寸后同步持久化
        persistSize: () => writeNodeSizeHint(node, node.size?.[0], node.size?.[1]),
    };
    requestAnimationFrame(resize);
    return widget;
}

const DEFAULT_SETTINGS = {
    labels: { "0": "", "1": "" },
    outputs: {},
    colors: { color1: "#000000", color2: "#FF0000", color3: "#000000", direction: "180deg" },
    count: 2,
    columns: 2,
    btnWidth: 60,
    btnHeight: 30,
    fontScale: DEFAULT_FONT_SCALE,
    gapBias: 10,
    fontColor: "#FFFFFF",
    inactiveColor: "#2a2a2a",
    widths: {},
    rowBias: {}
};

app.registerExtension({
    name: "ComfyUI.xiaozhuguang.selector.canvas",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "XiaozhuguangSelector") return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (origOnNodeCreated) origOnNodeCreated.apply(this, arguments);

            // 允许自由拖动节点大小
            this.resizable = true;
            this.flags = this.flags || {};
            this.flags.resizable = true;

            // 拖动缩放时强制最小尺寸
            const origOnResize = this.onResize;
            this.onResize = function () {
                if (origOnResize) origOnResize.apply(this, arguments);
                if (this.size) {
                    this.size[0] = Math.max(this.size[0], getSelectorMinNodeWidth(this));
                    // 最小高度必须够放下按钮，否则压缩后标签会被挤没；
                    // 该值只由设置和运行模式决定，刷新前后一致，不会造成尺寸跳动。
                    this.size[1] = Math.max(this.size[1], getSelectorMinNodeHeight(this));
                }
            };

            const settingsWidget = this.widgets?.find(w => w.name === "_xz_settings");
            if (settingsWidget) settingsWidget.hidden = true;

            const tagWidget = this.widgets?.find(w => w.name === "label");
            if (!tagWidget) return;
            const widgetIndex = this.widgets.indexOf(tagWidget);

            tagWidget.type = "hidden";
            tagWidget.hidden = true;
            tagWidget.computeSize = () => [0, 0];

            const node = this;

            createSelectorDOMWidget(node, tagWidget);
            const addedWidget = this.widgets.pop();
            this.widgets.splice(widgetIndex + 1, 0, addedWidget);

            // Recover settings saved by the first DOM-widget build, which appended
            // the UI after `_xz_settings` and therefore shifted its workflow slot.
            const previousSerialize = this.onSerialize;
            this.onSerialize = function (info) {
                const result = previousSerialize?.apply(this, arguments);
                const width = Number(info?.size?.[0] ?? this.size?.[0]);
                const height = Number(info?.size?.[1] ?? this.size?.[1]);
                if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
                    writeNodeSizeHint(this, width, height);
                    info.properties = { ...info.properties, [SIZE_HINT_KEY]: [...this.properties[SIZE_HINT_KEY]] };
                }
                return result;
            };
            const previousConfigure = this.onConfigure;
            this.onConfigure = function (info) {
                const result = previousConfigure?.apply(this, arguments);
                const settings = this.widgets?.find(w => w.name === "_xz_settings");
                const ui = this.widgets?.find(w => w.name === "xzg_selector_ui");
                if ((!settings?.value || settings.value === "null") && typeof ui?.value === "string" && ui.value.trim().startsWith("{")) {
                    settings.value = ui.value;
                    ui.value = null;
                }
                // 原生缩放更新工作流 size；旧的备用记录不能反过来覆盖它。
                const hint = readNodeSizeHint(this);
                const savedW = Number(info?.size?.[0]);
                const savedH = Number(info?.size?.[1]);
                const hasSavedSize = Number.isFinite(savedW) && Number.isFinite(savedH) && savedW > 0 && savedH > 0;
                const baseW = hasSavedSize ? savedW : hint?.[0];
                const baseH = hasSavedSize ? savedH : hint?.[1];
                if (Number.isFinite(baseW) && Number.isFinite(baseH) && baseW > 0 && baseH > 0) {
                    writeNodeSizeHint(this, baseW, baseH);
                    const restoreSize = () => {
                        if (!this.size) return;
                        const nextW = Math.max(baseW, getSelectorMinNodeWidth(this));
                        const nextH = Math.max(baseH, getSelectorMinNodeHeight(this));
                        writeNodeSizeHint(this, nextW, nextH);
                        if (Math.abs(this.size[0] - nextW) > 0.5 || Math.abs(this.size[1] - nextH) > 0.5) {
                            this.size[0] = nextW;
                            this.size[1] = nextH;
                            this.setDirtyCanvas?.(true, true);
                        }
                        this._xzgSelectorUI?.refresh?.();
                    };
                    requestAnimationFrame(() => {
                        restoreSize();
                        requestAnimationFrame(restoreSize);
                    });
                }
                this._xzgSelectorUI?.refresh?.();
                return result;
            };

            // Fallback for canvas events in frontends that route input around DOM widgets.
            const previousMouseDown = this.onMouseDown;
            this.onMouseDown = function (event, pos) {
                const ui = this._xzgSelectorUI;
                const canvas = ui?.canvas;
                const bounds = canvas?.getBoundingClientRect();
                if (event.button === 0 && bounds && bounds.width && bounds.height &&
                    event.clientX >= bounds.left && event.clientX <= bounds.right &&
                    event.clientY >= bounds.top && event.clientY <= bounds.bottom) {
                    // 与 DOM 事件使用同一套本地坐标与命中逻辑，避免节点层缩放导致错位。
                    const zoomX = (canvas.clientWidth || bounds.width) / bounds.width;
                    const zoomY = (canvas.clientHeight || bounds.height) / bounds.height;
                    const x = (event.clientX - bounds.left) * zoomX;
                    const y = (event.clientY - bounds.top) * zoomY;
                    let index = -1;
                    if (typeof ui.hitTest === "function") {
                        index = ui.hitTest(x, y);
                    } else {
                        const settings = getNodeSettings(this, DEFAULT_SETTINGS);
                        const { rects } = getButtonRects(0, canvas.clientWidth || bounds.width, settings, Math.max(0, (canvas.clientHeight || bounds.height) - 8));
                        index = rects.findIndex(r => r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
                    }
                    if (index >= 0) {
                        tagWidget.value = String(index);
                        try { tagWidget.callback?.(tagWidget.value, app.canvas, this); } catch (e) {}
                        this._xzgSelectorUI?.refresh?.();
                        this.setDirtyCanvas?.(true, true);
                        return true;
                    }
                }
                return previousMouseDown?.apply(this, arguments) ?? false;
            };

            // 初始大小：宽度按标签自然宽度推导（同布尔选择器），高度用默认值
            this.size[0] = getSelectorMinNodeWidth(this);
            this.size[1] = isVueNodesMode(this)
                ? Math.max(getSelectorMinNodeHeight(this), calcNaturalContentSize(getNodeSettings(this, DEFAULT_SETTINGS)).contentH + 72)
                : 58;
            // 加载工作流时 properties 可能晚于 onNodeCreated 才恢复，延迟再套用一次存档尺寸
            setTimeout(() => applyNodeSizeHint(this), 150);
        };
    },
});

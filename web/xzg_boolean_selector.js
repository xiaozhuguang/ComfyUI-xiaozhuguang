import { app } from "../../scripts/app.js";
import { xzgT } from "./xzg_i18n.js";

// ═══════════════════════════════════════════════
//  小珠光布尔 · Canvas 绘制版
//  按钮模式 True/False，与选择器风格一致
// ═══════════════════════════════════════════════

(function () {
    const ID = "xzg-bool-css";
    if (document.getElementById(ID)) return;
    const s = document.createElement("style");
    s.id = ID;
    s.textContent = `
.xzg-bs-dialog{position:fixed;z-index:10000;background:#2a2a2a;border:1px solid #444;border-radius:8px;padding:16px;min-width:280px;font-family:"Microsoft YaHei","微软雅黑",Arial,sans-serif;color:#fff;box-shadow:0 4px 20px rgba(0,0,0,.5)}
.xzg-bs-ptitle{font-size:14px;font-weight:700;color:#fff;margin-bottom:16px;cursor:move;user-select:none;display:flex;align-items:center;gap:8px;padding-bottom:8px;border-bottom:1px solid #3a3a3a;justify-content:space-between}
.xzg-bs-ptitle .xzg-bs-close{background:none;border:none;color:#888;font-size:18px;cursor:pointer;padding:0 4px;line-height:1}
.xzg-bs-ptitle .xzg-bs-close:hover{color:#fff}
.xzg-bs-row{display:flex;align-items:center;gap:10px;margin-bottom:12px}
.xzg-bs-rlbl{width:70px;font-size:12px;color:#aaa;flex-shrink:0;white-space:nowrap}
.xzg-bs-inp{flex:1;background:#1a1a1a;border:1px solid #444;border-radius:4px;padding:6px 8px;color:#fff;font-size:12px;outline:none;font-family:inherit}
.xzg-bs-inp:focus{border-color:#666}
.xzg-bs-clrbtn{width:28px;height:24px;border-radius:4px;border:1px solid #555;background:#2a2a2c;cursor:pointer;flex-shrink:0;padding:0;overflow:hidden}
.xzg-bs-clrbtn input[type=color]{width:150%;height:150%;border:none;cursor:pointer;background:transparent;transform:translate(-25%,-25%);padding:0;margin:0;appearance:none}
.xzg-bs-clrbtn input[type=color]::-webkit-color-swatch-wrapper{padding:0}
.xzg-bs-clrbtn input[type=color]::-webkit-color-swatch{border:none;border-radius:4px}
.xzg-bs-range{flex:1;accent-color:#4CAF50;cursor:pointer;height:4px;border-radius:2px;outline:none;appearance:none;background:#444}
.xzg-bs-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:14px;height:14px;border-radius:50%;background:#4CAF50;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.4)}
.xzg-bs-range::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:#4CAF50;cursor:pointer;border:none;box-shadow:0 1px 3px rgba(0,0,0,.4)}
.xzg-bs-val{min-width:28px;text-align:right;font-size:11px;color:#ccc;font-family:monospace}
.xzg-bs-section{border-top:1px solid #3a3a3a;padding-top:10px;margin-top:4px}
.xzg-bs-section-title{font-size:12px;color:#aaa;margin-bottom:8px}
.xzg-bs-color-row{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.xzg-bs-color-row label{font-size:11px;color:#888;width:32px;flex-shrink:0}
.xzg-bs-color-row input[type=color]{flex:1;height:28px;border:none;border-radius:4px;cursor:pointer;background:transparent}
.xzg-bs-select{flex:1;padding:5px 8px;border-radius:4px;border:1px solid #444;background:#222;color:#ddd;font-size:12px;outline:none;font-family:inherit}
.xzg-bs-btns{display:flex;gap:10px;justify-content:flex-end;margin-top:14px;padding-top:12px;border-top:1px solid #3a3a3a}
.xzg-bs-btn{padding:7px 18px;border-radius:6px;border:1px solid #555;background:transparent;color:#aaa;cursor:pointer;font-size:13px;font-family:inherit}
.xzg-bs-btn:hover{background:rgba(255,255,255,0.08)}
`;
    document.head.appendChild(s);
})();

const clamp = (v, mn, mx) => Math.max(mn, Math.min(mx, v));

// 字号是纯比例：fontScale（百分比）= 文字高度 / 标签高度，
// 绘制时 fontPx = 标签实际高度 × fontScale%，拖动缩放时比例恒定。
const DEFAULT_FONT_SCALE = 50;
const LEGACY_FONT_BASE = 30; // 旧 fontSize 字段的基准标签高度
const normalizeFontScale = (v) => clamp(Math.round(Number(v) || DEFAULT_FONT_SCALE), 20, 90);

const chainCallback = (object, property, callback) => {
    if (object == undefined) {
        console.error("Tried to add callback to non-existant object");
        return;
    }
    if (property in object) {
        const orig = object[property];
        object[property] = function(...args) {
            const r = orig.apply(this, args);
            callback.apply(this, args);
            return r;
        };
    } else {
        object[property] = callback;
    }
};

function rrect(ctx, x, y, w, h, r) {
    if (w < 0) w = 0;
    if (h < 0) h = 0;
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

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
    s.colors = { ...defaults.colors, ...(parsed.colors || {}) };
    s.labels = { ...defaults.labels, ...(parsed.labels || {}) };
    s.widths = { ...defaults.widths, ...(parsed.widths || {}) };
    s.btnWidth = clamp(s.btnWidth, 55, 300);
    s.btnHeight = clamp(s.btnHeight, 30, 80);
    // 兼容旧字段：fontSize（标签高 30px 时的字号）→ fontScale 百分比
    if (parsed.fontScale === undefined) {
        const legacyPx = parsed.fontSize !== undefined
            ? (Number(parsed.fontSize) || 12)
            : (DEFAULT_FONT_SCALE / 100) * LEGACY_FONT_BASE;
        s.fontScale = Math.round(legacyPx / LEGACY_FONT_BASE * 100);
    }
    s.fontScale = normalizeFontScale(s.fontScale);
    s.btnGap = clamp(s.btnGap, 0, 20);
    if (!s.widths || typeof s.widths !== "object") {
        s.widths = {};
    }
    return s;
}

function setNodeSettings(node, settings) {
    const sw = node.widgets?.find(w => w.name === "_xz_settings");
    if (sw) sw.value = JSON.stringify(settings);
}

function getDisplayLabel(value, labels) {
    const key = value ? "true" : "false";
    if (labels[key] && labels[key].trim()) return labels[key];
    return value ? "True" : "False";
}

function getButtonWidth(isTrue, settings) {
    const key = isTrue ? "true" : "false";
    if (settings.widths && settings.widths[key] !== undefined) {
        return clamp(settings.widths[key], 55, 300);
    }
    return clamp(settings.btnWidth, 55, 300);
}

/**
 * 计算布尔按钮布局矩形（参照小珠光选择器的边距/缩放算法）。
 * - 左右各 6px 边距：availableW = W - 12
 * - 顶部 4px、底部 8px 边距；节点高度空余时按钮等比放大填满，不足时等比缩小避免溢出
 * - 节点宽度空余时按钮等比放大填满，不足时等比压缩（保证不被节点边界裁掉）
 * - 按钮之间的比例关系（由 settings.widths / settings.btnWidth 决定）保持不变
 * @param {number} y - 控件顶部 y 坐标
 * @param {number} W - 节点宽度
 * @param {object} settings - 节点设置
 * @param {number} [availableH] - 可用高度（可选），大于自然高度时缩放按钮高度
 */
function getButtonRects(y, W, settings, availableH) {
    const gap = settings.btnGap;
    const btnH = settings.btnHeight;
    const startY = y + 4;
    const rects = [];
    const availableW = Math.max(0, W - 12); // 左右各 6px 边距

    // 高度自适应：参照选择器，按可用高度缩放按钮高度填满/压缩
    let scaledBtnH = btnH;
    let contentH = btnH;
    if (availableH !== undefined) {
        if (availableH > btnH) {
            scaledBtnH = availableH; // 放大填满
            contentH = availableH;
        } else {
            scaledBtnH = Math.max(10, availableH); // 缩小避免溢出
            contentH = availableH;
        }
    }

    const falseW = getButtonWidth(false, settings);
    const trueW = getButtonWidth(true, settings);
    const naturalTotalW = falseW + gap + trueW;

    // 宽度自适应：节点够宽时等比放大填满；不够宽时等比压缩，
    // 否则按钮会超出节点被裁掉（原先这里保持自然宽度，导致溢出）。
    let scaledFalseW = falseW;
    let scaledTrueW = trueW;
    let rowWidth;
    const totalGap = gap;
    const naturalContentW = falseW + trueW;
    const availableContentW = Math.max(0, availableW - totalGap);
    if (naturalContentW > 0) {
        const scale = availableContentW / naturalContentW;
        if (availableContentW >= naturalContentW) {
            scaledFalseW = falseW * scale;
            scaledTrueW = trueW * scale;
            rowWidth = availableW;
        } else {
            // 压缩时保底 20px，并用实际宽度重算行宽，避免最小值钳制后再次溢出
            scaledFalseW = Math.max(20, falseW * scale);
            scaledTrueW = Math.max(20, trueW * scale);
            rowWidth = scaledFalseW + totalGap + scaledTrueW;
        }
    } else {
        rowWidth = naturalTotalW;
    }

    const rowStartX = Math.max(6, (W - rowWidth) / 2);
    const invert = !!settings.invert;

    const order = invert
        ? [{ value: true, w: scaledTrueW }, { value: false, w: scaledFalseW }]
        : [{ value: false, w: scaledFalseW }, { value: true, w: scaledTrueW }];

    let curX = rowStartX;
    for (let i = 0; i < order.length; i++) {
        rects[i] = {
            x: curX,
            y: startY,
            w: order[i].w,
            h: scaledBtnH,
            value: order[i].value,
        };
        curX += order[i].w + gap;
    }

    const contentW = availableW;
    return { rects, contentW, contentH, heightScale: btnH > 0 ? scaledBtnH / btnH : 1 };
}

const DEFAULT_SETTINGS = {
    labels: { false: "False", true: "True" },
    colors: { color1: "#000000", color2: "#FF0000", color3: "#000000", direction: "180deg" },
    btnWidth: 60,
    btnHeight: 30,
    fontScale: DEFAULT_FONT_SCALE,
    btnGap: 4,
    fontColor: "#FFFFFF",
    inactiveColor: "#2a2a2a",
    widths: {},
    invert: false,
};

// ═══════════════════════════════════════════════
//  DOM 控件（Nodes 1 / Nodes 2.0 通用）
// ═══════════════════════════════════════════════

function getBoolMinContentHeight() {
    // 字号是比例值，不能参与节点最小高度计算（同选择器）；
    // 一行按钮的底线：12px 内容 + 上下各 4px 余量。
    return 20;
}

// 是否处于 Nodes 2.0：优先用全局标志（加载早期也稳定），DOM 探测只作兜底。
function isBoolVueNodesMode(node) {
    const flag = globalThis.LiteGraph?.vueNodesMode;
    if (typeof flag === "boolean") return flag;
    return !!node?._xzgBoolUI?.canvas?.closest?.(".lg-node");
}

// 尺寸持久化：拖拽结束把尺寸写进 node.properties（properties 一定会写进工作流），
// 这样即使前端没把 node.size 写回存档，刷新后也不会丢大小。
const SIZE_HINT_KEY = "_xzgSize";
function writeBoolNodeSizeHint(node, w, h) {
    if (!node || !Number.isFinite(w) || !Number.isFinite(h)) return;
    node.properties = node.properties || {};
    const prev = node.properties[SIZE_HINT_KEY];
    if (Array.isArray(prev) && Math.abs(prev[0] - w) < 0.5 && Math.abs(prev[1] - h) < 0.5) return;
    node.properties[SIZE_HINT_KEY] = [Math.round(w), Math.round(h)];
}
function readBoolNodeSizeHint(node) {
    const v = node?.properties?.[SIZE_HINT_KEY];
    if (!Array.isArray(v) || v.length < 2) return null;
    const w = Number(v[0]);
    const h = Number(v[1]);
    return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? [w, h] : null;
}
function applyBoolNodeSizeHint(node) {
    const hint = readBoolNodeSizeHint(node);
    if (!hint || !node?.size) return false;
    const nextW = Math.max(hint[0], getBoolMinNodeWidth(node));
    const nextH = Math.max(hint[1], getBoolMinNodeHeight(node));
    if (Math.abs(node.size[0] - nextW) > 0.5 || Math.abs(node.size[1] - nextH) > 0.5) {
        node.size[0] = nextW;
        node.size[1] = nextH;
        node.setDirtyCanvas?.(true, true);
    }
    node._xzgBoolUI?.refresh?.();
    return true;
}

function getBoolMinNodeWidth(node) {
    const settings = getNodeSettings(node, DEFAULT_SETTINGS);
    // 按两个标签的自然宽度定最小宽度，避免节点被缩到按钮放不下；
    // 上限 420，再宽的部分交给按钮等比压缩吸收，不让节点无限撑大。
    const natural = getButtonWidth(false, settings) + settings.btnGap + getButtonWidth(true, settings) + 12;
    return Math.min(420, Math.max(120, Math.round(natural)));
}

function getBoolMinNodeHeight(node) {
    // Nodes 2.0 的节点会为标题/插槽/底部角标预留空间，压缩过头按钮会被挤没
    return Math.max(58, getBoolMinContentHeight() + (isBoolVueNodesMode(node) ? 64 : 32));
}

function createBoolDOMWidget(node, boolWidget) {
    const root = document.createElement("div");
    root.style.cssText = "width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;contain:size layout;pointer-events:none;position:relative;";
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "position:absolute;inset:0;display:block;min-width:0;min-height:0;width:100%;height:100%;touch-action:manipulation;cursor:pointer;pointer-events:auto;";
    canvas.width = 1;
    canvas.height = 1;
    root.appendChild(canvas);
    // Legacy LiteGraph 的原生缩放手柄会被 DOM 控件盖住，单独留一个右下角手柄
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
    const fontFamily = `"Microsoft YaHei", "微软雅黑", "PingFang SC", "Hiragino Sans GB", "SimHei", Arial, sans-serif`;

    const paint = () => {
        if (!width || !height) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);
        const settings = getNodeSettings(node, DEFAULT_SETTINGS);
        const { rects } = getButtonRects(0, width, settings, Math.max(0, height - 8));
        lastRects = rects;
        const currentValue = !!boolWidget.value;
        const fontRatio = (settings.fontScale ?? DEFAULT_FONT_SCALE) / 100;

        // 两个标签共用同一个字号：取“高度比例字号”与“各自按宽度能容纳的字号”的最小值，
        // 长短不同的标签不会出现大小不一致，也不会被横向压扁。
        let fontSize = Infinity;
        for (const r of rects) {
            if (!r) continue;
            const target = Math.max(1, r.h * fontRatio);
            const label = getDisplayLabel(r.value, settings.labels);
            let fitted = target;
            if (label) {
                ctx.font = `${target}px ${fontFamily}`;
                const maxTextWidth = Math.max(1, r.w - 8);
                const textWidth = ctx.measureText(label).width;
                if (textWidth > maxTextWidth) {
                    fitted = Math.max(1, target * maxTextWidth / textWidth);
                }
            }
            fontSize = Math.min(fontSize, fitted);
        }
        if (!isFinite(fontSize)) fontSize = 1;
        ctx.font = `${fontSize}px ${fontFamily}`;

        for (const r of rects) {
            if (!r) continue;
            const isActive = currentValue === r.value;
            if (isActive) {
                ctx.fillStyle = settings.colors.direction === "radial"
                    ? drawRadialGradient(ctx, r.x, r.y, r.w, r.h, settings.colors)
                    : drawLinearGradient(ctx, r.x, r.y, r.w, r.h, settings.colors.direction, settings.colors);
            } else {
                ctx.fillStyle = settings.inactiveColor || "#2a2a2a";
            }
            rrect(ctx, r.x, r.y, r.w, r.h, 5);
            ctx.fill();

            ctx.strokeStyle = isActive ? settings.colors.color1 : "#444";
            ctx.lineWidth = 1;
            ctx.stroke();

            const label = getDisplayLabel(r.value, settings.labels);
            if (!label) continue;
            ctx.fillStyle = settings.fontColor || "#FFFFFF";
            ctx.textAlign = "center";
            ctx.textBaseline = "alphabetic";
            // 按字形墨迹盒垂直居中：textBaseline="middle" 依据的是字体 em 框，中文字形会偏上。
            const m = ctx.measureText(label);
            const ascent = m.actualBoundingBoxAscent;
            const descent = m.actualBoundingBoxDescent;
            const baselineOffset = (Number.isFinite(ascent) && Number.isFinite(descent))
                ? (ascent - descent) / 2
                : fontSize * 0.38;
            ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2 + baselineOffset);
        }
    };

    const resize = () => {
        // 用布局尺寸而不是 getBoundingClientRect()：画布缩放时节点层会给 DOM 加
        // transform，视觉尺寸带缩放系数，用它算几何会让绘制/点击坐标错位。
        const rect = root.getBoundingClientRect();
        let w = root.clientWidth || rect.width;
        const h = root.clientHeight || rect.height;
        if (!w || !h) return;
        // 部分前端会把 DOM 控件撑得比节点可视区更宽，这里再按父容器收一次，
        // 避免按钮画到节点外面被裁剪。
        const parentW = root.parentElement?.clientWidth || 0;
        if (parentW && parentW < w) w = parentW;
        width = Math.round(w);
        height = Math.round(h);
        // 显式对齐画布 CSS 尺寸，避免分数尺寸带来的亚像素缩放。
        canvas.style.width = width + "px";
        canvas.style.height = height + "px";
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
    const onWindowResize = () => resize();
    window.addEventListener("resize", onWindowResize);

    const widget = node.addDOMWidget("xzg_bool_ui", "custom", root, {
        hideOnZoom: false, margin: 0,
        getMinHeight: () => getBoolMinContentHeight(),
        getHeight: () => "100%",
    });
    // Nodes 2 的布局器用 computeLayoutSize 分配 DOM 控件高度；只提供 getMinHeight
    // 会让首次切换模式时控件被压到接近 0 高，按钮标签因此只剩一条。
    widget.computeLayoutSize = () => ({ minHeight: getBoolMinContentHeight(), minWidth: 0 });
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
        if (!rects) return null;
        for (const r of rects) {
            if (r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r;
        }
        let best = null;
        let bestDist = Infinity;
        for (const r of rects) {
            if (!r) continue;
            const dx = Math.max(r.x - x, 0, x - (r.x + r.w));
            const dy = Math.max(r.y - y, 0, y - (r.y + r.h));
            const dist = Math.hypot(dx, dy);
            if (dist < bestDist) {
                bestDist = dist;
                best = r;
            }
        }
        return bestDist <= 6 ? best : null;
    };

    const applyValue = (value) => {
        if (!!boolWidget.value === value) return;
        boolWidget.value = value;
        try { boolWidget.callback?.(value, app.canvas, node); } catch (e) {}
        paint();
        node.setDirtyCanvas?.(true, true);
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
        const rect = hitTestButton(x, y);
        if (!rect) return;
        applyValue(rect.value);
        event.preventDefault();
        event.stopPropagation();
    };

    // 只监听 pointerdown：叠加 mousedown/click 会在节点被拖动后用新坐标重新命中，
    // 导致切换结果被覆盖或看起来“点了没反应”。
    canvas.addEventListener("pointerdown", selectButton);

    // Nodes 1 下 DOM 控件盖住画布，滚轮到不了 LiteGraph，鼠标停在标签上无法缩放画布。
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
        const startWidth = node.size?.[0] || 120;
        const startHeight = node.size?.[1] || 58;
        const zoom = app.canvas?.ds?.scale || 1;
        resizeHandle.setPointerCapture?.(event.pointerId);
        const onMove = (moveEvent) => {
            const nextSize = [
                Math.max(getBoolMinNodeWidth(node), startWidth + (moveEvent.clientX - startX) / zoom),
                Math.max(getBoolMinNodeHeight(node), startHeight + (moveEvent.clientY - startY) / zoom),
            ];
            node.size[0] = nextSize[0];
            node.size[1] = nextSize[1];
            node.onResize?.(nextSize);
            // Nodes 2.0 的 resize 钩子可能回算 DOM 控件高度，这里以指针结果为准再写一次。
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
            writeBoolNodeSizeHint(node, node.size[0], node.size[1]);
            app.graph?.change?.();
        };
        resizeHandle.addEventListener("pointermove", onMove);
        resizeHandle.addEventListener("pointerup", onUp);
        resizeHandle.addEventListener("pointercancel", onUp);
    });

    const previousCallback = boolWidget.callback;
    boolWidget.callback = function (...args) {
        const result = previousCallback?.apply(this, args);
        requestAnimationFrame(paint);
        return result;
    };

    const previousRemoved = node.onRemoved;
    const onVueNodesModeChange = () => {
        requestAnimationFrame(() => {
            if (!node.size) return;
            const minHeight = getBoolMinNodeHeight(node);
            if (node.size[1] < minHeight) {
                node.size[1] = minHeight;
                writeBoolNodeSizeHint(node, node.size[0], node.size[1]);
                node.setDirtyCanvas?.(true, true);
                app.graph?.change?.();
            }
            requestAnimationFrame(resize);
        });
    };
    app.ui?.settings?.addEventListener?.("Comfy.VueNodes.Enabled.change", onVueNodesModeChange);
    node.onRemoved = function () {
        observer.disconnect();
        root.removeEventListener("wheel", forwardWheelToCanvas);
        window.removeEventListener("resize", onWindowResize);
        app.ui?.settings?.removeEventListener?.("Comfy.VueNodes.Enabled.change", onVueNodesModeChange);
        return previousRemoved?.apply(this, arguments);
    };

    node._xzgBoolUI = {
        refresh: () => requestAnimationFrame(resize),
        canvas,
        hitTest: hitTestButton,
        // 供设置面板等外部改动尺寸后同步持久化
        persistSize: () => writeBoolNodeSizeHint(node, node.size?.[0], node.size?.[1]),
    };
    requestAnimationFrame(resize);
    return widget;
}

// ═══════════════════════════════════════════════
//  设置控制面板
// ═════════════════════════════════════════════

let _boolSettingsPanel = null;

function openBoolSettingsPanel(node) {
    if (_boolSettingsPanel) {
        _boolSettingsPanel.remove();
        _boolSettingsPanel = null;
    }

    const s = getNodeSettings(node, DEFAULT_SETTINGS);
    const origSettings = JSON.parse(JSON.stringify(s));
    const origSize = [node.size[0], node.size[1]];

    const dlgWidth = 340;

    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;z-index:9999;background:transparent;pointer-events:none;";

    const dialog = document.createElement("div");
    dialog.className = "xzg-bs-dialog";
    dialog.style.cssText = "pointer-events:auto;position:absolute;top:50%;right:20px;transform:translateY(-50%);margin:0;";
    dialog.style.width = dlgWidth + "px";
    overlay.appendChild(dialog);

    const title = document.createElement("div");
    title.className = "xzg-bs-ptitle";
    title.innerHTML = `<span>⚙ ${xzgT('小珠光布尔设置','Xiaozhuguang Boolean Settings')}</span><button class="xzg-bs-close">✕</button>`;
    dialog.appendChild(title);

    function addRow(labelText, control) {
        const r = document.createElement("div");
        r.className = "xzg-bs-row";
        const l = document.createElement("label");
        l.className = "xzg-bs-rlbl";
        l.textContent = labelText;
        r.append(l, control);
        dialog.appendChild(r);
        return r;
    }

    function mkRange(min, max, step, value, suffix = "") {
        const wrap = document.createElement("div");
        wrap.style.cssText = "flex:1;display:flex;align-items:center;gap:8px;";
        const inp = document.createElement("input");
        inp.className = "xzg-bs-range";
        inp.type = "range";
        inp.min = min; inp.max = max; inp.step = step; inp.value = value;
        const val = document.createElement("span");
        val.className = "xzg-bs-val";
        val.textContent = value + suffix;
        wrap.append(inp, val);
        return { wrap, inp, val, suffix };
    }

    function mkClrBtn(color) {
        const btn = document.createElement("div");
        btn.className = "xzg-bs-clrbtn";
        const inp = document.createElement("input");
        inp.type = "color";
        inp.value = rgbToHex(color);
        btn.appendChild(inp);
        btn._input = inp;
        return btn;
    }

    const falseWidth = s.widths?.false !== undefined ? s.widths.false : s.btnWidth;
    const trueWidth = s.widths?.true !== undefined ? s.widths.true : s.btnWidth;


    const falseWidthCtrl = mkRange(55, 300, 1, falseWidth);
    addRow(xzgT('左标签宽度','Left Label Width'), falseWidthCtrl.wrap);

    const trueWidthCtrl = mkRange(55, 300, 1, trueWidth);
    addRow(xzgT('右标签宽度','Right Label Width'), trueWidthCtrl.wrap);

    const gapCtrl = mkRange(0, 20, 1, s.btnGap);
    addRow(xzgT('按钮间距','Button Gap'), gapCtrl.wrap);

    // 字号是相对标签高度的比例（百分比），拖动缩放节点时比例保持不变
    const fontSizeCtrl = mkRange(20, 90, 1, s.fontScale ?? DEFAULT_FONT_SCALE, "%");
    fontSizeCtrl.inp.title = xzgT('文字高度占标签高度的比例，缩放时保持不变','Text height as a percentage of label height; constant while resizing');
    const fontSizeRow = addRow(xzgT('标签字号','Label Font Size'), fontSizeCtrl.wrap);
    fontSizeRow.firstChild.title = fontSizeCtrl.inp.title;

    const falseLabelInp = document.createElement("input");
    falseLabelInp.className = "xzg-bs-inp";
    falseLabelInp.type = "text";
    falseLabelInp.value = s.labels?.false || "False";
    addRow(xzgT('左侧标签','Left Label'), falseLabelInp);

    const trueLabelInp = document.createElement("input");
    trueLabelInp.className = "xzg-bs-inp";
    trueLabelInp.type = "text";
    trueLabelInp.value = s.labels?.true || "True";
    addRow(xzgT('右侧标签','Right Label'), trueLabelInp);

    const colorRow = document.createElement("div");
    colorRow.className = "xzg-bs-row";
    const colorLbl = document.createElement("label");
    colorLbl.className = "xzg-bs-rlbl";
    colorLbl.textContent = xzgT('颜色设置','Color Settings');
    const colorWrap = document.createElement("div");
    colorWrap.style.cssText = "flex:1;display:flex;align-items:center;gap:8px;";
    const fontColorBtn = mkClrBtn(s.fontColor || "#aaa");
    fontColorBtn.title = xzgT('文字颜色','Text Color');
    fontColorBtn.style.flex = "1";
    const inactiveColorBtn = mkClrBtn(s.inactiveColor || "#2a2a2a");
    inactiveColorBtn.title = xzgT('未选中色','Inactive Color');
    inactiveColorBtn.style.flex = "1";
    const fcLabel = document.createElement("span");
    fcLabel.style.cssText = "font-size:11px;color:#888;white-space:nowrap;";
    fcLabel.textContent = xzgT('文字','Text');
    const icLabel = document.createElement("span");
    icLabel.style.cssText = "font-size:11px;color:#888;white-space:nowrap;";
    icLabel.textContent = xzgT('未选','Inactive');
    colorWrap.append(fcLabel, fontColorBtn, icLabel, inactiveColorBtn);
    colorRow.append(colorLbl, colorWrap);
    dialog.appendChild(colorRow);

    const invertRow = document.createElement("div");
    invertRow.className = "xzg-bs-row";
    const invertLbl = document.createElement("label");
    invertLbl.className = "xzg-bs-rlbl";
    invertLbl.textContent = xzgT('反向输出','Invert Output');
    const invertWrap = document.createElement("div");
    invertWrap.style.cssText = "flex:1;display:flex;align-items:center;gap:10px;";
    const invertSwitch = document.createElement("div");
    invertSwitch.style.cssText = "position:relative;width:40px;height:22px;border-radius:11px;background:" + (s.invert ? "#4CAF50" : "#555") + ";cursor:pointer;transition:background 0.2s;";
    const invertKnob = document.createElement("div");
    invertKnob.style.cssText = "position:absolute;top:2px;left:" + (s.invert ? "20px" : "2px") + ";width:18px;height:18px;border-radius:50%;background:#fff;transition:left 0.2s;";
    invertSwitch.appendChild(invertKnob);
    const invertTxt = document.createElement("span");
    invertTxt.style.cssText = "font-size:12px;color:#aaa;";
    invertTxt.textContent = s.invert ? xzgT('左真右假','Left True/Right False') : xzgT('左假右真','Left False/Right True');
    invertSwitch.addEventListener("click", () => {
        s.invert = !s.invert;
        invertSwitch.style.background = s.invert ? "#4CAF50" : "#555";
        invertKnob.style.left = s.invert ? "20px" : "2px";
        invertTxt.textContent = s.invert ? xzgT('左真右假','Left True/Right False') : xzgT('左假右真','Left False/Right True');
        applyPreview();
    });
    invertWrap.append(invertSwitch, invertTxt);
    invertRow.append(invertLbl, invertWrap);
    dialog.appendChild(invertRow);

    const section = document.createElement("div");
    section.className = "xzg-bs-section";
    const sectionTitle = document.createElement("div");
    sectionTitle.className = "xzg-bs-section-title";
    sectionTitle.textContent = xzgT('选中渐变色','Selected Gradient');
    section.appendChild(sectionTitle);

    const color1Row = document.createElement("div");
    color1Row.className = "xzg-bs-color-row";
    color1Row.innerHTML = `<label>${xzgT('色1','C1')}</label><input type="color" value="${s.colors.color1}"><label>${xzgT('色2','C2')}</label><input type="color" value="${s.colors.color2}"><label>${xzgT('色3','C3')}</label><input type="color" value="${s.colors.color3}">`;
    section.appendChild(color1Row);

    const dirRow = document.createElement("div");
    dirRow.className = "xzg-bs-row";
    const dirLbl = document.createElement("label");
    dirLbl.className = "xzg-bs-rlbl";
    dirLbl.textContent = xzgT('方向','Direction');
    const dirSel = document.createElement("select");
    dirSel.className = "xzg-bs-select";
    const dirs = [
        ["0deg", "↑ " + xzgT('从上到下','Top to Bottom')],
        ["90deg", "→ " + xzgT('从左到右','Left to Right')],
        ["180deg", "↓ " + xzgT('从下到上','Bottom to Top')],
        ["270deg", "← " + xzgT('从右到左','Right to Left')],
        ["radial", "◉ " + xzgT('径向','Radial')],
    ];
    dirs.forEach(([val, txt]) => {
        const opt = document.createElement("option");
        opt.value = val;
        opt.textContent = txt;
        if (s.colors.direction === val) opt.selected = true;
        dirSel.appendChild(opt);
    });
    dirRow.append(dirLbl, dirSel);
    section.appendChild(dirRow);

    dialog.appendChild(section);

    const btns = document.createElement("div");
    btns.className = "xzg-bs-btns";
    const resetBtn = document.createElement("button");
    resetBtn.className = "xzg-bs-btn";
    resetBtn.textContent = xzgT('恢复默认','Reset');
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "xzg-bs-btn";
    cancelBtn.textContent = xzgT('取消','Cancel');
    const applyBtn = document.createElement("button");
    applyBtn.className = "xzg-bs-btn";
    applyBtn.textContent = xzgT('确定','OK');
    btns.append(resetBtn, cancelBtn, applyBtn);
    dialog.appendChild(btns);

    document.body.appendChild(overlay);
    _boolSettingsPanel = overlay;

    let dragging = false, dragOffX = 0, dragOffY = 0;
    title.addEventListener("mousedown", (e) => {
        if (e.target.tagName === "BUTTON") return;
        dragging = true;
        const rect = dialog.getBoundingClientRect();
        dragOffX = e.clientX - rect.left;
        dragOffY = e.clientY - rect.top;
        dialog.style.right = "auto";
        dialog.style.transform = "none";
        e.preventDefault();
        e.stopPropagation();
    });
    document.addEventListener("mousemove", (e) => {
        if (!dragging) return;
        let nx = e.clientX - dragOffX;
        let ny = e.clientY - dragOffY;
        const rect = dialog.getBoundingClientRect();
        if (nx + rect.width > window.innerWidth) nx = window.innerWidth - rect.width;
        if (ny + rect.height > window.innerHeight) ny = window.innerHeight - rect.height;
        if (nx < 0) nx = 0;
        if (ny < 0) ny = 0;
        dialog.style.left = nx + "px";
        dialog.style.top = ny + "px";
    });
    document.addEventListener("mouseup", () => { dragging = false; });

    const colorInputs = color1Row.querySelectorAll('input[type="color"]');
    const color1Inp = colorInputs[0];
    const color2Inp = colorInputs[1];
    const color3Inp = colorInputs[2];

    let _initializing = true;

    function applyPreview() {
        if (_initializing) return;
        const ns = JSON.parse(JSON.stringify(s));
        const falseW = clamp(parseInt(falseWidthCtrl.inp.value), 55, 300);
        const trueW = clamp(parseInt(trueWidthCtrl.inp.value), 55, 300);
        ns.widths = { false: falseW, true: trueW };
        ns.btnGap = clamp(parseInt(gapCtrl.inp.value), 0, 20);
        ns.fontScale = normalizeFontScale(fontSizeCtrl.inp.value);
        ns.labels = {
            false: falseLabelInp.value,
            true: trueLabelInp.value,
        };
        ns.fontColor = rgbToHex(fontColorBtn._input.value);
        ns.inactiveColor = rgbToHex(inactiveColorBtn._input.value);
        ns.colors = {
            color1: rgbToHex(color1Inp.value),
            color2: rgbToHex(color2Inp.value),
            color3: rgbToHex(color3Inp.value),
            direction: dirSel.value,
        };
        ns.invert = !!s.invert;
        Object.assign(s, ns);
        setNodeSettings(node, s);
        // 自由缩放模式：不强制修改节点尺寸，按钮在用户拖动的节点内自适应填满
        // 仅确保不小于最小尺寸（Nodes 2.0 会额外预留插槽/底栏空间）
        if (node.size) {
            node.size[0] = Math.max(node.size[0], getBoolMinNodeWidth(node));
            node.size[1] = Math.max(node.size[1], getBoolMinNodeHeight(node));
        }
        node._xzgBoolUI?.refresh?.();
        node.setDirtyCanvas?.(true, true);
    }

    [falseWidthCtrl, trueWidthCtrl, gapCtrl, fontSizeCtrl].forEach(ctrl => {
        updateRangeFill(ctrl.inp);
        ctrl.inp.addEventListener("input", () => {
            ctrl.val.textContent = ctrl.inp.value + (ctrl.suffix || "");
            updateRangeFill(ctrl.inp);
            applyPreview();
        });
    });

    [fontColorBtn, inactiveColorBtn].forEach(btn => {
        const inp = btn._input;
        inp.addEventListener("input", () => {
            btn.style.background = inp.value;
            applyPreview();
        });
        inp.addEventListener("change", () => {
            btn.style.background = inp.value;
            applyPreview();
        });
    });

    [color1Inp, color2Inp, color3Inp, dirSel].forEach(el => {
        el.addEventListener("input", applyPreview);
        el.addEventListener("change", applyPreview);
    });

    [falseLabelInp, trueLabelInp].forEach(el => {
        el.addEventListener("input", applyPreview);
    });

    setTimeout(() => {
        _initializing = false;
    }, 50);

    const closePanel = (apply) => {
        if (!apply) {
            setNodeSettings(node, origSettings);
            node.size[0] = origSize[0];
            node.size[1] = origSize[1];
            node._xzgBoolUI?.refresh?.();
            node.setDirtyCanvas?.(true, true);
        }
        overlay.remove();
        _boolSettingsPanel = null;
    };
    title.querySelector(".xzg-bs-close").addEventListener("click", () => closePanel(true));
    cancelBtn.addEventListener("click", () => closePanel(false));
    applyBtn.addEventListener("click", () => closePanel(true));
    resetBtn.addEventListener("click", () => {
        setNodeSettings(node, JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
        overlay.remove();
        openBoolSettingsPanel(node);
    });
}

function rgbToHex(rgb) {
    if (!rgb || rgb.startsWith("#")) return rgb || "#000000";
    const m = rgb.match(/\d+/g);
    if (!m || m.length < 3) return "#000000";
    return "#" + m.slice(0, 3).map(x => parseInt(x).toString(16).padStart(2, "0")).join("");
}

function updateRangeFill(input) {
    const min = parseFloat(input.min) || 0;
    const max = parseFloat(input.max) || 100;
    const val = parseFloat(input.value) || 0;
    const pct = ((val - min) / (max - min)) * 100;
    input.style.background = `linear-gradient(to right, #81C784 0%, #81C784 ${pct}%, #444 ${pct}%, #444 100%)`;
}

app.registerExtension({
    name: "ComfyUI.xiaozhuguang.boolean_selector",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "XiaozhuguangBooleanSelector") return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (origOnNodeCreated) origOnNodeCreated.apply(this, arguments);

            // 参照小珠光选择器：允许自由拖动节点大小
            this.resizable = true;
            this.flags = this.flags || {};
            this.flags.resizable = true;

            // 拖动缩放时强制最小尺寸（Nodes 2.0 需要额外预留插槽/底部角标空间）
            const origOnResize = this.onResize;
            this.onResize = function () {
                if (origOnResize) origOnResize.apply(this, arguments);
                if (this.size) {
                    this.size[0] = Math.max(this.size[0], getBoolMinNodeWidth(this));
                    // 最小高度要保证按钮可见；该值只由设置和运行模式决定，刷新前后一致
                    this.size[1] = Math.max(this.size[1], getBoolMinNodeHeight(this));
                }
            };

            const settingsWidget = this.widgets?.find(w => w.name === "_xz_settings");
            if (settingsWidget) settingsWidget.hidden = true;

            const boolWidget = this.widgets?.find(w => w.name === "boolean_value");
            if (!boolWidget) return;
            const widgetIndex = this.widgets.indexOf(boolWidget);

            boolWidget.type = "hidden";
            boolWidget.hidden = true;
            boolWidget.computeSize = () => [0, 0];

            const node = this;

            // 用 DOM 控件承载按钮（Nodes 2.0 下节点不再走 canvas 绘制，
            // addCustomWidget 的 draw 不会被调用，必须改成 DOM）
            createBoolDOMWidget(node, boolWidget);
            const custom = this.widgets.pop();
            this.widgets.splice(widgetIndex + 1, 0, custom);

            // Recover settings saved by an earlier DOM-widget build that shifted the slot.
            const previousSerialize = this.onSerialize;
            this.onSerialize = function (info) {
                const result = previousSerialize?.apply(this, arguments);
                const width = Number(info?.size?.[0] ?? this.size?.[0]);
                const height = Number(info?.size?.[1] ?? this.size?.[1]);
                if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
                    writeBoolNodeSizeHint(this, width, height);
                    info.properties = { ...info.properties, [SIZE_HINT_KEY]: [...this.properties[SIZE_HINT_KEY]] };
                }
                return result;
            };
            const previousConfigure = this.onConfigure;
            this.onConfigure = function (info) {
                const result = previousConfigure?.apply(this, arguments);
                const settings = this.widgets?.find(w => w.name === "_xz_settings");
                const ui = this.widgets?.find(w => w.name === "xzg_bool_ui");
                if ((!settings?.value || settings.value === "null") && typeof ui?.value === "string" && ui.value.trim().startsWith("{")) {
                    settings.value = ui.value;
                    ui.value = null;
                }
                // 原生缩放更新工作流 size；旧的备用记录不能反过来覆盖它。
                const hint = readBoolNodeSizeHint(this);
                const savedW = Number(info?.size?.[0]);
                const savedH = Number(info?.size?.[1]);
                const hasSavedSize = Number.isFinite(savedW) && Number.isFinite(savedH) && savedW > 0 && savedH > 0;
                const baseW = hasSavedSize ? savedW : hint?.[0];
                const baseH = hasSavedSize ? savedH : hint?.[1];
                if (Number.isFinite(baseW) && Number.isFinite(baseH) && baseW > 0 && baseH > 0) {
                    writeBoolNodeSizeHint(this, baseW, baseH);
                    const restoreSize = () => {
                        if (!this.size) return;
                        const nextW = Math.max(baseW, getBoolMinNodeWidth(this));
                        const nextH = Math.max(baseH, getBoolMinNodeHeight(this));
                        writeBoolNodeSizeHint(this, nextW, nextH);
                        if (Math.abs(this.size[0] - nextW) > 0.5 || Math.abs(this.size[1] - nextH) > 0.5) {
                            this.size[0] = nextW;
                            this.size[1] = nextH;
                            this.setDirtyCanvas?.(true, true);
                        }
                        this._xzgBoolUI?.refresh?.();
                    };
                    requestAnimationFrame(() => {
                        restoreSize();
                        requestAnimationFrame(restoreSize);
                    });
                }
                this._xzgBoolUI?.refresh?.();
                return result;
            };

            // Fallback for frontends that route canvas input around DOM widgets.
            const previousMouseDown = this.onMouseDown;
            this.onMouseDown = function (event, pos) {
                if (event.type === "wheel") return previousMouseDown?.apply(this, arguments) ?? false;
                const ui = this._xzgBoolUI;
                const uiCanvas = ui?.canvas;
                const bounds = uiCanvas?.getBoundingClientRect();
                if (event.button === 0 && bounds && bounds.width && bounds.height &&
                    event.clientX >= bounds.left && event.clientX <= bounds.right &&
                    event.clientY >= bounds.top && event.clientY <= bounds.bottom) {
                    // 与 DOM 事件使用同一套本地坐标与命中逻辑，避免节点层缩放导致错位。
                    const zoomX = (uiCanvas.clientWidth || bounds.width) / bounds.width;
                    const zoomY = (uiCanvas.clientHeight || bounds.height) / bounds.height;
                    const x = (event.clientX - bounds.left) * zoomX;
                    const y = (event.clientY - bounds.top) * zoomY;
                    const rect = typeof ui.hitTest === "function" ? ui.hitTest(x, y) : null;
                    if (rect) {
                        if (!!boolWidget.value !== rect.value) {
                            boolWidget.value = rect.value;
                            try { boolWidget.callback?.(rect.value, app.canvas, this); } catch (e) {}
                        }
                        this._xzgBoolUI?.refresh?.();
                        this.setDirtyCanvas?.(true, true);
                        return true;
                    }
                }
                return previousMouseDown?.apply(this, arguments) ?? false;
            };

            chainCallback(this, "getExtraMenuOptions", function(_, options) {
                options.splice(0, 0, null, {
                    content: "⚙ " + xzgT('小珠光布尔设置','Xiaozhuguang Boolean Settings'),
                    color: '#FFD700',
                    callback: () => openBoolSettingsPanel(node),
                });
            });

            // 初始大小：用自然宽度计算（避免按钮被拉伸填满过宽的节点）
            const settings = getNodeSettings(this, DEFAULT_SETTINGS);
            const falseW = getButtonWidth(false, settings);
            const trueW = getButtonWidth(true, settings);
            const naturalW = falseW + settings.btnGap + trueW + 12; // +12 左右边距
            const { contentH } = getButtonRects(0, naturalW, settings);
            this.size[0] = Math.max(getBoolMinNodeWidth(this), naturalW);
            this.size[1] = Math.max(getBoolMinNodeHeight(this), contentH + 28);
            this._xzgBoolUI?.refresh?.();
            // 加载工作流时 properties 可能晚于 onNodeCreated 才恢复，延迟再套用一次存档尺寸
            setTimeout(() => applyBoolNodeSizeHint(this), 150);
        };
    },
});

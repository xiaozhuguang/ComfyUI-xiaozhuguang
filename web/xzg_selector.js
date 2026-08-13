import { app } from "../../scripts/app.js";

// ═══════════════════════════════════════════════
//  小珠光选择器 · Canvas 绘制版
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
    const max = Math.max(1, s.count);
    s.columns = Math.max(1, Math.min(s.columns, max));
    s.btnWidth = clamp(s.btnWidth, 30, 300);
    s.btnHeight = clamp(s.btnHeight, 30, 80);
    // 字体大小直接数值 8-60，不再绑定 btnHeight
    if (s.fontSize === undefined && s.fontBias !== undefined) {
        // 兼容旧 fontBias：基准 = btnHeight/2，转换为数值
        const base = (s.btnHeight || defaults.btnHeight) / 2;
        s.fontSize = clamp(Math.round(base * (1 + (s.fontBias || 0) / 100)), 8, 60);
    }
    s.fontSize = clamp(s.fontSize || 15, 8, 60);
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

        // 按钮宽度：节点宽度足够时等比放大填满；不足时保持自然宽度，不压缩按钮（由节点宽度自适应）
        let scaledWidths = [];
        let rowWidth;
        if (naturalRowWidth > 0 && rowCount > 0) {
            const totalGap = (rowCount - 1) * gap;
            const naturalContentW = naturalRowWidth - totalGap;
            const availableContentW = Math.max(0, availableW - totalGap);
            if (availableContentW >= naturalContentW) {
                // 节点够宽：放大按钮填满
                const scale = availableContentW / naturalContentW;
                for (let i = rowStartIdx; i < rowEndIdx; i++) {
                    scaledWidths[i] = naturalWidths[i] * scale;
                }
                rowWidth = availableW;
            } else {
                // 节点不够宽：保持按钮自然宽度，不压缩
                for (let i = rowStartIdx; i < rowEndIdx; i++) {
                    scaledWidths[i] = naturalWidths[i];
                }
                rowWidth = naturalRowWidth;
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

const DEFAULT_SETTINGS = {
    labels: { "0": "", "1": "" },
    colors: { color1: "#000000", color2: "#FF0000", color3: "#000000", direction: "180deg" },
    count: 2,
    columns: 2,
    btnWidth: 60,
    btnHeight: 30,
    fontSize: 15,
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
                    if (this.size[0] < 210) this.size[0] = 210;
                    if (this.size[1] < 58) this.size[1] = 58;
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

            node.addCustomWidget({
                name: "xzg_selector_ui",
                type: "xzg_selector",

                draw(ctx, node, W, y, H) {
                    const settings = getNodeSettings(node, DEFAULT_SETTINGS);
                    const count = settings.count;
                    // 用节点实际高度计算可用高度，而非 H 参数（H 始终为自然高度）
                    const nodeH = node.size[1] || 0;
                    const availH = Math.max(0, nodeH - y - 8);
                    const { rects, contentH, heightScale } = getButtonRects(y, W, settings, availH);
                    const currentValue = String(tagWidget.value ?? "0");

                    for (let i = 0; i < count; i++) {
                        const r = rects[i];
                        if (!r) continue;
                        const value = String(i);
                        const isActive = currentValue === value;

                        ctx.save();
                        if (isActive) {
                            if (settings.colors.direction === "radial") {
                                ctx.fillStyle = drawRadialGradient(ctx, r.x, r.y, r.w, r.h, settings.colors);
                            } else {
                                ctx.fillStyle = drawLinearGradient(ctx, r.x, r.y, r.w, r.h, settings.colors.direction, settings.colors);
                            }
                        } else {
                            ctx.fillStyle = settings.inactiveColor || "#2a2a2a";
                        }
                        rrect(ctx, r.x, r.y, r.w, r.h, 5);
                        ctx.fill();

                        ctx.strokeStyle = isActive ? settings.colors.color1 : "#444";
                        ctx.lineWidth = 1;
                        ctx.stroke();

                        const label = getDisplayLabel(value, settings.labels);
                        ctx.fillStyle = settings.fontColor || "#FFFFFF";
                        // 字体大小直接使用 fontSize 数值（8-60），不再随节点高度缩放
                        const effectiveFont = clamp(settings.fontSize || 15, 8, r.h * 0.85);
                        ctx.font = `${effectiveFont}px "Microsoft YaHei", "微软雅黑", "PingFang SC", "Hiragino Sans GB", "SimHei", Arial, sans-serif`;
                        ctx.textAlign = "center";
                        // 用实际字形度量精确垂直居中，避免大字体时偏上
                        ctx.textBaseline = "alphabetic";
                        const m = ctx.measureText(label);
                        const ascent = m.actualBoundingBoxAscent || effectiveFont * 0.8;
                        const descent = m.actualBoundingBoxDescent || effectiveFont * 0.2;
                        ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2 + (ascent - descent) / 2);
                        ctx.restore();
                    }

                    node._xzgSelY = y;
                    node._xzgSelH = contentH + 8;
                },

                mouse(event, pos, node) {
                    // 点击检测由 node.onMouseDown 处理，这里不再响应
                    return false;
                },

                computeSize(width) {
                    // 返回极小值，不干预节点高度，让用户自由拖动
                    return [width, 4];
                },
            });

            const custom = this.widgets.pop();
            this.widgets.splice(widgetIndex + 1, 0, custom);

            // 节点级点击检测：覆盖整个节点区域，不受 computeSize 限制
            const _node = this;
            _node.onMouseDown = function(event, pos) {
                if (event.button !== 0) return false;
                const settings = getNodeSettings(_node, DEFAULT_SETTINGS);
                const W = _node.size[0];
                const yPos = _node._xzgSelY !== undefined ? _node._xzgSelY : 0;
                const nodeH = _node.size[1] || 0;
                const availH = Math.max(0, nodeH - yPos - 8);
                const { rects } = getButtonRects(yPos, W, settings, availH);

                for (let i = 0; i < rects.length; i++) {
                    const r = rects[i];
                    if (!r) continue;
                    if (pos[0] >= r.x && pos[0] <= r.x + r.w &&
                        pos[1] >= r.y && pos[1] <= r.y + r.h) {
                        const value = String(i);
                        tagWidget.value = value;
                        if (tagWidget.callback) {
                            try { tagWidget.callback(value); } catch (e) {}
                        }
                        _node.setDirtyCanvas(true, true);
                        return true;
                    }
                }
                return false;
            };

            // 初始大小：与 rebuildSelectorNode 公式一致
            const settings = getNodeSettings(this, DEFAULT_SETTINGS);
            const { contentW, contentH } = calcNaturalContentSize(settings);
            this.size[0] = Math.max(210, contentW + 12);
            this.size[1] = 58;
        };
    },
});
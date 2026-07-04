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
    s.btnWidth = clamp(s.btnWidth, 55, 200);
    s.btnHeight = clamp(s.btnHeight, 30, 80);
    s.fontSize = clamp(s.fontSize, 10, 24);
    s.btnGap = clamp(s.btnGap, 0, 20);
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

// 计算每个按钮的矩形（基于 widget 绘制区域）
function getButtonRects(y, W, settings) {
    const count = settings.count;
    const cols = settings.columns;
    const rows = Math.ceil(count / cols);
    const gap = settings.btnGap;
    const minW = cols === 1 ? 130 : (cols === 2 ? 65 : 55);
    const btnW = Math.max(minW, settings.btnWidth);
    const btnH = settings.btnHeight;
    const contentW = cols * btnW + (cols - 1) * gap;
    const contentH = rows * btnH + (rows - 1) * gap;
    const startX = Math.max(10, (W - contentW) / 2);
    const startY = y + 10;
    const rects = [];
    for (let i = 0; i < count; i++) {
        const row = Math.floor(i / cols);
        const col = i % cols;
        rects.push({
            x: startX + col * (btnW + gap),
            y: startY + row * (btnH + gap),
            w: btnW,
            h: btnH,
        });
    }
    return { rects, contentW, contentH };
}

const DEFAULT_SETTINGS = {
    labels: { "0": "", "1": "" },
    colors: { color1: "#000000", color2: "#FF0000", color3: "#000000", direction: "180deg" },
    count: 2,
    columns: 2,
    btnWidth: 60,
    btnHeight: 30,
    fontSize: 12,
    btnGap: 4,
    fontColor: "#aaa",
    inactiveColor: "#2a2a2a"
};

app.registerExtension({
    name: "ComfyUI.xiaozhuguang.selector.canvas",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "XiaozhuguangSelector") return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (origOnNodeCreated) origOnNodeCreated.apply(this, arguments);

            this.resizable = false;
            this.flags = this.flags || {};
            this.flags.resizable = false;

            const settingsWidget = this.widgets?.find(w => w.name === "_xz_settings");
            if (settingsWidget) settingsWidget.hidden = true;

            const tagWidget = this.widgets?.find(w => w.name === "标签");
            if (!tagWidget) return;
            const widgetIndex = this.widgets.indexOf(tagWidget);

            tagWidget.type = "hidden";
            tagWidget.hidden = true;
            tagWidget.computeSize = () => [0, 0];

            let currentValue = tagWidget.value || "0";
            const node = this;

            // 隐藏默认标签 widget，用自定义 Canvas widget 替代
            node.addCustomWidget({
                name: "xzg_selector_ui",
                type: "xzg_selector",

                draw(ctx, node, W, y, H) {
                    const settings = getNodeSettings(node, DEFAULT_SETTINGS);
                    const count = settings.count;
                    const { rects, contentH } = getButtonRects(y, W, settings);

                    for (let i = 0; i < count; i++) {
                        const r = rects[i];
                        const value = String(i);
                        const isActive = currentValue === value;

                        ctx.save();
                        // 背景
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

                        // 边框
                        ctx.strokeStyle = isActive ? settings.colors.color1 : "#444";
                        ctx.lineWidth = 1;
                        ctx.stroke();

                        // 文字
                        const label = getDisplayLabel(value, settings.labels);
                        ctx.fillStyle = settings.fontColor || "#aaa";
                        ctx.font = `${settings.fontSize}px "Microsoft YaHei", "微软雅黑", "PingFang SC", "Hiragino Sans GB", "SimHei", Arial, sans-serif`;
                        ctx.textAlign = "center";
                        ctx.textBaseline = "middle";
                        ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2);
                        ctx.restore();
                    }

                    // 存储计算出的高度，供 computeSize 使用
                    node._xzgSelH = contentH + 20;
                },

                mouse(event, pos, node) {
                    if (event.type === "wheel") return false;
                    if (event.type !== "mousedown" && event.type !== "pointerdown") return false;
                    if (event.button !== 0 && event.type === "mousedown") return false;

                    const settings = getNodeSettings(node, DEFAULT_SETTINGS);
                    const W = node.size[0];
                    const { rects } = getButtonRects(this.y || 0, W, settings);

                    for (let i = 0; i < rects.length; i++) {
                        const r = rects[i];
                        if (pos[0] >= r.x && pos[0] <= r.x + r.w &&
                            pos[1] >= r.y && pos[1] <= r.y + r.h) {
                            const value = String(i);
                            currentValue = value;
                            tagWidget.value = value;
                            if (tagWidget.callback) {
                                try { tagWidget.callback(value); } catch (e) {}
                            }
                            node.setDirtyCanvas(true, true);
                            return true;
                        }
                    }
                    return false;
                },

                computeSize(width) {
                    const settings = getNodeSettings(node, DEFAULT_SETTINGS);
                    const { contentH } = getButtonRects(0, width, settings);
                    return [width, contentH + 25];
                },
            });

            // 重新排列 widget：隐藏的标签 widget 保留在原位，Canvas widget 在其后
            const custom = this.widgets.pop();
            this.widgets.splice(widgetIndex + 1, 0, custom);

            // 设置节点尺寸
            const settings = getNodeSettings(this, DEFAULT_SETTINGS);
            const { contentW, contentH } = getButtonRects(0, this.size[0], settings);
            this.size[0] = Math.max(180, contentW + 40);
            this.size[1] = Math.max(80, contentH + 50);
        };
    },
});

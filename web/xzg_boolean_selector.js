import { app } from "../../scripts/app.js";

// ═══════════════════════════════════════════════
//  小珠光布尔选择器 · Canvas 绘制版
//  开关切换 True/False，缩放任意大小都清晰
// ═══════════════════════════════════════════════

const clamp = (v, mn, mx) => Math.max(mn, Math.min(mx, v));

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

function getNodeSettings(node) {
    const sw = node.widgets?.find(w => w.name === "_xz_settings");
    let parsed = {};
    if (sw && sw.value) {
        try { parsed = JSON.parse(sw.value); } catch (e) {}
    }
    return {
        trueLabel: parsed.trueLabel || "开启",
        falseLabel: parsed.falseLabel || "关闭",
        onColor: parsed.onColor || "#4CAF50",
        offColor: parsed.offColor || "#E53935",
        knobColor: parsed.knobColor || "#ffffff",
        fontSize: clamp(parsed.fontSize || 14, 10, 24),
        toggleSize: clamp(parsed.toggleSize || 1.0, 0.5, 2.5),
    };
}

function setNodeSettings(node, settings) {
    const sw = node.widgets?.find(w => w.name === "_xz_settings");
    if (sw) sw.value = JSON.stringify(settings);
}

// 动态测量标签文字所需的最小节点宽度
let _measureCanvas = null;
function getMeasureCtx() {
    if (!_measureCanvas) {
        _measureCanvas = document.createElement("canvas");
        _measureCanvas.width = 1;
        _measureCanvas.height = 1;
    }
    return _measureCanvas.getContext("2d");
}

function calcMinNodeWidth(settings) {
    const ctx = getMeasureCtx();
    const scale = settings.toggleSize || 1.0;
    const fontSize = clamp(settings.fontSize || 14, 10, 24);
    const toggleW = 56 * scale;

    let maxLabelW = 0;
    ctx.font = `${fontSize}px "Microsoft YaHei", "PingFang SC", Arial, sans-serif`;
    if (settings.trueLabel) {
        maxLabelW = Math.max(maxLabelW, ctx.measureText(settings.trueLabel).width);
    }
    if (settings.falseLabel) {
        maxLabelW = Math.max(maxLabelW, ctx.measureText(settings.falseLabel).width);
    }

    // 布局: [左侧标签] + 间距8px + [开关] + 间距8px + [右侧标签]
    // 加上左右内边距各 16px
    if (maxLabelW > 0) {
        return Math.ceil(16 + maxLabelW + 8 + toggleW + 8 + maxLabelW + 16);
    }
    return Math.ceil(toggleW + 40);  // 无标签时的最小宽度
}

// ═══════════════════════════════════════════════
//  设置控制面板
// ═════════════════════════════════════════════

let _boolSettingsPanel = null;

function openBoolSettingsPanel(node) {
    // 关闭已有面板
    if (_boolSettingsPanel) {
        _boolSettingsPanel.remove();
        _boolSettingsPanel = null;
    }

    const s = getNodeSettings(node);
    const panel = document.createElement("div");
    panel.className = "xzg-bool-settings-panel";
    Object.assign(panel.style, {
        position: "fixed",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        width: "340px",
        background: "#1e1e1e",
        borderRadius: "12px",
        boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
        zIndex: "10000",
        fontFamily: '"Microsoft YaHei", "PingFang SC", Arial, sans-serif',
        color: "#ddd",
        overflow: "hidden",
    });

    panel.innerHTML = `
        <div id="xzg-bool-header" style="padding:16px 20px;background:#2a2a2a;border-bottom:1px solid #3a3a3a;display:flex;align-items:center;justify-content:space-between;cursor:move">
            <span style="font-size:15px;font-weight:bold;color:#eee">⚙ 小珠光布尔设置</span>
            <button id="xzg-bool-close" style="background:none;border:none;color:#888;font-size:20px;cursor:pointer;padding:0 4px;line-height:1">✕</button>
        </div>
        <div style="padding:18px 20px;display:flex;flex-direction:column;gap:14px">
            <!-- 按钮大小 -->
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
                <label style="font-size:12px;color:#aaa;white-space:nowrap">按钮大小</label>
                <input type="range" id="xzg-toggle-size" min="50" max="250" value="${Math.round(s.toggleSize * 100)}" style="flex:1;accent-color:#4CAF50" />
                <span id="xzg-toggle-val" style="font-size:12px;color:#888;width:42px;text-align:right">${s.toggleSize.toFixed(1)}x</span>
            </div>
            <!-- 开启轨道色 -->
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
                <label style="font-size:12px;color:#aaa;white-space:nowrap">开启轨道色</label>
                <input type="color" id="xzg-on-color" value="${s.onColor}" style="width:48px;height:30px;border:none;border-radius:4px;cursor:pointer;background:transparent" />
            </div>
            <!-- 关闭轨道色 -->
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
                <label style="font-size:12px;color:#aaa;white-space:nowrap">关闭轨道色</label>
                <input type="color" id="xzg-off-color" value="${s.offColor}" style="width:48px;height:30px;border:none;border-radius:4px;cursor:pointer;background:transparent" />
            </div>
            <!-- 手柄颜色 -->
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
                <label style="font-size:12px;color:#aaa;white-space:nowrap">手柄颜色</label>
                <input type="color" id="xzg-knob-color" value="${s.knobColor}" style="width:48px;height:30px;border:none;border-radius:4px;cursor:pointer;background:transparent" />
            </div>
            <!-- 开启标签 -->
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
                <label style="font-size:12px;color:#aaa;white-space:nowrap">开启标签</label>
                <input id="xzg-true-label" value="${s.trueLabel}" placeholder="留空不显示" style="flex:1;padding:6px 10px;border-radius:6px;border:1px solid #444;background:#222;color:#ddd;font-size:13px" />
            </div>
            <!-- 关闭标签 -->
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
                <label style="font-size:12px;color:#aaa;white-space:nowrap">关闭标签</label>
                <input id="xzg-false-label" value="${s.falseLabel}" placeholder="留空不显示" style="flex:1;padding:6px 10px;border-radius:6px;border:1px solid #444;background:#222;color:#ddd;font-size:13px" />
            </div>
            <!-- 标签字号 -->
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
                <label style="font-size:12px;color:#aaa;white-space:nowrap">标签字号</label>
                <input type="range" id="xzg-font-size" min="10" max="24" value="${s.fontSize}" style="flex:1;accent-color:#4CAF50" />
                <span id="xzg-font-val" style="font-size:12px;color:#888;width:28px;text-align:right">${s.fontSize}</span>
            </div>
        </div>
        <div style="padding:12px 20px;display:flex;gap:10px;justify-content:flex-end;border-top:1px solid #333">
            <button id="xzg-bool-cancel" style="padding:7px 18px;border-radius:6px;border:1px solid #444;background:#222;color:#aaa;cursor:pointer;font-size:13px">取消</button>
            <button id="xzg-bool-apply" style="padding:7px 18px;border-radius:6px;border:1px solid #4CAF50;background:#4CAF50;color:#fff;cursor:pointer;font-size:13px;font-weight:bold">应用</button>
        </div>
    `;

    document.body.appendChild(panel);
    _boolSettingsPanel = panel;

    // 拖动功能
    let dragging = false, dragOffX = 0, dragOffY = 0;
    const header = panel.querySelector("#xzg-bool-header");
    header.addEventListener("mousedown", (e) => {
        if (e.target.tagName === "BUTTON") return;
        // 首次拖动：从居中模式切换到 left/top 绝对定位
        if (panel.style.transform) {
            const rect = panel.getBoundingClientRect();
            panel.style.left = rect.left + "px";
            panel.style.top = rect.top + "px";
            panel.style.transform = "none";
        }
        dragging = true;
        dragOffX = e.clientX - panel.offsetLeft;
        dragOffY = e.clientY - panel.offsetTop;
        e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
        if (!dragging) return;
        const nx = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, e.clientX - dragOffX));
        const ny = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, e.clientY - dragOffY));
        panel.style.left = nx + "px";
        panel.style.top = ny + "px";
        panel.style.transform = "none";
        e.preventDefault();
    });
    document.addEventListener("mouseup", () => { dragging = false; });

    // 按钮大小滑块实时预览
    const toggleSlider = panel.querySelector("#xzg-toggle-size");
    const toggleVal = panel.querySelector("#xzg-toggle-val");
    toggleSlider.addEventListener("input", () => {
        toggleVal.textContent = (toggleSlider.value / 100).toFixed(1) + "x";
        let ns = getNodeSettings(node);
        ns.toggleSize = clamp(parseInt(toggleSlider.value) / 100, 0.5, 2.5);
        setNodeSettings(node, ns);
        node.size[0] = Math.max(calcMinNodeWidth(ns), node.size[0]);
        node.setDirtyCanvas(true, true);
    });

    // 关闭
    const closePanel = () => { panel.remove(); _boolSettingsPanel = null; };
    panel.querySelector("#xzg-bool-close").addEventListener("click", closePanel);
    panel.querySelector("#xzg-bool-cancel").addEventListener("click", closePanel);

    // 实时预览：从面板读取所有设置并立即应用到节点
    function applyPreview() {
        let ns = getNodeSettings(node);
        ns.toggleSize = clamp(parseInt(toggleSlider.value) / 100, 0.5, 2.5);
        ns.onColor = panel.querySelector("#xzg-on-color").value;
        ns.offColor = panel.querySelector("#xzg-off-color").value;
        ns.knobColor = panel.querySelector("#xzg-knob-color").value;
        ns.trueLabel = panel.querySelector("#xzg-true-label").value;
        ns.falseLabel = panel.querySelector("#xzg-false-label").value;
        ns.fontSize = clamp(parseInt(panel.querySelector("#xzg-font-size").value), 10, 24);
        setNodeSettings(node, ns);
        // 同步更新节点宽度以适配标签文字
        const newW = calcMinNodeWidth(ns);
        if (node.size[0] < newW) node.size[0] = newW;
        node.size[1] = Math.round(28 * ns.toggleSize + 8);
        node.setDirtyCanvas(true, true);
    }

    // 颜色选择器实时预览
    ["xzg-on-color", "xzg-off-color", "xzg-knob-color"].forEach(id => {
        const el = panel.querySelector(`#${id}`);
        if (el) el.addEventListener("input", applyPreview);
    });

    // 标签输入实时预览
    ["xzg-true-label", "xzg-false-label"].forEach(id => {
        const el = panel.querySelector(`#${id}`);
        if (el) el.addEventListener("input", applyPreview);
    });

    // 字号滑块实时预览
    const fontSlider = panel.querySelector("#xzg-font-size");
    const fontVal = panel.querySelector("#xzg-font-val");
    fontSlider.addEventListener("input", () => { fontVal.textContent = fontSlider.value; applyPreview(); });

    // 应用按钮（保留用于确认，但实际已实时生效）
    panel.querySelector("#xzg-bool-apply").addEventListener("click", () => {
        closePanel();
    });

    // 点击外部关闭
    setTimeout(() => {
        const onDocClick = (e) => {
            if (!panel.contains(e.target)) {
                document.removeEventListener("mousedown", onDocClick);
                closePanel();
            }
        };
        document.addEventListener("mousedown", onDocClick);
    }, 0);
}

app.registerExtension({
    name: "ComfyUI.xiaozhuguang.boolean_selector",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "XiaozhuguangBooleanSelector") return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (origOnNodeCreated) origOnNodeCreated.apply(this, arguments);

            this.resizable = false;
            this.flags = this.flags || {};
            this.flags.resizable = false;

            const settingsWidget = this.widgets?.find(w => w.name === "_xz_settings");
            if (settingsWidget) settingsWidget.hidden = true;

            const boolWidget = this.widgets?.find(w => w.name === "布尔值");
            if (!boolWidget) return;
            const widgetIndex = this.widgets.indexOf(boolWidget);

            boolWidget.type = "hidden";
            boolWidget.hidden = true;
            boolWidget.computeSize = () => [0, 0];

            let currentValue = !!boolWidget.value;
            const node = this;

            // 自定义 Canvas 绘制的开关 UI
            node.addCustomWidget({
                name: "xzg_bool_ui",
                type: "xzg_boolean",

                draw(ctx, node, W, y, H) {
                    const s = getNodeSettings(node);
                    const scale = s.toggleSize;

                    const toggleW = 56 * scale;
                    const toggleH = 28 * scale;
                    const toggleR = toggleH / 2;
                    const knobR = toggleH * 0.38;
                    const pad = 4;
                    const cx = W / 2;
                    const cy = y + pad + toggleH / 2;
                    const tx = cx - toggleW / 2;
                    const ty = cy - toggleH / 2;

                    // 开关背景轨道
                    ctx.save();

                    // 轨道背景
                    const bgGrad = ctx.createLinearGradient(tx, ty, tx, ty + toggleH);
                    if (currentValue) {
                        bgGrad.addColorStop(0, s.onColor);
                        bgGrad.addColorStop(1, s.onColor);
                    } else {
                        bgGrad.addColorStop(0, s.offColor);
                        bgGrad.addColorStop(1, s.offColor);
                    }
                    ctx.fillStyle = bgGrad;
                    rrect(ctx, tx, ty, toggleW, toggleH, toggleR);
                    ctx.fill();

                    // 轨道边框
                    ctx.strokeStyle = currentValue ? s.onColor : "#555";
                    ctx.lineWidth = 1;
                    rrect(ctx, tx, ty, toggleW, toggleH, toggleR);
                    ctx.stroke();

                    // 滑块圆点
                    const knobX = currentValue ? (tx + toggleW - toggleR - 3) : (tx + toggleR + 3);
                    const knobY = cy;

                    // 滑块阴影
                    ctx.shadowColor = "rgba(0,0,0,0.35)";
                    ctx.shadowBlur = 4;
                    ctx.shadowOffsetX = 0;
                    ctx.shadowOffsetY = 1;
                    ctx.fillStyle = s.knobColor;
                    ctx.beginPath();
                    ctx.arc(knobX, knobY, knobR, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.shadowColor = "transparent";
                    ctx.shadowBlur = 0;

                    // 滑块内图标（✓ 或 ✗）
                    const iconSize = knobR * 0.85;
                    ctx.fillStyle = currentValue ? s.onColor : "#999";
                    ctx.font = `bold ${iconSize}px "Microsoft YaHei", Arial, sans-serif`;
                    ctx.textAlign = "center";
                    ctx.textBaseline = "middle";
                    ctx.fillText(currentValue ? "✓" : "✗", knobX, knobY + 1);

                    // 自定义标签文字（仅用户设置时显示）
                    if (s.trueLabel || s.falseLabel) {
                        const onLabel = s.trueLabel || "";
                        const offLabel = s.falseLabel || "";
                        const labelY = cy;

                        // 关闭标签在左侧
                        if (offLabel) {
                            ctx.fillStyle = currentValue ? "#555" : s.offColor;
                            ctx.font = `${s.fontSize}px "Microsoft YaHei", "PingFang SC", Arial, sans-serif`;
                            ctx.textAlign = "right";
                            ctx.textBaseline = "middle";
                            ctx.fillText(offLabel, tx - 8, labelY);
                        }

                        // 开启标签在右侧
                        if (onLabel) {
                            ctx.fillStyle = currentValue ? s.onColor : "#555";
                            ctx.font = `${s.fontSize}px "Microsoft YaHei", "PingFang SC", Arial, sans-serif`;
                            ctx.textAlign = "left";
                            ctx.textBaseline = "middle";
                            ctx.fillText(onLabel, tx + toggleW + 8, labelY);
                        }
                    }

                    ctx.restore();

                    // 存储高度供 computeSize 使用
                    node._xzgBoolH = toggleH + pad * 2;
                },

                mouse(event, pos, node) {
                    if (event.type === "wheel") return false;
                    if (event.type !== "mousedown" && event.type !== "pointerdown") return false;
                    if (event.button !== 0 && event.type === "mousedown") return false;

                    const s = getNodeSettings(node);
                    const W = node.size[0];
                    const scale = s.toggleSize;
                    const toggleW = 56 * scale;
                    const toggleH = 28 * scale;
                    const pad = 4;
                    const widgetH = toggleH + pad * 2;
                    const cx = W / 2;
                    const cy = (this.y || 0) + widgetH / 2;
                    const tx = cx - toggleW / 2;

                    // 点击检测：开关区域
                    const hitArea = {
                        x: tx - 10,
                        y: (this.y || 0),
                        w: toggleW + 20,
                        h: widgetH
                    };

                    if (pos[0] >= hitArea.x && pos[0] <= hitArea.x + hitArea.w &&
                        pos[1] >= hitArea.y && pos[1] <= hitArea.y + hitArea.h) {
                        currentValue = !currentValue;
                        boolWidget.value = currentValue;
                        if (boolWidget.callback) {
                            try { boolWidget.callback(currentValue); } catch (e) {}
                        }
                        node.setDirtyCanvas(true, true);
                        return true;
                    }
                    return false;
                },

                computeSize(width) {
                    const s = getNodeSettings(node);
                    const minWidth = calcMinNodeWidth(s);
                    const h = Math.round(28 * s.toggleSize + 8);
                    return [Math.max(width, minWidth), h];
                },
            });

            // 重新排列 widget
            const custom = this.widgets.pop();
            this.widgets.splice(widgetIndex + 1, 0, custom);

            // 右键菜单：打开设置面板
            chainCallback(this, "getExtraMenuOptions", function(_, options) {
                options.push(null); // 分隔线
                options.push({
                    content: "⚙ <span style='color:#FFD700'>小珠光布尔设置</span>",
                    callback: () => openBoolSettingsPanel(node),
                });
            });

            // 设置节点尺寸（自适应高度）
            const s0 = getNodeSettings(node);
            this.size[0] = Math.max(calcMinNodeWidth(s0), this.size[0]);
            this.size[1] = Math.round(28 * s0.toggleSize + 8);
        };
    },
});

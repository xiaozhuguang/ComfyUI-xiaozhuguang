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
    s.btnWidth = clamp(s.btnWidth, 55, 300);
    s.btnHeight = clamp(s.btnHeight, 30, 80);
    s.fontSize = clamp(s.fontSize, 10, 24);
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

function getButtonRects(y, W, settings) {
    const gap = settings.btnGap;
    const btnH = settings.btnHeight;
    const rects = [];
    const startY = y + 5;

    const falseW = getButtonWidth(false, settings);
    const trueW = getButtonWidth(true, settings);
    const totalW = falseW + gap + trueW;
    const startX = Math.max(5, (W - totalW) / 2);

    const invert = !!settings.invert;

    if (!invert) {
        rects[0] = {
            x: startX,
            y: startY,
            w: falseW,
            h: btnH,
            value: false,
        };
        rects[1] = {
            x: startX + falseW + gap,
            y: startY,
            w: trueW,
            h: btnH,
            value: true,
        };
    } else {
        rects[0] = {
            x: startX,
            y: startY,
            w: trueW,
            h: btnH,
            value: true,
        };
        rects[1] = {
            x: startX + trueW + gap,
            y: startY,
            w: falseW,
            h: btnH,
            value: false,
        };
    }

    const contentW = totalW;
    const contentH = btnH;
    return { rects, contentW, contentH };
}

const DEFAULT_SETTINGS = {
    labels: { false: "False", true: "True" },
    colors: { color1: "#000000", color2: "#FF0000", color3: "#000000", direction: "180deg" },
    btnWidth: 60,
    btnHeight: 30,
    fontSize: 12,
    btnGap: 4,
    fontColor: "#aaa",
    inactiveColor: "#2a2a2a",
    widths: {},
    invert: false,
};

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

    const rect = app.canvas.canvas.getBoundingClientRect();
    const nodeScale = app.canvas.ds.scale;
    const nodeLeft = (node.pos[0] + app.canvas.ds.offset[0]) * nodeScale + rect.left;
    const nodeTop = (node.pos[1] + app.canvas.ds.offset[1]) * nodeScale + rect.top;
    const nodeWidth = (node.size?.[0] || 200) * nodeScale;

    const dlgWidth = 320;
    const dlgHeight = 560;
    const gap = 15;

    let dlgLeft = nodeLeft + nodeWidth + gap;
    let dlgTop = nodeTop - 110;

    if (dlgLeft + dlgWidth > rect.right - 10) dlgLeft = nodeLeft - dlgWidth - gap;
    if (dlgLeft < rect.left + 10) dlgLeft = rect.left + 10;
    if (dlgTop < rect.top + 10) dlgTop = rect.top + 10;
    if (dlgTop + dlgHeight > rect.bottom - 10) dlgTop = rect.bottom - dlgHeight - 10;

    const dialog = document.createElement("div");
    dialog.className = "xzg-bs-dialog";
    dialog.style.left = dlgLeft + "px";
    dialog.style.top = dlgTop + "px";
    dialog.style.width = dlgWidth + "px";

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

    function mkRange(min, max, step, value) {
        const wrap = document.createElement("div");
        wrap.style.cssText = "flex:1;display:flex;align-items:center;gap:8px;";
        const inp = document.createElement("input");
        inp.className = "xzg-bs-range";
        inp.type = "range";
        inp.min = min; inp.max = max; inp.step = step; inp.value = value;
        const val = document.createElement("span");
        val.className = "xzg-bs-val";
        val.textContent = value;
        wrap.append(inp, val);
        return { wrap, inp, val };
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

    const btnHeightCtrl = mkRange(30, 80, 1, s.btnHeight);
    addRow(xzgT('按钮高度','Button Height'), btnHeightCtrl.wrap);

    const falseWidthCtrl = mkRange(55, 300, 1, falseWidth);
    addRow(xzgT('左标签宽度','Left Label Width'), falseWidthCtrl.wrap);

    const trueWidthCtrl = mkRange(55, 300, 1, trueWidth);
    addRow(xzgT('右标签宽度','Right Label Width'), trueWidthCtrl.wrap);

    const gapCtrl = mkRange(0, 20, 1, s.btnGap);
    addRow(xzgT('按钮间距','Button Gap'), gapCtrl.wrap);

    const fontSizeCtrl = mkRange(10, 24, 1, s.fontSize);
    addRow(xzgT('标签字号','Label Font Size'), fontSizeCtrl.wrap);

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

    document.body.appendChild(dialog);
    _boolSettingsPanel = dialog;

    let dragging = false, dragOffX = 0, dragOffY = 0;
    title.addEventListener("mousedown", (e) => {
        if (e.target.tagName === "BUTTON") return;
        dragging = true;
        dragOffX = e.clientX - dialog.offsetLeft;
        dragOffY = e.clientY - dialog.offsetTop;
        e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
        if (!dragging) return;
        const nx = Math.max(0, Math.min(window.innerWidth - dialog.offsetWidth, e.clientX - dragOffX));
        const ny = Math.max(0, Math.min(window.innerHeight - dialog.offsetHeight, e.clientY - dragOffY));
        dialog.style.left = nx + "px";
        dialog.style.top = ny + "px";
        e.preventDefault();
    });
    document.addEventListener("mouseup", () => { dragging = false; });

    const colorInputs = color1Row.querySelectorAll('input[type="color"]');
    const color1Inp = colorInputs[0];
    const color2Inp = colorInputs[1];
    const color3Inp = colorInputs[2];

    let _initializing = true;

    function applyPreview() {
        if (_initializing) return;
        let ns = getNodeSettings(node, DEFAULT_SETTINGS);
        ns.btnHeight = clamp(parseInt(btnHeightCtrl.inp.value), 30, 80);
        const falseW = clamp(parseInt(falseWidthCtrl.inp.value), 55, 300);
        const trueW = clamp(parseInt(trueWidthCtrl.inp.value), 55, 300);
        ns.widths = { false: falseW, true: trueW };
        ns.btnGap = clamp(parseInt(gapCtrl.inp.value), 0, 20);
        ns.fontSize = clamp(parseInt(fontSizeCtrl.inp.value), 10, 24);
        ns.labels = {
            false: falseLabelInp.value,
            true: trueLabelInp.value,
        };
        ns.fontColor = fontColorBtn._input.value;
        ns.inactiveColor = inactiveColorBtn._input.value;
        ns.colors = {
            color1: color1Inp.value,
            color2: color2Inp.value,
            color3: color3Inp.value,
            direction: dirSel.value,
        };
        ns.invert = !!s.invert;
        setNodeSettings(node, ns);
        const { contentW, contentH } = getButtonRects(0, node.size[0], ns);
        node.size[0] = Math.max(120, contentW + 20);
        node.size[1] = Math.max(60, contentH + 30);
        node.setDirtyCanvas(true, true);
    }

    [btnHeightCtrl, falseWidthCtrl, trueWidthCtrl, gapCtrl, fontSizeCtrl].forEach(ctrl => {
        updateRangeFill(ctrl.inp);
        ctrl.inp.addEventListener("input", () => {
            ctrl.val.textContent = ctrl.inp.value;
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

    _initializing = false;

    const closePanel = (apply) => {
        if (!apply) {
            setNodeSettings(node, origSettings);
            node.size[0] = origSize[0];
            node.size[1] = origSize[1];
            node.setDirtyCanvas(true, true);
        }
        dialog.remove();
        _boolSettingsPanel = null;
    };
    title.querySelector(".xzg-bs-close").addEventListener("click", () => closePanel(true));
    cancelBtn.addEventListener("click", () => closePanel(false));
    applyBtn.addEventListener("click", () => closePanel(true));
    resetBtn.addEventListener("click", () => {
        setNodeSettings(node, JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
        dialog.remove();
        openBoolSettingsPanel(node);
    });

    setTimeout(() => {
        const onDocClick = (e) => {
            if (!dialog.contains(e.target)) {
                document.removeEventListener("mousedown", onDocClick);
                closePanel(false);
            }
        };
        document.addEventListener("mousedown", onDocClick);
    }, 0);
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

            this.resizable = false;
            this.flags = this.flags || {};
            this.flags.resizable = false;

            const settingsWidget = this.widgets?.find(w => w.name === "_xz_settings");
            if (settingsWidget) settingsWidget.hidden = true;

            const boolWidget = this.widgets?.find(w => w.name === "boolean_value");
            if (!boolWidget) return;
            const widgetIndex = this.widgets.indexOf(boolWidget);

            boolWidget.type = "hidden";
            boolWidget.hidden = true;
            boolWidget.computeSize = () => [0, 0];

            const node = this;

            node.addCustomWidget({
                name: "xzg_bool_ui",
                type: "xzg_boolean",

                draw(ctx, node, W, y, H) {
                    const settings = getNodeSettings(node, DEFAULT_SETTINGS);
                    const { rects, contentH } = getButtonRects(y, W, settings);
                    const currentValue = !!boolWidget.value;

                    for (let i = 0; i < rects.length; i++) {
                        const r = rects[i];
                        if (!r) continue;
                        const isActive = currentValue === r.value;

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

                        const label = getDisplayLabel(r.value, settings.labels);
                        ctx.fillStyle = settings.fontColor || "#aaa";
                        ctx.font = `${settings.fontSize}px "Microsoft YaHei", "微软雅黑", "PingFang SC", "Hiragino Sans GB", "SimHei", Arial, sans-serif`;
                        ctx.textAlign = "center";
                        ctx.textBaseline = "middle";
                        ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2);
                        ctx.restore();
                    }

                    node._xzgBoolH = contentH + 20;
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
                        if (!r) continue;
                        if (pos[0] >= r.x && pos[0] <= r.x + r.w &&
                            pos[1] >= r.y && pos[1] <= r.y + r.h) {
                            boolWidget.value = r.value;
                            if (boolWidget.callback) {
                                try { boolWidget.callback(r.value); } catch (e) {}
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
                    return [width, Math.max(60, contentH + 30)];
                },
            });

            const custom = this.widgets.pop();
            this.widgets.splice(widgetIndex + 1, 0, custom);

            chainCallback(this, "getExtraMenuOptions", function(_, options) {
                options.splice(0, 0, null, {
                    content: "⚙ <span style='color:#FFD700'>" + xzgT('小珠光布尔设置','Xiaozhuguang Boolean Settings') + "</span>",
                    callback: () => openBoolSettingsPanel(node),
                });
            });

            const settings = getNodeSettings(this, DEFAULT_SETTINGS);
            const { contentW, contentH } = getButtonRects(0, this.size[0], settings);
            this.size[0] = Math.max(120, contentW + 20);
            this.size[1] = Math.max(60, contentH + 30);
        };
    },
});

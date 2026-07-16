import { app } from "../../scripts/app.js";
import { xzgT } from "./xzg_i18n.js";


// ═══════════════════════════════════════════════
//  小珠光万能滑条 · 复刻孤海万能滑条
//  Canvas 绘制版：缩放到任意大小都始终可见
// ═══════════════════════════════════════════════


(function () {
    const ID = "xzg-us-css";
    if (document.getElementById(ID)) return;
    const s = document.createElement("style");
    s.id = ID;
    s.textContent = `
.xzg-us-dialog{position:fixed;z-index:10000;background:#2a2a2a;border:1px solid #444;border-radius:8px;padding:16px;min-width:280px;font-family:Arial,sans-serif;color:#fff;box-shadow:0 4px 20px rgba(0,0,0,.5)}
.xzg-us-ptitle{font-size:14px;font-weight:700;color:#e8c547;margin-bottom:16px;cursor:move;user-select:none;display:flex;align-items:center;gap:8px;padding-bottom:8px;border-bottom:1px solid #3a3a3a}
.xzg-us-row{display:flex;align-items:center;gap:10px;margin-bottom:12px}
.xzg-us-rlbl{width:60px;font-size:12px;color:#aaa;flex-shrink:0}
.xzg-us-inp{flex:1;background:#1a1a1a;border:1px solid #444;border-radius:4px;padding:6px 8px;color:#fff;font-size:12px;outline:none;font-family:inherit}
.xzg-us-inp::-webkit-outer-spin-button,.xzg-us-inp::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.xzg-us-inp[type=number]{-moz-appearance:textfield}
.xzg-us-inp:focus{border-color:#666}
.xzg-us-clrbtn{width:28px;height:24px;border-radius:4px;border:1px solid #555;background:#2a2a2c;cursor:pointer;flex-shrink:0}
.xzg-us-range{flex:1;accent-color:#555;cursor:pointer}
.xzg-us-val{min-width:24px;text-align:right;font-size:11px;color:#ccc;font-family:monospace}
.xzg-us-btns{display:flex;gap:8px;margin-top:16px}
.xzg-us-btn{flex:1;padding:8px;border:none;border-radius:4px;color:#fff;font-size:12px;cursor:pointer;font-family:inherit}
.xzg-us-bx{background:#444}
.xzg-us-bx:hover{background:#555}
.xzg-us-bok{background:#444;font-weight:700}
.xzg-us-bok:hover{background:#555}
.xzg-us-radio-wrap{flex:1;display:flex;gap:4px;align-items:center}
.xzg-us-radio-label{flex:1;display:flex;align-items:center;justify-content:center;gap:4px;cursor:pointer;color:#fff;font-size:12px;padding:6px;border-radius:4px;background:#3a3a3a;border:none;transition:background .15s}
.xzg-us-radio-label:hover{background:#444}
.xzg-us-radio-label input[type="radio"]{display:none}
.xzg-us-radio-label.xzg-us-radio-checked{background:#555;font-weight:700}
.xzg-us-snap-grid{display:flex;flex-wrap:wrap;gap:4px;flex:1}
.xzg-us-snap-inp{width:40px;padding:4px 2px;background:#1a1a1a;border:1px solid #444;border-radius:4px;color:#fff;font-size:11px;outline:none;text-align:center;-moz-appearance:textfield}
.xzg-us-snap-inp::-webkit-outer-spin-button,.xzg-us-snap-inp::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.xzg-us-color-picker{position:fixed;z-index:10001;background:#2a2a2a;border:1px solid #444;border-radius:8px;padding:10px;width:200px;box-shadow:0 4px 20px rgba(0,0,0,.5);user-select:none}
    `;
    document.head.appendChild(s);
})();

// ── 工具函数 ──────────────────────────────────
const pct   = (v, mn, mx) => { const r = mx - mn; return r > 0 ? ((v - mn) / r) * 100 : 0; };
const clamp = (v, mn, mx) => Math.max(mn, Math.min(mx, v));
const snap  = (v, mn, step) => step > 0 ? Math.round((v - mn) / step) * step + mn : v;
const fmt   = (v, isInt) => isInt ? String(Math.round(v)) : v.toFixed(2);
function castVal(v, isInt) {
    if (isInt) return parseInt(Math.round(v), 10);
    return parseFloat(v.toFixed(2));
}

// ── 统一的值计算函数，先 snap 再按类型取整 ──
function calcValue(v, mn, mx, step, isInt) {
    v = snap(v, mn, step);
    v = clamp(v, mn, mx);
    return castVal(v, isInt);
}

function snapToSnaps(v, snaps) {
    if (!snaps || snaps.length === 0) return v;
    let nearest = snaps[0];
    let minDist = Math.abs(v - nearest);
    for (let i = 1; i < snaps.length; i++) {
        const dist = Math.abs(v - snaps[i]);
        if (dist < minDist) { minDist = dist; nearest = snaps[i]; }
    }
    return nearest;
}

// ── HSL 颜色选择器工具 ───────────────────────
function hexToHsl(hex) {
    let r = parseInt(hex.slice(1, 3), 16) / 255;
    let g = parseInt(hex.slice(3, 5), 16) / 255;
    let b = parseInt(hex.slice(5, 7), 16) / 255;
    let max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;
    if (max === min) { h = s = 0; }
    else {
        let d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }
        h *= 60;
    }
    return { h: h, s: s * 100, l: l * 100 };
}

function hslToHex(h, s, l) {
    h /= 360; s /= 100; l /= 100;
    let r, g, b;
    if (s === 0) { r = g = b = l; }
    else {
        const hue2rgb = (p, q, t) => {
            if (t < 0) t += 1;
            if (t > 1) t -= 1;
            if (t < 1/6) return p + (q - p) * 6 * t;
            if (t < 1/2) return q;
            if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
            return p;
        };
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        r = hue2rgb(p, q, h + 1/3);
        g = hue2rgb(p, q, h);
        b = hue2rgb(p, q, h - 1/3);
    }
    const toHex = x => {
        const hex = Math.round(x * 255).toString(16);
        return hex.length === 1 ? '0' + hex : hex;
    };
    return '#' + toHex(r) + toHex(g) + toHex(b);
}

function hslToHsv(h, s, l) {
    s = s / 100; l = l / 100;
    const v = l + s * Math.min(l, 1 - l);
    const hsvS = v === 0 ? 0 : 2 * (1 - l / v);
    return { h: h, s: hsvS * 100, v: v * 100 };
}

function hsvToHsl(h, s, v) {
    s = s / 100; v = v / 100;
    const l = v * (1 - s / 2);
    const hslS = v === 0 ? 0 : (v - l) / Math.min(l, 1 - l);
    return { h: h, s: hslS * 100, l: l * 100 };
}

// ── Canvas 圆角矩形 ──────────────────────────
function rrect(ctx, x, y, w, h, r) {
    if (w < 0) w = 0;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

// ── updateVis ────────────────────────────────
function updateVis(n) {
    n.setDirtyCanvas(true, true);
}

// ── syncWidgetType ───────────────────────────
function syncWidgetType(node) {
    const g = node._xzgUs;
    if (!g || !g.widget) return;
    const p     = node.properties;
    const isInt = p.sliderType === "int";
    g.widget.type = isInt ? "INT" : "FLOAT";
    let v = g.widget.value;
    v = clamp(v, p.sliderMin, p.sliderMax);
    v = isInt ? Math.round(v) : parseFloat(v.toFixed(2));
    g.widget.value = v;
}

// ── syncOutputType ───────────────────────────
function syncOutputType(node) {
    const g = node._xzgUs;
    if (!g || !g.outputTypeWidget) return;
    const isInt = node.properties.sliderType === "int";
    g.outputTypeWidget.value = isInt ? "int" : "float";
}

// ── 清理拖拽状态 ─────────────────────────────
function cleanupDrag(node) {
    const g = node._xzgUs;
    if (!g) return;
    g._dragging = false;
    if (g._docCleanup) {
        g._docCleanup();
        g._docCleanup = null;
    }
}

// ── showSettings ─────────────────────────────
function showSettings(node) {
    cleanupDrag(node);
    document.querySelectorAll(".xzg-us-dialog, .xzg-us-color-picker").forEach((e) => e.remove());
    const p = node.properties;

    // 备份原始值，取消时恢复
    const origValueColor     = p.valueColor;
    const origTrackColor     = p.trackColor;
    const origThumbColor     = p.thumbColor;
    const origValueOffsetXPct= p.valueOffsetXPct;
    const origValueOffset    = p.valueOffset;
    const origFontSize       = p.fontSize;
    const origTrackHeight    = p.trackHeight;
    const origThumbSize      = p.thumbSize;
    const origUseSnaps       = p.useSnaps;
    const origSnaps          = Array.isArray(p.snaps) ? [...p.snaps] : [];
    const origSnapTickColor  = p.snapTickColor;
    const origSnapTickSize   = p.snapTickSize;

    const rect = app.canvas.canvas.getBoundingClientRect();
    const nodeScale = app.canvas.ds.scale;
    const nodeLeft = (node.pos[0] + app.canvas.ds.offset[0]) * nodeScale + rect.left;
    const nodeTop = (node.pos[1] + app.canvas.ds.offset[1]) * nodeScale + rect.top;
    const nodeWidth = (node.size?.[0] || 300) * nodeScale;
    const nodeHeight = (node.size?.[1] || 35) * nodeScale;

    const dlgWidth = 340;
    const dlgHeight = 620;
    const gap = 15;

    let dlgLeft = nodeLeft + nodeWidth + gap;
    let dlgTop = nodeTop - 10;

    if (dlgLeft + dlgWidth > rect.right - 10) dlgLeft = nodeLeft - dlgWidth - gap;
    if (dlgLeft < rect.left + 10) dlgLeft = rect.left + 10;
    if (dlgTop < rect.top + 10) dlgTop = rect.top + 10;
    if (dlgTop + dlgHeight > rect.bottom - 10) dlgTop = rect.bottom - dlgHeight - 10;

    const dialog = document.createElement("div");
    dialog.className = "xzg-us-dialog";

    const title = document.createElement("div");
    title.className = "xzg-us-ptitle";
    title.innerHTML = `<span>⚙️</span><span>${xzgT('小珠光万能滑条 设置','Xiaozhuguang Universal Slider Settings')}</span>`;
    dialog.appendChild(title);

    function addRow(labelText, control) {
        const r = document.createElement("div");
        r.className = "xzg-us-row";
        const l = document.createElement("label");
        l.className = "xzg-us-rlbl";
        l.textContent = labelText;
        r.append(l, control);
        dialog.appendChild(r);
        return r;
    }

    function mkInp(type, value, attrs) {
        const i = document.createElement("input");
        i.className = "xzg-us-inp";
        i.type = type;
        if (value !== undefined && value !== null) i.value = value;
        if (attrs) Object.entries(attrs).forEach(([k, v]) => i.setAttribute(k, v));
        return i;
    }

    function mkRange(min, max, step, value) {
        const wrap = document.createElement("div");
        wrap.style.cssText = "flex:1;display:flex;align-items:center;gap:8px;";
        const inp = document.createElement("input");
        inp.className = "xzg-us-range";
        inp.type = "range";
        inp.min = min; inp.max = max; inp.step = step; inp.value = value;
        const val = document.createElement("span");
        val.className = "xzg-us-val";
        val.textContent = value;
        wrap.append(inp, val);
        return { wrap, inp, val };
    }

    function mkClrBtn(color) {
        const btn = document.createElement("button");
        btn.className = "xzg-us-clrbtn";
        btn.type = "button";
        btn.style.background = color;
        return btn;
    }

    // 类型
    const radioWrap = document.createElement("div");
    radioWrap.className = "xzg-us-radio-wrap";
    let selectedType = p.sliderType;
    const typeLabels = [];
    function updateTypeUI(type) {
        selectedType = type;
        typeLabels.forEach(({ opt, label }) => {
            if (opt === type) label.classList.add("xzg-us-radio-checked");
            else label.classList.remove("xzg-us-radio-checked");
        });
    }
    ["int", "float"].forEach((opt) => {
        const label = document.createElement("label");
        label.className = "xzg-us-radio-label" + (p.sliderType === opt ? " xzg-us-radio-checked" : "");
        label.textContent = opt === "int" ? xzgT("整数","Integer") : xzgT("浮点","Float");
        label.addEventListener("click", () => updateTypeUI(opt));
        typeLabels.push({ opt, label });
        radioWrap.appendChild(label);
    });
    addRow(xzgT("类型","Type"), radioWrap);

    // 基本参数（最小值、最大值、步长放一行）
    const paramWrap = document.createElement("div");
    paramWrap.style.cssText = "display:flex;gap:6px;";
    function mkParamCell(labelText, value, attrs) {
        const cell = document.createElement("div");
        cell.style.cssText = "width:65px;display:flex;flex-direction:column;gap:2px;";
        const lbl = document.createElement("label");
        lbl.textContent = labelText;
        lbl.style.cssText = "font-size:10px;color:#aaa;text-align:center;";
        const inp = mkInp("number", value, attrs);
        inp.style.textAlign = "center";
        inp.style.padding = "4px 2px";
        inp.style.width = "100%";
        inp.style.boxSizing = "border-box";
        cell.append(lbl, inp);
        return { cell, inp };
    }
    const minCell = mkParamCell(xzgT("最小","Min"), p.sliderMin, { step: "any" });
    const maxCell = mkParamCell(xzgT("最大","Max"), p.sliderMax, { step: "any" });
    const stepCell = mkParamCell(xzgT("步长","Step"), p.sliderStep, { step: "any", min: "0.0001" });
    paramWrap.append(minCell.cell, maxCell.cell, stepCell.cell);
    addRow(xzgT("参数","Parameters"), paramWrap);

    // 数值水平位置 + 数值颜色
    const valueColorBtn = mkClrBtn(p.valueColor);
    const offsetXRow = document.createElement("div");
    offsetXRow.style.cssText = "flex:1;display:flex;align-items:center;gap:8px;";
    const offsetXCtrl = mkRange(0, 100, 1, p.valueOffsetXPct);
    offsetXRow.append(offsetXCtrl.wrap, valueColorBtn);
    addRow(xzgT("数值位置","Value Position"), offsetXRow);

    // 滑条/手柄样式
    const trackColorBtn = mkClrBtn(p.trackColor);
    const trackHRow = document.createElement("div");
    trackHRow.style.cssText = "flex:1;display:flex;align-items:center;gap:8px;";
    const trackHCtrl = mkRange(1, 20, 1, p.trackHeight);
    trackHRow.append(trackHCtrl.wrap, trackColorBtn);
    addRow(xzgT("滑条高度","Track Height"), trackHRow);
    const thumbColorBtn = mkClrBtn(p.thumbColor);
    const thumbSizeRow = document.createElement("div");
    thumbSizeRow.style.cssText = "flex:1;display:flex;align-items:center;gap:8px;";
    const thumbSizeCtrl = mkRange(6, 30, 1, p.thumbSize);
    thumbSizeRow.append(thumbSizeCtrl.wrap, thumbColorBtn);
    addRow(xzgT("手柄大小","Thumb Size"), thumbSizeRow);

    // 多值定格
    const snapRow = document.createElement("div");
    snapRow.className = "xzg-us-row";
    snapRow.style.alignItems = "flex-start";
    const snapLbl = document.createElement("label");
    snapLbl.className = "xzg-us-rlbl";
    snapLbl.textContent = xzgT("多值定格","Snap Values");
    snapLbl.style.marginTop = "4px";
    const snapWrap = document.createElement("div");
    snapWrap.style.cssText = "flex:1;display:flex;flex-direction:column;gap:8px;";
    const snapHeader = document.createElement("div");
    snapHeader.style.cssText = "display:flex;align-items:center;gap:8px;";
    const useSnapsCb = document.createElement("input");
    useSnapsCb.type = "checkbox";
    useSnapsCb.checked = p.useSnaps;
    useSnapsCb.style.cssText = "accent-color:#e8c547;cursor:pointer;";
    const snapHint = document.createElement("span");
    snapHint.textContent = xzgT("最多5个","Max 5");
    snapHint.style.cssText = "font-size:11px;color:#666;";
    snapHeader.append(useSnapsCb, snapHint);
    const snapList = document.createElement("div");
    snapList.className = "xzg-us-snap-grid";
    snapList.style.display = p.useSnaps ? "flex" : "none";
    const snapInputs = [];
    for (let i = 0; i < 5; i++) {
        const inp = document.createElement("input");
        inp.className = "xzg-us-snap-inp";
        inp.type = "number";
        inp.step = "any";
        inp.placeholder = `${xzgT("值","V")}${i+1}`;
        inp.value = (p.snaps && p.snaps[i] !== undefined) ? p.snaps[i] : "";
        snapList.appendChild(inp);
        snapInputs.push(inp);
    }
    const snapStyleRow = document.createElement("div");
    snapStyleRow.style.cssText = "display:" + (p.useSnaps ? "flex" : "none") + ";align-items:center;gap:10px;";
    const snapTickLbl = document.createElement("span");
    snapTickLbl.textContent = xzgT("刻度","Tick");
    snapTickLbl.style.cssText = "font-size:11px;color:#999;white-space:nowrap;";
    const snapColorBtn = mkClrBtn(p.snapTickColor);
    const snapSizeCtrl = mkRange(3, 14, 1, p.snapTickSize);
    snapStyleRow.append(snapTickLbl, snapColorBtn, snapSizeCtrl.wrap);

    snapWrap.append(snapHeader, snapList, snapStyleRow);
    snapRow.append(snapLbl, snapWrap);
    dialog.appendChild(snapRow);

    useSnapsCb.addEventListener("change", () => {
        const show = useSnapsCb.checked;
        snapList.style.display = show ? "flex" : "none";
        snapStyleRow.style.display = show ? "flex" : "none";
        p.useSnaps = show;
        updateVis(node);
    });

    snapInputs.forEach((inp, idx) => {
        inp.addEventListener("input", () => {
            const val = parseFloat(inp.value);
            const snaps = [];
            snapInputs.forEach((si) => {
                const sv = parseFloat(si.value);
                if (!isNaN(sv)) snaps.push(sv);
            });
            p.snaps = snaps;
            updateVis(node);
        });
    });

    // 按钮
    const btns = document.createElement("div");
    btns.className = "xzg-us-btns";
    const bCancel = document.createElement("button");
    bCancel.className = "xzg-us-btn xzg-us-bx";
    bCancel.type = "button";
    bCancel.textContent = xzgT("取消","Cancel");
    const bOk = document.createElement("button");
    bOk.className = "xzg-us-btn xzg-us-bok";
    bOk.type = "button";
    bOk.textContent = xzgT("确定","OK");
    btns.append(bCancel, bOk);
    dialog.appendChild(btns);

    document.body.appendChild(dialog);
    dialog.style.left = dlgLeft + "px";
    dialog.style.top = dlgTop + "px";

    // 拖拽
    let isDragging = false;
    let dragStartX = 0, dragStartY = 0, dlgStartX = 0, dlgStartY = 0;
    let mousedownOnHandle = false;
    title.addEventListener("mousedown", (e) => {
        isDragging = true;
        mousedownOnHandle = true;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        dlgStartX = dialog.offsetLeft;
        dlgStartY = dialog.offsetTop;
        e.preventDefault();
        e.stopPropagation();
    });
    function onDocMouseMove(e) {
        if (!isDragging) return;
        const dx = e.clientX - dragStartX;
        const dy = e.clientY - dragStartY;
        let newLeft = dlgStartX + dx;
        let newTop = dlgStartY + dy;
        newLeft = Math.max(0, Math.min(window.innerWidth - dialog.offsetWidth, newLeft));
        newTop = Math.max(0, Math.min(window.innerHeight - dialog.offsetHeight, newTop));
        dialog.style.left = newLeft + "px";
        dialog.style.top = newTop + "px";
    }
    function onDocMouseUp() { isDragging = false; mousedownOnHandle = false; }
    document.addEventListener("mousemove", onDocMouseMove);
    document.addEventListener("mouseup", onDocMouseUp);

    // HSL 颜色选择器
    let colorPicker = null;
    let pickerOutsideHandler = null;
    let pickerState = { h: 0, s: 0, l: 87 };
    let activeColorBtn = null;
    let activeColorKey = null;

    function applyPickerColor() {
        const hex = hslToHex(pickerState.h, pickerState.s, pickerState.l);
        activeColorBtn.style.background = hex;
        if (activeColorKey === 'value') p.valueColor = hex;
        else if (activeColorKey === 'track') p.trackColor = hex;
        else if (activeColorKey === 'thumb') p.thumbColor = hex;
        else if (activeColorKey === 'snap') p.snapTickColor = hex;
        updateVis(node);
    }

    function showColorPicker(btn, colorKey, initColor) {
        if (colorPicker) {
            if (pickerOutsideHandler) {
                document.removeEventListener('mousedown', pickerOutsideHandler, true);
                pickerOutsideHandler = null;
            }
            if (activeColorBtn === btn) {
                colorPicker.remove();
                colorPicker = null;
                activeColorBtn = null;
                return;
            }
            colorPicker.remove();
            colorPicker = null;
        }

        activeColorBtn = btn;
        activeColorKey = colorKey;

        const picker = document.createElement("div");
        picker.className = "xzg-us-color-picker";

        const initHsl = hexToHsl(initColor);
        pickerState = { h: initHsl.h, s: initHsl.s, l: initHsl.l };
        const initHsv = hslToHsv(initHsl.h, initHsl.s, initHsl.l);

        picker.innerHTML = `
            <div style="position:relative;width:100%;height:150px;border-radius:6px;overflow:hidden;margin-bottom:10px;" id="xzg-us-picker-sv">
                <div style="position:absolute;inset:0;background:linear-gradient(to right, #fff, transparent);"></div>
                <div style="position:absolute;inset:0;background:linear-gradient(to bottom, transparent, #000);"></div>
                <div style="position:absolute;width:12px;height:12px;border:2px solid #fff;border-radius:50%;transform:translate(-50%, -50%);box-shadow:0 0 2px rgba(0,0,0,0.8);pointer-events:none;" id="xzg-us-picker-sv-cursor"></div>
            </div>
            <div style="position:relative;width:100%;height:12px;border-radius:6px;
                background:linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%);
                margin-bottom:4px;" id="xzg-us-picker-hue">
                <div style="position:absolute;top:-2px;width:4px;height:16px;background:#fff;border-radius:2px;transform:translateX(-50%);box-shadow:0 0 2px rgba(0,0,0,0.8);pointer-events:none;" id="xzg-us-picker-hue-cursor"></div>
            </div>
        `;

        document.body.appendChild(picker);
        colorPicker = picker;

        const dlgRect = dialog.getBoundingClientRect();
        let pickerLeft = dlgRect.right + 12;
        if (pickerLeft + 220 > window.innerWidth - 10) pickerLeft = dlgRect.left - 220;
        let pickerTop = dlgRect.top;
        if (pickerTop + 210 > window.innerHeight - 10) pickerTop = window.innerHeight - 220;
        picker.style.left = pickerLeft + "px";
        picker.style.top = pickerTop + "px";

        const svArea = picker.querySelector("#xzg-us-picker-sv");
        const svCursor = picker.querySelector("#xzg-us-picker-sv-cursor");
        const hueBar = picker.querySelector("#xzg-us-picker-hue");
        const hueCursor = picker.querySelector("#xzg-us-picker-hue-cursor");

        const svRect = svArea.getBoundingClientRect();
        svCursor.style.left = (initHsv.s / 100 * svRect.width) + "px";
        svCursor.style.top = ((100 - initHsv.v) / 100 * svRect.height) + "px";
        svArea.style.backgroundColor = `hsl(${initHsl.h}, 100%, 50%)`;
        hueCursor.style.left = (initHsl.h / 360 * hueBar.offsetWidth) + "px";

        let draggingSV = false, draggingHue = false;

        const updateSV = (e) => {
            const rect = svArea.getBoundingClientRect();
            let x = e.clientX - rect.left;
            let y = e.clientY - rect.top;
            x = Math.max(0, Math.min(rect.width, x));
            y = Math.max(0, Math.min(rect.height, y));
            svCursor.style.left = x + "px";
            svCursor.style.top = y + "px";
            const hsvS = (x / rect.width) * 100;
            const hsvV = 100 - (y / rect.height) * 100;
            const hsl = hsvToHsl(pickerState.h, hsvS, hsvV);
            pickerState.s = hsl.s;
            pickerState.l = hsl.l;
            applyPickerColor();
        };

        const updateHue = (e) => {
            const rect = hueBar.getBoundingClientRect();
            let x = e.clientX - rect.left;
            x = Math.max(0, Math.min(rect.width, x));
            hueCursor.style.left = x + "px";
            const h = (x / rect.width) * 360;
            pickerState.h = h;
            svArea.style.backgroundColor = `hsl(${h}, 100%, 50%)`;
            applyPickerColor();
        };

        svArea.addEventListener("mousedown", (e) => { draggingSV = true; updateSV(e); e.preventDefault(); });
        hueBar.addEventListener("mousedown", (e) => { draggingHue = true; updateHue(e); e.preventDefault(); });
        document.addEventListener("mousemove", (e) => { if (draggingSV) updateSV(e); if (draggingHue) updateHue(e); });
        document.addEventListener("mouseup", () => { draggingSV = false; draggingHue = false; });

        picker.addEventListener("mousedown", (e) => e.stopPropagation());

        setTimeout(() => {
            pickerOutsideHandler = (e) => {
                if (!picker.contains(e.target) &&
                    e.target !== valueColorBtn && e.target !== trackColorBtn &&
                    e.target !== thumbColorBtn && e.target !== snapColorBtn) {
                    picker.remove();
                    colorPicker = null;
                    activeColorBtn = null;
                    document.removeEventListener('mousedown', pickerOutsideHandler, true);
                    pickerOutsideHandler = null;
                }
            };
            document.addEventListener('mousedown', pickerOutsideHandler, true);
        }, 0);
    }

    valueColorBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        showColorPicker(valueColorBtn, 'value', p.valueColor);
    });
    trackColorBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        showColorPicker(trackColorBtn, 'track', p.trackColor);
    });
    thumbColorBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        showColorPicker(thumbColorBtn, 'thumb', p.thumbColor);
    });
    snapColorBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        showColorPicker(snapColorBtn, 'snap', p.snapTickColor);
    });

    // 滑块数值联动
    offsetXCtrl.inp.addEventListener("input", () => {
        offsetXCtrl.val.textContent = offsetXCtrl.inp.value;
        p.valueOffsetXPct = clamp(parseInt(offsetXCtrl.inp.value) || 50, 0, 100);
        updateVis(node);
    });
    trackHCtrl.inp.addEventListener("input", () => {
        trackHCtrl.val.textContent = trackHCtrl.inp.value;
        p.trackHeight = clamp(parseInt(trackHCtrl.inp.value) || 4, 1, 20);
        updateVis(node);
    });
    thumbSizeCtrl.inp.addEventListener("input", () => {
        thumbSizeCtrl.val.textContent = thumbSizeCtrl.inp.value;
        p.thumbSize = clamp(parseInt(thumbSizeCtrl.inp.value) || 20, 6, 30);
        updateVis(node);
    });
    snapSizeCtrl.inp.addEventListener("input", () => {
        snapSizeCtrl.val.textContent = snapSizeCtrl.inp.value;
        p.snapTickSize = clamp(parseInt(snapSizeCtrl.inp.value) || 6, 3, 14);
        updateVis(node);
    });

    let confirmed = false;
    const closeDialog = () => {
        if (!confirmed) {
            p.valueColor      = origValueColor;
            p.trackColor      = origTrackColor;
            p.thumbColor      = origThumbColor;
            p.valueOffsetXPct = origValueOffsetXPct;
            p.valueOffset     = origValueOffset;
            p.fontSize        = origFontSize;
            p.trackHeight     = origTrackHeight;
            p.thumbSize       = origThumbSize;
            p.useSnaps        = origUseSnaps;
            p.snaps           = origSnaps;
            p.snapTickColor   = origSnapTickColor;
            p.snapTickSize    = origSnapTickSize;
            updateVis(node);
        }
        if (colorPicker) {
            if (pickerOutsideHandler) {
                document.removeEventListener('mousedown', pickerOutsideHandler, true);
                pickerOutsideHandler = null;
            }
            colorPicker.remove();
            colorPicker = null;
        }
        document.removeEventListener("mousemove", onDocMouseMove);
        document.removeEventListener("mouseup", onDocMouseUp);
        if (outsideHandler) {
            document.removeEventListener('mousedown', outsideHandler, true);
            outsideHandler = null;
        }
        dialog.remove();
    };

    bCancel.onclick = closeDialog;
    bOk.onclick = () => {
        let type = selectedType;
        let mn = parseFloat(minCell.inp.value);
        let mx = parseFloat(maxCell.inp.value);
        let step = parseFloat(stepCell.inp.value);

        if (isNaN(mn)) mn = p.sliderMin;
        if (isNaN(mx)) mx = p.sliderMax;
        if (mn > mx) { const t = mn; mn = mx; mx = t; }
        if (isNaN(step) || step <= 0) step = p.sliderStep;
        if (type === "int") {
            mn = Math.round(mn);
            mx = Math.round(mx);
            step = Math.max(1, Math.round(step));
        }

        p.sliderType  = type;
        p.sliderMin   = mn;
        p.sliderMax   = mx;
        p.sliderStep  = step;

        // 颜色值在颜色选择器拖动时已同步到 p，这里直接采用
        p.valueOffsetXPct = clamp(parseInt(offsetXCtrl.inp.value) || 50, 0, 100);
        p.trackHeight     = clamp(parseInt(trackHCtrl.inp.value) || 4, 1, 20);
        p.thumbSize       = clamp(parseInt(thumbSizeCtrl.inp.value) || 20, 6, 30);

        p.useSnaps = useSnapsCb.checked;
        p.snaps = [];
        if (p.useSnaps) {
            snapInputs.forEach(inp => {
                const v = parseFloat(inp.value);
                if (!isNaN(v)) p.snaps.push(v);
            });
        }
        p.snapTickSize  = clamp(parseInt(snapSizeCtrl.inp.value) || 6, 3, 14);

        // 保持 sliderColor 与 trackColor 一致，兼容旧版读取
        p.sliderColor = p.trackColor;

        const w = node._xzgUs.widget;
        if (w) {
            if (p.useSnaps && p.snaps.length > 0) {
                w.value = snapToSnaps(w.value, p.snaps);
            } else {
                w.value = calcValue(w.value, mn, mx, step, type === "int");
            }
        }

        syncWidgetType(node);
        syncOutputType(node);
        updateVis(node);
        node.setDirtyCanvas(true, true);
        confirmed = true;
        closeDialog();
    };

    // 点击面板外部关闭
    let outsideHandler = (e) => {
        if (mousedownOnHandle) { mousedownOnHandle = false; return; }
        const picker = document.querySelector('.xzg-us-color-picker');
        if (!dialog.contains(e.target) && !(picker && picker.contains(e.target))) {
            closeDialog();
        }
    };
    setTimeout(() => {
        document.addEventListener('mousedown', outsideHandler, true);
    }, 0);
}

// ── setupSlider ──────────────────────────────
function setupSlider(node) {
    const D = {
        sliderType: "int", sliderMin: 0, sliderMax: 100,
        sliderStep: 1, sliderLabel: "值", sliderColor: "#e8c547",
        valueOffset: -20, valueOffsetXPct: 50, fontSize: 14, valueColor: "#ffffff",
        trackHeight: 4, trackColor: "#e8c547", thumbSize: 20, thumbColor: "#f5f0e8",
        snaps: [], useSnaps: false, snapTickColor: "#555", snapTickSize: 5
    };
    if (!node.properties) node.properties = {};
    if (node.properties.sliderColor === undefined) node.properties.sliderColor = D.sliderColor;
    if (node.properties.trackColor === undefined) node.properties.trackColor = node.properties.sliderColor;
    for (const [k, v] of Object.entries(D)) {
        if (k === "sliderColor" || k === "trackColor") continue;
        if (node.properties[k] === undefined) node.properties[k] = v;
    }
    const p     = node.properties;
    const isInt = p.sliderType === "int";

    /* 隐藏 PY 自带滑条 */
    const dw = node.widgets ? node.widgets.find((w) => w.name === "value") : null;
    if (dw) {
        dw.hidden = true;
        dw.computeSize = () => [0, 0];
    }

    /* output_type 隐藏 widget */
    let outputTypeWidget = node.widgets
        ? node.widgets.find((w) => w.name === "output_type")
        : null;
    if (!outputTypeWidget) {
        node.addWidget("combo", "output_type", isInt ? "int" : "float", function () {}, { values: ["float", "int"] });
        outputTypeWidget = node.widgets ? node.widgets.find((w) => w.name === "output_type") : null;
    }
    if (outputTypeWidget) {
        outputTypeWidget.value       = isInt ? "int" : "float";
        outputTypeWidget.type        = "hidden";
        outputTypeWidget.hidden      = true;
        outputTypeWidget.computeSize = () => [0, 0];
        outputTypeWidget.draw        = function () {};
        outputTypeWidget.mouse       = function () {};
    }

    /* 节点外观：使用系统默认颜色 */

    /* ── 绘制状态缓存 ── */
    const ds = { trackLeft: 14, trackW: 192 };

    node._xzgUs = {
        widget: dw,
        outputTypeWidget: outputTypeWidget,
        _dragging: false,
        _docCleanup: null,
    };

    syncWidgetType(node);
    syncOutputType(node);

    /* ══════════════════════════════════════════
     *  注册 Canvas 自定义 Widget
     * ══════════════════════════════════════════ */
    node.addCustomWidget({
        name: "xzg_us_ui",
        type: "xzg_universal_slider",

        draw(ctx, node, W, y, H) {
            const g = node._xzgUs;
            if (!g) return;
            const p     = node.properties;
            const v     = g.widget ? g.widget.value : 0;
            const isInt = p.sliderType === "int";
            const color = p.trackColor;

            const ml = 6;
            const mr = 8;
            ds.trackLeft = ml;
            ds.trackW    = W - ml - mr;

            /* ── 轨道 ── */
            const trackY = y + 12;
            const trackH = p.trackHeight || 4;
            const trackR = trackH / 2;

            let ratio;
            if (p.useSnaps && p.snaps && p.snaps.length > 0) {
                const snaps = p.snaps;
                let idx = 0;
                let minDist = Math.abs(v - snaps[0]);
                for (let i = 1; i < snaps.length; i++) {
                    const dist = Math.abs(v - snaps[i]);
                    if (dist < minDist) { minDist = dist; idx = i; }
                }
                ratio = snaps.length > 1 ? idx / (snaps.length - 1) : 0.5;
            } else {
                ratio = clamp(pct(v, p.sliderMin, p.sliderMax), 0, 100) / 100;
            }
            const fillW = ds.trackW * ratio;

            /* ── 轨道背景 ── */
            ctx.save();
            ctx.shadowColor   = "rgba(0,0,0,0.5)";
            ctx.shadowBlur    = 2;
            ctx.shadowOffsetY = 1;
            rrect(ctx, ml, trackY, ds.trackW, trackH, trackR);
            ctx.fillStyle = "#1a1a1a";
            ctx.fill();
            ctx.restore();

            /* ── 多值定格刻度竖杠 ── */
            if (p.useSnaps && p.snaps && p.snaps.length > 0) {
                const snaps = p.snaps;
                const tickSize = p.snapTickSize || 6;
                const tickColor = p.snapTickColor || '#555';
                const tickWidth = 2;
                ctx.save();
                for (let i = 0; i < snaps.length; i++) {
                    const pctPos = snaps.length > 1 ? i / (snaps.length - 1) : 0.5;
                    const tx = ml + ds.trackW * pctPos;
                    const ty = trackY + (trackH - tickSize) / 2;
                    ctx.fillStyle = tickColor;
                    ctx.fillRect(tx - tickWidth / 2, ty, tickWidth, tickSize);
                }
                ctx.restore();
            }

            /* ── 发光层 ── */
            if (fillW > 0) {
                ctx.save();
                ctx.globalAlpha = 0.2;
                ctx.shadowColor = color;
                ctx.shadowBlur  = 10;
                rrect(ctx, ml, trackY + 2, fillW, trackH - 4, Math.max(0, trackR - 2));
                ctx.fillStyle = color;
                ctx.fill();
                ctx.restore();
            }

            /* ── 填充条 ── */
            if (fillW > 0) {
                ctx.save();
                rrect(ctx, ml, trackY, fillW, trackH, trackR);
                ctx.fillStyle = color;
                ctx.fill();
                ctx.restore();
            }

            /* ── 数值标签 ── */
            ctx.save();
            const valFont = `${p.fontSize || 14}px "Microsoft YaHei", "微软雅黑", "PingFang SC", "Hiragino Sans GB", "SimHei", "Segoe UI", Arial, sans-serif`;
            ctx.font = valFont;
            const valText = fmt(v, isInt);
            const valTextW = ctx.measureText(valText).width;
            const maxValX = Math.max(0, ds.trackW - valTextW);
            const valX = ml + Math.max(0, Math.min(maxValX, maxValX * (p.valueOffsetXPct ?? 50) / 100));
            const valY = trackY + (p.valueOffset ?? -20);

            ctx.textBaseline = "middle";
            ctx.textAlign    = "left";
            ctx.font         = valFont;
            ctx.fillStyle    = p.valueColor;
            ctx.fillText(valText, valX, valY);
            ctx.restore();

            /* ── 圆形旋钮 ── */
            const thumbX = ml + fillW;
            const thumbY = trackY + trackH / 2;
            const thumbR = (p.thumbSize || 20) / 2;

            ctx.save();
            if (g._dragging) {
                ctx.shadowColor = "rgba(232,197,71,0.12)";
                ctx.shadowBlur  = 5;
            } else {
                ctx.shadowColor = "rgba(0,0,0,0.4)";
                ctx.shadowBlur  = 4;
            }
            ctx.fillStyle   = p.thumbColor;
            ctx.strokeStyle = "rgba(0,0,0,0.3)";
            ctx.lineWidth   = 1;
            ctx.beginPath();
            ctx.arc(thumbX, thumbY, thumbR, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            ctx.restore();
        },

        mouse(event, pos, node) {
            const g = node._xzgUs;
            if (!g) return;
            const p = node.properties;

            /* ── 滚轮不拦截，交给画布缩放 ── */
            if (event.type === "wheel") return false;

            /* ── mouseup / pointerup：结束拖拽 ── */
            if (event.type === "mouseup" || event.type === "pointerup") {
                if (g._dragging) {
                    g._dragging = false;
                    if (g._docCleanup) { g._docCleanup(); g._docCleanup = null; }
                    node.setDirtyCanvas(true, true);
                    return true;
                }
                return;
            }

            /* ── mousemove / pointermove：拖拽中实时更新 ── */
            if ((event.type === "mousemove" || event.type === "pointermove") && g._dragging) {
                const isInt = p.sliderType === "int";
                const ratio = clamp((pos[0] - ds.trackLeft) / ds.trackW, 0, 1);
                let v;
                if (p.useSnaps && p.snaps && p.snaps.length > 0) {
                    const snaps = p.snaps;
                    const idx = Math.round(ratio * (snaps.length - 1));
                    v = snaps[Math.max(0, Math.min(snaps.length - 1, idx))];
                } else {
                    v = p.sliderMin + ratio * (p.sliderMax - p.sliderMin);
                    v = calcValue(v, p.sliderMin, p.sliderMax, p.sliderStep, isInt);
                }
                if (g.widget) g.widget.value = v;
                node.setDirtyCanvas(true, false);
                return true;
            }

            /* ── 仅处理左键 mousedown / pointerdown ── */
            if (event.type !== "mousedown" && event.type !== "pointerdown") return;
            if (event.button !== 0) return;

            /* ── 清理可能残留的拖拽状态 ── */
            if (g._dragging) {
                g._dragging = false;
                if (g._docCleanup) { g._docCleanup(); g._docCleanup = null; }
            }

            /* ── 左键：跳到点击位置并开始拖拽 ── */
            const isInt = p.sliderType === "int";
            const ratio = clamp((pos[0] - ds.trackLeft) / ds.trackW, 0, 1);
            let v;
            if (p.useSnaps && p.snaps && p.snaps.length > 0) {
                const snaps = p.snaps;
                const idx = Math.round(ratio * (snaps.length - 1));
                v = snaps[Math.max(0, Math.min(snaps.length - 1, idx))];
            } else {
                v = p.sliderMin + ratio * (p.sliderMax - p.sliderMin);
                v = calcValue(v, p.sliderMin, p.sliderMax, p.sliderStep, isInt);
            }

            if (g.widget) g.widget.value = v;
            node.setDirtyCanvas(true, false);

            g._dragging = true;

            /* ── document 备用监听（防止 LiteGraph 不转发后续事件时的保底） ── */
            const startCX  = event.clientX;
            const startVal = v;

            function onDocMove(e2) {
                if (!g._dragging) return;
                const dx       = e2.clientX - startCX;
                const scale    = app.canvas.ds.scale || 1;
                const graphDx  = dx / scale;
                const ratioD   = graphDx / ds.trackW;
                let nv = startVal + ratioD * (p.sliderMax - p.sliderMin);
                if (p.useSnaps && p.snaps && p.snaps.length > 0) {
                    const snaps = p.snaps;
                    let idx = 0;
                    let minDist = Math.abs(nv - snaps[0]);
                    for (let i = 1; i < snaps.length; i++) {
                        const dist = Math.abs(nv - snaps[i]);
                        if (dist < minDist) { minDist = dist; idx = i; }
                    }
                    nv = snaps[idx];
                } else {
                    nv = calcValue(nv, p.sliderMin, p.sliderMax, p.sliderStep, isInt);
                }
                if (g.widget) g.widget.value = nv;
                node.setDirtyCanvas(true, false);
            }

            function onDocUp() {
                if (!g._dragging) return;
                g._dragging = false;
                g._docCleanup = null;
                document.removeEventListener("mousemove", onDocMove);
                document.removeEventListener("mouseup", onDocUp);
                node.setDirtyCanvas(true, true);
            }

            g._docCleanup = function () {
                document.removeEventListener("mousemove", onDocMove);
                document.removeEventListener("mouseup", onDocUp);
            };
            document.addEventListener("mousemove", onDocMove);
            document.addEventListener("mouseup", onDocUp);

            return true;
        },

        computeSize(width) {
            return [width, 22];
        },
    });

    /* 监听外部值变化 */
    const origCB = node.onWidgetChanged;
    node.onWidgetChanged = function (name, value, widget) {
        if (origCB) origCB.call(this, name, value, widget);
        if (name === "value") updateVis(this);
    };

    /* 节点宽度：更窄更紧凑 */
    node.size[0] = Math.max(node.size[0], 120);
    node.size[1] = 22;
}

// ── 注册扩展 ────────────────────────────────
app.registerExtension({
    name: "ComfyUI.xiaozhuguang.universal.slider",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "XiaozhuguangUniversalSlider") return;

        /* ── 圆角标题补丁 ── */
        if (
            typeof LGraphCanvas !== "undefined" &&
            LGraphCanvas.prototype.drawNode &&
            typeof LiteGraph !== "undefined" &&
            !LGraphCanvas.prototype._xzgUsRadiusPatched
        ) {
            LGraphCanvas.prototype._xzgUsRadiusPatched = true;
            const origDrawNode = LGraphCanvas.prototype.drawNode;
            LGraphCanvas.prototype.drawNode = function (node, ctx, ...args) {
                if (node.type === "XiaozhuguangUniversalSlider") {
                    const origR = LiteGraph.NODE_ROUND_RADIUS;
                    LiteGraph.NODE_ROUND_RADIUS = 8;
                    origDrawNode.call(this, node, ctx, ...args);
                    LiteGraph.NODE_ROUND_RADIUS = origR;
                } else {
                    origDrawNode.call(this, node, ctx, ...args);
                }
            };
        }

        /* ── onNodeCreated ── */
        const onCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onCreated ? onCreated.apply(this, arguments) : undefined;
            setupSlider(this);
            return r;
        };

        /* ── configure（加载已保存的节点时恢复状态） ── */
        const onConfigure = nodeType.prototype.configure;
        nodeType.prototype.configure = function (info) {
            if (onConfigure) onConfigure.apply(this, arguments);
            if (!this._xzgUs) return;
            const p = this.properties;

            // 确保新属性存在默认值
            if (p.sliderType === undefined) p.sliderType = "int";
            if (p.sliderMin === undefined) p.sliderMin = 0;
            if (p.sliderMax === undefined) p.sliderMax = 100;
            if (p.sliderStep === undefined) p.sliderStep = 1;
            if (p.valueColor === undefined) p.valueColor = "#ffffff";
            if (p.valueOffset === undefined) p.valueOffset = -20;
            if (p.valueOffsetXPct === undefined) p.valueOffsetXPct = 50;
            if (p.fontSize === undefined) p.fontSize = 14;
            if (p.trackHeight === undefined) p.trackHeight = 4;
            if (p.trackColor === undefined) p.trackColor = p.sliderColor || "#e8c547";
            if (p.thumbSize === undefined) p.thumbSize = 20;
            if (p.thumbColor === undefined) p.thumbColor = "#f5f0e8";
            if (p.snaps === undefined) p.snaps = [];
            if (p.useSnaps === undefined) p.useSnaps = false;
            if (p.snapTickColor === undefined) p.snapTickColor = "#555";
            if (p.snapTickSize === undefined) p.snapTickSize = 6;

            const w = this._xzgUs.widget;
            if (w) {
                if (p.useSnaps && p.snaps.length > 0) {
                    w.value = snapToSnaps(w.value, p.snaps);
                } else {
                    const isInt = p.sliderType === "int";
                    w.value = calcValue(w.value, p.sliderMin, p.sliderMax, p.sliderStep, isInt);
                }
            }

            syncWidgetType(this);
            syncOutputType(this);
            updateVis(this);
        };

        /* ── 右键上下文菜单 ── */
        const origExtra = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
            let r;
            try {
                if (typeof origExtra === "function") {
                    r = origExtra.apply(this, arguments);
                }
            } catch (e) {
                console.warn("[XiaozhuguangUniversalSlider] getExtraMenuOptions:", e);
            }
            if (Array.isArray(options)) {
                options.splice(0, 0, null, {
                    content: '<span style="color:#FFD700;">' + xzgT('小珠光万能滑条 设置','Xiaozhuguang Universal Slider Settings') + '</span>',
                    callback: () => showSettings(this),
                });
            }
            return r;
        };
    },
});

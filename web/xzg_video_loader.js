import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { XiaozhuguangVideoPlayer } from "./xzg_video_player.js";

const VIDEO_EXTS = ["webm", "mp4", "mkv", "gif", "mov", "avi", "flv", "wmv", "m4v", "mpg", "mpeg", "ts"];
const VIDEO_PREVIEW_WIDGET_NAME = "xzg_video_preview";
const VIDEO_PREVIEW_MIN_H = 100;

// ═══════════════════════════════════════════════════════════════════════
// 自定义数值 widget（VHS 同款方案：从源头创建 canvas 不认识的 widget 类型）
// ═══════════════════════════════════════════════════════════════════════
function _xzgWidgetNumberMouse(event, [x, y], node) {
    const widgetWidth = this._xzgDrawW || this.width || node.size[0];
    const oldValue = this.value;
    const step = this._xzgStep || 1;
    const min = this._xzgMin;
    const max = this._xzgMax;

    const clamp = (v) => {
        if (min != null && v < min) v = min;
        if (max != null && v > max) v = max;
        return v;
    };

    if (event.type === 'pointermove') {
        if (event.deltaX) {
            this.value = clamp(this.value + event.deltaX);
            app.canvas._xzgValueDragged = true;
        }
    } else if (event.type === 'pointerup') {
        if (app.canvas._xzgValueDragged) {
            // 松手吸附到 step 倍数
            this.value = clamp(Math.round(this.value / step) * step);
        } else {
            // 点击 → 弹输入框
            app.canvas._xzgAllowPrompt = true;
            app.canvas?.prompt?.(
                this.label || this.name,
                this.value,
                (v) => {
                    this.value = clamp(Number(v));
                    if (this.callback) this.callback(this.value);
                    node.setDirtyCanvas?.(true, true);
                },
                event
            );
            return true;
        }
        app.canvas._xzgValueDragged = false;
    }

    if (oldValue !== this.value) {
        if (this.callback) this.callback(this.value);
        node.setDirtyCanvas?.(true, true);
    }
    return true;
}

// 带重置按钮的数值控件鼠标处理器（点击 × 一键归零）
function _xzgWidgetNumberWithResetMouse(event, [x, y], node) {
    if (event.type === 'pointerup' && !app.canvas._xzgValueDragged && this._xzgResetRect) {
        const [rx, ry, rw, rh] = this._xzgResetRect;
        if (x >= rx && x <= rx + rw && y >= ry && y <= ry + rh) {
            this.value = 0;
            if (this.callback) this.callback(this.value);
            node.setDirtyCanvas?.(true, true);
            return true;
        }
    }
    // 悬停高亮
    if (event.type === 'pointermove' && this._xzgResetRect) {
        const [rx, ry, rw, rh] = this._xzgResetRect;
        const hover = x >= rx && x <= rx + rw && y >= ry && y <= ry + rh;
        if (hover !== this._xzgResetHover) {
            this._xzgResetHover = hover;
            node.setDirtyCanvas?.(true, true);
        }
    }
    return _xzgWidgetNumberMouse.call(this, event, [x, y], node);
}

function _xzgDrawWidget(ctx, node, width, y, H) {
    this._xzgDrawW = width;
    const pad = 16;
    const r = 6;
    const w = width - pad * 2;
    ctx.fillStyle = '#2a2a2a';
    ctx.beginPath();
    if (ctx.roundRect) { ctx.roundRect(pad, y + 1, w, H - 2, r); } else { ctx.rect(pad, y + 1, w, H - 2); }
    ctx.fill();
    ctx.strokeStyle = '#444';
    ctx.stroke();
    // 左侧：中文标签
    ctx.fillStyle = '#9ab';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.label || this.name || '', pad + 6, y + H / 2);
    // 右侧：当前值（支持自定义颜色）
    const valueText = String(this.value);
    ctx.fillStyle = this._xzgValueColor || '#fff';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'right';
    let valueX = width - pad - 6;
    // 重置按钮（×），点击一键归零
    if (this._xzgShowReset) {
        valueX -= 18; // 左移留出按钮空间
        const btnR = 7;
        const btnCX = width - pad - 6 - btnR;
        const btnCY = y + H / 2;
        this._xzgResetRect = [btnCX - btnR, btnCY - btnR, btnR * 2, btnR * 2];
        // 暗灰色 × 符号
        ctx.strokeStyle = this._xzgResetHover ? '#888' : '#555';
        ctx.lineWidth = 2;
        const s = 4;
        ctx.beginPath();
        ctx.moveTo(btnCX - s, btnCY - s);
        ctx.lineTo(btnCX + s, btnCY + s);
        ctx.moveTo(btnCX + s, btnCY - s);
        ctx.lineTo(btnCX - s, btnCY + s);
        ctx.stroke();
    }
    // 绘制数值（恢复 fillStyle，防止重置按钮影响数值颜色）
    ctx.fillStyle = this._xzgValueColor || '#fff';
    ctx.fillText(valueText, valueX, y + H / 2);
}

// combo / button 同款圆角风格
function _xzgDrawComboWidget(ctx, node, width, y, H) {
    this._xzgDrawW = width;
    const pad = 16, r = 6;
    const w = width - pad * 2;
    ctx.fillStyle = '#2a2a2a';
    ctx.beginPath();
    if (ctx.roundRect) { ctx.roundRect(pad, y + 1, w, H - 2, r); } else { ctx.rect(pad, y + 1, w, H - 2); }
    ctx.fill();
    ctx.strokeStyle = '#444';
    ctx.stroke();
    // 左侧标签（超长省略）
    ctx.fillStyle = '#9ab';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const labelText = this.label || this.name || '';
    const labelMaxW = width - pad * 2 - 54; // 留出右侧值+箭头空间，再减3字符
    if (ctx.measureText(labelText).width > labelMaxW) {
        let truncated = labelText;
        while (ctx.measureText(truncated + '…').width > labelMaxW && truncated.length > 0) {
            truncated = truncated.slice(0, -1);
        }
        ctx.fillText(truncated + '…', pad + 6, y + H / 2);
    } else {
        ctx.fillText(labelText, pad + 6, y + H / 2);
    }
    // 右侧：当前值（超长省略）
    const displayText = this._xzgDisplayVal ? this._xzgDisplayVal(String(this.value ?? '')) : String(this.value ?? '');
    ctx.fillStyle = '#fff';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'right';
    const valMaxW = width - pad * 2 - 54;
    if (ctx.measureText(displayText).width > valMaxW) {
        let truncated = displayText;
        while (ctx.measureText(truncated + '…').width > valMaxW && truncated.length > 0) {
            truncated = truncated.slice(0, -1);
        }
        ctx.fillText(truncated + '…', width - pad - 16, y + H / 2);
    } else {
        ctx.fillText(displayText, width - pad - 16, y + H / 2);
    }
    // 右侧下拉箭头 ▼
    ctx.fillStyle = '#888';
    ctx.beginPath();
    const dx = width - pad - 8, dy = y + H / 2;
    ctx.moveTo(dx - 4, dy - 2);
    ctx.lineTo(dx + 4, dy - 2);
    ctx.lineTo(dx, dy + 3);
    ctx.closePath();
    ctx.fill();
}

// 强制帧率 combo 的 mouse 处理器：点击弹出下拉列表，禁止拖拽
function _xzgFpsComboMouse(event, [x, y], node) {
    if (event.type === 'pointerup') {
        _xzgShowComboDropdown(this, node, event);
        return true;
    }
    return true;
}

// 显示 combo 下拉列表（DOM 方式）
function _xzgShowComboDropdown(widget, node, event) {
    // 移除已有的下拉
    const old = document.querySelector('.xzg-fps-dropdown');
    if (old) old.remove();

    const values = widget.options?.values || ["0", "16", "24", "25", "30", "60"];
    const canvasRect = app.canvas?.canvas?.getBoundingClientRect?.();
    if (!canvasRect) return;

    // 计算 widget 在屏幕上的位置
    let wx = event.clientX;
    let wy = event.clientY;
    if (!wx || !wy) {
        // fallback: 用 canvas 坐标推算
        const pad = 16;
        const nodeX = (node.pos?.[0] || 0) * app.canvas.ds.scale + canvasRect.left;
        const nodeY = (node.pos?.[1] || 0) * app.canvas.ds.scale + canvasRect.top;
        const widgetIdx = node.widgets?.indexOf(widget) ?? 0;
        const widgetY = nodeY + node.widgets?.slice(0, widgetIdx).reduce((s, w) => s + (w.computeSize?.(node.size[0])?.[1] || 20), 0) || 0;
        wx = nodeX + node.size[0] * app.canvas.ds.scale - pad;
        wy = widgetY;
    }

    const dropdown = document.createElement('div');
    dropdown.className = 'xzg-fps-dropdown';
    dropdown.style.cssText = `
        position: fixed; z-index: 99999;
        left: ${Math.max(4, wx - 60)}px; top: ${wy + 4}px;
        min-width: 80px;
        background: #2a2a2a; border: 1px solid #555; border-radius: 6px;
        padding: 4px 0; box-shadow: 0 4px 16px rgba(0,0,0,0.5);
    `;

    values.forEach(v => {
        const item = document.createElement('div');
        const displayText = widget._xzgDisplayVal ? widget._xzgDisplayVal(String(v)) : String(v);
        item.textContent = displayText;
        const selected = String(v) === String(widget.value);
        item.style.cssText = `
            padding: 4px 16px; cursor: pointer; font-size: 13px;
            color: ${selected ? '#FFD700' : '#ccc'};
            background: ${selected ? '#333' : 'transparent'};
        `;
        item.onmouseenter = () => { item.style.background = '#444'; };
        item.onmouseleave = () => { item.style.background = selected ? '#333' : 'transparent'; };
        // 阻止 pointerdown 冒泡，防止关闭外部时误关
        item.addEventListener('pointerdown', (e) => e.stopPropagation());
        item.onclick = (e) => {
            e.stopPropagation();
            widget.value = v;
            if (widget.callback) widget.callback(v);
            node.setDirtyCanvas?.(true, true);
            dropdown.remove();
        };
        dropdown.appendChild(item);
    });

    // 阻止 dropdown 本身的 pointerdown 冒泡
    dropdown.addEventListener('pointerdown', (e) => e.stopPropagation());

    // 点击外部关闭（capture 阶段拦截，不受 LiteGraph stopPropagation 影响）
    const close = (e) => {
        if (!dropdown.contains(e.target)) {
            dropdown.remove();
            document.removeEventListener('pointerdown', close, true);
        }
    };
    document.addEventListener('pointerdown', close, true);

    document.body.appendChild(dropdown);
}

function _xzgDrawButtonWidget(ctx, node, width, y, H) {
    const pad = 16, r = 6;
    const w = width - pad * 2;
    ctx.fillStyle = '#2a2a2a';
    ctx.beginPath();
    if (ctx.roundRect) { ctx.roundRect(pad, y + 1, w, H - 2, r); } else { ctx.rect(pad, y + 1, w, H - 2); }
    ctx.fill();
    ctx.strokeStyle = '#444';
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.label || this.name || this.value || '', width / 2, y + H / 2);
}

// ═══════════════════════════════════════════════════════════════════════
// 激光引导线（参考小珠光编组激光引导线风格）
// ═══════════════════════════════════════════════════════════════════════
let _xzgLaserSvg = null;
let _xzgLaserRafId = null;

function _xzgShowLaserLine(widget, node) {
    _xzgHideLaserLine();

    const player = node._xzgVideoPlayer;
    if (!player) return;

    const isSkip = widget.name === '跳过帧数';
    const markerEl = isSkip ? player._loadRangeStart : player._loadRangeEnd;
    if (!markerEl || markerEl.style.display === 'none') return;

    const color = isSkip ? '#ef4444' : '#3b82f6';
    const glowFilter = `drop-shadow(0 0 4px ${color}88) drop-shadow(0 0 12px ${color}44)`;

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.style.cssText = "position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:100000;";
    svg.id = "xzg-video-loader-laser";

    // 计算控件数值区域屏幕位置（X固定在数值处，Y固定在节点顶部往下250px）
    const getWidgetScreenPos = () => {
        const canvas = app.canvas;
        if (!canvas?.ds || !canvas?.canvas) return null;
        const canvasRect = canvas.canvas.getBoundingClientRect();
        const scale = canvas.ds.scale;
        const offset = canvas.ds.offset;

        // 节点右侧数值区域屏幕坐标（需加 offset 补偿画布平移）
        const valueX = (node.pos[0] + offset[0] + node.size[0] - 50) * scale + canvasRect.left;
        // Y 根据控件不同：红线（跳过帧数）上移100，蓝线（帧数上限）保持250
        const yOffset = (widget.name === '跳过帧数') ? 197 : 222;
        const sy = (node.pos[1] + offset[1] + yOffset) * scale + canvasRect.top;
        return { x1: valueX, y1: sy };
    };

    const drawLine = () => {
        const canvas = app.canvas;
        if (!canvas?.ds || !canvas?.canvas) return;

        // 获取起点位置（每次重绘重新计算，跟随画布移动/缩放）
        const startPos = getWidgetScreenPos();
        if (!startPos) return;

        // 终点：标记元素屏幕位置（每次重绘重新计算，跟随竖杠移动）
        const markerRect = markerEl.getBoundingClientRect();
        const x2 = markerRect.left + markerRect.width / 2;
        const y2 = markerRect.top + markerRect.height / 2;

        // 清空并重绘
        while (svg.firstChild) svg.removeChild(svg.firstChild);

        // 主线
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", startPos.x1);
        line.setAttribute("y1", startPos.y1);
        line.setAttribute("x2", x2);
        line.setAttribute("y2", y2);
        line.setAttribute("stroke", color);
        line.setAttribute("stroke-width", "2");
        line.setAttribute("stroke-dasharray", "6 4");
        line.style.filter = glowFilter;
        const anim = document.createElementNS("http://www.w3.org/2000/svg", "animate");
        anim.setAttribute("attributeName", "stroke-dashoffset");
        anim.setAttribute("from", "0");
        anim.setAttribute("to", "20");
        anim.setAttribute("dur", "0.5s");
        anim.setAttribute("repeatCount", "indefinite");
        line.appendChild(anim);
        svg.appendChild(line);

        // 终点圆环
        const ring = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        ring.setAttribute("cx", x2);
        ring.setAttribute("cy", y2);
        ring.setAttribute("r", "6");
        ring.setAttribute("fill", "none");
        ring.setAttribute("stroke", color);
        ring.setAttribute("stroke-width", "2");
        ring.style.filter = glowFilter;
        const ringAnim = document.createElementNS("http://www.w3.org/2000/svg", "animate");
        ringAnim.setAttribute("attributeName", "r");
        ringAnim.setAttribute("values", "4;10;4");
        ringAnim.setAttribute("dur", "1s");
        ringAnim.setAttribute("repeatCount", "indefinite");
        ring.appendChild(ringAnim);
        const ringOpacity = document.createElementNS("http://www.w3.org/2000/svg", "animate");
        ringOpacity.setAttribute("attributeName", "opacity");
        ringOpacity.setAttribute("values", "1;0.3;1");
        ringOpacity.setAttribute("dur", "1s");
        ringOpacity.setAttribute("repeatCount", "indefinite");
        ring.appendChild(ringOpacity);
        svg.appendChild(ring);
    };

    drawLine();
    document.body.appendChild(svg);
    _xzgLaserSvg = svg;
    // 独立变量存储 rAF ID，函数引用保持不变 → 循环正确持续
    const loop = () => {
        drawLine();
        _xzgLaserRafId = requestAnimationFrame(loop);
    };
    _xzgLaserRafId = requestAnimationFrame(loop);
}

function _xzgHideLaserLine() {
    if (_xzgLaserRafId) {
        cancelAnimationFrame(_xzgLaserRafId);
        _xzgLaserRafId = null;
    }
    const svg = document.getElementById("xzg-video-loader-laser");
    if (svg) svg.remove();
    _xzgLaserSvg = null;
}

// 带激光引导线 + 重置按钮的数值控件鼠标处理器
function _xzgWidgetNumberWithLaserMouse(event, [x, y], node) {
    // 重置按钮点击
    if (event.type === 'pointerup' && !app.canvas._xzgValueDragged && this._xzgResetRect) {
        const [rx, ry, rw, rh] = this._xzgResetRect;
        if (x >= rx && x <= rx + rw && y >= ry && y <= ry + rh) {
            this.value = 0;
            if (this.callback) this.callback(this.value);
            node.setDirtyCanvas?.(true, true);
            _xzgHideLaserLine();
            return true;
        }
    }
    // 悬停高亮
    if (event.type === 'pointermove' && this._xzgResetRect) {
        const [rx, ry, rw, rh] = this._xzgResetRect;
        const hover = x >= rx && x <= rx + rw && y >= ry && y <= ry + rh;
        if (hover !== this._xzgResetHover) {
            this._xzgResetHover = hover;
            node.setDirtyCanvas?.(true, true);
        }
    }

    const result = _xzgWidgetNumberMouse.call(this, event, [x, y], node);

    if (event.type === 'pointermove' && event.deltaX) {
        if (!_xzgLaserSvg) {
            _xzgShowLaserLine(this, node);
        }
    } else if (event.type === 'pointerup' || event.type === 'pointerleave') {
        _xzgHideLaserLine();
    }

    return result;
}

// 根据视频比例切换自定义宽度/高度的显示和行为
function _updateRatioWidgets(node) {
    const ratioWidget = node.widgets?.find(w => w.name === "视频比例");
    const wWidget = node.widgets?.find(w => w.name === "自定义宽度");
    const hWidget = node.widgets?.find(w => w.name === "自定义高度");
    if (!ratioWidget || !wWidget || !hWidget) return;

    const isRatio = ratioWidget.value !== "自定义比例";

    if (isRatio) {
        wWidget.options.values = ["1", "2", "3", "4"];
        wWidget._xzgDisplayVal = (v) => ({1:"长边",2:"短边",3:"宽度",4:"高度"})[v] || v;
        wWidget.draw = _xzgDrawComboWidget;
        wWidget.mouse = _xzgFpsComboMouse;
        wWidget._xzgShowReset = false;
        wWidget.label = "边长模式";
        if (wWidget.value < 1 || wWidget.value > 4) wWidget.value = "1";
        hWidget.label = "边长尺寸";
        hWidget.draw = _xzgDrawWidget;
        hWidget.mouse = _xzgWidgetNumberMouse;
        hWidget._xzgShowReset = false;
    } else {
        wWidget.options.values = undefined;
        wWidget._xzgDisplayVal = undefined;
        wWidget.draw = _xzgDrawWidget;
        wWidget.mouse = _xzgWidgetNumberWithResetMouse;
        wWidget._xzgShowReset = true;
        wWidget.label = "自定义宽度";
        wWidget.value = 0;
        hWidget.draw = _xzgDrawWidget;
        hWidget.mouse = _xzgWidgetNumberWithResetMouse;
        hWidget._xzgShowReset = true;
        hWidget.label = "自定义高度";
        hWidget.value = 0;
    }
    node.setDirtyCanvas?.(true, true);
}

// 统一应用所有 widget 的样式（圆角、颜色、重置按钮等），可重复调用
function _applyWidgetStyles(node) {
    for (const w of node.widgets || []) {
        if (w.name === VIDEO_PREVIEW_WIDGET_NAME) continue;
        if (w.name === '强制帧率') {
            w.options = w.options || {};
            w.options.values = ["0", "16", "24", "25", "30", "60"];
            w.value = String(w.value ?? "0");
            w.mouse = _xzgFpsComboMouse;
            w.draw = _xzgDrawComboWidget;
        } else if (w.name === '视频') {
            w.draw = _xzgDrawComboWidget;
        } else if (w.name === '视频比例') {
            w.draw = _xzgDrawComboWidget;
            w.mouse = _xzgFpsComboMouse;
            w.value = String(w.value ?? "自定义比例");
            w.options = w.options || {};
            w.options.values = ["自定义比例", "原始比例", "竖屏9:16", "竖屏3:4", "横屏16:9", "横屏4:3", "等比1:1"];
        } else if (w.name === '上传视频') {
            w.draw = _xzgDrawButtonWidget;
        } else if (w.name === '跳过帧数') {
            w._xzgValueColor = '#FF4444';
            w._xzgShowReset = true;
            w.draw = _xzgDrawWidget;
            w.mouse = _xzgWidgetNumberWithLaserMouse;
        } else if (w.name === '帧数上限') {
            w._xzgValueColor = '#6699FF';
            w._xzgShowReset = true;
            w.draw = _xzgDrawWidget;
            w.mouse = _xzgWidgetNumberWithLaserMouse;
        } else if (w.name === '自定义宽度' || w.name === '自定义高度') {
            w._xzgValueColor = w._xzgValueColor || '#fff';
            w._xzgShowReset = true;
            w.draw = _xzgDrawWidget;
            w.mouse = _xzgWidgetNumberWithResetMouse;
        }
    }
}

function _xzgCreateNumberWidget(node, inputName, inputData) {
    const opts = inputData[1] || {};
    const w = {
        name: inputName,
        type: 'xzg-number',
        value: opts.default ?? 0,
        options: {},
        _xzgStep: opts.step || 1,
        _xzgMin: opts.min,
        _xzgMax: opts.max,
        computeSize(width) { return [width, 20]; },
        draw: _xzgDrawWidget,
        mouse: _xzgWidgetNumberMouse,
        callback(v) { if (this._xzgCb) this._xzgCb(v); },
    };
    if (!node.widgets) node.widgets = [];
    node.widgets.push(w);
    return w;
}

// 拦截 canvas.prompt：拖拽后(canvas 自己调的)不弹框
function _xzgPatchCanvasPrompt() {
    if (app.canvas._xzgPromptPatched) return;
    const origPrompt = app.canvas.prompt;
    app.canvas.prompt = function () {
        if (app.canvas._xzgAllowPrompt) {
            app.canvas._xzgAllowPrompt = false;
            app.canvas._xzgLastPromptMs = Date.now();
            return origPrompt.apply(this, arguments);
        }
        if (app.canvas._xzgValueDragged) {
            app.canvas._xzgValueDragged = false;
            return null;
        }
        if (app.canvas._xzgLastPromptMs && Date.now() - app.canvas._xzgLastPromptMs < 300) {
            return null;
        }
        return origPrompt.apply(this, arguments);
    };
    app.canvas._xzgPromptPatched = true;
}

function isVideoFilename(name) {
    if (!name) return false;
    const ext = name.split(".").pop().toLowerCase();
    return VIDEO_EXTS.includes(ext);
}

function getVideoUrl(filename) {
    if (!filename) return "";
    let name = filename;
    let type = "input";
    let subfolder = "";
    const suffixes = [" [output]", " [input]", " [temp]"];
    for (const s of suffixes) {
        if (name.endsWith(s)) {
            type = s.trim().slice(1, -1);
            name = name.slice(0, -s.length);
            break;
        }
    }
    const params = new URLSearchParams({ filename: name, type });
    if (subfolder) params.set("subfolder", subfolder);
    return `/view?${params.toString()}&rand=${Math.random()}`;
}

function _extractFilename(url) {
    try {
        const params = new URLSearchParams(new URL(url, location.origin).search);
        const name = params.get("filename");
        return name || "video.mp4";
    } catch (_) {
        return "video.mp4";
    }
}

async function uploadVideoFiles(files) {
    const uploaded = [];
    for (const file of files) {
        try {
            const body = new FormData();
            body.append("image", file);
            body.append("overwrite", "true");
            body.append("type", "input");
            const resp = await api.fetchApi("/upload/image", { method: "POST", body });
            if (resp.status === 200) {
                const data = await resp.json();
                if (data && data.name) {
                    uploaded.push(data.name);
                }
            }
        } catch (e) {
            console.warn("[小珠光] 视频上传失败:", e);
        }
    }
    return uploaded;
}

async function refreshVideoCombo(videoWidget, selectName) {
    try {
        const resp = await api.fetchApi("/object_info/XiaozhuguangVideoLoader");
        if (!resp.ok) return;
        const info = await resp.json();
        const list = info?.XiaozhuguangVideoLoader?.input?.required?.["视频"]?.[0];
        if (Array.isArray(list)) {
            videoWidget.options.values = list;
            if (selectName && list.includes(selectName)) {
                videoWidget.value = selectName;
            } else if (list.length > 0) {
                videoWidget.value = list[list.length - 1];
            }
            videoWidget.callback?.(videoWidget.value);
        }
    } catch (_) {}
}

function bindVideoLoaderInteractions(node) {
    node.resizable = true;
    node.minWidth = 300;
    node.minHeight = 500;
    // 强制 setSize 不得小于最小尺寸（防止拖动右下角缩小）
    const origSetSize = node.setSize;
    node.setSize = function(size) {
        size[0] = Math.max(size[0], this.minWidth || 300);
        size[1] = Math.max(size[1], this.minHeight || 500);
        return origSetSize?.apply(this, arguments);
    };
    node.setSize([300, 500]);

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.multiple = false;
    fileInput.accept = VIDEO_EXTS.map(e => "." + e).join(",");
    fileInput.style.display = "none";
    document.body.appendChild(fileInput);

    const triggerUpload = () => {
        app.canvas.node_widget = null;
        fileInput.value = "";
        fileInput.click();
    };

    const playerContainer = document.createElement("div");
    playerContainer.style.width = "100%";
    playerContainer.style.background = "#1a1a1a";
    playerContainer.style.position = "relative";
    playerContainer.style.pointerEvents = "none";

    node._xzgSourceFps = null;

    const updateFpsLabel = (sourceFps) => {
        const fpsWidget = node.widgets?.find(w => w.name === "强制帧率");
        if (!fpsWidget) return;
        fpsWidget.label = "强制帧率";
        node.setDirtyCanvas?.(true, true);
    };

    const updateFrameLimitLabel = () => {
        const limitWidget = node.widgets?.find(w => w.name === "帧数上限");
        if (!limitWidget) return;
        limitWidget.label = "帧数上限";
        node.setDirtyCanvas?.(true, true);
    };

    const updateVideoInfoLabels = () => {
        const video = player.videoElement;
        if (!video) return;
        const ratioWidget = node.widgets?.find(w => w.name === "视频比例");
        const wWidget = node.widgets?.find(w => w.name === "自定义宽度");
        const hWidget = node.widgets?.find(w => w.name === "自定义高度");
        const isRatio = ratioWidget?.value !== "自定义比例";
        if (wWidget) {
            wWidget.label = isRatio ? "边长模式" : "自定义宽度";
        }
        if (hWidget) {
            hWidget.label = isRatio ? "边长尺寸" : "自定义高度";
        }
        updateFrameLimitLabel();
    };

    const player = new XiaozhuguangVideoPlayer({
        container: playerContainer,
        onDblClick: triggerUpload,
        onLoadedMetadata: () => {
            updateVideoInfoLabels();
            syncLoadRange();
        },
        onSourceFpsDetected: (fps) => {
            if (typeof fps === "number" && fps > 0) {
                node._xzgSourceFps = Math.round(fps);
                updateFpsLabel(fps);
                updateFrameLimitLabel();
                node.setDirtyCanvas?.(true, true);
            }
        },
        onSaveToDesktop: () => {
            const url = player.getSrc();
            if (!url) return;
            XiaozhuguangVideoPlayer.downloadVideo(url, _extractFilename(url));
        },
        onSaveAs: () => {
            const url = player.getSrc();
            if (!url) return;
            XiaozhuguangVideoPlayer.saveAsVideo(url, _extractFilename(url));
        },
    });
    node._xzgVideoPlayer = player;

    const uploadBtn = node.addWidget("button", "上传视频", "upload", triggerUpload);
    uploadBtn.options.serialize = false;

    // 拦截 player.load 自动存储当前文件名（用于序列化恢复）
    player._currentFile = "";
    const _origPlayerLoad = player.load.bind(player);
    player.load = function (url) {
        if (url) {
            try {
                const p = new URL(url, location.origin);
                this._currentFile = p.searchParams.get("filename") || "";
            } catch (_) { this._currentFile = ""; }
        } else {
            this._currentFile = "";
        }
        return _origPlayerLoad(url);
    };

    // 视频播放区域下方的小字描述
    const hintText = document.createElement("div");
    hintText.textContent = "单击视频播放或暂停/双击视频上传";
    hintText.style.cssText = `
        width: 100%; text-align: center; font-size: 11px; color: #666;
        padding: 4px 0 2px; pointer-events: none;
    `;
    playerContainer.appendChild(hintText);

    const previewWidget = node.addDOMWidget(VIDEO_PREVIEW_WIDGET_NAME, "video", playerContainer, {
        hideOnZoom: false,
        getValue() { return player._currentFile || ""; },
        setValue(v) {
            if (!v) { player.load(""); return; }
            // 旧版兼容：可能是完整 URL 字符串
            let filename = v;
            if (typeof v === "string" && v.startsWith("/view?")) {
                try {
                    filename = new URL(v, location.origin).searchParams.get("filename") || v;
                } catch (_) { }
            }
            const url = getVideoUrl(filename);
            if (url && url !== player.src) {
                player._currentFile = filename;
                player.load(url);
            } else if (!url) {
                player.load("");
            }
        },
    });
    previewWidget.computeLayoutSize = function () {
        return { minHeight: VIDEO_PREVIEW_MIN_H, minWidth: 0 };
    };
    previewWidget.onRemove = () => {
        player.destroy();
        fileInput.remove();
    };

    const origOnResize = node.onResize;
    node.onResize = function (size) {
        const r = origOnResize?.apply(this, arguments);
        requestAnimationFrame(() => player.resize());
        return r;
    };

    const origOnRemoved = node.onRemoved;
    node.onRemoved = function () {
        _xzgHideLaserLine();
        player.destroy();
        fileInput.remove();
        return origOnRemoved?.apply(this, arguments);
    };

    const origOnConfigure = node.onConfigure;
    node.onConfigure = function (info) {
        origOnConfigure?.apply(this, arguments);
        requestAnimationFrame(() => {
            _applyWidgetStyles(node);
            _updateRatioWidgets(node);
            const w = node.widgets?.find(w => w.name === "视频");
            if (w && w.value) {
                player.load(getVideoUrl(w.value));
            }
            player.resize();
        });
    };

    // 从后端输出捕获视频真实帧率 + 实际加载帧数 + 宽高
    const origOnExecuted = node.onExecuted;
    node.onExecuted = function (output) {
        origOnExecuted?.apply(this, arguments);
        if (!output || !player) return;
        // ComfyUI onExecuted output 结构：{ result: [...], ui: {...} }
        // video_info 是返回值数组的第三个元素（index 2）
        const result = output.result || output;
        let vi = null;
        if (Array.isArray(result)) {
            vi = result[2];
        } else if (result && typeof result === "object") {
            vi = result.xzg_video_info || result.video_info || null;
        }
        if (vi) {
            const fps = vi.source_fps || vi.loaded_fps;
            if (typeof fps === "number" && fps > 0) {
                player.applyBackendFps(Math.round(fps));
            }
            // 用后端实际加载的帧数（准确，避免前端推算误差）
            const lf = vi.loaded_frame_count;
            if (typeof lf === "number" && lf > 0) {
                player.setTotalFrames(lf);
            }
            // 用后端实际加载的宽高同步预览比例
            const lw = vi.loaded_width;
            const lh = vi.loaded_height;
            if (typeof lw === "number" && typeof lh === "number" && lw > 0 && lh > 0) {
                player.setCustomSize(lw, lh);
            }
            // 用后端返回的原始宽高/帧数更新标签
            updateVideoInfoLabels();
            // 视频加载完成后更新控件边界约束（跳过帧数 max、帧数上限 min/max）
            syncLoadRange();
        }
    };

    fileInput.addEventListener("change", async (e) => {
        const files = Array.from(e.target.files || []).filter(f => isVideoFilename(f.name));
        if (files.length === 0) return;
        const uploaded = await uploadVideoFiles(files);
        if (uploaded.length > 0) {
            const videoWidget = node.widgets?.find(w => w.name === "视频");
            if (videoWidget) {
                await refreshVideoCombo(videoWidget, uploaded[0]);
                player.load(getVideoUrl(videoWidget.value));
            }
        }
        fileInput.value = "";
        node.setDirtyCanvas?.(true, true);
    });

    const origProcessDrop = node.processDrop;
    node.processDrop = function (e) {
        const files = Array.from(e.dataTransfer?.files || []).filter(f => isVideoFilename(f.name));
        if (files.length > 0) {
            e.preventDefault?.();
            e.stopPropagation?.();
            const dt = new DataTransfer();
            files.forEach(f => dt.items.add(f));
            fileInput.files = dt.files;
            fileInput.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
        }
        return origProcessDrop?.apply(this, arguments);
    };

    requestAnimationFrame(() => {
        const videoWidget = node.widgets?.find(w => w.name === "视频");
        if (videoWidget) {
            const origCb = videoWidget.callback;
            videoWidget.callback = function (value) {
                origCb?.apply(this, arguments);
                const url = getVideoUrl(value);
                player.load(url || "");
            };
            if (videoWidget.value) {
                player.load(getVideoUrl(videoWidget.value));
            }
        }
        // 同步强制帧率到播放器
        const fpsWidget = node.widgets?.find(w => w.name === "强制帧率");
        // 帧率变化时更新label（包括播放器初始化和自动检测）
        player.onFpsChange = (fps) => {
            updateFpsLabel(fps);
            updateVideoInfoLabels();
        };
        if (fpsWidget) {
            const origFpsCb = fpsWidget.callback;
            fpsWidget.callback = function (value) {
                origFpsCb?.apply(this, arguments);
                const fps = Number(value);
                if (fps > 0) {
                    player.setFrameRate(fps);
                } else {
                    player.resetFrameRate();
                }
            };
            const initFps = Number(fpsWidget.value);
            if (initFps > 0) {
                player.setFrameRate(initFps);
            } else {
                player.resetFrameRate();
            }
        }
        // 同步自定义宽高到播放器，预览比例随参数变化
        const wWidget = node.widgets?.find(w => w.name === "自定义宽度");
        const hWidget = node.widgets?.find(w => w.name === "自定义高度");
        const syncCustomSize = () => {
            // 比例模式下自定义宽度/高度为计算方式和边长尺寸，不用于预览
            const ratioW = node.widgets?.find(w => w.name === "视频比例");
            if (ratioW && ratioW.value !== "自定义比例") return;
            player.setCustomSize(wWidget?.value || 0, hWidget?.value || 0);
        };
        [wWidget, hWidget].forEach(w => {
            if (!w) return;
            const origCb = w.callback;
            w.callback = function (value) {
                origCb?.apply(this, arguments);
                syncCustomSize();
            };
        });
        syncCustomSize();
        const limitWidget = node.widgets?.find(w => w.name === "帧数上限");
        const skipWidget = node.widgets?.find(w => w.name === "跳过帧数");

        // 更新控件的 min/max 边界约束
        const updateWidgetBounds = () => {
            if (!skipWidget && !limitWidget) return;
            const totalFrames = typeof player.getSourceTotalFrames === "function"
                ? player.getSourceTotalFrames()
                : (player._sourceTotalFrames || 0);
            const skipVal = parseInt(skipWidget?.value) || 0;
            if (totalFrames > 0) {
                // 跳过帧数最大值 = 原始帧数 - 1
                if (skipWidget) skipWidget._xzgMax = totalFrames - 1;
                // 帧数上限最大值 = 剩余帧数（原始帧数 - 跳过帧数），实时跟随跳过帧数变化
                if (limitWidget) limitWidget._xzgMax = Math.max(0, totalFrames - skipVal);
            }
            // 帧数上限最小值保持 0（0 表示无限制/加载全部剩余帧），不跟随跳过帧数变动
            // 约束当前值
            if (skipWidget && skipWidget._xzgMax != null && skipWidget.value > skipWidget._xzgMax) {
                skipWidget.value = skipWidget._xzgMax;
            }
            if (limitWidget && limitWidget._xzgMax != null && limitWidget.value > limitWidget._xzgMax) {
                limitWidget.value = limitWidget._xzgMax;
            }
        };

        const syncLoadRange = () => {
            updateWidgetBounds();
            const skip = Math.max(0, parseInt(skipWidget?.value) || 0);
            const limit = Math.max(0, parseInt(limitWidget?.value) || 0);
            if (typeof player.setLoadRange === "function") {
                player.setLoadRange(skip, limit);
            }
        };
        if (limitWidget) {
            const origLimitCb = limitWidget.callback;
            limitWidget.callback = function (value) {
                origLimitCb?.apply(this, arguments);
                updateFrameLimitLabel();
                syncLoadRange();
            };
        }
        if (skipWidget) {
            const origSkipCb = skipWidget.callback;
            skipWidget.callback = function (value) {
                origSkipCb?.apply(this, arguments);
                // 跳过帧数变化时，帧数上限的 min 跟随变化
                syncLoadRange();
            };
        }
        updateFrameLimitLabel();
        syncLoadRange();
        // 视频比例变化时切换自定义宽度/高度的行为
        const ratioWidget = node.widgets?.find(w => w.name === "视频比例");
        if (ratioWidget) {
            const origRatioCb = ratioWidget.callback;
            ratioWidget.callback = function (value) {
                origRatioCb?.apply(this, arguments);
                _updateRatioWidgets(node);
            };
        }
        _updateRatioWidgets(node);
        player.resize();
    });
}

app.registerExtension({
    name: "xiaozhuguang.video_loader",
    getCustomWidgets() {
        return {
            XZGINT: (node, name, data) => _xzgCreateNumberWidget(node, name, data),
            XZGFLOAT: (node, name, data) => _xzgCreateNumberWidget(node, name, data),
        };
    },
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "XiaozhuguangVideoLoader") {
            // 强制帧率：强制走自定义 number widget，从源头避免原生 combo 列表
            if (nodeData.input?.required?.["强制帧率"]) {
                nodeData.input.required["强制帧率"][1].widgetType = "XZGINT";
            }
            // 视频比例：同样避免原生 combo 列表（双列表问题）
            if (nodeData.input?.required?.["视频比例"]) {
                nodeData.input.required["视频比例"][1].widgetType = "XZGINT";
            }
            // 注入自定义 widget 类型
            for (const inp of Object.values({ ...nodeData.input?.required, ...nodeData.input?.optional })) {
                if (["INT", "FLOAT"].includes(inp[0]) && inp[1]) {
                    inp[1].widgetType ??= "XZG" + inp[0];
                }
            }
            const correctOutputs = ["图像", "音频", "视频信息"];
            if (nodeData.outputs && Array.isArray(nodeData.outputs)) {
                nodeData.outputs.forEach((out, i) => {
                    if (correctOutputs[i]) out.name = correctOutputs[i];
                });
            }
            if (nodeData.output_name && Array.isArray(nodeData.output_name)) {
                nodeData.output_name = nodeData.output_name.slice(0, correctOutputs.length).map((n, i) => correctOutputs[i] || n);
            }
            const origOnNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const r = origOnNodeCreated?.apply(this, arguments);
                bindVideoLoaderInteractions(this);
                _xzgPatchCanvasPrompt();
                _applyWidgetStyles(this);
                if (this.outputs) {
                    this.outputs.forEach((out, i) => {
                        if (correctOutputs[i]) {
                            out.name = correctOutputs[i];
                            out.label = correctOutputs[i];
                        }
                    });
                }
                return r;
            };
        }
    },
});

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { XiaozhuguangVideoPlayer } from "./xzg_video_player.js";
import { xzgLang } from "./xzg_i18n.js";
import { xzgEnableCanvasPanOnSpace } from "./xzg_save_utils.js";

// ═══════════════════════════════════════════════════════════════════════
// 小珠光视频保存 - 双语翻译表
// ═══════════════════════════════════════════════════════════════════════
const _LABEL_MAP = {
    "图像": "Images",
    "帧率": "Frame Rate",
    "文件名前缀": "Filename Prefix",
    "格式": "Format",
    "CRF": "CRF",
    "模式": "Mode",
    "音频": "Audio",
    // 下拉值翻译
    "保存": "Save",
    "预览": "Preview",
    // CRF 注释翻译
    "数值越大质量越差 默认16": "Higher = lower quality, default 16",
};

function _tr(zh) {
    const lang = xzgLang();
    return (lang === "en" && _LABEL_MAP[zh]) ? _LABEL_MAP[zh] : zh;
}

// 与视频加载器一致：外部输入保留参数行，暗色显示并禁止本地编辑。
// 仅拦截前端的隐藏操作，保留 converted-widget 类型和连线序列化。
function _xzgKeepConvertedWidgetVisible(widget, node) {
    if (widget._xzgKeepConvertedVisible) return;
    widget._xzgKeepConvertedVisible = true;
    const isExternal = () => widget.type === 'converted-widget' ||
        node.inputs?.some(input => input.name === widget.name && input.link != null);
    widget.connectionSuppressed = false;
    let draw = widget.draw;
    let mouse = widget.mouse;
    let computeSize = widget.computeSize;
    const drawVisible = function (ctx, ...args) {
        ctx.save();
        try {
            if (isExternal()) ctx.globalAlpha *= 0.65;
            return draw?.call(this, ctx, ...args);
        } finally {
            ctx.restore();
        }
    };
    const mouseVisible = function (...args) {
        if (isExternal()) return true;
        return mouse?.apply(this, args);
    };
    const sizeVisible = function (width) {
        if (isExternal()) return [width, 20];
        return computeSize?.call(this, width) ?? [width, 20];
    };
    Object.defineProperties(widget, {
        connectionSuppressed: {
            configurable: true,
            get: () => false,
            set(_) { /* 外部连线仍提供参数，控件行保持可见。 */ },
        },
        draw: {
            configurable: true,
            get: () => drawVisible,
            set(value) { if (!isExternal() && value !== drawVisible) draw = value; },
        },
        mouse: {
            configurable: true,
            get: () => mouseVisible,
            set(value) { if (!isExternal() && value !== mouseVisible) mouse = value; },
        },
        computeSize: {
            configurable: true,
            get: () => sizeVisible,
            set(value) { if (!isExternal() && value !== sizeVisible) computeSize = value; },
        },
    });
}

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
            this.value = clamp(Math.round(this.value / step) * step);
        } else {
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

// Nodes 2 的控件使用独立画布。按真实行容器绘制并按 2x 位图重设尺寸，
// 不能混用缓存行宽、节点宽度和视口缩放后的位图宽度，否则首次加载和缩放后
// 字体缩放错误、行与行互相压盖（与视频加载器 _xzgVideoRowLayout 同一套方案）。
function _xzgVideoSaveRowLayout(ctx, node, width, y, H) {
    const canvas = ctx.canvas;
    const wrapper = canvas?.parentElement;
    if (canvas !== app.canvas?.canvas && canvas?.classList?.contains("cursor-crosshair")
        && wrapper?.clientWidth && wrapper?.clientHeight) {
        width = wrapper.clientWidth;
        H = wrapper.clientHeight;
        y = 0;
        canvas.style.width = width + "px";
        canvas.style.height = H + "px";
        if (canvas.width !== width * 2 || canvas.height !== H * 2) {
            canvas.width = width * 2;
            canvas.height = H * 2;
        }
        ctx.setTransform(2, 0, 0, 2, 0, 0);
        return [width, y, H];
    }
    const _nW = node?.size?.[0], _nH = node?.size?.[1];
    if (_nW != null && _nW > 0) width = Math.max(1, Math.min(width, _nW));
    if (_nH != null && _nH > 0) H = Math.max(1, Math.min(H, Math.max(0, _nH - y)));
    return [width, y, H];
}

function _xzgDrawWidget(ctx, node, width, y, H) {
    [width, y, H] = _xzgVideoSaveRowLayout(ctx, node, width, y, H);
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
    ctx.fillStyle = '#9ab';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const labelText = this._xzgLabel ? this._xzgLabel() : (this.label || this.name || '');
    ctx.fillText(labelText, pad + 6, y + H / 2);
    const valueText = String(this.value);
    ctx.fillStyle = this._xzgValueColor || '#fff';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(valueText, width - pad - 6, y + H / 2);
}

// combo / button 同款圆角风格
function _xzgDrawComboWidget(ctx, node, width, y, H) {
    [width, y, H] = _xzgVideoSaveRowLayout(ctx, node, width, y, H);
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
    const labelText = this._xzgLabel ? this._xzgLabel() : (this.label || this.name || '');
    const labelMaxW = width - pad * 2 - 54;
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
    const old = document.querySelector('.xzg-fps-dropdown');
    if (old) old.remove();

    const values = widget.options?.values || ["mp4", "webm", "gif"];
    const canvasRect = app.canvas?.canvas?.getBoundingClientRect?.();
    if (!canvasRect) return;

    let wx = event.clientX;
    let wy = event.clientY;
    if (!wx || !wy) {
        const pad = 16;
        const nodeX = (node.pos?.[0] || 0) * app.canvas.ds.scale + canvasRect.left;
        const nodeY = (node.pos?.[1] || 0) * app.canvas.ds.scale + canvasRect.top;
        const widgetIdx = node.widgets?.indexOf(widget) ?? 0;
        const widgetY = nodeY + node.widgets?.slice(0, widgetIdx).reduce((s, w) => s + (w.computeSize?.(node.size[0])?.[1] || 20), 0) || 0;
        wx = nodeX + node.size[0] * app.canvas.ds.scale - pad;
        wy = widgetY;
    }

    const dropdown = document.createElement('div');
    dropdown.className = 'xzg-fps-dropdown notranslate';
    dropdown.setAttribute('translate', 'no');
    dropdown.dataset.noTranslate = '1';
    dropdown.dataset.xzgFpsDropdown = '1';
    dropdown.style.cssText = `
        position: fixed; z-index: 99999;
        left: ${Math.max(4, wx - 60)}px; top: ${wy + 4}px;
        min-width: 80px;
        background: #2a2a2a; border: 1px solid #555; border-radius: 6px;
        padding: 4px 0; box-shadow: 0 4px 16px rgba(0,0,0,0.5);
    `;

    const createdItems = [];
    values.forEach(v => {
        const item = document.createElement('div');
        item.className = 'notranslate';
        item.setAttribute('translate', 'no');
        item.dataset.noTranslate = '1';
        const displayText = widget._xzgDisplayVal ? widget._xzgDisplayVal(String(v)) : String(v);
        item.dataset.xzgRawValue = String(v);
        item.dataset.xzgDisplay = displayText;
        item.textContent = displayText;
        createdItems.push({ el: item, expected: displayText, raw: String(v) });
        const selected = String(v) === String(widget.value);
        item.style.cssText = `
            padding: 4px 16px; cursor: pointer; font-size: 13px;
            color: ${selected ? '#FFD700' : '#ccc'};
            background: ${selected ? '#333' : 'transparent'};
        `;
        item.onmouseenter = () => { item.style.background = '#444'; };
        item.onmouseleave = () => { item.style.background = selected ? '#333' : 'transparent'; };
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

    // 兜底：对抗 PromptAssistant 等外部 MutationObserver 篡改下拉文字
    const repairIfTampered = () => {
        if (!document.body.contains(dropdown)) return;
        createdItems.forEach(({ el, expected }) => {
            if (el.textContent !== expected) {
                console.warn("[小珠光 video_save dropdown] 检测到外部插件篡改下拉项文本，已修复:",
                    JSON.stringify(el.textContent), "->", JSON.stringify(expected));
                el.textContent = expected;
            }
        });
    };
    Promise.resolve().then(repairIfTampered);
    setTimeout(repairIfTampered, 10);
    setTimeout(repairIfTampered, 50);

    dropdown.addEventListener('pointerdown', (e) => e.stopPropagation());

    const close = (e) => {
        if (!dropdown.contains(e.target)) {
            dropdown.remove();
            document.removeEventListener('pointerdown', close, true);
        }
    };
    document.addEventListener('pointerdown', close, true);

    document.body.appendChild(dropdown);
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

// 布尔开关 widget：与数值/combo 同款圆角深色块外观，
// 右侧显示 开/关（金色为开），点击整行切换 true/false
function _xzgDrawBoolWidget(ctx, node, width, y, H) {
    [width, y, H] = _xzgVideoSaveRowLayout(ctx, node, width, y, H);
    this._xzgDrawW = width;
    const pad = 16, r = 6;
    const w = width - pad * 2;
    ctx.fillStyle = '#2a2a2a';
    ctx.beginPath();
    if (ctx.roundRect) { ctx.roundRect(pad, y + 1, w, H - 2, r); } else { ctx.rect(pad, y + 1, w, H - 2); }
    ctx.fill();
    // 边框与其他选项同色，仅用右侧文字颜色区分开/关状态
    ctx.strokeStyle = '#444';
    ctx.stroke();
    // 左侧标签（超长省略）
    ctx.fillStyle = '#9ab';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const labelText = this._xzgLabel ? this._xzgLabel() : (this.label || this.name || '');
    const labelMaxW = width - pad * 2 - 54;
    if (ctx.measureText(labelText).width > labelMaxW) {
        let truncated = labelText;
        while (ctx.measureText(truncated + '…').width > labelMaxW && truncated.length > 0) truncated = truncated.slice(0, -1);
        ctx.fillText(truncated + '…', pad + 6, y + H / 2);
    } else {
        ctx.fillText(labelText, pad + 6, y + H / 2);
    }
    // 右侧：开 / 关 文本（开为金色）
    const displayText = this.value ? '开' : '关';
    ctx.fillStyle = this.value ? '#FFD700' : '#fff';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(displayText, width - pad - 16, y + H / 2);
}

function _xzgBoolWidgetMouse(event, [x, y], node) {
    if (event.type === 'pointerup') {
        this.value = !this.value;
        if (this.callback) this.callback(this.value);
        node.setDirtyCanvas?.(true, true);
    }
    return true;
}

function _xzgCreateBoolWidget(node, inputName, inputData) {
    const opts = inputData[1] || {};
    const w = {
        name: inputName,
        type: 'xzg-bool',
        value: !!opts.default,
        options: {},
        computeSize(width) { return [width, 20]; },
        draw: _xzgDrawBoolWidget,
        mouse: _xzgBoolWidgetMouse,
        callback(v) { if (this._xzgCb) this._xzgCb(v); },
    };
    if (!node.widgets) node.widgets = [];
    node.widgets.push(w);
    return w;
}

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

const VIDEO_PREVIEW_WIDGET_NAME = "xzg_video_combine_preview";
const VIDEO_PREVIEW_MIN_H = 100;

// Nodes 2.0（Vue 渲染节点）布局修正 —— 与「视频加载-化神级」_xzgFixVueWidgetGutter 同一套方案：
// 1) 原生 .lg-node-widgets 栅格给连接控件预留 12px 首列 + 左右 padding，会把自绘控件行
//    和 DOM 预览整体向右推（错乱根源），这里归零并让 canvas 行撑满；
// 2) WidgetLegacy 首次绘制可能早于行宽 CSS 生效，DOM 挂载/布局稳定后触发 triggerDraw 重绘，
//    避免自绘控件一直保留创建时的宽度。
function _xzgFixVueWidgetGutter(node) {
    if (!globalThis.LiteGraph?.vueNodesMode) return;
    const id = String(node?.id ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
    if (!id || id === "-1") return;
    const styleId = `xzg-video-save-widget-gutter-${id}`;
    if (!document.getElementById(styleId)) {
        const style = document.createElement("style");
        style.id = styleId;
        style.textContent = `
        [data-node-id="${id}"] .lg-node-widgets {
            padding-left: 0 !important;
            padding-right: 0 !important;
            row-gap: 2px !important;
            /* 原生第一列给连接控件预留 12px。控件仍在左侧内边距内显示，
               列本身不再把所有自绘行和 DOM 预览向右推。 */
            grid-template-columns: 0 minmax(80px, min-content) minmax(125px, 1fr) !important;
        }
        [data-node-id="${id}"] .lg-node-widgets div:has(> canvas) {
            width: 100% !important;
            margin-left: 0 !important;
            margin-right: 0 !important;
            min-width: 0 !important;
            box-sizing: border-box;
            line-height: 0;
        }
        [data-node-id="${id}"] .lg-node-widgets div > canvas { display: block; }
        [data-node-id="${id}"] .xzg-video-preview-container {
            padding-left: 8px;
            padding-right: 8px;
        }
    `;
        document.head.appendChild(style);
    }

    if (node._xzgVideoVueLayout?.id === id) return;
    node._xzgVideoVueLayout?.dispose();
    const state = { id, frame: 0, settlingFrames: 2, disposed: false, mountObserver: null, resizeObserver: null };
    const redraw = () => {
        state.frame = 0;
        if (state.disposed || !globalThis.LiteGraph?.vueNodesMode) return;
        // DOM 挂载和布局稳定后重绘独立控件画布 + 播放器尺寸
        for (const widget of node.widgets || []) {
            if (!widget.hidden) widget.triggerDraw?.();
        }
        node._xzgVideoPlayer?.resize?.();
        if (state.settlingFrames > 0) {
            state.settlingFrames--;
            schedule();
        }
    };
    const schedule = () => {
        if (!state.disposed && !state.frame) state.frame = requestAnimationFrame(redraw);
    };
    const watchLayout = () => {
        const grid = document.querySelector(`[data-node-id="${id}"] .lg-node-widgets`);
        if (!grid) return false;
        state.mountObserver?.disconnect();
        state.mountObserver = null;
        state.resizeObserver = new ResizeObserver(schedule);
        state.resizeObserver.observe(grid);
        schedule();
        return true;
    };
    state.dispose = () => {
        state.disposed = true;
        state.mountObserver?.disconnect();
        state.resizeObserver?.disconnect();
        if (state.frame) cancelAnimationFrame(state.frame);
        document.getElementById(styleId)?.remove();
    };
    node._xzgVideoVueLayout = state;
    if (!watchLayout()) {
        state.mountObserver = new MutationObserver(watchLayout);
        state.mountObserver.observe(document.body, { childList: true, subtree: true });
    }
}

// 模块级全局视频输出缓存：跨 tab 重建节点后恢复预览的关键
// key: `${工作流图指纹}|${节点 id}`；value: { filename, type, subfolder, frame_rate }
// 借鉴 ComfyUI 原生 setNodeOutputsByExecutionId 全局 store 思路：
// executed 事件到达时写入（节点实例存活时），切回 tab 重建节点后从此读取恢复。
//
// 关键：键必须含「工作流图指纹」——节点 id 只在单个工作流内唯一，不同工作流中
// id 相同的视频保存节点若共享裸 id 键，切换工作流后新节点的预览恢复会读到旧工作流
// 的输出（串台）。指纹随图结构变化而变化，跨工作流天然隔离。
const _xzgVideoOutputCache = new Map();

// 追踪「最近一次发起执行的图」：点击 Run 时会调用 app.queuePrompt，此刻 app.graph 即发起图。
// 这是跨工作流隔离 executed 输出的关键依据 —— 仅仅用指纹区分「缓存键」还不够：全局 executed
// 事件（api 的 "executed"）会广播给所有图里 id 相同的节点实例，若不判断「输出属于哪个图」，
// 切换到 B 工作流观察 A 的执行时，B 里 id 相同的节点实例也会收到 A 的输出并 load 进自己的预览区（串台）。
let _xzgRunningGraph = null;

// 发起执行时同步捕获：发起图的内容指纹 + 图内所有视频保存节点的 id 集合。
// 切走工作流 tab 可能销毁节点实例（节点级 executed 监听与播放器随之失效），
// 原工作流在后台跑完时输出只能靠模块级监听捕获 —— 指纹在 queuePrompt 时刻
// （发起图仍存活）计算并保存，不依赖图实例后续是否存活。
let _xzgRunningGraphFp = null;
let _xzgRunningGraphSaveIds = new Set();

// 按「工作流指纹|节点id」键的输出缓存：节点实例被销毁期间完成的执行，
// 切回工作流重建节点后由此恢复最新预览（与 localStorage 持久化等效的内存版）。
const _xzgVideoOutputCacheByFp = new Map();

// 工作流图结构指纹：以「节点 id→type 集合」为工作流身份。
// - 跨刷新稳定：刷新后图按 JSON 还原，指纹不变 → localStorage 恢复仍命中；
// - 跨工作流可区分：不同工作流结构不同 → 指纹不同 → 键不同 → 不串台；
// - 移动节点 / 编辑 widget 值不影响指纹；增删节点会改变指纹（旧缓存自然失效，不会误恢复）。
function _xzgGraphFingerprint(graph) {
    const parts = [];
    for (const n of (graph?.nodes || [])) {
        if (n && n.id != null && n.type) parts.push(String(n.id) + ":" + n.type);
    }
    parts.sort();
    // djb2 字符串哈希（稳定、无依赖），返回 32 位无符号数字字符串
    let h = 5381;
    for (const p of parts) {
        for (let i = 0; i < p.length; i++) {
            h = ((h << 5) + h + p.charCodeAt(i)) >>> 0;
        }
    }
    return String(h);
}

// 每个存活图实例的唯一运行时令牌（WeakMap 弱引用，不泄漏）。
// 根因：上面的指纹是「纯内容哈希（id:type 集合）」——两个结构完全相同的工作流（如复制得到）
// 会算出相同指纹，若模块缓存键用「指纹|节点id」，A 运行写入、随后切到 B，B 的 ResizeObserver/
// onConfigure 恢复就会从该共享键读到 A 的输出并 load 进 B 的预览区（跨工作流串台）。内容指纹
// 无法区分「内容相同但不同」的两个工作流，唯有图实例对象可以。这里用 WeakMap 为每个图分配唯一
// 递增令牌，让同会话内任意两个图（哪怕结构完全一致）都持有不同缓存键，从根源杜绝按共享键串台。
const _xzgGraphTokenMap = new WeakMap();
let _xzgGraphTokenSeq = 0;
function _xzgGraphToken(graph) {
    if (!graph) return "";
    let t = _xzgGraphTokenMap.get(graph);
    if (!t) { t = String(++_xzgGraphTokenSeq); _xzgGraphTokenMap.set(graph, t); }
    return t;
}

// 跨浏览器刷新的持久化恢复：写入 localStorage（key = `${指纹}_${节点 id}`）。
// 关键：绝不写入 node.properties / widget 序列化 —— 那会并入图/extra_pnginfo/签名，
// 破坏「上游未变时不重编码」的缓存命中。localStorage 不进 prompt，因此不影响缓存。
// 这样刷新后仍能恢复上次视频预览（对齐 VHS 刷新后仍有输出），又不牺牲缓存惰性。
// 说明：localStorage 仍按“内容指纹”键存（刷新后图是新实例、令牌会变，无法按令牌跨刷新恢复，
// 只能退回内容指纹）。刷新后同一标签页通常只加载一个工作流，指纹命中即本工作流，串台风险低；
// 会话内的实时跨工作流串台则由下方按“图实例令牌”键的模块缓存彻底杜绝。
const _xzgOutStoreKey = (wfFp, nodeId) => `xzg_video_combine_out_${wfFp}_${nodeId}`;
function _xzgPersistOutput(wfFp, nodeId, info) {
    try { localStorage.setItem(_xzgOutStoreKey(wfFp, nodeId), JSON.stringify(info)); } catch (e) { /* 忽略存储失败 */ }
}
function _xzgLoadPersistedOutput(wfFp, nodeId) {
    try { return JSON.parse(localStorage.getItem(_xzgOutStoreKey(wfFp, nodeId))); } catch (e) { return null; }
}
// 模块缓存键：图实例令牌 + 节点 id —— 同会话内两个图（即使结构完全一致）令牌不同 → 键不同 → 不串台
const _xzgCacheKey = (graph, nodeId) => `${_xzgGraphToken(graph)}|${nodeId}`;

function getVideoUrl(filename, type, subfolder, absToken) {
    if (!filename) return "";
    // 绝对路径输出：文件在 output/ 之外，/view 无法服务，走会话令牌拉流（后端注册守卫）
    if (absToken) {
        return `/xzg/davinci/view-abs?token=${encodeURIComponent(absToken)}`;
    }
    const params = new URLSearchParams({
        filename: filename,
        type: type || "output",
    });
    if (subfolder) params.set("subfolder", subfolder);
    // 注意：这里不带随机数（rand）。刷新到最新内容靠「文件名自增」天然实现——
    // 内容/输入变了文件名必变 → URL 变化 → 重新加载；同名文件（输入未变）则返回
    // 缓存命中项，避免每次渲染/恢复都因 URL 不同而强制重新下载、转圈读条。
    return `/view?${params.toString()}`;
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

// 在原生数值控件处理前消费点击，避免列表和 Value 输入框同时弹出。
function _xzgVideoSaveControlHit(event) {
    const canvas = app.canvas;
    const canvasEl = canvas?.canvas;
    if (!canvasEl || (event.target !== canvasEl && !canvasEl.contains?.(event.target))) return null;
    // 画布尚未初始化完成时（如工作流 configure 早期）该方法不存在，直接放行
    if (typeof canvas.convertEventToCanvasCoordinates !== "function") return null;
    const point = canvas.convertEventToCanvasCoordinates(event);
    for (const node of app.graph?.nodes || []) {
        if (node.type !== "XiaozhuguangVideoCombine" && node.type !== "XiaozhuguangVideoSaveDaVinci") continue;
        if (node.flags?.collapsed) continue;
        const x = point[0] - node.pos[0], y = point[1] - node.pos[1];
        for (const widget of node.widgets || []) {
            if (widget.name !== "格式" && widget.name !== "模式") continue;
            if (!Number.isFinite(widget._xzgControlY) || !Number.isFinite(widget._xzgControlH)) continue;
            if (x >= 16 && x <= widget._xzgDrawW - 16 &&
                y >= widget._xzgControlY && y <= widget._xzgControlY + widget._xzgControlH) {
                return { node, widget, x, y };
            }
        }
    }
    return null;
}

function _xzgPatchVideoSaveControlPointer() {
    // 扩展热重载/重复注册时，window 级捕获监听器会一层层叠加：每次点击被多个
    // stopImmediatePropagation 拦截，画布越来越卡，也容易引出各种诡异交互问题。
    if (window.__xzgVideoSavePointerPatched) return;
    window.__xzgVideoSavePointerPatched = true;
    let pendingControl = null;
    window.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        pendingControl = _xzgVideoSaveControlHit(event);
        if (!pendingControl) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
    }, true);
    window.addEventListener("pointerup", (event) => {
        if (!pendingControl) return;
        const { node, widget } = pendingControl;
        pendingControl = null;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        const hit = _xzgVideoSaveControlHit(event);
        if (hit?.node !== node || hit.widget !== widget) return;
        widget.mouse(event, [hit.x, hit.y], node);
    }, true);
    window.addEventListener("pointercancel", () => { pendingControl = null; }, true);
}

app.registerExtension({
    name: "xiaozhuguang.video_combine",
    init() {
        _xzgPatchVideoSaveControlPointer();
        // 记录「发起执行的图」：点击 Run 会走 app.queuePrompt，此刻 app.graph 即发起执行的图。
        // 之所以包 app.queuePrompt 而非 api.queuePrompt —— api.queuePrompt 会被本插件其它模块
        // （编组 / 水印）做一次性临时包装后随即还原，永久包进会把临时包装链拉长；而 app.queuePrompt
        // 无人永久包装，独立封装更稳。
        if (!app._xzgVideoCombineQueueHookInstalled && typeof app.queuePrompt === "function") {
            app._xzgVideoCombineQueueHookInstalled = true;
            const _xzgOrigAppQueuePrompt = app.queuePrompt;
            app.queuePrompt = function (...args) {
                const g = app.graph; // 同步取发起图（调用时 app.graph 是当前激活的图）
                const r = _xzgOrigAppQueuePrompt.apply(this, args);
                if (g) {
                    _xzgRunningGraph = g;
                    // 同步捕获发起图指纹与视频保存节点 id 集合（此刻图必然存活，
                    // 之后切 tab 销毁也不影响模块级 executed 兜底写入的键正确性）
                    _xzgRunningGraphFp = _xzgGraphFingerprint(g);
                    _xzgRunningGraphSaveIds = new Set(
                        (g.nodes || [])
                            .filter(n => n && n.id != null &&
                                (n.type === "XiaozhuguangVideoCombine" || n.type === "XiaozhuguangVideoSaveDaVinci"))
                            .map(n => String(n.id))
                    );
                }
                return r;
            };
        }

        // 模块级 executed 兜底监听（仅做持久化写入，不直接操作任何播放器 —— 不存在串台加载）：
        // 节点级 _onApiExecuted 能覆盖「节点实例存活」的全部场景；但切走工作流 tab 后节点实例
        // 可能被销毁，原工作流在后台跑完时节点级监听已失效，新输出无人写入缓存 —— 切回后
        // 重建的节点只能读到旧输出（用户反馈的"切回原工作流预览不更新"即此场景）。
        // 这里在 queuePrompt 时刻已捕获的「发起图指纹 + 视频保存节点 id 集合」约束下，
        // 把输出按「指纹|节点id」写入内存缓存与 localStorage，切回重建后即可恢复最新视频。
        // 铁律不变：只接受「发起本次执行的图」里视频保存节点的输出，绝不跨工作流写入。
        if (!app._xzgVideoCombineGlobalExecutedInstalled && typeof api?.addEventListener === "function") {
            app._xzgVideoCombineGlobalExecutedInstalled = true;
            api.addEventListener("executed", (event) => {
                try {
                    const detail = event.detail;
                    if (!detail || !detail.output) return;
                    if (!_xzgRunningGraphFp || _xzgRunningGraphSaveIds.size === 0) return;
                    const execNode = String(detail.node || detail.display_node || "");
                    const localId = execNode.split(":").pop();
                    if (!_xzgRunningGraphSaveIds.has(localId)) return;
                    const ui = detail.output.ui || detail.output;
                    const videos = ui?.videos || ui?.video;
                    if (!Array.isArray(videos) || videos.length === 0) return;
                    const v = videos[0];
                    const info = {
                        filename: v.filename || "",
                        type: v.type || "output",
                        subfolder: v.subfolder || "",
                    };
                    if (!info.filename) return;
                    // 绝对路径输出：令牌随缓存/持久化传递，供恢复时经 /xzg/davinci/view-abs 拉流
                    if (v.abs_token) info.abs_token = v.abs_token;
                    // 达芬奇节点在「预览 + 自定义输出」下使用的目录副本令牌。
                    if (v.davinci_abs_token) info.davinci_abs_token = v.davinci_abs_token;
                    if (v.is_absolute) info.is_absolute = v.is_absolute;
                    if (typeof v.frame_rate === "number" && v.frame_rate > 0) info.frame_rate = v.frame_rate;
                    if (typeof v.frame_count === "number" && v.frame_count > 0) info.frame_count = v.frame_count;
                    _xzgVideoOutputCacheByFp.set(`${_xzgRunningGraphFp}|${localId}`, info);
                    _xzgPersistOutput(_xzgRunningGraphFp, localId, info);
                } catch (e) { /* 兜底监听不影响主流程 */ }
            });
        }
    },
    getCustomWidgets() {
        return {
            XZGINT: (node, name, data) => _xzgCreateNumberWidget(node, name, data),
            XZGFLOAT: (node, name, data) => _xzgCreateNumberWidget(node, name, data),
            XZGBOOL: (node, name, data) => _xzgCreateBoolWidget(node, name, data),
        };
    },
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        // 化神级保存节点（XiaozhuguangVideoSaveDaVinci）复用本注册器的全部预览/缓存/恢复逻辑
        if (nodeData?.name !== "XiaozhuguangVideoCombine" &&
            nodeData?.name !== "XiaozhuguangVideoSaveDaVinci") return;

        // 给 combo widget（格式、模式）设置 XZGINT 类型，避免原生 combo 下拉列表
        // 模式：仅需点击切换 保存/预览，不弹列表
        for (const inp of Object.values({ ...nodeData.input?.required, ...nodeData.input?.optional })) {
            if (Array.isArray(inp[0]) && typeof inp[1] === 'object') {
                inp[1].widgetType = "XZGINT";
            }
        }

        for (const inp of Object.values({ ...nodeData.input?.required, ...nodeData.input?.optional })) {
            if (["INT", "FLOAT"].includes(inp[0]) && inp[1]) {
                inp[1].widgetType ??= "XZG" + inp[0];
            }
        }

        // BOOLEAN 开关（如「自动导出到达芬奇」「默认输出」）改用 XZGBOOL 同款圆角深色块外观，
        // 与数值/combo 保持统一（原生 ComfyUI 复选框是其风格不一致的根源）
        for (const [inpName, inp] of Object.entries({ ...nodeData.input?.required, ...nodeData.input?.optional })) {
            if (inp && inp[0] === "BOOLEAN" && ["自动导出到达芬奇", "use_default_output"].includes(inpName)) {
                if (!inp[1]) inp[1] = {};
                inp[1].widgetType = "XZGBOOL";
            }
        }

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origOnNodeCreated?.apply(this, arguments);

            const node = this;

            // 工作流图指纹：跨工作流隔离预览缓存的关键（写入/恢复键的一部分）。
            // 加载工作流时 configure 逐个创建节点、图此时未建全，这里只作兜底，
            // 由 onConfigure 的 rAF 阶段（整图就绪）重算覆盖；用户手动新建节点时图已就绪。
            node._xzgWfFp = _xzgGraphFingerprint(node.graph);

            const playerContainer = document.createElement("div");
            playerContainer.style.width = "100%";
            playerContainer.style.background = "#1a1a1a";
            playerContainer.style.position = "relative";
            playerContainer.style.pointerEvents = "none";
            // 启用空格+拖动平移画布（DOM widget 默认会拦截 pointer 事件）
            xzgEnableCanvasPanOnSpace(playerContainer);

            // Bypass 紫色覆盖层
            const bypassOverlay = document.createElement("div");
            bypassOverlay.style.cssText =
                "position:absolute;inset:0;background-color:rgba(106,36,106,0.6);pointer-events:none;z-index:100;display:none;";
            playerContainer.appendChild(bypassOverlay);

            const updateBypassState = () => {
                if (node.mode === 4) {
                    bypassOverlay.style.display = "block";
                } else {
                    bypassOverlay.style.display = "none";
                }
            };
            updateBypassState();
            node._xzgUpdateBypassState = updateBypassState;

            // 仅 Nodes 2 使用 flex 收缩布局；Nodes 1 保留原来的播放器布局（与视频加载器一致）
            const useVueResizeLayout = !!globalThis.LiteGraph?.vueNodesMode;
            // Nodes 2.0（Vue）：预览元素会被 grid 宿主（WidgetDOM 的 *:flex-1 拉伸）和
            // 固定定位 overlay 争抢挂载，height:100% 百分比在 auto 高度宿主里会退化，
            // 视频会溢出节点被裁剪。显式钉死 px 高度（与 computeLayoutSize.minHeight
            // 一致）并关掉 flex 拉伸，让 grid 行高/节点测量/overlay 几何三边一致。
            const applyPreviewHostLayout = (enabled) => {
                if (enabled) {
                    playerContainer.style.flex = "0 0 auto";
                    playerContainer.style.height = `${VIDEO_PREVIEW_MIN_H}px`;
                } else {
                    playerContainer.style.flex = "";
                    playerContainer.style.height = "100%";
                }
            };
            applyPreviewHostLayout(useVueResizeLayout);
            const player = new XiaozhuguangVideoPlayer({
                node,
                container: playerContainer,
                placeholderText: "🎬 暂无视频",
                flexContainer: useVueResizeLayout,
                flexMinHeight: useVueResizeLayout ? VIDEO_PREVIEW_MIN_H : 0,
                maxVideoHeight: useVueResizeLayout ? VIDEO_PREVIEW_MIN_H : 0,
                onSaveToDesktop: () => {
                    const url = player.getSrc();
                    if (!url) return;
                    XiaozhuguangVideoPlayer.downloadVideo(url, _extractFilename(url));
                },
            });

            node.resizable = true;
            node.minWidth = 300;
            // Nodes 1 保留原来的尺寸下限；Nodes 2 的预览最小高度由 DOM widget 的
            // computeLayoutSize 提供，强制 minHeight=500 会让 Vue 布局出现大片空白/错乱。
            if (!globalThis.LiteGraph?.vueNodesMode) node.minHeight = 500;
            const origSetSize = node.setSize;
            node.setSize = function(sizeOrWidth, height) {
                // LiteGraph 的 node.size 可以是 Float32Array，不能仅用 Array.isArray 判断。
                const usesNumbers = typeof sizeOrWidth === "number";
                const size = usesNumbers ? [sizeOrWidth, height] : sizeOrWidth;
                size[0] = Math.max(Number(size[0]) || 0, this.minWidth || 300);
                // LiteGraph 的 computeSize 接收的是输出数组而不是宽度数字。
                const requiredHeight = globalThis.LiteGraph?.vueNodesMode
                    ? (this.computeSize?.()?.[1] || 0)
                    : (this.minHeight || 500);
                size[1] = Math.max(Number(size[1]) || 0, requiredHeight);
                // LiteGraph setSize 的正式签名始终接收 [width, height]，
                // 即使上游在 Nodes 2 路径传入两个数字，也统一归一化回数组。
                const args = usesNumbers ? [size] : [size];
                return origSetSize?.apply(this, args);
            };
            node.setSize([300, 500]);

            // onNodeCreated 时 LiteGraph 还可能给节点临时 id=-1；等节点真正加入画布后
            // 再按真实 data-node-id 注入 Nodes 2 的行宽修正样式。
            const origOnAdded = node.onAdded;
            node.onAdded = function () {
                const result = origOnAdded?.apply(this, arguments);
                _xzgFixVueWidgetGutter(this);
                return result;
            };
            
            // 获取目录路径
            const modeWidget = node.widgets.find(w => w.name === '模式');

            const updateOutputDirDisplay = async () => {
                try {
                    const response = await api.fetchApi('/xzg/get_output_dir');
                    const data = await response.json();
                    const isSave = (modeWidget?.value ?? '保存') !== '预览';
                    const baseDir = isSave ? data.output_dir : (data.output_dir + '/preview/' + node.id);
                    node._xzgFullOutputDir = baseDir;
                    node.setDirtyCanvas(true, true);
                } catch (e) {
                    console.error('[小珠光视频保存] 获取输出目录失败:', e);
                }
            };
            updateOutputDirDisplay();

            const previewWidget = node.addDOMWidget(
                VIDEO_PREVIEW_WIDGET_NAME,
                "video",
                playerContainer,
                {
                    hideOnZoom: false,
                    getValue() {
                        // 优先从 properties 读取（跨 tab 重建后 player._videoInfo 会丢失）
                        const info = node.properties?._xzgVideoOutput || player._videoInfo;
                        return info ? {
                            filename: info.filename || "",
                            type: info.type || "output",
                            subfolder: info.subfolder || "",
                        } : null;
                    },
                    setValue(v) {
                        if (!v) { player.load(""); return; }
                        if (typeof v === "string") {
                            // 旧版兼容：仅 URL 字符串
                            if (v !== player.src) player.load(v);
                            return;
                        }
                        const filename = v.filename;
                        const type = v.type || "output";
                        const subfolder = v.subfolder || "";
                        if (!filename) { player.load(""); return; }
                        // 同 key 不重载（与 onExecuted / onConfigure 共用 player._lastAppliedKey）：
                        // 恢复/渲染时同名文件不再强制重新下载，消除无谓转圈读条。
                        const key = `${filename}|${type}|${subfolder}`;
                        if (player._lastAppliedKey === key) return;
                        // 关键：只在「同一会话内」由真实执行事件写入模块级 cache 时才拉流（键含工作流指纹）。
                        // 浏览器刷新后反序列化会触发 setValue，此时模块 cache 为空但 properties 里
                        // 有旧文件 —— 若直接 load 就会一进界面就转圈读条（对齐 VHS，configure 不拉流）。
                        // 切工作流后图实例令牌会变，令牌键必然落空，这里补查一次指纹键，
                        // 避免「刚执行过、缓存里明明有最新输出」却被误判成刷新而拒绝加载。
                        const sameGraphCached = node.graph
                            ? _xzgVideoOutputCache.get(_xzgCacheKey(node.graph, String(node.id)))
                            : null;
                        const sameFpCached = node.graph
                            ? _xzgVideoOutputCacheByFp.get(`${_xzgGraphFingerprint(node.graph)}|${String(node.id)}`)
                            : null;
                        if (!sameGraphCached && !sameFpCached) return;
                        // 只有确认要加载后才占用去重键：否则这里 return 会把 key 提前标记成
                        // 「已应用」，后续 onConfigure / executed 的同 key 恢复全部被跳过。
                        player._lastAppliedKey = key;
                        const url = getVideoUrl(filename, type, subfolder, v.abs_token);
                        if (url) {
                            const info = { filename, type, subfolder };
                            // 权威总帧数：复用执行时写入的 player._videoInfo.frame_count（load 不清 _backendFrameCount）
                            if (player._videoInfo?.frame_count) info.frame_count = player._videoInfo.frame_count;
                            player._videoInfo = info;
                            if (info.frame_count) player.setBackendFrameCount?.(info.frame_count);
                            // 注意：不再把文件名写进 node.properties —— 那会并入图/extra_pnginfo，
                            // 改变缓存签名导致每次运行都重编码。预览恢复只走模块级 _xzgVideoOutputCache。
                            player.load(url);
                        }
                    },
                }
            );

            previewWidget.computeLayoutSize = function () {
                return { minHeight: VIDEO_PREVIEW_MIN_H, minWidth: 0 };
            };
            // 修复：ComfyUI（属性面板/线性模式渲染等）会把 DOM widget 的 width 写成
            // 面板侧行宽度，而画布侧 DOM 宿主宽度 = widget.width - margin*2，
            // 一旦该值大于节点实际宽度，预览区就会溢出节点（随属性面板开/关变化）。
            // 这里把 width 定义为只读访问器，始终跟随节点实际宽度，忽略污染性写入。
            Object.defineProperty(previewWidget, 'width', {
                configurable: true,
                get() { return node.size?.[0] || 0; },
                set(_) { /* 忽略外部写入，防止预览区溢出节点 */ },
            });

            // 关键修复：预览为「纯展示」widget，禁止序列化进 prompt/图（getValue 返回的
            // 文件名每次执行都变化，一旦进入 widgets_values/extra_pnginfo 就会改变 ComfyUI
            // 节点缓存签名，导致「上游输入未变时仍被判定为变化 → 每次都重编码合成」）。
            // 对齐官方 audioUI 的 `serialize=false` 范式，使节点缓存可命中、输入不变不再读条。
            previewWidget.serialize = false;
            if (previewWidget.options) previewWidget.options.serialize = false;

            previewWidget.onRemove = () => {
                player.destroy();
            };

            const origOnResize = node.onResize;
            node.onResize = function (size) {
                const r = origOnResize?.apply(this, arguments);
                requestAnimationFrame(() => player.resize());
                return r;
            };

            const origOnRemoved = node.onRemoved;
            node.onRemoved = function () {
                api.removeEventListener("executed", _onApiExecuted);
                _visibilityObserver.disconnect();
                modeSettings?.removeEventListener?.("Comfy.VueNodes.Enabled.change", onVueModeChanged);
                if (vueModeFrame) cancelAnimationFrame(vueModeFrame);
                this._xzgVideoVueLayout?.dispose();
                this._xzgVideoVueLayout = null;
                player.destroy();
                return origOnRemoved?.apply(this, arguments);
            };

            const origOnConfigure = node.onConfigure;
            node.onConfigure = function (info) {
                origOnConfigure?.apply(this, arguments);
                requestAnimationFrame(() => {
                    // 加载工作流/切 tab 重建时，configure 是逐个节点执行的，同步阶段图中节点
                    // 可能尚未建全；rAF 阶段整图已就绪，这里统一重算指纹（覆盖 onNodeCreated 兜底）
                    _xzgFixVueWidgetGutter(node);
                    node._xzgWfFp = _xzgGraphFingerprint(node.graph);
                    const wfFp = node._xzgWfFp;
                    player.resize();
                    if (player._destroyed) return;
                    // 切 tab 重建 / 加载工作流 / 浏览器刷新后恢复视频预览。
                    // 取值优先级：本会话模块 cache（图实例键，真实执行）→ 按指纹的模块 cache
                    // （节点销毁期间由模块级兜底监听写入，见 init）→ localStorage 持久化（跨刷新）→ 旧 properties 兜底。
                    // 键含工作流图指纹：不同工作流即使节点 id 相同也不会读到彼此的预览（防串台）。
                    // 有可用的持久化输出就恢复加载（对齐 VHS 刷新后仍有图）；播放器加载动画已隐藏，不会转圈。
                    const moduleCached = node.graph ? _xzgVideoOutputCache.get(_xzgCacheKey(node.graph, String(node.id))) : null;
                    const fpCached = wfFp ? _xzgVideoOutputCacheByFp.get(`${wfFp}|${String(node.id)}`) : null;
                    const saved = moduleCached || fpCached || (wfFp ? _xzgLoadPersistedOutput(wfFp, String(node.id)) : null) || node.properties?._xzgVideoOutput;
                    if (saved && saved.filename) {
                        const key = `${saved.filename}|${saved.type || ""}|${saved.subfolder || ""}`;
                        // 同 key 恢复时跳过重复加载（避免无谓网络解码）
                        if (player._lastAppliedKey === key) return;
                        player._lastAppliedKey = key;
                        player._videoInfo = saved;
                        if (saved.frame_rate) player.setFrameRate?.(saved.frame_rate);
                        if (saved.frame_count) player.setBackendFrameCount?.(saved.frame_count);
                        const url = getVideoUrl(saved.filename, saved.type, saved.subfolder, saved.abs_token);
                        if (url) {
                            // 后台标签页不立即加载（解码管线停摆会卡死），记 pending 等回前台补加载
                            const visible = !document.hidden
                                && playerContainer.clientWidth > 0 && playerContainer.clientHeight > 0;
                            if (visible) {
                                player.load(url);
                            } else {
                                player._pendingVideoUrl = url;
                            }
                        }
                    }
                });
            };

            // 执行完成后加载输出视频
            // 提取为独立函数，供 onExecuted 和 api executed 事件共用
            // 关键：视频信息同步写入 node.properties，跨 tab 重建后可恢复
            // （借鉴 ComfyUI 原生 setNodeOutputsByExecutionId 全局 store 思路）
            const _applyVideoOutput = (output) => {
                if (!output || !player) return;
                const ui = output.ui || output;

                // 更新输出目录显示（使用执行返回的路径）
                if (ui?.output_dir) {
                    node._xzgFullOutputDir = ui.output_dir;
                    node.setDirtyCanvas(true, true);
                }

                // 兼容 output.videos / output.video 两种字段名
                const videos = ui?.videos || ui?.video;
                if (Array.isArray(videos) && videos.length > 0) {
                    const v = videos[0];
                    const info = {
                        filename: v.filename || "",
                        type: v.type || "output",
                        subfolder: v.subfolder || "",
                    };
                    if (typeof v.frame_rate === "number" && v.frame_rate > 0) {
                        info.frame_rate = v.frame_rate;
                    }
                    if (typeof v.frame_count === "number" && v.frame_count > 0) {
                        info.frame_count = v.frame_count;
                    }
                    // 绝对路径输出：令牌随缓存/持久化传递，供恢复时经 /xzg/davinci/view-abs 拉流
                    if (v.abs_token) info.abs_token = v.abs_token;
                    // 达芬奇节点在「预览 + 自定义输出」下使用的目录副本令牌。
                    if (v.davinci_abs_token) info.davinci_abs_token = v.davinci_abs_token;
                    if (v.is_absolute) info.is_absolute = v.is_absolute;
                    // 关键：先写入模块级全局 cache（按图实例令牌键，杜绝跨工作流串台）
                    // 切 tab 重建节点后，onConfigure/ResizeObserver 从此读取恢复预览。
                    // 指纹实时算：切工作流后节点实例可能被复用但不重走 onConfigure，
                    // 缓存的 _xzgWfFp 会停留在上一个工作流，键一错下面的恢复就全部打不中。
                    const wfFp = node.graph ? _xzgGraphFingerprint(node.graph) : node._xzgWfFp;
                    if (node.graph) {
                        node._xzgWfFp = wfFp;
                        // 模块缓存按“图实例令牌”键 —— 同会话内两个结构完全相同的工作流也会分持不同键，杜绝串台。
                        _xzgVideoOutputCache.set(_xzgCacheKey(node.graph, String(node.id)), info);
                        // 同时写一份「指纹键」：节点重建（令牌变化）后仍能命中最新值，
                        // 不必回落到 node.properties 里那份旧快照。
                        _xzgVideoOutputCacheByFp.set(`${wfFp}|${String(node.id)}`, info);
                        // localStorage 仍按“内容指纹”键（跨刷新恢复用，见 _xzgPersistOutput 注释）。
                        if (wfFp) _xzgPersistOutput(wfFp, String(node.id), info);
                    }
                    // player 已销毁时只存信息，等重建后由 onConfigure 恢复
                    if (player._destroyed) return;
                    // 去重：仅当输出 key（filename|type|subfolder）真变化时才重新加载，
                    // 与 VHS VideoCombine 前端一致（对返回参数做内容 diff）。
                    // - 同一次执行 onExecuted 与 api executed 重复触发 → key 相同 → 跳过
                    // - 后端缓存命中返回同一文件（输入未变）→ key 相同 → 跳过，不再无谓读条
                    // - 输入/内容真变了，后端重编码生成新文件名 → key 变化 → 重新加载刷新预览
                    const key = `${info.filename}|${info.type}|${info.subfolder}`;
                    if (player._lastAppliedKey === key) return;
                    player._lastAppliedKey = key;
                    player._videoInfo = info;
                    const url = getVideoUrl(info.filename, info.type, info.subfolder, info.abs_token);
                    if (url) {
                        if (info.frame_rate) player.setFrameRate?.(info.frame_rate);
                        // 总帧数优先用后端实测值：setBackendFrameCount 存入播放器权威帧数（load 不清空、
                        // 加载完成后优先采用；容器时长×帧率推算会因音轨尾差虚高 1 帧，如 459→460）
                        if (info.frame_count) player.setBackendFrameCount?.(info.frame_count);
                        // 容器可见且浏览器前台时才立即加载。后台标签页里 rAF/seek 解码管线
                        // 全部停摆，直接 load 会卡死在旧画面且回前台无人重触发（ResizeObserver
                        // 因 DOM 尺寸不变而不触发）；先记 pending，由播放器的 visibilitychange
                        // 兜底在回前台时补加载。
                        const visible = !document.hidden
                            && playerContainer.clientWidth > 0 && playerContainer.clientHeight > 0;
                        if (visible) {
                            player.load(url);
                        } else {
                            player._pendingVideoUrl = url;
                        }
                    }
                }
            };

            const origOnExecuted = node.onExecuted;
            node.onExecuted = function (output) {
                origOnExecuted?.apply(this, arguments);
                // 跨工作流铁律：只有「发起本次执行的图」（_xzgRunningGraph）里的本节点才允许应用输出。
                // 切到 B 工作流观察 A 的执行时，ComfyUI 会让当前图（B）里 id 相同的节点也触发
                // onExecuted；此判断拒绝掉，避免 A 的输出串到 B 的预览区。
                if (_xzgRunningGraph && this.graph && this.graph !== _xzgRunningGraph) return;
                _applyVideoOutput(output);
            };

            // 补充：监听 api executed 事件，解决切换工作流后 onExecuted 不触发的问题。
            // ComfyUI 前端只在当前 rootGraph 中查找节点调用 onExecuted，切换 tab 后
            // 原工作流的节点不在当前 rootGraph 中，onExecuted 不会被调用。
            const _onApiExecuted = (event) => {
                const detail = event.detail;
                if (!detail || !detail.output) return;
                // 匹配节点 id（兼容子图 executionId 格式 "parentId:childId"，取最后一段）
                const execNode = String(detail.node || detail.display_node || "");
                const localId = execNode.split(":").pop();
                if (localId !== String(node.id)) return;
                // 跨工作流铁律：仅接受「发起本次执行的图」里本节点的输出。全局 executed 事件会
                // 广播给所有图里 id 相同的节点实例；若不判断图归属，A 工作流的输出会被 B 里 id 相同
                // 的节点写进自己的缓存并 load 到 B 的预览区（串台）。
                if (_xzgRunningGraph && node.graph && node.graph !== _xzgRunningGraph) {
                    // 新版前端的 app.graph 与 node.graph 可能是同一工作流的两个包装实例，
                    // 直接用引用比较会把本图自己的输出误判成他图丢弃（预览一直停在旧视频）。
                    // 引用不等时退一步比内容指纹，指纹一致就仍按本图处理。
                    const runningFp = _xzgRunningGraphFp || _xzgGraphFingerprint(_xzgRunningGraph);
                    const nodeFp = _xzgGraphFingerprint(node.graph);
                    if (!runningFp || !nodeFp || runningFp !== nodeFp) return;
                }
                // 无条件调用：_applyVideoOutput 内部会先写模块级 cache（即使 player 销毁），
                // 再判断 player 是否可用决定是否立即 load
                _applyVideoOutput(detail.output);
            };
            api.addEventListener("executed", _onApiExecuted);

            // 监听容器可见性变化：切 tab 时 DOM widget 容器尺寸变为 0，
            // 切回时从 0 变为非 0。此时若有待加载视频就 load，确保预览刷新。
            let _containerVisible = playerContainer.clientWidth > 0 && playerContainer.clientHeight > 0;
            const _visibilityObserver = new ResizeObserver(() => {
                if (player._destroyed) return;
                const visible = playerContainer.clientWidth > 0 && playerContainer.clientHeight > 0;
                if (visible && !_containerVisible) {
                    // 容器从不可见变为可见（切回 tab）
                    if (player._pendingVideoUrl) {
                        const url = player._pendingVideoUrl;
                        player._pendingVideoUrl = null;
                        player.load(url);
                    } else if (player.getSrc() && player._currentDecoder) {
                        // 已有视频，重新渲染当前帧（canvas 在不可见时可能渲染异常）
                        player.seek(player._currentTime || 0);
                        player._updateSurfaceSize?.();
                    } else {
                        // player 无视频但有缓存记录：模块 cache（图实例键/指纹键）/ localStorage 持久化 / 旧 properties 兜底，
                        // 恢复加载（覆盖 onConfigure 恢复时机遗漏的场景）；播放器加载动画已隐藏，不转圈。
                        const wfFp = node.graph ? _xzgGraphFingerprint(node.graph) : node._xzgWfFp;
                        if (node.graph) node._xzgWfFp = wfFp;
                        const moduleCached = node.graph ? _xzgVideoOutputCache.get(_xzgCacheKey(node.graph, String(node.id))) : null;
                        const fpCached = wfFp ? _xzgVideoOutputCacheByFp.get(`${wfFp}|${String(node.id)}`) : null;
                        const saved = moduleCached || fpCached || (wfFp ? _xzgLoadPersistedOutput(wfFp, String(node.id)) : null) || node.properties?._xzgVideoOutput;
                        if (saved && saved.filename) {
                            const key = `${saved.filename}|${saved.type || ""}|${saved.subfolder || ""}`;
                            player._videoInfo = saved;
                            if (player._lastAppliedKey !== key) {
                                player._lastAppliedKey = key;
                                player._videoInfo = saved;
                                if (saved.frame_rate) player.setFrameRate?.(saved.frame_rate);
                                if (saved.frame_count) player.setBackendFrameCount?.(saved.frame_count);
                                const url = getVideoUrl(saved.filename, saved.type, saved.subfolder, saved.abs_token);
                                if (url) player.load(url);
                            }
                        }
                    }
                }
                _containerVisible = visible;
            });
            _visibilityObserver.observe(playerContainer);

            // 模式切换保留节点实例，不会重新执行 onAdded/onConfigure。
            // 因此必须显式重建新 DOM 的布局监听，并同步播放器布局（与视频加载器一致）。
            const modeSettings = app.ui?.settings;
            let vueModeFrame = 0;
            const onVueModeChanged = () => {
                if (vueModeFrame) cancelAnimationFrame(vueModeFrame);
                vueModeFrame = requestAnimationFrame(() => {
                    vueModeFrame = 0;
                    node._xzgVideoVueLayout?.dispose();
                    node._xzgVideoVueLayout = null;
                    const enabled = !!globalThis.LiteGraph?.vueNodesMode;
                    if (enabled) delete node.minHeight;
                    else node.minHeight = 500;
                    player.setFlexLayout(enabled, VIDEO_PREVIEW_MIN_H, VIDEO_PREVIEW_MIN_H);
                    applyPreviewHostLayout(enabled);
                    _xzgFixVueWidgetGutter(node);
                    player.resize();
                    node.setDirtyCanvas?.(true, true);
                });
            };
            modeSettings?.addEventListener?.("Comfy.VueNodes.Enabled.change", onVueModeChanged);

            node._xzgVideoPlayer = player;
            // 暴露预览容器（DOM 宿主），供化神级保存节点在其上叠加「导出到达芬奇」按钮
            node._xzgPreviewContainer = playerContainer;

            _xzgPatchCanvasPrompt();

            // 统一渲染风格：combo 用圆角 draw；所有 widget 加双语 label / value 显示
            for (const w of this.widgets || []) {
                // 修复（同「视频/音频」栏）：ComfyUI 会把 widget.width 写成面板侧行宽度，
                // 一旦大于节点实际宽度，行绘制/交互命中区就会溢出节点、且随属性面板开/关变化。
                // 这里把 width 改为只读访问器，始终跟随节点实际宽度，忽略污染性写入。
                if (w.name !== VIDEO_PREVIEW_WIDGET_NAME && !w._xzgWidthFixed) {
                    w._xzgWidthFixed = true;
                    try {
                        Object.defineProperty(w, 'width', {
                            configurable: true,
                            get() { return node.size?.[0] || 0; },
                            set(_) { /* 忽略外部写入，防止行溢出节点 */ },
                        });
                    } catch (_) {}
                }
                // 与「视频加载-化神级」同一套做法：创建控件时就把 label 写死，
                // 这样 ComfyUI 把控件转成输入端口后端口名才有字（只靠 _xzgLabel 自绘不够，
                // 会只剩一个圆点，如「帧率」连上上游后名称消失）
                if (w && !w.label) w.label = _tr(w.name);
                // 给每个 widget 绑定动态双语 label（随语言切换）
                if (w.name === '帧率' || w.name === '文件名前缀' || w.name === '格式' || w.name === 'CRF' || w.name === '模式') {
                    w._xzgLabel = () => _tr(w.name);
                }
                if (w.name === '格式') {
                    w.draw = function(ctx, nd, width, y, H) {
                        [width, y, H] = _xzgVideoSaveRowLayout(ctx, nd, width, y, H);
                        this._xzgControlY = y;
                        this._xzgControlH = H;
                        _xzgDrawComboWidget.call(this, ctx, nd, width, y, H);
                    };
                    w.mouse = _xzgFpsComboMouse;
                    w.value = String(w.value ?? "mp4");
                    w.options = w.options || {};
                    w.options.values = ["mp4", "webm", "gif"];
                    // 格式：保持英文原样（技术名词不翻译）
                    w._xzgDisplayVal = (v) => String(v);
                } else if (w.name === '帧率') {
                    w.draw = _xzgDrawWidget;
                    w._xzgValueColor = '#fff';
                    if (typeof w.mouse !== 'function') w.mouse = _xzgWidgetNumberMouse;
                } else if (w.name === '文件名前缀') {
                    // STRING 文本框：圆角矩形 + 标签 + 值
                    w.draw = _xzgDrawWidget;
                    if (!w._xzgValueColor) w._xzgValueColor = '#fff';
                } else if (w.name === 'CRF') {
                    w.draw = function(ctx, node, width, y, H) {
                        [width, y, H] = _xzgVideoSaveRowLayout(ctx, node, width, y, H);
                        this._xzgDrawW = width;
                        const pad = 16, r = 6;
                        const wr = width - pad * 2;
                        ctx.fillStyle = '#2a2a2a';
                        ctx.beginPath();
                        if (ctx.roundRect) { ctx.roundRect(pad, y + 1, wr, H - 2, r); } else { ctx.rect(pad, y + 1, wr, H - 2); }
                        ctx.fill();
                        ctx.strokeStyle = '#444';
                        ctx.stroke();
                        // 左侧标签
                        ctx.fillStyle = '#9ab';
                        ctx.font = '12px sans-serif';
                        ctx.textAlign = 'left';
                        ctx.textBaseline = 'middle';
                        ctx.fillText((this._xzgLabel ? this._xzgLabel() : (this.label || this.name || '')), pad + 6, y + H / 2);
                        // 右侧数值
                        const valueText = String(this.value);
                        ctx.font = '14px sans-serif';
                        const vw = ctx.measureText(valueText).width;
                        ctx.fillStyle = '#fff';
                        ctx.textAlign = 'right';
                        ctx.fillText(valueText, width - pad - 6, y + H / 2);
                        // 注释文字（右对齐，在数值左侧）
                        ctx.fillStyle = '#555';
                        ctx.font = '10px sans-serif';
                        ctx.textAlign = 'right';
                        ctx.fillText(_tr('数值越大质量越差 默认16'), width - pad - 6 - vw - 10, y + H / 2);
                    };
                } else if (w.name === '模式') {
                    // 模式：保存/预览 切换开关（与音频保存一致）
                    w.value = String(w.value ?? "保存");
                    w.options = w.options || {};
                    w.options.values = ["保存", "预览"];
                    w._xzgDisplayVal = (v) => _tr(String(v));
                    w.draw = function(ctx, nd, width, y, H) {
                        [width, y, H] = _xzgVideoSaveRowLayout(ctx, nd, width, y, H);
                        this._xzgDrawW = width;
                        this._xzgControlY = y;
                        this._xzgControlH = H;
                        const pad = 16, r = 6, wr = width - pad * 2;
                        ctx.fillStyle = '#2a2a2a';
                        ctx.beginPath();
                        if (ctx.roundRect) ctx.roundRect(pad, y + 1, wr, H - 2, r); else ctx.rect(pad, y + 1, wr, H - 2);
                        ctx.fill();
                        ctx.strokeStyle = '#444';
                        ctx.stroke();
                        // 左侧标签
                        ctx.fillStyle = '#9ab';
                        ctx.font = '12px sans-serif';
                        ctx.textAlign = 'left';
                        ctx.textBaseline = 'middle';
                        ctx.fillText((this._xzgLabel ? this._xzgLabel() : '模式'), pad + 6, y + H / 2);
                        // 右侧状态：保存=金色，预览=蓝色
                        const isSave = this.value !== '预览';
                        const dispVal = this._xzgDisplayVal ? this._xzgDisplayVal(this.value || '保存') : (this.value || '保存');
                        ctx.fillStyle = isSave ? '#FFD700' : '#88ccff';
                        ctx.font = '13px sans-serif';
                        ctx.textAlign = 'right';
                        ctx.fillText(dispVal, width - pad - 6, y + H / 2);
                    };
                    w.mouse = function(event, [x, y], node) {
                        // 拦截命中，阻止 ComfyUI 把点击交给原生逻辑弹输入框；pointerup 才会切换
                        if (event.type === 'pointerdown') return true;
                        if (event.type === 'pointerup') {
                            this.value = (this.value === '预览') ? '保存' : '预览';
                            node.setDirtyCanvas?.(true, true);
                            updateOutputDirDisplay();
                            return true;
                        }
                        return true;
                    };
                }
            }

            for (const w of this.widgets || []) {
                if (['帧率', '文件名前缀', '格式', 'CRF', '模式'].includes(w.name)) {
                    _xzgKeepConvertedWidgetVisible(w, node);
                }
            }

            requestAnimationFrame(() => player.resize());
        };

        // 绕过状态更新（画布重绘时同步）
        const origOnDrawBackground = nodeType.prototype.onDrawBackground;
        nodeType.prototype.onDrawBackground = function (ctx) {
            if (this._xzgUpdateBypassState) {
                this._xzgUpdateBypassState();
            }
            return origOnDrawBackground?.apply(this, arguments);
        };
    },
});

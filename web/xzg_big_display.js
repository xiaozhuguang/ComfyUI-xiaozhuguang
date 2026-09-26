import { app } from "../../scripts/app.js";
import { xzgLang, xzgT } from "./xzg_i18n.js";

// ═══════════════════════════════════════════════════
//  小珠光大字展示 / Xiaozhuguang Big Display
//  参考 comfyui-easy-use 的 showAnything（展示任何节点），
//  把任意输入（文本/数字/整数）放大显示在节点上，类似小珠光标题大字。
// ═══════════════════════════════════════════════════
const _NODE_TYPE = "XiaozhuguangBigDisplay";

// 每项文本的大字配置（右键设置可调）
const DEFAULT_CFG = {
    fontSize: 40,        // 固定字号；自适应开启时由可用空间决定
    minFontSize: 16,     // 自适应字号下限；空间不足时通过滚动查看内容
    maxFontSize: 200,    // 自适应字号上限
    autoFit: false,      // 文字大小自适应：开启后字号自动放大/缩小以尽量填满内容区
    fontColor: "#ffffff",
    textAlign: "center", // left / center / right
    vAlign: "center",   // 上下对齐：top / center / bottom
    lineHeight: 1.1,
    bold: false,
};

app.registerExtension({
    name: "ComfyUI.xiaozhuguang.big_display",

    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== _NODE_TYPE) return;

        // 大字内容已经承担节点的主要展示作用，隐藏默认标题栏与 ComfyUI 节点徽标。
        // LiteGraph 会处理旧画布标题；Vue 节点界面则通过节点 ID 限定的样式隐藏标题和徽标。
        nodeType.title_mode = LiteGraph.NO_TITLE;
        nodeType.collapsable = false;

        const hideNodeHeader = (node) => {
            if (!node?.id) return;
            try {
                const id = String(node.id).replace(/[^a-zA-Z0-9_-]/g, "");
                if (!id) return;
                const styleId = `xzg-big-display-header-${id}`;
                let style = document.getElementById(styleId);
                if (!style) {
                    style = document.createElement("style");
                    style.id = styleId;
                    document.head.appendChild(style);
                }
                const roots = [
                    `[data-node-id="${id}"]`, `[data-id="${id}"]`, `#node-${id}`,
                    `.litegraph-node[data-node-id="${id}"]`, `.comfy-node[data-node-id="${id}"]`,
                    `.litegraph-node[data-id="${id}"]`, `.comfy-node[data-id="${id}"]`,
                ];
                const headerSelectors = [
                    ".node-title", ".litegraph-node-title", ".comfy-node-title", "[data-testid='node-title']",
                    ".node-header", ".litegraph-node-header", ".comfy-node-header", ".lg-node-header",
                    "[class*='node-header']", "[class*='node_header']",
                ];
                const badgeSelectors = [
                    ".node-badge", ".comfy-badge", "[class*='badge']", "[data-testid*='badge']",
                ];
                const inputSelectors = [
                    ".node-input", ".litegraph-node-input", ".comfy-node-input", "[class*='node-input']",
                    "[class*='node_input']", "[data-testid*='input']",
                ];
                const scoped = (selectors) => roots.flatMap((r) => selectors.map((s) => `${r} ${s}`)).join(",");
                const header = scoped(headerSelectors);
                const badges = scoped(badgeSelectors);
                const inputLabels = scoped(inputSelectors);
                style.textContent = `${header},${badges},${inputLabels}{display:none!important;visibility:hidden!important;opacity:0!important;pointer-events:none!important;height:0!important;min-height:0!important;margin:0!important;padding:0!important;}`;
            } catch (e) {
                console.warn("[小珠光大字展示] 隐藏标题栏/徽标失败:", e);
            }
        };

        const suppressNodeBadges = (node) => {
            if (!node) return;
            // ComfyUI 的 ID、来源、耗时等角标由 LiteGraph 从 node.badges 绘制，
            // 不是 DOM。用仅属于此节点的只读空列表拦截核心扩展及其他扩展后续添加的角标。
            const hiddenBadges = [];
            Object.defineProperty(hiddenBadges, "push", {
                value: () => hiddenBadges.length,
                configurable: false,
                writable: false,
            });
            try {
                Object.defineProperty(node, "badges", {
                    configurable: true,
                    enumerable: true,
                    get: () => hiddenBadges,
                    set: () => {},
                });
            } catch (e) {
                try { node.badges = hiddenBadges; } catch (_) {}
            }
        };

        const hideNodeInputDecoration = (node) => {
            for (const input of node?.inputs || []) {
                // 不改输入名、类型、槽位索引或连接关系，只隐藏槽位上的点和标签。
                input.label = "\u200B";
                input.localized_name = "";
                if (typeof input.draw === "function") input.draw = () => {};
            }
        };

        // 右键菜单：配置大字样式（getExtraMenuOptions 是 ComfyUI/LiteGraph 标准菜单钩子）
        {
            const origGetExtra = nodeType.prototype.getExtraMenuOptions;
            nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
                // 屏蔽其他默认菜单项，只保留本节点的自定义菜单
                options.length = 0;
                // 复制当前展示的文本
                options.push({
                    content: `<span style="color:#FFD700;">${xzgT("复制文本", "Copy Text")}</span>`,
                    callback: () => {
                        const txt = (this._texts || []).join("\n");
                        this.copyTextToClipboard(txt);
                    },
                });
                // 金色文字，置于菜单最上方
                options.push(null, {
                    content: `<span style="color:#FFD700;">${xzgT("大字样式设置…", "Big Text Style…")}</span>`,
                    callback: () => this._openStyleDialog(),
                });
            };
        }

        // 对齐图标：typeKey 区分 textAlign(横线) / vAlign(竖线)，value 决定对齐边
        // 横线组：上短下长，靠左/居中/靠右；竖线组：长短不一，顶/中/底对齐
        function xzgAlignIcon(typeKey, value) {
            const L = (x1, y1, x2, y2) =>
                `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
            let inner;
            if (typeKey === "textAlign") {
                if (value === "left")
                    inner = L(3, 5, 7, 5) + L(3, 10.5, 13, 10.5) + L(3, 16, 21, 16);
                else if (value === "right")
                    inner = L(17, 5, 21, 5) + L(11, 10.5, 21, 10.5) + L(3, 16, 21, 16);
                else
                    inner = L(9, 5, 15, 5) + L(6, 10.5, 18, 10.5) + L(3, 16, 21, 16);
            } else {
                if (value === "top")
                    inner = L(6, 3, 6, 11) + L(12, 3, 12, 17) + L(18, 3, 18, 21);
                else if (value === "bottom")
                    inner = L(6, 13, 6, 21) + L(12, 7, 12, 21) + L(18, 3, 18, 21);
                else
                    inner = L(6, 7, 6, 15) + L(12, 5, 12, 19) + L(18, 3, 18, 21);
            }
            return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">${inner}</svg>`;
        }

        // 右键大字样式设置对话框
        nodeType.prototype._openStyleDialog = function () {
            const node = this;
            const cfg = { ...(this._cfg || DEFAULT_CFG) };
            cfg.minFontSize = Math.min(500, Math.max(4, Math.round(Number(cfg.minFontSize) || DEFAULT_CFG.minFontSize)));
            cfg.maxFontSize = Math.min(500, Math.max(4, Math.round(Number(cfg.maxFontSize) || DEFAULT_CFG.maxFontSize)));
            if (cfg.minFontSize > cfg.maxFontSize) cfg.maxFontSize = cfg.minFontSize;

            const wrap = document.createElement("div");
            wrap.style.cssText = "position:fixed;inset:0;z-index:99999;background:transparent;";
            const box = document.createElement("div");
            box.style.cssText = "position:fixed;left:0;top:0;transform:none;background:#222;border:1px solid #444;border-radius:8px;width:218px;max-height:calc(100vh - 16px);overflow-y:auto;box-sizing:border-box;padding:8px 12px 10px;color:#fff;font-family:'Microsoft YaHei',Arial,sans-serif;font-size:13px;box-shadow:0 8px 30px rgba(0,0,0,0.6);";
            box.innerHTML = `
                <div id="xz-bd-title" style="display:flex;justify-content:space-between;align-items:center;height:18px;margin-bottom:8px;cursor:move;user-select:none;">
                    <b style="color:#FFD700;font-size:13px;line-height:1;">${xzgT("大字样式设置", "Big Text Style")}</b>
                    <span id="xz-bd-close" style="cursor:pointer;color:#aaa;font-size:15px;line-height:1;">✕</span>
                </div>
            `;

            // 面板拖动：按住面板顶部/标题任意处即可拖动（交互控件与关闭按钮除外）
            (function () {
                const dragState = { on: false };
                const canDrag = (e) => {
                    const el = e.target;
                    if (!el || !el.closest) return false;
                    if (el.closest("input,button,select,#xz-bd-close")) return false;
                    // 仅允许从标题栏及其上方内边距区域发起拖动，空白正文不触发
                    const titleRect = box.querySelector("#xz-bd-title").getBoundingClientRect();
                    return e.clientY <= titleRect.bottom;
                };
                box.addEventListener("mousedown", (e) => {
                    if (e.button !== 0 || !canDrag(e)) return;
                    // 先记录含 transform 的视觉位置，再清除垂直居中的 transform，
                    // 最后用记录的 left/top 定位，保证拖动起始位置不跳变
                    const rect = box.getBoundingClientRect();
                    const visLeft = rect.left, visTop = rect.top;
                    box.style.transform = "none";
                    box.style.position = "fixed";
                    box.style.left = visLeft + "px";
                    box.style.top = visTop + "px";
                    box.style.margin = "0";
                    let startX = e.clientX, startY = e.clientY;
                    let ox = rect.left, oy = rect.top;
                    dragState.on = true;
                    const onMove = (ev) => {
                        if (!dragState.on) return;
                        box.style.left = ox + (ev.clientX - startX) + "px";
                        box.style.top = oy + (ev.clientY - startY) + "px";
                    };
                    const onUp = () => {
                        dragState.on = false;
                        window.removeEventListener("mousemove", onMove);
                        window.removeEventListener("mouseup", onUp);
                    };
                    window.addEventListener("mousemove", onMove);
                    window.addEventListener("mouseup", onUp);
                });
            })();

            const rows = [
                { key: "textAlign", label: xzgT("左右对齐", "H-Align"), type: "align", options: [
                    { value: "left", label: xzgT("左", "L") },
                    { value: "center", label: xzgT("中", "C") },
                    { value: "right", label: xzgT("右", "R") },
                ] },
                { key: "vAlign", label: xzgT("上下对齐", "V-Align"), type: "align", options: [
                    { value: "top", label: xzgT("上", "T") },
                    { value: "center", label: xzgT("中", "C") },
                    { value: "bottom", label: xzgT("下", "B") },
                ] },
                { key: "fontSize", label: xzgT("字号", "Font Size"), type: "number", min: 4, max: 200, step: 1 },
                { key: "autoFit", label: xzgT("自适应字号", "Auto Size"), type: "checkbox" },
                { key: "minFontSize", label: xzgT("自适应字号保底", "Auto-fit Minimum Size"), type: "number", min: 4, max: 500, step: 1 },
                { key: "maxFontSize", label: xzgT("自适应字号上限", "Auto-fit Maximum Size"), type: "number", min: 4, max: 500, step: 1 },
                { key: "fontColor", label: xzgT("文字颜色", "Text Color"), type: "color" },
                { key: "bold", label: xzgT("加粗", "Bold"), type: "checkbox" },
            ];

            const inputs = {};
            for (const r of rows) {
                const div = document.createElement("div");
                div.style.cssText = "display:flex;align-items:center;gap:8px;margin:6px 0;";
                const lab = document.createElement("span");
                lab.style.cssText = "flex:1;min-width:0;text-align:left;color:#ccc;flex-shrink:1;white-space:normal;";
                lab.textContent = r.label;
                div.appendChild(lab);
                let inp;
                if (r.type === "range") {
                    inp = document.createElement("input");
                    inp.type = "range";
                    inp.min = r.min; inp.max = r.max; inp.step = r.step;
                    inp.value = cfg[r.key] ?? (r.min + (r.max - r.min) / 2);
                    inp.style.cssText = "flex:1;accent-color:#FFD700;";
                } else if (r.type === "checkbox") {
                    inp = document.createElement("input");
                    inp.type = "checkbox";
                    inp.checked = !!cfg[r.key];
                    inp.style.cssText = "accent-color:#FFD700;transform:scale(1.2);";
                } else if (r.type === "number") {
                    inp = document.createElement("input");
                    inp.type = "text";
                    inp.inputMode = "numeric";
                    inp.min = r.min; inp.max = r.max; inp.step = r.step || 1;
                    inp.value = cfg[r.key] ?? r.min;
                    inp.style.cssText = "width:52px;flex:0 0 52px;min-width:0;box-sizing:border-box;background:#1a1a1a;border:1px solid #555;border-radius:4px;color:#fff;padding:4px 6px;";
                } else if (r.type === "color") {
                    inp = document.createElement("input");
                    inp.type = "color";
                    inp.value = cfg[r.key] || "#ffffff";
                    inp.style.cssText = "width:42px;height:24px;border:none;background:none;cursor:pointer;";
                } else if (r.type === "align") {
                    // 对齐三键图标：点击选择，金色高亮当前项
                    inp = document.createElement("div");
                    inp.style.cssText = "flex:1;display:flex;gap:4px;";
                    let curIdx = r.options.findIndex((o) => o.value === cfg[r.key]);
                    if (curIdx < 0) curIdx = 0;
                    inp._alignVal = () => (r.options[curIdx] ? r.options[curIdx].value : "");
                    const paint = () => {
                        [...inp.children].forEach((bb, j) => {
                            const on = j === curIdx;
                            bb.style.color = on ? "#FFD700" : "#cfcfcf";
                            bb.style.borderColor = on ? "#FFD700" : "#555";
                            bb.style.background = on ? "#332d1a" : "#2a2a2a";
                        });
                    };
                    r.options.forEach((o, i) => {
                        const b = document.createElement("button");
                        b.type = "button";
                        b.style.cssText = "flex:1;height:30px;display:flex;align-items:center;justify-content:center;background:#2a2a2a;border:1px solid #555;border-radius:4px;cursor:pointer;padding:0;";
                        b.title = o.label;
                        b.innerHTML = xzgAlignIcon(r.key, o.value);
                        b.addEventListener("click", () => {
                            curIdx = i;
                            paint();
                            apply();
                        });
                        inp.appendChild(b);
                    });
                    paint();
                }
                if (r.type === "range" && r.min >= 1) inp.step = r.step || 1;
                inputs[r.key] = inp;
                div.appendChild(inp);
                box.appendChild(div);
            }

            const apply = () => {
                for (const r of rows) {
                    const v = inputs[r.key];
                    const target = r.key;
                    if (r.type === "checkbox") cfg[target] = v.checked;
                    else if (r.type === "color") cfg[target] = v.value;
                    else if (r.type === "align") cfg[target] = v._alignVal();
                    else {
                        const num = parseFloat(v.value);
                        cfg[target] = Number.isFinite(num) ? num : cfg[target];
                    }
                }
                cfg.minFontSize = Math.min(500, Math.max(4, Math.round(Number(cfg.minFontSize) || DEFAULT_CFG.minFontSize)));
                cfg.maxFontSize = Math.min(500, Math.max(4, Math.round(Number(cfg.maxFontSize) || DEFAULT_CFG.maxFontSize)));
                if (cfg.minFontSize > cfg.maxFontSize) {
                    if (document.activeElement === inputs.minFontSize) cfg.maxFontSize = cfg.minFontSize;
                    else cfg.minFontSize = cfg.maxFontSize;
                    inputs.minFontSize.value = cfg.minFontSize;
                    inputs.maxFontSize.value = cfg.maxFontSize;
                }
                node._cfg = cfg;
                inputs.minFontSize.disabled = !cfg.autoFit;
                inputs.maxFontSize.disabled = !cfg.autoFit;
                // 标记工作流为已修改，保存工作流时随该节点持久化
                app.graph?.setDirtyCanvas(true, true);
                node.setDirtyCanvas?.(true, true);
            };

            for (const r of rows) {
                const inp = inputs[r.key];
                if (inp) {
                    inp.addEventListener(r.type === "checkbox" ? "change" : "input", apply);
                }
            }
            inputs.minFontSize.disabled = !cfg.autoFit;
            inputs.maxFontSize.disabled = !cfg.autoFit;

            const btns = document.createElement("div");
            btns.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:10px;";
            const ok = document.createElement("button");
            ok.textContent = xzgT("确定", "OK");
            ok.style.cssText = "padding:6px 16px;background:#FFD700;border:none;border-radius:4px;color:#000;font-weight:600;cursor:pointer;";
            const cancel = document.createElement("button");
            cancel.textContent = xzgT("取消", "Cancel");
            cancel.style.cssText = "padding:6px 16px;background:#3a3a3a;border:1px solid #555;border-radius:4px;color:#fff;cursor:pointer;";
            btns.appendChild(cancel);
            btns.appendChild(ok);
            box.appendChild(btns);

            wrap.appendChild(box);
            document.body.appendChild(wrap);

            // 将面板左上角锚定到节点右上角；靠近屏幕右沿时向节点左侧展开。
            const canvas = app.canvas;
            const canvasRect = canvas?.canvas?.getBoundingClientRect?.();
            if (canvasRect && node.pos && node.size) {
                const scale = canvas.ds?.scale || 1;
                const offset = canvas.ds?.offset || [0, 0];
                const nodeLeft = canvasRect.left + (node.pos[0] + offset[0]) * scale;
                const nodeTop = canvasRect.top + (node.pos[1] + offset[1]) * scale;
                const nodeRight = nodeLeft + node.size[0] * scale;
                const panelRect = box.getBoundingClientRect();
                const left = nodeRight + panelRect.width <= window.innerWidth - 8
                    ? nodeRight
                    : Math.max(8, nodeLeft - panelRect.width);
                const top = Math.max(8, Math.min(nodeTop, window.innerHeight - panelRect.height - 8));
                box.style.left = `${left}px`;
                box.style.top = `${top}px`;
            }

            const close = () => wrap.remove();
            ok.onclick = () => { apply(); close(); };
            cancel.onclick = close;
            wrap.onclick = (e) => { if (e.target === wrap) close(); };
            wrap.querySelector("#xz-bd-close").onclick = close;
        };

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origCreated?.apply(this, arguments);
            // 每个节点用独立的配置（默认值副本），由 onConfigure/onSerialize 随工作流持久化
            this._cfg = { ...DEFAULT_CFG };
            this._texts = [];
            this.properties = this.properties || {};
            this.color = "#1a1a1a";
            this.bgcolor = "#1a1a1a";
            this.size = [220, 120];   // 仅初始大小，之后尺寸完全由用户拖动控制，不做自适应
            hideNodeHeader(this);
            suppressNodeBadges(this);
            hideNodeInputDecoration(this);
            return r;
        };

        const origConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = origConfigure?.apply(this, arguments);
            hideNodeHeader(this);
            hideNodeInputDecoration(this);
            // 从恢复的工作流读取该节点的配置与已显示文本
            const wv = this.widgets_values;
            try {
                if (wv && typeof wv === "object" && wv.length > 0) {
                    const first = wv.find((x) => x && (x.texts || x.cfg));
                    if (first) {
                        if (Array.isArray(first.texts)) this._texts = first.texts;
                        if (first.cfg && typeof first.cfg === "object")
                            this._cfg = { ...DEFAULT_CFG, ...first.cfg };
                    }
                }
            } catch (e) {}
            if (!this._cfg) this._cfg = { ...DEFAULT_CFG };
            return r;
        };

        const origSerialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function (o) {
            const r = origSerialize?.apply(this, arguments);
            try {
                if (!o.widgets_values) o.widgets_values = [];
                o.widgets_values.push({ texts: this._texts || [], cfg: { ...this._cfg } });
            } catch (e) {}
            return r;
        };

        // 执行后接收文本并大字显示（easy-use showAnything 模式）
        const origExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            const r = origExecuted?.apply(this, arguments);
            const texts = (message && message.text) || [];
            this._texts = Array.isArray(texts) ? texts : [texts];
            this._xzgBigDisplayScrollTop = 0;
            this._xzgBigDisplayScrollTops = [];
            this.setDirtyCanvas?.(true, true);
            return r;
        };

        const origOnMouseWheel = nodeType.prototype.onMouseWheel;
        nodeType.prototype.onMouseWheel = function (event, pos) {
            const metrics = this._xzgBigDisplayScrollMetrics;
            const cell = metrics?.cells?.find((entry) => pos && pos[1] >= entry.top && pos[1] <= entry.top + entry.height);
            if (cell?.maxScroll > 0) {
                const tops = this._xzgBigDisplayScrollTops || (this._xzgBigDisplayScrollTops = []);
                tops[cell.index] = Math.max(0, Math.min(cell.maxScroll, (tops[cell.index] || 0) + (event?.deltaY || 0) * 0.8));
                this.setDirtyCanvas?.(true, true);
                return true;
            }
            if (!metrics?.cells && metrics?.maxScroll > 0) {
                this._xzgBigDisplayScrollTop = Math.max(0, Math.min(
                    metrics.maxScroll,
                    (this._xzgBigDisplayScrollTop || 0) + (event?.deltaY || 0) * 0.8,
                ));
                this.setDirtyCanvas?.(true, true);
                return true;
            }
            return origOnMouseWheel?.apply(this, arguments);
        };

        const origOnMouseDown = nodeType.prototype.onMouseDown;
        nodeType.prototype.onMouseDown = function (event, pos) {
            const metrics = this._xzgBigDisplayScrollMetrics;
            // 把 LiteGraph 右下角尺寸拖拽热区留给节点缩放，滚动条不得拦截。
            if (event?.button === 0 && pos && pos[0] >= (this.size?.[0] || 0) - 12 && pos[1] >= (this.size?.[1] || 0) - 12) {
                return origOnMouseDown?.apply(this, arguments);
            }
            const cell = metrics?.cells?.find((entry) => entry.maxScroll > 0 && pos &&
                pos[0] >= entry.trackX && pos[0] <= entry.trackX + 8 &&
                pos[1] >= entry.top && pos[1] <= entry.top + entry.height);
            if (event?.button === 0 && cell) {
                this._xzgBigDisplayScrollDragging = true;
                this._xzgBigDisplayDragIndex = cell.index;
                this._xzgBigDisplayDragOffset = pos[1] >= cell.thumbY && pos[1] <= cell.thumbY + cell.thumbH
                    ? pos[1] - cell.thumbY : cell.thumbH / 2;
                const tops = this._xzgBigDisplayScrollTops || (this._xzgBigDisplayScrollTops = []);
                tops[cell.index] = Math.max(0, Math.min(cell.maxScroll,
                    ((pos[1] - this._xzgBigDisplayDragOffset - cell.top) / Math.max(1, cell.height - cell.thumbH)) * cell.maxScroll));
                this.setDirtyCanvas?.(true, true);
                return true;
            }
            if (event?.button === 0 && metrics?.maxScroll > 0 && pos &&
                pos[0] >= metrics.trackX && pos[0] <= metrics.trackX + 8 &&
                pos[1] >= metrics.top && pos[1] <= metrics.top + metrics.height) {
                this._xzgBigDisplayScrollDragging = true;
                this._xzgBigDisplayDragOffset = pos[1] >= metrics.thumbY && pos[1] <= metrics.thumbY + metrics.thumbH
                    ? pos[1] - metrics.thumbY : metrics.thumbH / 2;
                this._xzgBigDisplayScrollTop = Math.max(0, Math.min(
                    metrics.maxScroll,
                    ((pos[1] - this._xzgBigDisplayDragOffset - metrics.top) /
                        Math.max(1, metrics.height - metrics.thumbH)) * metrics.maxScroll,
                ));
                this.setDirtyCanvas?.(true, true);
                return true;
            }
            return origOnMouseDown?.apply(this, arguments);
        };

        const origOnMouseMove = nodeType.prototype.onMouseMove;
        nodeType.prototype.onMouseMove = function (event, pos) {
            // 丢失 mouseup 时以 buttons 状态复位，避免单纯悬停/移动继续拖动文字滚动条。
            if (this._xzgBigDisplayScrollDragging && event && event.buttons === 0) {
                this._xzgBigDisplayScrollDragging = false;
                this._xzgBigDisplayDragIndex = null;
                this.setDirtyCanvas?.(true, true);
                return origOnMouseMove?.apply(this, arguments);
            }
            if (this._xzgBigDisplayScrollDragging && this._xzgBigDisplayDragIndex != null && pos) {
                const cell = this._xzgBigDisplayScrollMetrics?.cells?.find((entry) => entry.index === this._xzgBigDisplayDragIndex);
                if (cell) {
                    const tops = this._xzgBigDisplayScrollTops || (this._xzgBigDisplayScrollTops = []);
                    tops[cell.index] = Math.max(0, Math.min(cell.maxScroll,
                        ((pos[1] - this._xzgBigDisplayDragOffset - cell.top) / Math.max(1, cell.height - cell.thumbH)) * cell.maxScroll));
                    this.setDirtyCanvas?.(true, true);
                    return true;
                }
            }
            if (this._xzgBigDisplayScrollDragging && pos && this._xzgBigDisplayScrollMetrics) {
                const metrics = this._xzgBigDisplayScrollMetrics;
                this._xzgBigDisplayScrollTop = Math.max(0, Math.min(
                    metrics.maxScroll,
                    ((pos[1] - this._xzgBigDisplayDragOffset - metrics.top) /
                        Math.max(1, metrics.height - metrics.thumbH)) * metrics.maxScroll,
                ));
                this.setDirtyCanvas?.(true, true);
                return true;
            }
            return origOnMouseMove?.apply(this, arguments);
        };

        const origOnMouseUp = nodeType.prototype.onMouseUp;
        nodeType.prototype.onMouseUp = function () {
            if (this._xzgBigDisplayScrollDragging) {
                this._xzgBigDisplayScrollDragging = false;
                this._xzgBigDisplayDragIndex = null;
                this.setDirtyCanvas?.(true, true);
                return true;
            }
            return origOnMouseUp?.apply(this, arguments);
        };

        // 复制文本到剪贴板，返回是否成功
        nodeType.prototype.copyTextToClipboard = function (text) {
            const txt = (text ?? "").toString();
            if (!txt) return false;
            const done = (ok, silent) => {
                if (ok) {
                    if (!silent && app?.extensionManager?.toast)
                        app.extensionManager.toast.add({ title: "已复制", message: "", type: "success", life: 2 });
                } else {
                    if (app?.extensionManager?.toast)
                        app.extensionManager.toast.add({ title: "复制失败", message: "", type: "error", life: 3 });
                }
            };
            try {
                if (navigator.clipboard && window.isSecureContext) {
                    navigator.clipboard.writeText(txt).then(() => done(true)).catch(() => fallback());
                    return true;
                }
                fallback();
                return true;
            } catch (e) {
                fallback();
                return true;
            }
            function fallback() {
                const ta = document.createElement("textarea");
                ta.value = txt;
                ta.style.cssText = "position:fixed;top:-999px;left:-999px;opacity:0;";
                document.body.appendChild(ta);
                ta.focus();
                ta.select();
                let ok = false;
                try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
                document.body.removeChild(ta);
                done(ok);
            }
        };

        // 大字绘制
        nodeType.prototype.onDrawBackground = function (ctx) {
            const cfg = this._cfg || DEFAULT_CFG;
            const w = this.size[0] || 100;
            const h = this.size[1] || 100;
            const fontSize = cfg.fontSize;
            const lines = [];
            for (const t of this._texts || []) {
                for (const ln of String(t).split("\n")) lines.push(ln);
            }
            if (lines.length === 0) lines.push(xzgT("等待输入…", "Awaiting input…"));

            ctx.save();
            // 节点默认主体底色（非主题）：主题模式下级联主题绘制会跳过本节点主体填充，
            // 这里用节点自身 bgcolor 兜底铺满正文区，避免主题下正文区域变成全透明、文字悬空。
            const _bodyBg = (this.bgcolor && this.bgcolor !== "transparent") ? this.bgcolor : "#1a1a1a";
            ctx.fillStyle = _bodyBg;
            ctx.fillRect(0, 0, w, h);

            // 多项输入分别绘制为独立格子，避免批次/列表内容挤在同一块大字区域。
            const displayItems = (this._texts || []).map((value) => String(value));
            if (displayItems.length > 1) {
                const pad = 0;
                const titleH = 0;
                const inputBottom = Math.max(titleH, ...(this.inputs || []).map((input) => (input.pos?.[1] ?? titleH)));
                const contentTop = inputBottom + pad;
                const contentW = Math.max(1, w - pad * 2);
                const contentH = Math.max(1, h - contentTop - pad);
                const gap = 3;
                const configuredFont = Math.max(4, Math.round(Number(cfg.fontSize) || DEFAULT_CFG.fontSize));
                const maxAdaptiveFont = Math.min(500, Math.max(4, Math.round(Number(cfg.maxFontSize) || DEFAULT_CFG.maxFontSize)));
                const minFont = Math.min(maxAdaptiveFont, Math.min(500, Math.max(4, Math.round(Number(cfg.minFontSize) || DEFAULT_CFG.minFontSize))));
                const weight = cfg.bold ? "bold" : "normal";
                const align = cfg.textAlign || "center";
                const lineFactor = cfg.lineHeight || 1.1;
                const scrollbarW = 8;
                const cellW = Math.max(1, contentW);
                const cellH = Math.max(1, (contentH - gap * (displayItems.length - 1)) / displayItems.length);

                const wrapText = (text, maxWidth) => {
                    const wrapped = [];
                    for (const sourceLine of String(text).split("\n")) {
                        if (!sourceLine) { wrapped.push(""); continue; }
                        let line = "";
                        for (const char of Array.from(sourceLine)) {
                            if (line && ctx.measureText(line + char).width > maxWidth) {
                                wrapped.push(line);
                                line = char;
                            } else {
                                line += char;
                            }
                        }
                        wrapped.push(line);
                    }
                    return wrapped;
                };

                // 所有项目均分当前内容高度；每行内部独立滚动，不改变节点尺寸。
                const scrollTops = this._xzgBigDisplayScrollTops || (this._xzgBigDisplayScrollTops = []);
                const cells = [];
                displayItems.forEach((item, index) => {
                    const y = contentTop + index * (cellH + gap);
                    const trackX = w - scrollbarW;
                    const innerH = Math.max(1, cellH - 10);
                    const maxFont = cfg.autoFit ? maxAdaptiveFont : configuredFont;
                    const layoutAtWidth = (innerW) => {
                        const measure = (fontSize) => {
                            ctx.font = `${weight} ${fontSize}px "Microsoft YaHei", "微软雅黑", Arial, sans-serif`;
                            const wrapped = wrapText(item, innerW);
                            const lineHeight = Math.max(fontSize * lineFactor, fontSize + 2);
                            const maxLineWidth = wrapped.reduce((max, line) => Math.max(max, ctx.measureText(line).width), 0);
                            return { fontSize, wrapped, lineHeight, textHeight: wrapped.length * lineHeight, maxLineWidth };
                        };
                        if (!cfg.autoFit) return measure(maxFont);

                        // 自适应模式按可用宽度折行，再在设置的上下限之间选择合适字号。
                        let lo = minFont, hi = maxFont, best = measure(minFont);
                        while (lo <= hi) {
                            const mid = Math.floor((lo + hi) / 2);
                            const candidate = measure(mid);
                            if (candidate.textHeight <= innerH) {
                                best = candidate;
                                lo = mid + 1;
                            } else {
                                hi = mid - 1;
                            }
                        }
                        return best;
                    };
                    // 先用完整宽度排版；只有内容确实溢出时，才给滚动条留位置并重新排版。
                    let innerW = Math.max(1, cellW - 12);
                    let layout = layoutAtWidth(innerW);
                    let maxScroll = Math.max(0, layout.textHeight - innerH);
                    if (maxScroll > 0) {
                        innerW = Math.max(1, cellW - scrollbarW - 12);
                        layout = layoutAtWidth(innerW);
                        maxScroll = Math.max(0, layout.textHeight - innerH);
                    }
                    const { fontSize, wrapped, lineHeight, textHeight } = layout;
                    const textAreaW = cellW - (maxScroll > 0 ? scrollbarW : 0);
                    scrollTops[index] = Math.max(0, Math.min(maxScroll, scrollTops[index] || 0));
                    const scrollTop = scrollTops[index];
                    const thumbH = maxScroll > 0 ? Math.max(12, innerH * innerH / textHeight) : innerH;
                    const thumbY = y + 5 + (maxScroll > 0 ? scrollTop / maxScroll * (innerH - thumbH) : 0);
                    cells.push({ index, top: y + 5, height: innerH, rowTop: y, rowHeight: cellH, left: pad, right: pad + cellW, maxScroll, trackX, thumbY, thumbH });

                    ctx.fillStyle = "rgba(255,255,255,0.035)";
                    ctx.fillRect(pad, y, cellW, cellH);
                    ctx.strokeStyle = this.selected ? "#4CAF50" : "rgba(255,255,255,0.18)";
                    ctx.lineWidth = 1;
                    ctx.strokeRect(pad + 0.5, y + 0.5, Math.max(0, cellW - 1), Math.max(0, cellH - 1));

                    ctx.save();
                    ctx.beginPath();
                    ctx.rect(pad + 6, y + 5, innerW, innerH);
                    ctx.clip();
                    ctx.font = `${weight} ${fontSize}px "Microsoft YaHei", "微软雅黑", Arial, sans-serif`;
                    ctx.fillStyle = cfg.fontColor || "#ffffff";
                    ctx.textAlign = align;
                    ctx.textBaseline = "top";
                    const vAlign = cfg.vAlign || "center";
                    let textY = y + 5 - scrollTop;
                    if (maxScroll === 0 && vAlign === "center") textY += Math.max(0, (innerH - textHeight) / 2);
                    else if (maxScroll === 0 && vAlign === "bottom") textY += Math.max(0, innerH - textHeight);
                    const textX = align === "left" ? pad + 6 : align === "right" ? pad + textAreaW - 6 : pad + textAreaW / 2;
                    wrapped.forEach((line, lineIndex) => ctx.fillText(line, textX, textY + lineIndex * lineHeight));
                    ctx.restore();

                    if (maxScroll > 0) {
                        ctx.fillStyle = "rgba(255,255,255,0.12)";
                        ctx.fillRect(trackX + 2, y + 5, 4, innerH);
                        ctx.fillStyle = this._xzgBigDisplayScrollDragging && this._xzgBigDisplayDragIndex === index
                            ? "#FFD700" : "rgba(255,255,255,0.58)";
                        ctx.fillRect(trackX, thumbY, scrollbarW, thumbH);
                    }
                });
                this._xzgBigDisplayScrollMetrics = { cells };
                ctx.restore();
                return;
            }

            // 注：不再绘制"整个节点"的外圈绿色虚线框，仅保留下方文字内容区的绿框。

            const weight = cfg.bold ? "bold" : "normal";
            const align = cfg.textAlign || "center";
            // 外侧内边距固定为 0；滚动条单独占据右侧区域。
            const pad = 0;
            const showHint = (this._texts || []).length > 1;
            const hintH = showHint ? 16 : 0;
            const scrollbarW = 8;

            // ── 内容区定义 ─────────────────────────────────────────────
            // onDrawBackground 的 ctx 原点是节点本地左上角 (0,0)。
            // 顶部仅预留到输入端口实际位置，避免固定输入槽高度造成过多留白。
            // 内容区 = [padding .. 节点底部]，字号缩放、居中、绘制全部限定在内容区内。
            const titleH = 0;
            const inputBottom = Math.max(titleH, ...(this.inputs || []).map((input) => (input.pos?.[1] ?? titleH)));
            const contentTopExact = inputBottom + pad;
            let contentW = Math.max(1, w - pad * 2);
            let contentH = Math.max(1, h - contentTopExact - pad - hintH);

            // 选中时：只围绕内容区绘制绿色虚线框（不再框住整个节点含输入端口）
            if (this.selected) {
                ctx.fillStyle = "rgba(255,255,255,0.03)";
                ctx.fillRect(pad, contentTopExact, contentW, contentH);
                ctx.strokeStyle = "#4CAF50";
                ctx.lineWidth = 1;
                ctx.setLineDash([4, 4]);
                ctx.strokeRect(pad, contentTopExact, contentW, contentH);
                ctx.setLineDash([]);
            }

            // ── 自动换行 + 双向缩放 ──────────────────────────────────
            // 先按当前字号把每行文本按内容区宽度自动换行，再横向/纵向分别算"填满内容区"的缩放比
            // 并取较小值（宽高都不溢出）。节点拉大→字变大，节点缩小→字变小，超宽自动换行、不高设定上限。
            const fontStyleStr = (f) => `${weight} ${f}px "Microsoft YaHei", "微软雅黑", "PingFang SC", "SimHei", Arial, sans-serif`;
            const wrapLine = (str, maxW) => {
                // 贪婪软换行：以空格为优先断点，中文/无空格时按字符硬断，保证行宽不超 maxW
                if (str.length === 0) return [""];
                const n = str.length;
                const out = [];
                let start = 0;
                while (start < n) {
                    // 二分最长前缀 [start, mid)，使其宽度不超过 maxW
                    let lo = start, hi = n;
                    while (lo < hi) {
                        const mid = Math.floor((lo + hi + 1) / 2);
                        if (ctx.measureText(str.slice(start, mid)).width <= maxW) lo = mid;
                        else hi = mid - 1;
                    }
                    const end = lo;
                    if (end === n) { out.push(str.slice(start)); break; }
                    // [start,end) 放得下而再往后放不下：优先在空格处断行
                    let cut = -1;
                    for (let k = end; k > start; k--) {
                        const ch = str[k - 1];
                        if (ch === " " || ch === "\t" || ch === "\u3000") { cut = k - 1; break; }
                    }
                    if (cut >= 0) {
                        out.push(str.slice(start, cut));
                        start = cut + 1;
                        while (start < n && /\s/.test(str[start])) start++;
                    } else {
                        // 无空格可断：在前缀末端硬断（保证至少前进一个字符，避免死循环）
                        const e = (end === start) ? start + 1 : end;
                        out.push(str.slice(start, e));
                        start = e;
                    }
                }
                return out;
            };

            // ── 字号计算：固定字号 或 自适应 ─────────────────────────
            // 先按给定字号把每行文本按内容区宽度自动换行，再衡量整块文本高度。
            let fs;
            let wrapped = [];
            let wm = [];
            let lineHeight, firstAscent, lastDescent;

            const measureAt = (f) => {
                ctx.font = fontStyleStr(f);
                const wl = [];
                for (const ln of lines) wl.push(...wrapLine(ln, contentW));
                const mm = wl.map((lw) => ctx.measureText(lw));
                const maxLineW = mm.reduce((max, m) => Math.max(max, m.width), 0);
                const ascents = mm.map((m) => m.actualBoundingBoxAscent || f);
                const descents = mm.map((m) => m.actualBoundingBoxDescent || f * 0.15);
                // 行距至少完整容纳任意一行的实际字形高度，避免个别字体/字形
                // 在自动字号临界值时超出预估高度而被裁剪。
                const lh = Math.max(
                    f * (cfg.lineHeight || 1.1),
                    Math.max(...ascents) + Math.max(...descents) + 2,
                );
                // 整段文字按最高字形顶部和最低字形底部布局；只取首/末行会让
                // 中间行的重音、标点或拉丁字母下伸部分超出裁剪区。
                const fa = Math.max(...ascents);
                const ld = Math.max(...descents);
                const blkH = wl.length > 1 ? fa + (wl.length - 1) * lh + ld : fa + ld;
                return { wl, mm, lh, fa, ld, blkH, maxLineW };
            };

            const calculateLayout = () => {
                if (cfg.autoFit) {
                // 自适应：根据可用宽度折行，字号在设置的上下限之间适配；
                // 保底字号用于空间不足时启用纵向滚动查看。
                const maxF = Math.min(500, Math.max(4, Math.round(Number(cfg.maxFontSize) || DEFAULT_CFG.maxFontSize)));
                const minF = Math.min(maxF, Math.min(500, Math.max(4, Math.round(Number(cfg.minFontSize) || DEFAULT_CFG.minFontSize))));
                let bestF = minF;
                let bestM = measureAt(minF);
                let lo = minF, hi = maxF;
                while (lo <= hi) {
                    const mid = Math.floor((lo + hi) / 2);
                    const m = measureAt(mid);
                    if (m.blkH <= contentH) { bestF = mid; bestM = m; lo = mid + 1; }
                    else hi = mid - 1;
                }
                    return { fs: bestF, wrapped: bestM.wl, wm: bestM.mm, lineHeight: bestM.lh, firstAscent: bestM.fa, lastDescent: bestM.ld, maxLineW: bestM.maxLineW };
                }
                // 固定字号：直接采用填写的数值，仅按内容区宽度自动换行
                const f = Math.max(4, Math.round(fontSize) || DEFAULT_CFG.fontSize);
                const m = measureAt(f);
                return { fs: f, wrapped: m.wl, wm: m.mm, lineHeight: m.lh, firstAscent: m.fa, lastDescent: m.ld, maxLineW: m.maxLineW };
            };

            let layout = calculateLayout();
            const blockHeight = (m) => m.wrapped.length > 1
                ? m.firstAscent + (m.wrapped.length - 1) * m.lineHeight + m.lastDescent
                : m.firstAscent + m.lastDescent;
            // 发生纵向溢出时为竖向滚动条留出宽度，再计算最终字号与折行。
            if (blockHeight(layout) > contentH) {
                contentW = Math.max(1, contentW - scrollbarW);
                layout = calculateLayout();
            }
            ({ fs, wrapped, wm, lineHeight, firstAscent, lastDescent } = layout);

            // autoFit 的字号搜索会多次设置 ctx.font；最终绘制必须恢复到选中的字号，
            // 否则换行按一个字号计算、实际却用另一个字号绘制，行尾就会被裁剪。
            ctx.font = fontStyleStr(fs);

            const totalBlockH = blockHeight(layout);
            const maxScroll = Math.max(0, totalBlockH - contentH);
            this._xzgBigDisplayScrollTop = Math.max(0, Math.min(maxScroll, this._xzgBigDisplayScrollTop || 0));
            const scrollTop = this._xzgBigDisplayScrollTop;

            // 文字的起点 Y：按上下对齐（vAlign）计算（上对齐 top / 居中 center / 下对齐 bottom）
            const vAlign = cfg.vAlign || "center";
            let blockTop;
            if (maxScroll > 0) blockTop = contentTopExact - scrollTop;
            else if (vAlign === "top") blockTop = contentTopExact;
            else if (vAlign === "bottom") blockTop = contentTopExact + Math.max(0, contentH - totalBlockH);
            else blockTop = contentTopExact + (contentH - totalBlockH) / 2;
            const startY = blockTop + firstAscent;

            // 裁剪：从内容区顶部开始强制裁剪，确保文字绝不画入输入端口区域
            ctx.save();
            ctx.beginPath();
            ctx.rect(pad, contentTopExact, contentW, contentH);
            ctx.clip();

            ctx.textBaseline = "alphabetic";
            ctx.textAlign = align;

            wrapped.forEach((line, i) => {
                const y = startY + i * lineHeight;
                if (y - firstAscent > h) return;
                // textAlign 已设为 align，canvas 的 x 按对齐语义定位：
                // left=左起点, right=右边缘, center=文本中心（与小珠光标题一致）
                let x;
                if (align === "left") x = pad;
                else if (align === "right") x = pad + contentW;
                else x = pad + contentW / 2;

                ctx.fillStyle = cfg.fontColor;
                ctx.fillText(line, x, y);
            });

            // 结束 clip（内容区裁剪），恢复为节点整体坐标系，供底部提示正常绘制
            ctx.restore();

            this._xzgBigDisplayScrollMetrics = null;
            if (maxScroll > 0) {
                this._xzgBigDisplayScrollMetrics = {
                    top: contentTopExact, height: contentH, left: pad, right: pad + contentW,
                    maxScroll, trackX: pad + contentW, thumbY: contentTopExact, thumbH: contentH,
                };
            }
            if (maxScroll > 0) {
                const trackX = pad + contentW;
                const thumbH = Math.max(18, contentH * contentH / totalBlockH);
                const thumbY = contentTopExact + (scrollTop / maxScroll) * (contentH - thumbH);
                Object.assign(this._xzgBigDisplayScrollMetrics, { trackX, thumbY, thumbH });
                ctx.fillStyle = "rgba(255,255,255,0.12)";
                ctx.fillRect(trackX + 2, contentTopExact, 4, contentH);
                ctx.fillStyle = this._xzgBigDisplayScrollDragging ? "#FFD700" : "rgba(255,255,255,0.58)";
                ctx.fillRect(trackX, thumbY, scrollbarW, thumbH);
            }

            // 底部状态提示（极小时才显示执行来源）
            if (showHint) {
                ctx.font = `normal 11px "Microsoft YaHei", Arial, sans-serif`;
                ctx.fillStyle = "rgba(255,255,255,0.4)";
                ctx.textAlign = "center";
                ctx.fillText(xzgT(`共 ${this._texts.length} 项`, `${this._texts.length} items`), w / 2, h - 6);
            }
            ctx.restore();
        };
    },

    async setup() {
        if (!window._xzgBigDisplayPointerUpCaptureInstalled) {
            window._xzgBigDisplayPointerUpCaptureInstalled = true;
            const releaseScrollbars = () => {
                for (const node of app.graph?._nodes || []) {
                    if (!node._xzgBigDisplayScrollDragging) continue;
                    node._xzgBigDisplayScrollDragging = false;
                    node._xzgBigDisplayDragIndex = null;
                    node.setDirtyCanvas?.(true, true);
                }
            };
            window.addEventListener("pointerup", releaseScrollbars, true);
            window.addEventListener("mouseup", releaseScrollbars, true);
        }

        if (!window._xzgBigDisplayWheelCaptureInstalled) {
            window._xzgBigDisplayWheelCaptureInstalled = true;
            window.addEventListener("wheel", (event) => {
                const canvas = app.canvas;
                const canvasElement = canvas?.canvas;
                if (!canvasElement || (event.target !== canvasElement && !canvasElement.contains?.(event.target))) return;
                let graphPos;
                try {
                    const canvasPos = canvas.convertEventToCanvasOffset?.(event);
                    graphPos = canvasPos && canvas.convertCanvasToGraph?.(canvasPos);
                } catch (_) {}
                if (!graphPos && Array.isArray(canvas?.graph_mouse)) graphPos = canvas.graph_mouse;
                if (!graphPos) return;

                const node = [...(app.graph?._nodes || [])].reverse().find((candidate) =>
                    candidate.type === _NODE_TYPE && candidate.pos && candidate.size &&
                    graphPos[0] >= candidate.pos[0] && graphPos[0] <= candidate.pos[0] + candidate.size[0] &&
                    graphPos[1] >= candidate.pos[1] && graphPos[1] <= candidate.pos[1] + candidate.size[1]);
                if (!node) return;

                const localX = graphPos[0] - node.pos[0];
                const localY = graphPos[1] - node.pos[1];
                const metrics = node._xzgBigDisplayScrollMetrics;
                if (!metrics) return;
                if (metrics.cells) {
                    const cell = metrics.cells.find((entry) => localY >= entry.rowTop && localY <= entry.rowTop + entry.rowHeight && localX >= entry.left && localX <= entry.right);
                    if (!cell) return;
                    event.preventDefault();
                    event.stopPropagation();
                    event.stopImmediatePropagation();
                    if (cell.maxScroll > 0) {
                        const tops = node._xzgBigDisplayScrollTops || (node._xzgBigDisplayScrollTops = []);
                        tops[cell.index] = Math.max(0, Math.min(cell.maxScroll, (tops[cell.index] || 0) + (event.deltaY || 0) * 0.8));
                        node.setDirtyCanvas?.(true, true);
                    }
                } else if (metrics.maxScroll > 0 && localX >= metrics.left && localX <= metrics.right && localY >= metrics.top && localY <= metrics.top + metrics.height) {
                    event.preventDefault();
                    event.stopPropagation();
                    event.stopImmediatePropagation();
                    node._xzgBigDisplayScrollTop = Math.max(0, Math.min(metrics.maxScroll, (node._xzgBigDisplayScrollTop || 0) + (event.deltaY || 0) * 0.8));
                    node.setDirtyCanvas?.(true, true);
                }
            }, { capture: true, passive: false });
        }

        // 热修复入口
        window.XZG_BigDisplay_applyAll = function () {
            let n = 0;
            for (const nd of app.graph?._nodes || []) {
                if (nd.type === _NODE_TYPE) {
                    nd.setDirtyCanvas?.(true, true);
                    n++;
                }
            }
            return { patched: n };
        };
    },
});

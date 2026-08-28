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
    fontSize: 40,        // 基准字号（图像空间），自适应开启时作为最大字号上限
    autoFit: false,      // 文字大小自适应：开启后字号自动放大/缩小以尽量填满内容区
    fontColor: "#ffffff",
    bgEnabled: false,
    bgColor: "#2a2a2a",
    borderRadius: 6,
    bgPadding: 8,
    textAlign: "center", // left / center / right
    vAlign: "center",   // 上下对齐：top / center / bottom
    lineHeight: 1.1,
    bold: false,
};

app.registerExtension({
    name: "ComfyUI.xiaozhuguang.big_display",

    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== _NODE_TYPE) return;

        // 保留正常标题栏显示（隐藏可能导致空白异常，用户选择正常展示节点名）
        nodeType.collapsable = false;

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

            const wrap = document.createElement("div");
            wrap.style.cssText = "position:fixed;inset:0;z-index:99999;background:transparent;";
            const box = document.createElement("div");
            box.style.cssText = "position:fixed;left:66vw;top:50%;transform:translateY(-50%);background:#222;border:1px solid #444;border-radius:8px;width:268px;box-sizing:border-box;padding:8px 12px 10px;color:#fff;font-family:'Microsoft YaHei',Arial,sans-serif;font-size:13px;box-shadow:0 8px 30px rgba(0,0,0,0.6);";
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
                { key: "fontColor", label: xzgT("文字颜色", "Text Color"), type: "color" },
                { key: "bgEnabled", label: xzgT("显示背景", "Background"), type: "checkbox" },
                { key: "bgColor", label: xzgT("背景颜色", "BG Color"), type: "color" },
                { key: "padding", label: xzgT("内边距", "Padding"), type: "range", min: 0, max: 40, step: 1 },
                { key: "bold", label: xzgT("加粗", "Bold"), type: "checkbox" },
            ];

            const inputs = {};
            for (const r of rows) {
                const div = document.createElement("div");
                div.style.cssText = "display:flex;align-items:center;gap:8px;margin:6px 0;";
                const lab = document.createElement("span");
                lab.style.cssText = "width:78px;text-align:left;color:#ccc;flex-shrink:0;white-space:nowrap;";
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
                    inp.type = "number";
                    inp.min = r.min; inp.max = r.max; inp.step = r.step || 1;
                    inp.value = cfg[r.key] ?? r.min;
                    inp.style.cssText = "flex:1;min-width:0;background:#1a1a1a;border:1px solid #555;border-radius:4px;color:#fff;padding:4px 8px;";
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

            // 对齐命名到 cfg 实际字段（padding→bgPadding）
            const alias = { padding: "bgPadding" };

            const apply = () => {
                for (const r of rows) {
                    const v = inputs[r.key];
                    const target = alias[r.key] || r.key;
                    if (r.type === "checkbox") cfg[target] = v.checked;
                    else if (r.type === "color") cfg[target] = v.value;
                    else if (r.type === "align") cfg[target] = v._alignVal();
                    else {
                        const num = parseFloat(v.value);
                        cfg[target] = Number.isFinite(num) ? num : cfg[target];
                    }
                }
                node._cfg = cfg;
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
            return r;
        };

        const origConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = origConfigure?.apply(this, arguments);
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
            this.setDirtyCanvas?.(true, true);
            return r;
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

            // 可选的背景框
            if (cfg.bgEnabled && cfg.bgColor && cfg.bgColor !== "transparent") {
                ctx.fillStyle = cfg.bgColor;
                const br = 6; // 圆角内置固定 6，无滑条
                ctx.beginPath();
                ctx.roundRect(1, 1, w - 2, h - 2, Math.min(br, 16));
                ctx.fill();
            }

            // 注：不再绘制"整个节点"的外圈绿色虚线框，仅保留下方文字内容区的绿框。

            const weight = cfg.bold ? "bold" : "normal";
            const align = cfg.textAlign || "center";
            const pad = cfg.bgEnabled ? (cfg.bgPadding ?? 8) : 6;

            // ── 内容区定义 ─────────────────────────────────────────────
            // onDrawBackground 的 ctx 原点是节点本地左上角 (0,0)。
            // 顶部预留输入端口占用高度（标题栏 + 单个输入槽 + 余量），
            // 内容区 = [padding .. 节点底部]，字号缩放、居中、绘制全部限定在内容区内。
            const titleH = (LiteGraph.NODE_TITLE_HEIGHT ?? 30);
            const inputSlotH = (LiteGraph.NODE_SLOT_HEIGHT ?? 27);
            const nInputs = this.inputs?.length || 0;
            const contentTop = titleH + (nInputs > 0 ? inputSlotH : 0) + 2;
            const contentTopExact = Math.max(pad, contentTop - 25);   // 内容区顶部（排除输入端口高度，整体上移25px）
            const contentW = w - pad * 2;
            const contentH = Math.max(1, h - contentTopExact - pad);

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
                const lh = f * (cfg.lineHeight || 1.1);
                const fa = mm[0] ? (mm[0].actualBoundingBoxAscent || f) : f;
                const ld = mm[mm.length - 1] ? (mm[mm.length - 1].actualBoundingBoxDescent || f * 0.15) : f * 0.15;
                const blkH = wl.length > 1 ? fa + (wl.length - 1) * lh + ld : fa + ld;
                return { wl, mm, lh, fa, ld, blkH };
            };

            if (cfg.autoFit) {
                // 自适应：字号在 [4, 用户填写的字号] 区间内二分查找，
                // 找能放下整块文本且不超高内容区的最大字号。
                // 字号单调：越大→每行越宽越高→换行越多→整块越高，故可用二分。
                // 节点缩小→字变小；节点拉大→字变大并被用户设定的字号上限封顶。
                const maxF = Math.max(4, Math.round(fontSize) || DEFAULT_CFG.fontSize);
                const minF = 4;
                let bestF = minF;
                let bestM = measureAt(minF);
                let lo = minF, hi = maxF;
                while (lo <= hi) {
                    const mid = Math.floor((lo + hi) / 2);
                    const m = measureAt(mid);
                    if (m.blkH <= contentH) { bestF = mid; bestM = m; lo = mid + 1; }
                    else hi = mid - 1;
                }
                fs = bestF;
                wrapped = bestM.wl; wm = bestM.mm; lineHeight = bestM.lh;
                firstAscent = bestM.fa; lastDescent = bestM.ld;
            } else {
                // 固定字号：直接采用填写的数值，仅按内容区宽度自动换行
                const f = Math.max(4, Math.round(fontSize) || DEFAULT_CFG.fontSize);
                const m = measureAt(f);
                fs = f;
                wrapped = m.wl; wm = m.mm; lineHeight = m.lh;
                firstAscent = m.fa; lastDescent = m.ld;
            }

            const totalBlockH = wrapped.length > 1
                ? firstAscent + (wrapped.length - 1) * lineHeight + lastDescent
                : firstAscent + lastDescent;

            // 文字的起点 Y：按上下对齐（vAlign）计算（上对齐 top / 居中 center / 下对齐 bottom）
            const vAlign = cfg.vAlign || "center";
            let blockTop;
            if (vAlign === "top") blockTop = contentTopExact;
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

            // 底部状态提示（极小时才显示执行来源）
            const showHint = (this._texts || []).length > 1;

            wrapped.forEach((line, i) => {
                const y = startY + i * lineHeight;
                if (y - firstAscent > h) return;
                // textAlign 已设为 align，canvas 的 x 按对齐语义定位：
                // left=左起点, right=右边缘, center=文本中心（与小珠光标题一致）
                let x;
                if (align === "left") x = pad;
                else if (align === "right") x = w - pad;
                else x = w / 2;

                ctx.fillStyle = cfg.fontColor;
                ctx.fillText(line, x, y);
            });

            // 结束 clip（内容区裁剪），恢复为节点整体坐标系，供底部提示正常绘制
            ctx.restore();

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
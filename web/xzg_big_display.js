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
    fontSize: 40,        // 基准字号（图像空间）
    fontColor: "#ffffff",
    bgEnabled: false,
    bgColor: "#2a2a2a",
    bgOpacity: 0.9,
    borderRadius: 6,
    bgPadding: 8,
    textAlign: "center", // left / center / right
    lineHeight: 1.1,
    bold: false,
    glowEnabled: false,
    glowColor: "#4CAF50",
    glowSize: 12,
};
const CFG_KEY = "xzg_last_bigdisplay_config";

function loadCfg(defaults) {
    try {
        const s = localStorage.getItem(CFG_KEY);
        if (s) {
            const c = JSON.parse(s);
            if (c && typeof c === "object") return { ...defaults, ...c };
        }
    } catch (e) {}
    return { ...defaults };
}
function saveCfg(c) {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(c)); } catch (e) {}
}

app.registerExtension({
    name: "ComfyUI.xiaozhuguang.big_display",

    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== _NODE_TYPE) return;

        // 保留正常标题栏显示（隐藏可能导致空白异常，用户选择正常展示节点名）
        nodeType.collapsable = false;

        // 右键菜单：配置大字样式
        nodeType.prototype.addMenuOptions = function (menuOptions) {
            const opts = (this._menuHandle?.addMenuOptions
                ? this._menuHandle.addMenuOptions
                : null);
            if (opts) opts.call(this, menuOptions);

            menuOptions.push(null);
            menuOptions.push({
                content: xzgT("大字样式设置…", "Big Text Style…"),
                callback: () => this._openStyleDialog(),
            });
            return menuOptions;
        };

        // 右键大字样式设置对话框
        nodeType.prototype._openStyleDialog = function () {
            const node = this;
            const cfg = { ...(this._cfg || DEFAULT_CFG) };

            const wrap = document.createElement("div");
            wrap.style.cssText = "position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5);";
            const box = document.createElement("div");
            box.style.cssText = "background:#222;border:1px solid #444;border-radius:8px;padding:16px 18px;min-width:300px;color:#fff;font-family:'Microsoft YaHei',Arial,sans-serif;font-size:13px;box-shadow:0 8px 30px rgba(0,0,0,0.6);";
            box.innerHTML = `
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                    <b style="color:#ff8c00;font-size:14px;">${xzgT("大字样式设置", "Big Text Style")}</b>
                    <span id="xz-bd-close" style="cursor:pointer;color:#aaa;font-size:16px;">✕</span>
                </div>
            `;

            const rows = [
                { key: "fontSize", label: xzgT("字号", "Font Size"), type: "range", min: 12, max: 200, step: 1 },
                { key: "fontColor", label: xzgT("文字颜色", "Text Color"), type: "color" },
                { key: "bgEnabled", label: xzgT("显示背景", "Background"), type: "checkbox" },
                { key: "bgColor", label: xzgT("背景颜色", "BG Color"), type: "color" },
                { key: "bgOpacity", label: xzgT("背景透明度", "BG Opacity"), type: "range", min: 0, max: 1, step: 0.05 },
                { key: "roundedCorner", label: xzgT("圆角", "Corner Radius"), type: "range", min: 0, max: 24, step: 1 },
                { key: "padding", label: xzgT("内边距", "Padding"), type: "range", min: 0, max: 40, step: 1 },
                { key: "bold", label: xzgT("加粗", "Bold"), type: "checkbox" },
                { key: "glowEnabled", label: xzgT("发光", "Glow"), type: "checkbox" },
                { key: "glowColor", label: xzgT("发光颜色", "Glow Color"), type: "color" },
                { key: "glowSize", label: xzgT("发光强度", "Glow Size"), type: "range", min: 1, max: 60, step: 1 },
                { key: "letterSpacing", label: xzgT("字间距", "Letter Spacing"), type: "range", min: -10, max: 40, step: 1 },
            ];

            const inputs = {};
            for (const r of rows) {
                const div = document.createElement("div");
                div.style.cssText = "display:flex;align-items:center;gap:10px;margin:8px 0;";
                const lab = document.createElement("span");
                lab.style.cssText = "width:96px;text-align:right;color:#ccc;flex-shrink:0;";
                lab.textContent = r.label;
                div.appendChild(lab);
                let inp;
                if (r.type === "range") {
                    inp = document.createElement("input");
                    inp.type = "range";
                    inp.min = r.min; inp.max = r.max; inp.step = r.step;
                    inp.value = cfg[r.key] ?? (r.min + (r.max - r.min) / 2);
                    inp.style.cssText = "flex:1;accent-color:#ff8c00;";
                } else if (r.type === "checkbox") {
                    inp = document.createElement("input");
                    inp.type = "checkbox";
                    inp.checked = !!cfg[r.key];
                    inp.style.cssText = "accent-color:#ff8c00;transform:scale(1.2);";
                } else if (r.type === "color") {
                    inp = document.createElement("input");
                    inp.type = "color";
                    inp.value = cfg[r.key] || "#ffffff";
                    inp.style.cssText = "width:42px;height:24px;border:none;background:none;cursor:pointer;";
                }
                if (r.type === "range" && r.min >= 1) inp.step = r.step || 1;
                inputs[r.key] = inp;
                div.appendChild(inp);
                box.appendChild(div);
            }

            // 对齐命名到 cfg 实际字段（roundedCorner→borderRadius, padding→bgPadding, letterSpacing 可选）
            const alias = { roundedCorner: "borderRadius", padding: "bgPadding" };

            const apply = () => {
                for (const r of rows) {
                    const v = inputs[r.key];
                    const target = alias[r.key] || r.key;
                    if (r.type === "checkbox") cfg[target] = v.checked;
                    else if (r.type === "color") cfg[target] = v.value;
                    else {
                        const num = parseFloat(v.value);
                        cfg[target] = Number.isFinite(num) ? num : cfg[target];
                    }
                }
                node._cfg = cfg;
                saveCfg(cfg);
                node.setDirtyCanvas?.(true, true);
                app.graph?.setDirtyCanvas(true, true);
            };

            for (const r of rows) {
                const inp = inputs[r.key];
                if (inp) {
                    inp.addEventListener(r.type === "checkbox" ? "change" : "input", apply);
                }
            }

            const btns = document.createElement("div");
            btns.style.cssText = "display:flex;justify-content:flex-end;gap:10px;margin-top:14px;";
            const ok = document.createElement("button");
            ok.textContent = xzgT("确定", "OK");
            ok.style.cssText = "padding:6px 16px;background:#ff8c00;border:none;border-radius:4px;color:#000;font-weight:600;cursor:pointer;";
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
            this._cfg = loadCfg(DEFAULT_CFG);
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
            this._cfg = loadCfg(this._cfg || DEFAULT_CFG);
            // 从恢复的工作流读取已显示文本（若有）
            const wv = this.widgets_values;
            try {
                if (wv && typeof wv === "object" && wv.length > 0) {
                    const first = wv.find((x) => x && x.texts);
                    if (first && Array.isArray(first.texts)) this._texts = first.texts;
                }
            } catch (e) {}
            return r;
        };

        const origSerialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function (o) {
            const r = origSerialize?.apply(this, arguments);
            try {
                if (!o.widgets_values) o.widgets_values = [];
                o.widgets_values.push({ texts: this._texts || [] });
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
            // 背景
            if (cfg.bgEnabled && cfg.bgColor && cfg.bgColor !== "transparent") {
                ctx.globalAlpha = cfg.bgOpacity ?? 1;
                ctx.fillStyle = cfg.bgColor;
                const br = cfg.borderRadius ?? 6;
                ctx.beginPath();
                ctx.roundRect(1, 1, w - 2, h - 2, Math.min(br, 16));
                ctx.fill();
                ctx.globalAlpha = 1;
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

            // 字号双向缩放：以基准 fontSize 试测量文本块，横向/纵向分别算"填满内容区"的缩放比，
            // 取两者的较小值（保证宽高都不溢出）。节点拉大→字放大，节点缩小→字减小，自由由节点尺寸决定。
            const baseFonts = Array.from({ length: lines.length }, () => ({
                w: 0, asc: fontSize, desc: fontSize * 0.15,
            }));
            let fs = fontSize;
            {
                const measure = (f) => {
                    ctx.font = `${weight} ${f}px "Microsoft YaHei", "微软雅黑", "PingFang SC", "SimHei", Arial, sans-serif`;
                    return lines.map((ln) => {
                        const m = ctx.measureText(ln);
                        return {
                            w: m.width,
                            asc: m.actualBoundingBoxAscent || f,
                            desc: m.actualBoundingBoxDescent || f * 0.15,
                        };
                    });
                };
                let m = measure(fs);
                const availW = contentW;
                const lineH = fs * (cfg.lineHeight || 1.1);
                const asc = (m[0] && m[0].asc) || fs;
                const desc = (m[m.length - 1] && m[m.length - 1].desc) || fs * 0.15;
                const blockH = asc + (lines.length - 1) * lineH + desc;
                const availH = contentH;

                // 横向：填满内容区可用的放大/缩小比
                const maxWidth = m.reduce((mx, x) => Math.max(mx, x.w), 0);
                let scaleX = maxWidth > 0 ? availW / maxWidth : 1;
                // 纵向：填满内容区可用的放大/缩小比
                let scaleY = blockH > 0 ? availH / blockH : 1;
                // 取交集（较小者），保证宽、高都不溢出；>1 时即放大，<1 时即缩小
                let scale = Math.min(scaleX, scaleY);
                if (scale > 0 && Math.abs(scale - 1) > 0.001) {
                    fs = Math.max(4, fs * scale);   // 双向自由缩放，不设上限；节点越大字越大，节点越小字越小
                }
                ctx.font = `${weight} ${fs}px "Microsoft YaHei", "微软雅黑", "PingFang SC", "SimHei", Arial, sans-serif`;
                baseFonts.length = 0;
                for (const ln of lines) {
                    const mm = ctx.measureText(ln);
                    baseFonts.push({
                        w: mm.width,
                        asc: mm.actualBoundingBoxAscent || fs,
                        desc: mm.actualBoundingBoxDescent || fs * 0.15,
                    });
                }
            }

            const lineHeight = fs * (cfg.lineHeight || 1.1);
            const firstAscent = baseFonts[0] ? baseFonts[0].asc : fs;
            const lastDescent = baseFonts[baseFonts.length - 1] ? baseFonts[baseFonts.length - 1].desc : fs * 0.15;
            const totalBlockH = lines.length > 1
                ? firstAscent + (lines.length - 1) * lineHeight + lastDescent
                : firstAscent + lastDescent;

            // 文字垂直居中于内容区
            const startY = contentTopExact + (contentH - totalBlockH) / 2 + firstAscent;

            // 裁剪：从内容区顶部开始强制裁剪，确保文字绝不画入输入端口区域
            ctx.save();
            ctx.beginPath();
            ctx.rect(pad, contentTopExact, contentW, contentH);
            ctx.clip();

            ctx.textBaseline = "alphabetic";
            ctx.textAlign = align;

            // 底部状态提示（极小时才显示执行来源）
            const showHint = (this._texts || []).length > 1;

            lines.forEach((line, i) => {
                const y = startY + i * lineHeight;
                if (y - firstAscent > h) return;
                // textAlign 已设为 align，canvas 的 x 按对齐语义定位：
                // left=左起点, right=右边缘, center=文本中心（与小珠光标题一致）
                let x;
                if (align === "left") x = pad;
                else if (align === "right") x = w - pad;
                else x = w / 2;

                if (cfg.glowEnabled) {
                    ctx.save();
                    ctx.shadowColor = cfg.glowColor;
                    ctx.shadowBlur = cfg.glowSize * 2;
                    ctx.globalAlpha = 0.15;
                    ctx.fillStyle = cfg.fontColor;
                    ctx.fillText(line, x, y);
                    ctx.restore();
                }
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
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const XZG_IMAGE_PREVIEW_TYPE = "XiaozhuguangImagePreview";
const IMAGE_MARGIN = 6;

function imageUrl(data) {
    return api.apiURL(
        `/view?filename=${encodeURIComponent(data.filename)}&type=${data.type}&subfolder=${data.subfolder}${app.getPreviewFormatParam()}${app.getRandParam()}`
    );
}

// 安全设置节点尺寸：节点刚创建/加载时 this.size 可能是数字(如 270)或 NaN，
// 直接用 litegraph 的 node.computeSize 会因内部对数字 this.size 赋值 [0] 而报错，
// 故改为直接调用 widget 自身的 computeSize 计算尺寸，再 setSize。
function xzgSafeSetSize(node) {
    let w = node.size;
    if (Array.isArray(w)) w = w[0];
    if (typeof w !== "number" || !isFinite(w)) w = 270;
    const widget = node.canvasWidget;
    const size = widget ? widget.computeSize(w) : [w, 300];
    node.setSize(size);
}

// 时间戳：格式 yyyyMMdd_HHmmss，用于保存文件名避免重复
function xzgTimestamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// 通过 fetch 转 blob 下载，确保 download 文件名生效（跨域 URL 时浏览器会忽略 download 属性）
async function xzgDownload(url, filename) {
    try {
        const resp = await fetch(url);
        if (!resp.ok) return;
        const blob = await resp.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    } catch (e) {
        console.warn("[小珠光] 下载失败:", e);
    }
}

async function downloadImage(imgData) {
    if (!imgData) return;
    let url = imgData.real_url;

    if (!url && imgData.real_token) {
        // 懒编码：请求后端临时编码全分辨率 PNG（仅右键时触发，不拖慢执行）
        try {
            const resp = await api.fetchApi("/xzg_save_real", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token: imgData.real_token, index: imgData.real_index }),
            });
            if (!resp.ok) return;
            const info = await resp.json();
            if (info && info.filename) {
                url = api.apiURL(`/view?filename=${encodeURIComponent(info.filename)}&type=${info.type}&subfolder=${encodeURIComponent(info.subfolder)}${app.getRandParam()}`);
            }
        } catch (e) {
            return;
        }
    }
    if (!url) return;

    await xzgDownload(url, `xzg-preview-${xzgTimestamp()}.png`);
}

// JPG保存：直接借用现有的压缩预览图（后端已生成的 JPG），无需后端再编码
async function downloadJpgImage(imgData) {
    if (!imgData || !imgData.url) return;
    await xzgDownload(imgData.url, `xzg-preview-${xzgTimestamp()}.jpg`);
}


// ============ 自定义 Widget ============
class XzgImagePreviewWidget {
    constructor(name, node) {
        this.type = "custom";
        this.name = name;
        this.node = node;
        this.hitAreas = {};
        this._value = { images: [] };
        this.currentIndex = 0;
        this.gridMode = false;
        this._mousePos = null;
        this._btnFade = 0;
        this._lastClickT = 0;
        this._lastClickPos = null;
    }

    set value(v) {
        let cleaned;
        if (Array.isArray(v)) {
            cleaned = v.map((d, i) => {
                if (!d || typeof d === "string") {
                    d = { url: d, name: String(i + 1), selected: true };
                }
                return d;
            });
        } else {
            cleaned = (v && v.images) || [];
        }
        this._value.images = cleaned;
        if (this.currentIndex >= cleaned.length) this.currentIndex = 0;
    }

    get value() {
        return this._value;
    }

    _ensureImg(imgData) {
        if (!imgData) return;
        if (imgData.img && imgData.img.naturalWidth) return;
        if (imgData._loading) return;
        imgData._loading = true;
        const newImg = new Image();
        newImg.onload = () => {
            // 仅刷新显示，不持久化；刷新后图自动消失，下次执行重新加载
            this.node.setDirtyCanvas(true, true);
        };
        newImg.src = imgData.url;
        imgData.img = newImg;
    }

    draw(ctx, node, width, y) {
        this.hitAreas = {};
        const btnH = 18;
        const imgs = this._value.images;

        // 按钮行：减小卡顿 / 极速流畅 切换（若存在）
        const lagWidget = node.widgets?.find(w => w.name === "reduce_lag");
        if (lagWidget) {
            ctx.font = "11px Arial";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillStyle = "#aaaaaa";
            ctx.fillText(lagWidget.value ? "极致流畅" : "减小卡顿", width / 2, y + btnH / 2);
            this.hitAreas["reduce_lag"] = {
                bounds: [0, y, width, btnH],
                onDown: () => { lagWidget.value = !lagWidget.value; node.setDirtyCanvas(true); }
            };
            y += btnH + 4;
        }

        if (!imgs.length) return;

        // 图像区域（无任何 hitArea，可拖拽节点）
        if (this.gridMode) {
            this._drawGrid(ctx, node, width, y, imgs);
        } else {
            this._drawSingle(ctx, node, width, y, imgs);
        }
    }

    _drawSingle(ctx, node, width, y, imgs) {
        const imgData = imgs[this.currentIndex];
        if (!imgData) return;
        this._ensureImg(imgData);

        const nodeHeight = node.size[1] - y - IMAGE_MARGIN;
        if (nodeHeight <= 0) return;
        const effW = width - IMAGE_MARGIN * 2;

        let destX = IMAGE_MARGIN, destY = y, targetW = effW, targetH = nodeHeight;
        const img = imgData.img;
        if (img && img.naturalWidth) {
            const natW = img.naturalWidth, natH = img.naturalHeight;
            const imageAspect = natW / natH;
            const widgetAspect = effW / nodeHeight;
            if (imageAspect > widgetAspect) {
                targetW = effW;
                targetH = effW / imageAspect;
            } else {
                targetH = nodeHeight;
                targetW = nodeHeight * imageAspect;
            }
            destX = IMAGE_MARGIN + (effW - targetW) / 2;
            destY = y + (nodeHeight - targetH) / 2;
            ctx.drawImage(img, destX, destY, targetW, targetH);
        }

        // 三等分判定：左 1/3 上一页、中 1/3 网格、右 1/3 下一页
        const drawW = (img && img.naturalWidth) ? targetW : effW;
        const drawX = (img && img.naturalWidth) ? destX : IMAGE_MARGIN;
        const imgLoaded = img && img.naturalWidth;
        const third = drawW / 3;
        const fifth2 = drawW / 5;

        if (imgLoaded && imgs.length > 1) {
            this.hitAreas["prev"] = {
                bounds: [drawX, y, third, nodeHeight],
                onDown: () => this._step(-1, node)
            };
            this.hitAreas["toggle_grid"] = {
                bounds: [drawX + third, y, third, nodeHeight],
                onDown: () => { this.gridMode = !this.gridMode; node.setDirtyCanvas(true, true); }
            };
            this.hitAreas["next"] = {
                bounds: [drawX + third * 2, y, third, nodeHeight],
                onDown: () => this._step(1, node)
            };
        }

        // 图标渐入：鼠标在任一 1/3 区域时显示，离开立即消失
        if (imgLoaded && imgs.length > 1) {
            const inY = this._mousePos && this._mousePos[1] >= y && this._mousePos[1] <= y + nodeHeight;
            const inX = this._mousePos && this._mousePos[0] >= drawX && this._mousePos[0] <= drawX + drawW;
            const near = inY && inX;
            if (near) { this._btnFade = Math.min(1, this._btnFade + 0.1); }
            else { this._btnFade = 0; }
            if (this._btnFade > 0.01) {
                const a = this._btnFade;
                const iconY = y + nodeHeight - 12;
                const cx0 = drawX + fifth2 / 2;
                const cx1 = drawX + fifth2 * 2.5;
                const cx2 = drawX + fifth2 * 4.5;
                ctx.textBaseline = "middle";
                ctx.textAlign = "center";

                ctx.font = "16px Arial";
                ctx.fillStyle = `rgba(255,255,255,${a * 0.85})`;
                ctx.fillText("◀", cx0, iconY);

                ctx.font = "33px Arial";
                const ca = a * (this.gridMode ? 0.9 : 0.85);
                ctx.fillStyle = this.gridMode ? `rgba(136,204,255,${ca})` : `rgba(255,255,255,${ca})`;
                ctx.fillText("○", cx1, iconY);

                ctx.font = "16px Arial";
                ctx.fillStyle = `rgba(255,255,255,${a * 0.85})`;
                ctx.fillText("▶", cx2, iconY);
            }
        }
    }

    _drawGrid(ctx, node, width, y, imgs) {
        const gap = 2;
        const effW = width - IMAGE_MARGIN * 2;
        const nodeH = node.size[1] - y - IMAGE_MARGIN;
        // 自动选最佳列数：缩略图在节点内完全可见，不低于 20px
        let bestCell = 0, bestCols = 1;
        const maxCols = Math.max(1, Math.floor(effW / 30));
        for (let c = 1; c <= maxCols; c++) {
            const rows = Math.ceil(imgs.length / c);
            const cellW = (effW - gap * (c - 1)) / c;
            const cellH = (nodeH - gap * (rows - 1)) / rows;
            const cell = Math.min(cellW, cellH);
            if (cell > bestCell) { bestCell = cell; bestCols = c; }
        }
        const cell = Math.max(20, bestCell);
        const cols = bestCols;
        const rows = Math.ceil(imgs.length / cols);
        const gridW = cols * cell + (cols - 1) * gap;
        const gridH = rows * cell + (rows - 1) * gap;
        const startX = IMAGE_MARGIN + (effW - gridW) / 2;
        const startY = y + (nodeH - gridH) / 2;
        let cx = startX, cy = startY;

        for (let i = 0; i < imgs.length; i++) {
            const imgData = imgs[i];
            this._ensureImg(imgData);
            const img = imgData.img;

            ctx.fillStyle = "rgba(128,128,128,0.4)";
            ctx.fillRect(cx, cy, cell, cell);

            if (img && img.naturalWidth) {
                const ia = img.naturalWidth / img.naturalHeight;
                let tw = cell, th = cell;
                if (ia > 1) th = cell / ia; else tw = cell * ia;
                ctx.drawImage(img, cx + (cell - tw) / 2, cy + (cell - th) / 2, tw, th);
            }

            ctx.fillStyle = "rgba(255,255,255,0.8)";
            ctx.font = "11px Arial";
            ctx.textAlign = "left";
            ctx.textBaseline = "top";
            ctx.fillText(String(i + 1), cx + 3, cy + 2);

            // 缩略图点击有 hitArea；间隙处无 hitArea → 可拖拽
            if (img && img.naturalWidth) {
                this.hitAreas["grid_" + i] = {
                    bounds: [cx, cy, cell, cell],
                    index: i,
                    onDown: () => {
                        this.currentIndex = i;
                        this.gridMode = false;
                        node.setDirtyCanvas(true, true);
                    }
                };
            }

            cx += cell + gap;
            if ((i + 1) % cols === 0) { cx = startX; cy += cell + gap; }
        }

    }

    _step(dir, node) {
        const n = this._value.images.length;
        if (n <= 1) return;
        this.currentIndex = (this.currentIndex + dir + n) % n;
        this._ensureImg(this._value.images[this.currentIndex]);
        node.setDirtyCanvas(true, true);
    }

    computeSize(width) {
        const node = this.node;
        const ns = node.size;
        let w = width;
        if (typeof w !== "number" || !isFinite(w)) {
            w = (Array.isArray(ns) ? ns[0] : (typeof ns === "number" ? ns : 270)) || 270;
        }
        // 返回固定最小高度，实际绘制高度由 draw 中的 node.size[1] - y 决定
        // 避免返回 ns[1] 导致与上方控件高度叠加引发无限增长
        return [w, 200];
    }

    serializeValue(node, index) {
        // 不持久化图片，刷新后自动消失，确保重新执行
        return { images: [] };
    }

    mouse(event, pos, node) {
        if (event.type === "pointerdown" && event.button === 0) {
            // 双击检测
            const now = performance.now();
            const isDouble = this._lastClickPos &&
                (now - this._lastClickT) < 300 &&
                Math.abs(pos[0] - this._lastClickPos[0]) < 8 &&
                Math.abs(pos[1] - this._lastClickPos[1]) < 8;
            this._lastClickT = now;
            this._lastClickPos = [pos[0], pos[1]];

            for (const [key, area] of Object.entries(this.hitAreas)) {
                const [bx, by, bw, bh] = area.bounds;
                if (pos[0] >= bx && pos[0] <= bx + bw && pos[1] >= by && pos[1] <= by + bh) {
                    if (isDouble && area.onDouble) { area.onDouble(event, pos, node, area); return true; }
                    if (!isDouble && area.onDown) { area.onDown(event, pos, node, area); return true; }
                }
            }
            // 点击 body 任意位置均消费事件，禁止拖拽
            return true;
        }
        return false;
    }
}


// ============ 自定义节点 ============
class XiaozhuguangImagePreviewNode {
    constructor() {
        this.canvasWidget = null;
    }

    onExecuted(output) {
        const imgs = output.xzg_preview || [];
        const imagesToShow = imgs.map((d, i) => ({
            name: String(i + 1),
            selected: i === 0,
            url: imageUrl(d),
            real_url: d.real ? imageUrl(d.real) : null,
            real_name: d.real ? d.real.filename : null,
            real_token: d.real_token || null,
            real_index: (d.real_index != null) ? d.real_index : i,
            real_width: d.real_width,
            real_height: d.real_height,
        }));
        this.canvasWidget.value = { images: imagesToShow };
        // 多图（批次）时默认网格模式
        if (imagesToShow.length > 1) {
            this.canvasWidget.gridMode = true;
        }
        // 不重设尺寸，保持用户上次手动调整的大小；仅重绘
        this.setDirtyCanvas(true, true);
    }

    onSerialize(serialised) {
        if (this.canvasWidget) {
            for (let [index, wv] of (serialised.widgets_values || []).entries()) {
                if (this.widgets[index] && this.widgets[index].name === "xzg_image_preview") {
                    serialised.widgets_values[index] = this.canvasWidget.value.images.map(d => {
                        const copy = { ...d };
                        delete copy.img;
                        return copy;
                    });
                }
            }
        }
    }

    onMouseMove(e, pos) {
        if (this.canvasWidget) { this.canvasWidget._mousePos = [pos[0], pos[1]]; this.setDirtyCanvas(true, true); }
    }
    onMouseLeave(e, pos) {
        if (this.canvasWidget) { this.canvasWidget._mousePos = null; this.setDirtyCanvas(true, true); }
    }

    onNodeCreated() {
        const node = this;
        const w = this.addCustomWidget(new XzgImagePreviewWidget("xzg_image_preview", this));
        this.canvasWidget = w;
        // 将预览控件排到最前，使预览图位于路径类控件上方
        if (this.widgets) {
            this.widgets = [w, ...this.widgets.filter(x => x !== w)];
        }
        // hitArea 区域（按钮等）返回 widget → 可交互；
        // 图像等非 hitArea 区域返回 null → 可拖拽节点
        if (!node.getWidgetOnPos.__xzgPatched) {
            node.getWidgetOnPos = function (x, y, includeDisabled, ...rest) {
                const lx = x - node.pos[0];
                const ly = y - node.pos[1];
                const titleH = (typeof LiteGraph !== 'undefined' && LiteGraph.NODE_TITLE_HEIGHT) || 30;
                // 跳过标题栏和右下角缩放区域（保留 12px 缩放手柄）
                if (lx >= 0 && lx <= node.size[0] - 12 && ly >= titleH && ly <= node.size[1] - 12) {
                    if (node.canvasWidget) return node.canvasWidget;
                }
                return null;
            };
            node.getWidgetOnPos.__xzgPatched = true;
        }
        // 仅在尺寸本身是无效值（节点刚创建时 this.size 可能是数字/NaN）时修正，
        // 以触发 litegraph 的 setSize 初始化；已恢复或用户手动调整的尺寸一律保留，
        // 避免刷新/重载工作流后节点被重置为默认大小。
        const s = this.size;
        if (!Array.isArray(s) || !isFinite(s[0]) || !isFinite(s[1])) {
            let n = s;
            if (Array.isArray(n)) n = n[0];
            if (typeof n !== "number" || !isFinite(n)) n = 270;
            this.setSize([n, 300]);
        }
        setTimeout(() => { this.setDirtyCanvas(true, true); }, 0);
    }

    onDrawForeground(ctx, canvas) {
        // 禁用默认 PreviewImage 的小图绘制
    }

    getHelp() {
        return `
            <p>小珠光预览节点，用于预览图像（支持多图切换）。</p>
            <ul>
                <li><strong>减少卡顿</strong>：开启后预览压缩为最长边3840px的JPG（质量85），适合大图场景。</li>
                <li><strong>极速流畅</strong>：关闭减少卡顿，预览为最长边6400px的JPG（质量80）。</li>
            </ul>
            <p><strong>输入</strong>：<code>images</code></p>
        `;
    }

    static category = "xiaozhuguang";
    static title = "小珠光预览";
    static type = XZG_IMAGE_PREVIEW_TYPE;
}


// ============ 注册扩展 ============
app.registerExtension({
    name: "xiaozhuguang.ImagePreview",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name === XZG_IMAGE_PREVIEW_TYPE) {
            nodeType.prototype.previewWidget = null;
            nodeType.prototype.onPreviewRegistered = function () {};

            const origOnNodeCreated = nodeType.prototype.onNodeCreated;
            const origOnExecuted = nodeType.prototype.onExecuted;
            const origOnDrawForeground = nodeType.prototype.onDrawForeground;
            const origOnSerialize = nodeType.prototype.onSerialize;
            const origGetHelp = nodeType.prototype.getHelp;

            const proto = XiaozhuguangImagePreviewNode.prototype;

            nodeType.prototype.onNodeCreated = function () {
                this.canvasWidget = null;
                proto.onNodeCreated.call(this);

                for (const w of this.widgets || []) {
                    if (w.name === "reduce_lag") {
                        w.type = "hidden";
                        w.computeSize = () => [0, 0];
                        w.draw = () => {};
                    }
                }
                // 完全移除 reduce_lag 输入端口
                if (this.inputs) {
                    this.inputs = this.inputs.filter(inp => inp.name !== "reduce_lag");
                }
            };

            nodeType.prototype.onExecuted = function (output) {
                proto.onExecuted.call(this, output);
            };

            nodeType.prototype.onDrawForeground = function (ctx, canvas) {
                proto.onDrawForeground.call(this, ctx, canvas);
            };

            nodeType.prototype.onSerialize = function (o) {
                proto.onSerialize.call(this, o);
            };

            nodeType.prototype.onMouseMove = function (e, pos) {
                proto.onMouseMove.call(this, e, pos);
            };
            nodeType.prototype.onMouseLeave = function (e, pos) {
                proto.onMouseLeave.call(this, e, pos);
            };

            nodeType.prototype.getHelp = function () {
                return proto.getHelp.call(this);
            };

            // 防御：任何 setSize 调用前先把 this.size 规范为有限数组，
            // 避免 litegraph 内部对 NaN/数字 this.size 赋值 [0] 报错（加载工作流时常见）。
            const origSetSize = nodeType.prototype.setSize;
            nodeType.prototype.setSize = function (size, skip_compute) {
                if (!Array.isArray(this.size) ||
                    !isFinite(this.size[0]) || !isFinite(this.size[1])) {
                    let n = this.size;
                    if (Array.isArray(n)) n = n[0];
                    if (typeof n !== "number" || !isFinite(n)) n = 270;
                    this.size = [n, n];
                }
                return origSetSize ? origSetSize.call(this, size, skip_compute) : undefined;
            };

            // 最小尺寸限制
            nodeType.prototype.onNodeCreated = (function(orig) {
                return function () {
                    orig.call(this);
                    const MIN_H = 300;
                    this.minHeight = Math.max(this.minHeight || 0, MIN_H);
                    const origSetSize2 = this.setSize.bind(this);
                    this.setSize = function (size) {
                        const w = size?.[0] || this.size?.[0] || 300;
                        const h = Math.max(size?.[1] || this.size?.[1] || 300, MIN_H);
                        origSetSize2([w, h]);
                    };
                };
            })(nodeType.prototype.onNodeCreated);

            // 右键菜单：保存原图（预览为压缩图，但右键保存的是真实分辨率）
            // PNG保存(真实分辨率)与JPG保存(压缩预览)紧邻，置于菜单最上面两行
            // 通过 getExtraMenuOptions 直接操作最终 options 数组，确保排在最前面
            const origGetExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
            nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
                if (origGetExtraMenuOptions) origGetExtraMenuOptions.call(this, canvas, options);
                if (!options || !Array.isArray(options)) return;
                const w = this.canvasWidget;
                // 网格模式下不提供保存功能
                if (w && !w.gridMode && w.value && w.value.images && w.value.images.length) {
                    const cur = w.value.images[w.currentIndex] || w.value.images[0];
                    const saveOpts = [
                        {
                            content: `<span style="color:#4CAF50;">PNG保存</span>`,
                            callback: () => { downloadImage(cur); }
                        },
                        {
                            content: `<span style="color:#4CAF50;">JPG保存</span>`,
                            callback: () => { downloadJpgImage(cur); }
                        }
                    ];
                    // 插入到 options 数组最开头，紧跟一个分隔符
                    options.splice(0, 0, ...saveOpts, null);
                }
            };
        }
    },
});

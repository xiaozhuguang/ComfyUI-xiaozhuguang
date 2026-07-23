import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const XZG_IMAGE_SAVE_TYPE = "XiaozhuguangImageSave";
const IMAGE_MARGIN = 6;

function imageUrl(data) {
    return api.apiURL(
        `/view?filename=${encodeURIComponent(data.filename)}&type=${data.type}&subfolder=${data.subfolder}${app.getPreviewFormatParam()}${app.getRandParam()}`
    );
}

function downloadImage(imgData) {
    if (!imgData || !imgData.real_url) return;
    const a = document.createElement("a");
    a.href = imgData.real_url;
    a.download = imgData.real_name || (imgData.name + ".png");
    document.body.appendChild(a);
    a.click();
    a.remove();
}


// ============ 自定义 Widget ============
class XzgImageSaveWidget {
    constructor(name, node) {
        this.type = "custom";
        this.name = name;
        this.node = node;
        this.hitAreas = {};
        this._value = { images: [] };
        this.currentIndex = 0;
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

    draw(ctx, node, width, y) {
        this.hitAreas = {};

        // 绘制按钮行：减小卡顿 / 极速流畅
        const lagWidget = node.widgets?.find(w => w.name === "reduce_lag");
        if (lagWidget) {
            const btnH = 18;
            const SWAP_COLOR = "#aaaaaa";
            ctx.font = "11px Arial";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";

            const btnW = node.size[0];
            ctx.fillStyle = SWAP_COLOR;
            ctx.fillText(lagWidget.value ? "极致流畅" : "减小卡顿", btnW / 2, y + btnH / 2);
            this.hitAreas["reduce_lag"] = {
                bounds: [0, y, btnW, btnH],
                onDown: () => { lagWidget.value = !lagWidget.value; node.setDirtyCanvas(true); }
            };

            // 同一行右侧显示真实分辨率（预览本身是压缩图）
            const cur0 = this._value.images[this.currentIndex];
            if (cur0 && cur0.real_width) {
                ctx.fillStyle = "#bbbbbb";
                ctx.font = "11px Arial";
                ctx.textAlign = "right";
                ctx.textBaseline = "middle";
                ctx.fillText(`${cur0.real_width} x ${cur0.real_height}`, node.size[0] - 8, y + btnH / 2);
            }

            y += btnH + 4;
        }

        const imgs = this._value.images;
        if (!imgs.length) return;

        if (imgs.length > 1) {
            ctx.textAlign = "left";
            ctx.textBaseline = "top";
            ctx.font = "14px Arial";
            let x = 10;
            const spacing = 6;
            for (let i = 0; i < imgs.length; i++) {
                const img = imgs[i];
                const tw = ctx.measureText(img.name).width + 12;
                const selected = i === this.currentIndex;
                ctx.fillStyle = selected ? "rgba(180,180,180,1)" : "rgba(180,180,180,0.4)";
                ctx.fillText(img.name, x + 6, y + 3);
                this.hitAreas["tab_" + i] = {
                    bounds: [x, y, tw, 18],
                    index: i,
                    onDown: () => {
                        this.currentIndex = i;
                        const cur = imgs[i];
                        if (cur && !cur.img) {
                            const newImg = new Image();
                            newImg.src = cur.url;
                            cur.img = newImg;
                        }
                        node.setDirtyCanvas(true, true);
                    }
                };
                x += tw + spacing;
            }
            y += 22;
        }

        this._drawImage(ctx, node, width, y, imgs[this.currentIndex]);
    }

    _drawImage(ctx, node, width, y, imgData) {
        if (!imgData) return;
        if (!imgData.img || !imgData.img.naturalWidth) {
            if (!imgData._loading) {
                imgData._loading = true;
                const newImg = new Image();
                newImg.onload = () => { node.setDirtyCanvas(true, true); };
                newImg.src = imgData.url;
                imgData.img = newImg;
            }
            return;
        }
        const img = imgData.img;

        const nodeHeight = node.size[1] - y - IMAGE_MARGIN;
        if (nodeHeight <= 0) return;

        const effW = width - IMAGE_MARGIN * 2;
        const imgW = img.naturalWidth;
        const imgH = img.naturalHeight;
        const imageAspect = imgW / imgH;
        const widgetAspect = effW / nodeHeight;

        let targetW, targetH;
        if (imageAspect > widgetAspect) {
            targetW = effW;
            targetH = effW / imageAspect;
        } else {
            targetH = nodeHeight;
            targetW = nodeHeight * imageAspect;
        }

        const destX = IMAGE_MARGIN + (effW - targetW) / 2;
        const destY = y + (nodeHeight - targetH) / 2;

        ctx.save();
        ctx.drawImage(img, destX, destY, targetW, targetH);
        ctx.restore();
    }

    computeSize(width) {
        const node = this.node;
        const defaultH = 300;
        const switchRowH = 22;
        const cur = this._value.images[this.currentIndex];
        if (cur && cur.img && cur.img.naturalWidth) {
            const img = cur.img;
            const imgAspect = img.naturalWidth / img.naturalHeight;
            const nodeAspect = width / (defaultH - switchRowH);
            if (imgAspect > nodeAspect) {
                return [width, width / imgAspect + IMAGE_MARGIN + switchRowH];
            }
        }
        return [width, defaultH + IMAGE_MARGIN + switchRowH];
    }

    serializeValue(node, index) {
        const v = [];
        for (const d of this._value.images) {
            const copy = { ...d };
            delete copy.img;
            v.push(copy);
        }
        return { images: v };
    }

    mouse(event, pos, node) {
        if (event.type === "pointerdown" && event.button === 0) {
            for (const [key, area] of Object.entries(this.hitAreas)) {
                const [bx, by, bw, bh] = area.bounds;
                if (pos[0] >= bx && pos[0] <= bx + bw && pos[1] >= by && pos[1] <= by + bh) {
                    area.onDown?.(event, pos, node, area);
                    return true;
                }
            }
        }
        return false;
    }
}


// ============ 自定义节点 ============
class XiaozhuguangImageSaveNode {
    constructor() {
        this.canvasWidget = null;
    }

    onExecuted(output) {
        const imgs = output.xzg_preview || [];
        const imagesToShow = imgs.map((d, i) => ({
            name: String(i + 1),
            selected: i === 0,
            url: imageUrl(d),
            real_url: d.real ? imageUrl(d.real) : imageUrl(d),
            real_name: d.real ? d.real.filename : d.filename,
            real_width: d.real_width,
            real_height: d.real_height,
        }));
        this.canvasWidget.value = { images: imagesToShow };
        this.setDirtyCanvas(true, true);
    }

    onSerialize(serialised) {
        if (this.canvasWidget) {
            for (let [index, wv] of (serialised.widgets_values || []).entries()) {
                if (this.widgets[index] && this.widgets[index].name === "xzg_image_save") {
                    serialised.widgets_values[index] = this.canvasWidget.value.images.map(d => {
                        const copy = { ...d };
                        delete copy.img;
                        return copy;
                    });
                }
            }
        }
    }

    onNodeCreated() {
        const node = this;
        const w = this.addCustomWidget(new XzgImageSaveWidget("xzg_image_save", this));
        this.canvasWidget = w;
        // 将预览控件排到最前，使预览图位于路径类控件上方
        if (this.widgets) {
            this.widgets = [w, ...this.widgets.filter(x => x !== w)];
        }
        // 让图像区域（按钮/标签以外）被视为节点本体，从而可用左键拖动节点。
        if (!node.getWidgetOnPos.__xzgPatched) {
            const origGetWidgetOnPos = node.getWidgetOnPos.bind(node);
            node.getWidgetOnPos = function (x, y, includeDisabled, ...rest) {
                const hit = origGetWidgetOnPos(x, y, includeDisabled, ...rest);
                if (hit && hit === w && hit.hitAreas) {
                    const lx = x - node.pos[0];
                    const ly = y - node.pos[1];
                    let onArea = false;
                    for (const area of Object.values(hit.hitAreas)) {
                        const [bx, by, bw, bh] = area.bounds;
                        if (lx >= bx && lx <= bx + bw && ly >= by && ly <= by + bh) { onArea = true; break; }
                    }
                    if (!onArea) return null;
                }
                return hit;
            };
            node.getWidgetOnPos.__xzgPatched = true;
        }
        this.setSize(this.computeSize());
        this.setDirtyCanvas(true, true);
    }

    onDrawForeground(ctx, canvas) {
        // 禁用默认 PreviewImage 的小图绘制
    }

    getHelp() {
        return `
            <p>小珠光保存节点，保存图像为 JPG 95% 或 PNG，并显示压缩预览。</p>
            <ul>
                <li><strong>保存格式</strong>：JPG 95%（高质量）或 PNG（无损）。</li>
                <li><strong>减少卡顿</strong>：开启后预览压缩为最长边3840px的JPG（质量85）；关闭(极速流畅)：最长边6400px的JPG（质量80）。</li>
            </ul>
            <p><strong>输入</strong>：<code>images</code></p>
        `;
    }

    static category = "xiaozhuguang";
    static title = "小珠光保存";
    static type = XZG_IMAGE_SAVE_TYPE;
}


// ============ 注册扩展 ============
app.registerExtension({
    name: "xiaozhuguang.ImageSave",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name === XZG_IMAGE_SAVE_TYPE) {
            nodeType.prototype.previewWidget = null;
            nodeType.prototype.onPreviewRegistered = function () {};

            const origOnNodeCreated = nodeType.prototype.onNodeCreated;
            const origOnExecuted = nodeType.prototype.onExecuted;
            const origOnDrawForeground = nodeType.prototype.onDrawForeground;
            const origOnSerialize = nodeType.prototype.onSerialize;
            const origGetHelp = nodeType.prototype.getHelp;
            const origGetMenuOptions = nodeType.prototype.getMenuOptions;

            const proto = XiaozhuguangImageSaveNode.prototype;

            nodeType.prototype.onNodeCreated = function () {
                this.canvasWidget = null;
                proto.onNodeCreated.call(this);

                // 仅隐藏 reduce_lag（预览压缩开关），其余原生控件（保存格式/路径/前缀）保持可见可用
                for (const w of this.widgets || []) {
                    if (w.name === "reduce_lag") {
                        w.type = "hidden";
                        w.computeSize = () => [0, -4];
                        w.draw = () => {};
                    }
                }
                for (const inp of this.inputs || []) {
                    if (inp.name === "reduce_lag") {
                        inp.hidden = true;
                    }
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

            nodeType.prototype.getHelp = function () {
                return proto.getHelp.call(this);
            };

            // 右键菜单：保存真实分辨率原图（预览为压缩图，但右键下载的是真实分辨率）
            nodeType.prototype.getMenuOptions = function () {
                const options = origGetMenuOptions ? origGetMenuOptions.call(this) : [];
                const w = this.canvasWidget;
                if (w && w.value && w.value.images && w.value.images.length) {
                    const cur = w.value.images[w.currentIndex] || w.value.images[0];
                    options.push(null);
                    options.push({
                        content: "保存真实分辨率图",
                        callback: () => { downloadImage(cur); }
                    });
                    if (w.value.images.length > 1) {
                        options.push({
                            content: "保存全部真实分辨率图",
                            callback: () => { for (const img of w.value.images) downloadImage(img); }
                        });
                    }
                }
                return options;
            };
        }
    },
});

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const XZG_IMAGE_COMPARE_TYPE = "XiaozhuguangImageCompare";
const IMAGE_MARGIN = 6;

function imageUrl(data) {
    return api.apiURL(
        `/view?filename=${encodeURIComponent(data.filename)}&type=${data.type}&subfolder=${data.subfolder}${app.getPreviewFormatParam()}${app.getRandParam()}`
    );
}


// ============ 自定义 Widget ============
class XzgImageCompareWidget {
    constructor(name, node) {
        this.type = "custom";
        this.name = name;
        this.node = node;
        this.hitAreas = {};
        this.selected = [];        // [image_a_info, image_b_info]
        this._value = { images: [] };
    }

    set value(v) {
        let cleaned;
        if (Array.isArray(v)) {
            cleaned = v.map((d, i) => {
                if (!d || typeof d === "string") {
                    d = { url: d, name: i === 0 ? "A" : "B", selected: true };
                }
                return d;
            });
        } else {
            cleaned = (v && v.images) || [];
        }

        // 确保至少选中 2 张
        let selected = cleaned.filter(d => d.selected);
        if (selected.length === 0 && cleaned.length > 0) {
            cleaned[0].selected = true;
        }
        selected = cleaned.filter(d => d.selected);
        if (selected.length === 1 && cleaned.length > 1) {
            cleaned.find(d => !d.selected).selected = true;
        } else if (selected.length === 0 && cleaned.length >= 2) {
            cleaned[0].selected = true;
            cleaned[1].selected = true;
        }

        this._value.images = cleaned;
        selected = cleaned.filter(d => d.selected);
        this._setSelected(selected);
    }

    get value() {
        return this._value;
    }

    _setSelected(selected) {
        this._value.images.forEach(d => (d.selected = false));

        for (const sel of selected) {
            if (!sel.img) {
                const img = new Image();
                img.src = sel.url;
                sel.img = img;
            }
            sel.selected = true;
        }
        this.selected = selected;
    }

    _swapAB() {
        if (this.selected.length < 2) return;
        // 交换 selected 数组中的两个元素
        [this.selected[0], this.selected[1]] = [this.selected[1], this.selected[0]];
        this.node.setDirtyCanvas(true, true);
    }

    draw(ctx, node, width, y) {
        this.hitAreas = {};

        // 绘制开关行：减少卡顿 + 划线 + 交换AB
        const lagWidget = node.widgets?.find(w => w.name === "reduce_lag");
        const lineWidget = node.widgets?.find(w => w.name === "show_line");
        if (lagWidget && lineWidget) {
            const btnH = 18;
            const btnCount = 3;
            // 延伸到节点最边界，按钮行不使用任何边距（边距仅作用于下方图像）
            const btnW = node.size[0] / btnCount;
            // 与「A -- B」交换按钮一致的颜色（统一 #aaaaaa）
            const SWAP_COLOR = "#aaaaaa";
            ctx.font = "11px Arial";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            // 底色与节点完全一致：不填充背景，直接透出节点背景色

            // 减少卡顿开关：文字统一用 SWAP_COLOR，开启「极致流畅」/关闭「减小卡顿」
            ctx.fillStyle = SWAP_COLOR;
            ctx.fillText(lagWidget.value ? "极致流畅" : "减小卡顿", btnW / 2, y + btnH / 2);
            this.hitAreas["reduce_lag"] = {
                bounds: [0, y, btnW, btnH],
                onDown: () => { lagWidget.value = !lagWidget.value; node.setDirtyCanvas(true); }
            };

            // 划线开关：文字统一用 SWAP_COLOR，激活「划线」/未激活「划像」
            const x1 = btnW;
            ctx.fillStyle = SWAP_COLOR;
            ctx.fillText(lineWidget.value ? "划线" : "划像", x1 + btnW / 2, y + btnH / 2);
            this.hitAreas["show_line"] = {
                bounds: [x1, y, btnW, btnH],
                onDown: () => { lineWidget.value = !lineWidget.value; node.setDirtyCanvas(true); }
            };

            // 交换AB按钮：根据当前状态显示方向（动作按钮，文字 SWAP_COLOR）
            const x2 = x1 + btnW;
            ctx.fillStyle = SWAP_COLOR;
            // 判断当前 selected[0] 是 A 还是 B
            const leftName = this.selected[0]?.name || "";
            if (leftName.startsWith("A")) {
                ctx.fillText("B -- A", x2 + btnW / 2, y + btnH / 2);
            } else {
                ctx.fillText("A -- B", x2 + btnW / 2, y + btnH / 2);
            }
            this.hitAreas["swap_ab"] = {
                bounds: [x2, y, btnW, btnH],
                onDown: () => { this._swapAB(); }
            };

            // 分隔线 1px，颜色与 A--B 一致
            ctx.strokeStyle = SWAP_COLOR;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x1, y); ctx.lineTo(x1, y + btnH);
            ctx.moveTo(x2, y); ctx.lineTo(x2, y + btnH);
            ctx.stroke();

            y += btnH + 4;
        }

        if (!this.selected.length || this.selected.length < 2) return;

        if (this._value.images.length > 2) {
            // 批量选择标签
            ctx.textAlign = "left";
            ctx.textBaseline = "top";
            ctx.font = "14px Arial";
            let x = 10;
            const spacing = 6;
            for (const img of this._value.images) {
                const tw = ctx.measureText(img.name).width + 12;
                const selected = img.selected;
                ctx.fillStyle = selected ? "rgba(180,180,180,1)" : "rgba(180,180,180,0.4)";
                ctx.fillText(img.name, x + 6, y + 3);
                this.hitAreas[img.name] = {
                    bounds: [x, y, tw, 18],
                    data: img,
                    onDown: (e, pos, node, bounds) => {
                        const clicked = bounds.data;
                        // 直接切换选中项
                        if (clicked.name.startsWith("A") && this.selected[0] !== clicked) {
                            this.selected[0].selected = false;
                            this.selected[0] = clicked;
                            clicked.selected = true;
                            // 确保图片已加载
                            if (!clicked.img) {
                                const newImg = new Image();
                                newImg.src = clicked.url;
                                clicked.img = newImg;
                            }
                        } else if (!clicked.name.startsWith("A") && this.selected[1] !== clicked) {
                            this.selected[1].selected = false;
                            this.selected[1] = clicked;
                            clicked.selected = true;
                            if (!clicked.img) {
                                const newImg = new Image();
                                newImg.src = clicked.url;
                                clicked.img = newImg;
                            }
                        }
                        node.setDirtyCanvas(true, true);
                    }
                };
                x += tw + spacing;
            }
            y += 22;
        }

        // Slide 模式对比
        this._drawSlide(ctx, node, width, y);
    }

    _drawSlide(ctx, node, width, y) {
        const imgA = this.selected[0];
        const imgB = this.selected[1];
        if (!imgA || !imgB) return;
        if (!imgA.img || !imgA.img.naturalWidth || !imgB.img || !imgB.img.naturalWidth) return;

        const nodeHeight = node.size[1] - y - IMAGE_MARGIN;
        if (nodeHeight <= 0) return;

        // 实时从节点 widgets 读取划线参数
        const lineWidget = node.widgets?.find(w => w.name === "show_line");
        const showLine = lineWidget ? lineWidget.value : true;

        // 画 image_a
        this._drawImage(ctx, imgA.img, node.size[0], nodeHeight, y);

        // 鼠标在节点上时，按鼠标 X 裁剪画 image_b
        if (node.isPointerOver) {
            this._drawImage(ctx, imgB.img, node.size[0], nodeHeight, y, node.pointerOverPos[0]);

            // 画分割线：实线，#aaaaaa，1px
            if (showLine) {
                ctx.save();
                ctx.strokeStyle = "#aaaaaa";
                ctx.lineWidth = 1;
                ctx.setLineDash([]);
                ctx.beginPath();
                ctx.moveTo(node.pointerOverPos[0], y);
                ctx.lineTo(node.pointerOverPos[0], y + nodeHeight);
                ctx.stroke();
                ctx.restore();
            }
        }
    }


    _drawImage(ctx, img, nodeWidth, nodeHeight, y, cropX) {
        if (!img || !img.naturalWidth || !img.naturalHeight) return;

        const effW = nodeWidth - IMAGE_MARGIN * 2;
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

        const widthMultiplier = imgW / targetW;
        const sourceX = 0;
        const sourceY = 0;
        const cropOffset = cropX != null ? cropX - destX : 0;
        const sourceWidth = cropX != null ? Math.max(0, cropOffset) * widthMultiplier : imgW;
        const sourceHeight = imgH;
        const destWidth = cropX != null ? Math.max(0, cropOffset) : targetW;
        const destHeight = targetH;

        ctx.save();
        ctx.beginPath();
        if (cropX != null) {
            ctx.rect(destX, destY, destWidth, destHeight);
            ctx.clip();
        }
        ctx.drawImage(img, sourceX, sourceY, sourceWidth, sourceHeight, destX, destY, destWidth, destHeight);

        ctx.restore();
    }

    computeSize(width) {
        const node = this.node;
        const ns = node.size;
        const h = (Array.isArray(ns) && isFinite(ns[1])) ? ns[1] : 300 + IMAGE_MARGIN + 22;
        return [width, h];
    }

    serializeValue(node, index) {
        // 不持久化图片，刷新后自动消失
        return { images: [] };
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
            // 消费所有 body 点击，禁止拖拽
            return true;
        }
        return false;
    }
}


// ============ 自定义节点 ============
class XiaozhuguangImageCompareNode {
    constructor() {
        this.imageIndex = 0;
        this.imgs = [];
        this.serialize_widgets = true;
        this.pointerOverPos = [0, 0];
        this.canvasWidget = null;
        this.showLine = true;
    }

    onExecuted(output) {
        const aImages = output.a_images || [];
        const bImages = output.b_images || [];

        // 从节点 widgets 中读取划线参数
        const lineWidget = this.widgets?.find(w => w.name === "show_line");
        if (lineWidget !== undefined && lineWidget !== null) {
            this.showLine = lineWidget.value;
        }

        const imagesToShow = [];
        for (const [i, d] of aImages.entries()) {
            imagesToShow.push({
                name: aImages.length > 1 ? `A${i + 1}` : "A",
                selected: i === 0,
                url: imageUrl(d),
            });
        }
        for (const [i, d] of bImages.entries()) {
            imagesToShow.push({
                name: bImages.length > 1 ? `B${i + 1}` : "B",
                selected: i === 0,
                url: imageUrl(d),
            });
        }

        this.canvasWidget.value = { images: imagesToShow };

        this.setDirtyCanvas(true, true);
    }

    onSerialize(serialised) {
        if (this.canvasWidget) {
            for (let [index, wv] of (serialised.widgets_values || []).entries()) {
                if (this.widgets[index] && this.widgets[index].name === "xzg_image_compare") {
                    serialised.widgets_values[index] = [];
                }
            }
        }
    }

    onNodeCreated() {
        const node = this;
        const w = this.addCustomWidget(new XzgImageCompareWidget("xzg_image_compare", this));
        this.canvasWidget = w;
        // 让图像区域（按钮/标签以外）被视为节点本体，从而可用左键拖动节点。
        // body 全部区域（除右下缩放手柄）返回 widget，禁止拖拽
        if (!node.getWidgetOnPos.__xzgPatched) {
            node.getWidgetOnPos = function (x, y, includeDisabled, ...rest) {
                const lx = x - node.pos[0];
                const ly = y - node.pos[1];
                const titleH = (typeof LiteGraph !== 'undefined' && LiteGraph.NODE_TITLE_HEIGHT) || 30;
                if (lx >= 0 && lx <= node.size[0] - 12 && ly >= titleH && ly <= node.size[1] - 12) {
                    if (node.canvasWidget) return node.canvasWidget;
                }
                return null;
            };
            node.getWidgetOnPos.__xzgPatched = true;
        }
        this.setSize(this.computeSize());
        this.setDirtyCanvas(true, true);
    }

    onDrawForeground(ctx, canvas) {
        // 禁用默认 PreviewImage 的小图绘制
    }

    onMouseEnter(event) {
        this.isPointerOver = true;
    }

    onMouseLeave(event) {
        this.isPointerOver = false;
    }

    onMouseMove(event, pos, canvas) {
        this.pointerOverPos = [...pos];
        this.imageIndex = this.pointerOverPos[0] > this.size[0] / 2 ? 1 : 0;
    }

    getHelp() {
        return `
            <p>小珠光图像对比节点，用于对比两张图像。</p>
            <ul>
                <li><strong>Slide 模式</strong>：鼠标悬停时，B 图像按鼠标位置裁剪显示，A 图像为底层完整图像。</li>
                <li><strong>减少卡顿</strong>：开启后图像将被压缩为最长边3840px的JPG（质量80），适合大图场景。</li>
            </ul>
            <p><strong>输入</strong>：<code>a</code>（可选）、<code>b</code>（可选）</p>
        `;
    }

    static category = "xiaozhuguang";
    static title = "小珠光图像对比";
    static type = XZG_IMAGE_COMPARE_TYPE;
}


// ============ 注册扩展 ============
app.registerExtension({
    name: "xiaozhuguang.ImageCompare",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name === XZG_IMAGE_COMPARE_TYPE) {
            // 禁止默认的 PreviewImage 预览行为（小窗口 + X 按钮）
            nodeType.prototype.previewWidget = null;
            nodeType.prototype.onPreviewRegistered = function() {};

            // 用自定义类替换默认节点行为
            const origOnNodeCreated = nodeType.prototype.onNodeCreated;
            const origOnExecuted = nodeType.prototype.onExecuted;
            const origOnDrawForeground = nodeType.prototype.onDrawForeground;
            const origOnMouseEnter = nodeType.prototype.onMouseEnter;
            const origOnMouseLeave = nodeType.prototype.onMouseLeave;
            const origOnMouseMove = nodeType.prototype.onMouseMove;
            const origOnSerialize = nodeType.prototype.onSerialize;
            const origGetHelp = nodeType.prototype.getHelp;

            const proto = XiaozhuguangImageCompareNode.prototype;

            nodeType.prototype.onNodeCreated = function () {
                // 先初始化自定义属性
                this.imageIndex = 0;
                this.imgs = [];
                this.serialize_widgets = true;
                this.isPointerOver = false;
                this.pointerOverPos = [0, 0];
                this.canvasWidget = null;
                this.showLine = true;

                proto.onNodeCreated.call(this);

                // 彻底隐藏原始的布尔控件（本体 + "转换为输入"连接点），由 XzgImageCompareWidget 统一绘制
                // type="hidden" 会同时隐藏控件及其连接点，且不影响值序列化传给后端
                for (const w of this.widgets || []) {
                    if (w.name === "reduce_lag" || w.name === "show_line") {
                        w.type = "hidden";
                        w.computeSize = () => [0, 0];
                        w.draw = () => {};
                    }
                }
                // 完全移除对应的左侧输入插槽
                if (this.inputs) {
                    this.inputs = this.inputs.filter(inp => inp.name !== "reduce_lag" && inp.name !== "show_line");
                }
            };

            nodeType.prototype.onExecuted = function (output) {
                proto.onExecuted.call(this, output);
            };

            // 不覆盖 onMouseDown → ComfyUI 原生拖拽 + 右键菜单正常工作
            // 开关点击由 widget.mouse() 在 draw 阶段的 hitAreas 处理

            nodeType.prototype.onDrawForeground = function (ctx, canvas) {
                proto.onDrawForeground.call(this, ctx, canvas);
            };

            nodeType.prototype.onMouseEnter = function (event) {
                proto.onMouseEnter.call(this, event);
            };

            nodeType.prototype.onMouseLeave = function (event) {
                proto.onMouseLeave.call(this, event);
            };

            nodeType.prototype.onMouseMove = function (event, pos, canvas) {
                proto.onMouseMove.call(this, event, pos, canvas);
            };

            nodeType.prototype.onSerialize = function (o) {
                proto.onSerialize.call(this, o);
            };

            nodeType.prototype.getHelp = function () {
                return proto.getHelp.call(this);
            };

            // 最小尺寸限制
            nodeType.prototype.onNodeCreated = (function(orig) {
                return function () {
                    orig.call(this);
                    const MIN_H = 300;
                    this.minHeight = Math.max(this.minHeight || 0, MIN_H);
                    const origSetSize2 = this.setSize.bind(this);
                    this.setSize = function (size) {
                        const w = size?.[0] || this.size?.[0] || 400;
                        const h = Math.max(size?.[1] || this.size?.[1] || 400, MIN_H);
                        origSetSize2([w, h]);
                    };
                };
            })(nodeType.prototype.onNodeCreated);
        }
    },
});

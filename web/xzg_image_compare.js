import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const XZG_IMAGE_COMPARE_TYPE = "XiaozhuguangImageCompare";
const IMAGE_MARGIN = 6;

function imageUrl(data) {
    return api.apiURL(
        `/view?filename=${encodeURIComponent(data.filename)}&type=${data.type}&subfolder=${data.subfolder}${app.getPreviewFormatParam()}${app.getRandParam()}`
    );
}

// ============ 鼠标 & 拖拽状态（capture phase，在 ComfyUI 阻止冒泡前捕获） ============
let _isMouseDown = false;
/** 当前正在拖拽的节点（依赖 graph_mouse 实时定位） */
let _dragNode = null;
let _dragStartClient = null;
let _dragNodeStartPos = null;

document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    _isMouseDown = true;
    _dragStartClient = { x: e.clientX, y: e.clientY };

    const cvs = app?.canvas;
    if (!cvs || !cvs.graph_mouse || !cvs.graph) return;
    const [gx, gy] = cvs.graph_mouse;
    // 遍历图节点，检测鼠标是否在本节点区域内
    for (const node of cvs.graph._nodes) {
        if (node.type !== XZG_IMAGE_COMPARE_TYPE) continue;
        if (gx >= node.pos[0] && gx <= node.pos[0] + node.size[0] &&
            gy >= node.pos[1] && gy <= node.pos[1] + node.size[1]) {
            node.isPointerDown = true;
            _dragNode = node;
            _dragNodeStartPos = [...node.pos];
            break;
        }
    }
}, true);

document.addEventListener('pointermove', (e) => {
    if (!_isMouseDown || !_dragNode) return;
    const cvs = app?.canvas;
    if (!cvs?.ds || !_dragNode.graph) return;
    const dx = (e.clientX - _dragStartClient.x) / cvs.ds.scale;
    const dy = (e.clientY - _dragStartClient.y) / cvs.ds.scale;
    _dragNode.pos[0] = _dragNodeStartPos[0] + dx;
    _dragNode.pos[1] = _dragNodeStartPos[1] + dy;
    _dragNode.graph.change();
    cvs.setDirty(true, true);
}, true);

document.addEventListener('pointerup', (e) => {
    if (e.button !== 0) return;
    _isMouseDown = false;
    if (_dragNode) {
        _dragNode.isPointerDown = false;
        _dragNode = null;
    }
    _dragStartClient = null;
    _dragNodeStartPos = null;
}, true);

document.addEventListener('pointercancel', () => {
    _isMouseDown = false;
    if (_dragNode) {
        _dragNode.isPointerDown = false;
        _dragNode = null;
    }
    _dragStartClient = null;
    _dragNodeStartPos = null;
}, true);

// ============ 画布移动追踪（只检测画布缩放/平移） ============
let _canvasTracker = (function () {
    let _lastScale = null;
    let _lastOffset = null;
    let _isMoving = false;
    const listeners = [];

    function check() {
        const ds = app?.canvas?.ds;
        if (!ds) return;
        const scale = ds.scale;
        const offsetX = ds.offset[0];
        const offsetY = ds.offset[1];

        const scaleChanged = _lastScale !== null && scale !== _lastScale;
        const offsetChanged = _lastOffset !== null && (offsetX !== _lastOffset[0] || offsetY !== _lastOffset[1]);
        const anythingChanged = scaleChanged || offsetChanged;

        if (anythingChanged && !_isMoving) {
            _isMoving = true;
            listeners.forEach(fn => fn(true));
        } else if (!anythingChanged && _isMoving) {
            _isMoving = false;
            listeners.forEach(fn => fn(false));
        }

        _lastScale = scale;
        _lastOffset = [offsetX, offsetY];
    }

    setInterval(check, 100);

    return {
        get isMoving() { return _isMoving; },
        onMoveChange(fn) {
            listeners.push(fn);
            return () => {
                const idx = listeners.indexOf(fn);
                if (idx >= 0) listeners.splice(idx, 1);
            };
        }
    };
})();


// ============ 自定义 Widget ============
class XzgImageCompareWidget {
    constructor(name, node) {
        this.type = "custom";
        this.name = name;
        this.node = node;
        this.hitAreas = {};
        this.selected = [];        // [image_a_info, image_b_info]
        this._value = { images: [] };

        // 缩放优化相关
        this._isMoving = false;
        this._unsubMove = null;
        this._isShowingFullRes = false;
        this._transitionStart = null;
        this._transitionDuration = 1000;
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

        // 统一初始化：加载原图、激活追踪（覆盖执行结果和序列化恢复两种场景）
        this._startLoadingFullRes();
        this.activateCanvasTracking();
        // 无论 tracker 是否已激活，都确保触发淡入（防止二次 value 设置卡在缩略图）
        this.showFullRes();
    }

    get value() {
        return this._value;
    }

    _setSelected(selected) {
        this._value.images.forEach(d => (d.selected = false));

        for (const sel of selected) {
            if (!sel._thumbImg) {
                sel._thumbImg = new Image();
                sel._thumbImg.src = sel.url;
            }
            sel.img = sel._thumbImg; // 默认用缩略图
            sel.selected = true;
        }
        this.selected = selected;
        this._isShowingFullRes = false;
    }

    /** 立即开始加载原图，加载完成后存入 _fullResImg（按图片个体标记，避免重复加载） */
    _startLoadingFullRes() {
        const self = this;
        for (const item of this._value.images) {
            if (!item._fullData || item._fullResImg) continue;
            const fullUrl = imageUrl(item._fullData);
            const fullImg = new Image();
            fullImg.onload = () => {
                item._fullResImg = fullImg;
                // 非动画期间且需要显示原图时直接切换
                if (self._isShowingFullRes && self._transitionStart === null) {
                    item.img = fullImg;
                }
                self.node.setDirtyCanvas(true, true);
            };
            fullImg.src = fullUrl;
        }
    }

    /** 返回当前原图叠加透明度 (0~1) */
    _getFullAlpha() {
        if (this._transitionStart === null) {
            return this._isShowingFullRes ? 1 : 0;
        }
        const elapsed = performance.now() - this._transitionStart;
        const t = Math.min(elapsed / this._transitionDuration, 1);
        if (t >= 1) {
            this._transitionStart = null;
        } else {
            this.node.setDirtyCanvas(true, true);
        }
        return this._isShowingFullRes ? t : (1 - t);
    }

    /** 显示高清原图（淡入动画） */
    showFullRes() {
        if (this._isShowingFullRes) return;
        this._isShowingFullRes = true;
        this._transitionStart = performance.now();
        this.node.setDirtyCanvas(true, true);
    }

    /** 显示缩略图（立即，无动画） */
    showThumbnails() {
        if (!this._isShowingFullRes) return;
        for (const item of this._value.images) {
            if (!item.selected) continue;
            if (item._thumbImg) {
                item.img = item._thumbImg;
            }
        }
        this._isShowingFullRes = false;
        this._transitionStart = null;
        this.node.setDirtyCanvas(true, true);
    }

    /** 激活画布追踪（画布移动→缩略图，停止→高清） */
    activateCanvasTracking() {
        if (this._unsubMove) return;
        const self = this;

        this._unsubMove = _canvasTracker.onMoveChange((moving) => {
            self._isMoving = moving;
            if (moving) {
                self._onInteraction();
            } else {
                self.showFullRes();
            }
            self.node.setDirtyCanvas(true, true);
        });

        // 初始状态：立即开始淡入高清
        this.showFullRes();
    }

    /** 交互发生 → 立即切缩略图（淡出动画） */
    _onInteraction() {
        this.showThumbnails();
    }

    destroy() {
        if (this._unsubMove) {
            this._unsubMove();
            this._unsubMove = null;
        }
    }

    draw(ctx, node, width, y) {
        this.hitAreas = {};

        // 鼠标按下 → 立即淡出缩略图
        if ((_isMouseDown || node.isPointerDown) && this._isShowingFullRes) {
            this._onInteraction();
        } else if (!_isMouseDown && !node.isPointerDown && !this._isShowingFullRes && !_canvasTracker.isMoving && this._transitionStart === null) {
            // tracker 未激活 & 鼠标已松开 & 画布静止 & 缩略图稳态 → 开始淡入高清
            this.showFullRes();
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
                        // 直接切换选中项，不重置动画状态（不经过 _setSelected）
                        if (clicked.name.startsWith("A") && this.selected[0] !== clicked) {
                            this.selected[0].selected = false;
                            this.selected[0] = clicked;
                            clicked.selected = true;
                            clicked.img = clicked._thumbImg;
                        } else if (!clicked.name.startsWith("A") && this.selected[1] !== clicked) {
                            this.selected[1].selected = false;
                            this.selected[1] = clicked;
                            clicked.selected = true;
                            clicked.img = clicked._thumbImg;
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

        // 统一原图叠加 alpha（淡入0→1 / 淡出1→0 / 稳态0或1）
        const fullAlpha = this._getFullAlpha();

        // 画 image_a：缩略图打底 + 原图按 alpha 叠加
        this._drawImage(ctx, imgA._thumbImg || imgA.img, node.size[0], nodeHeight, y);
        if (fullAlpha > 0 && imgA._fullResImg) {
            ctx.save();
            ctx.globalAlpha = fullAlpha;
            this._drawImage(ctx, imgA._fullResImg, node.size[0], nodeHeight, y);
            ctx.restore();
        }

        // 鼠标在节点上时，按鼠标 X 裁剪画 image_b
        if (node.isPointerOver) {
            this._drawImage(ctx, imgB._thumbImg || imgB.img, node.size[0], nodeHeight, y, node.pointerOverPos[0]);
            if (fullAlpha > 0 && imgB._fullResImg) {
                ctx.save();
                ctx.globalAlpha = fullAlpha;
                this._drawImage(ctx, imgB._fullResImg, node.size[0], nodeHeight, y, node.pointerOverPos[0]);
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

        // 画分割线
        if (cropX != null && cropX >= destX && cropX <= destX + targetW) {
            ctx.beginPath();
            ctx.moveTo(cropX, destY);
            ctx.lineTo(cropX, destY + destHeight);
            ctx.strokeStyle = "rgba(255,255,255,0)";
            ctx.lineWidth = 0;
            ctx.stroke();
        }
        ctx.restore();
    }

    computeSize(width) {
        const node = this.node;
        const defaultH = 300;
        // 如果已有选中的图像，根据图像宽高比调整高度
        if (this.selected.length >= 2 && this.selected[0].img && this.selected[0].img.naturalWidth) {
            const img = this.selected[0].img;
            const imgAspect = img.naturalWidth / img.naturalHeight;
            const nodeAspect = width / defaultH;
            if (imgAspect > nodeAspect) {
                return [width, width / imgAspect + IMAGE_MARGIN];
            }
        }
        return [width, defaultH + IMAGE_MARGIN];
    }

    serializeValue(node, index) {
        const v = [];
        for (const d of this._value.images) {
            const copy = { ...d };
            delete copy.img;
            delete copy._thumbImg;
            delete copy._fullResImg;
            v.push(copy);
        }
        return { images: v };
    }
}


// ============ 自定义节点 ============
class XiaozhuguangImageCompareNode {
    constructor() {
        this.imageIndex = 0;
        this.imgs = [];
        this.serialize_widgets = true;
        this.isPointerDown = false;
        this.isPointerOver = false;
        this.pointerOverPos = [0, 0];
        this.canvasWidget = null;
    }

    onExecuted(output) {
        // 优先用缩略图初始化
        const aThumbs = output.a_thumbs || [];
        const bThumbs = output.b_thumbs || [];
        const aFull = output.a_images || [];
        const bFull = output.b_images || [];

        const imagesToShow = [];
        for (const [i, d] of aThumbs.entries()) {
            imagesToShow.push({
                name: aThumbs.length > 1 ? `A${i + 1}` : "A",
                selected: i === 0,
                url: imageUrl(d),
                _fullData: aFull[i], // 原始全分辨率数据引用
            });
        }
        for (const [i, d] of bThumbs.entries()) {
            imagesToShow.push({
                name: bThumbs.length > 1 ? `B${i + 1}` : "B",
                selected: i === 0,
                url: imageUrl(d),
                _fullData: bFull[i],
            });
        }

        if (imagesToShow.length === 0 && aFull.length > 0 && bFull.length > 0) {
            // 没有缩略图时回退到全分辨率
            for (const [i, d] of aFull.entries()) {
                imagesToShow.push({
                    name: aFull.length > 1 ? `A${i + 1}` : "A",
                    selected: i === 0,
                    url: imageUrl(d),
                });
            }
            for (const [i, d] of bFull.entries()) {
                imagesToShow.push({
                    name: bFull.length > 1 ? `B${i + 1}` : "B",
                    selected: i === 0,
                    url: imageUrl(d),
                });
            }
        }

        this.canvasWidget.value = { images: imagesToShow };

        this.setDirtyCanvas(true, true);
    }

    onSerialize(serialised) {
        if (this.canvasWidget) {
            for (let [index, wv] of (serialised.widgets_values || []).entries()) {
                if (this.widgets[index] && this.widgets[index].name === "xzg_image_compare") {
                    serialised.widgets_values[index] = this.widgets[index].value.images.map(d => {
                        const copy = { ...d };
                        delete copy.img;
                        delete copy._thumbImg;
                        delete copy._fullResImg;
                        return copy;
                    });
                }
            }
        }
    }

    onNodeCreated() {
        this.canvasWidget = this.addCustomWidget(new XzgImageCompareWidget("xzg_image_compare", this));
        this.setSize(this.computeSize());
        this.setDirtyCanvas(true, true);
    }

    onMouseDown(event, pos, canvas) {
        if (event.button !== 0) return; // 仅处理左键，让右键能触发上下文菜单
        this.isPointerDown = true;
        this.imgs = null;
        // 拖拽初始化由全局 capture-phase 监听器完成
    }

    onDrawForeground(ctx, canvas) {
        // 禁用默认 PreviewImage 的小图绘制
    }

    onMouseUp(event, pos, canvas) {
        this.isPointerDown = false;
        // 拖拽清理由全局 capture-phase 监听器完成
    }

    onMouseEnter(event) {
        this.isPointerOver = true;
    }

    onMouseLeave(event) {
        this.isPointerOver = false;
        this.isPointerDown = false;
    }

    onMouseMove(event, pos, canvas) {
        this.pointerOverPos = [...pos];
        this.imageIndex = this.pointerOverPos[0] > this.size[0] / 2 ? 1 : 0;
    }

    onRemoved() {
        if (this.canvasWidget && this.canvasWidget.destroy) {
            this.canvasWidget.destroy();
        }
    }

    getHelp() {
        return `
            <p>小珠光图像对比节点，用于对比两张图像。</p>
            <ul>
                <li><strong>Slide 模式</strong>：鼠标悬停时，B 图像按鼠标位置裁剪显示，A 图像为底层完整图像。白色分割线跟随鼠标。</li>
                <li><strong>原图优化</strong>：画布滚动/拖动/缩放时立即切为缩略图，画布停止 1s 后自动恢复高清原图。</li>
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
            const origOnMouseDown = nodeType.prototype.onMouseDown;
            const origOnDrawForeground = nodeType.prototype.onDrawForeground;
            const origOnMouseUp = nodeType.prototype.onMouseUp;
            const origOnMouseEnter = nodeType.prototype.onMouseEnter;
            const origOnMouseLeave = nodeType.prototype.onMouseLeave;
            const origOnMouseMove = nodeType.prototype.onMouseMove;
            const origOnRemoved = nodeType.prototype.onRemoved;
            const origOnSerialize = nodeType.prototype.onSerialize;
            const origGetHelp = nodeType.prototype.getHelp;

            const proto = XiaozhuguangImageCompareNode.prototype;

            nodeType.prototype.onNodeCreated = function () {
                // 先初始化自定义属性
                this.imageIndex = 0;
                this.imgs = [];
                this.serialize_widgets = true;
                this.isPointerDown = false;
                this.isPointerOver = false;
                this.pointerOverPos = [0, 0];
                this.canvasWidget = null;
                proto.onNodeCreated.call(this);
            };

            nodeType.prototype.onExecuted = function (output) {
                proto.onExecuted.call(this, output);
            };

            nodeType.prototype.onMouseDown = function (event, pos, canvas) {
                if (event.button !== 0) {
                    // 非左键（右键等）交给原始 handler 处理，确保上下文菜单等正常工作
                    return origOnMouseDown?.call(this, event, pos, canvas);
                }
                return proto.onMouseDown.call(this, event, pos, canvas);
            };

            nodeType.prototype.onDrawForeground = function (ctx, canvas) {
                proto.onDrawForeground.call(this, ctx, canvas);
            };

            nodeType.prototype.onMouseUp = function (event, pos, canvas) {
                proto.onMouseUp.call(this, event, pos, canvas);
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

            nodeType.prototype.onRemoved = function () {
                proto.onRemoved.call(this);
            };

            nodeType.prototype.onSerialize = function (o) {
                proto.onSerialize.call(this, o);
            };

            nodeType.prototype.getHelp = function () {
                return proto.getHelp.call(this);
            };
        }
    },
});
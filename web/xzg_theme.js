
window.XZGThemeManager = {
    currentNodes: [],
    styleElement: null,
    panelStyleElement: null,
    canvasHooked: false,
    protoRefs: {},

    init() {
        this.injectPanelStyles();
        this.setupContextMenu();
        this.ensureCanvasHook();
        this.hookSerialize();
    },

    injectPanelStyles() {
        if (document.getElementById("xzg-theme-panel-style")) return;
        
        const css = `
.xzg-theme-panel {
    position: fixed;
    z-index: 99999;
    width: 280px;
    background: #2a2a2a;
    border: 1px solid #444;
    border-radius: 8px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
    font-family: "Microsoft YaHei", "微软雅黑", "PingFang SC", "Hiragino Sans GB", "SimHei", Arial, sans-serif;
    color: #ddd;
    display: none;
    overflow: hidden;
}

.xzg-theme-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 7px 12px;
    background: #2a2a2a;
    border-bottom: 1px solid #444;
    color: #ddd;
    font-size: 14px;
    font-weight: bold;
}

.xzg-theme-title {
    font-size: 13px;
}

.xzg-theme-header-btns {
    display: flex;
    align-items: center;
    gap: 5px;
}

.xzg-theme-shortcut-btn {
    background: rgba(255, 255, 255, 0.2);
    border: 1px solid rgba(255, 255, 255, 0.3);
    color: #fff;
    font-size: 10px;
    font-weight: bold;
    padding: 4px 8px;
    border-radius: 4px;
    cursor: pointer;
    min-width: 70px;
    text-align: center;
    transition: all 0.2s;
}

.xzg-theme-shortcut-btn:hover {
    background: rgba(255, 255, 255, 0.3);
    transform: scale(1.05);
}

.xzg-theme-close {
    background: none;
    border: none;
    color: #999;
    font-size: 18px;
    cursor: pointer;
    padding: 0 4px;
    line-height: 1;
    opacity: 0.8;
    transition: opacity 0.2s;
}

.xzg-theme-close:hover {
    opacity: 1;
}

.xzg-theme-content {
    padding: 9px;
    max-height: 500px;
    overflow-y: auto;
}

.xzg-theme-section {
    margin-bottom: 9px;
}

.xzg-theme-section:last-child {
    margin-bottom: 0;
}

.xzg-theme-section-title {
    font-size: 12px;
    color: #888;
    margin-bottom: 5px;
    font-weight: bold;
    text-transform: uppercase;
    letter-spacing: 0.5px;
}

.xzg-theme-preview {
    width: 100%;
    height: 40px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 9px;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 50%, #f093fb 100%);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.xzg-preview-text {
    font-size: 12px;
    font-weight: bold;
    color: #fff;
}

.xzg-theme-color-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 7px;
    margin-bottom: 5px;
}

.xzg-theme-label {
    font-size: 12px;
    color: #aaa;
    min-width: 60px;
}

.xzg-theme-color-row input[type="color"] {
    width: 50px;
    height: 28px;
    border: 1px solid #555;
    border-radius: 4px;
    cursor: pointer;
    background: #333;
    padding: 0;
}

.xzg-theme-direction-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 7px;
    margin-bottom: 7px;
    margin-top: 7px;
}

.xzg-direction-buttons {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 1px;
}

.xzg-dir-btn {
    width: 24px;
    height: 22px;
    border: 1px solid #555;
    border-radius: 4px;
    background: #333;
    color: #aaa;
    cursor: pointer;
    font-size: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
}

.xzg-dir-btn:hover {
    background: #444;
    color: #fff;
}

.xzg-dir-btn.active {
    background: #333;
    border-color: #fff;
    color: #fff;
}

.xzg-theme-separator {
    height: 1px;
    background: #444;
    margin: 9px 0;
}

.xzg-theme-font-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 7px;
    margin-top: 7px;
    margin-bottom: 7px;
}

.xzg-font-size-control {
    display: flex;
    align-items: center;
    gap: 3px;
}

.xzg-font-btn {
    width: 28px;
    height: 22px;
    border: 1px solid #555;
    border-radius: 4px;
    background: #333;
    color: #aaa;
    cursor: pointer;
    font-size: 11px;
    font-weight: bold;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
}

.xzg-font-btn:hover {
    background: #444;
    color: #fff;
}

.xzg-font-btn:active {
    transform: scale(0.95);
}

.xzg-font-size-value {
    min-width: 30px;
    text-align: center;
    font-size: 12px;
    color: #ccc;
}

.xzg-align-buttons {
    display: flex;
    gap: 4px;
}

.xzg-align-btn {
    width: 32px;
    height: 22px;
    border: 1px solid #555;
    border-radius: 4px;
    background: #333;
    color: #aaa;
    cursor: pointer;
    font-size: 11px;
    font-size: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
}

.xzg-align-btn:hover {
    background: #444;
    color: #fff;
}

.xzg-align-btn.active {
    background: #333;
    border-color: #fff;
    color: #fff;
}

.xzg-apply-btn {
    width: 100%;
    padding: 7px 16px;
    background: #333;
    color: #FFD700;
    border: 1px solid #555;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
    font-weight: bold;
    text-shadow: 0 0 8px rgba(255, 215, 0, 0.6);
    transition: all 0.2s;
    margin-top: 7px;
}

.xzg-apply-btn:hover {
    background: #444;
}

.xzg-apply-btn:active {
    transform: translateY(0);
}

.xzg-reset-btn {
    width: 100%;
    padding: 5px 16px;
    background: #444;
    color: #ccc;
    border: 1px solid #555;
    border-radius: 6px;
    cursor: pointer;
    font-size: 12px;
    transition: all 0.2s;
    margin-top: 3px;
}

.xzg-reset-btn:hover {
    background: #555;
    color: #fff;
}

.xzg-theme-content::-webkit-scrollbar {
    width: 6px;
}

.xzg-theme-content::-webkit-scrollbar-track {
    background: #222;
}

.xzg-theme-content::-webkit-scrollbar-thumb {
    background: #555;
    border-radius: 3px;
}

.xzg-theme-content::-webkit-scrollbar-thumb:hover {
    background: #666;
}

.xzg-color-swatches {
    display: flex;
    flex-direction: column;
    gap: 5px;
    margin-bottom: 9px;
}

.xzg-swatch-group {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 7px;
}

.xzg-swatch-label {
    font-size: 12px;
    color: #aaa;
    min-width: 40px;
}

.xzg-swatch-row {
    display: flex;
    gap: 3px;
}

.xzg-color-swatch {
    width: 50px;
    height: 22px;
    border: 2px solid #555;
    border-radius: 4px;
    cursor: pointer;
    padding: 0;
    transition: all 0.2s;
}

.xzg-color-swatch:hover {
    border-color: #888;
    transform: scale(1.1);
}

.xzg-color-swatch.active {
    border-color: #fff;
    box-shadow: 0 0 0 2px #667eea;
}

.xzg-color-swatch:active {
    transform: scale(0.95);
}

.xzg-text-swatch {
    border-style: solid;
}

.xzg-picker-section {
    padding: 9px;
    background: #222;
    border-bottom: 1px solid #444;
}

.xzg-sv-area {
    position: relative;
    width: 100%;
    aspect-ratio: 16 / 10;
    border-radius: 6px;
    margin-bottom: 7px;
    cursor: crosshair;
    background-color: hsl(240, 100%, 50%);
    border: 1px solid #555;
    overflow: hidden;
}

.xzg-sv-white {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: linear-gradient(to right, #fff, transparent);
}

.xzg-sv-black {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: linear-gradient(to top, #000, transparent);
}

.xzg-sv-cursor {
    position: absolute;
    width: 18px;
    height: 18px;
    transform: translate(-50%, -50%);
    pointer-events: none;
    z-index: 2;
}

.xzg-hue-row {
    margin-bottom: 0;
}

.xzg-hue-bar {
    position: relative;
    width: 100%;
    height: 16px;
    border-radius: 8px;
    background: linear-gradient(to right, 
        #ff0000 0%, #ffff00 17%, #00ff00 33%, 
        #00ffff 50%, #0000ff 67%, #ff00ff 83%, #ff0000 100%);
    cursor: pointer;
    border: 1px solid #555;
}

.xzg-hue-cursor {
    position: absolute;
    top: 50%;
    width: 16px;
    height: 16px;
    border: 2px solid #fff;
    border-radius: 50%;
    transform: translate(-50%, -50%);
    box-shadow: 0 0 0 1px rgba(0,0,0,0.5), 0 1px 3px rgba(0,0,0,0.3);
    pointer-events: none;
}

.xzg-title-toggle-row {
    margin-bottom: 0;
}

.xzg-title-gradient-section.xzg-swatch-group {
    justify-content: flex-end;
}

.xzg-theme-direction-row.xzg-title-gradient-section {
    justify-content: flex-end;
}

.xzg-theme-direction-row.xzg-title-gradient-section .xzg-theme-label {
    margin-right: 10px;
}

.xzg-toggle-switch {
    position: relative;
    width: 52px;
    height: 26px;
    border: none;
    border-radius: 13px;
    background: #555;
    cursor: pointer;
    padding: 0;
    transition: background 0.2s;
    flex-shrink: 0;
}

.xzg-toggle-switch[data-checked="true"] {
    background: #353535;
}

.xzg-toggle-switch .xzg-toggle-slider {
    position: absolute;
    top: 3px;
    left: 3px;
    width: 20px;
    height: 20px;
    background: #fff;
    border-radius: 50%;
    transition: left 0.2s;
    pointer-events: none;
}

.xzg-toggle-switch[data-checked="true"] .xzg-toggle-slider {
    left: 29px;
}

.xzg-toggle-switch .xzg-toggle-label {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    font-size: 11px;
    color: #fff;
    pointer-events: none;
    font-weight: bold;
    user-select: none;
}

.xzg-toggle-switch[data-checked="false"] .xzg-toggle-label {
    right: 8px;
}

.xzg-toggle-switch[data-checked="true"] .xzg-toggle-label {
    left: 8px;
}

.xzg-dialog-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
}

.xzg-dialog {
    background: #2a2a2a;
    border: 1px solid #444;
    border-radius: 8px;
    min-width: 280px;
    max-width: 90vw;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
    font-family: "Microsoft YaHei", "微软雅黑", "PingFang SC", "Hiragino Sans GB", "SimHei", Arial, sans-serif;
    color: #ddd;
}

.xzg-dialog-title {
    padding: 12px 16px;
    font-size: 14px;
    font-weight: bold;
    border-bottom: 1px solid #444;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: #fff;
    border-radius: 8px 8px 0 0;
}

.xzg-dialog-body {
    padding: 16px;
    font-size: 13px;
}

.xzg-dialog-footer {
    padding: 12px 16px;
    border-top: 1px solid #444;
    display: flex;
    justify-content: flex-end;
    gap: 8px;
}

.xzg-btn {
    padding: 6px 16px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    transition: all 0.2s;
}

.xzg-btn-cancel {
    background: #444;
    color: #ddd;
}

.xzg-btn-cancel:hover {
    background: #555;
}

.xzg-presets-section {
    margin-top: 4px;
}

.xzg-presets-row {
    display: flex;
    gap: 5px;
    margin-top: 5px;
}

.xzg-preset-item {
    flex: 1;
    height: 36px;
    border-radius: 4px;
    cursor: pointer;
    border: 2px solid #444;
    transition: all 0.2s;
    position: relative;
    overflow: hidden;
}

.xzg-preset-item:hover {
    border-color: #667eea;
    transform: translateY(-2px);
    box-shadow: 0 2px 8px rgba(102, 126, 234, 0.3);
}

.xzg-preset-item:active {
    transform: translateY(0);
}

.xzg-presets-tip {
    text-align: center;
    color: #fff;
    font-size: 10px;
    margin-top: 3px;
    margin-bottom: 0;
}
        `;
        
        this.panelStyleElement = document.createElement("style");
        this.panelStyleElement.id = "xzg-theme-panel-style";
        this.panelStyleElement.textContent = css;
        document.head.appendChild(this.panelStyleElement);
    },

    _serializeHooksInstalled: false,

    hookSerialize(retryCount = 0) {
        // 如果已安装则跳过
        if (this._serializeHooksInstalled) return;

        const self = this;
        
        function hookProto(proto, name, makeWrapper) {
            const orig = proto[name];
            if (orig && orig._xzgWrapped) return;
            const wrapped = makeWrapper(orig);
            wrapped._xzgWrapped = true;
            self.protoRefs[name] = orig;
            proto[name] = wrapped;
        }

        if (window.LiteGraph && LiteGraph.LGraphNode && LiteGraph.LGraphNode.prototype) {
            hookProto(LiteGraph.LGraphNode.prototype, 'serialize', (orig) => function() {
                const data = orig ? orig.call(this) : {};
                if (this._xzgGradient) {
                    data._xzgGradient = JSON.parse(JSON.stringify(this._xzgGradient));
                }
                return data;
            });

            hookProto(LiteGraph.LGraphNode.prototype, 'configure', (orig) => function(data) {
                if (orig) orig.call(this, data);
                if (data && data._xzgGradient) {
                    this._xzgGradient = JSON.parse(JSON.stringify(data._xzgGradient));
                }
            });

            hookProto(LiteGraph.LGraphNode.prototype, 'onAdded', (orig) => function(graph) {
                if (orig) orig.call(this, graph);
                if (this._xzgGradient) {
                    setTimeout(() => {
                        XZGThemeManager.applyGradientToDOMNode(this);
                    }, 50);
                }
            });

            this._serializeHooksInstalled = true;
            console.log('[小珠光主题] 序列化 Hook 已安装 ✓');
        } else if (retryCount < 60) {
            // LiteGraph 尚未就绪，延迟重试（最多60次=6秒）
            setTimeout(() => self.hookSerialize(retryCount + 1), 100);
        } else {
            console.warn('[小珠光主题] 序列化 Hook 安装失败：LiteGraph 超时未就绪');
        }
    },

    ensureCanvasHook() {
        if (this.canvasHooked) return;
        if (!window.app || !app.canvas) {
            setTimeout(() => this.ensureCanvasHook(), 100);
            return;
        }
        this.hookDrawNodeShape();
        this.canvasHooked = true;
    },

    hookDrawNodeShape() {
        const canvas = app.canvas;
        if (!canvas) return;

        const self = this;

        function hookMethod(methodName, makeWrapper) {
            const targets = [];
            if (typeof canvas[methodName] === 'function' &&
                Object.prototype.hasOwnProperty.call(canvas, methodName)) {
                targets.push({ obj: canvas, orig: canvas[methodName] });
            }
            let proto = Object.getPrototypeOf(canvas);
            while (proto && proto !== Object.prototype) {
                if (Object.prototype.hasOwnProperty.call(proto, methodName) &&
                    typeof proto[methodName] === 'function') {
                    targets.push({ obj: proto, orig: proto[methodName] });
                }
                proto = Object.getPrototypeOf(proto);
            }
            if (targets.length === 0) {
                const fn = canvas[methodName];
                if (typeof fn === 'function') targets.push({ obj: canvas, orig: fn });
                else return false;
            }
            for (const t of targets) {
                if (t.orig._xzgWrapped) continue;
                const w = makeWrapper(t.orig);
                w._xzgWrapped = true;
                t.obj[methodName] = w;
            }
            return true;
        }

        function makeDrawShapeWrapper(origFn) {
            return function(node, ctx, size, fgcolor, bgcolor, selected, mouseOver) {
                if (!node._xzgGradient) {
                    origFn.call(this, node, ctx, size, fgcolor, bgcolor, selected, mouseOver);
                    return;
                }

                const LG = typeof LiteGraph !== 'undefined' ? LiteGraph : null;
                const th = LG?.NODE_TITLE_HEIGHT || 30;
                const w = size[0], h = size[1];
                const r = node.borderRadius || LG?.NODE_CORNER_RADIUS || 8;
                const cfg = node._xzgGradient;
                const pts = self._gradPts(w, h, th);
                const titlePts = self._titleGradPts(w, th);
                const bodyPts = self._bodyGradPts(w, h);
                const dirSym = self.degToSymbol(cfg.direction);
                const titleDirSym = self.degToSymbol(cfg.titleDirection || cfg.direction);

                ctx.save();
                try {
                    const useTitleGradient = cfg.useTitleGradient && cfg.titleStops && cfg.titleStops.length > 0;
                    
                    if (useTitleGradient) {
                        const [tx1, ty1, tx2, ty2] = titlePts[titleDirSym] || titlePts['↓'];
                        const titleGrad = ctx.createLinearGradient(tx1, ty1, tx2, ty2);
                        cfg.titleStops.forEach(s => titleGrad.addColorStop(s.p, s.color));
                        
                        const [bx1, by1, bx2, by2] = bodyPts[dirSym] || bodyPts['↓'];
                        const bodyGrad = ctx.createLinearGradient(bx1, by1, bx2, by2);
                        cfg.stops.forEach(s => bodyGrad.addColorStop(s.p, s.color));
                        
                        ctx.beginPath();
                        if (ctx.roundRect) ctx.roundRect(0, -th, w, th, [r, r, 0, 0]);
                        else ctx.rect(0, -th, w, th);
                        ctx.fillStyle = titleGrad;
                        ctx.fill();
                        
                        ctx.beginPath();
                        if (ctx.roundRect) ctx.roundRect(0, 0, w, h, [0, 0, r, r]);
                        else ctx.rect(0, 0, w, h);
                        ctx.fillStyle = bodyGrad;
                        ctx.fill();
                    } else {
                        const [x1, y1, x2, y2] = pts[dirSym] || pts['↓'];
                        const grad = ctx.createLinearGradient(x1, y1, x2, y2);
                        cfg.stops.forEach(s => grad.addColorStop(s.p, s.color));
                        
                        ctx.beginPath();
                        if (ctx.roundRect) ctx.roundRect(0, -th, w, h + th, r);
                        else ctx.rect(0, -th, w, h + th);
                        ctx.fillStyle = grad;
                        ctx.fill();
                    }

                    const title = node.getTitle ? node.getTitle() : (node.title || '');
                    if (title) {
                        const fontSize = cfg.fontSize || LG?.NODE_TEXT_SIZE || 14;
                        const color = cfg.titleText || '#ffffff';
                        const align = cfg.textAlign || 'left';
                        ctx.save();
                        ctx.font = `bold ${fontSize}px "Microsoft YaHei", "微软雅黑", "PingFang SC", "Hiragino Sans GB", "SimHei", Arial, sans-serif`;
                        ctx.fillStyle = color;
                        ctx.textBaseline = 'middle';
                        
                        let textX = 10;
                        if (align === 'center') {
                            ctx.textAlign = 'center';
                            textX = w / 2;
                        } else if (align === 'right') {
                            ctx.textAlign = 'right';
                            textX = w - 10;
                        } else {
                            ctx.textAlign = 'left';
                            textX = 10;
                        }
                        
                        ctx.fillText(title, textX, -th / 2);
                        ctx.restore();
                    }

                    ctx.globalAlpha = 0;
                    origFn.call(this, node, ctx, size, fgcolor, bgcolor, selected, mouseOver);
                } catch(e) {
                    origFn.call(this, node, ctx, size, fgcolor, bgcolor, selected, mouseOver);
                } finally {
                    ctx.restore();
                }
            };
        }

        const ok = hookMethod('drawNodeShape', makeDrawShapeWrapper);
        if (!ok) {
            hookMethod('drawNode', makeDrawShapeWrapper);
        }
    },

    _gradPts(w, h, th) {
        return {
            '↖': [w, h, 0, -th], '↑': [0, h, 0, -th], '↗': [0, h, w, -th],
            '←': [w, 0, 0,  0],  '→': [0, 0, w,  0],
            '↙': [w, -th, 0, h], '↓': [0, -th, 0, h], '↘': [0, -th, w, h],
        };
    },

    _titleGradPts(w, th) {
        return {
            '↖': [w, 0, 0, -th], '↑': [0, 0, 0, -th], '↗': [0, 0, w, -th],
            '←': [w, -th/2, 0, -th/2],  '→': [0, -th/2, w, -th/2],
            '↙': [w, -th, 0, 0], '↓': [0, -th, 0, 0], '↘': [0, -th, w, 0],
        };
    },

    _bodyGradPts(w, h) {
        return {
            '↖': [w, h, 0, 0], '↑': [0, h, 0, 0], '↗': [0, h, w, 0],
            '←': [w, h/2, 0, h/2],  '→': [0, h/2, w, h/2],
            '↙': [w, 0, 0, h], '↓': [0, 0, 0, h], '↘': [0, 0, w, h],
        };
    },

    degToSymbol(deg) {
        const map = {
            '0': '↓', '90': '→', '180': '↑', '270': '←',
            '45': '↘', '135': '↙', '225': '↖', '315': '↗'
        };
        return map[String(deg)] || '↓';
    },

    buildGradientConfig(colors) {
        const stops = [];
        if (colors.useGradient) {
            stops.push({ p: 0, color: colors.color1 });
            stops.push({ p: 0.5, color: colors.color2 });
            stops.push({ p: 1, color: colors.color3 });
        } else {
            stops.push({ p: 0, color: colors.color1 });
            stops.push({ p: 1, color: colors.color1 });
        }
        
        const titleStops = [];
        const useTitleGradient = colors.useTitleGradient !== false && colors.titleColor1;
        if (useTitleGradient) {
            titleStops.push({ p: 0, color: colors.titleColor1 });
            titleStops.push({ p: 0.5, color: colors.titleColor2 || colors.titleColor1 });
            titleStops.push({ p: 1, color: colors.titleColor3 || colors.titleColor1 });
        }
        
        return {
            direction: colors.direction || '90',
            stops: stops,
            titleDirection: colors.titleDirection || '90',
            titleStops: titleStops,
            useTitleGradient: useTitleGradient,
            titleText: colors.titleText || '#ffffff',
            useGradient: colors.useGradient !== false,
            fontSize: colors.fontSize || 14,
            textAlign: colors.textAlign || 'left'
        };
    },

    buildGradientCSS(colors) {
        if (!colors.useGradient) {
            return colors.color1;
        }
        const cssDeg = this.dirToCssDeg(colors.direction);
        return `linear-gradient(${cssDeg}deg, ${colors.color1} 0%, ${colors.color2} 50%, ${colors.color3} 100%)`;
    },

    buildTitleGradientCSS(colors) {
        if (!colors.useTitleGradient || !colors.titleColor1) {
            return null;
        }
        const cssDeg = this.dirToCssDeg(colors.titleDirection || '90');
        return `linear-gradient(${cssDeg}deg, ${colors.titleColor1} 0%, ${colors.titleColor2 || colors.titleColor1} 50%, ${colors.titleColor3 || colors.titleColor1} 100%)`;
    },

    dirToCssDeg(deg) {
        const sym = this.degToSymbol(deg);
        const map = {
            '↑': 0, '→': 90, '↓': 180, '←': 270,
            '↗': 45, '↘': 135, '↖': 225, '↙': 315
        };
        return map[sym] !== undefined ? map[sym] : 180;
    },

    applyThemeToNodes(nodes, colors) {
        if (!nodes || !nodes.length) return;
        
        const cfg = this.buildGradientConfig(colors);
        const gradCSS = this.buildGradientCSS(colors);

        nodes.forEach(node => {
            if (node.type === "XiaozhuguangTitle") return;
            node._xzgGradient = { ...cfg };
            node.color = colors.color1;
            node.bgcolor = colors.color1;
            this.applyGradientToDOMNode(node);
        });

        if (app.graph) {
            app.graph.setDirtyCanvas?.(true, true);
            // 标记工作流已修改，确保更改可被保存
            app.graph.change?.();
        }
    },

    applyGradientToDOMNode(node) {
        if (!node || !node._xzgGradient) return;
        
        const graphCanvas = document.getElementById("graph-canvas");
        if (!graphCanvas) return;

        const cfg = node._xzgGradient;
        const useTitleGradient = cfg.useTitleGradient && cfg.titleStops && cfg.titleStops.length > 0;
        
        const gradCSS = this.buildGradientCSS({
            color1: cfg.stops[0]?.color || '#e49c00',
            color2: cfg.stops[1]?.color || '#000000',
            color3: cfg.stops[2]?.color || '#005149',
            direction: cfg.direction || '90',
            useGradient: cfg.useGradient !== false
        });
        
        const titleGradCSS = useTitleGradient ? this.buildTitleGradientCSS({
            titleColor1: cfg.titleStops[0]?.color,
            titleColor2: cfg.titleStops[1]?.color,
            titleColor3: cfg.titleStops[2]?.color,
            titleDirection: cfg.titleDirection || '90',
            useTitleGradient: true
        }) : null;

        const nodeEls = graphCanvas.querySelectorAll(
            `[data-node-id="${node.id}"], [data-id="${node.id}"], #node-${node.id}`
        );
        
        nodeEls.forEach(nodeEl => {
            const inner = nodeEl.querySelector('[data-testid="node-inner-wrapper"]') || nodeEl;
            
            if (useTitleGradient) {
                inner.style.setProperty('background', gradCSS, 'important');
                inner.style.setProperty('--component-node-background', 'transparent', 'important');
                inner.style.setProperty('--component-node-header', 'transparent', 'important');
            } else {
                inner.style.setProperty('background', gradCSS, 'important');
                inner.style.setProperty('--component-node-background', 'transparent', 'important');
                inner.style.setProperty('--component-node-header', 'transparent', 'important');
            }

            const headerSelectors = [
                '[data-testid*="header"]', '.comfy-header', '.comfy-title', 
                '.node-header', '.node-title', '.litegraph .title',
                '.node-titlebar', '.title-bar', '.litemenu-title'
            ];
            const header = nodeEl.querySelector(headerSelectors.join(', '));
            if (header) {
                if (useTitleGradient && titleGradCSS) {
                    header.style.setProperty('background', titleGradCSS, 'important');
                    header.style.setProperty('background-color', titleGradCSS, 'important');
                } else {
                    header.style.setProperty('background', 'transparent', 'important');
                    header.style.setProperty('background-color', 'transparent', 'important');
                }
                header.style.setProperty('color', cfg.titleText || '#ffffff', 'important');
                if (cfg.fontSize) {
                    header.style.setProperty('font-size', cfg.fontSize + 'px', 'important');
                    const textEls = header.querySelectorAll('*');
                    textEls.forEach(el => {
                        el.style.setProperty('font-size', cfg.fontSize + 'px', 'important');
                    });
                }
                if (cfg.textAlign) {
                    header.style.setProperty('text-align', cfg.textAlign, 'important');
                    if (header.style.display === 'flex' || getComputedStyle(header).display === 'flex') {
                        header.style.setProperty('justify-content', cfg.textAlign === 'left' ? 'flex-start' : (cfg.textAlign === 'right' ? 'flex-end' : 'center'), 'important');
                    }
                    const textEls = header.querySelectorAll('span, div, p, h1, h2, h3, h4');
                    textEls.forEach(el => {
                        el.style.setProperty('text-align', cfg.textAlign, 'important');
                        if (getComputedStyle(el).display === 'flex') {
                            el.style.setProperty('justify-content', cfg.textAlign === 'left' ? 'flex-start' : (cfg.textAlign === 'right' ? 'flex-end' : 'center'), 'important');
                        }
                    });
                }
            }

            const body = nodeEl.querySelector('[data-testid*="body"], .comfy-body, .comfy-content, .node-body, .content');
            if (body) {
                body.style.setProperty('background', 'transparent', 'important');
                body.style.setProperty('background-color', 'transparent', 'important');
            }
        });
    },

    removeThemeFromNodes(nodes) {
        if (!nodes || !nodes.length) return;

        nodes.forEach(node => {
            delete node._xzgGradient;
            node.color = null;
            node.bgcolor = null;
            this.removeGradientFromDOMNode(node);
        });

        if (app.graph) {
            app.graph.setDirtyCanvas?.(true, true);
            app.graph.change?.();
        }
    },

    removeGradientFromDOMNode(node) {
        const graphCanvas = document.getElementById("graph-canvas");
        if (!graphCanvas) return;

        const nodeEls = graphCanvas.querySelectorAll(
            `[data-node-id="${node.id}"], [data-id="${node.id}"], #node-${node.id}`
        );
        
        nodeEls.forEach(nodeEl => {
            const inner = nodeEl.querySelector('[data-testid="node-inner-wrapper"]') || nodeEl;
            inner.style.removeProperty('background');
            inner.style.removeProperty('background-color');
            inner.style.removeProperty('--component-node-background');
            inner.style.removeProperty('--component-node-header');

            const allChilds = nodeEl.querySelectorAll('*');
            allChilds.forEach(child => {
                child.style.removeProperty('background');
                child.style.removeProperty('background-color');
            });

            const headerSelectors = [
                '[data-testid*="header"]', '.comfy-header', '.comfy-title', 
                '.node-header', '.node-title', '.litegraph .title',
                '.node-titlebar', '.title-bar', '.litemenu-title'
            ];
            const header = nodeEl.querySelector(headerSelectors.join(', '));
            if (header) {
                header.style.removeProperty('color');
                header.style.removeProperty('font-size');
                header.style.removeProperty('text-align');
                header.style.removeProperty('justify-content');
                const allChilds = header.querySelectorAll('*');
                allChilds.forEach(child => {
                    child.style.removeProperty('font-size');
                    child.style.removeProperty('text-align');
                    child.style.removeProperty('justify-content');
                    child.style.removeProperty('flex');
                });
            }
        });
    },

    getSelectedNodes() {
        if (!window.app || !app.canvas) return [];
        const canvas = app.canvas;
        if (canvas.selected_nodes) {
            const nodes = Object.values(canvas.selected_nodes);
            if (nodes.length > 0) return nodes;
        }
        return [];
    },

    getTopLeftNode(nodes) {
        if (!nodes || nodes.length === 0) return null;
        if (nodes.length === 1) return nodes[0];
        
        let topLeft = nodes[0];
        for (let i = 1; i < nodes.length; i++) {
            const node = nodes[i];
            const nodeY = node.pos ? node.pos[1] : 0;
            const topLeftY = topLeft.pos ? topLeft.pos[1] : 0;
            const nodeX = node.pos ? node.pos[0] : 0;
            const topLeftX = topLeft.pos ? topLeft.pos[0] : 0;
            
            if (nodeY < topLeftY) {
                topLeft = node;
            } else if (nodeY === topLeftY && nodeX < topLeftX) {
                topLeft = node;
            }
        }
        return topLeft;
    },

    getNodeGradient(node) {
        if (!node || !node._xzgGradient) return null;
        const cfg = node._xzgGradient;
        const useTitleGradient = cfg.useTitleGradient && cfg.titleStops && cfg.titleStops.length > 0;
        return {
            color1: cfg.stops[0]?.color || '#e65c5c',
            color2: cfg.stops[1]?.color || '#4fc94f',
            color3: cfg.stops[2]?.color || '#4d94e6',
            direction: cfg.direction || '90',
            titleColor1: useTitleGradient ? (cfg.titleStops[0]?.color || '#e49c00') : undefined,
            titleColor2: useTitleGradient ? (cfg.titleStops[1]?.color || '#000000') : undefined,
            titleColor3: useTitleGradient ? (cfg.titleStops[2]?.color || '#005149') : undefined,
            titleDirection: cfg.titleDirection || '90',
            useTitleGradient: useTitleGradient,
            titleText: cfg.titleText || '#ffffff',
            useGradient: cfg.useGradient !== false,
            fontSize: cfg.fontSize || 14,
            textAlign: cfg.textAlign || 'left'
        };
    },

    setupContextMenu() {
        const self = this;

        const checkShortcut = (e) => {
            if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) {
                return false;
            }
            const panel = window.XZGThemePanel;
            if (!panel) return false;
            const shortcut = panel.getShortcut();
            if (!shortcut || !shortcut.key) return false;
            const key = e.key.toLowerCase();
            if (key !== shortcut.key.toLowerCase()) return false;
            if (!!e.ctrlKey !== !!shortcut.ctrl) return false;
            if (!!e.altKey !== !!shortcut.alt) return false;
            if (!!e.shiftKey !== !!shortcut.shift) return false;
            if (!!e.metaKey !== !!shortcut.meta) return false;
            return true;
        };

        this._shortcutHandler = (e) => {
            if (checkShortcut(e)) {
                e.preventDefault();
                const panel = window.XZGThemePanel;
                if (panel && panel.isVisible) {
                    panel.hide();
                } else {
                    const nodes = self.getSelectedNodes();
                    if (nodes.length > 0) {
                        self.currentNodes = nodes;
                        self.showPanelForNodes(nodes);
                    } else {
                        self.showPanel();
                    }
                }
            }
        };
        document.addEventListener("keydown", this._shortcutHandler);

        if (window.XZGThemePanel) {
            window.XZGThemePanel.onThemeChange = (theme) => {
                const nodes = self.getSelectedNodes();
                if (nodes && nodes.length > 0) {
                    self.currentNodes = nodes;
                    const colors = {
                        color1: theme.colors.color1,
                        color2: theme.colors.color2,
                        color3: theme.colors.color3,
                        direction: theme.colors.direction,
                        titleColor1: theme.colors.titleColor1,
                        titleColor2: theme.colors.titleColor2,
                        titleColor3: theme.colors.titleColor3,
                        titleDirection: theme.colors.titleDirection,
                        useTitleGradient: theme.colors.useTitleGradient,
                        titleText: theme.colors.titleText,
                        useGradient: theme.colors.useGradient,
                        fontSize: theme.colors.fontSize,
                        textAlign: theme.colors.textAlign
                    };
                    self.applyThemeToNodes(nodes, colors);
                }
            };
            window.XZGThemePanel.onApply = (colors) => {
                const nodes = self.getSelectedNodes();
                if (nodes && nodes.length > 0) {
                    self.currentNodes = nodes;
                    const themeColors = {
                        color1: colors.color1,
                        color2: colors.color2,
                        color3: colors.color3,
                        direction: colors.direction,
                        titleColor1: colors.titleColor1,
                        titleColor2: colors.titleColor2,
                        titleColor3: colors.titleColor3,
                        titleDirection: colors.titleDirection,
                        useTitleGradient: colors.useTitleGradient,
                        titleText: colors.textColor,
                        useGradient: colors.useGradient,
                        fontSize: colors.fontSize,
                        textAlign: colors.textAlign
                    };
                    self.applyThemeToNodes(nodes, themeColors);
                }
            };
            window.XZGThemePanel.onReset = () => {
                const nodes = self.getSelectedNodes();
                if (nodes && nodes.length > 0) {
                    self.currentNodes = nodes;
                    self.removeThemeFromNodes(nodes);
                }
            };
        }

        this.setupSelectionListener();

        const observer = new MutationObserver(() => {
            self.refreshDOMGradients();
        });
        
        const graphCanvas = document.getElementById("graph-canvas");
        if (graphCanvas) {
            observer.observe(graphCanvas, { 
                childList: true, 
                subtree: true 
            });
        }
    },

    setupSelectionListener() {
        const self = this;
        let lastSelectedIds = new Set();

        function checkSelectionChange() {
            if (!window.XZGThemePanel || !window.XZGThemePanel.isVisible) {
                lastSelectedIds = new Set();
                return;
            }
            
            const nodes = self.getSelectedNodes();
            const currentIds = new Set(nodes.map(n => n.id));
            
            let changed = false;
            if (currentIds.size !== lastSelectedIds.size) {
                changed = true;
            } else if (currentIds.size > 0) {
                for (const id of currentIds) {
                    if (!lastSelectedIds.has(id)) {
                        changed = true;
                        break;
                    }
                }
            }
            
            if (changed && currentIds.size > 0) {
                lastSelectedIds = currentIds;
                self.currentNodes = nodes;
                const refNode = self.getTopLeftNode(nodes);
                if (refNode) {
                    self.updatePanelFromNode(refNode);
                }
            }
        }

        setInterval(checkSelectionChange, 200);
    },

    updatePanelFromNode(node) {
        if (!window.XZGThemePanel) return;
        
        const grad = this.getNodeGradient(node);
        if (grad) {
            window.XZGThemePanel.setCurrentTheme({
                colors: {
                    color1: grad.color1,
                    color2: grad.color2,
                    color3: grad.color3,
                    direction: grad.direction,
                    titleColor1: grad.titleColor1,
                    titleColor2: grad.titleColor2,
                    titleColor3: grad.titleColor3,
                    titleDirection: grad.titleDirection,
                    useTitleGradient: grad.useTitleGradient,
                    titleText: grad.titleText,
                    useGradient: grad.useGradient,
                    fontSize: grad.fontSize,
                    textAlign: grad.textAlign
                }
            });
        } else {
            window.XZGThemePanel.resetToDefault();
        }
    },

    refreshDOMGradients() {
        if (!window.app || !app.graph) return;
        const nodes = app.graph._nodes || app.graph.nodes;
        if (!nodes) return;
        nodes.forEach(node => {
            if (node._xzgGradient) {
                this.applyGradientToDOMNode(node);
            }
        });
    },

    showPanelForNodes(nodes) {
        if (!window.XZGThemePanel) return;
        
        window.XZGThemePanel.create();
        
        if (nodes && nodes.length > 0) {
            this.currentNodes = nodes;
            const refNode = this.getTopLeftNode(nodes);
            if (refNode) {
                this.updatePanelFromNode(refNode);
            }
        }
        
        window.XZGThemePanel.show();
    },

    showPanel(x, y) {
        this.showPanelForNodes(this.currentNodes);
    },

    waitForComfyUI() {
        return new Promise((resolve) => {
            const check = () => {
                if (window.app && window.app.graph && window.LiteGraph) {
                    resolve();
                } else {
                    setTimeout(check, 100);
                }
            };
            check();
        });
    }
};

(function initThemeWhenReady() {
    if (window.XZGThemePresets && window.XZGThemePanel) {
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", () => {
                window.XZGThemeManager.init();
            });
        } else {
            window.XZGThemeManager.init();
        }
    } else {
        setTimeout(initThemeWhenReady, 50);
    }
})();

(function registerExtensionEarly() {
    function tryRegister() {
        if (window.app && typeof window.app.registerExtension === "function") {
            try {
                app.registerExtension({
                    name: "XZG.Theme",
                    
                    getNodeMenuItems(node) {
                        if (!window.XZGThemeManager) return [];
                        
                        const canvas = app.canvas;
                        let nodes = [];
                        if (canvas.selected_nodes && canvas.selected_nodes[node.id]) {
                            nodes = Object.values(canvas.selected_nodes);
                        } else {
                            nodes = [node];
                        }
                        nodes = nodes.filter(n => n.type !== "XiaozhuguangTitle");
                        if (!nodes.length) return [];
                        
                        let shortcutText = "";
                        try {
                            const stored = localStorage.getItem("xzg_theme_shortcut");
                            if (stored) {
                                const sc = JSON.parse(stored);
                                const parts = [];
                                if (sc.ctrl) parts.push("Ctrl");
                                if (sc.alt) parts.push("Alt");
                                if (sc.shift) parts.push("Shift");
                                parts.push(sc.key.toUpperCase());
                                shortcutText = ` <span style="color:#888;font-size:10px;">快捷键${parts.join("+")}</span>`;
                            }
                        } catch (e) {}
                        return [
                            null,
                            {
                                content: nodes.length > 1
                                    ? `<span style="color:#FFD700;">🎨 小珠光主题 (${nodes.length})${shortcutText}</span>`
                                    : `<span style="color:#FFD700;">🎨 小珠光主题${shortcutText}</span>`,
                                callback: () => {
                                    if (window.XZGThemeManager) {
                                        window.XZGThemeManager.currentNodes = nodes;
                                        window.XZGThemeManager.showPanelForNodes(nodes);
                                    }
                                }
                            }
                        ];
                    }
                });
            } catch(e) {}
        } else {
            setTimeout(tryRegister, 100);
        }
    }
    tryRegister();
})();

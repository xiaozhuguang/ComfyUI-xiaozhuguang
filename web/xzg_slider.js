import { app } from "../../scripts/app.js";
import { xzgT } from "./xzg_i18n.js";


(function() {
    const XzgSliderSettings = {
        dialog: null,

        show(node) {
            if (this.dialog) {
                this.dialog.remove();
                this.dialog = null;
            }

            const cfg = node._xzgCfg || { min: 0, max: 100, step: 1, value: 50, type: 'INT', valueOffset: -20, valueOffsetXPct: 48, fontSize: 15, valueColor: '#ffffff' };
            const isInt = cfg.type === 'INT';

            const dialog = document.createElement("div");
            dialog.style.cssText = `
                position: fixed;
                z-index: 10000;
                background: #2a2a2a;
                border: 1px solid #444;
                border-radius: 8px;
                padding: 16px;
                min-width: 280px;
                font-family: Arial, sans-serif;
                color: #fff;
                box-shadow: 0 4px 20px rgba(0,0,0,0.5);
            `;

            dialog.innerHTML = `
                <style>.xzg-snap-input::-webkit-outer-spin-button,.xzg-snap-input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}</style>
                <div id="xzg-slider-drag-handle" style="display:flex;align-items:center;gap:8px;margin-bottom:16px;padding-bottom:8px;border-bottom:1px solid #3a3a3a;cursor:move;user-select:none;">
                    <div style="width:12px;height:12px;border-radius:50%;background:transparent;"></div>
                    <span style="font-weight:bold;font-size:14px;">${xzgT('小珠光滑条设置','Xiaozhuguang Slider Settings')}</span>
                </div>
                <div style="display:flex;flex-direction:column;gap:12px;">
                    <div style="display:flex;align-items:center;gap:10px;">
                        <label style="width:60px;font-size:12px;color:#aaa;">${xzgT('数值类型','Value Type')}</label>
                        <div style="flex:1;display:flex;gap:4px;">
                            <button id="xzg-slider-type-int" type="button"
                                style="flex:1;padding:6px;background:${isInt ? '#555' : '#3a3a3a'};border:none;border-radius:4px;color:#fff;font-size:12px;cursor:pointer;font-weight:${isInt ? 'bold' : 'normal'};">
                                ${xzgT('整数','Integer')}
                            </button>
                            <button id="xzg-slider-type-float" type="button"
                                style="flex:1;padding:6px;background:${!isInt ? '#555' : '#3a3a3a'};border:none;border-radius:4px;color:#fff;font-size:12px;cursor:pointer;font-weight:${!isInt ? 'bold' : 'normal'};">
                                ${xzgT('浮点','Float')}
                            </button>
                        </div>
                    </div>
                    <div style="display:flex;align-items:center;gap:10px;">
                        <label style="width:60px;font-size:12px;color:#aaa;">${xzgT('最小值','Min')}</label>
                        <input type="number" id="xzg-slider-min" value="${cfg.min}" step="${isInt ? 1 : 0.01}"
                            style="flex:1;padding:6px 8px;background:#1a1a1a;border:1px solid #444;border-radius:4px;color:#fff;font-size:12px;outline:none;">
                    </div>
                    <div style="display:flex;align-items:center;gap:10px;">
                        <label style="width:60px;font-size:12px;color:#aaa;">${xzgT('最大值','Max')}</label>
                        <input type="number" id="xzg-slider-max" value="${cfg.max}" step="${isInt ? 1 : 0.01}"
                            style="flex:1;padding:6px 8px;background:#1a1a1a;border:1px solid #444;border-radius:4px;color:#fff;font-size:12px;outline:none;">
                    </div>
                    <div style="display:flex;align-items:center;gap:10px;">
                        <label style="width:60px;font-size:12px;color:#aaa;">${xzgT('步长','Step')}</label>
                        <input type="number" id="xzg-slider-step" value="${cfg.step ?? 1}" step="${isInt ? 1 : 0.01}"
                            style="flex:1;padding:6px 8px;background:#1a1a1a;border:1px solid #444;border-radius:4px;color:#fff;font-size:12px;outline:none;">
                    </div>
                    <div id="xzg-slider-snaps-section">
                        <div style="display:flex;align-items:center;gap:10px;">
                            <label style="width:60px;font-size:12px;color:#aaa;">${xzgT('多值定格','Snap Values')}</label>
                            <input type="checkbox" id="xzg-slider-use-snaps" ${cfg.useSnaps ? 'checked' : ''}
                                style="accent-color:#555;cursor:pointer;">
                            <span style="font-size:11px;color:#666;">${xzgT('最多5个','Max 5')}</span>
                        </div>
                        <div id="xzg-slider-snaps-list" style="display:${cfg.useSnaps ? 'flex' : 'none'};flex-wrap:wrap;gap:4px;margin-top:6px;">
                            ${[0,1,2,3,4].map(i => {
                                const v = (cfg.snaps && cfg.snaps[i] !== undefined) ? cfg.snaps[i] : '';
                                return `<input type="number" class="xzg-snap-input" data-index="${i}" value="${v}" placeholder="${xzgT('值','V')}${i+1}"
                                    style="width:40px;padding:4px 2px;background:#1a1a1a;border:1px solid #444;border-radius:4px;color:#fff;font-size:11px;outline:none;text-align:center;-moz-appearance:textfield;">`;
                            }).join('')}
                        </div>
                        <div id="xzg-slider-snap-style" style="display:${cfg.useSnaps ? 'flex' : 'none'};align-items:center;gap:10px;margin-top:6px;">
                            <label style="font-size:11px;color:#aaa;white-space:nowrap;">${xzgT('圆点颜色','Dot Color')}</label>
                            <input type="color" id="xzg-slider-snap-color" value="${cfg.snapTickColor ?? '#555'}"
                                style="width:24px;height:24px;border:1px solid #555;border-radius:3px;background:transparent;cursor:pointer;padding:0;">
                            <label style="font-size:11px;color:#aaa;white-space:nowrap;margin-left:4px;">${xzgT('大小','Size')}</label>
                            <input type="range" id="xzg-slider-snap-size" min="3" max="14" value="${cfg.snapTickSize ?? 6}"
                                style="flex:1;accent-color:#555;cursor:pointer;">
                            <span id="xzg-slider-snap-size-val" style="min-width:20px;font-size:11px;color:#ccc;">${cfg.snapTickSize ?? 6}</span>
                        </div>
                    </div>
                    <div style="display:flex;gap:8px;margin-top:8px;">
                        <button id="xzg-slider-reset" type="button"
                            style="flex:1;padding:6px;background:#555;border:none;border-radius:4px;color:#ccc;font-size:11px;cursor:pointer;">
                            ${xzgT('恢复默认','Reset')}
                        </button>
                    </div>
                    <div style="display:flex;gap:8px;margin-top:8px;">
                        <button id="xzg-slider-cancel" type="button"
                            style="flex:1;padding:8px;background:#444;border:none;border-radius:4px;color:#fff;font-size:12px;cursor:pointer;">
                            ${xzgT('取消','Cancel')}
                        </button>
                        <button id="xzg-slider-ok" type="button"
                            style="flex:1;padding:8px;background:#555;border:none;border-radius:4px;color:#fff;font-size:12px;cursor:pointer;font-weight:bold;">
                            ${xzgT('确定','OK')}
                        </button>
                    </div>
                </div>
            `;

            document.body.appendChild(dialog);
            this.dialog = dialog;

            const rect = app.canvas.canvas.getBoundingClientRect();
            const nodeScale = app.canvas.ds.scale;
            const nodeLeft = (node.pos[0] + app.canvas.ds.offset[0]) * nodeScale + rect.left;
            const nodeTop = (node.pos[1] + app.canvas.ds.offset[1]) * nodeScale + rect.top;
            const nodeWidth = (node.size?.[0] || 200) * nodeScale;
            
            const dlgWidth = 320;
            const dlgHeight = 500;
            const gap = 15;
            
            let dlgLeft = nodeLeft + nodeWidth + gap;
            let dlgTop = rect.top + rect.height / 2 - dlgHeight / 2;
            
            if (dlgLeft + dlgWidth > rect.right - 10) dlgLeft = nodeLeft - dlgWidth - gap;
            if (dlgLeft < rect.left + 10) dlgLeft = rect.left + 10;
            if (dlgTop < rect.top + 10) dlgTop = rect.top + 10;
            if (dlgTop + dlgHeight > rect.bottom - 10) dlgTop = rect.bottom - dlgHeight - 10;
            
            dialog.style.left = dlgLeft + "px";
            dialog.style.top = dlgTop + "px";

            const dragHandle = dialog.querySelector("#xzg-slider-drag-handle");
            let isDragging = false, dragStartX = 0, dragStartY = 0, dlgStartX = 0, dlgStartY = 0;
            dragHandle.addEventListener("mousedown", (e) => {
                isDragging = true;
                dragStartX = e.clientX; dragStartY = e.clientY;
                dlgStartX = dialog.offsetLeft; dlgStartY = dialog.offsetTop;
                e.preventDefault(); e.stopPropagation();
            });
            document.addEventListener("mousemove", (e) => {
                if (!isDragging) return;
                const dx = e.clientX - dragStartX, dy = e.clientY - dragStartY;
                let newLeft = dlgStartX + dx, newTop = dlgStartY + dy;
                newLeft = Math.max(0, Math.min(window.innerWidth - dialog.offsetWidth, newLeft));
                newTop = Math.max(0, Math.min(window.innerHeight - dialog.offsetHeight, newTop));
                dialog.style.left = newLeft + "px";
                dialog.style.top = newTop + "px";
            });
            document.addEventListener("mouseup", () => { isDragging = false; });

            let confirmed = false;
            const closeDialog = () => {
                if (this.dialog) { this.dialog.remove(); this.dialog = null; }
            };

            dialog.querySelector("#xzg-slider-cancel").onclick = closeDialog;

            let currentType = isInt ? 'INT' : 'FLOAT';
            const intBtn = dialog.querySelector("#xzg-slider-type-int");
            const floatBtn = dialog.querySelector("#xzg-slider-type-float");
            const minInput = dialog.querySelector("#xzg-slider-min");
            const maxInput = dialog.querySelector("#xzg-slider-max");
            const stepInput = dialog.querySelector("#xzg-slider-step");

            function updateTypeUI(type) {
                currentType = type;
                if (type === 'INT') {
                    intBtn.style.background = '#555'; intBtn.style.fontWeight = 'bold';
                    floatBtn.style.background = '#3a3a3a'; floatBtn.style.fontWeight = 'normal';
                    minInput.step = '1'; maxInput.step = '1'; stepInput.step = '1';
                } else {
                    floatBtn.style.background = '#555'; floatBtn.style.fontWeight = 'bold';
                    intBtn.style.background = '#3a3a3a'; intBtn.style.fontWeight = 'normal';
                    minInput.step = '0.01'; maxInput.step = '0.01'; stepInput.step = '0.01';
                }
            }
            intBtn.onclick = () => updateTypeUI('INT');
            floatBtn.onclick = () => updateTypeUI('FLOAT');

            // 多值定格开关
            const useSnapsCb = dialog.querySelector("#xzg-slider-use-snaps");
            const snapsList = dialog.querySelector("#xzg-slider-snaps-list");
            const snapStyle = dialog.querySelector("#xzg-slider-snap-style");
            if (useSnapsCb && snapsList) {
                useSnapsCb.addEventListener("change", () => {
                    const show = useSnapsCb.checked;
                    snapsList.style.display = show ? "flex" : "none";
                    if (snapStyle) snapStyle.style.display = show ? "flex" : "none";
                });
            }
            const snapSizeInput = dialog.querySelector("#xzg-slider-snap-size");
            const snapSizeVal = dialog.querySelector("#xzg-slider-snap-size-val");
            if (snapSizeInput && snapSizeVal) {
                snapSizeInput.addEventListener("input", () => { snapSizeVal.textContent = snapSizeInput.value; });
            }

            const resetBtn = dialog.querySelector("#xzg-slider-reset");
            resetBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                minInput.value = 0; maxInput.value = 100; stepInput.value = 1;
                updateTypeUI('INT');
            });

            dialog.querySelector("#xzg-slider-ok").onclick = () => {
                let newMin, newMax, newStep;
                if (currentType === 'INT') {
                    newMin = parseInt(minInput.value) || 0;
                    newMax = parseInt(maxInput.value) || 100;
                    newStep = parseInt(stepInput.value) || 1;
                } else {
                    newMin = parseFloat(minInput.value) || 0;
                    newMax = parseFloat(maxInput.value) || 100;
                    newStep = parseFloat(stepInput.value) || 1;
                }
                if (newMin >= newMax) { alert(xzgT("最小值必须小于最大值","Min must be less than Max")); return; }
                if (newStep <= 0) { alert(xzgT("步长必须大于0","Step must be greater than 0")); return; }

                if (!node._xzgCfg) node._xzgCfg = {};
                node._xzgCfg.min = newMin;
                node._xzgCfg.max = newMax;
                node._xzgCfg.step = newStep;
                node._xzgCfg.type = currentType;

                const useSnaps = dialog.querySelector("#xzg-slider-use-snaps")?.checked ?? false;
                const snapInputs = dialog.querySelectorAll(".xzg-snap-input");
                const snaps = [];
                if (useSnaps) {
                    snapInputs.forEach(inp => {
                        const v = parseFloat(inp.value);
                        if (!isNaN(v)) snaps.push(v);
                    });
                }
                node._xzgCfg.useSnaps = useSnaps;
                node._xzgCfg.snaps = snaps;
                node._xzgCfg.snapTickColor = dialog.querySelector("#xzg-slider-snap-color")?.value || '#555';
                node._xzgCfg.snapTickSize = parseInt(dialog.querySelector("#xzg-slider-snap-size")?.value) || 6;

                // 更新原生 widget（需同时更新内部 DOM 元素）
                const widget = node.widgets?.find(w => w.name === '数值');
                if (widget) {
                    widget.options.min = newMin;
                    widget.options.max = newMax;
                    widget.options.step = newStep;
                    // 强制更新内部 slider 元素
                    if (widget.element) {
                        const slider = widget.element.querySelector('input[type="range"]');
                        if (slider) {
                            slider.min = String(newMin);
                            slider.max = String(newMax);
                            slider.step = String(newStep);
                        }
                    } else if (widget.inputEl) {
                        widget.inputEl.min = String(newMin);
                        widget.inputEl.max = String(newMax);
                        widget.inputEl.step = String(newStep);
                    }
                    
                    let val = widget.value ?? newMin;
                    val = Math.max(newMin, Math.min(newMax, val));
                    if (useSnaps && snaps.length > 0) {
                        let nearest = snaps[0], minDist = Math.abs(val - nearest);
                        for (let i = 1; i < snaps.length; i++) {
                            const dist = Math.abs(val - snaps[i]);
                            if (dist < minDist) { minDist = dist; nearest = snaps[i]; }
                        }
                        val = nearest;
                    } else {
                        val = Math.round((val - newMin) / newStep) * newStep + newMin;
                        if (currentType === 'INT') val = Math.round(val);
                    }
                    widget.value = val;
                    if (widget.callback) {
                        try { widget.callback(val, node, widget); } catch (e) {}
                    }
                }

                if (node.outputs && node.outputs[0]) {
                    node.outputs[0].type = currentType === 'INT' ? 'INT' : 'FLOAT';
                }

                if (node._xzgSaveCfg) node._xzgSaveCfg();
                if (node.graph) node.graph.setDirtyCanvas(true, true);
                confirmed = true;
                closeDialog();
            };

            addOutsideClickListener(dialog, closeDialog, dragHandle);
        }
    };

    function addOutsideClickListener(dialog, callback, dragHandle) {
        let mousedownOnHandle = false;
        if (dragHandle) {
            dragHandle.addEventListener("mousedown", () => { mousedownOnHandle = true; }, true);
        }
        const handler = (e) => {
            if (mousedownOnHandle) { mousedownOnHandle = false; return; }
            if (!dialog.contains(e.target)) {
                callback();
                document.removeEventListener('mousedown', handler, true);
            }
        };
        setTimeout(() => document.addEventListener('mousedown', handler, true), 0);
    }

    function setupNodeSlider(node) {
        if (node._xzgCfg) return;

        const numWidget = node.widgets?.find(w => w.name === '数值');
        if (!numWidget) return;

        const savedCfg = node.properties?.xzgSliderCfg;
        if (savedCfg && typeof savedCfg === 'object') {
            node._xzgCfg = {
                min: savedCfg.min ?? numWidget.options?.min ?? 0,
                max: savedCfg.max ?? numWidget.options?.max ?? 100,
                step: savedCfg.step ?? 1,
                value: numWidget.value ?? savedCfg.value ?? 50,
                type: savedCfg.type ?? 'INT',
                snaps: savedCfg.snaps ?? [],
                useSnaps: savedCfg.useSnaps ?? false,
                snapTickColor: savedCfg.snapTickColor ?? '#555',
                snapTickSize: savedCfg.snapTickSize ?? 6
            };
        } else {
            node._xzgCfg = {
                min: numWidget.options?.min ?? 0,
                max: numWidget.options?.max ?? 100,
                step: numWidget.options?.step ?? 1,
                value: numWidget.value ?? 50,
                type: 'INT',
                snaps: [],
                useSnaps: false,
                snapTickColor: '#555',
                snapTickSize: 6
            };
        }

        const cfg = node._xzgCfg;
        // 应用配置到原生 widget
        numWidget.options.min = cfg.min;
        numWidget.options.max = cfg.max;
        numWidget.options.step = cfg.step;
        numWidget.value = cfg.value;

        // 拦截 callback：每次滑条值变化时强制按步长/定格吸附
        if (!numWidget._xzgHooked) {
            numWidget._xzgHooked = true;
            const origCb = numWidget.callback;
            numWidget.callback = function(val, n, w) {
                const c = n._xzgCfg;
                if (c) {
                    const step = c.step || 1;
                    const smin = c.min != null ? c.min : 0;
                    const smax = c.max != null ? c.max : 100;
                    val = Math.max(smin, Math.min(smax, Number(val)));
                    if (c.useSnaps && c.snaps && c.snaps.length > 0) {
                        let nearest = c.snaps[0], minDist = Math.abs(val - nearest);
                        for (let i = 1; i < c.snaps.length; i++) {
                            const dist = Math.abs(val - c.snaps[i]);
                            if (dist < minDist) { minDist = dist; nearest = c.snaps[i]; }
                        }
                        val = nearest;
                    } else {
                        val = Math.round((val - smin) / step) * step + smin;
                        if (c.type === 'INT') val = Math.round(val);
                    }
                    w.value = val;
                    c.value = val;
                }
                if (origCb) origCb.call(this, val, n, w);
            };
        }
        // 延迟更新内部 DOM（节点可能尚未渲染）
        setTimeout(() => {
            const el = numWidget.element || numWidget.inputEl;
            if (!el) return;
            const slider = el.querySelector('input[type="range"]') || (el.tagName === 'INPUT' ? el : null);
            if (slider) {
                slider.min = String(cfg.min);
                slider.max = String(cfg.max);
                slider.step = String(cfg.step);
            }
        }, 100);

        if (node.outputs && node.outputs[0]) {
            node.outputs[0].type = cfg.type === 'INT' ? 'INT' : 'FLOAT';
        }

        node._xzgSaveCfg = function() {
            if (!node.properties) node.properties = {};
            node.properties.xzgSliderCfg = {
                min: node._xzgCfg.min,
                max: node._xzgCfg.max,
                step: node._xzgCfg.step,
                type: node._xzgCfg.type,
                snaps: node._xzgCfg.snaps || [],
                useSnaps: node._xzgCfg.useSnaps || false,
                snapTickColor: node._xzgCfg.snapTickColor ?? '#555',
                snapTickSize: node._xzgCfg.snapTickSize ?? 6
            };
        };
    }

    app.registerExtension({
        name: "ComfyUI.xiaozhuguang.slider",
        beforeRegisterNodeDef(nodeType, nodeData) {
            if (nodeData.name !== "XiaozhuguangSlider") return;

            const origOnNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function() {
                if (origOnNodeCreated) origOnNodeCreated.apply(this, arguments);
                setupNodeSlider(this);
            };

            const origOnConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function() {
                if (origOnConfigure) origOnConfigure.apply(this, arguments);
                if (!this._xzgCfg && this.properties?.xzgSliderCfg) {
                    const saved = this.properties.xzgSliderCfg;
                    this._xzgCfg = {
                        min: saved.min ?? 0,
                        max: saved.max ?? 100,
                        step: saved.step ?? 1,
                        value: this.widgets?.find(w => w.name === '数值')?.value ?? 50,
                        type: saved.type ?? 'INT',
                        snaps: saved.snaps ?? [],
                        useSnaps: saved.useSnaps ?? false,
                        snapTickColor: saved.snapTickColor ?? '#555',
                        snapTickSize: saved.snapTickSize ?? 6
                    };
                    const w = this.widgets?.find(w => w.name === '数值');
                    if (w) {
                        w.options.min = this._xzgCfg.min;
                        w.options.max = this._xzgCfg.max;
                        w.options.step = this._xzgCfg.step;
                    }
                    if (this.outputs && this.outputs[0]) {
                        this.outputs[0].type = this._xzgCfg.type === 'INT' ? 'INT' : 'FLOAT';
                    }
                }
            };
        },
        setup() {
            try {
                const LG = window.LiteGraph || app.canvas?.constructor;
                if (!LG?.LGraphCanvas?.prototype?.getNodeMenuOptions) return;
                const origGetNodeMenuOptions = LG.LGraphCanvas.prototype.getNodeMenuOptions;
                LG.LGraphCanvas.prototype.getNodeMenuOptions = function(node) {
                    const options = origGetNodeMenuOptions.call(this, node);
                    if (node.type !== "XiaozhuguangSlider" || !options) return options;
                    const sliderItem = {
                        content: `<span style="color:#FFD700;">${xzgT('小珠光滑条设置','Xiaozhuguang Slider Settings')}</span>`,
                        callback: () => {
                            setupNodeSlider(node);
                            XzgSliderSettings.show(node);
                        }
                    };
                    options.push(null, sliderItem);
                    return options;
                };
            } catch(e) {}
        }
    });
})();

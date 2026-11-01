import { app } from "../../scripts/app.js";

const TYPE = "XiaozhuguangBatchPromptList";
let fileDropHookInstalled = false;

function hidePromptDataInput(node) {
    const index = node.inputs?.findIndex(input => input.name === "提示词列表") ?? -1;
    if (index >= 0) node.removeInput(index);
    // One socket row only; avoid retaining the old two-input widget offset.
    node.widgets_start_y = (globalThis.LiteGraph?.NODE_SLOT_HEIGHT || 20) + 2;
}

// 复刻前端官方 forwardEventToCanvas（useCanvasInteractions）：
// 把指针/滚轮事件原样重派发到画布元素，由 LiteGraph 原生管线处理选中与拖拽。
function forwardEventToCanvas(event) {
    const canvasEl = app.canvas?.canvas;
    if (!canvasEl) return;
    event.preventDefault();
    event.stopPropagation();
    if (event instanceof PointerEvent) {
        canvasEl.dispatchEvent(new PointerEvent(event.type, event));
    } else if (event instanceof WheelEvent) {
        canvasEl.dispatchEvent(new WheelEvent("wheel", {
            clientX: event.clientX, clientY: event.clientY,
            deltaX: event.deltaX, deltaY: event.deltaY,
            ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey,
        }));
    } else {
        canvasEl.dispatchEvent(new MouseEvent(event.type, event));
    }
}

// Vue 高亮的真正同步入口是 canvas.processSelect（前端 selectNode 的实现），
// graph.selectNodes 只改非响应式状态，不会即时刷新选中描边。
function selectNodeViaCanvas(node, event) {
    const canvas = app.canvas, graph = app.graph;
    if (!canvas || !graph) return;
    const nodeObj = graph.getNodeById?.(node.id) ?? node;
    if (typeof canvas.processSelect === "function") {
        canvas.processSelect(nodeObj, event);
    } else if (!graph._selected_nodes?.[node.id]) {
        (graph.selectNodes?.([nodeObj]) ?? graph.selectNode?.(nodeObj));
        graph.change?.();
    }
    canvas.setDirty?.(true, true);
}

// 容器 pointer-events:none 后，滚轮落在卡片区会直接缩放画布。
// 这里补一条全局捕获：滚轮在提示词文本框上时优先滚动卡片列表/文本框，
// 都滚不动时再转发给画布缩放（与 xzg_text_box 的做法一致）。
if (!globalThis.__xzgBplWheelForward) {
    globalThis.__xzgBplWheelForward = true;
    window.addEventListener("wheel", event => {
        const editor = event.target;
        if (!editor?.classList?.contains?.("xzg-bpl-editor")) return;
        const cards = editor.closest("[data-xzg-cards]");
        if (cards && cards.scrollHeight > cards.clientHeight + 1) {
            event.preventDefault(); event.stopPropagation();
            cards.scrollTop += event.deltaY;
            return;
        }
        if (editor.scrollHeight > editor.clientHeight + 1) return;
        const canvasEl = app.canvas?.canvas;
        if (!canvasEl) return;
        event.preventDefault(); event.stopPropagation();
        canvasEl.dispatchEvent(new WheelEvent("wheel", {
            deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode,
            clientX: event.clientX, clientY: event.clientY,
            ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, altKey: event.altKey, metaKey: event.metaKey,
            bubbles: true, cancelable: true,
        }));
    }, { capture: true, passive: false });
}

function parseEntries(text) {
    const raw = String(text || "").trim();
    try {
        const list = JSON.parse(raw);
        if (Array.isArray(list)) return list.map(item => String(item));
    } catch (_) {}
    return raw.replace(/\r\n?/g, "\n").split(/^\s*---+\s*$/m).map(item => item.trim()).filter(Boolean);
}

function saveEntries(node) {
    const source = node._xzgPromptDataWidget;
    if (source) {
        source.value = JSON.stringify(node._xzgPromptEntries || []);
        source.callback?.(source.value);
    }
    node._xzgPromptCount = node._xzgPromptEntries?.length || 0;
    node.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
}

function renderCards(node) {
    const root = node._xzgPromptRoot;
    if (!root) return;
    if (!node._xzgPromptEntries?.length) node._xzgPromptEntries = [""];
    root.replaceChildren();
    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;justify-content:space-between;height:22px;min-height:22px;margin:0 0 4px;padding:0;color:#ddd;font:12px/22px sans-serif";
    const label = document.createElement("span");
    label.textContent = String(node._xzgPromptEntries.length);
    label.style.cssText = "display:flex;align-items:center;height:22px;line-height:22px;margin:0;padding:0";
    const add = document.createElement("button");
    add.textContent = "+";
    add.title = "新增提示词";
    add.style.cssText = "display:flex;align-items:center;justify-content:center;box-sizing:border-box;width:22px;height:22px;min-height:22px;margin:0;padding:0;border:0;background:transparent;color:#ddd;font:20px/22px sans-serif;cursor:pointer;pointer-events:auto";
    add.onclick = () => { node._xzgPromptEntries.push(""); saveEntries(node); renderCards(node); node._xzgPromptCards?.lastElementChild?.querySelector("textarea")?.focus(); };
    const subtract = document.createElement("button");
    subtract.textContent = "−";
    subtract.title = "删除最后一个文本框";
    subtract.style.cssText = add.style.cssText;
    subtract.disabled = node._xzgPromptEntries.length <= 1;
    if (subtract.disabled) subtract.style.opacity = "0.3";
    subtract.onclick = () => {
        if (node._xzgPromptEntries.length <= 1) return;
        node._xzgPromptEntries.pop(); saveEntries(node); renderCards(node);
    };
    const upload = document.createElement("button");
    upload.textContent = "上传";
    upload.title = "上传 TXT 文档（可一次多选），每个非空行追加为一条提示词";
    upload.style.cssText = "height:22px;padding:0 6px;border:0;border-radius:2px;background:transparent;color:#ccc;font:12px sans-serif;cursor:pointer;pointer-events:auto";
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".txt,text/plain";
    fileInput.multiple = true;
    fileInput.style.display = "none";
    fileInput.onchange = async () => {
        const files = [...(fileInput.files || [])];
        fileInput.value = "";
        if (!files.length) return;
        try {
            const additions = (await Promise.all(files.map(file => file.text())))
                .flatMap(value => value.replace(/\r\n?/g, "\n").split("\n").map(line => line.trim()).filter(Boolean));
            if (additions.length) {
                const entries = node._xzgPromptEntries;
                // 初始的空卡片无需保留，避免第一条提示词前面留白。
                if (entries.length === 1 && !entries[0]) entries.length = 0;
                entries.push(...additions);
                saveEntries(node); renderCards(node);
            }
        } catch (error) { console.error("[小珠光批次提示词列表] TXT 导入失败", error); }
    };
    upload.onclick = () => fileInput.click();
    const clear = document.createElement("button");
    clear.textContent = "清空";
    clear.title = "清空全部提示词";
    clear.style.cssText = "height:22px;padding:0 6px;border:0;border-radius:2px;background:transparent;color:#f66;font:12px sans-serif;cursor:pointer;pointer-events:auto";
    clear.onclick = () => {
        node._xzgPromptEntries = [""];
        saveEntries(node); renderCards(node);
    };
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;align-items:center;height:22px;margin:0;padding:0;gap:2px";
    actions.append(upload, clear, subtract, add);
    header.append(label, actions);
    root.append(header);
    header.style.flex = "0 0 auto";
    const cards = document.createElement("div");
    cards.style.cssText = "flex:1 1 0;min-height:0;overflow-y:auto;overflow-x:hidden;scrollbar-width:thin;scrollbar-color:#777 transparent";
    cards.dataset.xzgCards = "1";
    node._xzgPromptCards = cards;
    root.append(cards);
    node._xzgPromptEntries.forEach((value, index) => {
        const card = document.createElement("section");
        card.style.cssText = "display:flex;flex-direction:column;margin:0 0 5px;padding:0;border:1px solid #444444;border-radius:4px;overflow:hidden;background:#202226;box-sizing:border-box;box-shadow:0 1px 3px rgba(0,0,0,0.45)";
        const toolbar = document.createElement("div");
        toolbar.style.cssText = "display:flex;align-items:center;justify-content:flex-end;gap:2px;height:20px;min-height:20px;padding:0 2px;background:#353535;box-sizing:border-box";
        const move = (delta, text) => {
            const target = index + delta;
            if (target < 0 || target >= node._xzgPromptEntries.length) return;
            [node._xzgPromptEntries[index], node._xzgPromptEntries[target]] = [node._xzgPromptEntries[target], node._xzgPromptEntries[index]];
            saveEntries(node); renderCards(node);
        };
        const up = document.createElement("button"); up.textContent = "↑"; up.title = "上移"; up.disabled = index === 0; up.onclick = () => move(-1);
        const down = document.createElement("button"); down.textContent = "↓"; down.title = "下移"; down.disabled = index === node._xzgPromptEntries.length - 1; down.onclick = () => move(1);
        const remove = document.createElement("button"); remove.textContent = "×"; remove.title = "删除"; remove.onclick = () => { node._xzgPromptEntries.splice(index, 1); if (!node._xzgPromptEntries.length) node._xzgPromptEntries.push(""); saveEntries(node); renderCards(node); };
        toolbar.append(up, down, remove);
        for (const button of [up, down, remove]) {
            button.style.cssText = "width:18px;height:18px;padding:0;border:0;border-radius:2px;background:transparent;color:#ccc;font:13px sans-serif;cursor:pointer;pointer-events:auto";
            if (button.disabled) button.style.opacity = "0.3";
        }
        const editor = document.createElement("textarea");
        editor.value = value;
        editor.placeholder = "双击编辑更方便…";
        editor.rows = 3;
        editor.style.cssText = "display:block;width:100%;height:68px;min-height:68px;max-height:68px;box-sizing:border-box;resize:none;overflow:hidden;padding:5px 6px;background:#222222;color:#eee;border:0;border-radius:0;font:12px/1.5 sans-serif;outline:none;pointer-events:auto";
        editor.classList.add("xzg-bpl-editor");
        editor.addEventListener("input", () => { node._xzgPromptEntries[index] = editor.value; saveEntries(node); });
        editor.addEventListener("dblclick", event => {
            event.preventDefault(); event.stopPropagation();
            node._xzgClosePromptEditor?.();
            const overlay = document.createElement("div");
            overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:#0007";
            // 草稿式编辑：确认后写回，取消/ESC 丢弃修改。
            // 位置和大小记忆在 localStorage，标题栏可拖动，右下角可调整大小。
            const RECT_KEY = "xzgBatchPromptEditorRect";
            const panel = document.createElement("div");
            panel.style.cssText = "position:absolute;display:flex;flex-direction:column;box-sizing:border-box;padding:10px;gap:8px;background:#17181c;border:1px solid #555;border-radius:8px;box-shadow:0 8px 32px #000a";
            let saved = null;
            try { saved = JSON.parse(localStorage.getItem(RECT_KEY) || "null"); } catch (_) {}
            const width = Math.min(Math.max(saved?.width || Math.round(innerWidth * 0.75), 360), innerWidth - 20);
            const height = Math.min(Math.max(saved?.height || Math.round(innerHeight * 0.75), 240), innerHeight - 20);
            const left = saved?.left != null ? Math.min(Math.max(saved.left, 10), innerWidth - 80) : Math.round((innerWidth - width) / 2);
            const top = saved?.top != null ? Math.min(Math.max(saved.top, 10), innerHeight - 80) : Math.round((innerHeight - height) / 2);
            Object.assign(panel.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
            const persistRect = () => {
                try { localStorage.setItem(RECT_KEY, JSON.stringify({ left: panel.offsetLeft, top: panel.offsetTop, width: panel.offsetWidth, height: panel.offsetHeight })); } catch (_) {}
            };
            const bar = document.createElement("div");
            bar.style.cssText = "display:flex;align-items:center;gap:8px;cursor:move;user-select:none;flex:0 0 auto";
            const title = document.createElement("span");
            title.textContent = `编辑提示词 · 第 ${index + 1} 条`;
            title.style.cssText = "flex:1 1 0;min-width:0;color:#ddd;font:600 14px sans-serif;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
            bar.append(title);
            bar.addEventListener("pointerdown", event => {
                if (event.button !== 0 || event.target.closest("button")) return;
                event.preventDefault(); event.stopPropagation();
                const start = [event.clientX, event.clientY, panel.offsetLeft, panel.offsetTop];
                bar.setPointerCapture(event.pointerId);
                const moveBar = e => {
                    const x = Math.min(Math.max(start[2] + e.clientX - start[0], 10 - panel.offsetWidth + 60), innerWidth - 60);
                    const y = Math.min(Math.max(start[3] + e.clientY - start[1], 0), innerHeight - 32);
                    panel.style.left = `${x}px`; panel.style.top = `${y}px`;
                };
                const finishBar = () => {
                    bar.removeEventListener("pointermove", moveBar);
                    bar.removeEventListener("pointerup", finishBar);
                    bar.removeEventListener("pointercancel", finishBar);
                    persistRect();
                };
                bar.addEventListener("pointermove", moveBar);
                bar.addEventListener("pointerup", finishBar);
                bar.addEventListener("pointercancel", finishBar);
            });
            const expanded = document.createElement("textarea");
            expanded.value = editor.value;
            expanded.placeholder = "在此编辑这条提示词…";
            expanded.style.cssText = "flex:1 1 0;min-height:0;resize:none;box-sizing:border-box;padding:14px;background:#202226;color:#eee;border:1px solid #444;border-radius:6px;outline:none;font:15px/1.7 sans-serif";
            expanded.addEventListener("focus", () => { expanded.style.borderColor = "#777"; });
            expanded.addEventListener("blur", () => { expanded.style.borderColor = "#444"; });
            const confirm = () => {
                editor.value = expanded.value;
                node._xzgPromptEntries[index] = expanded.value;
                saveEntries(node);
                close();
            };
            const close = () => { document.removeEventListener("keydown", keydown, true); overlay.remove(); node._xzgClosePromptEditor = null; };
            const keydown = e => {
                if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); close(); }
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); confirm(); }
            };
            const buttonStyle = "flex:0 0 auto;height:28px;padding:0 16px;border:1px solid transparent;border-radius:4px;background:#2a2d33;color:#ccc;font:13px sans-serif;cursor:pointer";
            const hoverOn = button => { button.style.background = "#41454e"; };
            const hoverOff = button => { button.style.background = "#2a2d33"; };
            const cancel = document.createElement("button");
            cancel.textContent = "取消";
            cancel.title = "丢弃修改并关闭（ESC）";
            cancel.style.cssText = buttonStyle;
            cancel.onmouseenter = () => hoverOn(cancel);
            cancel.onmouseleave = () => hoverOff(cancel);
            cancel.onclick = close;
            const ok = document.createElement("button");
            ok.textContent = "确认";
            ok.title = "保存修改并关闭（Ctrl+Enter）";
            ok.style.cssText = buttonStyle;
            ok.onmouseenter = () => hoverOn(ok);
            ok.onmouseleave = () => hoverOff(ok);
            ok.onclick = confirm;
            node._xzgClosePromptEditor = close;
            overlay.addEventListener("pointerdown", e => { if (e.target === overlay) close(); });
            const resize = document.createElement("div");
            resize.title = "拖动调整大小";
            resize.style.cssText = "position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;touch-action:none;border-right:2px solid #666;border-bottom:2px solid #666;border-bottom-right-radius:7px;box-sizing:border-box";
            resize.addEventListener("pointerdown", event => {
                if (event.button !== 0) return;
                event.preventDefault(); event.stopPropagation();
                const start = [event.clientX, event.clientY, panel.offsetWidth, panel.offsetHeight];
                resize.setPointerCapture(event.pointerId);
                const moveResize = e => {
                    panel.style.width = `${Math.max(360, Math.min(start[2] + e.clientX - start[0], innerWidth - 20))}px`;
                    panel.style.height = `${Math.max(240, Math.min(start[3] + e.clientY - start[1], innerHeight - 20))}px`;
                };
                const finishResize = () => {
                    resize.removeEventListener("pointermove", moveResize);
                    resize.removeEventListener("pointerup", finishResize);
                    resize.removeEventListener("pointercancel", finishResize);
                    persistRect();
                };
                resize.addEventListener("pointermove", moveResize);
                resize.addEventListener("pointerup", finishResize);
                resize.addEventListener("pointercancel", finishResize);
            });
            bar.append(cancel, ok);
            panel.append(bar, expanded, resize);
            overlay.append(panel); document.body.append(overlay);
            document.addEventListener("keydown", keydown, true);
            expanded.focus();
        });
        card.append(toolbar, editor);
        cards.append(card);
    });
    const resize = document.createElement("div");
    resize.title = "拖动调整节点大小";
    resize.dataset.xzgNoDrag = "";
    resize.style.cssText = "position:absolute;right:0;bottom:0;width:14px;height:14px;cursor:nwse-resize;touch-action:none;box-sizing:border-box;pointer-events:auto";
    resize.addEventListener("pointerdown", event => {
        event.preventDefault(); event.stopPropagation();
        const start = [event.clientX, event.clientY, ...node.size];
        resize.setPointerCapture(event.pointerId);
        const move = e => {
            const scale = app.canvas?.ds?.scale || 1;
            node.setSize([Math.max(240, start[2] + (e.clientX - start[0]) / scale), Math.max(300, start[3] + (e.clientY - start[1]) / scale)]);
            node.setDirtyCanvas?.(true, true);
        };
        const finish = () => { resize.removeEventListener("pointermove", move); resize.removeEventListener("pointerup", finish); resize.removeEventListener("pointercancel", finish); };
        resize.addEventListener("pointermove", move);
        resize.addEventListener("pointerup", finish);
        resize.addEventListener("pointercancel", finish);
    });
    root.append(resize);
}

app.registerExtension({
    name: "xiaozhuguang.BatchPromptList",
    setup() {
        if (fileDropHookInstalled) return;
        fileDropHookInstalled = true;
        const importFiles = async (node, files) => {
            const additions = (await Promise.all(files.map(file => file.text())))
                .flatMap(value => value.replace(/\r\n?/g, "\n").split("\n").map(line => line.trim()).filter(Boolean));
            node._xzgPromptEntries.push(...additions);
            saveEntries(node);
            renderCards(node);
        };
        const findTarget = event => {
            const canvas = app.canvas, graph = app.graph;
            const point = canvas?.convertEventToCanvas?.(event);
            if (!point || !graph) return null;
            const scale = canvas.ds?.scale || 1, offset = canvas.ds?.offset || [0, 0];
            const x = point[0] / scale - offset[0], y = point[1] / scale - offset[1];
            return [...(graph._nodes || [])].reverse().find(node => node.type === TYPE
                && x >= node.pos[0] && x <= node.pos[0] + node.size[0]
                && y >= node.pos[1] && y <= node.pos[1] + node.size[1]);
        };
        document.addEventListener("dragover", event => {
            const files = [...(event.dataTransfer?.files || [])].filter(file => /\.txt$/i.test(file.name));
            if (!files.length || !findTarget(event)) return;
            event.preventDefault(); event.stopImmediatePropagation();
        }, true);
        document.addEventListener("drop", async event => {
            const files = [...(event.dataTransfer?.files || [])].filter(file => /\.txt$/i.test(file.name));
            if (!files.length) return;
            const node = findTarget(event);
            if (!node) return;
            event.preventDefault(); event.stopImmediatePropagation();
            try { await importFiles(node, files); }
            catch (error) { console.error("[小珠光批次提示词列表] TXT 导入失败", error); }
        }, true);
        window._xzgImportBatchPromptFiles = importFiles;
    },
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== TYPE) return;
        const created = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = created?.apply(this, arguments);
            let source = this.widgets?.find(widget => widget.name === "提示词列表");
            if (source) {
                // Retain its serialized slot without retaining a second DOM
                // textarea: that invisible DOM widget consumed the spare height.
                const original = source;
                const position = this.widgets.indexOf(original);
                original.onRemove?.();
                (original.element || original.inputEl)?.remove?.();
                source = {
                    name: "提示词列表", type: "hidden", value: original.value,
                    hidden: true,
                    computeSize: () => [0, -4], draw() {},
                    serializeValue() { return this.value; },
                };
                this.widgets.splice(position, 1);
            }
            this._xzgPromptDataWidget = source;
            hidePromptDataInput(this);
            this._xzgPromptEntries = parseEntries(source?.value);
            const root = document.createElement("div");
            root.style.cssText = "position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-height:0;overflow:hidden;padding:5px 5px 16px;box-sizing:border-box;background:transparent;border-radius:4px";
            this._xzgPromptRoot = root;
            // 捕获阶段：任何按下（含文本框/按钮）都先同步节点选中
            // （canvas.processSelect 即时刷新 Vue 高亮）。
            root.addEventListener("pointerdown", event => {
                if (event.button === 2) return;
                selectNodeViaCanvas(this, event);
            }, true);
            // 冒泡阶段：文本框/按钮以外的空白区自行接管拖拽——
            // 直接按指针位移更新 node.pos（多选时全部一起移动），
            // 松开或取消时结束并记录一次撤销点。
            root.addEventListener("pointerdown", event => {
                if (event.button === 2) return;
                if (event.target?.closest?.("textarea,button,[data-xzg-no-drag]")) return;
                event.preventDefault();
                const canvas = app.canvas, graph = app.graph;
                if (!graph) return;
                const scale = canvas?.ds?.scale || 1;
                const start = [event.clientX, event.clientY];
                const origins = [...Object.values(graph._selected_nodes || { [this.id]: this })]
                    .map(n => [n, n.pos[0], n.pos[1]]);
                const move = e => {
                    const dx = (e.clientX - start[0]) / scale, dy = (e.clientY - start[1]) / scale;
                    for (const [node, x, y] of origins) node.pos = [x + dx, y + dy];
                    canvas?.setDirty?.(true, true);
                };
                const finish = e => {
                    if (e && (e.clientX !== start[0] || e.clientY !== start[1])) graph.change?.();
                    root.removeEventListener("pointermove", move);
                    root.removeEventListener("pointerup", finish);
                    root.removeEventListener("pointercancel", finish);
                };
                root.setPointerCapture?.(event.pointerId);
                root.addEventListener("pointermove", move);
                root.addEventListener("pointerup", finish);
                root.addEventListener("pointercancel", finish);
            });
            // 滚轮：空白区转发画布缩放；文本框区域由全局捕获优先滚动列表/文本框。
            root.addEventListener("wheel", event => {
                if (event.target?.closest?.("textarea")) return;
                forwardEventToCanvas(event);
            }, { passive: false });
            const widget = this.addDOMWidget("提示词列表", "custom", root, {
                getValue: () => this._xzgPromptDataWidget?.value || "[]",
                setValue: value => {
                    if (this._xzgPromptDataWidget) this._xzgPromptDataWidget.value = value;
                    this._xzgPromptEntries = parseEntries(value);
                    renderCards(this);
                },
                hideOnZoom: false,
                margin: 0,
                getMinHeight: () => 200,
                getHeight: () => "100%",
            });
            // computeSize forces the fixed-size layout branch. Leave it absent
            // so computeLayoutSize receives the node's remaining height, as in
            // the video loader and points editor.
            delete widget.computeSize;
            widget.computeLayoutSize = () => ({ minHeight: 200, minWidth: 0 });
            widget.element = root;
            widget.serialize = true;
            if (widget.options) widget.options.serialize = true;
            renderCards(this);
            saveEntries(this);
            return result;
        };
        const configure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const result = configure?.apply(this, arguments);
            hidePromptDataInput(this);
            this._xzgPromptEntries = parseEntries(this._xzgPromptDataWidget?.value);
            renderCards(this);
            saveEntries(this);
            return result;
        };
        const removed = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            this._xzgClosePromptEditor?.();
            return removed?.apply(this, arguments);
        };
        const drop = nodeType.prototype.onDragDrop;
        nodeType.prototype.onDragDrop = async function (event) {
            const files = [...(event?.dataTransfer?.files || [])].filter(file => /\.txt$/i.test(file.name));
            if (files.length) {
                event.preventDefault?.(); event.stopPropagation?.();
                await window._xzgImportBatchPromptFiles?.(this, files);
                return;
            }
            return drop?.apply(this, arguments);
        };
    },
});

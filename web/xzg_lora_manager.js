import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { ensurePinyin, getPinyin } from "./xzg_pinyin_loader.js";

const TYPE = "XiaozhuguangLoraManager";
const WAN_TYPE = "XiaozhuguangWanLoraManager";
const TYPES = [TYPE, WAN_TYPE];
const HIDDEN_FIELDS = ["loras", "library_user"];
const BASE = "/xzg/lora/";
const SIDEBAR_SETTING = "xiaozhuguang.Toggle.EnableLoraSidebar";
const SIDEBAR_BUTTON = '.xzg-lora-library-tab-button, [data-testid="xzg-lora-library-tab-button"], [data-tab-id="xzg-lora-library"]';
let panel;
let pendingLibrary;

function pruneHiddenInputs(node) {
    for (let index = (node.inputs?.length || 0) - 1; index >= 0; index--) {
        const input = node.inputs[index];
        if (input.link == null && HIDDEN_FIELDS.includes(input.widget?.name || input.name)) {
            node.removeInput(index);
            node._widgetSlotsDirty = true;
        }
    }
}

function switchOutputMode(node, targetType) {
    const graph = node.graph;
    if (!graph) return;
    const replacement = LiteGraph.createNode(targetType);
    if (!replacement) {
        alert("目标 LoRA 节点尚未注册，请重启 ComfyUI 并刷新页面。");
        return;
    }
    replacement.pos = [...node.pos];
    replacement.size = [...node.size];
    replacement.mode = node.mode;
    replacement.flags = { ...node.flags };
    replacement.properties = { ...node.properties };
    if (node.title && node.title !== node.constructor.title) replacement.title = node.title;
    if (node.color) replacement.color = node.color;
    if (node.bgcolor) replacement.bgcolor = node.bgcolor;
    for (const name of HIDDEN_FIELDS) {
        widget(replacement, name).value = widget(node, name).value;
    }
    replacement._xzgLoraMetadata = node._xzgLoraMetadata;
    graph.beforeChange?.();
    try {
        graph.add(replacement);
        if (replacement.graph !== graph) return;
        graph.remove(node);
        replacement._xzgRenderLoras?.();
        graph.setDirtyCanvas?.(true, true);
    } finally {
        graph.afterChange?.();
    }
}

function fetchLibrary() {
    pendingLibrary ??= request("library").then(response => response.json()).finally(() => {
        pendingLibrary = null;
    });
    return pendingLibrary;
}

function managerNodes() {
    return TYPES.flatMap(type => app.graph?.findNodesByType?.(type) || []);
}

function updateNodeLibrary(data, target) {
    const nodes = new Set(managerNodes());
    if (target) nodes.add(target);
    for (const node of nodes) {
        node._xzgLoraMetadata = data.items;
        let list;
        try { list = selection(node); } catch { continue; }
        if (list.some(entry => entry.id && (entry.path || findLoraMetadata(data.items, entry)))) {
            saveSelection(node, list.map(entry => {
                if (!entry.id) return entry;
                const record = findLoraMetadata(data.items, entry);
                if (!record && !entry.path) return entry;
                const { root, path } = record || entry;
                return { root, path, enabled: entry.enabled, strength_model: entry.strength_model };
            }));
        } else {
            node._xzgRenderLoras?.();
        }
    }
}

function findLoraMetadata(items = [], entry) {
    const byId = entry.id && items.find(item => item.id === entry.id);
    if (byId) return byId;
    const matches = items.filter(item => item.path === entry.path && (!entry.root || entry.root === item.root));
    return matches.length === 1 ? matches[0] : undefined;
}

function updateMovedSelections(items, root, source, target) {
    for (const node of managerNodes()) {
        let list;
        try { list = selection(node); } catch { continue; }
        let changed = false;
        for (const entry of list) {
            const record = findLoraMetadata(items, entry);
            if (record?.root !== root || !(record.path === source || record.path.startsWith(source + "/"))) continue;
            entry.root = root;
            entry.path = target + record.path.slice(source.length);
            delete entry.id;
            changed = true;
        }
        if (changed) saveSelection(node, list);
    }
}

function setSidebarEnabled(enabled) {
    document.documentElement.classList.toggle("xzg-hide-lora-sidebar", !enabled);
}

function installCompactToggle(node, actions) {
    const toggle = button("", () => {
        node.properties ||= {};
        const compact = node.properties.xzgLoraCompact !== true;
        node.properties.xzgLoraCompact = compact;
        node.properties.xzgLoraHoverPreview = !compact;
        node._xzgLoraPreview?.remove();
        node._xzgRenderLoras?.();
        node.graph?.change?.();
        node.setDirtyCanvas?.(true, true);
        updateLabel();
    }, actions);
    function updateLabel() {
        const compact = node.properties?.xzgLoraCompact === true;
        toggle.textContent = compact ? "极小化：开" : "极小化：关";
        toggle.setAttribute("aria-pressed", String(compact));
    }
    node._xzgUpdateCompactToggle = updateLabel;
    updateLabel();
    // DOM 按钮位于画布之上，滚轮继续交给画布处理。
    actions.addEventListener("wheel", event => {
        const canvas = app.canvas?.canvas;
        if (!canvas) return;
        event.preventDefault();
        event.stopPropagation();
        canvas.dispatchEvent(new WheelEvent("wheel", {
            deltaX: event.deltaX, deltaY: event.deltaY, deltaZ: event.deltaZ, deltaMode: event.deltaMode,
            clientX: event.clientX, clientY: event.clientY,
            ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, altKey: event.altKey, metaKey: event.metaKey,
            bubbles: true, cancelable: true,
        }));
    }, { passive: false });
    const removed = node.onRemoved;
    node.onRemoved = function () {
        node._xzgLoraPreview?.remove();
        return removed?.apply(this, arguments);
    };
}

function matchesSearch(item, query) {
    const text = [item.path, item.notes, item.tags, item.triggers].join(" ").toLowerCase();
    const unmatched = query.toLowerCase().trim().split(/\s+/).filter(word => word && !text.includes(word));
    if (!unmatched.length) return true;
    const pinyin = getPinyin();
    if (!pinyin || !/[\u3400-\u9fff]/.test(text)) return false;
    const full = pinyin(text, { toneType: "none", separator: "" });
    const syllables = pinyin(text, { toneType: "none" });
    return unmatched.every(word => full.includes(word) || syllables.includes(word));
}

function strengthInput(value, commit) {
    const input = element("input", "xzg-lora-strength");
    input.type = "text";
    input.inputMode = "decimal";
    input.value = String(value);
    let current = value, gesture = null;
    function save() {
        const parsed = Number(input.value);
        if (!input.value.trim() || !Number.isFinite(parsed)) { input.value = String(current); return; }
        current = Math.round(Math.min(10, Math.max(-10, parsed)) * 100) / 100;
        input.value = String(current);
        commit(current);
    }
    input.addEventListener("change", save);
    input.addEventListener("keydown", event => {
        if (event.key === "Enter") { event.preventDefault(); save(); input.blur(); }
        if (event.key === "Escape") { input.value = String(current); input.blur(); }
    });
    input.addEventListener("pointerdown", event => {
        if (event.button !== 0) return;
        event.preventDefault(); event.stopPropagation();
        gesture = { id: event.pointerId, x: event.clientX, value: current, moved: false };
        input.setPointerCapture(event.pointerId);
    });
    input.addEventListener("pointermove", event => {
        if (!gesture || gesture.id !== event.pointerId) return;
        const dx = event.clientX - gesture.x;
        if (!gesture.moved && Math.abs(dx) < 5) return;
        gesture.moved = true;
        const steps = Math.round(dx / 10);
        input.value = String(Math.round(Math.min(10, Math.max(-10, gesture.value + steps * .1)) * 10) / 10);
    });
    function finish(event) {
        if (!gesture || gesture.id !== event.pointerId) return;
        const moved = gesture.moved;
        gesture = null;
        if (input.hasPointerCapture(event.pointerId)) input.releasePointerCapture(event.pointerId);
        if (moved) save();
        else if (event.type === "pointerup") { input.focus(); input.select(); }
    }
    input.addEventListener("pointerup", finish);
    input.addEventListener("pointercancel", finish);
    input.addEventListener("lostpointercapture", finish);
    return input;
}

function confirmClearMaintenance(signal) {
    return new Promise(resolve => {
        const overlay = element("div", "xzg-lora-clear-overlay");
        const dialog = element("section", "xzg-lora-clear-dialog");
        dialog.setAttribute("role", "alertdialog");
        dialog.setAttribute("aria-label", "清理全部 LoRA 维护资料");
        dialog.append(element("strong", "", "警告：清理全部 LoRA 维护资料"),
            element("p", "", "将删除全部备注、标签、触发词、收藏、推荐强度和缩略图。此操作不可撤销，请先按需导出备份。"),
            element("p", "", "LoRA 模型文件与当前加载列表不会删除。"));
        overlay.append(dialog); document.body.append(overlay);
        const actions = element("div", "xzg-lora-clear-actions"); dialog.append(actions);
        let timer;
        const deadline = Date.now() + 5000;
        const finish = value => {
            clearInterval(timer); signal.removeEventListener("abort", cancel);
            overlay.remove(); resolve(value);
        };
        const cancel = () => finish(false);
        const cancelButton = button("取消", cancel, actions);
        const confirmButton = button("", () => { if (Date.now() >= deadline) finish(true); }, actions);
        confirmButton.className = "xzg-lora-danger";
        function tick() {
            const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
            confirmButton.disabled = seconds > 0;
            confirmButton.textContent = seconds ? `确认清理（${seconds} 秒）` : "确认清理全部资料";
        }
        tick(); timer = setInterval(tick, 200);
        overlay.addEventListener("keydown", event => {
            event.stopPropagation();
            if (event.key === "Escape") { event.preventDefault(); cancel(); }
        });
        signal.addEventListener("abort", cancel, { once: true });
        cancelButton.focus();
    });
}

async function request(path, body, method = "POST") {
    const options = body === undefined ? { cache: "no-store" } : { method, body: body instanceof FormData ? body : JSON.stringify(body) };
    if (body !== undefined && !(body instanceof FormData)) options.headers = { "Content-Type": "application/json" };
    const response = await api.fetchApi(BASE + path, options);
    if (!response.ok) {
        if ((response.status === 404 || response.status === 405) && path === "clear-maintenance") {
            throw Error("ComfyUI 后端尚未加载此功能。请完整重启 ComfyUI，再刷新页面；仅刷新浏览器无效。");
        }
        const error = await response.json().catch(() => ({}));
        throw Error(error.error || `请求失败 (${response.status})`);
    }
    return response;
}

function element(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
}

function loadThumbnail(img, item, onError, query = "") {
    img.style.visibility = "hidden";
    img.addEventListener("load", () => { img.style.removeProperty("visibility"); }, { once: true });
    img.addEventListener("error", onError, { once: true });
    img.src = api.apiURL(BASE + "thumbnail/" + item.id + query);
}

function button(text, action, parent) {
    const b = element("button", "", text);
    b.type = "button";
    b.onclick = () => Promise.resolve().then(action).catch(error => alert(error.message));
    parent?.append(b);
    return b;
}

function widget(node, name) { return node.widgets?.find(w => w.name === name); }
function selection(node) {
    const list = JSON.parse(widget(node, "loras").value || "[]");
    if (!Array.isArray(list) || list.some(entry => !entry || typeof entry !== "object" || Array.isArray(entry))) {
        throw Error("LoRA 列表格式无效");
    }
    return list;
}
function serializeSelection(list) {
    return JSON.stringify(list.map(({ id, root, path, enabled, strength_model }) => ({
        id, root, path, enabled, strength_model,
    })));
}
function saveSelection(node, list, activeItem) {
    if (node.properties?.xzgLoraSingle === true) {
        const active = activeItem?.enabled !== false && activeItem ? activeItem : list.find(item => item.enabled !== false);
        for (const item of list) item.enabled = item === active;
    }
    widget(node, "loras").value = serializeSelection(list);
    node._xzgRenderLoras?.();
    node.setDirtyCanvas(true, true);
    app.graph?.change?.();
}

function filePicker(accept, action) {
    const input = element("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => {
        if (input.files[0]) Promise.resolve(action(input.files[0])).catch(error => alert(error.message));
    };
    input.click();
}

function style() {
    if (document.getElementById("xzg-lora-style")) return;
    const s = element("style");
    s.id = "xzg-lora-style";
    s.textContent = `
    .xzg-lora-overlay{position:fixed;inset:0;background:#0009;z-index:12000;color:#ece7df;font:14px/1.5 system-ui}
    .xzg-lora-panel{position:absolute;inset:0;box-sizing:border-box;background:#202124;border:1px solid #64523c;border-radius:0;display:flex;flex-direction:column;min-width:0;overflow:hidden;box-shadow:0 20px 80px #0009;user-select:none;-webkit-user-select:none}
    .xzg-lora-panel input,.xzg-lora-panel textarea,.xzg-lora-panel [contenteditable=true]{user-select:text;-webkit-user-select:text}
    .xzg-lora-titlebar{display:flex;align-items:center;gap:12px;padding:8px 14px;border-bottom:1px solid #494139;flex:none;user-select:none}
    .xzg-lora-titlebar strong{font-size:18px;color:#dfbd8e}
    .xzg-lora-titlebar .xzg-lora-close{margin-left:auto}
    .xzg-lora-panel button,.xzg-lora-stack button{background:#343434;color:#eee;border:1px solid #62605a;border-radius:6px;padding:6px 10px;cursor:pointer}
    .xzg-lora-panel button:hover{border-color:#eee;background:#494139}
    .xzg-lora-panel .xzg-lora-close{color:#ef929d;font-size:16px;font-weight:700}
    .xzg-lora-panel .xzg-lora-tags,.xzg-lora-panel .xzg-lora-tags input{font-size:16px;font-weight:700}
    .xzg-lora-clear-overlay{position:fixed;inset:0;z-index:12005;background:#000a;display:flex;align-items:center;justify-content:center;color:#eee;font:14px/1.6 system-ui;user-select:none}
    .xzg-lora-clear-dialog{width:min(480px,calc(100vw - 40px));padding:24px;background:#252525;border:1px solid #b75e68;border-radius:10px;box-sizing:border-box}
    .xzg-lora-clear-dialog strong{color:#ffb9b9;font-size:18px}
    .xzg-lora-clear-actions{display:flex;gap:12px;justify-content:flex-end}
    .xzg-lora-clear-actions button{padding:8px 14px;background:#343434;color:#eee;border:1px solid #62605a;border-radius:6px;cursor:pointer}
    .xzg-lora-clear-actions .xzg-lora-danger{color:#ffb9b9;border-color:#b75e68}
    .xzg-lora-clear-actions button:disabled{opacity:.4;cursor:default}
    .xzg-lora-panel .xzg-lora-danger{color:#ef929d}
    .xzg-lora-panel .xzg-lora-star{position:absolute;top:9px;right:9px;z-index:1;width:34px;height:34px;padding:5px;border:0;border-radius:50%;background:#141414b3;color:#fff;opacity:0;pointer-events:none}
    .xzg-lora-card:hover .xzg-lora-star,.xzg-lora-card:focus-within .xzg-lora-star{opacity:1;pointer-events:auto}
    .xzg-lora-panel .xzg-lora-star:hover{background:#292929e6}
    .xzg-lora-star svg{display:block;width:24px;height:24px;fill:none;stroke:currentColor;stroke-width:1.8}
    .xzg-lora-panel .xzg-lora-star[aria-pressed=true]{color:#ffd35a}
    .xzg-lora-star[aria-pressed=true] svg{fill:currentColor}
    .xzg-lora-panel input,.xzg-lora-panel select,.xzg-lora-panel textarea{box-sizing:border-box;background:#141517;color:#eee;border:1px solid #555;border-radius:6px;padding:8px;min-width:0}
    .xzg-lora-toolbar{display:flex;gap:8px;padding:12px;border-bottom:1px solid #494139;align-items:center;flex-wrap:wrap;flex:none}
    .xzg-lora-toolbar strong{font-size:18px;color:#dfbd8e;margin-right:auto}
    .xzg-lora-body{display:flex;flex:1;min-height:0;overflow:auto}
    .xzg-lora-sidebar{width:240px;flex:none;overflow:auto;padding:12px;border-right:1px solid #494139;box-sizing:border-box}
    .xzg-lora-sidebar button{display:block;width:100%;text-align:left;overflow-wrap:anywhere;margin:5px 0;white-space:normal}
    .xzg-lora-sidebar .active{border-color:#e1b97d;background:#534433}
    .xzg-lora-folder-row{display:flex;align-items:center;gap:4px}
    .xzg-lora-folder-toggle{width:20px;flex:none;padding:4px 0;pointer-events:none}
    .xzg-lora-folder-toggle svg{display:block;width:18px;height:18px;color:var(--nf-active-bar,#FFD700);transition:transform .15s;pointer-events:none}
    .xzg-lora-folder-toggle[data-expanded=true] svg{transform:rotate(90deg)}
    .xzg-lora-sidebar .xzg-lora-folder-label{flex:1;min-width:0;width:auto}
    .xzg-lora-folder-spacer{width:20px;flex:none}
    .xzg-lora-content{flex:1;min-width:0;overflow:auto;padding:16px}
    .xzg-lora-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:14px;align-items:start}
    .xzg-lora-card{position:relative;height:300px;min-width:0;box-sizing:border-box;display:flex;flex-direction:column;background:#2c2d30;border:1px solid #55504a;border-radius:10px;overflow:hidden;cursor:pointer}
    .xzg-lora-card:hover{border-color:#eee}
    .xzg-lora-image{width:100%;height:170px;flex:none;object-fit:contain;background:#161719;display:block}
    .xzg-lora-placeholder{display:flex;align-items:center;justify-content:center;color:#9f8a71;font-size:30px}
    .xzg-lora-card-info{padding:10px;min-width:0;flex:1;display:flex;flex-direction:column;gap:3px}
    .xzg-lora-card-info>.xzg-lora-name,.xzg-lora-card-info>.xzg-lora-muted{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;overflow-wrap:normal;min-height:18px}
    .xzg-lora-card-info>.xzg-lora-card-tags{font-size:14px;font-weight:700}
    .xzg-lora-tooltip{position:fixed;z-index:12002;pointer-events:none;box-sizing:border-box;padding:12px 14px;background:#151515;color:#eee;border:1px solid #eee;border-radius:6px;overflow-wrap:anywhere;overflow:hidden;box-shadow:0 6px 20px #0008;font-size:13px}
    .xzg-lora-tooltip-name{font-weight:700;color:#eee;white-space:pre-wrap}
    .xzg-lora-tooltip-label{color:#eee;font-size:12px;margin-top:9px}
    .xzg-lora-tooltip-value{white-space:pre-wrap}
    .xzg-lora-name{font-size:15px;font-weight:650;white-space:pre-wrap;overflow-wrap:anywhere}
    .xzg-lora-muted{font-size:12px;color:#b7b1a7;white-space:pre-wrap;overflow-wrap:anywhere}
    .xzg-lora-card-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:auto}
    .xzg-lora-card-actions button{padding:5px 7px;font-size:12px}
    .xzg-lora-panel .xzg-lora-add{flex:1;background:#343434;color:#cda56d;border-color:#62605a;font-size:15px;font-weight:700;padding:7px 12px}
    .xzg-lora-panel .xzg-lora-add:hover{background:#494139;border-color:#eee}
    .xzg-lora-detail{width:320px;flex:none;border-left:1px solid #494139;overflow:auto;padding:14px;box-sizing:border-box}
    .xzg-lora-detail label{display:block;margin:10px 0;color:#ccc}
    .xzg-lora-detail input:not([type=checkbox]),.xzg-lora-detail textarea{width:100%;margin-top:4px}
    .xzg-lora-detail textarea{min-height:90px;resize:vertical}
    .xzg-lora-status{padding:7px 26px 7px 14px;border-top:1px solid #494139;color:#bdb6ac;overflow-wrap:anywhere;max-height:64px;overflow:auto;flex:none}
    .xzg-lora-stack{font:12px system-ui;color:#eee;overflow:auto;padding:6px;box-sizing:border-box;background:#252525;width:100%;height:100%}
    .xzg-lora-node-actions{display:flex;gap:5px;align-items:center;box-sizing:border-box;width:100%;height:100%;padding:2px 6px;font:12px system-ui}
    .xzg-lora-node-actions button{flex:1;min-width:max-content;white-space:nowrap;background:#343434;color:#eee;border:1px solid #62605a;border-radius:4px;padding:5px 8px;cursor:pointer}
    .xzg-lora-node-actions button:hover{border-color:#eee}
    .xzg-lora-stack-row{padding:8px 0;overflow-wrap:anywhere;white-space:normal;cursor:pointer}
    .xzg-lora-stack-row:not(:last-child){border-bottom:1px solid #555}
    .xzg-lora-stack-row>.xzg-lora-name{cursor:inherit;user-select:none;font-size:12px;font-weight:400;line-height:1.4}
    .xzg-lora-stack-row.xzg-lora-has-thumbnail{display:grid;grid-template-columns:minmax(0,1fr) 50px;column-gap:8px;align-items:center;min-height:50px}
    .xzg-lora-has-thumbnail>.xzg-lora-name{grid-column:1;grid-row:1}
    .xzg-lora-has-thumbnail>.xzg-lora-stack-controls{grid-column:1;grid-row:2}
    .xzg-lora-has-thumbnail>.xzg-lora-row-thumbnail{grid-column:2;grid-row:1 / 3;width:50px;height:50px;object-fit:contain;align-self:center}
    .xzg-lora-stack-row.xzg-lora-dragging{opacity:.4;cursor:grabbing}
    .xzg-lora-stack-row.xzg-lora-drop-before{box-shadow:inset 0 2px #cda56d}
    .xzg-lora-stack-row.xzg-lora-drop-after{box-shadow:inset 0 -2px #cda56d}
    .xzg-lora-stack .xzg-lora-icon{width:28px;height:28px;padding:4px;display:inline-flex;align-items:center;justify-content:center}
    .xzg-lora-stack .xzg-lora-remove{color:#ff8585;font-size:22px;line-height:1}
    .xzg-lora-stack .xzg-lora-remove:hover{color:#ffb3b3;border-color:#cf6875;background:#532a30}
    .xzg-lora-stack .xzg-lora-copy,.xzg-lora-stack .xzg-lora-icon{border:0;background:transparent;box-shadow:none}
    .xzg-lora-stack .xzg-lora-copy{height:26px;padding:2px 4px;display:inline-flex;align-items:center;justify-content:center;line-height:1}
    .xzg-lora-stack .xzg-lora-copy:disabled{opacity:.45;cursor:default}
    .xzg-lora-stack .xzg-lora-icon{width:24px;height:26px;padding:3px}
    .xzg-lora-stack .xzg-lora-copy+.xzg-lora-icon,.xzg-lora-stack .xzg-lora-icon+.xzg-lora-icon{margin-left:-3px}
    .xzg-lora-stack-controls{display:flex;gap:6px;align-items:center;flex-wrap:nowrap;width:100%;margin-top:6px;white-space:nowrap}
    .xzg-lora-stack-controls>*{flex-shrink:0}
    .xzg-lora-stack .xzg-lora-strength{box-sizing:border-box;width:44px;text-align:center;background:#151515;color:#eee;border:1px solid #666;border-radius:3px;padding:3px 5px;outline:none;box-shadow:none;cursor:ew-resize;touch-action:none}
    .xzg-lora-stack .xzg-lora-strength:focus{border:1px solid #bbb;outline:none;box-shadow:none}
    .xzg-lora-stack-row{color:#eee}
    .xzg-lora-stack-row .xzg-lora-copy,.xzg-lora-stack-row .xzg-lora-icon,.xzg-lora-stack-row .xzg-lora-strength{color:inherit}
    .xzg-lora-stack-row .xzg-lora-remove{color:#ff8585}
    .xzg-lora-stack-row .xzg-lora-remove:hover{color:#ffb3b3}
    .xzg-lora-stack-controls input[type=checkbox]{accent-color:#cda56d}
    .xzg-lora-stack-row.xzg-lora-disabled{color:#777}
    .xzg-lora-stack-row.xzg-lora-disabled .xzg-lora-strength{background:#202020;border-color:#444}
    .xzg-lora-stack-row.xzg-lora-disabled img{opacity:.4;filter:grayscale(1)}
    .xzg-lora-stack.xzg-lora-compact{padding:2px 6px}
    .xzg-lora-stack.xzg-lora-compact .xzg-lora-stack-row{display:flex;align-items:center;gap:4px;box-sizing:border-box;height:20px;min-height:20px;margin:0;padding:0;white-space:nowrap}
    .xzg-lora-stack.xzg-lora-compact .xzg-lora-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .xzg-lora-stack.xzg-lora-compact .xzg-lora-stack-controls{flex:0 0 auto;width:auto;margin:0;gap:4px}
    .xzg-lora-stack.xzg-lora-compact .xzg-lora-strength{height:18px;min-height:0;margin:0;padding:0 3px;font:12px/16px system-ui}
    .xzg-lora-stack.xzg-lora-compact .xzg-lora-remove{box-sizing:border-box;width:18px;height:18px;min-height:0;margin:0;padding:1px}
    .xzg-lora-stack.xzg-lora-compact .xzg-lora-remove svg{width:14px;height:14px}
    .xzg-lora-stack.xzg-lora-compact .xzg-lora-row-thumbnail,
    .xzg-lora-stack.xzg-lora-compact .xzg-lora-stack-controls>span,
    .xzg-lora-stack.xzg-lora-compact .xzg-lora-stack-controls>input[type=checkbox],
    .xzg-lora-stack.xzg-lora-compact .xzg-lora-copy,
    .xzg-lora-stack.xzg-lora-compact .xzg-lora-icon:not(.xzg-lora-remove){display:none}
    .xzg-lora-node-actions.xzg-lora-compact button{padding:2px 4px;font-size:10px}
    @media(max-width:950px){.xzg-lora-sidebar{width:180px}.xzg-lora-detail{width:260px}}
    `;
    document.head.append(s);
}

async function openManager(node) {
    style();
    if (panel && !panel.close()) return;
    const overlay = element("div", "xzg-lora-overlay");
    const container = element("section", "xzg-lora-panel");
    container.setAttribute("role", "dialog");
    container.setAttribute("aria-label", "小珠光 LoRA 管理器");
    overlay.append(container);
    const titleBar = element("div", "xzg-lora-titlebar");
    titleBar.append(element("strong", "", "小珠光 · LoRA 管理器"));
    const toolbar = element("div", "xzg-lora-toolbar");
    container.append(titleBar, toolbar);
    const search = element("input"); search.placeholder = "搜索名称、标签或拼音，空格分隔多个词"; search.style.width = "340px";
    toolbar.append(search);
    const tag = element("select", "xzg-lora-tags"); toolbar.append(tag);
    const body = element("div", "xzg-lora-body");
    const sidebar = element("aside", "xzg-lora-sidebar");
    const content = element("main", "xzg-lora-content");
    const detail = element("aside", "xzg-lora-detail");
    const status = element("div", "xzg-lora-status", "正在读取本地 LoRA…");
    status.setAttribute("role", "status");
    body.append(sidebar, content, detail); container.append(body, status);
    let data, folder = null, favorites = false, active = null, dirty = false;
    const expandedFolders = new Set();
    const controller = new AbortController();
    window.addEventListener("keydown", event => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a" &&
            !event.target.closest?.("input,textarea,[contenteditable=true]")) {
            event.preventDefault(); event.stopImmediatePropagation();
        }
    }, { capture: true, signal: controller.signal });
    const tooltip = element("div", "xzg-lora-tooltip");
    tooltip.hidden = true;
    tooltip.setAttribute("role", "tooltip");
    overlay.append(tooltip);
    function placeTooltip(card) {
        const r = card.getBoundingClientRect(), gap = 10, margin = 8;
        const zones = [
            { left: r.right + gap, top: margin, width: innerWidth - r.right - gap - margin, height: innerHeight - margin * 2, rightSide: true },
            { left: margin, top: margin, width: r.left - gap - margin, height: innerHeight - margin * 2, leftSide: true },
            { left: margin, top: r.bottom + gap, width: innerWidth - margin * 2, height: innerHeight - r.bottom - gap - margin },
            { left: margin, top: margin, width: innerWidth - margin * 2, height: r.top - gap - margin, above: true },
        ].filter(zone => zone.width >= 140 && zone.height >= 60);
        let chosen, bestArea = -1;
        for (const zone of zones) {
            tooltip.style.width = `${Math.min(380, zone.width)}px`;
            tooltip.style.maxHeight = "none";
            const height = tooltip.getBoundingClientRect().height;
            const area = Math.min(380, zone.width) * Math.min(height, zone.height);
            if (area > bestArea) { bestArea = area; chosen = zone; }
            if (height <= zone.height && zone.width >= 280) { chosen = zone; break; }
        }
        if (!chosen) { tooltip.hidden = true; return; }
        const width = Math.min(380, chosen.width);
        tooltip.style.width = `${width}px`;
        tooltip.style.maxHeight = `${chosen.height}px`;
        const height = tooltip.getBoundingClientRect().height;
        const side = chosen.rightSide || chosen.leftSide;
        const left = chosen.leftSide ? r.left - gap - width : side ? chosen.left : Math.max(margin, Math.min(r.left, innerWidth - margin - width));
        const top = chosen.above ? r.top - gap - height : side ? Math.max(margin, Math.min(r.top, innerHeight - margin - height)) : chosen.top;
        tooltip.style.left = `${left}px`;
        tooltip.style.top = `${top}px`;
    }
    content.addEventListener("scroll", () => { tooltip.hidden = true; }, { passive: true });
    function mayDiscard() { return !dirty || confirm("详情中有尚未保存的修改，是否放弃？"); }
    function close() {
        if (!mayDiscard()) return false;
        controller.abort(); overlay.remove(); panel = null; return true;
    }
    panel = { close };
    button("刷新", () => reload(), toolbar);
    button("清理全部维护资料", async () => {
        if (!await confirmClearMaintenance(controller.signal)) return;
        await request("clear-maintenance", { confirm: true });
        dirty = false; active = null;
        await reload();
        status.textContent = "全部维护资料与缩略图已清理，LoRA 文件及加载列表已保留";
    }, titleBar).className = "xzg-lora-danger";
    button("关闭", close, titleBar).className = "xzg-lora-close";
    overlay.addEventListener("keydown", e => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
    document.body.append(overlay);
    search.oninput = renderCards; tag.onchange = renderCards;

    async function reload() {
        data = await (await request("library")).json();
        if (!overlay.isConnected) return;
        updateNodeLibrary(data, node);
        const oldTag = tag.value; tag.replaceChildren();
        for (const t of ["", ...new Set(data.items.flatMap(x => (x.tags || "").split(/[,，]/).map(v => v.trim()).filter(Boolean)))].sort()) {
            const option = element("option", "", t || "全部标签"); option.value = t; tag.append(option);
        }
        tag.value = oldTag; if (tag.selectedIndex < 0) tag.selectedIndex = 0;
        renderFolders(); renderCards();
        if (active && !dirty) edit(data.items.find(x => x.id === active));
        if (!active) detail.textContent = "点击卡片编辑资料，拖动卡片到左侧文件夹可移动文件。";
        status.textContent = `共 ${data.items.length} 个 LoRA · 资料位置：${data.storage} · 资料和缩略图请从画布上方小珠光 Logo 设置统一导入导出`;
    }

    function chooseFolder(value, fav = false) {
        folder = value; favorites = fav; renderFolders(); renderCards();
    }
    let folderMenu = null;
    function closeFolderMenu() {
        folderMenu?.abort(); folderMenu = null;
    }
    controller.signal.addEventListener("abort", closeFolderMenu, { once: true });
    async function renameFolder(directory) {
        const oldName = directory.path.split("/").pop();
        const name = prompt("新的文件夹名称", oldName);
        if (!name || name === oldName) return;
        if (/[\\/:]/.test(name) || name === "." || name === "..") throw Error("请输入有效的文件夹名称");
        const target = directory.path.split("/").slice(0, -1).concat(name).join("/");
        if (!confirm("这会重命名磁盘上的真实文件夹。其他加载器保存的旧路径可能失效。继续？")) return;
        await request("files", { action: "move", root: directory.root, path: directory.path, target });
        updateMovedSelections(data.items, directory.root, directory.path, target);
        if (folder?.root === directory.root && (folder.path === directory.path || folder.path.startsWith(directory.path + "/"))) {
            folder = { ...folder, path: target + folder.path.slice(directory.path.length) };
        }
        await reload();
    }
    function showFolderMenu(event, directory) {
        event.preventDefault(); event.stopPropagation(); closeFolderMenu();
        const menu = element("div", "xzg-lora-folder-menu");
        menu.style.cssText = "position:fixed;z-index:12001;background:#252525;border:1px solid #786348;border-radius:6px;padding:5px;box-shadow:0 6px 24px #0008";
        menu.setAttribute("role", "menu");
        const abort = new AbortController(); folderMenu = abort;
        abort.signal.addEventListener("abort", () => menu.remove(), { once: true });
        const rename = button("重命名文件夹", () => { closeFolderMenu(); return renameFolder(directory); }, menu);
        rename.setAttribute("role", "menuitem");
        rename.disabled = !directory.path;
        if (rename.disabled) rename.title = "LoRA 根目录不能重命名";
        overlay.append(menu);
        const rect = menu.getBoundingClientRect();
        menu.style.left = `${Math.max(0, Math.min(event.clientX, innerWidth - rect.width))}px`;
        menu.style.top = `${Math.max(0, Math.min(event.clientY, innerHeight - rect.height))}px`;
        document.addEventListener("pointerdown", e => { if (!menu.contains(e.target)) closeFolderMenu(); }, { capture: true, signal: abort.signal });
        document.addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeFolderMenu(); } }, { capture: true, signal: abort.signal });
        rename.focus();
    }
    function renderFolders() {
        closeFolderMenu();
        const scrollTop = sidebar.scrollTop;
        sidebar.replaceChildren();
        button("全部 LoRA", () => chooseFolder(null), sidebar);
        button(`★ 收藏 (${data.items.filter(item => item.favorite).length})`, () => chooseFolder(null, true), sidebar);
        sidebar.append(element("p", "xzg-lora-muted", "真实目录 · 右键文件夹可重命名 · 可将卡片拖到文件夹"));
        const children = new Map();
        const folderKey = (root, path) => JSON.stringify([root, path]);
        const counts = new Map();
        for (const item of data.items) {
            const parts = item.path.split("/");
            parts.pop();
            while (parts.length) {
                const key = folderKey(item.root, parts.join("/"));
                counts.set(key, (counts.get(key) || 0) + 1);
                parts.pop();
            }
        }
        for (const directory of data.directories) {
            if (!directory.path) continue;
            const parent = directory.path.split("/").slice(0, -1).join("/");
            const key = folderKey(directory.root, parent);
            if (!children.has(key)) children.set(key, []);
            children.get(key).push(directory);
        }
        function renderDirectory(directory, depth) {
            const key = folderKey(directory.root, directory.path);
            const descendants = children.get(key) || [];
            const row = element("div", "xzg-lora-folder-row");
            row.style.paddingLeft = `${depth * 16}px`;
            sidebar.append(row);
            const activate = () => {
                const expanding = descendants.length && !expandedFolders.has(key);
                expandedFolders.clear();
                const parts = directory.path.split("/");
                for (let i = 1; i < parts.length; i++) {
                    expandedFolders.add(folderKey(directory.root, parts.slice(0, i).join("/")));
                }
                if (expanding) expandedFolders.add(key);
                chooseFolder(directory);
            };
            if (descendants.length) {
                const expanded = expandedFolders.has(key);
                const toggle = element("span", "xzg-lora-folder-toggle");
                row.append(toggle);
                toggle.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>';
                toggle.setAttribute("aria-hidden", "true");
                toggle.dataset.expanded = String(expanded);
            } else row.append(element("span", "xzg-lora-folder-spacer"));
            const b = button(`📁 ${directory.path.split("/").pop()} (${counts.get(key) || 0})`, activate, row);
            b.className = "xzg-lora-folder-label";
            if (descendants.length) b.setAttribute("aria-expanded", String(expandedFolders.has(key)));
            b.title = directory.path;
            b.oncontextmenu = event => showFolderMenu(event, directory);
            if (folder?.root === directory.root && folder?.path === directory.path) b.classList.add("active");
            b.ondragover = e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; };
            b.ondrop = e => {
                e.preventDefault();
                const id = e.dataTransfer.getData("application/x-xzg-lora");
                if (id) moveItems([id], directory).catch(error => alert(error.message));
            };
            if (expandedFolders.has(key)) {
                for (const child of descendants) renderDirectory(child, depth + 1);
            }
        }
        for (const directory of data.directories) {
            if (directory.path && !directory.path.includes("/")) renderDirectory(directory, 0);
        }
        sidebar.scrollTop = scrollTop;
    }

    async function moveItems(ids, directory) {
        if (!mayDiscard()) return;
        const items = ids.map(id => data.items.find(x => x.id === id)).filter(Boolean);
        if (items.some(x => x.root !== directory.root)) throw Error("当前仅支持同一个 LoRA 根目录内移动");
        if (!confirm(`将 ${items.length} 个 LoRA 文件移动到 ${directory.path || directory.root}？其他加载器的旧路径可能失效。`)) return;
        try {
            for (const item of items) {
                const target = [directory.path, item.path.split("/").pop()].filter(Boolean).join("/");
                if (target === item.path) continue;
                await request("files", { action: "move", root: item.root, path: item.path, target });
                updateMovedSelections(data.items, item.root, item.path, target);
            }
        } finally { dirty = false; await reload(); }
    }

    function renderCards() {
        if (!data) return;
        tooltip.hidden = true;
        content.replaceChildren();
        const grid = element("div", "xzg-lora-grid"); content.append(grid);
        const addedIds = new Set(node ? selection(node).map(item => findLoraMetadata(data.items, item)?.id) : []);
        const query = search.value;
        const items = data.items.filter(x => (!folder || x.root === folder.root && (x.path.startsWith(folder.path ? folder.path + "/" : ""))) &&
            (!favorites || x.favorite) &&
            (!tag.value || (x.tags || "").split(/[,，]/).map(v => v.trim()).includes(tag.value)) &&
            matchesSearch(x, query));
        items.sort((a, b) => a.path.split("/").pop().localeCompare(b.path.split("/").pop(), "zh-CN"));
        for (const item of items) {
            const card = element("article", "xzg-lora-card"); card.draggable = item.exists;
            card.ondragstart = e => { tooltip.hidden = true; e.dataTransfer.setData("application/x-xzg-lora", item.id); };
            card.onpointerenter = () => {
                tooltip.replaceChildren(element("div", "xzg-lora-tooltip-name", item.path.split("/").pop()));
                for (const [label, value] of [["标签", item.tags], ["备注 / 使用心得", item.notes], ["触发词", item.triggers]]) {
                    tooltip.append(element("div", "xzg-lora-tooltip-label", label), element("div", "xzg-lora-tooltip-value", value?.trim() || "未填写"));
                }
                tooltip.hidden = false; placeTooltip(card);
            };
            card.onpointerleave = () => { tooltip.hidden = true; };
            card.onclick = () => { if (mayDiscard()) edit(item); };
            if (item.thumbnail) {
                const img = element("img", "xzg-lora-image"); img.loading = "lazy"; img.alt = item.path;
                loadThumbnail(img, item, () => {
                    img.replaceWith(element("div", "xzg-lora-image xzg-lora-placeholder", "LoRA"));
                }, "?v=" + (item._thumbnailVersion || "1"));
                card.append(img);
            } else card.append(element("div", "xzg-lora-image xzg-lora-placeholder", "LoRA"));
            const info = element("div", "xzg-lora-card-info");
            info.append(element("div", "xzg-lora-name", item.path.split("/").pop()));
            if (item.tags) info.append(element("div", "xzg-lora-muted xzg-lora-card-tags", item.tags));
            const controls = element("div", "xzg-lora-card-actions"); controls.onclick = e => e.stopPropagation();
            const added = addedIds.has(item.id);
            const addButton = button(added ? "已添加" : "添加 LoRA", () => {
                if (add(item) === false || !overlay.isConnected) return;
                renderCards();
            }, controls);
            addButton.className = "xzg-lora-add";
            addButton.disabled = !item.exists || added;
            const favoriteButton = button("", async () => {
                const next = !item.favorite;
                favoriteButton.disabled = true;
                try {
                    await request("metadata", { id: item.id, favorite: next });
                    item.favorite = next;
                    renderFolders(); renderCards();
                    status.textContent = `${next ? "已添加到收藏夹" : "已取消收藏"}：${item.path.split("/").pop()}`;
                } finally {
                    favoriteButton.disabled = false;
                }
            }, card);
            favoriteButton.className = "xzg-lora-star";
            favoriteButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path stroke-linejoin="round" d="m12 2.5 2.94 5.96 6.58.96-4.76 4.64 1.12 6.55L12 17.52l-5.88 3.09 1.12-6.55L2.48 9.42l6.58-.96Z"/></svg>';
            favoriteButton.setAttribute("aria-label", item.favorite ? "取消收藏" : "收藏");
            favoriteButton.addEventListener("click", event => event.stopPropagation());
            favoriteButton.setAttribute("aria-pressed", String(!!item.favorite));
            button("打开目录", async () => {
                await request("open-directory", { id: item.id });
            }, controls);
            info.append(controls); card.append(info); grid.append(card);
        }
        if (!items.length) grid.append(element("p", "", "没有符合条件的 LoRA"));
    }

    function add(item) {
        if (!node) {
            node = LiteGraph.createNode(TYPE);
            if (!node) throw Error("节点尚未注册，请重启 ComfyUI 并刷新页面");
            node.pos = app.canvas.graph_mouse ? [...app.canvas.graph_mouse] : [100, 100];
            if (!node.pos?.every(Number.isFinite)) node.pos = [100, 100];
            app.graph.add(node);
        }
        node._xzgLoraMetadata = data.items;

        const list = selection(node);
        if (list.some(x => findLoraMetadata(data.items, x)?.id === item.id)) { status.textContent = "该 LoRA 已在当前加载器中"; return; }
        list.push({ root: item.root, path: item.path, enabled: true,
            strength_model: item.strength_model ?? 1 });
        saveSelection(node, list, list[list.length - 1]); status.textContent = `已添加：${item.path.split("/").pop()} · 共 ${list.length} 个 LoRA`;

    }

    function edit(item) {
        if (!item) { active = null; detail.replaceChildren(); return; }
        active = item.id; dirty = false; detail.replaceChildren();
        detail.append(element("div", "xzg-lora-name", item.path.split("/").pop()));
        const thumbnailPreview = element("div");
        detail.append(thumbnailPreview);
        const uploadThumbnail = button("上传 / 替换缩略图", () => filePicker("image/*", async file => {
            const form = new FormData(); form.append("file", file);
            await changeThumbnail(() => request("thumbnail/" + item.id, form), true);
        }), detail);
        const deleteThumbnail = button("删除缩略图", () => changeThumbnail(
            () => request("thumbnail/" + item.id + "/delete", {}), false
        ), detail);
        deleteThumbnail.className = "xzg-lora-danger";
        function renderThumbnail(record) {
            thumbnailPreview.replaceChildren();
            deleteThumbnail.hidden = !record.thumbnail;
            if (record.thumbnail) {
                const image = element("img", "xzg-lora-image");
                loadThumbnail(image, record, () => image.remove(), "?v=" + Date.now());
                thumbnailPreview.append(image);
            }
        }
        async function changeThumbnail(save, hasThumbnail) {
            if (uploadThumbnail.disabled) return;
            uploadThumbnail.disabled = deleteThumbnail.disabled = true;
            try {
                await save();
                const record = data.items.find(entry => entry.id === item.id) || item;
                record.thumbnail = hasThumbnail;
                record._thumbnailVersion = Date.now();
                renderThumbnail(record);
                updateNodeLibrary(data, node);
                renderCards();
                status.textContent = hasThumbnail ? "缩略图已保存" : "缩略图已删除";
            } finally {
                uploadThumbnail.disabled = deleteThumbnail.disabled = false;
            }
        }
        renderThumbnail(item);
        const fields = {};
        for (const [key, label, type] of [["tags", "标签（用逗号分隔）", "text"], ["notes", "备注 / 使用心得", "textarea"], ["triggers", "触发词", "textarea"],
            ["strength_model", "推荐模型强度", "number"]]) {
            const labelElement = element("label", "", label);
            if (key === "tags") labelElement.className = "xzg-lora-tags";
            const input = element(type === "textarea" ? "textarea" : "input");
            if (type !== "textarea") input.type = type;
            if (type === "number") input.step = "0.05";
            input.value = item[key] ?? (type === "number" ? 1 : "");
            input.oninput = () => { dirty = true; }; fields[key] = input; labelElement.append(input); detail.append(labelElement);
        }
        button("保存资料", async () => {
            const values = { id: item.id };
            for (const [key, input] of Object.entries(fields)) {
                if (!input.reportValidity()) return;
                values[key] = input.type === "number" ? Number(input.value) : input.value;
            }
            await request("metadata", values); dirty = false; await reload(); status.textContent = "资料已保存";
        }, detail);
    }
    ensurePinyin().then(() => {
        if (overlay.isConnected && search.value.trim()) renderCards();
    }).catch(() => {});
    await reload(); search.focus();
}

function getNodeMenuItems(node) {
    if (!TYPES.includes(node?.type)) return [];
    const targetType = node.type === WAN_TYPE ? TYPE : WAN_TYPE;
    const label = targetType === WAN_TYPE ? "Wan（WANVIDLORA）" : "普通（MODEL）";
    const connected = node.inputs?.some(input => input.link != null)
        || node.outputs?.some(output => output.links?.length);
    return [{
        content: `切换 LoRA 接口 → ${label}${connected ? "（断开当前连线）" : ""}`,
        color: "#FFD700",
        callback: () => switchOutputMode(node, targetType),
    }];
}

app.registerExtension({
    name: "Xiaozhuguang.LoraManager",
    getNodeMenuItems,
    setup() {
        style();
        const sidebarIcon = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/></svg>')}")`;
        const sidebarStyle = element("style");
        sidebarStyle.textContent = `
            .xzg-lora-sidebar-icon {
                display: inline-block; width: 1.4rem; height: 1.4rem;
                background: currentColor;
                -webkit-mask: ${sidebarIcon} center / contain no-repeat;
                mask: ${sidebarIcon} center / contain no-repeat;
            }
            .xzg-hide-lora-sidebar .xzg-lora-library-tab-button,
            .xzg-hide-lora-sidebar [data-testid="xzg-lora-library-tab-button"],
            .xzg-hide-lora-sidebar [data-tab-id="xzg-lora-library"] { display: none !important; }
        `;
        document.head.append(sidebarStyle);
        app.ui.settings.addSetting({
            id: SIDEBAR_SETTING,
            name: "[小珠光] 显示「LoRA 管理器」侧栏入口",
            tooltip: "关闭后隐藏左侧图标，仅通过小珠光 LoRA 管理器节点打开管理器。",
            type: "boolean",
            defaultValue: false,
            onChange: value => setSidebarEnabled(value === true),
        });
        setSidebarEnabled(app.ui.settings.getSettingValue(SIDEBAR_SETTING) === true);
        document.addEventListener("click", event => {
            if (!event.target.closest?.(SIDEBAR_BUTTON)) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            if (app.ui.settings.getSettingValue(SIDEBAR_SETTING) === true) openManager();
        }, true);
        app.extensionManager.registerSidebarTab({ id: "xzg-lora-library", icon: "xzg-lora-sidebar-icon", title: "LoRA", tooltip: "LoRA",
            type: "custom", render: el => el.replaceChildren() });
    },
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!TYPES.includes(nodeData.name)) return;
        if (nodeData.name === WAN_TYPE) nodeType.skip_list = true;
        const original = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            original?.apply(this, arguments);
            for (const name of HIDDEN_FIELDS) {
                const w = widget(this, name);
                if (!w) continue;
                // Keep the value for workflow serialization and prompt submission.
                // Older canvas widgets can still call their own renderer after a type change.
                w.type = "hidden";
                w.hidden = true;
                w.draw = () => {};
                w.mouse = () => false;
                w.computeSize = () => [0, -4];
                w.computeLayoutSize = () => ({ minHeight: 0, maxHeight: 0, minWidth: 0 });
                if (w.inputEl) w.inputEl.style.setProperty("display", "none", "important");
            }
            pruneHiddenInputs(this);
            const actions = element("div", "xzg-lora-node-actions");
            button("打开 LoRA 管理器", () => openManager(this), actions);
            const modeToggle = button("", () => {
                this.properties ||= {};
                this.properties.xzgLoraSingle = this.properties.xzgLoraSingle !== true;
                saveSelection(this, selection(this));
            }, actions);
            modeToggle.setAttribute("aria-label", "单/多 LoRA");
            installCompactToggle(this, actions);
            const actionsHeight = () => this.properties?.xzgLoraCompact === true ? 26 : 36;
            const actionsWidget = this.addDOMWidget("lora_actions", "div", actions, {
                serialize: false,
                margin: 3,
                getMinHeight: actionsHeight,
                getMaxHeight: actionsHeight,
                getHeight: actionsHeight,
            });
            actionsWidget.computeLayoutSize = () => ({
                minHeight: actionsHeight(), maxHeight: actionsHeight(), minWidth: 0,
            });
            const stack = element("div", "xzg-lora-stack");
            const rows = element("div");
            stack.append(rows);
            stack.addEventListener("wheel", event => {
                const canvas = app.canvas?.canvas;
                if (!canvas) return;
                event.preventDefault();
                event.stopPropagation();
                canvas.dispatchEvent(new WheelEvent("wheel", {
                    deltaX: event.deltaX, deltaY: event.deltaY, deltaZ: event.deltaZ, deltaMode: event.deltaMode,
                    clientX: event.clientX, clientY: event.clientY,
                    ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, altKey: event.altKey, metaKey: event.metaKey,
                    bubbles: true, cancelable: true,
                }));
            }, { capture: true, passive: false });
            const stackMargin = 3;
            let stackHeight = 40 + 2 * stackMargin;
            const stackWidget = this.addDOMWidget("lora_stack", "div", stack, {
                serialize: false,
                margin: stackMargin,
                getMinHeight: () => stackHeight,
                getMaxHeight: () => stackHeight,
                getHeight: () => stackHeight,
            });
            stackWidget.computeLayoutSize = () => ({ minHeight: stackHeight, maxHeight: stackHeight, minWidth: 0 });
            // The properties panel shares these widgets with the canvas and writes its own row width.
            const node = this;
            for (const domWidget of [actionsWidget, stackWidget]) {
                Object.defineProperty(domWidget, "width", {
                    configurable: true,
                    get() { return node.size?.[0] || 0; },
                    set(_) {},
                });
            }
            // Keep the DOM layout's minimum widget heights and trim its default bottom allowance.
            this._xzgLoraHeight = () => this.computeSize()[1] - 8;
            const fitSize = () => {
                if (!rows.isConnected || !rows.offsetWidth) return;
                const compact = this.properties?.xzgLoraCompact === true;
                const padding = compact ? 4 : 12;
                actions.style.width = "max-content";
                this._xzgLoraMinWidth = Math.max(compact ? 300 : 380, actions.offsetWidth + 2 * actionsWidget.margin);
                actions.style.width = "";
                // ComfyUI insets DOM widgets by their margin on both edges.
                stackHeight = Math.max(40, rows.offsetHeight + padding) + 2 * stackMargin;
                const width = Math.max(this.size[0], this._xzgLoraMinWidth);
                const height = this._xzgLoraHeight();
                if (this.size[0] !== width || this.size[1] !== height) {
                    this.setSize([width, height]);
                    this.setDirtyCanvas(true, true);
                }
            };
            const observer = new ResizeObserver(fitSize);
            observer.observe(rows);
            const added = this.onAdded;
            this.onAdded = function () {
                added?.apply(this, arguments);
                observer.observe(rows);
            };
            const removed = this.onRemoved;
            this.onRemoved = function () {
                observer.disconnect();
                removed?.apply(this, arguments);
            };
            this._xzgRenderLoras = () => {
                const single = this.properties?.xzgLoraSingle === true;
                modeToggle.textContent = single ? "单 LoRA" : "多 LoRA";
                modeToggle.setAttribute("aria-pressed", String(single));
                this._xzgUpdateCompactToggle?.();
                const compact = this.properties?.xzgLoraCompact === true;
                stack.classList.toggle("xzg-lora-compact", compact);
                actions.classList.toggle("xzg-lora-compact", compact);
                this._xzgLoraPreview?.remove();
                rows.replaceChildren();
                requestAnimationFrame(fitSize);
                let list;
                try { list = selection(this); } catch { rows.textContent = "LoRA 列表格式无效，请检查 loras 数据"; return; }
                if (!list.length) rows.textContent = "尚未选择 LoRA，请打开管理器添加。";
                let draggedIndex = null;
                const clearDropMarks = () => {
                    for (const row of rows.children) row.classList.remove("xzg-lora-drop-before", "xzg-lora-drop-after");
                };
                list.forEach((item, index) => {
                    const row = element("div", "xzg-lora-stack-row");
                    row.classList.toggle("xzg-lora-disabled", item.enabled === false);
                    row.draggable = true;
                    row.ondragstart = event => {
                        if (event.target.closest(".xzg-lora-stack-controls")) { event.preventDefault(); return; }
                        event.stopPropagation();
                        draggedIndex = index;
                        event.dataTransfer.setData("text/plain", item.path || "");
                        event.dataTransfer.effectAllowed = "move";
                        row.classList.add("xzg-lora-dragging");
                    };
                    row.ondragover = event => {
                        if (draggedIndex === null || draggedIndex === index) return;
                        event.preventDefault(); event.stopPropagation(); clearDropMarks();
                        const rect = row.getBoundingClientRect();
                        row.classList.add(event.clientY < rect.top + rect.height / 2 ? "xzg-lora-drop-before" : "xzg-lora-drop-after");
                        event.dataTransfer.dropEffect = "move";
                    };
                    row.ondrop = event => {
                        if (draggedIndex === null || draggedIndex === index) return;
                        event.preventDefault(); event.stopPropagation();
                        const from = draggedIndex;
                        const rect = row.getBoundingClientRect();
                        let to = index + (event.clientY >= rect.top + rect.height / 2 ? 1 : 0);
                        const [moving] = list.splice(from, 1);
                        if (from < to) to--;
                        list.splice(to, 0, moving);
                        draggedIndex = null; saveSelection(this, list);
                    };
                    row.ondragend = () => { draggedIndex = null; row.classList.remove("xzg-lora-dragging"); clearDropMarks(); };
                    const info = findLoraMetadata(this._xzgLoraMetadata, item);
                    if (info?.thumbnail) {
                        row.classList.add("xzg-lora-has-thumbnail");
                        const img = element("img", "xzg-lora-row-thumbnail");
                        loadThumbnail(img, info, () => {
                            img.remove();
                            row.classList.remove("xzg-lora-has-thumbnail");
                        }, info._thumbnailVersion ? "?v=" + info._thumbnailVersion : "");
                        img.draggable = false;
                        row.append(img);
                    }
                    const name = element("div", "xzg-lora-name", (info?.path || item.path || "").split("/").pop() || "未知 LoRA");
                    name.setAttribute("role", "button");
                    name.setAttribute("aria-pressed", String(item.enabled !== false));
                    name.tabIndex = 0;
                    const toggleEnabled = () => {
                        item.enabled = item.enabled === false;
                        saveSelection(this, list, item);
                    };
                    row.addEventListener("click", event => {
                        if (draggedIndex !== null || event.target.closest("button, input, select, textarea, label, a, [contenteditable=true]")) return;
                        event.stopPropagation();
                        toggleEnabled();
                    });
                    name.addEventListener("keydown", event => {
                        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); toggleEnabled(); }
                    });
                    row.append(name);
                    const controls = element("div", "xzg-lora-stack-controls");
                    const enabled = element("input"); enabled.type = "checkbox"; enabled.checked = item.enabled !== false;
                    enabled.setAttribute("aria-label", "启用 LoRA");
                    enabled.onchange = () => {
                        item.enabled = enabled.checked;
                        saveSelection(this, list, item);
                    }; controls.append(enabled);
                    for (const [key, label] of [["strength_model", "模型强度"]]) {
                        controls.append(element("span", "", label));
                        const input = strengthInput(item[key] ?? 1, value => {
                            item[key] = value;
                            widget(this, "loras").value = JSON.stringify(list);
                            this.setDirtyCanvas(true, true);
                            app.graph?.change?.();
                        });
                        input.setAttribute("aria-label", label);
                        controls.append(input);
                    }
                    let triggers = "";
                    const copyTriggers = button("复制触发词", () => {
                        if (!copyTriggers.disabled) return navigator.clipboard.writeText(triggers);
                    }, controls);
                    copyTriggers.className = "xzg-lora-copy";
                    const updateCopyTriggers = info => {
                        triggers = typeof info?.triggers === "string" ? info.triggers : "";
                        copyTriggers.disabled = !triggers.trim();
                    };
                    updateCopyTriggers(info);
                    const openFolder = button("", async () => {
                        const record = findLoraMetadata((await fetchLibrary()).items, item);
                        if (!record) throw Error("LoRA 文件缺失或路径不唯一，请打开管理器检查");
                        await request("open-directory", { id: record.id });
                    }, controls);
                    openFolder.className = "xzg-lora-icon";
                    openFolder.setAttribute("aria-label", "打开目录");
                    openFolder.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M3 7V5h7l2 2h9v13H3Z"/><path d="M3 10h18"/></svg>';
                    const remove = button("", () => { list.splice(index, 1); saveSelection(this, list); }, controls);
                    remove.className = "xzg-lora-icon xzg-lora-remove";
                    remove.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
                    remove.setAttribute("aria-label", "移除 LoRA");
                    row.append(controls);
                    const preview = element("div", "xzg-lora-node-preview");
                    preview.style.cssText = "position:fixed;z-index:12002;display:none;box-sizing:border-box;width:320px;padding:14px;background:#252525;border:1px solid #eee;border-radius:6px;white-space:pre-wrap;overflow-wrap:anywhere;color:#eee;font:13px/1.6 system-ui;pointer-events:none;overflow:hidden;box-shadow:0 6px 20px #0008";
                    const showPreview = async () => {
                        if (this.properties?.xzgLoraCompact === true) return;
                        this._xzgLoraPreview?.remove();
                        this._xzgLoraPreview = preview;
                        document.body.append(preview);
                        preview.style.display = "block";
                        const position = () => {
                            const bounds = stack.getBoundingClientRect();
                            const maxWidth = Math.min(preview.dataset.hasThumbnail === "true" ? 620 : 380, window.innerWidth - 16);
                            preview.style.width = "max-content";
                            preview.style.maxWidth = `${maxWidth}px`;
                            preview.style.maxHeight = `${window.innerHeight - 16}px`;
                            const width = preview.getBoundingClientRect().width;
                            const top = Math.max(8, Math.min(row.getBoundingClientRect().top, window.innerHeight - preview.offsetHeight - 8));
                            preview.style.left = `${Math.max(8, Math.min(bounds.right + 12, window.innerWidth - width - 8))}px`;
                            preview.style.top = `${top}px`;
                        };
                        const render = info => {
                            preview.replaceChildren();
                            const hasDescription = ["notes", "tags", "triggers"].some(key => {
                                const value = Array.isArray(info[key]) ? info[key].join(" ") : info[key];
                                return String(value || "").trim().length > 0;
                            });
                            if (!info.thumbnail && !hasDescription) {
                                preview.style.display = "none";
                                return;
                            }
                            preview.dataset.hasThumbnail = String(!!info.thumbnail);
                            preview.style.width = info.thumbnail ? "620px" : "max-content";
                            preview.style.display = "flex";
                            preview.style.gap = "14px";
                            preview.style.alignItems = "flex-start";
                            if (info.thumbnail) {
                                const image = element("img");
                                image.style.cssText = "width:220px;max-width:38%;max-height:260px;object-fit:contain;flex-shrink:0";
                                loadThumbnail(image, info, () => {
                                    if (image.parentElement === preview) render({ ...info, thumbnail: false });
                                });
                                image.draggable = false; preview.append(image);
                            }
                            const description = element("div");
                            description.style.cssText = "flex:1;min-width:0;max-height:calc(100vh - 46px);overflow:auto;white-space:pre-wrap";
                            description.append(element("strong", "", info.path?.split("/").pop() || ""));
                            preview.append(description);
                            for (const [label, key] of [["备注", "notes"], ["标签", "tags"], ["触发词", "triggers"]]) {
                                const value = Array.isArray(info[key]) ? info[key].join("，") : info[key];
                                description.append(element("div", "", `${label}：${value || "未填写"}`));
                            }
                            position();
                        };
                        render(findLoraMetadata(this._xzgLoraMetadata, item) || item);
                        try {
                            const library = await fetchLibrary();
                            this._xzgLoraMetadata = library.items;
                            const updated = findLoraMetadata(library.items, item);
                            updateCopyTriggers(updated);
                            if (preview.isConnected) render(updated || item);
                        } catch (error) {
                            if (preview.isConnected) preview.append(element("div", "", error.message));
                        }
                    };
                    row.addEventListener("pointerenter", showPreview);
                    row.addEventListener("pointerleave", () => preview.remove());
                    row.addEventListener("dragstart", () => preview.remove());
                    rows.append(row);
                });
            };
            this._xzgRenderLoras(); this.setSize([500, this.computeSize()[1]]);
        };
        const resize = nodeType.prototype.onResize;
        nodeType.prototype.onResize = function (size) {
            const result = resize?.apply(this, arguments);
            if (this._xzgLoraHeight) {
                size[0] = Math.max(size[0], this._xzgLoraMinWidth ?? 300);
                size[1] = this._xzgLoraHeight();
            }
            return result;
        };
        const configure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            configure?.apply(this, arguments);
            if (nodeData.name === WAN_TYPE) {
                for (let index = (this.inputs?.length || 0) - 1; index >= 0; index--) {
                    const input = this.inputs[index];
                    if (["prev_lora", "merge_loras"].includes(input.widget?.name || input.name)) {
                        this.removeInput(index);
                        this._widgetSlotsDirty = true;
                    }
                }
            }
            pruneHiddenInputs(this);
            const clipInput = this.inputs?.findIndex(input => input.name === "clip");
            if (clipInput >= 0) this.removeInput(clipInput);
            const clipOutput = this.outputs?.findIndex(output => output.type === "CLIP");
            if (clipOutput >= 0) this.removeOutput(clipOutput);
            const input = widget(this, "loras");
            let list;
            try { list = selection(this); } catch {
                this._xzgRenderLoras?.();
                return;
            }
            input.value = serializeSelection(list);
            if (this.properties?.xzgLoraSingle === true) saveSelection(this, list);
            else this._xzgRenderLoras?.();
            if (list.length) {
                fetchLibrary().then(data => {
                    updateNodeLibrary(data, this);
                }).catch(() => {});
            }
        };
    }
});

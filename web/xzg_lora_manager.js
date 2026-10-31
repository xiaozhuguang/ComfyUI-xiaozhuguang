import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const TYPE = "XiaozhuguangLoraManager";
const BASE = "/xzg/lora/";
const SIDEBAR_SETTING = "xiaozhuguang.Toggle.EnableLoraSidebar";
const SIDEBAR_BUTTON = '.xzg-lora-library-tab-button, [data-testid="xzg-lora-library-tab-button"], [data-tab-id="xzg-lora-library"]';
let panel;

function setSidebarEnabled(enabled) {
    document.documentElement.classList.toggle("xzg-hide-lora-sidebar", !enabled);
}

function matchesSearch(item, query) {
    const text = [item.path, item.notes, item.tags, item.triggers].join(" ").toLowerCase();
    return query.toLowerCase().trim().split(/\s+/).filter(Boolean).every(word => text.includes(word));
}

function strengthInput(value, commit) {
    const input = element("input", "xzg-lora-strength");
    input.type = "text";
    input.inputMode = "decimal";
    input.value = String(value);
    input.title = "左右拖动：0～1，步进 0.1；单击输入，可超过 1，支持两位小数";
    let current = value, gesture = null;
    function save() {
        const parsed = Number(input.value);
        if (!input.value.trim() || !Number.isFinite(parsed)) { input.value = String(current); return; }
        current = Math.round(Math.max(0, parsed) * 100) / 100;
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
        input.value = String(Math.round(Math.min(1, Math.max(0, gesture.value + steps * .1)) * 10) / 10);
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
        if ((response.status === 404 || response.status === 405) &&
            (path === "clear-maintenance" || path.startsWith("triggers/"))) {
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

function button(text, action, parent) {
    const b = element("button", "", text);
    b.type = "button";
    b.onclick = () => Promise.resolve().then(action).catch(error => alert(error.message));
    parent?.append(b);
    return b;
}

function widget(node, name) { return node.widgets?.find(w => w.name === name); }
function selection(node) { return JSON.parse(widget(node, "loras").value || "[]"); }
function saveSelection(node, list) {
    widget(node, "loras").value = JSON.stringify(list);
    node._xzgRenderLoras?.();
    node.setDirtyCanvas(true, true);
    app.graph?.change?.();
}

function loraMode(node) { return node.properties?.xzg_lora_mode === "parallel" ? "parallel" : "serial"; }
function saveLoraMode(node, mode) {
    node.properties ||= {};
    node.properties.xzg_lora_mode = mode;
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
    .xzg-lora-node-actions button.xzg-lora-mode{font-weight:700;color:#dfbd8e}
    .xzg-lora-stack-row{padding:8px 0;border-bottom:1px solid #555;overflow-wrap:anywhere;white-space:normal}
    .xzg-lora-stack-row>.xzg-lora-name{cursor:grab;user-select:none}
    .xzg-lora-stack-row.xzg-lora-has-thumbnail{display:grid;grid-template-columns:minmax(0,1fr) 50px;column-gap:8px;align-items:center;min-height:50px}
    .xzg-lora-has-thumbnail>.xzg-lora-name{grid-column:1;grid-row:1}
    .xzg-lora-has-thumbnail>.xzg-lora-stack-controls{grid-column:1;grid-row:2}
    .xzg-lora-has-thumbnail>.xzg-lora-row-thumbnail{grid-column:2;grid-row:1 / 3;width:50px;height:50px;object-fit:contain;align-self:center}
    .xzg-lora-stack-row.xzg-lora-dragging{opacity:.4}
    .xzg-lora-stack-row.xzg-lora-drop-before{box-shadow:inset 0 2px #cda56d}
    .xzg-lora-stack-row.xzg-lora-drop-after{box-shadow:inset 0 -2px #cda56d}
    .xzg-lora-stack .xzg-lora-icon{width:28px;height:28px;padding:4px;display:inline-flex;align-items:center;justify-content:center}
    .xzg-lora-stack .xzg-lora-remove{color:#ff8585;font-size:22px;line-height:1}
    .xzg-lora-stack .xzg-lora-remove:hover{color:#ffb3b3;border-color:#cf6875;background:#532a30}
    .xzg-lora-stack .xzg-lora-copy,.xzg-lora-stack .xzg-lora-icon{border:0;background:transparent;box-shadow:none}
    .xzg-lora-stack .xzg-lora-copy{height:26px;padding:2px 4px;display:inline-flex;align-items:center;justify-content:center;line-height:1}
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
    const search = element("input"); search.placeholder = "搜索名称、标签等，空格分隔多个词"; search.style.width = "340px";
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
        if (node) {
            widget(node, "library_user").value = data.user;
            const list = selection(node);
            const byId = new Map(data.items.map(item => [item.id, item]));
            for (const entry of list) {
                const item = byId.get(entry.id);
                if (item) Object.assign(entry, { path: item.path, thumbnail: !!item.thumbnail });
                delete entry.name;
            }
            saveSelection(node, list);
        }
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
            }
        } finally { dirty = false; await reload(); }
    }

    function renderCards() {
        if (!data) return;
        tooltip.hidden = true;
        content.replaceChildren();
        const grid = element("div", "xzg-lora-grid"); content.append(grid);
        const addedIds = new Set(node ? selection(node).map(item => item.id) : []);
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
                img.src = api.apiURL(BASE + "thumbnail/" + item.id + "?v=" + (item._thumbnailVersion || "1")); card.append(img);
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
        widget(node, "library_user").value = data.user;


        const list = selection(node);
        if (list.some(x => x.id === item.id)) { status.textContent = "该 LoRA 已在当前加载器中"; return; }
        list.push({ id: item.id, path: item.path, thumbnail: !!item.thumbnail, enabled: true,
            strength_model: item.strength_model ?? 1 });
        saveSelection(node, list); status.textContent = `已添加：${item.path.split("/").pop()} · 共 ${list.length} 个 LoRA`;

    }

    function edit(item) {
        if (!item) { active = null; detail.replaceChildren(); return; }
        active = item.id; dirty = false; detail.replaceChildren();
        detail.append(element("div", "xzg-lora-name", item.path.split("/").pop()));
        if (item.thumbnail) {
            const image = element("img", "xzg-lora-image"); image.src = api.apiURL(BASE + "thumbnail/" + item.id + "?v=" + Date.now()); detail.append(image);
        }
        button("上传 / 替换缩略图", () => filePicker("image/*", async file => {
            const form = new FormData(); form.append("file", file);
            await request("thumbnail/" + item.id, form); item.thumbnail = true; item._thumbnailVersion = Date.now(); renderCards();
            status.textContent = "缩略图已保存";
        }), detail);
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
    await reload(); search.focus();
}

app.registerExtension({
    name: "Xiaozhuguang.LoraManager",
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
        if (nodeData.name !== TYPE) return;
        const original = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            original?.apply(this, arguments);
            for (const name of ["loras", "library_user"]) {
                const w = widget(this, name); w.type = "hidden"; w.computeSize = () => [0, -4];
                if (w.inputEl) w.inputEl.style.display = "none";
            }
            const actions = element("div", "xzg-lora-node-actions");
            button("打开 LoRA 管理器", () => openManager(this), actions);
            const modeButton = button("", () => {
                const next = loraMode(this) === "serial" ? "parallel" : "serial";
                if (next === "parallel") {
                    const list = selection(this);
                    const firstEnabled = list.find(item => item.enabled !== false);
                    if (firstEnabled) list.forEach(item => { item.enabled = item === firstEnabled; });
                    saveSelection(this, list);
                }
                saveLoraMode(this, next);
                modeButton.textContent = next === "serial" ? "模式：串联（多选）" : "模式：并联（单选）";
                modeButton.title = next === "serial" ? "多个已启用 LoRA 按列表顺序叠加" : "每次只启用一个 LoRA";
            }, actions);
            modeButton.className = "xzg-lora-mode";
            modeButton.textContent = loraMode(this) === "serial" ? "模式：串联（多选）" : "模式：并联（单选）";
            modeButton.title = loraMode(this) === "serial" ? "多个已启用 LoRA 按列表顺序叠加" : "每次只启用一个 LoRA";
            button("一键清除 LoRA", () => saveSelection(this, []), actions);
            this.addDOMWidget("lora_actions", "div", actions, { serialize: false, getMinHeight: () => 36, getMaxHeight: () => 36, getHeight: () => 36 });
            const stack = element("div", "xzg-lora-stack");
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
            this.addDOMWidget("lora_stack", "div", stack, { serialize: false, getMinHeight: () => 180, getHeight: () => 260 });
            this._xzgRenderLoras = () => {
                this._xzgLoraPreview?.remove();
                this._xzgLoraPreviewId = null;
                stack.replaceChildren();
                let list;
                try { list = selection(this); } catch { stack.textContent = "LoRA 列表格式无效，请检查 loras 数据"; return; }
                if (!list.length) stack.textContent = "尚未选择 LoRA，请打开管理器添加。";
                let draggedId = null;
                const clearDropMarks = () => {
                    for (const row of stack.children) row.classList.remove("xzg-lora-drop-before", "xzg-lora-drop-after");
                };
                list.forEach((item, index) => {
                    const row = element("div", "xzg-lora-stack-row");
                    row.classList.toggle("xzg-lora-disabled", item.enabled === false);
                    row.draggable = true;
                    row.ondragstart = event => {
                        if (event.target.closest(".xzg-lora-stack-controls")) { event.preventDefault(); return; }
                        event.stopPropagation();
                        draggedId = item.id;
                        event.dataTransfer.setData("text/plain", item.id);
                        event.dataTransfer.effectAllowed = "move";
                        row.classList.add("xzg-lora-dragging");
                    };
                    row.ondragover = event => {
                        if (!draggedId || draggedId === item.id) return;
                        event.preventDefault(); event.stopPropagation(); clearDropMarks();
                        const rect = row.getBoundingClientRect();
                        row.classList.add(event.clientY < rect.top + rect.height / 2 ? "xzg-lora-drop-before" : "xzg-lora-drop-after");
                        event.dataTransfer.dropEffect = "move";
                    };
                    row.ondrop = event => {
                        if (!draggedId || draggedId === item.id) return;
                        event.preventDefault(); event.stopPropagation();
                        const from = list.findIndex(entry => entry.id === draggedId);
                        const rect = row.getBoundingClientRect();
                        let to = index + (event.clientY >= rect.top + rect.height / 2 ? 1 : 0);
                        if (from < 0) return;
                        const [moving] = list.splice(from, 1);
                        if (from < to) to--;
                        list.splice(to, 0, moving);
                        draggedId = null; saveSelection(this, list);
                    };
                    row.ondragend = () => { draggedId = null; row.classList.remove("xzg-lora-dragging"); clearDropMarks(); };
                    if (item.thumbnail) {
                        row.classList.add("xzg-lora-has-thumbnail");
                        const img = element("img", "xzg-lora-row-thumbnail"); img.src = api.apiURL(BASE + "thumbnail/" + item.id);
                        img.draggable = false;
                        row.append(img);
                    }
                    const name = element("div", "xzg-lora-name", item.path.split("/").pop());
                    name.title = item.enabled === false ? "点击启用此 LoRA" : "点击停用此 LoRA";
                    name.setAttribute("role", "button");
                    name.tabIndex = 0;
                    const toggleEnabled = () => {
                        item.enabled = item.enabled === false;
                        if (item.enabled && loraMode(this) === "parallel") {
                            list.forEach(other => { if (other !== item) other.enabled = false; });
                        }
                        saveSelection(this, list);
                    };
                    name.addEventListener("click", event => { event.stopPropagation(); toggleEnabled(); });
                    name.addEventListener("keydown", event => {
                        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); toggleEnabled(); }
                    });
                    row.append(name);
                    const controls = element("div", "xzg-lora-stack-controls");
                    const enabled = element("input"); enabled.type = "checkbox"; enabled.checked = item.enabled !== false; enabled.title = "启用";
                    enabled.onchange = () => {
                        item.enabled = enabled.checked;
                        if (enabled.checked && loraMode(this) === "parallel") {
                            list.forEach(other => { if (other !== item) other.enabled = false; });
                        }
                        saveSelection(this, list);
                    }; controls.append(enabled);
                    for (const [key, label] of [["strength_model", "模型强度"]]) {
                        controls.append(element("span", "", label));
                        const input = strengthInput(item[key] ?? 1, value => {
                            item[key] = value;
                            widget(this, "loras").value = JSON.stringify(list);
                            this.setDirtyCanvas(true, true);
                            app.graph?.change?.();
                        });
                        input.setAttribute("aria-label", label + "强度");
                        controls.append(input);
                    }
                    const copyTriggers = button("复制触发词", async () => {
                        const result = await (await request("triggers/" + encodeURIComponent(item.id))).json();
                        if (result.triggers.trim()) await navigator.clipboard.writeText(result.triggers);
                    }, controls);
                    copyTriggers.className = "xzg-lora-copy";
                    const openFolder = button("", () => request("open-directory", { id: item.id }), controls);
                    openFolder.className = "xzg-lora-icon";
                    openFolder.title = "打开目录";
                    openFolder.setAttribute("aria-label", "打开目录");
                    openFolder.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M3 7V5h7l2 2h9v13H3Z"/><path d="M3 10h18"/></svg>';
                    const remove = button("", () => { list.splice(index, 1); saveSelection(this, list); }, controls);
                    remove.className = "xzg-lora-icon xzg-lora-remove";
                    remove.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
                    remove.title = "移除 LoRA";
                    remove.setAttribute("aria-label", "移除 LoRA");
                    row.append(controls);
                    const preview = element("div", "xzg-lora-node-preview");
                    preview.style.cssText = "position:fixed;z-index:12002;display:none;box-sizing:border-box;width:320px;padding:14px;background:#252525;border:1px solid #eee;border-radius:6px;white-space:pre-wrap;overflow-wrap:anywhere;color:#eee;font:13px/1.6 system-ui;pointer-events:none;overflow:hidden;box-shadow:0 6px 20px #0008";
                    const showPreview = async () => {
                        this._xzgLoraPreview?.remove();
                        this._xzgLoraPreview = preview;
                        this._xzgLoraPreviewId = item.id;
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
                                image.src = api.apiURL(BASE + "thumbnail/" + item.id);
                                image.style.cssText = "display:block;width:220px;max-width:38%;max-height:260px;object-fit:contain;flex-shrink:0";
                                image.draggable = false; preview.append(image);
                            }
                            const description = element("div");
                            description.style.cssText = "flex:1;min-width:0;max-height:calc(100vh - 46px);overflow:auto;white-space:pre-wrap";
                            description.append(element("strong", "", item.path.split("/").pop()));
                            preview.append(description);
                            for (const [label, key] of [["备注", "notes"], ["标签", "tags"], ["触发词", "triggers"]]) {
                                const value = Array.isArray(info[key]) ? info[key].join("，") : info[key];
                                description.append(element("div", "", `${label}：${value || "未填写"}`));
                            }
                            position();
                        };
                        render(this._xzgLoraMetadata?.get(item.id) || item);
                        try {
                            const library = await (await request("library")).json();
                            this._xzgLoraMetadata = new Map(library.items.map(entry => [entry.id, entry]));
                            if (this._xzgLoraPreviewId === item.id && preview.isConnected) render(this._xzgLoraMetadata.get(item.id) || item);
                        } catch (error) {
                            if (preview.isConnected) preview.append(element("div", "", error.message));
                        }
                    };
                    row.addEventListener("pointerenter", showPreview);
                    row.addEventListener("pointerleave", () => {
                        preview.remove();
                        if (this._xzgLoraPreviewId === item.id) this._xzgLoraPreviewId = null;
                    });
                    row.addEventListener("dragstart", () => preview.remove());
                    stack.append(row);
                });
                this._xzgLoraMinWidth = 320;
                requestAnimationFrame(() => {
                    if (!stack.isConnected) return;
                    actions.style.width = "max-content";
                    const actionsWidth = actions.scrollWidth + 28;
                    actions.style.width = "";
                    const controlWidth = Math.max(0, ...[...stack.querySelectorAll(".xzg-lora-stack-controls")].map(controls => {
                        const children = [...controls.children];
                        const width = children.reduce((total, child) => total + child.offsetWidth, 0) + Math.max(0, children.length - 1) * 6;
                        const thumbnailWidth = controls.parentElement.classList.contains("xzg-lora-has-thumbnail") ? 58 : 0;
                        return width + thumbnailWidth + 44;
                    }));
                    this._xzgLoraMinWidth = Math.max(320, actionsWidth, controlWidth);
                    if (this.size[0] < this._xzgLoraMinWidth) this.setSize([this._xzgLoraMinWidth, this.size[1]]);
                });
            };
            this._xzgRenderLoras(); this.setSize([500, 360]);
        };
        const resize = nodeType.prototype.onResize;
        nodeType.prototype.onResize = function (size) {
            size[0] = Math.max(size[0], this._xzgLoraMinWidth || 320);
            const result = resize?.apply(this, arguments);
            this.size[0] = Math.max(this.size[0], this._xzgLoraMinWidth || 320);
            return result;
        };
        const configure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            configure?.apply(this, arguments);
            const clipInput = this.inputs?.findIndex(input => input.name === "clip");
            if (clipInput >= 0) this.removeInput(clipInput);
            const clipOutput = this.outputs?.findIndex(output => output.type === "CLIP");
            if (clipOutput >= 0) this.removeOutput(clipOutput);
            this._xzgRenderLoras?.();
        };
    }
});

import { app } from "../../scripts/app.js";
import { xzgLang } from "./xzg_i18n.js";
import { cloudLoad, cloudSave, cloudUIInit, cloudUIQueueGeometry } from "./xzg_cloud_store.js";

const H3_PREFIX = "Minimax-H3 ";
const H3_GEN_MODES = [
    "Text to Video (T2VA)", "Image to Video (I2VA)", "First+Last Frame (FL2VA)",
    "Last Frame (L2VA)", "Full Reference (Ref2VA)",
].map(value => `${H3_PREFIX}${value}`);
const QWEN_IMAGE_TARGET = "Qwen-Image-2.1 图像";
const QWEN_IMAGE_TARGET_EN = "Qwen-Image-2.1 Image";
const PROMPT_RULE_PRESETS_KEY = "xzg_prompt_rule_presets";
const LEGACY_SKILL_PRESETS_KEY = "xzg_prompt_skill_presets";
const PROMPT_RULE_MANAGER_GEOMETRY_KEY = "xzg_prompt_rule_manager_geometry";
const LEGACY_PROMPT_RULE_MANAGER_GEOMETRY_KEY = "xzg_prompt_skill_manager_geometry";
let promptRulePresetsRestorePromise = null;
const QWEN_IMAGE_MODES = [
    "Qwen-Image-2.1 文生图",
    "Qwen-Image-2.1 图像编辑",
    "Qwen-Image-2.1 多参考图",
];
const TARGET_LABELS = {
    zh: { h3: "MiniMax-H3", qwen: "QWEN", custom: "自定义提示词规则" },
    en: { h3: "MiniMax-H3", qwen: "QWEN", custom: "Custom Prompt Rules" },
};
function xzgOrderedPromptRulePresetNames(presets) {
    return Object.keys(presets || {}).sort((a, b) => {
        const aOrder = presets[a]?.order;
        const bOrder = presets[b]?.order;
        const aHasOrder = Number.isFinite(aOrder);
        const bHasOrder = Number.isFinite(bOrder);
        if (aHasOrder && bHasOrder) return aOrder - bOrder || a.localeCompare(b);
        if (aHasOrder) return -1;
        if (bHasOrder) return 1;
        return a.localeCompare(b);
    });
}
function normalizePromptRulePresets(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    const normalized = {};
    for (const [name, entry] of Object.entries(data)) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        const rule = typeof entry.rule === "string" ? entry.rule : entry.skill;
        if (typeof rule !== "string") continue;
        const { skill: _legacySkill, ...rest } = entry;
        const category = String(rest.category || "自定义提示词规则");
        normalized[name] = { ...rest, category, name: String(rest.name || name), rule };
    }
    return normalized;
}

async function openPromptRuleManager(node) {
    if (node._xzgPromptRulePresetDialog || node._xzgPromptRulePresetOpening) return;
    node._xzgPromptRulePresetOpening = true;
    try { await cloudUIInit(); } catch (_) {}
    if (!promptRulePresetsRestorePromise) node._restorePromptRulePresets?.();
    try { await promptRulePresetsRestorePromise; } catch (_) {}
    node._xzgPromptRulePresetOpening = false;
    if (node._xzgPromptRulePresetDialog) return;
    const zh = xzgLang() === "zh";
    const load = () => {
        try { return normalizePromptRulePresets(JSON.parse(localStorage.getItem(PROMPT_RULE_PRESETS_KEY) || "{}")); }
        catch (_) { return {}; }
    };
    let presets = load();
    let activeType = Object.values(presets)[0]?.category || "";
    let activeName = null;
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;z-index:100000;background:#0009;padding:20px;box-sizing:border-box";
    overlay.addEventListener("contextmenu", event => { event.preventDefault(); event.stopPropagation(); });
    const panel = document.createElement("div");
    panel.style.cssText = "position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(760px,calc(100vw - 40px));height:min(700px,calc(100vh - 40px));display:flex;flex-direction:column;overflow:hidden;background:#202124;color:#43ffa0;border:1px solid #3a3a3a;border-radius:8px;font:13px Arial,sans-serif";
    panel.innerHTML = `<header style="display:flex;align-items:center;padding:13px 16px;border-bottom:1px solid #444;font-size:15px;font-weight:600"><span style="flex:1">${zh ? "自定义提示词规则管理" : "Custom Prompt Rules Manager"}</span><button data-close>${zh ? "确认" : "Confirm"}</button></header><main style="display:flex;flex:1;min-height:0"><aside style="box-sizing:border-box;flex:0 0 34%;min-width:150px;display:flex;flex-direction:column;padding:12px 10px;overflow:hidden;border-right:1px solid #444"><div style="display:flex;align-items:center;box-sizing:border-box;height:43px;flex:none;padding:0 4px"><span style="flex:1;font-weight:600;color:#fff">${zh ? "提示词类型" : "Prompt Types"}</span><button data-add-type>+</button></div><div data-types style="display:flex;flex-direction:column;gap:6px;overflow:auto;min-height:0;flex:1"></div></aside><section style="flex:1;min-width:0;display:flex;flex-direction:column;padding:12px 14px;min-height:0"><div style="display:flex;align-items:center;box-sizing:border-box;height:43px;flex:none;padding:0 2px;border-bottom:1px solid #3a3a3a"><span data-subtitle style="flex:1;font-weight:600;color:#fff">${zh ? "提示词细分" : "Prompt Subcategories"}</span><button data-add-sub title="${zh ? "增加子项" : "Add item"}">+</button></div><div data-subtypes style="display:flex;flex-direction:column;gap:6px;overflow:auto;min-height:0;flex:1;padding-top:10px"></div></section></main><div data-editor style="display:none;flex:1;flex-direction:column;min-height:0;padding:12px 16px"><div data-editor-label style="color:#43ffa0;margin-bottom:8px"></div><div style="display:flex;gap:8px;justify-content:flex-end;padding:0 0 10px"><button data-back>${zh ? "返回类型" : "Back to types"}</button><button data-import>${zh ? "导入 .txt / .md" : "Import .txt / .md"}</button><button data-save>${zh ? "保存内容" : "Save content"}</button><input data-file type="file" accept=".txt,.md,text/plain,text/markdown" style="display:none"></div><textarea data-content spellcheck="false" style="box-sizing:border-box;flex:1;min-height:100px;resize:none;padding:10px;background:#151617;color:#43ffa0;border:1px solid #555;border-radius:5px;font:12px/1.5 Consolas,monospace"></textarea></div>`;
    overlay.appendChild(panel); document.body.appendChild(overlay); node._xzgPromptRulePresetDialog = overlay;
    const mainPane = panel.querySelector("main"), leftPane = mainPane.querySelector("aside"), rightPane = mainPane.querySelector("section");
    const columnSplitter = document.createElement("div");
    columnSplitter.title = zh ? "左右拖动调整两栏宽度" : "Drag horizontally to resize the columns";
    columnSplitter.setAttribute("aria-label", columnSplitter.title);
    columnSplitter.style.cssText = "box-sizing:border-box;position:relative;z-index:1;flex:0 0 4px;display:flex;align-items:stretch;justify-content:center;cursor:col-resize;touch-action:none;user-select:none;background:#3a3a3a";
    columnSplitter.innerHTML = "";
    mainPane.insertBefore(columnSplitter, rightPane);
    leftPane.style.borderRight = "0";
    let leftPaneWidth = null;
    try {
        const saved = JSON.parse(localStorage.getItem(PROMPT_RULE_MANAGER_GEOMETRY_KEY) || localStorage.getItem(LEGACY_PROMPT_RULE_MANAGER_GEOMETRY_KEY) || "null");
        if (Number.isFinite(saved?.leftPaneWidth)) leftPaneWidth = saved.leftPaneWidth;
    } catch (_) {}
    if (leftPaneWidth === null) leftPaneWidth = leftPane.getBoundingClientRect().width;
    const clampLeftPaneWidth = value => Math.max(150, Math.min(mainPane.clientWidth - 210, value));
    const applyLeftPaneWidth = value => { leftPaneWidth = clampLeftPaneWidth(value); leftPane.style.flex = `0 0 ${leftPaneWidth}px`; };
    applyLeftPaneWidth(leftPaneWidth);
    columnSplitter.addEventListener("pointerdown", event => {
        if (event.button !== 0) return;
        event.preventDefault(); event.stopPropagation();
        const startX = event.clientX, startWidth = leftPane.getBoundingClientRect().width;
        const move = e => applyLeftPaneWidth(startWidth + e.clientX - startX);
        const end = () => { columnSplitter.removeEventListener("pointermove", move); persistGeometry(); };
        columnSplitter.setPointerCapture(event.pointerId); columnSplitter.addEventListener("pointermove", move);
        columnSplitter.addEventListener("pointerup", end, { once: true }); columnSplitter.addEventListener("pointercancel", end, { once: true });
    });
    const persistGeometry = () => {
        const rect = panel.getBoundingClientRect();
        const geometry = { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height), leftPaneWidth: Math.round(leftPane.getBoundingClientRect().width) };
        try { localStorage.setItem(PROMPT_RULE_MANAGER_GEOMETRY_KEY, JSON.stringify(geometry)); } catch (_) {}
        cloudUIQueueGeometry();
    };
    try {
        const saved = JSON.parse(localStorage.getItem(PROMPT_RULE_MANAGER_GEOMETRY_KEY) || localStorage.getItem(LEGACY_PROMPT_RULE_MANAGER_GEOMETRY_KEY) || "null");
        if (saved && [saved.left, saved.top, saved.width, saved.height].every(Number.isFinite)) {
            const minWidth = Math.min(520, window.innerWidth - 40), minHeight = Math.min(400, window.innerHeight - 40);
            const width = Math.max(minWidth, Math.min(window.innerWidth - 40, saved.width));
            const height = Math.max(minHeight, Math.min(window.innerHeight - 40, saved.height));
            panel.style.transform = "none"; panel.style.width = `${width}px`; panel.style.height = `${height}px`;
            panel.style.left = `${Math.max(0, Math.min(window.innerWidth - width, saved.left))}px`;
            panel.style.top = `${Math.max(0, Math.min(window.innerHeight - height, saved.top))}px`;
        }
    } catch (_) {}
    const titleBar = panel.querySelector("header");
    titleBar.style.cursor = "move"; titleBar.style.userSelect = "none";
    titleBar.addEventListener("pointerdown", event => {
        if (event.button !== 0 || event.target.closest("button")) return;
        event.preventDefault();
        const rect = panel.getBoundingClientRect(), startX = event.clientX, startY = event.clientY;
        panel.style.transform = "none"; panel.style.left = `${rect.left}px`; panel.style.top = `${rect.top}px`;
        const move = e => {
            panel.style.left = `${Math.max(0, Math.min(window.innerWidth - rect.width, rect.left + e.clientX - startX))}px`;
            panel.style.top = `${Math.max(0, Math.min(window.innerHeight - rect.height, rect.top + e.clientY - startY))}px`;
        };
        const end = () => { titleBar.removeEventListener("pointermove", move); persistGeometry(); };
        titleBar.setPointerCapture(event.pointerId); titleBar.addEventListener("pointermove", move);
        titleBar.addEventListener("pointerup", end, { once: true }); titleBar.addEventListener("pointercancel", end, { once: true });
    });
    const resizeHandle = document.createElement("div");
    resizeHandle.title = zh ? "拖动右下角调整窗口大小" : "Drag to resize dialog";
    resizeHandle.style.cssText = "position:absolute;right:1px;bottom:1px;width:18px;height:18px;z-index:2;cursor:nwse-resize;touch-action:none;user-select:none;background:linear-gradient(135deg,transparent 0 48%,#666 49% 55%,transparent 56% 66%,#888 67% 73%,transparent 74%)";
    panel.appendChild(resizeHandle);
    resizeHandle.addEventListener("pointerdown", event => {
        if (event.button !== 0) return;
        event.preventDefault(); event.stopPropagation();
        const rect = panel.getBoundingClientRect(), startX = event.clientX, startY = event.clientY;
        panel.style.transform = "none"; panel.style.left = `${rect.left}px`; panel.style.top = `${rect.top}px`;
        const minWidth = Math.min(520, window.innerWidth - 40), minHeight = Math.min(400, window.innerHeight - 40);
        const move = e => {
            panel.style.width = `${Math.max(minWidth, Math.min(window.innerWidth - rect.left - 20, rect.width + e.clientX - startX))}px`;
            panel.style.height = `${Math.max(minHeight, Math.min(window.innerHeight - rect.top - 20, rect.height + e.clientY - startY))}px`;
        };
        const end = () => { resizeHandle.removeEventListener("pointermove", move); persistGeometry(); };
        resizeHandle.setPointerCapture(event.pointerId); resizeHandle.addEventListener("pointermove", move);
        resizeHandle.addEventListener("pointerup", end, { once: true }); resizeHandle.addEventListener("pointercancel", end, { once: true });
    });
    const types = panel.querySelector("[data-types]"), subtypes = panel.querySelector("[data-subtypes]"), editorView = panel.querySelector("[data-editor]"), content = panel.querySelector("[data-content]"), header = panel.querySelector("header");
    for (const button of panel.querySelectorAll("button")) { button.style.cssText = "padding:5px 9px;background:#343b49;border:1px solid #555;border-radius:4px;cursor:pointer;white-space:nowrap"; button.style.setProperty("color", "#43ffa0", "important"); }
    for (const element of editorView.querySelectorAll("*")) element.style.setProperty("color", "#fff", "important");
    const setEditorConfirmDisabled = disabled => { const button = panel.querySelector("header [data-close]"); button.disabled = disabled; button.style.opacity = disabled ? ".45" : "1"; button.style.cursor = disabled ? "not-allowed" : "pointer"; };
    const closeButton = panel.querySelector("[data-close]"); closeButton.style.cssText = "padding:4px 5px;background:transparent;border:0;border-radius:0;font:17px Arial,sans-serif;cursor:pointer"; closeButton.style.setProperty("color", "#43ffa0", "important");
    const addTypeButton = panel.querySelector("[data-add-type]"); addTypeButton.style.cssText = "box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;flex:none;width:32px;height:32px;padding:0;background:transparent;border:0;border-radius:0;font:32px/32px Arial,sans-serif;cursor:pointer"; addTypeButton.style.setProperty("color", "#fff", "important");
    const addSubtypeButton = panel.querySelector("[data-add-sub]"); addSubtypeButton.style.cssText = "box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;flex:none;width:32px;height:32px;padding:0;background:transparent;border:0;border-radius:0;font:32px/32px Arial,sans-serif;cursor:pointer"; addSubtypeButton.style.setProperty("color", "#fff", "important");
    const dragStyle = document.createElement("style");
    dragStyle.textContent = `.xzg-preset-drag-row { cursor:grab;transition:all .2s;min-width:0 } .xzg-preset-drag-row:hover { background:rgba(255,255,255,.1) !important } .xzg-preset-drag-row:active { cursor:grabbing } .xzg-preset-drag-row.xzg-preset-dragging { opacity:.5;border:1px dashed #4CAF50 !important } .xzg-preset-drag-handle { flex:none;color:#666;font-size:14px;line-height:1;user-select:none;cursor:grab } .xzg-preset-drag-handle:hover { background:rgba(255,255,255,.1) } .xzg-preset-insert-marker { height:3px;flex:none;border-radius:2px;background:#4CAF50;box-shadow:0 0 6px rgba(76,175,80,.8);margin:0 }`;
    panel.appendChild(dragStyle);
    const typeOrder = type => {
        const markers = Object.values(presets).filter(p => p?._typeOnly && p.category === type && Number.isFinite(p.order) && p.order >= 0);
        if (markers.length) return Math.min(...markers.map(p => p.order));
        return Object.values(presets).findIndex(p => p?.category === type);
    };
    const typeNames = () => [...new Set(Object.values(presets).map(p => String(p.category || "").trim()).filter(Boolean))].sort((a,b)=>typeOrder(a)-typeOrder(b)||a.localeCompare(b));
    const itemsFor = type => Object.entries(presets).filter(([,p]) => p.category === type && !p._typeOnly).sort((a,b)=>(a[1].order ?? 0)-(b[1].order ?? 0));
    const hasDragType = (event, type) => event.dataTransfer && Array.from(event.dataTransfer.types).includes(type);
    const clearInsertMarker = list => list.querySelector("[data-insert-marker]")?.remove();
    const showInsertMarker = (list, rows, index) => { clearInsertMarker(list); const marker = document.createElement("div"); marker.dataset.insertMarker = "1"; marker.className = "xzg-preset-insert-marker"; list.insertBefore(marker, rows[index] || null); };
    const presetKeyFor = (type, name, except = null) => {
        if (!Object.entries(presets).some(([key,p]) => key !== except && p.category === type && !p._typeOnly && (p.name || key) === name)) return name;
        return `${type}::${name}`;
    };
    const buttonStyle = "background:transparent;color:#43ffa0 !important;border:0;padding:4px 7px;cursor:pointer;white-space:nowrap";
    const close = () => { overlay.remove(); node._xzgPromptRulePresetDialog = null; };
    const updateNode = () => { for (const n of new Set([node, ...(app.graph?._nodes || [])])) n?._syncTargetModel?.(); };
    const persist = async () => { localStorage.setItem(PROMPT_RULE_PRESETS_KEY, JSON.stringify(presets)); await cloudSave(PROMPT_RULE_PRESETS_KEY, presets).catch(() => {}); updateNode(); };
    const ask = (message, initial="") => new Promise(resolve => {
        const shade = document.createElement("div"); shade.style.cssText = "position:fixed;inset:0;z-index:100010;display:flex;align-items:center;justify-content:center;background:#0009;padding:20px;box-sizing:border-box";
        const box = document.createElement("div"); box.style.cssText = "box-sizing:border-box;width:min(420px,100%);padding:16px;background:#202124;color:#fff;border:1px solid #555;border-radius:7px;box-shadow:0 12px 36px #0009;font:13px Arial,sans-serif";
        const label = document.createElement("div"); label.textContent = message; label.style.cssText = "margin-bottom:10px;color:#fff";
        const input = document.createElement("input"); input.value = initial; input.style.cssText = "box-sizing:border-box;width:100%;padding:8px;background:#151617;color:#fff;border:1px solid #555;border-radius:4px;outline:none";
        const actions = document.createElement("div"); actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:14px";
        const finish = value => { document.removeEventListener("keydown", onKey, true); shade.remove(); resolve(value); };
        const cancel = document.createElement("button"); cancel.textContent = zh ? "取消" : "Cancel"; cancel.style.cssText = "padding:5px 10px;background:#343b49;color:#fff;border:1px solid #555;border-radius:4px;cursor:pointer"; cancel.onclick = () => finish("");
        const ok = document.createElement("button"); ok.textContent = zh ? "确认" : "Confirm"; ok.style.cssText = "padding:5px 10px;background:#343b49;color:#fff;border:1px solid #555;border-radius:4px;cursor:pointer"; ok.onclick = () => finish(input.value.trim());
        const onKey = event => { if (event.key === "Escape") finish(""); else if (event.key === "Enter") finish(input.value.trim()); };
        for (const element of [box, label, input, cancel, ok]) element.style.setProperty("color", "#fff", "important");
        actions.append(cancel, ok); box.append(label, input, actions); shade.appendChild(box); overlay.appendChild(shade); document.addEventListener("keydown", onKey, true); input.focus(); input.select();
    });
    const askConfirm = message => new Promise(resolve => {
        const shade = document.createElement("div"); shade.style.cssText = "position:fixed;inset:0;z-index:100010;display:flex;align-items:center;justify-content:center;background:#0009;padding:20px;box-sizing:border-box";
        const box = document.createElement("div"); box.style.cssText = "box-sizing:border-box;width:min(420px,100%);padding:16px;background:#202124;color:#fff;border:1px solid #555;border-radius:7px;box-shadow:0 12px 36px #0009;font:13px/1.5 Arial,sans-serif";
        const label = document.createElement("div"); label.textContent = message; label.style.cssText = "color:#fff";
        const actions = document.createElement("div"); actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:14px";
        const finish = value => { document.removeEventListener("keydown", onKey, true); shade.remove(); resolve(value); };
        const cancel = document.createElement("button"); cancel.textContent = zh ? "取消" : "Cancel"; cancel.style.cssText = "padding:5px 10px;background:#343b49;color:#fff;border:1px solid #555;border-radius:4px;cursor:pointer"; cancel.onclick = () => finish(false);
        const ok = document.createElement("button"); ok.textContent = zh ? "确认" : "Confirm"; ok.style.cssText = "padding:5px 10px;background:#492d2d;color:#fff;border:1px solid #694141;border-radius:4px;cursor:pointer"; ok.onclick = () => finish(true);
        const onKey = event => { if (event.key === "Escape") finish(false); };
        for (const element of [box, label, cancel, ok]) element.style.setProperty("color", "#fff", "important");
        actions.append(cancel, ok); box.append(label, actions); shade.appendChild(box); overlay.appendChild(shade); document.addEventListener("keydown", onKey, true); ok.focus();
    });
    let typeInsertIndex = null, subtypeInsertIndex = null;
    const reorderTypeDrop = async event => {
        const dragged = event.dataTransfer?.getData("application/x-xzg-prompt-type");
        if (!dragged) return;
        event.preventDefault(); event.stopPropagation();
        const targetIndex = typeInsertIndex; clearInsertMarker(types); typeInsertIndex = null;
        if (targetIndex == null) return;
        const ordered = typeNames(), from = ordered.indexOf(dragged);
        if (from < 0) return;
        const to = from < targetIndex ? targetIndex - 1 : targetIndex;
        if (to === from) return;
        const [moved] = ordered.splice(from, 1); ordered.splice(to, 0, moved);
        ordered.forEach((type, index) => {
            let markers = Object.values(presets).filter(p => p?._typeOnly && p.category === type);
            if (!markers.length) { const marker = { category:type, name:"", rule:"", _typeOnly:true }; presets[`__type__${Date.now()}_${index}_${Math.random().toString(36).slice(2)}`] = marker; markers = [marker]; }
            markers.forEach(marker => { marker.order = (index + 1) * 1000; });
        });
        await persist(); render();
    };
    types.addEventListener("dragover", event => { if (hasDragType(event, "application/x-xzg-prompt-type")) event.preventDefault(); });
    types.addEventListener("drop", reorderTypeDrop);
    types.addEventListener("dragend", () => { clearInsertMarker(types); typeInsertIndex = null; });
    const reorderSubtypeDrop = async event => {
        const dragged = event.dataTransfer?.getData("application/x-xzg-prompt-subtype");
        if (!dragged) return;
        event.preventDefault(); event.stopPropagation();
        const targetIndex = subtypeInsertIndex; clearInsertMarker(subtypes); subtypeInsertIndex = null;
        if (targetIndex == null) return;
        const ordered = itemsFor(activeType).map(([key]) => key), from = ordered.indexOf(dragged);
        if (from < 0) return;
        const to = from < targetIndex ? targetIndex - 1 : targetIndex;
        if (to === from) return;
        const [moved] = ordered.splice(from, 1); ordered.splice(to, 0, moved);
        ordered.forEach((key, index) => { presets[key].order = (index + 1) * 1000; });
        await persist(); render();
    };
    subtypes.addEventListener("dragover", event => { if (hasDragType(event, "application/x-xzg-prompt-subtype")) event.preventDefault(); });
    subtypes.addEventListener("drop", reorderSubtypeDrop);
    subtypes.addEventListener("dragend", () => { clearInsertMarker(subtypes); subtypeInsertIndex = null; });
    const render = () => {
        types.replaceChildren(); subtypes.replaceChildren();
        const categories = typeNames();
        if (!categories.includes(activeType)) activeType = categories[0] || "";
        for (const type of categories) {
            const row = document.createElement("div"); row.draggable = true; row.dataset.typeRow = "1"; row.className = `xzg-preset-drag-row${type === activeType ? " xzg-preset-active" : ""}`; row.style.cssText = "display:flex;align-items:center;box-sizing:border-box;height:40px;gap:6px;padding:6px 8px;background:#2a2a2a;border:1px solid #3a3a3a;border-radius:4px"; if (type === activeType) { row.style.borderLeft = "2px solid #FFD700"; row.style.paddingLeft = "5px"; } row.style.cursor = "grab";
            row.addEventListener("dragstart", event => { if (event.target.closest("button")) { event.preventDefault(); return; } event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-xzg-prompt-type", type); row.classList.add("xzg-preset-dragging"); });
            row.addEventListener("dragend", () => { row.classList.remove("xzg-preset-dragging"); clearInsertMarker(types); typeInsertIndex = null; });
            row.addEventListener("dragover", event => { if (!hasDragType(event, "application/x-xzg-prompt-type")) return; event.preventDefault(); const rect = row.getBoundingClientRect(), rows = [...types.querySelectorAll("[data-type-row]")], index = rows.indexOf(row); typeInsertIndex = event.clientY - rect.top < rect.height / 2 ? index : index + 1; showInsertMarker(types, rows, typeInsertIndex); });
            row.addEventListener("drop", event => { if (hasDragType(event, "application/x-xzg-prompt-type")) reorderTypeDrop(event); });
            row.addEventListener("click", event => { if (event.target.closest("button")) return; activeType = type; render(); });
            const dragHandle = document.createElement("span"); dragHandle.className = "xzg-preset-drag-handle"; dragHandle.textContent = "⠿"; dragHandle.title = zh ? "拖动调整顺序" : "Drag to reorder";
            const label = document.createElement("span"); label.textContent = type; label.title = type; label.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#fff;cursor:pointer"; label.onclick = () => { activeType = type; render(); };
            const rename = document.createElement("button"); rename.textContent = "✎"; rename.title = zh ? "重命名" : "Rename"; rename.style.cssText = `${buttonStyle};box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;flex:none;width:24px;height:24px;padding:0;font-size:16px;line-height:24px`; rename.style.setProperty("color", "#fff", "important"); rename.onclick = async () => { const next = await ask(zh ? "重命名提示词类型" : "Rename prompt type", type); const reserved = ["MiniMax-H3", "QWEN", "Qwen-Image-2.1 图像", "Qwen-Image-2.1 Image", "自定义提示词规则", "Custom Prompt Rules", "自定义 Skill", "Custom Skill"]; if (!next || (next !== type && (categories.includes(next) || reserved.includes(next)))) return; for (const p of Object.values(presets)) if (p.category === type) p.category = next; for (const n of new Set([node, ...(app.graph?._nodes || [])])) { const w=n?.widgets?.find(item=>item.name==="target_model"); if (w?.value===type) w.value=next; } activeType = next; await persist(); render(); };
            const del = document.createElement("button"); del.textContent = "×"; del.title = zh ? "删除" : "Delete"; del.style.cssText = `${buttonStyle};box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;flex:none;width:24px;height:24px;padding:0;font-size:26px;line-height:24px`; del.style.setProperty("color", "#c75c5c", "important"); del.onclick = async () => { if (!await askConfirm(zh ? `删除类型“${type}”及其所有细分和规则？` : `Delete type “${type}” and all its subtypes and rules?`)) return; for (const [key,p] of Object.entries(presets)) if (p.category === type) delete presets[key]; activeType = ""; await persist(); render(); };
            row.append(dragHandle,label,rename,del); types.appendChild(row);
        }
        panel.querySelector("[data-subtitle]").textContent = zh ? "提示词细分" : "Prompt Subcategories";
        const entries = itemsFor(activeType);
        if (!entries.length) { const empty = document.createElement("div"); empty.textContent = activeType ? (zh ? "此类型下还没有细分" : "No subtypes in this type yet") : (zh ? "请先新建提示词类型" : "Create a prompt type first"); empty.style.cssText = "margin:auto;padding:20px;text-align:center;color:#fff"; subtypes.appendChild(empty); }
        for (const [key,p] of entries) {
            const row = document.createElement("div"); row.draggable = true; row.dataset.subtypeRow = "1"; row.className = "xzg-preset-drag-row"; row.style.cssText = "display:flex;align-items:center;box-sizing:border-box;height:40px;gap:6px;padding:6px 8px;background:#2a2a2a;border:1px solid #3a3a3a;border-radius:4px";
            row.addEventListener("dragstart", event => { if (event.target.closest("button")) { event.preventDefault(); return; } event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-xzg-prompt-subtype", key); row.classList.add("xzg-preset-dragging"); });
            row.addEventListener("dragend", () => { row.classList.remove("xzg-preset-dragging"); clearInsertMarker(subtypes); subtypeInsertIndex = null; });
            row.addEventListener("dragover", event => { if (!hasDragType(event, "application/x-xzg-prompt-subtype")) return; event.preventDefault(); const rect = row.getBoundingClientRect(), rows = [...subtypes.querySelectorAll("[data-subtype-row]")], index = rows.indexOf(row); subtypeInsertIndex = event.clientY - rect.top < rect.height / 2 ? index : index + 1; showInsertMarker(subtypes, rows, subtypeInsertIndex); });
            row.addEventListener("drop", event => { if (hasDragType(event, "application/x-xzg-prompt-subtype")) reorderSubtypeDrop(event); });
            const dragHandle = document.createElement("span"); dragHandle.className = "xzg-preset-drag-handle"; dragHandle.textContent = "⠿"; dragHandle.title = zh ? "拖动调整顺序" : "Drag to reorder";
            const label = document.createElement("span"); label.textContent = p.name || key; label.style.cssText = "flex:1;min-width:0;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
            const hasRuleContent = typeof p.rule === "string" && p.rule.trim().length > 0;
            const ruleContentDot = hasRuleContent ? document.createElement("span") : null;
            if (ruleContentDot) { ruleContentDot.title = zh ? "已有规则内容" : "Has rule content"; ruleContentDot.setAttribute("aria-label", ruleContentDot.title); ruleContentDot.style.cssText = "width:6px;height:6px;flex:none;border-radius:50%;background:#fff;box-shadow:0 0 4px rgba(255,255,255,.65)"; }
            const rename = document.createElement("button"); rename.textContent = zh ? "重命名" : "Rename"; rename.style.cssText = buttonStyle; rename.style.setProperty("color", "#fff", "important"); rename.onclick = async () => { const next = await ask(zh ? "重命名细分" : "Rename subtype", p.name || key); if (!next || next === (p.name || key) || itemsFor(activeType).some(([otherKey,other]) => otherKey !== key && (other.name || otherKey) === next)) return; const nextKey = presetKeyFor(activeType,next,key); presets[nextKey] = {...p,name:next}; delete presets[key]; for (const n of new Set([node, ...(app.graph?._nodes || [])])) { const t=n?.widgets?.find(item=>item.name==="target_model"), m=n?.widgets?.find(item=>item.name==="generation_mode"); if (t?.value===activeType && m?.value===(p.name || key)) m.value=next; } if (activeName === key) activeName = nextKey; await persist(); render(); };
            const edit = document.createElement("button"); edit.textContent = zh ? "编辑内容" : "Edit Content"; edit.style.cssText = buttonStyle; edit.style.setProperty("color", "#fff", "important"); edit.onclick = () => { activeName = key; panel.querySelector("[data-editor-label]").textContent = `${p.category} / ${p.name || key}`; content.value = p.rule || ""; panel.querySelector("main").style.display = "none"; editorView.style.display = "flex"; setEditorConfirmDisabled(true); };
            const del = document.createElement("button"); del.textContent = zh ? "删除" : "Delete"; del.style.cssText = buttonStyle; del.style.setProperty("color", "#c75c5c", "important"); del.onclick = async () => { if (!await askConfirm(zh ? `删除细分“${p.name || key}”及其规则？` : `Delete subtype “${p.name || key}” and its rule?`)) return; delete presets[key]; await persist(); render(); };
            row.append(dragHandle); if (ruleContentDot) row.append(ruleContentDot); row.append(label,rename,edit,del); subtypes.appendChild(row);
        }
    };
    panel.querySelector("[data-add-type]").onclick = async () => { const type = await ask(zh ? "新建提示词类型" : "New prompt type"); const reserved = ["MiniMax-H3", "QWEN", "Qwen-Image-2.1 图像", "Qwen-Image-2.1 Image", "自定义提示词规则", "Custom Prompt Rules", "自定义 Skill", "Custom Skill"]; if (!type || typeNames().includes(type) || reserved.includes(type)) return; const nextOrder = typeNames().reduce((max, name) => Math.max(max, typeOrder(name)), 0) + 1000; presets[`__type__${Date.now()}`] = {category:type,name:"",rule:"",order:nextOrder,_typeOnly:true}; activeType = type; await persist(); render(); };
    panel.querySelector("[data-add-sub]").onclick = async () => { if (!activeType) return; const name = await ask(zh ? "新增提示词细分" : "New prompt subtype"); if (!name || itemsFor(activeType).some(([,p]) => (p.name || "") === name)) return; const key = presetKeyFor(activeType,name); const nextOrder = itemsFor(activeType).reduce((max, [,item]) => Math.max(max, Number.isFinite(item.order) ? item.order : 0), 0) + 1000; presets[key] = {category:activeType,name,rule:"",order:nextOrder}; activeName = key; await persist(); render(); panel.querySelector("[data-editor-label]").textContent = `${activeType} / ${name}`; content.value = ""; panel.querySelector("main").style.display = "none"; editorView.style.display = "flex"; setEditorConfirmDisabled(true); };
    panel.querySelector("[data-import]").onclick = () => panel.querySelector("[data-file]").click();
    panel.querySelector("[data-file]").onchange = async e => { const file=e.target.files?.[0]; if (file && /\.(txt|md)$/i.test(file.name)) { content.value=await file.text(); if (!activeName) { const name=file.name.replace(/\.(txt|md)$/i,""); presets[name]={category:activeType || "自定义提示词规则",name,rule:content.value}; activeName=name; panel.querySelector("[data-editor-label]").textContent=`${activeType} / ${name}`; } } e.target.value=""; };
    panel.querySelector("[data-save]").onclick = async () => { if (!activeName || !presets[activeName]) return; presets[activeName].rule=content.value; presets[activeName].updatedAt=new Date().toISOString(); await persist(); editorView.style.display="none"; panel.querySelector("main").style.display="flex"; setEditorConfirmDisabled(false); render(); };
    panel.querySelector("[data-back]").onclick = () => { editorView.style.display="none"; panel.querySelector("main").style.display="flex"; setEditorConfirmDisabled(false); render(); };
    panel.querySelector("[data-close]").onclick = close; render();
}
const QWEN_MODE_LABELS = {
    zh: ["Qwen-Image-2.1 文生图", "Qwen-Image-2.1 图像编辑", "Qwen-Image-2.1 多参考图"],
    en: ["Text to Image", "Image Editing", "Multi-Reference Image"],
};
const OUTPUT_LANGUAGE_LABELS = {
    zh: ["仅英文", "仅中文", "中英双语"],
    en: ["English Only", "Chinese Only", "Chinese + English"],
};
app.registerExtension({
    name: "Xiaozhuguang.H3Prompt",
    async beforeRegisterNodeDef(nodeType, nodeData, _app) {
        // ── 小珠光通用提示词 ──
        if (nodeData.name === "XiaozhuguangNinimaxH3Prompt" || nodeData.name === "XiaozhuguangNinimaxH3PromptNoSkill") {
            const supportsCustomPromptRules = nodeData.name === "XiaozhuguangNinimaxH3Prompt";
            // 获取图片接口名称（始终使用 image_N 格式，本地化通过 locale 文件处理）
            nodeType.prototype._xzgImgName = function (num) {
                return `image_${num}`;
            };

            // 判断是否为动态图片接口
            nodeType.prototype._isXzgImg = function (inp) {
                if (!inp || !inp.name) return false;
                return inp.name.startsWith("image_");
            };

            // 从名称中提取编号
            nodeType.prototype._xzgImgNum = function (name) {
                if (name.startsWith("image_")) return parseInt(name.split("_")[1]);
                return NaN;
            };

            nodeType.prototype._addComboControlInputs = function () {
                const labels = xzgLang() === "zh"
                    ? { target_model: "提示词类型", generation_mode: "提示词细分" }
                    : { target_model: "Prompt Type", generation_mode: "Prompt Subtype" };
                for (const [name, label] of Object.entries(labels)) {
                    if (this.inputs?.some(input => input.name === name)) continue;
                    const input = this.addInput(name, "*", {
                        tooltip: "Connect STRING or TEXT to override this selection",
                    });
                    input.label = label;
                }
            };

            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const r = onNodeCreated?.apply(this, arguments);
                this.setSize([300, 400]);
                this._addComboControlInputs();
                this._hideExtraImageInputs();
                this._ensureTargetModelCombo();
                this._syncTargetModel();
                if (supportsCustomPromptRules) {
                    this._addPromptRulePresetControls();
                    this._restorePromptRulePresets();
                }
                const targetWidget = this.widgets?.find(w => w.name === "target_model");
                if (targetWidget) {
                    const originalCallback = targetWidget.callback;
                    targetWidget.callback = (...args) => {
                        const result = originalCallback?.apply(targetWidget, args);
                        this._syncTargetModel();
                        return result;
                    };
                }
                return r;
            };

            // Qwen-Image-2.1 使用图像生成/编辑模式；H3 保持视频生成模式。
            nodeType.prototype._ensureTargetModelCombo = function () {
                const ensureCombo = (name, flag, fallback, values) => {
                    let widget = this.widgets?.find(w => w.name === name);
                    if (!widget) return null;
                    if (widget.type !== "combo" && !this[flag]) {
                        const index = this.widgets.indexOf(widget);
                        const value = widget.value ?? fallback;
                        const callback = widget.callback;
                        this.widgets.splice(index, 1);
                        const combo = this.addWidget("combo", name, value, function (...args) {
                            return callback?.apply(this, args);
                        }, { values });
                        const newIndex = this.widgets.indexOf(combo);
                        this.widgets.splice(newIndex, 1);
                        this.widgets.splice(index, 0, combo);
                        widget = combo;
                        this[flag] = true;
                    }
                    widget.options = widget.options || {};
                    return widget;
                };
                const lang = xzgLang();
                const labels = TARGET_LABELS[lang] || TARGET_LABELS.zh;
                const targetValues = supportsCustomPromptRules ? [labels.h3, labels.qwen, labels.custom] : [labels.h3, labels.qwen];
                ensureCombo("target_model", "_xzgTargetComboRebuilt", labels.h3, targetValues);
                ensureCombo("generation_mode", "_xzgGenerationModeComboRebuilt", H3_GEN_MODES[0], [...H3_GEN_MODES]);
            };

            nodeType.prototype._syncTargetModel = function () {
                this._ensureTargetModelCombo();
                const targetWidget = this.widgets?.find(w => w.name === "target_model");
                const gmWidget = this.widgets?.find(w => w.name === "generation_mode");
                if (!gmWidget?.options) return;
                const lang = xzgLang();
                const labels = TARGET_LABELS[lang] || TARGET_LABELS.zh;
                if (targetWidget) targetWidget.label = lang === "zh" ? "提示词类型" : "Prompt Type";
                if (gmWidget) gmWidget.label = lang === "zh" ? "提示词细分" : "Prompt Subtype";
                const outputLanguageWidget = this.widgets?.find(w => w.name === "output_language");
                if (outputLanguageWidget?.options) {
                    const outputLanguageIndex = ({
                        "仅英文": 0, "English Only": 0,
                        "仅中文": 1, "Chinese Only": 1,
                        "中英双语": 2, "Chinese + English": 2,
                    })[outputLanguageWidget.value] ?? 0;
                    outputLanguageWidget.options.values = OUTPUT_LANGUAGE_LABELS[lang] || OUTPUT_LANGUAGE_LABELS.zh;
                    outputLanguageWidget.value = outputLanguageWidget.options.values[outputLanguageIndex];
                }
                if (targetWidget?.options) {
                    let presets = {};
                    if (supportsCustomPromptRules) {
                        try { presets = JSON.parse(localStorage.getItem(PROMPT_RULE_PRESETS_KEY) || "{}"); } catch (_) {}
                    }
                    const oldValue = targetWidget.value || "";
                    const isQwen = oldValue === QWEN_IMAGE_TARGET || oldValue === QWEN_IMAGE_TARGET_EN || oldValue === "QWEN";
                    const presetCategories = [...new Set(Object.values(presets || {}).map(entry => String(entry?.category || "").trim()).filter(Boolean))];
                    const isCustom = supportsCustomPromptRules && (["自定义 Skill", "Custom Skill", "自定义提示词规则", "Custom Prompt Rules"].includes(oldValue) || presetCategories.includes(oldValue));
                    if (gmWidget) gmWidget.label = isCustom
                        ? (lang === "zh" ? "规则预设" : "Rule Preset")
                        : (lang === "zh" ? "提示词细分" : "Prompt Subtype");
                    const values = supportsCustomPromptRules ? [...new Set([labels.h3, labels.qwen, ...presetCategories])] : [labels.h3, labels.qwen];
                    targetWidget.options.values = values;
                    const selectedType = presetCategories.includes(oldValue) ? oldValue : labels.custom;
                    targetWidget.value = isCustom ? selectedType : isQwen ? labels.qwen : labels.h3;
                    const presetNames = presets && typeof presets === "object" && !Array.isArray(presets)
                        ? xzgOrderedPromptRulePresetNames(presets).filter(name => !presets[name]?._typeOnly) : [];
                    if (gmWidget?.options) {
                        if (isCustom) {
                            const subtypeNames = presetNames.filter(name => String(presets[name]?.category || "自定义提示词规则") === selectedType).map(name => String(presets[name]?.name || name));
                            gmWidget.options.values = subtypeNames.length ? subtypeNames : [lang === "zh" ? "（请先保存规则预设）" : "(Save a rule preset first)"];
                            const wanted = gmWidget.value;
                            gmWidget.value = subtypeNames.includes(wanted) ? wanted : (subtypeNames[0] || gmWidget.options.values[0]);
                        } else if (isQwen) {
                            const oldMode = gmWidget.value;
                            gmWidget.options.values = QWEN_MODE_LABELS[lang] || QWEN_MODE_LABELS.zh;
                            const canonical = ({
                                "Qwen-Image-2.1 文生图": 0, "Text to Image": 0,
                                "Qwen-Image-2.1 图像编辑": 1, "Image Editing": 1,
                                "Qwen-Image-2.1 多参考图": 2, "Multi-Reference Image": 2,
                            })[oldMode];
                            gmWidget.value = gmWidget.options.values[canonical ?? 0];
                        } else {
                            gmWidget.options.values = H3_GEN_MODES;
                            gmWidget.value = H3_GEN_MODES.includes(gmWidget.value) ? gmWidget.value : H3_GEN_MODES[0];
                        }
                    }
                }
            };

            nodeType.prototype._restorePromptRulePresets = function () {
                if (!promptRulePresetsRestorePromise) {
                    promptRulePresetsRestorePromise = (async () => {
                        let data = await cloudLoad(PROMPT_RULE_PRESETS_KEY, { fallbackValue: null });
                        let migrated = false;
                        if (!data || typeof data !== "object" || Array.isArray(data)) {
                            data = await cloudLoad(LEGACY_SKILL_PRESETS_KEY, { fallbackValue: {} });
                            migrated = true;
                        }
                        const normalized = normalizePromptRulePresets(data);
                        if (migrated || Object.values(data || {}).some(entry => entry && typeof entry === "object" && typeof entry.rule !== "string" && typeof entry.skill === "string")) {
                            await cloudSave(PROMPT_RULE_PRESETS_KEY, normalized).catch(() => {});
                        } else {
                            try { localStorage.setItem(PROMPT_RULE_PRESETS_KEY, JSON.stringify(normalized)); } catch (_) {}
                        }
                        try { localStorage.removeItem(LEGACY_SKILL_PRESETS_KEY); } catch (_) {}
                        return normalized;
                    })().catch(() => ({}));
                }
                promptRulePresetsRestorePromise.then(() => this._refreshPromptRulePresetTypes());
            };

            nodeType.prototype._refreshPromptRulePresetTypes = function () {
                for (const node of app.graph?._nodes || []) {
                    if (node?.type === "XiaozhuguangNinimaxH3Prompt" || node?.constructor?.name === "XiaozhuguangNinimaxH3Prompt" || node?.type === "XiaozhuguangNinimaxH3PromptNoSkill" || node?.constructor?.name === "XiaozhuguangNinimaxH3PromptNoSkill") {
                        node._syncTargetModel?.();
                    }
                }
                window.XZGRefreshPromptRulePresetTypes = () => {
                    for (const node of app.graph?._nodes || []) node?._syncTargetModel?.();
                };
                window.XZGRefreshSkillPresetTypes = window.XZGRefreshPromptRulePresetTypes;
            };

            nodeType.prototype._addPromptRulePresetControls = function () {
                if (this._xzgPromptRulePresetControlsAdded) return;
                this._xzgPromptRulePresetControlsAdded = true;
                const storageKey = PROMPT_RULE_PRESETS_KEY;
                const getRulePresets = () => {
                    try {
                        const parsed = JSON.parse(localStorage.getItem(storageKey) || "{}");
                        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
                    } catch (_) { return {}; }
                };
                this.addWidget("button", xzgLang() === "zh" ? "提示词规则管理" : "Manage Prompt Rules", null, async () => {
                    openPromptRuleManager(this);
                    return;
                    if (this._xzgPromptRulePresetDialog || this._xzgPromptRulePresetOpening) return;
                    this._xzgPromptRulePresetOpening = true;
                    try { await cloudUIInit(); } catch (_) {}
                    this._restorePromptRulePresets();
                    try { await promptRulePresetsRestorePromise; } catch (_) {}
                    this._xzgPromptRulePresetOpening = false;
                    if (this._xzgPromptRulePresetDialog) return;
                    const zh = xzgLang() === "zh";
                    const overlay = document.createElement("div");
                    overlay.style.cssText = "position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.62);display:block;padding:20px;box-sizing:border-box;";
                    const panel = document.createElement("div");
                    panel.style.cssText = "box-sizing:border-box;position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(760px, calc(100vw - 40px));height:min(700px, calc(100vh - 40px));min-width:min(520px, calc(100vw - 40px));min-height:min(400px, calc(100vh - 40px));max-width:calc(100vw - 40px);max-height:calc(100vh - 40px);display:flex;flex-direction:column;background:#202124;color:#eee;border:1px solid #555;border-radius:8px;box-shadow:0 16px 48px #0009;font:13px Arial,sans-serif;overflow:hidden;";
                    panel.innerHTML = `<div style="display:flex;align-items:center;padding:13px 16px;border-bottom:1px solid #444;font-size:15px;font-weight:600;flex:none"><span style="flex:1">${zh ? "自定义提示词规则管理" : "Custom Prompt Rules Manager"}</span><button data-close style="background:#343b49;border:1px solid #555;border-radius:4px;color:#ddd;font-size:13px;padding:5px 10px;cursor:pointer">${zh ? "确认" : "Confirm"}</button></div><div style="padding:12px 16px 8px;display:flex;gap:8px;flex:none"><input data-name maxlength="80" placeholder="${zh ? "规则名称" : "Rule name"}" style="flex:1;min-width:0;background:#151617;color:#eee;border:1px solid #555;border-radius:5px;padding:8px"><button data-import style="background:#343b49;color:#ddd;border:1px solid #555;border-radius:5px;padding:0 12px;cursor:pointer">${zh ? "导入 .txt / .md" : "Import .txt / .md"}</button><input data-file type="file" accept=".txt,.md,text/plain,text/markdown" style="display:none"><button data-save style="background:#3a7653;color:white;border:0;border-radius:5px;padding:0 14px;cursor:pointer">${zh ? "保存规则" : "Save Rule"}</button></div><textarea data-rule spellcheck="false" placeholder="${zh ? "在这里编写或编辑给模型使用的提示词规则，也可以拖入 .txt / .md 文件" : "Write or edit reusable prompt rules for the model, or drop a .txt / .md file"}" style="box-sizing:border-box;width:calc(100% - 32px);flex:1;min-height:120px;resize:none;margin:4px 16px 12px;padding:10px;background:#151617;color:#eee;border:1px solid #555;border-radius:5px;font:12px/1.5 Consolas,monospace"></textarea><div data-list style="flex:3;overflow:auto;padding:0 16px 14px;min-height:70px"></div><div style="padding:10px 16px;border-top:1px solid #444;color:#999;font-size:11px;flex:none">${zh ? "拖动标题栏移动、拖动右下角调整大小；点击名称加载，点击“编辑”修改名称和内容，拖动左侧手柄排序。" : "Drag the title bar to move and the lower-right corner to resize. Click a name to load it, use Edit to change it, and drag its handle to reorder."}</div>`;
                    const splitter = document.createElement("div");
                    splitter.title = zh ? "上下拖动调整规则编辑区高度" : "Drag vertically to resize the rule editor";
                    splitter.setAttribute("aria-label", splitter.title);
                    splitter.style.cssText = "box-sizing:border-box;flex:0 0 10px;height:10px;display:flex;align-items:center;justify-content:center;cursor:row-resize;touch-action:none;user-select:none";
                    splitter.innerHTML = "<span style=\"width:44px;height:2px;border-radius:2px;background:#555;pointer-events:none\"></span>";
                    panel.insertBefore(splitter, panel.querySelector("[data-list]"));
                    let persistDialogGeometry = () => {};
                    let fitEditorToDialog = () => {};
                    const resizeHandle = document.createElement("div");
                    resizeHandle.title = zh ? "拖动调整对话框大小" : "Drag to resize dialog";
                    resizeHandle.style.cssText = "position:absolute;right:1px;bottom:1px;width:18px;height:18px;z-index:2;cursor:nwse-resize;touch-action:none;user-select:none;background:linear-gradient(135deg,transparent 0 48%,#666 49% 55%,transparent 56% 66%,#888 67% 73%,transparent 74%)";
                    panel.appendChild(resizeHandle);
                    resizeHandle.addEventListener("pointerdown", e => {
                        if (e.button !== 0) return;
                        e.preventDefault();
                        e.stopPropagation();
                        const rect = panel.getBoundingClientRect();
                        const startX = e.clientX;
                        const startY = e.clientY;
                        const startWidth = rect.width;
                        const startHeight = rect.height;
                        panel.style.left = `${rect.left}px`;
                        panel.style.top = `${rect.top}px`;
                        panel.style.transform = "none";
                        panel.style.width = `${startWidth}px`;
                        panel.style.height = `${startHeight}px`;
                        const minWidth = Math.min(520, window.innerWidth - 40);
                        const minHeight = Math.min(400, window.innerHeight - 40);
                        const maxWidth = Math.max(minWidth, window.innerWidth - rect.left - 20);
                        const maxHeight = Math.max(minHeight, window.innerHeight - rect.top - 20);
                        const onMove = moveEvent => {
                            panel.style.width = `${Math.max(minWidth, Math.min(maxWidth, startWidth + moveEvent.clientX - startX))}px`;
                            panel.style.height = `${Math.max(minHeight, Math.min(maxHeight, startHeight + moveEvent.clientY - startY))}px`;
                            fitEditorToDialog();
                        };
                        const onEnd = () => {
                            resizeHandle.removeEventListener("pointermove", onMove);
                            resizeHandle.removeEventListener("pointerup", onEnd);
                            resizeHandle.removeEventListener("pointercancel", onEnd);
                            persistDialogGeometry();
                        };
                        resizeHandle.setPointerCapture(e.pointerId);
                        resizeHandle.addEventListener("pointermove", onMove);
                        resizeHandle.addEventListener("pointerup", onEnd, { once: true });
                        resizeHandle.addEventListener("pointercancel", onEnd, { once: true });
                    });
                    const titleBar = panel.firstElementChild;
                    const closeButton = titleBar.querySelector("[data-close]");
                    titleBar.style.cursor = "move";
                    titleBar.style.userSelect = "none";
                    closeButton.style.cursor = "pointer";
                    titleBar.addEventListener("pointerdown", e => {
                        if (e.button !== 0 || e.target.closest("button")) return;
                        e.preventDefault();
                        const rect = panel.getBoundingClientRect();
                        const startX = e.clientX;
                        const startY = e.clientY;
                        const startLeft = rect.left;
                        const startTop = rect.top;
                        panel.style.left = `${startLeft}px`;
                        panel.style.top = `${startTop}px`;
                        panel.style.transform = "none";
                        const onMove = moveEvent => {
                            const maxLeft = Math.max(0, window.innerWidth - rect.width);
                            const maxTop = Math.max(0, window.innerHeight - rect.height);
                            panel.style.left = `${Math.max(0, Math.min(maxLeft, startLeft + moveEvent.clientX - startX))}px`;
                            panel.style.top = `${Math.max(0, Math.min(maxTop, startTop + moveEvent.clientY - startY))}px`;
                        };
                        const onEnd = () => {
                            titleBar.removeEventListener("pointermove", onMove);
                            titleBar.removeEventListener("pointerup", onEnd);
                            titleBar.removeEventListener("pointercancel", onEnd);
                            persistDialogGeometry();
                        };
                        titleBar.setPointerCapture(e.pointerId);
                        titleBar.addEventListener("pointermove", onMove);
                        titleBar.addEventListener("pointerup", onEnd, { once: true });
                        titleBar.addEventListener("pointercancel", onEnd, { once: true });
                    });
                    overlay.appendChild(panel);
                    document.body.appendChild(overlay);
                    this._xzgPromptRulePresetDialog = overlay;
                    const saveDialogGeometry = () => {
                        const rect = panel.getBoundingClientRect();
                        const geometry = {
                            left: Math.round(rect.left),
                            top: Math.round(rect.top),
                            width: Math.round(rect.width),
                            height: Math.round(rect.height),
                            editorHeight: Math.round(panel.querySelector("[data-rule]").getBoundingClientRect().height),
                        };
                        try { localStorage.setItem(PROMPT_RULE_MANAGER_GEOMETRY_KEY, JSON.stringify(geometry)); } catch (_) {}
                        cloudUIQueueGeometry();
                    };
                    persistDialogGeometry = saveDialogGeometry;
                    let savedGeometry = null;
                    try {
                        const saved = JSON.parse(localStorage.getItem(PROMPT_RULE_MANAGER_GEOMETRY_KEY) || localStorage.getItem(LEGACY_PROMPT_RULE_MANAGER_GEOMETRY_KEY) || "null");
                        savedGeometry = saved;
                        if (saved && [saved.left, saved.top, saved.width, saved.height].every(Number.isFinite)) {
                            const minWidth = Math.min(520, window.innerWidth - 40);
                            const minHeight = Math.min(400, window.innerHeight - 40);
                            const width = Math.max(minWidth, Math.min(window.innerWidth - 40, saved.width));
                            const height = Math.max(minHeight, Math.min(window.innerHeight - 40, saved.height));
                            panel.style.transform = "none";
                            panel.style.width = `${width}px`;
                            panel.style.height = `${height}px`;
                            panel.style.left = `${Math.max(0, Math.min(window.innerWidth - width, saved.left))}px`;
                            panel.style.top = `${Math.max(0, Math.min(window.innerHeight - height, saved.top))}px`;
                        }
                    } catch (_) {}
                    const close = () => { overlay.remove(); this._xzgPromptRulePresetDialog = null; };
                    panel.querySelector("[data-close]").onclick = close;
                    const editor = panel.querySelector("[data-rule]");
                    const nameInput = panel.querySelector("[data-name]");
                    const saveButton = panel.querySelector("[data-save]");
                    editor.style.minHeight = "80px";
                    if (Number.isFinite(savedGeometry?.editorHeight)) {
                        const maxEditorHeight = Math.max(80, panel.clientHeight - 240);
                        editor.style.flex = `0 0 ${Math.min(maxEditorHeight, Math.max(80, savedGeometry.editorHeight))}px`;
                    }
                    fitEditorToDialog = () => {
                        const maxEditorHeight = Math.max(80, panel.clientHeight - 240);
                        if (editor.getBoundingClientRect().height > maxEditorHeight) {
                            editor.style.flex = `0 0 ${maxEditorHeight}px`;
                        }
                    };
                    splitter.addEventListener("pointerdown", e => {
                        if (e.button !== 0) return;
                        e.preventDefault();
                        const list = panel.querySelector("[data-list]");
                        const startY = e.clientY;
                        const startEditorHeight = editor.getBoundingClientRect().height;
                        const startListHeight = list.getBoundingClientRect().height;
                        const minEditorHeight = 80;
                        const minListHeight = 70;
                        const maxEditorHeight = Math.max(minEditorHeight, startEditorHeight + startListHeight - minListHeight);
                        const onMove = moveEvent => {
                            const nextHeight = Math.max(minEditorHeight, Math.min(maxEditorHeight, startEditorHeight + moveEvent.clientY - startY));
                            editor.style.flex = `0 0 ${nextHeight}px`;
                        };
                        const onEnd = () => {
                            splitter.removeEventListener("pointermove", onMove);
                            splitter.removeEventListener("pointerup", onEnd);
                            splitter.removeEventListener("pointercancel", onEnd);
                            persistDialogGeometry();
                        };
                        splitter.setPointerCapture(e.pointerId);
                        splitter.addEventListener("pointermove", onMove);
                        splitter.addEventListener("pointerup", onEnd, { once: true });
                        splitter.addEventListener("pointercancel", onEnd, { once: true });
                    });
                    let editingRuleName = null;
                    const clearButton = document.createElement("button");
                    clearButton.textContent = zh ? "清空" : "Clear";
                    clearButton.title = zh ? "清空名称和规则内容" : "Clear the name and rule content";
                    clearButton.style.cssText = "background:#343b49;color:#ddd;border:1px solid #555;border-radius:5px;padding:0 12px;cursor:pointer";
                    saveButton.parentElement.insertBefore(clearButton, saveButton);
                    clearButton.onclick = () => {
                        nameInput.value = "";
                        editor.value = "";
                        editingRuleName = null;
                        saveButton.textContent = zh ? "保存规则" : "Save Rule";
                        nameInput.focus();
                    };
                    const fileInput = panel.querySelector("[data-file]");
                    panel.querySelector("[data-import]").onclick = () => fileInput.click();
                    fileInput.onchange = async () => {
                        const file = fileInput.files?.[0];
                        if (!file) return;
                        if (!/\.(txt|md)$/i.test(file.name)) {
                            editor.placeholder = zh ? "只支持 .txt 和 .md 文件" : "Only .txt and .md files are supported";
                            fileInput.value = "";
                            return;
                        }
                        editor.value = await file.text();
                        if (!nameInput.value.trim()) nameInput.value = file.name.replace(/\.(txt|md)$/i, "");
                        fileInput.value = "";
                    };
                    editor.addEventListener("dragover", e => { e.preventDefault(); editor.style.borderColor = "#68b38a"; });
                    editor.addEventListener("dragleave", () => { editor.style.borderColor = "#555"; });
                    editor.addEventListener("drop", async e => {
                        e.preventDefault();
                        editor.style.borderColor = "#555";
                        const file = e.dataTransfer?.files?.[0];
                        if (!file) return;
                        if (!/\.(txt|md)$/i.test(file.name)) {
                            editor.placeholder = zh ? "只支持 .txt 和 .md 文件" : "Only .txt and .md files are supported";
                            return;
                        }
                        editor.value = await file.text();
                        if (!nameInput.value.trim()) nameInput.value = file.name.replace(/\.(txt|md)$/i, "");
                    });
                    const renderList = () => {
                        const list = panel.querySelector("[data-list]");
                        const presets = getRulePresets();
                        const names = xzgOrderedPromptRulePresetNames(presets);
                        list.replaceChildren();
                        if (!names.length) {
                            const empty = document.createElement("div");
                            empty.textContent = zh ? "暂无规则预设。填写提示词规则后，可在上方保存。" : "No rule presets yet. Enter prompt rules and save them above.";
                            empty.style.cssText = "padding:22px 8px;text-align:center;color:#999";
                            list.appendChild(empty);
                            return;
                        }
                        for (const name of names) {
                            const row = document.createElement("div");
                            row.dataset.presetName = name;
                            row.style.cssText = "display:flex;align-items:center;gap:6px;padding:3px 2px;border-bottom:1px solid #383838;transition:border-color .12s,opacity .12s";
                            const dragHandle = document.createElement("span");
                            dragHandle.textContent = "⠿";
                            dragHandle.title = zh ? "拖动调整顺序" : "Drag to reorder";
                            dragHandle.draggable = true;
                            dragHandle.style.cssText = "color:#888;font-size:18px;padding:2px 5px;cursor:grab;user-select:none";
                            dragHandle.addEventListener("dragstart", e => {
                                e.dataTransfer?.setData("text/plain", name);
                                if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
                                row.style.opacity = ".45";
                            });
                            dragHandle.addEventListener("dragend", () => {
                                row.style.opacity = "1";
                                for (const item of list.querySelectorAll("[data-preset-name]")) item.style.borderTop = item.style.borderBottom = "";
                            });
                            row.addEventListener("dragover", e => {
                                e.preventDefault();
                                if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
                                const rect = row.getBoundingClientRect();
                                const before = e.clientY < rect.top + rect.height / 2;
                                row.style.borderTop = before ? "2px solid #68b38a" : "";
                                row.style.borderBottom = before ? "" : "2px solid #68b38a";
                            });
                            row.addEventListener("dragleave", e => {
                                if (!row.contains(e.relatedTarget)) row.style.borderTop = row.style.borderBottom = "";
                            });
                            row.addEventListener("drop", e => {
                                e.preventDefault();
                                const draggedName = e.dataTransfer?.getData("text/plain");
                                const draggedRow = [...list.querySelectorAll("[data-preset-name]")].find(item => item.dataset.presetName === draggedName);
                                row.style.borderTop = row.style.borderBottom = "";
                                if (!draggedRow || draggedRow === row) return;
                                const rect = row.getBoundingClientRect();
                                const before = e.clientY < rect.top + rect.height / 2;
                                list.insertBefore(draggedRow, before ? row : row.nextSibling);
                                const orderedNames = [...list.querySelectorAll("[data-preset-name]")].map(item => item.dataset.presetName);
                                const updated = getRulePresets();
                                orderedNames.forEach((presetName, index) => {
                                    if (updated[presetName]) updated[presetName] = { ...updated[presetName], order: index };
                                });
                                cloudSave(storageKey, updated).catch(() => {});
                                this._refreshPromptRulePresetTypes();
                                renderList();
                            });
                            const apply = document.createElement("button");
                            apply.textContent = name;
                            apply.style.cssText = "flex:1;min-width:0;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:transparent;color:#ddd;border:0;padding:5px;cursor:pointer";
                            apply.onclick = () => {
                                const targetWidget = this.widgets?.find(w => w.name === "target_model");
                                const labels = TARGET_LABELS[xzgLang()] || TARGET_LABELS.zh;
                                targetWidget.value = labels.custom;
                                targetWidget.callback?.(labels.custom);
                                const modeWidget = this.widgets?.find(w => w.name === "generation_mode");
                                if (modeWidget?.options?.values?.includes(name)) modeWidget.value = name;
                                modeWidget?.callback?.(modeWidget.value);
                                this.setDirtyCanvas(true, true);
                            };
                            const edit = document.createElement("button");
                            edit.textContent = zh ? "编辑" : "Edit";
                            edit.style.cssText = "background:#343b49;color:#ddd;border:1px solid #555;border-radius:4px;padding:4px 8px;cursor:pointer";
                            edit.onclick = () => {
                                editingRuleName = name;
                                nameInput.value = name;
                                editor.value = presets[name]?.rule || "";
                                saveButton.textContent = zh ? "保存修改" : "Save Changes";
                                nameInput.focus();
                            };
                            const remove = document.createElement("button");
                            remove.textContent = zh ? "删除" : "Delete";
                            remove.style.cssText = "background:#492d2d;color:#f2baba;border:1px solid #694141;border-radius:4px;padding:4px 8px;cursor:pointer";
                            remove.onclick = () => {
                                const confirmed = window.confirm(zh ? `确定删除预设“${name}”吗？此操作无法撤销。` : `Delete preset “${name}”? This cannot be undone.`);
                                if (!confirmed) return;
                                const updated = getRulePresets();
                                delete updated[name];
                                cloudSave(storageKey, updated).catch(() => {});
                                if (editingRuleName === name) {
                                    editingRuleName = null;
                                    nameInput.value = "";
                                    editor.value = "";
                                    saveButton.textContent = zh ? "保存规则" : "Save Rule";
                                }
                                const targetWidget = this.widgets?.find(w => w.name === "target_model");
                                const modeWidget = this.widgets?.find(w => w.name === "generation_mode");
                                const labels = TARGET_LABELS[xzgLang()] || TARGET_LABELS.zh;
                                if (targetWidget?.value === labels.custom && modeWidget?.value === name) {
                                    modeWidget.value = xzgOrderedPromptRulePresetNames(updated)[0] || (zh ? "（请先保存规则预设）" : "(Save a rule preset first)");
                                }
                                this._syncTargetModel();
                                this._refreshPromptRulePresetTypes();
                                renderList();
                            };
                            row.append(dragHandle, apply, edit, remove);
                            list.appendChild(row);
                        }
                    };
                    saveButton.onclick = () => {
                        const name = nameInput.value.trim();
                        const value = editor.value.trim();
                        if (!name || !value) {
                            nameInput.placeholder = zh ? "请填写规则名称，且规则内容不能为空" : "Enter a rule name and non-empty rule content";
                            return;
                        }
                        const presets = getRulePresets();
                        if (editingRuleName && !Object.prototype.hasOwnProperty.call(presets, editingRuleName)) {
                            window.alert(zh ? "原预设已不存在，请重新选择后再编辑。" : "The original preset no longer exists. Select it again before editing.");
                            editingRuleName = null;
                            saveButton.textContent = zh ? "保存规则" : "Save Rule";
                            return;
                        }
                        if (editingRuleName && name !== editingRuleName && Object.prototype.hasOwnProperty.call(presets, name)) {
                            window.alert(zh ? "该名称已存在，请使用其他名称。" : "That name already exists. Choose another name.");
                            return;
                        }
                        const existingNames = xzgOrderedPromptRulePresetNames(presets);
                        existingNames.forEach((presetName, index) => {
                            if (!Number.isFinite(presets[presetName]?.order)) presets[presetName] = { ...presets[presetName], order: index };
                        });
                        const previousName = editingRuleName || name;
                        const previous = presets[previousName];
                        const nextOrder = Object.values(presets).reduce((max, preset) => Number.isFinite(preset?.order) ? Math.max(max, preset.order) : max, -1) + 1;
                        presets[name] = { ...(previous || {}), rule: value, order: Number.isFinite(previous?.order) ? previous.order : nextOrder, updatedAt: new Date().toISOString() };
                        if (editingRuleName && previousName !== name) delete presets[previousName];
                        cloudSave(storageKey, presets).catch(() => {});
                        if (editingRuleName && previousName !== name) {
                            const labelsForRename = TARGET_LABELS[xzgLang()] || TARGET_LABELS.zh;
                            for (const node of new Set([this, ...(app.graph?._nodes || [])])) {
                                const targetWidget = node.widgets?.find(w => w.name === "target_model");
                                const modeWidget = node.widgets?.find(w => w.name === "generation_mode");
                                if (targetWidget?.value === labelsForRename.custom && modeWidget?.value === previousName) {
                                    modeWidget.value = name;
                                    modeWidget.callback?.(name);
                                    node.setDirtyCanvas?.(true, true);
                                }
                            }
                        }
                        editingRuleName = name;
                        saveButton.textContent = zh ? "保存修改" : "Save Changes";
                        this._syncTargetModel();
                        this._refreshPromptRulePresetTypes();
                        const targetWidget = this.widgets?.find(w => w.name === "target_model");
                        const labels = TARGET_LABELS[xzgLang()] || TARGET_LABELS.zh;
                        targetWidget.value = labels.custom;
                        targetWidget.callback?.(labels.custom);
                        const modeWidget = this.widgets?.find(w => w.name === "generation_mode");
                        if (modeWidget?.options?.values?.includes(name)) modeWidget.value = name;
                        modeWidget?.callback?.(modeWidget.value);
                        renderList();
                    };
                    renderList();
                });
            };

            nodeType.prototype._hideExtraImageInputs = function () {
                for (let i = this.inputs.length - 1; i >= 0; i--) {
                    const inp = this.inputs[i];
                    if (inp && this._isXzgImg(inp)) {
                        const num = this._xzgImgNum(inp.name);
                        if (num === 1) continue; // 永远保留第一个图片接口
                        this.removeInput(i);
                    }
                }
            };

            // 核心：统一调整图片输入接口（参照 number_switch 的简洁模式）
            // 规则：已连接的接口左移填补空位，末尾保留一个空接口，最少 1 个，最多 10 个
            nodeType.prototype._adjustImageInputs = function () {
                if (!this.inputs) return;
                if (this._adjustingImageInputs) return;
                this._adjustingImageInputs = true;
                try {
                    // 收集所有图片接口
                    let imgInputs = [];
                    for (const inp of this.inputs) {
                        if (this._isXzgImg(inp)) imgInputs.push(inp);
                    }

                    // 统计已连接数量
                    let connectedCount = 0;
                    for (const inp of imgInputs) {
                        if (inp.link != null) connectedCount++;
                    }

                    // 紧凑化：将已连接的 link 左移填补空位
                    let writeIdx = 0;
                    for (let readIdx = 0; readIdx < imgInputs.length; readIdx++) {
                        const inp = imgInputs[readIdx];
                        if (inp.link != null) {
                            if (readIdx > writeIdx) {
                                const target = imgInputs[writeIdx];
                                target.link = inp.link;
                                inp.link = null;
                                // 更新 link 对象的 target_slot
                                const linkObj = this.graph && this.graph.links[target.link];
                                if (linkObj) {
                                    const targetSlot = this.inputs.indexOf(target);
                                    if (targetSlot >= 0) linkObj.target_slot = targetSlot;
                                }
                            }
                            writeIdx++;
                        }
                    }

                    // 重新统计（紧凑化后）
                    imgInputs = [];
                    for (const inp of this.inputs) {
                        if (this._isXzgImg(inp)) imgInputs.push(inp);
                    }
                    connectedCount = 0;
                    for (const inp of imgInputs) {
                        if (inp.link != null) connectedCount++;
                    }

                    // 目标数量 = 已连接 + 1 个空位，最少 1，最多 10
                    const desiredLen = Math.min(connectedCount + 1, 10);

                    if (imgInputs.length < desiredLen) {
                        // 添加不足的接口
                        for (let i = imgInputs.length; i < desiredLen; i++) {
                            this.addInput(this._xzgImgName(i + 1), "IMAGE", {
                                optional: true,
                                tooltip: `可选：参考图片${i + 1} / Reference image ${i + 1}`,
                            });
                            const addedInput = this.inputs[this.inputs.length - 1];
                            if (addedInput) addedInput.label = xzgLang() === "zh" ? `图片_${i + 1}` : `Image_${i + 1}`;
                        }
                        // 仅在高度不足时增大，保持当前宽度不变
                        const computed = this.computeSize();
                        if (computed[1] > this.size[1]) {
                            this.setSize([this.size[0], computed[1]]);
                        }
                        if (app.graph) app.graph.setDirtyCanvas(true, true);
                    } else if (imgInputs.length > desiredLen) {
                        // 从末尾移除多余的空图片接口
                        let removed = 0;
                        const toRemove = imgInputs.length - desiredLen;
                        for (let i = this.inputs.length - 1; i >= 0 && removed < toRemove; i--) {
                            if (this.inputs[i] && this.inputs[i].link == null && this._isXzgImg(this.inputs[i])) {
                                this.removeInput(i);
                                removed++;
                            }
                        }
                        if (removed > 0) {
                            if (app.graph) app.graph.setDirtyCanvas(true, true);
                        }
                    }

                    // 重编号为 image_1, image_2, ...
                    let num = 1;
                    for (const inp of this.inputs) {
                        if (this._isXzgImg(inp)) {
                            const expected = this._xzgImgName(num);
                            if (inp.name !== expected) inp.name = expected;
                            inp.label = xzgLang() === "zh" ? `图片_${num}` : `Image_${num}`;
                            num++;
                        }
                    }
                } finally {
                    this._adjustingImageInputs = false;
                }
            };

            // 连接/断连时延迟调用 _adjustImageInputs
            // 用 setTimeout 合并连续的连接/断连事件，跳过子图操作的中间状态
            const origOnConnectionsChange = nodeType.prototype.onConnectionsChange;
            nodeType.prototype.onConnectionsChange = function (slotType, slotIndex, connected, link, _info) {
                const r = origOnConnectionsChange?.apply(this, arguments);
                if (slotType === LiteGraph.INPUT) {
                    clearTimeout(this._adjustImgTimer);
                    this._adjustImgTimer = setTimeout(() => {
                        if (!this.graph || this._removed) return;
                        try { this._adjustImageInputs(); }
                        catch (e) { /* 节点状态不一致时忽略 */ }
                    }, 100);
                }
                return r;
            };

            // 调整图片接口
            const origConfigure = nodeType.prototype.configure;
            nodeType.prototype.configure = function (info) {
                const callArgs = [...arguments];
                const r = origConfigure?.apply(this, callArgs);
                // configure 会在 onNodeCreated 之后恢复 widget 值；恢复后重建细分列表。
                this._ensureTargetModelCombo();
                this._syncTargetModel();
                if (supportsCustomPromptRules) {
                    this._addPromptRulePresetControls();
                    this._restorePromptRulePresets();
                }
                // 子图解包时 configure 早于连线恢复；此刻增删/重编号端口会让恢复目标槽位消失。
                // 等到当前批次的连接变更全部完成后再统一整理。
                clearTimeout(this._adjustImgTimer);
                this._adjustImgTimer = setTimeout(() => {
                    if (!this.graph || this._removed) return;
                    try { this._adjustImageInputs(); }
                    catch (e) { /* 子图操作时可能状态不一致，忽略 */ }
                }, 350);
                return r;
            };
        }
    },
});

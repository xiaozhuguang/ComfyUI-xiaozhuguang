import { app } from "../../scripts/app.js";
import { xzgLang } from "./xzg_i18n.js";
import { cloudLoad, cloudSave, cloudUIInit, cloudUIQueueGeometry } from "./xzg_cloud_store.js";

// ═══════════════════════════════════════════════
//  小珠光文本框 / Xiaozhuguang Text Box
//  双语翻译表
// ═══════════════════════════════════════════════
const _NODE_TYPE = "XiaozhuguangTextBox";
const _NODE_TYPE_GOD = "XiaozhuguangTextBoxGod";
const _NODE_NAME_ZH = "小珠光文本框";
const _NODE_NAME_EN = "Xiaozhuguang Text Box";
const _NODE_NAME_GOD_ZH = "小珠光文本框-化神级";
const _NODE_NAME_GOD_EN = "Xiaozhuguang Text Box - God Tier";
const _GOD_PRESETS_KEY = "xzg_text_box_god_presets";
const _NO_PRESET = { zh: "（暂无提示词预设）", en: "(No prompt presets)" };
let _godPresetsRestorePromise = null;

const _LABEL_MAP = {
    "文本": "Text",
    "原文": "Raw Text",
    "数字转中文": "Num → Chinese",
    "提示词预设": "Prompt Preset",
};
function _tr(zh) {
    const lang = xzgLang();
    if (lang !== "en") return zh;
    return _LABEL_MAP[zh] != null ? _LABEL_MAP[zh] : zh;
}

// 占位符原文 placeholder（多行中文）→ 英文
const _PLACEHOLDER_ZH =
    "【小珠光文本框】\n" +
    "输出：text 原文 / text_zh_num 数字转中文\n" +
    "规则：日期时间→整体转写；数字+量词→完整读数；第N→第N；4位+年→按位读；其余→按位读\n" +
    "例：2023.4.16 21:08→二零二三年四月十六日九点零八分\n" +
    "12个→十二个  1280x720→一二八零乘以七二零  1926年→一九二六年\n" +
    "《》→。  ……→。";

const _PLACEHOLDER_EN =
    "[Xiaozhuguang Text Box]\n" +
    "Outputs: text (raw) / text_zh_num (digits → Chinese words)\n" +
    "Rules: datetime→whole conversion; digit+unit→full reading; 第N→ordinal; 4digits+年→year per digit; rest→per digit\n" +
    "Ex: 2023.4.16 21:08→二零二三年四月十六日九点零八分\n" +
    "12个→十二个  1280x720→一二八零乘以七二零  1926年→一九二六年\n" +
    "《》→。  ……→。";

const _PLACEHOLDER_ZH_GOD = _PLACEHOLDER_ZH.replace("【小珠光文本框】", "【小珠光文本框-化神级】");
const _PLACEHOLDER_EN_GOD = _PLACEHOLDER_EN.replace("[Xiaozhuguang Text Box]", "[Xiaozhuguang Text Box - God Tier]");

function _placeholderForLang(isGodTier = false) {
    if (xzgLang() !== "en") return isGodTier ? _PLACEHOLDER_ZH_GOD : _PLACEHOLDER_ZH;
    return isGodTier ? _PLACEHOLDER_EN_GOD : _PLACEHOLDER_EN;
}

function _readGodPresetsLocal() {
    try {
        const data = JSON.parse(localStorage.getItem(_GOD_PRESETS_KEY) || "{}");
        return data && typeof data === "object" && !Array.isArray(data) ? data : {};
    } catch (_) { return {}; }
}

function _orderedGodPresetNames(presets) {
    const entries = Object.values(presets || {});
    const categoryRanks = new Map();
    const fallbackRanks = new Map();
    for (const preset of entries) {
        const category = String(preset?.category || "");
        if (!category || fallbackRanks.has(category)) continue;
        fallbackRanks.set(category, fallbackRanks.size);
    }
    for (const preset of entries) {
        if (!preset?._categoryOnly || !Number.isFinite(preset.order) || preset.order < 0) continue;
        const category = String(preset.category || "");
        if (category && (!categoryRanks.has(category) || preset.order < categoryRanks.get(category))) categoryRanks.set(category, preset.order);
    }
    return Object.keys(presets || {}).filter(name => presets[name] && typeof presets[name] === "object" && presets[name]._categoryOnly !== true).sort((a, b) => {
        const ac = String(presets[a].category || "");
        const bc = String(presets[b].category || "");
        if (ac !== bc) {
            const ar = categoryRanks.get(ac) ?? fallbackRanks.get(ac) ?? Number.MAX_SAFE_INTEGER;
            const br = categoryRanks.get(bc) ?? fallbackRanks.get(bc) ?? Number.MAX_SAFE_INTEGER;
            return ar - br || ac.localeCompare(bc);
        }
        const ao = presets[a].order, bo = presets[b].order;
        if (Number.isFinite(ao) && Number.isFinite(bo)) return ao - bo || a.localeCompare(b);
        if (Number.isFinite(ao)) return -1;
        if (Number.isFinite(bo)) return 1;
        return a.localeCompare(b);
    });
}

function _godPresetChildName(key, preset) {
    return typeof preset?.name === "string" && preset.name ? preset.name : key;
}

function _godPresetStorageKey(category, name) {
    return category ? `${category} / ${name}` : name;
}

function _ensureGodPresetCombo(node, widgetName) {
    const widget = node?.widgets?.find(item => item?.name === widgetName);
    if (!widget || widget.type === "combo") return widget;
    const index = node.widgets.indexOf(widget), value = widget.value || "";
    node.widgets.splice(index, 1);
    const combo = node.addWidget("combo", widgetName, value, () => {}, { values: [""], serialize: true });
    const comboIndex = node.widgets.indexOf(combo);
    node.widgets.splice(comboIndex, 1);
    node.widgets.splice(index, 0, combo);
    return combo;
}

async function _loadGodPresets(force = false) {
    if (!force && _godPresetsRestorePromise) return _godPresetsRestorePromise;
    _godPresetsRestorePromise = cloudLoad(_GOD_PRESETS_KEY, { fallbackValue: {} })
        .then(data => {
            const presets = data && typeof data === "object" && !Array.isArray(data) ? data : {};
            try { localStorage.setItem(_GOD_PRESETS_KEY, JSON.stringify(presets)); } catch (_) {}
            return presets;
        })
        .catch(() => _readGodPresetsLocal());
    return _godPresetsRestorePromise;
}

function _syncGodPresetWidget(node, presets = _readGodPresetsLocal(), resetDetail = false) {
    const categoryWidget = _ensureGodPresetCombo(node, "preset_category");
    const detailWidget = _ensureGodPresetCombo(node, "preset_name");
    if (!categoryWidget || !detailWidget) return;
    const names = _orderedGodPresetNames(presets);
    const categories = ["无", ...new Set(names.map(name => String(presets[name].category || "")).filter(Boolean))];
    const storedCategory = String(categoryWidget.value || "");
    const storedDetail = String(detailWidget.value || "");
    const selectedPreset = names.find(name => name === _godPresetStorageKey(storedCategory === "无" ? "" : storedCategory, storedDetail === "无" ? "" : storedDetail));
    const selectedCategory = selectedPreset ? String(presets[selectedPreset].category || "") : String(categoryWidget.value || "无");
    categoryWidget.options = categoryWidget.options || {};
    categoryWidget.options.values = categories;
    categoryWidget.value = categories.includes(selectedCategory) ? selectedCategory : "无";
    const details = categoryWidget.value === "无" ? [] : names.filter(name => String(presets[name].category || "") === categoryWidget.value);
    const detailNames = details.map(name => _godPresetChildName(name, presets[name]));
    const previousDetail = String(detailWidget.value || "");
    detailWidget.options = detailWidget.options || {};
    const noCategory = categoryWidget.value === "无";
    detailWidget.options.values = noCategory ? ["无"] : (detailNames.length ? detailNames : [""]);
    detailWidget.value = noCategory ? "无" : (resetDetail || !detailNames.includes(previousDetail) ? (detailNames[0] ?? "") : previousDetail);
    const detailDisabled = noCategory || detailNames.length === 0;
    detailWidget.disabled = detailDisabled;
    detailWidget.options.disabled = detailDisabled;
    if (detailWidget._state) detailWidget._state.disabled = detailDisabled;
    categoryWidget.label = xzgLang() === "en" ? "Prompt Type" : "提示词类型";
    detailWidget.label = xzgLang() === "en" ? "Prompt Subtype" : "提示词细分";
    categoryWidget._xzgGodLastCategory = categoryWidget.value;
    node.setDirtyCanvas?.(true, true);
}

function _applyGodPreset(node, name, presets = _readGodPresetsLocal()) {
    const preset = presets[name];
    if (!preset || typeof preset !== "object") return false;
    const prompt = typeof preset.text === "string" ? preset.text : "";
    const textWidget = node.widgets?.find(item => item?.name === "text");
    if (!textWidget) return false;
    textWidget.value = prompt;
    textWidget.callback?.(prompt);
    const categoryWidget = node.widgets?.find(item => item?.name === "preset_category");
    if (categoryWidget) categoryWidget.value = String(preset.category || "");
    _syncGodPresetWidget(node, presets);
    const presetWidget = node.widgets?.find(item => item?.name === "preset_name");
    if (presetWidget) presetWidget.value = _godPresetChildName(name, preset);
    node.setDirtyCanvas?.(true, true);
    try { app.graph?.change?.(); } catch (_) {}
    return true;
}

function _syncAllGodPresetWidgets(presets = _readGodPresetsLocal()) {
    for (const node of app.graph?._nodes || []) {
        if (node?.type === _NODE_TYPE_GOD || node?.comfyClass === _NODE_TYPE_GOD) _syncGodPresetWidget(node, presets);
    }
}

async function _openGodPresetManagerTree(node) {
    try { await cloudUIInit(); } catch (_) {}
    let working = await _loadGodPresets(true);
    working = working && typeof working === "object" && !Array.isArray(working) ? { ...working } : {};
    const zh = xzgLang() !== "en";
    const geometryKey = "xzg_text_box_god_manager_geometry";
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;z-index:2000005;background:#0009;display:block;padding:20px;box-sizing:border-box";
    const dialog = document.createElement("div");
    dialog.style.cssText = "box-sizing:border-box;position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(760px,calc(100vw - 40px));height:min(700px,calc(100vh - 40px));display:flex;flex-direction:column;background:#202124;color:#fff;border:1px solid #555;border-radius:8px;box-shadow:0 16px 48px #0009;font:13px Arial,sans-serif;overflow:hidden";
    dialog.innerHTML = `<div style="display:flex;align-items:center;padding:13px 16px;border-bottom:1px solid #444;font-size:15px;font-weight:600;flex:none;user-select:none;-webkit-user-select:none"><span data-title style="flex:1">${zh ? "提示词预设管理" : "Prompt Preset Manager"}</span><button data-close style="background:transparent;border:0;border-radius:0;color:#e7b94f;padding:5px 8px;font:14px Arial,sans-serif;cursor:pointer">${zh ? "确认" : "Confirm"}</button></div><div data-home style="flex:1;overflow:auto;padding:12px 16px"></div><div data-editor style="display:none;flex:1;flex-direction:column;min-height:0;padding:12px 16px"><div data-editor-label style="color:#9db7a6;margin-bottom:8px"></div><div style="display:flex;gap:8px;justify-content:flex-end;padding:0 0 10px"><button data-back>${zh ? "返回分类" : "Back to categories"}</button><button data-import-content>${zh ? "导入 .txt / .md" : "Import .txt / .md"}</button><button data-save-content>${zh ? "保存内容" : "Save content"}</button></div><textarea data-editor-text spellcheck="false" style="box-sizing:border-box;flex:1;min-height:100px;resize:none;padding:10px;background:#151617;color:#eee;border:1px solid #555;border-radius:5px;font:12px/1.5 Consolas,monospace"></textarea></div><div data-resize title="${zh ? "拖动调整窗口大小" : "Drag to resize"}" style="position:absolute;right:1px;bottom:1px;width:18px;height:18px;cursor:nwse-resize;touch-action:none;user-select:none;background:linear-gradient(135deg,transparent 0 48%,#666 49% 55%,transparent 56% 66%,#888 67% 73%,transparent 74%)"></div>`;
    overlay.appendChild(dialog); document.body.appendChild(overlay);
    const dragStyle = document.createElement("style");
    dragStyle.textContent = `
        .xzg-preset-drag-list { gap: 3px !important; padding-top: 0 !important; padding-right: 2px; }
        .xzg-preset-drag-row {
            display: flex; align-items: center; gap: 8px; padding: 6px 8px;
            background: #2a2a2a; border: 1px solid #3a3a3a; border-radius: 4px;
            cursor: grab; transition: all 0.2s; min-width: 0;
        }
        .xzg-preset-drag-row:hover { background: rgba(255, 255, 255, 0.1); }
        .xzg-preset-drag-row:active { cursor: grabbing; }
        .xzg-preset-drag-row.xzg-preset-active { border-left: 2px solid var(--nf-active-bar, #FFD700); padding-left: 6px; }
        .xzg-preset-drag-row.xzg-preset-dragging { opacity: 0.5; border-style: dashed; border-color: #4CAF50; }
        .xzg-preset-drag-handle { flex: none; color: #666; font-size: 14px; line-height: 1; user-select: none; }
        .xzg-preset-drag-handle:hover { background: rgba(255, 255, 255, 0.1); }
    `;
    dialog.appendChild(dragStyle);
    overlay.addEventListener("contextmenu", event => {
        event.preventDefault();
        event.stopPropagation();
    });
    try {
        const saved = JSON.parse(localStorage.getItem(geometryKey) || "null");
        if (saved && [saved.left, saved.top, saved.width, saved.height].every(Number.isFinite)) {
            const width = Math.max(360, Math.min(innerWidth - 40, saved.width)), height = Math.max(300, Math.min(innerHeight - 40, saved.height));
            dialog.style.transform = "none"; dialog.style.width = `${width}px`; dialog.style.height = `${height}px`;
            dialog.style.left = `${Math.max(0, Math.min(innerWidth - width, saved.left))}px`; dialog.style.top = `${Math.max(0, Math.min(innerHeight - height, saved.top))}px`;
        }
    } catch (_) {}
    const titleBar = dialog.firstElementChild;
    titleBar.style.cssText += ";cursor:move;user-select:none";
    const managerConfirmButton = dialog.querySelector("[data-close]");
    if (managerConfirmButton) { managerConfirmButton.style.fontSize = "16px"; managerConfirmButton.style.setProperty("font-weight", "700", "important"); managerConfirmButton.style.setProperty("color", "#e7b94f", "important"); }
    dialog.querySelector("[data-title]").style.color = "#e7b94f";
    titleBar.addEventListener("pointerdown", event => {
        if (event.button !== 0 || event.target.closest("button")) return;
        event.preventDefault(); const rect = dialog.getBoundingClientRect(), sx = event.clientX, sy = event.clientY;
        dialog.style.transform = "none"; dialog.style.left = `${rect.left}px`; dialog.style.top = `${rect.top}px`;
        const move = e => { dialog.style.left = `${Math.max(0, Math.min(innerWidth - rect.width, rect.left + e.clientX - sx))}px`; dialog.style.top = `${Math.max(0, Math.min(innerHeight - rect.height, rect.top + e.clientY - sy))}px`; };
        const end = () => {
            titleBar.removeEventListener("pointermove", move); const r = dialog.getBoundingClientRect();
            try { localStorage.setItem(geometryKey, JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) })); } catch (_) {}
            cloudUIQueueGeometry();
        };
        titleBar.setPointerCapture(event.pointerId); titleBar.addEventListener("pointermove", move); titleBar.addEventListener("pointerup", end, { once: true }); titleBar.addEventListener("pointercancel", end, { once: true });
    });
    const resizeHandle = dialog.querySelector("[data-resize]");
    resizeHandle.addEventListener("pointerdown", event => {
        if (event.button !== 0) return;
        event.preventDefault(); event.stopPropagation();
        const rect = dialog.getBoundingClientRect(), sx = event.clientX, sy = event.clientY, sw = rect.width, sh = rect.height;
        dialog.style.transform = "none"; dialog.style.left = `${rect.left}px`; dialog.style.top = `${rect.top}px`;
        const move = e => {
            const width = Math.max(420, Math.min(innerWidth - rect.left - 20, sw + e.clientX - sx));
            const height = Math.max(320, Math.min(innerHeight - rect.top - 20, sh + e.clientY - sy));
            dialog.style.width = `${width}px`; dialog.style.height = `${height}px`;
        };
        const end = () => {
            resizeHandle.removeEventListener("pointermove", move); const r = dialog.getBoundingClientRect();
            try { localStorage.setItem(geometryKey, JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) })); } catch (_) {}
            cloudUIQueueGeometry();
        };
        resizeHandle.setPointerCapture(event.pointerId); resizeHandle.addEventListener("pointermove", move); resizeHandle.addEventListener("pointerup", end, { once: true }); resizeHandle.addEventListener("pointercancel", end, { once: true });
    });
    const home = dialog.querySelector("[data-home]"), editorView = dialog.querySelector("[data-editor]"), title = dialog.querySelector("[data-title]"), textArea = dialog.querySelector("[data-editor-text]"), closeButton = dialog.querySelector("[data-close]");
    home.style.cssText = "display:flex;flex:1;min-height:0;padding:0;overflow:hidden;user-select:none;-webkit-user-select:none";
    home.innerHTML = `<aside data-left-pane style="box-sizing:border-box;flex:0 0 34%;width:34%;min-width:150px;max-width:80%;display:flex;flex-direction:column;min-height:0;padding:12px 10px;overflow:hidden"><div style="display:flex;align-items:center;gap:8px;padding:0 4px 10px"><span style="flex:1;color:#ccc;font-weight:600">${zh ? "提示词类型" : "Prompt Types"}</span><button type="button" data-add-category style="width:28px;height:28px;background:#303030;color:#e7b94f;border:1px solid #454545;border-radius:4px;font-size:16px;cursor:pointer">+</button></div><div data-category-list style="display:flex;flex-direction:column;gap:4px;overflow:auto;min-height:0;flex:1"></div></aside><div data-split-divider style="width:4px;flex:none;background:#3a3a3a;cursor:col-resize"></div><section data-right-pane style="box-sizing:border-box;flex:1 1 0;min-width:0;display:flex;flex-direction:column;min-height:0;padding:12px 14px"><div style="display:flex;align-items:center;gap:8px;padding:0 2px 10px;border-bottom:1px solid #3a3a3a"><span data-right-title style="flex:1;color:#ddd;font-weight:600">${zh ? "提示词细分" : "Prompt Subcategories"}</span><button type="button" data-add-sub style="background:transparent;color:#e7b94f;border:0;padding:2px 5px;font:14px Arial,sans-serif;cursor:pointer">${zh ? "+ 增加子项" : "+ Add item"}</button></div><div data-subcategory-list style="display:flex;flex-direction:column;gap:6px;overflow:auto;min-height:0;flex:1;padding-top:10px"></div></section>`;
    const categoryList = home.querySelector("[data-category-list]"), subcategoryList = home.querySelector("[data-subcategory-list]"), rightTitle = home.querySelector("[data-right-title]"), addSubButton = home.querySelector("[data-add-sub]");
    categoryList.classList.add("xzg-preset-drag-list");
    subcategoryList.classList.add("xzg-preset-drag-list");
    home.querySelector("[data-left-pane] span").style.color = "#fff";
    rightTitle.style.color = "#fff";
    addSubButton.textContent = "+";
    addSubButton.title = zh ? "增加子项" : "Add item";
    addSubButton.style.cssText = "box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;flex:none;width:32px;height:32px;padding:0;background:transparent;border:0;border-radius:0;font:32px/32px Arial,sans-serif;cursor:pointer";
    addSubButton.style.color = "#fff";
    dialog.querySelector("[data-editor-label]").style.color = "#fff";
    const categoryOrder = category => {
        const entries = Object.values(working);
        const marker = entries.find(p => p?._categoryOnly && p.category === category && Number.isFinite(p.order) && p.order >= 0);
        if (marker) return marker.order;
        return entries.findIndex(p => p?.category === category);
    };
    const categories = () => [...new Set(Object.values(working).map(p => String(p?.category || "")).filter(Boolean))]
        .sort((a, b) => categoryOrder(a) - categoryOrder(b));
    const hasDragType = (event, type) => event.dataTransfer && Array.from(event.dataTransfer.types).includes(type);
    const clearInsertMarker = list => list.querySelector("[data-insert-marker]")?.remove();
    const showInsertMarker = (list, rows, index) => {
        clearInsertMarker(list);
        const marker = document.createElement("div"); marker.dataset.insertMarker = "1";
        marker.style.cssText = "height:3px;flex:none;border-radius:2px;background:#4CAF50;box-shadow:0 0 6px rgba(76,175,80,0.8);margin:0";
        list.insertBefore(marker, rows[index] || null);
    };
    let selectedCategory = categories()[0] || "";
    const save = async () => {
        const result = await cloudSave(_GOD_PRESETS_KEY, working);
        _godPresetsRestorePromise = Promise.resolve(working);
        _syncAllGodPresetWidgets(working);
        const cloudSaved = result?.ok === true;
        if (!cloudSaved) notify(zh ? "云端保存失败，数据已暂存本地。" : "Cloud save failed; data is stored locally for now.");
        return cloudSaved;
    };
    const keyFor = (category, name) => _godPresetStorageKey(category, name);
    const rebuild = entries => {
        const next = {};
        for (const [oldKey, p] of entries) {
            if (p?._categoryOnly) { next[oldKey] = p; continue; }
            const name = _godPresetChildName(oldKey, p), key = keyFor(String(p.category || ""), name);
            if (next[key]) return null;
            next[key] = { ...p, name, category: String(p.category || "") };
        }
        return next;
    };
    let editingKey = null;
    const notify = message => { let note = dialog.querySelector("[data-notice]"); if (!note) { note = document.createElement("div"); note.dataset.notice = "1"; note.style.cssText = "position:absolute;z-index:3;top:56px;left:50%;transform:translateX(-50%);max-width:calc(100% - 32px);padding:8px 12px;background:#343b49;color:#fff;border:1px solid #555;border-radius:5px;box-shadow:0 4px 12px #0008;pointer-events:none;text-align:center"; dialog.appendChild(note); } note.textContent = message; clearTimeout(note._timer); note._timer = setTimeout(() => note.remove(), 4000); };
    const askText = (label, initial = "") => new Promise(resolve => {
        const shade = document.createElement("div"); shade.dataset.modal = "1"; shade.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:#000a;display:flex;align-items:center;justify-content:center;padding:20px;pointer-events:auto";
        const box = document.createElement("div"); box.style.cssText = "width:min(420px,100%);padding:16px;background:#25282c;color:#fff;border:1px solid #555;border-radius:7px;box-shadow:0 12px 36px #0009;font:13px Arial,sans-serif";
        const title = document.createElement("div"); title.textContent = label; title.style.cssText = "font-weight:600;margin-bottom:12px";
        const input = document.createElement("input"); input.value = initial; input.maxLength = 100; input.style.cssText = "box-sizing:border-box;width:100%;padding:8px;background:#151617;color:#fff;border:1px solid #555;border-radius:4px";
        const actions = document.createElement("div"); actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:14px";
        const finish = value => { document.removeEventListener("keydown", onKey, true); shade.remove(); resolve(value); };
        const cancel = button(zh ? "取消" : "Cancel", () => finish(null)); const ok = button(zh ? "确定" : "OK", () => finish(input.value.trim()));
        input.addEventListener("keydown", e => { if (e.key === "Enter") finish(input.value.trim()); });
        const onKey = e => { if (e.key === "Escape") finish(null); }; document.addEventListener("keydown", onKey, true);
        actions.append(cancel, ok); box.append(title, input, actions); shade.appendChild(box); document.body.appendChild(shade); input.focus(); input.select();
    });
    const askConfirm = message => new Promise(resolve => {
        const shade = document.createElement("div"); shade.dataset.modal = "1"; shade.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:#000a;display:flex;align-items:center;justify-content:center;padding:20px;pointer-events:auto";
        const box = document.createElement("div"); box.style.cssText = "width:min(420px,100%);padding:16px;background:#25282c;color:#fff;border:1px solid #555;border-radius:7px;box-shadow:0 12px 36px #0009;font:13px Arial,sans-serif";
        const text = document.createElement("div"); text.textContent = message; text.style.cssText = "line-height:1.5;white-space:pre-wrap";
        const actions = document.createElement("div"); actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:14px";
        const finish = value => { document.removeEventListener("keydown", onKey, true); shade.remove(); resolve(value); };
        const deleteButton = button(zh ? "删除" : "Delete", () => finish(true), true); deleteButton.style.color = "#c75c5c";
        actions.append(button(zh ? "取消" : "Cancel", () => finish(false)), deleteButton);
        const onKey = e => { if (e.key === "Escape") finish(false); }; document.addEventListener("keydown", onKey, true);
        box.append(text, actions); shade.appendChild(box); document.body.appendChild(shade);
    });
    const askCategoryRemoval = category => new Promise(resolve => {
        const shade = document.createElement("div"); shade.dataset.modal = "1"; shade.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:#000a;display:flex;align-items:center;justify-content:center;padding:20px;pointer-events:auto";
        const box = document.createElement("div"); box.style.cssText = "width:min(460px,100%);padding:16px;background:#25282c;color:#fff;border:1px solid #555;border-radius:7px;box-shadow:0 12px 36px #0009;font:13px Arial,sans-serif";
        const heading = document.createElement("div"); heading.textContent = zh ? `删除提示词类型“${category}”` : `Delete prompt type “${category}”`; heading.style.cssText = "font-weight:600;margin-bottom:10px";
        const info = document.createElement("div"); info.textContent = zh ? "确定删除此提示词类型及其下的所有子项和提示词吗？" : "Delete this prompt type and all its subcategories and prompts?"; info.style.cssText = "color:#fff;line-height:1.5;margin-bottom:12px";
        const actions = document.createElement("div"); actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-top:14px";
        const finish = value => { document.removeEventListener("keydown", onKey, true); shade.remove(); resolve(value); };
        actions.append(button(zh ? "取消" : "Cancel", () => finish(false)), button(zh ? "确认" : "Confirm", () => finish(true), true));
        const onKey = e => { if (e.key === "Escape") finish(null); }; document.addEventListener("keydown", onKey, true);
        box.append(heading, info, actions); shade.appendChild(box); document.body.appendChild(shade);
    });
    const button = (label, action, danger = false) => { const b = document.createElement("button"); b.type = "button"; b.textContent = label; b.style.cssText = `position:relative;z-index:1;pointer-events:auto;background:${danger ? "#492d2d" : "#343b49"};color:#fff;border:1px solid #555;border-radius:4px;padding:5px 9px;cursor:pointer;white-space:nowrap`; b.addEventListener("click", event => { event.stopPropagation(); action(event); }); return b; };
    const textFileInput = document.createElement("input");
    textFileInput.type = "file"; textFileInput.accept = ".txt,.md,text/plain,text/markdown"; textFileInput.style.display = "none";
    overlay.appendChild(textFileInput);
    const importTextButton = editorView.querySelector("[data-import-content]");
    importTextButton.addEventListener("click", () => textFileInput.click());
    importTextButton.title = zh ? "导入后点击“保存内容”同步到云端" : "Click Save content after importing to sync to the cloud";
    const importTextFile = async file => {
        if (!/\.(txt|md)$/i.test(file.name)) {
            throw new Error(zh ? "只支持 .txt 和 .md 文件。" : "Only .txt and .md files are supported.");
        }
        textArea.value = await file.text();
        textArea.focus();
    };
    textFileInput.addEventListener("change", async () => {
        const file = textFileInput.files?.[0];
        textFileInput.value = "";
        if (!file) return;
        try { await importTextFile(file); }
        catch (error) { window.alert(String(error?.message || error)); }
    });
    textArea.addEventListener("dragover", event => { event.preventDefault(); textArea.style.borderColor = "#68b38a"; });
    textArea.addEventListener("dragleave", () => { textArea.style.borderColor = "#555"; });
    textArea.addEventListener("drop", async event => {
        const file = event.dataTransfer?.files?.[0];
        if (!file) return;
        event.preventDefault(); textArea.style.borderColor = "#555";
        try { await importTextFile(file); }
        catch (error) { window.alert(String(error?.message || error)); }
    });
    const addCategoryButton = button("+", async () => {
        const name = await askText(zh ? "新建提示词类型" : "New Prompt Type"); if (!name) return;
        if (categories().includes(name)) { notify(zh ? "提示词类型名称已存在，必须全局唯一。" : "Prompt category names must be unique."); return; }
        const nextOrder = categories().reduce((max, category) => Math.max(max, categoryOrder(category)), 0) + 1000;
        working[`__xzg_category__${Date.now()}__`] = { category: name, name: "", text: "", order: nextOrder, _categoryOnly: true }; selectedCategory = name; await save(); render();
    });
    addCategoryButton.title = zh ? "新建提示词类型" : "New Prompt Type";
    addCategoryButton.style.cssText = "box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;flex:none;width:32px;height:32px;padding:0;background:transparent;color:#fff;border:0;border-radius:0;font:32px/32px Arial,sans-serif;cursor:pointer";
    home.querySelector("[data-add-category]").replaceWith(addCategoryButton);
    const leftPane = home.querySelector("[data-left-pane]"), splitDivider = home.querySelector("[data-split-divider]");
    splitDivider.addEventListener("pointerdown", event => {
        if (event.button !== 0) return;
        event.preventDefault();
        const startX = event.clientX, startWidth = leftPane.getBoundingClientRect().width, bounds = home.getBoundingClientRect();
        const move = e => {
            const width = Math.max(160, Math.min(bounds.width - 240, startWidth + e.clientX - startX));
            leftPane.style.width = `${width}px`; leftPane.style.flex = `0 0 ${width}px`;
        };
        const end = () => { splitDivider.removeEventListener("pointermove", move); };
        splitDivider.setPointerCapture(event.pointerId); splitDivider.addEventListener("pointermove", move); splitDivider.addEventListener("pointerup", end, { once: true }); splitDivider.addEventListener("pointercancel", end, { once: true });
    });
    let categoryInsertIndex = null;
    const reorderCategoryDrop = async event => {
        const dragged = event.dataTransfer?.getData("application/x-xzg-prompt-category");
        if (!dragged) return;
        event.preventDefault(); event.stopPropagation();
        const targetIndex = categoryInsertIndex;
        clearInsertMarker(categoryList); categoryInsertIndex = null;
        if (targetIndex == null) return;
        const ordered = categories(), from = ordered.indexOf(dragged);
        if (from < 0) return;
        const to = from < targetIndex ? targetIndex - 1 : targetIndex;
        if (to === from) return;
        const [moved] = ordered.splice(from, 1); ordered.splice(to, 0, moved);
        for (const [key, preset] of Object.entries(working)) if (preset?._categoryOnly) delete working[key];
        ordered.forEach((category, index) => { working[`__xzg_category__${Date.now()}_${index}_${Math.random().toString(36).slice(2)}__`] = { category, name: "", text: "", order: (index + 1) * 1000, _categoryOnly: true }; });
        await save(); render();
    };
    categoryList.addEventListener("dragover", event => {
        if (!hasDragType(event, "application/x-xzg-prompt-category")) return;
        event.preventDefault();
    });
    categoryList.addEventListener("drop", reorderCategoryDrop);
    categoryList.addEventListener("dragend", () => { clearInsertMarker(categoryList); categoryInsertIndex = null; });
    let onExternalPresets = null;
    const close = () => { document.removeEventListener("keydown", onKey, true); if (onExternalPresets) window.removeEventListener("xzg:text-box-presets-imported", onExternalPresets); overlay.remove(); node._xzgGodPresetDialogOpen = false; };
    const openEditor = key => { const p = working[key]; if (!p) return; editingKey = key; title.textContent = zh ? "编辑细分内容" : "Edit Subcategory Content"; closeButton.disabled = true; closeButton.style.opacity = "0.45"; closeButton.style.cursor = "not-allowed"; dialog.querySelector("[data-editor-label]").textContent = `${p.category} / ${_godPresetChildName(key, p)}`; textArea.value = typeof p.text === "string" ? p.text : ""; home.style.display = "none"; editorView.style.display = "flex"; textArea.focus(); };
    const createSubcategory = async category => {
        if (!category) return;
        const name = await askText(zh ? `在“${category}”中增加子项` : `Add an item to “${category}”`); if (!name) return;
        const key = keyFor(category, name);
        if (working[key]) { notify(zh ? "该提示词类型下已有同名子项。" : "That item already exists in this category."); return; }
        const nextOrder = Object.values(working).filter(p => p?.category === category && !p?._categoryOnly).reduce((max, p) => Math.max(max, Number.isFinite(p.order) ? p.order : -1000), -1000) + 1000;
        working[key] = { category, name, text: "", order: nextOrder };
        await save(); render();
    };
    const renameCategory = async category => {
        const next = await askText(zh ? `重命名提示词类型“${category}”` : `Rename prompt type “${category}”`, category); if (!next || next === category) return;
        if (categories().includes(next)) { notify(zh ? "提示词类型名称已存在，必须全局唯一。" : "Prompt category names must be unique."); return; }
        const entries = Object.entries(working).map(([k, p]) => [k, p?.category === category ? { ...p, category: next } : p]);
        const rebuilt = rebuild(entries); if (!rebuilt) { notify(zh ? "重命名会造成子项重名，请先整理重名项。" : "Rename would create duplicate items."); return; }
        working = rebuilt; if (selectedCategory === category) selectedCategory = next; await save(); render();
    };
    const removeCategory = async category => {
        if (!await askCategoryRemoval(category)) return;
        for (const [k, p] of Object.entries(working)) if (p?.category === category) delete working[k];
        if (selectedCategory === category) selectedCategory = categories()[0] || "";
        await save(); render();
    };
    const render = () => {
        const cats = categories();
        if (!cats.includes(selectedCategory)) selectedCategory = cats[0] || "";
        categoryList.replaceChildren(); subcategoryList.replaceChildren();
        for (const category of cats) {
            const row = document.createElement("div"); row.draggable = true;
            row.className = `xzg-preset-drag-row${selectedCategory === category ? " xzg-preset-active" : ""}`;
            row.dataset.categoryRow = "1";
            row.addEventListener("dragstart", event => {
                if (event.target.closest("button")) { event.preventDefault(); return; }
                event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-xzg-prompt-category", category); row.classList.add("xzg-preset-dragging");
            });
            row.addEventListener("dragend", () => { row.classList.remove("xzg-preset-dragging"); clearInsertMarker(categoryList); categoryInsertIndex = null; });
            row.addEventListener("dragover", event => {
                if (!hasDragType(event, "application/x-xzg-prompt-category")) return;
                event.preventDefault();
                const rect = row.getBoundingClientRect();
                const rows = [...categoryList.querySelectorAll("[data-category-row]")];
                const index = rows.indexOf(row);
                categoryInsertIndex = event.clientY - rect.top < rect.height / 2 ? index : index + 1;
                showInsertMarker(categoryList, rows, categoryInsertIndex);
            });
            row.addEventListener("drop", event => { if (hasDragType(event, "application/x-xzg-prompt-category")) reorderCategoryDrop(event); });
            const dragHandle = document.createElement("span"); dragHandle.className = "xzg-preset-drag-handle"; dragHandle.textContent = "⠿"; dragHandle.title = zh ? "拖动调整顺序" : "Drag to reorder";
            const label = document.createElement("span"); label.textContent = category; label.title = category; label.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#fff";
            const rename = button("✎", event => { event.stopPropagation(); renameCategory(category); }); rename.title = zh ? "重命名" : "Rename"; rename.style.cssText += ";box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;flex:none;width:24px;height:24px;padding:0;background:transparent;border:0;color:#fff;font-size:16px;line-height:24px";
            const del = button("×", event => { event.stopPropagation(); removeCategory(category); }); del.title = zh ? "删除" : "Delete"; del.style.cssText += ";box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;flex:none;width:24px;height:24px;padding:0;background:transparent;border:0;color:#c75c5c;font-size:22px;line-height:24px";
            row.addEventListener("click", () => { selectedCategory = category; render(); });
            row.append(dragHandle, label, rename, del); categoryList.appendChild(row);
        }
        if (!cats.length) { const empty = document.createElement("div"); empty.textContent = zh ? "还没有提示词类型" : "No prompt types"; empty.style.cssText = "margin:auto;padding:16px;text-align:center;color:#fff"; categoryList.appendChild(empty); }
        rightTitle.textContent = zh ? "提示词细分" : "Prompt Subcategories";
        addSubButton.disabled = !selectedCategory; addSubButton.style.opacity = selectedCategory ? "1" : ".45";
        const details = selectedCategory ? Object.keys(working).filter(k => !working[k]?._categoryOnly && working[k]?.category === selectedCategory).sort((a, b) => (working[a].order ?? 0) - (working[b].order ?? 0) || _godPresetChildName(a, working[a]).localeCompare(_godPresetChildName(b, working[b]))) : [];
        let subcategoryInsertIndex = null;
        const reorderSubcategory = async (dragKey, insertIndex) => {
            const ordered = Object.keys(working).filter(k => !working[k]?._categoryOnly && working[k]?.category === selectedCategory).sort((a, b) => (working[a].order ?? 0) - (working[b].order ?? 0) || _godPresetChildName(a, working[a]).localeCompare(_godPresetChildName(b, working[b])));
            const from = ordered.indexOf(dragKey); if (from < 0 || insertIndex == null) return;
            const to = from < insertIndex ? insertIndex - 1 : insertIndex; if (from === to) return;
            const [moved] = ordered.splice(from, 1); ordered.splice(to, 0, moved);
            ordered.forEach((key, index) => { working[key].order = (index + 1) * 1000; });
            await save(); render();
        };
        subcategoryList.ondragover = event => {
            if (!hasDragType(event, "application/x-xzg-prompt-subcategory")) return;
            event.preventDefault();
        };
        subcategoryList.ondrop = event => {
            const dragKey = event.dataTransfer?.getData("application/x-xzg-prompt-subcategory"); if (!dragKey) return;
            event.preventDefault(); const index = subcategoryInsertIndex; clearInsertMarker(subcategoryList); subcategoryInsertIndex = null; reorderSubcategory(dragKey, index);
        };
        subcategoryList.ondragend = () => { clearInsertMarker(subcategoryList); subcategoryInsertIndex = null; };
        if (!selectedCategory || !details.length) {
            const empty = document.createElement("div"); empty.textContent = selectedCategory ? (zh ? "此分类下还没有子项" : "No items in this category yet") : (zh ? "请先在左侧新建提示词类型" : "Create a prompt type on the left first"); empty.style.cssText = "margin:auto;padding:20px;text-align:center;color:#fff"; subcategoryList.appendChild(empty);
        }
        for (const key of details) {
            const p = working[key], card = document.createElement("div"); card.draggable = true; card.dataset.subcategoryCard = "1"; card.className = "xzg-preset-drag-row";
            card.addEventListener("dragstart", event => {
                if (event.target.closest("button")) { event.preventDefault(); return; }
                event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-xzg-prompt-subcategory", key); card.classList.add("xzg-preset-dragging");
            });
            card.addEventListener("dragend", () => { card.classList.remove("xzg-preset-dragging"); clearInsertMarker(subcategoryList); subcategoryInsertIndex = null; });
            card.addEventListener("dragover", event => {
                if (!hasDragType(event, "application/x-xzg-prompt-subcategory")) return;
                event.preventDefault();
                const rect = card.getBoundingClientRect();
                const rows = [...subcategoryList.querySelectorAll("[data-subcategory-card]")];
                const index = rows.indexOf(card);
                subcategoryInsertIndex = event.clientY - rect.top < rect.height / 2 ? index : index + 1;
                showInsertMarker(subcategoryList, rows, subcategoryInsertIndex);
            });
            card.addEventListener("drop", event => {
                const dragKey = event.dataTransfer?.getData("application/x-xzg-prompt-subcategory"); if (!dragKey) return;
                event.preventDefault(); event.stopPropagation(); const index = subcategoryInsertIndex; clearInsertMarker(subcategoryList); subcategoryInsertIndex = null; reorderSubcategory(dragKey, index);
            });
            const dragHandle = document.createElement("span"); dragHandle.className = "xzg-preset-drag-handle"; dragHandle.textContent = "⠿"; dragHandle.title = zh ? "拖动调整顺序" : "Drag to reorder";
            const name = document.createElement("span"); name.textContent = _godPresetChildName(key, p); name.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;color:#fff";
            const hasContent = typeof p.text === "string" && p.text.trim().length > 0;
            const contentDot = hasContent ? document.createElement("span") : null;
            if (contentDot) { contentDot.title = zh ? "已有编辑内容" : "Has content"; contentDot.setAttribute("aria-label", contentDot.title); contentDot.style.cssText = "width:6px;height:6px;flex:none;border-radius:50%;background:#fff;box-shadow:0 0 4px rgba(255,255,255,.65)"; }
            const rename = button(zh ? "重命名" : "Rename", async () => {
                const next = await askText(zh ? `重命名子项“${name.textContent}”` : `Rename item “${name.textContent}”`, name.textContent); if (!next || next === name.textContent) return;
                const nextKey = keyFor(selectedCategory, next); if (working[nextKey]) { notify(zh ? "该提示词类型下已有同名子项。" : "That item already exists in this category."); return; }
                working[nextKey] = { ...p, name: next }; delete working[key]; await save(); render();
            });
            const edit = button(zh ? "编辑内容" : "Edit Content", () => openEditor(key));
            const del = button(zh ? "删除" : "Delete", async () => { if (!await askConfirm(zh ? `确定删除子项“${name.textContent}”及其提示词？` : `Delete item “${name.textContent}” and its prompt?`)) return; delete working[key]; await save(); render(); }, true);
            for (const b of [rename, edit]) b.style.cssText += ";background:transparent;border:0;color:#fff";
            del.style.cssText += ";background:transparent;border:0;color:#c75c5c";
            card.append(dragHandle); if (contentDot) card.append(contentDot); card.append(name, rename, edit, del); subcategoryList.appendChild(card);
        }
    };
    addSubButton.addEventListener("click", () => createSubcategory(selectedCategory));
    onExternalPresets = event => {
        const presets = event.detail;
        if (!presets || typeof presets !== "object" || Array.isArray(presets)) return;
        working = { ...presets };
        selectedCategory = categories()[0] || "";
        editingKey = null;
        editorView.style.display = "none"; home.style.display = "flex";
        title.textContent = zh ? "提示词预设管理" : "Prompt Preset Manager";
        render();
    };
    window.addEventListener("xzg:text-box-presets-imported", onExternalPresets);
    render();
    dialog.querySelector("[data-save-content]").addEventListener("click", async () => { if (!editingKey || !working[editingKey]) return; working[editingKey].text = textArea.value; working[editingKey].updatedAt = new Date().toISOString(); await save(); editorView.style.display = "none"; home.style.display = "flex"; closeButton.disabled = false; closeButton.style.opacity = "1"; closeButton.style.cursor = "pointer"; title.textContent = zh ? "提示词预设管理" : "Prompt Preset Manager"; render(); });
    dialog.querySelector("[data-back]").addEventListener("click", () => { editorView.style.display = "none"; home.style.display = "flex"; closeButton.disabled = false; closeButton.style.opacity = "1"; closeButton.style.cursor = "pointer"; title.textContent = zh ? "提示词预设管理" : "Prompt Preset Manager"; render(); });
    dialog.querySelector("[data-close]").addEventListener("click", close);
    const onKey = event => { if (event.key === "Escape" && !document.querySelector("[data-modal]")) close(); }; document.addEventListener("keydown", onKey, true);
    render();
}

function _installGodPresetControls(node) {
    if (node._xzgGodPresetControlsReady) {
        _syncGodPresetWidget(node);
        return;
    }
    node._xzgGodPresetControlsReady = true;
    const categoryWidget = _ensureGodPresetCombo(node, "preset_category");
    const presetWidget = _ensureGodPresetCombo(node, "preset_name");
    if (categoryWidget && !categoryWidget._xzgGodCategoryCallback) {
        const originalCallback = categoryWidget.callback;
        categoryWidget.callback = (...args) => {
            const previousCategory = categoryWidget._xzgGodLastCategory;
            const result = originalCallback?.apply(categoryWidget, args);
            const nextCategory = String(typeof args[0] === "string" ? args[0] : categoryWidget.value || "无");
            categoryWidget.value = nextCategory;
            if (previousCategory && previousCategory !== "无" && nextCategory === "无") {
                const textWidget = node.widgets?.find(item => item?.name === "text");
                if (textWidget) {
                    textWidget.value = "";
                    textWidget.callback?.("");
                    try { app.graph?.change?.(); } catch (_) {}
                }
            }
            if (presetWidget) presetWidget.value = "";
            _syncGodPresetWidget(node, _readGodPresetsLocal(), true);
            if (previousCategory === "无" && nextCategory !== "无") {
                const detail = String(presetWidget?.value || "");
                const presets = _readGodPresetsLocal();
                const key = _godPresetStorageKey(nextCategory, detail);
                if (detail && Object.prototype.hasOwnProperty.call(presets, key)) {
                    _applyGodPreset(node, key, presets);
                }
            }
            return result;
        };
        categoryWidget._xzgGodCategoryCallback = true;
    }
    if (presetWidget && !presetWidget._xzgGodPresetCallback) {
        const originalCallback = presetWidget.callback;
        presetWidget.callback = (...args) => {
            const result = originalCallback?.apply(presetWidget, args);
            const detail = typeof args[0] === "string" ? args[0] : presetWidget.value;
            const category = String(categoryWidget?.value || "");
            if (category === "无" || !detail) return result;
            const presets = _readGodPresetsLocal();
            const key = _godPresetStorageKey(category === "无" ? "" : category, detail === "无" ? "" : detail);
            if (Object.prototype.hasOwnProperty.call(presets, key)) _applyGodPreset(node, key, presets);
            return result;
        };
        presetWidget._xzgGodPresetCallback = true;
    }
    node._xzgGodPresetManagerWidget = node.addWidget("button", xzgLang() === "en" ? "Manage Prompt Presets" : "提示词预设管理", null, () => {
        if (!node._xzgGodPresetDialogOpen) {
            node._xzgGodPresetDialogOpen = true;
            _openGodPresetManagerTree(node).catch(error => {
                console.error("[小珠光文本框-化神级] 打开预设管理失败:", error);
                console.error(xzgLang() === "en" ? "Could not open prompt preset manager." : "无法打开提示词预设管理器。", error);
                node._xzgGodPresetDialogOpen = false;
            });
        }
    });
    _syncGodPresetWidget(node);
    _loadGodPresets().then(presets => _syncAllGodPresetWidgets(presets));
}

if (typeof window !== "undefined") {
    window.XZGRefreshTextBoxGodPresets = async (importedPresets = null) => {
        const presets = importedPresets && typeof importedPresets === "object" && !Array.isArray(importedPresets)
            ? importedPresets : await _loadGodPresets(true);
        if (presets === importedPresets) {
            try { localStorage.setItem(_GOD_PRESETS_KEY, JSON.stringify(presets)); } catch (_) {}
            _godPresetsRestorePromise = Promise.resolve(presets);
            window.dispatchEvent(new CustomEvent("xzg:text-box-presets-imported", { detail: presets }));
        }
        _syncAllGodPresetWidgets(presets);
        return presets;
    };
}

// 给单个节点实例应用双语补丁
function applyBilingual(node) {
    const isEn = xzgLang() === "en";
    const isGodTier = node.type === _NODE_TYPE_GOD || node.comfyClass === _NODE_TYPE_GOD;
    const nodeNameZh = isGodTier ? _NODE_NAME_GOD_ZH : _NODE_NAME_ZH;
    const nodeNameEn = isGodTier ? _NODE_NAME_GOD_EN : _NODE_NAME_EN;

    // 1) 标题
    if (node._xzgOrigTitle == null) node._xzgOrigTitle = node.title || nodeNameZh;
    node.title = isEn ? nodeNameEn : (isGodTier ? nodeNameZh : node._xzgOrigTitle);

    // 2) 输出插槽名（text / text_zh_num）
    // Python 端 RETURN_NAMES 已用英文代号，不改，除非中文端想显示成中文
    // 这里选择不改代号，只保证英文端显示的是通用英文；中文端保持 Python 默认。
    if (isGodTier) {
        const outputsMap = isEn
            ? { text: "Raw Text", text_zh_num: "Num → Chinese" }
            : { text: "原文", text_zh_num: "数字转中文" };
        for (const output of node.outputs || []) {
            if (output._xzgOrigName == null) output._xzgOrigName = output.name;
            output.name = outputsMap[output._xzgOrigName] ?? output._xzgOrigName;
        }
    }

    // 3) Widget：text 的 label、placeholder
    //    输入插槽名（Python INPUT_TYPES 没有自定义输入插槽，只有 text widget）
    const txt = node.widgets?.find((w) => w && w.name === "text");
    if (txt) {
        if (txt._xzgOrigLabel == null) {
            // 首次绑定：保存原始 label / placeholder
            txt._xzgOrigLabel = txt.label || "text";
            txt._xzgOrigPlaceholder =
                txt.element?.getAttribute?.("placeholder") ?? null;
            // ComfyUI 原生 multiline textarea 组件 widget 的 placeholder 属性
            // 直接存在 widget.options?.placeholder 也常见
            if (txt.options?.placeholder && txt._xzgOrigPlaceholder == null) {
                txt._xzgOrigPlaceholder = txt.options.placeholder;
            }
            // 兜底（Python 端传的 placeholder）用中文模板
            if (txt._xzgOrigPlaceholder == null) {
                txt._xzgOrigPlaceholder = _placeholderForLang(isGodTier);
            }
        }
        // label
        txt.label = isEn ? _tr("文本") : (isGodTier ? "文本" : (txt._xzgOrigLabel || "text"));
        // placeholder
        const want = isEn ? _placeholderForLang(isGodTier) : txt._xzgOrigPlaceholder;
        if (txt.element && typeof txt.element.setAttribute === "function") {
            if (txt.element.getAttribute("placeholder") !== want) {
                txt.element.setAttribute("placeholder", want);
            }
        }
        if (txt.options) {
            if (txt.options.placeholder !== want) txt.options.placeholder = want;
        }
    }

    if (isGodTier) {
        const presetWidget = node.widgets?.find(widget => widget?.name === "preset_name");
        const categoryWidget = node.widgets?.find(widget => widget?.name === "preset_category");
        if (categoryWidget) categoryWidget.label = isEn ? "Prompt Type" : "提示词类型";
        if (presetWidget) presetWidget.label = isEn ? "Prompt Subtype" : "提示词细分";
        if (node._xzgGodPresetManagerWidget) {
            node._xzgGodPresetManagerWidget.name = isEn ? "Manage Prompt Presets" : "提示词预设管理";
            node._xzgGodPresetManagerWidget.label = node._xzgGodPresetManagerWidget.name;
        }
    }

    node.setDirtyCanvas?.(true, true);
}

// 给 textarea 打 class + 占位符双语（onNodeCreated 里 DOM 可能还没 ready，用延时）
function ensureTextarea(node) {
    const tag = (ta) => {
        if (!ta) return;
        if (!ta._xzgTagged) { ta._xzgTagged = true; ta.classList.add("xzg-text-box"); }
        if (!ta._xzgFocusBorderGuard) {
            ta._xzgFocusBorderGuard = true;
            const applyWhiteFocusBorder = () => {
                ta.style.setProperty("border", "1px solid #fff", "important");
                ta.style.setProperty("outline", "1px solid #fff", "important");
                ta.style.setProperty("outline-offset", "0", "important");
                ta.style.setProperty("box-shadow", "none", "important");
            };
            ta.addEventListener("focus", applyWhiteFocusBorder);
            // ComfyUI/LiteGraph may update widget inline styles after focus. Reapply
            // while focused so those writes cannot leave the active border black.
            ta.addEventListener("input", applyWhiteFocusBorder);
            ta.addEventListener("keyup", applyWhiteFocusBorder);
            ta.addEventListener("pointerup", applyWhiteFocusBorder);
            ta.addEventListener("blur", () => {
                for (const property of ["border", "outline", "outline-offset", "box-shadow"]) {
                    ta.style.removeProperty(property);
                }
            });
            if (document.activeElement === ta) applyWhiteFocusBorder();
        }
        const isGodTier = node.type === _NODE_TYPE_GOD || node.comfyClass === _NODE_TYPE_GOD;
        const want = _placeholderForLang(isGodTier);
        if (ta.getAttribute("placeholder") !== want) {
            ta.setAttribute("placeholder", want);
        }
    };

    const tryAttach = () => {
        const wid = node.id;
        const selectors = [
            `textarea[data-node-id="${wid}"]`,
            `textarea[node-id="${wid}"]`,
            `[data-node-id="${wid}"] textarea`,
        ];
        for (const sel of selectors) {
            const ta = document.querySelector(sel);
            if (ta) { tag(ta); return true; }
        }
        const root = node.domElement || node.element || null;
        if (root) {
            const ta = root.querySelector("textarea");
            if (ta) { tag(ta); return true; }
        }
        return false;
    };

    if (!tryAttach()) {
        const obs = new MutationObserver(() => {
            if (tryAttach()) obs.disconnect();
        });
        obs.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => obs.disconnect(), 30000);
    }
    // 再补两次延时兜底（setSize 之后 textarea 才 ready）
    setTimeout(() => tryAttach(), 0);
    setTimeout(() => tryAttach(), 50);
}

// 注入 CSS：缩小小珠光文本框 placeholder 字体
(function () {
    const cssId = "xzg-text-box-placeholder-css";
    if (document.getElementById(cssId)) return;
    const s = document.createElement("style");
    s.id = cssId;
    s.textContent = `
textarea.xzg-text-box::placeholder {
    font-size: 14px;
    line-height: 1.5;
    opacity: 0.55;
}
textarea.xzg-text-box:focus,
textarea.xzg-text-box:focus-visible {
    border: 1px solid #fff !important;
    outline: 1px solid #fff !important;
    box-shadow: none !important;
    outline-offset: 0;
}`;
    document.head.appendChild(s);
})();

// ComfyUI 会在画布控件获得焦点时才创建/挂载 multiline textarea。
// 这时按 node.id 查找可能错过输入框；用委托焦点事件兜底，直接识别本节点占位符。
(function () {
    if (window.__xzg_text_box_focus_border_fixed) return;
    window.__xzg_text_box_focus_border_fixed = true;
    const focusProperties = ["border", "outline", "outline-offset", "box-shadow"];
    const isTextBoxTextarea = el => el instanceof HTMLTextAreaElement && (
        el.classList.contains("xzg-text-box") ||
        /小珠光文本框|Xiaozhuguang Text Box/i.test(el.getAttribute("placeholder") || "")
    );
    const applyWhiteBorder = el => {
        el.classList.add("xzg-text-box");
        el.style.setProperty("border", "1px solid #fff", "important");
        el.style.setProperty("outline", "1px solid #fff", "important");
        el.style.setProperty("outline-offset", "0", "important");
        el.style.setProperty("box-shadow", "none", "important");
    };
    let focusedTextarea = null;
    let styleObserver = null;
    document.addEventListener("focusin", event => {
        const el = event.target;
        if (!isTextBoxTextarea(el)) return;
        focusedTextarea = el;
        applyWhiteBorder(el);
        styleObserver?.disconnect();
        styleObserver = new MutationObserver(() => applyWhiteBorder(el));
        styleObserver.observe(el, { attributes: true, attributeFilter: ["style"] });
    }, true);
    document.addEventListener("focusout", event => {
        if (event.target !== focusedTextarea) return;
        styleObserver?.disconnect();
        styleObserver = null;
        for (const property of focusProperties) focusedTextarea.style.removeProperty(property);
        focusedTextarea = null;
    }, true);
})();

// 全局 capture：textarea 不可滚动时把 wheel 转发给画布缩放
(function () {
    if (window.__xzg_textarea_wheel_fixed) return;
    window.__xzg_textarea_wheel_fixed = true;

    window.addEventListener("wheel", (e) => {
        const el = e.target;
        if (!el || el.tagName !== "TEXTAREA") return;
        if (el.scrollHeight > el.clientHeight + 1) return;
        const cv = app.canvas?.canvas;
        if (!cv) return;
        e.preventDefault();
        e.stopPropagation();
        cv.dispatchEvent(new WheelEvent("wheel", {
            deltaY: e.deltaY, deltaX: e.deltaX,
            clientX: e.clientX, clientY: e.clientY,
            ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey,
            bubbles: true, cancelable: true,
        }));
    }, { capture: true, passive: false });
})();

app.registerExtension({
    name: "ComfyUI.xiaozhuguang.text_box_bilingual",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== _NODE_TYPE && nodeData.name !== _NODE_TYPE_GOD) return;

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origCreated?.apply(this, arguments);
            applyBilingual(this);
            ensureTextarea(this);
            if (this.type === _NODE_TYPE_GOD || this.comfyClass === _NODE_TYPE_GOD) _installGodPresetControls(this);
            return r;
        };

        const origConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = origConfigure?.apply(this, arguments);
            applyBilingual(this);
            ensureTextarea(this);
            if (this.type === _NODE_TYPE_GOD || this.comfyClass === _NODE_TYPE_GOD) _installGodPresetControls(this);
            return r;
        };
    },
});

// 热修复入口
if (typeof window !== "undefined") {
    window.XZG_TextBox_applyBilingualAll = function () {
        const graph = app.graph || window.graph;
        let n = 0;
        for (const nd of graph?._nodes || []) {
            if (nd.type === _NODE_TYPE || nd.type === _NODE_TYPE_GOD) { applyBilingual(nd); ensureTextarea(nd); n++; }
        }
        return { patched: n, lang: xzgLang() };
    };
}

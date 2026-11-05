import { app } from "../../scripts/app.js";
import { xzgT } from "./xzg_i18n.js";

const PREVIEW_BUTTON_DEFAULT_COLORS = {
    davinci_export: "#3ef558",
    davinci_import: "#3ef558",
    quickcut_send: "#ff69b4",
    quickcut_load: "#ff69b4",
    clipboard: "#ffd700",
};

function migrateClipboardSettings(node) {
    const properties = node.properties;
    if (!properties) return;
    for (const key of ["xzg_preview_buttons", "xzg_preview_button_colors", "xzg_preview_button_font_sizes"]) {
        const values = properties[key];
        if (!values || values.clipboard !== undefined || !("codex" in values || "doubao" in values)) continue;
        values.clipboard = key === "xzg_preview_buttons"
            ? values.codex !== false || values.doubao !== false
            : values.codex ?? values.doubao;
    }
    if (Array.isArray(properties.xzg_preview_button_order)) {
        properties.xzg_preview_button_order = [...new Set(properties.xzg_preview_button_order.map(
            id => id === "codex" || id === "doubao" ? "clipboard" : id))];
    }
}

export function xzgPreviewButtonVisible(node, id) {
    if (id === "clipboard") migrateClipboardSettings(node);
    return node.properties?.xzg_preview_buttons?.[id] !== false;
}

export function xzgOrderedPreviewActions(node, actions) {
    if (actions.some(action => action.id === "clipboard")) migrateClipboardSettings(node);
    const order = node.properties?.xzg_preview_button_order;
    const remaining = new Map(actions.map(action => [action.id, action]));
    const result = [];
    for (const id of Array.isArray(order) ? order : []) {
        if (remaining.has(id)) { result.push(remaining.get(id)); remaining.delete(id); }
    }
    return [...result, ...remaining.values()];
}

// 标签（悬浮按钮）间距：节点属性 xzg_preview_button_gap（0-40px）。
// 未设置时用默认值：图像加载器 2px（紧凑），其余节点 6px。
export function xzgGetPreviewButtonGap(node) {
    const v = Number(node?.properties?.xzg_preview_button_gap);
    if (Number.isFinite(v) && v >= 0) return Math.min(40, v);
    return node?._xzgImgLoaderUI ? 2 : 6;
}

// 新建节点默认隐藏全部悬浮按钮（设置面板中全部不勾选）；仅 onNodeCreated 调用，
// 工作流恢复（onConfigure）会覆盖 properties，不受影响。设置按钮由调用方排除在外。
export function xzgSetPreviewButtonsDefaultHidden(node, ids) {
    if (ids.includes("clipboard")) migrateClipboardSettings(node);
    node.properties ||= {};
    if (node.properties.xzg_preview_buttons) return;
    node.properties.xzg_preview_buttons = Object.fromEntries(ids.map(id => [id, false]));
}

export function xzgBeginPreviewSettings(node, refresh) {
    const original = {
        buttons: node.properties?.xzg_preview_buttons,
        fontSize: node.properties?.xzg_preview_button_font_size,
        order: node.properties?.xzg_preview_button_order,
        colors: node.properties?.xzg_preview_button_colors,
        sizes: node.properties?.xzg_preview_button_font_sizes,
        gap: node.properties?.xzg_preview_button_gap,
    };
    const pc = node._xzgPreviewContainer;
    if (!document.getElementById("xzg-preview-settings-style")) {
        const style = document.createElement("style");
        style.id = "xzg-preview-settings-style";
        style.textContent = ".xzg-preview-settings-open button { opacity:1 !important; }";
        document.head.append(style);
    }
    pc?.classList.add("xzg-preview-settings-open");
    return {
        update(checks, order, fontSize = node.properties?.xzg_preview_button_font_size ?? 14, colors = node.properties?.xzg_preview_button_colors ?? {}, sizes = node.properties?.xzg_preview_button_font_sizes ?? {}, gap = xzgGetPreviewButtonGap(node)) {
            node.properties ||= {};
            node.properties.xzg_preview_buttons = { ...original.buttons, ...Object.fromEntries([...checks].map(([id, input]) => [id, input.checked])) };
            node.properties.xzg_preview_button_order = order;
            node.properties.xzg_preview_button_font_size = Number(fontSize);
            node.properties.xzg_preview_button_colors = { ...colors };
            node.properties.xzg_preview_button_font_sizes = { ...sizes };
            node.properties.xzg_preview_button_gap = Math.max(0, Math.min(40, Number(gap) || 0));
            refresh?.();
        },
        finish(saved = false) {
            if (!saved) {
                node.properties ||= {};
                for (const [key, value] of [["xzg_preview_buttons", original.buttons], ["xzg_preview_button_order", original.order], ["xzg_preview_button_font_size", original.fontSize], ["xzg_preview_button_colors", original.colors], ["xzg_preview_button_font_sizes", original.sizes], ["xzg_preview_button_gap", original.gap]]) {
                    if (value === undefined) delete node.properties[key];
                    else node.properties[key] = value;
                }
            }
            pc?.classList.remove("xzg-preview-settings-open");
            refresh?.();
            if (pc && !pc.matches(":hover")) {
                for (const button of pc.querySelectorAll("button")) if (!button.disabled) button.style.opacity = "0";
            }
        },
    };
}

export function xzgBuildPreviewActionSettings(container, node, actions, sortable = false, onPreview = null, onFontSize = null, onColors = null, onSizes = null, onGap = null) {
    const ordered = xzgOrderedPreviewActions(node, actions);
    const checks = new Map();
    const colorInputs = new Map();
    const sizeInputs = new Map();
    // 「标签间距」输入框：放在可排序列表外层（列表 re-render 会清空子元素），取消时可还原
    const gapRow = document.createElement("div");
    gapRow.style.cssText = "display:flex;align-items:center;gap:8px;padding:6px 0 2px;";
    const gapLabel = document.createElement("label");
    gapLabel.textContent = xzgT("标签间距", "Label spacing");
    gapLabel.title = xzgT("悬浮按钮之间的间距（像素），随节点大小自适应缩放", "Spacing between floating buttons (px), auto-scales with node size");
    gapLabel.style.cssText = "flex:1;cursor:default;";
    const gapInput = document.createElement("input");
    gapInput.type = "number"; gapInput.min = "0"; gapInput.max = "40"; gapInput.step = "1";
    gapInput.value = String(xzgGetPreviewButtonGap(node));
    gapInput.style.cssText = "width:52px;box-sizing:border-box;";
    gapInput.addEventListener("input", () => onGap?.(Math.max(0, Math.min(40, Number(gapInput.value) || 0))));
    gapRow.append(gapLabel, gapInput);
    if (container.parentElement) container.parentElement.insertBefore(gapRow, container);
    const render = () => {
        container.replaceChildren();
        ordered.forEach(({ id, label }) => {
            const row = document.createElement("div");
            row.style.cssText = "display:flex;align-items:center;gap:6px;padding:5px 0;";
            row.dataset.actionId = id;
            const actionColor = node.properties?.xzg_preview_button_colors?.[id] || PREVIEW_BUTTON_DEFAULT_COLORS[id] || "#ffffff";
            const picker = document.createElement("input"); picker.type = "color"; picker.title = xzgT("字体颜色", "Text color"); picker.value = /^#[0-9a-f]{6}$/i.test(actionColor) ? actionColor : "#ffffff"; picker.style.cssText = "width:42px;height:28px;padding:2px;cursor:pointer;";
            colorInputs.set(id, picker);
            picker.addEventListener("input", () => onColors?.(checks, ordered.map(action => action.id), Number(node.properties?.xzg_preview_button_font_size ?? 14), Object.fromEntries([...colorInputs].map(([key, input]) => [key, input.value])), Object.fromEntries([...sizeInputs].map(([key, input]) => [key, Number(input.value)]))));
            const sizeInput = document.createElement("input"); sizeInput.type = "number"; sizeInput.min = "9"; sizeInput.max = "48"; sizeInput.step = "1"; sizeInput.title = xzgT("该标签字体大小", "Font size for this label"); sizeInput.value = String(node.properties?.xzg_preview_button_font_sizes?.[id] ?? node.properties?.xzg_preview_button_font_size ?? 14); sizeInput.style.cssText = "width:52px;box-sizing:border-box;";
            sizeInputs.set(id, sizeInput);
            sizeInput.addEventListener("input", () => onSizes?.(checks, ordered.map(action => action.id), Number(node.properties?.xzg_preview_button_font_size ?? 14), Object.fromEntries([...colorInputs].map(([key, input]) => [key, input.value])), Object.fromEntries([...sizeInputs].map(([key, input]) => [key, Math.max(9, Math.min(48, Number(input.value) || 12))]))));
            const caption = document.createElement("label");
            caption.style.cssText = "display:flex;align-items:center;gap:8px;flex:1;cursor:pointer;";
            let input = checks.get(id);
            if (!input) {
                input = document.createElement("input");
                input.type = "checkbox";
                input.checked = xzgPreviewButtonVisible(node, id);
                checks.set(id, input);
                input.addEventListener("change", () => onPreview?.(checks, ordered.map(action => action.id)));
            }
            caption.append(input, document.createTextNode(label));
            row.append(caption);
            if (sortable) row.append(picker, sizeInput);
            if (sortable) {
                const handle = document.createElement("span");
                handle.textContent = "⠿";
                handle.title = xzgT("拖动调整顺序", "Drag to reorder");
                handle.style.cssText = "cursor:grab;touch-action:none;user-select:none;padding:4px 8px;font-size:20px;line-height:1;";
                handle.setAttribute("aria-label", handle.title);
                row.prepend(handle);
                let pointerId = null;
                handle.addEventListener("pointerdown", event => {
                    if (event.button !== 0 || pointerId !== null) return;
                    event.preventDefault();
                    event.stopPropagation();
                    pointerId = event.pointerId;
                    document.addEventListener("pointermove", moveDrag);
                    document.addEventListener("pointerup", endDrag);
                    document.addEventListener("pointercancel", endDrag);
                    handle.style.cursor = "grabbing";
                    row.style.background = "rgba(128,128,128,.2)";
                    row.style.outline = "1px solid var(--border-color,#888)";
                });
                const moveDrag = event => {
                    if (event.pointerId !== pointerId) return;
                    event.preventDefault();
                    const siblings = [...container.children].filter(item => item !== row);
                    const next = siblings.find(item => {
                        const rect = item.getBoundingClientRect();
                        return event.clientY < rect.top + rect.height / 2;
                    });
                    container.insertBefore(row, next || null);
                    const byId = new Map(ordered.map(action => [action.id, action]));
                    ordered.splice(0, ordered.length, ...[...container.children].map(item => byId.get(item.dataset.actionId)));
                    onPreview?.(checks, ordered.map(action => action.id));
                    const rect = container.parentElement.getBoundingClientRect();
                    if (event.clientY < rect.top + 24) row.scrollIntoView({ block: "nearest" });
                    else if (event.clientY > rect.bottom - 24) row.scrollIntoView({ block: "nearest" });
                };
                const endDrag = event => {
                    if (event.pointerId !== pointerId) return;
                    pointerId = null;
                    document.removeEventListener("pointermove", moveDrag);
                    document.removeEventListener("pointerup", endDrag);
                    document.removeEventListener("pointercancel", endDrag);
                    handle.style.cursor = "grab";
                    row.style.background = "";
                    row.style.outline = "";
                };

            }
            container.append(row);
        });
    };
    render();
    return { checks, colors: colorInputs, sizes: sizeInputs, gap: gapInput, order: () => ordered.map(action => action.id), fontSize: () => node.properties?.xzg_preview_button_font_size ?? 14 };
}

export function xzgCloseLoaderSettings(node) {
    node._xzgLoaderSettingsDialog?.close();
}

// ── 节点右键菜单项显示管理（与悬浮按钮同一套：随节点/工作流保存，取消可还原） ──
// 存储：node.properties.xzg_menu_items = { [id]: true|false }，缺省视为显示。

export const XZG_MENU_CAPTURE_FRAME = "capture_frame_send_loader";

export function xzgMenuItemVisible(node, id) {
    return node.properties?.xzg_menu_items?.[id] !== false;
}

// 构建「右键菜单」设置分节。defs: [{id, label}]。
// 返回 { el, save(node), restore() }；无 defs 时返回 { el: null, ... }。
export function xzgBuildMenuItemsSection(node, defs) {
    if (!Array.isArray(defs) || defs.length === 0) {
        return { el: null, save() {}, restore() {} };
    }
    const section = document.createElement("fieldset");
    section.style.cssText = "margin:10px 0 0;padding:8px 12px;border:1px solid var(--border-color);border-radius:6px;";
    const legend = document.createElement("legend");
    legend.textContent = xzgT("右键菜单（随工作流保存）", "Context menu (saved with workflow)");
    section.append(legend);
    const original = node.properties?.xzg_menu_items;
    const checks = new Map();
    for (const def of defs) {
        if (!def?.id) continue;
        const row = document.createElement("div");
        row.style.cssText = "display:flex;align-items:center;gap:6px;padding:5px 0;";
        const label = document.createElement("label");
        label.style.cssText = "display:flex;align-items:center;gap:8px;flex:1;cursor:pointer;";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = xzgMenuItemVisible(node, def.id);
        checks.set(def.id, input);
        label.append(input, document.createTextNode(def.label || def.id));
        row.append(label);
        section.append(row);
    }
    return {
        el: section,
        save(target = node) {
            target.properties ||= {};
            target.properties.xzg_menu_items = {
                ...original,
                ...Object.fromEntries([...checks].map(([id, input]) => [id, input.checked])),
            };
        },
        restore() {
            if (original === undefined) delete node.properties?.xzg_menu_items;
            else node.properties.xzg_menu_items = original;
        },
    };
}

export function xzgShowLoaderSettings(node, actions, refresh, menuItems = []) {
    if (node._xzgLoaderSettingsDialog?.open) {
        node._xzgLoaderSettingsDialog.focus();
        return;
    }
    const dialog = document.createElement("dialog");
    node._xzgLoaderSettingsDialog = dialog;
    dialog.style.cssText = "width:340px;max-width:90vw;max-height:80vh;overflow:auto;box-sizing:border-box;padding:20px;border:1px solid var(--border-color);border-radius:10px;background:var(--comfy-menu-bg,#222);color:var(--input-text,#eee);font:14px sans-serif;box-shadow:0 12px 40px #0008;";
    const title = document.createElement("h3");
    title.textContent = xzgT("加载器设置", "Loader settings");
    title.style.cssText = "margin:0 0 18px;font-size:17px;cursor:move;user-select:none;touch-action:none;";
    title.title = xzgT("拖动标题移动设置面板", "Drag the title to move settings");
    let drag = null;
    title.addEventListener("pointerdown", event => {
        if (event.button !== 0 || drag) return;
        event.preventDefault();
        event.stopPropagation();
        const rect = dialog.getBoundingClientRect();
        drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
        // Replace the native dialog's centered auto margins with viewport coordinates.
        dialog.style.position = "fixed";
        dialog.style.margin = "0";
        dialog.style.inset = "auto";
        dialog.style.left = `${rect.left}px`;
        dialog.style.top = `${rect.top}px`;
        title.setPointerCapture(event.pointerId);
    });
    title.addEventListener("pointermove", event => {
        if (!drag || event.pointerId !== drag.id) return;
        const rect = dialog.getBoundingClientRect();
        dialog.style.left = `${Math.max(0, Math.min(Math.max(0, window.innerWidth - rect.width), drag.left + event.clientX - drag.x))}px`;
        dialog.style.top = `${Math.max(0, Math.min(Math.max(0, window.innerHeight - rect.height), drag.top + event.clientY - drag.y))}px`;
    });
    const endDrag = event => {
        if (!drag || event.pointerId !== drag.id) return;
        drag = null;
        if (title.hasPointerCapture(event.pointerId)) title.releasePointerCapture(event.pointerId);
    };
    title.addEventListener("pointerup", endDrag);
    title.addEventListener("pointercancel", endDrag);
    title.addEventListener("lostpointercapture", endDrag);
    dialog.append(title);
    const section = document.createElement("fieldset");
    section.style.cssText = "margin:0;padding:8px 12px;border:1px solid var(--border-color);border-radius:6px;";
    const legend = document.createElement("legend");
    legend.textContent = xzgT("预览区悬浮按钮", "Preview floating buttons");
    section.append(legend);
    const list = document.createElement("div");
    section.append(list);
    const preview = xzgBeginPreviewSettings(node, refresh);
    let saved = false;
    let controls;
    controls = xzgBuildPreviewActionSettings(list, node, actions, true, (checks, order) => preview.update(checks, order, controls?.fontSize(), Object.fromEntries([...(controls?.colors || [])].map(([id, input]) => [id, input.value])), Object.fromEntries([...(controls?.sizes || [])].map(([id, input]) => [id, Number(input.value)]))),
        fontSize => preview.update(controls?.checks || new Map(), controls?.order() || [], fontSize, Object.fromEntries([...(controls?.colors || [])].map(([id, input]) => [id, input.value])), Object.fromEntries([...(controls?.sizes || [])].map(([id, input]) => [id, Number(input.value)]))),
        (checks, order, size, colors, sizes) => preview.update(checks, order, size, colors, sizes),
        (checks, order, size, colors, sizes) => preview.update(checks, order, size, colors, sizes),
        gap => preview.update(controls?.checks || new Map(), controls?.order() || [], controls?.fontSize(), Object.fromEntries([...(controls?.colors || [])].map(([id, input]) => [id, input.value])), Object.fromEntries([...(controls?.sizes || [])].map(([id, input]) => [id, Number(input.value)])), gap));
    dialog.append(section);
    // 右键菜单分节：与悬浮按钮同一套保存/取消语义
    const menuSection = xzgBuildMenuItemsSection(node, menuItems);
    if (menuSection.el) dialog.append(menuSection.el);
    const hint = document.createElement("p");
    hint.textContent = xzgT("仅作用于当前节点，随工作流保存。", "Applies to this node and is saved with the workflow.");
    hint.style.cssText = "font-size:12px;opacity:.65;margin:12px 0;";
    dialog.append(hint);
    const footer = document.createElement("div");
    footer.style.cssText = "display:flex;justify-content:flex-end;gap:10px;margin-top:18px;";
    const cancel = document.createElement("button");
    cancel.textContent = xzgT("取消", "Cancel");
    cancel.addEventListener("click", () => dialog.close());
    const save = document.createElement("button");
    save.textContent = xzgT("保存", "Save");
    save.addEventListener("click", () => {
        node.properties ||= {};
        node.properties.xzg_preview_buttons = { ...node.properties.xzg_preview_buttons, ...Object.fromEntries([...controls.checks].map(([id, input]) => [id, input.checked])) };
        node.properties.xzg_preview_button_order = controls.order();
        node.properties.xzg_preview_button_font_size = controls.fontSize();
        node.properties.xzg_preview_button_colors = Object.fromEntries([...controls.colors].map(([id, input]) => [id, input.value]));
        node.properties.xzg_preview_button_font_sizes = Object.fromEntries([...controls.sizes].map(([id, input]) => [id, Number(input.value)]));
        node.properties.xzg_preview_button_gap = Math.max(0, Math.min(40, Number(controls.gap?.value) || 0));
        saved = true;
        menuSection.save(node);
        refresh();
        node.graph?.change?.();
        app.graph?.setDirtyCanvas?.(true, true);
        dialog.close();
    });
    for (const button of [cancel, save]) button.style.cssText = "padding:6px 18px;cursor:pointer;";
    footer.append(cancel, save);
    dialog.append(footer);
    dialog.addEventListener("click", event => {
        if (event.target !== dialog) return;
        const rect = dialog.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    });
    dialog.addEventListener("close", () => {
        preview.finish(saved);
        if (!saved) menuSection.restore();
        if (node._xzgLoaderSettingsDialog === dialog) delete node._xzgLoaderSettingsDialog;
        dialog.remove();
    }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
    requestAnimationFrame(() => {
        const rect = dialog.getBoundingClientRect();
        dialog.style.position = "fixed"; dialog.style.margin = "0"; dialog.style.inset = "auto";
        dialog.style.left = `${Math.max(12, window.innerWidth - rect.width - 24)}px`;
        dialog.style.top = `${Math.max(12, Math.min(80, (window.innerHeight - rect.height) / 2))}px`;
    });
}

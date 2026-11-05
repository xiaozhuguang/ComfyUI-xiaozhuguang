import { app } from "../../scripts/app.js";

const LEGACY_WIDGETS = [
    "cleanup_enabled", "threshold", "method", "shrink", "min_pixels", "min_frames", "edge_grow",
    "repair_enabled", "erode_dilate", "fill_holes", "remove_isolated_pixels", "smooth", "blur",
    "mask_binarize", "mask_threshold", "tapered_corners",
];

app.registerExtension({
    name: "Xiaozhuguang.MaskCleanupRepair",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "XiaozhuguangMaskCleanupRepair") return;
        const sync = node => {
            const widget = name => node.widgets?.find(item => item.name === name);
            const groups = {
                cleanup_enabled: ["threshold", "method", "shrink", "min_pixels", "min_frames", "edge_grow"],
                repair_enabled: ["fill_holes", "remove_isolated_pixels", "smooth", "blur"],
                mask_binarize: ["mask_threshold"],
            };
            for (const [toggle, names] of Object.entries(groups)) {
                // A linked switch is determined at execution time, rather than by its saved widget value.
                const linked = node.inputs?.some(input => input.name === toggle && input.link != null);
                const disabled = !linked && widget(toggle)?.value === false;
                for (const name of names) {
                    const item = widget(name);
                    if (item) item.disabled = disabled;
                }
            }
            node.setDirtyCanvas?.(true, true);
        };
        const created = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function (...args) {
            const result = created?.apply(this, args);
            for (const name of ["cleanup_enabled", "repair_enabled", "mask_binarize"]) {
                const widget = this.widgets?.find(item => item.name === name);
                if (!widget) continue;
                const callback = widget.callback;
                const node = this;
                widget.callback = function (value, ...rest) {
                    this.value = value;
                    const result = callback?.call(this, value, ...rest);
                    sync(node);
                    return result;
                };
            }
            sync(this);
            return result;
        };
        const connections = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function (...args) {
            const result = connections?.apply(this, args);
            sync(this);
            return result;
        };
        const configure = nodeType.prototype.configure;
        nodeType.prototype.configure = function (info, ...args) {
            const values = info?.widgets_values;
            // Older workflows start with the cleanup switch; expansion is now first.
            if (Array.isArray(values) && typeof values[0] === "boolean") {
                const saved = Object.fromEntries(LEGACY_WIDGETS.map((name, index) => [name, values[index]]));
                info = { ...info, widgets_values: (this.widgets || []).map(widget =>
                    saved[widget.name] !== undefined ? saved[widget.name] : widget.value) };
            }
            const result = configure?.call(this, info, ...args);
            sync(this);
            return result;
        };
    },
});

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
        const configure = nodeType.prototype.configure;
        nodeType.prototype.configure = function (info, ...args) {
            const values = info?.widgets_values;
            // Older workflows start with the cleanup switch; expansion is now first.
            if (Array.isArray(values) && typeof values[0] === "boolean") {
                const saved = Object.fromEntries(LEGACY_WIDGETS.map((name, index) => [name, values[index]]));
                info = { ...info, widgets_values: (this.widgets || []).map(widget =>
                    saved[widget.name] !== undefined ? saved[widget.name] : widget.value) };
            }
            return configure?.call(this, info, ...args);
        };
    },
});

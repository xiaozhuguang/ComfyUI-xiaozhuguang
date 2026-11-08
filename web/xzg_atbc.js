import { app } from "../../scripts/app.js";
import { xzgT } from "./xzg_i18n.js";

app.registerExtension({
    name: "xiaozhuguang.atbcCropToggle",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "XiaozhuguangATBC") return;
        const sync = node => {
            const mask = node.inputs?.find(input => input.name === "mask");
            if (mask) {
                mask.type = "MASK";
                mask.label = mask.localized_name = xzgT("遮罩", "Mask");
            }
            const widget = name => node.widgets?.find(w => w.name === name);
            // Older saved nodes have no serialized values for the appended controls.
            for (const [name, values] of Object.entries({
                crop_mode: ["遮罩平滑", "视频稳定跟踪"],
                tracking_preference: ["稳定优先", "紧凑优先"],
                tracking_scale: ["固定大小", "动态缩放"],
                alignment_mode: ["扩充", "变形"],
            })) {
                const item = widget(name);
                if (item && !values.includes(item.value)) item.value = values[0];
            }
            const margin = widget("margin_percent");
            if (margin && !Number.isFinite(margin.value)) margin.value = 10;
            // Runtime input values, including external connections, decide applicability.
            for (const name of ["tracking_preference", "tracking_scale", "mask_smooth", "crop_mode"]) {
                const item = widget(name);
                if (item) item.disabled = false;
            }
            node.setDirtyCanvas?.(true, true);
        };
        const created = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function (...args) {
            const result = created?.apply(this, args);
            for (const name of ["enable_crop", "sum_mask", "crop_mode"]) {
                const widget = this.widgets?.find(w => w.name === name);
                if (!widget) continue;
                const callback = widget.callback;
                widget.callback = (value, ...rest) => {
                    widget.value = value;
                    const result = callback?.call(widget, value, ...rest);
                    sync(this);
                    return result;
                };
            }
            sync(this);
            return result;
        };
        const connections = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function (...args) {
            const result = connections?.apply(this, args);
            setTimeout(() => sync(this), 0);
            return result;
        };
        const configure = nodeType.prototype.configure;
        nodeType.prototype.configure = function (info, ...args) {
            const index = this.widgets?.findIndex(w => w.name === "enable_crop") ?? -1;
            const values = info?.widgets_values;
            // Old schema: smooth at 6, sum at 7, pixels at 8, mode at 9.
            // New schema places smooth directly below mode, at 9.
            if (Array.isArray(values) && typeof values[6] === "number" && typeof values[7] === "boolean") {
                info = { ...info, widgets_values: [...values] };
                const [smooth] = info.widgets_values.splice(6, 1);
                info.widgets_values.splice(9, 0, smooth);
            }
            // The crop toggle replaces the former numeric threshold in the same slot.
            // Legacy thresholds must not be restored as boolean widget values.
            if (index >= 0 && Array.isArray(values) && typeof values[index] === "number") {
                info = { ...info, widgets_values: [...info.widgets_values] };
                info.widgets_values[index] = true;
            }
            // Remove the retired pixel-expansion slot after normalizing the old order.
            const normalized = info?.widgets_values;
            if (Array.isArray(normalized) && typeof normalized[7] === "number"
                && ["遮罩平滑", "视频稳定跟踪"].includes(normalized[8])) {
                info = { ...info, widgets_values: [...normalized] };
                info.widgets_values.splice(7, 1);
            }
            const marginIndex = this.widgets?.findIndex(w => w.name === "margin_percent") ?? -1;
            if (marginIndex >= 0 && Array.isArray(info?.widgets_values) && !info.xzg_margin_percent) {
                const values = [...info.widgets_values];
                values[marginIndex] = 10;
                info = { ...info, widgets_values: values };
            }
            const result = configure?.call(this, info, ...args);
            sync(this);
            return result;
        };
        const serialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function(info, ...args) {
            const result = serialize?.call(this, info, ...args);
            info.xzg_margin_percent = true;
            return result;
        };
    },
});

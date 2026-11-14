import { app } from "../../scripts/app.js";
import { xzgT } from "./xzg_i18n.js";

app.registerExtension({
    name: "xiaozhuguang.atbcCropToggle",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "XiaozhuguangATBC") return;
        const smoothingWidgets = ["position_smoothing_frames", "scale_smoothing_frames"];
        const sync = node => {
            const mask = node.inputs?.find(input => input.name === "mask");
            if (mask) {
                mask.type = "MASK";
                mask.label = mask.localized_name = xzgT("遮罩", "Mask");
            }
            const widget = name => node.widgets?.find(w => w.name === name);
            const margin = widget("margin_percent");
            if (margin && !Number.isFinite(margin.value)) margin.value = 10;
            for (const name of smoothingWidgets) {
                const item = widget(name);
                const defaultValue = nodeData.input?.optional?.[name]?.[1]?.default;
                if (item && !Number.isFinite(item.value) && Number.isFinite(defaultValue)) {
                    item.value = defaultValue;
                }
            }
            node.setDirtyCanvas?.(true, true);
        };
        const created = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function (...args) {
            const result = created?.apply(this, args);
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
            if (marginIndex >= 0 && Array.isArray(info?.widgets_values)) {
                const saved = [...info.widgets_values];
                if (["遮罩平滑", "逐帧裁剪", "视频稳定跟踪", "人脸构图"].includes(saved[marginIndex])) {
                    saved.splice(marginIndex, 1);
                    if (typeof saved[marginIndex] === "number") saved.splice(marginIndex, 1);
                    if (["稳定优先", "紧凑优先"].includes(saved[marginIndex])) saved.splice(marginIndex, 1);
                    if (["固定大小", "动态缩放"].includes(saved[marginIndex])) saved.splice(marginIndex, 1);
                    if (["扩充", "变形"].includes(saved[marginIndex])) saved.splice(marginIndex, 1);
                    info = { ...info, widgets_values: saved };
                }
            }
            if (marginIndex >= 0 && Array.isArray(info?.widgets_values) && !info.xzg_margin_percent) {
                const values = [...info.widgets_values];
                values[marginIndex] = 10;
                info = { ...info, widgets_values: values };
            }
            if (Array.isArray(info?.widgets_values) && !info.xzg_smoothing_frames) {
                const values = [...info.widgets_values];
                for (const name of smoothingWidgets) {
                    const index = this.widgets?.findIndex(w => w.name === name) ?? -1;
                    if (index >= 0 && Number.isFinite(values[index])) {
                        values[index] = Math.max(1, Math.min(240, Math.round(values[index] * 6)));
                    }
                }
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
            info.xzg_smoothing_frames = true;
            return result;
        };
    },
});

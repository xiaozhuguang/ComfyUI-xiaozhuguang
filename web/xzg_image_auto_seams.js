import { app } from "../../scripts/app.js";
app.registerExtension({
    name: "xiaozhuguang.imageAutomaticSeams",
    beforeRegisterNodeDef(type, data) {
        if (!["XiaozhuguangImageCrop", "XiaozhuguangImageRestore"].includes(data.name)) return;
        const configure = type.prototype.configure;
        type.prototype.configure = function(info, ...args) {
            if (Array.isArray(info?.widgets_values) && !info.xzg_image_auto_seams) {
                const values = [...info.widgets_values];
                if (data.name === "XiaozhuguangImageRestore") {
                    values.splice(0, 2);
                    values.splice(5, 0, false);
                } else {
                    // Last slot used to be additive pixel expansion.
                    const index = this.widgets?.findIndex(w => w.name === "margin_percent");
                    if (index >= 0) values[index] = 10;
                }
                info = { ...info, widgets_values: values };
            }
            if (data.name === "XiaozhuguangImageRestore" && Array.isArray(info?.widgets_values)
                && info.xzg_image_auto_seams !== 2) {
                const v = info.widgets_values;
                info = { ...info, widgets_values: [v[0], v[2], v[5], v[6]] };
            }
            const marginIndex = this.widgets?.findIndex(w => w.name === "margin_percent") ?? -1;
            if (marginIndex >= 0 && Array.isArray(info?.widgets_values) && !info.xzg_margin_percent) {
                const values = [...info.widgets_values];
                values[marginIndex] = 10;
                info = { ...info, widgets_values: values };
            }
            return configure?.call(this, info, ...args);
        };
        const serialize = type.prototype.onSerialize;
        type.prototype.onSerialize = function(info, ...args) {
            const result = serialize?.call(this, info, ...args);
            info.xzg_image_auto_seams = 2;
            info.xzg_margin_percent = true;
            return result;
        };
    },
});

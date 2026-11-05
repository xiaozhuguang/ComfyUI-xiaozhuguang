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
                    const index = this.widgets?.findIndex(w => w.name === "min_margin");
                    if (index >= 0) values[index] = 30;
                }
                info = { ...info, widgets_values: values };
            }
            return configure?.call(this, info, ...args);
        };
        const serialize = type.prototype.onSerialize;
        type.prototype.onSerialize = function(info, ...args) {
            const result = serialize?.call(this, info, ...args);
            info.xzg_image_auto_seams = true;
            return result;
        };
    },
});

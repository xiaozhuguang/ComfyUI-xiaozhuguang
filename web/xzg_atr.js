import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "xiaozhuguang.atrManualControlsOrder",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "XiaozhuguangATR") return;
        const configure = nodeType.prototype.configure;
        nodeType.prototype.configure = function (info, ...args) {
            if (Array.isArray(info?.widgets_values) && ![2, 3].includes(info.xzg_atr_auto_controls)) {
                let values = [...info.widgets_values];
                if (!info.xzg_atr_auto_controls && info.xzg_atr_manual_last) {
                    values = values.slice(0, -2);
                } else if (!info.xzg_atr_auto_controls && typeof values[0] === "number" && typeof values[1] === "number") {
                    values = values.slice(2);
                }
                // The automatic toggle was appended after seam_preview.
                if (values.length > 6) values = values.slice(0, 6);
                info = { ...info, widgets_values: values };
            }
            if (Array.isArray(info?.widgets_values) && info.xzg_atr_auto_controls !== 3) {
                const v = info.widgets_values;
                info = { ...info, widgets_values: [v[0], v[2], v[4], v[5]] };
            }
            return configure?.call(this, info, ...args);
        };
        const serialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function (info, ...args) {
            const result = serialize?.call(this, info, ...args);
            info.xzg_atr_auto_controls = 3;
            delete info.xzg_atr_manual_last;
            return result;
        };
    },
});

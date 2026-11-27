import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "xiaozhuguang.videoColorCalibratorSingleMode",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "XiaozhuguangVideoColorCalibrator") return;
        const hasLegacySmooth = Boolean(nodeData.input?.required?.smooth);
        const configure = nodeType.prototype.configure;
        nodeType.prototype.configure = function (info, ...args) {
            const values = info?.widgets_values;
            if (Array.isArray(values)) {
                const legacyMode = ["quantile", "linear"].includes(values[0]);
                if (!hasLegacySmooth && values.length > 1) {
                    const strengthIndex = legacyMode ? 2 : 1;
                    info = { ...info, widgets_values: values.slice(strengthIndex, strengthIndex + 1) };
                } else if (legacyMode) {
                    info = { ...info, widgets_values: values.slice(1) };
                }
            }
            return configure?.call(this, info, ...args);
        };
        if (hasLegacySmooth) return;
        const afterConfigure = nodeType.prototype.onAfterGraphConfigured;
        nodeType.prototype.onAfterGraphConfigured = function (...args) {
            afterConfigure?.apply(this, args);
            for (let i = (this.inputs?.length ?? 0) - 1; i >= 0; i--) {
                if (["mode", "smooth", "lock_per_shot"].includes(this.inputs[i].name)) {
                    this.removeInput(i);
                }
            }
        };
    },
});

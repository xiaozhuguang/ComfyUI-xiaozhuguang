import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "xiaozhuguang.videoColorCalibratorSingleMode",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "XiaozhuguangVideoColorCalibrator") return;
        const configure = nodeType.prototype.configure;
        nodeType.prototype.configure = function (info, ...args) {
            const values = info?.widgets_values;
            if (Array.isArray(values) && ["quantile", "linear"].includes(values[0])) {
                info = { ...info, widgets_values: values.slice(1) };
            }
            return configure?.call(this, info, ...args);
        };
    },
});

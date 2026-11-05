import { app } from "../../scripts/app.js";

const PRESETS = {
    "智谱": { api_url: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash-250414" },
    "百度千帆": { api_url: "https://qianfan.baidubce.com/v2", model: "ernie-4.5-turbo-128k" },
};

function applyPreset(node, provider, resetModel) {
    const preset = PRESETS[provider];
    if (!preset) return;
    for (const name of ["api_url", "model"]) {
        const widget = node.widgets?.find(item => item.name === name);
        if (!widget) continue;
        // Loading a workflow must retain an explicitly chosen model.
        if (name === "model" && !resetModel && String(widget.value ?? "").trim()) continue;
        widget.value = preset[name];
        widget.callback?.(widget.value);
    }
    node.setDirtyCanvas?.(true, true);
}

app.registerExtension({
    name: "xiaozhuguang.api_translate.presets",
    nodeCreated(node) {
        if ((node.comfyClass || node.type) !== "XiaozhuguangAPITranslate") return;
        const provider = node.widgets?.find(item => item.name === "provider");
        if (!provider || provider._xzgTranslatePresetInstalled) return;
        provider._xzgTranslatePresetInstalled = true;
        const callback = provider.callback;
        provider.callback = function (value, ...args) {
            const result = callback?.call(this, value, ...args);
            applyPreset(node, value, true);
            node.graph?.change?.();
            return result;
        };
        const configure = node.onConfigure;
        node.onConfigure = function (...args) {
            const result = configure?.apply(this, args);
            applyPreset(this, provider.value, false);
            return result;
        };
        applyPreset(node, provider.value, false);
    },
});

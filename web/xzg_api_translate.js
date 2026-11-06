import { app } from "../../scripts/app.js";

const PRESETS = {
    "智谱": { api_url: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash-250414" },
    "百度千帆": { api_url: "https://qianfan.baidubce.com/v2", model: "ernie-4.5-turbo-128k" },
};
const GGUF_PROVIDER = "Hy-MT2 (GGUF)";
const API_WIDGETS = new Set(["api_key", "model", "target_language", "instructions", "timeout"]);

function updateMode(node, provider, resize) {
    const gguf = provider === GGUF_PROVIDER;
    const previousHeight = resize ? node.computeSize()[1] : 0;
    for (const widget of node.widgets) {
        if (widget.name === "api_url") {
            widget.hidden = true;
        } else if (API_WIDGETS.has(widget.name)) {
            widget.hidden = gguf;
        } else if (widget.name.startsWith("gguf_")) {
            widget.hidden = !gguf;
        }
    }
    if (resize) {
        const height = node.computeSize()[1];
        node.setSize([node.size[0], Math.max(height, node.size[1] + height - previousHeight)]);
    }
    node.setDirtyCanvas?.(true, true);
}

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
        const apiKey = node.widgets?.find(item => item.name === "api_key");
        if (!provider || !apiKey || provider._xzgTranslatePresetInstalled) return;
        provider._xzgTranslatePresetInstalled = true;
        const widgets = [...node.widgets];
        const ordered = [provider, apiKey, ...widgets.filter(widget => widget !== provider && widget !== apiKey)];
        const toOriginal = ordered.map(widget => widgets.indexOf(widget));
        node.widgets.splice(0, widgets.length, ...ordered);

        // Keep workflow values in their original order so existing saves still load.
        const configureWidgets = node.configure;
        node.configure = function (info, ...args) {
            if (Array.isArray(info?.widgets_values)) {
                const values = info.widgets_values;
                info = { ...info, widgets_values: [
                    ...toOriginal.map(index => values[index]),
                    ...values.slice(widgets.length),
                ] };
            }
            return configureWidgets.call(this, info, ...args);
        };
        const serialize = node.onSerialize;
        node.onSerialize = function (info, ...args) {
            if (Array.isArray(info.widgets_values)) {
                const values = [...info.widgets_values];
                toOriginal.forEach((index, position) => {
                    info.widgets_values[index] = values[position];
                });
            }
            return serialize?.call(this, info, ...args);
        };

        let lastApiProvider;
        const callback = provider.callback;
        provider.callback = function (value, ...args) {
            const result = callback?.call(this, value, ...args);
            if (PRESETS[value]) {
                applyPreset(node, value, lastApiProvider !== undefined && lastApiProvider !== value);
                lastApiProvider = value;
            }
            updateMode(node, value, true);
            node.graph?.change?.();
            return result;
        };
        const configure = node.onConfigure;
        node.onConfigure = function (...args) {
            const result = configure?.apply(this, args);
            // Older workflows can restore the retired original-text output.
            if (this.outputs?.length > 1) this.removeOutput(1);
            lastApiProvider = PRESETS[provider.value] ? provider.value : undefined;
            applyPreset(this, provider.value, false);
            updateMode(this, provider.value, false);
            return result;
        };
        lastApiProvider = PRESETS[provider.value] ? provider.value : undefined;
        applyPreset(node, provider.value, false);
        updateMode(node, provider.value, false);
    },
});

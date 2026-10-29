import { app } from "../../scripts/app.js";

const CONTEXT_BY_PROFILE = { "24GB": 8192, "48GB": 32768 };

app.registerExtension({
    name: "xiaozhuguang.qwenLoaderVramProfile",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "XiaozhuguangQwenModelLoader") return;

        function syncContext(node, reset) {
            const profile = node.widgets?.find(w => w.name === "vram_profile");
            const context = node.widgets?.find(w => w.name === "context_length");
            const limit = CONTEXT_BY_PROFILE[profile?.value];
            if (!context || !limit) return;
            if (reset || Number(context.value) > limit) {
                context.value = limit;
                context.callback?.call(context, limit, node);
                node.setDirtyCanvas?.(true, true);
            }
        }

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);
            const profile = this.widgets?.find(w => w.name === "vram_profile");
            if (profile) {
                const callback = profile.callback;
                const node = this;
                profile.callback = function (value, ...args) {
                    const result = callback?.call(this, value, ...args);
                    profile.value = value;
                    syncContext(node, true);
                    return result;
                };
            }
            syncContext(this, true);
            return result;
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const result = onConfigure?.apply(this, arguments);
            // Preserve saved custom context lengths within the selected profile's cap.
            syncContext(this, false);
            return result;
        };
    },
});

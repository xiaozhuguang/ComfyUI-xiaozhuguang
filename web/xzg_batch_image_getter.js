import { app } from "../../scripts/app.js";

const NODE_TYPE = "XiaozhuguangBatchImageGetter";
const MAX_OUTPUTS = 20;

function requestedOutputCount(node) {
    const widget = (node.widgets || []).find((item) => item?.name === "输出数量");
    const value = Number(widget?.value ?? 7);
    return Math.max(1, Math.min(MAX_OUTPUTS, Number.isFinite(value) ? Math.trunc(value) : 7));
}

function resizeOutputs(node) {
    const count = requestedOutputCount(node);
    while ((node.outputs || []).length > count) node.removeOutput(node.outputs.length - 1);
    while ((node.outputs || []).length < count) node.addOutput(String(node.outputs.length + 1), "IMAGE");
    node.setSize(node.computeSize());
    node.setDirtyCanvas?.(true, true);
}

app.registerExtension({
    name: "ComfyUI.xiaozhuguang.batch_image_getter",
    setup() {
        const originalAfterConfigure = app.graph.afterConfigure;
        app.graph.afterConfigure = function () {
            const result = originalAfterConfigure?.apply(this, arguments);
            for (const node of this._nodes || []) {
                if (node.type === NODE_TYPE) resizeOutputs(node);
            }
            return result;
        };
    },
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        const originalCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = originalCreated?.apply(this, arguments);
            resizeOutputs(this);
            const widget = (this.widgets || []).find((item) => item?.name === "输出数量");
            if (widget) {
                const originalCallback = widget.callback;
                widget.callback = (...args) => {
                    const callbackResult = originalCallback?.apply(widget, args);
                    resizeOutputs(this);
                    return callbackResult;
                };
            }
            return result;
        };
    },
});

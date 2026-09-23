import { app } from "../../scripts/app.js";

const NODE_TYPE = "XiaozhuguangBatchImageGetter";
const MAX_OUTPUTS = 20;

function clampCount(value) {
    const n = Number(value);
    return Math.max(1, Math.min(MAX_OUTPUTS, Number.isFinite(n) ? Math.trunc(n) : 7));
}

function requestedOutputCount(node, prefer) {
    // 优先使用外部明确传入的数量（如 onConfigure 从序列化 widgets_values 直接解析），
    // 避免依赖"控件值是否已套用"的时序——切工作流重建节点时控件值常仍停留在默认 7。
    if (prefer !== undefined) return clampCount(prefer);
    const widget = (node.widgets || []).find((item) => item?.name === "输出数量");
    return clampCount(widget?.value);
}

function resizeOutputs(node, prefer) {
    const count = requestedOutputCount(node, prefer);
    // 仅在保存的“输出数量”之外移除端口；有效编号（1..count）的槽位索引始终不变。
    while ((node.outputs || []).length > count) node.removeOutput(node.outputs.length - 1);
    while ((node.outputs || []).length < count) node.addOutput(String(node.outputs.length + 1), "IMAGE");
    node.setSize(node.computeSize());
    node.setDirtyCanvas?.(true, true);
}

function widgetsValueCount(node, info) {
    // 直接读序列化的「输出数量」，绕开 configure 过程中控件值尚未写回 widget.value 的窗口。
    if (!info?.widgets_values || !Array.isArray(info.widgets_values)) return undefined;
    const idx = (node.widgets || []).findIndex((item) => item?.name === "输出数量");
    if (idx < 0 || info.widgets_values[idx] == null) return undefined;
    const n = Number(info.widgets_values[idx]);
    return Number.isFinite(n) ? n : undefined;
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

        // 关键修复：切换工作流再切回时节点被重建，reload 路径下直接读序列化数据里的
        // 「输出数量」来校正端口数，避免按未套用的默认值(7)重建出 7 个端口。
        const originalOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            const result = originalOnConfigure?.apply(this, arguments);
            resizeOutputs(this, widgetsValueCount(this, info));
            return result;
        };
    },
});

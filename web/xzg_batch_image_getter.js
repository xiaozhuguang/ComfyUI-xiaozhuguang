import { app } from "../../scripts/app.js";
import { xzgT } from "./xzg_i18n.js";

const LIST_GETTER = "XiaozhuguangBatchListGetter";
const LIST_GETTER_TYPES = new Set([
    "XiaozhuguangBatchImageGetter",
    "XiaozhuguangBatchMaskGetter",
    LIST_GETTER,
]);
const NODE_TYPES = LIST_GETTER_TYPES;
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

function resizeOutputs(node, prefer, mode, disconnectChanged = false) {
    const count = requestedOutputCount(node, prefer);
    const selected = mode ?? node.widgets?.find((item) => item?.name === "类型")?.value;
    const isMask = selected === "遮罩";
    const type = isMask ? "MASK" : "IMAGE";
    while ((node.outputs || []).length > count) node.removeOutput(node.outputs.length - 1);
    while ((node.outputs || []).length < count) node.addOutput(String(node.outputs.length + 1), type);
    for (let index = 0; index < count; index++) {
        if (disconnectChanged && node.outputs[index].type !== type) {
            node.disconnectOutput(index);
        }
        node.outputs[index].name = String(index + 1);
        node.outputs[index].type = type;
    }
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

function normalizeListGetterInput(node) {
    if (!LIST_GETTER_TYPES.has(node.type) || !Array.isArray(node.inputs)) return;

    const mode = node.widgets?.find((item) => item?.name === "类型")?.value;
    const image = node.inputs.find((slot) => slot.name === "图像");
    const mask = node.inputs.find((slot) => slot.name === "遮罩");
    let data = node.inputs.find((slot) => slot.name === "数据");

    // 旧工作流同时带有“图像/遮罩”槽时，按类型优先保留对应连线；
    // 若对应槽未连接，则保留另一个已连接槽，避免升级后丢失用户的数据线。
    const preferred = mode === "遮罩" ? mask : image;
    const keep = (preferred?.link != null ? preferred : null)
        ?? (image?.link != null ? image : null)
        ?? (mask?.link != null ? mask : null)
        ?? data ?? image ?? mask;

    if (!keep) {
        data = node.addInput("数据", "IMAGE,MASK");
    } else {
        keep.name = "数据";
        keep.type = "IMAGE,MASK";
        data = keep;
    }

    for (let index = node.inputs.length - 1; index >= 0; index--) {
        if (node.inputs[index] !== data) node.removeInput(index);
    }

    data.name = "数据";
    data.type = "IMAGE,MASK";
    data.label = data.localized_name = xzgT("图像／遮罩", "Image / Mask");
    if (data.link != null) {
        const link = node.graph?.getLink?.(data.link) ?? node.graph?.links?.[data.link];
        if (link) {
            link.target_id = node.id;
            link.target_slot = node.inputs.indexOf(data);
        }
    }
    node.setSize(node.computeSize());
    node.setDirtyCanvas?.(true, true);
}

function exposeSingleListGetterInput(nodeData) {
    if (!LIST_GETTER_TYPES.has(nodeData.name) || !nodeData.input?.optional) return;
    const optional = nodeData.input.optional;
    const data = optional["数据"] ?? optional["图像"] ?? optional["遮罩"];
    const mode = optional["类型"];
    if (data) {
        nodeData.input.optional = { "数据": data };
        if (mode) nodeData.input.optional["类型"] = mode;
    }
}

app.registerExtension({
    name: "ComfyUI.xiaozhuguang.batch_image_getter",
    setup() {
        const originalAfterConfigure = app.graph.afterConfigure;
        app.graph.afterConfigure = function () {
            const result = originalAfterConfigure?.apply(this, arguments);
            for (const node of this._nodes || []) {
                if (NODE_TYPES.has(node.type)) {
                    normalizeListGetterInput(node);
                    resizeOutputs(node);
                }
            }
            return result;
        };
    },
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (!NODE_TYPES.has(nodeData.name)) return;
        exposeSingleListGetterInput(nodeData);

        const originalCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = originalCreated?.apply(this, arguments);
            normalizeListGetterInput(this);
            resizeOutputs(this);
            const widget = (this.widgets || []).find((item) => item?.name === "输出数量");
            if (widget) {
                // Easy Use 刷新节点直接赋回 value，不调用 callback 或 onConfigure。
                const descriptor = Object.getOwnPropertyDescriptor(widget, "value");
                let value = widget.value;
                Object.defineProperty(widget, "value", {
                    configurable: true,
                    enumerable: descriptor?.enumerable ?? true,
                    get: () => descriptor?.get ? descriptor.get.call(widget) : value,
                    set: (next) => {
                        if (descriptor?.set) descriptor.set.call(widget, next);
                        else value = next;
                        resizeOutputs(this);
                    },
                });
                const originalCallback = widget.callback;
                widget.callback = (...args) => {
                    const callbackResult = originalCallback?.apply(widget, args);
                    resizeOutputs(this);
                    return callbackResult;
                };
            }
            const mode = this.widgets?.find((item) => item?.name === "类型");
            if (LIST_GETTER_TYPES.has(nodeData.name) && mode) {
                const originalCallback = mode.callback;
                mode.callback = (...args) => {
                    const callbackResult = originalCallback?.apply(mode, args);
                    normalizeListGetterInput(this);
                    resizeOutputs(this, undefined, args[0] ?? mode.value, true);
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
            const modeIndex = this.widgets?.findIndex((item) => item?.name === "类型");
            const mode = modeIndex >= 0 ? info?.widgets_values?.[modeIndex] : undefined;
            resizeOutputs(this, widgetsValueCount(this, info), mode);
            return result;
        };
    },
});

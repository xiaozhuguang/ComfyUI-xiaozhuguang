import { app } from "../../scripts/app.js";
import { xzgT } from "./xzg_i18n.js";

const NODE_TYPE = "XiaozhuguangImageMaskConvert";
const BOTH = "IMAGE,MASK";

function normalizeSlots(node) {
    if (!node.inputs?.some(input => input.name === "source")) {
        const image = node.inputs?.find(input => input.name === "image");
        const mask = node.inputs?.find(input => input.name === "mask");
        const keep = image?.link != null ? image : mask?.link != null ? mask : image || mask;
        const keepOutput = keep === mask && mask ? 1 : 0;
        for (let i = (node.outputs?.length || 0) - 1; i >= 0; i--) {
            if (i !== keepOutput) node.removeOutput(i);
        }
        for (let i = (node.inputs?.length || 0) - 1; i >= 0; i--) {
            if (node.inputs[i] !== keep) node.removeInput(i);
        }
        if (keep) keep.name = "source";
        else node.addInput("source", BOTH);
    }
    while (node.outputs?.length > 1) node.removeOutput(node.outputs.length - 1);
    if (!node.outputs?.length) node.addOutput("输出", BOTH);
    const input = node.inputs.find(input => input.name === "source");
    input.type = BOTH;
    input.label = input.localized_name = xzgT("图像／遮罩", "Image / Mask");
    if (["小珠光图像↔遮罩", "Xiaozhuguang Image ↔ Mask"].includes(node.title)) {
        node.title = xzgT("小珠光图像遮罩智能互转", "Xiaozhuguang Smart Image/Mask Converter");
    }
}

function outputType(node, seen = new Set()) {
    if (seen.has(node)) return BOTH;
    seen.add(node);
    const input = node.inputs?.find(slot => slot.name === "source");
    const link = node.graph?.links?.[input?.link];
    const upstream = link && node.graph.getNodeById(link.origin_id);
    const type = upstream?.type === NODE_TYPE ? outputType(upstream, seen) : upstream?.outputs?.[link?.origin_slot]?.type;
    return type === "IMAGE" ? "MASK" : type === "MASK" ? "IMAGE" : BOTH;
}

function syncGraph(graph) {
    const nodes = (graph?._nodes || []).filter(node => node.type === NODE_TYPE);
    for (const node of nodes) normalizeSlots(node);
    for (const node of nodes) {
        const type = outputType(node);
        const output = node.outputs[0];
        output.type = type;
        output.label = output.localized_name = type === "MASK" ? xzgT("遮罩", "Mask")
            : type === "IMAGE" ? xzgT("图像", "Image") : xzgT("输出", "Output");
        for (const id of [...(output.links || [])]) {
            const link = graph.links[id];
            if (!link) continue;
            const target = graph.getNodeById(link.target_id)?.inputs?.[link.target_slot];
            if (type !== BOTH && typeof target?.type === "string" && target.type !== "*" &&
                !target.type.split(",").map(item => item.trim()).includes(type)) {
                graph.removeLink(id);
            } else {
                link.type = type;
            }
        }
        node.setDirtyCanvas?.(true, true);
    }
}

app.registerExtension({
    name: "Xiaozhuguang.ImageMaskConvert",
    setup() {
        const original = app.graph.afterConfigure;
        app.graph.afterConfigure = function () {
            const result = original?.apply(this, arguments);
            syncGraph(this);
            return result;
        };
    },
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;
        for (const hook of ["onNodeCreated", "onConfigure", "onConnectionsChange"]) {
            const original = nodeType.prototype[hook];
            nodeType.prototype[hook] = function () {
                const result = original?.apply(this, arguments);
                queueMicrotask(() => { if (this.graph) syncGraph(this.graph); });
                return result;
            };
        }
    },
});

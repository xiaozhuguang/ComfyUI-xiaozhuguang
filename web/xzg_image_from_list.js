import { app } from "../../scripts/app.js";

const NODE_TYPE = "XiaozhuguangImageFromList";
const BOTH = "IMAGE,MASK";

function syncGraph(graph) {
    const nodes = (graph?._nodes || []).filter(node => node.type === NODE_TYPE);
    for (const node of nodes) {
        const input = node.inputs?.find(slot => slot.name === "images");
        if (input) {
            input.type = BOTH;
            input.label = input.localized_name = "图像／遮罩";
        }
        if (node.outputs?.[0]) node.outputs[0].type = BOTH;
    }
    // 多个选取节点串联时，将具体类型传到链尾。
    for (let pass = 0; pass < nodes.length; pass++) {
        for (const node of nodes) {
            const input = node.inputs?.find(slot => slot.name === "images");
            const link = graph.links[input?.link];
            const type = link && graph.getNodeById(link.origin_id)?.outputs?.[link.origin_slot]?.type;
            if (node.outputs?.[0] && (type === "IMAGE" || type === "MASK")) node.outputs[0].type = type;
        }
    }
    for (const node of nodes) {
        const output = node.outputs?.[0];
        if (!output) continue;
        output.label = output.localized_name = output.type === "MASK" ? "遮罩" : output.type === "IMAGE" ? "图像" : "图像／遮罩";
        for (const id of [...(output.links || [])]) {
            const link = graph.links[id];
            if (!link) continue;
            const target = graph.getNodeById(link.target_id)?.inputs?.[link.target_slot];
            if (output.type !== BOTH && typeof target?.type === "string" && target.type !== "*" &&
                !target.type.split(",").map(value => value.trim()).includes(output.type)) graph.removeLink(id);
            else link.type = output.type;
        }
        node.setDirtyCanvas?.(true, true);
    }
}

app.registerExtension({
    name: "Xiaozhuguang.ImageFromList",
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

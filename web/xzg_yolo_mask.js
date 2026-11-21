import { app } from "../../scripts/app.js";
import { xzgT } from "./xzg_i18n.js";

const yoloTypes = new Set(["XiaozhuguangYoloMask", "XiaozhuguangYoloFaceMask"]);

function setMaskOutputLabel(node) {
    if (node.outputs?.length !== 1) return;
    const [output] = node.outputs;
    if (output.type === "MASK") {
        output.label = output.localized_name = xzgT("遮罩", "Mask");
    }
}

function migrateYoloMaskOutputs(graph) {
    const legacyNodes = new Set();
    for (const node of graph.nodes ?? []) {
        if (!yoloTypes.has(node.type)) continue;
        if (node.outputs?.length === 1) {
            setMaskOutputLabel(node);
            continue;
        }
        if (node.outputs?.length !== 2) continue;
        const [image, mask] = node.outputs;
        if (image.links?.length || mask.type !== "MASK") continue;
        node.outputs = [mask];
        setMaskOutputLabel(node);
        legacyNodes.add(node.id);
    }

    for (const link of graph.links ?? []) {
        if (Array.isArray(link)) {
            if (legacyNodes.has(link[1]) && link[2] === 1) link[2] = 0;
        } else if (legacyNodes.has(link.origin_id) && link.origin_slot === 1) {
            link.origin_slot = 0;
        }
    }

    for (const subgraph of graph.definitions?.subgraphs ?? []) {
        migrateYoloMaskOutputs(subgraph);
    }
}

app.registerExtension({
    name: "xiaozhuguang.yolo_mask_migration",
    beforeConfigureGraph(graphData) {
        migrateYoloMaskOutputs(graphData);
    },
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (!yoloTypes.has(nodeData.name)) return;
        for (const hook of ["onNodeCreated", "onConfigure"]) {
            const original = nodeType.prototype[hook];
            nodeType.prototype[hook] = function (...args) {
                const result = original?.apply(this, args);
                setMaskOutputLabel(this);
                return result;
            };
        }
    },
});

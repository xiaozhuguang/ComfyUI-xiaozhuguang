import { app } from "../../scripts/app.js";

const legacySwitches = new Map([
    ["LazySwitch1way", { type: "XiaozhuguangLazySwitch", title: "🎈惰性开关（单路）" }],
    ["LazySwitch2way", { type: "XiaozhuguangLazySwitch2way", title: "🎈惰性开关（双路）" }],
]);

function migrateSwitches(graph) {
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    for (const node of nodes) {
        const legacyType = node?.type;
        const replacement = legacySwitches.get(legacyType);
        if (!replacement) continue;

        // Both nodes use the same socket names and boolean widget serialization.
        // Keep the saved slot order so links to the converted boolean stay valid.
        node.type = replacement.type;
        if ([legacyType, `🎈${legacyType}`, replacement.title].includes(node.title)) delete node.title;
        if (node.properties) {
            if (node.properties["Node name for S&R"] === legacyType) {
                node.properties["Node name for S&R"] = replacement.type;
            }
            delete node.properties.cnr_id;
            delete node.properties.aux_id;
            delete node.properties.ver;
        }
    }
    const subgraphs = graph?.definitions?.subgraphs;
    if (!Array.isArray(subgraphs)) return;
    for (const subgraph of subgraphs) {
        migrateSwitches(subgraph);
    }
}

app.registerExtension({
    name: "xiaozhuguang.lazy_switch_migration",
    beforeConfigureGraph(graphData) {
        migrateSwitches(graphData);
    },
});

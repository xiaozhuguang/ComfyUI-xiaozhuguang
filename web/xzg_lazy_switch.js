import { app } from "../../scripts/app.js";

const legacyType = "LazySwitch1way";
const switchType = "XiaozhuguangLazySwitch";
const legacyTitles = new Set(["🎈LazySwitch1way", "🎈惰性开关（单路）", legacyType]);

function migrateSwitches(graph) {
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    for (const node of nodes) {
        if (node?.type !== legacyType) continue;

        // Both nodes use the same socket names and boolean widget serialization.
        // Keep the saved slot order so links to the converted boolean stay valid.
        node.type = switchType;
        if (legacyTitles.has(node.title)) delete node.title;
        if (node.properties) {
            if (node.properties["Node name for S&R"] === legacyType) {
                node.properties["Node name for S&R"] = switchType;
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

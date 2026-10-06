import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "xiaozhuguang.VideoInfoReader",
    setup() {
        const nodes = LiteGraph.slot_types_default_out["VHS_VIDEOINFO"] ||= [];
        const node = "XiaozhuguangVideoInfoReader";
        const index = nodes.findIndex(item => item === node || item?.node === node);
        const entry = { node, title: "小珠光视频信息读取", content: "小珠光视频信息读取" };
        if (index === -1) {
            nodes.unshift(entry);
        } else {
            nodes[index] = entry;
        }
    },
});
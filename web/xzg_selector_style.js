import { app } from "../../scripts/app.js";
import { xzgT } from "./xzg_i18n.js";

export function applySelectorStyleToOthers(source, style, refresh) {
    const graph = app.graph;
    const graphs = new Set([graph]);
    const targets = [];
    let sourceFound = false;
    for (const currentGraph of graphs) {
        for (const node of currentGraph?._nodes || []) {
            if (node.subgraph) graphs.add(node.subgraph);
            if (node === source) {
                sourceFound = true;
            } else if (node.type === source.type) {
                const widget = node.widgets?.find(w => w.name === "_xz_settings");
                if (widget) targets.push({ node, widget });
            }
        }
    }
    if (!sourceFound || !targets.length) {
        app.extensionManager?.toast?.add({
            severity: "info",
            summary: xzgT("当前工作流没有可应用的其他选择器", "No other selectors to update in this workflow"),
            life: 2500
        });
        return;
    }

    graph.beforeChange?.();
    try {
        for (const { node, widget } of targets) {
            // 直接合并存档字段，避免改写旧工作流中的布局设置。
            let saved = {};
            try { saved = JSON.parse(widget.value); } catch (e) {}
            widget.value = JSON.stringify({ ...saved, ...style });
            refresh(node);
        }
        graph.setDirtyCanvas?.(true, true);
    } finally {
        graph.afterChange?.();
    }
    app.extensionManager?.toast?.add({
        severity: "success",
        summary: xzgT(`已应用到 ${targets.length} 个选择器`, `Applied to ${targets.length} selectors`),
        life: 2500
    });
}

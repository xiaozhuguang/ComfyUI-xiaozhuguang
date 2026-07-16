import { app } from "../../scripts/app.js";

(function () {
    const ID = "xzg-get-widget-css";
    if (document.getElementById(ID)) return;
    const s = document.createElement("style");
    s.id = ID;
    s.textContent = `
        .xzg-get-widget-wrap {
            width: 100%;
            height: 28px;
            position: relative;
            display: flex;
            align-items: center;
        }
        .xzg-get-widget-select {
            width: 100%;
            height: 26px;
            background: #2a2a2a;
            border: 1px solid #555;
            border-radius: 4px;
            color: #ddd;
            font-size: 12px;
            font-family: Consolas, monospace;
            padding: 0 8px;
            cursor: pointer;
            outline: none;
            appearance: none;
            -webkit-appearance: none;
        }
        .xzg-get-widget-select:hover {
            border-color: #777;
            background: #333;
        }
        .xzg-get-widget-select:focus {
            border-color: #3a6ea5;
        }
        .xzg-get-widget-select:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .xzg-get-widget-arrow {
            position: absolute;
            right: 10px;
            top: 50%;
            transform: translateY(-50%);
            color: #888;
            font-size: 10px;
            pointer-events: none;
        }
    `;
    document.head.appendChild(s);
})();

function getTargetNodeWidgets(node) {
    const targetLinkNodeId = getTargetLinkNodeId(node);
    if (!targetLinkNodeId) return [];

    const graph = app.graph;
    const targetNode = graph.getNodeById(targetLinkNodeId);
    if (!targetNode) return [];

    const widgets = [];
    if (targetNode.widgets) {
        for (const w of targetNode.widgets) {
            if (w.name && w.type !== "hidden" && !w.hidden) {
                widgets.push({
                    name: w.name,
                    label: w.label || w.name,
                    value: w.value
                });
            }
        }
    }

    return widgets;
}

function getTargetLinkNodeId(node) {
    if (!node.inputs) return null;

    const targetInput = node.inputs.find(inp => inp.name === "target_output");
    if (!targetInput || !targetInput.link) return null;

    const graph = app.graph;
    const link = graph.links[targetInput.link];
    if (!link) return null;

    return link.origin_id;
}

app.registerExtension({
    name: "ComfyUI.xiaozhuguang.get_widget",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "XiaozhuguangGetWidget") return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (origOnNodeCreated) origOnNodeCreated.apply(this, arguments);

            const node = this;
            const widgetNameWidget = node.widgets?.find(w => w.name === "widget_name");
            if (!widgetNameWidget) return;

            const widgetIndex = node.widgets.indexOf(widgetNameWidget);

            widgetNameWidget.type = "hidden";
            widgetNameWidget.hidden = true;
            widgetNameWidget.computeSize = () => [0, -0.5];

            const wrap = document.createElement("div");
            wrap.className = "xzg-get-widget-wrap";

            const select = document.createElement("select");
            select.className = "xzg-get-widget-select";

            const arrow = document.createElement("div");
            arrow.className = "xzg-get-widget-arrow";
            arrow.textContent = "▼";

            wrap.appendChild(select);
            wrap.appendChild(arrow);

            function refreshOptions() {
                const widgets = getTargetNodeWidgets(node);
                const currentValue = widgetNameWidget.value || "";

                select.innerHTML = "";

                if (widgets.length === 0) {
                    const opt = document.createElement("option");
                    opt.value = "";
                    opt.textContent = "请先连接目标节点";
                    opt.disabled = true;
                    select.appendChild(opt);
                    select.disabled = true;
                } else {
                    const opt = document.createElement("option");
                    opt.value = "";
                    opt.textContent = "全部控件";
                    select.appendChild(opt);

                    for (const w of widgets) {
                        const option = document.createElement("option");
                        option.value = w.name;
                        option.textContent = w.name;
                        if (w.name === currentValue) {
                            option.selected = true;
                        }
                        select.appendChild(option);
                    }
                    select.disabled = false;
                }

                if (!currentValue) {
                    select.value = "";
                }
            }

            select.addEventListener("change", function () {
                widgetNameWidget.value = select.value;
                if (widgetNameWidget.callback) {
                    try { widgetNameWidget.callback(select.value); } catch (e) {}
                }
                node.setDirtyCanvas(true, true);
            });

            const domWidget = node.addDOMWidget("xzg_widget_selector_dom", "xzg_widget_selector_dom", wrap, {
                getValue() {
                    return widgetNameWidget.value || "";
                },
                setValue(v) {
                    widgetNameWidget.value = v;
                    select.value = v;
                    if (widgetNameWidget.callback) {
                        try { widgetNameWidget.callback(v); } catch (e) {}
                    }
                },
            });

            const added = node.widgets.pop();
            node.widgets.splice(widgetIndex + 1, 0, added);

            refreshOptions();

            const origOnConnectInput = node.onConnectInput;
            node.onConnectInput = function (slot, type, output, node2, slot2) {
                if (origOnConnectInput) origOnConnectInput.apply(this, arguments);
                setTimeout(refreshOptions, 50);
            };

            const origOnConnectionsChange = node.onConnectionsChange;
            node.onConnectionsChange = function (type, index, connected, linkInfo, ioSlot) {
                if (origOnConnectionsChange) origOnConnectionsChange.apply(this, arguments);
                setTimeout(refreshOptions, 50);
            };

            setTimeout(refreshOptions, 100);
        };
    },
});

import { app } from "../../scripts/app.js";

// 运行时下拉文本 i18n：节点定义翻译由 locales/ 下的 nodeDefs.json 提供，
// 而这里的下拉占位/选项文本属于 JS 运行时字符串，需自行按当前界面语言切换。
const XZG_GET_WIDGET_I18N = {
    "zh": {
        "no_target": "请先连接目标节点",
        "all_widgets": "全部控件",
    },
    "en": {
        "no_target": "Connect a target node first",
        "all_widgets": "All widgets",
    },
};

function xzgGetWidgetT(key) {
    let lang = "en";
    try {
        // 正确读取 ComfyUI 当前语言（扩展标准 API，由 settings store 管理）。
        const saved = (app?.ui?.settings?.getSettingValue?.("Comfy.Locale") || "").toLowerCase();
        if (saved.startsWith("zh")) lang = "zh";
    } catch (e) {}
    const dict = XZG_GET_WIDGET_I18N[lang] || XZG_GET_WIDGET_I18N["en"];
    return dict[key] || XZG_GET_WIDGET_I18N["en"][key] || key;
}

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

        // 监听 ComfyUI 语言切换：刷新所有 Get Widget 下拉的文案
        if (!window.__xzg_get_widget_locale_hooked) {
            window.__xzg_get_widget_locale_hooked = true;
            try {
                const lookup = app?.ui?.settings?.settingsLookup?.["Comfy.Locale"];
                if (lookup) {
                    const orig = lookup.onChange;
                    lookup.onChange = function (is_now, was_before) {
                        for (const n of (app.graph?.nodes || [])) {
                            if (n.type === "XiaozhuguangGetWidget" &&
                                typeof n.xzgRefreshWidgetOptions === "function") {
                                try { n.xzgRefreshWidgetOptions(); } catch (e) {}
                            }
                        }
                        return orig?.apply(this, arguments);
                    };
                }
            } catch (e) {}
        }

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
                    opt.textContent = xzgGetWidgetT("no_target");
                    opt.disabled = true;
                    select.appendChild(opt);
                    select.disabled = true;
                } else {
                    const opt = document.createElement("option");
                    opt.value = "";
                    opt.textContent = xzgGetWidgetT("all_widgets");
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

            // 暴露给语言切换时全局刷新
            node.xzgRefreshWidgetOptions = refreshOptions;

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

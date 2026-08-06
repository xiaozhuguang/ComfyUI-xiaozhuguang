import { app } from "../../scripts/app.js";
import { xzgLang } from "./xzg_i18n.js";

// ═══════════════════════════════════════════════════════════════════════
// 小珠光输入惰性判断 - 双语翻译表
// ═══════════════════════════════════════════════════════════════════════
const _LABEL_MAP = {
    // 节点显示名
    "小珠光输入惰性判断": "Xiaozhuguang Input Lazy Check",
    // 输入插槽
    "A": "A (Primary)",
    "B": "B (Lazy Fallback)",
    // 输出插槽
    "输出": "Output",
    "判断": "Condition",
    // 节点描述 tooltip（短）
    "DESC_SHORT": "If A has value → output A (skip B); if A empty → output B (compute B upstream only on demand)",
};

function _tr(zh) {
    const lang = xzgLang();
    // 英文环境下翻译，中文环境原样
    if (lang !== "en") return zh;
    return (_LABEL_MAP[zh] != null) ? _LABEL_MAP[zh] : zh;
}

const NODE_TYPE = "XiaozhuguangInputLazyCheck";
const NODE_NAME_ZH = "小珠光输入惰性判断";
const INPUT_ZH_TO_EN = {
    "A": "A (Primary)",
    "B": "B (Lazy Fallback)",
};
const OUTPUT_ZH_TO_EN = {
    "输出": "Output",
    "判断": "Condition",
};

// 给节点实例打双语补丁
function applyBilingual(node) {
    const lang = xzgLang();
    const isEn = lang === "en";

    // 1) 标题（保留原 title 备份，切语言可还原）
    if (node._xzgOrigTitle == null) node._xzgOrigTitle = node.title || NODE_NAME_ZH;
    node.title = isEn ? _LABEL_MAP[NODE_NAME_ZH] || "Input Lazy Check" : node._xzgOrigTitle;

    // 2) 输入插槽名
    for (const inp of node.inputs || []) {
        if (inp._xzgOrigName == null) inp._xzgOrigName = inp.name;
        if (isEn) {
            if (INPUT_ZH_TO_EN[inp._xzgOrigName]) inp.name = INPUT_ZH_TO_EN[inp._xzgOrigName];
        } else {
            inp.name = inp._xzgOrigName;
        }
        // B 插槽保留 (Lazy) 标注，中文环境下不额外标注（Python 端已没有中文说明）
    }

    // 3) 输出插槽名
    for (const outp of node.outputs || []) {
        if (outp._xzgOrigName == null) outp._xzgOrigName = outp.name;
        if (isEn) {
            if (OUTPUT_ZH_TO_EN[outp._xzgOrigName]) outp.name = OUTPUT_ZH_TO_EN[outp._xzgOrigName];
        } else {
            outp.name = outp._xzgOrigName;
        }
    }

    node.setDirtyCanvas?.(true, true);
}

app.registerExtension({
    name: "xiaozhuguang.input_lazy_check",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData?.name !== NODE_TYPE) return;

        // prototype 初始化后自动应用
        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnNodeCreated?.apply(this, arguments);
            applyBilingual(this);
            return r;
        };

        // 加载旧工作流时也要应用（onConfigure 里没有 onNodeCreated 触发的情况）
        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = origOnConfigure?.apply(this, arguments);
            applyBilingual(this);
            return r;
        };
    },
});

// 暴露热修复入口（浏览器端调试用）
if (typeof window !== "undefined") {
    window.XZG_LazyCheck_applyBilingualAll = function () {
        const graph = app.graph || window.graph;
        let n = 0;
        for (const nd of graph?._nodes || []) {
            if (nd.type === NODE_TYPE) { applyBilingual(nd); n++; }
        }
        return { patched: n };
    };
}

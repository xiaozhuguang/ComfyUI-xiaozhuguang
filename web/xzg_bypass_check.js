import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { xzgLang } from "./xzg_i18n.js";

// ═══════════════════════════════════════════════════════════════════════
// 小珠光绕过判断 - 双语翻译表
// ═══════════════════════════════════════════════════════════════════════
const _LABEL_MAP = {
    // 节点显示名
    "小珠光绕过判断": "Xiaozhuguang Bypass Check",
    // 输入插槽
    "输入": "Input",
    // 输出插槽
    "判断": "Condition",
    // 节点描述 tooltip（短）
    "DESC_SHORT": "true = upstream bypassed; false = upstream enabled",
};

function _tr(zh) {
    const lang = xzgLang();
    if (lang !== "en") return zh;
    return (_LABEL_MAP[zh] != null) ? _LABEL_MAP[zh] : zh;
}

const NODE_TYPE = "XiaozhuguangBypassCheck";
const NODE_NAME_ZH = "小珠光绕过判断";
const INPUT_ZH_TO_EN = { "输入": "Input" };
const OUTPUT_ZH_TO_EN = { "判断": "Condition" };
// 前端注入的隐藏参数名（与后端 INPUT_TYPES 保持一致）：绝不渲染成插槽或按钮
const HIDDEN_INPUT_NAME = "bypass_status";

// 便捷判定：节点 id 是否相等（轻量，兼容 number / string）
function sameId(a, b) {
    return a == null || b == null ? false : a === b || a == b;
}

// ── 彻底剔除 bypass_status 的可见控件（复选框按钮）与插槽 ─────────────────
// ComfyUI 会把「带默认值的 BOOLEAN 可选输入」渲染成节点上的复选框按钮，
// 该按钮的序列化值会被当作 bypass_status 传给后端，从而"结果跟按钮绑定"。
// 因此必须在节点初始化/配置时把对应 widget 和 socket 一并移除。
function hideHiddenControl(node) {
    if (!node) return;
    if (node.widgets) {
        node.widgets = node.widgets.filter((w) => w?.name !== HIDDEN_INPUT_NAME);
    }
    if (node.inputs) {
        node.inputs = node.inputs.filter((i) => i?.name !== HIDDEN_INPUT_NAME);
    }
}

// 给节点实例打双语补丁 + 隐藏注入控件
function applyBilingual(node) {
    const lang = xzgLang();
    const isEn = lang === "en";

    // 1) 标题（保留原 title 备份，切语言可还原）
    if (node._xzgOrigTitle == null) node._xzgOrigTitle = node.title || NODE_NAME_ZH;
    node.title = isEn ? _LABEL_MAP[NODE_NAME_ZH] || "Bypass Check" : node._xzgOrigTitle;

    // 2) 输入插槽名（隐藏注入槽位不参与翻译）
    for (const inp of node.inputs || []) {
        if (inp.name === HIDDEN_INPUT_NAME) continue;
        if (inp._xzgOrigName == null) inp._xzgOrigName = inp.name;
        if (isEn) {
            if (INPUT_ZH_TO_EN[inp._xzgOrigName]) inp.name = INPUT_ZH_TO_EN[inp._xzgOrigName];
        } else {
            inp.name = inp._xzgOrigName;
        }
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

    // 4) 隐藏注入控件
    hideHiddenControl(node);

    if (node.setDirtyCanvas) node.setDirtyCanvas(true, true);
}

// ── 图源收集：兼容多图/前端改写的 aki 环境，app.graph 可能为空 ─────────────
function collectGraphs() {
    const seen = [];
    const push = (g) => { if (g && !seen.includes(g)) seen.push(g); };
    push(app?.graph);
    push(app?.canvas?.graph);
    push(window?.graph);
    if (app?.graphManager) {
        try { app.graphManager?.forEach?.((g) => push(g)); } catch { /* ignore */ }
        push(app.graphManager?.graph);
        push(app.graphManager?.currentGraph);
    }
    return seen;
}

// 按 id 在所有候选图里查找 litegraph 节点
function findNodeById(id) {
    for (const g of collectGraphs()) {
        const list = g._nodes || g.nodes || [];
        for (const n of list) {
            if (n && sameId(n.id, id)) return n;
        }
    }
    return null;
}

// 在节点自身所在图上找到上游连线对应的连线对象
function findLink(graphLike, linkId) {
    const others = collectGraphs(); // 若 graphLike 无 links，兜底所有图
    const candidates = [graphLike, ...others].filter(Boolean);
    for (const cand of candidates) {
        const links = cand.links || cand.linksMap;
        if (Array.isArray(links)) {
            const l = links.find((x) => x && x.id === linkId);
            if (l) return l;
        } else if (links && typeof links.get === "function") {
            const l = links.get(linkId);
            if (l) return l;
        }
    }
    return null;
}

// 计算某个绕过判断节点的上游节点是否被绕过
function resolveUpstreamBypassed(node) {
    const inp = (node.inputs || []).find((i) => i?.name === "输入" || i?.name === "Input");
    if (!inp || inp.link == null) {
        console.log("[小珠光]绕过判断 lookup: 未找到有效输入连线", { nodeId: node?.id, inputNames: (node.inputs || []).map(i => i?.name) });
        return false;
    }
    const link = findLink(node?.graph, inp.link);
    const origin = link && findNodeById(link.origin_id);
    const mod = origin ? origin.mode : undefined;
    const nm = (typeof LiteGraph !== "undefined" && LiteGraph.NODE_MODES) ? LiteGraph.NODE_MODES : null;
    console.log("[小珠光]绕过判断 lookup:", {
        nodeId: node?.id,
        linkId: inp.link,
        originId: link ? link.origin_id : undefined,
        originFound: !!origin,
        originType: origin ? origin.type : undefined,
        originMode: mod,
        NODE_MODES_BYPASS: nm ? nm.BYPASS : "(无LiteGraph)",
        originIsBypassed: origin ? origin.isBypassed : undefined,
        bypassed: origin ? (mod === 4 || origin.isBypassed === true) : false,
    });
    if (!origin) return false;
    return origin.mode === 4 || origin.isBypassed === true; // LiteGraph.NODE_MODES.BYPASS
}

// 面向 prompt 的一次性注入：按 prompt 的 node id 反查画布节点，写回 bypass_status
function injectIntoPrompt(prompt) {
    if (!prompt || typeof prompt !== "object") return;
    for (const id of Object.keys(prompt)) {
        const node = findNodeById(id);
        if (!node || node.type !== NODE_TYPE) continue;
        const entry = prompt[id];
        if (!entry || typeof entry !== "object") continue;
        if (entry.inputs == null) entry.inputs = {};
        const val = resolveUpstreamBypassed(node);
        entry.inputs[HIDDEN_INPUT_NAME] = val;
        console.log(`[小珠光]绕过判断 api注入: node=${id} 写入${HIDDEN_INPUT_NAME}=${val}`);
    }
}

// ── api.queuePrompt 运行时注入：把上游绕过状态写入最终 prompt ─────────────
let _apiInjectionInstalled = false;
function installApiInjection() {
    if (_apiInjectionInstalled) return;
    if (typeof api?.queuePrompt !== "function") return;
    _apiInjectionInstalled = true;

    const origApiQueue = api.queuePrompt;
    api.queuePrompt = async function (index, prompt, ...rest) {
        try {
            injectIntoPrompt(prompt);
        } catch (e) {
            console.warn("[小珠光] 绕过判断注入失败:", e);
        }
        return origApiQueue.call(api, index, prompt, ...rest);
    };
}

app.registerExtension({
    name: "xiaozhuguang.bypass_check",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData?.name !== NODE_TYPE) return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnNodeCreated?.apply(this, arguments);
            hideHiddenControl(this);
            applyBilingual(this);
            return r;
        };

        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = origOnConfigure?.apply(this, arguments);
            hideHiddenControl(this);
            applyBilingual(this);
            return r;
        };

        // 防止 ComfyUI 在连线/属性刷新时重新生成 bypass_status 控件
        const origUpdateInputs = nodeType.prototype.updateNodeInputs;
        if (typeof origUpdateInputs === "function") {
            nodeType.prototype.updateNodeInputs = function () {
                const r = origUpdateInputs.apply(this, arguments);
                hideHiddenControl(this);
                return r;
            };
        }
    },
    async setup() {
        installApiInjection();
        installGraphToPromptInjection();
    },
});

// ── graphToPrompt 兜底注入（兼容主 Run 走 graphToPrompt 分支的情况）────────
let _graphToPromptInstalled = false;
function installGraphToPromptInjection() {
    if (_graphToPromptInstalled) return;
    if (typeof app?.graphToPrompt !== "function") return;
    _graphToPromptInstalled = true;

    const origGraphToPrompt = app.graphToPrompt;
    app.graphToPrompt = async function (...args) {
        const result = await origGraphToPrompt.apply(this, args);
        if (!result) return result;
        const prompt = Array.isArray(result) ? result[0] : result;
        injectIntoPrompt(prompt);
        return result;
    };
}

// 暴露热修复入口（浏览器端调试用）
if (typeof window !== "undefined") {
    window.XZG_BypassCheck_applyAll = function () {
        let n = 0;
        for (const g of collectGraphs()) {
            for (const nd of g._nodes || g.nodes || []) {
                if (nd.type === NODE_TYPE) { applyBilingual(nd); n++; }
            }
        }
        return { patched: n };
    };
    window.XZG_BypassCheck_install = function () {
        installApiInjection();
        installGraphToPromptInjection();
        return { apiInjected: _apiInjectionInstalled, graphInjected: _graphToPromptInstalled };
    };
}
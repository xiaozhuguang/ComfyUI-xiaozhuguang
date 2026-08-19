import { app } from "../../scripts/app.js";
import { xzgLang } from "./xzg_i18n.js";

// ═══════════════════════════════════════════════
//  小珠光文本框 / Xiaozhuguang Text Box
//  双语翻译表
// ═══════════════════════════════════════════════
const _NODE_TYPE = "XiaozhuguangTextBox";
const _NODE_NAME_ZH = "小珠光文本框";
const _NODE_NAME_EN = "Xiaozhuguang Text Box";

const _LABEL_MAP = {
    "文本": "Text",
    "原文": "Raw Text",
    "数字转中文": "Num → Chinese",
};
function _tr(zh) {
    const lang = xzgLang();
    if (lang !== "en") return zh;
    return _LABEL_MAP[zh] != null ? _LABEL_MAP[zh] : zh;
}

// 占位符原文 placeholder（多行中文）→ 英文
const _PLACEHOLDER_ZH =
    "【小珠光文本框】\n" +
    "输出：text 原文 / text_zh_num 数字转中文\n" +
    "规则：日期时间→整体转写；数字+量词→完整读数；第N→第N；4位+年→按位读；其余→按位读\n" +
    "例：2023.4.16 21:08→二零二三年四月十六日九点零八分\n" +
    "12个→十二个  1280x720→一二八零乘以七二零  1926年→一九二六年\n" +
    "《》→。  ……→。";

const _PLACEHOLDER_EN =
    "[Xiaozhuguang Text Box]\n" +
    "Outputs: text (raw) / text_zh_num (digits → Chinese words)\n" +
    "Rules: datetime→whole conversion; digit+unit→full reading; 第N→ordinal; 4digits+年→year per digit; rest→per digit\n" +
    "Ex: 2023.4.16 21:08→二零二三年四月十六日九点零八分\n" +
    "12个→十二个  1280x720→一二八零乘以七二零  1926年→一九二六年\n" +
    "《》→。  ……→。";

function _placeholderForLang() {
    return xzgLang() === "en" ? _PLACEHOLDER_EN : _PLACEHOLDER_ZH;
}

// 给单个节点实例应用双语补丁
function applyBilingual(node) {
    const isEn = xzgLang() === "en";

    // 1) 标题
    if (node._xzgOrigTitle == null) node._xzgOrigTitle = node.title || _NODE_NAME_ZH;
    node.title = isEn ? _NODE_NAME_EN : node._xzgOrigTitle;

    // 2) 输出插槽名（text / text_zh_num）
    // Python 端 RETURN_NAMES 已用英文代号，不改，除非中文端想显示成中文
    // 这里选择不改代号，只保证英文端显示的是通用英文；中文端保持 Python 默认。
    // 若需要中文端输出插槽名也改成中文，打开以下两段：
    // const outputsMap = isEn ? {"text":"Raw Text","text_zh_num":"Num → Chinese"} : {"text":"text","text_zh_num":"text_zh_num"};
    // for (const o of node.outputs || []) {
    //     if (o._xzgOrigName == null) o._xzgOrigName = o.name;
    //     o.name = outputsMap[o._xzgOrigName] ?? o._xzgOrigName;
    // }

    // 3) Widget：text 的 label、placeholder
    //    输入插槽名（Python INPUT_TYPES 没有自定义输入插槽，只有 text widget）
    const txt = node.widgets?.find((w) => w && w.name === "text");
    if (txt) {
        if (txt._xzgOrigLabel == null) {
            // 首次绑定：保存原始 label / placeholder
            txt._xzgOrigLabel = txt.label || "text";
            txt._xzgOrigPlaceholder =
                txt.element?.getAttribute?.("placeholder") ?? null;
            // ComfyUI 原生 multiline textarea 组件 widget 的 placeholder 属性
            // 直接存在 widget.options?.placeholder 也常见
            if (txt.options?.placeholder && txt._xzgOrigPlaceholder == null) {
                txt._xzgOrigPlaceholder = txt.options.placeholder;
            }
            // 兜底（Python 端传的 placeholder）用中文模板
            if (txt._xzgOrigPlaceholder == null) {
                txt._xzgOrigPlaceholder = _PLACEHOLDER_ZH;
            }
        }
        // label
        txt.label = isEn ? _tr("文本") : (txt._xzgOrigLabel || "text");
        // placeholder
        const want = isEn ? _PLACEHOLDER_EN : txt._xzgOrigPlaceholder;
        if (txt.element && typeof txt.element.setAttribute === "function") {
            if (txt.element.getAttribute("placeholder") !== want) {
                txt.element.setAttribute("placeholder", want);
            }
        }
        if (txt.options) {
            if (txt.options.placeholder !== want) txt.options.placeholder = want;
        }
    }

    node.setDirtyCanvas?.(true, true);
}

// 给 textarea 打 class + 占位符双语（onNodeCreated 里 DOM 可能还没 ready，用延时）
function ensureTextarea(node) {
    const tag = (ta) => {
        if (!ta) return;
        if (!ta._xzgTagged) { ta._xzgTagged = true; ta.classList.add("xzg-text-box"); }
        const want = _placeholderForLang();
        if (ta.getAttribute("placeholder") !== want) {
            ta.setAttribute("placeholder", want);
        }
    };

    const tryAttach = () => {
        const wid = node.id;
        const selectors = [
            `textarea[data-node-id="${wid}"]`,
            `textarea[node-id="${wid}"]`,
            `[data-node-id="${wid}"] textarea`,
        ];
        for (const sel of selectors) {
            const ta = document.querySelector(sel);
            if (ta) { tag(ta); return true; }
        }
        const root = node.domElement || node.element || null;
        if (root) {
            const ta = root.querySelector("textarea");
            if (ta) { tag(ta); return true; }
        }
        return false;
    };

    if (!tryAttach()) {
        const obs = new MutationObserver(() => {
            if (tryAttach()) obs.disconnect();
        });
        obs.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => obs.disconnect(), 30000);
    }
    // 再补两次延时兜底（setSize 之后 textarea 才 ready）
    setTimeout(() => tryAttach(), 0);
    setTimeout(() => tryAttach(), 50);
}

// 注入 CSS：缩小小珠光文本框 placeholder 字体
(function () {
    const cssId = "xzg-text-box-placeholder-css";
    if (document.getElementById(cssId)) return;
    const s = document.createElement("style");
    s.id = cssId;
    s.textContent = `
textarea.xzg-text-box::placeholder {
    font-size: 14px;
    line-height: 1.5;
    opacity: 0.55;
}`;
    document.head.appendChild(s);
})();

// 全局 capture：textarea 不可滚动时把 wheel 转发给画布缩放
(function () {
    if (window.__xzg_textarea_wheel_fixed) return;
    window.__xzg_textarea_wheel_fixed = true;

    window.addEventListener("wheel", (e) => {
        const el = e.target;
        if (!el || el.tagName !== "TEXTAREA") return;
        if (el.scrollHeight > el.clientHeight + 1) return;
        const cv = app.canvas?.canvas;
        if (!cv) return;
        e.preventDefault();
        e.stopPropagation();
        cv.dispatchEvent(new WheelEvent("wheel", {
            deltaY: e.deltaY, deltaX: e.deltaX,
            clientX: e.clientX, clientY: e.clientY,
            ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey,
            bubbles: true, cancelable: true,
        }));
    }, { capture: true, passive: false });
})();

app.registerExtension({
    name: "ComfyUI.xiaozhuguang.text_box_bilingual",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== _NODE_TYPE) return;

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origCreated?.apply(this, arguments);
            applyBilingual(this);
            ensureTextarea(this);
            return r;
        };

        const origConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = origConfigure?.apply(this, arguments);
            applyBilingual(this);
            ensureTextarea(this);
            return r;
        };
    },
});

// 热修复入口
if (typeof window !== "undefined") {
    window.XZG_TextBox_applyBilingualAll = function () {
        const graph = app.graph || window.graph;
        let n = 0;
        for (const nd of graph?._nodes || []) {
            if (nd.type === _NODE_TYPE) { applyBilingual(nd); ensureTextarea(nd); n++; }
        }
        return { patched: n, lang: xzgLang() };
    };
}
